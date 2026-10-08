/**
 * Perf audit C3 (docs/reviews/perf-audit-verified-2026-10-09.md): ONE memory budget for ALL raster undo history, on the
 * REAL RasterLayerManager + RasterTextureManager + RasterSnapshotManager over the CPU mirror device. Over budget the
 * OLDEST undo steps across all histories are dropped (folded into their seeds), never the current state; each history
 * keeps its newest step while it can; undo after a trim is still exact.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createCpuDevice, installGpuGlobals, type CpuTexture } from '../renderer/raster/cpu-gpu-mirror';
import { markRasterCompositeDirty } from '../renderer/raster/core/raster-composite-dirty';
import {
  setRasterUndoBudget, setRasterUndoTierBudget, getRasterUndoBudget, getRasterUndoMemoryStats, DEFAULT_RASTER_UNDO_BUDGET,
} from '../renderer/raster/core/raster-undo-budget';
import { capsForTier } from '../renderer/core/gpu-capabilities';
import type { RasterRectPatch } from '../renderer/raster/core/raster-snapshot-manager';

const g = globalThis as Record<string, unknown>;
g.self ??= globalThis;
g.crypto ??= webcrypto;

let RLM: typeof import('./raster-layer-manager').RasterLayerManager;
beforeAll(async () => {
  installGpuGlobals();
  RLM = (await import('./raster-layer-manager')).RasterLayerManager;
});
afterEach(() => setRasterUndoBudget(null));

const W = 8, H = 6, FRAME = W * H * 4;
const cpu = (t: GPUTexture | null | undefined) => t as unknown as CpuTexture;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function pattern(seed: number): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(FRAME);
  for (let i = 0; i < a.length; i++) a[i] = (i * 7 + seed * 31 + 1) & 255;
  return a;
}

function stroke(tex: GPUTexture, value: number, x = 1, y = 1, rw = 3, rh = 2): RasterRectPatch {
  const t = cpu(tex);
  const before = new Uint8Array(rw * rh * 4), after = new Uint8Array(rw * rh * 4);
  for (let r = 0; r < rh; r++) for (let c = 0; c < rw * 4; c++) {
    const o = ((y + r) * t.width + x) * 4 + c;
    before[r * rw * 4 + c] = t.data[o];
    t.data[o] = value;
    after[r * rw * 4 + c] = value;
  }
  markRasterCompositeDirty({ x0: x, y0: y, x1: x + rw, y1: y + rh }, tex);
  return { w: t.width, h: t.height, x, y, rw, rh, before, after };
}

/** Flatten every history earlier tests left alive, and return the bytes that cannot be trimmed (the floor). */
function isolate(): number {
  setRasterUndoBudget(1);
  const floor = getRasterUndoMemoryStats().bytes;
  setRasterUndoBudget(null);
  return floor;
}

/** A document with two LOADED layers (their undo seeds = the loaded bytes, FRAME bytes each). */
function twoLoadedLayers() {
  const gpu = createCpuDevice();
  const rlm = new RLM(gpu.device, W, H);
  rlm.clearAllLayers();
  rlm.addLayerWithId('A', 'A');
  rlm.addLayerWithId('B', 'B');
  rlm.uploadPixelsToLayer('A', pattern(1).buffer);
  rlm.uploadPixelsToLayer('B', pattern(2).buffer);
  const layer = (id: string) => {
    const l = rlm.getLayerById(id)!;
    return {
      id, tex: l.texture!, mgr: l.manager,
      /** A fill: the whole layer = `v`, one full undo entry. */
      fill: async (v: number) => { cpu(l.texture).data.fill(v); markRasterCompositeDirty(null, l.texture!); await l.manager.pushSnapshot({ noCoalesce: true }); },
      steps: () => l.manager.getHistoryStats()!.index,
    };
  };
  return { rlm, A: layer('A'), B: layer('B') };
}

describe('C3 — accounting', () => {
  it('counts what the histories really hold: blank seeds 0, loaded seeds, full entries, both halves of a patch', async () => {
    const floor = isolate();
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);   // a blank Background: blank seed, 0 bytes
    expect(getRasterUndoMemoryStats().bytes - floor).toBe(0);
    const id = rlm.getLayers()[0].id;
    rlm.selectLayer(id);
    const mgr = rlm.getSelectedLayerManager()!;
    const tex = rlm.getLayerTexture(id)!;
    await mgr.pushStrokePatch(tex, stroke(tex, 50));               // 3×2 rect: before + after
    expect(getRasterUndoMemoryStats().bytes - floor).toBe(3 * 2 * 4 * 2);
    cpu(tex).data.fill(9); markRasterCompositeDirty(null, tex);
    await mgr.pushSnapshot({ noCoalesce: true });                  // a full entry
    expect(getRasterUndoMemoryStats().bytes - floor).toBe(48 + FRAME);
    rlm.addLayerWithId('L', 'Loaded');
    rlm.uploadPixelsToLayer('L', pattern(4).buffer);               // a loaded seed holds its bytes
    expect(getRasterUndoMemoryStats().bytes - floor).toBe(48 + FRAME + FRAME);
  });

  it('defaults: 256 MB until the tier applies; desktop 768 MB, mobile / safe 256 MB; the override wins, null = tier', () => {
    expect(DEFAULT_RASTER_UNDO_BUDGET).toBe(256 * 1024 * 1024);
    expect(capsForTier('desktop').undoMemoryBytes).toBe(768 * 1024 * 1024);
    expect(capsForTier('mobile').undoMemoryBytes).toBe(256 * 1024 * 1024);
    expect(capsForTier('safe').undoMemoryBytes).toBe(256 * 1024 * 1024);
    setRasterUndoTierBudget(768 * 1024 * 1024);
    expect(getRasterUndoBudget()).toBe(768 * 1024 * 1024);
    setRasterUndoBudget(100 * 1024 * 1024);
    expect(getRasterUndoBudget()).toBe(100 * 1024 * 1024);
    setRasterUndoBudget(null);
    expect(getRasterUndoBudget()).toBe(768 * 1024 * 1024);
    setRasterUndoTierBudget(DEFAULT_RASTER_UNDO_BUDGET);
  });
});

describe('C3 — trimming', () => {
  it('drops the OLDEST undo step across layers, oldest-first; undo after the trims is exact', async () => {
    const floor = isolate();
    const { rlm, A, B } = twoLoadedLayers();
    setRasterUndoBudget(floor + 2 * FRAME + 4 * FRAME);   // the two seeds + 4 fills
    await A.fill(11); await B.fill(21); await A.fill(12); await B.fill(22);
    expect([A.steps(), B.steps()]).toEqual([2, 2]);
    await A.fill(13);                       // over → A's oldest step (A's seed → fill 11) goes
    expect([A.steps(), B.steps()]).toEqual([2, 2]);
    await B.fill(23);                       // over → B's seed → 21 is now the oldest step anywhere
    expect([A.steps(), B.steps()]).toEqual([2, 2]);
    await A.fill(14);                       // over → A's 11 → 12 (older than B's 21 → 22)
    expect([A.steps(), B.steps()]).toEqual([2, 2]);
    expect(getRasterUndoMemoryStats().bytes - floor).toBeLessThanOrEqual(6 * FRAME);

    expect(await rlm.undoForLayer('A')).toBe(true);
    expect(cpu(A.tex).data.every(v => v === 13)).toBe(true);
    expect(await rlm.undoForLayer('A')).toBe(true);
    expect(cpu(A.tex).data.every(v => v === 12)).toBe(true);
    expect(await rlm.undoForLayer('A')).toBe(false);
    expect(await rlm.undoForLayer('B')).toBe(true);
    expect(await rlm.undoForLayer('B')).toBe(true);
    expect(cpu(B.tex).data.every(v => v === 21)).toBe(true);
    expect(await rlm.undoForLayer('B')).toBe(false);
    expect(await rlm.redoForLayer('B')).toBe(true);
    expect(cpu(B.tex).data.every(v => v === 22)).toBe(true);
  });

  it('a tiny budget: the layer being edited keeps its newest step, the others go down to their current state', async () => {
    const floor = isolate();
    const { rlm, A, B } = twoLoadedLayers();
    await B.fill(31); await B.fill(32);
    await A.fill(41); await A.fill(42);
    setRasterUndoBudget(floor + 1);
    await A.fill(43);
    expect(A.steps()).toBe(1);   // the active history: one undo step left
    expect(B.steps()).toBe(0);   // only its current pixels
    expect(cpu(B.tex).data.every(v => v === 32)).toBe(true);   // never the current state
    expect(await rlm.undoForLayer('B')).toBe(false);
    expect(await rlm.undoForLayer('A')).toBe(true);
    expect(cpu(A.tex).data.every(v => v === 42)).toBe(true);
    expect(await rlm.redoForLayer('A')).toBe(true);
    expect(cpu(A.tex).data.every(v => v === 43)).toBe(true);
  });

  it('stroke patches on a blank seed: trims fold into a full frame only when that frees memory; undo stays exact', async () => {
    const floor = isolate();
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);
    const id = rlm.getLayers()[0].id;
    rlm.selectLayer(id);
    const mgr = rlm.getSelectedLayerManager()!;
    const tex = rlm.getLayerTexture(id)!;
    const PATCH = 3 * 2 * 4 * 2;
    setRasterUndoBudget(floor + 300);
    const states: Uint8Array[] = [];
    for (let i = 0; i < 4; i++) {           // 4 patches = 192 B on a blank seed: under budget, nothing trimmed
      await mgr.pushStrokePatch(tex, stroke(tex, 60 + i, i % 5, i % 4));
      states.push(cpu(tex).data.slice());
    }
    expect(mgr.getHistoryStats()!.index).toBe(4);
    for (let i = 4; i < 9; i++) {
      await mgr.pushStrokePatch(tex, stroke(tex, 60 + i, i % 5, i % 4));
      states.push(cpu(tex).data.slice());
    }
    const st = mgr.getHistoryStats()!;
    expect(st.kinds[0]).toBe('full');
    expect(getRasterUndoMemoryStats().bytes - floor).toBeLessThanOrEqual(300);
    expect(getRasterUndoMemoryStats().bytes - floor).toBe(FRAME + st.index * PATCH);
    const steps = st.index;
    expect(steps).toBeGreaterThanOrEqual(1);
    for (let k = 1; k <= steps; k++) {
      expect(await rlm.undoForLayer(id)).toBe(true);
      expect(same(cpu(tex).data, states[8 - k])).toBe(true);
    }
    expect(await rlm.undoForLayer(id)).toBe(false);
  });

  it('a few blank-seeded patches are not folded (that would GROW memory): nothing is trimmed', async () => {
    const floor = isolate();
    const gpu = createCpuDevice();
    const rlm = new RLM(gpu.device, W, H);
    const id = rlm.getLayers()[0].id;
    rlm.selectLayer(id);
    const mgr = rlm.getSelectedLayerManager()!;
    const tex = rlm.getLayerTexture(id)!;
    setRasterUndoBudget(floor + 100);
    for (let i = 0; i < 3; i++) await mgr.pushStrokePatch(tex, stroke(tex, 70 + i, i, i));
    // 3 × 48 = 144 B > 100, but folding into the blank seed would hold a 192 B frame: kept as is
    expect(mgr.getHistoryStats()!.index).toBe(3);
    expect(mgr.getHistoryStats()!.kinds).toEqual(['full', 'rect', 'rect', 'rect']);
  });
});
