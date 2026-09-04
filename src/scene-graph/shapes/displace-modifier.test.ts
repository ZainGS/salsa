import { describe, it, expect } from 'vitest';
import { DisplaceModifier, type EditMeshData } from './edit-mesh';

/** A flat 2×2 grid of quads on the XZ plane (9 vertices) — enough surface to displace meaningfully. */
function grid(): EditMeshData {
    const vertices = [];
    for (let z = 0; z <= 2; z++) for (let x = 0; x <= 2; x++) {
        vertices.push({ x: x - 1, y: 0, z: z - 1, color: [1, 1, 1, 1] as [number, number, number, number] });
    }
    const faces = [];
    for (let z = 0; z < 2; z++) for (let x = 0; x < 2; x++) {
        const a = z * 3 + x;
        faces.push({ verts: [a, a + 1, a + 4, a + 3] });   // CCW quad
    }
    return { vertices, faces, uvs: vertices.map(() => [0, 0] as [number, number]) };
}

describe('DisplaceModifier', () => {
    it('strength 0 is the identity (no displacement)', () => {
        const m = grid();
        const out = new DisplaceModifier({ strength: 0 }).apply(m);
        out.vertices.forEach((v, i) => {
            expect(v.x).toBeCloseTo(m.vertices[i].x, 10);
            expect(v.y).toBeCloseTo(m.vertices[i].y, 10);
            expect(v.z).toBeCloseTo(m.vertices[i].z, 10);
        });
    });

    it('displaces the flat grid along its normal (the Y axis moves)', () => {
        const out = new DisplaceModifier({ strength: 0.5, frequency: 1, seed: 1 }).apply(grid());
        const movedY = out.vertices.some(v => Math.abs(v.y) > 1e-6);
        expect(movedY).toBe(true);
    });

    it("direction: 'y' pushes ONLY along Y", () => {
        const m = grid();
        const out = new DisplaceModifier({ strength: 0.5, direction: 'y', seed: 2 }).apply(m);
        out.vertices.forEach((v, i) => {
            expect(v.x).toBeCloseTo(m.vertices[i].x, 10);   // X untouched
            expect(v.z).toBeCloseTo(m.vertices[i].z, 10);   // Z untouched
        });
        expect(out.vertices.some((v, i) => Math.abs(v.y - m.vertices[i].y) > 1e-6)).toBe(true);
    });

    it('is deterministic for the same seed, and different seeds differ', () => {
        const a = new DisplaceModifier({ strength: 0.5, seed: 7 }).apply(grid());
        const b = new DisplaceModifier({ strength: 0.5, seed: 7 }).apply(grid());
        const c = new DisplaceModifier({ strength: 0.5, seed: 8 }).apply(grid());
        expect(a.vertices.map(v => v.y)).toEqual(b.vertices.map(v => v.y));
        expect(a.vertices.map(v => v.y)).not.toEqual(c.vertices.map(v => v.y));
    });

    it('toJSON round-trips its params (for save/reload)', () => {
        const json = new DisplaceModifier({ strength: 0.3, frequency: 2, seed: 5, octaves: 3, direction: 'x' }).toJSON();
        expect(json).toEqual({ type: 'displace', enabled: true, strength: 0.3, frequency: 2, seed: 5, octaves: 3, direction: 'x' });
    });
});
