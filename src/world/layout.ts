// ── World generation — Phase 1: the LAYOUT composer ────────────────────────────────────────────
// Border silhouette → road network → blocks → lots → zoning → WorldGraph. Two strategies (§6.3):
//   • radial — a central plaza, arterials spoking out, concentric ring roads, wedge blocks (the Lumiose look).
//   • grid   — axis-aligned streets, rectangular blocks (cleaner, city-like).
// Everything is clipped to the (convex) border, so the pattern fills a circle / square / hexagon / octagon.
// The preview draws roads as the GAPS between inset lots (like a real city map); roads are also stored as
// centerlines for the later Street composer.

import {
    LayoutParams, DEFAULT_LAYOUT_PARAMS, WorldGraph, Block, Lot, RoadSegment, Zone, V2, Intersection, JunctionType, DistrictType,
} from './types';
import {
    makeRng, Rng, borderPolygon, maxRadius, bounds, clipConvex, clipSegmentToConvex, polyArea, centroid, annulusSector, pointInPolygon, hash2, valueNoise2D,
} from './util';
import { streetBandHalf } from './elevation';
import { placeLandmarks } from './landmarks';
import { placeShotengai } from './shotengai';

/** Smooth value noise over grid-cell coordinates → contiguous terrace patches (thresholded by the caller).
 *  Thin wrapper over the shared valueNoise2D — the 0.34 cell pre-scale is the only difference (bit-exact:
 *  ci·f is computed identically before the shared body runs). */
function cellNoise(ci: number, ri: number, seed: number): number {
    const f = 0.34;
    return valueNoise2D(ci * f, ri * f, seed);
}

/** Public entry: build a full city layout graph from (partial) params. Deterministic in `seed`.
 *  `opts.layoutOnly` skips the district / landmark / shotengai / pond PLACEMENT passes — the flat-map tiles of a
 *  tiled world only need roads/blocks/lots/zones for their top-down preview, so skipping this is a big per-tile
 *  win when generating dozens of neighbour tiles (regions/landmarks/etc. stay the empty arrays gridLayout set). */
export function generateCityLayout(partial: Partial<LayoutParams> = {}, opts?: { layoutOnly?: boolean }): WorldGraph {
    const params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS, ...partial };
    const rng = makeRng(params.seed);
    const border = borderPolygon(params.border, params.radius, params.borderSides);
    const Rmax = maxRadius(border) * 1.02;
    const graph = params.pattern === 'grid'
        ? gridLayout(params, rng, border, Rmax)
        : radialLayout(params, rng, border, Rmax);
    graph.bounds = bounds(border);
    if (opts?.layoutOnly) return graph;   // flat-map neighbour tiles: skip the expensive placement passes below
    assignDistricts(graph);
    graph.landmarks = placeLandmarks(graph);   // claims civic/market blocks + tags their lots (before builders run)
    graph.shotengai = placeShotengai(graph);   // a pedestrian street through the market (tags its corridor lots)
    graph.ponds = buildPonds(graph);
    return graph;
}

/** Voronoi districts: a central DOWNTOWN core + scattered residential/civic/market seeds → each block takes the
 *  nearest seed's character. Coarser than zone; drives signage density, big screens, balconies (+ landmarks later). */
function assignDistricts(graph: WorldGraph): void {
    const R = graph.params.radius, rng = makeRng((graph.params.seed ^ 0xd15701) >>> 0);
    const seeds: { p: V2; type: DistrictType }[] = [{ p: [rng.range(-R * 0.3, R * 0.3), rng.range(-R * 0.3, R * 0.3)], type: 'downtown' }];
    const pool: DistrictType[] = ['residential', 'residential', 'civic', 'market', 'residential', 'downtown'];
    const n = Math.max(3, Math.round(R / 3));
    for (let i = 1; i < n; i++) seeds.push({ p: [rng.range(-R, R), rng.range(-R, R)], type: pool[(i - 1) % pool.length] });
    graph.regions = seeds.map((s, i) => ({ id: i, type: s.type, center: s.p }));
    for (const b of graph.blocks) {
        const c = centroid(b.poly);
        let best = 0, bd = Infinity;
        for (let i = 0; i < seeds.length; i++) { const dx = c[0] - seeds[i].p[0], dz = c[1] - seeds[i].p[1], d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i; } }
        b.district = seeds[best].type;
        b.region = best;
    }
}

/** The region (Voronoi district instance) containing a world point — used to filter builds + resolve clicks. */
export function regionAt(graph: WorldGraph, x: number, z: number): number {
    let best = 0, bd = Infinity;
    for (const r of graph.regions) { const dx = x - r.center[0], dz = z - r.center[1], d = dx * dx + dz * dz; if (d < bd) { bd = d; best = r.id; } }
    return best;
}

/** Rounded ponds inside ~half the park blocks (organic ellipses) — the small-water-body counterpart to canals. */
function buildPonds(graph: WorldGraph): V2[][] {
    const rng = makeRng((graph.params.seed ^ 0x70edca) >>> 0);
    const out: V2[][] = [];
    for (const b of graph.blocks) {
        if (b.zone !== 'park' || b.poly.length < 3 || !rng.chance(0.55)) continue;
        const c = centroid(b.poly), bb = bounds(b.poly);
        const rx = (bb.max[0] - bb.min[0]) * 0.34, ry = (bb.max[1] - bb.min[1]) * 0.34;
        if (rx < 0.03 || ry < 0.03) continue;
        const n = 14, pond: V2[] = [];
        for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2, j = 0.82 + rng.next() * 0.3; pond.push([c[0] + Math.cos(a) * rx * j, c[1] + Math.sin(a) * ry * j]); }
        out.push(pond);
    }
    return out;
}

/** Zone for a block by its normalised distance-from-centre `d` (0 = plaza, 1 = edge), plus a seeded park/water roll. */
function pickZone(d: number, roll: number, params: LayoutParams): Zone {
    if (roll < params.waterChance) return 'water';
    if (roll < params.waterChance + params.parkChance) return 'park';
    if (d < 0.16) return 'civic';
    if (d < 0.48) return 'commercial';
    return 'residential';
}

const MIN_LOT_AREA = 1e-4;

// ── Radial (Lumiose-style) ───────────────────────────────────────────────────────────────────────
function radialLayout(params: LayoutParams, rng: Rng, border: V2[], Rmax: number): WorldGraph {
    const C: V2 = [0, 0];
    const plazaR = params.radius * params.plazaRadius;
    const S = Math.max(3, params.spokeCount | 0);
    const K = Math.max(1, params.ringCount | 0);
    const half = params.streetWidth * 0.5;
    const alley = params.streetWidth * 0.62;

    // Ring radii plazaR..Rmax (mild jitter), and spoke angles (even + mild jitter).
    const ringR: number[] = [plazaR];
    for (let k = 1; k <= K; k++) { const t = k / K; ringR.push((plazaR + (Rmax - plazaR) * t) * (1 + (rng.next() - 0.5) * 0.05)); }
    const a0 = rng.next() * Math.PI * 2;
    const spokeA: number[] = [];
    for (let s = 0; s < S; s++) spokeA.push(a0 + (s / S) * Math.PI * 2 + (rng.next() - 0.5) * (Math.PI / S) * 0.25);

    const roads: RoadSegment[] = [];
    for (let s = 0; s < S; s++) {
        const a = spokeA[s];
        roads.push({ a: [Math.cos(a) * plazaR, Math.sin(a) * plazaR], b: [Math.cos(a) * Rmax, Math.sin(a) * Rmax], width: params.arterialWidth, klass: 'arterial' });
    }
    for (let k = 1; k < ringR.length; k++) {
        const r = ringR[k]; const steps = Math.max(24, S * 4);
        for (let i = 0; i < steps; i++) {
            const t1 = (i / steps) * Math.PI * 2, t2 = ((i + 1) / steps) * Math.PI * 2;
            roads.push({ a: [Math.cos(t1) * r, Math.sin(t1) * r], b: [Math.cos(t2) * r, Math.sin(t2) * r], width: params.streetWidth * 1.6, klass: 'ring', ring: k });
        }
    }

    const blocks: Block[] = [];
    const lots: Lot[] = [];
    let blockId = 0;
    for (let k = 0; k < ringR.length - 1; k++) {
        const r0 = ringR[k], r1 = ringR[k + 1];
        const dNorm = (0.5 * (r0 + r1) - plazaR) / Math.max(1e-4, Rmax - plazaR);
        for (let s = 0; s < S; s++) {
            const t0 = spokeA[s];
            const t1 = (s + 1 < S ? spokeA[s + 1] : spokeA[0] + Math.PI * 2);
            const zone = pickZone(dNorm, rng.next(), params);
            // Block interior (inset off the ring + spoke roads).
            const br0 = r0 + half, br1 = r1 - half;
            const dθb = half / Math.max(1e-3, r0);
            const bt0 = t0 + dθb, bt1 = t1 - dθb;
            if (br1 <= br0 || bt1 <= bt0) { blockId++; continue; }
            const blockPoly = clipConvex(annulusSector(br0, br1, bt0, bt1), border);
            const block: Block = { id: blockId, poly: blockPoly, ring: k, sector: s, zone, lots: [] };
            // Subdivide the block interior into lots (inset each by an internal alley).
            const nr = Math.max(1, params.lotsRadial | 0), na = Math.max(1, params.lotsAngular | 0);
            for (let i = 0; i < nr; i++) {
                const lr0 = br0 + ((br1 - br0) * i) / nr + alley * 0.5;
                const lr1 = br0 + ((br1 - br0) * (i + 1)) / nr - alley * 0.5;
                if (lr1 <= lr0) continue;
                const dθa = alley * 0.5 / Math.max(1e-3, lr0);
                for (let j = 0; j < na; j++) {
                    const lt0 = bt0 + ((bt1 - bt0) * j) / na + dθa;
                    const lt1 = bt0 + ((bt1 - bt0) * (j + 1)) / na - dθa;
                    if (lt1 <= lt0) continue;
                    const poly = clipConvex(annulusSector(lr0, lr1, lt0, lt1), border);
                    if (poly.length < 3) continue;
                    const area = polyArea(poly);
                    if (area < MIN_LOT_AREA) continue;
                    const id = `L${blockId}_${i}_${j}`;
                    lots.push({ id, poly, center: centroid(poly), zone, slot: zoneToSlot(zone), block: blockId, area });
                    block.lots.push(id);
                }
            }
            if (blockPoly.length >= 3) blocks.push(block);
            blockId++;
        }
    }

    // Intersections = spoke × ring crossings (where the roads cross) — crosswalks + street lights hang off these.
    const intersections: Intersection[] = [];
    for (let s = 0; s < S; s++) {
        const a = spokeA[s]; const cd: V2 = [Math.cos(a), Math.sin(a)], td: V2 = [-Math.sin(a), Math.cos(a)];
        for (let k = 1; k < ringR.length; k++) {
            const r = ringR[k]; const p: V2 = [cd[0] * r, cd[1] * r];
            if (pointInPolygon(p, border)) intersections.push({ pos: p, arms: [cd, [-cd[0], -cd[1]], td, [-td[0], -td[1]]], type: 'cross' });
        }
    }

    const plaza = borderPolygon('octagon', plazaR, 8);
    return { params, border, center: C, radius: params.radius, roads, blocks, lots, intersections, regions: [], landmarks: [], shotengai: null, levels: null, ponds: [], bridges: [], plaza, bounds: bounds(border) };
}

// ── Grid ───────────────────────────────────────────────────────────────────────────────────────
function gridLayout(params: LayoutParams, rng: Rng, border: V2[], _Rmax: number): WorldGraph {
    const R = params.radius;
    const cols = Math.max(2, params.gridCols | 0), rows = Math.max(2, params.gridRows | 0);
    const cw = (2 * R) / cols, ch = (2 * R) / rows;
    const half = params.streetWidth * 0.5;
    const alley = params.streetWidth * 0.6;
    const x0 = (c: number): number => -R + c * cw, y0 = (r: number): number => -R + r * ch;

    // Road-segment presence grids. Border segments always survive; interior ones are removed (seeded) to make
    // T / corner junctions. hSeg[ci][r] = horizontal road at y0(r) over x0(ci)..x0(ci+1). vSeg[c][ri] = vertical.
    const hSeg: boolean[][] = [], vSeg: boolean[][] = [];
    for (let ci = 0; ci < cols; ci++) { hSeg[ci] = []; for (let r = 0; r <= rows; r++) hSeg[ci][r] = true; }
    for (let c = 0; c <= cols; c++) { vSeg[c] = []; for (let ri = 0; ri < rows; ri++) vSeg[c][ri] = true; }

    // Seeded removal — cap each cell at 2 removed sides so blocks never dissolve. Removing a road MERGES the two
    // cells it separated (they'll simply not inset on that side → touch → read as one block).
    const removed: number[][] = [];
    for (let ci = 0; ci < cols; ci++) { removed[ci] = new Array(rows).fill(0); }
    const pRemove = Math.max(0, Math.min(0.5, params.junctionVariety * 0.26));   // tuned: junctionVariety ≈ the resulting non-4-way fraction
    for (let ci = 0; ci < cols; ci++) for (let r = 1; r < rows; r++) {         // interior horizontals → merge (ci,r-1)|(ci,r)
        if (rng.next() >= pRemove || removed[ci][r - 1] >= 2 || removed[ci][r] >= 2) continue;
        hSeg[ci][r] = false; removed[ci][r - 1]++; removed[ci][r]++;
    }
    for (let c = 1; c < cols; c++) for (let ri = 0; ri < rows; ri++) {         // interior verticals → merge (c-1,ri)|(c,ri)
        if (rng.next() >= pRemove || removed[c - 1][ri] >= 2 || removed[c][ri] >= 2) continue;
        vSeg[c][ri] = false; removed[c - 1][ri]++; removed[c][ri]++;
    }

    // A grid cell is only "in the city" when its CENTRE is inside the border — canals/terraces draw from the raw
    // cell grid (not the clipped blocks), so without this they'd leak outside a circle/hex border.
    const cellInside = (ci: number, ri: number): boolean => pointInPolygon([x0(ci) + cw * 0.5, y0(ri) + ch * 0.5], border);

    // Canals: force a CONTIGUOUS run of cells to water (a straight canal) instead of scattering random water blocks.
    const canal = new Set<string>();
    const nCanals = R > 7 ? 2 : 1;
    for (let k = 0; k < nCanals; k++) {
        if (rng.next() < 0.5) {
            const c = 1 + Math.floor(rng.next() * Math.max(1, cols - 2));
            const start = Math.floor(rng.next() * rows * 0.3), len = Math.max(3, Math.floor(rows * (0.5 + rng.next() * 0.4)));
            for (let r = start; r < Math.min(rows, start + len); r++) if (cellInside(c, r)) canal.add(c + ',' + r);
        } else {
            const r = 1 + Math.floor(rng.next() * Math.max(1, rows - 2));
            const start = Math.floor(rng.next() * cols * 0.3), len = Math.max(3, Math.floor(cols * (0.5 + rng.next() * 0.4)));
            for (let c = start; c < Math.min(cols, start + len); c++) if (cellInside(c, r)) canal.add(c + ',' + r);
        }
    }

    // Terrace levels — a smooth-noise threshold gives a few CONTIGUOUS raised patches; boundaries fall on grid roads
    // (so retaining walls + stairs land cleanly on streets, not diagonally through blocks). Outside-border cells stay 0.
    const terraceOn = params.terraces ?? true;
    const levels: number[][] = [];
    const tseed = (params.seed ^ 0x7e44ace) >>> 0;
    for (let ci = 0; ci < cols; ci++) {
        levels[ci] = [];
        for (let ri = 0; ri < rows; ri++) { const nz = terraceOn && cellInside(ci, ri) ? cellNoise(ci, ri, tseed) : 0; levels[ci][ri] = nz > 0.78 ? (nz > 0.92 ? 2 : 1) : 0; }
    }
    // Canals sit a LEVEL BELOW the street (a cut canal) → the terrace pass gives the embankment walls + stairs down for free.
    if (terraceOn) for (const key of canal) { const p = key.split(',').map(Number); if (levels[p[0]]) levels[p[0]][p[1]] = -1; }

    // Roads = the surviving segments, CLIPPED to the border (everything downstream — paint, poles, trees, guardrails,
    // traffic routes — follows the roads array, so nothing escapes a circular border any more).
    const roads: RoadSegment[] = [];
    const pushRoad = (a: V2, b: V2, klass: 'arterial' | 'street'): void => {
        const seg = clipSegmentToConvex(a, b, border);
        if (!seg || Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]) < 0.05) return;
        roads.push({ a: seg[0], b: seg[1], width: params.streetWidth * 1.4, klass });
    };
    for (let ci = 0; ci < cols; ci++) for (let r = 0; r <= rows; r++) if (hSeg[ci][r]) pushRoad([x0(ci), y0(r)], [x0(ci + 1), y0(r)], r % 3 === 0 ? 'arterial' : 'street');
    for (let c = 0; c <= cols; c++) for (let ri = 0; ri < rows; ri++) if (vSeg[c][ri]) pushRoad([x0(c), y0(ri)], [x0(c), y0(ri + 1)], c % 3 === 0 ? 'arterial' : 'street');

    // Blocks + lots — inset each cell ONLY on sides that still have a road (removed sides touch the neighbour).
    const blocks: Block[] = [];
    const lots: Lot[] = [];
    let blockId = 0;
    const maxD = Math.hypot(R, R);
    for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
        const S = hSeg[ci][ri], N = hSeg[ci][ri + 1], W = vSeg[ci][ri], E = vSeg[ci + 1][ri];
        const bx0 = x0(ci) + (W ? half : 0), bx1 = x0(ci + 1) - (E ? half : 0);
        const by0 = y0(ri) + (S ? half : 0), by1 = y0(ri + 1) - (N ? half : 0);
        if (bx1 <= bx0 || by1 <= by0) { blockId++; continue; }
        const cxm = (bx0 + bx1) * 0.5, cym = (by0 + by1) * 0.5;
        const zone: Zone = canal.has(ci + ',' + ri) ? 'water' : pickZone(Math.hypot(cxm, cym) / maxD, rng.next(), { ...params, waterChance: 0 });
        const blockPoly = clipConvex([[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]], border);
        const block: Block = { id: blockId, poly: blockPoly, ring: ri, sector: ci, zone, level: levels[ci][ri], lots: [] };
        const nx = Math.max(1, params.lotsAngular | 0), ny = Math.max(1, params.lotsRadial | 0);
        for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
            const lx0 = bx0 + ((bx1 - bx0) * ix) / nx + alley * 0.5, lx1 = bx0 + ((bx1 - bx0) * (ix + 1)) / nx - alley * 0.5;
            const ly0 = by0 + ((by1 - by0) * iy) / ny + alley * 0.5, ly1 = by0 + ((by1 - by0) * (iy + 1)) / ny - alley * 0.5;
            if (lx1 <= lx0 || ly1 <= ly0) continue;
            const poly = clipConvex([[lx0, ly0], [lx1, ly0], [lx1, ly1], [lx0, ly1]], border);
            if (poly.length < 3) continue;
            const area = polyArea(poly); if (area < MIN_LOT_AREA) continue;
            const id = `L${blockId}_${ix}_${iy}`;
            lots.push({ id, poly, center: centroid(poly), zone, slot: zoneToSlot(zone), block: blockId, area });
            block.lots.push(id);
        }
        if (blockPoly.length >= 3) blocks.push(block);
        blockId++;
    }

    // Bridges — a deck wherever a surviving road runs BETWEEN two canal cells (a cross-street over the water).
    const bridges: V2[][] = [];
    const dw = params.streetWidth * 1.4 * 0.6;
    // ★ The deck must reach the BANK, and the bank is not the cell edge. `cellLevelAt` mins across a street
    // band, so the excavated trench — road hole, embankment wall, and now the water quad — runs
    // streetBandHalf OUTSIDE the canal cell on each side. A deck spanning cell edge to cell edge landed its
    // abutments in mid-air over the water with a ~5.6 m gap to the shore at BOTH ends. Extend the span (not
    // the width) by the same band so the abutments sit on land where they belong.
    const bandH = streetBandHalf(params);
    const isC = (ci: number, ri: number): boolean => canal.has(ci + ',' + ri);
    // A canal is not always one cell wide and not always straight. Two rules make the deck land properly:
    //   WALK  — extend across every consecutive cell where BOTH cells flanking the road are canal, so a
    //           two-cell-wide reach is spanned in one go. The test is AND, not OR: at an L-bend the
    //           perpendicular arm makes one flanking cell canal for its whole length, and OR would chase
    //           it and build a deck down the entire canal instead of across it.
    //   LAND  — after walking, both approaches must be dry. At that same L-bend the road on the far side
    //           runs along the other arm's bank, so the level system has it inside the trench and the road
    //           base is cut away there: a deck built to it would arrive at no road at all. Skip it — the
    //           other crossings along the arm still connect the two banks.
    for (let ci = 0; ci < cols; ci++) for (let r = 1; r < rows; r++) {
        if (!hSeg[ci][r] || !isC(ci, r - 1) || !isC(ci, r)) continue;
        let a = ci, b = ci + 1;
        while (a > 0 && isC(a - 1, r - 1) && isC(a - 1, r)) a--;
        while (b < cols && isC(b, r - 1) && isC(b, r)) b++;
        if (isC(a - 1, r - 1) || isC(a - 1, r) || isC(b, r - 1) || isC(b, r)) continue;   // approach is in the trench
        const y = y0(r), xa = x0(a) - bandH, xb = x0(b) + bandH;
        bridges.push([[xa, y - dw], [xb, y - dw], [xb, y + dw], [xa, y + dw]]);
    }
    for (let c = 1; c < cols; c++) for (let ri = 0; ri < rows; ri++) {
        if (!vSeg[c][ri] || !isC(c - 1, ri) || !isC(c, ri)) continue;
        let a = ri, b = ri + 1;
        while (a > 0 && isC(c - 1, a - 1) && isC(c, a - 1)) a--;
        while (b < rows && isC(c - 1, b) && isC(c, b)) b++;
        if (isC(c - 1, a - 1) || isC(c, a - 1) || isC(c - 1, b) || isC(c, b)) continue;
        const x = x0(c), za = y0(a) - bandH, zb = y0(b) + bandH;
        bridges.push([[x - dw, za], [x - dw, zb], [x + dw, zb], [x + dw, za]]);
    }

    // Intersections — interior nodes, typed by which arms survive.
    const intersections: Intersection[] = [];
    for (let c = 1; c < cols; c++) for (let r = 1; r < rows; r++) {
        const p: V2 = [x0(c), y0(r)];
        if (!pointInPolygon(p, border)) continue;
        const arms: V2[] = [];
        if (hSeg[c - 1][r]) arms.push([-1, 0]);
        if (hSeg[c][r]) arms.push([1, 0]);
        if (vSeg[c][r - 1]) arms.push([0, -1]);
        if (vSeg[c][r]) arms.push([0, 1]);
        const t = classifyJunction(arms);
        if (t) intersections.push({ pos: p, arms, type: t });
    }

    // No central plaza octagon in GRID cities (it read as an odd white disc under downtown) — radial keeps its hub.
    return { params, border, center: [0, 0], radius: R, roads, blocks, lots, intersections, regions: [], landmarks: [], shotengai: null, levels: terraceOn ? levels : null, ponds: [], bridges, plaza: null, bounds: bounds(border) };
}

/** Junction type from its surviving arms: 4 = cross · 3 = tee · 2 perpendicular = corner · else = not a junction. */
function classifyJunction(arms: V2[]): JunctionType | null {
    if (arms.length >= 4) return 'cross';
    if (arms.length === 3) return 'tee';
    if (arms.length === 2) { const dot = arms[0][0] * arms[1][0] + arms[0][1] * arms[1][1]; return Math.abs(dot) < 0.5 ? 'corner' : null; }
    return null;
}

function zoneToSlot(z: Zone): Lot['slot'] {
    return z === 'park' ? 'park' : z === 'water' ? 'water' : z === 'plaza' ? 'plaza' : 'building';
}
