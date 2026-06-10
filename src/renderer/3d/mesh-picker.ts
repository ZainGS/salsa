/**
 * MeshPicker — CPU-side ray casting for 3D mesh picking.
 *
 * Casts a ray from screen coordinates through the camera, then tests each
 * Mesh3D using one of two strategies depending on whether the mesh geometry is static:
 *
 *   Static mesh (gpuDirty = false):
 *     BVH traversal — O(log N) per mesh. Built once on first pick, cached.
 *
 *   Dynamic mesh (gpuDirty = true, e.g. cloth simulation):
 *     Linear scan with AABB pre-rejection — O(N) per mesh.
 *     BVH is evicted so it will be rebuilt fresh once geometry settles.
 *
 * The BVH and all intersection math use scalar arithmetic — zero heap
 * allocations in the hot path for either strategy.
 */

import { mat4, vec3, vec4 } from 'gl-matrix';
import { Camera3D } from './camera-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { FLOATS_PER_VERT } from './mesh-generators';
import { MeshBVH } from './mesh-bvh';

export interface PickResult {
  mesh: Mesh3D;
  /** World-space distance from the camera origin to the hit point. */
  distance: number;
  /** Index of the first triangle vertex in the indices array (triangleIndex * 3). */
  triangleIndex: number;
  hitPoint: [number, number, number];
  /** World-space face normal (flat, from triangle edge cross-product). */
  faceNormal: [number, number, number];
  /**
   * Barycentric coordinates of the hit point within the triangle.
   * Weights for vertices at indices[tri*3+1] and indices[tri*3+2].
   * Weight for indices[tri*3+0] = 1 - baryU - baryV.
   */
  baryU: number;
  baryV: number;
}

const EPSILON = 1e-7;

export class MeshPicker {

  // ── Pre-allocated scratch buffers — never allocated in the hot path ──────────

  private readonly _scratchVP    = mat4.create();
  private readonly _scratchInvVP = mat4.create();
  private readonly _nearH        = vec4.create();
  private readonly _farH         = vec4.create();
  private readonly _nearPt       = vec3.create();
  private readonly _farPt        = vec3.create();
  private readonly _rayDir       = vec3.create();

  private readonly _invModel     = mat4.create();
  private readonly _lO4          = vec4.create();
  private readonly _lD4          = vec4.create();
  private readonly _lO           = vec3.create();
  private readonly _lD           = vec3.create();

  // Used only in the linear-scan fallback path
  private readonly _v0           = vec3.create();
  private readonly _v1           = vec3.create();
  private readonly _v2           = vec3.create();
  private readonly _edge1        = vec3.create();
  private readonly _edge2        = vec3.create();
  private readonly _h            = vec3.create();
  private readonly _s            = vec3.create();
  private readonly _q            = vec3.create();

  private readonly _lHit         = vec3.create();
  private readonly _wHit4        = vec4.create();
  private readonly _wHit         = vec3.create();
  private readonly _lNorm        = vec3.create();
  private readonly _wNorm        = vec3.create();

  // ── Caches ───────────────────────────────────────────────────────────────────

  // BVH per mesh — built on first pick of a static mesh, evicted when gpuDirty.
  private readonly _bvhCache  = new Map<string, MeshBVH>();

  // AABB per mesh — used only for the linear-scan fallback (dynamic meshes).
  private readonly _aabbCache = new Map<string, { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null>();

  /**
   * Compute a world-space ray from a canvas pixel position.
   * mouseX/Y and canvasWidth/Height must be in the same pixel space.
   */
  castRay(
    mouseX: number,
    mouseY: number,
    canvasWidth: number,
    canvasHeight: number,
    camera: Camera3D,
  ): { origin: vec3; dir: vec3 } {
    const ndcX = (2 * mouseX) / canvasWidth  - 1;
    const ndcY = 1 - (2 * mouseY) / canvasHeight;

    mat4.copy(this._scratchVP, camera.getViewProjectionMatrix() as mat4);
    mat4.invert(this._scratchInvVP, this._scratchVP);

    vec4.set(this._nearH, ndcX, ndcY, 0, 1);
    vec4.transformMat4(this._nearH, this._nearH, this._scratchInvVP);
    vec4.set(this._farH, ndcX, ndcY, 1, 1);
    vec4.transformMat4(this._farH, this._farH, this._scratchInvVP);

    const nw = this._nearH[3], fw = this._farH[3];
    vec3.set(this._nearPt, this._nearH[0] / nw, this._nearH[1] / nw, this._nearH[2] / nw);
    vec3.set(this._farPt,  this._farH[0]  / fw, this._farH[1]  / fw, this._farH[2]  / fw);

    vec3.subtract(this._rayDir, this._farPt, this._nearPt);
    vec3.normalize(this._rayDir, this._rayDir);

    return { origin: this._nearPt, dir: this._rayDir };
  }

  /**
   * Pick the closest Mesh3D under the given canvas position.
   */
  pickMesh(
    mouseX: number,
    mouseY: number,
    canvasWidth: number,
    canvasHeight: number,
    camera: Camera3D,
    meshes: Mesh3D[],
  ): PickResult | null {
    const { origin, dir } = this.castRay(mouseX, mouseY, canvasWidth, canvasHeight, camera);
    let closest: PickResult | null = null;

    for (const mesh of meshes) {
      if (!mesh.visible) continue;
      const hit = this.intersectMesh(origin, dir, mesh);
      if (hit && (!closest || hit.distance < closest.distance)) {
        closest = { mesh, ...hit };
      }
    }
    return closest;
  }

  /**
   * Evict all cached state for a mesh (BVH + AABB).
   * Call when the mesh is removed from the scene.
   */
  evictMesh(meshId: string): void {
    this._bvhCache.delete(meshId);
    this._aabbCache.delete(meshId);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private intersectMesh(
    rayOrigin: vec3,
    rayDir:    vec3,
    mesh:      Mesh3D,
  ): { distance: number; triangleIndex: number; hitPoint: [number, number, number]; faceNormal: [number, number, number]; baryU: number; baryV: number } | null {
    const geom = mesh.geometry;
    if (!geom || geom.vertices.length === 0) return null;

    const modelMat = mesh.localMatrix as mat4;
    if (!mat4.invert(this._invModel, modelMat)) return null;

    // Transform ray into local (object) space — valid for all transforms.
    vec4.set(this._lO4, rayOrigin[0], rayOrigin[1], rayOrigin[2], 1);
    vec4.transformMat4(this._lO4, this._lO4, this._invModel);
    vec4.set(this._lD4, rayDir[0], rayDir[1], rayDir[2], 0);
    vec4.transformMat4(this._lD4, this._lD4, this._invModel);

    const w = this._lO4[3];
    vec3.set(this._lO, this._lO4[0] / w, this._lO4[1] / w, this._lO4[2] / w);
    vec3.set(this._lD, this._lD4[0], this._lD4[1], this._lD4[2]);
    vec3.normalize(this._lD, this._lD);

    const verts  = geom.vertices;
    const idxs   = geom.indices;
    const ox = this._lO[0], oy = this._lO[1], oz = this._lO[2];
    const dx = this._lD[0], dy = this._lD[1], dz = this._lD[2];

    let hitT   = Infinity;
    let hitTri = -1;
    let hitU   = 0;
    let hitV   = 0;

    if (!mesh.gpuDirty) {
      // ── BVH path — static geometry ──────────────────────────────────────────
      let bvh = this._bvhCache.get(mesh.id);
      if (!bvh) {
        bvh = MeshBVH.build(verts, idxs);
        this._bvhCache.set(mesh.id, bvh);
      }
      const hit = bvh.intersect(ox, oy, oz, dx, dy, dz);
      if (!hit) return null;
      hitT   = hit.t;
      hitTri = hit.triIndex;

      // Re-run MT on the winning triangle to recover barycentric u,v.
      const stride = FLOATS_PER_VERT;
      const idx3 = hitTri * 3;
      const i0 = idxs[idx3]     * stride;
      const i1 = idxs[idx3 + 1] * stride;
      const i2 = idxs[idx3 + 2] * stride;
      const ax = verts[i0], ay = verts[i0+1], az = verts[i0+2];
      const bx = verts[i1], by = verts[i1+1], bz = verts[i1+2];
      const cx = verts[i2], cy = verts[i2+1], cz = verts[i2+2];
      const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
      const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
      const hhx = dy*e2z - dz*e2y, hhy = dz*e2x - dx*e2z, hhz = dx*e2y - dy*e2x;
      const af = 1 / (e1x*hhx + e1y*hhy + e1z*hhz);
      const sx = ox-ax, sy = oy-ay, sz = oz-az;
      hitU = af * (sx*hhx + sy*hhy + sz*hhz);
      const qx = sy*e1z - sz*e1y, qy = sz*e1x - sx*e1z, qz = sx*e1y - sy*e1x;
      hitV = af * (dx*qx + dy*qy + dz*qz);
    } else {
      // ── Linear scan — dynamic geometry (cloth, live edits) ─────────────────
      // Evict stale BVH so it will be rebuilt once geometry settles.
      this._bvhCache.delete(mesh.id);

      // AABB pre-rejection: skip all triangles on a clear miss.
      let aabb = this._aabbCache.get(mesh.id);
      if (aabb === undefined || mesh.gpuDirty) {
        aabb = computeAABB(verts);
        this._aabbCache.set(mesh.id, aabb);
      }
      if (aabb && !aabbHit(ox, oy, oz, dx, dy, dz, aabb)) return null;

      const stride = FLOATS_PER_VERT;
      for (let i = 0; i < idxs.length; i += 3) {
        const i0 = idxs[i]     * stride;
        const i1 = idxs[i + 1] * stride;
        const i2 = idxs[i + 2] * stride;

        vec3.set(this._v0, verts[i0], verts[i0 + 1], verts[i0 + 2]);
        vec3.set(this._v1, verts[i1], verts[i1 + 1], verts[i1 + 2]);
        vec3.set(this._v2, verts[i2], verts[i2 + 1], verts[i2 + 2]);

        const res = rayTriangleUV(this._lO, this._lD, this._v0, this._v1, this._v2,
                                  this._edge1, this._edge2, this._h, this._s, this._q);
        if (res !== null && res.t > EPSILON && res.t < hitT) {
          hitT   = res.t;
          hitTri = i / 3;
          hitU   = res.u;
          hitV   = res.v;
        }
      }
      if (hitTri < 0) return null;
    }

    // Convert local-space hit point back to world space
    vec3.scaleAndAdd(this._lHit, this._lO, this._lD, hitT);
    vec4.set(this._wHit4, this._lHit[0], this._lHit[1], this._lHit[2], 1);
    vec4.transformMat4(this._wHit4, this._wHit4, modelMat);
    const ww = this._wHit4[3];
    vec3.set(this._wHit, this._wHit4[0] / ww, this._wHit4[1] / ww, this._wHit4[2] / ww);

    // Compute local-space face normal from triangle edge cross product, then
    // transform to world space via transpose(inverse(modelMat)) = transpose(_invModel).
    // _invModel is already in scope (computed above via mat4.invert).
    {
      const stride = FLOATS_PER_VERT;
      const idx3 = hitTri * 3;
      const geom2 = mesh.geometry!;
      const v = geom2.vertices, ix = geom2.indices;
      const i0 = ix[idx3]     * stride;
      const i1 = ix[idx3 + 1] * stride;
      const i2 = ix[idx3 + 2] * stride;
      const e1x = v[i1] - v[i0], e1y = v[i1+1] - v[i0+1], e1z = v[i1+2] - v[i0+2];
      const e2x = v[i2] - v[i0], e2y = v[i2+1] - v[i0+1], e2z = v[i2+2] - v[i0+2];
      const lnx = e1y*e2z - e1z*e2y;
      const lny = e1z*e2x - e1x*e2z;
      const lnz = e1x*e2y - e1y*e2x;
      // Normal matrix = transpose(_invModel); apply to local normal (w=0)
      const im = this._invModel;
      const wnx = im[0]*lnx + im[1]*lny + im[2]*lnz;
      const wny = im[4]*lnx + im[5]*lny + im[6]*lnz;
      const wnz = im[8]*lnx + im[9]*lny + im[10]*lnz;
      const wlen = Math.sqrt(wnx*wnx + wny*wny + wnz*wnz) || 1;
      vec3.set(this._wNorm, wnx / wlen, wny / wlen, wnz / wlen);
    }

    return {
      distance:      vec3.distance(rayOrigin, this._wHit),
      triangleIndex: hitTri,
      hitPoint:      [this._wHit[0], this._wHit[1], this._wHit[2]],
      faceNormal:    [this._wNorm[0], this._wNorm[1], this._wNorm[2]],
      baryU:         hitU,
      baryV:         hitV,
    };
  }
}

// ── Module-private helpers ───────────────────────────────────────────────────

function computeAABB(verts: Float32Array): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
  if (verts.length === 0) return null;
  const s = FLOATS_PER_VERT;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += s) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function aabbHit(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  b: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): boolean {
  let tMin = -Infinity, tMax = Infinity;
  for (let a = 0; a < 3; a++) {
    const o  = a === 0 ? ox : a === 1 ? oy : oz;
    const d  = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = a === 0 ? b.minX : a === 1 ? b.minY : b.minZ;
    const hi = a === 0 ? b.maxX : a === 1 ? b.maxY : b.maxZ;
    if (Math.abs(d) < EPSILON) {
      if (o < lo || o > hi) return false;
    } else {
      const inv = 1 / d;
      let t1 = (lo - o) * inv, t2 = (hi - o) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
  }
  return tMax >= 0;
}

function rayTriangleUV(
  origin: vec3, dir: vec3, v0: vec3, v1: vec3, v2: vec3,
  edge1: vec3, edge2: vec3, h: vec3, s: vec3, q: vec3,
): { t: number; u: number; v: number } | null {
  vec3.subtract(edge1, v1, v0);
  vec3.subtract(edge2, v2, v0);
  vec3.cross(h, dir, edge2);
  const a = vec3.dot(edge1, h);
  if (a > -EPSILON && a < EPSILON) return null;
  const f = 1 / a;
  vec3.subtract(s, origin, v0);
  const u = f * vec3.dot(s, h);
  if (u < 0 || u > 1) return null;
  vec3.cross(q, s, edge1);
  const v = f * vec3.dot(dir, q);
  if (v < 0 || u + v > 1) return null;
  const t = f * vec3.dot(edge2, q);
  return t > EPSILON ? { t, u, v } : null;
}
