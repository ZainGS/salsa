/**
 * skin-deform-metrics.ts — measure how badly a skinned mesh deforms in a pose, on the CPU (no GPU).
 *
 * Poses the skeleton (rest local positions + per-joint pose rotations), skins every vertex with the same linear-blend
 * skinning the GPU does (Σ wᵢ · world(jᵢ) · invBind(jᵢ) · v, up to 4 influences), then compares each triangle's area
 * posed vs rest. Collapsing triangles (ratio ≪ 1) are the armpit/elbow "pinch"; ballooning ones (≫ 1) are stretch.
 * Used by the character-weights tests (audit 2026-09-28 C1) to turn "the shoulders look crushed" into a number.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

export interface SkinnedMeshData {
  /** Interleaved vertices; position at `posOffset` within each `stride`-float vertex. */
  vertices: Float32Array;
  stride: number;
  posOffset?: number;
  indices: Uint32Array;
  jointIndices: Uint8Array;     // 4 per vertex
  jointWeights: Float32Array;   // 4 per vertex
  jointNames: string[];
  jointParents: Int16Array;
  jointLocalPositions: Float32Array;   // 3 per joint (rest)
  inverseBindMatrices: Float32Array;   // 16 per joint, column-major
}

export type PoseRotations = { joint: string; q: readonly [number, number, number, number] | Float32Array | number[] }[];

export interface DeformReport {
  /** Triangles considered (after the region filter). */
  tris: number;
  /** Triangles whose posed area < 50% of rest. */
  collapsed: number;
  /** Triangles whose posed area > 200% of rest. */
  stretched: number;
  /** Triangles that FOLDED over — their posed normal points against where their dominant bone rotated the rest normal
   *  (the "crushed/inside-out" look; area alone misses it, a flipped triangle can keep its area). */
  folded: number;
  /** Smallest posed/rest area ratio. */
  minRatio: number;
  /** 5th-percentile area ratio — robust "how bad is the worst region". */
  p5Ratio: number;
}

/** World matrices for every joint in `pose` (rotation about each joint's own pivot, rest translation kept). */
export function posedJointWorld(m: SkinnedMeshData, pose: PoseRotations): mat4[] {
  const rot = new Map(pose.map((p) => [p.joint, p.q]));
  const world: mat4[] = [];
  for (let j = 0; j < m.jointNames.length; j++) {
    const q = rot.get(m.jointNames[j]);
    const local = mat4.fromRotationTranslation(
      mat4.create(),
      q ? quat.fromValues(q[0], q[1], q[2], q[3]) : quat.create(),
      vec3.fromValues(m.jointLocalPositions[j * 3], m.jointLocalPositions[j * 3 + 1], m.jointLocalPositions[j * 3 + 2]),
    );
    const parent = m.jointParents[j];
    world.push(parent >= 0 ? mat4.multiply(mat4.create(), world[parent], local) : local);
  }
  return world;
}

export type SkinningMethod = 'lbs' | 'dqs';

/** Skin all vertex positions into the pose. `method`: 'lbs' = linear blend (what the GPU does today), 'dqs' = dual
 *  quaternion (volume-preserving). Returns a flat xyz array. */
export function skinPositions(m: SkinnedMeshData, pose: PoseRotations, method: SkinningMethod = 'lbs'): Float32Array {
  const world = posedJointWorld(m, pose);
  const skin = world.map((w, j) => mat4.multiply(mat4.create(), w, m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4));
  if (method === 'dqs') return skinDQS(m, skin);
  const n = m.vertices.length / m.stride;
  const po = m.posOffset ?? 0;
  const out = new Float32Array(n * 3);
  const v = vec3.create(), t = vec3.create();
  for (let i = 0; i < n; i++) {
    const base = i * m.stride + po;
    vec3.set(v, m.vertices[base], m.vertices[base + 1], m.vertices[base + 2]);
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = m.jointWeights[i * 4 + k];
      if (!w) continue;
      vec3.transformMat4(t, v, skin[m.jointIndices[i * 4 + k]]);
      x += w * t[0]; y += w * t[1]; z += w * t[2];
    }
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
  }
  return out;
}

/** Dual-quaternion skinning of the positions (rigid skin matrices only — true for this rig: rotation + translation). */
function skinDQS(m: SkinnedMeshData, skin: mat4[]): Float32Array {
  const dqs = skin.map((sk) => {
    const r = mat4.getRotation(quat.create(), sk);
    const t = mat4.getTranslation(vec3.create(), sk);
    // dual part = 0.5 · (t as pure quat) · r
    const d = quat.multiply(quat.create(), quat.fromValues(t[0], t[1], t[2], 0), r);
    return { r, d: quat.scale(d, d, 0.5) };
  });
  const n = m.vertices.length / m.stride, po = m.posOffset ?? 0;
  const out = new Float32Array(n * 3);
  const br = quat.create(), bd = quat.create(), tmp = quat.create(), conj = quat.create(), tq = quat.create();
  for (let i = 0; i < n; i++) {
    quat.set(br, 0, 0, 0, 0); quat.set(bd, 0, 0, 0, 0);
    let first: quat | null = null;
    for (let k = 0; k < 4; k++) {
      const w = m.jointWeights[i * 4 + k]; if (!w) continue;
      const dq = dqs[m.jointIndices[i * 4 + k]];
      // antipodality: keep all rotation quats in the same hemisphere as the first
      const sgn = first && quat.dot(first, dq.r) < 0 ? -w : w;
      if (!first) first = dq.r;
      quat.add(br, br, quat.scale(tmp, dq.r, sgn));
      quat.add(bd, bd, quat.scale(tmp, dq.d, sgn));
    }
    const len = quat.length(br) || 1;
    quat.scale(br, br, 1 / len); quat.scale(bd, bd, 1 / len);
    const base = i * m.stride + po;
    const v = vec3.fromValues(m.vertices[base], m.vertices[base + 1], m.vertices[base + 2]);
    vec3.transformQuat(v, v, br);
    // translation = 2 · d · conj(r)
    quat.conjugate(conj, br);
    quat.multiply(tq, bd, conj);
    out[i * 3] = v[0] + 2 * tq[0]; out[i * 3 + 1] = v[1] + 2 * tq[1]; out[i * 3 + 2] = v[2] + 2 * tq[2];
  }
  return out;
}

function triArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/** The joint with the largest weight on a vertex. */
export function dominantJoint(m: SkinnedMeshData, v: number): number {
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++) { const w = m.jointWeights[v * 4 + k]; if (w > bw) { bw = w; best = m.jointIndices[v * 4 + k]; } }
  return best;
}

/**
 * Area distortion of `pose` vs rest. `region` (joint names) limits the report to triangles with at least one vertex
 * dominated by one of those joints — e.g. ['chest','clavicle_L','shoulder_L'] for the left armpit.
 */
function triNormal(p: ArrayLike<number>, a: number, b: number, c: number): vec3 {
  const u = vec3.fromValues(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
  const v = vec3.fromValues(p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]);
  return vec3.normalize(vec3.create(), vec3.cross(vec3.create(), u, v));
}

export function measureDeformation(m: SkinnedMeshData, pose: PoseRotations, region?: string[], restRegion?: SkinnedMeshData, method: SkinningMethod = 'lbs'): DeformReport {
  const rest = skinPositions(m, [], method);
  const posed = skinPositions(m, pose, method);
  // Per-joint rotation of the pose (world × invBind, rotation part) — to predict where each rest normal should point.
  const world = posedJointWorld(m, pose);
  const rotOf = world.map((w, j) => {
    const sk = mat4.multiply(mat4.create(), w, m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4);
    return mat4.getRotation(quat.create(), sk);
  });
  let folded = 0;
  const regionMesh = restRegion ?? m;   // classify region by a FIXED weighting so before/after compare the same tris
  const want = region ? new Set(region.map((n) => regionMesh.jointNames.indexOf(n)).filter((i) => i >= 0)) : null;
  const ratios: number[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t], b = m.indices[t + 1], c = m.indices[t + 2];
    if (want && !want.has(dominantJoint(regionMesh, a)) && !want.has(dominantJoint(regionMesh, b)) && !want.has(dominantJoint(regionMesh, c))) continue;
    const r0 = triArea(rest, a, b, c);
    if (r0 < 1e-12) continue;   // degenerate at rest — no meaningful ratio
    ratios.push(triArea(posed, a, b, c) / r0);
    const expected = vec3.transformQuat(vec3.create(), triNormal(rest, a, b, c), rotOf[dominantJoint(m, a)]);
    if (vec3.dot(triNormal(posed, a, b, c), expected) < 0) folded++;
  }
  ratios.sort((x, y) => x - y);
  return {
    tris: ratios.length,
    collapsed: ratios.filter((r) => r < 0.5).length,
    stretched: ratios.filter((r) => r > 2).length,
    folded,
    minRatio: ratios.length ? ratios[0] : 1,
    p5Ratio: ratios.length ? ratios[Math.floor(ratios.length * 0.05)] : 1,
  };
}
