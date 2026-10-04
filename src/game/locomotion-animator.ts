/**
 * LocomotionAnimator — the Play-mode avatar animation state machine (R6.2, rebuilt Round 8; docs/ui/play-mode.md
 * §Engine locomotion state machine).
 *
 * States: idle · move · jump · fall, plus two continuous mixes and one additive layer:
 *  - `move` is a speed-driven blend of walk ⇄ run (runMix, from the controller's walk / run speeds) and, on top, the
 *    CROUCH mix (0 = standing, 1 = sneaking; eased, so entering / leaving the sneak is a smooth dip, never a snap) that
 *    fades walk / run into the sneak gait and the idle into the crouch idle. One shared, normalized gait phase keeps the
 *    feet in step through every blend (all gait clips put the left heel strike at phase 0).
 *  - STRIDE MATCHING: the gait phase advances at speed / (the blended clips' distance per cycle), so a planted foot
 *    stays planted at any speed (clips from default-locomotion.ts carry their ground speed; others use the controller
 *    gait speeds). Clamped to [minRate, maxRate] of the clip's own cadence.
 *  - `jump` samples the Jump clip by the controller's AIR PHASE (0 take-off → 0.5 apex → 1 falling) when the state
 *    carries it, else by time; `fall` loops once a fall has lasted fallAfter seconds. A walk off a small drop does not
 *    flicker into the air pose (airDelay).
 *  - LAND: an additive squash-and-recover layer (weight = the landing impact, lighter while moving) on touch-down, so
 *    landing blends into whatever the ground state is doing instead of a stop-and-go.
 * Every state change CROSSFADES (inertial: the entered state's weight ramps up while the others scale down, sum 1).
 *
 * Pure: it returns weighted LAYERS { clip, phase, weight, additive? } each tick; the host samples each clip at its phase
 * against the rig's REST pose, blends the normal layers (weights sum to 1) and adds the additive ones on top.
 */

import type { LocomotionClips, LocomotionState } from './locomotion';
import { expSmooth } from './collision-math';

export type LocoAnimState = 'idle' | 'move' | 'jump' | 'fall';

export interface LocomotionAnimConfig {
  /** Speed (world units/s) at which `walk` is fully weighted — the controller's walk speed. */
  walkSpeed: number;
  /** Speed at which `run` is fully weighted — the controller's run speed. */
  runSpeed: number;
  /** Ground speed the walk / run / sneak clips are planted for at rate 1 (world units/s). null = the blend points
   *  (walkSpeed / runSpeed / walkSpeed × 0.6). */
  walkClipSpeed: number | null;
  runClipSpeed: number | null;
  sneakClipSpeed: number | null;
  /** Crossfade times (seconds). */
  startFade: number;   // idle → move
  stopFade: number;    // move → idle
  airFade: number;     // ground → jump / fall
  landFade: number;    // jump / fall → ground
  /** 1/s rate of the crouch (sneak) mix. */
  crouchRate: number;
  /** Enter `move` above this fraction of walkSpeed; leave it below stopThreshold (hysteresis, no flicker at the edge). */
  moveThreshold: number;
  stopThreshold: number;
  /** 1/s smoothing of the speed the blend reads. */
  speedSmoothing: number;
  /** Gait playback-rate clamp (× the clip's own cadence). */
  minRate: number;
  maxRate: number;
  /** Widen the rate clamp to include the rates that plant the walk / run clips at their blend points (a scaled avatar's
   *  slow / quick cadence keeps planted feet). false = the fixed clamp (the pre-2026-10-04 behaviour). */
  scaleRateClamp: boolean;
  /** Seconds airborne before a walk off a ledge shows the air pose (a jump shows it at once). */
  airDelay: number;
  /** Seconds airborne (descending) before the fall loop takes over. */
  fallAfter: number;
  /** Landing layer: weight per unit impact, minimum impact that plays it, and how much moving lightens it. */
  landGain: number;
  landMin: number;
  landMoving: number;
  /** Item 13 — the jump WIND-UP (the controller's jumpWindup): the Jump clip's phase at which it takes off (its crouch
   *  plays over [0, jumpTakeoff) during the wind-up, the air over [jumpTakeoff, 1] by air phase; the default Jump clip
   *  records it as `takeoffPhase`; 0 = a clip without one: the wind-up holds its first frame, the air maps as before),
   *  and the crossfade into the wind-up (short: the crouch only lasts ~60 ms). */
  jumpTakeoff: number;
  windupFade: number;
  /** The wind-up crossfade when the jump starts from the GAIT (a clip with a wind-up, the runtime jumps): about the
   *  wind-up's length, so the crouch blends out of the stride instead of popping through the clip's standing frame. */
  windupMoveFade: number;
  /** Jump VARIETY (clips.jumps with ≥ 2 clips): pick one per jump (off = always clips.jump), the RNG seed (seeded so a
   *  replay / test is deterministic), the air phase up to which a released button still counts as a TAP (the jump is
   *  re-picked among the tap-weighted variants, the hop), and the crossfade between two variants on that re-pick. */
  jumpVariety: boolean;
  jumpSeed: number;
  tapWindow: number;
  variantFade: number;
  /** The STROLL blend point (clips.stroll): speed (world units/s) at which the slow walk is fully weighted (null =
   *  0.5 × walkSpeed), and the ground speed it is planted for (null = that blend point). */
  strollSpeed: number | null;
  strollClipSpeed: number | null;
  /** The JOG (clips.jog, 2026-10-04): the ground speed it is planted for (world units/s; null = its blend point), and the
   *  speed at which it is fully weighted (null = jogClipSpeed, else midway between the walk and run speeds; never above
   *  runSpeed). With a jog the move blend is walk → jog (walkSpeed … the jog point) → run (the jog point … runSpeed, or
   *  runFullAt × the run clip's ground speed if lower). */
  jogSpeed: number | null;
  jogClipSpeed: number | null;
  /** With a jog: the run is fully weighted at the run speed, or already at this fraction of the run clip's own ground
   *  speed when that is lower. */
  runFullAt: number;
  /** SETTLE STEP (gait clips that record `passPhases`, the runtime defaults): on a stop the gait keeps stepping to its
   *  next passing position (the legs together under the body) while it fades out, instead of freezing mid-stride and
   *  sliding the feet together. The fade is the time that takes at ~the clip's cadence, clamped to [min, max] s. */
  settleMin: number;
  settleMax: number;
  /** IDLE VARIETY (clips.idles, 2026-10-04): while the character stands still, play one of the idle variants now and
   *  then (look around, stretch, check phone / wrist, tap a foot, fix hair / glasses), seeded, never the same one twice
   *  running. `idleFirstDelay` / `idleDelay` = [min, max] seconds of standing before the first / each next one;
   *  `idleFadeIn` / `idleFadeOut` = the crossfades from / back to the base idle; `idleCancelFade` = how fast a variant
   *  gets out of the way when the character moves (locomotion always wins). */
  idleVariety: boolean;
  idleFirstDelay: [number, number];
  idleDelay: [number, number];
  idleFadeIn: number;
  idleFadeOut: number;
  idleCancelFade: number;
}

export const DEFAULT_LOCOMOTION_ANIM: LocomotionAnimConfig = {
  walkSpeed: 1.6, runSpeed: 5.2, walkClipSpeed: null, runClipSpeed: null, sneakClipSpeed: null,
  startFade: 0.15, stopFade: 0.24, airFade: 0.08, landFade: 0.12, crouchRate: 8,
  moveThreshold: 0.06, stopThreshold: 0.03, speedSmoothing: 14,
  minRate: 0.45, maxRate: 1.7, scaleRateClamp: true, airDelay: 0.12, fallAfter: 1.0,
  landGain: 1.1, landMin: 0.15, landMoving: 0.45,
  jumpTakeoff: 0, windupFade: 0.03, windupMoveFade: 0.07,
  jumpVariety: true, jumpSeed: 1, tapWindow: 0.22, variantFade: 0.1,
  strollSpeed: null, strollClipSpeed: null, jogSpeed: null, jogClipSpeed: null, runFullAt: 0.85,
  settleMin: 0.16, settleMax: 0.42,
  idleVariety: true, idleFirstDelay: [4, 7], idleDelay: [6, 12], idleFadeIn: 0.5, idleFadeOut: 0.6, idleCancelFade: 0.15,
};

// ── Idle variety (2026-10-04) ────────────────────────────────────────────────────────────────────────────────────

/** The idle variant playing right now: its clip, normalized phase (0 → 1, played once) and blend weight over the base
 *  idle (0..1, eased in / out). */
export interface IdleVariantSample { clip: string; phase: number; mix: number; }

/**
 * Plays an idle VARIANT now and then while the character stands still: waits a random [min, max] time, picks one
 * (never the one that just played; the one before that less likely), plays it once with eased crossfades, then waits
 * again. Moving cancels it at once (it fades out over `cancelFade`) and restarts the wait. Seeded + pure.
 */
export class IdleVariantScheduler {
  private _rng: () => number;
  private _picker: JumpVariantPicker;
  private _still = 0;
  private _wait = -1;
  private _first = true;
  private _cur: { clip: string; t: number; dur: number; mix: number; cancel: boolean } | null = null;
  private _count = 0;
  /** Every variant started, in order (tests / diagnostics; capped at the last 64). */
  readonly history: string[] = [];
  constructor(seed = 1) { this._rng = seededRandom((seed ^ 0x51ed27) >>> 0); this._picker = new JumpVariantPicker((seed ^ 0x2545f491) >>> 0); }
  reseed(seed: number): void {
    this._rng = seededRandom((seed ^ 0x51ed27) >>> 0); this._picker.reseed((seed ^ 0x2545f491) >>> 0);
    this.reset(); this.history.length = 0; this._count = 0;
  }
  /** Back to a fresh stand (no variant, the first-delay wait). */
  reset(): void { this._still = 0; this._wait = -1; this._first = true; this._cur = null; }
  /** Variants started since construction / reseed. */
  get count(): number { return this._count; }
  get current(): IdleVariantSample | null { const c = this._cur; return c ? { clip: c.clip, phase: Math.min(1, c.t / c.dur), mix: c.mix } : null; }

  /** Advance by dt. `still` = fully in the standing idle (no move, not crouched, on the ground). `names` = the
   *  available variants, `duration(name)` = each one's length in seconds. */
  update(dt: number, still: boolean, names: readonly string[], duration: (name: string) => number, cfg: Pick<LocomotionAnimConfig, 'idleFirstDelay' | 'idleDelay' | 'idleFadeIn' | 'idleFadeOut' | 'idleCancelFade'>): IdleVariantSample | null {
    dt = Math.max(0, dt);
    const ease = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
    const c = this._cur;
    if (c) {
      c.t += dt;
      if (!still || c.cancel || !names.includes(c.clip)) {
        // Locomotion (or anything not a quiet stand) wins: get out of the way fast.
        c.cancel = true;
        c.mix = Math.max(0, c.mix - (cfg.idleCancelFade > 0 ? dt / cfg.idleCancelFade : 1));
        if (c.mix <= 0) { this._cur = null; this._still = 0; this._wait = -1; }
      } else if (c.t >= c.dur) {
        this._cur = null; this._still = 0; this._wait = -1;
      } else {
        c.mix = ease(Math.min(c.t / Math.max(1e-3, cfg.idleFadeIn), (c.dur - c.t) / Math.max(1e-3, cfg.idleFadeOut)));
      }
      return this.current;
    }
    if (!still || !names.length) { this._still = 0; this._wait = -1; return null; }
    if (this._wait < 0) {
      const r = this._first ? cfg.idleFirstDelay : cfg.idleDelay;
      this._wait = r[0] + (r[1] - r[0]) * this._rng();
    }
    this._still += dt;
    if (this._still < this._wait) return null;
    const pick = this._picker.pick(names, () => undefined, { stand: 1, walk: 0, run: 0, held: true });
    const dur = pick ? duration(pick) : 0;
    if (!pick || !(dur > 0.2)) { this._still = 0; this._wait = -1; return null; }
    this._first = false;
    this._cur = { clip: pick, t: 0, dur, mix: 0, cancel: false };
    this._count++;
    this.history.push(pick); if (this.history.length > 64) this.history.shift();
    return this.current;
  }
}

// ── Jump variety ────────────────────────────────────────────────────────────────────────────────────────────────

/** How likely a jump variant is in each context (relative weights, ≥ 0): from a stand / a walk / a run, and for a TAP
 *  (button released early: a short hop) / a HOLD (a full jump). A variant's pick weight = (context mix · stand/walk/run)
 *  × (tap or hold). `family` groups mirrored versions of one variant (picked as one, never twice running); `side` =
 *  which leg leads ('L' / 'R'), matched to the gait at take-off when moving. `land` = its own landing clip. */
export interface JumpVariantInfo {
  stand: number; walk: number; run: number; tap: number; hold: number;
  family?: string; side?: 'L' | 'R'; land?: string;
}
/** What the animator reads per clip name (a SkeletonAnimClip carries both optionally). */
export interface LocoClipInfo { takeoffPhase?: number; jumpVariant?: JumpVariantInfo; passPhases?: number[]; }

/** mulberry32 — a tiny seeded PRNG (uniform [0, 1)). */
export function seededRandom(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A stable 32-bit seed from a string (FNV-1a), e.g. a character id. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** The pick context: how much the character is standing / walking / running (sum 1), tap or hold, the leg to lead. */
export interface JumpContext { stand: number; walk: number; run: number; held: boolean; lead?: 'L' | 'R' | null; }

/**
 * Picks a jump variant per jump: weighted by context, never the same FAMILY twice running (unless it is the only one
 * with weight), the one before that less likely (× 0.35), and within a mirrored family the side that matches the
 * leading leg (else a coin flip). Seeded.
 */
export class JumpVariantPicker {
  private _rng: () => number;
  private _last: string | null = null;
  private _before: string | null = null;
  constructor(seed = 1) { this._rng = seededRandom(seed); }
  reseed(seed: number): void { this._rng = seededRandom(seed); this._last = null; this._before = null; }
  /** The family of the previous pick (null = none yet), and of the one before it. */
  get last(): string | null { return this._last; }
  get before(): string | null { return this._before; }

  static weight(v: JumpVariantInfo | undefined, ctx: JumpContext): number {
    const i = v ?? { stand: 1, walk: 1, run: 1, tap: 1, hold: 1 };
    const w = (ctx.stand * i.stand + ctx.walk * i.walk + ctx.run * i.run) * (ctx.held ? i.hold : i.tap);
    return Number.isFinite(w) && w > 0 ? w : 0;
  }

  /** Pick one of `names` (info(name) = its variant weights; unknown = neutral). `exclude` = families not to pick
   *  (default: the last pick's). `replace` = this pick REPLACES the last one (a tap re-pick of the same jump), so the
   *  history doesn't shift. Returns null for an empty list. */
  pick(names: readonly string[], info: (name: string) => JumpVariantInfo | undefined, ctx: JumpContext, exclude: string | readonly (string | null)[] | null = this._last, replace = false): string | null {
    const ex = new Set<string>((Array.isArray(exclude) ? exclude : [exclude]).filter((f): f is string => !!f));
    if (!names.length) return null;
    const fams = new Map<string, { names: string[]; w: number }>();
    for (const n of names) {
      const v = info(n), f = v?.family ?? n;
      let e = fams.get(f);
      if (!e) { e = { names: [], w: 0 }; fams.set(f, e); }
      e.names.push(n);
      e.w = Math.max(e.w, JumpVariantPicker.weight(v, ctx));
    }
    // The one before last is allowed but less likely (a tap between two holds shouldn't make every other jump the same).
    if (!replace && this._last && this._before && fams.has(this._before)) fams.get(this._before)!.w *= 0.35;
    let pool = [...fams.entries()].filter(([f, e]) => e.w > 0 && !ex.has(f));
    if (!pool.length) pool = [...fams.entries()].filter(([, e]) => e.w > 0);
    if (!pool.length) pool = [...fams.entries()];
    const total = pool.reduce((a, [, e]) => a + Math.max(e.w, 1e-9), 0);
    let r = this._rng() * total, chosen = pool[pool.length - 1];
    for (const p of pool) { r -= Math.max(p[1].w, 1e-9); if (r <= 0) { chosen = p; break; } }
    const [fam, e] = chosen;
    let name = e.names[0];
    if (e.names.length > 1) {
      const match = ctx.lead ? e.names.find((n) => info(n)?.side === ctx.lead) : undefined;
      name = match ?? e.names[Math.floor(this._rng() * e.names.length) % e.names.length];
    }
    if (!replace) this._before = this._last;
    this._last = fam;
    return name;
  }
}

/** One weighted clip sample: sample `clip` at normalized `phase` ∈ [0,1] and mix it in with `weight`. `additive`
 *  layers are added on top (relative to the rest pose) after the normal layers are blended. */
export interface LocoAnimLayer { clip: string; phase: number; weight: number; additive?: boolean; }

const STATES: LocoAnimState[] = ['idle', 'move', 'jump', 'fall'];
/** Gait phase a move starts at from a stand: the left foot planted mid-stance, the right one passing (a first step). */
const START_PHASE = 0.3;

export class LocomotionAnimator {
  cfg: LocomotionAnimConfig;
  private _state: LocoAnimState = 'idle';
  private _w: Record<LocoAnimState, number> = { idle: 1, move: 0, jump: 0, fall: 0 };
  private _phase: Record<LocoAnimState, number> = { idle: 0, move: 0, jump: 0, fall: 0 };
  private _fade = 0.2;
  private _speed = 0;
  private _runMix = 0;
  private _crouch = 0;
  private _airTime = 0;
  private _land = { t: -1, weight: 0, clip: '' };
  private _fresh = true;
  private _strollMix = 0;
  private _jogMix = 0;
  /** The settle step in progress (a stop): the gait phase to reach and the rate (cycles / s) to get there; null = none. */
  private _settle: { left: number; rate: number } | null = null;
  private _canSettle = false;
  // Jump variety: the clip this jump plays (null = clips.jump), the one it is fading from after a tap re-pick, the
  // fade (0 → 1 = fully the current), whether the tap check has been done, and the picker (seeded).
  private _jumpClip: string | null = null;
  private _jumpFrom: string | null = null;
  private _variantMix = 1;
  private _tapChecked = false;
  private _picker: JumpVariantPicker;
  private _seed: number;
  private _jumpCount = 0;
  /** This jump started from the gait: the wind-up blends the stride straight into the clip's TAKE-OFF pose (a runner
   *  pushes off one foot; the two-footed crouch, and the clip's standing first frame, popped the runner upright). */
  private _jumpFromGait = false;
  /** Idle variety (2026-10-04): the scheduler, and the variant layered over the idle this tick. */
  private _idleVar: IdleVariantScheduler;
  private _idleSample: IdleVariantSample | null = null;
  /** Landings since reset (the host's landing dust keys off it), and the last one's clip + impact. */
  private _landCount = 0;
  private _lastLand: { clip: string; impact: number } | null = null;

  constructor(cfg: Partial<LocomotionAnimConfig> = {}) {
    this.cfg = { ...DEFAULT_LOCOMOTION_ANIM, ...cfg };
    this._seed = this.cfg.jumpSeed;
    this._picker = new JumpVariantPicker(this._seed);
    this._idleVar = new IdleVariantScheduler(this._seed);
  }

  /** The jump clip the current (or last) jump plays — a variant from clips.jumps, or clips.jump. */
  get jumpClip(): string | null { return this._jumpClip; }
  /** Jumps started since reset (each one picked a variant). */
  get jumpCount(): number { return this._jumpCount; }
  /** 0 = the walk (or faster), 1 = fully the stroll (the slow walk), inside the move state. */
  get strollMix(): number { return this._strollMix; }
  /** Inside the running share (runMix): 1 = fully the jog, 0 = fully the run (0 without a jog clip). */
  get jogMix(): number { return this._jogMix; }
  /** The shared normalized gait phase (0 = left heel strike). */
  get gaitPhase(): number { return this._phase.move; }

  /** The jump context right now: standing / walking / running by the smoothed speed, tap / hold, the leading leg. */
  jumpContext(loco: LocomotionState, hasRun: boolean): JumpContext {
    const c = this.cfg;
    const mv = Math.max(0, Math.min(1, this._speed / Math.max(1e-3, c.walkSpeed)));
    const rk = hasRun ? Math.max(0, Math.min(1, (this._speed - c.walkSpeed) / Math.max(1e-3, c.runSpeed - c.walkSpeed))) : 0;
    // The leading leg at take-off: the one swinging forward (left swings through the half of the cycle centred ~0.7).
    const lead = mv > 0.25 ? (Math.cos(2 * Math.PI * (this._phase.move - 0.7)) > 0 ? 'L' : 'R') : null;
    return { stand: 1 - mv, walk: mv * (1 - rk), run: mv * rk, held: loco.jumpHeld !== false, lead };
  }

  get state(): LocoAnimState { return this._state; }
  /** Current state weights (sum 1). */
  get weights(): Readonly<Record<LocoAnimState, number>> { return this._w; }
  /** 0 = pure walk, 1 = pure run (inside the move state). */
  get runMix(): number { return this._runMix; }
  /** 0 = standing, 1 = fully crouched (sneak). */
  get crouchMix(): number { return this._crouch; }
  get smoothedSpeed(): number { return this._speed; }
  /** The landing layer's weight right now (0 when not landing). */
  get landWeight(): number { return this._land.t >= 0 ? this._land.weight : 0; }
  /** Landings that played the land layer since reset, and the last one (its clip: Land / Land Deep / Land Soft). */
  get landCount(): number { return this._landCount; }
  get lastLanding(): { clip: string; impact: number } | null { return this._lastLand; }
  /** The idle variant playing this tick (null = none) and the variants started since reset / reseed. */
  get idleVariant(): IdleVariantSample | null { return this._idleSample; }
  get idleVariantCount(): number { return this._idleVar.count; }
  get idleVariantHistory(): readonly string[] { return this._idleVar.history; }

  /** Back to a snapped idle (Play enter / avatar swap). */
  reset(): void {
    this._state = 'idle'; this._w = { idle: 1, move: 0, jump: 0, fall: 0 };
    this._phase = { idle: 0, move: 0, jump: 0, fall: 0 }; this._speed = 0; this._runMix = 0; this._crouch = 0;
    this._airTime = 0; this._land = { t: -1, weight: 0, clip: '' }; this._fresh = true; this._strollMix = 0; this._jogMix = 0;
    this._jumpClip = null; this._jumpFrom = null; this._variantMix = 1; this._tapChecked = false; this._jumpCount = 0; this._jumpFromGait = false;
    this._seed = this.cfg.jumpSeed; this._picker.reseed(this._seed);
    this._idleVar.reseed(this._seed); this._idleSample = null; this._landCount = 0; this._lastLand = null;
  }

  /** Choose this jump's clip (variety on + ≥ 2 variants), else clips.jump. `held` false = re-pick for a tap. */
  private _chooseJump(loco: LocomotionState, clips: LocomotionClips, info: ((n: string) => LocoClipInfo | null | undefined) | undefined): string | null {
    const list = (clips.jumps ?? []).filter((n) => !!n);
    if (!this.cfg.jumpVariety || list.length < 2) return clips.jump ?? null;
    if (this._seed !== this.cfg.jumpSeed) { this._seed = this.cfg.jumpSeed; this._picker.reseed(this._seed); }
    return this._picker.pick(list, (n) => info?.(n)?.jumpVariant, this.jumpContext(loco, !!clips.run)) ?? clips.jump ?? null;
  }

  /** The state the locomotion asks for, given which clips exist. */
  private _pick(loco: LocomotionState, clips: LocomotionClips): LocoAnimState {
    const walk = Math.max(1e-3, this.cfg.walkSpeed);
    if (!loco.airborne && (loco.jumpWindup ?? 0) > 0 && clips.jump) return 'jump';   // crouching to jump (item 13)
    if (loco.airborne && (clips.jump || clips.fall)) {
      const jumped = loco.jumped ?? loco.rising;
      const inAir = this._state === 'jump' || this._state === 'fall';
      if (inAir || jumped || this._airTime >= this.cfg.airDelay) {
        const falling = !loco.rising && this._airTime >= this.cfg.fallAfter;
        if (falling && clips.fall) return 'fall';
        if (this._state === 'fall' && clips.fall) return 'fall';
        return clips.jump ? 'jump' : 'fall';
      }
    }
    // A gait with a settle step (passPhases) stops as soon as the body has (the RAW speed), and steps to rest; others
    // wait for the smoothed speed (as before).
    const stopped = this._canSettle && loco.planarSpeed < this.cfg.stopThreshold * walk;
    const moving = this._state === 'move' ? this._speed > this.cfg.stopThreshold * walk && !stopped : this._speed > this.cfg.moveThreshold * walk && !stopped;
    return moving ? 'move' : 'idle';
  }

  /**
   * Advance by dt and return the weighted layers to blend. `duration(name)` = the clip's cycle length in seconds (≤ 0 /
   * unknown → 1 s). Layers with negligible weight are dropped; the normal layers' weights sum to 1.
   */
  update(dt: number, loco: LocomotionState, clips: LocomotionClips, duration: (clip: string) => number, info?: (clip: string) => LocoClipInfo | null | undefined): LocoAnimLayer[] {
    const c = this.cfg;
    dt = Math.max(0, dt);
    // A set with jump variants but no `jump`: the first variant stands in for it (the state machine keys on clips.jump).
    if (!clips.jump && clips.jumps?.length) clips = { ...clips, jump: clips.jumps[0] };
    this._speed = this._fresh ? loco.planarSpeed : expSmooth(this._speed, loco.planarSpeed, c.speedSmoothing, dt);
    this._airTime = loco.airborne ? (loco.airTime ?? this._airTime + dt) : 0;
    const prevState = this._state;
    this._canSettle = !!info?.(clips.walk)?.passPhases?.length;
    const next = this._pick(loco, clips);
    if (next !== this._state) {
      const from = this._state;
      const fromAir = from === 'jump' || from === 'fall';
      this._fade = next === 'idle' ? (fromAir ? c.landFade : c.stopFade)
        : next === 'move' ? (fromAir ? c.landFade : c.startFade)
        : (next === 'jump' && !loco.airborne) ? c.windupFade
        : c.airFade;
      if (next === 'move' && this._w.move < 1e-3) this._phase.move = START_PHASE;   // a fresh start: first step
      this._settle = null;
      // A stop from the gait: step on to the next passing position while fading (clips that record it).
      if (next === 'idle' && from === 'move' && info) {
        const gait = this._runMix > 0.5 && clips.run ? (clips.jog && this._jogMix > 0.5 ? clips.jog : clips.run) : clips.walk;
        const pass = info(gait)?.passPhases;
        if (pass && pass.length) {
          const p0 = this._phase.move;
          let d = 1;
          for (const q of pass) d = Math.min(d, (((q - p0) % 1) + 1) % 1);
          const cyc = Math.max(1e-3, duration(gait) > 1e-3 ? duration(gait) : 1);
          const T = Math.max(c.settleMin, Math.min(c.settleMax, d * cyc * 1.15));
          if (d * cyc <= c.settleMax * 1.6) { this._settle = { left: d, rate: d / T }; this._fade = T; }
        }
      }
      if (next === 'jump' && !(from === 'fall')) this._phase.jump = 0;
      if (next === 'fall' && this._w.fall < 1e-3) this._phase.fall = 0;
      // A NEW jump (from the ground): pick its variant now, so its own wind-up crouch plays.
      if (next === 'jump' && !fromAir) {
        this._jumpClip = this._chooseJump(loco, clips, info);
        this._jumpFrom = null; this._variantMix = 1; this._tapChecked = false; this._jumpCount++;
        this._jumpFromGait = !loco.airborne && this._w.move > 0.3 && (info?.(this._jumpClip ?? '')?.takeoffPhase ?? 0) > 0;
        if (this._jumpFromGait) this._fade = c.windupMoveFade;
      }
      this._state = next;
    }
    if (this._fresh) { for (const s of STATES) this._w[s] = s === next ? 1 : 0; this._fresh = false; }
    if (!this._jumpClip || (clips.jumps?.length ? false : this._jumpClip !== clips.jump)) this._jumpClip = clips.jump ?? null;
    // A TAP: the button let go before the air phase passed tapWindow (a short, cut jump) — re-pick among the variants
    // with the tap weighting (the hop), crossfading from the held pick. Only when that pick isn't already a tap one.
    if (this._state === 'jump' && !this._tapChecked && loco.jumpHeld === false && this.cfg.jumpVariety && (clips.jumps?.length ?? 0) >= 2) {
      const ap = loco.airborne ? (loco.airPhase ?? 0) : 0;
      this._tapChecked = true;
      const curInfo = info?.(this._jumpClip ?? '')?.jumpVariant;
      if (ap <= c.tapWindow && curInfo && curInfo.tap < curInfo.hold) {
        const ctx = { ...this.jumpContext(loco, !!clips.run), held: false };
        // Not this jump's held pick, nor the PREVIOUS jump's (no repeat of what just played); replaces this jump's pick.
        const alt = this._picker.pick(clips.jumps!, (n) => info?.(n)?.jumpVariant, ctx, [curInfo.family ?? this._jumpClip, this._picker.before], true);
        if (alt && alt !== this._jumpClip) { this._jumpFrom = this._jumpClip; this._jumpClip = alt; this._variantMix = 0; }
      }
    } else if (this._state === 'jump' && loco.airborne && (loco.airPhase ?? 0) > c.tapWindow) this._tapChecked = true;
    if (this._variantMix < 1) { this._variantMix = Math.min(1, this._variantMix + (c.variantFade > 0 ? dt / c.variantFade : 1)); if (this._variantMix >= 1) this._jumpFrom = null; }

    // Landing (additive): on touch-down from the air pose, weighted by the impact — the jump variant's own landing
    // (its `land` clip, when the rig has it) else clips.land.
    const landed = (prevState === 'jump' || prevState === 'fall') && !loco.airborne && !((loco.jumpWindup ?? 0) > 0);
    if (clips.land && landed) {
      const impact = loco.landImpact !== undefined && loco.landImpact > 0 ? loco.landImpact : 0.8;
      const own = prevState === 'jump' && this._jumpClip ? info?.(this._jumpClip)?.jumpVariant?.land : undefined;
      const landClip = own && duration(own) > 0 ? own : clips.land;
      if (impact >= c.landMin) {
        this._land = { t: 0, weight: Math.min(1, impact * c.landGain), clip: landClip };
        this._landCount++; this._lastLand = { clip: landClip, impact };
      }
    }

    // Inertial crossfade: the current state gains dt / fade; the rest share what's left in proportion.
    const cur = this._state;
    const gained = Math.min(1, this._w[cur] + (this._fade > 0 ? dt / this._fade : 1));
    let others = 0;
    for (const s of STATES) if (s !== cur) others += this._w[s];
    if (others > 1e-9) { const k = (1 - gained) / others; for (const s of STATES) if (s !== cur) this._w[s] *= k; this._w[cur] = gained; }
    else { for (const s of STATES) this._w[s] = s === cur ? 1 : 0; }

    // Walk ⇄ run mix by speed (only with a run clip); the crouch mix eases toward the sneak flag.
    const span = Math.max(1e-3, c.runSpeed - c.walkSpeed);
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    // With a JOG: walk → jog up to the jog point (the jog's own ground speed — never above the run speed, so a top
    // speed at or below the jog's natural pace stays a jog), then jog → run up to the run speed, or sooner at
    // `runFullAt` × the run clip's ground speed. Without clip speeds: midway / the run speed.
    const jogOn = !!(clips.run && clips.jog);
    const jogAt = jogOn ? Math.min(c.runSpeed, Math.max(c.walkSpeed * 1.25, c.jogSpeed ?? c.jogClipSpeed ?? c.walkSpeed + 0.5 * span)) : 0;
    const runFull = Math.max(jogAt + 1e-3, Math.min(c.runSpeed, c.runClipSpeed !== null ? c.runFullAt * c.runClipSpeed : c.runSpeed));
    this._runMix = !clips.run ? 0 : jogOn ? clamp01((this._speed - c.walkSpeed) / Math.max(1e-3, jogAt - c.walkSpeed)) : clamp01((this._speed - c.walkSpeed) / span);
    this._jogMix = jogOn ? 1 - clamp01((this._speed - jogAt) / (runFull - jogAt)) : 0;
    // Below the walk speed the STROLL (when the set has one) takes over: shorter steps, smaller arm swing.
    const strollAt = Math.max(1e-3, Math.min(c.walkSpeed * 0.95, c.strollSpeed ?? c.walkSpeed * 0.5));
    this._strollMix = clips.stroll ? Math.max(0, Math.min(1, (c.walkSpeed - this._speed) / Math.max(1e-3, c.walkSpeed - strollAt))) : 0;
    const wantCrouch = loco.sneaking && (clips.sneak || clips.crouch) ? 1 : 0;
    this._crouch = expSmooth(this._crouch, wantCrouch, c.crouchRate, dt);
    if (Math.abs(this._crouch - wantCrouch) < 1e-3) this._crouch = wantCrouch;
    const cSneak = clips.sneak ? this._crouch : 0, cIdle = clips.crouch ? this._crouch : 0;

    // Phases. Idle / fall loop on their own clocks; the gait advances at stride-matched speed while it has weight;
    // jump follows the air phase (or plays once by time).
    const dur = (n: string | undefined) => { const d = n ? duration(n) : 0; return d > 1e-3 ? d : 1; };
    this._phase.idle = (this._phase.idle + dt / dur(clips.idle)) % 1;
    if (this._w.move > 1e-4 || cur === 'move') {
      const r = this._runMix, st = this._strollMix, jm = this._jogMix;
      const wv = c.walkClipSpeed ?? c.walkSpeed, rv = c.runClipSpeed ?? c.runSpeed, sv = c.sneakClipSpeed ?? c.walkSpeed * 0.6;
      const wd = dur(clips.walk), rd = dur(clips.run ?? clips.walk), sd = dur(clips.sneak ?? clips.walk);
      const tv = c.strollClipSpeed ?? strollAt, td = dur(clips.stroll ?? clips.walk);
      const jv = c.jogClipSpeed ?? (jogOn ? jogAt : rv), jd = dur(clips.jog ?? clips.run ?? clips.walk);
      // Distance per cycle (at rate 1) and cycle time of the blended gait (stroll · walk · jog · run).
      const ww = (1 - r) * (1 - st), wr = r * (1 - jm), wj = r * jm;
      const gaitDist = (wv * wd) * ww + (rv * rd) * wr + (jv * jd) * wj + (tv * td) * st, gaitDur = wd * ww + rd * wr + jd * wj + td * st;
      const dist = gaitDist * (1 - cSneak) + (sv * sd) * cSneak, cyc = gaitDur * (1 - cSneak) + sd * cSneak;
      let cps = dist > 1e-6 ? this._speed / dist : 1 / cyc;                 // cycles per second
      // The rate clamp is WIDENED (never narrowed) to include the rates that plant each gait at its own blend point
      // (character scale 2026-10-04): a 2× giant walking at the metre walk speed needs ~0.4× its clip cadence, a
      // doll ~3×; the fixed [minRate, maxRate] slid their feet. An avatar at its natural size is unchanged.
      let lo = c.minRate, hi = c.maxRate;
      if (c.scaleRateClamp) {
        const rw = c.walkSpeed / Math.max(1e-6, wv), rr = clips.run ? c.runSpeed / Math.max(1e-6, rv) : rw, rj = jogOn ? jogAt / Math.max(1e-6, jv) : rw;
        lo = Math.min(lo, 0.9 * Math.min(rw, rr, rj)); hi = Math.max(hi, 1.1 * Math.max(rw, rr, rj));
      }
      cps = Math.max(lo / cyc, Math.min(hi / cyc, cps));
      if (this._settle && cur === 'idle') {
        // The settle step: advance toward the passing phase, and hold there.
        const step = Math.min(this._settle.left, dt * this._settle.rate);
        this._settle.left -= step;
        this._phase.move = (this._phase.move + step) % 1;
      } else this._phase.move = (this._phase.move + dt * cps) % 1;
    }
    if (clips.jump) {
      // The wind-up crouch plays the clip's [0, takeoff) part; the air maps onto [takeoff, 1] (takeoff 0 = as before).
      const ownTo = this._jumpClip ? info?.(this._jumpClip)?.takeoffPhase : undefined;
      const to = Math.max(0, Math.min(0.9, ownTo ?? c.jumpTakeoff));
      const wind = loco.jumpWindup ?? 0;
      this._phase.jump = !loco.airborne && wind > 0
        ? (this._jumpFromGait ? to : to * Math.min(1, wind))
        : loco.airborne && loco.airPhase !== undefined
          ? Math.max(this._phase.jump, to + (1 - to) * loco.airPhase)    // never runs backwards (a bonk / step)
          : Math.min(1, this._phase.jump + dt / dur(clips.jump));
    }
    if (clips.fall) this._phase.fall = (this._phase.fall + dt / dur(clips.fall)) % 1;

    // Idle variety: a variant now and then while fully standing (not crouched, not landing, not winding up a jump);
    // anything else cancels it fast, so locomotion always wins.
    const idleNames = c.idleVariety && clips.idles?.length ? clips.idles : null;
    if (idleNames) {
      const still = cur === 'idle' && this._w.idle > 0.97 && this._crouch < 0.02 && !loco.airborne && !((loco.jumpWindup ?? 0) > 0)
        && this._land.t < 0 && loco.planarSpeed < c.moveThreshold * Math.max(1e-3, c.walkSpeed);
      this._idleSample = this._idleVar.update(dt, still, idleNames, (n) => { const d = duration(n); return d > 1e-3 ? d : 0; }, c);
    } else if (this._idleSample || this._idleVar.current) { this._idleVar.reset(); this._idleSample = null; }
    const iv = this._idleSample, ivMix = iv ? iv.mix : 0;

    const out: LocoAnimLayer[] = [];
    const push = (clip: string | undefined, phase: number, weight: number) => { if (clip && weight > 1e-4) out.push({ clip, phase, weight }); };
    push(clips.idle, this._phase.idle, this._w.idle * (1 - cIdle) * (1 - ivMix));
    if (iv) push(iv.clip, iv.phase, this._w.idle * (1 - cIdle) * ivMix);
    push(clips.crouch, this._phase.idle, this._w.idle * cIdle);
    push(clips.stroll, this._phase.move, this._w.move * (1 - this._runMix) * this._strollMix * (1 - cSneak));
    push(clips.walk, this._phase.move, this._w.move * (1 - this._runMix) * (1 - this._strollMix) * (1 - cSneak));
    push(clips.run, this._phase.move, this._w.move * this._runMix * (1 - this._jogMix) * (1 - cSneak));
    push(clips.jog, this._phase.move, this._w.move * this._runMix * this._jogMix * (1 - cSneak));
    push(clips.sneak, this._phase.move, this._w.move * cSneak);
    // The jump: this jump's variant (and, right after a tap re-pick, the one it is fading from), same air phase.
    const jc = this._jumpClip ?? clips.jump;
    if (this._jumpFrom && this._variantMix < 1) push(this._jumpFrom, this._phase.jump, this._w.jump * (1 - this._variantMix));
    push(jc, this._phase.jump, this._w.jump * (this._jumpFrom && this._variantMix < 1 ? this._variantMix : 1));
    push(clips.fall, this._phase.fall, this._w.fall);
    // Renormalize (dropped layers / a missing clip) so the blend always sums to 1.
    const sum = out.reduce((a, l) => a + l.weight, 0);
    if (sum > 1e-9) for (const l of out) l.weight /= sum;

    // The landing layer (additive) on top: lighter while moving, gone once its clip has played.
    if (clips.land && this._land.t >= 0) {
      const lc = this._land.clip || clips.land;
      this._land.t += dt;
      const ph = this._land.t / dur(lc);
      if (ph >= 1 || loco.airborne) this._land = { t: -1, weight: 0, clip: '' };
      else {
        const moving = this._w.move;
        const w = this._land.weight * (1 - c.landMoving * moving);
        if (w > 1e-4) out.push({ clip: lc, phase: ph, weight: w, additive: true });
      }
    }
    return out;
  }
}

/**
 * Blend N weighted items with a pairwise lerp: running mix = lerp(mix, item, w / (w accumulated)). For quaternion slerp
 * this is the standard "incremental weighted average" (exact for 2 layers, a good approximation for more). `lerp(a, b,
 * t)` is the host's pose blend. Returns null for an empty list.
 */
export function blendWeighted<T>(items: { value: T; weight: number }[], lerp: (a: T, b: T, t: number) => T): T | null {
  let acc: T | null = null, wAcc = 0;
  for (const it of items) {
    if (!(it.weight > 0)) continue;
    wAcc += it.weight;
    acc = acc === null ? it.value : lerp(acc, it.value, it.weight / wAcc);
  }
  return acc;
}

// ── Procedural lean / head lead (Round 8) ───────────────────────────────────────────────────────────────────────

export interface LocomotionLeanConfig {
  /** Degrees of forward (+) / back (−) torso lean per (m/s²) of forward acceleration, and its clamp. */
  accelLean: number; maxAccelLean: number;
  /** Degrees of roll into a turn per (rad/s of turning × fraction of run speed), and its clamp. */
  turnRoll: number; maxTurnRoll: number;
  /** Degrees the head (and ~40 % of it, the chest) turns INTO a turn per rad/s, and its clamp. */
  headLead: number; maxHeadLead: number;
  /** TURN ANTICIPATION (item 13): degrees the head turns toward where the body is ABOUT to face, per radian of turn
   *  still to make (the controller's turnRemaining) — the head looks round first, the body follows. Shares maxHeadLead. */
  turnLead: number;
  /** 1/s smoothing of every channel (no jitter from the 60 Hz differentiation); the head uses headSmoothing (quicker,
   *  so the anticipation leads by a few frames instead of trailing). */
  smoothing: number; headSmoothing: number;
}
export const DEFAULT_LOCOMOTION_LEAN: LocomotionLeanConfig = {
  accelLean: 0.9, maxAccelLean: 8, turnRoll: 7, maxTurnRoll: 9, headLead: 7, maxHeadLead: 26, turnLead: 16, smoothing: 10, headSmoothing: 22,
};

/** The procedural extras the host layers over the blended locomotion pose, in degrees (joint-local, parent frame):
 *  `pitch` (spine, + = lean forward), `roll` (spine + chest, + = toward the character's right), `headYaw` / `chestYaw`
 *  (+ = to the character's left). */
export interface LeanOutput { pitch: number; roll: number; headYaw: number; chestYaw: number; }

/**
 * Body lean into acceleration and turns + the head leading a turn (Round 8). Fed the controller's per-tick planar
 * velocity, body facing and run speed (all in METRES / s, so the gains are scale-free); returns smoothed angles.
 * Airborne: the accel channel is held (no lurch from air control), the turn channels relax.
 */
export class LocomotionLean {
  cfg: LocomotionLeanConfig;
  private _prev: { vx: number; vz: number; facing: number } | null = null;
  private _out: LeanOutput = { pitch: 0, roll: 0, headYaw: 0, chestYaw: 0 };
  private _accel = 0;
  constructor(cfg: Partial<LocomotionLeanConfig> = {}) { this.cfg = { ...DEFAULT_LOCOMOTION_LEAN, ...cfg }; }

  reset(): void { this._prev = null; this._out = { pitch: 0, roll: 0, headYaw: 0, chestYaw: 0 }; this._accel = 0; }
  get output(): Readonly<LeanOutput> { return this._out; }
  /** The last tick's forward acceleration (m/s², + = speeding up) — the secondary motion's follow-through input. */
  get accel(): number { return this._accel; }

  /** vx / vz = planar velocity (m/s), facing = body yaw (rad), runSpeed = the full run speed (m/s), turnRemaining = the
   *  turn (rad, + = left) the body has still to make toward the move direction (0 = none / unknown). */
  update(dt: number, vx: number, vz: number, facing: number, runSpeed: number, grounded: boolean, turnRemaining = 0): LeanOutput {
    const c = this.cfg, o = this._out;
    if (!(dt > 0)) return o;
    const p = this._prev;
    this._prev = { vx, vz, facing };
    if (!p) return o;
    const fx = Math.sin(facing), fz = Math.cos(facing);
    const accel = ((vx - p.vx) * fx + (vz - p.vz) * fz) / dt;             // forward acceleration (m/s²)
    this._accel = Number.isFinite(accel) ? accel : 0;
    let dYaw = facing - p.facing;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    const omega = dYaw / dt;                                              // + = turning left
    const speedK = Math.min(1, Math.hypot(vx, vz) / Math.max(0.5, runSpeed));
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    const tPitch = grounded ? clamp(accel * c.accelLean, c.maxAccelLean) : o.pitch;
    const tRoll = grounded ? clamp(-omega * c.turnRoll * speedK, c.maxTurnRoll) : 0;
    const tHead = clamp(omega * c.headLead + (Number.isFinite(turnRemaining) ? turnRemaining : 0) * c.turnLead, c.maxHeadLead);
    const k = 1 - Math.exp(-c.smoothing * dt), kh = 1 - Math.exp(-c.headSmoothing * dt);
    o.pitch += (tPitch - o.pitch) * k;
    o.roll += (tRoll - o.roll) * k;
    o.headYaw += (tHead - o.headYaw) * kh;
    o.chestYaw = o.headYaw * 0.4;
    return o;
  }
}

// ── Secondary motion: follow-through + per-cycle variation (gait feel, 2026-10-03) ─────────────────────────────

export interface LocomotionSecondaryConfig {
  /** 0..1 — how loose the motion is (0 = off: the clips exactly; 0.5 = the default; 1 = twice the default). */
  looseness: number;
  /** Per gait CYCLE, each arm's swing amplitude varies by up to ± this fraction (at looseness 0.5), eased across the
   *  cycle so a loop never repeats exactly. */
  cycleNoise: number;
  /** Upper-body FOLLOW-THROUGH: a damped spring (Hz, damping ratio) driven by the forward acceleration (deg of chest
   *  pitch per m/s²; + = the chest pitches forward when the body brakes). Under-damped, so a stop settles with a
   *  little overshoot instead of freezing. */
  followHz: number; followDamping: number; followGain: number; maxFollow: number;
  /** The arms swing with the follow-through (deg of forward swing per deg of chest follow). */
  armFollow: number;
  /** A slow head drift while moving (deg, yaw / pitch) — the eyes don't stay locked dead ahead. */
  headDrift: number;
}
export const DEFAULT_LOCOMOTION_SECONDARY: LocomotionSecondaryConfig = {
  looseness: 0.5, cycleNoise: 0.12, followHz: 1.9, followDamping: 0.42, followGain: 0.55, maxFollow: 7, armFollow: 1.0, headDrift: 1.4,
};

/** The extras the host layers over the blended pose (degrees). `armL` / `armR` = extra FORWARD swing of each upper
 *  arm; `chestPitch` (+ = forward) with `neckPitch` countering it; `headYaw` / `headPitch` the drift. */
export interface SecondaryOutput { armL: number; armR: number; chestPitch: number; neckPitch: number; headYaw: number; headPitch: number; }

/** The per-tick input: the gait phase and how much the gait is playing, the blended arm-swing amplitude (deg), forward
 *  acceleration (m/s², + = speeding up) and whether the feet are on the ground. */
export interface SecondaryInput { phase: number; moveWeight: number; armAmp: number; armLag: number; accel: number; grounded: boolean; }

/**
 * Secondary motion for the engine's own humanoid rigs: what makes a procedural gait read loose instead of mechanical.
 *  - Per-CYCLE variation: every gait cycle draws a new swing scale for each arm (seeded), eased in across the cycle, so
 *    no two strides are identical (the clips themselves are perfect loops).
 *  - FOLLOW-THROUGH: the upper body is a damped spring hung on the pelvis, driven by the acceleration: it lags back on a
 *    start, swings forward on a stop and settles with a small overshoot; the arms swing with it.
 *  - A slow head drift while moving.
 * Pure + deterministic for a seed; `looseness` scales it all (0 = off).
 */
export class LocomotionSecondary {
  cfg: LocomotionSecondaryConfig;
  private _rng: () => number;
  private _seed: number;
  private _cycle = { prevL: 0, prevR: 0, nextL: 0, nextR: 0, lastPhase: -1 };
  private _spring = { x: 0, v: 0 };
  private _t = 0;
  private _drift = { a: 0, b: 0, c: 0, d: 0 };
  private _out: SecondaryOutput = { armL: 0, armR: 0, chestPitch: 0, neckPitch: 0, headYaw: 0, headPitch: 0 };
  constructor(cfg: Partial<LocomotionSecondaryConfig> = {}, seed = 1) {
    this.cfg = { ...DEFAULT_LOCOMOTION_SECONDARY, ...cfg };
    this._seed = seed; this._rng = seededRandom(seed); this._initDrift();
  }
  private _initDrift(): void { const r = this._rng; this._drift = { a: r() * 6.283, b: r() * 6.283, c: 0.31 + 0.08 * r(), d: 0.23 + 0.07 * r() }; }
  /** Back to rest; `seed` re-seeds (the character's id). */
  reset(seed = this._seed): void {
    this._seed = seed; this._rng = seededRandom(seed); this._initDrift();
    this._cycle = { prevL: 0, prevR: 0, nextL: 0, nextR: 0, lastPhase: -1 };
    this._spring = { x: 0, v: 0 }; this._t = 0;
    this._out = { armL: 0, armR: 0, chestPitch: 0, neckPitch: 0, headYaw: 0, headPitch: 0 };
  }
  get output(): Readonly<SecondaryOutput> { return this._out; }

  update(dt: number, s: SecondaryInput): SecondaryOutput {
    const c = this.cfg, o = this._out;
    if (!(dt > 0)) return o;
    const k = Math.max(0, Math.min(1, c.looseness)) * 2;          // 0.5 → 1×
    this._t += dt;
    // Per-cycle arm-swing scale: a new draw each time the phase wraps; eased across the cycle.
    const cy = this._cycle;
    if (cy.lastPhase < 0 || s.phase < cy.lastPhase - 0.5) {
      cy.prevL = cy.nextL; cy.prevR = cy.nextR;
      cy.nextL = this._rng() * 2 - 1; cy.nextR = this._rng() * 2 - 1;
    }
    cy.lastPhase = s.phase;
    const e = s.phase * s.phase * (3 - 2 * s.phase);
    const nL = cy.prevL + (cy.nextL - cy.prevL) * e, nR = cy.prevR + (cy.nextR - cy.prevR) * e;
    const sw = -Math.cos(2 * Math.PI * (s.phase - s.armLag));     // + = the LEFT arm forward (the clips' convention)
    const mw = Math.max(0, Math.min(1, s.moveWeight));
    // Follow-through spring: x'' = −ω²x − 2ζωx' − gain·accel (braking → the chest swings forward).
    const w = 2 * Math.PI * c.followHz, sp = this._spring;
    const drive = s.grounded ? Math.max(-c.maxFollow, Math.min(c.maxFollow, -s.accel * c.followGain)) : 0;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < steps; i++) {
      const h = dt / steps;
      const acc = w * w * (drive - sp.x) - 2 * c.followDamping * w * sp.v;
      sp.v += acc * h; sp.x += sp.v * h;
    }
    if (!Number.isFinite(sp.x) || !Number.isFinite(sp.v)) { sp.x = 0; sp.v = 0; }
    const follow = Math.max(-c.maxFollow * 1.5, Math.min(c.maxFollow * 1.5, sp.x)) * k;
    o.chestPitch = follow * 0.7;
    o.neckPitch = -follow * 0.45;
    const amp = s.armAmp * c.cycleNoise * k * mw;
    o.armL = amp * nL * sw + follow * c.armFollow;
    o.armR = amp * nR * -sw + follow * c.armFollow;
    const d = this._drift, t = this._t;
    o.headYaw = c.headDrift * k * mw * (0.65 * Math.sin(2 * Math.PI * d.c * t + d.a) + 0.35 * Math.sin(2 * Math.PI * d.c * 2.3 * t + d.b));
    o.headPitch = c.headDrift * 0.5 * k * mw * Math.sin(2 * Math.PI * d.d * t + d.b);
    return o;
  }
}
