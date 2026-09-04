import { describe, it, expect } from 'vitest';
import { slideAlongWall, isClimbableStep, expSmooth, clampCameraDistance } from './collision-math';

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
