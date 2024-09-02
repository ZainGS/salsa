import { SceneGraph } from "../scene-graph/scene-graph";
import { WebGPURenderStrategy } from "./render-strategies/webgpu-render-strategy";
import { Node } from "../scene-graph/node";
import { InteractionService } from '../services/interaction-service';
import { mat4, vec3, vec4 } from "gl-matrix";
import { Shape } from "../scene-graph/shapes/shape";

// src/renderer/webgpu-renderer.ts
export class WebGPURenderer {

    // Core Setup
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private shapePipeline!: GPURenderPipeline;
    private backgroundPipeline!: GPURenderPipeline;
    private boundingBoxPipeline!: GPURenderPipeline;
    private swapChainFormat: GPUTextureFormat = 'bgra8unorm';

    // User-Application State
    private interactionService: InteractionService;
    private lastRenderTime: number = 0;
    private renderThrottleTime: number = 8; // 16 ms for ~60 FPS
    private isDragging: boolean = false;
    
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
    private initialMouseOffset: {offsetX: number, offsetY: number} = {offsetX: 0, offsetY: 0};

    // Shape & World 
    private sceneGraph!: SceneGraph;
    private selectedNode: Node | null = null;
    private dragOffsetX: number = 0;
    private dragOffsetY: number = 0;

    // Multisample Anti-Aliasing
    private msaaTexture!: GPUTexture;
    private msaaTextureView!: GPUTextureView;
    private sampleCount: number = 1; // 4x MSAA

    constructor(canvas: HTMLCanvasElement, interactionService: InteractionService) {
         
        // Core Setup
        this.canvas = canvas;
        this.interactionService = interactionService;

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

    // Method to get the Bounding Box GPURenderPipeline
    public getBoundingBoxPipeline(): GPURenderPipeline {
        return this.boundingBoxPipeline;
    }
    
    public setSceneGraph(sceneGraph: SceneGraph) {
        this.sceneGraph = sceneGraph;
    }

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
            
            if(this.selectedNode) {
                (this.selectedNode as Shape).triggerRerender();
            }

            // Re-render the scene
            this.render();
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
            left: this.calculateDistance(mousePointArray, leftMidpoint),
            right: this.calculateDistance(mousePointArray, rightMidpoint),
            top: this.calculateDistance(mousePointArray, topMidpoint),
            bottom: this.calculateDistance(mousePointArray, bottomMidpoint),
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
    private calculateDistance(point1: number[], point2: number[]): number {
        return Math.sqrt(Math.pow(point1[0] - point2[0], 2) + Math.pow(point1[1] - point2[1], 2));
    }

    // Determines distance the mouse has moved from the shape during shape scaling
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

    private handleMouseDown(event: MouseEvent) {
        
        switch(event.button) {
            
            // LEFT MOUSE BUTTON
            case 0: 
                // ROTATING SHAPE
                if (this.selectedNode && this.isMouseNearRotationHandle(event.offsetX, event.offsetY, (this.selectedNode as Shape))) {
                    
                    this.isRotating = true;

                    // SET STARTING ROTATION STATE
                    this.initialMouseAngle = this.calculateMouseAngle(event.offsetX, event.offsetY, (this.selectedNode as Shape));
                    this.initialShapeRotation = this.selectedNode.rotation;
                }
                // SCALING SHAPE
                else if (this.selectedNode && this.isMouseNearScalingHandle(event.offsetX, event.offsetY, this.selectedNode as Shape)) {
                    const scalingSide = this.isMouseNearScalingHandle(event.offsetX, event.offsetY, this.selectedNode as Shape);
                    if (scalingSide) {
                        this.isScaling = true;
                        this.scalingSide = scalingSide;

                        // (CANVAS SPACE)
                        // Get Mouse Coordinates from MouseEvent 
                        const x = event.offsetX;
                        const y = event.offsetY;

                        // (MODEL WORLD SPACE CLICK)
                        // Transform the mouse coordinates back to model world space.
                        const [transformedX, transformedY] = this.transformMouseCoordinatesToWorldSpace(x, y);
                        this.lastMousePosition = {x: transformedX, y: transformedY};

                        // Store the initial dimensions and position of the shape
                        this.initialShapeDimensions = {
                            x: (this.selectedNode as Shape).x,
                            y: (this.selectedNode as Shape).y,
                            width: (this.selectedNode as Shape).width,
                            height: (this.selectedNode as Shape).height,
                        };

                    }
                }
                // DRAGGING SHAPE
                else {

                    this.isDragging = true;
    
                    // (CANVAS SPACE)
                    // Get Mouse Coordinates from MouseEvent 
                    const x = event.offsetX;
                    const y = event.offsetY;
            
                    // (MODEL WORLD SPACE CLICK)
                    // Transform the mouse coordinates back to model world space.
                    const [transformedX, transformedY] = this.transformMouseCoordinatesToWorldSpace(x, y);
                    
                    // Find the shape under the mouse
                    var newSelectedNode = this.findNodeUnderMouse(transformedX, transformedY);
                    if(newSelectedNode != this.selectedNode){
                        if(this.selectedNode) {
                            (this.selectedNode as Shape).deselect();
                        }
                        this.selectedNode = newSelectedNode;
                    }
    
                    // Calculate the offset between the mouse position and the shape's position
                    if (this.selectedNode) {
                        (this.selectedNode as Shape).select();
                        this.dragOffsetX = transformedX - this.selectedNode.x;
                        this.dragOffsetY = transformedY - this.selectedNode.y;
                    }
                }
                return
            
            // MIDDLE MOUSE BUTTON
            case 1:
                // PANNING WORLD
                this.isPanning = true;
                
                // Set initial mouse state + Prevent default middle-click behavior (auto-scroll)
                this.lastMousePosition = { x: event.clientX, y: event.clientY };
                event.preventDefault(); 
                return
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

            // Calculate delta movement in screen space
            const deltaX = (event.clientX - this.lastMousePosition.x);
            const deltaY = (event.clientY - this.lastMousePosition.y);

            // Scale Factor: To pan the world at the same rate as mouse movement
            var scaleFactor = 2;

            // Update pan offset in interaction service
            this.interactionService.adjustPan(deltaX*scaleFactor, deltaY*scaleFactor);

            // Update last mouse position
            this.lastMousePosition = { x: event.clientX, y: event.clientY };
            
            // Re-render the scene with updated transformations
            this.render();
        } 
        // DRAGGING SHAPE
        else if (this.isDragging && this.selectedNode) {

            // Get current mouse position in screen space
            const rect = this.canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;

            // Convert mouse position to model world space
            const [modelX, modelY] = this.transformMouseCoordinatesToWorldSpace(x, y);

            // Apply drag offsets
            this.selectedNode.x = modelX - this.dragOffsetX;
            this.selectedNode.y = modelY - this.dragOffsetY;

            // Update shape transformations
            this.selectedNode.updateLocalMatrix();

            // Re-render the scene
            this.render();
        }
        // ROTATING SHAPE
        else if(this.isRotating) {
            const currentMouseAngle = this.calculateMouseAngle(event.offsetX, event.offsetY, (this.selectedNode as Shape));
            const angleDifference = currentMouseAngle - this.initialMouseAngle;
            if(this.selectedNode)
            {
                (this.selectedNode as Shape).rotation = this.initialShapeRotation + angleDifference*20;
                (this.selectedNode as Shape).markDirty(); // Trigger a re-render
            }
        }
        // SCALING SHAPE
        else if (this.isScaling) {

            if (!this.lastMousePosition || !this.initialShapeDimensions || !this.selectedNode) {
                return; // Exit the function if lastMousePosition is null
            }

            // Rotation angle in radians
            const shapeRotation = this.selectedNode.rotation; 

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
            // For width scaling, project onto the rotated local X-axis
            const offsetAlongWidthAxis = mouseMovementX * cosTheta + mouseMovementY * sinTheta;

            // For height scaling, project onto the rotated local Y-axis
            const offsetAlongHeightAxis = -mouseMovementX * sinTheta + mouseMovementY * cosTheta;

            switch (this.scalingSide) {
                case 'left':
                    // Translate shape to keep the right edge fixed
                    this.selectedNode.x = this.initialShapeDimensions.x + offsetAlongWidthAxis * cosTheta / 2;
                    this.selectedNode.y = this.initialShapeDimensions.y + offsetAlongWidthAxis * sinTheta / 2;
                    // Adjust the width based on the offset along the axis
                    (this.selectedNode as Shape).width = this.initialShapeDimensions.width - offsetAlongWidthAxis;
                    break;

                case 'right':
                    // Translate shape to keep the right edge fixed
                    this.selectedNode.x = this.initialShapeDimensions.x + offsetAlongWidthAxis * cosTheta / 2;
                    this.selectedNode.y = this.initialShapeDimensions.y + offsetAlongWidthAxis * sinTheta / 2;
                    // Adjust the width based on the offset along the axis
                    (this.selectedNode as Shape).width = this.initialShapeDimensions.width + offsetAlongWidthAxis;
                    break;

                case 'bottom':
                    // Translate shape to keep the right edge fixed
                    this.selectedNode.x = this.initialShapeDimensions.x - offsetAlongHeightAxis  * sinTheta / 2;
                    this.selectedNode.y = this.initialShapeDimensions.y + offsetAlongHeightAxis * cosTheta / 2;
                    // Adjust the width based on the offset along the axis
                    (this.selectedNode as Shape).height = this.initialShapeDimensions.height - offsetAlongHeightAxis;
                    break;
                case 'top':
                    // Translate shape to keep the right edge fixed
                    this.selectedNode.x = this.initialShapeDimensions.x - offsetAlongHeightAxis * sinTheta / 2;
                    this.selectedNode.y = this.initialShapeDimensions.y + offsetAlongHeightAxis * cosTheta / 2;
                    // Adjust the width based on the offset along the axis
                    (this.selectedNode as Shape).height = this.initialShapeDimensions.height + offsetAlongHeightAxis;
                    break;
                case 'topRight':
                    // Translate shape to keep the right edge fixed
                    this.selectedNode.x = this.initialShapeDimensions.x - (offsetAlongHeightAxis * sinTheta / 2) + (offsetAlongWidthAxis * cosTheta / 2);
                    this.selectedNode.y = this.initialShapeDimensions.y + (offsetAlongHeightAxis * cosTheta / 2) + (offsetAlongWidthAxis * sinTheta / 2);
                    // Adjust the width based on the offset along the axis
                    (this.selectedNode as Shape).height = this.initialShapeDimensions.height + offsetAlongHeightAxis;
                    (this.selectedNode as Shape).width = this.initialShapeDimensions.width + offsetAlongWidthAxis;
                    break;
                case 'topLeft':
                    // Translate shape to keep the right edge fixed
                    this.selectedNode.x = this.initialShapeDimensions.x - (offsetAlongHeightAxis * sinTheta / 2) + (offsetAlongWidthAxis * cosTheta / 2);
                    this.selectedNode.y = this.initialShapeDimensions.y + (offsetAlongHeightAxis * cosTheta / 2) + (offsetAlongWidthAxis * sinTheta / 2);
                    // Adjust the width based on the offset along the axis
                    (this.selectedNode as Shape).height = this.initialShapeDimensions.height + offsetAlongHeightAxis;
                    (this.selectedNode as Shape).width = this.initialShapeDimensions.width - offsetAlongWidthAxis;
                    break;
                case 'bottomLeft':
                    // Translate shape to keep the right edge fixed
                    this.selectedNode.x = this.initialShapeDimensions.x - (offsetAlongHeightAxis * sinTheta / 2) + (offsetAlongWidthAxis * cosTheta / 2);
                    this.selectedNode.y = this.initialShapeDimensions.y + (offsetAlongHeightAxis * cosTheta / 2) + (offsetAlongWidthAxis * sinTheta / 2);
                    // Adjust the width based on the offset along the axis
                    (this.selectedNode as Shape).height = this.initialShapeDimensions.height - offsetAlongHeightAxis;
                    (this.selectedNode as Shape).width = this.initialShapeDimensions.width - offsetAlongWidthAxis;
                    break;
                case 'bottomRight':
                    // Translate shape to keep the right edge fixed
                    this.selectedNode.x = this.initialShapeDimensions.x - (offsetAlongHeightAxis * sinTheta / 2) + (offsetAlongWidthAxis * cosTheta / 2);
                    this.selectedNode.y = this.initialShapeDimensions.y + (offsetAlongHeightAxis * cosTheta / 2) + (offsetAlongWidthAxis * sinTheta / 2);
                    // Adjust the width based on the offset along the axis
                    (this.selectedNode as Shape).height = this.initialShapeDimensions.height - offsetAlongHeightAxis;
                    (this.selectedNode as Shape).width = this.initialShapeDimensions.width + offsetAlongWidthAxis;
                    break;
            }
        }
        else {
            if((this.selectedNode as Shape)?.boundingBox) {
                if (this.isMouseNearRotationHandle(mouseX, mouseY, (this.selectedNode as Shape))
                || this.isMouseNearScalingHandle(mouseX, mouseY, (this.selectedNode as Shape))) {
                    this.canvas.style.cursor = 'grab'; // Use your custom rotate cursor
                } else {
                    this.canvas.style.cursor = 'default';
                }
            }
        }
        
        if(this.selectedNode) {
            (this.selectedNode as Shape).triggerRerender();
        }
        
        this.lastRenderTime = currentTime;
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
            this.isRotating = false;
            this.isScaling = false;
        }
    }

    // Non-normalized, pixel-space coordinates for hit detection.
    private findNodeUnderMouse(x: number, y: number): Node | null {
        
        // Iterate through your scene graph and check if the x, y is within the bounds of any node.
        for (const node of this.sceneGraph.root.children) {
            if (node.containsPoint(x, y)) {
                return node;
            }
        }
        return null;
    }

    // Starting point of WebGPU Setup & Rendering Loop
    public async initialize() {
        await this.initWebGPU();
        this.createBackgroundRenderPipeline();
        this.createShapeRenderPipeline();
        this.createBoundingBoxPipeline();
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
    
        // Render shapes (uses the shape pipeline).
        this.renderShapes(passEncoder);
    
        // End the current render pass and submit all the recorded GPU commands (for   
        // rendering to our specific framebuffer: the canvas) to the GPU for execution.
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);
    }

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

    private renderShapes(passEncoder: GPURenderPassEncoder) {
        
        // Traverse scene graph and accumulate each shape's draw commands for  
        // the GPURenderPassEncoder (scoped to the Shape Pipeline) throughout 
        // the WebGPURenderStrategy.
        passEncoder.setPipeline(this.shapePipeline);
        this.sceneGraph.root.children.forEach(node => {
            const strategy = node.renderStrategy as WebGPURenderStrategy;
            strategy.render(node, passEncoder);
        });
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
                 }],
            },
            primitive: { topology: 'triangle-list' },
            multisample: {
                count: this.sampleCount, // Ensure the sample count matches MSAA settings
            },
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
        });
    }

}