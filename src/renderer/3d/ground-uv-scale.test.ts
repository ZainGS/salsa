import { describe, it, expect } from 'vitest';
import { groundUvWorldScale, GROUND_UV_SCALE_MARKER } from './ground-uv-scale';
import { generatePlane } from './mesh-generators';
import * as mesh3d from './shaders/mesh3d-shaders';

// Bug 2026-09-29: procedural-ground grout rendered as speckled noise that shimmered (worse zoomed in) because the
// shader derived metres-per-uv PER PIXEL from f32 screen derivatives. The scale is a per-mesh constant for an affine
// uv mapping, so it's now computed here once and passed in.

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const scaleM = (sx: number, sy: number, sz: number) => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 5, 6, 7, 1];

/** A flat quad in XZ whose uv = worldXZ * k (the city ground parameterisation), spanning `size` units. */
function worldUvQuad(size: number, k: number) {
    const P = [[0, 0], [size, 0], [size, size], [0, size]];
    const vertices = new Float32Array(4 * 12);
    P.forEach(([x, z], i) => { vertices.set([x, 0, z, 0, 1, 0, x * k, z * k, 1, 0, 0, 1], i * 12); });
    return { vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}

describe('groundUvWorldScale', () => {
    it('a W×D plane with 0..1 uv → [W, D] world units per uv (anisotropic kept apart)', () => {
        const s = groundUvWorldScale(generatePlane(20, 8, 4, 4), I)!;
        expect(s[0]).toBeCloseTo(20, 4);
        expect(s[1]).toBeCloseTo(8, 4);
    });
    it('follows the model matrix scale (translation ignored)', () => {
        const s = groundUvWorldScale(generatePlane(2, 2, 1, 1), scaleM(3, 1, 0.5))!;
        expect(s[0]).toBeCloseTo(6, 4);
        expect(s[1]).toBeCloseTo(1, 4);
    });
    it('the city ground (uv = worldXZ × 0.5) → exactly 2 units per uv, however far from the origin', () => {
        const s = groundUvWorldScale(worldUvQuad(400, 0.5), I)!;
        expect(s[0]).toBeCloseTo(2, 6);
        expect(s[1]).toBeCloseTo(2, 6);
    });
    it('degenerate uv → null (the shader keeps its per-pixel estimate)', () => {
        const q = worldUvQuad(1, 0.5);
        for (let i = 0; i < 4; i++) { q.vertices[i * 12 + 6] = 0.3; q.vertices[i * 12 + 7] = 0.3; }
        expect(groundUvWorldScale(q, I)).toBeNull();
        expect(groundUvWorldScale({ vertices: new Float32Array(0), indices: new Uint32Array(0) }, I)).toBeNull();
    });
});

describe('the ground shader uses the CPU scale', () => {
    const shaders = Object.values(mesh3d).filter((v): v is string => typeof v === 'string');
    it('every shader variant with a ground branch switches to uvTransform.xy when the marker is present', () => {
        const withGround = shaders.filter((s) => s.includes('let gUvMs'));
        expect(withGround.length).toBeGreaterThan(0);
        for (const s of withGround) {
            const branches = (s.match(/let gUvMs/g) ?? []).length;
            const fixed = (s.match(/let gUvMw = select\(gUvM, inst\.uvTransform\.xy, inst\.uvTransform\.z < -12000\.0\);/g) ?? []).length;
            expect(fixed).toBe(branches);
            expect(s).not.toMatch(/let gUvMs = gUvM \* gUnitM;/);
        }
        expect(GROUND_UV_SCALE_MARKER).toBeLessThan(-12000);
    });
});
