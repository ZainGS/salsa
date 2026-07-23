/**
 * src/packaging/packaging-creator.test.ts — headless verification of the Package CREATOR MODE
 * (enterCreatorMode / exitCreatorMode / getCreatorState) in PackagingManager. Follows the
 * packaging-editor.test.ts recording-fake-host style. The mode is entered from a NORMAL
 * illustration document, so the key contracts are:
 *  - enter creates the box + dieline layer ONCE, and does NOT resize the user's document,
 *  - re-enter is idempotent (reuses the box and the layer — no duplicates),
 *  - the dieline layer stays TRANSPARENT (never white-filled) — the panels' texOverBase material
 *    composites it over the kraft base, so an empty layer renders as blank cardboard,
 *  - exit keeps the box (and its layer link) in the scene — only paint/orbit/stage tear down.
 */

import { describe, it, expect } from 'vitest';
import { PackagingManager, type PackagingHost } from './packaging-manager';

/** A recording fake host with the creator-mode hooks. First ensure → a fresh layer; after that the
 *  existing id is reused (fresh:false) — mirroring the ShapeManager adapter's 'Dieline'-reuse.
 *  `fillLayerWhite` stays implemented (the optional host hook still exists) so the tests can prove
 *  the manager never invokes it — fresh layers are left transparent. */
function makeHost(opts: { creatorHooks?: boolean; nodeExists?: (id: string) => boolean } = {}) {
  const calls: string[] = [];
  const liveNodes = new Set<string>();
  let armed = false;
  let grp = 0, msh = 0, lyr = 0;
  const host: PackagingHost = {
    createGroup: (_name, _parentId, _scale) => { const id = `grp-${grp++}`; liveNodes.add(id); calls.push('createGroup:' + id); return id; },
    createPanelMesh: () => { const id = `mesh-${msh++}`; calls.push('createPanelMesh:' + id); return id; },
    setNodeTransform: () => { /* transforms only — not asserted here */ },
    removeNode: (id) => { liveNodes.delete(id); calls.push('removeNode:' + id); },
    linkLiveTexture: (_id, layerId) => { calls.push('link:' + layerId); },
    unlinkLiveTexture: () => { calls.push('unlink'); },
    exportLayerPng: async () => null,
    scheduleRender: () => {},
    setDocSize: (w, h) => { calls.push(`docSize:${w}x${h}`); },
    ensureDielineLayer: (existing) => { calls.push('ensureLayer:' + (existing ?? '')); return existing ?? 'layer-legacy'; },
    frameAndOrbit: (id) => { calls.push('frameAndOrbit:' + id); },
    stopOrbit: () => { calls.push('stopOrbit'); },
    armSurfacePaint: (meshIds, layerId) => { armed = true; calls.push(`arm:${meshIds.length}:${layerId}`); return true; },
    disarmSurfacePaint: () => { armed = false; calls.push('disarm'); },
    markUnitWrapper: (rootNodeId, localBounds) => { calls.push('unit:' + rootNodeId + (localBounds ? ':bounds' : '')); },
  };
  if (opts.creatorHooks !== false) {
    host.ensureDielineLayerInfo = (existing) => {
      calls.push('ensureLayerInfo:' + (existing ?? ''));
      if (existing) return { layerId: existing, fresh: false };   // reuse (saved id / named 'Dieline')
      const id = `layer-${lyr++}`;
      return { layerId: id, fresh: true };
    };
    host.fillLayerWhite = (layerId) => { calls.push('fillWhite:' + layerId); };
    host.beginCreatorStage = () => { calls.push('beginStage'); };
    host.endCreatorStage = () => { calls.push('endStage'); };
  }
  if (opts.nodeExists) host.nodeExists = opts.nodeExists;
  return { calls, host, liveNodes, isArmed: () => armed };
}

describe('PackagingManager creator mode', () => {
  it('enter creates the box + a fresh TRANSPARENT dieline layer once, arms paint — and never resizes the doc', () => {
    const { host, calls, isArmed } = makeHost();
    const mgr = new PackagingManager(host);

    const st = mgr.enterCreatorMode({ params: { width: 80, height: 60, depth: 40 } });
    expect(st.active).toBe(true);
    expect(st.packageId).not.toBeNull();
    expect(st.params).toEqual({ width: 80, height: 60, depth: 40 });
    expect(st.dielineLayerId).toBe('layer-0');
    expect(st.foldAmount).toBe(0);                                     // fresh box starts flat
    expect(st.guides.length).toBeGreaterThan(0);

    // One box: 7 groups (root + 6 hinge pivots), 6 panel meshes.
    expect(calls.filter(c => c.startsWith('createGroup')).length).toBe(7);
    expect(calls.filter(c => c.startsWith('createPanelMesh')).length).toBe(6);
    // Fresh layer stays TRANSPARENT — NO white fill (the kraft base shows through texOverBase);
    // it is linked to all 6 panels + armed.
    expect(calls.some(c => c.startsWith('fillWhite'))).toBe(false);
    expect(calls.filter(c => c === 'link:layer-0').length).toBe(6);
    expect(calls).toContain('arm:6:layer-0');
    expect(calls).toContain('frameAndOrbit:' + st.packageId);
    expect(calls).toContain('beginStage');
    expect(isArmed()).toBe(true);
    // The user's illustration document is NEVER resized (the enterEditor difference).
    expect(calls.some(c => c.startsWith('docSize:'))).toBe(false);
  });

  it('re-enter is idempotent: reuses the box and layer — no duplicates, layer never wiped', () => {
    const { host, calls } = makeHost();
    const mgr = new PackagingManager(host);
    const first = mgr.enterCreatorMode();
    calls.length = 0;

    const second = mgr.enterCreatorMode();
    expect(second.packageId).toBe(first.packageId);                    // same box
    expect(second.dielineLayerId).toBe(first.dielineLayerId);          // same layer
    expect(calls.filter(c => c.startsWith('createGroup')).length).toBe(0);
    expect(calls.filter(c => c.startsWith('createPanelMesh')).length).toBe(0);
    expect(calls.some(c => c.startsWith('fillWhite'))).toBe(false);    // reused layer is never wiped
    expect(calls).toContain('ensureLayerInfo:' + first.dielineLayerId);
    expect(mgr.getAll().length).toBe(1);
  });

  it('re-enter with params re-dimensions the SAME box (no second box) and keeps tracking it', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const first = mgr.enterCreatorMode({ params: { width: 80, height: 60, depth: 40 } });

    const second = mgr.enterCreatorMode({ params: { width: 120, height: 90, depth: 50 } });
    expect(mgr.getAll().length).toBe(1);                               // rebuilt, not duplicated
    expect(second.params).toEqual({ width: 120, height: 90, depth: 50 });
    expect(second.dielineLayerId).toBe(first.dielineLayerId);          // layer survives the rebuild
    expect(mgr.getCreatorState().packageId).toBe(second.packageId);
  });

  it('exit preserves the box + layer link; only paint/orbit/stage tear down; state stays queryable', () => {
    const { host, calls, isArmed } = makeHost();
    const mgr = new PackagingManager(host);
    const st = mgr.enterCreatorMode();
    calls.length = 0;

    mgr.exitCreatorMode();
    expect(calls).toContain('disarm');
    expect(calls).toContain('stopOrbit');
    expect(calls).toContain('endStage');
    expect(calls.some(c => c.startsWith('removeNode'))).toBe(false);   // the box STAYS in the scene
    expect(calls.some(c => c === 'unlink')).toBe(false);               // artwork keeps live-texturing it
    expect(isArmed()).toBe(false);
    const after = mgr.getCreatorState();
    expect(after.active).toBe(false);
    expect(after.packageId).toBe(st.packageId);                        // panel can still drive fold/export
    expect(mgr.get(st.packageId!)).not.toBeNull();
    mgr.exitCreatorMode();                                             // double-exit is a no-op
  });

  it('recreates the box when the tracked node is gone (document switch guard)', () => {
    const alive = { ok: true };
    const { host, liveNodes } = makeHost({ nodeExists: (id) => alive.ok && liveNodes.has(id) });
    const mgr = new PackagingManager(host);
    const first = mgr.enterCreatorMode();
    mgr.exitCreatorMode();
    alive.ok = false;                                                  // simulate the doc switching away

    const second = mgr.enterCreatorMode();
    expect(second.packageId).not.toBe(first.packageId);                // fresh box, no stale handle
    expect(second.active).toBe(true);
  });

  it('fillLayerWhite is NEVER invoked across the whole creator lifecycle (transparent-by-default dieline)', () => {
    const { host, calls } = makeHost();
    const mgr = new PackagingManager(host);
    mgr.enterCreatorMode();                                            // fresh enter (fresh layer)
    mgr.enterCreatorMode({ params: { width: 120, height: 90, depth: 50 } });   // re-dimension
    mgr.exitCreatorMode();
    mgr.enterCreatorMode();                                            // re-enter after exit
    expect(calls.some(c => c.startsWith('fillWhite'))).toBe(false);    // the hook exists but is never called
    expect(calls.filter(c => c.startsWith('ensureLayerInfo')).length).toBeGreaterThan(0);
  });

  it('falls back to the legacy ensureDielineLayer host (no white fill hooks) without crashing', () => {
    const { host, calls } = makeHost({ creatorHooks: false });
    const mgr = new PackagingManager(host);
    const st = mgr.enterCreatorMode();
    expect(st.dielineLayerId).toBe('layer-legacy');
    expect(calls.some(c => c.startsWith('ensureLayer:'))).toBe(true);
    expect(calls.some(c => c.startsWith('fillWhite'))).toBe(false);
  });

  it('getCreatorState before any enter is inert', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    expect(mgr.getCreatorState()).toEqual({ active: false, packageId: null, style: null, params: null, foldAmount: 0, dielineLayerId: null, guides: [] });
    mgr.exitCreatorMode();                                             // exit without enter is a no-op
  });

  it('addPackage creates a first-class unit-wrapper package WITHOUT entering the mode', () => {
    const { host, calls } = makeHost();
    const mgr = new PackagingManager(host);

    const st = mgr.addPackage({ width: 100, height: 50, depth: 30 });
    expect(mgr.getAll().length).toBe(1);
    expect(st.foldAmount).toBe(0);                                     // starts flat
    expect(st.params).toEqual({ width: 100, height: 50, depth: 30 });
    // Full hierarchy (root + 6 hinge pivots, 6 panel meshes) + the root marked select-as-a-unit with bounds.
    expect(calls.filter(c => c.startsWith('createGroup')).length).toBe(7);
    expect(calls.filter(c => c.startsWith('createPanelMesh')).length).toBe(6);
    expect(calls).toContain('unit:' + st.id + ':bounds');
    // NO mode side effects: no framing/stage/paint/layer, no doc resize.
    expect(calls.some(c => c.startsWith('frameAndOrbit'))).toBe(false);
    expect(calls.some(c => c === 'beginStage')).toBe(false);
    expect(calls.some(c => c.startsWith('arm:'))).toBe(false);
    expect(calls.some(c => c.startsWith('ensureLayer'))).toBe(false);
    expect(calls.some(c => c.startsWith('docSize:'))).toBe(false);
    expect(mgr.getCreatorState().active).toBe(false);
    expect(mgr.getCreatorState().packageId).toBeNull();                // not the creator box (yet)
  });

  it('addPackage() with no params uses the default creator dimensions', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const st = mgr.addPackage();
    expect(st.params).toEqual({ width: 80, height: 60, depth: 40, bleed: 3 });
  });

  it('enterCreatorMode({packageId}) targets that existing package (frames + arms IT, no new box)', () => {
    const { host, calls } = makeHost();
    const mgr = new PackagingManager(host);
    const a = mgr.addPackage();
    const b = mgr.addPackage({ width: 120, height: 90, depth: 50 });
    calls.length = 0;

    const st = mgr.enterCreatorMode({ packageId: b.id });
    expect(st.active).toBe(true);
    expect(st.packageId).toBe(b.id);                                   // not a, not a fresh box
    expect(st.params).toEqual({ width: 120, height: 90, depth: 50 });
    expect(calls).toContain('frameAndOrbit:' + b.id);
    expect(calls).toContain('arm:6:' + st.dielineLayerId);
    expect(calls.filter(c => c.startsWith('createGroup')).length).toBe(0);
    expect(mgr.getAll().length).toBe(2);
    // Exit → plain re-enter keeps tracking the targeted package (packageId persists).
    mgr.exitCreatorMode();
    expect(mgr.enterCreatorMode().packageId).toBe(b.id);
    expect(mgr.isPackageNode(a.id)).toBe(a.id);                        // a is untouched, still registered
  });

  it('enterCreatorMode with an UNKNOWN packageId falls back to the normal create-or-reuse enter', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const st = mgr.enterCreatorMode({ packageId: 'nope' });
    expect(st.active).toBe(true);
    expect(st.packageId).not.toBeNull();
    expect(mgr.getAll().length).toBe(1);                               // one fresh box, no crash
  });

  it('isPackageNode resolves panel/pivot/root ids to the package id; non-package → null', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const st = mgr.addPackage();
    expect(mgr.isPackageNode(st.id)).toBe(st.id);                          // root container
    expect(mgr.isPackageNode(st.box.rootGroupId)).toBe(st.id);             // same node, explicit
    expect(mgr.isPackageNode(st.box.panels[0].pivotNodeId)).toBe(st.id);   // hinge pivot
    expect(mgr.isPackageNode(st.box.panels[3].meshId)).toBe(st.id);        // panel mesh
    expect(mgr.isPackageNode('nope')).toBeNull();
    expect(mgr.isPackageNode('')).toBeNull();
    mgr.remove(st.id);
    expect(mgr.isPackageNode(st.id)).toBeNull();                           // removed → no longer resolves
  });

  it('attachDielinePane wires the pane only while the mode is active; hands back guides + a uv mapper', () => {
    const { host, calls } = makeHost();
    host.attachPaintPane = () => { calls.push('attachPane'); return (u, v) => [u * 100, v * 50]; };
    host.detachPaintPane = () => { calls.push('detachPane'); };
    const mgr = new PackagingManager(host);
    const fakePane = {} as Parameters<PackagingManager['attachDielinePane']>[0];

    expect(mgr.attachDielinePane(fakePane)).toBeNull();                // mode not entered → null
    mgr.enterCreatorMode();
    const pane = mgr.attachDielinePane(fakePane);
    expect(pane).not.toBeNull();
    expect(pane!.guides.length).toBeGreaterThan(0);
    expect(pane!.canvasWidth).toBeGreaterThan(0);
    expect(pane!.uvToCanvas(0.5, 0.5)).toEqual([50, 25]);              // host mapper passes through
    mgr.detachDielinePane();
    expect(calls).toContain('attachPane');
    expect(calls).toContain('detachPane');
    mgr.exitCreatorMode();
    expect(mgr.attachDielinePane(fakePane)).toBeNull();                // inactive again → null
  });

  it('every enter RE-APPLIES the panel material contract on (re)link — create-or-reuse AND adoption', () => {
    const { host, calls } = makeHost();
    host.applyPanelMaterial = (meshId) => { calls.push('mat:' + meshId); };
    const mgr = new PackagingManager(host);

    // Fresh enter → all 6 panels get the contract re-applied at link time.
    mgr.enterCreatorMode();
    expect(calls.filter(c => c.startsWith('mat:')).length).toBe(6);

    // {packageId} ADOPTION (an addPackage box, e.g. one restored/created outside the mode) → its 6
    // panels get texOverBase+kraft re-applied too (legacy multiply materials would render BLACK).
    const b = mgr.addPackage();
    calls.length = 0;
    mgr.enterCreatorMode({ packageId: b.id });
    const mats = calls.filter(c => c.startsWith('mat:'));
    expect(mats.length).toBe(6);
    for (const p of b.box.panels) expect(mats).toContain('mat:' + p.meshId);

    // Idempotent re-enter re-applies again (cheap, and heals any external material edits).
    calls.length = 0;
    mgr.enterCreatorMode();
    expect(calls.filter(c => c.startsWith('mat:')).length).toBe(6);
  });

  it('creator mode ISOLATES the target: other packages hidden on enter, restored on exit', () => {
    const { host, calls } = makeHost();
    const vis = new Map<string, boolean>();
    host.setNodeVisible = (id, v) => { vis.set(id, v); calls.push(`vis:${id}:${v}`); };
    host.isNodeVisible = (id) => vis.get(id) ?? true;
    const mgr = new PackagingManager(host);
    const a = mgr.addPackage();
    const b = mgr.addPackage({ width: 120, height: 90, depth: 50 });

    mgr.enterCreatorMode({ packageId: a.id });
    expect(vis.get(b.box.rootGroupId)).toBe(false);   // the OTHER package is hidden
    expect(vis.get(a.box.rootGroupId)).toBe(true);    // the target is shown

    mgr.exitCreatorMode();
    expect(vis.get(b.box.rootGroupId)).toBe(true);    // restored
    expect(vis.get(a.box.rootGroupId)).toBe(true);    // both visible again
  });

  it('isolation switches targets cleanly: enter A then enter B without exit → A hidden, B shown', () => {
    const { host } = makeHost();
    const vis = new Map<string, boolean>();
    host.setNodeVisible = (id, v) => { vis.set(id, v); };
    host.isNodeVisible = (id) => vis.get(id) ?? true;
    const mgr = new PackagingManager(host);
    const a = mgr.addPackage();
    const b = mgr.addPackage();

    mgr.enterCreatorMode({ packageId: a.id });
    expect(vis.get(b.box.rootGroupId)).toBe(false);

    mgr.enterCreatorMode({ packageId: b.id });        // switch WITHOUT exit
    expect(vis.get(a.box.rootGroupId)).toBe(false);   // old target now hidden
    expect(vis.get(b.box.rootGroupId)).toBe(true);    // new target shown

    mgr.exitCreatorMode();
    expect(vis.get(a.box.rootGroupId)).toBe(true);    // exit restores everything
    expect(vis.get(b.box.rootGroupId)).toBe(true);
  });

  it('isolation restore remembers PRIOR visibility and survives a package deleted while hidden', () => {
    const { host } = makeHost();
    const vis = new Map<string, boolean>();
    host.setNodeVisible = (id, v) => { vis.set(id, v); };
    host.isNodeVisible = (id) => vis.get(id) ?? true;
    const mgr = new PackagingManager(host);
    const a = mgr.addPackage();
    const b = mgr.addPackage();
    const c = mgr.addPackage();
    vis.set(c.box.rootGroupId, false);                // c was ALREADY hidden by the user

    mgr.enterCreatorMode({ packageId: a.id });
    expect(vis.get(b.box.rootGroupId)).toBe(false);
    mgr.remove(b.id);                                 // deleted while hidden — must not break restore
    mgr.exitCreatorMode();
    expect(vis.get(a.box.rootGroupId)).toBe(true);
    expect(vis.get(c.box.rootGroupId)).toBe(false);   // restored to its PRIOR (hidden) state, not blanket-shown
  });

  it('pane handle exposes per-panel labels + UV rects in [0,1], and its getters stay LIVE across setDimensions', () => {
    const { host } = makeHost();
    host.attachPaintPane = () => (u, v) => [u * 100, v * 50];
    host.detachPaintPane = () => {};
    const mgr = new PackagingManager(host);
    mgr.enterCreatorMode({ params: { width: 80, height: 60, depth: 40 } });
    const pane = mgr.attachDielinePane({} as Parameters<PackagingManager['attachDielinePane']>[0]);
    expect(pane).not.toBeNull();

    expect(pane!.panels.length).toBe(6);
    for (const p of pane!.panels) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
      const { u0, v0, u1, v1 } = p.uvRect;
      expect(u0).toBeGreaterThanOrEqual(0); expect(v0).toBeGreaterThanOrEqual(0);
      expect(u1).toBeLessThanOrEqual(1);    expect(v1).toBeLessThanOrEqual(1);
      expect(u1).toBeGreaterThan(u0);       expect(v1).toBeGreaterThan(v0);
    }

    // LIVE handle: after setDimensions the SAME handle reflects the new net (no stale captures).
    const beforeW = pane!.canvasWidth;
    mgr.setDimensions(mgr.getCreatorState().packageId!, { width: 160, height: 90, depth: 50 });
    const cur = mgr.get(mgr.getCreatorState().packageId!)!;
    expect(pane!.canvasWidth).toBe(cur.canvasWidth);
    expect(pane!.canvasWidth).not.toBe(beforeW);
    expect(pane!.guides).toBe(cur.guides);            // identity: the CURRENT guides, not a stale copy
    expect(pane!.panels.length).toBe(6);              // panels re-derive from the current net
  });

  it('remove() of the creator box clears the creator handle → next enter builds fresh', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    const st = mgr.enterCreatorMode();
    mgr.remove(st.packageId!);
    expect(mgr.getCreatorState().packageId).toBeNull();
    const again = mgr.enterCreatorMode();
    expect(again.packageId).not.toBe(st.packageId);
    expect(again.active).toBe(true);
  });
});
