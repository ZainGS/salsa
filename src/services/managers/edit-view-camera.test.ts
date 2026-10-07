/**
 * Edit Mesh / UV camera (UI review 2026-10-07 §3 #17): a fresh entry frames the mesh in a 3/4 view at ~60 % of the
 * view; a mode SWITCH (the same mesh's edit view left and re-entered right away) keeps the user's camera; the ortho
 * framing fits the box's on-screen silhouette (orthoFitHalfHeight) — identical to the old dx / dy rule straight on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scene3DArmature, type Scene3DArmatureHost, EDIT_VIEW_AZIMUTH, EDIT_VIEW_ELEVATION, EDIT_VIEW_PADDING, EDIT_CAMERA_KEEP_MS } from './scene3d-armature';
import { orthoFitHalfHeight } from './scene3d-manager';
import { Camera3D } from '../../renderer/3d/camera-3d';
import type { ManagerContext } from './manager-context';

describe('orthoFitHalfHeight', () => {
  it('straight on: exactly the old max(dy / 2, dx / 2 / aspect)', () => {
    expect(orthoFitHalfHeight(2, 1, 5, [0, 0, 1], [0, 1, 0], 1.5)).toBe(Math.max(0.5, 1 / 1.5));
    expect(orthoFitHalfHeight(1, 3, 0, [0, 0, 1], [0, 1, 0], 1)).toBe(1.5);
  });

  it('an oblique view fits the silhouette (a unit cube from a 3/4 view needs more than 0.5)', () => {
    const el = EDIT_VIEW_ELEVATION, az = EDIT_VIEW_AZIMUTH;
    const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    const h = orthoFitHalfHeight(1, 1, 1, dir, [0, 1, 0], 1);
    expect(h).toBeGreaterThan(0.6);
    expect(h).toBeLessThan(Math.sqrt(3) / 2 + 1e-9);          // never more than the bounding sphere
  });

  it('looking along up falls back to dx / dy', () => {
    expect(orthoFitHalfHeight(2, 4, 1, [0, 1, 0], [0, 1, 0], 1)).toBe(2);
  });
});

describe('Edit Mesh entry camera', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const camera = new Camera3D({ position: [0, 0, 10], target: [0, 0, 0] });
    camera.aspect = 1;
    const framed: Array<{ id: string; padding: number; dir: number[] }> = [];
    const renderer3D = { getCamera: () => camera, setMeshEditModeActive: () => {} };
    const ctx = {
      webgpuRenderer: { getCanvas: () => null, getRenderer3D: () => renderer3D, addPreRenderCallback: () => {}, removePreRenderCallback: () => {} },
      scheduleRender: () => {},
      interactionService: { cameraOwnsView: false, suppressBoxSelect: false },
    } as unknown as ManagerContext;
    const centers: Record<string, [number, number, number]> = { a: [1, 2, 3], b: [-4, 0, 0] };
    const host = {
      getMeshCenter: (id: string | null) => (id ? centers[id] ?? null : null),
      frameMesh: (id: string, padding: number) => {
        const p = camera.position, t = camera.target;
        framed.push({ id, padding, dir: [p[0] - t[0], p[1] - t[1], p[2] - t[2]] });
        camera.orthoSize = 0.5;
        return true;
      },
      syncFocusBgLiveLoop: () => {},
      ensureIdleCallback: () => {},
    } as unknown as Scene3DArmatureHost;
    const arm = new Scene3DArmature(ctx, host);
    return { arm, camera, framed };
  }
  const spherical = (arm: Scene3DArmature) => { const o = arm.getOrbitController()!; return { az: o.azimuth, el: o.elevation }; };

  it('a fresh entry: the 3/4 view is set BEFORE framing (so the fit uses it), ~60 % padding, the zoom seeded from it', () => {
    const { arm, camera, framed } = setup();
    arm.enableMeshEditOrbit('a');
    expect(framed).toHaveLength(1);
    expect(framed[0].padding).toBe(EDIT_VIEW_PADDING);
    const d = framed[0].dir, len = Math.hypot(d[0], d[1], d[2]);
    expect(Math.asin(d[1] / len)).toBeCloseTo(EDIT_VIEW_ELEVATION, 5);
    expect(Math.atan2(d[0], d[2])).toBeCloseTo(EDIT_VIEW_AZIMUTH, 5);
    expect(camera.mode).toBe('orthographic');
    expect(Array.from(camera.target)).toEqual([1, 2, 3]);
    expect(spherical(arm).el).toBeCloseTo(EDIT_VIEW_ELEVATION, 5);
  });

  it('a mode switch on the same mesh keeps the camera (orbit, target, zoom); another mesh or a late re-entry re-frames', () => {
    const { arm, camera, framed } = setup();
    arm.enableMeshEditOrbit('a');
    const oc = arm.getOrbitController()!;
    camera.setTarget(1.5, 2, 3);                               // the user panned…
    oc.setSpherical(1.2, -0.3);                                // …orbited…
    camera.orthoSize = 0.25;
    arm.reseedDecoupledZoom();                                 // …and zoomed (what Frame / the wheel leave behind)
    arm.disableMeshEditOrbit();
    arm.enableMeshEditOrbit('a');                              // e.g. Edit Mesh → UV editor in one click
    expect(framed).toHaveLength(1);
    expect(spherical(arm).az).toBeCloseTo(1.2, 6);
    expect(spherical(arm).el).toBeCloseTo(-0.3, 6);
    expect(Array.from(camera.target).map(v => +v.toFixed(5))).toEqual([1.5, 2, 3]);
    expect(camera.orthoSize).toBeCloseTo(0.25, 6);

    arm.disableMeshEditOrbit();
    arm.enableMeshEditOrbit('b');                              // another mesh: framed fresh
    expect(framed).toHaveLength(2);

    arm.disableMeshEditOrbit();
    const t0 = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(t0 + EDIT_CAMERA_KEEP_MS + 50);
    arm.enableMeshEditOrbit('b');                              // re-entered later: framed fresh
    expect(framed).toHaveLength(3);
    expect(spherical(arm).az).toBeCloseTo(EDIT_VIEW_AZIMUTH, 5);
  });
});
