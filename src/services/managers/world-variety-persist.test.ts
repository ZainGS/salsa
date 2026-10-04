import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import { MOVER_SHADOW_DEFAULTS } from './world-mover-shadows';

// visual-polish #11 / #16: a city saved before the district palette, roof variety and traffic density existed reloads
// with its old look (the marker stores the full params, so an absent field means an older save).
describe('legacy param pins on restore', () => {
    it('absent fields get their legacy values; present ones are kept', () => {
        const old = WorldManager._pinLegacyParams({ seed: 3, pedestrianDensity: 1 });
        expect(old).toMatchObject({ adScreens: false, districtPalette: false, roofVariety: false, trafficDensity: 1, pedestrianDensity: 1 });
        const now = WorldManager._pinLegacyParams({ seed: 3, adScreens: true, districtPalette: true, roofVariety: false, trafficDensity: 1.3 });
        expect(now).toMatchObject({ adScreens: true, districtPalette: true, roofVariety: false, trafficDensity: 1.3 });
    });
    it('mover blobs default on at the static blobs opacity', () => {
        expect(MOVER_SHADOW_DEFAULTS).toEqual({ on: true, strength: 0.55 });
    });
});
