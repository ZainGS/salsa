/**
 * EditMesh RENDER MESH builder (docs/specs/edit-mesh-topology.md §3).
 *
 * The EditMesh is the TOPOLOGY layer: shared vertices + polygon faces (n-gons), with per-FACE-CORNER attributes
 * (UVs) and per-face smooth / per-edge sharp flags. The GPU needs plain triangles whose vertices carry ONE normal /
 * UV / tangent each, so this module derives the render mesh:
 *
 *  - render vertices: a FLAT face's corners each get their own render vertex (the corner's position, the face
 *    normal, the corner UV) — exactly what a generator emits for a hard-edged primitive (a cube = 24 render
 *    vertices); a SMOOTH face's corners share a render vertex with every other smooth corner of the same vertex in
 *    the same normal FAN (corners joined across non-sharp edges between smooth faces) that has the same UV. The
 *    sharing is decided from the topology + UVs only (never from computed float values), so moving vertices never
 *    changes which corners share — the in-place drag patch below stays exact.
 *  - normals: flat = the face's Newell normal (the polygon normal, so a non-planar quad stays one flat face);
 *    smooth = the angle-weighted sum of the face normals over the corner's fan.
 *  - tangents: from the UV gradients of the face (summed over its triangles), Gram-Schmidt'd against the normal;
 *    handedness in w. Faces without usable UVs fall back to an axis-derived tangent (the old compile's rule).
 *  - triangulation: triangle as is; quad = (0,1,2)(0,2,3); 5+ corners = ear clipping in the face plane (concave
 *    n-gons stay correct), fan fallback when no ear exists.
 *
 * The output is INDEXED (render vertices are shared between the triangles of a face, and between faces in a smooth
 * fan). `sourceVerts[r]` is the topology vertex of render vertex r (skinned weight remap, drag patch).
 *
 * {@link patchRenderMesh} brings a previous build in line with moved vertex positions in place (the faces touching a
 * moved vertex, and every smooth fan they feed), through the same arithmetic as the build — the bytes equal a fresh
 * build exactly.
 */

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

/** The flat mesh format the build reads (EditMeshData in edit-mesh.ts — structurally typed here to avoid a cycle). */
export interface RenderSourceData {
  vertices: ArrayLike<{ x: number; y: number; z: number; color: ArrayLike<number> }>;
  faces: ArrayLike<{ verts: number[]; uvs?: ReadonlyArray<readonly [number, number] | undefined>; smooth?: boolean }>;
  /** Per-vertex fallback UV (a corner without its own UV uses its vertex's). */
  uvs: ArrayLike<readonly [number, number] | undefined>;
  /** Undirected vertex pairs marked sharp (smooth fans never cross them). */
  sharpEdges?: ReadonlyArray<readonly [number, number]>;
}

export type RenderGeometry = MeshGeometry & { vertexColors: Float32Array; sourceVerts: Uint32Array };

type P3 = { x: number; y: number; z: number };

/** Everything a patch needs from a build (all topology-derived; only positions / face frames are refreshed). */
export interface RenderState {
  nv: number;
  nf: number;
  /** Face f's corners are [faceStart[f], faceStart[f + 1]). */
  faceStart: Int32Array;
  cornerVert: Int32Array;
  cornerFace: Int32Array;
  /** Resolved corner UV (doubles, u v). */
  cornerUV: Float64Array;
  /** Corner → render vertex. */
  cornerRV: Int32Array;
  faceSmooth: Uint8Array;
  /** Per-face triangulation, corner-LOCAL indices, CSR by faceTriStart (in triangles). */
  faceTriStart: Int32Array;
  faceTris: Int32Array;
  /** Face frame: unit Newell normal, unit tangent (⊥ normal), bitangent accumulator, tangent handedness. */
  faceN: Float64Array;
  faceT: Float64Array;
  faceB: Float64Array;
  /** Corner angle (radians) — the smooth-normal weight. */
  cornerAngle: Float64Array;
  /** Corner → normal-fan id (−1 = a flat face's corner). Fan corner lists (ascending) in CSR. */
  cornerFan: Int32Array;
  fanStart: Int32Array;
  fanCorners: Int32Array;
  /** Render vertex → its corners (ascending), CSR. A flat render vertex has exactly one. */
  rvStart: Int32Array;
  rvCorners: Int32Array;
  /** Vertex → incident faces (CSR; a face appears once per vertex). */
  vfStart: Int32Array;
  vfFaces: Int32Array;
  /** Vertex positions as last written (doubles). */
  pos: Float64Array;
  /** Scratch: per-face / per-render-vertex marks (all zero between patches). */
  faceMark: Uint8Array;
  rvMark: Uint8Array;
}

/** Output-vertex gap (≈1.5 KB) below which two dirty spans are sent as one write. */
const PATCH_SPAN_GAP = 32;
/** Above this many spans a patch reports one covering span (one write beats hundreds of tiny ones). */
const PATCH_MAX_SPANS = 64;

// ── Build ─────────────────────────────────────────────────────────────────────

export function buildRenderMesh(data: RenderSourceData): { geom: RenderGeometry; state: RenderState } {
  const V = data.vertices, F = data.faces;
  const nv = V.length, nf = F.length;

  // 1. Corners (face order, corner order) + resolved corner UVs.
  const faceStart = new Int32Array(nf + 1);
  for (let f = 0; f < nf; f++) faceStart[f + 1] = faceStart[f] + F[f].verts.length;
  const nc = faceStart[nf];
  const cornerVert = new Int32Array(nc), cornerFace = new Int32Array(nc), cornerUV = new Float64Array(nc * 2);
  const faceSmooth = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) {
    const face = F[f], vs = face.verts, s = faceStart[f];
    faceSmooth[f] = face.smooth ? 1 : 0;
    for (let k = 0; k < vs.length; k++) {
      const c = s + k, v = vs[k];
      cornerVert[c] = v; cornerFace[c] = f;
      const uv = face.uvs?.[k] ?? data.uvs[v];
      cornerUV[c * 2] = uv ? uv[0] : 0; cornerUV[c * 2 + 1] = uv ? uv[1] : 0;
    }
  }

  // 2. Triangulation (positions at build time; a patch re-checks n-gons).
  const triLists: number[][] = new Array(nf);
  let nTri = 0;
  for (let f = 0; f < nf; f++) { const t = triangulateFace(V, F[f].verts); triLists[f] = t; nTri += t.length / 3; }
  const faceTriStart = new Int32Array(nf + 1), faceTris = new Int32Array(nTri * 3);
  for (let f = 0, o = 0; f < nf; f++) {
    faceTriStart[f] = o / 3;
    const t = triLists[f];
    for (let i = 0; i < t.length; i++) faceTris[o++] = t[i];
    faceTriStart[f + 1] = o / 3;
  }

  // 3. Smooth fans: union smooth corners of the same vertex across shared, non-sharp edges between smooth faces.
  const sharp = new Set<number>();
  for (const [a, b] of data.sharpEdges ?? []) sharp.add(edgeKey(a, b, nv));
  const parent = new Int32Array(nc);
  for (let c = 0; c < nc; c++) parent[c] = c;
  const find = (c: number): number => { while (parent[c] !== c) { parent[c] = parent[parent[c]]; c = parent[c]; } return c; };
  const union = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb; } };
  const edgeCorners = new Map<number, number[]>();   // undirected edge → the corners at the FROM end of each use
  for (let f = 0; f < nf; f++) {
    if (!faceSmooth[f]) continue;
    const s = faceStart[f], n = faceStart[f + 1] - s;
    for (let k = 0; k < n; k++) {
      const a = cornerVert[s + k], b = cornerVert[s + (k + 1) % n];
      if (a === b) continue;
      const key = edgeKey(a, b, nv);
      if (sharp.has(key)) continue;
      let list = edgeCorners.get(key);
      if (!list) edgeCorners.set(key, (list = []));
      list.push(s + k);
    }
  }
  const nextCorner = (c: number): number => { const f = cornerFace[c], s = faceStart[f], n = faceStart[f + 1] - s; return s + ((c - s + 1) % n); };
  for (const list of edgeCorners.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const ci = list[i], cj = list[j];
      const a = cornerVert[ci], ci2 = nextCorner(ci), cj2 = nextCorner(cj);
      // the corner of face j at vertex a / at the other end b
      const ja = cornerVert[cj] === a ? cj : cj2, jb = ja === cj ? cj2 : cj;
      union(ci, ja); union(ci2, jb);
    }
  }
  const cornerFan = new Int32Array(nc).fill(-1);
  const rootFan = new Map<number, number>();
  let nFan = 0;
  for (let c = 0; c < nc; c++) {
    if (!faceSmooth[cornerFace[c]]) continue;
    const r = find(c);
    let id = rootFan.get(r);
    if (id === undefined) { id = nFan++; rootFan.set(r, id); }
    cornerFan[c] = id;
  }
  const { start: fanStart, items: fanCorners } = csr(nFan, nc, (c) => cornerFan[c]);

  // 4. Render vertices in face / corner order: a flat corner → its own; a smooth corner → (fan, UV) shared.
  const cornerRV = new Int32Array(nc);
  const smoothKey = new Map<string, number>();
  let nRV = 0;
  const f32 = new Float32Array(2), u32 = new Uint32Array(f32.buffer);
  for (let c = 0; c < nc; c++) {
    const fan = cornerFan[c];
    if (fan < 0) { cornerRV[c] = nRV++; continue; }
    f32[0] = cornerUV[c * 2]; f32[1] = cornerUV[c * 2 + 1];
    const key = `${fan}:${u32[0]}:${u32[1]}`;
    let rv = smoothKey.get(key);
    if (rv === undefined) { rv = nRV++; smoothKey.set(key, rv); }
    cornerRV[c] = rv;
  }
  const { start: rvStart, items: rvCorners } = csr(nRV, nc, (c) => cornerRV[c]);

  // 5. Vertex → faces (patch dirtiness).
  const vfLists: number[][] = Array.from({ length: nv }, () => []);
  for (let f = 0; f < nf; f++) {
    const s = faceStart[f], e = faceStart[f + 1];
    for (let c = s; c < e; c++) { const l = vfLists[cornerVert[c]]; if (l && l[l.length - 1] !== f) l.push(f); }
  }
  const vfStart = new Int32Array(nv + 1);
  for (let v = 0; v < nv; v++) vfStart[v + 1] = vfStart[v] + vfLists[v].length;
  const vfFaces = new Int32Array(vfStart[nv]);
  for (let v = 0, o = 0; v < nv; v++) for (const f of vfLists[v]) vfFaces[o++] = f;

  const pos = new Float64Array(nv * 3);
  for (let v = 0; v < nv; v++) { const p = V[v]; pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z; }

  const state: RenderState = {
    nv, nf, faceStart, cornerVert, cornerFace, cornerUV, cornerRV, faceSmooth, faceTriStart, faceTris,
    faceN: new Float64Array(nf * 3), faceT: new Float64Array(nf * 3), faceB: new Float64Array(nf * 3),
    cornerAngle: new Float64Array(nc),
    cornerFan, fanStart, fanCorners, rvStart, rvCorners, vfStart, vfFaces, pos,
    faceMark: new Uint8Array(nf), rvMark: new Uint8Array(nRV),
  };

  // 6. Face frames, then every render vertex.
  for (let f = 0; f < nf; f++) faceFrame(state, V, f);
  const vertBuf = new Float32Array(nRV * FLOATS_PER_VERT);
  const colorBuf = new Float32Array(nRV * 4);
  const sourceVerts = new Uint32Array(nRV);
  for (let rv = 0; rv < nRV; rv++) {
    const c0 = rvCorners[rvStart[rv]], v = cornerVert[c0];
    writeRenderVertex(state, V, rv, vertBuf);
    const col = V[v].color;
    colorBuf[rv * 4] = col[0]; colorBuf[rv * 4 + 1] = col[1]; colorBuf[rv * 4 + 2] = col[2]; colorBuf[rv * 4 + 3] = col[3];
    sourceVerts[rv] = v;
  }
  const idxBuf = new Uint32Array(nTri * 3);
  for (let f = 0, o = 0; f < nf; f++) {
    const s = faceStart[f];
    for (let t = faceTriStart[f] * 3, e = faceTriStart[f + 1] * 3; t < e; t++) idxBuf[o++] = cornerRV[s + faceTris[t]];
  }

  return {
    geom: { vertices: vertBuf, indices: idxBuf, format: '12float', vertexColors: colorBuf, sourceVerts },
    state,
  };
}

// ── Incremental patch (mobile-parity 7.3d: Mesh Edit vertex drag) ─────────────

/**
 * Rewrite `out` (the vertex buffer the build produced) for the vertex positions in `verts`. Only faces touching a
 * moved vertex are re-framed, and only the render vertices of those faces — plus every render vertex of a smooth fan
 * such a face feeds — are rewritten. Returns the rewritten render-vertex spans flattened as [start, count, ...] in
 * ascending order ([] = nothing moved), or null when the patch cannot reproduce a fresh build (an n-gon whose
 * triangulation changed) — the caller recompiles. On null nothing was written.
 */
export function patchRenderMesh(state: RenderState, verts: ArrayLike<P3>, out: Float32Array): number[] | null {
  const { nv, pos, vfStart, vfFaces, faceMark } = state;
  if (verts.length !== nv) return null;

  // 1. Moved vertices → dirty faces (not committed until the n-gon check passes).
  const moved: number[] = [];
  for (let v = 0, o = 0; v < nv; v++, o += 3) {
    const p = verts[v];
    if (p.x !== pos[o] || p.y !== pos[o + 1] || p.z !== pos[o + 2]) moved.push(v);
  }
  if (moved.length === 0) return [];
  const dirtyFaces: number[] = [];
  for (const v of moved) {
    for (let k = vfStart[v]; k < vfStart[v + 1]; k++) { const f = vfFaces[k]; if (!faceMark[f]) { faceMark[f] = 1; dirtyFaces.push(f); } }
  }
  const clearMarks = (): void => { for (const f of dirtyFaces) faceMark[f] = 0; };

  // 2. An n-gon's ear clipping depends on the positions: a different triangulation = a different index buffer.
  for (const f of dirtyFaces) {
    const s = state.faceStart[f], n = state.faceStart[f + 1] - s;
    if (n < 5) continue;
    const vs: number[] = new Array(n);
    for (let k = 0; k < n; k++) vs[k] = state.cornerVert[s + k];
    const tri = triangulateFace(verts, vs);
    const t0 = state.faceTriStart[f] * 3, t1 = state.faceTriStart[f + 1] * 3;
    let same = tri.length === t1 - t0;
    for (let i = 0; same && i < tri.length; i++) if (tri[i] !== state.faceTris[t0 + i]) same = false;
    if (!same) { clearMarks(); return null; }
  }

  // 3. Commit positions, re-frame the dirty faces, collect the render vertices they feed.
  for (const v of moved) { const p = verts[v], o = v * 3; pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z; }
  const { rvMark, cornerRV, cornerFan, fanStart, fanCorners } = state;
  const dirtyRV: number[] = [];
  const markRV = (rv: number): void => { if (!rvMark[rv]) { rvMark[rv] = 1; dirtyRV.push(rv); } };
  for (const f of dirtyFaces) {
    faceFrame(state, verts, f);
    for (let c = state.faceStart[f]; c < state.faceStart[f + 1]; c++) {
      markRV(cornerRV[c]);
      const fan = cornerFan[c];
      if (fan >= 0) for (let k = fanStart[fan]; k < fanStart[fan + 1]; k++) markRV(cornerRV[fanCorners[k]]);
    }
  }
  clearMarks();

  // 4. Rewrite them (same arithmetic as the build).
  for (const rv of dirtyRV) { rvMark[rv] = 0; writeRenderVertex(state, verts, rv, out); }

  // 5. Ascending spans (a small gap is re-sent rather than split into another write).
  dirtyRV.sort((a, b) => a - b);
  const spans: number[] = [];
  let s = dirtyRV[0], e = s + 1;
  for (let i = 1; i < dirtyRV.length; i++) {
    const a = dirtyRV[i];
    if (a - e <= PATCH_SPAN_GAP) { e = a + 1; continue; }
    spans.push(s, e - s);
    s = a; e = a + 1;
  }
  spans.push(s, e - s);
  if (spans.length / 2 > PATCH_MAX_SPANS) return [spans[0], spans[spans.length - 2] + spans[spans.length - 1] - spans[0]];
  return spans;
}

// ── Shared arithmetic (build + patch) ─────────────────────────────────────────

/** Unit Newell normal, UV tangent / bitangent and corner angles of face f, into the state's face / corner arrays. */
function faceFrame(st: RenderState, V: ArrayLike<P3>, f: number): void {
  const s = st.faceStart[f], n = st.faceStart[f + 1] - s, cv = st.cornerVert;
  // Newell normal (the polygon normal: exact for planar faces, the best fit for a non-planar quad).
  let nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < n; k++) {
    const a = V[cv[s + k]], b = V[cv[s + (k + 1) % n]];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;

  // UV gradient tangent, summed over the face's triangles.
  let tx = 0, ty = 0, tz = 0, bx = 0, by = 0, bz = 0;
  const uv = st.cornerUV;
  for (let t = st.faceTriStart[f] * 3, e = st.faceTriStart[f + 1] * 3; t < e; t += 3) {
    const c0 = s + st.faceTris[t], c1 = s + st.faceTris[t + 1], c2 = s + st.faceTris[t + 2];
    const p0 = V[cv[c0]], p1 = V[cv[c1]], p2 = V[cv[c2]];
    const du1 = uv[c1 * 2] - uv[c0 * 2], dv1 = uv[c1 * 2 + 1] - uv[c0 * 2 + 1];
    const du2 = uv[c2 * 2] - uv[c0 * 2], dv2 = uv[c2 * 2 + 1] - uv[c0 * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (!(Math.abs(det) > 1e-20)) continue;
    const r = 1 / det;
    const e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
    const e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
    tx += (e1x * dv2 - e2x * dv1) * r; ty += (e1y * dv2 - e2y * dv1) * r; tz += (e1z * dv2 - e2z * dv1) * r;
    bx += (e2x * du1 - e1x * du2) * r; by += (e2y * du1 - e1y * du2) * r; bz += (e2z * du1 - e1z * du2) * r;
  }
  const o = f * 3;
  st.faceN[o] = nx; st.faceN[o + 1] = ny; st.faceN[o + 2] = nz;
  orthoTangent(nx, ny, nz, tx, ty, tz, st.faceT, o);
  st.faceB[o] = bx; st.faceB[o + 1] = by; st.faceB[o + 2] = bz;

  // Corner angles (smooth-normal weights) — only smooth faces feed fans.
  if (st.faceSmooth[f]) {
    for (let k = 0; k < n; k++) {
      const p = V[cv[s + k]], a = V[cv[s + (k + n - 1) % n]], b = V[cv[s + (k + 1) % n]];
      const ax = a.x - p.x, ay = a.y - p.y, az = a.z - p.z, qx = b.x - p.x, qy = b.y - p.y, qz = b.z - p.z;
      const la = Math.sqrt(ax * ax + ay * ay + az * az), lb = Math.sqrt(qx * qx + qy * qy + qz * qz);
      const d = la > 0 && lb > 0 ? (ax * qx + ay * qy + az * qz) / (la * lb) : 1;
      st.cornerAngle[s + k] = Math.acos(d > 1 ? 1 : d < -1 ? -1 : d);
    }
  }
}

/** Gram-Schmidt (tx, ty, tz) against the unit normal, normalized into out[o..o+2]; an axis-derived tangent when the
 *  input is (near) zero or parallel to the normal (the pre-topology compile's rule, so UV-less meshes match it). */
function orthoTangent(nx: number, ny: number, nz: number, tx: number, ty: number, tz: number, out: Float64Array, o: number): void {
  let d = tx * nx + ty * ny + tz * nz;
  let x = tx - d * nx, y = ty - d * ny, z = tz - d * nz;
  let l = Math.sqrt(x * x + y * y + z * z);
  if (!(l > 1e-12)) {
    x = Math.abs(nx) > 0.9 ? 0 : 1; y = Math.abs(nx) > 0.9 ? 1 : 0; z = 0;
    d = x * nx + y * ny + z * nz;
    x -= d * nx; y -= d * ny; z -= d * nz;
    l = Math.sqrt(x * x + y * y + z * z) || 1;
  }
  out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l;
}

const _N = new Float64Array(3), _T = new Float64Array(3);

/** Write render vertex rv (position, normal, UV, tangent) into `buf`. */
function writeRenderVertex(st: RenderState, V: ArrayLike<P3>, rv: number, buf: Float32Array): void {
  const k0 = st.rvStart[rv], k1 = st.rvStart[rv + 1], c0 = st.rvCorners[k0], f0 = st.cornerFace[c0];
  const p = V[st.cornerVert[c0]];
  const fan = st.cornerFan[c0];
  let nx: number, ny: number, nz: number, tx: number, ty: number, tz: number, bx: number, by: number, bz: number;
  if (fan < 0) {
    // Flat: the face frame.
    const o = f0 * 3;
    nx = st.faceN[o]; ny = st.faceN[o + 1]; nz = st.faceN[o + 2];
    tx = st.faceT[o]; ty = st.faceT[o + 1]; tz = st.faceT[o + 2];
    bx = st.faceB[o]; by = st.faceB[o + 1]; bz = st.faceB[o + 2];
  } else {
    // Smooth: angle-weighted face normals over the whole fan (ascending corner order) …
    nx = 0; ny = 0; nz = 0;
    for (let k = st.fanStart[fan]; k < st.fanStart[fan + 1]; k++) {
      const c = st.fanCorners[k], o = st.cornerFace[c] * 3, w = st.cornerAngle[c];
      nx += st.faceN[o] * w; ny += st.faceN[o + 1] * w; nz += st.faceN[o + 2] * w;
    }
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-12) { nx /= l; ny /= l; nz /= l; }
    else { const o = f0 * 3; nx = st.faceN[o]; ny = st.faceN[o + 1]; nz = st.faceN[o + 2]; }
    // … the tangent over this render vertex's own corners (same fan, same UV).
    tx = 0; ty = 0; tz = 0; bx = 0; by = 0; bz = 0;
    for (let k = k0; k < k1; k++) {
      const o = st.cornerFace[st.rvCorners[k]] * 3;
      tx += st.faceT[o]; ty += st.faceT[o + 1]; tz += st.faceT[o + 2];
      bx += st.faceB[o]; by += st.faceB[o + 1]; bz += st.faceB[o + 2];
    }
  }
  _N[0] = nx; _N[1] = ny; _N[2] = nz;
  orthoTangent(nx, ny, nz, tx, ty, tz, _T, 0);
  const qx = _T[0], qy = _T[1], qz = _T[2];
  // handedness: sign(dot(cross(N, T), B)); no UV gradient → +1
  const cx = ny * qz - nz * qy, cy = nz * qx - nx * qz, cz = nx * qy - ny * qx;
  const w = cx * bx + cy * by + cz * bz < 0 ? -1 : 1;
  const o = rv * FLOATS_PER_VERT;
  buf[o] = p.x; buf[o + 1] = p.y; buf[o + 2] = p.z;
  // (+ 0 turns a -0 into +0, so an axis-aligned face writes the generator's exact bits)
  buf[o + 3] = nx + 0; buf[o + 4] = ny + 0; buf[o + 5] = nz + 0;
  buf[o + 6] = st.cornerUV[c0 * 2]; buf[o + 7] = st.cornerUV[c0 * 2 + 1];
  buf[o + 8] = qx + 0; buf[o + 9] = qy + 0; buf[o + 10] = qz + 0; buf[o + 11] = w;
}

// ── Triangulation ─────────────────────────────────────────────────────────────

/**
 * Corner-local triangle list of a polygon: a triangle as is, a quad as (0,1,2)(0,2,3) (the generators' split, so a
 * primitive's diagonals are kept), 5+ corners by ear clipping in the plane of the Newell normal (handles concave
 * n-gons), falling back to a fan when no ear is found (degenerate / self-intersecting).
 */
export function triangulateFace(V: ArrayLike<P3>, vs: ArrayLike<number>): number[] {
  const n = vs.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  if (n === 4) return [0, 1, 2, 0, 2, 3];
  // Project onto the face plane (drop the dominant normal axis, keep the orientation CCW).
  let nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < n; k++) {
    const a = V[vs[k]], b = V[vs[(k + 1) % n]];
    nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
  }
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const px = new Float64Array(n), py = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const p = V[vs[k]];
    if (az >= ax && az >= ay) { px[k] = p.x; py[k] = nz >= 0 ? p.y : -p.y; }
    else if (ax >= ay) { px[k] = p.y; py[k] = nx >= 0 ? p.z : -p.z; }
    else { px[k] = p.z; py[k] = ny >= 0 ? p.x : -p.x; }
  }
  const cross = (a: number, b: number, c: number): number => (px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a]);
  const inside = (p: number, a: number, b: number, c: number): boolean =>
    cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const ring: number[] = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  let guard = n * n + 8;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      if (cross(a, b, c) <= 0) continue;   // reflex / collinear
      let ear = true;
      for (const q of ring) {
        if (q === a || q === b || q === c) continue;
        if (inside(q, a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(a, b, c);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (ring.length === 3) { out.push(ring[0], ring[1], ring[2]); return out; }
  // No ear (degenerate): fan the rest.
  for (let k = 1; k < ring.length - 1; k++) out.push(ring[0], ring[k], ring[k + 1]);
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function edgeKey(a: number, b: number, nv: number): number {
  return a < b ? a * nv + b : b * nv + a;
}

/** CSR of `count` ids over items 0..n-1 by `idOf` (−1 = no bucket); each bucket ascending. */
function csr(count: number, n: number, idOf: (i: number) => number): { start: Int32Array; items: Int32Array } {
  const start = new Int32Array(count + 1);
  for (let i = 0; i < n; i++) { const id = idOf(i); if (id >= 0) start[id + 1]++; }
  for (let k = 0; k < count; k++) start[k + 1] += start[k];
  const fill = start.slice(0, count);
  const items = new Int32Array(start[count]);
  for (let i = 0; i < n; i++) { const id = idOf(i); if (id >= 0) items[fill[id]++] = i; }
  return { start, items };
}
