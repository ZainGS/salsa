import { describe, it, expect } from 'vitest';
import { PlayDustDriver, type DustEnvironment, type DustTickInput } from './play-dust-driver';

const ENV: DustEnvironment = {
    groundColor: () => [0.5, 0.45, 0.4],
    lighting: () => ({ ambient: [0.5, 0.5, 0.5], ambientIntensity: 0.5, sun: [1, 1, 1], sunIntensity: 1, sunElevation: 0.8, fogMode: 'off', fogColor: [0, 0, 0], fogNear: 0, fogFar: 1, fogDensity: 0, distance: 3 }),
    visible: () => true,
};
const base = (o: Partial<DustTickInput> = {}): DustTickInput => ({
    enabled: true, feet: [0, 0, 0], facing: 0, vx: 0, vz: 0, grounded: true, landImpact: 0, landCount: 0, lastLanding: null,
    gaitPhase: 0, moveWeight: 0, runMix: 0, scale: 1, wet: 0, ...o,
});
const fakeRenderer = () => {
    const r = { live: new Set<unknown>(), adds: 0, addTransientParticles(s: unknown) { r.adds++; r.live.add(s); }, removeTransientParticles(s: unknown) { r.live.delete(s); } };
    return r;
};

describe('PlayDustDriver', () => {
    it('no particles (and no memory, no renderer registration) while standing idle', () => {
        const d = new PlayDustDriver(1), r = fakeRenderer();
        for (let i = 0; i < 600; i++) { d.tick(base(), ENV); d.frame(1 / 60, r); }
        expect(d.system.allocated).toBe(false);
        expect(d.system.allocations).toBe(0);
        expect(r.adds).toBe(0); expect(r.live.size).toBe(0);
        // Walking (not running) raises no footstep puffs either.
        let ph = 0;
        for (let i = 0; i < 300; i++) { ph = (ph + 0.03) % 1; d.tick(base({ gaitPhase: ph, moveWeight: 1, runMix: 0.1 }), ENV); }
        expect(d.system.allocated).toBe(false);
    });

    it('one burst per landing, of the landing clip\'s type (Land / Land Deep / Land Soft); splashes when wet', () => {
        const land = (clip: string, impact: number, wet = 0) => {
            const d = new PlayDustDriver(2);
            d.tick(base({ grounded: false }), ENV);
            d.tick(base({ landCount: 1, lastLanding: { clip, impact }, landImpact: impact, wet }), ENV);
            for (let i = 0; i < 30; i++) d.tick(base({ landCount: 1, lastLanding: { clip, impact }, wet }), ENV);   // no re-fire
            return d.emitted;
        };
        expect(land('Land', 1)).toMatchObject({ land: 1, landDeep: 0, landSoft: 0, splash: 0 });
        expect(land('Land Deep', 1.4)).toMatchObject({ landDeep: 1, land: 0 });
        expect(land('Land Soft', 0.5)).toMatchObject({ landSoft: 1, land: 0 });
        expect(land('Land', 1, 1)).toMatchObject({ splash: 1, land: 0 });
    });

    it('a rig without a landing counter falls back to the controller\'s landing impact', () => {
        const d = new PlayDustDriver(3);
        d.tick(base({ landCount: undefined, grounded: false }), ENV);
        d.tick(base({ landCount: undefined, landImpact: 1.6 }), ENV);
        expect(d.emitted.landDeep).toBe(1);
    });

    it('running: a puff per foot strike on dry ground, a splash step when wet; none while sneaking / disabled', () => {
        const run = (o: Partial<DustTickInput>) => {
            const d = new PlayDustDriver(4);
            let ph = 0;
            for (let i = 0; i < 120; i++) { ph = (ph + 0.025) % 1; d.tick(base({ gaitPhase: ph, moveWeight: 1, runMix: 1, ...o }), ENV); }
            return d.emitted;
        };
        expect(run({}).step).toBe(6);                                       // 3 cycles = 6 strikes
        expect(run({ wet: 1 })).toMatchObject({ step: 0, stepSplash: 6 });
        expect(run({ sneaking: true }).step).toBe(0);
        expect(run({ enabled: false }).step).toBe(0);
        expect(run({ grounded: false }).step).toBe(0);
    });

    it('frame(): registered with the renderer only while particles live; detach clears', () => {
        const d = new PlayDustDriver(5), r = fakeRenderer();
        d.tick(base({ grounded: false }), ENV);
        d.tick(base({ landCount: 1, lastLanding: { clip: 'Land', impact: 1 }, landImpact: 1 }), ENV);
        d.frame(1 / 60, r);
        expect(r.live.has(d.system)).toBe(true);
        for (let i = 0; i < 120; i++) d.frame(1 / 60, r);
        expect(r.live.size).toBe(0); expect(d.system.allocated).toBe(false);
        expect(r.adds).toBe(1);                                             // registered once, not per frame
        d.tick(base({ landCount: 2, lastLanding: { clip: 'Land', impact: 1 }, landImpact: 1, grounded: true }), ENV);
        d.frame(1 / 60, r);
        d.detach(r);
        expect(r.live.size).toBe(0); expect(d.system.allocated).toBe(false);
    });

    it('invisible (beyond the fog / sim-LOD edge): nothing emitted', () => {
        const d = new PlayDustDriver(6);
        d.tick(base({ grounded: false }), ENV);
        d.tick(base({ landCount: 1, lastLanding: { clip: 'Land', impact: 1 }, landImpact: 1 }), { ...ENV, visible: () => false });
        expect(d.system.allocated).toBe(false);
    });
});

describe('PlaySettings: landingDust + idleVariety (2026-10-04)', () => {
    it('default on, persisted only when off, restore resets first', async () => {
        const { PlaySettings } = await import('./play-settings');
        const s = new PlaySettings();
        expect(s.landingDust).toBe(true); expect(s.idleVariety).toBe(true);
        expect(s.serialize()).toBeUndefined();
        s.setLandingDust(false); s.setIdleVariety(false);
        expect(s.serialize()).toEqual({ landingDust: false, idleVariety: false });
        const t = new PlaySettings();
        t.restore({ landingDust: false });
        expect(t.landingDust).toBe(false); expect(t.idleVariety).toBe(true);
        t.restore(undefined);
        expect(t.landingDust).toBe(true);
    });
});
