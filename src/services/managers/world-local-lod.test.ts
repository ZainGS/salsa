import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import { cityDrawDistance } from './view-cull';
import { generateCityLayout, buildLocalLine, DEFAULT_LAYOUT_PARAMS } from '../../world';
import { CONTACT_SHADOW_LAYERS } from '../../world/contact-shadows';

// railway-upgrade R3.2: the at-grade local line's layer names land in the LOD tiers ON PURPOSE — sleepers, rails, fence
// and catenary are fine detail, the crossing equipment + station props are props, the bed / boards / paint / platform
// are structure, the lit parts (crossing lamps, station sign + lamps) and the parked train stay untiered — and every
// world:local-* name is claimed by exactly ONE zoom tier unless it is lit / the train.

const F = 10, tiers = WorldManager.cityDistanceTiers(F), fine = F * WorldManager.DIST_LOD_FINE;
const WM = WorldManager as unknown as Record<string, RegExp>;
const ZOOM = ['DETAIL_LOD', 'ROOF_LOD', 'PROPS_LOD', 'FLATMAP_LOD', 'STRUCTURE_LOD'].map(k => [k, WM[k]] as const);
const names = [...new Set(buildLocalLine(generateCityLayout({ ...DEFAULT_LAYOUT_PARAMS, seed: 1, localLine: true }), true).map(l => l.name))];
const LIT = /world:local-xing-lamp-|world:local-stn-sign-lit|world:local-stn-lamplights|world:local-train/;

describe('local line layer tiers (R3.2)', () => {
    it('builds the expected families', () => {
        for (const n of ['world:local-ballast', 'world:local-board', 'world:local-fine-rail', 'world:local-fine-sleeper', 'world:local-fine-cat-wire',
            'world:local-xing-prop', 'world:local-xing-arm', 'world:local-xing-lamp-0a', 'world:local-xing-lamp-0b', 'world:local-platform', 'world:local-train'])
            expect(names).toContain(n);
    });
    it('every local name is in exactly one zoom tier; lit parts + the train in none', () => {
        for (const n of names) {
            const hits = ZOOM.filter(([, re]) => re.test(n)).map(([k]) => k);
            if (LIT.test(n)) expect(hits, n).toEqual([]);
            else expect(hits.length, n + ' → ' + hits.join(',')).toBe(1);
        }
        expect(WM.PROPS_LOD.test('world:local-xing-arm-live-3')).toBe(true);   // the live arms are props too
    });
    it('distances: fine detail near only, props at the props range, structure + lit never distance-hide', () => {
        for (const n of names) {
            const d = cityDrawDistance(n, tiers);
            if (/world:local-fine-/.test(n)) expect(d).toBeCloseTo(fine);
            else if (/world:local-prop|world:local-xing-(?!lamp)/.test(n)) expect(d).toBeCloseTo(F * 1.2);
            else expect(d, n).toBe(0);
        }
    });
    it('the crossing equipment + station props cast contact shadows', () => {
        expect(CONTACT_SHADOW_LAYERS.test('world:local-xing-prop')).toBe(true);
        expect(CONTACT_SHADOW_LAYERS.test('world:local-prop')).toBe(true);
    });
});
