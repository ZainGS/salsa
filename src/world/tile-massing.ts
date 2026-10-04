// ── Streamed-tile MASSING tier (performance-plan P10.C1) ─────────────────────────────────────────────────────
// The cheapest 3D representation of a neighbour tile: the flat map (buildLayoutPreview) plus ONE extruded box per
// building lot — walls in the zone's tint bucket, a flat roof — merged into a few layers. Used for every streamed
// tile once the camera is zoomed out past the STRUCTURE band (a tile is then ~100 px across): it keeps the skyline
// that a flat proxy drops, at about a flat proxy's cost (layout-only graph, no builders, no worker round-trip).
//
// Heights follow buildStreets' per-lot rule (the same position-seeded RNG stream: tint pick, then buildingHeight),
// so a massing box stands about as tall as the full tile's building on that lot. Layout-only graphs have no
// districts, landmarks or variety claims, so the downtown boost / residential trim and landmark blocks are absent —
// invisible at the zoom this tier is used at. Pure (no DOM / WebGPU) → worker-safe.

import type { LayoutPreviewLayer, WorldGraph, Zone, V2 } from './types';
import { Accum3D } from './meshbuild';
import { makeRng, hash2, centroid } from './util';
import { buildingHeight } from './streets';
import { cityPalette } from './palette';
import { makeHeightField } from './elevation';

const BUILT_ZONES: readonly Zone[] = ['residential', 'commercial', 'civic'];

/** One extruded box per building lot of `graph` (already offset to its tile), as `world:bldg-<zone>-<bucket>` wall
 *  layers + one `world:roofs` layer — the same names as the full build, so every name-keyed rule (glow / night
 *  windows, materials, LOD tiers, fog classes) treats them like buildings. Elevation is BAKED (smooth terrain at the
 *  lot centre; the walls start a little below it so a box never floats on a slope). */
export function buildTileMassing(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params, gy = p.groundY, scale = p.radius / 10;
    const hf = makeHeightField(p);
    const PAL = cityPalette(p.seed, p.palette);
    const tint = (c: [number, number, number], i: number): [number, number, number] => {
        if (i === 1) return [Math.min(1, c[0] * 0.9 + 0.05), c[1] * 0.84, c[2] * 0.8];
        if (i === 2) return [Math.min(1, c[0] * 1.07), Math.min(1, c[1] * 1.07), Math.min(1, c[2] * 1.05)];
        return c;
    };
    const walls: Record<string, Accum3D[]> = {};
    for (const z of BUILT_ZONES) walls[z] = [new Accum3D(), new Accum3D(), new Accum3D()];
    const roofs = new Accum3D();
    const inset = 0.06;   // ≈ the street-edge setback of the full footprint (lotFootprint), as a fraction toward the centre
    for (const lot of graph.lots) {
        if (lot.slot !== 'building' || lot.poly.length < 3) continue;
        const buckets = walls[lot.zone]; if (!buckets) continue;
        // buildStreets' per-lot stream: first draw = the tint bucket, then the height.
        const rng = makeRng((p.seed ^ Math.floor(hash2(lot.center[0] * 97.31, lot.center[1] * 57.17, p.seed) * 0xfffffffe)) >>> 0);
        const bi = (rng.next() * buckets.length) | 0;
        const h = buildingHeight(lot.zone, rng, scale);
        const c = centroid(lot.poly);
        const foot: V2[] = lot.poly.map(q => [q[0] + (c[0] - q[0]) * inset, q[1] + (c[1] - q[1]) * inset] as V2);
        let minE = Infinity;
        for (const q of foot) minE = Math.min(minE, hf(q[0], q[1]));
        const base = gy + minE - 0.02 * scale, top = gy + hf(c[0], c[1]) + h;
        buckets[bi].walls(foot, base, top - base);
        roofs.cap(foot, top);
    }
    const out: LayoutPreviewLayer[] = [];
    const winFreq = 62.5 / p.radius, litFrac = p.nightMode ? 0.55 : 0;
    const win: Record<string, { freq: number; scale: number; wall: number }> = {
        residential: { freq: winFreq * 1.25, scale: 0.3, wall: 0 }, commercial: { freq: winFreq, scale: 0.26, wall: 0 }, civic: { freq: winFreq * 0.8, scale: 0.22, wall: 1 },
    };
    for (const z of BUILT_ZONES) walls[z].forEach((acc, i) => {
        if (acc.empty) return;
        const w = win[z];
        out.push({ name: `world:bldg-${z}-${i}`, color: tint(PAL[z as 'residential' | 'commercial' | 'civic'], i), y: gy, geometry: acc.geometry(), drape: 'baked',
            pattern: { color: [1.0, 0.87, 0.55], freq: w.freq, scale: w.scale, mode: 'windows', spacing: litFrac, angle: w.wall } });
    });
    if (!roofs.empty) out.push({ name: 'world:roofs', color: PAL.roof, y: gy, geometry: roofs.geometry(), drape: 'baked' });
    return out;
}
