import { SceneGraph } from "../scene-graph/scene-graph";
import { WebGPURenderStrategy } from "./render-strategies/webgpu-render-strategy";
import { Node } from "../scene-graph/node";

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

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;

        // Add event listeners for mouse events
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));

        // Handle mouse events like you did with Canvas, but adapt them for WebGPU
    }

    public setSceneGraph(sceneGraph: SceneGraph) {
        this.sceneGraph = sceneGraph;
    }

    private handleMouseDown(event: MouseEvent) {
        const x = event.offsetX;
        const y = event.offsetY;
    
        // Invert the y-coordinate for consistency
        const invertedY = this.canvas.height - y;
    
        // Find the shape under the mouse
        this.selectedNode = this.findNodeUnderMouse(x, invertedY);
    
        if (this.selectedNode) {
            // Calculate the offset between the mouse position and the shape's position
            this.dragOffsetX = x - this.selectedNode.x;
            this.dragOffsetY = invertedY - this.selectedNode.y;
        }
    }
    
    private lastRenderTime: number = 0;
    private renderThrottleTime: number = 8; // 16 ms for ~60 FPS
    private handleMouseMove(event: MouseEvent) {
        
        const currentTime = Date.now();
            if (currentTime - this.lastRenderTime < this.renderThrottleTime) {
            return; // Skip this frame
        }   

        if (this.selectedNode) {
            const x = event.offsetX;
            const y = event.offsetY;
    
            // Invert the y-coordinate for consistency
            const invertedY = this.canvas.height - y;
    
            // Update the position of the selected shape based on the mouse position and the drag offset
            this.selectedNode.x = x - this.dragOffsetX;  // Correct the application of dragOffsetX
            this.selectedNode.y = invertedY - this.dragOffsetY;  // Correct the application of dragOffsetY
    
            // Re-render the scene
            this.render();
            this.lastRenderTime = currentTime;
        }
    }

    private handleMouseUp(event: MouseEvent) {
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
        this.sceneGraph.root.children.forEach(node => {
            const strategy = node.renderStrategy as WebGPURenderStrategy;
            strategy.render(node, passEncoder);
        });
    }

    private renderBackground(passEncoder: GPURenderPassEncoder) {
        passEncoder.setPipeline(this.backgroundPipeline); // Use background pipeline
        
        // Set up the resolution uniform buffer
        const resolutionUniformData = new Float32Array([this.canvas.width, this.canvas.height, 0.0, 0.0]); // Pad to 16 bytes
        const resolutionUniformBuffer = this.device.createBuffer({
            size: resolutionUniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        this.device.queue.writeBuffer(resolutionUniformBuffer, 0, resolutionUniformData.buffer);
    
        // Create a bind group with the resolution uniform buffer
        const bindGroup = this.device.createBindGroup({
            layout: this.backgroundPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: resolutionUniformBuffer } },  // Fragment shader uniform
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

        // Vertex Shader (same as before)
        const vertexShaderCode = `
        @group(0) @binding(0) var<uniform> vertexUniforms: vec4<f32>;
    
        @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            let scaledPosition = position * vertexUniforms.zw;  // Scale using width and height
            let pos = scaledPosition + vertexUniforms.xy;       // Translate using x and y
            return vec4<f32>(pos, 0.0, 1.0);
        }
        `;
    
        // Fragment Shader for Shapes
        const shapeFragmentShaderCode = `
        @group(0) @binding(1) var<uniform> shapeColor: vec4<f32>;
    
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
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' }
                }
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
        @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            return vec4<f32>(position, 0.0, 1.0);
        }
        `;
    
        // Fragment Shader (for dot pattern)
        const fragmentShaderCode = `
        @group(0) @binding(0) var<uniform> resolution: vec4<f32>;

@fragment
fn main_fragment(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
    // Convert fragment coordinates to UV coordinates (0 to 1)
    let uv = fragCoord.xy / resolution.xy;

    // Control the size and spacing of dots
    let dotSize = 0.1; // Adjust this value for the size of the dots
    let spacing = 0.01;  // Adjust this value for the spacing between dots

    // Adjust the spacing in the x direction by the aspect ratio
    let aspectRatio = resolution.x / resolution.y;
    let adjustedUv = vec2<f32>(uv.x * aspectRatio, uv.y);

    // Calculate the position of the dot
    let dot = fract(adjustedUv / spacing) - vec2(0.5);
    let dist = length(dot);

    // Use step function to make the dots visible
    let insideDot = step(dist, dotSize); // 1.0 inside the dot, 0.0 outside

    // Background color
    let backgroundColor = vec4<f32>(1, 1, 1, 1.0);

    // Dot color
    let dotColor = vec4<f32>(0.85, 0.85, 0.85, 1.0);

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
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' }
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