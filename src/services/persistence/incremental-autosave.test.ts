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

// ── perf audit 2026-10-09 B5: leaving a document / Ctrl+S = saveNow({ incremental: true }) ──
describe('incremental explicit save (saveNow({ incremental: true }))', () => {
  it('writes only what changed — the stroke, the vector change — and leaves every other file on disk', async () => {
    const { rlm, p } = await fiveLayerDoc();
    const before = { A: file(root, 'salsa-documents/doc/layers/A.bin')!.data, E: file(root, 'salsa-documents/doc/layers/E.bin')!.data };
    rlm.paint(rlm.texOf('C'), 201);
    sceneJSON = '{"root":{"children":[{"id":"s9","type":"Rect"}]}}';
    expect(await p.saveNow({ incremental: true })).toBe(true);
    expect(rlm.reads).toEqual(['C']);                                     // one read-back (a full saveNow: 5)
    expect(p.lastWrittenFiles).toEqual(['scene.json', 'layers/C.bin', 'manifest.json']);
    expect((await bytes(root, 'salsa-documents/doc/layers/C.bin'))[0]).toBe(201);
    expect(root.list('salsa-documents/doc/layers')).toEqual(['A.bin', 'B.bin', 'C.bin', 'D.bin', 'E.bin']);
    expect(file(root, 'salsa-documents/doc/layers/A.bin')!.data).toBe(before.A);
    expect(file(root, 'salsa-documents/doc/layers/E.bin')!.data).toBe(before.E);
  });

  it('a leave-flush right after edits (no automatic save ran) loses nothing: layers, cels, deletions, blanks, new layers', async () => {
    const rlm = new FakeRlm();
    rlm.add('BG', 5); rlm.add('X', 6); rlm.add('Y', 7);
    const cels = rlm.addAnimated('anim', [30, 31, 32]);
    const coord = coordinatorFor(rlm);
    const p = persistenceFor(coord);
    await p.triggerSave();
    rlm.reads = [];
    rlm.paint(rlm.texOf('BG'), 90);                                      // a stroke
    rlm.paint(cels[2], 91);                                              // a cel edit
    const y = rlm.texOf('Y'); y.data.fill(0); markRasterCompositeDirty(null, y);   // cleared → blank
    rlm.layers = rlm.layers.filter((l) => l.id !== 'X');                 // deleted
    rlm.add('Z', 92);                                                    // new
    expect(await p.saveNow({ incremental: true })).toBe(true);
    expect(rlm.reads.sort()).toEqual(['BG', 'Y', 'Z', 'anim-c3']);
    expect((await bytes(root, 'salsa-documents/doc/layers/BG.bin'))[0]).toBe(90);
    expect((await bytes(root, 'salsa-documents/doc/cels/anim-c3.bin'))[0]).toBe(91);
    expect((await bytes(root, 'salsa-documents/doc/layers/Z.bin'))[0]).toBe(92);
    expect(root.list('salsa-documents/doc/layers')).not.toContain('Y.bin');
    const manifest = JSON.parse(await (file(root, 'salsa-documents/doc/manifest.json')!.data.text()));
    expect(manifest.layers.map((l: { id: string }) => l.id)).toEqual(['BG', 'Y', 'anim', 'Z']);
    // …and a fresh load of what the flush wrote reads back the document on screen
    const loaded = (await persistenceFor(coordinatorFor(new FakeRlm())).loadDocument('doc')) as DocumentSavePayload;
    const px = (id: string) => new Uint8Array(loaded.layers.find((l) => l.id === id)!.pixelData)[0];
    expect(px('BG')).toBe(90);
    expect(px('Z')).toBe(92);
    expect(loaded.layers.some((l) => l.id === 'X' || l.id === 'Y')).toBe(false);
    expect(new Uint8Array(loaded.cels!.find((c) => c.celId === 'anim-c3')!.pixelData)[0]).toBe(91);
  });

  it('nothing changed: reads and writes nothing, still reports "Saving…" / "Saved" (the user pressed Save)', async () => {
    const { rlm, p } = await fiveLayerDoc();
    const onStart = vi.fn(), onDone = vi.fn();
    p.setSaveCallbacks(onStart, onDone);
    const manifest = file(root, 'salsa-documents/doc/manifest.json')!.data;
    expect(await p.saveNow({ incremental: true })).toBe(true);
    expect(rlm.reads).toEqual([]);
    expect(file(root, 'salsa-documents/doc/manifest.json')!.data).toBe(manifest);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it('another writer changed the document on disk → every file is written again (the record is not trusted)', async () => {
    const { rlm, p } = await fiveLayerDoc();
    const f = file(root, 'salsa-documents/doc/manifest.json')!;
    const m = JSON.parse(await f.data.text());
    m.savedAt = '2099-01-01T00:00:00Z';
    f.data = new Blob([JSON.stringify(m)]);
    await p.saveNow({ incremental: true });
    expect(p.lastWrittenFiles).toEqual(expect.arrayContaining(['layers/A.bin', 'layers/E.bin', 'scene.json', 'manifest.json']));
  });

  it('a first save with no record (a fresh instance, nothing loaded) writes everything', async () => {
    const rlm = new FakeRlm();
    for (const id of ['A', 'B']) rlm.add(id, 3);
    const p = persistenceFor(coordinatorFor(rlm));
    await p.saveNow({ incremental: true });
    expect(p.lastWrittenFiles).toEqual(expect.arrayContaining(['layers/A.bin', 'layers/B.bin', 'scene.json', 'manifest.json']));
  });

  it('busy (Play) → deferred like any explicit save, and still incremental once it runs; a full request sharing it wins', async () => {
    const { rlm, p } = await fiveLayerDoc();
    let busy = true;
    p.setBusyPredicate(() => busy);
    rlm.paint(rlm.texOf('B'), 66);
    const pending = p.saveNow({ incremental: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(rlm.reads).toEqual([]);
    busy = false;
    expect(await pending).toBe(true);
    expect(rlm.reads).toEqual(['B']);
    expect(p.lastWrittenFiles).toEqual(['layers/B.bin', 'manifest.json']);
    rlm.reads = [];
    busy = true;
    const a = p.saveNow({ incremental: true });
    const b = p.saveNow();
    busy = false;
    await Promise.all([a, b]);
    expect(rlm.reads.length).toBe(5);                                     // the shared deferred save ran full
  });

  it('read-back count when leaving a 5-layer document after 1 stroke: incremental 1, full 5', async () => {
    const { rlm, p } = await fiveLayerDoc();
    rlm.paint(rlm.texOf('D'), 12);
    await p.saveNow({ incremental: true });
    const incremental = rlm.reads.length;
    rlm.reads = [];
    rlm.paint(rlm.texOf('D'), 13);
    await p.saveNow();
    expect({ incremental, full: rlm.reads.length }).toEqual({ incremental: 1, full: 5 });
  });
});

// ── Change-debounced autosave: any scene-graph change saves ~1.5 s later (not only the 30 s interval) ──
describe('document changes schedule the incremental autosave (notifyDocumentChanged)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await sleep(10); };
  const started = (rlm: FakeRlm, config: Record<string, number> = {}) => {
    const p = persistenceFor(coordinatorFor(rlm));
    p.setConfig(config);
    p.startAutoSave();
    return p;
  };

  it('draw vector shapes in a NEW local document, refresh 2 s later → the shapes are on disk', async () => {
    const rlm = new FakeRlm();
    rlm.add('Background', 255);
    const p = started(rlm);                          // the default debounce (1.5 s)
    const coord = coordinatorFor(rlm);
    let gatheredAt = 0;
    p.setStateProvider((o) => { gatheredAt = Date.now(); return coord.gather(false, { reusePixels: !o?.explicit }); });
    sceneJSON = '{"root":{"children":[{"id":"s1","type":"Rectangle"},{"id":"s2","type":"Ellipse"}]}}';
    const t0 = Date.now();
    p.notifyDocumentChanged();                       // ShapeManager: onSceneGraphChanged → notifyDocumentChanged
    await sleep(1000);
    expect(gatheredAt).toBe(0);                      // still debouncing
    await until(() => p.writeStats.writes > 0);
    expect(gatheredAt - t0).toBeGreaterThanOrEqual(1400);
    expect(gatheredAt - t0).toBeLessThan(2000);      // the save started before a refresh at 2 s
    // "refresh": a new instance loads what is on disk
    const loaded = await persistenceFor(coordinatorFor(new FakeRlm())).loadDocument('doc');
    expect(loaded?.sceneGraphJSON).toBe(sceneJSON);
    expect(loaded?.layers.map((l) => l.id)).toEqual(['Background']);
  });

  it('a later move / restyle after the first save is saved incrementally (scene.json + manifest only)', async () => {
    const rlm = new FakeRlm();
    rlm.add('Background', 255);
    const p = started(rlm, { changeDebounceMs: 30 });
    p.notifyDocumentChanged();
    await until(() => p.writeStats.writes === 1);
    rlm.reads = [];
    sceneJSON = '{"root":{"children":[{"id":"s1","type":"Rectangle","x":40}]}}';
    p.notifyDocumentChanged();
    await until(() => p.writeStats.writes === 2);
    expect(rlm.reads).toEqual([]);
    expect(p.lastWrittenFiles).toEqual(['scene.json', 'manifest.json']);
  });

  it('a run of changes with no pause still saves after changeMaxWaitMs, not only at the interval', async () => {
    const rlm = new FakeRlm();
    rlm.add('A', 1);
    const p = started(rlm, { changeDebounceMs: 100, changeMaxWaitMs: 300 });
    for (let i = 0; i < 20; i++) {                   // a drag: a change every 40 ms for 800 ms
      sceneJSON = `{"root":{"children":[{"id":"s1","x":${i}}]}}`;
      p.notifyDocumentChanged();
      await sleep(40);
    }
    expect(p.writeStats.writes).toBeGreaterThanOrEqual(1);
  });

  it('a stroke pause and edits in the same burst save once', async () => {
    const rlm = new FakeRlm();
    rlm.add('A', 1);
    const p = started(rlm, { strokeDebounceMs: 100, changeDebounceMs: 100 });
    p.notifyStrokeEnd();
    await sleep(30);
    p.notifyDocumentChanged();
    await sleep(30);
    p.notifyDocumentChanged();
    await sleep(400);
    expect(p.writeStats.writes).toBe(1);
  });

  it('never schedules a save while autosave is off (before start, after stop — a host that left the document)', async () => {
    const rlm = new FakeRlm();
    rlm.add('A', 1);
    const p = persistenceFor(coordinatorFor(rlm));
    p.setConfig({ changeDebounceMs: 20 });
    p.notifyDocumentChanged();                       // never started
    await sleep(80);
    p.startAutoSave();
    p.stopAutoSave();
    p.notifyDocumentChanged();                       // stopped
    await sleep(80);
    expect(p.writeStats.writes).toBe(0);
    p.startAutoSave();
    p.notifyDocumentChanged();
    p.cancelPendingSaves();                          // left the document with a change pending → dropped
    await sleep(80);
    expect(p.writeStats.writes).toBe(0);
  });

  it('changeDebounceMs: 0 turns it off', async () => {
    const rlm = new FakeRlm();
    rlm.add('A', 1);
    const p = started(rlm, { changeDebounceMs: 0 });
    p.notifyDocumentChanged();
    await sleep(100);
    expect(p.writeStats.writes).toBe(0);
  });
});
