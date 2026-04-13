/**
 * SelectionHighlightManager — Collects SDF-text selection rectangles and uploads
 * them as instanced colored quads.  Reuses the caret pipeline (same struct layout).
 *
 * Each highlight has the same CaretUniform layout:
 *   position : vec2<f32>  (world-space top-left of the rect)
 *   height   : f32        (world-space height, used as the Y extent)
 *   thickness : f32       (world-space width, repurposed as X extent)
 *   color    : vec4<f32>  (RGBA)
 *
 * Total: 8 floats (32 bytes) per instance — identical to CaretManager.
 */

import { mat4, vec4 } from 'gl-matrix';

export class SelectionHighlightManager {
  private device: GPUDevice;
  private buffer: GPUBuffer;
  private maxRects = 256;
  private floatArray: Float32Array<ArrayBuffer>;
  private currentCount = 0;

  constructor(device: GPUDevice, buffer: GPUBuffer) {
    this.device = device;
    this.buffer = buffer;
    this.floatArray = new Float32Array(this.maxRects * 8);
  }

  /**
   * Upload selection highlight rects.
   * @param rects Array of local-space rects + the SDF text node's matrices.
   */
  public update(rects: {
    x: number;
    y: number;
    width: number;
    height: number;
    color: { r: number; g: number; b: number; a: number };
    localMatrix: mat4;
    worldMatrix: mat4;
  }[]): void {
    this.currentCount = Math.min(rects.length, this.maxRects);

    for (let i = 0; i < this.currentCount; i++) {
      const r = rects[i];
      const o = i * 8;

      // Combine world × local
      const modelMatrix = mat4.create();
      mat4.multiply(modelMatrix, r.worldMatrix, r.localMatrix);

      // Transform the rect's top-left corner into clip / world space
      const local = vec4.fromValues(r.x, r.y, 0, 1);
      vec4.transformMat4(local, local, modelMatrix);

      this.floatArray[o + 0] = local[0]; // world X
      this.floatArray[o + 1] = local[1]; // world Y
      this.floatArray[o + 2] = r.height; // height (Y extent)
      this.floatArray[o + 3] = r.width;  // width  (repurpose thickness)
      this.floatArray[o + 4] = r.color.r;
      this.floatArray[o + 5] = r.color.g;
      this.floatArray[o + 6] = r.color.b;
      this.floatArray[o + 7] = r.color.a;
    }

    this.device.queue.writeBuffer(this.buffer, 0, this.floatArray);
  }

  public getCount(): number {
    return this.currentCount;
  }
}
