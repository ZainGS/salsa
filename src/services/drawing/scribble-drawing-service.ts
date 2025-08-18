import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Scribble } from "../../scene-graph/shapes/scribble";
import { RGBA } from "../../types/rgba";
import { EraserService } from "./eraser-service";
import { InteractionService } from "../interaction-service";
import cursorUrl from '../../assets/drawing.cur?url';

export class ScribbleDrawingService {
    private interactionService: InteractionService;
    private eraserService: EraserService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    private currentScribble: Scribble | null = null;
    public isDrawing: boolean = false;
    public isEnabled: boolean = false;
    private strokeColor: RGBA = { r: 1, g: 1, b: 1, a: 1 };
    private strokeWidth: number = 2 * .005;
    private shapeFactory: ShapeFactory;
    private eventListenersAttached = false;

    private startDrawingBound = (event: PointerEvent) => this.startDrawing(event);
    private updateDrawingBound = (event: PointerEvent) => this.updateDrawing(event);
    private finishDrawingBound = () => this.finishDrawing();

    constructor(
        interactionService: InteractionService,
        sceneGraph: SceneGraph,
        renderStrategy: RenderStrategy,
        shapeFactory: ShapeFactory,
        eraserService: EraserService,
    ) {
        this.interactionService = interactionService;
        this.eraserService = eraserService;
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
        //this.interactionService.canvas.style.cursor = 'default';
    }

    public setStrokeColor(color: RGBA) {
        this.strokeColor = color;
    }

    public setStrokeWidth(width: number) {
        this.strokeWidth = width;
    }

    private attachEventListeners() {
        if (this.eventListenersAttached) return; // Prevent multiple listeners

        const canvas = this.interactionService.canvas;
        canvas.addEventListener("pointerdown", this.startDrawingBound);
        canvas.addEventListener("pointermove", this.updateDrawingBound);
        canvas.addEventListener("pointerup", this.finishDrawingBound);

        this.eventListenersAttached = true;
    }

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;
    
        // Remove existing listeners
        canvas.removeEventListener("pointerdown", this.startDrawingBound);
        canvas.removeEventListener("pointermove", this.updateDrawingBound);
        canvas.removeEventListener("pointerup", this.finishDrawingBound);
    
        // Clear the flag so attachEventListeners can run
        this.eventListenersAttached = false;
    
        // Re-attach listeners
        this.attachEventListeners();
    }

    private startDrawing(event: PointerEvent) {
        if (!this.isEnabled || this.isDrawing || event.button !== 0) return;

        this.interactionService.updateWorldMatrix();
        const { x, y } = this.interactionService.toWorldCoords(event);

        this.currentScribble = this.shapeFactory.createScribble(x, y, this.strokeColor, this.strokeWidth);
        this.currentScribble.isStaging = true;

        this.eraserService.scribbles.push(this.currentScribble);
        this.sceneGraph.root.addChild(this.currentScribble);

        this.isDrawing = true;
        this.interactionService.beginInteractive();
        this.interactionService.onSceneGraphChanged.emit();
    }

    private updateDrawing(event: PointerEvent) {
        if(this.isEnabled) {
            this.interactionService.canvas.style.cursor = `url('${cursorUrl}'), crosshair`;
        }
        if (!this.isDrawing || !this.currentScribble) return;

        requestAnimationFrame(() => {
            const { x, y } = this.interactionService.toWorldCoords(event);
            this.currentScribble?.addPoint(x, y);
            this.interactionService.requestRender();
        });
    }

    private finishDrawing() {
        this.isDrawing = false;
        if(this.currentScribble) {
            this.currentScribble!.isStaging = false;
            this.currentScribble = null;
            this.interactionService.onSceneGraphChanged.emit();
        }
        this.interactionService.endInteractive();
    }
}