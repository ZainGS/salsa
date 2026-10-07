/**
 * BEVEL / CHAMFER for the Edit Mesh (docs/specs/edit-mesh-topology.md §8) — Blender's bevel, for vertices and edges.
 *
 * Pure topology function: face lists in → face lists out (EditMesh.bevel applies the result). The AMOUNT is a distance
 * ALONG THE EDGES (object units), CLAMPED so no cut passes a neighbouring vertex or overlaps another cut ("clamp
 * overlap": an edge cut from both ends gets at most half its length) — {@link bevelLimit}.
 *
 * Vertex chamfer: every corner of a selected vertex is replaced by the points at `amount` along its two edges; the hole
 * they leave is capped (a cube corner → a triangle; n incident edges → an n-gon). Segments > 1 round the cut inside
 * each face (a circular profile toward the old corner).
 *
 * Edge bevel: each selected edge becomes a strip of `segments` quads between the two faces it joined (1 = flat
 * chamfer, > 1 = a circular profile — the strip is shaded smooth). At each end vertex the corners are re-cut the way
 * Blender's vertex mesh does it, so NO corner is left open:
 *  - a face corner between two beveled edges takes their MEET point (the parallelogram corner `amount` along both);
 *  - a face corner next to one beveled edge takes the point `amount` along its other (non-beveled) edge — that edge's
 *    point is shared by the faces on both of its sides;
 *  - the old vertex stays only when some non-beveled edge at it gets no point (a terminal edge on a valence-4+ vertex);
 *    else it is removed and a face between two non-beveled edges takes both points plus the strip's end profile (a
 *    single cube edge: the end faces become pentagons, Blender's result);
 *  - whatever hole is left around the vertex (several strips meeting, a kept vertex) is capped with one polygon (the
 *    "cutoff" vertex mesh), fanned to a centre point when it is a curved ring (segments > 1).
 *
 * Corner attributes: a face keeps the UV / colour of its untouched corners (and their custom normals); a new point in a
 * face gets that face's attributes interpolated along its edge (profile points: the same conic in attribute space, so
 * a planar UV map stays exact); strips interpolate between the two faces they join; caps take the points' attributes.
 * New corners carry no custom normal (computed).
 */

import type { FaceList, RGBA, N3 } from './edit-mesh';

type UV = [number, number];
type P3 = { x: number; y: number; z: number };

export interface BevelVertex { x: number; y: number; z: number; color: RGBA; uv?: UV }

export interface BevelSpec {
  /** Vertex chamfer: cut these corners off. */
  vertices?: number[];
  /** Edge bevel: these edges (undirected vertex pairs). Ignored when `vertices` is given. */
  edges?: Array<[number, number]>;
  /** Distance along the edges (object units). Clamped to {@link bevelLimit}. */
  amount: number;
  /** 1 = flat chamfer; > 1 = rounded (default 1, at most 32). */
  segments?: number;
}

export interface BevelBuild {
  /** The full new vertex array (removed vertices dropped, new points appended after the kept ones). */
  vertices: BevelVertex[];
  /** The full new face list (the old faces in order — rebuilt where they touched the bevel — then strips, then caps). */
  faces: FaceList[];
  /** Old vertex index → new (−1 = removed). */
  remap: Int32Array;
  /** Indices (in `faces`) of the strip + cap faces. */
  newFaces: number[];
  /** Old edges that were split by a cut: [oldA, oldB, chain of NEW vertex indices from the A end to the B end] — the
   *  caller hands the edge's seam / sharp flag to every piece. */
  splitChains: Array<[number, number, number[]]>;
  /** The (clamped) amount used. */
  amount: number;
}

export interface BevelGuide {
  /** The vertex (vertex chamfer) or the edge midpoint (edge bevel), object space. */
  origin: [number, number, number];
  /** Unit inward direction: the normalised average of the incident edge directions (vertex), or of the two faces'
   *  inward perpendiculars (edge) — the "bisector" the guide line is drawn along. */
  dir: [number, number, number];
  /** How far the cut moves along `dir` per unit of amount (≈ the mean cosine between the cut edges and `dir`). */
  along: number;
}

const MAX_SEGMENTS = 32;
/** A cut may run to this fraction of its limit (an exact meeting would leave zero-length edges). */
const CLAMP_FRACTION = 0.995;

// ── Analysis ──────────────────────────────────────────────────────────────────

interface Corner { f: number; k: number; p: number; q: number }

interface Analysis {
  vertexMode: boolean;
  /** Bevel vertices (chamfered vertices / the beveled edges' end vertices). */
  vs: Set<number>;
  /** Undirected beveled edge keys (edge mode). */
  bev: Set<number>;
  /** Corners of each bevel vertex. */
  corners: Map<number, Corner[]>;
  /** Directed "v→x" keys of the edge points E(v, x). */
  needE: Set<number>;
  /** Bevel vertices that survive (edge mode: some non-beveled edge at it gets no point). */
  kept: Set<number>;
  /** Max amount (clamp overlap). */
  limit: number;
  key: (a: number, b: number) => number;
  dkey: (a: number, b: number) => number;
}

function analyse(V: ArrayLike<P3>, F: ArrayLike<number[]>, spec: BevelSpec): Analysis | null {
  const N = V.length;
  const key = (a: number, b: number): number => (a < b ? a * N + b : b * N + a);
  const dkey = (a: number, b: number): number => a * N + b;
  // directed edge uses (manifold check for beveled edges)
  const dir = new Map<number, number>();
  for (let f = 0; f < F.length; f++) {
    const L = F[f], n = L.length;
    for (let k = 0; k < n; k++) { const d = dkey(L[k], L[(k + 1) % n]); dir.set(d, (dir.get(d) ?? 0) + 1); }
  }
  const vertexMode = !!spec.vertices && spec.vertices.length > 0;
  const bev = new Set<number>();
  const vs = new Set<number>();
  if (vertexMode) {
    for (const v of spec.vertices!) if (v >= 0 && v < N) vs.add(v);
  } else {
    for (const [a, b] of spec.edges ?? []) {
      if (a === b || !(a >= 0 && a < N && b >= 0 && b < N)) continue;
      if (dir.get(dkey(a, b)) !== 1 || dir.get(dkey(b, a)) !== 1) continue;   // interior, manifold edges only
      bev.add(key(a, b)); vs.add(a); vs.add(b);
    }
  }
  if (vs.size === 0) return null;

  const corners = new Map<number, Corner[]>();
  for (const v of vs) corners.set(v, []);
  for (let f = 0; f < F.length; f++) {
    const L = F[f], n = L.length;
    for (let k = 0; k < n; k++) {
      const list = corners.get(L[k]);
      if (list) list.push({ f, k, p: L[(k + n - 1) % n], q: L[(k + 1) % n] });
    }
  }
  for (const [v, list] of corners) if (list.length === 0) { vs.delete(v); corners.delete(v); }
  if (vs.size === 0) return null;

  const isB = (a: number, b: number): boolean => bev.has(key(a, b));
  const needE = new Set<number>();
  const kept = new Set<number>();
  // offsets used along each undirected edge, by end ("how many cuts share this edge")
  const ends = new Map<number, Set<number>>();
  const use = (v: number, x: number): void => { const k = key(v, x); (ends.get(k) ?? ends.set(k, new Set()).get(k)!).add(v); };
  for (const [v, list] of corners) {
    const incident = new Set<number>();
    for (const c of list) { incident.add(c.p); incident.add(c.q); }
    if (vertexMode) {
      for (const x of incident) { needE.add(dkey(v, x)); use(v, x); }
      continue;
    }
    for (const c of list) {
      const bp = isB(v, c.p), bq = isB(v, c.q);
      if (bp && !bq) needE.add(dkey(v, c.q));
      if (bq && !bp) needE.add(dkey(v, c.p));
      if (bp && bq) { use(v, c.p); use(v, c.q); }   // the meet point runs along both
    }
    for (const x of incident) {
      if (isB(v, x)) continue;
      if (needE.has(dkey(v, x))) use(v, x);
      else kept.add(v);                              // a non-beveled edge with no point: the vertex anchors it
    }
  }
  let limit = Infinity;
  for (const [k, who] of ends) {
    const a = Math.floor(k / N), b = k - a * N;
    const L = dist(V[a], V[b]);
    limit = Math.min(limit, (L / who.size) * CLAMP_FRACTION);
  }
  if (!Number.isFinite(limit)) limit = 0;
  return { vertexMode, vs, bev, corners, needE, kept, limit, key, dkey };
}

/** The largest amount the bevel can take (clamp overlap), 0 when nothing can be beveled. */
export function bevelLimit(V: ArrayLike<P3>, F: ArrayLike<number[]>, spec: BevelSpec): number {
  return analyse(V, F, spec)?.limit ?? 0;
}

/** The guide (origin + inward direction) per bevel target — what the tool draws and maps the drag onto. */
export function bevelGuides(V: ArrayLike<P3>, F: ArrayLike<number[]>, spec: BevelSpec): BevelGuide[] {
  const a = analyse(V, F, spec);
  if (!a) return [];
  const out: BevelGuide[] = [];
  if (a.vertexMode) {
    for (const [v, list] of a.corners) {
      const P = V[v];
      const xs = new Set<number>();
      for (const c of list) { xs.add(c.p); xs.add(c.q); }
      let dx = 0, dy = 0, dz = 0;
      const us: P3[] = [];
      for (const x of xs) { const u = unit(sub(V[x], P)); us.push(u); dx += u.x; dy += u.y; dz += u.z; }
      const d = unit({ x: dx, y: dy, z: dz });
      let along = 0;
      for (const u of us) along += u.x * d.x + u.y * d.y + u.z * d.z;
      out.push({ origin: [P.x, P.y, P.z], dir: [d.x, d.y, d.z], along: Math.max(0.2, along / (us.length || 1)) });
    }
    return out;
  }
  // edge: the two faces' inward perpendiculars at the midpoint
  const seen = new Set<number>();
  for (let f = 0; f < F.length; f++) {
    const L = F[f], n = L.length;
    for (let k = 0; k < n; k++) {
      const s = L[k], t = L[(k + 1) % n], key = a.key(s, t);
      if (!a.bev.has(key) || seen.has(key)) continue;
      seen.add(key);
      // the other face on this edge
      let g = -1;
      for (let h = 0; h < F.length && g < 0; h++) {
        if (h === f) continue;
        const M = F[h];
        for (let j = 0; j < M.length; j++) if (M[j] === t && M[(j + 1) % M.length] === s) { g = h; break; }
      }
      const A = V[s], B = V[t];
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 };
      const e = unit(sub(B, A));
      const inward = (fi: number): P3 => {
        const c = centroid(V, F[fi]);
        const w = sub(c, mid), d = w.x * e.x + w.y * e.y + w.z * e.z;
        return unit({ x: w.x - e.x * d, y: w.y - e.y * d, z: w.z - e.z * d });
      };
      const p1 = inward(f), p2 = g >= 0 ? inward(g) : p1;
      const d = unit({ x: p1.x + p2.x, y: p1.y + p2.y, z: p1.z + p2.z });
      const along = Math.max(0.2, ((p1.x + p2.x) * d.x + (p1.y + p2.y) * d.y + (p1.z + p2.z) * d.z) / 2);
      out.push({ origin: [mid.x, mid.y, mid.z], dir: [d.x, d.y, d.z], along });
    }
  }
  return out;
}

// ── Build ─────────────────────────────────────────────────────────────────────

/** Interpolatable corner attributes (resolved: a corner's own value, else its vertex's). */
interface Attr { uv?: UV; col: RGBA }

function lerpA(a: Attr, b: Attr, t: number): Attr {
  return {
    uv: a.uv && b.uv ? [a.uv[0] + (b.uv[0] - a.uv[0]) * t, a.uv[1] + (b.uv[1] - a.uv[1]) * t] : a.uv ?? b.uv,
    col: [0, 1, 2, 3].map(i => a.col[i] + (b.col[i] - a.col[i]) * t) as RGBA,
  };
}

/** a + (p − a)·s + (q − a)·t (the meet point's parallelogram, in attribute space). */
function parA(a: Attr, p: Attr, q: Attr, s: number, t: number): Attr {
  return {
    uv: a.uv && p.uv && q.uv ? [a.uv[0] + (p.uv[0] - a.uv[0]) * s + (q.uv[0] - a.uv[0]) * t, a.uv[1] + (p.uv[1] - a.uv[1]) * s + (q.uv[1] - a.uv[1]) * t] : a.uv,
    col: [0, 1, 2, 3].map(i => a.col[i] + (p.col[i] - a.col[i]) * s + (q.col[i] - a.col[i]) * t) as RGBA,
  };
}

/** The rational quadratic Bézier X → (control C, weight w) → Y at t: a circular arc when |CX| = |CY| and w = sin(φ/2)
 *  (φ = the angle X C Y). Applied to positions and, with the same weights, to attributes. */
function conicW(t: number, w: number): [number, number, number] {
  const b0 = (1 - t) * (1 - t), b1 = 2 * t * (1 - t) * w, b2 = t * t, s = b0 + b1 + b2;
  return [b0 / s, b1 / s, b2 / s];
}
function conicA(x: Attr, c: Attr, y: Attr, t: number, w: number): Attr {
  const [k0, k1, k2] = conicW(t, w);
  return {
    uv: x.uv && c.uv && y.uv ? [x.uv[0] * k0 + c.uv[0] * k1 + y.uv[0] * k2, x.uv[1] * k0 + c.uv[1] * k1 + y.uv[1] * k2] : x.uv ?? y.uv,
    col: [0, 1, 2, 3].map(i => x.col[i] * k0 + c.col[i] * k1 + y.col[i] * k2) as RGBA,
  };
}

/** A FaceList (local twin of edit-mesh.ts `faceList`, kept here so this module has no runtime import of it). */
function mkFace(verts: number[], uvs: Array<UV | undefined> | null, smooth: boolean | undefined, cols: Array<RGBA | undefined> | null, nrms: Array<N3 | undefined> | null): FaceList {
  const f = verts as FaceList;
  if (uvs && uvs.some(u => u !== undefined)) f.uvs = uvs.map(u => (u ? [u[0], u[1]] as UV : undefined));
  if (smooth) f.smooth = true;
  if (cols && cols.some(c => c !== undefined)) f.cols = cols.map(c => (c ? [c[0], c[1], c[2], c[3]] as RGBA : undefined));
  if (nrms && nrms.some(c => c !== undefined)) f.nrms = nrms.map(c => (c ? [c[0], c[1], c[2]] as N3 : undefined));
  return f;
}

export function buildBevel(V: ReadonlyArray<BevelVertex>, F: ReadonlyArray<FaceList>, spec: BevelSpec): BevelBuild | null {
  const an = analyse(V, F, spec);
  if (!an) return null;
  const d = Math.min(Math.max(0, spec.amount), an.limit);
  if (!(d > 0)) return null;
  const segs = Math.max(1, Math.min(MAX_SEGMENTS, Math.round(spec.segments ?? 1)));
  const { vertexMode, vs, corners, needE, kept, dkey, key } = an;
  const isB = (a: number, b: number): boolean => an.bev.has(key(a, b));
  const anyUV = F.some(f => !!f.uvs), anyCol = F.some(f => !!f.cols);

  // New points live after the old vertices (old index space), compacted at the end.
  const pts: BevelVertex[] = [];
  const P = (id: number): BevelVertex => (id < V.length ? V[id] : pts[id - V.length]);
  const owner = new Map<number, number>();   // new point → its bevel vertex (the region the cap search uses)
  const addPt = (v: number, p: P3, col: RGBA, uv: UV | undefined): number => {
    const id = V.length + pts.length;
    pts.push({ x: p.x, y: p.y, z: p.z, color: col, uv });
    owner.set(id, v);
    return id;
  };
  const vAttr = (v: number): Attr => ({ uv: V[v].uv, col: V[v].color });

  // E(v, x): the point `d` along edge v → x (shared by the faces on both sides of the edge).
  const eIds = new Map<number, number>();
  const ptE = (v: number, x: number): number => {
    const k = dkey(v, x);
    let id = eIds.get(k);
    if (id === undefined) {
      const L = dist(V[v], V[x]), t = L > 0 ? d / L : 0;
      const a = lerpA(vAttr(v), vAttr(x), t);
      id = addPt(v, lerpP(V[v], V[x], t), a.col, V[v].uv && V[x].uv ? a.uv : undefined);
      eIds.set(k, id);
    }
    return id;
  };
  // M(f, v): the meet point of face f's corner at v between two beveled edges.
  const mIds = new Map<string, number>();
  const ptM = (f: number, v: number, p: number, q: number): number => {
    const k = `${f}:${v}`;
    let id = mIds.get(k);
    if (id === undefined) {
      const Lp = dist(V[v], V[p]), Lq = dist(V[v], V[q]);
      const s = Lp > 0 ? d / Lp : 0, t = Lq > 0 ? d / Lq : 0;
      const pos = { x: V[v].x + (V[p].x - V[v].x) * s + (V[q].x - V[v].x) * t, y: V[v].y + (V[p].y - V[v].y) * s + (V[q].y - V[v].y) * t, z: V[v].z + (V[p].z - V[v].z) * s + (V[q].z - V[v].z) * t };
      const a = parA(vAttr(v), vAttr(p), vAttr(q), s, t);
      id = addPt(v, pos, a.col, V[v].uv && V[p].uv && V[q].uv ? a.uv : undefined);
      mIds.set(k, id);
    }
    return id;
  };
  // Profiles: interior points of the arc X → Y around bevel vertex v (shared by everything that borders it).
  const profW = (v: number, X: number, Y: number): number => {
    const a = unit(sub(P(X), V[v])), b = unit(sub(P(Y), V[v]));
    const cos = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
    return Math.sin(Math.acos(cos) / 2);
  };
  const profIds = new Map<string, number[]>();
  const profile = (v: number, X: number, Y: number): number[] => {
    if (segs <= 1) return [];
    const lo = Math.min(X, Y), hi = Math.max(X, Y), k = `${v}:${lo}:${hi}`;
    let ids = profIds.get(k);
    if (!ids) {
      ids = [];
      const w = profW(v, lo, hi), A = P(lo), B = P(hi), C = V[v];
      for (let i = 1; i < segs; i++) {
        const [k0, k1, k2] = conicW(i / segs, w);
        const pos = { x: A.x * k0 + C.x * k1 + B.x * k2, y: A.y * k0 + C.y * k1 + B.y * k2, z: A.z * k0 + C.z * k1 + B.z * k2 };
        const at = conicA({ uv: A.uv, col: A.color }, vAttr(v), { uv: B.uv, col: B.color }, i / segs, w);
        ids.push(addPt(v, pos, at.col, A.uv && B.uv && C.uv ? at.uv : undefined));
      }
      profIds.set(k, ids);
    }
    return X === lo ? ids : [...ids].reverse();
  };

  // Strip end pairs (edge mode), to know which corner of a "both non-beveled" face takes a profile.
  // Per corner: the single point that replaces it when it touches a beveled edge.
  const single = new Map<string, number>();   // `${f}:${v}` → point
  if (!vertexMode) {
    for (const [v, list] of corners) {
      for (const c of list) {
        const bp = isB(v, c.p), bq = isB(v, c.q);
        if (bp && bq) single.set(`${c.f}:${v}`, ptM(c.f, v, c.p, c.q));
        else if (bp) single.set(`${c.f}:${v}`, ptE(v, c.q));
        else if (bq) single.set(`${c.f}:${v}`, ptE(v, c.p));
      }
    }
  }
  const stripEnds = new Set<string>();   // `${v}:${lo}:${hi}` — X/Y pairs that end a strip at v
  if (!vertexMode) {
    for (const [v, list] of corners) {
      for (const c of list) {
        if (!isB(v, c.q)) continue;   // the beveled edge v → q of face c.f; its other face has q → v
        const other = corners.get(v)!.find(o => o.f !== c.f && o.p === c.q);
        if (!other) continue;
        const X = single.get(`${c.f}:${v}`)!, Y = single.get(`${other.f}:${v}`)!;
        stripEnds.add(`${v}:${Math.min(X, Y)}:${Math.max(X, Y)}`);
      }
    }
  }

  // ── 1. Rebuild every face that has a corner at a bevel vertex ──────────────
  const faceAttr = new Map<string, Attr>();      // `${f}:${point}` → that face's attributes at the point
  const pointAttr = new Map<number, Attr>();     // point → the first face's attributes there (caps)
  const touched = new Set<number>();
  for (const list of corners.values()) for (const c of list) touched.add(c.f);
  const out: FaceList[] = [];
  for (let f = 0; f < F.length; f++) {
    const src = F[f];
    if (!touched.has(f)) { out.push(src); continue; }
    const n = src.length;
    const A = (k: number): Attr => ({ uv: src.uvs?.[(k + n) % n] ?? V[src[(k + n) % n]].uv, col: src.cols?.[(k + n) % n] ?? V[src[(k + n) % n]].color });
    const verts: number[] = [], uvs: Array<UV | undefined> = [], cols: Array<RGBA | undefined> = [], nrms: Array<N3 | undefined> = [];
    const push = (id: number, at: Attr, nrm?: N3): void => {
      verts.push(id); uvs.push(at.uv); cols.push(at.col); nrms.push(nrm);
      faceAttr.set(`${f}:${id}`, at);
      if (!pointAttr.has(id)) pointAttr.set(id, at);
    };
    for (let k = 0; k < n; k++) {
      const v = src[k];
      if (!vs.has(v)) { push(v, A(k), src.nrms?.[k]); continue; }
      const p = src[(k + n - 1) % n], q = src[(k + 1) % n];
      const Lp = dist(V[v], V[p]), Lq = dist(V[v], V[q]);
      const atE = (x: number, kx: number, L: number): Attr => lerpA(A(k), A(kx), L > 0 ? d / L : 0);
      const pushE = (x: number, kx: number, L: number): number => { const id = ptE(v, x); push(id, atE(x, kx, L)); return id; };
      const pushProfile = (X: number, aX: Attr, Y: number, aY: Attr): void => {
        const ids = profile(v, X, Y);
        if (!ids.length) return;
        const w = profW(v, X, Y);
        ids.forEach((id, i) => push(id, conicA(aX, A(k), aY, (i + 1) / segs, w)));
      };
      if (vertexMode) {
        const X = ptE(v, p), Y = ptE(v, q), aX = atE(p, k - 1, Lp), aY = atE(q, k + 1, Lq);
        push(X, aX); pushProfile(X, aX, Y, aY); push(Y, aY);
        continue;
      }
      const bp = isB(v, p), bq = isB(v, q);
      if (bp && bq) {
        const id = single.get(`${f}:${v}`)!;
        push(id, parA(A(k), A(k - 1), A(k + 1), Lp > 0 ? d / Lp : 0, Lq > 0 ? d / Lq : 0));
      } else if (bp) pushE(q, k + 1, Lq);
      else if (bq) pushE(p, k - 1, Lp);
      else {
        const hasP = needE.has(dkey(v, p)), hasQ = needE.has(dkey(v, q));
        if (kept.has(v)) {
          if (hasP) pushE(p, k - 1, Lp);
          push(v, A(k), src.nrms?.[k]);
          if (hasQ) pushE(q, k + 1, Lq);
        } else {
          const X = ptE(v, p), Y = ptE(v, q), aX = atE(p, k - 1, Lp), aY = atE(q, k + 1, Lq);
          push(X, aX);
          if (stripEnds.has(`${v}:${Math.min(X, Y)}:${Math.max(X, Y)}`)) pushProfile(X, aX, Y, aY);
          push(Y, aY);
        }
      }
    }
    out.push(mkFace(verts, src.uvs || anyUV ? uvs : null, src.smooth, src.cols ? cols : null, src.nrms ? nrms : null));
  }

  // ── 2. Strips (edge mode) ───────────────────────────────────────────────────
  const newFaces: number[] = [];
  if (!vertexMode) {
    const doneStrip = new Set<number>();
    for (let f = 0; f < F.length; f++) {
      const L = F[f], n = L.length;
      for (let k = 0; k < n; k++) {
        const a = L[k], b = L[(k + 1) % n];
        if (!isB(a, b) || doneStrip.has(key(a, b))) continue;
        doneStrip.add(key(a, b));
        // face f has a → b; the other face g has b → a
        const g = corners.get(a)!.find(o => o.f !== f && o.p === b)?.f;
        if (g === undefined) continue;
        const Xa = single.get(`${f}:${a}`), Xb = single.get(`${f}:${b}`), Ya = single.get(`${g}:${a}`), Yb = single.get(`${g}:${b}`);
        if (Xa === undefined || Xb === undefined || Ya === undefined || Yb === undefined) continue;
        const pa = [Xa, ...profile(a, Xa, Ya), Ya], pb = [Xb, ...profile(b, Xb, Yb), Yb];
        const aXa = faceAttr.get(`${f}:${Xa}`)!, aXb = faceAttr.get(`${f}:${Xb}`)!, aYa = faceAttr.get(`${g}:${Ya}`)!, aYb = faceAttr.get(`${g}:${Yb}`)!;
        const smooth = segs > 1 || (!!F[f].smooth && !!F[g].smooth);
        for (let i = 0; i < segs; i++) {
          const t0 = i / segs, t1 = (i + 1) / segs;
          const at = [lerpA(aXb, aYb, t0), lerpA(aXa, aYa, t0), lerpA(aXa, aYa, t1), lerpA(aXb, aYb, t1)];
          const vq = [pb[i], pa[i], pa[i + 1], pb[i + 1]];
          vq.forEach((id, j) => { if (!pointAttr.has(id)) pointAttr.set(id, at[j]); });
          newFaces.push(out.length);
          out.push(mkFace(vq, anyUV ? at.map(x => x.uv) : null, smooth, anyCol ? at.map(x => x.col) : null, null));
        }
      }
    }
  }

  // ── 3. Caps: every hole left around a bevel vertex, closed with one polygon ─
  const region = (id: number): number => (owner.get(id) ?? (vs.has(id) && (vertexMode ? false : kept.has(id)) ? id : -1));
  const directed = new Set<number>();
  const M = V.length + pts.length;
  const dk = (a: number, b: number): number => a * M + b;
  for (const f of out) for (let k = 0; k < f.length; k++) directed.add(dk(f[k], f[(k + 1) % f.length]));
  const nextOf = new Map<number, number>();
  for (const f of out) {
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      if (directed.has(dk(b, a))) continue;              // twinned
      const ra = region(a), rb = region(b);
      if (ra < 0 || ra !== rb) continue;                  // a real boundary, or not this bevel's
      nextOf.set(b, a);                                   // the hole runs opposite to the faces around it
    }
  }
  const usedHole = new Set<number>();
  for (const start of nextOf.keys()) {
    if (usedHole.has(start)) continue;
    const ring: number[] = [];
    let cur: number | undefined = start, closed = false;
    for (let g = 0; g < 4096 && cur !== undefined; g++) {
      if (usedHole.has(cur)) break;
      usedHole.add(cur); ring.push(cur);
      cur = nextOf.get(cur);
      if (cur === start) { closed = true; break; }
    }
    if (!closed || ring.length < 3) continue;
    const v = region(ring[0]);
    const at = ring.map(id => pointAttr.get(id) ?? { uv: P(id).uv, col: P(id).color });
    // a cap is smooth when rounded, else like the faces it cuts into
    const smoothCap = segs > 1 || (corners.get(v)?.every(c => !!F[c.f].smooth) ?? false);
    if (segs > 1 && ring.length > 4 && !planar(ring.map(P))) {
      // curved ring: fan to a centre point pushed toward the old corner as far as an arc midpoint bulges
      const c = centroid(ring.map(P), ring.map((_, i) => i));
      const V0 = V[v] ?? c;
      const bulge = conicW(0.5, profW(v, ring[0], ring[Math.floor(ring.length / 2)]))[1];
      const cp = { x: c.x + (V0.x - c.x) * bulge, y: c.y + (V0.y - c.y) * bulge, z: c.z + (V0.z - c.z) * bulge };
      const ca: Attr = {
        uv: at.every(a => a.uv) ? [at.reduce((s, a) => s + a.uv![0], 0) / at.length, at.reduce((s, a) => s + a.uv![1], 0) / at.length] : undefined,
        col: [0, 1, 2, 3].map(i => at.reduce((s, a) => s + a.col[i], 0) / at.length) as RGBA,
      };
      const center = addPt(v, cp, ca.col, ca.uv);
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        newFaces.push(out.length);
        out.push(mkFace([ring[i], ring[j], center], anyUV ? [at[i].uv, at[j].uv, ca.uv] : null, true, anyCol ? [at[i].col, at[j].col, ca.col] : null, null));
      }
    } else {
      newFaces.push(out.length);
      out.push(mkFace(ring, anyUV ? at.map(a => a.uv) : null, smoothCap, anyCol ? at.map(a => a.col) : null, null));
    }
  }

  // ── 4. Compact: drop removed vertices, renumber ─────────────────────────────
  const remap = new Int32Array(V.length).fill(-1);
  const vertsOut: BevelVertex[] = [];
  for (let i = 0; i < V.length; i++) {
    if (vs.has(i) && !(kept.has(i) && !vertexMode)) continue;
    remap[i] = vertsOut.length; vertsOut.push(V[i]);
  }
  const ptBase = vertsOut.length;
  for (const p of pts) vertsOut.push(p);
  const nid = (id: number): number => (id < V.length ? remap[id] : ptBase + (id - V.length));
  const faces = out.map(f => {
    const g = f.map(nid) as FaceList;
    if (f.uvs) g.uvs = f.uvs; if (f.cols) g.cols = f.cols; if (f.nrms) g.nrms = f.nrms; if (f.smooth) g.smooth = true;
    return g;
  });
  // split edges: old (v, x) → its pieces (for the seam / sharp hand-over)
  const splitChains: Array<[number, number, number[]]> = [];
  const doneEdge = new Set<number>();
  for (const dk2 of needE) {
    const v = Math.floor(dk2 / V.length), x = dk2 - v * V.length;
    const ek = key(v, x);
    if (doneEdge.has(ek)) continue;
    doneEdge.add(ek);
    const chain: number[] = [];
    if (remap[v] >= 0) chain.push(remap[v]);
    chain.push(nid(eIds.get(dkey(v, x))!));
    if (eIds.has(dkey(x, v))) chain.push(nid(eIds.get(dkey(x, v))!));
    if (remap[x] >= 0) chain.push(remap[x]);
    splitChains.push([v, x, chain]);
  }
  return { vertices: vertsOut, faces, remap, newFaces, splitChains, amount: d };
}

// ── Small vector helpers ──────────────────────────────────────────────────────

function sub(a: P3, b: P3): P3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function dist(a: P3, b: P3): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function unit(a: P3): P3 { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; }
function lerpP(a: P3, b: P3, t: number): P3 { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }; }
function centroid(V: ArrayLike<P3>, idx: ArrayLike<number>): P3 {
  let x = 0, y = 0, z = 0;
  const n = idx.length || 1;
  for (let i = 0; i < idx.length; i++) { const p = V[idx[i]]; x += p.x; y += p.y; z += p.z; }
  return { x: x / n, y: y / n, z: z / n };
}
/** Every point within 0.1 % of the ring's size from its Newell plane. */
function planar(ps: P3[]): boolean {
  let nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < ps.length; k++) {
    const a = ps[k], b = ps[(k + 1) % ps.length];
    nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 0)) return true;
  nx /= l; ny /= l; nz /= l;
  const c = centroid(ps, ps.map((_, i) => i));
  let size = 0;
  for (const p of ps) size = Math.max(size, dist(p, c));
  for (const p of ps) if (Math.abs((p.x - c.x) * nx + (p.y - c.y) * ny + (p.z - c.z) * nz) > size * 1e-3) return false;
  return true;
}
