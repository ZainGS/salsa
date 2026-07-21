/**
 * src/packaging/packaging-creator.test.ts — headless verification of the Package CREATOR MODE
 * (enterCreatorMode / exitCreatorMode / getCreatorState) in PackagingManager. Follows the
 * packaging-editor.test.ts recording-fake-host style. The mode is entered from a NORMAL
 * illustration document, so the key contracts are:
 *  - enter creates the box + dieline layer ONCE, and does NOT resize the user's document,
 *  - re-enter is idempotent (reuses the box and the layer — no duplicates),
 *  - a FRESH dieline layer is white-filled exactly once; a REUSED layer is never touched,
 *  - exit keeps the box (and its layer link) in the scene — only paint/orbit/stage tear down.
 */

import { describe, it, expect } from 'vitest';
import { PackagingManager, type PackagingHost } from './packaging-manager';

/** A recording fake host with the creator-mode hooks. First ensure → a fresh layer; after that the
 *  existing id is reused (fresh:false) — mirroring the ShapeManager adapter's 'Dieline'-reuse. */
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
  it('enter creates the box + a fresh WHITE dieline layer once, arms paint — and never resizes the doc', () => {
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
    // Fresh layer → white-filled exactly once, then linked to all 6 panels + armed.
    expect(calls.filter(c => c === 'fillWhite:layer-0').length).toBe(1);
    expect(calls.filter(c => c === 'link:layer-0').length).toBe(6);
    expect(calls).toContain('arm:6:layer-0');
    expect(calls).toContain('frameAndOrbit:' + st.packageId);
    expect(calls).toContain('beginStage');
    expect(isArmed()).toBe(true);
    // The user's illustration document is NEVER resized (the enterEditor difference).
    expect(calls.some(c => c.startsWith('docSize:'))).toBe(false);
  });

  it('re-enter is idempotent: reuses the box and layer — no duplicates, no second white fill', () => {
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
    expect(mgr.getCreatorState()).toEqual({ active: false, packageId: null, params: null, foldAmount: 0, dielineLayerId: null, guides: [] });
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
