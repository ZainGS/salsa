import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SlotRangeAllocator } from './instance-slot-allocator';
import { STREAM_HITCH } from './stream-hitch';

/** Live ranges must never overlap and must stay inside [0, capacity). */
function assertDisjoint(ranges: Array<[number, number]>, capacity: number): void {
  const used = new Uint8Array(capacity);
  for (const [s, n] of ranges) {
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s + n).toBeLessThanOrEqual(capacity);
    for (let i = s; i < s + n; i++) { expect(used[i]).toBe(0); used[i] = 1; }
  }
}

for (const indexed of [false, true]) describe(`SlotRangeAllocator (P16 indexedSlotFree=${indexed})`, () => {
  const was = STREAM_HITCH.indexedSlotFree;
  beforeEach(() => { STREAM_HITCH.indexedSlotFree = indexed; });
  afterEach(() => { STREAM_HITCH.indexedSlotFree = was; });
  it('appends at the high-water after a reset and fails past capacity', () => {
    const a = new SlotRangeAllocator();
    a.reset(10, 20);
    expect(a.alloc(4)).toBe(10);
    expect(a.alloc(6)).toBe(14);
    expect(a.high).toBe(20);
    expect(a.alloc(1)).toBe(-1);
    expect(a.alloc(0)).toBe(-1);
  });

  it('reuses freed single slots and best-fits ranges', () => {
    const a = new SlotRangeAllocator();
    a.reset(0, 100);
    const r8 = a.alloc(8), r3 = a.alloc(3), r5 = a.alloc(5), tail = a.alloc(2);
    a.free(r8, 8); a.free(r5, 5);
    expect(a.alloc(5)).toBe(r5);          // exact fit preferred over the bigger hole
    expect(a.alloc(1)).toBe(r8);          // single slot from a free range
    expect(a.alloc(7)).toBe(r8 + 1);      // the rest of that hole
    a.free(tail, 2);                      // flush with the high-water → retracts
    expect(a.high).toBe(tail);
    expect(r3).toBe(8);
  });

  it('merges fragmented free space lazily when a range has no fit', () => {
    const a = new SlotRangeAllocator();
    a.reset(0, 12);
    const s = [a.alloc(4), a.alloc(4), a.alloc(4)];   // buffer full
    expect(a.alloc(1)).toBe(-1);
    a.free(s[0], 4); a.free(s[1], 4);                 // two adjacent 4-holes, no single 8 range
    expect(a.alloc(8)).toBe(0);                       // found after the merge
  });

  it('parks an owned range and hands back the SAME slots on claim', () => {
    const a = new SlotRangeAllocator();
    a.reset(0, 50);
    const g = a.alloc(10);
    a.free(g, 10, 'groupA');
    expect(a.parkedCount).toBe(1);
    const other = a.alloc(10);            // must NOT take the parked range while the high-water has room
    expect(other).not.toBe(g);
    expect(a.hasOwned('groupA', 10)).toBe(true);
    expect(a.claimOwned('groupA', 10)).toBe(g);
    expect(a.parkedCount).toBe(0);
    expect(a.claimOwned('groupA', 10)).toBe(-1);
  });

  it('a size mismatch on claim releases the parked range as ordinary free space', () => {
    const a = new SlotRangeAllocator();
    a.reset(0, 30);
    const g = a.alloc(6); a.alloc(4);
    a.free(g, 6, 'g');
    expect(a.claimOwned('g', 7)).toBe(-1);
    expect(a.alloc(6)).toBe(g);           // now reusable by anyone
  });

  it('steals a parked range only as a last resort and reports the eviction', () => {
    const a = new SlotRangeAllocator();
    const lost: string[] = [];
    a.onDisown = (o) => lost.push(o);
    a.reset(0, 20);
    const g1 = a.alloc(10), g2 = a.alloc(10);
    a.free(g1, 10, 'one');
    a.free(g2, 10, 'two');
    const n = a.alloc(4);                 // no unowned space, no high-water → best-fit steal
    expect([g1, g2]).toContain(n);
    expect(lost.length).toBe(1);
    expect(a.parkedCount).toBe(1);
    expect(a.alloc(6)).toBe(n + 4);       // the stolen range's remainder became unowned
    const big = a.alloc(10);              // needs the other parked range
    expect(big).toBeGreaterThanOrEqual(0);
    expect(lost.length).toBe(2);
    expect(a.alloc(1)).toBe(-1);
  });

  it('merges parked + unowned neighbours when only their union fits', () => {
    const a = new SlotRangeAllocator();
    const lost: string[] = [];
    a.onDisown = (o) => lost.push(o);
    a.reset(0, 10);
    const x = a.alloc(5), y = a.alloc(5);
    a.free(x, 5, 'x'); a.free(y, 5);
    expect(a.alloc(10)).toBe(0);
    expect(lost).toEqual(['x']);
  });

  it('reset drops every parked range (reporting each) and growth adds room', () => {
    const a = new SlotRangeAllocator();
    const lost: string[] = [];
    a.onDisown = (o) => lost.push(o);
    a.reset(0, 8);
    a.free(a.alloc(4), 4, 'p');
    a.reset(3, 8);
    expect(lost).toEqual(['p']);
    expect(a.parkedCount).toBe(0);
    expect(a.alloc(5)).toBe(3);
    expect(a.alloc(1)).toBe(-1);
    a.setCapacity(16);
    expect(a.alloc(8)).toBe(8);
  });

  it('randomised churn keeps every live range disjoint and parked data reclaimable', () => {
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const cap = 4000;
    const a = new SlotRangeAllocator();
    const live = new Map<string, [number, number]>();      // owner → range
    const parked = new Map<string, [number, number]>();
    a.onDisown = (o) => { parked.delete(o); };
    a.reset(0, cap);
    let id = 0;
    for (let step = 0; step < 6000; step++) {
      const r = rnd();
      if (r < 0.45) {                                       // allocate a new mesh slot or group range
        const n = rnd() < 0.5 ? 1 : 1 + Math.floor(rnd() * 60);
        const s = a.alloc(n);
        if (s >= 0) live.set('o' + id++, [s, n]);
      } else if (r < 0.7 && live.size) {                    // hide: park (groups) or free (meshes)
        const k = [...live.keys()][Math.floor(rnd() * live.size)];
        const [s, n] = live.get(k)!; live.delete(k);
        if (n > 1 && rnd() < 0.7) { a.free(s, n, k); parked.set(k, [s, n]); } else a.free(s, n);
      } else if (parked.size) {                             // show again: reclaim or re-allocate
        const k = [...parked.keys()][Math.floor(rnd() * parked.size)];
        const [ps, n] = parked.get(k)!; parked.delete(k);
        const s = a.claimOwned(k, n);
        if (s >= 0) { expect(s).toBe(ps); live.set(k, [s, n]); }
        else { const s2 = a.alloc(n); if (s2 >= 0) live.set(k, [s2, n]); }
      }
      if (step % 500 === 0) assertDisjoint([...live.values(), ...parked.values()], cap);
    }
    assertDisjoint([...live.values(), ...parked.values()], cap);
    expect(a.high).toBeLessThanOrEqual(cap);
  });
});

describe('SlotRangeAllocator P16 indexed free space', () => {
  const was = STREAM_HITCH.indexedSlotFree;
  afterEach(() => { STREAM_HITCH.indexedSlotFree = was; });
  /** Simulate a streamed world: meshes (1 slot) and array groups (N slots) come and go in tile-sized batches. */
  function drive(indexed: boolean, seed: number): { a: SlotRangeAllocator; live: Map<string, [number, number]> } {
    STREAM_HITCH.indexedSlotFree = indexed;
    let x = seed;
    const rnd = (): number => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
    const cap = 20000;
    const a = new SlotRangeAllocator();
    a.reset(0, cap);
    const live = new Map<string, [number, number]>();
    const tiles: string[][] = [];
    let id = 0;
    for (let t = 0; t < 40; t++) {
      const keys: string[] = [];
      for (let i = 0; i < 120; i++) {
        const n = rnd() < 0.7 ? 1 : 2 + Math.floor(rnd() * 80);
        const s = a.alloc(n);
        if (s < 0) continue;
        const k = 'o' + id++; live.set(k, [s, n]); keys.push(k);
      }
      tiles.push(keys);
      if (tiles.length > 6) for (const k of tiles.shift()!) { const [s, n] = live.get(k)!; live.delete(k); a.free(s, n); }   // the oldest tile leaves
    }
    return { a, live };
  }
  it('both forms hand out disjoint ranges and account for every slot', () => {
    for (const indexed of [false, true]) for (const seed of [1, 7, 99]) {
      const { a, live } = drive(indexed, seed);
      assertDisjoint([...live.values(), ...a.freeRanges()], a.capacity);
      let used = 0; for (const [, n] of live.values()) used += n;
      expect(used + a.freeSlots).toBe(a.high);   // [0, high) = live + free, nothing lost
    }
  });
  it('the indexed free space stays maximal: no two free ranges touch, none ends at the high-water', () => {
    for (const seed of [3, 11]) {
      const { a } = drive(true, seed);
      const f = a.freeRanges();
      for (let i = 1; i < f.length; i++) expect(f[i - 1][0] + f[i - 1][1]).toBeLessThan(f[i][0]);
      if (f.length) expect(f[f.length - 1][0] + f[f.length - 1][1]).toBeLessThan(a.high);
      // the P5 list keeps one entry per freed slot run; the indexed one far fewer
      const legacy = drive(false, seed).a;
      expect(a.freeEntries).toBeLessThanOrEqual(legacy.freeEntries);
    }
  });
  it('switching the form mid-run keeps the free space and stays consistent', () => {
    const { a, live } = drive(false, 5);
    const before = a.freeSlots;
    STREAM_HITCH.indexedSlotFree = true;
    expect(a.freeSlots).toBe(before);
    const s = a.alloc(3);
    if (s >= 0) live.set('x', [s, 3]);
    STREAM_HITCH.indexedSlotFree = false;
    assertDisjoint([...live.values(), ...a.freeRanges()], a.capacity);
  });
  it('a freed neighbour pair merges at once and is reused as one range', () => {
    STREAM_HITCH.indexedSlotFree = true;
    const a = new SlotRangeAllocator();
    a.reset(0, 100);
    const s = [a.alloc(10), a.alloc(10), a.alloc(10), a.alloc(10)];
    a.free(s[1], 10); a.free(s[2], 10);
    expect(a.freeRanges()).toEqual([[10, 20]]);
    expect(a.alloc(20)).toBe(10);
    a.free(s[3], 10);                 // flush with the high-water → retracts
    expect(a.high).toBe(30);
  });
});
