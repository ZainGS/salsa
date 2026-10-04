import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';

// HARD FOG EDGE (2026-10-01): while sm.setFogHardEdge3D(true) is on, the city must leave the user's fog alone —
// no zoom-out rescale, no time-of-day replace, and saves / city exit keep the live (user) fog.

type Fog = { mode: string; color: number[]; near: number; far: number; density: number };
function scene(live: Record<string, unknown>, renderer3D: { fogHardEdge: boolean }, writes: Fog[]): unknown {
    const base: Record<string, unknown> = {
        renderer3D,
        getGlobalScene3DSettings: () => JSON.parse(JSON.stringify(live)),
        getPostProcessing3D: () => live.postProcess,
        getFog3D: () => ({ ...(live.fog as Fog) }),
        setFog3D: (f: Partial<Fog>) => { live.fog = { ...(live.fog as Fog), ...f }; writes.push(live.fog as Fog); },
        findExistingCityContainer: () => null, createCityContainer: () => ({ children: [] }),
        getAllMeshes: () => [], shadowsEnabled: false,
    };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}
type Priv = { _cityMode: boolean; _fogColor: number[] | null; _zoomOutFog(d: number): void; _snapshotGlobalLighting(): void };

const USER_FOG: Fog = { mode: 'linear', color: [1, 0, 1], near: 3, far: 3.05, density: 0.1 };

describe('hard fog edge', () => {
    it('zoom-out fog rescales the fog normally, but not while the hard edge is on', () => {
        for (const locked of [false, true]) {
            const live: Record<string, unknown> = { fog: { ...USER_FOG } };
            const writes: Fog[] = [];
            const w = new WorldManager(scene(live, { fogHardEdge: locked }, writes) as never);
            const p = w as unknown as Priv;
            p._fogColor = [1, 0, 1];
            p._zoomOutFog(50);   // far past 0.6 × far → the city would scale the fog out
            if (locked) { expect(writes).toHaveLength(0); expect(live.fog).toEqual(USER_FOG); }
            else expect(writes.length).toBeGreaterThan(0);
        }
    });

    it('a save in City mode keeps the user fog (not the pre-city snapshot) while the hard edge is on', () => {
        const r = { fogHardEdge: false };
        const live: Record<string, unknown> = { fog: { mode: 'off', color: [0.8, 0.8, 0.8], near: 5, far: 20, density: 0.1 }, lighting: {}, shadows: {} };
        const w = new WorldManager(scene(live, r, []) as never);
        const p = w as unknown as Priv;
        p._snapshotGlobalLighting(); p._cityMode = true;
        live.fog = { ...USER_FOG };
        expect((w.overlayPreCityState(JSON.parse(JSON.stringify(live))) as { fog: Fog }).fog.mode).toBe('off');   // unlocked: base look
        r.fogHardEdge = true;
        expect((w.overlayPreCityState(JSON.parse(JSON.stringify(live))) as { fog: Fog }).fog).toEqual(USER_FOG);
    });
});
