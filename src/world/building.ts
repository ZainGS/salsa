// ─────────────────────────────────────────────────────────────────────────────
// Procedural Building Generator (spec: docs/specs/building-generator.md)
//
// Pure: BuildingParams in → { layers, meta } out. The CITY / Building Creator owns
// PLACEMENT; this module owns the ARTIFACT. It reuses the Accum3D primitives + the
// windows-pattern shader (like the city's inline extrude) but composes a FACADE from
// stackable parts driven by a TYPOLOGY (category × archetype).
//
// Architecture: this file = types + params + archetype library + orchestration + LAYER
// ASSEMBLY (colour/pattern per accumulator). The geometry PART BUILDERS live in
// building-parts.ts; pure geometry helpers in building-geom.ts.
//
// Phases built: 1 core+typology+facade engine · 2 storefronts (shop bays) · 3 facade
// detail+materials (pilasters/quoins/cornice/downpipes/wall-AC/fire-escape) · 4 rooftop
// detail (penthouse/railing/tanks/AC/antenna/dishes/vents/garden/helipad) · 5 towers
// (setbacks/podium/crown/mullions) · 6 signage/neon (blade/wrap/rooftop signs + LED
// screens) · 7 traditional (machiya/warehouse/mall) · city-quality pass (docs/specs/city-quality-upgrade.md B2–B11):
// per-edge FRONTAGE (street / open / party — party walls plain), one window row per STOREY, Japanese sash windows,
// tile / siding / plaster facades, zakkyo / apaato / mansion / konbini / izakaya / jp-house archetypes, lit shop
// interiors + roller shutters, lettered sign stacks / tenant signs / billboards, utilities (AC + pipes, meters,
// vents, laundry), front-aligned roofs sized from the real footprint, and a separate parapet layer.
// ─────────────────────────────────────────────────────────────────────────────

import { Accum3D, mergePartsInto } from './meshbuild';
import { TwinAccum3D, loSpecFor, loGeometry, PROP_TWIN_M } from './lod-accum';
import { chamferPolygon, roundPolygon } from './util';
import type { V2, LayoutPreviewLayer, InstanceXform } from './types';
import { LIT, rectFoot, edgesOf, frontEdge, avoidTinyFront, mulberry, centroid, bbox, signedArea, ihash } from './building-geom';
import type { Edge, FrontageMask } from './building-geom';
import {
    emitMassing, emitFacadeDetail, emitStorefront, emitBalconies, emitJulietBalconies, emitWindowTrim, emitWindowSills, sillColor,
    emitRoof, emitRoofDetail, emitSignage, emitTraditional, emitGreenery, emitUtilities, emitJapanese,
    facadeCode,
} from './building-parts';
import { buildFoliage } from './foliage';
import type { FoliageParams } from './foliage';
import { AdvertSink } from './adverts';
import { signGlowTextColor, signInkColor, signFrameColor, signLum } from './sign-style';
import type { AdvertCatalog } from './adverts';

type V3 = [number, number, number];

/** A manually-placed foliage instance on a building (position in building-local metres) — stored in building params so
 *  it travels + persists with the building. `rot` = Y rotation (rad). Foliage params default if omitted. */
export type FoliagePlacement = Partial<FoliageParams> & { x: number; z: number; rot?: number };

export type BuildingCategory = 'house' | 'shophouse' | 'apartment' | 'office' | 'tower' | 'machiya' | 'warehouse' | 'mall';
export type WindowStyle = 'grid' | 'punched' | 'ribbon' | 'curtain';
export type BuildingCorner = 'sharp' | 'chamfer' | 'round';
/** Facade material. `plaster` = painted RENDER; `panel` = windowed metal-panel CLADDING (aluminium composite panels,
 *  facade code 8) — unlike `metal`, which is the warehouse's windowless corrugated sheet. */
export type BuildingMaterial = 'concrete' | 'brick' | 'plaster' | 'tile' | 'glass' | 'timber' | 'metal' | 'siding' | 'panel';
export type RoofStyle = 'flat' | 'parapet' | 'hip' | 'gable' | 'mansard' | 'sawtooth' | 'tiled-hip';
export type CrownStyle = 'none' | 'spire' | 'mech' | 'blade';
export type AwningStyle = 'flat' | 'sloped' | 'dome';
export type QuoinStyle = 'alternating' | 'block';   // alternating = interlocking corner stones (default); block = the old chunky corner cubes
export type DoorStyle = 'flush' | 'panel' | 'glazed' | 'double' | 'auto-slide' | 'sliding';   // sliding = Japanese wood-lattice sliding door
export type BalconyStyle = 'rail' | 'panel';   // rail = slab + railing per window · panel = continuous slab, frosted fronts + unit dividers (mansion)

/** The user-/city-facing knob record (what the Building Creator edits + persists). */
export interface BuildingParams {
    category: BuildingCategory;
    archetype: string;
    seed: number;
    // ── massing ──
    floors: number; width: number; depth: number; floorHeight: number; groundFloorHeight: number;
    cornerStyle: BuildingCorner; cornerAmount: number;
    setbacks: number;            // upper setbacks (towers) — 0 = straight
    setbackInset: number;        // footprint shrink per setback (world units)
    podium: boolean;             // wider retail base under a tower
    podiumFloors: number;
    // ── facade ──
    windowStyle: WindowStyle; bayWidth: number; material: BuildingMaterial;
    windowSash: boolean;         // Japanese aluminium SLIDING SASH: wide + low openings with a centre meeting rail
    glassTransparent: boolean;   // see-through "aquarium" glass (shows the interior) vs opaque glazed skin
    pilasters: boolean;          // vertical trim strips between bays
    quoins: boolean;             // corner stone blocks
    quoinStyle?: QuoinStyle;     // which quoin geometry (default 'alternating'); 'block' = the old chunky cubes
    cornice: boolean;            // pronounced crown moulding
    mullions: boolean;           // real curtain-wall fins (glass towers)
    // ── ground / storefront ──
    storefront: boolean; shopBays: number; stallriser: boolean; transom: boolean;
    shutter: boolean; awning: boolean; awningStyle: AwningStyle; awningStripe: boolean; noren: boolean; recessedEntry: boolean;
    rollerDoors: boolean;        // warehouse/industrial
    canopy: boolean;             // mall/entrance canopy
    lattice: boolean;            // machiya ground lattice (koshi)
    doorStyle: DoorStyle;        // flush / panel / glazed / double / auto-slide / sliding
    shopInterior: boolean;       // shop windows show a lit shop interior (shelves, posters, fluorescent light) vs plain dark glass
    shutterBays: number;         // 0..1 — fraction of shop bays with a roller shutter partly/fully down
    fascia: boolean;             // konbini-style lit full-width fascia band (colour stripes + logo) over the glazing
    lanterns: boolean;           // izakaya red paper lanterns (chouchin) either side of the entrance
    menuBoard: boolean;          // standing menu board beside the entrance
    // ── features ──
    balconies: boolean; julietBalconies: boolean; windowTrim: boolean; ledges: boolean; fireEscape: boolean; downpipes: boolean; wallUnits: boolean;
    /** Persona polish D2: a slim projecting SILL under every upper-floor window (instanced; skipped where a
     *  `windowTrim` surround already carries one). The recessed REVEAL itself is drawn by the window shader. */
    windowSills: boolean;
    balconyStyle: BalconyStyle;
    openCorridor: boolean;       // apaato: an open walkway along the front of every upper floor, a door per flat
    outsideStair: boolean;       // external steel stair (apaato walkway stair / zakkyo back stair)
    acUnits: boolean;            // AC condensers with pipe runs (side/back walls, balconies, corridors)
    utilities: boolean;          // meters, conduit, drain pipes, kitchen vents (the lived-in facade clutter)
    laundry: boolean;            // laundry poles (+ washing) on balconies / back windows
    // ── roof ──
    roofStyle: RoofStyle; roofPitch: number; deepEaves: boolean;
    roofClutter: boolean; roofPenthouse: boolean; roofRailing: boolean; roofGarden: boolean;
    roofDishes: boolean; roofVents: boolean; helipad: boolean; crown: CrownStyle;
    roofAerial: boolean;         // Yagi TV aerial
    solarHeater: boolean;        // rooftop solar water heater (tilted panel + tank)
    /** visual-polish #11 tail: how a flat / parapet roof carries its plant. Absent / 'classic' = the scattered plant
     *  (the standalone Creator and cities saved before it); 'clustered' = one back-edge cluster (stair box in the wall
     *  colour, ONE coloured water tank, ONE AC bank) + up to two district extras (emitRoofDetailClustered). Set by the
     *  city from LayoutParams.roofEquipment. */
    roofPlant?: 'classic' | 'clustered';
    // ── signage ──
    signage: boolean; bladeSign: boolean; wrapSign: boolean; rooftopSign: boolean; ledScreen: boolean; neon: boolean;
    /** visual-polish #6: the LED screen shows the designed ad loop (absent / true) or the legacy 'waves' static
     *  (false: cities saved before LayoutParams.adScreens existed). */
    adScreen?: boolean;
    signStack: boolean;          // vertical sign STACK up the facade (one lit panel per floor, kanji lettering, steel frame)
    floorSigns: boolean;         // a tenant sign under every upper floor's windows (zakkyo)
    /** The city district the building stands in (downtown / market / residential …) — picks its sign WORDS
     *  (persona-polish C1). Optional: the standalone Creator derives the words from the archetype alone. */
    signDistrict?: string;
    // ── greenery (attached foliage, auto-placed from meta — foliage generator item 2) ──
    baseHedge: boolean; vines: boolean; windowBoxes: boolean; basePlanters: boolean;
    greeneryColor: [number, number, number]; bloomColor: [number, number, number];
    foliage: FoliagePlacement[];   // manually-placed attached foliage (Building Editor grid tool)
    // ── colour ──
    baseColor: [number, number, number]; trimColor: [number, number, number]; roofColor: [number, number, number];
    glassColor: [number, number, number]; accentColor: [number, number, number]; signColor: [number, number, number];
    signColor2: [number, number, number]; signColor3: [number, number, number];   // the other tenants' sign colours
    julietColor: [number, number, number];        // wrought-iron railing tint (defaults to dark iron)
    windowTrimColor: [number, number, number];    // window surround (sill/lintel/jambs) — apart from general trim
    julietScroll: number;                          // 0 = plain bars, 1 = full diamond + side scrolls
    storefrontColor: [number, number, number];   // shopfront framing (stallriser/transom/mullions)
    awningColor: [number, number, number];        // awning fabric
    doorColor: [number, number, number];          // door leaf
    doorFrameColor: [number, number, number];     // door jambs + head (the surround)
    doorHandleColor: [number, number, number];    // door handle / hardware
    nightWindows: number;        // 0..1 lit-window fraction (day/night ramps this live)
    renderStyle: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud';   // whole-building shading style (default = PBR)
    /** ADVERTS (docs/ui/garp.md §Adverts): the city's signage-image catalog. Set only by the city (buildStreets);
     *  absent → every sign stays procedural (colour box + lettering). */
    adverts?: AdvertCatalog | null;
}

/** Metadata out — anchors the city sim / brandable-surface layer / interactions consume. */
export interface BuildingMeta {
    height: number;
    footprint: V2[];
    door: { pos: V2; out: V2; width: number; height: number } | null;   // width/height = the opening (for sliding/swing anim)
    signSlots: { pos: V3; out: V2; width: number; k?: number }[];   // k = the sign colour slot (0..2: signColor / 2 / 3), when known
    roofAnchor: V3;
    windowAnchors: { pos: V3; out: V2; w?: number }[];   // upper-floor window centres + half-width (window boxes / interactions)
    /** The entrance edge (building-local metres): endpoints + outward normal — for street dressing (cafe tables,
     *  A-boards) that must line up with the building's own shopfront instead of re-deriving a frontage. */
    front: { a: V2; b: V2; out: V2 };
    /** Facade points where overhead SERVICE WIRES from the street poles attach (front wall, ~5-6 m up). */
    wireAnchors: V3[];
    /** The building dressed its own shopfront (awning / fascia / shop signs) — city awnings/signage skip it. */
    shopfront: boolean;
}

/** A massing section (setback/podium band): a footprint over a Y range. */
export interface Section { foot: V2[]; y0: number; y1: number; }

/** Accumulator bundle — each becomes one layer + draw call. */
export interface Accums {
    wall: Accum3D; wallBase: Accum3D; glass: Accum3D; trim: Accum3D; roof: Accum3D;
    equip: Accum3D; awn: Accum3D; sign: Accum3D; screen: Accum3D;
    parapet: Accum3D;  // parapets / cornices / terrace lips — own layer so the roofline never LOD-culls (B10)
    party: Accum3D;    // plain party walls (shared with the neighbour — no windows, nothing protruding)
    shop: Accum3D;     // shop-window glazing: windows mode, one cell per bay (lit shop interior)
    shutter: Accum3D;  // roller shutters (corrugated)
    signB: Accum3D; signC: Accum3D;   // other tenants' sign colours
    signText: Accum3D; // light lettering (glyph strokes)
    signTextC: Accum3D; // glowing COLOURED lettering (on black lightboxes — B5)
    signInkC: Accum3D;  // coloured paint lettering (red / navy ink on white lightboxes — B5)
    signFrame: Accum3D; // lightbox casings + bevels + blade brackets (C2)
    shopRoom: Accum3D;  // C4: the recessed shop ROOM (floor / ceiling / side walls) behind an image-interior bay
    shopPane: Accum3D;  // C4: the clear glass pane in front of an image-interior bay
    signInk: Accum3D;  // dark lettering on light boxes / lanterns
    steel: Accum3D;    // painted steel: sign frames, billboard lattice, outside stairs, corridor rails
    lantern: Accum3D;  // izakaya paper lanterns (emissive red)
    panel: Accum3D;    // frosted balcony panels + unit dividers
    duct: Accum3D;     // pipe runs / conduit / kitchen ducts (galvanised)
    cloth: Accum3D;    // laundry
    front: Accum3D;   // shopfront framing (stallriser/transom/mullions) — its own colour
    door: Accum3D;    // door leaf — its own colour
    dframe: Accum3D;  // door jambs + head (surround) — doorFrameColor
    dhandle: Accum3D; // door handle / hardware — doorHandleColor
    green: Accum3D;   // attached greenery (hedges/vines/window-boxes/planters) leaves
    bloom: Accum3D;   // greenery flowers
    // visual-polish #11 tail (clustered roof plant only; empty on classic roofs):
    tank: Accum3D;    // the coloured water tank (ctx.roofTankColor)
    solar: Accum3D;   // photovoltaic panels (dark blue cells)
    pad: Accum3D;     // helipad deck
    mark: Accum3D;    // white paint: helipad H + touchdown ring
}

/** The build context threaded through every part builder. */
export interface BuildCtx {
    p: BuildingParams;
    rnd: () => number;
    foot: V2[];              // ground footprint (corner-styled)
    sections: Section[];     // massing (setbacks/podium); sections[0] = ground
    floors: number;
    levels: number[];        // floor y-levels (length floors+1)
    gH: number; fh: number; topY: number; baseTop: number;
    edges: Edge[];
    front: Edge;
    /** True when the caller passed a frontage mask (city / blocks): party walls + wrap-around shopfronts apply.
     *  False for the standalone Creator, whose every edge is street (legacy behaviour kept). */
    contextual: boolean;
    /** Per-face whole-cell u offsets for the window pattern (per-building band × 128 + face hash) — see L6. */
    uOff: number[];
    A: Accums;
    meta: BuildingMeta;
    instGroups: InstanceGroup[];   // repeated detail (juliet/trim) as canonical geometry + per-window transforms
    /** Advert faces (user images on sign faces) — null when the city passed no catalog (procedural signs). */
    ads: AdvertSink | null;
    /** visual-polish #11 tail: the clustered roof's water-tank colour (one of ROOF_TANK_COLORS), set by the emitter. */
    roofTankColor?: [number, number, number];
}

/** A canonical (local, at-origin) geometry + the transforms that place it — repeated building detail emitted for
 *  instancing. `name` maps to a colour/pattern in assembleLayers; `key` is the shared-geometry instance key. */
export interface InstanceGroup {
    name: string;
    key: string;
    geometry: LayoutPreviewLayer['geometry'];
    instances: InstanceXform[];
}

export const DEFAULT_BUILDING_PARAMS: BuildingParams = {
    category: 'office', archetype: 'office-block', seed: 1,
    floors: 8, width: 16, depth: 13, floorHeight: 3.1, groundFloorHeight: 4.2,
    cornerStyle: 'sharp', cornerAmount: 1.2, setbacks: 0, setbackInset: 1.4, podium: false, podiumFloors: 2,
    windowStyle: 'ribbon', bayWidth: 2.6, material: 'concrete', windowSash: false, glassTransparent: false,
    pilasters: false, quoins: false, quoinStyle: 'alternating', cornice: true, mullions: false,
    storefront: true, shopBays: 0, stallriser: true, transom: true, shutter: false,
    awning: false, awningStyle: 'sloped', awningStripe: false, noren: false, recessedEntry: true,
    rollerDoors: false, canopy: false, lattice: false, doorStyle: 'glazed',
    shopInterior: true, shutterBays: 0, fascia: false, lanterns: false, menuBoard: false,
    balconies: false, julietBalconies: false, windowTrim: false, ledges: true, fireEscape: false, downpipes: false, wallUnits: false,
    windowSills: true, balconyStyle: 'rail', openCorridor: false, outsideStair: false, acUnits: false, utilities: false, laundry: false,
    roofStyle: 'parapet', roofPitch: 0.55, deepEaves: false,
    roofClutter: true, roofPenthouse: true, roofRailing: false, roofGarden: false,
    roofDishes: false, roofVents: true, helipad: false, crown: 'none', roofAerial: false, solarHeater: false,
    signage: false, bladeSign: false, wrapSign: false, rooftopSign: false, ledScreen: false, neon: false, signStack: false, floorSigns: false,
    baseHedge: false, vines: false, windowBoxes: false, basePlanters: false,
    greeneryColor: [0.28, 0.46, 0.2], bloomColor: [0.9, 0.42, 0.5], foliage: [],
    baseColor: [0.72, 0.74, 0.77], trimColor: [0.85, 0.86, 0.88], roofColor: [0.38, 0.39, 0.42],
    glassColor: [0.5, 0.68, 0.8], accentColor: [0.3, 0.42, 0.5], signColor: [0.92, 0.4, 0.32],
    signColor2: [0.2, 0.55, 0.95], signColor3: [0.98, 0.84, 0.24],
    julietColor: [0.13, 0.13, 0.15], julietScroll: 0.6, windowTrimColor: [0.85, 0.86, 0.88],
    storefrontColor: [0.32, 0.34, 0.38], awningColor: [0.72, 0.28, 0.24], doorColor: [0.26, 0.27, 0.31],
    doorFrameColor: [0.85, 0.86, 0.88], doorHandleColor: [0.7, 0.62, 0.32], nightWindows: 0, renderStyle: 'default',
};

/** Archetype library — named preset bundles per category (the "style" the Creator picks). */
export const BUILDING_ARCHETYPES: Record<string, Partial<BuildingParams> & { category: BuildingCategory }> = {
    'suburban-house': {
        category: 'house', floors: 2, width: 9, depth: 10, floorHeight: 3, groundFloorHeight: 3.2,
        windowStyle: 'punched', bayWidth: 3, material: 'plaster', cornerStyle: 'sharp', doorStyle: 'panel',
        storefront: false, ledges: false, cornice: false, roofStyle: 'gable', roofPitch: 0.7, deepEaves: true,
        roofClutter: false, roofPenthouse: false, roofVents: false, recessedEntry: false,
        baseHedge: true, windowBoxes: true, basePlanters: true,
        baseColor: [0.86, 0.82, 0.72], trimColor: [0.96, 0.95, 0.92], roofColor: [0.44, 0.28, 0.24], accentColor: [0.5, 0.42, 0.36],
    },
    'brick-townhouse': {
        category: 'house', floors: 3, width: 7, depth: 11, floorHeight: 3, groundFloorHeight: 3.4,
        windowStyle: 'punched', bayWidth: 2.4, material: 'brick', cornerStyle: 'sharp',
        storefront: false, ledges: true, cornice: true, quoins: true, roofStyle: 'parapet',
        roofClutter: false, roofPenthouse: false, recessedEntry: true, downpipes: true,
        baseColor: [0.66, 0.36, 0.3], trimColor: [0.92, 0.9, 0.86], roofColor: [0.3, 0.3, 0.32], accentColor: [0.5, 0.45, 0.4],
    },
    'retro-shophouse': {
        category: 'shophouse', floors: 3, width: 8, depth: 11, floorHeight: 3, groundFloorHeight: 4,
        windowStyle: 'grid', bayWidth: 2.2, material: 'tile', cornerStyle: 'sharp',
        storefront: true, shopBays: 2, stallriser: true, transom: true, awning: true, awningStyle: 'sloped', awningStripe: true, noren: true, doorStyle: 'glazed',
        signage: true, bladeSign: true, ledges: true, cornice: true, roofStyle: 'parapet', windowSash: true,
        shutterBays: 0.15, acUnits: true, utilities: true, laundry: true,
        roofClutter: true, roofPenthouse: false, roofVents: true,
        baseColor: [0.8, 0.72, 0.6], trimColor: [0.92, 0.88, 0.8], roofColor: [0.36, 0.34, 0.32],
        glassColor: [0.42, 0.55, 0.6], accentColor: [0.86, 0.28, 0.22], signColor: [0.95, 0.85, 0.3],
    },
    'neon-arcade': {
        category: 'shophouse', floors: 4, width: 9, depth: 12, floorHeight: 3, groundFloorHeight: 4.2,
        windowStyle: 'grid', bayWidth: 2, material: 'concrete', cornerStyle: 'chamfer', cornerAmount: 1,
        storefront: true, shopBays: 3, stallriser: true, transom: true, awning: true, shutter: true,
        signage: true, bladeSign: true, wrapSign: true, ledScreen: true, neon: true, ledges: true, signStack: true, floorSigns: true,
        shutterBays: 0.2, acUnits: true, utilities: true,
        roofStyle: 'parapet', roofClutter: true, rooftopSign: true, nightWindows: 0.5,
        baseColor: [0.34, 0.32, 0.4], trimColor: [0.5, 0.48, 0.56], roofColor: [0.22, 0.22, 0.28],
        glassColor: [0.4, 0.6, 0.75], accentColor: [0.9, 0.2, 0.45], signColor: [0.3, 0.9, 0.95],
    },
    'apartment-balcony': {
        category: 'apartment', floors: 6, width: 15, depth: 12, floorHeight: 3, groundFloorHeight: 3.4,
        windowStyle: 'punched', bayWidth: 2.8, material: 'concrete', cornerStyle: 'chamfer', cornerAmount: 0.9,
        storefront: false, balconies: true, ledges: true, cornice: true, fireEscape: true, roofStyle: 'parapet',
        roofClutter: true, roofPenthouse: true, roofGarden: true, roofRailing: true,
        baseHedge: true, vines: true,
        baseColor: [0.78, 0.76, 0.72], trimColor: [0.9, 0.89, 0.86], roofColor: [0.4, 0.4, 0.42],
        glassColor: [0.5, 0.62, 0.7], accentColor: [0.6, 0.55, 0.48],
    },
    'office-block': {
        category: 'office', floors: 9, width: 16, depth: 14, floorHeight: 3.1, groundFloorHeight: 4.4,
        windowStyle: 'ribbon', bayWidth: 2.6, material: 'concrete', cornerStyle: 'sharp', doorStyle: 'auto-slide',
        storefront: true, ledges: true, cornice: true, pilasters: true, roofStyle: 'parapet',
        roofClutter: true, roofPenthouse: true, roofVents: true, roofRailing: true,
        baseColor: [0.72, 0.74, 0.77], trimColor: [0.86, 0.87, 0.89], roofColor: [0.38, 0.39, 0.42],
        glassColor: [0.5, 0.68, 0.8], accentColor: [0.3, 0.42, 0.5],
    },
    'glass-tower': {
        category: 'tower', floors: 26, width: 18, depth: 18, floorHeight: 3.3, groundFloorHeight: 5.5,
        windowStyle: 'curtain', bayWidth: 2.2, material: 'glass', cornerStyle: 'chamfer', cornerAmount: 1.8,
        setbacks: 2, setbackInset: 1.6, podium: true, podiumFloors: 3, mullions: true,
        storefront: true, ledges: false, cornice: false, roofStyle: 'flat', crown: 'mech',
        roofClutter: true, roofPenthouse: true, helipad: true, roofDishes: true, roofRailing: true,
        baseColor: [0.5, 0.62, 0.72], trimColor: [0.72, 0.8, 0.86], roofColor: [0.34, 0.4, 0.46],
        glassColor: [0.46, 0.66, 0.82], accentColor: [0.4, 0.6, 0.72],
    },
    'corporate-spire': {
        category: 'tower', floors: 34, width: 16, depth: 16, floorHeight: 3.4, groundFloorHeight: 6,
        windowStyle: 'curtain', bayWidth: 2, material: 'glass', cornerStyle: 'sharp',
        setbacks: 3, setbackInset: 1.3, podium: true, podiumFloors: 4, mullions: true,
        storefront: true, roofStyle: 'flat', crown: 'spire',
        roofClutter: true, roofPenthouse: true, helipad: true, roofDishes: true,
        baseColor: [0.44, 0.5, 0.58], trimColor: [0.66, 0.72, 0.8], roofColor: [0.3, 0.34, 0.4],
        glassColor: [0.4, 0.56, 0.72], accentColor: [0.5, 0.68, 0.8],
    },
    'machiya': {
        category: 'machiya', floors: 2, width: 7, depth: 13, floorHeight: 2.8, groundFloorHeight: 3,
        windowStyle: 'grid', bayWidth: 1.8, material: 'timber', cornerStyle: 'sharp',
        storefront: true, shopBays: 1, noren: true, lattice: true, awning: true, awningStyle: 'flat',
        signage: true, ledges: false, cornice: false, roofStyle: 'tiled-hip', roofPitch: 0.5, deepEaves: true,
        roofClutter: false, roofPenthouse: false, roofVents: false, recessedEntry: false,
        baseColor: [0.5, 0.42, 0.34], trimColor: [0.34, 0.27, 0.2], roofColor: [0.28, 0.3, 0.32],
        glassColor: [0.5, 0.5, 0.44], accentColor: [0.36, 0.28, 0.22], signColor: [0.85, 0.82, 0.7],
    },
    'warehouse': {
        category: 'warehouse', floors: 1, width: 22, depth: 18, floorHeight: 6, groundFloorHeight: 6,
        windowStyle: 'ribbon', bayWidth: 3.2, material: 'metal', cornerStyle: 'sharp',
        storefront: false, rollerDoors: true, ledges: false, cornice: false, roofStyle: 'sawtooth', roofPitch: 0.4,
        roofClutter: false, roofPenthouse: false, roofVents: true, downpipes: true, wallUnits: false,
        baseColor: [0.62, 0.63, 0.66], trimColor: [0.5, 0.52, 0.55], roofColor: [0.44, 0.46, 0.5],
        glassColor: [0.55, 0.66, 0.72], accentColor: [0.75, 0.6, 0.2],
    },
    // ── JAPANESE street archetypes (city-quality B5) ──────────────────────────────────────────────────────────
    // ZAKKYO pencil building: a narrow multi-tenant tower — a sign per floor, a vertical sign stack, tiled facade,
    // an external steel stair out the back, AC units + pipes on the side/back.
    'zakkyo': {
        category: 'shophouse', floors: 7, width: 6, depth: 14, floorHeight: 3.1, groundFloorHeight: 3.6,
        windowStyle: 'grid', bayWidth: 2.2, material: 'tile', cornerStyle: 'sharp', windowSash: false,
        storefront: true, shopBays: 1, stallriser: false, transom: true, shutter: true, shutterBays: 0.25, doorStyle: 'glazed',
        signage: true, signStack: true, floorSigns: true, neon: true, ledges: false, cornice: false,
        outsideStair: true, acUnits: true, utilities: true, downpipes: true,
        roofStyle: 'parapet', roofClutter: true, roofPenthouse: true, roofVents: true, roofRailing: true, nightWindows: 0.4,
        baseColor: [0.8, 0.76, 0.68], trimColor: [0.62, 0.62, 0.64], roofColor: [0.36, 0.36, 0.38],
        glassColor: [0.4, 0.5, 0.56], accentColor: [0.3, 0.3, 0.34], storefrontColor: [0.28, 0.29, 0.31],
        signColor: [0.95, 0.28, 0.24], signColor2: [0.22, 0.62, 0.98], signColor3: [0.98, 0.84, 0.25],
    },
    // APAATO: a 2-storey timber/steel walk-up — an open corridor along the front with a door per flat, an outside
    // steel stair, lap siding, sash windows, an AC unit per flat and laundry out the back. Sheet-metal gable roof.
    'apato': {
        category: 'apartment', floors: 2, width: 11, depth: 8, floorHeight: 2.8, groundFloorHeight: 2.9,
        windowStyle: 'punched', bayWidth: 2.4, material: 'siding', windowSash: true, cornerStyle: 'sharp', doorStyle: 'flush',
        storefront: false, openCorridor: true, outsideStair: true, acUnits: true, utilities: true, laundry: true,
        ledges: false, cornice: false, recessedEntry: false,
        roofStyle: 'gable', roofPitch: 0.3, deepEaves: false, roofClutter: false, roofPenthouse: false, roofVents: false, roofAerial: true,
        baseColor: [0.84, 0.81, 0.73], trimColor: [0.34, 0.36, 0.38], roofColor: [0.3, 0.36, 0.44],
        glassColor: [0.5, 0.58, 0.6], accentColor: [0.36, 0.38, 0.4], doorColor: [0.62, 0.6, 0.55],
    },
    // MANSION: a concrete / tiled apartment block — continuous balconies with frosted panel fronts + unit
    // dividers, an AC condenser on every balcony, laundry, a glass lobby entrance.
    'mansion': {
        category: 'apartment', floors: 7, width: 16, depth: 12, floorHeight: 2.95, groundFloorHeight: 3.3,
        windowStyle: 'punched', bayWidth: 2.7, material: 'tile', windowSash: true, cornerStyle: 'sharp', doorStyle: 'auto-slide',
        storefront: false, balconies: true, balconyStyle: 'panel', acUnits: true, utilities: true, laundry: true,
        ledges: false, cornice: false, recessedEntry: true,
        roofStyle: 'parapet', roofClutter: true, roofPenthouse: true, roofVents: true, roofRailing: false,
        baseColor: [0.86, 0.84, 0.8], trimColor: [0.9, 0.9, 0.88], roofColor: [0.42, 0.42, 0.44],
        glassColor: [0.55, 0.62, 0.66], accentColor: [0.62, 0.66, 0.7],
    },
    // KONBINI: a single-storey convenience store — full-width lit glazing, the three-stripe fascia band with a
    // katakana logo, an auto-slide door, AC plant on the roof.
    'konbini': {
        category: 'shophouse', floors: 1, width: 12, depth: 14, floorHeight: 3.2, groundFloorHeight: 4.2,
        windowStyle: 'grid', bayWidth: 3, material: 'concrete', cornerStyle: 'sharp', doorStyle: 'auto-slide',
        storefront: true, shopBays: 4, stallriser: true, transom: false, fascia: true, shopInterior: true,
        awning: false, signage: false, ledges: false, cornice: false, utilities: true,
        roofStyle: 'flat', roofClutter: true, roofPenthouse: false, roofVents: true,
        baseColor: [0.92, 0.92, 0.9], trimColor: [0.88, 0.88, 0.86], roofColor: [0.5, 0.5, 0.52],
        glassColor: [0.55, 0.66, 0.72], storefrontColor: [0.84, 0.85, 0.87],
        signColor: [0.12, 0.55, 0.34], signColor2: [0.2, 0.36, 0.78], signColor3: [0.96, 0.52, 0.16],
    },
    // IZAKAYA: a 2-storey timber pub — red paper lanterns, an indigo noren over a wood-lattice sliding door, a
    // menu board, a small tiled eave over the shopfront, a kitchen vent + duct up the side.
    'izakaya': {
        category: 'shophouse', floors: 2, width: 7, depth: 11, floorHeight: 2.8, groundFloorHeight: 3.2,
        windowStyle: 'grid', bayWidth: 1.8, material: 'plaster', windowSash: true, cornerStyle: 'sharp', doorStyle: 'sliding',
        storefront: true, shopBays: 1, stallriser: false, transom: false, noren: true, lanterns: true, menuBoard: true,
        awning: true, awningStyle: 'flat', signage: true, ledges: false, cornice: false, utilities: true, recessedEntry: false,
        roofStyle: 'tiled-hip', roofPitch: 0.45, deepEaves: true, roofClutter: false, roofPenthouse: false, roofVents: false,
        baseColor: [0.62, 0.5, 0.38], trimColor: [0.26, 0.19, 0.14], roofColor: [0.2, 0.21, 0.25],
        glassColor: [0.55, 0.5, 0.4], accentColor: [0.36, 0.26, 0.18], awningColor: [0.22, 0.2, 0.2],
        storefrontColor: [0.3, 0.22, 0.15], doorColor: [0.42, 0.3, 0.2], signColor: [0.92, 0.88, 0.76],
        signColor2: [0.85, 0.2, 0.16], signColor3: [0.95, 0.85, 0.6],
    },
    // JP HOUSE: a detached 2-storey house — ibushi-kawara hip roof, lap siding, sash windows, a TV aerial + solar
    // water heater, an AC unit and laundry out the back.
    'jp-house': {
        category: 'house', floors: 2, width: 8, depth: 9, floorHeight: 2.8, groundFloorHeight: 2.9,
        windowStyle: 'punched', bayWidth: 2.2, material: 'siding', windowSash: true, cornerStyle: 'sharp', doorStyle: 'panel',
        storefront: false, ledges: false, cornice: false, recessedEntry: false, acUnits: true, utilities: true, laundry: true,
        roofStyle: 'hip', roofPitch: 0.5, deepEaves: true, roofClutter: false, roofPenthouse: false, roofVents: false,
        roofAerial: true, solarHeater: true, basePlanters: true,
        baseColor: [0.86, 0.83, 0.76], trimColor: [0.4, 0.34, 0.28], roofColor: [0.25, 0.27, 0.32], accentColor: [0.45, 0.4, 0.34],
    },
    'mall': {
        category: 'mall', floors: 4, width: 30, depth: 24, floorHeight: 4.5, groundFloorHeight: 5.5,
        windowStyle: 'punched', bayWidth: 4, material: 'concrete', cornerStyle: 'round', cornerAmount: 2.2,
        storefront: true, shopBays: 4, canopy: true, doorStyle: 'auto-slide', awning: false, signage: true, ledScreen: true, rooftopSign: true,
        ledges: true, cornice: true, roofStyle: 'flat', roofClutter: true, roofPenthouse: true, roofVents: true,
        baseColor: [0.82, 0.8, 0.78], trimColor: [0.9, 0.89, 0.88], roofColor: [0.4, 0.4, 0.42],
        glassColor: [0.5, 0.66, 0.78], accentColor: [0.88, 0.3, 0.3], signColor: [0.95, 0.5, 0.2],
    },
};

export const DEFAULT_ARCHETYPE = 'office-block';
export function buildingArchetypeNames(): string[] { return Object.keys(BUILDING_ARCHETYPES); }

/** Resolve a partial into full params: DEFAULT ← archetype preset ← explicit overrides. */
export function resolveBuildingParams(partial: Partial<BuildingParams> = {}): BuildingParams {
    const name = partial.archetype && BUILDING_ARCHETYPES[partial.archetype] ? partial.archetype : DEFAULT_ARCHETYPE;
    const base = BUILDING_ARCHETYPES[name];
    return { ...DEFAULT_BUILDING_PARAMS, ...base, archetype: name, ...partial } as BuildingParams;
}

/** Corner-styled footprint from params. */
function styledFoot(p: BuildingParams): V2[] {
    const rect = rectFoot(Math.max(2, p.width), Math.max(2, p.depth));
    if (p.cornerStyle === 'chamfer') return chamferPolygon(rect, Math.max(0, p.cornerAmount));
    if (p.cornerStyle === 'round') return roundPolygon(rect, Math.max(0, p.cornerAmount), 3);
    return rect;
}

/** Uniformly shrink a footprint toward its centroid by ~`amt` world units on the short axis — CANNOT self-intersect
 *  or invert (a proportional scale, so chamfers/rounds scale too), unlike a miter offset on a many-vertex polygon. */
function shrinkFoot(foot: V2[], amt: number): V2[] {
    const c = centroid(foot); const { hw, hd } = bbox(foot); const minH = Math.max(0.5, Math.min(hw, hd));
    const f = Math.max(0.4, (minH - amt) / minH);
    return foot.map(pt => [c[0] + (pt[0] - c[0]) * f, c[1] + (pt[1] - c[1]) * f] as [number, number]);
}

/** Split the massing into sections (podium + setbacks). sections[0] always spans the ground. */
function computeSections(foot: V2[], p: BuildingParams, gH: number, topY: number, levels: number[]): Section[] {
    // Section boundaries SNAP to floor levels: the window rows are one storey per cell (B4), so a setback that
    // started mid-storey would cut a window row in half and restart the row count off the floor grid.
    const snap = (y: number): number => { let best = y, bd = Infinity; for (const l of levels) { const d = Math.abs(l - y); if (d < bd) { bd = d; best = l; } } return best; };
    const secs: Section[] = [];
    let cur = foot, startY = 0;
    const canSetback = p.setbacks > 0 && (p.category === 'tower' || p.category === 'office');
    if (p.podium && canSetback) {
        const podTop = snap(Math.min(topY - p.floorHeight, gH + Math.max(0, p.podiumFloors - 1) * p.floorHeight));
        secs.push({ foot: cur, y0: 0, y1: podTop });
        cur = shrinkFoot(cur, Math.max(0.6, p.setbackInset)); startY = podTop;
    }
    if (canSetback) {
        const bands = p.setbacks + 1;
        const bandH = (topY - startY) / bands;
        let y0 = startY;
        for (let i = 0; i < bands; i++) {
            const y1 = i === bands - 1 ? topY : snap(startY + (i + 1) * bandH);
            if (y1 - y0 > 0.1) secs.push({ foot: cur, y0, y1 });
            if (i < bands - 1 && y1 - y0 > 0.1) { cur = shrinkFoot(cur, Math.max(0.5, p.setbackInset)); y0 = y1; }
        }
    } else {
        secs.push({ foot: cur, y0: 0, y1: topY });
    }
    return secs.filter(s => s.y1 - s.y0 > 0.1);
}

/** Door preference by what an edge faces: a level STREET, then a street down a retaining wall (a raised terrace —
 *  reached by its stairs), then open ground, then a WATER edge (canal / pond: only when nothing else is left),
 *  and a PARTY wall last — a door must never land on the neighbour's wall. */
export const FRONT_RANK: Record<string, number> = { street: 0, drop: 1, open: 2, water: 3, party: 4 };

/** Pick the building's FRONT edge. In the CITY, `frontRef` is the block-interior centroid (in footprint-local
 *  metres): the front is the street edge whose OUTWARD normal points most AWAY from it (i.e. toward the street),
 *  so buildings on OPPOSITE sides of a block face OPPOSITE ways instead of all sharing +Z (the "every door faces
 *  the same way" bug). Mild per-seed jitter breaks ties between edges that face the street about equally. With no
 *  `frontRef` (the standalone Building Creator) it falls back to the old +Z heuristic. Only edges of the BEST kind
 *  present qualify (FRONT_RANK) — so a shop never opens onto the canal railing when it has a street. */
function pickFront(edges: Edge[], foot: V2[], frontRef: V2 | undefined, seed: number): Edge {
    const rank = (e: Edge): number => FRONT_RANK[e.kind] ?? 2;
    const best0 = Math.min(...edges.map(rank));
    const pool = edges.map(e => ({ ...e, street: rank(e) === best0 }));
    if (!frontRef) return edges[frontEdge(pool).i];
    const c = centroid(foot);
    let wx = c[0] - frontRef[0], wz = c[1] - frontRef[1];       // block-interior → this lot = its street direction
    const wl = Math.hypot(wx, wz);
    if (wl < 1e-4) return edges[frontEdge(pool).i];
    wx /= wl; wz /= wl;
    const jr = mulberry((seed ^ 0x2f6a9c1b) >>> 0);            // deterministic per-seed tie-break (own stream — doesn't disturb rnd)
    let best = pool[0], bestScore = -Infinity;
    for (const e of pool) {
        if (!e.street) continue;
        // The LONGEST street edge should win on a corner lot's short side street, so length weighs a little more
        // than the old 0.02 once real frontages exist (a 4 m side vs a 12 m front).
        const score = (e.out[0] * wx + e.out[1] * wz) + e.len * 0.04 + (jr() - 0.5) * 0.05;
        if (score > bestScore) { bestScore = score; best = e; }
    }
    return edges[avoidTinyFront(pool, best).i];   // don't put the door on a rounded-corner chord (curved-facade buildings)
}

/** Deterministic per-face u offsets (whole window cells) for the window pattern: a per-BUILDING band (× 128 cells,
 *  so the shader can recover a building id from floor(cell.x / 128) → per-building lit fraction) plus a per-face
 *  hash (so faces of one building light different windows). Placement is unchanged — offsets are whole cells. */
export function faceUOffsets(seed: number, n: number): number[] {
    const band = ihash(seed, 0x51ab) % 32;
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(band * 128 + (ihash(seed, i * 31 + 5) % 48));
    return out;
}

/**
 * Generate a building. Returns flat-colour LAYERS (→ addFlatColorMeshGroup) + METADATA.
 * `footprint` overrides the rectangular massing (the city passes the lot polygon here).
 * `frontRef` (footprint-local metres) = the block-interior point the entrance should face AWAY from (toward the
 * street); omit it for the standalone Creator (front then falls back to the +Z heuristic).
 * `frontage` (per footprint edge: 'street' | 'open' | 'party', or true/false) = what each edge faces. With it, party
 * walls go plain (no windows / balconies / trim / utilities), AC + pipes + stairs move to open side/back edges, and
 * a shopfront wraps round every street edge (corner lots). Omit it for the standalone Creator (all edges street).
 */
export function buildBuilding(partial: Partial<BuildingParams> = {}, footprint?: V2[], frontRef?: V2, frontage?: FrontageMask,
    opts: { farTwins?: boolean } = {}): { layers: LayoutPreviewLayer[]; meta: BuildingMeta } {
    const p = resolveBuildingParams(partial);
    const rnd = mulberry(p.seed * 2654435761);
    let foot = footprint && footprint.length >= 3 ? footprint : styledFoot(p);
    let mask = frontage && frontage.length === foot.length ? frontage : undefined;
    // edgesOf / walls assume CCW (positive area). A clockwise lot would turn every outward normal inward (doors
    // inside the building) — reverse it, carrying the mask along (edge i = foot[i]→foot[i+1] maps to the reversed
    // edge n-2-i, wrapping).
    if (signedArea(foot) < 0) {
        const n = foot.length;
        foot = [...foot].reverse();
        if (mask) { const m = mask; mask = foot.map((_, i) => m[(2 * n - 2 - i) % n]); }
    }

    const floors = Math.max(1, Math.round(p.floors));
    const gH = p.groundFloorHeight > 0 ? p.groundFloorHeight : p.floorHeight;
    const fh = Math.max(1.5, p.floorHeight);
    const levels: number[] = [0]; { let y = gH; levels.push(y); for (let i = 1; i < floors; i++) { y += fh; levels.push(y); } }
    const topY = levels[floors];
    const baseTop = Math.min(0.5, gH * 0.12);

    const A: Accums = {
        wall: new Accum3D(), wallBase: new Accum3D(), glass: new Accum3D(), trim: new Accum3D(), roof: new Accum3D(),
        // P9 (city build only — opts.farTwins): the roof plant also builds a cheap FAR TWIN (lod-accum.ts).
        equip: opts.farTwins ? new TwinAccum3D(loSpecFor(PROP_TWIN_M.roofEquip, 1)) : new Accum3D(), awn: new Accum3D(), sign: new Accum3D(), screen: new Accum3D(),
        front: new Accum3D(), door: new Accum3D(), dframe: new Accum3D(), dhandle: new Accum3D(), green: new Accum3D(), bloom: new Accum3D(),
        parapet: new Accum3D(), party: new Accum3D(), shop: new Accum3D(), shutter: new Accum3D(),
        signB: new Accum3D(), signC: new Accum3D(), signText: new Accum3D(), signInk: new Accum3D(), signTextC: new Accum3D(), signInkC: new Accum3D(), signFrame: new Accum3D(), shopRoom: new Accum3D(), shopPane: new Accum3D(),
        steel: new Accum3D(), lantern: new Accum3D(), panel: new Accum3D(), duct: new Accum3D(), cloth: new Accum3D(),
        tank: new Accum3D(),   // (no far twin: a box / 8-sided tank has nothing to simplify, a twin only doubled its bytes)
        solar: new Accum3D(), pad: new Accum3D(), mark: new Accum3D(),
    };
    // P20: the detail accumulators record every obox / prism / beam as a prop part while a streamed tile builds (no-op
    // otherwise): railing posts, brackets, frames and plant repeat at fixed sizes, and the tile instances those.
    for (const k of AUTO_PART_ACCUMS) A[k].autoParts = true;
    const edges = edgesOf(foot, mask);
    const front = pickFront(edges, foot, frontRef, p.seed);
    const ctx: BuildCtx = {
        p, rnd, foot, sections: computeSections(foot, p, gH, topY, levels), floors, levels, gH, fh, topY, baseTop,
        edges, front, contextual: !!mask, uOff: faceUOffsets(p.seed, foot.length), A,
        meta: {
            height: topY, footprint: foot, door: null, signSlots: [], roofAnchor: [0, topY, 0], windowAnchors: [],
            front: { a: [front.a[0], front.a[1]], b: [front.b[0], front.b[1]], out: [front.out[0], front.out[1]] },
            wireAnchors: [], shopfront: false,
        },
        instGroups: [],
        ads: p.adverts && p.adverts.entries.length ? new AdvertSink(p.adverts, p.seed) : null,
    };
    ctx.meta.door = { pos: [front.mid[0] + front.out[0] * 0.3, front.mid[1] + front.out[1] * 0.3], out: front.out, width: 1.2, height: 2.2 };

    // ── compose the facade (each part gated by params) ──
    emitMassing(ctx);
    emitFacadeDetail(ctx);
    if (p.balconies) emitBalconies(ctx);
    if (p.windowTrim) emitWindowTrim(ctx);
    else if (p.windowSills) emitWindowSills(ctx);   // D2: a slim sill per window (the trim surround has its own)
    if (p.julietBalconies) emitJulietBalconies(ctx);
    if (p.storefront || p.rollerDoors || p.canopy) emitStorefront(ctx);
    emitTraditional(ctx);       // machiya lattice / warehouse roller-doors / mall — category-gated internally
    emitJapanese(ctx);          // apaato corridor + stair · zakkyo back stair · izakaya lanterns / menu board
    emitRoof(ctx);
    emitRoofDetail(ctx);
    emitSignage(ctx);
    emitUtilities(ctx);         // AC + pipe runs, meters, conduit, kitchen vents, laundry (B8)
    emitGreenery(ctx);   // attached foliage — auto-placed from meta (foliage item 2)

    const layers = assembleLayers(ctx);
    // Manually-placed foliage (Building Editor grid tool) — render each instance and merge it into the building at
    // its local (x,z)+rot, so it travels + persists with the building (params-only). Capped to bound draw calls.
    if (p.foliage && p.foliage.length) {
        for (const pl of p.foliage.slice(0, 48)) {
            const { layers: fl } = buildFoliage(pl);
            const rot = pl.rot ?? 0;
            for (const L of fl) layers.push({ ...L, name: 'bldg:pfoliage-' + L.name.replace('foliage:', ''), geometry: xformGeo(L.geometry, pl.x, 0, pl.z, rot) });
        }
    }
    return { layers, meta: ctx.meta };
}

/** visual-polish #6: the pattern scale that switches mode 'waves' to the shader's AD SCREEN loop (adScreen). */
export const AD_SCREEN_SCALE = 2;
/** Re-map an LED screen's box UVs (world units, 0..extent per face) to the ad loop's per-face layout: u = `id` +
 *  0..0.999 across, v = 0..1 up — so the designed layout fits each face whatever its size, and `id` (a small per-building
 *  integer) picks that screen's ads. Every 4 consecutive vertices are one box face (Accum3D.obox). Returns a copy. */
export function adScreenUVs(geo: LayoutPreviewLayer['geometry'], id: number): LayoutPreviewLayer['geometry'] {
    const v = new Float32Array(geo.vertices), S = 12, n = v.length / S;
    for (let q = 0; q + 3 < n; q += 4) {
        let mu = 0, mv = 0;
        for (let k = q; k < q + 4; k++) { mu = Math.max(mu, v[k * S + 6]); mv = Math.max(mv, v[k * S + 7]); }
        for (let k = q; k < q + 4; k++) {
            v[k * S + 6] = id + (mu > 0 ? v[k * S + 6] / mu : 0) * 0.999;
            v[k * S + 7] = mv > 0 ? v[k * S + 7] / mv : 0;
        }
    }
    return { ...geo, vertices: v };
}

/** Translate (+dx,dy,dz) and rotate (rotY, radians) a 12-float geometry — for placing a foliage instance on a
 *  building. Rotates position, normal, and tangent XZ; leaves UVs. Returns a new geometry (indices shared, read-only). */
export function xformGeo(geo: LayoutPreviewLayer['geometry'], dx: number, dy: number, dz: number, rotY: number): LayoutPreviewLayer['geometry'] {
    const v = new Float32Array(geo.vertices); const c = Math.cos(rotY), s = Math.sin(rotY);
    for (let i = 0; i < v.length; i += 12) {
        const px = v[i], pz = v[i + 2]; v[i] = px * c + pz * s + dx; v[i + 1] = v[i + 1] + dy; v[i + 2] = -px * s + pz * c + dz;
        const nx = v[i + 3], nz = v[i + 5]; v[i + 3] = nx * c + nz * s; v[i + 5] = -nx * s + nz * c;
        const tx = v[i + 8], tz = v[i + 10]; v[i + 8] = tx * c + tz * s; v[i + 10] = -tx * s + tz * c;
    }
    return { vertices: v, indices: geo.indices, format: geo.format };
}

/** Concatenate several 12-float geometries into one (offsetting indices). Used to BAKE instanced groups into a
 *  single merged mesh (Tier-0 fallback) — behaviour-identical to the old world-baked path. */
export function mergeGeos(geos: LayoutPreviewLayer['geometry'][]): LayoutPreviewLayer['geometry'] {
    let nv = 0, ni = 0;
    for (const g of geos) { nv += g.vertices.length; ni += g.indices.length; }
    const vertices = new Float32Array(nv), indices = new Uint32Array(ni);
    let vo = 0, io = 0, base = 0;
    for (const g of geos) {
        vertices.set(g.vertices, vo);
        for (let i = 0; i < g.indices.length; i++) indices[io + i] = g.indices[i] + base;
        base += g.vertices.length / 12; vo += g.vertices.length; io += g.indices.length;
    }
    const out: LayoutPreviewLayer['geometry'] = { vertices, indices, format: '12float' };
    mergePartsInto(geos, out);   // P20: prop parts survive the merge (offsets shifted)
    return out;
}

/** Instancing tier for repeated detail (juliet/trim). FALSE = Tier-0: bake each instance into a merged mesh
 *  (behaviour-identical to pre-instancing). TRUE = emit instanced layers (canonical geometry + transforms) for the
 *  shared-key renderer path (P1). P0 keeps this false so output is unchanged while the decomposition is validated. */
const EMIT_INSTANCED = true;

/** P20: the detail accumulators whose obox / prism / beam calls are recorded as prop parts in a streamed tile build —
 *  the two whose primitives repeat at fixed sizes (roof railing posts / tank legs / plant; frosted panels). Measured on
 *  seed 3: steel / duct / door / doorframe / storefront / trim / parapet / lightbox frames are sized per facade, so
 *  recording them only cost worker time (~0.4 s a tile) for no instanced copy. */
const AUTO_PART_ACCUMS: readonly (keyof Accums)[] = ['equip', 'panel', 'tank', 'solar'];   // (tank / solar: the clustered roof plant, fixed sizes)

// ── layer assembly: turn accumulators into coloured/patterned LayoutPreviewLayers ──
function wallPattern(p: BuildingParams): NonNullable<LayoutPreviewLayer['pattern']> {
    // Material overrides the window rhythm for the two non-glazed specials:
    if (p.material === 'timber') return { color: [0.2, 0.15, 0.1], freq: 1 / Math.max(0.7, p.bayWidth * 0.5), scale: 0.6, mode: 'grid', spacing: 0.55, angle: 0 };   // lattice/timber framing
    if (p.material === 'metal') return { color: [0.4, 0.42, 0.45], freq: 6, scale: 0.5, mode: 'stripes', angle: 1.57, spacing: 0.5 };   // corrugated sheet
    const bay = Math.max(1, p.bayWidth);
    const cfg = p.windowStyle === 'punched' ? { f: 1 / (bay * 1.15), s: 0.22 }
        : p.windowStyle === 'ribbon' ? { f: 1 / (bay * 0.9), s: 0.44 }
            : { f: 1 / bay, s: 0.3 };   // grid
    // facade code (the windows shader's wallStyle slot): ribbon 3 · brick 0 · concrete 1 · TILE 4 · lap SIDING 5 ·
    // PLASTER 7, + 10 for Japanese sliding-sash windows. Curtain is glass-layer only (2); shop windows are 6.
    return { color: LIT, freq: cfg.f, scale: cfg.s, mode: 'windows', angle: facadeCode(p), spacing: Math.max(0, Math.min(1, p.nightWindows)) };
}

// Solid surfaces get only a SMALL unlit lift (not the city's flat-map 0.45×) so a picked colour reads TRUE on the
// building instead of glowing 45% brighter — while shadows still don't crush to black. Signage/screens stay bright.
const SOLID_E = 0.14;

function assembleLayers(ctx: BuildCtx): LayoutPreviewLayer[] {
    const { p, A } = ctx;
    const out: LayoutPreviewLayer[] = [];
    const curtain = p.windowStyle === 'curtain';
    if (!A.wall.empty) out.push({ name: 'bldg:wall', color: p.baseColor, y: 0, geometry: A.wall.geometry(), emissive: SOLID_E, pattern: wallPattern(p) });
    if (!A.wallBase.empty) out.push({ name: 'bldg:wallbase', color: p.baseColor, y: 0, geometry: A.wallBase.geometry(), emissive: SOLID_E });   // plain ground floor behind the storefront (no window peek-through)
    if (!A.glass.empty) {
        const gp: LayoutPreviewLayer['pattern'] = curtain
            ? { color: [0.92, 0.96, 1.0], freq: 1 / (Math.max(1, p.bayWidth) * 0.8), scale: 0.05, mode: 'windows', angle: 2, spacing: Math.max(0, Math.min(1, p.nightWindows * 0.7)) }   // facade type 2 = curtain wall (mullion grid + glass panels)
            : undefined;
        // Glass is OPAQUE by default (the "interior" is faked by the windows pattern's parallax interior-mapping +
        // reflection — no see-through to the hollow geometry). `glassTransparent` = the see-through "aquarium" look
        // (you see through to the interior), for when that's the desired vibe.
        const op = p.glassTransparent ? 0.6 : (curtain ? 1.0 : 0.9);
        out.push({ name: 'bldg:glass', color: p.glassColor, y: 0, geometry: A.glass.geometry(), pattern: gp, emissive: curtain ? 0.2 : 0.12, opacity: op, glass: true });
    }
    // procedural STONE for trim (cornices/sills/window surrounds): faint ashlar joints + the hash grain (mode grid
    // triggers the shader's value-grain + normal relief) → cut stone instead of flat plastic.
    // B4: plain ashlar joints (spacing 0 — the shingle variant's per-block hash + mottle read as brick noise on every
    // ledge / cornice / parapet), larger blocks and a softer joint colour.
    const stoneFor = (c: [number, number, number]): LayoutPreviewLayer['pattern'] => ({ color: [c[0] * 0.9, c[1] * 0.9, c[2] * 0.91], freq: 1.0, scale: 0.05, mode: 'grid', spacing: 0 });
    if (!A.trim.empty) out.push({ name: 'bldg:trim', color: p.trimColor, y: 0, geometry: A.trim.geometry(), emissive: SOLID_E, pattern: stoneFor(p.trimColor) });
    // Repeated detail (juliet / window trim) — emitted as canonical geometry + per-window transforms (see emit*).
    // Colour/pattern assigned here by name (the emitters stay geometry-only). Tier-0 bakes; Tier-1 instances.
    const instMeta: Record<string, { color: [number, number, number]; pattern?: LayoutPreviewLayer['pattern'] }> = {
        'bldg:juliet': { color: p.julietColor },
        // NO stone pattern on window trims: the ashlar-joint grain reads fine on big cornices but as a harsh
        // checker/chain on thin window surrounds (the "strange trims" report) — plain stone colour there.
        'bldg:windowtrim': { color: p.windowTrimColor },
        // D2 window sills: one of a few FIXED tones (aluminium flashing on sash facades, pale / dark stone on masonry)
        // so the city's instance groups stay few. 'trim-sill' → city layer world:detail-trim-sill (the DETAIL tier).
        'bldg:trim-sill': { color: sillColor(p) },
        'bldg:greenery': { color: p.greeneryColor },   // hedge/box/planter/vine leaf clumps — instanced (was the city's biggest baked layer)
    };
    const byName = new Map<string, InstanceGroup[]>();
    for (const g of ctx.instGroups) { if (g.instances.length) (byName.get(g.name) ?? byName.set(g.name, []).get(g.name)!).push(g); }
    for (const [name, groups] of byName) {
        const meta = instMeta[name] ?? { color: [0.8, 0.8, 0.8] as [number, number, number] };
        if (EMIT_INSTANCED) {
            // one instanced layer per width bucket (each bucket = one shared geometry + its transforms)
            for (const g of groups) out.push({ name, color: meta.color, y: 0, geometry: g.geometry, instances: g.instances, instanceKey: g.key, emissive: SOLID_E, pattern: meta.pattern });
        } else {
            // Tier-0 fallback: bake every instance (across all buckets) into ONE merged layer (== old behaviour).
            const geos: LayoutPreviewLayer['geometry'][] = [];
            for (const g of groups) for (const t of g.instances) geos.push(xformGeo(g.geometry, t.x, t.y, t.z, t.ry));
            out.push({ name, color: meta.color, y: 0, geometry: mergeGeos(geos), emissive: SOLID_E, pattern: meta.pattern });
        }
    }
    if (!A.roof.empty) {
        const tiled = p.roofStyle === 'tiled-hip' || p.roofStyle === 'hip' || p.roofStyle === 'gable' || p.roofStyle === 'mansard';
        const seam: [number, number, number] = [p.roofColor[0] * 0.7, p.roofColor[1] * 0.7, p.roofColor[2] * 0.7];
        // flat roofs get a subtle concrete-panel grain (same grid mode, wider cells) so the parapet/deck isn't flat plastic.
        // B4: ~1.7 m deck slabs with plain joints (the shingle variant + 0.9 m cells read as graph paper from the air).
        const flatRoof: LayoutPreviewLayer['pattern'] = { color: [p.roofColor[0] * 0.9, p.roofColor[1] * 0.9, p.roofColor[2] * 0.91], freq: 0.6, scale: 0.04, mode: 'grid', spacing: 0 };
        // KAWARA (Japanese clay tile) on hip / tiled-hip / sash-windowed houses: ~0.3 m courses (freq 3.3 per metre —
        // roof UVs are metres) with the shingle stagger — the old freq 8 read as fine grit, not tiles. A sheet-metal
        // gable (apaato) gets standing-seam stripes instead.
        const sheet = p.roofStyle === 'gable' && p.category === 'apartment';
        const kawara = p.roofStyle === 'tiled-hip' || p.roofStyle === 'hip' || (p.windowSash && tiled);
        const roofPat: LayoutPreviewLayer['pattern'] = sheet ? { color: seam, freq: 2.4, scale: 0.18, mode: 'stripes', angle: 0, spacing: 0.5 }
            : tiled ? { color: seam, freq: kawara ? 3.3 : 8, scale: 0.3, mode: 'grid', spacing: 1 } : flatRoof;
        out.push({ name: 'bldg:roof', color: p.roofColor, y: 0, geometry: A.roof.geometry(), emissive: SOLID_E * 0.8, pattern: roofPat });
    }
    // roof clutter (tanks / AC units / vents / pipes): subtle metal-panel grain so it isn't flat plastic either.
    if (!A.equip.empty) {
        const eq: LayoutPreviewLayer = { name: 'bldg:roof-equip', color: [0.5, 0.5, 0.52], y: 0, geometry: A.equip.geometry(), emissive: SOLID_E * 0.8, pattern: { color: [0.42, 0.42, 0.46], freq: 1.4, scale: 0.05, mode: 'grid', spacing: 1 } };
        // P9: near/far twin pair in METRES (the city merge rescales `dist` with the geometry).
        const lo = loGeometry(A.equip), d = PROP_TWIN_M.roofEquip;
        const tw = { key: 'roof-equip', dist: d, gridTris: Math.floor(eq.geometry.indices.length / 3), uvFromNear: true };
        if (lo) out.push({ ...eq, nearTwin: { ...tw, role: 'near' } }, { ...eq, geometry: lo, nearTwin: { ...tw, role: 'far' } });
        else out.push(eq);
    }
    // visual-polish #11 tail — the CLUSTERED roof plant's coloured pieces. Names under 'roof-equip-' so every roof-object
    // rule (LOD tier, twin tier, fog class, baked drape) holds; each carries a PATTERN so the city's material classifier
    // keeps its colour (a patternless /equip/ layer becomes galvanised grey).
    if (!A.tank.empty) {
        const tc = ctx.roofTankColor ?? [0.30, 0.50, 0.70];
        out.push({ name: 'bldg:roof-equip-tank', color: tc, y: 0, geometry: A.tank.geometry(), emissive: SOLID_E, pattern: { color: [tc[0] * 0.8, tc[1] * 0.8, tc[2] * 0.82], freq: 1, scale: 0.08, mode: 'grid', spacing: 0 } });   // FRP panel seams (~1 m)
    }
    if (!A.solar.empty) out.push({ name: 'bldg:roof-equip-solar', color: [0.10, 0.15, 0.30], y: 0, geometry: A.solar.geometry(), emissive: SOLID_E * 0.6, pattern: { color: [0.42, 0.48, 0.58], freq: 3, scale: 0.12, mode: 'grid', spacing: 0 } });   // PV cells
    if (!A.pad.empty) out.push({ name: 'bldg:roof-equip-pad', color: [0.27, 0.31, 0.30], y: 0, geometry: A.pad.geometry(), emissive: SOLID_E, pattern: { color: [0.24, 0.28, 0.27], freq: 0.5, scale: 0.03, mode: 'grid', spacing: 0 } });
    if (!A.mark.empty) out.push({ name: 'bldg:roof-equip-mark', color: [0.93, 0.93, 0.89], y: 0, geometry: A.mark.geometry(), emissive: SOLID_E * 1.5, pattern: { color: [0.93, 0.93, 0.89], freq: 1, scale: 0, mode: 'grid', spacing: 0 } });
    if (!A.front.empty) out.push({ name: 'bldg:storefront', color: p.storefrontColor, y: 0, geometry: A.front.geometry(), emissive: SOLID_E });
    if (!A.door.empty) out.push({ name: 'bldg:door', color: p.doorColor, y: 0, geometry: A.door.geometry(), emissive: SOLID_E });
    if (!A.dframe.empty) out.push({ name: 'bldg:doorframe', color: p.doorFrameColor, y: 0, geometry: A.dframe.geometry(), emissive: SOLID_E });
    if (!A.dhandle.empty) out.push({ name: 'bldg:doorhandle', color: p.doorHandleColor, y: 0, geometry: A.dhandle.geometry(), emissive: SOLID_E });
    if (!A.awn.empty) {
        const stripe: LayoutPreviewLayer['pattern'] = p.awningStripe ? { color: [0.96, 0.95, 0.92], freq: 2.2, scale: 0.5, mode: 'stripes', angle: 0, spacing: 0.5 } : undefined;   // classic striped awning
        out.push({ name: 'bldg:awning', color: p.awningColor, y: 0, geometry: A.awn.geometry(), emissive: SOLID_E * 1.3, pattern: stripe });
    }
    if (!A.green.empty) out.push({ name: 'bldg:greenery', color: p.greeneryColor, y: 0, geometry: A.green.geometry(), emissive: SOLID_E });
    if (!A.bloom.empty) out.push({ name: 'bldg:bloom', color: p.bloomColor, y: 0, geometry: A.bloom.geometry(), emissive: 0.28 });
    // B5: WHITE / cream lightboxes glow a little less (a 0.93 white × the full sign emission blew out to a flat
    // bloom blob at night that ate its dark lettering); black boxes stay dark whatever the emission.
    const boxE = (c: [number, number, number]): number => (p.neon ? 1.6 : 1.2) * (signLum(c) > 0.6 ? 0.72 : 1);
    if (!A.sign.empty) out.push({ name: 'bldg:sign', color: p.signColor, y: 0, geometry: A.sign.geometry(), emissive: boxE(p.signColor) });
    // visual-polish #6: a designed AD LOOP (the shader's adScreen: pattern 'waves' with scale > 1.5) on per-face
    // normalised UVs, instead of the freq-9 waves that aliased into TV static at every distance.
    if (!A.screen.empty) {
        if (p.adScreen === false) out.push({ name: 'bldg:screen', color: [0.95, 0.97, 1.0], y: 0, geometry: A.screen.geometry(), emissive: 1.4, pattern: { color: p.signColor, freq: 9, angle: 0.6, scale: 0.5, mode: 'waves', spacing: 0.7 } });   // legacy (old saves)
        else out.push({ name: 'bldg:screen', color: [0.95, 0.97, 1.0], y: 0, geometry: adScreenUVs(A.screen.geometry(), ihash(p.seed, 0x5c4ee) % 61), emissive: 1.4, pattern: { color: p.signColor, freq: 1, angle: 0, scale: AD_SCREEN_SCALE, mode: 'waves', spacing: 0 } });
    }
    // ── city-quality layers ──
    // Parapet / cornice / terrace lips: the SAME stone look as trim, but their own layer so the roofline is never
    // LOD-culled with the fine trim (B10) → city layer 'world:detail-parapet'.
    if (!A.parapet.empty) out.push({ name: 'bldg:parapet', color: p.trimColor, y: 0, geometry: A.parapet.geometry(), emissive: SOLID_E, pattern: stoneFor(p.trimColor) });
    // Party walls: plain wall colour with faint concrete panel seams (no windows — they abut the neighbour).
    if (!A.party.empty) {
        const pc: [number, number, number] = [p.baseColor[0] * 0.92, p.baseColor[1] * 0.92, p.baseColor[2] * 0.92];
        out.push({ name: 'bldg:partywall', color: pc, y: 0, geometry: A.party.geometry(), emissive: SOLID_E, pattern: { color: [pc[0] * 0.9, pc[1] * 0.9, pc[2] * 0.9], freq: 0.55, scale: 0.02, mode: 'grid', spacing: 0 } });
    }
    // Shop windows (B6): windows mode, ONE CELL PER BAY (bay UVs are 0..1, freq 1), facade code 6 = the shop
    // interior (fluorescent ceiling, shelf rows, posters on the glass) — most bays light up at dusk.
    if (!A.shop.empty) {
        const sp: LayoutPreviewLayer['pattern'] = p.shopInterior
            ? { color: [0.94, 0.97, 1.0], freq: 1, scale: 0.03, mode: 'windows', angle: 6, spacing: Math.max(0, Math.min(1, p.nightWindows)) }
            : undefined;
        out.push({ name: 'bldg:shop-glass', color: p.glassColor, y: 0, geometry: A.shop.geometry(), pattern: sp, emissive: 0.12, opacity: p.shopInterior ? 1 : 0.9, glass: true });
    }
    // SHOP WINDOWS (C4, docs/ui/garp.md §Shop windows): a bay showing a user's interior image is a real recessed room
    // (pale lit walls — glow row /shop-room/) behind a CLEAR pane; the image itself is an advert layer (sign-advert-*).
    if (!A.shopRoom.empty) out.push({ name: 'bldg:shop-room', color: [0.86, 0.86, 0.83], y: 0, geometry: A.shopRoom.geometry(), emissive: 0.5 });
    if (!A.shopPane.empty) out.push({ name: 'bldg:shop-glass-pane', color: p.glassColor, y: 0, geometry: A.shopPane.geometry(), emissive: 0.05, opacity: 0.22, glass: true });
    if (!A.shutter.empty) out.push({ name: 'bldg:shutter', color: [0.66, 0.67, 0.68], y: 0, geometry: A.shutter.geometry(), emissive: SOLID_E, pattern: { color: [0.46, 0.47, 0.49], freq: 9, scale: 0.35, mode: 'stripes', angle: 1.57, spacing: 0.5 } });
    if (!A.signB.empty) out.push({ name: 'bldg:sign-b', color: p.signColor2, y: 0, geometry: A.signB.geometry(), emissive: boxE(p.signColor2) });
    if (!A.signC.empty) out.push({ name: 'bldg:sign-c', color: p.signColor3, y: 0, geometry: A.signC.geometry(), emissive: boxE(p.signColor3) });
    if (!A.signText.empty) out.push({ name: 'bldg:sign-text', color: [0.98, 0.96, 0.9], y: 0, geometry: A.signText.geometry(), emissive: 1.5 });
    if (!A.signInk.empty) out.push({ name: 'bldg:sign-ink', color: [0.12, 0.1, 0.1], y: 0, geometry: A.signInk.geometry(), emissive: 0.05 });
    // B5 lettering variants + C2 lightbox casings (sign-text-c / sign-ink-c ride the sign-text / sign-ink glow + LOD rules).
    if (!A.signTextC.empty) out.push({ name: 'bldg:sign-text-c', color: signGlowTextColor([p.signColor, p.signColor2, p.signColor3]), y: 0, geometry: A.signTextC.geometry(), emissive: 1.5 });
    if (!A.signInkC.empty) out.push({ name: 'bldg:sign-ink-c', color: signInkColor(p.seed), y: 0, geometry: A.signInkC.geometry(), emissive: 0.05 });
    if (!A.signFrame.empty) out.push({ name: 'bldg:lightbox-frame', color: signFrameColor(p.seed), y: 0, geometry: A.signFrame.geometry(), emissive: SOLID_E });
    // ADVERTS: the user's images on sign faces, one layer per (page, lit) — lit ones glow like the signs they sit on.
    if (ctx.ads && !ctx.ads.empty) out.push(...ctx.ads.layers('bldg:', 0, 0.9, SOLID_E));
    if (!A.lantern.empty) out.push({ name: 'bldg:sign-lantern', color: [0.9, 0.16, 0.12], y: 0, geometry: A.lantern.geometry(), emissive: 1.5 });
    // Painted steel (sign frames, billboard lattice, outside stairs, corridor rails) — 'railing' → the city's
    // painted-metal classifier.
    if (!A.steel.empty) out.push({ name: 'bldg:railing-steel', color: p.trimColor, y: 0, geometry: A.steel.geometry(), emissive: SOLID_E });
    if (!A.panel.empty) {
        const fr: [number, number, number] = [0.5 + p.glassColor[0] * 0.4, 0.5 + p.glassColor[1] * 0.4, 0.5 + p.glassColor[2] * 0.4];   // frosted balcony glass
        out.push({ name: 'bldg:frosted-panel', color: fr, y: 0, geometry: A.panel.geometry(), emissive: SOLID_E });
    }
    if (!A.duct.empty) out.push({ name: 'bldg:duct', color: [0.62, 0.63, 0.64], y: 0, geometry: A.duct.geometry(), emissive: SOLID_E });
    if (!A.cloth.empty) out.push({ name: 'bldg:laundry', color: [0.92, 0.91, 0.87], y: 0, geometry: A.cloth.geometry(), emissive: SOLID_E });
    // whole-building shading style (PBR default / cel / cel-hd / sketch / ink / gouraud) — applied to every layer
    if (p.renderStyle !== 'default') for (const L of out) L.renderStyle = p.renderStyle;
    return out;
}
