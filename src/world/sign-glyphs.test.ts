/** Sign lettering (B7 / persona-polish C1): glyph cell math keeps text inside its sign; words are REAL shop words from
 *  the list, deterministic; every character of every word is in the font; the stroke budget holds. */
import { describe, it, expect } from 'vitest';
import { glyphCells, signWord, emitGlyphRun, GLYPH_NAMES, glyphStrokes, SIGN_WORDS, signWordKind, type SignWordKind } from './sign-glyphs';
import { Accum3D } from './meshbuild';

describe('sign glyphs', () => {
  it('every glyph has 1–16 stroke segments on the 0..4 design grid', () => {
    for (const n of GLYPH_NAMES) {
      const st = glyphStrokes(n);
      expect(st.length, n).toBeGreaterThan(0); expect(st.length, n).toBeLessThanOrEqual(16);
      for (const s of st) for (const c of s) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(4); }
    }
  });
  for (const [n, w, h, vertical] of [[4, 0.8, 3, true], [6, 5, 0.45, false], [1, 0.25, 0.5, true], [7, 1, 1, false]] as const) {
    it(`cells fit the box (${n} glyphs, ${w}×${h}, ${vertical ? 'vertical' : 'horizontal'})`, () => {
      const { cell, centres } = glyphCells(n, w, h, vertical);
      expect(centres.length).toBe(n);
      for (const [x, y] of centres) {
        expect(Math.abs(x) + cell / 2).toBeLessThanOrEqual(w / 2 + 1e-9);
        expect(Math.abs(y) + cell / 2).toBeLessThanOrEqual(h / 2 + 1e-9);
      }
      // square cells, no overlap along the run
      if (n > 1) { const d = vertical ? Math.abs(centres[1][1] - centres[0][1]) : Math.abs(centres[1][0] - centres[0][0]); expect(d).toBeCloseTo(cell, 9); }
    });
  }
  it('vertical runs read top → bottom, horizontal runs left → right', () => {
    const v = glyphCells(3, 1, 3, true).centres, h = glyphCells(3, 3, 1, false).centres;
    expect(v[0][1]).toBeGreaterThan(v[2][1]);
    expect(h[0][0]).toBeLessThan(h[2][0]);
  });
  it('every character of every listed word is in the font', () => {
    for (const [kind, words] of Object.entries(SIGN_WORDS)) for (const w of words) for (const ch of w) expect(glyphStrokes(ch).length, `${kind} ${w} ${ch}`).toBeGreaterThan(0);
  });
  it('signWord picks a REAL listed word, deterministic per seed, varied between seeds, sized to the slot', () => {
    expect(signWord(42, 4)).toEqual(signWord(42, 4));
    for (const kind of Object.keys(SIGN_WORDS) as SignWordKind[]) {
      for (let i = 0; i < 40; i++) {
        const w = signWord(i, 4, false, kind).join('');
        expect(SIGN_WORDS[kind]).toContain(w);
      }
      const seen = new Set(Array.from({ length: 60 }, (_, i) => signWord(i * 7919, 4, false, kind).join('')));
      expect(seen.size).toBeGreaterThanOrEqual(Math.min(4, SIGN_WORDS[kind].filter(x => [...x].length <= 4 && [...x].length >= 2).length));
    }
    // a 1-glyph slot gets a 1-glyph word (lanterns), a wide fascia slot a long one
    expect(signWord(5, 1, true, 'lantern').length).toBe(1);
    expect(signWord(5, 1, false, 'shop').length).toBe(1);
    expect(signWord(9, 5, false, 'nightlife').length).toBeGreaterThanOrEqual(3);
  });
  it('word kinds follow archetype identity, then district mood', () => {
    expect(signWordKind('konbini', 'downtown')).toBe('konbini');
    expect(signWordKind('izakaya')).toBe('izakaya');
    expect(signWordKind('zakkyo', 'downtown')).toBe('nightlife');
    expect(signWordKind('office-block', 'market')).toBe('food');
    expect(signWordKind('office-block', 'residential')).toBe('quiet');
    expect(signWordKind('office-block')).toBe('shop');
  });
  it('the long-vowel bar turns to run down a vertical (tate) column', () => {
    const [h] = glyphStrokes('ー'), [v] = glyphStrokes('ー', true);
    expect(Math.abs(h[1] - h[3])).toBeLessThan(0.01);   // horizontal
    expect(Math.abs(v[0] - v[2])).toBeLessThan(0.01);   // vertical
  });
  it('a 4-glyph run stays inside the face plane box and within ~32 tris per glyph', () => {
    const acc = new Accum3D();
    const n = emitGlyphRun(acc, [0, 5, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.8, 3, signWord(3, 4, true), true);
    expect(n).toBeGreaterThan(0);
    expect(acc.triCount).toBe(n * 2);
    expect(acc.triCount / 4).toBeLessThanOrEqual(32);
    // the whole word list averages well under that (≈ 8 segments / 16 tris per glyph)
    let segs = 0, glyphs = 0;
    for (const words of Object.values(SIGN_WORDS)) for (const w of words) for (const ch of w) { segs += glyphStrokes(ch).length; glyphs++; }
    expect(segs / glyphs).toBeLessThanOrEqual(9);
    const g = acc.geometry().vertices;
    for (let i = 0; i < g.length; i += 12) {
      expect(Math.abs(g[i])).toBeLessThanOrEqual(0.4 + 1e-6);
      expect(Math.abs(g[i + 1] - 5)).toBeLessThanOrEqual(1.5 + 1e-6);
      expect(g[i + 2]).toBeGreaterThan(0);   // lifted in front of the face
    }
  });
});
