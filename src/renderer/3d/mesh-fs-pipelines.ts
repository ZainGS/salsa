/**
 * SPECIALISED MESH FRAGMENT PIPELINES (docs/specs/shader-split.md §5; phases 1-3 of the shader split: ON by default
 * on every tier since phase 3, 2026-10-07; the rollback is SHADER_SPLIT mode 'off' / render debug noShaderSplit).
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
 *   else (a SHADOW key) the same key WITHOUT shadows (or a compiled superset of it) is compiled
 *                                           -> the SHADOW STAND-IN: drawn with it (no received sun shadow for a few
 *                                              frames, the "briefly simpler look" of spec §9) while the shadow key
 *                                              compiles at DOCUMENT priority. Turning shadows on never blanks a mesh.
 *   else                                     -> HOLD: the exact handle is requested through the cache's on-demand path
 *                                              (the draw is skipped, `waitingDraws` drives the host's "Preparing
 *                                              shaders"), and the `*-BASE` family of that axis is queued so the next
 *                                              new key has a fallback.
 * Outside a live frame (captures, thumbnails, tests) the exact key compiles synchronously, as every pipeline does.
 * NEVER the uber-shader: while the split is on, a covered mesh draws only generated pipelines (spec §9 decision 3).
 *
 * KEY CAP (spec §4.5): at most MeshFsPipelines.maxKeys distinct exact keys per device (96 desktop / 40 mobile:
 * GpuCaps.shaderSplitMaxKeys). Past it a new key is WIDENED (meshFsWidenKey: ground modes, then styles + the light
 * features together, then the BASE features) to an already registered key where one fits, so a look switch stops
 * compiling new shaders. Never `*-ALL`.
 *
 * SEEN-KEYS JOURNAL (spec §5.3): the last JOURNAL_MAX (axis, key) pairs drawn exactly on this device are kept in
 * localStorage (salsa.shaderSplit.seen) and warmed at COMMON priority on the next boot (warmJournal), so a user who
 * opens the same kind of document again holds nothing. Debug / inline-SSR / bisect keys are not journalled.
 *
 * Test knobs (sm.setShaderSplit3D): forceFallback (draw with the smallest compiled superset even when the exact key is
 * ready: the fallback-swap identity check, spec §6.4(c)), noFallback (always hold), noStandIn (no shadow stand-in),
 * slowCompileMs (treat a newly requested exact key as compiling for that long: exercises the fallback / hold paths on
 * a fast desktop).
 */

import { GPUPipelineCache, PIPELINE_PRIORITY, type PipelineHandle, type PipelinePriority } from '../core/gpu-pipeline-cache';
import { noteTwinSource } from './vertex-pack';
import { rdNoShaderSplit } from './render-debug';
import { generateMeshFs, meshFsSize } from './shaders/mesh-fs-generate';
import { MESH_FS_FAMILIES, meshFsCoverageExcluding, setMeshFsCoverage, type MeshFsFamily, MESH_FS_G_DEBUG, MESH_FS_G_SHADOW, MESH_FS_G_SSR_INLINE, meshFsBaseKey, meshFsBisectKey, meshFsKeyCovers, meshFsKeyOfNum, meshFsKeyParse, meshFsKeyString, meshFsWidenKey, type MeshFsBisect, type MeshFsKey } from './shaders/mesh-fs-key';

// ── The switch (spec §7.1) ─────────────────────────────────────────────────────────────────────────────────────────

/** Per-machine preference: 'on' | 'off' | 'auto' (= the phase default: ON since phase 3). Read once at load. 'off' is
 *  the ROLLBACK (every mesh on the uber-shader, as before the split); a stored 'on' (the phase 1-2 tablet opt-in)
 *  still means on. */
export const SHADER_SPLIT_STORAGE_KEY = 'salsa.shaderSplit';
export type ShaderSplitMode = 'on' | 'off' | 'auto';
/** The phase default ('auto' / no stored value). Phase 3 (shader-split.md §13): ON on every tier: desktop, mobile and
 *  safe mode (§9 decision 8: the smaller shaders are the safer path). */
export const SHADER_SPLIT_DEFAULT = true;

function readMode(): ShaderSplitMode {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(SHADER_SPLIT_STORAGE_KEY) : null;
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch { return 'auto'; }
}

/** The live switch state (Renderer3D reads shaderSplitActive() at draw time; Pipeline3D at its boot warm). */
export const SHADER_SPLIT: { mode: ShaderSplitMode } = { mode: readMode() };

/** The split is on: the stored mode (auto = the phase default, ON), unless the render-debug rollback switch
 *  noShaderSplit forces it off. */
export function shaderSplitActive(): boolean {
  if (rdNoShaderSplit()) return false;
  return SHADER_SPLIT.mode === 'on' || (SHADER_SPLIT.mode === 'auto' && SHADER_SPLIT_DEFAULT);
}

/** Set (and persist) the mode. 'auto' removes the stored value. */
export function setShaderSplitMode(mode: ShaderSplitMode): void {
  SHADER_SPLIT.mode = mode;
  try {
    if (typeof localStorage === 'undefined') return;
    if (mode === 'auto') localStorage.removeItem(SHADER_SPLIT_STORAGE_KEY); else localStorage.setItem(SHADER_SPLIT_STORAGE_KEY, mode);
  } catch { /* storage blocked: this session only */ }
}

if (SHADER_SPLIT.mode === 'off') console.warn(`[Salsa][shader-split] OFF (rollback) from localStorage (${SHADER_SPLIT_STORAGE_KEY}): every mesh on the uber-shader. sm.setShaderSplit3D({ mode: 'auto' }) clears it.`);

/** Per-machine family exclusions (a JSON array of MeshFsFamily): the safety valve for a device where a phase-2 family
 *  looks wrong (for example a driver that compiles the window-facade hash differently, shader-split.md §11.6):
 *  `sm.setShaderSplit3D({ exclude: ['windows'] })` keeps those meshes on today's pipelines; `['phase2']` = phase 1. */
export const SHADER_SPLIT_EXCLUDE_STORAGE_KEY = 'salsa.shaderSplit.exclude';
function readExclude(): MeshFsFamily[] {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(SHADER_SPLIT_EXCLUDE_STORAGE_KEY) : null;
    const a = v ? JSON.parse(v) as unknown : null;
    return Array.isArray(a) ? a.filter((x): x is MeshFsFamily => MESH_FS_FAMILIES.includes(x as MeshFsFamily)) : [];
  } catch { return []; }
}
let _exclude: MeshFsFamily[] = readExclude();
if (_exclude.length) { setMeshFsCoverage(meshFsCoverageExcluding(_exclude)); console.warn(`[Salsa][shader-split] families on today's pipelines (${SHADER_SPLIT_EXCLUDE_STORAGE_KEY}): ${_exclude.join(', ')}`); }
/** The excluded families. */
export function shaderSplitExcluded(): readonly MeshFsFamily[] { return _exclude; }
/** Set (and persist) the excluded families. The caller re-derives the slot keys (Renderer3D.setShaderSplit). */
export function setShaderSplitExcluded(ex: readonly MeshFsFamily[]): void {
  _exclude = ex.filter((x) => MESH_FS_FAMILIES.includes(x));
  setMeshFsCoverage(meshFsCoverageExcluding(_exclude));
  try {
    if (typeof localStorage === 'undefined') return;
    if (_exclude.length) localStorage.setItem(SHADER_SPLIT_EXCLUDE_STORAGE_KEY, JSON.stringify(_exclude)); else localStorage.removeItem(SHADER_SPLIT_EXCLUDE_STORAGE_KEY);
  } catch { /* storage blocked: this session only */ }
}

/** The pipeline axes (spec §5.1 MeshAxis). The planar-mirror passes reuse opaqueNoCull / transparentNoCull / skinned
 *  (same layouts; only bind group 0 differs). The always-on-top 'overlay' axis has no draw site (only postOverlay). */
export type MeshFsAxis = 'opaque' | 'opaqueNoCull' | 'transparent' | 'transparentNoCull' | 'skinned' | 'vertexColour' | 'postOverlay' | 'skinnedFaceMultiply';
export const MESH_FS_AXES: readonly MeshFsAxis[] = ['opaque', 'opaqueNoCull', 'transparent', 'transparentNoCull', 'skinned', 'vertexColour', 'postOverlay', 'skinnedFaceMultiply'];

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
  /** Drawn with its exact pipeline at least once (the journal). */
  drawn: boolean;
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

export interface MeshFsSplitOptions { forceFallback: boolean; noFallback: boolean; noStandIn: boolean; slowCompileMs: number; bisect: MeshFsBisect }

export interface MeshFsSplitStats {
  keys: number;
  pipelines: number;
  ready: number;
  pending: number;
  failed: number;
  /** The key cap (distinct exact keys) and how many exact keys count against it. */
  maxKeys: number;
  exactKeys: number;
  /** Selection counters since the last reset (CPU runs and GPU-driven bucket resolves). */
  exact: number;
  fallback: number;
  /** Draws made with the no-shadow key while the shadow key compiles. */
  standIn: number;
  held: number;
  /** New keys widened by the cap (since the registry was created). */
  widened: number;
  list: { axis: MeshFsAxis; key: string; ready: boolean; bytes: number; lines: number; ms: number }[];
}

/** localStorage key of the seen-keys journal ({ v, keys: ['axis:keystring', ...] }, most recent last). */
export const SHADER_SPLIT_JOURNAL_KEY = 'salsa.shaderSplit.seen';
/** Bump when the key format / meaning changes: an older journal is then dropped, not misread. */
export const SHADER_SPLIT_JOURNAL_VERSION = 2;

export class MeshFsPipelines {
  /** Distinct exact keys per device before new keys are widened (WebGPURenderer.applyGpuCaps sets it from
   *  GpuCaps.shaderSplitMaxKeys: 96 desktop, 40 mobile / safe). */
  static maxKeys = 96;
  /** Entries the seen-keys journal keeps. */
  static journalMax = 64;
  readonly opts: MeshFsSplitOptions = { forceFallback: false, noFallback: false, noStandIn: false, slowCompileMs: 0, bisect: 'none' };
  /** Called when an exact pipeline requested in the background (a fallback was drawing) lands: schedule a frame. */
  onLanded: (() => void) | null = null;
  private readonly _byNum: Map<number, Entry>[] = MESH_FS_AXES.map(() => new Map());
  private readonly _byStr = new Map<string, Entry>();
  private readonly _list: Entry[] = [];
  private readonly _modules = new Map<string, GPUShaderModule>();
  /** Key strings of every registered entry (any axis), and the exact keys that count against the cap. */
  private readonly _keyStrs = new Set<string>();
  private readonly _exactKeys = new Set<string>();
  private _gen = 0;
  private _counts = { exact: 0, fallback: 0, standIn: 0, held: 0 };
  private _widened = 0;
  private _journal: string[] | null = null;
  private _journalSave: ReturnType<typeof setTimeout> | null = null;

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
    e = { axis, key, ks, bytes: code.length, h, requested: false, t0: 0, ms: -1, readyAt: 0, fb: null, fbGen: -1, noted: null, drawn: false };
    this._byStr.set(id, e); this._list.push(e); this._keyStrs.add(ks);
    return e;
  }

  /** The key a NEW exact key is drawn with under the cap: itself while fewer than maxKeys exact keys exist (or it is
   *  one of them), else the first widening step that reaches an already registered key, else the fully widened key. */
  private _capped(k: MeshFsKey): MeshFsKey {
    const ks = meshFsKeyString(k);
    if (this._exactKeys.has(ks) || this._exactKeys.size < Math.max(1, MeshFsPipelines.maxKeys)) { this._exactKeys.add(ks); return k; }
    this._widened++;
    let w = k;
    for (const step of [1, 2, 3] as const) {
      w = meshFsWidenKey(k, step);
      const ws = meshFsKeyString(w);
      if (this._exactKeys.has(ws) || this._keyStrs.has(ws)) return w;
    }
    this._exactKeys.add(meshFsKeyString(w));   // (one per heavy-feature class past the cap: bounded)
    return w;
  }

  /** Hot path: the entry of packed mesh key `num` (meshFsKeyNum) under global bits `g`, with the bisect mode. */
  private _entryNum(axis: MeshFsAxis, num: number, g: number): Entry {
    const map = this._byNum[MESH_FS_AXES.indexOf(axis)];
    const id = num * 16 + g;   // g: MESH_FS_G_* (4 bits incl. the reserved f16 bit)
    let e = map.get(id);
    if (!e) {
      e = this.entry(axis, this._capped(meshFsBisectKey(meshFsKeyOfNum(num, g), this.opts.bisect)));
      map.set(id, e);
    }
    return e;
  }

  /** The entry of packed key `num` (g) on `axis` if it was registered already (never registers one). */
  private _peekNum(axis: MeshFsAxis, num: number, g: number): Entry | null {
    const e = this._byNum[MESH_FS_AXES.indexOf(axis)].get(num * 16 + g);
    if (e) return e;
    return this._byStr.get(`${axis}|${meshFsKeyString(meshFsBisectKey(meshFsKeyOfNum(num, g), this.opts.bisect))}`) ?? null;
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

  /** The `*-BASE` entry of `axis` for key `k`'s layout + globals. */
  private _baseOf(axis: MeshFsAxis, k: MeshFsKey): Entry {
    return this.entry(axis, meshFsBaseKey(k.tex, k.shadow, k.debug, k.ssrInline));
  }

  /** The pipeline to draw packed mesh key `num` with on `axis` (see the module doc), or null = hold (skip the draw). */
  pick(axis: MeshFsAxis, num: number, g: number): GPURenderPipeline | null {
    const e = this._entryNum(axis, num, g);
    const o = this.opts;
    if (!o.forceFallback && this._ready(e)) { this._drawnExact(e); return this._get(e); }
    if (!this.cache.inFrame && o.slowCompileMs <= 0 && !o.forceFallback) { this._drawnExact(e); return this._get(e); }   // capture / test: sync
    if (!o.noFallback) {
      const fb = this._fallback(e);
      if (fb) { this._request(e, PIPELINE_PRIORITY.DOCUMENT); this._counts.fallback++; return this._get(fb); }
    }
    if (o.forceFallback && this._ready(e)) { this._drawnExact(e); return this._get(e); }   // nothing to fall back on
    if ((g & MESH_FS_G_SHADOW) !== 0 && !o.noStandIn && !o.noFallback) {
      // SHADOW STAND-IN: the same mesh's no-shadow pipeline (exact or a compiled superset) while the shadow key compiles
      const ns = this._peekNum(axis, num, g & ~MESH_FS_G_SHADOW);
      const si = ns ? (this._ready(ns) ? ns : this._fallback(ns)) : null;
      if (si) {
        this._request(e, PIPELINE_PRIORITY.DOCUMENT);
        this._request(this._baseOf(axis, e.key), PIPELINE_PRIORITY.DOCUMENT);
        this._counts.standIn++;
        return this._get(si);
      }
    }
    // HOLD: the exact key through the on-demand path (marks waitingDraws); BASE queued as the next fallback
    this._counts.held++;
    this._request(this._baseOf(axis, e.key), PIPELINE_PRIORITY.DOCUMENT);
    this._request(e, PIPELINE_PRIORITY.NOW);
    if (o.slowCompileMs > 0 && e.h.ready) return null;   // simulated slow compile: compiled, treated as pending
    const p = this._get(e);   // in a live frame: null (the draw is skipped; marks waitingDraws, redraws when it lands)
    if (p) this._drawnExact(e);
    return p;
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

  /** Queue the `*-BASE` family of `axis` for a layout + global bits `g` (the fallback of the next new key there). */
  warmBase(axis: MeshFsAxis, tex: boolean, g: number, priority: PipelinePriority = PIPELINE_PRIORITY.DOCUMENT): void {
    this._request(this.entry(axis, meshFsBaseKey(tex, (g & MESH_FS_G_SHADOW) !== 0, (g & MESH_FS_G_DEBUG) !== 0, (g & MESH_FS_G_SSR_INLINE) !== 0)), priority);
  }

  // ── The seen-keys journal ────────────────────────────────────────────────────────────────────────────────────

  private _drawnExact(e: Entry): void {
    this._counts.exact++;
    if (e.drawn) return;
    e.drawn = true;
    const k = e.key;
    if (k.debug || k.ssrInline || k.lean || k.f16 || this.opts.bisect !== 'none') return;
    const j = this._journalLoad();
    const id = `${e.axis}:${e.ks}`;
    const i = j.indexOf(id);
    if (i >= 0) j.splice(i, 1);
    j.push(id);
    if (j.length > MeshFsPipelines.journalMax) j.splice(0, j.length - MeshFsPipelines.journalMax);
    if (this._journalSave === null && typeof setTimeout === 'function') {
      this._journalSave = setTimeout(() => { this._journalSave = null; this._journalStore(); }, 2000);
    }
  }

  private _journalLoad(): string[] {
    if (this._journal) return this._journal;
    this._journal = [];
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SHADER_SPLIT_JOURNAL_KEY) : null;
      const v = raw ? JSON.parse(raw) as { v?: number; keys?: unknown } : null;
      if (v && v.v === SHADER_SPLIT_JOURNAL_VERSION && Array.isArray(v.keys)) this._journal = v.keys.filter((x): x is string => typeof x === 'string').slice(-MeshFsPipelines.journalMax);
    } catch { /* storage blocked / malformed: start empty */ }
    return this._journal;
  }

  private _journalStore(): void {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(SHADER_SPLIT_JOURNAL_KEY, JSON.stringify({ v: SHADER_SPLIT_JOURNAL_VERSION, keys: this._journalLoad() }));
    } catch { /* storage blocked: this session only */ }
  }

  /** The journalled (axis, key) pairs (valid entries only, oldest first). */
  journal(): { axis: MeshFsAxis; key: MeshFsKey }[] {
    const out: { axis: MeshFsAxis; key: MeshFsKey }[] = [];
    for (const id of this._journalLoad()) {
      const c = id.indexOf(':');
      const axis = id.slice(0, c) as MeshFsAxis, key = meshFsKeyParse(id.slice(c + 1));
      if (c > 0 && key && MESH_FS_AXES.includes(axis) && !(axis.startsWith('skinned') && key.shadow)) out.push({ axis, key });
    }
    return out;
  }

  /** Boot: queue every journalled key at `priority` (newest first). Returns how many were queued. */
  warmJournal(priority: PipelinePriority = PIPELINE_PRIORITY.COMMON): number {
    const j = this.journal().reverse();
    for (const { axis, key } of j) this.warm(axis, key, priority);
    return j.length;
  }

  /** Forget the journal (memory + storage). */
  clearJournal(): void {
    this._journal = [];
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(SHADER_SPLIT_JOURNAL_KEY); } catch { /* blocked */ }
  }

  /** Every compiled pipeline with its descriptor (P22 packed twins). */
  compiled(): { p: GPURenderPipeline; desc: GPURenderPipelineDescriptor }[] {
    const out: { p: GPURenderPipeline; desc: GPURenderPipelineDescriptor }[] = [];
    for (const e of this._list) { const p = e.h.ready ? e.h.get() : null; if (p) out.push({ p, desc: e.h.descriptor() }); }
    return out;
  }

  /** Forget the hot-path memo (the bisect mode or the cap changed: packed keys map to other entries). */
  remap(): void { for (const m of this._byNum) m.clear(); this._gen++; }

  resetCounters(): void { this._counts = { exact: 0, fallback: 0, standIn: 0, held: 0 }; }

  stats(): MeshFsSplitStats {
    let ready = 0, pending = 0, failed = 0;
    const list = this._list.map((e) => {
      const r = this._ready(e);
      if (r) ready++; else if (e.h.failed) failed++; else if (e.requested || e.h.pending) pending++;
      return { axis: e.axis, key: e.ks, ready: r, bytes: e.bytes, lines: meshFsSize(generateMeshFs(e.key)).lines, ms: Math.round(e.ms) };
    });
    return { keys: this._keyStrs.size, pipelines: this._list.length, ready, pending, failed, maxKeys: MeshFsPipelines.maxKeys, exactKeys: this._exactKeys.size, ...this._counts, widened: this._widened, list };
  }
}
