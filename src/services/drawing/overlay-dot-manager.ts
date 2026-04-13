/**
 * OverlayDotManager — uploads connection-port indicator dots as instanced quads.
 *
 * Each dot has the same 32-byte layout:
 *   position : vec2<f32>  (clip-space center)
 *   radius   : f32        (world-space radius)
 *   _pad     : f32
 *   color    : vec4<f32>  (RGBA)
 */

import { mat4, vec4 } from 'gl-matrix';

export interface DotInstance {
  /** World-space position. */
  worldX: number;
  worldY: number;
  /** World-space radius. */
  radius: number;
  /** RGBA color (0-1). */
  color: { r: number; g: number; b: number; a: number };
}

export class OverlayDotManager {
  private device: GPUDevice;
  private buffer: GPUBuffer;
  private maxDots = 256;
  private floatArray: Float32Array<ArrayBuffer>;
  private currentCount = 0;

  constructor(device: GPUDevice, buffer: GPUBuffer) {
    this.device = device;
    this.buffer = buffer;
    this.floatArray = new Float32Array(this.maxDots * 8) as Float32Array<ArrayBuffer>;
  }

  /**
   * Upload dot instances.  `worldMatrix` is the global camera transform.
   */
  public update(dots: DotInstance[], worldMatrix: mat4): void {
    this.currentCount = Math.min(dots.length, this.maxDots);

    for (let i = 0; i < this.currentCount; i++) {
      const d = dots[i];
      const o = i * 8;

      // Transform world position to clip space
      const pos = vec4.fromValues(d.worldX, d.worldY, 0, 1);
      vec4.transformMat4(pos, pos, worldMatrix);

      this.floatArray[o + 0] = pos[0]; // clip X
      this.floatArray[o + 1] = pos[1]; // clip Y
      this.floatArray[o + 2] = d.radius;
      this.floatArray[o + 3] = 0;      // padding
      this.floatArray[o + 4] = d.color.r;
      this.floatArray[o + 5] = d.color.g;
      this.floatArray[o + 6] = d.color.b;
      this.floatArray[o + 7] = d.color.a;
    }

    this.device.queue.writeBuffer(this.buffer, 0, this.floatArray);
  }

  public getCount(): number {
    return this.currentCount;
  }
}
