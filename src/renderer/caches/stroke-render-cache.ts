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

import { Scribble } from "../../scene-graph/shapes/scribble";
import { Highlight } from "../../scene-graph/shapes/highlight";

type StrokeShape = Scribble | Highlight;

interface StrokeOffset {
  vertexOffset: number; // index in Float32Array, not bytes
  indexOffset: number;  // index in index buffer
  indexCount: number;
  vertexCount: number;
}

export class StrokeRenderCache {
  private device: GPUDevice;

  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;

  private vertexData: Float32Array;
  private indexData: Uint16Array;

  private maxVertices: number;
  private maxIndices: number;

  private vertexOffset: number = 0;
  private indexOffset: number = 0;

  // Lets us reuse and update strokes at specific GPU offsets.
  private scribbleOffsets: Map<Scribble, StrokeOffset> = new Map();
  private highlightOffsets: Map<Highlight, StrokeOffset> = new Map();

  private newestStroke: StrokeShape | null = null; // Track the newest stroke

  constructor(device: GPUDevice, maxVertices = 1_000_000, maxIndices = 2_000_000) {
    this.device = device;
    this.maxVertices = maxVertices;
    this.maxIndices = maxIndices;
    this.vertexData = new Float32Array(maxVertices);
    this.indexData = new Uint16Array(maxIndices);

    this.vertexBuffer = this.createVertexBuffer(maxVertices);
    this.indexBuffer = this.createIndexBuffer(maxIndices);
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

  public addSingleScribble(scribble: Scribble) {
    this.addStroke(scribble, this.scribbleOffsets, scribble.strokeWidth * 0.005);
    this.newestStroke = scribble; // Set as the newest stroke
  }

  public addSingleHighlight(highlight: Highlight) {
    this.addStroke(highlight, this.highlightOffsets, highlight.strokeWidth * 0.035);
    this.newestStroke = highlight; // Set as the newest stroke
  }

  public getOffset(shape: StrokeShape): StrokeOffset | undefined {
    if (shape instanceof Scribble) {
      return this.scribbleOffsets.get(shape);
    } else {
      return this.highlightOffsets.get(shape as Highlight);
    }
  }

  public updateStroke(shape: StrokeShape) {
    
    // Only allow updates to the newest stroke being drawn
    if (shape !== this.newestStroke) {
        console.warn("Cannot update an old stroke. Only the newest stroke can be updated.");
        return;
    }

    const offset = this.getOffset(shape);
    if (!offset) {
        console.warn("Stroke not found in cache. Adding it as a new stroke.");
        if (shape instanceof Scribble) {
            this.addSingleScribble(shape);
        } else {
            this.addSingleHighlight(shape as Highlight);
        }
        return;
    }

    const points = shape.points;
    if (points.length < 2) return;

    const isScribble = shape instanceof Scribble;
    const halfThickness = shape.strokeWidth * (isScribble ? 0.005 : 0.035);

    // Make sure you won’t overflow the buffer even though you’re writing to the same region.
    const estimatedVertices = points.length * 2;
    const estimatedIndices = (points.length - 1) * 6;
    // Ensure we have enough space for the updated stroke
    this.ensureVertexCapacity(offset.vertexOffset + estimatedVertices);
    this.ensureIndexCapacity(offset.indexOffset + estimatedIndices);

    // Write new data starting at the original offset
    const vertexStart = offset.vertexOffset;
    const indexStart = offset.indexOffset;

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

    const vertexCount = v - offset.vertexOffset;
    const indexCount = i - offset.indexOffset;

    // Upload only the relevant GPU buffer slices.
    // The offset.vertexOffset * 4 gives us the byte offset in GPU buffer.
    // We’re writing only what changed, not the entire buffer.
    this.device.queue.writeBuffer(
        this.vertexBuffer,
        offset.vertexOffset * 4,
        this.vertexData,
        offset.vertexOffset,
        vertexCount
    );
    // The offset.indexOffset * 2 gives us the byte offset in GPU buffer.
    // Uploads only what’s needed to the GPU.
    this.device.queue.writeBuffer(
        this.indexBuffer,
        offset.indexOffset * 2,
        this.indexData,
        offset.indexOffset,
        indexCount
    );

    // Update metadata
    // Update the offset record with the new size
    offset.vertexCount = vertexCount;
    offset.indexCount = indexCount;
    // Global offsets
    this.vertexOffset = offset.vertexOffset + offset.vertexCount;
    this.indexOffset = offset.indexOffset + offset.indexCount;

    // Ensure we have enough space for the updated stroke
    // Might not need this... Hmmmm
    this.ensureVertexCapacity(this.vertexOffset + vertexCount);
    this.ensureIndexCapacity(this.indexOffset + indexCount);
}

private deallocateStroke(shape: StrokeShape): void {
  if (shape instanceof Scribble) {
    this.scribbleOffsets.delete(shape);
  } else {
    this.highlightOffsets.delete(shape as Highlight);
  }
}

  private addStroke<T extends StrokeShape>(
    shape: T,
    offsetsMap: Map<T, StrokeOffset>,
    halfThickness: number
) {
    console.log("Adding", shape.id, "at vertexOffset:", this.vertexOffset, "indexOffset:", this.indexOffset);
    const points = shape.points;
    if (points.length < 2) return;

    const estimatedVertices = points.length * 2; // 2 vertices per point
    const estimatedIndices = (points.length - 1) * 6; // 6 indices per segment

    // Ensure we have enough space for the new stroke
    this.ensureVertexCapacity(this.vertexOffset + estimatedVertices);
    this.ensureIndexCapacity(this.indexOffset + estimatedIndices);

    const vertexStart = this.vertexOffset;
    const indexStart = this.indexOffset;

    let v = vertexStart;
    let i = indexStart;

    const normals: { x: number; y: number }[] = [];
    for (let p = 0; p < points.length; p++) {
        const prev = points[p - 1] ?? points[p];
        const next = points[p + 1] ?? points[p];

        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;

        const nx = -(dy / len);
        const ny = dx / len;

        normals.push({ x: nx, y: ny });
    }

    for (let p = 1; p < points.length; p++) {
      const prev = points[p - 1];
      const curr = points[p];
  
      const normalA = normals[p - 1];
      const normalB = normals[p];
  
      const base = v;
  
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
  
      this.indexData[i++] = vi;
      this.indexData[i++] = vi + 1;
      this.indexData[i++] = vi + 2;
      this.indexData[i++] = vi + 1;
      this.indexData[i++] = vi + 2;
      this.indexData[i++] = vi + 3;
    }

    const vertexCount = v - vertexStart;
    const indexCount = i - indexStart;

    // Update the GPU buffers
    this.device.queue.writeBuffer(
        this.vertexBuffer,
        vertexStart * 4,
        this.vertexData,
        vertexStart,
        vertexCount
    );
    this.device.queue.writeBuffer(
        this.indexBuffer,
        indexStart * 2,
        this.indexData,
        indexStart,
        indexCount
    );

    // Store the offset for this stroke
    offsetsMap.set(shape, {
        vertexOffset: vertexStart,
        indexOffset: indexStart,
        indexCount,
        vertexCount,
    });

    // Advance global offsets
    this.vertexOffset = v;
    this.indexOffset = i;
}

// Allows dynamic growth — buffer resizing without crashing.
private ensureVertexCapacity(required: number) {
  if (required >= this.vertexData.length) {
    console.log("v resize");
      // Calculate the new size, ensuring it's large enough
      const newSize = Math.max(this.vertexData.length * 2, required);

      // Create a new vertex data array and copy existing data
      const newVertexData = new Float32Array(newSize);
      newVertexData.set(this.vertexData.subarray(0, this.vertexOffset)); // Copy only used data

      // Create a new GPU buffer
      const newVertexBuffer = this.createVertexBuffer(newSize);

      // Upload the new data to the GPU
      const bytesUsed = this.vertexOffset * 4; // float32 = 4 bytes
      this.device.queue.writeBuffer(newVertexBuffer, 0, newVertexData.buffer, 0, bytesUsed);

      // Clean up the old buffer
      this.vertexBuffer.destroy();

      // Update references
      this.vertexData = newVertexData;
      this.vertexBuffer = newVertexBuffer;

      console.log("Resized vertex buffer to", newSize);
  }
}

private ensureIndexCapacity(required: number) {
  if (required >= this.indexData.length) {
    console.log("i resize");
      // Calculate the new size, ensuring it's large enough
      const newSize = Math.max(this.indexData.length * 2, required);

      // Create a new index data array and copy existing data
      const newIndexData = new Uint16Array(newSize);
      newIndexData.set(this.indexData.subarray(0, this.indexOffset)); // Copy only used data

      // Create a new GPU buffer
      const newIndexBuffer = this.createIndexBuffer(newSize);

      // Upload the new data to the GPU
      const bytesUsed = this.indexOffset * 2; // uint16 = 2 bytes
      this.device.queue.writeBuffer(newIndexBuffer, 0, newIndexData.buffer, 0, bytesUsed);

      // Clean up the old buffer
      this.indexBuffer.destroy();

      // Update references
      this.indexData = newIndexData;
      this.indexBuffer = newIndexBuffer;

      console.log("Resized index buffer to", newSize);
  }
}

  // public clear() {
  //   console.log("test");
  //   this.scribbleOffsets.clear();
  //   this.highlightOffsets.clear();
  //   this.vertexOffset = 0;
  //   this.indexOffset = 0;
  //   this.newestStroke = null;

  //   this.vertexData = new Float32Array(this.maxVertices);
  //   this.indexData = new Uint16Array(this.maxIndices);

  //   this.vertexBuffer.destroy();
  //   this.indexBuffer.destroy();

  //   this.vertexBuffer = this.createVertexBuffer(this.maxVertices);
  //   this.indexBuffer = this.createIndexBuffer(this.maxIndices);
  // }

  public getVertexBuffer(): GPUBuffer {
    return this.vertexBuffer;
  }

  public getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }
}