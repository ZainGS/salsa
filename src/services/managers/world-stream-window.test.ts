import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';

// performance-plan P10.D — the streamed tiled world's ACTIVE window, driven through WorldManager with a recording
// scene (no GPU, no city build): the Tile radius defines the full set, it centres on the tile under the camera EYE
// (the player in Play), with hysteresis at tile borders, and the original centre city despawns / returns like a tile.

type G = { name: string; visible: boolean; children: unknown[]; parent?: unknown };
function scene(log: string[], player: { pos: [number, number, number] | null }): unknown {
    const base: Record<string, unknown> = {
        findExistingCityContainer: () => null, createCityContainer: () => ({ children: [] }),
        getAllMeshes: () => [], shadowsEnabled: false,
        removeFlatColorMeshGroup: (g: G) => { log.push(`-${g.name}`); g.parent = null; },
        reattachFlatColorMeshGroup: (g: G) => { log.push(`+${g.name}`); g.parent = 'city'; },
        getPlayerFeet3D: () => player.pos,
    };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}
type Priv = {
    _params: unknown; _groups: G[]; _cityContainer: unknown; _outsideTiles: string;
    _windowTileKeys(p: unknown, cam: unknown, span: number): string[];
    _centreResident(): boolean; _focusTile: [number, number] | null;
};
const SPAN = 20;   // radius 10
const cam = (x: number, z: number, y = 30) => ({ position: [x, y, z], target: [0, 0, 0], mode: 'perspective', orthoSize: 1, getViewProjectionMatrix: () => new Float32Array(16) });

function world(tileRadius: number) {
    const log: string[] = [];
    const player = { pos: null as [number, number, number] | null };
    const w = new WorldManager(scene(log, player) as never);
    const p = w as unknown as Priv;
    const params = { worldMode: 'tiled', tileDetail: 'full', radius: 10, tileRadius, groundY: 0 };
    p._params = params;
    p._cityContainer = { children: [] };
    p._outsideTiles = 'none';   // only the active window (no frustum scan in this headless test)
    p._groups = [
        { name: 'World Layout', visible: true, children: [] }, { name: 'World Streets', visible: true, children: [] },
        { name: 'World Apron', visible: true, children: [] }, { name: 'World Sky', visible: true, children: [] },
    ];
    const keys = (x: number, z: number) => p._windowTileKeys(params, cam(x, z), SPAN);
    return { w, p, log, player, keys, params };
}

describe('P10.D active window', () => {
    it('1×1 at an oblique overview: exactly ONE full tile — the one under the eye — and the centre despawns', () => {
        const { p, log, keys } = world(0);
        // the user's state: eye over tile (-1, 2), looking back at the origin
        expect(keys(-22, 38)).toEqual(['-1,2']);
        expect(p._centreResident()).toBe(false);
        // the centre's own groups left the scene; the world-extent backdrop stayed
        expect(log).toEqual(['-World Layout', '-World Streets']);
        expect(p._groups.map(g => g.name)).toEqual(['World Apron', 'World Sky']);
    });

    it('3×3 → the 9 tiles around the eye; over the centre, the centre city IS the (0,0) full tile', () => {
        const { p, keys } = world(1);
        const k = keys(4, -3);   // eye over the centre
        expect(k.length).toBe(8);   // + the resident centre = 9 full
        expect(k).not.toContain('0,0');
        expect(new Set(k)).toEqual(new Set(['-1,-1', '0,-1', '1,-1', '-1,0', '1,0', '-1,1', '0,1', '1,1']));
        expect(p._centreResident()).toBe(true);
        expect(keys(4 + 3 * SPAN, -3)).toEqual(expect.arrayContaining(['2,0', '3,0', '4,0', '3,-1', '3,1']));
        expect(p._centreResident()).toBe(false);
    });

    it('the slider drives the window live: 1×1 → 3×3 → 5×5 without a regen', () => {
        const { params, keys } = world(0);
        expect(keys(60, 0)).toEqual(['3,0']);
        params.tileRadius = 1; expect(keys(60, 0).length).toBe(9);
        params.tileRadius = 2; expect(keys(60, 0).length).toBe(25);
    });

    it('the centre comes back (re-attached, not rebuilt) when the eye returns', () => {
        const { p, log, keys } = world(0);
        keys(3 * SPAN, 0);
        expect(p._centreResident()).toBe(false);
        log.length = 0;
        expect(keys(1, 1)).toEqual([]);   // over the centre again: its own groups ARE the full tile
        expect(p._centreResident()).toBe(true);
        expect(log).toEqual(['+World Layout', '+World Streets']);
        expect(p._groups.filter(g => g.parent === 'city').every(g => g.visible)).toBe(true);
    });

    it('hysteresis: standing on a tile border never thrashes; the switch needs ~12% into the next tile', () => {
        const { keys } = world(0);
        expect(keys(2 * SPAN, 0)).toEqual(['2,0']);
        for (const x of [2.5 * SPAN - 0.1, 2.5 * SPAN + 0.5, 2.5 * SPAN + 2, 2.5 * SPAN - 1]) expect(keys(x, 0)).toEqual(['2,0']);
        expect(keys(2.65 * SPAN, 0)).toEqual(['3,0']);
        expect(keys(2.45 * SPAN, 0)).toEqual(['3,0']);   // back over the border by a hair — still tile 3
    });

    it('Play: the window centres on the PLAYER, not the camera', () => {
        const { player, keys } = world(0);
        player.pos = [5 * SPAN + 3, 0, -2 * SPAN];
        expect(keys(-60, 60)).toEqual(['5,-2']);
        player.pos = null;
        expect(keys(-60, 60)).toEqual(['-3,3']);
    });

    it('A/B: eyeWindow off → the legacy path (the window helpers are not used)', () => {
        const { w, params } = world(0);
        const S = w.setP10Switches({ eyeWindow: false });
        try {
            expect(S.eyeWindow).toBe(false);
            expect((w as unknown as { _eyeWindowOn(p: unknown): boolean })._eyeWindowOn(params)).toBe(false);
        } finally { w.setP10Switches({ eyeWindow: true }); }
    });

    it('stats report the ACTUAL tiers (full used to be the constant budget 9)', () => {
        const { w, keys } = world(0);
        keys(-22, 38);
        const s = w.getStreamStats();
        expect(s.window).toBe('1×1');
        expect(s.centre).toBe('parked');
        expect(s.full).toBe(0);   // nothing has been reconciled into the stream in this headless test
        expect(s.focusTile).toEqual([-1, 2]);
    });
});
