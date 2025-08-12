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
import { Scribble } from "../../scene-graph/shapes/scribble";
import { Line } from "../../scene-graph/shapes/line";
import { Pattern } from "../../scene-graph/shapes/pattern";
import { BindGroupManager } from "./managers/bindgroup-manager";
import { PipelineManager } from "./managers/pipeline-manager";
import { Section } from "../../scene-graph/shapes/section";
import { SectionDrawingService } from "../../services/drawing/section-drawing-service";
import { Group } from "../../scene-graph/shapes/base/group";
import { StagingContainer } from "../util/staging-container";
import { StrokesStagingBuffer } from "../caches/buffers/strokes-staging-buffer";
import { SdfTextDrawingService } from "../../services/drawing/sdftext-drawing-service";
import { ScalingSide } from "../util/interaction-types";
import { getScalingSide, isNearRotationHandle, canvasPxToWorld, HIT } from "../util/handles";
import { CURSORS, ShapeDimensions, Vec2 } from "../../types/interaction";
import { pointInPolygon, polygonsIntersect } from "../util/geometry";
import { SelectionService } from "../../services/selection-service";
import { TransformController } from "../../services/transform-controller";

const RENDER = {
  throttleMs: 16,                  // ~60 FPS; was 8 with a 16ms comment
  indirectCommandStrideBytes: 5 * 4, // 5 uint32s = 20 bytes
} as const;

// src/renderer/webgpu-renderer.ts
export class WebGPURenderer {

    // Core Setup
    private canvas!: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private swapChainFormat: GPUTextureFormat = 'bgra8unorm';

    // User-Application State
    private pipelineManager: PipelineManager | null = null;
    private cacheService: CacheService | null = null;
    private lineDrawingService: LineDrawingService | null = null;
    private patternDrawingService: PatternDrawingService | null = null;
    private scribbleDrawingService: ScribbleDrawingService | null = null;
    private sectionDrawingService: SectionDrawingService | null = null;
    private highlightDrawingService: HighlightDrawingService | null = null;
    private textDrawingService: TextDrawingService | null = null;
    private sdfTextDrawingService: SdfTextDrawingService | null = null;
    private eraserService: EraserService | null = null;
    private interactionService: InteractionService;
    private selectionService!: SelectionService;
    private transformService!: TransformController;
    private lastRenderTime: number = 0;
    private renderThrottleTime: number = RENDER.throttleMs;
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
    private lastMousePosition: Vec2 | null = null;
    private initialShapeDimensions: ShapeDimensions | null = null;

    // Used to keep section children fixed while scaling section.
    private previousShapeDimensions: ShapeDimensions | null = null;

    /// Scaling
    private isScaling: boolean = false;
    private scalingSide: ScalingSide | null = null;
    // private initialMouseOffset: {offsetX: number, offsetY: number} = {offsetX: 0, offsetY: 0};

    // Shape & World 
    private sceneGraph!: SceneGraph;
    private primaryDraggedNode!: Node;
    private dragOffsetX: number = 0;
    private dragOffsetY: number = 0;
    private initialDragPositions: Map<Shape, { x: number; y: number }> = new Map();
    private initialGroupChildPositions: Map<Group, { x: number, y: number }> = new Map();

    // Multisample Anti-Aliasing
    // private msaaTexture!: GPUTexture;
    // private msaaTextureView!: GPUTextureView;
    
    private webGPURenderStrategy!: WebGPURenderStrategy;
    public stagingBuffer!: StrokesStagingBuffer;
    private bindGroupManager!: BindGroupManager;
    
    constructor(canvas: HTMLCanvasElement, interactionService: InteractionService) {
        // Core Setup
        this.initializeCanvas(canvas);
        this.interactionService = interactionService;
        window.addEventListener('keydown', this.handleKeyDown.bind(this)); // ADD THIS
    }

    private handleKeyDown(event: KeyboardEvent) {
        if ((event.key === 'g' || event.key === 'G') && this.interactionService.selectedNodes.size > 1) {
            this.groupSelectedShapes();
            event.preventDefault();
        }
        else if ((event.key === 'u' || event.key === 'U') && this.interactionService.selectedNodes.size >= 1) {
            this.ungroupSelectedShapes();
            event.preventDefault();
        }
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
    
    public setWebGPURenderStrategy(strategy: WebGPURenderStrategy) {
        this.webGPURenderStrategy = strategy;
    }

    public setSceneGraph(sceneGraph: SceneGraph) {
        this.sceneGraph = sceneGraph;
        this.selectionService = new SelectionService(sceneGraph.root);
        this.transformService = new TransformController(this.interactionService);
    }

    public setPipelineManager(
        pipelineManager: PipelineManager,
        bindGroupManager: BindGroupManager,
        cacheService: CacheService
    ) {
        this.pipelineManager = pipelineManager;
        this.bindGroupManager = bindGroupManager;
        this.cacheService = cacheService;
    }

    // Setter to assign CacheService
    public setCacheService(service: CacheService) {
        this.cacheService = service;
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

    // Setter to assign SectionDrawingService
    public setSectionDrawingService(service: SectionDrawingService) {
        this.sectionDrawingService = service;
    }

    // Setter to assign HighlightDrawingService
    public setHighlightDrawingService(service: HighlightDrawingService) {
        this.highlightDrawingService = service;
    }

    // Setter to assign TextDrawingService
    public setTextDrawingService(service: TextDrawingService) {
        this.textDrawingService = service;
    }

    // Setter to assign SdfTextDrawingService
    public setSdfTextDrawingService(service: SdfTextDrawingService) {
        this.sdfTextDrawingService = service;
    }
    
    private handleWheel(event: WheelEvent) {
        if (event.ctrlKey) {

            // Prevent the default zoom behavior in the browser
            event.preventDefault(); 

            // Invert to zoom in on scroll up
            const zoomDelta = event.deltaY * -0.001; 
    
            // Get mouse position relative to the canvas center (screen-space origin)
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = event.clientX - (rect.left + rect.width / 2);
            const mouseY = event.clientY - (rect.top  + rect.height / 2);
    
            // Adjust the zoom factor and pan offset
            this.interactionService.adjustZoom(zoomDelta, mouseX, mouseY);
            
            for (const node of this.interactionService.selectedNodes) {
                (node as Shape).triggerRerender();
            }
        }
    }

    // Determines angle the mouse has moved around the shape during shape rotation
    private calculateMouseAngle(mouseX: number, mouseY: number, shape: Shape): number {
        if (shape) {
            const [wx, wy] = this.screenToWorld(
                // mouseX/mouseY are canvas px when called; convert to client first:
                this.canvas.getBoundingClientRect().left + mouseX,
                this.canvas.getBoundingClientRect().top + mouseY
            );
            return Math.atan2(wy - shape.y, wx - shape.x);
        }
        return 0;
    }

    private isolatedGroup: Group | null = null;
    private lastClickTime: number = 0;
    
    private handleMouseDown(event: MouseEvent) {
        const DOUBLE_CLICK_THRESHOLD = 300; // ms
        const now = Date.now();
        const isDoubleClick = (now - this.lastClickTime) < DOUBLE_CLICK_THRESHOLD;
        this.lastClickTime = now;
    
        if (event.button === 1) {
            this.isPanning = true;
            this.lastMousePosition = [event.clientX, event.clientY];
            event.preventDefault();
            return;
        }
    
        if (event.button !== 0) return;
    
        if (this.interactionService.isPanToolSelected) {
            this.isPanning = true;
            this.lastMousePosition = [event.clientX, event.clientY];
            event.preventDefault();
            return;
        }
    
        if (
            this.lineDrawingService?.isEnabled ||
            this.scribbleDrawingService?.isEnabled ||
            this.sectionDrawingService?.isEnabled ||
            this.eraserService?.isEnabled ||
            this.highlightDrawingService?.isEnabled ||
            this.patternDrawingService?.isEnabled ||
            this.textDrawingService?.isEnabled ||
            this.sdfTextDrawingService?.isEnabled
        ) {
            this.interactionService.clearSelectedNodes();
            return;
        }
    
        const [mouseX, mouseY] = [event.offsetX, event.offsetY];
        const [worldX, worldY] = this.transformMouseCoordinatesToWorldSpace(mouseX, mouseY);
    
        // ROTATION
        if (this.interactionService.selectedNodes.size === 1) {
            const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
            if (isNearRotationHandle(shape, [worldX, worldY])) {
                this.isRotating = true;
                this.initialMouseAngle = this.calculateMouseAngle(mouseX, mouseY, shape);
                this.initialShapeRotation = shape.rotation;
                return;
            }
        }
    
        // SCALING
        if (this.interactionService.selectedNodes.size === 1) {
            const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
            const scalingSide = getScalingSide(shape, [worldX, worldY]);
            if (scalingSide) {
                this.isScaling = true;
                this.scalingSide = scalingSide;
                this.lastMousePosition = [worldX, worldY];
                this.initialShapeDimensions = {
                    x: shape.x,
                    y: shape.y,
                    width: shape.scaleX ?? shape.width,
                    height: shape.scaleY ?? shape.height,
                };
                this.previousShapeDimensions = {
                    x: shape.x,
                    y: shape.y,
                    width: shape.scaleX ?? shape.width,
                    height: shape.scaleY ?? shape.height,
                };
                return;
            }
        }
    
        var topNode = this.selectionService.findFirstNodeUnderMouse(worldX, worldY);
        // --- NEW: Evaluate double-click isolation first ---
        if (isDoubleClick && topNode instanceof Node && topNode.parent instanceof Group) {
            const parentGroup = topNode.parent;
            if (!this.isolatedGroup) {
                // First entry into isolation mode
                this.isolatedGroup = parentGroup;
            } else if (this.isDescendantOf(topNode, this.isolatedGroup)) {
                // Go deeper into isolation
                if (isDoubleClick && topNode instanceof Node && topNode.parent instanceof Group) {
                    if (!this.isolatedGroup) {
                        this.isolatedGroup = topNode.parent;
                    } else if (this.isDescendantOf(topNode, this.isolatedGroup)) {
                        // Walk up to the nearest Group under isolatedGroup
                        let ancestor = topNode instanceof Group ? topNode : topNode.parent;
                        while (ancestor && ancestor instanceof Group && ancestor.parent instanceof Group && this.isDescendantOf(ancestor.parent, this.isolatedGroup)) {
                            ancestor = ancestor.parent;
                        }
                        this.isolatedGroup = ancestor as Group;
                    }
                }
            }
        }

        if (this.isolatedGroup && (!topNode || !this.isDescendantOf(topNode, this.isolatedGroup))) {
            this.isolatedGroup = null;
            this.interactionService.clearSelectedNodes();
        }
    
        let selectionTarget: Node | null = null;
        if (topNode) {
            if (this.isolatedGroup && this.isDescendantOf(topNode, this.isolatedGroup)) {
                selectionTarget = topNode;
            } else if (topNode instanceof Shape || topNode instanceof Group) {
                let groupAncestor: Node | null = topNode.parent;
                while (groupAncestor instanceof Group && groupAncestor.parent instanceof Group) {
                    groupAncestor = groupAncestor.parent;
                }
                if (topNode instanceof Group) {
                    selectionTarget = topNode;
                } else {
                    selectionTarget = groupAncestor instanceof Group ? groupAncestor : topNode;
                }
            } else {
                selectionTarget = topNode;
            }
        }
    
        if (selectionTarget) {
            if (event.shiftKey) {
                if (this.interactionService.selectedNodes.has(selectionTarget)) {
                    this.interactionService.deselectNode(selectionTarget);
                } else {
                    this.interactionService.selectNode(selectionTarget);
                }
            } else {
                // If not already selected, replace selection
                if (!this.interactionService.selectedNodes.has(selectionTarget)) {
                    this.interactionService.clearSelectedNodes();
                    this.interactionService.selectNode(selectionTarget);
                }
                // else: shape was already selected — don't deselect others
            }
        } else {
            if (!event.shiftKey) {
                this.interactionService.clearSelectedNodes();
            }
    
            this.isDragging = false;
            this.isBoxSelecting = true;
    
            const [startX, startY] = this.transformMouseCoordinatesToWorldSpace(mouseX, mouseY);
            const previewBox = new Rectangle(
                startX, startY,
                1, 1,
                { r: 0.6, g: 0.55, b: 0.95, a: 0.25 },
                undefined,
                1,
                this.interactionService
            );
            previewBox.isPreview = true;
            previewBox.scaleX = 0.001;
            previewBox.scaleY = 0.001;
            this.interactionService.boxSelectPreview = previewBox;
            previewBox.markDirty();
    
            this.boxStart = { x: mouseX, y: mouseY };
            this.boxEnd = { x: mouseX, y: mouseY };
            return;
        }
    
        const selected = Array.from(this.interactionService.selectedNodes);
        if (selected.length > 0) {
            this.primaryDraggedNode = topNode && this.interactionService.selectedNodes.has(topNode) ? topNode : selected[0];
            this.dragOffsetX = worldX - this.primaryDraggedNode.x;
            this.dragOffsetY = worldY - this.primaryDraggedNode.y;
    
            this.initialDragPositions.clear();
            for (const node of selected) {
                if (node instanceof Shape || node instanceof Group) {
                    this.initialDragPositions.set(node, { x: node.x, y: node.y });
                }
            }
    
            if (this.primaryDraggedNode instanceof Section) {
                this.initialGroupChildPositions.clear();
                this.primaryDraggedNode.forEachDeep((node) => {
                    if (node instanceof Group) {
                        this.initialGroupChildPositions.set(node, { x: node.x, y: node.y });
                    }
                });
            }
            this.isDragging = true;
        }
    }

    private isDescendantOf(node: Node, group: Group): boolean {
        let current = node.parent;
        while (current) {
            if (current === group) return true;
            current = current.parent;
        }
        return false;
    }

    private groupSelectedShapes() {
        if (this.interactionService.selectedNodes.size <= 1) {
            console.log("Select at least 2 shapes to group.");
            return;
        }
    
        const selectedNodes = Array.from(this.interactionService.selectedNodes);
    
        // Step 1: Only group top-level selected nodes (skip nested ones)
        const topLevelNodes = selectedNodes.filter(node => {
            let current = node.parent;
            while (current) {
                if (this.interactionService.selectedNodes.has(current)) return false;
                current = current.parent;
            }
            return true;
        });
    
        const shapesToGroup = topLevelNodes.filter(n => n instanceof Shape || n instanceof Group) as (Shape | Group)[];
    
        if (shapesToGroup.length <= 1) {
            console.log("Select at least 2 top-level shapes/groups to group.");
            return;
        }
    
        const group = new Group(this.interactionService);
        group.zIndex = Math.max(...shapesToGroup.map(s => s.zIndex)) + 1;
    
        // Compute average world position to place new group at center
        const worldPositions: Vec2[] = shapesToGroup.map(node => {
            // const localToWorld = mat4.mul(mat4.create(), node.parentChainMatrix, node._localMatrix);
            const localToWorld = node.localMatrix;
            const result = vec4.transformMat4(vec4.create(), vec4.fromValues(0, 0, 0, 1), localToWorld);
            return [result[0], result[1]] as Vec2;
        });
    
        const avgX = worldPositions.reduce((sum, p) => sum + p[0], 0) / worldPositions.length;
        const avgY = worldPositions.reduce((sum, p) => sum + p[1], 0) / worldPositions.length;

        const avgCenter = vec4.fromValues(avgX, avgY, 0, 1);
        // Convert from world to local (relative to group.parent)
        const inverseParentMatrix = mat4.invert(mat4.create(), group.parentChainMatrix);
        vec4.transformMat4(avgCenter, avgCenter, inverseParentMatrix);

        group.x = avgCenter[0];
        group.y = avgCenter[1];
        group.updateLocalMatrix();

        const inverseGroupMatrix = mat4.invert(mat4.create(), group._localMatrix);

        for (const node of shapesToGroup) {
            const worldMatrix = mat4.mul(mat4.create(), node.parentChainMatrix, node._localMatrix);
            if (node instanceof Group) {
                const offset = vec4.fromValues(0, 0, 0, 1);
                vec4.transformMat4(offset, offset, worldMatrix);
                vec4.transformMat4(offset, offset, inverseGroupMatrix);
            
                node.x = offset[0];
                node.y = offset[1];
                node.updateLocalMatrix();
            
                node.parent?.removeChild(node);
                node.transformMode = "inherit";
                group.addChild(node);
            
                // Rebase children of the nested group
                this.fixNestedGroupChildren(node);
            }
            else {
                // Convert world position into group-local space
                const worldPos = vec4.fromValues(0, 0, 0, 1);
                vec4.transformMat4(worldPos, worldPos, worldMatrix);
                vec4.transformMat4(worldPos, worldPos, inverseGroupMatrix);

                node.x = worldPos[0];
                node.y = worldPos[1];
                node.updateLocalMatrix();

                node.parent?.removeChild(node);
                node.transformMode = "inherit";
                group.addChild(node);
            }
            
        }
    
        this.sceneGraph.root.addChild(group);
        group.recalculateSize();
    
        // Clear visual selection from old shapes
        for (const shape of shapesToGroup) {
            shape.deselect(); // Ensure visual deselection
        }

        this.interactionService.clearSelectedNodes();
        this.interactionService.selectNode(group);
        this.interactionService.onSceneGraphChanged.emit();
    }

    fixNestedGroupChildren(group: Group) {
        const inverseGroupMatrix = mat4.invert(mat4.create(), group.localMatrix);
    
        group.forEachDeep((child) => {
            if (child === group) return;
    
            const localToWorld = (child as Shape).localMatrix;
            const worldPos = vec4.transformMat4(vec4.create(), vec4.fromValues(0, 0, 0, 1), localToWorld);
            const newLocal = vec4.transformMat4(vec4.create(), worldPos, inverseGroupMatrix);
    
            child.x = newLocal[0];
            child.y = newLocal[1];
            child.updateLocalMatrix();
        });
    }

    private ungroupSelectedShapes() {
        const nodes = Array.from(this.interactionService.selectedNodes);
        const newlyUngroupedChildren: Node[] = [];

        for (const node of nodes) {
            if (node instanceof Group) {
                // Calculate the group's world position
                const groupWorldPos = this.getWorldPosition(node);

                // Move each immediate child to the scene root
                for (const child of node.children) {
                    // Calculate child's current world position
                    const childWorldPos = this.getWorldPosition(child);
                    
                    // Set new local position relative to scene root
                    child.x = childWorldPos[0] - groupWorldPos[0];
                    child.y = childWorldPos[1] - groupWorldPos[1];
                    child.updateLocalMatrix();

                    // Reparent to root
                    node.removeChild(child);
                    this.sceneGraph.root.addChild(child);
                    newlyUngroupedChildren.push(child);
                }

                // Remove the now-empty group
                if (node.parent) {
                    node.parent.removeChild(node);
                }
            }
        }

        // Select the newly ungrouped children
        this.interactionService.clearSelectedNodes();
        for (const child of newlyUngroupedChildren) {
            this.interactionService.selectNode(child);
        }

        this.interactionService.onSceneGraphChanged.emit();
    }

    private getWorldPosition(node: Node): [number, number] {
        const worldMatrix = mat4.multiply(
            mat4.create(),
            node.parentChainMatrix,
            (node as Shape | Group).localMatrix
        );
        const worldPos = vec4.transformMat4(
            vec4.create(),
            vec4.fromValues(0, 0, 0, 1),
            worldMatrix
        );
        return [worldPos[0], worldPos[1]];
    }

    /* About Transformed Mouse Coordinates:
    The transformMouseCoordinates method takes the mouse coordinates and transforms them from 
    screen space into the shape's coordinate space using the inverse of the worldMatrix. This allows the 
    click detection to occur in the correct space relative to the transformed shapes.

    By inverting the worldMatrix, you effectively reverse the scaling, translation, and any other 
    transformations applied to the shapes, mapping the mouse position back to the original coordinate space of the shapes.

    The transformed coordinates are then used to detect which shape is being clicked and to calculate the offset for dragging.
    -------------------------------------------------------------------------------------------------------------------------*/
    private transformMouseCoordinatesToWorldSpace(x: number, y: number): Vec2 {
        return this.canvasPxToWorld(x, y);
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
            const deltaX = event.clientX - this.lastMousePosition[0];
            const deltaY = event.clientY - this.lastMousePosition[1];
            var scaleFactor = 2;
            this.interactionService.adjustPan(deltaX * scaleFactor, deltaY * scaleFactor);
            this.lastMousePosition = [event.clientX, event.clientY];
        }
        // DRAGGING SHAPE
        else if (this.isDragging &&
            this.primaryDraggedNode &&
            this.interactionService.selectedNodes.size > 0 &&
            this.initialDragPositions.size > 0) {
   
            const [modelX, modelY] = this.screenToWorld(event.clientX, event.clientY);
        
            // Get original position of the node you clicked on
            const primaryInitial = this.initialDragPositions.get(this.primaryDraggedNode as Shape);
            if (!primaryInitial) return;
        
            // Calculate how far your mouse has moved relative to that shape's starting point
            const deltaX = modelX - (primaryInitial.x + this.dragOffsetX);
            const deltaY = modelY - (primaryInitial.y + this.dragOffsetY);
        
            for (const node of this.getTopLevelSelectedNodes()) {
                if (!(node instanceof Shape || node instanceof Group)) continue;
                const original = this.initialDragPositions.get(node);
                if (!original) continue;
            
                node.x = original.x + deltaX;
                node.y = original.y + deltaY;
                node.updateLocalMatrix();
            
                this.triggerRerenderForStrokesDeep(node);
            }

            // Keep children fixed when dragging a Section
            if (this.primaryDraggedNode instanceof Section) {
                const sectionInitial = this.initialDragPositions.get(this.primaryDraggedNode);
                if (!sectionInitial) return;
            
                const sectionDeltaX = modelX - (sectionInitial.x + this.dragOffsetX);
                const sectionDeltaY = modelY - (sectionInitial.y + this.dragOffsetY);

                // If you want even more precision later, you can cache the Section’s initial local matrix and invert+multiply
                // it just once instead of recomputing every frame. But your current approach is already very good and fast.
                this.primaryDraggedNode.forEachDeep((node) => {
                    if (node instanceof Group) {
                        const childInitial = this.initialGroupChildPositions.get(node);
                        if (!childInitial) return;
                
                        node.x = childInitial.x - sectionDeltaX;
                        node.y = childInitial.y - sectionDeltaY;
                        node.updateLocalMatrix();
                    }
                });
            }

            this.interactionService.updateWorldMatrix();
            this.interactionService.viewportBounds.markDirty();
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
                const box = new Rectangle(centerX, centerY, boxWidth, boxHeight, { r: 0.6, g: 0.55, b: 0.95, a: 0.25 }, undefined, 1, this.interactionService);
                box.isPreview = true;
                this.interactionService.boxSelectPreview = box;
                box.markDirty();
            } else {
                this.interactionService.boxSelectPreview.x = centerX;
                this.interactionService.boxSelectPreview.y = centerY;
                this.interactionService.boxSelectPreview.scaleX = boxWidth;
                this.interactionService.boxSelectPreview.scaleY = boxHeight;
                this.interactionService.boxSelectPreview.markDirty();
            }

            this.interactionService.clearSelectedNodes();
    
            // In every case where the shape’s bounding box is stored in local/object space, we must:
            // 1. Transform the corners into world space using shape.localMatrix.
            // 2. Run the SAT test between: worldCorners of the shape and selectionBox (also represented as a polygon in world space).
            // Selection box polygon (already in world space)
            
            // Define the selection box corners (it's axis-aligned)
            const selectionPolygon: Vec2[] = [
                [selectionBox.x, selectionBox.y],
                [selectionBox.x + selectionBox.width, selectionBox.y],
                [selectionBox.x + selectionBox.width, selectionBox.y + selectionBox.height],
                [selectionBox.x, selectionBox.y + selectionBox.height],
            ];

            // for (const node of this.sceneGraph.root.children) {
            //     if (!(node instanceof Shape)) continue;
            //     const shape = node as Shape;
            
            //     // General shapes use the base Shape implementation, but there are special cases 
            //     // for some shapes. I've listen them below and the method overrides for 
            //     // getWorldSpaceBoundingBoxPolygon() are implemented in those child classes.
            //     // General case: Just get the 4 local-space corners of the shape and transform to worldspace.
            //     // Special-case: Scribble or Highlight BB corners depends on their points array.
            //     // Special-case: Pattern BB corners depends on the vertices array.
            //     /** Then:
            //      * Check if a shape (which may be rotated) intersects with the selection box.
            //      * This accounts for rotation bc we transform the shape's BB corners into world space
            //      * and then perform polygon-based collision detection via SAT instead of simple AABB.
            //      */

            //     // TODO: Cache the transformed WSBBPolygon if nothing’s dirty to optimize performance later.                
            //     if (this.polygonsIntersect(shape.getWorldSpaceBoundingBoxPolygon(), selectionPolygon)) {
            //         shape.select();
            //         this.interactionService.selectedNodes.add(shape);
            //     } else {
            //         shape.deselect();
            //     }
            // }

            const allNodes = this.selectionService.findAllShapesDeep(this.sceneGraph.root);
            const topLevelMatches = allNodes.filter(node => {
                // Must intersect the selection box
                const intersects = polygonsIntersect(node.getWorldSpaceBoundingBoxPolygon(), selectionPolygon);

                // Exclude if any parent is also in the selection
                if (!intersects) return false;

                let current = node.parent;
                while (current) {
                    if (current instanceof Group && allNodes.includes(current)) {
                        return false; // Parent is also a matching shape/group → skip this one
                    }
                    current = current.parent;
                }
                return true;
            });

            for (const node of allNodes) {
                node.deselect();
            }
            for (const node of topLevelMatches) {
                node.select();
                this.interactionService.selectNode(node);
            }
        }
        // ROTATING SHAPE
        else if (this.isRotating && this.interactionService.selectedNodes.size === 1) {
            const shape = Array.from(this.interactionService.selectedNodes)[0] as Shape;
            const currentMouseAngle = this.calculateMouseAngle(mouseX, mouseY, shape);
            const angleDifference = currentMouseAngle - this.initialMouseAngle;
            shape.rotation = this.initialShapeRotation + angleDifference;
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
                const worldMouse: Vec2 = this.canvasPxToWorld(mouseX, mouseY);
                if (isNearRotationHandle(shape, worldMouse)) {
                    this.canvas.style.cursor = 'grab';
                } else {
                    const side = getScalingSide(shape, worldMouse);
                    this.canvas.style.cursor = side ? CURSORS[side] : 'default';
                }
            }
        }

        if (this.isDragging || this.isRotating || this.isScaling || this.isBoxSelecting) {
            for (const node of this.interactionService.selectedNodes) {
                (node as Shape).triggerRerender();
            }
        }
    
        this.lastRenderTime = currentTime;
    }

    private getTopLevelSelectedNodes(): Node[] {
        const allNodes = Array.from(this.interactionService.selectedNodes);
        return allNodes.filter(node => {
            let current = node.parent;
            while (current) {
                if (this.interactionService.selectedNodes.has(current)) {
                    return false; // If a parent is selected too, skip this node
                }
                current = current.parent;
            }
            return true;
        });
    }

    /* When dragging/moving a Group, you need to re-trigger rerender on any child scribbles/highlights/lines that 
       use world space geometry. Otherwise they don't move correctly while dragging. */
    triggerRerenderForStrokesDeep(node: Node) {
        node.forEachDeep(n => {
            if (n instanceof Scribble || n instanceof Highlight || n instanceof Line) {
                (n as Shape).triggerRerender();
            }
        });
    }

    /** When scaling a Section or ungrouping — if the Section/Group moves, 
     * you sometimes need to move its children back into world space correctly. 
     * Again: not just immediate children — all nested children recursively. */
    moveChildrenByDeltaDeep(node: Node, dx: number, dy: number) {
        node.forEachDeep(n => {
            if (n instanceof Shape) {
                n.x += dx;
                n.y += dy;
                n.updateLocalMatrix();
            }
        });
    }
    
    private handleScaling(event: MouseEvent, shape: Shape) {
        if (!this.lastMousePosition || !this.initialShapeDimensions) return;
    
        // Rotation angle in radians
        const shapeRotation = shape.rotation; 
    
        // Calculate cosine and sine of the angle
        const cosTheta = Math.cos(shapeRotation);
        const sinTheta = Math.sin(shapeRotation);
    
        // Convert mouse position to model world space
        const [modelX, modelY] = this.screenToWorld(event.clientX, event.clientY);
    
        // Calculate the mouse movement vector
        const mouseMovementX = modelX - this.lastMousePosition[0];
        const mouseMovementY = modelY - this.lastMousePosition[1];

        // Project the mouse movement onto the rotated axis
        const offsetAlongWidthAxis = (mouseMovementX * cosTheta + mouseMovementY * sinTheta);
        const offsetAlongHeightAxis = (-mouseMovementX * sinTheta + mouseMovementY * cosTheta);
    
        const minWidth = 0.05;
        const minHeight = 0.05;
    
        switch (this.scalingSide) {
            case 'left': {
                const newScaleX = this.initialShapeDimensions.width - offsetAlongWidthAxis;
                shape.scaleX = Math.max(minWidth, newScaleX);
            
                const dx = (this.initialShapeDimensions.width - shape.scaleX) / 2;
                shape.x = this.initialShapeDimensions.x + dx * cosTheta;
                shape.y = this.initialShapeDimensions.y + dx * sinTheta;
                break;
            }
            
            case 'right': {
                const newScaleX = this.initialShapeDimensions.width + offsetAlongWidthAxis;
                shape.scaleX = Math.max(minWidth, newScaleX);
            
                const dx = (shape.scaleX - this.initialShapeDimensions.width) / 2;
                shape.x = this.initialShapeDimensions.x + dx * cosTheta;
                shape.y = this.initialShapeDimensions.y + dx * sinTheta;
                break;
            }
            
            case 'top': {
                const newScaleY = this.initialShapeDimensions.height + offsetAlongHeightAxis;
                shape.scaleY = Math.max(minHeight, newScaleY);
            
                const dy = (shape.scaleY - this.initialShapeDimensions.height) / 2;
                shape.x = this.initialShapeDimensions.x - dy * sinTheta;
                shape.y = this.initialShapeDimensions.y + dy * cosTheta;
                break;
            }
            
            case 'bottom': {
                const newScaleY = this.initialShapeDimensions.height - offsetAlongHeightAxis;
                shape.scaleY = Math.max(minHeight, newScaleY);
            
                const dy = (this.initialShapeDimensions.height - shape.scaleY) / 2;
                shape.x = this.initialShapeDimensions.x - dy * sinTheta;
                shape.y = this.initialShapeDimensions.y + dy * cosTheta;
                break;
            }
            
            case 'topLeft': {
                const newScaleX = this.initialShapeDimensions.width - offsetAlongWidthAxis;
                const newScaleY = this.initialShapeDimensions.height + offsetAlongHeightAxis;
                shape.scaleX = Math.max(minWidth, newScaleX);
                shape.scaleY = Math.max(minHeight, newScaleY);
            
                const dx = (this.initialShapeDimensions.width - shape.scaleX) / 2;
                const dy = (shape.scaleY - this.initialShapeDimensions.height) / 2;
                shape.x = this.initialShapeDimensions.x + dx * cosTheta - dy * sinTheta;
                shape.y = this.initialShapeDimensions.y + dx * sinTheta + dy * cosTheta;
                break;
            }
            
            case 'topRight': {
                const newScaleX = this.initialShapeDimensions.width + offsetAlongWidthAxis;
                const newScaleY = this.initialShapeDimensions.height + offsetAlongHeightAxis;
                shape.scaleX = Math.max(minWidth, newScaleX);
                shape.scaleY = Math.max(minHeight, newScaleY);
            
                const dx = (shape.scaleX - this.initialShapeDimensions.width) / 2;
                const dy = (shape.scaleY - this.initialShapeDimensions.height) / 2;
                shape.x = this.initialShapeDimensions.x + dx * cosTheta - dy * sinTheta;
                shape.y = this.initialShapeDimensions.y + dx * sinTheta + dy * cosTheta;
                break;
            }
            
            case 'bottomLeft': {
                const newScaleX = this.initialShapeDimensions.width - offsetAlongWidthAxis;
                const newScaleY = this.initialShapeDimensions.height - offsetAlongHeightAxis;
                shape.scaleX = Math.max(minWidth, newScaleX);
                shape.scaleY = Math.max(minHeight, newScaleY);
            
                const dx = (this.initialShapeDimensions.width - shape.scaleX) / 2;
                const dy = (this.initialShapeDimensions.height - shape.scaleY) / 2;
                shape.x = this.initialShapeDimensions.x + dx * cosTheta - dy * sinTheta;
                shape.y = this.initialShapeDimensions.y + dx * sinTheta + dy * cosTheta;
                break;
            }
            
            case 'bottomRight': {
                const newScaleX = this.initialShapeDimensions.width + offsetAlongWidthAxis;
                const newScaleY = this.initialShapeDimensions.height - offsetAlongHeightAxis;
                shape.scaleX = Math.max(minWidth, newScaleX);
                shape.scaleY = Math.max(minHeight, newScaleY);
            
                const dx = (shape.scaleX - this.initialShapeDimensions.width) / 2;
                const dy = (this.initialShapeDimensions.height - shape.scaleY) / 2;
                shape.x = this.initialShapeDimensions.x + dx * cosTheta - dy * sinTheta;
                shape.y = this.initialShapeDimensions.y + dx * sinTheta + dy * cosTheta;
                break;
            }
        }
        shape.updateLocalMatrix();
        shape.markDirty(); // Trigger a re-render

        // --- LOGIC TO OFFSET CHILDREN IF SCALING SECTION ---
        if (shape instanceof Section && this.initialShapeDimensions) {
            const newCenterX = shape.x;
            const newCenterY = shape.y;
            const oldCenterX = this.previousShapeDimensions!.x;
            const oldCenterY = this.previousShapeDimensions!.y;
        
            // How much the Section moved (because of scaling)
            const deltaX = newCenterX - oldCenterX;
            const deltaY = newCenterY - oldCenterY;
        
            // Inverse move the children (only immediate children!)
            for (const child of shape.children) {
                child.x -= deltaX;
                child.y -= deltaY;
                child.updateLocalMatrix();
            }
            this.previousShapeDimensions!.x = shape.x;
            this.previousShapeDimensions!.y = shape.y;
        }
    }

    private handleMouseUp(event: MouseEvent) {

        if (this.isDragging || this.isScaling) {
            const touchedGroups = new Set<Group>();
        
            for (const node of this.interactionService.selectedNodes) {
                if (node instanceof Shape && node.parent instanceof Group) {
                    touchedGroups.add(node.parent);
                }
                else if (node instanceof Group) {
                    touchedGroups.add(node);
                }
            }
        
            for (const group of touchedGroups) {
                group.recalculateSize();
            }
        }

        // --- Handle Section aftermath (un-child shapes that moved outside) ---
        const sectionsChecked = new Set<Section>();

        for (const node of this.interactionService.selectedNodes) {
            if (!(node instanceof Shape)) continue;
            const shape = node;
            const parent = shape.parent;

            if (parent instanceof Section) {
                if (!sectionsChecked.has(parent)) {
                    parent.getWorldSpaceBoundingBoxPolygon(true); // Reset once per Section
                    sectionsChecked.add(parent);
                }
                const parentPolygon = parent.getWorldSpaceBoundingBoxPolygon(); // Now cached!
                const shapePolygon = shape.getWorldSpaceBoundingBoxPolygon(true);

                if (!polygonsIntersect(parentPolygon, shapePolygon)) {
                    // Shape is no longer inside Section → unparent it

                    parent.removeChild(shape);

                    // Adjust world position to stay consistent
                    shape.x += parent.x;
                    shape.y += parent.y;

                    this.sceneGraph.root.addChild(shape);

                    shape.updateLocalMatrix();
                    shape.markDirty();
                }
            }
        }

        // --- Check for Section scaling aftermath ---
        for (const node of this.interactionService.selectedNodes) {
            if (!(node instanceof Section)) continue;
            const section = node;

            const sectionPolygon = section.getWorldSpaceBoundingBoxPolygon(true);
            const children = [...section.children]; // Copy so we can safely modify during iteration

            for (const child of children) {
                if (!(child instanceof Shape)) continue;

                const childPolygon = child.getWorldSpaceBoundingBoxPolygon(true);

                if (!polygonsIntersect(sectionPolygon, childPolygon)) {
                    // Child is no longer inside Section after scaling → unparent it
                    section.removeChild(child);

                    // Adjust world position to stay consistent
                    child.x += section.x;
                    child.y += section.y;

                    this.sceneGraph.root.addChild(child);

                    child.updateLocalMatrix();
                    child.markDirty();
                }
            }
        }

        // Check deeply inside Groups that moved out of Sections
        for (const node of this.interactionService.selectedNodes) {
            if (!(node instanceof Group)) continue;

            for (const child of this.selectionService.findAllShapesDeep(node)) {
                const parent = child.parent;
                if (!(parent instanceof Section)) continue;

                if (!sectionsChecked.has(parent)) {
                    parent.getWorldSpaceBoundingBoxPolygon(true);
                    sectionsChecked.add(parent);
                }

                const parentPolygon = parent.getWorldSpaceBoundingBoxPolygon();
                const childPolygon = child.getWorldSpaceBoundingBoxPolygon(true);

                if (!polygonsIntersect(parentPolygon, childPolygon)) {
                    parent.removeChild(child);

                    child.x += parent.x;
                    child.y += parent.y;

                    this.sceneGraph.root.addChild(child);

                    child.updateLocalMatrix();
                    child.markDirty();
                }
            }
        }

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

        // Section logic
        if (this.primaryDraggedNode instanceof Shape || this.primaryDraggedNode instanceof Group) {
            const shape = this.primaryDraggedNode;
            const section = this.findTopSectionContainingShape(shape as Shape);
            
            if (section && section !== shape.parent) {
                // Subtract parent section's translation from shape to make it relative
                shape.x = shape.x - section.x;
                shape.y = shape.y - section.y;
        
                // Remove from old parent
                shape.parent?.removeChild(shape);
        
                // Add to section
                section.addChild(shape);
        
                // --- ADD THIS if shape is a Group ---
                if (shape instanceof Group) {
                    for (const child of shape.children) {
                        child.x -= section.x;
                        child.y -= section.y;
                        child.updateLocalMatrix();
                    }
                }
                // ----------------
        
                shape.updateLocalMatrix();
                shape.triggerRerender();
                
                // Optional: Z-index bump
                shape.zIndex = (section.zIndex ?? 0) + 1;
                shape.markDirty();
            }
        }
    }

    private findTopSectionContainingShape(shape: Shape): Section | null {
        const shapePolygon = shape.getWorldSpaceBoundingBoxPolygon();
    
        const candidates = this.sceneGraph.root.children.filter(n =>
            n instanceof Shape && n.getType?.() === "Section" && n !== shape
        ) as Section[];
    
        // Find all sections that contain the shape’s center
        const shapeCenter = [shape.x, shape.y] as [number, number];
        const containingSections = candidates.filter(section =>
            pointInPolygon(shapeCenter, section.getWorldSpaceBoundingBoxPolygon())
        );
    
        // Return topmost by zIndex (if overlapping)
        return containingSections.sort((a, b) => b.zIndex - a.zIndex)[0] || null;
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

        // Instantiate the staging buffer since device is now available
        this.stagingBuffer = new StrokesStagingBuffer(this.getDevice());
    }

    public async reinitialize(newCanvas: HTMLCanvasElement) {
        this.sceneGraph.root.children.length = 0;

        this.interactionService.canvas = newCanvas;

        // Reinitialize services to bind events to new canvas
        this.eraserService?.reinitializeEventListeners();
        this.highlightDrawingService?.reinitializeEventListeners();
        this.lineDrawingService?.reinitializeEventListeners();
        this.patternDrawingService?.reinitializeEventListeners();
        this.scribbleDrawingService?.reinitializeEventListeners();
        this.sectionDrawingService?.reinitializeEventListeners();
        this.textDrawingService?.reinitializeEventListeners();
        this.sdfTextDrawingService?.reinitializeEventListeners();

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

        //this.initBindGroups();
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
        // this.device = await adapter.requestDevice();

        this.device = await adapter.requestDevice({
            requiredFeatures: ["indirect-first-instance"],
        });

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

    public async render() {
        /* When the current visible nodes are sent to beginFrame(), we collect the staged scribbles, highlights,
        and lines into separate arrays. These staged shapes (e.g., an in-progress scribble) are rendered at the end of this render() 
        method so they appear visually on top of all other content.

        The beginFrame() method processes finalized (non-staged) shapes and prepares their corresponding
        IndirectDrawCommandBuffers. These buffers hold indirect draw commands, which allow all finalized shapes
        to be rendered in a single batched call using drawIndexedIndirect() in this render() method — improving performance
        since it is a batched and efficient WebGPU draw call..

        In contrast, staged shapes are not included in these command buffers. Instead, they are drawn manually 
        at the end of this render() method using drawIndexed() from the StrokesStagingBuffer, 
        since their geometry is dynamic and may change every frame.

        Finalized content is rendered first, followed by staged content to ensure proper z-order (staged shapes drawn on top).
        ------------------------------------------------------------------------------------------------------------------------*/
        const stagingContainer: StagingContainer = {
            scribbles: [],
            highlights: [],
            lines: [],
        };

        const commandEncoder = this.device.createCommandEncoder();    
        const textureView = this.context.getCurrentTexture().createView();
    
        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [{
                view: textureView,
                loadOp: 'clear',
                clearValue: { r: 1, g: 1, b: 1, a: 1 },
                storeOp: 'store',
            }],
            depthStencilAttachment: {  
                view: this.interactionService.depthTextureView,
                depthLoadOp: "clear",
                depthStoreOp: "store",
                depthClearValue: 1.0,
                stencilLoadOp: "clear",
                stencilStoreOp: "store",
                stencilClearValue: 0
            }
        };
    
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    
        // Render background
        this.renderBackground(passEncoder);
    
        // --- Indirect Rendering Starts ---
        /** The perfect structure:
            1. Shapes
            set shape pipeline + buffers
            drawIndexedIndirectCount(...);

            2. Strokes
            set stroke pipeline + buffers
            drawIndexedIndirectCount(...);

            3. Highlights
            set highlight pipeline + buffers
            drawIndexedIndirectCount(...);

            4. Bounding Boxes
            set box pipeline + buffers
            drawIndexedIndirectCount(...);
         */
        // console.log(this.sceneGraph);
        // const visibleNodes = this.sceneGraph.root.children
        //     .filter(node => node.visible)
        //     .sort((a, b) => a.zIndex - b.zIndex);
        const visibleNodes = this.getAllVisibleNodesRecursive(this.sceneGraph.root).sort((a, b) => a.zIndex - b.zIndex);

        if (this.interactionService.boxSelectPreview) {
            visibleNodes.push(this.interactionService.boxSelectPreview);
        }
        
        this.webGPURenderStrategy.beginFrame(visibleNodes, passEncoder, this.stagingBuffer, stagingContainer);
        this.webGPURenderStrategy.uploadDrawCommands();
        this.webGPURenderStrategy.uploadDrawCounts(this.device);
        const { shape, stroke, highlight, boundingBox, pattern, line, sdfText } = this.webGPURenderStrategy.getDrawBuffers();
        const { shape: shapeCount, 
                stroke: strokeCount, 
                highlight: highlightCount, 
                boundingBox: boxCount, 
                pattern: patternCount,
                line: lineCount, 
                sdfText: sdfTextCount } = this.webGPURenderStrategy.getDrawCounts();
        // console.log("Shapes:", shapeCount, "Strokes:", strokeCount, "Highlights:", highlightCount, "Boxes:", boxCount);

        const commandStride = 5 * 4; // 5 uint32s = 20 bytes (20 bytes per draw command)

        // Draw shapes
        passEncoder.setPipeline(this.pipelineManager!.getShapePipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedShapeBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.shapeGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.shapeGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < shapeCount; i++) {
            passEncoder.drawIndexedIndirect(shape, i * commandStride);
        }
        /** If the browser supports drawIndexedIndirectCount,
         *  We can batch all indexed draws in one call, using GPU-provided count — fast, clean, GPU-driven rendering.
         *  If it doesn’t (fallback path),
         *  You loop over draw calls, issuing one drawIndexedIndirect per shape (classic emulation).
         *  It works on all platforms, even without count support. */
        // if ('drawIndexedIndirectCount' in passEncoder) {
        //     console.log("Chrome Canary test working (drawIndexedIndirectCount).");
        //     const countBuffer = this.webGPURenderStrategy.getDrawCountBuffer();
        //     const countOffset = this.webGPURenderStrategy['drawCountBufferOffsets']['shape']; // Offset in bytes (0 for shapes)
        //     (passEncoder as any).drawIndexedIndirectCount(
        //         shape,         // indirectBuffer    (Each indirect draw command is exactly 20 bytes = 5 u32s)
        //         0,             // indirectOffset
        //         countBuffer,   // countBuffer       (shared 16-byte buffer)
        //         countOffset,   // countBufferOffset (0 for 'shape', 4 for 'stroke', etc.)
        //         shapeCount     // maxDrawCount (used to bound GPU-generated count)
        //     );
        // }
        // else {
            
        // }

        // Draw strokes (scribbles)
        passEncoder.setPipeline(this.pipelineManager!.getScribblePipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedScribbleBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.strokeGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.strokeGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < strokeCount; i++) {
            passEncoder.drawIndexedIndirect(stroke, i * commandStride);
        }

        // Draw lines
        passEncoder.setPipeline(this.pipelineManager!.getLinePipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedLineBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.lineGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.lineGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < lineCount; i++) {
            passEncoder.drawIndexedIndirect(line, i * commandStride);
        }

        // if ('drawIndexedIndirectCount' in passEncoder) {
        //     console.log("TEST");
        //     const countBuffer = this.webGPURenderStrategy.getDrawCountBuffer();
        //     const countOffset = this.webGPURenderStrategy['drawCountBufferOffsets']['stroke']; // 4 for strokes
        //     (passEncoder as any).drawIndexedIndirectCount(
        //         stroke,        // indirect buffer
        //         0,             // indirectOffset
        //         countBuffer,   // shared draw count buffer
        //         countOffset,   // byte offset for 'stroke' (4)
        //         strokeCount    // maxDrawCount
        //     );
        // } else {
            
        // }

        // Draw SDF Text
        // console.log(
        // "sdf verts",  this.cacheService!.sdfTextGeometryCache.vertexOffset,
        // "indices",    this.cacheService!.sdfTextGeometryCache.indexOffset,
        // "draws",      sdfTextCount
        // );

        passEncoder.setPipeline(this.pipelineManager!.getSdfTextPipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedSdfTextBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.sdfTextGeometryCache.getVertexBuffer());  
        passEncoder.setIndexBuffer(this.cacheService!.sdfTextGeometryCache.getIndexBuffer(), 'uint16');

        for (let i = 0; i < sdfTextCount; i++) {
            passEncoder.drawIndexedIndirect(sdfText, i * commandStride);
        }

        // Draw highlights (separate from other strokes)
        passEncoder.setPipeline(this.pipelineManager!.getHighlightPipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedHighlightBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.highlightGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.highlightGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < highlightCount; i++) {
            const zIndex = this.webGPURenderStrategy.highlightDrawCommands.getZIndexAt(i);
            passEncoder.setStencilReference(i+1);
            passEncoder.drawIndexedIndirect(highlight, i * commandStride);
        }

        // if ('drawIndexedIndirectCount' in passEncoder) {
        //     const countBuffer = this.webGPURenderStrategy.getDrawCountBuffer();
        //     const countOffset = this.webGPURenderStrategy['drawCountBufferOffsets']['highlight']; // 8 for highlights
        //     (passEncoder as any).drawIndexedIndirectCount(
        //         highlight,     // indirect buffer for highlight draw commands
        //         0,             // indirectOffset
        //         countBuffer,   // shared draw count buffer
        //         countOffset,   // byte offset for 'highlight' (8)
        //         highlightCount // maxDrawCount
        //     );
        // } else {
            
        // }
    
        this.renderStagingShapes(passEncoder, stagingContainer.scribbles, this.pipelineManager!.getStagingLinePipeline(), s => this.stagingBuffer.writeStroke(s));
        this.renderStagingShapes(passEncoder, stagingContainer.lines, this.pipelineManager!.getStagingLinePipeline(), l => this.stagingBuffer.writeLine(l));
        this.renderStagingShapes(passEncoder, stagingContainer.highlights, this.pipelineManager!.getStagingHighlightPipeline(), h => this.stagingBuffer.writeStroke(h));

        // Draw bounding boxes
        passEncoder.setPipeline(this.pipelineManager!.getBoundingBoxPipeline());
        passEncoder.setBindGroup(0, this.bindGroupManager.sharedBoundingBoxBindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService!.boundingBoxGeometryCache.getVertexBuffer());
        passEncoder.setIndexBuffer(this.cacheService!.boundingBoxGeometryCache.getIndexBuffer(), 'uint16');
        for (let i = 0; i < boxCount; i++) {
            passEncoder.drawIndexedIndirect(boundingBox, i * commandStride);
        }

        // Draw Patterns
        // passEncoder.setPipeline(this.pipelineManager!.getPatternPipeline());
        // passEncoder.setBindGroup(0, this.bindGroupManager.sharedPatternBindGroup);
        // passEncoder.setBindGroup(1, this.bindGroupManager.sharedPatternTextureBindGroup);
        // passEncoder.setVertexBuffer(0, this.cacheService!.patternGeometryCache.getVertexBuffer());
        // passEncoder.setIndexBuffer(this.cacheService!.patternGeometryCache.getIndexBuffer(), 'uint16');
        // for (let i = 0; i < patternCount; i++) {
        //     passEncoder.drawIndexedIndirect(pattern, i * commandStride);
        // }
    
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

    private renderStagingShapes<T extends Shape>(
        passEncoder: GPURenderPassEncoder,
        shapes: T[],
        pipeline: GPURenderPipeline,
        writeMethod: (shape: T) => any
        ): void {
            const layout = pipeline.getBindGroupLayout(0);
            passEncoder.setPipeline(pipeline);

            for (const shape of shapes) {
                const uniformData = this.getStrokeUniformData(shape);
                this.stagingBuffer.writeUniforms(uniformData);
                const bindGroup = this.stagingBuffer.createStagingBindGroup(layout);
                shape._stagingInfo = writeMethod(shape);
                this.stagingBuffer.renderStagingStroke(passEncoder, bindGroup);
            }
    }

    private getStrokeUniformData(shape: Shape): Float32Array {
        const canvas = this.interactionService.canvas;
        const resolution = new Float32Array([canvas.width, canvas.height, 0, 0]);
        const worldMatrix = this.interactionService.getWorldMatrix();
        const localMatrix = shape.localMatrix;
        const colorSource = shape.strokeColor;
        const shapeColor = new Float32Array([colorSource.r, colorSource.g, colorSource.b, colorSource.a]);
        const uniformData = new Float32Array(64);
        
        uniformData.set(resolution, 0);       // [0-3]
        uniformData.set(worldMatrix, 4);      // [4-19]
        uniformData.set(localMatrix, 20);     // [20-35]
        uniformData.set(shapeColor, 36);      // [36-39]
        uniformData[40] = shape.strokeWidth; // thickness
        uniformData[63] = 0; // Explicitly set last element
        // [40-63] will remain padded with 0s automatically
        return uniformData;
    }

    getAllVisibleNodesRecursive(node: Node): Node[] {
        const nodes: Node[] = [];
        if (node.visible) nodes.push(node);
    
        for (const child of node.children) {
            nodes.push(...this.getAllVisibleNodesRecursive(child));
        }
    
        return nodes;
    }

    private backgroundColor: Float32Array = new Float32Array([0.1059, 0.1059, 0.1059, 1]); // Default background color
    public setBackgroundColor(r: number, g: number, b: number, a: number = 1.0) {
        this.backgroundColor.set([r, g, b, a]);
    }
    public getBackgroundColor() {
        return this.backgroundColor;
    }
    public getBackgroundColorHex(): string {
        return this.rgbaToHex(this.backgroundColor);
    }

    private dotColor: Float32Array = new Float32Array([0.2078, 0.2078, 0.2078, 1]); // Default dot color
    public setDotColor(r: number, g: number, b: number, a: number = 1.0) {
        this.dotColor.set([r, g, b, a]);
    }
    public getDotColor() {
        return this.dotColor;
    }
    public getDotColorHex(): string {
        return this.rgbaToHex(this.dotColor);
    }

    // Helper to convert RGBA [0–1] to hex string
    private rgbaToHex(color: Float32Array): string {
        const toHex = (value: number) => {
            const hex = Math.round(value * 255).toString(16).padStart(2, '0');
            return hex;
        };
        const r = toHex(color[0]);
        const g = toHex(color[1]);
        const b = toHex(color[2]);
        return `${r}${g}${b}`;
    }

    private renderBackground(passEncoder: GPURenderPassEncoder) {
        
        passEncoder.setPipeline(this.pipelineManager!.getBackgroundPipeline()); // Use background pipeline

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

        const backgroundColorBuffer = this.device.createBuffer({
            size: this.backgroundColor.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(backgroundColorBuffer, 0, this.backgroundColor.buffer);

        const dotColorBuffer = this.device.createBuffer({
            size: this.dotColor.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(dotColorBuffer, 0, this.dotColor.buffer);

        // Create a bind group with the uniform buffers
        const bindGroup = this.device.createBindGroup({
            layout: this.pipelineManager!.getBackgroundPipeline().getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: resolutionUniformBuffer } },
                { binding: 1, resource: { buffer: worldMatrixUniformBuffer } }, 
                { binding: 2, resource: { buffer: backgroundColorBuffer } },
                { binding: 3, resource: { buffer: dotColorBuffer } },
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

    private clientToCanvasXY(clientX: number, clientY: number): Vec2 {
        const rect = this.canvas.getBoundingClientRect();
        return [clientX - rect.left, clientY - rect.top];
    }

    /** Preferred: use client coordinates straight from the MouseEvent */
    private screenToWorld(clientX: number, clientY: number): Vec2 {
        const [cx, cy] = this.clientToCanvasXY(clientX, clientY);
        return this.canvasPxToWorld(cx, cy);
    }

    private canvasPxToWorld(xCanvas: number, yCanvas: number): Vec2 {
        return canvasPxToWorld(xCanvas, yCanvas, this.canvas, this.interactionService);
    }

}