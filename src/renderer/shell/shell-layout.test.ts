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
  computeShellLayout,
  shellResponsiveOpts,
  SHELL_MIN_TILE_CSS,
  SHELL_COMPACT_BELOW_CSS,
  type ShellTileSpec,
  type ShellRenderModel,
} from './shell-layout';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
/** Deterministic stand-in for canvas measureText: 0.6 em per character. */
const measure = (text: string, fontPx: number) => text.length * fontPx * 0.6;

describe('computeProjectGrid — columns-first cards (UI-14, no right gap)', () => {
  // phone portrait / phone landscape / tablet portrait / tablet landscape / desktop
  const sizes: [number, number][] = [[390, 844], [844, 390], [800, 1280], [1280, 800], [1920, 1080]];

  for (const dpr of [1, 2]) {
    for (const [cssW, cssH] of sizes) {
      const W = cssW * dpr, H = cssH * dpr;
      it(`${cssW}×${cssH} @${dpr}x: same card size for 1, 2, 3 and 12 projects; ≥ the minimum; full rows end on the right margin`, () => {
        const minW = (cssW < 900 ? PROJECT_TILE_W_COMPACT_CSS : PROJECT_TILE_W_CSS) * dpr;
        const gap = 12 * dpr;
        const margin = projectGridSideMargin(W, dpr);
        const usable = W - 2 * margin;
        const ref = computeProjectGrid(W, H, ids(12), 0, dpr);
        // cols = floor((usable + gap) / (min + gap)); tileW = (usable − gap·(cols − 1)) / cols
        expect(ref.cols).toBe(Math.max(1, Math.floor((usable + gap) / (minW + gap))));
        expect(ref.tileW).toBeCloseTo((usable - gap * (ref.cols - 1)) / ref.cols, 6);
        expect(ref.tileW).toBeGreaterThanOrEqual(minW - 1e-6);
        expect(ref.tileH).toBe(Math.round(ref.tileW * PROJECT_TILE_ASPECT));
        // A full row reaches the right margin exactly (the old fixed-size layout left a gap there).
        const lastInRow0 = ref.items[ref.cols - 1];
        expect(lastInRow0.rect[0] + lastInRow0.rect[2]).toBeCloseTo(W - margin, 6);
        for (const n of [1, 2, 3, 12]) {
          const g = computeProjectGrid(W, H, ids(n), 0, dpr);
          expect(g.items).toHaveLength(n);
          expect(g.cols).toBe(ref.cols);
          expect(g.tileW).toBe(ref.tileW);   // never stretched for a short list
          expect(g.tileH).toBe(ref.tileH);
          g.items.forEach((it, i) => {
            expect(it.rect[2]).toBe(ref.tileW);
            expect(it.rect[3]).toBe(ref.tileH);
            // Left-aligned at the column positions of a full row; never past the right margin.
            expect(it.rect[0]).toBeCloseTo(margin + (i % g.cols) * (ref.tileW + gap), 6);
            expect(it.rect[0] + it.rect[2]).toBeLessThanOrEqual(W - margin + 1e-6);
          });
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

  it('worked widths: phone full-width, tablet + desktop cards a little over the minimum', () => {
    const w = (W: number, H: number) => { const g = computeProjectGrid(W, H, ids(12), 0); return [g.cols, g.tileW]; };
    // 390: margin 16 → usable 358 → 1 col of 358 (was 180 + a 178 px right gap)
    expect(w(390, 844)[0]).toBe(1); expect(w(390, 844)[1]).toBeCloseTo(358, 6);
    // 844 (phone landscape): margin 25.32 → usable 793.36 → 4 cols of 189.34
    expect(w(844, 390)[0]).toBe(4); expect(w(844, 390)[1]).toBeCloseTo((793.36 - 36) / 4, 6);
    // 800 (tablet portrait): margin 24 → usable 752 → 3 cols of 242.67
    expect(w(800, 1280)[0]).toBe(3); expect(w(800, 1280)[1]).toBeCloseTo((752 - 24) / 3, 6);
    // 1280 (tablet landscape): margin 38.4 → usable 1203.2 → 5 cols of 231.04
    expect(w(1280, 800)[0]).toBe(5); expect(w(1280, 800)[1]).toBeCloseTo((1203.2 - 48) / 5, 6);
    // 1920: margin 48 → usable 1824 → 7 cols of 250.29 (≈ 1.14× the 220 minimum)
    expect(w(1920, 1080)[0]).toBe(7); expect(w(1920, 1080)[1]).toBeCloseTo((1824 - 72) / 7, 6);
  });

  it('from 2 columns up a card stays under ~1.5× the minimum (no cap needed)', () => {
    for (let W = 300; W <= 3000; W += 7) {
      const g = computeProjectGrid(W, 900, ids(3), 0);
      if (g.cols < 2) continue;
      const minW = W < 900 ? PROJECT_TILE_W_COMPACT_CSS : PROJECT_TILE_W_CSS;
      expect(g.tileW).toBeGreaterThanOrEqual(minW - 1e-6);
      expect(g.tileW).toBeLessThan(1.5 * minW + 12 / 2 + 1e-6);
    }
  });

  it('the last partial row keeps the card size and starts at the left margin', () => {
    const W = 1280, H = 800;
    const g = computeProjectGrid(W, H, ids(7), 0);   // 5 + 2
    const x0 = projectGridSideMargin(W);
    const row1 = g.items.slice(5);
    expect(row1).toHaveLength(2);
    expect(row1[0].rect[0]).toBeCloseTo(x0, 6);
    expect(row1[1].rect[0]).toBeCloseTo(g.items[1].rect[0], 6);
    for (const it of row1) { expect(it.rect[2]).toBe(g.tileW); expect(it.rect[3]).toBe(g.tileH); }
    expect(row1[1].rect[1]).toBe(row1[0].rect[1]);
  });

  it('rotation recomputes the columns and refits the right edge (portrait ↔ landscape)', () => {
    for (const dpr of [1, 2]) {
      const P = computeProjectGrid(800 * dpr, 1280 * dpr, ids(10), 0, dpr);
      const L = computeProjectGrid(1280 * dpr, 800 * dpr, ids(10), 0, dpr);
      expect(L.cols).toBeGreaterThan(P.cols);
      for (const [g, W] of [[P, 800 * dpr], [L, 1280 * dpr]] as const) {
        const last = g.items[g.cols - 1];
        expect(last.rect[0] + last.rect[2]).toBeCloseTo(W - projectGridSideMargin(W, dpr), 6);
      }
      // Back to portrait → the identical layout (pure function of the size).
      expect(computeProjectGrid(800 * dpr, 1280 * dpr, ids(10), 0, dpr)).toEqual(P);
    }
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
    // One / two projects sit at the left (not stretched across / centred), at the full-row card size.
    for (const n of [1, 2]) {
      const few = computeProjectGrid(W, H, ids(n), 0);
      expect(few.items[0].rect[0]).toBeCloseTo(x0, 6);
      for (const it of few.items) expect(it.rect[2]).toBe(g.tileW);
    }
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

  it('the ✕ hit box grows to minHitPx around the button centre (coarse pointer), and only then', () => {
    const g = computeProjectGrid(1280, 800, ids(1), 0, 1);
    const it = g.items[0];
    const model = { projectGrid: g.items } as unknown as ShellRenderModel;
    const [x, y, w] = it.rect;
    const titleH = projectCardTitleH(it);
    const b = Math.min(Math.max(Math.min(w, it.rect[3]) * 0.012, 1.5), 2.5);
    const bx1 = w - 2 * b - b * 1.5, bx0 = bx1 - titleH * 0.7;
    const by0 = 2 * b + (titleH - titleH * 0.7) * 0.5;
    const cx = x + (bx0 + bx1) / 2, cy = y + by0 + titleH * 0.35;
    // 20 px left of the centre: outside the drawn button (+ its 2 px slop), inside a 44 px finger box.
    expect(hitTestProjectGridClose(model, cx - 20, cy, 1280)).toBeNull();
    expect(hitTestProjectGridClose(model, cx - 20, cy, 1280, 44)).toBe('p0');
    expect(hitTestProjectGridClose(model, cx, cy + 20, 1280, 44)).toBe('p0');
    expect(hitTestProjectGridClose(model, cx - 23, cy, 1280, 44)).toBeNull();
    // A min smaller than the button changes nothing.
    expect(hitTestProjectGridClose(model, cx - 20, cy, 1280, 4)).toBeNull();
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

// ── Responsive home (UI review 2026-10-07 §3 #22): tile floor, fewer columns, few empty slots on a phone ──

const homeSpecs = (n: number): ShellTileSpec[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: 'system', selected: false, hovered: false, label: `App ${i}` }));

describe('computeShellLayout — responsive (tile floor + compact phone layout)', () => {
  const layout = (cssW: number, cssH: number, dpr: number, n = 5) =>
    computeShellLayout(cssW * dpr, cssH * dpr, homeSpecs(n), { page: 0, zoom: 0.85, ...shellResponsiveOpts(cssW * dpr, dpr) });

  for (const dpr of [1, 1.5, 3]) {
    it(`phone 390×844 @${dpr}x: tiles ≥ ${SHELL_MIN_TILE_CSS} CSS px, ≤ 5 columns, one spare row, no tiny empties`, () => {
      const m = layout(390, 844, dpr);
      expect(m.grid.tileSize / dpr).toBeGreaterThanOrEqual(SHELL_MIN_TILE_CSS - 1e-6);
      expect(m.grid.columns).toBeLessThanOrEqual(5);
      expect(m.grid.columns).toBeGreaterThanOrEqual(3);
      // rows = the rows 5 tiles need + 1 spare (was ~9 rows × 10 columns of ~28 px discs)
      expect(m.grid.rows).toBe(Math.ceil(5 / m.grid.columns) + 1);
      expect(m.grid.columns * m.grid.rows - 5).toBeLessThan(m.grid.columns * 2);
      // every tile and the card stay on screen; the card hugs its rows and sits on the bottom margin
      for (const t of m.tiles) {
        expect(t.rect[0]).toBeGreaterThanOrEqual(0);
        expect(t.rect[0] + t.rect[2]).toBeLessThanOrEqual(390 * dpr + 1e-6);
        expect(t.rect[1] + t.rect[3]).toBeLessThanOrEqual(m.grid.cardY + m.grid.cardH + 1e-6);
      }
      expect(m.grid.cardY).toBeGreaterThanOrEqual(m.grid.regionTop);
      expect(m.grid.cardY + m.grid.cardH).toBeCloseTo(844 * dpr * (1 - 0.035), 3);
      // labels are readable (≥ 10 CSS px; were ~4 px)
      for (const l of m.labels) expect(l.fontPx / dpr).toBeGreaterThanOrEqual(10 - 1e-6);
    });
  }

  it('desktop keeps the full-card 3DS grid (no floor kicks in, rows fill the card)', () => {
    const plain = computeShellLayout(1920, 1080, homeSpecs(5), { page: 0, zoom: 0.85 });
    const resp = layout(1920, 1080, 1);
    expect(resp.grid.columns).toBe(plain.grid.columns);
    expect(resp.grid.rows).toBe(plain.grid.rows);
    expect(resp.grid.tileSize).toBeCloseTo(plain.grid.tileSize, 6);
    expect(resp.grid.cardH).toBeCloseTo(plain.grid.cardH, 6);
  });

  it('a portrait tablet gets fewer, bigger columns than the width-only rule', () => {
    const plain = computeShellLayout(800, 1280, homeSpecs(5), { page: 0, zoom: 0.85 });
    const resp = layout(800, 1280, 1);
    expect(plain.grid.tileSize).toBeLessThan(SHELL_MIN_TILE_CSS);
    expect(resp.grid.tileSize).toBeGreaterThanOrEqual(SHELL_MIN_TILE_CSS - 1e-6);
    expect(resp.grid.columns).toBeLessThan(plain.grid.columns);
  });

  it('compact applies only below the phone width', () => {
    expect(shellResponsiveOpts((SHELL_COMPACT_BELOW_CSS - 1) * 2, 2).spareRows).toBe(1);
    expect(shellResponsiveOpts(SHELL_COMPACT_BELOW_CSS * 2, 2).spareRows).toBeUndefined();
  });

  it('many carts on a phone: rows stop at what fits and the rest pages', () => {
    const m = layout(390, 844, 2, 40);
    expect(m.pageCount).toBeGreaterThan(1);
    expect(m.grid.cardY).toBeGreaterThanOrEqual(m.grid.regionTop);
  });
});

describe('layoutShellChips — keeps the first row clear of the top-right cluster', () => {
  it('wraps the second chip when the reserve leaves no room for it, later rows use the full width', () => {
    const labels = ['‹ Back', '+ New Project'];
    const free = layoutShellChips(labels, measure, 390, 844, 1);
    expect(free.rects[1][1]).toBe(free.rects[0][1]);              // one row without a reserve
    const res = layoutShellChips(labels, measure, 390, 844, 1, 260);
    expect(res.rects[0][0] + res.rects[0][2]).toBeLessThanOrEqual(390 - 260 + 1e-6);
    expect(res.rects[1][1]).toBeGreaterThan(res.rects[0][1]);      // wrapped below the cluster
  });

  it('a small reserve changes nothing when everything fits', () => {
    const a = layoutShellChips(['‹ Back'], measure, 1280, 800, 1);
    const b = layoutShellChips(['‹ Back'], measure, 1280, 800, 1, 200);
    expect(b.rects).toEqual(a.rects);
    expect(b.fontPx).toBe(a.fontPx);
  });
});
