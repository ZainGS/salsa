// ── World generation — shared types ─────────────────────────────────────────────────────────────
// Phase 1 (Layout) of the procedural world system (docs/specs/world-generation.md). This module is the
// GENERATION half (`sm.world.*`) — pure, deterministic geometry from a seed. It is a self-contained module:
// it imports only the renderer's MeshGeometry type; Salsa core NEVER imports `src/world/` (the bridge is
// `world-manager.ts`). The runtime SIM half lives in the separate `src/game/` module.
//
// Coordinate convention: layout works in a 2D plane `V2 = [x, y]`. The bridge maps it to the ground plane as
// world (x, groundY, y) — i.e. the layout's Y becomes world Z, so +Y in the map is "north/away" on the ground.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';

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
    bicycles: boolean;       // parked bicycles + bike racks near shops / stations
    lanterns: boolean;       // strung paper lanterns (chōchin) over the shotengai + downtown alleys (glow)
    railway: boolean;        // an elevated railway viaduct with a train running across the city
    rooftops: boolean;       // rooftop water tanks / AC units / antennas on flat roofs
    facadeDetail: boolean;   // fire escapes + pipes + AC boxes on some building facades
    detailedBuildings: boolean;  // OFF = the basic extruded boxes (fallback, default); ON = full procedural buildings
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
    bicycles: true,
    lanterns: true,
    railway: true,
    rooftops: true,
    facadeDetail: true,
    detailedBuildings: false,   // default OFF — the basic city is the fallback / less-detailed option
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
    ponds: V2[][];     // rounded water features inside park blocks (canals = the 'water'-zone lots)
    bridges: V2[][];   // road-deck quads where a cross-street spans a canal
    plaza: V2[] | null;
    bounds: { min: V2; max: V2 };
}

/** One flat colour layer of the top-down preview map (roads / a zone / parks / water / plaza). */
/** One placement of an instanced (canonical) geometry: translate + yaw, with an optional per-instance tint. */
export interface InstanceXform { x: number; y: number; z: number; ry: number; tint?: [number, number, number]; }

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
    /** Override the render STYLE for this layer's meshes (e.g. 'cel' for toon/Ghibli foliage). Default = scene/PBR. */
    renderStyle?: 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud';
    /** Add a Fresnel rim / back-light glow (Ghibli-ish backlit leaves). */
    rim?: boolean;
}
