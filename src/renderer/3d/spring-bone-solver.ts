/**
 * Spring-bone solver — VRM-style dynamic bones for hair tails / cloth / accessories.
 *
 * Runs AFTER FK + IK + constraints each frame (it's world-space physics on the already-posed skeleton).
 * Each spring joint is ROTATION-ONLY (the bone keeps its rest length): its tip is a damped spring point
 * that lags the rest (FK) pose with inertia + gravity, is collision-resolved against the body colliders,
 * then the joint's world matrix is re-derived to point the bone at the resolved tip. Children in the chain
 * read their parent's freshly-solved world matrix, so a chain is processed ROOT → tip.
 *
 * Evaluation order (extends constraint-solver.ts's pipeline):
 *   1. FK            — skel.computeWorldMatrices()
 *   2. IK            — solveAllIKChains()
 *   3. Constraints   — solveAllConstraints() + computeWorldMatrices()
 *   4. Spring bones  — solveSpringBones(skel, dt)   ← this module (writes spring joints' world/skin matrices)
 *
 * Ephemeral per-joint tip state lives here (a WeakMap), never on the serialized skeleton.
 */

import { mat4, quat, vec3 } from 'gl-matrix';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { Joint3D, SpringChain, SpringCollider } from '../../types/armature-3d';

/** Per-joint physics state (world-space tip positions for Verlet inertia). */
interface JointSpringState {
    /** Tip world position last frame + this frame. */
    prev: vec3;
    curr: vec3;
    init: boolean;
}
/** Per-skeleton runtime: tip state keyed by joint index. */
type SkelSpringState = Map<number, JointSpringState>;

const RUNTIME = new WeakMap<Skeleton3D, SkelSpringState>();

/** A collider resolved to world space this frame: a capsule p0→p1 (p0==p1 ⇒ sphere) of `radius`. */
interface WorldCollider { p0: vec3; p1: vec3; radius: number; }

// ── Reused module-level scratch — the solver runs sequentially per skeleton (never re-entrant / concurrent),
//    so these are safe to share across joints AND across skeletons. Each is assigned to one live value at a
//    time; see the live-range comments in solveSpringBones. Converting ~15 vec3/quat allocs PER JOINT PER
//    FRAME to reuse was the single biggest character-mode churn source (spring hair on every character). ──
const _tpIn        = vec3.create();   // transformPointInto input
const _qbPerp      = vec3.create();   // quatBetweenInto perp
const _qbAxis      = vec3.create();   // quatBetweenInto axis / basis
const _cosAb       = vec3.create();   // closestOnSegmentInto edge
const _cosTmp      = vec3.create();   // closestOnSegmentInto q-p0
const _sGdir       = vec3.create();   // per-chain gravity dir
const _sHead       = vec3.create();   // joint head (world) — live whole iteration
const _sAxis       = vec3.create();   // bone axis (local) — live until restAxis
const _sRestAxis   = vec3.create();   // rest tip axis (world) — live whole iteration
const _sRestTip    = vec3.create();   // rest tip (world)
const _sVel        = vec3.create();
const _sNextTip    = vec3.create();   // the swinging tip accumulator — live whole iteration
const _sSpringTemp = vec3.create();
const _sDir        = vec3.create();   // pinned bone dir — live through the collision loop
const _sClosest    = vec3.create();
const _sDelta      = vec3.create();
const _sD2         = vec3.create();
const _sNewAxis    = vec3.create();
const _sParentRot     = quat.create();
const _sRestWorldRot  = quat.create();   // live whole iteration
const _sDeltaRot      = quat.create();
const _sTmpMat        = mat4.create();   // per-joint skin-matrix temp
const _sTmpQuat       = quat.create();   // per-joint new world rotation

// Persistent collider pool (was a fresh WorldCollider[] + 2 vec3 per collider every frame).
const _colliderPool: WorldCollider[] = [];

// ── small math helpers (allocation-free — write into a caller-provided `out`) ──
function transformPointInto(out: vec3, m: Float32Array, p: [number, number, number]): vec3 {
    vec3.set(_tpIn, p[0], p[1], p[2]);
    return vec3.transformMat4(out, _tpIn, m as unknown as mat4);
}
/** Minimal-arc quaternion rotating unit vector a → unit vector b, written into `out`. */
function quatBetweenInto(out: quat, a: vec3, b: vec3): quat {
    const d = vec3.dot(a, b);
    if (d >= 0.999999) return quat.identity(out);
    if (d <= -0.999999) {
        let perp = vec3.cross(_qbPerp, a, vec3.set(_qbAxis, 1, 0, 0));
        if (vec3.length(perp) < 1e-4) perp = vec3.cross(_qbPerp, a, vec3.set(_qbAxis, 0, 1, 0));
        vec3.normalize(perp, perp);
        return quat.setAxisAngle(out, perp, Math.PI);
    }
    const axis = vec3.cross(_qbAxis, a, b);
    out[0] = axis[0]; out[1] = axis[1]; out[2] = axis[2]; out[3] = 1 + d;
    return quat.normalize(out, out);
}
/** Closest point on segment p0→p1 to point q, written into `out`. */
function closestOnSegmentInto(out: vec3, q: vec3, p0: vec3, p1: vec3): vec3 {
    const ab = vec3.subtract(_cosAb, p1, p0);
    const denom = vec3.dot(ab, ab);
    if (denom < 1e-12) return vec3.copy(out, p0);
    let t = vec3.dot(vec3.subtract(_cosTmp, q, p0), ab) / denom;
    t = Math.max(0, Math.min(1, t));
    return vec3.scaleAndAdd(out, p0, ab, t);
}

/** Resolve the skeleton's spring colliders to world space into the reused pool; returns the live count. */
function resolveCollidersInto(skel: Skeleton3D): number {
    let n = 0;
    const joints = skel.data.joints;
    for (const c of skel.data.springColliders ?? []) {
        const j = joints[c.jointIdx];
        if (!j) continue;
        let wc = _colliderPool[n];
        if (!wc) { wc = { p0: vec3.create(), p1: vec3.create(), radius: 0 }; _colliderPool[n] = wc; }
        transformPointInto(wc.p0, j.worldMatrix, c.offset);
        if (c.tail) transformPointInto(wc.p1, j.worldMatrix, c.tail); else vec3.copy(wc.p1, wc.p0);
        wc.radius = c.radius;
        n++;
    }
    return n;
}

/** Bone axis (head→tip, LOCAL frame) written into `outAxis`; returns its length, or -1 for a degenerate bone. */
function boneLocalInto(outAxis: vec3, joint: Joint3D, nextInChain: Joint3D | undefined): number {
    const v = nextInChain ? nextInChain.localPosition : joint.tailOffset;
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-5) return -1;
    vec3.set(outAxis, v[0] / len, v[1] / len, v[2] / len);
    return len;
}

/**
 * Solve all enabled spring chains for one frame. Mutates the spring joints' worldMatrix + the skeleton's
 * skinMatrices (and sets matricesDirty). Returns true while ANY spring is still moving (the driver should
 * request another frame); false once everything has settled (so the render loop can idle).
 *
 * @param dt seconds since the last solve. Clamped internally; the params are tuned for ~60fps.
 */
export function solveSpringBones(skel: Skeleton3D, dt: number): boolean {
    const chains = skel.data.springChains;
    if (!chains || chains.length === 0) return false;
    const joints = skel.data.joints;

    let state = RUNTIME.get(skel);
    if (!state) { state = new Map(); RUNTIME.set(skel, state); }

    const colliderCount = resolveCollidersInto(skel);
    // Normalise to a 60fps step so swing speed is framerate-independent; clamp so a long stall can't explode.
    const step = Math.max(0.2, Math.min(2.5, (dt > 0 ? dt : 1 / 60) * 60));
    const SETTLE2 = 1e-8;   // squared world-distance below which a joint is "still"
    let moving = false;

    const tmpMat = _sTmpMat;
    const tmpQuat = _sTmpQuat;

    for (const chain of chains) {
        if (!chain.enabled || chain.jointIndices.length === 0) continue;
        const drag = Math.max(0, Math.min(1, chain.drag));
        const stiff = Math.max(0, Math.min(1, chain.stiffness));
        const gdir = vec3.set(_sGdir, chain.gravityDir[0], chain.gravityDir[1], chain.gravityDir[2]);
        if (vec3.length(gdir) > 1e-6) vec3.normalize(gdir, gdir); else vec3.set(gdir, 0, -1, 0);

        for (let n = 0; n < chain.jointIndices.length; n++) {
            const jIdx = chain.jointIndices[n];
            const J = joints[jIdx];
            if (!J || J.parentIndex < 0) continue;
            const parent = joints[J.parentIndex];
            if (!parent) continue;
            const next = joints[chain.jointIndices[n + 1]];   // undefined at the tip
            const boneLen = boneLocalInto(_sAxis, J, next);   // _sAxis: bone axis, live until restAxis below
            if (boneLen < 0) continue;

            // Head (joint origin) world position — fixed by the parent (rigid); only the tip swings.
            const head = transformPointInto(_sHead, parent.worldMatrix, J.localPosition);   // live whole iter
            // Rest (FK) world rotation of the joint, and where its tip rests with NO physics.
            const parentRot = mat4.getRotation(_sParentRot, parent.worldMatrix as unknown as mat4);
            const restWorldRot = quat.multiply(_sRestWorldRot, parentRot, J.localRotation as unknown as quat);
            const restAxisWorld = vec3.transformQuat(_sRestAxis, _sAxis, restWorldRot);   // _sAxis last read here
            vec3.normalize(restAxisWorld, restAxisWorld);
            const restTip = vec3.scaleAndAdd(_sRestTip, head, restAxisWorld, boneLen);

            let st = state.get(jIdx);
            if (!st || !st.init) { st = { prev: vec3.clone(restTip), curr: vec3.clone(restTip), init: true }; state.set(jIdx, st); }

            // ── Verlet integration: inertia + spring-to-rest + gravity ──
            const vel = vec3.subtract(_sVel, st.curr, st.prev);
            vec3.scale(vel, vel, 1 - drag);                                  // drag
            const nextTip = vec3.add(_sNextTip, st.curr, vel);              // inertia carries the swing (accumulator)
            vec3.scaleAndAdd(nextTip, nextTip, vec3.subtract(_sSpringTemp, restTip, st.curr), stiff * step);   // spring back to the FK pose
            vec3.scaleAndAdd(nextTip, nextTip, gdir, chain.gravity * step); // gravity

            // ── Rigid bone length: keep the tip exactly `len` from the head ──
            let dir = vec3.subtract(_sDir, nextTip, head);
            if (vec3.length(dir) < 1e-6) dir = vec3.copy(_sDir, restAxisWorld);
            vec3.normalize(dir, dir);
            vec3.scaleAndAdd(nextTip, head, dir, boneLen);

            // ── Collisions: push the tip out of every collider, then re-pin the length ──
            for (let ci = 0; ci < colliderCount; ci++) {
                const col = _colliderPool[ci];
                const closest = closestOnSegmentInto(_sClosest, nextTip, col.p0, col.p1);
                const delta = vec3.subtract(_sDelta, nextTip, closest);
                const dist = vec3.length(delta);
                const minDist = col.radius + chain.hitRadius;
                if (dist < minDist) {
                    if (dist > 1e-6) vec3.scale(delta, delta, 1 / dist); else vec3.copy(delta, dir);
                    vec3.scaleAndAdd(nextTip, closest, delta, minDist);     // push out to the surface
                    const d2 = vec3.subtract(_sD2, nextTip, head);         // re-pin the bone length
                    if (vec3.length(d2) < 1e-6) vec3.copy(d2, dir);
                    vec3.normalize(d2, d2);
                    vec3.scaleAndAdd(nextTip, head, d2, boneLen);
                }
            }

            if (vec3.squaredDistance(nextTip, st.curr) > SETTLE2) moving = true;
            vec3.copy(st.prev, st.curr);
            vec3.copy(st.curr, nextTip);

            // ── Re-derive the joint's WORLD matrix so the bone points at the resolved tip ──
            const newAxisWorld = vec3.subtract(_sNewAxis, nextTip, head);
            vec3.normalize(newAxisWorld, newAxisWorld);
            const deltaRot = quatBetweenInto(_sDeltaRot, restAxisWorld, newAxisWorld);
            const newWorldRot = quat.multiply(tmpQuat, deltaRot, restWorldRot);
            quat.normalize(newWorldRot, newWorldRot);
            mat4.fromRotationTranslationScale(
                J.worldMatrix as unknown as mat4,
                newWorldRot,
                head as unknown as vec3,
                J.localScale as unknown as vec3,
            );
            // skinMatrix = worldMatrix × inverseBindMatrix
            mat4.mul(tmpMat, J.worldMatrix as unknown as mat4, J.inverseBindMatrix as unknown as mat4);
            skel.skinMatrices.set(tmpMat as Float32Array, J.index * 16);
        }
    }

    if (moving) skel.matricesDirty = true;
    return moving;
}

/** Forget a skeleton's spring tip state (call when chains change so they re-seed from the current rest). */
export function resetSpringState(skel: Skeleton3D): void {
    RUNTIME.delete(skel);
}
