/**
 * packaging-sync.test.ts — the DIELINE↔MESH SYNC guarantee through PackagingManager:
 * setDimensions AND template-param changes regenerate net + UVs + guides + panelLabels TOGETHER.
 *
 *  - dims-only change on tuckEnd → the IN-PLACE fast path (no node teardown; ids + live-texture
 *    links stay valid) and the guides' cut set matches the NEW net extents,
 *  - tuckStyle flip (RTE↔STE) = TOPOLOGY change (same panel COUNT, different parent links) →
 *    the clean rebuild path: old nodes fully removed (no orphans), live-texture re-linked onto
 *    the new panels, surface paint RE-ARMED (creator mode), scene-graph-changed emitted, fold
 *    preserved,
 *  - new styles are first-class: create/addPackage/enterCreatorMode accept 'tuckEnd'/'sleeve'
 *    (Round A) and 'rollEndMailer'/'rigidTwoPiece' (Round B); getCreatorState reports the style,
 *  - Round B parity: unit-wrapper + framing bounds span BOTH rigidTwoPiece trays (incl. the lid
 *    translate's hover apex), lidDepth/boardThickness/restOpenAmount are dims-only (fast path,
 *    foldTranslate re-baked), lockTabs flip = topology (rebuild), pane panels carry 'Lid …'
 *    labels, serialize carries the new params.
 */

import { describe, it, expect } from 'vitest';
import { PackagingManager, type PackagingHost } from './packaging-manager';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

/** Recording fake host with the in-place fast path (setPanelGeometry) + creator hooks. */
function makeHost() {
  const calls: string[] = [];
  const liveNodes = new Set<string>();
  const geoms = new Map<string, MeshGeometry>();
  type Bounds = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  const bounds = new Map<string, Bounds | undefined>();
  let armedMeshes: string[] = [];
  let armedLayer: string | null = null;
  let grp = 0, msh = 0, lyr = 0;
  const host: PackagingHost = {
    createGroup: (_name, _parent, _scale) => { const id = `grp-${grp++}`; liveNodes.add(id); calls.push('createGroup:' + id); return id; },
    createPanelMesh: (geom, _parent, name) => { const id = `mesh-${msh++}`; liveNodes.add(id); geoms.set(id, geom); calls.push(`createPanelMesh:${id}:${name}`); return id; },
    setNodeTransform: () => {},
    setPanelGeometry: (meshId, geom) => { geoms.set(meshId, geom); calls.push('setPanelGeometry:' + meshId); },
    removeNode: (id) => { liveNodes.delete(id); calls.push('removeNode:' + id); },
    linkLiveTexture: (meshId, layerId) => { calls.push(`link:${meshId}:${layerId}`); },
    unlinkLiveTexture: (meshId) => { calls.push('unlink:' + meshId); },
    exportLayerPng: async () => null,
    scheduleRender: () => {},
    setDocSize: () => {},
    ensureDielineLayer: (existing) => existing ?? `layer-${lyr++}`,
    ensureDielineLayerInfo: (existing) => existing ? { layerId: existing, fresh: false } : { layerId: `layer-${lyr++}`, fresh: true },
    frameAndOrbit: () => {},
    stopOrbit: () => {},
    armSurfacePaint: (meshIds, layerId) => { armedMeshes = meshIds.slice(); armedLayer = layerId; calls.push(`arm:${meshIds.length}:${layerId}`); return true; },
    disarmSurfacePaint: () => { armedMeshes = []; armedLayer = null; calls.push('disarm'); },
    notifySceneGraphChanged: () => { calls.push('sceneChanged'); },
    nodeExists: (id) => liveNodes.has(id),
    markUnitWrapper: (rootNodeId, localBounds) => { bounds.set(rootNodeId, localBounds); },
    // Pane stub: identity UV→canvas mapper (enough to read DielinePaneHandle.panels).
    attachPaintPane: () => (u: number, v: number) => [u, v] as [number, number],
  };
  return { host, calls, liveNodes, geoms, bounds, armed: () => ({ meshes: armedMeshes, layer: armedLayer }) };
}

describe('new styles are first-class', () => {
  it("create/addPackage accept 'tuckEnd' (13 panels) and 'sleeve' (5 panels)", () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const te = mgr.create('tuckEnd', { width: 80, height: 60, depth: 40 });
    expect(te.box.panels.length).toBe(13);
    expect(te.style).toBe('tuckEnd');
    const sl = mgr.addPackage({ width: 90, height: 50, depth: 30 }, 'sleeve');
    expect(sl.box.panels.length).toBe(5);
    expect(sl.style).toBe('sleeve');
  });

  it("enterCreatorMode({ style: 'tuckEnd' }) builds a tuckEnd and reports it in getCreatorState", () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const st = mgr.enterCreatorMode({ style: 'tuckEnd', params: { width: 80, height: 60, depth: 40 } });
    expect(st.active).toBe(true);
    expect(st.style).toBe('tuckEnd');
    expect(mgr.get(st.packageId!)!.box.panels.length).toBe(13);
    // slit guides reached the creator state (the host's overlay filter sees the new types).
    expect(st.guides.some(g => g.type === 'slit')).toBe(true);
  });
});

describe('dims-only change → the IN-PLACE fast path, dieline and mesh regenerate together', () => {
  it('same ids, no teardown; guides/canvas/labels/UVs all track the new dims', () => {
    const { host, calls } = makeHost();
    const mgr = new PackagingManager(host);
    const s0 = mgr.create('tuckEnd', { width: 80, height: 60, depth: 40 });
    const meshIdsBefore = s0.box.panels.map(p => p.meshId);
    calls.length = 0;

    const s1 = mgr.setDimensions(s0.id, { width: 120, height: 70, depth: 50 })!;
    expect(s1.id).toBe(s0.id);                                        // fast path: same package id
    expect(s1.box.panels.map(p => p.meshId)).toEqual(meshIdsBefore);  // same nodes
    expect(calls.some(c => c.startsWith('removeNode'))).toBe(false);  // no teardown
    expect(calls.filter(c => c.startsWith('setPanelGeometry')).length).toBe(13);

    // DIELINE↔MESH SYNC: the cut set spans the NEW canvas extents…
    const cut = s1.guides.find(g => g.type === 'cut')!;
    const xs = cut.segments.flatMap(seg => [seg[0][0], seg[1][0]]);
    const ys = cut.segments.flatMap(seg => [seg[0][1], seg[1][1]]);
    expect(Math.max(...xs)).toBeGreaterThan(s1.canvasWidth - 1.5);
    expect(Math.max(...ys)).toBeGreaterThan(s1.canvasHeight - 1.5);
    // …and every panel's UV rect equals its dieline (guide-outline) rect on the new net.
    const outline = s1.guides.find(g => g.type === 'panel' && !g.label)!;
    let seg = 0;
    for (const p of s1.foldMeshData.panels) {
      for (let k = 0; k < p.corners.length; k++) {
        const [pxX, pxY] = outline.segments[seg++][0];
        if (p.id === 'glueTab') { expect(p.uvs[k][0]).toBeGreaterThan(0.98); continue; }
        expect(p.uvs[k][0] * s1.canvasWidth).toBeCloseTo(pxX, 6);
        expect(p.uvs[k][1] * s1.canvasHeight).toBeCloseTo(pxY, 6);
      }
    }
    expect(Object.keys(s1.panelLabels).length).toBe(13);
  });

  it('preserves the fold amount', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const s0 = mgr.create('tuckEnd', { width: 80, height: 60, depth: 40 });
    mgr.setFoldAmount(s0.id, 0.62);
    const s1 = mgr.setDimensions(s0.id, { width: 100, height: 50, depth: 45 })!;
    expect(s1.foldAmount).toBeCloseTo(0.62, 12);
  });
});

describe('tuckStyle flip → topology change → the CLEAN REBUILD path', () => {
  it('old nodes gone (no orphans), new hierarchy correct, links + paint + notifications re-established', () => {
    const { host, calls, liveNodes, armed } = makeHost();
    const mgr = new PackagingManager(host);
    const st = mgr.enterCreatorMode({ style: 'tuckEnd', params: { width: 80, height: 60, depth: 40 } });
    const s0 = mgr.get(st.packageId!)!;
    const oldRoot = s0.box.rootGroupId;
    const oldMeshes = s0.box.panels.map(p => p.meshId);
    const layerId = st.dielineLayerId!;
    mgr.setFoldAmount(s0.id, 0.45);
    const botParentOld = s0.foldMeshData.panels[s0.foldMeshData.panels.findIndex(p => p.id === 'botClose')].parentPanelIndex;
    expect(s0.foldMeshData.panels[botParentOld].id).toBe('back');       // RTE default
    calls.length = 0;

    const s1 = mgr.setDimensions(s0.id, { width: 80, height: 60, depth: 40, tuckStyle: 'straight' })!;

    // REBUILD, not fast path: the old root subtree was removed and a new one built.
    expect(calls).toContain('removeNode:' + oldRoot);
    expect(s1.id).not.toBe(oldRoot);
    expect(liveNodes.has(oldRoot)).toBe(false);                         // no orphan nodes
    const newMeshes = s1.box.panels.map(p => p.meshId);
    for (const m of oldMeshes) expect(newMeshes).not.toContain(m);      // panels are all new
    expect(newMeshes.length).toBe(13);

    // Topology followed the param: bottom closure now hangs off the FRONT.
    const p1 = s1.foldMeshData.panels;
    expect(p1[p1.findIndex(p => p.id === 'botClose')].parentPanelIndex).toBe(p1.findIndex(p => p.id === 'front'));
    expect(Object.keys(s1.panelLabels).length).toBe(13);

    // Live-texture re-linked on every NEW panel; paint re-armed on them; tree announced; fold kept.
    for (const m of newMeshes) expect(calls).toContain(`link:${m}:${layerId}`);
    expect(armed().meshes).toEqual(newMeshes);
    expect(armed().layer).toBe(layerId);
    expect(calls).toContain('sceneChanged');
    expect(s1.foldAmount).toBeCloseTo(0.45, 12);
    expect(mgr.getCreatorState().packageId).toBe(s1.id);                // creator handle re-keyed
    expect(mgr.getAll().length).toBe(1);                                // still ONE package
  });

  it('flip back (straight → reverse) is symmetric', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const s0 = mgr.create('tuckEnd', { width: 80, height: 60, depth: 40, tuckStyle: 'straight' });
    const s1 = mgr.setDimensions(s0.id, { width: 80, height: 60, depth: 40, tuckStyle: 'reverse' })!;
    const p1 = s1.foldMeshData.panels;
    expect(p1[p1.findIndex(p => p.id === 'botClose')].parentPanelIndex).toBe(p1.findIndex(p => p.id === 'back'));
  });
});

describe('persistence round-trip covers the new styles', () => {
  it('serialize carries style + tuckStyle params for tuckEnd/sleeve packages', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const te = mgr.create('tuckEnd', { width: 80, height: 60, depth: 40, tuckStyle: 'straight' });
    mgr.create('sleeve', { width: 90, height: 50, depth: 30 });
    const entries = mgr.serialize();
    expect(entries.map(e => e.style).sort()).toEqual(['sleeve', 'tuckEnd']);
    const teEntry = entries.find(e => e.id === te.id)!;
    expect(teEntry.params.tuckStyle).toBe('straight');
    expect(teEntry.panels.length).toBe(13);
  });
});

// ── ROUND B: rollEndMailer (M4) + rigidTwoPiece (M5) lifecycle parity ─────────────────────────

describe("Round B styles are first-class ('rollEndMailer' / 'rigidTwoPiece')", () => {
  it('create/addPackage accept both (11 and 10 panels); enterCreatorMode reports the style', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const rm = mgr.create('rollEndMailer', { width: 80, height: 60, depth: 40 });
    expect(rm.box.panels.length).toBe(11);
    expect(rm.style).toBe('rollEndMailer');
    const rt = mgr.addPackage({ width: 80, height: 60, depth: 40 }, 'rigidTwoPiece');
    expect(rt.box.panels.length).toBe(10);
    expect(rt.style).toBe('rigidTwoPiece');

    const st = mgr.enterCreatorMode({ style: 'rollEndMailer', params: { width: 70, height: 50, depth: 30 }, packageId: rm.id });
    expect(st.style).toBe('rollEndMailer');
    // The mailer's lip shoulder slits reach the creator state's guide overlay.
    expect(st.guides.some(g => g.type === 'slit')).toBe(true);
  });

  it('unit-wrapper: isPackageNode resolves EVERY panel/pivot of BOTH rigidTwoPiece trays to the one package', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const rt = mgr.addPackage({ width: 80, height: 60, depth: 40 }, 'rigidTwoPiece');
    for (const p of rt.box.panels) {
      expect(mgr.isPackageNode(p.meshId)).toBe(rt.id);
      expect(mgr.isPackageNode(p.pivotNodeId)).toBe(rt.id);
    }
  });

  it('framing bounds measure BOTH trays for rigidTwoPiece, and track the fold POSE (BUG 2: tight, not the net union)', () => {
    const { host, bounds } = makeHost();
    const mgr = new PackagingManager(host);
    const rt = mgr.addPackage({ width: 80, height: 60, depth: 40 }, 'rigidTwoPiece');   // starts flat (fold 0)
    const flat = bounds.get(rt.box.rootGroupId)!;
    expect(flat).toBeTruthy();
    // At fold 0 the FLAT net spans both trays' nets: base net minX = −80 mm, lid net maxX = 254 mm.
    expect(flat.minX).toBeLessThan(-79 * 0.02);
    expect(flat.maxX).toBeGreaterThan(250 * 0.02);
    // BUG 2: bounds are the CURRENT fold pose, NOT a whole-fold-range union — folding collapses the
    // wide flat net to the assembled two-piece box, so the selection box shrinks (no net blowup).
    mgr.setFoldAmount(rt.id, 1);
    const closed = bounds.get(rt.box.rootGroupId)!;
    expect(closed.maxX - closed.minX).toBeLessThan(flat.maxX - flat.minX);
    expect(closed.maxX - closed.minX).toBeLessThan(200 * 0.02);   // tight to the box, far below the ~334 mm net span
  });

  it('rigidTwoPiece: lidDepth/boardThickness are dims-only → the IN-PLACE fast path (foldTranslate refreshed)', () => {
    const { host, calls } = makeHost();
    const mgr = new PackagingManager(host);
    const s0 = mgr.create('rigidTwoPiece', { width: 80, height: 60, depth: 40 });
    const meshIdsBefore = s0.box.panels.map(p => p.meshId);
    calls.length = 0;

    const s1 = mgr.setDimensions(s0.id, { width: 80, height: 60, depth: 40, lidDepth: 15, boardThickness: 3 })!;
    expect(s1.id).toBe(s0.id);                                        // same package id
    expect(s1.box.panels.map(p => p.meshId)).toEqual(meshIdsBefore);  // same nodes
    expect(calls.some(c => c.startsWith('removeNode'))).toBe(false);  // no teardown
    expect(calls.filter(c => c.startsWith('setPanelGeometry')).length).toBe(10);
    // The lid root's baked translate followed the new derived dims (seatY = 35? no: D 40 + bt 3 = 43,
    // lift = 15 + 6 = 21 → lift segment reaches (43 + 21) mm × MM_TO_WORLD on the y axis).
    const lidIdx = s1.foldMeshData.panels.findIndex(p => p.id === 'lid');
    const segs = s1.box.panels[lidIdx].foldTranslate!;
    expect(segs.length).toBe(3);
    expect(segs[0].to * segs[0].axis[1]).toBeCloseTo((43 + 21) * 0.02, 6);
  });

  it('rollEndMailer: restOpenAmount is dims-only → fast path; lockTabs flip = TOPOLOGY → clean rebuild', () => {
    const { host, calls, liveNodes } = makeHost();
    const mgr = new PackagingManager(host);
    const s0 = mgr.create('rollEndMailer', { width: 80, height: 60, depth: 40 });
    const oldRoot = s0.box.rootGroupId;
    calls.length = 0;

    // restOpenAmount: same topology (only the lid's target angle scales) → in-place.
    const s1 = mgr.setDimensions(s0.id, { width: 80, height: 60, depth: 40, restOpenAmount: 0.3 })!;
    expect(s1.id).toBe(oldRoot);
    expect(calls.some(c => c.startsWith('removeNode'))).toBe(false);
    expect(calls.filter(c => c.startsWith('setPanelGeometry')).length).toBe(11);
    calls.length = 0;

    // lockTabs off: 11 → 9 panels → the rebuild path (old subtree gone, no orphans).
    const s2 = mgr.setDimensions(s1.id, { width: 80, height: 60, depth: 40, lockTabs: false })!;
    expect(calls).toContain('removeNode:' + oldRoot);
    expect(liveNodes.has(oldRoot)).toBe(false);
    expect(s2.box.panels.length).toBe(9);
    expect(s2.foldMeshData.panels.some(p => p.id === 'lockA')).toBe(false);
    expect(mgr.getAll().length).toBe(1);
  });

  it("rigidTwoPiece pane panels: labels include the 'Lid …' set, UV rects inside [0,1]", () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    mgr.enterCreatorMode({ style: 'rigidTwoPiece', params: { width: 80, height: 60, depth: 40 } });
    const pane = mgr.attachDielinePane({} as never)!;
    expect(pane).toBeTruthy();
    const labels = pane.panels.map(p => p.label);
    for (const l of ['Base', 'Lid', 'Lid Front', 'Lid Back', 'Lid Left', 'Lid Right']) {
      expect(labels).toContain(l);
    }
    for (const p of pane.panels) {
      expect(p.uvRect.u0).toBeGreaterThanOrEqual(0); expect(p.uvRect.u1).toBeLessThanOrEqual(1);
      expect(p.uvRect.v0).toBeGreaterThanOrEqual(0); expect(p.uvRect.v1).toBeLessThanOrEqual(1);
      expect(p.uvRect.u1).toBeGreaterThan(p.uvRect.u0);
    }
    // The two-net layout: the Lid rect sits fully right of the Base rect (gutter between nets).
    const rect = (label: string) => pane.panels.find(p => p.label === label)!.uvRect;
    expect(rect('Lid').u0).toBeGreaterThan(rect('Base').u1);
  });

  it('serialize carries the Round B styles + their params (lockTabs/restOpenAmount/lidDepth/boardThickness)', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const rm = mgr.create('rollEndMailer', { width: 80, height: 60, depth: 40, lockTabs: false, restOpenAmount: 0.25 });
    const rt = mgr.create('rigidTwoPiece', { width: 80, height: 60, depth: 40, lidDepth: 15, boardThickness: 3 });
    const entries = mgr.serialize();
    expect(entries.map(e => e.style).sort()).toEqual(['rigidTwoPiece', 'rollEndMailer']);
    const rmE = entries.find(e => e.id === rm.id)!;
    expect(rmE.params.lockTabs).toBe(false);
    expect(rmE.params.restOpenAmount).toBe(0.25);
    expect(rmE.panels.length).toBe(9);
    const rtE = entries.find(e => e.id === rt.id)!;
    expect(rtE.params.lidDepth).toBe(15);
    expect(rtE.params.boardThickness).toBe(3);
    expect(rtE.panels.length).toBe(10);
  });
});
