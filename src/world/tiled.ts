// ── World generation — Phase C tiled world helpers (world-borders spec) ─────────────────────────────────
// A tiled world is built with TILE-LOD, not brute force: only the CENTRE (focused) tile is a full 3D city; the
// surrounding tiles are cheap FLAT MAPS (the top-down layout preview only — no buildings/props). This keeps a big
// world well inside memory + framerate (brute-forcing every tile at full detail OOMs — 9 cities ≈ 300 MB+). The
// seam is automatic for grid/square tiles: same cell size, offset by exactly 2R, so edge roads coincide; the
// elevation (one world height field, base `terrainSeed` — see tileParams), warp and biome sample WORLD space. The manager (WorldManager._generateTiledLayout)
// orchestrates: build the centre normally, then add a flat-map group per neighbour.

import { LayoutParams, WorldGraph, V2 } from './types';
import { offsetLocalLine } from './local-line';
import { bounds } from './util';

/** Trailing zero bits of a non-zero int (its 2-adic valuation). */
const ctz = (x: number): number => 31 - Math.clz32((x | 0) & -(x | 0));

/** Deterministic per-tile seed — the centre tile keeps the base seed (so it matches a normal diorama city). */
export function tileSeed(base: number, tx: number, tz: number, dedup = true): number {
    if (tx === 0 && tz === 0) return base >>> 0;
    const s = (base ^ Math.imul(tx | 0, 0x468959) ^ Math.imul(tz | 0, 0x1b3f7d)) >>> 0;
    // P10.A2 SEED COLLISIONS: −x = ~(x − 1) in two's complement, and x − 1 flips exactly the bits up to x's lowest set
    // bit. With both multipliers odd, tx·K1 and tz·K2 have the same lowest set bit whenever tx and tz have the same
    // number of trailing zeros, so the flips cancel: (tx, tz) ≡ (−tx, −tz) and (tx, −tz) ≡ (−tx, tz) — in a 3×3
    // world the four corner tiles were two identical pairs of cities (5×5: also (±2, ±2)). Re-salt exactly ONE member
    // of each colliding pair (tx < 0); every other tile keeps its legacy seed.
    if (dedup && tx < 0 && tz !== 0 && ctz(tx) === ctz(tz)) return (s ^ 0x5bd1e995) >>> 0;
    return s;
}

/** Offset every world coordinate in a tile graph by (dx,dz) — so its flat-map geometry lands in the right slot.
 *  Ids are NOT touched (neighbour tiles are flat-map-only; no composer runs on them, so nothing keys on their ids). */
export function offsetGraphGeometry(g: WorldGraph, dx: number, dz: number, landmarks = true): void {
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
    if (g.localLine) offsetLocalLine(g.localLine, dx, dz);   // railway-upgrade R3.2: the at-grade local line
    // P10.A1: landmark footprints / centres / entrances too — they used to stay at the CENTRE city, so every full
    // neighbour tile built its landmark on top of the centre (and site tests / skyway read the wrong spot).
    if (landmarks) for (const lm of g.landmarks ?? []) { offPoly(lm.footprint); lm.center = off(lm.center); lm.entrance = off(lm.entrance); }
    g.bounds = bounds(g.border);
}

/** Params a tile is generated with — grid/square, terraces + shotengai off (their per-tile grids are seam traps).
 *  ★ `terrainSeed` stays the BASE seed: every tile samples ONE continuous world-space height field (S12). A
 *  per-tile terrain seed made each tile its own hill set, so adjacent tiles met in a cliff at every border. */
export function tileParams(base: Partial<LayoutParams>, seed: number): Partial<LayoutParams> {
    return { ...base, seed, terrainSeed: base.terrainSeed ?? base.seed, pattern: 'grid', border: 'square', terraces: false, shotengai: false, worldMode: 'diorama' };
}

/** Half-extent (world units) a tiled world occupies — for sizing the shadow frustum + fog + the union border. */
export function tiledWorldExtent(params: LayoutParams): number {
    const tr = Math.max(0, Math.min(2, (params.tileRadius ?? 1) | 0));
    return (2 * tr + 1) * params.radius;
}
