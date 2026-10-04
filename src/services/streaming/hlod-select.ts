// P17 HLOD (performance-plan P17, engine-roadmap step 5): the settings and the per-tile level choice for the streamed
// tiles OUTSIDE the full-detail window. Pure, so it is unit-tested (hlod-select.test.ts).
//
// An outside tile is MID ("tx,tz|h": merged building shells in colour buckets) while it is near, FAR ("tx,tz|f": the
// 2-draw silhouette) past the mid distance, with a hysteresis band so a tile hovering at the threshold never thrashes
// between the two worker builds. With the fog horizon active (Hard edge + linear fog) a tile wholly past the fog's
// Far is FAR whatever the distance setting: it renders as flat fog colour, so the swap there is invisible; it swaps
// back to MID before its box reaches Far (the build lands while it is still in the fog).

/** The HLOD settings (WorldManager.setStreamHlod; session state, like Outside tiles). HLOD itself is the Outside tiles
 *  mode 'hlod' (tile-window.ts OutsideTiles): the A/B switch is that mode vs 'flat' / 'massing'. */
export interface HlodSettings {
    /** Mid → far distance, in tiles (one tile = 2 × the city radius), measured from the camera eye to the tile box. */
    midTiles: number;
    /** Skyline distance, in tiles: how far outside tiles stream (frustum-visible, up to `maxTiles`). The legacy outside
     *  tiers keep the stream's max render distance (5). */
    skylineTiles: number;
    /** Resident outside-tile cap while HLOD is on (the legacy cap is 40). */
    maxTiles: number;
    /** Dissolve HLOD tier swaps with the screen-door dither (flags2 bit 5) instead of popping. */
    fade: boolean;
    /** The dissolve's length (ms). */
    fadeMs: number;
    /** P19: the skyline IMPOSTOR RING (world/skyline-ring.ts): cheap stand-in buildings in a band past the skyline
     *  distance, for an endless horizon. Off by default. */
    ring: boolean;
    /** The ring band's depth (tiles past the skyline distance). */
    ringDepth: number;
}

export const HLOD_DEFAULTS: Readonly<HlodSettings> = { midTiles: 4, skylineTiles: 10, maxTiles: 160, fade: true, fadeMs: 450, ring: false, ringDepth: 5 };

/** Clamp a patch onto `cur` (unknown / non-finite fields ignored). */
export function sanitizeHlod(cur: HlodSettings, patch: Partial<HlodSettings> | null | undefined): HlodSettings {
    const o = { ...cur };
    if (!patch) return o;
    const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    if (typeof patch.fade === 'boolean') o.fade = patch.fade;
    if (typeof patch.ring === 'boolean') o.ring = patch.ring;
    o.ringDepth = Math.round(num(patch.ringDepth, 1, 12, o.ringDepth));
    o.midTiles = num(patch.midTiles, 1, 24, o.midTiles);
    o.skylineTiles = Math.round(num(patch.skylineTiles, 2, 24, o.skylineTiles));
    o.maxTiles = Math.round(num(patch.maxTiles, 16, 400, o.maxTiles));
    o.fadeMs = num(patch.fadeMs, 0, 3000, o.fadeMs);
    return o;
}

/** Hysteresis band of the mid / far distance (a fraction of it). */
export const HLOD_BAND = 0.15;
/** Fog rule: FAR once the tile's nearest point is past fog Far × FOG_FAR_OUT, back to the distance rule inside × FOG_FAR_IN. */
export const HLOD_FOG_OUT = 1.45;
export const HLOD_FOG_IN = 1.3;

/** The level of one outside tile. `dist` = camera eye → the tile box's nearest point (world units); `prev` = its level
 *  last time (null = new); `midDist` = the mid → far distance (world units); `fogFar` = the fog's Far while the fog
 *  horizon is active, else 0. */
export function hlodLevelFor(dist: number, prev: 'mid' | 'far' | null, midDist: number, fogFar = 0): 'mid' | 'far' {
    let lv: 'mid' | 'far' = dist < midDist ? 'mid' : dist > midDist * (1 + HLOD_BAND) ? 'far' : (prev ?? 'mid');
    if (fogFar > 0) {
        if (dist > fogFar * HLOD_FOG_OUT) lv = 'far';
        else if (dist > fogFar * HLOD_FOG_IN && prev === 'far') lv = 'far';
    }
    return lv;
}

/** Distance from a point to an axis-aligned box (0 inside). */
export function pointBoxDistance(px: number, py: number, pz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
    const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
    const dz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
    return Math.hypot(dx, dy, dz);
}

/** P19: an old (full / flat) tier's dissolve coverage `v` (1 → 0) quantised to `steps` levels: the nearest of
 *  (steps-1)/steps … 1/steps, or -1 (= not fading, drawn whole) while it rounds to 1. Each level change is a material
 *  rewrite of every mesh of the tile, so a few levels keep a full tile's dissolve to a few budgeted rewrites. */
export function oldTierFadeLevel(v: number, steps: number): number {
    const n = Math.max(1, steps | 0);
    const k = Math.max(1, Math.min(n, Math.round(v * n)));
    return k >= n ? -1 : k / n;
}

/** The dissolve coverage at `t` ms into a fade of `dur` ms (smoothstep 0 → 1; `dur` 0 = done at once). */
export function hlodFadeCoverage(t: number, dur: number): number {
    if (!(dur > 0)) return 1;
    const u = Math.max(0, Math.min(1, t / dur));
    return u * u * (3 - 2 * u);
}
