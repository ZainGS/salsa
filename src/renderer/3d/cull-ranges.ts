/**
 * P11 (docs/specs/performance-plan.md): SUB-MESH CULL RANGES.
 *
 * A merged city chunk (and, worse, a streamed tile's layer: ONE mesh per layer per tile, a 420 m box) passes the
 * frustum test whenever any corner of its box is in view, and then draws every triangle. Phase 0 measured 36-41 % of
 * the main pass and 50-68 % of the near shadow cascade as triangles outside the view / cascade inside such boxes.
 *
 * A heavy mesh's index list is cut into consecutive RUNS of a fixed triangle count, each with its own world box
 * (builders emit object by object, so a run is spatially compact), and every BLOCK of runs has a box too (the test is
 * hierarchical: a block outside skips its runs, a block wholly inside keeps them untested). A mesh that passes the
 * frustum test but is not wholly inside it draws only its runs whose box passes, as a few index sub-ranges: adjacent
 * kept runs merge into one draw, and so do kept runs separated by a short gap of dropped ones (a draw call costs more
 * than a few hundred clipped triangles).
 *
 * Triangles are drawn in their original order, and a run is dropped only when its box lies wholly outside one clip
 * plane (so every one of its triangles is clipped anyway): the image is bit-identical.
 *
 * Pure: unit-tested in cull-ranges.test.ts.
 */

export interface CullRanges {
  /** Number of runs. */
  n: number;
  /** Run i covers indices [first[i], first[i] + count[i]) of the mesh's index list (runs are contiguous, in order). */
  first: Int32Array;
  count: Int32Array;
  /** World boxes, 6 floats per run (minX, minY, minZ, maxX, maxY, maxZ). */
  box: Float64Array;
  /** Runs per block, and the blocks' world boxes (6 floats each; block b = runs [b * blockRuns, (b + 1) * blockRuns)). */
  blockRuns: number;
  blockBox: Float64Array;
  /** P22 propCull: the runs are INSTANCE ranges of an instanced group (first / count in copies), not index ranges. */
  inst?: boolean;
}

/** The six-plane box tests (FrustumCuller): intersects, and wholly inside. */
export interface BoxTester {
  testAABB(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean;
  containsAABB(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean;
}

/** Cut `indices` into runs of `runTris` triangles, grouped in blocks of `blockRuns`; boxes in world space through the
 *  column-major `m` (null = identity). `stride` = floats per vertex (position first). */
export function buildCullRanges(vertices: ArrayLike<number>, indices: ArrayLike<number>, stride: number,
                                m: ArrayLike<number> | null, runTris: number, blockRuns = 16): CullRanges {
  const tris = Math.floor(indices.length / 3), run = Math.max(1, runTris | 0), br = Math.max(1, blockRuns | 0);
  const n = Math.ceil(tris / run), nb = Math.ceil(n / br);
  const first = new Int32Array(n), count = new Int32Array(n), box = new Float64Array(n * 6), blockBox = new Float64Array(nb * 6);
  for (let b = 0; b < nb; b++) { blockBox[b * 6] = blockBox[b * 6 + 1] = blockBox[b * 6 + 2] = Infinity; blockBox[b * 6 + 3] = blockBox[b * 6 + 4] = blockBox[b * 6 + 5] = -Infinity; }
  for (let r = 0; r < n; r++) {
    const i0 = r * run * 3, i1 = Math.min(tris * 3, i0 + run * 3);
    first[r] = i0; count[r] = i1 - i0;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let j = i0; j < i1; j++) {
      const bi = indices[j] * stride;
      let x = vertices[bi], y = vertices[bi + 1], z = vertices[bi + 2];
      if (m) {
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        x = wx; y = wy; z = wz;
      }
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    box[r * 6] = x0; box[r * 6 + 1] = y0; box[r * 6 + 2] = z0; box[r * 6 + 3] = x1; box[r * 6 + 4] = y1; box[r * 6 + 5] = z1;
    const o = Math.floor(r / br) * 6;
    if (x0 < blockBox[o]) blockBox[o] = x0; if (y0 < blockBox[o + 1]) blockBox[o + 1] = y0; if (z0 < blockBox[o + 2]) blockBox[o + 2] = z0;
    if (x1 > blockBox[o + 3]) blockBox[o + 3] = x1; if (y1 > blockBox[o + 4]) blockBox[o + 4] = y1; if (z1 > blockBox[o + 5]) blockBox[o + 5] = z1;
  }
  return { n, first, count, box, blockRuns: br, blockBox };
}

/**
 * The index spans to draw: the runs whose box passes `t`, adjacent ones merged, and kept runs separated by at most
 * `mergeGap` dropped runs merged too (the gap is drawn: still bit-identical, it is clipped). Writes (first, count)
 * pairs into `out` (length reset) and returns the triangles in the spans.
 */
export function selectRanges(r: CullRanges, t: BoxTester, out: number[], mergeGap = 0): number {
  out.length = 0;
  let open = -1, openEnd = 0, gap = 0, lastKeptEnd = 0, tris = 0;
  const b = r.box, bb = r.blockBox, br = r.blockRuns, nb = Math.ceil(r.n / br);
  const keep = (i: number): void => {
    const f = r.first[i], e = f + r.count[i];
    if (open >= 0 && gap <= mergeGap) openEnd = e;
    else { if (open >= 0) { out.push(open, lastKeptEnd - open); tris += (lastKeptEnd - open) / 3; } open = f; openEnd = e; }
    lastKeptEnd = e; gap = 0;
  };
  for (let k = 0; k < nb; k++) {
    const o = k * 6, r0 = k * br, r1 = Math.min(r.n, r0 + br);
    if (!t.testAABB(bb[o], bb[o + 1], bb[o + 2], bb[o + 3], bb[o + 4], bb[o + 5])) { gap += r1 - r0; continue; }
    if (t.containsAABB(bb[o], bb[o + 1], bb[o + 2], bb[o + 3], bb[o + 4], bb[o + 5])) { for (let i = r0; i < r1; i++) keep(i); continue; }
    for (let i = r0; i < r1; i++) {
      const q = i * 6;
      if (t.testAABB(b[q], b[q + 1], b[q + 2], b[q + 3], b[q + 4], b[q + 5])) keep(i); else gap++;
    }
  }
  if (open >= 0) { out.push(open, lastKeptEnd - open); tris += (lastKeptEnd - open) / 3; }
  void openEnd;
  return tris;
}
