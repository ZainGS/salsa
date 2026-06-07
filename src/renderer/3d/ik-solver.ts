/**
 * FABRIK IK solver — pure math module, no GPU code or scene state.
 *
 * Usage:
 *   1. skel.computeWorldMatrices()        — FK pass (world positions from localRotation)
 *   2. solveAllIKChains(skel)             — writes ikRotation on chain joints, inline worldMatrix
 *   3. skel.computeWorldMatrices()        — final pass (propagates ikRotation through hierarchy)
 *   4. Renderer reads skel.skinMatrices
 */

import { mat4, quat, vec3 } from 'gl-matrix';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { IKChain } from '../../types/armature-3d';

// ── Math helpers ─────────────────────────────────────────────────────────────

/** Minimal-arc quaternion from unit vector a to unit vector b. */
function quatBetweenVectors(a: vec3, b: vec3): [number, number, number, number] {
  const dot = vec3.dot(a, b);
  if (dot >= 0.9999) return [0, 0, 0, 1]; // parallel — identity
  if (dot <= -0.9999) {
    // Anti-parallel — 180° around a perpendicular axis
    const perp = vec3.cross(vec3.create(), a, vec3.fromValues(1, 0, 0));
    if (vec3.length(perp) < 0.001) vec3.cross(perp, a, vec3.fromValues(0, 1, 0));
    vec3.normalize(perp, perp);
    return [perp[0], perp[1], perp[2], 0];
  }
  const axis = vec3.cross(vec3.create(), a, b);
  const w = 1 + dot;
  const len = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2] + w * w);
  return [axis[0] / len, axis[1] / len, axis[2] / len, w / len];
}

/** Recompute one joint's worldMatrix from its parent's (already-updated) worldMatrix. */
function recomputeOneJoint(
  jointIdx: number,
  joints: import('../../types/armature-3d').Joint3D[],
): void {
  const j = joints[jointIdx];
  const rot = (j.ikRotation ?? j.localRotation) as unknown as quat;
  const local = mat4.fromRotationTranslationScale(
    mat4.create(),
    rot,
    j.localPosition as unknown as vec3,
    j.localScale as unknown as vec3,
  );
  if (j.parentIndex < 0) {
    j.worldMatrix.set(local as Float32Array);
  } else {
    mat4.mul(
      j.worldMatrix as unknown as mat4,
      joints[j.parentIndex].worldMatrix as unknown as mat4,
      local,
    );
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface IKSolveInput {
  positions: [number, number, number][];
  boneLengths: number[];
  target: [number, number, number];
  /** When provided, intermediate joints are projected onto the plane (anchor, target, poleTarget). */
  poleTarget?: [number, number, number];
  maxIterations?: number;
  tolerance?: number;
}

/**
 * Post-FABRIK pole constraint: projects each intermediate joint onto the plane
 * defined by chain root, end target, and poleTarget, then re-stretches from
 * its parent to preserve bone lengths.
 */
function applyPoleConstraint(
  positions: [number, number, number][],
  boneLengths: number[],
  poleTarget: [number, number, number],
): void {
  if (positions.length < 3) return;

  const root = positions[0];
  const end  = positions[positions.length - 1];

  // Pole plane normal = normalize(cross(end - root, poleTarget - root))
  const tex = end[0] - root[0], tey = end[1] - root[1], tez = end[2] - root[2];
  const tpx = poleTarget[0] - root[0], tpy = poleTarget[1] - root[1], tpz = poleTarget[2] - root[2];
  const nx = tey * tpz - tez * tpy;
  const ny = tez * tpx - tex * tpz;
  const nz = tex * tpy - tey * tpx;
  const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nlen < 1e-6) return; // pole is collinear with root-end — no constraint possible

  const pnx = nx / nlen, pny = ny / nlen, pnz = nz / nlen;

  // Project each intermediate joint onto the pole plane, re-stretch from parent
  for (let k = 1; k < positions.length - 1; k++) {
    const p   = positions[k];
    const par = positions[k - 1];

    // Signed distance of p from the pole plane (plane passes through root)
    const d = (p[0] - root[0]) * pnx + (p[1] - root[1]) * pny + (p[2] - root[2]) * pnz;
    // Project onto plane
    const projX = p[0] - d * pnx;
    const projY = p[1] - d * pny;
    const projZ = p[2] - d * pnz;

    // Re-stretch from parent to maintain bone length
    const dx = projX - par[0], dy = projY - par[1], dz = projZ - par[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-10) continue;
    const bl = boneLengths[k - 1];
    positions[k] = [
      par[0] + dx * bl / dist,
      par[1] + dy * bl / dist,
      par[2] + dz * bl / dist,
    ];
  }
}

/**
 * Runs FABRIK in-place on the positions array.
 * Returns the final end-effector distance to target.
 */
export function solveFabrik(input: IKSolveInput): number {
  const { positions, boneLengths, target } = input;
  const maxIter = input.maxIterations ?? 10;
  const tol = input.tolerance ?? 0.001;
  const n = positions.length - 1;

  const rootPos: [number, number, number] = [positions[0][0], positions[0][1], positions[0][2]];

  let totalLen = 0;
  for (const bl of boneLengths) totalLen += bl;

  const dx0 = target[0] - rootPos[0];
  const dy0 = target[1] - rootPos[1];
  const dz0 = target[2] - rootPos[2];
  const distToTarget = Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0);

  if (distToTarget >= totalLen) {
    // Unreachable — stretch chain straight toward target
    const inv = distToTarget > 1e-10 ? 1 / distToTarget : 0;
    const rx = dx0 * inv, ry = dy0 * inv, rz = dz0 * inv;
    for (let i = 0; i < n; i++) {
      positions[i + 1] = [
        positions[i][0] + rx * boneLengths[i],
        positions[i][1] + ry * boneLengths[i],
        positions[i][2] + rz * boneLengths[i],
      ];
    }
  } else {
    for (let iter = 0; iter < maxIter; iter++) {
      const ex = positions[n][0] - target[0];
      const ey = positions[n][1] - target[1];
      const ez = positions[n][2] - target[2];
      if (Math.sqrt(ex * ex + ey * ey + ez * ez) < tol) break;

      // Forward pass — pull end to target
      positions[n] = [target[0], target[1], target[2]];
      for (let i = n - 1; i >= 0; i--) {
        const rx = positions[i][0] - positions[i + 1][0];
        const ry = positions[i][1] - positions[i + 1][1];
        const rz = positions[i][2] - positions[i + 1][2];
        const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (dist < 1e-10) continue;
        const lambda = boneLengths[i] / dist;
        positions[i] = [
          positions[i + 1][0] + rx * lambda,
          positions[i + 1][1] + ry * lambda,
          positions[i + 1][2] + rz * lambda,
        ];
      }

      // Backward pass — pin root
      positions[0] = [rootPos[0], rootPos[1], rootPos[2]];
      for (let i = 0; i < n; i++) {
        const rx = positions[i + 1][0] - positions[i][0];
        const ry = positions[i + 1][1] - positions[i][1];
        const rz = positions[i + 1][2] - positions[i][2];
        const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (dist < 1e-10) continue;
        const lambda = boneLengths[i] / dist;
        positions[i + 1] = [
          positions[i][0] + rx * lambda,
          positions[i][1] + ry * lambda,
          positions[i][2] + rz * lambda,
        ];
      }
    }
  }

  // Apply pole constraint as post-process (projects intermediate joints onto pole plane)
  if (input.poleTarget) {
    applyPoleConstraint(positions, boneLengths, input.poleTarget);
  }

  const ex = positions[n][0] - target[0];
  const ey = positions[n][1] - target[1];
  const ez = positions[n][2] - target[2];
  return Math.sqrt(ex * ex + ey * ey + ez * ez);
}

/**
 * Full IK solve for one IKChain on one skeleton.
 * Reads FK world positions from joint.worldMatrix, runs FABRIK,
 * writes joint.ikRotation for each intermediate chain joint (slerped by blendWeight),
 * and updates worldMatrix inline so each joint's children see the correct parent.
 */
export function solveIKChain(skeleton: Skeleton3D, chain: IKChain): void {
  if (!chain.enabled) return;
  const blend = chain.blendWeight ?? 1;
  // blend = 0 → pure FK; skip solve entirely
  if (blend <= 0) return;
  const { joints } = skeleton.data;
  const { endJointIdx, chainLength, target } = chain;

  if (endJointIdx < 0 || endJointIdx >= joints.length) return;

  // Walk up chainLength hops from end to find chain joints (root-first order)
  const chainJoints: number[] = [endJointIdx];
  for (let i = 0; i < chainLength; i++) {
    const parentIdx = joints[chainJoints[0]].parentIndex;
    if (parentIdx < 0) break;
    chainJoints.unshift(parentIdx);
  }
  // chainJoints[0] = anchor (not modified), chainJoints[last] = end effector
  if (chainJoints.length < 2) return;

  // Extract FK world positions
  const origPos: [number, number, number][] = chainJoints.map(idx => [
    joints[idx].worldMatrix[12],
    joints[idx].worldMatrix[13],
    joints[idx].worldMatrix[14],
  ]);
  const newPos: [number, number, number][] = origPos.map(p => [p[0], p[1], p[2]]);

  // Compute bone lengths from FK positions
  const boneLengths: number[] = [];
  for (let i = 0; i < chainJoints.length - 1; i++) {
    const dx = origPos[i + 1][0] - origPos[i][0];
    const dy = origPos[i + 1][1] - origPos[i][1];
    const dz = origPos[i + 1][2] - origPos[i][2];
    boneLengths.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }

  // Run FABRIK (with optional pole constraint)
  solveFabrik({ positions: newPos, boneLengths, target, poleTarget: chain.poleTarget });

  // Convert FABRIK positions to ikRotation for each non-anchor, non-end-effector joint.
  // Loop: k=1 to chainJoints.length-2 inclusive (intermediate joints only).
  // For joint at chainJoints[k], its outgoing bone (k→k+1) must align with newPos.
  for (let k = 1; k < chainJoints.length - 1; k++) {
    const jointIdx = chainJoints[k];
    const joint = joints[jointIdx];

    // Propagate parent's IK update into this joint's worldMatrix first
    recomputeOneJoint(jointIdx, joints);

    // Extract current world rotation (now accounts for ancestors' IK updates)
    const curWorldRot = quat.create();
    mat4.getRotation(curWorldRot, joint.worldMatrix as unknown as mat4);
    quat.normalize(curWorldRot, curWorldRot);

    // Outgoing bone direction before and after FABRIK
    const dx1 = origPos[k + 1][0] - origPos[k][0];
    const dy1 = origPos[k + 1][1] - origPos[k][1];
    const dz1 = origPos[k + 1][2] - origPos[k][2];
    const l1 = Math.sqrt(dx1 * dx1 + dy1 * dy1 + dz1 * dz1);
    const origDir = l1 > 1e-10
      ? vec3.fromValues(dx1 / l1, dy1 / l1, dz1 / l1)
      : vec3.fromValues(0, 1, 0);

    const dx2 = newPos[k + 1][0] - newPos[k][0];
    const dy2 = newPos[k + 1][1] - newPos[k][1];
    const dz2 = newPos[k + 1][2] - newPos[k][2];
    const l2 = Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2);
    const newDir = l2 > 1e-10
      ? vec3.fromValues(dx2 / l2, dy2 / l2, dz2 / l2)
      : vec3.fromValues(0, 1, 0);

    // Minimal-arc delta in world space
    const delta = quatBetweenVectors(origDir, newDir) as unknown as quat;

    // New world rotation = delta × current world rotation
    const newWorldRot = quat.multiply(quat.create(), delta, curWorldRot);
    quat.normalize(newWorldRot, newWorldRot);

    // Parent's world rotation (already IK-updated from previous iterations)
    const parentWorldRot = quat.create(); // identity for root joints
    if (joint.parentIndex >= 0) {
      mat4.getRotation(parentWorldRot, joints[joint.parentIndex].worldMatrix as unknown as mat4);
      quat.normalize(parentWorldRot, parentWorldRot);
    }

    // Local rotation = inverse(parentWorldRot) × newWorldRot
    const parentInv = quat.invert(quat.create(), parentWorldRot);
    const localRot = quat.multiply(quat.create(), parentInv, newWorldRot);
    quat.normalize(localRot, localRot);

    // Blend: slerp localRotation → pure IK rotation by blendWeight
    let finalRot: quat;
    if (blend >= 1) {
      finalRot = localRot;
    } else {
      const fkRot = joint.localRotation as unknown as quat;
      finalRot = quat.slerp(quat.create(), fkRot, localRot, blend);
      quat.normalize(finalRot, finalRot);
    }

    joint.ikRotation = [finalRot[0], finalRot[1], finalRot[2], finalRot[3]];

    // Update this joint's worldMatrix inline so the next iteration sees the correct parent
    recomputeOneJoint(jointIdx, joints);
  }
}

/** Runs solveIKChain for every enabled IKChain on the skeleton. */
export function solveAllIKChains(skeleton: Skeleton3D): void {
  const chains = skeleton.data.ikChains;
  if (!chains || chains.length === 0) return;
  for (const chain of chains) {
    if (chain.enabled) solveIKChain(skeleton, chain);
  }
}

/** Clears ikRotation from all joints (call when IK is disabled or chains removed). */
export function clearAllIKRotations(skeleton: Skeleton3D): void {
  skeleton.clearIKRotations();
}
