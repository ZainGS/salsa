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
import { Line } from '../../scene-graph/shapes/line';
import { Scribble } from '../../scene-graph/shapes/scribble';
import { Highlight } from '../../scene-graph/shapes/highlight';
import { Text } from '../../scene-graph/shapes/text';
import { Pattern } from '../../scene-graph/shapes/pattern';
import { CacheService } from '../../services/cache-service';

export class WebGPURenderStrategy implements RenderStrategy {
    
    private device: GPUDevice;
    private shapePipeline: GPURenderPipeline;
    private linePipeline: GPURenderPipeline;
    private patternPipeline: GPURenderPipeline;
    private highlightPipeline: GPURenderPipeline;
    private textPipeline: GPURenderPipeline;
    private boundingBoxPipeline: GPURenderPipeline;
    private interactionService: InteractionService;
    private cacheService: CacheService;
    private textSampler!: GPUSampler;
    private patternSampler!: GPUSampler;

    constructor(device: GPUDevice, 
                shapePipeline: GPURenderPipeline, 
                boundingBoxPipeline: GPURenderPipeline,
                linePipeline: GPURenderPipeline,
                textPipeline: GPURenderPipeline,
                highlightPipeline: GPURenderPipeline,
                patternPipeline: GPURenderPipeline,
                interactionService: InteractionService,
                cacheService: CacheService
                ) {
        this.device = device;
        this.shapePipeline = shapePipeline;
        this.linePipeline = linePipeline;
        this.textPipeline = textPipeline;
        this.highlightPipeline = highlightPipeline;
        this.boundingBoxPipeline = boundingBoxPipeline;
        this.patternPipeline = patternPipeline;
        this.interactionService = interactionService;
        this.cacheService = cacheService;

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

    render(node: Node, ctxOrEncoder: GPURenderPassEncoder, sharedBindGroup?: GPUBindGroup): void {

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
            node.fillColor.a = 0.4; // Make preview semi-transparent
        } 
        else {
            node.fillColor.a = 1; // Ensure finalized shape is solid
        }

        // This is the pass encoder (scoped to the shape pipeline) we passed in from WebGPURenderer.
        const passEncoder = ctxOrEncoder;

        // Check if world matrix has changed
        const currentVersion = this.interactionService.worldMatrixVersion;
        if (currentVersion !== this.cacheService.lastUploadedWorldMatrixVersion) {
            this.device.queue.writeBuffer(
                this.cacheService.worldMatrixBuffer,
                0,
                new Float32Array(this.interactionService.getWorldMatrix())
            );
            this.cacheService.lastUploadedWorldMatrixVersion = currentVersion;
        }

        // Ensure we're dealing with a specific shape so we may render it using the WebGPU Shading 
        // Language set within the shape pipeline's vertexShaderModule and fragmentShaderModule
        if (
            node instanceof Rectangle ||
            node instanceof Circle ||
            node instanceof Triangle ||
            node instanceof InvertedTriangle ||
            node instanceof Diamond
        ) {
            this.drawShape(passEncoder, node, sharedBindGroup!);
        }
        else if (node instanceof Line) {
            this.drawLine(passEncoder, node, sharedBindGroup!);
        } else if (node instanceof Scribble) {
            this.drawScribble(passEncoder, node, sharedBindGroup!);
        } else if (node instanceof Text) {
            this.drawText(passEncoder, node, sharedBindGroup!);
        } else if (node instanceof Highlight) {
            this.drawHighlight(passEncoder, node, sharedBindGroup!);
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

    private drawShape(passEncoder: GPURenderPassEncoder, shape: Shape, sharedBindGroup: GPUBindGroup): void {
        // Allocate space in the dynamic uniform buffer and get the offset for both vertex and fragment shaders

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
        if (shape.isDirty) {
            this.cacheService.shapeGeometryCache.update(shape);
            shape.isDirty = false;
        }

        // STEP 1: Allocate and cache uniform buffer
        const uniformOffset = this.cacheService.shapeUniformCache.allocate(shape);

        // STEP 2: Allocate geometry into shared shape buffer if not cached
        this.cacheService.shapeGeometryCache.allocate(shape);

        // STEP 3: Retrieve geometry and offsets
        const shapeOffset = this.cacheService.shapeGeometryCache.getOffset(shape);
        if (!shapeOffset) {
            console.error(`Shape offset not found for shape: ${shape.id}`);
            return;
        }

        // STEP 4: Set bind group for this shape's uniforms
        // The sharedBindGroup is a pointer to the whole shape uniform buffer, 
        // The dynamic offset (uniformOffset) is the exact slot for the current shape's data.
        // This dynamic offset passed at draw time tells the GPU, "Start reading at this many bytes into the buffer".
        // WebGPU already knows how big each shape’s data is because your shader expects exactly 160 bytes for Uniforms,
        // so we no longer need to specify a "size" parameter when the BindGroup was created. This is as long as we have
        // marked hasDynamicOffset: true on the BindGroupLayout when the shape render pipeline is setup.
        // Basically, size is implied from the layout of the uniform struct; WebGPU knows how many bytes to consume from the offset.
        passEncoder.setBindGroup(
            0,
            sharedBindGroup,
            [uniformOffset] // Dynamic offset in bytes
        );

        passEncoder.setVertexBuffer(
            0,
            this.cacheService.shapeGeometryCache.getVertexBuffer(),
            shapeOffset.vertexOffset * 4 // Float32 = 4 bytes
        );

        if (shapeOffset.indexCount > 0) {
            passEncoder.setIndexBuffer(
                this.cacheService.shapeGeometryCache.getIndexBuffer(),
                'uint16',
                shapeOffset.indexOffset * 2 // Uint16 = 2 bytes
            );
            passEncoder.drawIndexed(
                shapeOffset.indexCount,
                1,
                0,
                0,
                0
            );
        } else {
            passEncoder.draw(
                shapeOffset.vertexCount / 2, // x/y pairs
                1,
                0,
                0
            );
        }
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
    
    private drawBoundingBox(passEncoder: GPURenderPassEncoder, shape: Shape): void {
        
        // Adjust this for bounding box thickness
        // Values greater than 0.01 seem to render correctly more consistently
        const thickness = 0.015;
    
        if (shape.isDirty) {
            this.cacheService.boundingBoxGeometryCache.update(shape, thickness);
        }
          
        this.cacheService.boundingBoxGeometryCache.allocate(shape, thickness);
          
        const vertexBufferOffset = this.cacheService.boundingBoxGeometryCache.getOffset(shape)?.vertexOffset;
        if (vertexBufferOffset === undefined) {
            console.warn("Bounding box offset missing for", shape.id);
            return;
        }
        
        const uniformBufferOffset = shape.usesWorldSpaceBoundingBox()
            ? this.cacheService.identityMatrixBufferOffset // 0
            : this.cacheService.boundingBoxUniformCache.allocateLocalMatrix(shape);
        
        const uniformBuffer = shape.usesWorldSpaceBoundingBox()
            ? this.cacheService.identityMatrixBuffer
            : this.cacheService.boundingBoxUniformCache.getUniformBuffer()

        const worldMatrixBuffer = this.cacheService.worldMatrixBuffer;

        const bindGroup = this.device.createBindGroup({
            layout: this.boundingBoxPipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: uniformBuffer!,
                        offset: uniformBufferOffset,
                        size: 64,
                    },
                },
                {
                    binding: 1,
                    resource: {
                        buffer: worldMatrixBuffer,
                        offset: 0,
                        size: 64,
                    },
                },
            ],
        });

        passEncoder.setPipeline(this.boundingBoxPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService.boundingBoxGeometryCache.getVertexBuffer(), vertexBufferOffset);
        passEncoder.setIndexBuffer(this.cacheService.boundingBoxGeometryCache.getIndexBuffer(), 'uint16');
        passEncoder.drawIndexed(24, 1, 0, 0, 0);
    }

    private drawLine(passEncoder: GPURenderPassEncoder, line: Line, sharedBindGroup: GPUBindGroup) {

        // Allocate space in dynamic uniform buffer
        const uniformOffset = this.cacheService.shapeUniformCache.allocate(line);
        
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
    
        passEncoder.setBindGroup(0, sharedBindGroup, [uniformOffset]);
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
        const uniformOffset = this.cacheService.shapeUniformCache.allocate(pattern);
        const bindGroup = this.device.createBindGroup({
            layout: this.patternPipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0, 
                    resource: { 
                        buffer: this.cacheService.shapeUniformCache.getUniformBuffer()!,
                        offset: uniformOffset,
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
    
        if (pattern.isDirty) {
            this.cacheService.shapeGeometryCache.update(pattern);
            pattern.isDirty = false;
        }
        this.cacheService.shapeGeometryCache.allocate(pattern);
        
        const shapeOffset = this.cacheService.shapeGeometryCache.getOffset(pattern);
        if (!shapeOffset) return;
        
        // Bind pipeline and resources
        passEncoder.setPipeline(this.patternPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, this.cacheService.shapeGeometryCache.getVertexBuffer(), shapeOffset.vertexOffset * 4);
        
        // Use correct draw command (2 vertices for 1 line)
        passEncoder.draw(shapeOffset.vertexCount / 4, 1, 0, 0); // 4 floats per vertex (x,y,u,v)
    }

    private drawScribble(passEncoder: GPURenderPassEncoder, scribble: Scribble, sharedBindGroup: GPUBindGroup): void {
        if (scribble.points.length < 2) {
            console.warn("Scribble has fewer than 2 points. Skipping rendering.");
            return; // Handle this case appropriately (e.g., remove from the scribble list).
        }
    
        // Lazy allocation: if it's not in the cache yet, upload it
        let stroke = this.cacheService.strokeGeometryCache.getOffset(scribble);
        if (!stroke) {
            // Since it's not cached yet, add it
            this.cacheService.strokeGeometryCache.allocate(scribble);
            stroke = this.cacheService.strokeGeometryCache.getOffset(scribble);
            if (!stroke) {
                console.error("Failed to cache scribble. Skipping rendering.");
                return; // In case it failed
            }
        } else if (scribble.isPointsDirty) {
            // It's cached, but dirty, so update it
            this.cacheService.strokeGeometryCache.allocate(scribble);
            scribble.isPointsDirty = false; // Reset the dirty flag after updating
            // Re-fetch the updated stroke to get updated offsets
            stroke = this.cacheService.strokeGeometryCache.getOffset(scribble);
            if (!stroke) {
                console.error("Failed to re-fetch stroke after update.");
                return;
            }
        }
    
        // Log the stroke details for debugging
        // console.log("Drawing scribble:", scribble.id, {
        //     indexOffset: stroke.indexOffset,
        //     indexCount: stroke.indexCount,
        //     vertexOffset: stroke.vertexOffset,
        //     vertexCount: stroke.vertexCount
        // });
    
        // Allocate space for the shape in the dynamic uniform buffer
        const uniformOffset = this.cacheService.shapeUniformCache.allocate(scribble);
        if (uniformOffset === undefined) {
            console.error("Failed to allocate space in the dynamic uniform buffer. Skipping rendering.");
            return;
        }
    
        passEncoder.setBindGroup(0, sharedBindGroup, [uniformOffset]);

        // !!! Without the offsets, these overwrite the buffers from the start !!!
        passEncoder.setVertexBuffer(
            0,
            this.cacheService.strokeGeometryCache.getVertexBuffer(),
            stroke.vertexOffset * 4 // Float32 = 4 bytes
        );
        passEncoder.setIndexBuffer(this.cacheService.strokeGeometryCache.getIndexBuffer(), 'uint16');
    
        // Draw the stroke
        passEncoder.drawIndexed(stroke.indexCount, 1, stroke.indexOffset, 0, 0);
    }

    private drawHighlight(passEncoder: GPURenderPassEncoder, highlight: Highlight, sharedBindGroup: GPUBindGroup): void {
        if (highlight.points.length < 2) return;
    
        // Lazy allocation: if not cached yet, upload it
        let stroke = this.cacheService.strokeGeometryCache.getOffset(highlight);
        
        if (!stroke) {
            this.cacheService.strokeGeometryCache.allocate(highlight);
            stroke = this.cacheService.strokeGeometryCache.getOffset(highlight);
            if (!stroke) {
                console.error("Failed to cache highlight stroke. Skipping rendering.");
                return;
            }
        } else if (highlight.isPointsDirty) {
            this.cacheService.strokeGeometryCache.allocate(highlight);
            stroke = this.cacheService.strokeGeometryCache.getOffset(highlight); // refetch in case buffer resized
            if (!stroke) {
                console.error("Failed to re-fetch highlight after update.");
                return;
            }
        }
        highlight.isPointsDirty = false;
    
        // Allocate dynamic uniform space
        const uniformOffset = this.cacheService.shapeUniformCache.allocate(highlight);
        if (uniformOffset === undefined) {
            console.error("Failed to allocate uniform buffer for highlight.");
            return;
        }
    
        // Set pipeline and resources
        passEncoder.setStencilReference(highlight.zIndex);
        passEncoder.setPipeline(this.highlightPipeline);
        passEncoder.setBindGroup(0, sharedBindGroup, [uniformOffset]);
    
        // Use correct vertex offset in bytes (float32 = 4 bytes)
        passEncoder.setVertexBuffer(
            0,
            this.cacheService.strokeGeometryCache.getVertexBuffer(),
            stroke.vertexOffset * 4
        );
        passEncoder.setIndexBuffer(this.cacheService.strokeGeometryCache.getIndexBuffer(), 'uint16');
    
        // Draw highlight stroke
        passEncoder.drawIndexed(stroke.indexCount, 1, stroke.indexOffset, 0, 0);
    }

    private drawText(passEncoder: GPURenderPassEncoder, text: Text, sharedBindGroup: GPUBindGroup): void {
        // Always attempt to draw the caret
        this.drawCaret(passEncoder, text, sharedBindGroup);
    
        // Skip rendering if there's no texture or dimensions are invalid
        if (!text.textureView || text.width === 0 || text.height === 0) return;
    
        // Step 1: Allocate uniform buffer space
        const uniformOffset = this.cacheService.shapeUniformCache.allocate(text);
    
        // Step 2: Allocate vertex/index geometry if needed (text.getGeometryVertices/Indices should be implemented)
        this.cacheService.shapeGeometryCache.allocate(text);
        if (text.isDirty) {
            this.cacheService.shapeGeometryCache.update(text);
            text.isDirty = false;
        }
    
        // Step 3: Get offsets into the shared vertex/index buffers
        const shapeOffset = this.cacheService.shapeGeometryCache.getOffset(text);
        if (!shapeOffset) {
            console.error(`Text shape offset missing: ${text.id}`);
            return;
        }
    
        // Step 4: Create bind group for text rendering
        const bindGroup = this.device.createBindGroup({
            layout: this.textPipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.cacheService.shapeUniformCache.getUniformBuffer()!,
                        offset: uniformOffset,
                        size: 192,
                    },
                },
                {
                    binding: 1,
                    resource: text.textureView!,
                },
                {
                    binding: 2,
                    resource: this.textSampler,
                },
            ],
        });
    
        // Step 5: Bind pipeline, buffers, and draw the shape
        passEncoder.setPipeline(this.textPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(
            0,
            this.cacheService.shapeGeometryCache.getVertexBuffer(),
            shapeOffset.vertexOffset * 4 // Float32 = 4 bytes
        );
    
        // Right now, there shouldn't really be an indexCount since we're using a UV
        if (shapeOffset.indexCount > 0) {
            passEncoder.setIndexBuffer(
                this.cacheService.shapeGeometryCache.getIndexBuffer(),
                'uint16',
                shapeOffset.indexOffset // Uint16 = 2 bytes
            );
            passEncoder.drawIndexed(shapeOffset.indexCount, 1, 0, 0, 0);
        } else {
            passEncoder.draw(shapeOffset.vertexCount / 4, 1, 0, 0); // 4 floats per vertex (x, y, u, v)
        }
    }
    
    private drawCaret(passEncoder: GPURenderPassEncoder, text: Text, sharedBindGroup: GPUBindGroup) {
        if (!text.caretVisible) return; // Only show caret if selected
        
        const uniformOffset = this.cacheService.shapeUniformCache.allocate(text);    
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
        passEncoder.setBindGroup(0, sharedBindGroup, [uniformOffset]);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(6, 1, 0, 0);
    }
}