import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import type { Scene3DManager } from './scene3d-manager';

// visual-polish #9: the SKY DOME look field — which backdrop the city draws, persistence, the cloud-style param sync.

function fakeScene(over: Record<string, unknown> = {}): Scene3DManager {
    const base: Record<string, unknown> = { getPostProcessing3D: () => ({}), findExistingCityContainer: () => null, ...over };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) }) as unknown as Scene3DManager;
}
function withCity(): { w: WorldManager; container: { worldParams: Record<string, unknown> | null }; bg: { mode?: string; sky?: Record<string, unknown> }[] } {
    const bg: { mode?: string; sky?: Record<string, unknown> }[] = [];
    const w = new WorldManager(fakeScene({ setMeshEditBgMode3D: (o: { mode: string }) => bg.push(o) }));
    const container = { worldParams: null as Record<string, unknown> | null };
    const wa = w as unknown as Record<string, unknown>;
    wa._cityContainer = container;
    wa._graph = { params: { radius: 10, weather: "clear", seed: 3, districtPalette: true, roofVariety: true, roofEquipment: 'clustered' }, roads: [], intersections: [], lots: [] };   // (visual-polish #11 fields (+ tail roofEquipment) already on: the presets' look needs no streets rebuild here)
    wa._params = (wa._graph as { params: unknown }).params;
    wa._cityMode = true;
    wa._overrideGlobalLighting = true;
    wa._spawnTraffic = () => {}; wa._despawnTraffic = () => {};   // no movers in a unit test (the param sync is what we pin)
    return { w, container, bg };
}

describe('WorldManager sky dome', () => {
    it('scene presets draw the dome; a look without it draws the legacy gradient', () => {
        const { w, container, bg } = withCity();
        w.applyScenePreset('night');
        expect(w.skyDome).toEqual({});
        const last = bg[bg.length - 1];
        expect(last.mode).toBe('sky');
        expect((last.sky as { moon: number }).moon).toBeGreaterThan(0.9);
        expect((container.worldParams as { lighting: Record<string, unknown> }).lighting.skyDome).toEqual({});
        w.applyLook({});   // e.g. a style pack with no look
        expect(w.skyDome).toBeNull();
        expect(bg[bg.length - 1].mode).toBe('gradient');
        expect('skyDome' in (container.worldParams as { lighting: Record<string, unknown> }).lighting).toBe(false);   // absent = legacy
    });
    it('setSkyDome merges, validates, persists; null turns it off', () => {
        const { w, container } = withCity();
        w.applyScenePreset('golden');
        w.setSkyDome({ stars: 0.3, cityGlowColor: [1, 0.2, 0.1] });
        expect(w.skyDome).toEqual({ stars: 0.3, cityGlowColor: [1, 0.2, 0.1] });
        expect(w.scenePreset).toBeNull();
        w.setSkyDome({ moon: 7 } as never);
        expect(w.skyDome).toEqual({ stars: 0.3, cityGlowColor: [1, 0.2, 0.1], moon: 1 });
        expect((container.worldParams as { lighting: { skyDome: unknown } }).lighting.skyDome).toEqual(w.skyDome);
        w.setSkyDome(null);
        expect(w.skyDome).toBeNull();
    });
    it('the anime / cards cloud style keeps LayoutParams.domeClouds in step (paintedClouds unchanged)', () => {
        const { w } = withCity();
        const params = (w as unknown as { _params: Record<string, unknown> })._params;
        w.applyScenePreset('golden');
        expect(params.domeClouds).toBe(true);
        expect(params.paintedClouds).toBe(true);
        w.setSkyDome({ clouds: 'cards' });
        expect(params.domeClouds).toBe(false);
        w.setSkyDome({ clouds: 'anime' });
        expect(params.domeClouds).toBe(true);
        w.setSkyDome(null);
        expect(params.domeClouds).toBe(false);
    });
    it('reload: a saved dome comes back; an OLD marker (no field) stays on the legacy sky', () => {
        const { w, container } = withCity();
        w.applyScenePreset('night');
        w.setSkyDome({ cityGlow: 0.2 });
        const saved = JSON.parse(JSON.stringify({ ...container.worldParams, params: { radius: 10, worldMode: 'diorama' } }));
        const load = (wp: unknown): WorldManager => {
            const m = new WorldManager(fakeScene({ findExistingCityContainer: () => ({ worldParams: wp }) }));
            (m as unknown as { _startAsyncFull: () => void })._startAsyncFull = () => {};
            expect(m.restoreFromSave()).toBe(true);
            return m;
        };
        expect(load(saved).skyDome).toEqual({ cityGlow: 0.2 });
        const old = JSON.parse(JSON.stringify(saved)); delete old.lighting.skyDome;
        expect(load(old).skyDome).toBeNull();
    });
});
