/**
 * Per-layer DITHER CACHE (2026-10-08). A raster layer with an enabled per-layer dither used to be copied into one
 * shared scratch texture and dithered from scratch on EVERY composite — so a stroke on any layer re-dithered every
 * dithered layer at full resolution, and an error-diffusion layer did a GPU→CPU read-back + WASM pass per frame.
 *
 * Now each dithered layer keeps its own dithered copy (rgba8, the layer's size, made on first use) and the
 * compositor just samples it. It is redone only when its inputs change:
 *  - the layer texture OBJECT (a resize / cel switch / document load / device recovery gives a new one), the layer
 *    size or ANY dither config field → a full re-dither;
 *  - the layer's PIXELS (the per-texture content log, raster-content-version.ts — every pixel writer already reports
 *    there through markRasterCompositeDirty / bumpGpuPixelEpoch): ORDERED algorithms re-dither only the reported
 *    rect grown by DitherEngine.rectReach (the edge-effect taps and the density-dropout cell centre), which gives
 *    exactly the full re-dither's texels; an unknown rect re-dithers that layer only, whole;
 *  - ERROR DIFFUSION (a global, sequential pass) is never run per composite: while the layer changes, the cache
 *    keeps the previous result and the changed texels are patched in UNDITHERED (a raw copy); one full pass runs
 *    when the stroke on that layer ends (raster-stroke-activity.ts) or, for other changes, ~150 ms after the last
 *    one. One pass in flight at a time; a result whose source changed meanwhile is dropped (and the pass redone).
 *    A config-only change keeps showing the old result until the new one lands.
 *
 * Entries are freed when the dither is turned off, when the host drops the layer (retainOnly), on bake, and with
 * the compositor (device loss re-creates it; nothing survives a device).
 */

import { DitherEngine, type DitherConfig, type DitherTexelRect } from '../effects/dither-engine';
import { isWasmReady } from '../../../wasm/wasm-bindings';
import {
  rasterContentSeq, rasterTextureDirtySince, rasterTextureUid, rasterTextureWrittenAt,
} from '../raster-content-version';
import { isRasterStrokeActive, onRasterStrokeEnd } from '../raster-stroke-activity';

/** What the cache needs from a compositor layer. */
export interface DitherSourceLayer {
  texture: GPUTexture;
  ditherConfig?: DitherConfig;
  /** Stable id of the layer (the renderer passes the layer id); without one the texture object is the key. */
  cacheKey?: string;
}

/** resolve(): the texture to composite, and which of its texels changed since the previous resolve. */
export interface ResolvedDither {
  texture: GPUTexture;
  /** null = nothing, 'full' = everything, else the changed texels (inside the texture). */
  changed: DitherTexelRect | 'full' | null;
}

interface Entry {
  key: string | GPUTexture;
  tex: GPUTexture;
  w: number;
  h: number;
  /** Bumped on every write to `tex` (composite signatures). */
  gen: number;
  /** rasterTextureUid of the layer texture `tex` was made from. */
  srcUid: number;
  cfgKey: string;
  /** rasterContentSeq() when `tex` was last brought up to date with the source pixels. */
  seenSeq: number;
  /** The 'noise' pattern's seed — fixed per entry, so a re-dithered rect matches the rest. */
  noiseSeed: number;
  lastUsed: number;
  // ── error diffusion ──
  ed: boolean;
  /** `tex` does not hold the error diffusion of the current source + config yet. */
  stale: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  waitStroke: boolean;
  queued: boolean;
  noWasm: boolean;
  /** The latest source + config seen (the next pass's input). */
  src: GPUTexture;
  cfg: DitherConfig;
}

/** Every config field, in a stable order (a field added later is still covered). */
export function ditherConfigKey(cfg: DitherConfig): string {
  const o = cfg as unknown as Record<string, unknown>;
  let s = '';
  for (const k of Object.keys(o).sort()) s += k + ':' + JSON.stringify(o[k]) + '|';
  return s;
}

function unionRect(a: DitherTexelRect | 'full' | null, b: DitherTexelRect | 'full' | null): DitherTexelRect | 'full' | null {
  if (!a) return b;
  if (!b) return a;
  if (a === 'full' || b === 'full') return 'full';
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
export { unionRect as unionDitherRect };

export class LayerDitherCache {
  private entries = new Map<string | GPUTexture, Entry>();
  private byTex = new Map<GPUTexture, Entry>();
  private serial = 0;
  private nextSeed = 1;
  private inFlight = false;
  private destroyed = false;
  private unsubStroke: () => void;
  /** Delay of the error-diffusion pass after a non-stroke change (ms). */
  public debounceMs = 150;
  /** Texture-keyed entries (no cacheKey) not used for this many resolves are freed. */
  public maxIdleResolves = 600;

  /** Work counters (diagnostics / tests). */
  public readonly stats = {
    hits: 0, fullRedithers: 0, rectRedithers: 0, rectTexels: 0, rawPatches: 0,
    errorDiffusionPasses: 0, errorDiffusionLanded: 0, errorDiffusionDropped: 0, created: 0, released: 0,
  };

  constructor(
    private device: GPUDevice,
    private engine: DitherEngine,
    /** An error-diffusion result landed in a cache texture (outside any composite): composite again. */
    private onAsyncResult: () => void,
  ) {
    const self = new WeakRef(this);
    const unsub = onRasterStrokeEnd((tex) => {
      const c = self.deref();
      if (!c) { unsub(); return; }
      c.strokeEnded(tex);
    });
    this.unsubStroke = unsub;
  }

  /** Is this layer's dither one the cache serves (enabled, visible strength)? */
  public static active(cfg: DitherConfig | undefined | null): cfg is DitherConfig {
    return !!cfg && cfg.enabled && cfg.strength > 0.001;
  }

  /** A version string of a cache texture (changes on every write to it); null for a texture that is not one. */
  public versionOf(tex: GPUTexture): string | null {
    const e = this.byTex.get(tex);
    return e ? 'dc' + rasterTextureUid(tex) + '.' + e.gen : null;
  }

  /** Number of live entries (tests / diagnostics). */
  public get size(): number { return this.entries.size; }

  /**
   * The texture to composite for `layer`: its dithered cache (brought up to date first, doing only what changed),
   * or the layer texture itself when it has no active dither (its entry, if any, is freed).
   */
  public resolve(layer: DitherSourceLayer): ResolvedDither {
    const cfg = layer.ditherConfig;
    const src = layer.texture;
    const key = layer.cacheKey ?? src;
    if (!LayerDitherCache.active(cfg) || !src) {
      this.release(key);
      return { texture: src, changed: null };
    }
    const w = src.width, h = src.height;
    if (w === 0 || h === 0) return { texture: src, changed: null };
    this.serial++;
    if ((this.serial & 63) === 0) this.sweep();

    let e = this.entries.get(key);
    let fresh = false;
    if (!e || e.w !== w || e.h !== h) {
      if (e) this.release(key);
      e = this.create(key, src, cfg, w, h);
      fresh = true;
    }
    e.lastUsed = this.serial;
    e.src = src;
    e.cfg = cfg;

    const ed = DitherEngine.isErrorDiffusion(cfg.algorithm);
    const cfgKey = ditherConfigKey(cfg);
    const srcUid = rasterTextureUid(src);
    const structural = fresh || e.srcUid !== srcUid;
    const cfgChanged = e.cfgKey !== cfgKey || e.ed !== ed;
    const now = rasterContentSeq();
    const dirty = structural ? 'full' : rasterTextureDirtySince(src, e.seenSeq);
    e.srcUid = srcUid;
    e.cfgKey = cfgKey;
    e.ed = ed;
    e.seenSeq = now;   // (the work below is submitted now: it reads the source as of this point in the queue)

    if (!ed) {
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      e.stale = false; e.waitStroke = false; e.queued = false;
      if (structural || cfgChanged || dirty === 'full') {
        this.engine.applyRegion(src, e.tex, cfg, null, e.noiseSeed);
        e.gen++;
        this.stats.fullRedithers++;
        return { texture: e.tex, changed: 'full' };
      }
      if (dirty) {
        const reach = DitherEngine.rectReach(cfg, w);
        const r = clip({ x0: dirty.x0 - reach, y0: dirty.y0 - reach, x1: dirty.x1 + reach, y1: dirty.y1 + reach }, w, h);
        if (!r) { this.stats.hits++; return { texture: e.tex, changed: null }; }
        this.engine.applyRegion(src, e.tex, cfg, r, e.noiseSeed);
        e.gen++;
        this.stats.rectRedithers++;
        this.stats.rectTexels += (r.x1 - r.x0) * (r.y1 - r.y0);
        return { texture: e.tex, changed: r };
      }
      this.stats.hits++;
      return { texture: e.tex, changed: null };
    }

    // ── error diffusion: patch the changed texels in raw, run the real pass later ──
    let changed: DitherTexelRect | 'full' | null = null;
    if (structural || dirty === 'full') {
      this.rawCopy(src, e, null);
      changed = 'full';
    } else if (dirty) {
      const r = clip(dirty, w, h);
      if (r) { this.rawCopy(src, e, r); changed = r; }
    }
    if (structural || dirty || cfgChanged) {
      e.stale = true;
      this.schedule(e);
    } else if (e.stale && e.noWasm && isWasmReady()) {
      e.noWasm = false;
      this.schedule(e);
    } else {
      this.stats.hits++;
    }
    return { texture: e.tex, changed };
  }

  /**
   * Write `layer`'s dithered pixels into `dst` (usually the layer texture itself — the Bake) and free its entry.
   * Ordered: the up-to-date cache, copied. Error diffusion: a pass over the layer's current pixels, awaited.
   * False when the layer has no active dither or the pass could not run (error-diffusion WASM not ready).
   */
  public async bakeInto(layer: DitherSourceLayer, dst: GPUTexture): Promise<boolean> {
    const cfg = layer.ditherConfig;
    if (!LayerDitherCache.active(cfg) || !layer.texture) return false;
    const key = layer.cacheKey ?? layer.texture;
    const w = Math.min(layer.texture.width, dst.width), h = Math.min(layer.texture.height, dst.height);
    if (w === 0 || h === 0) return false;
    if (!DitherEngine.isErrorDiffusion(cfg.algorithm)) {
      const r = this.resolve(layer);
      if (r.texture === layer.texture) return false;
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture({ texture: r.texture }, { texture: dst }, { width: w, height: h });
      this.device.queue.submit([enc.finish()]);
    } else {
      const pixels = await this.engine.errorDiffuse(layer.texture, cfg);
      if (!pixels) return false;
      this.device.queue.writeTexture(
        { texture: dst }, pixels, { bytesPerRow: layer.texture.width * 4 }, { width: w, height: h },
      );
    }
    this.release(key);
    return true;
  }

  /** Free the entry of `key` (a layer id, or a texture for entries made without one). */
  public release(key: string | GPUTexture): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.byTex.delete(e.tex);
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    this.stats.released++;
    const tex = e.tex;
    // Deferred: a submitted command buffer (this frame's composite) may still reference it.
    this.device.queue.onSubmittedWorkDone().then(() => tex.destroy()).catch(() => { /* device lost */ });
  }

  /** Free every id-keyed entry whose id is not in `keys` (the host's layer list changed: deleted layers). */
  public retainOnly(keys: ReadonlySet<string>): void {
    for (const k of [...this.entries.keys()]) if (typeof k === 'string' && !keys.has(k)) this.release(k);
  }

  /** Free everything. */
  public clear(): void {
    for (const k of [...this.entries.keys()]) this.release(k);
  }

  public destroy(): void {
    this.clear();
    this.destroyed = true;
    this.unsubStroke();
  }

  // ── internals ──

  private create(key: string | GPUTexture, src: GPUTexture, cfg: DitherConfig, w: number, h: number): Entry {
    const tex = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING |
             GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    const e: Entry = {
      key, tex, w, h, gen: 0, srcUid: -1, cfgKey: '', seenSeq: 0, noiseSeed: this.nextSeed++, lastUsed: this.serial,
      ed: false, stale: false, timer: null, waitStroke: false, queued: false, noWasm: false, src, cfg,
    };
    this.entries.set(key, e);
    this.byTex.set(tex, e);
    this.stats.created++;
    return e;
  }

  private sweep(): void {
    for (const [k, e] of [...this.entries]) {
      if (typeof k !== 'string' && this.serial - e.lastUsed > this.maxIdleResolves) this.release(k);
    }
  }

  private rawCopy(src: GPUTexture, e: Entry, r: DitherTexelRect | null): void {
    const x0 = r ? r.x0 : 0, y0 = r ? r.y0 : 0, x1 = r ? r.x1 : e.w, y1 = r ? r.y1 : e.h;
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture(
      { texture: src, origin: { x: x0, y: y0 } },
      { texture: e.tex, origin: { x: x0, y: y0 } },
      { width: x1 - x0, height: y1 - y0 },
    );
    this.device.queue.submit([enc.finish()]);
    e.gen++;
    this.stats.rawPatches++;
  }

  private schedule(e: Entry): void {
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    if (isRasterStrokeActive(e.src)) { e.waitStroke = true; return; }   // strokeEnded() starts it
    e.waitStroke = false;
    e.timer = setTimeout(() => { e.timer = null; void this.run(e); }, this.debounceMs);
  }

  private strokeEnded(tex: object): void {
    for (const e of this.entries.values()) {
      if (!e.waitStroke || e.src !== tex) continue;
      e.waitStroke = false;
      if (e.timer) clearTimeout(e.timer);
      e.timer = setTimeout(() => { e.timer = null; void this.run(e); }, 0);
    }
  }

  private isCurrent(e: Entry): boolean {
    return !this.destroyed && this.entries.get(e.key) === e;
  }

  private async run(e: Entry): Promise<void> {
    if (!this.isCurrent(e) || !e.stale || !e.ed) return;
    if (this.inFlight) { e.queued = true; return; }
    if (isRasterStrokeActive(e.src)) { e.waitStroke = true; return; }
    const src = e.src, cfg = e.cfg, cfgKey = e.cfgKey, srcUid = e.srcUid;
    const seq = rasterContentSeq();   // BEFORE the read-back is submitted (a later write makes the result stale)
    this.inFlight = true;
    this.stats.errorDiffusionPasses++;
    let pixels: Uint8Array | null = null;
    try {
      pixels = await this.engine.errorDiffuse(src, cfg);
    } catch (err) {
      console.warn('[LayerDitherCache] error diffusion failed', err);
    } finally {
      this.inFlight = false;
    }
    const current = this.isCurrent(e) && e.ed && e.srcUid === srcUid && e.cfgKey === cfgKey &&
      e.w === src.width && e.h === src.height && rasterTextureWrittenAt(src) <= seq;
    if (current && pixels) {
      this.device.queue.writeTexture({ texture: e.tex }, pixels, { bytesPerRow: e.w * 4 }, { width: e.w, height: e.h });
      e.gen++;
      e.stale = false;
      this.stats.errorDiffusionLanded++;
      try { this.onAsyncResult(); } catch (err) { console.warn('[LayerDitherCache] onAsyncResult failed', err); }
    } else if (current) {
      e.noWasm = !isWasmReady();   // no pass possible: the layer stays undithered until WASM is ready
    } else {
      this.stats.errorDiffusionDropped++;   // the source / config moved on: drop it, run again for the new state
      if (this.isCurrent(e) && e.stale && e.ed) this.schedule(e);
    }
    for (const q of this.entries.values()) {
      if (!q.queued) continue;
      q.queued = false;
      void this.run(q);
      if (this.inFlight) break;   // the rest stay queued behind it
    }
  }
}

function clip(r: DitherTexelRect, w: number, h: number): DitherTexelRect | null {
  const x0 = Math.max(0, Math.floor(r.x0)), y0 = Math.max(0, Math.floor(r.y0));
  const x1 = Math.min(w, Math.ceil(r.x1)), y1 = Math.min(h, Math.ceil(r.y1));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}
