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
import { RenderCache } from '../render-cache';
import { mat4, vec4 } from 'gl-matrix';

export class WebGPURenderStrategy implements RenderStrategy {
    
    private device: GPUDevice;
    private shapePipeline: GPURenderPipeline;
    private boundingBoxPipeline: GPURenderPipeline;
    private canvas: HTMLCanvasElement;
    private interactionService: InteractionService;
    private renderCache: RenderCache;

    constructor(device: GPUDevice, 
                shapePipeline: GPURenderPipeline, 
                boundingBoxPipeline: GPURenderPipeline,
                canvas: HTMLCanvasElement, 
                interactionService: InteractionService) {
        this.device = device;
        this.shapePipeline = shapePipeline;
        this.boundingBoxPipeline = boundingBoxPipeline;
        this.canvas = canvas;
        this.interactionService = interactionService;
        // 1.6MB = 10,000 shapes before reallocation
        this.renderCache = new RenderCache(1600000, device, interactionService);
    }

    render(node: Node, ctxOrEncoder: CanvasRenderingContext2D | GPURenderPassEncoder): void {
        
        // Only handle GPURenderPassEncoder in this strategy
        if (!(ctxOrEncoder instanceof GPURenderPassEncoder)) {
            return; 
        }

        // Ensure we're dealing with a specific shape
        if (!(node instanceof Shape)) {
            console.error('Node is not a Shape:', node);
            return;
        }

        // If a shape is not in view, skip the uniform buffer setup for GPU rendering
        /*
        if (!this.isShapeInView(node)) {
            node.visible = false;
            console.log(node);
            return;
        }        
        */


        // If the node is visible, proceed with rendering
        node.visible = true;

        // This is the pass encoder (scoped to the shape pipeline) we passed in from WebGPURenderer.
        const passEncoder = ctxOrEncoder;

        // Ensure we're dealing with a specific shape so we may render it using the WebGPU Shading 
        // Language set within the shape pipeline's vertexShaderModule and fragmentShaderModule
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

        // If the shape is selected, render the bounding box
        if (node.isSelected()) {
            this.drawBoundingBox(passEncoder, node);
        }
    }
    
    private drawBoundingBox(passEncoder: GPURenderPassEncoder, shape: Shape): void {
 
        // Adjust this for bounding box thickness
        // Values greater than 0.01 seem to render correctly more consistently
        const thickness = 0.025; 

        const halfWidth = shape.width / 2;
        const halfHeight = shape.height / 2;

        // Define the vertices of the bounding box
        const vertices = new Float32Array([
            // Outer vertices
            -halfWidth - thickness, -halfHeight - thickness, // 0 Bottom-left
            halfWidth + thickness, -halfHeight - thickness,  // 1 Bottom-right
            -halfWidth - thickness, halfHeight + thickness,  // 2 Top-left
            halfWidth + thickness, halfHeight + thickness,   // 3 Top-right

            // Inner vertices
            -halfWidth, -halfHeight,  // 4 Bottom-left
            halfWidth, -halfHeight,   // 5 Bottom-right
            -halfWidth, halfHeight,   // 6 Top-left
            halfWidth, halfHeight     // 7 Top-right
        ]);

        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();

        // Define the indices for the bounding box triangles
        const indices = new Uint16Array([
            // Bottom side
            0, 1, 4,
            4, 1, 5,

            // Top side
            2, 3, 6,
            6, 3, 7,

            // Left side
            0, 2, 4,
            4, 2, 6,

            // Right side
            1, 3, 5,
            5, 3, 7
        ]);

        const indexBuffer = this.device.createBuffer({
            size: indices.byteLength,
            usage: GPUBufferUsage.INDEX,
            mappedAtCreation: true,
        });
        new Uint16Array(indexBuffer.getMappedRange()).set(indices);
        indexBuffer.unmap();

        // Create the bind group with arrays for matrices
        const bindGroup = this.device.createBindGroup({
            layout: this.boundingBoxPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.createMatrixBuffer(Array.from(shape.localMatrix)) } },
                { binding: 1, resource: { buffer: this.createMatrixBuffer(Array.from(this.interactionService.getWorldMatrix())) } }
            ],
        });

        passEncoder.setPipeline(this.boundingBoxPipeline);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.setBindGroup(0, bindGroup);

        // Draw the bounding box using the index buffer
        passEncoder.drawIndexed(indices.length, 1, 0, 0, 0);
    }

    private createMatrixBuffer(matrix: number[]): GPUBuffer {
        const buffer = this.device.createBuffer({
            size: matrix.length * 4, // 4 bytes per float
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(buffer.getMappedRange()).set(matrix);
        buffer.unmap();
        return buffer;
    }   

    private isShapeInView(shape: Shape): boolean {

        const ndcBounds = this.calculateNDCBounds(shape);

        return (
            ndcBounds.minX <= 1 && ndcBounds.maxX >= -1 &&
            ndcBounds.minY <= 1 && ndcBounds.maxY >= -1
        );
    }

    private calculateNDCBounds(shape: Shape): { minX: number; maxX: number; minY: number; maxY: number } {
        const boundingBox = shape.getBoundingBox(); // { x, y, width, height }
        const worldMatrix = this.interactionService.getWorldMatrix();
        // Calculate the corners of the bounding box
        const corners = [
            vec4.fromValues(boundingBox.x, boundingBox.y, 0, 1), // Top-left
            vec4.fromValues(boundingBox.x + boundingBox.width, boundingBox.y, 0, 1), // Top-right
            vec4.fromValues(boundingBox.x, boundingBox.y + boundingBox.height, 0, 1), // Bottom-left
            vec4.fromValues(boundingBox.x + boundingBox.width, boundingBox.y + boundingBox.height, 0, 1) // Bottom-right
        ];
    
        // Transform the corners to NDC space
        const transformedCorners = corners.map(corner => {
            const transformed = vec4.create();
            vec4.transformMat4(transformed, corner, worldMatrix);
            return transformed;
        });
    
        // Calculate the min and max bounds in NDC space
        const ndcBounds = {
            minX: Math.min(...transformedCorners.map(c => c[0] / c[3])),
            maxX: Math.max(...transformedCorners.map(c => c[0] / c[3])),
            minY: Math.min(...transformedCorners.map(c => c[1] / c[3])),
            maxY: Math.max(...transformedCorners.map(c => c[1] / c[3])),
        };
    
        return ndcBounds;
    }

    private drawRectangle(passEncoder: GPURenderPassEncoder, rect: Rectangle) {

        // Allocate space in the dynamic uniform buffer and get the offset for both vertex and fragment shaders
        const offset = this.renderCache.allocateShape(rect, 160);

        /* Create a bind group using the dynamic uniform buffer with the calculated offset
           The size parameter in the resource object for each bind group entry should match the size of 
           the data that each binding in your shader expects. Here is a nice breakdown:
            
                resolution: vec4<f32> (Binding 0):
                A vec4<f32> is 4 floats, each 4 bytes.
                Total size: 4 * 4 = 16 bytes.

                worldMatrix: mat4x4<f32> (Binding 1):
                A mat4x4<f32> is a 4x4 matrix of floats.
                Total size: 4 * 4 * 4 = 64 bytes.

                localMatrix: mat4x4<f32> (Binding 2):
                Same as worldMatrix, it's a 4x4 matrix of floats.
                Total size: 4 * 4 * 4 = 64 bytes.

                shapeColor: vec4<f32> (Binding 3):
                A vec4<f32> is 4 floats.
                Total size: 4 * 4 = 16 bytes.

           For each shape, the total uniform data size (when adding up all bindings) is:
           ***160 bytes***
        ------------------------------------------------------------------------------------*/
        const bindGroup = this.device.createBindGroup({
            layout: this.shapePipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0, 
                    resource: { 
                        buffer: this.renderCache.dynamicUniformBuffer,
                        offset: offset,
                        size: 160
                    }
                }
            ],
        });

        // Set up the vertex buffer (for the rectangle geometry)
        const vertices = new Float32Array([
            -0.5 * rect.width, -0.5 * rect.height,  // Bottom-left
            0.5 * rect.width, -0.5 * rect.height,   // Bottom-right
            -0.5 * rect.width, 0.5 * rect.height,   // Top-left
            0.5 * rect.width, 0.5 * rect.height,    // Top-right
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
        passEncoder.setPipeline(this.shapePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(6, 1, 0, 0);
        /* About drawIndexed vs draw:
        With passEncoder.draw(...), the vertices are used in the order they appear in the 
        vertex buffer. If the vertex buffer doesn’t naturally describe the two triangles 
        forming a rectangle, the GPU might render something unexpected, like a single triangle.

        Instead, passEncoder.drawIndexed(...) allows you to explicitly define how to connect 
        vertices using the index buffer, which makes it easier to create shapes like rectangles 
        from triangles, even if the vertex data isn’t naturally ordered.

        The index buffer provides the flexibility to reuse vertices efficiently, meaning you can 
        define a rectangle with just four vertices instead of six, and use the index buffer 
        to connect them in the correct order.
        -----------------------------------------------------------------------------------------*/
    }
    
    private drawCircle(passEncoder: GPURenderPassEncoder, circle: Circle) {

        const offset = this.renderCache.allocateShape(circle, 160);
        const bindGroup = this.device.createBindGroup({
            layout: this.shapePipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0, 
                    resource: { 
                        buffer: this.renderCache.dynamicUniformBuffer,
                        offset: offset,
                        size: 160
                    }
                }
            ],
        });
    
        // Circle drawing logic using triangle-list
        // Increase number of segments = smoother circle
        const numSegments = 60; 
        const angleStep = (Math.PI * 2) / numSegments;
    
        const vertices: number[] = [];

        // Scale factor for reducing the circle by half
        const scaleFactor = 0.5;
    
        // Create the circle vertices w/ triangle list approach
        for (let i = 0; i < numSegments; i++) {
            // Center circle vertex for current triangle
            vertices.push(0.0, 0.0);
    
            // First perimeter point of the triangle
            const angle1 = i * angleStep;
            vertices.push(Math.cos(angle1) * (circle.width* scaleFactor), Math.sin(angle1) * (circle.height * scaleFactor)); 
    
            // Second perimeter point of the triangle (next segment)
            const angle2 = (i + 1) * angleStep;
            vertices.push(Math.cos(angle2) * (circle.width* scaleFactor), Math.sin(angle2) * (circle.height * scaleFactor));
        }

        const vertexBuffer = this.device.createBuffer({
            size: vertices.length * 4, // 4 bytes per float
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true,
        });
    
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // Render the circle using triangle-list
        passEncoder.setPipeline(this.shapePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(vertices.length / 2, 1, 0, 0);
    }

    private drawDiamond(passEncoder: GPURenderPassEncoder, diamond: Diamond) {
        
        const offset = this.renderCache.allocateShape(diamond, 160);
        const bindGroup = this.device.createBindGroup({
            layout: this.shapePipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0, 
                    resource: { 
                        buffer: this.renderCache.dynamicUniformBuffer,
                        offset: offset,
                        size: 160
                    }
                }
            ],
        });

        // Set up the vertex buffer for the diamond shape
        const vertices = new Float32Array([
            0.0 * diamond.width, -0.5 * diamond.height,  // Bottom
            0.5 * diamond.width, 0.0 * diamond.height,   // Right
            0.0 * diamond.width, 0.5 * diamond.height,   // Top
            -0.5 * diamond.width, 0.0 * diamond.height,  // Left
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
        passEncoder.setPipeline(this.shapePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(6, 1, 0, 0);
    }

    private drawTriangle(passEncoder: GPURenderPassEncoder, triangle: Triangle) {

        const offset = this.renderCache.allocateShape(triangle, 160);
        const bindGroup = this.device.createBindGroup({
            layout: this.shapePipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0, 
                    resource: { 
                        buffer: this.renderCache.dynamicUniformBuffer,
                        offset: offset,
                        size: 160
                    }
                }
            ],
        });

        // Define triangle vertices
        const vertices = new Float32Array([
            0.0, 0.25,   // Top-middle
            0.25, -0.25,  // Bottom-right
            -0.25, -0.25, // Bottom-left
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
        passEncoder.setPipeline(this.shapePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(3, 1, 0, 0); // Drawing a single triangle with 3 vertices
    }

    private drawInvertedTriangle(passEncoder: GPURenderPassEncoder, triangle: InvertedTriangle) {
        
        const offset = this.renderCache.allocateShape(triangle, 160);
        const bindGroup = this.device.createBindGroup({
            layout: this.shapePipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0, 
                    resource: { 
                        buffer: this.renderCache.dynamicUniformBuffer,
                        offset: offset,
                        size: 160
                    }
                }
            ],
        });

        // Define inverted triangle vertices
        const vertices = new Float32Array([
            0.0, -0.25,  // Bottom-middle
            0.25, 0.25,   // Top-right
            -0.25, 0.25,  // Top-left
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
        passEncoder.setPipeline(this.shapePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(3, 1, 0, 0); // Drawing a single inverted triangle with 3 vertices
    }
}