import { describe, it, expect, beforeAll } from 'vitest';
import { DITHER_ALGORITHMS, DitherEngine, HALFTONE_SHAPES, halftoneShapeIndex, isHalftoneAlgorithm } from './dither-engine';
import { RasterManager } from '../../../services/managers/raster-manager';

// Halftone screen shapes (2026-10-08). The shapes themselves are pixel-checked on real D3D12 through the Dawn-node
// harness (contact sheet + dot / line / diamond byte-identical to the previous engine); this covers the config surface
// and the shader source the engine builds.

const NEW_ALGORITHMS = [
    'halftone_square', 'halftone_cross', 'halftone_ellipse', 'halftone_wavy', 'halftone_crosshatch', 'halftone_rings',
    'halftone_spiral', 'halftone_hexagon', 'halftone_star', 'halftone_heart', 'halftone_triangle',
] as const;

describe('Halftone shapes: algorithm values', () => {
    it('the saved algorithms keep their shader indices (dot 0, line 1, diamond 2)', () => {
        expect(halftoneShapeIndex('halftone_dot')).toBe(0);
        expect(halftoneShapeIndex('halftone_line')).toBe(1);
        expect(halftoneShapeIndex('halftone_diamond')).toBe(2);
    });

    it('every new algorithm is accepted (GPU ordered, listed) and maps to its own index', () => {
        const seen = new Set<number>([0, 1, 2]);
        for (const a of NEW_ALGORITHMS) {
            expect(isHalftoneAlgorithm(a)).toBe(true);
            expect(DitherEngine.isErrorDiffusion(a)).toBe(false);
            expect(DITHER_ALGORITHMS).toContain(a);
            const i = halftoneShapeIndex(a);
            expect(i).toBeGreaterThan(2);
            expect(seen.has(i)).toBe(false);
            seen.add(i);
        }
        expect(seen.size).toBe(HALFTONE_SHAPES.length);
    });

    it('non-halftone algorithms are -1; an unknown future shape falls back to Dot', () => {
        for (const a of ['bayer', 'blue_noise', 'noise', 'floyd_steinberg']) {
            expect(isHalftoneAlgorithm(a)).toBe(false);
            expect(halftoneShapeIndex(a)).toBe(-1);
        }
        expect(halftoneShapeIndex('halftone_moon')).toBe(0);
    });

    it('the managers expose the full list (hosts feature-detect shapes against it)', () => {
        expect(RasterManager.DitherAlgorithms).toEqual([...DITHER_ALGORITHMS]);
        expect(DITHER_ALGORITHMS.slice(0, 4)).toEqual(['bayer', 'halftone_dot', 'halftone_line', 'halftone_diamond']);
        expect(DITHER_ALGORITHMS.filter(a => DitherEngine.isErrorDiffusion(a))).toHaveLength(6);
    });
});

describe('Halftone shapes: shader source', () => {
    let code = '';
    beforeAll(() => {
        const g = globalThis as unknown as Record<string, unknown>;
        g.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 };
        g.GPUShaderStage ??= { COMPUTE: 0x4 };
        const stub = () => ({});
        const device = {
            createBuffer: stub, createBindGroupLayout: stub, createPipelineLayout: stub, createComputePipeline: stub,
            createShaderModule: (d: { code: string }) => { code = d.code; return {}; },
        };
        (new DitherEngine(device as unknown as GPUDevice) as unknown as { ensureHalftonePipeline(): void }).ensureHalftonePipeline();
    });

    it('the halftone switch has a case for every shape index (diamond = case 2 via default)', () => {
        for (let i = 0; i < HALFTONE_SHAPES.length; i++) {
            if (i === 2) continue;
            expect(code).toContain(`case ${i}: {`);
        }
        expect(code).toContain('default: {');
    });

    it('the dropout helpers are shape-aware (hexagon drops honeycomb cells)', () => {
        expect(code).toMatch(/halftoneCell\(px, py, angle, freq, texW, texH, shape\)/);
        expect(code).toMatch(/halftoneCellCenterPx\(cell, angle, freq, texW, texH, shape\)/);
    });

    it('cells keep one scale on x and y (no texW / texH aspect factor)', () => {
        expect(code).not.toMatch(/\* \(texW \/ texH\)/);
    });
});
