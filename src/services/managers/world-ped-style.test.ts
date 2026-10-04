import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import type { Scene3DManager } from './scene3d-manager';
import { PED_SHADE } from '../../world/mannequin';

// 2026-09-30: LayoutParams.pedestrianStyle — the crowd's shading, applied live (no regen) and persisted with the params.

function fakeScene(): Scene3DManager {
    const base: Record<string, unknown> = { getPostProcessing3D: () => ({}), findExistingCityContainer: () => null };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) }) as unknown as Scene3DManager;
}
type Mat = { diffuse: { r: number; g: number; b: number; a: number }; emissive: { r: number; g: number; b: number; a: number }; renderStyle?: string };
const mesh = (name: string, c = 0.3) => ({ name, visible: true, materialDirty: false, material: { diffuse: { r: c, g: c, b: c, a: 1 }, emissive: { r: 0, g: 0, b: 0, a: 1 } } as Mat });

function city(): { w: WorldManager; container: { worldParams: { params?: Record<string, unknown> } | null }; ped: ReturnType<typeof mesh>; walker: ReturnType<typeof mesh>; road: ReturnType<typeof mesh> } {
    const w = new WorldManager(fakeScene());
    const container = { worldParams: null as { params?: Record<string, unknown> } | null };
    const wa = w as unknown as Record<string, unknown>;
    const params = { radius: 10, weather: 'clear' };
    wa._cityContainer = container; wa._graph = { params, roads: [] }; wa._params = params;
    const ped = mesh('world:ped-navy'), walker = mesh('world:traffic-walker-top'), road = mesh('world:buildings', 0.5);
    wa._groups = [{ children: [ped, walker, road] }];
    return { w, container, ped, walker, road };
}
const glow = (w: WorldManager): void => { (w as unknown as { _lastGlowNight: number })._lastGlowNight = -1; (w as unknown as { _applyGlow: (n: number) => void })._applyGlow(0); };

describe('pedestrianStyle', () => {
    it("defaults to 'flat': the PED_SHADE lift, build colours untouched", () => {
        const { w, ped } = city();
        expect(w.pedestrianStyle).toBe('flat');
        glow(w);
        expect(ped.material.diffuse.r).toBeCloseTo(0.3);
        expect(ped.material.emissive.r).toBeCloseTo(0.3 * PED_SHADE.emissive);
    });
    it("'cel' / 'ink' / 'default' restyle the crowd live (full colour, no lift) and leave the rest of the city alone", () => {
        const { w, ped, walker, road, container } = city();
        w.setPedestrianStyle('cel');
        for (const m of [ped, walker]) {
            expect(m.material.renderStyle).toBe('cel');
            expect(m.material.diffuse.r).toBeCloseTo(0.3 / PED_SHADE.diffuse);
            expect(m.material.emissive.r).toBeLessThan(0.3 * 0.1);
        }
        expect(road.material.renderStyle).toBeUndefined();
        expect(container.worldParams?.params?.pedestrianStyle).toBe('cel');   // persisted with the params
        glow(w);   // a later glow re-dress keeps it (idempotent: the colour is not brightened twice)
        expect(ped.material.diffuse.r).toBeCloseTo(0.3 / PED_SHADE.diffuse);
        expect(ped.material.renderStyle).toBe('cel');
        w.setPedestrianStyle('ink'); expect(walker.material.renderStyle).toBe('ink');
        w.setPedestrianStyle('default'); expect(ped.material.renderStyle).toBe('default');
    });
    it("back to 'flat' restores the build colour + lift and follows the city's render style", () => {
        const { w, ped } = city();
        w.setPedestrianStyle('cel-hd');
        w.setRenderStyle('ink');                       // the city style: the crowd keeps its own
        expect(ped.material.renderStyle).toBe('cel-hd');
        w.setPedestrianStyle('flat');
        expect(ped.material.renderStyle).toBe('ink');  // flat inherits the city style
        expect(ped.material.diffuse.r).toBeCloseTo(0.3);
        expect(ped.material.emissive.r).toBeCloseTo(0.3 * PED_SHADE.emissive);
        expect(w.getStyle().renderStyle).toBe('ink');
    });
    it('updateCity({ pedestrianStyle }) is a selective live pass, not a rebuild', () => {
        const { w, ped } = city();
        w.updateCity({ pedestrianStyle: 'cel' });
        expect(ped.material.renderStyle).toBe('cel');
    });
});
