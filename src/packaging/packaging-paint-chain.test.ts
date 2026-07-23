/**
 * src/packaging/packaging-paint-chain.test.ts — headless INTEGRATION test of the Package-Creator
 * paint chain through the REAL classes (the "pane paints one texture, box samples another" gate).
 *
 * Real pieces under test (everything headless can reach):
 *   PackagingManager (creator mode + adoption) → real SceneGraph + MeshGroup3D/Mesh3D nodes →
 *   real LiveTextureMode → a raster-layer registry faked ONLY at the GPU boundary (layer.texture /
 *   layer.manager tokens stand in for GPUTexture/RasterTextureManager; ids + object identity are
 *   the real contract). The host adapter MIRRORS ShapeManager's packaging host line-for-line for
 *   the hooks in the chain (createPanelMesh material, linkLiveTexture→LiveTextureMode.link,
 *   ensureDielineLayerInfo, applyPanelMaterial, armSurfacePaint's texMgr capture, the
 *   onStrokeEnd→syncLiveTextures3D contract, beginCreatorStage's pick suppression).
 *
 * Chain contracts asserted (the bug-1 end-to-end trace):
 *   1. addPackage → enterCreatorMode({packageId}) links EVERY panel to the SAME dieline layer id
 *      that the paint session was armed with (no duplicate 'Dieline' layers, no id skew).
 *   2. Every panel's diffuse texture IS the very texture object the armed paint engine writes
 *      (layer.manager.getTexture() === layer.texture === mesh.diffuseTexture), hasTexture=true,
 *      texOverBase=true, and gpuDirty=true so the renderer repacks the per-slot flags.
 *   3. A pane-stroke end (onStrokeEnd → syncAll) after the layer's GPUTexture was RECREATED
 *      (doc-resize path) re-points every panel at the new texture and re-dirties them.
 *   4. Creator mode suppresses click-select for the package subtree (panel/pivot/root ids) and
 *      restores it on exit — the paint-vs-thin-wrapper-selection fight (bug 2).
 */

import { describe, it, expect } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { SceneGraph } from '../scene-graph/core/scene-graph';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { Mesh3D } from '../scene-graph/shapes/mesh-3d';
import { LiveTextureMode } from '../services/managers/live-texture-mode';
import type { RasterLayerManager } from '../services/raster-layer-manager';
import type { InteractionService } from '../services/interaction-service';
import { PackagingManager, type PackagingHost } from './packaging-manager';

// Shape's ctor only touches maxGlobalZIndex; hit-testing paths aren't exercised here.
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** GPUTexture stand-in — only OBJECT IDENTITY matters to the chain (LiveTextureMode compares refs;
 *  the paint engine writes texel contents in place, which needs no re-link). */
type TexToken = { readonly label: string };

/** RasterTextureManager stand-in: the layer's paint-target manager (what _armPackagingSurfacePaint
 *  captures and the pane's RasterPaintEngine writes into). */
class FakeTexManager {
  constructor(public tex: TexToken | null) {}
  getTexture(): TexToken | null { return this.tex; }
}

/** The raster-layer registry at the real API surface used by the chain (ids + texture + manager).
 *  Mirrors the REAL dual reference: `texture` is a reassignable SNAPSHOT field (the timeline cel
 *  swap writes into it) while `manager.getTexture()` is the live paint target. */
class FakeRasterLayers {
  layers: { id: string; name: string; visible: boolean; systemOwner?: string; texture: TexToken | null; manager: FakeTexManager }[] = [];
  private n = 0;
  addLayer(name: string, opts: { visible?: boolean; systemOwner?: string; blankPaintTarget?: boolean } = {}) {
    const tex: TexToken | null = opts.blankPaintTarget ? null : { label: `tex-${this.n}` };
    const layer = { id: `layer-${this.n++}`, name, visible: opts.visible ?? true, systemOwner: opts.systemOwner, texture: tex, manager: new FakeTexManager(tex) };
    this.layers.push(layer);
    return layer;
  }
  getLayerById(id: string) { return this.layers.find(l => l.id === id); }
  getLayerTexture(id: string): TexToken | null { return this.getLayerById(id)?.texture ?? null; }
  getLayers() { return this.layers; }
  /** The doc-resize path: RasterTextureManager.ensureTexture recreates the GPUTexture (both refs). */
  recreateTexture(id: string): TexToken {
    const l = this.getLayerById(id)!;
    const tex: TexToken = { label: (l.texture?.label ?? 'tex') + "'" };
    l.texture = tex;
    l.manager.tex = tex;
    return tex;
  }
  /** The BUG-1 producer: the timeline cel swap reassigns ONLY the snapshot field
   *  (raster-layer-manager onFrameChanged/forceFrameSync: `layer.texture = celTexture|undefined`)
   *  while the paint engine keeps writing `manager.getTexture()`. */
  divergeSnapshot(id: string, tex: TexToken | null): void {
    this.getLayerById(id)!.texture = tex;
  }
}

/** Real-node + real-LiveTextureMode host mirroring the ShapeManager packaging adapter. */
function makeChainHost() {
  const sceneGraph = new SceneGraph();
  const rlm = new FakeRasterLayers();
  const live = new LiveTextureMode(sceneGraph, () => rlm as unknown as RasterLayerManager);
  // Real InteractionService pick-suppression contract (bug 2) — the two fields the stage touches.
  const interaction = { suppressBoxSelect: false, pickSuppressed3D: null as ((id: string) => boolean) | null };
  const armed: { meshIds: string[]; layerId: string; texMgr: FakeTexManager | null }[] = [];
  let onStrokeEnd: (() => void) | null = null;
  let onStrokeBegin: (() => void) | null = null;

  let mgrRef: PackagingManager | null = null;
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
    removeNode: (id) => { const n = sceneGraph.findNodeById(id); n?.parent?.removeChild(n); },
    // EXACT adapter semantics: scene3d.setGeometry → mesh.setGeometry — enables the setDimensions
    // in-place fast path (panel/pivot ids and live-texture links survive a re-dimension).
    setPanelGeometry: (meshId, geom) => {
      const n = sceneGraph.findNodeById(meshId);
      if (n instanceof Mesh3D) n.setGeometry(geom);
    },
    // ── the live-texture chain, through the REAL LiveTextureMode ──
    linkLiveTexture: (id, layerId) => live.link(id, layerId),
    unlinkLiveTexture: (id) => live.unlink(id),
    exportLayerPng: async () => null,
    scheduleRender: () => {},
    setDocSize: () => {},
    ensureDielineLayer: (existing) => existing ?? rlm.addLayer('Dieline', { visible: false, systemOwner: 'packaging' }).id,
    ensureDielineLayerInfo: (existing) => {
      if (existing && rlm.getLayerById(existing)) return { layerId: existing, fresh: false };
      const named = rlm.getLayers().find(l => l.name === 'Dieline' && l.texture);
      if (named) return { layerId: named.id, fresh: false };
      return { layerId: rlm.addLayer('Dieline', { visible: false, systemOwner: 'packaging' }).id, fresh: true };
    },
    nodeExists: (id) => !!sceneGraph.findNodeById(id),
    frameAndOrbit: () => {},
    stopOrbit: () => {},
    // Mirrors _armPackagingSurfacePaint: the paint engine's texture = the LAYER's own manager.
    armSurfacePaint: (meshIds, layerId) => {
      const texMgr = rlm.getLayerById(layerId)?.manager ?? null;
      armed.push({ meshIds: [...meshIds], layerId, texMgr });
      // ONE stroke-end contract for pane + 3D strokes → syncLiveTextures3D.
      onStrokeEnd = () => live.syncAll();
      // Mirrors the beforeStroke contract: the links re-sync BEFORE the first dab too (the
      // controller re-points its engine at the manager's current texture at stroke begin; this
      // makes the panels sample that same object for the WHOLE stroke, not just after it ends).
      onStrokeBegin = () => live.syncAll();
      return texMgr !== null;
    },
    disarmSurfacePaint: () => { onStrokeEnd = null; onStrokeBegin = null; },
    // Mirrors the adapter's stage hygiene incl. the bug-2 pick suppression predicate.
    beginCreatorStage: () => {
      interaction.suppressBoxSelect = true;
      interaction.pickSuppressed3D = (id) => !!mgrRef?.isPackageNode(id);
    },
    endCreatorStage: () => {
      interaction.suppressBoxSelect = false;
      interaction.pickSuppressed3D = null;
    },
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
  mgrRef = mgr;
  const meshOf = (id: string): Mesh3D => {
    const n = sceneGraph.findNodeById(id);
    if (!(n instanceof Mesh3D)) throw new Error('panel mesh not found: ' + id);
    return n;
  };
  return {
    mgr, rlm, live, interaction, armed, sceneGraph, meshOf,
    strokeEnd: () => onStrokeEnd?.(),
    strokeBegin: () => onStrokeBegin?.(),
  };
}

describe('Package-Creator paint chain (REAL PackagingManager + scene nodes + LiveTextureMode)', () => {
  it('addPackage → enterCreatorMode({packageId}): ONE dieline layer end-to-end — every panel linked to the ARMED layer id', () => {
    const { mgr, rlm, live, armed } = makeChainHost();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    const st = mgr.enterCreatorMode({ packageId: pkg.id });

    expect(st.active).toBe(true);
    expect(st.dielineLayerId).not.toBeNull();
    // Exactly one Dieline layer exists (pane layer A ≠ box layer B would show up here).
    expect(rlm.getLayers().filter(l => l.name === 'Dieline').length).toBe(1);

    // The paint session was armed on ALL panels with the SAME layer the panels are linked to.
    expect(armed.length).toBe(1);
    expect(armed[0].layerId).toBe(st.dielineLayerId);
    expect(armed[0].meshIds.length).toBe(6);
    for (const p of pkg.box.panels) {
      expect(armed[0].meshIds).toContain(p.meshId);
      expect(live.isLinked(p.meshId)).toBe(true);
      expect(live.getLinkedLayerId(p.meshId)).toBe(st.dielineLayerId);
    }
  });

  it('every panel SAMPLES the very texture object the armed paint engine writes (+ hasTexture/texOverBase/gpuDirty)', () => {
    const { mgr, armed, meshOf } = makeChainHost();
    const pkg = mgr.addPackage();
    mgr.enterCreatorMode({ packageId: pkg.id });

    const engineTex = armed[0].texMgr!.getTexture();   // what pane/3D strokes paint (in place)
    for (const p of pkg.box.panels) {
      const m = meshOf(p.meshId);
      // SAME OBJECT end-to-end: paint-engine texture === layer texture === panel diffuse.
      expect(m.diffuseTexture as unknown as object).toBe(engineTex);
      expect(m.material.hasTexture).toBe(true);          // per-slot flags encode bit 0
      expect(m.material.texOverBase).toBe(true);         // bit 15 — dieline-over-kraft blend
      expect(m.gpuDirty).toBe(true);                     // renderer repacks the slot flags
    }
  });

  it('stroke-end sync re-points panels after the layer texture is RECREATED (doc-resize) and re-dirties them', () => {
    const { mgr, rlm, armed, meshOf, strokeEnd } = makeChainHost();
    const pkg = mgr.addPackage();
    const st = mgr.enterCreatorMode({ packageId: pkg.id });
    for (const p of pkg.box.panels) meshOf(p.meshId).gpuDirty = false;   // renderer consumed the flags

    // In-place painting (contents change, same object): stroke-end sync must NOT thrash the link.
    strokeEnd();
    for (const p of pkg.box.panels) {
      expect(meshOf(p.meshId).diffuseTexture as unknown as object).toBe(armed[0].texMgr!.getTexture());
      expect(meshOf(p.meshId).gpuDirty).toBe(false);     // nothing re-uploaded for a content-only change
    }

    // Doc resize recreates the layer GPUTexture → the next stroke-end sync must re-point + re-dirty.
    const fresh = rlm.recreateTexture(st.dielineLayerId!);
    strokeEnd();
    for (const p of pkg.box.panels) {
      const m = meshOf(p.meshId);
      expect(m.diffuseTexture as unknown as object).toBe(fresh);
      expect(m.material.hasTexture).toBe(true);
      expect(m.gpuDirty).toBe(true);
    }
  });

  it('re-enter after exit re-links the SAME layer (no duplicate Dieline) and re-arms on the same texture object', () => {
    const { mgr, rlm, armed } = makeChainHost();
    const pkg = mgr.addPackage();
    const first = mgr.enterCreatorMode({ packageId: pkg.id });
    mgr.exitCreatorMode();
    const second = mgr.enterCreatorMode();
    expect(second.dielineLayerId).toBe(first.dielineLayerId);
    expect(rlm.getLayers().filter(l => l.name === 'Dieline').length).toBe(1);
    expect(armed.length).toBe(2);
    expect(armed[1].texMgr!.getTexture()).toBe(armed[0].texMgr!.getTexture());
  });

  it('setDimensions mid-mode (fast path) keeps every panel linked + armed ids valid', () => {
    const { mgr, live, armed } = makeChainHost();
    const pkg = mgr.addPackage();
    const st = mgr.enterCreatorMode({ packageId: pkg.id });
    const resized = mgr.setDimensions(st.packageId!, { width: 140, height: 70, depth: 55 })!;
    expect(resized).not.toBeNull();
    for (const p of resized.box.panels) {
      expect(live.getLinkedLayerId(p.meshId)).toBe(st.dielineLayerId);   // links survive the in-place resize
      expect(armed[0].meshIds).toContain(p.meshId);                      // panel ids unchanged (fast path)
    }
  });

  it('REGRESSION (bug-1 root cause): panels track the MANAGER texture even when the layer.texture snapshot diverges (timeline cel swap)', () => {
    const { mgr, rlm, armed, meshOf, strokeEnd } = makeChainHost();
    const pkg = mgr.addPackage();
    const st = mgr.enterCreatorMode({ packageId: pkg.id });
    const painted = armed[0].texMgr!.getTexture()!;          // what pane/3D strokes actually write

    // The producer: onFrameChanged/forceFrameSync reassigns ONLY layer.texture (cel or undefined).
    rlm.divergeSnapshot(st.dielineLayerId!, { label: 'blank-cel' });
    strokeEnd();                                             // pane stroke ends → syncLiveTextures3D
    for (const p of pkg.box.panels) {
      // Pre-fix: mesh.diffuseTexture followed the snapshot ('blank-cel') → box rendered kraft while
      // the pane readback (manager texture) showed the paint. The mesh must sample the PAINTED object.
      expect(meshOf(p.meshId).diffuseTexture as unknown as object).toBe(painted);
      expect(meshOf(p.meshId).material.hasTexture).toBe(true);
    }

    rlm.divergeSnapshot(st.dielineLayerId!, null);           // blank-frame variant: snapshot nulled
    strokeEnd();
    for (const p of pkg.box.panels) {
      expect(meshOf(p.meshId).diffuseTexture as unknown as object).toBe(painted);
      expect(meshOf(p.meshId).material.hasTexture).toBe(true);
    }
  });

  it('REGRESSION (bug-1 self-heal): a null-at-link layer texture recovers on the next sync (hasTexture flips true)', () => {
    const { mgr, rlm, live, meshOf } = makeChainHost();
    const pkg = mgr.addPackage();
    const bare = rlm.addLayer('Dieline', { visible: false, systemOwner: 'packaging', blankPaintTarget: true });
    const panel = pkg.box.panels[0].meshId;

    live.link(panel, bare.id);                               // linked while the texture doesn't exist yet
    expect(meshOf(panel).material.hasTexture).toBe(false);   // correctly untextured for now
    expect(meshOf(panel).diffuseTexture).toBeNull();

    const tex = rlm.recreateTexture(bare.id);                // texture materializes (ensureTexture)
    live.syncAll();                                          // the stroke-end / link refresh path
    // Pre-fix: the ref-equality early-out kept hasTexture=false forever when diffuseTexture already
    // matched; the flag+ref pair must BOTH be re-derived so the mesh leaves the untextured pipeline.
    expect(meshOf(panel).diffuseTexture as unknown as object).toBe(tex);
    expect(meshOf(panel).material.hasTexture).toBe(true);
    expect(meshOf(panel).gpuDirty).toBe(true);
  });

  it('stroke BEGIN re-syncs the panels too — the first stroke after a texture recreation paints where the box samples', () => {
    const { mgr, rlm, armed, meshOf, strokeBegin } = makeChainHost();
    const pkg = mgr.addPackage();
    const st = mgr.enterCreatorMode({ packageId: pkg.id });

    // The layer texture is RECREATED between strokes (doc/canvas resize) — with stroke-END-only
    // sync the whole NEXT stroke painted into the new object while the panels still sampled the
    // old one. The begin-hook must re-point the panels BEFORE the first dab.
    const fresh = rlm.recreateTexture(st.dielineLayerId!);
    strokeBegin();
    for (const p of pkg.box.panels) {
      expect(meshOf(p.meshId).diffuseTexture as unknown as object).toBe(fresh);
      expect(meshOf(p.meshId).material.hasTexture).toBe(true);
    }
    expect(armed[0].texMgr!.getTexture()).toBe(fresh);   // the engine's manager resolves the same object
  });

  it('re-pointing syncs fire onRepoint per panel (renderer bind-group eviction hook) and advance the counters; content-only syncs do not', () => {
    const chain = makeChainHost();
    const pkg = chain.mgr.addPackage();
    const st = chain.mgr.enterCreatorMode({ packageId: pkg.id });
    const evicted: string[] = [];
    chain.live.onRepoint = (meshId) => evicted.push(meshId);

    const baseRepoints = chain.live.repoints;
    chain.strokeEnd();                                            // content-only: same texture object
    expect(chain.live.repoints).toBe(baseRepoints);               // no repoint for in-place paint
    expect(evicted.length).toBe(0);

    chain.rlm.recreateTexture(st.dielineLayerId!);                // reallocation → refs change
    chain.strokeEnd();
    expect(chain.live.repoints).toBe(baseRepoints + pkg.box.panels.length);
    expect(new Set(evicted)).toEqual(new Set(pkg.box.panels.map(p => p.meshId)));
    expect(chain.live.syncAllCalls).toBeGreaterThan(0);
  });

  it('creator mode suppresses click-select for the package subtree (panel/pivot/root) and restores on exit', () => {
    const { mgr, interaction } = makeChainHost();
    const pkg = mgr.addPackage();
    expect(interaction.pickSuppressed3D).toBeNull();               // outside the mode: selection normal

    mgr.enterCreatorMode({ packageId: pkg.id });
    expect(interaction.suppressBoxSelect).toBe(true);
    const sup = interaction.pickSuppressed3D!;
    expect(sup).not.toBeNull();
    expect(sup(pkg.box.rootGroupId)).toBe(true);                   // root container
    for (const p of pkg.box.panels) {
      expect(sup(p.meshId)).toBe(true);                            // panel meshes — paint, never select
      expect(sup(p.pivotNodeId)).toBe(true);                       // hinge pivots
    }
    expect(sup('some-unrelated-node')).toBe(false);                // other meshes still selectable

    mgr.exitCreatorMode();
    expect(interaction.pickSuppressed3D).toBeNull();               // restored
    expect(interaction.suppressBoxSelect).toBe(false);
  });
});
