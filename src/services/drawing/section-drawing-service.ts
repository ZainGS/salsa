// src/services/drawing/section-drawing-service.ts
import { InteractionService } from "../interaction-service";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { Section } from "../../scene-graph/shapes/section";
import { RGBA } from "../../types/rgba";

export class SectionDrawingService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    private shapeFactory: ShapeFactory;

    private currentSection: Section | null = null;
    public isDrawing: boolean = false;
    public isEnabled: boolean = false;

    private fillColor: RGBA = { r: 0.2, g: 0.2, b: 0.2, a: 0.3 };
    private strokeColor: RGBA = { r: 0.2, g: 0.2, b: 0.2, a: 1 };
    private strokeWidth: number = 1;

    private startX: number = 0;
    private startY: number = 0;

    private eventListenersAttached = false;
    private startDrawingBound = (event: PointerEvent) => this.startDrawing(event);
    private updateDrawingBound = (event: PointerEvent) => this.updateDrawing(event);
    private finishDrawingBound = () => this.finishDrawing();

    constructor(
        interactionService: InteractionService,
        sceneGraph: SceneGraph,
        renderStrategy: RenderStrategy,
        shapeFactory: ShapeFactory
    ) {
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

    private attachEventListeners() {
        if (this.eventListenersAttached) return;

        const canvas = this.interactionService.canvas;
        canvas.addEventListener("pointerdown", this.startDrawingBound);
        canvas.addEventListener("pointermove", this.updateDrawingBound);
        canvas.addEventListener("pointerup", this.finishDrawingBound);

        this.eventListenersAttached = true;
    }

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;

        canvas.removeEventListener("pointerdown", this.startDrawingBound);
        canvas.removeEventListener("pointermove", this.updateDrawingBound);
        canvas.removeEventListener("pointerup", this.finishDrawingBound);

        this.eventListenersAttached = false;
        this.attachEventListeners();
    }

    private startDrawing(event: PointerEvent) {
        if (!this.isEnabled || this.isDrawing || event.button !== 0) return;
    
        this.interactionService.updateWorldMatrix();
        const { x, y } = this.interactionService.toWorldCoords(event);
    
        this.startX = x;
        this.startY = y;
    
        this.currentSection = this.shapeFactory.createSection(
            x, y, 1, 1, // logical unit size
            this.fillColor,
            this.strokeColor,
            this.strokeWidth
        );
        this.currentSection.scaleX = 0.001;
        this.currentSection.scaleY = 0.001;
    
        this.sceneGraph.root.addChild(this.currentSection);
        this.isDrawing = true;
        this.interactionService.onSceneGraphChanged.emit();
    }

    private updateDrawing(event: PointerEvent) {
        if (!this.isDrawing || !this.currentSection) return;
    
        requestAnimationFrame(() => {
            const { x, y } = this.interactionService.toWorldCoords(event);
    
            const width = Math.abs(x - this.startX);
            const height = Math.abs(y - this.startY);
            const centerX = (x + this.startX) / 2;
            const centerY = (y + this.startY) / 2;
    
            this.currentSection!.x = centerX;
            this.currentSection!.y = centerY;
            this.currentSection!.scaleX = width;
            this.currentSection!.scaleY = height;
            this.currentSection!.markDirty();
        });
        this.interactionService.requestRender();
    }

    private finishDrawing() {
        this.isDrawing = false;
        this.currentSection = null;
    }

    public setFillColor(color: RGBA) {
        this.fillColor = color;
    }

    public setStrokeColor(color: RGBA) {
        this.strokeColor = color;
    }

    public setStrokeWidth(width: number) {
        this.strokeWidth = width;
    }
}