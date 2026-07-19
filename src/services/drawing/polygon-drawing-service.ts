import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Line } from "../../scene-graph/shapes/line";
import { Polygon } from "../../scene-graph/shapes/polygon";
import { RGBA } from "../../types/rgba";
import { InteractionService } from "../interaction-service";

/**
 * Freeform polygon drawing service.
 *
 * Flow:
 *  - Enable the tool, then click to place vertices.
 *  - A rubber-band line tracks the cursor from the last placed vertex.
 *  - Thin staging lines show edges already committed.
 *  - Close the polygon by:
 *      • clicking near the first vertex, or
 *      • double-clicking anywhere (auto-close back to first vertex), or
 *      • pressing Enter.
 *  - Cancel with Escape or right-click.
 *  - Minimum 3 vertices required to commit.
 */
export class PolygonDrawingService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private shapeFactory: ShapeFactory;

    public isEnabled = false;
    public isDrawing = false;

    /** World-space vertices placed so far. */
    private vertices: { x: number; y: number }[] = [];

    /** Staging lines showing already-placed edges. */
    private edgeLines: Line[] = [];

    /** Rubber-band line from last vertex to cursor. */
    private rubberBand: Line | null = null;

    /** Closing line from cursor back to first vertex (shown when ≥ 2 verts). */
    private closingLine: Line | null = null;

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
    private handleDblClickBound = (e: MouseEvent) => this.handleDblClick(e);
    private handleKeyDownBound = (e: KeyboardEvent) => this.handleKeyDown(e);

    /** Callback fired when a polygon is committed. ShapeManager hooks this. */
    public onPolygonCommitted: ((polygon: Polygon) => void) | null = null;

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

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;
        canvas.removeEventListener("pointerdown", this.handlePointerDownBound);
        canvas.removeEventListener("pointermove", this.handlePointerMoveBound);
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

    private handlePointerMove(e: PointerEvent) {
        if (!this.isDrawing || !this.rubberBand) return;

        requestAnimationFrame(() => {
            const { x, y } = this.interactionService.toWorldCoords(e);
            this.rubberBand?.updateEndPoint(x, y);

            // Update closing line from cursor back to first vertex
            if (this.closingLine && this.vertices.length >= 2) {
                this.closingLine.updateStartPoint(x, y);
            }

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
        this.interactionService.beginInteractive();

        // Create rubber-band line from first vertex to cursor
        this.rubberBand = this.shapeFactory.createLine(x, y, x, y, this.strokeColor, this.strokeWidth);
        this.rubberBand.isStaging = true;
        this.sceneGraph.root.addChild(this.rubberBand);

        this._drawFirstMarker(false);   // mark the start point (the close target)

        this.interactionService.onSceneGraphChanged.emit();
    }

    private addVertex(x: number, y: number) {
        this.vertices.push({ x, y });

        // Dot marker for the point just placed (the first vertex has its own close marker).
        this.vertexMarkers.push(...this._squareMarker(x, y, this.snapDistanceWorld() * 0.35, PolygonDrawingService.VERT_COLOR));

        // Convert the rubber-band into a permanent edge line
        if (this.rubberBand) {
            this.rubberBand.updateEndPoint(x, y);
            // Keep it as a staging edge display line
            this.edgeLines.push(this.rubberBand);
        }

        // Create new rubber-band from this vertex
        this.rubberBand = this.shapeFactory.createLine(x, y, x, y, this.strokeColor, this.strokeWidth);
        this.rubberBand.isStaging = true;
        this.sceneGraph.root.addChild(this.rubberBand);

        // Create/update closing line (from cursor back to first vertex) when we have ≥ 2 edges
        if (this.vertices.length >= 3 && !this.closingLine) {
            const first = this.vertices[0];
            this.closingLine = this.shapeFactory.createLine(x, y, first.x, first.y, this.strokeColor, this.strokeWidth);
            this.closingLine.isStaging = true;
            this.sceneGraph.root.addChild(this.closingLine);
        }

        this.interactionService.onSceneGraphChanged.emit();
    }

    private commitPolygon() {
        // Remove all staging lines
        this.removeStagingLines();

        // Create the final Polygon shape
        const polygon = this.shapeFactory.createPolygon(
            this.vertices,
            this.fillColor,
            this.strokeColor,
            this.strokeWidth,
        );
        this.sceneGraph.root.addChild(polygon);

        // Notify listeners
        this.onPolygonCommitted?.(polygon);

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
        for (const line of this.edgeLines) {
            this.sceneGraph.root.removeChild(line);
        }
        if (this.rubberBand) {
            this.sceneGraph.root.removeChild(this.rubberBand);
        }
        if (this.closingLine) {
            this.sceneGraph.root.removeChild(this.closingLine);
        }
        for (const l of this.vertexMarkers) this.sceneGraph.root.removeChild(l);
        for (const l of this.firstMarker) this.sceneGraph.root.removeChild(l);
    }

    private resetState() {
        this.vertices = [];
        this.edgeLines = [];
        this.rubberBand = null;
        this.closingLine = null;
        this.vertexMarkers = [];
        this.firstMarker = [];
        this.firstNear = false;
        this.isDrawing = false;
    }
}
