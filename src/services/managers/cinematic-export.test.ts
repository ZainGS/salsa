import { describe, it, expect } from 'vitest';
import { planCinematicFrames, estimateExportDuration, pickWebMMime, validateExportOptions, computeAspectCropRect, type CinematicExportOptions } from './cinematic-export';

describe('cinematic-export — planCinematicFrames', () => {
  it('inclusive of both ends, step 1', () => {
    expect(planCinematicFrames(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });
  it('honours frameStep (fast-forward)', () => {
    expect(planCinematicFrames(0, 10, 3)).toEqual([0, 3, 6, 9]);
  });
  it('single frame when start == end', () => {
    expect(planCinematicFrames(7, 7)).toEqual([7]);
  });
  it('empty when the range is inverted', () => {
    expect(planCinematicFrames(10, 5)).toEqual([]);
  });
  it('a bad step floors to at least 1 (never infinite-loops)', () => {
    expect(planCinematicFrames(1, 3, 0)).toEqual([1, 2, 3]);
    expect(planCinematicFrames(1, 3, 0.5)).toEqual([1, 2, 3]);
  });
});

describe('cinematic-export — estimateExportDuration', () => {
  it('frameCount / fps', () => {
    expect(estimateExportDuration(60, 30)).toBe(2);
    expect(estimateExportDuration(0, 30)).toBe(0);
  });
  it('guards fps <= 0', () => {
    expect(estimateExportDuration(60, 0)).toBe(0);
  });
});

describe('cinematic-export — pickWebMMime', () => {
  it('prefers vp9 when available', () => {
    expect(pickWebMMime(() => true)).toEqual({ mimeType: 'video/webm;codecs=vp9', ext: 'webm' });
  });
  it('falls back to vp8 then generic webm', () => {
    expect(pickWebMMime(m => m === 'video/webm;codecs=vp8' || m === 'video/webm')).toEqual({ mimeType: 'video/webm;codecs=vp8', ext: 'webm' });
    expect(pickWebMMime(m => m === 'video/webm')).toEqual({ mimeType: 'video/webm', ext: 'webm' });
  });
  it('null when nothing is supported', () => {
    expect(pickWebMMime(() => false)).toBeNull();
  });
});

describe('cinematic-export — computeAspectCropRect', () => {
  it('same aspect → full frame, no crop', () => {
    expect(computeAspectCropRect(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
  it('source wider than output → crops the sides, centered', () => {
    // 2000x1000 (2:1) into 1:1 → keep a 1000x1000 centred column
    expect(computeAspectCropRect(2000, 1000, 500, 500)).toEqual({ x: 500, y: 0, w: 1000, h: 1000 });
  });
  it('source taller than output → crops top/bottom, centered', () => {
    // 1000x2000 (1:2) into 1:1 → keep a 1000x1000 centred band
    expect(computeAspectCropRect(1000, 2000, 500, 500)).toEqual({ x: 0, y: 500, w: 1000, h: 1000 });
  });
  it('never returns a zero/negative rect', () => {
    const r = computeAspectCropRect(1, 1, 1920, 1080);
    expect(r.w).toBeGreaterThanOrEqual(1);
    expect(r.h).toBeGreaterThanOrEqual(1);
  });
});

describe('cinematic-export — validateExportOptions', () => {
  const ok: CinematicExportOptions = { fps: 30, start: 1, end: 60, width: 1920, height: 1080 };
  it('accepts a good config', () => {
    expect(validateExportOptions(ok)).toBeNull();
  });
  it('rejects inverted range, sub-1 start, bad fps/size/step', () => {
    expect(validateExportOptions({ ...ok, end: 0 })).toMatch(/end frame/);
    expect(validateExportOptions({ ...ok, start: 0 })).toMatch(/1-indexed/);
    expect(validateExportOptions({ ...ok, fps: 0 })).toMatch(/fps/);
    expect(validateExportOptions({ ...ok, width: 0 })).toMatch(/width/);
    expect(validateExportOptions({ ...ok, frameStep: 1.5 })).toMatch(/frameStep/);
  });
});
