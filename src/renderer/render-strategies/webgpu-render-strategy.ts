// src/rendering/webgpu-render-strategy.ts
import { RenderStrategy } from './render-strategy';
import { Node } from '../../scene-graph/node';
import { Rectangle } from '../../scene-graph/shapes/rectangle';
import { Circle } from '../../scene-graph/shapes/circle';
import { Diamond } from '../../scene-graph/shapes/diamond';
import { Triangle } from '../../scene-graph/shapes/triangle';
import { InvertedTriangle } from '../../scene-graph/shapes/inverted-triangle';

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
        } else if (node instanceof Diamond) {
            this.drawDiamond(passEncoder, node);
        } else if (node instanceof Triangle) {
            this.drawTriangle(passEncoder, node);
        } else if (node instanceof InvertedTriangle) {
            this.drawInvertedTriangle(passEncoder, node);
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

        const indices = new Uint16Array([
            0, 1, 2,  // First triangle (bottom-left, bottom-right, top-left)
            2, 1, 3,  // Second triangle (top-left, bottom-right, top-right)
        ]);

        const indexBuffer = this.device.createBuffer({
            size: indices.byteLength,
            usage: GPUBufferUsage.INDEX,
            mappedAtCreation: true,
        });

        new Uint16Array(indexBuffer.getMappedRange()).set(indices);
        indexBuffer.unmap();

        // Render the rectangle
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');

        /* 
        With passEncoder.draw(...), the vertices are used in the order they appear in the 
        vertex buffer. If the vertex buffer doesn’t naturally describe the two triangles 
        forming a rectangle, the GPU might render something unexpected, like a single triangle.

        Instead, passEncoder.drawIndexed(...) allows you to explicitly define how to connect 
        vertices using the index buffer, which makes it easier to create shapes like rectangles 
        from triangles, even if the vertex data isn’t naturally ordered.

        The index buffer provides the flexibility to reuse vertices efficiently, meaning you can 
        define a rectangle with just four vertices instead of six, and use the index buffer 
        to connect them in the correct order.
        */
        // passEncoder.draw(6, 1, 0, 0);
        passEncoder.drawIndexed(6, 1, 0, 0);
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

    private drawDiamond(passEncoder: GPURenderPassEncoder, diamond: Diamond) {
        // Create and update uniform buffers for both vertex and fragment shaders
    
        // vertex uniform data values MUST be normalized to [-1,1] using canvas dimensions
        let normalizedX = (diamond.x / this.canvas.width) * 2 - 1;
        let normalizedY = (diamond.y / this.canvas.height) * 2 - 1;
        let normalizedWidth = (diamond.width / this.canvas.width) * 2;
        let normalizedHeight = (diamond.height / this.canvas.height) * 2;
    
        const vertexUniformData = new Float32Array([
            normalizedX, normalizedY,               // Position
            normalizedWidth, normalizedHeight,      // Size
        ]);
        const vertexUniformBuffer = this.createUniformBuffer(vertexUniformData);
    
        const fragmentUniformData = new Float32Array([
            diamond.fillColor.r, diamond.fillColor.g, diamond.fillColor.b, diamond.fillColor.a, // Color
        ]);
        const fragmentUniformBuffer = this.createUniformBuffer(fragmentUniformData);
    
        const bindGroup = this.createBindGroup(vertexUniformBuffer, fragmentUniformBuffer);
    
        // Set up the vertex buffer for the diamond shape
        const vertices = new Float32Array([
            0.5, 0.0,  // Right (midpoint of the right edge)
            1.0, 0.5,  // Top (midpoint of the top edge)
            0.5, 1.0,  // Left (midpoint of the left edge)
            0.0, 0.5,  // Bottom (midpoint of the bottom edge)
        ]);
    
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        const indices = new Uint16Array([
            0, 1, 3,  // First triangle (Right, Top, Bottom)
            1, 2, 3,  // Second triangle (Top, Left, Bottom)
        ]);
    
        const indexBuffer = this.device.createBuffer({
            size: indices.byteLength,
            usage: GPUBufferUsage.INDEX,
            mappedAtCreation: true,
        });
    
        new Uint16Array(indexBuffer.getMappedRange()).set(indices);
        indexBuffer.unmap();
    
        // Render the diamond
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(6, 1, 0, 0);
    }

    private drawTriangle(passEncoder: GPURenderPassEncoder, triangle: Triangle) {
        // Normalize the position and size to [-1,1] based on canvas dimensions
        let normalizedX = (triangle.x / this.canvas.width) * 2 - 1;
        let normalizedY = (triangle.y / this.canvas.height) * 2 - 1;
        let normalizedWidth = (triangle.width / this.canvas.width) * 2;
        let normalizedHeight = (triangle.height / this.canvas.height) * 2;
    
        const vertexUniformData = new Float32Array([
            normalizedX, normalizedY,               // Position
            normalizedWidth, normalizedHeight,      // Size
        ]);
        const vertexUniformBuffer = this.createUniformBuffer(vertexUniformData);
    
        const fragmentUniformData = new Float32Array([
            triangle.fillColor.r, triangle.fillColor.g, triangle.fillColor.b, triangle.fillColor.a, // Color
        ]);
        const fragmentUniformBuffer = this.createUniformBuffer(fragmentUniformData);
    
        const bindGroup = this.createBindGroup(vertexUniformBuffer, fragmentUniformBuffer);
    
        // Define triangle vertices
        const vertices = new Float32Array([
            0.5, 1.0,  // Top-middle
            1.0, 0.0,  // Bottom-right
            0.0, 0.0,  // Bottom-left
        ]);
    
        // Create the vertex buffer with GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
    
        // Write data to the vertex buffer (ensure alignment to 4 bytes)
        this.device.queue.writeBuffer(vertexBuffer, 0, vertices.buffer, vertices.byteOffset, vertices.byteLength);
    
        // Define triangle indices
        const indices = new Uint16Array([
            0, 1, 2, 0  // Single triangle
        ]);
    
        // Create the index buffer with GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
        const indexBuffer = this.device.createBuffer({
            size: indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
    
        // Write data to the index buffer (ensure alignment to 4 bytes)
        this.device.queue.writeBuffer(indexBuffer, 0, indices.buffer, indices.byteOffset, indices.byteLength);
    
        // Render the triangle
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(3, 1, 0, 0); // Drawing a single triangle with 3 vertices
    }

    private drawInvertedTriangle(passEncoder: GPURenderPassEncoder, triangle: InvertedTriangle) {
        // Normalize the position and size to [-1,1] based on canvas dimensions
        let normalizedX = (triangle.x / this.canvas.width) * 2 - 1;
        let normalizedY = (triangle.y / this.canvas.height) * 2 - 1;
        let normalizedWidth = (triangle.width / this.canvas.width) * 2;
        let normalizedHeight = (triangle.height / this.canvas.height) * 2;
    
        const vertexUniformData = new Float32Array([
            normalizedX, normalizedY,               // Position
            normalizedWidth, normalizedHeight,      // Size
        ]);
        const vertexUniformBuffer = this.createUniformBuffer(vertexUniformData);
    
        const fragmentUniformData = new Float32Array([
            triangle.fillColor.r, triangle.fillColor.g, triangle.fillColor.b, triangle.fillColor.a, // Color
        ]);
        const fragmentUniformBuffer = this.createUniformBuffer(fragmentUniformData);
    
        const bindGroup = this.createBindGroup(vertexUniformBuffer, fragmentUniformBuffer);
    
        // Define inverted triangle vertices
        const vertices = new Float32Array([
            0.5, 0.0,  // Bottom-middle
            1.0, 1.0,  // Top-right
            0.0, 1.0,  // Top-left
        ]);
    
        // Create the vertex buffer with GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
    
        // Write data to the vertex buffer (ensure alignment to 4 bytes)
        this.device.queue.writeBuffer(vertexBuffer, 0, vertices.buffer, vertices.byteOffset, vertices.byteLength);
    
        // Define triangle indices
        const indices = new Uint16Array([
            0, 1, 2, 0  // Single triangle
        ]);
    
        // Create the index buffer with GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
        const indexBuffer = this.device.createBuffer({
            size: indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
    
        // Write data to the index buffer (ensure alignment to 4 bytes)
        this.device.queue.writeBuffer(indexBuffer, 0, indices.buffer, indices.byteOffset, indices.byteLength);
    
        // Render the triangle
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(3, 1, 0, 0); // Drawing a single inverted triangle with 3 vertices
    }
    
}