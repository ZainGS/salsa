/**
 * Scene3DArrayBake — bake an ArrayGroup3D's GPU instances into real geometry, extracted from Scene3DManager.
 *
 * Two terminal operations on the array tool (the live create/params/sync half lives in Scene3DArrays):
 *  - bakeArray3D: replace the ArrayGroup3D with a plain MeshGroup3D of independent Mesh3D copies (one per instance,
 *    source included), preserving each copy's world transform. Undoable.
 *  - bakeArrayMerged3D: fold every copy's geometry into ONE welded Mesh3D at the world origin, optionally bridging
 *    inter-copy gaps with oriented boxes (linear gapFill). Undoable.
 *
 * The heavy geometry maths (transform-and-merge, spatial-hash weld, oriented-box emit, matrix decompose) are
 * module-local pure functions here — they were only ever used by bake. This subsystem is geometry/GPU-adjacent
 * (creates meshes) so it's browser-verified rather than unit-tested. Dependencies beyond the shared ctx are a
 * narrow host: resolve the array group + a mesh, push undo, and clear the selected-group id (a selection field
 * kept on the manager). Scene3DManager keeps thin delegating methods so the public API and every caller are
 * unchanged.
 */

import { mat3, mat4 } from 'gl-matrix';
import { Mesh3D, Mesh3DConfig } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { ArrayGroup3D, LinearArrayParams, computeArrayOffsets, getArrayInstanceCount } from '../../scene-graph/shapes/array-group-3d';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';

/** Narrow host surface — everything Scene3DArrayBake needs from the parent manager beyond the shared ctx. */
export interface Scene3DArrayBakeHost {
  getArrayGroup(id: string): ArrayGroup3D | null;
  getMesh(id: string): Mesh3D | null;
  pushUndo(cmd: Command3D): void;
  /** Clear the manager's `_selectedGroupId` (array gizmo target) — the baked result is not an ArrayGroup3D. */
  clearSelectedGroup(): void;
}

export class Scene3DArrayBake {
  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DArrayBakeHost,
  ) {}

  private get _renderer3D() { return this.ctx.webgpuRenderer.getRenderer3D(); }

  /**
   * Convert an ArrayGroup3D to a plain MeshGroup3D with independent geometry per copy. Creates new Mesh3D objects
   * from the computed instance positions (GPU instancing model — no Mesh3D copies exist until bake). Pushes undo.
   */
  bakeArray3D(groupId: string): MeshGroup3D | null {
    const group = this.host.getArrayGroup(groupId);
    if (!group) return null;

    const source = this.host.getMesh(group.sourceId);
    if (!source) return null;

    const srcParent   = (source.parent ?? this.ctx.sceneGraph.root) as MeshGroup3D;
    const groupParent = (group.parent  ?? this.ctx.sceneGraph.root) as MeshGroup3D;
    const srcGeom     = source.geometry;

    // Clone source into a new independent Mesh3D at the given world position.
    const makeCopy = (wx: number, wy: number, wz: number): Mesh3D => {
      // Spread the full primitive config so params like radius, segments, etc. are preserved.
      const cfg: Mesh3DConfig = { ...(source as unknown as { _meshConfig: Mesh3DConfig })._meshConfig };
      if (source.meshPrimitive === 'custom' && srcGeom) {
        cfg.geometry = {
          vertices: new Float32Array(srcGeom.vertices),
          indices:  new Uint32Array(srcGeom.indices),
          format:   srcGeom.format,
        };
      } else {
        delete cfg.geometry;
      }
      const copy = new Mesh3D(this.ctx.interactionService, wx, wy, wz, cfg);
      copy.setRotation3D(source.rotationX, source.rotationY, source.rotation);
      copy.setScale3D(source.scaleX, source.scaleY, source.scaleZ);
      copy.setMaterial({ ...source.material });
      copy._name = source.name;
      return copy;
    };

    // Source copy (at source position) + N instance copies — all independent.
    const sourceCopy = makeCopy(source.x, source.y, source.z);

    // Determine instance world transforms: object offset (accumulated matrix) or standard translation.
    const objectOffsetId = group.arrayParams.mode === 'linear' ? group.arrayParams.objectOffsetId : undefined;
    const offsetMesh = objectOffsetId ? this.host.getMesh(objectOffsetId) : null;
    let instanceCopies: Mesh3D[];

    if (offsetMesh) {
      const srcMat = source.localMatrix as Float32Array;
      const invSrc = mat4.invert(mat4.create(), srcMat as unknown as mat4) as Float32Array;
      const D = mat4.multiply(mat4.create(), offsetMesh.localMatrix as unknown as mat4, invSrc as unknown as mat4) as Float32Array;
      const accum = new Float32Array(srcMat);
      const N = getArrayInstanceCount(group.arrayParams);
      instanceCopies = [];
      for (let i = 0; i < N; i++) {
        mat4.multiply(accum as unknown as mat4, D as unknown as mat4, accum as unknown as mat4);
        const t = decomposeMatrix4(accum);
        const copy = makeCopy(t.x, t.y, t.z);
        copy.rotationX = t.rotX;
        copy.rotationY = t.rotY;
        copy.rotation  = t.rotZ;
        copy.scaleX    = t.scaleX;
        copy.scaleY    = t.scaleY;
        copy.scaleZ    = t.scaleZ;
        instanceCopies.push(copy);
      }
    } else {
      instanceCopies = computeArrayOffsets(group.arrayParams, [source.x, source.y, source.z])
        .map(([dx, dy, dz]) => makeCopy(source.x + dx, source.y + dy, source.z + dz));
    }

    const allCopies = [sourceCopy, ...instanceCopies];

    // Only remove the source mesh if no other ArrayGroup3D still references it. Removing it when siblings exist
    // would break all other repeats off the same source.
    const siblingsExist = this.ctx.sceneGraph.root.children.some(
      n => n instanceof ArrayGroup3D && n.id !== group.id && (n as ArrayGroup3D).sourceId === source.id,
    );
    const removeSource = !siblingsExist;

    const plainGroup = new MeshGroup3D(this.ctx.interactionService);
    plainGroup._name = group.name;
    for (const copy of allCopies) plainGroup.addChild(copy);

    // Remove the ArrayGroup3D; replace with the baked group.
    groupParent.removeChild(group);
    if (removeSource) srcParent.removeChild(source);
    groupParent.addChild(plainGroup);

    this._renderer3D.setSelectedMeshIds(new Set(allCopies.map(c => c.id)));
    this._renderer3D.setArrayGizmoData(null);
    this.host.clearSelectedGroup();
    this.ctx.setSelectedNode(plainGroup.id);
    this.ctx.emitSceneGraphChanged();
    this.ctx.scheduleRender();

    this.host.pushUndo({
      description: 'Bake array',
      undo: () => {
        for (const c of [...plainGroup.children]) plainGroup.removeChild(c);
        groupParent.removeChild(plainGroup);
        groupParent.addChild(group);
        if (removeSource) srcParent.addChild(source);
        this._renderer3D.setSelectedMeshIds(new Set([source.id]));
        this.ctx.setSelectedNode(group.id);
        this.ctx.emitSceneGraphChanged();
      },
      redo: () => {
        for (const copy of allCopies) plainGroup.addChild(copy);
        groupParent.removeChild(group);
        if (removeSource) srcParent.removeChild(source);
        groupParent.addChild(plainGroup);
        this._renderer3D.setArrayGizmoData(null);
        this.host.clearSelectedGroup();
        this.ctx.setSelectedNode(plainGroup.id);
        this.ctx.emitSceneGraphChanged();
      },
    });

    return plainGroup;
  }

  /**
   * Bake an ArrayGroup3D into a single unified Mesh3D by:
   *  1. Transforming all copy geometries to world space.
   *  2. Optionally inserting oriented bridge boxes in inter-copy gaps (gapFill flag on LinearArrayParams).
   *  3. Welding near-coincident vertices within `weldThreshold` world units (default 0.001).
   *
   * The resulting mesh sits at the world origin (all positions already folded into vertex data). Pushes undo.
   */
  bakeArrayMerged3D(groupId: string): Mesh3D | null {
    const group = this.host.getArrayGroup(groupId);
    if (!group) return null;

    const source = this.host.getMesh(group.sourceId);
    if (!source) return null;

    const srcGeom = source.geometry;
    if (!srcGeom?.vertices.length) return null;

    const params = group.arrayParams;
    const linParams = params.mode === 'linear' ? params as LinearArrayParams : null;
    const weldThresh = linParams?.weldThreshold ?? 0.001;
    const doGapFill  = (linParams?.gapFill ?? false) && !linParams?.objectOffsetId;

    // ── Build one world matrix per copy (source first, then instances) ──────────────
    const allMats: Float32Array[] = [new Float32Array(source.localMatrix as Float32Array)];

    const objectOffsetId = linParams?.objectOffsetId;
    const offsetMesh     = objectOffsetId ? this.host.getMesh(objectOffsetId) : null;

    if (offsetMesh) {
      const srcMat = source.localMatrix as Float32Array;
      const invSrc = mat4.invert(mat4.create(), srcMat as unknown as mat4) as Float32Array;
      const D      = mat4.multiply(mat4.create(), offsetMesh.localMatrix as unknown as mat4, invSrc as unknown as mat4) as Float32Array;
      const accum  = new Float32Array(srcMat);
      const N      = getArrayInstanceCount(params);
      for (let i = 0; i < N; i++) {
        mat4.multiply(accum as unknown as mat4, D as unknown as mat4, accum as unknown as mat4);
        allMats.push(new Float32Array(accum));
      }
    } else {
      for (const [dx, dy, dz] of computeArrayOffsets(params, [source.x, source.y, source.z])) {
        const m = mat4.clone(source.localMatrix as unknown as mat4) as Float32Array;
        m[12] += dx; m[13] += dy; m[14] += dz;
        allMats.push(m);
      }
    }

    // ── Merge all copy geometries into flat arrays ─────────────────────────────────
    const mergedVerts: number[] = [];
    const mergedIdx:   number[] = [];
    for (const mat of allMats) {
      _mergeTransformedGeom(srcGeom.vertices, srcGeom.indices, mat, mergedVerts, mergedIdx);
    }

    // ── Gap fill: oriented bridge box between each pair of consecutive copies ──────
    if (doGapFill && allMats.length >= 2) {
      // Compute spacing direction and extent from the first two copy centers.
      const dx = allMats[1][12] - allMats[0][12];
      const dy = allMats[1][13] - allMats[0][13];
      const dz = allMats[1][14] - allMats[0][14];
      const spLen = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (spLen > 1e-6) {
        const dNorm: [number,number,number] = [dx/spLen, dy/spLen, dz/spLen];

        // World-space extent of source along dNorm.
        const srcMat = allMats[0];
        let minD = Infinity, maxD = -Infinity;
        let minU = Infinity, maxU = -Infinity;
        let minV = Infinity, maxV = -Infinity;

        // Gram-Schmidt: perpendicular axes u, v
        const ref: [number,number,number] = Math.abs(dNorm[0]) < 0.9 ? [1,0,0] : [0,1,0];
        const uDir = _normVec3(_crossVec3(dNorm, ref));
        const vDir = _normVec3(_crossVec3(dNorm, uDir));

        const sv = srcGeom.vertices;
        for (let vi = 0; vi < sv.length; vi += FLOATS_PER_VERT) {
          const px = sv[vi], py = sv[vi+1], pz = sv[vi+2];
          const wx = srcMat[0]*px + srcMat[4]*py + srcMat[8]*pz;
          const wy = srcMat[1]*px + srcMat[5]*py + srcMat[9]*pz;
          const wz = srcMat[2]*px + srcMat[6]*py + srcMat[10]*pz;
          const dotD = wx*dNorm[0] + wy*dNorm[1] + wz*dNorm[2];
          const dotU = wx*uDir[0]  + wy*uDir[1]  + wz*uDir[2];
          const dotV = wx*vDir[0]  + wy*vDir[1]  + wz*vDir[2];
          if (dotD < minD) minD = dotD; if (dotD > maxD) maxD = dotD;
          if (dotU < minU) minU = dotU; if (dotU > maxU) maxU = dotU;
          if (dotV < minV) minV = dotV; if (dotV > maxV) maxV = dotV;
        }

        const extentD = maxD - minD;
        const gap     = spLen - extentD;
        const extU    = maxU - minU;
        const extV    = maxV - minV;

        if (gap > 1e-6 && extU > 1e-6 && extV > 1e-6) {
          for (let i = 0; i < allMats.length - 1; i++) {
            // Bridge center = front face of copy i + half-gap forward.
            const frontFaceOffset = maxD + gap * 0.5;
            const bcx = allMats[i][12] + frontFaceOffset * dNorm[0];
            const bcy = allMats[i][13] + frontFaceOffset * dNorm[1];
            const bcz = allMats[i][14] + frontFaceOffset * dNorm[2];
            _appendOrientedBox(bcx, bcy, bcz, dNorm, uDir, vDir, gap, extU, extV, mergedVerts, mergedIdx);
          }
        }
      }
    }

    // ── Weld ──────────────────────────────────────────────────────────────────────
    const welded = _weldGeometry(mergedVerts, mergedIdx, weldThresh);

    // ── Build merged Mesh3D at world origin (vertices are already in world space) ──
    const groupParent = (group.parent  ?? this.ctx.sceneGraph.root) as MeshGroup3D;
    const srcParent   = (source.parent ?? this.ctx.sceneGraph.root) as MeshGroup3D;

    const siblingsExist = this.ctx.sceneGraph.root.children.some(
      n => n instanceof ArrayGroup3D && n.id !== group.id && (n as ArrayGroup3D).sourceId === source.id,
    );
    const removeSource = !siblingsExist;

    const merged = new Mesh3D(this.ctx.interactionService, 0, 0, 0, {
      primitive: 'custom',
      geometry: { ...welded, format: '12float' },
    });
    merged.setMaterial({ ...source.material });
    merged._name = group.name + ' (merged)';

    groupParent.removeChild(group);
    if (removeSource) srcParent.removeChild(source);
    groupParent.addChild(merged);

    this._renderer3D.setArrayGizmoData(null);
    this.host.clearSelectedGroup();
    this.ctx.setSelectedNode(merged.id);
    this.ctx.emitSceneGraphChanged();
    this.ctx.scheduleRender();

    this.host.pushUndo({
      description: 'Bake array (merged)',
      undo: () => {
        groupParent.removeChild(merged);
        groupParent.addChild(group);
        if (removeSource) srcParent.addChild(source);
        this._renderer3D.setSelectedMeshIds(new Set([source.id]));
        this.ctx.setSelectedNode(group.id);
        this.ctx.emitSceneGraphChanged();
      },
      redo: () => {
        groupParent.removeChild(group);
        if (removeSource) srcParent.removeChild(source);
        groupParent.addChild(merged);
        this._renderer3D.setArrayGizmoData(null);
        this.host.clearSelectedGroup();
        this.ctx.setSelectedNode(merged.id);
        this.ctx.emitSceneGraphChanged();
      },
    });

    return merged;
  }
}

// ── Array merge helpers (module-local pure geometry maths, previously in scene3d-manager) ────────────────────

/**
 * Decompose a column-major 4×4 matrix (gl-matrix format) into position, YXZ Euler angles (radians), and uniform
 * scale components. Matches the rotation order used by shape.updateLocalMatrix(): Y → X → Z.
 */
function decomposeMatrix4(m: Float32Array): {
  x: number; y: number; z: number;
  rotX: number; rotY: number; rotZ: number;
  scaleX: number; scaleY: number; scaleZ: number;
} {
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  // Normalized rotation elements (col-major: element at row r, col c → index c*4+r)
  const r12 = m[9]  / (sz || 1);   // -sin(rotX)
  const r02 = m[8]  / (sz || 1);   // sin(rotY)*cos(rotX)
  const r22 = m[10] / (sz || 1);   // cos(rotY)*cos(rotX)
  const r10 = m[1]  / (sx || 1);   // cos(rotX)*sin(rotZ)
  const r11 = m[5]  / (sy || 1);   // cos(rotX)*cos(rotZ)
  const rotX = Math.asin(Math.max(-1, Math.min(1, -r12)));
  const cx = Math.cos(rotX);
  const rotY = cx > 1e-6 ? Math.atan2(r02, r22) : 0;
  const rotZ = cx > 1e-6 ? Math.atan2(r10, r11) : Math.atan2(-m[4] / (sy || 1), m[0] / (sx || 1));
  return { x: m[12], y: m[13], z: m[14], rotX, rotY, rotZ, scaleX: sx, scaleY: sy, scaleZ: sz };
}

/**
 * Transform all vertices in `srcVerts` by the 4×4 matrix `M` (column-major) and append to `dstVerts`. Normals and
 * tangents are transformed by the normal matrix (M⁻¹)ᵀ. Indices are remapped by `baseVertex` and appended.
 */
function _mergeTransformedGeom(
  srcVerts: Float32Array,
  srcIdx:   Uint32Array,
  M:        Float32Array,
  dstVerts: number[],
  dstIdx:   number[],
): void {
  const FVERT      = FLOATS_PER_VERT;
  const baseVertex = dstVerts.length / FVERT;

  // Normal matrix = (M⁻¹)ᵀ (upper-left 3×3 only)
  const nm = mat3.fromMat4(mat3.create(), M as unknown as mat4);
  if (Math.abs(mat3.determinant(nm)) > 1e-12) {
    mat3.invert(nm, nm);
    mat3.transpose(nm, nm);
  }

  for (let vi = 0; vi < srcVerts.length; vi += FVERT) {
    const px = srcVerts[vi], py = srcVerts[vi+1], pz = srcVerts[vi+2];
    const wx = M[0]*px + M[4]*py + M[8]*pz  + M[12];
    const wy = M[1]*px + M[5]*py + M[9]*pz  + M[13];
    const wz = M[2]*px + M[6]*py + M[10]*pz + M[14];

    const nx = srcVerts[vi+3], ny = srcVerts[vi+4], nz = srcVerts[vi+5];
    const wnx = nm[0]*nx + nm[3]*ny + nm[6]*nz;
    const wny = nm[1]*nx + nm[4]*ny + nm[7]*nz;
    const wnz = nm[2]*nx + nm[5]*ny + nm[8]*nz;
    const nl  = Math.sqrt(wnx*wnx + wny*wny + wnz*wnz) || 1;

    const tx = srcVerts[vi+8], ty = srcVerts[vi+9], tz = srcVerts[vi+10], tw = srcVerts[vi+11];
    const wtx = nm[0]*tx + nm[3]*ty + nm[6]*tz;
    const wty = nm[1]*tx + nm[4]*ty + nm[7]*tz;
    const wtz = nm[2]*tx + nm[5]*ty + nm[8]*tz;
    const tl  = Math.sqrt(wtx*wtx + wty*wty + wtz*wtz) || 1;

    dstVerts.push(
      wx, wy, wz,
      wnx/nl, wny/nl, wnz/nl,
      srcVerts[vi+6], srcVerts[vi+7],
      wtx/tl, wty/tl, wtz/tl, tw,
    );
  }
  for (const i of srcIdx) dstIdx.push(baseVertex + i);
}

/** Weld near-coincident vertices using a spatial hash. Normals of merged vertices are averaged and re-normalized. */
function _weldGeometry(
  verts: number[],
  idx:   number[],
  threshold: number,
): { vertices: Float32Array; indices: Uint32Array } {
  const FVERT    = FLOATS_PER_VERT;
  const cellSize = Math.max(threshold, 1e-8);
  const invCell  = 1 / cellSize;
  const cellMap  = new Map<string, number[]>();
  const newVerts: number[] = [];
  const remap:    number[] = new Array(verts.length / FVERT);

  const cellKey = (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`;

  for (let vi = 0, i = 0; vi < verts.length; vi += FVERT, i++) {
    const px = verts[vi], py = verts[vi+1], pz = verts[vi+2];
    const cx = Math.floor(px * invCell);
    const cy = Math.floor(py * invCell);
    const cz = Math.floor(pz * invCell);

    let found = -1;
    outer: for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = cellMap.get(cellKey(cx+dx, cy+dy, cz+dz));
          if (!bucket) continue;
          for (const ni of bucket) {
            const eo = ni * FVERT;
            const ex = newVerts[eo], ey = newVerts[eo+1], ez = newVerts[eo+2];
            const d2 = (px-ex)*(px-ex) + (py-ey)*(py-ey) + (pz-ez)*(pz-ez);
            if (d2 <= threshold * threshold) { found = ni; break outer; }
          }
        }
      }
    }

    if (found >= 0) {
      remap[i] = found;
      const eo = found * FVERT;
      newVerts[eo+3] += verts[vi+3];
      newVerts[eo+4] += verts[vi+4];
      newVerts[eo+5] += verts[vi+5];
    } else {
      const newIdx = newVerts.length / FVERT;
      remap[i] = newIdx;
      const k = cellKey(cx, cy, cz);
      const bucket = cellMap.get(k);
      if (bucket) bucket.push(newIdx); else cellMap.set(k, [newIdx]);
      for (let f = 0; f < FVERT; f++) newVerts.push(verts[vi+f]);
    }
  }

  for (let vi = 0; vi < newVerts.length; vi += FVERT) {
    const nx = newVerts[vi+3], ny = newVerts[vi+4], nz = newVerts[vi+5];
    const l = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    newVerts[vi+3] /= l; newVerts[vi+4] /= l; newVerts[vi+5] /= l;
  }

  return {
    vertices: new Float32Array(newVerts),
    indices:  new Uint32Array(idx.map(i => remap[i])),
  };
}

/** 3-component cross product. */
function _crossVec3(a: [number,number,number], b: [number,number,number]): [number,number,number] {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

/** Normalize a 3-component vector (returns input unchanged if near-zero length). */
function _normVec3(v: [number,number,number]): [number,number,number] {
  const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) || 1;
  return [v[0]/l, v[1]/l, v[2]/l];
}

/**
 * Append a 6-face oriented box (24 verts, 36 indices) to `dstVerts`/`dstIdx`. Axes d, u, v must be orthonormal.
 * Sizes are full extents (not half). Vertex format: [px,py,pz, nx,ny,nz, u=0,v=0, tx=0,ty=0,tz=0, tw=1].
 */
function _appendOrientedBox(
  cx: number, cy: number, cz: number,
  d: [number,number,number], u: [number,number,number], v: [number,number,number],
  sizeD: number, sizeU: number, sizeV: number,
  dstVerts: number[], dstIdx: number[],
): void {
  const hD = sizeD/2, hU = sizeU/2, hV = sizeV/2;
  const corners: Array<[number,number,number]> = [];
  for (const sd of [-1, 1]) for (const su of [-1, 1]) for (const sv of [-1, 1]) {
    corners.push([
      cx + sd*hD*d[0] + su*hU*u[0] + sv*hV*v[0],
      cy + sd*hD*d[1] + su*hU*u[1] + sv*hV*v[1],
      cz + sd*hD*d[2] + su*hU*u[2] + sv*hV*v[2],
    ]);
  }
  const faces: Array<[[number,number,number], [number,number,number,number]]> = [
    [[-d[0],-d[1],-d[2]], [0, 1, 3, 2]],
    [[ d[0], d[1], d[2]], [4, 6, 7, 5]],
    [[-u[0],-u[1],-u[2]], [0, 4, 5, 1]],
    [[ u[0], u[1], u[2]], [2, 3, 7, 6]],
    [[-v[0],-v[1],-v[2]], [0, 2, 6, 4]],
    [[ v[0], v[1], v[2]], [1, 5, 7, 3]],
  ];
  const FVERT = FLOATS_PER_VERT;
  for (const [fn, vi] of faces) {
    const base = dstVerts.length / FVERT;
    for (const ci of vi) {
      const [px, py, pz] = corners[ci];
      dstVerts.push(px, py, pz, fn[0], fn[1], fn[2], 0, 0, 0, 0, 0, 1);
    }
    dstIdx.push(base, base+1, base+2, base, base+2, base+3);
  }
}
