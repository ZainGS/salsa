/**
 * orbit-roll.test.ts — VIEW ROLL (2026-10-08): a two-finger TWIST rolls the view around its axis, together with the
 * two-finger pan + pinch in one gesture; it snaps to level / ±90° / 180° with hysteresis; the orbit stays a turntable
 * whose drags are read on the rolled screen; pan follows the rolled screen; a pivot orbit and a Frame (lookAt +
 * syncFromCamera) keep the roll; a view the host doesn't let roll stays level.
 */
import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import { OrbitController, OrbitControllerRoll, rollSnap, unrollScreenDelta, wrapAngle } from './orbit-controller';
import { Camera3D } from './camera-3d';

const DEG = Math.PI / 180;
type Init = Partial<{ pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; altKey: boolean }>;

function setup(opts: { canRoll?: boolean | null; ortho?: boolean; altOrbitOnly?: boolean; editNav?: boolean; pivot?: [number, number, number] } = {}) {
  const cam = new Camera3D({ position: [0, 1, 6], target: [0, 0, 0], sceneRadius: 10 });
  cam.aspect = 800 / 600;
  if (opts.ortho) cam.mode = 'orthographic';
  const orb = new OrbitController(cam, { enableDamping: false, altOrbitOnly: !!opts.altOrbitOnly });
  if (opts.canRoll !== null) orb.canRoll = () => opts.canRoll ?? true;
  if (opts.editNav) orb.isEditNav = () => true;
  if (opts.pivot) orb.getOrbitPivot = () => opts.pivot!;
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
  const touch = (type: string, id: number, x: number, y: number) => fire(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y });
  /** A world point in VIEW space (x right, y up on screen; z toward the viewer). */
  const view = (p: ArrayLike<number>): number[] =>
    Array.from(vec3.transformMat4(vec3.create(), vec3.fromValues(p[0], p[1], p[2]), cam.getViewMatrix()));
  /** The screen angle (y UP, radians) of `p` around the target, as seen. */
  const screenAngle = (p: ArrayLike<number>): number => {
    const a = view(p), t = view(cam.target);
    return Math.atan2(a[1] - t[1], a[0] - t[0]);
  };
  return { cam, orb, fire, touch, view, screenAngle };
}

/** Two fingers from (a0, b0) to (a1, b1) in `steps` moves (each step moves finger 1, then finger 2). */
function twoFingerGesture(t: ReturnType<typeof setup>, a0: [number, number], b0: [number, number], a1: [number, number], b1: [number, number], steps = 20) {
  t.touch('pointerdown', 1, a0[0], a0[1]);
  t.touch('pointerdown', 2, b0[0], b0[1]);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    t.touch('pointermove', 1, a0[0] + (a1[0] - a0[0]) * k, a0[1] + (a1[1] - a0[1]) * k);
    t.touch('pointermove', 2, b0[0] + (b1[0] - b0[0]) * k, b0[1] + (b1[1] - b0[1]) * k);
  }
  t.touch('pointerup', 1, a1[0], a1[1]);
  t.touch('pointerup', 2, b1[0], b1[1]);
}
/** Finger positions on a circle of `r` around (cx, cy) at screen angle `deg` (y down: + = clockwise). */
const pair = (cx: number, cy: number, r: number, deg: number): [[number, number], [number, number]] => {
  const c = Math.cos(deg * DEG) * r, s = Math.sin(deg * DEG) * r;
  return [[cx - c, cy - s], [cx + c, cy + s]];
};
/** A rolled camera's up is unit length and perpendicular to the view direction (Float32 precision); unrolled it is
 *  world up exactly (lookAt makes the frame). */
function expectOrthonormalUp(cam: Camera3D, roll: number): void {
  if (roll === 0) { expect(Array.from(cam.up)).toEqual([0, 1, 0]); return; }
  const f = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), cam.target, cam.position));
  expect(vec3.length(cam.up)).toBeCloseTo(1, 6);
  expect(vec3.dot(f, cam.up)).toBeCloseTo(0, 6);
}

describe('VIEW ROLL — the two-finger twist', () => {
  it('turning the two fingers rolls the view by the change in their angle; the picture turns with the fingers', () => {
    const t = setup();
    const P = [1, 0, 0];                                   // a point to the right of the target on screen
    expect(t.screenAngle(P)).toBeCloseTo(0, 6);
    const [a0, b0] = pair(400, 300, 100, 0), [a1, b1] = pair(400, 300, 100, 20);   // +20°: clockwise on screen
    twoFingerGesture(t, a0, b0, a1, b1);
    expect(t.orb.roll).toBeCloseTo(-20 * DEG, 9);          // the telescoped angle change, exactly
    expect(t.screenAngle(P)).toBeCloseTo(-20 * DEG, 2);    // clockwise on screen (y up: −20°), like the fingers
    expectOrthonormalUp(t.cam, t.orb.roll);
    // and back the other way, past level and on: −35° on screen → the roll goes the other way
    const [a2, b2] = pair(400, 300, 100, -15);
    twoFingerGesture(t, a1, b1, a2, b2);
    expect(t.orb.roll).toBeCloseTo(15 * DEG, 9);
  });

  it('pan + pinch zoom + twist run together in ONE gesture (no mode switch)', () => {
    const t = setup();
    const r0 = t.orb.radius, tg0 = Array.from(t.cam.target);
    // midpoint +60 px right, spread 200 → 400 (zoom ×2), angle 0 → +30°
    const [a0, b0] = pair(400, 300, 100, 0), [a1, b1] = pair(460, 300, 200, 30);
    twoFingerGesture(t, a0, b0, a1, b1, 30);
    expect(t.orb.roll).toBeCloseTo(-30 * DEG, 9);
    expect(t.orb.radius).toBeCloseTo(r0 / 2, 6);          // the pinch: radius / Π ratios = r0 / 2
    expect(Math.hypot(t.cam.target[0] - tg0[0], t.cam.target[1] - tg0[1], t.cam.target[2] - tg0[2])).toBeGreaterThan(0.05);   // the pan
    // the pan went the way the fingers went ON the rolled screen: the old target now sits right of centre
    const v = t.view(tg0), c = t.view(t.cam.target);
    expect(v[0] - c[0]).toBeGreaterThan(0);
    expect(Math.abs(v[1] - c[1])).toBeLessThan(Math.abs(v[0] - c[0]) * 0.3);
  });

  it('a view the host does not let roll stays level (no hook, hook false, the tool modes\' two-finger orbit)', () => {
    for (const t of [setup({ canRoll: null }), setup({ canRoll: false }), setup({ altOrbitOnly: true })]) {
      const [a0, b0] = pair(400, 300, 100, 0), [a1, b1] = pair(400, 300, 100, 40);
      twoFingerGesture(t, a0, b0, a1, b1);
      expect(t.orb.roll).toBe(0);
      expect(Array.from(t.cam.up)).toEqual([0, 1, 0]);
    }
    // a stored roll is not applied while the host says no, and comes back when it says yes
    let allowed = false;
    const t = setup();
    t.orb.canRoll = () => allowed;
    t.orb.roll = 30 * DEG;
    t.orb.applySpherical();
    expect(Array.from(t.cam.up)).toEqual([0, 1, 0]);
    expect(t.orb.effectiveRoll).toBe(0);
    allowed = true;
    t.orb.applySpherical();
    expect(t.cam.up[1]).toBeLessThan(0.99);
  });

  it('fingers almost on top of each other do not twist (their angle is noise)', () => {
    const t = setup();
    const [a0, b0] = pair(400, 300, 5, 0), [a1, b1] = pair(400, 300, 5, 80);
    twoFingerGesture(t, a0, b0, a1, b1);
    expect(t.orb.roll).toBe(0);
  });
});

describe('VIEW ROLL — snap to level / ±90° / 180° with hysteresis', () => {
  const deg = (orb: OrbitController) => orb.roll / DEG;

  it('level holds until the twist passes SNAP_OUT; coming back snaps at SNAP_IN; no jitter on the edge', () => {
    expect(OrbitControllerRoll.SNAP_IN).toBeCloseTo(5 * DEG, 12);
    expect(OrbitControllerRoll.SNAP_OUT).toBeCloseTo(8 * DEG, 12);
    const { orb } = setup();
    for (let i = 0; i < 8; i++) { orb.twist(-1 * DEG); expect(orb.roll).toBe(0); }   // up to 8°: still level
    orb.twist(-1 * DEG);
    expect(deg(orb)).toBeCloseTo(9, 9);                     // past 8°: free
    orb.twist(3 * DEG);
    expect(deg(orb)).toBeCloseTo(6, 9);                     // 6° (> 5°): still free
    orb.twist(1.5 * DEG);
    expect(orb.roll).toBe(0);                               // 4.5°: snapped level
    // jitter across the snap-in edge (4°…7.5°, cumulative) stays level — leaving needs the full 8°
    for (const d of [-2, 1.5, -2.5, 2, -1.5, 3]) { orb.twist(d * DEG); expect(orb.roll).toBe(0); }
  });

  it('snaps to ±90° and 180° the same way (and wraps across ±180°)', () => {
    const { orb } = setup();
    orb.twist(-86 * DEG);
    expect(deg(orb)).toBeCloseTo(90, 9);
    orb.twist(-7 * DEG);
    expect(deg(orb)).toBeCloseTo(90, 9);                    // 93°: held
    orb.twist(-6 * DEG);
    expect(deg(orb)).toBeCloseTo(99, 9);                    // 99°: free
    orb.setRoll(0);
    orb.twist(88 * DEG);
    expect(deg(orb)).toBeCloseTo(-90, 9);
    orb.setRoll(170 * DEG);
    orb.twist(-6 * DEG);
    expect(Math.abs(deg(orb))).toBeCloseTo(180, 9);         // 176°: 180°
    orb.twist(-10 * DEG);
    expect(Math.abs(deg(orb))).toBeCloseTo(180, 9);         // 186° (= −174°): held across the wrap
    orb.twist(-3 * DEG);
    expect(deg(orb)).toBeCloseTo(-171, 9);                  // 189° = −171°: free
  });

  it('rollSnap / wrapAngle / unrollScreenDelta (pure)', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(rollSnap(4 * DEG, null)).toEqual({ roll: 0, snapped: 0 });
    expect(rollSnap(6 * DEG, null).snapped).toBeNull();
    expect(rollSnap(7 * DEG, 0)).toEqual({ roll: 0, snapped: 0 });
    expect(rollSnap(-87 * DEG, null).roll).toBeCloseTo(-Math.PI / 2, 12);
    expect(unrollScreenDelta(3, 4, 0)).toEqual([3, 4]);
    const [x, y] = unrollScreenDelta(0, -10, Math.PI / 2);
    expect(x).toBeCloseTo(10, 12); expect(y).toBeCloseTo(0, 12);
  });
});

describe('VIEW ROLL — orbit, pan, pivot and Frame under a roll', () => {
  /** The screen (y DOWN, CSS-like) displacement of the "front of the ball" point — what a grab-drag should move. */
  function frontPointMove(t: ReturnType<typeof setup>, drag: () => void): [number, number] {
    const toCam = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), t.cam.position, t.cam.target));
    const Q = vec3.scaleAndAdd(vec3.create(), t.cam.target, toCam, 0.5);
    const a = t.view(Q);
    drag();
    const b = t.view(Q);
    return [b[0] - a[0], -(b[1] - a[1])];
  }
  const cosBetween = (a: [number, number], b: [number, number]) => (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));

  it('a one-finger drag turns the way it looks on the ROLLED screen (the front of the subject follows the finger)', () => {
    for (const rollDeg of [0, 30, 90, -120, 180]) {
      for (const [dx, dy] of [[0, -20], [20, 0], [14, 14]] as const) {
        const t = setup();
        t.orb.setRoll(rollDeg * DEG);
        const m = frontPointMove(t, () => {
          t.touch('pointerdown', 1, 400, 300);
          t.touch('pointermove', 1, 400 + dx, 300 + dy);
          t.touch('pointerup', 1, 400 + dx, 300 + dy);
        });
        expect(cosBetween(m, [dx, dy])).toBeGreaterThan(0.99);   // same direction as the finger, at every roll
        expect(t.orb.roll).toBeCloseTo(wrapAngle(rollDeg * DEG), 12);   // orbiting keeps the roll
        expectOrthonormalUp(t.cam, t.orb.roll);
      }
    }
  });

  it('drag UP at a 90° roll spins around world up (azimuth), not the elevation; at 0° it tilts (elevation)', () => {
    const t = setup();
    const el0 = t.orb.elevation, az0 = t.orb.azimuth;
    t.touch('pointerdown', 1, 400, 300); t.touch('pointermove', 1, 400, 260); t.touch('pointerup', 1, 400, 260);
    expect(t.orb.elevation).toBeCloseTo(el0 - 40 * t.orb.orbitSpeed, 9);
    expect(t.orb.azimuth).toBeCloseTo(az0, 9);
    const r = setup();
    r.orb.setRoll(Math.PI / 2);
    const rel0 = r.orb.elevation, raz0 = r.orb.azimuth;
    r.touch('pointerdown', 1, 400, 300); r.touch('pointermove', 1, 400, 260); r.touch('pointerup', 1, 400, 260);
    expect(r.orb.elevation).toBeCloseTo(rel0, 9);
    expect(r.orb.azimuth).toBeCloseTo(raz0 - 40 * r.orb.orbitSpeed, 9);
  });

  it('the elevation limits still apply under a roll — no flip, no NaN', () => {
    const t = setup();
    t.orb.setRoll(60 * DEG);
    t.touch('pointerdown', 1, 400, 300);
    for (let i = 1; i <= 40; i++) t.touch('pointermove', 1, 400 - i * 30, 300 + i * 20);   // far past the pole
    t.touch('pointerup', 1, 400 - 1200, 300 + 800);
    expect(t.orb.elevation).toBeLessThanOrEqual(t.orb.maxElevation + 1e-12);
    expect(t.orb.elevation).toBeGreaterThanOrEqual(t.orb.minElevation - 1e-12);
    expect([...t.cam.position, ...t.cam.up].every(Number.isFinite)).toBe(true);
    expectOrthonormalUp(t.cam, t.orb.roll);
    expect(t.orb.roll).toBeCloseTo(60 * DEG, 12);
  });

  it('pan follows the rolled screen (mouse middle-drag and the two-finger pan)', () => {
    for (const rollDeg of [0, 90, 135]) {
      const t = setup();
      t.orb.setRoll(rollDeg * DEG);
      const T0 = Array.from(t.cam.target);
      t.fire('pointerdown', { button: 1, clientX: 400, clientY: 300 });
      t.fire('pointermove', { button: 1, clientX: 440, clientY: 300 });   // drag right
      t.fire('pointerup', { button: 1, clientX: 440, clientY: 300 });
      const a = t.view(T0), c = t.view(t.cam.target);
      expect(a[0] - c[0]).toBeGreaterThan(0);                              // the content moved RIGHT on screen
      expect(Math.abs(a[1] - c[1])).toBeLessThan(1e-6);
      // two fingers dragged DOWN together: the content moves down on screen
      const T1 = Array.from(t.cam.target);
      twoFingerGesture(t, [350, 300], [450, 300], [350, 340], [450, 340]);
      const b = t.view(T1), d = t.view(t.cam.target);
      expect(b[1] - d[1]).toBeLessThan(0);
      expect(Math.abs(b[0] - d[0])).toBeLessThan(Math.abs(b[1] - d[1]) * 0.05);   // (the fingers move one at a time: a hair of twist between)
      expect(t.orb.roll).toBeCloseTo(wrapAngle(rollDeg * DEG), 12);   // a straight two-finger pan doesn't twist
    }
  });

  it('a pivot orbit (edit views) keeps the pivot fixed on screen under a roll', () => {
    const P: [number, number, number] = [1.2, -0.4, 0.7];
    const t = setup({ pivot: P, altOrbitOnly: true, editNav: true, ortho: true });
    t.orb.setRoll(-35 * DEG);
    const before = t.view(P);
    t.fire('pointerdown', { altKey: true, clientX: 100, clientY: 100 });
    t.fire('pointermove', { altKey: true, clientX: 160, clientY: 130 });
    t.fire('pointermove', { altKey: true, clientX: 260, clientY: 40 });
    t.fire('pointerup', { altKey: true, clientX: 260, clientY: 40 });
    const after = t.view(P);
    for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(before[i], 6);
    expect(t.orb.roll).toBeCloseTo(-35 * DEG, 12);
  });

  it('a Frame (lookAt + syncFromCamera) keeps the roll; lookAt alone is level (Play / 2D / look-through)', () => {
    const t = setup();
    t.orb.setRoll(25 * DEG);
    const up0 = Array.from(t.cam.up);
    t.cam.lookAt(3, 2, 8, 1, 0, 0);
    expect(Array.from(t.cam.up)).toEqual([0, 1, 0]);      // a plain lookAt: level
    t.orb.syncFromCamera();                               // the host's Frame re-syncs the orbit
    expect(t.orb.roll).toBeCloseTo(25 * DEG, 12);
    expectOrthonormalUp(t.cam, t.orb.roll);
    expect(t.screenAngle([1 + Math.cos(t.orb.azimuth), 0, -Math.sin(t.orb.azimuth)])).toBeCloseTo(25 * DEG, 6);   // turntable right, rolled
    expect(up0).not.toEqual([0, 1, 0]);
  });

  it('Camera3D: setUp / resetUp; toJSON of the orbit carries the roll', () => {
    const cam = new Camera3D({ position: [0, 0, 5] });
    cam.setUp(1, 0, 0);
    expect(Array.from(cam.up)).toEqual([1, 0, 0]);
    cam.resetUp();
    expect(Array.from(cam.up)).toEqual([0, 1, 0]);
    const t = setup();
    t.orb.setRoll(0.4);
    expect(t.orb.toJSON().roll).toBeCloseTo(0.4, 12);
  });
});
