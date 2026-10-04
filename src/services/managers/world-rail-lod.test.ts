import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import { cityDrawDistance } from './view-cull';
import { generateCityLayout, buildRailway, DEFAULT_LAYOUT_PARAMS } from '../../world';

// railway-upgrade R1.6: the rail / station / metro layer names land in the LOD tiers ON PURPOSE — sleepers, rails and
// the catenary are fine detail, station props + metro kiosks are props, the structure never distance-hides, the lit
// parts stay untiered — and every name is claimed by at most ONE zoom tier (an outer tier must never re-show a mesh
// an inner one still hides).

const F = 10, tiers = WorldManager.cityDistanceTiers(F), fine = F * WorldManager.DIST_LOD_FINE;
const WM = WorldManager as unknown as Record<string, RegExp>;
const ZOOM = ['DETAIL_LOD', 'ROOF_LOD', 'PROPS_LOD', 'FLATMAP_LOD', 'STRUCTURE_LOD'].map(k => [k, WM[k]] as const);
const names = [...new Set([
    ...buildRailway(generateCityLayout({ ...DEFAULT_LAYOUT_PARAMS, seed: 3, edgeWear: 'heavy' }), false),
    ...buildRailway(generateCityLayout({ ...DEFAULT_LAYOUT_PARAMS, seed: 3, pattern: 'grid', railViaduct: 'arcade' }), false),   // R3.1 arcade
].map(l => l.name))];

describe('rail layer tiers (R1.6)', () => {
    it('builds the expected families', () => {
        for (const n of ['world:rail-deck', 'world:rail-pier', 'world:rail-fine-sleeper', 'world:rail-fine-cat-wire', 'world:rail-stn-platform', 'world:metro-kiosk',
            'world:rail-arc-wall', 'world:rail-arc-prop', 'world:rail-arc-sign-text', 'world:rail-arc-lantern', 'world:metro-sign-letter'])
            expect(names).toContain(n);
    });
    it('fine detail / props / structure / lit', () => {
        for (const n of names) {
            const d = cityDrawDistance(n, tiers);
            if (/world:rail-fine-/.test(n)) expect(d).toBeCloseTo(fine);
            else if (/world:rail-stn-prop|world:rail-arc-prop|world:metro-(?!sign)/.test(n)) expect(d).toBeCloseTo(F * 1.2);
            else expect(d).toBe(0);   // structure + the lit signs / lamps never distance-hide
        }
    });
    it('every rail name is in exactly one zoom tier (structure / detail / props), lit signs in none but structure', () => {
        for (const n of names) {
            const hits = ZOOM.filter(([, re]) => re.test(n)).map(([k]) => k);
            expect(hits.length, n + ' → ' + hits.join(',')).toBeLessThanOrEqual(1);
            if (/world:rail-/.test(n)) expect(hits.length, n).toBe(1);
        }
        expect(WM.STRUCTURE_LOD.test('world:rail-train')).toBe(false);   // the train belongs to the traffic system
    });
});
