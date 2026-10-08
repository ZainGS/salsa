/**
 * orbit-fling.test.ts — tablet bug 2026-10-08: "a slow pen drag does nothing, then after dragging a bit and releasing
 * the orbit releases a ton of energy and spins fast". Cause: a damped orbit drag only ADDED its deltas to the damping
 * velocity (applied by update(), i.e. per rendered frame) and requested no frame — on the on-demand renderer nothing
 * drew during the drag, the velocity piled up undecayed, and the first frame after the lift spun it out ×12.5.
 * Now a drag turns the camera directly (follows the pointer from where it passed the slop, a frame requested per
 * move) and the release fling comes only from the last ~100 ms of real movement. Realistic timestamps
 * (performance.now mocked), pen / mouse / finger, edit-view and scene paths.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OrbitController } from './orbit-controller';
import { Camera3D } from './camera-3d';

type Init = Partial<{ pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; altKey: boolean }>;

let clock = 1000;
afterEach(() => { vi.restoreAllMocks(); });

function setup(opts: { editNav?: boolean; altOrbitOnly?: boolean } = {}) {
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const cam = new Camera3D({ position: [0, 1, 6], target: [0, 0, 0], sceneRadius: 10 });
  cam.mode = 'orthographic';
  const orb = new OrbitController(cam, { altOrbitOnly: opts.altOrbitOnly ?? true });   // damping ON (the default)
  orb.isEditNav = () => opts.editNav ?? true;
  let frames = 0;
  orb.onChange = () => { frames++; };
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
    Object.assign(e, { pointerId: 1, pointerType: 'pen', button: 0, clientX: 0, clientY: 0, altKey: false, isPrimary: true, ...init });
    canvas.dispatchEvent(e);
  };
  /** Total extra turn the release fling adds (runs update() like the per-frame callback, 60 Hz). */
  const glide = (): number => {
    const a = orb.azimuth;
    let n = 0;
    while (orb.update() && n < 2000) { n++; clock += 1000 / 60; }
    return Math.abs(orb.azimuth - a);
  };
  return { cam, orb, fire, glide, frames: () => frames };
}

/** Drag from x0 to x1 at `pxPerMs`, one event every `stepMs` (pen/mouse ~ 4–16 ms). */
function drag(t: ReturnType<typeof setup>, pointerType: string, x0: number, x1: number, pxPerMs: number, stepMs = 8, extra: Init = {}): void {
  t.fire('pointerdown', { pointerType, clientX: x0, clientY: 300, ...extra });
  for (let x = x0; x < x1;) {
    clock += stepMs;
    x = Math.min(x1, x + pxPerMs * stepMs);
    t.fire('pointermove', { pointerType, clientX: x, clientY: 300, ...extra });
  }
}

describe('OrbitController — drag follows the pointer, release fling from the last ~100 ms only', () => {
  it('a SLOW pen drag turns the camera on every move (a frame requested each time), from the slop point — no jump', () => {
    const t = setup();
    const az0 = t.orb.azimuth, sp = t.orb.orbitSpeed;
    t.fire('pointerdown', { clientX: 100, clientY: 300 });
    let x = 100, slopX = NaN;
    for (let i = 0; i < 200; i++) {
      clock += 8; x += 0.4;                                           // 0.05 px/ms — a very slow, careful drag
      const before = t.orb.azimuth, framesBefore = t.frames();
      t.fire('pointermove', { clientX: x, clientY: 300 });
      if (Number.isNaN(slopX) && x - 100 > OrbitController.TOOL_DRAG_SLOP_PX) { slopX = x; expect(t.orb.azimuth).toBe(before); continue; }
      if (!Number.isNaN(slopX)) {
        expect(t.orb.azimuth).toBeCloseTo(az0 - (x - slopX) * sp, 9);   // follows the pen exactly
        expect(t.frames()).toBeGreaterThan(framesBefore);                // …and asks for a frame (on-demand renderer)
      }
    }
    expect(t.orb.azimuth).toBeLessThan(az0 - 0.1);                    // it really turned during the drag
    clock += 8;
    t.fire('pointerup', { clientX: x, clientY: 300 });
    expect(t.glide()).toBe(0);                                         // a slow drag: no fling
  });

  it('a stop before the release = no fling, even after a fast drag', () => {
    const t = setup();
    drag(t, 'pen', 100, 400, 2);                                       // fast
    clock += 120;                                                      // held still for 120 ms
    t.fire('pointerup', { clientX: 400, clientY: 300 });
    expect(t.glide()).toBe(0);
  });

  it('a quick flick glides on a little (≈ its last-100 ms speed × 120 ms), bounded, and decays to a stop', () => {
    const t = setup();
    // slow for a long time, then a quick flick: only the flick's speed counts
    drag(t, 'pen', 100, 140, 0.05);
    const xFlick0 = 140;
    t.fire('pointermove', { clientX: xFlick0, clientY: 300 });
    for (let i = 1; i <= 10; i++) { clock += 8; t.fire('pointermove', { clientX: xFlick0 + i * 12, clientY: 300 }); }   // 1.5 px/ms
    clock += 4;
    t.fire('pointerup', { clientX: xFlick0 + 120, clientY: 300 });
    const g = t.glide();
    const expected = 1.5 * OrbitController.FLING_GLIDE_MS * t.orb.orbitSpeed;   // ≈ 0.9 rad
    expect(g).toBeGreaterThan(expected * 0.6);
    expect(g).toBeLessThan(expected * 1.1);
    expect(t.orb.update()).toBe(false);                                // settled
  });

  it('the old "stored-up energy": a drag with NO frames rendered during it releases nothing extra', () => {
    const t = setup();
    // no update() runs during the drag (the renderer is idle) — the turn is already applied per move
    drag(t, 'pen', 100, 200, 0.1);
    const azDrag = t.orb.azimuth;
    clock += 60;
    t.fire('pointerup', { clientX: 200, clientY: 300 });
    expect(t.glide()).toBe(0);
    expect(t.orb.azimuth).toBe(azDrag);
  });

  it('a press catches a gliding view; pointercancel never flings', () => {
    const t = setup();
    drag(t, 'pen', 100, 400, 2);
    t.fire('pointerup', { clientX: 400, clientY: 300 });
    expect(t.orb.update()).toBe(true);                                 // gliding
    t.fire('pointerdown', { clientX: 500, clientY: 300 });
    expect(t.orb.update()).toBe(false);                                // caught
    t.fire('pointerup', { clientX: 500, clientY: 300 });
    drag(t, 'pen', 100, 400, 2);
    t.fire('pointercancel', { clientX: 400, clientY: 300 });
    expect(t.glide()).toBe(0);
  });

  it('finger (one-finger edit orbit) and mouse (Alt+drag; the scene\'s plain left drag) behave the same', () => {
    for (const c of [
      { type: 'touch', extra: {}, editNav: true, alt: true },
      { type: 'mouse', extra: { altKey: true }, editNav: true, alt: true },
      { type: 'mouse', extra: {}, editNav: false, alt: false },          // the normal scene's orbit
    ]) {
      const t = setup({ editNav: c.editNav, altOrbitOnly: c.alt });
      const az0 = t.orb.azimuth;
      drag(t, c.type, 100, 200, 0.05, 8, c.extra);
      expect(t.orb.azimuth).toBeLessThan(az0 - 0.3);                   // followed during the drag
      clock += 8;
      t.fire('pointerup', { pointerType: c.type, clientX: 200, clientY: 300, ...c.extra });
      expect(t.glide()).toBe(0);                                       // slow → no fling
      drag(t, c.type, 100, 400, 2, 8, c.extra);
      clock += 4;
      t.fire('pointerup', { pointerType: c.type, clientX: 400, clientY: 300, ...c.extra });
      const g = t.glide();
      expect(g).toBeGreaterThan(0.3);                                  // a flick glides…
      expect(g).toBeLessThan(2 * OrbitController.FLING_GLIDE_MS * t.orb.orbitSpeed * 1.1);   // …boundedly
    }
  });
});
