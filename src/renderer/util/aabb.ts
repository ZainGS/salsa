// src/renderer/util/aabb.ts
import { mat4, vec4 } from "gl-matrix";
import { Node } from "../../scene-graph/shapes/base/node";
import { Shape } from "../../scene-graph/shapes/base/shape";
import { Group } from "../../scene-graph/shapes/base/group";
import { Vec2 } from "../../types/interaction";

export type AABB = { minX: number; minY: number; maxX: number; maxY: number };

export function aabbOverlaps(a: AABB, b: AABB): boolean {
  // separated-axis test for axis-aligned boxes
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

export function polyToAABB(poly: Vec2[]): AABB {
  let minX =  Infinity, minY =  Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** World-space AABB for any Node.
 *  Shapes: from their world bbox polygon.
 *  Groups: union of children (shapes only).
 *  Others: null.
 */
export function getWorldAABB(node: Node): AABB | null {
  if (node instanceof Shape) {
    // true => refresh cached polygon if your Shape supports it
    const poly = node.getWorldSpaceBoundingBoxPolygon?.(true) as Vec2[] | undefined;
    return poly && poly.length > 0 ? polyToAABB(poly) : null;
  }
  if (node instanceof Group) {
    let agg: AABB | null = null;
    node.forEachDeep(n => {
      if (n instanceof Shape) {
        const bb = getWorldAABB(n);
        if (!bb) return;
        agg = agg
          ? { minX: Math.min(agg.minX, bb.minX),
              minY: Math.min(agg.minY, bb.minY),
              maxX: Math.max(agg.maxX, bb.maxX),
              maxY: Math.max(agg.maxY, bb.maxY) }
          : bb;
      }
    });
    return agg;
  }
  return null;
}

/** Viewport AABB in world space (uses the inverse world matrix). */
export function viewportAABB(canvas: HTMLCanvasElement, worldMatrix: mat4): AABB {
  const inv = mat4.create();
  if (!mat4.invert(inv, worldMatrix)) {
    // Fallback to identity if matrix is singular (extreme zoom, degenerate transform)
    mat4.identity(inv);
  }
  const toWorld = (xPx: number, yPx: number): Vec2 => {
    const ndcX = (xPx / canvas.width) * 2 - 1;
    const ndcY = (yPx / canvas.height) * -2 + 1;
    const v = vec4.fromValues(ndcX, ndcY, 0, 1);
    vec4.transformMat4(v, v, inv);
    return [v[0], v[1]];
  };
  const poly: Vec2[] = [
    toWorld(0, 0),
    toWorld(canvas.width, 0),
    toWorld(canvas.width, canvas.height),
    toWorld(0, canvas.height),
  ];
  return polyToAABB(poly);
}