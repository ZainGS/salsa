import { describe, it, expect } from 'vitest';
import { solveSpringBones } from './spring-bone-solver';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { Joint3D, SpringChain } from '../../types/armature-3d';

// Node.toJSON reaches for browser crypto — polyfill for the Node test env (mirrors scene3d-animation.test.ts).
const g = globalThis as unknown as { self?: { crypto?: { randomUUID?: () => string } } };
g.self ??= g as never;
let uuidN = 0;
(g.self.crypto ??= {} as never).randomUUID ??= () => `test-uuid-${uuidN++}`;

function joint(index: number, parentIndex = -1): Joint3D {
    return {
        index, name: `j${index}`, parentIndex, children: [],
        localPosition: [0, index * 0.5, 0], localRotation: [0, 0, 0, 1], localScale: [1, 1, 1],
        tailOffset: [0, 0.3, 0], worldMatrix: new Float32Array(16), inverseBindMatrix: new Float32Array(16),
    };
}
const chain = (jointIndices: number[]): SpringChain => ({
    id: 'c', jointIndices, stiffness: 0.5, drag: 0.5, gravity: 0, gravityDir: [0, -1, 0], hitRadius: 0, enabled: true,
});
const allFinite = (a: Float32Array): boolean => Array.from(a).every(Number.isFinite);

describe('spring-bone-solver — finite guards', () => {
    it('does NOT launder a non-finite upstream (parent) matrix into skinMatrices', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0)], clips: [], springChains: [chain([1])] });
        expect(allFinite(skel.skinMatrices)).toBe(true);               // clean after construction
        // Corrupt the anchor's world matrix — simulates a diverged FK/IK/constraint pass upstream.
        skel.data.joints[0].worldMatrix = new Float32Array(16).fill(NaN);
        solveSpringBones(skel, 1 / 60);
        // The guard skips the joint instead of writing a NaN skin matrix that would explode the skin into spikes.
        expect(allFinite(skel.skinMatrices)).toBe(true);
    });

    it('solves a finite skeleton without producing NaNs (sanity)', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0)], clips: [], springChains: [chain([1])] });
        for (let i = 0; i < 5; i++) solveSpringBones(skel, 1 / 60);
        expect(allFinite(skel.skinMatrices)).toBe(true);
    });

    it('re-seeds and stays finite even after a huge dt (stale-clock divergence attempt)', () => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0)], clips: [], springChains: [chain([1])] });
        solveSpringBones(skel, 100);   // giant dt — the internal step clamp + guards must keep it finite
        expect(allFinite(skel.skinMatrices)).toBe(true);
    });
});

describe('spring-bone-solver — scaled characters (Round 4: the Play auto player shrunk to city size)', () => {
    // Joint 2 is a spring chain's second bone: its head comes from joint 1's SOLVED world matrix, so a scale lost there
    // would show up as a full-size tail on a shrunk body.
    const build = (scale: number) => {
        const skel = new Skeleton3D({ name: 'S', joints: [joint(0), joint(1, 0), joint(2, 1)], clips: [], springChains: [{ ...chain([1, 2]), gravity: 0.02, gravityDir: [1, -1, 0] }] });
        if (scale !== 1) {
            skel.objectTransform.set([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]);
            skel.computeWorldMatrices();
        }
        return skel;
    };
    const tipOf = (skel: Skeleton3D, j: number) => {
        const m = skel.data.joints[j].worldMatrix;
        return [m[12], m[13], m[14]];
    };
    it('a uniformly scaled rig swings EXACTLY like the unscaled one, scaled (bone length, gravity, joint scale)', () => {
        const a = build(1), b = build(1 / 15);
        for (let i = 0; i < 40; i++) { solveSpringBones(a, 1 / 60); solveSpringBones(b, 1 / 60); }
        for (const j of [1, 2]) {
            const pa = tipOf(a, j), pb = tipOf(b, j);
            for (let k = 0; k < 3; k++) expect(pb[k]).toBeCloseTo(pa[k] / 15, 5);
        }
        // The solved spring joint keeps the character's scale (its X basis length = 1/15, not 1).
        const m = b.data.joints[1].worldMatrix;
        expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(1 / 15, 5);
        expect(allFinite(b.skinMatrices)).toBe(true);
    });
});
