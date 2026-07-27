// ─────────────────────────────────────────────────────────────────────────────
// FoliageManager — lifecycle for FREESTANDING procedural foliage (Foliage Creator, spec item 3).
// Mirrors BuildingManager: each foliage instance is its own thin-wrapper MeshGroup3D at the scene root (one outliner
// item, select/gizmo as a unit), geometry from the pure buildFoliage() generator, params-only marker persistence
// (worldParams.kind === 'foliage'). Building-ATTACHED foliage (spec items 2/4) is separate — it lives in a building's
// params. Shares the metres→units display scale + colour coercion with buildings.
// ─────────────────────────────────────────────────────────────────────────────

import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { buildFoliage, resolveFoliageParams, foliageTypeNames } from '../../world/foliage';
import type { FoliageParams, FoliageMeta } from '../../world/foliage';
import { coerceColorKeys } from './color-util';
import type { Scene3DManager } from './scene3d-manager';

type FTransform = { x: number; y: number; z: number; rx: number; ry: number; rz: number };
const IDENTITY_T: FTransform = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
const DEFAULT_METERS_PER_UNIT = 10;   // same scale as buildings so a bush reads correctly next to a tower
const FOLIAGE_COLOR_KEYS = ['foliageColor', 'tipColor', 'bloomColor', 'potColor', 'trunkColor', 'petalColor', 'centerColor', 'stemColor', 'soilColor'];

interface FoliageRec { container: MeshGroup3D; group: MeshGroup3D | null; params: FoliageParams; transform: FTransform; scale: number; meta: FoliageMeta | null; }
interface FoliageMarker { kind: 'foliage'; params: Partial<FoliageParams>; transform: Partial<FTransform>; scale?: number; }

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export class FoliageManager {
    private _items = new Map<string, FoliageRec>();
    private _counter = 0;

    constructor(private readonly scene3d: Scene3DManager) {
        if (typeof window !== 'undefined') {
            (window as unknown as { salsaFoliage?: unknown }).salsaFoliage = {
                add: (p: Partial<FoliageParams> = {}, t: Partial<FTransform> = {}) => this.create(p, t).id,
                type: (type: FoliageParams['type'], t: Partial<FTransform> = {}) => this.create({ type }, t).id,
                set: (id: string, p: Partial<FoliageParams>) => this.setParams(id, p),
                get: (id: string) => this.getParams(id),
                move: (id: string, t: Partial<FTransform>) => this.setTransform(id, t),
                scale: (id: string, unitsPerMetre: number) => this.setScale(id, unitsPerMetre),
                remove: (id: string) => this.remove(id),
                list: () => this.list(),
                types: () => foliageTypeNames(),
                frame: (id: string) => this.frame(id),
                restore: () => this.restoreFromSave(),
                clear: () => this.clear(),
                manager: this,
            };
        }
        this.scene3d.addThinWrapperTransformSync((c) => {
            const rec = this._items.get(c.id);
            if (!rec) return;
            rec.transform = { x: c.x, y: c.y, z: c.z, rx: c.rotationX, ry: c.rotationY, rz: c.rotation };
            if (c.scaleX > 0) rec.scale = c.scaleX;
            this._stamp(rec);
        });
    }

    create(partial: Partial<FoliageParams> = {}, transform: Partial<FTransform> = {}, opts: { scale?: number; frame?: boolean } = {}): { id: string; meta: FoliageMeta } {
        const params = resolveFoliageParams(coerceColorKeys(partial, FOLIAGE_COLOR_KEYS));
        const container = this.scene3d.createCityContainer(`${cap(params.type)} ${++this._counter}`);
        const t: FTransform = { ...IDENTITY_T, ...transform };
        const rec: FoliageRec = { container, group: null, params, transform: t, scale: opts.scale ?? 1 / DEFAULT_METERS_PER_UNIT, meta: null };
        this._items.set(container.id, rec);
        this._rebuild(rec);
        this.scene3d.setGroupTransform(container, { ...t, s: rec.scale });
        if (opts.frame !== false) this.scene3d.frameGroup(container);
        return { id: container.id, meta: rec.meta! };
    }

    setParams(id: string, partial: Partial<FoliageParams>): boolean {
        const rec = this._items.get(id);
        if (!rec) return false;
        rec.params = { ...rec.params, ...coerceColorKeys(partial, FOLIAGE_COLOR_KEYS) };
        this._rebuild(rec);
        return true;
    }

    getParams(id: string): FoliageParams | null { const r = this._items.get(id); return r ? { ...r.params } : null; }
    getMeta(id: string): FoliageMeta | null { return this._items.get(id)?.meta ?? null; }
    isFoliage(id: string): boolean { return this._items.has(id); }
    frame(id: string): boolean { const r = this._items.get(id); return r ? this.scene3d.frameGroup(r.container) : false; }

    /** Model↔real scale info for the host UI (same scale system as buildings). */
    getScaleInfo(id: string): { scale: number; metersPerUnit: number; realHeightM: number; displayHeightUnits: number } | null {
        const rec = this._items.get(id);
        if (!rec) return null;
        const h = rec.meta?.height ?? 0;
        return { scale: rec.scale, metersPerUnit: 1 / rec.scale, realHeightM: h, displayHeightUnits: h * rec.scale };
    }

    setTransform(id: string, t: Partial<FTransform>): boolean {
        const rec = this._items.get(id);
        if (!rec) return false;
        rec.transform = { ...rec.transform, ...t };
        this.scene3d.setGroupTransform(rec.container, { ...rec.transform, s: rec.scale });
        this._stamp(rec);
        return true;
    }
    setScale(id: string, unitsPerMetre: number): boolean {
        const rec = this._items.get(id);
        if (!rec || !(unitsPerMetre > 0)) return false;
        rec.scale = unitsPerMetre;
        this.scene3d.setGroupTransform(rec.container, { s: rec.scale });
        this._stamp(rec);
        return true;
    }

    remove(id: string): boolean {
        const rec = this._items.get(id);
        if (!rec) return false;
        if (rec.group) this.scene3d.removeFlatColorMeshGroup(rec.group);
        this.scene3d.removeFlatColorMeshGroup(rec.container);
        this._items.delete(id);
        return true;
    }

    list(): { id: string; name: string; type: FoliageParams['type'] }[] {
        return [...this._items.values()].map(r => ({ id: r.container.id, name: r.container.name ?? '', type: r.params.type }));
    }

    /** Regenerate every freestanding foliage from a loaded save's markers. Host calls this after document load. */
    restoreFromSave(): number {
        let n = 0;
        for (const child of this.scene3d.getRootMeshGroups()) {
            const wp = child.worldParams as FoliageMarker | null;
            if (!wp || wp.kind !== 'foliage' || !wp.params) continue;
            if (this._items.has(child.id)) continue;
            child.thinWrapper = true; child.documentSkipChildren = true;
            const rec: FoliageRec = { container: child, group: null, params: resolveFoliageParams(coerceColorKeys(wp.params, FOLIAGE_COLOR_KEYS)), transform: { ...IDENTITY_T, ...(wp.transform ?? {}) }, scale: wp.scale && wp.scale > 0 ? wp.scale : 1 / DEFAULT_METERS_PER_UNIT, meta: null };
            this._items.set(child.id, rec);
            this._rebuild(rec);
            this.scene3d.setGroupTransform(child, { ...rec.transform, s: rec.scale });
            n++;
        }
        this._counter = Math.max(this._counter, this._items.size);
        return n;
    }

    clear(): void { for (const id of [...this._items.keys()]) this.remove(id); this._counter = 0; }
    get count(): number { return this._items.size; }
    typeNames(): string[] { return foliageTypeNames(); }

    private _stamp(rec: FoliageRec): void {
        rec.container.worldParams = { kind: 'foliage', params: rec.params, transform: rec.transform, scale: rec.scale } satisfies FoliageMarker;
    }
    private _rebuild(rec: FoliageRec): void {
        const { layers, meta } = buildFoliage(rec.params);
        if (rec.group) { this.scene3d.removeFlatColorMeshGroup(rec.group); rec.group = null; }
        rec.group = this.scene3d.addFlatColorMeshGroup(`Foliage Mesh ${rec.container.id}`, layers, false, rec.container);
        rec.meta = meta;
        this._stamp(rec);
        this.scene3d.cacheGroupBounds(rec.container);
    }
}
