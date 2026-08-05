// ─────────────────────────────────────────────────────────────────────────────
// ProceduralObjectManager<TParams, TMeta> — the shared lifecycle for a scene full of standalone procedural
// objects (Building Creator, Foliage Creator, …). Each object is its OWN thin-wrapper MeshGroup3D container
// at the scene root (one outliner item, selected/gizmoed/transformed as a unit); its geometry comes from a
// pure generator and is added as NON-serialized children; the container serializes as a tiny params-only
// marker (`worldParams.kind`) so save stays small and load regenerates via {@link restoreFromSave}.
//
// ★ WHY THIS EXISTS. BuildingManager and FoliageManager were a find-and-replace of each other — the same
// `_items` map, `_counter`, gizmo transform-sync listener, create/setTransform/setScale/remove/list/clear/
// restoreFromSave/_stamp/_rebuild, differing only in the generator, the marker `kind`, colour coercion, and
// a name. That is precisely the duplication that lets two copies of one behaviour silently drift. This base
// holds the identical half; each subclass supplies the four things that genuinely differ (below) plus its
// own domain API (a building's attached-foliage placement, a foliage's type list, etc.).
//
// Subclasses provide: `kind` (marker discriminator) · `meshLabel` (child-group name) · `build(params)` (the
// generator) · `resolveParams(partial)` (defaults + colour coercion) · `makeName(params)` (outliner label).
// ─────────────────────────────────────────────────────────────────────────────

import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { LayoutPreviewLayer } from '../../world/types';
import type { Scene3DManager } from './scene3d-manager';

/** A placed object's transform (translation + Euler rotation). Scale is tracked separately (display scale). */
export interface ProcTransform { x: number; y: number; z: number; rx: number; ry: number; rz: number; }
export const IDENTITY_T: ProcTransform = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };

// Generators author in real METRES; an object is DISPLAYED at a uniform metres→units scale so a "model" sits
// at canvas scale with consistent relative sizes. Default 1 world unit = 10 m. (The city picks its own scale
// when it sizes objects to lots.) Shared so buildings and foliage read at the same size side by side.
export const DEFAULT_METERS_PER_UNIT = 10;

/** One managed object: its thin-wrapper container, the swapped-on-regen child group, params, transform,
 *  display scale (world units per metre), and the generator's last meta. */
export interface ProcRec<TParams, TMeta> {
    container: MeshGroup3D;
    group: MeshGroup3D | null;
    params: TParams;
    transform: ProcTransform;
    scale: number;
    meta: TMeta | null;
}

/** The persisted marker every subclass writes — `kind` distinguishes owners so no manager adopts another's. */
export interface ProcMarker<TParams> { kind: string; params: Partial<TParams>; transform: Partial<ProcTransform>; scale?: number; }

export abstract class ProceduralObjectManager<TParams, TMeta> {
    protected _items = new Map<string, ProcRec<TParams, TMeta>>();
    protected _counter = 0;

    /** Marker discriminator, e.g. 'building' | 'foliage'. */
    protected abstract readonly kind: string;
    /** Child mesh-group name prefix, e.g. 'Building Mesh'. */
    protected abstract readonly meshLabel: string;
    /** The pure generator: params → renderable layers + meta. */
    protected abstract build(params: TParams): { layers: LayoutPreviewLayer[]; meta: TMeta };
    /** Fill defaults + coerce host colour formats. Used by both create() and restore. */
    protected abstract resolveParams(partial: unknown): TParams;
    /** Outliner label for a new object. */
    protected abstract makeName(params: TParams): string;

    constructor(protected readonly scene3d: Scene3DManager) {
        // Persist gizmo moves: when a managed container is dragged, mirror its live transform (incl. a scale
        // drag) into the marker. Guarded on map membership so this ignores every OTHER owner's wrappers.
        this.scene3d.addThinWrapperTransformSync((c) => {
            const rec = this._items.get(c.id);
            if (!rec) return;
            rec.transform = { x: c.x, y: c.y, z: c.z, rx: c.rotationX, ry: c.rotationY, rz: c.rotation };
            if (c.scaleX > 0) rec.scale = c.scaleX;
            this._stamp(rec);
        });
    }

    /** Create + place a new object (auto-frames unless `frame:false`). Subclasses expose a typed wrapper. */
    protected _create(partial: unknown, transform: Partial<ProcTransform>, opts: { scale?: number; frame?: boolean } = {}): ProcRec<TParams, TMeta> {
        const params = this.resolveParams(partial);
        const container = this.scene3d.createCityContainer(this.makeName(params));
        const t: ProcTransform = { ...IDENTITY_T, ...transform };
        const rec: ProcRec<TParams, TMeta> = { container, group: null, params, transform: t, scale: opts.scale ?? 1 / DEFAULT_METERS_PER_UNIT, meta: null };
        this._items.set(container.id, rec);
        this._rebuild(rec);
        this.scene3d.setGroupTransform(container, { ...t, s: rec.scale });
        if (opts.frame !== false) this.scene3d.frameGroup(container);
        return rec;
    }

    /** Merge `partial` over the current params, re-resolve (defaults + clamps), and regenerate IN PLACE
     *  (same node id → selection + placement survive). This is the generic edit the typeId dispatcher calls.
     *  Subclasses OVERRIDE for special semantics (a building's archetype switch keeps the seed; foliage
     *  coerces colours without a full re-resolve). The default is correct for a plain flat params object. */
    setParams(id: string, partial: Partial<TParams>): boolean {
        const rec = this._items.get(id);
        if (!rec) return false;
        rec.params = this.resolveParams({ ...rec.params, ...partial });
        this._rebuild(rec);
        return true;
    }

    /** Generic create for the typeId dispatcher — returns the new node id. Subclasses keep a typed create(). */
    createFromParams(partial: unknown, transform: Partial<ProcTransform> = {}): string {
        return this._create(partial, transform).container.id;
    }

    getParams(id: string): TParams | null { const r = this._items.get(id); return r ? { ...r.params } : null; }
    getMeta(id: string): TMeta | null { return this._items.get(id)?.meta ?? null; }
    /** True if this manager owns `id` (each subclass also exposes a domain-named alias, e.g. isBuilding). */
    isManaged(id: string): boolean { return this._items.has(id); }
    frame(id: string): boolean { const r = this._items.get(id); return r ? this.scene3d.frameGroup(r.container) : false; }
    getTransform(id: string): ProcTransform | null { const r = this._items.get(id); return r ? { ...r.transform } : null; }

    setTransform(id: string, t: Partial<ProcTransform>): boolean {
        const rec = this._items.get(id);
        if (!rec) return false;
        rec.transform = { ...rec.transform, ...t };
        this.scene3d.setGroupTransform(rec.container, { ...rec.transform, s: rec.scale });
        this._stamp(rec);
        return true;
    }

    /** Set the display scale (world units per metre). Regenerate-free (transform only). */
    setScale(id: string, unitsPerMetre: number): boolean {
        const rec = this._items.get(id);
        if (!rec || !(unitsPerMetre > 0)) return false;
        rec.scale = unitsPerMetre;
        this.scene3d.setGroupTransform(rec.container, { s: rec.scale });
        this._stamp(rec);
        return true;
    }
    /** Set scale by metres-per-unit (the inverse — the "1 : N" ratio the UI shows). */
    setMetersPerUnit(id: string, metresPerUnit: number): boolean { return metresPerUnit > 0 ? this.setScale(id, 1 / metresPerUnit) : false; }

    remove(id: string): boolean {
        const rec = this._items.get(id);
        if (!rec) return false;
        if (rec.group) this.scene3d.removeFlatColorMeshGroup(rec.group);
        this.scene3d.removeFlatColorMeshGroup(rec.container);
        this._items.delete(id);
        return true;
    }

    clear(): void { for (const id of [...this._items.keys()]) this.remove(id); this._counter = 0; }
    get count(): number { return this._items.size; }

    /** Regenerate every object whose lightweight marker was restored from a loaded save. Host calls on doc
     *  load. Returns how many were rebuilt. */
    restoreFromSave(): number {
        let n = 0;
        for (const child of this.scene3d.getRootMeshGroups()) {
            const wp = child.worldParams as ProcMarker<TParams> | null;
            if (!wp || wp.kind !== this.kind || !wp.params) continue;
            if (this._items.has(child.id)) continue;
            if (!this._acceptRestore(wp)) continue;
            child.thinWrapper = true;
            child.documentSkipChildren = true;
            const rec: ProcRec<TParams, TMeta> = {
                container: child, group: null,
                params: this.resolveParams(wp.params),
                transform: { ...IDENTITY_T, ...(wp.transform ?? {}) },
                scale: wp.scale && wp.scale > 0 ? wp.scale : 1 / DEFAULT_METERS_PER_UNIT,
                meta: null,
            };
            this._items.set(child.id, rec);
            this._rebuild(rec);
            this.scene3d.setGroupTransform(child, { ...rec.transform, s: rec.scale });
            n++;
        }
        this._counter = Math.max(this._counter, this._items.size);   // keep new names from colliding with restored
        return n;
    }

    /** Hook for a subclass to reject a marker it should not adopt (default: accept any of its `kind`). */
    protected _acceptRestore(_marker: ProcMarker<TParams>): boolean { return true; }

    protected _stamp(rec: ProcRec<TParams, TMeta>): void {
        rec.container.worldParams = { kind: this.kind, params: rec.params, transform: rec.transform, scale: rec.scale } satisfies ProcMarker<TParams>;
    }

    /** (Re)generate geometry into the container: build layers, swap the child group, re-cache bounds + marker. */
    protected _rebuild(rec: ProcRec<TParams, TMeta>): void {
        const { layers, meta } = this.build(rec.params);
        if (rec.group) { this.scene3d.removeFlatColorMeshGroup(rec.group); rec.group = null; }
        rec.group = this.scene3d.addFlatColorMeshGroup(`${this.meshLabel} ${rec.container.id}`, layers, false, rec.container);
        rec.meta = meta;
        this._stamp(rec);
        this.scene3d.cacheGroupBounds(rec.container);
    }
}
