/**
 * INCREMENTAL DRAW RANK (engine-roadmap step 2 / step 3 hitch item; performance-plan.md §P13 "Step 2").
 *
 * The main pass orders its single-material opaque draws by a cached rank: the position of each mesh in
 *   meshes.slice().sort((a, b) => pipeOf(a) - pipeOf(b) || compare(a.geometryKey, b.geometryKey))
 * (a STABLE sort, so equal keys keep the input order). The rank was rebuilt from scratch on every structure change:
 * ~11.5 k meshes × log n geometry-key STRING compares + a full Map rebuild, ~10 ms in a tiled 3×3 world, paid on
 * every crowd-cell build and live-crowd promotion (the tiled p95 frame).
 *
 * This keeps the sorted order between updates and, on a change, only sorts the new / changed meshes and merges them
 * in. Geometry keys are interned to NUMERIC codes that preserve the string order (`GeomKeyCodes`), so the merge and
 * the order check compare numbers: (pipe, key code, input position) is a total order equal to the stable string
 * sort, hence the ranks are exactly the full sort's.
 *
 * Fallbacks to the full sort (identical result, original cost): no previous order, a duplicate mesh id in the input
 * (the old Map kept the LAST index for it — reproduced by the legacy path), more than a quarter of the meshes new,
 * or survivors whose relative input order changed (a re-parent / zIndex edit upstream).
 */

export interface RankedMesh { readonly id: string; readonly geometryKey: string }

/** Interns strings to numbers with the same order as the `<` string compare. New keys get a code between their
 *  neighbours; when two neighbours get too close (or a batch is large) every key is renumbered and `epoch` bumps. */
export class GeomKeyCodes {
  static STEP = 1024;
  private _keys: string[] = [];     // sorted
  private _codes: number[] = [];    // parallel, strictly increasing
  private readonly _map = new Map<string, number>();
  /** Bumped when existing codes change (a renumber): cached codes from an older epoch must be re-read. */
  epoch = 0;
  get size(): number { return this._keys.length; }
  has(key: string): boolean { return this._map.has(key); }
  /** The code of a key previously added (undefined if not). */
  get(key: string): number | undefined { return this._map.get(key); }

  /** Add any keys not yet known (a batch — sorted + merged once, then renumbered, when large). */
  addAll(keys: readonly string[]): void {
    const fresh: string[] = [];
    for (const k of keys) if (!this._map.has(k)) fresh.push(k);
    if (!fresh.length) return;
    if (fresh.length <= 32) { for (const k of fresh) this._insertOne(k); return; }
    const uniq = Array.from(new Set(fresh)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const merged: string[] = new Array(this._keys.length + uniq.length);
    let i = 0, j = 0, o = 0;
    const K = this._keys;
    while (i < K.length && j < uniq.length) merged[o++] = K[i] < uniq[j] ? K[i++] : uniq[j++];
    while (i < K.length) merged[o++] = K[i++];
    while (j < uniq.length) merged[o++] = uniq[j++];
    this._renumber(merged);
  }

  /** Rebuild from exactly `live` (drops keys no longer used). */
  rebuild(live: Iterable<string>): void {
    const keys = Array.from(new Set(live)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this._renumber(keys);
  }

  private _insertOne(key: string): void {
    const K = this._keys, C = this._codes;
    let lo = 0, hi = K.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (K[mid] < key) lo = mid + 1; else hi = mid; }
    let code: number;
    if (K.length === 0) code = 0;
    else if (lo === 0) code = C[0] - GeomKeyCodes.STEP;
    else if (lo === K.length) code = C[K.length - 1] + GeomKeyCodes.STEP;
    else {
      code = (C[lo - 1] + C[lo]) / 2;
      if (!(code > C[lo - 1] && code < C[lo])) {   // the gap is exhausted: renumber everything with the new key in place
        const keys = K.slice(); keys.splice(lo, 0, key);
        this._renumber(keys);
        return;
      }
    }
    K.splice(lo, 0, key); C.splice(lo, 0, code);
    this._map.set(key, code);
  }

  private _renumber(sortedKeys: string[]): void {
    this._keys = sortedKeys;
    this._codes = new Array(sortedKeys.length);
    this._map.clear();
    for (let i = 0; i < sortedKeys.length; i++) { const c = i * GeomKeyCodes.STEP; this._codes[i] = c; this._map.set(sortedKeys[i], c); }
    this.epoch++;
  }
}

interface Entry<M> { id: string; mesh: M; key: string; pipe: number; code: number; pos: number; stamp: number; fresh: boolean; rank: number }

export interface DrawRankStats { updates: number; merged: number; fullSorts: number; legacy: number; lastAdded: number; lastRemoved: number }

export class IncrementalDrawRank<M extends RankedMesh> {
  /** false = always the full sort (the A/B reference; still numeric-keyed, identical ranks). */
  incremental = true;
  readonly stats: DrawRankStats = { updates: 0, merged: 0, fullSorts: 0, legacy: 0, lastAdded: 0, lastRemoved: 0 };
  readonly codes = new GeomKeyCodes();
  private readonly _byId = new Map<string, Entry<M>>();
  private _sorted: Entry<M>[] = [];
  private _gen = 0;
  private _codeEpoch = -1;
  /** Set while the last update fell back to the exact old Map (duplicate ids). */
  private _legacy: Map<string, number> | null = null;

  /** The rank of a mesh id in the last update, or undefined (a mesh added since ranks at the tail, as before). */
  get(id: string): number | undefined {
    if (this._legacy) return this._legacy.get(id);
    return this._byId.get(id)?.rank;
  }
  /** P15 (gpu-scene.ts): the meshes of the last update in RANK order (rank 0 first), or null while the rank is in its
   *  legacy map (duplicate ids: use get()). Cached per update. */
  orderedMeshes(): readonly M[] | null {
    if (this._legacy) return null;
    if (this._orderedGen !== this._gen) {
      const s = this._sorted, out = this._ordered; out.length = s.length;
      for (let i = 0; i < s.length; i++) out[i] = s[i].mesh;
      this._orderedGen = this._gen;
    }
    return this._ordered;
  }
  /** P15: the meshes the last update added or re-ranked (merged in), or null after a full sort / the legacy map. */
  lastChangedMeshes(): readonly M[] | null {
    if (this._legacy || this._lastChanged === null) return null;
    const a = this._lastChanged, out: M[] = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i].mesh;
    return out;
  }
  private _lastChanged: Entry<M>[] | null = null;
  private readonly _ordered: M[] = [];
  private _orderedGen = -1;
  /** Forget a mesh (evicted). */
  delete(id: string): void { this._byId.delete(id); this._legacy?.delete(id); }
  clear(): void { this._byId.clear(); this._sorted = []; this._legacy = null; this._orderedGen = -1; }
  get size(): number { return this._legacy ? this._legacy.size : this._byId.size; }

  /** Re-rank `meshes` (the full current set, in input order). `pipeOf` = the pipeline class (0..3). */
  update(meshes: readonly M[], pipeOf: (m: M) => number): void {
    const st = this.stats; st.updates++;
    const gen = ++this._gen;
    const byId = this._byId;
    const added: Entry<M>[] = [];
    const newKeys: string[] = [];
    let dup = false;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      const key = m.geometryKey, pipe = pipeOf(m);
      let e = byId.get(m.id);
      if (!e) {
        e = { id: m.id, mesh: m, key, pipe, code: 0, pos: i, stamp: gen, fresh: true, rank: 0 };
        byId.set(m.id, e); added.push(e);
        if (!this.codes.has(key)) newKeys.push(key);
        continue;
      }
      if (e.stamp === gen) { dup = true; break; }
      if (e.mesh !== m || e.key !== key || e.pipe !== pipe) {
        e.mesh = m; e.pipe = pipe;
        if (e.key !== key) { e.key = key; if (!this.codes.has(key)) newKeys.push(key); }
        e.fresh = true; added.push(e);
      }
      e.pos = i; e.stamp = gen;
    }
    if (dup) { this._legacyUpdate(meshes, pipeOf); return; }
    this._legacy = null;
    // Prune: keys of evicted meshes accumulate (streamed tiles); rebuild the code table from the live set when it's
    // far bigger than the mesh count. Renumbering bumps the epoch → every entry re-reads its code below.
    if (this.codes.size + newKeys.length > 2 * meshes.length + 4096) {
      const live: string[] = []; for (let i = 0; i < meshes.length; i++) live.push(meshes[i].geometryKey);
      this.codes.rebuild(live);
    } else if (newKeys.length) this.codes.addAll(newKeys);
    // Survivors (previous order) and removals.
    const prev = this._sorted;
    const surv: Entry<M>[] = [];
    let removed = 0;
    for (let i = 0; i < prev.length; i++) {
      const e = prev[i];
      if (e.stamp !== gen) { if (byId.get(e.id) === e) byId.delete(e.id); removed++; continue; }
      if (!e.fresh) surv.push(e);
    }
    // Ids in the map that were neither in the last order nor seen now (deleted + re-added in between) can't exist:
    // every map entry is either in prev or added this update.
    const epochChanged = this.codes.epoch !== this._codeEpoch;
    this._codeEpoch = this.codes.epoch;
    if (epochChanged) for (let i = 0; i < surv.length; i++) surv[i].code = this.codes.get(surv[i].key)!;
    for (let i = 0; i < added.length; i++) added[i].code = this.codes.get(added[i].key)!;
    st.lastAdded = added.length; st.lastRemoved = removed;
    this._lastChanged = added;
    const cmp = (a: Entry<M>, b: Entry<M>): number => (a.pipe - b.pipe) || (a.code - b.code) || (a.pos - b.pos);
    let out: Entry<M>[] | null = null;
    if (this.incremental && prev.length > 0 && surv.length + added.length === meshes.length && added.length * 4 <= meshes.length + 64) {
      let ok = true;
      for (let i = 1; i < surv.length; i++) if (cmp(surv[i - 1], surv[i]) > 0) { ok = false; break; }
      if (ok) {
        if (added.length === 0) out = surv;
        else {
          added.sort(cmp);
          out = new Array(meshes.length);
          let i = 0, j = 0, o = 0;
          while (i < surv.length && j < added.length) out[o++] = cmp(surv[i], added[j]) <= 0 ? surv[i++] : added[j++];
          while (i < surv.length) out[o++] = surv[i++];
          while (j < added.length) out[o++] = added[j++];
        }
        st.merged++;
      }
    }
    if (!out) {
      out = new Array(meshes.length);
      for (let i = 0; i < meshes.length; i++) out[i] = byId.get(meshes[i].id)!;
      out.sort(cmp);
      st.fullSorts++;
      this._lastChanged = null;   // a full sort: anything may have moved
    }
    for (let i = 0; i < out.length; i++) { const e = out[i]; e.rank = i; e.fresh = false; }
    this._sorted = out;
  }

  /** The exact old code (string sort + Map, the LAST index wins for a duplicated id). */
  private _legacyUpdate(meshes: readonly M[], pipeOf: (m: M) => number): void {
    this.stats.legacy++;
    this._lastChanged = null;
    const tmp = meshes.slice().sort((a, b) => {
      const p = pipeOf(a) - pipeOf(b);
      if (p !== 0) return p;
      const ak = a.geometryKey, bk = b.geometryKey;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    const m = new Map<string, number>();
    for (let i = 0; i < tmp.length; i++) m.set(tmp[i].id, i);
    this._legacy = m;
    this._byId.clear(); this._sorted = [];   // the next duplicate-free update starts from a full sort
  }
}

/** Reference: the original full rank (tests). */
export function fullDrawRank<M extends RankedMesh>(meshes: readonly M[], pipeOf: (m: M) => number): Map<string, number> {
  const tmp = meshes.slice().sort((a, b) => {
    const p = pipeOf(a) - pipeOf(b);
    if (p !== 0) return p;
    const ak = a.geometryKey, bk = b.geometryKey;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  const m = new Map<string, number>();
  for (let i = 0; i < tmp.length; i++) m.set(tmp[i].id, i);
  return m;
}
