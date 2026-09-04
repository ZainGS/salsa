import { describe, it, expect, beforeEach } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { Scene3DArrays, type Scene3DArraysHost } from './scene3d-arrays';
import { ArrayGroup3D } from '../../scene-graph/shapes/array-group-3d';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

// §5.1 extraction: Scene3DArrays needs only ctx + a 3-method host, so it unit-tests with a fake renderer that
// records the instance-dirty / array-group traffic. We assert: create parents an ArrayGroup + pushes undo that
// removes it; overrides round-trip through undo/redo; and the direction-key logic keys arrays by mode + axis.

function makeEnv() {
  const sceneGraph = new SceneGraph();
  const preRenderCbs = new Set<() => boolean>();
  const rec = { instancesDirty: 0, selectedMeshIds: [] as Set<string>[], arrayGizmo: [] as unknown[], render: 0 };
  const renderer3D = {
    markInstancesDirty: () => { rec.instancesDirty++; },
    setSelectedMeshIds: (ids: Set<string>) => { rec.selectedMeshIds.push(ids); },
    setArrayGizmoData: (d: unknown) => { rec.arrayGizmo.push(d); },
    setArrayGroups: () => {},
    getSelectedMeshIds: () => new Set<string>(),
    setSelectedSourceId: () => {},
  };
  const undoStack: Command3D[] = [];
  const interactionService = { maxGlobalZIndex: 0 } as unknown as InteractionService;
  const ctx = {
    sceneGraph,
    interactionService,
    webgpuRenderer: {
      getRenderer3D: () => renderer3D,
      addPreRenderCallback: (cb: () => boolean) => { preRenderCbs.add(cb); },
    },
    scheduleRender: () => { rec.render++; },
    emitSceneGraphChanged: () => {},
    setSelectedNode: () => {},
    sceneStructureVersion: () => 0,
  } as unknown as ManagerContext;
  const host: Scene3DArraysHost = {
    getMesh: (id) => (sceneGraph.findNodeById(id) as Mesh3D) ?? null,
    pushUndo: (cmd) => { undoStack.push(cmd); },
    getTransformOrientationMode: () => null,
  };
  const arrays = new Scene3DArrays(ctx, host);
  // A real source mesh in the graph so create can resolve it.
  const src = new Mesh3D(interactionService, 0, 0, 0, { primitive: 'box' });
  sceneGraph.root.addChild(src);
  return { arrays, sceneGraph, rec, undoStack, preRenderCbs, src };
}

describe('§5.1 Scene3DArrays (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('createLinearArray3D parents an ArrayGroup3D, starts the sync loop, and pushes a removing undo', () => {
    const group = env.arrays.createLinearArray3D(env.src.id, 3);
    expect(group).toBeInstanceOf(ArrayGroup3D);
    expect(env.sceneGraph.root.children).toContain(group);
    expect(env.preRenderCbs.size).toBe(1);              // sync loop registered
    expect(env.undoStack).toHaveLength(1);
    expect(env.undoStack[0].description).toBe('Create array');
    env.undoStack[0].undo();
    expect(env.sceneGraph.root.children).not.toContain(group);
  });

  it('a second create reuses the SAME sync callback (does not stack pre-render callbacks)', () => {
    env.arrays.createLinearArray3D(env.src.id, 2);
    env.arrays.createRadialArray3D(env.src.id, 4);
    expect(env.preRenderCbs.size).toBe(1);
  });

  it('createGridArray3D / createRadialArray3D produce the matching array mode', () => {
    expect(env.arrays.createGridArray3D(env.src.id).arrayParams.mode).toBe('grid');
    expect(env.arrays.createRadialArray3D(env.src.id).arrayParams.mode).toBe('radial');
  });

  it('create throws for an unknown source mesh', () => {
    expect(() => env.arrays.createLinearArray3D('nope')).toThrow(/not found/);
  });

  it('setInstanceOverride records the override + marks instances dirty; undo/redo round-trip it', () => {
    const group = env.arrays.createLinearArray3D(env.src.id, 3);
    const dirtyBefore = env.rec.instancesDirty;
    env.arrays.setInstanceOverride(group.id, 0, { scale: [2, 2, 2] });
    expect(env.arrays.getInstanceOverrides(group.id)).toEqual([{ index: 0, override: { scale: [2, 2, 2] } }]);
    expect(env.rec.instancesDirty).toBe(dirtyBefore + 1);
    const cmd = env.undoStack[env.undoStack.length - 1];
    cmd.undo();
    expect(env.arrays.getInstanceOverrides(group.id)).toEqual([]);
    cmd.redo();
    expect(env.arrays.getInstanceOverrides(group.id)).toEqual([{ index: 0, override: { scale: [2, 2, 2] } }]);
  });

  it('clearInstanceOverride removes it and undo restores it', () => {
    const group = env.arrays.createLinearArray3D(env.src.id, 3);
    env.arrays.setInstanceOverride(group.id, 1, { scale: [3, 3, 3] });
    env.arrays.clearInstanceOverride(group.id, 1);
    expect(env.arrays.getInstanceOverrides(group.id)).toEqual([]);
    env.undoStack[env.undoStack.length - 1].undo();
    expect(env.arrays.getInstanceOverrides(group.id)).toEqual([{ index: 1, override: { scale: [3, 3, 3] } }]);
  });

  it('directionKey keys arrays by mode + dominant axis', () => {
    expect(env.arrays.directionKey({ mode: 'linear', countX: 3, spacing: [2, 0, 0] })).toBe('linear:+x');
    expect(env.arrays.directionKey({ mode: 'linear', countX: 3, spacing: [0, 0, -5] })).toBe('linear:-z');
    expect(env.arrays.directionKey({ mode: 'radial', count: 6, radius: 3, axis: 'y', arcDeg: 360, center: [0, 0, 0] })).toBe('radial:y');
    expect(env.arrays.directionKey({ mode: 'grid', countX: 2, spacingX: [2, 0, 0], countY: 2, spacingY: [0, 0, 2] })).toBe('grid:+x');
  });

  it('updateArrayParams3D mutates params live and marks instances dirty (no undo)', () => {
    const group = env.arrays.createLinearArray3D(env.src.id, 3);
    const undoLenBefore = env.undoStack.length;
    const dirtyBefore = env.rec.instancesDirty;
    env.arrays.updateArrayParams3D(group.id, { countX: 7 } as never);
    expect((group.arrayParams as { countX: number }).countX).toBe(7);
    expect(env.rec.instancesDirty).toBe(dirtyBefore + 1);
    expect(env.undoStack.length).toBe(undoLenBefore); // live update → no undo entry
  });
});
