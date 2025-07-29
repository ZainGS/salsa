/**
 * TODO: Implement APIs via Feature Managers to expose different core systems 
 * ShapeManager handles shape CRUD and registry-level updates.
 * FlowchartingManager handles smart arrows, node linking, and snapping points.
 * CollaborationManager handles presence, pointer syncing, WebSocket relays, locks, etc.
 * AIStreamManager manages streaming AI inference into buffers/registries.
 * SDFTextManager (or FontManager) handles SDF texture atlases, typesetting, caret, line wrapping, etc.
 * See: feature-managers.txt
 */

import { SceneGraph } from "../scene-graph/core/scene-graph";
import { ShapeFactory } from "../scene-graph/core/shape-factory";
import { Shape } from "../scene-graph/shapes/base/shape";
import { Node } from "../scene-graph/shapes/base/node";
import { RGBA } from "../types/rgba";
import { LineDrawingService } from "./drawing/line-drawing-service";
import { ScribbleDrawingService } from "./drawing/scribble-drawing-service";
import { TextDrawingService } from "./drawing/text-drawing-service";
import { hexToRgba } from "../utils/color";
import { EraserService } from "./drawing/eraser-service";
import { HighlightDrawingService } from "./drawing/highlight-drawing-service";
import { PatternDrawingService } from "./drawing/pattern-drawing-service";
import { ShapeType } from "../enums/shape-type";
import { InteractionService } from "./interaction-service";
import { Scribble } from "../scene-graph/shapes/scribble";
import { Highlight } from "../scene-graph/shapes/highlight";
import { Text } from "../scene-graph/shapes/text";
import { SectionDrawingService } from "./drawing/section-drawing-service";
import { Section } from "../scene-graph/shapes/section";
import { WebGPURenderer } from "../renderer/core/webgpu-renderer";
import { Group } from "../scene-graph/shapes/base/group";
import { EventEmitter } from "../renderer/util/event-emitter";

class ShapeManager {
    private shapeFactory: ShapeFactory;
    private sceneGraph!: SceneGraph;
    private static instance: ShapeManager; // Singleton instance
    public lineDrawingService!: LineDrawingService;
    public patternDrawingService!: PatternDrawingService;
    public scribbleDrawingService!: ScribbleDrawingService;
    public textDrawingService!: TextDrawingService;
    public highlightDrawingService!: HighlightDrawingService;
    public sectionDrawingService!: SectionDrawingService;
    public interactionService!: InteractionService;
    public eraserService!: EraserService;
    private shapeColor: RGBA = hexToRgba('#FFFFFF');
    private currentPreviewShape: Shape | null = null;
    private webgpuRenderer!: WebGPURenderer;

    private constructor(
        shapeFactory: ShapeFactory, 
        sceneGraph: SceneGraph, 
        lineDrawingService: LineDrawingService, 
        scribbleDrawingService: ScribbleDrawingService,
        textDrawingService: TextDrawingService,
        eraserService: EraserService,
        highlightDrawingService: HighlightDrawingService,
        patternDrawingService: PatternDrawingService,
        sectionDrawingService: SectionDrawingService,
        interactionService: InteractionService,
        webgpuRenderer: WebGPURenderer
    ) {
        this.shapeFactory = shapeFactory;
        this.sceneGraph = sceneGraph;
        this.lineDrawingService = lineDrawingService;
        this.scribbleDrawingService = scribbleDrawingService;
        this.textDrawingService = textDrawingService;
        this.highlightDrawingService = highlightDrawingService;
        this.eraserService = eraserService;
        this.patternDrawingService = patternDrawingService;
        this.interactionService = interactionService;
        this.sectionDrawingService = sectionDrawingService;
        this.webgpuRenderer = webgpuRenderer;
    }

    // Public method to get the singleton instance
    static getInstance(shapeFactory?: ShapeFactory, 
                       sceneGraph?: SceneGraph, 
                       lineDrawingService?: LineDrawingService, 
                       scribbleDrawingService?: ScribbleDrawingService,
                       textDrawingService?: TextDrawingService,
                       eraserService?: EraserService,
                       highlightDrawingService?: HighlightDrawingService,
                       patternDrawingService?: PatternDrawingService,
                       sectionDrawingService?: SectionDrawingService,
                       interactionService?: InteractionService,
                       webgpuRenderer?: WebGPURenderer): ShapeManager {
        if (!ShapeManager.instance) {
            if (!shapeFactory) throw new Error("ShapeFactory must be provided on first call!");
            if (!sceneGraph) throw new Error("SceneGraph must be provided on first call!");
            if (!lineDrawingService) throw new Error("Line Drawing Service must be provided on first call!");
            if (!scribbleDrawingService) throw new Error("Scribble Drawing Service must be provided on first call!");
            if (!highlightDrawingService) throw new Error("Highlight Drawing Service must be provided on first call!");
            if (!textDrawingService) throw new Error("Text Drawing Service must be provided on first call!");
            if (!eraserService) throw new Error("Eraser Service must be provided on first call!");
            if (!patternDrawingService) throw new Error("Pattern Drawing Service must be provided on first call!");
            if (!interactionService) throw new Error("Interaction Service must be provided on first call!");
            if (!sectionDrawingService) throw new Error("SectionDrawingService must be provided on first call!");
            if (!webgpuRenderer) throw new Error("WebGPURenderer must be provided on first call!");


            ShapeManager.instance = new ShapeManager(shapeFactory, sceneGraph, lineDrawingService, scribbleDrawingService, textDrawingService, eraserService, highlightDrawingService, patternDrawingService, sectionDrawingService, interactionService, webgpuRenderer);
        }
        return ShapeManager.instance;
    }

    private emitSceneGraphChanged() {
        this.interactionService.onSceneGraphChanged.emit();
    }

    public setBackgroundColor(r: number, g: number, b: number, a: number = 1.0) {
        if (this.webgpuRenderer) {
            this.webgpuRenderer.setBackgroundColor(r, g, b, a);
        }
    }

    public getBackgroundColor() {
        if (this.webgpuRenderer) {
            return this.webgpuRenderer.getBackgroundColorHex();
        }
    }

    public setDotColor(r: number, g: number, b: number, a: number = 1.0) {
        if (this.webgpuRenderer) {
            this.webgpuRenderer.setDotColor(r, g, b, a);
        }
    }
    
    public getDotColor() {
        if (this.webgpuRenderer) {
            return this.webgpuRenderer.getDotColorHex();
        }
    }

    public setSelectedNode(nodeId: string): void {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            this.interactionService.clearSelectedNodes();
            this.interactionService.selectNode(node);
        }
    }

    public addSelectedNode(nodeId: string): void {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            this.interactionService.selectNode(node);
        }
    }

    public clearSelectedNodes(): void {
        this.interactionService.clearSelectedNodes();
    }

    public deselectNode(nodeId: string): void {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            this.interactionService.deselectNode(node);
        }
    }

    createRectangle(
        x: number, y: number, width: number, height: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var rectangle = this.shapeFactory.createRectangle(x, y, width, height, this.shapeColor, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(rectangle);
        this.emitSceneGraphChanged();
    }

    createCircle(
        x: number, y: number, radius: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var circle = this.shapeFactory.createCircle(x, y, radius, this.shapeColor, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(circle);
        this.emitSceneGraphChanged();
    }

    createTriangle(
        x: number, y: number, width: number, height: number, strokeColor: RGBA, strokeWidth: number
    ): void {
        var triangle = this.shapeFactory.createTriangle(x, y, width, height, this.shapeColor, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(triangle);
        this.emitSceneGraphChanged();
    }

    createLine(x1: number, y1: number, x2: number, y2: number, strokeColor: RGBA, strokeWidth: number) {
        const line = this.shapeFactory.createLine(x1, y1, x2, y2, strokeColor, strokeWidth);
        this.sceneGraph.root.addChild(line);
        this.emitSceneGraphChanged();
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
        this.emitSceneGraphChanged();
    }

    public enableScribbleDrawing() {
        this.scribbleDrawingService.enable();
    }

    public disableScribbleDrawing() {
        this.scribbleDrawingService.disable();
    }

    public enableSectionDrawing() {
        this.sectionDrawingService.enable();
    }
    
    public disableSectionDrawing() {
        this.sectionDrawingService.disable();
    }

    public setStrokeWidth(width: number) {
        this.scribbleDrawingService.setStrokeWidth(width*.005);
    }

    createHighlight(x: number, y: number, strokeColor: RGBA, strokeWidth: number) {
        const highlight = this.shapeFactory.createHighlight(x, y, strokeColor, strokeWidth);
        this.eraserService.scribbles.push(highlight);
        this.sceneGraph.root.addChild(highlight);
        this.emitSceneGraphChanged();
    }

    public enableHighlightDrawing() {
        this.highlightDrawingService.enable();
    }

    public disableHighlightDrawing() {
        this.highlightDrawingService.disable();
    }

    public enableTextDrawing() {
        this.textDrawingService.enable();
    }

    public disableTextDrawing() {
        this.textDrawingService.disable();
    }

    public isTextDrawingInProgress(): boolean {
        return this.textDrawingService.isUserTyping();
    }

    public enableEraserTool() {
        this.eraserService.enable();
    }

    public disableEraserTool() {
        this.eraserService.disable();
    }

    public setStrokeColor(color: string) {
        this.scribbleDrawingService.setStrokeColor(hexToRgba(color));
    }

    public setHighlightColor(color: string) {
        this.highlightDrawingService.setStrokeColor(hexToRgba(color));
    }

    public setShapeColor(color: string) {
        this.shapeColor = hexToRgba(color);
    }

    public setTextColor(color: string) {
        this.textDrawingService.setTextColor(hexToRgba(color));
    }

    public enablePatternDrawing() {
        this.patternDrawingService.enable();
    }

    public disablePatternDrawing() {
        this.patternDrawingService.disable();
    }

    public setPattern(pattern: string) {
        this.patternDrawingService.setPattern(pattern);
    }

    // Shape Preview
    setPreviewShape(shapeType: ShapeType, event: MouseEvent) {
        // Remove existing preview shape
        if (this.currentPreviewShape) {
            this.sceneGraph.root.removeChild(this.currentPreviewShape);
            this.currentPreviewShape = null;
        }

        // If shapeType is null, just remove the preview
        if (!shapeType) return;

        const { x, y } = this.interactionService.toWorldCoords(event);

        // Create a new preview shape based on selected type
        switch (shapeType) {
            case ShapeType.Rectangle:
                this.currentPreviewShape = this.shapeFactory.createRectangle(
                    x, y, 1, 1, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1
                );
                break;
            case ShapeType.Circle:
                this.currentPreviewShape = this.shapeFactory.createCircle(
                    x, y, 1, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1
                );
                break;
            case ShapeType.Triangle:
                this.currentPreviewShape = this.shapeFactory.createTriangle(
                    x, y, 1, 1, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1
                );
                break;
            case ShapeType.InverseTriangle:
                this.currentPreviewShape = this.shapeFactory.createInvertedTriangle(
                    x, y, .5, .5, this.shapeColor, { r: 0, g: 0, b: 0, a: 1 }, 1
                );
                break;
            // Add other shapes here...
        }

        // Mark it as a preview shape
        if (this.currentPreviewShape) {
            this.currentPreviewShape.isPreview = true;
            this.sceneGraph.root.addChild(this.currentPreviewShape);
        }
    }

    updatePreviewShapePosition(event: MouseEvent) {
        if (this.currentPreviewShape) {
            const { x, y } = this.interactionService.toWorldCoords(event);
            this.currentPreviewShape.x = x;
            this.currentPreviewShape.y = y;

            // Sync colors if a new one has been selected
            if(this.currentPreviewShape.fillColor != this.shapeColor)
            {
                this.currentPreviewShape.fillColor = this.shapeColor;
            }
        }
    }

    confirmPreviewShape() {
        if (this.currentPreviewShape) {
            this.currentPreviewShape.fillColor = this.shapeColor;
            this.currentPreviewShape.isPreview = false; // Convert to actual shape
            this.currentPreviewShape = null;
        }
        this.emitSceneGraphChanged();
    }

    enablePanningTool() {
        this.interactionService.isPanToolSelected = true;
    }

    disablePanningTool() {
        this.interactionService.isPanToolSelected = false;
    }

    public getSceneGraphJSON(): string {
        return JSON.stringify(this.sceneGraph.toJSON()); // Ensure it calls the proper serialization method
    }

    public setSceneGraphJSON(jsonString: string): void {
        try {
            const data = JSON.parse(jsonString);
            this.updateSceneGraph(this.sceneGraph.root, data.root);
        } catch (error) {
            console.error("Error loading board:", error);
        }
    }

    public updateSceneGraph(targetNode: Node, sourceData: any): void {
        if (!targetNode || !sourceData) return;
    
        // Update core properties
        targetNode.x = sourceData.x;
        targetNode.y = sourceData.y;
        targetNode.scaleX = sourceData.scaleX;
        targetNode.scaleY = sourceData.scaleY;
        targetNode.rotation = sourceData.rotation;
        targetNode.zIndex = sourceData.zIndex;
        targetNode.visible = sourceData.visible;
    
        // Clear existing children (optional: optimize to avoid unnecessary clearing)
        targetNode.children = [];
    
        // Recursively recreate child nodes and attach them to the target node
        if (sourceData.children) {
            sourceData.children.forEach((childData: any) => {
                const newChild = this.recreateNode(childData);
                targetNode.addChild(newChild);
            });
        }
    }

    private recreateNode(data: any): Node {
        // //console.log(`Recreating node of type: ${data.type}`, data);
        let node: Node;
        
        switch (data.type) {
            case "Rectangle":
                node = this.shapeFactory.createRectangle(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Circle":
                node = this.shapeFactory.createCircle(
                    data.x, data.y, data.radius ?? data.width, // Assuming `width` is used as radius
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Triangle":
                node = this.shapeFactory.createTriangle(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "InvertedTriangle":
                node = this.shapeFactory.createInvertedTriangle(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Diamond":
                node = this.shapeFactory.createDiamond(
                    data.x, data.y, data.width, data.height,
                    data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Line":
                node = this.shapeFactory.createLine(
                    data.x1, data.y1, data.x2, data.y2,
                    data.strokeColor, data.strokeWidth
                );
                break;
            case "Scribble":
                node = this.shapeFactory.createScribble(
                    data.x, data.y, data.strokeColor, data.strokeWidth
                );
                (node as Scribble).points = data.points;
                (node as Scribble).wasCommitted = false;
                (node as Scribble).isStaging = false;
                this.eraserService.scribbles.push(node as Scribble);
                break;
            case "Highlight": 
                node = this.shapeFactory.createHighlight(
                    data.points[0].x, data.points[0].y, data.strokeColor, data.strokeWidth
                );
                (node as Highlight).points = data.points;
                this.eraserService.scribbles.push(node as Highlight);
                break;
            case "Pattern":
                node = this.shapeFactory.createPattern(
                    data.x1, data.y1, data.x2, data.y2,
                    data.strokeColor, data.strokeWidth,
                    data.pattern, // Assuming `pattern` is stored in JSON
                    this.patternDrawingService.device // GPUDevice needed
                );
                break;
            case "Text":
                console.log(data);
                node = this.shapeFactory.createText(
                    data.x, 
                    data.y, 
                    data.text, 
                    data.font, 
                    data.fillColor,
                    this.textDrawingService.device
                );
                const textNode = node as Text;
                textNode.setText(data.text ?? "", false);
                break;
            case "Polygon":
                node = this.shapeFactory.createPolygon(
                    data.points, data.fillColor, data.strokeColor, data.strokeWidth
                );
                break;
            case "Group":
                const recreatedChildren = (data.children || []).map((childData: any) =>
                    this.recreateNode(childData)
                );

                node = this.shapeFactory.createGroup(
                    recreatedChildren,
                    data.fillColor || { r: 0, g: 0, b: 0, a: 0 },
                    data.strokeColor || { r: 0, g: 0, b: 0, a: 0 },
                    data.strokeWidth || 1
                );

                // Optional group-specific flags
                (node as Group).clipChildren = data.clipChildren ?? false;
                (node as Group).drawBackground = data.drawBackground ?? false;
                (node as Group).backgroundColor = data.backgroundColor ?? { r: 1, g: 1, b: 1, a: 1 };
                break;
            default:
                node = new Node(); // Fallback case
                break;
        }
    
        // Restore common properties
        if (node instanceof Shape && data.id) {
            node.setId(data.id);
        }
        node.x = data.x;
        node.y = data.y;
        node.scaleX = data.scaleX;
        node.scaleY = data.scaleY;
        node.rotation = data.rotation;
        node.zIndex = data.zIndex;
        node.visible = data.visible;
    
        // Restore children only if not a Group (since Group already handles them)
        if (data.children && data.type !== "Group") {
            data.children.forEach((childData: any) => {
                node.addChild(this.recreateNode(childData));
            });
        }
    
        return node;
    }
    
    // public deleteSelectedShapes(): void {
    //     // TODO: Remove from Cache also
    //     const selected = Array.from(this.interactionService.selectedNodes);
    //     if (selected.length === 0) return;
    
    //     // Clear selection set
    //     this.interactionService.clearSelectedNodes();

    //     for (const node of selected) {
    //         // Remove from scene
    //         this.sceneGraph.root.removeChild(node);
    //         if(node.parent) {
    //             (node.parent as Group).recalculateSize();
    //         }
            
    //         // var parent = null;
    //         // if (node.parent) {
    //         //     parent = node.parent;
    //         // }

    //         // this.sceneGraph.root.removeChild(node);

    //         // if(parent) {
    //         //     (parent as Group).recalculateSize();
    //         // }
    
    //         // Also remove from eraserService if it's a scribble/highlight
    //         const type = (node as Shape).getType?.();
    //         if (type === "Scribble" || type === "Highlight") {
    //             const shape = node as Scribble | Highlight;

    //             const index = this.eraserService.scribbles.indexOf(shape);
    //             if (index !== -1) this.eraserService.scribbles.splice(index, 1);

    //             const viewIndex = this.eraserService.scribblesInView.indexOf(shape);
    //             if (viewIndex !== -1) this.eraserService.scribblesInView.splice(viewIndex, 1);
    //         }
    //     }
    
        
    // }

    public deleteSelectedShapes(): void {
    const selected = Array.from(this.interactionService.selectedNodes);
    if (selected.length === 0) return;

    // First collect all parents that will need recalculating
    const affectedParents = new Set<Group>();
    for (const node of selected) {
        if (node.parent) {
            affectedParents.add(node.parent as Group);
        }
    }

    // Then remove all selected nodes
    for (const node of selected) {
        // Remove from scene
        if (node.parent) {
            node.parent.removeChild(node);
        } else {
            this.sceneGraph.root.removeChild(node);
        }

        // Remove from eraserService if it's a scribble/highlight
        const type = (node as Shape).getType?.();
        if (type === "Scribble" || type === "Highlight") {
            const shape = node as Scribble | Highlight;
            const index = this.eraserService.scribbles.indexOf(shape);
            if (index !== -1) this.eraserService.scribbles.splice(index, 1);

            const viewIndex = this.eraserService.scribblesInView.indexOf(shape);
            if (viewIndex !== -1) this.eraserService.scribblesInView.splice(viewIndex, 1);
        }
    }

    // Finally, recalculate all affected parents
    affectedParents.forEach(parent => {
        parent.recalculateSize();
    });

    // Clear selection set
    this.interactionService.clearSelectedNodes();
    this.emitSceneGraphChanged(); // Don't forget to emit the change!
}

    public clear(): void {
        //console.log("Clearing ShapeManager...");
        
        // This might break the reference. Handle differently.
        // if (this.sceneGraph) {
        //     this.sceneGraph.root.children = []; // Remove all shapes
        // }
    
        this.currentPreviewShape = null; // Reset preview shape
    
        // Reset drawing services if necessary
        this.lineDrawingService?.disable();
        this.scribbleDrawingService?.disable();
        this.textDrawingService?.disable();
        this.highlightDrawingService?.disable();
        this.patternDrawingService?.disable();
        this.eraserService?.disable();
        // Clear scribbles without breaking references
        this.eraserService.scribbles.length = 0;
        this.eraserService.scribblesInView.length = 0;
        //console.log("ShapeManager cleared successfully.");
    }    

    
    getNodePosition(nodeId: string) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            return {x: node.x, y: node.y}
        }
    }

    setNodePosition(nodeId: string, x?: number, y?: number) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            node.x = x ?? node.x;
            node.y = y ?? node.y;
        }
    }

    getNodeById(nodeId: string) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            return node;
        }
    }

}


// Export only the singleton getter function
export default ShapeManager;