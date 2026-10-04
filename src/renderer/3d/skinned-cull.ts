/**
 * Conservative world bounds for SKINNED meshes (polish-round-3 R6.1), so characters can be frustum-culled.
 *
 * A skinned vertex is v' = sum_i w_i * S_i * v, where S_i is joint i's skin matrix (world x inverseBind). Each term
 * S_i * v lies within s_i * |v - b_i| of the joint's skinned position S_i * b_i (= the joint's world translation),
 * where b_i is the joint's BIND position and s_i the largest axis scale of S_i. The blend is a convex combination, so
 * the skinned vertex lies inside the union of the balls (S_i * b_i, s_i * r_i), with r_i = the largest bind-space
 * distance from joint i to any vertex it influences. Bounding those balls bounds the mesh in ANY pose. (A vertex
 * blended across two joints must fit in BOTH balls, so the box can overshoot by up to a bone length at the ends —
 * character-sized, never scene-sized.)
 *
 * Split for cost: the bind positions are per SKELETON (from its inverse binds), the radii per MESH (bind data only,
 * rebuilt on a skin change), and the joint spheres (position + scale of every joint in the current pose) per
 * skeleton per pose — shared by the body, clothes and hair that ride one skeleton. Per mesh per pose the box is then a
 * min/max over only the joints that mesh uses. Dual-quaternion skinning is not strictly a convex blend of the
 * S_i * v, so callers add a small relative pad.
 */

import { mat4 } from 'gl-matrix';

/** Bind-space cull data for one skinned mesh. `radii[i] < 0` = joint i influences no vertex of this mesh. */
export interface SkinnedCullRadii {
  jointCount: number;
  /** Per joint: the largest distance from the joint's bind position to a vertex it influences, or -1. */
  radii: Float32Array;
  /** The joints with radii >= 0 (the only ones the per-pose box visits). */
  used: Uint16Array;
}

const _inv = mat4.create();

/** Per joint bind position (xyz): the translation of inverse(inverseBindMatrix). A singular matrix gives the origin. */
export function computeJointBindPositions(inverseBinds: ArrayLike<ArrayLike<number>>): Float32Array {
  const jc = inverseBinds.length;
  const bindPos = new Float32Array(jc * 3);
  for (let j = 0; j < jc; j++) {
    const ib = inverseBinds[j];
    if (!ib || ib.length < 16 || mat4.invert(_inv, ib as unknown as mat4) === null) continue;
    bindPos[j * 3] = _inv[12]; bindPos[j * 3 + 1] = _inv[13]; bindPos[j * 3 + 2] = _inv[14];
  }
  return bindPos;
}

/**
 * Build the per-joint influence radii. `vertices` is the interleaved vertex array (`stride` floats per vertex,
 * position first), `jointIndices` / `jointWeights` hold 4 influences per vertex, `bindPos` = computeJointBindPositions.
 * A vertex with no positive weight is assigned to its first joint index, so nothing is ever left outside the box.
 */
export function computeSkinnedCullRadii(
  vertices: ArrayLike<number>, stride: number,
  jointIndices: ArrayLike<number>, jointWeights: ArrayLike<number>,
  bindPos: Float32Array,
): SkinnedCullRadii {
  const jc = Math.floor(bindPos.length / 3);
  const r2 = new Float64Array(jc).fill(-1);
  const nv = Math.floor(vertices.length / stride);
  const reach = (j: number, px: number, py: number, pz: number): void => {
    const dx = px - bindPos[j * 3], dy = py - bindPos[j * 3 + 1], dz = pz - bindPos[j * 3 + 2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2[j]) r2[j] = d;
  };
  for (let v = 0; v < nv; v++) {
    const px = vertices[v * stride], py = vertices[v * stride + 1], pz = vertices[v * stride + 2];
    let any = false;
    for (let k = 0; k < 4; k++) {
      const w = jointWeights[v * 4 + k] ?? 0;
      if (!(w > 0)) continue;
      const j = jointIndices[v * 4 + k] ?? 0;
      if (j >= jc) continue;
      any = true;
      reach(j, px, py, pz);
    }
    if (!any && jc > 0) reach(Math.min(jc - 1, jointIndices[v * 4] ?? 0), px, py, pz);
  }
  const radii = new Float32Array(jc);
  let nUsed = 0;
  for (let j = 0; j < jc; j++) { radii[j] = r2[j] >= 0 ? Math.sqrt(r2[j]) : -1; if (r2[j] >= 0) nUsed++; }
  const used = new Uint16Array(nUsed);
  for (let j = 0, u = 0; j < jc; j++) if (r2[j] >= 0) used[u++] = j;
  return { jointCount: jc, radii, used };
}

/** The current pose's joint spheres: per joint (x, y, z, scale) = S_j * b_j and the largest axis scale of S_j.
 *  `skin` = the skeleton's flat skin matrices (16 floats per joint). Writes into (and returns) `out` (grown if short). */
export function computeJointSpheres(skin: ArrayLike<number>, bindPos: Float32Array, out?: Float32Array): Float32Array {
  const jc = Math.min(Math.floor(bindPos.length / 3), Math.floor(skin.length / 16));
  const o4 = out && out.length >= jc * 4 ? out : new Float32Array(jc * 4);
  for (let j = 0; j < jc; j++) {
    const o = j * 16;
    const m0 = skin[o], m1 = skin[o + 1], m2 = skin[o + 2];
    const m4 = skin[o + 4], m5 = skin[o + 5], m6 = skin[o + 6];
    const m8 = skin[o + 8], m9 = skin[o + 9], m10 = skin[o + 10];
    const bx = bindPos[j * 3], by = bindPos[j * 3 + 1], bz = bindPos[j * 3 + 2];
    o4[j * 4] = m0 * bx + m4 * by + m8 * bz + skin[o + 12];
    o4[j * 4 + 1] = m1 * bx + m5 * by + m9 * bz + skin[o + 13];
    o4[j * 4 + 2] = m2 * bx + m6 * by + m10 * bz + skin[o + 14];
    o4[j * 4 + 3] = Math.sqrt(Math.max(m0 * m0 + m1 * m1 + m2 * m2, m4 * m4 + m5 * m5 + m6 * m6, m8 * m8 + m9 * m9 + m10 * m10));
  }
  return o4;
}

/**
 * World AABB of a skinned mesh from the pose's joint spheres, written into `out` as [minX, minY, minZ, maxX, maxY,
 * maxZ]. `model` = the mesh's model matrix, or null when the skeleton carries the object transform
 * (transformViaSkeleton). `relPad` grows the box by that fraction of its largest extent. Returns false when no
 * (finite) joint influences the mesh.
 */
export function skinnedAABBFromSpheres(
  spheres: Float32Array, cr: SkinnedCullRadii, model: ArrayLike<number> | null, relPad: number,
  out: Float64Array | number[],
): boolean {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const R = cr.radii, U = cr.used, lim = Math.floor(spheres.length / 4);
  for (let u = 0; u < U.length; u++) {
    const j = U[u];
    if (j >= lim) continue;
    const x = spheres[j * 4], y = spheres[j * 4 + 1], z = spheres[j * 4 + 2], e = R[j] * spheres[j * 4 + 3];
    if (!Number.isFinite(x + y + z + e)) continue;   // a NaN joint (a spring blow-up) must not poison the box
    if (x - e < minX) minX = x - e; if (x + e > maxX) maxX = x + e;
    if (y - e < minY) minY = y - e; if (y + e > maxY) maxY = y + e;
    if (z - e < minZ) minZ = z - e; if (z + e > maxZ) maxZ = z + e;
  }
  if (minX > maxX) return false;
  if (model) {
    // Arvo: transform the box by the model matrix (column-major).
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const hx = (maxX - minX) / 2, hy = (maxY - minY) / 2, hz = (maxZ - minZ) / 2;
    const wx = model[0] * cx + model[4] * cy + model[8] * cz + model[12];
    const wy = model[1] * cx + model[5] * cy + model[9] * cz + model[13];
    const wz = model[2] * cx + model[6] * cy + model[10] * cz + model[14];
    const ex = Math.abs(model[0]) * hx + Math.abs(model[4]) * hy + Math.abs(model[8]) * hz;
    const ey = Math.abs(model[1]) * hx + Math.abs(model[5]) * hy + Math.abs(model[9]) * hz;
    const ez = Math.abs(model[2]) * hx + Math.abs(model[6]) * hy + Math.abs(model[10]) * hz;
    minX = wx - ex; maxX = wx + ex; minY = wy - ey; maxY = wy + ey; minZ = wz - ez; maxZ = wz + ez;
  }
  const pad = relPad * Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  out[0] = minX - pad; out[1] = minY - pad; out[2] = minZ - pad;
  out[3] = maxX + pad; out[4] = maxY + pad; out[5] = maxZ + pad;
  return true;
}

/** Convenience (tests / one-offs): joint spheres + box in one call. */
export function skinnedWorldAABB(
  skin: ArrayLike<number>, bindPos: Float32Array, cr: SkinnedCullRadii, model: ArrayLike<number> | null, relPad: number,
  out: Float64Array | number[],
): boolean {
  return skinnedAABBFromSpheres(computeJointSpheres(skin, bindPos), cr, model, relPad, out);
}
