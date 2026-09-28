import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentStateCoordinator } from './document-state-coordinator';
import type { DocumentSavePayload } from './document-persistence';

// A stub whose unlisted members are no-op functions — restore() touches dozens of host hooks; this test only cares
// about the ones it overrides. `scene3d` is left undefined so the 3D / character passes are skipped entirely.
function stub<T extends object>(over: Record<string, unknown>): T {
  return new Proxy(over, {
    get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : (k === 'then' ? undefined : () => undefined)),
  }) as unknown as T;
}

function makeCoordinator(smOver: Record<string, unknown> = {}) {
  const sm = stub({
    scene3d: undefined,
    ui: { restore: vi.fn() },
    sceneGraph: { root: { children: [] } },
    interactionService: { onSceneGraphChanged: { emit: vi.fn() } },
    setSceneGraphJSON: vi.fn(async () => {}),
    ...smOver,
  });
  const priv = stub({ getRlm: () => undefined, rasterLayerManager: undefined, pendingProcTextures: new Map() });
  return new DocumentStateCoordinator(sm as never, priv as never);
}

function payload(over: Partial<DocumentSavePayload> = {}): DocumentSavePayload {
  return {
    manifest: { docId: 'd', name: 'n', layers: [], version: 3 } as unknown as DocumentSavePayload['manifest'],
    layers: [],
    ...over,
  } as DocumentSavePayload;
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('DocumentStateCoordinator.restore — records failed steps (audit 2026-09-28 P2)', () => {
  it('a clean restore reports no issues', async () => {
    const report = await makeCoordinator().restore(payload({ brushPresetsJSON: '[]' }));
    expect(report.issues).toEqual([]);
  });

  it('a step that throws is RECORDED (blocksSave) instead of silently swallowed', async () => {
    const c = makeCoordinator({ importBrushPresets: () => { throw new Error('bad presets'); } });
    const report = await c.restore(payload({ brushPresetsJSON: '{broken' }));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ area: 'brush presets', message: 'bad presets', blocksSave: true });
  });

  it('keeps restoring after a failed step and collects every failure', async () => {
    const uiRestore = vi.fn(() => { throw new Error('bad ui'); });
    const c = makeCoordinator({
      importBrushPresets: () => { throw new Error('bad presets'); },
      ui: { restore: uiRestore },
    });
    const report = await c.restore(payload({ brushPresetsJSON: 'x', uiLayersJSON: '[]' }));
    expect(uiRestore).toHaveBeenCalled();                                   // step after the failure still ran
    expect(report.issues.map((i) => i.area)).toEqual(['brush presets', 'UI layers']);
  });

  it('a failed 2D scene-graph load is recorded (setSceneGraphJSON is asked to rethrow)', async () => {
    const setSceneGraphJSON = vi.fn(async (_j: string, opts?: { rethrow?: boolean }) => {
      if (opts?.rethrow) throw new Error('corrupt scene.json');
    });
    const report = await makeCoordinator({ setSceneGraphJSON }).restore(payload({ sceneGraphJSON: '{}' }));
    expect(setSceneGraphJSON).toHaveBeenCalledWith('{}', { rethrow: true });
    expect(report.issues[0]).toMatchObject({ area: '2D scene graph', blocksSave: true });
  });

  it('P7: a load clears the 2D shape undo stack (no replaying the previous doc into this one)', async () => {
    const clear = vi.fn();
    const c = makeCoordinator({
      interactionService: { onSceneGraphChanged: { emit: vi.fn() }, vectorUndo: { clear } },
    });
    await c.restore(payload());
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('P6: clears every previous-document registry FIRST, unconditionally (even for an empty doc)', async () => {
    const order: string[] = [];
    const c = makeCoordinator({
      clearDocumentRegistriesForLoad: () => order.push('clear'),
      setSceneGraphJSON: async () => { order.push('scene'); },
    });
    await c.restore(payload({ sceneGraphJSON: '{}' }));
    expect(order).toEqual(['clear', 'scene']);
    order.length = 0;
    await c.restore(payload());                           // a doc with nothing in it still clears
    expect(order).toEqual(['clear']);
  });

  it('P6: a failure while clearing is recorded (and blocks saving)', async () => {
    const c = makeCoordinator({ clearDocumentRegistriesForLoad: () => { throw new Error('boom'); } });
    const report = await c.restore(payload());
    expect(report.issues[0]).toMatchObject({ area: 'clearing the previous document', blocksSave: true });
  });

  it('P10: a document from a NEWER build loads read-only (recorded issue → saving blocked)', async () => {
    const newer = payload();
    (newer.manifest as { schemaVersion?: number }).schemaVersion = 999;
    const report = await makeCoordinator().restore(newer);
    expect(report.issues[0]).toMatchObject({ area: 'document version', blocksSave: true });
  });

  it('P10: an older (unversioned) document loads cleanly — migrated, no issues', async () => {
    const report = await makeCoordinator().restore(payload());
    expect(report.issues).toEqual([]);
  });
});

