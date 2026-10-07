/**
 * fk-pass-count.test.ts — mobile-parity §7.3d: "IK computes world matrices up to 3× per frame".
 *
 * The per-frame skeleton solves (armature IK + constraints, the procedural idle's squash + foot IK, idle breaks) used to
 * run several FULL computeWorldMatrices() passes a frame. They now run ONE full pass and re-derive only the subtrees a
 * solver changed (Skeleton3D.recomputeSubtrees). These tests pin:
 *   • the final pose is BIT-IDENTICAL to the old pipeline (world matrices, skin matrices, ik/constraint state), frame
 *     after frame (so stale per-frame state carried between frames is covered too);
 *   • the full / partial pass counts per frame, before vs after;
 *   • poseVersion still bumps on every frame that changes the pose, and an empty partial recompute does not bump it.
 */
import { describe, it, expect, vi } from 'vitest';
import { mat4, quat } from 'gl-matrix';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { IKChain, Joint3D, JointConstraint } from '../../types/armature-3d';
import { solveAllIKChains } from './ik-solver';
import { solveAllConstraints, solveIKAndConstraints } from './constraint-solver';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { Scene3DAnimation, type Scene3DAnimationHost } from '../../services/managers/scene3d-animation';
import type { ManagerContext } from '../../services/managers/manager-context';

// Node.toJSON / Skeleton3D ids reach for the browser crypto.randomUUID — polyfill for the Node test env.
const g = globalThis as unknown as { self?: { crypto?: { randomUUID?: () => string } } };
g.self ??= g as never;
let uuidN = 0;
(g.self.crypto ??= {} as never).randomUUID ??= () => `fk-uuid-${uuidN++}`;
const rafG = globalThis as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number };
rafG.requestAnimationFrame ??= () => 0;

// ── A small humanoid (parent-first), with a slight bend at elbows/knees so IK has a plane to work in ──────────────
const SPEC: [name: string, parent: number, pos: [number, number, number], rotZ?: number][] = [
    ['hips', -1, [0, 1, 0]],
    ['lowerback', 0, [0, 0.1, 0]],
    ['spine', 1, [0, 0.15, 0]],
    ['chest', 2, [0, 0.15, 0]],
    ['neck', 3, [0, 0.2, 0]],
    ['head', 4, [0, 0.1, 0.01]],
    ['clavicle_L', 3, [0.05, 0.15, 0]],
    ['shoulder_L', 6, [0.12, 0, 0]],
    ['lowerarm_L', 7, [0.25, 0, 0], 0.2],
    ['hand_L', 8, [0.22, 0, 0.02]],
    ['clavicle_R', 3, [-0.05, 0.15, 0]],
    ['shoulder_R', 10, [-0.12, 0, 0]],
    ['lowerarm_R', 11, [-0.25, 0, 0], -0.2],
    ['hand_R', 12, [-0.22, 0, 0.02]],
    ['upperleg_L', 0, [0.1, -0.05, 0]],
    ['lowerleg_L', 14, [0, -0.42, 0.01], 0.05],
    ['foot_L', 15, [0, -0.4, -0.02]],
    ['toe_L', 16, [0, -0.05, 0.1]],
    ['upperleg_R', 0, [-0.1, -0.05, 0]],
    ['lowerleg_R', 18, [0, -0.42, 0.01], -0.05],
    ['foot_R', 19, [0, -0.4, -0.02]],
    ['toe_R', 20, [0, -0.05, 0.1]],
    ['eyeTarget', 5, [0, 0.05, 0.3]],
];
const IDX = new Map(SPEC.map(([n], i) => [n, i]));
const ix = (n: string): number => IDX.get(n)!;

function makeSkeleton(opts: { transform?: boolean } = {}): Skeleton3D {
    const joints: Joint3D[] = SPEC.map(([name, parentIndex, pos, rz], index) => {
        const q = quat.setAxisAngle(quat.create(), [0, 0, 1], rz ?? 0);
        return {
            index, name, parentIndex, children: [],
            localPosition: [...pos] as [number, number, number], localRotation: [q[0], q[1], q[2], q[3]], localScale: [1, 1, 1],
            tailOffset: [0, 0.1, 0], worldMatrix: new Float32Array(16), inverseBindMatrix: new Float32Array(16),
        };
    });
    for (const j of joints) if (j.parentIndex >= 0) joints[j.parentIndex].children.push(j.index);
    const skel = new Skeleton3D({ name: 'fk', joints, clips: [] });
    skel.computeInverseBindMatrices();
    if (opts.transform) {   // a moved / turned / scaled character (the root path through objectTransform)
        const m = mat4.create();
        mat4.fromRotationTranslationScale(m, quat.setAxisAngle(quat.create(), [0, 1, 0], 0.7), [2, 0.3, -1], [1.3, 1.3, 1.3]);
        skel.objectTransform.set(m);
    }
    skel.computeWorldMatrices();
    return skel;
}

/** Exact bit pattern of a float array (so -0 vs 0 or a last-ulp difference fails). */
function bits(a: ArrayLike<number> | undefined): number[] | undefined {
    if (!a) return undefined;
    const f = Float32Array.from(a as ArrayLike<number>);
    return Array.from(new Uint32Array(f.buffer));
}
/** Everything a frame's solve leaves behind that the renderer / next frame reads. */
function snapshot(s: Skeleton3D) {
    return {
        skin: bits(s.skinMatrices),
        joints: s.data.joints.map(j => ({
            w: bits(j.worldMatrix), ik: j.ikRotation ? [...j.ikRotation] : null,
            cr: j.constraintRotation ? [...j.constraintRotation] : null, cs: j.constraintScale ? [...j.constraintScale] : null,
            lr: [...j.localRotation], ls: [...j.localScale],
        })),
    };
}

/** Count full FK passes + partial recomputes on one skeleton (and how many joints the partials touched). */
function counter(s: Skeleton3D) {
    const full = vi.spyOn(s, 'computeWorldMatrices');
    const orig = s.recomputeSubtrees;   // the instance's own (the old-pipeline emulation overrides it)
    const part = vi.spyOn(s, 'recomputeSubtrees');
    let joints = 0;
    part.mockImplementation(function (this: Skeleton3D, roots: ArrayLike<number>) { const n = orig.call(this, roots); joints += n; return n; });
    return {
        take() { const r = { full: full.mock.calls.length, partial: part.mock.calls.length, partialJoints: joints }; full.mockClear(); part.mockClear(); joints = 0; return r; },
    };
}

describe('Skeleton3D.recomputeSubtrees — partial FK', () => {
    it('is bit-identical to a full pass after changing a few joints, and only touches their subtrees', () => {
        const a = makeSkeleton({ transform: true }), b = makeSkeleton({ transform: true });
        for (const s of [a, b]) {
            const q = quat.setAxisAngle(quat.create(), [1, 0.3, 0], 0.4);
            s.data.joints[ix('lowerarm_R')].ikRotation = [q[0], q[1], q[2], q[3]];
            s.data.joints[ix('lowerleg_L')].constraintScale = [1, 1.2, 1];
            s.data.joints[ix('shoulder_L')].localRotation = [0, 0, 0.2, Math.sqrt(1 - 0.04)];
        }
        a.computeWorldMatrices();
        const v0 = b.poseVersion;
        const n = b.recomputeSubtrees([ix('lowerarm_R'), ix('lowerleg_L'), ix('shoulder_L')]);
        expect(snapshot(b)).toEqual(snapshot(a));
        expect(n).toBe(2 + 3 + 3);                       // lowerarm_R+hand_R, lowerleg_L+foot_L+toe_L, shoulder_L+lowerarm_L+hand_L
        expect(b.poseVersion).toBe(v0 + 1);              // a changed pose still bumps poseVersion (mesh-picker key)
        expect(b.matricesDirty).toBe(true);
    });

    it('an empty / out-of-range root list is a no-op (no poseVersion bump → a held pose keeps the picker cache)', () => {
        const s = makeSkeleton();
        s.matricesDirty = false;
        const v0 = s.poseVersion;
        expect(s.recomputeSubtrees([])).toBe(0);
        expect(s.recomputeSubtrees([-1, 999])).toBe(0);
        expect(s.poseVersion).toBe(v0);
        expect(s.matricesDirty).toBe(false);
    });

    it('a non-parent-first rig falls back to the full pass (whose result depends on the previous state)', () => {
        // child (index 0) stored BEFORE its parent (index 1)
        const mk = (): Skeleton3D => new Skeleton3D({ name: 'np', clips: [], joints: [
            { index: 0, name: 'c', parentIndex: 1, children: [], localPosition: [0, 1, 0], localRotation: [0, 0, 0, 1], localScale: [1, 1, 1], tailOffset: [0, 0.1, 0], worldMatrix: new Float32Array(16), inverseBindMatrix: new Float32Array(16) },
            { index: 1, name: 'p', parentIndex: -1, children: [0], localPosition: [0, 2, 0], localRotation: [0, 0, 0, 1], localScale: [1, 1, 1], tailOffset: [0, 0.1, 0], worldMatrix: new Float32Array(16), inverseBindMatrix: new Float32Array(16) },
        ] });
        const a = mk(), b = mk();
        expect(b.isParentFirst()).toBe(false);
        for (const s of [a, b]) s.data.joints[1].localPosition = [0, 3, 0];
        a.computeWorldMatrices();
        expect(b.recomputeSubtrees([1])).toBe(2);
        expect(snapshot(b)).toEqual(snapshot(a));
        expect(makeSkeleton().isParentFirst()).toBe(true);
    });
});

// ── The armature per-frame solve (scene3d-armature's 'ik+constraints' pre-render callback) ────────────────────────
function rigSolvers(s: Skeleton3D, withIK: boolean, withC: boolean): void {
    const chains: IKChain[] = [
        { id: 'armL', endJointIdx: ix('hand_L'), chainLength: 3, target: [0.4, 1.3, 0.2], blendWeight: 1, enabled: true },
        { id: 'armR', endJointIdx: ix('hand_R'), chainLength: 3, target: [-0.4, 1.2, 0.25], poleTarget: [-0.3, 1.4, -0.5], blendWeight: 0.6, enabled: true },
        { id: 'legL', endJointIdx: ix('foot_L'), chainLength: 2, target: [0.12, 0.2, 0.15], blendWeight: 1, enabled: true },
        { id: 'off', endJointIdx: ix('foot_R'), chainLength: 2, target: [0, 0, 0], blendWeight: 1, enabled: false },
    ];
    s.data.ikChains = withIK ? chains : [];
    if (!withC) return;
    const add = (n: string, c: JointConstraint) => { const j = s.data.joints[ix(n)]; (j.constraints ??= []).push(c); };
    add('neck', { type: 'limitRotation', minX: -10, maxX: 10, minY: -10, maxY: 10, minZ: -5, maxZ: 5, influence: 1 });
    add('head', { type: 'lookAt', targetJointIdx: ix('hand_R'), axis: 'z', influence: 0.7 });          // target inside an IK subtree
    add('clavicle_L', { type: 'stretchTo', targetJointIdx: ix('hand_L'), influence: 0.8, volumePreserve: 0.5 });
    add('hand_L', { type: 'copyRotation', sourceJointIdx: ix('lowerarm_R'), influence: 0.5 });          // constrained descendant of a constrained joint
    add('hand_L', { type: 'limitRotation', minZ: -20, maxZ: 20, influence: 1 });                       // 2 constraints on one joint
}
/** The OLD callback body, verbatim (3 full passes with IK + constraints). */
function oldArmatureSolve(s: Skeleton3D, hasIK: boolean, hasC: boolean): void {
    s.computeWorldMatrices();
    if (hasIK) solveAllIKChains(s);
    if (hasC) { s.computeWorldMatrices(); solveAllConstraints(s); }
    s.computeWorldMatrices();
    s.matricesDirty = true;
}
/** Per-frame inputs that move (an IK drag + a clip writing the spine). */
function driveFrame(s: Skeleton3D, f: number): void {
    const ch = s.data.ikChains ?? [];
    for (const c of ch) { c.target = [c.target[0] + Math.sin(f * 0.7) * 0.03, c.target[1] + Math.cos(f * 0.4) * 0.02, c.target[2]]; }
    const q = quat.setAxisAngle(quat.create(), [0, 1, 0], Math.sin(f * 0.3) * 0.25);
    s.data.joints[ix('spine')].localRotation = [q[0], q[1], q[2], q[3]];
}

describe('solveIKAndConstraints — ONE full FK pass, bit-identical to the old 3-pass callback', () => {
    const cases: { name: string; ik: boolean; c: boolean; oldFull: number; newPartialCalls: number }[] = [
        { name: 'IK + constraints', ik: true, c: true, oldFull: 3, newPartialCalls: 2 },
        { name: 'IK only (IK drag)', ik: true, c: false, oldFull: 2, newPartialCalls: 1 },
        { name: 'constraints only', ik: false, c: true, oldFull: 3, newPartialCalls: 2 },
    ];
    for (const k of cases) {
        it(`${k.name}: same final matrices every frame; full passes ${k.oldFull} → 1`, () => {
            const oldS = makeSkeleton({ transform: true }), newS = makeSkeleton({ transform: true });
            rigSolvers(oldS, k.ik, k.c); rigSolvers(newS, k.ik, k.c);
            const co = counter(oldS), cn = counter(newS);
            const scratch: number[] = [];
            for (let f = 0; f < 12; f++) {
                driveFrame(oldS, f); driveFrame(newS, f);
                const v0 = newS.poseVersion;
                oldArmatureSolve(oldS, k.ik, k.c);
                solveIKAndConstraints(newS, k.ik, k.c, scratch);
                expect(snapshot(newS), `frame ${f}`).toEqual(snapshot(oldS));
                expect(newS.poseVersion).toBeGreaterThan(v0);   // a solved frame still bumps the pose version
                const o = co.take(), n = cn.take();
                expect(o).toEqual({ full: k.oldFull, partial: 0, partialJoints: 0 });
                expect(n.full).toBe(1);
                expect(n.partial).toBe(k.newPartialCalls);
                expect(n.partialJoints).toBeLessThan(newS.data.joints.length * (k.oldFull - 1));   // strictly less FK work
            }
            // sanity: the solvers really moved things (otherwise "identical" would be vacuous)
            if (k.ik) expect(newS.data.joints[ix('lowerarm_R')].ikRotation).toBeTruthy();
            if (k.c) expect(newS.data.joints[ix('head')].constraintRotation).toBeTruthy();
        });
    }
});

// ── The procedural idle (Scene3DAnimation's 'idle' pre-render callback): squash + foot IK + an idle break ─────────
function idleEnv(skel: Skeleton3D) {
    const body = Object.create(SkinnedMesh3D.prototype) as SkinnedMesh3D;
    Object.defineProperty(body, 'id', { value: 'body' });
    Object.assign(body, { skeleton: skel, skeletonId: skel.id, isProceduralBody: true });
    const cbs: (() => boolean)[] = [];
    const ctx = {
        scheduleRender: () => {}, emitSceneGraphChanged: () => {}, sceneGraph: { root: { children: [skel] } },
        webgpuRenderer: { addPreRenderCallback: (cb: () => boolean) => { if (!cbs.includes(cb)) cbs.push(cb); } },
        interactionService: { beginInteractive: () => {}, endInteractive: () => {} },
    } as unknown as ManagerContext;
    const host: Scene3DAnimationHost = {
        getSkeleton: (id) => (id === skel.id ? skel : null), keepSpringsAlive: () => {}, applyAllKeyframesAtFrame: () => {},
        getMesh: (id) => (id === 'body' ? body : null), getAllMeshes: () => [body], getBodyParams: () => null,
        getBoneOverlaySkeletonId: () => null, findClip: () => null, startScrollAnimation: () => {}, clearScrollFrames: () => {},
        isBoneOverlayActive: () => false, setIdleLiveHold: () => {},
    };
    const anim = new Scene3DAnimation(ctx, host);
    return { anim, tick: () => cbs.forEach((cb) => cb()) };
}
function idleSkeleton(): Skeleton3D {
    const s = makeSkeleton({ transform: true });
    s.data.ikChains = [
        { id: 'footL', endJointIdx: ix('foot_L'), chainLength: 2, target: [0, 0, 0], blendWeight: 1, enabled: false },
        { id: 'footR', endJointIdx: ix('foot_R'), chainLength: 2, target: [0, 0, 0], blendWeight: 1, enabled: false },
    ];
    const w = quat.setAxisAngle(quat.create(), [0, 0, 1], 0.9);
    s.data.clips = [{ id: 'wave', name: 'Wave', startFrame: 0, endFrame: 24, fps: 24, tracks: [
        { jointIndex: ix('lowerarm_L'), channel: 'rotation', keyframes: [{ frame: 0, value: [...s.data.joints[ix('lowerarm_L')].localRotation] }, { frame: 12, value: [w[0], w[1], w[2], w[3]] }, { frame: 24, value: [...s.data.joints[ix('lowerarm_L')].localRotation] }] },
    ] }];
    return s;
}
/** The OLD idle pipeline: every partial recompute was a full pass, and the break's clip apply ran its own FK. */
function asOldPipeline(s: Skeleton3D): void {
    s.recomputeSubtrees = function (this: Skeleton3D) { this.computeWorldMatrices(); return this.data.joints.length; };
    s.isParentFirst = () => false;
}

describe('procedural idle (squash & stretch + foot IK + idle break) — bit-identical, fewer full passes', () => {
    it('base idle: 4 full passes → 1 full + 3 partial; break over the idle: 5 → 1 full + 3 partial', () => {
        const now = { t: 1000 };
        const spy = vi.spyOn(performance, 'now').mockImplementation(() => now.t);
        try {
            const oldS = idleSkeleton(), newS = idleSkeleton();
            asOldPipeline(oldS);
            const O = idleEnv(oldS), N = idleEnv(newS);
            for (const { anim } of [O, N]) {
                anim.setLegIdleMode('body', 'ik');
                anim.setIdleAnimation('body', true);
                anim.setSquashStretch('body', { enabled: true, intensity: 0.1 });
            }
            expect(snapshot(newS)).toEqual(snapshot(oldS));
            const co = counter(oldS), cn = counter(newS);

            // Base idle frames.
            for (let f = 1; f <= 8; f++) {
                now.t = 1000 + f * 137;
                const v0 = newS.poseVersion;
                O.tick(); N.tick();
                expect(snapshot(newS), `idle frame ${f}`).toEqual(snapshot(oldS));
                expect(newS.poseVersion).toBeGreaterThan(v0);
                const o = co.take(), n = cn.take();
                expect(o.full).toBe(4);                        // measure + squash + 2 × foot-IK re-FK
                expect(n).toMatchObject({ full: 1, partial: 3 });
            }
            // the foot IK really solved (knees carry an ikRotation) — so the comparison isn't vacuous
            expect(newS.data.joints[ix('lowerleg_L')].ikRotation).toBeTruthy();

            // A clip played OVER the idle (crossfade in, full weight, crossfade out).
            const t0 = 1000 + 9 * 137;
            now.t = t0;
            expect(O.anim.playClipOverIdle('body', 'Wave')).toBe(true);
            expect(N.anim.playClipOverIdle('body', 'Wave')).toBe(true);
            co.take(); cn.take();
            for (const ms of [40, 120, 300, 500, 700, 900, 980]) {
                now.t = t0 + ms;
                O.tick(); N.tick();
                expect(snapshot(newS), `break @${ms}ms`).toEqual(snapshot(oldS));
                const o = co.take(), n = cn.take();
                expect(o.full).toBe(5);                        // + the clip apply's own FK pass
                expect(n).toMatchObject({ full: 1, partial: 3 });
            }
        } finally { spy.mockRestore(); }
    });

    it('plain idle (no squash, FK legs): still exactly 1 full pass a frame', () => {
        const now = { t: 1000 };
        const spy = vi.spyOn(performance, 'now').mockImplementation(() => now.t);
        try {
            const s = idleSkeleton();
            const E = idleEnv(s);
            E.anim.setIdleAnimation('body', true);
            const c = counter(s);
            for (let f = 1; f <= 3; f++) { now.t = 1000 + f * 100; E.tick(); expect(c.take()).toEqual({ full: 1, partial: 0, partialJoints: 0 }); }
        } finally { spy.mockRestore(); }
    });
});
