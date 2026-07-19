/**
 * src/packaging/fold-mesh.ts — the fold-mesh geometry compiler.
 *
 * Given a flat net (panel tree) and a fold amount 0..1, produce the 3D MeshGeometry
 * of the (partially) folded box. foldAmount 0 = flat dieline, 1 = closed box. Pure
 * function — no GPU, no scene graph; the manager calls this and uploads the result.
 *
 * Algorithm: each panel's world transform = parent.world × R(hinge, targetAngle·amount),
 * composed up the tree (so children cascade with their parent). Then each panel is
 * fan-triangulated with a normal recomputed from its CURRENT (folded) world plane.
 */

import { mat4, vec3 } from 'gl-matrix';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { FoldMeshData } from './types';

/** Rotation (mat4) by `angle` rad around the 3D line through a→b. T(a)·R(axis)·T(-a). */
function rotateAroundLine(a: vec3, b: vec3, angle: number): mat4 {
  const axis = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), b, a));
  const m = mat4.create();
  mat4.translate(m, m, a);                                    // T(a)
  mat4.multiply(m, m, mat4.fromRotation(mat4.create(), angle, axis)); // · R(axis, angle)
  mat4.translate(m, m, [-a[0], -a[1], -a[2]]);               // · T(-a)
  return m;
}

/** Outward-ish unit normal of a (planar) polygon from its first non-degenerate triangle. */
function polygonNormal(pts: vec3[]): vec3 {
  const n = vec3.create();
  for (let i = 1; i < pts.length - 1; i++) {
    const e1 = vec3.subtract(vec3.create(), pts[i], pts[0]);
    const e2 = vec3.subtract(vec3.create(), pts[i + 1], pts[0]);
    vec3.cross(n, e1, e2);
    if (vec3.length(n) > 1e-6) { return vec3.normalize(n, n); }
  }
  return vec3.fromValues(0, 1, 0);
}

/**
 * Compile the net at `foldAmount` (0 flat → 1 folded) into MeshGeometry.
 * '8float' (pos+normal+uv); Mesh3D.setGeometry computes tangents.
 */
export function compileFoldMesh(data: FoldMeshData, foldAmount: number): MeshGeometry {
  const amt = Math.max(0, Math.min(1, foldAmount));
  const panels = data.panels;
  const world: (mat4 | null)[] = new Array(panels.length).fill(null);

  const worldOf = (i: number): mat4 => {
    const cached = world[i];
    if (cached) return cached;
    const p = panels[i];
    let m: mat4;
    if (p.parentPanelIndex < 0 || !p.hinge) {
      m = mat4.create();   // root: flat in the XZ plane (identity)
    } else {
      const parent = worldOf(p.parentPanelIndex);
      const a = vec3.fromValues(p.hinge[0][0], 0, p.hinge[0][1]);   // hinge in flat net coords (x,0,z)
      const b = vec3.fromValues(p.hinge[1][0], 0, p.hinge[1][1]);
      const r = rotateAroundLine(a, b, (p.targetAngle * amt) * Math.PI / 180);
      m = mat4.multiply(mat4.create(), parent, r);   // parent · R  (R applied in the parent's local frame)
    }
    world[i] = m;
    return m;
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const m = worldOf(i);
    const wpts = p.corners.map(c =>
      vec3.transformMat4(vec3.create(), vec3.fromValues(c[0], 0, c[1]), m));
    const nrm = polygonNormal(wpts);
    const base = positions.length / 3;
    for (let k = 0; k < wpts.length; k++) {
      positions.push(wpts[k][0], wpts[k][1], wpts[k][2]);
      normals.push(nrm[0], nrm[1], nrm[2]);
      uvs.push(p.uvs[k][0], p.uvs[k][1]);
    }
    for (let k = 1; k < wpts.length - 1; k++) {   // fan triangulate
      indices.push(base, base + k, base + k + 1);
    }
  }

  const vc = positions.length / 3;
  const verts = new Float32Array(vc * 8);
  for (let v = 0; v < vc; v++) {
    verts[v * 8 + 0] = positions[v * 3 + 0];
    verts[v * 8 + 1] = positions[v * 3 + 1];
    verts[v * 8 + 2] = positions[v * 3 + 2];
    verts[v * 8 + 3] = normals[v * 3 + 0];
    verts[v * 8 + 4] = normals[v * 3 + 1];
    verts[v * 8 + 5] = normals[v * 3 + 2];
    verts[v * 8 + 6] = uvs[v * 2 + 0];
    verts[v * 8 + 7] = uvs[v * 2 + 1];
  }
  return { vertices: verts, indices: new Uint32Array(indices), format: '8float' };
}
