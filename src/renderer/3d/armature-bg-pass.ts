/**
 * ArmatureBgPass — configurable full-screen background for armature focus mode.
 *
 * Supported modes (set via ArmatureBgOptions.mode):
 *   'wavy'     — animated domain-warped procedural wave (organic flowing curves)
 *   'solid'    — flat color (color1)
 *   'gradient' — vertical gradient, color1 top → color2 bottom
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
        const c1  = opts.color1      ?? DEFAULT_COLOR1;
        const c2  = opts.color2      ?? DEFAULT_COLOR2;
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
