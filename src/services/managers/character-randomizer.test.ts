import { describe, it, expect } from 'vitest';
import { randomCharacterParams, RANDOM_CHARACTER_LIMITS as L } from './character-randomizer';
import { bodyFor, CONFIGS } from './clothing-audit-harness';
import { generateTop } from './clothing-generator';
import { generateHair, hairStyleNames, type HeadFrame } from './hair-generator';
import { generateCharacterParts } from './character-parts';
import { headRegionBBoxOf } from './body-fit';
import { eyeLayoutFromParams, computeFringe } from './face-features';
import { NEW_BODY_DEFAULTS } from './body-generator';

describe('random character defaults (polish-round-3 T6)', () => {
    const SEEDS = Array.from({ length: 500 }, (_, i) => i * 7919 + 1);

    it('every seed: eyes ≈0.4×0.2 + no bottom lash, a lock hair style, rim on, uncropped top, looser bottoms', () => {
        for (const seed of SEEDS) {
            const p = randomCharacterParams(seed);
            expect(p.eyes.width).toBeGreaterThanOrEqual(L.eyeWidth[0]);
            expect(p.eyes.width).toBeLessThanOrEqual(L.eyeWidth[1]);
            expect(p.eyes.height).toBeGreaterThanOrEqual(L.eyeHeight[0]);
            expect(p.eyes.height).toBeLessThanOrEqual(L.eyeHeight[1]);
            expect(Math.abs(p.eyes.width - 0.4)).toBeLessThan(0.05);
            expect(Math.abs(p.eyes.height - 0.2)).toBeLessThan(0.03);
            expect(p.eyes.lowerLash).toBe(false);
            expect(p.hair.hairMode).toBe('locks');                    // the anime style system (2026-10-04)
            expect(hairStyleNames()).toContain(p.hair.hairStyle);
            expect(p.rimLight).toBe(true);
            expect(p.top.hemHeight).toBeLessThanOrEqual(0);
            expect(p.bottom.thickness).toBeGreaterThan(0.014);
            expect(p.bottom.thickness).toBeGreaterThanOrEqual(L.bottomThickness[0]);
            expect(p.top.slot).toBe('top');
            expect(p.bottom.slot).toBe('bottom');
        }
    });

    it('is seeded (same seed → same character) and still varied across seeds', () => {
        expect(randomCharacterParams(42)).toEqual(randomCharacterParams(42));
        const all = SEEDS.map((s) => randomCharacterParams(s));
        const distinct = (f: (p: ReturnType<typeof randomCharacterParams>) => unknown) => new Set(all.map(f)).size;
        expect(distinct((p) => p.skinTone)).toBeGreaterThan(5);
        expect(distinct((p) => p.hair.rootColor)).toBeGreaterThan(10);
        expect(distinct((p) => p.hair.hairStyle)).toBe(hairStyleNames().length);   // every style gets picked
        expect(distinct((p) => p.hair.tailStyle)).toBeGreaterThanOrEqual(3);
        expect(distinct((p) => p.bottom.bottomStyle)).toBe(3);
        expect(distinct((p) => p.top.baseColor)).toBeGreaterThan(10);
        expect(distinct((p) => p.eyes.irisColor)).toBeGreaterThan(5);
    });

    it('body overrides merge over the random body', () => {
        const p = randomCharacterParams(3, { height: 0.7, waist: 0.9 });
        expect(p.body.height).toBe(0.7);
        expect(p.body.waist).toBe(0.9);
        expect(p.body.hipFront).toBeGreaterThan(0);
    });

    it('the random top actually covers the belly (hem at/below the hips)', () => {
        const { fit } = bodyFor(CONFIGS[0]);
        const hipsY = fit.joints['hips']!.pos[1];
        const lowestY = (top: ReturnType<typeof randomCharacterParams>['top']) => {
            const g = generateTop(fit, top);
            const v = g.geometry.vertices, stride = v.length / (g.jointWeights.length / 4);
            let minY = Infinity;
            for (let i = 1; i < v.length; i += stride) minY = Math.min(minY, v[i]);
            return minY;
        };
        // Control: the old randomizer's crop range (up to 0.85) really does bare the midriff.
        expect(lowestY({ ...randomCharacterParams(1).top, hemHeight: 0.85 })).toBeGreaterThan(hipsY + 0.02);
        for (const seed of SEEDS.slice(0, 12)) expect(lowestY(randomCharacterParams(seed).top)).toBeLessThanOrEqual(hipsY + 1e-3);
    });

    it('the random style hair generates finite geometry', () => {
        const { r } = bodyFor(CONFIGS[0]);
        const V = r.geometry.vertices, headIdx = r.skinning.jointNames.indexOf('head');
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < V.length / 12; i++) {
            let dom = 0, bw = -1;
            for (let k = 0; k < 4; k++) if (r.skinning.jointWeights[i * 4 + k] > bw) { bw = r.skinning.jointWeights[i * 4 + k]; dom = r.skinning.jointIndices[i * 4 + k]; }
            if (dom !== headIdx || bw <= 0.5) continue;
            for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], V[i * 12 + c]); mx[c] = Math.max(mx[c], V[i * 12 + c]); }
        }
        const head: HeadFrame = { cx: (mn[0] + mx[0]) / 2, cy: (mn[1] + mx[1]) / 2, cz: (mn[2] + mx[2]) / 2, rx: (mx[0] - mn[0]) / 2, ry: (mx[1] - mn[1]) / 2, rz: (mx[2] - mn[2]) / 2 };
        for (const seed of SEEDS.slice(0, 6)) {
            const hv = generateHair(head, randomCharacterParams(seed).hair, V).geometry.vertices;
            expect(hv.length).toBeGreaterThan(0);
            expect(hv.every(Number.isFinite)).toBe(true);
        }
    });
});

describe('random character look (visual-polish item 10, 2026-10-03)', () => {
    it('matte skin + cloth, banded hair sheen, no under-eye dots, hairline in range; the rest of a seed is unchanged', () => {
        for (const seed of [1, 7, 25, 32, 99]) {
            const p = randomCharacterParams(seed);
            expect(p.matte).toBe(true);
            expect(p.hair.sheenBand).toBe(true);
            expect(p.eyes.underDeco).toBe(false);
            expect(p.hair.hairlineFront).toBeGreaterThanOrEqual(L.hairlineFront[0]);
            expect(p.hair.hairlineFront).toBeLessThanOrEqual(L.hairlineFront[1]);
        }
        // The under-eye draw still happens (stream position kept): the colour/count after it still vary by seed.
        const all = Array.from({ length: 40 }, (_, i) => randomCharacterParams(i + 1));
        expect(new Set(all.map((p) => p.eyes.underDecoCount)).size).toBeGreaterThan(2);
        expect(new Set(all.map((p) => p.hair.hairlineFront.toFixed(3))).size).toBeGreaterThan(30);   // still varied
    });

    it('most random faces show their eyes: the generated fringe stays above the eye line', () => {
        // The issue: with the old 0..0.40 hairline about 40% of seeds hung the cap cards over the eyes. Measure the
        // generated hair's fringe (the face kit's own computeFringe) over each eye's columns.
        let clear = 0, n = 0;
        for (let seed = 1; seed <= 24; seed++) {
            const p = randomCharacterParams(seed);
            const parts = generateCharacterParts({ body: { ...NEW_BODY_DEFAULTS, ...p.body }, garments: [], hair: p.hair });
            const b = parts.body, s = b.skinning, head = s.jointNames.indexOf('head');
            const bb = headRegionBBoxOf(b.geometry.vertices, s.jointIndices, s.jointWeights, head)!;
            const hX = bb.max[0] - bb.min[0], hY = bb.max[1] - bb.min[1];
            const cx = (bb.min[0] + bb.max[0]) / 2, cz = (bb.min[2] + bb.max[2]) / 2, hw = hX * 0.95 / 2;
            const eyes = eyeLayoutFromParams(p.eyes, { cx, cy: bb.min[1] + hY * 0.55, hw, hh: hY * 0.21 });
            const skin = { x0: cx - hw, x1: cx + hw, y0: bb.min[1], y1: bb.min[1] + hY * 0.86 };
            const g = parts.hair!.result.geometry;
            const fy = computeFringe(g.vertices, g.indices, skin, cz, 160, 160, 12, p.hair.hairMode === 'cards' ? 0.5 : Infinity);   // solid locks: all of it (cards: the root)
            let cols = 0, over = 0;
            for (let i = 0; i < fy.length; i++) {
                const x = skin.x0 + ((i + 0.5) / fy.length) * (skin.x1 - skin.x0);
                if (Math.abs(Math.abs(x - cx) - Math.abs(eyes[1].cx - cx)) > eyes[1].halfW) continue;
                cols++; if (!Number.isNaN(fy[i]) && fy[i] < eyes[0].cy) over++;   // hair below the eye's centre line
            }
            n++; if (over / cols < 0.3) clear++;
        }
        expect(clear / n).toBeGreaterThanOrEqual(0.9);
    });
});
