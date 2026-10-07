/**
 * KNIFE (polyline) for the Edit Mesh (UI review 2026-10-07 §4 — the Knife tool of the Edit Mesh tool strip).
 *
 * Pure topology function: face lists in → face lists out (EditMesh.knifeCutPath applies the result). The input is the
 * tapped points ON THE SURFACE (object space + the face each lies in, in order). Between two consecutive points the cut
 * follows the surface along ONE cutting plane — the plane through both points that contains the view ray (perspective:
 * the eye; orthographic: the view direction), so the cut is the straight line the user drew on screen; with no view it
 * contains the faces' average normal. The walk goes face to face: from the current point it finds where the plane leaves
 * the current face (an edge point, or a vertex the plane passes through) in the direction of the next point, crosses to
 * the face on the other side, and stops in the face that holds the next point.
 *
 * Each face the path crosses EDGE TO EDGE (or vertex to vertex / edge to vertex) is split in two along the path; tapped
 * points inside a face become new vertices on the split (a bend inside the face). The faces beside a cut edge take its
 * new vertex too (EditMesh inserts it), so a closed mesh stays closed. Corner UVs / colours: a point on an edge takes the
 * face's corners interpolated along that edge, a point inside a face is interpolated over the face (fan triangle in its
 * plane — exact for a planar, linearly mapped face); untouched corners keep everything (incl. custom normals).
 *
 * Limits (documented in docs/reviews/section4-engine-api.md):
 *  - the faces are treated as PLANAR polygons (a strongly non-planar n-gon cuts along its Newell plane approximation);
 *  - a path's dangling ends — the part from the first tapped point to the first edge it crosses, and from the last edge
 *    to the last point, when those points lie INSIDE a face — are not cut (the half-edge mesh has no loose "wire"
 *    edges); tap on / next to an edge or vertex (the tool snaps) to start / end the cut exactly there;
 *  - a path that enters the same face twice, or bends on a face's boundary and continues inside the same face, is
 *    refused (null) rather than producing a partial cut.
 */

import type { FaceList, RGBA } from './edit-mesh';

type UV = [number, number];
type V3 = [number, number, number];

export interface KnifeVertex { x: number; y: number; z: number; color: RGBA; uv?: UV }

/** One tapped knife point: object-space position + the face it lies in. */
export interface KnifePoint { face: number; x: number; y: number; z: number }

export interface KnifeOptions {
  /** Perspective view: the eye (object space) — each segment cuts along the plane through both points and the eye. */
  eye?: V3 | null;
  /** Orthographic view: the view direction (object space). Ignored when `eye` is set. */
  viewDir?: V3 | null;
  /** A point within this distance (object units) of a vertex / edge of its face snaps onto it. Default 1e-6 × the
   *  mesh's bounding-box diagonal (only exact hits snap). */
  snap?: number;
}

export interface KnifeBuild {
  /** The vertices appended by the cut (indices continue after the input vertices). */
  vertices: KnifeVertex[];
  /** Every face after the cut (split faces replaced in place by their two halves, the second appended at the end). */
  faces: FaceList[];
  /** Undirected edge key "lo,hi" → its new vertex (at `t` from `vA`) — for EditMesh._insertEdgePoints. */
  points: Map<string, { idx: number; vA: number; t: number }>;
  /** [a, b, mid] for each edge the cut split (seam / sharp flags hand over to both pieces). */
  splitEdges: Array<[number, number, number]>;
  /** Number of faces split. */
  splitFaces: number;
}

/** A point of the cut: an existing vertex, a point on an edge (t from `a`), or a point inside a face. */
type KP =
  | { kind: 'v'; v: number; p: V3 }
  | { kind: 'e'; a: number; b: number; t: number; p: V3 }
  | { kind: 'f'; f: number; p: V3 };

type Step = { face: number; from: KP; to: KP };

const key = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lerpUV = (a: UV | undefined, b: UV | undefined, t: number): UV | undefined =>
  a && b ? [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] : (a ? [a[0], a[1]] : b ? [b[0], b[1]] : undefined);
const lerpCol = (a: RGBA, b: RGBA, t: number): RGBA =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];

/** A FaceList over `verts` with corner UVs / colours (each only when the source face had them) and its shading. */
function mkFace(verts: number[], uvs: Array<UV | undefined> | null, cols: RGBA[] | null, smooth?: boolean): FaceList {
  const f = verts as FaceList;
  if (uvs && uvs.some(u => u !== undefined)) f.uvs = uvs.map(u => (u ? [u[0], u[1]] as UV : undefined));
  if (cols) f.cols = cols.map(c => [c[0], c[1], c[2], c[3]] as RGBA);
  if (smooth) f.smooth = true;
  return f;
}

/** Newell normal (unit; +Z when degenerate) of a face's vertex loop. */
function faceNormal(verts: KnifeVertex[], f: number[]): V3 {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < f.length; k++) {
    const p = verts[f[k]], q = verts[f[(k + 1) % f.length]];
    x += (p.y - q.y) * (p.z + q.z); y += (p.z - q.z) * (p.x + q.x); z += (p.x - q.x) * (p.y + q.y);
  }
  const l = Math.hypot(x, y, z);
  return l > 1e-15 ? [x / l, y / l, z / l] : [0, 0, 1];
}

/**
 * Barycentric weights of `p` over the face's fan triangle (0, k, k + 1) that holds it (in the face plane; the triangle
 * with the least negative weight when none holds it exactly). Returns [k, w0, wk, wk1].
 */
function fanWeights(verts: KnifeVertex[], f: number[], p: V3): [number, number, number, number] {
  const n = faceNormal(verts, f);
  const P = (i: number): V3 => [verts[f[i]].x, verts[f[i]].y, verts[f[i]].z];
  let best: [number, number, number, number] = [1, 1, 0, 0], bestMin = -Infinity;
  for (let k = 1; k + 1 < f.length; k++) {
    const a = P(0), b = P(k), c = P(k + 1);
    const area = dot(cross(sub(b, a), sub(c, a)), n);
    if (Math.abs(area) < 1e-30) continue;
    const wa = dot(cross(sub(b, p), sub(c, p)), n) / area;
    const wb = dot(cross(sub(c, p), sub(a, p)), n) / area;
    const wc = 1 - wa - wb;
    const m = Math.min(wa, wb, wc);
    if (m > bestMin) { bestMin = m; best = [k, wa, wb, wc]; }
    if (m >= -1e-9) break;
  }
  return best;
}

/**
 * Build the knife cut through `pts` (≥ 2 points, in order). Null when the path cuts nothing (fewer than one face
 * crossed edge to edge) or is refused (see the module limits). `faces` are not modified.
 */
export function buildKnifeCut(verts: KnifeVertex[], faces: FaceList[], pts: KnifePoint[], opts: KnifeOptions = {}): KnifeBuild | null {
  if (pts.length < 2 || faces.length === 0) return null;
  const P = (v: number): V3 => [verts[v].x, verts[v].y, verts[v].z];

  // ── adjacency ──
  const edgeFaces = new Map<string, number[]>();
  const vertFaces = new Map<number, number[]>();
  faces.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const kk = key(f[k], f[(k + 1) % f.length]);
      let l = edgeFaces.get(kk); if (!l) edgeFaces.set(kk, l = []); l.push(fi);
      let vl = vertFaces.get(f[k]); if (!vl) vertFaces.set(f[k], vl = []);
      if (vl[vl.length - 1] !== fi) vl.push(fi);
    }
  });
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const v of verts) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); z0 = Math.min(z0, v.z); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); z1 = Math.max(z1, v.z); }
  const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1;
  const EPS = diag * 1e-9;
  const snap = Math.max(opts.snap ?? diag * 1e-6, EPS);

  // ── 1. tapped points → cut points (snapped onto a vertex / edge of their face when that close) ──
  const kps: KP[] = [];
  for (const pt of pts) {
    const f = faces[pt.face];
    if (!f || !Number.isFinite(pt.x + pt.y + pt.z)) return null;
    const p: V3 = [pt.x, pt.y, pt.z];
    let kp: KP | null = null;
    let bestV = -1, bestVD = snap;
    for (const v of f) { const d = len(sub(P(v), p)); if (d <= bestVD) { bestVD = d; bestV = v; } }
    if (bestV >= 0) kp = { kind: 'v', v: bestV, p: P(bestV) };
    else {
      let bestE: KP | null = null, bestED = snap;
      for (let k = 0; k < f.length; k++) {
        const a = f[k], b = f[(k + 1) % f.length], A = P(a), ab = sub(P(b), A), L2 = dot(ab, ab);
        if (L2 <= 0) continue;
        const t = Math.max(0, Math.min(1, dot(sub(p, A), ab) / L2));
        const q = lerp3(A, P(b), t), d = len(sub(q, p));
        if (d <= bestED) { bestED = d; bestE = { kind: 'e', a, b, t, p: q }; }
      }
      kp = bestE ?? { kind: 'f', f: pt.face, p };
    }
    const last = kps[kps.length - 1];
    if (last && len(sub(last.p, kp.p)) <= EPS) continue;   // a repeated tap
    kps.push(kp);
  }
  if (kps.length < 2) return null;

  const facesOf = (kp: KP): number[] =>
    kp.kind === 'v' ? vertFaces.get(kp.v) ?? [] : kp.kind === 'e' ? edgeFaces.get(key(kp.a, kp.b)) ?? [] : [kp.f];
  const sameKP = (a: KP, b: KP): boolean =>
    a.kind === 'v' ? b.kind === 'v' && a.v === b.v
      : a.kind === 'e' ? b.kind === 'e' && key(a.a, a.b) === key(b.a, b.b) && len(sub(a.p, b.p)) <= EPS
        : b.kind === 'f' && a.f === b.f && len(sub(a.p, b.p)) <= EPS;
  /** Both points lie on one edge (or are its two vertices): a segment along a face boundary — nothing to split. */
  const alongEdge = (a: KP, b: KP): boolean => {
    if (a.kind === 'e' && b.kind === 'e') return key(a.a, a.b) === key(b.a, b.b);
    if (a.kind === 'v' && b.kind === 'v') return edgeFaces.has(key(a.v, b.v));
    const e = a.kind === 'e' ? a : b.kind === 'e' ? b : null, v = a.kind === 'v' ? a : b.kind === 'v' ? b : null;
    return !!e && !!v && (e.a === v.v || e.b === v.v);
  };

  // ── 2. walk each segment across the faces ──
  const steps: Step[] = [];
  for (let s = 0; s + 1 < kps.length; s++) {
    const r = walk(kps[s], kps[s + 1]);
    if (!r) return null;
    steps.push(...r);
  }

  function walk(A: KP, B: KP): Step[] | null {
    const d = sub(B.p, A.p), L2 = dot(d, d);
    if (L2 <= EPS * EPS) return [];
    const avgN = (): V3 => {
      const n: V3 = [0, 0, 0];
      for (const f of [...facesOf(A), ...facesOf(B)]) { const fn = faceNormal(verts, faces[f]); n[0] += fn[0]; n[1] += fn[1]; n[2] += fn[2]; }
      return n;
    };
    let n: V3 = opts.eye ? cross(d, sub(opts.eye, A.p)) : opts.viewDir ? cross(d, opts.viewDir) : cross(d, avgN());
    if (len(n) < 1e-12 * Math.max(1, L2)) n = cross(d, avgN());
    const nl = len(n);
    if (!(nl > 1e-15)) return null;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    const prog = (p: V3): number => dot(sub(p, A.p), d) / L2;
    const sd = (v: number): number => dot(n, sub(P(v), A.p));
    const FB = new Set(facesOf(B));

    /** Where the plane leaves face f going forward from `cur` (the crossing with the most progress), or null. */
    const exitOf = (f: number, cur: KP): { kp: KP; s: number } | null => {
      const fv = faces[f], m = fv.length;
      const s0 = prog(cur.p);
      let best: { kp: KP; s: number } | null = null;
      const consider = (kp: KP): void => {
        if (sameKP(kp, cur)) return;
        if (cur.kind === 'e' && kp.kind === 'v' && (kp.v === cur.a || kp.v === cur.b) && Math.abs(prog(kp.p) - s0) < 1e-9) return;
        const s = prog(kp.p);
        if (s <= s0 + 1e-9) return;
        if (!best || s > best.s) best = { kp, s };
      };
      for (let k = 0; k < m; k++) {
        const a = fv[k], b = fv[(k + 1) % m], da = sd(a), db = sd(b);
        if (Math.abs(da) <= EPS) consider({ kind: 'v', v: a, p: P(a) });
        else if (Math.abs(db) > EPS && da * db < 0) {
          const t = da / (da - db);
          consider({ kind: 'e', a, b, t, p: lerp3(P(a), P(b), t) });
        }
      }
      return best;
    };

    const out: Step[] = [];
    let cur = A, prev = -1;
    for (let guard = 0; guard < faces.length * 2 + 8; guard++) {
      const cf = facesOf(cur).filter(f => f !== prev);
      // B is in a face of the current point: the last step.
      const shared = cf.filter(f => FB.has(f));
      if (shared.length > 0) {
        if (alongEdge(cur, B)) return out;
        out.push({ face: shared[0], from: cur, to: B });
        return out;
      }
      let pick: { f: number; kp: KP; s: number } | null = null;
      for (const f of cf) {
        const x = exitOf(f, cur);
        if (x && (!pick || x.s > pick.s)) pick = { f, kp: x.kp, s: x.s };
      }
      if (!pick || pick.s > 1 + 1e-6) return null;   // stuck, or past the next point without reaching its face
      if (!alongEdge(cur, pick.kp)) out.push({ face: pick.f, from: cur, to: pick.kp });
      prev = pick.f;
      cur = pick.kp;
    }
    return null;
  }

  // ── 3. passes: consecutive steps in one face; a face may be passed once ──
  const passes: Array<{ face: number; seq: KP[] }> = [];
  for (const st of steps) {
    const last = passes[passes.length - 1];
    if (last && last.face === st.face && sameKP(last.seq[last.seq.length - 1], st.from)) last.seq.push(st.to);
    else passes.push({ face: st.face, seq: [st.from, st.to] });
  }
  const seen = new Set<number>();
  for (const ps of passes) { if (seen.has(ps.face)) return null; seen.add(ps.face); }
  // a pass whose end lies inside the face is a dangling end (not cut); a boundary point mid-pass is refused
  const kept = passes.filter(ps => ps.seq[0].kind !== 'f' && ps.seq[ps.seq.length - 1].kind !== 'f');
  for (const ps of kept) for (let i = 1; i + 1 < ps.seq.length; i++) if (ps.seq[i].kind !== 'f') return null;

  // ── 4. vertices for the cut points ──
  const nv0 = verts.length;
  const newVerts: KnifeVertex[] = [];
  const points = new Map<string, { idx: number; vA: number; t: number }>();
  const splitEdges: Array<[number, number, number]> = [];
  const vIdx = (kp: KP): number => {
    if (kp.kind === 'v') return kp.v;
    if (kp.kind === 'e') {
      const kk = key(kp.a, kp.b);
      const have = points.get(kk);
      if (have) return have.idx;
      const va = verts[kp.a], vb = verts[kp.b];
      const idx = nv0 + newVerts.length;
      newVerts.push({ x: kp.p[0], y: kp.p[1], z: kp.p[2], color: lerpCol(va.color, vb.color, kp.t), uv: va.uv && vb.uv ? lerpUV(va.uv, vb.uv, kp.t) : undefined });
      points.set(kk, { idx, vA: kp.a, t: kp.t });
      splitEdges.push([kp.a, kp.b, idx]);
      return idx;
    }
    throw new Error('interior point');
  };

  // ── 5. split the faces ──
  const out: FaceList[] = faces.slice();
  const appended: FaceList[] = [];
  let splitFaces = 0;
  for (const ps of kept) {
    const fi = ps.face, f = faces[fi], n = f.length;
    const q0 = ps.seq[0], qm = ps.seq[ps.seq.length - 1];
    const inner = ps.seq.slice(1, -1) as Array<Extract<KP, { kind: 'f' }>>;
    if (inner.length === 0 && alongEdge(q0, qm)) continue;
    const hasUV = !!f.uvs, hasC = !!f.cols;
    const cUV = (k: number): UV | undefined => f.uvs?.[k] ?? verts[f[k]].uv;
    const cCol = (k: number): RGBA => f.cols?.[k] ?? verts[f[k]].color;
    // the face loop with the two boundary cut points inserted on their edges
    const L: number[] = [], LU: Array<UV | undefined> = [], LC: RGBA[] = [];
    for (let k = 0; k < n; k++) {
      const a = f[k], b = f[(k + 1) % n];
      L.push(a); LU.push(cUV(k)); LC.push(cCol(k));
      const on = [q0, qm].filter((q): q is Extract<KP, { kind: 'e' }> => q.kind === 'e' && key(q.a, q.b) === key(a, b))
        .map(q => ({ q, tt: q.a === a ? q.t : 1 - q.t })).sort((x, y) => x.tt - y.tt);
      for (const { q, tt } of on) {
        const idx = vIdx(q);
        if (L.includes(idx)) continue;
        L.push(idx); LU.push(lerpUV(cUV(k), cUV((k + 1) % n), tt)); LC.push(lerpCol(cCol(k), cCol((k + 1) % n), tt));
      }
    }
    const i = L.indexOf(vIdx(q0)), j = L.indexOf(vIdx(qm));
    if (i < 0 || j < 0 || i === j) continue;
    // interior points: new vertices, their attributes interpolated over the face
    const IV: number[] = [], IU: Array<UV | undefined> = [], IC: RGBA[] = [];
    for (const q of inner) {
      const [k, w0, wk, wk1] = fanWeights(verts, f, q.p);
      const mix = <T,>(x: T | undefined, y: T | undefined, z: T | undefined, fn: (a: number, b: number, c: number) => number, size: number): T | undefined => {
        if (!x || !y || !z) return undefined;
        const a = x as unknown as number[], b = y as unknown as number[], c = z as unknown as number[];
        return Array.from({ length: size }, (_, e) => fn(a[e], b[e], c[e])) as unknown as T;
      };
      const w = (a: number, b: number, c: number) => a * w0 + b * wk + c * wk1;
      const vu = mix(verts[f[0]].uv, verts[f[k]].uv, verts[f[k + 1]].uv, w, 2);
      const vc = mix(verts[f[0]].color, verts[f[k]].color, verts[f[k + 1]].color, w, 4)!;
      IV.push(nv0 + newVerts.length);
      newVerts.push({ x: q.p[0], y: q.p[1], z: q.p[2], color: vc, uv: vu });
      IU.push(mix(cUV(0), cUV(k), cUV(k + 1), w, 2));
      IC.push(mix(cCol(0), cCol(k), cCol(k + 1), w, 4)!);
    }
    const walkL = (from: number, to: number): number[] => {
      const r: number[] = [];
      for (let x = from; ; x = (x + 1) % L.length) { r.push(x); if (x === to) break; }
      return r;
    };
    const ra = walkL(i, j), rb = walkL(j, i);
    if (ra.length + inner.length < 3 || rb.length + inner.length < 3) continue;
    const revI = IV.map((_, x) => IV.length - 1 - x);
    const faceA = mkFace([...ra.map(x => L[x]), ...revI.map(x => IV[x])],
      hasUV ? [...ra.map(x => LU[x]), ...revI.map(x => IU[x])] : null, hasC ? [...ra.map(x => LC[x]), ...revI.map(x => IC[x])] : null, f.smooth);
    const faceB = mkFace([...rb.map(x => L[x]), ...IV],
      hasUV ? [...rb.map(x => LU[x]), ...IU] : null, hasC ? [...rb.map(x => LC[x]), ...IC] : null, f.smooth);
    out[fi] = faceA;
    appended.push(faceB);
    splitFaces++;
  }
  if (splitFaces === 0) return null;
  return { vertices: newVerts, faces: [...out, ...appended], points, splitEdges, splitFaces };
}
