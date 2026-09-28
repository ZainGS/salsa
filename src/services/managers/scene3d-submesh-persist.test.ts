import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Mesh3D, type Submesh3D } from '../../scene-graph/shapes/mesh-3d';
import { DEFAULT_MATERIAL } from '../../renderer/3d/material-3d';
import { Scene3DManager, validSavedSubmeshes } from './scene3d-manager';
import type { InteractionService } from '../interaction-service';

const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const slot = (indexOffset: number, indexCount: number, r = 1): Submesh3D =>
  ({ label: `s${indexOffset}`, indexOffset, indexCount, material: { ...DEFAULT_MATERIAL, diffuse: { r, g: 0, b: 0, a: 1 } } });

describe('multi-material submesh persistence (audit 2026-09-28 P8)', () => {
  it('Mesh3D.toJSON includes submeshes when present (and omits the key when there are none)', () => {
    const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' } as never);
    expect(m.toJSON().submeshes).toBeUndefined();
    m.submeshes = [slot(0, 6, 0.2), slot(6, 6, 0.9)];
    const json = JSON.parse(JSON.stringify(m.toJSON()));
    expect(json.submeshes).toHaveLength(2);
    expect(json.submeshes[1]).toMatchObject({ indexOffset: 6, indexCount: 6, material: { diffuse: { r: 0.9 } } });
  });

  it('validSavedSubmeshes accepts in-range slots as independent clones, rejects any out-of-range save', () => {
    const saved = [slot(0, 6), slot(6, 6)];
    const ok = validSavedSubmeshes(saved, 12)!;
    expect(ok).toHaveLength(2);
    ok[0].material.diffuse.r = 0.5;
    expect(saved[0].material.diffuse.r).toBe(1);             // clone — restoring can't alias the parsed save
    expect(validSavedSubmeshes([slot(0, 6), slot(6, 12)], 12)).toBeNull();   // runs past the index buffer
    expect(validSavedSubmeshes([{ indexOffset: 0 }], 12)).toBeNull();       // malformed
    expect(validSavedSubmeshes([], 12)).toBeNull();
    expect(validSavedSubmeshes(undefined, 12)).toBeNull();
  });

  it('the submesh setters mark the mesh save-dirty (they only set gpuDirty before)', () => {
    const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' } as never);
    m.submeshes = [slot(0, 6)];
    const self = { getMesh: () => m, ctx: { scheduleRender: () => {} } };
    for (const run of [
      () => Scene3DManager.prototype.setSubmesh.call(self as never, m.id, 0, { label: 'Glass' }),
      () => Scene3DManager.prototype.appendSubmesh.call(self as never, m.id, slot(6, 6)),
      () => Scene3DManager.prototype.removeSubmesh.call(self as never, m.id, 1),
      () => Scene3DManager.prototype.clearSubmeshes.call(self as never, m.id),
    ]) {
      m.stateDirty = false;
      run();
      expect(m.stateDirty).toBe(true);
    }
  });
});
