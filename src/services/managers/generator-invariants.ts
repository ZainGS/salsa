/**
 * generator-invariants.ts — §5.3 characterization oracle for the procedural character generators.
 *
 * The body/clothing/hair/attachment generators are pure `params → typed arrays`, so they can be checked
 * WITHOUT a GPUDevice. `validateSkinnedResult()` asserts the structural invariants every skinned generator
 * output must satisfy; a violation means the geometry would render as garbage or the skinning would explode
 * (the documented history: armpit spikes, UV bleed, verts collapsed to origin, weights that don't bind).
 *
 * Use it two ways:
 *   1. As a TEST oracle (see generator-invariants.test.ts) — call a generator, assert `.ok`.
 *   2. As a DEV guard — wrap a generator call in dev builds and console.warn on `.errors`.
 * It is deliberately allocation-light and side-effect free so it can run in either place.
 */

import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import type { GltfSkinnedResult } from '../../renderer/3d/gltf-importer';

export interface InvariantResult {
  ok: boolean;
  errors: string[];
  /** Populated stats (handy for golden tests / dev logging). */
  stats: { vertexCount: number; triangleCount: number; jointCount: number };
}

/** Max allowed deviation of a vertex's 4 blend weights from summing to 1. */
const WEIGHT_SUM_EPS = 1e-3;

/**
 * Validate a skinned generator result (body/clothing/hair/…). Returns every violation found (does not throw),
 * so a caller can log all problems at once. `label` is prefixed to each error for multi-generator test output.
 */
export function validateSkinnedResult(result: GltfSkinnedResult, label = 'skinned'): InvariantResult {
  const errors: string[] = [];
  const push = (msg: string) => errors.push(`[${label}] ${msg}`);

  const verts = result.geometry?.vertices;
  const indices = result.geometry?.indices;
  const skin = result.skinning;

  // ── Presence ──────────────────────────────────────────────────────────────
  if (!verts || verts.length === 0) push('geometry.vertices is empty');
  if (!indices || indices.length === 0) push('geometry.indices is empty');
  if (!skin) push('skinning data is missing');

  const vertexCount = verts ? Math.floor(verts.length / FLOATS_PER_VERT) : 0;
  const triangleCount = indices ? Math.floor(indices.length / 3) : 0;
  const jointCount = skin ? Math.floor(skin.inverseBindMatrices.length / 16) : 0;

  // Short-circuit the detailed checks if the mesh is structurally absent — the presence errors above say enough.
  if (!verts || !indices || !skin) {
    return { ok: errors.length === 0, errors, stats: { vertexCount, triangleCount, jointCount } };
  }

  // ── Interleave / stride ─────────────────────────────────────────────────────
  if (verts.length % FLOATS_PER_VERT !== 0) push(`vertices.length ${verts.length} is not a multiple of ${FLOATS_PER_VERT}`);
  if (indices.length % 3 !== 0) push(`indices.length ${indices.length} is not a multiple of 3`);

  // ── Skinning array sizing ────────────────────────────────────────────────────
  if (skin.jointIndices.length !== vertexCount * 4) push(`jointIndices.length ${skin.jointIndices.length} != 4×vertexCount ${vertexCount * 4}`);
  if (skin.jointWeights.length !== vertexCount * 4) push(`jointWeights.length ${skin.jointWeights.length} != 4×vertexCount ${vertexCount * 4}`);
  if (jointCount === 0) push('jointCount is 0 (no joints)');
  if (skin.jointNames.length !== jointCount) push(`jointNames.length ${skin.jointNames.length} != jointCount ${jointCount}`);
  if (skin.jointParents.length !== jointCount) push(`jointParents.length ${skin.jointParents.length} != jointCount ${jointCount}`);

  // ── Per-vertex geometry: finite, non-degenerate bounds, no collapse ──────────
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let nonFiniteGeom = 0, collapsedToOrigin = 0;
  for (let v = 0; v < vertexCount; v++) {
    const o = v * FLOATS_PER_VERT;
    const px = verts[o], py = verts[o + 1], pz = verts[o + 2];
    const nx = verts[o + 3], ny = verts[o + 4], nz = verts[o + 5];
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) ||
        !Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) nonFiniteGeom++;
    if (px === 0 && py === 0 && pz === 0) collapsedToOrigin++;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  if (nonFiniteGeom > 0) push(`${nonFiniteGeom} vertices have NaN/Inf position or normal`);
  // A healthy body/garment is never entirely at the origin; a large share there means the generator failed.
  if (vertexCount > 0 && collapsedToOrigin > vertexCount * 0.5) push(`${collapsedToOrigin}/${vertexCount} vertices collapsed to origin`);
  const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(ext > 1e-5)) push(`degenerate bounding box (max extent ${ext})`);

  // ── Per-vertex skinning: finite, non-negative, sums to 1, in-range joints ────
  let badWeightSum = 0, negWeight = 0, oobJoint = 0, nonFiniteW = 0;
  for (let v = 0; v < vertexCount; v++) {
    const o = v * 4;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = skin.jointWeights[o + k];
      const j = skin.jointIndices[o + k];
      if (!Number.isFinite(w)) { nonFiniteW++; continue; }
      if (w < 0) negWeight++;
      sum += w;
      if (w > 0 && (j < 0 || j >= jointCount)) oobJoint++;   // an index only matters if it carries weight
    }
    if (Math.abs(sum - 1) > WEIGHT_SUM_EPS) badWeightSum++;
  }
  if (nonFiniteW > 0) push(`${nonFiniteW} blend weights are NaN/Inf`);
  if (negWeight > 0) push(`${negWeight} negative blend weights`);
  if (oobJoint > 0) push(`${oobJoint} weighted joint indices out of range [0,${jointCount})`);
  if (badWeightSum > 0) push(`${badWeightSum}/${vertexCount} vertices have blend weights not summing to 1 (±${WEIGHT_SUM_EPS})`);

  // ── Index range ──────────────────────────────────────────────────────────────
  let oobIndex = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i] >= vertexCount) oobIndex++;
  if (oobIndex > 0) push(`${oobIndex} triangle indices out of range [0,${vertexCount})`);

  return { ok: errors.length === 0, errors, stats: { vertexCount, triangleCount, jointCount } };
}
