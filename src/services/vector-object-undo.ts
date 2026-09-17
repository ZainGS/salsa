/**
 * VectorObjectUndo — undo/redo for 2D vector OBJECT operations (audit P1, editing-loop-polish.md).
 *
 * The gap it closes: raster strokes, path-anchor edits, and every 3D transform were undoable — but
 * moving / rotating / scaling / grouping / ungrouping / deleting 2D shapes was not.
 *
 * Design: a generic SNAPSHOT-DIFF engine over the scene graph.
 *   - `begin(root, seeds)` captures a WATCH SET — each seed plus its ancestors (group sizes change)
 *     and all descendants (bakeScaleToLeaves / section reparents touch them) — as per-node snapshots
 *     of { parentId, x, y, rotation, scaleX, scaleY, zIndex }. `null` snap = not attached.
 *   - `commit(token, description, extraSeeds?)` re-snapshots (extraSeeds admits nodes created DURING
 *     the gesture — the 'g' group node), diffs, and pushes ONE command when anything changed.
 *   - Commands RETAIN the Node instances (never serialize): undoing a delete or a group re-attaches
 *     the very same objects, so ids stay stable and later commands keep applying cleanly.
 *   - The stack itself is the generic UndoManager3D (it was never 3D-specific).
 *
 * Apply order: detach removed → attach/retransform (looped until stable, so parents attach before
 * children regardless of map order) → recalculateSize on restored Groups (deepest-first) → re-assert
 * group positions (recalculateSize may recentre) → clear selection (stale-ref safety) → emit + render.
 */

import { UndoManager3D } from './managers/undo-manager-3d';
import { Node } from '../scene-graph/shapes/base/node';
import { Shape } from '../scene-graph/shapes/base/shape';
import { Group } from '../scene-graph/shapes/base/group';

interface NodeSnap {
    parentId: string;   // '' = the scene root
    x: number; y: number;
    rotation: number;
    scaleX: number; scaleY: number;
    zIndex: number;
    /** Line endpoints (local coords) — Lines keep identity scale by contract, so their geometry
     *  lives in x1..y2 and TRS alone can't restore an endpoint edit or a flip. */
    x1?: number; y1?: number; x2?: number; y2?: number;
}

/** Structural view of a Line (avoids importing the concrete class). */
interface LineLike {
    x1: number; y1: number; x2: number; y2: number;
    updateStartPoint(x: number, y: number): void;
    updateEndPoint(x: number, y: number): void;
}

function asLine(n: Node): LineLike | null {
    const l = n as unknown as LineLike;
    return typeof l.x1 === 'number' && typeof l.updateStartPoint === 'function' ? l : null;
}

interface Entry { node: Node; before: NodeSnap | null }

export interface UndoCaptureToken {
    root: Node;
    entries: Map<string, Entry>;
}

export interface VectorUndoHooks {
    emitChanged(): void;
    requestRender(): void;
    clearSelection?(): void;
}

export class VectorObjectUndo {
    private readonly _mgr = new UndoManager3D(50);

    constructor(private readonly hooks: VectorUndoHooks) {}

    get canUndo(): boolean { return this._mgr.canUndo; }
    get canRedo(): boolean { return this._mgr.canRedo; }
    get undoDescription(): string | null { return this._mgr.undoDescription; }
    get redoDescription(): string | null { return this._mgr.redoDescription; }

    undo(): boolean { return this._mgr.undo(); }
    redo(): boolean { return this._mgr.redo(); }
    clear(): void { this._mgr.clear(); }

    /** Snapshot the watch set for a gesture that is ABOUT to mutate `seeds` (and possibly their
     *  ancestors/descendants). Call at pointer-down / before a structural op. */
    begin(root: Node, seeds: Iterable<Node>): UndoCaptureToken {
        const entries = new Map<string, Entry>();
        for (const n of this._watchSet(root, seeds)) {
            entries.set(this._id(n), { node: n, before: this._snap(root, n) });
        }
        return { root, entries };
    }

    /** Diff the token against the current graph and push ONE undo command when anything changed.
     *  `extraSeeds`: nodes created during the gesture (e.g. the new Group from 'g'). */
    commit(token: UndoCaptureToken, description: string, extraSeeds: Iterable<Node> = []): boolean {
        const { root } = token;
        // Union: everything watched at begin + anything reachable from the extra seeds now.
        const all = new Map<string, Node>();
        for (const [id, e] of token.entries) all.set(id, e.node);
        for (const n of this._watchSet(root, extraSeeds)) all.set(this._id(n), n);

        const before = new Map<string, { node: Node; snap: NodeSnap | null }>();
        const after = new Map<string, { node: Node; snap: NodeSnap | null }>();
        let changed = false;
        for (const [id, node] of all) {
            const b = token.entries.get(id)?.before ?? null;   // not watched at begin = didn't exist yet
            const a = this._snap(root, node);
            if (!this._same(b, a)) changed = true;
            before.set(id, { node, snap: b });
            after.set(id, { node, snap: a });
        }
        if (!changed) return false;

        this._mgr.push({
            description,
            undo: () => this._apply(root, before),
            redo: () => this._apply(root, after),
        });
        return true;
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** `id` is Shape's minting getter (Node has none); every vector object is a Shape/Group. */
    private _id(n: Node): string { return (n as Shape).id; }

    private _watchSet(root: Node, seeds: Iterable<Node>): Set<Node> {
        const out = new Set<Node>();
        for (const seed of seeds) {
            // Ancestors up to (excluding) the root — their group bounds/positions can change.
            let p = seed.parent;
            while (p && p !== root) { out.add(p); p = p.parent; }
            // The node + every descendant (scale bakes / section reparents reach them).
            seed.forEachDeep((n: Node) => { out.add(n); });
            out.add(seed);
        }
        out.delete(root);
        return out;
    }

    private _attached(root: Node, n: Node): boolean {
        let p: Node | null = n;
        while (p) { if (p === root) return true; p = p.parent ?? null; }
        return false;
    }

    private _snap(root: Node, n: Node): NodeSnap | null {
        if (!this._attached(root, n)) return null;
        const snap: NodeSnap = {
            parentId: n.parent === root || !n.parent ? '' : this._id(n.parent),
            x: n.x, y: n.y,
            rotation: (n as Shape).rotation ?? 0,
            scaleX: (n as Shape).scaleX ?? 1,
            scaleY: (n as Shape).scaleY ?? 1,
            zIndex: n.zIndex ?? 0,
        };
        const line = asLine(n);
        if (line) { snap.x1 = line.x1; snap.y1 = line.y1; snap.x2 = line.x2; snap.y2 = line.y2; }
        return snap;
    }

    private _same(a: NodeSnap | null, b: NodeSnap | null): boolean {
        if (a === null || b === null) return a === b;
        // Object.is: a stray NaN field (e.g. an unset zIndex) must not make every gesture "dirty".
        const eq = (p: number, q: number) => p === q || Object.is(p, q);
        const eqOpt = (p?: number, q?: number) =>
            (p === undefined && q === undefined) || (p !== undefined && q !== undefined && eq(p, q));
        return a.parentId === b.parentId && eq(a.x, b.x) && eq(a.y, b.y) &&
            eq(a.rotation, b.rotation) && eq(a.scaleX, b.scaleX) && eq(a.scaleY, b.scaleY) &&
            eq(a.zIndex, b.zIndex) &&
            eqOpt(a.x1, b.x1) && eqOpt(a.y1, b.y1) && eqOpt(a.x2, b.x2) && eqOpt(a.y2, b.y2);
    }

    private _apply(root: Node, state: Map<string, { node: Node; snap: NodeSnap | null }>): void {
        // Pass 1: detach everything absent in this state.
        for (const { node, snap } of state.values()) {
            if (snap === null && node.parent) node.parent.removeChild(node);
        }

        // Pass 2: attach + retransform, looping so parents attach before their children.
        const pending = [...state.values()].filter((e) => e.snap !== null);
        let guard = pending.length + 1;
        while (pending.length > 0 && guard-- > 0) {
            for (let i = pending.length - 1; i >= 0; i--) {
                const { node, snap } = pending[i];
                const parent = snap!.parentId === ''
                    ? root
                    : state.get(snap!.parentId)?.node ?? this._findById(root, snap!.parentId);
                if (!parent || (parent !== root && !this._attached(root, parent))) continue;   // parent not placed yet
                if (node.parent !== parent) {
                    node.parent?.removeChild(node);
                    parent.addChild(node);
                }
                node.x = snap!.x; node.y = snap!.y;
                const sh = node as Shape;
                if ('rotation' in node) sh.rotation = snap!.rotation;
                sh.scaleX = snap!.scaleX; sh.scaleY = snap!.scaleY;
                node.zIndex = snap!.zIndex;
                const line = snap!.x1 !== undefined ? asLine(node) : null;
                if (line) {
                    line.updateStartPoint(snap!.x1!, snap!.y1!);
                    line.updateEndPoint(snap!.x2!, snap!.y2!);
                }
                node.updateLocalMatrix();
                if (node instanceof Shape) node.markDirty();
                pending.splice(i, 1);
            }
        }

        // Pass 3: restored Groups recompute bounds (deepest-first), then re-assert EVERY snapped
        // node's position — recalculateSize recentres a group AND rebases its children, so forcing
        // only the group back would shift the children in world space. The snapshot is the truth.
        const groups = [...state.values()]
            .filter((e) => e.snap !== null && e.node instanceof Group)
            .sort((a, b) => this._depth(b.node) - this._depth(a.node));
        for (const { node } of groups) (node as Group).recalculateSize();
        for (const { node, snap } of state.values()) {
            if (snap === null) continue;
            node.x = snap.x; node.y = snap.y;
            node.updateLocalMatrix();
        }

        this.hooks.clearSelection?.();
        this.hooks.emitChanged();
        this.hooks.requestRender();
    }

    private _depth(n: Node): number {
        let d = 0, p = n.parent;
        while (p) { d++; p = p.parent; }
        return d;
    }

    private _findById(root: Node, id: string): Node | null {
        let found: Node | null = null;
        root.forEachDeep((n: Node) => { if ((n as Shape).peekId?.() === id) found = n; });
        return found;
    }
}
