import { describe, it, expect } from 'vitest';
import { overlayPoseMasked, addPoseMasked, type SkeletonPose } from './skeleton-animator';

// Three-joint poses; every channel distinct so we can see exactly which joint came from where.
const base: SkeletonPose = {
  rotations: [[0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1]],
  positions: [[0, 0, 0], [1, 1, 1], [2, 2, 2]],
  scales:    [[1, 1, 1], [1, 1, 1], [1, 1, 1]],
};
const overlay: SkeletonPose = {
  rotations: [[9, 9, 9, 9], [9, 9, 9, 9], [9, 9, 9, 9]],
  positions: [[9, 9, 9], [9, 9, 9], [9, 9, 9]],
  scales:    [[9, 9, 9], [9, 9, 9], [9, 9, 9]],
};

describe('overlayPoseMasked', () => {
  it('takes overlay for masked joints and base for the rest', () => {
    const out = overlayPoseMasked(base, overlay, [1]);        // only joint 1 masked
    expect(out.positions[0]).toEqual([0, 0, 0]);              // joint 0 = base
    expect(out.positions[1]).toEqual([9, 9, 9]);              // joint 1 = overlay
    expect(out.positions[2]).toEqual([2, 2, 2]);              // joint 2 = base
    expect(out.rotations[1]).toEqual([9, 9, 9, 9]);
    expect(out.scales[1]).toEqual([9, 9, 9]);
  });
  it('does not mutate the base pose and returns fresh arrays', () => {
    const out = overlayPoseMasked(base, overlay, [0]);
    expect(base.positions[0]).toEqual([0, 0, 0]);             // base untouched
    expect(out.positions[0]).not.toBe(base.positions[0]);     // fresh copy
    out.positions[1][0] = 42;
    expect(base.positions[1][0]).toBe(1);                     // no aliasing back into base
  });
  it('ignores out-of-range mask indices', () => {
    const out = overlayPoseMasked(base, overlay, [99, -1, 2]);
    expect(out.positions[2]).toEqual([9, 9, 9]);              // valid index applied
    expect(out.positions.length).toBe(3);                    // no phantom joints
  });
  it('empty mask returns a base-equal pose', () => {
    const out = overlayPoseMasked(base, overlay, []);
    expect(out.positions).toEqual(base.positions);
    expect(out.rotations).toEqual(base.rotations);
  });
});

describe('addPoseMasked (additive layering)', () => {
  const I: [number, number, number, number] = [0, 0, 0, 1];
  // base joint 1 at pos (1,1,1); an additive clip whose motion is +2 on X relative to its reference.
  const mkBase = (): SkeletonPose => ({
    rotations: [I, I], positions: [[0, 0, 0], [1, 1, 1]], scales: [[1, 1, 1], [1, 1, 1]],
  });
  const add: SkeletonPose = { rotations: [I, I], positions: [[0, 0, 0], [3, 0, 0]], scales: [[1, 1, 1], [1, 1, 1]] };
  const ref: SkeletonPose = { rotations: [I, I], positions: [[0, 0, 0], [1, 0, 0]], scales: [[1, 1, 1], [1, 1, 1]] };

  it('adds weight·(add−ref) to masked joint positions', () => {
    const full = addPoseMasked(mkBase(), add, ref, 1, [1]);      // delta = (3,0,0)-(1,0,0) = (2,0,0)
    expect(full.positions[1]).toEqual([3, 1, 1]);                // 1 + 2
    const half = addPoseMasked(mkBase(), add, ref, 0.5, [1]);
    expect(half.positions[1]).toEqual([2, 1, 1]);               // 1 + 0.5·2
  });
  it('weight 0 is a no-op (delta scaled away)', () => {
    const out = addPoseMasked(mkBase(), add, ref, 0, [1]);
    expect(out.positions[1]).toEqual([1, 1, 1]);
  });
  it('add===ref means no motion even at full weight', () => {
    const out = addPoseMasked(mkBase(), ref, ref, 1, [1]);
    expect(out.positions[1]).toEqual([1, 1, 1]);
  });
  it('leaves unmasked joints untouched', () => {
    const out = addPoseMasked(mkBase(), add, ref, 1, [1]);
    expect(out.positions[0]).toEqual([0, 0, 0]);                // joint 0 not in mask
  });
  it('applies a rotation delta in the base frame (base identity → gets the ref→add turn)', () => {
    const qZ90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];   // 90° about Z
    const addR: SkeletonPose = { rotations: [I, qZ90], positions: [[0, 0, 0], [0, 0, 0]], scales: [[1, 1, 1], [1, 1, 1]] };
    const refR: SkeletonPose = { rotations: [I, I], positions: [[0, 0, 0], [0, 0, 0]], scales: [[1, 1, 1], [1, 1, 1]] };
    const out = addPoseMasked(mkBase(), addR, refR, 1, [1]);
    for (let k = 0; k < 4; k++) expect(out.rotations[1][k]).toBeCloseTo(qZ90[k], 5);
  });
});
