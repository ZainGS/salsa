import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scene3DBlendShapes, type Scene3DBlendShapeHost } from './scene3d-blend-shapes';
import type { ManagerContext } from './manager-context';
import type { Mesh3D, BlendShape } from '../../scene-graph/shapes/mesh-3d';

// §5.1 extraction: Scene3DBlendShapes owns no map — it operates on Mesh3D state through a narrow host. That makes
// it directly testable with a fake mesh (no GPUDevice, no scene graph): we assert the base-geometry capture, the
// weight array bookkeeping (grow/reindex), clamping, and the evaluate/render side effects.

function makeMesh(): Mesh3D & { evaluateBlendShapes: ReturnType<typeof vi.fn> } {
  return {
    geometry: { vertices: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]) },
    baseVertices: null,
    blendShapes: [] as BlendShape[],
    blendWeights: new Float32Array(0),
    evaluateBlendShapes: vi.fn(),
  } as unknown as Mesh3D & { evaluateBlendShapes: ReturnType<typeof vi.fn> };
}

function makeEnv(mesh: Mesh3D | null) {
  const scheduleRender = vi.fn();
  const host: Scene3DBlendShapeHost = { getMesh: (_id: string) => mesh };
  const ctx = { scheduleRender } as unknown as ManagerContext;
  return { ctx, host, scheduleRender };
}

describe('§5.1 Scene3DBlendShapes (extracted subsystem)', () => {
  let mesh: ReturnType<typeof makeMesh>;
  let sub: Scene3DBlendShapes;
  let scheduleRender: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mesh = makeMesh();
    const env = makeEnv(mesh);
    scheduleRender = env.scheduleRender;
    sub = new Scene3DBlendShapes(env.ctx, env.host);
  });

  it('add() captures base geometry, appends a shape, and grows the weight array', () => {
    const idx = sub.add('m', 'smile', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(idx).toBe(0);
    expect(mesh.baseVertices).toBeInstanceOf(Float32Array);
    expect(mesh.baseVertices!.length).toBe(mesh.geometry.vertices.length);
    expect(mesh.blendShapes).toHaveLength(1);
    expect(mesh.blendWeights).toHaveLength(1);
    // A second add preserves prior weights.
    sub.setWeight('m', 0, 0.5);
    sub.add('m', 'frown', new Float32Array(9));
    expect(mesh.blendWeights).toHaveLength(2);
    expect(mesh.blendWeights[0]).toBe(0.5);
  });

  it('add() throws for an unknown mesh', () => {
    const env = makeEnv(null);
    const s = new Scene3DBlendShapes(env.ctx, env.host);
    expect(() => s.add('missing', 'x', new Float32Array(9))).toThrow(/not found/);
  });

  it('setWeight() clamps to [0,1] and triggers evaluate + render', () => {
    sub.add('m', 'a', new Float32Array(9));
    sub.setWeight('m', 0, 5);
    expect(mesh.blendWeights[0]).toBe(1);
    sub.setWeight('m', 0, -3);
    expect(mesh.blendWeights[0]).toBe(0);
    expect(mesh.evaluateBlendShapes).toHaveBeenCalled();
    expect(scheduleRender).toHaveBeenCalled();
  });

  it('setWeight() is a no-op for an out-of-range index', () => {
    sub.add('m', 'a', new Float32Array(9));
    mesh.evaluateBlendShapes.mockClear();
    sub.setWeight('m', 7, 0.5);
    expect(mesh.evaluateBlendShapes).not.toHaveBeenCalled();
  });

  it('list() returns name/weight pairs', () => {
    sub.add('m', 'a', new Float32Array(9));
    sub.add('m', 'b', new Float32Array(9));
    sub.setWeight('m', 1, 0.25);
    expect(sub.list('m')).toEqual([{ name: 'a', weight: 0 }, { name: 'b', weight: 0.25 }]);
  });

  it('remove() reindexes weights and drops base geometry when the last shape goes', () => {
    sub.add('m', 'a', new Float32Array(9));
    sub.add('m', 'b', new Float32Array(9));
    sub.setWeight('m', 1, 0.7);
    sub.remove('m', 0);                       // drop 'a' → 'b' shifts to index 0
    expect(mesh.blendShapes).toHaveLength(1);
    expect(mesh.blendShapes[0].name).toBe('b');
    expect(mesh.blendWeights[0]).toBeCloseTo(0.7);
    expect(mesh.baseVertices).not.toBeNull();
    sub.remove('m', 0);                       // now empty → base geometry released
    expect(mesh.blendShapes).toHaveLength(0);
    expect(mesh.baseVertices).toBeNull();
  });

  it('applyMorphTargets() seeds shapes with zero weights and ignores an empty list', () => {
    sub.applyMorphTargets(mesh, [{ name: 't1', deltaVertices: new Float32Array(9) }, { name: 't2', deltaVertices: new Float32Array(9) }]);
    expect(mesh.blendShapes).toHaveLength(2);
    expect(mesh.blendWeights).toHaveLength(2);
    expect(Array.from(mesh.blendWeights)).toEqual([0, 0]);
    expect(mesh.baseVertices).not.toBeNull();

    const fresh = makeMesh();
    sub.applyMorphTargets(fresh, []);
    expect(fresh.baseVertices).toBeNull();    // empty list → untouched
    expect(fresh.blendShapes).toHaveLength(0);
  });
});
