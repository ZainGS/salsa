// Dynamic vertex/index buffer system for strokes
/*
Dynamic Vertex Buffer:
We maintain a single large Float32Array (vertexData) that represents all stroke vertices.
Each stroke is given a specific offset in this shared GPU vertex buffer.
We use writeBuffer to upload only the relevant slice when adding or updating a stroke.

Dynamic Index Buffer:
Same as vertex buffer, but using a Uint16Array for indices.
Stores how to assemble vertices into triangles (quads).
Only the used region is written to GPU on updates.

Why is this “Dynamic”?
We aren’t creating new GPU buffers per stroke.
We reuse and grow a single buffer, only uploading deltas.
We can update in-flight strokes in-place (via offset tracking).
We avoid memory fragmentation by tracking vertexOffset and indexOffset.
*/

import { Scribble } from "../../../scene-graph/shapes/scribble";
import { Highlight } from "../../../scene-graph/shapes/highlight";
import { GpuGeometryCache } from "./gpu-geometry-cache";
import { RenderDataRegistry } from "../cache-registry/render-data-registry";
import { Shape } from "../../../scene-graph/shapes/base/shape";
import { GeometryOffsets } from "../cache-registry/render-data";

export type StrokeShape = Scribble | Highlight;

export class StrokesRenderGeometryCache extends GpuGeometryCache<Scribble | Highlight> {
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;

  private vertexData: Float32Array;
  private indexData: Uint16Array;

  private maxVertices: number;
  private maxIndices: number;

  public vertexOffset: number = 0;
  public indexOffset: number = 0;

  private newestStroke: StrokeShape | null = null;
  
  private MAX_CHUNK_SIZE = 256 * 1024; // 256 KB
  // Safe value for most WebGPU implementations (128 KB)
  // private MAX_CHUNK_SIZE = 128 * 1024;
  // private MAX_CHUNK_SIZE = 10 * 1024;
  
  constructor(device: GPUDevice, registry: RenderDataRegistry<Shape>, maxVertices = 1_000_000, maxIndices = 2_000_000) {
    super(device, registry);
    this.maxVertices = maxVertices;
    this.maxIndices = maxIndices;
    this.vertexData = new Float32Array(maxVertices);
    this.indexData = new Uint16Array(maxIndices);

    this.vertexBuffer = this.createVertexBuffer(maxVertices);
    this.indexBuffer = this.createIndexBuffer(maxIndices);
  }

  private writeBufferInChunks(
    queue: GPUQueue,
    buffer: GPUBuffer,
    dstOffset: number,
    srcBuffer: ArrayBuffer,
    srcOffset: number,
    totalBytes: number
  ) {
    if (totalBytes <= 0) return;
    let remaining = totalBytes;
    while (remaining > 0) {
      const chunkSize = Math.min(remaining, this.MAX_CHUNK_SIZE);
      queue.writeBuffer(buffer, dstOffset, srcBuffer, srcOffset, chunkSize);
      dstOffset += chunkSize;
      srcOffset += chunkSize;
      remaining -= chunkSize;
    }
  }

  private createVertexBuffer(size: number): GPUBuffer {
    return this.device.createBuffer({
      size: size * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  private createIndexBuffer(size: number): GPUBuffer {
    return this.device.createBuffer({
      size: size * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
  }

  public allocate(obj: StrokeShape): number {
    // Automatically choose the correct halfThickness based on shape type
    const halfThickness = obj.strokeWidth * (obj instanceof Scribble ? 0.005 : 0.035);
    this.add(obj, halfThickness);
  
    // For strokes, we don't use uniform buffers, so just return dummy 0 offset
    return 0;
  }

  public add(shape: StrokeShape, halfThickness: number): void {
    const points = shape.points;
    if (points.length < 2) return;

    let vertexStart: number;
    let indexStart: number;

    const existing = this.registry.get(shape)?.geometryOffset;
    if (existing) {
      // Reuse previously allocated region
      vertexStart = existing.vertexOffset;
      indexStart = existing.indexOffset;
    } else {
      // New shape, allocate fresh region
      vertexStart = this.vertexOffset;
      indexStart = this.indexOffset;
    }

    // Make sure you won’t overflow the buffer even though you’re writing to the same region.
    const estimatedVertices = points.length * 2;
    const estimatedIndices = (points.length - 1) * 6;
    // Ensure we have enough space for the updated stroke
    this.ensureVertexCapacity(this.vertexOffset + estimatedVertices);
    this.ensureIndexCapacity(this.indexOffset + estimatedIndices);

    // Write new data starting at the original offset
    let v = vertexStart;
    let i = indexStart;

    // Use averaged normals per point, instead of per segment, to
    // get smooth quads that line up across stroke segments.
    // Calculating normals at each point is a key fix for gaps between segments. 
    // We compute smoothed normals by using the vector from the previous point to the next point.
    // This makes the edges of quads point in the right direction, preventing gaps from misaligned segments.
    const normals: { x: number; y: number }[] = [];
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
      this.vertexData[v++] = prev.x - normalA.x * halfThickness;
      this.vertexData[v++] = prev.y - normalA.y * halfThickness;
      this.vertexData[v++] = prev.x + normalA.x * halfThickness;
      this.vertexData[v++] = prev.y + normalA.y * halfThickness;

      this.vertexData[v++] = curr.x - normalB.x * halfThickness;
      this.vertexData[v++] = curr.y - normalB.y * halfThickness;
      this.vertexData[v++] = curr.x + normalB.x * halfThickness;
      this.vertexData[v++] = curr.y + normalB.y * halfThickness;

      const vi = (base - vertexStart) / 2;
      if (!Number.isFinite(vi)) continue;

      // Standard 2-triangle quad built from the 4 verts above.
      this.indexData[i++] = vi;
      this.indexData[i++] = vi + 1;
      this.indexData[i++] = vi + 2;
      this.indexData[i++] = vi + 1;
      this.indexData[i++] = vi + 2;
      this.indexData[i++] = vi + 3;
    }

    const vertexCount = v - vertexStart;
    const indexCount = i - indexStart;

    // Upload only the relevant GPU buffer slices.
    // The offset.vertexOffset * 4 gives us the byte offset in GPU buffer.
    // We’re writing only what changed, not the entire buffer.
    this.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer,
      vertexStart * 4,
      this.vertexData.buffer as ArrayBuffer,
      this.vertexData.byteOffset + vertexStart * 4,
      vertexCount * 4
    );
    // The offset.indexOffset * 2 gives us the byte offset in GPU buffer.
    // Uploads only what’s needed to the GPU.
    this.writeBufferInChunks(
      this.device.queue,
      this.indexBuffer,
      indexStart * 2,
      this.indexData.buffer as ArrayBuffer,
      this.indexData.byteOffset + indexStart * 2,
      indexCount * 2
    );

    // Update metadata
    // Update the offset record with the new size
    this.registry.set(shape, {
      geometryOffset: {
        vertexOffset: vertexStart,
        indexOffset: indexStart,
        vertexCount,
        indexCount,
      },
    });
    // Global offsets
    this.vertexOffset = v;
    this.indexOffset = i;
    this.newestStroke = shape;
  }

  public update(shape: StrokeShape) {
    // Only allow updates to the newest stroke being drawn
    if (shape !== this.newestStroke) return;
    const offset = this.registry.get(shape)?.geometryOffset;
    if (!offset) return;
    this.add(shape, shape.strokeWidth * (shape instanceof Scribble ? 0.005 : 0.035));
  }

  private ensureVertexCapacity(required: number) {
    if (required >= this.vertexData.length) {
      const newSize = Math.max(this.vertexData.length * 2, required);
      const newVertexData = new Float32Array(newSize);
      newVertexData.set(this.vertexData.subarray(0, this.vertexOffset));
      const newVertexBuffer = this.createVertexBuffer(newSize);
      const bytesUsed = this.vertexOffset * 4;
      
      this.writeBufferInChunks(
        this.device.queue,
        newVertexBuffer,
        0,
        newVertexData.buffer as ArrayBuffer,
        0,
        bytesUsed
      );

      this.vertexBuffer.destroy();
      this.vertexData = newVertexData;
      this.vertexBuffer = newVertexBuffer;
    }
  }

  private ensureIndexCapacity(required: number) {
    if (required >= this.indexData.length) {
      const newSize = Math.max(this.indexData.length * 2, required);
      const newIndexData = new Uint16Array(newSize);
      newIndexData.set(this.indexData.subarray(0, this.indexOffset));
      const newIndexBuffer = this.createIndexBuffer(newSize);
      const bytesUsed = this.indexOffset * 2;

      this.writeBufferInChunks(
        this.device.queue,
        newIndexBuffer,
        0,
        newIndexData.buffer as ArrayBuffer,
        0,
        bytesUsed
      );

      this.indexBuffer.destroy();
      this.indexData = newIndexData;
      this.indexBuffer = newIndexBuffer;
    }
  }

  public getVertexBuffer(): GPUBuffer {
    return this.vertexBuffer;
  }

  public getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }

  public getOffset(obj: StrokeShape): GeometryOffsets | undefined {
    return this.registry.get(obj)?.geometryOffset;
  } 
}
