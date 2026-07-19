// ─────────────────────────────────────────────────────────────────────────────
// BuildingManager — lifecycle for standalone procedural buildings (the Building Creator).
//
// Mirrors WorldManager, but for MANY coexisting buildings instead of one city. Each
// building is its OWN thin-wrapper MeshGroup3D container at the scene root (so it's one
// outliner item, selected + transformed as a unit — selection/gizmo/outliner already
// treat any thin-wrapper this way). Geometry comes from the pure buildBuilding() generator
// (src/world/building.ts) and is added as non-serialized children; the container serializes
// as a lightweight params-only marker (worldParams.kind === 'building') so save stays tiny
// and load regenerates via restoreFromSave().
//
// Host contract (Frogmarks "Building Creator"): docs/ui/building-creator.md. The host drives
// Add / select / Edit through the ShapeManager `*3D` wrappers that delegate here.
// ─────────────────────────────────────────────────────────────────────────────

import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { buildBuilding, resolveBuildingParams, buildingArchetypeNames, BUILDING_ARCHETYPES } from '../../world/building';
import type { BuildingParams, BuildingMeta, FoliagePlacement } from '../../world/building';
import { coerceColorKeys } from './color-util';

const FOLIAGE_COLOR_KEYS = ['foliageColor', 'tipColor', 'bloomColor', 'potColor', 'trunkColor'];
import type { Scene3DManager } from './scene3d-manager';

type BTransform = { x: number; y: number; z: number; rx: number; ry: number; rz: number };
const IDENTITY_T: BTransform = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };

// The generator works in real METRES (floorHeight ≈ 3 m). A building is DISPLAYED at a uniform scale mapping metres →
// world units, so a "model" sits at canvas scale (single-digit units) with consistent relative sizes (a tower really
// dwarfs a house). Default 1 world unit = 10 m. The city will pick its own metres/unit when it sizes buildings to lots.
export const DEFAULT_METERS_PER_UNIT = 10;

interface BuildingRec {
    container: MeshGroup3D;      // the thin-wrapper (one outliner item)
    group: MeshGroup3D | null;   // its single child group holding all layer meshes (swapped on regen)
    params: BuildingParams;
    transform: BTransform;
    scale: number;               // world units per metre (display scale)
    meta: BuildingMeta | null;
}

/** Persisted marker shape (container.worldParams) — distinct `kind` so the City manager never adopts a building. */
interface BuildingMarker { kind: 'building'; params: Partial<BuildingParams>; transform: Partial<BTransform>; scale?: number; }

/** Model↔real scale info for the host UI (the "1 : N" ratio + real/display dimensions). */
export interface BuildingScaleInfo { scale: number; metersPerUnit: number; realHeightM: number; displayHeightUnits: number; realWidthM: number; realDepthM: number; }

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const COLOR_KEYS = ['baseColor', 'trimColor', 'roofColor', 'glassColor', 'accentColor', 'signColor', 'storefrontColor', 'awningColor', 'doorColor', 'doorFrameColor', 'doorHandleColor', 'julietColor', 'windowTrimColor'] as const;

/** Coerce any host colour format → a [0..1] RGB triple: [0..1] array, [0..255] array, {r,g,b}, or "#rrggbb"/"#rgb".
 *  The generator/shader expect 0..1 linear-ish RGB; this makes the API robust to whatever a host picker emits. */
function toRGB(v: unknown): [number, number, number] | null {
    if (typeof v === 'string') {
        const h = v.trim().replace(/^#/, '');
        if (/^[0-9a-fA-F]{6}$/.test(h)) return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
        if (/^[0-9a-fA-F]{3}$/.test(h)) return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255];
        return null;
    }
    let r: number, g: number, b: number;
    if (Array.isArray(v) && v.length >= 3) { r = v[0]; g = v[1]; b = v[2]; }
    else if (v && typeof v === 'object' && 'r' in (v as Record<string, unknown>)) { const o = v as { r: number; g: number; b: number }; r = o.r; g = o.g; b = o.b; }
    else return null;
    if (![r, g, b].every(n => typeof n === 'number' && isFinite(n))) return null;
    if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }   // 0-255 → 0-1
    const c = (n: number): number => Math.max(0, Math.min(1, n));
    return [c(r), c(g), c(b)];
}

/** Normalize any colour-valued params in a partial to [0..1] RGB triples (drops unparseable ones). */
function coerceColors(partial: Partial<BuildingParams>): Partial<BuildingParams> {
    const out = { ...partial } as Record<string, unknown>;
    for (const k of COLOR_KEYS) {
        if (k in out && out[k] != null) { const rgb = toRGB(out[k]); if (rgb) out[k] = rgb; else delete out[k]; }
    }
    return out as Partial<BuildingParams>;
}

export class BuildingManager {
    private _buildings = new Map<string, BuildingRec>();
    private _counter = 0;

    constructor(private readonly scene3d: Scene3DManager) {
        // DEV console harness so buildings can be created/edited before Frogmarks has the Building Creator UI:
        //   salsaBuild.archetype('retro-shophouse')          → add one, returns its node id
        //   salsaBuild.set(id, { floors: 5, awning: true })  → live-edit its params
        //   salsaBuild.move(id, { x: 20 })                   → place it
        //   salsaBuild.list() / .archetypes() / .remove(id)
        if (typeof window !== 'undefined') {
            (window as unknown as { salsaBuild?: unknown }).salsaBuild = {
                add: (p: Partial<BuildingParams> = {}, t: Partial<BTransform> = {}) => this.create(p, t).id,
                archetype: (name: string, t: Partial<BTransform> = {}) => this.create({ archetype: name }, t).id,
                set: (id: string, p: Partial<BuildingParams>) => this.setParams(id, p),
                get: (id: string) => this.getParams(id),
                meta: (id: string) => this.getMeta(id),
                move: (id: string, t: Partial<BTransform>) => this.setTransform(id, t),
                scale: (id: string, unitsPerMetre: number) => this.setScale(id, unitsPerMetre),   // e.g. 0.1 = 1u:10m
                ratio: (id: string) => this.getScaleInfo(id),                                     // model↔real scale info
                frame: (id: string) => this.frame(id),
                remove: (id: string) => this.remove(id),
                list: () => this.list(),
                archetypes: () => buildingArchetypeNames(),
                restore: () => this.restoreFromSave(),
                clear: () => this.clear(),
                edit: (id: string) => this.enterEditMode(id),                                   // Building Editor mode + grid
                exitEdit: () => this.exitEditMode(),
                plant: (id: string, pl: FoliagePlacement) => this.addFoliage(id, pl),           // attach foliage at building-local x,z
                unplant: (id: string, i: number) => this.removeFoliage(id, i),
                plants: (id: string) => this.getFoliage(id),
                manager: this,
            };
        }

        // Persist gizmo moves: when a Building container is dragged, mirror its live transform (incl. scale) into
        // the marker. Guarded on map membership so this listener ignores the City (and any other owner's) wrappers.
        this.scene3d.addThinWrapperTransformSync((c) => {
            const rec = this._buildings.get(c.id);
            if (!rec) return;
            rec.transform = { x: c.x, y: c.y, z: c.z, rx: c.rotationX, ry: c.rotationY, rz: c.rotation };
            if (c.scaleX > 0) rec.scale = c.scaleX;   // capture a gizmo scale drag
            this._stamp(rec);
        });
    }

    /** Create + place a new procedural building. Auto-frames the camera on it. Returns its container node id. */
    create(partial: Partial<BuildingParams> = {}, transform: Partial<BTransform> = {}, opts: { scale?: number; frame?: boolean } = {}): { id: string; meta: BuildingMeta } {
        const params = resolveBuildingParams(coerceColors(partial));
        const container = this.scene3d.createCityContainer(this._nextName(params.category));   // generic thin-wrapper at root
        const t: BTransform = { ...IDENTITY_T, ...transform };
        const rec: BuildingRec = { container, group: null, params, transform: t, scale: opts.scale ?? 1 / DEFAULT_METERS_PER_UNIT, meta: null };
        this._buildings.set(container.id, rec);
        this._rebuild(rec);
        this.scene3d.setGroupTransform(container, { ...t, s: rec.scale });
        if (opts.frame !== false) this.scene3d.frameGroup(container);
        return { id: container.id, meta: rec.meta! };
    }

    /** Live-edit a building's params (merge over its current params) and regenerate in place (same node id →
     *  selection + placement survive). Passing a different `archetype` switches style (reloads the preset,
     *  keeping seed + placement). */
    setParams(id: string, partial: Partial<BuildingParams>): boolean {
        const rec = this._buildings.get(id);
        if (!rec) return false;
        const norm = coerceColors(partial);
        if (norm.archetype && norm.archetype !== rec.params.archetype) {
            rec.params = resolveBuildingParams({ seed: rec.params.seed, foliage: rec.params.foliage, ...norm });   // style switch — keep seed + placed foliage
        } else {
            rec.params = { ...rec.params, ...norm };
        }
        this._rebuild(rec);
        return true;
    }

    getParams(id: string): BuildingParams | null { const r = this._buildings.get(id); return r ? { ...r.params } : null; }
    getMeta(id: string): BuildingMeta | null { return this._buildings.get(id)?.meta ?? null; }
    isBuilding(id: string): boolean { return this._buildings.has(id); }

    /** Frame the camera on a building. */
    frame(id: string): boolean { const r = this._buildings.get(id); return r ? this.scene3d.frameGroup(r.container) : false; }

    // ── Building Editor mode + attached-foliage placement (grid tool) ─────────────────────────────────────
    private _editId: string | null = null;
    /** Enter Building Editor mode: frame the building + show the ground grid (for the foliage placement tool). */
    enterEditMode(id: string): boolean {
        const rec = this._buildings.get(id);
        if (!rec) return false;
        this._editId = id;
        this.scene3d.frameGroup(rec.container);
        this.scene3d.gridVisible = true;
        return true;
    }
    exitEditMode(): void { this._editId = null; this.scene3d.gridVisible = false; }
    get editId(): string | null { return this._editId; }

    /** Estimated ground-footprint radius (metres) of a placement, for overlap tests. */
    private _placementRadius(pl: FoliagePlacement): number { return Math.max(pl.size ?? 1.2, pl.width ?? 0) * 0.5 + 0.1; }

    /** Can a plant of ~`radius` sit at building-local (x,z) without overlapping the building or an existing plant?
     *  (x,z) are in the building's local metres — the same space as the placement grid + `meta.footprint`.) */
    canPlaceFoliage(id: string, x: number, z: number, radius = 0.6): boolean {
        const rec = this._buildings.get(id);
        if (!rec || !rec.meta) return false;
        if (this._pointNearPoly(x, z, rec.meta.footprint, radius)) return false;   // on/against the building
        for (const pl of rec.params.foliage ?? []) {
            const pr = this._placementRadius(pl), dx = x - pl.x, dz = z - pl.z;
            if (dx * dx + dz * dz < (radius + pr) * (radius + pr)) return false;    // over an existing plant
        }
        return true;
    }

    /** Add an attached foliage placement (building-local x,z + optional rot + foliage params). Regenerates the
     *  building (so it persists/travels). Returns the new index, or -1 if it overlaps (unless checkOverlap:false). */
    addFoliage(id: string, placement: FoliagePlacement, opts: { checkOverlap?: boolean } = {}): number {
        const rec = this._buildings.get(id);
        if (!rec) return -1;
        const pl = coerceColorKeys({ ...placement }, FOLIAGE_COLOR_KEYS) as FoliagePlacement;
        if (opts.checkOverlap !== false && !this.canPlaceFoliage(id, pl.x, pl.z, this._placementRadius(pl))) return -1;
        const list = [...(rec.params.foliage ?? []), pl];
        rec.params = { ...rec.params, foliage: list };
        this._rebuild(rec);
        return list.length - 1;
    }
    removeFoliage(id: string, index: number): boolean {
        const rec = this._buildings.get(id);
        if (!rec) return false;
        const list = [...(rec.params.foliage ?? [])];
        if (index < 0 || index >= list.length) return false;
        list.splice(index, 1); rec.params = { ...rec.params, foliage: list }; this._rebuild(rec);
        return true;
    }
    clearFoliage(id: string): boolean {
        const rec = this._buildings.get(id);
        if (!rec) return false;
        rec.params = { ...rec.params, foliage: [] }; this._rebuild(rec);
        return true;
    }
    getFoliage(id: string): FoliagePlacement[] { const r = this._buildings.get(id); return r ? [...(r.params.foliage ?? [])] : []; }

    private _distSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0; t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
    }
    private _pointNearPoly(x: number, z: number, poly: [number, number][], margin: number): boolean {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
            if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
        }
        if (inside) return true;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            if (this._distSeg(x, z, poly[j][0], poly[j][1], poly[i][0], poly[i][1]) < margin) return true;
        }
        return false;
    }

    /** Translate/rotate a placed building. */
    setTransform(id: string, t: Partial<BTransform>): boolean {
        const rec = this._buildings.get(id);
        if (!rec) return false;
        rec.transform = { ...rec.transform, ...t };
        this.scene3d.setGroupTransform(rec.container, { ...rec.transform, s: rec.scale });
        this._stamp(rec);
        return true;
    }
    getTransform(id: string): BTransform | null { const r = this._buildings.get(id); return r ? { ...r.transform } : null; }

    /** Set the display scale (world units per metre). E.g. 0.1 = 1 unit : 10 m. Regenerate-free (transform only). */
    setScale(id: string, unitsPerMetre: number): boolean {
        const rec = this._buildings.get(id);
        if (!rec || !(unitsPerMetre > 0)) return false;
        rec.scale = unitsPerMetre;
        this.scene3d.setGroupTransform(rec.container, { s: rec.scale });
        this._stamp(rec);
        return true;
    }
    /** Set scale by metres-per-unit (the inverse — the "1 : N" ratio the UI shows). */
    setMetersPerUnit(id: string, metresPerUnit: number): boolean { return metresPerUnit > 0 ? this.setScale(id, 1 / metresPerUnit) : false; }

    /** Model↔real scale info for the host UI (ratio + real/display dimensions). */
    getScaleInfo(id: string): BuildingScaleInfo | null {
        const rec = this._buildings.get(id);
        if (!rec) return null;
        const h = rec.meta?.height ?? 0;
        let w = 0, d = 0;
        if (rec.meta) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (const pt of rec.meta.footprint) { if (pt[0] < minX) minX = pt[0]; if (pt[0] > maxX) maxX = pt[0]; if (pt[1] < minZ) minZ = pt[1]; if (pt[1] > maxZ) maxZ = pt[1]; }
            w = maxX - minX; d = maxZ - minZ;
        }
        return { scale: rec.scale, metersPerUnit: 1 / rec.scale, realHeightM: h, displayHeightUnits: h * rec.scale, realWidthM: w, realDepthM: d };
    }

    /** Remove a building from the scene. */
    remove(id: string): boolean {
        const rec = this._buildings.get(id);
        if (!rec) return false;
        if (rec.group) this.scene3d.removeFlatColorMeshGroup(rec.group);
        this.scene3d.removeFlatColorMeshGroup(rec.container);
        this._buildings.delete(id);
        return true;
    }

    /** All buildings (for the host outliner / picker). */
    list(): { id: string; name: string; category: BuildingParams['category']; archetype: string }[] {
        return [...this._buildings.values()].map(r => ({ id: r.container.id, name: r.container.name ?? '', category: r.params.category, archetype: r.params.archetype }));
    }

    /** Regenerate every building whose lightweight marker was restored from a loaded save (params-only persistence).
     *  The host calls this after document load. Returns how many were rebuilt. */
    restoreFromSave(): number {
        let n = 0;
        for (const child of this.scene3d.getRootMeshGroups()) {
            const wp = child.worldParams as BuildingMarker | null;
            if (!wp || wp.kind !== 'building' || !wp.params) continue;
            if (this._buildings.has(child.id)) continue;
            child.thinWrapper = true;
            child.documentSkipChildren = true;
            const rec: BuildingRec = {
                container: child, group: null,
                params: resolveBuildingParams(coerceColors(wp.params)),
                transform: { ...IDENTITY_T, ...(wp.transform ?? {}) },
                scale: wp.scale && wp.scale > 0 ? wp.scale : 1 / DEFAULT_METERS_PER_UNIT,
                meta: null,
            };
            this._buildings.set(child.id, rec);
            this._rebuild(rec);
            this.scene3d.setGroupTransform(child, { ...rec.transform, s: rec.scale });
            n++;
        }
        this._counter = Math.max(this._counter, this._buildings.size);   // keep new names from colliding with restored ones
        return n;
    }

    /** Remove all buildings. */
    clear(): void {
        for (const id of [...this._buildings.keys()]) this.remove(id);
        this._counter = 0;
    }

    get count(): number { return this._buildings.size; }
    archetypeNames(): string[] { return buildingArchetypeNames(); }
    archetypeParams(name: string): Partial<BuildingParams> | null { return BUILDING_ARCHETYPES[name] ? { ...BUILDING_ARCHETYPES[name] } : null; }

    // ── internal ──
    private _nextName(cat: BuildingParams['category']): string { return `${cap(cat)} ${++this._counter}`; }

    private _stamp(rec: BuildingRec): void {
        rec.container.worldParams = { kind: 'building', params: rec.params, transform: rec.transform, scale: rec.scale } satisfies BuildingMarker;
    }

    /** (Re)generate geometry into the container: build layers, swap the child group, re-cache bounds + marker. */
    private _rebuild(rec: BuildingRec): void {
        const { layers, meta } = buildBuilding(rec.params);
        if (rec.group) { this.scene3d.removeFlatColorMeshGroup(rec.group); rec.group = null; }
        rec.group = this.scene3d.addFlatColorMeshGroup(`Building Mesh ${rec.container.id}`, layers, false, rec.container);
        rec.meta = meta;
        this._stamp(rec);
        this.scene3d.cacheGroupBounds(rec.container);
    }
}
