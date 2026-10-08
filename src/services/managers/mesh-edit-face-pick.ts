/**
 * Mesh Edit FACE PICK (mobile-parity §7.3d item 3).
 *
 * The old pick (kept below as {@link pickFaceFullScene}, the reference + the fallback) ray-cast the WHOLE scene
 * (pick3D: every visible pickable mesh, building a BVH for each on first contact), gave up unless the edit mesh was
 * the nearest hit, and then scanned EVERY EditMesh face for the world-space face centre nearest the hit point
 * (allocating two arrays + an object per face).
 *
 * {@link EditFacePicker} gives the same answer for a ray that hits the edit mesh:
 *  - the ray is cast at the edit mesh ONLY, through MeshPicker.pickMeshWithBVH with a BVH this class owns, keyed on
 *    the mesh's geometry object + arrays + geometryVersion (a recompile replaces the geometry; the in-place drag patch
 *    bumps geometryVersion) — the same ray, BVH walk and hit math as pick3D's per-mesh path, so the same hit point;
 *    a skinned mesh goes through MeshPicker.pickMesh([mesh]) (its CPU-skinned pose, as pick3D did);
 *  - the nearest face centre comes from a uniform grid over the world-space face centres (computed by the same
 *    arithmetic as the old scan: EditMesh.getFaceCenter, then the model matrix), searched in rings around the hit
 *    point until no closer centre can exist. Ties resolve exactly like the old ascending scan with a strict `<`: the
 *    smallest distance, then the LOWEST face index; non-finite centres never win. Rebuilt when the edit mesh's
 *    topology / positions (geometryVersion) or the model matrix change.
 *
 * Deliberate difference: another mesh in FRONT of the edit mesh no longer blocks the pick (Edit Mode edits one mesh,
 * as in Blender), and a hit on a character overlay (hair / garment) no longer stands in for its body.
 */

import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { MeshBVH } from '../../renderer/3d/mesh-bvh';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { EditMesh } from '../../scene-graph/shapes/edit-mesh';

type HitScene = { pick3D(px: number, py: number, w: number, h: number): { meshId: string; hitPoint: [number, number, number] } | null };

/** Mirror modifier support (round 2): the hit point mapped back to the real side (world → world) before the face-centre
 *  search, and the faces that can't be picked (skip[f] = 1: on the discarded side of a bisect mirror). */
export interface FacePickMirror {
  mapHit?: ((hx: number, hy: number, hz: number) => [number, number, number]) | null;
  skip?: Uint8Array | null;
}

/** The pre-7.3d face-centre scan: the face whose WORLD-space centre is nearest (hx, hy, hz); ties → the lowest index.
 *  Faces with skip[f] set never win. */
export function nearestFaceCenterScan(em: EditMesh, m: ArrayLike<number>, hx: number, hy: number, hz: number, skip?: Uint8Array | null): number {
  let bestFace = -1, bestDist = Infinity;
  for (let fi = 0; fi < em.faces.length; fi++) {
    if (skip && skip[fi]) continue;
    const [cx, cy, cz] = em.getFaceCenter(fi);
    const wx = m[0] * cx + m[4] * cy + m[8]  * cz + m[12];
    const wy = m[1] * cx + m[5] * cy + m[9]  * cz + m[13];
    const wz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
    const d = Math.sqrt((wx - hx) ** 2 + (wy - hy) ** 2 + (wz - hz) ** 2);
    if (d < bestDist) { bestDist = d; bestFace = fi; }
  }
  return bestFace;
}

/** The pre-7.3d face pick, verbatim: a full-scene pick3D, the edit mesh must be the nearest hit, then the scan. */
export function pickFaceFullScene(
  scene3d: HitScene, meshId: string, mesh: { editMesh: EditMesh | null; localMatrix: ArrayLike<number> } | null,
  px: number, py: number, canvasWidth: number, canvasHeight: number, mirror?: FacePickMirror | null,
): number {
  const hit = scene3d.pick3D(px, py, canvasWidth, canvasHeight);
  if (!hit || hit.meshId !== meshId) return -1;
  if (!mesh?.editMesh) return -1;
  const [hx, hy, hz] = mirror?.mapHit ? mirror.mapHit(hit.hitPoint[0], hit.hitPoint[1], hit.hitPoint[2]) : hit.hitPoint;
  return nearestFaceCenterScan(mesh.editMesh, mesh.localMatrix, hx, hy, hz, mirror?.skip);
}

/** Uniform grid over the world-space face centres (CSR cells). */
interface FaceGrid {
  em: EditMesh; faces: unknown; verts: unknown; halfEdges: unknown; nf: number; nv: number; gv: number;
  mat: Float64Array;
  /** World-space centre per face (xyz). */
  c: Float64Array;
  n: number;
  ox: number; oy: number; oz: number; cell: number; nx: number; ny: number; nz: number;
  start: Int32Array; items: Int32Array;
}

export class EditFacePicker {
  /** Counters for the perf report / tests. facesTested = face centres whose distance was evaluated. */
  readonly stats = { picks: 0, hits: 0, bvhBuilds: 0, gridBuilds: 0, facesTested: 0 };
  private readonly _picker = new MeshPicker();
  private _bvh: { mesh: Mesh3D; geom: object; verts: object; idxs: object; gv: number; bvh: MeshBVH } | null = null;
  private _grid: FaceGrid | null = null;

  /** The face under canvas px (px, py), or -1. Same result as pickFaceFullScene for a ray that reaches the edit mesh. */
  pick(mesh: Mesh3D, camera: Camera3D, px: number, py: number, canvasWidth: number, canvasHeight: number, mirror?: FacePickMirror | null): number {
    const em = mesh.editMesh;
    if (!em || !mesh.visible || !mesh.pickable) return -1;   // (pick3D skips hidden / non-pickable meshes)
    this.stats.picks++;
    let hit;
    if (mesh instanceof SkinnedMesh3D) {
      hit = this._picker.pickMesh(px, py, canvasWidth, canvasHeight, camera, [mesh]);
    } else {
      const bvh = this._bvhFor(mesh);
      if (!bvh) return -1;
      hit = this._picker.pickMeshWithBVH(px, py, canvasWidth, canvasHeight, camera, mesh, bvh);
    }
    if (!hit) return -1;
    this.stats.hits++;
    const [hx, hy, hz] = mirror?.mapHit ? mirror.mapHit(hit.hitPoint[0], hit.hitPoint[1], hit.hitPoint[2]) : hit.hitPoint;
    return this._nearest(this._gridFor(mesh, em), hx, hy, hz, mirror?.skip);
  }

  /** Drop the caches (edit mode ended). */
  clear(): void {
    if (this._bvh) this._picker.evictMesh(this._bvh.mesh.id);
    this._bvh = null; this._grid = null;
  }

  private _bvhFor(mesh: Mesh3D): MeshBVH | null {
    const geom = mesh.geometry;
    if (!geom || !geom.vertices || geom.vertices.length === 0 || !geom.indices || geom.indices.length < 3) return null;
    const b = this._bvh;
    if (b && b.mesh === mesh && b.geom === geom && b.verts === geom.vertices && b.idxs === geom.indices && b.gv === mesh.geometryVersion) return b.bvh;
    const bvh = MeshBVH.build(geom.vertices as Float32Array, geom.indices as Uint32Array);
    this.stats.bvhBuilds++;
    this._bvh = { mesh, geom, verts: geom.vertices, idxs: geom.indices, gv: mesh.geometryVersion, bvh };
    return bvh;
  }

  private _gridFor(mesh: Mesh3D, em: EditMesh): FaceGrid {
    const m = mesh.localMatrix as unknown as ArrayLike<number>;
    const g = this._grid;
    if (g && g.em === em && g.faces === em.faces && g.verts === em.vertices && g.halfEdges === em.halfEdges
        && g.nf === em.faces.length && g.nv === em.vertices.length && g.gv === mesh.geometryVersion && sameMat(g.mat, m)) return g;
    this.stats.gridBuilds++;
    return (this._grid = buildGrid(em, m, mesh.geometryVersion));
  }

  /** Ring search of the grid: exactly the old scan's answer (min distance, then the lowest index). */
  private _nearest(g: FaceGrid, hx: number, hy: number, hz: number, skip?: Uint8Array | null): number {
    if (g.n === 0) return -1;
    const { c, cell, nx, ny, nz, start, items } = g;
    // h's cell, clamped one cell outside the grid (clamping toward the grid only shrinks ring distances: the ring
    // lower bound below stays a lower bound).
    const ci = clampCell(Math.floor((hx - g.ox) / cell), nx), cj = clampCell(Math.floor((hy - g.oy) / cell), ny), ck = clampCell(Math.floor((hz - g.oz) / cell), nz);
    const maxR = Math.max(ci + 1, nx - ci, cj + 1, ny - cj, ck + 1, nz - ck);
    let best = -1, bestD = Infinity, tested = 0;
    const visit = (i: number, j: number, k: number): void => {
      const cid = (k * ny + j) * nx + i;
      for (let s = start[cid], e = start[cid + 1]; s < e; s++) {
        const f = items[s], o = f * 3;
        if (skip && skip[f]) continue;
        const d = Math.sqrt((c[o] - hx) ** 2 + (c[o + 1] - hy) ** 2 + (c[o + 2] - hz) ** 2);
        tested++;
        if (d < bestD || (d === bestD && f < best)) { bestD = d; best = f; }
      }
    };
    for (let r = 0; r <= maxR; r++) {
      // Every centre in ring r is at least (r - 1) cells from h along some axis (slack for the floor rounding).
      if (r >= 2 && (r - 1.0001) * cell > bestD) break;
      const i0 = Math.max(0, ci - r), i1 = Math.min(nx - 1, ci + r);
      const j0 = Math.max(0, cj - r), j1 = Math.min(ny - 1, cj + r);
      const k0 = Math.max(0, ck - r), k1 = Math.min(nz - 1, ck + r);
      for (let i = i0; i <= i1; i++) {
        const edgeI = Math.abs(i - ci) === r;
        for (let j = j0; j <= j1; j++) {
          if (edgeI || Math.abs(j - cj) === r) { for (let k = k0; k <= k1; k++) visit(i, j, k); }
          else {
            if (ck - r >= 0 && ck - r < nz) visit(i, j, ck - r);
            if (r > 0 && ck + r >= 0 && ck + r < nz) visit(i, j, ck + r);
          }
        }
      }
    }
    this.stats.facesTested += tested;
    return best;
  }
}

function clampCell(i: number, n: number): number { return i < -1 ? -1 : i > n ? n : i; }

function sameMat(a: Float64Array, m: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== m[i]) return false;
  return true;
}

function buildGrid(em: EditMesh, m: ArrayLike<number>, gv: number): FaceGrid {
  const nf = em.faces.length;
  const c = new Float64Array(nf * 3);
  const ok = new Uint8Array(nf);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, n = 0;
  for (let f = 0; f < nf; f++) {
    // The SAME arithmetic as the old scan (getFaceCenter, then the model matrix) → identical distances.
    const [cx, cy, cz] = em.getFaceCenter(f);
    const wx = m[0] * cx + m[4] * cy + m[8]  * cz + m[12];
    const wy = m[1] * cx + m[5] * cy + m[9]  * cz + m[13];
    const wz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
    c[f * 3] = wx; c[f * 3 + 1] = wy; c[f * 3 + 2] = wz;
    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) continue;   // never nearer than Infinity
    ok[f] = 1; n++;
    if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
    if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
    if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
  }
  const mat = new Float64Array(16);
  for (let i = 0; i < 16; i++) mat[i] = m[i];
  const base = { em, faces: em.faces, verts: em.vertices, halfEdges: em.halfEdges, nf, nv: em.vertices.length, gv, mat, c, n };
  if (n === 0) return { ...base, ox: 0, oy: 0, oz: 0, cell: 1, nx: 1, ny: 1, nz: 1, start: new Int32Array(2), items: new Int32Array(0) };
  const k = Math.max(1, Math.round(Math.cbrt(n)));
  const ext = Math.max(x1 - x0, y1 - y0, z1 - z0);
  const cell = ext > 0 && Number.isFinite(ext) ? ext / k : 1;
  const nx = Math.min(k + 1, Math.floor((x1 - x0) / cell) + 1);
  const ny = Math.min(k + 1, Math.floor((y1 - y0) / cell) + 1);
  const nz = Math.min(k + 1, Math.floor((z1 - z0) / cell) + 1);
  const cellOf = (f: number): number => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((c[f * 3] - x0) / cell)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((c[f * 3 + 1] - y0) / cell)));
    const kk = Math.min(nz - 1, Math.max(0, Math.floor((c[f * 3 + 2] - z0) / cell)));
    return (kk * ny + j) * nx + i;
  };
  const cells = nx * ny * nz;
  const start = new Int32Array(cells + 1);
  const cellIdx = new Int32Array(nf);
  for (let f = 0; f < nf; f++) { if (!ok[f]) continue; const id = cellOf(f); cellIdx[f] = id; start[id + 1]++; }
  for (let i = 0; i < cells; i++) start[i + 1] += start[i];
  const fill = start.slice(0, cells);
  const items = new Int32Array(n);
  for (let f = 0; f < nf; f++) if (ok[f]) items[fill[cellIdx[f]]++] = f;
  return { ...base, ox: x0, oy: y0, oz: z0, cell, nx, ny, nz, start, items };
}
