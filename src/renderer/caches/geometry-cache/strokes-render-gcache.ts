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
import { GpuBufferUtils } from "../../util/gpu-buffer-utils";
import { Line } from "../../../scene-graph/shapes/line";

export type StrokeShape = Scribble | Highlight;

export class StrokesRenderGeometryCache extends GpuGeometryCache<Scribble | Highlight> {
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;

  private vertexData: Float32Array;
  private indexData: Uint32Array;

  public vertexOffset: number = 0;
  public indexOffset: number = 0;

  private newestStroke: StrokeShape | null = null;
  
  constructor(device: GPUDevice, registry: RenderDataRegistry<Shape>, maxVertices = 1_000_000, maxIndices = 2_000_000) {
    super(device, registry);
    this.vertexData = new Float32Array(maxVertices);
    this.indexData = new Uint32Array(maxIndices);

    this.vertexBuffer = GpuBufferUtils.createVertexBuffer(maxVertices, this.device);
    this.indexBuffer = GpuBufferUtils.createIndexBuffer(maxIndices, this.device);
  }

  public allocate(shape: StrokeShape, vertexCount: number, indexCount: number): void {
    const existing = this.registry.registryMap.get(shape.id)?.geometryOffset;
    if (existing) return;
  
    const vertexOffset = this.vertexOffset;
    const indexOffset = this.indexOffset;

    this.registry.set('stroke', shape, {
      geometryOffset: {
        vertexOffset,
        indexOffset,
        vertexCount,
        indexCount,
      },
    });
  
    this.vertexOffset += vertexCount;
    this.indexOffset += indexCount;
    this.newestStroke = shape;
  }

  public allocateLine(line: Line): void {
    const existing = this.registry.get(line)?.geometryOffset;
    if (existing) return;
  
    const vertices = line.getGeometryVertices();
    // Each vertex is 2 floats (x, y). Generate sequential indices for all vertices.
    const drawVertexCount = vertices.length / 2;
    const indices = new Uint32Array(drawVertexCount);
    for (let i = 0; i < drawVertexCount; i++) indices[i] = i;
  
    const vertexCount = vertices.length;
    const indexCount = indices.length;
  
    const vertexOffset = this.vertexOffset;
    const indexOffset = this.indexOffset;
  
    // Store in vertexData and indexData
    this.vertexData.set(vertices, vertexOffset);
    this.indexData.set(indices, indexOffset);
  
    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer,
      vertexOffset * 4,
      this.vertexData.buffer as ArrayBuffer,
      this.vertexData.byteOffset + vertexOffset * 4,
      vertexCount * 4
    );
  
    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.indexBuffer,
      indexOffset * 4,
      this.indexData.buffer as ArrayBuffer,
      this.indexData.byteOffset + indexOffset * 4,
      indexCount * 4
    );
  
    this.registry.set('line', line, {
      geometryOffset: {
        vertexOffset,
        indexOffset,
        vertexCount,
        indexCount
      }
    });
  
    this.vertexOffset += vertexCount;
    this.indexOffset += indexCount;
  }
  
  public update(shape: StrokeShape): void {
    // Only allow updates to the newest stroke being drawn
    if (shape !== this.newestStroke) return;
    const offset = this.registry.registryMap.get(shape.id)?.geometryOffset;
    if (!offset) return;
    
    // Automatically choose the correct halfThickness based on shape type
    //const halfThickness = shape.strokeWidth * (shape instanceof Scribble ? 0.005 : 0.035);
    const halfThickness = shape.strokeWidth/2;
    
    const points = shape.points;
    if (points.length < 2) {
      return;
    }

    let vertexStart: number;
    let indexStart: number;

    const existing = this.registry.registryMap.get(shape.id)?.geometryOffset;
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
    ({ buffer: this.vertexBuffer, data: this.vertexData } = GpuBufferUtils.ensureBufferCapacity(
      this.device.queue,
      this.vertexBuffer,
      this.vertexData,
      this.vertexOffset,
      vertexStart + estimatedVertices,
      4, // bytes per float32
      (size) => GpuBufferUtils.createVertexBuffer(size, this.device)
    ));

    ({ buffer: this.indexBuffer, data: this.indexData } = GpuBufferUtils.ensureBufferCapacity(
      this.device.queue,
      this.indexBuffer,
      this.indexData,
      this.indexOffset,
      indexStart + estimatedIndices,
      4, // bytes per uint32
      (size) => GpuBufferUtils.createIndexBuffer(size, this.device)
    ));

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
    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer,
      vertexStart * 4,
      this.vertexData.buffer as ArrayBuffer,
      this.vertexData.byteOffset + vertexStart * 4,
      vertexCount * 4
    );

    // The offset.indexOffset * 4 gives us the byte offset in GPU buffer.
    // Uploads only what's needed to the GPU.
    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.indexBuffer,
      indexStart * 4,
      this.indexData.buffer as ArrayBuffer,
      this.indexData.byteOffset + indexStart * 4,
      indexCount * 4
    );

    // Update metadata (Update the offset record with the new size)
    this.registry.set('stroke', shape, {
      geometryOffset: {
        vertexOffset: vertexStart,
        indexOffset: indexStart,
        vertexCount,
        indexCount,
      },
    });

    // Global offsets — only advance forward, never regress
    this.vertexOffset = Math.max(this.vertexOffset, v);
    this.indexOffset = Math.max(this.indexOffset, i);
    this.newestStroke = shape;
  }

  /**
   * Re-upload a committed Line's vertex geometry in-place at its existing offset.
   * Called when a bound connector moves an endpoint on an already-committed line.
   * Returns true if the upload succeeded.
   */
  public reuploadLineGeometry(line: Line): boolean {
    const entry = this.registry.registryMap.get(line.id);
    if (!entry?.geometryOffset) return false;

    const offset = entry.geometryOffset;
    const vertices = line.getGeometryVertices();
    if (!vertices || vertices.length === 0) return false;

    // Upload vertex data at existing offset
    const uploadFloats = Math.min(vertices.length, offset.vertexCount);
    this.vertexData.set(vertices.subarray(0, uploadFloats), offset.vertexOffset);

    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.vertexBuffer,
      offset.vertexOffset * 4,
      this.vertexData.buffer as ArrayBuffer,
      this.vertexData.byteOffset + offset.vertexOffset * 4,
      uploadFloats * 4
    );

    // Re-upload index buffer: sequential indices covering all draw vertices
    const drawVertexCount = Math.floor(uploadFloats / 2);
    const indices = new Uint32Array(drawVertexCount);
    for (let i = 0; i < drawVertexCount; i++) indices[i] = i;

    const uploadIndices = Math.min(drawVertexCount, offset.indexCount);
    this.indexData.set(indices.subarray(0, uploadIndices), offset.indexOffset);

    GpuBufferUtils.writeBufferInChunks(
      this.device.queue,
      this.indexBuffer,
      offset.indexOffset * 4,
      this.indexData.buffer as ArrayBuffer,
      this.indexData.byteOffset + offset.indexOffset * 4,
      uploadIndices * 4
    );

    // Update stored counts so draw commands use the right range
    offset.vertexCount = uploadFloats;
    offset.indexCount = uploadIndices;
    return true;
  }

  public getVertexBuffer(): GPUBuffer {
    return this.vertexBuffer;
  }

  public getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }

  public getOffset(obj: StrokeShape | Line): GeometryOffsets | undefined {
    return this.registry.registryMap.get(obj.id)?.geometryOffset;
  } 
}
