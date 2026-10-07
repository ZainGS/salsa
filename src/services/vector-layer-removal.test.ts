/**
 * UI review 2026-10-07 #2 — removing a vector layer takes its shapes + ephemera placements with it as ONE undo step,
 * and documents saved while the old ✕ orphaned shapes get those shapes a layer back on load.
 * Real RasterLayerManager (mock GPU device), real EphemeraService, real scene-graph nodes + VectorObjectUndo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { removeVectorLayerWithContent, recoverOrphanedVectorContent, type VectorLayerRemovalDeps } from './vector-layer-removal';
import { RasterLayerManager } from './raster-layer-manager';
import { EphemeraService } from './ephemera/ephemera-service';
import type { EphemeraPlacement } from './ephemera/ephemera-types';
import { VectorObjectUndo } from './vector-object-undo';
import { Node } from '../scene-graph/shapes/base/node';
import { Group } from '../scene-graph/shapes/base/group';
import { Rectangle } from '../scene-graph/shapes/rectangle';
import type { InteractionService } from './interaction-service';
import ShapeManager from './shape-manager';

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

// ── Mock GPU device (texture tokens; everything else inert) — as blank-document.test.ts ─────────────────────────────
const g = globalThis as Record<string, unknown>;
g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };
const permissive: any = new Proxy(function () { /* callable */ }, {
    get: (_t, p) => (p === 'then' ? undefined : permissive),
    apply: () => permissive,
});
function makeMockDevice(): GPUDevice {
    return {
        createTexture: (desc: { size: number[] }) => ({ width: desc.size[0], height: desc.size[1], destroy() { /* */ }, createView: () => ({}) }),
        createBuffer: (desc: { size: number }) => ({
            size: desc.size, mapAsync: async () => undefined, getMappedRange: () => new ArrayBuffer(desc.size), unmap() { /* */ }, destroy() { /* */ },
        }),
        createCommandEncoder: () => ({
            beginRenderPass: () => permissive, beginComputePass: () => permissive,
            copyTextureToTexture() { /* */ }, copyTextureToBuffer() { /* */ }, copyBufferToTexture() { /* */ }, copyBufferToBuffer() { /* */ },
            finish: () => ({}),
        }),
        createBindGroupLayout: () => permissive, createPipelineLayout: () => permissive, createShaderModule: () => permissive,
        createComputePipeline: () => permissive, createRenderPipeline: () => permissive, createSampler: () => permissive,
        createBindGroup: () => permissive,
        queue: { submit() { /* */ }, writeTexture() { /* */ }, writeBuffer() { /* */ }, copyExternalImageToTexture() { /* */ }, onSubmittedWorkDone: async () => undefined },
    } as unknown as GPUDevice;
}

const isvc = { getViewportCenter: () => [0, 0], maxGlobalZIndex: 0 } as unknown as InteractionService;
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
let nextId = 0;
function rect(layerId?: string): Rectangle {
    const r = new Rectangle(0, 0, 10, 10, WHITE, WHITE, 1, isvc);
    r.setId(`n${nextId++}`);
    if (layerId !== undefined) r.layerId = layerId;
    return r;
}
function group(layerId: string, ...kids: Node[]): Group {
    const gr = new Group(isvc);
    gr.setId(`n${nextId++}`);
    gr.layerId = layerId;
    for (const k of kids) gr.addChild(k);
    return gr;
}
function placement(layerId: string, id: string): EphemeraPlacement {
    return { id, layerId, typeId: 'crosshair', params: {}, svg: '<svg/>', x: 0, y: 0, width: 5, height: 5, rotation: 0, opacity: 1, visible: true } as EphemeraPlacement;
}

/** A document with Background (raster) + vector layers A and B; A's shapes are interleaved with B's / unassigned ones
 *  at the root and one lives inside a group; A and B both have placements. */
function makeDoc() {
    const rlm = new RasterLayerManager(makeMockDevice(), 64, 64);
    const B = rlm.addVectorLayer('B');
    const A = rlm.addVectorLayer('A');
    rlm.addLayer('Ink');
    const root = new Node();
    const a1 = rect(A), b1 = rect(B), a2 = rect(A), loose = rect(), a3 = rect(A), gA = group(A, a3), b2 = rect(B);
    const gB = group(B, b2, rect(A));   // a stray A shape inside B's group goes too
    for (const n of [a1, b1, a2, loose, gA, gB]) root.addChild(n);
    const ephemera = new EphemeraService();
    const pA = [placement(A, 'pa1'), placement(A, 'pa2')];
    ephemera.getAllPlacements().set(A, [...pA]);
    ephemera.getAllPlacements().set(B, [placement(B, 'pb1')]);
    let active: string | null = A;
    const changed = vi.fn();
    const undo = new VectorObjectUndo({ emitChanged: () => {}, requestRender: () => {} });
    const detached: Node[] = [], attached: Node[] = [];
    const deps: VectorLayerRemovalDeps = {
        root, layers: rlm, placements: ephemera,
        isVectorNode: () => true,
        onDetached: (n) => detached.push(n), onAttached: (n) => attached.push(n),
        getActiveVectorLayerId: () => active, setActiveVectorLayer: (id) => { active = id; },
        changed, undo,
    };
    return { rlm, root, ephemera, deps, undo, changed, detached, attached, A, B, a1, b1, a2, loose, gA, gB, pA, getActive: () => active };
}

const layerRows = (rlm: RasterLayerManager) => rlm.getLayers().map((l) => [l.id, l.name, l.type, l.visible]);
/** Every node of the tree in preorder (identity + parent), so a restore must put each one back exactly. */
function treeOrder(root: Node): Array<[Node, Node | null]> {
    const out: Array<[Node, Node | null]> = [];
    const visit = (n: Node) => { for (const c of n.children) { out.push([c, c.parent]); visit(c); } };
    visit(root);
    return out;
}

describe('removeVectorLayerWithContent', () => {
    it('removes the layer, every shape tagged with it (top-most, nested too) and its placements; deactivates it', () => {
        const d = makeDoc();
        expect(removeVectorLayerWithContent(d.deps, d.A)).toBe(true);
        expect(d.rlm.getVectorLayers().map((l) => l.name)).toEqual(['B']);
        expect(d.root.children).toEqual([d.b1, d.loose, d.gB]);
        expect(d.gB.children.map((c) => c.layerId)).toEqual([d.B]);
        expect(d.ephemera.getPlacementsForLayer(d.A)).toEqual([]);
        expect(d.ephemera.getPlacementsForLayer(d.B).map((p) => p.id)).toEqual(['pb1']);
        expect(d.getActive()).toBeNull();
        expect(d.detached).toHaveLength(4);   // a1, a2, gA (with a3 inside), the stray in gB — a3 goes with its group
        expect(d.detached).toContain(d.gA);
        expect(d.changed).toHaveBeenCalledWith(d.A);
        expect(d.undo.canUndo).toBe(true);
        expect(d.undo.undoDescription).toBe('Remove vector layer');
    });

    it('one undo puts back the layer at its stack index, the same shape objects in their exact order, and the placements; redo removes them again', () => {
        const d = makeDoc();
        const layersBefore = layerRows(d.rlm);
        const treeBefore = treeOrder(d.root);
        removeVectorLayerWithContent(d.deps, d.A);

        expect(d.undo.undo()).toBe(true);
        expect(layerRows(d.rlm)).toEqual(layersBefore);
        expect(treeOrder(d.root)).toEqual(treeBefore);
        expect(d.ephemera.getPlacementsForLayer(d.A)).toEqual(d.pA);
        expect(d.ephemera.getPlacementsForLayer(d.A)[0]).toBe(d.pA[0]);
        expect(d.attached).toHaveLength(4);
        expect(d.undo.canUndo).toBe(false);

        expect(d.undo.redo()).toBe(true);
        expect(d.rlm.getVectorLayers().map((l) => l.name)).toEqual(['B']);
        expect(d.root.children).toEqual([d.b1, d.loose, d.gB]);
        expect(d.ephemera.getPlacementsForLayer(d.A)).toEqual([]);

        d.undo.undo();   // and back once more — the redo re-captured fresh state
        expect(layerRows(d.rlm)).toEqual(layersBefore);
        expect(treeOrder(d.root)).toEqual(treeBefore);
    });

    it('is a no-op (nothing removed, nothing recorded) for an id that is not a vector layer', () => {
        const d = makeDoc();
        const raster = d.rlm.getLayers().find((l) => l.name === 'Ink')!.id;
        const before = treeOrder(d.root);
        expect(removeVectorLayerWithContent(d.deps, raster)).toBe(false);
        expect(removeVectorLayerWithContent(d.deps, 'missing')).toBe(false);
        expect(d.rlm.getLayers()).toHaveLength(4);
        expect(treeOrder(d.root)).toEqual(before);
        expect(d.undo.canUndo).toBe(false);
        expect(d.getActive()).toBe(d.A);
    });

    it('an empty layer still removes and undoes as one step', () => {
        const d = makeDoc();
        const empty = d.rlm.addVectorLayer('Empty');
        const before = layerRows(d.rlm);
        removeVectorLayerWithContent(d.deps, empty);
        expect(d.rlm.getVectorLayers().map((l) => l.name)).toEqual(['A', 'B']);
        d.undo.undo();
        expect(layerRows(d.rlm)).toEqual(before);
    });
});

describe('ShapeManager.removeVectorLayer (the facade wiring)', () => {
    it('drops the selection of removed shapes, keeps the eraser registry in step, and Ctrl+Z (the 2D object stack) restores everything', () => {
        const d = makeDoc();
        const selected = new Set<Node>([d.a1, d.loose]);   // (deactivating A drops every layer-tagged selection anyway)
        const vectorUndo = new VectorObjectUndo({ emitChanged: () => {}, requestRender: () => {} });
        const scribbles: Node[] = [];
        const self = Object.create(ShapeManager.prototype) as Record<string, unknown>;
        Object.assign(self, {
            rasterLayerManager: d.rlm,
            sceneGraph: { root: d.root },
            _ephemera: d.ephemera,
            _ephemeraOverlay: { invalidateCache: vi.fn(), getSelectedPlacement: () => null, clearPlacementSelection: vi.fn() },
            interactionService: {
                selectedNodes: selected,
                deselectNode: (n: Node) => { selected.delete(n); },
                isVectorLayerInteractive: () => true,
                activeVectorLayerId: d.A,
                vectorUndo,
            },
            eraserService: { scribbles, scribblesInView: [] },
            webgpuRenderer: {},
            _activeVectorLayerId: d.A,
            emitSceneGraphChanged: vi.fn(),
            scheduleRender: vi.fn(),
        });
        const sm = self as unknown as ShapeManager;
        const layersBefore = layerRows(d.rlm);
        const treeBefore = treeOrder(d.root);

        expect(sm.removeVectorLayer(d.A)).toBe(true);
        expect(sm.getActiveVectorLayerId()).toBeNull();
        expect([...selected]).toEqual([d.loose]);
        expect(d.root.children).toEqual([d.b1, d.loose, d.gB]);
        expect(d.ephemera.getPlacementsForLayer(d.A)).toEqual([]);
        expect(sm.canUndo2DShapes).toBe(true);
        expect(self.emitSceneGraphChanged).toHaveBeenCalled();

        expect(sm.undo2DShapes()).toBe(true);
        expect(layerRows(d.rlm)).toEqual(layersBefore);
        expect(treeOrder(d.root)).toEqual(treeBefore);
        expect(d.ephemera.getPlacementsForLayer(d.A).map((p) => p.id)).toEqual(['pa1', 'pa2']);
    });
});

describe('recoverOrphanedVectorContent (load-time repair)', () => {
    it('gives each missing layer id of a shape or placement a "Recovered shapes" vector layer under the SAME id', () => {
        const d = makeDoc();
        // What the old ✕ left behind: the layer entry gone, its shapes and (here) placements still tagged with it.
        d.rlm.removeVectorLayer(d.A);
        d.ephemera.getAllPlacements().set('gone-2', [placement('gone-2', 'pg')]);
        const tree = treeOrder(d.root);

        const recovered = recoverOrphanedVectorContent(d.deps);
        expect(recovered).toEqual([d.A, 'gone-2']);
        const vec = d.rlm.getVectorLayers();
        expect(vec.map((l) => [l.id, l.name, l.visible])).toEqual([
            [d.B, 'B', true], [d.A, 'Recovered shapes 1', true], ['gone-2', 'Recovered shapes 2', true],
        ]);
        expect(treeOrder(d.root)).toEqual(tree);   // the shapes themselves are untouched (same ids → nothing to rewrite)
        expect(recoverOrphanedVectorContent(d.deps)).toEqual([]);   // idempotent
    });

    it('one orphaned id gets the plain name; ids of existing layers (any kind) and untagged / non-vector nodes are left alone', () => {
        const d = makeDoc();
        const raster = d.rlm.getLayers().find((l) => l.name === 'Ink')!.id;
        d.root.addChild(rect(raster));
        const mesh = rect('only-3d');
        d.root.addChild(mesh);
        d.root.addChild(rect('gone'));
        const deps = { ...d.deps, isVectorNode: (n: Node) => n !== mesh };
        expect(recoverOrphanedVectorContent(deps)).toEqual(['gone']);
        expect(d.rlm.getVectorLayers().find((l) => l.id === 'gone')?.name).toBe('Recovered shapes');
        expect(d.rlm.getLayers().filter((l) => l.id === raster)).toHaveLength(1);
    });
});
