// src/rendering/webgpu-render-strategy.ts
import { RenderStrategy } from './render-strategy';
import { Node } from '../scene-graph/node';
import { WebGPUShape } from '../scene-graph/webgpu-shape';
import { Rectangle } from '../scene-graph/rectangle';
import { Circle } from '../scene-graph/circle';

export class WebGPURenderStrategy implements RenderStrategy {
    
    private device: GPUDevice;
    private pipeline: GPURenderPipeline;

    constructor(device: GPUDevice, pipeline: GPURenderPipeline) {
        this.device = device;
        this.pipeline = pipeline;
    }

    render(node: Node, ctxOrEncoder: CanvasRenderingContext2D | GPURenderPassEncoder, pipeline?: GPURenderPipeline): void {
        if (!(ctxOrEncoder instanceof GPURenderPassEncoder)) {
            return; // Only handle GPURenderPassEncoder in this strategy
        }
        const passEncoder = ctxOrEncoder;

        if (!node.visible) return;

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

    private drawRectangle(passEncoder: GPURenderPassEncoder, rectangle: Rectangle) {
        passEncoder.setPipeline(this.pipeline);

        // Create vertices based on the rectangle's properties (example placeholder logic)
        const vertices = new Float32Array([
            rectangle.x, rectangle.y,
            rectangle.x + rectangle.boundingBox!.width, rectangle.y,
            rectangle.x + rectangle.boundingBox!.width, rectangle.y + rectangle.boundingBox!.height,
            rectangle.x, rectangle.y + rectangle.boundingBox!.height,
        ]);

        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });

        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();

        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(4, 1, 0, 0);
    }

    private drawCircle(passEncoder: GPURenderPassEncoder, circle: Circle) {
        // Implement WebGPU-specific rendering logic for a circle
    }
}