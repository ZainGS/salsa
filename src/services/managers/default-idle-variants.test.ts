import { describe, it, expect } from 'vitest';
import { buildIdleVariantClips, IDLE_VARIANT_CLIP } from './default-idle-variants';
import { buildLocomotionClips } from './default-locomotion';
import { webcrypto } from 'node:crypto';
import { sampleClipPose } from '../../renderer/3d/skeleton-animator';
import type { SkeletonPose } from '../../renderer/3d/skeleton-animator';

(globalThis as { crypto?: unknown }).crypto ??= webcrypto;
type V3 = [number, number, number];
// The procedural rig (body-generator JOINTS), as default-locomotion.test.ts uses it.
const joints = [
    { name: 'hips', localPosition: [0, 0.9, 0] as V3 },
    { name: 'upperleg_L', localPosition: [0.045, -0.14, 0] as V3 }, { name: 'lowerleg_L', localPosition: [0, -0.42, 0] as V3 }, { name: 'foot_L', localPosition: [0, -0.42, 0] as V3 },
    { name: 'upperleg_R', localPosition: [-0.045, -0.14, 0] as V3 }, { name: 'lowerleg_R', localPosition: [0, -0.42, 0] as V3 }, { name: 'foot_R', localPosition: [0, -0.42, 0] as V3 },
    { name: 'lowerback', localPosition: [0, 0.035, 0] as V3 }, { name: 'spine', localPosition: [0, 0.085, 0] as V3 },
    { name: 'chest', localPosition: [0, 0.18, 0] as V3 }, { name: 'neck', localPosition: [0, 0.16, 0] as V3 }, { name: 'head', localPosition: [0, 0.1, 0] as V3 },
    { name: 'clavicle_L', localPosition: [0.03, 0.06, 0] as V3 }, { name: 'shoulder_L', localPosition: [0.045, 0.015, 0] as V3 }, { name: 'lowerarm_L', localPosition: [0.27, 0, 0] as V3 }, { name: 'hand_L', localPosition: [0.23, 0, 0] as V3 },
    { name: 'clavicle_R', localPosition: [-0.03, 0.06, 0] as V3 }, { name: 'shoulder_R', localPosition: [-0.045, 0.015, 0] as V3 }, { name: 'lowerarm_R', localPosition: [-0.27, 0, 0] as V3 }, { name: 'hand_R', localPosition: [-0.23, 0, 0] as V3 },
];
const rest = (): SkeletonPose => ({
    rotations: joints.map(() => [0, 0, 0, 1] as [number, number, number, number]),
    positions: joints.map((j) => [j.localPosition[0], j.localPosition[1], j.localPosition[2]] as [number, number, number]),
    scales: joints.map(() => [1, 1, 1] as [number, number, number]),
});
const qd = (a: readonly number[], b: readonly number[]) => 1 - Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);

describe('default idle variants (2026-10-04)', () => {
    it('builds Look Around / Stretch / Check Wrist / Foot Tap; Adjust Glasses only for a glasses wearer', () => {
        const names = buildIdleVariantClips(joints).map((c) => c.name);
        expect(names).toEqual([IDLE_VARIANT_CLIP.lookAround, IDLE_VARIANT_CLIP.stretch, IDLE_VARIANT_CLIP.checkWrist, IDLE_VARIANT_CLIP.footTap]);
        expect(buildIdleVariantClips(joints, { glasses: true }).map((c) => c.name)).toContain(IDLE_VARIANT_CLIP.glasses);
        expect(buildIdleVariantClips([{ name: 'root' }, { name: 'tail' }])).toEqual([]);   // non-humanoid
    });

    it('every variant starts and ends in the neutral Stand pose (clean crossfades) and is a one-shot of 2.5–5 s', () => {
        const stand = buildLocomotionClips(joints).find((c) => c.name === 'Stand')!;
        for (const c of buildIdleVariantClips(joints, { glasses: true })) {
            const secs = (c.endFrame - c.startFrame) / c.fps;
            expect(secs).toBeGreaterThan(2.5); expect(secs).toBeLessThan(5);
            const a = sampleClipPose(c, rest(), c.startFrame), b = sampleClipPose(c, rest(), c.endFrame);
            for (let j = 0; j < joints.length; j++) expect(qd(a.rotations[j], b.rotations[j]), `${c.name} ${joints[j].name}`).toBeLessThan(1e-6);
            // The arms at the ends are the Stand idle's own relaxed arms (same IK legs, same stance).
            const s0 = sampleClipPose(stand, rest(), 0);
            for (const jn of ['shoulder_L', 'shoulder_R', 'lowerarm_L', 'lowerarm_R']) {
                const j = joints.findIndex((x) => x.name === jn);
                expect(qd(a.rotations[j], s0.rotations[j]), `${c.name} ${jn}`).toBeLessThan(2e-3);
            }
        }
    });

    it('arm clearance raises the arms (a broad body / bulky top), as for the Stand idle', () => {
        const j = joints.findIndex((x) => x.name === 'shoulder_L');
        const a = buildIdleVariantClips(joints)[0], b = buildIdleVariantClips(joints, { armClearance: 12 })[0];
        expect(qd(sampleClipPose(a, rest(), 0).rotations[j], sampleClipPose(b, rest(), 0).rotations[j])).toBeGreaterThan(1e-3);
    });

    it('carries face events (gaze / blink / face-kit expression) inside the clip', () => {
        for (const c of buildIdleVariantClips(joints, { glasses: true })) {
            expect(c.faceTrack?.length, c.name).toBeGreaterThan(0);
            for (const e of c.faceTrack!) { expect(e.frame).toBeGreaterThanOrEqual(c.startFrame); expect(e.frame).toBeLessThanOrEqual(c.endFrame); }
        }
        expect(buildIdleVariantClips(joints).find((c) => c.name === IDLE_VARIANT_CLIP.stretch)!.faceTrack!.some((e) => e.expression === 'open')).toBe(true);
    });
});
