/**
 * HIERARCHICAL CULL CLUSTERS (performance-plan P9, P7.9). A tiled city is ~11 k meshes; the per-frame draw-list build
 * visits every one of them (world box, distance LOD, light box, shadow reach, cascades, camera frustum) although at
 * street level ~60 % are behind the camera and most of those cannot cast into the view either. The renderer groups
 * its STATIC meshes into spatial clusters (an XZ grid over their world boxes); a cluster whose union box is outside
 * the camera frustum and whose shadow cannot reach the view (or that is outside the light box) rejects all of its
 * members at once. Members are still visited in the original order (the draw lists and their batching stay
 * identical), but a rejected member costs a few property reads instead of the full test chain.
 *
 * A member's fast path is only taken while its world box is exactly the one the cluster was built from (same
 * matrix version, no geometry change) — anything that moved is processed normally and triggers a rebuild. A cluster
 * also carries a per-frame FOG verdict (fog horizon, `fogPast`): wholly past the fog edge, its members of a culled fog
 * class are dropped the same way, from the main and shadow lists alike (the renderer keeps the per-member class check,
 * so a building or no-fog member in the same cluster is still processed). This
 * module is the pure half: building the clusters and the per-frame verdict. The renderer owns the loop.
 */

/** Verdicts. PASS = test the members one by one. OUT = no member is drawn or casts (outside the view and the light
 *  box, or no shadows this frame). NOREACH = outside the view and every member's shadow misses it (members may still
 *  belong to the P4.2 static shadow cache, which keeps off-view casters). */
export const HC_PASS = 0, HC_OUT = 1, HC_NOREACH = 2;

export interface CullCluster {
  /** The renderer that built it (a mesh may be drawn by several renderers). */
  owner: object;
  /** Union of the members' world boxes at build time: minX, minY, minZ, maxX, maxY, maxZ. */
  box: Float64Array;
  /** Members assigned at build time. */
  size: number;
  /** Frame number of `verdict`. */
  frame: number;
  verdict: number;
  /** FOG HORIZON (2026-10-01): this frame, the whole union box lies past the fog edge x 1.01 (from the fog eye), so
   *  every member of a culled fog class can be dropped without its own test. Set with `verdict` (same `frame`). */
  fogPast: boolean;
}

/** The per-mesh slots the clustering writes (fields on Mesh3D; renderer-private). */
export interface ClusterMember {
  _hcC: CullCluster | null;
  /** The mesh's matrix version at the last build (a clustered member's fast path requires the same version). */
  _hcVer: number;
  /** Serial of the last build that visited the mesh. */
  _hcB: number;
}

export interface ClusterBox { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** Average members per finest-level cluster the grid aims for. */
export const HC_TARGET_MEMBERS = 32;

let _buildSerial = 0;

/**
 * Assign every eligible mesh in `meshes` to a cluster of `owner` — a LOOSE QUADTREE over the XZ plane, flattened:
 * level 0 is a grid sized for ~`target` members per cell, each further level doubles the cell. A mesh goes to the
 * finest level whose cell is at least as wide as its box (a city-wide road layer lands in the one top cell), into the
 * cell holding its box centre, so a cluster's box is never more than about twice its cell. Every visited mesh gets
 * this build's serial in `_hcB` (so the renderer can tell new meshes from ones that were left out on purpose).
 * Returns the number of meshes clustered.
 */
export function buildCullClusters<M extends ClusterMember>(owner: object, meshes: readonly M[], boxOf: (m: M) => ClusterBox | null,
    eligible: (m: M) => boolean, version: (m: M) => number, target = HC_TARGET_MEMBERS): number {
  const serial = ++_buildSerial;
  const n = meshes.length;
  const cand: number[] = [];
  const bx = new Float64Array(n * 6);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const m = meshes[i];
    m._hcB = serial; m._hcVer = version(m);
    if (m._hcC && m._hcC.owner === owner) m._hcC = null;
    if (!eligible(m)) continue;
    const b = boxOf(m);
    if (!b || !(b.maxX >= b.minX) || !(b.maxZ >= b.minZ) || !Number.isFinite(b.minX + b.maxX + b.minY + b.maxY + b.minZ + b.maxZ)) continue;
    cand.push(i);
    const o = i * 6;
    bx[o] = b.minX; bx[o + 1] = b.minY; bx[o + 2] = b.minZ; bx[o + 3] = b.maxX; bx[o + 4] = b.maxY; bx[o + 5] = b.maxZ;
    if (b.minX < x0) x0 = b.minX; if (b.maxX > x1) x1 = b.maxX;
    if (b.minZ < z0) z0 = b.minZ; if (b.maxZ > z1) z1 = b.maxZ;
  }
  if (cand.length < 2 * target) return 0;
  const W = Math.max(x1 - x0, z1 - z0, 1e-9);
  const g0 = Math.max(1, Math.min(256, Math.round(Math.sqrt(cand.length / target))));
  const c0 = W / g0;
  const levels: Map<number, CullCluster>[] = [];
  let k = 0;
  for (const i of cand) {
    const o = i * 6, e = Math.max(bx[o + 3] - bx[o], bx[o + 5] - bx[o + 2]);
    let lv = 0, cs = c0;
    while (cs < e && cs < W) { lv++; cs *= 2; }
    const g = Math.max(1, Math.ceil(W / cs));
    let gx = Math.floor(((bx[o] + bx[o + 3]) * 0.5 - x0) / cs), gz = Math.floor(((bx[o + 2] + bx[o + 5]) * 0.5 - z0) / cs);
    if (gx >= g) gx = g - 1; if (gz >= g) gz = g - 1;
    if (gx < 0) gx = 0; if (gz < 0) gz = 0;
    const L = levels[lv] ??= new Map();
    let c = L.get(gz * g + gx);
    if (!c) { c = { owner, box: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity), size: 0, frame: -1, verdict: HC_PASS, fogPast: false }; L.set(gz * g + gx, c); }
    const B = c.box;
    if (bx[o] < B[0]) B[0] = bx[o]; if (bx[o + 1] < B[1]) B[1] = bx[o + 1]; if (bx[o + 2] < B[2]) B[2] = bx[o + 2];
    if (bx[o + 3] > B[3]) B[3] = bx[o + 3]; if (bx[o + 4] > B[4]) B[4] = bx[o + 4]; if (bx[o + 5] > B[5]) B[5] = bx[o + 5];
    c.size++;
    meshes[i]._hcC = c;
    k++;
  }
  return k;
}

/** The frustum / reach tests a verdict needs (the renderer's cullers, bound). */
export interface ClusterTests {
  /** Camera frustum (null = no frustum culling → every cluster passes). */
  inView: ((b: Float64Array) => boolean) | null;
  /** Whether a shadow list is being built this frame. */
  shadows: boolean;
  /** Light box (null = no light culling). */
  inLight: ((b: Float64Array) => boolean) | null;
  /** Whether the box's shadow can reach the view (null = no reach test → a lit, off-view cluster passes). */
  reaches: ((b: Float64Array) => boolean) | null;
}

/** The cluster's verdict for this frame (see HC_*). Conservative: a sub-box of a rejected box is rejected by every
 *  one of these tests too (plane tests and the swept shadow box are monotone in the box). */
export function clusterVerdict(c: CullCluster, t: ClusterTests): number {
  if (!t.inView || t.inView(c.box)) return HC_PASS;
  if (!t.shadows) return HC_OUT;
  if (t.inLight && !t.inLight(c.box)) return HC_OUT;
  if (t.reaches && !t.reaches(c.box)) return HC_NOREACH;
  return HC_PASS;
}
