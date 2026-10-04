/**
 * LANDING DUST (Play polish, 2026-10-04): a small stylised dust ring when the player lands, tiny puffs under the feet
 * while running on dry ground, and water SPLASHES instead on a wet street (rain / wet sheen). Docs:
 * docs/ui/play-mode.md §Landing dust + idle variety.
 *
 * Pure CPU simulation (no GPU, no scene graph): the Play loop feeds bursts (`emit`), ticks it per rendered frame and
 * hands the packed instances to the renderer's TRANSIENT particle list (Renderer3D.addTransientParticles), which draws
 * them with the billboard particle pipeline in a procedural shape mode (anime-style cel puff / droplet, no texture).
 *
 *  - Anime look: hard-edged puffs with a two-tone shade band, a lumpy outline per puff, and an eroding DISSOLVE edge
 *    instead of an alpha fade; the ring spreads fast then stalls (strong drag), the puffs swell as they slow.
 *  - Variants: `land` (the standard), `landDeep` (more puffs, faster and bigger, plus a rising central cloud),
 *    `landSoft` (a few small puffs), `step` (2–3 tiny puffs kicked back from the foot), `splash` / `stepSplash`
 *    (droplets arcing out under gravity + a low spray ring).
 *  - Scale: every length is METRES × `scale` (world units per metre of a 1.7 m human: the Play loop passes the
 *    avatar's height / 1.7, so a doll gets a small puff and a giant a big one, and a city's 15 m/unit is respected).
 *  - Colour comes from the caller per burst (the ground's colour, lit by the scene's sun + ambient, fogged by
 *    distance: `dustColor`), so it follows the time of day, night lighting and fog.
 *  - ZERO COST when idle: nothing is allocated until the first burst, and the pools are released again as soon as the
 *    last particle dies (`allocated` = false). The Play loop only registers the system with the renderer while it has
 *    live particles.
 *
 * Deterministic for a seed (tests). No wall clock: time comes from `tick(dt)`.
 */

import { seededRandom } from './locomotion-animator';

export type DustKind = 'land' | 'landDeep' | 'landSoft' | 'step' | 'splash' | 'stepSplash';

/** Particle shape modes the particle shader understands (texInfo.y). 0 = the textured quad (ordinary emitters). */
export const DUST_SHAPE_PUFF = 1;
export const DUST_SHAPE_DROP = 2;

export interface DustBurst {
    /** Ground point (world units). */
    x: number; y: number; z: number;
    kind: DustKind;
    /** World units per metre (avatar height / 1.7 m). */
    scale: number;
    /** Body yaw (radians; facing = (sin, cos)) — steps kick back, a running landing smears forward. */
    facing?: number;
    /** Planar velocity of the body (world units / s) — a moving landing carries the ring a little forward. */
    vx?: number; vz?: number;
    /** Landing impact (impact speed / jump speed, ~0.3 hop … 1.6 long fall): scales the ring's speed and size. */
    impact?: number;
    /** Lit + fogged colour (0..1 rgb) and opacity. */
    color: [number, number, number];
    alpha?: number;
}

/** Floats per particle in the CPU pool. */
const P = 20;
// [0..2] pos, [3..5] vel, [6] age, [7] life, [8] size0, [9] size1, [10..12] rgb, [13] alpha, [14] drag (1/s),
// [15] gravity (world units / s², + = up), [16] shape, [17] seed, [18] dissolve start (0..1), [19] spare
/** Floats per particle in the GPU upload (the particle shader's ParticleInstance: 3 × vec4). */
export const DUST_GPU_FLOATS = 12;

interface KindSpec {
    count: number;          // ring puffs
    r0: number;             // ring start radius (m)
    speed: [number, number];// outward speed (m/s)
    up: [number, number];   // upward speed (m/s)
    drag: number;           // 1/s
    size0: number; size1: number; // puff diameter start → end (m)
    life: [number, number];
    lift: number;           // buoyancy (m/s², + = up)
    core?: number;          // extra central rising puffs (deep landings)
    drops?: number;         // splash droplets
    dropUp?: [number, number];
    dropOut?: [number, number];
    back?: number;          // step: how much of the burst kicks backwards (0 = a full ring)
}

/** The burst variants (metres). Tuned in the browser against a 1.7 m character (see play-mode.md). */
export const DUST_KINDS: Record<DustKind, KindSpec> = {
    land:      { count: 10, r0: 0.12, speed: [1.5, 1.9], up: [0.12, 0.32], drag: 6.5, size0: 0.11, size1: 0.27, life: [0.5, 0.7], lift: 0.15 },
    landDeep:  { count: 14, r0: 0.14, speed: [2.1, 2.7], up: [0.15, 0.4], drag: 6, size0: 0.14, size1: 0.36, life: [0.6, 0.85], lift: 0.2, core: 4 },
    landSoft:  { count: 6, r0: 0.1, speed: [0.8, 1.1], up: [0.08, 0.2], drag: 7, size0: 0.07, size1: 0.17, life: [0.35, 0.5], lift: 0.1 },
    step:      { count: 3, r0: 0.04, speed: [0.35, 0.65], up: [0.1, 0.22], drag: 7, size0: 0.05, size1: 0.12, life: [0.3, 0.45], lift: 0.1, back: 0.85 },
    splash:    { count: 8, r0: 0.1, speed: [0.9, 1.3], up: [0.05, 0.12], drag: 8, size0: 0.07, size1: 0.16, life: [0.3, 0.42], lift: 0, drops: 12, dropUp: [1.6, 2.6], dropOut: [0.8, 1.6] },
    stepSplash:{ count: 0, r0: 0.05, speed: [0, 0], up: [0, 0], drag: 8, size0: 0, size1: 0, life: [0.25, 0.35], lift: 0, drops: 4, dropUp: [0.9, 1.4], dropOut: [0.3, 0.7], back: 0.6 },
};

/** Gravity on droplets (m/s²). */
const DROP_G = 9.8;

/** The dust system: a lazily allocated pool, ticked by the Play loop. Implements the renderer's transient-particle
 *  source (`activeCount` + `gpuData`). */
export class DustSystem {
    /** Hard cap on live particles (a burst past it is clipped). */
    readonly capacity: number;
    private _pool: Float32Array | null = null;
    private _gpu: Float32Array | null = null;
    private _gpuU32: Uint32Array | null = null;
    private _count = 0;
    private _gpuCount = 0;
    private _rng: () => number;
    private _seedCounter = 0;
    /** Bursts emitted since construction / reset (tests, diagnostics). */
    bursts = 0;
    /** Times the pools were allocated (each time the system wakes from idle). */
    allocations = 0;

    constructor(seed = 1, capacity = 192) {
        this._rng = seededRandom(seed);
        this.capacity = Math.max(8, Math.floor(capacity));
    }

    /** True while the pools exist (some particle alive, or a burst since the last tick). False = no memory held. */
    get allocated(): boolean { return this._pool !== null; }
    /** Live particles. */
    get count(): number { return this._count; }
    /** The renderer's transient-source view: instances packed by the last buildGPUData(). */
    get activeCount(): number { return this._gpuCount; }
    get gpuData(): Float32Array | null { return this._gpu; }

    /** Drop everything and release the pools (Play stop). */
    clear(): void { this._pool = null; this._gpu = null; this._gpuU32 = null; this._count = 0; this._gpuCount = 0; }
    reseed(seed: number): void { this._rng = seededRandom(seed); this._seedCounter = 0; }

    private _ensure(): void {
        if (this._pool) return;
        this._pool = new Float32Array(this.capacity * P);
        this._gpu = new Float32Array(this.capacity * DUST_GPU_FLOATS);
        this._gpuU32 = new Uint32Array(this._gpu.buffer);
        this.allocations++;
    }

    private _spawn(px: number, py: number, pz: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
        c: readonly number[], alpha: number, drag: number, grav: number, shape: number, dissolveAt: number): void {
        if (this._count >= this.capacity) return;
        const p = this._pool!, b = this._count * P;
        p[b] = px; p[b + 1] = py; p[b + 2] = pz; p[b + 3] = vx; p[b + 4] = vy; p[b + 5] = vz;
        p[b + 6] = 0; p[b + 7] = Math.max(0.05, life); p[b + 8] = s0; p[b + 9] = s1;
        p[b + 10] = c[0]; p[b + 11] = c[1]; p[b + 12] = c[2]; p[b + 13] = alpha;
        p[b + 14] = drag; p[b + 15] = grav; p[b + 16] = shape; p[b + 17] = (Math.imul(this._seedCounter++ + 1, 2654435761) >>> 16) & 0xffff;
        p[b + 18] = dissolveAt; p[b + 19] = 0;
        this._count++;
    }

    /** Emit one burst. Returns the number of particles spawned. */
    emit(o: DustBurst): number {
        const spec = DUST_KINDS[o.kind];
        if (!spec || !(o.scale > 0) || !Number.isFinite(o.scale) || ![o.x, o.y, o.z].every(Number.isFinite)) return 0;
        this._ensure();
        const before = this._count;
        const r = this._rng, s = o.scale;
        const lerp = (a: [number, number], t: number) => a[0] + (a[1] - a[0]) * t;
        const imp = Math.max(0.2, Math.min(1.8, o.impact ?? 1));
        const k = Math.max(0.7, Math.min(1.5, 0.75 + 0.35 * imp));          // impact scale (speed + size)
        const fa = o.facing ?? 0, fx = Math.sin(fa), fz = Math.cos(fa);
        const bvx = (o.vx ?? 0) * 0.25, bvz = (o.vz ?? 0) * 0.25;            // a moving landing drifts forward a little
        const alpha = Math.max(0, Math.min(1, o.alpha ?? 0.92));
        const c = o.color;
        // Ring puffs: evenly spaced (jittered) so the ring reads as a ring, or a back-kicked fan for a step.
        const n = spec.count, off = r() * Math.PI * 2;
        for (let i = 0; i < n; i++) {
            let ang: number;
            if (spec.back) {
                // A fan behind the foot: centred on -facing, ± (1 - back) × 180°.
                const spread = Math.PI * (1 - spec.back) + 0.35;
                ang = Math.atan2(-fx, -fz) + (n > 1 ? (i / (n - 1) - 0.5) * 2 * spread : 0) + (r() - 0.5) * 0.4;
            } else ang = off + (i / n) * Math.PI * 2 + (r() - 0.5) * (Math.PI * 2 / n) * 0.6;
            const dx = Math.sin(ang), dz = Math.cos(ang);
            const sp = lerp(spec.speed, r()) * k * s, up = lerp(spec.up, r()) * s;
            const r0 = spec.r0 * s;
            const sz0 = spec.size0 * k * s * (0.85 + 0.3 * r()), sz1 = spec.size1 * k * s * (0.85 + 0.3 * r());
            const tone = 0.94 + 0.08 * r();
            this._spawn(o.x + dx * r0, o.y, o.z + dz * r0, dx * sp + bvx, up, dz * sp + bvz, lerp(spec.life, r()) * (0.9 + 0.2 * k - 0.1),
                sz0, sz1, [c[0] * tone, c[1] * tone, c[2] * tone], alpha * (o.kind === 'splash' ? 0.7 : 1), spec.drag, spec.lift * s, DUST_SHAPE_PUFF, 0.35 + 0.1 * r());
        }
        // Deep landing: a few slower central puffs that rise and swell (the "whump").
        for (let i = 0; i < (spec.core ?? 0); i++) {
            const ang = r() * Math.PI * 2, rr = (0.05 + 0.08 * r()) * s;
            const sz0 = 0.16 * k * s, sz1 = 0.42 * k * s * (0.85 + 0.3 * r());
            this._spawn(o.x + Math.sin(ang) * rr, o.y, o.z + Math.cos(ang) * rr, Math.sin(ang) * 0.5 * s + bvx, (0.5 + 0.35 * r()) * s, Math.cos(ang) * 0.5 * s + bvz,
                0.75 + 0.2 * r(), sz0, sz1, [c[0] * 1.04, c[1] * 1.04, c[2] * 1.04], alpha * 0.85, 4.5, 0.25 * s, DUST_SHAPE_PUFF, 0.45);
        }
        // Splash droplets: up and out under gravity, small hard drops.
        for (let i = 0; i < (spec.drops ?? 0); i++) {
            let ang = r() * Math.PI * 2;
            if (spec.back) ang = Math.atan2(-fx, -fz) + (r() - 0.5) * Math.PI * (1 - spec.back) * 2 + (r() - 0.5) * 0.6;
            const out = lerp(spec.dropOut ?? [1, 1], r()) * k * s, up = lerp(spec.dropUp ?? [1, 1], r()) * Math.sqrt(k) * s;
            const sz = (0.028 + 0.022 * r()) * s * Math.sqrt(k);
            this._spawn(o.x + Math.sin(ang) * spec.r0 * s, o.y + 0.02 * s, o.z + Math.cos(ang) * spec.r0 * s, Math.sin(ang) * out + bvx, up, Math.cos(ang) * out + bvz,
                lerp(spec.life, r()) + 0.05, sz, sz * 0.7, c, alpha, 0.6, -DROP_G * s, DUST_SHAPE_DROP, 0.6);
        }
        const spawned = this._count - before;
        if (spawned > 0) this.bursts++;
        else if (this._count === 0) this.clear();
        return spawned;
    }

    /** Advance by dt seconds (drag, buoyancy / gravity, ageing), drop the dead, rebuild the GPU data. Releases the
     *  pools once nothing is alive. */
    tick(dt: number): void {
        const p = this._pool;
        if (!p) return;
        dt = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
        let w = 0;
        for (let i = 0; i < this._count; i++) {
            const b = i * P;
            const age = p[b + 6] + dt;
            if (age >= p[b + 7]) continue;
            p[b + 6] = age;
            const dk = Math.exp(-p[b + 14] * dt);
            p[b + 3] *= dk; p[b + 5] *= dk;
            p[b + 4] = p[b + 4] * (p[b + 16] === DUST_SHAPE_DROP ? 1 : dk) + p[b + 15] * dt;
            p[b] += p[b + 3] * dt; p[b + 1] += p[b + 4] * dt; p[b + 2] += p[b + 5] * dt;
            if (w !== i) p.copyWithin(w * P, b, b + P);
            w++;
        }
        this._count = w;
        if (w === 0) { this.clear(); return; }
        this.buildGPUData();
    }

    /** Pack the live particles for the particle shader: posSize, colour, texInfo (0, shape, dissolve × 1000, seed).
     *  The billboard centre is lifted by ~half its size so a puff sits ON the ground instead of half inside it. */
    buildGPUData(): void {
        const p = this._pool, g = this._gpu, u = this._gpuU32;
        if (!p || !g || !u) { this._gpuCount = 0; return; }
        for (let i = 0; i < this._count; i++) {
            const b = i * P, o = i * DUST_GPU_FLOATS;
            const t = Math.min(1, p[b + 6] / p[b + 7]);
            const e = 1 - (1 - t) * (1 - t);                                     // ease-out swell
            const size = p[b + 8] + (p[b + 9] - p[b + 8]) * e;
            const d0 = p[b + 18];
            const dissolve = t <= d0 ? 0 : Math.min(1, (t - d0) / (1 - d0));
            const drop = p[b + 16] === DUST_SHAPE_DROP;
            g[o] = p[b]; g[o + 1] = p[b + 1] + (drop ? 0 : size * 0.42); g[o + 2] = p[b + 2]; g[o + 3] = size;
            g[o + 4] = p[b + 10]; g[o + 5] = p[b + 11]; g[o + 6] = p[b + 12]; g[o + 7] = p[b + 13];
            u[o + 8] = 0; u[o + 9] = p[b + 16] >>> 0; u[o + 10] = Math.round(dissolve * dissolve * 1000) >>> 0; u[o + 11] = p[b + 17] >>> 0;
        }
        this._gpuCount = this._count;
    }
}

// ── Colour ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DustLighting {
    /** Scene ambient (rgb × intensity) and the sun (rgb × intensity; elevation 0..1 = how high it stands). */
    ambient: readonly number[]; ambientIntensity: number;
    sun: readonly number[]; sunIntensity: number; sunElevation: number;
    /** Fog: mode, colour, linear near / far, exponential density; `distance` = the burst's distance from the fog eye. */
    fogMode: 'off' | 'linear' | 'exponential'; fogColor: readonly number[]; fogNear: number; fogFar: number; fogDensity: number;
    distance: number;
    /** Extra light at the burst (the player light, a lamp pool), rgb added to the lighting term. Optional. */
    extra?: readonly number[];
}

/** The fog amount 0..1 at `distance` (the renderer's linear / exponential fog). */
export function dustFog(l: Pick<DustLighting, 'fogMode' | 'fogNear' | 'fogFar' | 'fogDensity' | 'distance'>): number {
    const d = Math.max(0, l.distance);
    if (l.fogMode === 'linear') { const span = Math.max(1e-6, l.fogFar - l.fogNear); return Math.max(0, Math.min(1, (d - l.fogNear) / span)); }
    if (l.fogMode === 'exponential') return Math.max(0, Math.min(1, 1 - Math.exp(-Math.max(0, l.fogDensity) * d)));
    return 0;
}

/**
 * The dust colour for a burst: the ground's colour lifted toward a pale warm dust (dust reads lighter than the surface
 * it comes off), lit by the scene (ambient + sun by its elevation, normalised so a clear noon is ~1), then fogged.
 * `water` = a splash: a pale sky-ish grey instead of the ground's colour.
 */
export function dustColor(ground: readonly number[] | null, l: DustLighting, water = false): [number, number, number] {
    const g = ground && ground.length >= 3 && ground.every((v, i) => i > 2 || Number.isFinite(v)) ? ground : [0.55, 0.52, 0.48];
    const pale = water ? [0.78, 0.84, 0.9] : [0.9, 0.86, 0.78];
    const mixK = water ? 0.85 : 0.55;
    const base = [0, 1, 2].map((i) => Math.max(0, Math.min(1, g[i])) * (1 - mixK) + pale[i] * mixK);
    const sunK = Math.max(0, Math.min(1, l.sunElevation)) * 0.8 + 0.2;
    const lit = [0, 1, 2].map((i) => {
        const a = (l.ambient[i] ?? 0) * Math.max(0, l.ambientIntensity) * 1.6;
        const s = (l.sun[i] ?? 0) * Math.max(0, l.sunIntensity) * sunK * 0.85;
        const x = (l.extra?.[i] ?? 0);
        return Math.max(0.06, Math.min(1.25, a + s + x));
    });
    const f = dustFog(l);
    return [0, 1, 2].map((i) => {
        const c = Math.min(1, base[i] * lit[i]);
        return c * (1 - f) + (l.fogColor[i] ?? 0) * f;
    }) as [number, number, number];
}

/** The landing variant for a touch-down: the animator's landing clip when it played one (Land / Land Deep / Land
 *  Soft), else by the impact (a hop is soft, a long fall deep). null = too light to raise dust. */
export function landingDustKind(landClip: string | null | undefined, impact: number): 'land' | 'landDeep' | 'landSoft' | null {
    if (!(impact >= 0.25)) return null;
    if (landClip === 'Land Deep') return 'landDeep';
    if (landClip === 'Land Soft') return 'landSoft';
    if (landClip === 'Land') return impact > 1.35 ? 'landDeep' : 'land';
    return impact > 1.35 ? 'landDeep' : impact < 0.55 ? 'landSoft' : 'land';
}

/** Footstep timing: did a foot strike between gait phases `prev` → `cur` (0 = left heel strike, 0.5 = right)? Returns
 *  'L' / 'R' / null. Handles the wrap at 1. */
export function footStrikeBetween(prev: number, cur: number): 'L' | 'R' | null {
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === cur) return null;
    if (prev <= cur) return prev < 0.5 && cur >= 0.5 ? 'R' : null;
    return 'L';   // wrapped past 1: the left heel strike (one tick never covers half a cycle)
}
