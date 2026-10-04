import { describe, it, expect } from 'vitest';
import { MoverBlobBuffer, moverFootprint, blobHalfExtents, MOVER_BLOB_SKIP } from './mover-shadows';

// visual-polish #16: the moving contact blobs (pure half). Vertex layout = contactShadowLayer's 12 floats.
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Float32Array => {
    const v: number[] = [];
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) v.push(x, y, z, 0, 1, 0, 0, 0, 1, 0, 0, 1);
    return new Float32Array(v);
};

describe('moverFootprint', () => {
    it('is the local box of the LOWER part (an umbrella or pantograph does not widen it)', () => {
        const body = box(-2, 2, 0, 1.4, -0.8, 0.8);
        const umbrella = box(-3, 3, 1.9, 2.0, -3, 3);   // above 55 % of the height → ignored
        const f = moverFootprint([{ vertices: body }, { vertices: umbrella }])!;
        expect(f.a).toBeCloseTo(2); expect(f.b).toBeCloseTo(0.8);
        expect(f.cx).toBeCloseTo(0); expect(f.cz).toBeCloseTo(0); expect(f.y0).toBeCloseTo(0);
    });
    it('applies each part scale; null without vertices', () => {
        const f = moverFootprint([{ vertices: box(-1, 3, 0, 1, -1, 1), scale: 2 }])!;
        expect(f.cx).toBeCloseTo(2); expect(f.a).toBeCloseTo(4);
        expect(moverFootprint([])).toBeNull();
    });
    it('skips the emote / headlight pool / glow layers by name', () => {
        expect(MOVER_BLOB_SKIP.test('world:traffic-headlight-pool')).toBe(true);
        expect(MOVER_BLOB_SKIP.test('world:traffic-emote')).toBe(true);
        expect(MOVER_BLOB_SKIP.test('world:traffic-car')).toBe(false);
    });
});

describe('blobHalfExtents', () => {
    const o = { spread: 1.5, minBlob: 0.4, maxHalf: 3, lift: 0 };
    it('a thin walker gets the round minimum, a car an oval, a long train car the cap', () => {
        expect(blobHalfExtents({ cx: 0, cz: 0, a: 0.1, b: 0.1, y0: 0 }, o)).toEqual([0.4, 0.4]);
        const [a, b] = blobHalfExtents({ cx: 0, cz: 0, a: 2, b: 0.8, y0: 0 }, o);
        expect(a).toBeCloseTo(3); expect(b).toBeCloseTo(1.35);
        expect(blobHalfExtents({ cx: 0, cz: 0, a: 9, b: 1, y0: 0 }, o)[0]).toBeCloseTo(4.5);
    });
});

describe('MoverBlobBuffer', () => {
    const B = [-10, -1, -10, 10, 1, 10];
    it('allocates n quads + 2 bounds anchors (never indexed) and starts every quad collapsed', () => {
        const b = new MoverBlobBuffer(3, B);
        expect(b.vertices.length).toBe((3 * 4 + 2) * 12);
        expect(b.indices.length).toBe(18);
        expect(Math.max(...b.indices)).toBe(11);   // the anchors (12, 13) are in no triangle
        const a1 = 13 * 12;
        expect([b.vertices[a1], b.vertices[a1 + 1], b.vertices[a1 + 2]]).toEqual([10, 1, 10]);
        expect(b.shown(0)).toBe(false);
        expect(b.takeDirty()).toBeNull();
    });
    it('set writes the oriented quad (yaw: local X → (cos, −sin)), up normals + radial UVs, and reports changes', () => {
        const b = new MoverBlobBuffer(2, B);
        expect(b.set(1, 1, 0.5, 2, Math.PI / 2, 2, 1)).toBe(true);
        expect(b.set(1, 1, 0.5, 2, Math.PI / 2, 2, 1)).toBe(false);   // unchanged → not rewritten
        const v = b.vertices, q = 4 * 12;
        // corner 0 = −a·X − b·Z; with yaw 90° local X = (0, −1), local Z = (1, 0)
        expect(v[q]).toBeCloseTo(1 - 1); expect(v[q + 2]).toBeCloseTo(2 + 2); expect(v[q + 1]).toBe(0.5);
        expect(v[q + 4]).toBe(1);
        expect([v[q + 6], v[q + 7], v[q + 12 + 6], v[q + 24 + 7]]).toEqual([0, 0, 1, 1]);
        expect(b.takeDirty()).toEqual([4, 4]);
        expect(b.takeDirty()).toBeNull();
    });
    it('the local centre offset is rotated with the yaw', () => {
        const b = new MoverBlobBuffer(1, B);
        b.set(0, 0, 0, 0, 0, 1, 1, 2, 0);
        const v = b.vertices;
        const cx = (v[0] + v[12] + v[24] + v[36]) / 4;
        expect(cx).toBeCloseTo(2);
    });
    it('hide collapses a quad to a point (zero area) and the dirty range spans the touched quads', () => {
        const b = new MoverBlobBuffer(4, B);
        b.set(0, 0, 0, 0, 0, 1, 1); b.set(3, 5, 0, 5, 0, 1, 1); b.takeDirty();
        expect(b.hide(0)).toBe(true); expect(b.hide(0)).toBe(false);
        const v = b.vertices;
        for (let k = 1; k < 4; k++) { expect(v[k * 12]).toBe(v[0]); expect(v[k * 12 + 2]).toBe(v[2]); }
        b.set(2, 1, 0, 1, 0, 1, 1);
        expect(b.takeDirty()).toEqual([0, 12]);   // quads 0..2 → vertices 0..11
        expect(b.shown(0)).toBe(false); expect(b.shown(3)).toBe(true);
    });
});
