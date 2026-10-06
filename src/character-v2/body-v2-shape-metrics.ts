/**
 * body-v2-shape-metrics.ts — test-support: GEOMETRY / PROPORTION measures of a v2 body (the body-v2@2 review fixes,
 * docs/specs/character-v2.md "body-v2@2 review fixes — G1"). Pure, node-only, no generator dependency (every measure
 * takes the mesh), so the same code measures the generator, the baked asset and a baseline copy.
 *
 *   • legSections     — horizontal plane sections of the legs: L∩R overlap AREA (scanline) + the L–R gap per plane;
 *   • frontContour / hipDent — the front-view outer contour from the waist to the knee (no interior dip = no notch);
 *   • sideProfileTurn — the bust's side silhouette (max z per torso ring): the turning angle per ring;
 *   • torsoSpacing    — the smallest ring-to-ring gap at any torso column;
 *   • shoulderSlope   — the front top silhouette from the neck base to the acromion;
 *   • reach           — wrist / fingertip vs the crotch (Relaxed and arms straight down), hand + foot sizes;
 *   • mirrorMisses    — vertices without an x-mirrored twin (with the L↔R joint swap);
 *   • uvIslands       — per UV island: mirrored share, image-down · body-down, anisotropy.
 * Units: rig units (1 = 1 m at height 1); ratios are of the stature H (sole → crown).
 */
import { skinAll } from '../services/managers/clothing-audit-harness';
import { posedJointWorld, type SkinnedMeshData, type PoseRotations } from '../services/managers/skin-deform-metrics';

type V3 = [number, number, number];

/** Σ weights on *_L joints minus Σ on *_R joints, per vertex. */
export function sideWeights(m: SkinnedMeshData): Float32Array {
  const n = m.jointWeights.length / 4, out = new Float32Array(n);
  const sgn = m.jointNames.map((nm) => (nm.endsWith('_L') ? 1 : nm.endsWith('_R') ? -1 : 0));
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 4; k++) s += sgn[m.jointIndices[i * 4 + k]] * m.jointWeights[i * 4 + k]; out[i] = s; }
  return out;
}
/** Dominant joint name per vertex. */
export function dominantNames(m: SkinnedMeshData): string[] {
  const n = m.jointWeights.length / 4, out: string[] = [];
  for (let i = 0; i < n; i++) {
    let b = 0, bw = -1;
    for (let k = 0; k < 4; k++) if (m.jointWeights[i * 4 + k] > bw) { bw = m.jointWeights[i * 4 + k]; b = m.jointIndices[i * 4 + k]; }
    out.push(m.jointNames[b]);
  }
  return out;
}
export const posedP = (m: SkinnedMeshData, pose: PoseRotations): { P: Float32Array; N: Float32Array } =>
  skinAll(m, m.vertices, m.jointIndices, m.jointWeights, pose, 'dualQuat');
export function restP(m: SkinnedMeshData): Float32Array {
  const n = m.vertices.length / 12, P = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { P[i * 3] = m.vertices[i * 12]; P[i * 3 + 1] = m.vertices[i * 12 + 1]; P[i * 3 + 2] = m.vertices[i * 12 + 2]; }
  return P;
}
export function yBounds(P: Float32Array): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < P.length; i += 3) { lo = Math.min(lo, P[i]); hi = Math.max(hi, P[i]); }
  return { lo, hi };
}
const jointY = (m: SkinnedMeshData, pose: PoseRotations, name: string): V3 => {
  const w = posedJointWorld(m, pose)[m.jointNames.indexOf(name)];
  return [w[12], w[13], w[14]];
};

/** Plane cut of one triangle at height y → a segment in (x, z), or null. */
function cutTri(P: Float32Array, a: number, b: number, c: number, y: number): [number, number, number, number] | null {
  const pts: number[] = [];
  const ids = [a, b, c];
  for (let k = 0; k < 3; k++) {
    const i = ids[k], j = ids[(k + 1) % 3];
    const yi = P[i * 3 + 1] - y, yj = P[j * 3 + 1] - y;
    if ((yi < 0) === (yj < 0)) continue;
    const t = yi / (yi - yj);
    pts.push(P[i * 3] + t * (P[j * 3] - P[i * 3]), P[i * 3 + 2] + t * (P[j * 3 + 2] - P[i * 3 + 2]));
  }
  return pts.length === 4 ? [pts[0], pts[1], pts[2], pts[3]] : null;
}
function segDist(s: number[], q: number[]): number {
  const pd = (px: number, pz: number, a: number[]) => {
    const dx = a[2] - a[0], dz = a[3] - a[1], l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2)) : 0;
    return Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
  };
  return Math.min(pd(s[0], s[1], q), pd(s[2], s[3], q), pd(q[0], q[1], s), pd(q[2], q[3], s));
}
/** Even-odd inside intervals of a segment soup on the line z = zz. */
function intervals(segs: number[][], zz: number): number[] {
  const xs: number[] = [];
  for (const s of segs) {
    if ((s[1] <= zz) === (s[3] <= zz)) continue;
    xs.push(s[0] + ((zz - s[1]) * (s[2] - s[0])) / (s[3] - s[1]));
  }
  xs.sort((p, q) => p - q);
  return xs.length % 2 === 0 ? xs : xs.slice(0, xs.length - 1);
}

export interface LegSectionRow { y: number; t: number; gap: number; area: number; need: number }
/** The clearance one leg keeps from the body's midline (the required L–R gap is twice this), by the leg fraction t
 *  (0 = hip joint … 1 = knee … 2 = ankle): the legs meet at the crotch apex, part by mid-thigh, stay apart below. */
export function legClearance(t: number, H = 1): number {
  const s = (e0: number, e1: number, x: number) => { const u = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
  return H * (0.0015 + 0.0025 * s(0.15, 0.6, t) + 0.002 * s(0.6, 1.0, t));
}
/**
 * Horizontal plane sections of the legs (every `step`, from just under the crotch apex to the ankles): each plane's
 * L and R leg polygons (triangles of leg-dominant verts, split by side weight) → their overlap AREA (scanline, even-odd)
 * and their minimum distance (the gap). `need` = the required gap 2·legClearance(t) − `tol` (the crotch band gets a
 * linear ramp from 0 over the first 1.5 cm, where the legs leave the shared crotch point).
 */
export function legSections(m: SkinnedMeshData, P: Float32Array, pose: PoseRotations, opts: { step?: number; tol?: number; H?: number } = {}): { rows: LegSectionRow[]; minMargin: number; maxArea: number } {
  const step = opts.step ?? 0.01, tol = opts.tol ?? 0.0005, H = opts.H ?? 1;
  const sw = sideWeights(m), dom = dominantNames(m), I = m.indices, n = sw.length;
  const legJ = (d: string) => d === 'hips' || /^(upperleg|lowerleg|foot)_/.test(d);
  // the crotch apex: the lowest rest vertex on the midline (pure centre) below the hip joint
  const rest = restP(m);
  const yHip0 = jointY(m, [], 'hips')[1];
  let apex = Infinity;
  for (let i = 0; i < n; i++) if (Math.abs(rest[i * 3]) < 1e-6 && rest[i * 3 + 1] < yHip0 && Math.abs(sw[i]) < 1e-6) apex = Math.min(apex, P[i * 3 + 1]);
  const hip = jointY(m, pose, 'upperleg_L'), knee = jointY(m, pose, 'lowerleg_L'), ank = jointY(m, pose, 'foot_L');
  const ankR = jointY(m, pose, 'foot_R');
  const yEnd = Math.max(ank[1], ankR[1]) + 0.01 * H;
  const tAt = (y: number) => (y > knee[1] ? (hip[1] - y) / (hip[1] - knee[1]) : 1 + (knee[1] - y) / (knee[1] - ank[1]));
  const tris: [number, number, number, number][] = [];   // a, b, c, side (+1 L / −1 R)
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    if (!legJ(dom[a]) || !legJ(dom[b]) || !legJ(dom[c])) continue;
    const s = (sw[a] + sw[b] + sw[c]) / 3;
    if (Math.abs(s) < 0.02) continue;
    tris.push([a, b, c, s > 0 ? 1 : -1]);
  }
  const rows: LegSectionRow[] = [];
  let minMargin = Infinity, maxArea = 0;
  for (let y = apex - 0.002 * H; y > yEnd; y -= step * H) {
    const L: number[][] = [], R: number[][] = [];
    for (const [a, b, c, s] of tris) { const g = cutTri(P, a, b, c, y); if (g) (s > 0 ? L : R).push(g); }
    if (!L.length || !R.length) continue;
    let z0 = Infinity, z1 = -Infinity;
    for (const g of [...L, ...R]) { z0 = Math.min(z0, g[1], g[3]); z1 = Math.max(z1, g[1], g[3]); }
    let area = 0;
    const dz = 0.0005 * H;
    for (let zz = z0 + dz / 2; zz < z1; zz += dz) {
      const a = intervals(L, zz), b = intervals(R, zz);
      for (let i = 0; i + 1 < a.length; i += 2) for (let j = 0; j + 1 < b.length; j += 2) {
        const lo = Math.max(a[i], b[j]), hi = Math.min(a[i + 1], b[j + 1]);
        if (hi > lo) area += (hi - lo) * dz;
      }
    }
    let gap = Infinity;
    for (const p of L) for (const q of R) gap = Math.min(gap, segDist(p, q));
    if (area > 0) gap = -Math.sqrt(area);
    const t = tAt(y), d = apex - y;
    const need = Math.min(1, d / (0.03 * H)) * 2 * legClearance(t, H) - tol;
    rows.push({ y, t, gap, area, need });
    minMargin = Math.min(minMargin, gap - need);
    maxArea = Math.max(maxArea, area);
  }
  return { rows, minMargin, maxArea };
}

/** Front-view outer HALF-width (max x of non-arm, non-head triangles) at heights y. */
export function frontContour(m: SkinnedMeshData, P: Float32Array, ys: number[]): number[] {
  const dom = dominantNames(m), I = m.indices;
  const skip = (d: string) => /^(shoulder|lowerarm|hand)_/.test(d) || d === 'head';
  const keep: number[] = [];
  for (let t = 0; t < I.length; t += 3) if (!skip(dom[I[t]]) && !skip(dom[I[t + 1]]) && !skip(dom[I[t + 2]])) keep.push(t);
  return ys.map((y) => {
    let mx = -Infinity;
    for (const t of keep) { const g = cutTri(P, I[t], I[t + 1], I[t + 2], y); if (g) mx = Math.max(mx, g[0], g[2]); }
    return mx;
  });
}
/** The deepest interior dip of the front outer contour between `yTop` (≈ the waist) and `yBot` (≈ the knee):
 *  max over y of min(max width above, max width below) − width — a notch / pinch reads as a positive dent. */
export function hipDent(m: SkinnedMeshData, P: Float32Array, yTop: number, yBot: number, step = 0.004): { dent: number; at: number; profile: [number, number][] } {
  const ys: number[] = [];
  for (let y = yTop; y >= yBot; y -= step) ys.push(y);
  const w = frontContour(m, P, ys);
  let dent = 0, at = NaN;
  const pre: number[] = [], suf: number[] = new Array(w.length);
  for (let i = 0; i < w.length; i++) pre.push(Math.max(i ? pre[i - 1] : -Infinity, w[i]));
  for (let i = w.length - 1; i >= 0; i--) suf[i] = Math.max(i + 1 < w.length ? suf[i + 1] : -Infinity, w[i]);
  for (let i = 1; i + 1 < w.length; i++) { const d = Math.min(pre[i - 1], suf[i + 1]) - w[i]; if (d > dent) { dent = d; at = ys[i]; } }
  return { dent, at, profile: ys.map((y, i) => [y, w[i]]) };
}

/** Side silhouette of a ring stack (max z per ring) → the turning angle (deg) at each interior ring. */
export function sideProfileTurn(rings: { verts: { p: V3 }[] }[], from: number, to: number): { maxTurn: number; at: number; turns: number[] } {
  const pts = rings.slice(from, to + 1).map((rg) => { let best = rg.verts[0].p; for (const v of rg.verts) if (v.p[2] > best[2]) best = v.p; return best; });
  const turns: number[] = [];
  let maxTurn = 0, at = -1;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = Math.atan2(pts[i][2] - pts[i - 1][2], pts[i][1] - pts[i - 1][1]);
    const b = Math.atan2(pts[i + 1][2] - pts[i][2], pts[i + 1][1] - pts[i][1]);
    let d = (b - a) * 180 / Math.PI; while (d > 180) d -= 360; while (d < -180) d += 360;
    turns.push(d);
    if (Math.abs(d) > Math.abs(maxTurn)) { maxTurn = d; at = from + i; }
  }
  return { maxTurn, at, turns };
}

/** The smallest ring-to-ring spacing at any column of a ring stack (rings index-corresponding). */
export function torsoSpacing(rings: { verts: { p: V3 }[] }[]): { min: number; ring: number; col: number } {
  let min = Infinity, ring = -1, col = -1;
  for (let r = 0; r + 1 < rings.length; r++) for (let c = 0; c < rings[r].verts.length; c++) {
    const a = rings[r].verts[c].p, b = rings[r + 1].verts[c].p, d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d < min) { min = d; ring = r; col = c; }
  }
  return { min, ring, col };
}

/** Top silhouette height (front view) in the vertical plane x = xx (non-head triangles below `yMax`). */
export function topAt(m: SkinnedMeshData, P: Float32Array, xx: number, yMax: number): number {
  const dom = dominantNames(m), I = m.indices;
  let top = -Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const ids = [I[t], I[t + 1], I[t + 2]];
    if (ids.some((i) => dom[i] === 'head')) continue;
    for (let k = 0; k < 3; k++) {
      const i = ids[k], j = ids[(k + 1) % 3];
      const xi = P[i * 3] - xx, xj = P[j * 3] - xx;
      if ((xi < 0) === (xj < 0)) continue;
      const u = xi / (xi - xj), y = P[i * 3 + 1] + u * (P[j * 3 + 1] - P[i * 3 + 1]);
      if (y < yMax) top = Math.max(top, y);
    }
  }
  return top;
}
/** Shoulder slope (deg) in the front view: the chord of the top silhouette from x = xNeck to x = xAcromion. */
export function shoulderSlope(m: SkinnedMeshData, P: Float32Array, xNeck: number, xAcr: number, yMax: number): number {
  const a = topAt(m, P, xNeck, yMax), b = topAt(m, P, xAcr, yMax);
  return (Math.atan2(a - b, xAcr - xNeck) * 180) / Math.PI;
}

/** Arms straight down (the Relaxed clavicles kept) — the reach reference pose. */
export function armsDownPose(): PoseRotations {
  const h = (deg: number) => { const a = (deg * Math.PI) / 360; return [0, 0, Math.sin(a), Math.cos(a)] as [number, number, number, number]; };
  return [{ joint: 'shoulder_L', q: h(-88) }, { joint: 'shoulder_R', q: h(88) }];
}
export interface Reach { H: number; crotch: number; wrist: number; tip: number; wristMinusCrotch: number; tipMinusCrotch: number }
/** Stature-relative wrist / fingertip heights vs the crotch apex (left side). */
export function reach(m: SkinnedMeshData, pose: PoseRotations): Reach {
  const { P } = posedP(m, pose), dom = dominantNames(m), sw = sideWeights(m), rest = restP(m);
  const { lo, hi } = yBounds(P), H = hi - lo;
  const yHip0 = jointY(m, [], 'hips')[1];
  let crotch = Infinity, tip = Infinity;
  for (let i = 0; i < dom.length; i++) {
    if (Math.abs(rest[i * 3]) < 1e-6 && rest[i * 3 + 1] < yHip0 && Math.abs(sw[i]) < 1e-6) crotch = Math.min(crotch, P[i * 3 + 1]);
    if (dom[i] === 'hand_L') tip = Math.min(tip, P[i * 3 + 1]);
  }
  const wrist = jointY(m, pose, 'hand_L')[1];
  return { H, crotch: (crotch - lo) / H, wrist: (wrist - lo) / H, tip: (tip - lo) / H, wristMinusCrotch: (wrist - crotch) / H, tipMinusCrotch: (tip - crotch) / H };
}
/** Rest-pose hand length (hand joint → the farthest hand vertex along the arm, left) and head height (chin → crown). */
export function handAndHead(m: SkinnedMeshData): { hand: number; head: number; headW: number; headD: number; H: number } {
  const P = restP(m), dom = dominantNames(m), { lo, hi } = yBounds(P);
  const hj = jointY(m, [], 'hand_L');
  let hand = 0, y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < dom.length; i++) {
    if (dom[i] === 'hand_L') hand = Math.max(hand, P[i * 3] - hj[0]);
    if (dom[i] === 'head') { y0 = Math.min(y0, P[i * 3 + 1]); y1 = Math.max(y1, P[i * 3 + 1]); x0 = Math.min(x0, P[i * 3]); x1 = Math.max(x1, P[i * 3]); z0 = Math.min(z0, P[i * 3 + 2]); z1 = Math.max(z1, P[i * 3 + 2]); }
  }
  return { hand, head: hi - y0, headW: x1 - x0, headD: z1 - z0, H: hi - lo };
}
/** Rest-pose foot (left): length (z extent) and width (x extent) of the verts below the ankle joint; ankle height. */
export function footSize(m: SkinnedMeshData): { length: number; width: number; ankleH: number; H: number } {
  const P = restP(m), sw = sideWeights(m), { lo, hi } = yBounds(P), a = jointY(m, [], 'foot_L');
  let z0 = Infinity, z1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  for (let i = 0; i < sw.length; i++) {
    if (sw[i] <= 0.5 || P[i * 3 + 1] > a[1]) continue;
    z0 = Math.min(z0, P[i * 3 + 2]); z1 = Math.max(z1, P[i * 3 + 2]); x0 = Math.min(x0, P[i * 3]); x1 = Math.max(x1, P[i * 3]);
  }
  return { length: z1 - z0, width: x1 - x0, ankleH: a[1] - lo, H: hi - lo };
}

/** Vertices with no x-mirrored twin (position within `eps`, joints swapped L↔R) at rest. */
export function mirrorMisses(m: SkinnedMeshData, eps = 1e-4, weights = true): number {
  const P = restP(m), n = P.length / 3, q = (x: number) => Math.round(x / eps);
  const swapName = (s: string) => s.endsWith('_L') ? s.slice(0, -2) + '_R' : s.endsWith('_R') ? s.slice(0, -2) + '_L' : s;
  const swapJ = m.jointNames.map((nm) => m.jointNames.indexOf(swapName(nm)));
  const key = (x: number, y: number, z: number) => `${q(x)},${q(y)},${q(z)}`;
  const map = new Map<string, number[]>();
  for (let i = 0; i < n; i++) { const k = key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); }
  const wSig = (i: number, swap: boolean) => {
    const w = new Map<number, number>();
    for (let k = 0; k < 4; k++) { const wt = m.jointWeights[i * 4 + k]; if (wt <= 1e-4) continue; const j = swap ? swapJ[m.jointIndices[i * 4 + k]] : m.jointIndices[i * 4 + k]; w.set(j, (w.get(j) ?? 0) + wt); }
    return w;
  };
  let miss = 0;
  for (let i = 0; i < n; i++) {
    const x = -P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++) for (let dy = -1; dy <= 1 && !found; dy++) for (let dz = -1; dz <= 1 && !found; dz++) {
      for (const j of map.get(`${q(x) + dx},${q(y) + dy},${q(z) + dz}`) ?? []) {
        if (Math.hypot(P[j * 3] - x, P[j * 3 + 1] - y, P[j * 3 + 2] - z) > eps) continue;
        const a = wSig(i, true), b = wSig(j, false);
        let ok = true; if (weights) for (const [jj, wt] of a) if (Math.abs((b.get(jj) ?? 0) - wt) > 2e-3) ok = false;
        if (ok) { found = true; break; }
      }
    }
    if (!found) miss++;
  }
  return miss;
}

export interface UVIsland { tris: number; area3: number; mirroredPct: number; downDot: number; dominant: string; anisoP99: number; anisoMax: number; aniso3Pct: number; uvBox: [number, number, number, number] }
/**
 * UV islands (connected components over shared vertex indices). Per island: the share of its 3D area that is MIRRORED
 * (UV winding vs the outward 3D winding, in the image-down convention: v = 0 is the image top), the area-weighted
 * dot of image-down (+v) with body-down (−y) (vertical islands should read ≈ 1), and the 3D→UV anisotropy
 * (σmax / σmin of the per-triangle Jacobian).
 */
export function uvIslands(m: SkinnedMeshData): UVIsland[] {
  const V = m.vertices, I = m.indices, nv = V.length / 12, dom = dominantNames(m);
  const par = new Int32Array(nv).map((_, i) => i);
  const find = (x: number): number => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < I.length; t += 3) { const a = find(I[t]), b = find(I[t + 1]), c = find(I[t + 2]); par[b] = a; par[find(c)] = a; }
  const isl = new Map<number, { tris: number; area3: number; mir: number; down: number; anis: [number, number][]; dom: Map<string, number>; box: [number, number, number, number] }>();
  for (let t = 0; t < I.length; t += 3) {
    const ids = [I[t], I[t + 1], I[t + 2]];
    const p = ids.map((i) => [V[i * 12], V[i * 12 + 1], V[i * 12 + 2]]), u = ids.map((i) => [V[i * 12 + 6], V[i * 12 + 7]]);
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const a3 = 0.5 * Math.hypot(nrm[0], nrm[1], nrm[2]);
    if (a3 < 1e-12) continue;
    const du1 = u[1][0] - u[0][0], dv1 = u[1][1] - u[0][1], du2 = u[2][0] - u[0][0], dv2 = u[2][1] - u[0][1];
    const det = du1 * dv2 - du2 * dv1;
    const k = find(ids[0]);
    let s = isl.get(k);
    if (!s) { s = { tris: 0, area3: 0, mir: 0, down: 0, anis: [], dom: new Map(), box: [Infinity, Infinity, -Infinity, -Infinity] }; isl.set(k, s); }
    s.tris++; s.area3 += a3;
    for (const q of u) { s.box[0] = Math.min(s.box[0], q[0]); s.box[1] = Math.min(s.box[1], q[1]); s.box[2] = Math.max(s.box[2], q[0]); s.box[3] = Math.max(s.box[3], q[1]); }
    for (const i of ids) s.dom.set(dom[i], (s.dom.get(dom[i]) ?? 0) + 1);
    // outward-CCW triangles map NON-mirrored when det < 0 in the image-down convention (see the header)
    if (det > 0) s.mir += a3;
    if (Math.abs(det) > 1e-14) {
      // dP/dv (the 3D direction of image-down) = (du1·e2 − du2·e1) / det
      const bv = [(du1 * e2[0] - du2 * e1[0]) / det, (du1 * e2[1] - du2 * e1[1]) / det, (du1 * e2[2] - du2 * e1[2]) / det];
      const bl = Math.hypot(bv[0], bv[1], bv[2]) || 1;
      s.down += (-bv[1] / bl) * a3;
      // anisotropy: singular values of the 2×2 map in the triangle's own 3D frame
      const l1 = Math.hypot(e1[0], e1[1], e1[2]);
      const ex = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
      const nl = Math.hypot(nrm[0], nrm[1], nrm[2]), nz = [nrm[0] / nl, nrm[1] / nl, nrm[2] / nl];
      const ey = [nz[1] * ex[2] - nz[2] * ex[1], nz[2] * ex[0] - nz[0] * ex[2], nz[0] * ex[1] - nz[1] * ex[0]];
      const x1 = l1, y1 = 0, x2 = e2[0] * ex[0] + e2[1] * ex[1] + e2[2] * ex[2], y2 = e2[0] * ey[0] + e2[1] * ey[1] + e2[2] * ey[2];
      // J maps (x, y) → (u, v): [du1 du2; dv1 dv2] · inv([x1 x2; y1 y2])
      const d3 = x1 * y2 - x2 * y1;
      const a = (du1 * y2 - du2 * y1) / d3, b = (du2 * x1 - du1 * x2) / d3, c = (dv1 * y2 - dv2 * y1) / d3, d = (dv2 * x1 - dv1 * x2) / d3;
      const E = (a * a + b * b + c * c + d * d) / 2, F = Math.sqrt(Math.max(0, E * E - (a * d - b * c) ** 2));
      const smax = Math.sqrt(E + F), smin = Math.sqrt(Math.max(1e-30, E - F));
      s.anis.push([smax / smin, a3]);
    }
  }
  return [...isl.values()].map((s) => {
    s.anis.sort((p, q) => p[0] - q[0]);
    const tot = s.anis.reduce((x, y) => x + y[1], 0);
    let acc = 0, p99 = s.anis.length ? s.anis[s.anis.length - 1][0] : 1;
    for (const [r, a] of s.anis) { acc += a; if (acc >= 0.99 * tot) { p99 = r; break; } }
    const over3 = s.anis.filter((x) => x[0] > 3).reduce((x, y) => x + y[1], 0);
    const dm = [...s.dom.entries()].sort((p, q) => q[1] - p[1])[0][0];
    return { tris: s.tris, area3: s.area3, mirroredPct: (100 * s.mir) / s.area3, downDot: s.down / s.area3, dominant: dm,
      anisoP99: p99, anisoMax: s.anis.length ? s.anis[s.anis.length - 1][0] : 1, aniso3Pct: tot ? (100 * over3) / tot : 0, uvBox: s.box };
  });
}

/** The narrowest front-view width of the neck between y0 and y1 (all non-head triangles). */
export function neckWidth(m: SkinnedMeshData, P: Float32Array, y0: number, y1: number, step = 0.002): number {
  const ys: number[] = [];
  for (let y = y0; y <= y1; y += step) ys.push(y);
  const w = frontContour(m, P, ys);
  return 2 * Math.min(...w.filter((x) => Number.isFinite(x)));
}

/** Output-vertex index of each rest position in `rings` (position-hash lookup; any seam duplicate will do — they skin
 *  identically). */
export function ringVertexIds(m: SkinnedMeshData, rings: { verts: { p: [number, number, number] }[] }[]): number[][] {
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const map = new Map<string, number>();
  for (let i = 0; i < m.vertices.length / 12; i++) { const k = key(m.vertices[i * 12], m.vertices[i * 12 + 1], m.vertices[i * 12 + 2]); if (!map.has(k)) map.set(k, i); }
  return rings.map((rg) => rg.verts.map((v) => map.get(key(v.p[0], v.p[1], v.p[2])) ?? -1));
}
/**
 * The ANKLE's rigid-shin check (review topology#3): with the foot posed, the lower-shin rings should ride the lower-leg
 * bone rigidly. Returns the largest centroid offset (rig units) of the given leg rings from the lower-leg joint's rigid
 * transform, and the bend (deg) of the shin axis (first → last ring) against the rigidly transformed rest axis.
 */
export function shinRigidity(m: SkinnedMeshData, rings: number[][], pose: PoseRotations, side: 'L' | 'R' = 'L'): { offset: number; bendDeg: number } {
  const { P } = posedP(m, pose), R = restP(m);
  const w = posedJointWorld(m, pose)[m.jointNames.indexOf('lowerleg_' + side)];
  const j = m.jointNames.indexOf('lowerleg_' + side), ib = m.inverseBindMatrices.subarray(j * 16, j * 16 + 16);
  const rigid = (x: number, y: number, z: number): [number, number, number] => {
    const lx = ib[0] * x + ib[4] * y + ib[8] * z + ib[12], ly = ib[1] * x + ib[5] * y + ib[9] * z + ib[13], lz = ib[2] * x + ib[6] * y + ib[10] * z + ib[14];
    return [w[0] * lx + w[4] * ly + w[8] * lz + w[12], w[1] * lx + w[5] * ly + w[9] * lz + w[13], w[2] * lx + w[6] * ly + w[10] * lz + w[14]];
  };
  const cen = (A: Float32Array, ids: number[]) => { const c = [0, 0, 0]; for (const i of ids) for (let k = 0; k < 3; k++) c[k] += A[i * 3 + k] / ids.length; return c as [number, number, number]; };
  let offset = 0;
  for (const ids of rings) {
    const a = cen(P, ids), r = cen(R, ids), b = rigid(r[0], r[1], r[2]);
    offset = Math.max(offset, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  const p0 = cen(P, rings[0]), p1 = cen(P, rings[rings.length - 1]);
  const r0 = cen(R, rings[0]), r1 = cen(R, rings[rings.length - 1]);
  const q0 = rigid(r0[0], r0[1], r0[2]), q1 = rigid(r1[0], r1[1], r1[2]);
  const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], v = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]];
  const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2]));
  return { offset, bendDeg: (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI };
}
/** Max normal turn (deg) between two generator outputs over vertices that moved less than `maxMove` (a hard switch in
 *  a normal post-pass shows as a big turn with no motion). */
export function normalJump(a: Float32Array, b: Float32Array, maxMove = 1e-4): number {
  let worst = 0;
  for (let i = 0; i < a.length / 12; i++) {
    const o = i * 12;
    if (Math.hypot(a[o] - b[o], a[o + 1] - b[o + 1], a[o + 2] - b[o + 2]) > maxMove) continue;
    const d = a[o + 3] * b[o + 3] + a[o + 4] * b[o + 4] + a[o + 5] * b[o + 5];
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI);
  }
  return worst;
}
