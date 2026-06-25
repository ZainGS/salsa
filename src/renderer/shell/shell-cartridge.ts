/**
 * shell-cartridge.ts — The top-section 3D viewer for the Shell UI.
 *
 * Renders the selected cart as a slowly spinning, gently bobbing cartridge
 * (a GBA/DS-style slab with a distinct front label face), or — in the
 * Illustrations dashboard — a flatter "sketchbook" variant. It is a small,
 * self-contained 3D pipeline (its own MVP + a single directional light),
 * deliberately not the engine's full Renderer3D, to keep the shell
 * decoupled and cheap.
 *
 * It owns its own render pass (loading the color the 2D grid pass already
 * drew, with its own depth buffer) and is constrained to the top region of
 * the canvas via the viewport. Idle animation is driven by a wall-clock
 * time value, matching the cadence in docs/specs/shell-ui.md:
 *   • spin  — one Y revolution per 12s
 *   • bob   — sine on Y, 2s period, ~5% of height
 *   • tilt  — fixed ~10° on X toward the viewer
 */

import { mat4 } from 'gl-matrix';
import type { ViewerSpec } from './shell-layout';
import type { ShellThumbnailAtlas } from './shell-thumbnails';
import type { Billboard3DGeometry } from '../3d/billboard-3d';

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

// Uniform layout: mvp(64) + model(64) + body(16) + label(16) + light(16) + uvRect(16) + sideColor(16) = 208.
// light.w doubles as a 0/1 "use thumbnail" flag. sideColor is used by the
// billboard pipeline only (the cartridge shader reads just the 192-byte prefix).
const UNIFORM_SIZE = 208;

const SHADER = /* wgsl */ `
struct U {
  mvp: mat4x4<f32>,
  model: mat4x4<f32>,
  bodyColor: vec4<f32>,
  labelColor: vec4<f32>,
  lightDir: vec4<f32>,   // xyz = direction to light; w = useThumb (0/1)
  uvRect: vec4<f32>,     // thumbnail atlas u0,v0,u1,v1
};
@group(0) @binding(0) var<uniform> u: U;
@group(1) @binding(0) var thumbTex: texture_2d<f32>;
@group(1) @binding(1) var thumbSmp: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) isFront: f32,
  @location(2) uv: vec2<f32>,
};

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) isFront: f32,
) -> VsOut {
  var out: VsOut;
  out.pos = u.mvp * vec4<f32>(position, 1.0);
  out.normal = (u.model * vec4<f32>(normal, 0.0)).xyz;
  out.isFront = isFront;
  out.uv = uv;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let l = normalize(u.lightDir.xyz);
  let diff = max(dot(n, l), 0.0);
  let shade = 0.35 + diff * 0.75;

  // Sample the thumbnail unconditionally (uniform control flow), mapping the
  // inset region [b,1-b] to the tile's atlas UV rect.
  let b = 0.12;
  let tuv = clamp((in.uv - vec2<f32>(b, b)) / (1.0 - 2.0 * b), vec2<f32>(0.0), vec2<f32>(1.0));
  let auv = mix(u.uvRect.xy, u.uvRect.zw, tuv);
  let thumbRGB = textureSample(thumbTex, thumbSmp, auv).rgb;
  let labelRGB = mix(u.labelColor.rgb, thumbRGB, u.lightDir.w);

  var base = u.bodyColor.rgb;
  if (in.isFront > 0.5) {
    let inset = step(b, in.uv.x) * step(in.uv.x, 1.0 - b) *
                step(b, in.uv.y) * step(in.uv.y, 1.0 - b);
    base = mix(u.bodyColor.rgb, labelRGB, inset);
  }
  return vec4<f32>(base * shade, 1.0);
}
`;

/** Build a box (W×H×D) centered at origin. Front (+Z) face is flagged so
 *  the shader can draw the label inset there. Returns interleaved vertices
 *  (pos3, nrm3, uv2, isFront1 = 9 floats) and 16-bit indices. */
function buildBox(W: number, H: number, D: number): { verts: Float32Array; indices: Uint16Array } {
  const hw = W / 2, hh = H / 2, hd = D / 2;
  const v: number[] = [];
  const idx: number[] = [];

  // face: 4 corners (CCW), normal, isFront
  const addFace = (
    c: [number, number, number][],
    n: [number, number, number],
    isFront: number,
  ) => {
    const base = v.length / 9;
    const uvs: [number, number][] = [[0, 1], [1, 1], [1, 0], [0, 0]];
    for (let i = 0; i < 4; i++) {
      v.push(c[i][0], c[i][1], c[i][2], n[0], n[1], n[2], uvs[i][0], uvs[i][1], isFront);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // +Z (front)
  addFace([[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]], [0, 0, 1], 1);
  // -Z (back)
  addFace([[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]], [0, 0, -1], 0);
  // +X
  addFace([[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]], [1, 0, 0], 0);
  // -X
  addFace([[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]], [-1, 0, 0], 0);
  // +Y (top)
  addFace([[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]], [0, 1, 0], 0);
  // -Y (bottom)
  addFace([[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]], [0, -1, 0], 0);

  return { verts: new Float32Array(v), indices: new Uint16Array(idx) };
}

interface MeshBuffers {
  vbuf: GPUBuffer;
  ibuf: GPUBuffer;
  count: number;
  format: GPUIndexFormat;
}

/** Billboard fragment shader: front/back faces textured from the icon atlas,
 *  side walls solid `sideColor`, transparent texels discarded (cutout edges). */
const BILLBOARD_SHADER = /* wgsl */ `
struct U {
  mvp: mat4x4<f32>, model: mat4x4<f32>,
  bodyColor: vec4<f32>, labelColor: vec4<f32>,
  lightDir: vec4<f32>, uvRect: vec4<f32>, sideColor: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(1) @binding(0) var thumbTex: texture_2d<f32>;
@group(1) @binding(1) var thumbSmp: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) faceType: f32,
  @location(2) uv: vec2<f32>,
};

@vertex
fn vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) faceType: f32) -> VsOut {
  var out: VsOut;
  out.pos = u.mvp * vec4<f32>(position, 1.0);
  out.normal = (u.model * vec4<f32>(normal, 0.0)).xyz;
  out.faceType = faceType;
  out.uv = uv;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  // Flat inked look: nearly-flat albedo (a hair of shading reads the form),
  // ink-blue cut edge + ink-blue silhouette band → the screen-print cutout.
  let n = normalize(in.normal);
  let l = normalize(u.lightDir.xyz);
  let shade = 0.92 + abs(dot(n, l)) * 0.08;   // two-sided: no brightness blink when the cutout mirror-flips at edge-on
  let auv = mix(u.uvRect.xy, u.uvRect.zw, in.uv);
  let tex = textureSample(thumbTex, thumbSmp, auv);
  if (in.faceType > 1.5) {
    // Cutout face: drop transparent texels so interior holes read as true
    // see-through gaps (the outline is baked into the texture, not painted).
    // Threshold sits below the silhouette trace (~0.43) so the rim's antialiased
    // edge isn't eroded into a thin gap.
    if (tex.a < 0.3) { discard; }
    return vec4<f32>(tex.rgb * shade, 1.0);
  }
  if (in.faceType > 0.5) {
    return vec4<f32>(u.sideColor.rgb * shade, 1.0);   // cut edge = ink
  }
  // Front/back face: icon where opaque, ink (sideColor) in the dilated band.
  let isIcon = step(0.5, tex.a);
  let rgb = mix(u.sideColor.rgb, tex.rgb, isIcon);
  return vec4<f32>(rgb * shade, 1.0);
}
`;

// Flat-shaded 3D "coin" for system-app tiles: the app icon (sampled from the
// shared thumbnail atlas, alpha-composited) sits on the top face; rim/back are
// the dark body color. Same vertex layout as the cartridge shader.
const DISC_SHADER = /* wgsl */ `
struct U {
  mvp: mat4x4<f32>,
  model: mat4x4<f32>,
  bodyColor: vec4<f32>,
  labelColor: vec4<f32>,
  lightDir: vec4<f32>,   // xyz = direction to light; w = useThumb (0/1)
  uvRect: vec4<f32>,     // icon atlas u0,v0,u1,v1
};
@group(0) @binding(0) var<uniform> u: U;
@group(1) @binding(0) var thumbTex: texture_2d<f32>;
@group(1) @binding(1) var thumbSmp: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) isFront: f32,
  @location(2) uv: vec2<f32>,
};

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) isFront: f32,
) -> VsOut {
  var out: VsOut;
  out.pos = u.mvp * vec4<f32>(position, 1.0);
  out.normal = (u.model * vec4<f32>(normal, 0.0)).xyz;
  out.isFront = isFront;
  out.uv = uv;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let l = normalize(u.lightDir.xyz);
  let shade = 0.55 + max(dot(n, l), 0.0) * 0.5;
  // Sample the icon unconditionally (uniform control flow); composite onto the
  // top face by its alpha so transparent icon areas show the disc body.
  let auv = mix(u.uvRect.xy, u.uvRect.zw, in.uv);
  let tex = textureSample(thumbTex, thumbSmp, auv);
  var base = u.bodyColor.rgb;
  if (in.isFront > 0.5) {
    base = mix(u.bodyColor.rgb, tex.rgb, tex.a * u.lightDir.w);
  }
  return vec4<f32>(base * shade, 1.0);
}
`;

/** Build a flat coin (radius R, thickness D) centered at origin, facing +Z.
 *  Top face is isFront=1 with UVs spanning [0,1]² for the icon; rim and back
 *  are isFront=0 (body color). Interleaved pos3/nrm3/uv2/isFront1. */
function buildDisc(R: number, D: number, segs: number): { verts: Float32Array; indices: Uint16Array } {
  const hd = D / 2;
  const v: number[] = [];
  const idx: number[] = [];
  const push = (
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    uu: number, vv: number, isFront: number,
  ): number => { v.push(px, py, pz, nx, ny, nz, uu, vv, isFront); return v.length / 9 - 1; };

  // Top face (+Z): center fan, isFront=1, UVs map the disc into [0,1]².
  const tc = push(0, 0, hd, 0, 0, 1, 0.5, 0.5, 1);
  const top: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const x = Math.cos(a), y = Math.sin(a);
    top.push(push(x * R, y * R, hd, 0, 0, 1, x * 0.5 + 0.5, -y * 0.5 + 0.5, 1));
  }
  for (let i = 0; i < segs; i++) idx.push(tc, top[i], top[(i + 1) % segs]);

  // Bottom face (−Z): isFront=0.
  const bc = push(0, 0, -hd, 0, 0, -1, 0.5, 0.5, 0);
  const bot: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    bot.push(push(Math.cos(a) * R, Math.sin(a) * R, -hd, 0, 0, -1, 0, 0, 0));
  }
  for (let i = 0; i < segs; i++) idx.push(bc, bot[(i + 1) % segs], bot[i]);

  // Rim: isFront=0, outward normals.
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    const x0 = Math.cos(a0), y0 = Math.sin(a0), x1 = Math.cos(a1), y1 = Math.sin(a1);
    const t0 = push(x0 * R, y0 * R, hd, x0, y0, 0, 0, 0, 0);
    const t1 = push(x1 * R, y1 * R, hd, x1, y1, 0, 0, 0, 0);
    const b0 = push(x0 * R, y0 * R, -hd, x0, y0, 0, 0, 0, 0);
    const b1 = push(x1 * R, y1 * R, -hd, x1, y1, 0, 0, 0, 0);
    idx.push(t0, b0, t1, t1, b0, b1);
  }
  return { verts: new Float32Array(v), indices: new Uint16Array(idx) };
}

// Iridescent "CD" for FrogCart tiles: a silver/chrome annulus with a diffraction
// rainbow that sweeps as it spins. Same vertex layout + uniform as the coin.
// See docs/specs/shell-cd.md.
const CD_SHADER = /* wgsl */ `
struct U {
  mvp: mat4x4<f32>,
  model: mat4x4<f32>,
  bodyColor: vec4<f32>,
  labelColor: vec4<f32>,
  lightDir: vec4<f32>,   // xyz unused here; w = useThumb (0/1) for cover art (P2)
  uvRect: vec4<f32>,     // cover-art atlas rect (P2)
};
@group(0) @binding(0) var<uniform> u: U;
@group(1) @binding(0) var thumbTex: texture_2d<f32>;
@group(1) @binding(1) var thumbSmp: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wn: vec3<f32>,     // world normal
  @location(1) wp: vec3<f32>,     // world position
  @location(2) lxy: vec2<f32>,    // local position (disc plane) for radial bands
  @location(3) uv: vec2<f32>,
  @location(4) isFront: f32,
};

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) isFront: f32,
) -> VsOut {
  var out: VsOut;
  out.pos = u.mvp * vec4<f32>(position, 1.0);
  out.wn = (u.model * vec4<f32>(normal, 0.0)).xyz;
  out.wp = (u.model * vec4<f32>(position, 1.0)).xyz;
  out.lxy = position.xy;
  out.uv = uv;
  out.isFront = isFront;
  return out;
}

fn bump3y(x: vec3<f32>, yoffset: vec3<f32>) -> vec3<f32> {
  return clamp((vec3<f32>(1.0) - x * x) - yoffset, vec3<f32>(0.0), vec3<f32>(1.0));
}

// Zucconi-6 spectral approximation: a visible wavelength (nm) → RGB.
fn spectral_zucconi6(w: f32) -> vec3<f32> {
  let x = clamp((w - 400.0) / 300.0, 0.0, 1.0);
  let c1 = vec3<f32>(3.54585104, 2.93225262, 2.41593945);
  let x1 = vec3<f32>(0.69549072, 0.49228336, 0.27699880);
  let y1 = vec3<f32>(0.02312639, 0.15225084, 0.52607955);
  let c2 = vec3<f32>(3.90307140, 3.21182957, 3.96587128);
  let x2 = vec3<f32>(0.11748627, 0.86755042, 0.66077860);
  let y2 = vec3<f32>(0.84897130, 0.88445281, 0.73949448);
  return bump3y(c1 * (vec3<f32>(x) - x1), y1) + bump3y(c2 * (vec3<f32>(x) - x2), y2);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.wn);
  let viewDir = normalize(vec3<f32>(0.0, 0.0, 6.5) - in.wp);   // camera fixed in drawCD
  let L = normalize(vec3<f32>(-0.3, 0.45, 1.0));               // a fixed key light
  let fres = pow(1.0 - abs(dot(n, viewDir)), 3.0);

  let r = length(in.lxy);

  // Physically-based diffraction grating (Alan Zucconi's CD-ROM shader). CD
  // tracks are circular, so a slit's TANGENT is the radial direction rotated
  // 90°. Measuring the light/view angles against that tangent (not the normal)
  // is what makes the rainbow a RADIAL band, not concentric rings: the reflected
  // colour is the sum of every visible wavelength satisfying |sinθL−sinθV|=n·w/d.
  let radial = normalize(in.lxy + vec2<f32>(1e-5, 0.0));
  let tangentLocal = vec3<f32>(-radial.y, radial.x, 0.0);
  let T = normalize((u.model * vec4<f32>(tangentLocal, 0.0)).xyz);
  let uu = abs(dot(L, T) - dot(viewDir, T));                   // |sinθL − sinθV|
  let DGRATING = 2400.0;                                       // grating gap (nm) — tune
  var rainbow = vec3<f32>(0.0);
  for (var k = 1; k <= 8; k = k + 1) {
    rainbow = rainbow + spectral_zucconi6(uu * DGRATING / f32(k));
  }
  rainbow = clamp(rainbow, vec3<f32>(0.0), vec3<f32>(1.0));

  // Dark steel base + a specular glint + the additive diffraction rainbow.
  var col = vec3<f32>(0.26, 0.28, 0.33);
  col = col + pow(max(0.0, dot(reflect(-L, n), viewDir)), 24.0) * 0.5;   // specular
  col = col + fres * 0.18;
  col = col + rainbow * smoothstep(0.33, 0.42, r);            // radial rainbow, outside hub

  // Hub: bright silver clamping ring around the hole.
  let hub = 1.0 - smoothstep(0.28, 0.34, r);
  col = mix(col, vec3<f32>(0.62, 0.64, 0.70), hub * 0.9);

  // Cover art (P2): sample unconditionally (textureSample requires uniform
  // control flow — it can't live inside the per-fragment isFront branch), then
  // composite on the front face only.
  let auv = mix(u.uvRect.xy, u.uvRect.zw, in.uv);
  let tex = textureSample(thumbTex, thumbSmp, auv);
  if (in.isFront > 0.5 && u.lightDir.w > 0.5) {
    col = mix(col, tex.rgb, tex.a * 0.7);
  }

  return vec4<f32>(col, 1.0);
}
`;

/** Build a thin annulus (CD): outer radius R, hole radius rHole, thickness D.
 *  Top ring isFront=1 (UVs map the outer disc to [0,1]² for cover art); bottom
 *  + rims isFront=0. Rendered with cullMode 'none', so winding is forgiving. */
function buildCD(R: number, D: number, rHole: number, segs: number): { verts: Float32Array; indices: Uint16Array } {
  const hd = D / 2, TAU = Math.PI * 2;
  const v: number[] = [];
  const idx: number[] = [];
  const push = (
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    uu: number, vv: number, isFront: number,
  ): number => { v.push(px, py, pz, nx, ny, nz, uu, vv, isFront); return v.length / 9 - 1; };
  const uvx = (x: number) => x / R * 0.5 + 0.5;
  const uvy = (y: number) => -y / R * 0.5 + 0.5;

  // Top ring (+Z, isFront=1) — UVs span the outer disc for cover art.
  const ti: number[] = [], to: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU, c = Math.cos(a), s = Math.sin(a);
    ti.push(push(c * rHole, s * rHole, hd, 0, 0, 1, uvx(c * rHole), uvy(s * rHole), 1));
    to.push(push(c * R, s * R, hd, 0, 0, 1, uvx(c * R), uvy(s * R), 1));
  }
  for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; idx.push(ti[i], to[i], to[j], ti[i], to[j], ti[j]); }

  // Bottom ring (−Z, isFront=0).
  const bi: number[] = [], bo: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU, c = Math.cos(a), s = Math.sin(a);
    bi.push(push(c * rHole, s * rHole, -hd, 0, 0, -1, 0, 0, 0));
    bo.push(push(c * R, s * R, -hd, 0, 0, -1, 0, 0, 0));
  }
  for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; idx.push(bi[i], bo[j], bo[i], bi[i], bi[j], bo[j]); }

  // Outer rim (outward normal) + inner rim / hole wall (inward normal).
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const o0 = push(c0 * R, s0 * R, hd, c0, s0, 0, 0, 0, 0);
    const o1 = push(c1 * R, s1 * R, hd, c1, s1, 0, 0, 0, 0);
    const o2 = push(c0 * R, s0 * R, -hd, c0, s0, 0, 0, 0, 0);
    const o3 = push(c1 * R, s1 * R, -hd, c1, s1, 0, 0, 0, 0);
    idx.push(o0, o2, o1, o1, o2, o3);
    const k0 = push(c0 * rHole, s0 * rHole, hd, -c0, -s0, 0, 0, 0, 0);
    const k1 = push(c1 * rHole, s1 * rHole, hd, -c1, -s1, 0, 0, 0, 0);
    const k2 = push(c0 * rHole, s0 * rHole, -hd, -c0, -s0, 0, 0, 0, 0);
    const k3 = push(c1 * rHole, s1 * rHole, -hd, -c1, -s1, 0, 0, 0, 0);
    idx.push(k0, k1, k2, k1, k3, k2);
  }
  return { verts: new Float32Array(v), indices: new Uint16Array(idx) };
}

export class CartridgeViewer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private thumbAtlas: ShellThumbnailAtlas;

  private pipeline!: GPURenderPipeline;
  private billboardPipeline!: GPURenderPipeline;
  private uniformBuf!: GPUBuffer;
  private bindGroup!: GPUBindGroup;
  private thumbBindGroup!: GPUBindGroup;

  private cartridge!: MeshBuffers;
  private sketchbook!: MeshBuffers;
  private billboards = new Map<string, MeshBuffers>();

  // System-app disc (coin) + a small pool of per-disc uniform buffers — one
  // uniform buffer can't back multiple draws within a single frame.
  private discPipeline!: GPURenderPipeline;
  private disc!: MeshBuffers;
  private cdPipeline!: GPURenderPipeline;
  private cd!: MeshBuffers;
  private discUniformBufs: GPUBuffer[] = [];
  private discBindGroups: GPUBindGroup[] = [];

  // Appear animation: which mesh is shown, and when it appeared.
  private appearKey = '';
  private appearStart = 0;

  private depthTex: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private depthSize: [number, number] = [0, 0];

  private mvp = mat4.create();
  private model = mat4.create();
  private proj = mat4.create();
  private view = mat4.create();

  constructor(device: GPUDevice, format: GPUTextureFormat, thumbAtlas: ShellThumbnailAtlas) {
    this.device = device;
    this.format = format;
    this.thumbAtlas = thumbAtlas;
    this.build();
  }

  private build(): void {
    const module = this.device.createShaderModule({ code: SHADER });

    this.uniformBuf = this.device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bgl = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.bindGroup = this.device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuf } }],
    });

    const thumbBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.thumbBindGroup = this.device.createBindGroup({
      layout: thumbBGL,
      entries: [
        { binding: 0, resource: this.thumbAtlas.getView() },
        { binding: 1, resource: this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
      ],
    });

    const vbufLayout = {
      arrayStride: 36,
      attributes: [
        { shaderLocation: 0, offset: 0,  format: 'float32x3' as const },
        { shaderLocation: 1, offset: 12, format: 'float32x3' as const },
        { shaderLocation: 2, offset: 24, format: 'float32x2' as const },
        { shaderLocation: 3, offset: 32, format: 'float32' as const },
      ],
    };

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl, thumbBGL] }),
      vertex: { module, entryPoint: 'vs', buffers: [vbufLayout] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });

    const bbModule = this.device.createShaderModule({ code: BILLBOARD_SHADER });
    this.billboardPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl, thumbBGL] }),
      vertex: { module: bbModule, entryPoint: 'vs', buffers: [vbufLayout] },
      fragment: { module: bbModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },   // cutout: show both faces
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });

    this.cartridge = this.upload(buildBox(2.0, 3.0, 0.4));
    this.sketchbook = this.upload(buildBox(3.2, 2.4, 0.3));
    this.disc = this.upload(buildDisc(1.0, 0.34, 48));
    this.cd = this.upload(buildCD(1.0, 0.05, 0.17, 48));

    // Coin + CD pipelines (same layout), sharing a pool of per-draw uniform
    // buffers — one buffer can't back multiple draws within a single frame.
    const discLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bgl, thumbBGL] });
    const discModule = this.device.createShaderModule({ code: DISC_SHADER });
    this.discPipeline = this.device.createRenderPipeline({
      layout: discLayout,
      vertex: { module: discModule, entryPoint: 'vs', buffers: [vbufLayout] },
      fragment: { module: discModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });
    const cdModule = this.device.createShaderModule({ code: CD_SHADER });
    this.cdPipeline = this.device.createRenderPipeline({
      layout: discLayout,
      vertex: { module: cdModule, entryPoint: 'vs', buffers: [vbufLayout] },
      fragment: { module: cdModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });
    for (let i = 0; i < 24; i++) {
      const buf = this.device.createBuffer({ size: UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.discUniformBufs.push(buf);
      this.discBindGroups.push(this.device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: buf } }] }));
    }
  }

  private upload(geo: { verts: Float32Array; indices: Uint16Array }): MeshBuffers {
    const vbuf = this.device.createBuffer({ size: geo.verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vbuf, 0, geo.verts);
    // Index buffer size must be a multiple of 4.
    const ibytes = Math.ceil(geo.indices.byteLength / 4) * 4;
    const ibuf = this.device.createBuffer({ size: ibytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ibuf, 0, geo.indices);
    return { vbuf, ibuf, count: geo.indices.length, format: 'uint16' };
  }

  /** Upload (or replace) a Billboard3D cutout mesh under `key`. Interleaves the
   *  primitive's arrays into the viewer's pos/normal/uv/faceType vertex format. */
  setBillboard(key: string, geo: Billboard3DGeometry): void {
    const vcount = geo.positions.length / 3;
    const verts = new Float32Array(vcount * 9);
    for (let i = 0; i < vcount; i++) {
      const o = i * 9;
      verts[o + 0] = geo.positions[i * 3]; verts[o + 1] = geo.positions[i * 3 + 1]; verts[o + 2] = geo.positions[i * 3 + 2];
      verts[o + 3] = geo.normals[i * 3]; verts[o + 4] = geo.normals[i * 3 + 1]; verts[o + 5] = geo.normals[i * 3 + 2];
      verts[o + 6] = geo.uvs[i * 2]; verts[o + 7] = geo.uvs[i * 2 + 1];
      verts[o + 8] = geo.faceType[i];
    }
    const vbuf = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vbuf, 0, verts);
    const ibuf = this.device.createBuffer({ size: geo.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(ibuf, 0, geo.indices);
    this.billboards.get(key)?.vbuf.destroy();
    this.billboards.get(key)?.ibuf.destroy();
    this.billboards.set(key, { vbuf, ibuf, count: geo.indices.length, format: 'uint32' });
  }

  private ensureDepth(w: number, h: number): void {
    if (this.depthTex && this.depthSize[0] === w && this.depthSize[1] === h) return;
    this.depthTex?.destroy();
    this.depthTex = this.device.createTexture({
      size: { width: w, height: h },
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTex.createView();
    this.depthSize = [w, h];
  }

  /**
   * Draw the viewer into the top region of the canvas. `colorView` is the
   * current swapchain view (already cleared + grid-drawn). `region` is the
   * top viewer rectangle in device px. `timeSec` drives idle animation.
   */
  render(
    encoder: GPUCommandEncoder,
    colorView: GPUTextureView,
    canvasW: number,
    canvasH: number,
    region: { x: number; y: number; w: number; h: number },
    spec: ViewerSpec,
    timeSec: number,
    thumb: { u0: number; v0: number; u1: number; v1: number } | null,
  ): void {
    if (region.w <= 0 || region.h <= 0) return;
    this.ensureDepth(canvasW, canvasH);
    if (!this.depthView) return;

    // Billboard cutout (system-app icon) takes priority when present; a CD
    // viewer (hovered FrogCart) uses the iridescent annulus.
    const billboard = spec.billboardKey ? this.billboards.get(spec.billboardKey) : undefined;
    const isCD = spec.kind === 'cd';
    const mesh = isCD ? this.cd : (billboard ?? (spec.kind === 'sketchbook' ? this.sketchbook : this.cartridge));
    const isBillboard = !!billboard;
    const drop = isBillboard ? -0.30 : 0.0;   // hero vertical offset

    // ── appear animation ── when the shown mesh changes (e.g. hovering a tile),
    // pop in (scale up with a little overshoot) and spin quickly, decelerating
    // into the idle spin.
    const curKey = spec.billboardKey ?? ('#' + spec.kind);
    if (curKey !== this.appearKey) { this.appearKey = curKey; this.appearStart = timeSec; }
    const age = Math.max(0, timeSec - this.appearStart);
    const gt = Math.min(age / 0.30, 1);                    // grow over ~0.3s
    const c1 = 1.70158, c3 = c1 + 1;
    const grow = 1 + c3 * Math.pow(gt - 1, 3) + c1 * Math.pow(gt - 1, 2); // easeOutBack
    const scale = (isBillboard ? 2.25 : isCD ? 1.2 : 1.0) * grow * (spec.scale ?? 1);
    const extraSpin = 1.3 * Math.PI * 2 * (1 - Math.exp(-age / 0.4));     // decaying spin-up

    // ── animation ──
    mat4.identity(this.model);
    if (spec.floaty) {
      // Weightless "facing you" float (the hero logo): gentle sway + nod + roll
      // + bob + drift, no full spin — so the logo always reads front-on but never
      // sits still. The slightly-offset frequencies trace a lazy figure-8.
      const swayY = Math.sin(timeSec * 0.55) * 0.20;        // ±~11° left/right
      const nodX  = Math.sin(timeSec * 0.80 + 0.6) * 0.10;  // ±~6° up/down nod
      const rollZ = Math.sin(timeSec * 0.40 + 1.3) * 0.05;  // ±~3° subtle roll
      const fbob  = Math.sin(timeSec * 0.90) * 0.10;        // vertical float
      const drift = Math.sin(timeSec * 0.50) * 0.05;        // side-to-side drift
      mat4.translate(this.model, this.model, [drift, fbob + drop, 0]);
      mat4.rotateZ(this.model, this.model, rollZ);
      mat4.rotateX(this.model, this.model, nodX);
      mat4.rotateY(this.model, this.model, swayY);
      if (scale !== 1) mat4.scale(this.model, this.model, [scale, scale, scale]);
    } else {
      // Cutout billboards spin fully (they read well edge-on); the box meshes
      // (cartridge/sketchbook) only sway, so they never collapse to a sliver.
      const spin = (isBillboard || isCD)
        ? (timeSec % 12) / 12 * Math.PI * 2 + extraSpin      // full spin (cutouts + CDs) + appear spin-up
        : Math.sin(timeSec * 0.5) * 0.85;                    // gentle ±49° sway (box meshes)
      const bob = Math.sin(timeSec * Math.PI) * 0.12;        // 2s period
      const tilt = (isCD ? -24 : -10) * Math.PI / 180;       // tilt more for the CD
      mat4.translate(this.model, this.model, [0, bob + drop, 0]);
      mat4.rotateX(this.model, this.model, tilt);
      mat4.rotateY(this.model, this.model, spin);
      if (scale !== 1) mat4.scale(this.model, this.model, [scale, scale, scale]);
      // Always-front: mirror past edge-on so the back reads as the front.
      if (spec.mirrorBack && Math.cos(spin) < 0) {
        mat4.scale(this.model, this.model, [-1, 1, 1]);
      }
    }

    const aspect = region.w / region.h;
    mat4.perspective(this.proj, 35 * Math.PI / 180, aspect, 0.1, 100);
    mat4.lookAt(this.view, [0, 0, 6.5], [0, 0, 0], [0, 1, 0]);
    mat4.multiply(this.mvp, this.proj, this.view);
    mat4.multiply(this.mvp, this.mvp, this.model);

    // ── uniforms ──
    const u = new Float32Array(UNIFORM_SIZE / 4);
    u.set(this.mvp, 0);
    u.set(this.model, 16);
    const body = spec.bodyColor, label = spec.labelColor;
    u.set([body[0], body[1], body[2], body[3]], 32);
    u.set([label[0], label[1], label[2], label[3]], 36);
    u.set([0.4, 0.7, 0.6, thumb ? 1 : 0], 40); // light dir (xyz) + useThumb (w)
    u.set(thumb ? [thumb.u0, thumb.v0, thumb.u1, thumb.v1] : [0, 0, 1, 1], 44); // uvRect
    const side = spec.sideColor ?? [1, 1, 1, 1];
    u.set([side[0], side[1], side[2], side[3]], 48); // sideColor (billboard)
    this.device.queue.writeBuffer(this.uniformBuf, 0, u);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    // Constrain to the top viewer region. Viewport y is from the top in WebGPU.
    pass.setViewport(region.x, region.y, region.w, region.h, 0, 1);
    pass.setPipeline(isCD ? this.cdPipeline : (isBillboard ? this.billboardPipeline : this.pipeline));
    pass.setBindGroup(0, this.bindGroup);
    pass.setBindGroup(1, this.thumbBindGroup);
    pass.setVertexBuffer(0, mesh.vbuf);
    pass.setIndexBuffer(mesh.ibuf, mesh.format);
    pass.drawIndexed(mesh.count);
    pass.end();
  }

  /**
   * Draw a system-app coin into a tile's screen region (own depth pass, over
   * the already-composited 2D tiles). `iconRect` is the icon's atlas UV rect
   * (or null → no icon). `slot` indexes the per-disc uniform pool.
   */
  drawDisc(
    encoder: GPUCommandEncoder,
    colorView: GPUTextureView,
    canvasW: number,
    canvasH: number,
    region: { x: number; y: number; w: number; h: number },
    iconRect: { u0: number; v0: number; u1: number; v1: number } | null,
    timeSec: number,
    slot: number,
  ): void {
    if (region.w <= 0 || region.h <= 0) return;
    if (slot >= this.discUniformBufs.length) return;
    this.ensureDepth(canvasW, canvasH);
    if (!this.depthView) return;

    const phase = slot * 2.1;
    const tilt = -22 * Math.PI / 180;                    // look down at the coin
    const sway = Math.sin(timeSec * 0.5 + phase) * 0.55; // gentle ±32° turn (never edge-on)
    const bob = Math.sin(timeSec * 1.0 + phase) * 0.07;

    mat4.identity(this.model);
    mat4.translate(this.model, this.model, [0, bob, 0]);
    mat4.rotateX(this.model, this.model, tilt);
    mat4.rotateY(this.model, this.model, sway);
    mat4.scale(this.model, this.model, [1.7, 1.7, 1.7]);

    const aspect = region.w / region.h;
    mat4.perspective(this.proj, 35 * Math.PI / 180, aspect, 0.1, 100);
    mat4.lookAt(this.view, [0, 0, 6.5], [0, 0, 0], [0, 1, 0]);
    mat4.multiply(this.mvp, this.proj, this.view);
    mat4.multiply(this.mvp, this.mvp, this.model);

    const u = new Float32Array(UNIFORM_SIZE / 4);
    u.set(this.mvp, 0);
    u.set(this.model, 16);
    u.set([0.13, 0.13, 0.16, 1], 32);             // dark coin body
    u.set([0.9, 0.9, 0.95, 1], 36);               // label (unused — icon via thumb)
    u.set([0.3, 0.6, 0.7, iconRect ? 1 : 0], 40); // light dir + useThumb
    u.set(iconRect ? [iconRect.u0, iconRect.v0, iconRect.u1, iconRect.v1] : [0, 0, 1, 1], 44);
    this.device.queue.writeBuffer(this.discUniformBufs[slot], 0, u);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setViewport(region.x, region.y, region.w, region.h, 0, 1);
    pass.setPipeline(this.discPipeline);
    pass.setBindGroup(0, this.discBindGroups[slot]);
    pass.setBindGroup(1, this.thumbBindGroup);
    pass.setVertexBuffer(0, this.disc.vbuf);
    pass.setIndexBuffer(this.disc.ibuf, this.disc.format);
    pass.drawIndexed(this.disc.count);
    pass.end();
  }

  /**
   * Draw a FrogCart CD (iridescent annulus) into a tile's screen rect — own
   * depth pass, over the 2D tiles. `cover` is the cover-art atlas rect (Phase 2;
   * null = holographic only). `slot` indexes the shared per-draw uniform pool.
   */
  drawCD(
    encoder: GPUCommandEncoder,
    colorView: GPUTextureView,
    canvasW: number,
    canvasH: number,
    region: { x: number; y: number; w: number; h: number },
    cover: { u0: number; v0: number; u1: number; v1: number } | null,
    timeSec: number,
    slot: number,
  ): void {
    if (region.w <= 0 || region.h <= 0) return;
    if (slot >= this.discUniformBufs.length) return;
    this.ensureDepth(canvasW, canvasH);
    if (!this.depthView) return;

    const phase = slot * 1.7;
    const tilt = -26 * Math.PI / 180;                  // see the face + the sheen
    const spin = timeSec * 0.55 + phase;               // continuous Y whirl
    const bob = Math.sin(timeSec * 1.1 + phase) * 0.06;

    mat4.identity(this.model);
    mat4.translate(this.model, this.model, [0, bob, 0]);
    mat4.rotateX(this.model, this.model, tilt);
    mat4.rotateY(this.model, this.model, spin);
    mat4.scale(this.model, this.model, [1.75, 1.75, 1.75]);

    const aspect = region.w / region.h;
    mat4.perspective(this.proj, 35 * Math.PI / 180, aspect, 0.1, 100);
    mat4.lookAt(this.view, [0, 0, 6.5], [0, 0, 0], [0, 1, 0]);
    mat4.multiply(this.mvp, this.proj, this.view);
    mat4.multiply(this.mvp, this.mvp, this.model);

    const u = new Float32Array(UNIFORM_SIZE / 4);
    u.set(this.mvp, 0);
    u.set(this.model, 16);
    u.set([0.72, 0.74, 0.80, 1], 32);                  // chrome silver base
    u.set([0.9, 0.9, 0.95, 1], 36);                    // (label unused)
    u.set([0.3, 0.6, 0.7, cover ? 1 : 0], 40);         // w = use cover art
    u.set(cover ? [cover.u0, cover.v0, cover.u1, cover.v1] : [0, 0, 1, 1], 44);
    this.device.queue.writeBuffer(this.discUniformBufs[slot], 0, u);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setViewport(region.x, region.y, region.w, region.h, 0, 1);
    pass.setPipeline(this.cdPipeline);
    pass.setBindGroup(0, this.discBindGroups[slot]);
    pass.setBindGroup(1, this.thumbBindGroup);
    pass.setVertexBuffer(0, this.cd.vbuf);
    pass.setIndexBuffer(this.cd.ibuf, this.cd.format);
    pass.drawIndexed(this.cd.count);
    pass.end();
  }

  /**
   * Draw a Billboard3D cutout (a system-app icon shape) into a tile's screen
   * rect — a small spinning 3D cutout, like a mini hero logo (Install Cart =
   * download arrow). `iconRect` is the icon's atlas UV rect (sampled on the
   * faces). `slot` indexes the shared per-draw uniform pool.
   */
  drawBillboard(
    encoder: GPUCommandEncoder,
    colorView: GPUTextureView,
    canvasW: number,
    canvasH: number,
    region: { x: number; y: number; w: number; h: number },
    key: string,
    iconRect: { u0: number; v0: number; u1: number; v1: number } | null,
    timeSec: number,
    slot: number,
    sideColor: [number, number, number, number] = [1, 1, 1, 1],
  ): void {
    const mesh = this.billboards.get(key);
    if (!mesh || region.w <= 0 || region.h <= 0 || slot >= this.discUniformBufs.length) return;
    this.ensureDepth(canvasW, canvasH);
    if (!this.depthView) return;

    const phase = slot * 1.4;
    const tilt = -8 * Math.PI / 180;
    const spin = (timeSec % 10) / 10 * Math.PI * 2 + phase;   // full 10s/rev whirl
    const bob = Math.sin(timeSec * Math.PI + phase) * 0.07;

    mat4.identity(this.model);
    mat4.translate(this.model, this.model, [0, bob, 0]);
    mat4.rotateX(this.model, this.model, tilt);
    mat4.rotateY(this.model, this.model, spin);
    mat4.scale(this.model, this.model, [3.25, 3.25, 3.25]); // cutouts read smaller → scale up

    const aspect = region.w / region.h;
    mat4.perspective(this.proj, 35 * Math.PI / 180, aspect, 0.1, 100);
    mat4.lookAt(this.view, [0, 0, 6.5], [0, 0, 0], [0, 1, 0]);
    mat4.multiply(this.mvp, this.proj, this.view);
    mat4.multiply(this.mvp, this.mvp, this.model);

    const u = new Float32Array(UNIFORM_SIZE / 4);
    u.set(this.mvp, 0);
    u.set(this.model, 16);
    u.set([0.14, 0.14, 0.17, 1], 32);              // body (unused by cutout faces)
    u.set([0.9, 0.9, 0.95, 1], 36);                // label
    u.set([0.4, 0.7, 0.6, iconRect ? 1 : 0], 40);  // light dir + useThumb
    u.set(iconRect ? [iconRect.u0, iconRect.v0, iconRect.u1, iconRect.v1] : [0, 0, 1, 1], 44);
    u.set(sideColor, 48);                           // sideColor (themed cut edge / band)
    this.device.queue.writeBuffer(this.discUniformBufs[slot], 0, u);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setViewport(region.x, region.y, region.w, region.h, 0, 1);
    pass.setPipeline(this.billboardPipeline);
    pass.setBindGroup(0, this.discBindGroups[slot]);
    pass.setBindGroup(1, this.thumbBindGroup);
    pass.setVertexBuffer(0, mesh.vbuf);
    pass.setIndexBuffer(mesh.ibuf, mesh.format);
    pass.drawIndexed(mesh.count);
    pass.end();
  }

  destroy(): void {
    this.uniformBuf.destroy();
    this.cartridge.vbuf.destroy();
    this.cartridge.ibuf.destroy();
    this.sketchbook.vbuf.destroy();
    this.sketchbook.ibuf.destroy();
    this.disc.vbuf.destroy();
    this.disc.ibuf.destroy();
    this.cd.vbuf.destroy();
    this.cd.ibuf.destroy();
    for (const b of this.discUniformBufs) b.destroy();
    for (const b of this.billboards.values()) { b.vbuf.destroy(); b.ibuf.destroy(); }
    this.billboards.clear();
    this.depthTex?.destroy();
    this.depthTex = null;
  }
}
