/**
 * src/world/lamp-post.test.ts — the lamp-post generator (the new-prop template + two reuses: an EMISSIVE lamp
 * head and windSway BANNERS).
 *
 * Pins the contract: the expected material-family layers exist, banners toggle + carry the wind spec, the lamp
 * head is emissive, params clamp, and it's authored in metres + deterministic.
 */

import { describe, it, expect } from 'vitest';
import { buildLampPost, resolveLampPostParams, DEFAULT_LAMP_POST_PARAMS, LAMP_STYLES } from './lamp-post';
import type { LayoutPreviewLayer } from './types';

const layer = (ls: LayoutPreviewLayer[], name: string) => ls.find((l) => l.name === name);

describe('buildLampPost — layers & material families', () => {
    it('emits a metal pole, an EMISSIVE lamp head, and a windSway banner (default has banners)', () => {
        const { layers } = buildLampPost();
        const pole = layer(layers, 'world:lamp-pole');
        const glow = layer(layers, 'world:lamp-glow');
        const banner = layer(layers, 'world:lamp-banner');
        expect(pole?.metal).toBeTruthy();                      // painted-metal family
        expect((glow?.emissive ?? 0)).toBeGreaterThan(0);      // the lamp glows
        expect(banner?.wind).toBeTruthy();                     // banners reuse windSway
        expect(banner!.wind!.amount).toBeGreaterThan(0);
    });

    it('banners:false drops the banner layer (and the cross-arm geometry)', () => {
        const withB = buildLampPost({ banners: true });
        const noB = buildLampPost({ banners: false });
        expect(layer(withB.layers, 'world:lamp-banner')).toBeTruthy();
        expect(layer(noB.layers, 'world:lamp-banner')).toBeUndefined();
        // fewer verts overall without the arm + two banners.
        const verts = (ls: LayoutPreviewLayer[]) => ls.reduce((n, l) => n + l.geometry.vertices.length, 0);
        expect(verts(noB.layers)).toBeLessThan(verts(withB.layers));
    });

    it('both styles build; classic vs modern differ in geometry', () => {
        for (const style of LAMP_STYLES) expect(buildLampPost({ style }).layers.length).toBeGreaterThan(0);
        const cV = buildLampPost({ style: 'classic', banners: false }).layers.reduce((n, l) => n + l.geometry.vertices.length, 0);
        const mV = buildLampPost({ style: 'modern', banners: false }).layers.reduce((n, l) => n + l.geometry.vertices.length, 0);
        expect(cV).not.toBe(mV);
    });
});

describe('lamp-post params + authoring', () => {
    it('resolveLampPostParams clamps height to [2, 8] and validates the style enum', () => {
        expect(resolveLampPostParams({ heightM: 0.5 }).heightM).toBe(2);
        expect(resolveLampPostParams({ heightM: 99 }).heightM).toBe(8);
        expect(resolveLampPostParams({ style: 'bogus' as never }).style).toBe(DEFAULT_LAMP_POST_PARAMS.style);
    });

    it('is authored in METRES (1 unit = 1 m) — the tallest extent ≈ heightM', () => {
        let maxY = -Infinity, minY = Infinity;
        for (const L of buildLampPost({ heightM: 5, banners: false }).layers) {
            const v = L.geometry.vertices;
            for (let i = 1; i < v.length; i += 12) { maxY = Math.max(maxY, v[i]); minY = Math.min(minY, v[i]); }
        }
        expect(maxY - minY).toBeGreaterThan(5 * 0.9);
        expect(maxY - minY).toBeLessThan(5 * 1.3);   // headroom for the finial/globe above the pole
    });

    it('is deterministic', () => {
        const a = buildLampPost({ seed: 7 }).layers.map((l) => l.geometry.vertices.length);
        const b = buildLampPost({ seed: 7 }).layers.map((l) => l.geometry.vertices.length);
        expect(a).toEqual(b);
    });
});
