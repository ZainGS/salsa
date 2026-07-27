// ── World generation — shop signage ─────────────────────────────────────────────────────────────
// A building's street frontage (its longest edge) is divided into several SHOPS; each gets a flat sign above
// the door, and about half also get a projecting "blade" sign sticking out from the wall (the Japanese look).
// Signs are coloured rectangles from a small palette (merged per colour → a few glowing layers). Later these
// rectangles can become real text via the Billboard3D primitive.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { makeRng, centroid, frontageEdge, hash2, graphLookups } from './util';
import { Accum3D } from './meshbuild';
import { makeElevation } from './elevation';

type V3 = [number, number, number];

const PALETTE: [number, number, number][] = [
    [0.82, 0.18, 0.16], [0.18, 0.34, 0.68], [0.92, 0.78, 0.22], [0.22, 0.60, 0.40], [0.85, 0.45, 0.60], [0.90, 0.88, 0.82],
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

    for (const lot of graph.lots) {
        if (lot.slot !== 'building') continue;
        if (keep && !keep(regionByBlock.get(lot.block) ?? -1)) continue;
        const downtown = distById.get(lot.block) === 'downtown';
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
            accs[(rng.next() * PALETTE.length) | 0].obox([px + oW[0] * 0.008 * s, gyL + doorY, pz + oW[2] * 0.008 * s], eW, up, oW, wSign, 0.028 * s, 0.006 * s);
            if (h > 0.32 * s && rng.chance(downtown ? 0.85 : 0.45)) accs[(rng.next() * PALETTE.length) | 0].obox([px + oW[0] * 0.05 * s, gyL + 0.24 * s, pz + oW[2] * 0.05 * s], oW, up, eW, 0.045 * s, 0.05 * s, 0.004 * s);   // projecting blade sign
            // downtown = extra stacked blade higher up (the wall-of-signs look) — only where the facade reaches
            if (downtown && h > 0.5 * s && rng.chance(0.7)) accs[(rng.next() * PALETTE.length) | 0].obox([px + oW[0] * 0.045 * s, gyL + 0.4 * s, pz + oW[2] * 0.045 * s], oW, up, eW, 0.04 * s, 0.06 * s, 0.004 * s);
            // SIGN TOWER: some downtown shops stack blade signs floor-by-floor up the facade (pencil-building wall
            // of neon) — the stack stops just under the building's own roofline.
            if (downtown && i === 0 && rng.chance(0.3)) for (let fy = 0.45 * s; fy < h - 0.08 * s; fy += 0.14 * s) accs[(rng.next() * PALETTE.length) | 0].obox([px + oW[0] * 0.05 * s, gyL + fy, pz + oW[2] * 0.05 * s], oW, up, eW, 0.038 * s, 0.055 * s, 0.004 * s);
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
