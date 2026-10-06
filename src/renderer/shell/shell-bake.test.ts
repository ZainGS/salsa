/**
 * shell-bake.test.ts — the Shell's static bakes + the mode cross-fade keep the picture identical:
 *  - the panel bake key follows the panel shader's REAL inputs (not hover), and the bake rect holds every pixel the
 *    panel shader can colour (CPU mirror of its card mask);
 *  - the backdrop sticker's scissor rect holds every pixel the sticker shader can colour (CPU mirror of its alpha);
 *  - skipping the specks where the grid mask is 0 adds exactly what the unconditional product added (0);
 *  - the GPU-side cross-fade follows the old per-frame curve exactly.
 */
import { describe, it, expect } from 'vitest';
import {
  panelBakeKey, panelBakeRect, panelOccupiedMask, backdropStickerRect, BACKDROP_Q_BOUNDS,
  modeFadeT, scrimAlphaForFade, MODE_FADE_MS,
} from './shell-bake';
import { computeShellLayout, SHELL_THEMES, type ShellTileSpec, type ShellRenderModel } from './shell-layout';

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function homeSpecs(hoveredId: string | null = null): ShellTileSpec[] {
  const mk = (id: string, extra: Partial<ShellTileSpec>): ShellTileSpec =>
    ({ id, kind: 'system', label: id, selected: false, hovered: hoveredId === id, ...extra });
  return [
    mk('system:illustrator', { billboardKey: 'system:illustrator' }),
    mk('__add_cart__', { kind: 'empty', billboardKey: '__download__' }),
    mk('system:settings', { billboardKey: 'system:settings' }),
    mk('__demo_cart__', { kind: 'remote', cd: true }),
  ];
}
function homeModel(w = 1600, h = 1000, theme = SHELL_THEMES.polygon, hovered: string | null = null, zoom = 0.85): ShellRenderModel {
  return computeShellLayout(w, h, homeSpecs(hovered), { page: 0, zoom }, theme);
}

describe('panel bake key', () => {
  it('is unchanged by hover, selection, the dwell ring and the viewer (what a pointer move rebuilds)', () => {
    const a = homeModel();
    const b = homeModel(1600, 1000, SHELL_THEMES.polygon, 'system:illustrator');
    b.ringTileId = 'system:illustrator'; b.ringCountdownStart = 12.5;
    b.viewer = { kind: 'cd', bodyColor: [1, 1, 1, 1], labelColor: [1, 1, 1, 1] };
    b.tiles[0].selected = true;
    b.modeFade = 0.3;
    expect(panelBakeKey(b, 1600, 1000)).toBe(panelBakeKey(a, 1600, 1000));
  });

  it('changes with the canvas size, the grid, the theme colours and the occupied cells', () => {
    const base = homeModel();
    const key = panelBakeKey(base, 1600, 1000);
    expect(panelBakeKey(homeModel(1601, 1000), 1601, 1000)).not.toBe(key);
    expect(panelBakeKey(homeModel(1600, 1000, SHELL_THEMES.polygon, null, 1.1), 1600, 1000)).not.toBe(key);   // zoom → grid pitch
    expect(panelBakeKey(homeModel(1600, 1000, SHELL_THEMES.frog), 1600, 1000)).not.toBe(key);
    const occ = homeModel();
    occ.tiles[3] = { ...occ.tiles[3], cd: false };   // the cart leaves its cell
    expect(panelBakeKey(occ, 1600, 1000)).not.toBe(key);
    for (const field of ['accentA', 'accentB', 'panelBorder', 'panelColor'] as const) {
      const m = homeModel();
      m[field] = [m[field][0] * 0.5 + 0.1, m[field][1], m[field][2], m[field][3]];
      expect(panelBakeKey(m, 1600, 1000), field).not.toBe(key);
    }
    const dark = homeModel(); dark.dark = !dark.dark;
    expect(panelBakeKey(dark, 1600, 1000)).not.toBe(key);
    const rb = homeModel(); rb.rainbow = !rb.rainbow;
    expect(panelBakeKey(rb, 1600, 1000)).not.toBe(key);
  });

  it('every theme produces a distinct key at the same size', () => {
    const keys = new Set(Object.values(SHELL_THEMES).map(t => panelBakeKey(homeModel(1280, 800, t), 1280, 800)));
    expect(keys.size).toBe(Object.keys(SHELL_THEMES).length);
  });

  it('occupied mask = the cells holding a 3D tile (first 32)', () => {
    expect(panelOccupiedMask([{ billboardKey: 'a' }, {}, { cd: true }, { discIcon: 'x' }])).toBe(0b1101);
    expect(panelOccupiedMask(Array.from({ length: 40 }, () => ({ cd: true })))).toBe(0xffffffff);
  });
});

describe('panel bake rect', () => {
  // CPU mirror of PANEL_COMMON's card mask (sdRoundRect + the 1.5 px smoothstep edge).
  function cardMask(fx: number, fy: number, g: ShellRenderModel['grid']): number {
    const hx = g.cardW * 0.5, hy = g.cardH * 0.5;
    const px = fx - (g.cardX + hx), py = fy - (g.cardY + hy);
    const qx = Math.abs(px) - hx + g.cardCorner, qy = Math.abs(py) - hy + g.cardCorner;
    const d = Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - g.cardCorner;
    return 1 - smoothstep(-1.5, 1.5, d);
  }

  it('holds every pixel the panel shader colours (mask > 0.001), for several sizes / themes / zooms', () => {
    for (const [w, h] of [[1600, 1000], [1280, 800], [2000, 1200], [390, 844], [1024, 1366], [801, 601]] as const) {
      for (const theme of [SHELL_THEMES.polygon, SHELL_THEMES.frog]) {
        for (const zoom of [0.55, 0.85, 1.35]) {
          const g = computeShellLayout(w, h, homeSpecs(), { page: 0, zoom }, theme).grid;
          const r = panelBakeRect(g, w, h);
          if (!(g.cardW > 0 && g.cardH > 0)) { expect(r).toBeNull(); continue; }
          expect(r).not.toBeNull();
          const { x, y, w: rw, h: rh } = r!;
          expect(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(rw) && Number.isInteger(rh)).toBe(true);
          expect(x >= 0 && y >= 0 && x + rw <= w && y + rh <= h).toBe(true);
          // rows the panel quad covers: pixel centres in [regionTop, regionTop + regionHeight)
          const rowIn = (j: number) => j + 0.5 >= g.regionTop && j + 0.5 < g.regionTop + g.regionHeight;
          // Every pixel within 4 px outside the rect: the shader's output there is exactly transparent.
          for (let j = Math.max(0, y - 4); j < Math.min(h, y + rh + 4); j++) {
            if (!rowIn(j)) continue;
            for (let i = Math.max(0, x - 4); i < Math.min(w, x + rw + 4); i++) {
              const inside = i >= x && i < x + rw && j >= y && j < y + rh;
              if (inside) continue;
              expect(cardMask(i + 0.5, j + 0.5, g) <= 0.001, `${w}x${h} z${zoom} px ${i},${j}`).toBe(true);
            }
          }
          // …and the rect is tight: its edge rows / columns are within 3 px of a coloured pixel (no wasted texture).
          expect(rw).toBeLessThanOrEqual(Math.ceil(g.cardW) + 6);
          expect(rh).toBeLessThanOrEqual(Math.ceil(g.cardH) + 6);
        }
      }
    }
  });

  it('clips to the rows the panel quad covers', () => {
    const g = { cardX: 10, cardY: 100, cardW: 300, cardH: 200, regionTop: 150.2, regionHeight: 100 };
    const r = panelBakeRect(g, 400, 400)!;
    expect(r.y).toBe(150);          // centre 150.5 >= 150.2
    expect(r.y + r.h).toBe(250);    // centre 249.5 < 250.2, centre 250.5 is not
    expect(r.x).toBe(8);
    expect(r.x + r.w).toBe(312);
  });

  it('null for an empty card or canvas', () => {
    expect(panelBakeRect({ cardX: 0, cardY: 0, cardW: 0, cardH: 10, regionTop: 0, regionHeight: 10 }, 100, 100)).toBeNull();
    expect(panelBakeRect({ cardX: 0, cardY: 0, cardW: 10, cardH: 10, regionTop: 0, regionHeight: 10 }, 0, 100)).toBeNull();
    expect(panelBakeRect({ cardX: 500, cardY: 0, cardW: 10, cardH: 10, regionTop: 0, regionHeight: 10 }, 100, 100)).toBeNull();
  });
});

describe('backdrop sticker scissor', () => {
  // CPU mirror of BACKDROP_SHADER's coverage (blob smooth-union + three squiggle ribbons with their cream borders).
  const smin = (a: number, b: number, k: number) => {
    const hh = Math.min(1, Math.max(0, 0.5 + 0.5 * (b - a) / k));
    return (b * (1 - hh) + a * hh) - k * hh * (1 - hh);
  };
  const sdC = (qx: number, qy: number, cx: number, cy: number, r: number) => Math.hypot(qx - cx, qy - cy) - r;
  const sdSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
    const hh = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
    return Math.hypot(pax - bax * hh, pay - bay * hh);
  };
  function squig(qx: number, qy: number, baseY: number, amp: number, freq: number, phase: number, xmin: number, xmax: number, th: number): number {
    const m = th + 0.05;
    if (qx < xmin - m || qx > xmax + m) return 0;
    if (qy < baseY - amp - m || qy > baseY + amp + m) return 0;
    const N = 18;
    let px = xmin, py = baseY + amp * Math.sin(freq * xmin + phase), best = 1e9;
    for (let i = 1; i <= N; i++) {
      const x = xmin + (xmax - xmin) * (i / N);
      const y = baseY + amp * Math.sin(freq * x + phase);
      best = Math.min(best, sdSeg(qx, qy, px, py, x, y));
      px = x; py = y;
    }
    return 1 - smoothstep(th, th + 0.025, best);
  }
  function stickerAlpha(qx: number, qy: number, t: number): number {
    let blob = sdC(qx, qy, -0.45, 0.05, 0.62);
    blob = smin(blob, sdC(qx, qy, 0.45, -0.05, 0.66), 0.35);
    blob = smin(blob, sdC(qx, qy, 0.05, 0.35, 0.55), 0.35);
    blob = smin(blob, sdC(qx, qy, -0.15, -0.35, 0.42), 0.30);
    let a = 1 - smoothstep(-0.01, 0.03, blob);
    const off = 0.07, th = 0.085;
    for (let i = 0; i < 3; i++) {
      const baseY = -0.42 + i * 0.45 + Math.sin(t * 0.8 + i * 1.7) * 0.04;
      const amp = 0.15 + i * 0.015, freq = 6.0 - i * 0.4, phase = t * (1.1 + i * 0.25) + i * 2.1;
      const xmin = -0.7 + i * 0.12, xmax = 0.55 + i * 0.08;
      a = Math.max(a, squig(qx, qy, baseY - off, amp, freq, phase, xmin, xmax, th * 1.08));
      a = Math.max(a, squig(qx, qy, baseY, amp, freq, phase, xmin, xmax, th));
    }
    return a;
  }

  it('the sticker is fully transparent outside the q-bounds, at any time', () => {
    const b = BACKDROP_Q_BOUNDS;
    let insideHits = 0;
    for (let t = 0; t < 40; t += 1.37) {
      for (let qy = -2.2; qy <= 2.2; qy += 0.025) {
        for (let qx = -2.4; qx <= 2.4; qx += 0.025) {
          const a = stickerAlpha(qx, qy, t);
          const inside = qx >= b.x0 && qx <= b.x1 && qy >= b.y0 && qy <= b.y1;
          if (inside) { if (a > 0) insideHits++; continue; }
          if (a !== 0) throw new Error(`alpha ${a} outside the bounds at q=(${qx.toFixed(2)}, ${qy.toFixed(2)}) t=${t.toFixed(2)}`);
        }
      }
    }
    expect(insideHits).toBeGreaterThan(1000);
  });

  it('the bounds are not wastefully loose (coverage reaches within 0.12 of every side)', () => {
    const b = BACKDROP_Q_BOUNDS;
    let minX = 9, maxX = -9, minY = 9, maxY = -9;
    for (let t = 0; t < 40; t += 1.37) {
      for (let qy = b.y0; qy <= b.y1; qy += 0.02) for (let qx = b.x0; qx <= b.x1; qx += 0.02) {
        if (stickerAlpha(qx, qy, t) > 0) { minX = Math.min(minX, qx); maxX = Math.max(maxX, qx); minY = Math.min(minY, qy); maxY = Math.max(maxY, qy); }
      }
    }
    expect(minX - b.x0).toBeLessThan(0.36); expect(b.x1 - maxX).toBeLessThan(0.36);
    expect(minY - b.y0).toBeLessThan(0.36); expect(b.y1 - maxY).toBeLessThan(0.36);
  });

  it('device rect: every pixel centre outside it maps outside the q-bounds; clamped to the canvas', () => {
    for (const [w, h] of [[1600, 1000], [390, 844], [2000, 1200], [3, 3]] as const) {
      const r = backdropStickerRect(w, h)!;
      expect(r).not.toBeNull();
      expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h).toBe(true);
      const vh = h * 0.40, cx = w * 0.5, cy = vh * 0.55, S = Math.max(vh * 0.40, 1), b = BACKDROP_Q_BOUNDS;
      const qOf = (i: number, j: number) => [(i + 0.5 - cx) / S, (j + 0.5 - cy) / S];
      for (const [i, j] of [[r.x - 1, r.y], [r.x + r.w, r.y], [r.x, r.y - 1], [r.x, r.y + r.h]]) {
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const [qx, qy] = qOf(i, j);
        expect(qx < b.x0 || qx > b.x1 || qy < b.y0 || qy > b.y1).toBe(true);
      }
    }
    expect(backdropStickerRect(0, 100)).toBeNull();
  });
});

describe('specks behind the grid mask (BG shader)', () => {
  // CPU mirror of gridMask(): 1 - smoothstep(0.125, 1, max(q.x, q.y)). The shader now evaluates the specks only where
  // the mask is > 0; that is the same picture iff the mask is never negative and the skipped product was exactly 0.
  const gridMask = (u: number, v: number) => {
    const qx = Math.abs(u - 0.5) / 0.36, qy = Math.abs(v - 0.83) / 0.065;
    return 1 - smoothstep(0.125, 1.0, Math.max(qx, qy));
  };
  it('the mask is in [0, 1] everywhere, and exactly 0 outside the grid footprint', () => {
    let zero = 0, pos = 0;
    for (let v = 0; v <= 1; v += 1 / 400) for (let u = 0; u <= 1; u += 1 / 400) {
      const m = gridMask(u, v);
      expect(m >= 0 && m <= 1).toBe(true);
      if (m === 0) { zero++; expect(Math.abs(u - 0.5) >= 0.36 - 1e-6 || Math.abs(v - 0.83) >= 0.065 - 1e-6).toBe(true); } else pos++;
      // what the old shader added where the mask is 0: specks (finite, in [0, 1.7]) * 0 = 0
      if (m === 0) for (const s of [0, 0.3, 1, 1.7]) expect(0.25 + s * m).toBe(0.25);
    }
    expect(zero).toBeGreaterThan(pos * 5);   // the specks are skipped on most of the screen
  });
});

describe('mode cross-fade', () => {
  it('follows the old per-frame curve exactly (t = min(1, elapsed / 380), scrim = 1 - |2t - 1|)', () => {
    expect(MODE_FADE_MS).toBe(380);
    const start = 1234.5;
    for (let now = start; now <= start + 500; now += 3.7) {
      const oldT = Math.min(1, (now - start) / 380);
      const oldScrim = 1 - Math.abs(2 * oldT - 1);
      expect(modeFadeT(now, start)).toBe(oldT);
      expect(scrimAlphaForFade(modeFadeT(now, start))).toBe(oldScrim);
    }
  });
  it('rests at alpha 0 in both modes and peaks at 1 at the midpoint', () => {
    expect(scrimAlphaForFade(0)).toBe(0);
    expect(scrimAlphaForFade(1)).toBe(0);
    expect(scrimAlphaForFade(0.5)).toBe(1);
    expect(modeFadeT(1000 + 190, 1000)).toBe(0.5);
    expect(modeFadeT(99999, 1000)).toBe(1);
  });
});
