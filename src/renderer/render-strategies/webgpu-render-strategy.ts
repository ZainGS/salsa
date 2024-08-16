// src/rendering/webgpu-render-strategy.ts
import { RenderStrategy } from './render-strategy';
import { Node } from '../../scene-graph/node';
import { Rectangle } from '../../scene-graph/shapes/rectangle';
import { Circle } from '../../scene-graph/shapes/circle';
import { Diamond } from '../../scene-graph/shapes/diamond';
import { Triangle } from '../../scene-graph/shapes/triangle';
import { InvertedTriangle } from '../../scene-graph/shapes/inverted-triangle';
import { InteractionService } from '../../services/interaction-service';
import { Shape } from '../../scene-graph/shapes/shape';

export class WebGPURenderStrategy implements RenderStrategy {
    
    private device: GPUDevice;
    private pipeline: GPURenderPipeline;
    private canvas: HTMLCanvasElement;
    private interactionService: InteractionService;

    constructor(device: GPUDevice, pipeline: GPURenderPipeline, canvas: HTMLCanvasElement, interactionService: InteractionService) {
        this.device = device;
        this.pipeline = pipeline;
        this.canvas = canvas;
        this.interactionService = interactionService;
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
        const bindGroup = this.createAndBindUniformBuffers(passEncoder, rect);

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

    private createBindGroup(vertexUniformBuffer: GPUBuffer, 
                            fragmentUniformBuffer: GPUBuffer, 
                            zoomFactorUniformBuffer: GPUBuffer,
                            panOffsetUniformBuffer: GPUBuffer,
                            resolutionUniformBuffer: GPUBuffer,
                            worldMatrixUniformBuffer: GPUBuffer): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: vertexUniformBuffer }}, // Vertex shader buffer
                { binding: 1, resource: { buffer: zoomFactorUniformBuffer }}, // Zoom Factor shader buffer
                { binding: 2, resource: { buffer: fragmentUniformBuffer }}, // Fragment shader buffer
                { binding: 3, resource: { buffer: panOffsetUniformBuffer }}, // Pan Offset shader buffer
                { binding: 4, resource: { buffer: resolutionUniformBuffer }}, // Resolution shader buffer
                { binding: 5, resource: { buffer: worldMatrixUniformBuffer }}, // World Matrix shader buffer
            ],
        });
    }

    private drawCircle(passEncoder: GPURenderPassEncoder, circle: Circle) {

        // Create and update uniform buffers for both vertex and fragment shaders
        const bindGroup = this.createAndBindUniformBuffers(passEncoder, circle);
    
        // Circle drawing logic using triangle-list
        const numSegments = 60; // Increase number of segments for smoother circle
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
        const bindGroup = this.createAndBindUniformBuffers(passEncoder, diamond);

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

        // Create and update uniform buffers for both vertex and fragment shaders
        const bindGroup = this.createAndBindUniformBuffers(passEncoder, triangle);

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
        
        // Create and update uniform buffers for both vertex and fragment shaders
        const bindGroup = this.createAndBindUniformBuffers(passEncoder, triangle);

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

    private createAndBindUniformBuffers(passEncoder: GPURenderPassEncoder, node: Shape): GPUBindGroup {
        // Create buffers for position, zoom factor, color, and pan offset
        const vertexUniformBuffer = this.createUniformBuffer(this.getVertexUniformData(node));
        const zoomFactorUniformBuffer = this.createUniformBuffer(new Float32Array([this.interactionService.getZoomFactor()]));
        const fragmentUniformBuffer = this.createUniformBuffer(this.getFragmentUniformData(node));
        const resolutionUniformBuffer = this.createUniformBuffer(new Float32Array([this.canvas.width, this.canvas.height, 0.0, 0.0]));
        const worldMatrixUniformBuffer = this.createUniformBuffer(this.interactionService.getWorldMatrix() as Float32Array);

        // Normalize the pan offset based on the canvas size
        const panOffset = this.interactionService.getPanOffset();
        const normalizedPanX = (panOffset.x / this.canvas.width) * 2;
        const normalizedPanY = (panOffset.y / this.canvas.height) * -2;
        const panOffsetBuffer = this.createUniformBuffer(new Float32Array([normalizedPanX, normalizedPanY]));

        // Create and return the bind group
        return this.createBindGroup(vertexUniformBuffer, fragmentUniformBuffer, zoomFactorUniformBuffer, panOffsetBuffer, resolutionUniformBuffer, worldMatrixUniformBuffer);
    }
    
    private getVertexUniformData(node: Node): Float32Array {
        const zoomFactor = this.interactionService.getZoomFactor();
        const aspectRatio = this.canvas.width / this.canvas.height;

        // Normalize position and size based on the node type
        if (node instanceof Rectangle || node instanceof Triangle || node instanceof InvertedTriangle || node instanceof Diamond) {
            return new Float32Array([
                ((node.x / this.canvas.width) * 2 - 1) * aspectRatio,  // Normalize x position
                (node.y / this.canvas.height) * 2 - 1, // Normalize y position
                ((node.width / this.canvas.width) * 2 * zoomFactor) * aspectRatio,   // Scale width by zoom factor
                (node.height / this.canvas.height) * 2 * zoomFactor  // Scale height by zoom factor
            ]);
        } else if (node instanceof Circle) {
            return new Float32Array([
                ((node.x / this.canvas.width) * 2 - 1) * aspectRatio,  // Normalize x position
                (node.y / this.canvas.height) * 2 - 1, // Normalize y position
                (node.radius / this.canvas.width) * 2 * zoomFactor * aspectRatio,  // Scale radius by zoom factor
                (node.radius / this.canvas.height) * 2 * zoomFactor  // Scale radius by zoom factor
            ]);
        }
        return new Float32Array(); // Default case, should not happen
    }
    
    private getFragmentUniformData(node: Shape): Float32Array {
        return new Float32Array([node.fillColor.r, node.fillColor.g, node.fillColor.b, node.fillColor.a]);
    }
    
}