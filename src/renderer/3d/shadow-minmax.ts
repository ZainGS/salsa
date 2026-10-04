/**
 * Shadow min/max tiles (docs/specs/performance-plan.md P6) — an exact shortcut for the 5x5 PCF.
 *
 * Every shadow-receiving fragment runs a 25-tap comparison PCF on the far map and, near the camera, on a cascade (50
 * taps inside the blend band). At street level that was ~30 % of the main-pass GPU time (6.5 of 21 ms at 2500x1390).
 * Most fragments are either fully lit or fully shadowed: every one of the taps returns the same answer.
 *
 * After a shadow map is written, two small compute passes build, per 8x8 tile of the map, the MIN and MAX stored depth
 * over that tile and its 8 neighbours (so any kernel whose footprint stays within 8 texels of its centre texel is
 * covered). The fragment shader reads one texel of that: if its reference depth is below the min, every comparison tap
 * passes ('less' sampler) and the PCF result is exactly 1; at or above the max, every tap fails and it is exactly 0.
 * Only the rest (shadow edges) run the full PCF. The output is bit-identical to the full PCF.
 *
 * Validity is tracked per map: a map written in a frame whose min/max rebuild could not run (pipeline still compiling)
 * turns the shortcut OFF for that map (uniform flag) until a rebuild lands — never a stale shortcut.
 */
import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle } from '../core/gpu-pipeline-cache';

/** Tile edge in shadow-map texels (the WGSL reads it from the params uniform; keep the two in sync via this). */
export const SHADOW_MM_TILE = 8;

/** Number of min/max tiles along an edge for a map of `size` texels. */
export function shadowMinMaxTiles(size: number): number { return Math.max(1, Math.ceil(size / SHADOW_MM_TILE)); }

/** Can the shortcut cover a kernel of `radius` taps each side, spaced `soft` texels? The bilinear footprint adds one
 *  texel and the centre-texel rounding another half. Mirrors the WGSL test. */
export function shadowKernelFitsTile(radius: number, soft: number): boolean { return radius * soft + 2.5 <= SHADOW_MM_TILE; }

export const SHADOW_MM_TILE_FAR_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_depth_2d;
@group(0) @binding(1) var dst: texture_storage_2d_array<rg32float, write>;
// One invocation per 8x8 tile (no shared memory, no barriers); edge tiles clamp to the last texel.
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let dims = textureDimensions(src);
  let nt = (dims + vec2<u32>(7u, 7u)) / 8u;
  if (g.x >= nt.x || g.y >= nt.y) { return; }
  let last = dims - vec2<u32>(1u, 1u);
  var mn = 3.0e38;
  var mx = -3.0e38;
  for (var y = 0u; y < 8u; y++) {
    for (var x = 0u; x < 8u; x++) {
      let d = textureLoad(src, vec2<i32>(min(g.xy * 8u + vec2<u32>(x, y), last)), 0);
      mn = min(mn, d);
      mx = max(mx, d);
    }
  }
  textureStore(dst, vec2<i32>(g.xy), 0, vec4<f32>(mn, mx, 0.0, 0.0));
}
`;

export const SHADOW_MM_TILE_CASC_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_depth_2d_array;
@group(0) @binding(1) var dst: texture_storage_2d_array<rg32float, write>;
// One invocation per 8x8 tile of layer g.z (see the far variant).
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let dims = textureDimensions(src);
  let nt = (dims + vec2<u32>(7u, 7u)) / 8u;
  if (g.x >= nt.x || g.y >= nt.y) { return; }
  let last = dims - vec2<u32>(1u, 1u);
  var mn = 3.0e38;
  var mx = -3.0e38;
  for (var y = 0u; y < 8u; y++) {
    for (var x = 0u; x < 8u; x++) {
      let d = textureLoad(src, vec2<i32>(min(g.xy * 8u + vec2<u32>(x, y), last)), i32(g.z), 0);
      mn = min(mn, d);
      mx = max(mx, d);
    }
  }
  textureStore(dst, vec2<i32>(g.xy), i32(g.z), vec4<f32>(mn, mx, 0.0, 0.0));
}
`;

export const SHADOW_MM_DILATE_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rg32float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let dims = vec2<i32>(textureDimensions(src));
  let c = vec2<i32>(g.xy);
  if (c.x >= dims.x || c.y >= dims.y) { return; }
  var mn = 3.0e38;
  var mx = -3.0e38;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = clamp(c + vec2<i32>(dx, dy), vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
      let v = textureLoad(src, q, i32(g.z), 0).xy;
      mn = min(mn, v.x);
      mx = max(mx, v.y);
    }
  }
  textureStore(dst, c, i32(g.z), vec4<f32>(mn, mx, 0.0, 0.0));
}
`;

/** The exported shader strings (wgsl-static-check scans these). */
export const SHADOW_MINMAX_SHADERS = { SHADOW_MM_TILE_FAR_WGSL, SHADOW_MM_TILE_CASC_WGSL, SHADOW_MM_DILATE_WGSL };

type MMTarget = { tile: GPUTexture; mm: GPUTexture; tileStore: GPUTextureView; tileRead: GPUTextureView; mmStore: GPUTextureView; size: number; layers: number;
  tileBG: WeakMap<GPUTextureView, GPUBindGroup>; dilBG: GPUBindGroup | null };

export class ShadowMinMax {
  /** The params uniform the fragment shader reads: x = far map valid, y = cascades valid, z = tile size. */
  readonly params: GPUBuffer;
  private readonly _p = new Float32Array([0, 0, SHADOW_MM_TILE, 0]);
  private _pDirty = true;
  private readonly _tileFar: PipelineHandle<GPUComputePipeline>;
  private readonly _tileCasc: PipelineHandle<GPUComputePipeline>;
  private readonly _dilate: PipelineHandle<GPUComputePipeline>;
  private _far: MMTarget | null = null;
  private _casc: MMTarget | null = null;
  /** Views the shadow bind group binds (2d far view, 2d-array cascade view). Recreated with the textures. */
  farView!: GPUTextureView;
  cascView!: GPUTextureView;
  /** Diagnostics. */
  readonly stats = { farBuilds: 0, cascBuilds: 0, skipped: 0 };

  constructor(private readonly device: GPUDevice) {
    this.params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ShadowMinMaxParams' });
    const cache = GPUPipelineCache.for(device);
    const mk = (code: string, name: string) => {
      let module: GPUShaderModule | null = null;
      const h = cache.compute(() => ({ layout: 'auto', compute: { module: module ??= device.createShaderModule({ code, label: name }), entryPoint: 'main' }, label: name }), name, 'shadow-minmax:' + name);
      void h.warm(PIPELINE_PRIORITY.DOCUMENT);
      return h;
    };
    this._tileFar = mk(SHADOW_MM_TILE_FAR_WGSL, 'ShadowMMTileFar');
    this._tileCasc = mk(SHADOW_MM_TILE_CASC_WGSL, 'ShadowMMTileCasc');
    this._dilate = mk(SHADOW_MM_DILATE_WGSL, 'ShadowMMDilate');
    this.ensure(1, 1, 1);
  }

  private _target(size: number, layers: number, label: string): MMTarget {
    const n = shadowMinMaxTiles(size);
    const desc = (l: string): GPUTextureDescriptor => ({ size: [n, n, layers], format: 'rg32float', label: l, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const tile = this.device.createTexture(desc(label + 'Tile')), mm = this.device.createTexture(desc(label));
    return { tile, mm, size, layers, tileStore: tile.createView({ dimension: '2d-array' }), tileRead: tile.createView({ dimension: '2d-array' }), mmStore: mm.createView({ dimension: '2d-array' }), tileBG: new WeakMap(), dilBG: null };
  }

  /** (Re)size for a far map of `farSize` and `layers` cascades of `cascSize`. Returns true when the views changed
   *  (the caller rebuilds its bind group). Both maps start INVALID (shortcut off) until their first rebuild. */
  ensure(farSize: number, cascSize: number, layers: number): boolean {
    let changed = false;
    if (!this._far || this._far.size !== farSize) {
      this._far?.tile.destroy(); this._far?.mm.destroy();
      this._far = this._target(farSize, 1, 'ShadowMMFar');
      this.farView = this._far.mm.createView({ dimension: '2d' });
      this.setValid('far', false); changed = true;
    }
    if (!this._casc || this._casc.size !== cascSize || this._casc.layers !== layers) {
      this._casc?.tile.destroy(); this._casc?.mm.destroy();
      this._casc = this._target(cascSize, layers, 'ShadowMMCasc');
      this.cascView = this._casc.mm.createView({ dimension: '2d-array' });
      this.setValid('casc', false); changed = true;
    }
    return changed;
  }

  setValid(which: 'far' | 'casc', on: boolean): void {
    const i = which === 'far' ? 0 : 1, v = on ? 1 : 0;
    if (this._p[i] !== v) { this._p[i] = v; this._pDirty = true; }
  }

  /** Upload the params when they changed (call once per frame before the frame's submit). */
  flush(): void {
    if (!this._pDirty) return;
    this._pDirty = false;
    this.device.queue.writeBuffer(this.params, 0, this._p);
  }

  /** Record the rebuild for one map after it was written this frame. On success the map's shortcut turns on; when a
   *  pipeline is still compiling it turns OFF (never stale). `depthView` = the depth texture as a 2d (far) or 2d-array
   *  (cascades) view. */
  record(enc: GPUCommandEncoder, which: 'far' | 'casc', depthView: GPUTextureView, layers = 1): boolean {
    const t = which === 'far' ? this._far : this._casc;
    const tilePipe = (which === 'far' ? this._tileFar : this._tileCasc).get(), dil = this._dilate.get();
    if (!t || !tilePipe || !dil || layers > t.layers) { this.setValid(which, false); this.stats.skipped++; return false; }
    const n = shadowMinMaxTiles(t.size);
    const pass = enc.beginComputePass({ label: 'ShadowMinMax.' + which });
    pass.setPipeline(tilePipe);
    let tbg = t.tileBG.get(depthView);
    if (!tbg) { tbg = this.device.createBindGroup({ layout: tilePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: depthView }, { binding: 1, resource: t.tileStore }] }); t.tileBG.set(depthView, tbg); }
    pass.setBindGroup(0, tbg);
    pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), layers);
    pass.setPipeline(dil);
    pass.setBindGroup(0, t.dilBG ??= this.device.createBindGroup({ layout: dil.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.tileRead }, { binding: 1, resource: t.mmStore }] }));
    pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), layers);
    pass.end();
    this.setValid(which, true);
    if (which === 'far') this.stats.farBuilds++; else this.stats.cascBuilds++;
    return true;
  }

  destroy(): void {
    this._far?.tile.destroy(); this._far?.mm.destroy(); this._casc?.tile.destroy(); this._casc?.mm.destroy();
    this._far = null; this._casc = null;
    this.params.destroy();
  }
}
