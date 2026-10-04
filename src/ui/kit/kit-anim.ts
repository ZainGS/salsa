/**
 * src/ui/kit/kit-anim.ts
 *
 * Pure animation curves for the UI kit: overshoot / spring easings, the widget INTRO transforms (slide with
 * overshoot, pop, punch, drop, spin) and the one-shot CLIPS a playAnimation action can play on a widget (shake,
 * wobble, pulse…). Everything is a function of elapsed UI-time ms, so a frame sequence is reproducible and the
 * unit tests need no clock.
 */

import type { UIKitIntro, UIKitClip } from './kit-types';

/** A widget animation transform, in DESIGN px / radians, applied about the widget centre. */
export interface KitXf { dx: number; dy: number; scale: number; rot: number; alpha: number; }
export const KIT_XF_IDENTITY: Readonly<KitXf> = Object.freeze({ dx: 0, dy: 0, scale: 1, rot: 0, alpha: 1 });

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t: number): number => { const x = clamp01(t); return x * x * x; };
export const easeInOutCubic = (t: number): number => { const x = clamp01(t); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
/** Overshoots past 1 then settles (back-out). */
export function easeOutBack(t: number, s = 1.9): number { const x = clamp01(t) - 1; return 1 + (s + 1) * x * x * x + s * x * x; }
/** Damped spring 0 → 1 with `bounces` visible overshoots: the "snap" of a selection highlight. */
export function springSnap(t: number, bounces = 1.6, damping = 5.5): number {
  const x = clamp01(t);
  if (x >= 1) return 1;
  return 1 - Math.exp(-damping * x) * Math.cos(bounces * Math.PI * 2 * x);
}
/** Damped sine 1 → 0 (wobble / shake envelope). */
export const dampedSine = (t: number, freq: number, damping: number): number => Math.exp(-damping * t) * Math.sin(freq * Math.PI * 2 * t);

export const DEFAULT_INTRO_MS: Record<UIKitIntro['type'], number> = { none: 0, slide: 420, pop: 360, punch: 420, drop: 520, spin: 480 };
const CLIP_MS: Record<UIKitClip, number> = { intro: 0, slide: 420, pop: 360, punch: 420, drop: 520, spin: 480, shake: 380, wobble: 600, pulse: 420 };

/** Duration of a clip / intro in ms (intro = the widget's own intro length). */
export function kitClipDuration(clip: UIKitClip | UIKitIntro['type'], intro?: UIKitIntro): number {
  if (clip === 'intro') return (intro?.durationMs ?? DEFAULT_INTRO_MS[intro?.type ?? 'none']) + (intro?.delayMs ?? 0);
  return (CLIP_MS as Record<string, number>)[clip] ?? DEFAULT_INTRO_MS[clip as UIKitIntro['type']] ?? 0;
}

/** Transform of an intro `elapsedMs` after it started (before its delay → hidden; after its end → identity). */
export function introXf(intro: UIKitIntro | undefined, elapsedMs: number): KitXf {
  if (!intro || intro.type === 'none') return { ...KIT_XF_IDENTITY };
  const delay = intro.delayMs ?? 0, dur = Math.max(1, intro.durationMs ?? DEFAULT_INTRO_MS[intro.type]);
  const e = elapsedMs - delay;
  if (e < 0) return { dx: 0, dy: 0, scale: 1, rot: 0, alpha: 0 };
  const t = clamp01(e / dur);
  if (t >= 1) return { ...KIT_XF_IDENTITY };
  const fade = clamp01(t * 4);
  switch (intro.type) {
    case 'slide': {
      const d = intro.dir ?? 'left', dist = 1100;
      const k = 1 - easeOutBack(t, 1.7);
      const sx = d === 'left' ? -1 : d === 'right' ? 1 : 0, sy = d === 'up' ? -1 : d === 'down' ? 1 : 0;
      return { dx: sx * dist * k, dy: sy * dist * 0.6 * k, scale: 1, rot: -sx * 0.06 * k, alpha: fade };
    }
    case 'pop': return { dx: 0, dy: 0, scale: Math.max(0, easeOutBack(t, 2.6)), rot: 0, alpha: fade };
    case 'punch': {
      const s = 1 + 0.75 * (1 - springSnap(t, 1.4, 6));
      return { dx: 0, dy: 0, scale: s, rot: -0.05 * dampedSine(t, 2.2, 5), alpha: clamp01(t * 8) };
    }
    case 'drop': {
      // fall from above with two bounces
      const fall = 1 - springSnap(t, 1.2, 4.5);
      return { dx: 0, dy: -520 * fall, scale: 1, rot: 0.04 * dampedSine(t, 2, 4), alpha: fade };
    }
    case 'spin': return { dx: 0, dy: 0, scale: 0.3 + 0.7 * easeOutBack(t, 1.4), rot: -Math.PI * 0.6 * (1 - easeOutCubic(t)), alpha: fade };
  }
  return { ...KIT_XF_IDENTITY };
}

/** Transform of a one-shot clip `elapsedMs` in (identity once done). */
export function clipXf(clip: UIKitClip, elapsedMs: number, intro?: UIKitIntro): KitXf {
  if (clip === 'intro') return introXf(intro, elapsedMs);
  if (clip === 'slide' || clip === 'pop' || clip === 'punch' || clip === 'drop' || clip === 'spin') return introXf({ type: clip, dir: intro?.dir }, elapsedMs);
  const dur = CLIP_MS[clip];
  const t = clamp01(elapsedMs / dur);
  if (t >= 1) return { ...KIT_XF_IDENTITY };
  switch (clip) {
    case 'shake': {
      const env = 1 - t;
      return { dx: 22 * env * Math.sin(elapsedMs * 0.11), dy: 14 * env * Math.sin(elapsedMs * 0.157 + 1.3), scale: 1, rot: 0.02 * env * Math.sin(elapsedMs * 0.09), alpha: 1 };
    }
    case 'wobble': return { dx: 0, dy: 0, scale: 1, rot: 0.16 * dampedSine(t, 3, 4), alpha: 1 };
    case 'pulse': return { dx: 0, dy: 0, scale: 1 + 0.14 * Math.sin(Math.PI * t), rot: 0, alpha: 1 };
  }
  return { ...KIT_XF_IDENTITY };
}

/** Compose two transforms (b applied on top of a). */
export function composeXf(a: KitXf, b: KitXf): KitXf {
  return { dx: a.dx + b.dx, dy: a.dy + b.dy, scale: a.scale * b.scale, rot: a.rot + b.rot, alpha: a.alpha * b.alpha };
}

/** Deterministic RNG (mulberry32) — layouts must be stable frame to frame. */
export function kitRng(seed: number): () => number {
  let a = (Math.floor(seed) * 2654435761) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
