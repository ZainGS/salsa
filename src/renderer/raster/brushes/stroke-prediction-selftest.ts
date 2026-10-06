/**
 * ON-DEVICE self-test for raster stroke prediction (BRUSH-4, docs/specs/mobile-parity.md §3).
 *
 * The provisional (predicted) tail is byte-exact on the CPU mirror and on desktop GPUs, but on a tablet it hid the
 * committed stroke (2026-10-06), which no off-device test reproduced. This runs the REAL RasterPaintEngine on the
 * device's own GPU against a private scratch texture (no document is touched): the same stroke with and without a
 * predicted tail every frame, read back after every step, inside a validation error scope. It answers, on the
 * device: does the tail draw, does taking it back restore the committed stroke exactly, and is the finished stroke
 * the same as without prediction. Run it (`sm.runStrokePredictionSelfTest()`) before turning the setting on.
 */

import { RasterPaintEngine } from '../core/raster-paint-engine';
import type { PointerInput } from './brush-engine';

export interface StrokePredictionSelfTestCase {
  preset: string;
  /** Texels the stroke changed without prediction (0 = the brush didn't paint: the case proves nothing). */
  strokeTexels: number;
  /** The same stroke run twice without prediction differs (a jittering preset): the comparison is skipped. */
  nondeterministic: boolean;
  /** Texels that differ from the no-prediction run after each frame's tail was taken back (all 0 = exact). */
  afterClear: number[];
  /** Texels the tail changed while shown, per frame (all 0 = the tail never drew). */
  tailShown: number[];
  /** Texels of the finished stroke that differ from the no-prediction run (0 = identical). */
  finalDiff: number;
  /** Texels of the committed stroke missing or changed right after the last tail was taken back. */
  ok: boolean;
}

export interface StrokePredictionSelfTestReport {
  ok: boolean;
  /** GPU validation / out-of-memory errors raised while the test ran. */
  errors: string[];
  cases: StrokePredictionSelfTestCase[];
  /** One line per case, for a console / an alert. */
  summary: string;
}

const W = 512, H = 384, FRAMES = 6;

const realPoint = (i: number): PointerInput => ({
  x: 120 + i * 9, y: 190 + Math.sin(i / 3) * 40, pressure: 0.8 + 0.2 * Math.sin(i / 5), timestamp: 1000 + i * 8,
});
const predictedAfter = (i: number): PointerInput[] => [1, 2, 3].map(k => {
  const p = realPoint(i + k);
  return { ...p, x: p.x + k * 1.5, y: p.y - k * 2 };
});

async function readTexture(device: GPUDevice, tex: GPUTexture): Promise<Uint8Array> {
  const padded = Math.ceil(W * 4 / 256) * 256;
  const buf = device.createBuffer({ size: padded * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: padded }, { width: W, height: H });
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const out = new Uint8Array(W * H * 4);
  for (let r = 0; r < H; r++) out.set(src.subarray(r * padded, r * padded + W * 4), r * W * 4);
  buf.unmap();
  buf.destroy();
  return out;
}

function diffTexels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  }
  return n;
}

async function runStroke(device: GPUDevice, preset: string, predict: boolean) {
  // The same usage as a raster layer (RasterTextureManager.ensureTexture).
  const tex = device.createTexture({
    size: [W, H], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT |
           GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const init = new Uint8Array(W * H * 4);
  for (let i = 0; i < init.length; i += 4) {
    const t = i >> 2;
    init[i] = t % 251; init[i + 1] = 120; init[i + 2] = 210; init[i + 3] = (t % 7) * 36;
  }
  device.queue.writeTexture({ texture: tex }, init, { bytesPerRow: W * 4 }, { width: W, height: H });
  const engine = new RasterPaintEngine(device, () => { /* no renderer */ });
  try {
    if (!engine.setActivePreset(preset)) throw new Error('unknown preset ' + preset);
    engine.setBrushColor(0.9, 0.25, 0.1, 1);
    engine.setActiveTexture(tex);
    const start = await readTexture(device, tex);
    const afterClear: Uint8Array[] = [], shown: Uint8Array[] = [];
    engine.beginStroke(realPoint(0), { pointerType: 'touch' });
    for (let f = 0; f < FRAMES; f++) {
      engine.addStrokePoints([1, 2, 3].map(k => realPoint(f * 3 + k)));
      if (predict) {
        engine.drawProvisionalStroke(predictedAfter(f * 3 + 3));
        shown.push(await readTexture(device, tex));   // (reads the texture directly: the tail stays on it)
        engine.clearProvisionalStroke();
      }
      afterClear.push(await readTexture(device, tex));
    }
    await engine.endStroke(realPoint(FRAMES * 3 + 1), { pushSnapshot: false });
    const end = await readTexture(device, tex);
    return { start, end, afterClear, shown };
  } finally {
    engine.destroy();
    tex.destroy();
  }
}

/**
 * Run the self-test on `device`. Takes ~a second; allocates and frees its own textures. `presets`: brush preset
 * ids to try (default: a wet brush, a stabilized pen and an eraser — the three stamp paths).
 */
export async function runStrokePredictionSelfTest(
  device: GPUDevice,
  presets: string[] = ['default_round_soft', 'default_hard_pen', 'default_eraser'],
): Promise<StrokePredictionSelfTestReport> {
  const errors: string[] = [];
  const cases: StrokePredictionSelfTestCase[] = [];
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  try {
    for (const preset of presets) {
      const off = await runStroke(device, preset, false);
      const off2 = await runStroke(device, preset, false);
      const on = await runStroke(device, preset, true);
      const strokeTexels = diffTexels(off.end, off.start);
      const nondeterministic = diffTexels(off.end, off2.end) !== 0;
      const afterClear = on.afterClear.map((t, f) => diffTexels(t, off.afterClear[f]));
      const tailShown = on.shown.map((t, f) => diffTexels(t, off.afterClear[f]));
      const finalDiff = diffTexels(on.end, off.end);
      const ok = strokeTexels > 0 && (nondeterministic || (finalDiff === 0 && afterClear.every(n => n === 0)));
      cases.push({ preset, strokeTexels, nondeterministic, afterClear, tailShown, finalDiff, ok });
    }
  } catch (e) {
    errors.push('threw: ' + (e instanceof Error ? e.message : String(e)));
  }
  for (const kind of ['out-of-memory', 'validation']) {
    try {
      const err = await device.popErrorScope();
      if (err) errors.push(kind + ': ' + err.message);
    } catch (e) {
      errors.push(kind + ' scope: ' + (e instanceof Error ? e.message : String(e)));
    }
  }
  const ok = errors.length === 0 && cases.length === presets.length && cases.every(c => c.ok);
  const summary = [
    `stroke prediction self-test: ${ok ? 'PASS' : 'FAIL'}`,
    ...cases.map(c => `${c.ok ? 'ok  ' : 'FAIL'} ${c.preset}: stroke ${c.strokeTexels} texels, after take-back [${c.afterClear.join(',')}] differ, ` +
      `final ${c.finalDiff} differ, tail drew [${c.tailShown.join(',')}]${c.nondeterministic ? ' (jittering preset: not compared)' : ''}`),
    ...errors.map(e => 'GPU error: ' + e),
  ].join('\n');
  return { ok, errors, cases, summary };
}
