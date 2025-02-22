import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Shape } from "../scene-graph/shapes/base/shape";
import { RGBA } from "../types/rgba";
import { LineDrawingService } from "../services/line-drawing-service";
import { ScribbleDrawingService } from "./scribble-drawing-service";
import { TextDrawingService } from "./text-drawing-service";
import { hexToRgba } from "../utils/color";
import { EraserService } from "./eraser-service";

class ShapeManager {
    private shapeFactory: ShapeFactory;
    private sceneGraph!: SceneGraph;
    private static instance: ShapeManager; // Singleton instance
    public lineDrawingService!: LineDrawingService;
    public scribbleDrawingService!: ScribbleDrawingService;
    public textDrawingService!: TextDrawingService;
    public eraserService!: EraserService;
    private shapeColor: RGBA = hexToRgba('#FFFFFF');

    private constructor(
        shapeFactory: ShapeFactory, 
        sceneGraph: SceneGraph, 
        lineDrawingService: LineDrawingService, 
        scribbleDrawingService: ScribbleDrawingService,
        textDrawingService: TextDrawingService,
        eraserService: EraserService) {
        this.shapeFactory = shapeFactory;
        this.sceneGraph = sceneGraph;
        this.lineDrawingService = lineDrawingService;
        this.scribbleDrawingService = scribbleDrawingService;
        this.textDrawingService = textDrawingService;
        this.eraserService = eraserService;
    }

    // Public method to get the singleton instance
    static getInstance(shapeFactory?: ShapeFactory, 
                       sceneGraph?: SceneGraph, 
                       lineDrawingService?: LineDrawingService, 
                       scribbleDrawingService?: ScribbleDrawingService,
                       textDrawingService?: TextDrawingService,
                       eraserService?: EraserService): ShapeManager {
        if (!ShapeManager.instance) {
            if (!shapeFactory) throw new Error("ShapeFactory must be provided on first call!");
            if (!sceneGraph) throw new Error("SceneGraph must be provided on first call!");
            if (!lineDrawingService) throw new Error("Line Drawing Service must be provided on first call!");
            if (!scribbleDrawingService) throw new Error("Scribble Drawing Service must be provided on first call!");
            if (!textDrawingService) throw new Error("Text Drawing Service must be provided on first call!");
            if (!eraserService) throw new Error("Eraser Service must be provided on first call!");

            ShapeManager.instance = new ShapeManager(shapeFactory, sceneGraph, lineDrawingService, scribbleDrawingService, textDrawingService, eraserService);
        }
        return ShapeManager.instance;
    }

    createRectangle(
        x: number, y: number, width: number, height: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var rectangle = this.shapeFactory.createRectangle(x, y, width, height, this.shapeColor, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(rectangle);
    }

    createCircle(
        x: number, y: number, radius: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var circle = this.shapeFactory.createCircle(x, y, radius, this.shapeColor, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(circle);
    }

    createTriangle(
        x: number, y: number, width: number, height: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var triangle = this.shapeFactory.createTriangle(x, y, width, height, this.shapeColor, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(triangle);
    }

    createLine(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number) {
        const line = this.shapeFactory.createLine(x1, y1, x2, y2, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(line);
    }

    public enableLineDrawing() {
        this.lineDrawingService.enable();
    }

    public disableLineDrawing() {
        this.lineDrawingService.disable();
    }

    createScribble(x: number, y: number, strokeColor: RGBA, strokeWidth: number) {
        const scribble = this.shapeFactory.createScribble(x, y, strokeColor, strokeWidth);
        this.eraserService.scribbles.push(scribble);
        this.sceneGraph.root.addChild(scribble);
    }

    public enableEraserTool() {
        this.eraserService.enable();
    }

    public disableEraserTool() {
        this.eraserService.disable();
    }

    public enableScribbleDrawing() {
        this.scribbleDrawingService.enable();
    }

    public disableScribbleDrawing() {
        this.scribbleDrawingService.disable();
    }

    public enableTextDrawing() {
        this.textDrawingService.enable();
    }

    public disableTextDrawing() {
        this.textDrawingService.disable();
    }

    public setStrokeColor(color: string) {
        this.scribbleDrawingService.setStrokeColor(hexToRgba(color));
    }

    public setShapeColor(color: string) {
        this.shapeColor = hexToRgba(color);
    }

    public setTextColor(color: string) {
        this.textDrawingService.setTextColor(hexToRgba(color));
    }
}


// Export only the singleton getter function
export default ShapeManager;