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
    private handleKeyDownBound = (event: KeyboardEvent) => this.handleKeyDown(event);

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
        window.addEventListener("keydown", this.handleKeyDownBound);

        this.eventListenersAttached = true;
    }

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;
    
        canvas.removeEventListener("pointerdown", this.handlePointerDownBound);
        canvas.removeEventListener("pointermove", this.handlePointerMoveBound);
        window.removeEventListener("keydown", this.handleKeyDownBound);
    
        this.eventListenersAttached = false;
        this.attachEventListeners();
    }

    // ── Click-click drawing flow ────────────────────────────────────
    //  1st click  → create line, start drawing
    //  move       → update endpoint in real time
    //  2nd click  → commit line
    //  Escape     → cancel drawing

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
            // ── First click: start a new line ──
            this.startDrawing(event);
        } else {
            // ── Second click: finish the line ──
            this.finishDrawing(event);
        }
    }

    private handlePointerMove(event: PointerEvent) {
        if (!this.isDrawing || !this.currentLine) return;

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
        this.isDrawing = false;
        this.currentLine = null;
        this.interactionService.onSceneGraphChanged.emit();
        this.interactionService.endInteractive();
    }

    /** Cancel the current line drawing (e.g. on Escape). */
    private cancelDrawing() {
        if (this.currentLine) {
            this.sceneGraph.root.removeChild(this.currentLine);
            this.currentLine = null;
        }
        this.isDrawing = false;
        this.interactionService.onSceneGraphChanged.emit();
        this.interactionService.endInteractive();
    }

}