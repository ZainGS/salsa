/**
Uses triple buffering (frameCount = 3) to prevent GPU-CPU sync issues across frames.
Allocates per-frame vertex and index buffers that act as in-flight, temporary geometry caches.
Uploads geometry for actively drawn scribbles (or highlights) each frame.
Allows us to render live drawing previews without affecting the shared cache or final buffers.
Lets us "flush" committed strokes into our main StrokesRenderGeometryCache once drawing is finalized.
 */

import { Scribble } from "../../../scene-graph/shapes/scribble";
import { StrokesRenderGeometryCache } from "../geometry-cache/strokes-render-gcache";
import { Highlight } from "../../../scene-graph/shapes/highlight";
import { Line } from "../../../scene-graph/shapes/line";

export class StrokesStagingBuffer {
    private device: GPUDevice;
    private vertexBuffers: GPUBuffer[] = [];
    private indexBuffers: GPUBuffer[] = [];
    private vertexData: Float32Array[] = [];
    private indexData: Uint16Array[] = [];

    private maxVertices = 4096; // Enough for a medium stroke
    private maxIndices = 8192;

    private currentVertexCount = 0;
    private currentIndexCount = 0;

    public currentFrameIndex: number = 0;
    private frameCount = 3;

    private readonly BYTES_PER_VERTEX = 4; // Float32
    private readonly BYTES_PER_INDEX = 2;  // Uint16

    private uniformBuffer: GPUBuffer;
    private readonly UNIFORM_SIZE = 272; // aligned to 272 bytes per draw

    private indexCountThisFrame = 0;

    constructor(device: GPUDevice) {
        this.device = device;
        // This buffer contains: [ Frame 0 uniform data ][ Frame 1 uniform data ][ Frame 2 uniform data ]
        this.uniformBuffer = this.device.createBuffer({
            size: this.UNIFORM_SIZE * this.frameCount, // e.g., 256 * 3 = 768
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        for (let i = 0; i < this.frameCount; i++) {
            this.vertexData[i] = new Float32Array(this.maxVertices);
            this.indexData[i] = new Uint16Array(this.maxIndices);

            this.vertexBuffers[i] = this.device.createBuffer({
                size: this.maxVertices * this.BYTES_PER_VERTEX,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });

            this.indexBuffers[i] = this.device.createBuffer({
                size: this.maxIndices * this.BYTES_PER_INDEX,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
        }
    }

    private lastFrameIndex = -1;
    public beginFrame() {
        const index = (this.currentFrameIndex + 1) % this.frameCount;
        if (index !== this.lastFrameIndex) {
            this.currentFrameIndex = index;
            this.indexCountThisFrame = 0;
            this.currentVertexCount = 0;
            this.currentIndexCount = 0;
            this.vertexData[this.currentFrameIndex].fill(0);
            this.indexData[this.currentFrameIndex].fill(0);
            this.lastFrameIndex = index;
        }
    }
  
    writeStroke(s: Scribble | Highlight): { vertexCount: number, indexCount: number, vertexStart: number, indexStart: number, frameIndex: number; } {

        const neededVertices = (s.points.length - 1) * 8;  // 8 floats per segment
        const neededIndices = (s.points.length - 1) * 6;   // 6 indices per segment

        if (neededVertices > this.maxVertices) {
            this.maxVertices = neededVertices * 2;
        
            this.vertexData[this.currentFrameIndex] = new Float32Array(this.maxVertices);
            this.vertexBuffers[this.currentFrameIndex] = this.device.createBuffer({
                size: this.maxVertices * this.BYTES_PER_VERTEX,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }
        
        if (neededIndices > this.maxIndices) {
            this.maxIndices = neededIndices * 2;
        
            this.indexData[this.currentFrameIndex] = new Uint16Array(this.maxIndices);
            this.indexBuffers[this.currentFrameIndex] = this.device.createBuffer({
                size: this.maxIndices * this.BYTES_PER_INDEX,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
        }
    
        // const MAX_ALLOWED_VERTICES = 65536;
        // if (neededVertices > MAX_ALLOWED_VERTICES) {
        //     console.warn("Stroke too long, skipping frame.");
        //     return;
        // }

        const vertexArray = this.vertexData[this.currentFrameIndex];
        const indexArray = this.indexData[this.currentFrameIndex];
        let vertexStart = 0; // always 0 in staging
        let v = vertexStart;
        let indexStart = 0;
        let i = indexStart;
        const halfThickness = s.strokeWidth/2;
    
        // Use averaged normals per point, instead of per segment, to
        // get smooth quads that line up across stroke segments.
        // Calculating normals at each point is a key fix for gaps between segments. 
        // We compute smoothed normals by using the vector from the previous point to the next point.
        // This makes the edges of quads point in the right direction, preventing gaps from misaligned segments.
        const normals = [];
        const points = s.points;
    
        for (let p = 0; p < points.length; p++) {
            // For each point p, we look at the point before and after: prev and next.
            const prev = points[p - 1] ?? points[p];
            const next = points[p + 1] ?? points[p];

            // We construct a tangent vector (dx, dy) through those two points.
            const dx = next.x - prev.x;
            const dy = next.y - prev.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;

            // Then we calculate a normal by rotating that tangent 90° counter-clockwise:
            const nx = -(dy / len);
            const ny = dx / len;

            // This gives a unit-length perpendicular direction that’s "smoothed" over adjacent segments.
            normals.push({ x: nx, y: ny });
        }
    
        // Then we use these normals to build quads:
        // (Build vertices and indices with smoothed normals)
        for (let p = 1; p < points.length; p++) {
            const prev = points[p - 1];
            const curr = points[p];

            // normalA affects how the tail of the quad is angled
            // normalB affects how the head of the quad is angled
            const normalA = normals[p - 1];
            const normalB = normals[p];
            const base = v;
    
            // These are the two quads (8 values = 4 vec2s) per segment
            // Each point creates two vertices (left + right) using the 
            // normal to "push" outward, forming the sides of the stroke.
            // And with this, our joins between segments are visually seamless — 
            // no cracks, no plus signs, no sudden spikes. Just smooth strokes.
            
            /* Normal smoothing explanation
            When you draw a stroke, you don’t want it to be just a line — you want it to have thickness.
            To get thickness, we generate two points on either side of the main line, using the normal direction.
            If the center line goes like this:
            A -------- B

            Then we build a quad like this (exaggerated):
            A1         B1   ← line + normal * thickness
            |          |
            A -------- B   ← center line
            |          |
            A2         B2   ← line - normal * thickness

            Instead of using one normal per segment, we created a smooth average normal per point by using:
            normal at p = perpendicular of (next - prev)

            So every point knows how to “split the angle” between its two connected lines. 
            This avoids cracks between segments and creates beautiful continuity.*/
            vertexArray[v++] = prev.x - normalA.x * halfThickness;
            vertexArray[v++] = prev.y - normalA.y * halfThickness;
            vertexArray[v++] = prev.x + normalA.x * halfThickness;
            vertexArray[v++] = prev.y + normalA.y * halfThickness;
    
            vertexArray[v++] = curr.x - normalB.x * halfThickness;
            vertexArray[v++] = curr.y - normalB.y * halfThickness;
            vertexArray[v++] = curr.x + normalB.x * halfThickness;
            vertexArray[v++] = curr.y + normalB.y * halfThickness;
    
            const vi = (v - 8) / 2;
            //const vi = (base - vertexStart) / 2;
            if (!Number.isFinite(vi)) continue;

            // Standard 2-triangle quad built from the 4 verts above.
            indexArray[i++] = vi;
            indexArray[i++] = vi + 1;
            indexArray[i++] = vi + 2;
            indexArray[i++] = vi + 1;
            indexArray[i++] = vi + 2;
            indexArray[i++] = vi + 3;
        }
    
        this.currentVertexCount = v - vertexStart;
        this.currentIndexCount = i - indexStart;

        this.device.queue.writeBuffer(
            this.vertexBuffers[this.currentFrameIndex],
            0,
            vertexArray.buffer,
            vertexArray.byteOffset,
            v * this.BYTES_PER_VERTEX
        );
    
        this.device.queue.writeBuffer(
            this.indexBuffers[this.currentFrameIndex],
            0,
            indexArray.buffer,
            indexArray.byteOffset,
            i * this.BYTES_PER_INDEX
        );

        this.indexCountThisFrame = i;

        return {
            vertexCount: this.currentVertexCount,
            indexCount: this.currentIndexCount,
            vertexStart,
            indexStart,
            frameIndex: this.currentFrameIndex
          };
    }

    writeLine(line: Line): { vertexCount: number, indexCount: number, vertexStart: number, indexStart: number, frameIndex: number; } {
        const frame = this.currentFrameIndex;
        const vertices = line.getGeometryVertices();
        const indices = new Uint16Array([0, 1, 2, 3, 4, 5]);
    
        // Ensure vertex buffer size
        if (vertices.length > this.maxVertices) {
            this.maxVertices = vertices.length * 2;
            this.vertexData[frame] = new Float32Array(this.maxVertices);
            this.vertexBuffers[frame] = this.device.createBuffer({
                size: this.maxVertices * this.BYTES_PER_VERTEX,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }
    
        // Ensure index buffer size
        if (indices.length > this.maxIndices) {
            this.maxIndices = indices.length * 2;
            this.indexData[frame] = new Uint16Array(this.maxIndices);
            this.indexBuffers[frame] = this.device.createBuffer({
                size: this.maxIndices * this.BYTES_PER_INDEX,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
        }
    
        // Write to vertex and index arrays
        this.vertexData[frame].set(vertices, 0);
        this.indexData[frame].set(indices, 0);
    
        this.currentVertexCount = vertices.length / 2; // 6 vertices
        this.currentIndexCount = indices.length;
        this.indexCountThisFrame = indices.length;
    
        this.device.queue.writeBuffer(
            this.vertexBuffers[frame],
            0,
            this.vertexData[frame].buffer,
            this.vertexData[frame].byteOffset,
            vertices.length * this.BYTES_PER_VERTEX
        );
    
        this.device.queue.writeBuffer(
            this.indexBuffers[frame],
            0,
            this.indexData[frame].buffer,
            this.indexData[frame].byteOffset,
            indices.length * this.BYTES_PER_INDEX
        );
    
        return {
            vertexCount: this.currentVertexCount,
            indexCount: this.currentIndexCount,
            vertexStart: 0,
            indexStart: 0,
            frameIndex: frame
        };
    }
  
    renderStagingStroke(pass: GPURenderPassEncoder, dynamicBindGroup: GPUBindGroup) {
        const vb = this.vertexBuffers[this.currentFrameIndex];
        const ib = this.indexBuffers[this.currentFrameIndex];

        pass.setBindGroup(0, dynamicBindGroup, [this.currentFrameIndex * 272]);
        pass.setVertexBuffer(0, vb);
        pass.setIndexBuffer(ib, 'uint16');

        if (this.indexCountThisFrame === 0) return;
        pass.setStencilReference(9999999); // For highlights

        console.log("🧪 Staging line:", {
            vb,
            ib,
            indexCount: this.indexCountThisFrame,
            vertexData: this.vertexData[this.currentFrameIndex].slice(0, 12),
            indexData: this.indexData[this.currentFrameIndex].slice(0, 6),
          });


        pass.drawIndexed(this.indexCountThisFrame, 1, 0, 0, 0);
    }
    
    createDynamicBindGroup(uniformBuffer: GPUBuffer, layout: GPUBindGroupLayout, offset: number): GPUBindGroup {
        return this.device.createBindGroup({
            layout,
            entries: [{
            binding: 0,
            resource: {
                buffer: uniformBuffer,
                offset: offset,
                size: 256 // if needed; WebGPU requires `offset % 256 === 0`
            }
            }]
        });
    }

    createStagingBindGroup(layout: GPUBindGroupLayout): GPUBindGroup {
        return this.device.createBindGroup({
            layout,
            entries: [{
                binding: 0,
                resource: {
                    buffer: this.uniformBuffer,
                    offset: this.currentFrameIndex * 272,
                    size: this.UNIFORM_SIZE
                }
            }]
        });
    }

    writeUniforms(data: Float32Array) {
        this.device.queue.writeBuffer(
          this.uniformBuffer,
          this.currentFrameIndex * 272,
          data.buffer,
          data.byteOffset,
          data.byteLength
        );
    }

    public getCurrentCounts(): { vertexCount: number; indexCount: number } {
        return {
            vertexCount: this.currentVertexCount,
            indexCount: this.currentIndexCount,
        };
    }

    public copyToSharedBuffer(obj: Scribble | Highlight | Line, shared: StrokesRenderGeometryCache) {
        const frameIndex = obj._stagingInfo.frameIndex;
        const offset = shared.getOffset(obj);
        
        if (!offset) {
            console.error("❌ Missing offset for", obj.id);
            console.warn("Registry dump:", shared.registry);
            return;
        }

        this.device.queue.writeBuffer(
            shared.getVertexBuffer(),
            offset.vertexOffset * 4,
            this.vertexData[frameIndex].buffer,
            this.vertexData[frameIndex].byteOffset,
            offset.vertexCount * 4
        );
    
        this.device.queue.writeBuffer(
            shared.getIndexBuffer(),
            offset.indexOffset * 2,
            this.indexData[frameIndex].buffer,
            this.indexData[frameIndex].byteOffset,
            offset.indexCount * 2
        );

        //this.resetCurrentFrame();
    }

    public resetCurrentFrame() {
        this.currentVertexCount = 0;
        this.currentIndexCount = 0;
        this.indexCountThisFrame = 0;
        this.vertexData[this.currentFrameIndex].fill(0);
        this.indexData[this.currentFrameIndex].fill(0);
    }
    
}