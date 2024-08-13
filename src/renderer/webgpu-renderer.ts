import { SceneGraph } from "../scene-graph/scene-graph";
import { WebGPURenderStrategy } from "./webgpu-render-strategy";

// src/renderer/webgpu-renderer.ts
export class WebGPURenderer {
    private canvas: HTMLCanvasElement;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private pipeline!: GPURenderPipeline;
    private swapChainFormat: GPUTextureFormat = 'bgra8unorm';

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;

        // Add event listeners for mouse events
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));

        // Handle mouse events like you did with Canvas, but adapt them for WebGPU
    }

    handleMouseDown() {

    }

    handleMouseMove() {
        
    }

    handleMouseUp() {
        
    }

    public async initialize() {
        await this.initWebGPU();
        this.createRenderPipeline();
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
    }

    private createRenderPipeline() {

        // Vertex Shader
        const vertexShaderCode = `
        @group(0) @binding(0) var<uniform> vertexUniforms: vec4<f32>;

        @vertex
        fn main_vertex(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
            let scaledPosition = position * vertexUniforms.zw;  // Scale using width and height
            let pos = scaledPosition + vertexUniforms.xy;       // Translate using x and y
            return vec4<f32>(pos, 0.0, 1.0);
        }
        `;

        // Fragment Shader
        const fragmentShaderCode = `
        @group(0) @binding(1) var<uniform> fragmentUniforms: vec4<f32>;

        @fragment
        fn main_fragment() -> @location(0) vec4<f32> {
            return fragmentUniforms;  // Use the color defined in the fragment uniform
        }
        `;

        // Create the shader modules
        const vertexShaderModule = this.device.createShaderModule({
            code: vertexShaderCode,
        });

        const fragmentShaderModule = this.device.createShaderModule({
            code: fragmentShaderCode,
        });

        // Define the vertex buffer layout
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

        this.pipeline = this.device.createRenderPipeline({
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
        });
    }

    // Method to get the GPUDevice
    public getDevice(): GPUDevice {
        return this.device;
    }

    // Method to get the GPURenderPipeline
    public getPipeline(): GPURenderPipeline {
        return this.pipeline;
    }

    public render(sceneGraph: SceneGraph) {
        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();
        const renderPassDescriptor: GPURenderPassDescriptor = {
            colorAttachments: [{
                view: textureView,
                loadOp: 'clear',
                clearValue: { r: 1, g: 1, b: 1, a: 1 },
                storeOp: 'store',
            }],
        };

        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(this.pipeline);
        
        // We will render shapes here;
        // Render the scene graph.
        sceneGraph.root.children.forEach(node => {
            const strategy = node.renderStrategy as WebGPURenderStrategy;
            strategy.render(node, passEncoder);
        });

        passEncoder.end();

        this.device.queue.submit([commandEncoder.finish()]);
    }

}