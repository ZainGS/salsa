import { describe, it, expect } from 'vitest';
import { hammersley, importanceSampleGGX, prefilterColor, integrateBRDF, generateBRDFLUT, cubeFaceTexelDir } from './ibl-prefilter';
import { evaluateSkyColor, DEFAULT_SKY } from './procedural-sky';

const unit = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);

describe('hammersley', () => {
    it('first point is the origin', () => {
        expect(hammersley(0, 16)).toEqual([0, 0]);
    });
    it('all points lie in [0,1)', () => {
        for (let i = 0; i < 64; i++) {
            const [a, b] = hammersley(i, 64);
            expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThan(1);
            expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(1);
        }
    });
});

describe('importanceSampleGGX', () => {
    const N: [number, number, number] = [0, 0, 1];
    it('returns unit vectors', () => {
        for (let i = 0; i < 16; i++) {
            const h = importanceSampleGGX(hammersley(i, 16), 0.5, N);
            expect(unit(h)).toBeCloseTo(1, 5);
        }
    });
    it('collapses to the normal at roughness→0', () => {
        const h = importanceSampleGGX(hammersley(5, 16), 0.001, N);
        expect(h[2]).toBeCloseTo(1, 3);   // aligned with N (+Z)
    });
    it('spreads away from the normal at high roughness', () => {
        let maxTilt = 0;
        for (let i = 0; i < 32; i++) maxTilt = Math.max(maxTilt, 1 - importanceSampleGGX(hammersley(i, 32), 1.0, N)[2]);
        expect(maxTilt).toBeGreaterThan(0.2);   // some samples tilt well off-axis
    });
});

describe('integrateBRDF', () => {
    it('returns (scale, bias) in [0,1]', () => {
        for (const r of [0.1, 0.4, 0.7, 1.0]) {
            for (const nv of [0.1, 0.5, 1.0]) {
                const [A, B] = integrateBRDF(nv, r, 128);
                expect(A).toBeGreaterThanOrEqual(0); expect(A).toBeLessThanOrEqual(1.01);
                expect(B).toBeGreaterThanOrEqual(0); expect(B).toBeLessThanOrEqual(1.01);
            }
        }
    });
    it('approaches scale≈1, bias≈0 at low roughness + normal incidence', () => {
        const [A, B] = integrateBRDF(1.0, 0.02, 256);
        expect(A).toBeGreaterThan(0.95);
        expect(B).toBeLessThan(0.05);
    });
});

describe('generateBRDFLUT', () => {
    it('produces a size×size×2 table', () => {
        const lut = generateBRDFLUT(8, 64);
        expect(lut.length).toBe(8 * 8 * 2);
        for (const v of lut) expect(Number.isFinite(v)).toBe(true);
    });
});

describe('prefilterColor', () => {
    const sunDir: [number, number, number] = [0, 1, 0];
    const sample = (d: [number, number, number]) => evaluateSkyColor(d, { ...DEFAULT_SKY, sunColor: [0, 0, 0], sunHalo: 0 }, sunDir);

    it('at roughness 0 returns the mirror sample', () => {
        const R: [number, number, number] = [0.3, 0.8, 0.1];
        const c = prefilterColor(sample, R, 0, 64);
        const direct = sample([0.3, 0.8, 0.1]);
        expect(c[0]).toBeCloseTo(direct[0], 5);
        expect(c[2]).toBeCloseTo(direct[2], 5);
    });
    it('blurs toward the local average at high roughness (differs from the mirror sample)', () => {
        const R: [number, number, number] = [1, 0, 0];   // at the horizon
        const mirror = sample([1, 0, 0]);
        const blurred = prefilterColor(sample, R, 0.9, 128);
        // A rough reflection at the horizon pulls in zenith/ground → blue channel shifts measurably.
        expect(Math.abs(blurred[2] - mirror[2])).toBeGreaterThan(0.01);
    });
    it('stays finite and non-negative', () => {
        const c = prefilterColor(sample, [0, 1, 0], 0.5, 64);
        for (const v of c) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); }
    });
});

describe('cubeFaceTexelDir', () => {
    it('face centers point down the expected axes', () => {
        expect(cubeFaceTexelDir(0, 0.5, 0.5)).toEqual([1, -0, -0]);   // +X
        expect(cubeFaceTexelDir(2, 0.5, 0.5)[1]).toBeCloseTo(1, 5);   // +Y
        expect(cubeFaceTexelDir(4, 0.5, 0.5)[2]).toBeCloseTo(1, 5);   // +Z
        expect(cubeFaceTexelDir(5, 0.5, 0.5)[2]).toBeCloseTo(-1, 5);  // -Z
    });
    it('returns unit vectors across the face', () => {
        for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]] as const) {
            expect(unit(cubeFaceTexelDir(0, u, v))).toBeCloseTo(1, 5);
        }
    });
});
