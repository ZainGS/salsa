import { describe, it, expect } from 'vitest';
import { IncrementalDrawRank, GeomKeyCodes, fullDrawRank } from './draw-order-rank';

interface M { id: string; geometryKey: string; pipe: number }
const pipeOf = (m: M) => m.pipe;
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
let nid = 0;
const KEYS = Array.from({ length: 300 }, (_, i) => `geo:${(i * 7919) % 1000}:${String.fromCharCode(65 + (i % 26))}`);
const mk = (r: () => number): M => ({ id: 'm' + (nid++), geometryKey: KEYS[Math.floor(r() * KEYS.length)], pipe: Math.floor(r() * 4) });

function expectSameRanks(rank: IncrementalDrawRank<M>, meshes: M[]): void {
  const ref = fullDrawRank(meshes, pipeOf);
  for (const m of meshes) expect(rank.get(m.id)).toBe(ref.get(m.id));
}

describe('GeomKeyCodes', () => {
  it('codes keep the string order through single inserts, gap exhaustion and batches', () => {
    const c = new GeomKeyCodes();
    const r = rng(2);
    const keys: string[] = [];
    // many keys between the same two neighbours → forces renumbering
    for (let i = 0; i < 80; i++) { const k = 'a' + 'm'.repeat(i) + 'z'; keys.push(k); c.addAll([k]); }
    for (let i = 0; i < 500; i++) { const k = 'k' + Math.floor(r() * 1e6).toString(36); keys.push(k); }
    c.addAll(keys.slice(80));                 // a big batch
    const sorted = Array.from(new Set(keys)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) expect(c.get(sorted[i - 1])!).toBeLessThan(c.get(sorted[i])!);
    expect(c.epoch).toBeGreaterThan(0);
  });
});

describe('IncrementalDrawRank (step 2 / hitch item: incremental draw order)', () => {
  it('first update equals the full stable string sort', () => {
    const r = rng(1);
    const meshes = Array.from({ length: 3000 }, () => mk(r));
    const rank = new IncrementalDrawRank<M>();
    rank.update(meshes, pipeOf);
    expectSameRanks(rank, meshes);
  });

  it('adds, removals, key / pipe changes and reorders match the full sort; small changes merge', () => {
    const r = rng(42);
    let meshes = Array.from({ length: 4000 }, () => mk(r));
    const rank = new IncrementalDrawRank<M>();
    rank.update(meshes, pipeOf);
    for (let step = 0; step < 40; step++) {
      const op = r();
      if (op < 0.35) {                                   // a crowd cell: insert a batch somewhere
        const at = Math.floor(r() * meshes.length);
        const batch = Array.from({ length: 1 + Math.floor(r() * 60) }, () => mk(r));
        meshes = [...meshes.slice(0, at), ...batch, ...meshes.slice(at)];
      } else if (op < 0.6) {                             // evict a few
        meshes = meshes.filter(() => r() > 0.01);
      } else if (op < 0.75) {                            // new geometry key on a few (a re-dress / edit)
        for (let i = 0; i < 5; i++) { const m = meshes[Math.floor(r() * meshes.length)]; m.geometryKey = 'new:' + Math.floor(r() * 1e9); }
      } else if (op < 0.85) {                            // pipeline class change
        for (let i = 0; i < 5; i++) { const m = meshes[Math.floor(r() * meshes.length)]; m.pipe = (m.pipe + 1) % 4; }
      } else if (op < 0.92) {                            // swap two meshes in the input order (a reparent upstream)
        const i = Math.floor(r() * meshes.length), j = Math.floor(r() * meshes.length);
        [meshes[i], meshes[j]] = [meshes[j], meshes[i]];
      } else {                                           // evict via delete() then re-add with the same id
        const m = meshes[Math.floor(r() * meshes.length)];
        rank.delete(m.id);
      }
      rank.update(meshes, pipeOf);
      expectSameRanks(rank, meshes);
    }
    expect(rank.stats.merged).toBeGreaterThan(rank.stats.fullSorts);
  });

  it('duplicate ids reproduce the old Map (last index wins) and recover after', () => {
    const r = rng(3);
    const meshes = Array.from({ length: 200 }, () => mk(r));
    const dup = { ...meshes[10] };
    const withDup = [...meshes, dup];
    const rank = new IncrementalDrawRank<M>();
    rank.update(withDup, pipeOf);
    const ref = fullDrawRank(withDup, pipeOf);
    for (const m of withDup) expect(rank.get(m.id)).toBe(ref.get(m.id));
    expect(rank.stats.legacy).toBe(1);
    rank.update(meshes, pipeOf);
    expectSameRanks(rank, meshes);
  });

  it('unknown ids (added since the last update) are undefined → ranked at the tail by the caller', () => {
    const rank = new IncrementalDrawRank<M>();
    rank.update([{ id: 'a', geometryKey: 'x', pipe: 0 }], pipeOf);
    expect(rank.get('b')).toBeUndefined();
  });

  it('incremental=false (A/B) gives the same ranks', () => {
    const r = rng(8);
    const meshes = Array.from({ length: 1500 }, () => mk(r));
    const a = new IncrementalDrawRank<M>(), b = new IncrementalDrawRank<M>();
    b.incremental = false;
    a.update(meshes, pipeOf); b.update(meshes, pipeOf);
    meshes.splice(700, 0, mk(r), mk(r), mk(r));
    a.update(meshes, pipeOf); b.update(meshes, pipeOf);
    for (const m of meshes) expect(a.get(m.id)).toBe(b.get(m.id));
    expect(b.stats.merged).toBe(0);
  });

  it('the key table is pruned when evicted keys pile up, without changing ranks', () => {
    const rank = new IncrementalDrawRank<M>();
    let meshes: M[] = [];
    for (let wave = 0; wave < 12; wave++) {
      meshes = Array.from({ length: 500 }, (_, i) => ({ id: `w${wave}-${i}`, geometryKey: `tile${wave}:${i}`, pipe: i % 2 }));
      rank.update(meshes, pipeOf);
      expectSameRanks(rank, meshes);
    }
    expect(rank.codes.size).toBeLessThan(2 * 500 + 4096 + 500);
  });
});
