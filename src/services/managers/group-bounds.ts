// Engine-roadmap step 3 (performance-plan §P13 "Step 3"): the City gizmo's aggregate bounds without the whole-world
// vertex scan.
//
// Scene3DManager.cacheGroupBounds walked every vertex of every mesh under the City container: ~13-19 k meshes and
// ~25 M vertices in a tiled 3x3 world, up to 132 ms in ONE timer task after each streamed tile settled (the largest
// part of the tiled p95 frames after step 2). The box is a plain min / max over the same vertex set, so it can be
// assembled from per-geometry boxes:
//  - each geometry's box is computed once and cached by its vertex ARRAY (a WeakMap: a dropped tile frees its entry;
//    a replaced geometry is a new array; a mesh flagged gpuDirty, i.e. edited in place, is rescanned and its entry
//    dropped. Limit: an in-place vertex edit that is uploaded before the next walk keeps the old box. The callers' geometry
//    (City tiles, blocks, procedural objects) is rebuilt, never edited in place);
//  - the walk then reads cached boxes, and only the geometries that arrived since the last walk are scanned;
//  - GroupBoundsJob runs that in time slices (a few ms each), so a freshly landed tile is scanned across frames.
// The result is bit-identical: the same vertices, the same stride-12 position scan, min / max are order-free.

import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';

export interface Bounds6 { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** Per-geometry boxes, keyed by the vertex array (min x, y, z, max x, y, z). */
const geomBoxes = new WeakMap<Float32Array, Float64Array>();

/** Diagnostics: geometries scanned / served from the cache, slices run, the slowest slice. */
export const groupBoundsStats = { scanned: 0, cachedHits: 0, slices: 0, maxSliceMs: 0, lastTotalMs: 0, jobs: 0 };

/** The position min / max of an interleaved stride-12 vertex array (exactly the old cacheGroupBounds loop). */
export function scanVertexBox(v: Float32Array, out: Float64Array = new Float64Array(6)): Float64Array {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < v.length; i += 12) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
    return out;
}

/** The cached box of a mesh's geometry (scanned on first use; a gpuDirty mesh is rescanned). null = no vertices. */
export function meshGeometryBox(m: Mesh3D): Float64Array | null {
    const v = m.geometry?.vertices;
    if (!v || v.length === 0) return null;
    if (m.gpuDirty) { geomBoxes.delete(v); groupBoundsStats.scanned++; return scanVertexBox(v); }   // being edited: never trust / keep
    let b = geomBoxes.get(v);
    if (b) { groupBoundsStats.cachedHits++; return b; }
    b = scanVertexBox(v);
    groupBoundsStats.scanned++;
    geomBoxes.set(v, b);
    return b;
}

/** The meshes the old cacheGroupBounds visited, in the same order: every Mesh3D descendant of `group`'s children,
 *  skipping direct-child MeshGroup3Ds whose name `exclude` matches. */
export function boundsMeshes(group: MeshGroup3D, exclude?: (name: string) => boolean): Mesh3D[] {
    const out: Mesh3D[] = [];
    for (const child of group.children) {
        if (child instanceof MeshGroup3D && exclude?.(child.name ?? '')) continue;
        child.forEachDeep(n => { if (n instanceof Mesh3D) out.push(n); });
    }
    return out;
}

/** One aggregate-bounds computation, resumable in time slices. */
export class GroupBoundsJob {
    private readonly _meshes: Mesh3D[];
    private _i = 0;
    private _minX = Infinity; private _minY = Infinity; private _minZ = Infinity;
    private _maxX = -Infinity; private _maxY = -Infinity; private _maxZ = -Infinity;
    private _t = 0;

    constructor(readonly group: MeshGroup3D, exclude?: (name: string) => boolean) {
        this._meshes = boundsMeshes(group, exclude);
        groupBoundsStats.jobs++;
    }

    get done(): boolean { return this._i >= this._meshes.length; }

    /** Advance by about `budgetMs` (Infinity = finish now). Returns true when every mesh has been folded in. */
    step(budgetMs = Infinity): boolean {
        const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
        const t0 = now();
        const ms = this._meshes;
        let i = this._i;
        for (; i < ms.length; i++) {
            const b = meshGeometryBox(ms[i]);
            if (b) {
                if (b[0] < this._minX) this._minX = b[0]; if (b[3] > this._maxX) this._maxX = b[3];
                if (b[1] < this._minY) this._minY = b[1]; if (b[4] > this._maxY) this._maxY = b[4];
                if (b[2] < this._minZ) this._minZ = b[2]; if (b[5] > this._maxZ) this._maxZ = b[5];
            }
            if (budgetMs !== Infinity && (i & 31) === 31 && now() - t0 >= budgetMs) { i++; break; }
        }
        this._i = i;
        const el = now() - t0;
        this._t += el;
        groupBoundsStats.slices++;
        if (el > groupBoundsStats.maxSliceMs) groupBoundsStats.maxSliceMs = el;
        if (this.done) groupBoundsStats.lastTotalMs = this._t;
        return this.done;
    }

    /** The aggregate box (null when no mesh had vertices) — valid once `done`. */
    result(): Bounds6 | null {
        return isFinite(this._minX) ? { minX: this._minX, minY: this._minY, minZ: this._minZ, maxX: this._maxX, maxY: this._maxY, maxZ: this._maxZ } : null;
    }
}
