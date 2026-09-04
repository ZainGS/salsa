// ── World generation — elevated railway ─────────────────────────────────────────────────────────
// The Tokyo set-piece: an ELEVATED RAILWAY VIADUCT running straight across the city (above a grid road line so
// its piers land on the street, not on buildings), carrying a low-poly TRAIN. Concrete piers + a deck slab +
// side girders + two rails, with a multi-car train parked at a seeded position. Whole-city infrastructure
// (not region-filtered); piers skip canal cells (the deck simply spans the water). All merged + deterministic.

import type { WorldGraph, LayoutPreviewLayer, BorderShape } from './types';
import { Accum3D } from './meshbuild';
import { cellLevelAt } from './elevation';
import { borderPolygon, clipSegmentToConvex } from './util';

const PIER: [number, number, number] = [0.55, 0.55, 0.58];    // concrete pier + cap
const DECK: [number, number, number] = [0.30, 0.30, 0.34];    // deck slab + girders
const RAIL: [number, number, number] = [0.46, 0.46, 0.49];    // steel rails
const TRAIN: [number, number, number] = [0.28, 0.50, 0.72];   // train livery
const TRAIN_DK: [number, number, number] = [0.12, 0.13, 0.16];// windows (lit at night)

/** The viaduct line for a params set — shared by the static build AND the traffic sim's moving train.
 *  The span is CLIPPED to the city border so the viaduct doesn't stick out of a circle/hex silhouette. */
export function railwayLine(p: { seed: number; gridCols: number; pattern: string; radius: number; groundY: number; border: BorderShape; borderSides: number }): { rx: number; z0: number; z1: number; deckY: number } {
    const R = p.radius, s = R / 10, cols = Math.max(2, p.gridCols | 0);
    const col = 2 + ((p.seed >>> 3) % Math.max(1, cols - 4));
    const rx = p.pattern === 'grid' ? -R + col * (2 * R / cols) : R * 0.18;   // over a grid road line (piers land on the street)
    let z0 = -R * 0.94, z1 = R * 0.94;
    const border = borderPolygon(p.border, R * 0.97, p.borderSides);
    const seg = clipSegmentToConvex([rx, z0], [rx, z1], border);
    if (seg) { z0 = seg[0][1]; z1 = seg[1][1]; }
    return { rx, z0: Math.min(z0, z1), z1: Math.max(z0, z1), deckY: p.groundY + 0.72 * s };
}

/** The SKY-TRAIN's multi-segment route (the cyber suite): a polyline that WEAVES across the city and runs
 *  dead-straight +X through the MEGATOWER's portal at its centre. Shared by the static guideway build AND the
 *  traffic sim's path-following train. Null unless `holograms` is on. */
export function skywayPath(graph: WorldGraph): { pts: [number, number][]; y: number } | null {
    const p = graph.params;
    if (!(p.holograms ?? false)) return null;
    const mt = graph.landmarks.find(l => l.type === 'megatower');
    const R = p.radius, s = R / 10;
    const c: [number, number] = mt ? mt.center : [0, 0];
    // Bent approach → straight portal segment (through c along +X) → bent exit. The bends are the "weave".
    const pts: [number, number][] = [
        [-R * 1.06, c[1] * 0.2 - R * 0.30],
        [c[0] - R * 0.35, c[1]],
        [c[0] + R * 0.35, c[1]],
        [R * 1.06, c[1] * 0.2 + R * 0.30],
    ];
    return { pts, y: p.groundY + 0.8 * s };
}

/** The sky-train's GUIDEWAY: a glowing maglev beam floating along the skyway polyline (no piers — it's the
 *  future). Routed heightless like the viaduct (`rail-` prefix). Empty unless `holograms` is on. */
export function buildSkyway(graph: WorldGraph): LayoutPreviewLayer[] {
    const sky = skywayPath(graph);
    if (!sky) return [];
    const s = graph.params.radius / 10, gy = graph.params.groundY;
    const beam = new Accum3D();
    const by = sky.y - 0.045 * s;   // just under the train belly
    for (let i = 0; i < sky.pts.length - 1; i++) beam.beam([sky.pts[i][0], by, sky.pts[i][1]], [sky.pts[i + 1][0], by, sky.pts[i + 1][1]], 0.012 * s, 4);
    // noWarp: the guideway follows its OWN polyline; the sky-train (also unwarped) rides the same line exactly.
    return [{ name: 'world:rail-sky', color: [0.30, 0.90, 1.0], y: gy, geometry: beam.geometry(), emissive: 1.2, opacity: 0.8, noWarp: true }];
}

export function buildRailway(graph: WorldGraph, includeTrain = true): LayoutPreviewLayer[] {
    const p = graph.params; if (!(p.railway ?? true)) return [];
    const gy = p.groundY, s = p.radius / 10;
    // The whole viaduct is LEVEL (rail-* layers are routed with NO height field — real railways don't roll with
    // the terrain). deckY clears the highest terrace + terrain; piers extend BELOW ground so their feet stay
    // buried wherever the terrain dips, instead of poking through the deck where it rises.
    const { rx, z0, z1, deckY } = railwayLine(p);
    const w = 0.06 * s;
    const zA: [number, number, number] = [0, 0, 1], up: [number, number, number] = [0, 1, 0], xA: [number, number, number] = [1, 0, 0];

    const pier = new Accum3D(), deck = new Accum3D(), rail = new Accum3D(), train = new Accum3D(), trainDk = new Accum3D();

    // Piers (skip canals — the deck spans them). Base buried; the cap OVERLAPS up INTO the deck slab so there's
    // never a gap between the pier top and the underside of the deck (the slab bottom is deckY - 0.012·s; the cap
    // top reaches deckY - 0.006·s, poking ~0.006·s into the slab where it's hidden).
    const nP = Math.max(3, Math.round((z1 - z0) / (1.1 * s)));
    const pierBase = gy - 0.3 * s, pierTop = deckY - 0.006 * s;
    for (let i = 0; i <= nP; i++) {
        const z = z0 + (z1 - z0) * i / nP;
        if (cellLevelAt(graph, rx, z) < 0) continue;
        pier.prism([rx, pierBase, z], 0.03 * s, 0.03 * s, pierTop - pierBase, 6);
        pier.obox([rx, pierTop - 0.012 * s, z], zA, up, xA, 0.006 * s, 0.012 * s, w * 1.4);   // pier cap — top overlaps into the slab (no gap)
    }

    // Deck slab + two side girders + two rails (continuous across the whole span).
    const dz = (z0 + z1) / 2, dl = (z1 - z0) / 2;
    deck.obox([rx, deckY, dz], zA, up, xA, dl, 0.012 * s, w);
    for (const sx of [-1, 1]) deck.beam([rx + sx * w, deckY + 0.008 * s, z0], [rx + sx * w, deckY + 0.008 * s, z1], 0.006 * s, 4);
    for (const sx of [-1, 1]) rail.beam([rx + sx * w * 0.4, deckY + 0.016 * s, z0], [rx + sx * w * 0.4, deckY + 0.016 * s, z1], 0.004 * s, 3);

    // Train — a few cars at a seeded position along the span. Skipped when the traffic sim runs its own MOVING train.
    if (includeTrain) {
        const nCars = 4, carL = 0.32 * s, gap = 0.02 * s, tot = nCars * (2 * carL + gap), cy = deckY + 0.052 * s;
        const startZ = z0 + ((p.seed >>> 7) % 1000) / 1000 * Math.max(0.001, (z1 - z0) - tot);
        for (let cIdx = 0; cIdx < nCars; cIdx++) {
            const cz = startZ + cIdx * (2 * carL + gap) + carL;
            train.obox([rx, cy, cz], zA, up, xA, carL, 0.042 * s, w * 0.82);          // body
            trainDk.obox([rx, cy + 0.012 * s, cz], zA, up, xA, carL * 0.92, 0.015 * s, w * 0.86);   // window band
        }
    }

    // The whole elevated viaduct opts OUT of the domain warp (noWarp): it's a rigid straight structure, and its
    // sparse geometry would approximate the warp curve far more coarsely than the moving train samples it — which
    // is exactly what made the train drift off the rails. Static rails + train mover now share pure layout space.
    const out: LayoutPreviewLayer[] = [];
    if (!pier.empty) out.push({ name: 'world:rail-pier', color: PIER, y: gy, geometry: pier.geometry(), noWarp: true });
    if (!deck.empty) out.push({ name: 'world:rail-deck', color: DECK, y: gy, geometry: deck.geometry(), noWarp: true });
    if (!rail.empty) out.push({ name: 'world:rail-track', color: RAIL, y: gy, geometry: rail.geometry(), noWarp: true });
    if (!train.empty) out.push({ name: 'world:rail-train', color: TRAIN, y: gy, geometry: train.geometry(), noWarp: true });
    if (!trainDk.empty) out.push({ name: 'world:rail-train-win', color: TRAIN_DK, y: gy, geometry: trainDk.geometry(), emissive: p.nightMode ? 0.95 : 0.5, noWarp: true });
    return out;
}
