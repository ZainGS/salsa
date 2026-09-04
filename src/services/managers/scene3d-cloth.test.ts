import { describe, it, expect, beforeEach } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { Scene3DCloth, type Scene3DClothHost } from './scene3d-cloth';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { ClothMesh3D } from '../../scene-graph/shapes/cloth-mesh-3d';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';

// §5.1 extraction (tier-2). The GPU cloth simulation / preview needs a real device, so these tests pin the parts
// that run on the CPU alone: creation (buildClothGeometry is pure), the geometry cache, config/stitch/wind-zone
// getters, the vertex-slot mapping, and the not-a-cloth-mesh guards. The live-sim paths (enable/tick/preview) are
// browser-verified. This is enough to prove the ctx + host wiring and that the public surface still behaves.

function makeEnv() {
  const sceneGraph = new SceneGraph();
  const preRenderCbs = new Set<() => boolean>();
  const host: Scene3DClothHost = {
    getMesh: (id) => (sceneGraph.findNodeById(id) as Mesh3D | null) ?? null,
    getFrameLinkAnim: () => null,
  };
  const ctx = {
    sceneGraph,
    interactionService: { maxGlobalZIndex: 0 } as unknown as InteractionService,
    webgpuRenderer: {
      getDevice: () => null,
      getRenderer3D: () => ({ setVertexBufferOverride: () => {} }),
      addPreRenderCallback: (cb: () => boolean) => { preRenderCbs.add(cb); },
      removePreRenderCallback: (cb: () => boolean) => { preRenderCbs.delete(cb); },
    },
    scheduleRender: () => {},
    emitSceneGraphChanged: () => {},
  } as unknown as ManagerContext;
  return { ctx, host, sceneGraph, preRenderCbs };
}

describe('§5.1 Scene3DCloth (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  let cloth: Scene3DCloth;
  beforeEach(() => { env = makeEnv(); cloth = new Scene3DCloth(env.ctx, env.host); });

  it('createClothMesh() builds a ClothMesh3D, attaches it, and caches its geometry result', () => {
    const mesh = cloth.createClothMesh(0, 0, 0, { cols: 6, rows: 8 }, {}, undefined, 'Banner');
    expect(mesh).toBeInstanceOf(ClothMesh3D);
    expect(mesh.name).toBe('Banner');
    expect(env.sceneGraph.root.children).toContain(mesh);
    const result = cloth.getClothGeometryResult(mesh.id);
    expect(result).not.toBeNull();
    expect(result!.vertexCount).toBeGreaterThan(0);
  });

  it('getClothConfig() returns the grid + physics of a created mesh', () => {
    const mesh = cloth.createClothMesh(0, 0, 0, { cols: 6, rows: 8 });
    const cfg = cloth.getClothConfig(mesh.id);
    expect(cfg).not.toBeNull();
    expect(cfg!.grid.cols).toBe(6);
    expect(cfg!.grid.rows).toBe(8);
    expect(typeof cfg!.physics.gravity).toBe('number');
  });

  it('getClothVertexSlot maps (col,row) to a stable slot index', () => {
    const mesh = cloth.createClothMesh(0, 0, 0, { cols: 4, rows: 4 });
    // Top-left corner is slot 0 and should be active for a default full grid.
    expect(cloth.getClothVertexSlot(mesh.id, 0, 0)).toBe(0);
    // Out-of-range col/row → null.
    expect(cloth.getClothVertexSlot(mesh.id, 999, 999)).toBeNull();
  });

  it('wind zones: add / update / get / remove / clear round-trip (no live handle needed)', () => {
    const mesh = cloth.createClothMesh(0, 0, 0);
    const id = cloth.addWindZone(mesh.id, { shape: 'sphere', center: [0, 0, 0], radius: 1, windVec: [1, 0, 0], falloff: 'none' });
    expect(id).toBeTruthy();
    expect(cloth.getWindZones(mesh.id)).toHaveLength(1);

    expect(cloth.updateWindZone(mesh.id, id!, { radius: 2 })).toBe(true);
    expect(cloth.getWindZones(mesh.id)[0].radius).toBe(2);

    expect(cloth.removeWindZone(mesh.id, id!)).toBe(true);
    expect(cloth.getWindZones(mesh.id)).toHaveLength(0);

    cloth.addWindZone(mesh.id, { shape: 'box', center: [0, 0, 0], halfExtents: [1, 1, 1], windVec: [0, 1, 0], falloff: 'linear' });
    expect(cloth.clearWindZones(mesh.id)).toBe(true);
    expect(cloth.getWindZones(mesh.id)).toHaveLength(0);
  });

  it('registerGeometry() / getClothGeometryResult() round-trips (the restore path)', () => {
    const mesh = cloth.createClothMesh(0, 0, 0, { cols: 4, rows: 4 });
    const result = cloth.getClothGeometryResult(mesh.id)!;
    const fresh = new Scene3DCloth(env.ctx, env.host);
    expect(fresh.getClothGeometryResult(mesh.id)).toBeNull();
    fresh.registerGeometry(mesh.id, result);
    expect(fresh.getClothGeometryResult(mesh.id)).toBe(result);
  });

  it('non-cloth / unknown-mesh guards return the empty sentinel, not a throw', () => {
    expect(cloth.getClothConfig('nope')).toBeNull();
    expect(cloth.getClothGeometryResult('nope')).toBeNull();
    expect(cloth.getClothStitches('nope')).toEqual([]);
    expect(cloth.getWindZones('nope')).toEqual([]);
    expect(cloth.getClothBendStiffnessMap('nope')).toBeNull();
    expect(cloth.setClothPhysics('nope', { gravity: 5 })).toBe(false);
    expect(cloth.addWindZone('nope', { shape: 'sphere', center: [0, 0, 0], windVec: [0, 0, 0], falloff: 'none' })).toBeNull();
    expect(cloth.getClothVertexSlot('nope', 0, 0)).toBeNull();
  });

  it('dispose() is safe on an empty subsystem and after creating a mesh', () => {
    cloth.createClothMesh(0, 0, 0);
    expect(() => cloth.dispose()).not.toThrow();
    expect(() => cloth.dispose()).not.toThrow();
  });
});
