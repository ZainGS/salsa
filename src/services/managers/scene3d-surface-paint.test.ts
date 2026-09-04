import { describe, it, expect } from 'vitest';

import { Scene3DSurfacePaint, type Scene3DSurfacePaintHost } from './scene3d-surface-paint';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import type { MeshPicker } from '../../renderer/3d/mesh-picker';
import type { ManagerContext } from './manager-context';

// §5.1 extraction: the valuable, deterministic core of surface-paint is the raycast→barycentric-UV mapping.
// (The pointer-listener enter()/enterMulti() paths are browser-gated and verified in-app.) We mock the picker to
// return a chosen hit and assert screenToMeshUV3D interpolates the triangle's vertex UVs by the pick's bary weights.

const STRIDE = 12; // FLOATS_PER_VERT; UV at offset 6,7

/** One triangle: v0 uv=(0,0), v1 uv=(1,0), v2 uv=(0,1). */
function triMesh(id: string): Mesh3D {
  const verts = new Float32Array(STRIDE * 3);
  verts[0 * STRIDE + 6] = 0; verts[0 * STRIDE + 7] = 0;
  verts[1 * STRIDE + 6] = 1; verts[1 * STRIDE + 7] = 0;
  verts[2 * STRIDE + 6] = 0; verts[2 * STRIDE + 7] = 1;
  return { id, geometry: { vertices: verts, indices: new Uint32Array([0, 1, 2]) } } as unknown as Mesh3D;
}

type Hit = { mesh: Mesh3D; triangleIndex: number; baryU: number; baryV: number } | null;

function makeEnv(mesh: Mesh3D | null, hit: Hit) {
  const ctx = {
    webgpuRenderer: { getCanvas: () => ({ width: 100, height: 100 }) },
  } as unknown as ManagerContext;
  const host: Scene3DSurfacePaintHost = {
    getMesh: () => mesh,
    getPicker: () => ({ pickMesh: () => hit } as unknown as MeshPicker),
    getCamera: () => ({} as Camera3D),
  };
  return new Scene3DSurfacePaint(ctx, host);
}

const RECT = { left: 0, top: 0, width: 100, height: 100 };

describe('§5.1 Scene3DSurfacePaint (extracted subsystem)', () => {
  it('interpolates the hit triangle UVs by the pick barycentric weights', () => {
    const mesh = triMesh('m1');
    const sp = makeEnv(mesh, { mesh, triangleIndex: 0, baryU: 0.5, baryV: 0.5 });
    // w0 = 1 - 0.5 - 0.5 = 0 → uv = 0.5*(1,0) + 0.5*(0,1) = (0.5, 0.5)
    expect(sp.screenToMeshUV3D(50, 50, RECT, 'm1')).toEqual({ u: 0.5, v: 0.5 });
  });

  it('returns the first vertex UV when the hit sits on vertex 0 (bary 0,0)', () => {
    const mesh = triMesh('m1');
    const sp = makeEnv(mesh, { mesh, triangleIndex: 0, baryU: 0, baryV: 0 });
    expect(sp.screenToMeshUV3D(1, 1, RECT, 'm1')).toEqual({ u: 0, v: 0 });
  });

  it('returns null when the mesh does not exist', () => {
    const sp = makeEnv(null, null);
    expect(sp.screenToMeshUV3D(50, 50, RECT, 'gone')).toBeNull();
  });

  it('returns null when the ray misses (picker returns null)', () => {
    const mesh = triMesh('m1');
    const sp = makeEnv(mesh, null);
    expect(sp.screenToMeshUV3D(50, 50, RECT, 'm1')).toBeNull();
  });

  it('returns null when the pick lands on a DIFFERENT mesh than requested', () => {
    const mesh = triMesh('m1');
    const other = triMesh('other');
    const sp = makeEnv(mesh, { mesh: other, triangleIndex: 0, baryU: 0.2, baryV: 0.2 });
    expect(sp.screenToMeshUV3D(50, 50, RECT, 'm1')).toBeNull();
  });
});
