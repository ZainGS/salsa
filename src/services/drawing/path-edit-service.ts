/**
 * src/services/drawing/path-edit-service.ts
 *
 * Path NODE EDITOR (docs/specs/vector-paths.md P2): enter edit mode on a committed PathNode and re-drag its
 * anchors and Bézier handles. The path itself re-renders LIVE (every mutation retessellates + re-uploads via
 * PathNode._mutated), so the editor only draws lightweight staged overlay markers:
 *
 *  - blue squares on every anchor; the SELECTED anchor is green;
 *  - for the selected anchor only (Illustrator-style): light-blue handle bars to its in/out tips + tip squares.
 *
 * Interactions:
 *  - click an anchor → select it; drag → move it (handles ride along).
 *  - drag a handle tip → retarget the tangent; SMOOTH anchors mirror the opposite handle, Alt (or a cusp
 *    anchor) moves one side only.
 *  - double-click on a segment → insert an anchor there via an EXACT De Casteljau split (shape unchanged).
 *  - Delete/Backspace → remove the selected anchor (min 3 closed / 2 open); Escape or click empty space → exit.
 *  - Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y → undo/redo anchor edits, SESSION-SCOPED (the stack lives for one edit
 *    session and is consumed here — e.stopImmediatePropagation keeps the host's raster/3D undo routing from
 *    double-firing, the Delete-key pattern). One drag = one undo step (snapshot at drag start, committed on
 *    the first actual mutation so a plain click-select never records a no-op step).
 *  - double-click a committed Path while NOT editing → enter edit mode on it (engine-owned entry; gated off
 *    while a creator owns input — suppressBoxSelect — or `autoEnterGate` refuses, e.g. the pen tool is
 *    enabled and its dblclick means "close the polygon").
 *
 * Anchors live in the path's LOCAL space (absolute coords + the node's x/y transform on top), so pointer
 * input is inverse-transformed through the path's localMatrix before mutating — a moved/scaled path edits
 * correctly. Box-select is suppressed while active (the creator-mode pattern).
 */

import { mat4, vec4 } from "gl-matrix";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Line } from "../../scene-graph/shapes/line";
import { PathNode, type PathAnchor } from "../../scene-graph/shapes/path-node";
import { nearestTOnCubic, type Pt } from "../../scene-graph/core/bezier";
import { RGBA } from "../../types/rgba";
import { InteractionService } from "../interaction-service";

type DragState = { kind: 'anchor' | 'in' | 'out'; idx: number } | null;

export class PathEditService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private shapeFactory: ShapeFactory;

    public active = false;
    private target: PathNode | null = null;
    private selected = 0;
    private _drag: DragState = null;

    /** Staged overlay nodes: 4 lines per anchor square + the selected anchor's handle bars/tips. */
    private markerLines: Line[] = [];

    private static readonly ANCHOR_COLOR: RGBA = { r: 0.16, g: 0.50, b: 1.00, a: 1 };
    private static readonly SELECTED_COLOR: RGBA = { r: 0.16, g: 0.78, b: 0.42, a: 1 };
    private static readonly HANDLE_COLOR: RGBA = { r: 0.55, g: 0.75, b: 1.0, a: 1 };

    private onDownBound = (e: PointerEvent) => this.onDown(e);
    private onMoveBound = (e: PointerEvent) => this.onMove(e);
    private onUpBound = () => this.onUp();
    private onDblBound = (e: MouseEvent) => this.onDbl(e);
    private onKeyBound = (e: KeyboardEvent) => this.onKey(e);

    /** Fired on enter/exit and after every anchor mutation — the host refreshes its inspector off this. */
    public onEdited: ((path: PathNode | null) => void) | null = null;

    /** Extra veto on the dblclick-a-Path auto-entry (beyond suppressBoxSelect). ShapeManager wires the pen
     *  tool's isEnabled here — while it's drawing, dblclick means "close the polygon", not "edit". */
    public autoEnterGate: (() => boolean) | null = null;

    // ── Session undo (anchor edits only; cleared on enter/exit) ─────────────────────────────────────────────
    private _undoStack: PathAnchor[][] = [];
    private _redoStack: PathAnchor[][] = [];
    /** Snapshot taken at drag START; pushed onto the stack by the first real mutation of that drag. */
    private _pendingSnap: PathAnchor[] | null = null;
    private static readonly UNDO_DEPTH = 100;

    private cloneAnchors(): PathAnchor[] {
        return (this.target?.anchors ?? []).map((a) => ({
            x: a.x, y: a.y,
            in: a.in ? { x: a.in.x, y: a.in.y } : undefined,
            out: a.out ? { x: a.out.x, y: a.out.y } : undefined,
            kind: a.kind,
        }));
    }

    private pushUndo(snap: PathAnchor[]): void {
        this._undoStack.push(snap);
        if (this._undoStack.length > PathEditService.UNDO_DEPTH) this._undoStack.shift();
        this._redoStack = [];
    }

    /** Restore an anchor snapshot (a fresh deep copy each time — the node mutates its arrays in place,
     *  so handing over the stored snapshot would corrupt the stack on the next drag). */
    private applySnapshot(snap: PathAnchor[]): void {
        if (!this.target) return;
        this.target.setAnchors(snap.map((a) => ({
            x: a.x, y: a.y,
            in: a.in ? { x: a.in.x, y: a.in.y } : undefined,
            out: a.out ? { x: a.out.x, y: a.out.y } : undefined,
            kind: a.kind,
        })));
        this.selected = Math.max(0, Math.min(this.selected, this.target.anchors.length - 1));
        this.rebuildOverlay();
        this.onEdited?.(this.target);
        this.interactionService.requestRender();
    }

    private clearUndo(): void {
        this._undoStack = [];
        this._redoStack = [];
        this._pendingSnap = null;
    }

    constructor(interactionService: InteractionService, sceneGraph: SceneGraph, shapeFactory: ShapeFactory) {
        this.interactionService = interactionService;
        this.sceneGraph = sceneGraph;
        this.shapeFactory = shapeFactory;
        this.attach();
    }

    private attached = false;
    private attach(): void {
        if (this.attached) return;
        const c = this.interactionService.canvas;
        c.addEventListener("pointerdown", this.onDownBound);
        c.addEventListener("pointermove", this.onMoveBound);
        c.addEventListener("pointerup", this.onUpBound);
        c.addEventListener("dblclick", this.onDblBound);
        window.addEventListener("keydown", this.onKeyBound);
        this.attached = true;
    }
    public reinitializeEventListeners(): void {
        const c = this.interactionService.canvas;
        c.removeEventListener("pointerdown", this.onDownBound);
        c.removeEventListener("pointermove", this.onMoveBound);
        c.removeEventListener("pointerup", this.onUpBound);
        c.removeEventListener("dblclick", this.onDblBound);
        window.removeEventListener("keydown", this.onKeyBound);
        this.attached = false;
        this.attach();
    }

    // ── Enter / exit ────────────────────────────────────────────────────────────────────────────────────────

    public enter(path: PathNode): void {
        if (this.active) this.exit();
        this.active = true;
        this.target = path;
        this.selected = 0;
        this.clearUndo();
        this.interactionService.clearSelectedNodes();
        this.interactionService.suppressBoxSelect = true;
        this.rebuildOverlay();
        this.onEdited?.(path);
        this.interactionService.requestRender();
    }

    public exit(): void {
        if (!this.active) return;
        this.active = false;
        this._drag = null;
        this.clearUndo();
        this.setOverlay([]);
        this.interactionService.suppressBoxSelect = false;
        this.target = null;
        this.onEdited?.(null);
        this.interactionService.onSceneGraphChanged.emit();
    }

    public get editingPath(): PathNode | null { return this.active ? this.target : null; }
    public get selectedAnchor(): number { return this.selected; }

    // ── Space conversion + picking ──────────────────────────────────────────────────────────────────────────

    /** ~N screen px in world units (zoom-stable pick radii / marker sizes). */
    private px(n: number): number {
        const a = this.interactionService.toWorldCoordsFromCanvas(0, 0);
        const b = this.interactionService.toWorldCoordsFromCanvas(n, 0);
        return Math.hypot(b.x - a.x, b.y - a.y);
    }

    /** World → the path's LOCAL anchor space (inverse localMatrix). */
    private toLocal(wx: number, wy: number): Pt {
        const inv = mat4.create();
        if (!this.target || !mat4.invert(inv, this.target.localMatrix)) return { x: wx, y: wy };
        const v = vec4.fromValues(wx, wy, 0, 1);
        vec4.transformMat4(v, v, inv);
        return { x: v[0], y: v[1] };
    }

    /** Local anchor space → world (localMatrix). */
    private toWorld(p: Pt): Pt {
        if (!this.target) return p;
        const v = vec4.fromValues(p.x, p.y, 0, 1);
        vec4.transformMat4(v, v, this.target.localMatrix);
        return { x: v[0], y: v[1] };
    }

    private handleTip(idx: number, which: 'in' | 'out'): Pt | null {
        const a = this.target?.anchors[idx];
        const h = which === 'in' ? a?.in : a?.out;
        return a && h ? { x: a.x + h.x, y: a.y + h.y } : null;
    }

    // ── Pointer / keyboard ──────────────────────────────────────────────────────────────────────────────────

    private onDown(e: PointerEvent): void {
        if (!this.active || !this.target || e.button !== 0) return;
        const w = this.interactionService.toWorldCoords(e);
        const p = this.toLocal(w.x, w.y);
        const r = this.px(9);

        // 1) The selected anchor's handle tips grab first (they overlap the curve).
        for (const which of ['in', 'out'] as const) {
            const tip = this.handleTip(this.selected, which);
            if (tip && Math.hypot(p.x - tip.x, p.y - tip.y) <= r) {
                this._pendingSnap = this.cloneAnchors();
                this._drag = { kind: which, idx: this.selected };
                return;
            }
        }
        // 2) Any anchor: select + start moving it.
        const anchors = this.target.anchors;
        for (let i = 0; i < anchors.length; i++) {
            if (Math.hypot(p.x - anchors[i].x, p.y - anchors[i].y) <= r) {
                this.selected = i;
                this._pendingSnap = this.cloneAnchors();
                this._drag = { kind: 'anchor', idx: i };
                this.rebuildOverlay();
                this.interactionService.requestRender();
                return;
            }
        }
        // 3) On the path body OR near its outline: keep editing (a dblclick-insert's first click lands
        //    exactly ON the outline, where even-odd containsPoint is a coin flip). Truly off: exit.
        const near = this.nearestOnPath(p);
        if (!this.target.containsPoint(w.x, w.y) && !(near && near.dist <= this.px(8))) this.exit();
    }

    /** Closest point on the path outline (all segments, curves included) to a LOCAL-space point. */
    private nearestOnPath(p: Pt): { seg: number; t: number; dist: number } | null {
        if (!this.target) return null;
        const anchors = this.target.anchors;
        const n = anchors.length;
        const segCount = this.target.closed ? n : n - 1;
        let best: { seg: number; t: number; dist: number } | null = null;
        for (let i = 0; i < segCount; i++) {
            const a = anchors[i], b = anchors[(i + 1) % n];
            const c1: Pt = a.out ? { x: a.x + a.out.x, y: a.y + a.out.y } : a;
            const c2: Pt = b.in ? { x: b.x + b.in.x, y: b.y + b.in.y } : b;
            const hit = nearestTOnCubic(a, c1, c2, b, p);
            if (!best || hit.dist < best.dist) best = { seg: i, t: hit.t, dist: hit.dist };
        }
        return best;
    }

    private onMove(e: PointerEvent): void {
        if (!this.active || !this.target || !this._drag || !(e.buttons & 1)) return;
        const w = this.interactionService.toWorldCoords(e);
        const p = this.toLocal(w.x, w.y);
        // First actual mutation of this drag: the drag-start snapshot becomes one undo step.
        if (this._pendingSnap) { this.pushUndo(this._pendingSnap); this._pendingSnap = null; }
        const { kind, idx } = this._drag;
        if (kind === 'anchor') {
            this.target.moveAnchor(idx, p.x, p.y);
        } else {
            const a = this.target.anchors[idx];
            if (!a) return;
            const v: Pt = { x: p.x - a.x, y: p.y - a.y };
            const mirror = !e.altKey && a.kind !== 'cusp' && a.kind !== 'corner';
            this.target.setHandle(idx, kind, v, mirror);
        }
        this.rebuildOverlay();
        this.onEdited?.(this.target);
        this.interactionService.requestRender();
    }

    private onUp(): void {
        if (this._drag) this._drag = null;
        this._pendingSnap = null;   // click without movement → no undo step
    }

    private onDbl(e: MouseEvent): void {
        if (!this.active || !this.target) { this.tryAutoEnter(e); return; }
        const w = this.interactionService.toWorldCoords(e);
        const p = this.toLocal(w.x, w.y);
        // Nearest point across all segments; insert when within pick range.
        const best = this.nearestOnPath(p);
        if (best && best.dist <= this.px(8) && best.t > 0.02 && best.t < 0.98) {
            const snap = this.cloneAnchors();
            const newIdx = this.target.insertAnchorOnSegment(best.seg, best.t);
            if (newIdx >= 0) {
                this.pushUndo(snap);
                this.selected = newIdx;
                this.rebuildOverlay();
                this.onEdited?.(this.target);
                this.interactionService.requestRender();
            }
        }
    }

    /** Engine-owned entry: double-click a committed Path on the canvas → edit it. Respects the
     *  active-vector-layer interactivity gate; topmost (last in draw order) Path under the cursor wins. */
    private tryAutoEnter(e: MouseEvent): void {
        if (this.interactionService.suppressBoxSelect) return;   // a creator/Player mode owns input
        if (this.autoEnterGate && !this.autoEnterGate()) return;
        const w = this.interactionService.toWorldCoords(e);
        let hit: PathNode | null = null;
        const walk = (n: { children?: unknown[] }): void => {
            for (const k of (n.children ?? []) as (PathNode & { children?: unknown[] })[]) {
                if (k instanceof PathNode && !k.isStaging && !k.isPreview && k.visible !== false
                    && this.interactionService.isVectorLayerInteractive(k.layerId)
                    && k.containsPoint(w.x, w.y)) {
                    hit = k;   // keep the LAST match — later in draw order = on top
                }
                walk(k);
            }
        };
        walk(this.sceneGraph.root);
        if (hit) this.enter(hit);
    }

    private onKey(e: KeyboardEvent): void {
        if (!this.active || !this.target) return;
        if (e.key === 'Escape') { this.exit(); e.preventDefault(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            const snap = this.cloneAnchors();
            if (this.target.removeAnchor(this.selected)) {
                this.pushUndo(snap);
                this.selected = Math.min(this.selected, this.target.anchors.length - 1);
                this.rebuildOverlay();
                this.onEdited?.(this.target);
                this.interactionService.requestRender();
            }
            e.preventDefault();   // consumed: never falls through to shape deletion
            e.stopImmediatePropagation();
            return;
        }
        // Session undo/redo — consumed here so the host's raster/3D Ctrl+Z routing never double-fires.
        const mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
            const isRedo = e.key === 'y' || e.key === 'Y' || e.shiftKey;
            if (isRedo) {
                const snap = this._redoStack.pop();
                if (snap) { this._undoStack.push(this.cloneAnchors()); this.applySnapshot(snap); }
            } else {
                const snap = this._undoStack.pop();
                if (snap) { this._redoStack.push(this.cloneAnchors()); this.applySnapshot(snap); }
            }
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }

    // ── Overlay ─────────────────────────────────────────────────────────────────────────────────────────────

    /** Reconcile the staged overlay Line nodes to the wanted segment list (reuse/create/remove). */
    private setOverlay(segs: { a: Pt; b: Pt; color: RGBA; w: number }[]): void {
        const structural = this.markerLines.length !== segs.length;
        while (this.markerLines.length > segs.length) { const l = this.markerLines.pop()!; this.sceneGraph.root.removeChild(l); }
        while (this.markerLines.length < segs.length) {
            const l = this.shapeFactory.createLine(0, 0, 0, 0, PathEditService.ANCHOR_COLOR, 0.01);
            l.isStaging = true;
            this.sceneGraph.root.addChild(l);
            this.markerLines.push(l);
        }
        for (let i = 0; i < segs.length; i++) {
            const l = this.markerLines[i];
            l.updateStartPoint(segs[i].a.x, segs[i].a.y);
            l.updateEndPoint(segs[i].b.x, segs[i].b.y);
            l.strokeColor = segs[i].color;
            l.strokeWidth = segs[i].w;
            l.markDirty();
        }
        if (structural) this.interactionService.onSceneGraphChanged.emit();
    }

    private rebuildOverlay(): void {
        if (!this.target) { this.setOverlay([]); return; }
        const segs: { a: Pt; b: Pt; color: RGBA; w: number }[] = [];
        const half = this.px(5), w = this.px(1.4);
        const square = (c: Pt, h: number, color: RGBA) => {
            const pts = [
                { x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h },
                { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h },
            ];
            for (let i = 0; i < 4; i++) segs.push({ a: pts[i], b: pts[(i + 1) % 4], color, w });
        };
        this.target.anchors.forEach((a, i) => {
            square(this.toWorld(a), i === this.selected ? half * 1.2 : half,
                i === this.selected ? PathEditService.SELECTED_COLOR : PathEditService.ANCHOR_COLOR);
        });
        // Selected anchor's handles: bar to each tip + a small tip square.
        const sel = this.target.anchors[this.selected];
        if (sel) {
            for (const which of ['in', 'out'] as const) {
                const tip = this.handleTip(this.selected, which);
                if (!tip) continue;
                segs.push({ a: this.toWorld(sel), b: this.toWorld(tip), color: PathEditService.HANDLE_COLOR, w });
                square(this.toWorld(tip), half * 0.6, PathEditService.HANDLE_COLOR);
            }
        }
        this.setOverlay(segs);
    }
}
