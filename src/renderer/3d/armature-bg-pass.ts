/**
 * ArmatureBgPass — configurable full-screen background for armature focus mode.
 *
 * Supported modes (set via ArmatureBgOptions.mode):
 *   'wavy'     — animated domain-warped procedural wave (organic flowing curves)
 *   'solid'    — flat color (color1)
 *   'gradient' — vertical gradient, color1 top → color2 bottom
 *   'checkers' — kawaii green/yellow (color1/color2) checkerboard fading to white at the bottom,
 *                with slowly-spinning clover/flower motifs in scattered cells
 *   'dim'      — semi-transparent dark overlay rendered over the scene
 *   'none'     — caller should skip draw()
 *
 * Draw order:
 *   • solid / gradient / wavy  →  caller draws BEFORE meshes (acts as background)
 *   • dim                      →  caller draws AFTER meshes, BEFORE bone overlay
 */

import type { ArmatureBgMode, ArmatureBgOptions } from '../../types/armature-3d';

// --- Shaders ---

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
struct Uniforms {
    resolution  : vec2<f32>,   // 0
    time        : f32,          // 8
    mode        : u32,          // 12
    color1      : vec4<f32>,   // 16
    color2      : vec4<f32>,   // 32
    dimStrength : f32,          // 48
    _p0         : f32,          // 52
    _p1         : f32,          // 56
    _p2         : f32,          // 60
}                               // total: 64 bytes
@group(0) @binding(0) var<uniform> u: Uniforms;

// Domain-warped wave — two passes of sinusoidal warping create organic ribbons.
fn wave(uv: vec2<f32>) -> f32 {
    // First warp layer
    let w1 = vec2<f32>(
        sin(uv.y * 2.1 + sin(uv.x * 1.4) * 1.1 + u.time * 0.48),
        sin(uv.x * 2.6 + sin(uv.y * 1.8) * 0.9 + u.time * 0.32),
    );
    let p1 = uv + w1 * 0.55;

    // Second warp layer (finer detail)
    let w2 = vec2<f32>(
        sin(p1.y * 3.5 + u.time * 0.20),
        sin(p1.x * 3.1 + u.time * 0.28),
    );
    let p2 = p1 + w2 * 0.28;

    let raw = sin(p2.x * 3.14159 * 1.7 + p2.y * 2.3 + u.time * 0.24) * 0.5 + 0.5;
    return smoothstep(0.3, 0.7, raw);
}

// Per-cell pseudo-random in [0,1).
fn hash21(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

// Signed distance to a soft 4-petal flower (polar): r minus (base + petal bumps). It's ONE closed
// curve, so the outline can never have inner arcs/holes. base = how full the center is.
// q in [-0.5, 0.5]; less than 0 = inside. (No backticks in WGSL comments — they end the template literal.)
fn cloverSDF(q: vec2<f32>) -> f32 {
    let r = length(q);
    let a = atan2(q.y, q.x);
    let base = 0.20;                               // center fullness ("disc" size)
    let shape = base + 0.09 * abs(cos(2.0 * a));   // 4 lobes
    return r - shape;
}

@fragment
fn main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    // uv: (0,0) top-left → (1,1) bottom-right
    let uv = frag.xy / u.resolution;
    // Aspect-corrected centered UV for wavy mode
    let aUV = (uv - vec2(0.5)) * vec2(u.resolution.x / u.resolution.y, 1.0);

    switch u.mode {
        case 0u: {                                           // solid
            return u.color1;
        }
        case 1u: {                                           // gradient (top→bottom)
            return mix(u.color1, u.color2, uv.y);
        }
        case 2u: {                                           // wavy
            let t = wave(aUV * 22.0);
            return mix(u.color1, u.color2, t);
        }
        case 3u: {                                           // dim overlay
            return vec4<f32>(0.0, 0.0, 0.0, u.dimStrength);
        }
        case 4u: {                                           // checkers — kawaii clover picnic
            let asp = u.resolution.x / u.resolution.y;
            // Aspect-correct, then rotate the whole grid a few degrees so it's angled like the ref.
            let ROT = -0.15;                                 // ~-8.5° tilt (other direction, gentler)
            let cr = cos(ROT); let sr = sin(ROT);
            let ctr = vec2<f32>(0.5 * asp, 0.5);
            let pc  = vec2<f32>(uv.x * asp, uv.y) - ctr;
            let p   = vec2<f32>(pc.x * cr - pc.y * sr, pc.x * sr + pc.y * cr) + ctr;
            let CELLS = 10.0;
            let cell = floor(p * CELLS);
            let fr   = fract(p * CELLS);

            // Green/yellow checkerboard with FUZZY borders: a smooth sin·sin checker field, soft-stepped
            // so cells blur into each other (cell centers stay full color; borders feather).
            let PI = 3.14159265;
            let cf = sin(p.x * CELLS * PI) * sin(p.y * CELLS * PI);   // + in color1 cells, − in color2
            let BLUR = 0.03;                                         // higher = fuzzier borders
            var col = mix(u.color2.rgb, u.color1.rgb, smoothstep(-BLUR, BLUR, cf));

            // Flowers in a hashed subset of cells, each spinning organically.
            let h = hash21(cell);
            if (h > 0.9) {                                    // ~10% of cells get a clover (4× rarer)
                let seed = h * 6.2831;
                // Sum of sines → slow spin that eases, stalls and reverses; per-cell phase desyncs them.
                let ang = sin(u.time * 0.22 + seed) * 1.6 + sin(u.time * 0.09 + seed * 2.7) * 1.0 + seed;
                let cs = cos(ang); let sn = sin(ang);
                let q0 = fr - vec2<f32>(0.5);
                let q  = vec2<f32>(q0.x * cs - q0.y * sn, q0.x * sn + q0.y * cs);
                let d  = cloverSDF(q);
                let outline = 1.0 - smoothstep(0.004, 0.12, abs(d));    // softer/blurrier hollow outline
                col = mix(col, vec3<f32>(0.0, 0.0, 0.0), outline * 0.9);
            }

            // Fade toward white at the bottom edge (gentle falloff from 0.62 → full white at 1.0).
            col = mix(col, vec3<f32>(0.0, 0.0, 0.0), smoothstep(0.62, 1.0, uv.y));
            return vec4<f32>(col, 1.0);
        }
        default: {
            return vec4<f32>(0.0);
        }
    }
}
`;

// Mode enum → WGSL u32 value
const MODE_U32: Record<ArmatureBgMode, number> = {
    solid:    0,
    gradient: 1,
    wavy:     2,
    dim:      3,
    checkers: 4,
    none:     0xff,
};

// ── Named wavy presets (Frogmarks uses these for the background style dropdown) ──

/** "Wavy Water" — light blue bg with warm cream stripes (default). */
export const ARMATURE_BG_WAVY_WATER: ArmatureBgOptions = {
    mode:   'wavy',
    color1: [0.72, 0.83, 0.91, 1.0],
    color2: [0.94, 0.92, 0.85, 1.0],
};

/** "Wavy Sage" — muted sage green bg with warm cream stripes. */
export const ARMATURE_BG_WAVY_SAGE: ArmatureBgOptions = {
    mode:   'wavy',
    color1: [0.73, 0.80, 0.71, 1.0],
    color2: [0.93, 0.91, 0.84, 1.0],
};

// "Clover Picnic" green/yellow — clearer/more saturated than a pastel; also used as the checkers default.
// Saved "Clover Picnic" green/yellow: green [0.62, 0.82, 0.47, 1], yellow [1.0, 0.95, 0.60, 1]
// (the two consts below are just color1/color2 slots — currently a dark-teal + black experiment)
const CHECKERS_GREEN:  [number, number, number, number] = [0.231, 0.380, 0.318, 1.0];  // #3B6151 dark teal
const CHECKERS_YELLOW: [number, number, number, number] = [0.0,   0.0,   0.0,   1.0];  // black

/** "Clover Picnic" — kawaii green/yellow checkerboard, fades to white at the bottom, spinning clovers. */
export const ARMATURE_BG_CHECKERS_CLOVER: ArmatureBgOptions = {
    mode:   'checkers',
    color1: CHECKERS_GREEN,
    color2: CHECKERS_YELLOW,
};

// Default fallback colors (match Wavy Water)
const DEFAULT_COLOR1: [number, number, number, number] = [0.72, 0.83, 0.91, 1.0];
const DEFAULT_COLOR2: [number, number, number, number] = [0.94, 0.92, 0.85, 1.0];
const DEFAULT_DIM    = 0.50;

const UNIFORM_FLOATS = 16; // 64 bytes / 4

export class ArmatureBgPass {
    private _device:    GPUDevice;
    private _pipeline:  GPURenderPipeline;
    private _ubuf:      GPUBuffer;
    private _bindGroup: GPUBindGroup;
    private _startTime  = performance.now();
    private _f32        = new Float32Array(UNIFORM_FLOATS);
    private _u32        = new Uint32Array(this._f32.buffer);

    constructor(device: GPUDevice, format: GPUTextureFormat) {
        this._device = device;

        this._ubuf = device.createBuffer({
            size:  UNIFORM_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const bgl = device.createBindGroupLayout({
            entries: [{
                binding:    0,
                visibility: GPUShaderStage.FRAGMENT,
                buffer:     { type: 'uniform' },
            }],
        });

        this._bindGroup = device.createBindGroup({
            layout:  bgl,
            entries: [{ binding: 0, resource: { buffer: this._ubuf } }],
        });

        this._pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            vertex: {
                module:     device.createShaderModule({ code: VERT }),
                entryPoint: 'main',
            },
            fragment: {
                module:     device.createShaderModule({ code: FRAG }),
                entryPoint: 'main',
                targets: [{
                    format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one',       dstFactor: 'zero',                operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list' },
            // Must declare depth-stencil format to match the render pass attachment state,
            // but we never read or write depth — this pass draws everywhere.
            depthStencil: {
                format:             'depth24plus-stencil8',
                depthWriteEnabled:  false,
                depthCompare:       'always',
            },
        });
    }

    /** Draw the background. Skip if mode is 'none'. */
    draw(pass: GPURenderPassEncoder, opts: ArmatureBgOptions, canvasW: number, canvasH: number): void {
        if (opts.mode === 'none') return;

        const t   = (performance.now() - this._startTime) / 1000.0;
        // Checkers falls back to green/yellow (not the wavy blue/cream) when no colors are given.
        const isCheck = opts.mode === 'checkers';
        const c1  = opts.color1      ?? (isCheck ? CHECKERS_GREEN  : DEFAULT_COLOR1);
        const c2  = opts.color2      ?? (isCheck ? CHECKERS_YELLOW : DEFAULT_COLOR2);
        const dim = opts.dimStrength ?? DEFAULT_DIM;
        const f   = this._f32;
        const u   = this._u32;

        f[0] = canvasW; f[1] = canvasH;
        f[2] = t;
        u[3] = MODE_U32[opts.mode];
        f[4] = c1[0]; f[5] = c1[1]; f[6] = c1[2]; f[7] = c1[3];
        f[8] = c2[0]; f[9] = c2[1]; f[10] = c2[2]; f[11] = c2[3];
        f[12] = dim;
        // f[13..15] = padding (zero from initialization)

        this._device.queue.writeBuffer(this._ubuf, 0, f);
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroup);
        pass.draw(6);
    }

    destroy(): void {
        this._ubuf.destroy();
    }
}
