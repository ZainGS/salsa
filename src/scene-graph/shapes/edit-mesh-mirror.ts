/**
 * Edit Mesh MIRROR — plane + BISECT (round 2, docs/reviews/round2-feedback-2026-10-08.md "Mirror rework").
 *
 * A plane mirror is a PLANE (point + unit normal, object space) — the normal points TOWARD THE COPY side. The modifier
 * output (bisectMirror) keeps only the REAL side of its input (signed distance ≤ eps): faces crossing the plane are cut
 * (Sutherland–Hodgman, one new vertex per cut EDGE, shared by both faces of the edge, snapped onto the plane), faces on
 * the copy side are dropped, faces lying IN the plane are dropped (they would be internal once the copy exists). Then
 * the reflected copy is added (reversed winding, corner UVs / colours reversed with their corners, custom normals
 * reflected) and every on-plane vertex is shared by both halves — the seam is welded by construction. The base mesh is
 * never touched (non-destructive, like Blender's Mirror + Bisect); Bake (EditMesh.applyModifier) writes the output.
 * O(V + corners): one pass over the vertices, one over the face corners, a hash map keyed by the cut edge.
 *
 * The "images" helpers below are what Edit Mesh picking and the edit overlay use to show / pick the copy side: an
 * element of the base mesh appears at its real position (clipped to the real side) and at every reflection of it,
 * through the stack's plane mirrors in order (img = bitmask of the reflections applied, 0 = the real one). An element
 * entirely on the discarded side has no image at all (not drawn, not pickable).
 */

import type { EditMeshData, N3 } from './edit-mesh';

/** One plane mirror of the stack, object space. `normal` is unit and points toward the copy side; points within `eps`
 *  of the plane are ON it (snapped, welded, never duplicated). */
export interface MirrorPlane {
  point: N3;
  normal: N3;
  eps: number;
}

type Vert = EditMeshData['vertices'][number];
type Face = EditMeshData['faces'][number];
type UV = [number, number];
type RGBA = [number, number, number, number];

/** Signed distance of (x, y, z) from the plane (> 0 = the copy side). */
export function planeDistance(pl: MirrorPlane, x: number, y: number, z: number): number {
  const p = pl.point, n = pl.normal;
  return (x - p[0]) * n[0] + (y - p[1]) * n[1] + (z - p[2]) * n[2];
}

/** A unit copy of `n` (null when it has no direction). */
export function unitNormal(n: ArrayLike<number>): N3 | null {
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!(l > 1e-12) || !Number.isFinite(l)) return null;
  return [n[0] / l + 0, n[1] / l + 0, n[2] / l + 0];
}

/** The reflection of a direction across the plane (its normal component negated). */
function reflectDir(n: N3, d: N3): N3 {
  const k = 2 * (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]);
  return [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]];
}

/**
 * The bisect mirror of `mesh` across `plane` (see the module comment). Returns the input itself (`inert: true`) when
 * nothing of it lies on the real side off the plane (the whole mesh is on the copy side / flat in the plane) — the
 * mesh never vanishes under a plane swept past it.
 */
export function bisectMirror(mesh: EditMeshData, plane: MirrorPlane): { data: EditMeshData; inert: boolean } {
  const V = mesh.vertices, nV = V.length, eps = Math.max(0, plane.eps);
  const n = plane.normal;
  const sd = new Float64Array(nV);
  const side = new Int8Array(nV);
  for (let i = 0; i < nV; i++) {
    const d = planeDistance(plane, V[i].x, V[i].y, V[i].z);
    sd[i] = d;
    side[i] = d > eps ? 1 : d < -eps ? -1 : 0;
  }
  const vUV = (i: number): UV => mesh.uvs[i] ?? [0, 0];

  // Output vertices (real side): base vertices on demand + one per cut edge.
  const outV: Vert[] = [];
  const outUV: UV[] = [];
  const onPlane: boolean[] = [];
  const vmap = new Int32Array(nV).fill(-1);
  const useV = (i: number): number => {
    let o = vmap[i];
    if (o >= 0) return o;
    const v = V[i];
    o = outV.length;
    vmap[i] = o;
    if (side[i] === 0) {
      const d = sd[i];
      outV.push({ x: v.x - d * n[0], y: v.y - d * n[1], z: v.z - d * n[2], color: [v.color[0], v.color[1], v.color[2], v.color[3]] });
      onPlane.push(true);
    } else {
      outV.push({ x: v.x, y: v.y, z: v.z, color: [v.color[0], v.color[1], v.color[2], v.color[3]] });
      onPlane.push(false);
    }
    const uv = vUV(i);
    outUV.push([uv[0], uv[1]]);
    return o;
  };
  const cut = new Map<number, number>();
  const cutV = (a: number, b: number): number => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const key = lo * nV + hi;
    let o = cut.get(key);
    if (o !== undefined) return o;
    const t = sd[lo] / (sd[lo] - sd[hi]);
    const A = V[lo], B = V[hi];
    let x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t, z = A.z + (B.z - A.z) * t;
    const d = planeDistance(plane, x, y, z);
    x -= d * n[0]; y -= d * n[1]; z -= d * n[2];
    const ca = A.color, cb = B.color;
    const ua = vUV(lo), ub = vUV(hi);
    o = outV.length;
    outV.push({ x, y, z, color: [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t, ca[3] + (cb[3] - ca[3]) * t] });
    outUV.push([ua[0] + (ub[0] - ua[0]) * t, ua[1] + (ub[1] - ua[1]) * t]);
    onPlane.push(true);
    cut.set(key, o);
    return o;
  };

  const faces: Face[] = [];
  for (const f of mesh.faces) {
    const vs = f.verts, k = vs.length;
    let neg = false, pos = false;
    for (let c = 0; c < k; c++) { const s = side[vs[c]]; if (s < 0) neg = true; else if (s > 0) pos = true; }
    if (!neg) continue;   // on the copy side, or flat in the plane (internal once mirrored)
    if (!pos) {
      faces.push({ verts: vs.map(useV), uvs: f.uvs, cols: f.cols, nrms: f.nrms, smooth: f.smooth });
      continue;
    }
    // Cut: keep the real-side corners, add one corner where an edge crosses the plane (Sutherland–Hodgman).
    const verts: number[] = [];
    const uvs: Array<UV | undefined> | null = f.uvs ? [] : null;
    const cols: Array<RGBA | undefined> | null = f.cols ? [] : null;
    const nrms: Array<N3 | undefined> | null = f.nrms ? [] : null;
    const cUV = (c: number): UV => f.uvs?.[c] ?? vUV(vs[c]);
    const cCol = (c: number): RGBA => f.cols?.[c] ?? V[vs[c]].color;
    for (let c = 0; c < k; c++) {
      const c2 = (c + 1) % k;
      const a = vs[c], b = vs[c2];
      if (side[a] <= 0) {
        verts.push(useV(a));
        uvs?.push(f.uvs![c]); cols?.push(f.cols![c]); nrms?.push(f.nrms![c]);
      }
      if ((side[a] < 0 && side[b] > 0) || (side[a] > 0 && side[b] < 0)) {
        verts.push(cutV(a, b));
        const t = sd[a] / (sd[a] - sd[b]);
        if (uvs) { const p = cUV(c), q = cUV(c2); uvs.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
        if (cols) { const p = cCol(c), q = cCol(c2); cols.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, p[3] + (q[3] - p[3]) * t]); }
        if (nrms) {
          const p = f.nrms![c], q = f.nrms![c2];
          nrms.push(p && q ? unitNormal([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]) ?? undefined : undefined);
        }
      }
    }
    if (verts.length >= 3) faces.push({ verts, uvs: uvs ?? undefined, cols: cols ?? undefined, nrms: nrms ?? undefined, smooth: f.smooth });
  }
  if (faces.length === 0) return { data: mesh, inert: true };

  // Sharp edges of the real side (an edge that was cut keeps its real part).
  const sharpKey = new Set<number>();
  const sharp: Array<[number, number]> = [];
  const addSharp = (a: number, b: number, M: number): void => {
    if (a === b) return;
    const key = a < b ? a * M + b : b * M + a;
    if (sharpKey.has(key)) return;
    sharpKey.add(key);
    sharp.push([a, b]);
  };
  const realSharp: Array<[number, number]> = [];
  for (const [a, b] of mesh.sharpEdges ?? []) {
    if (a < 0 || b < 0 || a >= nV || b >= nV) continue;
    if (side[a] <= 0 && side[b] <= 0) {
      if (vmap[a] >= 0 && vmap[b] >= 0) realSharp.push([vmap[a], vmap[b]]);
    } else if ((side[a] < 0 && side[b] > 0) || (side[a] > 0 && side[b] < 0)) {
      const keep = side[a] < 0 ? a : b;
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const x = cut.get(lo * nV + hi);
      if (x !== undefined && vmap[keep] >= 0) realSharp.push([vmap[keep], x]);
    }
  }

  // The reflected copy: on-plane vertices are shared (the welded seam), the rest get a reflected twin.
  const nReal = outV.length;
  const mirrorOf = new Int32Array(nReal);
  for (let j = 0; j < nReal; j++) {
    if (onPlane[j]) { mirrorOf[j] = j; continue; }
    const v = outV[j];
    const d = planeDistance(plane, v.x, v.y, v.z);
    mirrorOf[j] = outV.length;
    outV.push({ x: v.x - 2 * d * n[0], y: v.y - 2 * d * n[1], z: v.z - 2 * d * n[2], color: [v.color[0], v.color[1], v.color[2], v.color[3]] });
    outUV.push([outUV[j][0], outUV[j][1]]);
  }
  const nReal2 = faces.length;
  for (let fi = 0; fi < nReal2; fi++) {
    const f = faces[fi];
    faces.push({
      verts: [...f.verts].reverse().map(i => mirrorOf[i]),
      uvs: f.uvs ? [...f.uvs].reverse() : undefined,
      cols: f.cols ? [...f.cols].reverse() : undefined,
      nrms: f.nrms ? [...f.nrms].reverse().map(c => (c ? reflectDir(n, c) : undefined)) : undefined,
      smooth: f.smooth,
    });
  }
  const M = outV.length + 1;
  for (const [a, b] of realSharp) addSharp(a, b, M);
  for (const [a, b] of realSharp) addSharp(mirrorOf[a], mirrorOf[b], M);

  return { data: { vertices: outV, faces, uvs: outUV, sharpEdges: sharp }, inert: false };
}

// ── Images (Edit Mesh picking + overlay) ──────────────────────────────────────

/** Reflect (x, y, z) across the plane, in place into `out` at `o`. */
function reflectInto(pl: MirrorPlane, x: number, y: number, z: number, out: number[], o: number): void {
  const d = 2 * planeDistance(pl, x, y, z), n = pl.normal;
  out[o] = x - d * n[0]; out[o + 1] = y - d * n[1]; out[o + 2] = z - d * n[2];
}

/**
 * Every place the base-mesh POINT (x, y, z) appears in the output of the planes (in stack order): its real position
 * (img 0) when it is on the real side of every plane, and each reflection (img = bitmask of the planes reflected
 * through). A point on a plane is not duplicated by it. None = the point is discarded.
 */
export function forEachPointImage(planes: readonly MirrorPlane[], x: number, y: number, z: number,
  cb: (x: number, y: number, z: number, img: number) => void): void {
  if (planes.length === 0) { cb(x, y, z, 0); return; }
  let pts: number[] = [x, y, z, 0];
  for (let i = 0; i < planes.length; i++) {
    const pl = planes[i], next: number[] = [];
    for (let o = 0; o < pts.length; o += 4) {
      const d = planeDistance(pl, pts[o], pts[o + 1], pts[o + 2]);
      if (d > pl.eps) continue;
      next.push(pts[o], pts[o + 1], pts[o + 2], pts[o + 3]);
      if (d >= -pl.eps) continue;   // on the plane: shared by both halves
      const k = next.length;
      next.push(0, 0, 0, pts[o + 3] | (1 << i));
      reflectInto(pl, pts[o], pts[o + 1], pts[o + 2], next, k);
    }
    pts = next;
  }
  for (let o = 0; o < pts.length; o += 4) cb(pts[o], pts[o + 1], pts[o + 2], pts[o + 3]);
}

/**
 * The segment a→b as it appears in the output: clipped to each plane's real side, plus each reflection. A segment that
 * collapses onto a plane (an edge from an on-plane vertex into the discarded side) is dropped; one lying in a plane is
 * kept once (not duplicated).
 */
export function forEachSegmentImage(planes: readonly MirrorPlane[],
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  cb: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, img: number) => void): void {
  if (planes.length === 0) { cb(ax, ay, az, bx, by, bz, 0); return; }
  let segs: number[] = [ax, ay, az, bx, by, bz, 0];
  for (let i = 0; i < planes.length; i++) {
    const pl = planes[i], e = pl.eps, next: number[] = [];
    for (let o = 0; o < segs.length; o += 7) {
      let x0 = segs[o], y0 = segs[o + 1], z0 = segs[o + 2], x1 = segs[o + 3], y1 = segs[o + 4], z1 = segs[o + 5];
      const img = segs[o + 6];
      let d0 = planeDistance(pl, x0, y0, z0), d1 = planeDistance(pl, x1, y1, z1);
      if (d0 > e && d1 > e) continue;
      if (d0 > e || d1 > e) {
        // clip the copy-side end onto the plane
        const t = d0 / (d0 - d1);
        const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t, cz = z0 + (z1 - z0) * t;
        if (d0 > e) { x0 = cx; y0 = cy; z0 = cz; d0 = 0; } else { x1 = cx; y1 = cy; z1 = cz; d1 = 0; }
        if (Math.abs(d0) <= e && Math.abs(d1) <= e) continue;   // collapsed onto the plane
      }
      next.push(x0, y0, z0, x1, y1, z1, img);
      if (Math.abs(d0) <= e && Math.abs(d1) <= e) continue;     // in the plane: shared
      const k = next.length;
      next.push(0, 0, 0, 0, 0, 0, img | (1 << i));
      reflectInto(pl, x0, y0, z0, next, k);
      reflectInto(pl, x1, y1, z1, next, k + 3);
    }
    segs = next;
  }
  for (let o = 0; o < segs.length; o += 7) cb(segs[o], segs[o + 1], segs[o + 2], segs[o + 3], segs[o + 4], segs[o + 5], segs[o + 6]);
}

/**
 * The polygon `pts` (flat xyz) as it appears in the output: clipped to each plane's real side (Sutherland–Hodgman),
 * plus each reflection. A piece with < 3 corners or lying flat in a plane (internal) is dropped — the modifier's rules.
 */
export function forEachPolygonImage(planes: readonly MirrorPlane[], pts: ArrayLike<number>,
  cb: (poly: number[], img: number) => void): void {
  if (planes.length === 0) { cb(Array.from(pts), 0); return; }
  let polys: Array<{ p: number[]; img: number }> = [{ p: Array.from(pts), img: 0 }];
  for (let i = 0; i < planes.length; i++) {
    const pl = planes[i], e = pl.eps, next: typeof polys = [];
    for (const { p, img } of polys) {
      const k = p.length / 3;
      const d: number[] = [];
      let neg = false, pos = false;
      for (let c = 0; c < k; c++) {
        const s = planeDistance(pl, p[c * 3], p[c * 3 + 1], p[c * 3 + 2]);
        d.push(s);
        if (s < -e) neg = true; else if (s > e) pos = true;
      }
      if (!neg) continue;
      let q = p;
      if (pos) {
        q = [];
        for (let c = 0; c < k; c++) {
          const c2 = (c + 1) % k, da = d[c], db = d[c2];
          if (da <= e) q.push(p[c * 3], p[c * 3 + 1], p[c * 3 + 2]);
          if ((da < -e && db > e) || (da > e && db < -e)) {
            const t = da / (da - db);
            q.push(p[c * 3] + (p[c2 * 3] - p[c * 3]) * t, p[c * 3 + 1] + (p[c2 * 3 + 1] - p[c * 3 + 1]) * t, p[c * 3 + 2] + (p[c2 * 3 + 2] - p[c * 3 + 2]) * t);
          }
        }
        if (q.length < 9) continue;
      }
      next.push({ p: q, img });
      const r: number[] = new Array(q.length);
      for (let o = 0; o < q.length; o += 3) reflectInto(pl, q[o], q[o + 1], q[o + 2], r, o);
      next.push({ p: r, img: img | (1 << i) });
    }
    polys = next;
  }
  for (const { p, img } of polys) cb(p, img);
}

/**
 * Map a point of the OUTPUT (object space) back to the base mesh: undo the reflections in reverse stack order (a point
 * on a plane's copy side is reflected back). `img` = the reflections undone (0 = it was on the real side).
 */
export function toRealSide(planes: readonly MirrorPlane[], x: number, y: number, z: number): { x: number; y: number; z: number; img: number } {
  let img = 0;
  const p = [x, y, z];
  for (let i = planes.length - 1; i >= 0; i--) {
    const pl = planes[i];
    if (planeDistance(pl, p[0], p[1], p[2]) > pl.eps) { reflectInto(pl, p[0], p[1], p[2], p, 0); img |= 1 << i; }
  }
  return { x: p[0], y: p[1], z: p[2], img };
}

/**
 * The object-space affine map of image `img` (real → image): `[L (3x3, column-major) | t]` (12 numbers), x' = L x + t.
 * Each reflection is orthogonal and an involution, so image → real's linear part is Lᵀ.
 */
export function imageAffine(planes: readonly MirrorPlane[], img: number): Float64Array {
  const A = new Float64Array(12);
  A[0] = A[4] = A[8] = 1;
  for (let i = 0; i < planes.length; i++) {
    if (!(img & (1 << i))) continue;
    const n = planes[i].normal, c = 2 * (planes[i].point[0] * n[0] + planes[i].point[1] * n[1] + planes[i].point[2] * n[2]);
    // R = I − 2 n nᵀ;  A ← R ∘ A
    const apply = (o: number): void => {
      const x = A[o], y = A[o + 1], z = A[o + 2], k = 2 * (x * n[0] + y * n[1] + z * n[2]);
      A[o] = x - k * n[0]; A[o + 1] = y - k * n[1]; A[o + 2] = z - k * n[2];
    };
    apply(0); apply(3); apply(6); apply(9);
    A[9] += c * n[0]; A[10] += c * n[1]; A[11] += c * n[2];
  }
  return A;
}

/** A stable key of the planes (caches compare it). */
export function mirrorPlanesKey(planes: readonly MirrorPlane[]): string {
  let s = '';
  for (const p of planes) s += `${p.point[0]},${p.point[1]},${p.point[2]},${p.normal[0]},${p.normal[1]},${p.normal[2]},${p.eps};`;
  return s;
}
