/**
 * src/ui/kit/kit-text-atlas.ts
 *
 * Canvas-2D text atlas for the UI kit. Each (text, font, device px, outline, slant) is rasterised ONCE at its exact
 * device size — so kit type is crisp at any resolution — into a shelf-packed rgba8 atlas:
 *   R = fill coverage, G = (fill ∪ outline) coverage.
 * The kit shader composites fill over outline from those two channels, and draws drop shadows from G. Slanted
 * headings are sheared WHILE rasterising (no resampling blur). New entries upload just their own rectangle.
 */

import type { KitGlyphEntry, KitTextProvider, KitTextSpec } from './kit-prims';

/** Kit font token → CSS font stack (system fonts only: the kit ships no font files). */
export const KIT_FONT_CSS: Record<string, { family: string; weight: number; italic?: boolean }> = {
  impact: { family: 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif', weight: 400 },
  sans: { family: '"Arial Black", "Segoe UI Black", Arial, sans-serif', weight: 900 },
  serif: { family: 'Georgia, "Times New Roman", serif', weight: 700, italic: true },
  slab: { family: 'Rockwell, "Courier New", serif', weight: 700 },
  mono: { family: '"Courier New", Consolas, monospace', weight: 700 },
  script: { family: '"Segoe Script", "Comic Sans MS", cursive', weight: 700 },
};

export function kitCssFont(font: string, px: number): string {
  const f = KIT_FONT_CSS[font] ?? KIT_FONT_CSS.impact;
  return `${f.italic ? 'italic ' : ''}${f.weight} ${px}px ${f.family}`;
}

const ATLAS = 2048;
const GAP = 2;

export class KitTextAtlas implements KitTextProvider {
  private _device: GPUDevice | null = null;
  private _tex: GPUTexture | null = null;
  private readonly _entries = new Map<string, KitGlyphEntry>();
  private _x = GAP; private _y = GAP; private _rowH = 0;
  private readonly _measureCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  private readonly _measureCache = new Map<string, number>();
  /** Bumped whenever the atlas texture is replaced (the renderer rebuilds its bind group). */
  version = 0;

  constructor() {
    let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
    try { ctx = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8).getContext('2d') : null; } catch { ctx = null; }
    this._measureCtx = ctx;
  }

  /** Bind to a device (a new device → fresh texture + empty atlas). */
  setDevice(device: GPUDevice): void {
    if (device === this._device && this._tex) return;
    this._device = device;
    this._tex = device.createTexture({
      label: 'UIKitTextAtlas', size: [ATLAS, ATLAS], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._clear();
  }
  get texture(): GPUTexture | null { return this._tex; }

  private _clear(): void { this._entries.clear(); this._x = GAP; this._y = GAP; this._rowH = 0; this.version++; }

  measure(text: string, font: string, px: number): number {
    const key = `${font}|${text}`;
    let unit = this._measureCache.get(key);
    if (unit === undefined) {
      const c = this._measureCtx;
      if (c) { c.font = kitCssFont(font, 100); unit = c.measureText(text).width / 100; }
      else unit = text.length * 0.55;
      this._measureCache.set(key, unit);
    }
    return unit * px;
  }

  get(spec: KitTextSpec): KitGlyphEntry | null {
    if (!this._device || !this._tex || !spec.text) return null;
    const px = Math.max(4, Math.min(512, Math.round(spec.px)));
    const ow = Math.max(0, Math.round(spec.outline ?? 0));
    const sl = Math.round((spec.slant ?? 0) * 100) / 100;
    const key = `${spec.font}|${px}|${ow}|${sl}|${spec.text}`;
    const hit = this._entries.get(key);
    if (hit) return hit;
    return this._raster(key, spec.text, spec.font, px, ow, sl);
  }

  private _raster(key: string, text: string, font: string, px: number, ow: number, slant: number): KitGlyphEntry | null {
    const tw = this.measure(text, font, px);
    const lineH = Math.ceil(px * 1.3);
    const pad = ow + 4;
    const h = Math.min(ATLAS - 2 * GAP, lineH + 2 * pad);
    const shear = Math.ceil(Math.abs(slant) * h);
    const w = Math.min(ATLAS - 2 * GAP, Math.ceil(tw + 2 * pad + shear));
    if (this._x + w + GAP > ATLAS) { this._x = GAP; this._y += this._rowH + GAP; this._rowH = 0; }
    if (this._y + h + GAP > ATLAS) { this._clear(); }   // full → start over (entries re-rasterise on demand)
    const ax = this._x, ay = this._y;
    this._x += w + GAP; this._rowH = Math.max(this._rowH, h);

    let cv: OffscreenCanvas;
    try { cv = new OffscreenCanvas(w, h); } catch { return null; }
    const c = cv.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
    if (!c) return null;
    const draw = (withOutline: boolean): Uint8ClampedArray => {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, w, h);
      // shear about the vertical centre: x += -slant * (y - h/2) leans the tops right
      c.setTransform(1, 0, -slant, 1, slant * (h / 2), 0);
      c.font = kitCssFont(font, px);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.lineJoin = 'miter'; c.miterLimit = 3;
      c.fillStyle = '#fff'; c.strokeStyle = '#fff';
      const x = w / 2, y = h / 2 + px * 0.04;
      if (withOutline && ow > 0) { c.lineWidth = ow * 2; c.strokeText(text, x, y); }
      c.fillText(text, x, y);
      return c.getImageData(0, 0, w, h).data;
    };
    const fill = draw(false);
    const both = ow > 0 ? draw(true) : fill;
    const out = new Uint8Array(w * h * 4);
    for (let i = 0, j = 0; i < out.length; i += 4, j += 4) {
      out[i] = fill[j + 3]; out[i + 1] = both[j + 3]; out[i + 2] = 0; out[i + 3] = 255;
    }
    this._device!.queue.writeTexture({ texture: this._tex!, origin: [ax, ay] }, out, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h]);
    const e: KitGlyphEntry = { u0: ax / ATLAS, v0: ay / ATLAS, u1: (ax + w) / ATLAS, v1: (ay + h) / ATLAS, w, h };
    this._entries.set(key, e);
    return e;
  }
}
