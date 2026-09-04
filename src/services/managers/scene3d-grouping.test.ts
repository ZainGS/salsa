import { describe, it, expect, beforeEach } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { Scene3DGrouping, type Scene3DGroupingHost } from './scene3d-grouping';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

// §5.1 extraction: Scene3DGrouping is GPU-free, so a real SceneGraph + mock ctx drives it. We assert create/delete
// group parenting + undo, the outliner visibility/name setters, and getScene3DHierarchy's shape (groups nest their
// mesh children; a thin-wrapper collapses to one leaf).

function makeEnv() {
  const sceneGraph = new SceneGraph();
  const interactionService = { maxGlobalZIndex: 0 } as unknown as InteractionService;
  const undoStack: Command3D[] = [];
  const rec = { render: 0, emitChanged: 0 };
  const ctx = {
    sceneGraph,
    interactionService,
    scheduleRender: () => { rec.render++; },
    emitSceneGraphChanged: () => { rec.emitChanged++; },
    setSelectedNode: () => {},
  } as unknown as ManagerContext;
  const host: Scene3DGroupingHost = {
    getMesh: (id) => (sceneGraph.findNodeById(id) as Mesh3D) ?? null,
    pushUndo: (cmd) => { undoStack.push(cmd); },
    directionKey: () => 'linear:+x',
  };
  const grouping = new Scene3DGrouping(ctx, host);
  const addMesh = (name: string) => {
    const m = new Mesh3D(interactionService, 0, 0, 0, { primitive: 'box' });
    m.name = name;
    sceneGraph.root.addChild(m);
    return m;
  };
  return { grouping, sceneGraph, undoStack, rec, addMesh };
}

describe('§5.1 Scene3DGrouping (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('createMeshGroup parents a group under root and undo removes it', () => {
    const grp = env.grouping.createMeshGroup('My Group');
    expect(grp).toBeInstanceOf(MeshGroup3D);
    expect(env.sceneGraph.root.children).toContain(grp);
    expect(env.undoStack[0].description).toBe('Create group');
    env.undoStack[0].undo();
    expect(env.sceneGraph.root.children).not.toContain(grp);
  });

  it('deleteMeshGroup lifts children to root; undo re-parents them into the group', () => {
    const grp = env.grouping.createMeshGroup();
    const a = env.addMesh('a'); const b = env.addMesh('b');
    grp.addChild(a); grp.addChild(b);
    env.grouping.deleteMeshGroup(grp.id);
    expect(env.sceneGraph.root.children).toContain(a);   // lifted to root
    expect(env.sceneGraph.root.children).not.toContain(grp);
    env.undoStack[env.undoStack.length - 1].undo();
    expect(env.sceneGraph.root.children).toContain(grp);
    expect(grp.children).toContain(a);
    expect(grp.children).toContain(b);
  });

  it('deleteMeshGroup returns false for an unknown id', () => {
    expect(env.grouping.deleteMeshGroup('nope')).toBe(false);
  });

  it('setMeshVisible / setMeshName mutate the node and report false for unknown ids', () => {
    const m = env.addMesh('cube');
    expect(env.grouping.setMeshVisible(m.id, false)).toBe(true);
    expect(env.grouping.isMeshVisible(m.id)).toBe(false);
    expect(env.grouping.setMeshName(m.id, 'renamed')).toBe(true);
    expect(env.grouping.getMeshName(m.id)).toBe('renamed');
    expect(env.grouping.setMeshVisible('nope', true)).toBe(false);
  });

  it('setGroupCollapsed / setGroupVisible / setGroupName round-trip on a group', () => {
    const grp = env.grouping.createMeshGroup('G');
    expect(env.grouping.setGroupCollapsed(grp.id, true)).toBe(true);
    expect(env.grouping.isGroupCollapsed(grp.id)).toBe(true);
    expect(env.grouping.setGroupVisible(grp.id, false)).toBe(true);
    expect(env.grouping.isGroupVisible(grp.id)).toBe(false);
    expect(env.grouping.setGroupName(grp.id, 'Renamed')).toBe(true);
    expect(env.grouping.getGroupName(grp.id)).toBe('Renamed');
  });

  it('getScene3DHierarchy nests a group\'s mesh children and lists top-level meshes', () => {
    const loose = env.addMesh('loose');
    const grp = env.grouping.createMeshGroup('Grp');
    const inside = env.addMesh('inside');
    grp.addChild(inside);
    const tree = env.grouping.getScene3DHierarchy();
    const looseEntry = tree.find(n => n.id === loose.id);
    const grpEntry = tree.find(n => n.id === grp.id);
    expect(looseEntry?.type).toBe('3DMesh');
    expect(grpEntry?.type).toBe('3DMeshGroup');
    expect(grpEntry?.children?.map(c => c.id)).toContain(inside.id);
  });

  it('getScene3DNode returns a mesh descriptor or null', () => {
    const m = env.addMesh('n');
    expect(env.grouping.getScene3DNode(m.id)).toMatchObject({ id: m.id, name: 'n', type: '3DMesh' });
    expect(env.grouping.getScene3DNode('nope')).toBeNull();
  });
});
