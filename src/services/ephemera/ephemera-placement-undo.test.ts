/**
 * UI review 2026-10-07 §2b — ephemera place / delete / edit / canvas move / rasterize are each ONE step on the 2D
 * object undo stack, and undo / redo round-trip them exactly. Real EphemeraService + VectorObjectUndo; the paint
 * layer's raster history is a small fake with the same entry-token semantics as RasterSnapshotManager.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EphemeraService } from './ephemera-service';
import { VectorObjectUndo } from '../vector-object-undo';
import {
    recordPlacementAdded, deletePlacementUndoable, editPlacementUndoable, recordPlacementGeometry, placementGeometry,
    rasterizePlacementsUndoable, type EphemeraUndoDeps, type RasterizeTarget,
} from './ephemera-placement-undo';

const L = 'vec-1';
const TYPE = 'barcode:code128';

let ephemera: EphemeraService;
let undo: VectorObjectUndo;
let changes: string[];
let deps: EphemeraUndoDeps;

beforeEach(() => {
    ephemera = new EphemeraService();
    undo = new VectorObjectUndo({ emitChanged: () => {}, requestRender: () => {} });
    changes = [];
    deps = { store: ephemera, undo, changed: (id) => changes.push(id) };
});

function place(x = 0): string {
    const p = ephemera.addPlacement(L, TYPE, ephemera.getDefaultParams(TYPE), x, 0, 0.5, 0.25)!;
    recordPlacementAdded(deps, L, p);
    return p.id;
}
const ids = (): string[] => ephemera.getPlacementsForLayer(L).map(p => p.id);

describe('ephemera placement undo', () => {
    it('place is one step: undo removes the placement, redo puts the same object back', () => {
        const a = place(0);
        const obj = ephemera.getPlacementsForLayer(L)[0];
        expect(undo.undoDescription).toBe('Place ephemera');
        expect(undo.undo()).toBe(true);
        expect(ids()).toEqual([]);
        expect(undo.redo()).toBe(true);
        expect(ids()).toEqual([a]);
        expect(ephemera.getPlacementsForLayer(L)[0]).toBe(obj);
        expect(changes.every(c => c === L)).toBe(true);
    });

    it('delete restores the placement at its old index (draw order kept)', () => {
        const a = place(0), b = place(1), c = place(2);
        expect(deletePlacementUndoable(deps, L, b)).toBe(true);
        expect(ids()).toEqual([a, c]);
        expect(undo.undoDescription).toBe('Delete ephemera');
        undo.undo();
        expect(ids()).toEqual([a, b, c]);
        undo.redo();
        expect(ids()).toEqual([a, c]);
        expect(deletePlacementUndoable(deps, L, 'missing')).toBe(false);
    });

    it('an edit (params / blend / glow / feather) undoes to the exact old record, svg included', () => {
        const a = place();
        const p = ephemera.getPlacementsForLayer(L)[0];
        const before = JSON.parse(JSON.stringify(p));
        editPlacementUndoable(deps, L, a, () => ephemera.updatePlacement(L, a, {
            params: { ...p.params, text: 'CHANGED' }, blendMode: 'multiply',
            glow: { radius: 4, color: '#ff0000', opacity: 0.5 }, feather: { mode: 'radial', start: 0.5, end: 1 },
        }));
        const after = JSON.parse(JSON.stringify(p));
        expect(after.svg).not.toBe(before.svg);
        expect(undo.undoDescription).toBe('Edit ephemera');
        undo.undo();
        expect(JSON.parse(JSON.stringify(p))).toEqual(before);
        undo.redo();
        expect(JSON.parse(JSON.stringify(p))).toEqual(after);
    });

    it('an edit that changes nothing records nothing', () => {
        const a = place();
        const depth = undo.canUndo;
        undo.undo(); undo.redo();   // stack: [place]
        editPlacementUndoable(deps, L, a, () => ephemera.updatePlacement(L, a, { opacity: 1 }));
        expect(depth).toBe(true);
        expect(undo.undoDescription).toBe('Place ephemera');
    });

    it('a canvas gesture is one step from its first update to the pointer-up', () => {
        const a = place();
        const p = ephemera.getPlacementsForLayer(L)[0];
        const before = placementGeometry(p);
        ephemera.updatePlacement(L, a, { x: 0.1, y: 0.2 });
        ephemera.updatePlacement(L, a, { x: 0.3, y: 0.4, rotation: 15 });
        expect(recordPlacementGeometry(deps, L, a, before, 'Move ephemera')).toBe(true);
        undo.undo();
        expect(placementGeometry(p)).toEqual(before);
        undo.redo();
        expect(placementGeometry(p)).toEqual({ ...before, x: 0.3, y: 0.4, rotation: 15 });
        // A press that moved nothing records nothing
        expect(recordPlacementGeometry(deps, L, a, placementGeometry(p))).toBe(false);
    });

    it('Ctrl+Z order is LIFO across place / edit / delete', () => {
        const a = place();
        editPlacementUndoable(deps, L, a, () => ephemera.updatePlacement(L, a, { opacity: 0.5 }));
        deletePlacementUndoable(deps, L, a);
        undo.undo();   // delete
        expect(ephemera.getPlacementsForLayer(L)[0].opacity).toBe(0.5);
        undo.undo();   // edit
        expect(ephemera.getPlacementsForLayer(L)[0].opacity).toBe(1);
        undo.undo();   // place
        expect(ids()).toEqual([]);
        expect(undo.canUndo).toBe(false);
    });
});

/** A paint layer's raster history: entries are objects (identity tokens), like RasterSnapshotManager's. */
function fakeRaster() {
    const entries: object[] = [{ seed: true }];
    let index = 0;
    const log: string[] = [];
    const raster: RasterizeTarget & { paint(): void } = {
        composite: async (_id, list) => { log.push('composite:' + list.length); entries.length = index + 1; entries.push({}); index++; return true; },
        historyMark: () => ({ top: entries[index], next: entries[index + 1] ?? null }),
        undo: async () => { log.push('undo'); if (index === 0) return false; index--; return true; },
        redo: async () => { log.push('redo'); if (index + 1 >= entries.length) return false; index++; return true; },
        paint: () => { entries.length = index + 1; entries.push({}); index++; },
    };
    return { raster, log, state: () => ({ index, length: entries.length }) };
}

describe('ephemera rasterize undo', () => {
    it('burns the visible placements, removes them, and undo puts both back (pixels via the layer history)', async () => {
        const a = place(0), b = place(1);
        ephemera.updatePlacement(L, b, { visible: false });   // hidden: not burned, stays
        const { raster, log, state } = fakeRaster();
        expect(await rasterizePlacementsUndoable({ ...deps, raster }, L, 'paint-1')).toBe(true);
        expect(log).toEqual(['composite:1']);
        expect(ids()).toEqual([b]);
        expect(state().index).toBe(1);
        expect(undo.undoDescription).toBe('Rasterize ephemera');

        undo.undo();
        expect(ids()).toEqual([a, b]);
        expect(log).toEqual(['composite:1', 'undo']);
        await Promise.resolve();
        expect(state().index).toBe(0);

        undo.redo();
        expect(ids()).toEqual([b]);
        expect(log).toEqual(['composite:1', 'undo', 'redo']);
        await Promise.resolve();
        expect(state().index).toBe(1);
    });

    it('a stroke painted after the rasterize is never undone by it — only the placements come back', async () => {
        const a = place(0);
        const { raster, log, state } = fakeRaster();
        await rasterizePlacementsUndoable({ ...deps, raster }, L, 'paint-1');
        raster.paint();   // the user paints on that layer afterwards
        undo.undo();      // the 2D stack is consumed first
        expect(ids()).toEqual([a]);
        expect(log).toEqual(['composite:1']);   // no raster undo: the stroke survives
        expect(state().index).toBe(2);
    });

    it('nothing visible = nothing burned and nothing recorded; a failed composite changes nothing', async () => {
        const a = place(0);
        ephemera.updatePlacement(L, a, { visible: false });
        const { raster, log } = fakeRaster();
        expect(await rasterizePlacementsUndoable({ ...deps, raster }, L, 'paint-1')).toBe(true);
        expect(log).toEqual([]);
        expect(undo.undoDescription).toBe('Place ephemera');

        ephemera.updatePlacement(L, a, { visible: true });
        const failing: RasterizeTarget = { ...raster, composite: async () => false };
        expect(await rasterizePlacementsUndoable({ ...deps, raster: failing }, L, 'paint-1')).toBe(false);
        expect(ids()).toEqual([a]);
        expect(undo.undoDescription).toBe('Place ephemera');
    });

    it('rasterizes only the named placements when ids are given', async () => {
        const a = place(0), b = place(1);
        const { raster } = fakeRaster();
        await rasterizePlacementsUndoable({ ...deps, raster }, L, 'paint-1', [a]);
        expect(ids()).toEqual([b]);
        undo.undo();
        expect(ids()).toEqual([a, b]);
    });
});

describe('EphemeraService take / reinsert', () => {
    it('round-trips a placement object at its index and ignores a duplicate id', () => {
        const a = place(0), b = place(1);
        const taken = ephemera.takePlacement(L, a)!;
        expect(taken.index).toBe(0);
        expect(ids()).toEqual([b]);
        ephemera.reinsertPlacement(L, taken.placement, taken.index);
        ephemera.reinsertPlacement(L, taken.placement, 5);
        expect(ids()).toEqual([a, b]);
        expect(ephemera.takePlacement(L, 'nope')).toBeNull();
    });
});

describe('placementsToTexels', () => {
    it('maps world units (y up, artboard-centred) onto layer texels (y down)', async () => {
        const { placementsToTexels } = await import('./ephemera-placement-undo');
        const p = ephemera.addPlacement(L, TYPE, {}, -0.5, 0.25, 0.5, 0.25, 30)!;   // world artboard 2 × 1
        const [t] = placementsToTexels([p], { width: 2, height: 1 }, { w: 2000, h: 1000 });
        expect(t.width).toBe(500);
        expect(t.height).toBe(250);
        // centre (-0.25, 0.375) world → (750, 125) texels
        expect(t.x + t.width / 2).toBe(750);
        expect(t.y + t.height / 2).toBe(125);
        expect(t.rotation).toBe(-30);
        expect(p.x).toBe(-0.5);   // the source record is untouched
        const [tiny] = placementsToTexels([{ ...p, width: 0.0001, height: 0.0001 }], { width: 2, height: 1 }, { w: 2000, h: 1000 });
        expect(tiny.width).toBe(1);
    });
});
