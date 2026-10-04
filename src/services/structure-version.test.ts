import { describe, it, expect } from 'vitest';
import { StructureVersion } from './structure-version';

describe('StructureVersion (step 2: coalesced structure notifications)', () => {
  it('many bumps between two reads advance the version once', () => {
    const v = new StructureVersion();
    const a = v.read();
    for (let i = 0; i < 10; i++) v.bump();   // a crowd cell + promotions in one frame
    expect(v.read()).toBe(a + 1);
    expect(v.read()).toBe(a + 1);            // no change since → same value
    expect(v.bumps).toBe(10);
  });

  it('every reader sees a change made after its previous read (no cache can miss one)', () => {
    const v = new StructureVersion();
    // two caches reading at different times, bumps interleaved
    let cacheA = v.read(), cacheB = v.read();
    const changedA: boolean[] = [], changedB: boolean[] = [];
    const script = ['bump', 'A', 'bump', 'bump', 'B', 'A', 'B', 'bump', 'B', 'bump', 'A', 'A'];
    let sinceA = false, sinceB = false;
    for (const s of script) {
      if (s === 'bump') { v.bump(); sinceA = sinceB = true; continue; }
      const now = v.read();
      if (s === 'A') { changedA.push(now !== cacheA); expect(now !== cacheA).toBe(sinceA); cacheA = now; sinceA = false; }
      else { changedB.push(now !== cacheB); expect(now !== cacheB).toBe(sinceB); cacheB = now; sinceB = false; }
    }
    expect(changedA).toEqual([true, true, true, false]);
    expect(changedB).toEqual([true, false, true]);
  });

  it('coalesce=false is the old counter', () => {
    const v = new StructureVersion();
    v.coalesce = false;
    const a = v.read();
    v.bump(); v.bump(); v.bump();
    expect(v.read()).toBe(a + 3);
  });
});
