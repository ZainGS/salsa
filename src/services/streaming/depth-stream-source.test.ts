import { describe, it, expect } from 'vitest';
import { StreamManager } from './stream-manager';
import { DepthStreamSource, octaveLevel, levelKey, parseLevel } from './depth-stream-source';
import type { Focus, StreamBudget } from './stream-manager';

const BUDGET: StreamBudget = { loadRadius: 0, detailRadius: 0, unloadRadius: 0, maxLiveChunks: 64 };
const at = (scale: number): Focus => ({ x: 0, z: 0, scale });

describe('octaveLevel', () => {
    it('maps geometric zoom depth to integer-spaced levels', () => {
        const lvl = octaveLevel(1, 2);
        expect(lvl(1)).toBeCloseTo(0);
        expect(lvl(2)).toBeCloseTo(1);
        expect(lvl(4)).toBeCloseTo(2);
        expect(lvl(8)).toBeCloseTo(3);
        expect(lvl(0.5)).toBeCloseTo(-1);
    });
    it('guards degenerate input (scale/base ≤ 0, factor 1)', () => {
        expect(octaveLevel(1, 2)(0)).toBe(0);
        expect(octaveLevel(0, 2)(4)).toBe(0);
        expect(octaveLevel(1, 1)(4)).toBe(0);
    });
});

describe('DepthStreamSource.targetChunks (scale band, current level first)', () => {
    const src = (over?: Partial<{ band: number; minLevel: number; maxLevel: number }>) =>
        new DepthStreamSource({ levelForScale: octaveLevel(1, 2), buildLevel: () => ({}), disposeLevel: () => {}, ...over });

    it('returns the current level then the fade band around it', () => {
        expect(src().targetChunks(at(4), BUDGET)).toEqual(['L2', 'L1', 'L3']);   // level 2, band 1
    });
    it('clamps at minLevel — no negative structural levels', () => {
        expect(src().targetChunks(at(1), BUDGET)).toEqual(['L0', 'L1']);         // level 0 → no L-1
    });
    it('clamps at maxLevel — the finest level that exists', () => {
        expect(src({ maxLevel: 2 }).targetChunks(at(8), BUDGET)).toEqual(['L2', 'L1']);   // level 3 clamped to 2
    });
    it('band 0 streams only the current level', () => {
        expect(src({ band: 0 }).targetChunks(at(4), BUDGET)).toEqual(['L2']);
    });
    it('band 2 widens the resident set', () => {
        expect(src({ band: 2 }).targetChunks(at(4), BUDGET).sort()).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
    });
});

describe('DepthStreamSource driven by the SAME StreamManager (the generalisation)', () => {
    it('zooming deeper builds finer levels and disposes the coarse ones — no engine change', () => {
        const builds: number[] = [], disposes: number[] = [];
        const src = new DepthStreamSource({
            levelForScale: octaveLevel(1, 2),
            buildLevel: (l) => { builds.push(l); return { l }; },
            disposeLevel: (l) => { disposes.push(l); },
        });
        const mgr = new StreamManager(src);

        mgr.sync(at(1), BUDGET);                       // depth 1 → level 0 → {L0, L1}
        expect(builds.slice().sort()).toEqual([0, 1]);
        expect(mgr.liveCount).toBe(2);

        builds.length = 0;
        mgr.sync(at(8), BUDGET);                       // depth 8 → level 3 → {L2, L3, L4}; L0,L1 fall out
        expect(builds.slice().sort()).toEqual([2, 3, 4]);
        expect(disposes.slice().sort()).toEqual([0, 1]);
        expect(mgr.has('L3')).toBe(true);
        expect(mgr.has('L0')).toBe(false);
        expect(mgr.liveCount).toBe(3);
    });

    it('a small zoom within the same level rebuilds nothing (band overlap kept)', () => {
        const builds: number[] = [], disposes: number[] = [];
        const src = new DepthStreamSource({
            levelForScale: octaveLevel(1, 2),
            buildLevel: (l) => { builds.push(l); return { l }; },
            disposeLevel: (l) => { disposes.push(l); },
        });
        const mgr = new StreamManager(src);
        mgr.sync(at(4), BUDGET);                       // level 2 → {L1,L2,L3}
        builds.length = 0;
        mgr.sync(at(4.3), BUDGET);                     // still level 2 → same set
        expect(builds).toEqual([]);
        expect(disposes).toEqual([]);
    });
});

describe('levelKey / parseLevel round-trip', () => {
    it('encodes and decodes a level, including negatives', () => {
        expect(levelKey(3)).toBe('L3');
        expect(parseLevel('L3')).toBe(3);
        expect(parseLevel(levelKey(-2))).toBe(-2);
    });
});
