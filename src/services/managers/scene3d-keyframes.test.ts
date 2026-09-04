import { describe, it, expect, beforeEach } from 'vitest';

import { Scene3DKeyframes, type Scene3DKeyframesHost } from './scene3d-keyframes';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';

// §5.1 extraction: pure keyframe-track data ops over mesh.keyframeTracks — a plain object mesh + captured undo is
// all it takes. We assert set/remove/clear round-trip through undo, blend-shape tracks nest under blendWeights,
// and the timeline query helpers aggregate frames across every track.

function fakeMesh(id: string, name = id): Mesh3D {
  return { id, name, stateDirty: false, keyframeTracks: {} as Record<string, unknown> } as unknown as Mesh3D;
}

function makeEnv(meshes: Mesh3D[] = [fakeMesh('m1')]) {
  const byId = new Map(meshes.map(m => [m.id, m]));
  const undoStack: Command3D[] = [];
  const ctx = {} as unknown as ManagerContext;
  const host: Scene3DKeyframesHost = {
    getMesh: (id) => byId.get(id) ?? null,
    getAllMeshes: () => meshes,
    pushUndo: (cmd) => { undoStack.push(cmd); },
  };
  return { kf: new Scene3DKeyframes(ctx, host), byId, undoStack };
}

const tracks = (env: ReturnType<typeof makeEnv>, id = 'm1') =>
  (env.byId.get(id) as unknown as { keyframeTracks: Record<string, unknown> }).keyframeTracks;

describe('§5.1 Scene3DKeyframes (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('setMeshKeyframe writes a track keyframe, marks dirty, and pushes undo that removes it', () => {
    expect(env.kf.setMeshKeyframe('m1', 'position', 5, [1, 2, 3])).toBe(true);
    expect((tracks(env).position as { frame: number }[])[0].frame).toBe(5);
    expect((env.byId.get('m1') as unknown as { stateDirty: boolean }).stateDirty).toBe(true);
    env.undoStack[0].undo();
    expect((tracks(env).position as unknown[]).length).toBe(0);
    env.undoStack[0].redo();
    expect((tracks(env).position as unknown[]).length).toBe(1);
  });

  it('setMeshKeyframe on an existing frame captures the prior value for undo', () => {
    env.kf.setMeshKeyframe('m1', 'position', 5, [1, 1, 1]);
    env.kf.setMeshKeyframe('m1', 'position', 5, [9, 9, 9]);
    expect((tracks(env).position as { value: number[] }[])[0].value).toEqual([9, 9, 9]);
    env.undoStack[env.undoStack.length - 1].undo();
    expect((tracks(env).position as { value: number[] }[])[0].value).toEqual([1, 1, 1]); // prior value restored
  });

  it('removeMeshKeyframe deletes the key; undo restores it; unknown returns false', () => {
    env.kf.setMeshKeyframe('m1', 'rotation', 3, [0, 0, 0]);
    expect(env.kf.removeMeshKeyframe('m1', 'rotation', 3)).toBe(true);
    expect((tracks(env).rotation as unknown[]).length).toBe(0);
    env.undoStack[env.undoStack.length - 1].undo();
    expect((tracks(env).rotation as unknown[]).length).toBe(1);
    expect(env.kf.removeMeshKeyframe('m1', 'rotation', 999)).toBe(false); // no key at that frame
  });

  it('clearMeshKeyframeTracks wipes all tracks; undo restores the snapshot', () => {
    env.kf.setMeshKeyframe('m1', 'position', 1, [0, 0, 0]);
    env.kf.setMeshKeyframe('m1', 'scale', 2, [1, 1, 1]);
    expect(env.kf.clearMeshKeyframeTracks('m1')).toBe(true);
    expect(Object.keys(tracks(env))).toHaveLength(0);
    env.undoStack[env.undoStack.length - 1].undo();
    expect(tracks(env).position).toBeDefined();
    expect(tracks(env).scale).toBeDefined();
  });

  it('blend-shape keyframes nest under blendWeights and round-trip through undo', () => {
    expect(env.kf.setBlendShapeKeyframe('m1', 'smile', 4, 0.8)).toBe(true);
    const bw = (tracks(env).blendWeights as Record<string, { frame: number; value: number }[]>);
    expect(bw.smile[0]).toMatchObject({ frame: 4, value: 0.8 });
    expect(env.kf.getBlendShapeKeyframeTracks('m1')).toBe(bw);
    env.kf.removeBlendShapeKeyframe('m1', 'smile', 4);
    expect(bw.smile.length).toBe(0);
    env.undoStack[env.undoStack.length - 1].undo();
    expect(bw.smile.length).toBe(1);
  });

  it('getMeshKeyframeFrames aggregates + sorts frames across transform AND blend-shape tracks', () => {
    env.kf.setMeshKeyframe('m1', 'position', 10, [0, 0, 0]);
    env.kf.setMeshKeyframe('m1', 'scale', 2, [1, 1, 1]);
    env.kf.setBlendShapeKeyframe('m1', 'smile', 5, 1);
    expect(env.kf.getMeshKeyframeFrames('m1')).toEqual([2, 5, 10]);
    expect(env.kf.hasMeshKeyframeAtFrame('m1', 5)).toBe(true);
    expect(env.kf.hasMeshKeyframeAtFrame('m1', 7)).toBe(false);
  });

  it('getAllMeshesForAnimation / getAllMeshKeyframeTracks list every mesh', () => {
    const env2 = makeEnv([fakeMesh('a', 'Alpha'), fakeMesh('b', 'Beta')]);
    expect(env2.kf.getAllMeshesForAnimation()).toEqual([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
    expect(env2.kf.getAllMeshKeyframeTracks().map(r => r.meshId)).toEqual(['a', 'b']);
  });

  it('operations on an unknown mesh are safe no-ops', () => {
    expect(env.kf.setMeshKeyframe('nope', 'position', 0, [0, 0, 0])).toBe(false);
    expect(env.kf.getMeshKeyframeTracks('nope')).toBeNull();
    expect(env.kf.getMeshKeyframeFrames('nope')).toEqual([]);
  });
});
