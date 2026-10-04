/**
 * SIMULATION LOD (docs/specs/engine-roadmap-todo.md step 1, performance-plan.md §P13): how often each simulated thing
 * (a walker, a car, a train, a live crowd person, a character's idle, its spring bones) is updated, from its distance
 * to the camera, whether it is on screen, and whether the fog horizon hides it.
 *
 *   NEAR     inside `nearM` and on screen: every frame (exactly as without sim LOD);
 *   MID      `nearM`..`midM` on screen: `midHz` (≈ 10 Hz);
 *   FAR      past `midM` on screen: `farHz` (≈ 2 Hz; 0 = frozen);
 *   OFFSCREEN anywhere off screen: `offscreenHz` (≈ 2 Hz; 0 = frozen);
 *   FROZEN   past the fog horizon's cull distance (fog-horizon.ts; Hard edge + "Buildings only in fog"): no update.
 *
 * Distance bands are hysteretic: leaving a band outward needs `hysteresis` (10 %) past its edge, so a mover on a band
 * edge never flips every frame. A thing moving to a FASTER band is updated on the frame it changes (no stale frame).
 * Never throttled (the callers pass `exempt`): the active Play player, the selection, anything being edited (pose
 * editing, a timeline preview) and the targets of script behaviours.
 *
 * Everything here is PURE (no DOM, no scene graph): the band rule, the schedule and the counters. The systems that use
 * it (world-traffic.ts, world-live-crowd.ts, world-crowd.ts, scene3d-animation.ts, scene3d-armature.ts) compute their
 * own distances and call `band()` / `due()`. With `enabled` false every band is NEAR and every call is due, so the
 * callers run their pre-sim-LOD code path unchanged (the A/B switch).
 */

export const SIM_NEAR = 0;
export const SIM_MID = 1;
export const SIM_FAR = 2;
export const SIM_OFFSCREEN = 3;
export const SIM_FROZEN = 4;
export type SimBand = 0 | 1 | 2 | 3 | 4;
export const SIM_BAND_NAMES = ['near', 'mid', 'far', 'offscreen', 'frozen'] as const;
/** Freeze only this far (metres) past the fog horizon's cull distance (see SimLod.inFog). */
export const FOG_MARGIN_M = 4;

export interface SimLodSettings {
  /** The A/B switch: false = every system updates every frame, exactly as before sim LOD. */
  enabled: boolean;
  /** Every-frame radius (metres). */
  nearM: number;
  /** Mid-rate radius (metres); past it = far. */
  midM: number;
  /** Update rates (Hz). 0 = frozen in that band. */
  midHz: number;
  farHz: number;
  offscreenHz: number;
  /** Freeze everything past the fog horizon's cull distance. */
  fogFreeze: boolean;
  /** Outward band hysteresis (fraction of the band edge). */
  hysteresis: number;
  /** Anti-stutter: a MOVING thing on screen in the mid / far band updates at least often enough that one update moves
   *  it at most this many pixels (from its speed, its distance and the lens) — a car at 100 m stays smooth while a
   *  standing walker costs nothing. 0 = the band rates alone. */
  stutterPx: number;
}

export const DEFAULT_SIM_LOD: Readonly<SimLodSettings> = Object.freeze({
  enabled: true, nearM: 40, midM: 120, midHz: 10, farHz: 2, offscreenHz: 2, fogFreeze: true, hysteresis: 0.1, stutterPx: 1.5,
});

export function defaultSimLod(): SimLodSettings { return { ...DEFAULT_SIM_LOD }; }

const fin = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Merge a patch onto `base`, every value clamped to its legal range (bad values keep the base value). */
export function sanitizeSimLod(patch: unknown, base: SimLodSettings = defaultSimLod()): SimLodSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<SimLodSettings> & { reset?: boolean };
  const out: SimLodSettings = p.reset ? defaultSimLod() : { ...base };
  if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
  if (fin(p.nearM)) out.nearM = clamp(p.nearM, 0, 5000);
  if (fin(p.midM)) out.midM = clamp(p.midM, 0, 20000);
  if (out.midM < out.nearM) out.midM = out.nearM;
  if (fin(p.midHz)) out.midHz = clamp(p.midHz, 0, 120);
  if (fin(p.farHz)) out.farHz = clamp(p.farHz, 0, 120);
  if (fin(p.offscreenHz)) out.offscreenHz = clamp(p.offscreenHz, 0, 120);
  if (typeof p.fogFreeze === 'boolean') out.fogFreeze = p.fogFreeze;
  if (fin(p.hysteresis)) out.hysteresis = clamp(p.hysteresis, 0, 1);
  if (fin(p.stutterPx)) out.stutterPx = clamp(p.stutterPx, 0, 100);
  return out;
}

/** The fields that differ from the defaults (what a saved city stores), or null. */
export function simLodDiff(s: SimLodSettings): Partial<SimLodSettings> | null {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_SIM_LOD) as (keyof SimLodSettings)[]) if (s[k] !== DEFAULT_SIM_LOD[k]) out[k] = s[k];
  return Object.keys(out).length ? out as Partial<SimLodSettings> : null;
}

/** The band for a thing `distM` metres from the camera. `prev` is its band last frame (for the hysteresis; pass
 *  SIM_NEAR for a newcomer — the fast side, so nothing starts stale). */
export function simBand(s: SimLodSettings, distM: number, inView: boolean, inFog: boolean, prev: SimBand, exempt = false): SimBand {
  if (!s.enabled || exempt) return SIM_NEAR;
  if (inFog && s.fogFreeze) return SIM_FROZEN;
  if (!inView) return s.offscreenHz > 0 ? SIM_OFFSCREEN : SIM_FROZEN;
  const h = 1 + s.hysteresis;
  // The previous DISTANCE band (off-screen / frozen carry none: decide by distance alone).
  const pd = prev <= SIM_FAR ? prev : -1;
  const nearEdge = pd === SIM_NEAR ? s.nearM * h : s.nearM;
  if (distM < nearEdge) return SIM_NEAR;
  const midEdge = pd >= 0 && pd <= SIM_MID ? s.midM * h : s.midM;
  if (distM < midEdge) return s.midHz > 0 ? SIM_MID : SIM_FROZEN;
  return s.farHz > 0 ? SIM_FAR : SIM_FROZEN;
}

/** Seconds between updates in a band: 0 = every frame, Infinity = never. */
export function simInterval(s: SimLodSettings, band: SimBand): number {
  switch (band) {
    case SIM_NEAR: return 0;
    case SIM_MID: return s.midHz > 0 ? 1 / s.midHz : Infinity;
    case SIM_FAR: return s.farHz > 0 ? 1 / s.farHz : Infinity;
    case SIM_OFFSCREEN: return s.offscreenHz > 0 ? 1 / s.offscreenHz : Infinity;
    default: return Infinity;
  }
}

/** Per-thing schedule state (embed in the thing's record). */
export interface SimSlot { band: SimBand; next: number }
export function newSimSlot(): SimSlot { return { band: SIM_NEAR, next: -Infinity }; }

/**
 * Should this thing update at time `now` (seconds, any monotonic clock)? Moves it to `band` first. A move to a faster
 * band is due at once; otherwise it is due once its interval has passed since its last update. `phase` (0..1) staggers
 * things of one band across the interval, so a crowd at 2 Hz does not all update on the same frame.
 */
export function simDue(s: SimLodSettings, slot: SimSlot, band: SimBand, now: number, phase = 0, maxInterval = Infinity): boolean {
  const prev = slot.band;
  slot.band = band;
  const iv = Math.min(simInterval(s, band), band === SIM_MID || band === SIM_FAR ? maxInterval : Infinity);
  if (iv === 0) { slot.next = now; return true; }
  if (!isFinite(iv)) return false;
  if (band < prev || slot.next === -Infinity) {   // faster band (or first sight) → now, then on the staggered grid
    slot.next = now + iv * (0.5 + 0.5 * phase);
    return true;
  }
  if (now + 1e-9 < slot.next) return false;
  // next on the grid after now (a long frame never queues several updates)
  slot.next = Math.max(slot.next + iv, now + iv * 0.5);
  return true;
}

/** Counters of one system for its last pass (reset by `begin()`), plus lifetime totals. */
export class SimLodCounter {
  readonly bands = [0, 0, 0, 0, 0];
  updates = 0;
  skipped = 0;
  totalUpdates = 0;
  totalSkipped = 0;
  /** performance.now() of the last begin (a system that stopped running reads as idle after a second). */
  at = 0;
  begin(): void { this.bands.fill(0); this.updates = 0; this.skipped = 0; this.at = typeof performance !== 'undefined' ? performance.now() : 0; }
  count(band: SimBand, updated: boolean): void {
    this.bands[band]++;
    if (updated) { this.updates++; this.totalUpdates++; } else { this.skipped++; this.totalSkipped++; }
  }
  view(idle = false): SimLodSystemStats {
    if (idle) return { near: 0, mid: 0, far: 0, offscreen: 0, frozen: 0, updates: 0, skipped: 0, totalUpdates: this.totalUpdates, totalSkipped: this.totalSkipped };
    return { near: this.bands[0], mid: this.bands[1], far: this.bands[2], offscreen: this.bands[3], frozen: this.bands[4],
      updates: this.updates, skipped: this.skipped, totalUpdates: this.totalUpdates, totalSkipped: this.totalSkipped };
  }
}

export interface SimLodSystemStats {
  near: number; mid: number; far: number; offscreen: number; frozen: number;
  /** Updated / skipped in the system's last pass (one frame). */
  updates: number; skipped: number;
  /** Since the counters were created (or reset). */
  totalUpdates: number; totalSkipped: number;
}

export interface SimLodStats {
  enabled: boolean;
  settings: SimLodSettings;
  /** Every system summed. */
  total: SimLodSystemStats;
  /** Per system: walkers, cars, trains, otherMovers, liveCrowd, crowdCells, characters, springs. */
  systems: Record<string, SimLodSystemStats>;
  /** Crowd cell builds skipped because the cell lies past the fog horizon (lifetime). */
  fogSkippedCellBuilds: number;
}

/** The frame's view facts every system needs to band its things (filled once per frame by the owner). */
export interface SimLodView {
  /** Camera position (world). */
  cam: [number, number, number];
  /** View-projection matrix (column-major), or null (no camera: everything counts as on screen). */
  vp: ArrayLike<number> | null;
  /** Fog eye (world) and the fog horizon's cull distance (world units; Infinity = no fog freeze this frame). */
  fogEye: [number, number, number];
  fogEdge: number;
  /** Metres per world unit (a city's scale; 1 without a city) — the band distances are in metres. */
  mpu: number;
  /** Pixels per world unit at a distance of one world unit (canvas height / (2 tan(fov / 2))); ortho: pixels per unit
   *  everywhere (`ortho` true). 0 = unknown (no anti-stutter). */
  pxPerUnit: number;
  ortho: boolean;
}

/** THE sim LOD state: the settings, the per-system counters and this frame's view. One per Scene3DManager. */
export class SimLod {
  settings: SimLodSettings = defaultSimLod();
  readonly view: SimLodView = { cam: [0, 0, 0], vp: null, fogEye: [0, 0, 0], fogEdge: Infinity, mpu: 1, pxPerUnit: 0, ortho: false };
  private readonly _sys = new Map<string, SimLodCounter>();
  fogSkippedCellBuilds = 0;

  get enabled(): boolean { return this.settings.enabled; }

  configure(patch: unknown): SimLodSettings {
    this.settings = sanitizeSimLod(patch, this.settings);
    return { ...this.settings };
  }

  counter(system: string): SimLodCounter {
    let c = this._sys.get(system);
    if (!c) { c = new SimLodCounter(); this._sys.set(system, c); }
    return c;
  }

  resetStats(): void { this._sys.clear(); this.fogSkippedCellBuilds = 0; }

  /** Is world point (x, y, z) with radius `r` (world units) past the fog horizon's cull distance? */
  inFog(x: number, y: number, z: number, r = 0): boolean {
    const e = this.view.fogEdge;
    if (!(e < Infinity)) return false;
    const f = this.view.fogEye, dx = x - f[0], dy = y - f[1], dz = z - f[2];
    // + FOG_MARGIN_M: a thing is frozen only once it is a few metres past the line, so one walking out of the fog is
    // already updating (at its band's rate) when it reaches the edge — the jump to its clock position happens unseen
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - r - FOG_MARGIN_M / Math.max(1e-6, this.view.mpu);
    return d > e;
  }

  /** The band of a thing at world point (x, y, z) with radius `r` (world units). `bigOnScreen`: distance bands do
   *  not apply (large, smooth motion read from far away: trains, clouds) — on screen it is NEAR. `noFog`: never
   *  fog-frozen (a no-fog material, the clouds). */
  bandAt(x: number, y: number, z: number, r: number, prev: SimBand, exempt = false, bigOnScreen = false, noFog = false, vx = 0, vz = 0): SimBand {
    const v = this.view, c = v.cam;
    const dx = x - c[0], dy = y - c[1], dz = z - c[2];
    const distM = bigOnScreen ? 0 : Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - r) * v.mpu;
    // on screen now, or where it will be by its next off-screen update (a fast car about to enter the view is not
    // left posed off screen for half a second)
    const lead = Math.min(1, simInterval(this.settings, SIM_OFFSCREEN));
    const inView = simPointInView(v.vp, x, y, z, 1.35) || ((vx !== 0 || vz !== 0) && isFinite(lead) && simPointInView(v.vp, x + vx * lead, y, z + vz * lead, 1.35));
    const inFog = !noFog && this.inFog(x, y, z, r);
    return simBand(this.settings, distM, inView, inFog, prev, exempt);
  }

  /** bandAt + simDue + the counter, in one call: true = update this thing now. */
  step(counter: SimLodCounter, slot: SimSlot, now: number, phase: number, x: number, y: number, z: number, r: number,
       exempt = false, bigOnScreen = false, noFog = false, speed = 0, vx = 0, vz = 0): boolean {
    const band = this.bandAt(x, y, z, r, slot.band, exempt, bigOnScreen, noFog, vx, vz);
    // anti-stutter: a moving thing on screen updates before it has moved `stutterPx` pixels
    let maxIv = Infinity;
    const v = this.view, sp = this.settings.stutterPx;
    if (speed > 0 && sp > 0 && v.pxPerUnit > 0 && (band === SIM_MID || band === SIM_FAR)) {
      const c = v.cam, dx = x - c[0], dy = y - c[1], dz = z - c[2];
      const pxPerUnit = v.ortho ? v.pxPerUnit : v.pxPerUnit / Math.max(1e-6, Math.sqrt(dx * dx + dy * dy + dz * dz));
      maxIv = sp / (speed * pxPerUnit);
    }
    const due = simDue(this.settings, slot, band, now, phase, maxIv);
    counter.count(band, due);
    return due;
  }

  stats(): SimLodStats {
    const systems: Record<string, SimLodSystemStats> = {};
    const total: SimLodSystemStats = { near: 0, mid: 0, far: 0, offscreen: 0, frozen: 0, updates: 0, skipped: 0, totalUpdates: 0, totalSkipped: 0 };
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    for (const [k, c] of this._sys) {
      const v = c.view(now - c.at > 1000 || !this.settings.enabled); systems[k] = v;
      for (const f of Object.keys(total) as (keyof SimLodSystemStats)[]) total[f] += v[f];
    }
    return { enabled: this.settings.enabled, settings: { ...this.settings }, total, systems, fogSkippedCellBuilds: this.fogSkippedCellBuilds };
  }
}

/** Is world point (x, y, z) inside the view (NDC widened by `margin`)? Points behind the camera are out. (The same
 *  test as world-traffic.ts pointInView; repeated here so the module stays dependency-free.) */
export function simPointInView(vp: ArrayLike<number> | null, x: number, y: number, z: number, margin = 1.35): boolean {
  if (!vp) return true;
  const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (w <= 1e-4) return false;
  const nx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w;
  const ny = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w;
  return nx >= -margin && nx <= margin && ny >= -margin && ny <= margin;
}
