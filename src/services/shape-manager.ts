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
import { Line } from "../scene-graph/shapes/line";
import { SdfTextDrawingService } from "./drawing/sdftext-drawing-service";
import { SDFText } from "../scene-graph/shapes/sdf-text/sdf-text";
import { CacheService } from "./cache-service";
import { StickyNote } from "../scene-graph/shapes/sticky-note";

class ShapeManager {
    private shapeFactory: ShapeFactory;
    private sceneGraph!: SceneGraph;
    private static instance: ShapeManager; // Singleton instance
    public lineDrawingService!: LineDrawingService;
    public patternDrawingService!: PatternDrawingService;
    public scribbleDrawingService!: ScribbleDrawingService;
    public textDrawingService!: TextDrawingService;
    public sdfTextDrawingService!: SdfTextDrawingService;
    public highlightDrawingService!: HighlightDrawingService;
    public sectionDrawingService!: SectionDrawingService;
    public interactionService!: InteractionService;
    public eraserService!: EraserService;
    private shapeColor: RGBA = hexToRgba('#FFFFFF');
    private currentPreviewShape: Shape | null = null;
    private webgpuRenderer!: WebGPURenderer;

    // --- rAF glue to the renderer ---
    private scheduleRender() { this.webgpuRenderer?.scheduleRender(); }
    private beginInteractive() { this.webgpuRenderer?.beginInteractive(); }
    private endInteractive() { this.webgpuRenderer?.endInteractive(); }

    private constructor(
        shapeFactory: ShapeFactory, 
        sceneGraph: SceneGraph, 
        lineDrawingService: LineDrawingService, 
        scribbleDrawingService: ScribbleDrawingService,
        textDrawingService: TextDrawingService,
        sdfTextDrawingService: SdfTextDrawingService,
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
        this.sdfTextDrawingService = sdfTextDrawingService;
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
                       sdfTextDrawingService?: SdfTextDrawingService,
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
            if (!sdfTextDrawingService) throw new Error("SDF Text Drawing Service must be provided on first call!");
            if (!eraserService) throw new Error("Eraser Service must be provided on first call!");
            if (!patternDrawingService) throw new Error("Pattern Drawing Service must be provided on first call!");
            if (!interactionService) throw new Error("Interaction Service must be provided on first call!");
            if (!sectionDrawingService) throw new Error("SectionDrawingService must be provided on first call!");
            if (!webgpuRenderer) throw new Error("WebGPURenderer must be provided on first call!");


            ShapeManager.instance = new ShapeManager(shapeFactory, sceneGraph, lineDrawingService, scribbleDrawingService, textDrawingService, sdfTextDrawingService, eraserService, highlightDrawingService, patternDrawingService, sectionDrawingService, interactionService, webgpuRenderer);
        }
        return ShapeManager.instance;
    }

    private emitSceneGraphChanged() {
        this.interactionService.onSceneGraphChanged.emit();
        this.scheduleRender();
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
        if (node && !node.locked) {
            this.interactionService.clearSelectedNodes();
            this.interactionService.selectNode(node);
        }
        this.scheduleRender();
    }

    public addSelectedNode(nodeId: string): void {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node  && !node.locked) {
            this.interactionService.selectNode(node);
        }
        this.scheduleRender();
    }

    public clearSelectedNodes(): void {
        this.interactionService.clearSelectedNodes();
        this.scheduleRender();
    }

    public deselectNode(nodeId: string): void {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            this.interactionService.deselectNode(node);
        }
        this.scheduleRender();
    }

    public setNodeFillColor(layerId: string, newColor: RGBA) {
        const node = this.sceneGraph.findNodeById(layerId) as Shape;
        if (!node) return;

        const type = node.getType?.();
        if (type === 'Scribble') {
            (node as any).strokeColor = newColor;
        } else if (type === 'Sticky Note') {
            // single source of truth: use the class API
            (node as any as StickyNote).setColor(newColor);  // updates bg + marks dirty
        } else {
            (node as any).fillColor = newColor;
        }
        this.emitSceneGraphChanged();
    }

    public getNodeFillColor(layerId: string) {
        const node = this.sceneGraph.findNodeById(layerId) as Shape;
        if (!node) return { r:1,g:1,b:1,a:1 };

        const type = node.getType?.();
        if (type === 'Scribble') return (node as any).strokeColor;
        if (type === 'Sticky Note') return (node as any as StickyNote).bg.fillColor;
        return (node as any).fillColor;
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

    createStickyNote(x: number, y: number, text = "New note", color?: RGBA, signatureText?: string) {
        const note = this.shapeFactory.createStickyNote(x, y, text, color ?? {r:1,g:.98,b:.65,a:1}, signatureText);
        this.sceneGraph.root.addChild(note);
        this.interactionService.clearSelectedNodes();
        this.interactionService.selectNode(note);
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
        this.beginInteractive();
    }

    public disableScribbleDrawing() {
        this.scribbleDrawingService.disable();
        this.endInteractive();
    }

    public enableSectionDrawing() {
        this.sectionDrawingService.enable();
        this.beginInteractive();
    }
    
    public disableSectionDrawing() {
        this.sectionDrawingService.disable();
        this.endInteractive();
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
            this.emitSceneGraphChanged();
            this.endInteractive(); 
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
            this.beginInteractive();
            this.scheduleRender();
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
            this.scheduleRender();
        }
    }

    confirmPreviewShape() {
        if (this.currentPreviewShape) {
            this.currentPreviewShape.fillColor = this.shapeColor;
            this.currentPreviewShape.isPreview = false; // Convert to actual shape
            this.currentPreviewShape = null;
            this.endInteractive();
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
            this.emitSceneGraphChanged();
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
        targetNode.locked = sourceData.locked;
    
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
                const line = this.shapeFactory.createLine(
                    data.x1, data.y1, data.x2, data.y2, data.strokeColor, data.strokeWidth
                );
                if (data.x1 === data.x2 && data.y1 === data.y2) {
                    line.updateEndPoint(data.x2 + 1e-6, data.y2); // avoid degenerate on load
                }
                node = line;
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
            case "SDFText":
                node = this.shapeFactory.createSDFText(
                    data.x, 
                    data.y, 
                    data.text, 
                    data.fontSize,
                    this.sdfTextDrawingService.getSDFAtlas(),
                    data.fillColor || data.strokeColor, // SDFText uses strokeColor primarily
                    data.font
                );
                const sdfTextNode = node as SDFText;
                sdfTextNode.lineHeight = data.lineHeight ?? sdfTextNode.lineHeight;
                sdfTextNode.setText(data.text ?? "TEST");
                sdfTextNode.sdfThreshold = data.sdfThreshold ?? 0.5;
                sdfTextNode.outlineColor = data.outlineColor ?? { r: 0, g: 0, b: 0, a: 0 };
                sdfTextNode.smoothing = data.smoothing ?? 1;
                sdfTextNode.outlineWidth = data.outlineWidth ?? 0;
                sdfTextNode.refreshText();
                break;
            case "Sticky Note": 
                const note = this.shapeFactory.createStickyNote(
                    data.x, data.y, data.text ?? "New note", data.color ?? {r:1,g:.98,b:.65,a:1}, data.signatureText
                );
                note.fixedWidth = data.fixedWidth ?? true;
                if (data.targetWidth) note.setWidth(data.targetWidth);
                node = note;
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

                (node as Group).clipChildren = data.clipChildren ?? false;
                (node as Group).drawBackground = data.drawBackground ?? false;
                (node as Group).backgroundColor = data.backgroundColor ?? { r: 1, g: 1, b: 1, a: 1 };
                break;
            default:
                node = new Node();
                break;
        }
    
        if (node instanceof Shape && data.id) {
            node.setId(data.id);
        }

        node.name = data.name;
        node.x = data.x;
        node.y = data.y;
        node.scaleX = data.scaleX;
        node.scaleY = data.scaleY;
        node.rotation = data.rotation;
        node.zIndex = data.zIndex;
        node.visible = data.visible;
        node.locked = data.locked;
    
        // Restore children only if not a Group (since Group already handles them)
        if (data.children && data.type !== "Group" && data.type !== "Sticky Note") {
            data.children.forEach((childData: any) => {
                node.addChild(this.recreateNode(childData));
            });
        }
    
        return node;
    }

    // TODO: Remove from Cache also
    public deleteSelectedShapes(): void {
        this.beginInteractive();

        const selected = Array.from(this.interactionService.selectedNodes);
        if (selected.length === 0) { 
            this.endInteractive();
            return;
        }

        // Collect only parents that actually have recalc
        type RecalcParent = { recalculateSize?: () => void };
        const parentsToRecalc = new Set<RecalcParent>();

        for (const node of selected) {
            const p = node.parent as RecalcParent | null;
            if (p && typeof p.recalculateSize === 'function') {
                parentsToRecalc.add(p);
            }
        }

        // Remove deepest first (so children go before their selected parents)
        const depthOf = (n: any) => { let d = 0, p = n.parent; while (p) { d++; p = p.parent; } return d; };
        selected.sort((a, b) => depthOf(b) - depthOf(a));

        // Remove nodes
        for (const node of selected) {
            if (node.parent) {
            node.parent.removeChild(node);
            } else {
            // root child
            this.sceneGraph.root.removeChild(node);
            }

            // Clean up eraser registries for scribbles/highlights
            const type = (node as any as Shape).getType?.();
            if (type === "Scribble" || type === "Highlight") {
            const arr = this.eraserService.scribbles;
            const idx = arr.indexOf(node as any);
            if (idx !== -1) arr.splice(idx, 1);

            const viewArr = this.eraserService.scribblesInView;
            const vidx = viewArr.indexOf(node as any);
            if (vidx !== -1) viewArr.splice(vidx, 1);
            }
        }

        // Recalculate only where supported
        parentsToRecalc.forEach(p => p.recalculateSize!());

        // Clear selection and emit
        this.interactionService.clearSelectedNodes();
        this.endInteractive();
        this.emitSceneGraphChanged();
    }

    public clear(): void {
        // Reset preview shape
        this.currentPreviewShape = null; 
        // Reset drawing services if necessary
        this.lineDrawingService?.disable();
        this.scribbleDrawingService?.disable();
        this.textDrawingService?.disable();
        this.sdfTextDrawingService?.disable();
        this.highlightDrawingService?.disable();
        this.patternDrawingService?.disable();
        this.eraserService?.disable();
        // Clear scribbles without breaking references
        this.eraserService.scribbles.length = 0;
        this.eraserService.scribblesInView.length = 0;
        this.scheduleRender();
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
        this.emitSceneGraphChanged();
    }

    setNodeVisibility(nodeId: string, visible: boolean) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            node.visible = visible;
        }
        this.emitSceneGraphChanged();
    }

    setNodeLocked(nodeId: string, locked: boolean) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            node.locked = locked;
        }
        this.scheduleRender();
    }

    setNodeName(nodeId: string, name: string = "Untitled") {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            node.name = name;
        }
        this.scheduleRender(); 
    }

    getNodeById(nodeId: string) {
        const node = this.sceneGraph.findNodeById(nodeId);
        if (node) {
            return node;
        }
    }

    // SDF Text Related
    public enableSDFTextDrawing() {
        this.sdfTextDrawingService.enable();
        this.beginInteractive();
    }

    public disableSDFTextDrawing() {
        this.sdfTextDrawingService.disable();
        this.endInteractive();
    }

    public isSDFTextDrawingInProgress(): boolean {
        return this.sdfTextDrawingService.isUserTyping();
    }

    public setSDFTextColor(color: string) {
        this.sdfTextDrawingService.setTextColor(hexToRgba(color));
        this.scheduleRender(); 
    }

    public setSDFTextOutlineColor(color: string) {
        this.sdfTextDrawingService.setOutlineColor(hexToRgba(color));
        this.scheduleRender(); 
    }

    public setSDFTextFontSize(size: number) {
        this.sdfTextDrawingService.setFontSize(size);
        this.scheduleRender(); 
    }

    public setSDFTextFont(font: string) {
        this.sdfTextDrawingService.setFont(font);
        this.scheduleRender(); 
    }

    public setSDFTextThreshold(threshold: number) {
        this.sdfTextDrawingService.setSDFThreshold(threshold);
        this.scheduleRender(); 
    }

    public setSDFTextSmoothing(smoothing: number) {
        this.sdfTextDrawingService.setSmoothing(smoothing);
        this.scheduleRender(); 
    }

    public setSDFTextOutlineWidth(width: number) {
        this.sdfTextDrawingService.setOutlineWidth(width);
        this.scheduleRender(); 
    }

    public updateSDFText(
    nodeId: string,
    props: Partial<{
        text: string;
        font: string;
        fontSize: number;
        lineHeight: number;
        fill: string | RGBA;
        outline: string | RGBA;
        outlineWidth: number;
        threshold: number;
        smoothing: number;
    }>
    ): void {

        // 1) Locate & type-guard the node
        const node = this.sceneGraph.findNodeById(nodeId);

        if ((node as Shape).getType() === 'Sticky Note') {
            const note = node as StickyNote;
            if (props.text !== undefined) {
                note.setText(props.text);
                note.markDirty?.();
            }
            this.emitSceneGraphChanged();
            return;
        }

        if (!node || (node as Shape).getType() != 'SDFText') return;

        // 2) Merge the incoming changes
        if (props.font        !== undefined) (node as SDFText).font        = props.font;
        if (props.fontSize    !== undefined) (node as SDFText).fontSize    = props.fontSize;
        if (props.lineHeight  !== undefined) (node as SDFText).lineHeight = props.lineHeight;

        if (props.fill !== undefined) {
            (node as SDFText).strokeColor = typeof props.fill === "string"
                                    ? hexToRgba(props.fill)
                                    : props.fill;
        }

        if (props.outline !== undefined) {
            (node as SDFText).outlineColor = typeof props.outline === "string"
                                    ? hexToRgba(props.outline)
                                    : props.outline;
        }

        if (props.outlineWidth !== undefined) (node as SDFText).outlineWidth = props.outlineWidth;
        if (props.threshold    !== undefined) (node as SDFText).sdfThreshold = props.threshold;
        if (props.smoothing    !== undefined) (node as SDFText).smoothing    = props.smoothing;
        if (props.text        !== undefined) {
            (node as SDFText).setText(props.text)
        } else {
            (node as SDFText).refreshText();
        }
        
        (node as SDFText).isDirty = true;
        this.emitSceneGraphChanged();
    }

    public async waitForFrameSettled(): Promise<void> {
			return this.webgpuRenderer.waitForFrameSettled();
    }

    public async captureThumbnailBlob(maxWidth = 300): Promise<Blob> {
    	return await this.webgpuRenderer.snapshotToBlob(maxWidth);
    }

}

// Export only the singleton getter function
export default ShapeManager;