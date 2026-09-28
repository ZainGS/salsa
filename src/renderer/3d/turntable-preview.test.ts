import { describe, it, expect } from 'vitest';
import { planTurntable, boundsCenterRadius, orbitCameraPose } from './turntable-preview';

describe('planTurntable', () => {
  it('sweeps the clip once and yaw over `turns` revolutions across the steps', () => {
    const steps = planTurntable({ frames: 4, clipStartFrame: 0, clipEndFrame: 40, turns: 1 });
    expect(steps.length).toBe(4);
    expect(steps.map(s => s.frame)).toEqual([0, 10, 20, 30]);              // t = 0,.25,.5,.75 (last ≠ first → loops)
    expect(steps.map(s => s.yaw)).toEqual([0, Math.PI / 2, Math.PI, Math.PI * 1.5]);
  });
  it('honors multiple turns', () => {
    const steps = planTurntable({ frames: 2, clipStartFrame: 0, clipEndFrame: 10, turns: 2 });
    expect(steps.map(s => s.yaw)).toEqual([0, Math.PI * 2]);               // 2 revolutions over 2 steps
  });
  it('a single-frame clip rotates a static pose; frames clamped to >= 1', () => {
    const steps = planTurntable({ frames: 3, clipStartFrame: 7, clipEndFrame: 7 });
    expect(steps.every(s => s.frame === 7)).toBe(true);
    expect(planTurntable({ frames: 0, clipStartFrame: 0, clipEndFrame: 1 }).length).toBe(1);
  });
});

describe('boundsCenterRadius', () => {
  it('center is the AABB midpoint; radius reaches the farthest point', () => {
    const { center, radius } = boundsCenterRadius([[-1, 0, 0], [1, 0, 0], [0, 2, 0]]);
    expect(center).toEqual([0, 1, 0]);
    expect(radius).toBeCloseTo(Math.hypot(1, 1, 0), 5);                    // farthest of the three from (0,1,0)
  });
  it('empty input degrades to origin + unit radius (no divide-by-zero)', () => {
    expect(boundsCenterRadius([])).toEqual({ center: [0, 0, 0], radius: 1 });
  });
});

describe('orbitCameraPose', () => {
  it('targets the center and pulls back to fit the sphere in the FOV', () => {
    const fovY = Math.PI / 3;                                             // 60°
    const { position, target } = orbitCameraPose([0, 0, 0], 1, 0, 0, fovY, 1);
    expect(target).toEqual([0, 0, 0]);
    const dist = 1 / Math.sin(fovY / 2);                                  // exact fit at margin 1
    expect(position[2]).toBeCloseTo(dist, 5);                             // yaw 0, pitch 0 → straight down +Z
    expect(position[0]).toBeCloseTo(0, 5); expect(position[1]).toBeCloseTo(0, 5);
  });
  it('yaw orbits horizontally; margin pushes the camera farther', () => {
    const fovY = Math.PI / 3;
    const a = orbitCameraPose([0, 0, 0], 1, Math.PI / 2, 0, fovY, 1);     // quarter turn → on +X axis
    expect(a.position[0]).toBeCloseTo(1 / Math.sin(fovY / 2), 4);
    expect(a.position[2]).toBeCloseTo(0, 4);
    const near = orbitCameraPose([0, 0, 0], 1, 0, 0, fovY, 1);
    const far = orbitCameraPose([0, 0, 0], 1, 0, 0, fovY, 2);
    expect(Math.abs(far.position[2])).toBeGreaterThan(Math.abs(near.position[2]));
  });
  it('offsets from a non-origin center', () => {
    const { position, target } = orbitCameraPose([5, 1, -2], 2, 0, 0, Math.PI / 3, 1.3);
    expect(target).toEqual([5, 1, -2]);
    expect(position[0]).toBeCloseTo(5, 5);                               // yaw 0 keeps x at center
  });
});
