// src/rendering/webgpu-render-strategy.ts
import { RenderStrategy } from './render-strategy';
import { Node } from '../scene-graph/node';
import { Rectangle } from '../scene-graph/rectangle';
import { Circle } from '../scene-graph/circle';

export class WebGPURenderStrategy implements RenderStrategy {
    
    private device: GPUDevice;
    private pipeline: GPURenderPipeline;
    private canvas: HTMLCanvasElement;

    constructor(device: GPUDevice, pipeline: GPURenderPipeline, canvas: HTMLCanvasElement) {
        this.device = device;
        this.pipeline = pipeline;
        this.canvas = canvas;
    }

    render(node: Node, ctxOrEncoder: CanvasRenderingContext2D | GPURenderPassEncoder): void {
        if (!(ctxOrEncoder instanceof GPURenderPassEncoder)) {
            return; // Only handle GPURenderPassEncoder in this strategy
        }

        if (!node.visible) return;        

        const passEncoder = ctxOrEncoder;

        // Ensure we're dealing with a specific shape and render it using WebGPU
        if (node instanceof Rectangle) {
            this.drawRectangle(passEncoder, node);
        } else if (node instanceof Circle) {
            this.drawCircle(passEncoder, node);
        }
        // Add more shape handling as needed
        else {
            console.error('Node is not recognized by WebGPURenderStrategy:', node);
        }
    }

    private drawRectangle(passEncoder: GPURenderPassEncoder, rect: Rectangle) {
        // Create and update uniform buffers for both vertex and fragment shaders

        // vertex uniform data values MUST normalized to [-1,1] using canvas dimensions
        let normalizedX = (rect.x / this.canvas.width) * 2 - 1;
        let normalizedY = (rect.y / this.canvas.height) * 2 - 1;
        let normalizedWidth = (rect.width / this.canvas.width) * 2;
        let normalizedHeight = (rect.height / this.canvas.height) * 2;

        const vertexUniformData = new Float32Array([
            normalizedX, normalizedY,               // Position
            normalizedWidth, normalizedHeight,      // Size
        ]);
        const vertexUniformBuffer = this.createUniformBuffer(vertexUniformData);

        const fragmentUniformData = new Float32Array([
            rect.fillColor.r, rect.fillColor.g, rect.fillColor.b, rect.fillColor.a, // Color
        ]);
        const fragmentUniformBuffer = this.createUniformBuffer(fragmentUniformData);

        const bindGroup = this.createBindGroup(vertexUniformBuffer, fragmentUniformBuffer);

        // Set up the vertex buffer (for the rectangle geometry)
        const vertices = new Float32Array([
            0.0, 0.0,  // Bottom-left
            1.0, 0.0,  // Bottom-right
            0.0, 1.0,  // Top-left
            1.0, 1.0,  // Top-right
        ]);
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();

        // Render the rectangle
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(4, 1, 0, 0);
    }

    private createUniformBuffer(data: Float32Array): GPUBuffer {
        const uniformBuffer = this.device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.device.queue.writeBuffer(uniformBuffer, 0, data.buffer);

        return uniformBuffer;
    }

    private createBindGroup(vertexUniformBuffer: GPUBuffer, fragmentUniformBuffer: GPUBuffer): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: vertexUniformBuffer }}, // Vertex shader buffer
                { binding: 1, resource: { buffer: fragmentUniformBuffer }}, // Fragment shader buffer
            ],
        });
    }

    private drawCircle(passEncoder: GPURenderPassEncoder, circle: Circle) {
        
        // Normalize the position and size (radius)
        const normalizedX = (circle.x / this.canvas.width) * 2 - 1;
        const normalizedY = (circle.y / this.canvas.height) * 2 - 1;
        const normalizedRadiusX = (circle.radius / this.canvas.width) * 2;
        const normalizedRadiusY = (circle.radius / this.canvas.height) * 2;
    
        // Create and update uniform buffers for both vertex and fragment shaders
        const vertexUniformData = new Float32Array([
            normalizedX, normalizedY,       // Normalized Position (translation)
            normalizedRadiusX, normalizedRadiusY  // Normalized Radius (scaling factors)
        ]);
        const vertexUniformBuffer = this.createUniformBuffer(vertexUniformData);
    
        const fragmentUniformData = new Float32Array([
            circle.fillColor.r, circle.fillColor.g, circle.fillColor.b, circle.fillColor.a, // Color
        ]);
        const fragmentUniformBuffer = this.createUniformBuffer(fragmentUniformData);
    
        const bindGroup = this.createBindGroup(vertexUniformBuffer, fragmentUniformBuffer);
    
        // Circle drawing logic using triangle-list
        const numSegments = 30; // Increase number of segments for smoother circle
        const angleStep = (Math.PI * 2) / numSegments;
    
        const vertices: number[] = [];
    
        // Create the circle vertices using a triangle list approach
        for (let i = 0; i < numSegments; i++) {
            // Center of the circle for the current triangle
            vertices.push(0.0, 0.0); // center vertex
    
            // First perimeter point of the triangle
            const angle1 = i * angleStep;
            vertices.push(Math.cos(angle1), Math.sin(angle1)); 
    
            // Second perimeter point of the triangle (next segment)
            const angle2 = (i + 1) * angleStep;
            vertices.push(Math.cos(angle2), Math.sin(angle2));
        }
    
        const vertexBuffer = this.device.createBuffer({
            size: vertices.length * 4, // 4 bytes per float
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
    
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // Render the circle using triangle-list
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(vertices.length / 2, 1, 0, 0);
    }
}