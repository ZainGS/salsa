/**
 * src/ui/kit/kit-renderer.ts
 *
 * GPU renderer for the UI kit: ONE pipeline, one instanced draw (6 vertices x N prims). The fragment shader shades
 * each prim analytically — convex-quad / burst-star / ellipse / radial-ray SDFs with 1-px anti-aliasing, jagged torn
 * edges, screen-tone patterns (halftone, stripes, gradient dots, cross lines, checker) and a fade mask — or samples
 * the text atlas (fill + outline channels). Nothing is tessellated, so a full HUD is a few hundred quads.
 *
 * It draws onto the FINAL swapchain image after post-processing (WebGPURenderer.setUIKitOverlayDrawer), so the kit is
 * always at full canvas resolution: TAAU, dynamic resolution, the lo-fi pass, bloom and grading never touch it.
 */

import { PRIM_FLOATS, type PrimList } from './kit-prims';
import { KitTextAtlas } from './kit-text-atlas';

export const UI_KIT_WGSL = /* wgsl */ `
struct Prim {
  a: vec4f,  // centre xy, local half extents zw (device px)
  b: vec4f,  // rotation, kind, flags, jag amplitude
  c: vec4f,  // colour (straight rgba)
  d: vec4f,  // colour 2 (pattern / outline / alternate stripe)
  e: vec4f,  // kind data (poly v0 v1 | glyph uv rect | star spikes inner phase irregular | ring)
  f: vec4f,  // kind data (poly v2 v3 | radii)
  g: vec4f,  // pattern type, cell px, angle, amount
  h: vec4f,  // jag wavelength, seed, fade mode, unused
};
struct U { size: vec2f, time: f32, pad: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> prims: array<Prim>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) id: u32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let p = prims[ii];
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let l = corners[vi] * p.a.zw;
  let cr = cos(p.b.x);
  let sr = sin(p.b.x);
  let w = p.a.xy + vec2f(cr * l.x - sr * l.y, sr * l.x + cr * l.y);
  var o: VO;
  o.pos = vec4f(w.x / u.size.x * 2.0 - 1.0, 1.0 - w.y / u.size.y * 2.0, 0.0, 1.0);
  o.local = l;
  o.id = ii;
  return o;
}

fn hash11(x: f32) -> f32 { return fract(sin(x * 127.1 + 311.7) * 43758.5453); }

fn cross2(a: vec2f, b: vec2f) -> f32 { return a.x * b.y - a.y * b.x; }

// Zigzag profile for torn edges: alternating peaks and troughs with random heights, 0..1.
fn jagProfile(x: f32) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let h0 = select(0.1 * hash11(i), 0.55 + 0.45 * hash11(i), (i - 2.0 * floor(i * 0.5)) < 0.5);
  let i1 = i + 1.0;
  let h1 = select(0.1 * hash11(i1), 0.55 + 0.45 * hash11(i1), (i1 - 2.0 * floor(i1 * 0.5)) < 0.5);
  return mix(h0, h1, f);
}

// Signed distance (px) to a convex quad (v3 may repeat v2 = triangle), with optional jag along the nearest edge.
fn sdPoly(p: vec2f, pr: Prim) -> f32 {
  var v: array<vec2f, 4>;
  v[0] = pr.e.xy; v[1] = pr.e.zw; v[2] = pr.f.xy; v[3] = pr.f.zw;
  var area = 0.0;
  for (var i = 0u; i < 4u; i++) { area += cross2(v[i], v[(i + 1u) % 4u]); }
  let s = select(-1.0, 1.0, area >= 0.0);
  var dmin = 1e9;
  var inside = true;
  var edge = 0.0;
  var along = 0.0;
  for (var i = 0u; i < 4u; i++) {
    let a = v[i];
    let b = v[(i + 1u) % 4u];
    let ba = b - a;
    let len2 = dot(ba, ba);
    if (len2 < 1e-6) { continue; }
    let pa = p - a;
    let h = clamp(dot(pa, ba) / len2, 0.0, 1.0);
    let dd = length(pa - ba * h);
    if (dd < dmin) { dmin = dd; edge = f32(i); along = h * sqrt(len2); }
    if (s * cross2(ba, pa) < 0.0) { inside = false; }
  }
  var d = select(dmin, -dmin, inside);
  let amp = pr.b.w;
  if (amp > 0.0) {
    d += amp * jagProfile(along / max(pr.h.x, 1.0) + pr.h.y * 13.17 + edge * 7.31);
  }
  return d;
}

// Burst star in ellipse space; returns an approximate px distance.
fn sdStar(p: vec2f, pr: Prim) -> f32 {
  let rad = max(pr.f.xy, vec2f(1.0));
  let q = p / rad;
  let len = length(q);
  let n = max(3.0, pr.e.x);
  let ang = atan2(q.y, q.x) - pr.e.z;
  let sec = ang / 6.2831853 * n;
  let idx = floor(sec);
  let fr = fract(sec);
  let iw = idx - n * floor(idx / n);
  let outer = 1.0 - pr.e.w * hash11(iw + 3.0);
  let rr = mix(pr.e.y, outer, 1.0 - abs(fr * 2.0 - 1.0));
  let g = length(q / rad) / max(len, 1e-4);
  return (len - rr) / max(g, 1e-5);
}

fn sdEllipse(p: vec2f, pr: Prim) -> f32 {
  let rad = max(pr.f.xy, vec2f(1.0));
  let q = p / rad;
  let len = length(q);
  let g = length(q / rad) / max(len, 1e-4);
  var d = (len - 1.0) / max(g, 1e-5);
  if (pr.e.x > 0.0) { d = abs(d + pr.e.x * 0.5) - pr.e.x * 0.5; }
  return d;
}

fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x + s * v.y, -s * v.x + c * v.y);
}

// Screen-tone pattern coverage 0..1 at screen position sp.
fn pattern(sp: vec2f, local: vec2f, pr: Prim) -> f32 {
  let kind = pr.g.x;
  if (kind < 0.5) { return 0.0; }
  let cell = max(pr.g.y, 2.0);
  let r = rot2(sp, pr.g.z);
  let amt = pr.g.w;
  if (kind < 1.5 || (kind > 2.5 && kind < 3.5)) {
    var a = amt;
    if (kind > 2.5) {
      // gradient dots: radius ramps across the prim (local x, rotated by the pattern angle)
      let n = local / max(pr.a.zw, vec2f(1.0));
      a = amt * clamp(0.5 + 0.5 * dot(n, vec2f(cos(pr.g.z - pr.b.x), sin(pr.g.z - pr.b.x))), 0.0, 1.0);
    }
    let cp = (fract(r / cell) - 0.5) * cell;
    let rad = a * cell * 0.62;
    return clamp(rad - length(cp) + 0.5, 0.0, 1.0);
  }
  if (kind < 2.5) {
    let v = fract(r.x / cell) * cell;
    let w = amt * cell;
    return clamp(min(v, w - v) + 0.5, 0.0, 1.0) * select(0.0, 1.0, w > 0.0);
  }
  if (kind < 4.5) {
    let w = max(1.0, amt * cell * 0.35);
    let vx = fract(r.x / cell) * cell;
    let vy = fract(r.y / cell) * cell;
    let lx = clamp(min(vx, w - vx) + 0.5, 0.0, 1.0);
    let ly = clamp(min(vy, w - vy) + 0.5, 0.0, 1.0);
    return max(lx, ly);
  }
  let cx = floor(r.x / cell) + floor(r.y / cell);
  return select(0.0, 1.0, (cx - 2.0 * floor(cx * 0.5)) > 0.5) * amt;
}

fn fadeMask(local: vec2f, pr: Prim) -> f32 {
  let m = pr.h.z;
  if (m < 0.5) { return 1.0; }
  let n = local / max(pr.a.zw, vec2f(1.0));
  if (m < 1.5) { return clamp(0.5 - 0.5 * n.x, 0.0, 1.0) * 1.4; }
  if (m < 2.5) { return clamp(0.5 + 0.5 * n.x, 0.0, 1.0) * 1.4; }
  if (m < 3.5) { return clamp(0.5 - 0.5 * n.y, 0.0, 1.0) * 1.4; }
  if (m < 4.5) { return clamp(0.5 + 0.5 * n.y, 0.0, 1.0) * 1.4; }
  return clamp(length(n) * 0.9, 0.0, 1.0);
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let pr = prims[i.id];
  let kind = pr.b.y;
  let p = i.local;
  if (kind > 2.5 && kind < 3.5) {
    // glyph: R = fill, G = fill plus outline
    let uvn = p / max(pr.a.zw, vec2f(1e-3)) * 0.5 + 0.5;
    let uv = mix(pr.e.xy, pr.e.zw, uvn);
    let t = textureSampleLevel(atlas, samp, uv, 0.0);
    let fillA = t.r;
    let allA = max(t.g, t.r);
    if (pr.b.z > 0.5) {
      let a = allA * pr.c.a;
      return vec4f(pr.c.rgb * a, a);
    }
    let fa = fillA * pr.c.a;
    let oa = max(allA - fillA, 0.0) * pr.d.a;
    return vec4f(pr.c.rgb * fa + pr.d.rgb * oa, fa + oa);
  }
  var d = 0.0;
  var base = pr.c;
  if (kind < 0.5) {
    d = sdPoly(p, pr);
  } else if (kind < 1.5) {
    d = sdStar(p, pr);
  } else if (kind < 2.5) {
    d = sdEllipse(p, pr);
  } else {
    // radial rays: alternate c / d wedges inside the ellipse, with a hole
    let rad = max(pr.f.xy, vec2f(1.0));
    let q = p / rad;
    let len = length(q);
    let g = length(q / rad) / max(len, 1e-4);
    d = (len - 1.0) / max(g, 1e-5);
    let hole = pr.e.y;
    d = max(d, (hole - len) / max(g, 1e-5));
    let n = max(2.0, pr.e.x);
    let s = fract((atan2(q.y, q.x) / 6.2831853 + 0.5) * n + pr.e.z);
    let edgePx = min(s, abs(0.5 - s)) / n * 6.2831853 * len / max(g, 1e-5);
    let hard = select(1.0, 0.0, s < 0.5);
    let mixv = mix(0.5, hard, clamp(edgePx * 2.0, 0.0, 1.0));
    base = mix(pr.c, pr.d, mixv);
  }
  let cov = clamp(0.5 - d, 0.0, 1.0) * fadeMask(p, pr);
  if (cov <= 0.0) { discard; }
  // pattern over the base colour
  let m = pattern(i.pos.xy, p, pr) * pr.d.a;
  var rgb = base.rgb * base.a;
  var a = base.a;
  if (kind < 2.5 && pr.g.x > 0.5) {
    rgb = pr.d.rgb * m + rgb * (1.0 - m);
    a = m + a * (1.0 - m);
  }
  return vec4f(rgb * cov, a * cov);
}
`;

/** Instanced kit renderer (owns the pipeline, prim buffer and text atlas). */
export class UIKitRenderer {
  readonly atlas = new KitTextAtlas();
  private _device: GPUDevice | null = null;
  private _gen = -1;
  private _format: GPUTextureFormat | null = null;
  private _pipe: GPURenderPipeline | null = null;
  private _ubuf: GPUBuffer | null = null;
  private _sbuf: GPUBuffer | null = null;
  private _sbufFloats = 0;
  private _bg: GPUBindGroup | null = null;
  private _bgAtlasVersion = -1;
  private _sampler: GPUSampler | null = null;
  private readonly _u = new Float32Array(4);

  /** Bind to a device + swapchain format (rebuilds on a new device generation or format). */
  prepare(device: GPUDevice, format: GPUTextureFormat, generation = 0): void {
    if (this._device === device && this._gen === generation && this._format === format && this._pipe) return;
    this._device = device; this._gen = generation; this._format = format;
    this.atlas.setDevice(device);
    const module = device.createShaderModule({ label: 'UIKitShader', code: UI_KIT_WGSL });
    this._pipe = device.createRenderPipeline({
      label: 'UIKitPipeline', layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format, blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this._ubuf = device.createBuffer({ label: 'UIKitUniforms', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this._sbuf = null; this._sbufFloats = 0; this._bg = null;
  }

  /** Draw a built prim list onto `view` (load + store; no depth). */
  draw(encoder: GPUCommandEncoder, view: GPUTextureView, W: number, H: number, list: PrimList, timeMs: number): void {
    const device = this._device;
    if (!device || !this._pipe || !this._ubuf || list.count === 0 || !this.atlas.texture) return;
    const need = list.count * PRIM_FLOATS;
    if (!this._sbuf || this._sbufFloats < need) {
      this._sbuf?.destroy();
      this._sbufFloats = Math.max(need, PRIM_FLOATS * 512, this._sbufFloats * 2);
      this._sbuf = device.createBuffer({ label: 'UIKitPrims', size: this._sbufFloats * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this._bg = null;
    }
    if (!this._bg || this._bgAtlasVersion !== this.atlas.version) {
      this._bg = device.createBindGroup({ layout: this._pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this._ubuf } },
        { binding: 1, resource: { buffer: this._sbuf } },
        { binding: 2, resource: this.atlas.texture.createView() },
        { binding: 3, resource: this._sampler! },
      ] });
      this._bgAtlasVersion = this.atlas.version;
    }
    this._u[0] = W; this._u[1] = H; this._u[2] = timeMs * 0.001; this._u[3] = 0;
    device.queue.writeBuffer(this._ubuf, 0, this._u);
    device.queue.writeBuffer(this._sbuf, 0, list.data.buffer, list.data.byteOffset, need * 4);
    const pass = encoder.beginRenderPass({ label: 'UIKitPass', colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this._pipe);
    pass.setBindGroup(0, this._bg);
    pass.draw(6, list.count);
    pass.end();
  }
}
