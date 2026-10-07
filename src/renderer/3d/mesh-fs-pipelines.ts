/**
 * SPECIALISED MESH FRAGMENT PIPELINES (docs/specs/shader-split.md §5; phase 1 of the shader split).
 *
 * One registry of (axis x key) render pipelines. The axis supplies everything but the fragment module (vertex module
 * and buffers, layout, blend, depth, cull: Pipeline3D's describe callback); the key's fragment module is generated
 * from the merged template (shaders/mesh-fs-generate.ts), created once per key string and shared across axes.
 *
 * SELECTION (pick), per draw run:
 *   exact compiled                          -> the exact pipeline
 *   else a compiled SUPERSET exists          -> the smallest one (WGSL bytes) draws, the exact key compiles in the
 *                                              background (DOCUMENT priority); same pixels (the template keeps every
 *                                              block's runtime gate), so the swap is invisible
 *   else                                     -> HOLD: the exact handle is requested through the cache's on-demand path
 *                                              (the draw is skipped, `waitingDraws` drives the host's "Preparing
 *                                              shaders"), and the `*-BASE` family of that axis is queued so the next
 *                                              new key has a fallback.
 * Outside a live frame (captures, thumbnails, tests) the exact key compiles synchronously, as every pipeline does.
 * NEVER the uber-shader: while the split is on, a covered mesh draws only generated pipelines (spec §9 decision 3).
 *
 * Test knobs (sm.setShaderSplit3D): forceFallback (draw with the smallest compiled superset even when the exact key is
 * ready: the fallback-swap identity check, spec §6.4(c)), noFallback (always hold), slowCompileMs (treat a newly
 * requested exact key as compiling for that long: exercises the fallback / hold paths on a fast desktop).
 */

import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle, type PipelinePriority } from '../core/gpu-pipeline-cache';
import { noteTwinSource } from './vertex-pack';
import { rdForceShaderSplit } from './render-debug';
import { generateMeshFs, meshFsSize } from './shaders/mesh-fs-generate';
import { meshFsBaseKey, meshFsBisectKey, meshFsKeyCovers, meshFsKeyOfNum, meshFsKeyString, type MeshFsBisect, type MeshFsKey } from './shaders/mesh-fs-key';

// ── The switch (spec §7.1) ─────────────────────────────────────────────────────────────────────────────────────────

/** Per-machine preference: 'on' | 'off' | 'auto' (= the phase default: OFF in phase 1). Read once at load. */
export const SHADER_SPLIT_STORAGE_KEY = 'salsa.shaderSplit';
export type ShaderSplitMode = 'on' | 'off' | 'auto';
/** Phase 1 default: off everywhere. */
const SHADER_SPLIT_DEFAULT = false;

function readMode(): ShaderSplitMode {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(SHADER_SPLIT_STORAGE_KEY) : null;
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch { return 'auto'; }
}

/** The live switch state (Renderer3D reads shaderSplitActive() at draw time; Pipeline3D at its boot warm). */
export const SHADER_SPLIT: { mode: ShaderSplitMode } = { mode: readMode() };

/** The split is on: the stored mode (auto = the phase default) or the render-debug forceShaderSplit switch. */
export function shaderSplitActive(): boolean {
  return (SHADER_SPLIT.mode === 'on' || (SHADER_SPLIT.mode === 'auto' && SHADER_SPLIT_DEFAULT)) || rdForceShaderSplit();
}

/** Set (and persist) the mode. 'auto' removes the stored value. */
export function setShaderSplitMode(mode: ShaderSplitMode): void {
  SHADER_SPLIT.mode = mode;
  try {
    if (typeof localStorage === 'undefined') return;
    if (mode === 'auto') localStorage.removeItem(SHADER_SPLIT_STORAGE_KEY); else localStorage.setItem(SHADER_SPLIT_STORAGE_KEY, mode);
  } catch { /* storage blocked: this session only */ }
}

if (SHADER_SPLIT.mode === 'on') console.warn(`[Salsa][shader-split] ON from localStorage (${SHADER_SPLIT_STORAGE_KEY}). sm.setShaderSplit3D({ mode: 'auto' }) clears it.`);

/** The pipeline axes phase 1 covers (spec §5.1 MeshAxis; the overlay / vertex-colour / face-kit / planar-mirror axes
 *  are phase 2 and keep today's pipelines). */
export type MeshFsAxis = 'opaque' | 'opaqueNoCull' | 'transparent' | 'transparentNoCull' | 'skinned';
export const MESH_FS_AXES: readonly MeshFsAxis[] = ['opaque', 'opaqueNoCull', 'transparent', 'transparentNoCull', 'skinned'];

/** Builds the pipeline descriptor of `axis` around fragment module `fs` (layout from key.tex / key.shadow). */
export type MeshFsDescribe = (axis: MeshFsAxis, key: MeshFsKey, fs: GPUShaderModule, label: string) => GPURenderPipelineDescriptor;

interface Entry {
  axis: MeshFsAxis;
  key: MeshFsKey;
  ks: string;
  bytes: number;
  h: PipelineHandle<GPURenderPipeline>;
  /** Background compile requested (warm or fallback) / its request time / wall ms to ready (-1 = not yet). */
  requested: boolean;
  t0: number;
  ms: number;
  /** slowCompileMs: not treated as ready before this time. */
  readyAt: number;
  /** Fallback memo (valid while fbGen === the registry gen). */
  fb: Entry | null;
  fbGen: number;
  noted: GPURenderPipeline | null;
}

/** The smallest (by `bytes`) candidate covering `key`, other than `self`; null when none. Pure (unit-tested). */
export function smallestCovering<T extends { key: MeshFsKey; bytes: number }>(key: MeshFsKey, candidates: Iterable<T>, self?: T): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (c === self || !meshFsKeyCovers(c.key, key)) continue;
    if (!best || c.bytes < best.bytes) best = c;
  }
  return best;
}

export interface MeshFsSplitOptions { forceFallback: boolean; noFallback: boolean; slowCompileMs: number; bisect: MeshFsBisect }

export interface MeshFsSplitStats {
  keys: number;
  pipelines: number;
  ready: number;
  pending: number;
  failed: number;
  /** Selection counters since the last reset (CPU runs and GPU-driven bucket resolves). */
  exact: number;
  fallback: number;
  held: number;
  list: { axis: MeshFsAxis; key: string; ready: boolean; bytes: number; lines: number; ms: number }[];
}

export class MeshFsPipelines {
  readonly opts: MeshFsSplitOptions = { forceFallback: false, noFallback: false, slowCompileMs: 0, bisect: 'none' };
  /** Called when an exact pipeline requested in the background (a fallback was drawing) lands: schedule a frame. */
  onLanded: (() => void) | null = null;
  private readonly _byNum: Map<number, Entry>[] = MESH_FS_AXES.map(() => new Map());
  private readonly _byStr = new Map<string, Entry>();
  private readonly _list: Entry[] = [];
  private readonly _modules = new Map<string, GPUShaderModule>();
  private _gen = 0;
  private _counts = { exact: 0, fallback: 0, held: 0 };

  constructor(
    private readonly device: GPUDevice,
    private readonly cache: GPUPipelineCache,
    private readonly describe: MeshFsDescribe,
    private readonly wrapFs: (code: string) => string,
  ) {}

  /** The entry of (axis, key), registering its handle (no compile) on first use. */
  entry(axis: MeshFsAxis, key: MeshFsKey): Entry {
    const ks = meshFsKeyString(key);
    const id = `${axis}|${ks}`;
    let e = this._byStr.get(id);
    if (e) return e;
    const code = generateMeshFs(key);
    const label = `MeshFS:${axis}:${ks}`;
    const h = this.cache.render(() => {
      let mod = this._modules.get(ks);
      if (!mod) { mod = this.device.createShaderModule({ code: this.wrapFs(code), label: `MeshFS:${ks}` }); this._modules.set(ks, mod); }
      return this.describe(axis, key, mod, label);
    }, label, label);
    e = { axis, key, ks, bytes: code.length, h, requested: false, t0: 0, ms: -1, readyAt: 0, fb: null, fbGen: -1, noted: null };
    this._byStr.set(id, e); this._list.push(e);
    return e;
  }

  /** Hot path: the entry of packed mesh key `num` (meshFsPhase1Num) under global bits `g`, with the bisect mode. */
  private _entryNum(axis: MeshFsAxis, num: number, g: number): Entry {
    const ai = MESH_FS_AXES.indexOf(axis);
    const map = this._byNum[ai];
    const id = num * 16 + g;   // g: MESH_FS_G_* (4 bits incl. the reserved f16 bit)
    let e = map.get(id);
    if (!e) {
      e = this.entry(axis, meshFsBisectKey(meshFsKeyOfNum(num, g), this.opts.bisect));
      map.set(id, e);
    }
    return e;
  }

  private _ready(e: Entry): boolean {
    if (!e.h.ready) return false;
    return this.opts.slowCompileMs <= 0 || !e.requested || performance.now() >= e.readyAt;
  }

  private _get(e: Entry): GPURenderPipeline | null {
    const p = e.h.get();
    if (p !== null && p !== e.noted) { noteTwinSource(p, e.h.descriptor()); e.noted = p; }   // P22: twin-able
    return p;
  }

  /** Queue a background compile of `e` (idempotent). */
  private _request(e: Entry, priority: PipelinePriority): void {
    if (e.requested) return;
    e.requested = true; e.t0 = performance.now(); e.readyAt = e.t0 + Math.max(0, this.opts.slowCompileMs);
    void e.h.warm(priority).then((p) => {
      if (!p) return;
      e.ms = performance.now() - e.t0;
      this._gen++;
      const wait = e.readyAt - performance.now();
      if (wait > 0) setTimeout(() => { this._gen++; this.onLanded?.(); }, wait);
      else this.onLanded?.();
    });
  }

  /** The smallest compiled superset of `e` on its axis (memoised until a pipeline lands). */
  private _fallback(e: Entry): Entry | null {
    if (e.fbGen === this._gen) return e.fb;
    const ready = this._list.filter((c) => c.axis === e.axis && this._ready(c));
    e.fb = smallestCovering(e.key, ready, e); e.fbGen = this._gen;
    return e.fb;
  }

  /** The pipeline to draw packed mesh key `num` with on `axis` (see the module doc), or null = hold (skip the draw). */
  pick(axis: MeshFsAxis, num: number, g: number): GPURenderPipeline | null {
    const e = this._entryNum(axis, num, g);
    const o = this.opts;
    if (!o.forceFallback && this._ready(e)) { this._counts.exact++; return this._get(e); }
    if (!this.cache.inFrame && o.slowCompileMs <= 0 && !o.forceFallback) { this._counts.exact++; return this._get(e); }   // capture / test: sync
    if (!o.noFallback) {
      const fb = this._fallback(e);
      if (fb) { this._request(e, PIPELINE_PRIORITY.DOCUMENT); this._counts.fallback++; return this._get(fb); }
    }
    if (o.forceFallback && this._ready(e)) { this._counts.exact++; return this._get(e); }   // nothing to fall back on
    // HOLD: the exact key through the on-demand path (marks waitingDraws); BASE queued as the next fallback
    this._counts.held++;
    const k = e.key;
    this._request(this.entry(axis, meshFsBaseKey(k.tex, k.shadow, k.debug, k.ssrInline)), PIPELINE_PRIORITY.DOCUMENT);
    this._request(e, PIPELINE_PRIORITY.NOW);
    if (o.slowCompileMs > 0 && e.h.ready) return null;   // simulated slow compile: compiled, treated as pending
    return this._get(e);   // in a live frame: null (the draw is skipped; marks waitingDraws, redraws when it lands)
  }

  /** The smallest compiled superset of packed key `num` (g) on `axis`, other than the exact key, or null. P22 packed
   *  draws use its packed twin while the chosen pipeline's own twin compiles (same pixels: it is a superset). */
  fallbackPipe(axis: MeshFsAxis, num: number, g: number): GPURenderPipeline | null {
    const fb = this._fallback(this._entryNum(axis, num, g));
    return fb ? this._get(fb) : null;
  }

  /** Queue `key` on `axis` for a background compile at `priority` (pre-warm). */
  warm(axis: MeshFsAxis, key: MeshFsKey, priority: PipelinePriority = PIPELINE_PRIORITY.DOCUMENT): void {
    this._request(this.entry(axis, key), priority);
  }

  /** Queue packed mesh key `num` (global bits `g`) on `axis` (the document pre-warm). */
  warmNum(axis: MeshFsAxis, num: number, g: number, priority: PipelinePriority = PIPELINE_PRIORITY.DOCUMENT): void {
    this._request(this._entryNum(axis, num, g), priority);
  }

  /** Every compiled pipeline with its descriptor (P22 packed twins). */
  compiled(): { p: GPURenderPipeline; desc: GPURenderPipelineDescriptor }[] {
    const out: { p: GPURenderPipeline; desc: GPURenderPipelineDescriptor }[] = [];
    for (const e of this._list) { const p = e.h.ready ? e.h.get() : null; if (p) out.push({ p, desc: e.h.descriptor() }); }
    return out;
  }

  /** Forget the hot-path memo (the bisect mode changed: packed keys map to other entries). */
  remap(): void { for (const m of this._byNum) m.clear(); this._gen++; }

  resetCounters(): void { this._counts = { exact: 0, fallback: 0, held: 0 }; }

  stats(): MeshFsSplitStats {
    let ready = 0, pending = 0, failed = 0;
    const list = this._list.map((e) => {
      const r = this._ready(e);
      if (r) ready++; else if (e.h.failed) failed++; else if (e.requested || e.h.pending) pending++;
      return { axis: e.axis, key: e.ks, ready: r, bytes: e.bytes, lines: meshFsSize(generateMeshFs(e.key)).lines, ms: Math.round(e.ms) };
    });
    return { keys: new Set(this._list.map((e) => e.ks)).size, pipelines: this._list.length, ready, pending, failed, ...this._counts, list };
  }
}
