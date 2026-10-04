import { describe, it, expect } from 'vitest';
import { applyObjectStyle, mergeObjectStyle, patchClearsField, sanitizeObjectStyle, neutralizeClearedFields, isEmptyStyle } from './object-style';
import { VendingManager } from './vending-manager';
import { BlockManager } from './block-manager';
import type { Scene3DManager } from './scene3d-manager';
import type { Node } from '../../scene-graph/shapes/base/node';

// Environment styling (2026-09-29): regenerated objects (city / blocks / creator objects) keep a persisted look.

type M = { material: Record<string, unknown>; children: unknown[]; isFaceDecal?: boolean; gpuDirty?: boolean; materialDirty?: boolean };
const mesh = (mat: Record<string, unknown> = {}, extra: Partial<M> = {}): M => ({ material: { renderStyle: 'default', ...mat }, children: [], ...extra });
const group = (...children: unknown[]) => ({ children }) as unknown as Node;

describe('object style — pure helpers', () => {
    it('merge sets, null clears, undefined leaves alone', () => {
        const a = mergeObjectStyle(undefined, { renderStyle: 'cel', toonShadow: true });
        expect(a).toEqual({ renderStyle: 'cel', toonShadow: true });
        expect(mergeObjectStyle(a, { toonShadow: null })).toEqual({ renderStyle: 'cel' });
        expect(mergeObjectStyle(a, { rimLight: true })).toEqual({ renderStyle: 'cel', toonShadow: true, rimLight: true });
        expect(patchClearsField(a, { toonShadow: null })).toBe(true);
        expect(patchClearsField(a, { rimLight: null })).toBe(false);   // wasn't set → nothing to rebuild
        expect(isEmptyStyle({})).toBe(true);
    });
    it('sanitize keeps only valid fields (old / foreign markers load safely)', () => {
        expect(sanitizeObjectStyle({ renderStyle: 'cel', toonShadow: 'yes', junk: 1 })).toEqual({ renderStyle: 'cel' });
        expect(sanitizeObjectStyle({ renderStyle: 'unlit' })).toBeUndefined();
        expect(sanitizeObjectStyle(null)).toBeUndefined();
    });
    it('neutralize gives clearing values for fields the patch clears', () => {
        expect(neutralizeClearedFields({ renderStyle: 'cel', toonShadow: true }, { renderStyle: null, toonShadow: null, rimLight: null }))
            .toEqual({ renderStyle: 'default', toonShadow: false });
    });
    it('applies recursively, skipping unlit materials and face decals', () => {
        const a = mesh(), b = mesh(), unlit = mesh({ renderStyle: 'unlit' }), decal = mesh({}, { isFaceDecal: true });
        const n = applyObjectStyle(group(a, group(b, unlit), decal), { renderStyle: 'cel', toonShadow: true, rimLight: true });
        expect(n).toBe(2);
        for (const m of [a, b]) { expect(m.material).toMatchObject({ renderStyle: 'cel', toonShadow: true, rimEnabled: true }); expect(m.materialDirty).toBe(true); }
        expect(unlit.material.renderStyle).toBe('unlit');
        expect(decal.material.renderStyle).toBe('default');
    });
});

/** A fake scene whose mesh groups hold one mesh per generated layer (so styles are observable). */
function fakeScene() {
    let seq = 0;
    const roots: Record<string, unknown>[] = [];
    const node = (name: string, children: unknown[] = []) => ({ id: `n${++seq}`, name, worldParams: null as unknown, thinWrapper: false, documentSkipChildren: false, x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotation: 0, scaleX: 1, children });
    return {
        roots,
        createCityContainer: (name: string) => { const n = node(name); roots.push(n); return n; },
        addFlatColorMeshGroup: (name: string, layers: unknown[], _silent?: boolean, parent?: { children: unknown[] }) => {
            const g = node(name, layers.map(() => mesh({ renderStyle: 'default' })));
            parent?.children.push(g);
            return g;
        },
        createChildGroup: (parent: { children: unknown[] }, name: string) => { const g = node(name); parent.children.push(g); return g; },
        removeFlatColorMeshGroup: () => {},
        setGroupTransform: () => {}, frameGroup: () => true, cacheGroupBounds: () => {},
        getRootMeshGroups: () => [...roots], addThinWrapperTransformSync: () => {}, requestRender3D: () => {},
        addExplicitArrayInstances: () => {},
    };
}
const meshesOf = (g: { children: unknown[] }): M[] => g.children.flatMap((c) => ((c as M).material ? [c as M] : meshesOf(c as { children: unknown[] })));
type Container = { worldParams: { style?: unknown }; children: { children: unknown[] }[] };

describe('creator objects keep their style across rebuilds + reloads', () => {
    it('setStyle applies, persists in the marker, survives a param rebuild and a save → load', () => {
        const fs = fakeScene(), mgr = new VendingManager(fs as unknown as Scene3DManager);
        const { id } = mgr.create({ brand: 0 });
        expect(mgr.setStyle(id, { renderStyle: 'cel', toonShadow: true })).toBe(true);
        const container = fs.roots[0] as unknown as Container;
        expect(container.worldParams.style).toEqual({ renderStyle: 'cel', toonShadow: true });
        mgr.setParams(id, { shelves: 2 });   // regenerate → new meshes
        const latest = container.children[container.children.length - 1];
        expect(meshesOf(latest).length).toBeGreaterThan(0);
        for (const m of meshesOf(latest)) expect(m.material.renderStyle).toBe('cel');
        // reload into a fresh manager
        const fs2 = fakeScene(), mgr2 = new VendingManager(fs2 as unknown as Scene3DManager);
        fs2.roots.push({ id: 'r1', name: 'r', worldParams: container.worldParams, thinWrapper: false, documentSkipChildren: false, x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotation: 0, scaleX: 1, children: [] });
        expect(mgr2.restoreFromSave()).toBe(1);
        expect(mgr2.getStyle('r1')).toEqual({ renderStyle: 'cel', toonShadow: true });
        const r = fs2.roots[0] as unknown as Container;
        for (const m of meshesOf(r.children[0])) expect(m.material.renderStyle).toBe('cel');
    });
    it('new objects start from the Environment default; clearing a field rebuilds to the generator look', () => {
        const fs = fakeScene(), mgr = new VendingManager(fs as unknown as Scene3DManager);
        mgr.defaultStyle = () => ({ renderStyle: 'cel-hd' });
        const { id } = mgr.create({});
        expect(mgr.getStyle(id)).toEqual({ renderStyle: 'cel-hd' });
        mgr.setStyle(id, { renderStyle: null });
        expect(mgr.getStyle(id)).toEqual({});
        const container = fs.roots[0] as unknown as Container;
        expect(container.worldParams.style).toBeUndefined();
        for (const m of meshesOf(container.children[container.children.length - 1])) expect(m.material.renderStyle).toBe('default');
    });
});

describe('blocks keep their style too', () => {
    it('block setStyle persists in the block marker + re-applies on rebuild', () => {
        const fs = fakeScene(), blocks = new BlockManager(fs as unknown as Scene3DManager);
        const id = blocks.create({}, { starter: 2 });
        blocks.setStyle(id, { renderStyle: 'cel', rimLight: true });
        const c = fs.roots[0] as unknown as Container;
        expect(c.worldParams.style).toEqual({ renderStyle: 'cel', rimLight: true });
        blocks.addBuilding(id, { archetype: 'brick-townhouse' });   // rebuild
        expect(blocks.getStyle(id)).toEqual({ renderStyle: 'cel', rimLight: true });
        const latest = c.children[c.children.length - 1];
        for (const m of meshesOf(latest)) expect(m.material.renderStyle).toBe('cel');
        expect(blocks.ids()).toEqual([id]);
    });
    it('new blocks start from the Environment default', () => {
        const fs = fakeScene(), blocks = new BlockManager(fs as unknown as Scene3DManager);
        blocks.defaultStyle = () => ({ toonShadow: true });
        const id = blocks.create({}, { starter: 1 });
        expect(blocks.getStyle(id)).toEqual({ toonShadow: true });
    });
});
