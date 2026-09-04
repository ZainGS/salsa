/**
 * SpatialGridXZ — a uniform XZ broadphase for Play-mode collision (docs/specs/play-mode.md).
 *
 * Play casts a ground ray (down) and a wall ray (horizontal) every fixed step. Testing every city mesh per cast is
 * O(meshes) twice a tick — untenable at street scale. This grid buckets mesh XZ-AABBs into cells so a cast only tests
 * the handful of meshes near the character. Pure + index-based (no scene refs), so it's deterministic + unit-testable;
 * the manager maps returned indices back to meshes.
 *
 * Oversized AABBs (e.g. a city-spanning ground plane) would flood thousands of cells, so any AABB spanning more than
 * `oversizedCellCap` cells goes in an always-tested list instead — the common "one giant ground" case stays cheap.
 */

export interface XZBounds { minX: number; minZ: number; maxX: number; maxZ: number; }

export class SpatialGridXZ {
  readonly cellSize: number;
  private readonly _cells = new Map<string, number[]>();
  private readonly _oversized: number[] = [];
  private _count = 0;
  private _stamp: Int32Array = new Int32Array(0);   // dedup-by-generation across multi-cell queries
  private _gen = 0;

  constructor(cellSize: number, private readonly oversizedCellCap = 256) {
    this.cellSize = cellSize > 1e-6 ? cellSize : 1;
  }

  /** Build a grid over a list of AABBs (index = position in the array), auto-picking a cell size from their average
   *  footprint (so a typical mesh spans ~1 cell regardless of world scale). */
  static build(aabbs: XZBounds[], oversizedCellCap = 256): SpatialGridXZ {
    let sum = 0;
    for (const b of aabbs) sum += ((b.maxX - b.minX) + (b.maxZ - b.minZ)) * 0.5;
    const cell = aabbs.length ? Math.max(sum / aabbs.length, 1e-3) : 1;
    const g = new SpatialGridXZ(cell, oversizedCellCap);
    for (let i = 0; i < aabbs.length; i++) g.insert(i, aabbs[i]);
    return g;
  }

  private static _key(cx: number, cz: number): string { return cx + ',' + cz; }

  insert(index: number, b: XZBounds): void {
    if (index + 1 > this._count) this._count = index + 1;
    const cs = this.cellSize;
    const x0 = Math.floor(b.minX / cs), x1 = Math.floor(b.maxX / cs);
    const z0 = Math.floor(b.minZ / cs), z1 = Math.floor(b.maxZ / cs);
    const span = (x1 - x0 + 1) * (z1 - z0 + 1);
    if (span > this.oversizedCellCap) { this._oversized.push(index); return; }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = SpatialGridXZ._key(cx, cz);
        const arr = this._cells.get(k);
        if (arr) arr.push(index); else this._cells.set(k, [index]);
      }
    }
  }

  /** Fill `out` with the unique candidate indices whose cells overlap the query region (+ all oversized). Reuse one
   *  `out` array across calls to avoid per-tick allocation. Returns `out`. */
  query(b: XZBounds, out: number[]): number[] {
    out.length = 0;
    if (this._stamp.length < this._count) this._stamp = new Int32Array(this._count);
    const gen = ++this._gen;
    const push = (i: number) => { if (this._stamp[i] !== gen) { this._stamp[i] = gen; out.push(i); } };
    for (const i of this._oversized) push(i);
    const cs = this.cellSize;
    const x0 = Math.floor(b.minX / cs), x1 = Math.floor(b.maxX / cs);
    const z0 = Math.floor(b.minZ / cs), z1 = Math.floor(b.maxZ / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this._cells.get(SpatialGridXZ._key(cx, cz));
        if (arr) for (const i of arr) push(i);
      }
    }
    return out;
  }

  /** Candidates for a single column (point) — the ground down-ray case. */
  queryPoint(x: number, z: number, out: number[]): number[] {
    return this.query({ minX: x, minZ: z, maxX: x, maxZ: z }, out);
  }
}
