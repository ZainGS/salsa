/**
 * src/packaging/packaging-fresh-create.test.ts — PART-0 REGRESSION harness: the FRESH-create
 * Package-Creator path, replayed through the REAL RasterLayerManager (mock GPU device), the real
 * LiveTextureMode + PackagingManager + scene nodes, a UVPaintController-faithful paint-session
 * mirror, AND a Renderer3D-faithful texture-bind-group mirror.
 *
 * USER EVIDENCE this gates: a freshly created package (addPackage / create-path enterCreatorMode)
 * did NOT live-update while painting, while the SAME package after save + reload + re-adoption did.
 * The fresh path differs from the adopt path in exactly one way the fakes never modelled: the
 * dieline layer is created DURING the enter (ensureDielineLayerInfo → RasterLayerManager.addLayer)
 * — so this harness runs that ordering against the REAL layer manager, including the
 * texture-created-LATER (lazy) variant and the doc-resize reallocation variant, and asserts at the
 * RENDERER level (what a draw would actually bind), not just at the mesh fields.
 *
 * Mirrors kept line-faithful to the real code:
 *  - ensureDielineLayerInfo / _addPackagingDielineLayer / _tagPackagingLayer  (shape-manager)
 *  - _armPackagingSurfacePaint texMgr capture + beforeStroke/onStrokeEnd contracts
 *  - UVPaintController.enter/strokeBeginUV/syncActiveTexture   (uv-paint-controller)
 *  - Renderer3D.createTextureBindGroup cache (self-validates by texture ref) + the
 *    untextured-pipeline gate (material.hasTexture) + evictTextureBindGroup via onRepoint
 */

import { describe, it, expect } from 'vitest';

// Node test env: browser globals used by Shape ids + GPU enums used by RasterTextureManager.
import { webcrypto } from 'node:crypto';
const g = globalThis as Record<string, unknown>;
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;
g.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

import { SceneGraph } from '../scene-graph/core/scene-graph';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { Mesh3D } from '../scene-graph/shapes/mesh-3d';
import { LiveTextureMode } from '../services/managers/live-texture-mode';
import { RasterLayerManager } from '../services/raster-layer-manager';
import type { RasterTextureManager } from '../renderer/raster/raster-texture-manager';
import type { InteractionService } from '../services/interaction-service';
import { PackagingManager, type PackagingHost } from './packaging-manager';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

// Minimal DOM stub for UVPaintController's pane-canvas creation (node env has no document).
g.document ??= {
  createElement: () => ({
    width: 0, height: 0, style: {},
    getContext: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
};

/** Permissive callable proxy — stands in for GPU pipeline/module/sampler objects whose methods the
 *  paint-engine constructors touch but whose behaviour is irrelevant to texture-identity tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const permissive: any = new Proxy(function () { /* callable */ }, {
  get: (_t, p) => (p === 'then' ? undefined : permissive),
  apply: () => permissive,
});

// ── Mock GPUDevice: identity-bearing texture tokens; everything else inert ─────────────────────
let texSeq = 0;
function makeMockDevice(): GPUDevice {
  const device = {
    createTexture: (desc: { size: number[] | { width?: number } }) => {
      const size = desc.size as number[];
      const tex = {
        label: `mock-tex-${texSeq++}`,
        width: Array.isArray(size) ? size[0] : 0,
        height: Array.isArray(size) ? size[1] : 0,
        destroyed: false,
        destroy() { (tex as { destroyed: boolean }).destroyed = true; },
        createView: () => ({}),
      };
      return tex;
    },
    createBuffer: (desc: { size: number }) => ({
      size: desc.size,
      mapAsync: async () => undefined,
      getMappedRange: () => new ArrayBuffer(desc.size),
      unmap() { /* noop */ },
      destroy() { /* noop */ },
    }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ end() { /* noop */ }, setPipeline() { /* noop */ }, setBindGroup() { /* noop */ }, draw() { /* noop */ } }),
      beginComputePass: () => ({ end() { /* noop */ }, setPipeline() { /* noop */ }, setBindGroup() { /* noop */ }, dispatchWorkgroups() { /* noop */ } }),
      copyTextureToTexture() { /* noop */ },
      copyTextureToBuffer() { /* noop */ },
      copyBufferToTexture() { /* noop */ },
      copyBufferToBuffer() { /* noop */ },
      finish: () => ({}),
    }),
    createBindGroupLayout: () => permissive,
    createPipelineLayout: () => permissive,
    createShaderModule: () => permissive,
    createComputePipeline: () => permissive,
    createRenderPipeline: () => permissive,
    createSampler: () => permissive,
    createBindGroup: () => permissive,
    createRenderBundleEncoder: () => permissive,
    queue: {
      submit() { /* noop */ },
      writeTexture() { /* noop */ },
      writeBuffer() { /* noop */ },
      copyExternalImageToTexture() { /* noop */ },
      onSubmittedWorkDone: async () => undefined,
    },
  };
  return device as unknown as GPUDevice;
}

/** Renderer3D.createTextureBindGroup mirror: per-mesh cache keyed by mesh.id storing the diffuse
 *  ref, SELF-VALIDATING by texture ref on every draw; untextured meshes use the untextured
 *  pipeline (no texture sampled at all). `sampledTexture` = what a draw of this mesh binds. */
class RendererMirror {
  private cache = new Map<string, { diffuse: object }>();
  readonly defaultWhite = { label: 'default-white-1x1' };
  evictTextureBindGroup(meshId: string): void { this.cache.delete(meshId); }
  sampledTexture(mesh: Mesh3D): object | null {
    if (!mesh.material.hasTexture && !mesh.material.hasNormalMap) return null;   // untextured pipeline
    const diffuseTex = (mesh.diffuseTexture as unknown as object) ?? this.defaultWhite;
    const cached = this.cache.get(mesh.id);
    if (cached && cached.diffuse === diffuseTex) return cached.diffuse;
    this.cache.set(mesh.id, { diffuse: diffuseTex });                            // rebuild bind group
    return diffuseTex;
  }
}

/** UVPaintController mirror — the exact capture semantics of enter()/strokeBeginUV()/
 *  syncActiveTexture()/strokeEndUV() for a packaging session (no pane, no DOM). Dabs "paint" by
 *  recording the engine's CURRENT write target into `painted`. */
class PaintSessionMirror {
  engineTex: GPUTexture | null = null;
  texMgr: RasterTextureManager | null = null;
  beforeStroke: (() => void) | null = null;
  onStrokeEnd: (() => void) | null = null;
  readonly painted = new Set<object>();
  enter(texMgr: RasterTextureManager): void {           // UVPaintController.enter
    this.texMgr = texMgr;
    this.engineTex = texMgr.getTexture();
  }
  private syncActiveTexture(): void {                   // UVPaintController.syncActiveTexture
    const fresh = this.texMgr?.getTexture() ?? null;
    if (fresh && fresh !== this.engineTex) this.engineTex = fresh;
  }
  strokeBegin(): void {                                 // UVPaintController.strokeBeginUV
    this.syncActiveTexture();
    this.beforeStroke?.();
    if (this.engineTex) this.painted.add(this.engineTex as unknown as object);   // the dab
  }
  strokeEnd(): void {                                   // UVPaintController.strokeEndUV
    this.onStrokeEnd?.();
  }
  exit(): void { this.texMgr = null; this.engineTex = null; this.onStrokeEnd = null; }
}

/** Full fresh-path chain: REAL RasterLayerManager + REAL LiveTextureMode + REAL PackagingManager,
 *  host adapter mirroring ShapeManager's packaging host line-for-line. */
function makeRealChain(opts: { docW?: number; docH?: number } = {}) {
  const device = makeMockDevice();
  const sceneGraph = new SceneGraph();
  const rlm = new RasterLayerManager(device, opts.docW ?? 1024, opts.docH ?? 768);
  const live = new LiveTextureMode(sceneGraph, () => rlm);
  const renderer = new RendererMirror();
  live.onRepoint = (meshId) => renderer.evictTextureBindGroup(meshId);   // ShapeManager ctor wiring
  const controller = new PaintSessionMirror();

  const tagPackagingLayer = (layerId: string): void => {                 // _tagPackagingLayer
    const l = rlm.getLayerById(layerId);
    if (!l) return;
    if (l.systemOwner !== 'packaging') rlm.setSystemOwner(layerId, 'packaging');
    // Package-OWNED layers use `visible` as STACK visibility — never force-hide those (the
    // re-enter-hides-the-base-layer regression); only legacy/untagged layers get composite-hidden.
    if (l.visible && !l.packageOwnerId) rlm.setVisibility(layerId, false);
  };

  const host: PackagingHost = {
    createGroup: (name, parentNodeId, scale) => {
      const grp = new MeshGroup3D(isvc);
      grp.name = name;
      if (scale !== undefined) { grp.scaleX = scale; grp.scaleY = scale; grp.scaleZ = scale; }
      const parent = parentNodeId ? sceneGraph.findNodeById(parentNodeId) : null;
      (parent ?? sceneGraph.root).addChild(grp);
      return grp.id;
    },
    createPanelMesh: (geom, parentNodeId, name) => {
      const m = new Mesh3D(isvc, 0, 0, 0, {
        primitive: 'custom', geometry: geom,
        material: { diffuse: { r: 0.96, g: 0.95, b: 0.93, a: 1 }, roughness: 0.92, metalness: 0, doubleSided: true, texOverBase: true },
      });
      m.name = name; m.gpuDirty = true;
      (sceneGraph.findNodeById(parentNodeId) ?? sceneGraph.root).addChild(m);
      return m.id;
    },
    setNodeTransform: (id, t) => {
      const n = sceneGraph.findNodeById(id) as Mesh3D | MeshGroup3D | null;
      if (!n) return;
      if (t.pos) n.setXYZ(t.pos[0], t.pos[1], t.pos[2]);
      if (t.rotX !== undefined) n.rotationX = t.rotX;
      if (t.rotY !== undefined) n.rotationY = t.rotY;
      if (t.rotZ !== undefined) n.rotation = t.rotZ;
    },
    setPanelGeometry: (meshId, geom) => {
      const n = sceneGraph.findNodeById(meshId);
      if (n instanceof Mesh3D) n.setGeometry(geom);
    },
    removeNode: (id) => { const n = sceneGraph.findNodeById(id); n?.parent?.removeChild(n); },
    linkLiveTexture: (id, layerId) => live.link(id, layerId),
    unlinkLiveTexture: (id) => live.unlink(id),
    exportLayerPng: async () => null,
    scheduleRender: () => { /* on-demand render — content changes need no re-encode to be visible */ },
    setDocSize: () => { /* creator mode never resizes the doc */ },
    // Legacy hook (unused when ensureDielineLayerInfo exists) — mirror anyway.
    ensureDielineLayer: (existing) => {
      if (existing && rlm.getLayerById(existing)?.texture) { tagPackagingLayer(existing); return existing; }
      return rlm.addLayer('Dieline', { visible: false, systemOwner: 'packaging' })?.id ?? null;
    },
    // EXACT ShapeManager.ensureDielineLayerInfo (the fresh-create ordering under test), incl. the
    // per-package by-NAME reuse scope (never adopt a 'Dieline' owned by a DIFFERENT package).
    ensureDielineLayerInfo: (existing, packageId) => {
      if (existing && rlm.getLayerById(existing)?.texture) {
        tagPackagingLayer(existing);
        return { layerId: existing, fresh: false };
      }
      const named = rlm.getLayers().find(l => {
        if (l.name !== 'Dieline' || !rlm.getLayerById(l.id)?.texture) return false;
        const owner = rlm.getLayerById(l.id)?.packageOwnerId;
        return !owner || owner === packageId;
      });
      if (named) {
        tagPackagingLayer(named.id);
        return { layerId: named.id, fresh: false };
      }
      const id = rlm.addLayer('Dieline', { visible: false, systemOwner: 'packaging', ...(packageId ? { packageOwnerId: packageId } : {}) })?.id ?? null;
      return id ? { layerId: id, fresh: true } : null;
    },
    nodeExists: (id) => !!sceneGraph.findNodeById(id),
    frameAndOrbit: () => { /* camera not modelled */ },
    stopOrbit: () => { /* camera not modelled */ },
    // EXACT _armPackagingSurfacePaint: capture the LAYER's own manager, point the engine at its
    // CURRENT texture, wire the beforeStroke/onStrokeEnd sync contracts.
    armSurfacePaint: (meshIds, layerId) => {
      const texMgr = rlm.getLayerById(layerId)?.manager ?? null;
      if (!meshIds[0] || !texMgr) return false;
      controller.enter(texMgr);
      controller.beforeStroke = () => live.syncAll();     // syncLiveTextures3D
      controller.onStrokeEnd = () => live.syncAll();      // syncLiveTextures3D
      return true;
    },
    disarmSurfacePaint: () => controller.exit(),
    applyPanelMaterial: (meshId) => {
      const n = sceneGraph.findNodeById(meshId);
      if (!(n instanceof Mesh3D)) return;
      Object.assign(n.material, {
        diffuse: { r: 0.96, g: 0.95, b: 0.93, a: 1 }, roughness: 0.92, metalness: 0,
        doubleSided: true, texOverBase: true,
      });
      n.gpuDirty = true;
    },
    markUnitWrapper: (rootNodeId, localBounds) => {
      const n = sceneGraph.findNodeById(rootNodeId);
      if (n instanceof MeshGroup3D) { if (localBounds) n.cachedBounds = localBounds; n.thinWrapper = true; }
    },
  };
  const mgr = new PackagingManager(host);
  const meshOf = (id: string): Mesh3D => {
    const n = sceneGraph.findNodeById(id);
    if (!(n instanceof Mesh3D)) throw new Error('panel mesh not found: ' + id);
    return n;
  };
  return { device, sceneGraph, rlm, live, renderer, controller, mgr, meshOf };
}

describe('FRESH-create Package-Creator paint chain (REAL RasterLayerManager + renderer bind-group mirror)', () => {
  it('fresh enterCreatorMode (layer created DURING enter): a stroke paints the texture EVERY panel draw samples', () => {
    const { rlm, renderer, controller, mgr, meshOf } = makeRealChain();
    const st = mgr.enterCreatorMode({ params: { width: 80, height: 60, depth: 40 } });
    expect(st.active).toBe(true);
    expect(st.dielineLayerId).not.toBeNull();
    const layer = rlm.getLayerById(st.dielineLayerId!)!;
    expect(layer.manager.getTexture()).not.toBeNull();       // addLayer creates the texture eagerly
    expect(layer.systemOwner).toBe('packaging');
    expect(layer.visible).toBe(false);

    const pkg = mgr.get(st.packageId!)!;
    // Simulate frames BEFORE any painting (the box is on screen first) — bind groups get cached.
    for (const p of pkg.box.panels) renderer.sampledTexture(meshOf(p.meshId));

    controller.strokeBegin();
    // MID-STROKE (the "live-update while painting" contract): every panel's draw must bind the
    // very texture object the engine is writing dabs into.
    for (const p of pkg.box.panels) {
      const bound = renderer.sampledTexture(meshOf(p.meshId));
      expect(bound).toBe(controller.engineTex as unknown as object);
      expect(controller.painted.has(bound!)).toBe(true);
    }
    controller.strokeEnd();
    expect(controller.engineTex).toBe(layer.manager.getTexture());
  });

  it('addPackage → enterCreatorMode({packageId}) (the first-class-object path): same end-to-end identity', () => {
    const { rlm, renderer, controller, mgr, meshOf } = makeRealChain();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    for (const p of pkg.box.panels) renderer.sampledTexture(meshOf(p.meshId));   // drawn untextured first
    const st = mgr.enterCreatorMode({ packageId: pkg.id });
    controller.strokeBegin();
    for (const p of pkg.box.panels) {
      expect(renderer.sampledTexture(meshOf(p.meshId))).toBe(controller.engineTex as unknown as object);
    }
    controller.strokeEnd();
    expect(rlm.getLayerById(st.dielineLayerId!)!.manager.getTexture()).toBe(controller.engineTex);
  });

  it('REGRESSION (lazy texture): dieline layer linked while its manager texture does NOT exist yet — the first stroke after it materializes must land where the panels sample', () => {
    const { rlm, renderer, controller, mgr, meshOf, live } = makeRealChain();
    // Replicate the lazy-create ordering: the layer exists but its manager has NO GPUTexture at
    // link/arm time (texture created later, on first paint/composite).
    const bare = rlm.addLayer('Dieline', { visible: false, systemOwner: 'packaging' })!;
    const mgrTex = rlm.getLayerById(bare.id)!.manager as unknown as { texture?: GPUTexture };
    mgrTex.texture = undefined;                              // manager texture not created yet
    rlm.getLayerById(bare.id)!.texture = undefined;          // snapshot field empty too

    const pkg = mgr.addPackage();
    mgr.enterCreatorMode({ packageId: pkg.id });             // reuses the named 'Dieline'... only if texture — fresh branch guards on texture!
    const st = mgr.getCreatorState();
    expect(st.dielineLayerId).not.toBeNull();

    // Whichever layer got linked: force the LAZY case on it — null the manager texture AFTER arm,
    // then materialize a texture later (ensureTexture) with the SAME ordering the real lazy path has.
    const linked = rlm.getLayerById(st.dielineLayerId!)!;
    (linked.manager as unknown as { texture?: GPUTexture }).texture = undefined;
    linked.texture = undefined;
    live.syncAll();                                          // panels resolve null → untextured
    for (const p of pkg.box.panels) {
      expect(renderer.sampledTexture(meshOf(p.meshId))).toBeNull();   // untextured pipeline (kraft)
    }

    const created = linked.manager.ensureTexture(1024, 768);  // texture materializes LATER
    expect(created).toBeTruthy();
    controller.strokeBegin();                                 // first stroke after materialization
    for (const p of pkg.box.panels) {
      const bound = renderer.sampledTexture(meshOf(p.meshId));
      expect(bound).toBe(created as unknown as object);
      expect(bound).toBe(controller.engineTex as unknown as object);
    }
  });

  it('doc-resize (RasterLayerManager.setSize reallocates EVERY layer texture): next stroke self-heals engine + panels + bind groups', () => {
    const { rlm, renderer, controller, mgr, meshOf } = makeRealChain();
    const st = mgr.enterCreatorMode();
    const pkg = mgr.get(st.packageId!)!;
    controller.strokeBegin(); controller.strokeEnd();
    const before = controller.engineTex!;
    for (const p of pkg.box.panels) renderer.sampledTexture(meshOf(p.meshId));   // bind groups cached on `before`

    rlm.setSize(2048, 1024);                                  // reallocates the dieline texture
    const after = rlm.getLayerById(st.dielineLayerId!)!.manager.getTexture()!;
    expect(after).not.toBe(before);

    controller.strokeBegin();                                 // stroke-begin self-heal
    for (const p of pkg.box.panels) {
      expect(renderer.sampledTexture(meshOf(p.meshId))).toBe(after as unknown as object);
    }
    expect(controller.engineTex).toBe(after);
    controller.strokeEnd();
  });

  it('exit → re-enter reuses the SAME named Dieline layer of the REAL manager (no duplicates) and stays identity-consistent', () => {
    const { rlm, controller, mgr } = makeRealChain();
    const first = mgr.enterCreatorMode();
    mgr.exitCreatorMode();
    const second = mgr.enterCreatorMode();
    expect(second.dielineLayerId).toBe(first.dielineLayerId);
    expect(rlm.getLayers().filter(l => l.name === 'Dieline').length).toBe(1);
    controller.strokeBegin();
    expect(controller.engineTex).toBe(rlm.getLayerById(second.dielineLayerId!)!.manager.getTexture());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PART-0 ROOT-CAUSE REGRESSION — through the REAL UVPaintController.
//
// The fresh-create path ARMS the paint session with the dieline layer's RasterTextureManager
// captured ONCE (`_armPackagingSurfacePaint`'s `texMgr`). The document-restore pipeline
// (autosave load / doc-open racing a fresh `enterCreatorMode` — the create-from-shell flow)
// REBUILDS the raster layer list: `clearAllLayers()` + `addLayerWithId(sameId)` → the same layer
// id now owns a brand-NEW RasterTextureManager. From then on:
//   • the armed engine re-resolves its write target from the CAPTURED (orphaned) manager — its
//     texture "agrees with itself" forever, so `syncActiveTexture` never heals it;
//   • LiveTextureMode resolves BY LAYER ID through the LIVE RasterLayerManager → the panels sample
//     the NEW manager's texture.
// Engine writes texture A, box samples texture B → the box NEVER shows the paint (the fresh-path
// "does not live-update" bug). The RE-ADOPTION path arms AFTER the restore finished, so its
// captured manager IS the live one — which is exactly why a reloaded package painted fine.
//
// Root fix: the paint target carries a `resolveTexMgr` provider — the session re-resolves the
// MANAGER (not just its texture) by layer id at every stroke begin.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { UVPaintController } from '../services/managers/uv-paint-controller';
import { UVEditorSession } from '../services/managers/uv-canvas-renderer';

function makeControllerChain() {
  const chain = makeRealChain();
  const { rlm, live } = chain;
  const controller = new UVPaintController(chain.device, () => { /* on-demand render */ });
  /** EXACT `_armPackagingSurfacePaint` semantics, through the REAL controller. */
  const arm = (primaryMeshId: string, layerId: string): boolean => {
    const mesh = chain.sceneGraph.findNodeById(primaryMeshId);
    const texMgr = rlm.getLayerById(layerId)?.manager ?? null;
    if (!(mesh instanceof Mesh3D) || !texMgr) return false;
    controller.enter({
      mesh, texMgr,
      session: new UVEditorSession(primaryMeshId),
      uvRenderer: null, canvas: null,
      // ★THE FIX under test: re-resolve the layer's manager from the LIVE RasterLayerManager at
      // every stroke begin (mirrors the shape-manager arm hook).
      resolveTexMgr: () => rlm.getLayerById(layerId)?.manager ?? null,
    });
    controller.beforeStroke = () => live.syncAll();     // syncLiveTextures3D
    controller.onStrokeEnd = () => live.syncAll();      // syncLiveTextures3D
    return true;
  };
  return { ...chain, controller, arm };
}

describe('PART-0 REGRESSION: restore pipeline rebuilds the dieline layer (same id, NEW manager) after the fresh arm', () => {
  it('the next stroke begin re-resolves the WRITE MANAGER by layer id — engine and panels converge on the live texture', () => {
    const chain = makeControllerChain();
    const { rlm, renderer, mgr, meshOf, controller, arm } = chain;

    // FRESH create path: enter creator mode → dieline layer created during the enter.
    const st = mgr.enterCreatorMode({ params: { width: 80, height: 60, depth: 40 } });
    const pkg = mgr.get(st.packageId!)!;
    const layerId = st.dielineLayerId!;
    expect(arm(pkg.box.panels[0].meshId, layerId)).toBe(true);
    const capturedMgr = rlm.getLayerById(layerId)!.manager;

    // THE RACE: the document-restore pipeline rebuilds the layer list — same layer ID, new manager.
    rlm.clearAllLayers();
    rlm.addLayerWithId(layerId, 'Dieline', { visible: false, systemOwner: 'packaging' });
    const liveMgr = rlm.getLayerById(layerId)!.manager;
    expect(liveMgr).not.toBe(capturedMgr);                       // the captured manager is ORPHANED

    // Paint (3D-surface stroke begin — same entry the pane uses).
    controller.strokeBeginUV(0.5, 0.5, 1);

    const engineTex = controller.getEngine().getActiveTexture();
    expect(engineTex).toBe(liveMgr.getTexture());                // engine writes the LIVE layer texture
    for (const p of pkg.box.panels) {
      const m = meshOf(p.meshId);
      // Pre-fix: engine wrote the orphaned manager's texture while every panel sampled the live
      // one — identical symptoms to the field bug (paint lands, box never shows it).
      expect(m.diffuseTexture as unknown as object).toBe(engineTex as unknown as object);
      expect(renderer.sampledTexture(m)).toBe(engineTex as unknown as object);
    }
    controller.strokeEndUV();
  });

  it('no-race baseline: the REAL controller stays converged on the fresh path (same-session create + paint)', () => {
    const chain = makeControllerChain();
    const { rlm, renderer, mgr, meshOf, controller, arm } = chain;
    const st = mgr.enterCreatorMode();
    const pkg = mgr.get(st.packageId!)!;
    expect(arm(pkg.box.panels[0].meshId, st.dielineLayerId!)).toBe(true);
    controller.strokeBeginUV(0.25, 0.25, 1);
    const engineTex = controller.getEngine().getActiveTexture();
    expect(engineTex).toBe(rlm.getLayerById(st.dielineLayerId!)!.manager.getTexture());
    for (const p of pkg.box.panels) {
      expect(renderer.sampledTexture(meshOf(p.meshId))).toBe(engineTex as unknown as object);
    }
    controller.strokeEndUV();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BUG 2 — package VECTOR layers must stay hidden from the NORMAL layers panel across reload. The
// host filters `systemOwner === 'packaging'`; getVectorLayers() previously dropped the tag, so a
// restored package vector layer leaked into the normal panel. Real RasterLayerManager round-trip.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('BUG 2: package vector layers stay hidden from the normal panel across reload', () => {
  it('getVectorLayers exposes systemOwner + packageOwnerId, and they survive the manifest round-trip', () => {
    const device = makeMockDevice();
    const rlm = new RasterLayerManager(device, 512, 512);

    const pkgVecId = rlm.addVectorLayer('Stickers', { visible: true, systemOwner: 'packaging', packageOwnerId: 'pkg-1' });
    const userVecId = rlm.addVectorLayer('Doodles');

    const rows = () => rlm.getVectorLayers();
    const pkgRow = () => rows().find(l => l.id === pkgVecId)!;
    const normalPanel = () => rows().filter(l => l.systemOwner !== 'packaging');

    // BEFORE reload — the host can distinguish + filter the package vector layer out.
    expect(pkgRow().systemOwner).toBe('packaging');
    expect(pkgRow().packageOwnerId).toBe('pkg-1');
    expect(rows().find(l => l.id === userVecId)!.systemOwner).toBeUndefined();
    expect(normalPanel().map(l => l.id)).toEqual([userVecId]);          // package vec hidden

    // MANIFEST ROUND-TRIP: metadata → clear → re-create with addVectorLayerWithId (the restore path).
    const meta = rlm.getLayerMetadata().filter(m => m.type === 'vector');
    rlm.clearAllLayers();
    for (const m of meta) {
      rlm.addVectorLayerWithId(m.id, m.name, { visible: m.visible, systemOwner: m.systemOwner, packageOwnerId: m.packageOwnerId });
    }

    // AFTER reload — the tags are re-applied → the package vector layer is STILL hidden.
    expect(pkgRow().systemOwner).toBe('packaging');
    expect(pkgRow().packageOwnerId).toBe('pkg-1');
    expect(normalPanel().map(l => l.id)).toEqual([userVecId]);
  });
});
