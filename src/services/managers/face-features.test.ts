import { describe, it, expect } from 'vitest';
import {
    defaultFaceFeatureParams, normalizeFaceFeatureParams, randomFaceFeatureParams, blendExpressionShapes, lerpExpressionShape,
    expressionWeights, dominantExpression, EXPRESSION_SHAPES, FACE_EXPRESSION_NAMES, featureMultiplier, resolveBrowColor,
    eyeLayoutFromParams, computeFringe, buildFaceOverlayGeometry, eyeDecalSurfaceZ, renderFaceLayer, hexToRgb,
    type FaceLayout,
} from './face-features';
import { defaultEyeParams, blinkParamsFor } from './eye-generator';
import { randomCharacterParams } from './character-randomizer';
import { bodyFor, CONFIGS } from './clothing-audit-harness';
import { headRegionBBoxOf } from './body-fit';
import { makeRng } from '../../world/util';
import { generateBodyResult, NEW_BODY_DEFAULTS } from './body-generator';

describe('face kit params', () => {
    it('normalize fills, clamps and drops junk; a full set round-trips unchanged', () => {
        const d = defaultFaceFeatureParams();
        expect(normalizeFaceFeatureParams(undefined)).toEqual(d);
        expect(normalizeFaceFeatureParams(d)).toEqual(d);
        const n = normalizeFaceFeatureParams({ browThickness: 7, mouthWidth: -3, browStyle: 'zig' as never, browColor: 'red', expression: 'smile', junk: 1 } as never);
        expect(n.browThickness).toBe(1);
        expect(n.mouthWidth).toBe(0.2);
        expect(n.browStyle).toBe(d.browStyle);
        expect(n.browColor).toBe('');
        expect(n.expression).toBe('smile');
        expect((n as unknown as Record<string, unknown>).junk).toBeUndefined();
    });

    it('random params stay in range and are seeded', () => {
        for (let s = 1; s < 300; s++) {
            const p = randomFaceFeatureParams(makeRng(s));
            expect(normalizeFaceFeatureParams(p)).toEqual(p);   // already valid
            expect(p.enabled).toBe(true);
            expect(p.browColor).toBe('');                       // brows follow the hair
            expect(p.browThickness).toBeGreaterThanOrEqual(0.35);
        }
        expect(randomFaceFeatureParams(makeRng(9))).toEqual(randomFaceFeatureParams(makeRng(9)));
    });

    it('random characters carry a face kit without changing any pre-kit field of a seed', () => {
        const p = randomCharacterParams(42);
        expect(p.face.enabled).toBe(true);
        expect(randomCharacterParams(42)).toEqual(p);
        // The face draws from its own seed-derived stream (drawn last), so it varies by seed too.
        const q = randomCharacterParams(43);
        expect(q.face).not.toEqual(p.face);
    });

    it('lid shadow is opt-in for old eyes and follows into the blink frame', () => {
        const old = { ...defaultEyeParams() } as Partial<ReturnType<typeof defaultEyeParams>>;
        delete old.lidShadow; delete old.lidShadowColor;
        expect(old.lidShadow).toBeUndefined();                  // saved eyes without it render no shadow (0)
        const b = blinkParamsFor(defaultEyeParams())!;
        expect(b.closed).toBe(true);
        expect(b.lidShadow).toBe(defaultEyeParams().lidShadow);
    });
});

describe('expressions', () => {
    it('names, shapes and blends', () => {
        expect(FACE_EXPRESSION_NAMES).toEqual(['neutral', 'smile', 'open', 'frown', 'surprised']);
        expect(blendExpressionShapes({ neutral: 1 })).toEqual(EXPRESSION_SHAPES.neutral);
        expect(blendExpressionShapes({ smile: 1 })).toEqual(EXPRESSION_SHAPES.smile);
        const half = blendExpressionShapes({ smile: 0.5 });
        expect(half.mouthCurve).toBeCloseTo(EXPRESSION_SHAPES.smile.mouthCurve / 2);
        const avg = blendExpressionShapes({ smile: 1, frown: 1 });   // sums past 1 → normalised
        expect(avg.mouthCurve).toBeCloseTo((EXPRESSION_SHAPES.smile.mouthCurve + EXPRESSION_SHAPES.frown.mouthCurve) / 2);
        expect(blendExpressionShapes({}, { browRaise: 0.4 }).browRaise).toBeCloseTo(0.4);
        const l = lerpExpressionShape(EXPRESSION_SHAPES.neutral, EXPRESSION_SHAPES.surprised, 0.5);
        expect(l.mouthOpen).toBeCloseTo(EXPRESSION_SHAPES.surprised.mouthOpen / 2);
        expect(EXPRESSION_SHAPES.surprised.browRaise).toBeGreaterThan(0);
        expect(EXPRESSION_SHAPES.frown.browInner).toBeLessThan(0);
        expect(EXPRESSION_SHAPES.smile.mouthCurve).toBeGreaterThan(0);
    });

    it('weights from a name / object; dominant', () => {
        expect(expressionWeights('smile')).toEqual({ smile: 1 });
        expect(expressionWeights('nope')).toEqual({ neutral: 1 });
        expect(expressionWeights({ open: 0.4, smile: -1, bogus: 3 } as never)).toEqual({ open: 0.4, smile: 0 });
        expect(dominantExpression({ open: 0.4, smile: 0.6 })).toBe('smile');
        expect(dominantExpression({})).toBe('neutral');
    });
});

describe('colour', () => {
    it('multipliers turn the skin into the target, clamped (multiply can only darken)', () => {
        const skin = hexToRgb('#f5c5a3');
        const m = featureMultiplier([0.2, 0.1, 0.05], skin);
        expect(m[0] * skin[0]).toBeCloseTo(0.2);
        expect(featureMultiplier([1, 1, 1], [0.5, 0.5, 0.5])).toEqual([1, 1, 1]);
    });

    it('brows follow the hair and always read darker than the skin', () => {
        const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        for (const skinHex of ['#f5c5a3', '#6b3a22', '#fce4cc']) {
            const skin = hexToRgb(skinHex);
            for (const hair of ['#1a0a00', '#f5e6c8', '#cccccc', '#cc3300', null]) {
                const c = resolveBrowColor('', hair, skin);
                expect(lum(c)).toBeLessThanOrEqual(lum(skin) * 0.6 + 1e-6);
            }
        }
        const dark = resolveBrowColor('', '#3d1a00', hexToRgb('#f5c5a3'));
        expect(dark[0]).toBeGreaterThan(dark[2]);                 // keeps the hair's hue (brown)
        expect(resolveBrowColor('#102030', '#ffffff', [1, 1, 1])).toEqual(hexToRgb('#102030'));
    });
});

describe('layout + overlay geometry on the real procedural head', () => {
    const { r } = bodyFor(CONFIGS[0]);
    const g = r.geometry, ji = r.skinning.jointIndices, jw = r.skinning.jointWeights;
    const head = r.skinning.jointNames.indexOf('head');
    const bb = headRegionBBoxOf(g.vertices, ji, jw, head)!;
    const hX = bb.max[0] - bb.min[0], hY = bb.max[1] - bb.min[1], hZ = bb.max[2] - bb.min[2];
    const cx = (bb.min[0] + bb.max[0]) / 2, hw = hX * 0.95 / 2;
    const rect = { x0: cx - hw, x1: cx + hw, y0: bb.min[1], y1: bb.min[1] + hY * 0.86 };

    it('eye layout mirrors the eye generator (symmetric, visual sizes)', () => {
        const ep = defaultEyeParams();
        const f = { cx, cy: bb.min[1] + hY * 0.55, hw, hh: hY * 0.21 };
        const [l, rr] = eyeLayoutFromParams(ep, f);
        expect(l.cx + rr.cx).toBeCloseTo(2 * cx);
        expect(l.outerSign).toBe(-1); expect(rr.outerSign).toBe(1);
        expect(rr.halfW).toBeCloseTo(ep.width * f.hh);
        expect(rr.cy).toBeCloseTo(f.cy + f.hh - ep.verticalPos * 2 * f.hh);
    });

    it('the overlay hugs the head: in front of the surface, inside the rect, skinned (weights sum to 1)', () => {
        const off = hZ * 0.006;
        const o = buildFaceOverlayGeometry({ vertices: g.vertices, indices: g.indices, jointIndices: ji, jointWeights: jw }, head, rect, 21, 25, off, undefined, hY * 0.15)!;
        expect(o).not.toBeNull();
        const nv = o.vertices.length / 12;
        expect(nv).toBeGreaterThan(100);
        expect(o.jointIndices.length).toBe(nv * 4);
        expect(o.jointWeights.length).toBe(nv * 4);
        let maxIdx = 0; for (const i of o.indices) maxIdx = Math.max(maxIdx, i);
        expect(maxIdx).toBeLessThan(nv);
        for (let v = 0; v < nv; v++) {
            const x = o.vertices[v * 12], y = o.vertices[v * 12 + 1], z = o.vertices[v * 12 + 2], u = o.vertices[v * 12 + 6], t = o.vertices[v * 12 + 7];
            expect(x).toBeGreaterThanOrEqual(rect.x0 - 1e-6); expect(x).toBeLessThanOrEqual(rect.x1 + 1e-6);
            expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThanOrEqual(1);
            expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThanOrEqual(1);
            expect(z).toBeGreaterThan(bb.min[2]);   // a front hit
            let s = 0; for (let k = 0; k < 4; k++) s += o.jointWeights[v * 4 + k];
            expect(s).toBeCloseTo(1, 5);
            void y;
        }
        // The centre column sits `off` in front of the face's front-most point near the nose (max z of the head).
        let maxZ = -Infinity; for (let v = 0; v < nv; v++) maxZ = Math.max(maxZ, o.vertices[v * 12 + 2]);
        expect(maxZ).toBeGreaterThan(bb.max[2] - hZ * 0.05);
        expect(maxZ).toBeLessThanOrEqual(bb.max[2] + off + 1e-6);
    });

    it('minZ lifts the overlay in front of the eye decal', () => {
        // A flat 3x3 "decal" grid well in front of the face → every overlay vertex in its rect is pushed to it.
        const NC = 3, NR = 3, zD = bb.max[2] + 0.05, dv = new Float32Array(NC * NR * 12);
        for (let rr = 0; rr < NR; rr++) for (let c = 0; c < NC; c++) { const i = (rr * NC + c) * 12; dv[i] = rect.x0 + (c / 2) * (rect.x1 - rect.x0); dv[i + 1] = rect.y1 - (rr / 2) * (rect.y1 - rect.y0); dv[i + 2] = zD; }
        const zf = eyeDecalSurfaceZ(dv, NC, NR);
        expect(zf(cx, (rect.y0 + rect.y1) / 2)).toBeCloseTo(zD);
        expect(zf(rect.x1 + 1, rect.y1)).toBe(-Infinity);
        const o = buildFaceOverlayGeometry({ vertices: g.vertices, indices: g.indices, jointIndices: ji, jointWeights: jw }, head, rect, 9, 9, 0.001, (x, y) => zf(x, y) + 0.01)!;
        for (let v = 0; v < o.vertices.length / 12; v++) expect(o.vertices[v * 12 + 2]).toBeGreaterThanOrEqual(zD + 0.01 - 1e-6);
    });

    it('fringe: hair hanging to a line gives that line; no hair → NaN; card tips past vMax are ignored', () => {
        // One quad of "bangs" from the top of the rect down to y = yb over the middle third, in front (z > zMin).
        const yb = rect.y0 + (rect.y1 - rect.y0) * 0.6, x0 = cx - hw / 3, x1 = cx + hw / 3, z = bb.max[2] + 0.01;
        const v = new Float32Array(4 * 12);
        [[x0, rect.y1 + 0.01, 0], [x1, rect.y1 + 0.01, 0], [x1, yb, 1], [x0, yb, 1]].forEach(([x, y, tv], i) => { v[i * 12] = x; v[i * 12 + 1] = y; v[i * 12 + 2] = z; v[i * 12 + 7] = tv; });
        const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
        const f = computeFringe(v, idx, rect, bb.min[2], 32, 64);
        expect(Number.isNaN(f[0])).toBe(true);                       // no hair at the side
        expect(Math.abs(f[16] - yb)).toBeLessThan((rect.y1 - rect.y0) / 64 * 2.5);
        const fCards = computeFringe(v, idx, rect, bb.min[2], 32, 64, 12, 0.5);   // only the solid half of the card
        const mid = rect.y1 + 0.01 + (yb - rect.y1 - 0.01) * 0.5;
        expect(Math.abs(fCards[16] - mid)).toBeLessThan((rect.y1 - rect.y0) / 64 * 3);
        // Behind the face: ignored.
        expect(Number.isNaN(computeFringe(v, idx, rect, z + 1, 32, 64)[16])).toBe(true);
    });

    it('paints through a canvas without throwing; disabled → only a clear', () => {
        const calls: string[] = [];
        const ctx = new Proxy({}, {
            get: (_t, k) => {
                if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} });
                return (...a: unknown[]) => { calls.push(String(k)); void a; };
            },
            set: () => true,
        }) as unknown as CanvasRenderingContext2D;
        const ep = defaultEyeParams();
        const eyes = eyeLayoutFromParams(ep, { cx, cy: bb.min[1] + hY * 0.55, hw, hh: hY * 0.21 });
        const L: FaceLayout = {
            skin: rect, brow: { x0: rect.x0, x1: rect.x1, y0: bb.min[1] + hY * 0.44, y1: bb.min[1] + hY * 0.8 }, midX: cx, eyes,
            noseY: bb.min[1] + hY * 0.4, chinY: bb.min[1] + hY * 0.08, faceHalfW: hw * 0.6, fringe: { y: new Float32Array(16).fill(bb.min[1] + hY * 0.7) },
        };
        const colors = { skin: hexToRgb('#f5c5a3'), hairRoot: '#3d1a00' };
        for (const n of FACE_EXPRESSION_NAMES) {
            for (const nose of ['none', 'tick', 'shadow', 'dot', 'button'] as const) {
                renderFaceLayer(ctx, 'skin', { ...defaultFaceFeatureParams(), noseStyle: nose, blushLines: true }, L, EXPRESSION_SHAPES[n], colors, 256, 256);
            }
            for (const st of ['soft', 'straight', 'arched', 'angled', 'short'] as const) renderFaceLayer(ctx, 'brow', { ...defaultFaceFeatureParams(), browStyle: st }, L, EXPRESSION_SHAPES[n], colors, 256, 128);
        }
        expect(calls.filter((c) => c === 'fill').length).toBeGreaterThan(50);
        calls.length = 0;
        renderFaceLayer(ctx, 'skin', { ...defaultFaceFeatureParams(), enabled: false }, L, EXPRESSION_SHAPES.neutral, colors, 256, 256);
        expect(calls).toEqual(['setTransform', 'clearRect']);
    });
});

// The ANIME head (BodyParams.headShape, new bodies 2026-10-04) is reshaped but keeps the topology: the face kit's
// overlay must still hug its front, and the kit's rows (chin → brow) must land on the face, not miss under the jaw.
describe('face kit placement on the anime head (NEW_BODY_DEFAULTS)', () => {
    const r = generateBodyResult({ ...NEW_BODY_DEFAULTS });
    const g = r.geometry, ji = r.skinning.jointIndices, jw = r.skinning.jointWeights;
    const head = r.skinning.jointNames.indexOf('head');
    const bb = headRegionBBoxOf(g.vertices, ji, jw, head)!;
    const hX = bb.max[0] - bb.min[0], hY = bb.max[1] - bb.min[1], hZ = bb.max[2] - bb.min[2];
    const cx = (bb.min[0] + bb.max[0]) / 2, hw = hX * 0.95 / 2;
    const rect = { x0: cx - hw, x1: cx + hw, y0: bb.min[1], y1: bb.min[1] + hY * 0.86 };
    const NC = 21, NR = 25, off = hZ * 0.006;
    const o = buildFaceOverlayGeometry({ vertices: g.vertices, indices: g.indices, jointIndices: ji, jointWeights: jw }, head, rect, NC, NR, off, undefined, hY * 0.15)!;

    it('the overlay hugs the head (in front, inside the rect, skinned)', () => {
        expect(o).not.toBeNull();
        const nv = o.vertices.length / 12;
        expect(nv).toBeGreaterThan(100);
        let maxZ = -Infinity;
        for (let v = 0; v < nv; v++) {
            const x = o.vertices[v * 12], z = o.vertices[v * 12 + 2];
            expect(Number.isFinite(z)).toBe(true);
            expect(x).toBeGreaterThanOrEqual(rect.x0 - 1e-6); expect(x).toBeLessThanOrEqual(rect.x1 + 1e-6);
            expect(z).toBeGreaterThan(bb.min[2]);
            let s = 0; for (let k = 0; k < 4; k++) s += o.jointWeights[v * 4 + k];
            expect(s).toBeCloseTo(1, 5);
            maxZ = Math.max(maxZ, z);
        }
        expect(maxZ).toBeGreaterThan(bb.max[2] - hZ * 0.05);
        expect(maxZ).toBeLessThanOrEqual(bb.max[2] + off + 1e-6);
    });

    it('the kit rows (mouth, nose, eyes, brows) sit on the face front, centred', () => {
        // the overlay's centre column, sampled at the kit rows used by the layout (fractions of the head height)
        const nv = o.vertices.length / 12;
        for (const f of [0.18, 0.3, 0.4, 0.55, 0.7]) {
            const y = bb.min[1] + hY * f;
            let best = -1, bd = Infinity;
            for (let v = 0; v < nv; v++) { const d = Math.hypot(o.vertices[v * 12] - cx, o.vertices[v * 12 + 1] - y); if (d < bd) { bd = d; best = v; } }
            expect(bd, `row ${f}`).toBeLessThan(hY * 0.05);
            expect(o.vertices[best * 12 + 2], `row ${f}`).toBeGreaterThan(bb.max[2] - hZ * 0.3);   // the face front, not the under-jaw
        }
        // symmetric about the face centre
        let sx = 0; for (let v = 0; v < nv; v++) sx += o.vertices[v * 12] - cx;
        expect(Math.abs(sx / nv)).toBeLessThan(hX * 0.02);
    });
});
