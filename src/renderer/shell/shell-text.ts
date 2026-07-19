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
 * atlas. The atlas rebuilds only when the set of (text, width, size) changes.
 */

/** UV + pixel-size record for one rasterized label. */
export interface LabelEntry {
  u0: number; v0: number; u1: number; v1: number;
  /** Rasterized width/height in atlas (device) pixels. */
  wPx: number; hPx: number;
}

const ATLAS_WIDTH = 2048;

export class ShellLabelAtlas {
  private device: GPUDevice;
  private texture: GPUTexture | null = null;
  private size: [number, number] = [ATLAS_WIDTH, 1];
  private entries = new Map<string, LabelEntry>();
  private signature = '';

  private canvas = new OffscreenCanvas(ATLAS_WIDTH, 1);
  private c2d: OffscreenCanvasRenderingContext2D;

  constructor(device: GPUDevice) {
    this.device = device;
    this.c2d = this.canvas.getContext('2d')!;
  }

  /** The atlas GPU texture (null until `build` runs at least once). */
  getTexture(): GPUTexture | null { return this.texture; }
  getSize(): [number, number] { return this.size; }

  /** Force the next `build` to re-rasterize (e.g. after a web font loads). */
  invalidate(): void { this.signature = ''; }

  /** Look up a label's atlas record. Returns null if it isn't packed.
   *  `fontFamily` must be the resolved family used at build time. */
  get(text: string, maxWidthPx: number, fontPx: number, fontFamily: string, scaleX = 1, scaleY = 1): LabelEntry | null {
    return this.entries.get(this.key(text, maxWidthPx, fontPx, fontFamily, scaleX, scaleY)) ?? null;
  }

  private key(text: string, maxWidthPx: number, fontPx: number, fontFamily: string, scaleX = 1, scaleY = 1): string {
    return `${text}|${Math.round(maxWidthPx)}|${Math.round(fontPx)}|${fontFamily}|${scaleX.toFixed(2)}|${scaleY.toFixed(2)}`;
  }

  /**
   * Rebuild the atlas for the given labels if the set changed. Each request
   * carries its own `fontPx`, so tile labels, a big title, and small badges
   * coexist in one atlas. Rows have variable height.
   */
  build(
    requests: { text: string; maxWidthPx: number; fontPx: number; fontFamily?: string; scaleX?: number; scaleY?: number }[],
    defaultFontFamily: string,
  ): void {
    type Req = { text: string; maxWidthPx: number; fontPx: number; fontFamily: string; scaleX: number; scaleY: number };
    const uniq = new Map<string, Req>();
    for (const r of requests) {
      if (!r.text) continue;
      const sx = r.scaleX ?? 1, sy = r.scaleY ?? 1;
      const fam = r.fontFamily ?? defaultFontFamily;
      uniq.set(this.key(r.text, r.maxWidthPx, r.fontPx, fam, sx, sy),
        { text: r.text, maxWidthPx: r.maxWidthPx, fontPx: r.fontPx, fontFamily: fam, scaleX: sx, scaleY: sy });
    }
    const sig = `${defaultFontFamily}|` + [...uniq.keys()].sort().join('~');
    if (sig === this.signature && this.texture) return;
    this.signature = sig;

    // Shelf-pack with per-request font + variable row height.
    type Placed = { key: string; text: string; w: number; h: number; padX: number; font: string; sx: number; sy: number; x: number; y: number };
    const placed: Placed[] = [];
    // Supersample: rasterize at SS× the requested size, then report the LOGICAL size (÷ SS) so the on-screen
    // quad is unchanged but samples a denser texture → crisp labels (was 1:1 + linear = soft/blurry).
    const SS = 3;
    let cx = 0, cy = 0, rowMax = 0;
    for (const [key, r] of uniq) {
      const fpx = r.fontPx * SS;
      const font = `400 ${fpx}px ${r.fontFamily}`;
      this.c2d.font = font;
      const lineH = Math.ceil(fpx * 1.4 * r.scaleY);   // taller/shorter row
      const padX = Math.ceil(fpx * 0.3);
      const text = this.truncate(r.text, r.maxWidthPx * SS);   // maxWidth is logical → compare at the SS× font
      const w = Math.ceil(this.c2d.measureText(text).width * r.scaleX) + padX * 2;
      if (cx + w > ATLAS_WIDTH) { cx = 0; cy += rowMax; rowMax = 0; }
      placed.push({ key, text, w, h: lineH, padX, font, sx: r.scaleX, sy: r.scaleY, x: cx, y: cy });
      cx += w;
      rowMax = Math.max(rowMax, lineH);
    }
    const atlasH = Math.max(1, cy + rowMax);

    if (this.canvas.height !== atlasH) this.canvas.height = atlasH;
    this.c2d.clearRect(0, 0, ATLAS_WIDTH, atlasH);
    this.c2d.textBaseline = 'middle';
    this.c2d.textAlign = 'left';
    this.c2d.fillStyle = '#ffffff';

    this.entries.clear();
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
      this.entries.set(p.key, {
        u0: p.x / ATLAS_WIDTH,
        v0: p.y / atlasH,
        u1: (p.x + p.w) / ATLAS_WIDTH,
        v1: (p.y + p.h) / atlasH,
        wPx: p.w / SS,   // report the LOGICAL (on-screen) size; the UVs above point at the SS× texels
        hPx: p.h / SS,
      });
    }

    this.uploadTexture(ATLAS_WIDTH, atlasH);
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

  private uploadTexture(w: number, h: number): void {
    if (this.texture && (this.size[0] !== w || this.size[1] !== h)) {
      this.texture.destroy();
      this.texture = null;
    }
    if (!this.texture) {
      this.texture = this.device.createTexture({
        label: 'ShellLabelAtlas',
        size: { width: w, height: h },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.size = [w, h];
    }
    const bitmap = this.canvas.transferToImageBitmap();
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: this.texture },
      { width: w, height: h },
    );
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.entries.clear();
  }
}
