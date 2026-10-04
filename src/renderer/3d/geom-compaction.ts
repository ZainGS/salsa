// P10.B6 — in-place GPU compaction plan for the renderer's shared geometry pool (renderer-3d.ts _compactGeomPoolGpu).
// Pure (no WebGPU) so it is unit-tested by simulating the copies on a byte array.

/** P10.B6: plan an IN-PLACE compaction of disjoint byte spans of one buffer into a dense prefix. Spans keep their
 *  relative order by OLD offset; each new offset is the sum of the sizes before it, so it is ≤ the old one and a move
 *  never overwrites bytes not yet moved — PROVIDED the moves run in the returned order, each one bounced through a
 *  scratch buffer (`[src, dst, size]`: copy src→scratch, then scratch→dst; a buffer cannot be both ends of a copy).
 *  Spans bigger than `scratch` move in ascending chunks. Spans already in place emit no move. `newOff[k]` is span
 *  k's new offset (input order); `tail` = the packed size. Pure — unit-tested by simulation. */
export function planSpanCompaction(spans: readonly { off: number; size: number }[], scratch: number, coalesce = false): { newOff: number[]; tail: number; moves: [number, number, number][] } {
  const order = spans.map((_, k) => k).sort((a, b) => spans[a].off - spans[b].off);
  const newOff = new Array<number>(spans.length).fill(0);
  const moves: [number, number, number][] = [];
  const emit = (off: number, dst: number, size: number): void => { for (let j = 0; j < size; j += scratch) moves.push([off + j, dst + j, Math.min(scratch, size - j)]); };
  let cur = 0;
  // P16 (STREAM_HITCH.coalescedCompaction): spans ADJACENT in the old layout move by the same distance (the new offsets
  // are prefix sums, so no gap = same shift), so a run of them is one move (chunked by the scratch size) instead of
  // one copy pair per span: a streamed pool holds ~10 k live geometries in long runs between the holes of tiles that
  // left, and every copy is an encoder call (two per move).
  let runSrc = -1, runDst = 0, runLen = 0;
  for (const k of order) {
    const { off, size } = spans[k];
    newOff[k] = cur;
    if (!coalesce) { if (off !== cur && size > 0) emit(off, cur, size); cur += size; continue; }
    if (size > 0) {
      if (runSrc >= 0 && runSrc + runLen === off) runLen += size;   // continues the run (same shift)
      else { if (runSrc >= 0 && runSrc !== runDst) emit(runSrc, runDst, runLen); runSrc = off; runDst = cur; runLen = size; }
    }
    cur += size;
  }
  if (coalesce && runSrc >= 0 && runSrc !== runDst) emit(runSrc, runDst, runLen);
  return { newOff, tail: cur, moves };
}

/** P10.D4 POOL SHRINK: the geometry pool grows (×1.5 on overflow, ×2.5 headroom on a full rebuild) but used to NEVER
 *  release capacity (bug-hunt D-R1) — a streamed tiled world that once held 1.8 GB kept 1.8 GB of buffers after the
 *  tiles left. After a compaction the live bytes are a dense prefix of `used` bytes; when the buffer is more than
 *  `trigger` × bigger than what it needs, return the smaller capacity to reallocate to (`used` × `headroom`, at least
 *  `minCap`, 4-byte aligned), else null (keep the buffer). `trigger` > the full rebuild's 2.5× headroom so a fresh
 *  rebuild never shrinks straight away, and `headroom` < `trigger` so a shrink is not immediately undone by growth. */
export function planPoolShrink(cap: number, used: number, minCap = 64 << 20, trigger = 3, headroom = 1.6): number | null {
  const need = Math.max(minCap, Math.ceil(used * headroom / 4) * 4);
  if (cap <= minCap || cap <= need || cap < trigger * Math.max(used, 1)) return null;
  return need;
}
