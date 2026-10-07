import { describe, it, expect, beforeAll } from 'vitest';
import { pickCanvasFormat, isBgraFormat, readbackToRgba, readCanvasFormatOverride, CANVAS_FORMAT_OVERRIDE_KEY, type CanvasColorFormat } from './canvas-format';
import { PipelineManager } from './managers/pipeline-manager';
import { PipelineHandle } from './gpu-pipeline-cache';
import { PostProcessPass } from '../3d/post-process-pass';
import { FxaaPass } from '../3d/fxaa-pass';
import { LoFiPass } from '../3d/lofi-pass';
import { BloomPass } from '../3d/bloom-pass';
import { OutlinePass } from '../3d/outline-pass';
import { PostBgKeepPass } from '../3d/post-bg-keep-pass';

// CRASH-6 (mobile-parity): the canvas is configured with the device's preferred format (rgba8unorm on Android,
// bgra8unorm on desktop Chrome / Windows). Everything format-dependent is run under BOTH formats here; the real-GPU
// compile of every canvas-target pipeline under both formats is the Dawn harness (docs/specs/mobile-parity.md CRASH-6).

const FORMATS: CanvasColorFormat[] = ['rgba8unorm', 'bgra8unorm'];

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 };
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
  g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 };
  g.GPUMapMode ??= { READ: 1, WRITE: 2 };
});

describe('pickCanvasFormat', () => {
  const gpu = (f: string) => ({ getPreferredCanvasFormat: () => f as GPUTextureFormat });
  it('uses the preferred format (rgba8unorm on Android, bgra8unorm on desktop)', () => {
    expect(pickCanvasFormat(gpu('rgba8unorm'), null)).toBe('rgba8unorm');
    expect(pickCanvasFormat(gpu('bgra8unorm'), null)).toBe('bgra8unorm');
  });
  it('falls back to bgra8unorm without WebGPU, on a throw, or on a non-canvas answer', () => {
    expect(pickCanvasFormat(undefined, null)).toBe('bgra8unorm');
    expect(pickCanvasFormat(null, null)).toBe('bgra8unorm');
    expect(pickCanvasFormat({}, null)).toBe('bgra8unorm');
    expect(pickCanvasFormat({ getPreferredCanvasFormat: () => { throw new Error('x'); } }, null)).toBe('bgra8unorm');
    expect(pickCanvasFormat(gpu('rgba16float'), null)).toBe('bgra8unorm');
  });
  it('the override wins', () => {
    expect(pickCanvasFormat(gpu('rgba8unorm'), 'bgra8unorm')).toBe('bgra8unorm');
    expect(pickCanvasFormat(gpu('bgra8unorm'), 'rgba8unorm')).toBe('rgba8unorm');
  });
  it('reads the localStorage override (auto / junk = none)', () => {
    const store = new Map<string, string>();
    const g = globalThis as Record<string, unknown>;
    const prev = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null };
    try {
      expect(readCanvasFormatOverride()).toBeNull();
      store.set(CANVAS_FORMAT_OVERRIDE_KEY, 'rgba8unorm'); expect(readCanvasFormatOverride()).toBe('rgba8unorm');
      store.set(CANVAS_FORMAT_OVERRIDE_KEY, 'bgra8unorm'); expect(readCanvasFormatOverride()).toBe('bgra8unorm');
      store.set(CANVAS_FORMAT_OVERRIDE_KEY, 'auto'); expect(readCanvasFormatOverride()).toBeNull();
      store.set(CANVAS_FORMAT_OVERRIDE_KEY, 'r8unorm'); expect(readCanvasFormatOverride()).toBeNull();
    } finally { g.localStorage = prev; }
  });
  it('isBgraFormat', () => {
    expect(isBgraFormat('bgra8unorm')).toBe(true);
    expect(isBgraFormat('bgra8unorm-srgb')).toBe(true);
    expect(isBgraFormat('rgba8unorm')).toBe(false);
  });
});

describe('readbackToRgba (the frame read-backs) under both formats', () => {
  // Store the same RGBA image the way each format lays it out in memory, with 256-byte row padding.
  const W = 5, H = 3, PADDED = 256;
  const image = (): Uint8Array => {
    const px = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const a = i % 4 === 0 ? 0 : i % 4 === 1 ? 255 : i % 4 === 2 ? 128 : 37;
      // premultiplied colour (each channel <= alpha)
      px[i * 4] = Math.min(a, (i * 53) & 255); px[i * 4 + 1] = Math.min(a, (i * 97) & 255); px[i * 4 + 2] = Math.min(a, (i * 31 + 7) & 255); px[i * 4 + 3] = a;
    }
    return px;
  };
  const store = (rgba: Uint8Array, fmt: CanvasColorFormat): Uint8Array => {
    const buf = new Uint8Array(PADDED * H).fill(0xee);   // padding garbage must never leak
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4, d = y * PADDED + x * 4;
      const [r, g, b, a] = [rgba[s], rgba[s + 1], rgba[s + 2], rgba[s + 3]];
      if (fmt === 'bgra8unorm') { buf[d] = b; buf[d + 1] = g; buf[d + 2] = r; buf[d + 3] = a; }
      else { buf[d] = r; buf[d + 1] = g; buf[d + 2] = b; buf[d + 3] = a; }
    }
    return buf;
  };
  // The loops the renderer used before (BGRA-only): snapshotToBlob and snapshotRegionToCanvas.
  const oldSnapshotToBlob = (src: Uint8Array): Uint8ClampedArray => {
    const rgba = new Uint8ClampedArray(W * H * 4); let dst = 0;
    for (let y = 0; y < H; y++) { const row = y * PADDED; for (let x = 0; x < W; x++) { const i = row + x * 4; rgba[dst++] = src[i + 2]; rgba[dst++] = src[i + 1]; rgba[dst++] = src[i]; rgba[dst++] = src[i + 3]; } }
    return rgba;
  };
  const oldSnapshotRegion = (src: Uint8Array): Uint8ClampedArray => {
    const rgba = new Uint8ClampedArray(W * H * 4); let dst = 0;
    for (let row = 0; row < H; row++) {
      const base = row * PADDED;
      for (let col = 0; col < W; col++) {
        const i = base + col * 4, a = src[i + 3];
        if (a === 0) { rgba[dst++] = 0; rgba[dst++] = 0; rgba[dst++] = 0; rgba[dst++] = 0; continue; }
        const inv = a >= 255 ? 1 : 255 / a;
        rgba[dst++] = src[i + 2] * inv; rgba[dst++] = src[i + 1] * inv; rgba[dst++] = src[i] * inv; rgba[dst++] = a;
      }
    }
    return rgba;
  };

  for (const fmt of FORMATS) {
    it(`${fmt}: strips padding and returns RGBA`, () => {
      const px = image();
      expect([...readbackToRgba(store(px, fmt), W, H, PADDED, fmt)]).toEqual([...px]);
    });
    it(`${fmt}: un-premultiply gives the same RGBA whichever format stored it`, () => {
      const px = image();
      const viaBgra = oldSnapshotRegion(store(px, 'bgra8unorm'));   // the old (BGRA) path = the reference
      expect([...readbackToRgba(store(px, fmt), W, H, PADDED, fmt, { unpremultiply: true })]).toEqual([...viaBgra]);
    });
  }
  it('bgra8unorm output is byte-identical to the old BGRA-only loops (desktop unchanged)', () => {
    const buf = store(image(), 'bgra8unorm');
    expect([...readbackToRgba(buf, W, H, PADDED, 'bgra8unorm')]).toEqual([...oldSnapshotToBlob(buf)]);
    expect([...readbackToRgba(buf, W, H, PADDED, 'bgra8unorm', { unpremultiply: true })]).toEqual([...oldSnapshotRegion(buf)]);
  });
  it('rgba8unorm is NOT swizzled (the old loops would have swapped R and B)', () => {
    const px = image();
    const buf = store(px, 'rgba8unorm');
    expect([...readbackToRgba(buf, W, H, PADDED, 'rgba8unorm')]).toEqual([...px]);
    expect([...oldSnapshotToBlob(buf)]).not.toEqual([...px]);
  });
});

// ── Pipeline descriptors: everything that targets the canvas is built for the format it is given ──

interface Rec { descs: GPURenderPipelineDescriptor[]; device: GPUDevice }
function recordingDevice(): Rec {
  const descs: GPURenderPipelineDescriptor[] = [];
  const stub = (): unknown => new Proxy(function () { /* callable stub */ }, {
    get: (_t, k) => (k === 'then' ? undefined : k === 'width' || k === 'height' ? 1 : stub()),
    apply: () => stub(),
  });
  const device = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === 'createRenderPipelineAsync' || k === 'createComputePipelineAsync') return undefined;   // sync path
      if (k === 'createRenderPipeline') return (d: GPURenderPipelineDescriptor) => { descs.push(d); return stub(); };
      if (k === 'limits') return { maxTextureDimension2D: 8192, maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 27 };
      if (k === 'features') return new Set();
      return () => stub();
    },
  }) as unknown as GPUDevice;
  return { descs, device };
}
/** Every pipeline descriptor an object holds (direct handles, PipelineSets, arrays / maps of handles) + what it made. */
function descriptorsOf(objs: object[], rec: Rec): GPURenderPipelineDescriptor[] {
  const out: GPURenderPipelineDescriptor[] = [...rec.descs];
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 3) return;
    seen.add(v);
    if (v instanceof PipelineHandle) { if (v.kind === 'render') out.push(v.descriptor() as GPURenderPipelineDescriptor); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (v instanceof Map) { for (const x of v.values()) visit(x, depth + 1); return; }
    for (const k of Object.keys(v)) { if (k !== 'device' && k !== '_device' && k !== '_cache') visit((v as Record<string, unknown>)[k], depth + 1); }
  };
  for (const o of objs) visit(o, 0);
  return out;
}
const colourTargets = (ds: GPURenderPipelineDescriptor[]): string[] =>
  ds.flatMap((d) => (d.fragment?.targets ?? []).filter((t): t is GPUColorTargetState => !!t).map((t) => String(t.format)));

describe('canvas-target pipeline descriptors under both formats', () => {
  for (const fmt of FORMATS) {
    it(`${fmt}: every 2D PipelineManager pipeline targets the canvas format`, () => {
      const rec = recordingDevice();
      new PipelineManager(rec.device, fmt);
      const targets = colourTargets(rec.descs);
      expect(rec.descs.length).toBeGreaterThanOrEqual(15);
      expect(targets.length).toBeGreaterThanOrEqual(15);
      expect(new Set(targets)).toEqual(new Set([fmt]));
    });

    it(`${fmt}: the post / composite passes write the canvas format and never the other canvas format`, () => {
      const rec = recordingDevice();
      const passes: object[] = [
        new PostProcessPass(rec.device, fmt),
        new FxaaPass(rec.device, fmt),
        new LoFiPass(rec.device, fmt),
        new BloomPass(rec.device, fmt),
        new OutlinePass(rec.device, {} as GPUBindGroupLayout, fmt),
        new PostBgKeepPass(rec.device, fmt),
      ];
      const targets = colourTargets(descriptorsOf(passes, rec));
      expect(targets.filter((t) => t === fmt).length).toBeGreaterThanOrEqual(6);
      // bgra8unorm is never an intermediate format, so under rgba8unorm no target may be BGRA
      if (fmt === 'rgba8unorm') expect(targets).not.toContain('bgra8unorm');
    });
  }

  it('the keyed composite pipelines are distinct per format (the device cache key includes the format)', () => {
    const rec = recordingDevice();
    const handles = (o: object): PipelineHandle[] => Object.values(o).filter((v): v is PipelineHandle => v instanceof PipelineHandle);
    const compositeOf = (o: object, fmt: string): PipelineHandle | undefined => handles(o).find((h) =>
      ((h.descriptor() as GPURenderPipelineDescriptor).fragment?.targets ?? []).some((t) => t?.format === fmt));
    const bR = compositeOf(new BloomPass(rec.device, 'rgba8unorm'), 'rgba8unorm');
    const bB = compositeOf(new BloomPass(rec.device, 'bgra8unorm'), 'bgra8unorm');
    expect(bR).toBeDefined(); expect(bB).toBeDefined(); expect(bR).not.toBe(bB);
    const oR = compositeOf(new OutlinePass(rec.device, {} as GPUBindGroupLayout, 'rgba8unorm'), 'rgba8unorm');
    const oB = compositeOf(new OutlinePass(rec.device, {} as GPUBindGroupLayout, 'bgra8unorm'), 'bgra8unorm');
    expect(oR).toBeDefined(); expect(oB).toBeDefined(); expect(oR).not.toBe(oB);
  });
});
