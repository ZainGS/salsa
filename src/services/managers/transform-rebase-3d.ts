/**
 * rebase3DNodeToParent — reparent a 3D node WITHOUT moving it in world space (audit P3,
 * editing-loop-polish.md — "the 2026-09-14 2D ungroup math, in 3D").
 *
 * The problem it fixes: `addMeshToGroup` / `removeMeshFromGroup` / `deleteMeshGroup` used to
 * reparent by raw removeChild/addChild — the node's LOCAL x/y/z were suddenly interpreted in a
 * different frame, so any transformed group made its members jump on entry/exit.
 *
 * Method: capture the node's world TRS from its COMBINED matrix (the `localMatrix` getter composes
 * the parent chain) BEFORE detaching, reparent, then re-express that world TRS in the new parent's
 * frame (translation via the exact inverse matrix; rotation via quaternion division decomposed back
 * to the engine's Y→X→Z Euler order; scale per-axis). A rotated ancestor with NON-UNIFORM scale
 * shears — that can't be expressed as TRS, so rotation/scale are the nearest fit there (same
 * documented caveat as 2D `bakeScaleToLeaves`); position is always exact.
 */

import { mat4, quat, vec3, vec4 } from 'gl-matrix';
import { Node } from '../../scene-graph/shapes/base/node';
import { quatToEulerYXZ } from './transform-controller-3d';

/** The node's current world TRS, decomposed from its combined matrix. */
export function worldTRS3D(node: Node): { t: vec3; q: quat; s: vec3 } {
    const wm = (node as unknown as { localMatrix: mat4 }).localMatrix;
    return {
        t: vec3.fromValues(wm[12], wm[13], wm[14]),
        q: mat4.getRotation(quat.create(), wm),
        s: mat4.getScaling(vec3.create(), wm),
    };
}

/**
 * Reparent `node` under `newParent` (detaching from its current parent first) and rewrite its
 * local TRS so its world transform is preserved. Ends with `updateLocalMatrix()`; the caller owns
 * emit/render. No-op when the node is already a direct child of `newParent`.
 */
export function rebase3DNodeToParent(node: Node, newParent: Node): void {
    if (node.parent === newParent) return;

    const { t, q, s } = worldTRS3D(node);

    node.parent?.removeChild(node);
    newParent.addChild(node);

    // The new parent chain's world matrix (identity when parenting to the scene root).
    const pm = node.parentChainMatrix;
    const inv = mat4.invert(mat4.create(), pm) ?? mat4.identity(mat4.create());

    const local = vec4.transformMat4(vec4.create(), vec4.fromValues(t[0], t[1], t[2], 1), inv);
    const pq = mat4.getRotation(quat.create(), pm);
    const ps = mat4.getScaling(vec3.create(), pm);
    const lq = quat.multiply(quat.create(), quat.invert(quat.create(), pq), q);
    quat.normalize(lq, lq);
    const [rx, ry, rz] = quatToEulerYXZ(lq);

    node.x = local[0];
    node.y = local[1];
    node.z = local[2];
    node.rotationX = rx;
    node.rotationY = ry;
    node.rotation = rz;
    node.scaleX = ps[0] !== 0 ? s[0] / ps[0] : s[0];
    node.scaleY = ps[1] !== 0 ? s[1] / ps[1] : s[1];
    node.scaleZ = ps[2] !== 0 ? s[2] / ps[2] : s[2];
    node.updateLocalMatrix();
}

/** Snapshot of the local TRS fields `rebase3DNodeToParent` rewrites — for undo closures. */
export interface LocalTRS3D {
    x: number; y: number; z: number;
    rotationX: number; rotationY: number; rotation: number;
    scaleX: number; scaleY: number; scaleZ: number;
}

export function captureLocalTRS3D(node: Node): LocalTRS3D {
    return {
        x: node.x, y: node.y, z: node.z,
        rotationX: node.rotationX, rotationY: node.rotationY, rotation: node.rotation,
        scaleX: node.scaleX, scaleY: node.scaleY, scaleZ: node.scaleZ,
    };
}

export function restoreLocalTRS3D(node: Node, t: LocalTRS3D): void {
    node.x = t.x; node.y = t.y; node.z = t.z;
    node.rotationX = t.rotationX; node.rotationY = t.rotationY; node.rotation = t.rotation;
    node.scaleX = t.scaleX; node.scaleY = t.scaleY; node.scaleZ = t.scaleZ;
    node.updateLocalMatrix();
}
