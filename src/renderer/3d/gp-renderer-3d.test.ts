/**
 * gp-renderer-3d.test.ts — the CPU side of the Grease Pencil stroke pass: the uniform block the stroke shader reads and
 * the width it draws. The bug (2026-10-09): the shader read baseWidth (a WORLD-unit half-width, the panel's Width
 * slider, default 0.02) as a PIXEL half-width, so a default stroke was 0.04 px wide — nothing was ever visible.
 * Real-GPU pixels: scratchpad Dawn harness (docs/reviews/grease-pencil-2026-10-09.md).
 */
import { describe, it, expect } from 'vitest';
import { packGpStrokeUniforms, gpStrokeHalfWidthPx, GpRenderer3D } from './gp-renderer-3d';
import { GP_STROKE_UNIFORM_BYTES, GP_MIN_HALF_WIDTH_PX, GP_STROKE_VERTEX, GP_FILL_VERTEX, GP_VERTEX_BYTES, GP_FILL_UNIFORM_BYTES } from './shaders/gp-shaders';
import { webcrypto } from 'node:crypto';
import { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';
import { Camera3D } from './camera-3d';
import { recreateNode } from '../../services/shape-serializer';

describe('GP stroke uniforms', () => {
  it('pack the shader struct layout (112 bytes: vp | color | width, joint, w, h | projScaleY, minHalfPx)', () => {
    expect(GP_STROKE_UNIFORM_BYTES).toBe(112);
    const f = new Float32Array(GP_STROKE_UNIFORM_BYTES / 4);
    const i = new Int32Array(f.buffer);
    const vp = Array.from({ length: 16 }, (_, k) => k + 1);
    packGpStrokeUniforms(f, i, vp, { r: 0.1, g: 0.2, b: 0.3, a: 0.8 }, 0.5, 0.02, 3, 1280, 720, 2.5);
    expect(Array.from(f.slice(0, 16))).toEqual(vp);
    expect(f[16]).toBeCloseTo(0.1, 6); expect(f[18]).toBeCloseTo(0.3, 6);
    expect(f[19]).toBeCloseTo(0.4, 6);                       // alpha × layer opacity
    expect(f[20]).toBeCloseTo(0.02, 6);
    expect(i[21]).toBe(3);
    expect(f[22]).toBe(1280); expect(f[23]).toBe(720);
    expect(f[24]).toBe(2.5);
    expect(f[25]).toBe(GP_MIN_HALF_WIDTH_PX);
  });

  it('the shader struct carries the same fields in that order', () => {
    const order = ['viewProjection', 'color', 'baseWidth', 'jointIndex', 'canvasWidth', 'canvasHeight', 'projScaleY', 'minHalfPx'];
    const at = order.map(n => GP_STROKE_VERTEX.indexOf(n + ':'));
    expect(at.every(x => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe('GP stroke width (world-unit half-width → pixels)', () => {
  it('the default Width (0.02) on a mesh framed ~3 units away is several pixels wide, not 0.04 px', () => {
    const cam = new Camera3D({ position: [0, 0, 3], target: [0, 0, 0] });
    cam.aspect = 16 / 9;
    const p11 = (cam.getProjectionMatrix() as unknown as Float32Array)[5];
    const half = gpStrokeHalfWidthPx(0.02, 1, p11, 1080, 3);
    expect(half).toBeGreaterThan(3);
    expect(half).toBeLessThan(40);
    // perspective: twice as far → half as wide
    expect(gpStrokeHalfWidthPx(0.02, 1, p11, 1080, 6)).toBeCloseTo(half / 2, 6);
    // pen pressure scales it
    expect(gpStrokeHalfWidthPx(0.02, 0.5, p11, 1080, 3)).toBeCloseTo(half / 2, 6);
  });

  it('never thinner than the minimum (a far / zoomed-out stroke stays visible)', () => {
    expect(gpStrokeHalfWidthPx(0.002, 0.1, 1, 720, 500)).toBe(GP_MIN_HALF_WIDTH_PX);
  });

  it('orthographic (the 2D views): w = 1, projScaleY = 1 / ortho half-height', () => {
    const cam = new Camera3D({ position: [0, 0, 3], target: [0, 0, 0] });
    cam.mode = 'orthographic';
    cam.orthoSize = 2;                                       // half-height 2 world units
    const p11 = (cam.getProjectionMatrix() as unknown as Float32Array)[5];
    expect(p11).toBeCloseTo(0.5, 6);
    // 0.02 world of a 4-unit-tall view on 800 px = 4 px
    expect(gpStrokeHalfWidthPx(0.02, 1, p11, 800, 1)).toBeCloseTo(4, 6);
  });
});

describe('GP persistence — the scene-graph copy', () => {
  it('recreateNode skips GpObject3D (scene3dJSON.gpObjects is authoritative; it used to become an empty placeholder)', () => {
    expect(recreateNode({ type: 'GpObject3D', id: 'g1', layers: [] }, {} as never)).toBeNull();
  });
});

/** A WGSL struct's body without its comments. */
const structOf = (src: string, name: string): string =>
  src.slice(src.indexOf('struct ' + name), src.indexOf('};', src.indexOf('struct ' + name))).replace(/\/\/.*$/gm, '');

describe('GP shader buffer layouts match the CPU packing (each mismatch broke every frame with a stroke)', () => {
  it('GpVertex is six scalars (24 B), not a 16-byte-aligned vec3 (32 B stride)', () => {
    expect(GP_VERTEX_BYTES).toBe(24);
    const struct = structOf(GP_STROKE_VERTEX, 'GpVertex');
    expect(struct).not.toMatch(/vec3/);
    expect((struct.match(/: *f32/g) ?? []).length).toBe(6);
  });

  it('the fill reads flat xyz triples and its uniform struct fits the 96-byte buffer (no vec3 pad)', () => {
    expect(GP_FILL_VERTEX).toMatch(/triVerts: +array<f32>/);
    const struct = structOf(GP_FILL_VERTEX, 'GpFillUniforms');
    expect(struct).not.toMatch(/vec3/);
    expect(GP_FILL_UNIFORM_BYTES).toBe(96);                  // mat4 64 + vec4 16 + i32 + 3 f32 16
  });
});

describe('GpRenderer3D draws with a skin bind group at group 1 (mock device)', () => {
  it('a stroke without a bone still binds the dummy skin buffer (it was created before its buffer existed → unset)', () => {
    const g = globalThis as Record<string, unknown>;
    g.self ??= globalThis; g.crypto ??= webcrypto;
    g.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, UNIFORM: 64, VERTEX: 32, MAP_READ: 1 };
    g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
    let bg = 0;
    const device = {
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBuffer: (d: { size: number }) => ({ size: d.size, destroy() {} }),
      createBindGroup: () => ({ id: ++bg }),
      queue: { writeBuffer: () => {} },
    } as unknown as GPUDevice;
    const r = new GpRenderer3D(device, 'bgra8unorm');
    const obj = new GpObject3D({ maxGlobalZIndex: 0 } as never);
    const layer = obj.addLayer('L');
    obj.addStroke(layer, { points: [{ x: 0, y: 0, z: 0, pressure: 1, opacity: 1 }, { x: 1, y: 0, z: 0, pressure: 1, opacity: 1 }], color: { r: 0, g: 0, b: 0, a: 1 }, baseWidth: 0.02, closed: false });
    const sets: [number, unknown][] = [];
    const draws: number[] = [];
    const pass = {
      setPipeline: () => {}, setVertexBuffer: () => {},
      setBindGroup: (i: number, b: unknown) => { sets.push([i, b]); },
      draw: (n: number) => { draws.push(n); },
    } as unknown as GPURenderPassEncoder;
    const cam = new Camera3D({ position: [0, 0, 3], target: [0, 0, 0] });
    r.draw([obj], new Map(), cam, pass, 800, 600, 0);
    expect(draws).toEqual([6]);
    const g1 = sets.filter(([i]) => i === 1);
    expect(g1).toHaveLength(1);
    expect(g1[0][1]).toBeTruthy();
  });
});
