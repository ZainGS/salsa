import { describe, it, expect } from 'vitest';
import { resolveGlowColor } from './text-effect-engine';

// Glow Color (UI dead-controls audit 2026-10-09): the engine reads `color`; Frogmarks wrote `glowColor` before the
// fix, so documents saved then still carry their colour under the legacy key.
describe('resolveGlowColor', () => {
  it('uses color (rgb; an alpha entry is ignored)', () => {
    expect(resolveGlowColor({ radius: 4, intensity: 1, color: [0.2, 0.6, 1] })).toEqual([0.2, 0.6, 1]);
    expect(resolveGlowColor({ radius: 4, intensity: 1, color: [1, 0, 0.5, 1] })).toEqual([1, 0, 0.5]);
  });

  it('falls back to the legacy glowColor of an older document', () => {
    expect(resolveGlowColor({ radius: 4, intensity: 1, glowColor: [0, 1, 0, 1] })).toEqual([0, 1, 0]);
  });

  it('color wins when both are set', () => {
    expect(resolveGlowColor({ radius: 4, intensity: 1, color: [1, 1, 1], glowColor: [0, 0, 0] })).toEqual([1, 1, 1]);
  });

  it('no colour (or a malformed one) = the text colour (null)', () => {
    expect(resolveGlowColor({ radius: 4, intensity: 1 })).toBeNull();
    expect(resolveGlowColor(null)).toBeNull();
    expect(resolveGlowColor({ radius: 4, intensity: 1, color: [1, 'x', 0] as unknown as [number, number, number] })).toBeNull();
    expect(resolveGlowColor({ radius: 4, intensity: 1, color: [1, 0] as unknown as [number, number, number] })).toBeNull();
  });
});
