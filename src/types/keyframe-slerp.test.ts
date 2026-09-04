import { describe, it, expect } from 'vitest';
import { interpolateEulerSlerp, interpolateVec3, type Vec3Value } from './keyframe-3d';

// Round a vec3 of radians, normalizing -0 → 0 so toEqual is stable.
const r = (v: Vec3Value): Vec3Value => v.map(n => +n.toFixed(6) + 0) as Vec3Value;
const HALF_PI = Math.PI / 2;

describe('interpolateEulerSlerp — endpoints & midpoint', () => {
  it('returns the exact endpoints at t=0 and t=1', () => {
    const a: Vec3Value = [0.3, -0.7, 1.1], b: Vec3Value = [-0.5, 1.2, 0.2];
    expect(r(interpolateEulerSlerp(a, b, 0, 'linear'))).toEqual(r(a));
    expect(r(interpolateEulerSlerp(a, b, 1, 'linear'))).toEqual(r(b));
  });

  it('a pure-yaw pan slerps to the exact half angle (matches euler-lerp for one axis)', () => {
    const a: Vec3Value = [0, 0, 0], b: Vec3Value = [0, HALF_PI, 0];
    const mid = interpolateEulerSlerp(a, b, 0.5, 'linear');
    expect(+mid[1].toFixed(5)).toBe(+(HALF_PI / 2).toFixed(5));   // 45°
    expect(+mid[0].toFixed(6) + 0).toBe(0);
    expect(+mid[2].toFixed(6) + 0).toBe(0);
  });

  it('step easing holds the start value', () => {
    const a: Vec3Value = [0.1, 0.2, 0.3], b: Vec3Value = [1, 1, 1];
    expect(r(interpolateEulerSlerp(a, b, 0.5, 'step'))).toEqual(r(a));
  });
});

describe('interpolateEulerSlerp — takes the SHORT way around', () => {
  it('interpolating 170° → -170° yaw passes through 180°, not through 0°', () => {
    const a: Vec3Value = [0, (170 * Math.PI) / 180, 0];
    const b: Vec3Value = [0, (-170 * Math.PI) / 180, 0];
    const midSlerp = interpolateEulerSlerp(a, b, 0.5, 'linear');
    // Reconstruct the yaw magnitude; slerp should land near ±180° (|yaw| ≈ π), NOT near 0.
    expect(Math.abs(midSlerp[1])).toBeGreaterThan((179 * Math.PI) / 180);
    // Euler-lerp instead collapses to ~0° — the wobble this fix avoids.
    const midLerp = interpolateVec3(a, b, 0.5, 'linear');
    expect(Math.abs(midLerp[1])).toBeLessThan((1 * Math.PI) / 180);
  });
});
