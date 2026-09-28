import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentPersistence, type DocumentSavePayload } from './document-persistence';

// isOPFSAvailable() only checks that navigator.storage.getDirectory exists. Stub it (rejecting, so a save that gets
// past the gates fails fast inside writeToOPFS instead of touching real storage). We assert on whether the STATE
// PROVIDER was called — that is the moment a save snapshots the scene, i.e. the thing the load guard must prevent.
beforeEach(() => {
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockRejectedValue(new Error('no opfs in test')) } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function make(provider: () => Promise<DocumentSavePayload>) {
  const p = new DocumentPersistence({ intervalMs: 0, strokeDebounceMs: 50 });
  p.setStateProvider(provider);
  return p;
}
const failingProvider = () => vi.fn(async (): Promise<DocumentSavePayload> => { throw new Error('gathered'); });

describe('DocumentPersistence load guard (audit 2026-09-28 P1)', () => {
  it('saves normally when not suspended', async () => {
    const gather = failingProvider();
    await make(gather).triggerSave();
    expect(gather).toHaveBeenCalledTimes(1);
  });

  it('suspend() blocks automatic AND explicit saves until resume()', async () => {
    const gather = failingProvider();
    const p = make(gather);
    await p.suspend();
    expect(p.isSuspended).toBe(true);
    expect(await p.triggerSave()).toBe(false);
    expect(await p.saveNow()).toBe(false);
    expect(gather).not.toHaveBeenCalled();
    p.resume();
    await p.saveNow();
    expect(gather).toHaveBeenCalledTimes(1);
  });

  it('is nestable — stays blocked until every suspend is resumed', async () => {
    const gather = failingProvider();
    const p = make(gather);
    await p.suspend(); await p.suspend();
    p.resume();
    await p.saveNow();
    expect(gather).not.toHaveBeenCalled();
    p.resume();
    await p.saveNow();
    expect(gather).toHaveBeenCalledTimes(1);
  });

  it('suspend() cancels a pending stroke-debounce save (it must not fire mid-load)', async () => {
    vi.useFakeTimers();
    const gather = failingProvider();
    const p = make(gather);
    p.notifyStrokeEnd();                 // schedules a save in 50ms
    await p.suspend();
    p.resume();                          // load finished before the debounce would have fired
    await vi.advanceTimersByTimeAsync(200);
    expect(gather).not.toHaveBeenCalled();
  });

  it('suspend() waits for a save that is already writing before it resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gather = vi.fn(async (): Promise<DocumentSavePayload> => { await gate; throw new Error('gathered'); });
    const p = make(gather);
    const inFlight = p.saveNow();
    let suspended = false;
    const s = p.suspend().then(() => { suspended = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(suspended).toBe(false);       // still waiting on the in-flight save
    release();
    await inFlight; await s;
    expect(suspended).toBe(true);
  });

  it('setSaveBlocked() blocks every save until cleared (failed-restore protection)', async () => {
    const gather = failingProvider();
    const p = make(gather);
    p.setSaveBlocked('document restore failed: boom');
    expect(p.saveBlocked).toContain('boom');
    expect(await p.saveNow()).toBe(false);
    expect(await p.triggerSave()).toBe(false);
    expect(gather).not.toHaveBeenCalled();
    p.setSaveBlocked(null);
    await p.saveNow();
    expect(gather).toHaveBeenCalledTimes(1);
  });
});

describe('busy predicate (Play / UI preview / Player mode — audit P11)', () => {
  it('blocks AUTOMATIC saves while busy; an explicit saveNow still runs', async () => {
    const gather = failingProvider();
    const p = make(gather);
    let busy = true;
    p.setBusyPredicate(() => busy);
    expect(await p.triggerSave()).toBe(false);
    expect(gather).not.toHaveBeenCalled();
    await p.saveNow();                                   // deliberate user save is honoured
    expect(gather).toHaveBeenCalledTimes(1);
    busy = false;                                        // preview ended → autosave resumes
    await p.triggerSave();
    expect(gather).toHaveBeenCalledTimes(2);
  });
});

// ── Real write → read round trip against an in-memory OPFS ─────────────────────────────────────────────────────
import { installFakeOPFS } from './opfs-fake';

function roundTripPayload(over: Partial<DocumentSavePayload> = {}): DocumentSavePayload {
  return {
    manifest: { docId: 'doc1', name: 'Doc', version: 3, layers: [], createdAt: 0, updatedAt: 0 },
    layers: [],
    ...over,
  } as unknown as DocumentSavePayload;
}

describe('DocumentPersistence OPFS round trip', () => {
  it('P3: GARP pools + UI layers are written to disk and read back', async () => {
    const root = installFakeOPFS(vi.stubGlobal);
    const garp = { pools: [{ id: 'p1', name: 'Shops' }], textures: { t1: { kind: 'img' } } };
    const ui = JSON.stringify([{ id: 'ui1', name: 'Menu' }]);
    const p = make(async () => roundTripPayload({ garpJSON: garp, uiLayersJSON: ui }));
    expect(await p.saveNow()).toBe(true);
    expect(root.list('salsa-documents/doc1')).toEqual(expect.arrayContaining(['garp.json', 'ui.json']));

    const loaded = await p.loadDocument('doc1');
    expect(loaded?.garpJSON).toEqual(garp);
    expect(loaded?.uiLayersJSON).toBe(ui);
  });

  it('P3: removing the last pool / UI layer deletes the file (no resurrection on reload)', async () => {
    const root = installFakeOPFS(vi.stubGlobal);
    let state = roundTripPayload({ garpJSON: { pools: [], textures: {} }, uiLayersJSON: '[]' });
    const p = make(async () => state);
    await p.saveNow();
    expect(root.list('salsa-documents/doc1')).toEqual(expect.arrayContaining(['garp.json', 'ui.json']));
    state = roundTripPayload({ garpJSON: null, uiLayersJSON: null });   // user deleted them all
    await p.saveNow();
    expect(root.list('salsa-documents/doc1')).not.toContain('garp.json');
    expect(root.list('salsa-documents/doc1')).not.toContain('ui.json');
    const loaded = await p.loadDocument('doc1');
    expect(loaded?.garpJSON).toBeNull();
    expect(loaded?.uiLayersJSON).toBeNull();
  });

  it('P0: a save that did not gather models3d never prunes existing GLBs', async () => {
    const root = installFakeOPFS(vi.stubGlobal);
    const glb = new Uint8Array([1, 2, 3]).buffer;
    const full = roundTripPayload({ models3d: { m1: glb }, models3dComplete: true });
    let state = full;
    const p = make(async () => state);
    await p.saveNow();                                                  // save #0 (prunes) with the full store
    expect(root.list('salsa-documents/doc1/models3d')).toEqual(['m1.glb']);
    state = roundTripPayload({ models3d: {}, models3dComplete: false }); // e.g. only a 2D stroke changed
    for (let i = 0; i < 8; i++) await p.saveNow();                     // crosses the every-8th prune
    expect(root.list('salsa-documents/doc1/models3d')).toEqual(['m1.glb']);
  });

  it('P2 (save side): a texture that failed to export is not pruned from disk', async () => {
    const root = installFakeOPFS(vi.stubGlobal);
    const png = new Uint8Array([9]).buffer;
    let state = roundTripPayload({ meshTextures: { a: png, b: png } });
    const p = make(async () => state);
    await p.saveNow();
    expect(root.list('salsa-documents/doc1/meshTextures')).toEqual(['a.png', 'b.png']);
    state = roundTripPayload({ meshTextures: { a: png }, meshTexturesComplete: false });  // 'b' failed to export
    for (let i = 0; i < 8; i++) await p.saveNow();
    expect(root.list('salsa-documents/doc1/meshTextures')).toEqual(['a.png', 'b.png']);
  });
});

describe('save integrity (audit 2026-09-28 P9)', () => {
  it('writes manifest.json LAST — it is the commit record', async () => {
    const root = installFakeOPFS(vi.stubGlobal);
    const p = make(async () => roundTripPayload({ sceneGraphJSON: '{}', uiLayersJSON: '[]', ephemeraJSON: '{}' }));
    await p.saveNow();
    const dir = await root.getDirectoryHandle('salsa-documents').then((d) => d.getDirectoryHandle('doc1'));
    const files = [...dir.children.keys()];              // Map = creation order
    expect(files[files.length - 1]).toBe('manifest.json');
    expect(files).toContain('scene.json');
  });

  it('an explicit save waits for a running save — two writes never overlap', async () => {
    installFakeOPFS(vi.stubGlobal);
    let running = 0, maxRunning = 0, release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const p = make(async () => {
      calls++; running++; maxRunning = Math.max(maxRunning, running);
      if (calls === 1) await first;                     // the first save is slow
      running--;
      return roundTripPayload();
    });
    const a = p.saveNow();
    const b = p.saveNow();                               // user hits Save while the first is still writing
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);                               // b has NOT started gathering yet
    release();
    await a; await b;
    expect(calls).toBe(2);
    expect(maxRunning).toBe(1);
  });

  it('writes under a per-document Web Lock when the Locks API exists', async () => {
    const root = installFakeOPFS(vi.stubGlobal);
    const names: string[] = [];
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => root },
      locks: { request: async (name: string, _o: unknown, fn: () => Promise<unknown>) => { names.push(name); return fn(); } },
    });
    await make(async () => roundTripPayload()).saveNow();
    expect(names).toEqual(['salsa-doc:doc1']);
  });

  it('saves when the tab is hidden (flush on close / tab switch), and stops listening after stopAutoSave', async () => {
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (t: string, f: () => void) => listeners.set(t, f),
      removeEventListener: (t: string) => listeners.delete(t),
    };
    vi.stubGlobal('document', { ...target, visibilityState: 'hidden' });
    vi.stubGlobal('window', target);
    vi.useFakeTimers();
    const gather = failingProvider();
    const p = new DocumentPersistence({ intervalMs: 30_000, strokeDebounceMs: 0 });
    p.setStateProvider(gather);
    p.startAutoSave();
    listeners.get('visibilitychange')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(gather).toHaveBeenCalledTimes(1);
    p.stopAutoSave();
    expect(listeners.size).toBe(0);
  });
});

describe('newer-document guard on write (audit 2026-09-28 P10)', () => {
  it('refuses to overwrite a document whose on-disk manifest is from a NEWER build, and blocks further saves', async () => {
    const root = installFakeOPFS(vi.stubGlobal);
    const docDir = await (await root.getDirectoryHandle('salsa-documents', { create: true })).getDirectoryHandle('doc1', { create: true });
    const f = await docDir.getFileHandle('manifest.json', { create: true });
    const w = await f.createWritable(); await w.write(JSON.stringify({ docId: 'doc1', schemaVersion: 99 })); await w.close();

    const p = make(async () => roundTripPayload({ sceneGraphJSON: '{"mine":1}' }));
    expect(await p.saveNow()).toBe(false);
    expect(p.saveBlocked).toMatch(/newer version of Salsa/);
    expect(docDir.list()).toEqual(['manifest.json']);                       // nothing of ours was written
    expect(JSON.parse(await (await docDir.getFileHandle('manifest.json')).getFile().then((b) => b.text())).schemaVersion).toBe(99);
  });

  it('saves normally over a same-or-older on-disk manifest', async () => {
    const root = installFakeOPFS(vi.stubGlobal);
    const p = make(async () => roundTripPayload({ sceneGraphJSON: '{}' }));
    expect(await p.saveNow()).toBe(true);                                    // no manifest on disk yet
    expect(await p.saveNow()).toBe(true);                                    // our own (current) manifest on disk
    expect(root.list('salsa-documents/doc1')).toContain('scene.json');
  });
});

