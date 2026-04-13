/**
 * BrushStampPipeline — the GPU compute shader that stamps ONE dab onto a texture.
 *
 * This replaces the monolithic brush shader that was inlined in RasterTextureManager.
 * It now supports:
 *  • Tip-texture sampling (parametric or image tips via r8unorm texture)
 *  • Per-dab size, opacity, rotation, flow (set via uniforms per dispatch)
 *  • Blend modes: normal paint, erase-fade, erase-clear, erase-hard
 *  • Aspect-ratio correction for non-square canvases
 *
 * One pipeline is created once and reused for every dab — only the uniforms change.
 */

export interface StampParams {
  /** Center X in texel coords. */
  cx: number;
  /** Center Y in texel coords. */
  cy: number;
  /** Radius in texels after dynamics are applied. */
  radius: number;
  /** RGBA color in 0-1 range. Alpha = per-dab opacity (flow × dynamics). */
  color: [number, number, number, number];
  /** Tip rotation in radians. */
  rotation: number;
  /** 0 = paint, 1 = erase-fade, 2 = erase-clear, 3 = erase-hard, 4 = multiply, 5 = screen, 6 = overlay. */
  mode: number;
  /** Aspect ratio correction [x, y]. Usually [1, mismatch]. */
  aspect: [number, number];
  /** Tip texture (r8unorm) — the brush shape mask. */
  tipTexture: GPUTexture;
  /** When true, paint only where existing alpha > 0 (preserves transparency). */
  lockTransparency?: boolean;
  /** Selection mask texture (r32float). If provided, paint is constrained to selected region. */
  selectionMask?: GPUTexture | null;

  // ── Canvas grain (paper texture) ──
  /** Grain texture (r8unorm, tileable). null = no grain. */
  grainTexture?: GPUTexture | null;
  /** Inverse scale factors for tiling: grainUV = texelCoord * invScale. */
  grainInvScale?: [number, number];
  /** How strongly grain modulates brush alpha (0 = none, 1 = full). */
  grainStrength?: number;

  // ── Dual brush (shape × texture) ──
  /** Dual brush texture (r8unorm, tileable). null = no dual brush. */
  dualBrushTexture?: GPUTexture | null;
  /** Dual brush params: [scale, strength, blendOp (0=multiply,1=subtract,2=minimum), tileMode (0=dab-local,1=canvas-tiling)]. */
  dualBrushScale?: number;
  dualBrushStrength?: number;
  dualBrushBlendOp?: number;
  dualBrushTileMode?: number; // 0 = dab-local, 1 = canvas-tiling
  dualBrushRotation?: number; // per-dab random rotation for organic variation

  /** When true, dab is stamped into stroke accumulation layer using max-alpha (wet-stroke mode). */
  wetStroke?: boolean;
}

export class BrushStampPipeline {
  private device: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bindGroupLayout!: GPUBindGroupLayout;

  // Reusable uniform buffers (avoid per-dab allocation)
  private paramBuf: GPUBuffer;
  private colorBuf: GPUBuffer;
  private aspectBuf: GPUBuffer;

  // Pre-allocated typed arrays to avoid GC pressure (rewritten every dab)
  private paramData = new Float32Array(8);
  private colorData = new Float32Array(4);
  private aspectData = new Float32Array(2);

  // Persistent ping-pong texture (avoids alloc+destroy per dab)
  private pingTex: GPUTexture | null = null;
  private pingTexW = 0;
  private pingTexH = 0;

  // Cached bind group + the texture pair it was built for
  private cachedBindGroup: GPUBindGroup | null = null;
  private cachedSrcTex: GPUTexture | null = null;
  private cachedDstTex: GPUTexture | null = null;
  private cachedTipTex: GPUTexture | null = null;

  // Sampler for the tip texture
  private tipSampler: GPUSampler;

  // Dummy 1x1 mask (r32float = 1.0) for when there's no selection
  private dummyMaskTex: GPUTexture;

  // Cached selection mask reference for bind group invalidation
  private cachedMaskTex: GPUTexture | null = null;

  // Canvas grain (paper texture) support
  private grainBuf: GPUBuffer;
  private grainData = new Float32Array(4); // invScaleX, invScaleY, strength, pad
  private grainSampler: GPUSampler;
  private dummyGrainTex: GPUTexture;
  private cachedGrainTex: GPUTexture | null = null;

  // Dual brush (shape × texture) support
  private dualBrushBuf: GPUBuffer;
  private dualBrushData = new Float32Array(8); // scale, strength, blendOp, tileMode, rotation, pad, pad, pad
  private dummyDualTex: GPUTexture;
  private cachedDualTex: GPUTexture | null = null;

  // ── Wet-stroke (indirect painting) state ──
  // Prevents opacity buildup when painting over the same area within a single stroke.
  // strokeBaseTex  = snapshot of canvas at beginStroke (never written during stroke)
  // strokeAccumTex = transparent layer that accumulates dab coverage via max-alpha
  // After each dab: output = composite(strokeBaseTex, strokeAccumTex)
  private strokeBaseTex: GPUTexture | null = null;
  private strokeAccumTex: GPUTexture | null = null;
  private strokeTexW = 0;
  private strokeTexH = 0;
  private strokeActive = false;

  // Composite pipeline: merges stroke accum layer onto stroke base
  private compositePipeline!: GPUComputePipeline;
  private compositeBGL!: GPUBindGroupLayout;

  // Wet edges pipeline: darkens alpha edges on stroke accum layer
  private wetEdgesPipeline: GPUComputePipeline | null = null;
  private wetEdgesBGL: GPUBindGroupLayout | null = null;
  private wetEdgesParamBuf: GPUBuffer;
  private wetEdgesParamData = new Float32Array(4); // edgeDarkness, edgeWidth, strength, pad

  constructor(device: GPUDevice) {
    this.device = device;

    // Pre-allocate uniform buffers (small, rewritten every dab)
    this.paramBuf = device.createBuffer({
      size: 32, // 8 floats: cx, cy, radius, mode, rotation, pad, pad, pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.colorBuf = device.createBuffer({
      size: 16, // 4 floats: r, g, b, a
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.aspectBuf = device.createBuffer({
      size: 8, // 2 floats: aspectX, aspectY
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.tipSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // ── Grain uniform buffer (invScaleX, invScaleY, strength, pad) ──
    this.grainBuf = device.createBuffer({
      size: 16, // 4 floats
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Repeat sampler for tiling grain texture across the canvas
    this.grainSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    // 1x1 r8unorm white texture (grain value 1.0 = fully opaque, no modulation)
    this.dummyGrainTex = device.createTexture({
      size: [1, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.dummyGrainTex },
      new Uint8Array([255]),
      { bytesPerRow: 1 },
      { width: 1, height: 1 },
    );

    // ── Dual brush uniform buffer (scale, strength, blendOp, tileMode, rotation, ...) ──
    this.dualBrushBuf = device.createBuffer({
      size: 32, // 8 floats
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 1x1 r8unorm white texture (dual brush value 1.0 = no modulation)
    this.dummyDualTex = device.createTexture({
      size: [1, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.dummyDualTex },
      new Uint8Array([255]),
      { bytesPerRow: 1 },
      { width: 1, height: 1 },
    );

    // Create a 1x1 r32float texture filled with 1.0 (fully selected / no constraint)
    this.dummyMaskTex = device.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.dummyMaskTex },
      new Float32Array([1.0]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    this.buildPipeline();
    this.buildCompositePipeline();

    // Wet edges uniform buffer
    this.wetEdgesParamBuf = device.createBuffer({
      size: 16, // 4 floats
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ── Stroke lifecycle (wet-stroke) ─────────────────────────────────

  /**
   * Call at the start of a stroke. Snapshots the canvas into strokeBaseTex
   * and creates a transparent strokeAccumTex. All subsequent stampWithPingPong
   * calls will use indirect painting until endStroke().
   */
  public beginStroke(texture: GPUTexture): void {
    const w = texture.width;
    const h = texture.height;

    // Ensure stroke textures match dimensions
    if (!this.strokeBaseTex || this.strokeTexW !== w || this.strokeTexH !== h) {
      this.strokeBaseTex?.destroy();
      this.strokeAccumTex?.destroy();
      this.strokeBaseTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      this.strokeAccumTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
               GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      this.strokeTexW = w;
      this.strokeTexH = h;
    }

    // Snapshot current canvas → strokeBaseTex
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture }, { texture: this.strokeBaseTex! }, { width: w, height: h });
    this.device.queue.submit([enc.finish()]);

    // Clear strokeAccumTex to transparent black
    this.clearTexture(this.strokeAccumTex!, w, h);

    this.strokeActive = true;
    this.cachedBindGroup = null; // invalidate — textures changed
  }

  /**
   * Call at the end of a stroke. Optionally applies wet edges to the stroke
   * accumulation layer, then flattens it onto the canvas.
   */
  public endStroke(wetEdges?: { edgeDarkness: number; edgeWidth: number; strength: number }): void {
    // Apply wet edges post-process if requested and we have a valid accum texture
    if (wetEdges && wetEdges.strength > 0 && this.strokeAccumTex && this.strokeActive) {
      this.applyWetEdges(this.strokeAccumTex, wetEdges);
    }
    this.strokeActive = false;
  }

  // ── Stroke accum texture accessors (for stroke texture renderer) ──

  /** Get the stroke accumulation texture (for stroke texture rendering). */
  public getStrokeAccumTex(): GPUTexture | null {
    return this.strokeActive ? this.strokeAccumTex : null;
  }

  /** Clear the stroke accumulation texture to transparent black. */
  public clearStrokeAccum(): void {
    if (this.strokeAccumTex && this.strokeTexW > 0 && this.strokeTexH > 0) {
      this.clearTexture(this.strokeAccumTex, this.strokeTexW, this.strokeTexH);
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Stamp a single dab onto `dstTexture`.
   * `srcTexture` is a snapshot of the destination BEFORE this dab
   * (ping-pong pattern, needed for correct blending).
   */
  public stamp(
    srcTexture: GPUTexture,
    dstTexture: GPUTexture,
    params: StampParams,
  ): void {
    const { cx, cy, radius, color, rotation, mode, aspect, tipTexture } = params;

    const texW = dstTexture.width;
    const texH = dstTexture.height;
    const minX = Math.max(0, Math.floor(cx - radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxX = Math.min(texW - 1, Math.ceil(cx + radius));
    const maxY = Math.min(texH - 1, Math.ceil(cy + radius));
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw <= 0 || bh <= 0) return;

    // Write uniforms using pre-allocated arrays (zero GC pressure)
    const p = this.paramData;
    p[0] = minX; p[1] = minY; p[2] = radius; p[3] = mode;
    p[4] = rotation; p[5] = cx; p[6] = cy;
    p[7] = (params.lockTransparency ? 1 : 0) | (params.wetStroke ? 2 : 0);
    this.device.queue.writeBuffer(this.paramBuf, 0, p);

    const c = this.colorData;
    c[0] = color[0]; c[1] = color[1]; c[2] = color[2]; c[3] = color[3];
    this.device.queue.writeBuffer(this.colorBuf, 0, c);

    const a = this.aspectData;
    a[0] = aspect[0]; a[1] = aspect[1];
    this.device.queue.writeBuffer(this.aspectBuf, 0, a);

    // Resolve selection mask: use real mask or dummy 1x1 (no constraint)
    const maskTex = params.selectionMask ?? this.dummyMaskTex;

    // Resolve grain texture: use real grain or dummy 1x1 (no modulation)
    const grainTex = params.grainTexture ?? this.dummyGrainTex;
    const g = this.grainData;
    g[0] = params.grainInvScale?.[0] ?? 0;
    g[1] = params.grainInvScale?.[1] ?? 0;
    g[2] = params.grainTexture ? (params.grainStrength ?? 0) : 0; // 0 strength when no grain
    g[3] = 0;
    this.device.queue.writeBuffer(this.grainBuf, 0, g);

    // Resolve dual brush texture: use real dual brush or dummy 1x1 (no modulation)
    const dualTex = params.dualBrushTexture ?? this.dummyDualTex;
    const db = this.dualBrushData;
    db[0] = params.dualBrushTexture ? (params.dualBrushScale ?? 1) : 1;
    db[1] = params.dualBrushTexture ? (params.dualBrushStrength ?? 0) : 0; // 0 strength = disabled
    db[2] = params.dualBrushBlendOp ?? 0; // 0=multiply, 1=subtract, 2=minimum
    db[3] = params.dualBrushTileMode ?? 0; // 0=dab-local, 1=canvas-tiling
    db[4] = params.dualBrushRotation ?? 0;
    db[5] = 0; db[6] = 0; db[7] = 0;
    this.device.queue.writeBuffer(this.dualBrushBuf, 0, db);

    // Reuse bind group if textures haven't changed (common case: same stroke)
    if (
      this.cachedBindGroup &&
      this.cachedSrcTex === srcTexture &&
      this.cachedDstTex === dstTexture &&
      this.cachedTipTex === tipTexture &&
      this.cachedMaskTex === maskTex &&
      this.cachedGrainTex === grainTex &&
      this.cachedDualTex === dualTex
    ) {
      // Bind group is still valid — uniforms were already updated in-place
    } else {
      this.cachedBindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: srcTexture.createView() },
          { binding: 1, resource: dstTexture.createView() },
          { binding: 2, resource: this.tipSampler },
          { binding: 3, resource: { buffer: this.paramBuf } },
          { binding: 4, resource: { buffer: this.colorBuf } },
          { binding: 5, resource: { buffer: this.aspectBuf } },
          { binding: 6, resource: tipTexture.createView() },
          { binding: 7, resource: maskTex.createView() },
          { binding: 8, resource: grainTex.createView() },
          { binding: 9, resource: this.grainSampler },
          { binding: 10, resource: { buffer: this.grainBuf } },
          { binding: 11, resource: dualTex.createView() },
          { binding: 12, resource: { buffer: this.dualBrushBuf } },
        ],
      });
      this.cachedSrcTex = srcTexture;
      this.cachedDstTex = dstTexture;
      this.cachedTipTex = tipTexture;
      this.cachedMaskTex = maskTex;
      this.cachedGrainTex = grainTex;
      this.cachedDualTex = dualTex;
    }

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.cachedBindGroup!);

    const wgSize = 8;
    pass.dispatchWorkgroups(Math.ceil(bw / wgSize), Math.ceil(bh / wgSize));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Stamp with ping-pong: copies texture → persistent temp, stamps from temp → texture.
   * The temp texture is kept alive across dabs to avoid alloc/dealloc per dab.
   *
   * When a stroke is active (beginStroke was called), uses "indirect painting":
   *  - Dabs are stamped onto strokeAccumTex (using max-alpha, not additive blend)
   *  - After each dab, output = composite(strokeBaseTex, strokeAccumTex)
   * This prevents opacity buildup when painting over the same area.
   */
  public stampWithPingPong(
    texture: GPUTexture,
    params: StampParams,
  ): void {
    // Erase modes (1,2,3) must bypass wet-stroke: the accum texture starts transparent,
    // so erasing transparent pixels (existing.a * (1-brush) = 0*anything = 0) is a no-op.
    // Erasing also *wants* opacity buildup (repeated strokes erase more), so direct is correct.
    const isEraseMode = params.mode !== 0;
    if (this.strokeActive && this.strokeBaseTex && this.strokeAccumTex && !isEraseMode) {
      // ── Indirect painting (wet-stroke) path ──
      // Ensure ping texture for the accum read
      if (
        !this.pingTex ||
        this.pingTexW !== texture.width ||
        this.pingTexH !== texture.height
      ) {
        this.pingTex?.destroy();
        this.pingTex = this.device.createTexture({
          size: [texture.width, texture.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.pingTexW = texture.width;
        this.pingTexH = texture.height;
        this.cachedBindGroup = null;
      }

      // Copy current strokeAccumTex → ping (for reading)
      const cpEnc = this.device.createCommandEncoder();
      cpEnc.copyTextureToTexture(
        { texture: this.strokeAccumTex },
        { texture: this.pingTex },
        { width: texture.width, height: texture.height },
      );
      this.device.queue.submit([cpEnc.finish()]);

      // Stamp dab: read from ping (current accum), write to strokeAccumTex
      // The shader uses max-alpha blending for paint mode when strokeActive
      this.stamp(this.pingTex, this.strokeAccumTex, { ...params, wetStroke: true });

      // Composite: strokeBaseTex + strokeAccumTex → output texture
      this.compositeStrokeLayer(this.strokeBaseTex, this.strokeAccumTex, texture);
      return;
    }

    // ── Legacy direct path (no stroke lifecycle) ──
    if (
      !this.pingTex ||
      this.pingTexW !== texture.width ||
      this.pingTexH !== texture.height
    ) {
      this.pingTex?.destroy();
      this.pingTex = this.device.createTexture({
        size: [texture.width, texture.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.pingTexW = texture.width;
      this.pingTexH = texture.height;
      this.cachedBindGroup = null;
    }

    const copyEnc = this.device.createCommandEncoder();
    copyEnc.copyTextureToTexture(
      { texture },
      { texture: this.pingTex },
      { width: texture.width, height: texture.height },
    );
    this.device.queue.submit([copyEnc.finish()]);

    this.stamp(this.pingTex, texture, params);
  }

  public destroy(): void {
    this.paramBuf.destroy();
    this.colorBuf.destroy();
    this.aspectBuf.destroy();
    this.grainBuf.destroy();
    this.pingTex?.destroy();
    this.pingTex = null;
    this.strokeBaseTex?.destroy();
    this.strokeBaseTex = null;
    this.strokeAccumTex?.destroy();
    this.strokeAccumTex = null;
    this.dummyMaskTex.destroy();
    this.dummyGrainTex.destroy();
    this.cachedBindGroup = null;
  }

  // ── Stroke composite helper ───────────────────────────────────────

  /**
   * Composite strokeAccum onto strokeBase, writing the result to outputTex.
   * Uses standard alpha-over blending: output = base + accum composited on top.
   */
  private compositeStrokeLayer(
    baseTex: GPUTexture,
    accumTex: GPUTexture,
    outputTex: GPUTexture,
  ): void {
    const w = outputTex.width;
    const h = outputTex.height;

    const bg = this.device.createBindGroup({
      layout: this.compositeBGL,
      entries: [
        { binding: 0, resource: baseTex.createView() },
        { binding: 1, resource: accumTex.createView() },
        { binding: 2, resource: outputTex.createView() },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Clear a texture to transparent black (0,0,0,0). */
  private clearTexture(tex: GPUTexture, w: number, h: number): void {
    const paddedRowBytes = Math.ceil(w * 4 / 256) * 256;
    const buf = this.device.createBuffer({
      size: paddedRowBytes * h,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).fill(0);
    buf.unmap();
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: buf, bytesPerRow: paddedRowBytes },
      { texture: tex },
      { width: w, height: h },
    );
    this.device.queue.submit([enc.finish()]);
    buf.destroy();
  }

  // ── Composite pipeline construction ───────────────────────────────

  private buildCompositePipeline(): void {
    const code = /* wgsl */ `
      @group(0) @binding(0) var baseTex: texture_2d<f32>;    // stroke base (pre-stroke snapshot)
      @group(0) @binding(1) var accumTex: texture_2d<f32>;   // stroke accumulation layer
      @group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let base = textureLoad(baseTex, coords, 0);
        let stroke = textureLoad(accumTex, coords, 0);

        // Standard alpha-over: stroke layer on top of base
        let srcA = stroke.a;
        if (srcA <= 0.001) {
          textureStore(output, coords, base);
          return;
        }

        let outA = srcA + base.a * (1.0 - srcA);
        var outRGB = vec3<f32>(0.0);
        if (outA > 0.001) {
          outRGB = (stroke.rgb * srcA + base.rgb * base.a * (1.0 - srcA)) / outA;
        }
        textureStore(output, coords, vec4<f32>(outRGB, outA));
      }
    `;

    this.compositeBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      ],
    });

    this.compositePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.compositeBGL] }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }

  // ── Wet Edges post-process ─────────────────────────────────────────

  /**
   * Apply wet edges effect to the stroke accumulation texture.
   * Darkens and concentrates pigment at the alpha boundaries of strokes.
   */
  private applyWetEdges(
    accumTex: GPUTexture,
    settings: { edgeDarkness: number; edgeWidth: number; strength: number },
  ): void {
    this.ensureWetEdgesPipeline();

    const w = accumTex.width;
    const h = accumTex.height;

    // We need a ping texture to read from while writing to accumTex
    if (!this.pingTex || this.pingTexW !== w || this.pingTexH !== h) {
      this.pingTex?.destroy();
      this.pingTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.pingTexW = w;
      this.pingTexH = h;
      this.cachedBindGroup = null;
    }

    // Copy accumTex → ping for reading
    const cpEnc = this.device.createCommandEncoder();
    cpEnc.copyTextureToTexture({ texture: accumTex }, { texture: this.pingTex! }, { width: w, height: h });
    this.device.queue.submit([cpEnc.finish()]);

    // Write wet edge params
    const p = this.wetEdgesParamData;
    p[0] = settings.edgeDarkness;
    p[1] = settings.edgeWidth;
    p[2] = settings.strength;
    p[3] = 0;
    this.device.queue.writeBuffer(this.wetEdgesParamBuf, 0, p);

    const bg = this.device.createBindGroup({
      layout: this.wetEdgesBGL!,
      entries: [
        { binding: 0, resource: this.pingTex!.createView() },
        { binding: 1, resource: accumTex.createView() },
        { binding: 2, resource: { buffer: this.wetEdgesParamBuf } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.wetEdgesPipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  private ensureWetEdgesPipeline(): void {
    if (this.wetEdgesPipeline) return;

    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
      // params: edgeDarkness, edgeWidth, strength, pad
      @group(0) @binding(2) var<uniform> params: vec4<f32>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let src = textureLoad(srcTex, coords, 0);

        // Skip fully transparent pixels
        if (src.a <= 0.001) {
          textureStore(output, coords, src);
          return;
        }

        let edgeDarkness = params.x;
        let edgeWidth = i32(params.y);
        let strength = params.z;

        // Sample neighborhood to find minimum alpha (edge detection)
        var minA = src.a;
        for (var dy = -edgeWidth; dy <= edgeWidth; dy = dy + 1) {
          for (var dx = -edgeWidth; dx <= edgeWidth; dx = dx + 1) {
            if (dx == 0 && dy == 0) { continue; }
            let nc = vec2<i32>(
              clamp(coords.x + dx, 0, i32(dim.x) - 1),
              clamp(coords.y + dy, 0, i32(dim.y) - 1),
            );
            let na = textureLoad(srcTex, nc, 0).a;
            minA = min(minA, na);
          }
        }

        // Edge factor: high where this pixel has alpha but neighbors don't
        // (i.e. at the boundary of the painted area)
        let edgeFactor = src.a * (1.0 - minA);

        // Darken RGB at edges (simulate pigment concentration)
        let darkened = src.rgb * (1.0 - edgeFactor * edgeDarkness * strength);

        // Slightly boost alpha at edges (wet paint pools at borders)
        let boostedA = min(1.0, src.a + edgeFactor * strength * 0.3);

        let result = mix(src, vec4<f32>(darkened, boostedA), strength);
        textureStore(output, coords, result);
      }
    `;

    this.wetEdgesBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.wetEdgesPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.wetEdgesBGL] }),
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }

  // ── Stamp pipeline construction ───────────────────────────────────

  private buildPipeline(): void {
    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex: texture_2d<f32>;
      @group(0) @binding(1) var dstTex: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(2) var tipSamp: sampler;
      // params: minX, minY, radius, mode, rotation, cx, cy, flags
      // flags encodes: bit 0 = lockTransparency, bit 1 = wetStroke
      @group(0) @binding(3) var<uniform> params: array<f32, 8>;
      @group(0) @binding(4) var<uniform> color: vec4<f32>;
      @group(0) @binding(5) var<uniform> aspect: vec2<f32>;
      @group(0) @binding(6) var tipTex: texture_2d<f32>;
      @group(0) @binding(7) var selMask: texture_2d<f32>;
      @group(0) @binding(8) var grainTex: texture_2d<f32>;
      @group(0) @binding(9) var grainSamp: sampler;
      // grainParams: invScaleX, invScaleY, strength, pad
      @group(0) @binding(10) var<uniform> grainParams: vec4<f32>;
      @group(0) @binding(11) var dualTex: texture_2d<f32>;
      // dualParams: scale, strength, blendOp, tileMode, rotation, pad, pad, pad
      @group(0) @binding(12) var<uniform> dualParams: array<f32, 8>;

      fn blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
        let outA = src.a + dst.a * (1.0 - src.a);
        if (outA <= 0.0) { return vec4<f32>(0.0); }
        let outRGB = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / outA;
        return vec4<f32>(outRGB, outA);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let local_ix = i32(gid.x);
        let local_iy = i32(gid.y);
        let ox = i32(params[0]);
        let oy = i32(params[1]);
        let r  = params[2];
        let mode = i32(params[3]);
        let rotation = params[4];
        let flags = i32(params[7]);
        let lockTrans = (flags & 1) != 0;
        let wetStroke = (flags & 2) != 0;

        let ix = ox + local_ix;
        let iy = oy + local_iy;

        // Selection mask constraint: read mask value at this texel.
        // If the mask texture is 1x1 (dummy), it reads (0,0) = 1.0 everywhere.
        let maskDim = textureDimensions(selMask);
        var maskVal = 1.0;
        if (maskDim.x > 1u || maskDim.y > 1u) {
          // Real mask — sample at the exact texel position
          let mx = clamp(ix, 0, i32(maskDim.x) - 1);
          let my = clamp(iy, 0, i32(maskDim.y) - 1);
          maskVal = textureLoad(selMask, vec2<i32>(mx, my), 0).r;
        }
        if (maskVal <= 0.001) { return; }

        let px = f32(ix) + 0.5;
        let py = f32(iy) + 0.5;
        // Use actual dab center from uniforms (params[5], params[6]) instead of
        // reconstructing from bounding box origin. The old formula (ox + r)
        // was wrong when the dab was clipped against texture edges.
        let cx = params[5];
        let cy = params[6];

        // Offset from center, apply aspect correction
        var dx = (px - cx) * aspect.x;
        var dy = (py - cy) * aspect.y;

        // Apply per-dab rotation
        let cosR = cos(rotation);
        let sinR = sin(rotation);
        let rdx = dx * cosR - dy * sinR;
        let rdy = dx * sinR + dy * cosR;

        let d = sqrt(rdx * rdx + rdy * rdy);
        if (d > r) { return; }

        // Sample the tip texture: map (-r..+r) to (0..1) UV
        let u = (rdx / r) * 0.5 + 0.5;
        let v = (rdy / r) * 0.5 + 0.5;
        var tipAlpha = textureSampleLevel(tipTex, tipSamp, vec2<f32>(u, v), 0.0).r;

        if (tipAlpha <= 0.001) { return; }

        // ── Canvas grain modulation ──
        // Sample the tiling grain texture at the canvas-space texel position.
        // grainParams.xy = inverse scale for tiling, grainParams.z = strength.
        let grainStrength = grainParams.z;
        if (grainStrength > 0.001) {
          let grainUV = vec2<f32>(f32(ix), f32(iy)) * grainParams.xy;
          let grainVal = textureSampleLevel(grainTex, grainSamp, grainUV, 0.0).r;
          // mix(1.0, grainVal, strength): at strength=0 no effect, at strength=1 full grain
          tipAlpha = tipAlpha * mix(1.0, grainVal, grainStrength);
        }

        // ── Dual brush texture modulation ──
        // Combines the tip shape with a second texture for organic, grainy strokes.
        let dualScale = dualParams[0];
        let dualStrength = dualParams[1];
        let dualBlendOp = i32(dualParams[2]);
        let dualTileMode = i32(dualParams[3]);
        let dualRotation = dualParams[4];

        if (dualStrength > 0.001) {
          var dualUV: vec2<f32>;
          if (dualTileMode == 1) {
            // Canvas-tiling: UV based on absolute canvas position
            let dualDim = vec2<f32>(textureDimensions(dualTex));
            dualUV = vec2<f32>(f32(ix), f32(iy)) / (dualDim * dualScale);
          } else {
            // Dab-local: UV relative to the dab center, with optional rotation
            var localDx = rdx / r;
            var localDy = rdy / r;
            if (abs(dualRotation) > 0.001) {
              let cosD = cos(dualRotation);
              let sinD = sin(dualRotation);
              let tmpX = localDx * cosD - localDy * sinD;
              localDy = localDx * sinD + localDy * cosD;
              localDx = tmpX;
            }
            dualUV = (vec2<f32>(localDx, localDy) / dualScale) * 0.5 + 0.5;
          }
          let dualVal = textureSampleLevel(dualTex, grainSamp, dualUV, 0.0).r;
          if (dualBlendOp == 1) {
            // Subtract: dark areas of texture reduce alpha
            tipAlpha = tipAlpha * mix(1.0, 1.0 - dualVal, dualStrength);
          } else if (dualBlendOp == 2) {
            // Minimum: take the lower of tip and texture
            tipAlpha = min(tipAlpha, mix(tipAlpha, dualVal, dualStrength));
          } else {
            // Multiply (default): texture directly modulates tip
            tipAlpha = tipAlpha * mix(1.0, dualVal, dualStrength);
          }
        }

        let brushAlpha = color.a * tipAlpha * maskVal;
        let existing = textureLoad(srcTex, vec2<i32>(ix, iy), 0);
        var out: vec4<f32> = existing;

        if (mode == 0) {
          // Paint (normal blend)
          if (wetStroke) {
            // Wet-stroke mode: writing to stroke accumulation layer.
            // Use max-alpha: the stroke layer opacity at each texel is the maximum
            // of all dabs that touched it, NOT their additive sum.
            // This prevents opacity buildup when painting over the same area.
            let newA = max(existing.a, brushAlpha);
            // Blend the color: if the new dab has higher alpha, use its color;
            // otherwise keep the existing color.
            var newRGB = color.rgb;
            if (existing.a > 0.001 && existing.a >= brushAlpha) {
              newRGB = existing.rgb;
            } else if (existing.a > 0.001) {
              // Lerp color from existing toward new based on alpha increase
              let t = (brushAlpha - existing.a) / max(brushAlpha, 0.001);
              newRGB = mix(existing.rgb, color.rgb, t);
            }
            out = vec4<f32>(newRGB, newA);
          } else {
            let brushCol = vec4<f32>(color.rgb, brushAlpha);
            out = blend(existing, brushCol);
          }
        } else if (mode == 1) {
          // Erase (fade): reduce alpha proportionally
          let newA = existing.a * (1.0 - brushAlpha);
          var newRGB = existing.rgb;
          if (existing.a > 0.0) {
            newRGB = existing.rgb * (newA / existing.a);
          } else {
            newRGB = vec3<f32>(1.0);
          }
          out = vec4<f32>(newRGB, newA);
        } else if (mode == 2) {
          // Erase (clear / hard erase)
          let newA = existing.a * (1.0 - ceil(brushAlpha));
          var newRGB = existing.rgb;
          if (newA <= 0.0) {
            newRGB = vec3<f32>(1.0);
          } else if (existing.a > 0.0) {
            newRGB = existing.rgb * (newA / existing.a);
          }
          out = vec4<f32>(newRGB, newA);
        } else if (mode == 3) {
          // Erase (hard with sharper falloff)
          let t = 1.0 - smoothstep(0.0, r, d);
          let hardT = pow(t, 3.0);
          let brushAlphaHard = color.a * hardT;
          let newA = existing.a * (1.0 - brushAlphaHard);
          var newRGB = existing.rgb;
          if (newA <= 0.0) {
            newRGB = vec3<f32>(0.0);
          } else if (existing.a > 0.0) {
            newRGB = existing.rgb * (newA / existing.a);
          }
          out = vec4<f32>(newRGB, newA);
        } else if (mode == 4) {
          // Multiply blend: darkens by multiplying existing color with brush color
          let blended = existing.rgb * color.rgb;
          let outRGB = mix(existing.rgb, blended, brushAlpha);
          let outA = existing.a + brushAlpha * (1.0 - existing.a);
          out = vec4<f32>(outRGB, outA);
        } else if (mode == 5) {
          // Screen blend: lightens by inverting, multiplying, and inverting back
          let blended = vec3<f32>(1.0) - (vec3<f32>(1.0) - existing.rgb) * (vec3<f32>(1.0) - color.rgb);
          let outRGB = mix(existing.rgb, blended, brushAlpha);
          let outA = existing.a + brushAlpha * (1.0 - existing.a);
          out = vec4<f32>(outRGB, outA);
        } else if (mode == 6) {
          // Overlay blend: combines multiply and screen based on existing luminance
          var blended: vec3<f32>;
          // Per-channel overlay
          blended.r = select(
            1.0 - 2.0 * (1.0 - existing.r) * (1.0 - color.r),
            2.0 * existing.r * color.r,
            existing.r < 0.5
          );
          blended.g = select(
            1.0 - 2.0 * (1.0 - existing.g) * (1.0 - color.g),
            2.0 * existing.g * color.g,
            existing.g < 0.5
          );
          blended.b = select(
            1.0 - 2.0 * (1.0 - existing.b) * (1.0 - color.b),
            2.0 * existing.b * color.b,
            existing.b < 0.5
          );
          let outRGB = mix(existing.rgb, blended, brushAlpha);
          let outA = existing.a + brushAlpha * (1.0 - existing.a);
          out = vec4<f32>(outRGB, outA);
        }

        // Lock transparency: clamp output alpha to not exceed the original alpha
        if (lockTrans) {
          out = vec4<f32>(out.rgb, min(out.a, existing.a));
        }

        textureStore(dstTex, vec2<i32>(ix, iy), out);
      }
    `;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 11, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: this.device.createShaderModule({ code }),
        entryPoint: 'main',
      },
    });
  }
}
