import { RenderStrategy } from "../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Line } from "../scene-graph/shapes/line";
import { RGBA } from "../types/rgba";
import { InteractionService } from "./interaction-service";

export class LineDrawingService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    private currentLine: Line | null = null;
    public  isDrawing: boolean = false;
    private strokeColor: RGBA = { r: .6, g: .6, b: .6, a: 1 };
    private strokeWidth: number = 2;
    public  isEnabled: boolean = false;
    private shapeFactory: ShapeFactory;

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
        this.interactionService.deselectSelectedNode();
    }

    public disable() {
        this.isEnabled = false;
    }

    private eventListenersAttached = false;

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
        // const { x, y } = {
        //     x: (0),
        //     y: (0),
        // };
        //this.currentLine = new Line(this.renderStrategy, x, y, x, y, this.strokeColor, this.strokeWidth, this.interactionService);
        this.currentLine = this.shapeFactory.createLine(x,y,x,y,this.strokeColor,1)
        this.sceneGraph.root.addChild(this.currentLine);
        this.isDrawing = true;
    }

    createLine(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number) {
        const line = this.shapeFactory.createLine(0,0,
        1, 1,
        {r: 175/255, g: 244/255, b: 198/255, a: 1}, 
        10
    );
        this.sceneGraph.root.addChild(line);
    }
    
    private updateDrawing(event: MouseEvent) {
        if (!this.isDrawing || !this.currentLine) return;
        requestAnimationFrame(() => {
            const { x, y } = this.interactionService.toWorldCoords(event);

            if(!this.currentLine || !this.currentLine.x2 || !this.currentLine.y2) {
                return;
            }

            // Prevent redundant updates
            if (this.currentLine!.x2 === x && this.currentLine!.y2 === y) {
                return;
            }
            
            this.currentLine?.updateEndPoint(x, y);
            //this.currentLine?.markDirty();
        });
    }

    private finishDrawing() {
        this.isDrawing = false;
        this.currentLine = null; // Reset after finishing
        // this.disable();
    }

}