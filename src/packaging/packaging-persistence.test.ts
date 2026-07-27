/**
 * src/packaging/packaging-persistence.test.ts — package RE-ADOPTION on reload (bug-2 fix).
 *
 * The registry round-trip through the persistence JSON: serialize() → a FRESH PackagingManager
 * (the post-reload state: empty registry, scene nodes restored) → restoreFromJSON() re-binds the
 * EXISTING nodes — no duplicates, isPackageNode/getAll work, enterCreatorMode reuses the restored
 * box, setDimensions/fold drive the restored nodes, the dieline link re-establishes, and panel
 * meshes the document-restore pass left at the scene ROOT are re-parented under their hinge
 * pivots. Plus the defensive dedupe: enterCreatorMode ADOPTS an orphaned package root (persisted
 * marker structure, not in the registry) instead of creating a second overlapping box.
 */

import { describe, it, expect, vi } from 'vitest';

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
import { PackagingManager, type PackagingHost, type PackagingPersistEntry, type PackagingMarker } from './packaging-manager';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

type TexToken = { readonly label: string };

class FakeTexManager {
  constructor(public tex: TexToken | null) {}
  getTexture(): TexToken | null { return this.tex; }
}

class FakeRasterLayers {
  layers: { id: string; name: string; visible: boolean; systemOwner?: string; texture: TexToken | null; manager: FakeTexManager }[] = [];
  private n = 0;
  addLayer(name: string, opts: { visible?: boolean; systemOwner?: string } = {}) {
    const tex: TexToken = { label: `tex-${this.n}` };
    const layer = { id: `layer-${this.n++}`, name, visible: opts.visible ?? true, systemOwner: opts.systemOwner, texture: tex, manager: new FakeTexManager(tex) };
    this.layers.push(layer);
    return layer;
  }
  getLayerById(id: string) { return this.layers.find(l => l.id === id); }
  getLayers() { return this.layers; }
}

/** Build a host + manager over a given scene graph / layer registry — the ShapeManager adapter,
 *  mirrored hook-for-hook including the RE-ADOPTION hooks (reparentNode / layerExists /
 *  getPackageStructure / findOrphanPackageRoots). */
function makeHost(sceneGraph: SceneGraph, rlm: FakeRasterLayers, live: LiveTextureMode) {
  const armed: { meshIds: string[]; layerId: string }[] = [];
  const unitRootEmits: { id: string; panelsAtEmit: number }[] = [];
  let isoMemory: Map<string, boolean> | null = null;   // full-scene isolation memory (mirrors the adapter)
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
      if (t.scale) { n.scaleX = t.scale[0]; n.scaleY = t.scale[1]; n.scaleZ = t.scale[2]; }
    },
    // Mirror the ShapeManager adapter: read the ROOT's live transform so serialize()/the marker
    // capture a whole-box gizmo move/rotate/scale for round-tripping.
    getNodeTransform: (id) => {
      const n = sceneGraph.findNodeById(id) as Mesh3D | MeshGroup3D | null;
      if (!n) return null;
      return {
        x: n.x, y: n.y, z: n.z,
        rotationX: n.rotationX, rotationY: n.rotationY, rotation: n.rotation,
        scaleX: n.scaleX, scaleY: n.scaleY, scaleZ: n.scaleZ,
      };
    },
    setPanelGeometry: (meshId, geom) => {
      const n = sceneGraph.findNodeById(meshId);
      if (n instanceof Mesh3D) n.setGeometry(geom);
    },
    removeNode: (id) => { const n = sceneGraph.findNodeById(id); n?.parent?.removeChild(n); },
    linkLiveTexture: (id, layerId) => live.link(id, layerId),
    unlinkLiveTexture: (id) => live.unlink(id),
    exportLayerPng: async () => null,
    scheduleRender: () => {},
    setDocSize: () => {},
    ensureDielineLayer: (existing) => existing ?? rlm.addLayer('Dieline', { visible: false, systemOwner: 'packaging' }).id,
    ensureDielineLayerInfo: (existing) => {
      if (existing && rlm.getLayerById(existing)?.texture) return { layerId: existing, fresh: false };
      const named = rlm.getLayers().find(l => l.name === 'Dieline' && l.texture);
      if (named) return { layerId: named.id, fresh: false };
      return { layerId: rlm.addLayer('Dieline', { visible: false, systemOwner: 'packaging' }).id, fresh: true };
    },
    nodeExists: (id) => !!sceneGraph.findNodeById(id),
    frameAndOrbit: () => {},
    stopOrbit: () => {},
    armSurfacePaint: (meshIds, layerId) => { armed.push({ meshIds: [...meshIds], layerId }); return true; },
    disarmSurfacePaint: () => {},
    applyPanelMaterial: () => {},
    // Mirror the adapter: the ROOT is a thin-wrapper documentSkipChildren marker created + announced
    // up front (Building/City pattern), BEFORE any panels — so the Outliner shows it immediately.
    createUnitRoot: (name) => {
      const g = new MeshGroup3D(isvc);
      g.name = name;
      g.thinWrapper = true;
      g.documentSkipChildren = true;
      (g as unknown as { worldParams: unknown }).worldParams = { kind: 'packaging' };
      sceneGraph.root.addChild(g);
      unitRootEmits.push({ id: g.id, panelsAtEmit: g.children.length });   // 0 children = announced empty
      return g.id;
    },
    markUnitWrapper: (rootNodeId, localBounds) => {
      const n = sceneGraph.findNodeById(rootNodeId);
      // Mirror the ShapeManager adapter: package roots are documentSkipChildren procedural markers
      // (panels regenerate from params on load — bug 3), not just thin wrappers.
      if (n instanceof MeshGroup3D) { if (localBounds) n.cachedBounds = localBounds; n.thinWrapper = true; n.documentSkipChildren = true; }
    },
    // ── Creator-mode ISOLATION hooks (mirror the ShapeManager adapter: stamp the whole subtree) ──
    setNodeVisible: (id, visible) => {
      const n = sceneGraph.findNodeById(id);
      if (!n) return;
      n.forEachDeep(d => { d.visible = visible; });   // includes the root itself
    },
    isNodeVisible: (id) => sceneGraph.findNodeById(id)?.visible ?? true,
    // FULL-SCENE isolation (mirror the adapter): hide EVERY top-level object except the edited box.
    isolateSceneToPackage: (keepRootId) => {
      if (isoMemory) for (const [id, vis] of isoMemory) { const p = sceneGraph.findNodeById(id); if (p) p.forEachDeep(d => { d.visible = vis; }); }
      const mem = new Map<string, boolean>();
      for (const child of [...sceneGraph.root.children]) {
        const cid = (child as unknown as { id: string }).id;
        if (cid === keepRootId) continue;
        mem.set(cid, (child as unknown as { visible: boolean }).visible);
        child.forEachDeep(d => { d.visible = false; });
      }
      isoMemory = mem;
    },
    restoreSceneIsolation: () => {
      if (!isoMemory) return;
      for (const [id, vis] of isoMemory) { const p = sceneGraph.findNodeById(id); if (p) p.forEachDeep(d => { d.visible = vis; }); }
      isoMemory = null;
    },
    // ── RE-ADOPTION hooks (mirror the ShapeManager adapter) ──
    reparentNode: (childId, parentId) => {
      const child = sceneGraph.findNodeById(childId);
      const parent = sceneGraph.findNodeById(parentId);
      if (!child || !parent || child.parent === parent) return;
      child.parent?.removeChild(child);
      (parent as MeshGroup3D).addChild(child);
    },
    layerExists: (layerId) => !!rlm.getLayerById(layerId)?.texture,
    // SELF-DESCRIBING MARKER hooks (mirror the ShapeManager adapter) — stamp the full persist entry
    // onto the root's worldParams and scan the scene ROOT for those markers.
    stampMarker: (rootId, entry) => {
      const g = sceneGraph.findNodeById(rootId);
      if (g instanceof MeshGroup3D) (g as unknown as { worldParams: unknown }).worldParams = { kind: 'packaging', entry };
    },
    findPackageMarkers: () => {
      const out: { rootId: string; entry: PackagingPersistEntry | null }[] = [];
      for (const c of sceneGraph.root.children) {
        if (c instanceof MeshGroup3D) {
          const wp = (c as unknown as { worldParams?: { kind?: string; entry?: PackagingPersistEntry } }).worldParams;
          if (wp?.kind === 'packaging') out.push({ rootId: c.id, entry: wp.entry ?? null });
        }
      }
      return out;
    },
    getPackageStructure: (rootId) => {
      const root = sceneGraph.findNodeById(rootId);
      if (!(root instanceof MeshGroup3D)) return null;
      const out: { pivotNodeId: string; meshId: string | null; name: string }[] = [];
      root.forEachDeep(n => {
        if (n === root) return;
        if (n instanceof MeshGroup3D && typeof n.name === 'string' && n.name.endsWith(' Hinge')) {
          const mesh = (n.children ?? []).find(c => c instanceof Mesh3D) as Mesh3D | undefined;
          out.push({ pivotNodeId: n.id, meshId: mesh?.id ?? null, name: n.name.slice(0, -' Hinge'.length) });
        }
      });
      return out.length ? out : null;
    },
    findOrphanPackageRoots: (knownIds) => {
      const known = new Set(knownIds);
      const found: string[] = [];
      const scan = (n: { children?: unknown[] }): void => {
        for (const c of (n.children ?? []) as { children?: unknown[] }[]) {
          if (c instanceof MeshGroup3D && !known.has(c.id) && (c.name === 'Package' || c.thinWrapper)) {
            let hingePanels = 0;
            c.forEachDeep(d => {
              if (d instanceof MeshGroup3D && typeof d.name === 'string' && d.name.endsWith(' Hinge') &&
                  (d.children ?? []).some(x => x instanceof Mesh3D)) hingePanels++;
            });
            if (hingePanels > 0) { found.push(c.id); continue; }
          }
          scan(c as { children?: unknown[] });
        }
      };
      scan(sceneGraph.root as unknown as { children?: unknown[] });
      return found;
    },
  };
  return { host, armed, unitRootEmits };
}

function countNodes(sceneGraph: SceneGraph): number {
  let n = 0;
  sceneGraph.root.forEachDeep(() => n++);
  return n;
}

/** The reload simulation: same scene graph + layers (nodes "restored"), FRESH manager. */
function reload(sceneGraph: SceneGraph, rlm: FakeRasterLayers) {
  const live = new LiveTextureMode(sceneGraph, () => rlm as unknown as RasterLayerManager);
  const { host, armed } = makeHost(sceneGraph, rlm, live);
  return { mgr: new PackagingManager(host), live, armed };
}

function setup() {
  const sceneGraph = new SceneGraph();
  const rlm = new FakeRasterLayers();
  const live = new LiveTextureMode(sceneGraph, () => rlm as unknown as RasterLayerManager);
  const { host, armed, unitRootEmits } = makeHost(sceneGraph, rlm, live);
  return { sceneGraph, rlm, live, mgr: new PackagingManager(host), armed, unitRootEmits };
}

describe('Packaging Outliner presence — root announced up front (Building pattern)', () => {
  it('addPackage creates the thin-wrapper root via createUnitRoot, announced EMPTY before any panels', () => {
    const { sceneGraph, mgr, unitRootEmits } = setup();
    const pkg = mgr.addPackage();
    // The root was created + announced through createUnitRoot with ZERO panels present at that moment
    // (the "show Package in the Outliner immediately" contract — panels build under it afterwards).
    expect(unitRootEmits.length).toBe(1);
    expect(unitRootEmits[0].id).toBe(pkg.id);
    expect(unitRootEmits[0].panelsAtEmit).toBe(0);
    // Final state: one thin-wrapper, documentSkipChildren root carrying the packaging kind marker.
    const root = sceneGraph.findNodeById(pkg.id) as MeshGroup3D;
    expect(root.thinWrapper).toBe(true);
    expect(root.documentSkipChildren).toBe(true);
    expect((root as unknown as { worldParams?: { kind?: string } }).worldParams?.kind).toBe('packaging');
    expect(root.children.length).toBeGreaterThan(0);                 // panels built UNDER the announced root (nested)
    let meshCount = 0;
    root.forEachDeep(n => { if (n instanceof Mesh3D) meshCount++; });
    expect(meshCount).toBe(pkg.box.panels.length);                   // every panel mesh lives under the one root
    expect(mgr.isPackageNode(pkg.box.panels[0].meshId)).toBe(pkg.id);
  });
});

describe('Packaging persistence — registry round-trip + re-adoption (bug 2)', () => {
  it('serialize → fresh manager → restoreFromJSON re-binds the EXISTING nodes (getAll / isPackageNode / no new nodes)', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 120, height: 70, depth: 45, bleed: 3 });
    mgr.enterCreatorMode({ packageId: pkg.id });   // links a Dieline layer
    mgr.exitCreatorMode();
    mgr.setFoldAmount(pkg.id, 0.6);
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe(pkg.id);
    expect(persisted[0].dielineLayerId).toBeTruthy();
    expect(persisted[0].panels.length).toBe(6);

    // "Reload": fresh manager, same (restored) nodes + layers.
    const { mgr: mgr2, live: live2 } = reload(sceneGraph, rlm);
    expect(mgr2.getAll().length).toBe(0);
    const before = countNodes(sceneGraph);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    expect(countNodes(sceneGraph)).toBe(before);                      // re-binding only — zero node churn

    const s = mgr2.get(pkg.id)!;
    expect(s).not.toBeNull();
    expect(s.params).toEqual(persisted[0].params);
    expect(s.foldAmount).toBeCloseTo(0.6, 6);
    expect(s.dielineLayerId).toBe(persisted[0].dielineLayerId);
    // isPackageNode resolves root / panels / pivots on the restored package.
    expect(mgr2.isPackageNode(pkg.id)).toBe(pkg.id);
    for (const p of s.box.panels) {
      expect(mgr2.isPackageNode(p.meshId)).toBe(pkg.id);
      expect(mgr2.isPackageNode(p.pivotNodeId)).toBe(pkg.id);
      // Dieline link re-established on the restored panels.
      expect(live2.getLinkedLayerId(p.meshId)).toBe(persisted[0].dielineLayerId);
    }
  });

  it('REGENERATION path (bug 3): a documentSkipChildren marker (panels absent on reload) rebuilds ONE package UNDER the existing root', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 90, height: 60, depth: 40 });
    mgr.enterCreatorMode({ packageId: pkg.id });   // links a Dieline layer
    mgr.exitCreatorMode();
    mgr.setFoldAmount(pkg.id, 0.5);
    // The root is a documentSkipChildren procedural marker (markUnitWrapper mirror sets it).
    const root = sceneGraph.findNodeById(pkg.id) as MeshGroup3D;
    expect(root.thinWrapper).toBe(true);
    expect(root.documentSkipChildren).toBe(true);
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));

    // Simulate the documentSkipChildren save→restore: the marker root survives, but its panel/pivot
    // subtree was NOT serialized — strip the children, keep the (empty) root.
    for (const c of [...root.children]) root.removeChild(c);
    expect(root.children.length).toBe(0);
    const rootCountBefore = sceneGraph.root.children.length;

    const { mgr: mgr2, live: live2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    expect(sceneGraph.root.children.length).toBe(rootCountBefore);     // no duplicate stacked box
    const s = mgr2.get(pkg.id)!;
    expect(s.id).toBe(pkg.id);
    expect(s.box.rootGroupId).toBe(pkg.id);                            // rebuilt UNDER the same root id
    expect(s.box.panels.length).toBe(6);                              // panels regenerated
    expect(s.foldAmount).toBeCloseTo(0.5, 6);                          // persisted fold re-applied
    for (const p of s.box.panels) {
      expect(sceneGraph.findNodeById(p.meshId)).toBeTruthy();          // panels exist again
      expect(mgr2.isPackageNode(p.meshId)).toBe(pkg.id);               // resolve to the ONE package
      expect((sceneGraph.findNodeById(p.meshId)!.parent as MeshGroup3D).id).toBe(p.pivotNodeId);
      expect(live2.getLinkedLayerId(p.meshId)).toBe(persisted[0].dielineLayerId);   // dieline re-linked
    }
    // enterCreatorMode reuses the regenerated box — no duplicate.
    const before = countNodes(sceneGraph);
    const st = mgr2.enterCreatorMode();
    expect(st.packageId).toBe(pkg.id);
    expect(countNodes(sceneGraph)).toBe(before);
  });

  it('restoreFromJSON REPAIRS panel meshes the document restore left at the scene root (two-deep nesting gap)', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage();
    const persisted = mgr.serialize();

    // Simulate the restore gap: panel meshes re-created at the ROOT, not under their pivots.
    for (const p of pkg.box.panels) {
      const mesh = sceneGraph.findNodeById(p.meshId)!;
      mesh.parent?.removeChild(mesh);
      sceneGraph.root.addChild(mesh);
      expect(mesh.parent).toBe(sceneGraph.root);
    }

    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    for (const p of mgr2.get(pkg.id)!.box.panels) {
      const mesh = sceneGraph.findNodeById(p.meshId)!;
      expect((mesh.parent as MeshGroup3D).id).toBe(p.pivotNodeId);    // back under its hinge pivot
    }
  });

  it('enterCreatorMode on a restored package reuses it — no duplicate box, fold/dims drive the restored nodes', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    mgr.enterCreatorMode({ packageId: pkg.id });
    mgr.exitCreatorMode();
    const persisted = mgr.serialize();

    const { mgr: mgr2, armed } = reload(sceneGraph, rlm);
    mgr2.restoreFromJSON(persisted);
    const before = countNodes(sceneGraph);
    const st = mgr2.enterCreatorMode();                                // NO packageId — the duplicate-box path
    expect(st.packageId).toBe(pkg.id);                                 // reused the restored box
    expect(countNodes(sceneGraph)).toBe(before);                       // NO second box created
    expect(mgr2.getAll().length).toBe(1);
    expect(armed.length).toBe(1);                                      // paint armed on the restored panels

    // Fold + re-dimension operate on the restored hierarchy (in-place fast path keeps ids).
    const resized = mgr2.setDimensions(pkg.id, { width: 100, height: 50, depth: 30 });
    expect(resized).not.toBeNull();
    expect(resized!.id).toBe(pkg.id);
    mgr2.setFoldAmount(pkg.id, 1);
    expect(mgr2.get(pkg.id)!.foldAmount).toBe(1);
  });

  it('DEFENSIVE DEDUPE: enterCreatorMode adopts an ORPHANED package root (no persisted entry) instead of creating a second box', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage();                                      // creates the node structure

    // Orphan it: fresh manager (empty registry), nodes still in the scene, NO restoreFromJSON.
    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.getAll().length).toBe(0);
    const rootsBefore = sceneGraph.root.children.length;
    const st = mgr2.enterCreatorMode();
    expect(st.packageId).toBe(pkg.id);                                 // adopted the orphan
    expect(sceneGraph.root.children.length).toBe(rootsBefore);         // no overlapping second box
    expect(mgr2.getAll().length).toBe(1);
    expect(mgr2.isPackageNode(pkg.box.panels[0].meshId)).toBe(pkg.id);
  });

  it('restoreFromJSON recovers from PANEL ID DRIFT via structural name matching, drops entries whose root is gone, and is idempotent', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage();
    const persisted = mgr.serialize();

    // Corrupt every persisted panel id (simulated id drift) — structure matching must recover.
    const drifted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(persisted));
    for (const p of drifted[0].panels) { p.meshId = 'gone-' + p.meshId; p.pivotNodeId = 'gone-' + p.pivotNodeId; }
    // Plus one entry whose root no longer exists — must be skipped, not throw.
    drifted.push({ ...JSON.parse(JSON.stringify(persisted[0])), id: 'no-such-root' });

    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromJSON(drifted)).toBe(1);
    const s = mgr2.get(pkg.id)!;
    expect(s).not.toBeNull();
    const realPanelIds = new Set(pkg.box.panels.map(p => p.meshId));
    for (const p of s.box.panels) expect(realPanelIds.has(p.meshId)).toBe(true);   // re-bound to the REAL nodes

    // Idempotent: adopting again is a no-op (already live).
    expect(mgr2.restoreFromJSON(drifted)).toBe(0);
    expect(mgr2.getAll().length).toBe(1);
  });

  // ── Round B styles: the same round-trip for rollEndMailer (M4) and rigidTwoPiece (M5) ──
  for (const [style, params, panelCount] of [
    ['rollEndMailer', { width: 80, height: 60, depth: 40, lockTabs: true, restOpenAmount: 0.2 }, 11],
    ['rigidTwoPiece', { width: 80, height: 60, depth: 40, lidDepth: 15, boardThickness: 3 }, 10],
  ] as const) {
    it(`${style}: serialize → reload → restoreFromJSON re-binds style + params + panels (no node churn), fold drives`, () => {
      const { sceneGraph, rlm, mgr } = setup();
      const pkg = mgr.addPackage({ ...params }, style);
      mgr.setFoldAmount(pkg.id, 0.5);
      const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));
      expect(persisted[0].style).toBe(style);
      expect(persisted[0].params).toEqual(params);
      expect(persisted[0].panels.length).toBe(panelCount);

      const { mgr: mgr2 } = reload(sceneGraph, rlm);
      const before = countNodes(sceneGraph);
      expect(mgr2.restoreFromJSON(persisted)).toBe(1);
      expect(countNodes(sceneGraph)).toBe(before);                    // re-binding only — zero node churn

      const s = mgr2.get(pkg.id)!;
      expect(s.style).toBe(style);
      expect(s.params).toEqual(params);
      expect(s.foldAmount).toBeCloseTo(0.5, 6);
      expect(s.box.panels.length).toBe(panelCount);
      // Unit select spans everything (both rigidTwoPiece trays included).
      for (const p of s.box.panels) expect(mgr2.isPackageNode(p.meshId)).toBe(pkg.id);
      // Fold + re-dimension drive the restored hierarchy (dims-only → in-place: same package id).
      mgr2.setFoldAmount(pkg.id, 1);
      expect(mgr2.get(pkg.id)!.foldAmount).toBe(1);
      const resized = mgr2.setDimensions(pkg.id, { ...params, width: 100 });
      expect(resized!.id).toBe(pkg.id);
    });
  }
});

describe('Packaging SELF-DESCRIBING marker — worldParams round-trip + restoreFromSave (Building pattern)', () => {
  /** Read a root node's stamped worldParams marker. */
  const markerOf = (sceneGraph: SceneGraph, id: string): PackagingMarker | undefined =>
    (sceneGraph.findNodeById(id) as unknown as { worldParams?: PackagingMarker } | null)?.worldParams;

  /** Simulate the documentSkipChildren save→restore: JSON round-trip the root's worldParams (as it
   *  would ride through sceneGraphJSON) and strip the panel subtree the skip-children save omits. */
  function simulateSkipChildrenReload(sceneGraph: SceneGraph, rootId: string): void {
    const root = sceneGraph.findNodeById(rootId) as MeshGroup3D;
    const wp = JSON.parse(JSON.stringify((root as unknown as { worldParams: unknown }).worldParams));
    (root as unknown as { worldParams: unknown }).worldParams = wp;   // survives as parsed JSON, not the live object
    for (const c of [...root.children]) root.removeChild(c);
  }

  it('(a) addPackage STAMPS worldParams { kind, entry } with style + params + foldAmount + panels', () => {
    const { sceneGraph, mgr } = setup();
    const pkg = mgr.addPackage({ width: 120, height: 70, depth: 45, bleed: 3 });
    const wp = markerOf(sceneGraph, pkg.id)!;
    expect(wp.kind).toBe('packaging');
    expect(wp.entry).toBeTruthy();
    expect(wp.entry!.id).toBe(pkg.id);
    expect(wp.entry!.style).toBe('simpleBox');
    expect(wp.entry!.params).toEqual({ width: 120, height: 70, depth: 45, bleed: 3 });
    expect(wp.entry!.foldAmount).toBe(1);              // addPackage closes the box
    expect(wp.entry!.panels.length).toBe(6);
  });

  it('(b,c) restoreFromSave re-adopts from the MARKER ALONE — no scene3dJSON packaging array (getAll/isPackageNode work)', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 90, height: 60, depth: 40 });
    mgr.enterCreatorMode({ packageId: pkg.id });        // links a Dieline layer (rides in the marker entry)
    mgr.exitCreatorMode();
    mgr.setFoldAmount(pkg.id, 0.5);
    const dielineLayerId = markerOf(sceneGraph, pkg.id)!.entry!.dielineLayerId;
    expect(dielineLayerId).toBeTruthy();

    simulateSkipChildrenReload(sceneGraph, pkg.id);

    // Fresh manager. NO restoreFromJSON, NO packaging array — only the scene marker.
    const { mgr: mgr2, live: live2 } = reload(sceneGraph, rlm);
    expect(mgr2.getAll().length).toBe(0);
    expect(mgr2.restoreFromSave()).toBe(1);

    const s = mgr2.get(pkg.id)!;
    expect(s.id).toBe(pkg.id);
    expect(s.style).toBe('simpleBox');
    expect(s.params).toEqual({ width: 90, height: 60, depth: 40 });
    expect(s.foldAmount).toBeCloseTo(0.5, 6);
    expect(s.box.panels.length).toBe(6);
    expect(mgr2.getAll().length).toBe(1);
    expect(mgr2.isPackageNode(pkg.id)).toBe(pkg.id);
    for (const p of s.box.panels) {
      expect(mgr2.isPackageNode(p.meshId)).toBe(pkg.id);              // panels resolve to the package
      expect((sceneGraph.findNodeById(p.meshId)!.parent as MeshGroup3D).id).toBe(p.pivotNodeId);
      expect(live2.getLinkedLayerId(p.meshId)).toBe(dielineLayerId);  // dieline re-linked from the marker
    }
  });

  it('(d) restoreFromSave is IDEMPOTENT — twice = one package; and safe after/around restoreFromJSON (no dupes)', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));
    simulateSkipChildrenReload(sceneGraph, pkg.id);

    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromSave()).toBe(1);
    expect(mgr2.restoreFromSave()).toBe(0);             // second scan adopts nothing (already live)
    expect(mgr2.getAll().length).toBe(1);
    // The legacy array path finds it already registered → no double-adoption.
    expect(mgr2.restoreFromJSON(persisted)).toBe(0);
    expect(mgr2.getAll().length).toBe(1);
  });

  it('(d2) restoreFromSave after restoreFromJSON adopts NOTHING (both mechanisms, one package)', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));
    simulateSkipChildrenReload(sceneGraph, pkg.id);

    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);    // array path adopts first
    expect(mgr2.restoreFromSave()).toBe(0);             // marker path finds it already live
    expect(mgr2.getAll().length).toBe(1);
  });

  it('(e) the marker RE-STAMPS on setDimensions (in place) and setStyle (rebuild); a reload from the fresh marker rebuilds the new style', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });

    // In-place re-dimension keeps the id → same root, refreshed entry.
    mgr.setDimensions(pkg.id, { width: 111, height: 60, depth: 40 });
    expect(markerOf(sceneGraph, pkg.id)!.entry!.params.width).toBe(111);

    // setStyle is a topology REBUILD → the id changes; the marker lands on the NEW root.
    const st = mgr.setStyle(pkg.id, 'tuckEnd')!;
    expect(markerOf(sceneGraph, st.id)!.entry!.style).toBe('tuckEnd');
    expect(markerOf(sceneGraph, st.id)!.entry!.id).toBe(st.id);

    // Reload from that fresh marker alone → the tuckEnd box (new params) comes back.
    simulateSkipChildrenReload(sceneGraph, st.id);
    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromSave()).toBe(1);
    const s = mgr2.get(st.id)!;
    expect(s.style).toBe('tuckEnd');
    expect(s.params.width).toBe(111);
  });

  it('(j) enter creator mode FLATTENS the target rotation to 0, isolates the whole scene, and restores both on exit', () => {
    const { sceneGraph, mgr } = setup();
    const a = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    // The user placed/rotated the package in the scene.
    (sceneGraph.findNodeById(a.id) as MeshGroup3D).rotationX = 0.5;
    (sceneGraph.findNodeById(a.id) as MeshGroup3D).rotationY = 0.9;
    (sceneGraph.findNodeById(a.id) as MeshGroup3D).rotation = 0.3;
    // A second, unrelated scene object (a raw mesh) that must be HIDDEN while editing A.
    const other = new Mesh3D(isvc, 0, 0, 0, {}); other.name = 'Cube'; sceneGraph.root.addChild(other);

    mgr.enterCreatorMode({ packageId: a.id });
    const root = sceneGraph.findNodeById(a.id) as MeshGroup3D;
    expect(root.rotationX).toBe(0); expect(root.rotationY).toBe(0); expect(root.rotation).toBe(0);  // laid flat
    expect(other.visible).toBe(false);                                  // everything else hidden
    expect(root.visible).toBe(true);                                    // the edited box stays visible
    // A save WHILE in the mode persists the user's REAL rotation, not the transient zero.
    const entry = mgr.serialize().find(e => e.id === a.id)!;
    expect(entry.transform).toBeTruthy();
    expect(entry.transform!.rotationX).toBeCloseTo(0.5, 9);
    expect(entry.transform!.rotationY).toBeCloseTo(0.9, 9);
    expect(entry.transform!.rotation).toBeCloseTo(0.3, 9);

    mgr.exitCreatorMode();
    expect(root.rotationX).toBeCloseTo(0.5, 9);                         // rotation restored
    expect(root.rotationY).toBeCloseTo(0.9, 9);
    expect(root.rotation).toBeCloseTo(0.3, 9);
    expect(other.visible).toBe(true);                                   // other objects visible again
  });

  it('(f) reloaded root gets a NEW id — restoreFromSave adopts via the SCANNED root id, not the stale entry.id', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    const oldId = pkg.id;
    simulateSkipChildrenReload(sceneGraph, oldId);
    // Reproduce the real bug: the documentSkipChildren toJSON used to DROP the id, so the restored
    // marker root gets a FRESH node id while its worldParams `entry` still carries the pre-reload id.
    (sceneGraph.findNodeById(oldId) as MeshGroup3D).setId('reloaded-fresh-id');
    expect(markerOf(sceneGraph, 'reloaded-fresh-id')!.entry!.id).toBe(oldId);   // entry.id is now STALE

    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromSave()).toBe(1);                    // adopted DESPITE the id mismatch
    expect(mgr2.getAll().length).toBe(1);
    const s = mgr2.getAll()[0];
    expect(s.id).toBe('reloaded-fresh-id');                    // registered under the LIVE root id
    expect(mgr2.isPackageNode('reloaded-fresh-id')).toBe('reloaded-fresh-id');
    expect(mgr2.isPackageNode(oldId)).toBeNull();              // the stale id resolves to nothing
    for (const p of s.box.panels) expect(mgr2.isPackageNode(p.meshId)).toBe('reloaded-fresh-id');
  });

  // ── ROOT TRANSFORM persistence (position/rotation/scale) — the reset-to-origin-on-reload fix ──
  /** Simulate a whole-box GIZMO DRAG: mutate the root node directly (touches NO packaging API). */
  function dragRoot(sceneGraph: SceneGraph, id: string, t: { x: number; y: number; z: number; rx: number; ry: number; rz: number; s: number }): void {
    const root = sceneGraph.findNodeById(id) as MeshGroup3D;
    root.setXYZ(t.x, t.y, t.z);
    root.rotationX = t.rx; root.rotationY = t.ry; root.rotation = t.rz;
    root.scaleX = t.s; root.scaleY = t.s; root.scaleZ = t.s;
  }
  /** Reproduce recreateNode's '3DMeshGroup' branch: a restored marker root comes back at the origin. */
  function resetRootToOrigin(sceneGraph: SceneGraph, id: string): void {
    dragRoot(sceneGraph, id, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 });
  }
  function expectRootTransform(sceneGraph: SceneGraph, id: string, t: { x: number; y: number; z: number; rx: number; ry: number; rz: number; s: number }): void {
    const r = sceneGraph.findNodeById(id) as MeshGroup3D;
    expect(r.x).toBeCloseTo(t.x, 6); expect(r.y).toBeCloseTo(t.y, 6); expect(r.z).toBeCloseTo(t.z, 6);
    expect(r.rotationX).toBeCloseTo(t.rx, 6); expect(r.rotationY).toBeCloseTo(t.ry, 6); expect(r.rotation).toBeCloseTo(t.rz, 6);
    expect(r.scaleX).toBeCloseTo(t.s, 6); expect(r.scaleY).toBeCloseTo(t.s, 6); expect(r.scaleZ).toBeCloseTo(t.s, 6);
  }

  it('(g) a moved/rotated/scaled root round-trips through serialize → restoreFromJSON (fold survives alongside)', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    const T = { x: 12, y: 3, z: -7, rx: 0.4, ry: -0.9, rz: 0.15, s: 2 };
    dragRoot(sceneGraph, pkg.id, T);
    mgr.setFoldAmount(pkg.id, 0.5);

    // serialize() reads the LIVE node transform (the fix), so a bare gizmo drag is captured at save.
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));
    expect(persisted[0].transform).toBeTruthy();
    expect(persisted[0].transform!.x).toBeCloseTo(12, 6);
    expect(persisted[0].transform!.rotationY).toBeCloseTo(-0.9, 6);
    expect(persisted[0].transform!.scaleX).toBeCloseTo(2, 6);
    expect(persisted[0].foldAmount).toBeCloseTo(0.5, 6);   // fold persists ALONGSIDE the transform

    resetRootToOrigin(sceneGraph, pkg.id);                 // recreateNode drops a MeshGroup marker's transform
    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    expectRootTransform(sceneGraph, pkg.id, T);            // re-applied on restore
    expect(mgr2.get(pkg.id)!.foldAmount).toBeCloseTo(0.5, 6);
  });

  it('(h) transform round-trips through the self-describing MARKER → restoreFromSave (regeneration path)', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    const T = { x: -5, y: 1, z: 8, rx: 0, ry: 1.2, rz: 0, s: 0.5 };
    dragRoot(sceneGraph, pkg.id, T);
    mgr.setFoldAmount(pkg.id, 0.7);   // a later interaction re-stamps the marker with the LIVE transform + fold
    expect(markerOf(sceneGraph, pkg.id)!.entry!.transform!.x).toBeCloseTo(-5, 6);

    simulateSkipChildrenReload(sceneGraph, pkg.id);        // marker rides worldParams; panels stripped
    resetRootToOrigin(sceneGraph, pkg.id);                 // ...and the root comes back at the origin

    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromSave()).toBe(1);
    expectRootTransform(sceneGraph, pkg.id, T);            // re-applied from the marker alone
    expect(mgr2.get(pkg.id)!.foldAmount).toBeCloseTo(0.7, 6);
  });

  it('(i) an UNMOVED package carries no transform field (back-compat) and restore is a no-op', () => {
    const { sceneGraph, rlm, mgr } = setup();
    const pkg = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));
    expect(persisted[0].transform).toBeUndefined();       // identity → omitted (small entries, older-save parity)
    const { mgr: mgr2 } = reload(sceneGraph, rlm);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    expectRootTransform(sceneGraph, pkg.id, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 });
  });
});

describe('Packaging creator-mode isolation — orphan strays never share the stage', () => {
  /** A package-shaped root the manager does NOT know about, with a topology matching NO template
   *  (2 hinge-panels): `findOrphanPackageRoots` still flags it as a candidate, but
   *  `_adoptStructural` rejects it for every template — so it must be left UNREGISTERED + UNMODIFIED
   *  (never mangled), while the isolation pass still hides it while the mode is active. */
  function buildMalformedOrphan(sceneGraph: SceneGraph): { rootId: string; panelIds: string[] } {
    const root = new MeshGroup3D(isvc);
    root.name = 'Package';
    sceneGraph.root.addChild(root);
    const panelIds: string[] = [];
    for (let i = 0; i < 2; i++) {                        // 2 panels — matches no template's panel count
      const hinge = new MeshGroup3D(isvc);
      hinge.name = `Weird${i} Hinge`;
      root.addChild(hinge);
      const mesh = new Mesh3D(isvc, 0, 0, 0, {});
      mesh.name = `Weird${i}`;
      hinge.addChild(mesh);
      panelIds.push(mesh.id);
    }
    return { rootId: root.id, panelIds };
  }

  it('registered A + unregistered stray O: entering on A adopts + HIDES O; exit restores O', () => {
    const { sceneGraph, rlm, live, mgr } = setup();
    const a = mgr.addPackage({ width: 80, height: 60, depth: 40 });   // A registered in `mgr`

    // Build O as a raw in-scene stray: a SEPARATE throwaway manager over the SAME scene creates a
    // genuine box structure, but `mgr` never learns about it — exactly a duplicate-era leftover
    // baked into the document that the live manager's registry has no record of.
    const stray = new PackagingManager(makeHost(sceneGraph, rlm, live).host);
    const o = stray.addPackage({ width: 100, height: 50, depth: 30 });
    expect(mgr.isPackageNode(o.id)).toBeNull();            // `mgr` doesn't know O
    const oRoot = sceneGraph.findNodeById(o.box.rootGroupId)!;
    expect(oRoot.visible).toBe(true);

    // Enter targeting A: the up-front adopt-all-orphans sweep adopts O, then isolation hides it.
    const st = mgr.enterCreatorMode({ packageId: a.id });
    expect(st.packageId).toBe(a.id);
    expect(mgr.getAll().length).toBe(2);                   // O adopted into the registry
    expect(mgr.isPackageNode(o.box.panels[0].meshId)).toBe(o.id);   // its panels resolve now
    expect(oRoot.visible).toBe(false);                     // NOT sharing the stage with A
    expect(sceneGraph.findNodeById(a.box.rootGroupId)!.visible).toBe(true);

    mgr.exitCreatorMode();
    expect(oRoot.visible).toBe(true);                      // restored to prior visibility
  });

  it('malformed candidate (matches no template): skipped by adoption, still HIDDEN in mode, not mangled, restored on exit', () => {
    const { sceneGraph, mgr } = setup();
    const a = mgr.addPackage();
    const orphan = buildMalformedOrphan(sceneGraph);
    const oRoot = sceneGraph.findNodeById(orphan.rootId)!;
    const childCountBefore = oRoot.children.length;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const st = mgr.enterCreatorMode({ packageId: a.id });
    expect(st.packageId).toBe(a.id);
    expect(mgr.getAll().length).toBe(1);                   // NOT adopted (topology mismatch) — only A
    expect(mgr.isPackageNode(orphan.panelIds[0])).toBeNull();
    expect(warn).toHaveBeenCalled();                       // warned about the unadoptable candidate
    expect(oRoot.children.length).toBe(childCountBefore);  // structure untouched — not mangled
    expect(oRoot.visible).toBe(false);                     // defensive isolation pass hid it anyway

    mgr.exitCreatorMode();
    expect(oRoot.visible).toBe(true);                      // restored
    warn.mockRestore();
  });
});
