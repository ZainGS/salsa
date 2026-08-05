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

import { buildBuilding, resolveBuildingParams, buildingArchetypeNames, BUILDING_ARCHETYPES } from '../../world/building';
import type { BuildingParams, BuildingMeta, FoliagePlacement } from '../../world/building';
import { coerceColorKeys } from './color-util';
import type { Scene3DManager } from './scene3d-manager';
import { ProceduralObjectManager, DEFAULT_METERS_PER_UNIT, type ProcTransform } from './procedural-object-manager';

const FOLIAGE_COLOR_KEYS = ['foliageColor', 'tipColor', 'bloomColor', 'potColor', 'trunkColor'];

// Re-exported for the modules that imported it from here before it moved to the shared base (e.g. BlockManager).
export { DEFAULT_METERS_PER_UNIT };

type BTransform = ProcTransform;

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

export class BuildingManager extends ProceduralObjectManager<BuildingParams, BuildingMeta> {
    protected readonly kind = 'building';
    protected readonly meshLabel = 'Building Mesh';
    protected build(params: BuildingParams): { layers: ReturnType<typeof buildBuilding>['layers']; meta: BuildingMeta } { return buildBuilding(params); }
    protected resolveParams(partial: unknown): BuildingParams { return resolveBuildingParams(coerceColors(partial as Partial<BuildingParams>)); }
    protected makeName(params: BuildingParams): string { return `${cap(params.category)} ${++this._counter}`; }

    constructor(scene3d: Scene3DManager) {
        super(scene3d);
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
    }

    /** Create + place a new procedural building. Auto-frames the camera on it. Returns its container node id. */
    create(partial: Partial<BuildingParams> = {}, transform: Partial<BTransform> = {}, opts: { scale?: number; frame?: boolean } = {}): { id: string; meta: BuildingMeta } {
        const rec = this._create(partial, transform, opts);
        return { id: rec.container.id, meta: rec.meta! };
    }

    /** Live-edit a building's params (merge over its current params) and regenerate in place (same node id →
     *  selection + placement survive). Passing a different `archetype` switches style (reloads the preset,
     *  keeping seed + placement). */
    setParams(id: string, partial: Partial<BuildingParams>): boolean {
        const rec = this._items.get(id);
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

    /** Domain-named alias for {@link isManaged}. */
    isBuilding(id: string): boolean { return this.isManaged(id); }

    // ── Building Editor mode + attached-foliage placement (grid tool) ─────────────────────────────────────
    private _editId: string | null = null;
    /** Enter Building Editor mode: frame the building + show the ground grid (for the foliage placement tool). */
    enterEditMode(id: string): boolean {
        const rec = this._items.get(id);
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
        const rec = this._items.get(id);
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
        const rec = this._items.get(id);
        if (!rec) return -1;
        const pl = coerceColorKeys({ ...placement }, FOLIAGE_COLOR_KEYS) as FoliagePlacement;
        if (opts.checkOverlap !== false && !this.canPlaceFoliage(id, pl.x, pl.z, this._placementRadius(pl))) return -1;
        const list = [...(rec.params.foliage ?? []), pl];
        rec.params = { ...rec.params, foliage: list };
        this._rebuild(rec);
        return list.length - 1;
    }
    removeFoliage(id: string, index: number): boolean {
        const rec = this._items.get(id);
        if (!rec) return false;
        const list = [...(rec.params.foliage ?? [])];
        if (index < 0 || index >= list.length) return false;
        list.splice(index, 1); rec.params = { ...rec.params, foliage: list }; this._rebuild(rec);
        return true;
    }
    clearFoliage(id: string): boolean {
        const rec = this._items.get(id);
        if (!rec) return false;
        rec.params = { ...rec.params, foliage: [] }; this._rebuild(rec);
        return true;
    }
    getFoliage(id: string): FoliagePlacement[] { const r = this._items.get(id); return r ? [...(r.params.foliage ?? [])] : []; }

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

    // setTransform / getTransform / setScale / setMetersPerUnit now come from ProceduralObjectManager.

    /** Model↔real scale info for the host UI (ratio + real/display dimensions). */
    getScaleInfo(id: string): BuildingScaleInfo | null {
        const rec = this._items.get(id);
        if (!rec) return null;
        const h = rec.meta?.height ?? 0;
        let w = 0, d = 0;
        if (rec.meta) { let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (const pt of rec.meta.footprint) { if (pt[0] < minX) minX = pt[0]; if (pt[0] > maxX) maxX = pt[0]; if (pt[1] < minZ) minZ = pt[1]; if (pt[1] > maxZ) maxZ = pt[1]; }
            w = maxX - minX; d = maxZ - minZ;
        }
        return { scale: rec.scale, metersPerUnit: 1 / rec.scale, realHeightM: h, displayHeightUnits: h * rec.scale, realWidthM: w, realDepthM: d };
    }

    // remove / restoreFromSave / clear / count now come from ProceduralObjectManager (the 'building' marker
    // kind, buildBuilding generator and colour coercion are supplied via the abstract members at the top).

    /** All buildings (for the host outliner / picker). */
    list(): { id: string; name: string; category: BuildingParams['category']; archetype: string }[] {
        return [...this._items.values()].map(r => ({ id: r.container.id, name: r.container.name ?? '', category: r.params.category, archetype: r.params.archetype }));
    }

    archetypeNames(): string[] { return buildingArchetypeNames(); }
    archetypeParams(name: string): Partial<BuildingParams> | null { return BUILDING_ARCHETYPES[name] ? { ...BUILDING_ARCHETYPES[name] } : null; }

    // _stamp / _rebuild now come from ProceduralObjectManager (via the abstract `kind` / `meshLabel` / `build`).
}
