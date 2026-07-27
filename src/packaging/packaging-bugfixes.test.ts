/**
 * src/packaging/packaging-bugfixes.test.ts — the five Package-Creator UX bug fixes, exercised
 * through adapter-mirror hosts (the ShapeManager hooks, mirrored hook-for-hook):
 *
 *   BUG 1  addPackage / rebuild fire exactly ONE scene-graph-changed at the END of assembly,
 *          carrying the fully thin-wrapper-marked tree (the "invisible until next mesh" fix).
 *   BUG 2  the unit-wrapper selection/gizmo bounds track the CURRENT fold pose (tight), not the
 *          whole-fold-range net UNION — at fold 1 they match the closed W×H×D box, not the net.
 *   BUG 3  in creator mode a pick on the target package is suppressed UNCONDITIONALLY — any
 *          modifier, and even while a vector 'place' layer is active (alt-orbit no longer selects).
 *   BUG 4  the tuck-end choreography folds SMALL flaps (dust) fully before the LARGE closure, and
 *          the tongue tucks last; roll-end stages its small locks before the large lid.
 *   BUG 5  a LEGACY reload (panels serialized as loose '<Name> Hinge' nodes at the scene root)
 *          collapses to exactly ONE 'Package' — the loose leftovers are pruned.
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
import type { InteractionService } from '../services/interaction-service';
import { PackagingManager, type PackagingHost, type PackagingPersistEntry } from './packaging-manager';
import { TUCK_SEQUENCE, ROLL_SEQUENCE } from './mechanisms';
import { computeFoldWorldCorners } from './box-hierarchy';
import { tuckEnd } from './templates/tuck-end';
import { expectNoInterpenetration } from './test-utils';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
type Bounds = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };

/**
 * A host over REAL scene nodes that mirrors the ShapeManager adapter's emit semantics: createGroup /
 * createPanelMesh / markUnitWrapper(flip) / notify all call `emit()`, which DEFERS while a scene-graph
 * batch is open (exactly emitSceneGraphChanged's `_sceneGraphBatchDepth` behaviour) and fires the one
 * real emit at endSceneGraphBatch. Records every emit + the latest bounds handed to markUnitWrapper.
 */
function makeHost() {
  const sceneGraph = new SceneGraph();
  const bounds = new Map<string, Bounds | undefined>();
  const live = new Map<string, string>();       // meshId → layerId
  let batchDepth = 0, pending = false, emits = 0;
  let wrapperMarkedAtLastEmit = true;
  let lyr = 0;

  const emit = (): void => {
    if (batchDepth > 0) { pending = true; return; }   // deferred (mirror emitSceneGraphChanged)
    emits++;
    // Every top-level MeshGroup3D that looks like a package root is a thin-wrapper at emit time?
    wrapperMarkedAtLastEmit = sceneGraph.root.children.every(
      c => !(c instanceof MeshGroup3D) || c.name !== 'Package' || (c.thinWrapper && c.documentSkipChildren),
    );
  };

  const host: PackagingHost = {
    createGroup: (name, parentNodeId, scale) => {
      const grp = new MeshGroup3D(isvc); grp.name = name;
      if (scale !== undefined) { grp.scaleX = grp.scaleY = grp.scaleZ = scale; }
      const parent = (parentNodeId ? sceneGraph.findNodeById(parentNodeId) : null) ?? sceneGraph.root;
      parent.addChild(grp);
      emit(); return grp.id;
    },
    createPanelMesh: (geom, parentNodeId, name) => {
      const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: geom, material: { doubleSided: true, texOverBase: true } });
      m.name = name;
      (sceneGraph.findNodeById(parentNodeId) ?? sceneGraph.root).addChild(m);
      emit(); return m.id;
    },
    setNodeTransform: () => {},
    setPanelGeometry: (meshId, geom) => { const n = sceneGraph.findNodeById(meshId); if (n instanceof Mesh3D) n.setGeometry(geom); },
    removeNode: (id) => { const n = sceneGraph.findNodeById(id); n?.parent?.removeChild(n); emit(); },
    linkLiveTexture: (id, layerId) => { live.set(id, layerId); },
    unlinkLiveTexture: (id) => { live.delete(id); },
    exportLayerPng: async () => null,
    scheduleRender: () => {},
    setDocSize: () => {},
    ensureDielineLayer: (existing) => existing ?? `layer-${lyr++}`,
    ensureDielineLayerInfo: (existing) => existing ? { layerId: existing, fresh: false } : { layerId: `layer-${lyr++}`, fresh: true },
    frameAndOrbit: () => {},
    stopOrbit: () => {},
    armSurfacePaint: () => true,
    disarmSurfacePaint: () => {},
    nodeExists: (id) => !!sceneGraph.findNodeById(id),
    markUnitWrapper: (rootNodeId, localBounds) => {
      const n = sceneGraph.findNodeById(rootNodeId);
      if (!(n instanceof MeshGroup3D)) return;
      if (localBounds) { bounds.set(rootNodeId, localBounds); n.cachedBounds = localBounds; }
      if (!n.thinWrapper || !n.documentSkipChildren) { n.thinWrapper = true; n.documentSkipChildren = true; emit(); }
    },
    notifySceneGraphChanged: () => emit(),
    beginSceneGraphBatch: () => { batchDepth++; },
    endSceneGraphBatch: () => { if (batchDepth > 0) batchDepth--; if (batchDepth === 0 && pending) { pending = false; emit(); } },
    reparentNode: (childId, parentId) => {
      const child = sceneGraph.findNodeById(childId), parent = sceneGraph.findNodeById(parentId);
      if (!child || !parent || child.parent === parent) return;
      child.parent?.removeChild(child); (parent as MeshGroup3D).addChild(child);
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
            let hinge = 0;
            c.forEachDeep(d => { if (d instanceof MeshGroup3D && typeof d.name === 'string' && d.name.endsWith(' Hinge') && (d.children ?? []).some(x => x instanceof Mesh3D)) hinge++; });
            if (hinge > 0) { found.push(c.id); continue; }
          }
          scan(c as { children?: unknown[] });
        }
      };
      scan(sceneGraph.root as unknown as { children?: unknown[] });
      return found;
    },
    pruneLoosePackageNodes: (keepIds) => {
      const keep = new Set(keepIds);
      const doomed: (MeshGroup3D | Mesh3D)[] = [];
      for (const c of [...sceneGraph.root.children]) {
        const isLoosePivot = c instanceof MeshGroup3D && !keep.has(c.id) &&
          typeof c.name === 'string' && c.name.endsWith(' Hinge') &&
          (c.children ?? []).some(x => x instanceof Mesh3D);
        const isLoosePanel = c instanceof Mesh3D && !keep.has(c.id) &&
          (c.material as { texOverBase?: boolean } | undefined)?.texOverBase === true;
        if (isLoosePivot || isLoosePanel) doomed.push(c);
      }
      for (const n of doomed) { n.parent?.removeChild(n); emit(); }
      return doomed.length;
    },
  };
  return {
    host, sceneGraph, bounds, live,
    getEmits: () => emits,
    wrapperMarkedAtLastEmit: () => wrapperMarkedAtLastEmit,
    topLevelHinges: () => sceneGraph.root.children.filter(c => c instanceof MeshGroup3D && (c.name as string).endsWith(' Hinge')).length,
    topLevelPanels: () => sceneGraph.root.children.filter(c => c instanceof Mesh3D && (c.material as { texOverBase?: boolean } | undefined)?.texOverBase === true).length,
    packageRoots: () => sceneGraph.root.children.filter(c => c instanceof MeshGroup3D && c.name === 'Package').length,
  };
}

const MM = 0.02;

describe('BUG 1 — addPackage / rebuild announce the package with ONE final emit', () => {
  it('addPackage fires exactly ONE scene-graph-changed, and the tree is thin-wrapper-marked at that emit', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const before = h.getEmits();
    const s = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    expect(h.getEmits() - before).toBe(1);                 // the burst coalesced — not 15 emits, exactly 1
    expect(h.wrapperMarkedAtLastEmit()).toBe(true);        // the single emit carries the MARKED tree (not partial)
    // And it really is one collapsed unit: root is thinWrapper + documentSkipChildren.
    const root = h.sceneGraph.findNodeById(s.id) as MeshGroup3D;
    expect(root.thinWrapper).toBe(true);
    expect(root.documentSkipChildren).toBe(true);
  });

  it('a second addPackage announces itself too (no "invisible until the next mesh")', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    mgr.addPackage();
    const mid = h.getEmits();
    mgr.addPackage({ width: 120, height: 90, depth: 50 });
    expect(h.getEmits() - mid).toBe(1);
  });

  it('a dimension REBUILD (topology change) also coalesces to one emit', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const s = mgr.addPackage({ width: 80, height: 60, depth: 40 }, 'tuckEnd');
    const before = h.getEmits();
    mgr.setDimensions(s.id, { width: 80, height: 60, depth: 40, tuckStyle: 'straight' });   // topology flip → _rebuild
    expect(h.getEmits() - before).toBe(1);
  });
});

describe('BUG 2 — selection/gizmo bounds track the fold POSE, not the net union', () => {
  it('at fold 1 the bounds match the closed W×H×D box, and are far smaller than the flat net', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const s = mgr.addPackage({ width: 80, height: 60, depth: 40 });   // simpleBox
    mgr.setFoldAmount(s.id, 0);                                        // addPackage now defaults CLOSED → flatten to read the net pose
    const flat = h.bounds.get(s.id)!;
    // Flat net is wide: netW = W + 2H = 200 mm → ~4.0 world units across.
    expect(flat.maxX - flat.minX).toBeGreaterThan(180 * MM);

    mgr.setFoldAmount(s.id, 1);
    const closed = h.bounds.get(s.id)!;
    // Closed box: x∈[−40,40], y∈[0,60], z∈[−20,20] mm × 0.02.
    expect(closed.maxX - closed.minX).toBeCloseTo(80 * MM, 6);
    expect(closed.maxY - closed.minY).toBeCloseTo(60 * MM, 6);
    expect(closed.maxZ - closed.minZ).toBeCloseTo(40 * MM, 6);
    // The whole point: the folded selection box is a fraction of the flat-net box (no blowup).
    expect(closed.maxX - closed.minX).toBeLessThan((flat.maxX - flat.minX) * 0.5);
  });

  it('bounds refresh on every fold scrub AND on re-dimension', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const s = mgr.addPackage({ width: 80, height: 60, depth: 40 });
    mgr.setFoldAmount(s.id, 1);
    const w80 = h.bounds.get(s.id)!.maxX - h.bounds.get(s.id)!.minX;
    expect(w80).toBeCloseTo(80 * MM, 6);
    mgr.setDimensions(s.id, { width: 120, height: 60, depth: 40 });   // dims-only fast path, still folded
    const w120 = h.bounds.get(s.id)!.maxX - h.bounds.get(s.id)!.minX;
    expect(w120).toBeCloseTo(120 * MM, 6);                            // tracked the new width at the CURRENT pose
  });
});

describe('BUG 3 — creator-mode pick suppression is unconditional for the target', () => {
  it('suppresses the target package (root/pivot/mesh) and lifts on exit; other packages are not the target', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const a = mgr.addPackage();
    const b = mgr.addPackage({ width: 120, height: 90, depth: 50 });
    expect(mgr.isPickSuppressed(b.box.panels[0].meshId)).toBe(false);   // not in mode yet

    mgr.enterCreatorMode({ packageId: b.id });
    expect(mgr.isPickSuppressed(b.id)).toBe(true);                      // root
    expect(mgr.isPickSuppressed(b.box.panels[2].meshId)).toBe(true);    // panel mesh
    expect(mgr.isPickSuppressed(b.box.panels[4].pivotNodeId)).toBe(true); // hinge pivot
    expect(mgr.isPickSuppressed(a.box.panels[0].meshId)).toBe(false);   // the OTHER package is not the target
    expect(mgr.isPickSuppressed('not-a-node')).toBe(false);

    mgr.exitCreatorMode();
    expect(mgr.isPickSuppressed(b.box.panels[0].meshId)).toBe(false);   // click-select restored on exit
  });

  it('stays suppressed even in vector PLACE mode (paintable false) — the alt-orbit-selects fix', () => {
    const h = makeHost();
    // Minimal layer-stack host so a vector layer can go active (isActivePaintable → false).
    const stack = new Map<string, { name: string; visible: boolean; opacity: number; kind: 'raster' | 'vector' }>();
    let n = 0;
    h.host.stack = {
      addRasterLayer: (_p, name) => { const id = `r${n++}`; stack.set(id, { name, visible: true, opacity: 1, kind: 'raster' }); return id; },
      addVectorLayer: (_p, name) => { const id = `v${n++}`; stack.set(id, { name, visible: true, opacity: 1, kind: 'vector' }); return id; },
      adopt: () => {}, info: (id) => stack.get(id) ?? null, setVisible: () => {}, setOpacity: () => {},
      rename: () => {}, remove: (id) => stack.delete(id), linkComposite: () => {}, unlinkComposite: () => {},
      recomposite: () => {}, exportPng: async () => null,
    };
    const mgr = new PackagingManager(h.host);
    const pkg = mgr.addPackage();
    mgr.enterCreatorMode({ packageId: pkg.id });
    const v = mgr.addVectorLayer(pkg.id)!;                               // place mode
    mgr.setActiveLayer(pkg.id, v.layerId);
    expect(mgr.isActivePaintable()).toBe(false);                        // vector active = not painting
    // Old bug: suppression lifted here → an alt-orbit click SELECTED the box. Now it stays suppressed.
    expect(mgr.isPickSuppressed(pkg.box.panels[0].meshId)).toBe(true);
  });
});

describe('BUG 4 — small-first fold choreography', () => {
  it('tuck-end: walls → dust (small) → tongue (pre-curl) → closure (large, last), each stage clear of the next', () => {
    // Walls wrap, then the small dust flaps, then the tongue PRE-CURLS before the large lid closes
    // over it last (user preference — the tongue folds before the tuck, how the box closes by hand).
    expect(TUCK_SEQUENCE.walls[1]).toBeLessThanOrEqual(TUCK_SEQUENCE.dust[0]);
    expect(TUCK_SEQUENCE.dust[1]).toBeLessThanOrEqual(TUCK_SEQUENCE.tongue[0]);
    expect(TUCK_SEQUENCE.tongue[1]).toBeLessThanOrEqual(TUCK_SEQUENCE.closure[0]);
    expect(TUCK_SEQUENCE.closure[1]).toBe(1);                           // the lid closes LAST
  });

  it('roll-end: small corner locks finish before the large lid; the lip tucks last', () => {
    expect(ROLL_SEQUENCE.lock[1]).toBeLessThanOrEqual(ROLL_SEQUENCE.lid[0]);   // small locks fully before the large lid
    expect(ROLL_SEQUENCE.lip[1]).toBeGreaterThan(ROLL_SEQUENCE.lid[1]);        // the lip finishes AFTER the lid (tucks last)
    expect(ROLL_SEQUENCE.lip[1]).toBe(1);
  });

  it('the retuned tuck-end windows keep every fold pose interpenetration-free', () => {
    const { foldMeshData } = tuckEnd({ width: 90, height: 60, depth: 45 });
    for (const t of [0, 0.3, 0.45, 0.55, 0.6, 0.7, 0.82, 0.9, 1]) {
      const corners = computeFoldWorldCorners(foldMeshData.panels, t);
      expectNoInterpenetration(corners, foldMeshData.panels, `tuckEnd@${t}`);
    }
  });
});

describe('BUG 5 — legacy reload collapses loose panels to one Package', () => {
  it('post-fix save→reload: one thin-wrapper Package, panels regenerated under it, no loose siblings', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const pkg = mgr.addPackage({ width: 90, height: 60, depth: 40 });
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));
    // documentSkipChildren save: the marker root survives, panels were NOT serialized.
    const root = h.sceneGraph.findNodeById(pkg.id) as MeshGroup3D;
    for (const c of [...root.children]) root.removeChild(c);

    const h2 = { ...h };   // same scene graph, fresh manager
    const mgr2 = new PackagingManager(h.host);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    expect(h2.packageRoots()).toBe(1);
    expect(h2.topLevelHinges()).toBe(0);                               // panels are UNDER the Package, none loose
    const s = mgr2.get(pkg.id)!;
    expect(s.box.panels.length).toBe(6);
    for (const p of s.box.panels) expect(mgr2.isPackageNode(p.meshId)).toBe(pkg.id);
  });

  it('legacy save (panels serialized as LOOSE "<Name> Hinge" nodes at root) → reload prunes them to one Package', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const pkg = mgr.addPackage({ width: 90, height: 60, depth: 40 });
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));

    // Simulate a PRE-documentSkipChildren save that the restore floated up: strip the marker root's
    // subtree, then drop the panels back as LOOSE '<Name> Hinge' pivot subtrees at the scene ROOT
    // (siblings of Package) — exactly the "loose Package, Front, Right, Back, Left" symptom.
    const root = h.sceneGraph.findNodeById(pkg.id) as MeshGroup3D;
    for (const c of [...root.children]) root.removeChild(c);
    for (const name of ['Front', 'Right', 'Back', 'Left', 'Top', 'Bottom']) {
      const pivot = new MeshGroup3D(isvc); pivot.name = `${name} Hinge`;
      const mesh = new Mesh3D(isvc, 0, 0, 0, {}); mesh.name = name;
      pivot.addChild(mesh);
      h.sceneGraph.root.addChild(pivot);        // LOOSE at the scene root
    }
    expect(h.topLevelHinges()).toBe(6);

    const mgr2 = new PackagingManager(h.host);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    expect(h.packageRoots()).toBe(1);                                  // ONE Package
    expect(h.topLevelHinges()).toBe(0);                                // every loose leftover pruned
    const s = mgr2.get(pkg.id)!;
    expect(s.box.panels.length).toBe(6);
    for (const p of s.box.panels) {
      expect(mgr2.isPackageNode(p.meshId)).toBe(pkg.id);
      expect((h.sceneGraph.findNodeById(p.meshId)!.parent as MeshGroup3D).id).toBe(p.pivotNodeId);
    }
  });

  it('legacy save where the two-deep flatten dropped PANEL MESHES (Base/Front/…) to root → pruned to one Package', () => {
    const h = makeHost();
    const mgr = new PackagingManager(h.host);
    const pkg = mgr.addPackage({ width: 90, height: 60, depth: 40 });
    const persisted: PackagingPersistEntry[] = JSON.parse(JSON.stringify(mgr.serialize()));

    // The document-restore two-deep-nesting flatten drops panel MESHES (root→pkg→pivot→mesh = 3 deep)
    // to the scene ROOT as loose 'Base'/'Front'/… meshes — the actual "extra outliner items" symptom.
    // Package panels are the ONLY meshes with texOverBase, so the prune targets them by that signature.
    const root = h.sceneGraph.findNodeById(pkg.id) as MeshGroup3D;
    for (const c of [...root.children]) root.removeChild(c);
    for (const name of ['Base', 'Front', 'Back', 'Left', 'Right', 'Lid']) {
      const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', material: { texOverBase: true } });
      mesh.name = name;
      h.sceneGraph.root.addChild(mesh);                                  // LOOSE panel mesh at the scene root
    }
    expect(h.topLevelPanels()).toBe(6);

    const mgr2 = new PackagingManager(h.host);
    expect(mgr2.restoreFromJSON(persisted)).toBe(1);
    expect(h.packageRoots()).toBe(1);                                   // ONE Package
    expect(h.topLevelPanels()).toBe(0);                                 // loose panel meshes pruned
    // A plain user mesh (no texOverBase) at root is NEVER pruned.
    const userMesh = new Mesh3D(isvc, 0, 0, 0, {}); userMesh.name = 'Front';
    h.sceneGraph.root.addChild(userMesh);
    mgr2.restoreFromJSON(persisted);
    expect(h.sceneGraph.findNodeById(userMesh.id)).toBeTruthy();        // untouched — not a package panel
  });
});
