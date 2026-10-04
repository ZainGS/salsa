import { describe, it, expect } from 'vitest';
import { splitPassStats, type PassFrameCounters } from './pass-stats';

const base: PassFrameCounters = {
  passMainDraws: 100, passMainTris: 1_000_000, passFarShadowDraws: 0, passFarShadowTris: 0,
  passCascadeDraws: 40, passCascadeTris: 300_000, passOutlineDraws: 90, passOutlineTris: 800_000,
  passPrepassDraws: 90, passPrepassTris: 800_000, passPlanarDraws: 0, passPlanarTris: 0, passOtherDraws: 2, passOtherTris: 12,
  passFarShadowLastDraws: 300, passFarShadowLastTris: 2_000_000, passCascadeLastDraws: 40, passCascadeLastTris: 300_000,
  skinnedTris: 30_000, skinnedDrawn: 7, trisVisible: 1_000_000,
};

describe('splitPassStats', () => {
  it('main = colour pass + characters; shadow = last refresh of each map; other = the prepasses', () => {
    const { tris, draws } = splitPassStats(base);
    expect(tris.main).toBe(1_030_000);
    expect(tris.shadow).toBe(2_300_000);
    expect(tris.shadowThisFrame).toBe(300_000);   // the far map was cached this frame
    expect(tris.other).toBe(1_600_012);
    expect(tris.total).toBe(tris.main + tris.shadow + tris.other);
    expect(draws.main).toBe(107);
    expect(draws.shadow).toBe(340);
    expect(tris.passes.farShadow).toBe(2_000_000);
    expect(tris.passes.skinned).toBe(30_000);
  });
  it('an empty frame is all zeros', () => {
    const z = Object.fromEntries(Object.keys(base).map((k) => [k, 0])) as unknown as PassFrameCounters;
    const { tris } = splitPassStats(z);
    expect(tris.total).toBe(0); expect(tris.main).toBe(0);
  });
});
