import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Line } from "../../scene-graph/shapes/line";
import { RGBA } from "../../types/rgba";
import { InteractionService } from "../interaction-service";

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

    private startDrawingBound = (event: PointerEvent) => this.startDrawing(event);
    private updateDrawingBound = (event: PointerEvent) => this.updateDrawing(event);
    private finishDrawingBound = () => this.finishDrawing();

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
    }

    private eventListenersAttached = false;

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
        
        this.currentLine = this.shapeFactory.createLine(x, y, x + LineDrawingService.MIN_LINE_LENGTH, y + LineDrawingService.MIN_LINE_LENGTH, this.strokeColor, this.strokeWidth);
        this.currentLine.isStaging = true;

        this.sceneGraph.root.addChild(this.currentLine);

        this.isDrawing = true;
        this.interactionService.beginInteractive();
        this.interactionService.onSceneGraphChanged.emit();
    }
    
    private updateDrawing(event: PointerEvent) {
        if (!this.isDrawing || !this.currentLine) return;

        requestAnimationFrame(() => {
            const { x, y } = this.interactionService.toWorldCoords(event);
            this.currentLine?.updateEndPoint(x, y);
            this.interactionService.requestRender();
        });
    }

    private finishDrawing() {
        this.isDrawing = false;
        if(this.currentLine) {
            this.currentLine.isStaging = false;
            this.currentLine = null; 
            this.interactionService.onSceneGraphChanged.emit();
        }
        this.interactionService.endInteractive();
    }

}