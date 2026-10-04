/**
 * Slot allocator for the renderer's instance storage buffer (P5 follow-up, docs/specs/performance-plan.md).
 *
 * Hands out CONTIGUOUS ranges of instance slots inside [0, capacity): single slots for meshes and N-slot ranges for
 * GPU-instanced array groups (one instanced draw needs its N copies back to back). Before this, the incremental
 * instance path could only append single mesh slots; any change to the array-group SET (the city zoom tiers show or
 * hide ~286 groups on every view switch) forced a full re-sort + re-write of every slot.
 *
 * Free space is kept in two forms:
 *  - UNOWNED free ranges (anything evicted / released for good). Reused first, best fit. Never coalesced on free
 *    (frees are O(1)); a range request that finds no fit merges the whole free list once ("lazy compaction") and
 *    retries before giving up.
 *  - OWNED ("parked") ranges: a released range that still holds its owner's data (an array group the view just hid).
 *    `claimOwned(owner, count)` hands the SAME range back without a rewrite when the owner returns. Parked ranges are
 *    only reused for someone else after the unowned list and the high-water both failed, so flipping between two
 *    view modes keeps both groups' data resident while capacity allows.
 *
 * Returns -1 when nothing fits — the caller then falls back to its full repack (which compacts everything and calls
 * `reset`). Pure bookkeeping, no GPU types: unit-tested in instance-slot-allocator.test.ts.
 */
import { STREAM_HITCH } from './stream-hitch';

export interface SlotRange { start: number; count: number }

/** Size bucket of a free range (floor(log2(count))): bucket 0 = single slots. */
function bucketOf(count: number): number { return 31 - Math.clz32(count); }

export class SlotRangeAllocator {
  private _capacity = 0;
  private _high = 0;
  /** Unowned free ranges (unsorted; single-slot frees are the common case → pop from the end). */
  private _free: SlotRange[] = [];
  /** Parked ranges: owner → the range it released (data still intact). */
  private readonly _owned = new Map<string, SlotRange>();
  /** Called when a parked range is taken over by someone else (its data is about to be overwritten). */
  onDisown: ((owner: string) => void) | null = null;
  // P16 indexedSlotFree (STREAM_HITCH): the unowned free space as MAXIMAL ranges (coalesced on every free, keyed by
  // start and by end) in size buckets, instead of `_free`. A range alloc scans one or two buckets; a free is O(1).
  // The P5 list kept every evicted mesh slot as its own entry and every range alloc scanned all of them (thousands
  // per tile landing, times hundreds of new array groups: about 20 ms a frame).
  private _indexed = false;
  private readonly _byStart = new Map<number, SlotRange>();
  private readonly _byEnd = new Map<number, SlotRange>();
  private readonly _buckets: Set<SlotRange>[] = [];

  get capacity(): number { return this._capacity; }
  /** One past the highest slot ever handed out since the last reset (the append point). */
  get high(): number { return this._high; }
  /** Total free slots (unowned + parked) below the high-water. */
  get freeSlots(): number {
    this._syncMode();
    let n = 0;
    for (const r of this._free) n += r.count;
    for (const r of this._byStart.values()) n += r.count;
    for (const r of this._owned.values()) n += r.count;
    return n;
  }
  get parkedCount(): number { return this._owned.size; }

  /** After a full repack: [0, high) is packed solid, nothing free, nothing parked. */
  reset(high: number, capacity: number): void {
    this._high = high;
    this._capacity = capacity;
    this._free.length = 0;
    this._byStart.clear(); this._byEnd.clear(); for (const b of this._buckets) b.clear();
    this._indexed = STREAM_HITCH.indexedSlotFree;
    if (this._owned.size) {
      const owners = [...this._owned.keys()];
      this._owned.clear();
      if (this.onDisown) for (const o of owners) this.onDisown(o);
    }
  }

  /** The buffer grew (contents preserved by the caller) — more room above the high-water. */
  setCapacity(capacity: number): void { this._capacity = capacity; }

  /** Is `owner`'s parked range (of exactly `count` slots) still intact? */
  hasOwned(owner: string, count: number): boolean {
    const r = this._owned.get(owner);
    return !!r && r.count === count;
  }

  /** Take back `owner`'s parked range when it is still intact and the same size: returns its start (the data there is
   *  unchanged), else -1. A size mismatch releases the parked range to the unowned list. */
  claimOwned(owner: string, count: number): number {
    const r = this._owned.get(owner);
    if (!r) return -1;
    this._owned.delete(owner);
    if (r.count === count) return r.start;
    this._pushFree(r.start, r.count);
    return -1;
  }

  /** Drop `owner`'s parked range (its data went stale) — the slots become ordinary free space. */
  disown(owner: string): void {
    const r = this._owned.get(owner);
    if (!r) return;
    this._owned.delete(owner);
    this._pushFree(r.start, r.count);
  }

  /** Allocate `count` contiguous slots. Order: best-fit unowned range → high-water → lazy merge of the unowned list →
   *  steal a parked range (best fit) → merge everything (parked included) → -1. */
  alloc(count: number): number {
    if (count <= 0) return -1;
    this._syncMode();
    let s = this._fitUnowned(count);
    if (s >= 0) return s;
    if (this._high + count <= this._capacity) { s = this._high; this._high += count; return s; }
    if (!this._indexed && this._free.length > 1 && this._mergeUnowned()) {
      s = this._fitUnowned(count);
      if (s >= 0) return s;
      if (this._high + count <= this._capacity) { s = this._high; this._high += count; return s; }
    }
    if (this._owned.size) {
      s = this._stealOwned(count);
      if (s >= 0) return s;
      this._disownAll();
      this._mergeUnowned();
      s = this._fitUnowned(count);
      if (s >= 0) return s;
      if (this._high + count <= this._capacity) { s = this._high; this._high += count; return s; }
    }
    return -1;
  }

  /** Release a range. With `owner`, it is PARKED (data kept for `claimOwned`); a previous parked range of the same
   *  owner is released first. Without, it joins the unowned free list. */
  free(start: number, count: number, owner?: string): void {
    if (count <= 0) return;
    this._syncMode();
    if (owner !== undefined) {
      const prev = this._owned.get(owner);
      if (prev) this._pushFree(prev.start, prev.count);
      this._owned.set(owner, { start, count });
      return;
    }
    if (this._indexed) { this._ixAdd(start, count); return; }
    if (start + count === this._high) { this._high = start; return; }   // flush with the tail → retract
    this._free.push({ start, count });
  }

  /** Unowned free ranges as [start, count] pairs sorted by start (tests / diagnostics; either mode). */
  freeRanges(): Array<[number, number]> {
    this._syncMode();
    const out: Array<[number, number]> = [];
    for (const r of this._free) if (r.count > 0) out.push([r.start, r.count]);
    for (const r of this._byStart.values()) out.push([r.start, r.count]);
    return out.sort((a, b) => a[0] - b[0]);
  }
  /** Number of unowned free-range entries (the P5 list grows by one per freed slot; the indexed form stays maximal). */
  get freeEntries(): number { return this._free.length + this._byStart.size; }

  /** Release an unowned range into whichever free structure is live (the legacy list keeps its no-coalesce rule). */
  private _pushFree(start: number, count: number): void {
    if (count <= 0) return;
    if (this._indexed) this._ixAdd(start, count); else this._free.push({ start, count });
  }
  /** Follow the switch: convert the free space when STREAM_HITCH.indexedSlotFree flipped since the last call. */
  private _syncMode(): void {
    const want = STREAM_HITCH.indexedSlotFree;
    if (want === this._indexed) return;
    if (want) {
      const old = this._free.splice(0);
      this._indexed = true;
      for (const r of old) if (r.count > 0) this._ixAdd(r.start, r.count);
    } else {
      const old = [...this._byStart.values()];
      this._byStart.clear(); this._byEnd.clear(); for (const b of this._buckets) b.clear();
      this._indexed = false;
      for (const r of old) this._free.push({ start: r.start, count: r.count });
    }
  }
  // indexed form
  private _ixInsert(r: SlotRange): void {
    this._byStart.set(r.start, r); this._byEnd.set(r.start + r.count, r);
    const b = bucketOf(r.count);
    while (this._buckets.length <= b) this._buckets.push(new Set());
    this._buckets[b].add(r);
  }
  private _ixRemove(r: SlotRange): void {
    this._byStart.delete(r.start); this._byEnd.delete(r.start + r.count);
    this._buckets[bucketOf(r.count)]?.delete(r);
  }
  /** Add [start, start + count) to the free space, merged with the free ranges touching it; retracts the high-water
   *  when it ends there (the range before it is then in use, or it would have merged). */
  private _ixAdd(start: number, count: number): void {
    const p = this._byEnd.get(start);
    if (p) { this._ixRemove(p); start = p.start; count += p.count; }
    const n = this._byStart.get(start + count);
    if (n) { this._ixRemove(n); count += n.count; }
    if (start + count === this._high) { this._high = start; return; }
    this._ixInsert({ start, count });
  }
  /** Best fit in the smallest bucket that can hold `count`, else the smallest range of the next non-empty bucket. */
  private _ixFit(count: number): number {
    const B = this._buckets;
    let best: SlotRange | null = null;
    const b0 = bucketOf(count);
    if (b0 < B.length) {
      let bestWaste = Infinity;
      for (const r of B[b0]) { const w = r.count - count; if (w >= 0 && w < bestWaste) { best = r; bestWaste = w; if (w === 0) break; } }
    }
    for (let k = b0 + 1; best === null && k < B.length; k++) {
      if (!B[k].size) continue;
      for (const r of B[k]) if (best === null || r.count < best.count) best = r;
    }
    if (best === null) return -1;
    this._ixRemove(best);
    const s = best.start;
    if (best.count > count) this._ixInsert({ start: s + count, count: best.count - count });   // its neighbours are in use
    return s;
  }

  private _fitUnowned(count: number): number {
    if (this._indexed) return this._ixFit(count);
    const f = this._free;
    if (count === 1) {   // fast path: any range will do — take from the last one
      for (let i = f.length - 1; i >= 0; i--) {
        const r = f[i];
        if (r.count < 1) continue;
        const s = r.start; r.start++; r.count--;
        if (r.count === 0) { f[i] = f[f.length - 1]; f.pop(); }
        return s;
      }
      return -1;
    }
    let best = -1, bestWaste = Infinity;
    for (let i = 0; i < f.length; i++) {
      const w = f[i].count - count;
      if (w >= 0 && w < bestWaste) { best = i; bestWaste = w; if (w === 0) break; }
    }
    if (best < 0) return -1;
    const r = f[best], s = r.start;
    r.start += count; r.count -= count;
    if (r.count === 0) { f[best] = f[f.length - 1]; f.pop(); }
    return s;
  }

  private _stealOwned(count: number): number {
    let bestOwner: string | null = null, bestWaste = Infinity;
    for (const [o, r] of this._owned) {
      const w = r.count - count;
      if (w >= 0 && w < bestWaste) { bestOwner = o; bestWaste = w; if (w === 0) break; }
    }
    if (bestOwner === null) return -1;
    const r = this._owned.get(bestOwner)!;
    this._owned.delete(bestOwner);
    this.onDisown?.(bestOwner);
    if (r.count > count) this._pushFree(r.start + count, r.count - count);
    return r.start;
  }

  private _disownAll(): void {
    const all = [...this._owned];
    this._owned.clear();
    for (const [o, r] of all) { this._pushFree(r.start, r.count); this.onDisown?.(o); }
    this._owned.clear();
  }

  /** Sort + coalesce the unowned list; retract the high-water over a trailing free run. Returns whether it changed. */
  private _mergeUnowned(): boolean {
    if (this._indexed) return false;   // always merged
    const f = this._free;
    if (!f.length) return false;
    const before = f.length, highBefore = this._high;
    f.sort((a, b) => a.start - b.start);
    let w = 0;
    for (let i = 0; i < f.length; i++) {
      const r = f[i];
      if (r.count <= 0) continue;
      if (w > 0 && f[w - 1].start + f[w - 1].count === r.start) f[w - 1].count += r.count;
      else f[w++] = { start: r.start, count: r.count };
    }
    f.length = w;
    if (w > 0 && f[w - 1].start + f[w - 1].count === this._high) { this._high = f[w - 1].start; f.length = w - 1; }
    return f.length !== before || this._high !== highBefore;
  }
}
