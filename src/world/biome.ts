// ── World generation — Phase 2: the BIOME composer ──────────────────────────────────────────────
// Scatters low-poly 3D dressing onto the layout graph — the first real 3D on top of the flat map. Trees fill
// PARK lots densely, gardens dot RESIDENTIAL lots, and rocks sprinkle the parks. All seeded (deterministic)
// and merged into a few colour layers (foliage / trunks / rocks) so a whole forest is a handful of draws.
// Reads the graph the Layout composer produced; emits into the same flat-colour-group pipeline.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { makeRng, Rng, scatterInPolygon, centroid, pointInPolygon, hash2, bounds, graphLookups } from './util';
import { Accum3D } from './meshbuild';
import { buildCityFoliage, type TreePlacement, type TreeKind } from './city-foliage';
import { cityMetresPerUnit } from './types';
import { cellLevelAt } from './elevation';
import { regionAt } from './layout';
import { inShotengai } from './shotengai';

type V3 = [number, number, number];

const TRUNK_COLOR: [number, number, number] = [0.36, 0.26, 0.17];   // bark brown
const FOLIAGE_COLOR: [number, number, number] = [0.30, 0.55, 0.28]; // leaf green
const ROCK_COLOR: [number, number, number] = [0.55, 0.55, 0.58];    // grey stone
const SAKURA_COLOR: [number, number, number] = [0.95, 0.76, 0.84];  // cherry-blossom pink
const PLANTER_COLOR: [number, number, number] = [0.58, 0.40, 0.32]; // terracotta planter

/** A PLAYGROUND: swing frame (two A-legs + top bar + hanging seats) and a slide (ladder + sloped chute). */
function addPlayground(a: Accum3D, c: V2, gy: number, s: number): void {
    const up: [number, number, number] = [0, 1, 0], xA: [number, number, number] = [1, 0, 0], zA: [number, number, number] = [0, 0, 1];
    const fw = 0.045 * s, fh = 0.15 * s;   // ~2.25 m frame (was 0.75 m — waist-high)
    // Swing frame
    for (const sx of [-1, 1]) a.prism([c[0] + sx * fw, gy, c[1] - 0.03 * s], 0.0035 * s, 0.0035 * s, fh, 4);
    a.beam([c[0] - fw, gy + fh, c[1] - 0.03 * s], [c[0] + fw, gy + fh, c[1] - 0.03 * s], 0.003 * s, 4);
    for (const sx of [-0.45, 0.45]) {
        a.beam([c[0] + sx * fw * 2, gy + fh, c[1] - 0.03 * s], [c[0] + sx * fw * 2, gy + 0.03 * s, c[1] - 0.03 * s], 0.0012 * s, 3);   // chains
        a.obox([c[0] + sx * fw * 2, gy + 0.028 * s, c[1] - 0.03 * s], xA, up, zA, 0.007 * s, 0.0018 * s, 0.004 * s);                    // seat (~0.42 m)
    }
    // Slide: ladder + a sloped chute
    const sz0 = c[1] + 0.035 * s, sh = 0.09 * s;   // ~1.35 m platform
    a.prism([c[0] - 0.02 * s, gy, sz0], 0.003 * s, 0.003 * s, sh, 4);
    a.prism([c[0] - 0.012 * s, gy, sz0], 0.003 * s, 0.003 * s, sh, 4);
    a.quad4([c[0] - 0.016 * s - 0.006 * s, gy + sh, sz0], [c[0] - 0.016 * s + 0.006 * s, gy + sh, sz0],
        [c[0] + 0.05 * s + 0.006 * s, gy + 0.004 * s, sz0 + 0.012 * s], [c[0] + 0.05 * s - 0.006 * s, gy + 0.004 * s, sz0 + 0.012 * s]);
}

/** A FOUNTAIN: stone basin ring + a centre column with a small upper bowl, over an animated water disc. */
function addFountain(stone: Accum3D, water: Accum3D, c: V2, gy: number, s: number): void {
    const r = 0.05 * s;
    stone.prism([c[0], gy, c[1]], r + 0.008 * s, r + 0.008 * s, 0.014 * s, 12);          // basin wall
    water.disc([c[0], gy + 0.012 * s, c[1]], [0, 1, 0], r, 12);                          // pool (waves pattern)
    stone.prism([c[0], gy, c[1]], 0.007 * s, 0.007 * s, 0.05 * s, 6);                    // column
    stone.disc([c[0], gy + 0.05 * s, c[1]], [0, 1, 0], 0.018 * s, 8);                    // upper bowl
    water.blob([c[0], gy + 0.058 * s, c[1]], 0.008 * s, 0.01 * s, 0.008 * s, 0.2, 5);    // spout plume
}

/** A GAZEBO: six posts + a low rail + a hex pyramid roof with a finial. */
function addGazebo(a: Accum3D, wood: Accum3D, c: V2, gy: number, s: number): void {
    const r = 0.085 * s, n = 6, postH = 0.16 * s;   // ~2.55 m across, ~2.4 m posts (was 1.26 m / 0.68 m — a doll's gazebo)
    const pts: V2[] = [];
    for (let i = 0; i < n; i++) { const ang = (i / n) * Math.PI * 2; pts.push([c[0] + Math.cos(ang) * r, c[1] + Math.sin(ang) * r]); }
    for (const pt of pts) wood.prism([pt[0], gy, pt[1]], 0.005 * s, 0.005 * s, postH, 4);
    for (let i = 0; i < n; i++) { const q = pts[i], w = pts[(i + 1) % n]; wood.beam([q[0], gy + 0.06 * s, q[1]], [w[0], gy + 0.06 * s, w[1]], 0.002 * s, 3); }   // rail (~0.9 m)
    a.pyramid(pts, gy + postH, 0.03 * s);                                                // hex roof
    a.blob([c[0], gy + postH + 0.034 * s, c[1]], 0.005 * s, 0.006 * s, 0.005 * s, 0, 0); // finial
}

/** Build the biome dressing for a graph. Returns merged colour layers (empty ones omitted). */
export function buildBiome(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    // NOTE: deliberately NO composer-level RNG here — park trees/rocks + residential garden trees each draw from a
    // per-lot POSITION-HASH stream (lotRng below), so a region-filtered rebuild is a subset of the full build (it
    // never reshuffles scatter in lots it didn't rebuild). Matches the street-tree block + streets.ts discipline.
    const seed = graph.params.seed;
    const gy = graph.params.groundY;
    const scale = graph.radius / 10;                 // props sized relative to a radius-10 reference city
    const foliage = new Accum3D(), trunk = new Accum3D(), rock = new Accum3D(), sakura = new Accum3D(), planter = new Accum3D();
    const parkProp = new Accum3D(), fountainWater = new Accum3D();   // playground/gazebo frames + the fountain pool
    // ★ Trees are no longer accumulated as blobs — they are COLLECTED and handed to the real foliage
    // generator (city-foliage.ts), which builds a small pool of proper carded trees and GPU-instances them.
    // The generator authors in real metres; the city is a diorama, so it needs the conversion below.
    const trees: TreePlacement[] = [];
    const metersPerUnit = cityMetresPerUnit(graph.radius);
    const plant = (pos: V2, kind: TreeKind, sc = 1): void => { trees.push({ pos, y: gy, kind, scale: sc }); };
    // Pick a tree kind from a 0..1 roll, keeping roughly the old species mix (conifer-leaning parks).
    const kindFromRoll = (r: number): TreeKind => (r < 0.42 ? 'conifer' : r < 0.74 ? 'broadleaf' : r < 0.88 ? 'conifer' : 'bush');
    // ★ NEVER plant inside a building. Street trees are placed off the kerb by a fixed offset with no
    // regard for what is actually there, so on a shallow lot the offset lands inside the frontage — which
    // the old cone-and-sphere trees hid but a 6 m carded tree does not. Lots are convex quads, so a point
    // test against the built lots of nearby blocks is cheap. Parks/water are not built on, so they pass.
    const builtLots = graph.lots.filter(l => l.zone !== 'park' && l.zone !== 'water' && l.poly.length >= 3)
        .map(l => ({ poly: l.poly, b: bounds(l.poly) }));
    const inBuilding = (pt: V2): boolean => {
        for (const { poly, b } of builtLots) {
            if (pt[0] < b.min[0] || pt[0] > b.max[0] || pt[1] < b.min[1] || pt[1] > b.max[1]) continue;
            if (pointInPolygon(pt, poly)) return true;
        }
        return false;
    };
    const { regionByBlock } = graphLookups(graph);

    // Ponds sit INSIDE park blocks → reject any scatter point that lands in the water (no trees/rocks on the
    // pond). Pond AABBs are precomputed once per build; the cheap box reject skips the point-in-polygon test
    // for nearly every scatter point (same accept/reject result — the box only prunes guaranteed misses).
    const pondBB = graph.ponds.filter(pond => pond.length >= 3).map(pond => ({ pond, b: bounds(pond) }));
    const inWater = (pt: V2): boolean => {
        if (cellLevelAt(graph, pt[0], pt[1]) < 0) return true;   // canal / sunk cell — not just ponds
        for (const { pond, b } of pondBB) {
            if (pt[0] < b.min[0] || pt[0] > b.max[0] || pt[1] < b.min[1] || pt[1] > b.max[1]) continue;
            if (pointInPolygon(pt, pond)) return true;
        }
        return false;
    };

    for (const lot of graph.lots) {
        if (keep && !keep(regionByBlock.get(lot.block) ?? -1)) continue;
        // PER-LOT RNG, seeded by position: every scatter draw for this lot comes from its own stream (mirrors
        // streets.ts), so it's independent of visit order and the `keep` filter — selective regen stays idempotent.
        const lotRng = makeRng((seed ^ Math.floor(hash2(lot.center[0] * 97.31, lot.center[1] * 57.17, seed) * 0xfffffffe)) >>> 0);
        if (lot.zone === 'park') {
            const nTrees = Math.min(16, Math.max(1, Math.round(lot.area / (0.03 * scale * scale))));
            for (const p of scatterInPolygon(lot.poly, nTrees, lotRng)) if (!inWater(p)) plant(p, kindFromRoll(lotRng.next()));
            const nRocks = Math.min(4, Math.round(nTrees * 0.25));
            for (const p of scatterInPolygon(lot.poly, nRocks, lotRng)) if (!inWater(p)) addRock(rock, [p[0], gy, p[1]], lotRng, scale);
            // PARK PROP: bigger parks get one centrepiece — a playground, a fountain or a gazebo (parks stop
            // being just trees-on-grass). Seeded per lot; skipped if the centre landed in a pond.
            const pc = centroid(lot.poly);
            if (lot.area > 0.04 * scale * scale && !inWater(pc)) {
                const pick = hash2(pc[0] * 61.7, pc[1] * 43.9, (graph.params.seed ^ 0x9a7c) >>> 0);
                if (pick < 0.34) addPlayground(parkProp, pc, gy, scale);
                else if (pick < 0.67) addFountain(rock, fountainWater, pc, gy, scale);
                else addGazebo(parkProp, trunk, pc, gy, scale);
            }
        } else if (lot.zone === 'residential') {
            // A small GARDEN tree in the front setback — NOT the lot centroid (residential lots are BUILT, so the
            // centroid is inside the house). Nudge from a corner toward the centre so it sits in the setback strip;
            // skip if that still lands in the building. `k` is drawn unconditionally so this lot's stream is stable.
            if (lotRng.chance(0.3)) {
                const c = centroid(lot.poly), v = lot.poly[0];
                const g: V2 = [v[0] + (c[0] - v[0]) * 0.2, v[1] + (c[1] - v[1]) * 0.2];
                const k = kindFromRoll(lotRng.next());
                if (!inBuilding(g)) plant(g, k, 0.7);
            }
        }
        // civic / commercial / water: left clear (buildings + water dressing come later)
    }

    // STREET TREES + planters lining the roads (whole-city infra, like lamp posts — position-hash deterministic).
    if (graph.params.streetTrees ?? true) {
        const p = graph.params, half = p.streetWidth * 0.5, curb = half + 0.05 * scale;
        const overW = (x: number, z: number): boolean => cellLevelAt(graph, x, z) < 0 || !pointInPolygon([x, z], graph.border);
        graph.roads.forEach((road, ri) => {
            if (road.klass === 'alley' || road.klass === 'ring') return;
            const ax = road.a, dx = road.b[0] - ax[0], dz = road.b[1] - ax[1], len = Math.hypot(dx, dz);
            if (len < 0.8 * scale) return;
            const px = -dz / len, pz = dx / len, sp = 0.62 * scale, n = Math.floor(len / sp);
            for (let i = 0; i < n; i++) {
                const t = (i + 0.5) / n; if (t * len < half + 0.2 * scale || (1 - t) * len < half + 0.2 * scale) continue;
                if (hash2(ri, i, (p.seed ^ 0x77ee) >>> 0) > 0.5) continue;                       // ~half the slots → a tree-lined but not solid avenue
                const side = hash2(ri, i, (p.seed ^ 0x0051) >>> 0) < 0.5 ? 1 : -1;
                const x = ax[0] + dx * t + px * curb * side, z = ax[1] + dz * t + pz * curb * side;
                if (overW(x, z) || inBuilding([x, z])) continue;                       // never plant into a frontage
                if (keep && !keep(regionAt(graph, x, z) ?? -1)) continue;             // skip disabled regions (matches furniture)
                if (inShotengai(graph, x, z)) continue;                              // not in the pedestrian shotengai mall
                const tr = makeRng((p.seed ^ (ri * 131 + i * 17) ^ 0xa1) >>> 0);
                if (hash2(ri, i, (p.seed ^ 0x009c) >>> 0) < 0.14) addPlanter(planter, foliage, [x, gy, z], tr, scale);
                // street planting leans formal: broadleaf avenues with ~22% sakura
                else plant([x, z], hash2(ri, i, (p.seed ^ 0x003d) >>> 0) < 0.22 ? 'sakura' : 'broadleaf', 0.9);
            }
        });
    }

    const layers: LayoutPreviewLayer[] = [];
    // ★ REAL TREES (city-foliage.ts): a pool of generated carded trees, GPU-instanced per variant, carrying
    // the shared wind + leaf-translucency look. Replaces the cones-and-spheres that used to fill `foliage`.
    layers.push(...buildCityFoliage(trees, metersPerUnit, graph.params.seed,
        { leafColor: graph.params.leafColor, leafColorVar: graph.params.leafColorVar }));
    if (!trunk.empty) layers.push({ name: 'world:tree-trunks', color: TRUNK_COLOR, y: gy, geometry: trunk.geometry() });
    // `foliage` / `sakura` now only carry PLANTER greenery (addPlanter), not trees.
    if (!foliage.empty) layers.push({ name: 'world:tree-foliage', color: FOLIAGE_COLOR, y: gy, geometry: foliage.geometry(), pattern: { color: [0.22, 0.44, 0.21], freq: 7, scale: 0.55, mode: 'dots' } });
    if (!sakura.empty) layers.push({ name: 'world:tree-sakura', color: SAKURA_COLOR, y: gy, geometry: sakura.geometry(), pattern: { color: [0.99, 0.88, 0.92], freq: 7, scale: 0.55, mode: 'dots' } });
    if (!planter.empty) layers.push({ name: 'world:planter', color: PLANTER_COLOR, y: gy, geometry: planter.geometry() });
    // Granite, not flat grey: a boulder reads as a boulder because of the mineral speckle and the
    // roughness break-up. `jitter` is dropped to near-nothing — a rock has no courses to jitter.
    if (!rock.empty) layers.push({ name: 'world:rocks', color: ROCK_COLOR, y: gy, geometry: rock.geometry(),
        ground: { surface: 'granite', tint: ROCK_COLOR, tileMm: 2600, jitter: 0.15, metersPerUnit } });
    if (!parkProp.empty) layers.push({ name: 'world:park-prop', color: [0.72, 0.34, 0.28], y: gy, geometry: parkProp.geometry() });   // playground/gazebo (rusty red)
    // Fountain water: the same real water material, but a small basin — a much shorter swell, barely
    // choppy, and the strongest glitter in the city because it is the thing people look straight at.
    if (!fountainWater.empty) layers.push({ name: 'world:fountain-water', color: [0.40, 0.58, 0.72], y: gy, geometry: fountainWater.geometry(),
        water: { deep: [0.10, 0.28, 0.36], shallow: [0.46, 0.70, 0.74], waveScale: metersPerUnit / 0.35, waveSpeed: 1.3, choppy: 0.22, glitter: 1.5 } });
    return layers;
}

/** A street planter: a low terracotta tub + a small green shrub. */
function addPlanter(planter: Accum3D, foliage: Accum3D, base: V3, rng: Rng, scale: number): void {
    const w = 0.03 * scale;
    planter.prism(base, w, w, 0.032 * scale, 6);
    foliage.blob([base[0], base[1] + 0.055 * scale, base[2]], w * 1.15, 0.035 * scale, w * 1.15, 0.35, rng.next() * 1000);
}

/** A tree with per-planting VARIETY: conifer (stacked cones) · broadleaf (round canopy) · columnar cypress
 *  (tall narrow cone) · bush (low canopy cluster, no trunk). Seeded pick, weighted by where it grows. */
export function addTree(foliage: Accum3D, trunk: Accum3D, base: V3, rng: Rng, scale: number, kindRoll?: number): void {
    const r = kindRoll ?? rng.next();
    if (r < 0.42) {          // CONIFER — the original two-tier pine
        const h = (0.18 + rng.next() * 0.12) * scale;
        const tr = (0.012 + rng.next() * 0.008) * scale;
        trunk.prism(base, tr, tr, h, 4, rng.next() * Math.PI);
        const fr = (0.05 + rng.next() * 0.04) * scale, fh = (0.14 + rng.next() * 0.10) * scale;
        const fx: V3 = [base[0], base[1] + h * 0.7, base[2]];
        foliage.cone(fx, fr, fh, 6, rng.next() * Math.PI);
        foliage.cone([fx[0], fx[1] + fh * 0.45, fx[2]], fr * 0.7, fh * 0.75, 6, rng.next() * Math.PI);
    } else if (r < 0.74) {   // BROADLEAF — trunk + a clustered round canopy
        const h = (0.12 + rng.next() * 0.08) * scale;
        trunk.prism(base, 0.011 * scale, 0.011 * scale, h, 4, rng.next() * Math.PI);
        const cr = (0.055 + rng.next() * 0.035) * scale, cy = base[1] + h + cr * 0.5;
        foliage.blob([base[0], cy, base[2]], cr * 1.15, cr, cr * 1.15, 0.3, rng.next() * 991);
        foliage.blob([base[0] + cr * 0.5, cy - cr * 0.2, base[2] + cr * 0.3], cr * 0.7, cr * 0.6, cr * 0.7, 0.3, rng.next() * 887);
        foliage.blob([base[0] - cr * 0.45, cy - cr * 0.15, base[2] - cr * 0.35], cr * 0.65, cr * 0.55, cr * 0.65, 0.3, rng.next() * 773);
    } else if (r < 0.88) {   // COLUMNAR CYPRESS — tall, narrow, formal
        const h = (0.06 + rng.next() * 0.04) * scale;
        trunk.prism(base, 0.008 * scale, 0.008 * scale, h, 4, rng.next() * Math.PI);
        foliage.cone([base[0], base[1] + h * 0.6, base[2]], (0.026 + rng.next() * 0.012) * scale, (0.24 + rng.next() * 0.1) * scale, 6, rng.next() * Math.PI);
    } else {                 // BUSH — low canopy cluster, no trunk
        const cr = (0.03 + rng.next() * 0.02) * scale;
        foliage.blob([base[0], base[1] + cr * 0.7, base[2]], cr * 1.3, cr * 0.8, cr * 1.3, 0.35, rng.next() * 661);
        foliage.blob([base[0] + cr * 0.8, base[1] + cr * 0.5, base[2] - cr * 0.4], cr * 0.8, cr * 0.6, cr * 0.8, 0.35, rng.next() * 557);
    }
}

/** A small jittered boulder. */
export function addRock(rock: Accum3D, base: V3, rng: Rng, scale: number): void {
    const r = (0.02 + rng.next() * 0.03) * scale;
    rock.blob([base[0], base[1] + r * 0.5, base[2]], r, r * 0.7, r * 0.9, 0.35, rng.next() * 1000);
}

// (kept for future roadside placement: sample points along a road centerline)
export function _alongSegment(a: V2, b: V2, n: number): V2[] {
    const out: V2[] = [];
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    return out;
}
