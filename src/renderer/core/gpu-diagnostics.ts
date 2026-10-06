/**
 * GPU crash diagnostics (docs/specs/mobile-parity.md CRASH-10 / CRASH-3 / CRASH-9; docs/ui/gpu-diagnostics.md).
 *
 * The runtime half of gpu-capabilities.ts: it reads the environment (navigator, matchMedia, localStorage, the URL)
 * and keeps the session's breadcrumbs, uncaptured GPU errors and loss history. Everything that must survive a GPU
 * process crash or a reload is written to localStorage (per machine, never into a document):
 *  - 'salsa.gpu.lastLoss'  — the last device loss: reason, message, adapter, tier, caps, breadcrumbs, open compiles;
 *  - 'salsa.gpu.crumbs'    — the newest breadcrumbs (throttled), so a tab that died without a loss event still tells;
 *  - 'salsa.gpu.lossTimes' — recent loss times (the crash-loop guard counts across reloads);
 *  - 'salsa.gpu.safeMode'  — set when the guard trips (cleared by ?salsaSafe=0 or removing the key).
 * 'salsa.gpu.tier' is only READ here (a manual override).
 *
 * Never throws: storage can be missing, full or blocked.
 */

import { detectGpuTier, noteDeviceLoss, gpuJson, LOSS_GUARD_DEFAULTS, type GpuTierInputs, type GpuTierResult, type GpuCaps, type GpuTier } from './gpu-capabilities';

export const GPU_KEYS = Object.freeze({
  tier: 'salsa.gpu.tier',
  safeMode: 'salsa.gpu.safeMode',
  lastLoss: 'salsa.gpu.lastLoss',
  crumbs: 'salsa.gpu.crumbs',
  lossTimes: 'salsa.gpu.lossTimes',
});

export interface GpuAdapterFacts { vendor: string; architecture: string; device: string; description: string }

export interface GpuCrumb { t: number; what: string; n?: number }
export interface GpuErrorRecord { t: number; kind: string; message: string; n?: number }

export interface GpuLossRecord {
  at: number;
  /** ISO time (readable when copied off the tablet). */
  when: string;
  reason: string;
  message: string;
  adapter: GpuAdapterFacts | null;
  tier: GpuTier | null;
  caps: GpuCaps | null;
  /** Compiles / dispatches that STARTED but never ENDED: the prime suspects. */
  open: string[];
  breadcrumbs: GpuCrumb[];
  errors: GpuErrorRecord[];
  /** The crash-loop guard tripped on this loss (the next device uses the safe caps). */
  safeModeTripped: boolean;
}

// ── Storage (never throws) ─────────────────────────────────────────────────────────────────────────────────────

export interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

let _storeOverride: KeyValueStore | null | undefined;
/** TEST HOOK: use `s` instead of localStorage (undefined = back to localStorage). */
export function setGpuDiagnosticsStore(s: KeyValueStore | null | undefined): void { _storeOverride = s; }
function store(): KeyValueStore | null {
  if (_storeOverride !== undefined) return _storeOverride;
  try { return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null; } catch { return null; }
}
function sget(k: string): string | null { try { return store()?.getItem(k) ?? null; } catch { return null; } }
function sset(k: string, v: string): void { try { store()?.setItem(k, v); } catch { /* full / blocked */ } }
function sdel(k: string): void { try { store()?.removeItem(k); } catch { /* blocked */ } }
function sjson<T>(k: string): T | null { const raw = sget(k); if (!raw) return null; try { return JSON.parse(raw) as T; } catch { return null; } }

// ── Breadcrumbs ────────────────────────────────────────────────────────────────────────────────────────────────

const CRUMB_MAX = 40;
const ERROR_MAX = 20;
const _crumbs: GpuCrumb[] = [];
const _errors: GpuErrorRecord[] = [];
const _open = new Map<number, string>();
let _openSeq = 0;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _sessionSafe = false;

function now(): number { return Date.now(); }

function pushCoalesced<T extends { t: number; n?: number }>(list: T[], max: number, rec: T, same: (a: T) => boolean): void {
  const last = list[list.length - 1];
  if (last && same(last)) { last.n = (last.n ?? 1) + 1; last.t = rec.t; return; }
  list.push(rec);
  if (list.length > max) list.splice(0, list.length - max);
}

type PersistedCrumbs = { at: number; crumbs: GpuCrumb[]; open: string[] };
let _prevSession: PersistedCrumbs | null | undefined;
/** The previous page load's persisted crumbs, captured BEFORE this session first overwrites them. */
function capturePrevSession(): PersistedCrumbs | null {
  if (_prevSession === undefined) _prevSession = sjson<PersistedCrumbs>(GPU_KEYS.crumbs);
  return _prevSession;
}

function schedulePersistCrumbs(): void {
  if (_persistTimer !== null) return;
  capturePrevSession();
  try {
    _persistTimer = setTimeout(() => {
      _persistTimer = null;
      sset(GPU_KEYS.crumbs, JSON.stringify({ at: now(), crumbs: _crumbs.slice(-20), open: [..._open.values()] }));
    }, 500);
  } catch { _persistTimer = null; }
}

/** Record a breadcrumb (a repeat of the last one only bumps its count, so per-frame callers don't flood the ring). */
export function gpuCrumb(what: string): void {
  pushCoalesced(_crumbs, CRUMB_MAX, { t: now(), what }, (a) => a.what === what);
  schedulePersistCrumbs();
}

/** Start of a GPU operation that may hang or crash (a pipeline compile, a first dispatch). Returns the token for
 *  gpuCrumbEnd. An operation still open at a device loss is listed in lastLoss.open. */
export function gpuCrumbBegin(what: string): number {
  const id = ++_openSeq;
  _open.set(id, what);
  if (_open.size > 64) { const first = _open.keys().next().value; if (first !== undefined) _open.delete(first); }
  gpuCrumb(`${what} start`);
  return id;
}

/** End of an operation started with gpuCrumbBegin (`ok` false = it failed / was rejected). */
export function gpuCrumbEnd(id: number, ok = true): void {
  const what = _open.get(id);
  if (what === undefined) return;
  _open.delete(id);
  gpuCrumb(`${what} ${ok ? 'end' : 'FAILED'}`);
}

export function getGpuCrumbs(): GpuCrumb[] { return _crumbs.map((c) => ({ ...c })); }
export function getOpenGpuOps(): string[] { return [..._open.values()]; }

/** An uncaptured GPU error (GPUValidationError / GPUOutOfMemoryError / GPUInternalError). Returns true the first
 *  time a given message is seen (the caller logs only then). */
export function recordGpuError(kind: string, message: string): boolean {
  const msg = String(message ?? '').slice(0, 600);
  const seen = _errors.some((e) => e.kind === kind && e.message === msg);
  pushCoalesced(_errors, ERROR_MAX, { t: now(), kind, message: msg }, (a) => a.kind === kind && a.message === msg);
  gpuCrumb(`uncaptured ${kind}`);
  return !seen;
}
export function getGpuErrors(): GpuErrorRecord[] { return _errors.map((e) => ({ ...e })); }

// ── Environment → tier ─────────────────────────────────────────────────────────────────────────────────────────

/** Read the tier inputs from the browser (adapter facts from the caller). Handles ?salsaSafe=1 / =0 (0 clears the
 *  stored safe mode). */
export function readGpuTierInputs(adapter: GpuAdapterFacts | null): GpuTierInputs {
  const g = globalThis as unknown as {
    navigator?: Navigator & { userAgentData?: { mobile?: boolean }; deviceMemory?: number };
    matchMedia?: (q: string) => { matches: boolean };
    location?: { search?: string };
  };
  const nav = g.navigator;
  const mm = (q: string): boolean | null => { try { return typeof g.matchMedia === 'function' ? g.matchMedia(q).matches : null; } catch { return null; } };
  let safeQuery: boolean | null = null;
  try {
    const q = new URLSearchParams(g.location?.search ?? '').get('salsaSafe');
    if (q === '1' || q === 'true') safeQuery = true;
    else if (q === '0' || q === 'false') { sdel(GPU_KEYS.safeMode); sdel(GPU_KEYS.lossTimes); _sessionSafe = false; }
  } catch { /* no URL */ }
  return {
    vendor: adapter?.vendor ?? null,
    architecture: adapter?.architecture ?? null,
    description: [adapter?.description, adapter?.device].filter(Boolean).join(' ') || null,
    uaMobile: nav?.userAgentData?.mobile ?? null,
    userAgent: nav?.userAgent ?? null,
    coarsePointer: mm('(pointer: coarse)'),
    anyFinePointer: mm('(any-pointer: fine)'),
    maxTouchPoints: nav?.maxTouchPoints ?? null,
    deviceMemory: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null,
    tierOverride: sget(GPU_KEYS.tier),
    safeModeStored: !!sget(GPU_KEYS.safeMode),
    safeQuery,
    safeSession: _sessionSafe,
  };
}

/** The tier of this machine right now (adapter facts + environment). */
export function detectGpuTierNow(adapter: GpuAdapterFacts | null): GpuTierResult & { inputs: GpuTierInputs } {
  const inputs = readGpuTierInputs(adapter);
  return { ...detectGpuTier(inputs), inputs };
}

// ── Crash-loop guard + loss record ─────────────────────────────────────────────────────────────────────────────

/** A device loss: run the crash-loop guard (persisted loss times; ≥ 2 within 60 s → safe mode, stored + this
 *  session) and write 'salsa.gpu.lastLoss'. Returns the record. */
export function recordGpuDeviceLoss(reason: string, message: string, ctx: { adapter: GpuAdapterFacts | null; tier: GpuTier | null; caps: GpuCaps | null }): GpuLossRecord {
  const t = now();
  const prev = sjson<unknown[]>(GPU_KEYS.lossTimes);
  const g = noteDeviceLoss(Array.isArray(prev) ? prev : [], t, LOSS_GUARD_DEFAULTS);
  sset(GPU_KEYS.lossTimes, JSON.stringify(g.history));
  const tripped = g.tripped && ctx.tier !== 'safe';
  if (g.tripped) { _sessionSafe = true; sset(GPU_KEYS.safeMode, JSON.stringify({ at: t, losses: g.history.length })); }
  gpuCrumb(`device lost (${reason})`);
  const rec: GpuLossRecord = {
    at: t, when: new Date(t).toISOString(), reason, message: String(message ?? '').slice(0, 1000),
    adapter: ctx.adapter, tier: ctx.tier, caps: ctx.caps,
    open: getOpenGpuOps(), breadcrumbs: getGpuCrumbs().slice(-30), errors: getGpuErrors().slice(-10),
    safeModeTripped: tripped,
  };
  sset(GPU_KEYS.lastLoss, gpuJson(rec));
  return rec;
}

export function readLastGpuLoss(): GpuLossRecord | null { return sjson<GpuLossRecord>(GPU_KEYS.lastLoss); }
/** The breadcrumbs persisted by the PREVIOUS page load (read once at start-up, before this session overwrites them). */
export function readPersistedGpuCrumbs(): PersistedCrumbs | null { return capturePrevSession(); }

/** Safe mode on (stored + this session) or off (both cleared, with the loss history). */
export function setGpuSafeModeStored(on: boolean): void {
  _sessionSafe = on;
  if (on) sset(GPU_KEYS.safeMode, JSON.stringify({ at: now(), manual: true }));
  else { sdel(GPU_KEYS.safeMode); sdel(GPU_KEYS.lossTimes); }
}
export function isGpuSafeModeStored(): boolean { return _sessionSafe || !!sget(GPU_KEYS.safeMode); }

/** TEST HOOK: forget the session state (crumbs, errors, open ops, session safe mode). */
export function resetGpuDiagnosticsForTests(): void {
  _crumbs.length = 0; _errors.length = 0; _open.clear(); _openSeq = 0; _sessionSafe = false; _prevSession = undefined;
  if (_persistTimer !== null) { clearTimeout(_persistTimer); _persistTimer = null; }
}
