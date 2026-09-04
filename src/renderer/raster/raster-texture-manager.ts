import { RasterCanvas } from './raster-canvas';

export class RasterTextureManager {
  private device: GPUDevice;
  private texture?: GPUTexture;
  private width = 0;
  private height = 0;
  // Reusable staging GPU buffer (for padded uploads)
  private stagingBuffer?: GPUBuffer;
  private stagingSize = 0;
  // Reusable CPU-side staging array to avoid per-upload allocation
  private cpuStaging?: Uint8Array;
  // Undo/redo snapshots (stored as tightly-packed RGBA rows)
  private snapshots: Array<{ w: number; h: number; data: Uint8Array }> = [];
  private snapIndex = -1; // points to current snapshot in history
  private maxSnapshots = 10;
  // timestamp of last snapshot push (ms) to coalesce rapid calls
  private lastSnapshotMs = 0;
  // Enable debug logs while we diagnose snapshot behavior
  private debugSnapshots = false;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  // --- Compute brush support ---
  private brushComputePipeline?: GPUComputePipeline;
  private brushBindGroupLayout?: GPUBindGroupLayout;

  private ensureBrushComputePipeline() {
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

  // Dispatch compute brush into the texture. cx,cy in texel coords. color is [r,g,b,a] in 0..1
  public dispatchBrushToTexture(
    tex: GPUTexture,
    srcView: GPUTextureView | undefined,
    cx: number,
    cy: number,
    radius: number,
    colorArr: [number,number,number,number],
    mode: 'paint' | 'erase' | 'clear' = 'paint',
    eraseHard?: boolean,
    canvasWidth?: number,
    canvasHeight?: number
  ) 
  {
    this.ensureBrushComputePipeline();
    const device = this.device;

    // Create a temporary texture for reading (ping-pong approach)
    const tempTex = device.createTexture({
      size: [this.width, this.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    // Copy current texture to temp texture
    const copyEncoder = device.createCommandEncoder();
    copyEncoder.copyTextureToTexture(
      { texture: tex },
      { texture: tempTex },
      { width: this.width, height: this.height }
    );
    device.queue.submit([copyEncoder.finish()]);

    // Now use tempTex as source, tex as destination
    const texW = this.width;
    const texH = this.height;
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
    const texAspect = this.width / this.height;    // 1669/991 = 1.684 (wide)
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

  ensureTexture(w: number, h: number) {
    if (this.texture && this.width === w && this.height === h) return this.texture;

    const oldTex = this.texture;
    const copyW  = oldTex ? Math.min(this.width, w) : 0;
    const copyH  = oldTex ? Math.min(this.height, h) : 0;

    this.width = w; this.height = h;
    this.texture = this.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_DST |
             GPUTextureUsage.RENDER_ATTACHMENT |
             GPUTextureUsage.STORAGE_BINDING |
             GPUTextureUsage.COPY_SRC,
    });

    // Preserve existing pixel data (e.g. when document size changes).
    // Copies as much as fits into the new texture; any new area stays transparent.
    if (oldTex && copyW > 0 && copyH > 0) {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture(
        { texture: oldTex },
        { texture: this.texture },
        { width: copyW, height: copyH },
      );
      this.device.queue.submit([enc.finish()]);
    }
    // DEFER the destroy to after the GPU drains: `oldTex` may still be referenced by a PREVIOUS frame's
    // in-flight command buffer (the compositor bind group). Destroying it inline throws "Destroyed texture
    // used in a submit" — seen when a rapid resize (e.g. a setDocumentSize thrash) reallocates the doc
    // texture mid-frame. onSubmittedWorkDone resolves once all prior submits (incl. the copy above) complete.
    if (oldTex) this.device.queue.onSubmittedWorkDone().then(() => oldTex.destroy()).catch(() => { /* device lost */ });

    return this.texture;
  }

  // Initialize with a blank snapshot - call this after creating the texture
  public async initializeWithBlankSnapshot(): Promise<void> {
    if (!this.texture) return;
    
    // Clear texture to transparent
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.texture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    
  // Push the blank state as the initial snapshot and ensure snapIndex is seeded
  await this.pushSnapshot();
  // Ensure snapIndex points at the initial snapshot so undo/redo behaves predictably
  if (this.snapshots.length > 0) this.snapIndex = 0;
  }

  // Expose current texture size
  public getTextureSize(): { w: number, h: number } {
    return { w: this.width, h: this.height };
  }

  /** The current backing GPU texture (null until ensureTexture runs). */
  public getTexture(): GPUTexture | null {
    return this.texture ?? null;
  }

  // Push a snapshot of the current texture into the undo stack
  public async pushSnapshot(): Promise<void> {
    const now = Date.now();
    const COALESCE_MS = 40;
    
    if (now - this.lastSnapshotMs < COALESCE_MS) {
      if (this.debugSnapshots) console.log('pushSnapshot: coalesced');
      return;
    }
    
    this.lastSnapshotMs = now; // Set once, here
    
    if (!this.texture) return;
    const w = this.width, h = this.height;
    if (w === 0 || h === 0) return;

    const bytesPerPixel = 4;
    const unpaddedRow = w * bytesPerPixel;
    const paddedRow = Math.ceil(unpaddedRow / 256) * 256;
    const total = paddedRow * h;

    const readBuf = this.device.createBuffer({ size: total, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.texture },
      { buffer: readBuf, bytesPerRow: paddedRow },
      { width: w, height: h, depthOrArrayLayers: 1 }
    );
    this.device.queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readBuf.getMappedRange());

    // Convert padded rows -> tightly packed rows
    const out = new Uint8Array(unpaddedRow * h);
    for (let row = 0; row < h; row++) {
      const srcOff = row * paddedRow;
      const dstOff = row * unpaddedRow;
      out.set(mapped.subarray(srcOff, srcOff + unpaddedRow), dstOff);
    }

    readBuf.unmap();
    readBuf.destroy();

    // Only check for duplicates if we're already in the snapshot history (snapIndex >= 0)
    // If we're at snapIndex = -1 (current state), always allow the snapshot
    let shouldSkip = false;
    if (this.snapIndex >= 0 && this.snapshots.length > 0) {
      // Compare to the current snapshot we're viewing
      const compareSnap = this.snapshots[this.snapIndex];
      
      if (compareSnap && compareSnap.w === w && compareSnap.h === h && compareSnap.data.length === out.length) {
        let same = true;
        for (let i = 0; i < out.length; i++) {
          if (compareSnap.data[i] !== out[i]) { same = false; break; }
        }
        if (same) {
          shouldSkip = true;
          if (this.debugSnapshots) console.log('pushSnapshot: skipped identical to current snapshot');
        }
      }
    }

    if (shouldSkip) return;

    // Truncate redo history when pushing a new snapshot
    if (this.snapIndex + 1 < this.snapshots.length) {
      this.snapshots.length = this.snapIndex + 1;
    }

    // Add new snapshot
    this.snapshots.push({ w, h, data: out });
    
    // Handle max snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
      // Don't decrease snapIndex here - it should point to the new last element
    }
    
    this.snapIndex = this.snapshots.length - 1;
    
    if (this.debugSnapshots) {
      console.log('pushSnapshot: added, snapIndex=', this.snapIndex, 'length=', this.snapshots.length);
    }
  }

  // restore tight RGBA snapshot into the texture
  private async restoreSnapshot(snap: { w: number; h: number; data: Uint8Array }) {
    const w = snap.w, h = snap.h;
    const bytesPerPixel = 4;
    const unpaddedRow = w * bytesPerPixel;
    const paddedRow = Math.ceil(unpaddedRow / 256) * 256;
    const total = paddedRow * h;

    // ensure texture size
    this.ensureTexture(w, h);
    this.ensureStagingBuffer(total);

    if (!this.cpuStaging || this.cpuStaging.length < total) this.cpuStaging = new Uint8Array(total);
    const tmp = this.cpuStaging;
    // pack rows into padded layout
    for (let row = 0; row < h; row++) {
      const srcOff = row * unpaddedRow;
      const dstOff = row * paddedRow;
      tmp.set(snap.data.subarray(srcOff, srcOff + unpaddedRow), dstOff);
    }

    // Some drivers/implementations reject huge single writeBuffer calls. Split into smaller chunks.
    const MAX_CHUNK = 4 * 1024 * 1024; // 4MB
    let offset = 0;
    while (offset < total) {
      const chunk = Math.min(MAX_CHUNK, total - offset);
      this.device.queue.writeBuffer(this.stagingBuffer!, offset, tmp as any, offset, chunk);
      offset += chunk;
    }

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: this.stagingBuffer!, bytesPerRow: paddedRow },
      { texture: this.texture!, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { width: w, height: h, depthOrArrayLayers: 1 }
    );
    this.device.queue.submit([enc.finish()]);
    
    if (this.debugSnapshots) console.log('Restored snapshot', w, h, 'snapIndex=', this.snapIndex);
  }

  public async undo(): Promise<boolean> {
    if (this.debugSnapshots) console.log('undo: snapIndex=', this.snapIndex, 'length=', this.snapshots.length);
    
    if (this.snapshots.length === 0) {
      if (this.debugSnapshots) console.log('undo: no snapshots');
      return false;
    }
    
    // If we're at -1 (current state), go to the most recent snapshot
    if (this.snapIndex === -1) {
      this.snapIndex = this.snapshots.length - 1;
    }
    // If we're at any snapshot (including 0), try to go to the previous one
    else if (this.snapIndex > 0) {
      this.snapIndex--;
    }
    // If we're at snapshot 0, we can only "undo" if we have a blank state to restore to
    else if (this.snapIndex === 0) {
      // If we're viewing snapshot 0 and it's not the current drawn state,
      // we can't go further back
      if (this.debugSnapshots) console.log('undo: already at oldest state');
      return false;
    }
    
    const snap = this.snapshots[this.snapIndex];
    if (!snap) {
      if (this.debugSnapshots) console.log('undo: snapshot not found at index', this.snapIndex);
      return false;
    }
    
    await this.restoreSnapshot(snap);
    if (this.debugSnapshots) console.log('undo: success, new snapIndex=', this.snapIndex);
    return true;
  }

  public async redo(): Promise<boolean> {
    if (this.debugSnapshots) console.log('redo: snapIndex=', this.snapIndex, 'length=', this.snapshots.length);
    
    // If we're at -1, go to index 0
    if (this.snapIndex === -1) {
      if (this.snapshots.length === 0) {
        if (this.debugSnapshots) console.log('redo: no snapshots to redo to');
        return false;
      }
      this.snapIndex = 0;
    }
    // Normal case: go forward one snapshot
    else {
      if (this.snapIndex + 1 >= this.snapshots.length) {
        if (this.debugSnapshots) console.log('redo: nothing to redo');
        return false;
      }
      this.snapIndex++;
    }
    
    const snap = this.snapshots[this.snapIndex];
    if (!snap) {
      if (this.debugSnapshots) console.log('redo: snapshot not found at index', this.snapIndex);
      return false;
    }
    
    await this.restoreSnapshot(snap);
    if (this.debugSnapshots) console.log('redo: success, new snapIndex=', this.snapIndex);
    return true;
  }

  /**
   * Read the current GPU texture back into a tightly-packed RGBA buffer.
   * Shared by exportToBlob() (persistence) and readToCanvas() (live UV-pane
   * display). Returns null when there is no texture to read.
   */
  private async _readbackRGBA() {
    if (!this.texture) return null;
    const w = this.width, h = this.height;
    if (w === 0 || h === 0) return null;

    const padded = Math.ceil((w * 4) / 256) * 256;
    const readBuf = this.device.createBuffer({ size: padded * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.texture },
      { buffer: readBuf, bytesPerRow: padded, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    this.device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);

    const src = new Uint8Array(readBuf.getMappedRange());
    const rgba = new Uint8ClampedArray(w * h * 4);
    let dst = 0;
    for (let y = 0; y < h; y++) {
      const row = y * padded;
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        // Source texture is rgba8unorm; copy directly.
        rgba[dst++] = src[i + 0];
        rgba[dst++] = src[i + 1];
        rgba[dst++] = src[i + 2];
        rgba[dst++] = src[i + 3];
      }
    }
    readBuf.unmap();
    readBuf.destroy();
    return { rgba, w, h };
  }

  // Export current texture as an image Blob (PNG/WebP). Useful for persistence.
  public async exportToBlob(type: 'image/png' | 'image/webp' = 'image/webp'): Promise<Blob> {
    const back = await this._readbackRGBA();
    if (!back) return new Blob();
    const { rgba, w, h } = back;

    const fullCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });

    const ctx = (fullCanvas as any).getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('2D context unavailable');
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);

    if ('convertToBlob' in fullCanvas) {
      return await (fullCanvas as OffscreenCanvas).convertToBlob({ type });
    }
    return await new Promise<Blob>(res => (fullCanvas as HTMLCanvasElement).toBlob(b => res(b!), type));
  }

  /**
   * Blit the current texture into a provided 2D canvas (resized to match).
   * Lets the UV paint controller show live paint as the UV-editor background
   * each (throttled) frame without an async createImageBitmap round-trip.
   */
  public async readToCanvas(target: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    const back = await this._readbackRGBA();
    if (!back) return;
    const { rgba, w, h } = back;
    if (target.width !== w) target.width = w;
    if (target.height !== h) target.height = h;
    const ctx = (target as any).getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) return;
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  }

  private ensureStagingBuffer(minSize: number) {
    if (this.stagingBuffer && this.stagingSize >= minSize) return;
    this.stagingBuffer?.destroy();
    this.stagingSize = Math.max(minSize, 256);
    this.stagingBuffer = this.device.createBuffer({ size: this.stagingSize, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  }

  // Upload either full buffer or dirty rect from RasterCanvas
  uploadRasterCanvas(raster: RasterCanvas) {
    const w = raster.width, h = raster.height;
    const tex = this.ensureTexture(w, h);
    const srcBuf = raster.getBuffer();

    // If the canvas has a dirty rect, upload only that region (padded rows to 256 bytes).
    let dirty = raster.consumeDirtyRect();
    if (!dirty) {
      // No dirty rect: treat as full-canvas upload (useful for imports where dirty isn't set)
      dirty = { x: 0, y: 0, w: w, h: h } as any;
    }
    // Narrow type for TS (we have ensured dirty is set above)
    const nd = dirty!;

    const bytesPerPixel = 4;

    // Upload the dirty rect with 256-byte-aligned rows (required for copyBufferToTexture compatibility)
  const rectW = nd.w, rectH = nd.h;
    const unpaddedRow = rectW * bytesPerPixel;
    const paddedRow = Math.ceil(unpaddedRow / 256) * 256;

    const totalBytes = paddedRow * rectH;
    this.ensureStagingBuffer(totalBytes);

    // Fill the reusable cpu staging buffer
    if (!this.cpuStaging || this.cpuStaging.length < totalBytes) this.cpuStaging = new Uint8Array(totalBytes);
    const tmp = this.cpuStaging;
    for (let row = 0; row < rectH; row++) {
  const srcRowStart = ((nd.y + row) * w + nd.x) * bytesPerPixel;
      const srcSlice = srcBuf.subarray(srcRowStart, srcRowStart + unpaddedRow);
      tmp.set(srcSlice, row * paddedRow);
    }

    // Use chunked writes to avoid large single-buffer limits
    const MAX_CHUNK = 4 * 1024 * 1024; // 4MB
    let off = 0;
    while (off < totalBytes) {
      const chunk = Math.min(MAX_CHUNK, totalBytes - off);
      this.device.queue.writeBuffer(this.stagingBuffer!, off, tmp as any, off, chunk);
      off += chunk;
    }

    // copy staging buffer -> texture with padded row pitch using a short command encoder
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToTexture(
      { buffer: this.stagingBuffer!, bytesPerRow: paddedRow },
  { texture: tex, mipLevel: 0, origin: { x: nd.x, y: nd.y, z: 0 } },
      { width: rectW, height: rectH, depthOrArrayLayers: 1 }
    );
    this.device.queue.submit([enc.finish()]);

    return tex;
  }

  destroy() {
    this.texture?.destroy();
    this.texture = undefined;
  }
}