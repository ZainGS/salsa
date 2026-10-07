/**
 * Triangle geometry → EditMesh topology (docs/specs/edit-mesh-topology.md §2).
 *
 * The GPU format splits a vertex wherever its normal or UV differs (a cube = 24 vertices, a UV sphere = a seam
 * column + per-u pole copies), and an un-indexed geometry (an old EditMesh compile, some imports) is pure triangle
 * soup. Editing that directly tears the surface apart: dragging a cube corner moved one of its three copies. So when
 * a mesh enters Edit Mesh its geometry is converted to the modeller model:
 *
 *  1. WELD — vertices closer than WELD_REL × the bounding-box diagonal become ONE topology vertex (the first copy's
 *     exact position is kept, so an unedited mesh compiles back to the same positions). UVs are NOT a reason to keep
 *     vertices apart: each face corner keeps its own UV (seams = corners whose UVs differ).
 *  2. Degenerate triangles (two corners welded together — a UV sphere's pole caps) are dropped.
 *  3. TRIS → QUADS — conservative: two triangles sharing an edge merge into a quad only when the result is planar
 *     (≤ QUAD_MAX_DIHEDRAL_DEG), convex, close to rectangular (every corner within QUAD_MAX_CORNER_DEV_DEG of 90°)
 *     and seamless (equal UVs and normals on the shared edge). Best-first by how rectangular the quad is, so a grid's
 *     real quads win over the parallelograms across grid lines. The quad keeps the triangles' diagonal as its 0–2
 *     split, so an unedited mesh renders exactly as before.
 *  4. SHADING — a face whose source normals deviate from its own normal is SMOOTH; an edge between two smooth faces
 *     whose source normals differ across it is SHARP. (Box = flat; sphere / torus / cylinder side = smooth with the
 *     cylinder caps flat.)
 *
 * With `weld: false` (skinned bodies: their rest weights / weight paint index the GEOMETRY's vertices) the vertex
 * array stays 1:1 with the geometry and only the triangles are read (no welding, no quads, UVs stay per vertex).
 */

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

export type UV2 = [number, number];

export interface WeldOptions {
  /** Merge coincident positions (default true). false = keep the geometry's vertices 1:1. */
  weld?: boolean;
  /** Merge coplanar triangle pairs into quads (default true; only with weld). */
  quads?: boolean;
  /** Also fill `vertex.uv` (the per-vertex fallback) from the first corner (default true). The UV editor treats a
   *  mesh with no vertex UVs as "never unwrapped" and auto-unwraps it on first open — primitives pass false so a box
   *  keeps that behaviour while its corners still carry the generator UVs for rendering. */
  vertexUVs?: boolean;
}

export interface WeldResult {
  vertices: Array<{ x: number; y: number; z: number; color: [number, number, number, number]; uv?: UV2 }>;
  faces: Array<{ verts: number[]; uvs?: UV2[]; smooth: boolean }>;
  sharpEdges: Array<[number, number]>;
  /** Stats (tests / the report). */
  stats: { sourceVerts: number; sourceTris: number; degenerate: number; quads: number };
}

/** Weld distance, relative to the bounding-box diagonal. */
export const WELD_REL = 1e-6;
/** Tris → quads: max angle between the two triangle normals. */
export const QUAD_MAX_DIHEDRAL_DEG = 5;
/** Tris → quads: max deviation of any quad corner from 90°. */
export const QUAD_MAX_CORNER_DEV_DEG = 25;
/** Normals closer than this (dot) are "the same" (smooth / sharp / seam tests). */
const NORMAL_SAME_DOT = 0.9995;
/** UVs closer than this are "the same" (seam test on a shared edge). */
const UV_SAME = 1e-6;

const DEFAULT_COLOR = (): [number, number, number, number] => [0.8, 0.8, 0.8, 1];

export function weldGeometry(geom: MeshGeometry, opts: WeldOptions = {}): WeldResult {
  const weld = opts.weld !== false;
  const doQuads = weld && opts.quads !== false;
  const vertexUVs = opts.vertexUVs !== false;
  const src = geom.vertices, S = FLOATS_PER_VERT;
  const nSrc = Math.floor(src.length / S);
  const idx = geom.indices && geom.indices.length >= 3 ? geom.indices : null;
  const nTri = idx ? Math.floor(idx.length / 3) : Math.floor(nSrc / 3);
  const triSrc = (t: number, k: number): number => (idx ? idx[t * 3 + k] : t * 3 + k);

  // 1. Weld map (source vertex → topology vertex).
  const map = new Int32Array(nSrc);
  const reps: number[] = [];   // topology vertex → its source vertex (first copy)
  if (weld) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < nSrc; i++) {
      const x = src[i * S], y = src[i * S + 1], z = src[i * S + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const diag = Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0, z1 - z0) : 0;
    const eps = Math.max(diag * WELD_REL, 1e-12);
    const grid = new Map<string, number[]>();
    const cellOf = (v: number): number => Math.floor(v / eps);
    for (let i = 0; i < nSrc; i++) {
      const x = src[i * S], y = src[i * S + 1], z = src[i * S + 2];
      const cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
      let found = -1;
      for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
        const cell = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!cell) continue;
        for (const w of cell) {
          const r = reps[w] * S;
          if (Math.abs(src[r] - x) <= eps && Math.abs(src[r + 1] - y) <= eps && Math.abs(src[r + 2] - z) <= eps) { found = w; break; }
        }
      }
      if (found < 0) {
        found = reps.length;
        reps.push(i);
        const key = `${cx},${cy},${cz}`;
        const cell = grid.get(key);
        if (cell) cell.push(found); else grid.set(key, [found]);
      }
      map[i] = found;
    }
  } else {
    for (let i = 0; i < nSrc; i++) { map[i] = i; reps.push(i); }
  }

  const vertices: WeldResult['vertices'] = reps.map((s) => ({
    x: src[s * S], y: src[s * S + 1], z: src[s * S + 2], color: DEFAULT_COLOR(),
  }));

  // 2. Triangles in topology vertices; corner attributes from the source.
  type Tri = { v: [number, number, number]; s: [number, number, number] };
  const tris: Tri[] = [];
  let degenerate = 0;
  for (let t = 0; t < nTri; t++) {
    const s0 = triSrc(t, 0), s1 = triSrc(t, 1), s2 = triSrc(t, 2);
    if (s0 >= nSrc || s1 >= nSrc || s2 >= nSrc) continue;
    const a = map[s0], b = map[s1], c = map[s2];
    if (weld && (a === b || b === c || a === c)) { degenerate++; continue; }
    tris.push({ v: [a, b, c], s: [s0, s1, s2] });
  }

  const uvOf = (s: number): UV2 => [src[s * S + 6] ?? 0, src[s * S + 7] ?? 0];
  const nrmOf = (s: number): [number, number, number] => [src[s * S + 3] ?? 0, src[s * S + 4] ?? 0, src[s * S + 5] ?? 0];

  if (!weld) {
    // 1:1 (skinned): UVs per vertex, as the legacy edit mesh; smooth where the source normals say so.
    for (let i = 0; i < nSrc; i++) vertices[i].uv = uvOf(i);
    const faces = tris.map((t) => ({ verts: [...t.v], smooth: isSmooth(vertices, t.v, t.s.map(nrmOf)) }));
    return { vertices, faces, sharpEdges: [], stats: { sourceVerts: nSrc, sourceTris: nTri, degenerate, quads: 0 } };
  }

  // 3. Tris → quads.
  type Poly = { order: number; v: number[]; s: number[] };
  const polys: Poly[] = [];
  const merged = new Uint8Array(tris.length);
  let quads = 0;
  if (doQuads && tris.length > 1) {
    const dirEdge = new Map<string, number[]>();   // "a,b" → triangles using the directed edge a→b
    tris.forEach((t, ti) => {
      for (let k = 0; k < 3; k++) {
        const key = `${t.v[k]},${t.v[(k + 1) % 3]}`;
        const l = dirEdge.get(key);
        if (l) l.push(ti); else dirEdge.set(key, [ti]);
      }
    });
    type Cand = { t1: number; t2: number; k: number; score: number };
    const cands: Cand[] = [];
    for (let t1 = 0; t1 < tris.length; t1++) {
      const T = tris[t1];
      for (let k = 0; k < 3; k++) {
        const a = T.v[k], b = T.v[(k + 1) % 3];
        const fwd = dirEdge.get(`${a},${b}`), back = dirEdge.get(`${b},${a}`);
        if (!fwd || fwd.length !== 1 || !back || back.length !== 1) continue;   // boundary / non-manifold
        const t2 = back[0];
        if (t2 <= t1) continue;                                                 // each pair once (t1 = the earlier)
        const score = quadScore(vertices, tris, t1, t2, k, uvOf, nrmOf);
        if (score >= 0) cands.push({ t1, t2, k, score });
      }
    }
    cands.sort((p, q) => p.score - q.score || p.t1 - q.t1 || p.t2 - q.t2);
    for (const c of cands) {
      if (merged[c.t1] || merged[c.t2]) continue;
      merged[c.t1] = 1; merged[c.t2] = 1;
      const q = buildQuad(tris, c.t1, c.t2, c.k);
      polys.push({ order: c.t1, v: q.v, s: q.s });
      quads++;
    }
  }
  tris.forEach((t, ti) => { if (!merged[ti]) polys.push({ order: ti, v: [...t.v], s: [...t.s] }); });
  polys.sort((p, q) => p.order - q.order);

  // 4. Faces with corner UVs + shading.
  const faces: WeldResult['faces'] = polys.map((p) => ({
    verts: p.v,
    uvs: p.s.map(uvOf),
    smooth: isSmooth(vertices, p.v, p.s.map(nrmOf)),
  }));
  if (vertexUVs) {
    faces.forEach((f) => f.verts.forEach((v, k) => { if (!vertices[v].uv) vertices[v].uv = [f.uvs![k][0], f.uvs![k][1]]; }));
  }

  // Sharp edges: both sides smooth but the source normals differ across the edge (split normals in the source).
  const sharpEdges: Array<[number, number]> = [];
  const edgeUse = new Map<string, Array<{ f: number; k: number }>>();
  faces.forEach((f, fi) => {
    const n = f.verts.length;
    for (let k = 0; k < n; k++) {
      const a = f.verts[k], b = f.verts[(k + 1) % n];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const l = edgeUse.get(key);
      if (l) l.push({ f: fi, k }); else edgeUse.set(key, [{ f: fi, k }]);
    }
  });
  for (const [key, uses] of edgeUse) {
    if (uses.length !== 2) continue;
    const [u, w] = uses;
    if (!faces[u.f].smooth || !faces[w.f].smooth) continue;
    const nrmAt = (use: { f: number; k: number }, vert: number): [number, number, number] => {
      const p = polys[use.f], at = p.v.indexOf(vert);
      return nrmOf(p.s[at]);
    };
    const [a, b] = key.split(',').map(Number);
    if (!sameNormal(nrmAt(u, a), nrmAt(w, a)) || !sameNormal(nrmAt(u, b), nrmAt(w, b))) sharpEdges.push([a, b]);
  }

  return { vertices, faces, sharpEdges, stats: { sourceVerts: nSrc, sourceTris: nTri, degenerate, quads } };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type P3 = { x: number; y: number; z: number };

function newell(V: ArrayLike<P3>, vs: ArrayLike<number>): [number, number, number] {
  let nx = 0, ny = 0, nz = 0;
  const n = vs.length;
  for (let k = 0; k < n; k++) {
    const a = V[vs[k]], b = V[vs[(k + 1) % n]];
    nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(nx, ny, nz);
  return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
}

function sameNormal(a: [number, number, number], b: [number, number, number]): boolean {
  const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2]);
  if (la < 0.5 || lb < 0.5) return la < 0.5 && lb < 0.5;   // both missing = the same (no data)
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb) >= NORMAL_SAME_DOT;
}

/** Smooth = some corner's source normal leans away from the face normal (a missing / flipped normal never counts). */
function isSmooth(V: ArrayLike<P3>, vs: number[], normals: Array<[number, number, number]>): boolean {
  const fn = newell(V, vs);
  for (const n of normals) {
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 0.5) continue;
    const d = (n[0] * fn[0] + n[1] * fn[1] + n[2] * fn[2]) / l;
    if (d > 0 && d < NORMAL_SAME_DOT) return true;
  }
  return false;
}

/** The quad of t1 + t2 across t1's edge k (x_k → x_{k+1}), with the shared edge as its 0–2 diagonal and t1's lowest
 *  shared corner first: k = 2 → [x0, x1, x2, d]; else [x_k, d, x_{k+1}, x_{k+2}] (d = t2's third vertex). */
function buildQuad(tris: Array<{ v: number[]; s: number[] }>, t1: number, t2: number, k: number): { v: number[]; s: number[] } {
  const T = tris[t1], U = tris[t2];
  const a = T.v[k], b = T.v[(k + 1) % 3];
  const dk = U.v.findIndex((x) => x !== a && x !== b);
  const d = U.v[dk], ds = U.s[dk];
  const x = (i: number) => T.v[(k + i) % 3], xs = (i: number) => T.s[(k + i) % 3];
  if (k === 2) return { v: [T.v[0], T.v[1], T.v[2], d], s: [T.s[0], T.s[1], T.s[2], ds] };
  return { v: [x(0), d, x(1), x(2)], s: [xs(0), ds, xs(1), xs(2)] };
}

/** Score of merging t1 + t2 across t1's edge k (lower = more rectangular), or −1 when the merge is not allowed. */
function quadScore(
  V: ArrayLike<P3>, tris: Array<{ v: number[]; s: number[] }>, t1: number, t2: number, k: number,
  uvOf: (s: number) => UV2, nrmOf: (s: number) => [number, number, number],
): number {
  const T = tris[t1], U = tris[t2];
  const a = T.v[k], b = T.v[(k + 1) % 3];
  // seamless: the same UV and normal on both sides at both shared vertices
  for (const vert of [a, b]) {
    const sa = T.s[T.v.indexOf(vert)], sb = U.s[U.v.indexOf(vert)];
    const ua = uvOf(sa), ub = uvOf(sb);
    if (Math.abs(ua[0] - ub[0]) > UV_SAME || Math.abs(ua[1] - ub[1]) > UV_SAME) return -1;
    if (!sameNormal(nrmOf(sa), nrmOf(sb))) return -1;
  }
  // planar
  const n1 = newell(V, T.v), n2 = newell(V, U.v);
  const dDot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
  if (!(Math.hypot(...n1) > 0) || !(Math.hypot(...n2) > 0)) return -1;
  const dihedral = Math.acos(Math.min(1, Math.max(-1, dDot))) * 180 / Math.PI;
  if (dihedral > QUAD_MAX_DIHEDRAL_DEG) return -1;
  // convex + near-rectangular
  const q = buildQuad(tris, t1, t2, k).v;
  const qn = newell(V, q);
  let dev = 0;
  for (let i = 0; i < 4; i++) {
    const p = V[q[i]], pa = V[q[(i + 3) % 4]], pb = V[q[(i + 1) % 4]];
    const ax = pa.x - p.x, ay = pa.y - p.y, az = pa.z - p.z, bx = pb.x - p.x, by = pb.y - p.y, bz = pb.z - p.z;
    // turn direction at this corner vs the quad normal (convexity): (p − pa) × (pb − p) · n > 0
    const ex = -ax, ey = -ay, ez = -az;
    const cx = ey * bz - ez * by, cy = ez * bx - ex * bz, cz = ex * by - ey * bx;
    if (cx * qn[0] + cy * qn[1] + cz * qn[2] <= 0) return -1;
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
    if (!(la > 0 && lb > 0)) return -1;
    const ang = Math.acos(Math.min(1, Math.max(-1, (ax * bx + ay * by + az * bz) / (la * lb)))) * 180 / Math.PI;
    const dv = Math.abs(ang - 90);
    if (dv > QUAD_MAX_CORNER_DEV_DEG) return -1;
    dev += dv;
  }
  return dev + dihedral;
}
