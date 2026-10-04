// The SKYLINE IMPOSTOR RING (performance-plan P19, optional, off by default): an endless horizon past the last streamed
// HLOD tile. The HLOD skyline streams real tiles out to `skylineTiles` (a square around the window's focus tile); past
// it the world simply ended on a bare horizon. The ring fills a band of tiles beyond it with cheap stand-in buildings:
//
//   - per tile of the band (Chebyshev distance inner+1 .. inner+depth from the centre tile), a few hashed boxes, so
//     the content is WORLD-ANCHORED (a tile's boxes are the same every time it is in the band; moving the centre by a
//     tile only adds / drops the band's edge rows: no sliding, no popping of the rest);
//   - heights from a low-frequency district hash (dense clusters with towers, low sprawl between), in storeys of the
//     city's floor height; footprints a little smaller than a lot;
//   - colours from the city palette (residential / commercial / civic facade colours, the palette's roof colour), in
//     RING_WALL_BUCKETS wall meshes + one roof mesh (4 draws for the whole ring), the windows pattern on the walls (lit
//     at night like the HLOD tiles);
//   - fog-friendly: ordinary meshes named like the HLOD tiles' (world:bldg-hlod-ring-*, world:roofs-hlod-ring), so the
//     fog, the fog horizon (a silhouette in fog colour) and the night windows treat them as the far HLOD level.
//
// Pure + deterministic (seed + tile coords) → unit-tested (skyline-ring.test.ts). World-space geometry, pre-draped
// ('baked'): heights come from `ground(x, z)` (the world's height field) at each box.

import type { LayoutPreviewLayer } from './types';
import { Accum3D } from './meshbuild';
import { hash2 } from './util';
import { cityPalette } from './palette';

type C3 = [number, number, number];

/** Wall colour buckets of the ring (each is one draw). */
export const RING_WALL_BUCKETS = 3;

export interface SkylineRingOptions {
    seed: number;
    /** City radius (one tile = 2 × radius world units). */
    radius: number;
    /** The centre tile (the window's focus tile). */
    centre: readonly [number, number];
    /** The band starts past this Chebyshev tile distance (= the HLOD skyline distance). */
    inner: number;
    /** Band depth (tiles). */
    depth: number;
    /** Boxes per band tile (before the district density). */
    perTile?: number;
    /** Ground height at a world XZ (the world's height field); absent = flat at `groundY`. */
    ground?: (x: number, z: number) => number;
    groundY?: number;
    palette?: string;
    nightMode?: boolean;
}

/** The band's tiles (Chebyshev distance inner+1 .. inner+depth from the centre), nearest ring first. */
export function ringTiles(centre: readonly [number, number], inner: number, depth: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    const lo = Math.max(0, inner | 0) + 1, hi = Math.max(lo, (inner | 0) + Math.max(1, depth | 0));
    for (let d = lo; d <= hi; d++) for (let dz = -d; dz <= d; dz++) for (let dx = -d; dx <= d; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        out.push([centre[0] + dx, centre[1] + dz]);
    }
    return out;
}

/** One stand-in building of a band tile (exported for the tests: world-anchored = a pure function of the tile). */
export interface RingBox { x: number; z: number; w: number; d: number; h: number; ry: number; colour: number }
export function ringBoxesOf(seed: number, radius: number, tx: number, tz: number, perTile = 6): RingBox[] {
    const span = 2 * radius, s = radius / 10, floorU = 0.2 * s;
    const h = (a: number, b: number): number => hash2(tx * 131.71 + a * 17.3, tz * 97.13 + b * 29.9, (seed ^ 0x5b17e) >>> 0);
    // district density: a smooth-ish field over tiles (the hash of a 3-tile cell + this tile's own), so the band has
    // clusters with towers and low sprawl between instead of uniform noise
    const cx = Math.floor(tx / 3), cz = Math.floor(tz / 3);
    const dens = 0.35 * hash2(cx * 41.3, cz * 77.9, (seed ^ 0xd15c) >>> 0) + 0.45 * hash2(cx * 41.3 + 9.1, cz * 77.9 + 3.3, (seed ^ 0xd15d) >>> 0) + 0.2 * h(0.5, 0.5);
    const n = Math.max(1, Math.round(perTile * (0.45 + dens)));
    const out: RingBox[] = [];
    for (let i = 0; i < n; i++) {
        const u = h(i, 1), v = h(i, 2), r = h(i, 3);
        const floors = 3 + Math.round((4 + 26 * dens * dens) * r * r * r + 6 * dens * h(i, 4));
        out.push({
            x: (tx + (u - 0.5) * 0.86) * span, z: (tz + (v - 0.5) * 0.86) * span,
            w: span * (0.06 + 0.08 * h(i, 5)), d: span * (0.06 + 0.08 * h(i, 6)), h: floors * floorU,
            ry: Math.round(h(i, 7) * 4) * (Math.PI / 2) + (h(i, 8) - 0.5) * 0.3, colour: Math.floor(h(i, 9) * RING_WALL_BUCKETS) % RING_WALL_BUCKETS,
        });
    }
    return out;
}

/** The ring's layers: RING_WALL_BUCKETS wall meshes (windows pattern) + one roof mesh, world space, pre-draped. */
export function buildSkylineRing(o: SkylineRingOptions): LayoutPreviewLayer[] {
    const PAL = cityPalette(o.seed, o.palette);
    const gy = o.groundY ?? 0, ground = o.ground ?? ((): number => gy);
    const winFreq = 62.5 / o.radius, cell = 1 / winFreq;
    const lit: C3 = PAL.windowLit?.[0] ?? [1.0, 0.87, 0.55];
    const cols: C3[] = [PAL.residential, PAL.commercial, PAL.civic];
    const walls = cols.map(() => new Accum3D()), roofs = new Accum3D();
    for (const [tx, tz] of ringTiles(o.centre, o.inner, o.depth)) {
        for (const b of ringBoxesOf(o.seed, o.radius, tx, tz, o.perTile)) {
            const c = Math.cos(b.ry), sn = Math.sin(b.ry), hw = b.w / 2, hd = b.d / 2;
            const foot: Array<[number, number]> = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, e]) => [b.x + a * c - e * sn, b.z + a * sn + e * c]);
            const base = ground(b.x, b.z) - 0.05 * (o.radius / 10);   // a little into the ground (no gap on a slope)
            walls[b.colour].wallsWin(foot, base, b.h + 0.05 * (o.radius / 10), cell, 0.2 * o.radius / 10);   // one window row a storey
            roofs.cap(foot, base + b.h + 0.05 * (o.radius / 10));
        }
    }
    const out: LayoutPreviewLayer[] = [];
    walls.forEach((w, i) => {
        if (w.empty) return;
        out.push({ name: `world:bldg-hlod-ring-${i}`, color: cols[i], y: gy, drape: 'baked', noWarp: true, geometry: w.geometry(),
            pattern: { color: lit, freq: winFreq, scale: 0.26, mode: 'windows', spacing: o.nightMode ? 0.55 : 0, angle: 0 } });
    });
    if (!roofs.empty) out.push({ name: 'world:roofs-hlod-ring', color: PAL.roof, y: gy, drape: 'baked', noWarp: true, geometry: roofs.geometry() });
    return out;
}
