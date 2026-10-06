/**
 * GPU capability tier + caps (docs/specs/mobile-parity.md CRASH-8 / CRASH-3 / TIER-1; docs/ui/gpu-diagnostics.md).
 *
 * PURE: every input is passed in (no navigator / localStorage / window here; gpu-diagnostics.ts reads the
 * environment). The caps are a PER-MACHINE layer: they clamp what the renderer may do on this device and never
 * rewrite a document setting, so a document stays portable between a tablet and a desktop.
 *
 *  - detectGpuTier()      — 'desktop' | 'mobile' | 'safe' from the adapter info, the UA, the pointer, deviceMemory and
 *                           the overrides (?salsaSafe=1, salsa.gpu.safeMode, salsa.gpu.tier);
 *  - capsForTier()        — the caps of a tier; resolveGpuCaps() also folds in what the device can do;
 *  - noteDeviceLoss()     — the crash-loop guard (2 losses within 60 s → safe mode);
 *  - computeCanvasBacking() — the DPR / max-pixel cap of the main canvas;
 *  - clampTextureExtent() — fit a texture into maxTextureDimension2D.
 *
 * 'desktop' caps EQUAL the engine defaults from before this module existed (no behaviour change on desktop).
 */

export type GpuTier = 'desktop' | 'mobile' | 'safe';

export interface GpuCaps {
  /** P15 GPU-driven culling + indirect draws may run (Renderer3D.gpuDriven still decides; false forces the CPU path). */
  gpuDriven: boolean;
  /** P21 specialised shader variants may compile (false = every mesh on the uber-shader). */
  shaderVariants: boolean;
  /** LiveText may use the HTML-in-canvas capture (false = mode 'none', the OffscreenCanvas fallback, no WebGL probe). */
  htmlInCanvas: boolean;
  /** Max device-pixel ratio of the main canvas backing store (Infinity = the window's DPR, uncapped). */
  maxDpr: number;
  /** Max backing-store pixels (width × height) of the main canvas (Infinity = uncapped). */
  maxCanvasPixels: number;
  /** Concurrent background pipeline compiles (GPUPipelineCache.maxConcurrentWarm). */
  warmConcurrency: number;
  /** Shadow-map passes may run (false = suspended: the map is cleared once to "lit", no depth passes). */
  shadows: boolean;
  /** SSAO may run (false = treated as off; the document keeps its setting). */
  ssao: boolean;
  /** SSR may run (false = treated as off; the document keeps its setting). */
  ssr: boolean;
  /** Temporal AA may run (false = treated as mode 'off'; the per-machine TAA preference is kept). */
  taa: boolean;
}

/** Today's engine defaults: desktop behaviour is unchanged. */
export const DESKTOP_CAPS: Readonly<GpuCaps> = Object.freeze({
  gpuDriven: true, shaderVariants: true, htmlInCanvas: true,
  maxDpr: Infinity, maxCanvasPixels: Infinity, warmConcurrency: 2,
  shadows: true, ssao: true, ssr: true, taa: true,
});

/** Phones / tablets: the CPU draw path, the uber-shader only, no HTML-in-canvas, DPR ≤ 1.5 and ≤ 2.5 MP, one compile at a time. */
export const MOBILE_CAPS: Readonly<GpuCaps> = Object.freeze({
  ...DESKTOP_CAPS,
  gpuDriven: false, shaderVariants: false, htmlInCanvas: false,
  maxDpr: 1.5, maxCanvasPixels: 2_500_000, warmConcurrency: 1,
});

/** Safe mode (crash loop / ?salsaSafe=1): the mobile caps plus shadows / SSAO / SSR / TAA off. */
export const SAFE_CAPS: Readonly<GpuCaps> = Object.freeze({
  ...MOBILE_CAPS,
  shadows: false, ssao: false, ssr: false, taa: false,
});

/** JSON for logs / localStorage: Infinity (uncapped) is written as "none" (plain JSON would turn it into null). */
export function gpuJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x === Infinity ? 'none' : x));
}

export function capsForTier(tier: GpuTier): GpuCaps {
  return { ...(tier === 'safe' ? SAFE_CAPS : tier === 'mobile' ? MOBILE_CAPS : DESKTOP_CAPS) };
}

export interface GpuDeviceFacts {
  /** The device was created with 'indirect-first-instance' (the GPU-driven bundles draw with firstInstance). */
  indirectFirstInstance: boolean;
}

/** The caps of `tier`, minus what the device cannot do. */
export function resolveGpuCaps(tier: GpuTier, dev?: Partial<GpuDeviceFacts>): GpuCaps {
  const c = capsForTier(tier);
  if (dev && dev.indirectFirstInstance === false) c.gpuDriven = false;
  return c;
}

export interface GpuTierInputs {
  /** adapter.info.vendor / architecture / description (any may be empty: browsers can hide them). */
  vendor?: string | null;
  architecture?: string | null;
  description?: string | null;
  /** navigator.userAgentData?.mobile (false on Android TABLETS; the UA catches those). */
  uaMobile?: boolean | null;
  /** navigator.userAgent. */
  userAgent?: string | null;
  /** matchMedia('(pointer:coarse)').matches — the PRIMARY pointer is a finger. */
  coarsePointer?: boolean | null;
  /** matchMedia('(any-pointer:fine)').matches — some pointer (mouse / trackpad / stylus) is fine. */
  anyFinePointer?: boolean | null;
  /** navigator.maxTouchPoints (an iPad reports a desktop "Macintosh" UA). */
  maxTouchPoints?: number | null;
  /** navigator.deviceMemory (GB, capped at 8 by browsers). */
  deviceMemory?: number | null;
  /** localStorage 'salsa.gpu.tier' ('mobile' | 'desktop' | 'safe'; anything else = auto). */
  tierOverride?: string | null;
  /** localStorage 'salsa.gpu.safeMode' is set (the crash-loop guard tripped earlier). */
  safeModeStored?: boolean | null;
  /** ?salsaSafe=1 in the page URL. */
  safeQuery?: boolean | null;
  /** The crash-loop guard tripped in THIS session (storage may be unavailable). */
  safeSession?: boolean | null;
}

export interface GpuTierResult { tier: GpuTier; reasons: string[] }

/** Mobile GPU vendors (adapter.info.vendor). Chrome reports Imagination as 'img-tec'. */
export const MOBILE_GPU_VENDOR_RE = /qualcomm|\barm\b|imagination|img-tec|samsung|mediatek/i;
/** Mobile GPU families (adapter.info.architecture / description). */
export const MOBILE_GPU_ARCH_RE = /adreno|mali|valhall|bifrost|midgard|powervr|xclipse/i;

/**
 * The tier. Precedence: ?salsaSafe=1 / a stored or session safe mode → 'safe'; then the 'salsa.gpu.tier' override;
 * then detection: a mobile GPU, a mobile / Android UA, an iPad (Mac UA + touch), a touch-only device (coarse primary
 * pointer and no fine pointer), or ≤ 2 GB device memory → 'mobile'; else 'desktop'.
 */
export function detectGpuTier(i: GpuTierInputs): GpuTierResult {
  if (i.safeQuery) return { tier: 'safe', reasons: ['?salsaSafe=1'] };
  if (i.safeSession) return { tier: 'safe', reasons: ['crash-loop guard (this session)'] };
  if (i.safeModeStored) return { tier: 'safe', reasons: ['salsa.gpu.safeMode'] };
  const o = (i.tierOverride ?? '').trim().toLowerCase();
  if (o === 'safe' || o === 'mobile' || o === 'desktop') return { tier: o, reasons: [`salsa.gpu.tier=${o}`] };
  const reasons: string[] = [];
  const vendor = i.vendor ?? '', arch = `${i.architecture ?? ''} ${i.description ?? ''}`;
  if (vendor && MOBILE_GPU_VENDOR_RE.test(vendor)) reasons.push(`gpu vendor ${vendor}`);
  if (MOBILE_GPU_ARCH_RE.test(arch)) reasons.push(`gpu ${arch.trim()}`);
  const ua = i.userAgent ?? '';
  if (i.uaMobile === true) reasons.push('userAgentData.mobile');
  if (/android/i.test(ua)) reasons.push('Android UA');
  else if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && (i.maxTouchPoints ?? 0) > 1)) reasons.push('iOS / iPadOS');
  if (i.coarsePointer === true && i.anyFinePointer !== true) reasons.push('touch-only pointer');
  if (typeof i.deviceMemory === 'number' && i.deviceMemory > 0 && i.deviceMemory <= 2) reasons.push(`deviceMemory ${i.deviceMemory} GB`);
  return reasons.length ? { tier: 'mobile', reasons } : { tier: 'desktop', reasons: ['no mobile signal'] };
}

// ── Crash-loop guard (CRASH-3) ─────────────────────────────────────────────────────────────────────────────────

export interface LossGuardOptions { windowMs: number; threshold: number }
export const LOSS_GUARD_DEFAULTS: Readonly<LossGuardOptions> = Object.freeze({ windowMs: 60_000, threshold: 2 });

/** Record a device loss at `now`: the loss times still inside the window (newest last) and whether the guard trips
 *  (≥ threshold losses within windowMs). Garbage in `history` (non-numbers, future times) is dropped. */
export function noteDeviceLoss(history: ReadonlyArray<unknown>, now: number, opts: LossGuardOptions = LOSS_GUARD_DEFAULTS): { history: number[]; tripped: boolean } {
  const kept = history.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t <= now && now - t < opts.windowMs);
  kept.push(now);
  const out = kept.slice(-Math.max(1, opts.threshold * 4));
  return { history: out, tripped: out.length >= opts.threshold };
}

// ── Canvas backing store (TIER-1) ──────────────────────────────────────────────────────────────────────────────

/**
 * The main canvas backing size for a CSS box of cssW × cssH at the window's DPR, under the caps. The DPR is
 * max(1, dpr) clamped to maxDpr, then lowered so width × height ≤ maxPixels. With the desktop caps (Infinity) this is
 * exactly the old `floor(css × max(1, dpr))`.
 */
export function computeCanvasBacking(cssW: number, cssH: number, dpr: number, caps: Pick<GpuCaps, 'maxDpr' | 'maxCanvasPixels'>): { width: number; height: number; dpr: number } {
  let d = Math.max(1, Number.isFinite(dpr) && dpr > 0 ? dpr : 1);
  if (Number.isFinite(caps.maxDpr) && caps.maxDpr > 0) d = Math.min(d, Math.max(caps.maxDpr, 0.25));
  const w = Math.max(0, cssW), h = Math.max(0, cssH);
  if (Number.isFinite(caps.maxCanvasPixels) && caps.maxCanvasPixels > 0 && w > 0 && h > 0 && w * h * d * d > caps.maxCanvasPixels) {
    d = Math.sqrt(caps.maxCanvasPixels / (w * h));
  }
  return { width: Math.floor(w * d), height: Math.floor(h * d), dpr: d };
}

/** Scale w × h down (aspect kept) so neither side exceeds `maxDim`; `scale` is the factor applied (1 = unchanged). */
export function clampTextureExtent(w: number, h: number, maxDim: number): { width: number; height: number; scale: number } {
  const W = Math.max(1, Math.ceil(w)), H = Math.max(1, Math.ceil(h));
  const m = Number.isFinite(maxDim) && maxDim >= 1 ? Math.floor(maxDim) : Infinity;
  if (W <= m && H <= m) return { width: W, height: H, scale: 1 };
  const s = Math.min(m / W, m / H);
  return { width: Math.max(1, Math.min(m, Math.floor(W * s))), height: Math.max(1, Math.min(m, Math.floor(H * s))), scale: s };
}
