/**
 * PlayDustDriver — the Play loop's side of the landing dust (src/game/landing-dust.ts; docs/ui/play-mode.md §Landing
 * dust + idle variety). Decides WHEN to raise dust and what kind, from the player's locomotion each fixed tick:
 *  - a touch-down (the animator's landing counter, or the controller's landImpact for a host-animated rig) → a ring
 *    sized by the landing clip (Land / Land Deep / Land Soft) and the impact; a SPLASH when the ground is wet;
 *  - while RUNNING on the ground, a tiny puff at each foot strike (the shared gait phase crossing 0 / 0.5), dry ground
 *    only — a wet street gets a small splash instead;
 * coloured by the ground under the feet, lit by the scene and fogged (DustLighting from the host), scaled by the
 * avatar's size (world units per metre of a 1.7 m human), skipped beyond the fog / sim-LOD edge or far from the camera.
 *
 * ZERO COST when nothing is emitting: the DustSystem holds no memory until a burst, and the host only registers it with
 * the renderer (addTransientParticles) while particles are alive (`frame`).
 */

import { DustSystem, dustColor, footStrikeBetween, landingDustKind, type DustKind, type DustLighting } from '../../game/landing-dust';

/** What the driver reads each tick (all optional extras default sensibly). */
export interface DustTickInput {
    enabled: boolean;
    /** Feet position (world units), body yaw, planar velocity (world units / s). */
    feet: readonly number[]; facing: number; vx: number; vz: number;
    grounded: boolean;
    /** The controller's landing impact on the tick of a touch-down (0 otherwise). */
    landImpact: number;
    /** The engine animator's landing counter + last landing (absent for a host-animated rig). */
    landCount?: number; lastLanding?: { clip: string; impact: number } | null;
    /** Gait: the shared phase (0 = left heel strike), the move-state weight, the walk ⇄ run mix, crouched. */
    gaitPhase?: number; moveWeight?: number; runMix?: number; sneaking?: boolean;
    /** World units per metre of a 1.7 m human (avatar height / 1.7). */
    scale: number;
    /** 0..1 how wet the ground is (rain / wet sheen). ≥ WET_AT splashes instead of dust. */
    wet: number;
}

/** What the driver asks the host (lazily — only when a burst is actually emitted). */
export interface DustEnvironment {
    /** The ground's base colour under a point (0..1 rgb), or null = unknown (a neutral dust). */
    groundColor(x: number, y: number, z: number): readonly number[] | null;
    /** Scene lighting + fog for a point. */
    lighting(x: number, y: number, z: number): DustLighting;
    /** False when a burst here would not be seen (beyond the fog / sim-LOD edge, or too far from the camera). */
    visible(x: number, y: number, z: number, footstep: boolean): boolean;
}

/** Wetness at / above which the ground splashes. */
export const WET_AT = 0.35;

export class PlayDustDriver {
    readonly system: DustSystem;
    private _lastLandCount = -1;
    private _lastPhase = NaN;
    private _wasGrounded = true;
    private _registered = false;
    /** Bursts by kind since reset (tests / diagnostics). */
    readonly emitted: Record<DustKind, number> = { land: 0, landDeep: 0, landSoft: 0, step: 0, splash: 0, stepSplash: 0 };

    constructor(seed = 1) { this.system = new DustSystem(seed); }

    /** Play enter / stop: drop every particle and the edge detectors. */
    reset(seed?: number): void {
        this.system.clear();
        if (seed !== undefined) this.system.reseed(seed);
        this._lastLandCount = -1; this._lastPhase = NaN; this._wasGrounded = true;
        for (const k of Object.keys(this.emitted) as DustKind[]) this.emitted[k] = 0;
    }

    /** One fixed Play tick: emit any bursts this tick calls for. Returns the bursts emitted. */
    tick(i: DustTickInput, env: DustEnvironment): number {
        let n = 0;
        const lc = i.landCount;
        // The animator's counter is the source of truth when it has one (its clip names the landing); a rig animated
        // by the host has none, so the controller's landing impact (one tick) is used instead.
        let landed: { clip: string | null; impact: number } | null = null;
        if (lc !== undefined) {
            if (this._lastLandCount >= 0 && lc > this._lastLandCount) landed = { clip: i.lastLanding?.clip ?? null, impact: i.lastLanding?.impact ?? i.landImpact };
            this._lastLandCount = lc;
        }
        if (!landed && lc === undefined && i.landImpact > 0 && !this._wasGrounded) landed = { clip: null, impact: i.landImpact };
        this._wasGrounded = i.grounded;
        const phase = i.gaitPhase ?? NaN, prevPhase = this._lastPhase;
        this._lastPhase = phase;
        if (!i.enabled || !(i.scale > 0)) return 0;
        const wet = i.wet >= WET_AT;
        if (landed) {
            const dry = landingDustKind(landed.clip, landed.impact);
            if (dry) {
                const kind: DustKind = wet ? 'splash' : dry;
                const [x, y, z] = i.feet;
                if (env.visible(x, y, z, false)) { n += this._emit(kind, i, env, x, y, z, landed.impact); }
            }
        }
        // Running footsteps: a puff at each foot strike, only at a real run (not a walk / sneak), on the ground.
        if (!landed && i.grounded && !i.sneaking && (i.moveWeight ?? 0) > 0.6 && (i.runMix ?? 0) > 0.55 && Number.isFinite(prevPhase) && Number.isFinite(phase)) {
            const foot = footStrikeBetween(prevPhase, phase);
            if (foot) {
                const s = foot === 'L' ? 1 : -1, lat = 0.1 * i.scale * s;
                // The character's left = (cos f, −sin f) (it faces (sin f, cos f); +X is its left at f = 0).
                const x = i.feet[0] + Math.cos(i.facing) * lat, y = i.feet[1], z = i.feet[2] - Math.sin(i.facing) * lat;
                if (env.visible(x, y, z, true)) n += this._emit(wet ? 'stepSplash' : 'step', i, env, x, y, z, 1);
            }
        }
        return n;
    }

    private _emit(kind: DustKind, i: DustTickInput, env: DustEnvironment, x: number, y: number, z: number, impact: number): number {
        const water = kind === 'splash' || kind === 'stepSplash';
        const color = dustColor(water ? null : env.groundColor(x, y, z), env.lighting(x, y, z), water);
        const got = this.system.emit({ x, y, z, kind, scale: i.scale, facing: i.facing, vx: i.vx, vz: i.vz, impact, color, alpha: water ? 0.8 : 0.92 });
        if (got > 0) { this.emitted[kind]++; return 1; }
        return 0;
    }

    /** One rendered frame: advance the particles and keep the renderer registration in step with them (registered
     *  only while something is alive). */
    frame(dt: number, renderer: { addTransientParticles(s: DustSystem): void; removeTransientParticles(s: DustSystem): void } | null): void {
        if (!this.system.allocated && !this._registered) return;               // idle: nothing to do at all
        if (this.system.allocated) this.system.tick(dt);
        const live = this.system.allocated && this.system.count > 0;
        if (live && !this._registered) { renderer?.addTransientParticles(this.system); this._registered = true; }
        else if (!live && this._registered) { renderer?.removeTransientParticles(this.system); this._registered = false; }
    }
    /** True while the system is registered with the renderer (has live particles). */
    get registered(): boolean { return this._registered; }
    /** Unregister + clear (Play stop). */
    detach(renderer: { removeTransientParticles(s: DustSystem): void } | null): void {
        renderer?.removeTransientParticles(this.system); this._registered = false; this.reset();
    }
}
