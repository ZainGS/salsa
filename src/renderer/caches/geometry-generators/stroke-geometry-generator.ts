import { Scribble } from "../../../scene-graph/shapes/scribble";
import { Highlight } from "../../../scene-graph/shapes/highlight";
import { Line } from "../../../scene-graph/shapes/line";

export interface StrokeGeometry {
  vertexData: Float32Array;
  indexData: Uint16Array;
  vertexCount: number;
  indexCount: number;
}

export class StrokeGeometryGenerator {
  public generate(s: Scribble | Highlight): StrokeGeometry {
    const points = s.points;
    if (points.length < 2) return {
      vertexData: new Float32Array(0),
      indexData: new Uint16Array(0),
      vertexCount: 0,
      indexCount: 0,
    };

    const maxVertices = (points.length - 1) * 8;
    const maxIndices = (points.length - 1) * 6;

    const vertexArray = new Float32Array(maxVertices);
    const indexArray = new Uint16Array(maxIndices);

    // const halfThickness = s.strokeWidth * (s instanceof Scribble ? 0.005 : 0.035);
    const halfThickness = s.strokeWidth/2;

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

    let v = 0;
    let i = 0;

    // Then we use these normals to build quads:
    // (Build vertices and indices with smoothed normals)
    for (let p = 1; p < points.length; p++) {
      const prev = points[p - 1];
      const curr = points[p];

      // normalA affects how the tail of the quad is angled
      // normalB affects how the head of the quad is angled
      const normalA = normals[p - 1];
      const normalB = normals[p];

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

      // Standard 2-triangle quad built from the 4 verts above.
      const vi = (v - 8) / 2;
      if (!Number.isFinite(vi)) continue;
      indexArray[i++] = vi;
      indexArray[i++] = vi + 1;
      indexArray[i++] = vi + 2;
      indexArray[i++] = vi + 1;
      indexArray[i++] = vi + 2;
      indexArray[i++] = vi + 3;
    }

    return {
      vertexData: vertexArray,
      indexData: indexArray,
      vertexCount: v,
      indexCount: i,
    };
  }

  generateLine(line: Line): {
    vertexData: Float32Array;
    indexData: Uint16Array;
    vertexCount: number;
    indexCount: number;
  } {
    const halfThickness = line.strokeWidth / 2;
  
    const startX = line.x1;
    const startY = line.y1;
    const endX = line.x2;
    const endY = line.y2;
  
    const dirX = endX - startX;
    const dirY = endY - startY;
    const length = Math.sqrt(dirX * dirX + dirY * dirY);
  
    const normalX = -(dirY / length) * halfThickness;
    const normalY = (dirX / length) * halfThickness;
  
    const vertexData = new Float32Array([
      startX - normalX, startY - normalY, // Bottom-left
      endX - normalX, endY - normalY,     // Bottom-right
      startX + normalX, startY + normalY, // Top-left
      startX + normalX, startY + normalY, // Top-left (Duplicate)
      endX - normalX, endY - normalY,     // Bottom-right (Duplicate)
      endX + normalX, endY + normalY      // Top-right
    ]);
  
    const indexData = new Uint16Array([
      0, 1, 2,
      3, 4, 5
    ]);
  
    return {
      vertexData,
      indexData,
      vertexCount: 6, // 6 vertices * 2 floats
      indexCount: 6
    };
  }
}