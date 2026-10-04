import { describe, it, expect } from 'vitest';
import { outlineLayers, type HighlightStyle } from './mesh-highlight-pass';

const st = (color: [number, number, number, number], width: number): HighlightStyle =>
  ({ color, width, thicknessPx: 6, patternMode: 0, patternColor: [1, 1, 1], freq: 20, speed: 0, glow: 1 });

describe('outlineLayers — stacked outline rings', () => {
  it('no rings → just the outline (the original single-outline behaviour)', () => {
    const main = st([1, 0, 0, 1], 0.03);
    expect(outlineLayers(main, null)).toEqual([main]);
    expect(outlineLayers(main, [])).toEqual([main]);
  });
  it('each ring shell = everything inside it + its own thickness (inner → outer)', () => {
    const red = st([1, 0, 0, 1], 0.03), white = st([1, 1, 1, 1], 0.02), black = st([0, 0, 0, 1], 0.01);
    const l = outlineLayers(red, [white, black]);
    expect(l.map((x) => x.color)).toEqual([red.color, white.color, black.color]);
    expect(l[0].width).toBeCloseTo(0.03);
    expect(l[1].width).toBeCloseTo(0.05);
    expect(l[2].width).toBeCloseTo(0.06);
    expect(white.width).toBe(0.02);   // pure: the input ring isn't mutated
  });
});

import { outlineAnimates } from './mesh-highlight-pass';
describe('outline line boil — keep-alive rule', () => {
  it('animates for a scrolling pattern OR a boiling line; an even static line does not', () => {
    const base = st([0, 0, 0, 1], 0.03);
    expect(outlineAnimates(base)).toBe(false);
    expect(outlineAnimates({ ...base, speed: 1 })).toBe(true);
    expect(outlineAnimates({ ...base, wobble: 0.3 })).toBe(true);                 // default boilFps 10
    expect(outlineAnimates({ ...base, wobble: 0.3, boilFps: 0 })).toBe(false);    // uneven but still
  });
});
