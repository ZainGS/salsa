/**
 * New-document audit 2026-10-06: a NEW document must start blank — nothing of the document that was open before
 * (the ShapeManager outlives every document). These tests replay "previous document open → startBlankDocument /
 * restore of the blank payload" against the REAL RasterLayerManager + AnimationTimeline (mock GPU device), the REAL
 * DocumentStateCoordinator and a REAL SceneGraph, and pin every reset the blank path relies on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBlankDocumentPayload, DEFAULT_CANVAS_GRID, EMPTY_EPHEMERA_JSON, EMPTY_SCENE_GRAPH_JSON } from './blank-document';
import { DocumentStateCoordinator } from './document-state-coordinator';
import { DocumentPersistence, type DocumentSavePayload } from './document-persistence';
import { RasterLayerManager } from '../raster-layer-manager';
import { AnimationTimeline } from '../../animation/animation-timeline';
import { DEFAULT_ONION_SKIN } from '../../animation/animation-types';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { Node } from '../../scene-graph/shapes/base/node';
import { defaultDitherConfig } from '../../renderer/raster/effects/dither-engine';
import { Scene3DTextures } from '../managers/scene3d-textures';
import { Scene3DManager } from '../managers/scene3d-manager';
import ShapeManager from '../shape-manager';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

// ── Mock GPU device (texture tokens; everything else inert) — same shape as packaging-fresh-create.test.ts ──────────
const g = globalThis as Record<string, unknown>;
g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };
const permissive: any = new Proxy(function () { /* callable */ }, {
  get: (_t, p) => (p === 'then' ? undefined : permissive),
  apply: () => permissive,
});
function makeMockDevice(): GPUDevice {
  return {
    createTexture: (desc: { size: number[] }) => {
      const tex = { width: desc.size[0], height: desc.size[1], destroyed: false, destroy() { tex.destroyed = true; }, createView: () => ({}) };
      return tex;
    },
    createBuffer: (desc: { size: number }) => ({
      size: desc.size, mapAsync: async () => undefined, getMappedRange: () => new ArrayBuffer(desc.size), unmap() { /* */ }, destroy() { /* */ },
    }),
    createCommandEncoder: () => ({
      beginRenderPass: () => permissive, beginComputePass: () => permissive,
      copyTextureToTexture() { /* */ }, copyTextureToBuffer() { /* */ }, copyBufferToTexture() { /* */ }, copyBufferToBuffer() { /* */ },
      finish: () => ({}),
    }),
    createBindGroupLayout: () => permissive, createPipelineLayout: () => permissive, createShaderModule: () => permissive,
    createComputePipeline: () => permissive, createRenderPipeline: () => permissive, createSampler: () => permissive,
    createBindGroup: () => permissive,
    queue: { submit() { /* */ }, writeTexture() { /* */ }, writeBuffer() { /* */ }, copyExternalImageToTexture() { /* */ }, onSubmittedWorkDone: async () => undefined },
  } as unknown as GPUDevice;
}

/** A Node with a scene-graph id (registers in the SceneGraph id map like a Shape). */
class IdNode extends Node {
  constructor(public id: string) { super(); }
  peekId(): string { return this.id; }
}

/** "Document A" is open: painted layers + a folder, animation on, a 2D shape and a "3D mesh" in the scene graph,
 *  non-default dither / grid / ephemera, undo history. Returns the coordinator wired to that state + spies. */
function documentAOpen() {
  const rlm = new RasterLayerManager(makeMockDevice(), 800, 600);
  rlm.addLayer('Ink');
  rlm.addLayer('Colour');
  rlm.addVectorLayer('Vector A');
  rlm.setAnimationEnabled(true);
  rlm.getTimeline().setFrameCount(48);
  rlm.getTimeline().setFps(24);
  rlm.getTimeline().setLoopMode('ping-pong');
  rlm.getTimeline().setPlayRange(5, 40);
  rlm.setOnionSkinConfig({ enabled: true, framesBefore: 5 });
  const docALayerIds = rlm.getLayers().map((l) => l.id);

  const sceneGraph = new SceneGraph();
  sceneGraph.root.addChild(new IdNode('shape-A'));
  sceneGraph.root.addChild(new IdNode('mesh-A'));

  const calls: string[] = [];
  const grid: Record<string, unknown> = {};
  const renderer = {
    setCanvasGridColor: (r: number, g: number, b: number) => { grid.color = [r, g, b]; },
    setCanvasGridOpacity: (o: number) => { grid.opacity = o; },
    setCanvasGridCells: (n: number) => { grid.cells = n; },
    setCanvasGridVisible: (v: boolean) => { grid.visible = v; },
  };
  const ephemera = { deserialize: vi.fn() };
  const setDitherConfig = vi.fn();
  const vectorUndoClear = vi.fn();
  const clearUndo3D = vi.fn();
  const emit = vi.fn();
  const recoverOrphanedVectorContent = vi.fn();
  const sm = new Proxy({
    scene3d: undefined,
    sceneGraph,
    ui: { restore: vi.fn() },
    interactionService: { onSceneGraphChanged: { emit }, vectorUndo: { clear: vectorUndoClear } },
    // The real scene-graph replacement (removeChild loop, unregistering each subtree from the id map).
    setSceneGraphJSON: async (json: string) => {
      calls.push('scene');
      ShapeManager.prototype.updateSceneGraph.call({ recreateNode: () => null }, sceneGraph.root, JSON.parse(json).root);
    },
    clearDocumentRegistriesForLoad: () => calls.push('clear-registries'),
    clearProceduralRegistriesForLoad: () => calls.push('clear-procedural'),
    clearDocumentSize: () => calls.push('clear-doc-size'),
    setDocumentSize: (w: number, h: number) => calls.push(`doc-size ${w}x${h}`),
    setDitherConfig,
    clearUndo3D,
    setAnimationEnabled: (on: boolean) => rlm.setAnimationEnabled(on),
  } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : (k === 'then' ? undefined : () => undefined)),
  });
  const priv = new Proxy({
    getRasterLayerManager: () => rlm,
    getWebgpuRenderer: () => renderer,
    getSceneGraph: () => sceneGraph,
    ephemera,
    pendingProcTextures: new Map(),
    uvPaintTextures: new Map(),
    recoverOrphanedVectorContent,
  } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : (k === 'then' ? undefined : () => undefined)),
  });
  const coordinator = new DocumentStateCoordinator(sm as never, priv as never);
  return { rlm, sceneGraph, coordinator, calls, grid, ephemera, setDitherConfig, vectorUndoClear, clearUndo3D, emit, docALayerIds, recoverOrphanedVectorContent };
}

describe('the blank document payload', () => {
  it('is an empty, unanimated, unbounded document under the given id', () => {
    const p = createBlankDocumentPayload('local-new', 'Untitled');
    expect(p.manifest.docId).toBe('local-new');
    expect(p.manifest.layers).toEqual([]);
    expect(p.manifest.animation).toBeNull();
    expect(p.manifest.documentSize).toBeNull();
    expect(p.manifest.canvasGrid).toEqual(DEFAULT_CANVAS_GRID);
    expect(JSON.parse(p.sceneGraphJSON!).root.children).toEqual([]);
    for (const k of ['scene3dJSON', 'textureLibrary', 'ephemeraJSON', 'garpJSON', 'uiLayersJSON'] as const) expect(p[k]).toBeNull();
    expect(p.layers).toEqual([]);
    expect(p.cels).toEqual([]);
  });

  it('carries a bounded artboard size when given one (the New Illustration dialog)', () => {
    const p = createBlankDocumentPayload('d', 'n', { documentSize: { w: 1920, h: 1080 } });
    expect(p.manifest.documentSize).toEqual({ w: 1920, h: 1080 });
    expect(createBlankDocumentPayload('d', 'n', { documentSize: { w: 0, h: 10 } }).manifest.documentSize).toBeNull();
  });
});

describe('restoring the blank payload over an open document leaves nothing of it', () => {
  it('layers, pixels, animation, scene graph, settings, ephemera and undo all go back to a new document\'s', async () => {
    const a = documentAOpen();
    const report = await a.coordinator.restore(createBlankDocumentPayload('new-doc', 'Untitled'));
    expect(report.issues).toEqual([]);

    // Layers: exactly the default stack, freshly minted (none of document A's ids, so none of its pixels / cels).
    // (The same stack a freshly booted engine has: main.ts adds 'Vector' on top of the manager's 'Background'.)
    const fresh = new RasterLayerManager(makeMockDevice(), 800, 600);
    fresh.addVectorLayer('Vector');
    const shape = (m: RasterLayerManager) => m.getLayers().map((l) => [l.name, l.type, l.visible, l.opacity, l.parentId]);
    const layers = a.rlm.getLayers();
    expect(shape(a.rlm)).toEqual(shape(fresh));
    expect(layers.map((l) => [l.name, l.type])).toEqual([['Vector', 'vector'], ['Background', 'layer']]);
    for (const l of layers) expect(a.docALayerIds).not.toContain(l.id);

    // Animation: off, timeline at a new timeline's state.
    expect(a.rlm.isAnimationEnabled()).toBe(false);
    expect(a.rlm.getTimeline().getState()).toMatchObject({ frameCount: 1, currentFrame: 1, fps: 12, loopMode: 'loop', playbackState: 'stopped', playRangeStart: 1, playRangeEnd: 1 });
    expect(a.rlm.getOnionSkinConfig()).toEqual(DEFAULT_ONION_SKIN);

    // Scene graph: every root child removed AND unregistered from the id map (no stale lookups).
    expect(a.sceneGraph.root.children).toEqual([]);
    expect(a.sceneGraph.findNodeById('shape-A')).toBeNull();
    expect((a.sceneGraph as unknown as { nodeMap: Map<string, unknown> }).nodeMap.size).toBe(0);

    // Every previous-document registry is cleared first, before the scene graph is replaced.
    expect(a.calls.indexOf('clear-registries')).toBeGreaterThanOrEqual(0);
    expect(a.calls.indexOf('clear-registries')).toBeLessThan(a.calls.indexOf('scene'));
    expect(a.calls).toContain('clear-procedural');
    expect(a.calls).toContain('clear-doc-size');   // infinite canvas

    // Settings back to defaults; ephemera emptied; both undo stacks cleared; one scene-changed event at the end.
    expect(a.setDitherConfig).toHaveBeenCalledWith(defaultDitherConfig());
    expect(a.grid).toEqual({ ...DEFAULT_CANVAS_GRID });
    expect(a.ephemera.deserialize).toHaveBeenCalledWith(EMPTY_EPHEMERA_JSON);
    expect(a.vectorUndoClear).toHaveBeenCalled();
    expect(a.clearUndo3D).toHaveBeenCalled();
    expect(a.emit).toHaveBeenCalledTimes(1);
    // Orphaned vector shapes / placements get a layer back once both are restored (UI review 2026-10-07 #2).
    expect(a.recoverOrphanedVectorContent).toHaveBeenCalledTimes(1);
  });

  it('a bounded blank document sets its artboard size instead of clearing it', async () => {
    const a = documentAOpen();
    await a.coordinator.restore(createBlankDocumentPayload('d', 'n', { documentSize: { w: 1200, h: 900 } }));
    expect(a.calls).toContain('doc-size 1200x900');
    expect(a.calls).not.toContain('clear-doc-size');
  });

  it('a saved document WITHOUT animation no longer inherits the previous one\'s (any load, not just blank)', async () => {
    const a = documentAOpen();
    const saved = createBlankDocumentPayload('doc-b', 'B');
    saved.manifest.layers = [{ id: 'b1', name: 'B layer', visible: true, locked: false, opacity: 1, blendMode: 'normal', clipped: false, lockTransparency: false, celIds: [], animationType: 'static' }];
    await a.coordinator.restore(saved);
    expect(a.rlm.isAnimationEnabled()).toBe(false);
    expect(a.rlm.getTimeline().getFrameCount()).toBe(1);
    expect(a.rlm.getLayers().map((l) => l.id)).toEqual(['b1']);
  });
});

describe('AnimationTimeline.resetForDocumentLoad', () => {
  it('returns to a new timeline\'s state and stops playback', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const t = new AnimationTimeline(12, 1);
    t.setFrameCount(30); t.setFps(30); t.setLoopMode('none'); t.setPlayRange(3, 20); t.setOnionSkinConfig({ enabled: true });
    t.play();
    const events: string[] = [];
    t.on((e) => events.push(e.type));
    t.resetForDocumentLoad();
    expect(t.getState()).toEqual(new AnimationTimeline(12, 1).getState());
    expect(t.getOnionSkinConfig()).toEqual(DEFAULT_ONION_SKIN);
    expect(events).toContain('playback-state-changed');
  });
});

describe('Scene3DTextures.resetForDocumentLoad', () => {
  it('starts an empty texture library (restore MERGES, so the previous document\'s textures were saved into the next)', () => {
    const tex = new Scene3DTextures({} as never, { getMesh: () => null, getAllMeshes: () => [] });
    (tex as unknown as { _textureLibrary: unknown })._textureLibrary = { toJSONWithData: () => ({ entries: [{ id: 'old' }] }) };
    expect(tex.getTextureLibraryData()).toEqual({ entries: [{ id: 'old' }] });
    tex.resetForDocumentLoad();
    expect(tex.getTextureLibraryData()).toBeNull();
  });
});

describe('Scene3DManager.clearForDocumentLoad3D — the rest of the per-document 3D state', () => {
  it('drops camera cuts / preview, Grease Pencil + particle registries, host point lights and the 3D selection', () => {
    const calls: string[] = [];
    const rec = (name: string) => (...args: unknown[]) => { calls.push(args.length ? `${name}(${JSON.stringify(args)})` : name); };
    const stub = {
      exitPlayMode3D: rec('exitPlay'),
      _character: { clearForDocumentLoad: rec('character') },
      _kitbash: { clearForDocumentLoad: rec('kitbash') },
      _modelStore: new Map([['glb', new ArrayBuffer(1)]]),
      _textures: { resetForDocumentLoad: rec('textures') },
      _scriptManager: { restore: rec('scripts') },
      animLibrary: { clearForDocumentLoad: rec('animLibrary') },
      _assetRefs: { clearForDocumentLoad: rec('assetRefs') },
      playSettings: { restore: rec('play') },
      ctx: { webgpuRenderer: { getRenderer3D: () => ({ resetGpuScene: rec('gpuScene') }) } },
      _previewThroughCameras: true,
      _lookThroughCamId: null as string | null,
      _cameraCuts: [{ frame: 1, cameraId: 'camA' }],
      setPreviewThroughCameras3D: rec('preview'),
      lookThroughCamera3D: rec('lookThrough'),
      setCameraCuts3D: rec('cuts'),
      _gp: { dispose: rec('gp') },
      _particles: { dispose: rec('particles') },
      setPointLights3D: rec('pointLights'),
      setCandidatePointLights3D: rec('candidateLights'),
      clearSelection: rec('selection'),
    };
    (Scene3DManager.prototype.clearForDocumentLoad3D as () => void).call(stub);
    expect(stub._modelStore.size).toBe(0);
    for (const c of ['textures', 'preview([false])', 'cuts([[]])', 'gp', 'particles', 'pointLights([[]])', 'candidateLights([[]])', 'selection']) {
      expect(calls).toContain(c);
    }
    expect(calls).not.toContain('lookThrough');   // not looking through a camera → nothing to exit
  });
});

describe('ShapeManager.startBlankDocument', () => {
  function engine() {
    const order: string[] = [];
    const restored: DocumentSavePayload[] = [];
    const self = {
      currentDocId: 'doc-A', currentDocName: 'A',
      rasterLayerManager: { getCanvasSize: () => ({ w: 640, h: 480 }) },
      getSelectionEngine: () => ({
        cancelTransform: () => order.push(`cancelTransform while ${self.currentDocId}`),
        deselectAll: async () => { order.push(`deselect while ${self.currentDocId}`); },
      }),
      restoreDocumentState: async (p: DocumentSavePayload) => { order.push(`restore as ${self.currentDocId}`); restored.push(p); },
      interactionService: { clearSelectedNodes: () => order.push('clear2D') },
      scene3d: { clearSelection: () => order.push('clear3D') },
      scheduleRender: () => undefined,
    };
    return { self, order, restored };
  }

  it('drops the floating raster selection of the previous doc, then restores the blank payload under the NEW id', async () => {
    const { self, order, restored } = engine();
    await ShapeManager.prototype.startBlankDocument.call(self as never, 'local-new', 'Fresh', { documentSize: { w: 300, h: 200 } });
    expect(order).toEqual(['cancelTransform while doc-A', 'deselect while doc-A', 'restore as local-new', 'clear2D', 'clear3D']);
    expect(self.currentDocName).toBe('Fresh');
    expect(restored[0].manifest).toMatchObject({ docId: 'local-new', name: 'Fresh', layers: [], animation: null, documentSize: { w: 300, h: 200 } });
    expect(restored[0].sceneGraphJSON).toBe(EMPTY_SCENE_GRAPH_JSON);
  });

  it('without an id, saves have NO target — never the previous document\'s', async () => {
    const { self } = engine();
    await ShapeManager.prototype.startBlankDocument.call(self as never);
    expect(self.currentDocId).toBe('');
  });
});

describe('DocumentPersistence — pending saves never outlive the document they were for', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockRejectedValue(new Error('no opfs in test')) } });
  });

  it('cancelPendingSaves() drops a stroke-debounced save (disableAutoSave calls it when the host leaves the doc)', async () => {
    vi.useFakeTimers();
    const gather = vi.fn(async (): Promise<DocumentSavePayload> => { throw new Error('gathered'); });
    const p = new DocumentPersistence({ intervalMs: 0, strokeDebounceMs: 50 });
    p.setStateProvider(gather);
    p.notifyStrokeEnd();
    p.cancelPendingSaves();
    await vi.advanceTimersByTimeAsync(500);
    expect(gather).not.toHaveBeenCalled();
  });

  it('a save with no document id (a blank document not bound to one yet) writes nothing', async () => {
    const getDirectory = vi.fn().mockRejectedValue(new Error('should not be reached'));
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    const p = new DocumentPersistence({ intervalMs: 0, strokeDebounceMs: 0 });
    const done = vi.fn();
    p.setSaveCallbacks(() => undefined, done);
    p.setStateProvider(async () => createBlankDocumentPayload('', 'Untitled'));
    expect(await p.saveNow()).toBe(false);
    expect(getDirectory).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(false);
  });

  it('ShapeManager.disableAutoSave stops the timer AND cancels the pending saves', () => {
    const persistence = { stopAutoSave: vi.fn(), cancelPendingSaves: vi.fn() };
    ShapeManager.prototype.disableAutoSave.call({ persistence } as never);
    expect(persistence.stopAutoSave).toHaveBeenCalled();
    expect(persistence.cancelPendingSaves).toHaveBeenCalled();
  });
});
