import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import type { Scene3DManager } from './scene3d-manager';
import { CITY_CLEAN_LOOK, cityScenePreset, GRAPHIC_LOOK } from '../../world/scene-presets';
import { cityStyle } from '../../world/styles';
import { cityMetresPerUnit } from '../../world/types';

// visual-polish #5 (night light spill, soft coloured lamp pools, wet sheen), #7c (the Play player light) and #3 (ink on
// foliage + crease fade): opt-in CityLook fields, the glow-pass dressing and the outline hand-off.

function fakeScene(over: Record<string, unknown> = {}): Scene3DManager {
    const base: Record<string, unknown> = { getPostProcessing3D: () => ({}), findExistingCityContainer: () => null, ...over };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) }) as unknown as Scene3DManager;
}
type Mat = Record<string, unknown> & { diffuse: { r: number; g: number; b: number; a: number }; emissive: { r: number; g: number; b: number; a: number } };
const mesh = (name: string, mat: Partial<Mat> = {}) => ({ name, visible: true, materialDirty: false,
    material: { diffuse: { r: 1, g: 0.88, b: 0.6, a: 1 }, emissive: { r: 0, g: 0, b: 0, a: 1 }, roughness: 1, ...mat } as Mat });
function withCity(over: Record<string, unknown> = {}): { w: WorldManager; container: { worldParams: Record<string, unknown> | null } } {
    const w = new WorldManager(fakeScene(over));
    const container = { worldParams: null as Record<string, unknown> | null };
    const wa = w as unknown as Record<string, unknown>;
    wa._cityContainer = container;
    wa._graph = { params: { radius: 10, weather: 'clear', groundY: 0 }, roads: [], lots: [] };
    return { w, container };
}
const glow = (w: WorldManager, meshes: unknown[], night: number): void => {
    const wa = w as unknown as { _groups: unknown[]; _lastGlowNight: number; _applyGlow: (n: number) => void };
    wa._groups = [{ name: 'test', children: meshes }];
    wa._lastGlowNight = -1; wa._applyGlow(night);
};
const lighting = (c: { worldParams: Record<string, unknown> | null }): Record<string, unknown> => c.worldParams!.lighting as Record<string, unknown>;

describe('look data', () => {
    it('every scene preset carries the night spill + player light (night-gated); Night is damp and Rainy Evening wet', () => {
        expect(CITY_CLEAN_LOOK.nightSpill).toBe(1);
        expect(CITY_CLEAN_LOOK.playerLight).toBe(1);
        expect(cityScenePreset('night')!.look.wetSheen).toBeGreaterThan(0);
        expect(cityScenePreset('rainyEvening')!.look.wetSheen).toBe(1);
        expect(cityScenePreset('noon')!.look.wetSheen).toBeUndefined();
    });
    it('the Graphic look + Phantom Night ink only the canopy silhouette and fade crease ink with distance', () => {
        for (const o of [GRAPHIC_LOOK.outlines!, cityScenePreset('graphic')!.look.outlines!, cityStyle('persona5')!.look!.outlines!]) {
            expect(o.foliage).toBe('silhouette');
            expect(o.creaseFade!.far).toBeGreaterThan(o.creaseFade!.near);
        }
        expect(cityStyle('persona5')!.look!.nightSpill).toBeGreaterThan(0);
    });
});

describe('WorldManager night light fields', () => {
    it('opt-in: absent = off and not persisted (old cities byte-identical); set = persisted; a raw look resets them', () => {
        const { w, container } = withCity();
        w.applyLook({});
        expect(w.nightSpill).toBe(0); expect(w.wetSheen).toBe(0); expect(w.playerLight).toBe(0);
        for (const k of ['nightSpill', 'wetSheen', 'playerLight']) expect(lighting(container)[k]).toBeUndefined();
        w.applyScenePreset('rainyEvening');
        expect(w.nightSpill).toBe(1); expect(w.wetSheen).toBe(1); expect(w.playerLight).toBe(1);
        expect(lighting(container)).toMatchObject({ nightSpill: 1, wetSheen: 1, playerLight: 1 });
        w.setNightSpill(9); expect(w.nightSpill).toBe(1.5);   // clamped
        w.setWetSheen(-1); expect(w.wetSheen).toBe(0);
        expect(w.scenePreset).toBeNull();                     // a hand edit leaves the preset
        w.applyLook({});
        expect(w.nightSpill).toBe(0);
    });
    it('restoreFromSave reads the fields (absent = 0)', () => {
        const load = (lt: Record<string, unknown>): WorldManager => {
            const m = new WorldManager(fakeScene({ findExistingCityContainer: () => ({ worldParams: { params: { radius: 10 }, lighting: { timeOfDay: 0.9, ...lt } } }) }));
            (m as unknown as { _startAsyncFull: () => void })._startAsyncFull = () => {};
            m.restoreFromSave();
            return m;
        };
        const a = load({});
        expect([a.nightSpill, a.wetSheen, a.playerLight]).toEqual([0, 0, 0]);
        const b = load({ nightSpill: 0.8, wetSheen: 0.5, playerLight: 1.2 });
        expect([b.nightSpill, b.wetSheen, b.playerLight]).toEqual([0.8, 0.5, 1.2]);
    });
    it('★ lamp pools: with the spill on they glow in the lamp colour BELOW white (the old 1.9x clipped to a grey-white disc); off = the legacy dress', () => {
        const { w } = withCity();
        w.applyLook({ lampColor: [1, 0.84, 0.6] });
        const pool = mesh('world:lamp-pool');
        glow(w, [pool], 1);
        expect(pool.material.emissive.r).toBeGreaterThan(1.5);   // legacy: diffuse x 1.9 (clips)
        w.applyLook({ lampColor: [1, 0.84, 0.6], nightSpill: 1 });
        glow(w, [pool], 1);
        const e = pool.material.emissive;
        expect(Math.max(e.r, e.g, e.b)).toBeLessThan(1);
        expect(e.r).toBeGreaterThan(e.b + 0.3);                  // warm, not grey
        expect(pool.material.diffuse.r).toBeLessThan(0.1);       // the fill / lamp point light can't wash it out
        w.applyLook({});                                           // spill off again → the built pool colour comes back
        glow(w, [pool], 1);
        expect(pool.material.diffuse).toEqual({ r: 1, g: 0.88, b: 0.6, a: 1 });
        expect(pool.material.emissive.r).toBeGreaterThan(1.5);
    });
    it('spill meshes: hidden by day and with the spill off; at night lit in their own (built) colour', () => {
        const { w } = withCity();
        w.applyLook({ nightSpill: 1 });
        const sp = mesh('world:light-spill-s8', { diffuse: { r: 0.3, g: 0.5, b: 1, a: 1 } });
        glow(w, [sp], 0);
        expect(sp.visible).toBe(false);
        glow(w, [sp], 1);
        expect(sp.visible).toBe(true);
        expect(sp.material.emissive.b).toBeGreaterThan(sp.material.emissive.r);
        expect(Math.max(sp.material.emissive.r, sp.material.emissive.g, sp.material.emissive.b)).toBeLessThan(1);
        glow(w, [sp], 1);                                          // a re-dress keeps the colour (the base was captured once)
        expect(sp.material.emissive.b).toBeGreaterThan(sp.material.emissive.r);
        w.applyLook({});
        glow(w, [sp], 1);
        expect(sp.visible).toBe(false);
    });
    it('wet sheen: legacy 0.35 rain / matte dry when off; glossier rain and a damp night road when on (a dry day stays matte)', () => {
        const { w } = withCity();
        const road = mesh('world:roads');
        const wa = w as unknown as { _params: Record<string, unknown> };
        wa._params = { weather: 'rain', radius: 10 };
        w.applyLook({});
        glow(w, [road], 1); expect(road.material.roughness).toBeCloseTo(0.35);
        w.applyLook({ wetSheen: 1 });
        glow(w, [road], 1); expect(road.material.roughness).toBeLessThan(0.1);
        wa._params = { weather: 'clear', radius: 10 };
        glow(w, [road], 1); expect(road.material.roughness).toBeCloseTo(0.4);
        glow(w, [road], 0); expect(road.material.roughness).toBe(1);
        w.applyLook({});
        glow(w, [road], 1); expect(road.material.roughness).toBe(1);
    });
    it('player light: night-scaled config to the scene in City mode, none by day / with the field off / outside the city', () => {
        const calls: unknown[] = [];
        const { w } = withCity({ setPlayerLight3D: (c: unknown) => calls.push(c) });
        const wa = w as unknown as { _cityMode: boolean; _applyPlayerLight: (n: number) => void };
        wa._cityMode = true;
        w.applyLook({ playerLight: 1 });
        calls.length = 0;
        wa._applyPlayerLight(1);
        expect((calls.pop() as { strength: number }).strength).toBeCloseTo(1);
        wa._applyPlayerLight(0);
        expect(calls.pop()).toBeNull();
        w.applyLook({});
        wa._applyPlayerLight(1);
        expect(calls.pop()).toBeNull();
        w.applyLook({ playerLight: 1 }); wa._cityMode = false;
        wa._applyPlayerLight(1);
        expect(calls.pop()).toBeNull();
    });
    it('outlines: foliage mode + crease fade survive the copy (absent stays absent) and reach the scene in world units', () => {
        const got: unknown[][] = [];
        const { w } = withCity({ enableOutlines: (...a: unknown[]) => got.push(a) });
        w.setCityOutlines({ color: [0, 0, 0, 1], threshold: 2 });
        expect(w.cityOutlines).toEqual({ color: [0, 0, 0, 1], threshold: 2 });
        expect(got.pop()![3]).toEqual({ foliage: 'full', creaseFade: null });
        w.setCityOutlines({ color: [0, 0, 0, 1], threshold: 2, foliage: 'silhouette', creaseFade: { near: 15, far: 70, minAlpha: 0.1 } });
        expect(w.cityOutlines!.foliage).toBe('silhouette');
        const mpu = cityMetresPerUnit(10);
        const ex = got.pop()![3] as { foliage: string; creaseFade: { near: number; far: number; minAlpha: number } };
        expect(ex.foliage).toBe('silhouette');
        expect(ex.creaseFade.near).toBeCloseTo(15 / mpu); expect(ex.creaseFade.far).toBeCloseTo(70 / mpu); expect(ex.creaseFade.minAlpha).toBeCloseTo(0.1);
        w.setCityOutlines({ color: [0, 0, 0, 1], threshold: 2, foliage: 'bogus' as never, creaseFade: { near: 5, far: 2 } });
        expect(w.cityOutlines).toEqual({ color: [0, 0, 0, 1], threshold: 2 });
    });
});
