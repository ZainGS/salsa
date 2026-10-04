import { describe, it, expect } from 'vitest';
import { CityStreamSource, parseKey, tileKey, hlodKey, isHlodKey, type CityStreamHost } from './city-stream-source';
import type { Focus, StreamBudget } from './stream-manager';
import type { LayoutParams } from '../../world/types';

// A minimal host: targetChunks only reads tileParams(), so build/dispose/callbacks can be no-ops here. Proxy tiers
// only apply to `tileDetail: 'full'` worlds, so default to that (the case where proxy actually changes a tile).
function sourceWith(radius: number, tileRadius: number, tileDetail: 'flat' | 'focus' | 'full' = 'full'): CityStreamSource {
    const host: CityStreamHost = {
        tileParams: () => ({ radius, tileRadius, tileDetail } as unknown as LayoutParams),
        buildTile: () => [],
        buildTileAsync: () => Promise.resolve([]),
        canUseWorkers: () => false,
        disposeTile: () => {},
        onSlice: () => {},
        onSettled: () => {},
    };
    return new CityStreamSource(host);
}

// A full budget (window = detail = everything) reproduces the pre-Phase-3 all-full grid; radii clamp to tileRadius.
const full: StreamBudget = { loadRadius: 9, detailRadius: 9, unloadRadius: 9, maxLiveChunks: 999 };
const budget = (loadRadius: number, detailRadius: number): StreamBudget =>
    ({ loadRadius, detailRadius, unloadRadius: loadRadius, maxLiveChunks: 999 });
const focus = (x: number, z: number): Focus => ({ x, z, scale: 1 });

describe('CityStreamSource.targetChunks (focus-relative window + zoom detail)', () => {
    it('full budget at origin = the old fixed 3×3 grid minus the centre, all FULL, axis before diagonals', () => {
        const keys = sourceWith(10, 1).targetChunks(focus(0, 0), full);
        expect(keys.slice().sort()).toEqual(['-1,-1', '-1,0', '-1,1', '0,-1', '0,1', '1,-1', '1,0', '1,1']);
        expect(keys.some(k => k.includes('|'))).toBe(false);     // none are proxies at full detail
        expect(keys).not.toContain('0,0');                       // centre city is not a streamed tile
        expect(keys.slice(0, 4).sort()).toEqual(['-1,0', '0,-1', '0,1', '1,0']);     // d²=1 axis tiles first
        expect(keys.slice(4).sort()).toEqual(['-1,-1', '-1,1', '1,-1', '1,1']);      // d²=2 diagonals last
    });

    it('a focus one tile over shifts the whole window (span = 2·radius)', () => {
        const keys = sourceWith(10, 1).targetChunks(focus(40, 0), full).slice().sort();
        expect(keys).toEqual(['1,-1', '1,0', '1,1', '2,-1', '2,0', '2,1', '3,-1', '3,0', '3,1']);
        expect(keys).toHaveLength(9);                            // (0,0) outside the window → nothing excluded
    });

    it('sub-tile focus movement does NOT shift the window (tile-quantised → no thrash)', () => {
        const src = sourceWith(10, 1);
        expect(src.targetChunks(focus(4, -3), full).slice().sort())
            .toEqual(src.targetChunks(focus(-4, 3), full).slice().sort());
    });

    it('detailRadius 0 makes every neighbour a PROXY (far, cheap flat tile)', () => {
        const keys = sourceWith(10, 1).targetChunks(focus(0, 0), budget(1, 0));
        expect(keys.every(k => k.endsWith('|p'))).toBe(true);
        expect(keys.map(parseKey).every(k => k.proxy)).toBe(true);
        expect(keys).toHaveLength(8);
    });

    it('mixed tiers: within detailRadius = full, beyond = proxy', () => {
        // cap 2, window radius 2, full detail out to ring 1 → ring 1 (cheb=1) full, ring 2 (cheb=2) proxy.
        const parsed = sourceWith(10, 2).targetChunks(focus(0, 0), budget(2, 1)).map(parseKey);
        const fullTiles = parsed.filter(k => !k.proxy);
        const proxyTiles = parsed.filter(k => k.proxy);
        expect(fullTiles).toHaveLength(8);                       // 3×3 ring minus centre
        expect(proxyTiles).toHaveLength(16);                     // 5×5 minus 3×3
        expect(fullTiles.every(k => Math.max(Math.abs(k.tx), Math.abs(k.tz)) <= 1)).toBe(true);
        expect(proxyTiles.every(k => Math.max(Math.abs(k.tx), Math.abs(k.tz)) === 2)).toBe(true);
    });

    it('zoom shrinks the window: loadRadius below tileRadius keeps only the inner ring', () => {
        expect(sourceWith(10, 3).targetChunks(focus(0, 0), budget(1, 1))).toHaveLength(8);   // radius-1 window despite cap 3
    });

    it('loadRadius is clamped to tileRadius (the world extent)', () => {
        expect(sourceWith(10, 1).targetChunks(focus(0, 0), budget(5, 5))).toHaveLength(8);   // cap 1 → radius 1
    });

    it('non-full worlds NEVER emit proxies (flat/focus neighbours build identically → no key churn)', () => {
        // Same tight budget that made everything a proxy above, but tileDetail 'focus' → all plain keys.
        const keys = sourceWith(10, 1, 'focus').targetChunks(focus(0, 0), budget(1, 0));
        expect(keys.some(k => k.includes('|'))).toBe(false);
        expect(keys).toHaveLength(8);
    });

    it('tileRadius 0 streams nothing (just the centre city)', () => {
        expect(sourceWith(10, 0).targetChunks(focus(0, 0), full)).toEqual([]);
    });
});

describe('CityStreamSource.buildPreview (proxy-first stand-in)', () => {
    // Record what buildTile is asked to build (proxy flag) so we can assert the preview builds a FLAT stand-in.
    function recordingSource(tileDetail: 'flat' | 'focus' | 'full') {
        const calls: Array<{ tx: number; tz: number; proxy: boolean }> = [];
        const host: CityStreamHost = {
            tileParams: () => ({ radius: 10, tileRadius: 1, tileDetail } as unknown as LayoutParams),
            buildTile: (_p, tx, tz, proxy) => { calls.push({ tx, tz, proxy }); return []; },
            buildTileAsync: () => Promise.resolve([]),
            canUseWorkers: () => false,
            disposeTile: () => {}, onSlice: () => {}, onSettled: () => {},
        };
        return { src: new CityStreamSource(host), calls };
    }

    it('builds a FLAT stand-in for a full-3D tile', () => {
        const { src, calls } = recordingSource('full');
        const out = src.buildPreview('1,0');
        expect(out).not.toBeNull();
        expect(calls).toEqual([{ tx: 1, tz: 0, proxy: true }]);   // preview = the cheap flat build
    });

    it('returns null for an already-proxy key (its full build IS the flat map)', () => {
        const { src, calls } = recordingSource('full');
        expect(src.buildPreview('1,0|p')).toBeNull();
        expect(calls).toEqual([]);
    });

    it('returns null for a non-full world (tiles are flat anyway → no double build)', () => {
        expect(recordingSource('focus').src.buildPreview('1,0')).toBeNull();
        expect(recordingSource('flat').src.buildPreview('1,0')).toBeNull();
    });
});

describe('tileKey / parseKey round-trip', () => {
    it('encodes and decodes the proxy + lite tiers in the key', () => {
        expect(tileKey(2, -1, false)).toBe('2,-1');
        expect(tileKey(2, -1, true)).toBe('2,-1|p');
        expect(tileKey(2, -1, false, true)).toBe('2,-1|l');   // lite: full 3D minus detailed buildings (far zoom)
        expect(tileKey(2, -1, true, true)).toBe('2,-1|p');    // proxy wins — a flat tile has no detail to strip
        expect(tileKey(2, -1, true, false, true)).toBe('2,-1|m');   // P10.C1 massing wins over everything
        expect(parseKey('2,-1')).toEqual({ tx: 2, tz: -1, proxy: false, lite: false, massing: false, hlod: null });
        expect(parseKey('2,-1|p')).toEqual({ tx: 2, tz: -1, proxy: true, lite: false, massing: false, hlod: null });
        expect(parseKey('2,-1|l')).toEqual({ tx: 2, tz: -1, proxy: false, lite: true, massing: false, hlod: null });
        expect(parseKey('2,-1|m')).toEqual({ tx: 2, tz: -1, proxy: false, lite: false, massing: true, hlod: null });
        // negative coords survive the split (the tier suffix must not poison Number(tz))
        expect(parseKey(tileKey(-3, -4, true))).toEqual({ tx: -3, tz: -4, proxy: true, lite: false, massing: false, hlod: null });
        // P17 HLOD tiers
        expect(hlodKey(2, -1, 'mid')).toBe('2,-1|h');
        expect(hlodKey(-3, 4, 'far')).toBe('-3,4|f');
        expect(parseKey('2,-1|h')).toEqual({ tx: 2, tz: -1, proxy: false, lite: false, massing: false, hlod: 'mid' });
        expect(parseKey('-3,4|f')).toEqual({ tx: -3, tz: 4, proxy: false, lite: false, massing: false, hlod: 'far' });
        expect(isHlodKey('1,1|h') && isHlodKey('1,1|f') && !isHlodKey('1,1|m') && !isHlodKey('1,1')).toBe(true);
    });
});

describe('CityStreamSource P10 hooks (massing tier, lite preview, preview dispose key, cancel)', () => {
    function rec() {
        const calls = { built: [] as string[], disposed: [] as (string | undefined)[], cancelled: [] as string[] };
        const p = { radius: 10, tileRadius: 1, tileDetail: 'full' } as unknown as LayoutParams;
        const retired = new Set<string>();
        const host: CityStreamHost = {
            tileParams: () => p,
            buildTile: (_p, tx, tz, proxy, massing, hlod) => { calls.built.push(`${tx},${tz}:${proxy ? 'proxy' : 'full'}${massing ? '+massing' : ''}${hlod ? '+hlod-' + hlod : ''}`); return []; },
            buildTileAsync: (_p, tx, tz, key) => { calls.built.push(`${tx},${tz}:async:${key}`); return Promise.resolve([]); },
            canUseWorkers: () => true,
            cancelTileBuild: (key) => { calls.cancelled.push(key); return true; },
            hasRetired: (key) => retired.has(key),
            disposeTile: (_g, key) => { calls.disposed.push(key); },
            onSlice: () => {},
            onSettled: () => {},
        };
        return { src: new CityStreamSource(host), calls, retired };
    }

    it('a massing key builds synchronously through buildTile(massing) and never previews', () => {
        const { src, calls } = rec();
        expect(src.canPreviewKey('2,-1|m')).toBe(false);
        expect(src.buildPreview('2,-1|m')).toBeNull();
        src.build('2,-1|m');
        expect(calls.built).toEqual(['2,-1:proxy+massing']);
    });

    it('P17: HLOD keys are cheap, never preview, and build through buildTile(hlod) (sync: no worker hook)', () => {
        const { src, calls } = rec();
        for (const k of ['2,-1|h', '-4,3|f']) {
            expect(src.canPreviewKey(k)).toBe(false);
            expect(src.buildPreview(k)).toBeNull();
            expect(src.isCheapKey(k)).toBe(true);
            expect(src.chunkId(k)).toBe(k.slice(0, k.indexOf('|')));   // same chunk as its full / flat tiers → the tier-flip hold
        }
        src.build('2,-1|h'); src.build('-4,3|f');
        expect(calls.built).toEqual(['2,-1:proxy+hlod-mid', '-4,3:proxy+hlod-far']);
    });

    it('P17: under the HLOD skyline (cheapBoost) the cheap class may use every worker and a backlog borrows 2 full slots', () => {
        const { src } = rec();
        const host = (src as unknown as { host: CityStreamHost }).host;
        host.workerCount = () => 8; host.reserveCheap = () => true;
        expect(src.maxConcurrentBuilds).toBe(6);
        expect(src.maxConcurrentCheap).toBe(4);
        expect(src.fullCapFor(100)).toBe(6);         // no boost: the plain classes
        host.cheapBoost = () => true;
        expect(src.maxConcurrentCheap).toBe(8);
        expect(src.fullCapFor(16)).toBe(6);          // ≤ 2 × the cheap cap queued: no borrow
        expect(src.fullCapFor(17)).toBe(4);          // a backlog: two fewer full slots
        host.workerCount = () => 2;
        expect(src.fullCapFor(100)).toBe(1);         // never under one full slot... (2 workers: base 2 → max(1, 0))
        CityStreamSource.hlodBoost = false;
        try { expect(src.fullCapFor(100)).toBe(2); expect(src.maxConcurrentCheap).toBe(2); } finally { CityStreamSource.hlodBoost = true; }
    });

    it('P17: HLOD keys go to the cheap worker hook with their level; crossFade delegates (absent hook = false)', async () => {
        const { src } = rec();
        const seen: string[] = [];
        const host = (src as unknown as { host: CityStreamHost }).host;
        host.buildCheapTileAsync = (_p, tx, tz, massing, key, hlod) => { seen.push(`${tx},${tz}:${key}:${massing}:${hlod}`); return Promise.resolve([]); };
        await src.build('3,1|f');
        expect(seen).toEqual(['3,1:3,1|f:false:far']);
        expect(src.crossFade('3,1', [], false, '3,1|h', [])).toBe(false);
        host.crossFadeTile = (pk, _p, pp, nk) => pk === '3,1' && !pp && nk === '3,1|h';
        expect(src.crossFade('3,1', [], false, '3,1|h', [])).toBe(true);
    });

    it('lite tiles get the flat preview (unless a retired build re-attaches) — previewLite A/B', () => {
        const { src, retired } = rec();
        expect(src.canPreviewKey('1,0|l')).toBe(true);
        retired.add('1,0|l');
        expect(src.canPreviewKey('1,0|l')).toBe(false);
        CityStreamSource.previewLite = false;
        try { expect(src.canPreviewKey('3,0|l')).toBe(false); } finally { CityStreamSource.previewLite = true; }
        expect(src.canPreviewKey('3,0|p')).toBe(false);
    });

    it('async builds carry the stream key (cancellable); cancel delegates to the host', () => {
        const { src, calls } = rec();
        void src.build('1,1');
        expect(calls.built).toEqual(['1,1:async:1,1']);
        expect(src.cancel('1,1')).toBe(true);
        expect(calls.cancelled).toEqual(['1,1']);
    });

    it('a dropped PREVIEW retires under its proxy key, never as the full / lite tile', () => {
        const { src, calls } = rec();
        src.dispose('1,0', [], true);
        src.dispose('1,0|l', [], true);
        src.dispose('1,0', [], false);
        expect(calls.disposed).toEqual(['1,0|p', '1,0|p', '1,0']);
        CityStreamSource.previewKeyFix = false;
        try { src.dispose('2,0', [], true); expect(calls.disposed[3]).toBe('2,0'); } finally { CityStreamSource.previewKeyFix = true; }
    });
});
