import { SceneGraph } from "../scene-graph/scene-graph";
import { WebGPURenderStrategy } from "./render-strategies/webgpu-render-strategy";
import { Node } from "../scene-graph/node";
import { InteractionService } from '../services/interaction-service';
import { mat4, vec2, vec3 } from "gl-matrix";

// src/renderer/webgpu-renderer.ts
export class WebGPURenderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private shapePipeline!: GPURenderPipeline;
    private backgroundPipeline!: GPURenderPipeline;
    private swapChainFormat: GPUTextureFormat = 'bgra8unorm';

    // MSAA
    private msaaTexture!: GPUTexture;
    private msaaTextureView!: GPUTextureView;
    private sampleCount: number = 4; // 4x MSAA

    private sceneGraph!: SceneGraph;
    private selectedNode: Node | null = null;
    private dragOffsetX: number = 0;
    private dragOffsetY: number = 0;

    private interactionService: InteractionService;

    private isPanning: boolean = false;
    private lastMousePosition: { x: number, y: number } | null = null;

    constructor(canvas: HTMLCanvasElement, interactionService: InteractionService) {
        this.canvas = canvas;
        this.interactionService = interactionService;

        // Add event listeners for mouse events
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));

        // Add event listener for Ctrl + scroll
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));
    }

    public setSceneGraph(sceneGraph: SceneGraph) {
        this.sceneGraph = sceneGraph;
    }

    private handleWheel(event: WheelEvent) {
        if (event.ctrlKey) {
            event.preventDefault(); // Prevent the default zoom behavior in the browser
            const zoomDelta = event.deltaY * -0.0005; // Invert to zoom in on scroll up
    
            // Get mouse position relative to the canvas
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = event.clientX - rect.left;
            const mouseY = event.clientY - rect.top;
    
            // Adjust the zoom factor and pan offset
            this.interactionService.adjustZoom(zoomDelta, mouseX, mouseY);
    
            // Re-render the scene
            this.render();
        }
    }

    private handleMouseDown(event: MouseEvent) {
        if (event.button === 1) { // Middle mouse button
            this.isPanning = true;
            this.lastMousePosition = { x: event.clientX, y: event.clientY };
            event.preventDefault(); // Prevent default middle-click behavior (like auto-scroll)
        } else {
            const x = event.offsetX;
            const y = event.offsetY;
    
            // Transform the mouse coordinates back to the shape's coordinate space
            const [transformedX, transformedY] = this.transformMouseCoordinates(x, y);
            
            // Find the shape under the mouse
            this.selectedNode = this.findNodeUnderMouse(transformedX, transformedY);
    
            if (this.selectedNode) {
                // Calculate the offset between the mouse position and the shape's position
                this.dragOffsetX = transformedX - this.selectedNode.x;
                this.dragOffsetY = transformedY - this.selectedNode.y;
            }
        }
    }

    /* 
    The transformMouseCoordinates method takes the mouse coordinates and transforms them from 
    screen space into the shape's coordinate space using the inverse of the worldMatrix. This allows the 
    click detection to occur in the correct space relative to the transformed shapes.
    

    By inverting the worldMatrix, you effectively reverse the scaling, translation, and any other 
    transformations applied to the shapes, mapping the mouse position back to the original coordinate space of the shapes.

    The transformed coordinates are then used to detect which shape is being clicked and to calculate the offset for dragging.
    */
    private transformMouseCoordinates(x: number, y: number): [number, number] {
        // Get the inverse of the world matrix to transform back to shape space
        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());
    
        // Convert screen space (x, y) to NDC (-1 to 1)
        const ndcX = (x / this.canvas.width) * 2 - 1;
        const ndcY = (y / this.canvas.height) * -2 + 1;
    
        // Apply the inverse transformation
        const transformed = vec3.fromValues(ndcX, ndcY, 0);
        vec3.transformMat4(transformed, transformed, inverseWorldMatrix);
    
        // Return the transformed coordinates
        return [transformed[0], transformed[1]];
    }
    
    private lastRenderTime: number = 0;
    private renderThrottleTime: number = 8; // 16 ms for ~60 FPS

    private handleMouseMove(event: MouseEvent) {
        
        const currentTime = Date.now();
        if (currentTime - this.lastRenderTime < this.renderThrottleTime) {
            return; // Skip this frame if rendering is throttled
        }
    
        if (this.isPanning && this.lastMousePosition) {
            
            // Panning logic
            const dx = event.clientX - this.lastMousePosition.x;
            const dy = event.clientY - this.lastMousePosition.y;
    
            this.interactionService.adjustPan(dx, dy);
    
            this.lastMousePosition = { x: event.clientX, y: event.clientY };
            // Re-render the scene with the updated panOffset
            this.render();
        } else if (this.selectedNode) {
            // Node movement logic
            console.log("TEST");
            const rect = this.canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
    
            // Invert the world matrix to map the mouse position back to the original coordinate space
            const inverseWorldMatrix = mat4.create();
            mat4.invert(inverseWorldMatrix, this.interactionService.getWorldMatrix());
    
            // Create a vector for the mouse position and transform it using the inverse world matrix
            const point = vec3.fromValues((x / this.canvas.width) * 2 - 1, (y / this.canvas.height) * -2 + 1, 0);
            vec3.transformMat4(point, point, inverseWorldMatrix);
    
            // Update the position of the selected shape based on the transformed mouse position
            this.selectedNode.x = point[0] - this.dragOffsetX;
            this.selectedNode.y = point[1] - this.dragOffsetY;
    
            // Re-render the scene with the updated node position
            this.render();
        }
        console.log("TEST");
        this.lastRenderTime = currentTime;
    }

    private handleMouseUp(event: MouseEvent) {
        
        if (event.button === 1) { // Middle mouse button
            this.isPanning = false;
            this.lastMousePosition = null;
        }
        
        this.selectedNode = null;
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

    public async initialize() {
        await this.initWebGPU();
        this.createBackgroundRenderPipeline();
        this.createShapeRenderPipeline();
    }

    private async initWebGPU() {
        if (!navigator.gpu) {
            throw new Error("WebGPU is not supported on this browser.");
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("Failed to request WebGPU adapter.");
        }

        this.device = await adapter.requestDevice();
        this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;

        this.context.configure({
            device: this.device,
            format: this.swapChainFormat,
            alphaMode: 'premultiplied',
        });

        // Create MSAA texture
        this.createMSAATexture();
    }

    private createMSAATexture() {
        this.msaaTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            sampleCount: this.sampleCount,
            format: this.swapChainFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.msaaTextureView = this.msaaTexture.createView();
    }

    // Method to get the GPUDevice
    public getDevice(): GPUDevice {
        return this.device;
    }

    // Method to get the GPURenderPipeline
    public getShapePipeline(): GPURenderPipeline {
        return this.shapePipeline;
    }

    public render() {

        this.interactionService.updateWorldMatrix();
        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();
        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [{
                view: this.msaaTextureView, // Use MSAA texture view
                resolveTarget: textureView, // Resolve to the default swap chain texture
                loadOp: 'clear',
                clearValue: { r: 1, g: 1, b: 1, a: 1 },
                storeOp: 'store',
            }],
        };
    
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

        // Render the background with a dot pattern
        this.renderBackground(passEncoder);
    
        // Render shapes using the shape pipeline
        this.renderShapes(passEncoder);
    
        passEncoder.end();
    
        this.device.queue.submit([commandEncoder.finish()]);
    }

    private renderShapes(passEncoder: GPURenderPassEncoder) {
        
        // Render shapes within the scene graph
        passEncoder.setPipeline(this.shapePipeline);
        
        // Traverse scene graph and render children
        this.sceneGraph.root.children.forEach(node => {
            const strategy = node.renderStrategy as WebGPURenderStrategy;
            console.log(this.sceneGraph);
            strategy.render(node, passEncoder);
        });
    }

    private renderBackground(passEncoder: GPURenderPassEncoder) {
        passEncoder.setPipeline(this.backgroundPipeline); // Use background pipeline
        
        // Set up the pan offset uniform buffer

        // Retrieve pan offset and zoom factor from InteractionService
        const panOffset = this.interactionService.getPanOffset();

        // Normalize the pan offset based on the canvas size
        const normalizedPanX = (panOffset.x / this.canvas.width) * -1;
        const normalizedPanY = (panOffset.y / this.canvas.height) * -1;

        const panMatrixData = new Float32Array([normalizedPanX, normalizedPanY]);
    
        const panMatrixUniformBuffer = this.device.createBuffer({
            size: panMatrixData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    
        this.device.queue.writeBuffer(panMatrixUniformBuffer, 0, panMatrixData.buffer);

        // Set up the resolution uniform buffer
        const resolutionUniformData = new Float32Array([this.canvas.width, this.canvas.height, 0.0, 0.0]); // Pad to 16 bytes
        const resolutionUniformBuffer = this.device.createBuffer({
            size: resolutionUniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        this.device.queue.writeBuffer(resolutionUniformBuffer, 0, resolutionUniformData.buffer);

        // Set up the zoom factor uniform buffer
        const zoomFactorUniformData = new Float32Array([this.interactionService.getZoomFactor()]);
        const zoomFactorUniformBuffer = this.device.createBuffer({
            size: zoomFactorUniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.device.queue.writeBuffer(zoomFactorUniformBuffer, 0, zoomFactorUniformData.buffer);
    
        // Create a bind group with the uniform buffers
        const bindGroup = this.device.createBindGroup({
            layout: this.backgroundPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: resolutionUniformBuffer } },  // Fragment shader uniforms
                { binding: 1, resource: { buffer: zoomFactorUniformBuffer } },
                { binding: 2, resource: { buffer: panMatrixUniformBuffer } }, 
            ],
        });
    
        passEncoder.setBindGroup(0, bindGroup);
    
        // Use the full-screen quad vertex buffer
        const quadVertexBuffer = this.setupFullScreenQuad();
        passEncoder.setVertexBuffer(0, quadVertexBuffer);
    
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

        // Vertex Shader 
        const vertexShaderCode = `
        @group(0) @binding(5) var<uniform> worldMatrix: mat4x4<f32>;

        @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            let pos = vec4<f32>(position, 0.0, 1.0); // Convert to 4D vector
            let transformedPosition = worldMatrix * pos; // Apply the world matrix
            return transformedPosition;
        }
        `;
    
        // Fragment Shader for Shapes
        const shapeFragmentShaderCode = `
        @group(0) @binding(2) var<uniform> shapeColor: vec4<f32>;
    
        @fragment
        fn main_fragment() -> @location(0) vec4<f32> {
            return shapeColor; // Simply output the shape's color
        }
        `;
    
        // Create the shader modules
        const vertexShaderModule = this.device.createShaderModule({
            code: vertexShaderCode,
        });
    
        const fragmentShaderModule = this.device.createShaderModule({
            code: shapeFragmentShaderCode,
        });
    
        // Define the vertex buffer layout (same as before)
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 2 * 4, // 2 floats, each 4 bytes
            attributes: [
                {
                    shaderLocation: 0, // Corresponds to the attribute location in the shader
                    offset: 0,
                    format: 'float32x2',
                },
            ],
        };
    
        // Define the bind group layout
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX, // Add zoomFactor here
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 3, // For the pan offset 
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 4, // For the resolution
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 5, // For the world matrix
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' },
                },
            ]
        });
    
        // Create the pipeline layout using the bind group layout
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout]
        });
    
        // Create the pipeline for shapes
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
        @group(0) @binding(0) var<uniform> resolution: vec4<f32>;
        @group(0) @binding(1) var<uniform> zoomFactor: f32;
        @group(0) @binding(2) var<uniform> panOffset: vec2<f32>;

        @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            let scaledPosition = (position * zoomFactor); // Scale using zoom factor and then apply pan
            return vec4<f32>(scaledPosition, 0.0, 1.0);  // Create the final position vector
        }
        `;
    
        // Fragment Shader (for dot pattern)
        const fragmentShaderCode = `
        @group(0) @binding(0) var<uniform> resolution: vec4<f32>;
        @group(0) @binding(1) var<uniform> zoomFactor: f32;
        @group(0) @binding(2) var<uniform> panOffset: vec2<f32>;

        @fragment
        fn main_fragment(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
            // Convert fragment coordinates to UV coordinates (0 to 1)
            let uv = fragCoord.xy / resolution.xy;

            // Apply the pan offset to UV coordinates
            let panAdjustedUv = uv + (panOffset);

            // Scale UV by the zoom factor for higher quality rendering
            let scaledUv = panAdjustedUv * zoomFactor;

            // Control the size and spacing of dots
            let dotSize = 0.0650 * zoomFactor; // Adjust dot size according to the zoom factor
            let spacing = 0.03125 * zoomFactor;  // Adjust spacing according to the zoom factor

            // Adjust the spacing in the x direction by the aspect ratio
            let aspectRatio = resolution.x / resolution.y;
            let adjustedUv = vec2<f32>(panAdjustedUv.x * aspectRatio, panAdjustedUv.y);

            // Calculate the position of the dot
            let dot = fract(adjustedUv / spacing) - vec2(0.5);
            let dist = length(dot);

            // Use step function to make the dots visible
            let insideDot = step(dist, dotSize); // 1.0 inside the dot, 0.0 outside

            // Background color
            let backgroundColor = vec4<f32>(1, 1, 1, 1.0);

            // Dot color
            let dotColor = vec4<f32>(0.85, 0.85, 0.85, 0.95);

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
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, // Both stages need access
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1, // Matches zoomFactor uniform in the shader
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, // Ensure zoomFactor is visible to the vertex shader
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 2, // Matches panOffset uniform in the shader
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, // Ensure panOffset is visible to the vertex shader
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

}