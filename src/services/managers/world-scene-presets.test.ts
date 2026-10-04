import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import type { Scene3DManager } from './scene3d-manager';
import { CITY_SCENE_PRESETS, CITY_CLEAN_LOOK, cityScenePreset } from '../../world/scene-presets';
import { computeDayNight } from '../../world/day-night';

// polish-round-3 T1: scene presets (time of day × weather on one clean PBR look), the clean surface look, persistence.

/** A scene3d stand-in: every method is a no-op unless overridden. */
function fakeScene(over: Record<string, unknown> = {}): Scene3DManager {
    const base: Record<string, unknown> = { getPostProcessing3D: () => ({}), findExistingCityContainer: () => null, ...over };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) }) as unknown as Scene3DManager;
}
type Mat = Record<string, unknown> & { diffuse: { r: number; g: number; b: number; a: number } };
const mesh = (name: string, mat: Partial<Mat> = {}) => ({ name, visible: true, materialDirty: false,
    material: { diffuse: { r: 0.6, g: 0.5, b: 0.4, a: 1 }, emissive: { r: 0, g: 0, b: 0, a: 1 }, ...mat } as Mat });

/** A manager with a (fake) built city: container + graph so the marker stamps. */
function withCity(): { w: WorldManager; container: { worldParams: Record<string, unknown> | null } } {
    const w = new WorldManager(fakeScene());
    const container = { worldParams: null as Record<string, unknown> | null };
    const wa = w as unknown as Record<string, unknown>;
    wa._cityContainer = container;
    wa._graph = { params: { radius: 10, weather: 'clear' }, roads: [] };
    return { w, container };
}

describe('scene preset data', () => {
    it('eight unique TIME × WEATHER presets, all on the PBR look (no render style / outlines / SSAO)', () => {
        // + 'graphic' (visual-polish #8, 2026-10-03): Golden Hour + the Graphic look — deliberately NOT plain PBR.
        expect(CITY_SCENE_PRESETS.map((p) => p.name)).toEqual(['morning', 'noon', 'golden', 'dusk', 'night', 'rainyEvening', 'snowyMorning', 'overcast', 'graphic']);
        const graphic = cityScenePreset('graphic')!;
        expect(graphic.timeOfDay).toBe(cityScenePreset('golden')!.timeOfDay);
        expect(graphic.look.outlines ?? null).not.toBeNull();
        for (const p of CITY_SCENE_PRESETS.filter((q) => q.name !== 'graphic')) {
            expect(p.look.cityStyle).toBeUndefined();
            expect(p.look.outlines ?? null).toBeNull();
            expect(p.look.ssao).toBe(false);
            expect(p.timeOfDay).toBeGreaterThanOrEqual(0);
            expect(p.timeOfDay).toBeLessThan(1);
        }
        expect(cityScenePreset('overcast')!.weather).toBe('overcast');
        expect(cityScenePreset('rainyEvening')!.weather).toBe('rain');
    });
    it('golden hour: a violet zenith over an orange horizon, and the sun is low + warm', () => {
        const g = cityScenePreset('golden')!;
        const dusk = g.look.sky!.dusk!;
        expect(dusk.top![2]).toBeGreaterThan(dusk.top![0]);        // violet-blue top
        expect(dusk.bottom![0]).toBeGreaterThan(dusk.bottom![2]);  // orange horizon
        const L = computeDayNight(g.timeOfDay);
        expect(L.sunDir[1]).toBeGreaterThan(-0.4);                 // low sun → long shadows
        expect(L.sunColor[0]).toBeGreaterThan(L.sunColor[2]);      // warm key light
    });
    it("overcast weather: dimmer, flatter sun than clear at the same time", () => {
        const c = computeDayNight(0.52), o = computeDayNight(0.52, { weather: 'overcast' });
        expect(o.sunIntensity).toBeLessThan(c.sunIntensity * 0.7);
        expect(o.ambientIntensity).toBeGreaterThan(c.ambientIntensity);
    });
});

describe('WorldManager scene presets + clean look', () => {
    it('a fresh manager starts on the clean look', () => {
        const w = new WorldManager(fakeScene());
        expect(w.groundFinish).toBe('clean');
        expect(w.paving).toBe('tiles');
        expect(w.buildingMute).toBeCloseTo(CITY_CLEAN_LOOK.buildingMute!);
        expect(w.paintedClouds).toBe(true);
        expect(w.ssao).toBe(false);
        expect(w.cityShadowSoftness).toBeCloseTo(CITY_CLEAN_LOOK.shadowSoftness!);
    });
    it('applyScenePreset sets time + look, keeps PBR, and stamps everything into the City marker', () => {
        const { w, container } = withCity();
        expect(w.applyScenePreset('nope')).toBe(false);
        expect(w.applyScenePreset('golden')).toBe(true);
        expect(w.scenePreset).toBe('golden');
        expect(w.timeOfDay).toBeCloseTo(0.7);
        expect(w.renderStyle).toBeNull();
        expect(w.skyKeys.dusk.bottom[0]).toBeGreaterThan(0.9);
        const lt = (container.worldParams as { lighting: Record<string, unknown> }).lighting;
        expect(lt).toMatchObject({ scenePreset: 'golden', groundFinish: 'clean', paving: 'tiles', paintedClouds: true });
        expect(lt.timeOfDay).toBeCloseTo(0.7);
        // a hand edit / style-pack look drops the preset tag
        w.setBuildingMute(0.1);
        expect(w.scenePreset).toBeNull();
        w.applyScenePreset('night');
        w.applyLook({});   // e.g. a style pack with no look = the legacy defaults
        expect(w.scenePreset).toBeNull();
        expect(w.groundFinish).toBe('weathered');
        expect(w.paving).toBe('slabs');
        expect(w.buildingMute).toBe(0);
        expect(w.paintedClouds).toBe(false);
        expect(w.cityShadowSoftness).toBeCloseTo(1.3);
    });
    it('persistence: a preset reloads exactly; an OLD saved city (no T1 fields) reloads weathered', () => {
        const { w, container } = withCity();
        w.applyScenePreset('overcast');
        const saved = JSON.parse(JSON.stringify({ ...container.worldParams, params: { radius: 10, worldMode: 'diorama' } }));
        const load = (wp: unknown): WorldManager => {
            const m = new WorldManager(fakeScene({ findExistingCityContainer: () => ({ worldParams: wp }) }));
            (m as unknown as { _startAsyncFull: () => void })._startAsyncFull = () => {};   // no city build in a unit test
            expect(m.restoreFromSave()).toBe(true);
            return m;
        };
        const r = load(saved);
        expect(r.scenePreset).toBe('overcast');
        expect(r.timeOfDay).toBeCloseTo(0.52);
        expect([r.groundFinish, r.paving, r.paintedClouds]).toEqual(['clean', 'tiles', false]);
        expect(r.cityShadowSoftness).toBeCloseTo(2.6);
        expect(r.skyKeys.noon.top).toEqual([0.62, 0.66, 0.72]);
        // a pre-T1 marker: lighting without any of the new fields
        const old = load({ params: { radius: 10 }, lighting: { timeOfDay: 0.5, override: true, sunAzimuth: 0.7, heightFog: 0 } });
        expect([old.groundFinish, old.paving, old.buildingMute, old.paintedClouds, old.scenePreset]).toEqual(['weathered', 'slabs', 0, false, null]);
        expect(old.cityShadowSoftness).toBeCloseTo(1.3);
    });
    it('the glow walk applies clean ground / tiled paving / building mute live, and restores the as-built values', () => {
        const { w } = withCity();
        const road = mesh('world:roads', { groundShade: true, groundMode: 4, groundTile: [0, 0], groundJitter: 1, groundWeather: 1 });
        const walk = mesh('world:sidewalks', { groundShade: true, groundMode: 5, groundTile: [1.2, 1.2], groundJitter: 1, groundWeather: 1, groundGrout: { r: 0.5, g: 0.5, b: 0.5, a: 0.012 } });
        const wall = mesh('world:detail-wall', { diffuse: { r: 0.8, g: 0.3, b: 0.2, a: 1 } });
        const sign = mesh('world:detail-sign', { diffuse: { r: 0.9, g: 0.2, b: 0.1, a: 1 } });
        const paint = mesh('world:roadpaint', { groundShade: true, groundMode: 20, groundTile: [1, 0], groundJitter: 1, groundWeather: 0, diffuse: { r: 0.9, g: 0.9, b: 0.86, a: 1 } });
        const wear = mesh('world:roads-wear', { groundShade: true, groundMode: 4, groundTile: [0, 0], groundJitter: 1, groundWeather: 1 });
        (w as unknown as { _groups: unknown[] })._groups = [{ children: [road, walk, wall, sign, paint, wear] }];
        const glow = () => { (w as unknown as { _lastGlowNight: number })._lastGlowNight = -1; (w as unknown as { _applyGlow: (n: number) => void })._applyGlow(0); };
        glow();
        expect(road.material.groundTile).toEqual([1, 1]);       // crack-free asphalt + B1 drift / repair patches
        expect(road.material.groundWeather).toBe(0);
        const rd = road.material.diffuse;
        expect(rd.r).toBeGreaterThan(0.25);                      // B1: a lighter grey…
        expect(rd.r).toBeGreaterThan(rd.b);                      // …and warm, not navy
        expect(wear.material.diffuse.r).toBeLessThan(rd.r);      // tyre-wear lane: the same grey a shade darker
        expect(wear.material.groundTile).toEqual([1, 1]);
        expect(walk.material.groundMode).toBe(21);               // B3: paver tiles
        expect(walk.material.groundTile).toEqual([0.5, 0.5]);    // ~50 cm tiles
        expect((walk.material.groundGrout as { a: number }).a).toBeLessThan(0.006);   // thin joints
        expect(walk.material.diffuse.r - walk.material.diffuse.b).toBeGreaterThan(0.08);   // warm tile
        expect(paint.material.groundShade).toBe(true);           // B2: worn matte paint…
        expect(paint.material.diffuse.r).toBeLessThan(0.85);     // …off-white
        expect(paint.material.emissive).toEqual({ r: 0, g: 0, b: 0, a: 1 });   // never a light
        const d = wall.material.diffuse;
        expect(d.r - d.b).toBeLessThan(0.6 - 0.05);              // desaturated
        expect(sign.material.diffuse).toEqual({ r: 0.9, g: 0.2, b: 0.1, a: 1 });   // signs keep their colour
        w.setGroundFinish('weathered'); w.setPaving('slabs'); w.setBuildingMute(0);
        glow();
        expect(road.material.groundTile).toEqual([0, 0]);
        expect(road.material.groundWeather).toBe(1);
        expect(road.material.diffuse).toEqual({ r: 0.6, g: 0.5, b: 0.4, a: 1 });
        expect(wear.material.diffuse).toEqual(road.material.diffuse);   // as built the wear strips match the road exactly
        expect(paint.material.groundShade).toBe(false);          // the old FLAT paint, exactly
        expect(paint.material.diffuse).toEqual({ r: 0.9, g: 0.9, b: 0.86, a: 1 });
        expect(walk.material.groundTile).toEqual([1.2, 1.2]);
        expect(walk.material.groundJitter).toBe(1);
        expect(wall.material.diffuse).toEqual({ r: 0.8, g: 0.3, b: 0.2, a: 1 });
    });
});

describe('visual-polish 2026-10-03 resume', () => {
    it('a look WITH outlines keeps them on (the edgeWear line had split the if / else and disabled the ink)', () => {
        const calls: string[] = [];
        const w = new WorldManager(fakeScene({ enableOutlines: () => { calls.push('on'); }, disableOutlines: () => { calls.push('off'); } }));
        (w as unknown as Record<string, unknown>)._graph = { params: { radius: 10, weather: 'clear' }, roads: [] };
        w.applyScenePreset('graphic');
        expect(calls[calls.length - 1]).toBe('on');
        expect(w.graphicLook).toBe(true);
        w.setGraphicLook(false);
        expect(calls[calls.length - 1]).toBe('off');
        expect(w.graphicLook).toBe(false);
    });
    it('windowGlow: opt-in look field, persisted only when set, absent on load = 1', () => {
        const { w, container } = withCity();
        w.applyScenePreset('night');
        expect(w.windowGlow).toBe(1);
        expect((container.worldParams!.lighting as Record<string, unknown>).windowGlow).toBeUndefined();   // old docs byte-identical
        w.applyLook({ windowGlow: 0.7 });
        expect(w.windowGlow).toBeCloseTo(0.7);
        expect((container.worldParams!.lighting as Record<string, unknown>).windowGlow).toBeCloseTo(0.7);
        const win = mesh('world:detail-wall', { patternMode: 'windows' });
        (w as unknown as { _groups: unknown[] })._groups = [{ children: [win] }];
        (w as unknown as { _lastGlowNight: number })._lastGlowNight = -1; (w as unknown as { _applyGlow: (n: number) => void })._applyGlow(1);
        expect(win.material.windowGlow).toBeCloseTo(0.7);
        w.applyLook({});
        (w as unknown as { _lastGlowNight: number })._lastGlowNight = -1; (w as unknown as { _applyGlow: (n: number) => void })._applyGlow(1);
        expect(win.material.windowGlow).toBeUndefined();
    });
    it('ad screens: an old saved city (no adScreens in its params) restores with the legacy screens; a new one keeps the ad loop', () => {
        const load = (params: Record<string, unknown>): Record<string, unknown> => {
            let got: Record<string, unknown> = {};
            const m = new WorldManager(fakeScene({ findExistingCityContainer: () => ({ worldParams: { params, lighting: { timeOfDay: 0.5 } } }) }));
            (m as unknown as { _startAsyncFull: (p: Record<string, unknown>) => void })._startAsyncFull = (p) => { got = p; };
            m.restoreFromSave();
            return got;
        };
        expect(load({ radius: 10 }).adScreens).toBe(false);
        expect(load({ radius: 10, adScreens: true }).adScreens).toBe(true);
    });
});
