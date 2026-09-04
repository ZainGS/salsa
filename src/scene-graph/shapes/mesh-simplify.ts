/**
 * QEM mesh decimation (Garland–Heckbert quadric error metric, edge-collapse).
 *
 * Surface-nets / marching-cubes meshes have UNIFORM topology (one vertex per straddling grid cell), so a flat
 * flank costs as many triangles as a detailed joint. This simplifier reduces triangle count while preserving
 * the silhouette, and is CURVATURE-ADAPTIVE — flat regions collapse hard, curved regions keep density.
 *
 * Position-only (no UVs): decimate the CLOSED mesh, THEN (re)unwrap — so there are no seams to smear. Pure /
 * CPU / unit-testable. See docs/specs/mesh-decimation.md.
 */

import type { V3 } from './sdf-mesh';
import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT, computeTangents } from '../../renderer/3d/mesh-generators';

type Tri = [number, number, number];

// ── quadric = symmetric 4×4, stored as its 10 unique upper-triangle entries ──
//   [ q0 q1 q2 q3 ]
//   [ q1 q4 q5 q6 ]
//   [ q2 q5 q7 q8 ]
//   [ q3 q6 q8 q9 ]
type Quadric = Float64Array;   // length 10

function planeQuadric(a: number, b: number, c: number, d: number): Quadric {
  const q = new Float64Array(10);
  q[0] = a * a; q[1] = a * b; q[2] = a * c; q[3] = a * d;
  q[4] = b * b; q[5] = b * c; q[6] = b * d;
  q[7] = c * c; q[8] = c * d;
  q[9] = d * d;
  return q;
}
function qAddInto(dst: Quadric, src: Quadric): void { for (let i = 0; i < 10; i++) dst[i] += src[i]; }
function qAdd(a: Quadric, b: Quadric): Quadric { const r = new Float64Array(10); for (let i = 0; i < 10; i++) r[i] = a[i] + b[i]; return r; }

/** v^T Q v for v = (x,y,z,1) — the squared distance-to-planes error at a point. */
function qError(q: Quadric, x: number, y: number, z: number): number {
  return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x
    + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y
    + q[7] * z * z + 2 * q[8] * z
    + q[9];
}

/** Solve the 3×3 [[q0,q1,q2],[q1,q4,q5],[q2,q5,q7]] · v = -(q3,q6,q8) for the optimal contraction point. */
function optimalPos(q: Quadric): V3 | null {
  const a = q[0], b = q[1], c = q[2], d = q[4], e = q[5], f = q[7];   // symmetric 3×3 entries
  // cofactors / determinant
  const A = d * f - e * e, B = c * e - b * f, C = b * e - c * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-10) return null;
  const D = a * f - c * c, E = b * c - a * e, F = a * d - b * b;
  const inv = 1 / det;
  const rx = -q[3], ry = -q[6], rz = -q[8];
  return [
    (A * rx + B * ry + C * rz) * inv,
    (B * rx + D * ry + E * rz) * inv,
    (C * rx + E * ry + F * rz) * inv,
  ];
}

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Unit face normal (zero vector if degenerate). */
function faceNormal(p0: V3, p1: V3, p2: V3): V3 {
  const n = cross3(sub3(p1, p0), sub3(p2, p0));
  const l = Math.hypot(n[0], n[1], n[2]);
  return l < 1e-20 ? [0, 0, 0] : [n[0] / l, n[1] / l, n[2] / l];
}

// ── a tiny binary min-heap of edge-collapse candidates ──
interface HeapEntry { cost: number; a: number; b: number; t: V3; sa: number; sb: number; }
class MinHeap {
  private h: HeapEntry[] = [];
  get size(): number { return this.h.length; }
  push(e: HeapEntry): void {
    const h = this.h; h.push(e); let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (h[p].cost <= h[i].cost) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
  }
  pop(): HeapEntry | undefined {
    const h = this.h; if (h.length === 0) return undefined;
    const top = h[0], last = h.pop()!;
    if (h.length > 0) {
      h[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let s = i;
        if (l < h.length && h[l].cost < h[s].cost) s = l;
        if (r < h.length && h[r].cost < h[s].cost) s = r;
        if (s === i) break; [h[s], h[i]] = [h[i], h[s]]; i = s;
      }
    }
    return top;
  }
}

/**
 * Decimate a triangle mesh to ~`targetRatio` of its faces (0..1). Position-only, curvature-adaptive.
 * Locks boundary edges (keeps open borders), skips collapses that flip a face or go non-manifold. Deterministic.
 */
export function simplifyMesh(positionsIn: V3[], trisIn: Tri[], targetRatio: number): { positions: V3[]; tris: Tri[] } {
  const ratio = Math.max(0.02, Math.min(1, targetRatio));
  const nV = positionsIn.length;
  if (ratio >= 0.999 || trisIn.length < 4 || nV < 4) return { positions: positionsIn.map(p => [...p] as V3), tris: trisIn.map(t => [...t] as Tri) };

  const pos: V3[] = positionsIn.map(p => [...p] as V3);
  const faces: (Tri | null)[] = trisIn.map(t => [...t] as Tri);
  const alive = new Uint8Array(nV).fill(1);
  const stamp = new Int32Array(nV);
  const vFaces: Set<number>[] = Array.from({ length: nV }, () => new Set<number>());
  const quad: Quadric[] = Array.from({ length: nV }, () => new Float64Array(10));

  // Per-face plane quadric → accumulate onto its 3 verts; build vertex→face adjacency.
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi]!;
    const p0 = pos[f[0]], p1 = pos[f[1]], p2 = pos[f[2]];
    const n = faceNormal(p0, p1, p2);
    const d = -dot3(n, p0);
    const kp = planeQuadric(n[0], n[1], n[2], d);
    for (const v of f) { qAddInto(quad[v], kp); vFaces[v].add(fi); }
  }

  const sharedFaces = (a: number, b: number): number[] => {
    const out: number[] = []; const fa = vFaces[a], fb = vFaces[b];
    const [small, big] = fa.size < fb.size ? [fa, fb] : [fb, fa];
    for (const f of small) if (big.has(f)) out.push(f);
    return out;
  };
  const neighbors = (a: number): number[] => {
    const s = new Set<number>();
    for (const fi of vFaces[a]) { const f = faces[fi]!; for (const v of f) if (v !== a) s.add(v); }
    return [...s];
  };

  const heap = new MinHeap();
  const evalEdge = (a: number, b: number): HeapEntry => {
    const q = qAdd(quad[a], quad[b]);
    let t = optimalPos(q);
    if (!t) {   // singular → best of the two endpoints or the midpoint
      const mid: V3 = [(pos[a][0] + pos[b][0]) / 2, (pos[a][1] + pos[b][1]) / 2, (pos[a][2] + pos[b][2]) / 2];
      const cands = [pos[a], pos[b], mid];
      let best = cands[0], bc = Infinity;
      for (const c of cands) { const e = qError(q, c[0], c[1], c[2]); if (e < bc) { bc = e; best = c; } }
      t = [best[0], best[1], best[2]];
    }
    return { cost: qError(q, t[0], t[1], t[2]), a, b, t, sa: stamp[a], sb: stamp[b] };
  };

  // Seed the heap with every unique interior edge (a<b).
  const seen = new Set<number>();
  for (const f of faces) {
    for (let e = 0; e < 3; e++) {
      let a = f![e], b = f![(e + 1) % 3]; if (a > b) { const tmp = a; a = b; b = tmp; }
      const key = a * nV + b; if (seen.has(key)) continue; seen.add(key);
      heap.push(evalEdge(a, b));
    }
  }

  let faceCount = faces.length;
  const target = Math.max(4, Math.floor(faces.length * ratio));

  const wouldFlip = (a: number, b: number, t: V3, shared: Set<number>): boolean => {
    for (const set of [vFaces[a], vFaces[b]]) {
      for (const fi of set) {
        if (shared.has(fi)) continue;
        const f = faces[fi]!;
        const q0 = f[0] === a || f[0] === b ? t : pos[f[0]];
        const q1 = f[1] === a || f[1] === b ? t : pos[f[1]];
        const q2 = f[2] === a || f[2] === b ? t : pos[f[2]];
        const nn = faceNormal(q0, q1, q2);
        if (nn[0] === 0 && nn[1] === 0 && nn[2] === 0) return true;   // degenerate
        const on = faceNormal(pos[f[0]], pos[f[1]], pos[f[2]]);
        if (dot3(on, nn) < 0.1) return true;                          // flip / sliver
      }
    }
    return false;
  };

  while (faceCount > target && heap.size > 0) {
    const e = heap.pop()!;
    const { a, b, t } = e;
    if (!alive[a] || !alive[b] || stamp[a] !== e.sa || stamp[b] !== e.sb) continue;   // dead or stale
    const sh = sharedFaces(a, b);
    if (sh.length !== 2) continue;               // boundary (1) or non-manifold (>2) → lock
    const shSet = new Set(sh);
    if (wouldFlip(a, b, t, shSet)) continue;

    // ── collapse b → a at t ──
    pos[a] = t;
    qAddInto(quad[a], quad[b]);
    // remove the 2 shared faces (only from their own 3 verts — O(1), not a full scan)
    for (const fi of sh) { const f = faces[fi]!; for (const v of f) vFaces[v].delete(fi); faces[fi] = null; }
    // re-point b's surviving faces to a
    for (const fi of [...vFaces[b]]) {
      const f = faces[fi]; if (!f) continue;
      for (let k = 0; k < 3; k++) if (f[k] === b) f[k] = a;
      vFaces[a].add(fi);
    }
    vFaces[b].clear();
    alive[b] = 0;
    faceCount -= 2;
    stamp[a]++;
    for (const n of neighbors(a)) heap.push(evalEdge(a, n));
  }

  // Compact: drop dead verts + null faces, remap indices.
  const remap = new Int32Array(nV).fill(-1);
  const outPos: V3[] = [];
  for (let v = 0; v < nV; v++) if (alive[v]) { remap[v] = outPos.length; outPos.push(pos[v]); }
  const outTris: Tri[] = [];
  for (const f of faces) {
    if (!f) continue;
    const a = remap[f[0]], b = remap[f[1]], c = remap[f[2]];
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    outTris.push([a, b, c]);
  }
  return { positions: outPos, tris: outTris };
}

/**
 * Decimate a 12-float MeshGeometry in place-ish (returns a new geometry). Positions are QEM-simplified; normals
 * are recomputed (area-weighted face averaging); each surviving vertex keeps its ORIGINAL uv (approximate — a
 * seamed mesh should re-unwrap after). Tangents recomputed. For a metaball/creature, prefer decimating BEFORE
 * the per-blob unwrap (generateSdfMesh's `decimate`) — this wrapper is the generic path for arbitrary meshes.
 */
export function simplifyGeometry(geom: MeshGeometry, targetRatio: number): MeshGeometry {
  const S = FLOATS_PER_VERT;
  const nV = geom.vertices.length / S;
  const positions: V3[] = [];
  for (let i = 0; i < nV; i++) positions.push([geom.vertices[i * S], geom.vertices[i * S + 1], geom.vertices[i * S + 2]]);
  const tris: Tri[] = [];
  for (let i = 0; i + 2 < geom.indices.length; i += 3) tris.push([geom.indices[i], geom.indices[i + 1], geom.indices[i + 2]]);

  // Decimate on positions; recompute normals below. UVs are DROPPED (collapsed verts move, so carrying the
  // original uv would stretch/smear) — callers that need texturing re-unwrap after (autoUnwrap3D, or the
  // per-blob unwrap for a metaball source). This keeps the generic path simple and correct-by-construction.
  const r = simplifyMesh(positions, tris, targetRatio);
  const outN = r.positions.length;

  // Recompute area-weighted normals from the simplified faces.
  const nrm: V3[] = Array.from({ length: outN }, () => [0, 0, 0] as V3);
  for (const [a, b, c] of r.tris) {
    const p0 = r.positions[a], p1 = r.positions[b], p2 = r.positions[c];
    const fn = cross3(sub3(p1, p0), sub3(p2, p0));   // length ∝ 2·area → area weighting for free
    for (const v of [a, b, c]) { nrm[v][0] += fn[0]; nrm[v][1] += fn[1]; nrm[v][2] += fn[2]; }
  }

  const verts8 = new Float32Array(outN * 8);
  for (let i = 0; i < outN; i++) {
    const p = r.positions[i], n = nrm[i], o = i * 8;
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    verts8[o] = p[0]; verts8[o + 1] = p[1]; verts8[o + 2] = p[2];
    verts8[o + 3] = n[0] / l; verts8[o + 4] = n[1] / l; verts8[o + 5] = n[2] / l;
    verts8[o + 6] = 0; verts8[o + 7] = 0;   // uv dropped — re-unwrap for a seamed/textured mesh
  }
  const indices = new Uint32Array(r.tris.length * 3);
  let ii = 0;
  for (const t of r.tris) { indices[ii++] = t[0]; indices[ii++] = t[1]; indices[ii++] = t[2]; }
  return computeTangents({ vertices: verts8, indices, format: '8float' });
}
