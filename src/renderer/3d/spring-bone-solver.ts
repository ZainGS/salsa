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

// ── small math helpers ──
function mat4Translation(m: Float32Array): vec3 { return vec3.fromValues(m[12], m[13], m[14]); }
function transformPoint(m: Float32Array, p: [number, number, number]): vec3 {
    return vec3.transformMat4(vec3.create(), vec3.fromValues(p[0], p[1], p[2]), m as unknown as mat4);
}
/** Minimal-arc quaternion rotating unit vector a → unit vector b. */
function quatBetween(a: vec3, b: vec3): quat {
    const d = vec3.dot(a, b);
    if (d >= 0.999999) return quat.create();
    const out = quat.create();
    if (d <= -0.999999) {
        let perp = vec3.cross(vec3.create(), a, vec3.fromValues(1, 0, 0));
        if (vec3.length(perp) < 1e-4) perp = vec3.cross(vec3.create(), a, vec3.fromValues(0, 1, 0));
        vec3.normalize(perp, perp);
        return quat.setAxisAngle(out, perp, Math.PI);
    }
    const axis = vec3.cross(vec3.create(), a, b);
    out[0] = axis[0]; out[1] = axis[1]; out[2] = axis[2]; out[3] = 1 + d;
    return quat.normalize(out, out);
}
/** Closest point on segment p0→p1 to point q. */
function closestOnSegment(q: vec3, p0: vec3, p1: vec3): vec3 {
    const ab = vec3.subtract(vec3.create(), p1, p0);
    const denom = vec3.dot(ab, ab);
    if (denom < 1e-12) return vec3.clone(p0);
    let t = vec3.dot(vec3.subtract(vec3.create(), q, p0), ab) / denom;
    t = Math.max(0, Math.min(1, t));
    return vec3.scaleAndAdd(vec3.create(), p0, ab, t);
}

/** Resolve all of the skeleton's spring colliders to world space using the body joints' worldMatrices. */
function resolveColliders(skel: Skeleton3D): WorldCollider[] {
    const out: WorldCollider[] = [];
    const joints = skel.data.joints;
    for (const c of skel.data.springColliders ?? []) {
        const j = joints[c.jointIdx];
        if (!j) continue;
        const p0 = transformPoint(j.worldMatrix, c.offset);
        const p1 = c.tail ? transformPoint(j.worldMatrix, c.tail) : p0;
        out.push({ p0, p1, radius: c.radius });
    }
    return out;
}

/** Bone vector (head→tip) in the joint's LOCAL frame + its length — toward the next chain joint, else the
 *  joint's tailOffset (leaf). Returns null for a degenerate (zero-length) bone. */
function boneLocal(joint: Joint3D, nextInChain: Joint3D | undefined): { axis: vec3; len: number } | null {
    const v = nextInChain ? nextInChain.localPosition : joint.tailOffset;
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-5) return null;
    return { axis: vec3.fromValues(v[0] / len, v[1] / len, v[2] / len), len };
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

    const colliders = resolveColliders(skel);
    // Normalise to a 60fps step so swing speed is framerate-independent; clamp so a long stall can't explode.
    const step = Math.max(0.2, Math.min(2.5, (dt > 0 ? dt : 1 / 60) * 60));
    const SETTLE2 = 1e-8;   // squared world-distance below which a joint is "still"
    let moving = false;

    const tmpMat = mat4.create();
    const tmpQuat = quat.create();

    for (const chain of chains) {
        if (!chain.enabled || chain.jointIndices.length === 0) continue;
        const drag = Math.max(0, Math.min(1, chain.drag));
        const stiff = Math.max(0, Math.min(1, chain.stiffness));
        const gdir = vec3.fromValues(chain.gravityDir[0], chain.gravityDir[1], chain.gravityDir[2]);
        if (vec3.length(gdir) > 1e-6) vec3.normalize(gdir, gdir); else vec3.set(gdir, 0, -1, 0);

        for (let n = 0; n < chain.jointIndices.length; n++) {
            const jIdx = chain.jointIndices[n];
            const J = joints[jIdx];
            if (!J || J.parentIndex < 0) continue;
            const parent = joints[J.parentIndex];
            if (!parent) continue;
            const next = joints[chain.jointIndices[n + 1]];   // undefined at the tip
            const bone = boneLocal(J, next);
            if (!bone) continue;

            // Head (joint origin) world position — fixed by the parent (rigid); only the tip swings.
            const head = transformPoint(parent.worldMatrix, J.localPosition);
            // Rest (FK) world rotation of the joint, and where its tip rests with NO physics.
            const parentRot = mat4.getRotation(quat.create(), parent.worldMatrix as unknown as mat4);
            const restWorldRot = quat.multiply(quat.create(), parentRot, J.localRotation as unknown as quat);
            const restAxisWorld = vec3.transformQuat(vec3.create(), bone.axis, restWorldRot);
            vec3.normalize(restAxisWorld, restAxisWorld);
            const restTip = vec3.scaleAndAdd(vec3.create(), head, restAxisWorld, bone.len);

            let st = state.get(jIdx);
            if (!st || !st.init) { st = { prev: vec3.clone(restTip), curr: vec3.clone(restTip), init: true }; state.set(jIdx, st); }

            // ── Verlet integration: inertia + spring-to-rest + gravity ──
            const vel = vec3.subtract(vec3.create(), st.curr, st.prev);
            vec3.scale(vel, vel, 1 - drag);                                  // drag
            const nextTip = vec3.add(vec3.create(), st.curr, vel);          // inertia carries the swing
            vec3.scaleAndAdd(nextTip, nextTip, vec3.subtract(vec3.create(), restTip, st.curr), stiff * step);   // spring back to the FK pose
            vec3.scaleAndAdd(nextTip, nextTip, gdir, chain.gravity * step); // gravity

            // ── Rigid bone length: keep the tip exactly `len` from the head ──
            let dir = vec3.subtract(vec3.create(), nextTip, head);
            if (vec3.length(dir) < 1e-6) dir = vec3.clone(restAxisWorld);
            vec3.normalize(dir, dir);
            vec3.scaleAndAdd(nextTip, head, dir, bone.len);

            // ── Collisions: push the tip out of every collider, then re-pin the length ──
            for (const col of colliders) {
                const closest = closestOnSegment(nextTip, col.p0, col.p1);
                const delta = vec3.subtract(vec3.create(), nextTip, closest);
                const dist = vec3.length(delta);
                const minDist = col.radius + chain.hitRadius;
                if (dist < minDist) {
                    if (dist > 1e-6) vec3.scale(delta, delta, 1 / dist); else vec3.copy(delta, dir);
                    vec3.scaleAndAdd(nextTip, closest, delta, minDist);     // push out to the surface
                    let d2 = vec3.subtract(vec3.create(), nextTip, head);   // re-pin the bone length
                    if (vec3.length(d2) < 1e-6) d2 = vec3.clone(dir);
                    vec3.normalize(d2, d2);
                    vec3.scaleAndAdd(nextTip, head, d2, bone.len);
                }
            }

            if (vec3.squaredDistance(nextTip, st.curr) > SETTLE2) moving = true;
            vec3.copy(st.prev, st.curr);
            vec3.copy(st.curr, nextTip);

            // ── Re-derive the joint's WORLD matrix so the bone points at the resolved tip ──
            const newAxisWorld = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), nextTip, head));
            const deltaRot = quatBetween(restAxisWorld, newAxisWorld);
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
