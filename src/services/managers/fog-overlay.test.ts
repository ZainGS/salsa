/**
 * Step 3 (fog-horizon §6 "a cheap step"): road paint, road wear, gutters and storefronts are fog class 'overlay' —
 * class 2 for the fog-horizon CPU cull (they stop drawing past Far), but with NO fade-band dissolve (flags2 bit 0 off),
 * so inside the clear zone and the band they look exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { assignDrawDistances, type FogExtraClass } from './view-cull';
import { encodeMeshFlags2, FLAGS2_DISTANCE_FADE } from '../../renderer/3d/material-3d';

const OVERLAYS: FogExtraClass = [/world:roadpaint|world:roads-wear|world:gutter|world:detail-storefront/, 'overlay'];
const EXTRAS: FogExtraClass[] = [OVERLAYS, [/world:lamp-/, 'other']];

type N = { name: string; children?: N[]; fogClass: 0 | 1 | 2; fogNoFade: boolean; materialDirty: boolean; drawDistance: number };
const node = (name: string, children?: N[]): N => ({ name, children, fogClass: 0, fogNoFade: false, materialDirty: false, drawDistance: 0 });

describe('fog class overlay (step 3)', () => {
    it('overlays are class 2 without the fade; other extras keep fading; buildings untouched', () => {
        const paint = node('world:roadpaint'), wear = node('world:roads-wear'), gutter = node('world:gutter-grate');
        const store = node('world:detail-storefront#3'), lamp = node('world:lamp-pool'), body = node('world:bodies');
        const root = node('World Tile 0_1 Streets', [paint, wear, gutter, store, lamp, body]);
        assignDrawDistances([root], [], { tiers: [], extras: EXTRAS });
        for (const m of [paint, wear, gutter, store]) {
            expect(m.fogClass).toBe(2);
            expect(m.fogNoFade).toBe(true);
            expect(m.materialDirty).toBe(true);   // the slot's flags2 is rewritten
            expect(encodeMeshFlags2({ ...m, material: {} }) & FLAGS2_DISTANCE_FADE).toBe(0);
        }
        expect(lamp.fogClass).toBe(2); expect(lamp.fogNoFade).toBe(false);
        expect(encodeMeshFlags2({ ...lamp, material: {} }) & FLAGS2_DISTANCE_FADE).toBe(FLAGS2_DISTANCE_FADE);
        expect(body.fogClass).toBe(0); expect(body.fogNoFade).toBe(false); expect(body.materialDirty).toBe(false);
    });
    it('switch off (no overlay entry) = the old classes', () => {
        const paint = node('world:roadpaint');
        paint.fogClass = 2; paint.fogNoFade = true;
        assignDrawDistances([paint], [], { tiers: [], extras: [[/world:lamp-/, 'other']] });
        expect(paint.fogClass).toBe(0);
        expect(paint.fogNoFade).toBe(false);
    });
});
