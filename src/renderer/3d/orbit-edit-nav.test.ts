/**
 * orbit-edit-nav.test.ts — edit-view navigation (Edit Mesh / UV editor / Armature; round-3 tablet feedback 2026-10-08,
 * a pen with NO side button): a pen / one-finger drag that no tool claimed (pointer-claims) orbits once past the slop,
 * a tap stays the tool's, two fingers pan + pinch zoom, the host's Pan tool pans with any one-pointer drag (mouse too),
 * the mouse is otherwise unchanged. Synthetic pointer events on a fake canvas drive the real OrbitController.
 */
import { describe, it, expect } from 'vitest';
import { OrbitController } from './orbit-controller';
import { Camera3D } from './camera-3d';
import { claimPointerEvent } from '../util/pointer-claims';

type Init = Partial<{ pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; altKey: boolean; isPrimary: boolean }>;

function setup(opts: { editNav?: boolean; pan?: boolean; ortho?: boolean } = {}) {
  const cam = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0], sceneRadius: 10 });
  if (opts.ortho) cam.mode = 'orthographic';
  const orb = new OrbitController(cam, { enableDamping: false, altOrbitOnly: true });
  const nav = { on: opts.editNav ?? true, pan: !!opts.pan };
  orb.isEditNav = () => nav.on;
  orb.isPanTool = () => nav.pan;
  const zooms: number[] = [];
  orb.onTouchZoom = (ratio) => { zooms.push(ratio); };
  const el = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(el, {
    style: { touchAction: '' }, width: 800, height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {}, releasePointerCapture: () => {},
  });
  const canvas = el as unknown as HTMLCanvasElement;
  orb.attach(canvas);
  const fire = (type: string, init: Init, claim = false): Event => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, altKey: false, isPrimary: true, ...init });
    if (claim) claimPointerEvent(e);
    canvas.dispatchEvent(e);
    return e;
  };
  const tgt = () => Array.from(cam.target).map(v => +v.toFixed(6));
  return { cam, orb, nav, fire, tgt, zooms };
}

describe('OrbitController — edit-view navigation (pen / finger)', () => {
  it('pen: a drag past the slop orbits, following the pen from where it passed the slop (no jump); a tap moves nothing', () => {
    const t = setup();
    expect(t.orb.editNavActive).toBe(true);
    const az0 = t.orb.azimuth;
    t.fire('pointerdown', { pointerType: 'pen', clientX: 100, clientY: 100 });
    t.fire('pointermove', { pointerType: 'pen', clientX: 105, clientY: 100 });
    expect(t.orb.azimuth).toBe(az0);                                   // a tap so far
    t.fire('pointermove', { pointerType: 'pen', clientX: 120, clientY: 100 });
    expect(t.orb.azimuth).toBe(az0);                                   // the slop movement isn't applied (no jump)
    t.fire('pointermove', { pointerType: 'pen', clientX: 130, clientY: 100 });
    expect(t.orb.azimuth).toBeCloseTo(az0 - 10 * t.orb.orbitSpeed, 12);
    t.fire('pointerup', { pointerType: 'pen', clientX: 130, clientY: 100 });
    t.fire('pointermove', { pointerType: 'pen', clientX: 200, clientY: 100 });   // hover after the lift: nothing
    expect(t.orb.azimuth).toBeCloseTo(az0 - 10 * t.orb.orbitSpeed, 12);
    // a tap: press + release inside the slop
    t.fire('pointerdown', { pointerType: 'pen', clientX: 300, clientY: 300 });
    t.fire('pointerup', { pointerType: 'pen', clientX: 303, clientY: 302 });
    expect(t.orb.azimuth).toBeCloseTo(az0 - 10 * t.orb.orbitSpeed, 12);
  });

  it('pen / finger: a press a tool CLAIMED (a drag of the selection, a gizmo, a stroke) never orbits', () => {
    const t = setup();
    const az0 = t.orb.azimuth;
    t.fire('pointerdown', { pointerType: 'pen', clientX: 100, clientY: 100 }, true);
    t.fire('pointermove', { pointerType: 'pen', clientX: 160, clientY: 100 });
    t.fire('pointerup', { pointerType: 'pen', clientX: 160, clientY: 100 });
    t.fire('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 }, true);
    t.fire('pointermove', { pointerType: 'touch', clientX: 160, clientY: 100 });
    t.fire('pointerup', { pointerType: 'touch', clientX: 160, clientY: 100 });
    expect(t.orb.azimuth).toBe(az0);
    // …and while a tool disabled the controller (a joint drag holds the orbit) nothing moves either
    t.orb.enabled = false;
    t.fire('pointerdown', { pointerType: 'pen', clientX: 100, clientY: 100 });
    t.fire('pointermove', { pointerType: 'pen', clientX: 160, clientY: 100 });
    t.fire('pointerup', { pointerType: 'pen', clientX: 160, clientY: 100 });
    expect(t.orb.azimuth).toBe(az0);
  });

  it('one finger off the selection orbits past the slop; two fingers PAN (no orbit) and pinch zooms', () => {
    const t = setup({ ortho: true });
    const az0 = t.orb.azimuth;
    t.fire('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
    t.fire('pointermove', { pointerType: 'touch', clientX: 104, clientY: 100 });
    expect(t.orb.azimuth).toBe(az0);
    t.fire('pointermove', { pointerType: 'touch', clientX: 140, clientY: 100 });
    expect(t.orb.azimuth).toBe(az0);                                  // passing the slop: no jump…
    t.fire('pointermove', { pointerType: 'touch', clientX: 160, clientY: 100 });
    expect(t.orb.azimuth).toBeCloseTo(az0 - 20 * t.orb.orbitSpeed, 12);   // …then it follows the finger
    t.fire('pointerup', { pointerType: 'touch', clientX: 160, clientY: 100 });
    const az1 = t.orb.azimuth, t0 = t.tgt();
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 300 });
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 400, clientY: 300 });
    t.fire('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 330, clientY: 300 });
    t.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 430, clientY: 300 });
    expect(t.orb.azimuth).toBe(az1);                                  // not an orbit…
    expect(t.tgt()[0]).not.toBeCloseTo(t0[0], 6);                     // …a pan
    t.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 530, clientY: 300 });   // spread: zoom in
    expect(t.zooms.length).toBeGreaterThan(0);
    expect(t.zooms.at(-1)!).toBeGreaterThan(1);
  });

  it('outside an edit view (altOrbitOnly tool modes): a pen drag does nothing, two fingers orbit (unchanged)', () => {
    const t = setup({ editNav: false });
    expect(t.orb.editNavActive).toBe(false);
    const az0 = t.orb.azimuth;
    t.fire('pointerdown', { pointerType: 'pen', clientX: 100, clientY: 100 });
    t.fire('pointermove', { pointerType: 'pen', clientX: 160, clientY: 100 });
    t.fire('pointerup', { pointerType: 'pen', clientX: 160, clientY: 100 });
    t.fire('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
    t.fire('pointermove', { pointerType: 'touch', clientX: 160, clientY: 100 });
    t.fire('pointerup', { pointerType: 'touch', clientX: 160, clientY: 100 });
    expect(t.orb.azimuth).toBe(az0);
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 300 });
    t.fire('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false, clientX: 400, clientY: 300 });
    t.fire('pointermove', { pointerType: 'touch', pointerId: 1, clientX: 330, clientY: 300 });
    expect(t.orb.azimuth).not.toBe(az0);
  });

  it('the mouse is unchanged in an edit view: a plain left drag never orbits, Alt+left does, middle pans', () => {
    const t = setup();
    const az0 = t.orb.azimuth, t0 = t.tgt();
    t.fire('pointerdown', { clientX: 100, clientY: 100 });
    t.fire('pointermove', { clientX: 160, clientY: 100 });
    t.fire('pointerup', { clientX: 160, clientY: 100 });
    expect(t.orb.azimuth).toBe(az0);
    expect(t.tgt()).toEqual(t0);
    t.fire('pointerdown', { clientX: 100, clientY: 100, altKey: true });
    t.fire('pointermove', { clientX: 110, clientY: 100, altKey: true });
    t.fire('pointerup', { clientX: 110, clientY: 100 });
    expect(t.orb.azimuth).toBeCloseTo(az0 - 10 * t.orb.orbitSpeed, 12);
    t.fire('pointerdown', { button: 1, clientX: 0, clientY: 0 });
    t.fire('pointermove', { clientX: 20, clientY: 0 });
    expect(t.tgt()[0]).not.toBeCloseTo(t0[0], 6);
  });
});

describe('OrbitController — the host Pan tool in an edit view', () => {
  it('mouse left / pen / one finger drags PAN at once (no orbit); off again = select / orbit rules back', () => {
    const t = setup({ pan: true });
    const az0 = t.orb.azimuth;
    for (const pointerType of ['mouse', 'pen', 'touch']) {
      const t0 = t.tgt();
      t.fire('pointerdown', { pointerType, clientX: 100, clientY: 100 });
      t.fire('pointermove', { pointerType, clientX: 103, clientY: 100 });   // pans from the first pixel
      t.fire('pointermove', { pointerType, clientX: 140, clientY: 100 });
      t.fire('pointerup', { pointerType, clientX: 140, clientY: 100 });
      expect(t.tgt()[0]).not.toBeCloseTo(t0[0], 6);
      expect(t.orb.azimuth).toBe(az0);
    }
    t.nav.pan = false;
    const t1 = t.tgt();
    t.fire('pointerdown', { pointerType: 'pen', clientX: 100, clientY: 100 });
    t.fire('pointermove', { pointerType: 'pen', clientX: 140, clientY: 100 });
    t.fire('pointermove', { pointerType: 'pen', clientX: 160, clientY: 100 });
    t.fire('pointerup', { pointerType: 'pen', clientX: 160, clientY: 100 });
    expect(t.tgt()).toEqual(t1);
    expect(t.orb.azimuth).not.toBe(az0);                              // a pen drag orbits again
  });
});
