/**
 * body-v2-poses.ts — test-support: the deformation pose set (ROM poses + gait frames) and the per-region deformation /
 * self-intersection measures used by body-v2-metrics.test.ts and the contact sheets.
 */
import { BODY_POSES } from '../services/managers/body-generator';
import { ROM_POSES, skinAll, q } from '../services/managers/clothing-audit-harness';
import { measureDeformation, posedJointWorld, type SkinnedMeshData, type PoseRotations } from '../services/managers/skin-deform-metrics';
import { measureSelfIntersection } from '../services/managers/pose-preview';
import { buildLocomotionClips } from '../services/managers/default-locomotion';
import { sampleClipPose } from '../renderer/3d/skeleton-animator';
import { relaxedStance, armsPose } from '../services/managers/pose-authoring';
import { buildIdleVariantClips } from '../services/managers/default-idle-variants';
import { buildDefaultPoses } from '../services/managers/default-animations';

export const REGIONS: Record<string, string[]> = {
  shoulder: ['chest', 'clavicle_L', 'clavicle_R', 'shoulder_L', 'shoulder_R'],
  elbow: ['lowerarm_L', 'lowerarm_R'],
  hip: ['hips', 'upperleg_L', 'upperleg_R'],
  knee: ['lowerleg_L', 'lowerleg_R'],
  spine: ['lowerback', 'spine'],
};

export function gaitPose(m: SkinnedMeshData, clip: 'Walk' | 'Run', frac: number): PoseRotations {
  const joints = m.jointNames.map((name, j) => ({ name, localPosition: [m.jointLocalPositions[j * 3], m.jointLocalPositions[j * 3 + 1], m.jointLocalPositions[j * 3 + 2]] }));
  const rel = new Map(Object.entries(relaxedStance()));
  const bind = {
    rotations: m.jointNames.map((n) => [...(rel.get(n) ?? [0, 0, 0, 1])] as [number, number, number, number]),
    positions: joints.map((j) => j.localPosition as [number, number, number]),
    scales: m.jointNames.map(() => [1, 1, 1] as [number, number, number]),
  };
  const c = buildLocomotionClips(joints).find((x) => x.name === clip)!;
  const s = sampleClipPose(c, bind, c.endFrame * frac);
  return m.jointNames.map((joint, j) => ({ joint, q: s.rotations[j] }));
}

export const DEFORM_POSES: Record<string, (m: SkinnedMeshData) => PoseRotations> = {
  'relaxed': () => BODY_POSES['Relaxed'] as PoseRotations,
  'elbow 120': () => ROM_POSES['elbows: flex 120'],
  'knee 130': () => ROM_POSES['legs: knee 130'],
  'squat': () => ROM_POSES['legs: squat'],
  'sit': () => ROM_POSES['legs: sit'],
  'arms overhead': () => ROM_POSES['arms: overhead'],
  'arms forward': () => ROM_POSES['arms: forward'],
  'arms cross': () => ROM_POSES['arms: cross body'],
  'side split': () => ROM_POSES['legs: splits side'],
  'lunge': () => ROM_POSES['legs: lunge'],
  'kick forward': () => ROM_POSES['legs: kick forward'],
  'torso bend': () => ROM_POSES['torso: bend forward'],
  'torso twist': () => ROM_POSES['torso: twist'],
  'head turn+nod': () => [...(BODY_POSES['Relaxed'] as PoseRotations), { joint: 'neck', q: q('y', 35) }, { joint: 'head', q: q('x', 25) }],
  'walk 25%': (m) => gaitPose(m, 'Walk', 0.25),
  'walk 50%': (m) => gaitPose(m, 'Walk', 0.5),
  'run 25%': (m) => gaitPose(m, 'Run', 0.25),
  'run 60%': (m) => gaitPose(m, 'Run', 0.6),
};

export interface DeformRow { pose: string; region: string; tris: number; stretchPct: number; collapsePct: number; foldPct: number; folded: number }
export function deformTable(m: SkinnedMeshData): DeformRow[] {
  const rows: DeformRow[] = [];
  for (const [pn, f] of Object.entries(DEFORM_POSES)) {
    const pose = f(m);
    for (const [rn, joints] of Object.entries(REGIONS)) {
      const d = measureDeformation(m, pose, joints, undefined, 'dqs');
      rows.push({ pose: pn, region: rn, tris: d.tris, stretchPct: (100 * d.stretched) / d.tris, collapsePct: (100 * d.collapsed) / d.tris, foldPct: (100 * d.folded) / d.tris, folded: d.folded });
    }
  }
  return rows;
}
export function selfIntersect(m: SkinnedMeshData): Record<string, number> {
  const out: Record<string, number> = {};
  const rest = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, [], 'dualQuat');
  for (const [pn, f] of Object.entries(DEFORM_POSES)) {
    const posed = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, f(m), 'dualQuat');
    out[pn] = measureSelfIntersection(m, rest.P, posed.P, posed.N).verts.size;
  }
  return out;
}


/** Measured proportions of a posed body (Relaxed by default), comparable to the reference image estimates:
 *  heads tall (sole → crown / chin → crown), crotch height / height, shoulder (deltoid) breadth, hip and waist widths.
 *  Arm / hand vertices are excluded from the hip / waist widths (the hands hang by the hips). */
export function proportions(m: SkinnedMeshData, pose: PoseRotations = BODY_POSES['Relaxed'] as PoseRotations) {
  const { P } = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
  const n = P.length / 3, names = m.jointNames;
  const dom = (i: number) => { let b = 0, bw = -1; for (let k = 0; k < 4; k++) if (m.jointWeights[i * 4 + k] > bw) { bw = m.jointWeights[i * 4 + k]; b = m.jointIndices[i * 4 + k]; } return names[b]; };
  let lo = Infinity, hi = -Infinity, chin = Infinity, crotch = -Infinity;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, P[i * 3 + 1]); hi = Math.max(hi, P[i * 3 + 1]); }
  const D = Array.from({ length: n }, (_, i) => dom(i));
  for (let i = 0; i < n; i++) if (D[i] === 'head') chin = Math.min(chin, P[i * 3 + 1]);
  // crotch: the highest point of the gap between the legs = the lowest torso (hips) vertex near the midline
  let crotchLo = Infinity;
  for (let i = 0; i < n; i++) if (D[i] === 'hips' && Math.abs(P[i * 3]) < 0.012) crotchLo = Math.min(crotchLo, P[i * 3 + 1]);
  crotch = crotchLo;
  const H = hi - lo, head = hi - chin;
  const jw = (nm: string) => { const j = names.indexOf(nm); let y = 0; for (let k = j; k >= 0; k = m.jointParents[k]) y += m.jointLocalPositions[k * 3 + 1]; return y; };
  const ySh = jw('shoulder_L'), yH = jw('hips'), yC = jw('chest');
  const isArm = (d: string) => /^(shoulder|lowerarm|hand)_/.test(d);
  const widthIn = (y0: number, y1: number, skipArms: boolean) => {
    let xl = -Infinity, xr = Infinity;
    for (let i = 0; i < n; i++) { const y = P[i * 3 + 1]; if (y < y0 || y > y1 || (skipArms && isArm(D[i]))) continue; xl = Math.max(xl, P[i * 3]); xr = Math.min(xr, P[i * 3]); }
    return xl === -Infinity ? Infinity : xl - xr;   // an empty band never wins the min
  };
  const shoulder = widthIn(ySh - 0.07, ySh + 0.06, false);
  const hip = widthIn(yH - 0.12, yH + 0.01, true);
  let waist = Infinity;
  for (let k = 0; k <= 20; k++) { const y = yH + (yC - yH) * (0.2 + 0.6 * k / 20); waist = Math.min(waist, widthIn(y - 0.015, y + 0.015, true)); }
  // head width (skull, at the widest head row)
  let hx0 = Infinity, hx1 = -Infinity;
  for (let i = 0; i < n; i++) if (D[i] === 'head') { hx0 = Math.min(hx0, P[i * 3]); hx1 = Math.max(hx1, P[i * 3]); }
  return { height: H, headsTall: H / head, crotchRatio: (crotch - lo) / H, shoulderW: shoulder / H, hipW: hip / H, waistW: waist / H,
    shoulderToHip: shoulder / hip, shoulderHeads: shoulder / (hx1 - hx0) };
}

// ══ body-v2@2 review fixes — G2: skin-weight / deformation measures that SEE the fold classes the area / dominant-bone
// fold test above cannot (docs/specs/character-v2.md "body-v2@2 review fixes — G2"; review weights#6, deformation#5,
// topology#9). Everything skins with skinAll 'dualQuat' (the GPU path) and reads only the mesh, so the same code
// measures v1, any v2 generator copy and the baked asset.
//   • inverted — posed face normal · Σ its corners' skinned vertex normals < 0 (what the GPU shades with), counted only
//     where it is ≥ 0 at rest: a strip that rides its own bone while folding into another surface (the chin into the
//     throat) is caught; a smoothly blended deltoid is not a false positive (the dominant-bone test's 26 of 48);
//   • crease — welded edges whose two faces were within 45° at rest and > 100° apart posed (a crumple), count + rest
//     length (rig cm, so a denser mesh is not penalised);
//   • aniso — the triangle's in-plane deformation σmax / σmin (twist SHEAR: no area change, no flip, but a painted
//     stripe kinks — the neck turn, the forearm roll);
//   • buried — region vertices whose point 1.5 mm out along the skinned normal lies INSIDE the posed body (3-ray
//     parity, majority): skin passing through skin (the jaw into the throat; the calf into the thigh).

type V3n = [number, number, number];
interface Prep {
  rest: { P: Float32Array; N: Float32Array };
  dom: Int32Array;
  /** welded edges with exactly two faces: [triA, triB, restLength] */
  edges: [number, number, number][];
}
const PREP = new WeakMap<Float32Array, Prep>();
export function prepMesh(m: SkinnedMeshData): Prep {
  const hit = PREP.get(m.vertices); if (hit) return hit;
  const rest = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, [], 'dualQuat');
  const n = m.vertices.length / m.stride, dom = new Int32Array(n);
  for (let i = 0; i < n; i++) { let b = 0, bw = -1; for (let k = 0; k < 4; k++) if (m.jointWeights[i * 4 + k] > bw) { bw = m.jointWeights[i * 4 + k]; b = m.jointIndices[i * 4 + k]; } dom[i] = b; }
  const id = new Map<string, number>(), w = new Int32Array(n);
  for (let i = 0; i < n; i++) { const k = `${rest.P[i * 3]},${rest.P[i * 3 + 1]},${rest.P[i * 3 + 2]}`; let x = id.get(k); if (x === undefined) { x = id.size; id.set(k, x); } w[i] = x; }
  const em = new Map<number, number[]>();
  const I = m.indices;
  for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = w[I[t + k]], b = w[I[t + (k + 1) % 3]]; if (a === b) continue;
    const key = a < b ? a * 1e6 + b : b * 1e6 + a;
    let e = em.get(key); if (!e) { e = []; em.set(key, e); } e.push(t / 3, I[t + k], I[t + (k + 1) % 3]);
  }
  const edges: [number, number, number][] = [];
  for (const e of em.values()) if (e.length === 6) {
    const a = e[1], b = e[2];
    edges.push([e[0], e[3], Math.hypot(rest.P[a * 3] - rest.P[b * 3], rest.P[a * 3 + 1] - rest.P[b * 3 + 1], rest.P[a * 3 + 2] - rest.P[b * 3 + 2])]);
  }
  const p: Prep = { rest, dom, edges };
  PREP.set(m.vertices, p);
  return p;
}
const faceN = (P: ArrayLike<number>, a: number, b: number, c: number): V3n => {
  const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
function triAreaOf(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}
/** In-plane deformation σmax / σmin of triangle (a, b, c) from rest R to posed P (Infinity for a degenerate one). */
function triAniso(R: ArrayLike<number>, P: ArrayLike<number>, a: number, b: number, c: number): number {
  const e1 = [R[b * 3] - R[a * 3], R[b * 3 + 1] - R[a * 3 + 1], R[b * 3 + 2] - R[a * 3 + 2]], e2 = [R[c * 3] - R[a * 3], R[c * 3 + 1] - R[a * 3 + 1], R[c * 3 + 2] - R[a * 3 + 2]];
  const l1 = Math.hypot(e1[0], e1[1], e1[2]); if (l1 < 1e-12) return Infinity;
  const t1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1], d = e2[0] * t1[0] + e2[1] * t1[1] + e2[2] * t1[2];
  const o = [e2[0] - d * t1[0], e2[1] - d * t1[1], e2[2] - d * t1[2]], h = Math.hypot(o[0], o[1], o[2]); if (h < 1e-12) return Infinity;
  // rest 2D: e1 = (l1, 0), e2 = (d, h); F = [p1 p2] · E⁻¹
  const p1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]], p2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
  const f1 = p1.map((x) => x / l1), f2 = p2.map((x, k) => (x - (d / l1) * p1[k]) / h);
  const A = f1[0] * f1[0] + f1[1] * f1[1] + f1[2] * f1[2], B = f1[0] * f2[0] + f1[1] * f2[1] + f1[2] * f2[2], C = f2[0] * f2[0] + f2[1] * f2[1] + f2[2] * f2[2];
  const tr = A + C, disc = Math.sqrt(Math.max(0, (A - C) * (A - C) + 4 * B * B));
  const s1 = Math.sqrt(Math.max(0, (tr + disc) / 2)), s2 = Math.sqrt(Math.max(0, (tr - disc) / 2));
  return s2 < 1e-12 ? Infinity : s1 / s2;
}

export interface SkinRow {
  tris: number; stretched: number; collapsed: number; inverted: number;
  creaseN: number; creaseCm: number;
  /** the worst in-plane σmax/σmin; triangles above 2 and above 3 */
  maxAniso: number; aniso2: number; aniso3: number;
  minRatio: number; maxRatio: number;
}
/** Per-region skin measures of `pose` (regions: joint lists; a triangle belongs to a region if any corner is dominated
 *  by one of its joints — the same membership as measureDeformation). */
export function skinMetrics(m: SkinnedMeshData, pose: PoseRotations, regions: Record<string, string[]>, posed?: { P: Float32Array; N: Float32Array }): Record<string, SkinRow> {
  const pr = prepMesh(m), R = pr.rest.P, RN = pr.rest.N;
  const { P, N } = posed ?? skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
  const I = m.indices, nt = I.length / 3;
  const out: Record<string, SkinRow> = {};
  for (const [rn, joints] of Object.entries(regions)) {
    const want = new Set(joints.map((j) => m.jointNames.indexOf(j)).filter((j) => j >= 0));
    const inR = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) if (want.has(pr.dom[I[t * 3]]) || want.has(pr.dom[I[t * 3 + 1]]) || want.has(pr.dom[I[t * 3 + 2]])) inR[t] = 1;
    const row: SkinRow = { tris: 0, stretched: 0, collapsed: 0, inverted: 0, creaseN: 0, creaseCm: 0, maxAniso: 1, aniso2: 0, aniso3: 0, minRatio: Infinity, maxRatio: 0 };
    for (let t = 0; t < nt; t++) {
      if (!inR[t]) continue;
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      const ar0 = triAreaOf(R, a, b, c); if (ar0 < 1e-12) continue;
      const n0 = faceN(R, a, b, c), n1 = faceN(P, a, b, c);
      row.tris++;
      const ratio = triAreaOf(P, a, b, c) / ar0;
      if (ratio > 2) row.stretched++;
      if (ratio < 0.5) row.collapsed++;
      row.minRatio = Math.min(row.minRatio, ratio); row.maxRatio = Math.max(row.maxRatio, ratio);
      const s0 = n0[0] * (RN[a * 3] + RN[b * 3] + RN[c * 3]) + n0[1] * (RN[a * 3 + 1] + RN[b * 3 + 1] + RN[c * 3 + 1]) + n0[2] * (RN[a * 3 + 2] + RN[b * 3 + 2] + RN[c * 3 + 2]);
      const s1 = n1[0] * (N[a * 3] + N[b * 3] + N[c * 3]) + n1[1] * (N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1]) + n1[2] * (N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]);
      if (s1 < 0 && s0 >= 0) row.inverted++;
      const an = triAniso(R, P, a, b, c);
      if (Number.isFinite(an)) { row.maxAniso = Math.max(row.maxAniso, an); if (an > 2) row.aniso2++; if (an > 3) row.aniso3++; }
    }
    for (const [ta, tb, el] of pr.edges) {
      if (!inR[ta] && !inR[tb]) continue;
      const ra = faceN(R, I[ta * 3], I[ta * 3 + 1], I[ta * 3 + 2]), rb = faceN(R, I[tb * 3], I[tb * 3 + 1], I[tb * 3 + 2]);
      if (ra[0] * rb[0] + ra[1] * rb[1] + ra[2] * rb[2] < Math.cos(Math.PI / 4)) continue;
      const pa = faceN(P, I[ta * 3], I[ta * 3 + 1], I[ta * 3 + 2]), pb = faceN(P, I[tb * 3], I[tb * 3 + 1], I[tb * 3 + 2]);
      if (pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2] < Math.cos((100 * Math.PI) / 180)) { row.creaseN++; row.creaseCm += el * 100; }
    }
    if (!Number.isFinite(row.minRatio)) row.minRatio = 1;
    out[rn] = row;
  }
  return out;
}

/** Region vertices (dominated by `joints`) whose point `offset` out along the skinned normal is inside the posed body
 *  (3-ray parity, majority vote). 0 at rest on v1 and v2. */
export function buriedVerts(m: SkinnedMeshData, P: Float32Array, N: Float32Array, joints: string[], offset = 0.0015): number[] {
  const pr = prepMesh(m), want = new Set(joints.map((j) => m.jointNames.indexOf(j)).filter((j) => j >= 0));
  const I = m.indices, nt = I.length / 3;
  const dirs: V3n[] = ([[0.5773, 0.5774, 0.5774], [-0.6402, 0.2132, 0.7383], [0.1733, -0.9127, 0.3701]] as V3n[]).map((d) => { const l = Math.hypot(d[0], d[1], d[2]); return [d[0] / l, d[1] / l, d[2] / l] as V3n; });
  const out: number[] = [];
  const n = P.length / 3;
  for (let i = 0; i < n; i++) {
    if (!want.has(pr.dom[i])) continue;
    const ox = P[i * 3] + N[i * 3] * offset, oy = P[i * 3 + 1] + N[i * 3 + 1] * offset, oz = P[i * 3 + 2] + N[i * 3 + 2] * offset;
    let inside = 0;
    for (const d of dirs) {
      let hits = 0;
      for (let t = 0; t < nt; t++) {
        const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
        // Möller–Trumbore
        const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
        const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-14) continue;
        const inv = 1 / det, tx = ox - P[a * 3], ty = oy - P[a * 3 + 1], tz = oz - P[a * 3 + 2];
        const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) continue;
        if ((e2x * qx + e2y * qy + e2z * qz) * inv > 1e-9) hits++;
      }
      if (hits & 1) inside++;
    }
    if (inside >= 2) out.push(i);
  }
  return out;
}

/** The vertex twin across the x = 0 mirror plane (by rest position; −1 = none). */
export function mirrorTwins(m: SkinnedMeshData): Int32Array {
  const n = m.vertices.length / m.stride, key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const at = new Map<string, number>();
  for (let i = 0; i < n; i++) { const o = i * m.stride; const k = key(m.vertices[o], m.vertices[o + 1], m.vertices[o + 2]); if (!at.has(k)) at.set(k, i); }
  const tw = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) { const o = i * m.stride; const j = at.get(key(-m.vertices[o], m.vertices[o + 1], m.vertices[o + 2])); if (j !== undefined) tw[i] = j; }
  return tw;
}
/** Largest |w − swapLR(w_twin)| over every twinned vertex (the emitted top-4 weights), the count above 1e-3, and the
 *  twin-less count. */
export function weightAsymmetry(m: SkinnedMeshData): { max: number; over1e3: number; missing: number } {
  const tw = mirrorTwins(m), n = tw.length, names = m.jointNames;
  const swap = names.map((nm) => names.indexOf(nm.endsWith('_L') ? nm.slice(0, -2) + '_R' : nm.endsWith('_R') ? nm.slice(0, -2) + '_L' : nm));
  let max = 0, over = 0, missing = 0;
  for (let i = 0; i < n; i++) {
    const j = tw[i]; if (j < 0) { missing++; continue; }
    const a = new Map<number, number>(), b = new Map<number, number>();
    for (let k = 0; k < 4; k++) {
      const ja = m.jointIndices[i * 4 + k], jb = swap[m.jointIndices[j * 4 + k]];
      a.set(ja, (a.get(ja) ?? 0) + m.jointWeights[i * 4 + k]); b.set(jb, (b.get(jb) ?? 0) + m.jointWeights[j * 4 + k]);
    }
    let d = 0; for (const jj of new Set([...a.keys(), ...b.keys()])) d = Math.max(d, Math.abs((a.get(jj) ?? 0) - (b.get(jj) ?? 0)));
    max = Math.max(max, d); if (d > 1e-3) over++;
  }
  return { max, over1e3: over, missing };
}
/** Largest posed distance between a vertex and its mirrored twin's mirror image, in a pose that is itself L/R
 *  symmetric (rig units). */
export function posedTwinDeviation(m: SkinnedMeshData, pose: PoseRotations): number {
  const tw = mirrorTwins(m), { P } = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
  let max = 0;
  for (let i = 0; i < tw.length; i++) { const j = tw[i]; if (j < 0) continue; max = Math.max(max, Math.hypot(P[i * 3] + P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2])); }
  return max;
}

/** The knee (left leg, from the generator's legSurface rings): the largest posed / rest distance of a knee-band vertex
 *  to its nearest bone segment (a bulge), and the medial vs lateral (y, z) displacement gap at the t 0.90 / 1.07 rings
 *  (a twisted crease when the hinge field is rotated: review topology#2). */
export function kneeMetrics(m: SkinnedMeshData, legL: { verts: { p: [number, number, number] }[] }[], pose: PoseRotations): { radialMax: number; mlGap: number } {
  const n = m.vertices.length / m.stride, key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const at = new Map<string, number>();
  for (let i = 0; i < n; i++) { const o = i * m.stride; const k = key(m.vertices[o], m.vertices[o + 1], m.vertices[o + 2]); if (!at.has(k)) at.set(k, i); }
  const idOf = (p: [number, number, number]) => at.get(key(p[0], p[1], p[2])) ?? -1;
  const { P } = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
  const W0 = posedJointWorld(m, []), W1 = posedJointWorld(m, pose);
  const J = (W: ReturnType<typeof posedJointWorld>, nm: string): V3n => { const w = W[m.jointNames.indexOf(nm)]; return [w[12], w[13], w[14]]; };
  const segD = (p: V3n, a: V3n, b: V3n) => { const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]; const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2))); return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]); };
  const bone = (W: ReturnType<typeof posedJointWorld>, p: V3n) => Math.min(segD(p, J(W, 'upperleg_L'), J(W, 'lowerleg_L')), segD(p, J(W, 'lowerleg_L'), J(W, 'foot_L')));
  // legSurface ring 0 = the thigh top; ring 1 + i = LEG_RINGS[i] → t 0.79 … 1.20 = rings 6 … 10, 0.90 = 7, 1.07 = 9
  let radialMax = 0;
  for (let r = 6; r <= 10 && r < legL.length; r++) for (const v of legL[r].verts) {
    const i = idOf(v.p); if (i < 0) continue;
    const d0 = bone(W0, v.p), d1 = bone(W1, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    if (d0 > 1e-6) radialMax = Math.max(radialMax, d1 / d0);
  }
  // the (y, z) displacement of the ring at exactly the outer (+X) vs the inner (−X) side, interpolated around the ring
  // between the two nearest slots (the 16 slots are not placed symmetrically about the sagittal plane)
  const ll = J(W0, 'lowerleg_L');
  let mlGap = 0;
  for (const r of [7, 9]) {
    if (r >= legL.length) continue;
    const vs = legL[r].verts, ids = vs.map((v) => idOf(v.p)); if (ids.some((i) => i < 0)) continue;
    const ang = vs.map((v) => Math.atan2(v.p[0] - ll[0], -(v.p[2] - ll[2])));
    const dispAt = (target: number): [number, number] => {
      for (let k = 0; k < vs.length; k++) {
        const k2 = (k + 1) % vs.length, a0 = ang[k], a1 = ang[k2];
        let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da <= -Math.PI) da += 2 * Math.PI;
        let dt = target - a0; while (dt > Math.PI) dt -= 2 * Math.PI; while (dt <= -Math.PI) dt += 2 * Math.PI;
        const f = dt / da; if (f < 0 || f > 1) continue;
        const i0 = ids[k], i1 = ids[k2];
        const y = (1 - f) * (P[i0 * 3 + 1] - vs[k].p[1]) + f * (P[i1 * 3 + 1] - vs[k2].p[1]);
        const z = (1 - f) * (P[i0 * 3 + 2] - vs[k].p[2]) + f * (P[i1 * 3 + 2] - vs[k2].p[2]);
        return [y, z];
      }
      return [0, 0];
    };
    const o = dispAt(Math.PI / 2), i = dispAt(-Math.PI / 2);
    mlGap = Math.max(mlGap, Math.hypot(o[0] - i[0], o[1] - i[1]));
  }
  return { radialMax, mlGap };
}

/** How far the PARENT segment's skin moves when only the child joint rotates (the shin under an ankle flex, the forearm
 *  under a wrist flex): the largest displacement of any vertex within 8 cm of the parent bone that sits more than
 *  `minDist` up the bone from the `child` joint (measured ALONG the bone, so the joint ring itself is excluded), rig
 *  units. `pose` must rotate only the child (and below). */
export function parentDrift(m: SkinnedMeshData, pose: PoseRotations, parent: string, child: string, minDist = 0.03): number {
  return parentDriftImpl(m, pose, parent, child, minDist);
}

/** How far each listed limb RING's posed centre sits off its posed bone line (`from` → `to` joints), rig units: a
 *  limb whose weights lag along its length bends like rubber (the arm raised 150° with the shoulder smoothed far down
 *  the arm: the mid upper arm 5–6 cm off the humerus). `rings` = surface rings (generator armSurface / legSurface). */
export function ringOffBone(m: SkinnedMeshData, rings: { verts: { p: [number, number, number] }[] }[], ringIdx: number[], pose: PoseRotations, from: string, to: string): number[] {
  const n = m.vertices.length / m.stride, key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const at = new Map<string, number>();
  for (let i = 0; i < n; i++) { const o = i * m.stride; const k = key(m.vertices[o], m.vertices[o + 1], m.vertices[o + 2]); if (!at.has(k)) at.set(k, i); }
  const off = (ps: PoseRotations): number[] => {
    const { P } = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, ps, 'dualQuat'), W = posedJointWorld(m, ps);
    const a = W[m.jointNames.indexOf(from)], b = W[m.jointNames.indexOf(to)];
    const A: V3n = [a[12], a[13], a[14]], d: V3n = [b[12] - a[12], b[13] - a[13], b[14] - a[14]], L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    return ringIdx.map((ri) => {
      const c = [0, 0, 0]; let k = 0;
      for (const v of rings[ri].verts) { const i = at.get(key(v.p[0], v.p[1], v.p[2])); if (i === undefined) continue; c[0] += P[i * 3]; c[1] += P[i * 3 + 1]; c[2] += P[i * 3 + 2]; k++; }
      const ap = [c[0] / k - A[0], c[1] / k - A[1], c[2] / k - A[2]], t = (ap[0] * d[0] + ap[1] * d[1] + ap[2] * d[2]) / L2;
      return Math.hypot(ap[0] - t * d[0], ap[1] - t * d[1], ap[2] - t * d[2]);
    });
  };
  // posed minus rest (the shoulder-cap rings sit off the axis by design at rest)
  const r0 = off([]), r1 = off(pose);
  return r1.map((x, i) => Math.abs(x - r0[i]));
}

/** The worst KINK a pose adds along a limb's surface columns: for each of the rings' slots, the polyline through the
 *  slot's vertex on rings `from` … `to`, the largest increase (posed − rest) of the turning angle between consecutive
 *  segments, degrees. A weight transition that ends abruptly along the limb (the shoulder cap lagging, the rigid arm
 *  below it) shows as a notch in the silhouette that area / fold / σ measures all read as clean. */
export function columnKink(m: SkinnedMeshData, rings: { verts: { p: [number, number, number] }[] }[], from: number, to: number, pose: PoseRotations): { deg: number; ring: number; slot: number } {
  const n = m.vertices.length / m.stride, key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const at = new Map<string, number>();
  for (let i = 0; i < n; i++) { const o = i * m.stride; const k = key(m.vertices[o], m.vertices[o + 1], m.vertices[o + 2]); if (!at.has(k)) at.set(k, i); }
  const { P } = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
  const turn = (a: number[], b: number[], c: number[]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / ((Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2])) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
  };
  let best = { deg: 0, ring: -1, slot: -1 };
  const slots = rings[from].verts.length;
  for (let k = 0; k < slots; k++) {
    const ids = [] as number[];
    for (let r = from; r <= to; r++) ids.push(at.get(key(...rings[r].verts[k].p)) ?? -1);
    if (ids.some((i) => i < 0)) continue;
    const R = ids.map((i) => [m.vertices[i * m.stride], m.vertices[i * m.stride + 1], m.vertices[i * m.stride + 2]]), Q = ids.map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    for (let j = 1; j + 1 < ids.length; j++) {
      const d = turn(Q[j - 1], Q[j], Q[j + 1]) - turn(R[j - 1], R[j], R[j + 1]);
      if (d > best.deg) best = { deg: d, ring: from + j, slot: k };
    }
  }
  return best;
}

function parentDriftImpl(m: SkinnedMeshData, pose: PoseRotations, parent: string, child: string, minDist: number): number {
  const { P } = skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
  const W0 = posedJointWorld(m, []), jp = m.jointNames.indexOf(parent), jc = m.jointNames.indexOf(child);
  const a: V3n = [W0[jp][12], W0[jp][13], W0[jp][14]], c: V3n = [W0[jc][12], W0[jc][13], W0[jc][14]];
  const L = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), d: V3n = [(c[0] - a[0]) / L, (c[1] - a[1]) / L, (c[2] - a[2]) / L];
  const V = m.vertices, st = m.stride;
  let max = 0;
  for (let i = 0; i < V.length / st; i++) {
    const rx = V[i * st] - c[0], ry = V[i * st + 1] - c[1], rz = V[i * st + 2] - c[2];
    const s = rx * d[0] + ry * d[1] + rz * d[2];   // < 0 = up the parent
    if (s > -minDist || s < -L) continue;
    if (Math.hypot(rx - s * d[0], ry - s * d[1], rz - s * d[2]) > 0.08) continue;
    max = Math.max(max, Math.hypot(P[i * 3] - V[i * st], P[i * 3 + 1] - V[i * st + 1], P[i * 3 + 2] - V[i * st + 2]));
  }
  return max;
}

/** The regions of the G2 gates: the five above plus the neck (neck + head: the chin / throat / nape), the wrist
 *  (hand) and the ankle (foot). The clavicles are in `shoulder` (no vertex is clavicle-dominated). */
export const REVIEW_REGIONS: Record<string, string[]> = {
  ...REGIONS,
  neck: ['neck', 'head'],
  wrist: ['hand_L', 'hand_R'],
  ankle: ['foot_L', 'foot_R'],
};
const relaxedPose = (): PoseRotations => BODY_POSES['Relaxed'] as PoseRotations;
/** `extra` over Relaxed (the extra joints replace Relaxed's). */
const over = (extra: Record<string, readonly number[]>): PoseRotations => {
  const base = relaxedPose().filter((r) => !(r.joint in extra));
  return [...base, ...Object.entries(extra).map(([joint, qq]) => ({ joint, q: qq as [number, number, number, number] }))];
};
function clipFrame(m: SkinnedMeshData, clipName: string, frame: number): PoseRotations {
  const joints = m.jointNames.map((name, j) => ({ name, localPosition: [m.jointLocalPositions[j * 3], m.jointLocalPositions[j * 3 + 1], m.jointLocalPositions[j * 3 + 2]] }));
  const rel = new Map(Object.entries(relaxedStance()));
  const bind = {
    rotations: m.jointNames.map((n) => [...(rel.get(n) ?? [0, 0, 0, 1])] as [number, number, number, number]),
    positions: joints.map((j) => j.localPosition as [number, number, number]),
    scales: m.jointNames.map(() => [1, 1, 1] as [number, number, number]),
  };
  const c = [...buildLocomotionClips(joints), ...buildIdleVariantClips(joints)].find((x) => x.name === clipName);
  if (!c) throw new Error(`no clip ${clipName}`);
  const s = sampleClipPose(c, bind, frame);
  return m.jointNames.map((joint, j) => ({ joint, q: s.rotations[j] }));
}

/**
 * The G2 pose set (review weights#6 / deformation#5 / topology#9): what the 18 DEFORM_POSES never reach — head-only
 * nods / tilts / turns and look-ups (the head joint is what Play, the look-at and VRM drive), forward flexion past
 * horizontal (the default Idle Stretch / Jump Reach go there), the clavicle shrug, wrist + forearm rolls and wrist
 * flexion, off-hinge elbows, deep knees (150°, seiza, kneeling) and the ankle. Joint conventions: head / neck x+ =
 * nod down, y = turn, z = tilt; arm L forward = y−, raise = z+; elbow L flex = y−; hand roll = x; knee bend = x+;
 * foot x+ = plantarflex (toes down).
 */
export const REVIEW_POSES: Record<string, (m: SkinnedMeshData) => PoseRotations> = {
  // neck → head
  'head down 20': () => over({ head: q('x', 20) }),
  'head down 35': () => over({ head: q('x', 35) }),
  'phone nod': () => over({ neck: q('x', 6), head: q('x', 18) }),
  'nod n15+h20': () => over({ neck: q('x', 15), head: q('x', 20) }),
  'nod n15+h35': () => over({ neck: q('x', 15), head: q('x', 35) }),
  'head up 30': () => over({ head: q('x', -30) }),
  'look up n15+h35': () => over({ neck: q('x', -15), head: q('x', -35) }),
  'head tilt 30': () => over({ head: q('z', 30) }),
  'head yaw 35': () => over({ head: q('y', 35) }),
  'head yaw 60': () => over({ head: q('y', 60) }),
  'turn n40+h35': () => over({ neck: q('y', 40), head: q('y', 35) }),
  // shoulders: forward flexion, the shrug, the default clips that reach overhead
  'arm fwd-up 90': () => over({ ...armsPose({ raise: 0, fwd: 90 }) }),
  'arm fwd-up 120': () => over({ ...armsPose({ raise: 0, fwd: 120 }) }),
  'arm fwd-up 150': () => over({ ...armsPose({ raise: 0, fwd: 150 }) }),
  'overhead + shrug 25': () => [...ROM_POSES['arms: overhead'], { joint: 'clavicle_L', q: q('z', 25) }, { joint: 'clavicle_R', q: q('z', -25) }],
  'Idle Stretch f40': (m) => clipFrame(m, 'Idle Stretch', 40),
  'Jump Reach f12': (m) => clipFrame(m, 'Jump Reach', 12),
  // elbow off the hinge (diagnostic: an axis-agnostic bend; the hinge convention is local −Y for the left arm)
  'elbow 95 about -Z': () => over({ lowerarm_L: q('z', -95), lowerarm_R: q('z', 95) }),
  // the shipped Hands on Hips capture (default-animations: its lowerarm bends ~87° about −Z, off the hinge — review
  // deformation#3; a content fix, measured here so the body's off-axis behaviour is on record)
  'Hands on Hips': (m) => { const def = buildDefaultPoses(m.jointNames.map((name) => ({ name }))).find((x) => x.name === 'Hands on Hips')!; return def.rotations.map((r) => ({ joint: m.jointNames[r.jointIndex], q: r.rotation })); },
  // wrist / forearm
  'wrist flex 70': () => [{ joint: 'hand_L', q: q('z', -70) }, { joint: 'hand_R', q: q('z', 70) }],
  'wrist ext 60': () => [{ joint: 'hand_L', q: q('z', 60) }, { joint: 'hand_R', q: q('z', -60) }],
  'wrist dev 30': () => [{ joint: 'hand_L', q: q('y', 30) }, { joint: 'hand_R', q: q('y', -30) }],
  'hand roll 90': () => [{ joint: 'hand_L', q: q('x', 90) }, { joint: 'hand_R', q: q('x', 90) }],
  'hand roll -90': () => [{ joint: 'hand_L', q: q('x', -90) }, { joint: 'hand_R', q: q('x', -90) }],
  'forearm roll 90': () => [{ joint: 'lowerarm_L', q: q('x', 90) }, { joint: 'lowerarm_R', q: q('x', 90) }],
  'elbow 90 + hand roll 90': () => [{ joint: 'lowerarm_L', q: q('y', -90) }, { joint: 'lowerarm_R', q: q('y', 90) }, { joint: 'hand_L', q: q('x', 90) }, { joint: 'hand_R', q: q('x', 90) }],
  // knees + ankles
  'knee 90': () => over({ lowerleg_L: q('x', 90) }),
  'knee 150': () => over({ lowerleg_L: q('x', 150) }),
  'seiza': () => over({ upperleg_L: q('x', -80), upperleg_R: q('x', -80), lowerleg_L: q('x', 158), lowerleg_R: q('x', 158), foot_L: q('x', 45), foot_R: q('x', 45) }),
  'kneel': () => over({ upperleg_L: q('x', -5), upperleg_R: q('x', -5), lowerleg_L: q('x', 95), lowerleg_R: q('x', 95), foot_L: q('x', 50), foot_R: q('x', 50) }),
  'ankle plantar 40': () => over({ foot_L: q('x', 40), foot_R: q('x', 40) }),
  'ankle dorsi 25': () => over({ foot_L: q('x', -25), foot_R: q('x', -25) }),
};
