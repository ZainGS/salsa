import { describe, it, expect } from 'vitest';
import { bakePrefilteredCube, bakeBRDFLUTBytes, cubeMipCount } from './ibl-specular-bake';
import { DEFAULT_SKY } from './procedural-sky';

const SUN: [number, number, number] = [0, 1, 0];

describe('bakePrefilteredCube', () => {
    it('produces 6 faces per mip, with halving sizes and opaque alpha', () => {
        const baked = bakePrefilteredCube(DEFAULT_SKY, SUN, 8, 4, 16);
        expect(baked.length).toBe(6 * 4);
        const mip0 = baked.filter(b => b.mip === 0);
        expect(mip0.length).toBe(6);
        expect(mip0[0].size).toBe(8);
        expect(baked.find(b => b.mip === 1)!.size).toBe(4);
        expect(baked.find(b => b.mip === 3)!.size).toBe(1);
        for (const b of baked) {
            expect(b.data.length).toBe(b.size * b.size * 4);
            expect(b.data[3]).toBe(255);
        }
    });

    it('covers all six face indices', () => {
        const baked = bakePrefilteredCube(DEFAULT_SKY, SUN, 4, 2, 8);
        const faces = new Set(baked.map(b => b.face));
        expect([...faces].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('the +Y (up) face is bluer than the -Y (down) face at mip 0', () => {
        const sky = { ...DEFAULT_SKY, sunColor: [0, 0, 0] as [number, number, number], sunHalo: 0 };
        const baked = bakePrefilteredCube(sky, SUN, 4, 1, 8);
        const up = baked.find(b => b.face === 2)!;    // +Y
        const down = baked.find(b => b.face === 3)!;   // -Y
        const avgB = (d: Uint8ClampedArray) => { let s = 0; for (let i = 2; i < d.length; i += 4) s += d[i]; return s / (d.length / 4); };
        expect(avgB(up.data)).toBeGreaterThan(avgB(down.data));
    });
});

describe('bakeBRDFLUTBytes', () => {
    it('produces size×size RGBA with blue=0, alpha=255', () => {
        const lut = bakeBRDFLUTBytes(8, 32);
        expect(lut.length).toBe(8 * 8 * 4);
        for (let i = 0; i < 8 * 8; i++) {
            expect(lut[i * 4 + 2]).toBe(0);
            expect(lut[i * 4 + 3]).toBe(255);
        }
    });
});

describe('cubeMipCount', () => {
    it('counts mips down to 1×1', () => {
        expect(cubeMipCount(1)).toBe(1);
        expect(cubeMipCount(32)).toBe(6);   // 32,16,8,4,2,1
        expect(cubeMipCount(64)).toBe(7);
    });
});
