import { mat4, vec4 } from "gl-matrix";

export class CaretManager {
    private device: GPUDevice;
    private uniformBuffer: GPUBuffer;
    private maxCarets = 256;
    private floatArray: Float32Array;
    private currentCount = 0;
  
    constructor(device: GPUDevice, buffer: GPUBuffer) {
      this.device = device;
      this.uniformBuffer = buffer;
      this.floatArray = new Float32Array(this.maxCarets * 8);
    }
  
    public update(carets: {
        x: number;
        y: number;
        height: number;
        thickness: number;
        color: { r: number; g: number; b: number; a: number };
        localMatrix: mat4;
        worldMatrix: mat4;
      }[]) {
        this.currentCount = carets.length;
      
        for (let i = 0; i < carets.length; i++) {
          const c = carets[i];
          const o = i * 8;
      
          // Step 1: Combine world * local
          const modelMatrix = mat4.create();
          mat4.multiply(modelMatrix, c.worldMatrix, c.localMatrix);
      
          // Step 2: Transform caret position
          const local = vec4.fromValues(c.x, c.y, 0, 1);
          vec4.transformMat4(local, local, modelMatrix); // result in local[0], local[1]
      
          // Step 3: Fill data
          this.floatArray[o + 0] = local[0];              // world X
          this.floatArray[o + 1] = local[1];              // world Y
          this.floatArray[o + 2] = c.height;
          this.floatArray[o + 3] = c.thickness;
          this.floatArray[o + 4] = c.color.r;
          this.floatArray[o + 5] = c.color.g;
          this.floatArray[o + 6] = c.color.b;
          this.floatArray[o + 7] = c.color.a;
        }
      
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.floatArray);
      }
      
      public getCount(): number {
        return this.currentCount;
      }
  }