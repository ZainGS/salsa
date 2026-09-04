/**
 * mesh-picker-skinned.test.ts — the skin-aware pick.
 *
 * A skinned mesh RENDERS deformed (skin matrices) but its base geometry is the rest pose. The picker CPU-skins
 * the geometry so painting/selecting a POSED creature lands on the visible surface, not the rest silhouette.
 * This drives the real MeshPicker with an orthographic camera and asserts a posed vertex is where the ray hits.
 */
import { describe, it, expect } from 'vitest';
// Shape.id uses self.crypto.randomUUID (browser globals). Provide both before importing nodes.
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
import { MeshPicker } from './mesh-picker';
import { Camera3D } from './camera-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { InteractionService } from '../../services/interaction-service';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** A 0.4×0.4 quad in the XY plane at z=0, every vertex weighted 100% to joint 0. */
function makeQuad(): SkinnedMesh3D {
  const h = 0.2;
  const P: [number, number, number][] = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0]];
  const verts = new Float32Array(4 * 12);          // 12-float layout; only positions matter for picking
  for (let i = 0; i < 4; i++) { verts[i * 12] = P[i][0]; verts[i * 12 + 1] = P[i][1]; verts[i * 12 + 2] = P[i][2]; }
  const mesh = new SkinnedMesh3D(isvc, 0, 0, 0, {
    primitive: 'custom',
    geometry: { vertices: verts, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), format: '12float' },
  });
  mesh.pickable = true;
  mesh.transformViaSkeleton = true;                // object transform lives on the skeleton → pick with identity model
  mesh.jointIndices = new Uint8Array(16);          // all → joint 0
  mesh.jointWeights = new Float32Array(16);
  for (let i = 0; i < 4; i++) mesh.jointWeights[i * 4] = 1;
  return mesh;
}

/** A one-joint rig, bound at the origin (skinMatrix = identity at rest). */
function makeSkeleton(): Skeleton3D {
  const skel = new Skeleton3D({ name: 't', joints: [], clips: [] });
  skel.addJoint(-1, [0, 0, 0], 'root');            // computes world matrices (root = identity)
  skel.computeInverseBindMatrices();               // invBind = inverse(identity) = identity
  skel.computeWorldMatrices();                     // skinMatrix = world × invBind = identity → verts at rest
  return skel;
}

describe('MeshPicker — skin-aware pick', () => {
  // Orthographic so pixel↔world is linear: orthoSize 1, aspect 1 → world X,Y ∈ [-1,1] over a 100×100 canvas.
  const cam = new Camera3D({ mode: 'orthographic', position: [0, 0, 3], target: [0, 0, 0], up: [0, 1, 0], orthoSize: 1, near: 0.1, far: 100 });
  cam.aspect = 1;

  it('picks the DEFORMED surface of a posed skinned mesh, not the rest pose', () => {
    const picker = new MeshPicker();
    const mesh = makeQuad();
    const skel = makeSkeleton();
    mesh.skeleton = skel; mesh.skeletonId = 'sk';

    // At rest the quad sits at the origin → the centre pixel ray (world x=0) hits it there.
    const rest = picker.pickMesh(50, 50, 100, 100, cam, [mesh]);
    expect(rest).not.toBeNull();
    expect(Math.abs(rest!.hitPoint[0])).toBeLessThan(0.05);

    // POSE: translate the root joint +0.5 in X. The quad now spans x∈[0.3,0.7].
    skel.setJointPosition(0, [0.5, 0, 0]);

    // The centre pixel (world x=0) now MISSES — proof the picker uses the deformed geometry, not the rest quad.
    expect(picker.pickMesh(50, 50, 100, 100, cam, [mesh])).toBeNull();

    // The pixel at world x=0.5 (pixel 75) HITS the shifted quad.
    const posed = picker.pickMesh(75, 50, 100, 100, cam, [mesh]);
    expect(posed).not.toBeNull();
    expect(posed!.hitPoint[0]).toBeGreaterThan(0.3);
  });

  it('a non-skinned mesh is unaffected (picks its base geometry)', () => {
    const picker = new MeshPicker();
    const mesh = makeQuad();
    // No skeleton attached → the skinned path is skipped; the base quad at origin is picked normally.
    mesh.skeleton = null; mesh.skeletonId = null;
    const hit = picker.pickMesh(50, 50, 100, 100, cam, [mesh]);
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.hitPoint[0])).toBeLessThan(0.05);
  });
});
