import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Scene3DManager, playCharacterOutlinesOnRestore } from './scene3d-manager';
import type { InteractionService } from '../interaction-service';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals).
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const mesh = () => new Mesh3D(isvc, 0, 0, 0, { primitive: 'cube' } as never);

// Call the two Scene3DManager methods against a minimal `this` (they only need getMesh / getAllMeshes).
function host(meshes: Mesh3D[]) {
  const self = { getMesh: (id: string) => meshes.find((m) => m.id === id) ?? null, getAllMeshes: () => meshes };
  return {
    snapshot: () => Scene3DManager.prototype.snapshotDirtyMeshes.call(self as never),
    clearIfUnchanged: (s: Array<{ id: string; version: number }>) =>
      Scene3DManager.prototype.clearMeshDirtyStateIfUnchanged.call(self as never, s),
  };
}

describe('mesh save-dirty versioning (audit 2026-09-28 P5)', () => {
  it('every stateDirty = true bumps stateVersion; = false does not', () => {
    const m = mesh();
    const v0 = m.stateVersion;
    m.stateDirty = true;
    expect(m.stateVersion).toBe(v0 + 1);
    m.stateDirty = false;
    expect(m.stateVersion).toBe(v0 + 1);
    expect(m.stateDirty).toBe(false);
  });

  it('an edit that lands WHILE a save is writing stays dirty; untouched meshes are cleared', () => {
    const a = mesh(), b = mesh();
    a.stateDirty = true; b.stateDirty = true;
    const h = host([a, b]);
    const snap = h.snapshot();                 // save serializes both…
    a.stateDirty = true;                       // …then `a` is edited during the async write
    h.clearIfUnchanged(snap);                  // write completes
    expect(a.stateDirty).toBe(true);           // the mid-write edit is NOT lost — saved next time
    expect(b.stateDirty).toBe(false);          // b was saved as-is
  });

  it('a mesh dirtied only after the snapshot is not touched', () => {
    const a = mesh(), late = mesh();
    a.stateDirty = true; late.stateDirty = false;
    const h = host([a, late]);
    const snap = h.snapshot();
    late.stateDirty = true;
    h.clearIfUnchanged(snap);
    expect(late.stateDirty).toBe(true);
    expect(a.stateDirty).toBe(false);
  });
});

describe('resetGlobalScene3DSettingsForLoad (audit 2026-09-28 P6)', () => {
  it('snapshots defaults on the FIRST load and re-applies that same snapshot on every later load', () => {
    let live = { fog: { enabled: false }, ssao: { enabled: false } };
    const applied: unknown[] = [];
    const self: Record<string, unknown> = {
      _globalSettingsDefaults: null,
      getGlobalScene3DSettings: () => live,
      restoreGlobalScene3DSettings: (s: unknown) => { applied.push(s); },
    };
    const reset = () => Scene3DManager.prototype.resetGlobalScene3DSettingsForLoad.call(self as never);
    reset();                                              // first load: defaults = the app-start state
    live = { fog: { enabled: true }, ssao: { enabled: true } };   // doc A turns fog + SSAO on
    reset();                                              // opening doc B must start from the DEFAULTS, not A's
    // fogHardEdge is an only-when-on key, so the reset pins its default explicitly (2026-10-01); fogHorizon saves only
    // its non-default fields, so its pinned default is {} (= every field at its default). (playCharacterOutlines is
    // NOT pinned: it is always saved, so the snapshot's app-start value — on — is what a new / empty document gets; an
    // old full save without the key is detected in restoreGlobalScene3DSettings instead — see the test below.)
    expect(applied[1]).toEqual({ fog: { enabled: false }, ssao: { enabled: false }, fogHardEdge: false, fogHorizon: {} });
    expect(applied[1]).not.toBe(applied[0]);              // a fresh copy each time (restore can't mutate the snapshot)
  });
});

describe('play character outlines on restore (visual-polish item 10)', () => {
  it('saved value wins; an old full save without the key plays without; a partial patch / empty doc keeps the default', () => {
    expect(playCharacterOutlinesOnRestore({ playCharacterOutlines: true }, false)).toBe(true);
    expect(playCharacterOutlinesOnRestore({ playCharacterOutlines: false }, true)).toBe(false);
    expect(playCharacterOutlinesOnRestore({ characterOutlines: null }, true)).toBe(false);      // pre-item-10 full save
    expect(playCharacterOutlinesOnRestore({ viewState: {} as never }, true)).toBe(false);
    expect(playCharacterOutlinesOnRestore({ fog: { enabled: true } } as never, true)).toBe(true);   // lighting-only patch
    expect(playCharacterOutlinesOnRestore({}, true)).toBe(true);                                // new / empty document
  });
});
