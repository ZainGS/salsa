import { describe, it, expect } from 'vitest';
import { contactFootprints, contactShadowLayer, withContactShadows, CONTACT_SHADOW_LAYERS } from './contact-shadows';
import type { LayoutPreviewLayer } from './types';

/** An axis-aligned box as a 12-float indexed mesh (8 corners, 12 triangles). */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, into?: { v: number[]; i: number[] }): { v: number[]; i: number[] } {
    const acc = into ?? { v: [], i: [] };
    const b = acc.v.length / 12;
    for (let k = 0; k < 8; k++) acc.v.push(k & 1 ? x1 : x0, k & 2 ? y1 : y0, k & 4 ? z1 : z0, 0, 1, 0, 0, 0, 1, 0, 0, 1);
    const f = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
    for (const [a, c, d, e] of f) acc.i.push(b + a, b + c, b + d, b + a, b + d, b + e);
    return acc;
}
const layer = (name: string, acc: { v: number[]; i: number[] }): LayoutPreviewLayer =>
    ({ name, color: [1, 1, 1], y: 0, geometry: { vertices: new Float32Array(acc.v), indices: new Uint32Array(acc.i), format: '12float' } }) as LayoutPreviewLayer;

describe('contact shadows (persona-polish A3)', () => {
    it('only grounds eligible layers (people, parked cars, street props) — never wires, glass or signs', () => {
        for (const n of ['world:ped-navy', 'world:car-white', 'world:car-taxi', 'world:bench', 'world:vending-body', 'world:trash']) expect(CONTACT_SHADOW_LAYERS.test(n)).toBe(true);
        for (const n of ['world:util-wire', 'world:car-glass2', 'world:car-sign', 'world:sign-a', 'world:roads']) expect(CONTACT_SHADOW_LAYERS.test(n)).toBe(false);
    });
    it('merges the stacked parts of one object (legs + torso + head) into ONE footprint, separate objects stay separate', () => {
        const a = box(0, 0, 0, 0.2, 0.8, 0.2);         // legs
        box(-0.05, 0.8, -0.05, 0.25, 1.4, 0.25, a);     // torso (overlaps in plan)
        box(0.05, 1.4, 0.05, 0.15, 1.6, 0.15, a);       // head
        box(3, 0, 3, 3.2, 1.6, 3.2, a);                 // another person far away
        const fps = contactFootprints([layer('world:ped-navy', a)]);
        expect(fps.length).toBe(2);
        const near = fps.find((f) => f.x < 1)!;
        expect(near.y).toBeCloseTo(0);                  // the blob sits at the feet
        expect(near.x).toBeCloseTo(0.1, 1); expect(near.z).toBeCloseTo(0.1, 1);
    });
    it('a car on a diagonal street gets a diagonal (principal-axis) footprint', () => {
        // A 4 x 1.8 "car" made of points rotated 45 degrees.
        const acc = { v: [] as number[], i: [] as number[] };
        const c = Math.SQRT1_2;
        const pts: [number, number][] = [];
        for (let u = -2; u <= 2; u += 0.5) for (const w of [-0.9, 0.9]) pts.push([u * c - w * c, u * c + w * c]);
        for (const [x, z] of pts) acc.v.push(x, 0, z, 0, 1, 0, 0, 0, 1, 0, 0, 1);
        for (let k = 0; k + 2 < pts.length; k++) acc.i.push(k, k + 1, k + 2);
        const [f] = contactFootprints([layer('world:car-red', acc)]);
        expect(f.a).toBeGreaterThan(1.8);
        expect(Math.abs(Math.abs(Math.cos(f.angle)) - c)).toBeLessThan(0.05);
    });
    it('instanced layers stamp the canonical footprint per instance', () => {
        const L = layer('world:bench', box(-0.5, 0, -0.2, 0.5, 0.45, 0.2));
        (L as unknown as { instances: unknown[] }).instances = [{ x: 5, y: 1, z: 2, ry: 0 }, { x: -3, y: 0, z: 0, ry: Math.PI / 2 }];
        const fps = contactFootprints([L]);
        expect(fps.length).toBe(2);
        expect(fps[0].x).toBeCloseTo(5); expect(fps[0].y).toBeCloseTo(1);
        expect(fps[1].x).toBeCloseTo(-3);
    });
    it('the blob layer is a transparent radial-fade quad per footprint, and withContactShadows is a no-op without eligible layers', () => {
        const L = contactShadowLayer([{ x: 0, z: 0, y: 0, a: 1, b: 0.5, angle: 0 }], { lift: 0.01, opacity: 0.5 })!;
        expect(L.geometry.indices.length).toBe(6);
        expect(L.radialFade).toBe(true); expect(L.opacity).toBe(0.5);
        expect(L.geometry.vertices[1]).toBeCloseTo(0.01);
        const roads = [layer('world:roads', box(0, 0, 0, 1, 0.1, 1))];
        expect(withContactShadows(roads)).toBe(roads);
        expect(withContactShadows([layer('world:ped-navy', box(0, 0, 0, 0.3, 1.6, 0.3))]).length).toBe(2);
    });
});
