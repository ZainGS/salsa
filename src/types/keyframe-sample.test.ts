import { describe, it, expect } from 'vitest';
import { sampleTrack, interpolateScalar, hasAnyKeyframes, EMPTY_TRACK, type Keyframe } from './keyframe-3d';

// sampleTrack skips its copy + sort for a track already in frame order (it ran per track per mesh per frame of
// playback); the result must be the same either way, and the caller's track is never reordered.
describe('sampleTrack — in-order fast path', () => {
  const kf = (frame: number, value: number): Keyframe<number> => ({ frame, value, easing: 'linear' });

  it('samples an unsorted track exactly like the same track sorted, without reordering it', () => {
    const sorted = [kf(1, 0), kf(5, 10), kf(9, 2), kf(10, 4), kf(12, -3)];
    const shuffled = [sorted[3], sorted[0], sorted[4], sorted[1], sorted[2]];
    const before = shuffled.slice();
    for (let f = -1; f <= 14; f += 0.5) {
      expect(sampleTrack(shuffled, f, interpolateScalar)).toBe(sampleTrack(sorted, f, interpolateScalar));
    }
    expect(shuffled).toEqual(before);
  });

  it('an empty track (or the shared EMPTY_TRACK) samples to null', () => {
    expect(sampleTrack([], 3, interpolateScalar)).toBeNull();
    expect(sampleTrack(EMPTY_TRACK, 3, interpolateScalar)).toBeNull();
  });
});

describe('hasAnyKeyframes', () => {
  it('is false for no tracks / empty tracks, true for any keyed track or blend-weight entry', () => {
    expect(hasAnyKeyframes(undefined)).toBe(false);
    expect(hasAnyKeyframes({})).toBe(false);
    expect(hasAnyKeyframes({ position: [], opacity: [], blendWeights: {} })).toBe(false);
    expect(hasAnyKeyframes({ opacity: [{ frame: 1, value: 1, easing: 'linear' }] })).toBe(true);
    expect(hasAnyKeyframes({ blendWeights: { smile: [] } })).toBe(true);   // the blend-shape sync runs for it
    expect(hasAnyKeyframes({ target: [{ frame: 2, value: [0, 0, 0], easing: 'step' }] })).toBe(true);
  });
});
