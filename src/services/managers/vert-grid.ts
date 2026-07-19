/**
 * Uniform spatial hash over body-vertex POSITIONS (12-float stride: pos at 0..2), for fast nearest-vertex
 * queries during the shrink-wrap collision fit. It replaces the O(clothVerts × bodyVerts) inner scan in
 * fitGarmentToBody / fitHairToBody with a local 3×3×3 cell lookup.
 *
 * The cell size IS the guaranteed search radius: `nearest()` examines every body vert within one cell of the
 * query point (a point within `cell` of the query can only fall in the 3×3×3 block around its cell). Choose
 * `cell` = the largest distance that can affect the fit (the push reach, and — for clothing — the weight-
 * transfer distance). A vert farther than that is neither pushed nor weight-transferred, so returning
 * best = -1 for it yields the same result as the old full scan (which would have found a far vert it then
 * ignored). Hash collisions only add extra (far) candidates to a query — they never drop a true neighbour —
 * so the nearest found is always correct.
 */
export class VertGrid {
    private readonly inv: number;
    private readonly cells = new Map<number, number[]>();

    /** @param verts body vertices, 12 floats/vert (position in 0..2). @param cell cell size = search radius. */
    constructor(private readonly verts: Float32Array, cell: number) {
        this.inv = 1 / cell;
        const n = (verts.length / 12) | 0;
        for (let b = 0; b < n; b++) {
            const key = this._key(verts[b * 12], verts[b * 12 + 1], verts[b * 12 + 2]);
            const arr = this.cells.get(key);
            if (arr) arr.push(b); else this.cells.set(key, [b]);
        }
    }

    private _hash(ix: number, iy: number, iz: number): number {
        return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
    }
    private _key(x: number, y: number, z: number): number {
        return this._hash(Math.floor(x * this.inv), Math.floor(y * this.inv), Math.floor(z * this.inv));
    }

    /** Nearest body-vert index to (x,y,z) within the 3×3×3 neighbourhood + its SQUARED distance.
     *  best = -1 (d2 = Infinity) when no body vert sits within ~one cell (the point is far from the body). */
    nearest(x: number, y: number, z: number): { best: number; d2: number } {
        const v = this.verts;
        const cx = Math.floor(x * this.inv), cy = Math.floor(y * this.inv), cz = Math.floor(z * this.inv);
        let best = -1, bestD = Infinity;
        for (let dz = -1; dz <= 1; dz++)
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                    const arr = this.cells.get(this._hash(cx + dx, cy + dy, cz + dz));
                    if (!arr) continue;
                    for (let i = 0; i < arr.length; i++) {
                        const b = arr[i], o = b * 12;
                        const ex = x - v[o], ey = y - v[o + 1], ez = z - v[o + 2];
                        const d = ex * ex + ey * ey + ez * ez;
                        if (d < bestD) { bestD = d; best = b; }
                    }
                }
        return { best, d2: bestD };
    }
}
