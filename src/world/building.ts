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
// screens) · 7 traditional (machiya/warehouse/mall). City wiring (per-lot category +
// frontage/party-wall context) is a later pass — the contract already accepts `footprint`
// + per-edge `frontage`.
// ─────────────────────────────────────────────────────────────────────────────

import { Accum3D } from './meshbuild';
import { chamferPolygon, roundPolygon } from './util';
import type { V2, LayoutPreviewLayer, InstanceXform } from './types';
import { LIT, rectFoot, edgesOf, frontEdge, mulberry, centroid, bbox } from './building-geom';
import type { Edge } from './building-geom';
import {
    emitMassing, emitFacadeDetail, emitStorefront, emitBalconies, emitJulietBalconies, emitWindowTrim,
    emitRoof, emitRoofDetail, emitSignage, emitTraditional, emitGreenery,
} from './building-parts';
import { buildFoliage } from './foliage';
import type { FoliageParams } from './foliage';

type V3 = [number, number, number];

/** A manually-placed foliage instance on a building (position in building-local metres) — stored in building params so
 *  it travels + persists with the building. `rot` = Y rotation (rad). Foliage params default if omitted. */
export type FoliagePlacement = Partial<FoliageParams> & { x: number; z: number; rot?: number };

export type BuildingCategory = 'house' | 'shophouse' | 'apartment' | 'office' | 'tower' | 'machiya' | 'warehouse' | 'mall';
export type WindowStyle = 'grid' | 'punched' | 'ribbon' | 'curtain';
export type BuildingCorner = 'sharp' | 'chamfer' | 'round';
export type BuildingMaterial = 'concrete' | 'brick' | 'plaster' | 'tile' | 'glass' | 'timber' | 'metal';
export type RoofStyle = 'flat' | 'parapet' | 'hip' | 'gable' | 'mansard' | 'sawtooth' | 'tiled-hip';
export type CrownStyle = 'none' | 'spire' | 'mech' | 'blade';
export type AwningStyle = 'flat' | 'sloped' | 'dome';
export type DoorStyle = 'flush' | 'panel' | 'glazed' | 'double' | 'auto-slide';

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
    glassTransparent: boolean;   // see-through "aquarium" glass (shows the interior) vs opaque glazed skin
    pilasters: boolean;          // vertical trim strips between bays
    quoins: boolean;             // corner stone blocks
    cornice: boolean;            // pronounced crown moulding
    mullions: boolean;           // real curtain-wall fins (glass towers)
    // ── ground / storefront ──
    storefront: boolean; shopBays: number; stallriser: boolean; transom: boolean;
    shutter: boolean; awning: boolean; awningStyle: AwningStyle; awningStripe: boolean; noren: boolean; recessedEntry: boolean;
    rollerDoors: boolean;        // warehouse/industrial
    canopy: boolean;             // mall/entrance canopy
    lattice: boolean;            // machiya ground lattice (koshi)
    doorStyle: DoorStyle;        // flush / panel / glazed / double
    // ── features ──
    balconies: boolean; julietBalconies: boolean; windowTrim: boolean; ledges: boolean; fireEscape: boolean; downpipes: boolean; wallUnits: boolean;
    // ── roof ──
    roofStyle: RoofStyle; roofPitch: number; deepEaves: boolean;
    roofClutter: boolean; roofPenthouse: boolean; roofRailing: boolean; roofGarden: boolean;
    roofDishes: boolean; roofVents: boolean; helipad: boolean; crown: CrownStyle;
    // ── signage ──
    signage: boolean; bladeSign: boolean; wrapSign: boolean; rooftopSign: boolean; ledScreen: boolean; neon: boolean;
    // ── greenery (attached foliage, auto-placed from meta — foliage generator item 2) ──
    baseHedge: boolean; vines: boolean; windowBoxes: boolean; basePlanters: boolean;
    greeneryColor: [number, number, number]; bloomColor: [number, number, number];
    foliage: FoliagePlacement[];   // manually-placed attached foliage (Building Editor grid tool)
    // ── colour ──
    baseColor: [number, number, number]; trimColor: [number, number, number]; roofColor: [number, number, number];
    glassColor: [number, number, number]; accentColor: [number, number, number]; signColor: [number, number, number];
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
}

/** Metadata out — anchors the city sim / brandable-surface layer / interactions consume. */
export interface BuildingMeta {
    height: number;
    footprint: V2[];
    door: { pos: V2; out: V2; width: number; height: number } | null;   // width/height = the opening (for sliding/swing anim)
    signSlots: { pos: V3; out: V2; width: number }[];
    roofAnchor: V3;
    windowAnchors: { pos: V3; out: V2; w?: number }[];   // upper-floor window centres + half-width (window boxes / interactions)
}

/** A massing section (setback/podium band): a footprint over a Y range. */
export interface Section { foot: V2[]; y0: number; y1: number; }

/** Accumulator bundle — each becomes one layer + draw call. */
export interface Accums {
    wall: Accum3D; wallBase: Accum3D; glass: Accum3D; trim: Accum3D; roof: Accum3D;
    equip: Accum3D; awn: Accum3D; sign: Accum3D; screen: Accum3D;
    front: Accum3D;   // shopfront framing (stallriser/transom/mullions) — its own colour
    door: Accum3D;    // door leaf — its own colour
    dframe: Accum3D;  // door jambs + head (surround) — doorFrameColor
    dhandle: Accum3D; // door handle / hardware — doorHandleColor
    green: Accum3D;   // attached greenery (hedges/vines/window-boxes/planters) leaves
    bloom: Accum3D;   // greenery flowers
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
    A: Accums;
    meta: BuildingMeta;
    instGroups: InstanceGroup[];   // repeated detail (juliet/trim) as canonical geometry + per-window transforms
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
    windowStyle: 'ribbon', bayWidth: 2.6, material: 'concrete', glassTransparent: false,
    pilasters: false, quoins: false, cornice: true, mullions: false,
    storefront: true, shopBays: 0, stallriser: true, transom: true, shutter: false,
    awning: false, awningStyle: 'sloped', awningStripe: false, noren: false, recessedEntry: true,
    rollerDoors: false, canopy: false, lattice: false, doorStyle: 'glazed',
    balconies: false, julietBalconies: false, windowTrim: false, ledges: true, fireEscape: false, downpipes: false, wallUnits: false,
    roofStyle: 'parapet', roofPitch: 0.55, deepEaves: false,
    roofClutter: true, roofPenthouse: true, roofRailing: false, roofGarden: false,
    roofDishes: false, roofVents: true, helipad: false, crown: 'none',
    signage: false, bladeSign: false, wrapSign: false, rooftopSign: false, ledScreen: false, neon: false,
    baseHedge: false, vines: false, windowBoxes: false, basePlanters: false,
    greeneryColor: [0.28, 0.46, 0.2], bloomColor: [0.9, 0.42, 0.5], foliage: [],
    baseColor: [0.72, 0.74, 0.77], trimColor: [0.85, 0.86, 0.88], roofColor: [0.38, 0.39, 0.42],
    glassColor: [0.5, 0.68, 0.8], accentColor: [0.3, 0.42, 0.5], signColor: [0.92, 0.4, 0.32],
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
        signage: true, bladeSign: true, ledges: true, cornice: true, roofStyle: 'parapet',
        roofClutter: true, roofPenthouse: false, roofVents: true,
        baseColor: [0.8, 0.72, 0.6], trimColor: [0.92, 0.88, 0.8], roofColor: [0.36, 0.34, 0.32],
        glassColor: [0.42, 0.55, 0.6], accentColor: [0.86, 0.28, 0.22], signColor: [0.95, 0.85, 0.3],
    },
    'neon-arcade': {
        category: 'shophouse', floors: 4, width: 9, depth: 12, floorHeight: 3, groundFloorHeight: 4.2,
        windowStyle: 'grid', bayWidth: 2, material: 'concrete', cornerStyle: 'chamfer', cornerAmount: 1,
        storefront: true, shopBays: 3, stallriser: true, transom: true, awning: true, shutter: true,
        signage: true, bladeSign: true, wrapSign: true, ledScreen: true, neon: true, ledges: true,
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
function computeSections(foot: V2[], p: BuildingParams, gH: number, topY: number): Section[] {
    const secs: Section[] = [];
    let cur = foot, startY = 0;
    const canSetback = p.setbacks > 0 && (p.category === 'tower' || p.category === 'office');
    if (p.podium && canSetback) {
        const podTop = Math.min(topY - p.floorHeight, gH + Math.max(0, p.podiumFloors - 1) * p.floorHeight);
        secs.push({ foot: cur, y0: 0, y1: podTop });
        cur = shrinkFoot(cur, Math.max(0.6, p.setbackInset)); startY = podTop;
    }
    if (canSetback) {
        const bands = p.setbacks + 1;
        const bandH = (topY - startY) / bands;
        for (let i = 0; i < bands; i++) {
            secs.push({ foot: cur, y0: startY + i * bandH, y1: startY + (i + 1) * bandH });
            if (i < bands - 1) cur = shrinkFoot(cur, Math.max(0.5, p.setbackInset));
        }
    } else {
        secs.push({ foot: cur, y0: 0, y1: topY });
    }
    return secs.filter(s => s.y1 - s.y0 > 0.1);
}

/**
 * Generate a building. Returns flat-colour LAYERS (→ addFlatColorMeshGroup) + METADATA.
 * `footprint` overrides the rectangular massing (the city passes the lot polygon here later).
 */
export function buildBuilding(partial: Partial<BuildingParams> = {}, footprint?: V2[]): { layers: LayoutPreviewLayer[]; meta: BuildingMeta } {
    const p = resolveBuildingParams(partial);
    const rnd = mulberry(p.seed * 2654435761);
    const foot = footprint && footprint.length >= 3 ? footprint : styledFoot(p);

    const floors = Math.max(1, Math.round(p.floors));
    const gH = p.groundFloorHeight > 0 ? p.groundFloorHeight : p.floorHeight;
    const fh = Math.max(1.5, p.floorHeight);
    const levels: number[] = [0]; { let y = gH; levels.push(y); for (let i = 1; i < floors; i++) { y += fh; levels.push(y); } }
    const topY = levels[floors];
    const baseTop = Math.min(0.5, gH * 0.12);

    const A: Accums = {
        wall: new Accum3D(), wallBase: new Accum3D(), glass: new Accum3D(), trim: new Accum3D(), roof: new Accum3D(),
        equip: new Accum3D(), awn: new Accum3D(), sign: new Accum3D(), screen: new Accum3D(),
        front: new Accum3D(), door: new Accum3D(), dframe: new Accum3D(), dhandle: new Accum3D(), green: new Accum3D(), bloom: new Accum3D(),
    };
    const edges = edgesOf(foot);
    const front = frontEdge(edges);
    const ctx: BuildCtx = {
        p, rnd, foot, sections: computeSections(foot, p, gH, topY), floors, levels, gH, fh, topY, baseTop,
        edges, front, A, meta: { height: topY, footprint: foot, door: null, signSlots: [], roofAnchor: [0, topY, 0], windowAnchors: [] },
        instGroups: [],
    };
    ctx.meta.door = { pos: [front.mid[0] + front.out[0] * 0.3, front.mid[1] + front.out[1] * 0.3], out: front.out, width: 1.2, height: 2.2 };

    // ── compose the facade (each part gated by params) ──
    emitMassing(ctx);
    emitFacadeDetail(ctx);
    if (p.balconies) emitBalconies(ctx);
    if (p.windowTrim) emitWindowTrim(ctx);
    if (p.julietBalconies) emitJulietBalconies(ctx);
    if (p.storefront || p.rollerDoors || p.canopy) emitStorefront(ctx);
    emitTraditional(ctx);       // machiya lattice / warehouse roller-doors / mall — category-gated internally
    emitRoof(ctx);
    emitRoofDetail(ctx);
    emitSignage(ctx);
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
    return { vertices, indices, format: '12float' };
}

/** Instancing tier for repeated detail (juliet/trim). FALSE = Tier-0: bake each instance into a merged mesh
 *  (behaviour-identical to pre-instancing). TRUE = emit instanced layers (canonical geometry + transforms) for the
 *  shared-key renderer path (P1). P0 keeps this false so output is unchanged while the decomposition is validated. */
const EMIT_INSTANCED = true;

// ── layer assembly: turn accumulators into coloured/patterned LayoutPreviewLayers ──
function wallPattern(p: BuildingParams): NonNullable<LayoutPreviewLayer['pattern']> {
    // Material overrides the window rhythm for the two non-glazed specials:
    if (p.material === 'timber') return { color: [0.2, 0.15, 0.1], freq: 1 / Math.max(0.7, p.bayWidth * 0.5), scale: 0.6, mode: 'grid', spacing: 0.55, angle: 0 };   // lattice/timber framing
    if (p.material === 'metal') return { color: [0.4, 0.42, 0.45], freq: 6, scale: 0.5, mode: 'stripes', angle: 1.57, spacing: 0.5 };   // corrugated sheet
    const bay = Math.max(1, p.bayWidth);
    const cfg = p.windowStyle === 'punched' ? { f: 1 / (bay * 1.15), s: 0.22 }
        : p.windowStyle === 'ribbon' ? { f: 1 / (bay * 0.9), s: 0.44 }
            : { f: 1 / bay, s: 0.3 };   // grid
    // facade type: ribbon → 3 (horizontal glazing bands); else masonry (brick 0 / concrete 1). Curtain is glass-layer only.
    const facade = p.windowStyle === 'ribbon' ? 3 : (p.material === 'brick' ? 0 : 1);
    return { color: LIT, freq: cfg.f, scale: cfg.s, mode: 'windows', angle: facade, spacing: Math.max(0, Math.min(1, p.nightWindows)) };
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
    const stoneFor = (c: [number, number, number]): LayoutPreviewLayer['pattern'] => ({ color: [c[0] * 0.86, c[1] * 0.86, c[2] * 0.88], freq: 1.6, scale: 0.05, mode: 'grid', spacing: 1 });
    if (!A.trim.empty) out.push({ name: 'bldg:trim', color: p.trimColor, y: 0, geometry: A.trim.geometry(), emissive: SOLID_E, pattern: stoneFor(p.trimColor) });
    // Repeated detail (juliet / window trim) — emitted as canonical geometry + per-window transforms (see emit*).
    // Colour/pattern assigned here by name (the emitters stay geometry-only). Tier-0 bakes; Tier-1 instances.
    const instMeta: Record<string, { color: [number, number, number]; pattern?: LayoutPreviewLayer['pattern'] }> = {
        'bldg:juliet': { color: p.julietColor },
        // NO stone pattern on window trims: the ashlar-joint grain reads fine on big cornices but as a harsh
        // checker/chain on thin window surrounds (the "strange trims" report) — plain stone colour there.
        'bldg:windowtrim': { color: p.windowTrimColor },
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
        const flatRoof: LayoutPreviewLayer['pattern'] = { color: [p.roofColor[0] * 0.85, p.roofColor[1] * 0.85, p.roofColor[2] * 0.86], freq: 1.1, scale: 0.045, mode: 'grid', spacing: 1 };
        out.push({ name: 'bldg:roof', color: p.roofColor, y: 0, geometry: A.roof.geometry(), emissive: SOLID_E * 0.8, pattern: tiled ? { color: seam, freq: 8, scale: 0.3, mode: 'grid', spacing: 1 } : flatRoof });
    }
    // roof clutter (tanks / AC units / vents / pipes): subtle metal-panel grain so it isn't flat plastic either.
    if (!A.equip.empty) out.push({ name: 'bldg:roof-equip', color: [0.5, 0.5, 0.52], y: 0, geometry: A.equip.geometry(), emissive: SOLID_E * 0.8, pattern: { color: [0.42, 0.42, 0.46], freq: 1.4, scale: 0.05, mode: 'grid', spacing: 1 } });
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
    if (!A.sign.empty) out.push({ name: 'bldg:sign', color: p.signColor, y: 0, geometry: A.sign.geometry(), emissive: p.neon ? 1.6 : 1.2 });
    if (!A.screen.empty) out.push({ name: 'bldg:screen', color: [0.95, 0.97, 1.0], y: 0, geometry: A.screen.geometry(), emissive: 1.4, pattern: { color: p.signColor, freq: 9, angle: 0.6, scale: 0.5, mode: 'waves', spacing: 0.7 } });
    // whole-building shading style (PBR default / cel / cel-hd / sketch / ink / gouraud) — applied to every layer
    if (p.renderStyle !== 'default') for (const L of out) L.renderStyle = p.renderStyle;
    return out;
}
