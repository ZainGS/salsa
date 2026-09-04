import { describe, it, expect } from 'vitest';
import { generateRevolve, generateTube, FLOATS_PER_VERT } from './mesh-generators';

type G = ReturnType<typeof generateRevolve>;
const positions = (g: G): [number, number, number][] => {
    const out: [number, number, number][] = [];
    for (let i = 0; i < g.vertices.length; i += FLOATS_PER_VERT) out.push([g.vertices[i], g.vertices[i + 1], g.vertices[i + 2]]);
    return out;
};
const normalsOf = (g: G): [number, number, number][] => {
    const out: [number, number, number][] = [];
    for (let i = 0; i < g.vertices.length; i += FLOATS_PER_VERT) out.push([g.vertices[i + 3], g.vertices[i + 4], g.vertices[i + 5]]);
    return out;
};

describe('generateRevolve (surface of revolution)', () => {
    it('a constant-radius profile makes a tube — every point at r=0.5 (or an axis cap centre)', () => {
        const g = generateRevolve([[0.5, -0.5], [0.5, 0.5]], 16);
        expect(g.indices.length).toBeGreaterThan(0);
        for (const [x, , z] of positions(g)) {
            const r = Math.hypot(x, z);
            expect(r < 1e-6 || Math.abs(r - 0.5) < 1e-4).toBe(true);   // side rim r=0.5, cap centre r=0
        }
    });

    it('tessellation scales with segments (profile sets shape, segments set resolution)', () => {
        const a = generateRevolve([[0.5, -0.5], [0.5, 0.5]], 8);
        const b = generateRevolve([[0.5, -0.5], [0.5, 0.5]], 32);
        expect(b.vertices.length).toBeGreaterThan(a.vertices.length);
    });

    it('a profile ending at radius 0 is a sharp tip on the axis (no degenerate crash)', () => {
        const g = generateRevolve([[0.5, -0.5], [0, 0.5]], 12);
        expect(g.vertices.length).toBeGreaterThan(0);
        expect(positions(g).some(([x, y, z]) => Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6 && Math.abs(y - 0.5) < 1e-6)).toBe(true);
    });

    it('all normals are unit length (including a varying profile)', () => {
        const g = generateRevolve([[0.4, -0.5], [0.2, 0], [0.3, 0.5]], 10);
        for (const [nx, ny, nz] of normalsOf(g)) {
            expect(Math.abs(Math.hypot(nx, ny, nz) - 1)).toBeLessThan(1e-4);
        }
    });

    it('is deterministic for the same inputs', () => {
        const a = generateRevolve([[0.4, -0.5], [0.2, 0.5]], 12);
        const b = generateRevolve([[0.4, -0.5], [0.2, 0.5]], 12);
        expect([...a.vertices]).toEqual([...b.vertices]);
        expect([...a.indices]).toEqual([...b.indices]);
    });

    it('a degenerate profile (<2 points) returns empty geometry rather than crashing', () => {
        const g = generateRevolve([[0.5, 0]], 8);
        expect(g.vertices.length).toBe(0);
        expect(g.indices.length).toBe(0);
    });
});

describe('generateTube (loft / path sweep)', () => {
    it('a straight vertical path with constant radius is a tube at that radius', () => {
        const g = generateTube([[0, 0, 0], [0, 1, 0]], [0.3], 12);
        expect(g.indices.length).toBeGreaterThan(0);
        for (const [x, y, z] of positions(g)) {
            const r = Math.hypot(x, z);
            expect(r < 1e-6 || Math.abs(r - 0.3) < 1e-4).toBe(true);   // side ring r=0.3, cap centre r=0
            expect(y).toBeGreaterThanOrEqual(-1e-6);
            expect(y).toBeLessThanOrEqual(1 + 1e-6);
        }
    });

    it('per-point radii vary the thickness along the path', () => {
        const g = generateTube([[0, 0, 0], [0, 1, 0]], [0.4, 0.1], 8);
        const maxR = Math.max(...positions(g).map(([x, , z]) => Math.hypot(x, z)));
        expect(Math.abs(maxR - 0.4) < 1e-4).toBe(true);   // the widest ring is the 0.4 base
    });

    it('follows a curved path without producing NaNs (rotation-minimizing frame)', () => {
        const g = generateTube([[0, 0, 0], [0.5, 0.5, 0], [1, 0.5, 0.5]], [0.2, 0.15, 0.1], 10);
        expect(g.vertices.length).toBeGreaterThan(0);
        expect([...g.vertices].every(Number.isFinite)).toBe(true);
    });

    it('all normals are unit length', () => {
        const g = generateTube([[0, 0, 0], [0, 0.5, 0.2], [0, 1, 0]], [0.2, 0.15, 0.05], 10);
        for (const [nx, ny, nz] of normalsOf(g)) {
            expect(Math.abs(Math.hypot(nx, ny, nz) - 1)).toBeLessThan(1e-4);
        }
    });

    it('is deterministic + returns empty for a <2-point path', () => {
        const a = generateTube([[0, 0, 0], [0, 1, 0]], [0.2], 8);
        const b = generateTube([[0, 0, 0], [0, 1, 0]], [0.2], 8);
        expect([...a.vertices]).toEqual([...b.vertices]);
        expect(generateTube([[0, 0, 0]], [0.2], 8).vertices.length).toBe(0);
    });
});
