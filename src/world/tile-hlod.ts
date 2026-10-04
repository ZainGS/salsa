// ── Streamed-tile HLOD (performance-plan P17, engine-roadmap step 5) ───────────────────────────────────────────────
// Past the full-detail window a streamed tile is ONE simplified, merged representation built in the world worker:
//
//   MID ('mid', key "tx,tz|h") — the tile's building shells as a few merged meshes: every building lot extruded to the
//     height the FULL build gives it (the same per-lot RNG stream for the zone height + the downtown boost, and the
//     detailed path's archetype / storey rules), walls in the per-building facade colour the full build picks
//     (facadeFor + the region tint lean), quantised into at most MID_WALL_BUCKETS colour buckets with the windows
//     pattern, roofs by archetype (flat, parapet, hipped, mansard, a spire crown, a setback storey) in at most
//     MID_ROOF_BUCKETS colours, the tile's landmarks merged into those buckets, and the flat map merged into roads /
//     paving / park / water. ~10-14 draws a tile (the massing tier was 17), ~1-3 MB.
//   FAR ('far', key "tx,tz|f") — a SILHOUETTE: one coarse draped ground sheet + ONE wall mesh (the tile's wall-area-
//     weighted facade colour, windows pattern) + ONE roof mesh (roofs + landmarks, the roof-area-weighted colour).
//     3 draws a tile, ~0.6 MB. Meant
//     for the skyline past the fog's Far (Hard edge: flat fog colour, the GPU fast path) and for distant tiles.
//
// Everything is plain single-material meshes (no vertex colours, no textures), so every HLOD mesh is an ordinary
// GPU-driven record (gpu-scene.ts gdMeshCandidate). Names reuse the city's rules: walls `world:bldg-hlod-*` (baked,
// night windows by pattern mode), roofs `world:roofs-hlod-*`, ground `world:hlod-*` (fog class 'building': kept in
// the fog as silhouettes / continuous ground). Pure + deterministic (seeded by the tile graph only) → worker-safe.

import type { LayoutPreviewLayer, WorldGraph, Zone, V2, Lot } from './types';
import { CITY_FLOOR_M } from './types';
import { Accum3D } from './meshbuild';
import { makeRng, hash2, centroid, graphLookups } from './util';
import { buildingHeight, zoneArchetype, FLOOR_RANGE, TINTS, applyTint, pickRoof } from './streets';
import { cityPalette, facadeFor, applyRoofVariety } from './palette';
import { makeHeightField } from './elevation';
import { BUILDING_ARCHETYPES, mergeGeos, faceUOffsets } from './building';
import { buildLayoutPreview, ZONE_COLOR } from './preview';
import { buildLandmarks } from './landmarks';
import { buildWater } from './water';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

export type HlodLevel = 'mid' | 'far';
type C3 = [number, number, number];

/** Per-tile byte targets (vertex + index bytes of every layer). */
export const HLOD_BYTES = { mid: 5 * 1024 * 1024, far: 1024 * 1024 } as const;
/** Colour buckets of the mid level (each is one draw). */
export const MID_WALL_BUCKETS = 5;
export const MID_ROOF_BUCKETS = 3;
/** The far level's ground sheet resolution (cells per side). */
export const FAR_GROUND_CELLS = 20;

const BUILT_ZONES: readonly Zone[] = ['residential', 'commercial', 'civic'];

/** One building as the HLOD sees it. */
interface HBld { foot: V2[]; base: number; top: number; wall: C3; roof: C3; roofKind: 'flat' | 'parapet' | 'hip' | 'mansard' | 'spire'; step: boolean; mat: 0 | 1; weight: number; uo: number; pent?: { foot: V2[]; h: number } }

/** Vertex + index bytes of a layer list (the byte budget's measure). Shared geometry objects count once. */
export function hlodLayerBytes(layers: readonly LayoutPreviewLayer[]): number {
    const seen = new Set<object>();
    let b = 0;
    for (const L of layers) {
        const g = L.geometry;
        if (!g || seen.has(g)) continue;
        seen.add(g);
        b += g.vertices.byteLength + (g.indices ? g.indices.byteLength : 0);
    }
    return b;
}

// ── The buildings ────────────────────────────────────────────────────────────────────────────────────────────────

/** The variety-lot quota of buildStreets (construction / parking / gas claims: position hashes only, no RNG), so those
 *  lots are not raised as buildings here either. Mirrors streets.ts (VARIETY-LOT QUOTA). */
function varietyLots(graph: WorldGraph, distById: Map<number, string>, scale: number): Set<Lot> {
    const p = graph.params;
    const caps = { construction: 2, parking: 2, gas: 1 } as const;
    const cands: { lot: Lot; type: keyof typeof caps; rank: number }[] = [];
    for (const lot of graph.lots) {
        if (lot.slot !== 'building' && !lot.variety) continue;
        if (!BUILT_ZONES.includes(lot.zone) || lot.poly.length < 3) continue;
        if ((distById.get(lot.block) ?? 'mixed') === 'downtown') continue;
        if (lot.area <= 0.02 * scale * scale) continue;
        const special = hash2(lot.center[0] * 577.3, lot.center[1] * 401.7, (p.seed ^ 0x51fe) >>> 0);
        const type = special < 0.02 ? 'construction' : special < 0.04 ? 'parking' : special < 0.05 && lot.zone === 'commercial' ? 'gas' : null;
        if (!type) continue;
        cands.push({ lot, type, rank: hash2(lot.center[0] * 733.9, lot.center[1] * 269.3, (p.seed ^ 0x5a07) >>> 0) });
    }
    cands.sort((a, b) => a.rank - b.rank || a.lot.center[0] - b.lot.center[0] || a.lot.center[1] - b.lot.center[1]);
    const used = { construction: 0, parking: 0, gas: 0 };
    const out = new Set<Lot>();
    for (const cd of cands) if (used[cd.type] < caps[cd.type]) { used[cd.type]++; out.add(cd.lot); }
    return out;
}

/** Every building of the tile: footprint, base / roof height, facade + roof colour, roof kind. Heights follow the full
 *  build (buildStreets' per-lot stream: tint pick, zone height, downtown boost; the detailed path's archetype storey
 *  range); colours follow the detailed path's facade rules (or the box path's zone tints with detailed buildings off).
 *  Draws the full build makes from the per-lot stream AFTER the corner treatment cannot be replayed without building
 *  the footprint, so the archetype / storey jitter / tint roll use their own lot-hashed stream: the same
 *  distributions, not lot-for-lot the same picks. */
function tileBuildings(graph: WorldGraph): HBld[] {
    const p = graph.params, gy = p.groundY, scale = p.radius / 10;
    const hf = makeHeightField(p, p.tileOrigin ? [p.tileOrigin[0], p.tileOrigin[1]] : undefined);
    const PAL = cityPalette(p.seed, p.palette);
    const { regionByBlock, distByBlock } = graphLookups(graph);
    const dtc = graph.regions.find(r => r.type === 'downtown')?.center ?? null;
    const variety = varietyLots(graph, distByBlock, scale);
    const detailed = p.detailedBuildings ?? true;
    const regionTint = (region: number): number =>
        Math.floor(hash2(region * 131.7 + 3.1, region * 57.3 + 9.7, (p.seed ^ 0x9e37f21b) >>> 0) * TINTS.length) % TINTS.length;
    const zoneTint = (c: C3, i: number): C3 => i === 1 ? [Math.min(1, c[0] * 0.9 + 0.05), c[1] * 0.84, c[2] * 0.8]
        : i === 2 ? [Math.min(1, c[0] * 1.07), Math.min(1, c[1] * 1.07), Math.min(1, c[2] * 1.05)] : c;
    const floorU = 0.2 * scale, k = floorU / CITY_FLOOR_M;
    const inset = 0.06;
    const out: HBld[] = [];
    for (const lot of graph.lots) {
        if (lot.slot !== 'building' || lot.poly.length < 3 || variety.has(lot)) continue;
        if (!BUILT_ZONES.includes(lot.zone)) continue;
        // buildStreets' per-lot stream: the tint bucket, then the zone height.
        const rng = makeRng((p.seed ^ Math.floor(hash2(lot.center[0] * 97.31, lot.center[1] * 57.17, p.seed) * 0xfffffffe)) >>> 0);
        const bi = (rng.next() * 3) | 0;
        const district = distByBlock.get(lot.block) ?? 'mixed';
        let hMul = district === 'residential' ? 0.92 : 1;
        if (dtc) {
            const dd = Math.hypot(lot.center[0] - dtc[0], lot.center[1] - dtc[1]) / (p.radius * 0.55);
            hMul *= 1 + Math.max(0, 1 - dd) * (district === 'downtown' ? 0.85 : 0.35);
        }
        const h = buildingHeight(lot.zone, rng, scale) * hMul;
        const c = centroid(lot.poly);
        const foot: V2[] = lot.poly.map(q => [q[0] + (c[0] - q[0]) * inset, q[1] + (c[1] - q[1]) * inset] as V2);
        let minE = Infinity;
        for (const q of foot) minE = Math.min(minE, hf(q[0], q[1]));
        const base = gy + minE - 0.02 * scale, ground = gy + hf(c[0], c[1]);
        let area = 0;
        for (let i = 0; i < foot.length; i++) { const a = foot[i], b = foot[(i + 1) % foot.length]; area += a[0] * b[1] - b[0] * a[1]; }
        area = Math.abs(area) * 0.5;
        const lotSeed = Math.floor(hash2(lot.center[0] * 41.3, lot.center[1] * 29.9, p.seed) * 0x7fffffff);
        if (!detailed) {
            const own = makeRng((lotSeed ^ 0x3c1d) >>> 0);
            const st = p.roofStyle && p.roofStyle !== 'mixed' ? p.roofStyle : pickRoof(lot.zone, own, h > 0.85 * scale);
            const roofKind = st === 'pointed' || st === 'spire' ? 'hip' : st === 'mansard' ? 'mansard' : st === 'parapet' ? 'parapet' : 'flat';
            out.push({ foot, base, top: ground + h, wall: zoneTint(PAL[lot.zone as 'residential' | 'commercial' | 'civic'], bi), roof: PAL.roof, roofKind,
                step: st === 'tower', mat: lot.zone === 'civic' ? 1 : 0, weight: area * h, uo: lotSeed });
            continue;
        }
        // The detailed path (emitDetailedBuilding): archetype by zone / district / frontage, storeys in its range, the
        // facade material + swatch leaning to the region tint, the roof colour tinted with it.
        const own = makeRng((lotSeed ^ 0x51c3a7) >>> 0);
        const vh = (salt: number): number => hash2(lot.center[0] * 12.9 + salt * 3.1, lot.center[1] * 78.2 + salt * 1.7, (lotSeed ^ 0x7f4a2c9d) >>> 0);
        let frontM = 0;
        for (let i = 0; i < foot.length; i++) { const a = foot[i], b = foot[(i + 1) % foot.length]; frontM = Math.max(frontM, Math.hypot(b[0] - a[0], b[1] - a[1]) / k); }
        const archetype = zoneArchetype(lot.zone, own, district, frontM || 10);
        const floors = Math.max(1, Math.min(40, Math.round(h / floorU)));
        let vFloors = Math.max(1, Math.min(40, floors + Math.round((vh(1) - 0.5) * Math.max(2, floors * 0.4))));
        const range = FLOOR_RANGE[archetype];
        if (range) vFloors = Math.max(range[0], Math.min(range[1], vFloors));
        const bh = (CITY_FLOOR_M * (1.1 + vh(3) * 0.4) + (vFloors - 1) * CITY_FLOOR_M * (0.93 + vh(2) * 0.2)) * k;
        const arch = BUILDING_ARCHETYPES[archetype] ?? BUILDING_ARCHETYPES['office-block'];
        const rt = regionTint(regionByBlock.get(lot.block) ?? -1);
        const r = own.next();
        const ti = r > 0.80 ? Math.min(TINTS.length - 1, rt + 1) : r > 0.60 ? Math.max(0, rt - 1) : rt;
        const tint = TINTS[ti];
        const soft = { b: 0.5 + tint.b * 0.5, w: [tint.w[0] * 0.5, tint.w[1] * 0.5, tint.w[2] * 0.5] as C3 };
        const fac = facadeFor(archetype, district, vh(21), vh(22), ti, p.districtPalette ? { h3: vh(25) } : null);   // visual-polish #11 (as streets.ts)
        const wall: C3 = fac ? [fac.color[0], fac.color[1], fac.color[2]] : applyTint((arch.baseColor ?? [0.72, 0.74, 0.77]) as C3, soft);
        let roof = applyTint((arch.roofColor ?? [0.38, 0.39, 0.42]) as C3, tint);
        const cityRoof = p.roofStyle && p.roofStyle !== 'mixed' && vFloors <= 12 ? p.roofStyle : null;
        const rs = cityRoof === 'pointed' ? 'hip' : cityRoof === 'flat' || cityRoof === 'helipad' ? 'flat' : cityRoof === 'parapet' ? 'parapet' : cityRoof === 'mansard' ? 'mansard' : (arch.roofStyle ?? 'parapet');
        if (p.roofVariety) { const rb = { roofStyle: rs as string, roofColor: roof, roofGarden: false }; applyRoofVariety(rb, district, vFloors, vh(26), vh(27)); roof = rb.roofColor; }
        const roofKind: HBld['roofKind'] = arch.crown === 'spire' ? 'spire' : rs === 'gable' || rs === 'hip' || rs === 'tiled-hip' ? 'hip' : rs === 'mansard' ? 'mansard' : rs === 'parapet' ? 'parapet' : 'flat';
        const mat: 0 | 1 = fac ? (fac.material === 'brick' || fac.material === 'tile' ? 0 : 1) : (arch.material === 'brick' ? 0 : 1);
        // visual-polish #11 tail: a clustered roof's plant reads from afar as ONE stair box at a back corner (the mid level
        // draws it; the classic roof's scattered plant was never drawn here).
        const pent = p.roofEquipment === 'clustered' && (roofKind === 'flat' || roofKind === 'parapet') && (arch.roofPenthouse ?? true) && arch.crown !== 'mech'
            ? stairBox(foot, 2.6 * k, 2.5 * k) : undefined;
        out.push({ foot, base, top: ground + bh, wall, roof, roofKind, step: vFloors >= 12 && vh(6) > 0.5, mat, weight: area * bh, uo: lotSeed, ...(pent ? { pent } : {}) });
    }
    return out;
}

// ── Colour buckets (deterministic) ───────────────────────────────────────────────────────────────────────────────

/** visual-polish #11 tail: the clustered roof's stair box as the HLOD draws it — a `w`-wide square aligned with the
 *  footprint's first edge, about halfway from the centroid to that edge's first corner, `h` tall. Undefined when the
 *  roof is too small for it. */
function stairBox(foot: V2[], w: number, h: number): { foot: V2[]; h: number } | undefined {
    const c = centroid(foot), a = foot[0], b = foot[1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-9) return undefined;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, half = Math.min(w, L * 0.25) / 2;
    if (half < w * 0.3) return undefined;
    const m: V2 = [c[0] + (a[0] - c[0]) * 0.55, c[1] + (a[1] - c[1]) * 0.55];
    const q = (sx: number, sz: number): V2 => [m[0] + (ux * sx - uz * sz) * half, m[1] + (uz * sx + ux * sz) * half];
    return { foot: [q(-1, -1), q(1, -1), q(1, 1), q(-1, 1)], h };
}

/** Greedy weighted clustering of colours into at most `max` buckets: colours sorted by weight (ties by value), each
 *  joins the nearest bucket within `join` (weighted mean), else opens a bucket while there is room, else joins the
 *  nearest. Returns the bucket centres and, per input, its bucket. Pure + deterministic. */
export function bucketColours(cols: readonly C3[], weights: readonly number[], max: number, join = 0.07): { centres: C3[]; of: number[] } {
    const order = cols.map((_, i) => i).sort((a, b) => (weights[b] - weights[a]) || (cols[a][0] - cols[b][0]) || (cols[a][1] - cols[b][1]) || (cols[a][2] - cols[b][2]) || a - b);
    const sum: Array<[number, number, number, number]> = [];
    const centres: C3[] = [];
    const d2 = (a: C3, b: C3): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const nearest = (c: C3): number => { let bi = -1, bd = Infinity; for (let j = 0; j < centres.length; j++) { const d = d2(c, centres[j]); if (d < bd) { bd = d; bi = j; } } return bi; };
    for (const i of order) {
        const c = cols[i], w = Math.max(1e-9, weights[i]);
        let j = nearest(c);
        if (j < 0 || (d2(c, centres[j]) > join * join && centres.length < max)) { j = centres.length; centres.push([c[0], c[1], c[2]]); sum.push([0, 0, 0, 0]); }
        const s = sum[j];
        s[0] += c[0] * w; s[1] += c[1] * w; s[2] += c[2] * w; s[3] += w;
        centres[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    }
    return { centres, of: cols.map(c => nearest(c)) };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────────────────────────────────────────

const insetTo = (foot: V2[], k: number): V2[] => { const c = centroid(foot); return foot.map(q => [q[0] + (c[0] - q[0]) * k, q[1] + (c[1] - q[1]) * k] as V2); };

/** One building's roof into `roofs` (and a setback storey's walls into `walls`). Cheap stand-ins for buildRoof /
 *  the detailed roofs: the silhouette (pitch, parapet lip, crown) is what reads from a distance. */
function emitRoof(b: HBld, roofs: Accum3D, walls: Accum3D | null, s: number, cell: number): void {
    let top = b.top, foot = b.foot;
    if (b.step) {   // a taller block steps back: one smaller storey band on top
        const up = insetTo(foot, 0.22), hh = Math.min(0.35 * s, (b.top - b.base) * 0.16);
        if (walls) walls.wallsWin(up, top, hh, cell, cell);
        else roofs.walls(up, top, hh);
        roofs.cap(foot, top + 0.0018 * s, 1);
        foot = up; top += hh;
    }
    switch (b.roofKind) {
        case 'hip': {
            const c = centroid(foot);
            let rad = 0; for (const q of foot) rad += Math.hypot(q[0] - c[0], q[1] - c[1]); rad /= foot.length;
            roofs.pyramid(insetTo(foot, -0.06), top, Math.min(0.24 * s, rad * 0.55));
            break;
        }
        case 'mansard': {
            const i1 = insetTo(foot, 0.2);
            roofs.frustum(foot, i1, top, top + 0.085 * s); roofs.cap(i1, top + 0.085 * s, 1);
            break;
        }
        case 'parapet':
            roofs.walls(foot, top, 0.03 * s); roofs.cap(foot, top + 0.0018 * s, 1);
            break;
        case 'spire': {
            const sp = insetTo(foot, 0.3);
            roofs.cap(foot, top + 0.0018 * s, 1);
            roofs.pyramid(sp, top, 0.45 * s);
            break;
        }
        default:
            roofs.cap(foot, top + 0.0018 * s, 1);
    }
}

/** Merge layers' geometry by `key(layer)` into one layer per key (the first layer of a key gives the look). */
function mergeBy(layers: readonly LayoutPreviewLayer[], key: (L: LayoutPreviewLayer) => string | null, look: (key: string, first: LayoutPreviewLayer) => Omit<LayoutPreviewLayer, 'geometry'>): LayoutPreviewLayer[] {
    const by = new Map<string, { first: LayoutPreviewLayer; geos: MeshGeometry[] }>();
    for (const L of layers) {
        if (L.instances?.length || !L.geometry?.indices?.length) continue;   // world-baked only
        const k = key(L); if (k === null) continue;
        const e = by.get(k);
        if (e) e.geos.push(L.geometry); else by.set(k, { first: L, geos: [L.geometry] });
    }
    const out: LayoutPreviewLayer[] = [];
    for (const [k, { first, geos }] of by) out.push({ ...look(k, first), geometry: geos.length === 1 ? geos[0] : mergeGeos(geos) } as LayoutPreviewLayer);
    return out;
}

/** The far level's ground: a coarse grid sheet over the tile's border box (draped 'smooth' by the tile drape). */
function farGroundSheet(graph: WorldGraph, y: number, n: number): MeshGeometry {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const q of graph.border) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
    const acc = new Accum3D();
    const S = n + 1, idx: number[] = new Array(S * S);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const x = x0 + (x1 - x0) * (i / n), z = z0 + (z1 - z0) * (j / n);
        idx[j * S + i] = acc.vertex([x, y, z], [0, 1, 0], x * 0.5, z * 0.5);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = idx[j * S + i], b = idx[j * S + i + 1], c = idx[(j + 1) * S + i + 1], d = idx[(j + 1) * S + i];
        acc.triangle(a, c, b); acc.triangle(a, d, c);
    }
    return acc.geometry();
}

// ── The levels ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Build one tile's HLOD layers. `graph` = the tile's FULL layout (districts + landmarks; generateCityLayout without
 *  layoutOnly), already offset to the tile (offsetGraphGeometry) with params.tileOrigin stamped. The layers are
 *  pre-drape (the tile drape bakes the ground sheets and warps everything). */
export function buildTileHlod(graph: WorldGraph, level: HlodLevel): LayoutPreviewLayer[] {
    const p = graph.params, gy = p.groundY, s = p.radius / 10;
    const PAL = cityPalette(p.seed, p.palette);
    const blds = tileBuildings(graph);
    const winFreq = 62.5 / p.radius, cell = 1 / winFreq;
    const litFrac = p.nightMode ? 0.55 : 0;
    const lit: C3 = PAL.windowLit?.[0] ?? [1.0, 0.87, 0.55];
    const out: LayoutPreviewLayer[] = [];
    // Landmarks (the full tile's own geometry, merged by colour below; the ornament layers are dropped).
    const lm = graph.landmarks.length ? buildLandmarks(graph, null).filter(L => /world:lm-(stone|roof|dome|dark|glass|red)$/.test(L.name) && !L.instances?.length) : [];
    if (level === 'far') {
        // ONE wall mesh (the tile's wall-area-weighted facade colour, the windows pattern on world-unit UVs: lit at
        // night) + ONE roof mesh (the roof-area-weighted roof colour, + the landmark shells). From the air the roofs are
        // what reads, from the street the walls: one colour for both made far tiles a visibly darker, flatter plateau.
        const walls = new Accum3D(), roofs = new Accum3D();
        const wc = [0, 0, 0, 0], rc = [0, 0, 0, 0];
        for (const b of blds) {
            walls.walls(b.foot, b.base, b.top - b.base);
            emitRoof(b, roofs, null, s, cell);
            const fw = b.weight / Math.max(1e-6, b.top - b.base);   // footprint area
            wc[0] += b.wall[0] * b.weight; wc[1] += b.wall[1] * b.weight; wc[2] += b.wall[2] * b.weight; wc[3] += b.weight;
            rc[0] += b.roof[0] * fw; rc[1] += b.roof[1] * fw; rc[2] += b.roof[2] * fw; rc[3] += fw;
        }
        if (!walls.empty) out.push({ name: 'world:bldg-hlod-far', color: wc[3] > 0 ? [wc[0] / wc[3], wc[1] / wc[3], wc[2] / wc[3]] : PAL.commercial, y: gy, drape: 'baked',
            geometry: walls.geometry(), pattern: { color: lit, freq: winFreq, scale: 0.26, mode: 'windows', spacing: litFrac, angle: 1 } });
        const geos: MeshGeometry[] = roofs.empty ? [] : [roofs.geometry()];
        for (const L of lm) geos.push(L.geometry);
        if (geos.length) out.push({ name: 'world:roofs-hlod-far', color: rc[3] > 0 ? [rc[0] / rc[3], rc[1] / rc[3], rc[2] / rc[3]] : PAL.roof, y: gy, drape: 'baked', geometry: geos.length === 1 ? geos[0] : mergeGeos(geos) });
        // The ground: one coarse sheet a kerb above the road level, in the pavement / lot colour mix.
        const road = ZONE_COLOR.road;
        const gcol: C3 = [(PAL.sidewalk[0] * 2 + road[0]) / 3, (PAL.sidewalk[1] * 2 + road[1]) / 3, (PAL.sidewalk[2] * 2 + road[2]) / 3];
        out.unshift({ name: 'world:hlod-ground', color: gcol, y: gy, drape: 'smooth', geometry: farGroundSheet(graph, gy, FAR_GROUND_CELLS) });
        return out;
    }
    // ── MID ──
    // Ground: the flat map (built as for a flat-map tile: no kerb strips / dropped kerbs), merged into roads / paving
    // (pavements, courtyards, plaza and the built lots, which the buildings cover) / park, plus the tile's water.
    const flat = buildLayoutPreview({ ...graph, regions: [] } as WorldGraph);
    const groundKey = (L: LayoutPreviewLayer): string | null => L.name === 'world:roads' ? 'roads' : L.name === 'world:park' ? 'park'
        : /world:(sidewalks|courtyard|plaza|residential|commercial|civic)$/.test(L.name) ? 'paving' : null;
    out.push(...mergeBy(flat, groundKey, (k, f) => ({ name: `world:hlod-${k}`, color: k === 'paving' ? PAL.sidewalk : f.color, y: gy, drape: 'smooth' })));
    const water = buildWater(graph).filter(L => L.water && !L.instances?.length);
    if (water.length) out.push(...mergeBy(water, () => 'water', (_k, f) => ({ name: 'world:hlod-water', color: f.color, y: gy, drape: 'smooth', water: f.water })));
    // Walls: colour buckets × wall material (the windows pattern's brick / concrete switch).
    const wallB = bucketColours(blds.map(b => b.wall), blds.map(b => b.weight), MID_WALL_BUCKETS);
    const roofCols: C3[] = blds.map(b => b.roof), roofW = blds.map(b => b.weight);
    const lmCols: C3[] = lm.map(L => L.color);
    for (const L of lm) { const g = L.geometry; roofW.push(g.indices ? g.indices.length : 0); }
    const roofB = bucketColours([...roofCols, ...lmCols], roofW, MID_ROOF_BUCKETS, 0.09);
    // One wall mesh per colour bucket; its wall material (the windows pattern's brick / concrete switch) is the
    // bucket's weighted majority.
    const walls = wallB.centres.map(() => ({ acc: new Accum3D(), m0: 0, m1: 0 }));
    const roofs: Accum3D[] = roofB.centres.map(() => new Accum3D());
    blds.forEach((b, i) => {
        const w = walls[wallB.of[i]];
        if (b.mat) w.m1 += b.weight; else w.m0 += b.weight;
        w.acc.wallsWin(b.foot, b.base, b.top - b.base, cell, cell, { uOffset: faceUOffsets(b.uo, b.foot.length) });
        emitRoof(b, roofs[roofB.of[i]], w.acc, s, cell);
        if (b.pent && !b.step) { const r = roofs[roofB.of[i]]; r.walls(b.pent.foot, b.top, b.pent.h); r.cap(b.pent.foot, b.top + b.pent.h, 1); }   // visual-polish #11 tail
    });
    walls.forEach((w, i) => {
        if (w.acc.empty) return;
        out.push({ name: `world:bldg-hlod-${i}`, color: wallB.centres[i], y: gy, drape: 'baked', geometry: w.acc.geometry(),
            pattern: { color: lit, freq: winFreq, scale: 0.26, mode: 'windows', spacing: litFrac, angle: w.m1 > w.m0 ? 1 : 0 } });
    });
    const roofGeos: MeshGeometry[][] = roofs.map(r => r.empty ? [] : [r.geometry()]);
    lm.forEach((L, i) => roofGeos[roofB.of[roofCols.length + i]].push(L.geometry));
    roofGeos.forEach((gs, i) => {
        if (!gs.length) return;
        out.push({ name: `world:roofs-hlod-${i}`, color: roofB.centres[i], y: gy, drape: 'baked', geometry: gs.length === 1 ? gs[0] : mergeGeos(gs) });
    });
    return out;
}
