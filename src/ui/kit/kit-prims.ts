/**
 * src/ui/kit/kit-prims.ts
 *
 * The kit's GPU primitive list. Every kit piece lays out into a flat list of PRIMS (one instanced quad each) that a
 * single WGSL shader shades with an SDF (convex quad / burst star / ellipse / radial rays) or samples from the text
 * atlas (glyph), with an optional screen-tone pattern (halftone / stripes / gradient dots / lines / checker), jagged
 * edges and a fade mask. 32 floats (8 x vec4) per prim; the layout is mirrored by the struct in kit-renderer.ts.
 *
 * The builder keeps a canvas-like SIMILARITY transform (translate + rotate + uniform scale) so a widget's layout code
 * works in its own design-px space and the intro / clip animation is one transform on top.
 */

/** Prim kinds (b.y in the shader). */
export const PK_POLY = 0, PK_STAR = 1, PK_ELLIPSE = 2, PK_GLYPH = 3, PK_RAYS = 4;
/** Pattern codes (g.x). */
export const PAT = { none: 0, halftone: 1, stripes: 2, gradient: 3, lines: 4, checker: 5 } as const;
/** Fade-mask codes (h.z). */
export const FADE = { none: 0, left: 1, right: 2, up: 3, down: 4, radial: 5 } as const;

export const PRIM_FLOATS = 32;

export type RGBA = [number, number, number, number];
export type V2 = [number, number];

/** A rasterised text image in the atlas (device px). */
export interface KitGlyphEntry { u0: number; v0: number; u1: number; v1: number; w: number; h: number; }

/** What a text request asks the atlas for. `px` / `outline` are DEVICE px. */
export interface KitTextSpec {
  text: string;
  font: string;      // kit font token (impact | sans | serif | slab | mono | script)
  px: number;
  outline?: number;
  slant?: number;    // horizontal shear applied while rasterising (crisp italics)
  italic?: boolean;
  weight?: number;
}

/** Text raster + measurement surface (the GPU atlas in the app, a fake in tests). */
export interface KitTextProvider {
  /** Width of the text at `px` (same units as px). */
  measure(text: string, font: string, px: number): number;
  /** Atlas entry for the spec (rasterised on demand); null = not available (headless). */
  get(spec: KitTextSpec): KitGlyphEntry | null;
}

export interface PrimOpts {
  color2?: RGBA;
  pattern?: number;
  patternScale?: number;   // LOCAL units (scaled by the transform)
  patternAngle?: number;   // radians
  patternAmount?: number;
  jag?: number;            // LOCAL units
  jagWave?: number;        // LOCAL units
  seed?: number;
  fade?: number;
}

interface Xf { tx: number; ty: number; rot: number; k: number; }

export class PrimList {
  data = new Float32Array(PRIM_FLOATS * 256);
  count = 0;
  /** Global alpha multiplier (widget opacity × intro fade). */
  alpha = 1;
  private _xf: Xf = { tx: 0, ty: 0, rot: 0, k: 1 };
  private readonly _stack: Xf[] = [];

  reset(): void { this.count = 0; this.resetXf(); }
  /** Reset the transform + alpha but KEEP the prims already written (the next widget appends). */
  resetXf(): void { this.alpha = 1; this._xf = { tx: 0, ty: 0, rot: 0, k: 1 }; this._stack.length = 0; }
  save(): void { this._stack.push({ ...this._xf }); }
  restore(): void { const x = this._stack.pop(); if (x) this._xf = x; }
  /** Current uniform scale (local → device px). */
  get k(): number { return this._xf.k; }
  get rot(): number { return this._xf.rot; }
  translate(x: number, y: number): void {
    const { rot, k } = this._xf, c = Math.cos(rot) * k, s = Math.sin(rot) * k;
    this._xf.tx += c * x - s * y; this._xf.ty += s * x + c * y;
  }
  rotate(r: number): void { this._xf.rot += r; }
  scale(k: number): void { this._xf.k *= k; }
  /** Map a local point to device px. */
  map(x: number, y: number): V2 {
    const { tx, ty, rot, k } = this._xf, c = Math.cos(rot) * k, s = Math.sin(rot) * k;
    return [tx + c * x - s * y, ty + s * x + c * y];
  }

  private _slot(): number {
    if ((this.count + 1) * PRIM_FLOATS > this.data.length) {
      const nd = new Float32Array(this.data.length * 2); nd.set(this.data); this.data = nd;
    }
    return this.count++ * PRIM_FLOATS;
  }

  private _write(kind: number, cx: number, cy: number, hx: number, hy: number, rot: number, color: RGBA, o: PrimOpts,
    e: [number, number, number, number], f: [number, number, number, number], flags = 0): void {
    const a = this.alpha * color[3];
    if (a <= 0.001 && !(o.color2 && o.color2[3] * this.alpha > 0.001)) return;
    const [dx, dy] = this.map(cx, cy), k = this._xf.k;
    const i = this._slot(), d = this.data;
    d[i] = dx; d[i + 1] = dy; d[i + 2] = hx * k; d[i + 3] = hy * k;
    d[i + 4] = this._xf.rot + rot; d[i + 5] = kind; d[i + 6] = flags; d[i + 7] = (o.jag ?? 0) * k;
    d[i + 8] = color[0]; d[i + 9] = color[1]; d[i + 10] = color[2]; d[i + 11] = a;
    const c2 = o.color2 ?? color;
    d[i + 12] = c2[0]; d[i + 13] = c2[1]; d[i + 14] = c2[2]; d[i + 15] = c2[3] * this.alpha;
    d.set(e, i + 16); d.set(f, i + 20);
    d[i + 24] = o.pattern ?? 0; d[i + 25] = (o.patternScale ?? 10) * k; d[i + 26] = (o.patternAngle ?? 0) + this._xf.rot; d[i + 27] = o.patternAmount ?? 0.5;
    d[i + 28] = Math.max(1, (o.jagWave ?? 24) * k); d[i + 29] = o.seed ?? 0; d[i + 30] = o.fade ?? 0; d[i + 31] = 0;
  }

  /** Convex polygon of 3 or 4 LOCAL vertices (a triangle repeats its last vertex). Vertices are relative to (cx, cy). */
  poly(cx: number, cy: number, v: V2[], color: RGBA, o: PrimOpts = {}, rot = 0): void {
    const q = v.length === 3 ? [v[0], v[1], v[2], v[2]] : v;
    let hx = 0, hy = 0;
    for (const p of q) { hx = Math.max(hx, Math.abs(p[0])); hy = Math.max(hy, Math.abs(p[1])); }
    const k = this._xf.k, pad = 2 / Math.max(1e-3, k);
    hx += pad; hy += pad;
    this._write(PK_POLY, cx, cy, hx, hy, rot, color, o,
      [q[0][0] * k, q[0][1] * k, q[1][0] * k, q[1][1] * k], [q[2][0] * k, q[2][1] * k, q[3][0] * k, q[3][1] * k]);
  }
  /** Axis-aligned (local) rectangle sheared horizontally by `skew` (x += skew * -y, so +skew leans right). */
  slant(cx: number, cy: number, w: number, h: number, skew: number, color: RGBA, o: PrimOpts = {}, rot = 0): void {
    const hw = w / 2, hh = h / 2, sk = skew * hh;
    this.poly(cx, cy, [[-hw + sk, -hh], [hw + sk, -hh], [hw - sk, hh], [-hw - sk, hh]], color, o, rot);
  }
  rect(cx: number, cy: number, w: number, h: number, color: RGBA, o: PrimOpts = {}, rot = 0): void { this.slant(cx, cy, w, h, 0, color, o, rot); }
  /** Spiky burst: `spikes` points between inner ratio and the rx/ry ellipse. */
  star(cx: number, cy: number, rx: number, ry: number, spikes: number, inner: number, color: RGBA, o: PrimOpts = {}, phase = 0, irregular = 0.35): void {
    const pad = 2 / Math.max(1e-3, this._xf.k);
    this._write(PK_STAR, cx, cy, rx + pad, ry + pad, 0, color, o, [spikes, inner, phase, irregular], [rx * this._xf.k, ry * this._xf.k, 0, 0]);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, color: RGBA, o: PrimOpts = {}, ring = 0): void {
    const pad = 2 / Math.max(1e-3, this._xf.k);
    this._write(PK_ELLIPSE, cx, cy, rx + pad, ry + pad, 0, color, o, [ring * this._xf.k, 0, 0, 0], [rx * this._xf.k, ry * this._xf.k, 0, 0]);
  }
  /** Radial stripes (sun rays) inside an ellipse, alternating color / color2, with an inner hole ratio. */
  rays(cx: number, cy: number, rx: number, ry: number, count: number, color: RGBA, color2: RGBA, phase = 0, hole = 0, o: PrimOpts = {}): void {
    this._write(PK_RAYS, cx, cy, rx, ry, 0, color, { ...o, color2 }, [count, hole, phase, 0], [rx * this._xf.k, ry * this._xf.k, 0, 0]);
  }
  /** A rasterised text image centred at (cx, cy). `scaleK` = the extra (animation) scale between the raster and the
   *  drawn size. mode 0 = fill + outline (color = fill, color2 = outline); 1 = silhouette (outline ∪ fill) in color. */
  glyph(cx: number, cy: number, g: KitGlyphEntry, color: RGBA, color2: RGBA, mode: 0 | 1, rot = 0, scaleK = 1): void {
    const k = this._xf.k;
    // glyph extents are device px at the raster scale; express them in local units so the transform applies.
    const hx = (g.w / 2) * scaleK / k, hy = (g.h / 2) * scaleK / k;
    this._write(PK_GLYPH, cx, cy, hx, hy, rot, color, { color2 }, [g.u0, g.v0, g.u1, g.v1], [0, 0, 0, 0], mode);
  }
}
