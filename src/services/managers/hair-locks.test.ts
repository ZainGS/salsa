import { describe, it, expect } from 'vitest';
import { generateHair, hairStyleNames, hairStylePreset, DEFAULT_HAIR_PARAMS, type HairParams } from './hair-generator';
import { generateCharacterParts } from './character-parts';
import { headRegionBBoxOf } from './body-fit';
import { computeFringe, eyeLayoutFromParams } from './face-features';
import { defaultEyeParams } from './eye-generator';
import { NEW_BODY_DEFAULTS } from './body-generator';
import { defaultTopParams } from './clothing-generator';

/** Generate a character's hair (body + a top for the collision soup) and measure it against the face. */
function measure(hair: HairParams) {
    const parts = generateCharacterParts({ body: { ...NEW_BODY_DEFAULTS }, garments: [defaultTopParams()], hair });
    const b = parts.body, s = b.skinning, head = s.jointNames.indexOf('head');
    const bb = headRegionBBoxOf(b.geometry.vertices, s.jointIndices, s.jointWeights, head)!;
    const hX = bb.max[0] - bb.min[0], hY = bb.max[1] - bb.min[1];
    const cx = (bb.min[0] + bb.max[0]) / 2, cz = (bb.min[2] + bb.max[2]) / 2, hw = hX * 0.95 / 2;
    const eyes = eyeLayoutFromParams(defaultEyeParams(), { cx, cy: bb.min[1] + hY * 0.55, hw, hh: hY * 0.21 });
    const skin = { x0: cx - hw, x1: cx + hw, y0: bb.min[1], y1: bb.min[1] + hY * 0.86 };
    const r = parts.hair!.result, g = r.geometry;
    const fy = computeFringe(g.vertices, g.indices, skin, cz, 160, 160, 12, Infinity);   // locks are solid: all of it counts
    let cols = 0, over = 0;
    for (let i = 0; i < fy.length; i++) {
        const x = skin.x0 + ((i + 0.5) / fy.length) * (skin.x1 - skin.x0);
        if (Math.abs(Math.abs(x - cx) - Math.abs(eyes[1].cx - cx)) > eyes[1].halfW) continue;
        cols++; if (!Number.isNaN(fy[i]) && fy[i] < eyes[0].cy + eyes[0].halfH) over++;   // hair below the eye's top
    }
    return { result: r, tris: g.indices.length / 3, eyeCover: over / Math.max(1, cols), fringeCols: fy.filter((v) => !Number.isNaN(v)).length };
}

describe('hair style system (hairMode locks)', () => {
    it('has the 15 presets, each a locks-mode param bundle with the highlight band', () => {
        const names = hairStyleNames();
        for (const n of ['bob', 'long-straight', 'side-swept', 'ponytail', 'twintails', 'short-messy', 'bun', 'hime',
            'braid', 'twin-braids', 'wavy', 'curls', 'spiky', 'drills', 'curly-volume']) expect(names).toContain(n);
        for (const n of names) {
            const p = hairStylePreset(n)!;
            expect(p.hairMode).toBe('locks');
            expect(p.sheenBand).toBe(true);
            expect(p.hairStyle).toBe(n);
        }
        expect(hairStylePreset('Hime cut')!.hairStyle).toBe('hime');
        expect(hairStylePreset('nope')).toBeNull();
    });

    it('every preset: finite geometry within the triangle budget, a fringe, and the eyes left clear', () => {
        for (const n of hairStyleNames()) {
            for (const seed of [0, 17]) {
                const m = measure(hairStylePreset(n, seed)!);
                if (process.env.HAIR_TRIS) console.log('[tris]', n, seed, m.tris, 'eyeCover', m.eyeCover.toFixed(2), 'fringeCols', m.fringeCols);
                const v = m.result.geometry.vertices;
                expect(v.every(Number.isFinite), n).toBe(true);
                expect(m.tris, n).toBeGreaterThan(1500);
                expect(m.tris, n).toBeLessThanOrEqual(10000);
                expect(m.fringeCols, n).toBeGreaterThan(40);          // the face kit finds a fringe edge
                expect(m.eyeCover, n).toBeLessThan(0.3);              // eyes visible by default
            }
        }
    });

    it('tails are tagged for spring chains (ponytail 1, twintails 2), loose styles have none', () => {
        expect(measure(hairStylePreset('ponytail')!).result.tailBones.length).toBe(1);
        expect(measure(hairStylePreset('twintails')!).result.tailBones.length).toBe(2);
        expect(measure(hairStylePreset('bob')!).result.tailBones.length).toBe(0);
        const tw = measure(hairStylePreset('twintails')!).result;
        expect(tw.drapeFromTailId).toBe(2);
        expect(Array.from(tw.tailVertId).some((t) => t === 1)).toBe(true);
    });

    it('braids and drills are spring-tagged tails too; the curl / spike / poof styles have none', () => {
        expect(measure(hairStylePreset('braid')!).result.tailBones.length).toBe(1);
        expect(measure(hairStylePreset('twin-braids')!).result.tailBones.length).toBe(2);
        expect(measure(hairStylePreset('drills')!).result.tailBones.length).toBe(2);
        for (const n of ['wavy', 'curls', 'spiky', 'curly-volume']) expect(measure(hairStylePreset(n)!).result.tailBones.length, n).toBe(0);
    });

    it('the new style knobs change the hair; absent = off (the original 8 presets build exactly as before)', () => {
        const base = hairStylePreset('long-straight', 3)!;
        const g0 = measure(base).result.geometry.vertices;
        const off = measure({ ...base, lockCurl: 0, lockSpike: 0, hairPoof: 0, tailForm: 'bundle' }).result.geometry.vertices;
        expect(Array.from(off)).toEqual(Array.from(g0));
        for (const k of [{ lockCurl: 0.6 }, { lockCurl: 0.6, lockCurlType: 'spiral' as const }, { lockSpike: 0.8 }, { hairPoof: 0.8 }]) {
            const g = measure({ ...base, ...k }).result.geometry.vertices;
            expect(g.length === g0.length && g.every((v, i) => v === g0[i]), JSON.stringify(k)).toBe(false);
        }
        const pony = hairStylePreset('ponytail')!;
        const bundle = measure(pony).result.geometry.vertices;
        for (const tailForm of ['braid', 'drill'] as const) {
            const m = measure({ ...pony, tailForm });
            expect(m.result.tailBones.length).toBe(1);
            expect(m.result.geometry.vertices.length).not.toBe(bundle.length);
            expect(m.tris).toBeLessThanOrEqual(10000);
        }
    });

    it('a long fringe really covers the eyes (the slider is not clamped)', () => {
        expect(measure({ ...hairStylePreset('hime')!, fringeHeight: -0.05 }).eyeCover).toBeGreaterThan(0.5);
    });

    it('legacy modes are untouched: cards / chunky hair ignores the style fields', () => {
        const head = { cx: 0, cy: 1.6, cz: 0, rx: 0.09, ry: 0.11, rz: 0.1 };
        const a = generateHair(head, { ...DEFAULT_HAIR_PARAMS }).geometry.vertices;
        const b = generateHair(head, { ...DEFAULT_HAIR_PARAMS, fringeStyle: 'swept', lockCount: 20, hairLength: 3, gather: true }).geometry.vertices;
        expect(Array.from(b)).toEqual(Array.from(a));
    });
});
