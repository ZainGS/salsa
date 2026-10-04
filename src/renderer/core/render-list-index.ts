/**
 * RENDER-LIST INDEX (engine-roadmap step 2, performance-plan.md §P13 "Step 2").
 *
 * The host renderer keeps a flat, zIndex-ordered list of every Shape in the scene graph and re-filters it into the
 * frame's render list. In a 3D world the scene graph is ~19 k nodes of which almost all are 3D (meshes, mesh groups,
 * array groups), and the editor's 2D steps (the render strategy's beginFrame, the caret and text-selection
 * collectors, the below / above-raster split) used to loop over all of them every frame, finding nothing to do.
 *
 * This index splits one structure walk into per-kind lists:
 *   - `flat2D`: the nodes the 2D strategy can act on (everything except the 3D kinds below);
 *   - `flat3D`: Mesh3D / ParticleEmitter3D / GpObject3D, the nodes the 3D passes draw;
 *   - `skeletons`: every Skeleton3D (the grease-pencil pass binds strokes to them);
 * and keeps each list in the SAME order the old code produced: a stable zIndex sort of the depth-first (preorder)
 * walk, i.e. ordered by (zIndex, walk position).
 *
 * INCREMENTAL: a structure change (a crowd cell, a live-crowd promotion) adds or removes a handful of nodes in a
 * 19 k-node tree. The walk itself is cheap (an explicit stack, no closure per node); the expensive part was the
 * full O(n log n) re-sort. Each node carries the generation of the last walk that saw it (`_rlGen`) and its walk
 * position (`_rlPos`), so a list is rebuilt by:
 *   1. keeping the previous list's nodes that this walk saw again (survivors), in their previous order;
 *   2. checking in O(n) that the survivors are still ordered by (zIndex, walk position): a zIndex edit or a
 *      reorder of siblings fails the check and falls back to the full sort;
 *   3. sorting only the new nodes and merging them in.
 * The result is exactly the full stable sort (positions are distinct, so the order is total). Any doubt (a node
 * seen twice in one walk, counts that don't add up, more than a quarter of the list new) takes the full sort.
 *
 * Pure (no renderer or DOM dependency) so it is unit-tested against the full rescan.
 */

/** The fields the index reads and writes on a scene node. */
export interface RenderListNode {
  zIndex: number;
  children: RenderListNode[];
  /** Generation of the last index walk that visited this node (0 = never). Index bookkeeping only. */
  _rlGen: number;
  /** This node's preorder position in that walk. Index bookkeeping only. */
  _rlPos: number;
  /** Inherited "render below raster" (PanelLayout subtrees) — read during the walk. */
  renderBelowRaster?: boolean;
}

/** classify() result bits. */
export const RL_2D = 1;
export const RL_3D = 2;
export const RL_SKELETON = 4;

/** Generations are unique across every index instance, so two indexes walking the same nodes never confuse stamps. */
let _globalGen = 0;

export interface RenderListIndexStats {
  walks: number;
  /** Lists rebuilt by the survivor merge (two per walk: 2D and 3D). */
  merged: number;
  /** Lists rebuilt by the full stable sort. */
  fullSorts: number;
  /** Nodes added / removed in the last walk (both lists). */
  lastAdded: number;
  lastRemoved: number;
  /** Total nodes visited in the last walk. */
  lastNodes: number;
}

const cmpZ = (a: RenderListNode, b: RenderListNode): number => (a.zIndex - b.zIndex) || (a._rlPos - b._rlPos);

export class RenderListIndex<N extends RenderListNode = RenderListNode> {
  /** Use the survivor merge (true) or always re-sort the whole walk (false: the A/B reference). */
  incremental = true;
  flat2D: N[] = [];
  flat3D: N[] = [];
  skeletons: N[] = [];
  /** True when some 3D-list node sits under a renderBelowRaster ancestor (then the per-frame live check is needed). */
  any3DBelowRaster = false;
  /** Bumped on every walk (consumers key per-walk caches on it). */
  version = 0;
  readonly stats: RenderListIndexStats = { walks: 0, merged: 0, fullSorts: 0, lastAdded: 0, lastRemoved: 0, lastNodes: 0 };

  private _gen = 0;          // this index's last walk generation
  private readonly _stack: N[] = [];
  private readonly _below: boolean[] = [];
  private readonly _w2: N[] = [];
  private readonly _w3: N[] = [];
  private readonly _a2: N[] = [];
  private readonly _a3: N[] = [];

  /** `classify(node)` → a bitmask of RL_2D / RL_3D / RL_SKELETON (0 = in no list). Must be constant per node. */
  constructor(private readonly classify: (n: N) => number) {}

  /** Re-walk the tree under `root` (preorder, like Node.forEachDeep) and rebuild the lists. */
  walk(root: N): void {
    const prevGen = this._gen;
    const gen = this._gen = ++_globalGen;
    const st = this.stats;
    st.walks++; this.version++;
    const w2 = this._w2, w3 = this._w3, a2 = this._a2, a3 = this._a3, stack = this._stack, below = this._below;
    w2.length = 0; w3.length = 0; a2.length = 0; a3.length = 0;
    const skeletons: N[] = [];
    let pos = 0, dup = false, any3DBelow = false;
    stack.length = 0; below.length = 0;
    stack.push(root); below.push(false);
    while (stack.length) {
      const n = stack.pop()!;
      const inh = below.pop()!;
      if (n._rlGen === gen) dup = true;   // the same node reached twice in one walk
      const seenBefore = n._rlGen === prevGen && prevGen !== 0;
      n._rlGen = gen; n._rlPos = pos++;
      const b = inh || !!n.renderBelowRaster;
      const k = this.classify(n);
      if (k & RL_2D) { w2.push(n); if (!seenBefore) a2.push(n); }
      if (k & RL_3D) { w3.push(n); if (!seenBefore) a3.push(n); if (b) any3DBelow = true; }
      if (k & RL_SKELETON) skeletons.push(n);
      const ch = n.children as N[];
      for (let i = ch.length - 1; i >= 0; i--) { stack.push(ch[i]); below.push(b); }
    }
    st.lastNodes = pos;
    const r2 = this._rebuild(this.flat2D, w2, a2, gen, dup);
    const r3 = this._rebuild(this.flat3D, w3, a3, gen, dup);
    st.lastAdded = a2.length + a3.length;
    st.lastRemoved = r2.removed + r3.removed;
    this.flat2D = r2.list; this.flat3D = r3.list;
    this.skeletons = skeletons;
    this.any3DBelowRaster = any3DBelow;
  }

  /** Force the next walk to rebuild every list with the full sort (e.g. after the lists were re-sorted elsewhere). */
  reset(): void { this._gen = 0; this.flat2D = []; this.flat3D = []; }

  private _rebuild(prev: N[], walk: N[], added: N[], gen: number, dup: boolean): { list: N[]; removed: number } {
    // Survivors: the previous list's nodes this walk saw again, in their previous order.
    const surv: N[] = [];
    for (let i = 0; i < prev.length; i++) if (prev[i]._rlGen === gen) surv.push(prev[i]);
    const removed = prev.length - surv.length;
    const full = (): { list: N[]; removed: number } => { this.stats.fullSorts++; return { list: walk.slice().sort(cmpZ), removed }; };
    if (!this.incremental || dup || prev.length === 0 || surv.length + added.length !== walk.length
        || added.length * 4 > walk.length + 64) return full();
    // The survivors must still be in (zIndex, walk position) order: a zIndex edit or a sibling reorder breaks it.
    for (let i = 1; i < surv.length; i++) if (cmpZ(surv[i - 1], surv[i]) > 0) return full();
    if (added.length === 0) { this.stats.merged++; return { list: surv, removed }; }
    added.sort(cmpZ);
    const out: N[] = new Array(walk.length);
    let i = 0, j = 0, o = 0;
    while (i < surv.length && j < added.length) out[o++] = cmpZ(surv[i], added[j]) <= 0 ? surv[i++] : added[j++];
    while (i < surv.length) out[o++] = surv[i++];
    while (j < added.length) out[o++] = added[j++];
    this.stats.merged++;
    return { list: out, removed };
  }
}

/** Reference: the old behaviour — preorder walk, then a stable sort by zIndex (for tests and the A/B switch). */
export function fullRescan<N extends RenderListNode>(root: N, classify: (n: N) => number, bit: number): N[] {
  const out: N[] = [];
  const visit = (n: N): void => { if (classify(n) & bit) out.push(n); for (const c of n.children as N[]) visit(c); };
  visit(root);
  return out.sort((a, b) => a.zIndex - b.zIndex);
}
