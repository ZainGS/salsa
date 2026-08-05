// ─────────────────────────────────────────────────────────────────────────────
// VendingManager — lifecycle for a standalone VENDING MACHINE as an editable procedural object (the second
// member of the procedural-creation family, after packaging — docs/specs/creator-modes.md §5). A thin
// subclass of ProceduralObjectManager: the base supplies the identical create/orbit-frame/transform/scale/
// remove/restore/persist/gizmo-sync lifecycle already proven by Building + Foliage; this file supplies only
// the vending generator, the 'vending' marker kind, and the dev harness.
//
// This is deliberately the SECOND lifecycle member so the shared CreatorStage (isolate/flatten/studio/paint)
// can later be extracted from packaging AND vending together rather than guessed from packaging alone — the
// sequencing decision recorded in creator-modes.md §5.3. The generator is authored 1:1 in metres, so the
// base's display-scale (1 world unit = 10 m) applies exactly as it does to a building or a tree.
// ─────────────────────────────────────────────────────────────────────────────

import { buildVendingMachine, resolveVendingParams, VENDING_BRANDS } from '../../world/vending';
import type { VendingParams, VendingMeta } from '../../world/vending';
import type { Scene3DManager } from './scene3d-manager';
import { ProceduralObjectManager, type ProcTransform } from './procedural-object-manager';

export class VendingManager extends ProceduralObjectManager<VendingParams, VendingMeta> {
    protected readonly kind = 'vending';
    protected readonly meshLabel = 'Vending Mesh';
    protected build(params: VendingParams): { layers: ReturnType<typeof buildVendingMachine>['layers']; meta: VendingMeta } { return buildVendingMachine(params); }
    protected resolveParams(partial: unknown): VendingParams { return resolveVendingParams(partial as Partial<VendingParams>); }
    protected makeName(_params: VendingParams): string { return `Vending ${++this._counter}`; }

    constructor(scene3d: Scene3DManager) {
        super(scene3d);
        // DEV console harness (before Frogmarks has a Vending Creator panel):
        //   salsaVend.add({ brand: 1 })            → create one, returns its node id
        //   salsaVend.set(id, { productCols: 3 })  → live-edit
        //   salsaVend.brands() / .list() / .remove(id)
        if (typeof window !== 'undefined') {
            (window as unknown as { salsaVend?: unknown }).salsaVend = {
                add: (p: Partial<VendingParams> = {}, t: Partial<ProcTransform> = {}) => this.create(p, t).id,
                set: (id: string, p: Partial<VendingParams>) => this.setParams(id, p),
                get: (id: string) => this.getParams(id),
                move: (id: string, t: Partial<ProcTransform>) => this.setTransform(id, t),
                scale: (id: string, unitsPerMetre: number) => this.setScale(id, unitsPerMetre),
                remove: (id: string) => this.remove(id),
                list: () => this.list(),
                brands: () => VENDING_BRANDS.map((b) => b.name),
                frame: (id: string) => this.frame(id),
                restore: () => this.restoreFromSave(),
                clear: () => this.clear(),
                manager: this,
            };
        }
    }

    create(partial: Partial<VendingParams> = {}, transform: Partial<ProcTransform> = {}, opts: { scale?: number; frame?: boolean } = {}): { id: string; meta: VendingMeta } {
        const rec = this._create(partial, transform, opts);
        return { id: rec.container.id, meta: rec.meta! };
    }

    // setParams comes from the base (merge → resolveVendingParams → rebuild in place) — identical to what
    // this class used to hand-roll, so it's dropped here.

    /** Domain-named alias for {@link isManaged}. */
    isVending(id: string): boolean { return this.isManaged(id); }

    list(): { id: string; name: string; brand: string }[] {
        return [...this._items.values()].map(r => ({ id: r.container.id, name: r.container.name ?? '', brand: VENDING_BRANDS[r.params.brand]?.name ?? '' }));
    }

    brandNames(): string[] { return VENDING_BRANDS.map((b) => b.name); }
}
