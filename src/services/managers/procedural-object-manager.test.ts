/**
 * src/services/managers/procedural-object-manager.test.ts — characterization tests for the shared
 * procedural-object lifecycle (BuildingManager / FoliageManager after the base-class extraction).
 *
 * ★ WHY THESE EXIST. BuildingManager, FoliageManager and BlockManager had ZERO test coverage, yet they own
 * document persistence (the params-only marker + restore) and gizmo transform-sync — behaviour that only
 * shows up in the browser, exactly where this project has repeatedly shipped "green tests, broken page".
 * Extracting a base class from untested code is how a refactor silently changes behaviour. So these pin the
 * contract the base must honour: create places + frames + stamps a marker, edits regenerate in place,
 * transforms/scale persist into the marker, the gizmo-sync listener writes the marker, remove tears down
 * both groups, and restore round-trips the marker back to a live object WITHOUT one manager adopting
 * another's markers. They run against a fake scene that records the calls, with the REAL generators.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BuildingManager } from './building-manager';
import { FoliageManager } from './foliage-manager';
import { VendingManager } from './vending-manager';
import type { Scene3DManager } from './scene3d-manager';

interface FakeNode {
    id: string; name: string;
    worldParams: unknown; thinWrapper: boolean; documentSkipChildren: boolean;
    x: number; y: number; z: number; rotationX: number; rotationY: number; rotation: number; scaleX: number;
}

/** A minimal Scene3DManager stand-in: it records the calls the managers make and models just enough of the
 *  scene graph (a root list + the transform-sync callbacks) for the lifecycle to run. */
class FakeScene {
    roots: FakeNode[] = [];
    removed: FakeNode[] = [];
    framed: string[] = [];
    transforms: { id: string; t: Record<string, number> }[] = [];
    boundsCached: string[] = [];
    gridVisible = false;
    private _syncs: ((c: FakeNode) => void)[] = [];
    private _seq = 0;

    private _node(name: string): FakeNode {
        return { id: `n${++this._seq}`, name, worldParams: null, thinWrapper: false, documentSkipChildren: false,
            x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotation: 0, scaleX: 1 };
    }
    createCityContainer(name: string): FakeNode { const n = this._node(name); this.roots.push(n); return n; }
    addFlatColorMeshGroup(name: string): FakeNode { return this._node(name); }  // child group; not a root
    removeFlatColorMeshGroup(g: FakeNode): void { this.removed.push(g); const i = this.roots.indexOf(g); if (i >= 0) this.roots.splice(i, 1); }
    setGroupTransform(g: FakeNode, t: Record<string, number>): void { this.transforms.push({ id: g.id, t }); }
    frameGroup(g: FakeNode): boolean { this.framed.push(g.id); return true; }
    cacheGroupBounds(g: FakeNode): void { this.boundsCached.push(g.id); }
    getRootMeshGroups(): FakeNode[] { return [...this.roots]; }
    addThinWrapperTransformSync(cb: (c: FakeNode) => void): void { this._syncs.push(cb); }
    createChildGroup(_p: FakeNode, name: string): FakeNode { return this._node(name); }

    /** Simulate a gizmo drag: mutate a node and fire the registered sync callbacks (what the renderer does). */
    fireGizmo(node: FakeNode, delta: Partial<FakeNode>): void {
        Object.assign(node, delta);
        for (const cb of this._syncs) cb(node);
    }
    /** Simulate a document reload: drop the live managers' state but KEEP the marker on a fresh root node. */
    reloadWith(markers: unknown[]): FakeNode[] {
        this.roots = markers.map((m, i) => ({ ...this._node(`restored${i}`), worldParams: m }));
        return this.roots;
    }
}

const scene = (): { fake: FakeScene; s: Scene3DManager } => {
    const fake = new FakeScene();
    return { fake, s: fake as unknown as Scene3DManager };
};

describe('ProceduralObjectManager — shared lifecycle (via BuildingManager)', () => {
    let fake: FakeScene, mgr: BuildingManager;
    beforeEach(() => { const c = scene(); fake = c.fake; mgr = new BuildingManager(c.s); });

    it('create places a thin-wrapper, builds geometry, frames, and stamps a params marker', () => {
        const { id } = mgr.create({ archetype: 'brick-townhouse' }, { x: 3 });
        expect(mgr.isBuilding(id)).toBe(true);
        expect(mgr.count).toBe(1);
        expect(fake.framed).toContain(id);                 // auto-framed
        expect(fake.boundsCached).toContain(id);           // bounds cached after build
        const wp = fake.roots[0].worldParams as { kind: string; params: unknown; transform: { x: number } };
        expect(wp.kind).toBe('building');                  // marker discriminator
        expect(wp.transform.x).toBe(3);                    // transform captured into the marker
        expect(wp.params).toBeTruthy();
    });

    it('create can skip framing', () => {
        mgr.create({}, {}, { frame: false });
        expect(fake.framed).toEqual([]);
    });

    it('setParams regenerates in place (same id, group swapped) and an archetype switch keeps the seed', () => {
        const { id } = mgr.create({ archetype: 'brick-townhouse', seed: 42 });
        const removedBefore = fake.removed.length;
        expect(mgr.setParams(id, { archetype: 'glass-tower' })).toBe(true);
        expect(mgr.isBuilding(id)).toBe(true);                       // same node
        expect(mgr.getParams(id)!.seed).toBe(42);                    // seed preserved across style switch
        expect(mgr.getParams(id)!.archetype).toBe('glass-tower');
        expect(fake.removed.length).toBeGreaterThan(removedBefore);  // old child group torn down
    });

    it('setTransform and setScale write through to the marker (params-only persistence)', () => {
        const { id } = mgr.create({});
        mgr.setTransform(id, { x: 10, ry: 1.5 });
        mgr.setScale(id, 0.25);
        const wp = fake.roots[0].worldParams as { transform: { x: number; ry: number }; scale: number };
        expect(wp.transform.x).toBe(10);
        expect(wp.transform.ry).toBe(1.5);
        expect(wp.scale).toBe(0.25);
        expect(mgr.getScaleInfo(id)!.metersPerUnit).toBeCloseTo(4, 6);   // 1 / 0.25
    });

    it('a gizmo drag mirrors the live transform + scale into the marker', () => {
        const { id } = mgr.create({});
        fake.fireGizmo(fake.roots[0], { x: 7, rotationY: 0.5, scaleX: 0.5 });
        const wp = fake.roots[0].worldParams as { transform: { x: number; ry: number }; scale: number };
        expect(wp.transform.x).toBe(7);
        expect(wp.transform.ry).toBe(0.5);
        expect(wp.scale).toBe(0.5);
        expect(mgr.getTransform(id)!.x).toBe(7);
    });

    it('remove tears down BOTH the child group and the container, and drops it from the map', () => {
        const { id } = mgr.create({});
        expect(mgr.remove(id)).toBe(true);
        expect(mgr.isBuilding(id)).toBe(false);
        expect(mgr.count).toBe(0);
        expect(fake.roots.length).toBe(0);           // container removed from the scene root
        expect(fake.removed.length).toBe(2);         // child mesh group + container
    });

    it('restoreFromSave rebuilds from a marker and marks the node thin-wrapper + skip-children', () => {
        const { id } = mgr.create({ archetype: 'brick-townhouse', seed: 9 }, { x: 5 });
        const marker = fake.roots[0].worldParams;
        // Fresh manager + a reloaded document carrying only the marker.
        const c2 = scene(); const mgr2 = new BuildingManager(c2.s);
        c2.fake.reloadWith([marker]);
        expect(mgr2.restoreFromSave()).toBe(1);
        const rid = c2.fake.roots[0].id;
        expect(mgr2.isBuilding(rid)).toBe(true);
        expect(mgr2.getParams(rid)!.seed).toBe(9);
        expect(mgr2.getTransform(rid)!.x).toBe(5);
        expect(c2.fake.roots[0].thinWrapper).toBe(true);
        expect(c2.fake.roots[0].documentSkipChildren).toBe(true);
        expect(id).toBeTruthy();
    });

    it('restoreFromSave is idempotent and ignores already-managed nodes', () => {
        mgr.create({});
        const before = mgr.count;
        expect(mgr.restoreFromSave()).toBe(0);       // its own live node is skipped
        expect(mgr.count).toBe(before);
    });

    it('clear removes everything and resets the counter', () => {
        mgr.create({}); mgr.create({});
        expect(mgr.count).toBe(2);
        mgr.clear();
        expect(mgr.count).toBe(0);
        expect(fake.roots.length).toBe(0);
    });
});

describe('generic dispatch surface (createFromParams + base setParams)', () => {
    // These are what ShapeManager's typeId dispatcher (createCreator3D / setCreatorParams3D) calls on the
    // base, so a host can drive any creator by id without knowing its concrete manager type.
    it('createFromParams places an object from an untyped params bag and returns its id', () => {
        const c = scene(); const mgr = new VendingManager(c.s);
        const id = mgr.createFromParams({ brand: 2, productCols: 3 } as unknown);
        expect(mgr.isVending(id)).toBe(true);
        expect(mgr.getParams(id)!.brand).toBe(2);
        expect(mgr.getParams(id)!.productCols).toBe(3);
        expect(c.fake.roots[0].id).toBe(id);
    });

    it('the base setParams merges + re-resolves + regenerates in place', () => {
        const c = scene(); const mgr = new VendingManager(c.s);
        const id = mgr.createFromParams({ brand: 0 } as unknown);
        const removedBefore = c.fake.removed.length;
        expect(mgr.setParams(id, { productRows: 4 })).toBe(true);
        expect(mgr.getParams(id)!.productRows).toBe(4);
        expect(mgr.getParams(id)!.brand).toBe(0);                      // untouched keys survive the merge
        expect(c.fake.removed.length).toBeGreaterThan(removedBefore);  // regenerated in place
        expect(mgr.setParams('missing', { brand: 1 })).toBe(false);
    });
});

describe('marker isolation — a manager never adopts another owner\'s markers', () => {
    it('the building manager ignores a foliage marker and vice-versa', () => {
        // Build one of each, collect their markers, then restore into fresh managers of BOTH kinds.
        const a = scene(); const b = new BuildingManager(a.s); b.create({ archetype: 'brick-townhouse' });
        const f = scene(); const fm = new FoliageManager(f.s); fm.create({ type: 'bush' });
        const buildingMarker = a.fake.roots[0].worldParams;
        const foliageMarker = f.fake.roots[0].worldParams;

        const c = scene();
        c.fake.reloadWith([buildingMarker, foliageMarker]);
        const bm2 = new BuildingManager(c.s);
        const fm2 = new FoliageManager(c.s);
        expect(bm2.restoreFromSave()).toBe(1);   // adopts ONLY the building marker
        expect(fm2.restoreFromSave()).toBe(1);   // adopts ONLY the foliage marker
        expect(bm2.count).toBe(1);
        expect(fm2.count).toBe(1);
    });
});

describe('VendingManager — the 2nd procedural-creation member rides the same base', () => {
    let fake: FakeScene, mgr: VendingManager;
    beforeEach(() => { const c = scene(); fake = c.fake; mgr = new VendingManager(c.s); });

    it('create → live-edit params → regenerate in place, stamping a vending marker', () => {
        const { id } = mgr.create({ brand: 1 }, { x: 4 });
        expect(mgr.isVending(id)).toBe(true);
        expect((fake.roots[0].worldParams as { kind: string }).kind).toBe('vending');
        const removedBefore = fake.removed.length;
        expect(mgr.setParams(id, { productCols: 3 })).toBe(true);
        expect(mgr.getParams(id)!.productCols).toBe(3);
        expect(fake.removed.length).toBeGreaterThan(removedBefore);   // old child group swapped
    });

    it('params round-trip through a save marker into a fresh manager', () => {
        const { id } = mgr.create({ brand: 2, productRows: 3 }, { z: 6 });
        mgr.setScale(id, 0.2);
        const marker = fake.roots[0].worldParams;
        const c2 = scene(); const mgr2 = new VendingManager(c2.s);
        c2.fake.reloadWith([marker]);
        expect(mgr2.restoreFromSave()).toBe(1);
        const rid = c2.fake.roots[0].id;
        expect(mgr2.getParams(rid)!.brand).toBe(2);
        expect(mgr2.getParams(rid)!.productRows).toBe(3);
        expect(mgr2.getTransform(rid)!.z).toBe(6);
    });

    it('is ignored by the building manager and vice-versa (marker isolation across all three)', () => {
        mgr.create({ brand: 0 });
        const marker = fake.roots[0].worldParams;
        const c2 = scene(); c2.fake.reloadWith([marker]);
        const bm = new BuildingManager(c2.s);
        const vm = new VendingManager(c2.s);
        expect(bm.restoreFromSave()).toBe(0);   // building manager must NOT adopt a vending marker
        expect(vm.restoreFromSave()).toBe(1);
    });
});

describe('FoliageManager rides the same base', () => {
    let fake: FakeScene, mgr: FoliageManager;
    beforeEach(() => { const c = scene(); fake = c.fake; mgr = new FoliageManager(c.s); });

    it('create → edit → persist → restore round-trips a foliage object', () => {
        const { id } = mgr.create({ type: 'bush' }, { z: 2 });
        expect(mgr.isFoliage(id)).toBe(true);
        expect((fake.roots[0].worldParams as { kind: string }).kind).toBe('foliage');
        mgr.setScale(id, 0.2);
        expect(mgr.getScaleInfo(id)!.metersPerUnit).toBeCloseTo(5, 6);
        const marker = fake.roots[0].worldParams;

        const c2 = scene(); const mgr2 = new FoliageManager(c2.s);
        c2.fake.reloadWith([marker]);
        expect(mgr2.restoreFromSave()).toBe(1);
        expect(mgr2.getTransform(c2.fake.roots[0].id)!.z).toBe(2);
    });
});
