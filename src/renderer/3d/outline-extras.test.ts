import { describe, it, expect } from 'vitest';
import { OutlinePass, outlineFoliageCode } from './outline-pass';
import { OUTLINE_DEPTH_NORMAL_SHADER, OUTLINE_SOBEL_SHADER } from './shaders/outline-shaders';

// visual-polish #3: ink on foliage (leaf cards cut to their leaves in the pre-pass; foliage marked by a half-length
// normal; a silhouette-only / off mode in the Sobel pass) and the distance fade of CREASE ink (mid-range ledge dashes).
// WGSL only compiles in a browser — these pin the wiring and the uniform packing.

describe('outline pre-pass: foliage', () => {
    it('cuts leaf cards (bit 13) to the shared leaf silhouette and sways foliage (bit 19) like the colour pass', () => {
        expect(OUTLINE_DEPTH_NORMAL_SHADER).toMatch(/fn leafCardCoverage\(/);
        expect(OUTLINE_DEPTH_NORMAL_SHADER).toMatch(/\(mflags & 8192u\) != 0u && leafCardCoverage\(in\.uv\) < 0\.5\) \{ discard; \}/);
        expect(OUTLINE_DEPTH_NORMAL_SHADER).toMatch(/foliageWindOffset\(/);
        expect(OUTLINE_DEPTH_NORMAL_SHADER).toMatch(/@location\(2\) uv:/);
    });
    it('marks foliage (leaf cards + foliage shade) with a HALF-length normal, everything else unit length', () => {
        expect(OUTLINE_DEPTH_NORMAL_SHADER).toMatch(/8192u \| 1048576u/);
        expect(OUTLINE_DEPTH_NORMAL_SHADER).toMatch(/select\(0\.5, 0\.25, isFoliage\) \+ 0\.5/);
        // the Sobel side tells them apart by length (0.5 vs 1) and normalises before the crease dot
        expect(OUTLINE_SOBEL_SHADER).toMatch(/fn loadNormalF\(/);
        expect(OUTLINE_SOBEL_SHADER).toMatch(/l < 0\.75/);
    });
    it('the pipeline feeds the uv attribute at the mesh vertex uv offset', async () => {
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const src = readFileSync(fileURLToPath(new URL('./outline-pass.ts', import.meta.url)), 'utf8');
        expect(src).toMatch(/shaderLocation: 2, offset: 24, format: 'float32x2'/);
    });
});

describe('outline Sobel: modes + crease fade', () => {
    it('declares the extra vec4 after camEye and reads the foliage mode + crease fade from it', () => {
        expect(OUTLINE_SOBEL_SHADER).toMatch(/camEye:\s+vec4<f32>,[^\n]*\n\s+extra:\s+vec4<f32>/);
        expect(OUTLINE_SOBEL_SHADER).toMatch(/folMode == 2u && cFol/);
        expect(OUTLINE_SOBEL_SHADER).toMatch(/crease = folMode == 1u && cFol != nFol/);
        expect(OUTLINE_SOBEL_SHADER).toMatch(/params\.extra\.z > params\.extra\.y/);
    });
    it('foliage codes: full 0, silhouette 1, off 2 (absent / unknown = full)', () => {
        expect(outlineFoliageCode(undefined)).toBe(0);
        expect(outlineFoliageCode('full')).toBe(0);
        expect(outlineFoliageCode('silhouette')).toBe(1);
        expect(outlineFoliageCode('off')).toBe(2);
    });
    /** An OutlinePass without a GPU (only the param state + a fake queue). */
    function bare(): { p: OutlinePass; writes: Float32Array[] } {
        const writes: Float32Array[] = [];
        const p = Object.create(OutlinePass.prototype) as OutlinePass;
        Object.assign(p, { color: [0, 0, 0, 1], threshold: 2, fogCut: null, depthFade: null, fadeView: null, foliageMode: 0, creaseFade: null,
            _paramsScratch: new Float32Array(36), _paramsBuffer: {},
            device: { queue: { writeBuffer: (_b: unknown, _o: number, d: Float32Array) => writes.push(d.slice()) } } });
        return { p, writes };
    }
    it('setExtras validates; needsFadeView follows the depth OR the crease fade', () => {
        const { p } = bare();
        expect(p.needsFadeView).toBe(false);
        p.setExtras({ foliage: 'silhouette', creaseFade: { near: 1, far: 5 } });
        expect(p.foliageMode).toBe(1);
        expect(p.creaseFade).toEqual({ near: 1, far: 5, minAlpha: 0, thinPx: 0 });   // (thinPx: visual-polish #3b, absent = 0 = off)
        expect(p.needsFadeView).toBe(true);
        p.setExtras({ creaseFade: { near: 5, far: 1 } });
        expect(p.creaseFade).toBeNull();
        expect(p.foliageMode).toBe(0);
        p.setExtras(undefined);
        expect(p.needsFadeView).toBe(false);
    });
    it('packs extra = (mode, near, far, minAlpha) at floats 32-35, the eye + inverse VP for a crease fade alone; off = (0, 0, 0, 1)', () => {
        const { p, writes } = bare();
        p.updateParams();
        expect(Array.from(writes.pop()!.slice(32, 36))).toEqual([0, 0, 0, 1]);
        p.setExtras({ foliage: 'off', creaseFade: { near: 2, far: 9, minAlpha: 0.25 } });
        const inv = new Float32Array(16).map((_, i) => i + 1);
        p.fadeView = { eye: [7, 8, 9], invViewProj: inv };
        p.updateParams();
        const d = writes.pop()!;
        expect(Array.from(d.slice(32, 36))).toEqual([2, 2, 9, 0.25]);
        expect(Array.from(d.slice(28, 31))).toEqual([7, 8, 9]);
        expect(Array.from(d.slice(8, 24))).toEqual(Array.from(inv));
        expect(d[6]).toBe(0);   // no depth fade: its far stays 0 (off)
    });
});

describe('outline Sobel: thin creases (visual-polish #3b)', () => {
    function bare(): { p: OutlinePass; writes: Float32Array[] } {
        const writes: Float32Array[] = [];
        const p = Object.create(OutlinePass.prototype) as OutlinePass;
        Object.assign(p, { color: [0, 0, 0, 1], threshold: 2, fogCut: null, depthFade: null, fadeView: null, foliageMode: 0, creaseFade: null,
            _paramsScratch: new Float32Array(36), _paramsBuffer: {},
            device: { queue: { writeBuffer: (_b: unknown, _o: number, d: Float32Array) => writes.push(d.slice()) } } });
        return { p, writes };
    }
    it('thinPx is validated (2..4, rounded; below 2 / absent = 0 = off)', () => {
        const { p } = bare();
        p.setExtras({ creaseFade: { near: 1, far: 5, thinPx: 3 } }); expect(p.creaseFade?.thinPx).toBe(3);
        p.setExtras({ creaseFade: { near: 1, far: 5, thinPx: 9 } }); expect(p.creaseFade?.thinPx).toBe(4);
        p.setExtras({ creaseFade: { near: 1, far: 5, thinPx: 1 } }); expect(p.creaseFade?.thinPx).toBe(0);
        p.setExtras({ creaseFade: { near: 1, far: 5, thinPx: NaN } }); expect(p.creaseFade?.thinPx).toBe(0);
    });
    it('packs thinPx into camEye.w (float 31) with the crease fade; 0 without one', () => {
        const { p, writes } = bare();
        p.setExtras({ creaseFade: { near: 2, far: 9, thinPx: 3 } });
        p.fadeView = { eye: [1, 2, 3], invViewProj: new Float32Array(16) };
        p.updateParams();
        expect(writes.pop()![31]).toBe(3);
        p.setExtras({});
        p.updateParams();
        expect(writes.pop()![31]).toBe(0);
    });
    it('the Sobel pass drops thin creases past the crease-fade near distance unless the depth steps', () => {
        expect(OUTLINE_SOBEL_SHADER).toMatch(/fn creaseThick\(/);
        expect(OUTLINE_SOBEL_SHADER).toMatch(/fn eyeDist\(/);
        expect(OUTLINE_SOBEL_SHADER).toMatch(/let thinOn = thinPx >= 2 && params\.extra\.z > params\.extra\.y && cDist > params\.extra\.y;/);
        expect(OUTLINE_SOBEL_SHADER).toMatch(/crease = abs\(eyeDist\(nc\) - cDist\) > cDist \* 0\.04;/);
    });
});
