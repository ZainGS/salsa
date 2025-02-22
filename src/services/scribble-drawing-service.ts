import { RenderStrategy } from "../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Scribble } from "../scene-graph/shapes/scribble";
import { RGBA } from "../types/rgba";
import { EraserService } from "./eraser-service";
import { InteractionService } from "./interaction-service";

export class ScribbleDrawingService {
    private interactionService: InteractionService;
    private eraserService: EraserService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    private currentScribble: Scribble | null = null;
    public isDrawing: boolean = false;
    public isEnabled: boolean = false;
    private strokeColor: RGBA = { r: 1, g: 1, b: 1, a: 1 };
    private strokeWidth: number = 2;
    private shapeFactory: ShapeFactory;
    private eventListenersAttached = false;

    constructor(
        interactionService: InteractionService,
        sceneGraph: SceneGraph,
        renderStrategy: RenderStrategy,
        shapeFactory: ShapeFactory,
        eraserService: EraserService
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
    }

    public disable() {
        this.isEnabled = false;
    }

    public setStrokeColor(color: RGBA) {
        this.strokeColor = color;
    }

    private attachEventListeners() {
        if (this.eventListenersAttached) return; // Prevent multiple listeners

        const canvas = this.interactionService.canvas;
        canvas.addEventListener("mousedown", (event) => this.startDrawing(event));
        canvas.addEventListener("mousemove", (event) => this.updateDrawing(event));
        canvas.addEventListener("mouseup", () => this.finishDrawing());

        this.eventListenersAttached = true;
    }

    private startDrawing(event: MouseEvent) {
        if (!this.isEnabled || this.isDrawing || event.button !== 0) return;

        this.interactionService.updateWorldMatrix();
        const { x, y } = this.interactionService.toWorldCoords(event);

        // Create new scribble shape
        this.currentScribble = this.shapeFactory.createScribble(
            x, y, this.strokeColor, this.strokeWidth
        );

        this.eraserService.scribbles.push(this.currentScribble);
        this.sceneGraph.root.addChild(this.currentScribble);
        this.isDrawing = true;
    }

    private updateDrawing(event: MouseEvent) {
        if (!this.isDrawing || !this.currentScribble) return;

        requestAnimationFrame(() => {
            const { x, y } = this.interactionService.toWorldCoords(event);
            this.currentScribble?.addPoint(x, y);
        });
    }

    private finishDrawing() {
        this.isDrawing = false;
        this.currentScribble = null;
    }
}