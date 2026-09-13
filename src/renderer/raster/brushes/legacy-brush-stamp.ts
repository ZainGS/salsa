/**
 * LegacyBrushStamp — the ORIGINAL single-dab compute brush, extracted verbatim from
 * RasterTextureManager (audit B1).
 *
 * ⚠ LEGACY FALLBACK ONLY. The live painting path is RasterPaintEngine + BrushStampPipeline
 * (src/renderer/raster/brushes/brush-stamp-pipeline.ts); this shader is reached solely through
 * webgpu-renderer.dispatchGpuBrush ← RasterDrawingService.stampAtLegacy, which fires only when the
 * paint engine hasn't been initialized (uploadRasterCanvas-only flows). Do not grow this — if the
 * fallback is ever proven dead in the host, delete this module together with dispatchGpuBrush and
 * stampAtLegacy.
 */

export class LegacyBrushStamp {
  private device: GPUDevice;
  private brushComputePipeline?: GPUComputePipeline;
  private brushBindGroupLayout?: GPUBindGroupLayout;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  private ensurePipeline() {
    if (this.brushComputePipeline) return;
    const code = `
    @group(0) @binding(0) var srcTex: texture_2d<f32>;
    @group(0) @binding(1) var dstTex: texture_storage_2d<rgba8unorm, write>;
    @group(0) @binding(2) var samp: sampler;
    // params: minX, minY, radius, modeFlag
    // modeFlag: 0 = paint, 1 = erase-fade, 2 = erase-clear, 3 = erase-hard (sharper falloff)
    @group(0) @binding(3) var<uniform> params: vec4<f32>;
    @group(0) @binding(4) var<uniform> color: vec4<f32>;
    // aspect: aspectX, aspectY for correcting oval brushes
    @group(0) @binding(5) var<uniform> aspect: vec2<f32>;

    fn blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
      let outA = src.a + dst.a * (1.0 - src.a);
      if (outA <= 0.0) { return vec4<f32>(0.0); }
      let outRGB = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / outA;
      return vec4<f32>(outRGB, outA);
    }

    @compute @workgroup_size(8,8)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let local_ix = i32(gid.x);
      let local_iy = i32(gid.y);
      let ox = i32(params.x);
      let oy = i32(params.y);
      let ix = ox + local_ix;
      let iy = oy + local_iy;
      let px = f32(ix) + 0.5;
      let py = f32(iy) + 0.5;
      let r = params.z;
      let mode = i32(params.w);
      // Use actual center from the bounding box plus radius.
      // This is correct for the legacy path since the bounding box is always
      // computed as floor(cx - radius) and the dab is always fully within bounds.
      let cx = f32(params.x) + r;
      let cy = f32(params.y) + r;
      // Apply aspect ratio correction to make circular brushes
      let dx = (px - cx) * aspect.x;
      let dy = (py - cy) * aspect.y;
      let d = sqrt(dx*dx + dy*dy);
      if (d <= r) {
        let t = 1.0 - smoothstep(0.0, r, d);
        let brushAlpha = color.a * t;
        let existing = textureLoad(srcTex, vec2<i32>(ix, iy), 0);
        var out: vec4<f32> = existing;
        if (mode == 0) {
          // paint
          let brushCol = vec4<f32>(color.rgb, brushAlpha);
          out = blend(existing, brushCol);
        } else if (mode == 1) {
          // erase (fade): reduce alpha proportionally
          let newA = existing.a * (1.0 - brushAlpha);
          var newRGB = existing.rgb;
          if (existing.a > 0.0) {
            newRGB = existing.rgb * (newA / existing.a);
          } else {
            newRGB = vec3<f32>(1.0);
          }
          out = vec4<f32>(newRGB, newA);
        } else if (mode == 2) {
          // clear (hard erase) - make fully transparent where brush applies
          let newA = existing.a * (1.0 - ceil(brushAlpha));
          var newRGB = existing.rgb;
          if (newA <= 0.0) {
            // eraser color
            newRGB = vec3<f32>(1.0);
          } else if (existing.a > 0.0) {
            newRGB = existing.rgb * (newA / existing.a);
          }
          out = vec4<f32>(newRGB, newA);
        } else if (mode == 3) {
          // erase-hard: sharper falloff but still allows soft edges if pressure low
          // use a power curve on the t factor to make the brush edge crisper
          let hardT = pow(t, 3.0); // cubic falloff -> sharper edge
          let brushAlphaHard = color.a * hardT;
          let newA_h = existing.a * (1.0 - brushAlphaHard);
          var newRGB_h = existing.rgb;
          if (newA_h <= 0.0) {
            newRGB_h = vec3<f32>(0.0);
          } else if (existing.a > 0.0) {
            newRGB_h = existing.rgb * (newA_h / existing.a);
          }
          out = vec4<f32>(newRGB_h, newA_h);
        }
        textureStore(dstTex, vec2<i32>(ix, iy), out);
      }
    }
    `;

    this.brushBindGroupLayout = this.device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
    ]});

    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.brushBindGroupLayout]});
    this.brushComputePipeline = this.device.createComputePipeline({ layout: pipelineLayout, compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' } });
  }

  /** Dispatch one brush dab into `tex`. cx,cy in texel coords; color is [r,g,b,a] in 0..1.
   *  texW/texH = the texture's dimensions; canvasWidth/Height = the world quad it stretches over
   *  (for the oval-correction aspect). */
  public dispatch(
    tex: GPUTexture,
    texW: number,
    texH: number,
    cx: number,
    cy: number,
    radius: number,
    colorArr: [number, number, number, number],
    mode: 'paint' | 'erase' | 'clear' = 'paint',
    eraseHard?: boolean,
    canvasWidth?: number,
    canvasHeight?: number
  ) {
    this.ensurePipeline();
    const device = this.device;

    // Create a temporary texture for reading (ping-pong approach)
    const tempTex = device.createTexture({
      size: [texW, texH],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    // Copy current texture to temp texture
    const copyEncoder = device.createCommandEncoder();
    copyEncoder.copyTextureToTexture(
      { texture: tex },
      { texture: tempTex },
      { width: texW, height: texH }
    );
    device.queue.submit([copyEncoder.finish()]);

    // Now use tempTex as source, tex as destination
    const minX = Math.max(0, Math.floor(cx - radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxX = Math.min(texW - 1, Math.ceil(cx + radius));
    const maxY = Math.min(texH - 1, Math.ceil(cy + radius));
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw <= 0 || bh <= 0) {
      tempTex.destroy();
      return;
    }

    let modeFlag = 0;
    if (mode === 'erase') modeFlag = eraseHard ? 3 : 1;
    else if (mode === 'clear') modeFlag = 2;

    const params = new Float32Array([minX, minY, radius, modeFlag]);
    const paramBuf = device.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(paramBuf, 0, params);

    const color = new Float32Array(colorArr);
    const colorBuf = device.createBuffer({ size: color.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(colorBuf, 0, color);

    // Calculate aspect ratio correction
    const worldQuadW = canvasWidth || 2.0;
    const worldQuadH = canvasHeight || 2.0;

    // Calculate the aspect ratio mismatch
    const worldAspect = worldQuadW / worldQuadH;  // 2.0/2.0 = 1.0 (square)
    const texAspect = texW / texH;                 // 1669/991 = 1.684 (wide)
    const mismatch = texAspect / worldAspect;      // 1.684

    // To draw circles on screen, we need ellipses in texture (taller to compensate
    // for the squeeze). Shader multiplies distance by aspect — use reciprocal so
    // vertical distances are *reduced*, making the brush extend further vertically.
    const aspectData = new Float32Array([1.0, 1.0 / mismatch ]);
    const aspectBuf = device.createBuffer({
      size: aspectData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    device.queue.writeBuffer(aspectBuf, 0, aspectData);

    const bind = device.createBindGroup({
      layout: this.brushBindGroupLayout!,
      entries: [
        { binding: 0, resource: tempTex.createView() }, // Read from temp
        { binding: 1, resource: tex.createView() },     // Write to original
        { binding: 2, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
        { binding: 3, resource: { buffer: paramBuf } },
        { binding: 4, resource: { buffer: colorBuf } },
        { binding: 5, resource: { buffer: aspectBuf } }
      ]
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.brushComputePipeline!);
    pass.setBindGroup(0, bind);

    const wgSize = 8;
    const workX = Math.ceil(bw / wgSize);
    const workY = Math.ceil(bh / wgSize);
    pass.dispatchWorkgroups(workX, workY);
    pass.end();
    device.queue.submit([enc.finish()]);

    paramBuf.destroy();
    colorBuf.destroy();
    aspectBuf.destroy();
    tempTex.destroy();
  }
}
