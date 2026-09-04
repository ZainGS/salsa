import { describe, it, expect } from 'vitest';
import { SKY_PRESETS, skyPresetNames } from './sky-presets';
import { normalizeSkyParams } from './procedural-sky';

describe('sky presets', () => {
    it('exposes the expected preset set', () => {
        const names = skyPresetNames();
        expect(names).toContain('noon');
        expect(names).toContain('goldenHour');
        expect(names).toContain('sunset');
        expect(names).toContain('night');
    });

    it('every preset has valid, fully-specified sky params', () => {
        for (const name of skyPresetNames()) {
            const p = SKY_PRESETS[name];
            expect(p.label.length).toBeGreaterThan(0);
            // Idempotent through normalize => already complete (no missing fields silently defaulted differently).
            expect(normalizeSkyParams(p.sky)).toEqual(p.sky);
            expect(p.sky.intensity).toBeGreaterThan(0);
            expect(p.sky.sunSizeDeg).toBeGreaterThan(0);
        }
    });

    it('presets carry a plausible sun placement', () => {
        for (const name of skyPresetNames()) {
            const sun = SKY_PRESETS[name].sun;
            if (!sun) continue;
            expect(sun.elevationDeg).toBeGreaterThanOrEqual(-90);
            expect(sun.elevationDeg).toBeLessThanOrEqual(90);
            expect(sun.intensity).toBeGreaterThan(0);
        }
    });

    it('golden hour sits lower + warmer than noon', () => {
        const noon = SKY_PRESETS.noon, gold = SKY_PRESETS.goldenHour;
        expect(gold.sun!.elevationDeg).toBeLessThan(noon.sun!.elevationDeg);
        // warmer = more red-vs-blue in the sun tint
        const warmth = (c: [number, number, number]) => c[0] - c[2];
        expect(warmth(gold.sun!.color)).toBeGreaterThan(warmth(noon.sun!.color));
    });

    it('night is much dimmer than noon overall', () => {
        const lum = (c: [number, number, number]) => c[0] + c[1] + c[2];
        expect(lum(SKY_PRESETS.night.sky.zenith)).toBeLessThan(lum(SKY_PRESETS.noon.sky.zenith));
    });
});
