/**
 * ★ Autosave safety for carts (docs/specs/frogcart-cd-art-and-launch.md, Part A risk): loading / playing a .frogcart
 * in the Player must NEVER save the cart's scene into the illustration that was open before.
 *
 * importFrogcart replaces the engine's whole document (unpackProject → restoreDocumentState) but used to leave the
 * document id naming the last-open illustration (the Shell → Player and dashboard → Player paths). Every save path
 * gathers its target from that id, so any save after the restore — a stroke debounce, a timer a host left running, a
 * deferred / explicit saveNow, a tab-hide flush, a save after exitUIPlayerMode — wrote the cart into that
 * illustration. importFrogcart now stops autosave and drops the id BEFORE the restore; these tests pin that, and that
 * a save with no id writes nothing, and that Player mode itself is a busy period for every automatic save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { packFrogcart } from './frogcart';
import { DocumentPersistence } from './document-persistence';
import { createBlankDocumentPayload } from './blank-document';
import ShapeManager from '../shape-manager';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const cartBlob = () => packFrogcart({
  scenePackage: new Blob([zipSync({ 'manifest.json': strToU8('{}') }) as unknown as BlobPart]),
  meta: { title: 'Night Market' },
  stateMachineJSON: null,
});

/** The engine with illustration A open and autosave running (the state the Shell → Player path starts from). */
function engineWithIllustrationOpen() {
  const order: string[] = [];
  const persistence = { stopAutoSave: vi.fn(() => order.push('stopAutoSave')), cancelPendingSaves: vi.fn(() => order.push('cancelPendingSaves')) };
  const self = {
    currentDocId: 'illustration-A',
    currentDocName: 'A',
    persistence,
    disableAutoSave: ShapeManager.prototype.disableAutoSave,
    unpackProject: vi.fn(async () => { order.push(`restore cart while docId='${self.currentDocId}'`); }),
    registerUISound: vi.fn(),
  };
  return { self, order, persistence };
}

describe('importFrogcart never leaves the previous document as the save target', () => {
  it('stops autosave and drops the document id BEFORE the cart replaces the scene', async () => {
    const { self, order } = engineWithIllustrationOpen();
    const r = await ShapeManager.prototype.importFrogcart.call(self as never, await cartBlob());
    expect(r.manifest.title).toBe('Night Market');
    expect(order).toEqual(['stopAutoSave', 'cancelPendingSaves', "restore cart while docId=''"]);
    expect(self.currentDocId).toBe('');
    expect(self.currentDocName).toBe('Night Market');
  });

  it('a malformed cart throws before anything changes — the open document keeps saving to itself', async () => {
    const { self, persistence } = engineWithIllustrationOpen();
    const bad = new Blob([zipSync({ 'manifest.json': strToU8('{}') }) as unknown as BlobPart]);   // no scene.salsa
    await expect(ShapeManager.prototype.importFrogcart.call(self as never, bad)).rejects.toThrow(/frogcart/i);
    expect(self.currentDocId).toBe('illustration-A');
    expect(persistence.stopAutoSave).not.toHaveBeenCalled();
    expect(self.unpackProject).not.toHaveBeenCalled();
  });
});

describe('after a cart is loaded, no save can reach the illustration', () => {
  /** A real DocumentPersistence whose provider gathers the engine's CURRENT identity (as docState.gather does). */
  function persistenceFor(self: { currentDocId: string; currentDocName: string }) {
    const getDirectory = vi.fn().mockRejectedValue(new Error('a save tried to write'));
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    const p = new DocumentPersistence({ intervalMs: 0, strokeDebounceMs: 20, changeDebounceMs: 20 });
    const gathered: string[] = [];
    p.setStateProvider(async () => { gathered.push(self.currentDocId); return createBlankDocumentPayload(self.currentDocId, self.currentDocName); });
    return { p, getDirectory, gathered };
  }

  it('explicit, timed, stroke, change and tab-hide style saves all have no target — nothing is written', async () => {
    vi.useFakeTimers();
    const { self } = engineWithIllustrationOpen();
    await ShapeManager.prototype.importFrogcart.call(self as never, await cartBlob());
    const { p, getDirectory, gathered } = persistenceFor(self);
    p.startAutoSave();                 // a host that never disabled autosave
    expect(await p.saveNow()).toBe(false);
    expect(await p.saveNow({ incremental: true })).toBe(false);
    expect(await p.triggerSave()).toBe(false);
    p.notifyStrokeEnd();
    p.notifyDocumentChanged();
    await vi.advanceTimersByTimeAsync(1000);
    expect(gathered.every((id) => id === '')).toBe(true);
    expect(gathered.length).toBeGreaterThan(0);
    expect(getDirectory).not.toHaveBeenCalled();   // no write was even attempted
    p.destroy();
  });

  it('…still after the Player exits (exitUIPlayerMode does not bring the old id back)', async () => {
    const { self } = engineWithIllustrationOpen();
    await ShapeManager.prototype.importFrogcart.call(self as never, await cartBlob());
    const player = Object.assign(self, {
      _uiPlayerMode: true,
      ui: { setInteractive: vi.fn(), activeUILayerId: null },
      interactionService: { suppressBoxSelect: true },
      _uiStopAllClipPlayers: vi.fn(),
      _uiSound: { stopAll: vi.fn() },
      scheduleRender: vi.fn(),
    });
    ShapeManager.prototype.exitUIPlayerMode.call(player as never);
    expect(player._uiPlayerMode).toBe(false);
    expect(self.currentDocId).toBe('');
    const { p, getDirectory } = persistenceFor(self);
    expect(await p.saveNow()).toBe(false);
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('opening a document again binds saves to IT (the next editor session saves normally)', async () => {
    const { self } = engineWithIllustrationOpen();
    await ShapeManager.prototype.importFrogcart.call(self as never, await cartBlob());
    ShapeManager.prototype.setCurrentDocId.call(self as never, 'illustration-B', 'B');
    expect(self.currentDocId).toBe('illustration-B');
  });
});

describe('Player mode is a busy period for every automatic save (even with an id)', () => {
  it('the engine\'s persistence skips automatic saves while _uiPlayerMode is on, and defers explicit ones', async () => {
    vi.useFakeTimers();
    const gather = vi.fn(async () => createBlankDocumentPayload('illustration-A', 'A'));
    const engine = {
      docState: { gather },
      scene3d: { isPlayModeActive: () => false, getAnimationPlayer: () => null },
      ui: { interactive: true },
      _uiPlayerMode: true,
      webgpuRenderer: { isDeviceLost: false },
      rasterLayerManager: null,
      _persistBusyEpoch: () => 0,
      _notifyPersistDeferred: vi.fn(),
    };
    const p = (ShapeManager.prototype as unknown as { _createPersistence(this: unknown, c?: object): DocumentPersistence })
      ._createPersistence.call(engine, { intervalMs: 50, strokeDebounceMs: 10 });
    p.startAutoSave();
    expect(await p.triggerSave()).toBe(false);
    p.notifyStrokeEnd();
    await vi.advanceTimersByTimeAsync(500);
    expect(gather).not.toHaveBeenCalled();
    let settled = false;
    void p.saveNow().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);          // deferred until Player mode ends …
    expect(gather).not.toHaveBeenCalled();
    p.destroy();                          // … and a host leaving drops it (cancelPendingSaves)
  });
});
