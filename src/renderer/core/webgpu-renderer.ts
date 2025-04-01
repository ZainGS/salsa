/// <reference types="@webgpu/types" />
// import "@webgpu/types";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { WebGPURenderStrategy } from "../render-strategies/webgpu-render-strategy";
import { Node } from "../../scene-graph/shapes/base/node";
import { InteractionService } from '../../services/interaction-service';
import { mat4, vec3, vec4 } from "gl-matrix";
import { Shape } from "../../scene-graph/shapes/base/shape";
import { LineDrawingService } from "../../services/drawing/line-drawing-service";
import { ScribbleDrawingService } from "../../services/drawing/scribble-drawing-service";
import { EraserService } from "../../services/drawing/eraser-service";
import { HighlightDrawingService } from "../../services/drawing/highlight-drawing-service";
import { PatternDrawingService } from "../../services/drawing/pattern-drawing-service";
import { CacheService } from "../../services/cache-service";
import { TextDrawingService } from "../../services/drawing/text-drawing-service";
import { Rectangle } from "../../scene-graph/shapes/rectangle";

// src/renderer/webgpu-renderer.ts
export class WebGPURenderer {

    // Core Setup
    private canvas!: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private shapePipeline!: GPURenderPipeline;
    private linePipeline!: GPURenderPipeline;
    private patternPipeline!: GPURenderPipeline;
    private highlightPipeline!: GPURenderPipeline;
    private textPipeline!: GPURenderPipeline;
    private backgroundPipeline!: GPURenderPipeline;
    private boundingBoxPipeline!: GPURenderPipeline;
    private swapChainFormat: GPUTextureFormat = 'bgra8unorm';

    // User-Application State
    private lineDrawingService: LineDrawingService | null = null;
    private patternDrawingService: PatternDrawingService | null = null;
    private scribbleDrawingService: ScribbleDrawingService | null = null;
    private highlightDrawingService: HighlightDrawingService | null = null;
    private textDrawingService: TextDrawingService | null = null;
    private eraserService: EraserService | null = null;
    private interactionService: InteractionService;
    private lastRenderTime: number = 0;
    private renderThrottleTime: number = 8; // 16 ms for ~60 FPS
    private isDragging: boolean = false;
    private isBoxSelecting = false;
    private boxStart = { x: 0, y: 0 };
    private boxEnd = { x: 0, y: 0 };
    
    /// Rotation
    private isRotating: boolean = false;
    private initialMouseAngle: number = 0;
    private initialShapeRotation: number = 0;

    /// Panning
    private isPanning: boolean = false;
    private lastMousePosition: { x: number, y: number } | null = null;
    private initialShapeDimensions: {
        x: number,
        y: number,
        width: number,
        height: number
    } | null = null;
    
    /// Scaling
    private isScaling: boolean = false;
    private scalingSide: any;
    // private initialMouseOffset: {offsetX: number, offsetY: number} = {offsetX: 0, offsetY: 0};

    // Shape & World 
    private sceneGraph!: SceneGraph;
    private primaryDraggedNode!: Node;
    private dragOffsetX: number = 0;
    private dragOffsetY: number = 0;
    private initialDragPositions: Map<Shape, { x: number; y: number }> = new Map();

    // Multisample Anti-Aliasing
    // private msaaTexture!: GPUTexture;
    // private msaaTextureView!: GPUTextureView;
    private sampleCount: number = 1; // 4x MSAA

    constructor(canvas: HTMLCanvasElement, interactionService: InteractionService) {
        // Core Setup
        this.initializeCanvas(canvas);
        this.interactionService = interactionService;
    }

    private initializeCanvas(newCanvas: HTMLCanvasElement) {
        // Canvas is used for textureView in renderPassDescriptor, 
        // Mouse Events, background pipeline, etc.
        this.canvas = newCanvas;
        // Mouse Event Listeners
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));
    }

    // Method to get the GPUDevice
    public getDevice(): GPUDevice {
        return this.device;
    }

    // Method to get the Shape GPURenderPipeline
    public getShapePipeline(): GPURenderPipeline {
        return this.shapePipeline;
    }

    public getLinePipeline(): GPURenderPipeline {
        return this.linePipeline;
    }

    public getHighlightPipeline(): GPURenderPipeline {
        return this.highlightPipeline;
    }

    public getPatternPipeline(): GPURenderPipeline {
        return this.patternPipeline;
    }

    // Method to get the Bounding Box GPURenderPipeline
    public getBoundingBoxPipeline(): GPURenderPipeline {
        return this.boundingBoxPipeline;
    }

    public getTextPipeline(): GPURenderPipeline {
        return this.textPipeline;
    }
    
    public setSceneGraph(sceneGraph: SceneGraph) {
        this.sceneGraph = sceneGraph;
    }

    // Setter to assign LineDrawingService
    public setLineDrawingService(service: LineDrawingService) {
        this.lineDrawingService = service;
    }

    // Setter to assign PatternDrawingService
    public setPatternDrawingService(service: PatternDrawingService) {
        this.patternDrawingService = service;
    }

    // Setter to assign EraserService
    public setEraserService(service: EraserService) {
        this.eraserService = service;
    }

    // Setter to assign ScribbleDrawingService
    public setScribbleDrawingService(service: ScribbleDrawingService) {
        this.scribbleDrawingService = service;
    }

    // Setter to assign HighlightDrawingService
    public setHighlightDrawingService(service: HighlightDrawingService) {
        this.highlightDrawingService = service;
    }

    // Setter to assign TextDrawingService
    public setTextDrawingService(service: TextDrawingService) {
        this.textDrawingService = service;
    }

    // Enable line drawing mode
    // public enableLineDrawingMode() {
    //     if (this.lineDrawingService) {
    //         this.lineDrawingService.enable(); // Add enable method in LineDrawingService
    //     }
    // }

    // Enable selection mode
    // public enableSelectionMode() {
    //     if (this.lineDrawingService) {
    //         this.lineDrawingService.disable(); // Add disable method in LineDrawingService
    //     }
    // }
    
    private handleWheel(event: WheelEvent) {
        if (event.ctrlKey) {

            // Prevent the default zoom behavior in the browser
            event.preventDefault(); 

            // Invert to zoom in on scroll up
            const zoomDelta = event.deltaY * -0.001; 
    
            // Get mouse position relative to the canvas center (screen-space origin)
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = event.clientX - rect.right/2;
            const mouseY = event.clientY - rect.bottom/2;
    
            // Adjust the zoom factor and pan offset
            this.interactionService.adjustZoom(zoomDelta, mouseX, mouseY);
            
            for (const node of this.interactionService.selectedNodes) {
                (node as Shape).triggerRerender();
            }
        }
    }

    // Checks for Rotation Handles around bounding box corners
    private isMouseNearRotationHandle(mouseX: number, mouseY: number, shape: Shape): boolean {
        const corners = shape.getWorldSpaceCorners();
        
        // Bottom Left Handle Offset
        corners[0][0] -= .035;
        corners[0][1] -= .035;

        // Bottom Right Handle Offset
        corners[1][0] += .035;
        corners[1][1] -= .035;

        // Top Right Handle Offset
        corners[2][0] += .035;
        corners[2][1] += .035;

        // Top Left Handle Offset
        corners[3][0] -= .035;
        corners[3][1] += .035;

        // Convert the mouse point to NDC space
        const ndcX = (mouseX / this.canvas.width) * 2 - 1;
        const ndcY = (mouseY / this.canvas.height) * -2 + 1;
        
        // Convert the NDC mouse point to world space using the inverse of the world matrix
        const mousePoint = vec4.fromValues(ndcX, ndcY, 0, 1);

        // Invert the world matrix to go from screen space back to world space
        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());
        vec4.transformMat4(mousePoint, mousePoint, inverseWorldMatrix);

        // Invert the local matrix to go from world space to the shape's local space
        const inverseLocalMatrix = mat4.create();
        mat4.invert(inverseLocalMatrix, shape.localMatrix);
        vec4.transformMat4(mousePoint, mousePoint, inverseLocalMatrix);

        const threshold = 0.01625; // Adjust the threshold based on your needs
    
        return corners.some(corner => {
            const distance = Math.sqrt(
                Math.pow(mousePoint[0] - corner[0], 2) +
                Math.pow(mousePoint[1] - corner[1], 2)
            );
            return distance <= threshold;
        });
    }

    // Determines angle the mouse has moved around the shape during shape rotation
    private calculateMouseAngle(mouseX: number, mouseY: number, shape: Shape): number {
        if (shape) {

            // Convert the mouse coordinates from screen space to NDC space
            let ndcX = (mouseX / this.canvas.width) * 2 - 1;
            let ndcY = (mouseY / this.canvas.height) * -2 + 1;
    
            // Create a vec4 for the mouse point in NDC space
            const mousePoint = vec4.fromValues(ndcX, ndcY, 0, 1);
    
            // Invert the world matrix to transform the mouse point to world space
            const inverseWorldMatrix = mat4.create();
            mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());
            vec4.transformMat4(mousePoint, mousePoint, inverseWorldMatrix);
    
            // The shape's center should be transformed similarly if needed, 
            // but in this case, we assume it's in local space(?), so we directly use it.
            const centerX = shape.x;
            const centerY = shape.y;
            
            // For some reason 0.05 aligns the rotation with the mouse. It's a mystery...
            var sensitivity = 0.05;
            // Calculate the angle using atan2, ensuring both points are in the same space
            const angle = sensitivity * Math.atan2(mousePoint[1] - centerY, mousePoint[0] - centerX);
    
            return angle;
        }
        return 0;
    }

    // Checks for Scaling Handles at bounding box edges and returns closest match
    private isMouseNearScalingHandle(mouseX: number, mouseY: number, shape: Shape): string | null {
        
        // For now, only allow scaling when one shape is selected. In the future,
        // when grouping techniques are implemented we can maybe scale everything together.
        if (this.interactionService.selectedNodes.size !== 1) return null;

        const corners = shape.getWorldSpaceCorners();
    
        // Convert the mouse point to NDC space
        const ndcX = (mouseX / this.canvas.width) * 2 - 1;
        const ndcY = (mouseY / this.canvas.height) * -2 + 1;
    
        // Convert the NDC mouse point to world space using the inverse of the world matrix
        const mousePoint = vec4.fromValues(ndcX, ndcY, 0, 1);
    
        // Invert the world matrix to go from screen space back to world space
        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());
        vec4.transformMat4(mousePoint, mousePoint, inverseWorldMatrix);
    
        // Invert the local matrix to go from world space to the shape's local space
        const inverseLocalMatrix = mat4.create();
        mat4.invert(inverseLocalMatrix, shape.localMatrix);
        vec4.transformMat4(mousePoint, mousePoint, inverseLocalMatrix);
    
        const threshold = 0.035; // Adjust the threshold based on your needs
    
        // Calculate midpoints for the 4 sides and 4 corners
        const leftMidpoint = [(corners[0][0] + corners[3][0]) / 2, (corners[0][1] + corners[3][1]) / 2];
        const rightMidpoint = [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2];
        const bottomMidpoint = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
        const topMidpoint = [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2];
    
        const bottomLeftMidpoint = [corners[0][0], corners[0][1]];
        const bottomRightMidpoint = [corners[1][0], corners[1][1]];
        const topRightMidpoint = [corners[2][0], corners[2][1]];
        const topLeftMidpoint = [corners[3][0], corners[3][1]];

        // Convert Float32Array (vec4) to number[] for distance calculation
        const mousePointArray = Array.from(mousePoint);
    
        // Calculate distances to each side
        type Side = 'left' | 'right' | 'top' | 'bottom' 
        | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
        
        const distances: Record<Side, number> = {
            left: this.calculateDistance(mousePointArray, leftMidpoint, 1.075, shape.height*14),
            right: this.calculateDistance(mousePointArray, rightMidpoint, 1.075, shape.height*14),
            top: this.calculateDistance(mousePointArray, topMidpoint, shape.width*14, 1.075),
            bottom: this.calculateDistance(mousePointArray, bottomMidpoint, shape.width*14, 1.075),
            topLeft: this.calculateDistance(mousePointArray, topLeftMidpoint),
            topRight: this.calculateDistance(mousePointArray, topRightMidpoint),
            bottomLeft: this.calculateDistance(mousePointArray, bottomLeftMidpoint),
            bottomRight: this.calculateDistance(mousePointArray, bottomRightMidpoint)
        };
    
        // Determine which side is closest
        const closestSide: Side = (Object.keys(distances) as Side[]).reduce((a, b) => distances[a] < distances[b] ? a : b);

        // Check if the closest side is within the threshold
        if (distances[closestSide] <= threshold) {
            return closestSide;
        }
        
        return null;
    }

    // Helper method to calculate distance between two points
    private calculateDistance(point1: number[], point2: number[], scaleX: number = 1, scaleY: number = 1): number {
        const dx = (point1[0] - point2[0]) / (scaleX);
        const dy = (point1[1] - point2[1]) / (scaleY);
        return Math.sqrt(dx * dx + dy * dy);
    }

    // Determines distance the mouse has moved from the shape during shape scaling
    /*
    private calculateMouseOffset(mouseX: number, mouseY: number, shape: Shape): { offsetX: number, offsetY: number } {
        if (shape) {
            // Convert the mouse coordinates from screen space to NDC space
            let ndcX = (mouseX / this.canvas.width) * 2 - 1;
            let ndcY = (mouseY / this.canvas.height) * -2 + 1;
    
            // Create a vec4 for the mouse point in NDC space
            const mousePoint = vec4.fromValues(ndcX, ndcY, 0, 1);
    
            // Invert the world matrix to transform the mouse point to world space
            const inverseWorldMatrix = mat4.create();
            mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());
            vec4.transformMat4(mousePoint, mousePoint, inverseWorldMatrix);
    
            // The shape's center should be transformed similarly if needed,
            // but in this case, we assume it's in local space, so we directly use it.
            const centerX = shape.x;
            const centerY = shape.y;
    
            // Calculate the X and Y offsets from the shape's center
            const offsetX = mousePoint[0] - centerX;
            const offsetY = mousePoint[1] - centerY;

            return { offsetX, offsetY };
        }
        return { offsetX: 0, offsetY: 0 };
    }
    */

    private handleMouseDown(event: MouseEvent) {
        switch (event.button) {
            case 0: { // LEFT MOUSE BUTTON
                if (this.interactionService.isPanToolSelected) {
                    this.isPanning = true;
                    this.lastMousePosition = { x: event.clientX, y: event.clientY };
                    event.preventDefault();
                    return;
                }
    
                if (
                    this.lineDrawingService?.isEnabled ||
                    this.scribbleDrawingService?.isEnabled ||
                    this.eraserService?.isEnabled ||
                    this.highlightDrawingService?.isEnabled ||
                    this.patternDrawingService?.isEnabled ||
                    this.textDrawingService?.isEnabled
                ) {
                    this.interactionService.selectedNodes.forEach(n => (n as Shape).deselect());
                    this.interactionService.selectedNodes.clear();
                    return;
                }
    
                const [mouseX, mouseY] = [event.offsetX, event.offsetY];
                const [worldX, worldY] = this.transformMouseCoordinatesToWorldSpace(mouseX, mouseY);
    
                // ROTATION
                if (this.interactionService.selectedNodes.size === 1) {
                    const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
                    if (this.isMouseNearRotationHandle(mouseX, mouseY, shape)) {
                        this.isRotating = true;
                        this.initialMouseAngle = this.calculateMouseAngle(mouseX, mouseY, shape);
                        this.initialShapeRotation = shape.rotation;
                        return;
                    }
                }
    
                // SCALING
                if (this.interactionService.selectedNodes.size === 1) {
                    const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
                    const scalingSide = this.isMouseNearScalingHandle(mouseX, mouseY, shape);
                    if (scalingSide) {
                        this.isScaling = true;
                        this.scalingSide = scalingSide;
                        this.lastMousePosition = { x: worldX, y: worldY };
                        this.initialShapeDimensions = {
                            x: shape.x,
                            y: shape.y,
                            width: shape.width,
                            height: shape.height,
                        };
                        return;
                    }
                }
    
                // DRAGGING or BOX SELECTING
                this.isDragging = true;
                
                this.initialDragPositions.clear();
                for (const node of this.interactionService.selectedNodes) {
                    if (node instanceof Shape) {
                        this.initialDragPositions.set(node, { x: node.x, y: node.y });
                    }
                }

                const overlappingNodes = this.findAllNodesUnderMouse(worldX, worldY);
                if (overlappingNodes.length > 0) {
                    const topNode = overlappingNodes[0];
    
                    if (event.shiftKey) {
                        // Shift-click toggles selection
                        if (this.interactionService.selectedNodes.has(topNode)) {
                            (topNode as Shape).deselect();
                            this.interactionService.selectedNodes.delete(topNode);
                        } else {
                            this.interactionService.selectedNodes.add(topNode);
                            (topNode as Shape).select();
                        }
                    } else {
                        // Normal click
                        if (!this.interactionService.selectedNodes.has(topNode)) {
                            // Not already selected → replace selection
                            for (const n of this.interactionService.selectedNodes) {
                                (n as Shape).deselect();
                            }
                            this.interactionService.selectedNodes.clear();
                            this.interactionService.selectedNodes.add(topNode);
                            (topNode as Shape).select();
                        }
                        // else: clicking on already-selected shape → keep selection (prepping for drag)
                    }

                    /*---------------------------------------------------------------------------
                    We are storing a snapshot of each selected shape’s position before dragging starts.
                    This is crucial because:
                    During a drag, we don't want to apply raw mouse deltas directly to the shapes.
                    Instead, we want to offset each shape relative to where it started.
                    If we didn’t store the initialDragPositions, we’d either:
                    Move the shapes based on their latest position — which causes cumulative error (a jump or drift each frame).
                    Or apply deltas without knowing where each shape started — making multi-drag totally inaccurate.
                    We clear and re-set initialDragPositions on every new drag to ensure:
                    Each selected shape knows where it started
                    We apply correct relative movement to all of them
                    We can support clean, consistent group dragging every time */
                    this.initialDragPositions.clear();
                    for (const node of this.interactionService.selectedNodes) {
                        this.initialDragPositions.set(node as Shape, { x: node.x, y: node.y });
                    }
    
                    // Set drag offset for the topNode (single drag for now)
                    this.primaryDraggedNode = topNode as Shape;
                    this.dragOffsetX = worldX - this.primaryDraggedNode.x;
                    this.dragOffsetY = worldY - this.primaryDraggedNode.y;
                } else {
                    // Empty click → clear selection + start box select
                    this.interactionService.selectedNodes.forEach(n => (n as Shape).deselect());
                    this.interactionService.selectedNodes.clear();
    
                    this.isDragging = false;
                    this.isBoxSelecting = true;
                    this.boxStart = { x: mouseX, y: mouseY };
                    this.boxEnd = { x: mouseX, y: mouseY };
                }
    
                return;
            }
    
            case 1: { // MIDDLE MOUSE BUTTON
                this.isPanning = true;
                this.lastMousePosition = { x: event.clientX, y: event.clientY };
                event.preventDefault();
                return;
            }
        }
    }

    /* About Transformed Mouse Coordinates:
    The transformMouseCoordinates method takes the mouse coordinates and transforms them from 
    screen space into the shape's coordinate space using the inverse of the worldMatrix. This allows the 
    click detection to occur in the correct space relative to the transformed shapes.

    By inverting the worldMatrix, you effectively reverse the scaling, translation, and any other 
    transformations applied to the shapes, mapping the mouse position back to the original coordinate space of the shapes.

    The transformed coordinates are then used to detect which shape is being clicked and to calculate the offset for dragging.
    -------------------------------------------------------------------------------------------------------------------------*/
    private transformMouseCoordinatesToWorldSpace(x: number, y: number): [number, number] {

        // (NDC-SPACE CLICK)
        // Convert screen space mouse point (x, y) to NDC (-1 to 1)
        const ndcX = (x / this.canvas.width) * 2 - 1;
        const ndcY = (y / this.canvas.height) * -2 + 1;

        // (MODEL-SPACE WORLD MATRIX) [Pre-Transformation "Model" World Space]
        // Get the inverse of the world matrix
        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());
    
        // (MODEL-SPACE CLICK) [Pre-Transformation "Model" World Space]
        // Convert the NDC mouse point to world space using the inverse of the world matrix
        const transformed = vec3.fromValues(ndcX, ndcY, 0);
        vec3.transformMat4(transformed, transformed, inverseWorldMatrix);
    
        // Return the transformed coordinates (in original, untransformed world space)
        // You could say this is the same as "pre-transformed world space", because
        // the point we output has not been affected by world transformations due to the inverse
        // matrix. It's like we went back in time and clicked the OG spot. This "space" lets us more 
        // efficiently handle hit detection. 
        return [transformed[0], transformed[1]];
    }
    
    private handleMouseMove(event: MouseEvent) {
        const mouseX = event.offsetX;
        const mouseY = event.offsetY;
    
        // Skip this frame if rendering is throttled
        const currentTime = Date.now();
        if (currentTime - this.lastRenderTime < this.renderThrottleTime) {
            return; 
        }
    
        // Handle based on state from Mouse Down
        // PANNING WORLD
        if (this.isPanning && this.lastMousePosition) {
            const deltaX = (event.clientX - this.lastMousePosition.x);
            const deltaY = (event.clientY - this.lastMousePosition.y);
            var scaleFactor = 2;
            this.interactionService.adjustPan(deltaX * scaleFactor, deltaY * scaleFactor);
            this.lastMousePosition = { x: event.clientX, y: event.clientY };
        }
        // DRAGGING SHAPE
        else if (this.isDragging &&
            this.primaryDraggedNode &&
            this.interactionService.selectedNodes.size > 0 &&
            this.initialDragPositions.size > 0) {
   
            const rect = this.canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const [modelX, modelY] = this.transformMouseCoordinatesToWorldSpace(x, y);
        
            // Get original position of the node you clicked on
            const primaryInitial = this.initialDragPositions.get(this.primaryDraggedNode as Shape);
            if (!primaryInitial) return;
        
            // Calculate how far your mouse has moved relative to that shape's starting point
            const deltaX = modelX - (primaryInitial.x + this.dragOffsetX);
            const deltaY = modelY - (primaryInitial.y + this.dragOffsetY);
        
            // Move all selected shapes by that same delta
            for (const node of this.interactionService.selectedNodes) {
                if (!(node instanceof Shape)) continue;
                const original = this.initialDragPositions.get(node);
                if (!original) continue;
        
                node.x = original.x + deltaX;
                node.y = original.y + deltaY;
                node.updateLocalMatrix();
            }
        }
        // Box Selecting
        else if (this.isBoxSelecting) {
            const [startX, startY] = this.transformMouseCoordinatesToWorldSpace(this.boxStart.x, this.boxStart.y);
            const rect = this.canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const [endX, endY] = this.transformMouseCoordinatesToWorldSpace(x, y);
    
            const x1 = Math.min(startX, endX);
            const y1 = Math.min(startY, endY);
            const x2 = Math.max(startX, endX);
            const y2 = Math.max(startY, endY);
    
            const selectionBox = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };

            // Setup selection box to be drawn in renderer
            const boxWidth = selectionBox.width;
            const boxHeight = selectionBox.height;
            const centerX = x1 + boxWidth / 2;
            const centerY = y1 + boxHeight / 2;

            if (!this.interactionService.boxSelectPreview) {
                const box = new Rectangle(this.sceneGraph.root.renderStrategy!, centerX, centerY, boxWidth, boxHeight, { r: 0.6, g: 0.55, b: 0.95, a: 0.25 }, undefined, 1, this.interactionService);
                box.isPreview = true;
                this.interactionService.boxSelectPreview = box;
                box.markDirty();
            } else {
                this.interactionService.boxSelectPreview.x = centerX;
                this.interactionService.boxSelectPreview.y = centerY;
                this.interactionService.boxSelectPreview.width = boxWidth;
                this.interactionService.boxSelectPreview.height = boxHeight;
                this.interactionService.boxSelectPreview.markDirty();
            }

            this.interactionService.selectedNodes.clear();
    
            // In every case where the shape’s bounding box is stored in local/object space, we must:
            // 1. Transform the corners into world space using shape.localMatrix.
            // 2. Run the SAT test between: worldCorners of the shape and selectionBox (also represented as a polygon in world space).
            // Selection box polygon (already in world space)
            
            // Define the selection box corners (it's axis-aligned)
            const selectionPolygon: [number, number][] = [
                [selectionBox.x, selectionBox.y],
                [selectionBox.x + selectionBox.width, selectionBox.y],
                [selectionBox.x + selectionBox.width, selectionBox.y + selectionBox.height],
                [selectionBox.x, selectionBox.y + selectionBox.height],
            ];

            for (const node of this.sceneGraph.root.children) {
                if (!(node instanceof Shape)) continue;
                const shape = node as Shape;
            
                // General shapes use the base Shape implementation, but there are special cases 
                // for some shapes. I've listen them below and the method overrides for 
                // getWorldSpaceBoundingBoxPolygon() are implemented in those child classes.
                // General case: Just get the 4 local-space corners of the shape and transform to worldspace.
                // Special-case: Scribble or Highlight BB corners depends on their points array.
                // Special-case: Pattern BB corners depends on the vertices array.
                /** Then:
                 * Check if a shape (which may be rotated) intersects with the selection box.
                 * This accounts for rotation bc we transform the shape's BB corners into world space
                 * and then perform polygon-based collision detection via SAT instead of simple AABB.
                 */

                // TODO: Cache the transformed WSBBPolygon if nothing’s dirty to optimize performance later.
                if (this.polygonsIntersect(shape.getWorldSpaceBoundingBoxPolygon(), selectionPolygon)) {
                    shape.select();
                    this.interactionService.selectedNodes.add(shape);
                } else {
                    shape.deselect();
                }
            }
        }
        // ROTATING SHAPE
        else if (this.isRotating && this.interactionService.selectedNodes.size === 1) {
            const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
            const currentMouseAngle = this.calculateMouseAngle(mouseX, mouseY, shape);
            const angleDifference = currentMouseAngle - this.initialMouseAngle;
            shape.rotation = this.initialShapeRotation + angleDifference * 20;
            shape.markDirty(); // Trigger a re-render
        }
        // SCALING SHAPE
        else if (this.isScaling && this.interactionService.selectedNodes.size === 1) {
            const [shape] = Array.from(this.interactionService.selectedNodes) as Shape[];
            if (!this.lastMousePosition || !this.initialShapeDimensions) return;
            this.handleScaling(event, shape);
        }
        else {
            const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
            if (shape?.boundingBox) {
                if (this.isMouseNearRotationHandle(mouseX, mouseY, shape)) {
                    this.canvas.style.cursor = 'grab';
                } else if (this.isMouseNearScalingHandle(mouseX, mouseY, shape)) {
                    const scalingSide = this.isMouseNearScalingHandle(mouseX, mouseY, shape);
                    switch (scalingSide) {
                        case "top": this.canvas.style.cursor = 'n-resize'; return;
                        case "left": this.canvas.style.cursor = 'w-resize'; return;
                        case "bottom": this.canvas.style.cursor = 's-resize'; return;
                        case "right": this.canvas.style.cursor = 'e-resize'; return;
                        case "topLeft": this.canvas.style.cursor = 'nw-resize'; return;
                        case "topRight": this.canvas.style.cursor = 'ne-resize'; return;
                        case "bottomLeft": this.canvas.style.cursor = 'sw-resize'; return;
                        case "bottomRight": this.canvas.style.cursor = 'se-resize'; return;
                    }
                } else {
                    this.canvas.style.cursor = 'default';
                }
            }
        }
    
        for (const node of this.interactionService.selectedNodes) {
            (node as Shape).triggerRerender();
        }
    
        this.lastRenderTime = currentTime;
    }

    /**
     * Checks if two convex polygons (given as arrays of [x, y] pairs) intersect.
     * Uses the Separating Axis Theorem (SAT): if any separating axis exists
     * where projections don't overlap, then the polygons do not intersect.
     */
    polygonsIntersect(a: [number, number][], b: [number, number][]): boolean {
        // Run SAT for both polygons
        const polygons = [a, b];

        for (let i = 0; i < polygons.length; i++) {
            const polygon = polygons[i];

            // Loop over each edge of the polygon
            for (let j = 0; j < polygon.length; j++) {
                const k = (j + 1) % polygon.length;
                const edge = [
                    polygon[k][0] - polygon[j][0],
                    polygon[k][1] - polygon[j][1],
                ];

                // Compute the perpendicular axis (normal) to the current edge
                const normal = [-edge[1], edge[0]];

                // Project polygon A onto the axis
                let minA = Infinity, maxA = -Infinity;
                for (const [x, y] of a) {
                    const projected = x * normal[0] + y * normal[1];
                    minA = Math.min(minA, projected);
                    maxA = Math.max(maxA, projected);
                }

                // Project polygon B onto the same axis
                let minB = Infinity, maxB = -Infinity;
                for (const [x, y] of b) {
                    const projected = x * normal[0] + y * normal[1];
                    minB = Math.min(minB, projected);
                    maxB = Math.max(maxB, projected);
                }

                // If projections do not overlap, there's a separating axis — shapes do NOT intersect
                if (maxA < minB || maxB < minA) {
                    return false;
                }
            }
        }

        // All projections overlapped → shapes intersect
        return true;
    }
    

    private handleScaling(event: MouseEvent, shape: Shape) {
        if (!this.lastMousePosition || !this.initialShapeDimensions) return;
    
        // Rotation angle in radians
        const shapeRotation = shape.rotation; 
    
        // Calculate cosine and sine of the angle
        const cosTheta = Math.cos(shapeRotation);
        const sinTheta = Math.sin(shapeRotation);
    
        // Convert mouse position to model world space
        const x = event.offsetX;
        const y = event.offsetY;
        const [modelX, modelY] = this.transformMouseCoordinatesToWorldSpace(x, y);
    
        // Calculate the mouse movement vector
        const mouseMovementX = modelX - this.lastMousePosition.x;
        const mouseMovementY = modelY - this.lastMousePosition.y;
    
        // Project the mouse movement onto the rotated axis
        const offsetAlongWidthAxis = mouseMovementX * cosTheta + mouseMovementY * sinTheta;
        const offsetAlongHeightAxis = -mouseMovementX * sinTheta + mouseMovementY * cosTheta;
    
        const minWidth = 0.05;
        const minHeight = 0.05;
    
        switch (this.scalingSide) {
            case 'left':
                let newWidthLeft = this.initialShapeDimensions.width - offsetAlongWidthAxis;
                newWidthLeft = Math.max(minWidth, newWidthLeft);
                shape.x = this.initialShapeDimensions.x + (this.initialShapeDimensions.width - newWidthLeft) * cosTheta / 2;
                shape.y = this.initialShapeDimensions.y + (this.initialShapeDimensions.width - newWidthLeft) * sinTheta / 2;
                shape.width = newWidthLeft;
                break;
            case 'right':
                let newWidthRight = this.initialShapeDimensions.width + offsetAlongWidthAxis;
                newWidthRight = Math.max(minWidth, newWidthRight);
                shape.x = this.initialShapeDimensions.x + (newWidthRight - this.initialShapeDimensions.width) * cosTheta / 2;
                shape.y = this.initialShapeDimensions.y + (newWidthRight - this.initialShapeDimensions.width) * sinTheta / 2;
                shape.width = newWidthRight;
                break;
            case 'bottom':
                let newHeightBottom = this.initialShapeDimensions.height - offsetAlongHeightAxis;
                newHeightBottom = Math.max(minHeight, newHeightBottom);
                shape.x = this.initialShapeDimensions.x - (this.initialShapeDimensions.height - newHeightBottom) * sinTheta / 2;
                shape.y = this.initialShapeDimensions.y + (this.initialShapeDimensions.height - newHeightBottom) * cosTheta / 2;
                shape.height = newHeightBottom;
                break;
            case 'top':
                let newHeightTop = this.initialShapeDimensions.height + offsetAlongHeightAxis;
                newHeightTop = Math.max(minHeight, newHeightTop);
                shape.x = this.initialShapeDimensions.x - (newHeightTop - this.initialShapeDimensions.height) * sinTheta / 2;
                shape.y = this.initialShapeDimensions.y + (newHeightTop - this.initialShapeDimensions.height) * cosTheta / 2;
                shape.height = newHeightTop;
                break;
            case 'topRight':
                let newWidthTR = this.initialShapeDimensions.width + offsetAlongWidthAxis;
                let newHeightTR = this.initialShapeDimensions.height + offsetAlongHeightAxis;
                newWidthTR = Math.max(minWidth, newWidthTR);
                newHeightTR = Math.max(minHeight, newHeightTR);
                const wDiffTR = newWidthTR - this.initialShapeDimensions.width;
                const hDiffTR = newHeightTR - this.initialShapeDimensions.height;
                shape.x = this.initialShapeDimensions.x + (wDiffTR * cosTheta / 2 - hDiffTR * sinTheta / 2);
                shape.y = this.initialShapeDimensions.y + (hDiffTR * cosTheta / 2 + wDiffTR * sinTheta / 2);
                shape.width = newWidthTR;
                shape.height = newHeightTR;
                break;
            case 'topLeft':
                let newWidthTL = this.initialShapeDimensions.width - offsetAlongWidthAxis;
                let newHeightTL = this.initialShapeDimensions.height + offsetAlongHeightAxis;
                newWidthTL = Math.max(minWidth, newWidthTL);
                newHeightTL = Math.max(minHeight, newHeightTL);
                const wDiffTL = newWidthTL - this.initialShapeDimensions.width;
                const hDiffTL = newHeightTL - this.initialShapeDimensions.height;
                shape.x = this.initialShapeDimensions.x - (wDiffTL * cosTheta / 2 + hDiffTL * sinTheta / 2);
                shape.y = this.initialShapeDimensions.y + (hDiffTL * cosTheta / 2 - wDiffTL * sinTheta / 2);
                shape.width = newWidthTL;
                shape.height = newHeightTL;
                break;
            case 'bottomLeft':
                let newWidthBL = this.initialShapeDimensions.width - offsetAlongWidthAxis;
                let newHeightBL = this.initialShapeDimensions.height - offsetAlongHeightAxis;
                newWidthBL = Math.max(minWidth, newWidthBL);
                newHeightBL = Math.max(minHeight, newHeightBL);
                const wDiffBL = newWidthBL - this.initialShapeDimensions.width;
                const hDiffBL = newHeightBL - this.initialShapeDimensions.height;
                shape.x = this.initialShapeDimensions.x - (wDiffBL * cosTheta / 2 - hDiffBL * sinTheta / 2);
                shape.y = this.initialShapeDimensions.y - (hDiffBL * cosTheta / 2 + wDiffBL * sinTheta / 2);
                shape.width = newWidthBL;
                shape.height = newHeightBL;
                break;
            case 'bottomRight':
                let newWidthBR = this.initialShapeDimensions.width + offsetAlongWidthAxis;
                let newHeightBR = this.initialShapeDimensions.height - offsetAlongHeightAxis;
                newWidthBR = Math.max(minWidth, newWidthBR);
                newHeightBR = Math.max(minHeight, newHeightBR);
                const wDiffBR = newWidthBR - this.initialShapeDimensions.width;
                const hDiffBR = newHeightBR - this.initialShapeDimensions.height;
                shape.x = this.initialShapeDimensions.x + (wDiffBR * cosTheta / 2 + hDiffBR * sinTheta / 2);
                shape.y = this.initialShapeDimensions.y - (hDiffBR * cosTheta / 2 - wDiffBR * sinTheta / 2);
                shape.width = newWidthBR;
                shape.height = newHeightBR;
                break;
        }
    
        shape.markDirty(); // Trigger a re-render
    }
    
    

    private handleMouseUp(event: MouseEvent) {
        
        // Middle mouse button
        if (event.button === 1) { 
            this.isPanning = false;
            this.lastMousePosition = null;
        }
        // Left mouse button
        else if (event.button === 0) {
            this.isDragging = false;
            this.isBoxSelecting = false;
            this.interactionService.boxSelectPreview = null;
            this.isRotating = false;
            this.isScaling = false;

            if(this.interactionService.isPanToolSelected) {
                this.isPanning = false;
                this.lastMousePosition = null;
            }
        }
    }

    // Non-normalized, pixel-space coordinates for hit detection.
    private findNodeUnderMouse(x: number, y: number): Node | null {
        // Iterate through your scene graph and check if the x, y is within the bounds of any node.
        // Traverse in reverse z-index order so top-most shape gets selected.
        const nodes = [...this.sceneGraph.root.children]
        .filter(n => n.visible)
        .sort((a, b) => b.zIndex - a.zIndex); // Top-most first

        for (const node of nodes) {
            if (node.containsPoint(x, y)) {
                return node;
            }
        }
        return null;
    }

    // Non-normalized, pixel-space coordinates for hit detection.
    private findAllNodesUnderMouse(x: number, y: number): Node[] {
        // Filter & sort your scene graph and check if the x, y is within the bounds of any nodes.
        // Returns all nodes under the mouse.
        return [...this.sceneGraph.root.children]
            .filter(n => n.visible && n.containsPoint(x, y))
            .sort((a, b) => b.zIndex - a.zIndex); // top-most first
    }

    setCanvasSize(device: GPUDevice) {
        // Get the maximum screen resolution
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.interactionService.updateWorldMatrix();
        this.interactionService.setDepthTextureView(device);
        this.interactionService.viewportBounds.markDirty();
    }

    // Starting point of WebGPU Setup & Rendering Loop
    public async initialize() {
        await this.initWebGPU();
        
        // Update canvas size when the window is resized
        this.setCanvasSize(this.getDevice());      
        window.addEventListener('resize', () => this.setCanvasSize(this.getDevice()));

        this.createBackgroundRenderPipeline();
        this.createShapeRenderPipeline();
        this.createBoundingBoxPipeline();
        this.createLineRenderPipeline();
        this.createTextRenderPipeline();
        this.createHighlightRenderPipeline();
        this.createPatternRenderPipeline();
    }

    public async reinitialize(newCanvas: HTMLCanvasElement) {
        this.sceneGraph.root.children.length = 0;
        CacheService.getInstance().initialize(this.device);
        this.interactionService.canvas = newCanvas;

        // Reinitialize services to bind events to new canvas
        this.eraserService?.reinitializeEventListeners();
        this.highlightDrawingService?.reinitializeEventListeners();
        this.lineDrawingService?.reinitializeEventListeners();
        this.patternDrawingService?.reinitializeEventListeners();
        this.scribbleDrawingService?.reinitializeEventListeners();
        this.textDrawingService?.reinitializeEventListeners();

        this.initializeCanvas(newCanvas);
        this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
        this.context.configure({
            device: this.device,
            format: this.swapChainFormat,
            alphaMode: 'premultiplied',
        });

        // Update canvas size when the window is resized
        this.setCanvasSize(this.getDevice());      
        window.addEventListener('resize', () => this.setCanvasSize(this.getDevice()));

        // Update world transformations
        this.interactionService.updateWorldMatrix();
        this.interactionService.setDepthTextureView(this.device);
        this.interactionService.viewportBounds.markDirty();
    }

    private async initWebGPU() {
        
        /* About WebGPU and the navigator.gpu check:
        'navigator' is a property of the global 'window' object of the web browser that provides 
        information about the state of the browser. It includes various properties and methods, like 
        navigator.userAgent or navigator.gpu. When you write navigator.gpu, you're implicitly accessing 
        window.navigator.gpu. The browser's access to the GPU object is facilitated by the WebGPU API, 
        a modern graphics API that allows web applications to directly interact with the GPU for 
        high-performance graphics and compute tasks. The navigator.gpu property is the entry point for the 
        WebGPU API. It provides a GPU object, which you can use to access the GPU capabilities of the user's device.
        This object allows you to create GPU devices, command queues, buffers, textures, shaders, and other resources 
        necessary for rendering graphics or performing compute operations. The browser implements the WebGPU API, including 
        the navigator.gpu interface. This implementation interacts with the underlying operating system's graphics drivers to 
        communicate with the GPU.

        Remember that the browser acts as an abstraction layer between the web application and the underlying graphics hardware. 
        When you call functions on the GPU object, the browser translates these into lower-level graphics API calls 
        (like Vulkan, Direct3D, or Metal) that are executed by the GPU.
        --------------------------------------------------------------------------------------------------------------------------*/
        if (!navigator.gpu) { throw new Error("WebGPU is not supported on this browser."); }

        /* About the GPUAdapter:
           The GPUAdapter is an interface that provides information about the GPU hardware and 
           allows us to request a GPUDevice to perform rendering or compute operations.
           Not all devices or browsers support WebGPU. By checking for the availability of a GPUAdapter, 
           the application can handle cases where WebGPU isn't supported and potentially provide fallbacks 
           (a different rendering strategy) or inform the user.
        ---------------------------------------------------------------------------------------------------------------------------*/
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) { throw new Error("Failed to request WebGPU adapter."); }
        this.device = await adapter.requestDevice();

        this.interactionService.setDepthTextureView(this.device);


        /* About GPUCanvasContext:
        Retrieves the WebGPU rendering context for the canvas. This context is specifically designed to allow 
        WebGPU commands to render content onto a <canvas> element.  The context returned is cast to GPUCanvasContext, 
        which is a special type of context for managing the WebGPU rendering pipeline.

        The canvas context is the bridge between the WebGPU rendering pipeline and the HTML canvas. 
        It’s where the WebGPU commands will output the rendered content.

        Note: The swap chain format we use is bgra8unorm ("blue-green-red-alpha with 8 bits per channel and normalized values"). 
        The swap chain format determines how the image data is represented in memory before being displayed on the screen.
        Also, alphaMode: 'premultiplied' is used. This setting indicates how the alpha channel (transparency) is handled. 
        'premultiplied' means that the color values have already been multiplied by the alpha value, which is a common way of 
        handling transparency in rendering.
        --------------------------------------------------------------------------------------------------------------------------*/
        this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
        this.context.configure({
            device: this.device,
            format: this.swapChainFormat,
            alphaMode: 'premultiplied',
        });

        /* About GPUTextureView and MSAA: 
           Below we set up a texture on the GPU that will be used specifically for MSAA rendering. 
           This texture will hold multiple samples per pixel, according to the sampleCount, to smooth out the final rendered image.
           After creating the texture, the createView call sets up a GPUTextureView. This view is what we'll actually bind to our 
           render pipeline when we want to render content using MSAA. The view acts as a handle to the texture, allowing us to specify 
           how it will be used in rendering operations.

           When you render to the msaaTexture, each pixel in the texture is actually composed of multiple samples. 
           The GPU will calculate the final color of each pixel by averaging these samples.
           Once rendering is complete, the final image with reduced aliasing is typically resolved into a non-MSAA texture 
           (such as the swap chain texture) that can be displayed on the screen.
        ----------------------------------------------------------------------------------------------------------------------------*/
        /*
        this.msaaTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            sampleCount: this.sampleCount,
            format: this.swapChainFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.msaaTextureView = this.msaaTexture.createView();
        */
    }

    public render() {
        // Scale MSAA texture to current canvas if resized
        // this.ensureCanvasSizeAndTextures();
    
        /* About the GPUCommandEncoder:
           Throughout our rendering code, we will be recording commands (like setting pipelines, 
           drawing objects) into a GPUCommandEncoder; These commands are stored in a command buffer.
           After all commands are recorded, this.device.queue.submit([commandEncoder.finish()]); 
           will submit this GPUCommandBuffer to the GPU's command queue for execution. 
           That is the point where the GPU actually starts processing the commands and performing the rendering.
        -------------------------------------------------------------------------------------------/-----------*/
        const commandEncoder = this.device.createCommandEncoder();    
        const textureView = this.context.getCurrentTexture().createView();
        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [{
                view: textureView,
                // view: this.msaaTextureView, // Use MSAA texture view
                // resolveTarget: textureView, // Resolve to the default swap chain texture
                loadOp: 'clear',
                clearValue: { r: 1, g: 1, b: 1, a: 1 },
                storeOp: 'store',
            }],
            depthStencilAttachment: {  
                view: this.interactionService.depthTextureView,
                depthLoadOp: "clear",
                depthStoreOp: "store",
                depthClearValue: 1.0, // Default depth value (far plane)
                stencilLoadOp: "clear",
                stencilStoreOp: "store",
                stencilClearValue: 0
            }
        };

        /* About the GPURenderPassEncoder (for batching draw calls):
           The GPURenderPassEncoder represents a single render pass, which is a period 
           where you're issuing draw commands to the GPU to render to a particular framebuffer (like the canvas).
           During a single render pass, you can issue multiple draw commands (like drawing different shapes) 
           using the same passEncoder. This is efficient because it avoids the overhead of 
           starting and ending multiple render passes for each shape.
        
           Within a single render pass, you can switch pipelines and bind groups as needed. For example, 
           if different shapes require different shaders or uniform data, you can switch the pipeline or 
           bind group before each draw call.

           The commands I issue in the GPURenderStrategy (setPipeline, setBindGroup, setVertexBuffer, 
           and setIndexBuffer) are essentially configuring the GPU state before drawing each shape.

           The passEncoder accumulates the drawing commands, and they are only executed once the render pass 
           ends below. This allows us to efficiently batch multiple draw calls into a single render pass.

           Basically, by using the same passEncoder, we minimize the overhead associated with starting and 
           ending multiple render passes. Thus, we keep all related draw calls within a single render pass.
        --------------------------------------------------------------------------------------------------*/
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

        // Render the background with a dot pattern (uses the background pipeline).
        this.renderBackground(passEncoder);
    
        // Apply deferred updates to Viewport Bounds & Recompute visibilty once per frame
        this.interactionService.viewportBounds.updateVisibility(this.sceneGraph.root.children as Shape[]);

        // Get all children sorted by zIndex AFTER culling
        // console.log(this.sceneGraph.root.children);
        const sortedNodes = this.sceneGraph.root.children
        .filter(node => node.visible)
        .sort((a, b) => a.zIndex - b.zIndex);

        // Render shapes (uses the shape pipeline).
        for (const node of sortedNodes) {
            this.renderShapes(passEncoder, node);
        }

        // Render selection box (uses the shape pipeline).
        if (this.interactionService.boxSelectPreview) {
           this.renderSelectionBox(passEncoder, this.interactionService.boxSelectPreview);
        }

        // End the current render pass and submit all the recorded GPU commands (for   
        // rendering to our specific framebuffer: the canvas) to the GPU for execution.
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

    /*
    private ensureCanvasSizeAndTextures() {
        const currentTexture = this.context.getCurrentTexture();
        const canvasWidth = currentTexture.width;
        const canvasHeight = currentTexture.height;
    
        if (!this.msaaTexture || this.msaaTexture.width !== canvasWidth || this.msaaTexture.height !== canvasHeight) {
            this.msaaTexture = this.device.createTexture({
                size: [canvasWidth, canvasHeight],
                format: 'bgra8unorm',
                sampleCount: this.sampleCount,
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.msaaTextureView = this.msaaTexture.createView();
        }
    }
    */

    private renderShapes(passEncoder: GPURenderPassEncoder, node: Node) {
        
        // Traverse scene graph and accumulate each shape's draw commands for  
        // the GPURenderPassEncoder (scoped to the Shape Pipeline) throughout 
        // the WebGPURenderStrategy.
        passEncoder.setPipeline(this.shapePipeline);
        const strategy = node.renderStrategy as WebGPURenderStrategy;
        strategy.render(node, passEncoder);
    }

    private renderSelectionBox(passEncoder: GPURenderPassEncoder, node: Node) {
        passEncoder.setPipeline(this.shapePipeline);
        const strategy = node.renderStrategy as WebGPURenderStrategy;
        strategy.render(node, passEncoder);
    }

    private renderBackground(passEncoder: GPURenderPassEncoder) {
        
        passEncoder.setPipeline(this.backgroundPipeline); // Use background pipeline

        // Set up resolution uniform buffer (Pad to 16 bytes for alignment requirements [8 bytes of data, 16-byte alignment])
        const resolutionUniformData = new Float32Array([this.canvas.width, this.canvas.height, 0.0, 0.0]);
        const resolutionUniformBuffer = this.device.createBuffer({
            size: resolutionUniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(resolutionUniformBuffer, 0, resolutionUniformData.buffer);

        // World Matrix inversion to Local-Shape coordinate system
        let worldMatrix = this.interactionService.getWorldMatrix();
        let invertedWorldMatrix = mat4.create();
        const worldMatrixUniformData = mat4.invert(invertedWorldMatrix, worldMatrix) as Float32Array;
        const worldMatrixUniformBuffer = this.device.createBuffer({
            size: worldMatrixUniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(worldMatrixUniformBuffer, 0, worldMatrixUniformData.buffer);

        // Create a bind group with the uniform buffers
        const bindGroup = this.device.createBindGroup({
            layout: this.backgroundPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: resolutionUniformBuffer } },
                { binding: 1, resource: { buffer: worldMatrixUniformBuffer } }, 
            ],
        });
    
        // Use the full-screen quad vertex buffer
        const quadVertexBuffer = this.setupFullScreenQuad();
        passEncoder.setVertexBuffer(0, quadVertexBuffer);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.draw(6, 1, 0, 0); // Draw the full-screen quad
    }

    private setupFullScreenQuad() {
        const vertices = new Float32Array([
            -1.0, -1.0,  // First triangle
             1.0, -1.0,
            -1.0,  1.0,
             1.0, -1.0,  // Second triangle
             1.0,  1.0,
            -1.0,  1.0,
        ]);
    
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
    
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        return vertexBuffer;
    }

    private createTextRenderPipeline() {
        const vertexShaderCode = `
                    struct Uniforms {
                        resolution: vec4<f32>,
                        worldMatrix: mat4x4<f32>,
                        localMatrix: mat4x4<f32>,
                        shapeColor: vec4<f32>
                    };

                    @group(0) @binding(0) var<uniform> uniforms: Uniforms;

                    struct VertexInput {
                        @location(0) position: vec2<f32>,
                        @location(1) uv: vec2<f32>
                    };

                    struct VertexOutput {
                        @builtin(position) position: vec4<f32>,
                        @location(0) uv: vec2<f32>
                    };

                    @vertex
                    fn vs_main(in: VertexInput) -> VertexOutput {
                        var output: VertexOutput;
                        let localPos = uniforms.localMatrix * vec4<f32>(in.position, 0.0, 1.0);
                        let transformedPos = uniforms.worldMatrix * localPos;
                        output.position = transformedPos;
                        output.uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
                        return output;
                    }
        `

        const fragmentShaderCode = `
            @group(0) @binding(1) var myTexture: texture_2d<f32>;
            @group(0) @binding(2) var mySampler: sampler;

            @fragment
            fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
                // let flippedUV = vec2<f32>(uv.x, 1.0 - uv.y);  // Flip UV coordinates
                let texColor = textureSample(myTexture, mySampler, uv);
                
                // Improve clarity by boosting contrast (optional)
                let alpha = step(0.5, texColor.a); 
                
                return vec4<f32>(texColor.rgb, alpha);
            }
        `;
    
        this.textPipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.device.createBindGroupLayout({
                    entries: [
                      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
                    ]
                  })],
            }),
            vertex: {
                module: this.device.createShaderModule({ code: vertexShaderCode }),
                entryPoint: "vs_main",
                buffers: [{
                    arrayStride: 4 * 4, // (x, y, u, v)
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: "float32x2" },
                        { shaderLocation: 1, offset: 2 * 4, format: "float32x2" },
                    ],
                }],
            },
            fragment: {
                module: this.device.createShaderModule({ code: fragmentShaderCode }),
                entryPoint: "fs_main",
                targets: [
                    {
                        format: this.swapChainFormat,
                        blend: {
                            color: {
                                srcFactor: "one",  // Keep full color intensity
                                dstFactor: "one",  // Add brightness on overlap
                                operation: "add"
                            },
                            alpha: {
                                srcFactor: "one", 
                                dstFactor: "one",
                                operation: "add"
                            }
                        }
                    },
                ],
            },
            primitive: { topology: "triangle-strip" },
            depthStencil: {  // ✅ Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    private createShapeRenderPipeline() {

        /* About Shaders:
        Shaders are small programs that run on the GPU. They are used to process 
        vertices and pixels (fragments) to produce the final image you see on the screen.

        Vertex Shader: Processes each vertex of your geometry, transforming it from its original position to its final position on the screen.
        Fragment Shader: Processes each pixel that makes up the geometry, determining its color, transparency, and other properties.
        -------------------------------------------------------------------------------------------------------------------------------*/
        // WebGPU Shading Language [WGSL] Vertex Shader for shapes 
        const vertexShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,
                worldMatrix: mat4x4<f32>,
                localMatrix: mat4x4<f32>,
                shapeColor: vec4<f32>
            };

            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            @vertex
            fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
                
                // Apply transformations using the local and world matrices
                let pos = uniforms.localMatrix * vec4<f32>(position, 0.0, 1.0);
                let transformedPosition = uniforms.worldMatrix * pos;

                // Apply aspect ratio correction during final position calculation
                return vec4<f32>(transformedPosition.x, transformedPosition.y, transformedPosition.z, transformedPosition.w);
            }
        `;
    
        // WebGPU Shading Language [WGSL] Fragment Shader for shapes 
        const shapeFragmentShaderCode = `
        struct Uniforms {
            resolution: vec4<f32>,
            worldMatrix: mat4x4<f32>,
            localMatrix: mat4x4<f32>,
            shapeColor: vec4<f32>
        };

        @group(0) @binding(0) var<uniform> uniforms: Uniforms;
    
        @fragment
        fn main_fragment() -> @location(0) vec4<f32> {
            return uniforms.shapeColor; // Simply output the shape's color
        }
        `;
    
        /* About Shader Modules:
           In WebGPU, shaders are compiled and managed through GPUShaderModule objects. 
           These shader modules are then used in a respective rendering pipeline to control how the GPU processes vertices and fragments. 
        --------------------------------------------------------------------------------------------------------------------------------*/
        const vertexShaderModule = this.device.createShaderModule({
            code: vertexShaderCode,
        });
    
        const fragmentShaderModule = this.device.createShaderModule({
            code: shapeFragmentShaderCode,
        });
    
        /* About GPUVertexBufferLayout 
           Our layout below describes a vertex buffer where each vertex consists of 2 floats (x and y coordinates), each 4 bytes. 
           These floats are packed together with no padding, so the total size of each vertex is 8 bytes.
           The data for each vertex starts immediately after the previous vertex's data ends, which is determined by the arrayStride.

           The vertex attribute (in this case, the position) is passed to the vertex shader at @location(0).
           The GPU will read the vertex data from the buffer, interpret each as two float32 values (based on the format), 
           and pass it to the shader for processing.

           This 'location' input in the vertex shader refers to the vertices' coordinates in the shape's local space.
           So for a rectangle, each position value passed to the shader is one of four local coordinates ([0,0], [1,0],
           [0,1], [1,1]]). The shader uses these positions to determine where each vertex of the rectangle should be placed in 
           world space after applying transformations (like translation, rotation, or scaling) via a "Local Matrix" and "World Matrix".
        ------------------------------------------------------------------------------------------------------------------------------*/
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4,
            attributes: [
                {
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x2',
                },
            ],
        };
    
        /* About BindGroupLayout and BindGroups
           A GPUBindGroupLayout describes the structure of a GPUBindGroup. 
           A GPUBindGroup is a collection of resources (such as buffers or textures) that are bound together and 
           made accessible to shaders during rendering. Each entry in the layout corresponds to a specific resource that 
           the shaders will use. The layout specifies how these resources are mapped to bindings within the shaders.
           By defining this layout, WebGPU can optimize the way resources are bound and accessed during rendering.

           Each binding corresponds to a specific @binding(n) in your shader code, where n is the binding number (0, 1, 2, or 3). 
           The layout ensures that the data is correctly mapped to the corresponding bindings in the shaders.

           The resources specified are uniform buffers, which means they hold data that doesn't change frequently during rendering 
           (like transformation matrices or constants). These buffers are typically small and can be accessed very efficiently by the GPU.
        ------------------------------------------------------------------------------------------------------------------*/
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0, // All uniform data packed into one buffer
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' }
                }
            ]
        });
    
        /* About GPUPipelineLayout:         
           The GPUPipelineLayout defines the overall structure of how resources are organized in 
           the GPU pipeline. It links the shaders with the resources they need to execute.
           The pipeline layout doesn't hold the actual data or resources; instead, it describes 
           how the data will be organized and bound during rendering. 
        --------------------------------------------------------------------------------------------*/
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        /* About GPURenderPipeline:
           This GPURenderPipeline defines how vertices are processed, how fragments (pixels)  
           are shaded, and how the final image is rendered to the screen.

           Note: The primitive object specifies how the vertices are assembled into geometric primitives.
           topology: 'triangle-list' indicates that the vertices will be grouped into triangles. Each set of 
           three vertices defines one triangle. This is the most common primitive topology used in rendering, 
           as complex shapes can be represented as a collection of triangles.
         ----------------------------------------------------------------------------------------------------*/
        this.shapePipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: 'main_vertex',
                buffers: [vertexBufferLayout],
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: 'main_fragment',
                targets: [{ 
                    format: this.swapChainFormat,
                    blend: { // Enable blending for transparency
                        color: {
                            srcFactor: 'src-alpha',   // Use source alpha
                            dstFactor: 'one-minus-src-alpha', // Blend with background
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                 }],
            },
            primitive: { topology: 'triangle-list' },
            multisample: {
                count: this.sampleCount, // Ensure the sample count matches MSAA settings
            },
            depthStencil: {  // ✅ Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    private createLineRenderPipeline() {
        // WGSL Vertex Shader for Lines
        const vertexShaderCode = `
            struct Uniforms {
            resolution: vec4<f32>,
            worldMatrix: mat4x4<f32>,
            localMatrix: mat4x4<f32>,
            lineColor: vec4<f32>,
            thickness: f32
        };

        @group(0) @binding(0) var<uniform> uniforms: Uniforms;

        @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            
            // Apply local transformation first
            let localPos = uniforms.localMatrix * vec4<f32>(position, 0.0, 1.0);

            // Apply world transformation
            let worldPos = uniforms.worldMatrix * localPos;

            return vec4<f32>(worldPos.xy, 0.0, 1.0);
        }
        `;
    
        // WGSL Fragment Shader for Lines
        const fragmentShaderCode = `
            struct Uniforms {
            resolution: vec4<f32>,
            worldMatrix: mat4x4<f32>,
            localMatrix: mat4x4<f32>,
            lineColor: vec4<f32>,
            thickness: f32,
            padding: vec3<f32>
        };

        @group(0) @binding(0) var<uniform> uniforms: Uniforms;

        @fragment
        fn main_fragment() -> @location(0) vec4<f32> {
            return uniforms.lineColor;
        }
        `;
    
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4, // 2 floats (x, y), 4 bytes each
            attributes: [
                {
                    shaderLocation: 0, // Must match `@location(0)` in shader
                    offset: 0,
                    format: 'float32x2', // Two floats per vertex
                },
            ],
        };

        // Create Shader Modules
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
        // Define Bind Group Layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                }
            ]
        });
    
        // Create Pipeline Layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        // Create the Render Pipeline
        this.linePipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: "main_vertex",
                buffers: [vertexBufferLayout]
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: "main_fragment",
                targets: [{
                    format: this.swapChainFormat,
                }],
            },
            primitive: { topology: "triangle-list" },
            depthStencil: {  // Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    private createPatternRenderPipeline() {
        // WGSL Vertex Shader for Patterns
        const vertexShaderCode = `
            struct Uniforms {
                resolution: vec4<f32>,
                worldMatrix: mat4x4<f32>,
                localMatrix: mat4x4<f32>,
            };

            @group(0) @binding(0) var<uniform> uniforms: Uniforms;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) uv: vec2<f32>
            };

            @vertex
            fn main_vertex(@location(0) position: vec2<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
                var output: VertexOutput;

                // Apply local and world transformations
                let localPos = uniforms.localMatrix * vec4<f32>(position, 0.0, 1.0);
                let worldPos = uniforms.worldMatrix * localPos;

                output.position = vec4<f32>(worldPos.xy, 0.0, 1.0);
                output.uv = uv;  // Pass UV coordinates to fragment shader

                return output;
            }
        `;
    
        // WGSL Fragment Shader for Patterns
        const fragmentShaderCode = `
            @group(0) @binding(1) var patternTexture: texture_2d<f32>;
            @group(0) @binding(2) var patternSampler: sampler;

            @fragment
            fn main_fragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
                let wrappedUV = fract(uv);  // Ensure UVs wrap instead of clamping
                return textureSample(patternTexture, patternSampler, wrappedUV);
            }
        `;
    
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 4 * 4, // 2 floats (x, y) + 2 floats (uv), each 4 bytes
            attributes: [
                {
                    shaderLocation: 0, // Position
                    offset: 0,
                    format: 'float32x2',
                },
                {
                    shaderLocation: 1, // UV coordinates
                    offset: 2 * 4,
                    format: 'float32x2',
                },
            ],
        };

        // Create Shader Modules
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
        // Define Bind Group Layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0, // Uniform buffer
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                {
                    binding: 1, // Texture
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float" }
                },
                {
                    binding: 2, // Sampler
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: "filtering" }
                }
            ]
        });
    
        // Create Pipeline Layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        }); 
    
        // Create the Render Pipeline
        this.patternPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: "main_vertex",
                buffers: [vertexBufferLayout]
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: "main_fragment",
                targets: [{
                    format: this.swapChainFormat,
                }],
            },
            primitive: { topology: "triangle-list" },
            depthStencil: {  // Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    private createHighlightRenderPipeline() {
        // WGSL Vertex Shader for Lines
        const vertexShaderCode = `
            struct Uniforms {
            resolution: vec4<f32>,
            worldMatrix: mat4x4<f32>,
            localMatrix: mat4x4<f32>,
            lineColor: vec4<f32>,
            thickness: f32
        };

        @group(0) @binding(0) var<uniform> uniforms: Uniforms;

        @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            
            // Apply local transformation first
            let localPos = uniforms.localMatrix * vec4<f32>(position, 0.0, 1.0);

            // Apply world transformation
            let worldPos = uniforms.worldMatrix * localPos;

            return vec4<f32>(worldPos.xy, 0.0, 1.0);
        }
        `;
    
        // WGSL Fragment Shader for Lines
        const fragmentShaderCode = `
            struct Uniforms {
            resolution: vec4<f32>,
            worldMatrix: mat4x4<f32>,
            localMatrix: mat4x4<f32>,
            lineColor: vec4<f32>,
            thickness: f32,
            padding: vec3<f32>
        };

        @group(0) @binding(0) var<uniform> uniforms: Uniforms;

        // Gamma correction function
        fn applyGamma(color: vec3<f32>, gamma: f32) -> vec3<f32> {
            return pow(color, vec3<f32>(gamma));
        }

        @fragment
        fn main_fragment() -> @location(0) vec4<f32> {
            let baseColor = uniforms.lineColor;
    
            // Apply gamma correction (sRGB → Linear space)
            let correctedColor = applyGamma(baseColor.rgb, 2.2);

            // Premultiply alpha to prevent weird transparency stacking
            let overlapFactor = 0.7;  // Adjust between 0.5 - 0.9
            let premultipliedColor = vec4<f32>(
                correctedColor.rgb * mix(1.0, sqrt(baseColor.a), overlapFactor), // Soften alpha impact on blending
                baseColor.a
            );

            // Apply slight saturation boost (prevents washed-out color)
            let saturationFactor = 1.15;
            let finalColor = mix(vec3<f32>(dot(premultipliedColor.rgb, vec3<f32>(0.3, 0.59, 0.11))), premultipliedColor.rgb, saturationFactor);

            // Apply inverse gamma correction (convert back to display color space)
            let displayColor = applyGamma(finalColor, 1.0 / 2.2);

            // Clamp the final color to prevent oversaturation
            let clampedColor = min(displayColor, vec3<f32>(0.9)); // Adjust the max brightness

            return vec4<f32>(clampedColor, premultipliedColor.a);
        }
        `;
    
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4, // 2 floats (x, y), 4 bytes each
            attributes: [
                {
                    shaderLocation: 0, // Must match `@location(0)` in shader
                    offset: 0,
                    format: 'float32x2', // Two floats per vertex
                },
            ],
        };

        // Create Shader Modules
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });
    
        // Define Bind Group Layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                }
            ]
        });
    
        // Create Pipeline Layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        // Create the Render Pipeline
        this.highlightPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: "main_vertex",
                buffers: [vertexBufferLayout]
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: "main_fragment",
                targets: [{
                    format: this.swapChainFormat,
                    blend: {
                        color: {
                            srcFactor: "src-alpha",  // Allow same highlight to blend normally
                            dstFactor: "one-minus-src-alpha", // This keeps adding RGB values, which can exceed (1.0, 1.0, 1.0)
                            operation: "add"
                        },
                        alpha: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        }
                    }
                }],
            },
            primitive: { topology: "triangle-list" },
            depthStencil: {
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Prevents depth blocking but still allows ordering (Ensures highlights don’t overwrite each other)
                depthCompare: "always",
                stencilFront: {
                    compare: "not-equal",  // Only render where stencil is not already written (Ensures highlights do not merge into one object)
                    failOp: "keep",
                    depthFailOp: "keep",
                    passOp: "replace"  // Replace stencil value so highlights don't stack (Marks stencil buffer for each unique highlight)
                },
                stencilBack: {
                    compare: "not-equal",
                    failOp: "keep",
                    depthFailOp: "keep",
                    passOp: "replace"
                }
            }
            
        });
    }

    private createBackgroundRenderPipeline() {
        
        // Vertex Shader (for full-screen quad)
        const vertexShaderCode = `
        @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            return vec4<f32>(position, 0.0, 1.0);  // Create the final position vector
        }
        `;
    
        // Fragment Shader (for dot pattern)
        const fragmentShaderCode = `
        @group(0) @binding(0) var<uniform> resolution: vec4<f32>;
        @group(0) @binding(1) var<uniform> worldMatrix: mat4x4<f32>;

        @fragment
        fn main_fragment(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
            
            let aspectRatio = resolution.x / resolution.y;
            
            // Convert fragment coordinates to UV coordinates (0 to 1)
            var uv = fragCoord.xy / resolution.xy;

            // Flip the Y-axis by inverting the Y coordinate
            uv.y = 1.0 - uv.y;

            // Convert UV to NDC space (-1 to 1)
            let uvNDC = uv * 2.0 - vec2(1.0, 1.0);

            // Apply the world matrix transformation (includes panning and scaling)
            var transformedUV = (worldMatrix * vec4<f32>(uvNDC, 0.0, 1.0)).xy;

            // Adjust the UVs back to the 0 to 1 range
            var adjustedUv = (transformedUV + vec2(1.0, 1.0)) / 2.0;

            // Control the size and spacing of dots
            let dotSize = 0.0650; // dot sizing
            let spacing = 0.03125;  // dot spacing

            // Calculate the position of the dot
            let dot = fract(adjustedUv / spacing) - vec2(0.5);
            let dist = length(dot);

            // Use step function to make the dots visible
            let insideDot = step(dist, dotSize); // 1.0 inside the dot, 0.0 outside

            // Background color
            // let backgroundColor = vec4<f32>(1, 1, 1, 1.0);
            let backgroundColor = vec4<f32>(.01, .01, .01, 1.0);

            // Dot color
            // let dotColor = vec4<f32>(0.90, 0.90, 0.90, 1);
            let dotColor = vec4<f32>(0.15, 0.1, 0.15, 1.0);

            // Choose between dot color and background color based on insideDot
            let color = mix(backgroundColor, dotColor, insideDot);

            // Output the final color
            return color;
        }
    `;
    
        // Create the shader modules
        const vertexShaderModule = this.device.createShaderModule({
            code: vertexShaderCode,
        });
    
        const fragmentShaderModule = this.device.createShaderModule({
            code: fragmentShaderCode,
        });
    
        // Define the vertex buffer layout for full-screen quad (no attributes needed)
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4, // 2 floats per vertex, 4 bytes per float
            attributes: [
                {
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x2',
                },
            ],
        };
    
        // Define the bind group layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0, // Matches resolution uniform in the shader
                    visibility: GPUShaderStage.FRAGMENT, // Both stages need access
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1, // Matches worldMatrix uniform in the shader
                    visibility: GPUShaderStage.FRAGMENT, // Ensure panOffset is visible to the vertex shader
                    buffer: { type: 'uniform' },
                },
            ]
        });
    
        // Create the pipeline layout using the bind group layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        // Create the pipeline for the background
        this.backgroundPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: 'main_vertex',
                buffers: [vertexBufferLayout],
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: 'main_fragment',
                targets: [{ 
                    format: this.swapChainFormat,
                 }],
            },
            primitive: { topology: 'triangle-list' },
            multisample: {
                count: this.sampleCount, // Ensure the sample count matches MSAA settings
            },
            depthStencil: {  // Ensure it matches the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false, // Only needed for actual depth testing
                depthCompare: "always",
            },
        });
    }

    private createBoundingBoxPipeline() {
        const vertexShaderCode = `
        @binding(0) @group(0) var<uniform> localMatrix: mat4x4<f32>;
        @binding(1) @group(0) var<uniform> worldMatrix: mat4x4<f32>;

        @vertex
        fn main_vertex(
            @location(0) position: vec2<f32>
        ) -> @builtin(position) vec4<f32> {

            let pos = localMatrix * vec4<f32>(position, 0.0, 1.0);
            var transformedPosition = worldMatrix * pos;
            return transformedPosition;
        }
    `;
    
        const fragmentShaderCode = `
            @fragment
            fn main_fragment() -> @location(0) vec4<f32> {
                return vec4<f32>(0.5, 0.1, 1.0, 1.0); // Blue color
            }
        `;
    
        const vertexShaderModule = this.device.createShaderModule({ code: vertexShaderCode });
        const fragmentShaderModule = this.device.createShaderModule({ code: fragmentShaderCode });

        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' }
                }
            ]
        });

        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });

        this.boundingBoxPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: vertexShaderModule,
                entryPoint: 'main_vertex',
                buffers: [{
                    arrayStride: 2 * 4,
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
                }]
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: 'main_fragment',
                targets: [{ format: this.swapChainFormat }]
            },
            primitive: { 
                topology: 'triangle-list',
            },
            multisample: {
                count: this.sampleCount,
            },
            depthStencil: {  // ✅ Add this to match the render pass
                format: "depth24plus-stencil8",
                depthWriteEnabled: false,
                depthCompare: "always",
            }
        });
    }

}