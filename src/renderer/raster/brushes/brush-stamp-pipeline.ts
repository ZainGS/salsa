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

import { markRasterCompositeDirty } from '../core/raster-composite-dirty';

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

/** A texel rectangle, max-exclusive. */
export interface TexelRect { x0: number; y0: number; x1: number; y1: number }

/** Bytes of CPU→GPU uniform staging per batch (BRUSH-1b). ~250 dabs; a fuller batch submits early and goes on. */
const STAGING_BYTES = 64 * 1024;
/** Staging reserved per dab (5 stamp uniforms + bleed + one composite rect, 16-byte aligned) — see reserveStaging. */
const DAB_STAGING_BYTES = 256;
/** Kept free so the final composite of a flush always has a slot for its rect uniform. */
const STAGING_HEADROOM = 32;

function unionRect(a: TexelRect | null, b: TexelRect): TexelRect {
  if (!a) return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function padRect(r: TexelRect | null, pad: number): TexelRect | null {
  return r && { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad };
}

/**
 * The texel bounds of a dab's stamp dispatch (BRUSH-1). `minX/minY/bw/bh` is the box the stamp shader is
 * dispatched over (ceil(bw/8) × ceil(bh/8) workgroups starting at minX/minY); the FOOTPRINT is every in-texture
 * texel a thread of that dispatch can read or write: the box rounded up to whole 8×8 workgroups, clipped to the
 * texture. Copying / compositing exactly the footprint (instead of the whole canvas) is pixel-identical: the
 * shader reads `srcTex` and writes `dstTex` only at its own texel, so texels outside the footprint are never
 * touched. Exported for the CPU-mirror tests. Returns null for a dab entirely off the texture.
 */
export function dabDispatchBounds(
  cx: number, cy: number, radius: number, texW: number, texH: number,
): { minX: number; minY: number; bw: number; bh: number; footprint: TexelRect } | null {
  const minX = Math.max(0, Math.floor(cx - radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxX = Math.min(texW - 1, Math.ceil(cx + radius));
  const maxY = Math.min(texH - 1, Math.ceil(cy + radius));
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw <= 0 || bh <= 0) return null;
  const fx1 = Math.min(texW, minX + Math.ceil(bw / 8) * 8);
  const fy1 = Math.min(texH, minY + Math.ceil(bh / 8) * 8);
  return { minX, minY, bw, bh, footprint: { x0: minX, y0: minY, x1: fx1, y1: fy1 } };
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
  // E5: composite + bleed bind groups were rebuilt (with fresh createView calls) EVERY DAB - cache them
  // keyed on texture identity, invalidated wherever cachedBindGroup is (texture swap / ping realloc).
  private cachedCompositeBG: GPUBindGroup | null = null;
  private cachedCompositeKey: [GPUTexture, GPUTexture, GPUTexture] | null = null;
  private cachedBleedBGs: [GPUBindGroup, GPUBindGroup] | null = null;
  private cachedBleedAccum: GPUTexture | null = null;
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

  // Bleed / diffusion pipeline: Gaussian spread on stroke accum layer
  private bleedPipeline: GPUComputePipeline | null = null;
  private bleedBGL: GPUBindGroupLayout | null = null;
  private bleedParamBuf: GPUBuffer;
  private bleedParamData = new Float32Array(4); // radius, strength, pad, pad

  // ── BRUSH-1 / 1b: bounded + batched dab recording ──
  // Every dab records into ONE open encoder (`batchEnc`); its uniforms go through a staging buffer
  // (copyBufferToBuffer in command order, so many dabs can share one submit without clobbering each
  // other's uniforms — a plain queue.writeBuffer would land ALL of them before the submit). The wet-stroke
  // composite is deferred and run once per flush over the union of what changed (`pendingComposite`).
  private batchEnc: GPUCommandEncoder | null = null;
  private batchDepth = 0;
  private stagingBuf: GPUBuffer;
  private stagingCpu = new ArrayBuffer(STAGING_BYTES);
  private stagingF32 = new Float32Array(this.stagingCpu);
  private stagingU32 = new Uint32Array(this.stagingCpu);
  private stagingCursor = 0;
  /** Composite rect uniform: originX, originY, width, height (u32). */
  private compositeRectBuf: GPUBuffer;
  /** Union of strokeAccumTex texels changed since the last composite (null = none). */
  private pendingComposite: TexelRect | null = null;
  /** A full-accum change (per-dab bleed) since the last composite → composite the whole texture. */
  private pendingCompositeFull = false;
  private pendingOutput: GPUTexture | null = null;
  /** BRUSH-5: texels of a NON-accum texture (a layer) written by the commands recorded since the last submit.
   *  Reported to the incremental layer composite (markRasterCompositeDirty) right after flush() submits them. */
  private recordedDirty: TexelRect | null = null;
  /** Direct-path (erase / blend-mode) dab writes to the stroke's output since the last composite. The old
   *  full-canvas composite overwrote them; the bounded composite re-covers them so the result stays identical. */
  private strokeOutputDirty: TexelRect | null = null;
  /** Union of output-texture texels written this stroke (composites + direct dabs) — the undo patch rect. */
  private strokeTouched: TexelRect | null = null;
  // ── End-of-stroke effects (wet edges / end bleed / stroke-texture strip) ──
  // They rewrite strokeAccumTex AFTER the last dab composite, so endStroke composites the accum into the stroke's
  // output once more — bounded to everything the accum can hold paint in plus everything the stroke already wrote.
  /** The texture the stroke paints into (beginStroke's texture; the output of the wet composites). */
  private strokeTarget: GPUTexture | null = null;
  /** Union of strokeAccumTex texels that may hold paint this stroke (wet footprints, a strip, bleed spread). */
  private strokeAccumDirty: TexelRect | null = null;
  /** A wet dab or a stroke-texture strip put paint in the accum this stroke (the end composite needs one). */
  private strokeAccumUsed = false;
  /** The accum was rewritten outside the dab path (clearStrokeAccum + markStrokeAccumWritten — the strip). */
  private strokeAccumRewritten = false;
  /** Diagnostics / tests: submits and texels copied+composited (BRUSH-1 traffic counter). */
  public readonly stats = { submits: 0, copiedTexels: 0, compositedTexels: 0 };

  // ── Provisional (predicted) tail — BRUSH-4 stroke prediction ──
  // drawProvisional saves the texels under the predicted dabs into small scratch textures, stamps + composites the
  // dabs through the normal path, and remembers the rect; clearProvisional takes the tail back. Every real entry
  // point (settleProvisional) clears it first, so real work never builds on a predicted texel and nothing that
  // reads the textures (undo patch, smudge, readbacks) ever sees one.
  //
  // The take-back (2026-10-06, after the tail hid the committed stroke on a tablet GPU): it uses ONLY the kinds of
  // GPU work the committed stroke itself uses, and never copies a texture into the layer or the accum:
  //  - a WET tail saved only the ACCUM texels; they go back with a compute pass (rectCopy), and the layer is then
  //    RE-COMPOSITED from base ⊕ accum over the tail rect — the same pass that put the committed stroke there, so
  //    what comes back is the committed stroke by construction (a wet stroke's layer always equals base ⊕ accum);
  //  - a DIRECT tail (eraser / blend-mode brush: the dabs wrote the layer itself) saved the layer texels; they go
  //    back with the same compute pass.
  // `savedOut`: the layer texels were saved (a direct tail, or a stroke that also wrote the layer directly).
  private provisional: { texture: GPUTexture; rect: TexelRect; wet: boolean; savedOut: boolean } | null = null;
  private inProvisional = false;
  /** This stroke stamped real dabs straight into its output (erase / blend modes): its layer is NOT base ⊕ accum. */
  private strokeDirectWrites = false;
  private rectCopyPipeline: GPUComputePipeline | null = null;
  private rectCopyBGL: GPUBindGroupLayout | null = null;
  private rectCopyBuf: GPUBuffer | null = null;
  private rectCopyData = new Uint32Array(4);
  private rectCopyBGs: Array<{ src: GPUTexture; dst: GPUTexture; bg: GPUBindGroup }> = [];
  private scratchOut: GPUTexture | null = null;
  private scratchAccum: GPUTexture | null = null;
  private scratchW = 0;
  private scratchH = 0;
  /** Diagnostics / tests: provisional draws, and the texels they saved + restored. */
  public readonly provisionalStats = { draws: 0, clears: 0, savedTexels: 0 };

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

    // Bleed / diffusion uniform buffer
    this.bleedParamBuf = device.createBuffer({
      size: 16, // 4 floats: radius, strength, pad, pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.stagingBuf = device.createBuffer({
      size: STAGING_BYTES,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.compositeRectBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ── Batching (BRUSH-1b) ───────────────────────────────────────────

  /**
   * Open a dab batch: every dab until the matching endBatch() records into one command encoder and is
   * submitted once (the brush engine opens one per pointer frame). Nests; only the outermost end submits.
   * Anything that reads the painted textures outside the pipeline must happen after endBatch()/flush().
   */
  public beginBatch(): void {
    this.settleProvisional();
    this.batchDepth++;
  }

  public endBatch(): void {
    if (this.batchDepth > 0) this.batchDepth--;
    if (this.batchDepth === 0) this.flush();
  }

  /** Submit everything recorded so far (incl. the deferred composite). The batch, if open, stays open. */
  public flush(): void {
    const enc = this.batchEnc;
    if (!enc) return;
    this.compositePending(enc);
    if (this.stagingCursor > 0) {
      this.device.queue.writeBuffer(this.stagingBuf, 0, this.stagingCpu, 0, this.stagingCursor);
    }
    this.device.queue.submit([enc.finish()]);
    this.stats.submits++;
    this.batchEnc = null;
    this.stagingCursor = 0;
    const dirty = this.recordedDirty;
    if (dirty) {
      this.recordedDirty = null;
      markRasterCompositeDirty(dirty);
    }
  }

  private encoder(): GPUCommandEncoder {
    return this.batchEnc ??= this.device.createCommandEncoder();
  }

  /** Make room for `bytes` of staged uniforms in the current submit (submitting early when full). Call
   *  BEFORE recording a dab so a dab never straddles an encoder swap mid-recording. */
  private reserveStaging(bytes: number): void {
    if (this.stagingCursor + bytes > STAGING_BYTES - STAGING_HEADROOM) this.flush();
  }

  /** Copy `data` into staging and record a copy into `dst` at this point of the command stream. */
  private stageUniform(enc: GPUCommandEncoder, dst: GPUBuffer, data: Float32Array | Uint32Array): void {
    const off = this.stagingCursor;
    const n = data.length;
    if (off + n * 4 > STAGING_BYTES) throw new Error('BrushStampPipeline: uniform staging overflow');
    if (data instanceof Float32Array) this.stagingF32.set(data, off >> 2);
    else this.stagingU32.set(data, off >> 2);
    enc.copyBufferToBuffer(this.stagingBuf, off, dst, 0, n * 4);
    this.stagingCursor = off + Math.ceil((n * 4) / 16) * 16;
  }

  /** Record the deferred wet-stroke composite over everything that changed since the last one. */
  private compositePending(enc: GPUCommandEncoder): void {
    const out = this.pendingOutput;
    if (!out || (!this.pendingComposite && !this.pendingCompositeFull)) {
      this.pendingOutput = null;
      return;
    }
    let r: TexelRect;
    if (this.pendingCompositeFull) {
      r = { x0: 0, y0: 0, x1: out.width, y1: out.height };
    } else {
      r = this.pendingComposite!;
      if (this.strokeOutputDirty) r = unionRect(r, this.strokeOutputDirty);
    }
    const x0 = Math.max(0, r.x0), y0 = Math.max(0, r.y0);
    const x1 = Math.min(out.width, r.x1), y1 = Math.min(out.height, r.y1);
    this.pendingComposite = null;
    this.pendingCompositeFull = false;
    this.pendingOutput = null;
    this.strokeOutputDirty = null;
    if (x1 <= x0 || y1 <= y0 || !this.strokeBaseTex || !this.strokeAccumTex) return;
    const rect = { x0, y0, x1, y1 };
    this.compositeRecord(enc, this.strokeBaseTex, this.strokeAccumTex, out, rect);
    this.strokeTouched = unionRect(this.strokeTouched, rect);
  }

  /** The output-texture texels this stroke wrote (exact; composites + direct dabs), then reset. Pair with
   *  readStrokeRect for an undo patch. Null when the stroke wrote nothing. */
  public takeStrokeTouchedRect(): TexelRect | null {
    this.settleProvisional();
    this.flush();
    const r = this.strokeTouched;
    this.strokeTouched = null;
    return r;
  }

  /**
   * BRUSH-6: read back the BEFORE (the stroke-start snapshot in strokeBaseTex) and AFTER (`texture`) pixels of
   * `rect` for an undo patch — two small readbacks instead of a full-canvas one. Must be called after the
   * stroke ends and before the next beginStroke (it records its copies immediately, so a later stroke can't
   * overwrite strokeBaseTex under it). Null when the stroke base doesn't match `texture`'s size.
   */
  public readStrokeRect(
    texture: GPUTexture, rect: TexelRect,
  ): Promise<{ x: number; y: number; w: number; h: number; before: Uint8Array; after: Uint8Array }> | null {
    this.settleProvisional();
    this.flush();
    const base = this.strokeBaseTex;
    if (!base || this.strokeTexW !== texture.width || this.strokeTexH !== texture.height) return null;
    const x = Math.max(0, Math.floor(rect.x0)), y = Math.max(0, Math.floor(rect.y0));
    const w = Math.min(texture.width, Math.ceil(rect.x1)) - x;
    const h = Math.min(texture.height, Math.ceil(rect.y1)) - y;
    if (w <= 0 || h <= 0) return null;
    const row = w * 4;
    const padded = Math.ceil(row / 256) * 256;
    const mk = () => this.device.createBuffer({ size: padded * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const bBuf = mk(), aBuf = mk();
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: base, origin: { x, y } }, { buffer: bBuf, bytesPerRow: padded }, { width: w, height: h });
    enc.copyTextureToBuffer({ texture, origin: { x, y } }, { buffer: aBuf, bytesPerRow: padded }, { width: w, height: h });
    this.device.queue.submit([enc.finish()]);
    this.stats.submits++;
    const unpack = (buf: GPUBuffer) => {
      const src = new Uint8Array(buf.getMappedRange());
      const out = new Uint8Array(row * h);
      for (let r = 0; r < h; r++) out.set(src.subarray(r * padded, r * padded + row), r * row);
      buf.unmap(); buf.destroy();
      return out;
    };
    return Promise.all([bBuf.mapAsync(GPUMapMode.READ), aBuf.mapAsync(GPUMapMode.READ)])
      .then(() => ({ x, y, w, h, before: unpack(bBuf), after: unpack(aBuf) }));
  }

  /** Ensure the shared ping texture matches `w×h` (submitting pending work first if it must be reallocated —
   *  recorded commands may reference the old one). */
  private ensurePing(w: number, h: number): GPUTexture {
    if (!this.pingTex || this.pingTexW !== w || this.pingTexH !== h) {
      this.flush();
      this.pingTex?.destroy();
      this.pingTex = this.device.createTexture({
        size: [w, h],
        format: 'rgba8unorm',
        // STORAGE_BINDING: pingTex is SHARED with applyBleed (which binds it as a write storage texture) and
        // reuse is gated on SIZE only — so every allocation must support storage or a bleed-after-same-size-dab
        // reuses a storage-less texture → WebGPU validation error.
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
      });
      this.pingTexW = w;
      this.pingTexH = h;
      this.cachedBindGroup = null;
      this.cachedBleedBGs = null;
    }
    return this.pingTex;
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
    this.settleProvisional();
    this.flush();   // anything still recorded belongs to the previous stroke

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
        // RENDER_ATTACHMENT: cleared with a loadOp:'clear' pass (BRUSH-1b) instead of a CPU zero upload.
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
               GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.strokeTexW = w;
      this.strokeTexH = h;
    }

    // Snapshot current canvas → strokeBaseTex, and clear strokeAccumTex to transparent black — one submit.
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture }, { texture: this.strokeBaseTex! }, { width: w, height: h });
    this.recordClear(enc, this.strokeAccumTex!);
    this.device.queue.submit([enc.finish()]);
    this.stats.submits++;

    this.pendingComposite = null;
    this.pendingCompositeFull = false;
    this.pendingOutput = null;
    this.strokeOutputDirty = null;
    this.strokeTouched = null;
    this.strokeDirectWrites = false;
    this.strokeTarget = texture;
    this.strokeAccumDirty = null;
    this.strokeAccumUsed = false;
    this.strokeAccumRewritten = false;
    this.strokeActive = true;
    this.cachedBindGroup = null; // invalidate — textures changed
    this.cachedCompositeKey = null; this.cachedCompositeBG = null;
    this.cachedBleedBGs = null; this.cachedBleedAccum = null;
  }

  /**
   * Call at the end of a stroke. Optionally applies the end-of-stroke bleed and wet edges to the stroke
   * accumulation layer, then flattens it onto the canvas.
   *
   * The flatten: these passes (and a stroke-texture strip the brush engine rendered into the accum — see
   * markStrokeAccumWritten) change the accum AFTER the last dab composite, so the accum is composited into the
   * stroke's output once more. Before 2026-10-06 that composite was missing and the three effects never reached
   * the canvas (mobile-parity.md §3). It's bounded: the rect is everything the accum can hold paint in (the wet
   * footprints / the strip, grown by the bleed spread and the wet-edge kernel) united with everything the stroke
   * already wrote (so a strip that replaced the dab preview also restores the base where the preview was).
   * Outside that rect accum alpha is 0 and the output already equals the base, so it's byte-identical to a
   * full-canvas composite. The rect joins strokeTouched, so the undo patch includes the effect. A stroke with no
   * end effects records nothing here (unchanged); one that put no paint in the accum (an eraser stroke) skips
   * the passes too, since the accum is discarded.
   */
  public endStroke(
    wetEdges?: { edgeDarkness: number; edgeWidth: number; strength: number },
    bleed?: { radius: number; strength: number },
  ): void {
    this.settleProvisional();
    this.flush();
    if (this.strokeAccumTex && this.strokeActive && this.strokeAccumUsed) {
      let effect = this.strokeAccumRewritten;
      if (bleed && bleed.strength > 0) {
        this.applyBleed(this.strokeAccumTex, bleed);
        // two cross-shaped gathers of `radius` (applyBleed rounds it, min 1): paint spreads ≤ 2·radius per axis
        // (only when strength ≥ 0.99 — below that transparent texels stay put — but the pad is harmless)
        this.strokeAccumDirty = padRect(this.strokeAccumDirty, 2 * Math.max(1, Math.round(bleed.radius)));
        effect = true;
      }
      if (wetEdges && wetEdges.strength > 0) {
        this.applyWetEdges(this.strokeAccumTex, wetEdges);
        // the shader only rewrites texels that already hold paint; padding by the kernel width is conservative
        this.strokeAccumDirty = padRect(this.strokeAccumDirty, Math.max(0, Math.ceil(wetEdges.edgeWidth)));
        effect = true;
      }
      if (effect) this.compositeStrokeEnd();
    }
    this.strokeActive = false;
  }

  /** The end-of-stroke flatten (see endStroke): one bounded composite of the accum into the stroke's output. */
  private compositeStrokeEnd(): void {
    const out = this.strokeTarget, base = this.strokeBaseTex, accum = this.strokeAccumTex;
    if (!out || !base || !accum || out.width !== this.strokeTexW || out.height !== this.strokeTexH) return;
    let r = this.strokeAccumDirty;
    if (this.strokeTouched) r = unionRect(r, this.strokeTouched);
    if (!r) return;
    const x0 = Math.max(0, Math.floor(r.x0)), y0 = Math.max(0, Math.floor(r.y0));
    const x1 = Math.min(out.width, Math.ceil(r.x1)), y1 = Math.min(out.height, Math.ceil(r.y1));
    if (x1 <= x0 || y1 <= y0) return;
    const rect = { x0, y0, x1, y1 };
    this.reserveStaging(DAB_STAGING_BYTES);
    this.compositeRecord(this.encoder(), base, accum, out, rect);
    this.strokeTouched = unionRect(this.strokeTouched, rect);
    this.flush();
  }

  /** True when this stroke has put paint in the accum (a wet dab or a strip) — erase-only strokes haven't. */
  public get strokeHasAccumPaint(): boolean {
    return this.strokeActive && this.strokeAccumUsed;
  }

  // ── Stroke accum texture accessors (for stroke texture renderer) ──

  /** Get the stroke accumulation texture (for stroke texture rendering). */
  public getStrokeAccumTex(): GPUTexture | null {
    this.settleProvisional();
    this.flush();   // the caller renders into it with its own submit
    return this.strokeActive ? this.strokeAccumTex : null;
  }

  /** Clear the stroke accumulation texture to transparent black. During a stroke this marks the accum as
   *  rewritten, so endStroke flattens it (the caller reports what it then draws with markStrokeAccumWritten). */
  public clearStrokeAccum(): void {
    this.settleProvisional();
    this.flush();
    if (this.strokeAccumTex && this.strokeTexW > 0 && this.strokeTexH > 0) {
      const enc = this.device.createCommandEncoder();
      this.recordClear(enc, this.strokeAccumTex);
      this.device.queue.submit([enc.finish()]);
      this.stats.submits++;
      if (this.strokeActive) {
        this.strokeAccumDirty = null;
        this.strokeAccumRewritten = true;
      }
    }
  }

  /** Report that something outside the dab path (the stroke-texture strip) drew into the accum within `rect`
   *  (texels, max-exclusive; clipped by the end composite). endStroke then composites it onto the canvas. */
  public markStrokeAccumWritten(rect: TexelRect): void {
    if (!this.strokeActive) return;
    this.strokeAccumDirty = unionRect(this.strokeAccumDirty, rect);
    this.strokeAccumUsed = true;
    this.strokeAccumRewritten = true;
  }

  // ── Provisional (predicted) tail — BRUSH-4 stroke prediction ─────

  /**
   * Draw `dabs` (the predicted tail) onto the live stroke's texture for ONE frame, so they can be taken back
   * exactly by clearProvisional(). The texels of the output (and, for wet dabs, the stroke accum) under the
   * dabs' union footprint are copied into small scratch textures first; the dabs then go through the normal
   * recording path (ping copy, stamp, bounded composite) and are submitted. All of the stroke's bookkeeping
   * (pending composite, touched / undo rect, accum-dirty rect) is restored afterwards, so the predicted dabs never
   * count toward the stroke. Cost: one copy of the footprint per texture, the dabs, one bounded composite — no
   * full-canvas work. Returns false (nothing drawn) outside a stroke on `texture`, inside an open batch, or when
   * every dab is off the texture. A previous provisional tail is cleared first.
   */
  public drawProvisional(texture: GPUTexture, dabs: readonly StampParams[]): boolean {
    this.settleProvisional();
    if (!this.strokeActive || texture !== this.strokeTarget || this.batchDepth > 0 || dabs.length === 0) return false;
    const W = texture.width, H = texture.height;
    let rect: TexelRect | null = null;
    let wet = false, direct = false;
    const canWet = !!this.strokeBaseTex && !!this.strokeAccumTex;
    for (const d of dabs) {
      const b = dabDispatchBounds(d.cx, d.cy, d.radius, W, H);
      if (!b) continue;
      rect = unionRect(rect, b.footprint);
      if (d.mode === 0 && canWet) wet = true; else direct = true;   // (the same test as recordDab)
    }
    if (!rect) return false;
    // The layer texels are saved only when they can't be re-derived as base ⊕ accum afterwards.
    const savedOut = direct || this.strokeDirectWrites || !wet;
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;

    this.flush();                       // the real stroke lands first
    this.ensureScratch(w, h);           // (may reallocate — nothing recorded references the old ones)
    this.ensurePing(W, H);
    const saved = {
      pendingComposite: this.pendingComposite, pendingCompositeFull: this.pendingCompositeFull,
      pendingOutput: this.pendingOutput, strokeOutputDirty: this.strokeOutputDirty, strokeTouched: this.strokeTouched,
      strokeAccumDirty: this.strokeAccumDirty, strokeAccumUsed: this.strokeAccumUsed,
      strokeAccumRewritten: this.strokeAccumRewritten,
    };
    const enc = this.encoder();
    if (savedOut) {
      enc.copyTextureToTexture({ texture, origin: { x: rect.x0, y: rect.y0 } }, { texture: this.scratchOut! }, { width: w, height: h });
    }
    if (wet) {
      enc.copyTextureToTexture({ texture: this.strokeAccumTex!, origin: { x: rect.x0, y: rect.y0 } }, { texture: this.scratchAccum! }, { width: w, height: h });
    }
    this.provisionalStats.savedTexels += w * h * ((wet ? 1 : 0) + (savedOut ? 1 : 0));
    // The composite of the predicted dabs must stay inside `rect` (only its texels are saved): drop the stroke's
    // direct-path dirty rect for this pass (restored below).
    this.strokeOutputDirty = null;
    this.provisional = { texture, rect, wet, savedOut };
    this.inProvisional = true;
    try {
      for (const d of dabs) this.recordDab(texture, d);
      this.flush();
    } finally {
      this.inProvisional = false;
      this.pendingComposite = saved.pendingComposite; this.pendingCompositeFull = saved.pendingCompositeFull;
      this.pendingOutput = saved.pendingOutput; this.strokeOutputDirty = saved.strokeOutputDirty;
      this.strokeTouched = saved.strokeTouched; this.strokeAccumDirty = saved.strokeAccumDirty;
      this.strokeAccumUsed = saved.strokeAccumUsed; this.strokeAccumRewritten = saved.strokeAccumRewritten;
    }
    this.provisionalStats.draws++;
    return true;
  }

  /**
   * Take the provisional tail back (byte-exact). False when there was none. Compute passes only (see the notes at
   * `provisional`): the saved accum texels are written back, then the layer under the tail is either re-composited
   * from base ⊕ accum (a wet stroke) or written back from its saved texels (a direct tail).
   */
  public clearProvisional(): boolean {
    const p = this.provisional;
    if (!p || this.inProvisional) return false;
    this.provisional = null;
    this.flush();
    const { rect } = p;
    this.reserveStaging(DAB_STAGING_BYTES);
    const enc = this.encoder();
    const accum = this.strokeAccumTex, base = this.strokeBaseTex;
    if (p.wet && accum) this.rectCopyRecord(enc, this.scratchAccum!, accum, rect);
    if (p.savedOut) this.rectCopyRecord(enc, this.scratchOut!, p.texture, rect);
    else if (accum && base) this.compositeRecord(enc, base, accum, p.texture, rect);
    this.flush();
    this.provisionalStats.clears++;
    return true;
  }

  /** Record a compute copy of `src`'s texels at (0,0)..(w,h) into `dst` at `rect` (the provisional take-back). */
  private rectCopyRecord(enc: GPUCommandEncoder, src: GPUTexture, dst: GPUTexture, rect: TexelRect): void {
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    if (w <= 0 || h <= 0) return;
    if (!this.rectCopyPipeline) {
      const code = /* wgsl */ `
        @group(0) @binding(0) var rectCopySrc: texture_2d<f32>;
        @group(0) @binding(1) var rectCopyDst: texture_storage_2d<rgba8unorm, write>;
        // rect: dst originX, originY, width, height (src is read at 0,0)
        @group(0) @binding(2) var<uniform> rect: vec4<u32>;

        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
          if (gid.x >= rect.z || gid.y >= rect.w) { return; }
          let dim = textureDimensions(rectCopyDst);
          let px = gid.x + rect.x;
          let py = gid.y + rect.y;
          if (px >= dim.x || py >= dim.y) { return; }
          let c = textureLoad(rectCopySrc, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
          textureStore(rectCopyDst, vec2<i32>(i32(px), i32(py)), c);
        }
      `;
      this.rectCopyBGL = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      this.rectCopyPipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.rectCopyBGL] }),
        compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
      });
      this.rectCopyBuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    let entry = this.rectCopyBGs.find(e => e.src === src && e.dst === dst);
    if (!entry) {
      if (this.rectCopyBGs.length >= 4) this.rectCopyBGs.length = 0;   // textures were reallocated: start over
      entry = {
        src, dst,
        bg: this.device.createBindGroup({
          layout: this.rectCopyBGL!,
          entries: [
            { binding: 0, resource: src.createView() },
            { binding: 1, resource: dst.createView() },
            { binding: 2, resource: { buffer: this.rectCopyBuf! } },
          ],
        }),
      };
      this.rectCopyBGs.push(entry);
    }
    const d = this.rectCopyData;
    d[0] = rect.x0; d[1] = rect.y0; d[2] = w; d[3] = h;
    this.stageUniform(enc, this.rectCopyBuf!, d);
    const pass = enc.beginComputePass();
    pass.setPipeline(this.rectCopyPipeline);
    pass.setBindGroup(0, entry.bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    if (dst !== this.strokeAccumTex) this.recordedDirty = unionRect(this.recordedDirty, rect);   // BRUSH-5
  }

  /** True while a provisional tail is on the texture. */
  public get hasProvisional(): boolean { return this.provisional !== null; }

  /** Every real entry point calls this first: a provisional tail never survives into real work or a readback. */
  private settleProvisional(): void {
    if (this.provisional && !this.inProvisional) this.clearProvisional();
  }

  /** Grow-only scratch textures for the provisional save (sizes rounded up to 64 texels). */
  private ensureScratch(w: number, h: number): void {
    if (this.scratchOut && this.scratchAccum && w <= this.scratchW && h <= this.scratchH) return;
    const sw = Math.max(this.scratchW, Math.ceil(w / 64) * 64), sh = Math.max(this.scratchH, Math.ceil(h / 64) * 64);
    this.scratchOut?.destroy();
    this.scratchAccum?.destroy();
    // Read by the take-back compute pass (TEXTURE_BINDING) — the same usage as the per-dab ping texture.
    const mk = () => this.device.createTexture({
      size: [sw, sh], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    this.scratchOut = mk();
    this.scratchAccum = mk();
    this.rectCopyBGs.length = 0;
    this.scratchW = sw;
    this.scratchH = sh;
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
    this.beginBatch();
    try {
      this.reserveStaging(DAB_STAGING_BYTES);
      this.stampRecord(this.encoder(), srcTexture, dstTexture, params);
    } finally {
      this.endBatch();
    }
  }

  /** Record one dab into `enc`. Uniforms are STAGED (copyBufferToBuffer recorded just before the dispatch),
   *  so any number of dabs can share one encoder/submit (BRUSH-1b). The caller reserves staging first
   *  (reserveStaging). Returns false for an off-canvas dab (nothing recorded). */
  private stampRecord(
    enc: GPUCommandEncoder,
    srcTexture: GPUTexture,
    dstTexture: GPUTexture,
    params: StampParams,
  ): boolean {
    const { cx, cy, radius, color, rotation, mode, aspect, tipTexture } = params;

    const b = dabDispatchBounds(cx, cy, radius, dstTexture.width, dstTexture.height);
    if (!b) return false;
    const { minX, minY, bw, bh } = b;

    // Write uniforms using pre-allocated arrays (zero GC pressure)
    const p = this.paramData;
    p[0] = minX; p[1] = minY; p[2] = radius; p[3] = mode;
    p[4] = rotation; p[5] = cx; p[6] = cy;
    p[7] = (params.lockTransparency ? 1 : 0) | (params.wetStroke ? 2 : 0);
    this.stageUniform(enc, this.paramBuf, p);

    const c = this.colorData;
    c[0] = color[0]; c[1] = color[1]; c[2] = color[2]; c[3] = color[3];
    this.stageUniform(enc, this.colorBuf, c);

    const a = this.aspectData;
    a[0] = aspect[0]; a[1] = aspect[1];
    this.stageUniform(enc, this.aspectBuf, a);

    // Resolve selection mask: use real mask or dummy 1x1 (no constraint)
    const maskTex = params.selectionMask ?? this.dummyMaskTex;

    // Resolve grain texture: use real grain or dummy 1x1 (no modulation)
    const grainTex = params.grainTexture ?? this.dummyGrainTex;
    const g = this.grainData;
    g[0] = params.grainInvScale?.[0] ?? 0;
    g[1] = params.grainInvScale?.[1] ?? 0;
    g[2] = params.grainTexture ? (params.grainStrength ?? 0) : 0; // 0 strength when no grain
    g[3] = 0;
    this.stageUniform(enc, this.grainBuf, g);

    // Resolve dual brush texture: use real dual brush or dummy 1x1 (no modulation)
    const dualTex = params.dualBrushTexture ?? this.dummyDualTex;
    const db = this.dualBrushData;
    db[0] = params.dualBrushTexture ? (params.dualBrushScale ?? 1) : 1;
    db[1] = params.dualBrushTexture ? (params.dualBrushStrength ?? 0) : 0; // 0 strength = disabled
    db[2] = params.dualBrushBlendOp ?? 0; // 0=multiply, 1=subtract, 2=minimum
    db[3] = params.dualBrushTileMode ?? 0; // 0=dab-local, 1=canvas-tiling
    db[4] = params.dualBrushRotation ?? 0;
    db[5] = 0; db[6] = 0; db[7] = 0;
    this.stageUniform(enc, this.dualBrushBuf, db);

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

    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.cachedBindGroup!);

    const wgSize = 8;
    pass.dispatchWorkgroups(Math.ceil(bw / wgSize), Math.ceil(bh / wgSize));
    pass.end();
    // BRUSH-5: a dab stamped straight into a layer (erase / blend modes / no stroke lifecycle). Accum dabs reach
    // the layer through compositeRecord; the ping texture is never a layer.
    if (dstTexture !== this.strokeAccumTex && dstTexture !== this.pingTex) {
      this.recordedDirty = unionRect(this.recordedDirty, b.footprint);
    }
    return true;
  }

  /**
   * Stamp with ping-pong: copies texture → persistent temp, stamps from temp → texture.
   * The temp texture is kept alive across dabs to avoid alloc/dealloc per dab.
   *
   * When a stroke is active (beginStroke was called), uses "indirect painting":
   *  - Dabs are stamped onto strokeAccumTex (using max-alpha, not additive blend)
   *  - output = composite(strokeBaseTex, strokeAccumTex)
   * This prevents opacity buildup when painting over the same area.
   *
   * BRUSH-1: the ping copy and the composite cover only the dab's dispatch footprint (dabDispatchBounds), not
   * the whole canvas — pixel-identical, since the stamp touches nothing else and the composite is a per-texel
   * function of (base, accum) whose inputs changed only there. BRUSH-1b: inside a batch (beginBatch/endBatch)
   * the composite is deferred to ONE pass over the union of the batch's footprints, and the batch is ONE submit;
   * outside a batch each call is its own one-dab batch.
   */
  public stampWithPingPong(
    texture: GPUTexture,
    params: StampParams,
    perDabBleed?: { radius: number; strength: number },
  ): void {
    this.beginBatch();
    try {
      this.recordDab(texture, params, perDabBleed);
    } finally {
      this.endBatch();
    }
  }

  private recordDab(
    texture: GPUTexture,
    params: StampParams,
    perDabBleed?: { radius: number; strength: number },
  ): void {
    const W = texture.width, H = texture.height;
    const bounds = dabDispatchBounds(params.cx, params.cy, params.radius, W, H);
    const fp = bounds?.footprint ?? null;
    const bleed = !!(perDabBleed && perDabBleed.strength > 0);
    // Erase modes (1,2,3) must bypass wet-stroke: the accum texture starts transparent,
    // so erasing transparent pixels (existing.a * (1-brush) = 0*anything = 0) is a no-op.
    // Erasing also *wants* opacity buildup (repeated strokes erase more), so direct is correct.
    const isEraseMode = params.mode !== 0;
    const wet = this.strokeActive && !!this.strokeBaseTex && !!this.strokeAccumTex && !isEraseMode;
    if (!fp && !(wet && bleed)) return;   // off-canvas dab: the old full copy + composite changed nothing

    this.reserveStaging(DAB_STAGING_BYTES);
    const ping = this.ensurePing(W, H);   // may flush (realloc) — fetch the encoder after
    const enc = this.encoder();

    if (wet) {
      // ── Indirect painting (wet-stroke) path ──
      const accum = this.strokeAccumTex!;
      // A batch composites into ONE output; a different output texture composites what's pending first.
      if (this.pendingOutput && this.pendingOutput !== texture) this.compositePending(enc);
      if (fp) {
        // Copy the footprint of strokeAccumTex → ping (for reading)
        const fw = fp.x1 - fp.x0, fh = fp.y1 - fp.y0;
        enc.copyTextureToTexture(
          { texture: accum, origin: { x: fp.x0, y: fp.y0 } },
          { texture: ping, origin: { x: fp.x0, y: fp.y0 } },
          { width: fw, height: fh },
        );
        this.stats.copiedTexels += fw * fh;
        // Stamp dab: read from ping (current accum), write to strokeAccumTex
        // The shader uses max-alpha blending for paint mode when strokeActive
        this.stampRecord(enc, ping, accum, { ...params, wetStroke: true });
        this.pendingComposite = unionRect(this.pendingComposite, fp);
        this.strokeAccumDirty = unionRect(this.strokeAccumDirty, fp);
      }
      // Per-dab bleed: spreads paint over the WHOLE accum layer (kept full-size: bounding it would change the
      // result), so the next composite must cover the whole texture too.
      if (bleed) {
        this.bleedRecord(enc, accum, perDabBleed!);
        this.pendingCompositeFull = true;
        this.strokeAccumDirty = { x0: 0, y0: 0, x1: W, y1: H };
      }
      this.strokeAccumUsed = true;
      this.pendingOutput = texture;
      return;
    }

    // ── Direct path (erase / blend modes / no stroke lifecycle) ──
    // It reads the output texture, so a deferred wet composite into it must land first.
    if (this.pendingOutput) this.compositePending(enc);
    const fw = fp!.x1 - fp!.x0, fh = fp!.y1 - fp!.y0;
    enc.copyTextureToTexture(
      { texture, origin: { x: fp!.x0, y: fp!.y0 } },
      { texture: ping, origin: { x: fp!.x0, y: fp!.y0 } },
      { width: fw, height: fh },
    );
    this.stats.copiedTexels += fw * fh;
    this.stampRecord(enc, ping, texture, params);
    this.strokeTouched = unionRect(this.strokeTouched, fp!);
    if (this.strokeActive) this.strokeOutputDirty = unionRect(this.strokeOutputDirty, fp!);
    if (!this.inProvisional) this.strokeDirectWrites = true;
  }

  /**
   * Read a single texel from a texture (async, 1-dab lag for smudge).
   * Copies the pixel to a staging buffer, maps it, and returns the RGBA (0-1).
   */
  public async samplePixel(
    texture: GPUTexture,
    x: number,
    y: number,
  ): Promise<[number, number, number, number]> {
    this.settleProvisional();
    this.flush();   // read what the dabs recorded so far actually wrote
    const px = Math.max(0, Math.min(texture.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(texture.height - 1, Math.round(y)));

    // bytesPerRow must be a multiple of 256; 1 pixel (4 bytes) → padded to 256
    const buf = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture, origin: { x: px, y: py, z: 0 } },
      { buffer: buf, bytesPerRow: 256 },
      { width: 1, height: 1 },
    );
    this.device.queue.submit([enc.finish()]);

    await buf.mapAsync(GPUMapMode.READ, 0, 4);
    const bytes = new Uint8Array(buf.getMappedRange(0, 4));
    const r = bytes[0] / 255;
    const g = bytes[1] / 255;
    const b = bytes[2] / 255;
    const a = bytes[3] / 255;
    buf.unmap();
    buf.destroy();

    return [r, g, b, a];
  }

  public destroy(): void {
    this.batchEnc = null;   // drop anything unsubmitted (the device objects die with us)
    this.batchDepth = 0;
    this.stagingCursor = 0;
    this.stagingBuf.destroy();
    this.compositeRectBuf.destroy();
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
    this.provisional = null;
    this.scratchOut?.destroy(); this.scratchOut = null;
    this.scratchAccum?.destroy(); this.scratchAccum = null;
    this.scratchW = 0; this.scratchH = 0;
    this.rectCopyBGs.length = 0;
    this.rectCopyBuf?.destroy(); this.rectCopyBuf = null;
    this.dummyMaskTex.destroy();
    this.dummyGrainTex.destroy();
    this.cachedBindGroup = null;
    this.cachedCompositeBG = null; this.cachedCompositeKey = null;
    this.cachedBleedBGs = null; this.cachedBleedAccum = null;
  }

  // ── Stroke composite helper ───────────────────────────────────────

  /**
   * Composite strokeAccum onto strokeBase over `rect` of outputTex (BRUSH-1: bounded — the rect origin/size go
   * in a staged uniform and the dispatch covers only the rect).
   * Uses standard alpha-over blending: output = base + accum composited on top.
   */
  private compositeRecord(
    enc: GPUCommandEncoder,
    baseTex: GPUTexture,
    accumTex: GPUTexture,
    outputTex: GPUTexture,
    rect: TexelRect,
  ): void {
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    if (w <= 0 || h <= 0) return;

    // E5: same three textures every dab of a stroke - rebuild only when one changes.
    const k = this.cachedCompositeKey;
    if (!this.cachedCompositeBG || !k || k[0] !== baseTex || k[1] !== accumTex || k[2] !== outputTex) {
      this.cachedCompositeBG = this.device.createBindGroup({
        layout: this.compositeBGL,
        entries: [
          { binding: 0, resource: baseTex.createView() },
          { binding: 1, resource: accumTex.createView() },
          { binding: 2, resource: outputTex.createView() },
          { binding: 3, resource: { buffer: this.compositeRectBuf } },
        ],
      });
      this.cachedCompositeKey = [baseTex, accumTex, outputTex];
    }

    this.compositeRectData[0] = rect.x0; this.compositeRectData[1] = rect.y0;
    this.compositeRectData[2] = w; this.compositeRectData[3] = h;
    this.stageUniform(enc, this.compositeRectBuf, this.compositeRectData);

    const pass = enc.beginComputePass();
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, this.cachedCompositeBG);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.stats.compositedTexels += w * h;
    this.recordedDirty = unionRect(this.recordedDirty, rect);   // BRUSH-5: the layer changed here
  }
  private compositeRectData = new Uint32Array(4);

  /** Record a clear of `tex` to transparent black (0,0,0,0) — a loadOp:'clear' render pass (BRUSH-1b; was a
   *  CPU zero-filled w×h×4 buffer upload every stroke). */
  private recordClear(enc: GPUCommandEncoder, tex: GPUTexture): void {
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: tex.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.end();
  }

  // ── Composite pipeline construction ───────────────────────────────

  private buildCompositePipeline(): void {
    const code = /* wgsl */ `
      @group(0) @binding(0) var baseTex: texture_2d<f32>;    // stroke base (pre-stroke snapshot)
      @group(0) @binding(1) var accumTex: texture_2d<f32>;   // stroke accumulation layer
      @group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;
      // rect: originX, originY, width, height (BRUSH-1: only the changed region is composited)
      @group(0) @binding(3) var<uniform> rect: vec4<u32>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        if (gid.x >= rect.z || gid.y >= rect.w) { return; }
        let dim = textureDimensions(output);
        let px = gid.x + rect.x;
        let py = gid.y + rect.y;
        if (px >= dim.x || py >= dim.y) { return; }
        let coords = vec2<i32>(i32(px), i32(py));

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
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
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
    this.flush();
    this.ensurePing(w, h);

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

  // ── Bleed / diffusion post-process ────────────────────────────────

  /**
   * Apply paint bleed/diffusion to the stroke accumulation texture.
   * Runs a two-pass separable Gaussian blur, then lerps with the original.
   */
  public applyBleed(
    accumTex: GPUTexture,
    settings: { radius: number; strength: number },
  ): void {
    this.beginBatch();
    try {
      this.reserveStaging(DAB_STAGING_BYTES);
      this.ensurePing(accumTex.width, accumTex.height);   // may flush — fetch the encoder after
      this.bleedRecord(this.encoder(), accumTex, settings);
    } finally {
      this.endBatch();
    }
  }

  /** Record the two blur passes into `enc` (E5: shares the per-dab encoder in stampWithPingPong).
   *  Bind groups are cached per (accumTex, pingTex) pair - they were rebuilt (4 createView) per dab. */
  private bleedRecord(
    enc: GPUCommandEncoder,
    accumTex: GPUTexture,
    settings: { radius: number; strength: number },
  ): void {
    this.ensureBleedPipeline();

    const w = accumTex.width;
    const h = accumTex.height;

    // The caller has ensured pingTex (ensurePing) BEFORE taking `enc` — reallocating here would destroy a
    // texture the open encoder may already reference.
    if (!this.pingTex || this.pingTexW !== w || this.pingTexH !== h) {
      throw new Error('BrushStampPipeline.bleedRecord: ping texture not prepared');
    }

    const p = this.bleedParamData;
    p[0] = Math.max(1, Math.round(settings.radius));
    p[1] = Math.max(0, Math.min(1, settings.strength));
    p[2] = 0; p[3] = 0;
    this.stageUniform(enc, this.bleedParamBuf, p);   // staged: per-dab bleeds can share one submit

    if (!this.cachedBleedBGs || this.cachedBleedAccum !== accumTex) {
      // Pass 1 - horizontal blur: accumTex → pingTex; pass 2 - vertical blur + lerp: pingTex → accumTex.
      this.cachedBleedBGs = [
        this.device.createBindGroup({
          layout: this.bleedBGL!,
          entries: [
            { binding: 0, resource: accumTex.createView() },
            { binding: 1, resource: this.pingTex!.createView() },
            { binding: 2, resource: { buffer: this.bleedParamBuf } },
          ],
        }),
        this.device.createBindGroup({
          layout: this.bleedBGL!,
          entries: [
            { binding: 0, resource: this.pingTex!.createView() },
            { binding: 1, resource: accumTex.createView() },
            { binding: 2, resource: { buffer: this.bleedParamBuf } },
          ],
        }),
      ];
      this.cachedBleedAccum = accumTex;
    }
    const [bg1, bg2] = this.cachedBleedBGs;

    const pass1 = enc.beginComputePass();
    pass1.setPipeline(this.bleedPipeline!);
    pass1.setBindGroup(0, bg1);
    pass1.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass1.end();

    const pass2 = enc.beginComputePass();
    pass2.setPipeline(this.bleedPipeline!);
    pass2.setBindGroup(0, bg2);
    pass2.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass2.end();
  }

  private ensureBleedPipeline(): void {
    if (this.bleedPipeline) return;

    // Single-pass shader used for both horizontal (pass1) and vertical (pass2).
    // On pass1: reads srcTex (accumTex), writes to dstTex (pingTex).
    // On pass2: reads srcTex (pingTex), writes back to dstTex (accumTex) with lerp.
    // The shader detects vertical pass by checking if the pingTex is the dst
    // by convention — both passes use the same shader; the lerp is always applied,
    // but the second pass's result goes to the final texture.
    const code = /* wgsl */ `
      @group(0) @binding(0) var srcTex:    texture_2d<f32>;
      @group(0) @binding(1) var dstTex:    texture_storage_2d<rgba8unorm, write>;
      // params: radius (float), strength (0-1), pad, pad
      @group(0) @binding(2) var<uniform> params: vec4<f32>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim  = textureDimensions(srcTex);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }
        let coords = vec2<i32>(i32(gid.x), i32(gid.y));

        let radius   = i32(params.x);
        let strength = params.y;
        let src      = textureLoad(srcTex, coords, 0);

        // Skip transparent pixels — don't spread emptiness into paint
        if (src.a <= 0.001 && strength < 0.99) {
          textureStore(dstTex, coords, src);
          return;
        }

        // Box blur: average neighbours along X axis (pass 1) or Y axis (pass 2).
        // We distinguish passes by sampling direction: pass1 samples horizontally
        // (caller binds accumTex as src), pass2 samples vertically (pingTex as src).
        // Since both passes use the same shader we just do a full 2D gather here
        // on the smaller radius to approximate a Gaussian in one dispatch per pass.
        var accum = vec4<f32>(0.0);
        var count = 0.0;
        for (var d = -radius; d <= radius; d = d + 1) {
          let sx = clamp(coords.x + d, 0, i32(dim.x) - 1);
          let sy = clamp(coords.y + d, 0, i32(dim.y) - 1);
          // Pass 1 (horizontal): vary x, fix y. Pass 2 (vertical): vary y, fix x.
          // We use the same kernel for both directions to keep code simple.
          let s1 = textureLoad(srcTex, vec2<i32>(sx, coords.y), 0);
          let s2 = textureLoad(srcTex, vec2<i32>(coords.x, sy), 0);
          accum += s1 + s2;
          count += 2.0;
        }
        // Always include center pixel once
        accum += src;
        count += 1.0;
        let blurred = accum / count;

        // Lerp between original and blurred by strength
        let result = mix(src, blurred, strength);
        textureStore(dstTex, coords, result);
      }
    `;

    this.bleedBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.bleedPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bleedBGL] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
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
