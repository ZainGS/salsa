// ─────────────────────────────────────────────────────────────────────────────
// FoliageManager — lifecycle for FREESTANDING procedural foliage (Foliage Creator, spec item 3).
// A thin subclass of ProceduralObjectManager: the base holds the identical create/transform/scale/remove/
// restore/persist lifecycle it once shared (by copy-paste) with BuildingManager; this file supplies only
// what differs — the buildFoliage generator, the 'foliage' marker kind, foliage colour-key coercion, the
// name, the dev harness, and foliage-specific reads (type list / scale info). Building-ATTACHED foliage
// (spec items 2/4) is separate — it lives in a building's params.
// ─────────────────────────────────────────────────────────────────────────────

import { buildFoliage, resolveFoliageParams, foliageTypeNames } from '../../world/foliage';
import type { FoliageParams, FoliageMeta } from '../../world/foliage';
import { coerceColorKeys } from './color-util';
import type { Scene3DManager } from './scene3d-manager';
import { ProceduralObjectManager, type ProcTransform } from './procedural-object-manager';

const FOLIAGE_COLOR_KEYS = ['foliageColor', 'tipColor', 'bloomColor', 'potColor', 'trunkColor', 'petalColor', 'centerColor', 'stemColor', 'soilColor'];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export class FoliageManager extends ProceduralObjectManager<FoliageParams, FoliageMeta> {
    protected readonly kind = 'foliage';
    protected readonly meshLabel = 'Foliage Mesh';
    protected build(params: FoliageParams): { layers: ReturnType<typeof buildFoliage>['layers']; meta: FoliageMeta } { return buildFoliage(params); }
    protected resolveParams(partial: unknown): FoliageParams { return resolveFoliageParams(coerceColorKeys(partial as Record<string, unknown>, FOLIAGE_COLOR_KEYS)); }
    protected makeName(params: FoliageParams): string { return `${cap(params.type)} ${++this._counter}`; }

    constructor(scene3d: Scene3DManager) {
        super(scene3d);
        if (typeof window !== 'undefined') {
            (window as unknown as { salsaFoliage?: unknown }).salsaFoliage = {
                add: (p: Partial<FoliageParams> = {}, t: Partial<ProcTransform> = {}) => this.create(p, t).id,
                type: (type: FoliageParams['type'], t: Partial<ProcTransform> = {}) => this.create({ type }, t).id,
                set: (id: string, p: Partial<FoliageParams>) => this.setParams(id, p),
                get: (id: string) => this.getParams(id),
                move: (id: string, t: Partial<ProcTransform>) => this.setTransform(id, t),
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
    }

    create(partial: Partial<FoliageParams> = {}, transform: Partial<ProcTransform> = {}, opts: { scale?: number; frame?: boolean } = {}): { id: string; meta: FoliageMeta } {
        const rec = this._create(partial, transform, opts);
        return { id: rec.container.id, meta: rec.meta! };
    }

    setParams(id: string, partial: Partial<FoliageParams>): boolean {
        const rec = this._items.get(id);
        if (!rec) return false;
        rec.params = { ...rec.params, ...coerceColorKeys(partial, FOLIAGE_COLOR_KEYS) };
        this._rebuild(rec);
        return true;
    }

    /** Domain-named alias for {@link isManaged}. */
    isFoliage(id: string): boolean { return this.isManaged(id); }

    /** Model↔real scale info for the host UI (same scale system as buildings). */
    getScaleInfo(id: string): { scale: number; metersPerUnit: number; realHeightM: number; displayHeightUnits: number } | null {
        const rec = this._items.get(id);
        if (!rec) return null;
        const h = rec.meta?.height ?? 0;
        return { scale: rec.scale, metersPerUnit: 1 / rec.scale, realHeightM: h, displayHeightUnits: h * rec.scale };
    }

    list(): { id: string; name: string; type: FoliageParams['type'] }[] {
        return [...this._items.values()].map(r => ({ id: r.container.id, name: r.container.name ?? '', type: r.params.type }));
    }

    typeNames(): string[] { return foliageTypeNames(); }
}
