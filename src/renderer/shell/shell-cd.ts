/**
 * shell-cd.ts — The Shell's FrogCart CD: its shader, pipeline, pose and uniforms, shared by the CartridgeViewer (the
 * home tiles + the hero viewer, shell-cartridge.ts) and the export dialog's live disc preview (cart-disc-preview.ts),
 * so the preview is the SAME disc with the same idle motion. See docs/specs/shell-cd.md.
 *
 * The disc mesh + the surface / print maths are the neutral CD-disc module's (renderer/3d/cd-disc), shared with the
 * CD Kit disc: real CD hole (SHELL_CD_HOLE_RATIO), a clear hub ring (no print inside the stacking-ring radius),
 * 0.85 print opacity. What the Shell disc prints on its face (CDFace):
 *   art      an image (an atlas cell, or the preview's own texture + crop rect): transparent pixels show the foil
 *   pattern  no image: the cart's seeded wavy pattern (cart-disc-pattern.ts)
 *   neither  the bare holographic disc
 */

import { mat4 } from 'gl-matrix';
import { shellGpuCached } from './shell-gpu-cache';
import { CD_DISC_WGSL } from '../3d/cd-disc/cd-disc-wgsl';
import { CART_DISC_PATTERN_WGSL, cartDiscPatternCached, writeCartDiscPatternUniforms, type CartDiscPatternRef } from '../3d/cd-disc/cart-disc-pattern';
import { buildShellCDMesh } from '../3d/cd-disc/cd-disc-geometry';

/** The Shell's depth format: the viewer's 3D pipelines write it, and every 2D Shell pipeline declares it (compare
 *  'always', no write) so all of them can draw in ONE render pass. */
export const SHELL_DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/** Bytes of one Shell 3D draw's uniforms: mvp(64) + model(64) + 5 vec4 (80) = 208. */
export const SHELL_3D_UNIFORM_SIZE = 208;

/** A texture rect (0..1). */
export type CDUV = { u0: number; v0: number; u1: number; v1: number };

/** What a CD prints on its face. `art` wins; else `pattern`; else the bare holographic disc. */
export interface CDFace {
  art: CDUV | null;
  pattern: CartDiscPatternRef | null;
}

/** The face-mode code in the uniforms (face.w). */
export const CD_FACE_MODE = { holo: 0, art: 1, pattern: 2 } as const;

/**
 * A CD's pose in the fixed Shell camera (eye at z 6.5, looking at the origin). Applied as
 * translate(x, y) · rotateX(tilt) · rotateY(spin) · rotateZ(roll) · scale: `roll` spins the disc about its OWN axis
 * (invisible on a bare disc; reads once the face has print), `spin` is the idle Y whirl. Angles in radians.
 */
export interface CDPose {
  x: number;
  y: number;
  tilt: number;
  spin: number;
  roll: number;
  scale: number;
}

/** The tile CD's idle tilt (radians): look down at the face + the sheen. */
export const CD_IDLE_TILT = -26 * Math.PI / 180;
/** The tile CD's scale in its tile rect. */
export const CD_TILE_SCALE = 1.75;

/** The idle motion of a tile CD (and the export preview): a continuous Y whirl, the tilt, a gentle bob. `phase`
 *  desyncs neighbouring tiles. Writes into `out` when given (per-frame callers: no allocation). */
export function cdIdlePose(timeSec: number, phase = 0, out?: CDPose): CDPose {
  const p = out ?? { x: 0, y: 0, tilt: 0, spin: 0, roll: 0, scale: 1 };
  p.x = 0;
  p.y = Math.sin(timeSec * 1.1 + phase) * 0.06;
  p.tilt = CD_IDLE_TILT;
  p.spin = timeSec * 0.55 + phase;
  p.roll = 0;
  p.scale = CD_TILE_SCALE;
  return p;
}

const _v3: [number, number, number] = [0, 0, 0];
/** The model matrix of a pose (see CDPose for the order). */
export function cdPoseModel(out: mat4, pose: CDPose): mat4 {
  mat4.identity(out);
  _v3[0] = pose.x; _v3[1] = pose.y; _v3[2] = 0;
  mat4.translate(out, out, _v3);
  mat4.rotateX(out, out, pose.tilt);
  mat4.rotateY(out, out, pose.spin);
  if (pose.roll) mat4.rotateZ(out, out, pose.roll);
  _v3[0] = _v3[1] = _v3[2] = pose.scale;
  mat4.scale(out, out, _v3);
  return out;
}

/** Uniform index of the rotational blur arc (patC.w; the pattern leaves it 0). */
export const CD_BLUR_INDEX = 51;

/**
 * Fill a CD draw's uniforms (Float32Array of SHELL_3D_UNIFORM_SIZE / 4): mvp, model, then the face —
 * patA / patB / face(amp, freq, rot, mode) / uvRect / patC (the pattern words are zero unless the face is a pattern).
 * blurArc (radians, 0 = sharp) smears the face print along its rotation (the launch spin-up, shell-launch.ts).
 */
export function writeCDUniforms(u: Float32Array, mvp: ArrayLike<number>, model: ArrayLike<number>, face: CDFace | null, blurArc = 0): void {
  u.fill(0);
  u.set(mvp as ArrayLike<number>, 0);
  u.set(model as ArrayLike<number>, 16);
  const art = face?.art ?? null;
  if (art) {
    u[43] = CD_FACE_MODE.art;
    u[44] = art.u0; u[45] = art.v0; u[46] = art.u1; u[47] = art.v1;
    u[CD_BLUR_INDEX] = blurArc > 0 ? blurArc : 0;
    return;
  }
  u[44] = 0; u[45] = 0; u[46] = 1; u[47] = 1;
  if (face?.pattern) {
    writeCartDiscPatternUniforms(u, 32, cartDiscPatternCached(face.pattern));
    u[43] = CD_FACE_MODE.pattern;
  } else {
    u[43] = CD_FACE_MODE.holo;
  }
  u[CD_BLUR_INDEX] = blurArc > 0 ? blurArc : 0;
}

// Iridescent CD for FrogCart tiles: the shared CD surface (silver/steel + the diffraction rainbow that sweeps as it
// spins + the silver hub) with the face print. Same vertex layout as the Shell coin (pos, normal, uv, isFront).
export const CD_SHADER = /* wgsl */ `
${CD_DISC_WGSL}
${CART_DISC_PATTERN_WGSL}
struct U {
  mvp: mat4x4<f32>,
  model: mat4x4<f32>,
  patA: vec4<f32>,       // pattern ink rgb + family (0 checker, 1 stripes, 2 dots)
  patB: vec4<f32>,       // pattern paper rgb + cells across the disc
  face: vec4<f32>,       // warp amplitude, warp frequency, rotation, face mode (0 bare, 1 art, 2 pattern)
  uvRect: vec4<f32>,     // art texture rect u0, v0, u1, v1
  patC: vec4<f32>,       // warp phase xy, dot radius, rotational blur arc (radians, 0 = sharp)
};
@group(0) @binding(0) var<uniform> u: U;
@group(1) @binding(0) var thumbTex: texture_2d<f32>;
@group(1) @binding(1) var thumbSmp: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wn: vec3<f32>,     // world normal
  @location(1) wp: vec3<f32>,     // world position
  @location(2) lxy: vec2<f32>,    // local position (disc plane) for radial bands + the pattern
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

// 1 inside the art texture's 0..1 rect, 0 outside (a zoomed-out preview samples past it). Arithmetic only: no branch.
fn cd_art_inside(uv: vec2<f32>) -> f32 {
  let ok = all(uv >= vec2<f32>(0.0, 0.0)) && all(uv <= vec2<f32>(1.0, 1.0));
  return select(0.0, 1.0, ok);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let n = normalize(in.wn);
  let viewDir = normalize(vec3<f32>(0.0, 0.0, 6.5) - in.wp);   // the fixed Shell camera
  let L = normalize(vec3<f32>(-0.3, 0.45, 1.0));               // a fixed key light
  let r = length(in.lxy);

  // CD tracks are circular, so a slit's TANGENT is the radial direction rotated 90 degrees; the disc spins, so the
  // tangent goes through the model matrix (the CD Kit's unrotated disc uses it in local space).
  let radial = normalize(in.lxy + vec2<f32>(1e-5, 0.0));
  let tangentLocal = vec3<f32>(-radial.y, radial.x, 0.0);
  let T = normalize((u.model * vec4<f32>(tangentLocal, 0.0)).xyz);
  let uu = abs(dot(L, T) - dot(viewDir, T));                   // |sin thetaL - sin thetaV|
  var col = cd_disc_surface(n, L, viewDir, r, uu);

  // Sample the art and evaluate the pattern unconditionally (textureSample + the pattern's derivatives need uniform
  // control flow), then print on the front face only.
  // (a zoomed-out preview's rect reaches past the texture: outside it the art is transparent, the foil shows)
  let auv = mix(u.uvRect.xy, u.uvRect.zw, in.uv);
  var tex = textureSample(thumbTex, thumbSmp, auv);
  tex.a = tex.a * cd_art_inside(auv);
  var pat = cart_disc_pattern(in.lxy, u.patA, u.patB, u.face, u.patC);
  // Rotational blur (the launch spin-up): average the print over an arc about the disc centre. The arc is a uniform,
  // so this branch and the fixed 7-tap loop keep uniform control flow (textureSample + the pattern derivatives).
  let blurArc = u.patC.w;
  if (blurArc > 0.0005) {
    var tAcc = vec4<f32>(0.0);
    var pAcc = vec3<f32>(0.0);
    let d = in.uv - vec2<f32>(0.5, 0.5);
    for (var i = 0; i < 7; i = i + 1) {
      let a = (f32(i) / 6.0 - 0.5) * blurArc;
      let c = cos(a);
      let s = sin(a);
      let lr = vec2<f32>(c * in.lxy.x - s * in.lxy.y, s * in.lxy.x + c * in.lxy.y);
      let ur = vec2<f32>(0.5, 0.5) + vec2<f32>(c * d.x + s * d.y, c * d.y - s * d.x);
      let suv = mix(u.uvRect.xy, u.uvRect.zw, ur);
      var ts = textureSample(thumbTex, thumbSmp, suv);
      ts.a = ts.a * cd_art_inside(suv);
      tAcc = tAcc + ts;
      pAcc = pAcc + cart_disc_pattern(lr, u.patA, u.patB, u.face, u.patC);
    }
    tex = tAcc / 7.0;
    pat = pAcc / 7.0;
  }
  if (in.isFront > 0.5) {
    if (u.face.w > 1.5) {
      col = cd_print(col, pat, 1.0, r);           // the seeded pattern (opaque ink)
    } else if (u.face.w > 0.5) {
      col = cd_print(col, tex.rgb, tex.a, r);     // the art: transparent pixels show the foil
    }
  }
  return vec4<f32>(col, 1.0);
}
`;

/** The 3D viewer's shared layouts (per device, kept across mounts): group 0 = the draw's uniforms, group 1 = a texture
 *  + its sampler. */
export function shellCartLayouts(dev: GPUDevice): { bgl: GPUBindGroupLayout; thumbBGL: GPUBindGroupLayout; layout: GPUPipelineLayout; sampler: GPUSampler } {
  const bgl = shellGpuCached(dev, 'cart.bgl', () => dev.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  }));
  const thumbBGL = shellGpuCached(dev, 'cart.thumbBGL', () => dev.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  }));
  const layout = shellGpuCached(dev, 'cart.layout', () => dev.createPipelineLayout({ bindGroupLayouts: [bgl, thumbBGL] }));
  const sampler = shellGpuCached(dev, 'cart.sampler', () => dev.createSampler({ magFilter: 'linear', minFilter: 'linear' }));
  return { bgl, thumbBGL, layout, sampler };
}

/** The Shell 3D vertex layout: pos3, nrm3, uv2, isFront1 (36 bytes). */
export const SHELL_3D_VBUF_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 36,
  attributes: [
    { shaderLocation: 0, offset: 0,  format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
    { shaderLocation: 3, offset: 32, format: 'float32' },
  ],
};

/** The CD pipeline for a colour format (cached per device + format: the Shell and the export preview share it). */
export function shellCDPipeline(dev: GPUDevice, fmt: GPUTextureFormat): GPURenderPipeline {
  const { layout } = shellCartLayouts(dev);
  return shellGpuCached(dev, `cart.cd|${fmt}`, () => {
    const module = dev.createShaderModule({ code: CD_SHADER, label: 'ShellCD' });
    return dev.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs', buffers: [SHELL_3D_VBUF_LAYOUT] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: fmt }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: SHELL_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });
  });
}

/** Upload the Shell's unit CD mesh. The caller owns (and destroys) the buffers. */
export function uploadShellCDMesh(dev: GPUDevice): { vbuf: GPUBuffer; ibuf: GPUBuffer; count: number; format: GPUIndexFormat } {
  const geo = buildShellCDMesh();
  const vbuf = dev.createBuffer({ size: geo.verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(vbuf, 0, geo.verts);
  const ibytes = Math.ceil(geo.indices.byteLength / 4) * 4;   // index buffer size must be a multiple of 4
  const ibuf = dev.createBuffer({ size: ibytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  const padded = new Uint16Array(ibytes / 2); padded.set(geo.indices);
  dev.queue.writeBuffer(ibuf, 0, padded);
  return { vbuf, ibuf, count: geo.indices.length, format: 'uint16' };
}

/** The fixed Shell camera (eye at z 6.5 looking at the origin, 35 degree vertical FOV). */
export const SHELL_EYE: readonly [number, number, number] = [0, 0, 6.5];
export const SHELL_FOV = 35 * Math.PI / 180;
const _view = mat4.lookAt(mat4.create(), SHELL_EYE, [0, 0, 0], [0, 1, 0]);
const _proj = mat4.create();
/** mvp = perspective(aspect) · view · model. */
export function shellProject(out: mat4, model: mat4, aspect: number): mat4 {
  mat4.perspective(_proj, SHELL_FOV, aspect, 0.1, 100);
  mat4.multiply(out, _proj, _view);
  return mat4.multiply(out, out, model);
}
