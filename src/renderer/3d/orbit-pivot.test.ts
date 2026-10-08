/**
 * orbit-pivot.test.ts — the edit views' orbit PIVOT (notes 2026-10-08 #1): an orbit gesture revolves the camera rig
 * around the host's pivot (OrbitController.getOrbitPivot, asked when the gesture starts), so the pivot keeps its exact
 * place on screen — no jump at the start, none during the drag or its momentum — while pan / zoom carry on from the
 * moved target. Without a hook (the scene's orbit) the classic orbit around the target is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import { OrbitController } from './orbit-controller';
import { Camera3D } from './camera-3d';

type Init = Partial<{ pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; altKey: boolean }>;

function setup(opts: { pivot?: [number, number, number] | null; damping?: boolean; ortho?: boolean; editNav?: boolean } = {}) {
  const cam = new Camera3D({ position: [0, 1, 6], target: [0, 0, 0], sceneRadius: 10 });
  if (opts.ortho) cam.mode = 'orthographic';
  const orb = new OrbitController(cam, { enableDamping: !!opts.damping, altOrbitOnly: true });
  orb.isEditNav = () => opts.editNav ?? true;
  const asked: number[] = [];
  if (opts.pivot !== undefined) orb.getOrbitPivot = () => { asked.push(1); return opts.pivot ?? null; };
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(el, {
    style: { touchAction: '' }, width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {},
  });
  const canvas = el as unknown as HTMLCanvasElement;
  orb.attach(canvas);
  const fire = (type: string, init: Init): void => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, altKey: false, isPrimary: true, ...init });
    canvas.dispatchEvent(e);
  };
  /** A world point in the camera's VIEW space (its screen place in ortho; with depth in perspective). */
  const view = (p: [number, number, number]): number[] => {
    const out = vec3.transformMat4(vec3.create(), vec3.fromValues(p[0], p[1], p[2]), cam.getViewMatrix());
    return Array.from(out);
  };
  return { cam, orb, fire, view, asked };
}

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe('OrbitController — orbit around a pivot', () => {
  it('an Alt+drag orbit keeps the pivot fixed on screen (no jump at the start, none during the drag)', () => {
    const P: [number, number, number] = [1.2, -0.4, 0.7];
    const t = setup({ pivot: P });
    const before = t.view(P);
    const pos0 = Array.from(t.cam.position), tgt0 = Array.from(t.cam.target);
    t.fire('pointerdown', { altKey: true, clientX: 100, clientY: 100 });
    expect(t.asked).toHaveLength(1);                                   // asked once, when the gesture starts
    close(Array.from(t.cam.position), pos0, 9);                        // pressing moves nothing
    close(Array.from(t.cam.target), tgt0, 9);
    t.fire('pointermove', { altKey: true, clientX: 160, clientY: 130 });
    close(t.view(P), before);
    t.fire('pointermove', { altKey: true, clientX: 260, clientY: 40 });
    close(t.view(P), before);
    t.fire('pointerup', { altKey: true, clientX: 260, clientY: 40 });
    expect(t.asked).toHaveLength(1);
    // the view really turned (and the target moved off its old place around the pivot)
    expect(Math.hypot(t.cam.position[0] - pos0[0], t.cam.position[2] - pos0[2])).toBeGreaterThan(0.1);
    expect(Math.hypot(t.cam.target[0] - tgt0[0], t.cam.target[1] - tgt0[1], t.cam.target[2] - tgt0[2])).toBeGreaterThan(0.01);
    // the orbit radius (target ↔ camera) is unchanged: zoom carries on as before
    expect(vec3.distance(t.cam.position, t.cam.target)).toBeCloseTo(Math.hypot(0, 1, 6), 6);
  });

  it('pen / finger drags that turn into an orbit use the pivot; damped momentum keeps it fixed too', () => {
    const P: [number, number, number] = [-0.8, 0.5, 0.3];
    for (const pointerType of ['pen', 'touch']) {
      const t = setup({ pivot: P, damping: true, ortho: true });
      const before = t.view(P);
      t.fire('pointerdown', { pointerType, clientX: 100, clientY: 100 });
      t.fire('pointermove', { pointerType, clientX: 150, clientY: 120 });
      t.fire('pointermove', { pointerType, clientX: 190, clientY: 150 });
      t.fire('pointerup', { pointerType, clientX: 190, clientY: 150 });
      expect(t.asked).toHaveLength(1);
      let frames = 0;
      // (5 digits: ~100 Float32 camera updates — the view-space depth ≈ 5.7 is a few ulps off by the end)
      while (t.orb.update() && frames < 500) { frames++; close(t.view(P), before, 5); }
      expect(frames).toBeGreaterThan(5);
      close(t.view(P), before, 5);
    }
  });

  it('the elevation clamp holds the pivot too (a drag past the pole)', () => {
    const P: [number, number, number] = [0.5, 0.2, -0.6];
    const t = setup({ pivot: P });
    const before = t.view(P);
    t.fire('pointerdown', { altKey: true, clientX: 100, clientY: 100 });
    t.fire('pointermove', { altKey: true, clientX: 100, clientY: 900 });   // far past maxElevation
    expect(t.orb.elevation).toBeCloseTo(t.orb.maxElevation, 9);
    close(t.view(P), before);
    t.fire('pointermove', { altKey: true, clientX: 140, clientY: 1000 });
    close(t.view(P), before);
  });

  it('a null pivot (the host has none) = the classic orbit around the target', () => {
    const t = setup({ pivot: null });
    t.fire('pointerdown', { altKey: true, clientX: 100, clientY: 100 });
    t.fire('pointermove', { altKey: true, clientX: 180, clientY: 100 });
    t.fire('pointerup', { altKey: true, clientX: 180, clientY: 100 });
    close(Array.from(t.cam.target), [0, 0, 0], 9);                      // orbit around the target, as before
    expect(t.orb.orbitPivot).toBeNull();
  });

  it('no hook (the scene orbit): unchanged — the target stays put', () => {
    const t = setup({ editNav: false });
    t.orb.altOrbitOnly = false;
    t.fire('pointerdown', { clientX: 100, clientY: 100 });
    t.fire('pointermove', { clientX: 200, clientY: 150 });
    t.fire('pointerup', { clientX: 200, clientY: 150 });
    close(Array.from(t.cam.target), [0, 0, 0], 9);
    expect(t.orb.azimuth).toBeCloseTo(Math.atan2(0, 6) - 100 * t.orb.orbitSpeed, 9);
  });
});
