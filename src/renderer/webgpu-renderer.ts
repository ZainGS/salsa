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
        @vertex
        fn main_vertex(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
            var positions = array<vec2<f32>, 3>(
                vec2<f32>(0.0, 0.5),
                vec2<f32>(-0.5, -0.5),
                vec2<f32>(0.5, -0.5)
            );
            let position = positions[vertexIndex];
            return vec4<f32>(position, 0.0, 1.0);
        }
        `;

        // Fragment Shader
        const fragmentShaderCode = `
        @fragment
        fn main_fragment() -> @location(0) vec4<f32> {
            return vec4<f32>(1.0, 0.0, 0.0, 1.0); // Red color
        }
        `;

        // Create the shader modules
        const vertexShaderModule = this.device.createShaderModule({
            code: vertexShaderCode,
        });

        const fragmentShaderModule = this.device.createShaderModule({
            code: fragmentShaderCode,
        });

        this.pipeline = this.device.createRenderPipeline({
            vertex: {
                module: vertexShaderModule,
                entryPoint: 'main_vertex',
            },
            fragment: {
                module: fragmentShaderModule,
                entryPoint: 'main_fragment',
                targets: [{ 
                    format: this.swapChainFormat,
                 }],
            },
            primitive: { topology: 'triangle-list' },
            layout: 'auto',
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