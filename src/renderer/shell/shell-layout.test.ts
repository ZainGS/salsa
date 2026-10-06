import { describe, it, expect } from 'vitest';
import {
  computeProjectGrid,
  layoutShellChips,
  projectCardTitleFontPx,
  projectCardTitleH,
  projectGridSideMargin,
  clampShellFontPx,
  hitTestProjectGridClose,
  PROJECT_TILE_W_CSS,
  PROJECT_TILE_W_COMPACT_CSS,
  PROJECT_TILE_ASPECT,
  SHELL_CHIP_MIN_H_CSS,
  type ShellRenderModel,
} from './shell-layout';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
/** Deterministic stand-in for canvas measureText: 0.6 em per character. */
const measure = (text: string, fontPx: number) => text.length * fontPx * 0.6;

describe('computeProjectGrid — fixed-size cards (UI-14)', () => {
  const sizes: [number, number][] = [[390, 844], [800, 1280], [1280, 800], [1920, 1080]];

  for (const dpr of [1, 2]) {
    for (const [cssW, cssH] of sizes) {
      const W = cssW * dpr, H = cssH * dpr;
      it(`${cssW}×${cssH} @${dpr}x: card size is constant for 1, 3 and 12 projects`, () => {
        const expectedW = (cssW < 900 ? PROJECT_TILE_W_COMPACT_CSS : PROJECT_TILE_W_CSS) * dpr;
        for (const n of [1, 3, 12]) {
          const g = computeProjectGrid(W, H, ids(n), 0, dpr);
          expect(g.items).toHaveLength(n);
          expect(g.tileW).toBe(expectedW);
          expect(g.tileH).toBe(Math.round(expectedW * PROJECT_TILE_ASPECT));
          for (const it of g.items) {
            expect(it.rect[2]).toBe(expectedW);
            expect(it.rect[3]).toBe(g.tileH);
            // Every card stays inside the viewport horizontally (left-aligned, no overflow).
            expect(it.rect[0]).toBeGreaterThanOrEqual(0);
            expect(it.rect[0] + it.rect[2]).toBeLessThanOrEqual(W);
          }
        }
      });

      it(`${cssW}×${cssH} @${dpr}x: column count depends on width only, scales with DPR`, () => {
        const c1 = computeProjectGrid(W, H, ids(1), 0, dpr).cols;
        const c12 = computeProjectGrid(W, H, ids(12), 0, dpr).cols;
        expect(c1).toBe(c12);
        expect(c12).toBe(computeProjectGrid(cssW, cssH, ids(12), 0, 1).cols);
      });
    }
  }

  it('expected column counts: 1 on a phone, 2+ on an 800 px portrait tablet, more on desktop', () => {
    expect(computeProjectGrid(390, 844, ids(12), 0).cols).toBe(1);
    expect(computeProjectGrid(800, 1280, ids(12), 0).cols).toBeGreaterThanOrEqual(2);
    expect(computeProjectGrid(1600, 2560, ids(12), 0, 2).cols).toBeGreaterThanOrEqual(2);
    expect(computeProjectGrid(1280, 800, ids(12), 0).cols).toBe(5);
    expect(computeProjectGrid(1920, 1080, ids(12), 0).cols).toBe(7);
  });

  it('left-aligned and wraps into rows of `cols` identical cards', () => {
    const W = 1280, H = 800;
    const g = computeProjectGrid(W, H, ids(12), 0);
    const x0 = projectGridSideMargin(W);
    const rows = Math.ceil(12 / g.cols);
    // First card of every row starts at the side margin; rows step by a constant pitch.
    const rowStarts = g.items.filter((_, i) => i % g.cols === 0);
    expect(rowStarts).toHaveLength(rows);
    for (const it of rowStarts) expect(it.rect[0]).toBeCloseTo(x0, 6);
    const pitch = rowStarts[1].rect[1] - rowStarts[0].rect[1];
    expect(pitch).toBeGreaterThan(g.tileH);
    for (let r = 1; r < rows; r++) expect(rowStarts[r].rect[1] - rowStarts[r - 1].rect[1]).toBeCloseTo(pitch, 6);
    // One project sits at the left (not stretched across / centred).
    const one = computeProjectGrid(W, H, ids(1), 0);
    expect(one.items[0].rect[0]).toBeCloseTo(x0, 6);
    expect(one.items[0].rect[2]).toBe(g.tileW);
  });

  it('content height grows with rows; scrollY shifts every card up', () => {
    const W = 800, H = 1280;
    const few = computeProjectGrid(W, H, ids(3), 0);
    const many = computeProjectGrid(W, H, ids(60), 0);
    expect(many.contentHeight).toBeGreaterThan(H);   // overflows → scrollable
    expect(many.contentHeight).toBeGreaterThan(few.contentHeight);
    const scrolled = computeProjectGrid(W, H, ids(60), 300);
    for (let i = 0; i < 60; i++) expect(scrolled.items[i].rect[1]).toBeCloseTo(many.items[i].rect[1] - 300, 6);
  });

  it('topMargin places the first row; empty list is empty', () => {
    const g = computeProjectGrid(1280, 800, ids(2), 0, 1, 150);
    expect(g.items[0].rect[1]).toBe(150);
    expect(computeProjectGrid(1280, 800, [], 0).items).toHaveLength(0);
  });

  it('a viewport narrower than one card shrinks the card to fit (never overflows)', () => {
    const g = computeProjectGrid(150, 600, ids(2), 0);
    expect(g.cols).toBe(1);
    expect(g.items[0].rect[0] + g.items[0].rect[2]).toBeLessThanOrEqual(150);
  });

  it('title bar is ≥ 20 CSS px and drives the ✕ hit-test', () => {
    for (const dpr of [1, 2]) {
      const g = computeProjectGrid(1280 * dpr, 800 * dpr, ids(1), 0, dpr);
      const it = g.items[0];
      expect(projectCardTitleH(it)).toBeGreaterThanOrEqual(20 * dpr);
      const model = { projectGrid: g.items } as unknown as ShellRenderModel;
      const [x, y, w] = it.rect;
      const titleH = projectCardTitleH(it);
      const b = Math.min(Math.max(Math.min(w, it.rect[3]) * 0.012, 1.5), 2.5);
      // Centre of the close button (card-local → screen; GRID_CURVE = 0 so no curve).
      const bx1 = w - 2 * b - b * 1.5, bx0 = bx1 - titleH * 0.7;
      const by0 = 2 * b + (titleH - titleH * 0.7) * 0.5;
      const hit = hitTestProjectGridClose(model, x + (bx0 + bx1) / 2, y + by0 + titleH * 0.35, 1280 * dpr);
      expect(hit).toBe('p0');
      expect(hitTestProjectGridClose(model, x + w / 2, y + it.rect[3] / 2, 1280 * dpr)).toBeNull();
    }
  });
});

describe('shell chip buttons — sized from measured labels', () => {
  const labels = ['‹ Back', '+ New Project'];

  it('font is clamped to 12–16 CSS px (× DPR)', () => {
    for (const dpr of [1, 2]) {
      expect(clampShellFontPx(4 * dpr, dpr)).toBe(12 * dpr);
      expect(clampShellFontPx(14 * dpr, dpr)).toBe(14 * dpr);
      expect(clampShellFontPx(60 * dpr, dpr)).toBe(16 * dpr);
    }
  });

  for (const dpr of [1, 2]) {
    for (const [cssW, cssH] of [[390, 844], [800, 1280], [1280, 800], [1920, 1080]] as [number, number][]) {
      it(`${cssW}×${cssH} @${dpr}x: every label fits its chip; chips ≥ 44 CSS px tall; no overlap; on-screen`, () => {
        const W = cssW * dpr, H = cssH * dpr;
        const L = layoutShellChips(labels, measure, W, H, dpr);
        expect(L.rects).toHaveLength(2);
        expect(L.fontPx).toBeGreaterThanOrEqual(12 * dpr);
        expect(L.fontPx).toBeLessThanOrEqual(16 * dpr);
        L.rects.forEach(([x, y, w, h], i) => {
          expect(w).toBeGreaterThanOrEqual(measure(labels[i], L.fontPx) + 2 * 12 * dpr);
          expect(h).toBeGreaterThanOrEqual(SHELL_CHIP_MIN_H_CSS * dpr);
          expect(x + w).toBeLessThanOrEqual(W);
          expect(y + h).toBeLessThanOrEqual(L.bottom);
        });
        const [a, b] = L.rects;
        const sameRow = a[1] === b[1];
        if (sameRow) expect(b[0]).toBeGreaterThanOrEqual(a[0] + a[2]);
        else expect(b[1]).toBeGreaterThanOrEqual(a[1] + a[3]);
        // The grid starts below the chips when given their bottom.
        const g = computeProjectGrid(W, H, ids(3), 0, dpr, L.bottom + 16 * dpr);
        expect(g.items[0].rect[1]).toBeGreaterThan(L.bottom);
      });
    }
  }

  it('chip width = measured text + 2·padding (not a fraction of the screen width)', () => {
    const narrow = layoutShellChips(labels, measure, 800, 1280, 1);
    const wide = layoutShellChips(labels, measure, 1920, 1280, 1);
    expect(narrow.fontPx).toBe(16);   // 0.02·1280 = 25.6 → capped at 16
    const pad = Math.max(12, 16 * 0.9);
    expect(narrow.rects[0][2]).toBe(Math.ceil(measure(labels[0], 16)) + 2 * pad);
    expect(narrow.rects[1][2]).toBe(Math.ceil(measure(labels[1], 16)) + 2 * pad);
    expect(wide.rects[0][2]).toBe(narrow.rects[0][2]);   // same font → same width at any screen width
    expect(narrow.rects[0][3]).toBe(44);
  });

  it('too wide for one row: shrinks the font to 12 px, then wraps', () => {
    const long = ['‹ Back', '+ New Product Packaging'];
    const L = layoutShellChips(long, measure, 260, 844, 1);
    expect(L.fontPx).toBe(12);
    expect(L.rects[1][1]).toBeGreaterThan(L.rects[0][1]);   // wrapped to a second row
    expect(L.rects[1][0]).toBe(L.rects[0][0]);               // left-aligned under the first
  });
});

describe('project card title font', () => {
  it('clamps to 12–16 CSS px and shrinks to fit before ellipsizing', () => {
    // Short name: preferred size (20 px bar · 0.68 = 13.6 → 14).
    expect(projectCardTitleFontPx('Cat', 150, 20, 1, measure)).toBe(14);
    // Long name: shrinks, but never below 12 px (the atlas ellipsizes past that).
    const f = projectCardTitleFontPx('A rather long illustration', 190, 20, 1, measure);
    expect(f).toBeLessThan(14);
    expect(f).toBeGreaterThanOrEqual(12);
    expect(projectCardTitleFontPx('x'.repeat(200), 100, 20, 1, measure)).toBe(12);
    // DPR scales the clamp.
    expect(projectCardTitleFontPx('Cat', 300, 40, 2, measure)).toBe(27);
    expect(projectCardTitleFontPx('Cat', 300, 200, 2, measure)).toBe(32);
  });
});
