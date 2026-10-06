// src/renderer/utils/handles.ts
import { mat4, vec3, vec4 } from "gl-matrix";
import type { ScalingSide } from "./interaction-types";
import type { Shape } from "../../scene-graph/shapes/base/shape";
import type { InteractionService } from "../../services/interaction-service";
import { HandleSide, Vec2 } from "../../types/interaction";

export const HIT = {
  rotateHandleOffset: 0.035,
  rotateHandleThreshold: 0.01625,
  scaleHandleThreshold: 0.035,
} as const;

/** A handle threshold scaled for touch (TOUCH-8). The enlarged radius is capped at a third of the shape's smaller
 *  side so a small shape's handles never swallow its whole body (it must still be draggable by a finger), but it
 *  never drops below the mouse threshold. hitScale 1 returns the mouse threshold unchanged. */
export function touchThreshold(base: number, hitScale: number, shape: { width: number; height: number }): number {
  if (!(hitScale > 1)) return base;
  const cap = Math.min(Math.abs(shape.width), Math.abs(shape.height)) / 3;
  return Math.max(base, Math.min(base * hitScale, Number.isFinite(cap) ? cap : base));
}

const dist = (a: [number, number], b: [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Convert canvas pixel coords to world space.
 * Kept here so utils can be used outside the renderer if needed.
 */
export function canvasPxToWorld(
  xCanvas: number,
  yCanvas: number,
  canvas: HTMLCanvasElement,
  interaction: InteractionService
): Vec2 {
  // (NDC-SPACE CLICK)
  // Convert screen space mouse point (x, y) to NDC (-1 to 1).
  // Inputs are CSS pixels (offsetX/clientX-rect), so normalize by the CSS size — dividing by the BACKING size
  // (canvas.width) shifts every click toward the top-left by cssSize/backingSize whenever devicePixelRatio ≠ 1
  // or the canvas is CSS-scaled (shapes commit offset from the cursor; hit-tests err identically so selection
  // "works" on large shapes and hides it). Falls back to the backing size when CSS size is unavailable (tests).
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  const ndcX = (xCanvas / cssW) * 2 - 1;
  const ndcY = (yCanvas / cssH) * -2 + 1;
  // (MODEL-SPACE WORLD MATRIX) [Pre-Transformation "Model" World Space]
  // Get the inverse of the world matrix
  const invWorld = mat4.invert(mat4.create(), interaction.getWorldMatrix())!;
  // (MODEL-SPACE CLICK) [Pre-Transformation "Model" World Space]
  // Convert the NDC mouse point to world space using the inverse of the world matrix
  const v = vec3.fromValues(ndcX, ndcY, 0);
  vec3.transformMat4(v, v, invWorld);
  // Return the transformed coordinates (in original, untransformed world space)
  // You could say this is the same as "pre-transformed world space", because
  // the point we output has not been affected by world transformations due to the inverse
  // matrix. It's like we went back in time and clicked the OG spot. This "space" lets us more 
  // efficiently handle hit detection. 
  return [v[0], v[1]];
}

/** Returns true if worldMouse is within the rotation handle threshold of any corner. */
export function isNearRotationHandle(
  shape: Shape,
  worldMouse: Vec2,
  /** TOUCH-8: hit-radius multiplier (2 under a finger; 1 = the mouse threshold). */
  hitScale = 1,
): boolean {
  // Optional: keep Sections unrotatable (matches your old behavior)
  if (shape.getType && shape.getType() === "Section") return false;

  // Convert world mouse -> shape local space
  const invLocal = shape.getInverseLocalMatrix(); // you already have this method
  const m = vec4.fromValues(worldMouse[0], worldMouse[1], 0, 1);
  vec4.transformMat4(m, m, invLocal); // m is now local coordinates

  // Local-space corners of the bounding box
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  const corners: [number, number][] = [
    [-hw, -hh], // BL
    [ hw, -hh], // BR
    [ hw,  hh], // TR
    [-hw,  hh], // TL
  ];

  // Offset the handles outward a bit (still in local units)
  corners[0][0] -= HIT.rotateHandleOffset; corners[0][1] -= HIT.rotateHandleOffset;
  corners[1][0] += HIT.rotateHandleOffset; corners[1][1] -= HIT.rotateHandleOffset;
  corners[2][0] += HIT.rotateHandleOffset; corners[2][1] += HIT.rotateHandleOffset;
  corners[3][0] -= HIT.rotateHandleOffset; corners[3][1] += HIT.rotateHandleOffset;

  // Local-space distance check keeps size consistent regardless of zoom
  for (const [cx, cy] of corners) {
    const dx = m[0] - cx;
    const dy = m[1] - cy;
    if (Math.hypot(dx, dy) <= touchThreshold(HIT.rotateHandleThreshold, hitScale, shape)) return true;
  }
  return false;
}

/** Returns which scaling handle is closest (within threshold) or null. */
export function getScalingSide(
  shape: Shape,
  worldMouse: Vec2,
  /** TOUCH-8: hit-radius multiplier (2 under a finger; 1 = the mouse threshold). */
  hitScale = 1,
): HandleSide | null {
  // mouse: world -> local
  const inv = shape.getInverseLocalMatrix();
  const lm = vec4.fromValues(worldMouse[0], worldMouse[1], 0, 1);
  vec4.transformMat4(lm, lm, inv);
  const mouseLocal: [number, number] = [lm[0], lm[1]];

  // local-space box corners (unrotated)
  const c = shape.getLocalBoundingBoxCorners(); // BL, BR, TR, TL in local
  const leftMid: [number, number]   = [(c[0][0] + c[3][0]) / 2, (c[0][1] + c[3][1]) / 2];
  const rightMid: [number, number]  = [(c[1][0] + c[2][0]) / 2, (c[1][1] + c[2][1]) / 2];
  const bottomMid: [number, number] = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
  const topMid: [number, number]    = [(c[2][0] + c[3][0]) / 2, (c[2][1] + c[3][1]) / 2];

  const named: Record<ScalingSide, [number, number]> = {
    left: leftMid,
    right: rightMid,
    top: topMid,
    bottom: bottomMid,
    topLeft:  [c[3][0], c[3][1]],
    topRight: [c[2][0], c[2][1]],
    bottomLeft:  [c[0][0], c[0][1]],
    bottomRight: [c[1][0], c[1][1]],
  };

  // Slightly “fatten” edge hit areas using local width/height
  const w = shape.width, h = shape.height;
  const scaleEdge = (p: [number, number], sx: number, sy: number): [number, number] =>
    [p[0] / sx, p[1] / sy];

  const dists: Record<ScalingSide, number> = {
    left:       dist(scaleEdge(mouseLocal, 1.075, h * 14), scaleEdge(leftMid, 1.075, h * 14)),
    right:      dist(scaleEdge(mouseLocal, 1.075, h * 14), scaleEdge(rightMid, 1.075, h * 14)),
    top:        dist(scaleEdge(mouseLocal, w * 14, 1.075), scaleEdge(topMid, w * 14, 1.075)),
    bottom:     dist(scaleEdge(mouseLocal, w * 14, 1.075), scaleEdge(bottomMid, w * 14, 1.075)),
    topLeft:    dist(mouseLocal, named.topLeft),
    topRight:   dist(mouseLocal, named.topRight),
    bottomLeft: dist(mouseLocal, named.bottomLeft),
    bottomRight:dist(mouseLocal, named.bottomRight),
  };

  const closest = (Object.keys(dists) as ScalingSide[])
    .reduce((a, b) => dists[a] < dists[b] ? a : b);

  return dists[closest] <= touchThreshold(HIT.scaleHandleThreshold, hitScale, shape) ? closest : null;
}