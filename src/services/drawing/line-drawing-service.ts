import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Line, ArrowheadStyle } from "../../scene-graph/shapes/line";
import { RGBA } from "../../types/rgba";
import { InteractionService } from "../interaction-service";
import { ConnectorService } from "../connector-service";

export class LineDrawingService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    private currentLine: Line | null = null;
    public  isDrawing: boolean = false;
    private strokeColor: RGBA = { r: .6, g: .6, b: .6, a: 1 };
    private strokeWidth: number = 2 * .005;
    private static readonly MIN_LINE_LENGTH: number = 0.001;
    public  isEnabled: boolean = false;
    private shapeFactory: ShapeFactory;

    /** Optional connector service for snap-to-port behavior. */
    private connectorService: ConnectorService | null = null;

    /** Default arrowhead style for newly drawn lines. */
    public defaultArrowStart: ArrowheadStyle = 'none';
    public defaultArrowEnd: ArrowheadStyle = 'none';

    private handlePointerDownBound = (event: PointerEvent) => this.handlePointerDown(event);
    private handlePointerMoveBound = (event: PointerEvent) => this.handlePointerMove(event);
    private handlePointerUpBound = (event: PointerEvent) => this.handlePointerUp(event);
    private handleKeyDownBound = (event: KeyboardEvent) => this.handleKeyDown(event);

    /** Screen distance (CSS px) a press must travel before its release finishes the line (press-drag-release);
     *  a shorter press is a click and the line waits for a second click. A finger gets more slack. */
    public static readonly DRAG_PX = 6;
    public static readonly TOUCH_DRAG_PX = 10;
    /** The press that started the current line (null once the line is in click-click mode or finished). */
    private _press: { pointerId: number; clientX: number; clientY: number; slop: number; dragged: boolean } | null = null;
    /** Undo capture for the line being drawn (one 'Draw line' step on finish). */
    private _undoToken: ReturnType<InteractionService['vectorUndo']['begin']> | null = null;

    /** Stroke colour for new lines / arrows (the host's current colour). */
    public setStrokeColor(color: RGBA): void {
        this.strokeColor = { ...color };
    }
    public getStrokeColor(): RGBA { return { ...this.strokeColor }; }

    constructor(interactionService: InteractionService, 
                sceneGraph: SceneGraph, 
                renderStrategy: RenderStrategy, 
                shapeFactory: ShapeFactory) {
        this.interactionService = interactionService;
        this.sceneGraph = sceneGraph;
        this.renderStrategy = renderStrategy;
        this.shapeFactory = shapeFactory;
        this.attachEventListeners();
    }

    public enable() {
        this.isEnabled = true;
        this.interactionService.clearSelectedNodes();
    }

    public disable() {
        this.isEnabled = false;
        // If we're mid-draw when disabled, cancel
        if (this.isDrawing) this.cancelDrawing();
    }

    /** Attach a ConnectorService for snap-to-port during line drawing. */
    public setConnectorService(cs: ConnectorService): void {
        this.connectorService = cs;
    }

    private eventListenersAttached = false;

    private attachEventListeners() {
        if (this.eventListenersAttached) return;

        const canvas = this.interactionService.canvas;
        canvas.addEventListener("pointerdown", this.handlePointerDownBound);
        canvas.addEventListener("pointermove", this.handlePointerMoveBound);
        // The release may land off the canvas (a drag past its edge): listen on the window.
        window.addEventListener("pointerup", this.handlePointerUpBound);
        window.addEventListener("keydown", this.handleKeyDownBound);

        this.eventListenersAttached = true;
    }

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;
    
        canvas.removeEventListener("pointerdown", this.handlePointerDownBound);
        canvas.removeEventListener("pointermove", this.handlePointerMoveBound);
        window.removeEventListener("pointerup", this.handlePointerUpBound);
        window.removeEventListener("keydown", this.handleKeyDownBound);

        this.eventListenersAttached = false;
        this.attachEventListeners();
    }

    // ── Drawing flow (UI review 2026-10-07 §2b / §3 #12) ────────────
    //  press-drag-release → the line runs from the press to the release (one gesture)
    //  click, move, click → click-click still works: a press that doesn't travel DRAG_PX
    //                       leaves the line following the pointer until the next press
    //  Escape / right-click → cancel drawing

    private handlePointerDown(event: PointerEvent) {
        if (!this.isEnabled) return;

        // Right-click cancels current drawing
        if (event.button === 2 && this.isDrawing) {
            event.preventDefault();
            this.cancelDrawing();
            return;
        }

        if (event.button !== 0) return;

        if (!this.isDrawing) {
            // ── Press: start a new line (finished by this press's release after a drag, or by a 2nd click) ──
            this.startDrawing(event);
            this._press = {
                pointerId: event.pointerId,
                clientX: event.clientX, clientY: event.clientY,
                slop: event.pointerType === 'touch' ? LineDrawingService.TOUCH_DRAG_PX : LineDrawingService.DRAG_PX,
                dragged: false,
            };
        } else if (this._press && event.pointerId !== this._press.pointerId) {
            // A second finger mid-drag (a pinch): drop the half-made line instead of finishing it there.
            this.cancelDrawing();
        } else {
            // ── Second click: finish the line ──
            this.finishDrawing(event);
        }
    }

    /** The press that started the line is released: after a drag it finishes the line there (press-drag-release);
     *  a click (no drag) leaves the line following the pointer for click-click. */
    private handlePointerUp(event: PointerEvent) {
        const press = this._press;
        if (!press || event.pointerId !== press.pointerId) return;
        this._press = null;
        if (!this.isEnabled || !this.isDrawing) return;
        const dragged = press.dragged || Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) >= press.slop;
        if (dragged) this.finishDrawing(event);
    }

    private handlePointerMove(event: PointerEvent) {
        if (!this.isDrawing || !this.currentLine) return;
        const press = this._press;
        if (press && !press.dragged && event.pointerId === press.pointerId &&
            Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) >= press.slop) {
            press.dragged = true;
        }

        requestAnimationFrame(() => {
            let { x, y } = this.interactionService.toWorldCoords(event);

            // Snap end point to nearest connection port
            const snap = this.connectorService?.findSnapTarget(x, y, this.currentLine?.id);
            if (snap) {
                x = snap.x;
                y = snap.y;
            }

            this.currentLine?.updateEndPoint(x, y);
            this.interactionService.requestRender();
        });
    }

    private handleKeyDown(event: KeyboardEvent) {
        if (event.key === 'Escape' && this.isDrawing) {
            this.cancelDrawing();
        }
    }

    private startDrawing(event: PointerEvent) {
        this.interactionService.updateWorldMatrix();
        let { x, y } = this.interactionService.toWorldCoords(event);

        // Snap start point to nearest connection port
        const startSnap = this.connectorService?.findSnapTarget(x, y);
        if (startSnap) {
            x = startSnap.x;
            y = startSnap.y;
        }
        
        this.currentLine = this.shapeFactory.createLine(
            x, y,
            x + LineDrawingService.MIN_LINE_LENGTH,
            y + LineDrawingService.MIN_LINE_LENGTH,
            this.strokeColor, this.strokeWidth
        );
        this.currentLine.isStaging = true;
        this.currentLine.arrowStart = this.defaultArrowStart;
        this.currentLine.arrowEnd = this.defaultArrowEnd;
        // One undo step for the finished line (begin before it is attached: the commit sees it as added)
        this._undoToken = this.interactionService.vectorUndo?.begin(this.sceneGraph.root, []) ?? null;

        // Bind start if snapped
        if (startSnap) {
            this.currentLine.startBinding = { shapeId: startSnap.shapeId, portId: startSnap.portId };
        }

        this.sceneGraph.root.addChild(this.currentLine);

        this.isDrawing = true;
        this.interactionService.beginInteractive();
        this.interactionService.onSceneGraphChanged.emit();
    }

    private finishDrawing(event: PointerEvent) {
        if (!this.currentLine) return;

        // Snap the end point at the click location
        let { x, y } = this.interactionService.toWorldCoords(event);
        const endSnap = this.connectorService?.findSnapTarget(x, y, this.currentLine.id);
        if (endSnap) {
            x = endSnap.x;
            y = endSnap.y;
        }
        this.currentLine.updateEndPoint(x, y);

        // Bind end if snapped
        if (endSnap) {
            this.currentLine.endBinding = { shapeId: endSnap.shapeId, portId: endSnap.portId };
        }

        this.currentLine.isStaging = false;
        const line = this.currentLine;
        this.isDrawing = false;
        this.currentLine = null;
        this._press = null;
        if (this._undoToken) {
            this.interactionService.vectorUndo.commit(this._undoToken, 'Draw line', [line]);
            this._undoToken = null;
        }
        this.interactionService.onSceneGraphChanged.emit();
        this.interactionService.endInteractive();
    }

    /** Cancel the current line drawing (e.g. on Escape). */
    private cancelDrawing() {
        if (this.currentLine) {
            this.sceneGraph.root.removeChild(this.currentLine);
            this.currentLine = null;
        }
        this._press = null;
        this._undoToken = null;
        this.isDrawing = false;
        this.interactionService.onSceneGraphChanged.emit();
        this.interactionService.endInteractive();
    }

}