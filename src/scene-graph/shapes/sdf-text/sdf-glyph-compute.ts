// sdf-glyph-compute.ts
export class SDFGlyphCompute {
  constructor(private device: GPUDevice) {
    this.createPipelines();
    this.sampler = device.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    });
    //device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  }

  private sampler: GPUSampler;
  private initPipeline!: GPUComputePipeline;
  private jfaPipeline!: GPUComputePipeline;
  private finalizePipeline!: GPUComputePipeline;

  // Reused per-glyph temporary textures, resized as needed
  private tempMask?: GPUTexture;     // rgba8unorm, TEXTURE_BINDING|COPY_DST
  private seedA?: GPUTexture;        // rgba32float, TEXTURE_BINDING|STORAGE_BINDING
  private seedB?: GPUTexture;        // rgba32float, TEXTURE_BINDING|STORAGE_BINDING
  private tempW = 0;
  private tempH = 0;

  // simple temp retire (mirrors the atlas buckets)
  private tempBuckets: GPUTexture[][] = [[], []];
  private tempBucketCursor = 0;
  private retireTemp(t?: GPUTexture | null) { if (t) this.tempBuckets[this.tempBucketCursor].push(t); }
  public async sweepComputeTemps(queue: GPUQueue) {
    this.tempBucketCursor ^= 1;
    queue.onSubmittedWorkDone();
    for (const t of this.tempBuckets[this.tempBucketCursor]) { try { t.destroy(); } catch {} }
    this.tempBuckets[this.tempBucketCursor].length = 0;
  }

  private createPipelines() {
    const initWGSL = /* wgsl */`
      @group(0) @binding(0) var inputMask : texture_2d<f32>; // sampled, rgba8unorm
      @group(0) @binding(1) var seedOut   : texture_storage_2d<rgba32float, write>; // storage, rgba32float
      @group(0) @binding(2) var samp      : sampler;

      struct InitParams {
        width  : u32,
        height : u32,
        thr    : f32,
        _pad   : f32,
      };
      @group(0) @binding(3) var<uniform> P : InitParams;

      @compute @workgroup_size(8,8)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        if (gid.x >= P.width || gid.y >= P.height) { return; }
        let p   = vec2<i32>(i32(gid.x), i32(gid.y));
        let a   = textureLoad(inputMask, p, 0).r;

        // 4-neighbor edge test
        var isEdge = false;
        let dirs = array<vec2<i32>,4>(vec2<i32>(1,0), vec2<i32>(-1,0), vec2<i32>(0,1), vec2<i32>(0,-1));
        for (var i = 0; i < 4; i++) {
          let q = p + dirs[i];
          if (q.x >= 0 && q.y >= 0 && q.x < i32(P.width) && q.y < i32(P.height)) {
            let b = textureLoad(inputMask, q, 0).r;
            if ((a >= P.thr && b < P.thr) || (a < P.thr && b >= P.thr)) { isEdge = true; }
          }
        }

        // seed stores nearest edge coord in xy; zw unused
        if (isEdge) {
          textureStore(seedOut, p, vec4<f32>(f32(p.x), f32(p.y), 0.0, 0.0));
        } else {
          textureStore(seedOut, p, vec4<f32>(-1e9, -1e9, 0.0, 0.0));
        }
      }
    `;

    const jfaWGSL = /* wgsl */`
      @group(0) @binding(0) var seedInTex  : texture_2d<f32>; // sampled, rgba32float
      @group(0) @binding(1) var seedOutTex : texture_storage_2d<rgba32float, write>; // storage, rgba32float

      struct StepParams {
        width  : u32,
        height : u32,
        stepPx : i32,
        _pad   : i32,
      };
      @group(0) @binding(2) var<uniform> S : StepParams;

      @compute @workgroup_size(8,8)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        if (gid.x >= S.width || gid.y >= S.height) { return; }
        let p = vec2<i32>(i32(gid.x), i32(gid.y));

        var best = textureLoad(seedInTex, p, 0).xy;
        var bestDist = 1e18;

        if (best.x > -1e8) {
          let d = vec2<f32>(best - vec2<f32>(f32(p.x), f32(p.y)));
          bestDist = dot(d,d);
        }

        let s = S.stepPx;
        let offs = array<vec2<i32>,8>(
          vec2<i32>( s, 0), vec2<i32>(-s, 0), vec2<i32>(0,  s), vec2<i32>(0, -s),
          vec2<i32>( s, s), vec2<i32>( s,-s), vec2<i32>(-s, s), vec2<i32>(-s,-s)
        );

        for (var i=0; i<8; i++) {
          let q = p + offs[i];
          if (q.x < 0 || q.y < 0 || q.x >= i32(S.width) || q.y >= i32(S.height)) { continue; }
          let c = textureLoad(seedInTex, q, 0).xy;
          if (c.x <= -1e8) { continue; }
          let d = vec2<f32>(c - vec2<f32>(f32(p.x), f32(p.y)));
          let dd = dot(d,d);
          if (dd < bestDist) { bestDist = dd; best = c; }
        }

        textureStore(seedOutTex, p, vec4<f32>(best, 0.0, 0.0));
      }
    `;

    const finalizeWGSL = /* wgsl */`
      @group(0) @binding(0) var inputMask : texture_2d<f32>; // sampled, rgba8unorm
      @group(0) @binding(1) var seedTex   : texture_2d<f32>; // sampled, rgba32float
      @group(0) @binding(2) var atlasOut  : texture_storage_2d<rgba8unorm, write>; // storage, rgba8unorm

      struct FinalParams {
        width     : u32,
        height    : u32,
        thr       : f32,
        maxDistPx : f32,
        atlasX    : u32,
        atlasY    : u32,
        _pad0     : u32,
        _pad1     : u32,
      };
      @group(0) @binding(3) var<uniform> F : FinalParams;

      @compute @workgroup_size(8,8)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        if (gid.x >= F.width || gid.y >= F.height) { return; }
        let p    = vec2<i32>(i32(gid.x), i32(gid.y));
        let seed = textureLoad(seedTex, p, 0).xy;

        var dist = 1e6;
        if (seed.x > -1e8) {
          let d = vec2<f32>(seed - vec2<f32>(f32(p.x), f32(p.y)));
          dist = sqrt(dot(d,d));
        }

        // sign from mask
        let a = textureLoad(inputMask, p, 0).r;
        let s = select(1.0, -1.0, a >= F.thr); // outside positive

        let sdf01 = clamp(0.5 + s * (dist / F.maxDistPx) * 0.5, 0.0, 1.0);

        let outXY = vec2<i32>(i32(F.atlasX) + p.x, i32(F.atlasY) + p.y);
        textureStore(atlasOut, outXY, vec4<f32>(sdf01, 1.0, 1.0, 1.0));
      }
    `;

    this.initPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } }, // inputMask (rgba8unorm, so float is good)
            { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: {} },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          ]
        })]
      }),
      compute: { module: this.device.createShaderModule({ code: initWGSL }), entryPoint: 'main' }
    });

    this.jfaPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } }, // seedInTex (rgba32float, so we gotta use unfilterable-float)
            { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          ]
        })]
      }),
      compute: { module: this.device.createShaderModule({ code: jfaWGSL }), entryPoint: 'main' }
    });

    this.finalizePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } }, // inputMask (rgba8unorm)
            { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } }, // seedTex (rgba32float)
            { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          ]
        })]
      }),
      compute: { module: this.device.createShaderModule({ code: finalizeWGSL }), entryPoint: 'main' }
    });
  }

  private ensureTemps(w: number, h: number) {
    const W = Math.max(w, this.tempW);
    const H = Math.max(h, this.tempH);
    if (this.tempMask && W <= this.tempW && H <= this.tempH) return;

    // allocate new, DO NOT destroy old immediately
    const newMask = this.device.createTexture({
      size: { width: W, height: H },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const seedUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const newA = this.device.createTexture({ size: { width: W, height: H }, format: 'rgba32float', usage: seedUsage });
    const newB = this.device.createTexture({ size: { width: W, height: H }, format: 'rgba32float', usage: seedUsage });

    // retire old AFTER next frame submit (use the atlas' same sweeper, or add one here)
    this.retireTemp(this.tempMask); this.retireTemp(this.seedA); this.retireTemp(this.seedB);

    this.tempMask = newMask;
    this.seedA = newA;
    this.seedB = newB;
    this.tempW = W; this.tempH = H;
  }

  run({
    canvas,
    width, height,
    atlasTexture,
    atlasX, atlasY,
    threshold = 0.5,
    maxDistPx = 32
  }: {
    canvas: OffscreenCanvas | HTMLCanvasElement | ImageBitmap,
    width: number, height: number,
    atlasTexture: GPUTexture,
    atlasX: number, atlasY: number,
    threshold?: number,
    maxDistPx?: number
  }) {
    this.ensureTemps(width, height);

    const encoder = this.device.createCommandEncoder();

    // 1) Upload the glyph mask from canvas → tempMask (avoids 256B row padding issues)
    // NOTE: the canvas you pass should already contain the white-on-black glyph.
    // OffscreenCanvas works here in Chromium
    (this.device.queue as any).copyExternalImageToTexture(
      { source: canvas },
      { texture: this.tempMask! },
      { width, height }
    );

    // 2) Init seeds
    {
    //   const params = new Float32Array([width, height, threshold, 0]); // 4*4 bytes
    //   const ub = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    //   this.device.queue.writeBuffer(ub, 0, params);
      const ub = this.makeInitUBO(width, height, threshold);

      const bg = this.device.createBindGroup({
        layout: this.initPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.tempMask!.createView() },
          { binding: 1, resource: this.seedA!.createView() },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: { buffer: ub } },
        ]
      });

      const pass = encoder.beginComputePass();
      pass.setPipeline(this.initPipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(width/8), Math.ceil(height/8));
      pass.end();
    }

    // 3) JFA steps
    let step = 1;
    while (step < Math.max(width, height)) step <<= 1;

    let pingIn = this.seedA!, pingOut = this.seedB!;
    for (; step >= 1; step >>= 1) {
      const stepUB = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(stepUB, 0, new Int32Array([width, height, step, 0]));

      const bg = this.device.createBindGroup({
        layout: this.jfaPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: pingIn.createView() },      // sampled read
          { binding: 1, resource: pingOut.createView() },     // storage write
          { binding: 2, resource: { buffer: stepUB } },
        ]
      });

      const pass = encoder.beginComputePass();
      pass.setPipeline(this.jfaPipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(width/8), Math.ceil(height/8));
      pass.end();

      // swap
      const tmp = pingIn; pingIn = pingOut; pingOut = tmp;
    }

    // 4) Finalize → write signed+normalized SDF into atlas at (atlasX, atlasY)
    {
      // 32-byte params, 16B aligned
    //   const p = new Float32Array([
    //     width, height, threshold, maxDistPx,
    //     atlasX, atlasY, 0, 0
    //   ]);
    //   const ub = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    //   this.device.queue.writeBuffer(ub, 0, p);

      const ub = this.makeFinalUBO(width, height, threshold, maxDistPx, atlasX, atlasY);

      const bg = this.device.createBindGroup({
        layout: this.finalizePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.tempMask!.createView() },
          { binding: 1, resource: pingIn.createView() },         // nearest edge coords
          { binding: 2, resource: atlasTexture.createView() },   // STORAGE write
          { binding: 3, resource: { buffer: ub } },
        ]
      });

      const pass = encoder.beginComputePass();
      pass.setPipeline(this.finalizePipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(width/8), Math.ceil(height/8));
      pass.end();
    }

    this.device.queue.submit([encoder.finish()]);
  }

  // --- helpers to pack WGSL structs with mixed ints/floats ---
    private makeInitUBO(width: number, height: number, thr: number): GPUBuffer {
    const buf = new ArrayBuffer(16);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    u32[0] = width >>> 0;   // width : u32
    u32[1] = height >>> 0;  // height: u32
    f32[2] = thr;           // thr   : f32
    f32[3] = 0.0;           // _pad  : f32
    const ub = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ub, 0, buf);
    return ub;
    }

    private makeFinalUBO(
    width: number, height: number, thr: number, maxDistPx: number, atlasX: number, atlasY: number
    ): GPUBuffer {
    const buf = new ArrayBuffer(32);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    u32[0] = width >>> 0;     // width   : u32
    u32[1] = height >>> 0;    // height  : u32
    f32[2] = thr;             // thr     : f32
    f32[3] = maxDistPx;       // maxDist : f32
    u32[4] = atlasX >>> 0;    // atlasX  : u32
    u32[5] = atlasY >>> 0;    // atlasY  : u32
    u32[6] = 0;               // _pad0   : u32
    u32[7] = 0;               // _pad1   : u32
    const ub = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ub, 0, buf);
    return ub;
    }
}
