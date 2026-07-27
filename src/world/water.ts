// ── World generation — water dressing ──────────────────────────────────────────────────────────
// Draws the water bodies. CANALS = the grid cells sunk to a lower terrace level (level < 0): drawn flat, the
// elevation post-transform sinks them one step and the road base is cut away over them (preview.fillGrid), so
// the water sits down in a real trench edged by the terrace embankment walls. PONDS (parks) + radial water have
// no trench, so they sit just ABOVE the ground as flat blue discs (with a railing). A bridge DECK spans each
// canal-crossing road. Reads the graph; emits merged colour layers.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { METAL_PAINTED } from './palette';
import { CITY_FLOOR_M } from './types';
import { polysToGeometry } from './preview';
import { Accum3D } from './meshbuild';
import { centroid, dist } from './util';
import { terraceStep, streetBandHalf } from './elevation';

type V3 = [number, number, number];

const WATER: [number, number, number] = [0.34, 0.52, 0.66];   // canal/pond blue
const RAIL: [number, number, number] = [0.58, 0.58, 0.62];    // metal railing
const DECK: [number, number, number] = [0.42, 0.38, 0.34];    // bridge deck (warm stone/timber)
const STONE: [number, number, number] = [0.56, 0.54, 0.50];   // bridge abutments + arch rib

export function buildWater(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params, gy = p.groundY, s = p.radius / 10, R = p.radius;
    const metalScale = 3 * (CITY_FLOOR_M / (0.2 * s));   // cycles per WORLD UNIT (the city is a diorama)
    const layers: LayoutPreviewLayer[] = [];

    // 1) SUNKEN CANALS = the grid cells at level < 0 (canal cells are forced to -1 in the layout). The floor level is
    //    BAKED into the Y here (gy - step) rather than left to cellLevelAt: a cell rect's far corners sit ON the terrace
    //    boundary, where cellLevelAt resolves to the NEIGHBOUR cell (level 0) and would tilt the quad out of the trench.
    //    The 'canal' name routes it through the WorldManager smooth-only drape (like the walls), so the flat floor meets
    //    the embankment wall base exactly. The road base has a matching HOLE cut over these cells (preview.fillGrid).
    const canalCells: V2[][] = [];
    const lv = graph.levels;
    if (lv) {
        const cols = p.gridCols, rows = p.gridRows, cw = 2 * R / cols, ch = 2 * R / rows;
        const cx = (c: number): number => -R + c * cw, cz = (r: number): number => -R + r * ch;
        const isCanal = (ci: number, ri: number): boolean => (lv[ci]?.[ri] ?? 0) < 0;
        // ★ THE TRENCH IS WIDER THAN THE CELL. `cellLevelAt` takes the MIN across a street band so a
        // carriageway never steps mid-road — and at a canal edge that means the whole band resolves to the
        // canal's level. The road HOLE (preview.fillGrid) and the embankment WALL (terraces.ts) both follow
        // that dilated line, sitting streetBandHalf outside the cell. A water quad built at raw cell width
        // therefore stopped ~5.6 m short of the wall on BOTH banks — 20.6% of the span at each end, +41%
        // overall — leaving a bare strip you could see straight through.
        //
        // So push every cell edge that faces LAND out to the same line the trench uses. Edges facing
        // another canal cell stay put: expanding those too would overlap the neighbour's quad at an
        // identical Y and z-fight.
        const band = streetBandHalf(p);
        for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
            if (!isCanal(ci, ri)) continue;
            const xa = cx(ci) - (isCanal(ci - 1, ri) ? 0 : band);
            const xb = cx(ci + 1) + (isCanal(ci + 1, ri) ? 0 : band);
            const za = cz(ri) - (isCanal(ci, ri - 1) ? 0 : band);
            const zb = cz(ri + 1) + (isCanal(ci, ri + 1) ? 0 : band);
            canalCells.push([[xa, za], [xb, za], [xb, zb], [xa, zb]]);
        }
    }
    const canalY = gy - terraceStep(p);   // one terrace step below street (canal cells are level -1)

    // 2) SHALLOW WATER = ponds (in parks) + any radial 'water' lots (no terraces there). There's no trench to sink
    //    into, so these sit just ABOVE the local ground — a flat blue disc on the map — rather than hiding beneath it.
    const flat: V2[][] = graph.ponds.filter(poly => poly.length >= 3);
    if (!canalCells.length) for (const l of graph.lots) if (l.zone === 'water' && l.poly.length >= 3) flat.push(l.poly);

    if (!canalCells.length && !flat.length && !graph.bridges.length) return [];

    // ★ REAL WATER (material bit 21) instead of the old animated wave BANDS. Those scrolled a colour
    // across the albedo, so the surface never caught the light — no shimmer is possible when nothing
    // touches the normal. Now: a ripple normal from four rotated sine octaves plus a fine chop, Fresnel
    // toward the scene's sky/fog colour, and a tight specular lobe for the sun glitter.
    //
    // waveScale is CYCLES PER WORLD UNIT and the city is a diorama (1 unit = CITY_FLOOR_M / (0.2·s) m,
    // i.e. 15 m at the default radius). A ~1.4 m swell is therefore about 10 cycles/unit — derived here
    // rather than hardcoded so it stays right if the city's radius changes.
    const mPerUnit = CITY_FLOOR_M / (0.2 * s);
    const swellM = 1.4;                                   // metres between crests
    const water = {
        deep: [0.045, 0.17, 0.26] as [number, number, number],
        shallow: [0.30, 0.58, 0.62] as [number, number, number],
        waveScale: mPerUnit / swellM,
        waveSpeed: 0.85,
        choppy: 0.45,
        glitter: 1.15,
    };
    if (canalCells.length) layers.push({ name: 'world:canal', color: WATER, y: canalY, geometry: polysToGeometry(canalCells, canalY), water: { ...water } });
    // A pond is sheltered — shorter swell, calmer, a touch greener than a canal.
    if (flat.length) { const y = gy + 0.012 * s; layers.push({ name: 'world:pond', color: WATER, y, geometry: polysToGeometry(flat, y), water: { ...water, waveScale: water.waveScale * 1.5, choppy: 0.33, waveSpeed: 0.6, shallow: [0.33, 0.58, 0.55] } }); }

    // Railings only around the SHALLOW water (canals are edged by the terrace wall-top rail from the terrace pass).
    const posts = new Accum3D(), rail = new Accum3D();
    for (const poly of flat) addRailing(posts, rail, poly, gy, s);
    if (!posts.empty) layers.push({ name: 'world:water-railposts', color: RAIL, y: gy, geometry: posts.geometry() , metal: { ...METAL_PAINTED, scale: metalScale }});
    if (!rail.empty) layers.push({ name: 'world:water-rail', color: RAIL, y: gy, geometry: rail.geometry() , metal: { ...METAL_PAINTED, scale: metalScale }});

    // Bridges: proper ARCHED bridges where a cross-street spans the canal — a cambered deck, stone abutments at
    // both banks, an arch rib underneath, and railings that follow the camber. (Was: a flat brown rectangle.)
    if (graph.bridges.length) {
        const deckA = new Accum3D(), stone = new Accum3D(), rp = new Accum3D(), rb = new Accum3D();
        const paint = new Accum3D(), lamps = new Accum3D();
        for (const deck of graph.bridges) addArchBridge(deckA, stone, rp, rb, paint, lamps, deck, gy, s);
        if (!deckA.empty) layers.push({ name: 'world:bridge', color: DECK, y: gy, geometry: deckA.geometry(), pattern: { color: [DECK[0] * 0.82, DECK[1] * 0.82, DECK[2] * 0.82], freq: 30, scale: 0.12, mode: 'grid' } });   // paving joints
        if (!stone.empty) layers.push({ name: 'world:bridge-stone', color: STONE, y: gy, geometry: stone.geometry(), pattern: { color: [STONE[0] * 0.75, STONE[1] * 0.75, STONE[2] * 0.75], freq: 22, scale: 0.3, mode: 'grid', spacing: 1 } });   // masonry courses (shingle-stagger variant)
        if (!rp.empty) layers.push({ name: 'world:bridge-railpost', color: RAIL, y: gy, geometry: rp.geometry() , metal: { ...METAL_PAINTED, scale: metalScale }});
        if (!rb.empty) layers.push({ name: 'world:bridge-rail', color: RAIL, y: gy, geometry: rb.geometry() , metal: { ...METAL_PAINTED, scale: metalScale }});
        if (!paint.empty) layers.push({ name: 'world:bridge-paint', color: [0.88, 0.87, 0.82], y: gy, geometry: paint.geometry() });     // centre dashes + kerb lines
        if (!lamps.empty) layers.push({ name: 'world:bridge-lamplights', color: [1.0, 0.92, 0.62], y: gy, geometry: lamps.geometry(), emissive: 0.9 });   // matches the /lamplights/ glow row
    }

    return layers;
}

/** An arched canal bridge built over the layout's deck rectangle: cambered deck (paving joints), a proper
 *  MASONRY FASCIA whose lower edge sweeps an arch opening (deep at the banks, thin at mid-span), a stone
 *  PARAPET base with dense balustrade posts + double rails, CENTRE DASHES + kerb lines, ornate LAMPS, stone
 *  abutments, and — on long spans — CUTWATER PIERS standing in the water. */
function addArchBridge(deck: Accum3D, stone: Accum3D, posts: Accum3D, rail: Accum3D, paint: Accum3D, lamps: Accum3D, quad: V2[], gy: number, s: number): void {
    if (quad.length < 4) return;
    // The layout's deck quad: find the long (span) axis and the width axis.
    const e0 = dist(quad[0], quad[1]), e1 = dist(quad[1], quad[2]);
    const A = e0 >= e1 ? quad[0] : quad[1], B = e0 >= e1 ? quad[1] : quad[2];
    const spanLen = Math.max(e0, e1), width = Math.min(e0, e1);
    const c = centroid(quad);
    const d: V2 = [(B[0] - A[0]) / spanLen, (B[1] - A[1]) / spanLen];   // span direction
    const p2: V2 = [-d[1], d[0]];                                        // width direction
    const half = spanLen * 0.5, wHalf = width * 0.5;
    const rise = Math.min(0.045 * s, half * 0.18);                       // camber height at mid-span
    const N = 10, thick = 0.012 * s, railH = 0.045 * s, r = 0.0045 * s;
    const dW: V3 = [d[0], 0, d[1]], up: V3 = [0, 1, 0], pW: V3 = [p2[0], 0, p2[1]];
    const at = (t: number, w: number): V2 => [c[0] + d[0] * (t * 2 - 1) * half + p2[0] * w, c[1] + d[1] * (t * 2 - 1) * half + p2[1] * w];
    const camber = (t: number): number => gy + 0.008 * s + rise * (1 - (t * 2 - 1) * (t * 2 - 1));   // parabolic
    // The fascia's LOWER edge: deep into the banks at the ends, rising to just under the deck at mid-span —
    // the classic masonry ARCH OPENING silhouette seen from the water.
    const archBottom = (t: number): number => {
        const o = 1 - (t * 2 - 1) * (t * 2 - 1);                          // 0 at ends → 1 at mid
        const openness = Math.pow(Math.max(0, o), 0.65);
        return (gy - 0.055 * s) * (1 - openness) + (camber(t) - thick - 0.006 * s) * openness;
    };
    for (let i = 0; i < N; i++) {
        const t0 = i / N, t1 = (i + 1) / N, y0 = camber(t0), y1 = camber(t1);
        const a0 = at(t0, -wHalf), b0 = at(t0, wHalf), a1 = at(t1, -wHalf), b1 = at(t1, wHalf);
        deck.quad4([a0[0], y0, a0[1]], [b0[0], y0, b0[1]], [b1[0], y1, b1[1]], [a1[0], y1, a1[1]]);                     // deck surface
        deck.quad4([a0[0], y0 - thick, a0[1]], [a1[0], y1 - thick, a1[1]], [b1[0], y1 - thick, b1[1]], [b0[0], y0 - thick, b0[1]]);   // soffit
        for (const side of [-1, 1]) {
            // MASONRY FASCIA: from the deck edge down to the arch-opening curve (stone layer → courses pattern).
            const s0 = at(t0, wHalf * side), s1 = at(t1, wHalf * side);
            stone.quad4([s0[0], y0, s0[1]], [s1[0], y1, s1[1]], [s1[0], archBottom(t1), s1[1]], [s0[0], archBottom(t0), s0[1]]);
            // STONE PARAPET base strip (a low solid wall under the balustrade).
            const q0 = at(t0, (wHalf - 0.004 * s) * side), q1 = at(t1, (wHalf - 0.004 * s) * side);
            stone.obox([(q0[0] + q1[0]) / 2, (y0 + y1) / 2 + 0.007 * s, (q0[1] + q1[1]) / 2], dW, up, pW, dist(q0, q1) * 0.52, 0.007 * s, 0.005 * s);
            // Balustrade: DENSE posts (two per segment) + double rails following the camber.
            const m0 = at((t0 + t1) / 2, (wHalf - 0.006 * s) * side), ym = camber((t0 + t1) / 2);
            const r0 = at(t0, (wHalf - 0.006 * s) * side), r1 = at(t1, (wHalf - 0.006 * s) * side);
            rail.beam([r0[0], y0 + railH, r0[1]], [r1[0], y1 + railH, r1[1]], r * 0.8, 4);
            rail.beam([r0[0], y0 + railH * 0.55, r0[1]], [r1[0], y1 + railH * 0.55, r1[1]], r * 0.6, 4);
            posts.prism([r0[0], y0 + 0.012 * s, r0[1]], r, r, railH - 0.010 * s, 4);
            posts.prism([m0[0], ym + 0.012 * s, m0[1]], r * 0.8, r * 0.8, railH - 0.012 * s, 4);
            if (i === N - 1) posts.prism([r1[0], y1 + 0.012 * s, r1[1]], r, r, railH - 0.010 * s, 4);
        }
        // CENTRE DASHES (every other segment) + thin kerb lines along both deck edges.
        if (i % 2 === 0) {
            const m0 = at(t0 + 0.02 / N, 0), m1 = at(t1 - 0.02 / N, 0);
            paint.quad4([m0[0] - p2[0] * 0.004 * s, camber(t0) + 0.0015 * s, m0[1] - p2[1] * 0.004 * s],
                [m0[0] + p2[0] * 0.004 * s, camber(t0) + 0.0015 * s, m0[1] + p2[1] * 0.004 * s],
                [m1[0] + p2[0] * 0.004 * s, camber(t1) + 0.0015 * s, m1[1] + p2[1] * 0.004 * s],
                [m1[0] - p2[0] * 0.004 * s, camber(t1) + 0.0015 * s, m1[1] - p2[1] * 0.004 * s]);
        }
        for (const side of [-1, 1]) {
            const k0 = at(t0, (wHalf - 0.014 * s) * side), k1 = at(t1, (wHalf - 0.014 * s) * side);
            paint.quad4([k0[0] - p2[0] * 0.0018 * s, y0 + 0.0012 * s, k0[1] - p2[1] * 0.0018 * s],
                [k0[0] + p2[0] * 0.0018 * s, y0 + 0.0012 * s, k0[1] + p2[1] * 0.0018 * s],
                [k1[0] + p2[0] * 0.0018 * s, y1 + 0.0012 * s, k1[1] + p2[1] * 0.0018 * s],
                [k1[0] - p2[0] * 0.0018 * s, y1 + 0.0012 * s, k1[1] - p2[1] * 0.0018 * s]);
        }
    }
    // Stone ABUTMENTS with pilaster caps at both banks.
    for (const end of [0, 1]) {
        const e = at(end, 0), y = camber(end);
        stone.obox([e[0], y - 0.05 * s, e[1]], dW, up, pW, 0.02 * s, 0.05 * s, wHalf * 1.06);
        for (const side of [-1, 1]) {
            const pe = at(end, (wHalf - 0.002 * s) * side);
            stone.obox([pe[0], y + 0.028 * s, pe[1]], dW, up, pW, 0.012 * s, 0.028 * s, 0.012 * s);   // pilaster
            stone.obox([pe[0], y + 0.058 * s, pe[1]], dW, up, pW, 0.015 * s, 0.004 * s, 0.015 * s);   // cap
        }
    }
    // ORNATE LAMPS at the abutment pilasters + mid-span: slim post + warm glowing head.
    for (const lt of [0.04, 0.5, 0.96]) {
        for (const side of [-1, 1]) {
            const lp = at(lt, (wHalf - 0.01 * s) * side), ly = camber(lt);
            posts.prism([lp[0], ly, lp[1]], 0.0035 * s, 0.0035 * s, 0.075 * s, 4);
            lamps.blob([lp[0], ly + 0.08 * s, lp[1]], 0.009 * s, 0.011 * s, 0.009 * s, 0, 0);
        }
    }
    // CUTWATER PIERS on long spans: stone piers standing in the canal with pointed noses (diamond section).
    if (spanLen > 1.1 * s) {
        for (const pt of [1 / 3, 2 / 3]) {
            const pp = at(pt, 0);
            const diag: V3 = [(d[0] + p2[0]) * 0.7071, 0, (d[1] + p2[1]) * 0.7071];
            const diag2: V3 = [(d[0] - p2[0]) * 0.7071, 0, (d[1] - p2[1]) * 0.7071];
            stone.obox([pp[0], (gy - 0.3 * s + camber(pt) - thick) / 2, pp[1]], diag, up, diag2,
                0.035 * s, (camber(pt) - thick - (gy - 0.3 * s)) / 2, 0.035 * s);   // diamond pier (pointed cutwaters both ways)
        }
    }
}

/** Post-and-rail railing around a water-body polygon, offset outward onto the walkway. */
function addRailing(posts: Accum3D, rail: Accum3D, poly: V2[], gy: number, s: number): void {
    const c = centroid(poly), off = 0.018 * s, railH = 0.05 * s, r = 0.005 * s, spacing = 0.28 * s;
    const out = (p: V2): V2 => { const dx = p[0] - c[0], dz = p[1] - c[1], l = Math.hypot(dx, dz) || 1; return [p[0] + (dx / l) * off, p[1] + (dz / l) * off]; };
    for (let i = 0; i < poly.length; i++) {
        const a = out(poly[i]), b = out(poly[(i + 1) % poly.length]), len = dist(a, b), n = Math.max(1, Math.floor(len / spacing));
        for (let k = 0; k <= n; k++) { const t = k / n; posts.prism([a[0] + (b[0] - a[0]) * t, gy, a[1] + (b[1] - a[1]) * t], r, r, railH, 4); }
        rail.beam([a[0], gy + railH, a[1]], [b[0], gy + railH, b[1]], r * 0.8, 4);
    }
}
