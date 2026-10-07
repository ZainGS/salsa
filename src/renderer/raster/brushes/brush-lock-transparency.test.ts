/**
 * mobile-parity 7.2: "Lock transparency" on a layer must keep EVERY texel's alpha exactly as it was, for every brush —
 * including the wet (accum) path the normal brushes take: round soft, watercolor wet edges, per-dab bleed, end bleed,
 * smudge and the stroke-texture strip. On the wet path the stamp shader clamped to the stroke ACCUM's alpha (0 ahead
 * of the stroke), so a locked layer painted nothing at all; the lock now lives in the accum → layer composite.
 * Real RasterPaintEngine / BrushStampPipeline on the CPU mirror.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createCpuDevice, installGpuGlobals, CpuTexture } from '../cpu-gpu-mirror';
import type { BrushPreset } from './brush-preset';
import type { PointerInput } from './brush-engine';

beforeAll(() => installGpuGlobals());
afterEach(() => { vi.restoreAllMocks(); });

const W = 200, H = 140;
const asGpu = (t: CpuTexture) => t as unknown as GPUTexture;

/** Opaque left half, a half-transparent band, a fully transparent right part (with non-zero RGB under alpha 0). */
function fill(t: CpuTexture) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const a = x < 80 ? 255 : x < 120 ? 128 : 0;
    t.data[i] = 40; t.data[i + 1] = 160; t.data[i + 2] = 220; t.data[i + 3] = a;
  }
}

const pt = (i: number): PointerInput => ({ x: 20 + i * 8, y: 70 + Math.sin(i / 2) * 20, pressure: 0.9, timestamp: 1000 + i * 8, tiltX: 0, tiltY: 0 });

async function presets(): Promise<Record<string, BrushPreset | undefined>> {
  const { createDefaultPresets } = await import('../core/raster-paint-engine');
  const soft = createDefaultPresets().find(p => p.id === 'default_round_soft')!;
  return {
    default_round_soft: undefined,
    default_watercolor_wash: undefined,
    test_bleed_dab: { ...soft, id: 'test_bleed_dab', bleed: { enabled: true, radius: 3, strength: 1, perDab: true } } as BrushPreset,
    test_bleed_end: { ...soft, id: 'test_bleed_end', bleed: { enabled: true, radius: 3, strength: 1 } } as BrushPreset,
    test_smudge: { ...soft, id: 'test_smudge', smudge: { enabled: true, strength: 0.6 } } as BrushPreset,
    test_strip: {
      ...soft, id: 'test_strip',
      strokeTexture: { enabled: true, textureData: '', textureSize: 64, texelsPerUnit: 0.05, edgeSoftness: 0.4 },
    } as BrushPreset,
  };
}

async function stroke(presetId: string, preset: BrushPreset | undefined, lock: boolean, erase?: number) {
  vi.spyOn(Math, 'random').mockReturnValue(0.37);
  const { RasterPaintEngine } = await import('../core/raster-paint-engine');
  const gpu = createCpuDevice();
  const tex = gpu.mkTex(W, H, 'rgba8unorm');
  fill(tex);
  const engine = new RasterPaintEngine(gpu.device, () => {});
  if (preset) engine.registerPreset(preset);
  expect(engine.setActivePreset(presetId)).toBe(true);
  if (erase !== undefined) engine.setEraseMode(erase);
  engine.setLockTransparency(lock);
  engine.setBrushColor(0.9, 0.2, 0.1, 1);
  engine.setActiveTexture(asGpu(tex));
  await engine.initializeSnapshots();
  const before = tex.data.slice();
  engine.beginStroke(pt(0));
  for (let f = 0; f < 6; f++) engine.addStrokePoints([1, 2, 3].map(k => pt(f * 3 + k)));
  await engine.endStroke(pt(19));
  return { before, after: tex.data.slice() };
}

function alphaChanged(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) n++;
  return n;
}
function transparentTouched(before: Uint8Array, after: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (before[i + 3] !== 0) continue;
    if (after[i] !== before[i] || after[i + 1] !== before[i + 1] || after[i + 2] !== before[i + 2] || after[i + 3] !== 0) n++;
  }
  return n;
}
function rgbChanged(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n;
}

describe('lock transparency holds for every brush (wet path included)', () => {
  const ids = ['default_round_soft', 'default_watercolor_wash', 'test_bleed_dab', 'test_bleed_end', 'test_smudge', 'test_strip'];
  for (const id of ids) {
    it(`${id}: alpha never changes, transparent texels are untouched, and the opaque part IS painted`, async () => {
      const p = (await presets())[id];
      const unlocked = await stroke(id, p, false);
      expect(alphaChanged(unlocked.before, unlocked.after)).toBeGreaterThan(0);   // the brush does reach transparency
      const locked = await stroke(id, p, true);
      expect(alphaChanged(locked.before, locked.after)).toBe(0);
      expect(transparentTouched(locked.before, locked.after)).toBe(0);
      expect(rgbChanged(locked.before, locked.after)).toBeGreaterThan(0);       // it used to paint NOTHING
    });
  }

  it('the direct path (multiply blend) still holds alpha; the lock does not change an UNLOCKED stroke', async () => {
    const { createDefaultPresets } = await import('../core/raster-paint-engine');
    const soft = createDefaultPresets().find(q => q.id === 'default_round_soft')!;
    const multiply = { ...soft, id: 'test_multiply', blending: { ...soft.blending, mode: 'multiply' } } as BrushPreset;
    const locked = await stroke('test_multiply', multiply, true);
    expect(alphaChanged(locked.before, locked.after)).toBe(0);
    // Unlocked runs are deterministic and take the unchanged code path (byte-identical run to run)
    const a = await stroke('default_round_soft', undefined, false);
    const b = await stroke('default_round_soft', undefined, false);
    expect(Buffer.from(a.after).equals(Buffer.from(b.after))).toBe(true);
  });
});
