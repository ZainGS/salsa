import { describe, it, expect } from 'vitest';
import { aabbDistanceSq, distanceLodHidden, fovDistanceScale, DISTANCE_LOD_SHOW, orthoLodDistance } from './distance-lod';

describe('distance LOD (R6.1)', () => {
  it('measures to the nearest point of the box (0 inside)', () => {
    expect(aabbDistanceSq(0, 0, 0, -1, -1, -1, 1, 1, 1)).toBe(0);
    expect(aabbDistanceSq(5, 0, 0, -1, -1, -1, 1, 1, 1)).toBeCloseTo(16, 9);
    expect(aabbDistanceSq(4, 5, -4, -1, -1, -1, 1, 1, 1)).toBeCloseTo(9 + 16 + 9, 9);
  });

  it('hides past the draw distance and shows again only inside the hysteresis band', () => {
    const far = 10;
    let hidden = false;
    const step = (d: number) => (hidden = distanceLodHidden(d * d, far, hidden));
    expect(step(9.99)).toBe(false);
    expect(step(10.01)).toBe(true);               // crossed → hidden
    expect(step(9.5)).toBe(true);                 // inside far but outside the show band → stays hidden (no flicker)
    expect(step(far * DISTANCE_LOD_SHOW + 0.01)).toBe(true);
    expect(step(far * DISTANCE_LOD_SHOW - 0.01)).toBe(false);   // well inside → shown
    expect(step(9.9)).toBe(false);                // shown stays shown up to far
    // jitter around the threshold never toggles more than once
    let flips = 0, prev = hidden;
    for (let i = 0; i < 200; i++) { step(10 + Math.sin(i) * 0.4); if (hidden !== prev) flips++; prev = hidden; }
    expect(flips).toBeLessThanOrEqual(1);
  });

  it('scales with the lens: 1 at 45 degrees, shorter for a wide Play camera, clamped', () => {
    expect(fovDistanceScale(Math.PI / 4)).toBeCloseTo(1, 9);
    const wide = fovDistanceScale((75 * Math.PI) / 180);
    expect(wide).toBeLessThan(0.6);
    expect(wide).toBeGreaterThan(0.5);
    expect(fovDistanceScale((20 * Math.PI) / 180)).toBeGreaterThan(2);
    expect(fovDistanceScale(1e-6)).toBeLessThanOrEqual(4);
    expect(fovDistanceScale(3.1)).toBeGreaterThanOrEqual(0.25);
  });
});

describe('ortho screen-size LOD (P1.2)', () => {
  it('maps the ortho half-height to the 45-degree perspective distance with the same view', () => {
    // A 45-degree lens at distance d sees half-height d * tan(22.5 deg); ortho sees orthoSize.
    expect(orthoLodDistance(1) * Math.tan(Math.PI / 8)).toBeCloseTo(1, 9);
    expect(orthoLodDistance(3)).toBeCloseTo(3 * orthoLodDistance(1), 9);
    expect(orthoLodDistance(-1)).toBe(0);
  });
  it('zooming out (bigger orthoSize) hides a chunk the way pulling a perspective camera back does', () => {
    const far = 27.4;
    const d2 = (s: number) => orthoLodDistance(s) ** 2;
    expect(distanceLodHidden(d2(1.2), far, false)).toBe(false);   // 85% zoom on the 2D artboard: detail kept
    expect(distanceLodHidden(d2(20), far, false)).toBe(true);     // far zoomed out: hidden
  });
});
