import { describe, it, expect, beforeEach } from 'vitest';

import { Scene3DWeightPaint, type Scene3DWeightPaintHost } from './scene3d-weight-paint';
import type { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { OrbitController } from '../../renderer/3d/orbit-controller';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import type { ManagerContext } from './manager-context';

// §5.1 extraction: the interactive parts (brush preview, pointer listeners, heatmap upload) need a canvas + GPU and
// are browser-verified. The pure joint-weight MATH — normalize-to-1 and the dab (increment a joint's weight toward
// a target, then renormalize) — is plain typed-array logic and IS unit-testable with a mock SkinnedMesh.

/** Mock a skinned mesh with `nv` verts: 4 joint slots each, given indices/weights. */
function fakeMesh(nv: number, jointIndices: number[], jointWeights: number[]): SkinnedMesh3D {
  return {
    id: 'm1',
    jointIndices: Int32Array.from(jointIndices),
    jointWeights: Float32Array.from(jointWeights),
    geometry: { vertices: new Float32Array(nv * 12) },
    vertexColors: null as Float32Array | null,
    skinDirty: false,
  } as unknown as SkinnedMesh3D;
}

function makeEnv(mesh: SkinnedMesh3D | null) {
  const ctx = { scheduleRender: () => {}, webgpuRenderer: { getRenderer3D: () => ({}) } } as unknown as ManagerContext;
  const host: Scene3DWeightPaintHost = {
    getSkinnedMesh: () => mesh,
    getOrbitController: () => null as unknown as OrbitController,
    getCamera: () => ({} as Camera3D),
    pickFromClient3D: () => null,
    getVerticesNearPoint3D: () => [],
  };
  return new Scene3DWeightPaint(ctx, host);
}

const weightsOf = (m: SkinnedMesh3D) => Array.from(m.jointWeights as Float32Array);

describe('§5.1 Scene3DWeightPaint (pure joint-weight math)', () => {
  it('isActive() is false before entering the mode', () => {
    expect(makeEnv(null).isActive()).toBe(false);
  });

  it('normalizeWeights3D makes each vertex\'s 4 weights sum to 1 and marks skin dirty', () => {
    const mesh = fakeMesh(1, [0, 1, 2, 3], [1, 1, 2, 0]); // sum = 4
    const wp = makeEnv(mesh);
    wp.normalizeWeights3D('m1');
    expect(weightsOf(mesh)).toEqual([0.25, 0.25, 0.5, 0]);
    expect((mesh as unknown as { skinDirty: boolean }).skinDirty).toBe(true);
  });

  it('normalizeWeights3D leaves an all-zero vertex untouched (no divide-by-zero)', () => {
    const mesh = fakeMesh(1, [0, 1, 2, 3], [0, 0, 0, 0]);
    const wp = makeEnv(mesh);
    wp.normalizeWeights3D('m1');
    expect(weightsOf(mesh)).toEqual([0, 0, 0, 0]);
  });

  it('paintWeightDab3D moves an existing joint slot toward the target weight, then renormalizes to 1', () => {
    // vertex 0: joint 2 already in slot 1 at weight 0.2; other slots hold joints 0/1/3.
    const mesh = fakeMesh(1, [0, 2, 1, 3], [0.5, 0.2, 0.2, 0.1]);
    const wp = makeEnv(mesh);
    // paint joint 2 toward weight 1 at strength 0.5 → slot1: 0.2 + (1-0.2)*0.5 = 0.6, then renormalize (sum 1.4)
    wp.paintWeightDab3D('m1', 2, [0], 1, 0.5);
    const w = weightsOf(mesh);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);       // renormalized
    expect(w[1]).toBeCloseTo(0.6 / 1.4, 5);                        // painted slot dominates
    expect(w[1]).toBeGreaterThan(0.2);                            // increased
  });

  it('paintWeightDab3D assigns the joint to the lightest slot when not already present', () => {
    // joint 9 is not in any slot; slot 3 has the smallest weight (0.05) → gets reassigned to joint 9.
    const mesh = fakeMesh(1, [0, 1, 2, 3], [0.5, 0.3, 0.15, 0.05]);
    const wp = makeEnv(mesh);
    wp.paintWeightDab3D('m1', 9, [0], 1, 1);   // strength 1 → slot3 weight becomes 1 pre-normalize
    expect(mesh.jointIndices[3]).toBe(9);                         // reassigned to the painted joint
    expect(weightsOf(mesh).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('operations on an unknown mesh are safe no-ops', () => {
    const wp = makeEnv(null);
    expect(() => wp.normalizeWeights3D('nope')).not.toThrow();
    expect(() => wp.paintWeightDab3D('nope', 0, [0], 1, 1)).not.toThrow();
  });
});
