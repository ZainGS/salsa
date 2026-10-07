/**
 * Incremental autosave (docs/ui/document-persistence.md "Incremental autosave"): an automatic save reads back only the
 * raster layers / cels whose pixels changed since their last read-back, writes only the files that differ from what
 * is on disk, and writes NOTHING when nothing changed — without ever dropping a layer from disk or skipping an edit.
 *
 * Runs the real DocumentStateCoordinator + DocumentPersistence on an in-memory OPFS (pixel format 'raw', so no canvas
 * encoder is needed) with a fake layer manager whose "GPU read-back" is counted. Pixel writes are reported exactly as
 * the real writers do: markRasterCompositeDirty / bumpGpuPixelEpoch with (or without) the texture written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentStateCoordinator } from './document-state-coordinator';
import { DocumentPersistence, type DocumentSavePayload } from './document-persistence';
import { installFakeOPFS, type FakeDir, type FakeFile } from './opfs-fake';
import { markRasterCompositeDirty } from '../../renderer/raster/core/raster-composite-dirty';
import { bumpGpuPixelEpoch } from '../../renderer/raster/gpu-pixel-epoch';
import { noteRasterContentWrite, rasterContentSeq, rasterTextureWrittenAt } from '../../renderer/raster/raster-content-version';

// ── Fakes ──────────────────────────────────────────────────────────

type Tex = { width: number; height: number; data: Uint8Array; label: string };
type FakeLayer = { id: string; name: string; type?: string; tex?: Tex; cels?: Array<{ id: string; tex: Tex }> };

const W = 2, H = 2;
function tex(label: string, v = 0): Tex {
  const data = new Uint8Array(W * H * 4);
  if (v) for (let i = 0; i < data.length; i += 4) { data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255; }
  return { width: W, height: H, data, label };
}

/** The slice of RasterLayerManager the save / load paths use. `reads` = every GPU read-back, by texture label. */
class FakeRlm {
  layers: FakeLayer[] = [];
  animation = false;
  reads: string[] = [];

  add(id: string, v: number): Tex { const t = tex(id, v); this.layers.push({ id, name: id, tex: t }); return t; }
  addAnimated(id: string, celValues: number[]): Tex[] {
    const cels = celValues.map((v, i) => ({ id: `${id}-c${i + 1}`, tex: tex(`${id}-c${i + 1}`, v) }));
    this.layers.push({ id, name: id, tex: cels[0].tex, cels });   // the displayed cel is the layer's texture
    this.animation = true;
    return cels.map((c) => c.tex);
  }
  texOf(id: string): Tex { const t = this.layers.find((l) => l.id === id)?.tex; if (!t) throw new Error(id); return t; }
  /** A brush stroke: pixels change, the pipeline reports the texture it wrote (or nothing: `attributed=false`). */
  paint(t: Tex, v: number, report: 'attributed' | 'unattributed' | 'none' = 'attributed'): void {
    for (let i = 0; i < t.data.length; i += 4) { t.data[i] = v; t.data[i + 3] = 255; }
    if (report === 'attributed') markRasterCompositeDirty({ x0: 0, y0: 0, x1: W, y1: H }, t);
    else if (report === 'unattributed') markRasterCompositeDirty();
  }

  // ── save surface ──
  getCanvasSize() { return { w: W, h: H }; }
  getLayerMetadata() {
    return this.layers.map((l) => ({
      id: l.id, name: l.name, type: (l.type ?? 'layer') as string, parentId: null, visible: true, locked: false,
      opacity: 1, blendMode: 'normal', clipped: false, lockTransparency: false,
      animationType: (l.cels ? 'animated' : 'static') as 'animated' | 'static',
      celIds: (l.cels ?? []).map((c) => c.id),
    }));
  }
  isAnimationEnabled() { return this.animation; }
  getTimeline() {
    return {
      getState: () => ({ fps: 12, frameCount: 3, loopMode: 'loop', playRangeStart: 1, playRangeEnd: 3 }),
      getOnionSkinConfig: () => ({ enabled: false, framesBefore: 1, framesAfter: 1, opacity: 0.3, tintBefore: [1, 0, 0], tintAfter: [0, 0, 1] }),
      setPlayRange: () => {},
    };
  }
  getCels(layerId: string) {
    return (this.layers.find((l) => l.id === layerId)?.cels ?? []).map((c, i) => ({ id: c.id, startFrame: i + 1, duration: 1, celType: 'key' as const }));
  }
  getPixelSources() {
    return {
      layers: this.layers.filter((l) => l.tex).map((l) => ({ id: l.id, texture: l.tex as unknown as GPUTexture })),
      cels: this.layers.flatMap((l) => (l.cels ?? []).map((c) => ({ celId: c.id, texture: c.tex as unknown as GPUTexture }))),
    };
  }
  getLayerTexture(id: string) { return (this.layers.find((l) => l.id === id)?.tex ?? null) as unknown as GPUTexture | null; }
  async readTexturePixels(t: Tex): Promise<ArrayBuffer> { this.reads.push(t.label); return t.data.slice().buffer; }

  // ── restore surface ──
  setSize() {}
  clearAllLayers() { this.layers = []; }
  getLayers() { return this.layers; }
  addLayerWithId(id: string, name: string) { if (!this.layers.some((l) => l.id === id)) this.layers.push({ id, name, tex: tex(id) }); }
  add3DDividerWithId() {}
  addVectorLayerWithId() {}
  uploadPixelsToLayer(id: string, px: ArrayBuffer): boolean {
    const t = this.layers.find((l) => l.id === id)?.tex;
    if (!t) return false;
    bumpGpuPixelEpoch('full', t);   // as RasterLayerManager does
    t.data.set(new Uint8Array(px));
    return true;
  }
  selectLayer() { return true; }
  resetAnimationForDocumentLoad() { this.animation = false; }
  resetToDefaultLayers() {}
}

/** A stub whose unlisted members are no-op functions (restore touches dozens of host hooks). */
function stub<T extends object>(over: Record<string, unknown>): T {
  return new Proxy(over, {
    get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : (k === 'then' ? undefined : () => undefined)),
  }) as unknown as T;
}

let sceneJSON = '{"root":{"children":[]}}';
function coordinatorFor(rlm: FakeRlm): DocumentStateCoordinator {
  const sm = stub({
    scene3d: undefined,
    world: undefined,
    ui: { listUILayers: () => [], serialize: () => ({}), restore: () => {} },
    sceneGraph: { root: { children: [] } },
    interactionService: { onSceneGraphChanged: { emit: () => {} } },
    getSceneGraphJSONForDocument: () => sceneJSON,
    exportAllBrushPresets: () => '[]',
    setSceneGraphJSON: async () => {},
  });
  const renderer = stub({
    getCanvasGridVisible: () => false, getCanvasGridColor: () => [0, 0, 0], getCanvasGridOpacity: () => 1, getCanvasGridCells: () => 8,
    getDevice: () => null,
  });
  const priv = stub({
    getRasterLayerManager: () => rlm,
    getWebgpuRenderer: () => renderer,
    uvPaintTextures: new Map(),
    pendingProcTextures: new Map(),
    ephemera: { serialize: () => '{"placements":[]}', deserialize: () => {} },
    garp: { hasContent: () => false },
    getDocIdentity: () => ({ id: 'doc', name: 'Doc' }),
    getDocumentSizePx: () => null,
    getPixelFormat: () => 'raw',
  });
  return new DocumentStateCoordinator(sm as never, priv as never);
}

/** Wired exactly like ShapeManager._createPersistence: automatic saves reuse pixels, explicit ones don't. */
function persistenceFor(coord: DocumentStateCoordinator): DocumentPersistence {
  const p = new DocumentPersistence({ intervalMs: 0, strokeDebounceMs: 0, pixelFormat: 'raw' });
  p.setStateProvider((o) => coord.gather(false, { reusePixels: !o?.explicit }));
  return p;
}

function file(root: FakeDir, path: string): FakeFile | undefined {
  let d: FakeDir = root;
  const segs = path.split('/');
  for (const s of segs.slice(0, -1)) { const n = d.children.get(s); if (!n || n.kind !== 'directory') return undefined; d = n; }
  const f = d.children.get(segs[segs.length - 1]);
  return f && f.kind === 'file' ? f : undefined;
}
async function bytes(root: FakeDir, path: string): Promise<number[]> {
  const f = file(root, path);
  return f ? [...new Uint8Array(await f.data.arrayBuffer())] : [];
}

let root: FakeDir;
beforeEach(() => {
  root = installFakeOPFS(vi.stubGlobal);
  sceneJSON = '{"root":{"children":[]}}';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Five painted layers, saved once (the first automatic save writes everything). */
async function fiveLayerDoc() {
  const rlm = new FakeRlm();
  for (const [i, id] of ['A', 'B', 'C', 'D', 'E'].entries()) rlm.add(id, 10 + i);
  const coord = coordinatorFor(rlm);
  const p = persistenceFor(coord);
  expect(await p.triggerSave()).toBe(true);
  rlm.reads = [];
  return { rlm, coord, p };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('raster content versions (raster-content-version.ts)', () => {
  it('an attributed write marks only its texture; an unattributed one marks every texture', () => {
    const a = {}, b = {};
    const s0 = rasterContentSeq();
    noteRasterContentWrite(a);
    expect(rasterTextureWrittenAt(a)).toBeGreaterThan(s0);
    expect(rasterTextureWrittenAt(b)).toBeLessThanOrEqual(s0);
    noteRasterContentWrite();
    expect(rasterTextureWrittenAt(b)).toBeGreaterThan(s0);
  });

  it('markRasterCompositeDirty / bumpGpuPixelEpoch report content writes (incl. "none" with a target, [] = unknown)', () => {
    const a = {}, b = {};
    let s = rasterContentSeq();
    markRasterCompositeDirty({ x0: 0, y0: 0, x1: 1, y1: 1 }, a);
    expect(rasterTextureWrittenAt(a)).toBeGreaterThan(s);
    expect(rasterTextureWrittenAt(b)).toBeLessThanOrEqual(s);
    s = rasterContentSeq();
    bumpGpuPixelEpoch('none', b);
    expect(rasterTextureWrittenAt(b)).toBeGreaterThan(s);
    expect(rasterTextureWrittenAt(a)).toBeLessThanOrEqual(s);
    s = rasterContentSeq();
    markRasterCompositeDirty(null, []);   // the brush pipeline with no recorded target → fail safe
    expect(rasterTextureWrittenAt(a)).toBeGreaterThan(s);
    expect(rasterTextureWrittenAt(b)).toBeGreaterThan(s);
  });
});

describe('incremental autosave — an edit is never skipped', () => {
  it('a stroke on one layer → saved: only that layer is read back and rewritten; all 5 files stay on disk', async () => {
    const { rlm, p } = await fiveLayerDoc();
    expect(root.list('salsa-documents/doc/layers')).toEqual(['A.bin', 'B.bin', 'C.bin', 'D.bin', 'E.bin']);
    const before = { B: file(root, 'salsa-documents/doc/layers/B.bin')!.data, E: file(root, 'salsa-documents/doc/layers/E.bin')!.data };

    rlm.paint(rlm.texOf('C'), 200);
    expect(await p.triggerSave()).toBe(true);

    expect(rlm.reads).toEqual(['C']);                                    // one read-back (was 5)
    expect(p.lastWrittenFiles).toEqual(['layers/C.bin', 'manifest.json']);
    expect((await bytes(root, 'salsa-documents/doc/layers/C.bin'))[0]).toBe(200);         // the stroke is on disk
    expect(root.list('salsa-documents/doc/layers')).toEqual(['A.bin', 'B.bin', 'C.bin', 'D.bin', 'E.bin']);
    expect(file(root, 'salsa-documents/doc/layers/B.bin')!.data).toBe(before.B);          // untouched files were not rewritten
    expect(file(root, 'salsa-documents/doc/layers/E.bin')!.data).toBe(before.E);
  });

  it('an idle timed save reads nothing back and writes nothing (and reports no "Saving…")', async () => {
    const { rlm, p } = await fiveLayerDoc();
    const onStart = vi.fn(), onDone = vi.fn();
    p.setSaveCallbacks(onStart, onDone);
    const manifest = file(root, 'salsa-documents/doc/manifest.json')!.data;
    expect(await p.triggerSave()).toBe(true);
    expect(rlm.reads).toEqual([]);
    expect(p.writeStats.unchanged).toBe(1);
    expect(file(root, 'salsa-documents/doc/manifest.json')!.data).toBe(manifest);
    expect(onStart).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('undo after a save → saved again (the undone pixels are on disk)', async () => {
    const { rlm, p } = await fiveLayerDoc();
    const t = rlm.texOf('A');
    const original = t.data.slice();
    rlm.paint(t, 99);
    await p.triggerSave();
    expect((await bytes(root, 'salsa-documents/doc/layers/A.bin'))[0]).toBe(99);
    rlm.reads = [];
    // Undo = the snapshot manager writes the BEFORE pixels back and reports [target, texture] (writeRect).
    t.data.set(original);
    bumpGpuPixelEpoch({ x0: 0, y0: 0, x1: W, y1: H }, [t, t]);
    await p.triggerSave();
    expect(rlm.reads).toEqual(['A']);
    expect(await bytes(root, 'salsa-documents/doc/layers/A.bin')).toEqual([...original]);
  });

  it('a failed write stays dirty and is retried by the next save', async () => {
    const { rlm, p } = await fiveLayerDoc();
    rlm.paint(rlm.texOf('B'), 77);
    const docDir = (root.children.get('salsa-documents') as FakeDir).children.get('doc') as FakeDir;
    const dir = docDir.children.get('layers') as FakeDir;
    const real = dir.getFileHandle.bind(dir);
    let fail = true;
    dir.getFileHandle = async (name: string, o?: { create?: boolean }) => {
      if (fail && name === 'B.bin') { fail = false; throw new DOMException('disk full', 'QuotaExceededError'); }
      return real(name, o);
    };
    expect(await p.triggerSave()).toBe(false);
    expect((await bytes(root, 'salsa-documents/doc/layers/B.bin'))[0]).toBe(11);          // not written
    expect(await p.triggerSave()).toBe(true);                              // retried
    expect((await bytes(root, 'salsa-documents/doc/layers/B.bin'))[0]).toBe(77);
    expect(rlm.reads).toEqual(['B']);                                      // the retry needed no second read-back
  });

  it('a write nobody attributed re-reads every layer (fail safe) but rewrites only the changed one', async () => {
    const { rlm, p } = await fiveLayerDoc();
    rlm.paint(rlm.texOf('D'), 150, 'unattributed');
    await p.triggerSave();
    expect(rlm.reads.sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(p.lastWrittenFiles).toEqual(['layers/D.bin', 'manifest.json']);
    expect((await bytes(root, 'salsa-documents/doc/layers/D.bin'))[0]).toBe(150);
  });

  it('a write nobody REPORTED is caught by the periodic verification read', async () => {
    const { rlm, coord, p } = await fiveLayerDoc();
    rlm.paint(rlm.texOf('E'), 123, 'none');                                // a writer that forgot to report
    await p.triggerSave();
    expect(rlm.reads).toEqual([]);                                          // invisible to the cache…
    coord.pixelVerifyIntervalMs = 1;
    await new Promise((r) => setTimeout(r, 5));
    await p.triggerSave();                                                  // …until the verification read
    expect(rlm.reads.length).toBe(5);
    expect(coord.pixelReadStats.unnotedChanges).toBe(1);
    expect((await bytes(root, 'salsa-documents/doc/layers/E.bin'))[0]).toBe(123);
    expect(p.lastWrittenFiles).toEqual(['layers/E.bin', 'manifest.json']);
  });

  it('an explicit save reads every layer fresh and writes every file', async () => {
    const { rlm, p } = await fiveLayerDoc();
    expect(await p.saveNow()).toBe(true);
    expect(rlm.reads.length).toBe(5);
    expect(p.lastWrittenFiles).toEqual(expect.arrayContaining(['layers/A.bin', 'layers/E.bin', 'scene.json', 'manifest.json']));
  });

  it('cel edits: only the edited cel is read back and rewritten', async () => {
    const rlm = new FakeRlm();
    rlm.add('BG', 5);
    const cels = rlm.addAnimated('anim', [30, 31, 32]);
    const coord = coordinatorFor(rlm);
    const p = persistenceFor(coord);
    await p.triggerSave();
    expect(root.list('salsa-documents/doc/cels')).toEqual(['anim-c1.bin', 'anim-c2.bin', 'anim-c3.bin']);
    rlm.reads = [];
    rlm.paint(cels[1], 222);
    await p.triggerSave();
    expect(rlm.reads).toEqual(['anim-c2']);
    expect(p.lastWrittenFiles).toEqual(['cels/anim-c2.bin', 'manifest.json']);
    expect((await bytes(root, 'salsa-documents/doc/cels/anim-c2.bin'))[0]).toBe(222);
    expect(root.list('salsa-documents/doc/cels')).toEqual(['anim-c1.bin', 'anim-c2.bin', 'anim-c3.bin']);
  });

  it('a new layer is saved; a deleted one leaves the manifest (its file is pruned, unchanged files never are)', async () => {
    const { rlm, coord, p } = await fiveLayerDoc();
    rlm.add('F', 60);                                                      // new layer (a new texture: not cached)
    rlm.layers = rlm.layers.filter((l) => l.id !== 'B');                   // deleted layer
    await p.triggerSave();
    expect(rlm.reads).toEqual(['F']);
    const manifest = JSON.parse(await (file(root, 'salsa-documents/doc/manifest.json')!.data.text()));
    expect(manifest.layers.map((l: { id: string }) => l.id)).toEqual(['A', 'C', 'D', 'E', 'F']);
    expect((await bytes(root, 'salsa-documents/doc/layers/F.bin'))[0]).toBe(60);
    // A fresh instance prunes on its first write (saveCount 0) — and keeps every unchanged layer's file.
    const p2 = persistenceFor(coord);
    p2.inheritWriteRecord(p);
    rlm.paint(rlm.texOf('A'), 1);
    await p2.triggerSave();
    expect(root.list('salsa-documents/doc/layers')).toEqual(['A.bin', 'C.bin', 'D.bin', 'E.bin', 'F.bin']);
  });

  it('reorder only: no read-back, the manifest is rewritten, no pixel file is', async () => {
    const { rlm, p } = await fiveLayerDoc();
    rlm.layers.reverse();
    await p.triggerSave();
    expect(rlm.reads).toEqual([]);
    expect(p.lastWrittenFiles).toEqual(['manifest.json']);
    const manifest = JSON.parse(await (file(root, 'salsa-documents/doc/manifest.json')!.data.text()));
    expect(manifest.layers.map((l: { id: string }) => l.id)).toEqual(['E', 'D', 'C', 'B', 'A']);
  });

  it('a vector-only change writes scene.json + manifest, reads no pixels', async () => {
    const { rlm, p } = await fiveLayerDoc();
    sceneJSON = '{"root":{"children":[{"id":"s1","type":"Rect"}]}}';
    await p.triggerSave();
    expect(rlm.reads).toEqual([]);
    expect(p.lastWrittenFiles).toEqual(['scene.json', 'manifest.json']);
  });

  it('clearing a layer (now blank) removes its old file right away (no resurrection on reload)', async () => {
    const { rlm, p } = await fiveLayerDoc();
    const t = rlm.texOf('C');
    t.data.fill(0);
    markRasterCompositeDirty(null, t);
    await p.triggerSave();
    expect(root.list('salsa-documents/doc/layers')).toEqual(['A.bin', 'B.bin', 'D.bin', 'E.bin']);
  });

  it('another writer changed the document on disk → the next save writes every file again', async () => {
    const { rlm, p } = await fiveLayerDoc();
    const m = JSON.parse(await (file(root, 'salsa-documents/doc/manifest.json')!.data.text()));
    m.savedAt = '2099-01-01T00:00:00Z';                                    // e.g. another tab saved it
    const f = file(root, 'salsa-documents/doc/manifest.json')!;
    f.data = new Blob([JSON.stringify(m)]);
    rlm.paint(rlm.texOf('A'), 3);
    await p.triggerSave();
    expect(rlm.reads).toEqual(['A']);                                      // pixels still come from the cache…
    expect(p.lastWrittenFiles).toEqual(expect.arrayContaining(['layers/A.bin', 'layers/B.bin', 'layers/E.bin']));   // …but every file is rewritten
  });

  it('load → no spurious save: the first automatic save after opening a document reads and writes nothing', async () => {
    await fiveLayerDoc();
    const rlm2 = new FakeRlm();
    const coord2 = coordinatorFor(rlm2);
    const p2 = persistenceFor(coord2);
    const payload = (await p2.loadDocument('doc')) as DocumentSavePayload;
    await coord2.restore(payload);
    rlm2.reads = [];
    expect(await p2.triggerSave()).toBe(true);
    expect(rlm2.reads).toEqual([]);
    expect(p2.writeStats).toMatchObject({ writes: 0, unchanged: 1 });
    // …and an edit after the load is saved, alone.
    rlm2.paint(rlm2.texOf('D'), 45);
    await p2.triggerSave();
    expect(rlm2.reads).toEqual(['D']);
    expect(p2.lastWrittenFiles).toEqual(['layers/D.bin', 'manifest.json']);
    // A host re-enabling autosave (a new instance) keeps that knowledge.
    const p3 = persistenceFor(coord2);
    p3.inheritWriteRecord(p2);
    await p3.triggerSave();
    expect(p3.writeStats.unchanged).toBe(1);
  });

  it('read-back count for a typical edit: 1 stroke on a 5-layer document = 1 read-back (was 5), idle = 0 (was 5)', async () => {
    const { rlm, p } = await fiveLayerDoc();
    rlm.paint(rlm.texOf('B'), 90);
    await p.triggerSave();
    const afterStroke = rlm.reads.length;
    rlm.reads = [];
    await p.triggerSave();
    const idle = rlm.reads.length;
    rlm.reads = [];
    await p.saveNow();                                                     // the old behaviour, every save
    const full = rlm.reads.length;
    expect({ afterStroke, idle, full }).toEqual({ afterStroke: 1, idle: 0, full: 5 });
  });
});
