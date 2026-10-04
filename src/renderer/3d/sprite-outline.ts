import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle } from '../core/gpu-pipeline-cache';
/**
 * sprite-outline.ts — ALPHA-SHAPED outlines for textured sprites (docs/specs/sprite-alpha-outlines.md).
 *
 * The per-object outline is an inflated hull, which on a flat sprite quad can only ever trace the quad's SQUARE
 * border. For a sprite whose texture has transparency (an icon / reaction PNG) we instead build a small signed
 * DISTANCE FIELD of the image's alpha, once per texture, and draw the outline rings from it (see the sprite path in
 * MeshHighlightPass). This module is the CPU half: the distance transform (pure, unit-tested) + the async
 * per-texture builder/cache (a GPU blit of the alpha into a small readable target → EDT → an r8 field texture).
 *
 * Nothing here runs for any mesh that isn't a transparent-textured sprite; every other outline keeps the hull path.
 */

/** Exact 1D squared distance transform (Felzenszwalb & Huttenlocher) of f over n samples → out. */
function edt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}

/** Exact 2D Euclidean distance (texels) from every cell to the nearest cell where `inside(i)` is true. */
function edt2d(w: number, h: number, inside: (i: number) => boolean): Float64Array {
  const INF = 1e20, n = Math.max(w, h);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = inside(i) ? 0 : INF;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {                         // columns
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {                         // rows
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x]);
  }
  return grid;
}

export interface AlphaSDF {
  /** Field size in texels (the image area + `pad` on every side). */
  width: number; height: number;
  /** Padding (texels) around the image inside the field. */
  pad: number;
  /** Image area size in field texels (width − 2·pad, height − 2·pad). */
  imageW: number; imageH: number;
  /** Encoded signed distance, 0..255: 128 = the shape's edge; > 128 outside; < 128 inside. See `maxDist`. */
  data: Uint8Array;
  /** Distance (texels) that maps to 0 / 255 (±maxDist) — decode: d = (v/255 − 0.5) · 2 · maxDist. */
  maxDist: number;
  /** False if the image had NO transparent pixel (fully opaque) — then the square hull outline is correct. */
  hasTransparency: boolean;
}

/**
 * Signed distance field of an alpha mask (row 0 = the image's top). Inside = alpha ≥ 0.5 (so soft anti-aliased
 * edges outline cleanly). `pad` texels of empty border are added on every side so a ring can extend past the image's
 * own edge even where the shape touches it. Pure.
 */
export function computeAlphaSDF(alpha: Uint8Array, w: number, h: number, pad: number, maxDist = pad): AlphaSDF {
  const W = w + 2 * pad, H = h + 2 * pad;
  const isIn = new Uint8Array(W * H);
  let transparent = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = alpha[y * w + x];
    if (a >= 128) isIn[(y + pad) * W + (x + pad)] = 1; else transparent = true;
  }
  const outside = edt2d(W, H, (i) => isIn[i] === 1);    // distance to the shape (0 on/inside)
  const inside  = edt2d(W, H, (i) => isIn[i] === 0);    // distance to the background (0 outside)
  const data = new Uint8Array(W * H), md = Math.max(1, maxDist);
  for (let i = 0; i < W * H; i++) {
    // Edge-centred signed distance: + outside, − inside (the half-texel keeps the edge between the two cells).
    const sd = isIn[i] ? -(inside[i] - 0.5) : (outside[i] - 0.5);
    data[i] = Math.max(0, Math.min(255, Math.round((0.5 + sd / (2 * md)) * 255)));
  }
  return { width: W, height: H, pad, imageW: w, imageH: h, data, maxDist: md, hasTransparency: transparent };
}

/** Decode an encoded SDF texel to a signed distance in texels (mirrors the WGSL decode). */
export function decodeSDF(v: number, maxDist: number): number { return (v / 255 - 0.5) * 2 * maxDist; }

// ── The gate + layer thresholds (pure) ───────────────────────────────────────────────────────────────────────────

/** What the gate reads off a mesh (a structural subset of Mesh3D, so it's testable without a GPU). */
export interface SpriteOutlineCandidate {
  meshPrimitive: string;
  diffuseTexture: { depthOrArrayLayers: number } | null;
  material: { hasTexture?: boolean; textureTiling?: readonly number[] | null; textureOffset?: readonly number[] | null };
}

/**
 * Which sprite-outline path a mesh's outline takes, or `null` = the regular (hull) outline, unchanged:
 * - only a SPRITE with a single-layer diffuse texture qualifies at all (everything else → null);
 * - `spriteShape: 'square'` (or the old `alphaShape: false`) → null: the hull's square outline IS that look;
 * - 'card' → 'card' (any texture mapping — it reads the image through the sprite's own UV transform);
 * - 'image' / unset → 'image', but only when the texture is mapped once (no tiling / offset — a sprite-sheet frame
 *   would read its neighbours' shapes). Whether the image actually HAS transparency is decided later by the field
 *   builder (an opaque image keeps the hull, which is already correct for it).
 */
export function spriteOutlineMode(m: SpriteOutlineCandidate, style: { spriteShape?: string; alphaShape?: boolean }): 'image' | 'card' | null {
  if (m.meshPrimitive !== 'sprite' || !m.material.hasTexture || !m.diffuseTexture) return null;
  if (m.diffuseTexture.depthOrArrayLayers !== 1) return null;
  const shape = style.spriteShape ?? (style.alphaShape === false ? 'square' : 'image');
  if (shape === 'square') return null;
  if (shape === 'card') return 'card';
  const t = m.material.textureTiling, o = m.material.textureOffset;
  if (t && ((t[0] ?? 1) !== 1 || (t[1] ?? 1) !== 1)) return null;
  if (o && ((o[0] ?? 0) !== 0 || (o[1] ?? 0) !== 0)) return null;
  return 'image';
}

/** Most layers one sprite outline draws (the main outline + up to 7 stacked rings — more are dropped). */
export const SPRITE_OUTLINE_MAX_LAYERS = 8;

/**
 * Each layer's OUTER distance from the shape's edge (model units), inner → outer, from the cumulative widths
 * `outlineLayers` already produces — clamped to `maxUnits` (the field's padding in model units: past it the stored
 * distance saturates, so a wider ring would fill out to the quad's square edge). Pure.
 */
export function spriteLayerOuterWidths(layerWidths: readonly number[], maxUnits: number): number[] {
  return layerWidths.slice(0, SPRITE_OUTLINE_MAX_LAYERS).map((w) => Math.max(0, Math.min(w, maxUnits)));
}

/** Which layer a point `d` model units OUTSIDE the shape falls in (index), or -1 (inside the shape or past the last
 *  ring → not drawn). Mirrors the shader's pick (without line boil). */
export function spriteLayerAt(d: number, outer: readonly number[]): number {
  if (d <= 0) return -1;
  for (let i = 0; i < outer.length; i++) if (d < outer[i]) return i;
  return -1;
}

// ── GPU side: per-texture builder + cache ────────────────────────────────────────────────────────────────────────

/** A built field on the GPU (or `null` = the texture is fully opaque → keep the square hull outline). */
export interface SpriteSDFTexture { tex: GPUTexture; view: GPUTextureView; info: Omit<AlphaSDF, 'data'> }

/** Longest side of the downsampled alpha the field is built from (icons need little; 256 is plenty). */
export const SPRITE_SDF_RES = 256;
/** Padding in field texels — the widest outline the field supports (all rings together): 64 of 256 = a quarter of
 *  the sprite's longer side. Wider rings are clamped to it (see spriteLayerOuterWidths). */
export const SPRITE_SDF_PAD = 64;

const ALPHA_BLIT_WGSL = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let xy = p[vi];
  return VsOut(vec4<f32>(xy, 0.0, 1.0), xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5));
}
@fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let a = textureSampleLevel(src, samp, uv, 0.0).a;
  return vec4<f32>(a, a, a, a);
}
`;

/**
 * Builds + caches alpha SDF textures per source GPUTexture. Async (a small GPU→CPU readback): until a texture's
 * field is ready, `get` returns undefined and the caller keeps the square hull outline for that frame.
 */
export class SpriteSDFCache {
  private readonly _ready = new WeakMap<GPUTexture, SpriteSDFTexture | null>();
  private readonly _pending = new WeakSet<GPUTexture>();
  private _blitPipe: PipelineHandle<GPURenderPipeline> | null = null;   // P2: non-blocking cache handle (awaited — _build is async)
  private _sampler: GPUSampler | null = null;
  /** Called when a field finishes building (so the host can schedule a redraw). */
  onReady: (() => void) | null = null;

  constructor(private readonly device: GPUDevice) {}

  /** The field for `src`: a texture, `null` (opaque — use the hull), or undefined (still building / just started). */
  get(src: GPUTexture): SpriteSDFTexture | null | undefined {
    if (this._ready.has(src)) return this._ready.get(src)!;
    if (!this._pending.has(src)) { this._pending.add(src); void this._build(src).catch(() => this._ready.set(src, null)); }
    return undefined;
  }

  private async _build(src: GPUTexture): Promise<void> {
    const d = this.device;
    if (src.depthOrArrayLayers !== 1 || src.dimension !== '2d') { this._ready.set(src, null); return; }
    const aspect = src.width / Math.max(1, src.height);
    const w = aspect >= 1 ? SPRITE_SDF_RES : Math.max(8, Math.round(SPRITE_SDF_RES * aspect));
    const h = aspect >= 1 ? Math.max(8, Math.round(SPRITE_SDF_RES / aspect)) : SPRITE_SDF_RES;
    this._blitPipe ??= GPUPipelineCache.for(d).render({
      label: 'SpriteAlphaBlit',
      layout: 'auto',
      vertex: { module: d.createShaderModule({ code: ALPHA_BLIT_WGSL }), entryPoint: 'vs' },
      fragment: { module: d.createShaderModule({ code: ALPHA_BLIT_WGSL }), entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    const blitPipe = await this._blitPipe.warm(PIPELINE_PRIORITY.NOW);
    if (!blitPipe) { this._ready.set(src, null); return; }
    this._sampler ??= d.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const target = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bpr = Math.ceil((w * 4) / 256) * 256;
    const buf = d.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setPipeline(blitPipe);
    pass.setBindGroup(0, d.createBindGroup({ layout: blitPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: src.createView() }, { binding: 1, resource: this._sampler },
    ] }));
    pass.draw(3);
    pass.end();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buf.getMappedRange());
    const alpha = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = px[y * bpr + x * 4 + 3];
    buf.unmap(); buf.destroy(); target.destroy();

    const sdf = computeAlphaSDF(alpha, w, h, SPRITE_SDF_PAD);
    if (!sdf.hasTransparency) { this._ready.set(src, null); this.onReady?.(); return; }
    const tex = d.createTexture({ size: [sdf.width, sdf.height], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: tex }, sdf.data, { bytesPerRow: sdf.width }, [sdf.width, sdf.height]);
    const { data: _drop, ...info } = sdf; void _drop;
    this._ready.set(src, { tex, view: tex.createView(), info });
    this.onReady?.();
  }
}
