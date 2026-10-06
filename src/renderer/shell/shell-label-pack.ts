/**
 * shell-label-pack.ts — the label atlas's shelf packer + its "what do I have to rasterize" decision (pure, no GPU).
 *
 * The atlas is ADDITIVE: a label that is already packed keeps its cell (and its pixels), and only labels that are new
 * get measured, rasterized and uploaded. Flipping home ↔ illustrations, hovering, or scrolling the project grid
 * therefore costs nothing for text that was shown before (the old atlas re-rasterized EVERY label whenever the set
 * changed). A full repack happens only on the first build, after `invalidate()` (font load) and when the shelf runs
 * out of room.
 */

/** Left-to-right shelves with variable row height, exactly the placement the atlas always used. */
export class LabelShelfPacker {
  private cx = 0;
  private cy = 0;
  private rowMax = 0;

  constructor(readonly width: number) {}

  /** Place a w×h cell; returns its top-left. A cell wider than the atlas still gets a row of its own. */
  place(w: number, h: number): { x: number; y: number } {
    if (this.cx + w > this.width) { this.cx = 0; this.cy += this.rowMax; this.rowMax = 0; }
    const at = { x: this.cx, y: this.cy };
    this.cx += w;
    this.rowMax = Math.max(this.rowMax, h);
    return at;
  }

  /** Height used so far (the bottom of the current row). */
  get height(): number { return this.cy + this.rowMax; }

  /** Save / restore the cursor (to try a batch of placements and roll back). */
  snapshot(): [number, number, number] { return [this.cx, this.cy, this.rowMax]; }
  restore(s: readonly [number, number, number]): void { this.cx = s[0]; this.cy = s[1]; this.rowMax = s[2]; }

  reset(): void { this.cx = 0; this.cy = 0; this.rowMax = 0; }
}

/** The atlas key of one label request (what makes two requests the same raster). */
export function labelKey(text: string, maxWidthPx: number, fontPx: number, fontFamily: string, scaleX = 1, scaleY = 1): string {
  return `${text}|${Math.round(maxWidthPx)}|${Math.round(fontPx)}|${fontFamily}|${scaleX.toFixed(2)}|${scaleY.toFixed(2)}`;
}

/** The requested keys that are not packed yet, in request order (duplicates collapsed). */
export function missingLabelKeys(requested: Iterable<string>, has: (key: string) => boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of requested) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (!has(k)) out.push(k);
  }
  return out;
}

/**
 * The atlas height to allocate for `neededH` rows: `step` doubled until it fits (so a few new labels don't resize the
 * texture, and with a power-of-two step the height is a power of two: a cell's v = y / height is then exact in
 * float32), within `maxH`.
 */
export function atlasAllocHeight(neededH: number, step: number, maxH: number): number {
  let h = Math.max(1, step);
  while (h < neededH && h < maxH) h *= 2;
  return Math.max(1, Math.min(h, maxH));
}
