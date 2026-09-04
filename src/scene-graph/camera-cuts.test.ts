import { describe, it, expect } from 'vitest';
import { activeCameraAt, setCut, removeCut, pruneCuts, type CameraCut } from './camera-cuts';

describe('camera-cuts — activeCameraAt (step)', () => {
    const cuts: CameraCut[] = [{ frame: 0, cameraId: 'a' }, { frame: 60, cameraId: 'b' }, { frame: 120, cameraId: 'c' }];

    it('null before the first cut / on an empty track', () => {
        expect(activeCameraAt([], 10)).toBeNull();
        expect(activeCameraAt([{ frame: 30, cameraId: 'a' }], 10)).toBeNull();
    });
    it('returns the camera of the last cut at or before the frame', () => {
        expect(activeCameraAt(cuts, 0)).toBe('a');
        expect(activeCameraAt(cuts, 30)).toBe('a');     // between 0 and 60 → still a
        expect(activeCameraAt(cuts, 60)).toBe('b');     // exactly on a cut → that cut
        expect(activeCameraAt(cuts, 90)).toBe('b');
        expect(activeCameraAt(cuts, 120)).toBe('c');
        expect(activeCameraAt(cuts, 9999)).toBe('c');   // after the last → last
    });
    it('order-independent (unsorted input still resolves correctly)', () => {
        const shuffled: CameraCut[] = [{ frame: 120, cameraId: 'c' }, { frame: 0, cameraId: 'a' }, { frame: 60, cameraId: 'b' }];
        expect(activeCameraAt(shuffled, 90)).toBe('b');
    });
});

describe('camera-cuts — edits', () => {
    it('setCut adds sorted and replaces at the same frame', () => {
        let cuts = setCut([], 60, 'b');
        cuts = setCut(cuts, 0, 'a');
        expect(cuts.map(c => c.frame)).toEqual([0, 60]);   // sorted
        cuts = setCut(cuts, 60, 'c');                       // replace at 60
        expect(cuts.filter(c => c.frame === 60)).toHaveLength(1);
        expect(activeCameraAt(cuts, 60)).toBe('c');
    });
    it('removeCut deletes the cut at a frame', () => {
        const cuts = setCut(setCut([], 0, 'a'), 60, 'b');
        expect(removeCut(cuts, 60).map(c => c.cameraId)).toEqual(['a']);
        expect(removeCut(cuts, 999)).toHaveLength(2);       // no-op for a missing frame
    });
    it('pruneCuts drops every cut for a deleted camera', () => {
        const cuts: CameraCut[] = [{ frame: 0, cameraId: 'a' }, { frame: 30, cameraId: 'b' }, { frame: 60, cameraId: 'a' }];
        expect(pruneCuts(cuts, 'a').map(c => c.cameraId)).toEqual(['b']);
    });
    it('the edit helpers do not mutate the input array', () => {
        const orig: CameraCut[] = [{ frame: 0, cameraId: 'a' }];
        setCut(orig, 60, 'b'); removeCut(orig, 0); pruneCuts(orig, 'a');
        expect(orig).toEqual([{ frame: 0, cameraId: 'a' }]);
    });
});
