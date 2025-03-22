// src/rendering/webgpu-render-strategy.ts
import { RenderStrategy } from './render-strategy';
import { Node } from '../../scene-graph/shapes/base/node';
import { Rectangle } from '../../scene-graph/shapes/rectangle';
import { Circle } from '../../scene-graph/shapes/circle';
import { Diamond } from '../../scene-graph/shapes/diamond';
import { Triangle } from '../../scene-graph/shapes/triangle';
import { InvertedTriangle } from '../../scene-graph/shapes/inverted-triangle';
import { InteractionService } from '../../services/interaction-service';
import { Shape } from '../../scene-graph/shapes/base/shape';
import { RenderCache } from '../caches/render-cache';
import { Line } from '../../scene-graph/shapes/line';
import { Scribble } from '../../scene-graph/shapes/scribble';
import { Highlight } from '../../scene-graph/shapes/highlight';
import { Text } from '../../scene-graph/shapes/text';
import { Pattern } from '../../scene-graph/shapes/pattern';
import { StrokeRenderCache } from '../caches/stroke-render-cache';
// import { vec4 } from 'gl-matrix';

export class WebGPURenderStrategy implements RenderStrategy {
    
    private device: GPUDevice;
    private shapePipeline: GPURenderPipeline;
    private linePipeline: GPURenderPipeline;
    private patternPipeline: GPURenderPipeline;
    private highlightPipeline: GPURenderPipeline;
    private textPipeline: GPURenderPipeline;
    private boundingBoxPipeline: GPURenderPipeline;
    private interactionService: InteractionService;
    private renderCache: RenderCache;
    private strokeRenderCache: StrokeRenderCache;
    private textSampler!: GPUSampler;
    private patternSampler!: GPUSampler;

    constructor(device: GPUDevice, 
                shapePipeline: GPURenderPipeline, 
                boundingBoxPipeline: GPURenderPipeline,
                linePipeline: GPURenderPipeline,
                textPipeline: GPURenderPipeline,
                highlightPipeline: GPURenderPipeline,
                patternPipeline: GPURenderPipeline,
                interactionService: InteractionService
                ) {
        this.device = device;
        this.shapePipeline = shapePipeline;
        this.linePipeline = linePipeline;
        this.textPipeline = textPipeline;
        this.highlightPipeline = highlightPipeline;
        this.boundingBoxPipeline = boundingBoxPipeline;
        this.patternPipeline = patternPipeline;
        this.interactionService = interactionService;

        // 1.6MB = 10,000 shapes before reallocation
        this.renderCache = new RenderCache(1600000, device, interactionService);

        // 1.6MB = 10,000 shapes before reallocation
        this.strokeRenderCache = new StrokeRenderCache(device);

        // Create a sampler for text
        this.textSampler = this.device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
        });

        // Create a sampler for pattern textures
        this.patternSampler = this.device.createSampler({
            magFilter: "linear", // How to upscale
            minFilter: "linear", // How to downscale
            addressModeU: "repeat", // Repeat pattern horizontally
            addressModeV: "repeat"  // Repeat pattern vertically
        });
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

        /* 
        In the future, we can handle this in the GPU so it's parallelized:
        --------------------------------------------------------------------
        const isPreview = shape.isPreview ? 1.0 : 0.0;
        const uniformBuffer = new Float32Array([
            shape.fillColor.r,
            shape.fillColor.g,
            shape.fillColor.b,
            shape.fillColor.a,
            isPreview
        ]);
        device.queue.writeBuffer(shape.uniformBuffer, 0, uniformBuffer);
        ----------------------------------------------------------------------
        We would have to modify the Fragment Shader like this:
        struct Uniforms {
            resolution: vec4<f32>,
            worldMatrix: mat4x4<f32>,
            localMatrix: mat4x4<f32>,
            shapeColor: vec4<f32>,
            isPreview: f32, // New flag for preview mode (0 = false, 1 = true)
        };

        @group(0) @binding(0) var<uniform> uniforms: Uniforms;

        @fragment
        fn main_fragment() -> @location(0) vec4<f32> {
            let alpha = mix(uniforms.shapeColor.a, 0.25, uniforms.isPreview);
            return vec4<f32>(uniforms.shapeColor.rgb, alpha);
        }
        -------------------------------------------------------------------------
        But for now, this is easier:
        */
        if (node.isPreview) {
            node.fillColor.a = 0.10; // Make preview semi-transparent
        } else {
            node.fillColor.a = 1.0; // Ensure finalized shape is solid
        }

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
        } else if (node instanceof Line) {
            this.drawLine(passEncoder, node);
        } else if (node instanceof Scribble) {
            this.drawScribble(passEncoder, node);
        } else if (node instanceof Text) {
            this.drawText(passEncoder, node);
        } else if (node instanceof Highlight) {
            this.drawHighlight(passEncoder, node);
        } else if (node instanceof Pattern) {
            this.drawPattern(passEncoder, node);
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
        const thickness = 0.015;
    
        if (shape instanceof Line) {
            // this.drawLineBoundingBox(passEncoder, shape, thickness);
            return;
        }

        if (shape instanceof Pattern) {
            this.drawPatternBoundingBox(passEncoder, shape, thickness);
            return;
        }

        if (shape instanceof Text) {
            this.drawTextBoundingBox(passEncoder, shape)
            return;
        }
    
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
    
    private drawTextBoundingBox(passEncoder: GPURenderPassEncoder, text: Text): void {

        const scale = 1 / 64; // Same scale as text rendering
        const { width, height } = text.boundingBox;
    
        const scaledWidth = width * scale;
        const scaledHeight = height * scale;
    
        const thickness = 0.01; // Outline thickness
    
        // Properly aligned bounding box (using bottom-left as origin)
        const vertices = new Float32Array([
            // Outer vertices
            0 - thickness, 0 - thickness,                            // Bottom-left
            scaledWidth + thickness, 0 - thickness,                 // Bottom-right
            0 - thickness, scaledHeight + thickness,                // Top-left
            scaledWidth + thickness, scaledHeight + thickness,      // Top-right
    
            // Inner vertices
            0, 0,                                                   // Bottom-left
            scaledWidth, 0,                                         // Bottom-right
            0, scaledHeight,                                        // Top-left
            scaledWidth, scaledHeight                               // Top-right
        ]);
    
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
    
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // Index buffer for outline quads
        const indices = new Uint16Array([
            // Bottom
            0, 1, 4,
            4, 1, 5,
    
            // Top
            2, 3, 6,
            6, 3, 7,
    
            // Left
            0, 2, 4,
            4, 2, 6,
    
            // Right
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
    
        // Bind transformation matrices
        const bindGroup = this.device.createBindGroup({
            layout: this.boundingBoxPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.createMatrixBuffer(Array.from(text.localMatrix)) } },
                { binding: 1, resource: { buffer: this.createMatrixBuffer(Array.from(this.interactionService.getWorldMatrix())) } }
            ],
        });
    
        passEncoder.setPipeline(this.boundingBoxPipeline);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.setBindGroup(0, bindGroup);
    
        // Draw the bounding box using indexed triangles
        passEncoder.drawIndexed(indices.length, 1, 0, 0, 0);
    }

    private drawLineBoundingBox(passEncoder: GPURenderPassEncoder, line: Line, thickness: number): void {
        const halfThickness = thickness / 2;
    
        // Extract line start and end points
        const startX = line.x1;
        const startY = line.y1;
        const endX = line.x2;
        const endY = line.y2;
    
        // Compute perpendicular vector for thickness
        const dirX = endX - startX;
        const dirY = endY - startY;
        const length = Math.sqrt(dirX * dirX + dirY * dirY);
        const normalX = -(dirY / length) * halfThickness;
        const normalY = (dirX / length) * halfThickness;
    
        // Define the 8 vertices (outer & inner box for outline effect)
        const vertices = new Float32Array([
            // Outer box
            startX - normalX - halfThickness, startY - normalY - halfThickness, // 0 Bottom-left
            endX - normalX + halfThickness, endY - normalY - halfThickness,     // 1 Bottom-right
            startX + normalX - halfThickness, startY + normalY + halfThickness, // 2 Top-left
            endX + normalX + halfThickness, endY + normalY + halfThickness,     // 3 Top-right
    
            // Inner box (closer to the actual line)
            startX - normalX, startY - normalY, // 4 Bottom-left (inner)
            endX - normalX, endY - normalY,     // 5 Bottom-right (inner)
            startX + normalX, startY + normalY, // 6 Top-left (inner)
            endX + normalX, endY + normalY      // 7 Top-right (inner)
        ]);
    
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
    
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // Define the indices to create an outline using triangles
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
    
        // Bind transformation matrices
        const bindGroup = this.device.createBindGroup({
            layout: this.boundingBoxPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.createMatrixBuffer(Array.from(line.localMatrix)) } },
                { binding: 1, resource: { buffer: this.createMatrixBuffer(Array.from(this.interactionService.getWorldMatrix())) } }
            ],
        });
    
        passEncoder.setPipeline(this.boundingBoxPipeline);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.drawIndexed(indices.length, 1, 0, 0, 0);
    }
    
    private drawPatternBoundingBox(passEncoder: GPURenderPassEncoder, pattern: Pattern, thickness: number): void {
        const boundingBox = pattern.boundingBox; // ✅ Use precomputed bounding box
    
        if (!boundingBox.vertices || boundingBox.vertices.length < 8) {
            console.error("Bounding box vertices are not set correctly.");
            return;
        }
    
        // Flatten the `[x, y]` pairs into a Float32Array
        const vertices = new Float32Array(boundingBox.vertices.flat());
        
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
    
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // Index buffer for outline quads
        const indices = new Uint16Array([
            // Bottom
            0, 1, 4,
            4, 1, 5,
    
            // Top
            2, 3, 6,
            6, 3, 7,
    
            // Left
            0, 2, 4,
            4, 2, 6,
    
            // Right
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
    
        // ✅ Bind transformation matrices
        const bindGroup = this.device.createBindGroup({
            layout: this.boundingBoxPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.createMatrixBuffer(Array.from(pattern.localMatrix)) } },
                { binding: 1, resource: { buffer: this.createMatrixBuffer(Array.from(this.interactionService.getWorldMatrix())) } }
            ],
        });
    
        passEncoder.setPipeline(this.boundingBoxPipeline);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.setBindGroup(0, bindGroup);
    
        // ✅ Draw the bounding box as two triangles forming a rectangle
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

    /*
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
    */

    private drawRectangle(passEncoder: GPURenderPassEncoder, rect: Rectangle) {

        // Allocate space in the dynamic uniform buffer and get the offset for both vertex and fragment shaders
        // const offset = this.renderCache.allocateShape(rect, 160);
        const offset = this.renderCache.allocateShape(rect);

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

        const offset = this.renderCache.allocateShape(circle);
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
        
        const offset = this.renderCache.allocateShape(diamond);
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

        const offset = this.renderCache.allocateShape(triangle);
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
            0.0, 0.5 * triangle.height,   // Top-middle
            0.5 * triangle.width, -0.5 * triangle.height,  // Bottom-right
            -0.5 * triangle.width, -0.5 * triangle.height, // Bottom-left
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
        
        const offset = this.renderCache.allocateShape(triangle);
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
            0.0, -0.5 * triangle.height,  // Bottom-middle
            0.5 * triangle.width, 0.5 * triangle.height,   // Top-right
            -0.5 * triangle.width, 0.5 * triangle.height,  // Top-left
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

    private drawLine(passEncoder: GPURenderPassEncoder, line: Line) {

        // Allocate space in dynamic uniform buffer
        const offset = this.renderCache.allocateShape(line);
        const bindGroup = this.device.createBindGroup({
            layout: this.linePipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0, 
                    resource: { 
                        buffer: this.renderCache.dynamicUniformBuffer,
                        offset: offset,
                        size: 192
                    }
                }
            ],
        });
    
        // ✅ Define line segment vertices (two points: start & end)
        // const vertices = new Float32Array([
        //     line.x1, line.y1, // Point 1
        //     line.x2, line.y2      // Point 2
        // ]);
    
        const halfThickness = line.strokeWidth * 0.005; // Scale thickness properly

        // Start and End points (adjust X and Y for direction)
        const startX = line.x1;
        const startY = line.y1;
        const endX = line.x2;
        const endY = line.y2;

        // Compute perpendicular vector for thickness
        const dirX = endX - startX;
        const dirY = endY - startY;
        const length = Math.sqrt(dirX * dirX + dirY * dirY);
        const normalX = -(dirY / length) * halfThickness;
        const normalY = (dirX / length) * halfThickness;

        // Now construct a thin quad (two triangles forming the line)
        const vertices = new Float32Array([
            startX - normalX, startY - normalY,  // Bottom-left
            endX - normalX, endY - normalY,      // Bottom-right
            startX + normalX, startY + normalY,  // Top-left
            startX + normalX, startY + normalY,  // Top-left (Duplicate)
            endX - normalX, endY - normalY,      // Bottom-right (Duplicate)
            endX + normalX, endY + normalY       // Top-right
        ]);

        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,  // Ensure enough space (6 vertices * 8 bytes)
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, // Allow writing data
            mappedAtCreation: true
        });

        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // Bind pipeline and resources
        passEncoder.setPipeline(this.linePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
    
        // Use correct draw command (2 vertices for 1 line)
        passEncoder.draw(6, 1, 0, 0);
    }

    private drawPattern(passEncoder: GPURenderPassEncoder, pattern: Pattern) {

        if (!pattern.texture) {
            console.warn(`Pattern texture not loaded for: ${pattern.texture}`);
            return; // Exit early to avoid errors
        }

        // Allocate space in dynamic uniform buffer
        const offset = this.renderCache.allocateShape(pattern);
        const bindGroup = this.device.createBindGroup({
            layout: this.patternPipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0, 
                    resource: { 
                        buffer: this.renderCache.dynamicUniformBuffer,
                        offset: offset,
                        size: 192
                    }
                },
                {
                    binding: 1, // Bind the pattern texture
                    resource: pattern.texture.createView(),
                },
                {
                    binding: 2, // Bind the sampler
                    resource: this.patternSampler,
                }
            ],
        });
    
        // Compute proper UV scaling based on pattern size
        const patternWidth = pattern.texture.width;  // Get actual texture size
        const patternHeight = pattern.texture.height;

        // Compute length of the dragged shape
        const shapeLength = Math.sqrt((pattern.x2 - pattern.x1) ** 2 + (pattern.y2 - pattern.y1) ** 2);
        const shapeThickness = pattern.strokeWidth;  // Keep thickness consistent

        // Set uScale based on shape length so it tiles only in the dragged direction
        const uScale = 1600 * shapeLength / patternWidth;

        // Keep vScale fixed so that it doesn’t stretch in the perpendicular direction
        const vScale = 2;  // Ensures no tiling along the thickness axis

        // Compute perpendicular thickness
        const halfThickness = shapeThickness * 0.005;

        const startX = pattern.x1;
        const startY = pattern.y1;
        const endX = pattern.x2;
        const endY = pattern.y2;

        // Compute direction vector
        const dirX = (endX - startX) / shapeLength;
        const dirY = (endY - startY) / shapeLength;

        // Compute perpendicular vector for thickness
        const normalX = -dirY * halfThickness;
        const normalY = dirX * halfThickness;

        // UVs should align exactly along the dragged direction, with v fixed
        const vertices = new Float32Array([
            startX - normalX, startY - normalY, 0, 0,  // Bottom-left (UV 0,0)
            endX - normalX, endY - normalY, uScale, 0,  // Bottom-right (UV uScale,0)
            startX + normalX, startY + normalY, 0, vScale,  // Top-left (UV 0,1)
            startX + normalX, startY + normalY, 0, vScale,  // Top-left (Duplicate)
            endX - normalX, endY - normalY, uScale, 0,  // Bottom-right (Duplicate)
            endX + normalX, endY + normalY, uScale, vScale  // Top-right (UV uScale,1)
        ]);

        // const vertices = new Float32Array([
        //     startX - normalX, startY - normalY, 0, 0,  // Bottom-left
        //     endX - normalX, endY - normalY, uScale, 0,  // Bottom-right
        //     startX + normalX, startY + normalY, 0, vScale,  // Top-left
        //     startX + normalX, startY + normalY, 0, vScale,  // Top-left (Duplicate)
        //     endX - normalX, endY - normalY, uScale, 0,  // Bottom-right (Duplicate)
        //     endX + normalX, endY + normalY, uScale, vScale  // Top-right
        // ]);

        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength, 
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true
        });

        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // Bind pipeline and resources
        passEncoder.setPipeline(this.patternPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
    
        // Use correct draw command (2 vertices for 1 line)
        passEncoder.draw(6, 1, 0, 0);
    }

    private drawScribble(passEncoder: GPURenderPassEncoder, scribble: Scribble) {
        if (scribble.points.length < 2) return; // At least two points needed
    
        // Allocate uniform buffer space for the scribble shape
        const offset = this.renderCache.allocateShape(scribble);
        const bindGroup = this.device.createBindGroup({
            layout: this.linePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.renderCache.dynamicUniformBuffer, offset, size: 192 } }
            ],
        });
    
        // Convert points into a **proper quad strip**
        const halfThickness = scribble.strokeWidth * 0.005; // Adjust stroke scaling
        const vertices: number[] = [];
        const indices: number[] = [];
    
        for (let i = 0; i < scribble.points.length; i++) {
            const prev = scribble.points[Math.max(0, i - 1)];
            const curr = scribble.points[i];
    
            // Compute normal for thickness
            const dx = curr.x - prev.x;
            const dy = curr.y - prev.y;
            const length = Math.sqrt(dx * dx + dy * dy) || 1; // Avoid division by zero
            const normalX = -(dy / length) * halfThickness;
            const normalY = (dx / length) * halfThickness;
    
            // Push vertices for **both sides of the stroke**
            const index = i * 2; // 2 vertices per segment
            vertices.push(
                curr.x - normalX, curr.y - normalY, // Bottom-left
                curr.x + normalX, curr.y + normalY  // Top-left
            );
    
            // Create **triangle strip indices** for the stroke
            if (i > 0) { // Avoid invalid indices at the first point
                indices.push(index - 2, index - 1, index, index - 1, index, index + 1);
            }
        }
    
        // 🟢 **Create and Upload Vertex Buffer**
        const vertexBuffer = this.device.createBuffer({
            size: vertices.length * 4, // 4 bytes per float
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // **Create and Upload Index Buffer**
        const indexBuffer = this.device.createBuffer({
            size: indices.length * 2, // 2 bytes per index (Uint16)
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Uint16Array(indexBuffer.getMappedRange()).set(indices);
        indexBuffer.unmap();
    
        // **Bind Buffers and Draw**
        passEncoder.setPipeline(this.linePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(indices.length, 1, 0, 0);
    }

    private drawHighlight(passEncoder: GPURenderPassEncoder, highlight: Highlight) {
        if (highlight.points.length < 2) return; // At least two points needed

        // Allocate uniform buffer space for the scribble shape
        const offset = this.renderCache.allocateShape(highlight);
        const bindGroup = this.device.createBindGroup({
            layout: this.highlightPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.renderCache.dynamicUniformBuffer, offset, size: 192 } }
            ],
        });
        
        // **Before drawing, configure stencil reference**
        passEncoder.setStencilReference(highlight.zIndex);  // ✅ Set reference value for stencil test 

        // Convert points into a **proper quad strip**
        const halfThickness = highlight.strokeWidth * 0.035; // Adjust stroke scaling
        const vertices: number[] = [];
        const indices: number[] = [];
    
        for (let i = 0; i < highlight.points.length; i++) {
            const prev = highlight.points[Math.max(0, i - 1)];
            const curr = highlight.points[i];
    
            // Compute normal for thickness
            const dx = curr.x - prev.x;
            const dy = curr.y - prev.y;
            const length = Math.sqrt(dx * dx + dy * dy) || 1; // Avoid division by zero
            const normalX = -(dy / length) * halfThickness;
            const normalY = (dx / length) * halfThickness;
    
            // Push vertices for **both sides of the stroke**
            const index = i * 2; // 2 vertices per segment
            vertices.push(
                curr.x - normalX, curr.y - normalY, // Bottom-left
                curr.x + normalX, curr.y + normalY  // Top-left
            );
    
            // Create **triangle strip indices** for the stroke
            if (i > 0) { // Avoid invalid indices at the first point
                indices.push(index - 2, index - 1, index, index - 1, index, index + 1);
            }
        }
    
        // **Create and Upload Vertex Buffer**
        const vertexBuffer = this.device.createBuffer({
            size: vertices.length * 4, // 4 bytes per float
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // **Create and Upload Index Buffer**
        const indexBuffer = this.device.createBuffer({
            size: indices.length * 2, // 2 bytes per index (Uint16)
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        new Uint16Array(indexBuffer.getMappedRange()).set(indices);
        indexBuffer.unmap();
    
        // **Bind Buffers and Draw**
        passEncoder.setPipeline(this.highlightPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(indices.length, 1, 0, 0);
    }

    private drawText(passEncoder: GPURenderPassEncoder, text: Text) {

        if (!text.textureView || text.width === 0 || text.height === 0) return;
        this.drawCaret(passEncoder, text);

        const offset = this.renderCache.allocateShape(text);
    
        const localMatrixBuffer = this.device.createBuffer({
            size: 64, // mat4<f32> is 4x4 floats, 16 bytes each
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(localMatrixBuffer, 0, text.localMatrix as Float32Array);
    
        const worldMatrixBuffer = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(worldMatrixBuffer, 0, this.interactionService.getWorldMatrix() as Float32Array);
    
        const bindGroup = this.device.createBindGroup({
            layout: this.textPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: localMatrixBuffer } },
                { binding: 1, resource: { buffer: worldMatrixBuffer } },
                { binding: 2, resource: text.textureView },
                { binding: 3, resource: this.textSampler },
            ],
        });
    
        const scale = 1 / 64;  // Adjust the scale factor to fit properly
        const vertices = new Float32Array([
            0, 0, 0, 0,                      // Bottom-left (UV 0,0)
            text.width*scale, 0, 1, 0,              // Bottom-right (UV 1,0)
            0, text.height*scale, 0, 1,             // Top-left (UV 0,1)
            text.width*scale, text.height*scale, 1, 1      // Top-right (UV 1,1)
        ]);

        // const vertices = new Float32Array([
        //     0, 0, 0, 1,                      // Bottom-left
        //     text.width, 0, 1, 1,              // Bottom-right
        //     0, text.height, 0, 0,             // Top-left
        //     text.width, text.height, 1, 0     // Top-right
        // ]);
    
        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
    
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        passEncoder.setPipeline(this.textPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(4, 1, 0, 0);
    }
    
    private drawCaret(passEncoder: GPURenderPassEncoder, text: Text) {
        if (!text.caretVisible) return; // Only show caret if selected
        
        const offset = this.renderCache.allocateShape(text);
        const bindGroup = this.device.createBindGroup({
            layout: this.linePipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0, 
                    resource: { 
                        buffer: this.renderCache.dynamicUniformBuffer,
                        offset: offset,
                        size: 192
                    }
                }
            ],
        });
    
        const scale = 1 / 64;
        const caretX = text.getCaretPosition();
        const caretHeight = Math.max(text.boundingBox.height * scale, 0.05);
        const thickness = Math.max(0.005, 0.01);
    
        // Align caret with text baseline
        // const baselineOffset = text.boundingBox.height * scale * 0.8;
    
        const vertices = new Float32Array([
            caretX, 0,                // Bottom-left
            caretX, caretHeight,   // Top-left
            caretX + thickness, 0,    // Bottom-right
            caretX + thickness, caretHeight // Top-right
        ]);

        const vertexBuffer = this.device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
    
        new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
        vertexBuffer.unmap();
    
        // Use correct indices for a rectangle
        const indices = new Uint16Array([
            0, 1, 2, // First triangle (bottom-left, top-left, bottom-right)
            1, 2, 3  // Second triangle (top-left, bottom-right, top-right)
        ]);
    
        const indexBuffer = this.device.createBuffer({
            size: indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
    
        new Uint16Array(indexBuffer.getMappedRange()).set(indices);
        indexBuffer.unmap();
    
        // Use index buffer and indexed drawing
        passEncoder.setPipeline(this.linePipeline); 
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(6, 1, 0, 0);
    }

}