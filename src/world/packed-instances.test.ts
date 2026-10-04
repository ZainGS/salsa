import { describe, it, expect } from 'vitest';
import { packInstances, unpackInstances, slicePacked, packLayerInstances, unpackLayerInstances, layerInstanceCount } from './packed-instances';

describe('packed instances (step 3b)', () => {
    it('round-trips every number exactly, keeps absent keys absent and arrays their length', () => {
        const list = [
            { x: 1.5, y: -0, z: 1e-300, ry: Math.PI },
            { x: NaN, y: 2, z: 3, ry: 0, s: 1.25, tint: [0.1, 0.2, 0.3] },
            { x: -7, y: 8, z: 9, ry: -1, sv: [1, 2, 3], cs: [4, 5, 6], pi: 12 },
            { x: 0, y: 0, z: 0, ry: 0, tint: [1, 1, 1], pi: 0 },
        ];
        const p = packInstances(list)!;
        expect(p).not.toBeNull();
        const back = unpackInstances(p);
        expect(back).toEqual(list);
        expect(Object.is(back[0].y, -0)).toBe(true);
        expect(Number.isNaN(back[1].x as number)).toBe(true);
        expect('s' in back[0]).toBe(false);
        expect(unpackInstances(slicePacked(p, 1, 3))).toEqual(list.slice(1, 3));
    });
    it('does not pack strings / booleans / mixed widths; packs a layer in place and back', () => {
        expect(packInstances([{ x: 1, skin: 'a' }])).toBeNull();
        expect(packInstances([{ x: 1, tint: [1, 2, 3] }, { x: 2, tint: [1, 2] }])).toBeNull();
        expect(packInstances([{ x: 1, f: true }])).toBeNull();
        const inst = [{ x: 1, y: 2, z: 3, ry: 4 }, { x: 5, y: 6, z: 7, ry: 8, s: 2 }];
        const L: { instances?: object[]; instPacked?: ReturnType<typeof packInstances> & object } = { instances: inst };
        const bufs = packLayerInstances(L)!;
        expect(bufs.length).toBe(2);
        expect(L.instances).toBeUndefined();
        expect(layerInstanceCount(L as never)).toBe(2);
        unpackLayerInstances(L as never);
        expect(L.instPacked).toBeUndefined();
        expect(L.instances).toEqual(inst);
        expect(inst.length).toBe(2);   // the source list itself is never touched
    });
});
