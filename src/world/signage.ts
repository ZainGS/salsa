// ── World generation — shop signage ─────────────────────────────────────────────────────────────
// A building's street frontage (its longest edge) is divided into several SHOPS; each gets a flat sign above
// the door, and about half also get a projecting "blade" sign sticking out from the wall (the Japanese look).
// Signs are coloured rectangles from a small palette (merged per colour → a few glowing layers). Later these
// rectangles can become real text via the Billboard3D primitive.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { makeRng, centroid, frontageEdge, hash2, graphLookups } from './util';
import { Accum3D } from './meshbuild';
import { makeElevation } from './elevation';
import { AdvertSink } from './adverts';

type V3 = [number, number, number];

// persona-polish B5: curated tones (vermilion / navy / amber / teal / rose / warm white) — varied hue AND value, not
// pure primaries. Same count + order as before (the colour rng stream and the layer names are unchanged).
const PALETTE: [number, number, number][] = [
    [0.84, 0.27, 0.18], [0.16, 0.26, 0.52], [0.94, 0.68, 0.2], [0.16, 0.52, 0.44], [0.82, 0.36, 0.56], [0.92, 0.92, 0.88],
];
const NAMES = ['red', 'blue', 'yellow', 'green', 'pink', 'white'];

const nrm2 = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

export function buildSignage(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params; if (!p.signage) return [];
    const gy = p.groundY, s = p.radius / 10;
    const rng = makeRng((p.seed ^ 0x5124a3b) >>> 0);
    const accs = PALETTE.map(() => new Accum3D());
    const holoA = new Accum3D(), holoB = new Accum3D();   // cyber holo billboards (two neon tints)
    const shopW = 0.22 * s;
    const { regionByBlock, distByBlock: distById, blockCentroid: blockC } = graphLookups(graph);
    const elev = makeElevation(graph);   // signs bake the SAME anchor lift as their (rigid) building — layer routed heightless
    // ADVERTS (docs/ui/garp.md §Adverts): the user's images on these simple signs too (non-detailed buildings). A pure
    // hash per sign — the colour rng stream below is consumed EXACTLY as before, so an empty pool is byte-identical.
    const ads = p.adverts && p.adverts.entries.length ? new AdvertSink(p.adverts, (p.seed ^ 0x5a1e) >>> 0) : null;
    // Per-sign salt from its (quantized) position — stable whatever the region filter / other lots do.
    const posSalt = (c: V3): number => (Math.imul(Math.round(c[0] * 4096), 73856093) ^ Math.imul(Math.round(c[1] * 4096), 19349663) ^ Math.imul(Math.round(c[2] * 4096), 83492791)) >>> 0;
    /** Cover the +`n` face (centre `c`, w × h) of a sign box with an image; the box itself stays as the frame. */
    const adOn = (c: V3, n: V3, w: number, h: number, salt: number): void => { if (ads) ads.face(c, n, w, h, salt, false, 0.002 * s); };
    /** A projecting blade box's two faces (±`e`), one image seen from both sides. */
    const adBlade = (c: V3, e: V3, w: number, h: number, th: number, salt: number): void => {
        for (const sg of [1, -1]) adOn([c[0] + e[0] * sg * th, c[1], c[2] + e[2] * sg * th], [e[0] * sg, 0, e[2] * sg], w, h, salt);
    };

    for (const lot of graph.lots) {
        if (lot.slot !== 'building') continue;
        if (keep && !keep(regionByBlock.get(lot.block) ?? -1)) continue;
        const downtown = distById.get(lot.block) === 'downtown';
        // ★ DETAILED buildings letter their OWN signs (tenant signs, vertical stacks, fascias, billboards — B3/B7),
        // placed on the real facade. The blocks here were re-derived from the raw lot and floated off it (and
        // doubled every shop's sign). Only the cyber HOLO boards (floating above the roof, not on the wall) stay.
        if (p.detailedBuildings) {
            const hh = lot.builtH ?? 0;
            if ((p.holograms ?? false) && downtown && hh > 0.8 * s && rng.chance(0.5)) {
                const gyH = gy + elev(lot.center[0], lot.center[1]);
                const fr0 = frontageEdge(lot.poly, blockC.get(lot.block) ?? null, 0);
                const ed = nrm2([fr0.b[0] - fr0.a[0], fr0.b[1] - fr0.a[1]]);
                (rng.chance(0.5) ? holoA : holoB).obox([lot.center[0], gyH + hh + 0.22 * s, lot.center[1]], [ed[0], 0, ed[1]], [0, 1, 0], [-ed[1], 0, ed[0]], 0.13 * s, 0.075 * s, 0.004 * s);
            }
            continue;
        }
        if (lot.zone === 'residential' && !downtown && !rng.chance(0.25)) continue;   // mostly shops → commercial/civic + all of downtown; a few residential
        const foot = insetToward(lot.poly, lot.center, 0.12);
        if (foot.length < 3) continue;
        // Street-facing frontage with jitter — signs face the street and vary per building (not all one direction).
        const fr = frontageEdge(foot, blockC.get(lot.block) ?? null, hash2(lot.center[0] * 991, lot.center[1] * 761, p.seed) * 100);
        if (fr.len < shopW * 0.8) continue;

        const eDir = nrm2([fr.b[0] - fr.a[0], fr.b[1] - fr.a[1]]);
        let outward: V2 = [-eDir[1], eDir[0]];
        const mid: V2 = [(fr.a[0] + fr.b[0]) / 2, (fr.a[1] + fr.b[1]) / 2], cen = centroid(foot);
        if ((mid[0] - cen[0]) * outward[0] + (mid[1] - cen[1]) * outward[1] < 0) outward = [-outward[0], -outward[1]];   // face the street
        const eW: V3 = [eDir[0], 0, eDir[1]], oW: V3 = [outward[0], 0, outward[1]], up: V3 = [0, 1, 0];

        // ALL signage clamps to the building's REAL facade height (lot.builtH, stamped by buildStreets) — otherwise
        // blades/stacks float in mid-air above short buildings (glowing confetti columns at night).
        const h = lot.builtH ?? 0.4 * s;
        const gyL = gy + elev(lot.center[0], lot.center[1]);   // the building's rigid anchor height
        const n = Math.max(1, Math.floor(fr.len / shopW));   // this "building" hosts n shops side by side
        const wSign = (fr.len / n) * 0.42;
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n, px = fr.a[0] + (fr.b[0] - fr.a[0]) * t, pz = fr.a[1] + (fr.b[1] - fr.a[1]) * t;
            const doorY = Math.min(0.15 * s, h * 0.65);   // over-door sign — drops onto short facades
            const dc: V3 = [px + oW[0] * 0.008 * s, gyL + doorY, pz + oW[2] * 0.008 * s];
            accs[(rng.next() * PALETTE.length) | 0].obox(dc, eW, up, oW, wSign, 0.028 * s, 0.006 * s);
            adOn([dc[0] + oW[0] * 0.006 * s, dc[1], dc[2] + oW[2] * 0.006 * s], oW, wSign * 2, 0.056 * s, posSalt(dc));
            if (h > 0.32 * s && rng.chance(downtown ? 0.85 : 0.45)) {   // projecting blade sign
                const bc: V3 = [px + oW[0] * 0.05 * s, gyL + 0.24 * s, pz + oW[2] * 0.05 * s];
                accs[(rng.next() * PALETTE.length) | 0].obox(bc, oW, up, eW, 0.045 * s, 0.05 * s, 0.004 * s);
                adBlade(bc, eW, 0.09 * s, 0.1 * s, 0.004 * s, posSalt(bc));
            }
            // downtown = extra stacked blade higher up (the wall-of-signs look) — only where the facade reaches
            if (downtown && h > 0.5 * s && rng.chance(0.7)) {
                const bc: V3 = [px + oW[0] * 0.045 * s, gyL + 0.4 * s, pz + oW[2] * 0.045 * s];
                accs[(rng.next() * PALETTE.length) | 0].obox(bc, oW, up, eW, 0.04 * s, 0.06 * s, 0.004 * s);
                adBlade(bc, eW, 0.08 * s, 0.12 * s, 0.004 * s, posSalt(bc));
            }
            // SIGN TOWER: some downtown shops stack blade signs floor-by-floor up the facade (pencil-building wall
            // of neon) — the stack stops just under the building's own roofline.
            if (downtown && i === 0 && rng.chance(0.3)) for (let fy = 0.45 * s; fy < h - 0.08 * s; fy += 0.14 * s) {
                const bc: V3 = [px + oW[0] * 0.05 * s, gyL + fy, pz + oW[2] * 0.05 * s];
                accs[(rng.next() * PALETTE.length) | 0].obox(bc, oW, up, eW, 0.038 * s, 0.055 * s, 0.004 * s);
                adBlade(bc, eW, 0.076 * s, 0.11 * s, 0.004 * s, posSalt(bc));
            }
        }
        // HOLO BILLBOARD (cyber suite): a big translucent screen FLOATING above some tall downtown roofs, running
        // the animated waves pattern — the Blade-Runner ad hovering over the skyline. Baked anchor like all signage.
        if ((p.holograms ?? false) && downtown && h > 0.8 * s && rng.chance(0.5)) {
            (rng.chance(0.5) ? holoA : holoB).obox([lot.center[0], gyL + h + 0.22 * s, lot.center[1]], eW, up, oW, 0.13 * s, 0.075 * s, 0.004 * s);
        }
    }

    const out: LayoutPreviewLayer[] = [];
    const glow = p.nightMode ? 1.25 : 0.5;   // shop signs read as lit; full neon at night
    accs.forEach((a, i) => { if (!a.empty) out.push({ name: 'world:sign-' + NAMES[i], color: PALETTE[i], y: gy, geometry: a.geometry(), emissive: glow }); });
    if (ads && !ads.empty) out.push(...ads.layers('world:', gy, Math.min(glow, 0.9), 0.14));   // user images (GARP signage pages)
    // Holo billboards: animated drifting bands (the wavy-screen shader) at two neon tints, translucent + glowing.
    // ★ REAL LIT SIGNS (material bit 22) instead of a colour band scrolled across the albedo. The two
    // boards get DIFFERENT phases — a whole street flickering in unison is the giveaway that it is one
    // animation playing on many quads rather than many independent tubes.
    if (!holoA.empty) out.push({ name: 'world:sign-holoboard-a', color: [0.05, 0.25, 0.35], y: gy, geometry: holoA.geometry(),
        neon: { glow: [0.30, 0.95, 1.0], accent: [0.55, 1.0, 1.0], scanDensity: 26, flicker: 0.14, scroll: 0.4, phase: 0.13 }, opacity: 0.85 });
    if (!holoB.empty) out.push({ name: 'world:sign-holoboard-b', color: [0.30, 0.06, 0.28], y: gy, geometry: holoB.geometry(),
        neon: { glow: [1.0, 0.40, 0.90], accent: [1.0, 0.75, 0.95], scanDensity: 19, flicker: 0.22, scroll: 0.28, phase: 0.67 }, opacity: 0.85 });
    return out;
}

function insetToward(poly: V2[], c: V2, f: number): V2[] {
    return poly.map(pp => [pp[0] + (c[0] - pp[0]) * f, pp[1] + (c[1] - pp[1]) * f] as V2);
}
