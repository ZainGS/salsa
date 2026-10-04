import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorldManager } from './world-manager';
import { HLOD_DEFAULTS } from '../streaming/hlod-select';

// performance-plan P17 — HLOD outside tiles through WorldManager with a recording scene (no GPU, no city build): the
// level per tile (mid / far by the eye distance, hysteretic), the skyline scan, the HLOD LRU bounds, the dissolves.

type G = { name: string; visible: boolean; children: unknown[]; parent?: unknown };
function scene(log: string[]): unknown {
    const base: Record<string, unknown> = {
        findExistingCityContainer: () => null, createCityContainer: () => ({ children: [] }),
        getAllMeshes: () => [], shadowsEnabled: false,
        removeFlatColorMeshGroup: (g: G) => { log.push(`-${g.name}`); g.parent = null; },
        reattachFlatColorMeshGroup: (g: G) => { log.push(`+${g.name}`); g.parent = 'city'; },
        getPlayerFeet3D: () => null,
        getCamera: () => ({ sceneRadius: 30, autoFar: true }),
    };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}
type Tile = { tx: number; tz: number; rank: number; id: number };
type Priv = {
    _params: unknown; _groups: G[]; _cityContainer: unknown; _outsideTiles: string;
    _windowTileKeys(p: unknown, cam: unknown, span: number): string[];
    _scanVisibleTiles(...a: unknown[]): Tile[];
    _disposeTileGroups(groups: unknown[], key?: string): void;
    _hlodRetired: { size: number; bytes: number; evicted: number; maxBytes: number; maxCount: number };
    _hlodLanded(groups: unknown[], hlod: 'mid' | 'far'): unknown[];
    _crossFadeTile(pk: string, prev: unknown[], pp: boolean, nk: string, next: unknown[]): boolean;
    _hlodFadeCb(): boolean;
    _hlodFades: unknown[];
    _streamSrc: { dispose(key: string, h: unknown, preview?: boolean): void };
};
const SPAN = 20;   // radius 10
const pack = (tx: number, tz: number): number => (tx + 8192) * 16384 + (tz + 8192);
const cam = (x: number, z: number, y = 2, mode = 'perspective') => ({ position: [x, y, z], target: [x, 0, z + 5], mode, orthoSize: 1, autoFar: true, sceneRadius: 30, getViewProjectionMatrix: () => new Float32Array(16) });

function world() {
    const log: string[] = [];
    const w = new WorldManager(scene(log) as never);
    const p = w as unknown as Priv;
    const params = { worldMode: 'tiled', tileDetail: 'full', radius: 10, tileRadius: 0, groundY: 0 };
    p._params = params;
    p._cityContainer = { children: [] };
    p._groups = [];
    w.setStreamOutsideTiles('hlod');
    // the frustum scan is a projection test (needs a real camera): stand in a ring of every tile within the radius
    const scans: unknown[] = [];
    p._scanVisibleTiles = (...a: unknown[]): Tile[] => {
        scans.push(a[4]);
        const o = a[4] as { radius: number; cap: number; centre: [number, number] } | undefined;
        const R = o?.radius ?? 5, [cx, cz] = o?.centre ?? [0, 0];
        const out: Tile[] = [];
        for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) out.push({ tx: cx + dx, tz: cz + dz, rank: dx * dx + dz * dz, id: pack(cx + dx, cz + dz) });
        out.sort((a1, b1) => a1.rank - b1.rank);
        return out.slice(0, o?.cap ?? 40);
    };
    const keys = (x: number, z: number, y = 2, mode = 'perspective') => p._windowTileKeys(params, cam(x, z, y, mode), SPAN);
    return { w, p, log, keys, scans };
}
const meshes = (n: number, bytes: number) => Array.from({ length: n }, () => ({ hlodFade: -1, materialDirty: false, geometry: { vertices: new Float32Array(bytes / 4), indices: new Uint32Array(0) } }));
const grp = (name: string, n = 2, bytes = 4096): G => ({ name, visible: true, children: meshes(n, bytes) });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('P17 HLOD outside tiles', () => {
    it('outside mode hlod: the window stays full; outside tiles are mid near the eye and far past the mid distance', () => {
        const { keys, scans } = world();
        const k = keys(4 * SPAN + 1, 1);   // eye over tile (4, 0), 1×1 window
        expect(k[0]).toBe('4,0');
        const outside = k.slice(1);
        expect(outside.every(x => x.endsWith('|h') || x.endsWith('|f'))).toBe(true);
        const S = scans[scans.length - 1] as { radius: number; cap: number; centre: [number, number] };
        expect(S).toEqual({ radius: HLOD_DEFAULTS.skylineTiles, cap: HLOD_DEFAULTS.maxTiles, centre: [4, 0] });   // eye-centred skyline scan
        expect(outside.length).toBe(HLOD_DEFAULTS.maxTiles - 1);
        expect(outside).toContain('5,0|h');   // the neighbour: mid
        expect(outside.some(x => x.endsWith('|f'))).toBe(true);
        // the far ones really are the far ones: every mid tile is nearer (in tiles) than every far tile
        const cheb = (x: string) => { const [a, b] = x.split('|')[0].split(',').map(Number); return Math.max(Math.abs(a - 4), Math.abs(b)); };
        const maxMid = Math.max(...outside.filter(x => x.endsWith('|h')).map(cheb)), minFar = Math.min(...outside.filter(x => x.endsWith('|f')).map(cheb));
        expect(maxMid).toBeLessThanOrEqual(HLOD_DEFAULTS.midTiles + 1);
        expect(minFar).toBeGreaterThanOrEqual(HLOD_DEFAULTS.midTiles);
    });

    it('hysteresis: a tile at the mid / far threshold keeps its level while the eye bobs', () => {
        const { w, keys } = world();
        w.setStreamHlod({ midTiles: 3 });
        const at = (x: number) => keys(x, 1).find(k => k.startsWith('8,0|'))!;
        // tile (8,0) nearest face is at x = 150; mid distance 60: the eye at x = 150 - 60 - 4 → mid, then bob ±5
        expect(at(150 - 64)).toBe('8,0|h');
        for (const dx of [-3, 3, 5, -5]) expect(at(150 - 64 - dx)).toBe('8,0|h');   // d 58..70 < 69 = 60 × 1.15
        expect(at(150 - 75)).toBe('8,0|f');
        for (const dx of [-6, 3, 8]) expect(at(150 - 75 + dx)).toBe('8,0|f');            // d 67..81 ≥ 60: held far
        expect(at(150 - 58)).toBe('8,0|h');
    });

    it('settings: skyline distance and the cap drive the scan; ortho keeps the flat outside tiers', () => {
        const { w, keys, scans } = world();
        expect(w.setStreamHlod({ skylineTiles: 4, maxTiles: 30 })).toMatchObject({ skylineTiles: 4, maxTiles: 30 });
        keys(1, 1);
        expect(scans[scans.length - 1]).toMatchObject({ radius: 4, cap: 30 });
        const o = keys(1, 1, 30, 'orthographic');
        expect(o.every(k => !k.endsWith('|h') && !k.endsWith('|f'))).toBe(true);
        expect(o.some(k => k.endsWith('|p'))).toBe(true);
        w.setStreamOutsideTiles('flat');
        expect(keys(1, 1).some(k => k.endsWith('|h') || k.endsWith('|f'))).toBe(false);
    });

    it('the HLOD LRU is bounded by count and bytes (oldest evicted); a re-attach takes the tile back out', () => {
        const C = WorldManager.HLOD_RETIRE_COUNT, B = WorldManager.HLOD_RETIRE_CAP;
        WorldManager.HLOD_RETIRE_COUNT = 5; WorldManager.HLOD_RETIRE_CAP = 10 * 8192;
        try {
            const { p } = world();
            for (let i = 0; i < 12; i++) p._disposeTileGroups([grp(`World Tile ${i}_0 HLOD`)], `${i},0|f`);   // 8 KB each
            expect(p._hlodRetired.size).toBe(5);
            expect(p._hlodRetired.evicted).toBe(7);
            expect(p._hlodRetired.bytes).toBeLessThanOrEqual(10 * 8192);
            (p._hlodRetired as unknown as { setCaps(b: number, c: number): void }).setCaps(3 * 8192, 5);
            expect(p._hlodRetired.size).toBe(3);
            const back = (p as unknown as { _takeRetiredHlod(k: string): unknown[] | null })._takeRetiredHlod('11,0|f');
            expect(back).not.toBeNull();
            expect(p._hlodRetired.size).toBe(2);
            expect((p as unknown as { _takeRetiredHlod(k: string): unknown[] | null })._takeRetiredHlod('0,0|f')).toBeNull();   // long evicted
        } finally { WorldManager.HLOD_RETIRE_COUNT = C; WorldManager.HLOD_RETIRE_CAP = B; }
    });

    it('dissolves: a landed HLOD tile fades in; the held old tier stays whole, then fades out and is disposed', () => {
        vi.stubGlobal('requestAnimationFrame', () => 0);
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { p } = world();
        const disposed: string[] = [];
        p._streamSrc.dispose = (key: string) => { disposed.push(key); };
        const next = [grp('World Tile 3_0 HLOD')], prev = [grp('World Tile 3_0 HLOD')];
        const fade = (g: G[]) => (g[0].children as Array<{ hlodFade: number }>).map(m => m.hlodFade);
        p._hlodLanded(next, 'far');
        expect(fade(next)).toEqual([0, 0]);
        expect(p._crossFadeTile('3,0|h', prev, false, '3,0|f', next)).toBe(true);
        now += HLOD_DEFAULTS.fadeMs / 2; p._hlodFadeCb();
        expect(fade(next)[0]).toBeCloseTo(0.5, 6);
        expect(fade(prev)).toEqual([-1, -1]);   // old tier whole while the new one comes in (no holes)
        now += HLOD_DEFAULTS.fadeMs / 2 + 1; p._hlodFadeCb();
        expect(fade(next)).toEqual([-1, -1]);   // done: drawn whole again (flags2 bit 5 off)
        now += HLOD_DEFAULTS.fadeMs / 4; p._hlodFadeCb();
        expect(fade(prev)[0]).toBeGreaterThan(0.5); expect(fade(prev)[0]).toBeLessThan(1);
        now += HLOD_DEFAULTS.fadeMs; p._hlodFadeCb();
        expect(disposed).toEqual(['3,0|h']);
        expect(p._hlodFadeCb()).toBe(false);   // idle: no more frames requested
        // a full tile replacing an HLOD one: the HLOD fades out at once over the opaque full tile
        const full = [grp('World Tile 4_0 World Streets')], h = [grp('World Tile 4_0 HLOD')];
        expect(p._crossFadeTile('4,0|h', h, false, '4,0', full)).toBe(true);
        now += 1; p._hlodFadeCb();
        expect(fade(h)[0]).toBeGreaterThan(0.9);
        now += HLOD_DEFAULTS.fadeMs; p._hlodFadeCb();
        expect(disposed).toEqual(['3,0|h', '4,0|h']);
        // no HLOD on either side: the stream disposes as before (P19 dissolveOldTiers off; on, it dissolves too:
        // world-stream-motion.test.ts)
        const S = WorldManager.STREAM19.dissolveOldTiers;
        WorldManager.STREAM19.dissolveOldTiers = false;
        try { expect(p._crossFadeTile('5,0', [grp('a')], false, '5,0|p', [grp('b')])).toBe(false); } finally { WorldManager.STREAM19.dissolveOldTiers = S; }
    });

    it('fade off (or headless): tiles land whole and swaps dispose at once', () => {
        const { w, p } = world();
        const g = [grp('World Tile 3_0 HLOD')];
        p._hlodLanded(g, 'mid');
        expect((g[0].children as Array<{ hlodFade: number }>).every(m => m.hlodFade === -1)).toBe(true);   // headless: no rAF
        vi.stubGlobal('requestAnimationFrame', () => 0);
        w.setStreamHlod({ fade: false });
        expect(p._crossFadeTile('3,0|h', g, false, '3,0|f', [grp('x')])).toBe(false);
    });
});

describe('P17 HLOD reassembly priority (the far tiles that drained away in a fly)', () => {
    type RJob = { name: string; layers: unknown[]; prio: number; ctx: { out: unknown[]; remaining: number; resolve(m: unknown[]): void; staged: boolean } };
    type RPriv = { _tileGroupPrio(n: string): number; _reassembleQueue: RJob[]; _slice: unknown; _reassembleOne(d?: number): boolean;
        _reassembleSlice(d: number): boolean; _addTracked(name: string, layers: unknown[], out: unknown[]): void; _startSlice(j: RJob): void };
    const job = (name: string, prio: number): RJob => ({ name, layers: [], prio, ctx: { out: [], remaining: 1, resolve: () => {}, staged: false } });
    it('an HLOD group goes before every full-tile group (switch off = the old decoration rank)', () => {
        const { p } = world();
        const q = p as unknown as RPriv;
        expect(q._tileGroupPrio('World Tile 3_-1 HLOD')).toBe(-1);
        for (const n of ['World Tile 3_-1 Layout', 'World Tile 3_-1 World Streets', 'World Tile 3_-1 World Biome']) expect(q._tileGroupPrio(n)).toBeGreaterThanOrEqual(0);
        WorldManager.HLOD_REASSEMBLY_FIRST = false;
        try { expect(q._tileGroupPrio('World Tile 3_-1 HLOD')).toBe(3); } finally { WorldManager.HLOD_REASSEMBLY_FIRST = true; }
    });
    it('a queued HLOD job assembles one-shot while a full-tile group is mid-slice; the slice resumes after', () => {
        const { p } = world();
        const q = p as unknown as RPriv;
        const calls: string[] = [];
        q._reassembleSlice = () => { calls.push('slice'); return true; };
        q._addTracked = (name: string) => { calls.push('oneshot:' + name); };
        q._startSlice = (j: RJob) => { calls.push('start:' + j.name); };
        q._slice = { job: job('World Tile 1_0 World Furniture', 3) };
        q._reassembleQueue.push(job('World Tile 2_0 World Streets', 1), job('World Tile 9_4 HLOD', -1));
        q._reassembleOne();
        expect(calls).toEqual(['oneshot:World Tile 9_4 HLOD']);   // not the slice, not sliced itself
        q._reassembleOne();
        expect(calls[1]).toBe('slice');                             // no HLOD job left: the slice goes on
        expect(q._reassembleQueue.map(j => j.name)).toEqual(['World Tile 2_0 World Streets']);
    });
});
