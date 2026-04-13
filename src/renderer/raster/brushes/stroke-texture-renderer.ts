/**
 * StrokeTextureRenderer — renders a textured strip along a stroke polyline.
 *
 * Instead of stamping individual dabs, this maps a rectangular texture along
 * the stroke path, creating continuous fibrous looks (charcoal, crayon, marker).
 *
 * Architecture:
 *   1. The stroke polyline (position + width at each vertex) is collected during the stroke.
 *   2. At endStroke (or incrementally), generate a triangle strip mesh along the path.
 *   3. UV-map the mesh: u = 0→1 across width, v tiles along length.
 *   4. A compute shader rasterizes the strip into the target texture using the stroke texture.
 *
 * Uses a compute-based software rasterizer to write directly to the storage texture,
 * avoiding the complexity of a separate render pipeline + framebuffer.
 */

export interface StrokeVertex {
  x: number;
  y: number;
  pressure: number;
  width: number;  // half-width at this vertex (radius)
}

export class StrokeTextureRenderer {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline | null = null;
  private bgl: GPUBindGroupLayout | null = null;

  // Buffers
  private vertexBuf: GPUBuffer | null = null;
  private paramBuf: GPUBuffer;
  private paramData = new Float32Array(8); // color(4), texelsPerUnit, edgeSoftness, numSegments, pad

  // Sampler for stroke texture
  private texSampler: GPUSampler;

  // Dummy 1x1 white texture for when no stroke texture is loaded
  private dummyTex: GPUTexture;

  constructor(device: GPUDevice) {
    this.device = device;

    this.paramBuf = device.createBuffer({
      size: 32, // 8 floats
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.texSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'repeat', // tile along stroke length
    });

    this.dummyTex = device.createTexture({
      size: [1, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.dummyTex },
      new Uint8Array([255]),
      { bytesPerRow: 1 },
      { width: 1, height: 1 },
    );
  }

  /**
   * Render a textured stroke onto the target texture.
   *
   * @param vertices The stroke polyline vertices (position + width).
   * @param targetTex The texture to render into (storage + texture binding).
   * @param strokeTex The grayscale stroke texture (r8unorm).
   * @param color RGBA color (0-1).
   * @param texelsPerUnit Texture tiling density along the stroke.
   * @param edgeSoftness Edge feather amount (0-1).
   */
  public render(
    vertices: StrokeVertex[],
    targetTex: GPUTexture,
    strokeTex: GPUTexture | null,
    color: [number, number, number, number],
    texelsPerUnit: number,
    edgeSoftness: number,
  ): void {
    if (vertices.length < 2) return;

    this.ensurePipeline();

    const tex = strokeTex ?? this.dummyTex;

    // Build segment data: each segment = [x0, y0, hw0, x1, y1, hw1, vStart, vEnd]
    // where hw = half-width, vStart/vEnd = accumulated V coordinate for UV tiling
    const numSegments = vertices.length - 1;
    const segmentData = new Float32Array(numSegments * 8);
    let accumV = 0;

    for (let i = 0; i < numSegments; i++) {
      const v0 = vertices[i];
      const v1 = vertices[i + 1];
      const dx = v1.x - v0.x;
      const dy = v1.y - v0.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);

      const vEnd = accumV + segLen * texelsPerUnit;

      segmentData[i * 8 + 0] = v0.x;
      segmentData[i * 8 + 1] = v0.y;
      segmentData[i * 8 + 2] = v0.width;
      segmentData[i * 8 + 3] = v1.x;
      segmentData[i * 8 + 4] = v1.y;
      segmentData[i * 8 + 5] = v1.width;
      segmentData[i * 8 + 6] = accumV;
      segmentData[i * 8 + 7] = vEnd;

      accumV = vEnd;
    }

    // Upload segment buffer
    if (this.vertexBuf) this.vertexBuf.destroy();
    this.vertexBuf = this.device.createBuffer({
      size: Math.max(32, segmentData.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuf, 0, segmentData);

    // Params: color(4), texelsPerUnit, edgeSoftness, numSegments, pad
    const p = this.paramData;
    p[0] = color[0]; p[1] = color[1]; p[2] = color[2]; p[3] = color[3];
    p[4] = texelsPerUnit; p[5] = edgeSoftness; p[6] = numSegments; p[7] = 0;
    this.device.queue.writeBuffer(this.paramBuf, 0, p);

    const bg = this.device.createBindGroup({
      layout: this.bgl!,
      entries: [
        { binding: 0, resource: targetTex.createView() },
        { binding: 1, resource: tex.createView() },
        { binding: 2, resource: this.texSampler },
        { binding: 3, resource: { buffer: this.paramBuf } },
        { binding: 4, resource: { buffer: this.vertexBuf } },
      ],
    });

    const w = targetTex.width;
    const h = targetTex.height;
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  public destroy(): void {
    this.vertexBuf?.destroy();
  }

  private ensurePipeline(): void {
    if (this.pipeline) return;

    // The shader iterates over all segments for each pixel and finds the closest one,
    // then computes the UV and samples the texture. This is O(pixels × segments) but
    // segments are typically <100 and the GPU handles it fine.
    const code = /* wgsl */ `
      @group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(1) var strokeTex: texture_2d<f32>;
      @group(0) @binding(2) var strokeSamp: sampler;
      // params: r, g, b, a, texelsPerUnit, edgeSoftness, numSegments, pad
      @group(0) @binding(3) var<uniform> params: array<f32, 8>;
      // segments: array of [x0, y0, hw0, x1, y1, hw1, vStart, vEnd]
      @group(0) @binding(4) var<storage, read> segments: array<f32>;

      // Project point P onto segment AB, return (t, perpDistance, halfWidth, vCoord)
      fn projectOntoSegment(px: f32, py: f32, segIdx: i32) -> vec4<f32> {
        let base = segIdx * 8;
        let ax = segments[base + 0];
        let ay = segments[base + 1];
        let hw0 = segments[base + 2];
        let bx = segments[base + 3];
        let by = segments[base + 4];
        let hw1 = segments[base + 5];
        let vStart = segments[base + 6];
        let vEnd = segments[base + 7];

        let dx = bx - ax;
        let dy = by - ay;
        let lenSq = dx * dx + dy * dy;

        if (lenSq < 0.001) {
          // Degenerate segment
          let dist = sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
          return vec4<f32>(0.0, dist, hw0, vStart);
        }

        // t = projection parameter along segment (0 = start, 1 = end)
        var t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        t = clamp(t, 0.0, 1.0);

        // Closest point on segment
        let cpx = ax + t * dx;
        let cpy = ay + t * dy;

        // Perpendicular distance
        let perpDist = sqrt((px - cpx) * (px - cpx) + (py - cpy) * (py - cpy));

        // Interpolated half-width and V coordinate
        let hw = mix(hw0, hw1, t);
        let vCoord = mix(vStart, vEnd, t);

        return vec4<f32>(t, perpDist, hw, vCoord);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let dim = textureDimensions(output);
        if (gid.x >= dim.x || gid.y >= dim.y) { return; }

        let px = f32(gid.x) + 0.5;
        let py = f32(gid.y) + 0.5;

        let colorR = params[0];
        let colorG = params[1];
        let colorB = params[2];
        let colorA = params[3];
        let edgeSoftness = params[5];
        let numSegs = i32(params[6]);

        // Find the closest segment
        var bestDist = 1e10;
        var bestU = 0.5;  // U coordinate (0-1 across width)
        var bestV = 0.0;  // V coordinate (tiles along length)
        var bestInside = false;

        for (var s = 0; s < numSegs; s = s + 1) {
          let proj = projectOntoSegment(px, py, s);
          let perpDist = proj.y;
          let hw = proj.z;
          let vCoord = proj.w;

          if (perpDist < bestDist) {
            bestDist = perpDist;

            // U: map perpendicular distance to 0-1 across the stroke width
            // Center = 0.5, edges = 0 and 1
            if (hw > 0.001) {
              // Signed perpendicular: determine which side of the segment
              let base = s * 8;
              let ax = segments[base + 0]; let ay = segments[base + 1];
              let bx = segments[base + 3]; let by = segments[base + 4];
              let segDx = bx - ax; let segDy = by - ay;
              // Normal direction (left-hand perpendicular)
              let cross = (px - ax) * segDy - (py - ay) * segDx;
              let side = select(1.0, -1.0, cross < 0.0);
              bestU = 0.5 + side * (perpDist / hw) * 0.5;
              bestU = clamp(bestU, 0.0, 1.0);
            } else {
              bestU = 0.5;
            }

            bestV = vCoord;
            bestInside = perpDist <= hw;
          }
        }

        if (!bestInside) { return; }

        // Read the existing pixel (for alpha compositing)
        // Note: we can't textureLoad from a storage texture, so we use max-alpha accumulation
        // by only writing pixels with non-zero alpha (the compositor handles the rest).

        // Edge softness: smooth falloff near the stroke border
        var edgeAlpha = 1.0;
        if (edgeSoftness > 0.001 && bestDist > 0.0) {
          // Find the half-width of the closest segment for edge calculation
          var closestHW = 1.0;
          var minD = 1e10;
          for (var s2 = 0; s2 < numSegs; s2 = s2 + 1) {
            let proj2 = projectOntoSegment(px, py, s2);
            if (proj2.y < minD) {
              minD = proj2.y;
              closestHW = proj2.z;
            }
          }
          let edgeStart = closestHW * (1.0 - edgeSoftness);
          if (bestDist > edgeStart) {
            edgeAlpha = 1.0 - smoothstep(edgeStart, closestHW, bestDist);
          }
        }

        // Sample the stroke texture
        let texVal = textureSampleLevel(strokeTex, strokeSamp, vec2<f32>(bestU, bestV), 0.0).r;

        let finalAlpha = colorA * texVal * edgeAlpha;
        if (finalAlpha <= 0.001) { return; }

        textureStore(output, vec2<i32>(i32(gid.x), i32(gid.y)),
          vec4<f32>(colorR, colorG, colorB, finalAlpha));
      }
    `;

    this.bgl = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
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
