import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scene3DRibbons, type Scene3DRibbonHost } from './scene3d-ribbons';
import type { ManagerContext } from './manager-context';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';

// §5.1 extraction. generateRibbon is pure CPU, so creation + all the field-mutating setters (which rebuild
// geometry) are testable with a fake mesh + fake camera. The camera-facing/scroll tick and the world↔screen
// handle-drag depend on the live camera/projection — those are browser-verified; here we mock the host's
// project/unproject to pin the handle-drag wiring + depth-gating.

function makeMesh(id: string): Mesh3D {
  return {
    id,
    localMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    setGeometry: vi.fn(),
    gpuDirty: false,
  } as unknown as Mesh3D;
}

function makeEnv() {
  const meshes = new Map<string, Mesh3D>();
  let nextId = 0;
  const preRenderCbs = new Set<() => boolean>();
  const scheduleRender = vi.fn();
  // A fake camera at the origin with an identity-ish VP; enough for generateRibbon(cameraPosition).
  const camera = { position: [0, 0, 5] as [number, number, number] };
  const host: Scene3DRibbonHost = {
    createRibbonMesh: (_x, _y, _z, _geom, _mat) => { const m = makeMesh(`ribbon-${nextId++}`); meshes.set(m.id, m); return m; },
    getMesh: (id) => meshes.get(id) ?? null,
    getFrameLinkAnim: () => null,
    projectWorldToScreen3D: (x, y, _z, w, h) => ({ x: (x + 1) * 0.5 * w, y: (1 - y) * 0.5 * h, depth: 0.5 }),
    unprojectScreenToWorld3D: (sx, sy, _d, w, h) => ({ x: sx / w * 2 - 1, y: 1 - sy / h * 2, z: 0 }),
  };
  const ctx = {
    webgpuRenderer: {
      getRenderer3D: () => ({ getCamera: () => camera }),
      addPreRenderCallback: (cb: () => boolean) => { preRenderCbs.add(cb); },
      removePreRenderCallback: (cb: () => boolean) => { preRenderCbs.delete(cb); },
    },
    scheduleRender,
  } as unknown as ManagerContext;
  return { ctx, host, meshes, preRenderCbs, scheduleRender };
}

const CPS = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }];

describe('§5.1 Scene3DRibbons (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  let ribbons: Scene3DRibbons;
  beforeEach(() => { env = makeEnv(); ribbons = new Scene3DRibbons(env.ctx, env.host); });

  it('addRibbon() creates a mesh and stores default ribbon data', () => {
    const mesh = ribbons.addRibbon(0, 0, 0, CPS, 0.5, 16);
    const data = ribbons.getData(mesh.id);
    expect(data).not.toBeNull();
    expect(data!.controlPoints).toHaveLength(3);
    expect(data!.width).toBe(0.5);
    expect(data!.pathMode).toBe('normal');
    expect(data!.doubleSided).toBe('double');
  });

  it('setters mutate ribbon data and rebuild geometry', () => {
    const mesh = ribbons.addRibbon(0, 0, 0, CPS, 0.5);
    (mesh.setGeometry as ReturnType<typeof vi.fn>).mockClear();

    expect(ribbons.updateWidth(mesh.id, 2)).toBe(true);
    expect(ribbons.getData(mesh.id)!.width).toBe(2);

    expect(ribbons.setPathMode(mesh.id, 'world-up')).toBe(true);
    expect(ribbons.getData(mesh.id)!.pathMode).toBe('world-up');

    expect(ribbons.setDoubleSided(mesh.id, false)).toBe(true);      // legacy boolean → 'front'
    expect(ribbons.getData(mesh.id)!.doubleSided).toBe('front');

    expect(ribbons.setUvTileCount(mesh.id, 3)).toBe(true);
    expect(ribbons.getData(mesh.id)!.uvTileCount).toBe(3);

    expect(ribbons.setControlPoint(mesh.id, 1, 5, 5, 5)).toBe(true);
    expect(ribbons.getData(mesh.id)!.controlPoints[1]).toEqual({ x: 5, y: 5, z: 5 });

    expect(mesh.setGeometry).toHaveBeenCalled();   // rebuilt on each mutation
  });

  it('camera-facing path mode starts the per-frame tick', () => {
    const mesh = ribbons.addRibbon(0, 0, 0, CPS, 0.5);
    expect(env.preRenderCbs.size).toBe(0);
    ribbons.setPathMode(mesh.id, 'camera-facing');
    expect(env.preRenderCbs.size).toBe(1);
    // The tick rebuilds camera-facing ribbons and stays active while one exists.
    const tick = [...env.preRenderCbs][0];
    (mesh.setGeometry as ReturnType<typeof vi.fn>).mockClear();
    expect(tick()).toBe(true);
    expect(mesh.setGeometry).toHaveBeenCalled();
  });

  it('handle drag: begin captures depth, move applies, without begin it is a no-op', () => {
    const mesh = ribbons.addRibbon(0, 0, 0, CPS, 0.5);
    // move before begin → no drag started
    expect(ribbons.moveHandle(mesh.id, 0, 10, 10, 100, 100)).toBe(false);
    // begin then move
    expect(ribbons.beginHandleDrag(mesh.id, 0, 100, 100)).toBe(true);
    expect(ribbons.moveHandle(mesh.id, 0, 50, 50, 100, 100)).toBe(true);
    ribbons.endHandleDrag(mesh.id, 0);
    expect(ribbons.moveHandle(mesh.id, 0, 60, 60, 100, 100)).toBe(false);   // ended → no-op
  });

  it('computeTextureSize returns power-of-two dims or null for a non-ribbon', () => {
    const mesh = ribbons.addRibbon(0, 0, 0, CPS, 0.5);
    const size = ribbons.computeTextureSize(mesh.id, 128)!;
    expect(size).not.toBeNull();
    expect(Number.isInteger(Math.log2(size.height))).toBe(true);   // power of two
    expect(Number.isInteger(Math.log2(size.width))).toBe(true);
    expect(ribbons.computeTextureSize('nope')).toBeNull();
  });

  it('guards + removeData', () => {
    expect(ribbons.getData('nope')).toBeNull();
    expect(ribbons.updateWidth('nope', 1)).toBe(false);
    expect(ribbons.getHandleScreenPositions('nope', 100, 100)).toEqual([]);
    const mesh = ribbons.addRibbon(0, 0, 0, CPS, 0.5);
    expect(ribbons.removeData(mesh.id)).toBe(true);
    expect(ribbons.getData(mesh.id)).toBeNull();
  });

  it('dispose() clears the tick', () => {
    const mesh = ribbons.addRibbon(0, 0, 0, CPS, 0.5);
    ribbons.setPathMode(mesh.id, 'camera-facing');
    expect(env.preRenderCbs.size).toBe(1);
    ribbons.dispose();
    expect(env.preRenderCbs.size).toBe(0);
    expect(ribbons.getData(mesh.id)).toBeNull();
  });
});
