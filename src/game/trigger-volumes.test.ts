import { describe, it, expect } from 'vitest';
import { pointInShape, TriggerVolumeSystem, type TriggerVolume, type Vec3 } from './trigger-volumes';

describe('pointInShape', () => {
    it('box AABB inclusive containment', () => {
        const box = { kind: 'box' as const, min: [0, 0, 0] as Vec3, max: [2, 2, 2] as Vec3 };
        expect(pointInShape([1, 1, 1], box)).toBe(true);
        expect(pointInShape([0, 0, 0], box)).toBe(true);   // inclusive edge
        expect(pointInShape([2, 2, 2], box)).toBe(true);
        expect(pointInShape([3, 1, 1], box)).toBe(false);
        expect(pointInShape([1, -0.01, 1], box)).toBe(false);
    });
    it('sphere containment', () => {
        const s = { kind: 'sphere' as const, center: [0, 0, 0] as Vec3, radius: 2 };
        expect(pointInShape([1, 1, 1], s)).toBe(true);       // dist √3 < 2
        expect(pointInShape([2, 0, 0], s)).toBe(true);        // on the surface
        expect(pointInShape([2, 2, 0], s)).toBe(false);       // dist √8 > 2
    });
});

describe('TriggerVolumeSystem', () => {
    const box: TriggerVolume = { id: 'zone', shape: { kind: 'box', min: [0, 0, 0], max: [2, 2, 2] } };

    it('fires enter then exit on edges only (not every frame)', () => {
        const sys = new TriggerVolumeSystem();
        sys.setVolumes([box]);
        expect(sys.update([5, 1, 1])).toEqual([]);              // outside → nothing
        expect(sys.update([1, 1, 1])).toEqual([{ type: 'enter', id: 'zone' }]); // crossed in
        expect(sys.update([1.5, 1, 1])).toEqual([]);            // still inside → no repeat
        expect(sys.update([5, 1, 1])).toEqual([{ type: 'exit', id: 'zone' }]);  // crossed out
        expect(sys.update([6, 1, 1])).toEqual([]);              // still outside → nothing
    });

    it('a `once` volume fires enter a single time even across re-entry', () => {
        const sys = new TriggerVolumeSystem();
        sys.setVolumes([{ id: 'pickup', shape: box.shape, once: true }]);
        expect(sys.update([1, 1, 1])).toEqual([{ type: 'enter', id: 'pickup' }]);
        expect(sys.update([5, 1, 1])).toEqual([{ type: 'exit', id: 'pickup' }]);
        expect(sys.update([1, 1, 1])).toEqual([]);   // re-enter suppressed (already consumed)
    });

    it('containing() lists every volume under the point', () => {
        const sys = new TriggerVolumeSystem();
        sys.setVolumes([
            box,
            { id: 'sphere', shape: { kind: 'sphere', center: [1, 1, 1], radius: 3 } },
            { id: 'far', shape: { kind: 'box', min: [50, 0, 0], max: [52, 2, 2] } },
        ]);
        expect(sys.containing([1, 1, 1]).sort()).toEqual(['sphere', 'zone']);
        expect(sys.containing([51, 1, 1])).toEqual(['far']);
    });

    it('reset() clears enter/exit + one-shot memory', () => {
        const sys = new TriggerVolumeSystem();
        sys.setVolumes([{ id: 'pickup', shape: box.shape, once: true }]);
        sys.update([1, 1, 1]);          // consumed
        sys.reset();
        expect(sys.update([1, 1, 1])).toEqual([{ type: 'enter', id: 'pickup' }]);   // fires again after reset
    });

    it('reuses a provided out array', () => {
        const sys = new TriggerVolumeSystem();
        sys.setVolumes([box]);
        const out: { type: 'enter' | 'exit'; id: string }[] = [];
        sys.update([1, 1, 1], out);
        expect(out).toEqual([{ type: 'enter', id: 'zone' }]);
        sys.update([1.2, 1, 1], out);
        expect(out).toEqual([]);        // cleared, no stale entries
    });
});
