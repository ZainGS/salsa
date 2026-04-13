/**
 * OnionSkinRenderer — GPU compute shader that composites ghost frames
 * for onion skinning (animation workflow).
 *
 * Renders previous/next frames as semi-transparent tinted overlays on top
 * of the current composited frame, so animators can see adjacent drawings.
 */

export interface OnionFrame {
  texture: GPUTexture;
  opacity: number;
  tint: [number, number, number]; // RGB 0-1
}

export class OnionSkinRenderer {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline | null = null;
  private bgl: GPUBindGroupLayout | null = null;
  private paramBuf: GPUBuffer;

  constructor(device: GPUDevice) {
    this.device = device;
    this.paramBuf = device.createBuffer({
      size: 16, // tintR, tintG, tintB, opacity
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Composite one onion frame onto the output texture.
   * Call this once per ghost frame (previous and next frames).
   *
   * The onion frame is drawn with a tint color and reduced opacity,
   * alpha-blended on top of whatever's already in the output.
   *
   * NOTE: Because storage textures are write-only, we use a read texture +
   * write texture ping-pong pattern. The caller is responsible for copying
   * the current accumulated image to `readTex` before each call.
   */
  public composite(
    readTex: GPUTexture,   // current accumulated image (read)
    writeTex: GPUTexture,  // output (write)
    onionTex: GPUTexture,  // the ghost frame texture (read)
    opacity: number,
    tint: [number, number, number],
  ): void {
    this.ensurePipeline();

    // Upload params
    const data = new Float32Array([tint[0], tint[1], tint[2], opacity]);
    this.device.queue.writeBuffer(this.paramBuf, 0, data);

    const bg = this.device.createBindGroup({
      layout: this.bgl!,
      entries: [
        { binding: 0, resource: readTex.createView() },
        { binding: 1, resource: onionTex.createView() },
        { binding: 2, resource: writeTex.createView() },
        { binding: 3, resource: { buffer: this.paramBuf } },
      ],
    });

    const w = writeTex.width;
    const h = writeTex.height;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  public destroy(): void {
    this.paramBuf.destroy();
  }

  private ensurePipeline(): void {
    if (this.pipeline) return;

    const code = /* wgsl */ `
      // Read the current accumulated composite
      @group(0) @binding(0) var accumTex: texture_2d<f32>;
      // The onion skin frame
      @group(0) @binding(1) var onionTex: texture_2d<f32>;
      // Output
      @group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;
      // tintR, tintG, tintB, opacity
      @group(0) @binding(3) var<uniform> params: vec4<f32>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(accumTex);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }

        let coord = vec2<i32>(i32(gid.x), i32(gid.y));
        let accum = textureLoad(accumTex, coord, 0);
        let onion = textureLoad(onionTex, coord, 0);

        let tint = params.xyz;
        let opacity = params.w;

        // Apply tint to the onion frame: multiply RGB by tint, scale alpha
        let onionAlpha = onion.a * opacity;

        if (onionAlpha <= 0.001) {
          // No onion pixel here — pass through accumulated
          textureStore(output, coord, accum);
          return;
        }

        // Tinted onion color
        let onionRgb = onion.rgb * tint;

        // Alpha-over composite: onion on top of accumulated
        let outA = onionAlpha + accum.a * (1.0 - onionAlpha);
        var outRgb = vec3<f32>(0.0);
        if (outA > 0.001) {
          outRgb = (onionRgb * onionAlpha + accum.rgb * accum.a * (1.0 - onionAlpha)) / outA;
        }

        textureStore(output, coord, vec4<f32>(outRgb, outA));
      }
    `;

    this.bgl = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgl] }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }
}
