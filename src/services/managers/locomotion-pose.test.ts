import { describe, it, expect } from 'vitest';
import { composeLocomotionPose } from './locomotion-pose';
import { SkirtFollow } from './skirt-steer';
import type { SkeletonPose } from '../../renderer/3d/skeleton-animator';
import type { SkeletonAnimClip } from '../../types/armature-3d';

const qz = (d: number): [number, number, number, number] => { const h = (d * Math.PI) / 360; return [0, 0, Math.sin(h), Math.cos(h)]; };
const rest: SkeletonPose = { rotations: [qz(30)], positions: [[0, 1, 0]], scales: [[1, 1, 1]] };
const clip = (keys: [number, number, number, number][]): SkeletonAnimClip => ({
    id: 'c', name: 'Add', startFrame: 0, endFrame: keys.length - 1, fps: 30,
    tracks: [{ jointIndex: 0, channel: 'rotation', keyframes: keys.map((q, frame) => ({ frame, value: q })) }],
});

describe('composeLocomotionPose (item 13)', () => {
    it('an ADDITIVE layer is a delta from its own first frame: a track authored at identity does not undo the rest pose', () => {
        const land = clip([qz(0), qz(10), qz(0)]);   // Land-style: identity at both ends
        const at0 = composeLocomotionPose([{ clip: 'Add', phase: 0, weight: 1, additive: true }], () => land, rest);
        expect(at0.rotations[0][2]).toBeCloseTo(qz(30)[2], 6);            // was: snapped back to identity (the arms' T)
        const mid = composeLocomotionPose([{ clip: 'Add', phase: 0.5, weight: 1, additive: true }], () => land, rest);
        expect(mid.rotations[0][2]).toBeCloseTo(qz(40)[2], 5);            // rest + the clip's 10 deg delta
    });
    it('no layers: a copy of rest', () => {
        const p = composeLocomotionPose([], () => null, rest);
        expect(p.rotations[0]).toEqual(rest.rotations[0]);
        expect(p.rotations[0]).not.toBe(rest.rotations[0]);
    });
});

describe('SkirtFollow (item 13)', () => {
    it('lags a stepped signal, overshoots a little, settles, and snaps on the first update / after a long gap', () => {
        const f = new SkirtFollow();
        expect(f.update(0.4, 1 / 60)).toBe(0.4);                          // first update snaps
        let v = 0;
        for (let i = 0; i < 3; i++) v = f.update(-0.6, 1 / 60);
        expect(v).toBeGreaterThan(-0.6);                                  // still on its way (lag)
        let peak = v;
        for (let i = 0; i < 60; i++) peak = Math.min(peak, f.update(-0.6, 1 / 60));
        expect(peak).toBeLessThan(-0.6);                                  // a small overshoot
        expect(peak).toBeGreaterThan(-0.9);
        for (let i = 0; i < 240; i++) f.update(-0.6, 1 / 60);
        expect(f.settled(-0.6)).toBe(true);
        expect(f.update(1, 0.5)).toBe(1);                                 // a > 0.25 s gap snaps
        expect(Math.abs(f.update(5, 1 / 60))).toBeLessThanOrEqual(1);     // clamped to the steer range
    });
});
