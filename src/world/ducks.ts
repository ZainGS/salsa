// ── World generation — DUCKS ─────────────────────────────────────────────────────────────────────
// Cute low-poly ducks that drift on the city's water, replacing the old canal boat. Each city "flotilla" is a
// small cluster of ducks emitted as one traffic mover (kind 'boat' → rides the water line + gentle bob), facing
// +X so faceRoute yaws them down the canal. GARP-READY (docs/specs/city-props-garp.md): duckGarpPool() exposes
// the colourways as a skin pool, so the duck "skin" is picked from the pool by position hash (mallard / pekin /
// brown / rubber…) — the same reskin path the other city props use, and easily extended with more variants.

import type { LayoutPreviewLayer } from './types';
import type { GarpPool } from './garp';
import { Accum3D } from './meshbuild';

type V3 = [number, number, number];
type RGB = [number, number, number];

export interface DuckColorway { name: string; body: RGB; head: RGB; beak: RGB; }

/** The duck skins. Index/order is stable — duckGarpPool() mirrors it, and pickSkin() chooses one per flotilla. */
export const DUCK_COLORWAYS: DuckColorway[] = [
    { name: 'mallard', body: [0.44, 0.37, 0.28], head: [0.11, 0.33, 0.22], beak: [0.85, 0.72, 0.28] },   // brown body, green head
    { name: 'pekin',   body: [0.95, 0.93, 0.87], head: [0.95, 0.93, 0.87], beak: [0.92, 0.55, 0.18] },   // classic white + orange bill
    { name: 'brown',   body: [0.56, 0.42, 0.28], head: [0.45, 0.32, 0.20], beak: [0.32, 0.28, 0.23] },   // female mallard
    { name: 'rubber',  body: [0.97, 0.83, 0.20], head: [0.97, 0.83, 0.20], beak: [0.93, 0.50, 0.14] },   // rubber-duck yellow
];

/** GARP pool for the ducks — one 'skin' per colourway (tint = body colour). Extensible: adding a skin only reskins
 *  the ~share of flotillas that now hash to it (rendezvous hashing), never the whole set. */
export function duckGarpPool(): GarpPool {
    return {
        id: 'salsa/duck', name: 'Ducks', version: 1, size: [256, 256],
        slots: ['skin'],
        defaults: { skin: 'duck/mallard' },
        skins: DUCK_COLORWAYS.map((c) => ({ name: c.name, slots: { skin: `duck/${c.name}` }, tint: c.body })),
    };
}

/** Emit ONE duck (facing +X) at local (cx,_,cz) into the body / head / beak accumulators, scaled by `s`. */
function emitDuck(body: Accum3D, head: Accum3D, beak: Accum3D, cx: number, cz: number, s: number): void {
    const L = 0.024 * s;   // body half-length
    body.blob([cx, 0.010 * s, cz], L, 0.011 * s, L * 0.72, 0, 0);                       // plump oval hull sitting low
    body.blob([cx - L * 0.92, 0.017 * s, cz], L * 0.30, 0.009 * s, L * 0.30, 0, 0);     // upturned tail (aft = -X)
    head.blob([cx + L * 0.80, 0.026 * s, cz], L * 0.42, L * 0.50, L * 0.42, 0, 0);      // head forward + up
    beak.blob([cx + L * 1.24, 0.023 * s, cz], L * 0.22, 0.004 * s, L * 0.14, 0, 0);     // little bill
}

/** A small drifting FLOTILLA of ducks in colourway `idx` (facing +X for faceRoute) — the mover's layers. */
export function duckFlotillaLayers(idx: number, s: number): LayoutPreviewLayer[] {
    const c = DUCK_COLORWAYS[((idx % DUCK_COLORWAYS.length) + DUCK_COLORWAYS.length) % DUCK_COLORWAYS.length];
    const body = new Accum3D(), head = new Accum3D(), beak = new Accum3D();
    // Three ducks in a loose paddling cluster (offsets in world units at scale s).
    const spots: [number, number][] = [[0, 0], [-0.055 * s, 0.045 * s], [-0.05 * s, -0.05 * s]];
    for (const [dx, dz] of spots) emitDuck(body, head, beak, dx, dz, s);
    const out: LayoutPreviewLayer[] = [{ name: 'world:duck-body', color: c.body, y: 0, geometry: body.geometry() }];
    if (!head.empty) out.push({ name: 'world:duck-head', color: c.head, y: 0, geometry: head.geometry() });
    if (!beak.empty) out.push({ name: 'world:duck-beak', color: c.beak, y: 0, geometry: beak.geometry() });
    return out;
}
