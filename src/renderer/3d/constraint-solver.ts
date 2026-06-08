/**
 * Bone constraint solver — pure math module, no GPU code.
 *
 * Evaluation order:
 *   1. FK  — skel.computeWorldMatrices()
 *   2. IK  — solveAllIKChains(skel)
 *   3. Post-IK world matrices — skel.computeWorldMatrices()
 *   4. Constraints — solveAllConstraints(skel)   ← this module
 *   5. Final world matrices — skel.computeWorldMatrices()
 */

import { mat4, quat, vec3 } from 'gl-matrix';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { Joint3D, JointConstraint } from '../../types/armature-3d';

// ── Math helpers ──────────────────────────────────────────────────────────────

/** Minimal-arc quaternion from unit vector a → b. */
function quatBetweenVectors(a: vec3, b: vec3): quat {
    const dot = vec3.dot(a, b);
    if (dot >= 0.9999) return quat.create();
    const out = quat.create();
    if (dot <= -0.9999) {
        const perp = vec3.cross(vec3.create(), a, vec3.fromValues(1, 0, 0));
        if (vec3.length(perp) < 0.001) vec3.cross(perp, a, vec3.fromValues(0, 1, 0));
        vec3.normalize(perp, perp);
        quat.setAxisAngle(out, perp, Math.PI);
        return out;
    }
    const axis = vec3.cross(vec3.create(), a, b);
    out[0] = axis[0];
    out[1] = axis[1];
    out[2] = axis[2];
    out[3] = 1 + dot;
    quat.normalize(out, out);
    return out;
}

/** Extract translation from a mat4. */
function mat4Translation(m: Float32Array): vec3 {
    return vec3.fromValues(m[12], m[13], m[14]);
}

/** Recompute joint.worldMatrix using constraintRotation / ikRotation / localRotation precedence. */
function recomputeWorldMatrix(joint: Joint3D, joints: Joint3D[]): void {
    const rot   = quat.clone((joint.constraintRotation ?? joint.ikRotation ?? joint.localRotation) as unknown as quat);
    const scale = vec3.clone((joint.constraintScale ?? joint.localScale) as unknown as vec3);
    const local = mat4.create() as unknown as Float32Array;
    mat4.fromRotationTranslationScale(
        local as unknown as mat4,
        rot,
        joint.localPosition as unknown as vec3,
        scale,
    );
    if (joint.parentIndex < 0) {
        joint.worldMatrix.set(local);
    } else {
        mat4.mul(
            joint.worldMatrix as unknown as mat4,
            joints[joint.parentIndex].worldMatrix as unknown as mat4,
            local as unknown as mat4,
        );
    }
}

// ── Constraint evaluators ─────────────────────────────────────────────────────

function applyLookAt(joint: Joint3D, joints: Joint3D[], c: Extract<JointConstraint, { type: 'lookAt' }>): void {
    if (c.targetJointIdx < 0 || c.targetJointIdx >= joints.length) return;

    const targetPos = mat4Translation(joints[c.targetJointIdx].worldMatrix);
    const jointPos  = mat4Translation(joint.worldMatrix);

    const dir = vec3.subtract(vec3.create(), targetPos, jointPos);
    if (vec3.length(dir) < 0.0001) return;
    vec3.normalize(dir, dir);

    // Bring direction into the joint's parent local space
    const parentInv = quat.create();
    if (joint.parentIndex >= 0) {
        const parentRot = quat.create();
        mat4.getRotation(parentRot, joints[joint.parentIndex].worldMatrix as unknown as mat4);
        quat.invert(parentInv, parentRot);
    }
    const localDir = vec3.transformQuat(vec3.create(), dir, parentInv);
    vec3.normalize(localDir, localDir);

    // Align the chosen local axis with localDir
    const axisVec: vec3 = c.axis === 'x' ? vec3.fromValues(1, 0, 0)
                        : c.axis === 'z' ? vec3.fromValues(0, 0, 1)
                        :                  vec3.fromValues(0, 1, 0);
    const delta = quatBetweenVectors(axisVec, localDir);

    const baseRot = quat.clone((joint.ikRotation ?? joint.localRotation) as unknown as quat);
    const target  = quat.multiply(quat.create(), baseRot, delta);
    const out     = quat.slerp(quat.create(), baseRot, target, Math.max(0, Math.min(1, c.influence)));
    quat.normalize(out, out);
    joint.constraintRotation = [out[0], out[1], out[2], out[3]];
}

function applyCopyRotation(joint: Joint3D, joints: Joint3D[], c: Extract<JointConstraint, { type: 'copyRotation' }>): void {
    if (c.sourceJointIdx < 0 || c.sourceJointIdx >= joints.length) return;
    const src     = joints[c.sourceJointIdx].localRotation as unknown as quat;
    const baseRot = quat.clone((joint.ikRotation ?? joint.localRotation) as unknown as quat);
    const out     = quat.slerp(quat.create(), baseRot, src, Math.max(0, Math.min(1, c.influence)));
    quat.normalize(out, out);
    joint.constraintRotation = [out[0], out[1], out[2], out[3]];
}

function applyStretchTo(joint: Joint3D, joints: Joint3D[], c: Extract<JointConstraint, { type: 'stretchTo' }>): void {
    if (c.targetJointIdx < 0 || c.targetJointIdx >= joints.length) return;

    const targetPos = mat4Translation(joints[c.targetJointIdx].worldMatrix);
    const jointPos  = mat4Translation(joint.worldMatrix);
    const currentLen = vec3.distance(targetPos, jointPos);

    const tail    = joint.tailOffset ?? [0, 0.3, 0];
    const restLen = Math.sqrt(tail[0] * tail[0] + tail[1] * tail[1] + tail[2] * tail[2]);
    if (restLen < 0.0001) return;

    const stretchFactor = currentLen / restLen;
    const vp = Math.max(0, Math.min(1, c.volumePreserve));
    const perpScale = vp > 0 ? 1.0 + (1.0 / Math.sqrt(Math.max(stretchFactor, 0.0001)) - 1.0) * vp : 1.0;
    const targetScale: [number, number, number] = [perpScale, stretchFactor, perpScale];

    const cur = joint.localScale;
    const inf = Math.max(0, Math.min(1, c.influence));
    joint.constraintScale = [
        cur[0] + (targetScale[0] - cur[0]) * inf,
        cur[1] + (targetScale[1] - cur[1]) * inf,
        cur[2] + (targetScale[2] - cur[2]) * inf,
    ];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Evaluate all joint constraints on the skeleton.
 * Caller must have already run IK and called computeWorldMatrices() once before
 * calling this. After this returns, caller calls computeWorldMatrices() one final
 * time to propagate constraint overrides through the hierarchy.
 */
export function solveAllConstraints(skeleton: Skeleton3D): void {
    const joints = skeleton.data.joints;
    for (const joint of joints) {
        if (!joint.constraints?.length) continue;
        for (const c of joint.constraints) {
            switch (c.type) {
                case 'lookAt':       applyLookAt(joint, joints, c);       break;
                case 'copyRotation': applyCopyRotation(joint, joints, c); break;
                case 'stretchTo':    applyStretchTo(joint, joints, c);    break;
            }
            // Inline update so subsequent constraints on this joint see updated orientation
            recomputeWorldMatrix(joint, joints);
        }
    }
}

/** Clear ephemeral constraint state (call when constraints change or are removed). */
export function clearAllConstraintState(skeleton: Skeleton3D): void {
    for (const j of skeleton.data.joints) {
        j.constraintRotation = undefined;
        j.constraintScale    = undefined;
    }
}
