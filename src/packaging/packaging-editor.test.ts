/**
 * src/packaging/packaging-editor.test.ts — headless verification of the enterEditor/exitEditor
 * orchestration in PackagingManager. Uses a fake PackagingHost that records calls, so we can assert
 * that entering the editor composes the pieces in the right order (size doc → ensure+link dieline
 * layer → start flat → frame+orbit → arm surface paint) and that exiting tears painting + orbit down.
 * No GPU / renderer needed — the manager only touches the host interface + the box-hierarchy builder.
 */

import { describe, it, expect } from 'vitest';
import { PackagingManager, type PackagingHost } from './packaging-manager';

/** A recording fake host. createGroup/createPanelMesh return stable, unique node ids. */
function makeHost() {
  const calls: string[] = [];
  let armed = false;
  let armedCount = 0;
  let grp = 0, msh = 0;
  const host: PackagingHost = {
    createGroup: (name, parentId, scale) => { const id = `grp-${grp++}`; calls.push(`createGroup:${id}:${scale ?? ''}`); return id; },
    createPanelMesh: () => { const id = `mesh-${msh++}`; calls.push(`createPanelMesh:${id}`); return id; },
    setNodeTransform: () => { /* transforms only — not asserted here */ },
    removeNode: (id) => { calls.push('removeNode:' + id); },
    linkLiveTexture: (_id, layerId) => { calls.push('link:' + layerId); },
    unlinkLiveTexture: () => { calls.push('unlink'); },
    exportLayerPng: async () => null,
    scheduleRender: () => {},
    setDocSize: (w, h) => { calls.push(`docSize:${w}x${h}`); },
    ensureDielineLayer: (existing) => { calls.push('ensureLayer:' + (existing ?? '')); return existing ?? 'layer-1'; },
    frameAndOrbit: (id) => { calls.push('frameAndOrbit:' + id); },
    stopOrbit: () => { calls.push('stopOrbit'); },
    armSurfacePaint: (meshIds, layerId) => { armed = true; armedCount = meshIds.length; calls.push(`arm:${meshIds.length}:${layerId}`); return true; },
    disarmSurfacePaint: () => { armed = false; calls.push('disarm'); },
  };
  return { host, calls, isArmed: () => armed, armedCount: () => armedCount };
}

describe('PackagingManager.enterEditor', () => {
  it('composes doc-size → dieline layer link → flat → frame+orbit → arm surface paint', () => {
    const { host, calls, isArmed, armedCount } = makeHost();
    const mgr = new PackagingManager(host);
    const s = mgr.create('simpleBox', { width: 80, height: 60, depth: 40 });
    expect(s.id).toBe(s.meshId);   // id == root container node id

    const h = mgr.enterEditor(s.id);
    expect(h).not.toBeNull();
    expect(h!.meshId).toBe(s.meshId);   // frame/orbit target = root container
    expect(h!.dielineLayerId).toBe('layer-1');
    expect(h!.canvasWidth).toBe(s.canvasWidth);
    expect(h!.guides.length).toBeGreaterThan(0);

    // Doc sized to the dieline BEFORE the layer is ensured (so a new layer is created at doc size).
    const iDoc = calls.findIndex(c => c.startsWith('docSize:'));
    const iEnsure = calls.findIndex(c => c.startsWith('ensureLayer:'));
    const iLink = calls.findIndex(c => c.startsWith('link:'));
    const iFrame = calls.findIndex(c => c.startsWith('frameAndOrbit:'));
    const iArm = calls.findIndex(c => c.startsWith('arm:'));
    expect(iDoc).toBeGreaterThanOrEqual(0);
    expect(iDoc).toBeLessThan(iEnsure);
    expect(iEnsure).toBeLessThan(iLink);
    expect(iLink).toBeLessThan(iFrame);
    expect(iFrame).toBeLessThan(iArm);
    // Every one of the 6 panels is live-textured with the shared dieline layer, and surface paint
    // is armed across all 6 (raycast whichever panel is hit).
    expect(calls.filter(c => c === 'link:layer-1').length).toBe(6);
    expect(calls).toContain('frameAndOrbit:' + s.meshId);
    expect(calls).toContain('arm:6:layer-1');
    expect(isArmed()).toBe(true);
    expect(armedCount()).toBe(6);
    expect(mgr.get(s.id)!.foldAmount).toBe(0); // starts flat
  });

  it('reuses a saved layer id on restore and honours frame:false', () => {
    const { host, calls } = makeHost();
    const mgr = new PackagingManager(host);
    const s = mgr.create('simpleBox', { width: 50, height: 50, depth: 50 });

    const h = mgr.enterEditor(s.id, { layerId: 'saved-layer', frame: false });
    expect(h!.dielineLayerId).toBe('saved-layer');
    expect(calls).toContain('ensureLayer:saved-layer');
    expect(calls).toContain('arm:6:saved-layer');
    expect(calls.some(c => c.startsWith('frameAndOrbit'))).toBe(false); // frame:false → no camera change
  });

  it('exitEditor disarms painting and stops orbit', () => {
    const { host, calls, isArmed } = makeHost();
    const mgr = new PackagingManager(host);
    const s = mgr.create('simpleBox', { width: 80, height: 60, depth: 40 });
    mgr.enterEditor(s.id);
    calls.length = 0;

    mgr.exitEditor(s.id);
    expect(calls).toContain('disarm');
    expect(calls).toContain('stopOrbit');
    expect(isArmed()).toBe(false);
  });

  it('remove deletes the whole panel subtree via the root container', () => {
    const { host, calls } = makeHost();
    const mgr = new PackagingManager(host);
    const s = mgr.create('simpleBox', { width: 80, height: 60, depth: 40 });
    calls.length = 0;
    mgr.remove(s.id);
    expect(calls).toContain('removeNode:' + s.meshId);
    expect(mgr.get(s.id)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    const { host } = makeHost();
    const mgr = new PackagingManager(host);
    expect(mgr.enterEditor('nope')).toBeNull();
  });
});
