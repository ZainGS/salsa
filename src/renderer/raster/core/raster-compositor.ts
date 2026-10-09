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
 *
 * ONE command encoder per composite (perf E9, 2026-10-09): every copy / blend / opacity / grain / global-dither pass
 * of a composite() / compositeIncremental() / applyGrainOverlay() call is recorded into one batch encoder and
 * submitted once at the end (was one submit per step: ~8–9 per render). Uniforms are written with queue.writeBuffer,
 * which lands before the batch's submit, so a uniform buffer is written at most once per batch (claimUniform submits
 * the batch early in the rare case one would be rewritten — the same layer texture listed twice). The per-layer
 * dither cache and the error-diffusion read-back keep their own submits (they run before / outside the batch).
 */

import { CanvasGrainManager } from '../canvas-grain';
import { DitherEngine, DitherConfig, defaultDitherConfig, ditherConfigActive } from '../effects/dither-engine';
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
  /** Signature of the inputs the persistent output was last composited from (numbers; see buildSignature) — valid
   *  only while hasSig. hasSig false = the output is not a known composite (never composited / composited by another
   *  path / post-processed in place) → the next incremental composite is a full one. */
  sig: number[];
  hasSig: boolean;
}

/** Element-wise equality of two signatures (NaN equals NaN: an undefined Frame Link field is written as NaN). */
function sameSignature(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x !== y && !(x !== x && y !== y)) return false;
  }
  return true;
}

function storeSignature(slot: IncrementalSlot, sig: readonly number[]): void {
  const d = slot.sig;
  d.length = sig.length;
  for (let i = 0; i < sig.length; i++) d[i] = sig[i];
  slot.hasSig = true;
}

const num = (v: number | undefined | null): number => (v === undefined || v === null ? NaN : v);

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
  /** An ANIMATED layer (it has cels): its dither cache keeps one entry per cel texture (bounded LRU) instead of one
   *  per layer, so a cel swap reuses that cel's dithered result (layer-dither-cache.ts, perf E5). */
  cacheCels?: boolean;
  /** Optional per-layer procedural displacement animation. */
  frameLinkAnimation?: FrameLinkAnimation;
}

/** Frame Link displacement type → the shader's dispType (0 = none). A module constant: it was a fresh object literal
 *  per layer per composite. */
const FRAME_LINK_TYPE_ID: Readonly<Record<string, number>> = {
  'wave': 1, 'shake': 2, 'ripple': 3, 'noise': 4, 'turbulence': 5,
};

/** The frame range a Frame Link "Loop to Fit" animation repeats over (1-based, inclusive): the timeline play range. */
export interface FrameLinkLoopRange { start: number; end: number }

/** What the displacement shader is given for one layer: the frame it evaluates, the phase advance per frame, and
 *  (noise types, Loop to Fit) the loop length it cross-fades over — 0 = no cross-fade. */
export interface FrameLinkTiming { frame: number; speed: number; blendLoop: number }

/**
 * Frame Link loop modes (UI audit 2026-10-09: Loop was stored but never read).
 *  - Free: the phase advances at Speed forever (frame = the timeline frame).
 *  - Loop to Fit: the animation repeats exactly over the play range (L frames), so playback loops seamlessly:
 *    Wave / Ripple round the speed to a whole number of cycles per L frames (at least one, sign kept);
 *    Shake repeats its jitter sequence every L frames;
 *    Noise / Turbulence (not periodic) cross-fade: D(t) * (1 - t/L) + D(t - L) * t/L over t = 0..L-1, which starts at
 *    D(0) and returns to it at t = L.
 * Frames outside the range wrap into it.
 */
export function frameLinkTiming(
  anim: Pick<FrameLinkAnimation, 'type' | 'speed' | 'loopMode'>, frame: number, range: FrameLinkLoopRange | null,
): FrameLinkTiming {
  const speed = anim.speed ?? 0.15;
  if (anim.loopMode !== 'loop-to-fit' || !range) return { frame, speed, blendLoop: 0 };
  const start = Math.round(range.start);
  const L = Math.max(1, Math.round(range.end) - start + 1);
  const t = (((Math.round(frame) - start) % L) + L) % L;
  switch (anim.type) {
    case 'wave': case 'ripple': {
      const TAU = Math.PI * 2;
      let n = Math.round(speed * L / TAU);
      if (n === 0 && speed !== 0) n = speed > 0 ? 1 : -1;
      return { frame: start + t, speed: n * TAU / L, blendLoop: 0 };
    }
    case 'shake': return { frame: start + t, speed, blendLoop: 0 };
    case 'noise': case 'turbulence': return { frame: t, speed, blendLoop: L > 1 ? L : 0 };
    default: return { frame, speed, blendLoop: 0 };
  }
}

export class RasterCompositor {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;

  // Uniform buffer for per-layer params:
  //   vec4[0] = [blendMode, opacity, clipped, dispBlendLoop]   (dispBlendLoop: frameLinkTiming)
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
  /** The timeline play range (the renderer sets it with currentFrame): what Frame Link "Loop to Fit" repeats over.
   *  null = no timeline (Loop to Fit behaves like Free). */
  public frameLoopRange: FrameLinkLoopRange | null = null;
  /** Is the timeline playing? (the renderer sets it before compositing): per-layer error-diffusion passes wait. */
  public playbackActive = false;

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

  // ── E9: one command encoder per composite (see the file header) ──
  private _enc: GPUCommandEncoder | null = null;
  private _encDepth = 0;
  /** Uniform buffers a command in the open batch reads (rewriting one first submits the batch). */
  private _encUniforms = new Set<GPUBuffer>();
  private readonly _submitList: GPUCommandBuffer[] = [null as unknown as GPUCommandBuffer];
  /** Buffers to destroy once the batch is submitted (a destroyed buffer must not be in a submit). */
  private _encTrash: GPUBuffer[] = [];

  // ── E8: per-frame allocations ──
  private _resolvedScratch: CompositorLayerInfo[] = [];
  private _resolvedInfo = new WeakMap<CompositorLayerInfo, CompositorLayerInfo>();
  private _resolvedChanged: DirtyTexelRect | 'full' | null = null;
  private _sigScratch: number[] = [];
  private _grainParamData = new Float32Array(4);
  private _grainOverlayBG: { bg: GPUBindGroup; ping: GPUTexture; grain: GPUTexture; out: GPUTexture; buf: GPUBuffer } | null = null;
  private _baseOpacityData = new Float32Array(1);
  private _baseOpacityBG: { bg: GPUBindGroup; tmp: GPUTexture; out: GPUTexture; buf: GPUBuffer } | null = null;

  /** The open batch encoder (made on first use). Only inside beginBatch() / endBatch(). */
  private enc(): GPUCommandEncoder {
    return this._enc ??= this.device.createCommandEncoder({ label: 'RasterCompositor batch' });
  }
  private beginBatch(): void { this._encDepth++; }
  private endBatch(): void {
    if (--this._encDepth > 0) return;
    this._encDepth = 0;
    this.flushBatch();
  }
  /** Submit what the batch recorded (one submit), then free its trash. */
  private flushBatch(): void {
    const e = this._enc;
    this._enc = null;
    this._encUniforms.clear();
    if (e) {
      const cb = this._submitList;
      cb[0] = e.finish();
      this.device.queue.submit(cb);
      cb[0] = null as unknown as GPUCommandBuffer;   // (do not keep the finished buffer alive)
      this.stats.submits++;
    }
    if (this._encTrash.length > 0) {
      for (const b of this._encTrash) b.destroy();
      this._encTrash.length = 0;
    }
  }
  /** `buf` is about to be rewritten with queue.writeBuffer: if a command already recorded in the open batch reads it,
   *  submit the batch first (writes land before the NEXT submit, so the recorded command would read the new value). */
  private claimUniform(buf: GPUBuffer): void {
    if (this._encUniforms.has(buf)) this.flushBatch();
    this._encUniforms.add(buf);
  }
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
    this._ditherCache = new LayerDitherCache(device, this._ditherEngine, (tex) => {
      // A cache texture changed outside a composite: an output composited from it is stale → full next time. An
      // off-screen cel's result (landed after playback) leaves the outputs alone — showing that cel later changes the
      // layer's texture identity, which the signature sees.
      if (this._signatureMentions(tex)) this.invalidateIncremental();
      this.requestRender?.();
    });
    this._ditherCache.isPlaybackActive = () => this.playbackActive;
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
  /** Per-cel dither cache limits of animated layers (E5): entries per layer (default 8) and bytes over all of them
   *  (null = a quarter of the shared raster undo budget). Omitted = unchanged. */
  public setDitherCelCacheLimits(perLayer?: number, bytes?: number | null): void {
    if (perLayer !== undefined) this._ditherCache.maxCelsPerLayer = Math.max(1, Math.floor(perLayer));
    if (bytes !== undefined) this._ditherCache.celBudgetBytes = bytes;
  }
  /** Bytes held by per-cel dither cache entries (diagnostics). */
  public get ditherCelCacheBytes(): number { return this._ditherCache.celEntryBytes; }

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

  /** The layers with each active per-layer dither swapped for its (brought up to date) cached texture; the union of
   *  the cache texels that changed doing so (the incremental composite re-composites them) is left in
   *  _resolvedChanged. E8: the returned list is a reused scratch array of reused per-layer objects (it was a slice +
   *  a spread per dithered layer per render) — valid until the next call. */
  private _resolveDithers(layers: CompositorLayerInfo[]): CompositorLayerInfo[] {
    this._ditherCache.beginFrame();
    let changed: DirtyTexelRect | 'full' | null = null;
    let out: CompositorLayerInfo[] | null = null;
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (!l.ditherConfig) continue;
      if (!l.visible || !l.texture) continue;   // hidden: neither dithered nor freed (showing it again is free)
      const r = this._ditherCache.resolve(l);
      changed = unionDitherRect(changed, r.changed);
      if (!out) {
        out = this._resolvedScratch;
        out.length = layers.length;
        for (let j = 0; j < layers.length; j++) out[j] = layers[j];
      }
      let c = this._resolvedInfo.get(l);
      if (!c) { c = { ...l }; this._resolvedInfo.set(l, c); }
      c.texture = r.texture; c.blendMode = l.blendMode; c.opacity = l.opacity; c.clipped = l.clipped;
      c.visible = l.visible; c.cacheKey = l.cacheKey; c.cacheCels = l.cacheCels;
      c.frameLinkAnimation = l.frameLinkAnimation; c.ditherConfig = undefined;
      out[i] = c;
    }
    this._resolvedChanged = changed;
    return out ?? layers;
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
      pd[3] = 0;
      pd[4] = 0; pd[5] = 0; pd[6] = 0; pd[7] = 0;
      pd[8] = 0; pd[9] = 0; pd[10] = this.currentFrame; pd[11] = 0;
      pd[12] = 0; pd[13] = 0; pd[14] = 0; pd[15] = 0;
      pd[16] = 0; pd[17] = 0; pd[18] = w; pd[19] = h;
      return;
    }

    const dirRad = (anim.direction ?? 0) * Math.PI / 180;
    const flags = (anim.displaceX !== false ? 1 : 0) | (anim.displaceY ? 2 : 0);

    const tm = frameLinkTiming(anim, this.currentFrame, this.frameLoopRange);   // Free / Loop to Fit
    pd[3]  = tm.blendLoop;
    // vec4[1]: dispType, amplitude, frequency, speed
    pd[4]  = FRAME_LINK_TYPE_ID[anim.type] ?? 0;
    pd[5]  = anim.amplitude ?? 0;
    pd[6]  = anim.frequency ?? 3;
    pd[7]  = tm.speed;
    // vec4[2]: direction(rad), phase, frame, flags
    pd[8]  = dirRad;
    pd[9]  = anim.phase ?? 0;
    pd[10] = tm.frame;
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
    return ditherConfigActive(globalCfg) && DitherEngine.isErrorDiffusion(globalCfg.algorithm);
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
    const resolved = this._resolveDithers(layers);
    const g = this._ditherConfig;
    const sig = DitherEngine.isActiveOrdered(g) ? this.globalResultSignature(resolved, outputTexture) : null;
    this.beginBatch();
    try {
      if (sig !== null && this.restoreGlobalResult(outputTexture, sig)) return;
      if (!this._compositeStack(resolved, outputTexture)) return;   // (no visible layer: cleared + paper, no dither)
      // ── Global non-destructive dither post-process (recorded into the batch) ──
      if (DitherEngine.isActiveOrdered(g)) this._ditherEngine.apply(outputTexture, g, this.enc());
      // ── Global canvas grain overlay pass ──
      this.applyGrainOverlay(outputTexture, w, h);
      if (sig !== null) this.storeGlobalResult(outputTexture, sig);
    } finally {
      this.endBatch();
    }
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
    const resolved = this._resolveDithers(layers);
    const g = { ...this._ditherConfig };
    const globalOn = ditherConfigActive(g);
    const ed = globalOn && DitherEngine.isErrorDiffusion(g.algorithm);
    const deferED = ed && isRasterStrokeActive();
    const sig = globalOn && !deferED ? this.globalResultSignature(resolved, outputTexture) : null;
    this.beginBatch();
    try {
      if (sig !== null && this.restoreGlobalResult(outputTexture, sig)) return;
      if (!this._compositeStack(resolved, outputTexture)) return;
    } finally {
      this.endBatch();   // (submitted before the async pass reads the output back)
    }
    // ── Global non-destructive dither post-process (async) ──
    if (deferED) this._globalEDDeferred = true;   // (the stroke-end listener asks for the frame that runs it)
    else await this._ditherEngine.applyAsync(outputTexture, g);
    this.beginBatch();
    try {
      // ── Global canvas grain overlay pass ──
      this.applyGrainOverlay(outputTexture, w, h);
      if (sig !== null) this.storeGlobalResult(outputTexture, sig);
    } finally {
      this.endBatch();
    }
  }

  /** The layer stack (base copy + opacity + blend steps) of composite() / compositeAsync(), dithers already resolved.
   *  False when no layer is visible: the output was cleared and given the paper grain (the caller is done). */
  private _compositeStack(layers: CompositorLayerInfo[], outputTexture: GPUTexture): boolean {
    const w = outputTexture.width;
    const h = outputTexture.height;
    let firstIdx = -1;
    for (let i = 0; i < layers.length; i++) if (layers[i].visible && layers[i].texture) { firstIdx = i; break; }
    if (firstIdx < 0) {
      this.clearTexture(outputTexture);
      // Still apply grain — the blank canvas IS the paper
      this.applyGrainOverlay(outputTexture, w, h);
      return false;
    }

    const first = layers[firstIdx];
    const firstTex = first.texture;
    if (RasterCompositor.baseNeedsBlendStep(first)) {
      // A displaced base (Frame Link): the copy would skip the displacement, so the base takes the blend step over a
      // cleared output instead — as Normal, unclipped (over a transparent backdrop that is exactly what the copy +
      // base-opacity pass give; blend modes / clipping of the bottom layer keep meaning nothing, as before).
      this.clearTexture(outputTexture);
      this.ensurePing(w, h);
      const b = this._baseStepLayer;
      b.texture = firstTex; b.visible = true; b.opacity = first.opacity; b.frameLinkAnimation = first.frameLinkAnimation;
      this._compositeLayerStep(b, firstTex, outputTexture, w, h);
      b.frameLinkAnimation = undefined;
    } else {
      // Copy first visible layer → output (no blending needed for the base)
      this.enc().copyTextureToTexture(
        { texture: firstTex },
        { texture: outputTexture },
        { width: Math.min(firstTex.width, w), height: Math.min(firstTex.height, h) },
      );
      this.noteCopy(Math.min(firstTex.width, w) * Math.min(firstTex.height, h));

      if (first.opacity < 1.0) {
        this.applyBaseOpacity(outputTexture, first.opacity, w, h);
      }
    }

    for (let i = firstIdx + 1; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.visible || !layer.texture) continue;
      this.ensurePing(w, h);   // persistent ping texture matching the output
      this._compositeLayerStep(layer, layer.texture, outputTexture, w, h);
    }
    return true;
  }

  /** The base layer's blend-step stand-in (reused: no allocation per frame). */
  private readonly _baseStepLayer: CompositorLayerInfo = {
    texture: null as unknown as GPUTexture, blendMode: LayerBlendMode.Normal, opacity: 1, clipped: false, visible: true,
  };

  /**
   * Does the BOTTOM visible layer need the blend step instead of the plain copy? Only for a visible Frame Link
   * displacement — the one per-layer step the copy skips that shows over an empty backdrop (its dither comes resolved,
   * its opacity has its own pass, the grain runs over the whole output, and blend mode / clipping mean nothing over
   * transparency). The same test as the shader's (amplitude below 0.001 = no displacement). compositeIncremental
   * never runs this on its region passes: any enabled Frame Link (base included) takes the legacy composite(), and
   * its signature carries the base's Frame Link params, so the decision is part of it.
   */
  public static baseNeedsBlendStep(l: Pick<CompositorLayerInfo, 'frameLinkAnimation'>): boolean {
    const a = l.frameLinkAnimation;
    return !!a && a.enabled && (FRAME_LINK_TYPE_ID[a.type] ?? 0) !== 0 && (a.amplitude ?? 0) >= 0.001;
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
          ',' + a.noiseOctaves + ',' + a.noiseLacunarity + ',' + a.noisePersistence + ',' + a.shakeSeed + ',' + (a.loopMode ?? 'free');
      }
    }
    if (frameLink) {
      const r = this.frameLoopRange;
      sig += '|f' + this.currentFrame + (r ? ',' + r.start + '-' + r.end : '');
    }
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
    this.enc().copyTextureToTexture({ texture: r.tex }, { texture: out }, { width: out.width, height: out.height });
    this.noteCopy(out.width * out.height);
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
    this.enc().copyTextureToTexture({ texture: out }, { texture: r.tex }, { width: out.width, height: out.height });
    this.noteCopy(out.width * out.height);
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
    this.claimUniform(entry.buf);
    this.device.queue.writeBuffer(entry.buf, 0, pd);

    const layerW = Math.min(layerTex.width, w);
    const layerH = Math.min(layerTex.height, h);
    const enc = this.enc();
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
    this.noteCopy(w * h);
    this.noteDispatch(layerW * layerH, 2);
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
    if (!slot) { slot = { cursor: new RasterDirtyCursor(), sig: [], hasSig: false }; this._slots.set(slotKey, slot); }
    layers = this._resolveDithers(layers);
    // always consumed: whatever we do below covers it (plus the dither-cache texels re-dithered just now)
    const dirty = unionDitherRect(slot.cursor.take(), this._resolvedChanged);
    const sig = this._sigScratch;
    const regionOk = !this._regionBroken && this.buildSignature(layers, outputTexture, false, sig);
    if (!regionOk) {
      // A Frame Link displacement (and nothing else) rules the region passes out: the legacy full composite runs, but
      // only when its inputs moved — the frame number, the displacement params, the layer list, or reported pixels.
      // Renders between two frame changes then reuse the output (it is exactly what composite() wrote last time).
      const flOk = this.buildSignature(layers, outputTexture, true, sig);
      if (flOk && slot.hasSig && sameSignature(sig, slot.sig) && !dirty) { this.stats.skip++; return 'skip'; }
      slot.hasSig = false;
      this.stats.full++;
      this.composite(layers, outputTexture);
      if (flOk) storeSignature(slot, sig);
      return 'full';
    }
    this.beginBatch();
    try {
      if (!slot.hasSig || !sameSignature(sig, slot.sig) || dirty === 'full') {
        slot.hasSig = false;
        this._compositeRegion(layers, outputTexture, 0, 0, w, h);
        storeSignature(slot, sig);
        this.stats.full++;
        return 'full';
      }
      if (!dirty) { this.stats.skip++; return 'skip'; }
      const x0 = Math.max(0, dirty.x0), y0 = Math.max(0, dirty.y0), x1 = Math.min(w, dirty.x1), y1 = Math.min(h, dirty.y1);
      if (x1 <= x0 || y1 <= y0) { this.stats.skip++; return 'skip'; }
      this._compositeRegion(layers, outputTexture, x0, y0, x1, y1);
      this.stats.rect++;
      return 'rect';
    } catch (e) {
      // A region pipeline could not be built: stay on the legacy composite for good.
      console.warn('RasterCompositor: incremental composite unavailable, using the full composite', e);
      this._regionBroken = true;
      slot.hasSig = false;
      this.stats.full++;
      this.composite(layers, outputTexture);
      return 'full';
    } finally {
      this.endBatch();
    }
  }

  /** The output of `slotKey` (every slot when omitted) was, or is about to be, written by something other than
   *  compositeIncremental: its next compositeIncremental is a full one. */
  public invalidateIncremental(slotKey?: string): void {
    if (slotKey === undefined) { for (const s of this._slots.values()) s.hasSig = false; return; }
    const slot = this._slots.get(slotKey);
    if (slot) slot.hasSig = false;
  }

  /** Could an output's last composite have read `tex`? (its id appears in a valid signature; a coincidence with
   *  another number only costs one needless full composite). */
  private _signatureMentions(tex: GPUTexture): boolean {
    const id = this._texIds.get(tex);
    if (id === undefined) return false;
    for (const s of this._slots.values()) {
      if (!s.hasSig) continue;
      for (let i = 0; i < s.sig.length; i++) if (s.sig[i] === id) return true;
    }
    return false;
  }

  private texId(t: GPUTexture): number {
    let id = this._texIds.get(t);
    if (id === undefined) { id = this._nextTexId++; this._texIds.set(t, id); }
    return id;
  }

  /**
   * Everything the composited pixels depend on besides the layers' own pixels, written into `sig` as numbers (E8: it
   * was a string built per render). False when this frame can't be composited incrementally (a global dither or a
   * displacement animation is active). `frameLink`: the signature of a LEGACY full composite() whose only obstacle
   * is a Frame Link displacement — the same, plus the frame number and every displacement param composite() uploads
   * (kind 1, so it never matches a region-pass signature, kind 0); false when there is no enabled Frame Link or a
   * dither is active. Layout: [kind, frame, loop start, loop end, out id, w, h, visible count, 22 per visible layer,
   * grain on, 4 grain].
   */
  private buildSignature(layers: CompositorLayerInfo[], out: GPUTexture, frameLink: boolean, sig: number[]): boolean {
    const g = this._ditherConfig;
    if (ditherConfigActive(g)) return false;
    let n = 0;
    sig[n++] = frameLink ? 1 : 0;
    sig[n++] = frameLink ? this.currentFrame : 0;
    sig[n++] = frameLink && this.frameLoopRange ? this.frameLoopRange.start : 0;
    sig[n++] = frameLink && this.frameLoopRange ? this.frameLoopRange.end : 0;
    sig[n++] = this.texId(out); sig[n++] = out.width; sig[n++] = out.height;
    const countAt = n++;
    let count = 0;
    let sawFrameLink = false;
    for (let i = 0; i < layers.length; i++) {   // (per-layer dithers are resolved to their cached textures by the caller)
      const l = layers[i];
      if (!l.visible || !l.texture) continue;
      const d = l.ditherConfig;
      if (ditherConfigActive(d)) return false;   // (an unresolved list: never from compositeIncremental)
      const t = l.texture;
      count++;
      sig[n++] = this.texId(t); sig[n++] = t.width; sig[n++] = t.height;
      sig[n++] = l.blendMode; sig[n++] = l.opacity; sig[n++] = l.clipped ? 1 : 0;
      const a = l.frameLinkAnimation;
      if (a && a.enabled) {
        if (!frameLink) return false;   // displacement (reads other texels, changes with the frame number)
        sawFrameLink = true;
        // Exactly the inputs writeDisplacementParams reads (raw values: the ?? defaults are applied the same way).
        sig[n++] = 1; sig[n++] = FRAME_LINK_TYPE_ID[a.type] ?? 0;
        sig[n++] = num(a.amplitude); sig[n++] = num(a.frequency); sig[n++] = num(a.speed); sig[n++] = num(a.direction);
        sig[n++] = num(a.phase); sig[n++] = a.displaceX !== false ? 1 : 0; sig[n++] = a.displaceY ? 1 : 0;
        sig[n++] = num(a.rippleCenterX); sig[n++] = num(a.rippleCenterY); sig[n++] = num(a.noiseOctaves);
        sig[n++] = num(a.noiseLacunarity); sig[n++] = num(a.noisePersistence);
        sig[n++] = num(a.shakeSeed); sig[n++] = a.loopMode === 'loop-to-fit' ? 1 : 0;
      } else {
        for (let k = 0; k < 16; k++) sig[n++] = 0;
      }
    }
    if (frameLink && !sawFrameLink) return false;
    sig[countAt] = count;
    const gm = this._grainManager;
    const grainTex = gm ? gm.getGrainTexture() : null;
    if (gm && grainTex && gm.getGrainStrength() > 0.001) {
      const inv = gm.getGrainInvScale();
      sig[n++] = 1; sig[n++] = this.texId(grainTex); sig[n++] = gm.getGrainStrength(); sig[n++] = inv[0]; sig[n++] = inv[1];
    } else {
      sig[n++] = 0;
    }
    sig.length = n;
    return true;
  }

  /** The composite over `R` only (texels, max-exclusive, inside the output). Mirrors composite() pass for pass —
   *  minus the dithers and the displacement, which incrementalSignature() rules out. */
  private _compositeRegion(layers: CompositorLayerInfo[], outputTexture: GPUTexture, x0: number, y0: number, x1: number, y1: number): void {
    const w = outputTexture.width;
    const h = outputTexture.height;
    const R = this._region;
    R.x0 = x0; R.y0 = y0; R.x1 = x1; R.y1 = y1;
    let firstIdx = -1;
    for (let i = 0; i < layers.length; i++) if (layers[i].visible && layers[i].texture) { firstIdx = i; break; }
    if (firstIdx < 0) {
      this._regionClear(outputTexture, R);
      this._regionGrain(outputTexture, w, h, R);   // the blank canvas IS the paper
      return;
    }
    const first = layers[firstIdx];
    this._regionCopyBase(first.texture, outputTexture, R);
    if (first.opacity < 1.0) this._regionBaseOpacity(outputTexture, first.opacity, w, h, R);
    for (let i = firstIdx + 1; i < layers.length; i++) {
      const l = layers[i];
      if (l.visible && l.texture) this._regionLayerStep(l, outputTexture, w, h, R);
    }
    this._regionGrain(outputTexture, w, h, R);
  }
  private _region: DirtyTexelRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

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
    this.enc().copyBufferToTexture(
      { buffer: buf, bytesPerRow: paddedRowBytes },
      { texture: tex, origin: { x: R.x0, y: R.y0 } },
      { width: w, height: h },
    );
    this._encTrash.push(buf);   // destroyed once the batch is submitted
  }

  /** Base layer → output over `R` (clipped to the layer's extent, like composite()'s base copy). */
  private _regionCopyBase(firstTex: GPUTexture, outputTexture: GPUTexture, R: DirtyTexelRect): void {
    const x1 = Math.min(R.x1, firstTex.width, outputTexture.width);
    const y1 = Math.min(R.y1, firstTex.height, outputTexture.height);
    if (x1 <= R.x0 || y1 <= R.y0) return;
    this.enc().copyTextureToTexture(
      { texture: firstTex, origin: { x: R.x0, y: R.y0 } },
      { texture: outputTexture, origin: { x: R.x0, y: R.y0 } },
      { width: x1 - R.x0, height: y1 - R.y0 },
    );
    this.noteCopy((x1 - R.x0) * (y1 - R.y0));
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
    this.claimUniform(this._regionOpacityBuf!);
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
    const enc = this.enc();
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
    this.noteCopy(rw * rh);
    this.noteDispatch(rw * rh, 1);
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
    this.claimUniform(entry.buf);
    this.device.queue.writeBuffer(entry.buf, 0, pd);

    // Only the region is read back: the shader reads the accumulated result at its own texel only.
    const enc = this.enc();
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
    this.noteCopy(rw * rh);
    this.noteDispatch(rw * rh, 2);
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
    this.claimUniform(this._regionGrainBuf!);
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
    const enc = this.enc();
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
    this.noteCopy(rw * rh);
    this.noteDispatch(rw * rh, 1);
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

    this.enc().copyBufferToTexture(
      { buffer: buf, bytesPerRow: paddedRowBytes },
      { texture: tex },
      { width: w, height: h },
    );
    this._encTrash.push(buf);   // destroyed once the batch is submitted
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
    const enc = this.enc();
    enc.copyTextureToTexture({ texture: tex }, { texture: tmpTex }, { width: w, height: h });

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

    // Write opacity uniform (E8: a persistent Float32Array and a cached bind group)
    if (!this._baseOpacityBuf) {
      this._baseOpacityBuf = this.device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    this._baseOpacityData[0] = opacity;
    this.claimUniform(this._baseOpacityBuf);
    this.device.queue.writeBuffer(this._baseOpacityBuf, 0, this._baseOpacityData);

    let cached = this._baseOpacityBG;
    if (!cached || cached.tmp !== tmpTex || cached.out !== tex || cached.buf !== this._baseOpacityBuf) {
      cached = this._baseOpacityBG = {
        bg: this.device.createBindGroup({
          layout: this._baseOpacityBGL!,
          entries: [
            { binding: 0, resource: tmpTex.createView() },
            { binding: 1, resource: tex.createView() },
            { binding: 2, resource: { buffer: this._baseOpacityBuf } },
          ],
        }),
        tmp: tmpTex, out: tex, buf: this._baseOpacityBuf,
      };
    }

    const pass = enc.beginComputePass();
    pass.setPipeline(this._baseOpacityPipeline);
    pass.setBindGroup(0, cached.bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.noteCopy(w * h);
    this.noteDispatch(w * h, 1);
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
    this.beginBatch();
    try {
      this._grainOverlayPass(tex, w, h, grainTex, strength, invScale);
    } finally {
      this.endBatch();
    }
  }

  private _grainOverlayPass(tex: GPUTexture, w: number, h: number, grainTex: GPUTexture, strength: number, invScale: ArrayLike<number>): void {
    // Write grain params: invScaleX, invScaleY, strength, pad (E8: a persistent Float32Array)
    if (!this._grainOverlayParamBuf) {
      this._grainOverlayParamBuf = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    const gp = this._grainParamData;
    gp[0] = invScale[0]; gp[1] = invScale[1]; gp[2] = strength; gp[3] = 0;
    this.claimUniform(this._grainOverlayParamBuf);
    this.device.queue.writeBuffer(this._grainOverlayParamBuf, 0, gp);

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
    const ping = this._grainOverlayPingTex!;
    const enc = this.enc();
    enc.copyTextureToTexture({ texture: tex }, { texture: ping }, { width: w, height: h });

    // (E8: the bind group is cached while its textures / buffer are the same objects)
    let cached = this._grainOverlayBG;
    if (!cached || cached.ping !== ping || cached.grain !== grainTex || cached.out !== tex || cached.buf !== this._grainOverlayParamBuf) {
      cached = this._grainOverlayBG = {
        bg: this.device.createBindGroup({
          layout: this._grainOverlayBGL!,
          entries: [
            { binding: 0, resource: ping.createView() },
            { binding: 1, resource: grainTex.createView() },
            { binding: 2, resource: this._grainOverlaySampler! },
            { binding: 3, resource: { buffer: this._grainOverlayParamBuf } },
            { binding: 4, resource: tex.createView() },
          ],
        }),
        ping, grain: grainTex, out: tex, buf: this._grainOverlayParamBuf,
      };
    }

    const pass = enc.beginComputePass();
    pass.setPipeline(this._grainOverlayPipeline!);
    pass.setBindGroup(0, cached.bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.noteCopy(w * h);
    this.noteDispatch(w * h, 1);
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

      // Texel displacement for a pixel. Loop to Fit for the noise types (params[0].w = loop length L, 0 = off):
      // cross-fade the frame with the frame one loop earlier, so the end of the loop meets its start.
      fn computeDisplacement(px: f32, py: f32) -> vec2<f32> {
        let frame   = params[2].z;
        let loopLen = params[0].w;
        let d = computeDisplacementAt(px, py, frame);
        if (loopLen < 0.5) { return d; }
        return mix(d, computeDisplacementAt(px, py, frame - loopLen), frame / loopLen);
      }

      // Texel displacement for a given pixel position at a given frame
      fn computeDisplacementAt(px: f32, py: f32, frame: f32) -> vec2<f32> {
        let dispType  = i32(params[1].x);  // 0=none, 1=wave, 2=shake, 3=ripple, 4=noise, 5=turbulence
        let amplitude = params[1].y;
        let freq      = params[1].z;
        let speed     = params[1].w;
        let dir       = params[2].x;       // radians
        let phase     = params[2].y;
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
