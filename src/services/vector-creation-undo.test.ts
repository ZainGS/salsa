/**
 * Every 2D vector CREATION is ONE step on the 2D object undo stack (vector-object-undo.ts): Ctrl+Z takes the new
 * object off, redo puts the very same instance back — layer, z-order and style intact. Plus the freeform polygon
 * tool filling with the host's current (pen) colour, and Change colour as an undo step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shape.id mints through self.crypto (a browser global) — Node 22 has crypto on globalThis.
const g = globalThis as { self?: unknown };
g.self ??= globalThis;

import ShapeManager from './shape-manager';
import { VectorObjectUndo, recordVectorCreation } from './vector-object-undo';
import { ShapeFactory } from '../scene-graph/core/shape-factory';
import { SceneGraph } from '../scene-graph/core/scene-graph';
import { Node } from '../scene-graph/shapes/base/node';
import { Group } from '../scene-graph/shapes/base/group';
import { Rectangle } from '../scene-graph/shapes/rectangle';
import { PathNode } from '../scene-graph/shapes/path-node';
import { LiveTextNode } from '../scene-graph/shapes/live-text';
import { PolygonDrawingService } from './drawing/polygon-drawing-service';
import { LiveTextManager } from './managers/live-text-manager';
import type { ManagerContext } from './managers/manager-context';
import type { InteractionService } from './interaction-service';
import type { CacheService } from './cache-service';

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

type Proto = Record<string, (...a: any[]) => any>;
const SM = ShapeManager.prototype as unknown as Proto;

function makeIsvc() {
    const undo = new VectorObjectUndo({ emitChanged: () => {}, requestRender: () => {}, clearSelection: () => {} });
    const isvc = {
        maxGlobalZIndex: 1,
        vectorUndo: undo,
        getViewportCenter: () => [0, 0],
        clearSelectedNodes: vi.fn(), selectNode: vi.fn(), deselectNode: vi.fn(),
        onSceneGraphChanged: { emit: vi.fn() },
        requestRender: vi.fn(), beginInteractive: vi.fn(), endInteractive: vi.fn(),
    };
    return { isvc, undo };
}

/** A ShapeManager `this` with just what the creation verbs touch. */
function makeSM() {
    const { isvc, undo } = makeIsvc();
    const sceneGraph = new SceneGraph();
    const shapeFactory = new ShapeFactory(isvc as unknown as InteractionService, {} as CacheService);
    const sm: Record<string, unknown> = {
        sceneGraph, shapeFactory, interactionService: isvc,
        shapeColor: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
        polygonDrawingService: null,
        _stampVectorLayer: (t: { layerId?: string }) => { t.layerId = 'vec-1'; },
        emitSceneGraphChanged: vi.fn(), scheduleRender: vi.fn(), endInteractive: vi.fn(),
    };
    for (const k of ['_recordCreated', 'getNodeFillColor', '_applyNodeFillColor']) sm[k] = SM[k].bind(sm);
    const call = (name: string, ...args: unknown[]) => SM[name].call(sm, ...args);
    return { sm, call, undo, root: sceneGraph.root, shapeFactory, isvc };
}

/** One step: undo detaches every node, redo re-attaches the SAME instances with layer / z / style intact. */
function expectOneCreationStep(undo: VectorObjectUndo, root: Node, nodes: Node[], description: string) {
    expect(undo.canUndo).toBe(true);
    expect(undo.undoDescription).toBe(description);
    const before = nodes.map((n) => ({
        layerId: (n as any).layerId, z: n.zIndex, fill: { ...((n as any).fillColor ?? {}) }, x: n.x, y: n.y,
    }));
    expect(undo.undo()).toBe(true);
    for (const n of nodes) { expect(n.parent).toBeNull(); expect(root.children).not.toContain(n); }
    expect(undo.canUndo).toBe(false);          // exactly ONE step for the creation
    expect(undo.redo()).toBe(true);
    nodes.forEach((n, i) => {
        expect(n.parent).toBe(root);
        expect((n as any).layerId).toBe(before[i].layerId);
        expect(n.zIndex).toBe(before[i].z);
        expect({ ...((n as any).fillColor ?? {}) }).toEqual(before[i].fill);
        expect([n.x, n.y]).toEqual([before[i].x, before[i].y]);
    });
    expect(undo.canRedo).toBe(false);
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('recordVectorCreation', () => {
    it('pushes nothing without a stack or when none of the nodes is attached', () => {
        const { undo, root, shapeFactory } = makeSM();
        const r = shapeFactory.createRectangle(0, 0, 1, 1, RED, BLACK, 1);
        expect(recordVectorCreation(null, root, [r], 'Add shape')).toBe(false);
        expect(recordVectorCreation(undo, root, [r], 'Add shape')).toBe(false);   // not attached
        expect(undo.canUndo).toBe(false);
    });

    it('a compound object (group) comes off and back WHOLE: its children stay inside, in order', () => {
        const { isvc, undo } = makeIsvc();
        const root = new SceneGraph().root;
        const grp = new Group(isvc as unknown as InteractionService);
        const a = new Rectangle(-1, 0, 1, 1, RED, BLACK, 1, isvc as unknown as InteractionService);
        const b = new Rectangle(1, 0, 1, 1, RED, BLACK, 1, isvc as unknown as InteractionService);
        grp.addChild(a); grp.addChild(b);
        root.addChild(grp);
        expect(recordVectorCreation(undo, root, [grp], 'Add group')).toBe(true);
        undo.undo();
        expect(grp.parent).toBeNull();
        expect(grp.children).toEqual([a, b]);   // not taken apart
        undo.redo();
        expect(grp.parent).toBe(root);
        expect(grp.children).toEqual([a, b]);
        expect([a.x, b.x]).toEqual([-1, 1]);
    });
});

describe('ShapeManager creation verbs — each is ONE 2D undo step', () => {
    const verbs: Array<[string, unknown[], string]> = [
        ['createRectangle', [0, 0, 0.5, 0.5, BLACK, 1], 'Add shape'],
        ['createCircle', [0, 0, 0.5, BLACK, 1], 'Add shape'],
        ['createTriangle', [0, 0, 0.5, 0.5, BLACK, 1], 'Add shape'],
        ['createLine', [0, 0, 1, 1, BLACK, 1], 'Draw line'],
        ['createArrow', [0, 0, 1, 1, BLACK, 1], 'Draw arrow'],
        ['createPath', [[{ x: 0, y: 0, kind: 'corner' }, { x: 1, y: 0, kind: 'corner' }, { x: 1, y: 1, kind: 'corner' }], true, BLACK, 0.01], 'Add path'],
    ];
    for (const [verb, args, desc] of verbs) {
        it(`${verb}: undo removes it, redo restores the same node (layer, z-order, style)`, () => {
            const { call, undo, root } = makeSM();
            const node = call(verb, ...args) as Node;
            expect(node.parent).toBe(root);
            expect((node as any).layerId).toBe('vec-1');
            expectOneCreationStep(undo, root, [node], desc);
        });
    }

    it('createRegularPolygon / createPolygonFromPoints / createPresetPolygon', () => {
        for (const [verb, args] of [
            ['createRegularPolygon', [0, 0, 0.3, 6]],
            ['createPolygonFromPoints', [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]]],
            ['createPresetPolygon', [0, 0, 1, 1, 'star5']],
        ] as Array<[string, unknown[]]>) {
            const { call, undo, root } = makeSM();
            call(verb, ...args);
            const node = root.children[root.children.length - 1];
            expectOneCreationStep(undo, root, [node], 'Add shape');
        }
    });

    it('createStickyNote / createSpeechBalloon (compound shapes) — one step each, children kept', () => {
        for (const [verb, factoryFn, desc] of [
            ['createStickyNote', 'createStickyNote', 'Add sticky note'],
            ['createSpeechBalloon', 'createSpeechBalloon', 'Add speech balloon'],
        ]) {
            const { call, undo, root, shapeFactory, isvc } = makeSM();
            const is = isvc as unknown as InteractionService;
            let made: Group | null = null;
            // The real note / balloon render text through a canvas: a Group of two parts stands in for it.
            (shapeFactory as unknown as Proto)[factoryFn] = () => {
                const grp = new Group(is);
                grp.addChild(new Rectangle(0, 0, 1, 1, RED, BLACK, 1, is));
                grp.addChild(new Rectangle(0, 0, 0.5, 0.5, BLACK, BLACK, 1, is));
                made = grp;
                return grp;
            };
            call(verb, 0, 0);
            const kids = [...made!.children];
            expectOneCreationStep(undo, root, [made!], desc);
            expect(made!.children).toEqual(kids);
        }
    });

    it('importSVGPath: every subpath of one import = ONE step', () => {
        const { call, undo, root } = makeSM();
        const created = call('importSVGPath', 'M0 0 L10 0 L10 10 Z M20 0 L30 0 L30 10 Z') as Node[];
        expect(created).toHaveLength(2);
        expectOneCreationStep(undo, root, created, 'Import SVG');
    });

    it('shape tool click (confirmPreviewShape) is still one step', () => {
        const { sm, call, undo, root, shapeFactory } = makeSM();
        const ghost = shapeFactory.createRectangle(0, 0, 1, 1, RED, BLACK, 1);
        ghost.isPreview = true;
        root.addChild(ghost);
        sm.currentPreviewShape = ghost;
        sm._skipNextPreviewConfirm = false;
        call('confirmPreviewShape');
        expect(ghost.isPreview).toBe(false);
        expectOneCreationStep(undo, root, [ghost], 'Add shape');
    });
});

describe('ShapeManager.setNodeFillColor — Change colour is one undo step', () => {
    it('undo puts the old fill back, redo the new one; an unchanged colour records nothing', () => {
        const { call, undo, root, shapeFactory } = makeSM();
        const r = shapeFactory.createRectangle(0, 0, 1, 1, { r: 1, g: 1, b: 1, a: 1 }, BLACK, 1);
        root.addChild(r);
        call('setNodeFillColor', r.id, RED);
        expect(r.fillColor).toEqual(RED);
        expect(undo.undoDescription).toBe('Change colour');
        undo.undo();
        expect(r.fillColor).toEqual({ r: 1, g: 1, b: 1, a: 1 });
        expect(undo.canUndo).toBe(false);
        undo.redo();
        expect(r.fillColor).toEqual(RED);
        call('setNodeFillColor', r.id, { ...RED });
        expect(undo.canRedo).toBe(false);
        undo.undo();                                   // the no-op recolour pushed nothing: this is the first change
        expect(r.fillColor).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    });
});

// ── Freeform polygon tool ────────────────────────────────────────────────────────────────────────────

type Handler = (e: any) => unknown;
function polygonRig() {
    const canvasL = new Map<string, Handler[]>();
    const winL = new Map<string, Handler[]>();
    const add = (m: Map<string, Handler[]>) => (t: string, h: Handler) => { m.set(t, [...(m.get(t) ?? []), h]); };
    const rm = (m: Map<string, Handler[]>) => (t: string, h: Handler) => { m.set(t, (m.get(t) ?? []).filter((x) => x !== h)); };
    vi.stubGlobal('window', { addEventListener: add(winL), removeEventListener: rm(winL) });
    const { isvc, undo } = makeIsvc();
    Object.assign(isvc, {
        canvas: { addEventListener: add(canvasL), removeEventListener: rm(canvasL) },
        toWorldCoords: (e: any) => ({ x: e.clientX / 100, y: e.clientY / 100 }),
        toWorldCoordsFromCanvas: (px: number, py: number) => ({ x: px / 100, y: py / 100 }),
    });
    const sceneGraph = new SceneGraph();
    const factory = new ShapeFactory(isvc as unknown as InteractionService, {} as CacheService);
    factory.setLayerStampProvider(() => 'vec-2');
    const svc = new PolygonDrawingService(isvc as unknown as InteractionService, sceneGraph, factory);
    svc.enable();
    const fire = (m: Map<string, Handler[]>, type: string, e: any) => { for (const h of m.get(type) ?? []) h({ button: 0, buttons: 0, preventDefault() {}, ...e }); };
    const click = (x: number, y: number) => { fire(canvasL, 'pointerdown', { clientX: x, clientY: y }); fire(canvasL, 'pointerup', { clientX: x, clientY: y }); };
    const drawTriangle = () => { click(0, 0); click(100, 0); click(100, 100); fire(winL, 'keydown', { key: 'Enter' }); };
    return { svc, undo, root: sceneGraph.root, drawTriangle };
}

describe('PolygonDrawingService (freeform polygon tool)', () => {
    it('fills with the colour the host set (the pen colour) — its own copy', () => {
        const t = polygonRig();
        const pen = { r: 0.9, g: 0.1, b: 0.3, a: 1 };
        t.svc.setFillColor(pen);
        t.drawTriangle();
        expect(t.root.children).toHaveLength(1);              // staging lines all gone
        const path = t.root.children[0] as PathNode;
        expect(path).toBeInstanceOf(PathNode);
        expect(path.fillColor).toEqual(pen);
        expect(path.fillColor).not.toBe(pen);
        pen.r = 0;                                            // the host's object changing later doesn't reach it
        expect(path.fillColor.r).toBeCloseTo(0.9);
    });

    it('a committed polygon is ONE undo step; redo restores the same path (layer, z-order, fill)', () => {
        const t = polygonRig();
        t.svc.setFillColor(RED);
        t.drawTriangle();
        const path = t.root.children[0] as PathNode;
        expect(path.layerId).toBe('vec-2');
        expectOneCreationStep(t.undo, t.root, [path], 'Draw polygon');
        expect(path.fillColor).toEqual(RED);
        expect(t.root.children).toEqual([path]);
    });

    it('a cancelled polygon records nothing', () => {
        const t = polygonRig();
        t.svc.disable();
        expect(t.undo.canUndo).toBe(false);
    });

    it('ShapeManager.setShapeColor feeds the polygon tool (the host calls it with the pen colour)', () => {
        const t = polygonRig();
        SM.setShapeColor.call({ polygonDrawingService: t.svc }, '#00ff00');
        expect(t.svc.getFillColor()).toEqual({ r: 0, g: 1, b: 0, a: 1 });
        t.drawTriangle();
        expect((t.root.children[0] as PathNode).fillColor).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    });
});

// ── LiveText (the Illustration Text tool) ────────────────────────────────────────────────────────────

describe('LiveTextManager — a new text box is one undo step once it has text', () => {
    function rig() {
        for (const m of ['applyInitialSize', 'updateTexture', 'beginEditing', 'endEditing', 'destroy'] as const) {
            vi.spyOn(LiveTextNode.prototype, m).mockImplementation(() => {});
        }
        const { isvc, undo } = makeIsvc();
        const sceneGraph = new SceneGraph();
        const factory = new ShapeFactory(isvc as unknown as InteractionService, {} as CacheService);
        const ctx = {
            sceneGraph, shapeFactory: factory, interactionService: isvc, rasterLayerManager: undefined,
            webgpuRenderer: { beginInteractive: vi.fn(), endInteractive: vi.fn() },
            scheduleRender: vi.fn(), emitSceneGraphChanged: vi.fn(),
        } as unknown as ManagerContext;
        const mgr = new LiveTextManager(ctx, { getActiveVectorLayerId: () => 'vec-3', getTextEffectEngine: () => null });
        return { mgr, undo, root: sceneGraph.root };
    }

    it('created empty (the tool click): no step until editing ends WITH text — then exactly one', () => {
        const t = rig();
        const node = t.mgr.createLiveText(0, 0, { text: '' });
        expect(t.undo.canUndo).toBe(false);
        t.mgr.beginLiveTextEditing(node.id);
        node.text = 'Hello';
        t.mgr.endLiveTextEditing(node.id);
        expectOneCreationStep(t.undo, t.root, [node], 'Add text');
        expect(node.layerId).toBe('vec-3');
        t.mgr.beginLiveTextEditing(node.id);           // editing it again later is not another creation
        t.mgr.endLiveTextEditing(node.id);
        t.undo.undo();
        expect(t.undo.canUndo).toBe(false);
    });

    it('left empty: removed, nothing recorded', () => {
        const t = rig();
        const node = t.mgr.createLiveText(0, 0, { text: '' });
        t.mgr.endLiveTextEditing(node.id);
        expect(node.parent).toBeNull();
        expect(t.undo.canUndo).toBe(false);
    });

    it('created with text (API / AI): recorded right away', () => {
        const t = rig();
        const node = t.mgr.createLiveText(0, 0, { text: 'Hi' });
        expectOneCreationStep(t.undo, t.root, [node], 'Add text');
    });
});
