/**
 * SelectionOverlayRenderer — draws marching-ants selection outline + transform handles
 * as part of the WebGPU render pass.
 *
 * Draws in WORLD space (texel → world conversion) and uses the same world matrix
 * as the raster quad so the overlay pans/zooms with the canvas.
 */

export interface SelectionOverlayState {
  /** Bounding rect in texel space (from selectionInfo.bounds). */
  bounds: { x: number; y: number; w: number; h: number } | null;
  /** In-progress drag preview rect in texel space. */
  dragPreview: { x: number; y: number; w: number; h: number } | null;
  /** Is a transform in progress? */
  isTransforming: boolean;
  /** Transform state if transforming. */
  transform: { translateX: number; translateY: number; scaleX: number; scaleY: number; rotation: number } | null;
  /** Tool that created the selection ('rect', 'ellipse', 'lasso', 'magic-wand'). */
  tool?: 'rect' | 'ellipse' | 'lasso' | 'magic-wand';
  /** Polygon points for lasso outline (texel coords). */
  lassoPoints?: Array<{ x: number; y: number }> | null;
}

export class SelectionOverlayRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private handlePipeline: GPURenderPipeline | null = null;
  private vertexBuf: GPUBuffer | null = null;
  private handleVertexBuf: GPUBuffer | null = null;
  private uniformBuf: GPUBuffer;
  private uniformData = new Float32Array(4); // time, pad, pad, pad
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private startTime = performance.now();

  constructor(device: GPUDevice) {
    this.device = device;
    this.uniformBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Render selection overlay into the current render pass.
   *
   * @param passEncoder - Active render pass encoder
   * @param state - Selection overlay state
   * @param texW - Raster texture width in texels
   * @param texH - Raster texture height in texels
   * @param worldW - World quad width (raster quad spans -worldW/2 to +worldW/2)
   * @param worldH - World quad height
   * @param worldMatrixBuf - The same GPU uniform buffer the raster quad uses for the world matrix
   * @param format - Render target texture format
   */
  public render(
    passEncoder: GPURenderPassEncoder,
    state: SelectionOverlayState,
    texW: number,
    texH: number,
    worldW: number,
    worldH: number,
    worldMatrixBuf: GPUBuffer,
    format: GPUTextureFormat,
  ): void {
    const rect = state.bounds ?? state.dragPreview;
    // Allow lasso rendering even without a rect (during in-progress drag)
    const hasLassoPoints = state.tool === 'lasso' && state.lassoPoints && state.lassoPoints.length >= 2;
    if (!rect && !hasLassoPoints) return;

    // Apply transform offset if transforming
    let drawRect = rect ? { ...rect } : { x: 0, y: 0, w: 0, h: 0 };
    if (state.isTransforming && state.transform && state.bounds) {
      drawRect = {
        x: state.bounds.x + state.transform.translateX,
        y: state.bounds.y + state.transform.translateY,
        w: state.bounds.w * state.transform.scaleX,
        h: state.bounds.h * state.transform.scaleY,
      };
    }

    this.ensurePipeline(format);

    // Convert texel rect → world-space vertices
    // Texel (0, 0) = top-left → world (-worldW/2, +worldH/2)
    // Texel (texW, texH) = bottom-right → world (+worldW/2, -worldH/2)
    const hw = worldW / 2;
    const hh = worldH / 2;

    const toWorldX = (tx: number) => (tx / texW) * worldW - hw;
    const toWorldY = (ty: number) => hh - (ty / texH) * worldH; // Y flipped

    const x0 = toWorldX(drawRect.x);
    const y0 = toWorldY(drawRect.y);
    const x1 = toWorldX(drawRect.x + drawRect.w);
    const y1 = toWorldY(drawRect.y + drawRect.h);

    // Build line-strip vertices based on selection tool shape
    const isEllipse = state.tool === 'ellipse';
    const isLasso = state.tool === 'lasso' && state.lassoPoints && state.lassoPoints.length >= 2;
    let verts: Float32Array<ArrayBuffer>;
    if (isLasso) {
      verts = this.buildLassoVerts(state.lassoPoints!, toWorldX, toWorldY,
        state.isTransforming ? state.transform : null);
    } else if (rect) {
      if (isEllipse) {
        verts = this.buildEllipseVerts(x0, y0, x1, y1);
      } else {
        verts = new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]);
      }
    } else {
      return; // no rect and not a lasso — nothing to draw
    }
    const vertexCount = verts.length / 2;

    // Upload vertices
    if (!this.vertexBuf || this.vertexBuf.size < verts.byteLength) {
      this.vertexBuf?.destroy();
      this.vertexBuf = this.device.createBuffer({
        size: Math.max(verts.byteLength, 1024),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.vertexBuf, 0, verts);

    // Upload time uniform
    const elapsed = (performance.now() - this.startTime) / 1000.0;
    this.uniformData[0] = elapsed;
    this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniformData);

    const bg = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: worldMatrixBuf } },
        { binding: 1, resource: { buffer: this.uniformBuf } },
      ],
    });

    passEncoder.setPipeline(this.pipeline!);
    passEncoder.setBindGroup(0, bg);
    passEncoder.setVertexBuffer(0, this.vertexBuf);
    passEncoder.draw(vertexCount, 1, 0, 0);

    // Draw drag preview as a second outline if we have both bounds and preview
    if (state.dragPreview && state.bounds) {
      const dp = state.dragPreview;
      const dpX0 = toWorldX(dp.x);
      const dpY0 = toWorldY(dp.y);
      const dpX1 = toWorldX(dp.x + dp.w);
      const dpY1 = toWorldY(dp.y + dp.h);
      let dpVerts: Float32Array<ArrayBuffer>;
      if (isEllipse) {
        dpVerts = this.buildEllipseVerts(dpX0, dpY0, dpX1, dpY1);
      } else {
        dpVerts = new Float32Array([dpX0, dpY0, dpX1, dpY0, dpX1, dpY1, dpX0, dpY1, dpX0, dpY0]);
      }
      if (this.vertexBuf.size >= dpVerts.byteLength) {
        this.device.queue.writeBuffer(this.vertexBuf, 0, dpVerts);
        passEncoder.draw(dpVerts.length / 2, 1, 0, 0);
      }
    }

    // Draw transform handles if transforming
    if (state.isTransforming) {
      this.renderTransformHandles(passEncoder, drawRect, toWorldX, toWorldY, texW, texH, bg);
    }
  }

  /** Render 8 small handle squares at corners and edge midpoints. */
  private renderTransformHandles(
    passEncoder: GPURenderPassEncoder,
    rect: { x: number; y: number; w: number; h: number },
    toWorldX: (tx: number) => number,
    toWorldY: (ty: number) => number,
    texW: number,
    texH: number,
    bg: GPUBindGroup,
  ): void {
    if (!this.handlePipeline) return;

    // Handle size in world units (~6 texels)
    const handleTexels = 6;
    const sx = (handleTexels / texW) * Math.abs(toWorldX(texW) - toWorldX(0));
    const sy = (handleTexels / texH) * Math.abs(toWorldY(0) - toWorldY(texH));

    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const handles = [
      { x: rect.x, y: rect.y },
      { x: cx, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x, y: cy },
      { x: rect.x + rect.w, y: cy },
      { x: rect.x, y: rect.y + rect.h },
      { x: cx, y: rect.y + rect.h },
      { x: rect.x + rect.w, y: rect.y + rect.h },
    ];

    // Build triangle-list vertices for filled handle squares (2 triangles per handle)
    const triVerts: number[] = [];
    for (const h of handles) {
      const wx = toWorldX(h.x);
      const wy = toWorldY(h.y);
      triVerts.push(wx - sx, wy - sy);
      triVerts.push(wx + sx, wy - sy);
      triVerts.push(wx + sx, wy + sy);
      triVerts.push(wx - sx, wy - sy);
      triVerts.push(wx + sx, wy + sy);
      triVerts.push(wx - sx, wy + sy);
    }

    const arr = new Float32Array(triVerts);
    if (!this.handleVertexBuf || this.handleVertexBuf.size < arr.byteLength) {
      this.handleVertexBuf?.destroy();
      this.handleVertexBuf = this.device.createBuffer({
        size: Math.max(arr.byteLength, 512),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.handleVertexBuf, 0, arr);

    passEncoder.setPipeline(this.handlePipeline);
    passEncoder.setBindGroup(0, bg);
    passEncoder.setVertexBuffer(0, this.handleVertexBuf);
    passEncoder.draw(handles.length * 6, 1, 0, 0);
  }

  public destroy(): void {
    this.vertexBuf?.destroy();
    this.handleVertexBuf?.destroy();
    this.uniformBuf.destroy();
  }

  // ── Ellipse outline helper ────────────────────────────────────────

  /** Build a line-strip ellipse inscribed in the axis-aligned box (x0,y0)→(x1,y1). */
  private buildEllipseVerts(x0: number, y0: number, x1: number, y1: number, segments = 64): Float32Array<ArrayBuffer> {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = Math.abs(x1 - x0) / 2;
    const ry = Math.abs(y1 - y0) / 2;
    // +1 to close the loop
    const verts = new Float32Array((segments + 1) * 2);
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      verts[i * 2]     = cx + Math.cos(angle) * rx;
      verts[i * 2 + 1] = cy + Math.sin(angle) * ry;
    }
    return verts;
  }

  // ── Lasso outline helper ──────────────────────────────────────────

  /** Build a closed line-strip polygon from lasso points, converting texel → world coords. */
  private buildLassoVerts(
    points: Array<{ x: number; y: number }>,
    toWorldX: (tx: number) => number,
    toWorldY: (ty: number) => number,
    transform: { translateX: number; translateY: number; scaleX: number; scaleY: number } | null,
  ): Float32Array<ArrayBuffer> {
    const n = points.length;
    // +1 to close the loop back to the first point
    const verts = new Float32Array((n + 1) * 2);
    const tx = transform?.translateX ?? 0;
    const ty = transform?.translateY ?? 0;
    for (let i = 0; i <= n; i++) {
      const p = points[i % n];
      verts[i * 2]     = toWorldX(p.x + tx);
      verts[i * 2 + 1] = toWorldY(p.y + ty);
    }
    return verts;
  }

  // ── Pipeline construction ─────────────────────────────────────────

  private ensurePipeline(format: GPUTextureFormat): void {
    if (this.pipeline) return;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }, // world matrix
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, // time
      ],
    });

    // ── Marching ants pipeline (line-strip) ─────────────────────────
    const marchingAntsCode = /* wgsl */ `
      @group(0) @binding(0) var<uniform> worldMatrix: mat4x4<f32>;
      @group(0) @binding(1) var<uniform> params: vec4<f32>; // time, pad, pad, pad

      struct VSOut {
        @builtin(position) pos: vec4<f32>,
      };

      @vertex
      fn vs(@location(0) position: vec2<f32>) -> VSOut {
        var out: VSOut;
        out.pos = worldMatrix * vec4<f32>(position, 0.0, 1.0);
        return out;
      }

      @fragment
      fn fs(in: VSOut) -> @location(0) vec4<f32> {
        let screenX = in.pos.x;
        let screenY = in.pos.y;
        let dashLen = 6.0;
        let speed = 30.0;
        let t = params.x * speed;

        let along = screenX + screenY + t;
        let inDash = fract(along / dashLen) < 0.5;

        if (inDash) {
          return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        } else {
          return vec4<f32>(1.0, 1.0, 1.0, 1.0);
        }
      }
    `;

    const marchModule = this.device.createShaderModule({ code: marchingAntsCode });
    const vertexLayout: GPUVertexBufferLayout = {
      arrayStride: 8,
      attributes: [{ format: 'float32x2' as GPUVertexFormat, offset: 0, shaderLocation: 0 }],
    };

    const depthStencil: GPUDepthStencilState = {
      format: 'depth24plus-stencil8',
      depthWriteEnabled: false,
      depthCompare: 'always',
    };

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: marchModule, entryPoint: 'vs', buffers: [vertexLayout] },
      fragment: {
        module: marchModule,
        entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'line-strip' },
      depthStencil,
    });

    // ── Handle pipeline (triangle-list, solid white fill) ───────────
    const handleCode = /* wgsl */ `
      @group(0) @binding(0) var<uniform> worldMatrix: mat4x4<f32>;
      @group(0) @binding(1) var<uniform> params: vec4<f32>;

      struct VSOut {
        @builtin(position) pos: vec4<f32>,
      };

      @vertex
      fn vs(@location(0) position: vec2<f32>) -> VSOut {
        var out: VSOut;
        out.pos = worldMatrix * vec4<f32>(position, 0.0, 1.0);
        return out;
      }

      @fragment
      fn fs(in: VSOut) -> @location(0) vec4<f32> {
        return vec4<f32>(1.0, 1.0, 1.0, 0.9);
      }
    `;

    const handleModule = this.device.createShaderModule({ code: handleCode });
    this.handlePipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: handleModule, entryPoint: 'vs', buffers: [vertexLayout] },
      fragment: {
        module: handleModule,
        entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil,
    });
  }
}
