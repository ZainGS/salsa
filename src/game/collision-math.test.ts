import { describe, it, expect } from 'vitest';
import { slideAlongWall, isClimbableStep, expSmooth, clampCameraDistance, groundProbeTop, sampleStandableGround, findStandableGround, resolveHorizontalMove, wallRayHeights, type RayCaster, type RayHit } from './collision-math';
import { CharacterController, NO_INPUT } from './character-controller';

describe('slideAlongWall', () => {
    it('slides along a wall facing -Z when moving +Z into it', () => {
        // Move from (0,0) toward (0,1); wall right at the start (blockDist 0), normal points -Z (0,0,-1).
        // The move is straight into the wall → tangent is zero → stop short (no slide).
        const [x, z] = slideAlongWall(0, 0, 0, 1, 0, 0, -1, 0);
        expect(x).toBeCloseTo(0, 6);
        expect(z).toBeCloseTo(0, 6);
    });

    it('slides diagonally: into-wall component removed, along-wall kept', () => {
        // Move NE (1,1) normalized; a wall with normal -Z (blocks +Z). blockDist 0, r 0.
        // Expect: +Z component cancelled, +X component preserved → slides to +X by |move|.
        const [x, z] = slideAlongWall(0, 0, 1, 1, 0, 0, -1, 0);
        const len = Math.hypot(1, 1);
        expect(x).toBeCloseTo(len, 5);   // full length spent sliding along +X
        expect(z).toBeCloseTo(0, 5);
    });

    it('advances up to the wall (minus radius) before sliding', () => {
        // Move +X by 5; wall dead ahead is irrelevant here (normal +X blocks +X → straight-in, stops short).
        const [x, z] = slideAlongWall(0, 0, 5, 0, 2, 1, 0, 0.5);
        expect(x).toBeCloseTo(1.5, 5);   // blockDist 2 − radius 0.5
        expect(z).toBeCloseTo(0, 5);
    });

    it('is a no-op for a zero-length move', () => {
        expect(slideAlongWall(3, 4, 3, 4, 0, 0, -1, 0.5)).toEqual([3, 4]);
    });
});

describe('isClimbableStep', () => {
    it('treats a small rise as a step', () => {
        expect(isClimbableStep(0, 0.3, 0.4)).toBe(true);
    });
    it('rejects a rise taller than stepHeight (a wall)', () => {
        expect(isClimbableStep(0, 1.2, 0.4)).toBe(false);
    });
    it('rejects flat / descending ground (not a step-up)', () => {
        expect(isClimbableStep(0, 0, 0.4)).toBe(false);
        expect(isClimbableStep(1, 0.5, 0.4)).toBe(false);
    });
    it('rejects a gap (null ground)', () => {
        expect(isClimbableStep(0, null, 0.4)).toBe(false);
    });
});

describe('expSmooth', () => {
    it('moves partway toward the target and converges', () => {
        let v = 0;
        for (let i = 0; i < 200; i++) v = expSmooth(v, 10, 12, 1 / 60);
        expect(v).toBeCloseTo(10, 3);
    });
    it('is a no-op at dt 0, and snaps when rate ≤ 0', () => {
        expect(expSmooth(3, 10, 12, 0)).toBe(3);
        expect(expSmooth(3, 10, 0, 1 / 60)).toBe(10);
    });
    it('takes a bigger step at a higher rate', () => {
        const slow = expSmooth(0, 1, 5, 1 / 60);
        const fast = expSmooth(0, 1, 30, 1 / 60);
        expect(fast).toBeGreaterThan(slow);
    });
});

describe('clampCameraDistance', () => {
    it('keeps the desired distance when nothing is hit', () => {
        expect(clampCameraDistance(4, 10, 0.25, 0.4)).toBe(4);
    });
    it('pulls in to just before a nearer wall', () => {
        expect(clampCameraDistance(4, 2, 0.25, 0.4)).toBeCloseTo(1.75, 6);
    });
    it('never closer than minDist (avoids clipping into the avatar)', () => {
        expect(clampCameraDistance(4, 0.3, 0.25, 0.4)).toBe(0.4);
    });
});


describe('groundProbeTop (R6.2: the step height, no longer half the eye height)', () => {
  it('starts the ground ray just above the feet, at the step height', () => {
    expect(groundProbeTop(2, 0.4, 1.6)).toBeCloseTo(2.4, 9);    // eye height no longer widens the window
    expect(groundProbeTop(0, 0.4)).toBeCloseTo(0.4, 9);
    expect(groundProbeTop(1, 0, 0)).toBeGreaterThan(1);         // never AT the feet (would miss a flush floor)
  });
});

// ── A fake box world for the ray-cast ground / wall rules ─────────────────────────────────────────────────────────
type Box = { min: [number, number, number]; max: [number, number, number] };
/** Double-sided AABB ray cast (like the BVH picker on closed meshes: from inside a box you hit its far face). */
function boxWorld(boxes: Box[]): RayCaster {
  return (o, d, maxDist) => {
    let best: RayHit | null = null;
    for (const b of boxes) {
      let t0 = -Infinity, t1 = Infinity, n0 = -1, n1 = -1;
      let ok = true;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-12) { if (o[a] < b.min[a] || o[a] > b.max[a]) { ok = false; break; } continue; }
        let ta = (b.min[a] - o[a]) / d[a], tb = (b.max[a] - o[a]) / d[a];
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) { t0 = ta; n0 = a; }
        if (tb < t1) { t1 = tb; n1 = a; }
        if (t0 > t1) { ok = false; break; }
      }
      if (!ok || t1 < 0) continue;
      const t = t0 >= 0 ? t0 : t1, axis = t0 >= 0 ? n0 : n1;
      if (t > maxDist) continue;
      const normal: [number, number, number] = [0, 0, 0];
      normal[axis] = 1;
      if (!best || t < best.distance) best = { distance: t, normal };
    }
    return best;
  };
}
const FLOOR: Box = { min: [-50, -1, -50], max: [50, 0, 50] };
const STEP = 0.4, EYE = 1.6, R = 0.35;

/** Drive a controller along +X (D = screen-right is −X, so walk with W after turning to face +X) through a box world
 *  with the real ground + wall rules, and return the max feet height seen. */
function runThrough(boxes: Box[], opts: { jumpAt?: number; ticks?: number } = {}) {
  const cast = boxWorld([FLOOR, ...boxes]);
  const c = new CharacterController({ acceleration: 0, deceleration: 0, moveSpeed: 3.5, stepHeight: STEP, eyeHeight: EYE, radius: R, cameraMode: 'third' }, [-6, 0, 0]);
  c.setHeading(Math.PI / 2);   // face +X
  c.groundSampler = (x, z) => sampleStandableGround(cast, x, z, c.pos[1], STEP, EYE);
  c.moveResolver = (fx, fz, tx, tz, r) => resolveHorizontalMove(cast, fx, fz, tx, tz, c.pos[1], r, STEP, EYE);
  let maxY = 0;
  const n = opts.ticks ?? 240;
  for (let i = 0; i < n; i++) {
    c.update(1 / 60, { ...NO_INPUT, forward: 1, jump: opts.jumpAt !== undefined && c.pos[0] > opts.jumpAt && c.pos[0] < opts.jumpAt + 0.2 });
    maxY = Math.max(maxY, c.pos[1]);
  }
  return { c, maxY };
}

describe('R6.2: never teleported onto overhead geometry (box world)', () => {
  it('runs UNDER a shop awning (underside 2.2 m, valance hanging to 1.9 m) at street level', () => {
    const awning: Box = { min: [-1, 2.2, -3], max: [1, 2.3, 3] };
    const valance: Box = { min: [0.9, 1.9, -3], max: [1, 2.2, 3] };
    const { c, maxY } = runThrough([awning, valance]);
    expect(c.pos[0]).toBeGreaterThan(3);       // got through (the valance is above the head ray at 1.52 m)
    expect(maxY).toBeCloseTo(0, 6);
  });

  it('runs under a BRIDGE DECK (2.6 m clearance, 1 m thick)', () => {
    const { c, maxY } = runThrough([{ min: [-2, 2.6, -10], max: [2, 3.6, 10] }]);
    expect(c.pos[0]).toBeGreaterThan(3);
    expect(maxY).toBeCloseTo(0, 6);
  });

  it('runs under a TREE CANOPY made of stacked foliage cards (lowest card at 1.7 m, cards every 0.3 m)', () => {
    const cards: Box[] = [];
    for (let y = 1.7; y < 4; y += 0.3) cards.push({ min: [-1.5, y, -1.5], max: [1.5, y + 0.01, 1.5] });
    const { c, maxY } = runThrough(cards);
    expect(c.pos[0]).toBeGreaterThan(3);
    expect(maxY).toBeCloseTo(0, 6);
  });

  it('JUMPING under a low canopy does not land on it (the old 0.8 m probe window did)', () => {
    const cards: Box[] = [];
    for (let y = 1.2; y < 3; y += 0.25) cards.push({ min: [-1.5, y, -1.5], max: [1.5, y + 0.01, 1.5] });
    // Only the upper cards: the lowest is at 1.2 m, above the head ray at a jump apex it may bonk, never stand.
    const { c, maxY } = runThrough(cards.slice(0), { jumpAt: -1.2, ticks: 300 });
    expect(maxY).toBeLessThan(1.0);            // a jump apex (~0.84 m), never on a card
    expect(c.pos[1]).toBeCloseTo(0, 6);        // landed back on the street
    expect(c.grounded).toBe(true);
  });

  it('a BENCH seat (0.48 m, above the step height) blocks instead of popping the player on top', () => {
    const { c, maxY } = runThrough([{ min: [0, 0, -2], max: [0.5, 0.48, 2] }]);
    expect(maxY).toBeCloseTo(0, 6);
    expect(c.pos[0]).toBeLessThan(0);           // stopped short of it (radius)
    expect(c.pos[0]).toBeGreaterThan(-R - 0.05);
  });

  it('still steps UP a curb and a flight of stairs (≤ step height each)', () => {
    const curb: Box = { min: [-2, 0, -5], max: [20, 0.15, 5] };
    const r1 = runThrough([curb]);
    expect(r1.c.pos[1]).toBeCloseTo(0.15, 6);
    expect(r1.c.pos[0]).toBeGreaterThan(3);
    const stairs: Box[] = [];
    for (let i = 0; i < 6; i++) stairs.push({ min: [-3 + i * 0.3, 0, -2], max: [20, 0.18 * (i + 1), 2] });
    const r2 = runThrough(stairs);
    expect(r2.c.pos[1]).toBeCloseTo(1.08, 6);
    expect(r2.c.pos[0]).toBeGreaterThan(3);
  });

  it('a curb UNDER a low awning is stepped onto only when there is headroom', () => {
    const curb: Box = { min: [-2, 0, -5], max: [20, 0.15, 5] };
    const lowBeam: Box = { min: [-2, 1.2, -5], max: [20, 1.3, 5] };   // 1.05 m of room above the curb: no fit
    const cast = boxWorld([FLOOR, curb, lowBeam]);
    expect(sampleStandableGround(cast, 0, 0, 0, STEP, EYE)).toBeCloseTo(0, 6);                       // not the curb top
    expect(sampleStandableGround(boxWorld([FLOOR, curb]), 0, 0, 0, STEP, EYE)).toBeCloseTo(0.15, 6); // headroom → step
  });

  it('spawn placement from high above skips canopy cards (no headroom) and lands on the street', () => {
    const cards: Box[] = [];
    for (let y = 2; y < 5; y += 0.3) cards.push({ min: [-1.5, y, -1.5], max: [1.5, y + 0.01, 1.5] });
    const cast = boxWorld([FLOOR, ...cards]);
    // The TOP card has sky above it (headroom) — spawning from 30 m picks it (a roof is a legit spawn); from just
    // under the canopy top the search walks down through the cards to the street.
    expect(findStandableGround(cast, 0, 0, 4.5, EYE)).toBeCloseTo(0, 6);
  });

  it('a ramp under 45° stays walkable (knee ray grazing it is not a wall)', () => {
    // A 30° ramp approximated by thin steps whose faces report an up-normal: model it as a sloped box stack of 2 cm.
    const ramp: Box[] = [];
    for (let i = 0; i < 60; i++) ramp.push({ min: [i * 0.0346, 0, -2], max: [20, 0.02 * (i + 1), 2] });
    const { c } = runThrough(ramp);
    expect(c.pos[0]).toBeGreaterThan(1.5);
    expect(c.pos[1]).toBeGreaterThan(0.8);
  });
});

describe('wallRayHeights', () => {
  it('knee just over the step, mid body, head — ascending and distinct', () => {
    const h = wallRayHeights(0.4, 1.6);
    expect(h.length).toBe(3);
    expect(h[0]).toBeGreaterThan(0.4);
    expect(h[0]).toBeLessThan(0.5);
    expect(h[1]).toBeCloseTo(0.8, 9);
    expect(h[2]).toBeCloseTo(1.52, 9);
  });
});
