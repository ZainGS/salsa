// ── World generation — Phase 3: the STREET / BUILDING composer ──────────────────────────────────
// The payoff pass: extrude each building lot's footprint UP into a massed building (walls + a slate roof),
// height by zone (civic tall → commercial mid → residential low), with per-building CORNER STYLE (sharp /
// chamfer / round — the Shibuya-109 look). Then street furniture: lamp posts along the arterials + taller
// STREET LIGHTS with an arm over each intersection. Still merged per-colour (a few draws total).

import { CITY_FLOOR_M, type WorldGraph, type LayoutPreviewLayer, type Zone, type V2, type CornerStyle, type RoofStyle, type Lot } from './types';
import { makeRng, Rng, chamferPolygon, roundPolygon, centroid, polyArea, frontageEdge, hash2, graphLookups } from './util';
import { Accum3D } from './meshbuild';
import { buildBuilding, resolveBuildingParams, xformGeo, mergeGeos } from './building';
import type { BuildingParams, DoorStyle } from './building';
import { ZONE_COLOR } from './preview';
import { cellLevelAt, makeElevation } from './elevation';
import { cityPalette, METAL_PAINTED, METAL_GALVANISED, METAL_POLE } from './palette';

type V3 = [number, number, number];

const ROOF_COLOR: [number, number, number] = [0.42, 0.40, 0.45];  // slate
const ROOF_DETAIL: [number, number, number] = [0.16, 0.16, 0.19]; // antennas / dishes / spires / helipad pad / facade pipes
const ROOF_EQUIP: [number, number, number] = [0.52, 0.54, 0.58];  // rooftop water tanks / AC condensers / facade AC boxes
const ROOF_MARK: [number, number, number] = [0.90, 0.90, 0.84];   // helipad H marking
const POST_COLOR: [number, number, number] = [0.20, 0.20, 0.24];  // dark metal
const LAMP_COLOR: [number, number, number] = [1.0, 0.92, 0.62];   // warm bulb (half-emissive → glows)
const BALCONY_COLOR: [number, number, number] = [0.66, 0.64, 0.60];   // concrete balcony slab
const SCREEN_COLORS: [number, number, number][] = [[0.10, 0.80, 0.92], [0.92, 0.20, 0.62], [0.60, 0.30, 0.95], [0.98, 0.86, 0.55]];   // big neon screens (cyan/magenta/purple/warm)

const nrm2 = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

// ── DETAILED BUILDINGS (opt-in `p.detailedBuildings`): fill each lot with a full procedural buildBuilding() instead
// of the basic extruded box. SCALE BRIDGE: the generator authors in METRES (a floor ≈ 3 m); the city is in
// radius-scaled units where a floor is 0.2·scale units. So build on the lot footprint scaled to metres, then
// uniform-scale the geometry back by k = 0.2·scale/3 and drop it to the lot ground. Buildings merge by (layer,colour)
// → a whole city stays a bounded draw count. City-scale INSTANCING (balconies/trim) is a later Tier-3 pass (baked here). ──
// CITY_FLOOR_M (metres per floor for the bridge) now lives in ./types — preview.ts needs it as well.

/** Uniform-scale a 12-float geometry by k (all axes) + translate Y by dy. Uniform scale leaves normals/tangents unit. */
function scaleGeoY(geo: LayoutPreviewLayer['geometry'], k: number, dy: number): LayoutPreviewLayer['geometry'] {
    const v = new Float32Array(geo.vertices);
    for (let i = 0; i < v.length; i += 12) { v[i] *= k; v[i + 1] = v[i + 1] * k + dy; v[i + 2] *= k; }
    return { vertices: v, indices: geo.indices, format: geo.format };
}

/** Zone → a building archetype (with a little seeded variety). */
function zoneArchetype(zone: Zone, rng: Rng): string {
    if (zone === 'residential') return rng.chance(0.5) ? 'brick-townhouse' : 'apartment-balcony';
    if (zone === 'commercial')  return rng.chance(0.5) ? 'retro-shophouse' : 'office-block';
    return rng.chance(0.5) ? 'office-block' : 'glass-tower';   // civic
}

type DetailGroup = { name: string; cell: string; color: [number, number, number]; emissive?: number; pattern?: LayoutPreviewLayer['pattern']; geos: LayoutPreviewLayer['geometry'][] };
// Instanced detail (juliet/trim/greenery) grouped by (CELL, geometry key). cell='' when detailGrid=0 → city-wide (few
// groups, no cull). cell='<gx>_<gz>' when chunked → one ArrayGroup PER CELL so off-screen cells frustum-cull.
type InstGroup = { name: string; cell: string; color: [number, number, number]; emissive?: number; pattern?: LayoutPreviewLayer['pattern']; geometry: LayoutPreviewLayer['geometry']; instances: { x: number; y: number; z: number; ry: number }[] };
const colKey = (c: [number, number, number]): string => c.map(v => Math.round(v * 24)).join(',');

// Per-building tint variants so buildings of the same archetype don't all render identically (esp. the near-white
// stone trim). DISCRETE (not continuous jitter) so colour still quantizes into a small set → geometry keeps sharing
// instances / merged draws instead of every building becoming its own colour. Applied uniformly to base+trim+roof so
// each building reads coherent (a "warm" building is warm all over). ORDERED as a cool→warm gradient: each REGION
// leans to one index (its neighbourhood character) and buildings roll to ±1 for life, so adjacent picks stay close.
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
type Tint = { b: number; w: [number, number, number] };
const TINTS: Tint[] = [
    { b: 0.66, w: [-0.030, -0.010, 0.025] },// 0 slate grey (dark cool)
    { b: 0.80, w: [-0.020, 0, 0.020] },     // 1 cool grey
    { b: 0.98, w: [0, 0, 0] },              // 2 light neutral (≈ as-designed white stone)
    { b: 0.85, w: [0.050, 0.022, -0.020] }, // 3 cream
    { b: 0.72, w: [0.060, 0.005, -0.045] }, // 4 tan / sandstone
    { b: 0.62, w: [0.070, -0.008, -0.055] },// 5 ochre / warm-dark
];
const applyTint = (c: [number, number, number], t: Tint): [number, number, number] =>
    [clamp01(c[0] * t.b + t.w[0]), clamp01(c[1] * t.b + t.w[1]), clamp01(c[2] * t.b + t.w[2])];
// Some buildings PAINT the trim/parapet a saturated colour instead of stone — the classic dark-red brick cornice,
// plus green / navy / charcoal. A multiply-tint on white stone can't reach these, so they're absolute colours.
// Discrete → still instance-shareable. Residential leans to the brick red (index 0).
const PAINTED_TRIM: [number, number, number][] = [
    [0.44, 0.17, 0.14],  // 0 brick / oxblood red
    [0.22, 0.30, 0.24],  // 1 forest green
    [0.19, 0.24, 0.33],  // 2 navy / slate blue
    [0.26, 0.23, 0.20],  // 3 charcoal brown
];

/** Build a full procedural building fitted to `foot` (city-units) at ground `base`, height ~`h` units. Non-instanced
 *  layers merge into `merged` (by name+colour → bounded draws); INSTANCED detail accumulates city-wide into `inst`
 *  (by geometry key → one ArrayGroup covering every building's balconies/trim of that shape). */
function emitDetailedBuilding(merged: Map<string, DetailGroup>, inst: Map<string, InstGroup>, lot: Lot, foot: V2[], base: number, h: number, scale: number, seed: number, rng: Rng, regionTint: number, cell: string): void {
    const floorU = 0.2 * scale;                                  // a city floor's height in units
    const k = floorU / CITY_FLOOR_M;                             // metre → city-unit scale (so a 3 m floor = floorU units)
    const floors = Math.max(1, Math.min(40, Math.round(h / floorU)));
    const footM: V2[] = foot.map(pt => [pt[0] / k, pt[1] / k]);  // lot shape in metres (× k later → exactly `foot`)
    // ★ DOOR VARIETY. The city never set any door param, so every building fell through to the archetype
    // default — one dark-slate leaf, one white frame, one brass handle, on every entrance in the city.
    // Entrances are at eye level and read individually, so they are the worst thing to repeat. A real
    // street mixes PAINTED joinery (the classic saturated front door), STAINED WOOD and dark METAL, each
    // with its own hardware; the frame is usually either the building's own trim white or a stone tone.
    const DOOR_FINISH: Array<{ leaf: [number, number, number]; handle: [number, number, number]; style: DoorStyle }> = [
        { leaf: [0.10, 0.24, 0.19], handle: [0.72, 0.63, 0.33], style: 'panel' },    // deep green + brass
        { leaf: [0.34, 0.09, 0.11], handle: [0.72, 0.63, 0.33], style: 'panel' },    // oxblood + brass
        { leaf: [0.09, 0.15, 0.30], handle: [0.80, 0.81, 0.84], style: 'panel' },    // navy + steel
        { leaf: [0.13, 0.13, 0.14], handle: [0.74, 0.66, 0.35], style: 'panel' },    // near-black + brass
        { leaf: [0.42, 0.26, 0.13], handle: [0.24, 0.23, 0.22], style: 'flush' },    // stained oak + iron
        { leaf: [0.29, 0.17, 0.10], handle: [0.76, 0.64, 0.34], style: 'panel' },    // walnut + brass
        { leaf: [0.24, 0.26, 0.29], handle: [0.82, 0.83, 0.86], style: 'glazed' },   // grey metal + steel
        { leaf: [0.55, 0.56, 0.58], handle: [0.30, 0.30, 0.32], style: 'glazed' },   // light metal + dark
    ];
    const FRAME: Array<[number, number, number]> = [
        [0.88, 0.88, 0.90],   // painted white joinery
        [0.80, 0.78, 0.73],   // warm stone surround
        [0.20, 0.20, 0.22],   // dark painted surround
    ];
    const dfin = DOOR_FINISH[(hash2(lot.center[0] * 31.7, lot.center[1] * 17.3, (seed ^ 0x4d17) >>> 0) * DOOR_FINISH.length) | 0];
    const dframe = FRAME[(hash2(lot.center[1] * 11.9, lot.center[0] * 23.1, (seed ^ 0x91c3) >>> 0) * FRAME.length) | 0];
    const params: Partial<BuildingParams> = {
        archetype: zoneArchetype(lot.zone, rng), floors, floorHeight: CITY_FLOOR_M, seed,
        julietBalconies: lot.zone === 'residential', windowTrim: true, storefront: lot.zone === 'commercial',
        // A shopfront keeps its glazed commercial entrance; only non-shop entrances take a joinery finish.
        doorStyle: lot.zone === 'commercial' ? 'glazed' : dfin.style,
        doorColor: dfin.leaf, doorHandleColor: dfin.handle, doorFrameColor: dframe,
    };
    // Per-building tint (base + trim + roof) BIASED to the region's palette: mostly the neighbourhood's own tint,
    // with a minority rolling to an adjacent (clamped, so no cool↔warm wrap) tint for life — coherent districts,
    // varied streets.
    const resolved = resolveBuildingParams(params);
    const r = rng.next();
    const ti = r > 0.80 ? Math.min(TINTS.length - 1, regionTint + 1)
        : r > 0.60 ? Math.max(0, regionTint - 1)
        : regionTint;
    const tint = TINTS[ti];
    // Trim / parapet / cornice / roof carry the tint at FULL strength — that's the prominent white crown the eye
    // catches, so it needs the real range (grey / tan / dark stone). The base wall gets a GENTLER half-tint so
    // masonry doesn't go muddy.
    const soft: Tint = { b: 0.5 + tint.b * 0.5, w: [tint.w[0] * 0.5, tint.w[1] * 0.5, tint.w[2] * 0.5] };
    resolved.baseColor = applyTint(resolved.baseColor, soft);
    resolved.roofColor = applyTint(resolved.roofColor, tint);
    // Trim: mostly stone (tinted), but ~1 in 4 buildings gets a PAINTED trim/parapet — residential leans brick-red
    // (the dark-red cornice look), others roll the full painted palette. Applied to cornice + window surrounds.
    const paint = rng.next();
    if (paint < 0.26) {
        const idx = (lot.zone === 'residential' && paint < 0.15) ? 0 : (rng.next() * PAINTED_TRIM.length) | 0;
        resolved.trimColor = PAINTED_TRIM[idx];
        resolved.windowTrimColor = PAINTED_TRIM[idx];
    } else {
        resolved.trimColor = applyTint(resolved.trimColor, tint);          // baked cornice / parapet / pilasters / surrounds
        resolved.windowTrimColor = applyTint(resolved.windowTrimColor, tint); // instanced per-window surrounds
    }
    const { layers } = buildBuilding(resolved, footM);
    for (const L of layers) {
        const cp = cell ? cell + '|' : '';   // cell='' (detailGrid=0) → key identical to the city-wide baseline
        if (L.instances && L.instances.length && L.instanceKey) {
            // INSTANCED: one canonical geometry (scaled, at origin) + this building's transforms → ArrayGroup per (cell,key).
            const key = `${cp}${L.name}|${L.instanceKey}|${colKey(L.color)}`;
            let g = inst.get(key);
            if (!g) { g = { name: L.name, cell, color: L.color, emissive: L.emissive, pattern: L.pattern, geometry: scaleGeoY(L.geometry, k, 0), instances: [] }; inst.set(key, g); }
            for (const t of L.instances) g.instances.push({ x: t.x * k, y: t.y * k + base, z: t.z * k, ry: t.ry });
        } else {
            // NON-instanced (walls/roof/doors/…): scale + drop to the lot, merge by (cell,name,colour).
            const geo = scaleGeoY(L.geometry, k, base);
            const key = `${cp}${L.name}|${colKey(L.color)}`;
            let g = merged.get(key);
            if (!g) { g = { name: L.name, cell, color: L.color, emissive: L.emissive, pattern: L.pattern, geos: [] }; merged.set(key, g); }
            g.geos.push(geo);
        }
    }
}

/** Build the streetscape (buildings + lamp posts + intersection street lights) for a graph. */
export function buildStreets(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params, gy = p.groundY, scale = p.radius / 10;
    // Metal detail frequency in CYCLES PER WORLD UNIT. The city is a diorama, so ~3 cycles per real metre
    // becomes 3 * (metres per unit) — derived, never hardcoded. Declared HERE because the detail-layer
    // material classifier closes over it and runs before the later layer pushes (temporal dead zone).
    const metalScale = 3 * (CITY_FLOOR_M / (0.2 * scale));
    // NOTE: deliberately NO composer-level RNG here — every draw comes from a per-lot position-seeded stream
    // (lotRng below), so selective regen stays idempotent. (A dead never-consumed composer rng used to sit here.)
    const { regionByBlock, distByBlock: distById, blockCentroid: blockC } = graphLookups(graph);
    // Each region (neighbourhood) leans to ONE tint index — its palette character — so districts read coherently
    // (a warm-brick quarter vs a cool-concrete one). Deterministic + memoized per region (seed-stable across regen).
    const regionTintCache = new Map<number, number>();
    const regionTint = (region: number): number => {
        let idx = regionTintCache.get(region);
        if (idx === undefined) { idx = Math.floor(hash2(region * 131.7 + 3.1, region * 57.3 + 9.7, (p.seed ^ 0x9e37f21b) >>> 0) * TINTS.length) % TINTS.length; regionTintCache.set(region, idx); }
        return idx;
    };

    // Buildings — THREE tint buckets per zone (per-building colour variety: base / warm-dark / light) + shared roofs.
    const zoneAcc: Record<string, Accum3D[]> = {
        civic: [new Accum3D(), new Accum3D(), new Accum3D()],
        commercial: [new Accum3D(), new Accum3D(), new Accum3D()],
        residential: [new Accum3D(), new Accum3D(), new Accum3D()],
    };
    const roofs = new Accum3D(), roofDark = new Accum3D(), roofMark = new Accum3D(), roofEquip = new Accum3D();
    const balcony = new Accum3D(), screens = SCREEN_COLORS.map(() => new Accum3D());
    const foundation = new Accum3D();
    const laundry = new Accum3D(), alley = new Accum3D(), constr = new Accum3D(), parking = new Accum3D();
    // SKYLINE: heights peak toward the downtown seed and relax outward — the city gets a real silhouette
    // (a noise-uniform height field reads as suburbs everywhere; a graded one reads as a CITY from a distance).
    const dtc = graph.regions.find(r => r.type === 'downtown')?.center ?? null;
    // Window rhythm per zone (also used for the layer pattern params below) — building walls use wallsWin()
    // with these cell sizes so every facade holds a WHOLE number of window cells (no clipped half-windows
    // at corners or the roofline).
    const winFreqBase = 62.5 / p.radius;
    const winFreqByZone: Record<string, number> = { residential: winFreqBase * 1.25, commercial: winFreqBase, civic: winFreqBase * 0.8 };
    // SLOPE PADS: buildings are RIGID — the whole family (walls/roofs/dressing) bakes the elevation at the lot's
    // ANCHOR (centre) instead of draping per-vertex (which sheared walls on slopes and capped how steep the hills
    // could go). A stone FOUNDATION pad extends below the lowest terrain corner so nothing floats on the downhill
    // side — the San-Francisco stepped-street look. Baked layers are routed with NO height field in the manager.
    const elev = makeElevation(graph);
    const detailedMerged = new Map<string, DetailGroup>();   // opt-in full procedural buildings: non-instanced walls/roof (merged)
    const detailedInst = new Map<string, InstGroup>();       // …their balconies/trim/greenery → ArrayGroups
    // Optional SPATIAL CHUNKING (p.detailGrid = N → N×N grid): bucket buildings into cells so off-screen cells cull.
    // detailGrid=0 → cellOf() returns '' → detail merges CITY-WIDE (baseline). PERF TOGGLE via salsaWorld.update({detailGrid:N}).
    const grid = Math.max(0, Math.floor(p.detailGrid ?? 0));
    let cMinX = Infinity, cMaxX = -Infinity, cMinZ = Infinity, cMaxZ = -Infinity;
    if (grid > 0) for (const l of graph.lots) { const c = l.center; if (c[0] < cMinX) cMinX = c[0]; if (c[0] > cMaxX) cMaxX = c[0]; if (c[1] < cMinZ) cMinZ = c[1]; if (c[1] > cMaxZ) cMaxZ = c[1]; }
    const cellSize = Math.max(1e-3, Math.max(cMaxX - cMinX, cMaxZ - cMinZ) / grid);
    const cellOf = (c: V2): string => grid > 0 ? `${Math.floor((c[0] - cMinX) / cellSize)}_${Math.floor((c[1] - cMinZ) / cellSize)}` : '';
    // VARIETY-LOT QUOTA (idempotency fix): construction/parking/gas claims are picked ONCE here, from the FULL
    // lot list, by a POSITION-HASH RANKING with per-type caps. This replaces the old running counters
    // (nConstr/nParking/nGas), which consumed quota in visit order AFTER the region filter — the same lot could
    // be a building in one render and a construction site in the next depending on which regions were active,
    // and all special lots clustered into the first-visited region. Selection is now a pure function of
    // (lot position, area, zone, district, seed): independent of visit order, the `keep` filter, and prior
    // claims. RNG DISCIPLINE: this pass consumes NO seeded RNG (hash2 only), and the per-lot lotRng draw
    // sequence inside the main loop is unchanged on every path — heights/tints of every other building stay
    // bit-identical to the pre-fix output.
    const varietyByLot = new Map<Lot, NonNullable<Lot['variety']>>();
    {
        const caps = { construction: 2, parking: 2, gas: 1 } as const;
        const cands: { lot: Lot; type: keyof typeof caps; rank: number }[] = [];
        for (const lot of graph.lots) {
            if (lot.slot !== 'building' && !lot.variety) continue;              // mirrors the main-loop entry (re-runs re-claim)
            if (!zoneAcc[lot.zone]) continue;                                   // park/water lots never reach the variety check
            if (lot.poly.length < 3) continue;                                  // (insetToward preserves the vertex count)
            if ((distById.get(lot.block) ?? 'mixed') === 'downtown') continue;
            if (lot.area <= 0.02 * scale * scale) continue;
            const special = hash2(lot.center[0] * 577.3, lot.center[1] * 401.7, (p.seed ^ 0x51fe) >>> 0);
            const type = special < 0.02 ? 'construction' : special < 0.04 ? 'parking'
                : special < 0.05 && lot.zone === 'commercial' ? 'gas' : null;
            if (!type) continue;
            cands.push({ lot, type, rank: hash2(lot.center[0] * 733.9, lot.center[1] * 269.3, (p.seed ^ 0x5a07) >>> 0) });
        }
        // Position-hash rank (spatially uniform → the winners spread across the city), deterministic tiebreak.
        cands.sort((a, b) => a.rank - b.rank || a.lot.center[0] - b.lot.center[0] || a.lot.center[1] - b.lot.center[1]);
        const used = { construction: 0, parking: 0, gas: 0 };
        for (const cd of cands) if (used[cd.type] < caps[cd.type]) { used[cd.type]++; varietyByLot.set(cd.lot, cd.type); }
    }
    for (const lot of graph.lots) {
        // Variety-claimed lots (slot flipped to 'empty' on a PREVIOUS run) must still enter, so a re-run of
        // buildStreets on the same graph consumes the seeded RNG identically (selective-regen idempotency).
        if (lot.slot !== 'building' && !lot.variety) continue;
        if (keep && !keep(regionByBlock.get(lot.block) ?? -1)) continue;   // active-region editor: only the enabled neighbourhoods build
        const buckets = zoneAcc[lot.zone]; if (!buckets) continue;
        // PER-LOT RNG, seeded by position: every random draw for this building comes from its own stream, so
        // toggling any style param (roofStyle/cornerStyle/facadeDetail…) can NEVER shift another building's
        // height/tint — heights stay stable across style changes, and dependents (signage/awnings, which size
        // to builtH) stay valid under selective regen.
        const lotRng = makeRng((p.seed ^ Math.floor(hash2(lot.center[0] * 97.31, lot.center[1] * 57.17, p.seed) * 0xfffffffe)) >>> 0);
        const acc = buckets[(lotRng.next() * buckets.length) | 0];   // per-building tint pick (street reads varied, not uniform)
        const district = distById.get(lot.block) ?? 'mixed';
        // Skyline gradient: boost toward the downtown centre (downtown blocks hardest), taper with distance.
        let hMul = district === 'residential' ? 0.92 : 1;
        if (dtc) {
            const dd = Math.hypot(lot.center[0] - dtc[0], lot.center[1] - dtc[1]) / (p.radius * 0.55);
            hMul *= 1 + Math.max(0, 1 - dd) * (district === 'downtown' ? 0.85 : 0.35);
        }
        const h = buildingHeight(lot.zone, lotRng, scale) * hMul;
        lot.builtH = h;   // signage/awnings clamp their wall dressing to the real facade height
        let foot = insetToward(lot.poly, lot.center, 0.12);   // shrink a touch → the sidewalk shows as a plot rim
        if (foot.length < 3) continue;
        foot = applyCorner(foot, lot, p.cornerStyle, lotRng, scale);
        const lift = elev(lot.center[0], lot.center[1]);
        let minE = Infinity; for (const pt of foot) minE = Math.min(minE, elev(pt[0], pt[1]));
        const base = gy + lift;
        // VARIETY BLOCKS: a few lots skip the building and become a construction site / parking lot / gas
        // station instead — claimed by the deterministic position-hash quota computed above (never by visit
        // order), breaking the "every block is shops" monotony without breaking selective-regen idempotency.
        const claimed = varietyByLot.get(lot);
        if (claimed) {
            if (claimed === 'construction') addConstructionSite(foundation, roofDark, constr, foot, lot.center, base, scale);
            else if (claimed === 'parking') addParkingLot(parking, roofMark, roofDark, foot, lot.center, base, scale, p.seed);
            else addGasStation(roofDark, roofMark, constr, foot, lot.center, base, scale);
            if (lift - minE > 0.004 * scale) foundation.walls(foot, gy + minE - 0.012 * scale, lift - minE + 0.013 * scale);
            lot.slot = 'empty';   // signage/awnings/pedestrian dressing skip non-building lots
            lot.variety = claimed;   // …but a buildStreets RE-RUN still walks this lot (RNG idempotency)
            lot.builtH = 0.1 * scale;
            continue;
        }
        if (lift - minE > 0.004 * scale) foundation.walls(foot, gy + minE - 0.012 * scale, lift - minE + 0.013 * scale);   // pad down to the terrain
        // DETAILED path (opt-in): a full procedural building fitted to this lot, instead of the basic box below.
        if (p.detailedBuildings) {
            emitDetailedBuilding(detailedMerged, detailedInst, lot, foot, base, h, scale, Math.floor(lotRng.next() * 1e9), lotRng, regionTint(regionByBlock.get(lot.block) ?? -1), cellOf(lot.center));
            continue;
        }
        const winCell = 1 / winFreqByZone[lot.zone];
        acc.wallsWin(foot, base, h, winCell, winCell);   // whole window cells per face — windows never clip
        buildRoof(roofs, roofDark, roofMark, roofEquip, foot, base + h, lot.zone, p.roofStyle, lotRng, scale, h, p.rooftops ?? true);
        const ref = blockC.get(lot.block) ?? null, jit = hash2(lot.center[0] * 991, lot.center[1] * 761, p.seed) * 100;
        if ((p.facadeDetail ?? true) && lot.zone !== 'residential' && lotRng.chance(0.4)) addFacadeDetail(roofEquip, roofDark, foot, base, h, lotRng, scale, ref, jit);
        // Taller residential blocks get an external FIRE-ESCAPE stair on a side face: per-floor landings + doors
        // with zigzag flights between them (the walk-up look; doors read as per-level entrances).
        if ((p.facadeDetail ?? true) && lot.zone === 'residential' && h > 0.42 * scale && lotRng.chance(0.4)) addFireEscape(roofDark, foot, base, h, scale, ref, jit);
        // Most buildings get a front DOOR + a small entrance STOOP (steps sized to the real drop to the
        // sidewalk). The stamped door anchor drives the door-visit sim (pedestrians entering buildings).
        if (lotRng.chance(0.72)) {
            const ent = addEntrance(roofDark, foundation, foot, base, scale, ref, jit, (x, z) => gy + elev(x, z));
            if (ent) { lot.door = ent.door; lot.doorOut = ent.out; }
        }
        // District character: entertainment cores get big neon SCREENS high on tall buildings; residential gets
        // BALCONIES (with LAUNDRY strung between some of them — the lived-in tell).
        if (district === 'downtown' && h > 0.9 * scale) addBigScreen(screens, foot, lotRng, base, h, scale, ref, jit);
        else if (district === 'residential' && lot.zone === 'residential') addBalconies(balcony, laundry, foot, base, h, scale, ref, jit);
        // ALLEY CLUTTER: the rear face of commercial buildings gets a dumpster + stacked crates — backstreets
        // stop being bare (the alley is where the Tokyo-backstreet feel lives).
        if ((lot.zone === 'commercial' || district === 'downtown') && hash2(lot.center[0] * 313.1, lot.center[1] * 977.7, (p.seed ^ 0xa11e) >>> 0) < 0.3) {
            addAlleyClutter(alley, roofEquip, foot, base, scale, ref, jit);
        }
    }

    // Street furniture. Poles sit at the CURB (blocks are inset by streetWidth*0.5) — NOT at road.width, which is an
    // inflated value that would push them out into the road / inside the buildings.
    const posts = new Accum3D(), lamps = new Accum3D(), pools = new Accum3D();   // pools = faint light discs on the pavement (glow at night)
    const half = p.streetWidth * 0.5, curbOff = half + 0.02 * scale;   // just onto the sidewalk beside the curb
    const overWater = (x: number, z: number): boolean => cellLevelAt(graph, x, z) < 0;   // don't plant furniture in a canal

    // Lamp posts along the ARTERIALS only (intersections get their own street lights below → keep these sparse).
    const postH = 0.14 * scale, spacing = 1.8 * scale;
    for (const road of graph.roads) {
        if (road.klass !== 'arterial') continue;
        const dx = road.b[0] - road.a[0], dz = road.b[1] - road.a[1], len = Math.hypot(dx, dz), nl = len || 1;
        const ox = (dz / nl) * curbOff, oz = (-dx / nl) * curbOff;
        const n = Math.max(1, Math.floor(len / spacing));
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n, x = road.a[0] + dx * t + ox, z = road.a[1] + dz * t + oz;
            if (overWater(x, z)) continue;
            posts.prism([x, gy, z], 0.006 * scale, 0.006 * scale, postH, 4);
            lamps.blob([x, gy + postH, z], 0.022 * scale, 0.022 * scale, 0.022 * scale, 0, 0);
            pools.disc([x, gy + 0.004 * scale, z], [0, 1, 0], 0.05 * scale, 10);
        }
    }

    // STREET LIGHTS at each intersection — a pole on a real block CORNER with an arm reaching over the crossing.
    // Use arms[0] + a PERPENDICULAR direction (never arms[0]+arms[1]: on a straight-through road those are OPPOSITE
    // and cancel → the pole lands dead-centre in the junction). The corner is `half` along each → the curb corner.
    if (p.streetLights) {
        for (const it of graph.intersections) {
            if (overWater(it.pos[0], it.pos[1])) continue;   // skip junctions that fall in the canal
            const d0 = nrm2(it.arms[0]);
            const pd: V2 = [-d0[1], d0[0]];                                        // a perpendicular arm direction
            const corner: V2 = [it.pos[0] + (d0[0] + pd[0]) * half, it.pos[1] + (d0[1] + pd[1]) * half];   // curb corner
            if (overWater(corner[0], corner[1])) continue;
            const armDir = nrm2([it.pos[0] - corner[0], it.pos[1] - corner[1]]);   // reach back over the crossing
            addStreetLight(posts, lamps, pools, [corner[0], gy, corner[1]], armDir, scale);
        }
    }

    const layers: LayoutPreviewLayer[] = [];
    const winFreq = 62.5 / p.radius;                                   // windows ≈ 0.16·(radius/10) apart, uniform across buildings
    // WINDOWS pattern: real inset window cells with a per-cell hash-LIT set (secondary = the warm lit glass; unlit
    // glass is dark in-shader). spacing = lit fraction — 0 by day; the day/night cycle (sm.world.setTimeOfDay)
    // ramps it live so buildings light up as evening falls. Per-zone rhythm: tight housing, big civic glazing.
    const litColor: [number, number, number] = [1.0, 0.87, 0.55];
    const litFrac = p.nightMode ? 0.55 : 0;
    // In windows mode the free `angle` slot selects the WALL material: 0 = running-bond brick, 1 = concrete speckle.
    const winByZone: Record<string, { freq: number; scale: number; wall: number }> = {
        residential: { freq: winFreq * 1.25, scale: 0.3, wall: 0 }, commercial: { freq: winFreq, scale: 0.26, wall: 0 }, civic: { freq: winFreq * 0.8, scale: 0.22, wall: 1 },
    };
    const PAL = cityPalette(p.seed, p.palette);   // harmonized walls/roofs (matches the flat map)
    // Tint buckets: base / warmer+darker / lighter — neighbouring buildings stop reading as one repeated colour.
    const tint = (c: [number, number, number], i: number): [number, number, number] => {
        if (i === 1) return [Math.min(1, c[0] * 0.9 + 0.05), c[1] * 0.84, c[2] * 0.8];
        if (i === 2) return [Math.min(1, c[0] * 1.07), Math.min(1, c[1] * 1.07), Math.min(1, c[2] * 1.05)];
        return c;
    };
    for (const z of ['residential', 'commercial', 'civic'] as Zone[]) {
        const w = winByZone[z];
        zoneAcc[z].forEach((acc, i) => {
            if (acc.empty) return;
            layers.push({ name: `world:bldg-${z}-${i}`, color: tint(PAL[z as 'residential' | 'commercial' | 'civic'], i), y: gy, geometry: acc.geometry(), pattern: { color: litColor, freq: w.freq, scale: w.scale, mode: 'windows', spacing: litFrac, angle: w.wall } });
        });
    }
    // DETAILED buildings (opt-in). Non-instanced walls/roof: merge each (layer,colour) group → one baked layer.
    // Instanced balconies/trim/greenery: one ArrayGroup per geometry key covering the whole city.
    // ★ MATERIAL CLASSIFIER for the detailed-building sub-layers. These were ALL flat colour, and with
    // detailed buildings on they are the largest mass in the city — juliet balconies alone are ~380k
    // triangles of railing, and the greenery over 1M of leaves. Map each sub-layer name to the material
    // it obviously is, once, here, rather than at every emit site.
    // ★ `metalTint` REPLACES the diffuse (the shader does col = tint * tone), so any rule that wants to
    // keep a layer's generated colour must pass that colour AS the tint. The painted-joinery rules below
    // do exactly that — otherwise the 8 door finishes and the per-lot trim tones all collapse to one slate
    // grey and the variety added upstream is silently thrown away.
    const detailMat = (raw: string, color: [number, number, number], hasPattern: boolean): Partial<LayoutPreviewLayer> => {
        const n = raw.replace('bldg:', '');
        // ★ PATTERN WINS. metalShade, foliageShade and `pattern` are the SAME four instance floats — a mesh
        // is exactly one of them. So handing metal to a layer that already carries a pattern does not layer
        // two effects, it silently deletes the pattern. The generator's `grid` on roof equipment is the
        // panel seams, and on trim it is the glazing bars; both are authored detail worth more than a
        // streak map. Measured: without this guard the rules below ate 366k triangles of grid pattern.
        // `glass` is a plain flag bit and does NOT touch the slots, so it stays available either way.
        if (hasPattern) return /glass|storefront|window(?!trim)/.test(n) ? { glass: true } : {};
        // Railings, balustrades, fire escapes and window guards are painted METAL.
        if (/juliet|balcon|railing|escape|guard/.test(n)) return { metal: { ...METAL_PAINTED, scale: metalScale } };
        // Rooftop plant and ducting is galvanised and filthy on top.
        if (/equip|vent|duct|tank|aerial|antenna/.test(n)) return { metal: { ...METAL_GALVANISED, scale: metalScale } };
        // Shopfront glazing + door glass catch the sky like the curtain walls do.
        if (/glass|storefront|window(?!trim)/.test(n)) return { glass: true };
        // Handles, knobs, hinges, letterplates — SMALL bright metal. Barely streaked (they get handled and
        // polished), low roughness, so they catch a highlight and read as hardware rather than paint.
        if (/handle|knob|hinge|letter/.test(n)) {
            return { metal: { tint: color, streak: [color[0] * 0.6, color[1] * 0.6, color[2] * 0.6],
                roughness: 0.22, streakAmount: 0.15, grime: 0.15, scale: metalScale * 2.2 } };
        }
        // PAINTED JOINERY — window trim, door frames, sills, cornices, the door leaf itself. This is the
        // single biggest flat block in the city (window trim alone was 255k tris of pure albedo). Painted
        // timber weathers the same way painted metal does: rain streaks down the verticals, grime settling
        // on the up-facing sills. Gentler than a railing — joinery is repainted far more often.
        if (/trim|frame|sill|lintel|cornice|reveal|mullion|door/.test(n)) {
            return { metal: { tint: color, streak: [color[0] * 0.72, color[1] * 0.72, color[2] * 0.70],
                roughness: 0.55, streakAmount: 0.40, grime: 0.22, scale: metalScale * 1.4 } };
        }
        // Attached greenery is real swept leaves now — give it the same translucency + wind as every
        // other plant in the library, or a million triangles of foliage stays flat cardboard.
        if (/greenery|foliage|vine|hedge|planter|box/.test(n)) {
            return {
                wind: { height: 0.35, stiffness: 1.7, amount: 0.55 },
                foliageShade: { translucency: 0.7, translucencyColor: [0.62, 0.86, 0.40],
                    groundBlend: 0, groundTint: [0.35, 0.42, 0.28], baseAO: 0.3 },
            };
        }
        return {};
    };
    for (const g of detailedMerged.values()) {
        if (!g.geos.length) continue;
        layers.push({ name: `world:detail-${g.name.replace('bldg:', '')}${g.cell ? '#' + g.cell : ''}`, color: g.color, y: gy, geometry: mergeGeos(g.geos), emissive: g.emissive, pattern: g.pattern, ...detailMat(g.name, g.color, !!g.pattern) });
    }
    for (const g of detailedInst.values()) {
        if (!g.instances.length) continue;
        layers.push({ name: `world:detail-${g.name.replace('bldg:', '')}${g.cell ? '#' + g.cell : ''}`, color: g.color, y: gy, geometry: g.geometry, instances: g.instances, arrayGroup: true, emissive: g.emissive, pattern: g.pattern, ...detailMat(g.name, g.color, !!g.pattern) });
    }
    // Slope pads under rigid buildings — poured concrete, so give them the concrete surface with a large
    // pour size (these are single slabs, not a paved grid) rather than leaving them flat grey.
    if (!foundation.empty) layers.push({ name: 'world:foundation', color: [0.52, 0.51, 0.48], y: gy, geometry: foundation.geometry(),
        ground: { surface: 'concrete', tint: [0.52, 0.51, 0.48], tileMm: 4000, metersPerUnit: CITY_FLOOR_M / (0.2 * scale) } });
    const roofSeam: [number, number, number] = [PAL.roof[0] * 0.68, PAL.roof[1] * 0.68, PAL.roof[2] * 0.68];
    // SHINGLES: the grid pattern's spacing>0.5 variant — staggered running-bond courses + a per-tile hash shade,
    // so the big hipped/mansard slopes read as tiled roofs instead of flat paint (pyramid/frustum UVs are
    // world-proportional, so the course size is consistent across every roof).
    if (!roofs.empty) layers.push({ name: 'world:roofs', color: PAL.roof, y: gy, geometry: roofs.geometry(), pattern: { color: roofSeam, freq: 26, scale: 0.3, mode: 'grid', spacing: 1 } });
    if (!roofDark.empty) layers.push({ name: 'world:roof-detail', color: ROOF_DETAIL, y: gy, geometry: roofDark.geometry() , metal: { ...METAL_PAINTED, scale: metalScale }});
    if (!roofEquip.empty) layers.push({ name: 'world:roof-equip', color: ROOF_EQUIP, y: gy, geometry: roofEquip.geometry() , metal: { ...METAL_GALVANISED, scale: metalScale }});
    if (!roofMark.empty) layers.push({ name: 'world:roof-mark', color: ROOF_MARK, y: gy, geometry: roofMark.geometry() });
    if (!balcony.empty) layers.push({ name: 'world:balcony', color: BALCONY_COLOR, y: gy, geometry: balcony.geometry() });
    // Neon screens: ANIMATED wave patterns — each colour layer gets its own frequency / direction / scroll speed AND
    // waveform (scale selects: soft bands / zigzag sweep / blocky glitch scanlines) so the wall of screens runs
    // visibly different animations out of sync. The bands carry the emissive in-shader.
    const SCREEN_WAVE: [number, number, number, number][] = [[9, 0.5, 0.9, 0.2], [12, 2.2, 0.6, 0.5], [7, 4.0, 1.2, 0.8], [10, 1.2, 0.75, 0.5]];   // [freq, angle, speed, waveform]
    screens.forEach((a, i) => {
        if (a.empty) return;
        const [wf, wa, ws, wv] = SCREEN_WAVE[i];
        // Real neon rather than the `waves` pattern: the pattern painted moving bands into the ALBEDO,
        // so a screen went dark in shadow like any other wall. neonShade drives the EMISSIVE term with
        // scanlines + flicker, which is what makes it read as a lit display. Each screen keeps its own
        // phase (and its own scan density from the old waveform slot) so the wall never pulses in unison.
        layers.push({ name: 'world:screen-' + i, color: SCREEN_COLORS[i], y: gy, geometry: a.geometry(),
            emissive: p.nightMode ? 1.5 : 0.9,
            neon: { glow: SCREEN_COLORS[i], accent: [0.95, 0.97, 1.0], scanDensity: wf * 14, flicker: 0.10 + wv * 0.10, scroll: ws, phase: wa } });
    });
    if (!posts.empty) layers.push({ name: 'world:lightpoles', color: POST_COLOR, y: gy, geometry: posts.geometry() , metal: { ...METAL_POLE, scale: metalScale }});
    if (!lamps.empty) layers.push({ name: 'world:lamplights', color: LAMP_COLOR, y: gy, geometry: lamps.geometry(), emissive: p.nightMode ? 1.5 : 0.9 });   // lamp bulbs glow (brighter at night)
    // Lamp light POOLS: faint warm discs on the pavement under every light — near-invisible by day, the glow
    // walk cranks them at night so streets get pooled light instead of uniformly dark asphalt.
    if (!pools.empty) layers.push({ name: 'world:lamp-pool', color: [1.0, 0.88, 0.60], y: gy, geometry: pools.geometry(), emissive: p.nightMode ? 1.2 : 0.05, opacity: 0.32 });
    if (!laundry.empty) layers.push({ name: 'world:laundry', color: [0.93, 0.92, 0.87], y: gy, geometry: laundry.geometry() });      // strung sheets/shirts (off-white)
    if (!alley.empty) layers.push({ name: 'world:alley-clutter', color: [0.36, 0.33, 0.29], y: gy, geometry: alley.geometry() });    // crates (dumpsters ride roofEquip grey)
    if (!constr.empty) layers.push({ name: 'world:construction', color: [0.92, 0.55, 0.14], y: gy, geometry: constr.geometry() });   // safety orange (crane/barriers/pumps)
    if (!parking.empty) layers.push({ name: 'world:parking', color: [0.16, 0.16, 0.18], y: gy, geometry: parking.geometry() });      // parking-lot asphalt
    return layers;
}

/** A street light: vertical pole + a short horizontal arm + a lamp head at the arm's end (reaches over the road).
 *  Kept SHORTER than the buildings (h ≈ 0.2·scale, vs residential 0.2–0.52·scale) so it doesn't tower over them. */
function addStreetLight(posts: Accum3D, lamps: Accum3D, pools: Accum3D, base: V3, armDir: V2, scale: number): void {
    const h = 0.2 * scale, r = 0.007 * scale;
    posts.prism(base, r, r, h, 4);
    const top: V3 = [base[0], base[1] + h, base[2]];
    const armEnd: V3 = [top[0] + armDir[0] * 0.1 * scale, top[1] - 0.012 * scale, top[2] + armDir[1] * 0.1 * scale];
    posts.beam(top, armEnd, r * 0.7, 4);
    lamps.blob([armEnd[0], armEnd[1] - 0.01 * scale, armEnd[2]], 0.02 * scale, 0.012 * scale, 0.02 * scale, 0, 0);
    pools.disc([armEnd[0], base[1] + 0.004 * scale, armEnd[2]], [0, 1, 0], 0.06 * scale, 10);   // light pool on the road under the head
}

/** LAUNDRY strung along a balcony: a thin line + a few hanging sheet/shirt quads (off-white reads right from afar). */
function addLaundry(laundry: Accum3D, at: V3, eW: V3, oW: V3, half: number, s: number, seedish: number): void {
    const lineY = at[1] + 0.055 * s;
    laundry.beam([at[0] - eW[0] * half, lineY, at[2] - eW[2] * half], [at[0] + eW[0] * half, lineY, at[2] + eW[2] * half], 0.0012 * s, 3);
    const n = 3 + ((hash2(seedish * 7.7, at[1] * 13.1, 0x1aa7) * 2) | 0);
    for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5, w = (0.012 + hash2(seedish, i * 3.3, 0x2b1) * 0.01) * s, hgt = (0.02 + hash2(seedish, i * 5.1, 0x3c2) * 0.015) * s;
        const cx = at[0] + eW[0] * t * half * 2, cz = at[2] + eW[2] * t * half * 2;
        laundry.quad4([cx - eW[0] * w, lineY, cz - eW[2] * w], [cx + eW[0] * w, lineY, cz + eW[2] * w],
            [cx + eW[0] * w + oW[0] * 0.004 * s, lineY - hgt, cz + eW[2] * w + oW[2] * 0.004 * s],
            [cx - eW[0] * w + oW[0] * 0.004 * s, lineY - hgt, cz - eW[2] * w + oW[2] * 0.004 * s]);
    }
}

/** Rear-face ALLEY CLUTTER: a dumpster (grey, into roofEquip) + a stack of crates behind the building. */
function addAlleyClutter(alley: Accum3D, equip: Accum3D, foot: V2[], gy: number, s: number, ref: V2 | null, jit: number): void {
    const fr = frontage(foot, ref, jit); if (!fr) return;
    const c = centroid(foot);
    // The REAR is the reflection of the street-frontage midpoint through the centroid, pushed just past the wall.
    const mid: V2 = [(fr.a[0] + fr.b[0]) * 0.5, (fr.a[1] + fr.b[1]) * 0.5];
    const rx = 2 * c[0] - mid[0] - fr.outward[0] * 0.03 * s, rz = 2 * c[1] - mid[1] - fr.outward[1] * 0.03 * s;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], up: V3 = [0, 1, 0], oW: V3 = [-fr.outward[0], 0, -fr.outward[1]];   // faces the back street
    equip.obox([rx, gy + 0.016 * s, rz], eW, up, oW, 0.022 * s, 0.016 * s, 0.013 * s);                    // dumpster body
    equip.obox([rx, gy + 0.034 * s, rz], eW, up, oW, 0.023 * s, 0.003 * s, 0.014 * s);                    // lid
    const bx = rx + fr.eDir[0] * 0.05 * s, bz = rz + fr.eDir[1] * 0.05 * s;                                // crate stack beside it
    alley.obox([bx, gy + 0.009 * s, bz], eW, up, oW, 0.011 * s, 0.009 * s, 0.011 * s);
    alley.obox([bx + fr.eDir[0] * 0.006 * s, gy + 0.027 * s, bz + fr.eDir[1] * 0.006 * s], eW, up, oW, 0.009 * s, 0.008 * s, 0.009 * s);
}

/** A CONSTRUCTION SITE lot: a partial concrete frame (columns + slabs), a tall TOWER CRANE (mast + jib +
 *  counter-jib + hook + hanging load), a perimeter barrier, and material piles. Cranes make skylines. */
function addConstructionSite(concrete: Accum3D, dark: Accum3D, orange: Accum3D, foot: V2[], c: V2, gy: number, s: number): void {
    const inner = insetToward(foot, c, 0.22);
    if (inner.length >= 3) {
        // Two-storey open frame: corner columns + floor slabs (the "under construction" skeleton).
        for (const v of inner) concrete.prism([v[0], gy, v[1]], 0.012 * s, 0.012 * s, 0.4 * s, 4);
        concrete.cap(inner, gy + 0.2 * s, 1); concrete.cap(inner, gy + 0.4 * s, 1);
    }
    // Perimeter barrier: orange posts + a rail along the lot edge.
    for (let i = 0; i < foot.length; i++) {
        const a = foot[i], b = foot[(i + 1) % foot.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.floor(len / (0.09 * s)));
        for (let k = 0; k <= n; k++) { const t = k / n; orange.prism([a[0] + (b[0] - a[0]) * t, gy, a[1] + (b[1] - a[1]) * t], 0.004 * s, 0.004 * s, 0.028 * s, 4); }
        orange.beam([a[0], gy + 0.024 * s, a[1]], [b[0], gy + 0.024 * s, b[1]], 0.003 * s, 3);
    }
    // Tower crane at a corner of the frame: mast → cab → jib + counter-jib → cable + hanging load.
    const mastX = c[0] + (foot[0][0] - c[0]) * 0.55, mastZ = c[1] + (foot[0][1] - c[1]) * 0.55, mastH = 1.15 * s;
    const jibDir = nrm2([c[0] - mastX, c[1] - mastZ]);
    const xJ: V3 = [jibDir[0], 0, jibDir[1]], up: V3 = [0, 1, 0], zJ: V3 = [-jibDir[1], 0, jibDir[0]];
    orange.prism([mastX, gy, mastZ], 0.014 * s, 0.014 * s, mastH, 4);                                       // mast
    orange.obox([mastX, gy + mastH + 0.014 * s, mastZ], xJ, up, zJ, 0.02 * s, 0.014 * s, 0.016 * s);        // cab
    orange.obox([mastX + jibDir[0] * 0.24 * s, gy + mastH + 0.02 * s, mastZ + jibDir[1] * 0.24 * s], xJ, up, zJ, 0.26 * s, 0.006 * s, 0.006 * s);   // jib
    orange.obox([mastX - jibDir[0] * 0.09 * s, gy + mastH + 0.02 * s, mastZ - jibDir[1] * 0.09 * s], xJ, up, zJ, 0.09 * s, 0.008 * s, 0.008 * s);   // counter-jib
    const hookX = mastX + jibDir[0] * 0.38 * s, hookZ = mastZ + jibDir[1] * 0.38 * s;
    dark.beam([hookX, gy + mastH + 0.014 * s, hookZ], [hookX, gy + 0.32 * s, hookZ], 0.0018 * s, 3);        // cable
    dark.obox([hookX, gy + 0.3 * s, hookZ], xJ, up, zJ, 0.02 * s, 0.014 * s, 0.014 * s);                    // hanging load
    // Material piles near the frame.
    dark.obox([c[0] - jibDir[0] * 0.14 * s, gy + 0.012 * s, c[1] - jibDir[1] * 0.14 * s], xJ, up, zJ, 0.03 * s, 0.012 * s, 0.02 * s);
}

/** A PARKING LOT: dark asphalt slab + painted stall rows (white) + a few parked cars between the lines. */
function addParkingLot(lot: Accum3D, white: Accum3D, dark: Accum3D, foot: V2[], c: V2, gy: number, s: number, seed: number): void {
    const pad = insetToward(foot, c, 0.06);
    if (pad.length < 3) return;
    lot.cap(pad, gy + 0.006 * s, 1);
    const fr = frontage(pad); if (!fr) return;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], up: V3 = [0, 1, 0], oW: V3 = [fr.outward[0], 0, fr.outward[1]];
    const rows = 2, stallW = 0.05 * s, nS = Math.max(2, Math.floor((fr.len * 0.8) / stallW));
    for (let r = 0; r < rows; r++) {
        const back = 0.1 * s + r * 0.16 * s;
        for (let i = 0; i <= nS; i++) {
            const t = (i / nS - 0.5) * fr.len * 0.8;
            const px = c[0] + fr.eDir[0] * t - fr.outward[0] * back + fr.outward[0] * 0.08 * s;
            const pz = c[1] + fr.eDir[1] * t - fr.outward[1] * back + fr.outward[1] * 0.08 * s;
            white.obox([px, gy + 0.008 * s, pz], oW, up, eW, 0.028 * s, 0.0012 * s, 0.0025 * s);   // stall line
            if (i < nS && hash2(px * 131.7, pz * 71.3, (seed ^ 0x9a44) >>> 0) < 0.45) {            // a car in ~half the stalls
                const cx = px + fr.eDir[0] * stallW * 0.5, cz = pz + fr.eDir[1] * stallW * 0.5;
                dark.obox([cx, gy + 0.022 * s, cz], oW, up, eW, 0.028 * s, 0.014 * s, 0.016 * s);
            }
        }
    }
}

/** A GAS STATION: flat canopy on four posts + two pump islands + a road-side totem sign. */
function addGasStation(dark: Accum3D, white: Accum3D, orange: Accum3D, foot: V2[], c: V2, gy: number, s: number): void {
    const fr = frontage(foot); if (!fr) return;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], up: V3 = [0, 1, 0], oW: V3 = [fr.outward[0], 0, fr.outward[1]];
    const canH = 0.14 * s, cw2 = Math.min(fr.len * 0.34, 0.2 * s), cd = 0.11 * s;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) dark.prism([c[0] + eW[0] * cw2 * 0.8 * sx + oW[0] * cd * 0.7 * sz, gy, c[1] + eW[2] * cw2 * 0.8 * sx + oW[2] * cd * 0.7 * sz], 0.006 * s, 0.006 * s, canH, 4);
    white.obox([c[0], gy + canH + 0.008 * s, c[1]], eW, up, oW, cw2, 0.008 * s, cd);                        // canopy slab
    orange.obox([c[0], gy + canH + 0.024 * s, c[1]], eW, up, oW, cw2, 0.008 * s, cd * 0.2);                 // brand band
    for (const sx of [-1, 1]) {                                                                              // pump islands
        const px = c[0] + eW[0] * cw2 * 0.45 * sx, pz = c[1] + eW[2] * cw2 * 0.45 * sx;
        white.obox([px, gy + 0.006 * s, pz], eW, up, oW, 0.035 * s, 0.006 * s, 0.02 * s);
        orange.obox([px, gy + 0.032 * s, pz], eW, up, oW, 0.008 * s, 0.026 * s, 0.008 * s);
    }
    const tx = c[0] + fr.outward[0] * cd * 1.9, tz = c[1] + fr.outward[1] * cd * 1.9;                        // totem sign at the curb
    dark.prism([tx, gy, tz], 0.006 * s, 0.006 * s, 0.2 * s, 4);
    orange.obox([tx, gy + 0.21 * s, tz], eW, up, oW, 0.03 * s, 0.022 * s, 0.006 * s);
}

/** Massing height by zone (× city scale), with per-building jitter + an occasional tall tower for skyline variety. */
function buildingHeight(zone: Zone, rng: Rng, scale: number): number {
    let h = zone === 'civic' ? 0.6 + rng.next() * 0.7 : zone === 'commercial' ? 0.35 + rng.next() * 0.55 : 0.2 + rng.next() * 0.32;
    if (zone !== 'residential' && rng.chance(0.14)) h *= 1.7 + rng.next() * 1.3;   // ~14% of non-residential are notably taller
    return h * scale;
}

/** Per-building corner treatment. `mixed` = seeded blend (≈50% sharp, 28% chamfer, 22% round). */
function applyCorner(foot: V2[], lot: Lot, style: CornerStyle, rng: Rng, scale: number): V2[] {
    let s: CornerStyle = style;
    if (style === 'mixed') { const r = rng.next(); s = r < 0.5 ? 'sharp' : r < 0.78 ? 'chamfer' : 'round'; }
    if (s === 'sharp') return foot;
    const amt = Math.min(Math.sqrt(Math.max(0, lot.area)) * 0.28, 0.12 * scale);
    if (amt < 1e-4) return foot;
    return s === 'round' ? roundPolygon(foot, amt, 3) : chamferPolygon(foot, amt);
}

/** Shrink a polygon toward a centre point by fraction `f` (uniform, robust for the convex-ish lots we generate). */
function insetToward(poly: V2[], c: V2, f: number): V2[] {
    return poly.map(p => [p[0] + (c[0] - p[0]) * f, p[1] + (c[1] - p[1]) * f] as V2);
}

/** The building's street frontage = its longest edge, with an OUTWARD (away-from-centre) normal. */
/** The dressing frontage: a STREET-FACING near-longest edge picked with jitter (so identical lots don't all face
 *  the same way). `ref` = the block centroid (edges away from it face streets); outward = away from the lot. */
function frontage(foot: V2[], ref: V2 | null = null, jitter = 0): { a: V2; b: V2; eDir: V2; outward: V2; len: number } | null {
    if (foot.length < 3) return null;
    const e = frontageEdge(foot, ref, jitter);
    const a = e.a, b = e.b, len = e.len;
    if (len < 1e-4) return null;
    const eDir: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let outward: V2 = [-eDir[1], eDir[0]];
    const c = centroid(foot), mid: V2 = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
    if ((mid[0] - c[0]) * outward[0] + (mid[1] - c[1]) * outward[1] < 0) outward = [-outward[0], -outward[1]];
    return { a, b, eDir, outward, len };
}

/** A big emissive SCREEN panel high on a tall downtown building's frontage (the Shibuya look). */
function addBigScreen(screens: Accum3D[], foot: V2[], rng: Rng, gy: number, h: number, s: number, ref: V2 | null, jit: number): void {
    const fr = frontage(foot, ref, jit); if (!fr) return;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
    const mx = (fr.a[0] + fr.b[0]) * 0.5, mz = (fr.a[1] + fr.b[1]) * 0.5, y = gy + h * 0.72;
    screens[(rng.next() * screens.length) | 0].obox([mx + oW[0] * 0.012 * s, y, mz + oW[2] * 0.012 * s], eW, up, oW, fr.len * 0.4, h * 0.16, 0.01 * s);
}

/** Per-floor balcony slabs protruding from a residential building's frontage — and LAUNDRY strung along
 *  ~40% of them (line + hanging sheet quads; the walk-up look). */
function addBalconies(balcony: Accum3D, laundry: Accum3D, foot: V2[], gy: number, h: number, s: number, ref: V2 | null, jit: number): void {
    const fr = frontage(foot, ref, jit); if (!fr) return;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
    const mx = (fr.a[0] + fr.b[0]) * 0.5, mz = (fr.a[1] + fr.b[1]) * 0.5, floorH = 0.2 * s, nF = Math.min(6, Math.floor(h / floorH));
    for (let f = 1; f < nF; f++) {
        balcony.obox([mx + oW[0] * 0.022 * s, gy + f * floorH, mz + oW[2] * 0.022 * s], eW, up, oW, fr.len * 0.44, 0.006 * s, 0.03 * s);
        if (hash2(mx * 91.3 + f * 17.7, mz * 53.1, 0x1d7a) < 0.4) {
            addLaundry(laundry, [mx + oW[0] * 0.03 * s, gy + f * floorH, mz + oW[2] * 0.03 * s], eW, oW, fr.len * 0.3, s, mx * 7.1 + mz * 3.3 + f);
        }
    }
}

// ── Rooftops ─────────────────────────────────────────────────────────────────────────────────────
/** Build a roof on the building whose walls top out at `topY`, per style (mixed = seeded, weighted by zone). */
function buildRoof(roofs: Accum3D, dark: Accum3D, mark: Accum3D, equip: Accum3D, foot: V2[], topY: number, zone: Zone, style: RoofStyle, rng: Rng, s: number, h: number, rooftops: boolean): void {
    const st = style === 'mixed' ? pickRoof(zone, rng, h > 0.85 * s) : style;
    const c = centroid(foot);
    // A projecting CORNICE band under the roofline gives facades a proper top (the brownstone/brick look).
    const cornice = (): void => { const cf = insetToward(foot, c, -0.05); dark.walls(cf, topY - 0.026 * s, 0.026 * s); dark.cap(cf, topY, 1); };
    switch (st) {
        case 'pointed': {
            // Hipped roof with EAVES OVERHANG + a finial spike at the apex (the Dutch-gable read).
            const of = insetToward(foot, c, -0.08), hgt = (0.16 + rng.next() * 0.16) * s;
            roofs.pyramid(of, topY, hgt);
            dark.prism([c[0], topY + hgt - 0.005 * s, c[1]], 0.0035 * s, 0.0035 * s, 0.045 * s, 4);   // finial spike
            mark.blob([c[0], topY + hgt + 0.042 * s, c[1]], 0.007 * s, 0.007 * s, 0.007 * s, 0, 0);   // finial ball
            break;
        }
        case 'spire': {
            // Church/gate-tower SPIRE: cornice → octagon-ish drum → tall steep pyramid → finial (Zutphen/Fraumünster).
            cornice();
            const drum = insetToward(foot, c, 0.3);
            roofs.walls(drum, topY, 0.055 * s); roofs.cap(drum, topY + 0.055 * s, 1);
            const sp = insetToward(foot, c, 0.26), hgt = (0.5 + rng.next() * 0.3) * s;
            roofs.pyramid(sp, topY + 0.055 * s, hgt);
            dark.prism([c[0], topY + 0.05 * s + hgt, c[1]], 0.003 * s, 0.003 * s, 0.06 * s, 4);
            mark.blob([c[0], topY + 0.055 * s + hgt + 0.055 * s, c[1]], 0.008 * s, 0.008 * s, 0.008 * s, 0, 0);
            break;
        }
        case 'mansard': {
            // Steep-sided MANSARD: cornice → steep tiled slope → flat top with clutter.
            cornice();
            const i1 = insetToward(foot, c, 0.2);
            roofs.frustum(foot, i1, topY, topY + 0.085 * s);
            roofs.cap(i1, topY + 0.085 * s, 1);
            clutter(dark, equip, c, topY + 0.085 * s, rng, s, rooftops);
            break;
        }
        case 'parapet':
            // Roof slab a hair ABOVE the cornice cap — coplanar caps z-fight (striped flicker on flat roofs).
            cornice(); roofs.cap(foot, topY + 0.0018 * s, 1); roofs.walls(foot, topY, 0.03 * s); clutter(dark, equip, c, topY, rng, s, rooftops); break;
        case 'chamfer': {
            if (rng.chance(0.5)) cornice();
            const ins = insetToward(foot, c, 0.32); roofs.frustum(foot, ins, topY, topY + 0.06 * s); roofs.cap(ins, topY + 0.06 * s, 1); break;
        }
        case 'rounded': {
            const i1 = insetToward(foot, c, 0.16), i2 = insetToward(foot, c, 0.4);
            roofs.frustum(foot, i1, topY, topY + 0.03 * s); roofs.frustum(i1, i2, topY + 0.03 * s, topY + 0.06 * s); roofs.cap(i2, topY + 0.06 * s, 1); break;
        }
        case 'helipad':
            roofs.cap(foot, topY, 1); helipad(dark, mark, foot, c, topY, s); break;
        case 'tower':
            tower(roofs, dark, foot, c, topY, rng, s); break;
        default: // flat
            if (zone !== 'residential' && rng.chance(0.55)) cornice();
            roofs.cap(foot, topY + 0.0018 * s, 1); clutter(dark, equip, c, topY, rng, s, rooftops); break;   // lifted off the cornice cap (z-fight)
    }
}

/** Weighted roof pick by zone. Helipads + towers only on TALL buildings; spires are the rare skyline accent. */
function pickRoof(zone: Zone, rng: Rng, tall: boolean): RoofStyle {
    const r = rng.next();
    if (zone === 'residential') return r < 0.36 ? 'flat' : r < 0.68 ? 'pointed' : r < 0.84 ? 'mansard' : 'parapet';
    if (zone === 'commercial') {
        if (tall) return r < 0.36 ? 'tower' : r < 0.52 ? 'parapet' : r < 0.64 ? 'chamfer' : r < 0.72 ? 'helipad' : r < 0.8 ? 'spire' : 'flat';
        return r < 0.3 ? 'parapet' : r < 0.5 ? 'flat' : r < 0.66 ? 'chamfer' : r < 0.78 ? 'mansard' : r < 0.9 ? 'rounded' : 'spire';
    }
    // civic
    if (tall) return r < 0.34 ? 'tower' : r < 0.52 ? 'parapet' : r < 0.62 ? 'helipad' : r < 0.78 ? 'spire' : 'flat';
    return r < 0.34 ? 'parapet' : r < 0.58 ? 'flat' : r < 0.72 ? 'chamfer' : r < 0.86 ? 'mansard' : 'spire';
}

/** Rooftop clutter — a thin antenna mast, a small dish, and (when `rooftops`) a water tank on legs + an AC condenser. */
function clutter(dark: Accum3D, equip: Accum3D, c: V2, topY: number, rng: Rng, s: number, rooftops: boolean): void {
    if (rng.chance(0.42)) dark.prism([c[0] + (rng.next() - 0.5) * 0.06 * s, topY, c[1] + (rng.next() - 0.5) * 0.06 * s], 0.004 * s, 0.004 * s, (0.1 + rng.next() * 0.16) * s, 4);
    if (rng.chance(0.22)) dark.blob([c[0] + (rng.next() - 0.5) * 0.1 * s, topY + 0.02 * s, c[1] + (rng.next() - 0.5) * 0.1 * s], 0.03 * s, 0.018 * s, 0.03 * s, 0.25, rng.next() * 997);
    if (rooftops && rng.chance(0.5)) {   // water tank on four legs (the iconic JP rooftop cylinder)
        const tx = c[0] + (rng.next() - 0.5) * 0.08 * s, tz = c[1] + (rng.next() - 0.5) * 0.08 * s, tr = 0.028 * s;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) equip.prism([tx + sx * tr * 0.6, topY, tz + sz * tr * 0.6], 0.004 * s, 0.004 * s, 0.028 * s, 4);
        equip.prism([tx, topY + 0.028 * s, tz], tr, tr, 0.04 * s, 8);
    }
    if (rooftops && rng.chance(0.45)) equip.obox([c[0] + (rng.next() - 0.5) * 0.12 * s, topY + 0.012 * s, c[1] + (rng.next() - 0.5) * 0.12 * s], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.025 * s, 0.012 * s, 0.02 * s);   // AC condenser
}

/** A front DOOR + entrance STOOP at the frontage: a dark recessed door with stone steps CLAMPED to the real
 *  ground at the door (`groundAt`) — steps only exist where the door actually sits above the sidewalk, and
 *  they never sink below it (the old fixed 3-step descent buried stoops under the map on uphill frontages).
 *  Returns the door anchor + outward direction so the caller can stamp the lot for the door-visit sim. */
function addEntrance(dark: Accum3D, stone: Accum3D, foot: V2[], base: number, s: number, ref: V2 | null, jit: number,
    groundAt: (x: number, z: number) => number): { door: V2; out: V2 } | null {
    const fr = frontage(foot, ref, jit); if (!fr || fr.len < 0.12 * s) return null;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
    const t = 0.26;   // off-centre door (shop doors read at the centre; stoops sit to one side)
    const dx = fr.a[0] + (fr.b[0] - fr.a[0]) * t, dz = fr.a[1] + (fr.b[1] - fr.a[1]) * t;
    dark.obox([dx + oW[0] * 0.005 * s, base + 0.032 * s, dz + oW[2] * 0.005 * s], eW, up, oW, 0.014 * s, 0.032 * s, 0.005 * s);   // door
    const rise = 0.009 * s, run = 0.014 * s;
    const ground = groundAt(dx + oW[0] * run * 2, dz + oW[2] * run * 2);   // the sidewalk just outside the door
    const drop = base - ground;
    const n = Math.max(0, Math.min(4, Math.round(drop / rise)));           // as many steps as the drop needs; 0 = flush door
    for (let i = 0; i < n; i++) {
        const off = (n - i) * run;
        const yTop = base - (i + 1) * (drop / n);                          // evenly divide the real drop
        stone.obox([dx + oW[0] * off, (base - i * (drop / n) + yTop) / 2, dz + oW[2] * off], eW, up, oW, 0.022 * s, Math.max(0.002 * s, drop / n * 0.55), run * 0.6);
    }
    if (n === 0 && drop > 0.001 * s) stone.obox([dx + oW[0] * run, base - drop * 0.5, dz + oW[2] * run], eW, up, oW, 0.022 * s, drop * 0.55, run * 0.7);   // low threshold slab
    return { door: [dx, dz], out: [fr.outward[0], fr.outward[1]] };
}

/** An external FIRE-ESCAPE / walk-up stair on a SIDE face (not the frontage): a landing + dark door at each
 *  floor, zigzag flights between landings, and a ground ladder — per-level entrances on taller residentials. */
function addFireEscape(dark: Accum3D, foot: V2[], gy: number, h: number, s: number, ref: V2 | null, jit: number): void {
    const fr = frontage(foot, ref, jit); if (!fr) return;
    // side edge = the edge most perpendicular to the frontage (so the stair doesn't cover the shopfront)
    let side: { a: V2; b: V2; len: number } | null = null, best = -1;
    for (let i = 0; i < foot.length; i++) {
        const a = foot[i], b = foot[(i + 1) % foot.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.06 * s) continue;
        const d: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        const perp = Math.abs(d[0] * fr.outward[0] + d[1] * fr.outward[1]);   // parallel to frontage-outward = a side face
        if (perp > best) { best = perp; side = { a, b, len }; }
    }
    if (!side) return;
    const eDir: V2 = [(side.b[0] - side.a[0]) / side.len, (side.b[1] - side.a[1]) / side.len];
    let outward: V2 = [-eDir[1], eDir[0]];
    const c = centroid(foot), mid: V2 = [(side.a[0] + side.b[0]) * 0.5, (side.a[1] + side.b[1]) * 0.5];
    if ((mid[0] - c[0]) * outward[0] + (mid[1] - c[1]) * outward[1] < 0) outward = [-outward[0], -outward[1]];
    const eW: V3 = [eDir[0], 0, eDir[1]], oW: V3 = [outward[0], 0, outward[1]], up: V3 = [0, 1, 0];
    const floorH = 0.18 * s, nF = Math.min(6, Math.floor(h / floorH));
    const proj = 0.018 * s, landW = 0.028 * s;
    let prev: V3 | null = null;
    for (let f = 1; f < nF; f++) {
        const zig = (f % 2 === 0 ? 1 : -1) * 0.03 * s;
        const lx = mid[0] + eDir[0] * zig + outward[0] * proj, lz = mid[1] + eDir[1] * zig + outward[1] * proj, ly = gy + f * floorH;
        dark.obox([lx, ly, lz], eW, up, oW, landW, 0.0035 * s, proj);                                   // landing
        dark.obox([lx - oW[0] * proj * 0.4, ly + 0.028 * s, lz - oW[2] * proj * 0.4], eW, up, oW, 0.011 * s, 0.026 * s, 0.004 * s);   // door
        if (prev) dark.beam(prev, [lx - eDir[0] * landW * 0.8, ly, lz - eDir[1] * landW * 0.8], 0.004 * s, 4);   // zigzag flight
        prev = [lx + eDir[0] * landW * 0.8, ly, lz + eDir[1] * landW * 0.8];
    }
    if (prev && nF > 1) dark.beam([mid[0] + outward[0] * proj, gy, mid[1] + outward[1] * proj], [mid[0] + eDir[0] * -0.03 * s + outward[0] * proj, gy + floorH, mid[1] + eDir[1] * -0.03 * s + outward[1] * proj], 0.004 * s, 4);   // ground flight
}

/** Facade detail on non-residential blocks: protruding AC boxes at floor intervals + a vertical downpipe. */
function addFacadeDetail(equip: Accum3D, dark: Accum3D, foot: V2[], gy: number, h: number, rng: Rng, s: number, ref: V2 | null, jit: number): void {
    const fr = frontage(foot, ref, jit); if (!fr) return;
    const eW: V3 = [fr.eDir[0], 0, fr.eDir[1]], oW: V3 = [fr.outward[0], 0, fr.outward[1]], up: V3 = [0, 1, 0];
    const nFloors = Math.max(1, Math.floor(h / (0.18 * s)));
    for (let f = 1; f < nFloors; f++) {
        if (!rng.chance(0.5)) continue;
        const t = 0.2 + rng.next() * 0.6, y = gy + f * (h / nFloors);
        const px = fr.a[0] + (fr.b[0] - fr.a[0]) * t, pz = fr.a[1] + (fr.b[1] - fr.a[1]) * t;
        equip.obox([px + oW[0] * 0.012 * s, y, pz + oW[2] * 0.012 * s], eW, up, oW, 0.018 * s, 0.011 * s, 0.011 * s);
    }
    const px = fr.a[0] + (fr.b[0] - fr.a[0]) * 0.08 + oW[0] * 0.006 * s, pz = fr.a[1] + (fr.b[1] - fr.a[1]) * 0.08 + oW[2] * 0.006 * s;
    dark.beam([px, gy, pz], [px, gy + h * 0.95, pz], 0.004 * s, 3);   // downpipe
}

/** A dark landing pad + a white H marking. */
function helipad(dark: Accum3D, mark: Accum3D, foot: V2[], c: V2, topY: number, s: number): void {
    const r = Math.min(0.13 * s, Math.sqrt(Math.max(0, polyArea(foot))) * 0.34);
    if (r < 0.02 * s) return;
    dark.disc([c[0], topY + 0.004 * s, c[1]], [0, 1, 0], r, 18);
    const bar = (dx: number, ax: V3, hx: number, hz: number) => mark.obox([c[0] + dx, topY + 0.007 * s, c[1]], ax, [0, 1, 0], [0, 0, 1], hx, 0.002 * s, hz);
    bar(-r * 0.34, [1, 0, 0], r * 0.07, r * 0.42);   // left post
    bar(r * 0.34, [1, 0, 0], r * 0.07, r * 0.42);     // right post
    bar(0, [1, 0, 0], r * 0.34, r * 0.07);            // cross bar
}

/** A tapering tower cap: a few shrinking tiers + a spire or antenna mast. */
function tower(roofs: Accum3D, dark: Accum3D, foot: V2[], c: V2, topY: number, rng: Rng, s: number): void {
    let cur = foot, y = topY;
    const tiers = rng.next() < 0.5 ? 2 : 3;
    for (let i = 0; i < tiers; i++) {
        const next = insetToward(cur, c, 0.3), th = (0.07 + rng.next() * 0.08) * s;
        roofs.frustum(cur, next, y, y + th); cur = next; y += th;
    }
    roofs.cap(cur, y, 1);
    if (rng.chance(0.6)) roofs.pyramid(cur, y, (0.1 + rng.next() * 0.16) * s);
    else dark.prism([c[0], y, c[1]], 0.005 * s, 0.005 * s, (0.1 + rng.next() * 0.12) * s, 4);
}
