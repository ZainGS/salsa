/**
 * src/packaging/packaging-layer-stack.test.ts — Part 1/2: the package LAYER STACK.
 *
 * Real pieces: PackagingManager + real SceneGraph/Mesh3D nodes + real LiveTextureMode (provider
 * links). The host adapter mirrors ShapeManager's `stack` hooks at the same API surface, with the
 * GPU boundary faked: layer textures are identity tokens and the COMPOSITE is a recording fake
 * (ordered inputs + a stable output token) standing in for the RasterCompositor pass.
 *
 * Contracts gated:
 *  1. Legacy dieline MIGRATION: entering creator mode bootstraps the stack with the dieline as the
 *     base layer, and the panels re-link to the COMPOSITE target — not layer 0's texture.
 *  2. Stack CRUD: addLayer/getLayerStack/setActiveLayer/setLayerVisible/setLayerOpacity/
 *     reorderLayer/renameLayer/removeLayer (+ the last-raster-layer guard).
 *  3. ACTIVE-layer paint routing: adding/activating a raster layer re-arms surface paint on it;
 *     activating a VECTOR layer disarms paint ('place' mode) and isActivePaintable() flips — the
 *     host's box click-pick suppression gate (Part 2).
 *  4. Composite inputs re-read order/visibility/opacity live (erase-reveals-below comes from
 *     compositing the stack bottom→top; an empty stack clears → the bare board shows).
 *  5. Persistence round-trip: layers[] + activeLayerId ride the persist entry; restoreFromJSON
 *     re-links the composite and the stack survives.
 *  6. exportDielinePng exports the FLATTENED composite when a stack exists.
 */

import { describe, it, expect, vi } from 'vitest';

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
import { PackagingManager, type PackagingHost, type PackagingPersistEntry } from './packaging-manager';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

type TexToken = { readonly label: string };

class FakeTexManager {
  constructor(public tex: TexToken | null) {}
  getTexture(): TexToken | null { return this.tex; }
}

type FakeLayer = {
  id: string; name: string; kind: 'raster' | 'vector';
  visible: boolean; opacity: number;
  systemOwner?: string; packageOwnerId?: string;
  texture: TexToken | null; manager: FakeTexManager | null;
};

class FakeLayerRegistry {
  layers: FakeLayer[] = [];
  private n = 0;
  addRaster(name: string, opts: { visible?: boolean; systemOwner?: string; packageOwnerId?: string } = {}): FakeLayer {
    const tex: TexToken = { label: `layer-tex-${this.n}` };
    const l: FakeLayer = {
      id: `layer-${this.n++}`, name, kind: 'raster',
      visible: opts.visible ?? true, opacity: 1,
      systemOwner: opts.systemOwner, packageOwnerId: opts.packageOwnerId,
      texture: tex, manager: new FakeTexManager(tex),
    };
    this.layers.push(l);
    return l;
  }
  addVector(name: string, opts: { visible?: boolean; systemOwner?: string; packageOwnerId?: string } = {}): FakeLayer {
    const l: FakeLayer = {
      id: `layer-${this.n++}`, name, kind: 'vector',
      visible: opts.visible ?? true, opacity: 1,
      systemOwner: opts.systemOwner, packageOwnerId: opts.packageOwnerId,
      texture: null, manager: null,
    };
    this.layers.push(l);
    return l;
  }
  get(id: string) { return this.layers.find(l => l.id === id); }
  remove(id: string): boolean {
    const i = this.layers.findIndex(l => l.id === id);
    if (i < 0) return false;
    this.layers.splice(i, 1);
    return true;
  }
  // LiveTextureMode's RasterLayerManager surface (layer links resolve manager-first).
  getLayerById(id: string) { return this.get(id); }
  getLayerTexture(id: string): TexToken | null { return this.get(id)?.texture ?? null; }
  getLayers() { return this.layers; }
}

/** Recording composite target: `tex` = the stable output token the panels must sample; `inputs` =
 *  what the last recomposite consumed (ordered bottom→top, with visibility/opacity). */
type CompositeRec = {
  tex: TexToken;
  inputs: { layerId: string; tex: TexToken | null; visible: boolean; opacity: number; kind: string }[];
  recomposites: number;
  mgrLike: FakeTexManager;
};

function makeStackHost() {
  const sceneGraph = new SceneGraph();
  const reg = new FakeLayerRegistry();
  const live = new LiveTextureMode(sceneGraph, () => reg as unknown as RasterLayerManager);
  const composites = new Map<string, CompositeRec>();
  const armed: { meshIds: string[]; layerId: string }[] = [];
  let disarms = 0;
  let notifies = 0;                       // host scene-graph-changed emits (the Outliner's event)
  const vis = new Map<string, boolean>(); // node visibility (creator-mode isolation)
  const exportedPngFor: string[] = [];
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
    setPanelGeometry: (meshId, geom) => {
      const n = sceneGraph.findNodeById(meshId);
      if (n instanceof Mesh3D) n.setGeometry(geom);
    },
    removeNode: (id) => { const n = sceneGraph.findNodeById(id); n?.parent?.removeChild(n); },
    linkLiveTexture: (id, layerId) => live.link(id, layerId),
    unlinkLiveTexture: (id) => live.unlink(id),
    exportLayerPng: async () => null,
    scheduleRender: () => { /* noop */ },
    setDocSize: () => { /* noop */ },
    ensureDielineLayer: (existing) =>
      (existing && reg.get(existing)?.texture) ? existing : reg.addRaster('Dieline', { visible: false, systemOwner: 'packaging' }).id,
    // EXACT mirror of the ShapeManager adapter (incl. the per-package by-NAME reuse scope: never
    // steal a 'Dieline' owned by a DIFFERENT package; tag ownership at birth; and _tagPackagingLayer
    // semantics — package-OWNED layers keep `visible` as STACK visibility, never force-hidden).
    ensureDielineLayerInfo: (existing, packageId) => {
      const tag = (layerId: string): void => {
        const l = reg.get(layerId);
        if (!l) return;
        l.systemOwner = 'packaging';
        if (l.visible && !l.packageOwnerId) l.visible = false;   // legacy/untagged only
      };
      if (existing && reg.get(existing)?.texture) { tag(existing); return { layerId: existing, fresh: false }; }
      const named = reg.getLayers().find(l =>
        l.name === 'Dieline' && l.texture && (!l.packageOwnerId || l.packageOwnerId === packageId));
      if (named) { tag(named.id); return { layerId: named.id, fresh: false }; }
      return { layerId: reg.addRaster('Dieline', { visible: false, systemOwner: 'packaging', packageOwnerId: packageId }).id, fresh: true };
    },
    nodeExists: (id) => !!sceneGraph.findNodeById(id),
    frameAndOrbit: () => { /* noop */ },
    stopOrbit: () => { /* noop */ },
    armSurfacePaint: (meshIds, layerId) => { armed.push({ meshIds: [...meshIds], layerId }); return true; },
    disarmSurfacePaint: () => { disarms++; },
    // Real material re-assert (the adapter's applyPanelMaterial): kraft/white base + texOverBase.
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
    notifySceneGraphChanged: () => { notifies++; },
    setNodeVisible: (id, visible) => {
      const n = sceneGraph.findNodeById(id);
      n?.forEachDeep?.((d: { visible: boolean }) => { d.visible = visible; });
      vis.set(id, visible);
    },
    isNodeVisible: (id) => vis.get(id) ?? true,
    layerExists: (layerId) => !!reg.get(layerId)?.texture,

    // ── the `stack` hooks, mirroring the ShapeManager adapter ──
    stack: {
      addRasterLayer: (packageId, name) => reg.addRaster(name, { visible: true, systemOwner: 'packaging', packageOwnerId: packageId }).id,
      addVectorLayer: (packageId, name) => reg.addVector(name, { visible: true, systemOwner: 'packaging', packageOwnerId: packageId }).id,
      adopt: (packageId, layerId) => {
        const l = reg.get(layerId);
        if (!l) return;
        l.systemOwner = 'packaging';
        l.packageOwnerId = packageId;
        if (!l.visible) l.visible = true;   // package-tagged → visible now means STACK visibility
      },
      info: (layerId) => {
        const l = reg.get(layerId);
        return l ? { name: l.name, visible: l.visible, opacity: l.opacity, kind: l.kind } : null;
      },
      setVisible: (layerId, visible) => { const l = reg.get(layerId); if (l) l.visible = visible; },
      setOpacity: (layerId, opacity) => { const l = reg.get(layerId); if (l) l.opacity = opacity; },
      rename: (layerId, name) => { const l = reg.get(layerId); if (l) l.name = name; },
      remove: (layerId) => reg.remove(layerId),
      linkComposite: (packageId, panelMeshIds, getStack) => {
        let rec = composites.get(packageId);
        if (!rec) {
          const tex: TexToken = { label: `composite-${packageId}` };
          rec = { tex, inputs: [], recomposites: 0, mgrLike: new FakeTexManager(tex) };
          composites.set(packageId, rec);
        }
        (rec as CompositeRec & { getStack?: () => { layerIds: string[] } }).getStack = getStack;
        const provider = () => (composites.get(packageId)?.tex ?? null) as unknown as GPUTexture | null;
        for (const id of panelMeshIds) live.linkProvider(id, provider);
        host.stack!.recomposite(packageId);
      },
      unlinkComposite: (packageId) => {
        composites.delete(packageId);
      },
      recomposite: (packageId) => {
        const rec = composites.get(packageId) as (CompositeRec & { getStack?: () => { layerIds: string[] } }) | undefined;
        if (!rec?.getStack) return;
        rec.recomposites++;
        rec.inputs = rec.getStack().layerIds
          .map(layerId => {
            const l = reg.get(layerId);
            return l ? { layerId, tex: l.texture, visible: l.visible, opacity: l.opacity, kind: l.kind } : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
      },
      exportPng: async (packageId) => { exportedPngFor.push(packageId); return null; },
    },
  };
  const mgr = new PackagingManager(host);
  mgrRef = mgr;
  void mgrRef;
  const meshOf = (id: string): Mesh3D => {
    const n = sceneGraph.findNodeById(id);
    if (!(n instanceof Mesh3D)) throw new Error('panel mesh not found: ' + id);
    return n;
  };
  return {
    sceneGraph, reg, live, composites, armed, mgr, meshOf, host, exportedPngFor, vis,
    getDisarms: () => disarms, getNotifies: () => notifies,
  };
}

describe('package layer stack (Part 1)', () => {
  it('MIGRATION + COMPOSITE LINKAGE: creator enter bootstraps the stack from the dieline and panels sample the COMPOSITE, not layer 0', () => {
    const { reg, composites, mgr, meshOf } = makeStackHost();
    const st = mgr.enterCreatorMode({ params: { width: 80, height: 60, depth: 40 } });
    const pkg = mgr.get(st.packageId!)!;

    const stack = mgr.getLayerStack(pkg.id);
    expect(stack.length).toBe(1);
    expect(stack[0].layerId).toBe(st.dielineLayerId);        // legacy dieline = base layer
    expect(stack[0].kind).toBe('raster');
    expect(stack[0].active).toBe(true);
    expect(reg.get(st.dielineLayerId!)!.packageOwnerId).toBe(pkg.id);   // adopted/tagged
    expect(reg.get(st.dielineLayerId!)!.visible).toBe(true);            // stack-visible once tagged

    const rec = composites.get(pkg.id)!;
    expect(rec).toBeTruthy();
    const layer0Tex = reg.get(st.dielineLayerId!)!.texture!;
    for (const p of pkg.box.panels) {
      const m = meshOf(p.meshId);
      expect(m.diffuseTexture as unknown as object).toBe(rec.tex);      // the COMPOSITE target
      expect(m.diffuseTexture as unknown as object).not.toBe(layer0Tex); // NOT the base layer
      expect(m.material.hasTexture).toBe(true);
    }
    // Composite consumed the stack bottom→top.
    expect(rec.inputs.map(i => i.layerId)).toEqual([st.dielineLayerId]);
  });

  it('CRUD: addLayer (top + active + re-arm), visibility/opacity live in the composite inputs, rename, reorder', () => {
    const { reg, composites, armed, mgr } = makeStackHost();
    const st = mgr.enterCreatorMode();
    const pkgId = st.packageId!;
    const base = st.dielineLayerId!;

    const added = mgr.addLayer(pkgId, 'Art')!;
    expect(added).toBeTruthy();
    let stack = mgr.getLayerStack(pkgId);
    expect(stack.map(l => l.layerId)).toEqual([base, added.layerId]);   // appended on TOP
    expect(stack[1].active).toBe(true);                                 // new layer is the paint target
    expect(armed[armed.length - 1].layerId).toBe(added.layerId);        // paint re-armed on it

    // Visibility + opacity flow into the composite inputs (the erase-reveals-below machinery).
    mgr.setLayerVisible(pkgId, base, false);
    mgr.setLayerOpacity(pkgId, added.layerId, 0.5);
    const rec = composites.get(pkgId)!;
    expect(rec.inputs.find(i => i.layerId === base)!.visible).toBe(false);
    expect(rec.inputs.find(i => i.layerId === added.layerId)!.opacity).toBe(0.5);
    mgr.setLayerVisible(pkgId, base, true);

    // Rename.
    expect(mgr.renameLayer(pkgId, added.layerId, 'Label Art')).toBe(true);
    expect(reg.get(added.layerId)!.name).toBe('Label Art');

    // Reorder: move the added layer to the bottom → composite order flips.
    expect(mgr.reorderLayer(pkgId, added.layerId, 0)).toBe(true);
    stack = mgr.getLayerStack(pkgId);
    expect(stack.map(l => l.layerId)).toEqual([added.layerId, base]);
    expect(rec.inputs.map(i => i.layerId)).toEqual([added.layerId, base]);
  });

  it('removeLayer: deletes + repairs active; the LAST raster layer is guarded', () => {
    const { mgr, reg } = makeStackHost();
    const st = mgr.enterCreatorMode();
    const pkgId = st.packageId!;
    const base = st.dielineLayerId!;
    const l2 = mgr.addLayer(pkgId, 'Art')!;

    expect(mgr.removeLayer(pkgId, l2.layerId)).toBe(true);
    expect(reg.get(l2.layerId)).toBeUndefined();                        // gone from the registry
    const stack = mgr.getLayerStack(pkgId);
    expect(stack.map(l => l.layerId)).toEqual([base]);
    expect(stack[0].active).toBe(true);                                 // active repaired to base

    expect(mgr.removeLayer(pkgId, base)).toBe(false);                   // last raster — guarded
    expect(mgr.getLayerStack(pkgId).length).toBe(1);
  });

  it('persistence round-trip: layers[] + activeLayerId ride the entry; restore re-links the composite', () => {
    const chain = makeStackHost();
    const { mgr, composites, meshOf } = chain;
    const st = mgr.enterCreatorMode();
    const pkgId = st.packageId!;
    const l2 = mgr.addLayer(pkgId, 'Art')!;
    mgr.exitCreatorMode();

    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));
    expect(persisted[0].layers).toEqual([st.dielineLayerId, l2.layerId]);
    expect(persisted[0].activeLayerId).toBe(l2.layerId);

    // Fresh manager over the SAME scene/registry (the reload re-adoption path).
    composites.clear();
    const mgr2 = new PackagingManager(chain.host);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    const stack = mgr2.getLayerStack(pkgId);
    expect(stack.map(l => l.layerId)).toEqual([st.dielineLayerId, l2.layerId]);
    expect(stack.find(l => l.active)!.layerId).toBe(l2.layerId);
    const rec = composites.get(pkgId)!;
    expect(rec).toBeTruthy();
    for (const p of mgr2.get(pkgId)!.box.panels) {
      expect(meshOf(p.meshId).diffuseTexture as unknown as object).toBe(rec.tex);   // composite re-linked
    }
  });

  it('exportDielinePng exports the FLATTENED composite when a stack exists', async () => {
    const { mgr, exportedPngFor } = makeStackHost();
    const st = mgr.enterCreatorMode();
    await mgr.exportDielinePng(st.packageId!);
    expect(exportedPngFor).toEqual([st.packageId]);
  });
});

describe('vector layers in the stack (Part 2)', () => {
  it('addVectorLayer joins the stack in order and flips to PLACE mode (paint disarmed, suppression gate lifts)', () => {
    const { mgr, armed, getDisarms } = makeStackHost();
    const st = mgr.enterCreatorMode();
    const pkgId = st.packageId!;
    expect(mgr.isActivePaintable()).toBe(true);                         // raster base active = paint mode

    const v = mgr.addVectorLayer(pkgId, 'Stickers')!;
    expect(v).toBeTruthy();
    const stack = mgr.getLayerStack(pkgId);
    expect(stack.map(l => l.kind)).toEqual(['raster', 'vector']);
    expect(stack[1].active).toBe(true);
    expect(getDisarms()).toBeGreaterThan(0);                            // place mode: surface paint OFF
    expect(mgr.isActivePaintable()).toBe(false);                        // → box click-pick suppression lifts

    // Back to the raster layer → paint re-arms on it, suppression returns.
    expect(mgr.setActiveLayer(pkgId, st.dielineLayerId!)).toBe(true);
    expect(armed[armed.length - 1].layerId).toBe(st.dielineLayerId);
    expect(mgr.isActivePaintable()).toBe(true);
  });

  it('BUG 1: addVectorLayer AFTER bootstrap wires the layer into the compositor subscription — recomposite fired + composite inputs include it (tagged for the host change-event)', () => {
    const { mgr, reg, composites } = makeStackHost();
    const st = mgr.enterCreatorMode();
    const pkgId = st.packageId!;
    const rec = composites.get(pkgId)!;
    const recompositesBefore = rec.recomposites;

    // Add the vector layer AFTER the stack bootstrapped (dieline only) — the compositor must pick
    // it up (the getStack closure is live), not stay frozen on the bootstrap layer set.
    const v = mgr.addVectorLayer(pkgId, 'Stickers')!;
    expect(rec.recomposites).toBeGreaterThan(recompositesBefore);      // relink recomposited
    expect(rec.inputs.map(i => i.layerId)).toEqual([st.dielineLayerId, v.layerId]);
    expect(rec.inputs.find(i => i.layerId === v.layerId)!.kind).toBe('vector');   // proxy slot in the composite
    // The layer is package-tagged — this is what the host's change-event subscription
    // (_pkgVectorLayerDirty) resolves to route a placement change back into THIS composite.
    expect(reg.get(v.layerId)!.packageOwnerId).toBe(pkgId);
    expect(reg.get(v.layerId)!.systemOwner).toBe('packaging');

    // A subsequent recomposite (what the debounced placement-change handler triggers) still carries
    // the vector layer — the subscription target survives beyond the add.
    const n = rec.recomposites;
    mgr.setLayerOpacity(pkgId, v.layerId, 0.8);
    expect(rec.recomposites).toBeGreaterThan(n);
    expect(rec.inputs.map(i => i.layerId)).toContain(v.layerId);
  });

  it('BUG 1: a dims/style REBUILD re-keys the package but keeps the vector layer OWNED by the new id (the change subscription never goes stale)', () => {
    const { mgr, reg, composites } = makeStackHost();
    const st = mgr.enterCreatorMode({ params: { width: 80, height: 60, depth: 40 } });
    const oldId = st.packageId!;
    const v = mgr.addVectorLayer(oldId, 'Stickers')!;
    expect(reg.get(v.layerId)!.packageOwnerId).toBe(oldId);

    // A style change is a topology rebuild → the package id CHANGES. The vector layer must be
    // re-tagged to the new id, else _pkgVectorLayerDirty(packageOwnerId) resolves an unlinked
    // composite and vector placements silently stop recompositing onto the box.
    const s2 = mgr.setStyle(oldId, 'tuckEnd')!;
    expect(s2.id).not.toBe(oldId);                                     // re-keyed
    expect(reg.get(v.layerId)!.packageOwnerId).toBe(s2.id);           // re-tagged to the NEW id
    expect(composites.has(s2.id)).toBe(true);                          // composite keyed by the new id
    const rec = composites.get(s2.id)!;
    expect(rec.inputs.map(i => i.layerId)).toContain(v.layerId);      // still composited after rebuild
  });

  it('vector layers persist in the stack order and survive the round-trip', () => {
    const chain = makeStackHost();
    const { mgr } = chain;
    const st = mgr.enterCreatorMode();
    const pkgId = st.packageId!;
    const v = mgr.addVectorLayer(pkgId, 'Stickers')!;
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));
    expect(persisted[0].layers).toEqual([st.dielineLayerId, v.layerId]);

    chain.composites.clear();
    const mgr2 = new PackagingManager(chain.host);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    const stack = mgr2.getLayerStack(pkgId);
    expect(stack.map(l => l.kind)).toEqual(['raster', 'vector']);
    // Restored active was the vector layer → still place mode after restore + enter.
    expect(stack.find(l => l.active)!.layerId).toBe(v.layerId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// OUTLINER-FLOW PARITY (the two-package acceptance scenario): addPackage → select → "Package Mode"
// must behave IDENTICALLY to the toolbar create-or-reuse flow, per targeted package. Gates the
// three field bugs: (1) {packageId} enters lacking material/stack/paint/isolation parity, (2)
// addPackage invisible in the Outliner until the next unrelated scene change, (3) every selection
// silently editing the SAME (previous creator) box via the quiet unknown-id fallback.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('Outliner-flow parity: two packages through the adapter-mirror harness', () => {
  it('addPackage emits the host scene-graph-changed notification IMMEDIATELY (A and B)', () => {
    const { mgr, getNotifies } = makeStackHost();
    const before = getNotifies();
    const a = mgr.addPackage();
    expect(getNotifies()).toBeGreaterThan(before);       // A announced by its own add — no flush needed
    const mid = getNotifies();
    const b = mgr.addPackage({ width: 120, height: 90, depth: 50 });
    expect(getNotifies()).toBeGreaterThan(mid);          // B too
    expect(a.id).not.toBe(b.id);
  });

  it('isPackageNode resolves B via its ROOT, a PANEL mesh, and a HINGE pivot', () => {
    const { mgr } = makeStackHost();
    mgr.addPackage();
    const b = mgr.addPackage();
    expect(mgr.isPackageNode(b.id)).toBe(b.id);                          // root container
    expect(mgr.isPackageNode(b.box.panels[2].meshId)).toBe(b.id);        // panel mesh
    expect(mgr.isPackageNode(b.box.panels[4].pivotNodeId)).toBe(b.id);   // hinge pivot
  });

  it('enterCreatorMode({packageId: B}) runs the FULL enter on B: material contract, own stack + composite, paint on ITS layer, A isolated, state tracks B', () => {
    const { mgr, reg, composites, armed, vis, meshOf } = makeStackHost();
    const a = mgr.addPackage();
    const b = mgr.addPackage({ width: 120, height: 90, depth: 50 });
    // Corrupt B's panel materials (simulates a restored box whose persisted material predates
    // texOverBase — the grey/black-box symptom) so the enter must RE-ASSERT the contract.
    for (const p of b.box.panels) {
      const m = meshOf(p.meshId);
      Object.assign(m.material, { diffuse: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, texOverBase: false });
    }

    const st = mgr.enterCreatorMode({ packageId: b.id });
    expect(st.active).toBe(true);
    expect(st.packageId).toBe(b.id);                     // the state reflects the box actually targeted
    expect(mgr.getCreatorState().packageId).toBe(b.id);

    // Panel material contract re-asserted on every B panel (white/kraft base + texOverBase).
    for (const p of b.box.panels) {
      const m = meshOf(p.meshId);
      expect(m.material.texOverBase).toBe(true);
      expect(m.material.diffuse.r).toBeCloseTo(0.96);
    }
    // B's stack provisioned with its OWN dieline (owned by B) + panels linked to B's COMPOSITE.
    const stack = mgr.getLayerStack(b.id);
    expect(stack.length).toBe(1);
    expect(reg.get(stack[0].layerId)!.packageOwnerId).toBe(b.id);
    const rec = composites.get(b.id)!;
    expect(rec).toBeTruthy();
    for (const p of b.box.panels) {
      expect(meshOf(p.meshId).diffuseTexture as unknown as object).toBe(rec.tex);
    }
    // Paint armed on B's ACTIVE stack layer, across B's 6 panels.
    const lastArm = armed[armed.length - 1];
    expect(lastArm.layerId).toBe(stack.find(l => l.active)!.layerId);
    expect(lastArm.meshIds.sort()).toEqual(b.box.panels.map(p => p.meshId).sort());
    // Isolation: A hidden, B shown.
    expect(vis.get(a.box.rootGroupId)).toBe(false);
    expect(vis.get(b.box.rootGroupId)).toBe(true);
  });

  it('switching to A WITHOUT exit mirrors everything (A shown + armed on ITS layer, B hidden) and never cross-links dielines', () => {
    const { mgr, reg, composites, armed, vis, meshOf } = makeStackHost();
    const a = mgr.addPackage();
    const b = mgr.addPackage();
    const stB = mgr.enterCreatorMode({ packageId: b.id });
    const stA = mgr.enterCreatorMode({ packageId: a.id });   // switch, no exit

    expect(stA.packageId).toBe(a.id);
    expect(vis.get(b.box.rootGroupId)).toBe(false);          // B now hidden
    expect(vis.get(a.box.rootGroupId)).toBe(true);           // A shown
    // A got its OWN dieline/stack — B's base was NOT stolen (the by-NAME reuse is package-scoped).
    expect(stA.dielineLayerId).not.toBe(stB.dielineLayerId);
    expect(reg.get(stA.dielineLayerId!)!.packageOwnerId).toBe(a.id);
    expect(reg.get(stB.dielineLayerId!)!.packageOwnerId).toBe(b.id);
    // Paint re-armed on A's active layer, panels sample A's composite.
    const stackA = mgr.getLayerStack(a.id);
    expect(armed[armed.length - 1].layerId).toBe(stackA.find(l => l.active)!.layerId);
    const recA = composites.get(a.id)!;
    for (const p of a.box.panels) {
      expect(meshOf(p.meshId).diffuseTexture as unknown as object).toBe(recA.tex);
    }
  });

  it('a raw PANEL or PIVOT selection id passed as packageId still targets the right package', () => {
    const { mgr } = makeStackHost();
    mgr.addPackage();
    const b = mgr.addPackage();
    const viaPanel = mgr.enterCreatorMode({ packageId: b.box.panels[1].meshId });
    expect(viaPanel.packageId).toBe(b.id);
    mgr.exitCreatorMode();
    const a = mgr.getAll().find(p => p.id !== b.id)!;
    const viaPivot = mgr.enterCreatorMode({ packageId: a.box.panels[3].pivotNodeId });
    expect(viaPivot.packageId).toBe(a.id);
    mgr.exitCreatorMode();
  });

  it('RE-ENTER keeps the migrated base layer STACK-VISIBLE (the tag-hides-the-base regression: paint written but never composited)', () => {
    const { mgr, reg, composites } = makeStackHost();
    const a = mgr.addPackage();
    const first = mgr.enterCreatorMode({ packageId: a.id });
    expect(reg.get(first.dielineLayerId!)!.visible).toBe(true);    // migrated base is stack-visible
    mgr.exitCreatorMode();

    const again = mgr.enterCreatorMode({ packageId: a.id });       // the Outliner flow ALWAYS re-enters
    expect(again.dielineLayerId).toBe(first.dielineLayerId);
    expect(reg.get(again.dielineLayerId!)!.visible).toBe(true);    // NOT force-hidden by the tag pass
    const rec = composites.get(a.id)!;
    expect(rec.inputs.find(i => i.layerId === again.dielineLayerId)!.visible).toBe(true);   // still composited
    mgr.exitCreatorMode();
  });

  it('an UNKNOWN packageId warns LOUDLY (id + known registry keys) and falls back non-throwing', () => {
    const { mgr } = makeStackHost();
    const a = mgr.addPackage();
    mgr.enterCreatorMode({ packageId: a.id });
    mgr.exitCreatorMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* capture */ });
    try {
      const st = mgr.enterCreatorMode({ packageId: 'no-such-node' });
      expect(st.active).toBe(true);                        // non-throwing fallback (create-or-reuse)
      expect(st.packageId).toBe(a.id);                     // fell back to the previous creator box
      expect(warn).toHaveBeenCalled();
      const msg = String(warn.mock.calls.map(c => c.join(' ')).join('\n'));
      expect(msg).toContain('no-such-node');               // the unresolved id
      expect(msg).toContain(a.id);                         // the known registry keys
    } finally {
      warn.mockRestore();
    }
  });
});
