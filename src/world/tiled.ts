// ── World generation — Phase C tiled world helpers (world-borders spec) ─────────────────────────────────
// A tiled world is built with TILE-LOD, not brute force: only the CENTRE (focused) tile is a full 3D city; the
// surrounding tiles are cheap FLAT MAPS (the top-down layout preview only — no buildings/props). This keeps a big
// world well inside memory + framerate (brute-forcing every tile at full detail OOMs — 9 cities ≈ 300 MB+). The
// seam is automatic for grid/square tiles: same cell size, offset by exactly 2R, so edge roads coincide; continuous
// elevation/warp/biome sample WORLD space → seamless for free. The manager (WorldManager._generateTiledLayout)
// orchestrates: build the centre normally, then add a flat-map group per neighbour.

import { LayoutParams, WorldGraph, V2 } from './types';
import { bounds } from './util';

/** Deterministic per-tile seed — the centre tile keeps the base seed (so it matches a normal diorama city). */
export function tileSeed(base: number, tx: number, tz: number): number {
    if (tx === 0 && tz === 0) return base >>> 0;
    return (base ^ Math.imul(tx | 0, 0x468959) ^ Math.imul(tz | 0, 0x1b3f7d)) >>> 0;
}

/** Offset every world coordinate in a tile graph by (dx,dz) — so its flat-map geometry lands in the right slot.
 *  Ids are NOT touched (neighbour tiles are flat-map-only; no composer runs on them, so nothing keys on their ids). */
export function offsetGraphGeometry(g: WorldGraph, dx: number, dz: number): void {
    const off = (p: V2): V2 => [p[0] + dx, p[1] + dz];
    const offPoly = (poly: V2[]): void => { for (let i = 0; i < poly.length; i++) poly[i] = [poly[i][0] + dx, poly[i][1] + dz]; };
    for (const r of g.roads) { r.a = off(r.a); r.b = off(r.b); }
    for (const b of g.blocks) offPoly(b.poly);
    for (const l of g.lots) { offPoly(l.poly); l.center = off(l.center); }
    for (const it of g.intersections) it.pos = off(it.pos);
    for (const pond of g.ponds) offPoly(pond);
    for (const br of g.bridges) offPoly(br);
    if (g.plaza) offPoly(g.plaza);
    offPoly(g.border);
    g.bounds = bounds(g.border);
}

/** Params a tile is generated with — grid/square, terraces + shotengai off (their per-tile grids are seam traps). */
export function tileParams(base: Partial<LayoutParams>, seed: number): Partial<LayoutParams> {
    return { ...base, seed, pattern: 'grid', border: 'square', terraces: false, shotengai: false, worldMode: 'diorama' };
}

/** Half-extent (world units) a tiled world occupies — for sizing the shadow frustum + fog + the union border. */
export function tiledWorldExtent(params: LayoutParams): number {
    const tr = Math.max(0, Math.min(2, (params.tileRadius ?? 1) | 0));
    return (2 * tr + 1) * params.radius;
}
