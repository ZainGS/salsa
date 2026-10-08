import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Line } from "../../scene-graph/shapes/line";
import { PathNode, type PathAnchor } from "../../scene-graph/shapes/path-node";
import { RGBA } from "../../types/rgba";
import { InteractionService } from "../interaction-service";
import { sampleCubic, penEdgeControls, type Pt } from "../../scene-graph/core/bezier";
import { recordVectorCreation } from "../vector-object-undo";

/**
 * Freeform polygon drawing service — with the PEN-TOOL curve gesture (docs/specs/vector-paths.md P0).
 *
 * Flow:
 *  - Enable the tool, then click to place vertices.
 *  - CLICK = a sharp corner vertex. CLICK + HOLD + DRAG = pull out mirrored Bézier handles at that vertex:
 *    the drag vector becomes the OUT-handle, its mirror the IN-handle, so adjacent edges curve smoothly
 *    through the point (cubic segments via penEdgeControls). Since P1 the commit is a true PathNode —
 *    anchors + handles persist as source data and the node tessellates itself (adaptive De Casteljau).
 *  - A rubber-band tracks the cursor from the last placed vertex (curved when that vertex has a handle).
 *  - Thin staging lines show edges already committed; blue squares mark vertices; the green square on the
 *    FIRST vertex is the click-to-close target.
 *  - Close by: clicking near the first vertex, double-clicking, or pressing Enter (min 3 vertices).
 *  - Cancel with Escape or right-click.
 */
export class PolygonDrawingService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private shapeFactory: ShapeFactory;

    public isEnabled = false;
    public isDrawing = false;

    /** World-space vertices placed so far. */
    private vertices: { x: number; y: number }[] = [];
    /** Pen-gesture OUT-handle per vertex (mirrored in-handle is implied); null = sharp corner. */
    private handles: (Pt | null)[] = [];

    /** Staged preview lines per committed edge (edge i = vertices[i] → vertices[i+1]): 1 line when straight,
     *  CURVE_SEGS short lines when either endpoint carries a handle. */
    private edgeSegs: Line[][] = [];

    /** Rubber-band from last vertex to cursor — 1 line, or CURVE_SEGS when the last vertex has a handle. */
    private rubberSegs: Line[] = [];

    /** Auto-close GHOST: a thin dashed line from the cursor back to the first vertex (shown from the 3rd
     *  vertex on). Dashed + dimmer + half-width so it reads as "where closing WOULD go", never as a committed
     *  edge — the staging pipeline has no dash support, so the dashes are CLOSE_DASHES tiny staged Lines. */
    private closingSegs: Line[] = [];
    private static readonly CLOSE_DASHES = 12;
    private static readonly CLOSE_GHOST_COLOR: RGBA = { r: 0.45, g: 0.45, b: 0.45, a: 0.8 };

    /** In-flight handle drag: pointer still held after placing vertices[idx]. */
    private _drag: { idx: number; active: boolean } | null = null;
    /** The dragged handle's visual: one staged line through the anchor (−out → +out). */
    private handleIndicator: Line[] = [];

    /** Preview sampling density for a curved edge (fixed — commit re-flattens adaptively). */
    private static readonly CURVE_SEGS = 16;
    private static readonly HANDLE_COLOR: RGBA = { r: 0.55, g: 0.75, b: 1.0, a: 1 };

    /** Small square markers at each PLACED vertex, so the points you've clicked are visible. */
    private vertexMarkers: Line[] = [];
    /** The FIRST vertex's marker — kept separate so it can highlight as the "click here to close" target. */
    private firstMarker: Line[] = [];
    private firstNear = false;

    // Construction-overlay marker colours.
    private static readonly VERT_COLOR: RGBA  = { r: 0.16, g: 0.50, b: 1.00, a: 1 };  // placed points (blue)
    private static readonly CLOSE_COLOR: RGBA = { r: 0.16, g: 0.78, b: 0.42, a: 1 };  // first vertex — close target (green)
    private static readonly CLOSE_HL: RGBA    = { r: 0.35, g: 1.00, b: 0.55, a: 1 };  // first vertex, cursor within snap (bright)

    private fillColor: RGBA = { r: 0.85, g: 0.85, b: 0.85, a: 1 };
    private strokeColor: RGBA = { r: 0.6, g: 0.6, b: 0.6, a: 1 };
    private strokeWidth: number = 2 * 0.005;

    private handlePointerDownBound = (e: PointerEvent) => this.handlePointerDown(e);
    private handlePointerMoveBound = (e: PointerEvent) => this.handlePointerMove(e);
    private handlePointerUpBound = (e: PointerEvent) => this.handlePointerUp(e);
    private handleDblClickBound = (e: MouseEvent) => this.handleDblClick(e);
    private handleKeyDownBound = (e: KeyboardEvent) => this.handleKeyDown(e);

    /** Callback fired when the shape is committed (a PathNode since P1). ShapeManager hooks this. */
    public onPolygonCommitted: ((shape: PathNode) => void) | null = null;

    constructor(
        interactionService: InteractionService,
        sceneGraph: SceneGraph,
        shapeFactory: ShapeFactory,
    ) {
        this.interactionService = interactionService;
        this.sceneGraph = sceneGraph;
        this.shapeFactory = shapeFactory;
        this.attachEventListeners();
    }

    // ── Public API ──────────────────────────────────────────────────

    public enable() {
        this.isEnabled = true;
        this.interactionService.clearSelectedNodes();
    }

    public disable() {
        this.isEnabled = false;
        if (this.isDrawing) this.cancelDrawing();
    }

    public setColors(fill: RGBA, stroke: RGBA, strokeWidth: number) {
        this.fillColor = fill;
        this.strokeColor = stroke;
        this.strokeWidth = strokeWidth;
    }

    /** The fill a committed polygon gets — ShapeManager.setShapeColor feeds the host's current (pen) colour here,
     *  the same colour the rectangle / ellipse / triangle tools fill with. (A closed path renders fill only.) */
    public setFillColor(fill: RGBA) {
        this.fillColor = fill;
    }

    /** The fill the next committed polygon will get (a copy). */
    public getFillColor(): RGBA {
        return { ...this.fillColor };
    }

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;
        canvas.removeEventListener("pointerdown", this.handlePointerDownBound);
        canvas.removeEventListener("pointermove", this.handlePointerMoveBound);
        canvas.removeEventListener("pointerup", this.handlePointerUpBound);
        canvas.removeEventListener("dblclick", this.handleDblClickBound);
        window.removeEventListener("keydown", this.handleKeyDownBound);
        this.eventListenersAttached = false;
        this.attachEventListeners();
    }

    // ── Event wiring ────────────────────────────────────────────────

    private eventListenersAttached = false;

    private attachEventListeners() {
        if (this.eventListenersAttached) return;
        const canvas = this.interactionService.canvas;
        canvas.addEventListener("pointerdown", this.handlePointerDownBound);
        canvas.addEventListener("pointermove", this.handlePointerMoveBound);
        canvas.addEventListener("pointerup", this.handlePointerUpBound);
        canvas.addEventListener("dblclick", this.handleDblClickBound);
        window.addEventListener("keydown", this.handleKeyDownBound);
        this.eventListenersAttached = true;
    }

    // ── Handlers ────────────────────────────────────────────────────

    private handlePointerDown(e: PointerEvent) {
        if (!this.isEnabled) return;

        // Right-click → cancel
        if (e.button === 2 && this.isDrawing) {
            e.preventDefault();
            this.cancelDrawing();
            return;
        }
        if (e.button !== 0) return;

        const { x, y } = this.interactionService.toWorldCoords(e);
        const snap = this.snapDistanceWorld();

        if (!this.isDrawing) {
            // ── First click: start drawing ──
            this.startDrawing(x, y);
            this._drag = { idx: 0, active: false };   // hold+drag now pulls out this vertex's handles
            return;
        }

        // ── Subsequent clicks ──
        // Close if clicking near the FIRST vertex (and we have ≥ 3 points).
        if (this.vertices.length >= 3) {
            const first = this.vertices[0];
            if (Math.hypot(x - first.x, y - first.y) <= snap) {
                this.commitPolygon();
                return;
            }
        }

        // Ignore a click landing on top of the LAST vertex — that's the 2nd press of a double-click (or an
        // accidental double-tap); adding it would drop a spurious duplicate point. Replaces the old
        // `e.detail >= 2` skip, which swallowed ALL fast clicks (detail counts rapid clicks) so you could
        // barely place a second point.
        const last = this.vertices[this.vertices.length - 1];
        if (last && Math.hypot(x - last.x, y - last.y) <= snap) return;

        this.addVertex(x, y);
        this._drag = { idx: this.vertices.length - 1, active: false };   // pen gesture: keep holding to curve
    }

    /** Pointer released — finalize an in-flight handle drag (a tiny drag = plain click = corner vertex). */
    private handlePointerUp(_e: PointerEvent) {
        if (!this.isDrawing || !this._drag) return;
        const { idx, active } = this._drag;
        this._drag = null;
        if (!active) this.handles[idx] = null;
        this._setPolyline(this.handleIndicator, []);   // hide the handle bar once released
        // Rebuild the rubber band from this vertex so it curves out of the new handle (or stays straight).
        if (idx === this.vertices.length - 1) this._updateRubber(this.vertices[idx].x, this.vertices[idx].y);
        this.interactionService.onSceneGraphChanged.emit();
    }

    /** ~12 screen pixels expressed in WORLD units — so close/dedup snapping feels the same at any zoom. (The
     *  old fixed threshold of 15 was in world units ≈ 15× the whole visible canvas, so every 4th click
     *  auto-closed into a triangle.) */
    private snapDistanceWorld(): number {
        const a = this.interactionService.toWorldCoordsFromCanvas(0, 0);
        const b = this.interactionService.toWorldCoordsFromCanvas(12, 0);
        return Math.hypot(b.x - a.x, b.y - a.y);
    }

    /** A small axis-aligned square from 4 staging lines, centred at (cx,cy) — used for vertex + close markers. */
    private _squareMarker(cx: number, cy: number, half: number, color: RGBA): Line[] {
        const p = [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]];
        const w = this.snapDistanceWorld() / 6;
        const out: Line[] = [];
        for (let i = 0; i < 4; i++) {
            const a = p[i], b = p[(i + 1) % 4];
            const l = this.shapeFactory.createLine(a[0], a[1], b[0], b[1], color, w);
            l.isStaging = true;
            this.sceneGraph.root.addChild(l);
            out.push(l);
        }
        return out;
    }

    /** (Re)draw the first-vertex marker — the "click here to close" target. Brighter + larger when the cursor
     *  is within snap range (`near`). */
    private _drawFirstMarker(near: boolean): void {
        for (const l of this.firstMarker) this.sceneGraph.root.removeChild(l);
        this.firstMarker = [];
        if (!this.vertices.length) return;
        const first = this.vertices[0];
        const snap = this.snapDistanceWorld();
        this.firstMarker = this._squareMarker(first.x, first.y, snap * (near ? 0.7 : 0.5),
            near ? PolygonDrawingService.CLOSE_HL : PolygonDrawingService.CLOSE_COLOR);
    }

    // ── Staged-polyline plumbing (the curve preview is many short staged Lines) ─────────────────────────────

    /** Make `lines` render exactly the polyline `pts` (n−1 staged segments): reuse existing Line nodes,
     *  create/remove to match, and update endpoints in place. `pts: []` clears. */
    private _setPolyline(lines: Line[], pts: Pt[], color = this.strokeColor, width = this.strokeWidth): void {
        const need = Math.max(0, pts.length - 1);
        const structural = lines.length !== need;
        while (lines.length > need) { const l = lines.pop()!; this.sceneGraph.root.removeChild(l); }
        while (lines.length < need) {
            const l = this.shapeFactory.createLine(0, 0, 0, 0, color, width);
            l.isStaging = true;
            this.sceneGraph.root.addChild(l);
            lines.push(l);
        }
        for (let i = 0; i < need; i++) {
            lines[i].updateStartPoint(pts[i].x, pts[i].y);
            lines[i].updateEndPoint(pts[i + 1].x, pts[i + 1].y);
        }
        // Nodes were added/removed → the renderer's render list must rebuild, or the new segments are
        // invisible until some other structural event fires (endpoint-only updates don't need this).
        if (structural) this.interactionService.onSceneGraphChanged.emit();
    }

    /** Preview points for the edge a→b honoring the pen handles (straight = 2 points, curved = CURVE_SEGS+1). */
    private _edgePreviewPts(a: Pt, aOut: Pt | null, b: Pt, bOut: Pt | null): Pt[] {
        const { c1, c2, curved } = penEdgeControls(a, aOut, b, bOut);
        return curved ? sampleCubic(a, c1, c2, b, PolygonDrawingService.CURVE_SEGS) : [a, b];
    }

    /** Re-preview committed edge i (vertices[i] → vertices[i+1]) — called when a handle at either end changes. */
    private _updateEdge(i: number): void {
        if (i < 0 || i + 1 >= this.vertices.length) return;
        this._setPolyline(this.edgeSegs[i],
            this._edgePreviewPts(this.vertices[i], this.handles[i], this.vertices[i + 1], this.handles[i + 1]));
    }

    /** Rubber band: last vertex → cursor, curving out of the last vertex's handle. */
    private _updateRubber(cx: number, cy: number): void {
        const last = this.vertices[this.vertices.length - 1];
        if (!last) return;
        this._setPolyline(this.rubberSegs, this._edgePreviewPts(last, this.handles[this.vertices.length - 1], { x: cx, y: cy }, null));
    }

    /** The dashed auto-close ghost: cursor → first vertex as CLOSE_DASHES fixed dashes (constant node count,
     *  so pointer-moves only update endpoints — no structural churn). Dash length scales with distance. */
    private _updateClosing(cx: number, cy: number): void {
        if (this.vertices.length < 3) return;
        const first = this.vertices[0];
        const dx = first.x - cx, dy = first.y - cy;
        const N = PolygonDrawingService.CLOSE_DASHES;
        const structural = this.closingSegs.length !== N;
        while (this.closingSegs.length < N) {
            const l = this.shapeFactory.createLine(0, 0, 0, 0, PolygonDrawingService.CLOSE_GHOST_COLOR, this.strokeWidth * 0.5);
            l.isStaging = true;
            this.sceneGraph.root.addChild(l);
            this.closingSegs.push(l);
        }
        const period = 1 / N, fill = 0.55;   // 55% dash, 45% gap
        for (let i = 0; i < N; i++) {
            const t0 = i * period, t1 = t0 + period * fill;
            this.closingSegs[i].updateStartPoint(cx + dx * t0, cy + dy * t0);
            this.closingSegs[i].updateEndPoint(cx + dx * t1, cy + dy * t1);
        }
        if (structural) this.interactionService.onSceneGraphChanged.emit();
    }

    private handlePointerMove(e: PointerEvent) {
        if (!this.isDrawing) return;

        requestAnimationFrame(() => {
            if (!this.isDrawing) return;
            const { x, y } = this.interactionService.toWorldCoords(e);

            // ── Pen gesture: pointer held after placing a vertex → drag out mirrored handles ──
            if (this._drag && (e.buttons & 1)) {
                const idx = this._drag.idx;
                const v = this.vertices[idx];
                const out: Pt = { x: x - v.x, y: y - v.y };
                if (!this._drag.active && Math.hypot(out.x, out.y) > this.snapDistanceWorld() * 0.4) this._drag.active = true;
                if (this._drag.active) {
                    this.handles[idx] = out;
                    // Handle bar: a line through the anchor from −out to +out.
                    this._setPolyline(this.handleIndicator,
                        [{ x: v.x - out.x, y: v.y - out.y }, { x: v.x + out.x, y: v.y + out.y }],
                        PolygonDrawingService.HANDLE_COLOR, this.snapDistanceWorld() / 8);
                    this._updateEdge(idx - 1);                       // incoming edge curves with the mirrored in-handle
                    if (idx === this.vertices.length - 1) this._setPolyline(this.rubberSegs, []);   // rubber pauses during the drag
                    this.interactionService.requestRender();
                    return;
                }
            } else if (this._drag && !(e.buttons & 1)) {
                // Missed pointerup (released off-canvas) — finalize as a corner.
                if (!this._drag.active) this.handles[this._drag.idx] = null;
                this._drag = null;
                this._setPolyline(this.handleIndicator, []);
            }

            this._updateRubber(x, y);
            this._updateClosing(x, y);   // dashed ghost: cursor → first vertex

            // Emphasise the first-vertex marker when the cursor is close enough to CLOSE there (≥ 3 verts).
            if (this.vertices.length >= 3) {
                const first = this.vertices[0];
                const near = Math.hypot(x - first.x, y - first.y) <= this.snapDistanceWorld();
                if (near !== this.firstNear) { this.firstNear = near; this._drawFirstMarker(near); }
            }

            this.interactionService.requestRender();
        });
    }

    private handleDblClick(_e: MouseEvent) {
        if (!this.isDrawing) return;
        // Double-click → close the polygon if we have enough vertices
        if (this.vertices.length >= 3) {
            this.commitPolygon();
        }
    }

    private handleKeyDown(e: KeyboardEvent) {
        if (!this.isDrawing) return;
        if (e.key === 'Escape') {
            this.cancelDrawing();
        } else if (e.key === 'Enter' && this.vertices.length >= 3) {
            this.commitPolygon();
        }
    }

    // ── Drawing lifecycle ───────────────────────────────────────────

    private startDrawing(x: number, y: number) {
        this.isDrawing = true;
        this.vertices = [{ x, y }];
        this.handles = [null];
        this.interactionService.beginInteractive();

        this._updateRubber(x, y);       // degenerate until the cursor moves
        this._drawFirstMarker(false);   // mark the start point (the close target)

        this.interactionService.onSceneGraphChanged.emit();
    }

    private addVertex(x: number, y: number) {
        this.vertices.push({ x, y });
        this.handles.push(null);

        // Dot marker for the point just placed (the first vertex has its own close marker).
        this.vertexMarkers.push(...this._squareMarker(x, y, this.snapDistanceWorld() * 0.35, PolygonDrawingService.VERT_COLOR));

        // Freeze the just-completed edge (prev → this vertex, curved if prev carries a handle) by HANDING the
        // rubber-band's staged nodes to the edge — resetting the array without transferring leaks the nodes.
        const i = this.vertices.length - 2;
        this.edgeSegs[i] = this.rubberSegs;
        this._updateEdge(i);

        // Fresh rubber-band from this vertex (degenerate until the cursor moves again).
        this.rubberSegs = [];
        this._updateRubber(x, y);
        this._updateClosing(x, y);   // dashed ghost appears from the 3rd vertex on

        this.interactionService.onSceneGraphChanged.emit();
    }

    private commitPolygon() {
        // P1 (docs/specs/vector-paths.md): commit a true PathNode — anchors + handles PERSIST as source data
        // (the P2 node editor re-drags them); the node tessellates itself for fill/hit-test/selection.
        const anchors: PathAnchor[] = this.vertices.map((v, i) => {
            const out = this.handles[i];
            return out
                ? { x: v.x, y: v.y, out: { x: out.x, y: out.y }, in: { x: -out.x, y: -out.y }, kind: 'smooth' as const }
                : { x: v.x, y: v.y, kind: 'corner' as const };
        });

        // Remove all staging lines
        this.removeStagingLines();

        // Copies: each polygon owns its colours (a later in-place recolour of one must not reach the others).
        const path = this.shapeFactory.createPath(
            anchors,
            true,
            { ...this.fillColor },
            { ...this.strokeColor },
            this.strokeWidth,
        );
        this.sceneGraph.root.addChild(path);
        // ONE 2D undo step: Ctrl+Z takes the polygon off again, redo puts the same instance back.
        recordVectorCreation(this.interactionService.vectorUndo, this.sceneGraph.root, [path], 'Draw polygon');

        // Notify listeners
        this.onPolygonCommitted?.(path);

        this.resetState();
        this.interactionService.onSceneGraphChanged.emit();
        this.interactionService.endInteractive();
    }

    private cancelDrawing() {
        this.removeStagingLines();
        this.resetState();
        this.interactionService.onSceneGraphChanged.emit();
        this.interactionService.endInteractive();
    }

    private removeStagingLines() {
        for (const seg of this.edgeSegs) for (const line of seg) this.sceneGraph.root.removeChild(line);
        for (const line of this.rubberSegs) this.sceneGraph.root.removeChild(line);
        for (const line of this.handleIndicator) this.sceneGraph.root.removeChild(line);
        for (const line of this.closingSegs) this.sceneGraph.root.removeChild(line);
        for (const l of this.vertexMarkers) this.sceneGraph.root.removeChild(l);
        for (const l of this.firstMarker) this.sceneGraph.root.removeChild(l);
    }

    private resetState() {
        this.vertices = [];
        this.handles = [];
        this.edgeSegs = [];
        this.rubberSegs = [];
        this.handleIndicator = [];
        this._drag = null;
        this.closingSegs = [];
        this.vertexMarkers = [];
        this.firstMarker = [];
        this.firstNear = false;
        this.isDrawing = false;
    }
}
