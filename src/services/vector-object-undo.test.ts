import { describe, it, expect } from 'vitest';
import { VectorObjectUndo } from './vector-object-undo';
import { Node } from '../scene-graph/shapes/base/node';
import { Group } from '../scene-graph/shapes/base/group';
import { Rectangle } from '../scene-graph/shapes/rectangle';
import type { InteractionService } from './interaction-service';

// Minimal stub — Shape ctors read maxGlobalZIndex for the default z; nothing here touches the GPU.
const isvc = { getViewportCenter: () => [0, 0], maxGlobalZIndex: 0 } as unknown as InteractionService;

const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

/** Node's test env has no `self.crypto`, so mint ids by hand (Shape.id has a setter). */
let nextId = 0;
function rect(x: number, y: number, w = 10, h = 10): Rectangle {
    const r = new Rectangle(x, y, w, h, WHITE, BLACK, 1, isvc);
    r.setId(`n${nextId++}`);
    return r;
}
function group(): Group {
    const g = new Group(isvc);
    g.setId(`n${nextId++}`);
    return g;
}

function makeEngine() {
    const calls = { changed: 0, render: 0, cleared: 0 };
    const engine = new VectorObjectUndo({
        emitChanged: () => { calls.changed++; },
        requestRender: () => { calls.render++; },
        clearSelection: () => { calls.cleared++; },
    });
    return { engine, calls };
}

describe('VectorObjectUndo — snapshot-diff undo for 2D vector object operations', () => {
    it('move: undo restores position, redo re-applies it', () => {
        const { engine, calls } = makeEngine();
        const root = new Node();
        const a = rect(1, 2);
        root.addChild(a);

        const token = engine.begin(root, [a]);
        a.x = 50; a.y = 60;
        a.updateLocalMatrix();
        expect(engine.commit(token, 'Move shapes')).toBe(true);

        expect(engine.canUndo).toBe(true);
        expect(engine.undoDescription).toBe('Move shapes');
        engine.undo();
        expect([a.x, a.y]).toEqual([1, 2]);
        expect(a.parent).toBe(root);
        engine.redo();
        expect([a.x, a.y]).toEqual([50, 60]);
        expect(calls.changed).toBe(2);
        expect(calls.render).toBe(2);
        expect(calls.cleared).toBe(2);
    });

    it('no-op gesture: commit returns false and pushes nothing', () => {
        const { engine } = makeEngine();
        const root = new Node();
        const a = rect(1, 2);
        root.addChild(a);

        const token = engine.begin(root, [a]);
        expect(engine.commit(token, 'Move shapes')).toBe(false);
        expect(engine.canUndo).toBe(false);
    });

    it('group: undo detaches the group and returns children to the root; redo re-attaches the SAME group instance', () => {
        const { engine } = makeEngine();
        const root = new Node();
        const a = rect(0, 0);
        const b = rect(20, 0);
        root.addChild(a); root.addChild(b);

        // Simulate groupSelectedShapes: reparent under a new Group created DURING the gesture.
        const token = engine.begin(root, [a, b]);
        const g = group();
        g.x = 10; g.y = 0;
        g.updateLocalMatrix();
        root.removeChild(a); root.removeChild(b);
        a.x = -10; b.x = 10;                        // rebased into group-local space
        g.addChild(a); g.addChild(b);
        root.addChild(g);
        expect(engine.commit(token, 'Group shapes', [g])).toBe(true);

        engine.undo();
        expect(a.parent).toBe(root);
        expect(b.parent).toBe(root);
        expect(g.parent).toBeNull();
        expect([a.x, b.x]).toEqual([0, 20]);

        engine.redo();
        expect(a.parent).toBe(g);                    // the retained instance, not a clone
        expect(g.parent).toBe(root);
        expect(g.peekId()).toBeDefined();
        expect([a.x, b.x, g.x]).toEqual([-10, 10, 10]);
    });

    it('delete: undo re-attaches the retained instances (parent group included), children after parents', () => {
        const { engine } = makeEngine();
        const root = new Node();
        const g = group();
        const a = rect(-5, 0);
        g.addChild(a);
        g.x = 100;
        g.updateLocalMatrix();
        root.addChild(g);

        // Simulate deleteSelectedShapes on the group: subtree detaches.
        const token = engine.begin(root, [g]);
        root.removeChild(g);
        expect(engine.commit(token, 'Delete shapes')).toBe(true);

        engine.undo();
        expect(g.parent).toBe(root);                 // group attaches first (loop-until-stable)…
        expect(a.parent).toBe(g);                    // …then the child resolves onto it
        expect([g.x, a.x]).toEqual([100, -5]);

        engine.redo();
        expect(g.parent).toBeNull();
    });

    it('a new command truncates the redo branch', () => {
        const { engine } = makeEngine();
        const root = new Node();
        const a = rect(0, 0);
        root.addChild(a);

        let t = engine.begin(root, [a]);
        a.x = 10; engine.commit(t, 'Move 1');
        t = engine.begin(root, [a]);
        a.x = 20; engine.commit(t, 'Move 2');

        engine.undo();                               // back to x=10
        expect(engine.canRedo).toBe(true);
        t = engine.begin(root, [a]);
        a.x = 99; engine.commit(t, 'Move 3');        // diverge
        expect(engine.canRedo).toBe(false);
        engine.undo();
        expect(a.x).toBe(10);
    });

    it('rotation + scale participate in the snapshot', () => {
        const { engine } = makeEngine();
        const root = new Node();
        const a = rect(0, 0);
        root.addChild(a);

        const token = engine.begin(root, [a]);
        a.rotation = Math.PI / 4;
        a.scaleX = 2; a.scaleY = 3;
        a.updateLocalMatrix();
        expect(engine.commit(token, 'Rotate shapes')).toBe(true);

        engine.undo();
        expect(a.rotation).toBe(0);
        expect([a.scaleX, a.scaleY]).toEqual([1, 1]);
        engine.redo();
        expect(a.rotation).toBeCloseTo(Math.PI / 4);
        expect([a.scaleX, a.scaleY]).toEqual([2, 3]);
    });
});
