import { mat4 } from "gl-matrix";
import { RenderStrategy } from "../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Pattern } from "../scene-graph/shapes/pattern";
import { RGBA } from "../types/rgba";
import { InteractionService } from "./interaction-service";

export class PatternDrawingService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    private currentPattern: Pattern | null = null;
    public  isDrawing: boolean = false;
    private strokeColor: RGBA = { r: .6, g: .6, b: .6, a: 1 };
    private pattern: string = "";
    private strokeWidth: number = 2;
    public  isEnabled: boolean = false;
    private shapeFactory: ShapeFactory;
    public device: GPUDevice;

    private startDrawingBound = (event: MouseEvent) => this.startDrawing(event);
    private updateDrawingBound = (event: MouseEvent) => this.updateDrawing(event);
    private finishDrawingBound = () => this.finishDrawing();

    constructor(interactionService: InteractionService, 
                sceneGraph: SceneGraph, 
                renderStrategy: RenderStrategy, 
                shapeFactory: ShapeFactory,
                device: GPUDevice) {
        this.interactionService = interactionService;
        this.sceneGraph = sceneGraph;
        this.renderStrategy = renderStrategy;
        this.shapeFactory = shapeFactory;
        this.device = device;
        this.attachEventListeners();
    }

    public enable() {
        this.isEnabled = true;
        this.interactionService.deselectSelectedNode();
    }

    public disable() {
        this.isEnabled = false;
    }

    public setPattern(pattern: string) {
        this.pattern = pattern;
    }

    private eventListenersAttached = false;

    private attachEventListeners() {
        if (this.eventListenersAttached) return; // Prevent multiple listeners

        const canvas = this.interactionService.canvas;
        canvas.addEventListener("mousedown", this.startDrawingBound);
        canvas.addEventListener("mousemove", this.updateDrawingBound);
        canvas.addEventListener("mouseup", this.finishDrawingBound);

        this.eventListenersAttached = true;
    }

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;
    
        // Remove existing listeners
        canvas.removeEventListener("mousedown", this.startDrawingBound);
        canvas.removeEventListener("mousemove", this.updateDrawingBound);
        canvas.removeEventListener("mouseup", this.finishDrawingBound);
    
        // Clear the flag so attachEventListeners can run
        this.eventListenersAttached = false;
    
        // Re-attach listeners
        this.attachEventListeners();
    }

    private startDrawing(event: MouseEvent) {
        if (!this.isEnabled || this.isDrawing || event.button !== 0) return;
        this.interactionService.updateWorldMatrix();
        const { x, y } = this.interactionService.toWorldCoords(event);
        
        this.currentPattern = this.shapeFactory.createPattern(x,y,x,y,this.strokeColor,10,this.pattern, this.device)
        this.sceneGraph.root.addChild(this.currentPattern);
        this.isDrawing = true;
    }
    
    private updateDrawing(event: MouseEvent) {
        if (!this.isDrawing || !this.currentPattern) return;
        requestAnimationFrame(() => {
            const { x, y } = this.interactionService.toWorldCoords(event);

            if(!this.currentPattern || !this.currentPattern.x2 || !this.currentPattern.y2) {
                return;
            }

            // Prevent redundant updates
            if (this.currentPattern!.x2 === x && this.currentPattern!.y2 === y) {
                return;
            }
            
            this.currentPattern?.updateEndPoint(x, y);
            //this.currentPattern?.markDirty();
        });
    }

    private finishDrawing() {
        this.isDrawing = false;
        this.currentPattern = null; // Reset after finishing
        // this.disable();
    }

}