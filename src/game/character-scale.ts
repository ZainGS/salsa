/**
 * Character SCALE helpers (2026-10-04) — pure, no engine imports, unit-tested in character-scale.test.ts.
 *
 * A procedural character's size has two knobs:
 *  - the body `height` PARAM (body-generator): bakes a uniform factor into the geometry + skeleton rest pose and
 *    regenerates / refits every overlay (clothes, hair, face kit, charms). Proportions stay; it is a "re-make".
 *  - the uniform NODE SCALE of the body mesh (this module): the body transform drives the skeleton's object transform
 *    (transformViaSkeleton), and every overlay is skinned to that skeleton, so the whole character scales as one
 *    with NO regeneration. It is an ordinary node scale (saved with the body node).
 *
 * The body's origin is NOT at its feet (the generator roots the rig at the hips, legs extend below it), so a scale
 * about the origin would sink / lift the feet. Every scale path here keeps the SOLES (the lowest point of the rest
 * geometry) at the same world height.
 */

import { REFERENCE_AVATAR_HEIGHT_M } from './third-person-camera';

/** Smallest / largest uniform character scale the API accepts (a 1 cm doll to a kaiju). */
export const CHARACTER_SCALE_MIN = 0.01;
export const CHARACTER_SCALE_MAX = 1000;

/** Clamp a requested uniform scale into the supported range (NaN / ≤ 0 → null = reject). */
export function clampCharacterScale(s: number): number | null {
  if (!Number.isFinite(s) || s <= 0) return null;
  return Math.min(CHARACTER_SCALE_MAX, Math.max(CHARACTER_SCALE_MIN, s));
}

/** The new origin Y that keeps the soles at the same world height when the uniform scale goes s0 → s1. `localMinY` is
 *  the lowest Y of the rest geometry in MESH space (the soles); valid for an upright (yaw-only) character. */
export function feetAnchoredY(y0: number, s0: number, s1: number, localMinY: number): number {
  return y0 + localMinY * (s0 - s1);
}

/** The uniform factor that turns a character `currentH` tall into one `targetH` tall (same units). 1 when either is
 *  unusable. */
export function scaleFactorForHeight(currentH: number, targetH: number): number {
  if (!(currentH > 0) || !(targetH > 0) || !Number.isFinite(currentH) || !Number.isFinite(targetH)) return 1;
  return targetH / currentH;
}

/**
 * The Play collision CAPSULE for an avatar of measured world height `H` (any size, any scene scale): the metre
 * defaults (radius, step height) × H / 1.7 m — the same ratio avatarCameraFraming uses, so a 2× giant gets a 2× wide
 * body and climbs 2× higher steps, and a doll does not stand 35 cm away from every wall. A 1.7 m avatar (a fitted
 * character in a city, or 1.7 units outside one) gets exactly the defaults.
 */
export function avatarCollisionScale(H: number, d: { radius: number; stepHeight: number }): { radius: number; stepHeight: number } {
  const k = H > 0 && Number.isFinite(H) ? H / REFERENCE_AVATAR_HEIGHT_M : 1;
  return { radius: d.radius * k, stepHeight: d.stepHeight * k };
}

/** The transform fields a scale constraint reads / writes (a Mesh3D satisfies it). */
export interface ScalableNode {
  x: number; y: number; z: number;
  scaleX: number; scaleY: number; scaleZ: number;
  isProceduralBody?: boolean;
  transformViaSkeleton?: boolean;
  isHair?: boolean; isClothing?: boolean; isAttachment?: boolean; isFaceDecal?: boolean;
}
export interface ScaleSnapshot { x: number; y: number; z: number; sx: number; sy: number; sz: number }

/** A part that RIDES a character's skeleton (hair, garment, charm, face decal): its own TRS is not used (the skin
 *  carries the body transform), so a gizmo scale must leave it alone. */
export function isCharacterPart(n: ScalableNode): boolean {
  return !n.isProceduralBody && !!n.transformViaSkeleton && !!(n.isHair || n.isClothing || n.isAttachment || n.isFaceDecal);
}

/**
 * Gizmo / shortcut scale constraint for a character. After the transform controller wrote a scale step:
 *  - a procedural BODY becomes UNIFORM (the axis factor that moved most from the drag start wins, applied to all three
 *    axes, keeping any authored ratio) and is scaled FROM ITS FEET (the origin Y re-derived so the soles stay put; X / Z
 *    keep what the controller computed — a multi-selection formation scale still spreads — except a corner drag, whose
 *    corner anchoring would slide a uniform character sideways, so it scales in place);
 *  - a character PART keeps its drag-start transform.
 * Returns true when it changed anything. `localMinY` = the body's rest-geometry lowest Y in mesh space.
 */
export function constrainCharacterScale(n: ScalableNode, init: ScaleSnapshot, localMinY: number | null, opts?: { corner?: boolean }): boolean {
  if (isCharacterPart(n)) {
    if (n.scaleX === init.sx && n.scaleY === init.sy && n.scaleZ === init.sz && n.x === init.x && n.y === init.y && n.z === init.z) return false;
    n.scaleX = init.sx; n.scaleY = init.sy; n.scaleZ = init.sz; n.x = init.x; n.y = init.y; n.z = init.z;
    return true;
  }
  if (!n.isProceduralBody) return false;
  const r = (s: number, s0: number) => (s0 !== 0 ? s / s0 : 1);
  const rx = r(n.scaleX, init.sx), ry = r(n.scaleY, init.sy), rz = r(n.scaleZ, init.sz);
  let f = rx;
  if (Math.abs(ry - 1) > Math.abs(f - 1)) f = ry;
  if (Math.abs(rz - 1) > Math.abs(f - 1)) f = rz;
  if (!Number.isFinite(f) || f <= 0) f = 1;
  const k = clampCharacterScale(Math.abs(init.sy * f)) ?? Math.abs(init.sy);
  f = init.sy !== 0 ? k / Math.abs(init.sy) : 1;
  n.scaleX = init.sx * f; n.scaleY = init.sy * f; n.scaleZ = init.sz * f;
  if (opts?.corner) { n.x = init.x; n.z = init.z; }
  n.y = localMinY !== null && Number.isFinite(localMinY) ? feetAnchoredY(init.y, init.sy, n.scaleY, localMinY) : init.y;
  return true;
}

/** Lowest Y of a vertex buffer (stride floats per vertex, position first). null when empty. */
export function geometryMinY(vertices: ArrayLike<number>, stride: number): number | null {
  let lo = Infinity;
  for (let i = 1; i < vertices.length; i += stride) if (vertices[i] < lo) lo = vertices[i];
  return Number.isFinite(lo) ? lo : null;
}
