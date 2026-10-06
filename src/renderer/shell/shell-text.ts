/**
 * shell-text.ts — Canvas-2D label atlas for the Shell UI.
 *
 * Shell text (tile labels, the title pill, info badges) is short and static,
 * so the engine's SDF glyph-compute system (built for arbitrarily scaled
 * vector text) is unnecessary here. Instead we rasterize each string once with
 * the Canvas 2D API — crisp, hinted, kerned for free — pack them into a single
 * texture atlas, and sample that atlas in ShellRenderer's textured-quad pass.
 *
 * Each request carries its own font size, so different sizes coexist in one
 * atlas. The atlas is ADDITIVE (shell-label-pack.ts): a packed label keeps its
 * cell, and only labels that are new get measured, rasterized and uploaded
 * (just their rows). A full repack happens on the first build, after
 * `invalidate()` and when the shelf runs out of room.
 *
 * The texture is r8unorm holding the glyph COVERAGE: the text is drawn white, so
 * the canvas's premultiplied red channel equals its alpha; the label shader
 * samples `.r`. (A quarter of the rgba8 upload + memory.)
 */
import { LabelShelfPacker, labelKey, missingLabelKeys, atlasAllocHeight } from './shell-label-pack';

/** UV + pixel-size record for one rasterized label. */
export interface LabelEntry {
  u0: number; v0: number; u1: number; v1: number;
  /** Rasterized width/height in atlas (device) pixels. */
  wPx: number; hPx: number;
}

const ATLAS_WIDTH = 2048;
/** Supersample: rasterize at SS× the requested size, then report the LOGICAL size (÷ SS) so the on-screen quad is
 *  unchanged but samples a denser texture → crisp labels (was 1:1 + linear = soft/blurry). */
const SS = 3;
/** The atlas height is allocated in steps of this many rows, so a few new labels don't resize the texture. */
const ALLOC_STEP = 512;
/** Labels accumulate (stale ones included) up to this height; past it the atlas repacks with the current set only. */
const ACCUMULATE_MAX_H = 4096;

export interface LabelRequest { text: string; maxWidthPx: number; fontPx: number; fontFamily?: string; scaleX?: number; scaleY?: number }
type Req = { text: string; maxWidthPx: number; fontPx: number; fontFamily: string; scaleX: number; scaleY: number };
type Placed = { key: string; text: string; w: number; h: number; padX: number; font: string; sx: number; sy: number; x: number; y: number };

export class ShellLabelAtlas {
  private device: GPUDevice;
  private texture: GPUTexture | null = null;
  private size: [number, number] = [ATLAS_WIDTH, 1];
  private entries = new Map<string, LabelEntry>();
  /** Cells as packed (atlas px), for the "would it still fit" dry run. */
  private cells = new Map<string, { w: number; h: number }>();
  /** The request behind every packed label (to re-rasterize them when the texture grows). */
  private reqs = new Map<string, Req>();
  private packer = new LabelShelfPacker(ATLAS_WIDTH);
  private dirtyAll = true;
  private _version = 0;
  /** Counters for the perf HUD / tests: labels rasterized, full repacks. */
  rasterCount = 0;
  repackCount = 0;

  private canvas = new OffscreenCanvas(ATLAS_WIDTH, 1);
  private c2d: OffscreenCanvasRenderingContext2D;

  constructor(device: GPUDevice) {
    this.device = device;
    this.c2d = this.canvas.getContext('2d')!;
  }

  /** The atlas GPU texture (null until `build` runs at least once). */
  getTexture(): GPUTexture | null { return this.texture; }
  getSize(): [number, number] { return this.size; }
  /** Bumped whenever an entry or the texture changes (callers re-resolve their cached entries). */
  get version(): number { return this._version; }

  /** Force the next `build` to re-rasterize everything (e.g. after a web font loads). */
  invalidate(): void { this.dirtyAll = true; this._version++; }

  /** Look up a label's atlas record. Returns null if it isn't packed.
   *  `fontFamily` must be the resolved family used at build time. */
  get(text: string, maxWidthPx: number, fontPx: number, fontFamily: string, scaleX = 1, scaleY = 1): LabelEntry | null {
    return this.entries.get(labelKey(text, maxWidthPx, fontPx, fontFamily, scaleX, scaleY)) ?? null;
  }

  /**
   * Make sure every requested label is packed. Each request carries its own
   * `fontPx`, so tile labels, a big title, and small badges coexist in one
   * atlas. Rows have variable height. Labels packed by an earlier call stay
   * (additive); only the missing ones are rasterized.
   */
  build(requests: readonly LabelRequest[], defaultFontFamily: string): void {
    const uniq = new Map<string, Req>();
    for (const r of requests) {
      if (!r.text) continue;
      const sx = r.scaleX ?? 1, sy = r.scaleY ?? 1;
      const fam = r.fontFamily ?? defaultFontFamily;
      uniq.set(labelKey(r.text, r.maxWidthPx, r.fontPx, fam, sx, sy),
        { text: r.text, maxWidthPx: r.maxWidthPx, fontPx: r.fontPx, fontFamily: fam, scaleX: sx, scaleY: sy });
    }
    const maxH = this.device.limits?.maxTextureDimension2D ?? 8192;

    if (!this.dirtyAll && this.texture) {
      const missing = missingLabelKeys(uniq.keys(), k => this.entries.has(k));
      if (missing.length === 0) return;
      // Additive: place the new labels after the existing ones, if they fit the allocated texture.
      const snap = this.packer.snapshot();
      const placed: Placed[] = [];
      for (const key of missing) placed.push(this.measureAndPlace(key, uniq.get(key)!));
      if (this.packer.height <= this.size[1]) {
        this.raster(placed, false);
        return;
      }
      // Out of rows: undo the trial placement. Grow (keeping every packed label) while that stays under the
      // accumulation cap; otherwise repack with the current set only (stale labels are dropped).
      this.packer.restore(snap);
      for (const key of missing) this.reqs.delete(key);
      const cap = Math.min(maxH, ACCUMULATE_MAX_H);
      if (this.fitsAccumulated(uniq, cap)) {
        const keep = new Map<string, Req>(this.reqs);
        for (const [k, r] of uniq) keep.set(k, r);
        this.rebuildAll(keep, cap, this.size[1] * 2);   // grow geometrically: few regrows as labels accumulate
        return;
      }
    }
    this.rebuildAll(uniq, maxH);
  }

  /** Would the packed labels + `extra` fit in `capH` rows? (A dry run of the shelf packer.) */
  private fitsAccumulated(extra: Map<string, Req>, capH: number): boolean {
    const dry = new LabelShelfPacker(ATLAS_WIDTH);
    for (const c of this.cells.values()) dry.place(c.w, c.h);
    for (const [k, r] of extra) {
      if (this.cells.has(k)) continue;
      const m = this.measure(r);
      dry.place(m.w, m.h);
    }
    return dry.height <= capH;
  }

  private measure(r: Req): { text: string; w: number; h: number; padX: number; font: string } {
    const fpx = r.fontPx * SS;
    const font = `400 ${fpx}px ${r.fontFamily}`;
    this.c2d.font = font;
    const lineH = Math.ceil(fpx * 1.4 * r.scaleY);   // taller/shorter row
    const padX = Math.ceil(fpx * 0.3);
    const text = this.truncate(r.text, r.maxWidthPx * SS);   // maxWidth is logical → compare at the SS× font
    const w = Math.ceil(this.c2d.measureText(text).width * r.scaleX) + padX * 2;
    return { text, w, h: lineH, padX, font };
  }

  private measureAndPlace(key: string, r: Req): Placed {
    const m = this.measure(r);
    const at = this.packer.place(m.w, m.h);
    this.reqs.set(key, r);
    return { key, text: m.text, w: m.w, h: m.h, padX: m.padX, font: m.font, sx: r.scaleX, sy: r.scaleY, x: at.x, y: at.y };
  }

  /** Repack + re-rasterize exactly `set` (drops every other label). `minH` = allocate at least this many rows. */
  private rebuildAll(set: Map<string, Req>, maxH: number, minH = 0): void {
    this.packer.reset();
    this.reqs = new Map();
    this.cells.clear();
    this.entries.clear();
    const placed: Placed[] = [];
    for (const [key, r] of set) placed.push(this.measureAndPlace(key, r));
    // Clamp to the device's max texture dimension — a very long label list could otherwise exceed it and throw
    // unguarded in createTexture. (Labels past the clamp get clipped rather than crashing the whole shell.)
    const atlasH = atlasAllocHeight(Math.max(this.packer.height, minH), ALLOC_STEP, maxH);
    if (this.canvas.height !== atlasH) this.canvas.height = atlasH;   // (a resize clears the canvas)
    this.c2d.clearRect(0, 0, ATLAS_WIDTH, atlasH);
    this.ensureTexture(ATLAS_WIDTH, atlasH);
    this.dirtyAll = false;
    this.repackCount++;
    this.raster(placed, true);
  }

  /** Draw `placed` into the canvas, record their entries and upload the rows they touch (or everything). */
  private raster(placed: Placed[], all: boolean): void {
    const atlasH = this.size[1];
    this.c2d.textBaseline = 'middle';
    this.c2d.textAlign = 'left';
    this.c2d.fillStyle = '#ffffff';
    let y0 = Infinity, y1 = 0;
    for (const p of placed) {
      this.c2d.font = p.font;             // per-label size (also re-set after resize)
      if (p.sx !== 1 || p.sy !== 1) {
        // Squash/stretch about the cell center (baseline = middle).
        this.c2d.save();
        this.c2d.translate(p.x + p.padX, p.y + p.h / 2);
        this.c2d.scale(p.sx, p.sy);
        this.c2d.fillText(p.text, 0, 0);
        this.c2d.restore();
      } else {
        this.c2d.fillText(p.text, p.x + p.padX, p.y + p.h / 2);
      }
      this.cells.set(p.key, { w: p.w, h: p.h });
      this.entries.set(p.key, {
        u0: p.x / ATLAS_WIDTH,
        v0: p.y / atlasH,
        u1: (p.x + p.w) / ATLAS_WIDTH,
        v1: (p.y + p.h) / atlasH,
        wPx: p.w / SS,   // report the LOGICAL (on-screen) size; the UVs above point at the SS× texels
        hPx: p.h / SS,
      });
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y + p.h);
    }
    this.rasterCount += placed.length;
    this._version++;
    if (all) this.upload(0, atlasH);
    else if (y1 > y0) this.upload(Math.max(0, Math.floor(y0)), Math.min(atlasH, Math.ceil(y1)));
  }

  /** Truncate `text` with an ellipsis so it fits within `maxWidthPx` (font
   *  must already be set on the 2D context). */
  private truncate(text: string, maxWidthPx: number): string {
    if (this.c2d.measureText(text).width <= maxWidthPx) return text;
    const ell = '…';
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.c2d.measureText(text.slice(0, mid) + ell).width <= maxWidthPx) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + ell : ell;
  }

  private ensureTexture(w: number, h: number): void {
    if (this.texture && (this.size[0] !== w || this.size[1] !== h)) {
      this.texture.destroy();
      this.texture = null;
    }
    if (!this.texture) {
      this.texture = this.device.createTexture({
        label: 'ShellLabelAtlas',
        size: { width: w, height: h },
        format: 'r8unorm',   // coverage only (see the file header)
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    this.size = [w, h];
  }

  /** Upload canvas rows [y0, y1) to the texture. The canvas keeps its pixels (no transferToImageBitmap), which is
   *  what lets a later build add labels without redrawing the old ones. premultipliedAlpha → red = coverage. */
  private upload(y0: number, y1: number): void {
    if (!this.texture || y1 <= y0) return;
    this.device.queue.copyExternalImageToTexture(
      { source: this.canvas, origin: { x: 0, y: y0 } },
      { texture: this.texture, origin: { x: 0, y: y0 }, premultipliedAlpha: true },
      { width: this.size[0], height: y1 - y0 },
    );
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.entries.clear();
    this.cells.clear();
    this.reqs.clear();
    this.packer.reset();
    this.dirtyAll = true;
  }
}
