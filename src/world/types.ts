// ── World generation — shared types ─────────────────────────────────────────────────────────────
// Phase 1 (Layout) of the procedural world system (docs/specs/world-generation.md). This module is the
// GENERATION half (`sm.world.*`) — pure, deterministic geometry from a seed. It is a self-contained module:
// it imports only the renderer's MeshGeometry type; Salsa core NEVER imports `src/world/` (the bridge is
// `world-manager.ts`). The runtime SIM half lives in the separate `src/game/` module.
//
// Coordinate convention: layout works in a 2D plane `V2 = [x, y]`. The bridge maps it to the ground plane as
// world (x, groundY, y) — i.e. the layout's Y becomes world Z, so +Y in the map is "north/away" on the ground.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { GroundSurfaceName } from './ground-surfaces';

/** Metres per building FLOOR in the city bridge. With `streets.ts` sizing a floor at 0.2 * scale world
 *  units, this is what fixes the city's real-world scale: at the default radius one world unit = 15 m.
 *  ★ Lives here (the shared base module) rather than in streets.ts because `preview.ts` needs it too and
 *  streets.ts already imports preview.ts — importing back would be a cycle. */
export const CITY_FLOOR_M = 3;

/** Metres per WORLD UNIT in the city diorama. `streets.ts` sizes a building floor at `0.2 * (radius/10)`
 *  world units and a floor is CITY_FLOOR_M metres tall, so one world unit spans `CITY_FLOOR_M / (0.2 * s)`
 *  metres — 15 m at the default radius. ★ Nine call sites across eight `src/world` files derived this by
 *  hand; they MUST agree (the canal-gap bug was exactly two copies of one length disagreeing), so it lives
 *  here as the single source of truth. Takes `radius` — the universal input every site already has. */
export function cityMetresPerUnit(radius: number): number {
    return CITY_FLOOR_M / (0.2 * (radius / 10));
}

/** Detail frequency for the METAL material (`metalScale`), in cycles per WORLD UNIT. ~3 cycles per real
 *  metre becomes `3 * metresPerUnit` per unit — derived, never hardcoded, so it tracks the diorama scale. */
export function metalScaleFor(radius: number): number {
    return 3 * cityMetresPerUnit(radius);
}

export type V2 = [number, number];

/** Overall silhouette the city is clipped to (all convex → Sutherland–Hodgman clip works). */
export type BorderShape = 'circle' | 'square' | 'hexagon' | 'octagon';

/** How the street network is generated. Hybrid per §6.3: cities lean 'grid', towns lean 'radial'. */
export type RoadPattern = 'radial' | 'grid';

/** What a parcel is zoned for → drives colour now, and building/biome density later. */
export type Zone = 'civic' | 'commercial' | 'residential' | 'park' | 'water' | 'plaza';

/** What ultimately fills a slot (consumed by later composers). */
export type SlotKind = 'building' | 'park' | 'water' | 'plaza' | 'landmark' | 'shotengai' | 'empty';

/** A pedestrian shopping street (shotengai): a run of grid cells with paving, market stalls + entry arches. */
export interface Shotengai { cells: [number, number][]; spine: [V2, V2]; width: number; region: number; }

/** A significant building that claims a whole block (own silhouette + a game spawn/interaction anchor). */
export type LandmarkType = 'cityhall' | 'station' | 'museum' | 'hospital' | 'shrine' | 'radiotower' | 'postoffice' | 'stadium' | 'powerplant' | 'megatower' | 'school';
export interface Landmark { id: number; type: LandmarkType; block: number; footprint: V2[]; center: V2; entrance: V2; }

export type RoadClass = 'arterial' | 'ring' | 'street' | 'alley';

/** A neighbourhood character (coarser than Zone) — biases signage/screens/balconies + later landmarks. */
export type DistrictType = 'downtown' | 'residential' | 'civic' | 'market' | 'mixed';

/** One district INSTANCE (a Voronoi seed) — a contiguous neighbourhood + the unit of the active-region editor. */
export interface RegionSeed { id: number; type: DistrictType; center: V2; }

/** All knobs for a layout. Everything is seed-derived; the same params → the same city, byte for byte. */
export interface LayoutParams {
    seed: number;
    radius: number;          // half-size of the diorama, in world units (the border fits inside ±radius)
    border: BorderShape;
    borderSides: number;     // circle resolution (Ngon sides) — ignored for square/hex/octagon
    pattern: RoadPattern;
    // radial
    spokeCount: number;      // main arterials from the plaza to the edge
    ringCount: number;       // concentric ring roads
    // grid
    gridCols: number;
    gridRows: number;
    // subdivision
    lotsRadial: number;      // lots per block along the radial / row axis
    lotsAngular: number;     // lots per block along the angular / column axis
    // widths (world units)
    streetWidth: number;     // gap between lots (the visible streets)
    arterialWidth: number;   // main road width (graph data for later phases)
    plazaRadius: number;     // central plaza half-size (× radius)
    // dressing
    parkChance: number;      // 0..1 chance a block becomes a park
    waterChance: number;     // 0..1 chance a block becomes water
    junctionVariety: number; // 0..1 (grid) — fraction of junctions that become non-4-way (T / corner) via road removal
    elevation: number;       // 0..1 — terrain relief (0 = flat; gentle rolling hills otherwise)
    warp: number;            // 0..1 — DOMAIN WARP: 0 = clean grid, 1 = organic old-town (roads curve, blocks vary)
    terraces: boolean;       // grid — discrete raised terraces (retaining walls + stairs where the level steps up)
    groundY: number;         // world Y the flat map sits at
    // streetscape detail
    sidewalks: boolean;      // draw a sidewalk band around each block
    roadPaint: boolean;      // lane lines (dashed centre + solid sides) + crosswalks at intersections
    streetLights: boolean;   // taller light poles at intersections (in addition to lamp posts along roads)
    trafficLights: boolean;  // Japanese-style horizontal 3-lamp signals (pole + arm + sign) at junctions
    signage: boolean;        // shop signage along building frontages (flat over-door signs + projecting blades)
    landmarks: boolean;      // place significant buildings (city hall / station / museum) on civic/market blocks
    shotengai: boolean;      // grid — a pedestrian shopping street through the market district (arch + stalls)
    cornerStyle: CornerStyle;// building footprint corners: sharp | chamfer | round | mixed (seeded per building)
    roofStyle: RoofStyle;    // building rooftop treatment (seeded per building when 'mixed')
    // detail pass (docs/specs/city-detail.md)
    awnings: boolean;        // ground-floor striped awnings + shopfront glass + noren on shop frontages
    streetFurniture: boolean;// vending machines / benches / bus stops / manholes / post boxes / cones / guardrails
    powerLines: boolean;     // utility poles + overhead catenary wires beside the roads (the JP street look)
    parkedCars: boolean;     // low-poly parked cars (+ bus/truck/taxi variants) along the curbs
    nightMode: boolean;      // crank emissives (lit windows / neon signs / lamps) for a night render
    // detail pass 2
    streetTrees: boolean;    // trees + planters lining the streets (not just parks); some are pink sakura
    leafColor?: [number, number, number];  // TINT MULTIPLIER on ALL city foliage ([1,1,1] = no change). Shift the whole city warmer/cooler while keeping per-tree-type differences; works on sakura pink too (multiplies any base colour).
    leafColorVar?: number;   // 0..1 — how much each tree's leaf LIGHTNESS may vary (default 0.08). Kept SUBTLE: even at 1.0 the effective jitter caps at ±0.18 lightness (a uniform rgb multiply — no hue shift), so trees vary naturally, never rainbow.
    bicycles: boolean;       // parked bicycles + bike racks near shops / stations
    lanterns: boolean;       // strung paper lanterns (chōchin) over the shotengai + downtown alleys (glow)
    railway: boolean;        // an elevated railway viaduct with a train running across the city
    rooftops: boolean;       // rooftop water tanks / AC units / antennas on flat roofs
    facadeDetail: boolean;   // fire escapes + pipes + AC boxes on some building facades
    detailedBuildings: boolean;  // ON (default) = full procedural buildings; OFF = the basic extruded-box fallback
    quoinStyle?: 'alternating' | 'block';   // CITY-WIDE quoin geometry for detailed buildings — 'alternating' (default, interlocking stones) or 'block' (the old chunky cubes)
                                 // (buildBuilding per lot: real facades / windows / balconies / trim), fit to each lot
    detailGrid: number;          // 0 = detail merged CITY-WIDE (few draws, no cull); N = N×N spatial grid so off-screen cells frustum-cull (more draws, scales larger). PERF TOGGLE while we profile.
    pedestrians: boolean;    // tiny static people on sidewalks / the shotengai / the plaza (crowd v1; sim moves them later)
    pedestrianDensity: number;   // ×multiplier on the crowd count (static peds + walking movers). 1 = default; crank for a busy city.
    traffic: boolean;        // MOVING cars/train/walkers while in City mode (the live sim ticker)
    clouds: boolean;         // drifting procedural clouds above the city (part of the live ticker)
    cloudDensity: number;    // 0..1 — how many clouds (≈3 at 0 … ≈18 at 1)
    holograms: boolean;      // the CYBER suite: holo fish + billboards, flying vehicles, robot walkers, megatower + sky-train
    weather: 'clear' | 'rain' | 'snow';   // rain = streaks/grey deck/wet roads/lightning · snow = drifting flakes + frosted ground
    fog: boolean;            // day/night-cycle distance fog (haze for depth); false = fog off
    palette: 'auto' | 'terracotta' | 'slate' | 'pastel' | 'brick' | 'mint';   // city colour grade ('auto' = seeded pick)
    // world borders (docs/specs/world-borders.md — Phase A)
    voidGrid: boolean;       // emissive grid / rings extending PAST the border into the void (the "cyberspace" floor); shape follows border
    borderGlow: boolean;     // emissive outline ribbon along the city border (reads especially in City Edit Mode)
    voidExtent?: number;     // how far the void grid reaches (× radius; default 5)
    voidGridSpacing?: number;// DEPRECATED / unused — the void grid cell is now always exactly the city's size + shape (one cell = one tile). Kept so old saves + the (now removable) Frogmarks slider don't break.
    voidLineWidth?: number;  // grid line half-thickness (× city radius; default 0.025)
    borderGlowHeight?: number;// raised luminous border-wall height (× city scale R/10; default 1.2; 0 = flat ribbon only)
    // terrain apron (Phase B) — nature past the border
    terrainApron: boolean;   // grass/field ground + forest patches + rocks filling the ring beyond the city
    apronRadius?: number;    // how far the nature ring reaches (× radius; default 2.5)
    natureDensity?: number;  // 0..1 — how densely forest/fields fill the apron (default 0.6)
    // multi-tile expansion (Phase C1) — a bigger flat world of connected city tiles
    worldMode?: 'diorama' | 'tiled';  // 'diorama' = one city (default); 'tiled' = an N×N block of connected tiles
    tileRadius?: number;     // tiled: rings of tiles around the centre (0=1×1, 1=3×3, 2=5×5; default 1). Grid/square tiles only.
    tileDetail?: 'flat' | 'focus' | 'full';   // tiled LOD: 'flat' = all tiles flat maps (cheap overview) · 'focus' = centre 3D + neighbours flat (default) · 'full' = EVERY tile full 3D (heavy — memory grows with tile count)
}

export type CornerStyle = 'sharp' | 'chamfer' | 'round' | 'mixed';
export type RoofStyle = 'flat' | 'pointed' | 'parapet' | 'chamfer' | 'rounded' | 'helipad' | 'tower' | 'spire' | 'mansard' | 'mixed';

/** Junction shape: cross = 4 arms (→ traffic light) · tee = 3 arms (→ stop sign) · corner = 2 perpendicular arms (→ nothing). */
export type JunctionType = 'cross' | 'tee' | 'corner';

/** A road junction. `arms` = the unit direction of EACH road arm meeting here (2–4); drives crosswalks + signals. */
export interface Intersection { pos: V2; arms: V2[]; type: JunctionType; }

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
    seed: 1,
    radius: 10,
    border: 'square',
    borderSides: 64,
    pattern: 'grid',
    spokeCount: 8,
    ringCount: 4,
    gridCols: 11,
    gridRows: 11,
    lotsRadial: 2,
    lotsAngular: 3,
    streetWidth: 0.40,
    arterialWidth: 0.5,
    plazaRadius: 0.09,
    parkChance: 0.12,
    waterChance: 0.06,
    junctionVariety: 0.3,
    elevation: 0.45,
    warp: 0.35,
    terraces: true,
    groundY: 0,
    sidewalks: true,
    roadPaint: true,
    streetLights: true,
    trafficLights: true,
    signage: true,
    landmarks: true,
    shotengai: true,
    cornerStyle: 'mixed',
    roofStyle: 'mixed',
    awnings: true,
    streetFurniture: true,
    powerLines: true,
    parkedCars: true,
    nightMode: false,
    streetTrees: true,
    leafColor: [1, 1, 1],      // no tint by default — trees keep their per-kind colours
    leafColorVar: 0.08,        // subtle per-tree lightness variety (effective jitter caps at ±0.18)
    bicycles: true,
    lanterns: true,
    railway: true,
    rooftops: true,
    facadeDetail: true,
    // ★ ON by default. The extruded-box fallback has no doors, no frames, no entrance detail at all, so
    // the default city was missing its whole street-level read and every tester had to tick this by hand.
    // Cost measured on a radius-10 grid: 384 -> 691 ms build, 2.65M -> 4.92M triangles (1.8x / 1.9x); the
    // zoom LOD already culls the detail band, so the far field is unaffected.
    detailedBuildings: true, quoinStyle: 'alternating',
    detailGrid: 0,              // default 0 = city-wide merge (current baseline); set N>0 for N×N spatial chunking
    pedestrians: true,
    pedestrianDensity: 1,      // crowd multiplier — salsaWorld.update({ pedestrianDensity: 20 }) for a packed city
    traffic: true,
    clouds: true,
    cloudDensity: 0.55,
    holograms: false,
    weather: 'clear',
    fog: true,
    palette: 'auto',
    voidGrid: true,
    borderGlow: true,
    terrainApron: false,
};

/** A road centerline (graph data; the Street composer walks these later). The preview shows roads as the gaps. */
export interface RoadSegment { a: V2; b: V2; width: number; klass: RoadClass; ring?: number; }

/** A single parcel — the atom later composers fill (a building, a tree cluster, a pond…). */
export interface Lot {
    id: string;
    poly: V2[];        // clipped footprint (CCW)
    center: V2;
    zone: Zone;
    slot: SlotKind;
    block: number;     // owning block id
    area: number;
    /** Built massing height, stamped by buildStreets — later composers (signage/awnings) clamp wall dressing to it. */
    builtH?: number;
    /** Shop kind ("BAKERY" / "GROCER" / "CLINIC" …), stamped for labelled shops — future NPC schedules hook here. */
    shopType?: string;
    /** Variety-block claim (construction/parking/gas), stamped by buildStreets. Lets a RE-RUN of buildStreets
     *  on the same graph walk the identical code path (the claim sets slot='empty', which would otherwise
     *  skip the lot early and shift the seeded RNG stream for every later building). */
    variety?: 'construction' | 'parking' | 'gas';
    /** Front-door anchor (stamped by buildStreets' addEntrance) — the door-visit sim walks pedestrians here. */
    door?: V2;
    /** The door's outward (street-facing) direction. */
    doorOut?: V2;
}

/** A block = one cell of the generating structure (a ring×sector wedge, or a grid cell), pre-subdivision. */
export interface Block { id: number; poly: V2[]; ring: number; sector: number; zone: Zone; district?: DistrictType; region?: number; level?: number; lots: string[]; }

/** The whole layout graph — consumed by Biome / Street / Landmark / NPC composers. */
export interface WorldGraph {
    params: LayoutParams;
    border: V2[];      // convex border polygon (CCW)
    center: V2;
    radius: number;
    roads: RoadSegment[];
    blocks: Block[];
    lots: Lot[];
    intersections: Intersection[];
    regions: RegionSeed[];   // district instances (Voronoi seeds) — the active-region editor unit
    landmarks: Landmark[];   // significant buildings claiming whole blocks (+ entrance anchors for the game)
    shotengai: Shotengai | null;   // a pedestrian shopping street through the market district (grid only)
    levels: number[][] | null;   // grid — discrete terrace level per cell [ci][ri] (0 = base); null for radial
    ramps?: Ramp[];    // road ramps that slope a carriageway between two terrace levels (so cars climb, not fall off)
    ponds: V2[][];     // rounded water features inside park blocks (canals = the 'water'-zone lots)
    bridges: V2[][];   // road-deck quads where a cross-street spans a canal
    plaza: V2[] | null;
    bounds: { min: V2; max: V2 };
}

/** A road RAMP: a stretch of carriageway that slopes smoothly between two terrace levels so a car climbs it
 *  instead of dropping off the retaining-wall cliff. A corridor `len` long × `halfWidth` wide, centred on the
 *  step, oriented up the `(ax,az)` axis. Consumed by makeElevation (drape + car Y), terraces (wall gap) and
 *  traffic (let a run cross). See elevation.ts computeRamps / rampLevelAt. */
export interface Ramp {
    x: number; z: number;        // corridor centre (the step location, a road/boundary crossing)
    ax: number; az: number;      // unit axis ALONG the road, pointing UPHILL
    loLevel: number; hiLevel: number;   // terrace levels at the low / high end
    len: number; halfWidth: number;     // corridor length (along axis) / half-width (across)
}

/** One flat colour layer of the top-down preview map (roads / a zone / parks / water / plaza). */
/** One placement of an instanced (canonical) geometry: translate + yaw, with an optional per-instance tint. */
export interface InstanceXform {
    x: number; y: number; z: number; ry: number;
    /** Per-instance UNIFORM scale. Used by the city's instanced trees for two things at once: converting
     *  the foliage generator's real metres into diorama world units, and per-tree size variation so a small
     *  variant pool does not read as the same tree stamped repeatedly. */
    s?: number;
    tint?: [number, number, number];
    /** GARP (docs/specs/city-props-garp.md §2): the SKIN NAME this instance wears (chosen in world-gen by
     *  position hash — see `pickSkin`). Resolved to a dedicated-GARP-atlas layer at scene instantiation via the
     *  layer's `garp` marker + the services resolver → written as this copy's per-instance textureIndex. A NAME,
     *  never a layer index (layers are session-local). Only meaningful when the layer carries `garp`. */
    skin?: string;
}

export interface LayoutPreviewLayer {
    name: string;
    color: [number, number, number]; // linear-ish 0..1 RGB
    y: number;                        // world Y (tiny per-layer offset avoids z-fighting)
    geometry: MeshGeometry;
    /** Optional in-shader procedural pattern — "free" surface texture, no geometry. `color` = the secondary/line
     *  colour (primary = the layer `color`). `mode` picks the motif (default `grid` = joints/mullions); `stripes`
     *  (awnings), `checker` (paving), `windows` (hash-LIT window cells — `spacing` = lit fraction, lit cells glow),
     *  `waves` (ANIMATED drifting bands — `spacing` = scroll speed, bands carry the glow: screens/water).
     *  `angle` rotates (radians). `freq` = cells across the UV. */
    pattern?: { color: [number, number, number]; freq: number; scale?: number; mode?: 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid' | 'windows' | 'waves'; angle?: number; spacing?: number };
    /** ★ Optional PROCEDURAL GROUND surface (procedural-ground.md §11) — pavers/asphalt/turf generated per
     *  fragment from a handful of params, replacing the flat colour + `pattern` motif. MUTUALLY EXCLUSIVE
     *  with `pattern` (both ride the same instance slots); `ground` wins if both are set.
     *  The city's ground geometry is uv = worldXZ * 0.5, so adjacent road / pavement / plaza meshes tile
     *  CONTINUOUSLY — the consumer sets `groundWorldUV` for that, which also retargets the weathering masks. */
    ground?: { surface: GroundSurfaceName; tint?: [number, number, number]; tileMm?: number; groutMm?: number;
        jitter?: number; weather?: 'new' | 'worn' | 'ancient' | 'mossy' | 'dirty';
        /** METRES PER WORLD UNIT — the city is a diorama (1 unit = 15 m). Without it every tile size
         *  and noise frequency is off by exactly that factor. See Material3D.groundWorldScale. */
        metersPerUnit?: number };
    /** ★ How this layer meets the terrain, overriding the name-based classification in the drape pass.
     *   · `'full'`   — drape per-vertex on smooth terrain + the DISCRETE terrace step. Only safe for finely
     *                  subdivided ground (the road grid), because a step is a discontinuity: a coarse
     *                  polygon spanning one cannot represent it and linearly RAMPS between the two levels,
     *                  which is the "assets stretch between the higher and lower half" artifact.
     *   · `'smooth'` — drape on the smooth field only; the discrete level is already baked into the
     *                  geometry (per polygon, at its centroid) so each piece is flat at its own level.
     *   · `'baked'`  — already world-ready; the height pass must not touch it. */
    drape?: 'full' | 'smooth' | 'baked';
    /** ★ Skip the horizontal DOMAIN WARP for this layer — it stays geometrically pure in layout space. Used by
     *  the ELEVATED RAILWAY: the viaduct + guideway are rigid structures that must NOT ripple with the ground
     *  warp, otherwise their sparse geometry (a single deck box, a few rail segments) approximates the warp curve
     *  far more coarsely than the moving train samples it — and the train drifts off the rails. Both the static
     *  rail geometry AND the train mover skip the warp, so they share one pure coordinate space. */
    noWarp?: boolean;
    /** ★ PAINTED METAL (per-object tone + rain streaks + grime + roughness break-up). `scale` is CYCLES
     *  PER WORLD UNIT, so it must be set for the world's scale. */
    metal?: { tint?: [number, number, number]; streak?: [number, number, number]; roughness?: number;
        streakAmount?: number; grime?: number; scale?: number };
    /** ★ A LIT SIGN (scanlines + per-sign flicker + diffuser falloff), driving the emissive term.
     *  `phase` must differ per sign or the whole street flickers together. */
    neon?: { glow?: [number, number, number]; accent?: [number, number, number];
        scanDensity?: number; flicker?: number; scroll?: number; phase?: number };
    /** ★ Render SINGLE-SIDED (back-face culled). City meshes are double-sided by default, which is right
     *  for open shells, but WRONG for anything whose two faces carry different UVs: a text sign plate is
     *  two quads with MIRRORED U so it reads from both sides, and that only works if each face is hidden
     *  from behind. Double-sided, the mirrored back face z-fights the front (they sit ~2 cm apart) and you
     *  get mirror-writing. */
    singleSided?: boolean;
    /** ★ Real WATER (ripple normal + Fresnel + sun glitter) instead of the old scrolling-band `pattern`
     *  motif. Mutually exclusive with `pattern` / `ground` — they share the instance slots.
     *  `waveScale` is CYCLES PER WORLD UNIT, so it must be set for the world's scale. */
    water?: { deep?: [number, number, number]; shallow?: [number, number, number];
        waveScale?: number; waveSpeed?: number; choppy?: number; glitter?: number };
    /** Instanced content big enough to cast a real shadow (city trees). Instanced draws are excluded
     *  from the shadow + outline passes by default — see Mesh3D.castsInstancedShadow. */
    castShadow?: boolean;
    /** Optional emissive strength override (0..1) — higher = glows (neon signs, lit windows, lamps at night). Default ~0.45. */
    emissive?: number;
    /** Optional opacity (<1 = transparent pass) — clouds. */
    opacity?: number;
    /** Skip this layer when auto-framing the camera — FAR decoration (void grid / border glow / terrain apron)
     *  that extends past the city and would otherwise shrink the framed view. */
    excludeFromFrame?: boolean;
    /** PERF: meshes sharing this key share ONE GPU geometry allocation + get batched into instanced draws
     *  (the renderer sorts same-key instance slots contiguously). Used by traffic mover ARCHETYPES — every
     *  red car body is the same geometry object. Only set when the geometry really is identical. */
    instanceKey?: string;
    /** INSTANCED layer: `geometry` is LOCAL/CANONICAL (built at the origin, +Z = outward, +X = along-face, Y from the
     *  sill) and is drawn ONCE PER transform in `instances` (all sharing one geometry via `instanceKey`). When absent
     *  the geometry is world-baked as usual. Per-instance `tint` overrides the layer `color` for that copy (free —
     *  material is per-instance in the renderer). Used for repeated building detail (juliet balconies / window trim). */
    instances?: InstanceXform[];
    /** When true (with `instances`), render as ONE GPU-instanced ArrayGroup (1 node + 1 draw for ALL instances)
     *  instead of one shared-key mesh per instance. For CITY-scale repetition (thousands of instances) where the
     *  per-instance node count of the shared-key path would bite. All instances share the layer material. */
    arrayGroup?: boolean;
    /** Alpha-test the quad into a procedural LEAF silhouette (order-independent). Foliage `render:'card'` leaf layers. */
    leafCard?: boolean;
    /** Mark this layer as GLASS → stylized fresnel sky-reflection when the global glass-quality toggle is on. */
    glass?: boolean;
    /** Soft radial alpha falloff from the UV centre (mesh flag bit 17). The layer's meshes dissolve to nothing at
     *  their rim — a lamp light-pool that reads as a soft glow on the pavement instead of a hard-edged sticker
     *  disc. Pair with a disc/quad whose UVs are centred (see `MeshBuild.disc`) + opacity<1 (transparent pass). */
    radialFade?: boolean;
    /** Per-OBJECT index sub-ranges within this merged layer's geometry — `{ id, start, count }` where `start`/`count`
     *  are indices relative to this mesh. Lets the hover-outline pass trace ONE object's exact silhouette out of a
     *  merged mesh (landmarks merge all buildings into ~9 material meshes). See buildLandmarks + setHoverOutlineRanges. */
    outlineRanges?: { id: number; start: number; count: number }[];
    /** CAR-PAINT / clearcoat REFLECTION (docs/specs/car-creator.md §matcap): route the layer through the base PBR
     *  path with a raised metalness + low roughness so it reflects the env hemisphere (the GT sheen that sweeps as
     *  the body turns). No new material flag — it's just clearcoat-like metalness/roughness. `strength` ≈ metalness
     *  (0.35–0.5), `roughness` ≈ gloss (lower = sharper sky). */
    reflect?: { strength?: number; roughness?: number };
    /** GARP (docs/specs/city-props-garp.md §2): this layer's meshes sample the DEDICATED GARP atlas for `pool`'s
     *  `slot`. Set on an INSTANCED layer (canonical geometry + per-copy transforms) — scene instantiation flags the
     *  material `garpTex` and writes each copy's textureIndex. ★ SKIN SELECTION HAPPENS AT INSTANTIATION, not here:
     *  world-gen only supplies positions + `seed`, and the services resolver runs `pickSkin` over the RUNTIME pool
     *  (so USER-ADDED variants are eligible — a static world-gen pick could only ever choose the built-in skins).
     *  An instance may still force a specific {@link InstanceXform.skin} by name (explicit consumers); otherwise the
     *  copy's (x,z)+seed hash chooses. The atlas itself is built services-side (the pool's skin textures are content). */
    garp?: { pool: string; slot: string; seed: number };
    /** Override the render STYLE for this layer's meshes (e.g. 'cel' for toon/Ghibli foliage). Default = scene/PBR. */
    renderStyle?: 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud';
    /** Add a Fresnel rim / back-light glow (Ghibli-ish backlit leaves). */
    rim?: boolean;
    /** WIND (foliage-quality.md S1) — height-graded vertex sway. `height` = this layer's LOCAL plant height
     *  (the grading denominator, metres), `stiffness` = the bend exponent (grass ≈1.2, hedge ≈3),
     *  `amount` = per-layer scale (trunks/vessels tiny, blades 1). Scene direction/strength/speed are global. */
    wind?: { height: number; stiffness: number; amount: number };
    /** TRANSLUCENCY + GROUND BLEND + BASE AO (foliage-quality.md S2) — the fragment half of the shared
     *  foliage look. Leave off for trunks/vessels (opaque wood/ceramic never transmits). */
    foliageShade?: { translucency?: number; translucencyColor?: [number, number, number]; groundBlend?: number; groundTint?: [number, number, number]; baseAO?: number };
}
