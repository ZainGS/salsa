import { describe, it, expect, beforeEach } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { Scene3DPrimitives, type Scene3DPrimitivesHost } from './scene3d-primitives';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

// §5.1 extraction: Scene3DPrimitives is deliberately GPU-free, so it unit-tests with a mock ctx — build a mesh,
// assert it lands under the scene root, gets selected, and pushes exactly one undo entry whose undo/redo detach
// and re-attach it. The illustration-viewport hooks are stubbed (default no-sync) so the factory path is exact.

function makeEnv(opts: { synced?: boolean; defaultScale?: number } = {}) {
  const sceneGraph = new SceneGraph();
  const calls = { render: 0, emitChanged: 0, selected: [] as string[], setSelectedMeshIds: [] as Set<string>[], applyCam: 0 };
  const undoStack: Command3D[] = [];
  const ctx = {
    sceneGraph,
    interactionService: { maxGlobalZIndex: 0 } as unknown as InteractionService,
    webgpuRenderer: {
      getRenderer3D: () => ({ setSelectedMeshIds: (ids: Set<string>) => { calls.setSelectedMeshIds.push(ids); } }),
    },
    scheduleRender: () => { calls.render++; },
    emitSceneGraphChanged: () => { calls.emitChanged++; },
    setSelectedNode: (id: string) => { calls.selected.push(id); },
  } as unknown as ManagerContext;
  const host: Scene3DPrimitivesHost = {
    pushUndo: (cmd) => { undoStack.push(cmd); },
    isIllustrationSync: () => opts.synced ?? false,
    illustrationMeshDefaultScale: () => opts.defaultScale ?? 1,
    applyIllustrationCamera: () => { calls.applyCam++; },
  };
  return { prim: new Scene3DPrimitives(ctx, host), sceneGraph, calls, undoStack };
}

describe('§5.1 Scene3DPrimitives (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('create() parents the mesh under the scene root, selects it, and schedules a render', () => {
    const m = env.prim.box(1, 2, 3);
    expect(m).toBeInstanceOf(Mesh3D);
    expect(env.sceneGraph.root.children).toContain(m);
    expect(env.calls.selected).toEqual([m.id]);
    expect(env.calls.setSelectedMeshIds[0].has(m.id)).toBe(true);
    expect(env.calls.render).toBe(1);
    expect(env.calls.emitChanged).toBe(1);
  });

  it('create() pushes one undo entry whose undo detaches and redo re-attaches the mesh', () => {
    const m = env.prim.sphere(0, 0, 0);
    expect(env.undoStack).toHaveLength(1);
    expect(env.undoStack[0].description).toBe('Create mesh');
    env.undoStack[0].undo();
    expect(env.sceneGraph.root.children).not.toContain(m);
    env.undoStack[0].redo();
    expect(env.sceneGraph.root.children).toContain(m);
  });

  it('each primitive builder produces the matching Mesh3D primitive kind', () => {
    expect(env.prim.box(0, 0, 0).meshPrimitive).toBe('box');
    expect(env.prim.sphere(0, 0, 0).meshPrimitive).toBe('sphere');
    expect(env.prim.plane(0, 0, 0).meshPrimitive).toBe('plane');
    expect(env.prim.cylinder(0, 0, 0).meshPrimitive).toBe('cylinder');
    expect(env.prim.torus(0, 0, 0).meshPrimitive).toBe('torus');
  });

  it('illustration-synced create() auto-scales non-custom primitives by the default canvas scale', () => {
    const synced = makeEnv({ synced: true, defaultScale: 4 });
    const box = synced.prim.box(0, 0, 0);
    expect([box.scaleX, box.scaleY, box.scaleZ]).toEqual([4, 4, 4]);   // primitive → scaled
    const custom = synced.prim.custom(0, 0, 0, { vertices: new Float32Array(), indices: new Uint32Array() } as never);
    expect([custom.scaleX, custom.scaleY, custom.scaleZ]).toEqual([1, 1, 1]); // custom geometry → left at original scale
  });

  it('not-synced create() does NOT re-apply the illustration camera; synced does', () => {
    env.prim.box(0, 0, 0);
    expect(env.calls.applyCam).toBe(0);
    const synced = makeEnv({ synced: true });
    synced.prim.box(0, 0, 0);
    expect(synced.calls.applyCam).toBe(1);
  });

  it('polygon() and circle() attach an EditMesh to the created mesh', () => {
    const poly = env.prim.polygon(0, 0, 0, [[0, 0], [1, 0], [1, 1]], 1, 'tri');
    expect(poly.editMesh).toBeTruthy();
    expect(poly.name).toBe('tri');
    const circ = env.prim.circle(0, 0, 0, 0.5, 6, 1);
    expect(circ.editMesh).toBeTruthy();
  });

  it('importObjMesh() parses OBJ text into a custom mesh', () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
    const m = env.prim.importObjMesh(0, 0, 0, obj);
    expect(m.meshPrimitive).toBe('custom');
    expect(env.sceneGraph.root.children).toContain(m);
  });
});
