import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorldManager } from './world-manager';
import { StreamManager, type StreamSource } from '../streaming/stream-manager';
import { HLOD_DEFAULTS } from '../streaming/hlod-select';
import { keepUpTiles } from '../streaming/motion-window';

// performance-plan P19 — the speed-aware window through WorldManager with a recording scene (no GPU, no city build):
// the predicted window, the fast window's stand-ins (and the landing option), the cancellation of the full builds a fast
// window drops, and the old-tier dissolve bookkeeping. Motion is fed with explicit times (no wall clock).

type G = { name: string; visible: boolean; children: unknown[]; parent?: unknown };
function scene(): unknown {
    const base: Record<string, unknown> = {
        findExistingCityContainer: () => null, createCityContainer: () => ({ children: [] }),
        getAllMeshes: () => [], shadowsEnabled: false,
        removeFlatColorMeshGroup: (g: G) => { g.parent = null; },
        reattachFlatColorMeshGroup: (g: G) => { g.parent = 'city'; },
        getPlayerFeet3D: () => null,
        getCamera: () => ({ sceneRadius: 30, autoFar: true }),
    };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}
type Tile = { tx: number; tz: number; rank: number; id: number };
type Priv = {
    _params: unknown; _groups: G[]; _cityContainer: unknown;
    _windowTileKeys(p: unknown, cam: unknown, span: number): string[];
    _scanVisibleTiles(...a: unknown[]): Tile[];
    _motion: { update(x: number, z: number, t: number, span: number): boolean; state: string; speed: number; reset(): void };
    _stream: { isFull(k: string): boolean };
    _centreParked: unknown;
    _crossFadeTile(pk: string, prev: unknown[], pp: boolean, nk: string, next: unknown[]): boolean;
    _hlodLanded(groups: unknown[], hlod: 'mid' | 'far'): unknown[];
    _hlodFadeCb(): boolean;
    _disposeTileGroups(groups: unknown[], key?: string): void;
    _streamSrc: { dispose(key: string, h: unknown, preview?: boolean): void };
};
const SPAN = 20;   // radius 10
const pack = (tx: number, tz: number): number => (tx + 8192) * 16384 + (tz + 8192);
const cam = (x: number, z: number) => ({ position: [x, 2, z], target: [x + 5, 0, z], mode: 'perspective', orthoSize: 1, autoFar: true, sceneRadius: 30, getViewProjectionMatrix: () => new Float32Array(16) });

function world(tileRadius = 1) {
    const w = new WorldManager(scene() as never);
    const p = w as unknown as Priv;
    const params = { worldMode: 'tiled', tileDetail: 'full', radius: 10, tileRadius, groundY: 0 };
    p._params = params;
    p._cityContainer = { children: [] };
    p._groups = [];
    w.setStreamOutsideTiles('hlod');
    w.setStreamHlod({ skylineTiles: 3, maxTiles: 40 });
    p._scanVisibleTiles = (...a: unknown[]): Tile[] => {
        const o = a[4] as { radius: number; cap: number; centre: [number, number] } | undefined;
        const R = o?.radius ?? 3, [cx, cz] = o?.centre ?? [0, 0];
        const out: Tile[] = [];
        for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) out.push({ tx: cx + dx, tz: cz + dz, rank: dx * dx + dz * dz, id: pack(cx + dx, cz + dz) });
        out.sort((a1, b1) => a1.rank - b1.rank);
        return out.slice(0, o?.cap ?? 40);
    };
    let t = 0;
    /** Move the eye along +x at `tps` tiles/s for `ms` ending at `xEnd` (tile units), then take the window's keys. */
    const flyTo = (xEnd: number, tps: number, ms = 1500): string[] => {
        const n = Math.ceil(ms / 16);
        for (let i = n; i >= 0; i--) { t += 16; p._motion.update((xEnd - tps * i * 16 / 1000) * SPAN, 0.2 * SPAN, t, SPAN); }
        return p._windowTileKeys(params, cam(xEnd * SPAN, 0.2 * SPAN), SPAN);
    };
    return { w, p, params, flyTo };
}
const full = (keys: string[]) => keys.filter(k => !k.includes('|'));
const S19 = { ...WorldManager.STREAM19 };
afterEach(() => { Object.assign(WorldManager.STREAM19, S19); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('P19 speed-aware window (WorldManager._windowTileKeys)', () => {
    it('still: exactly the P10.D window (the same keys with the P19 switches off)', () => {
        const a = world(), b = world();
        b.w.setStreamMotion(false);
        const ka = a.flyTo(4.3, 0), kb = b.flyTo(4.3, 0);
        expect(ka).toEqual(kb);
        expect(full(ka).sort()).toEqual(['3,-1', '3,0', '3,1', '4,-1', '4,0', '4,1', '5,-1', '5,0', '5,1']);
    });

    it('moving: the window centres on the predicted focus (the row ahead is asked for early), ahead-first order', () => {
        const { flyTo } = world();
        const k = flyTo(4.3, 0.5);   // lead 1 tile (capped) → predicted x 5.3 → centre tile 5
        expect(full(k).sort()).toEqual(['4,-1', '4,0', '4,1', '5,-1', '5,0', '5,1', '6,-1', '6,0', '6,1']);
        expect(k[0]).toBe('5,0');                                 // nearest the predicted point first
        expect(k.indexOf('6,0')).toBeLessThan(k.indexOf('4,0'));  // ahead before behind
        // the switch off: centred on the eye's own tile
        const o = world(); o.w.setStreamMotion({ motionWindow: false });
        expect(full(o.flyTo(4.3, 0.5)).sort()).toEqual(['3,-1', '3,0', '3,1', '4,-1', '4,0', '4,1', '5,-1', '5,0', '5,1']);
    });

    it('1×1 window: the tile under the eye stays full while the predicted tile is asked for too', () => {
        const { flyTo } = world(0);
        expect(full(flyTo(4.3, 0.25)).sort()).toEqual(['4,0', '5,0']);   // (0.25: under the 1×1 window's adaptive keep-up speed)
    });

    it('fast: no new full builds — tiles not already full are HLOD mid stand-ins; full ones stay; slow again = full', () => {
        const { p, flyTo } = world();
        p._stream.isFull = (k: string) => k === '5,0';   // one tile already landed
        const k = flyTo(4.3, 1.2);
        expect(p._motion.state).toBe('fast');
        expect(full(k)).toEqual(['5,0']);
        expect(k).toContain('6,0|h'); expect(k).toContain('4,-1|h');
        expect(new Set(k.map(x => x.split('|')[0])).size).toBe(k.length);   // one key per tile (the window is not scanned twice)
        // stop: the state settles after settleMs under the slow speed → the full window comes back
        let ks = flyTo(4.3, 0, 200);
        expect(p._motion.state).toBe('fast');
        ks = flyTo(4.3, 0, 1500);
        expect(p._motion.state).toBe('slow');
        expect(full(ks).length).toBe(9);
        // the switch off: full tiles at any speed
        const o = world(); o.w.setStreamMotion({ fastWindow: false });
        expect(full(o.flyTo(4.3, 1.2)).length).toBe(9);
    });

    it("fast 'landing': one full tile at the predicted landing point (velocity × landingS), kept out of the outside set", () => {
        const { w, flyTo } = world();
        w.setStreamMotion(undefined, { fast: 'landing' });
        const k = flyTo(4.3, 1.2);   // landing x = 4.3 + 1.2 × 3 = 7.9 → tile 8
        expect(full(k)).toEqual(['8,0']);
        expect(k.filter(x => x.startsWith('8,0')).length).toBe(1);
    });

    it('fast over a parked centre: its stand-in shows and it is not restored mid-fly', () => {
        const { p, flyTo } = world();
        const pk = { groups: [], graph: null };
        p._centreParked = pk;
        const k = flyTo(0.3, 1.2);
        expect(k).toContain('0,0|h');
        expect(p._centreParked).toBe(pk);
    });
});

describe('P19 capped window (a Play run: between the keep-up speed and fastTiles)', () => {
    it('only the corridor builds full — own tile + the tiles along the path — the rest of the window are stand-ins', () => {
        const { w, p, flyTo } = world();
        (p._motion as unknown as { keepUp: number }).keepUp = keepUpTiles(8, 1, 1);   // a slow landing: ~0.24 tiles/s keeps up
        const k = flyTo(4.3, 0.35);
        expect(p._motion.state).toBe('capped');
        // latency 3 s (the default before any landing): reach 0.35 × 3 × 1.25 + 0.75 = 2.06 → x 4.3 .. 6.36
        expect(full(k)).toEqual(['4,0', '5,0', '6,0']);
        expect(k.slice(0, 3)).toEqual(['4,0', '5,0', '6,0']);       // dispatched first, in path order
        expect(k).toContain('5,1|h'); expect(k).toContain('4,-1|h');
        expect(new Set(k.map(x => x.split('|')[0])).size).toBe(k.length);
        expect(w.getStreamMotionStats().corridor).toBe(3);
        // a window tile that is already full stays full
        p._stream.isFull = (key: string) => key === '5,1';
        expect(full(flyTo(4.3, 0.35)).sort()).toEqual(['4,0', '5,0', '5,1', '6,0']);
        // the switch off: the band shows stand-ins like the fast state (the first P19 build)
        const o = world(); o.w.setStreamMotion({ cappedWindow: false });
        (o.p._motion as unknown as { keepUp: number }).keepUp = keepUpTiles(8, 1, 1);
        expect(full(o.flyTo(4.3, 0.35))).toEqual([]);
        // adaptive off: no band, the full window
        const a = world(); a.w.setStreamMotion(undefined, { adaptive: false });
        (a.p._motion as unknown as { keepUp: number }).keepUp = keepUpTiles(8, 1, 1);
        expect(full(a.flyTo(4.3, 0.35)).length).toBe(9);
    });
});

describe('P19 standInFirst: a window tile with nothing on screen takes its stand-in before the full build', () => {
    it('moving: stand-in first (no sync preview); once it shows (or the full build is in flight) the full key; still = full', () => {
        const { p, params, flyTo } = world();
        (p as unknown as { _tileParamsForBuild: unknown })._tileParamsForBuild = params;   // a sync flat preview would be built
        const SM = p._stream as unknown as { shownChunks(): Set<string>; isInflight(k: string): boolean };
        let k = flyTo(4.3, 0.5);
        expect(full(k)).toEqual([]);
        expect(k).toContain('5,0|h');
        SM.shownChunks = () => new Set(['5,0']);   // its stand-in landed
        SM.isInflight = (key: string) => key === '6,0';   // a full build already dispatched keeps its key
        k = flyTo(4.3, 0.5);
        expect(full(k).sort()).toEqual(['5,0', '6,0']);
        // switch off: the full keys at once (the stream builds its flat previews)
        const o = world(); (o.p as unknown as { _tileParamsForBuild: unknown })._tileParamsForBuild = o.params;
        o.w.setStreamMotion({ standInFirst: false });
        expect(full(o.flyTo(4.3, 0.5)).length).toBe(9);
        // still: the full window (a jump / a stop keeps the instant preview)
        const s = world(); (s.p as unknown as { _tileParamsForBuild: unknown })._tileParamsForBuild = s.params;
        expect(full(s.flyTo(4.3, 0)).length).toBe(9);
    });
});

describe('P19 cancellation: the full builds a fast window drops are cancelled at once', () => {
    it('slow keys dispatch full builds; the fast keys cancel every in-flight full build that left and dispatch the stand-ins', () => {
        const { p, flyTo } = world();
        const built: string[] = [], cancelled: string[] = [];
        const src: StreamSource<string[]> = {
            targetChunks: () => [], isCheapKey: (k) => k.includes('|'), maxConcurrentBuilds: 6, maxConcurrentCheap: 999,
            chunkId: (k) => k.split('|')[0],
            build: (k) => { built.push(k); return new Promise<string[]>(() => {}); },   // never lands (a 2-4 s build in flight)
            dispose: () => {}, cancel: (k) => { cancelled.push(k); return true; },
        };
        const sm = new StreamManager(src);
        const slow = flyTo(4.3, 0.5);
        sm.reconcile(slow);
        const inFull = built.filter(k => !k.includes('|'));
        expect(inFull.length).toBe(6);   // the full class's cap
        const fast = flyTo(4.3, 1.2);
        expect(p._motion.state).toBe('fast');
        const before = built.length;
        sm.reconcile(fast);
        expect(cancelled.sort()).toEqual(inFull.sort());   // every in-flight full build left the target → cancelled
        const after = built.slice(before);
        expect(after.some(k => k.endsWith('|h'))).toBe(true);    // the freed slots go to the stand-ins
        expect(after.filter(k => !k.includes('|'))).toEqual([]); // and no full build starts while fast
    });
});

describe('P19 old-tier dissolves (full / flat tiers replaced by HLOD)', () => {
    let nid = 0;
    const meshes = (n: number) => Array.from({ length: n }, () => ({ id: 'm' + (nid++), hlodFade: -1, materialDirty: false, geometry: { vertices: new Float32Array(16), indices: new Uint32Array(0) } }));
    type M = { id: string; hlodFade: number; materialDirty: boolean };
    it('the old full tier dissolves in OLD_TIER_FADE_STEPS steps after the HLOD is whole; array sources stay whole; disposed whole', () => {
        vi.stubGlobal('requestAnimationFrame', () => 0);
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { p } = world();
        const disposed: Array<{ key: string; fades: number[] }> = [];
        const ms = meshes(3);
        const prev: G[] = [{ name: 'World Tile 3_0 World Streets', visible: true, children: [...ms, { sourceId: ms[0].id, children: [] }] }];
        const next: G[] = [{ name: 'World Tile 3_0 HLOD', visible: true, children: meshes(2) }];
        p._streamSrc.dispose = (key: string, h: unknown) => { disposed.push({ key, fades: ((h as G[])[0].children as M[]).filter(m => typeof m.hlodFade === 'number').map(m => m.hlodFade) }); };
        p._hlodLanded(next, 'mid');
        expect(p._crossFadeTile('3,0', prev, false, '3,0|h', next)).toBe(true);
        const levels: number[][] = [];
        let rewrites = 0;
        for (let i = 0; i < 80 && !disposed.length; i++) {
            now += 16; p._hlodFadeCb();
            for (const m of ms) if (m.materialDirty) { rewrites++; m.materialDirty = false; }
            const l = ms.map(m => m.hlodFade);
            if (!levels.length || levels[levels.length - 1].join() !== l.join()) levels.push(l);
            if (now < 1000 + HLOD_DEFAULTS.fadeMs) expect(ms.every(m => m.hlodFade === -1)).toBe(true);   // whole while the HLOD fades in
        }
        expect(disposed.map(d => d.key)).toEqual(['3,0']);
        expect(levels.map(l => l[1])).toEqual([-1, 0.75, 0.5, 0.25, -1]);   // stepped, then whole again for the LRU
        expect(levels.every(l => l[0] === -1)).toBe(true);                    // the array source never fades
        expect(rewrites).toBe(2 * 4);                                           // 3 steps + the reset, for each of the 2 faded meshes
        expect(disposed[0].fades).toEqual([-1, -1, -1]);
    });

    it('switch off: the old tier goes at once when the HLOD is whole (the P17 behaviour); no HLOD on either side = the stream disposes', () => {
        vi.stubGlobal('requestAnimationFrame', () => 0);
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { w, p } = world();
        w.setStreamMotion({ dissolveOldTiers: false });
        const disposed: string[] = [];
        p._streamSrc.dispose = (key: string) => { disposed.push(key); };
        const ms = meshes(2);
        const next: G[] = [{ name: 'World Tile 3_0 HLOD', visible: true, children: meshes(1) }];
        p._hlodLanded(next, 'mid');
        expect(p._crossFadeTile('3,0', [{ name: 'a', visible: true, children: ms }], false, '3,0|h', next)).toBe(true);
        now += HLOD_DEFAULTS.fadeMs + 1; p._hlodFadeCb();
        now += 1; p._hlodFadeCb();
        expect(disposed).toEqual(['3,0']);
        expect(ms.every(m => m.hlodFade === -1)).toBe(true);
        expect(p._crossFadeTile('5,0', [{ name: 'b', visible: true, children: meshes(1) }], false, '5,0|p', [{ name: 'c', visible: true, children: [] }])).toBe(false);
        // on: a full ↔ flat swap (no HLOD) dissolves too
        w.setStreamMotion({ dissolveOldTiers: true });
        expect(p._crossFadeTile('6,0', [{ name: 'd', visible: true, children: meshes(1) }], false, '6,0|p', [{ name: 'e', visible: true, children: [] }])).toBe(true);
    });

    it('a tier retired mid-dissolve comes back whole', () => {
        const { p } = world();
        const ms = meshes(2); ms[0].hlodFade = 0.5; ms[1].hlodFade = 0.25;
        p._disposeTileGroups([{ name: 'World Tile 2_0 Layout', visible: true, children: ms }], '2,0|p');
        expect(ms.map(m => m.hlodFade)).toEqual([-1, -1]);
    });
});
