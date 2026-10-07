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
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
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
  /** P6 A/B switch for the raycastWorld world-box prefilter (false = test every candidate mesh, the old path). */
  static worldBoxPrefilter = true;

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

  // CPU-skinned positions per skinned mesh — rebuilt when the skeleton pose changes (poseVersion).
  // `src`: the base vertex array it was skinned from (a geometry rebuild re-skins). `bvh`: a BVH over THIS pose's
  // verts, built once the pose has held still for a few picks (see _skinnedBVH) — dropped with the pose.
  private readonly _skinCache = new Map<string, {
    poseVer: number; verts: Float32Array; src: Float32Array; epoch: number;
    firstPickAt: number; picks: number; bvh: MeshBVH | null; bvhIdx?: Uint32Array;
  }>();
  /** A skinned pose must have been picked this many times, over at least SKIN_BVH_SETTLE_MS, before it gets a BVH:
   *  a pose that changes every frame (a live idle / clip) keeps the linear scan (one scan per pose is cheaper than a
   *  build per pose); a still pose (UV paint with the idle paused, a posed character) is picked in O(log n). */
  static readonly SKIN_BVH_MIN_PICKS = 3;
  static readonly SKIN_BVH_SETTLE_MS = 50;
  private readonly _ident = mat4.create();

  /**
   * CPU-skin a skinned mesh's positions into a copy of its 12-float vertex buffer (positions overwritten;
   * normals/uv left as base — picking needs positions + topology only). Returns the deformed verts + the model
   * matrix to pick with (IDENTITY for transformViaSkeleton meshes, whose object transform is baked into the skin
   * matrices; else the mesh's own model matrix). null for non-skinned meshes → the caller uses base geometry.
   * At rest this reproduces base×localMatrix exactly, so it only *changes* results once the rig is posed.
   */
  private _skinnedDeform(mesh: Mesh3D): { verts: Float32Array; modelMat: mat4 } | null {
    if (!(mesh instanceof SkinnedMesh3D)) return null;
    this._syncBlend(mesh);
    const skel = mesh.skeleton, base = mesh.geometry, ji = mesh.jointIndices, jw = mesh.jointWeights;
    if (!skel || !base || !ji || !jw || skel.skinMatrices.length === 0) return null;
    let cached = this._skinCache.get(mesh.id);
    if (!cached || cached.poseVer !== skel.poseVersion || cached.verts.length !== base.vertices.length || cached.src !== base.vertices) {
      const M = skel.skinMatrices, stride = FLOATS_PER_VERT, n = base.vertices.length / stride;
      // mobile-parity 7.3b P2: re-skin INTO the cached array (a fresh base.vertices.slice() per pose version was a
      // full-mesh allocation per pick during idle animation). Seeded from base so normals / UVs / unweighted
      // positions are the base values, exactly like the copy was. (Its skinned BVH is keyed to this pose — see below.)
      const verts = cached && cached.verts.length === base.vertices.length ? cached.verts : new Float32Array(base.vertices.length);
      verts.set(base.vertices);
      for (let v = 0; v < n; v++) {
        const o = v * stride;
        const bx = base.vertices[o], by = base.vertices[o + 1], bz = base.vertices[o + 2];
        let px = 0, py = 0, pz = 0, wsum = 0;
        for (let k = 0; k < 4; k++) {
          const w = jw[v * 4 + k];
          if (w === 0) continue;
          const j = ji[v * 4 + k] * 16;
          px += w * (M[j] * bx + M[j + 4] * by + M[j + 8] * bz + M[j + 12]);
          py += w * (M[j + 1] * bx + M[j + 5] * by + M[j + 9] * bz + M[j + 13]);
          pz += w * (M[j + 2] * bx + M[j + 6] * by + M[j + 10] * bz + M[j + 14]);
          wsum += w;
        }
        if (wsum > 1e-6) { verts[o] = px; verts[o + 1] = py; verts[o + 2] = pz; }   // else keep the base (unweighted) position
      }
      cached = { poseVer: skel.poseVersion, verts, src: base.vertices, epoch: (cached?.epoch ?? 0) + 1, firstPickAt: -1, picks: 0, bvh: null };
      this._skinCache.set(mesh.id, cached);
    }
    return { verts: cached.verts, modelMat: (mesh.transformViaSkeleton ? this._ident : mesh.localMatrix) as mat4 };
  }

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
    includeNonPickable = false,
  ): PickResult | null {
    const { origin, dir } = this.castRay(mouseX, mouseY, canvasWidth, canvasHeight, camera);
    let closest: PickResult | null = null;

    for (const mesh of meshes) {
      // `pickable` is off for DECORATION (the whole city) so selection/hover stay fast. Decal placement needs
      // to land on those surfaces, so it opts INTO them via includeNonPickable — it still pays the BVH build
      // for the city, but only while the decal tool is dragging, which is fine.
      if (!mesh.visible || (!mesh.pickable && !includeNonPickable)) continue;
      const hit = this.intersectMesh(origin, dir, mesh);
      if (hit && (!closest || hit.distance < closest.distance)) {
        closest = { mesh, ...hit };
      }
    }
    return closest;
  }

  /**
   * Cast an arbitrary WORLD-space ray (origin + direction) at a set of meshes and return the closest hit. Unlike
   * pickMesh (which builds the ray from a screen position), this takes the ray directly — used by Play-mode ground
   * and wall collision (downward / horizontal rays). `dir` need not be normalized. Pass includeNonPickable=true to
   * hit city decoration (which is non-pickable for selection speed).
   */
  raycastWorld(
    origin: vec3,
    dir: vec3,
    meshes: Mesh3D[],
    includeNonPickable = false,
    maxDist = Infinity,
    bvhBudget = false,
  ): PickResult | null {
    this._bvhBudgetOn = bvhBudget && MeshPicker.bvhBuildBudgetMs > 0;
    try { return this._raycastWorld(origin, dir, meshes, includeNonPickable, maxDist); } finally { this._bvhBudgetOn = false; }
  }
  /** performance-plan P10.D: BVH-build budget (ms per ~frame) for BUDGETED rays (the Play third-person camera). A
   *  streamed tiled city brings thousands of never-hit meshes near the player; the camera's ray bundle built their
   *  BVHs on first contact — seconds in one frame. Past the budget a mesh without a BVH is skipped for this frame (it
   *  is built on a later frame). 0 = unbudgeted (the old behaviour). */
  static bvhBuildBudgetMs = 4;
  private _bvhBudgetOn = false;
  /** Count of meshes skipped by the BVH budget (callers compare before / after a ray to know a result is partial). */
  bvhSkips = 0;
  private _bvhWindowAt = -1e9;
  private _bvhSpent = 0;
  private _raycastWorld(origin: vec3, dir: vec3, meshes: Mesh3D[], includeNonPickable: boolean, maxDist: number): PickResult | null {
    let closest: PickResult | null = null;
    // P6 (performance-plan.md): a cheap world-AABB slab test rejects a mesh before the matrix inverse + BVH walk. A
    // Play collision ray (ground / walls / the 5-ray camera bundle, ~10 a frame) gets ~500 broadphase candidates in a
    // city, and almost all of them miss. The box bounds every hit, so its entry distance is a lower bound on the hit
    // distance: a mesh whose box is entered beyond maxDist, or no nearer than the best hit so far, cannot win. The
    // result is the same as testing every mesh (the box is padded for float slack).
    if (!MeshPicker.worldBoxPrefilter) {
      for (const mesh of meshes) {
        if (!mesh.visible || (!mesh.pickable && !includeNonPickable)) continue;
        const hit = this.intersectMesh(origin, dir, mesh);
        if (hit && (!closest || hit.distance < closest.distance)) closest = { mesh, ...hit };
      }
      return closest;
    }
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const dl = Math.hypot(dir[0], dir[1], dir[2]);
    const ux = dl > 0 ? dir[0] / dl : 0, uy = dl > 0 ? dir[1] / dl : 0, uz = dl > 0 ? dir[2] / dl : 0;
    // Pass 1: box entry distance per candidate (misses / beyond maxDist dropped). Boxes come from a per-LIST cache when
    // the caller re-sends the same array (the Play collision hood), else from the per-mesh cache.
    const n = meshes.length;
    if (this._rcT.length < n) { this._rcT = new Float64Array(n * 2); }
    const T = this._rcT, order = this._rcOrder;
    order.length = 0;
    const listCache = this._listBoxes(meshes);
    for (let i = 0; i < n; i++) {
      const mesh = meshes[i];
      if (!mesh.visible || (!mesh.pickable && !includeNonPickable) || this._detached.has(mesh)) continue;
      let tIn = 0;
      if (dl > 0) {
        let b: Float64Array | null, bo = 0;
        if (listCache) { bo = this._listBoxAt(listCache, i, mesh); b = bo >= 0 ? listCache.boxes : null; }
        else b = this._worldBoxOf(mesh);
        if (b) {
          const t = slabEntry(ox, oy, oz, ux, uy, uz, b, bo);
          if (t === null || t > maxDist) continue;
          tIn = t;
        }
      }
      T[i] = tIn;
      order.push(i);
    }
    // Pass 2: nearest boxes first, stopping once a box starts beyond the best hit. Ties on the hit distance go to the
    // EARLIER list entry, exactly as the plain list walk resolves them.
    if (order.length > 1) order.sort((a, b) => T[a] - T[b] || a - b);
    let bestIdx = -1;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      if (closest && T[i] > closest.distance) break;
      const mesh = meshes[i];
      const hit = this.intersectMesh(origin, dir, mesh, closest ? Math.min(maxDist, closest.distance) : maxDist);
      if (hit && (!closest || hit.distance < closest.distance || (hit.distance === closest.distance && i < bestIdx))) { closest = { mesh, ...hit }; bestIdx = i; }
    }
    return closest;
  }

  /**
   * P6 (performance-plan.md): may any triangle of `mesh` (at its CURRENT transform) lie inside the world box
   * [minX, minY, minZ, maxX, maxY, maxZ]? Conservative, never a false negative — used to pre-filter the Play collision
   * candidates to the meshes that actually reach into the neighbourhood around the character (see CollisionHood).
   * Skinned / dynamic (gpuDirty) / degenerate cases answer true (always kept).
   */
  meshMayTouchWorldBox(mesh: Mesh3D, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    this._syncBlend(mesh);
    const geom = mesh.geometry;
    if (!geom || geom.vertices.length === 0) return true;
    if (mesh.gpuDirty || mesh instanceof SkinnedMesh3D) return true;
    const wb = this._worldBoxOf(mesh);
    if (!wb) return true;
    if (wb[3] < minX || wb[0] > maxX || wb[4] < minY || wb[1] > maxY || wb[5] < minZ || wb[2] > maxZ) return false;
    const modelMat = mesh.localMatrix as mat4;
    if (!mat4.invert(this._invModel, modelMat)) return true;
    const im = this._invModel;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let ci = 0; ci < 8; ci++) {
      const cx = ci & 1 ? maxX : minX, cy = ci & 2 ? maxY : minY, cz = ci & 4 ? maxZ : minZ;
      const X = im[0] * cx + im[4] * cy + im[8] * cz + im[12];
      const Y = im[1] * cx + im[5] * cy + im[9] * cz + im[13];
      const Z = im[2] * cx + im[6] * cy + im[10] * cz + im[14];
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
    }
    if (!Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1)) return true;
    // Pad for float slack in the inverse (a triangle exactly on the box face must not be dropped).
    const pad = 1e-5 * Math.max(1, x1 - x0, y1 - y0, z1 - z0, Math.abs(x0), Math.abs(y0), Math.abs(z0), Math.abs(x1), Math.abs(y1), Math.abs(z1));
    // No BVH yet: answer from the box alone (conservative) instead of building one here — a hood rebuild over ~900
    // meshes would otherwise build every BVH at once (~90 ms). A ray that reaches the mesh builds it lazily, as before.
    const bvh = this._bvhCache.get(mesh.id);
    if (!bvh) return true;
    return bvh.overlapsBox(x0 - pad, y0 - pad, z0 - pad, x1 + pad, y1 + pad, z1 + pad);
  }

  // P6 raycastWorld scratch: per-candidate box entry distances + the visit order.
  private _rcT = new Float64Array(256);
  private readonly _rcOrder: number[] = [];
  // P6 per-LIST box cache (the Play collision hood re-sends one list for many rays): boxes + the (matrix version,
  // geometry) each was computed for, so a ray costs no per-mesh map lookup.
  private _lbRef: Mesh3D[] | null = null;
  private _lb: ListBoxCache | null = null;
  private _listBoxes(meshes: Mesh3D[]): ListBoxCache | null {
    if (meshes.length < 16) return null;   // short lists: the per-mesh cache is as cheap
    if (this._lbRef === meshes && this._lb && this._lb.has.length >= meshes.length) return this._lb;
    if (this._lbRef !== meshes) {   // only cache an array seen twice in a row (scratch lists change contents per call)
      this._lbRef = meshes; this._lb = null; return null;
    }
    const n = Math.ceil(meshes.length * 1.25);
    this._lb = { boxes: new Float64Array(n * 6), ver: new Float64Array(n).fill(-1), geom: new Array(n).fill(null), mesh: new Array(n).fill(null), has: new Uint8Array(n) };
    return this._lb;
  }
  /** Box entry slot for list entry i: returns the box OFFSET into c.boxes (i * 6), or -1 when the mesh has no safe box.
   *  Validated per entry by mesh identity + matrix version + geometry, so a scratch array whose contents change is safe. */
  private _listBoxAt(c: ListBoxCache, i: number, mesh: Mesh3D): number {
    const ver = mesh.localMatrixVersion + mesh.blendVersion * 4294967296;   // (a blend-shape change re-derives the box)
    if (c.mesh[i] === mesh && c.ver[i] === ver && c.geom[i] === mesh.geometry && !mesh.gpuDirty) return c.has[i] ? i * 6 : -1;
    const b = this._worldBoxOf(mesh);
    c.mesh[i] = mesh; c.ver[i] = ver; c.geom[i] = mesh.geometry;
    if (b) { c.boxes.set(b, i * 6); c.has[i] = 1; return i * 6; }
    c.has[i] = 0;
    return -1;
  }

  /** P6: per-mesh WORLD bounding box for the raycastWorld prefilter, cached by (geometry object, matrix version), or
   *  null when no safe box exists (skinned / dynamic geometry — those keep their own exact paths). Padded by a small
   *  relative epsilon so a hit computed on the box face is never rejected by rounding. */
  private readonly _worldBoxCache = new Map<string, { geom: object; ver: number; b: Float64Array }>();
  private readonly _localBoxOfGeom = new WeakMap<object, Float64Array | null>();
  private _worldBoxOf(mesh: Mesh3D): Float64Array | null {
    this._syncBlend(mesh);
    if (mesh.gpuDirty || mesh instanceof SkinnedMesh3D) return null;
    const geom = mesh.geometry;
    if (!geom || geom.vertices.length === 0) return null;
    const ver = mesh.localMatrixVersion;
    const c = this._worldBoxCache.get(mesh.id);
    if (c && c.geom === geom && c.ver === ver) return c.b;
    let lb = this._localBoxOfGeom.get(geom);
    if (lb === undefined) {
      const a = computeAABB(geom.vertices);
      lb = a ? Float64Array.of(a.minX, a.minY, a.minZ, a.maxX, a.maxY, a.maxZ) : null;
      this._localBoxOfGeom.set(geom, lb);
    }
    if (!lb) return null;
    const m = mesh.localMatrix as unknown as Float32Array;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let ci = 0; ci < 8; ci++) {
      const cx = ci & 1 ? lb[3] : lb[0], cy = ci & 2 ? lb[4] : lb[1], cz = ci & 4 ? lb[5] : lb[2];
      const w = m[3] * cx + m[7] * cy + m[11] * cz + m[15];
      if (!(Math.abs(w - 1) < 1e-6)) return null;   // projective matrix: no affine box (never for scene meshes)
      const X = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
      const Y = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
      const Z = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
    }
    if (!Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1)) return null;
    const pad = 1e-4 * Math.max(1, x1 - x0, y1 - y0, z1 - z0, Math.abs(x0), Math.abs(y0), Math.abs(z0), Math.abs(x1), Math.abs(y1), Math.abs(z1));
    const b = c && c.b ? c.b : new Float64Array(6);
    b[0] = x0 - pad; b[1] = y0 - pad; b[2] = z0 - pad; b[3] = x1 + pad; b[4] = y1 + pad; b[5] = z1 + pad;
    if (c) { c.geom = geom; c.ver = ver; } else this._worldBoxCache.set(mesh.id, { geom, ver, b });
    return b;
  }

  /**
   * Sample the ground height under (x, z): cast a ray straight down from high above and return the y of the closest
   * hit, or null if nothing is under that column. `fromY` is the ray start height (default well above any scene).
   */
  sampleGroundHeight(
    x: number,
    z: number,
    meshes: Mesh3D[],
    fromY = 1e4,
    includeNonPickable = true,
  ): number | null {
    vec3.set(this._downOrigin, x, fromY, z);
    vec3.set(this._downDir, 0, -1, 0);
    const hit = this.raycastWorld(this._downOrigin, this._downDir, meshes, includeNonPickable);
    return hit ? hit.hitPoint[1] : null;
  }

  private _downOrigin: vec3 = vec3.create();
  private _downDir: vec3 = vec3.create();

  /**
   * Evict all cached state for a mesh (BVH + AABB).
   * Call when the mesh is removed from the scene.
   */
  /** performance-plan P10.D: meshes removed from the scene (streamed tiles) — a collision ray from a not-yet-refreshed
   *  broadphase list must neither hit them nor RE-BUILD their BVH after evictMesh (that BVH was then never freed: the
   *  Play heap grew ~100 MB/s walking a streamed city). Weak, so a dropped mesh is not kept alive by this set. */
  private readonly _detached = new WeakSet<Mesh3D>();
  setDetached(mesh: Mesh3D, detached: boolean): void { if (detached) this._detached.add(mesh); else this._detached.delete(mesh); }
  /** Diagnostics: per-mesh BVHs currently cached. */
  bvhCount(): number { return this._bvhCache.size; }
  /** Engine-roadmap step 3 (collision cells): is the mesh marked removed (see setDetached)? */
  isDetached(mesh: Mesh3D): boolean { return this._detached.has(mesh); }

  /**
   * Engine-roadmap step 3 (src/game/collision-cells.ts): the LOCAL ray intersectMesh would use for a mesh with an
   * IDENTITY model matrix — the world ray through gl-matrix's Float32 vec4 math (origin and direction rounded to f32,
   * the direction normalised in f32) — written into out[0..5], with out[6] = the world length of the local unit
   * direction (intersectMesh's tCap factor k). A collision cell tests its merged triangles with exactly this ray.
   */
  identityLocalRay(rayOrigin: ArrayLike<number>, rayDir: ArrayLike<number>, out: Float64Array): Float64Array {
    mat4.identity(this._invModel);
    this._invModel[12] = -0; this._invModel[13] = -0; this._invModel[14] = -0;
    vec4.set(this._lO4, rayOrigin[0], rayOrigin[1], rayOrigin[2], 1);
    vec4.transformMat4(this._lO4, this._lO4, this._invModel);
    vec4.set(this._lD4, rayDir[0], rayDir[1], rayDir[2], 0);
    vec4.transformMat4(this._lD4, this._lD4, this._invModel);
    const w = this._lO4[3];
    vec3.set(this._lO, this._lO4[0] / w, this._lO4[1] / w, this._lO4[2] / w);
    vec3.set(this._lD, this._lD4[0], this._lD4[1], this._lD4[2]);
    vec3.normalize(this._lD, this._lD);
    out[0] = this._lO[0]; out[1] = this._lO[1]; out[2] = this._lO[2];
    out[3] = this._lD[0]; out[4] = this._lD[1]; out[5] = this._lD[2];
    out[6] = Math.hypot(this._lD[0], this._lD[1], this._lD[2]);
    return out;
  }

  /**
   * Engine-roadmap step 3: the PickResult intersectMesh returns for an IDENTITY-matrix static mesh whose BVH walk found
   * triangle `tri` at local t (the same barycentrics, world hit point, distance and face normal, computed by the same
   * code) — so a collision cell's hit is reported exactly as the per-mesh path reports it.
   */
  hitFromLocalT(rayOrigin: vec3, rayDir: vec3, mesh: Mesh3D, tri: number, t: number): PickResult {
    const geom = mesh.geometry;
    const modelMat = mesh.localMatrix as mat4;
    const mm = modelMat as unknown as Float32Array;
    mat4.identity(this._invModel);
    this._invModel[12] = -mm[12]; this._invModel[13] = -mm[13]; this._invModel[14] = -mm[14];
    vec4.set(this._lO4, rayOrigin[0], rayOrigin[1], rayOrigin[2], 1);
    vec4.transformMat4(this._lO4, this._lO4, this._invModel);
    vec4.set(this._lD4, rayDir[0], rayDir[1], rayDir[2], 0);
    vec4.transformMat4(this._lD4, this._lD4, this._invModel);
    const w = this._lO4[3];
    vec3.set(this._lO, this._lO4[0] / w, this._lO4[1] / w, this._lO4[2] / w);
    vec3.set(this._lD, this._lD4[0], this._lD4[1], this._lD4[2]);
    vec3.normalize(this._lD, this._lD);
    const verts = geom.vertices, idxs = geom.indices;
    const ox = this._lO[0], oy = this._lO[1], oz = this._lO[2];
    const dx = this._lD[0], dy = this._lD[1], dz = this._lD[2];
    const stride = FLOATS_PER_VERT;
    const idx3 = tri * 3;
    const i0 = idxs[idx3] * stride, i1 = idxs[idx3 + 1] * stride, i2 = idxs[idx3 + 2] * stride;
    const ax = verts[i0], ay = verts[i0+1], az = verts[i0+2];
    const bx = verts[i1], by = verts[i1+1], bz = verts[i1+2];
    const cx = verts[i2], cy = verts[i2+1], cz = verts[i2+2];
    const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
    const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
    const hhx = dy*e2z - dz*e2y, hhy = dz*e2x - dx*e2z, hhz = dx*e2y - dy*e2x;
    const af = 1 / (e1x*hhx + e1y*hhy + e1z*hhz);
    const sx = ox-ax, sy = oy-ay, sz = oz-az;
    const hitU = af * (sx*hhx + sy*hhy + sz*hhz);
    const qx = sy*e1z - sz*e1y, qy = sz*e1x - sx*e1z, qz = sx*e1y - sy*e1x;
    const hitV = af * (dx*qx + dy*qy + dz*qz);
    return { mesh, ...this._finishHit(rayOrigin, modelMat, verts, idxs, tri, t, hitU, hitV) };
  }

  /** The shared tail of intersectMesh / hitFromLocalT: local hit → world point, distance and face normal. Reads the
   *  local ray from _lO / _lD and the inverse from _invModel (set by the caller). */
  private _finishHit(rayOrigin: vec3, modelMat: mat4, verts: Float32Array, idxs: Uint32Array, hitTri: number, hitT: number, hitU: number, hitV: number):
    { distance: number; triangleIndex: number; hitPoint: [number, number, number]; faceNormal: [number, number, number]; baryU: number; baryV: number } {
    vec3.scaleAndAdd(this._lHit, this._lO, this._lD, hitT);
    vec4.set(this._wHit4, this._lHit[0], this._lHit[1], this._lHit[2], 1);
    vec4.transformMat4(this._wHit4, this._wHit4, modelMat);
    const ww = this._wHit4[3];
    vec3.set(this._wHit, this._wHit4[0] / ww, this._wHit4[1] / ww, this._wHit4[2] / ww);
    {
      const stride = FLOATS_PER_VERT;
      const idx3 = hitTri * 3;
      const v = verts, ix = idxs;
      const i0 = ix[idx3]     * stride;
      const i1 = ix[idx3 + 1] * stride;
      const i2 = ix[idx3 + 2] * stride;
      const e1x = v[i1] - v[i0], e1y = v[i1+1] - v[i0+1], e1z = v[i1+2] - v[i0+2];
      const e2x = v[i2] - v[i0], e2y = v[i2+1] - v[i0+1], e2z = v[i2+2] - v[i0+2];
      const lnx = e1y*e2z - e1z*e2y;
      const lny = e1z*e2x - e1x*e2z;
      const lnz = e1x*e2y - e1y*e2x;
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
  /** Character v2 Phase 1.5: a blend-shape change no longer sets gpuDirty (the vertices are patched in place), so the
   *  geometry-derived caches (BVH, boxes, CPU-skinned copy) key on Mesh3D.blendVersion instead — dropped here when it
   *  moved and rebuilt LAZILY by the next pick (never per frame / per weight change). */
  private readonly _blendSeen = new Map<string, number>();
  /** The BVH of a skinned mesh's CURRENT cached pose, built once that pose has been picked SKIN_BVH_MIN_PICKS times
   *  over SKIN_BVH_SETTLE_MS (null until then → the caller scans linearly). It references the cached verts, which are
   *  only re-skinned for a NEW pose (a new cache entry, so the BVH goes with the old one). */
  private _skinnedBVH(meshId: string, idxs: Uint32Array): MeshBVH | null {
    const c = this._skinCache.get(meshId);
    if (!c) return null;
    if (c.bvh && c.bvhIdx === idxs) return c.bvh;
    c.bvh = null;
    const now = performance.now();
    if (c.picks === 0) c.firstPickAt = now;
    c.picks++;
    if (c.picks < MeshPicker.SKIN_BVH_MIN_PICKS || now - c.firstPickAt < MeshPicker.SKIN_BVH_SETTLE_MS) return null;
    c.bvh = MeshBVH.build(c.verts, idxs);
    c.bvhIdx = idxs;
    return c.bvh;
  }

  private _syncBlend(mesh: Mesh3D): void {
    const v = mesh.blendVersion;
    if (v === 0) return;
    const id = mesh.id;
    if (this._blendSeen.get(id) === v) return;
    this._blendSeen.set(id, v);
    this._bvhCache.delete(id); this._worldBoxCache.delete(id); this._aabbCache.delete(id); this._skinCache.delete(id);
    if (mesh.geometry) this._localBoxOfGeom.delete(mesh.geometry);
  }
  evictMesh(meshId: string): void {
    this._blendSeen.delete(meshId);
    this._worldBoxCache.delete(meshId);
    this._bvhCache.delete(meshId);
    this._aabbCache.delete(meshId);
    this._skinCache.delete(meshId);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private intersectMesh(
    rayOrigin: vec3,
    rayDir:    vec3,
    mesh:      Mesh3D,
    maxWorldDist = Infinity,
  ): { distance: number; triangleIndex: number; hitPoint: [number, number, number]; faceNormal: [number, number, number]; baryU: number; baryV: number } | null {
    const geom = mesh.geometry;
    if (!geom || geom.vertices.length === 0) return null;

    // Skinned + posed meshes RENDER deformed (skin matrices), but the base geometry is the rest pose. Pick
    // against a CPU-skinned copy so painting/selecting a bent-limb creature lands on the visible surface, not
    // the rest silhouette. At rest this equals base × localMatrix, so nothing changes until the rig is posed.
    this._syncBlend(mesh);
    const skin = this._skinnedDeform(mesh);
    const modelMat = (skin ? skin.modelMat : mesh.localMatrix) as mat4;
    // P6: world-baked city meshes sit at a pure translation (usually identity) — invert that directly (exact) instead of
    // the general 4x4 inverse on every collision ray x candidate.
    const mm = modelMat as unknown as Float32Array;
    if (mm[0] === 1 && mm[5] === 1 && mm[10] === 1 && mm[15] === 1 && mm[1] === 0 && mm[2] === 0 && mm[3] === 0 && mm[4] === 0
      && mm[6] === 0 && mm[7] === 0 && mm[8] === 0 && mm[9] === 0 && mm[11] === 0) {
      mat4.identity(this._invModel);
      this._invModel[12] = -mm[12]; this._invModel[13] = -mm[13]; this._invModel[14] = -mm[14];
    } else if (!mat4.invert(this._invModel, modelMat)) return null;

    // Transform ray into local (object) space — valid for all transforms.
    vec4.set(this._lO4, rayOrigin[0], rayOrigin[1], rayOrigin[2], 1);
    vec4.transformMat4(this._lO4, this._lO4, this._invModel);
    vec4.set(this._lD4, rayDir[0], rayDir[1], rayDir[2], 0);
    vec4.transformMat4(this._lD4, this._lD4, this._invModel);

    const w = this._lO4[3];
    vec3.set(this._lO, this._lO4[0] / w, this._lO4[1] / w, this._lO4[2] / w);
    vec3.set(this._lD, this._lD4[0], this._lD4[1], this._lD4[2]);
    vec3.normalize(this._lD, this._lD);

    const verts  = skin ? skin.verts : geom.vertices;
    const idxs   = geom.indices;
    const ox = this._lO[0], oy = this._lO[1], oz = this._lO[2];
    const dx = this._lD[0], dy = this._lD[1], dz = this._lD[2];

    let hitT   = Infinity;
    let hitTri = -1;
    let hitU   = 0;
    let hitV   = 0;

    // A skinned mesh whose pose has held still gets a BVH over that pose's verts (P2); else it keeps the linear scan.
    const skinBvh = skin && !mesh.gpuDirty ? this._skinnedBVH(mesh.id, idxs) : null;
    if ((!mesh.gpuDirty && !skin) || skinBvh) {
      // ── BVH path — static geometry (or a settled skinned pose) ──────────────
      let bvh = skinBvh ?? this._bvhCache.get(mesh.id);
      if (!bvh) {
        let t0 = 0;
        if (this._bvhBudgetOn) {
          t0 = performance.now();
          if (t0 - this._bvhWindowAt > 16) { this._bvhWindowAt = t0; this._bvhSpent = 0; }
          if (this._bvhSpent >= MeshPicker.bvhBuildBudgetMs) { this.bvhSkips++; return null; }   // over budget: build it on a later frame
        }
        bvh = MeshBVH.build(verts, idxs);
        this._bvhCache.set(mesh.id, bvh);
        if (this._bvhBudgetOn) this._bvhSpent += performance.now() - t0;
      }
      // P6: a world-distance cap → a local-t cap (the local unit direction maps to k world units; affine, so exact),
      // padded so a hit right at the cap survives rounding (the caller re-checks the world distance).
      let tCap = Infinity;
      if (maxWorldDist !== Infinity) {
        const k = Math.hypot(
          modelMat[0] * dx + modelMat[4] * dy + modelMat[8] * dz,
          modelMat[1] * dx + modelMat[5] * dy + modelMat[9] * dz,
          modelMat[2] * dx + modelMat[6] * dy + modelMat[10] * dz);
        if (k > 0) tCap = (maxWorldDist / k) * (1 + 1e-5) + 1e-6;
      }
      const hit = bvh.intersect(ox, oy, oz, dx, dy, dz, tCap);
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
      // Skinned verts change with the pose — recompute their AABB fresh (don't cache a stale pose's box).
      let aabb = skin ? undefined : this._aabbCache.get(mesh.id);
      if (aabb === undefined || mesh.gpuDirty) {
        aabb = computeAABB(verts);
        if (!skin) this._aabbCache.set(mesh.id, aabb);
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
      const v = verts, ix = idxs;   // deformed verts when skinned → the face normal matches the posed surface
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

/** P6: entry distance (>= 0) of the ray o + t*u (u unit) into box b = [minX, minY, minZ, maxX, maxY, maxZ], or null
 *  when it misses or the box lies wholly behind the origin. */
function slabEntry(ox: number, oy: number, oz: number, ux: number, uy: number, uz: number, b: Float64Array, o = 0): number | null {
  let tMin = 0, tMax = Infinity;
  if (Math.abs(ux) < EPSILON) { if (ox < b[o] || ox > b[o + 3]) return null; }
  else { const i = 1 / ux; let t1 = (b[o] - ox) * i, t2 = (b[o + 3] - ox) * i; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tMin) tMin = t1; if (t2 < tMax) tMax = t2; if (tMin > tMax) return null; }
  if (Math.abs(uy) < EPSILON) { if (oy < b[o + 1] || oy > b[o + 4]) return null; }
  else { const i = 1 / uy; let t1 = (b[o + 1] - oy) * i, t2 = (b[o + 4] - oy) * i; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tMin) tMin = t1; if (t2 < tMax) tMax = t2; if (tMin > tMax) return null; }
  if (Math.abs(uz) < EPSILON) { if (oz < b[o + 2] || oz > b[o + 5]) return null; }
  else { const i = 1 / uz; let t1 = (b[o + 2] - oz) * i, t2 = (b[o + 5] - oz) * i; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tMin) tMin = t1; if (t2 < tMax) tMax = t2; if (tMin > tMax) return null; }
  return tMin;
}

/** P6 raycastWorld per-list box cache (see MeshPicker._listBoxes). */
interface ListBoxCache { boxes: Float64Array; ver: Float64Array; geom: (object | null)[]; mesh: (Mesh3D | null)[]; has: Uint8Array }

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
