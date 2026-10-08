/**
 * Regenerate a mesh in place from its generator settings (mesh-generator.ts) — the live Add Mesh settings panel.
 * Keeps the node (id, transform, material, keyframes, outline …) and replaces only its geometry; a creature also
 * re-places / replaces the eye spheres it owns (MeshGeneratorRecord.parts).
 */

import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { MeshGeneratorType } from '../../scene-graph/shapes/mesh-generator';
import type { SdfBlob } from '../../scene-graph/shapes/sdf-mesh';
import { buildCreatureBlobs, creatureEyes, type CreatureParams } from './creature-generator';

export interface MeshGeneratorRegenHost {
  getMesh(id: string): Mesh3D | null;
  /** Add a creature eye sphere at a WORLD position, scene root, WITHOUT selecting it (the panel keeps the body). */
  addEye(x: number, y: number, z: number, radius: number): Mesh3D;
  removeMesh(id: string): void;
}

const EYE_SEGMENTS = { widthSegments: 10, heightSegments: 7 };

/** Rebuild `mesh` from (already normalized) `params`. Returns the generator's part ids (a creature's eyes) or
 *  undefined when the type owns none. */
export function regenerateMeshFromGenerator(mesh: Mesh3D, type: MeshGeneratorType, p: Record<string, any>, host: MeshGeneratorRegenHost): string[] | undefined {
  switch (type) {
    case 'cylinder':
      mesh.resetToPrimitive('cylinder', { radius: p.radius, radiusTop: p.radiusTop, height: p.height, radialSegments: p.segments });
      return undefined;
    case 'revolve':
      mesh.resetToPrimitive('revolve', { profile: p.profile, radialSegments: p.segments });
      return undefined;
    case 'tube':
      mesh.resetToPrimitive('tube', { path: p.path, radii: p.radii, radialSegments: p.segments });
      return undefined;
    case 'metaball':
      mesh.resetToPrimitive('metaball', { blobs: p.blobs as SdfBlob[], resolution: p.resolution, decimate: p.decimate < 1 ? p.decimate : undefined });
      return undefined;
    case 'circle':
      mesh.editMesh = EditMesh.fromCircle(p.radius, p.segments, p.height);
      mesh.syncFromEditMesh();
      return undefined;
    case 'polygon':
      mesh.editMesh = EditMesh.fromPolygon(p.points, p.height);
      mesh.syncFromEditMesh();
      return undefined;
    case 'creature': {
      const cp = p as CreatureParams & { resolution: number };
      const dec = cp.decimate ?? 0.4;
      mesh.resetToPrimitive('metaball', { blobs: buildCreatureBlobs(cp), resolution: cp.resolution, decimate: dec > 0 && dec < 1 ? dec : undefined });
      return placeCreatureEyes(mesh, cp, host);
    }
  }
  return undefined;
}

/** Eyes follow the body's current transform (it may have been moved / turned / scaled since it was added): reuse the
 *  existing pair, or replace them; none when eyes are off. */
function placeCreatureEyes(body: Mesh3D, p: CreatureParams, host: MeshGeneratorRegenHost): string[] {
  const old = (body.generator?.parts ?? []).map((id) => host.getMesh(id)).filter((m): m is Mesh3D => !!m);
  const eyes = p.eyes === false ? [] : creatureEyes(p);
  if (old.length !== eyes.length) {
    for (const m of old) host.removeMesh(m.id);
    old.length = 0;
  }
  const M = body.localMatrix as unknown as ArrayLike<number>;
  const ids: string[] = [];
  eyes.forEach((e, i) => {
    const [x, y, z] = e.pos;
    const wx = M[0] * x + M[4] * y + M[8] * z + M[12];
    const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
    const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
    let eye = old[i];
    if (eye) {
      eye.setPosition3D(wx, wy, wz);
      eye.setPrimitive('sphere', { radius: e.radius, ...EYE_SEGMENTS });
    } else {
      eye = host.addEye(wx, wy, wz, e.radius);
    }
    eye.setRotation3D(body.rotationX, body.rotationY, body.rotation);
    eye.setScale3D(body.scaleX, body.scaleY, body.scaleZ);
    ids.push(eye.id);
  });
  return ids;
}
