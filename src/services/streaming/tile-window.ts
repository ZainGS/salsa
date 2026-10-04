// The ACTIVE tile window of a streamed tiled world (performance-plan P10.D, 2026-10-01). Pure, so it is unit-tested.
//
// While "Stream to camera" is on, the Tile radius slider defines the ACTIVE window: 1×1 = 1 full tile, 3×3 = 9,
// (2r+1)². The window is centred on the tile DIRECTLY BELOW THE CAMERA (the eye projected onto the ground plane), or
// on the PLAYER in Play mode, never on the orbit target or the view centre. A hysteresis band at the tile borders stops
// a focus that sits on an edge from thrashing the window: the focus tile only changes once the point is `margin` of a
// tile INTO the next one. Tiles outside the window are the cheap outside tier (None / Flat / Massing).

import { hysteresisTile } from './stream-manager';

/** Hysteresis band at tile borders, as a fraction of a tile (the focus switches ~12% into the next tile). */
export const WINDOW_MARGIN = 0.12;

/** The point the window centres on, in CITY-LOCAL world XZ: the player's feet in Play, else the camera EYE. `origin`
 *  is the city placement (its translation; the tiled world is laid out upright around it). */
export function windowFocusPoint(eye: ArrayLike<number>, player: ArrayLike<number> | null, origin: { x: number; z: number }): [number, number] {
    const p = player ?? eye;
    return [p[0] - origin.x, p[2] - origin.z];
}

/** The focus tile for a city-local XZ point, with hysteresis against the previous focus tile (`prev`; null = snap).
 *  `span` = one tile's world size (2 × radius). */
export function windowFocusTile(x: number, z: number, span: number, prev: readonly [number, number] | null, margin = WINDOW_MARGIN): [number, number] {
    if (!(span > 0)) return [0, 0];
    const u = x / span, v = z / span;
    if (!prev) return [Math.round(u), Math.round(v)];
    return [hysteresisTile(u, prev[0], margin), hysteresisTile(v, prev[1], margin)];
}

/** The tiles of the active window: the (2r+1)² square around the focus tile, nearest-to-focus first (the focus
 *  tile itself first). `radius` is the Tile radius setting (0 = 1×1), clamped to 0..3. */
export function windowTiles(fx: number, fz: number, radius: number): Array<[number, number]> {
    const r = Math.max(0, Math.min(3, radius | 0));
    const out: Array<[number, number, number]> = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) out.push([fx + dx, fz + dz, dx * dx + dz * dz]);
    out.sort((a, b) => a[2] - b[2]);
    return out.map(t => [t[0], t[1]]);
}

/** Outside-the-window tier setting. 'flat' = the flat map, auto-promoted to massing when zoomed far out (the zoom
 *  tiers' STRUCTURE band, `farMassing`); 'massing' = massing at every zoom; 'hlod' = the P17 HLOD tiers (mid / far by
 *  distance, out to the skyline distance; hlod-select.ts); 'none' = nothing outside the window. */
export type OutsideTiles = 'none' | 'flat' | 'massing' | 'hlod';

/** The tier an OUTSIDE tile builds at: 'p' (flat), 'm' (massing), 'h' (HLOD: mid or far, chosen per tile by
 *  hlod-select.ts hlodLevelFor) or null (not built). */
export function outsideTier(mode: OutsideTiles, farMassingNow: boolean): 'p' | 'm' | 'h' | null {
    if (mode === 'none') return null;
    if (mode === 'hlod') return 'h';
    if (mode === 'massing' || farMassingNow) return 'm';
    return 'p';
}
