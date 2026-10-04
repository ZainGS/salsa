/**
 * SkyDomePass (visual-polish #9) — the stylised SKY backdrop: one full-screen triangle pair that turns each pixel into
 * a VIEW DIRECTION and paints the sky there (so it sits at infinity, follows the horizon as the camera tilts, and is
 * never far-clipped, fogged or depth-sorted). Drawn by ArmatureBgPass for mode 'sky' BEFORE the meshes (no depth).
 *
 * Terms (CPU reference + layout: sky-dome.ts):
 *   - gradient: horizon → zenith above (pow(y, bias)), horizon → the fog colour just below the horizon;
 *   - horizon GLOW (city light pollution, a warm / coloured band that fades up the sky);
 *   - sun: crisp disc + halo + a wide warm band along the horizon on the sun side;
 *   - moon: a shaded disc (limb + three soft maria) with a two-scale halo;
 *   - stars: one hashed point per cell of a 3D grid on the unit sphere (only the pixel's own cell is tested), faded
 *     near the horizon and by the city glow, gently twinkling;
 *   - painted anime CLOUDS: two layers of cumulus silhouettes (5 round lobes + a flat base each), toon two-tone lit
 *     per lobe toward the light (sun by day, moon at night), a thin bright rim on the lit side (golden rims at golden
 *     hour, a silver lining near the sun), city glow on the undersides at night, and horizon haze at their feet.
 * Cost: ~40 ALU-light tests per sky pixel (no loops over every cloud / star); see docs/ui/city-quality.md §Sky.
 * No backticks in WGSL comments (they end the template literal).
 */

import { GPUPipelineCache, type PipelineHandle } from '../core/gpu-pipeline-cache';
import type { SkyDomeParams } from '../../types/armature-3d';
import {
  buildSkyDomeClouds, packSkyDomeHeader, SKY_DOME_HEADER_VEC4, SKY_DOME_UNIFORM_FLOATS, SKY_CLOUD_SECTORS, SKY_CLOUD_VEC4_PER,
  SKY_CLOUD_SECTORS_LOW, SKY_CLOUD_SECTORS_HIGH, SKY_CLOUD_LOBES, SKY_CLOUD_SMOOTH, type SkyDomeView,
} from './sky-dome';

const VERT = /* wgsl */`
@vertex
fn main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    var pos = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2( 1.0, -1.0), vec2( 1.0,  1.0), vec2(-1.0,  1.0),
    );
    return vec4<f32>(pos[vi], 0.0, 1.0);
}
`;

const FRAG = /* wgsl */`
struct SkyU {
    right      : vec4<f32>,   // xyz camera right, w tanX
    up         : vec4<f32>,   // xyz camera up,    w tanY
    fwd        : vec4<f32>,   // xyz camera fwd,   w time (s)
    res        : vec4<f32>,   // x w, y h, z pixel angle (rad), w gradient bias
    zenith     : vec4<f32>,   // w stars
    horizon    : vec4<f32>,   // w glow amount
    ground     : vec4<f32>,   // w glow height (rad)
    glow       : vec4<f32>,   // rgb glow colour, w cloud opacity
    sunDir     : vec4<f32>,   // w sun disc
    sunCol     : vec4<f32>,   // w sun halo
    moonDir    : vec4<f32>,   // w moon visibility
    moonCol    : vec4<f32>,   // w moon radius (rad)
    cloudLit   : vec4<f32>,   // w moon halo
    cloudShade : vec4<f32>,   // w rim amount
    cloudRim   : vec4<f32>,   // w drift (rad per s)
    cloudLight : vec4<f32>,
    cloudGlow  : vec4<f32>,
    clouds     : array<vec4<f32>, ${SKY_CLOUD_SECTORS * SKY_CLOUD_VEC4_PER}>,
}
@group(0) @binding(0) var<uniform> u: SkyU;

const TAU = 6.28318530718;
const PI  = 3.14159265359;

fn wrapPi(a: f32) -> f32 { return a - TAU * floor((a + PI) / TAU); }
fn wrap2Pi(a: f32) -> f32 { return a - TAU * floor(a / TAU); }
fn hash31(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q = q + dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
fn hash33(p: vec3<f32>) -> vec3<f32> {
    var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    q = q + dot(q, q.yxz + 33.33);
    return fract((q.xxy + q.yxx) * q.zyx);
}
fn smin(a: f32, b: f32, k: f32) -> f32 {
    let h = max(k - abs(a - b), 0.0) / max(k, 1e-6);
    return min(a, b) - h * h * k * 0.25;
}

// Gradient + horizon glow + sun (mirrors evaluateSkyDome in sky-dome.ts).
fn skyColor(d: vec3<f32>, el: f32) -> vec3<f32> {
    var c: vec3<f32>;
    if (d.y >= 0.0) {
        c = mix(u.horizon.rgb, u.zenith.rgb, 1.0 - pow(1.0 - d.y, u.res.w));
    } else {
        c = mix(u.horizon.rgb, u.ground.rgb, smoothstep(0.0, 0.2, -el));
    }
    c = c + u.glow.rgb * (u.horizon.w * 0.42 * exp(-abs(el) / max(u.ground.w, 0.001)));
    if (u.sunDir.w > 0.0 || u.sunCol.w > 0.0) {
        let sAng = acos(clamp(dot(d, u.sunDir.xyz), -1.0, 1.0));
        let sunH = max(length(u.sunDir.xz), 1e-4);
        let dirH = max(length(d.xz), 1e-4);
        let side = max(0.0, dot(d.xz, u.sunDir.xz) / (sunH * dirH));
        let band = u.sunCol.w * 0.22 * side * side * side * exp(-max(el, 0.0) / 0.18);
        let aa = u.res.z;
        let disc = u.sunDir.w * 1.6 * (1.0 - smoothstep(0.03 - aa, 0.03 + aa, sAng)) * step(-0.01, el);
        let halo = u.sunCol.w * (0.55 * exp(-sAng / 0.08) + 0.2 * exp(-sAng / 0.35));
        c = c + u.sunCol.rgb * (band + disc + halo);
    }
    return c;
}

fn addMoon(c0: vec3<f32>, d: vec3<f32>) -> vec3<f32> {
    let vis = u.moonDir.w;
    if (vis <= 0.0) { return c0; }
    let m = u.moonDir.xyz;
    let size = u.moonCol.w;
    let aa = u.res.z;
    let ang = acos(clamp(dot(d, m), -1.0, 1.0));
    let halo = u.cloudLit.w * (0.45 * exp(-max(0.0, ang - size) / (size * 2.0)) + 0.15 * exp(-ang / 0.3));
    var c = c0 + u.moonCol.rgb * halo * vis;
    if (ang < size + 2.0 * aa) {
        // disc-local coordinates (unit radius): limb darkening + three soft maria = a stylised moon face
        let ax = normalize(cross(m, vec3<f32>(0.0, 1.0, 0.0)) + vec3<f32>(1e-4, 0.0, 0.0));
        let ay = cross(ax, m);
        let q = vec2<f32>(dot(d - m, ax), dot(d - m, ay)) / size;
        var face = 1.0 - 0.18 * dot(q, q);
        face = face - 0.12 * (1.0 - smoothstep(0.18, 0.34, length(q - vec2<f32>(-0.28, 0.22))));
        face = face - 0.09 * (1.0 - smoothstep(0.12, 0.26, length(q - vec2<f32>(0.25, -0.1))));
        face = face - 0.07 * (1.0 - smoothstep(0.08, 0.2, length(q - vec2<f32>(0.05, 0.42))));
        let cov = (1.0 - smoothstep(size - aa, size + aa, ang)) * vis;
        c = mix(c, u.moonCol.rgb * face * 1.15, cov);
    }
    return c;
}

fn stars(d: vec3<f32>, el: f32) -> vec3<f32> {
    if (u.zenith.w <= 0.0 || el < 0.02) { return vec3<f32>(0.0); }
    let K = 70.0;
    let p = d * K;
    let cell = floor(p);
    let h = hash31(cell);
    if (h > 0.085) { return vec3<f32>(0.0); }
    let j = hash33(cell + 17.0);
    let sp = cell + 0.2 + 0.6 * j;
    let dist = length(p - sp) / K;                 // ~radians
    let mag = h / 0.085;                           // 0 = brightest
    let size = u.res.z * (1.0 + 1.5 * (1.0 - mag));
    let tw = 0.8 + 0.2 * sin(u.fwd.w * (1.3 + 2.0 * j.x) + j.y * 40.0);
    let fade = smoothstep(0.02, 0.3, el) * (1.0 - min(0.85, u.horizon.w * 0.9 * exp(-el / 0.5)));
    let k = (1.0 - smoothstep(size * 0.4, size, dist)) * (1.3 - mag) * tw * fade * u.zenith.w;
    let tint = mix(vec3<f32>(0.80, 0.88, 1.0), vec3<f32>(1.0, 0.92, 0.80), j.z);
    return tint * k;
}

// The union SDF of one cloud (5 base puffs + 2 crown lumps, smooth-unioned, clipped by the flat base) at chart (x, y).
fn sectorSDF(idx: u32, x: f32, y: f32) -> f32 {
    var d = 1e9;
    for (var k = 1u; k <= ${SKY_CLOUD_LOBES}u; k = k + 1u) {
        let L = u.clouds[idx * ${SKY_CLOUD_VEC4_PER}u + k];
        d = smin(d, length(vec2<f32>(x, y) - L.xy) - L.z, L.z * ${SKY_CLOUD_SMOOTH});
    }
    return max(d, -y);
}
struct CloudHit { d: f32, x: f32, y: f32, a: f32, idx: u32 }
// The nearer of the two candidate clouds (the pixel's sector + its nearer neighbour). Header = (centre az, base el,
// opacity, cos base); x is flattened by cos(base) so the puffs stay round.
fn cloudLayer(off: u32, n: u32, az: f32, el: f32) -> CloudHit {
    let sf = az / TAU * f32(n);
    let i0 = u32(floor(sf)) % n;
    let i1 = select((i0 + n - 1u) % n, (i0 + 1u) % n, fract(sf) > 0.5);
    var best = CloudHit(1e9, 0.0, 0.0, 0.0, 0u);
    for (var j = 0u; j < 2u; j = j + 1u) {
        let idx = off + select(i1, i0, j == 0u);
        let hd = u.clouds[idx * ${SKY_CLOUD_VEC4_PER}u];
        if (hd.z <= 0.0) { continue; }
        let x = wrapPi(az - hd.x) * hd.w;
        let y = el - hd.y;
        if (y < -0.02) { continue; }   // under the flat base: never inside (saves the lobe loop)
        let d = sectorSDF(idx, x, y);
        if (d < best.d) { best = CloudHit(d, x, y, hd.z, idx); }
    }
    return best;
}
// Toon-shade one cloud hit over the sky colour behind it. The LIT region is where the silhouette, shifted toward the
// light, no longer covers the pixel (an offset-SDF test): a lit cap that follows every lump, a crisp two-tone terminator.
fn shadeCloud(h: CloudHit, d: vec3<f32>, azRaw: f32, el: f32, behind: vec3<f32>, horizonSky: vec3<f32>) -> vec3<f32> {
    let aa = u.res.z * 1.2;
    let a0 = (1.0 - smoothstep(-aa, aa, h.d)) * h.a * u.glow.w;
    if (a0 <= 0.0) { return behind; }
    let scale = u.clouds[h.idx * ${SKY_CLOUD_VEC4_PER}u + 3u].z;   // the middle puff radius
    // crisp toon edges everywhere but the flat underside, which softens into the sky (the painted-background look)
    let a = a0 * smoothstep(0.0, scale * 0.1, h.y);
    let Ld = u.cloudLight.xyz;
    let dAz = wrapPi(atan2(Ld.z, Ld.x) - azRaw);
    let l2 = normalize(vec2<f32>(sin(dAz) * 0.8, (asin(clamp(Ld.y, -1.0, 1.0)) - el) * 1.2 + 0.45));
    let dl = sectorSDF(h.idx, h.x + l2.x * scale * 0.42, h.y + l2.y * scale * 0.42);
    let lit = smoothstep(-aa, aa, dl);
    var col = mix(u.cloudShade.rgb, u.cloudLit.rgb, lit);
    col = col * (1.0 - 0.12 * (1.0 - smoothstep(0.0, scale * 0.5, h.y)) * (1.0 - lit));   // a deeper shade toward the base
    // a thin bright rim just inside the lit edge (golden rims; a silver lining toward the light)
    let rimW = scale * 0.09 + aa;
    let rimBand = (1.0 - smoothstep(rimW * 0.5, rimW, -h.d)) * lit;
    let near = exp(-acos(clamp(dot(d, Ld), -1.0, 1.0)) / 0.3);
    col = mix(col, u.cloudRim.rgb, clamp(rimBand * u.cloudShade.w * (0.6 + 1.4 * near), 0.0, 1.0));
    // undersides: the city glow at night
    let under = 1.0 - clamp(h.y / max(scale * 1.2, 1e-4), 0.0, 1.0);
    col = col + u.cloudGlow.rgb * under * exp(-max(el, 0.0) / 0.15);
    col = mix(col, horizonSky, 0.5 * exp(-max(el, 0.0) / 0.03));   // the feet of the banks melt into the haze
    return mix(behind, col, a);
}

@fragment
fn main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let ndc = vec2<f32>(frag.x / u.res.x * 2.0 - 1.0, 1.0 - frag.y / u.res.y * 2.0);
    let d = normalize(u.fwd.xyz + ndc.x * u.right.w * u.right.xyz + ndc.y * u.up.w * u.up.xyz);
    let el = asin(clamp(d.y, -1.0, 1.0));
    var c = skyColor(d, el);
    c = addMoon(c, d);
    c = c + stars(d, el);
    if (u.glow.w > 0.0 && el > -0.01 && el < 0.95) {
        let azRaw = atan2(d.z, d.x);
        let t = u.fwd.w * u.cloudRim.w;
        let hz = u.horizon.rgb + u.glow.rgb * u.horizon.w * 0.42;
        if (el < 0.42) {
            let cl = cloudLayer(0u, ${SKY_CLOUD_SECTORS_LOW}u, wrap2Pi(azRaw - t * 0.5), el);
            c = shadeCloud(cl, d, azRaw, el, c, hz);
        }
        if (el > 0.2) {
            let ch = cloudLayer(${SKY_CLOUD_SECTORS_LOW}u, ${SKY_CLOUD_SECTORS_HIGH}u, wrap2Pi(azRaw - t), el);
            c = shadeCloud(ch, d, azRaw, el, c, hz);
        }
    }
    // dither: the dark night gradient would band in 8 bits
    let n = fract(sin(dot(frag.xy, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
    c = c + vec3<f32>(n / 255.0);
    return vec4<f32>(max(c, vec3<f32>(0.0)), 1.0);
}
`;

export class SkyDomePass {
  private _device: GPUDevice;
  private _pipeline: PipelineHandle<GPURenderPipeline>;
  private _ubuf: GPUBuffer;
  private _bindGroup: GPUBindGroup;
  private _f32 = new Float32Array(SKY_DOME_HEADER_VEC4 * 4);
  private _cloudKey = '';
  private _startTime = typeof performance !== 'undefined' ? performance.now() : 0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this._device = device;
    this._ubuf = device.createBuffer({ label: 'SkyDome.uniforms', size: SKY_DOME_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this._bindGroup = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: this._ubuf } }] });
    this._pipeline = GPUPipelineCache.for(device).render({
      label: 'SkyDome',
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module: device.createShaderModule({ label: 'SkyDome.vs', code: VERT }), entryPoint: 'main' },
      fragment: { module: device.createShaderModule({ label: 'SkyDome.fs', code: FRAG }), entryPoint: 'main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      // the render pass carries a depth-stencil attachment: declare it, never read or write it (a pre-mesh backdrop)
      depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always' },
    });
  }

  /** Draw the dome. Returns false while the pipeline is still compiling (the caller then draws its fallback). */
  draw(pass: GPURenderPassEncoder, sky: SkyDomeParams, view: SkyDomeView, width: number, height: number): boolean {
    const pipe = this._pipeline.get();
    if (!pipe) return false;
    const key = `${sky.cloudSeed | 0}|${Math.round(Math.max(0, Math.min(1, sky.cloudCoverage)) * 1000)}`;
    if (key !== this._cloudKey) {
      this._cloudKey = key;
      const layout = buildSkyDomeClouds(sky.cloudSeed | 0, sky.cloudCoverage);
      this._device.queue.writeBuffer(this._ubuf, SKY_DOME_HEADER_VEC4 * 16, layout);
    }
    const t = ((typeof performance !== 'undefined' ? performance.now() : 0) - this._startTime) / 1000;
    packSkyDomeHeader(this._f32, sky, view, width, height, t);
    this._device.queue.writeBuffer(this._ubuf, 0, this._f32);
    pass.setPipeline(pipe);
    pass.setBindGroup(0, this._bindGroup);
    pass.draw(6);
    return true;
  }

  destroy(): void { this._ubuf.destroy(); }
}

/** The WGSL sources (scanned by wgsl-static-check.test.ts). */
export const SKY_DOME_WGSL_VS = VERT;
export const SKY_DOME_WGSL_FS = FRAG;
