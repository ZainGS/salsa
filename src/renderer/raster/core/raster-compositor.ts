/**
 * RasterCompositor — GPU compute shader that flattens multiple raster layers
 * into a single output texture, respecting per-layer blend modes, opacity,
 * and clipping masks.
 *
 * Architecture:
 *   For each layer (back-to-front), dispatch a compute pass that reads the
 *   layer texture + the accumulated result so far, blends them according to
 *   the layer's blend mode and opacity, and writes the result back.
 *
 * Supports:
 *   12 blend modes (Normal, Multiply, Screen, Overlay, Soft Light, Hard Light,
 *   Color Dodge, Color Burn, Darken, Lighten, Add/Glow, Difference)
 *   Per-layer opacity (0-1)
 *   Clipping masks (clip to alpha of layer below)
 *   Visibility toggle (skip invisible layers)
 *   Global canvas grain overlay (paper texture applied to final output)
 */

import { CanvasGrainManager } from '../canvas-grain';
import { DitherEngine, DitherConfig, defaultDitherConfig } from '../effects/dither-engine';
import type { FrameLinkAnimation } from '../../../animation';
import { OnionSkinRenderer, type OnionFrame } from '../../../animation/onion-skin-renderer';
import { RasterDirtyCursor, type DirtyTexelRect } from './raster-composite-dirty';
import { LayerDitherCache, ditherConfigKey, unionDitherRect } from './layer-dither-cache';
import { rasterTextureVersion } from '../raster-content-version';
import { isRasterStrokeActive, onRasterStrokeEnd } from '../raster-stroke-activity';

/** What one compositeIncremental call did. */
export type IncrementalCompositeResult = 'skip' | 'rect' | 'full';

/** Per-target state of the incremental composite (BRUSH-5). */
interface IncrementalSlot {
  /** This target's position in the dirty-rect log. */
  cursor: RasterDirtyCursor;
  /** Signature of the inputs the persistent output was last composited from by the REGION passes; null = the
   *  output is not one of those (never composited / composited by the legacy path / post-processed in place) →
   *  the next incremental composite is a full one. */
  sig: string | null;
}

/** Blend mode enum — matches the uniform values in the shader. */
export enum LayerBlendMode {
  Normal     = 0,
  Multiply   = 1,
  Screen     = 2,
  Overlay    = 3,
  SoftLight  = 4,
  HardLight  = 5,
  ColorDodge = 6,
  ColorBurn  = 7,
  Darken     = 8,
  Lighten    = 9,
  Add        = 10,
  Difference = 11,
}

/** Per-layer metadata passed to the compositor. */
export interface CompositorLayerInfo {
  texture: GPUTexture;
  blendMode: LayerBlendMode;
  opacity: number;       // 0-1
  clipped: boolean;      // true → clip to alpha of layer below
  visible: boolean;
  /** Optional per-layer dither config. When set and enabled, the layer is dithered before compositing — from its
   *  own cached dithered copy (layer-dither-cache.ts), redone only when the layer's pixels or the config change. */
  ditherConfig?: DitherConfig;
  /** Stable id of the layer for its dither cache (the renderer passes the layer id). Without one the cache is keyed
   *  by the texture object (a new texture = a new cache entry; idle ones are freed after a while). */
  cacheKey?: string;
  /** Optional per-layer procedural displacement animation. */
  frameLinkAnimation?: FrameLinkAnimation;
}

/** Frame Link displacement type → the shader's dispType (0 = none). A module constant: it was a fresh object literal
 *  per layer per composite. */
const FRAME_LINK_TYPE_ID: Readonly<Record<string, number>> = {
  'wave': 1, 'shake': 2, 'ripple': 3, 'noise': 4, 'turbulence': 5,
};

export class RasterCompositor {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;

  // Uniform buffer for per-layer params:
  //   vec4[0] = [blendMode, opacity, clipped, pad]
  //   vec4[1] = [dispType, dispAmplitude, dispFrequency, dispSpeed]
  //   vec4[2] = [dispDirection, dispPhase, currentFrame, dispFlags]
  //   vec4[3] = [rippleCenterX, rippleCenterY, noiseOctaves, noiseLacunarity]
  //   vec4[4] = [noisePersistence, shakeSeed, texW, texH]
  private paramsBuf: GPUBuffer;
  // Pre-allocated typed array (avoids GC per-frame): 5 vec4 = 20 floats
  private paramsData = new Float32Array(20);
  // E5: per-layer blend step used to rebuild a bind group (3 createView) + 2 submits PER LAYER PER FRAME
  // while painting. Cache {param buffer + bind group} per layer texture (WeakMap - entries die with the
  // texture), keyed valid while (ping, layerTex, output) identities are unchanged. Each layer gets its OWN
  // uniform buffer so a single-submit frame can't race the shared one (queue writes land before submits).
  private _layerStepCache = new WeakMap<GPUTexture, { buf: GPUBuffer; bg: GPUBindGroup; ping: GPUTexture; out: GPUTexture }>();

  /** Current animation frame (1-indexed). Set before each composite call. */
  public currentFrame: number = 1;

  // Persistent ping texture for accumulated result readback
  private pingTex: GPUTexture | null = null;
  private pingTexW = 0;
  private pingTexH = 0;

  // Base-layer opacity compute pass (lazy-built)
  private _baseOpacityPipeline: GPUComputePipeline | null = null;
  private _baseOpacityBGL: GPUBindGroupLayout | null = null;
  private _baseOpacityBuf: GPUBuffer | null = null;
  // BRUSH-5: the read copy for the base-opacity pass — was a full-size texture created AND destroyed every frame.
  private _baseOpacityTmp: GPUTexture | null = null;
  private _baseOpacityTmpW = 0;
  private _baseOpacityTmpH = 0;

  // ── Incremental composite (BRUSH-5) — see compositeIncremental. Its own (lazily built) pipelines: the legacy
  // composite() / compositeAsync() passes above and below are not touched by it. ──
  private _slots = new Map<string, IncrementalSlot>();
  private _texIds = new WeakMap<GPUTexture, number>();
  private _nextTexId = 1;
  private _blendCode = '';
  private _regionBroken = false;
  private _regionBlendPipeline: GPUComputePipeline | null = null;
  private _regionBlendBGL: GPUBindGroupLayout | null = null;
  private _regionParams = new Float32Array(24);   // the 5 blend/displacement vec4 + [x0, y0, x1, y1]
  private _regionStepCache = new WeakMap<GPUTexture, { buf: GPUBuffer; bg: GPUBindGroup; ping: GPUTexture; out: GPUTexture }>();
  private _regionOpacityPipeline: GPUComputePipeline | null = null;
  private _regionOpacityBGL: GPUBindGroupLayout | null = null;
  private _regionOpacityBuf: GPUBuffer | null = null;
  private _regionOpacityData = new Float32Array(8);   // [opacity,0,0,0], [x0,y0,x1,y1]
  private _regionOpacityBG: { bg: GPUBindGroup; ping: GPUTexture; out: GPUTexture } | null = null;
  private _regionGrainPipeline: GPUComputePipeline | null = null;
  private _regionGrainBGL: GPUBindGroupLayout | null = null;
  private _regionGrainBuf: GPUBuffer | null = null;
  private _regionGrainSampler: GPUSampler | null = null;
  private _regionGrainData = new Float32Array(8);     // [invScaleX, invScaleY, strength, 0], [x0,y0,x1,y1]
  private _regionGrainBG: { bg: GPUBindGroup; ping: GPUTexture; grain: GPUTexture; out: GPUTexture } | null = null;
  /** Work counters (diagnostics / tests): composites by kind, and the texels of every texture copy / compute
   *  dispatch region the compositor recorded (legacy and incremental paths; dither engine + onion skin excluded).
   *  `bytes`: the texture memory those touch — 4 B per texel read or written (a copy = 8 B/texel, a blend step
   *  = 12 B/texel, base opacity / grain = 8 B/texel). */
  public readonly stats = {
    full: 0, rect: 0, skip: 0, submits: 0, copies: 0, dispatches: 0, copyTexels: 0, dispatchTexels: 0, bytes: 0,
  };
  private noteCopy(texels: number): void { this.stats.copies++; this.stats.copyTexels += texels; this.stats.bytes += texels * 8; }
  /** `reads`: full-size textures the pass reads per texel (it writes one). */
  private noteDispatch(texels: number, reads: number): void {
    this.stats.dispatches++; this.stats.dispatchTexels += texels; this.stats.bytes += texels * 4 * (reads + 1);
  }

  // Global canvas grain overlay
  private _grainManager: CanvasGrainManager | null = null;
  private _grainOverlayPipeline: GPUComputePipeline | null = null;
  private _grainOverlayBGL: GPUBindGroupLayout | null = null;
  private _grainOverlayParamBuf: GPUBuffer | null = null;
  private _grainOverlaySampler: GPUSampler | null = null;
  private _grainOverlayPingTex: GPUTexture | null = null;
  private _grainOverlayPingW = 0;
  private _grainOverlayPingH = 0;

  // Non-destructive dithering post-process
  private _ditherEngine: DitherEngine;
  private _ditherConfig: DitherConfig = defaultDitherConfig();

  // Per-layer dither: each dithered layer's own cached result (non-destructive: the layer texture is never modified)
  private _ditherCache: LayerDitherCache;
  /** Asked for a frame when work finished OUTSIDE a composite needs one (an error-diffusion result landed, a deferred
   *  global error diffusion can run now that the stroke ended). The renderer sets it to its scheduleRender. */
  public requestRender: (() => void) | null = null;
  // Global dither: the finished composite (layers + global dither + grain) per output, reused while nothing it
  // depends on changed (a pan / zoom / vector edit re-renders without touching a raster layer).
  private _globalResults = new WeakMap<GPUTexture, { tex: GPUTexture; sig: string }>();
  private _globalEDDeferred = false;
  private _unsubStrokeEnd: () => void;

  // Onion skin rendering
  private _onionRenderer: OnionSkinRenderer;
  // Ping texture for onion skin read-back (can't read+write same storage texture)
  private _onionPingTex: GPUTexture | null = null;
  private _onionPingW = 0;
  private _onionPingH = 0;

  constructor(device: GPUDevice) {
    this.device = device;

    this.paramsBuf = device.createBuffer({
      size: 80, // 20 floats = 5 vec4: blend params + displacement params
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._ditherEngine = new DitherEngine(device);
    this._ditherCache = new LayerDitherCache(device, this._ditherEngine, () => {
      this.invalidateIncremental();   // a cache texture changed outside a composite: the next one is a full one
      this.requestRender?.();
    });
    this._onionRenderer = new OnionSkinRenderer(device);
    const self = new WeakRef(this);
    const unsub = onRasterStrokeEnd(() => {
      const c = self.deref();
      if (!c) { unsub(); return; }
      if (c._globalEDDeferred) { c._globalEDDeferred = false; c.requestRender?.(); }
    });
    this._unsubStrokeEnd = unsub;

    this.buildPipeline();
  }

  // ── Dither configuration ─────────────────────────────────────────

  /** Set the complete dither configuration. */
  public setDitherConfig(config: DitherConfig): void {
    this._ditherConfig = { ...config };
  }

  /** Get the current dither configuration (copy). */
  public getDitherConfig(): DitherConfig {
    return { ...this._ditherConfig };
  }

  /** Enable or disable dithering. */
  public setDitherEnabled(enabled: boolean): void {
    this._ditherConfig.enabled = enabled;
  }

  /** The per-layer dither cache's work counters (diagnostics / tests). */
  public get ditherCacheStats(): LayerDitherCache['stats'] { return this._ditherCache.stats; }
  /** The dither engine's work counters (diagnostics / tests). */
  public get ditherEngineStats(): DitherEngine['stats'] { return this._ditherEngine.stats; }
  /** Live per-layer dither cache entries. */
  public get ditherCacheSize(): number { return this._ditherCache.size; }
  /** The error-diffusion debounce (ms) for non-stroke changes. */
  public set ditherDebounceMs(ms: number) { this._ditherCache.debounceMs = Math.max(0, ms); }

  /** Free the dither caches of layers no longer in the document (ids = every raster layer id still listed). */
  public retainLayerDitherCaches(ids: ReadonlySet<string>): void { this._ditherCache.retainOnly(ids); }
  /** Free every per-layer dither cache (a document load; they rebuild on the next composite). */
  public clearDitherCaches(): void { this._ditherCache.clear(); this._globalResults = new WeakMap(); }

  /**
   * BAKE: write `layer`'s dithered pixels into `dst` (normally the layer texture itself) and free its cache. The
   * caller owns the undo snapshots, the dirty report and turning the layer's dither off. False when the layer has no
   * active dither or an error-diffusion pass could not run.
   */
  public bakeLayerDither(layer: CompositorLayerInfo, dst: GPUTexture): Promise<boolean> {
    return this._ditherCache.bakeInto(layer, dst);
  }

  /** The layers with each active per-layer dither swapped for its (brought up to date) cached texture, and the union
   *  of the cache texels that changed doing so (the incremental composite re-composites them). */
  private _resolveDithers(layers: CompositorLayerInfo[]): { layers: CompositorLayerInfo[]; changed: DirtyTexelRect | 'full' | null } {
    let changed: DirtyTexelRect | 'full' | null = null;
    let out: CompositorLayerInfo[] | null = null;
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (!l.ditherConfig) continue;
      if (!l.visible || !l.texture) continue;   // hidden: neither dithered nor freed (showing it again is free)
      const r = this._ditherCache.resolve(l);
      changed = unionDitherRect(changed, r.changed);
      out ??= layers.slice();
      out[i] = r.texture === l.texture ? { ...l, ditherConfig: undefined } : { ...l, texture: r.texture, ditherConfig: undefined };
    }
    return { layers: out ?? layers, changed };
  }

  /**
   * Set the global canvas grain manager. When set, the grain texture is applied
   * as a final overlay on the composited output — like real paper showing through paint.
   */
  public setGrainManager(manager: CanvasGrainManager | null): void {
    this._grainManager = manager;
  }

  // ── Onion skin overlay ──────────────────────────────────────────

  /**
   * Overlay onion skin ghost frames onto the composited output.
   * Call this AFTER composite() but BEFORE applyGrainOverlay().
   *
   * `onionFrames` is an ordered array of ghost frames (e.g. previous frames in red,
   * next frames in blue), each with a texture, opacity, and tint.
   * The output texture is modified in-place.
   */
  public applyOnionSkin(
    outputTexture: GPUTexture,
    onionFrames: OnionFrame[],
  ): void {
    if (onionFrames.length === 0) return;
    const w = outputTexture.width;
    const h = outputTexture.height;

    // Ensure ping texture for read-back
    if (!this._onionPingTex || this._onionPingW !== w || this._onionPingH !== h) {
      this._onionPingTex?.destroy();
      this._onionPingTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this._onionPingW = w;
      this._onionPingH = h;
    }

    for (const frame of onionFrames) {
      if (!frame.texture || frame.opacity <= 0) continue;

      // Copy current output → ping (read source)
      const cpEnc = this.device.createCommandEncoder();
      cpEnc.copyTextureToTexture(
        { texture: outputTexture },
        { texture: this._onionPingTex! },
        { width: w, height: h },
      );
      this.device.queue.submit([cpEnc.finish()]);

      // Composite the onion frame onto outputTexture
      this._onionRenderer.composite(
        this._onionPingTex!,
        outputTexture,
        frame.texture,
        frame.opacity,
        frame.tint,
      );
    }
  }

  // ── Displacement uniform writer ──

  /** Encode displacement animation params into the pre-allocated paramsData array at index 4..19. */
  private writeDisplacementParams(layer: CompositorLayerInfo, w: number, h: number): void {
    const pd = this.paramsData;
    const anim = layer.frameLinkAnimation;
    if (!anim || !anim.enabled) {
      // Type 0 = none, amplitude 0 → computeDisplacement returns (0,0)
      pd[4] = 0; pd[5] = 0; pd[6] = 0; pd[7] = 0;
      pd[8] = 0; pd[9] = 0; pd[10] = this.currentFrame; pd[11] = 0;
      pd[12] = 0; pd[13] = 0; pd[14] = 0; pd[15] = 0;
      pd[16] = 0; pd[17] = 0; pd[18] = w; pd[19] = h;
      return;
    }

    const dirRad = (anim.direction ?? 0) * Math.PI / 180;
    const flags = (anim.displaceX !== false ? 1 : 0) | (anim.displaceY ? 2 : 0);

    // vec4[1]: dispType, amplitude, frequency, speed
    pd[4]  = FRAME_LINK_TYPE_ID[anim.type] ?? 0;
    pd[5]  = anim.amplitude ?? 0;
    pd[6]  = anim.frequency ?? 3;
    pd[7]  = anim.speed ?? 0.15;
    // vec4[2]: direction(rad), phase, currentFrame, flags
    pd[8]  = dirRad;
    pd[9]  = anim.phase ?? 0;
    pd[10] = this.currentFrame;
    pd[11] = flags;
    // vec4[3]: rippleCenterX, rippleCenterY, noiseOctaves, noiseLacunarity
    pd[12] = anim.rippleCenterX ?? 0.5;
    pd[13] = anim.rippleCenterY ?? 0.5;
    pd[14] = anim.noiseOctaves ?? 2;
    pd[15] = anim.noiseLacunarity ?? 2.0;
    // vec4[4]: noisePersistence, shakeSeed, texW, texH
    pd[16] = anim.noisePersistence ?? 0.5;
    pd[17] = anim.shakeSeed ?? 0;
    pd[18] = w;
    pd[19] = h;
  }

  /**
   * Does this frame require the async composite path? A GLOBAL error-diffusion dither
   * needs a GPU→CPU→WASM round-trip that the sync
   * `composite()` cannot do — it silently drops error-diffusion dither. Callers
   * MUST route through `compositeAsync()` when this returns true. Single source of
   * truth so the two hot callers can't drift out of sync (audit A4).
   */
  public static needsAsyncComposite(_layers: CompositorLayerInfo[], globalCfg: DitherConfig): boolean {
    // Per-layer error diffusion no longer needs it: the layer dither cache runs that pass in the background and the
    // sync composite samples its result (2026-10-08).
    return globalCfg.enabled && globalCfg.strength > 0.001 && DitherEngine.isErrorDiffusion(globalCfg.algorithm);
  }

  /**
   * Composite all layers (back-to-front) into `outputTexture`.
   * `outputTexture` must be rgba8unorm with STORAGE_BINDING + TEXTURE_BINDING + COPY_DST usage.
   *
   * The first visible layer is copied directly; subsequent layers are blended on top.
   * After all layers are composited, a global canvas grain overlay is applied (if enabled).
   * Per-layer dithers (ordered AND error diffusion) come from the layer dither cache.
   *
   * SYNC PATH: cannot apply a GLOBAL error-diffusion dither — call `needsAsyncComposite()` first and
   * route to `compositeAsync()` when it returns true, else the global dither is skipped.
   */
  public composite(layers: CompositorLayerInfo[], outputTexture: GPUTexture): void {
    const w = outputTexture.width;
    const h = outputTexture.height;
    if (w === 0 || h === 0) return;
    const resolved = this._resolveDithers(layers).layers;
    const g = this._ditherConfig;
    const sig = DitherEngine.isActiveOrdered(g) ? this.globalResultSignature(resolved, outputTexture) : null;
    if (sig !== null && this.restoreGlobalResult(outputTexture, sig)) return;
    if (!this._compositeStack(resolved, outputTexture)) return;   // (no visible layer: cleared + paper, no dither)
    // ── Global non-destructive dither post-process ──
    this._ditherEngine.apply(outputTexture, g);
    // ── Global canvas grain overlay pass ──
    this.applyGrainOverlay(outputTexture, w, h);
    if (sig !== null) this.storeGlobalResult(outputTexture, sig);
  }

  /**
   * Async variant of composite() that supports a GLOBAL error diffusion dither
   * (per-layer error diffusion is the layer dither cache's — composite() serves it too).
   *
   * Call this instead of composite() when the global config uses an error diffusion
   * algorithm (floyd_steinberg, atkinson, etc. — see needsAsyncComposite). While a brush
   * stroke is in progress the global pass is deferred (the frame shows the composite
   * without it) and runs once on the first composite after the stroke ends; a composite
   * whose inputs did not change since the last one reuses that result.
   */
  public async compositeAsync(layers: CompositorLayerInfo[], outputTexture: GPUTexture): Promise<void> {
    const w = outputTexture.width;
    const h = outputTexture.height;
    if (w === 0 || h === 0) return;
    const resolved = this._resolveDithers(layers).layers;
    const g = { ...this._ditherConfig };
    const globalOn = g.enabled && g.strength > 0.001;
    const ed = globalOn && DitherEngine.isErrorDiffusion(g.algorithm);
    const deferED = ed && isRasterStrokeActive();
    const sig = globalOn && !deferED ? this.globalResultSignature(resolved, outputTexture) : null;
    if (sig !== null && this.restoreGlobalResult(outputTexture, sig)) return;
    if (!this._compositeStack(resolved, outputTexture)) return;
    // ── Global non-destructive dither post-process (async) ──
    if (deferED) this._globalEDDeferred = true;   // (the stroke-end listener asks for the frame that runs it)
    else await this._ditherEngine.applyAsync(outputTexture, g);
    // ── Global canvas grain overlay pass ──
    this.applyGrainOverlay(outputTexture, w, h);
    if (sig !== null) this.storeGlobalResult(outputTexture, sig);
  }

  /** The layer stack (base copy + opacity + blend steps) of composite() / compositeAsync(), dithers already resolved.
   *  False when no layer is visible: the output was cleared and given the paper grain (the caller is done). */
  private _compositeStack(layers: CompositorLayerInfo[], outputTexture: GPUTexture): boolean {
    const w = outputTexture.width;
    const h = outputTexture.height;
    const visibleLayers = layers.filter(l => l.visible && l.texture);
    if (visibleLayers.length === 0) {
      this.clearTexture(outputTexture);
      // Still apply grain — the blank canvas IS the paper
      this.applyGrainOverlay(outputTexture, w, h);
      return false;
    }

    // Copy first visible layer → output (no blending needed for the base)
    const first = visibleLayers[0];
    const firstTex = first.texture;
    const copyEnc = this.device.createCommandEncoder();
    copyEnc.copyTextureToTexture(
      { texture: firstTex },
      { texture: outputTexture },
      { width: Math.min(firstTex.width, w), height: Math.min(firstTex.height, h) },
    );
    this.device.queue.submit([copyEnc.finish()]);
    this.noteCopy(Math.min(firstTex.width, w) * Math.min(firstTex.height, h));
    this.stats.submits++;

    if (first.opacity < 1.0) {
      this.applyBaseOpacity(outputTexture, first.opacity, w, h);
    }
    if (visibleLayers.length <= 1) return true;

    // Ensure persistent ping texture matches output dimensions
    this.ensurePing(w, h);
    for (let i = 1; i < visibleLayers.length; i++) {
      const layer = visibleLayers[i];
      this._compositeLayerStep(layer, layer.texture, outputTexture, w, h);
    }
    return true;
  }

  /** Everything a GLOBAL-dither composite of `out` depends on, layer pixels included (their content versions —
   *  every pixel writer reports to raster-content-version.ts — and the dither caches' write counts). */
  private globalResultSignature(layers: CompositorLayerInfo[], out: GPUTexture): string {
    let sig = this.texId(out) + ':' + out.width + 'x' + out.height + '|' + ditherConfigKey(this._ditherConfig);
    let frameLink = false;
    for (const l of layers) {
      if (!l.visible || !l.texture) continue;
      const t = l.texture;
      const ver = this._ditherCache.versionOf(t) ?? rasterTextureVersion(t);
      sig += '|' + this.texId(t) + ',' + ver + ',' + t.width + ',' + t.height + ',' + l.blendMode + ',' + l.opacity + ',' + (l.clipped ? 1 : 0);
      const a = l.frameLinkAnimation;
      if (a && a.enabled) {
        frameLink = true;
        sig += ',fl' + a.type + ',' + a.amplitude + ',' + a.frequency + ',' + a.speed + ',' + a.direction + ',' + a.phase +
          ',' + (a.displaceX !== false ? 1 : 0) + (a.displaceY ? 1 : 0) + ',' + a.rippleCenterX + ',' + a.rippleCenterY +
          ',' + a.noiseOctaves + ',' + a.noiseLacunarity + ',' + a.noisePersistence + ',' + a.shakeSeed;
      }
    }
    if (frameLink) sig += '|f' + this.currentFrame;
    // 'noise' re-rolls its pattern on every pass: a reused result is still one of its frames (the same as an idle one).
    const gm = this._grainManager;
    const grainTex = gm ? gm.getGrainTexture() : null;
    if (gm && grainTex && gm.getGrainStrength() > 0.001) {
      const inv = gm.getGrainInvScale();
      sig += '|g' + this.texId(grainTex) + ',' + gm.getGrainStrength() + ',' + inv[0] + ',' + inv[1];
    }
    return sig;
  }

  /** Reuse the stored global-dither result of `out` when `sig` matches (one copy instead of the whole composite). */
  private restoreGlobalResult(out: GPUTexture, sig: string): boolean {
    const r = this._globalResults.get(out);
    if (!r || r.sig !== sig || r.tex.width !== out.width || r.tex.height !== out.height) return false;
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: r.tex }, { texture: out }, { width: out.width, height: out.height });
    this.device.queue.submit([enc.finish()]);
    this.noteCopy(out.width * out.height);
    this.stats.submits++;
    return true;
  }

  private storeGlobalResult(out: GPUTexture, sig: string): void {
    let r = this._globalResults.get(out);
    if (!r || r.tex.width !== out.width || r.tex.height !== out.height) {
      r?.tex.destroy();
      r = {
        tex: this.device.createTexture({
          size: [out.width, out.height], format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        }),
        sig: '',
      };
      this._globalResults.set(out, r);
    }
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: out }, { texture: r.tex }, { width: out.width, height: out.height });
    this.device.queue.submit([enc.finish()]);
    this.noteCopy(out.width * out.height);
    this.stats.submits++;
    r.sig = sig;
  }

  /** One blend step (E5): copy output→ping + blend layerTex over it back into output, in ONE submit,
   *  with cached per-layer uniforms + bind group. Params are written to the LAYER'S OWN buffer. */
  private _compositeLayerStep(
    layer: CompositorLayerInfo,
    layerTex: GPUTexture,
    outputTexture: GPUTexture,
    w: number,
    h: number,
  ): void {
    const pd = this.paramsData;
    pd[0] = layer.blendMode; pd[1] = layer.opacity; pd[2] = layer.clipped ? 1.0 : 0.0; pd[3] = 0;
    this.writeDisplacementParams(layer, w, h);

    let entry = this._layerStepCache.get(layerTex);
    if (!entry || entry.ping !== this.pingTex || entry.out !== outputTexture) {
      const buf = entry?.buf ?? this.device.createBuffer({
        size: this.paramsData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      entry = {
        buf,
        bg: this.device.createBindGroup({
          layout: this.bindGroupLayout,
          entries: [
            { binding: 0, resource: this.pingTex!.createView() },
            { binding: 1, resource: layerTex.createView() },
            { binding: 2, resource: outputTexture.createView() },
            { binding: 3, resource: { buffer: buf } },
          ],
        }),
        ping: this.pingTex!,
        out: outputTexture,
      };
      this._layerStepCache.set(layerTex, entry);
    }
    this.device.queue.writeBuffer(entry.buf, 0, pd);

    const layerW = Math.min(layerTex.width, w);
    const layerH = Math.min(layerTex.height, h);
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: outputTexture },
      { texture: this.pingTex! },
      { width: w, height: h },
    );
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, entry.bg);
    const wgSize = 8;
    pass.dispatchWorkgroups(Math.ceil(layerW / wgSize), Math.ceil(layerH / wgSize));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.noteCopy(w * h);
    this.noteDispatch(layerW * layerH, 2);
    this.stats.submits++;
  }

  // ── Incremental composite (BRUSH-5) ─────────────────────────────

  /**
   * composite() into a PERSISTENT `outputTexture`, doing only the work that changed since the last call for
   * `slotKey` (one key per output: the renderer uses 'main' and 'fg'):
   *  - inputs unchanged and nothing reported dirty → no GPU work at all ('skip');
   *  - layer pixels reported dirty (raster-composite-dirty.ts) → the composite passes bounded to the union rect
   *    ('rect'): the base copy, base opacity, every blend step and the paper grain. Each is a function of the same
   *    texel of its inputs (the grain is sampled at absolute canvas coordinates), so the result is pixel-identical
   *    to compositing everything;
   *  - anything else → everything ('full'): the first call, a change to the layer list (texture identity, order,
   *    visibility, opacity, blend mode, clipping, sizes), to the output texture or the grain, and a whole-canvas
   *    dirty report.
   * Per-layer dithers composite from their cached textures (layer-dither-cache.ts); the cache texels a call
   * re-dithers join the dirty rect. While a GLOBAL dither or a displacement animation is active — they read other
   * texels / the frame number — every call is a legacy composite() ('full'); with a Frame Link displacement as the only obstacle,
   * that composite is skipped while the frame number, the displacement params and the inputs above are unchanged and
   * nothing was reported dirty ('skip').
   *
   * The rect and the full passes here are the SAME region pipelines (a full pass is the rect [0,w)×[0,h)), built
   * on first use; composite() / compositeAsync() keep their own, untouched. A caller that composites this output
   * any other way (compositeAsync, composite(), an in-place post-process such as the onion skin) must call
   * invalidateIncremental(slotKey), which makes the next call here a full one. Sync only.
   */
  public compositeIncremental(
    layers: CompositorLayerInfo[],
    outputTexture: GPUTexture,
    slotKey: string,
  ): IncrementalCompositeResult {
    const w = outputTexture.width, h = outputTexture.height;
    if (w === 0 || h === 0) return 'skip';
    let slot = this._slots.get(slotKey);
    if (!slot) { slot = { cursor: new RasterDirtyCursor(), sig: null }; this._slots.set(slotKey, slot); }
    const resolved = this._resolveDithers(layers);
    layers = resolved.layers;
    // always consumed: whatever we do below covers it (plus the dither-cache texels re-dithered just now)
    const dirty = unionDitherRect(slot.cursor.take(), resolved.changed);
    const sig = this._regionBroken ? null : this.incrementalSignature(layers, outputTexture);
    if (sig === null) {
      // A Frame Link displacement (and nothing else) rules the region passes out: the legacy full composite runs, but
      // only when its inputs moved — the frame number, the displacement params, the layer list, or reported pixels.
      // Renders between two frame changes then reuse the output (it is exactly what composite() wrote last time).
      const flSig = this.incrementalSignature(layers, outputTexture, true);
      if (flSig !== null && flSig === slot.sig && !dirty) { this.stats.skip++; return 'skip'; }
      slot.sig = null;
      this.stats.full++;
      this.composite(layers, outputTexture);
      slot.sig = flSig;
      return 'full';
    }
    try {
      if (sig !== slot.sig || dirty === 'full') {
        slot.sig = null;
        this._compositeRegion(layers, outputTexture, { x0: 0, y0: 0, x1: w, y1: h });
        slot.sig = sig;
        this.stats.full++;
        return 'full';
      }
      if (!dirty) { this.stats.skip++; return 'skip'; }
      const R = { x0: Math.max(0, dirty.x0), y0: Math.max(0, dirty.y0), x1: Math.min(w, dirty.x1), y1: Math.min(h, dirty.y1) };
      if (R.x1 <= R.x0 || R.y1 <= R.y0) { this.stats.skip++; return 'skip'; }
      this._compositeRegion(layers, outputTexture, R);
      this.stats.rect++;
      return 'rect';
    } catch (e) {
      // A region pipeline could not be built: stay on the legacy composite for good.
      console.warn('RasterCompositor: incremental composite unavailable, using the full composite', e);
      this._regionBroken = true;
      slot.sig = null;
      this.stats.full++;
      this.composite(layers, outputTexture);
      return 'full';
    }
  }

  /** The output of `slotKey` (every slot when omitted) was, or is about to be, written by something other than
   *  compositeIncremental: its next compositeIncremental is a full one. */
  public invalidateIncremental(slotKey?: string): void {
    if (slotKey === undefined) { for (const s of this._slots.values()) s.sig = null; return; }
    const slot = this._slots.get(slotKey);
    if (slot) slot.sig = null;
  }

  private texId(t: GPUTexture): number {
    let id = this._texIds.get(t);
    if (id === undefined) { id = this._nextTexId++; this._texIds.set(t, id); }
    return id;
  }

  /** Everything the composited pixels depend on besides the layers' own pixels, as a string; null when this
   *  frame can't be composited incrementally (a global dither or a displacement animation is active).
   *  `frameLink`: the signature of a LEGACY full composite() whose only obstacle is a Frame Link displacement — the
   *  same, plus the frame number and every displacement param composite() uploads ('fl' prefix, so it never matches
   *  a region-pass signature); null when there is no enabled Frame Link or a dither is active. */
  private incrementalSignature(layers: CompositorLayerInfo[], out: GPUTexture, frameLink = false): string | null {
    const g = this._ditherConfig;
    if (g.enabled && g.strength > 0.001) return null;
    let sig = this.texId(out) + ':' + out.width + 'x' + out.height;
    let sawFrameLink = false;
    for (const l of layers) {   // (per-layer dithers are resolved to their cached textures by the caller)
      if (!l.visible || !l.texture) continue;
      const d = l.ditherConfig;
      if (d && d.enabled && d.strength > 0.001) return null;   // (an unresolved list: never from compositeIncremental)
      const t = l.texture;
      sig += '|' + this.texId(t) + ',' + t.width + ',' + t.height + ',' + l.blendMode + ',' + l.opacity + ',' + (l.clipped ? 1 : 0);
      const a = l.frameLinkAnimation;
      if (a && a.enabled) {
        if (!frameLink) return null;   // displacement (reads other texels, changes with the frame number)
        sawFrameLink = true;
        // Exactly the inputs writeDisplacementParams reads (raw values: the ?? defaults are applied the same way).
        sig += ',fl' + a.type + ',' + a.amplitude + ',' + a.frequency + ',' + a.speed + ',' + a.direction + ',' + a.phase +
          ',' + (a.displaceX !== false ? 1 : 0) + (a.displaceY ? 1 : 0) + ',' + a.rippleCenterX + ',' + a.rippleCenterY +
          ',' + a.noiseOctaves + ',' + a.noiseLacunarity + ',' + a.noisePersistence + ',' + a.shakeSeed;
      }
    }
    if (frameLink) {
      if (!sawFrameLink) return null;
      sig = 'fl' + this.currentFrame + '#' + sig;
    }
    const gm = this._grainManager;
    const grainTex = gm ? gm.getGrainTexture() : null;
    if (gm && grainTex && gm.getGrainStrength() > 0.001) {
      const inv = gm.getGrainInvScale();
      sig += '|g' + this.texId(grainTex) + ',' + gm.getGrainStrength() + ',' + inv[0] + ',' + inv[1];
    }
    return sig;
  }

  /** The composite over `R` only (texels, max-exclusive, inside the output). Mirrors composite() pass for pass —
   *  minus the dithers and the displacement, which incrementalSignature() rules out. */
  private _compositeRegion(layers: CompositorLayerInfo[], outputTexture: GPUTexture, R: DirtyTexelRect): void {
    const w = outputTexture.width;
    const h = outputTexture.height;
    const visibleLayers = layers.filter(l => l.visible && l.texture);
    if (visibleLayers.length === 0) {
      this._regionClear(outputTexture, R);
      this._regionGrain(outputTexture, w, h, R);   // the blank canvas IS the paper
      return;
    }
    const first = visibleLayers[0];
    this._regionCopyBase(first.texture, outputTexture, R);
    if (first.opacity < 1.0) this._regionBaseOpacity(outputTexture, first.opacity, w, h, R);
    for (let i = 1; i < visibleLayers.length; i++) {
      this._regionLayerStep(visibleLayers[i], outputTexture, w, h, R);
    }
    this._regionGrain(outputTexture, w, h, R);
  }

  /** The persistent read-back texture of the region passes (the blend steps, the base opacity and the grain all
   *  read the output through it, one after the other). */
  private ensurePing(w: number, h: number): GPUTexture {
    if (!this.pingTex || this.pingTexW !== w || this.pingTexH !== h) {
      this.pingTex?.destroy();
      this.pingTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      this.pingTexW = w;
      this.pingTexH = h;
    }
    return this.pingTex;
  }

  /** Transparent black over `R` (a fresh GPU buffer is zero-filled). */
  private _regionClear(tex: GPUTexture, R: DirtyTexelRect): void {
    const w = R.x1 - R.x0, h = R.y1 - R.y0;
    if (w <= 0 || h <= 0) return;
    const paddedRowBytes = Math.ceil(w * 4 / 256) * 256;
    const buf = this.device.createBuffer({ size: paddedRowBytes * h, usage: GPUBufferUsage.COPY_SRC });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: buf, bytesPerRow: paddedRowBytes },
      { texture: tex, origin: { x: R.x0, y: R.y0 } },
      { width: w, height: h },
    );
    this.device.queue.submit([enc.finish()]);
    this.stats.submits++;
    buf.destroy();
  }

  /** Base layer → output over `R` (clipped to the layer's extent, like composite()'s base copy). */
  private _regionCopyBase(firstTex: GPUTexture, outputTexture: GPUTexture, R: DirtyTexelRect): void {
    const x1 = Math.min(R.x1, firstTex.width, outputTexture.width);
    const y1 = Math.min(R.y1, firstTex.height, outputTexture.height);
    if (x1 <= R.x0 || y1 <= R.y0) return;
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: firstTex, origin: { x: R.x0, y: R.y0 } },
      { texture: outputTexture, origin: { x: R.x0, y: R.y0 } },
      { width: x1 - R.x0, height: y1 - R.y0 },
    );
    this.device.queue.submit([enc.finish()]);
    this.noteCopy((x1 - R.x0) * (y1 - R.y0));
    this.stats.submits++;
  }

  /** applyBaseOpacity over `R`: one submit, reading the output through the persistent ping texture. */
  private _regionBaseOpacity(tex: GPUTexture, opacity: number, w: number, h: number, R: DirtyTexelRect): void {
    if (opacity >= 0.999) return;   // (the same threshold as applyBaseOpacity)
    const rw = R.x1 - R.x0, rh = R.y1 - R.y0;
    if (rw <= 0 || rh <= 0) return;
    const ping = this.ensurePing(w, h);
    if (!this._regionOpacityPipeline) {
      const code = /* wgsl */ `
        @group(0) @binding(0) var src: texture_2d<f32>;
        @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
        // regionOpacity[0] = [opacity, 0, 0, 0], regionOpacity[1] = [x0, y0, x1, y1] (texels, max-exclusive)
        @group(0) @binding(2) var<uniform> regionOpacity: array<vec4<f32>, 2>;

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
          let dim = textureDimensions(dst);
          let coords = vec2<i32>(i32(gid.x) + i32(regionOpacity[1].x), i32(gid.y) + i32(regionOpacity[1].y));
          if (coords.x >= i32(regionOpacity[1].z) || coords.y >= i32(regionOpacity[1].w)) { return; }
          if (coords.x >= i32(dim.x) || coords.y >= i32(dim.y)) { return; }
          let c = textureLoad(src, coords, 0);
          textureStore(dst, coords, vec4<f32>(c.rgb, c.a * regionOpacity[0].x));
        }
      `;
      this._regionOpacityBGL = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      this._regionOpacityPipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._regionOpacityBGL] }),
        compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
      });
      this._regionOpacityBuf = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    const d = this._regionOpacityData;
    d[0] = opacity; d[1] = 0; d[2] = 0; d[3] = 0;
    d[4] = R.x0; d[5] = R.y0; d[6] = R.x1; d[7] = R.y1;
    this.device.queue.writeBuffer(this._regionOpacityBuf!, 0, d);
    let cached = this._regionOpacityBG;
    if (!cached || cached.ping !== ping || cached.out !== tex) {
      cached = this._regionOpacityBG = {
        bg: this.device.createBindGroup({
          layout: this._regionOpacityBGL!,
          entries: [
            { binding: 0, resource: ping.createView() },
            { binding: 1, resource: tex.createView() },
            { binding: 2, resource: { buffer: this._regionOpacityBuf! } },
          ],
        }),
        ping, out: tex,
      };
    }
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: tex, origin: { x: R.x0, y: R.y0 } },
      { texture: ping, origin: { x: R.x0, y: R.y0 } },
      { width: rw, height: rh },
    );
    const pass = enc.beginComputePass();
    pass.setPipeline(this._regionOpacityPipeline);
    pass.setBindGroup(0, cached.bg);
    pass.dispatchWorkgroups(Math.ceil(rw / 8), Math.ceil(rh / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.noteCopy(rw * rh);
    this.noteDispatch(rw * rh, 1);
    this.stats.submits++;
  }

  /** The blend shader with a region: `params` grows by [x0, y0, x1, y1] and main() walks the region instead of
   *  the whole texture. Derived from the legacy source so the blend maths cannot drift apart. */
  private regionBlendCode(): string {
    const decl = /var<uniform> params: array<vec4<f32>, 5>;/;
    const head = /let dim = textureDimensions\(output\);\s*if \(gid\.x >= dim\.x \|\| gid\.y >= dim\.y\) \{ return; \}\s*let ix = i32\(gid\.x\);\s*let iy = i32\(gid\.y\);/;
    const code = this._blendCode;
    if (!decl.test(code) || !head.test(code)) {
      throw new Error('RasterCompositor: the blend shader changed — update regionBlendCode()');
    }
    return code
      .replace(decl, 'var<uniform> params: array<vec4<f32>, 6>;   // params[5] = regionRect [x0, y0, x1, y1]')
      .replace(head, `let dim = textureDimensions(output);
        let ix = i32(gid.x) + i32(params[5].x);
        let iy = i32(gid.y) + i32(params[5].y);
        if (ix >= i32(params[5].z) || iy >= i32(params[5].w)) { return; }
        if (ix >= i32(dim.x) || iy >= i32(dim.y)) { return; }`);
  }

  /** _compositeLayerStep over `R` (clipped to the layer's extent): only the region is read back and blended. */
  private _regionLayerStep(layer: CompositorLayerInfo, outputTexture: GPUTexture, w: number, h: number, R: DirtyTexelRect): void {
    const layerTex = layer.texture;
    const rx1 = Math.min(R.x1, layerTex.width, w);
    const ry1 = Math.min(R.y1, layerTex.height, h);
    if (rx1 <= R.x0 || ry1 <= R.y0) return;
    const rw = rx1 - R.x0, rh = ry1 - R.y0;
    const ping = this.ensurePing(w, h);
    if (!this._regionBlendPipeline) {
      const code = this.regionBlendCode();
      this._regionBlendBGL = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', minBindingSize: 96 } },
        ],
      });
      this._regionBlendPipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._regionBlendBGL] }),
        compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
      });
    }

    // params[0] = blend, params[1..4] = displacement OFF (type 0; texW/texH kept), params[5] = the region
    const pd = this._regionParams;
    pd.fill(0);
    pd[0] = layer.blendMode; pd[1] = layer.opacity; pd[2] = layer.clipped ? 1.0 : 0.0;
    pd[10] = this.currentFrame; pd[18] = w; pd[19] = h;
    pd[20] = R.x0; pd[21] = R.y0; pd[22] = rx1; pd[23] = ry1;

    let entry = this._regionStepCache.get(layerTex);
    if (!entry || entry.ping !== ping || entry.out !== outputTexture) {
      const buf = entry?.buf ?? this.device.createBuffer({
        size: pd.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      entry = {
        buf,
        bg: this.device.createBindGroup({
          layout: this._regionBlendBGL!,
          entries: [
            { binding: 0, resource: ping.createView() },
            { binding: 1, resource: layerTex.createView() },
            { binding: 2, resource: outputTexture.createView() },
            { binding: 3, resource: { buffer: buf } },
          ],
        }),
        ping, out: outputTexture,
      };
      this._regionStepCache.set(layerTex, entry);
    }
    this.device.queue.writeBuffer(entry.buf, 0, pd);

    // Only the region is read back: the shader reads the accumulated result at its own texel only.
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: outputTexture, origin: { x: R.x0, y: R.y0 } },
      { texture: ping, origin: { x: R.x0, y: R.y0 } },
      { width: rw, height: rh },
    );
    const pass = enc.beginComputePass();
    pass.setPipeline(this._regionBlendPipeline);
    pass.setBindGroup(0, entry.bg);
    pass.dispatchWorkgroups(Math.ceil(rw / 8), Math.ceil(rh / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.noteCopy(rw * rh);
    this.noteDispatch(rw * rh, 2);
    this.stats.submits++;
  }

  /** applyGrainOverlay over `R`. The grain is sampled at the ABSOLUTE canvas texel, so a sub-rect is seamless. */
  private _regionGrain(tex: GPUTexture, w: number, h: number, R: DirtyTexelRect): void {
    if (!this._grainManager) return;
    const grainTex = this._grainManager.getGrainTexture();
    if (!grainTex) return;
    const strength = this._grainManager.getGrainStrength();
    if (strength <= 0.001) return;
    const invScale = this._grainManager.getGrainInvScale();
    const rw = R.x1 - R.x0, rh = R.y1 - R.y0;
    if (rw <= 0 || rh <= 0) return;
    const ping = this.ensurePing(w, h);
    if (!this._regionGrainPipeline) {
      const code = /* wgsl */ `
        @group(0) @binding(0) var srcTex: texture_2d<f32>;       // composited paint input
        @group(0) @binding(1) var grainTex: texture_2d<f32>;     // r8unorm tiling grain
        @group(0) @binding(2) var grainSamp: sampler;            // repeat sampler
        // regionGrain[0] = [invScaleX, invScaleY, strength, pad], regionGrain[1] = [x0, y0, x1, y1]
        @group(0) @binding(3) var<uniform> regionGrain: array<vec4<f32>, 2>;
        @group(0) @binding(4) var output: texture_storage_2d<rgba8unorm, write>;

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
          let dim = textureDimensions(output);
          let grainParams = regionGrain[0];
          let coords = vec2<i32>(i32(gid.x) + i32(regionGrain[1].x), i32(gid.y) + i32(regionGrain[1].y));
          if (coords.x >= i32(regionGrain[1].z) || coords.y >= i32(regionGrain[1].w)) { return; }
          if (coords.x >= i32(dim.x) || coords.y >= i32(dim.y)) { return; }

          let src = textureLoad(srcTex, coords, 0);

          // The same maths as the full-canvas grain overlay, at the absolute canvas texel
          let grainUV = vec2<f32>(f32(coords.x), f32(coords.y)) * grainParams.xy;
          let grainVal = textureSampleLevel(grainTex, grainSamp, grainUV, 0.0).r;
          let strength = grainParams.z;
          let modulation = mix(1.0, grainVal, strength);
          let paperRGB = vec3<f32>(1.0) * modulation;
          let paintRGB = src.rgb * modulation;
          let paintA   = src.a;
          let outRGB = paintRGB * paintA + paperRGB * (1.0 - paintA);
          textureStore(output, coords, vec4<f32>(outRGB, 1.0));
        }
      `;
      this._regionGrainSampler = this.device.createSampler({
        magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
      });
      this._regionGrainBGL = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        ],
      });
      this._regionGrainPipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._regionGrainBGL] }),
        compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
      });
      this._regionGrainBuf = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    const d = this._regionGrainData;
    d[0] = invScale[0]; d[1] = invScale[1]; d[2] = strength; d[3] = 0;
    d[4] = R.x0; d[5] = R.y0; d[6] = R.x1; d[7] = R.y1;
    this.device.queue.writeBuffer(this._regionGrainBuf!, 0, d);
    let cached = this._regionGrainBG;
    if (!cached || cached.ping !== ping || cached.grain !== grainTex || cached.out !== tex) {
      cached = this._regionGrainBG = {
        bg: this.device.createBindGroup({
          layout: this._regionGrainBGL!,
          entries: [
            { binding: 0, resource: ping.createView() },
            { binding: 1, resource: grainTex.createView() },
            { binding: 2, resource: this._regionGrainSampler! },
            { binding: 3, resource: { buffer: this._regionGrainBuf! } },
            { binding: 4, resource: tex.createView() },
          ],
        }),
        ping, grain: grainTex, out: tex,
      };
    }
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: tex, origin: { x: R.x0, y: R.y0 } },
      { texture: ping, origin: { x: R.x0, y: R.y0 } },
      { width: rw, height: rh },
    );
    const pass = enc.beginComputePass();
    pass.setPipeline(this._regionGrainPipeline);
    pass.setBindGroup(0, cached.bg);
    pass.dispatchWorkgroups(Math.ceil(rw / 8), Math.ceil(rh / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.noteCopy(rw * rh);
    this.noteDispatch(rw * rh, 1);
    this.stats.submits++;
  }

  public destroy(): void {
    this.paramsBuf.destroy();
    this.pingTex?.destroy();
    this.pingTex = null;
    this._ditherCache.destroy();
    this._ditherEngine.destroy();
    this._unsubStrokeEnd();
    this._grainOverlayPingTex?.destroy();
    this._grainOverlayPingTex = null;
    this._grainOverlayParamBuf?.destroy();
    this._grainOverlayParamBuf = null;
    this._onionPingTex?.destroy();
    this._onionPingTex = null;
    this._baseOpacityBuf?.destroy();
    this._baseOpacityBuf = null;
    this._baseOpacityTmp?.destroy();
    this._baseOpacityTmp = null;
    this._regionOpacityBuf?.destroy();
    this._regionOpacityBuf = null;
    this._regionGrainBuf?.destroy();
    this._regionGrainBuf = null;
    this._slots.clear();
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private clearTexture(tex: GPUTexture): void {
    // Write transparent black to the entire texture via buffer copy
    const w = tex.width;
    const h = tex.height;
    const paddedRowBytes = Math.ceil(w * 4 / 256) * 256;
    const buf = this.device.createBuffer({
      size: paddedRowBytes * h,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).fill(0);
    buf.unmap();

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: buf, bytesPerRow: paddedRowBytes },
      { texture: tex },
      { width: w, height: h },
    );
    this.device.queue.submit([enc.finish()]);
    buf.destroy();
  }

  /**
   * Apply opacity to the base layer in-place by scaling alpha.
   * Uses a compute pass that reads the texture and writes back with scaled alpha.
   */
  private applyBaseOpacity(tex: GPUTexture, opacity: number, w: number, h: number): void {
    if (opacity >= 0.999) return;

    // Need a copy to read from (can't read+write same texture). BRUSH-5: kept across frames (it used to be a
    // full-size texture created and destroyed EVERY frame); the copy + pass are the same as before.
    if (!this._baseOpacityTmp || this._baseOpacityTmpW !== w || this._baseOpacityTmpH !== h) {
      this._baseOpacityTmp?.destroy();
      this._baseOpacityTmp = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this._baseOpacityTmpW = w;
      this._baseOpacityTmpH = h;
    }
    const tmpTex = this._baseOpacityTmp;
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture({ texture: tex }, { texture: tmpTex }, { width: w, height: h });
    this.device.queue.submit([cpEnc.finish()]);

    // Simple compute pass to scale alpha
    if (!this._baseOpacityPipeline) {
      const code = /* wgsl */ `
        @group(0) @binding(0) var src: texture_2d<f32>;
        @group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
        @group(0) @binding(2) var<uniform> opacity: f32;

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
          let dim = textureDimensions(dst);
          if (gid.x >= dim.x || gid.y >= dim.y) { return; }
          let coords = vec2<i32>(i32(gid.x), i32(gid.y));
          let c = textureLoad(src, coords, 0);
          textureStore(dst, coords, vec4<f32>(c.rgb, c.a * opacity));
        }
      `;
      this._baseOpacityBGL = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      this._baseOpacityPipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._baseOpacityBGL] }),
        compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
      });
    }

    // Write opacity uniform
    if (!this._baseOpacityBuf) {
      this._baseOpacityBuf = this.device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this._baseOpacityBuf, 0, new Float32Array([opacity]));

    const bg = this.device.createBindGroup({
      layout: this._baseOpacityBGL!,
      entries: [
        { binding: 0, resource: tmpTex.createView() },
        { binding: 1, resource: tex.createView() },
        { binding: 2, resource: { buffer: this._baseOpacityBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this._baseOpacityPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.noteCopy(w * h);
    this.noteDispatch(w * h, 1);
    this.stats.submits += 2;
  }

  // ── Global grain overlay ────────────────────────────────────────────

  /**
   * Apply global canvas grain as a post-process on any raster texture.
   * Makes the entire canvas look like textured paper:
   *  - Unpainted areas show as white paper with grain texture (peaks/valleys)
   *  - Painted areas show paint modulated by grain (paint catches on peaks)
   * Call this after compositing, or directly on a single-layer texture.
   */
  public applyGrainOverlay(tex: GPUTexture, w: number, h: number): void {
    if (!this._grainManager) return;
    const grainTex = this._grainManager.getGrainTexture();
    if (!grainTex) return;
    const strength = this._grainManager.getGrainStrength();
    if (strength <= 0.001) return;
    const invScale = this._grainManager.getGrainInvScale();

    this.ensureGrainOverlayPipeline();

    // Write grain params: invScaleX, invScaleY, strength, pad
    if (!this._grainOverlayParamBuf) {
      this._grainOverlayParamBuf = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(
      this._grainOverlayParamBuf,
      0,
      new Float32Array([invScale[0], invScale[1], strength, 0]),
    );

    // Ensure ping texture for read-back
    if (!this._grainOverlayPingTex || this._grainOverlayPingW !== w || this._grainOverlayPingH !== h) {
      this._grainOverlayPingTex?.destroy();
      this._grainOverlayPingTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this._grainOverlayPingW = w;
      this._grainOverlayPingH = h;
    }

    // Copy current composited output → ping
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture({ texture: tex }, { texture: this._grainOverlayPingTex! }, { width: w, height: h });
    this.device.queue.submit([cpEnc.finish()]);

    const bg = this.device.createBindGroup({
      layout: this._grainOverlayBGL!,
      entries: [
        { binding: 0, resource: this._grainOverlayPingTex!.createView() },
        { binding: 1, resource: grainTex.createView() },
        { binding: 2, resource: this._grainOverlaySampler! },
        { binding: 3, resource: { buffer: this._grainOverlayParamBuf } },
        { binding: 4, resource: tex.createView() },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this._grainOverlayPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.noteCopy(w * h);
    this.noteDispatch(w * h, 1);
    this.stats.submits += 2;
  }

  private ensureGrainOverlayPipeline(): void {
    if (this._grainOverlayPipeline) return;

    this._grainOverlaySampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;       // composited paint input
      @group(0) @binding(1) var grainTex: texture_2d<f32>;     // r8unorm tiling grain
      @group(0) @binding(2) var grainSamp: sampler;            // repeat sampler
      @group(0) @binding(3) var<uniform> grainParams: vec4<f32>; // invScaleX, invScaleY, strength, pad
      @group(0) @binding(4) var output: texture_storage_2d<rgba8unorm, write>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);

        // Sample grain texture at canvas-space position (tiling)
        let grainUV = vec2<f32>(f32(gid.x), f32(gid.y)) * grainParams.xy;
        let grainVal = textureSampleLevel(grainTex, grainSamp, grainUV, 0.0).r;
        let strength = grainParams.z;
        let modulation = mix(1.0, grainVal, strength);

        // The canvas IS paper. The grain texture is the paper surface.
        // Paper base: white modulated by grain (peaks = bright, valleys = darker)
        let paperRGB = vec3<f32>(1.0) * modulation;

        // Composite paint over the paper surface.
        // Paint color is also modulated by grain (paint catches on peaks, skips valleys).
        let paintRGB = src.rgb * modulation;
        let paintA   = src.a;

        // Alpha-over: paint on top of opaque paper
        let outRGB = paintRGB * paintA + paperRGB * (1.0 - paintA);

        // Output is always fully opaque — this IS the paper
        textureStore(output, coords, vec4<f32>(outRGB, 1.0));
      }
    `;

    this._grainOverlayBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      ],
    });

    this._grainOverlayPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this._grainOverlayBGL] }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }

  // ── Pipeline construction ─────────────────────────────────────────

  private buildPipeline(): void {
    const code = /* wgsl */ `
      @group(0) @binding(0) var accum: texture_2d<f32>;       // accumulated result (read)
      @group(0) @binding(1) var layerTex: texture_2d<f32>;    // current layer (read)
      @group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>; // output (write)
      // params[0] = [blendMode, opacity, clipped, pad]
      // params[1] = [dispType, amplitude, frequency, speed]
      // params[2] = [direction, phase, currentFrame, flags(displaceX|displaceY)]
      // params[3] = [rippleCenterX, rippleCenterY, noiseOctaves, noiseLacunarity]
      // params[4] = [noisePersistence, shakeSeed, texW, texH]
      @group(0) @binding(3) var<uniform> params: array<vec4<f32>, 5>;

      // ── Blend mode functions ──
      // All operate on premultiplied-alpha-free RGB. Alpha is handled separately.

      fn blendNormal(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return src; }

      fn blendMultiply(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return dst * src; }

      fn blendScreen(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        return 1.0 - (1.0 - dst) * (1.0 - src);
      }

      fn blendOverlay(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        // Per channel: if dst < 0.5 → 2*dst*src, else 1 - 2*(1-dst)*(1-src)
        let low = 2.0 * dst * src;
        let high = 1.0 - 2.0 * (1.0 - dst) * (1.0 - src);
        return select(high, low, dst < vec3<f32>(0.5));
      }

      fn blendSoftLight(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        // W3C formula
        let d = select(sqrt(dst), ((16.0 * dst - 12.0) * dst + 4.0) * dst, dst <= vec3<f32>(0.25));
        return select(dst + (2.0 * src - 1.0) * (d - dst), dst - (1.0 - 2.0 * src) * dst * (1.0 - dst), src <= vec3<f32>(0.5));
      }

      fn blendHardLight(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        return blendOverlay(src, dst); // hardlight = overlay with swapped args
      }

      fn blendColorDodge(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        return select(min(vec3<f32>(1.0), dst / max(1.0 - src, vec3<f32>(0.001))), vec3<f32>(0.0), dst <= vec3<f32>(0.0));
      }

      fn blendColorBurn(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        return select(1.0 - min(vec3<f32>(1.0), (1.0 - dst) / max(src, vec3<f32>(0.001))), vec3<f32>(1.0), dst >= vec3<f32>(1.0));
      }

      fn blendDarken(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return min(dst, src); }
      fn blendLighten(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return max(dst, src); }

      fn blendAdd(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return min(dst + src, vec3<f32>(1.0)); }

      fn blendDifference(dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> { return abs(dst - src); }

      fn applyBlend(mode: i32, dst: vec3<f32>, src: vec3<f32>) -> vec3<f32> {
        switch (mode) {
          case 0:  { return blendNormal(dst, src); }
          case 1:  { return blendMultiply(dst, src); }
          case 2:  { return blendScreen(dst, src); }
          case 3:  { return blendOverlay(dst, src); }
          case 4:  { return blendSoftLight(dst, src); }
          case 5:  { return blendHardLight(dst, src); }
          case 6:  { return blendColorDodge(dst, src); }
          case 7:  { return blendColorBurn(dst, src); }
          case 8:  { return blendDarken(dst, src); }
          case 9:  { return blendLighten(dst, src); }
          case 10: { return blendAdd(dst, src); }
          case 11: { return blendDifference(dst, src); }
          default: { return blendNormal(dst, src); }
        }
      }

      // ── Displacement helpers ──

      // PCG hash for shake/noise
      fn pcgHash(v: u32) -> u32 {
        var s = v * 747796405u + 2891336453u;
        let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
        return (w >> 22u) ^ w;
      }

      fn hash2Dfloat(x: u32, y: u32) -> f32 {
        return f32(pcgHash(x + pcgHash(y))) / 4294967295.0;
      }

      // Simple gradient noise for organic displacement
      fn gradientNoise(px: f32, py: f32) -> f32 {
        let ix = i32(floor(px));
        let iy = i32(floor(py));
        let fx = fract(px);
        let fy = fract(py);
        // Smoothstep interpolation weights
        let ux = fx * fx * (3.0 - 2.0 * fx);
        let uy = fy * fy * (3.0 - 2.0 * fy);
        // Four corner hashes
        let a = hash2Dfloat(u32(ix),     u32(iy));
        let b = hash2Dfloat(u32(ix + 1), u32(iy));
        let c = hash2Dfloat(u32(ix),     u32(iy + 1));
        let d = hash2Dfloat(u32(ix + 1), u32(iy + 1));
        return mix(mix(a, b, ux), mix(c, d, ux), uy) * 2.0 - 1.0; // range: -1..1
      }

      // Compute texel displacement for a given pixel position
      fn computeDisplacement(px: f32, py: f32) -> vec2<f32> {
        let dispType  = i32(params[1].x);  // 0=none, 1=wave, 2=shake, 3=ripple, 4=noise, 5=turbulence
        let amplitude = params[1].y;
        let freq      = params[1].z;
        let speed     = params[1].w;
        let dir       = params[2].x;       // radians
        let phase     = params[2].y;
        let frame     = params[2].z;
        let flags     = u32(params[2].w);  // bit0 = displaceX, bit1 = displaceY
        let texW      = params[4].z;
        let texH      = params[4].w;

        if (dispType == 0 || amplitude < 0.001) {
          return vec2<f32>(0.0, 0.0);
        }

        let doX = (flags & 1u) != 0u;
        let doY = (flags & 2u) != 0u;

        // Normalized position
        let nx = px / texW;
        let ny = py / texH;

        // Direction vector
        let cs = cos(dir);
        let sn = sin(dir);

        var dx = 0.0;
        var dy = 0.0;

        switch (dispType) {
          // Wave: sinusoidal displacement along a direction
          case 1: {
            // Project pixel onto wave direction's perpendicular axis
            let proj = nx * (-sn) + ny * cs;
            let wave = sin(proj * freq * 6.283185 + frame * speed + phase);
            dx = select(0.0, wave * amplitude, doX);
            dy = select(0.0, wave * amplitude, doY);
            // Rotate displacement into wave direction
            let rdx = dx * cs - dy * sn;
            let rdy = dx * sn + dy * cs;
            dx = rdx;
            dy = rdy;
          }
          // Shake: whole-layer jitter per frame
          case 2: {
            let seed = u32(params[4].y);
            let fIdx = u32(frame) + seed;
            let jx = (hash2Dfloat(fIdx, 0u) * 2.0 - 1.0) * amplitude;
            let jy = (hash2Dfloat(fIdx, 1u) * 2.0 - 1.0) * amplitude;
            dx = select(0.0, jx, doX);
            dy = select(0.0, jy, doY);
          }
          // Ripple: radial waves from a center point
          case 3: {
            let cx = params[3].x;
            let cy = params[3].y;
            let dist = length(vec2<f32>(nx - cx, ny - cy));
            let wave = sin(dist * freq * 6.283185 - frame * speed + phase);
            // Radial direction from center
            let radDir = normalize(vec2<f32>(nx - cx, ny - cy) + vec2<f32>(0.0001));
            let d = wave * amplitude;
            dx = select(0.0, radDir.x * d, doX);
            dy = select(0.0, radDir.y * d, doY);
          }
          // Noise: simplex-like organic displacement
          case 4: {
            let nScale = freq;
            let nX = gradientNoise(nx * nScale + frame * speed, ny * nScale + phase);
            let nY = gradientNoise(nx * nScale + phase + 100.0, ny * nScale + frame * speed + 100.0);
            dx = select(0.0, nX * amplitude, doX);
            dy = select(0.0, nY * amplitude, doY);
          }
          // Turbulence: multi-octave layered noise
          case 5: {
            let octaves  = i32(params[3].z);
            let lacunarity  = params[3].w;
            let persistence = params[4].x;
            var tFreq = freq;
            var tAmp  = 1.0;
            var sumX  = 0.0;
            var sumY  = 0.0;
            var maxAmp = 0.0;
            for (var oi = 0; oi < 4; oi = oi + 1) {
              if (oi >= octaves) { break; }
              sumX = sumX + gradientNoise(nx * tFreq + frame * speed, ny * tFreq + phase) * tAmp;
              sumY = sumY + gradientNoise(nx * tFreq + phase + 50.0, ny * tFreq + frame * speed + 50.0) * tAmp;
              maxAmp = maxAmp + tAmp;
              tFreq = tFreq * lacunarity;
              tAmp = tAmp * persistence;
            }
            sumX = sumX / max(maxAmp, 0.001);
            sumY = sumY / max(maxAmp, 0.001);
            dx = select(0.0, sumX * amplitude, doX);
            dy = select(0.0, sumY * amplitude, doY);
          }
          default: {}
        }

        return vec2<f32>(dx, dy);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let ix = i32(gid.x);
        let iy = i32(gid.y);

        let blendMode = i32(params[0].x);
        let opacity   = params[0].y;
        let clipped   = params[0].z > 0.5;

        let coords = vec2<i32>(ix, iy);
        let dst = textureLoad(accum, coords, 0);     // accumulated below

        // Compute displaced sample coordinates for this layer
        let disp = computeDisplacement(f32(ix), f32(iy));
        let sx = clamp(ix + i32(round(disp.x)), 0, i32(dim.x) - 1);
        let sy = clamp(iy + i32(round(disp.y)), 0, i32(dim.y) - 1);
        let src = textureLoad(layerTex, vec2<i32>(sx, sy), 0);

        // Layer opacity scales the source alpha
        var srcA = src.a * opacity;

        // Clipping mask: multiply source alpha by the accumulated alpha below
        if (clipped) {
          srcA = srcA * dst.a;
        }

        if (srcA <= 0.001) {
          // Nothing to blend — keep accumulated as-is
          textureStore(output, coords, dst);
          return;
        }

        // Apply blend mode to RGB (straight alpha, not premultiplied)
        let blendedRGB = applyBlend(blendMode, dst.rgb, src.rgb);

        // Standard alpha compositing: src over dst
        let outA = srcA + dst.a * (1.0 - srcA);
        var outRGB = vec3<f32>(0.0);
        if (outA > 0.001) {
          outRGB = (blendedRGB * srcA + dst.rgb * dst.a * (1.0 - srcA)) / outA;
        }

        textureStore(output, coords, vec4<f32>(outRGB, outA));
      }
    `;

    this._blendCode = code;   // the incremental composite derives its region variant from it (regionBlendCode)

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', minBindingSize: 80 } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }
}
