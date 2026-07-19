// ─────────────────────────────────────────────────────────────────────────────
// BlockManager — a NEIGHBORHOOD BLOCK: many procedural buildings authored + saved + moved as ONE unit, with their
// repeated detail (juliet balconies / window trim) collapsed to a handful of GPU-instanced ArrayGroups across the
// WHOLE block (Tier-2 of the instancing plan — docs/specs/instancing-blocks.md). This is the standalone extraction
// of the city's Region→District→Block→Lot level, and the node-efficient owner of cross-building instancing.
//
// A Block is a thin-wrapper MeshGroup3D container at the scene root (one outliner item, moved/scaled as a unit) whose
// worldParams is a lightweight params-only marker (kind === 'block') → tiny save; load regenerates via restoreFromSave.
// Buildings live INSIDE the block in block-local METRES (position + yaw); the block container applies the display scale.
//
// The collector (_rebuild): build each building → split layers into NON-instanced (walls/roof/etc. → a per-building
// sub-group at its placement) and INSTANCED (juliet/trim → transform every instance into block-local metres, group by
// (geometry-key + colour), and emit ONE source mesh + ONE explicit ArrayGroup per group). So a whole neighborhood's
// balconies draw from a few geometries + a few nodes instead of thousands of meshes.
// ─────────────────────────────────────────────────────────────────────────────

import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { buildBuilding, resolveBuildingParams } from '../../world/building';
import type { BuildingParams } from '../../world/building';
import type { LayoutPreviewLayer } from '../../world/types';
import type { Scene3DManager } from './scene3d-manager';
import { DEFAULT_METERS_PER_UNIT } from './building-manager';

/** Block-local placement of one building (METRES): ground position + yaw. */
type Placement = { x: number; y: number; z: number; ry: number };
const IDENTITY_P: Placement = { x: 0, y: 0, z: 0, ry: 0 };

interface BlockBuildingSpec { params: BuildingParams; placement: Placement; }

interface BlockRec {
    container: MeshGroup3D;         // the thin-wrapper (one outliner item)
    group: MeshGroup3D | null;      // single inner group holding ALL block geometry (swapped on regen)
    buildings: BlockBuildingSpec[];
    transform: Placement;           // the block's own placement (world)
    scale: number;                  // world units per metre (display scale of the whole block)
}

/** Persisted marker (container.worldParams) — distinct `kind` so no other manager adopts a block. */
interface BlockMarker {
    kind: 'block';
    buildings: { params: Partial<BuildingParams>; placement: Placement }[];
    transform: Placement;
    scale?: number;
}

export class BlockManager {
    private _blocks = new Map<string, BlockRec>();
    private _counter = 0;

    constructor(private readonly scene3d: Scene3DManager) {
        // DEV console harness (before Frogmarks has a Block UI):
        //   const b = salsaBlock.create()
        //   salsaBlock.add(b, { archetype:'brick-townhouse' }, { x: 0,  z: 0 })
        //   salsaBlock.add(b, { archetype:'brick-townhouse' }, { x: 16, z: 0, ry: 0 })
        //   salsaBlock.stats(b)   → node/instance/geometry counts
        if (typeof window !== 'undefined') {
            (window as unknown as { salsaBlock?: unknown }).salsaBlock = {
                create: (t: Partial<Placement> = {}, opts: { starter?: boolean | number } = {}) => this.create(t, opts),
                add: (id: string, params: Partial<BuildingParams>, placement: Partial<Placement> = {}) => this.addBuilding(id, params, placement),
                move: (id: string, t: Partial<Placement>) => this.setTransform(id, t),
                scale: (id: string, unitsPerMetre: number) => this.setScale(id, unitsPerMetre),
                remove: (id: string) => this.remove(id),
                removeBuilding: (id: string, index: number) => this.removeBuilding(id, index),
                list: () => this.list(),
                stats: (id: string) => this.stats(id),
                restore: () => this.restoreFromSave(),
                clear: () => this.clear(),
                manager: this,
            };
        }

        // Persist gizmo moves of a whole block.
        this.scene3d.addThinWrapperTransformSync((c) => {
            const rec = this._blocks.get(c.id);
            if (!rec) return;
            rec.transform = { x: c.x, y: c.y, z: c.z, ry: c.rotationY };
            if (c.scaleX > 0) rec.scale = c.scaleX;
            this._stamp(rec);
        });
    }

    /** Create a block. By default it's SEEDED with a short starter row of buildings so "Add Block" shows something
     *  real (not a confusing empty gizmo) + immediately demonstrates the cross-building instancing; pass
     *  `{ starter: false }` for an empty block, or `{ starter: N }` for N buildings. Auto-frames when non-empty. */
    create(transform: Partial<Placement> = {}, opts: { starter?: boolean | number } = {}): string {
        const container = this.scene3d.createCityContainer(`Block ${++this._counter}`);
        const rec: BlockRec = { container, group: null, buildings: [], transform: { ...IDENTITY_P, ...transform }, scale: 1 / DEFAULT_METERS_PER_UNIT };
        this._blocks.set(container.id, rec);
        const n = opts.starter === false ? 0 : opts.starter === true || opts.starter === undefined ? 3 : Math.max(0, Math.floor(opts.starter));
        let x = 0;   // place adjacent by WIDTH (+ a small alley), not a fixed gap — narrow buildings shouldn't sit far apart
        for (let i = 0; i < n; i++) {
            const params = resolveBuildingParams({ archetype: 'brick-townhouse', julietBalconies: true, windowTrim: true, seed: i + 1 });
            rec.buildings.push({ params, placement: { x, y: 0, z: 0, ry: 0 } });
            x += params.width + 1;   // footprint is centred at the placement, so step by full width + 1 m
        }
        if (n > 0) { this._rebuild(rec); this.scene3d.frameGroup(container); }
        else { this.scene3d.setGroupTransform(container, { ...rec.transform, s: rec.scale }); this._stamp(rec); }
        return container.id;
    }

    isBlock(id: string): boolean { return this._blocks.has(id); }

    /** Add a building to a block at a block-local placement (METRES). Returns its index, or -1 if the block is unknown.
     *  Blocks are the detailed-building showcase, so `julietBalconies` + `windowTrim` default ON (the caller can turn
     *  them off) — otherwise the block draws plain shells with nothing to instance. */
    addBuilding(id: string, params: Partial<BuildingParams>, placement: Partial<Placement> = {}): number {
        const rec = this._blocks.get(id);
        if (!rec) return -1;
        rec.buildings.push({ params: resolveBuildingParams({ julietBalconies: true, windowTrim: true, ...params }), placement: { ...IDENTITY_P, ...placement } });
        this._rebuild(rec);
        return rec.buildings.length - 1;
    }

    /** Move/rotate one building within the block (block-local metres). */
    setBuildingPlacement(id: string, index: number, placement: Partial<Placement>): boolean {
        const rec = this._blocks.get(id);
        if (!rec || index < 0 || index >= rec.buildings.length) return false;
        rec.buildings[index].placement = { ...rec.buildings[index].placement, ...placement };
        this._rebuild(rec);
        return true;
    }

    /** Live-edit one building's params within the block. */
    setBuildingParams(id: string, index: number, partial: Partial<BuildingParams>): boolean {
        const rec = this._blocks.get(id);
        if (!rec || index < 0 || index >= rec.buildings.length) return false;
        rec.buildings[index].params = { ...rec.buildings[index].params, ...partial };
        this._rebuild(rec);
        return true;
    }

    /** Read one block-building's full params (to SEED an edit panel — same rich panel as a standalone building). */
    getBuildingParams(id: string, index: number): BuildingParams | null {
        const rec = this._blocks.get(id);
        if (!rec || index < 0 || index >= rec.buildings.length) return null;
        return { ...rec.buildings[index].params };
    }

    /** List a block's buildings (index + archetype/category + placement) — for the host's per-building list/editor. */
    getBuildings(id: string): { index: number; archetype: string; category: BuildingParams['category']; placement: Placement }[] {
        const rec = this._blocks.get(id);
        if (!rec) return [];
        return rec.buildings.map((b, index) => ({ index, archetype: b.params.archetype, category: b.params.category, placement: { ...b.placement } }));
    }

    removeBuilding(id: string, index: number): boolean {
        const rec = this._blocks.get(id);
        if (!rec || index < 0 || index >= rec.buildings.length) return false;
        rec.buildings.splice(index, 1);
        this._rebuild(rec);
        return true;
    }

    /** Move/rotate the whole block. */
    setTransform(id: string, t: Partial<Placement>): boolean {
        const rec = this._blocks.get(id);
        if (!rec) return false;
        rec.transform = { ...rec.transform, ...t };
        this.scene3d.setGroupTransform(rec.container, { ...rec.transform, s: rec.scale });
        this._stamp(rec);
        return true;
    }

    /** Set the whole block's display scale (world units per metre). Regenerate-free (transform only). */
    setScale(id: string, unitsPerMetre: number): boolean {
        const rec = this._blocks.get(id);
        if (!rec || !(unitsPerMetre > 0)) return false;
        rec.scale = unitsPerMetre;
        this.scene3d.setGroupTransform(rec.container, { s: rec.scale });
        this._stamp(rec);
        return true;
    }

    remove(id: string): boolean {
        const rec = this._blocks.get(id);
        if (!rec) return false;
        if (rec.group) this.scene3d.removeFlatColorMeshGroup(rec.group);
        this.scene3d.removeFlatColorMeshGroup(rec.container);
        this._blocks.delete(id);
        return true;
    }

    list(): { id: string; name: string; buildings: number }[] {
        return [...this._blocks.values()].map(r => ({ id: r.container.id, name: r.container.name ?? '', buildings: r.buildings.length }));
    }

    /** Node/instance/geometry breakdown for a block (proves the instancing win). */
    stats(id: string): { buildings: number; distinctInstancedGeometries: number; totalInstances: number } | null {
        const rec = this._blocks.get(id);
        if (!rec) return null;
        const keys = new Set<string>();
        let total = 0;
        for (const b of rec.buildings) {
            for (const L of buildBuilding(b.params).layers) {
                if (!L.instances) continue;
                keys.add(`${L.name}|${L.instanceKey}|${L.color.join(',')}`);
                total += L.instances.length;
            }
        }
        return { buildings: rec.buildings.length, distinctInstancedGeometries: keys.size, totalInstances: total };
    }

    /** Regenerate every block whose lightweight marker was restored from a loaded save. Host calls on doc load. */
    restoreFromSave(): number {
        let n = 0;
        for (const child of this.scene3d.getRootMeshGroups()) {
            const wp = child.worldParams as BlockMarker | null;
            if (!wp || wp.kind !== 'block' || !Array.isArray(wp.buildings)) continue;
            if (this._blocks.has(child.id)) continue;
            child.thinWrapper = true;
            child.documentSkipChildren = true;
            const rec: BlockRec = {
                container: child, group: null,
                buildings: wp.buildings.map(b => ({ params: resolveBuildingParams(b.params), placement: { ...IDENTITY_P, ...b.placement } })),
                transform: { ...IDENTITY_P, ...(wp.transform ?? {}) },
                scale: wp.scale && wp.scale > 0 ? wp.scale : 1 / DEFAULT_METERS_PER_UNIT,
            };
            this._blocks.set(child.id, rec);
            this._rebuild(rec);
            this.scene3d.setGroupTransform(child, { ...rec.transform, s: rec.scale });
            n++;
        }
        this._counter = Math.max(this._counter, this._blocks.size);
        return n;
    }

    clear(): void { for (const id of [...this._blocks.keys()]) this.remove(id); this._counter = 0; }
    get count(): number { return this._blocks.size; }

    // ── internal ──
    private _stamp(rec: BlockRec): void {
        rec.container.worldParams = {
            kind: 'block',
            buildings: rec.buildings.map(b => ({ params: b.params, placement: b.placement })),
            transform: rec.transform,
            scale: rec.scale,
        } satisfies BlockMarker;
    }

    /** Rotate a building-local (x,z) into block-local space by the building's placement yaw + position (metres). */
    private _toBlock(p: Placement, x: number, z: number): [number, number] {
        const c = Math.cos(p.ry), s = Math.sin(p.ry);
        return [x * c + z * s + p.x, -x * s + z * c + p.z];   // matches xformGeo's rotateY convention
    }

    private _rebuild(rec: BlockRec): void {
        if (rec.group) { this.scene3d.removeFlatColorMeshGroup(rec.group); rec.group = null; }
        const group = this.scene3d.createChildGroup(rec.container, `Block Mesh ${rec.container.id}`);
        rec.group = group;

        // Collect INSTANCED detail across all buildings (block-local metres), grouped by geometry-key + colour
        // (ArrayGroup instances share the source material, so colour is part of the key).
        type Grp = { name: string; geometry: LayoutPreviewLayer['geometry']; color: [number, number, number]; emissive?: number; pattern?: LayoutPreviewLayer['pattern']; instanceKey: string; transforms: { x: number; y: number; z: number; ry: number }[] };
        const groups = new Map<string, Grp>();

        for (const b of rec.buildings) {
            const { layers } = buildBuilding(b.params);
            const nonInst: LayoutPreviewLayer[] = [];
            for (const L of layers) {
                if (L.instances && L.instanceKey) {
                    const key = `${L.name}|${L.instanceKey}|${L.color.join(',')}`;
                    let g = groups.get(key);
                    if (!g) { g = { name: L.name, geometry: L.geometry, color: L.color, emissive: L.emissive, pattern: L.pattern, instanceKey: L.instanceKey, transforms: [] }; groups.set(key, g); }
                    for (const t of L.instances) {
                        const [bx, bz] = this._toBlock(b.placement, t.x, t.z);
                        g.transforms.push({ x: bx, y: t.y + b.placement.y, z: bz, ry: b.placement.ry + t.ry });
                    }
                } else {
                    nonInst.push(L);
                }
            }
            // Non-instanced geometry (walls/roof/doors/…) → a per-building sub-group at its block-local placement.
            if (nonInst.length) {
                const sub = this.scene3d.addFlatColorMeshGroup(`Bldg`, nonInst, true, group);
                this.scene3d.setGroupTransform(sub, { ...b.placement, s: 1 });
            }
        }

        // Emit ONE source mesh + ONE ArrayGroup per instanced group → the whole block's balconies/trim in a few nodes.
        for (const g of groups.values()) {
            this.scene3d.addExplicitArrayInstances(group, { name: g.name, geometry: g.geometry, color: g.color, emissive: g.emissive, pattern: g.pattern, transforms: g.transforms });
        }

        this.scene3d.setGroupTransform(rec.container, { ...rec.transform, s: rec.scale });
        this._stamp(rec);
        this.scene3d.cacheGroupBounds(rec.container);
    }
}
