/**
 * src/ui/kit/kit-layout.ts
 *
 * Lays every kit piece out into GPU prims (kit-prims.ts). Each widget is designed in its own DESIGN-px space around
 * (0, 0) — 1920x1080 reference — then placed by anchor + offset, scaled by min(W/1920, H/1080) and animated by one
 * intro/clip transform. Pure: no GPU, no DOM (text goes through the KitTextProvider seam), so it runs in unit tests.
 *
 * The look: stacked flat shapes (a shape, its offset "drop" copy behind, a border copy), hard slants, jagged
 * torn edges, halftone / stripe screen tones and outlined kinetic type in a red / black / white palette with one
 * accent. All shapes and type are original; only the style is the reference.
 */

import type { UIKitWidget, UIKitAnchor, UIKitPalette, UIKitTransitionType } from './kit-types';
import type { UIValue } from '../ui-types';
import { kitNum, kitStr, kitBool, kitColor, kitPalette, KIT_FONTS } from './kit-schema';
import { PrimList, PAT, FADE, type RGBA, type V2, type KitTextProvider, type PrimOpts } from './kit-prims';
import { kitRng, springSnap, dampedSine, easeInOutCubic, easeOutCubic, easeInCubic, easeOutBack, clamp01, type KitXf } from './kit-anim';

export const DESIGN_W = 1920, DESIGN_H = 1080;
export const designScale = (W: number, H: number): number => Math.max(0.05, Math.min(W / DESIGN_W, H / DESIGN_H));

export function anchorPoint(a: UIKitAnchor, W: number, H: number): V2 {
  const x = a === 'tl' || a === 'ml' || a === 'bl' ? 0 : a === 'tr' || a === 'mr' || a === 'br' ? W : W / 2;
  const y = a === 'tl' || a === 'tc' || a === 'tr' ? 0 : a === 'bl' || a === 'bc' || a === 'br' ? H : H / 2;
  return [x, y];
}

/** A pointer target in DEVICE px (convex polygon). */
export interface KitHit { id: string; poly: V2[]; z: number; }

/** Menu runtime state (selection + when it last moved, for the snap / wobble). */
export interface KitMenuState { sel: number; prev: number; changedAt: number; }

export interface KitLayoutCtx {
  list: PrimList;
  text: KitTextProvider;
  now: number;
  interactive: boolean;
  /** Static scale (design px → device px) WITHOUT the animation scale — text rasterises at this size. */
  ks: number;
  pal: Required<UIKitPalette>;
  vars: (id: string) => UIValue | undefined;
  menu?: KitMenuState;
  hits: KitHit[];
  z: number;
}

/** Stable id of a menu widget's item i — the click-trigger targetId ("<widgetId>#<slug>"). */
export function menuItems(w: UIKitWidget): string[] { return kitStr(w, 'items').split('|').map((s) => s.trim()).filter(Boolean); }
export function menuItemId(w: UIKitWidget, i: number): string {
  const label = menuItems(w)[i] ?? String(i);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || String(i);
  return `${w.id}#${slug}`;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────
const D2R = Math.PI / 180;
const withA = (c: RGBA, a: number): RGBA => [c[0], c[1], c[2], c[3] * a];
const col = (L: KitLayoutCtx, v: string): RGBA => kitColor(v, L.pal);
/** `{var}` placeholders → live UI variable values. */
function tmpl(L: KitLayoutCtx, s: string): string {
  return s.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_m, id: string) => { const v = L.vars(id); return v === undefined ? '' : String(v); });
}
/** A number prop that a variable can drive (when the variable id is set and defined). */
function numOrVar(L: KitLayoutCtx, w: UIKitWidget, key: string, varKey: string): number {
  const vid = kitStr(w, varKey);
  if (vid) { const v = Number(L.vars(vid)); if (Number.isFinite(v)) return v; }
  return kitNum(w, key);
}
function strOrVar(L: KitLayoutCtx, w: UIKitWidget, key: string, varKey: string): string {
  const vid = kitStr(w, varKey);
  if (vid) { const v = L.vars(vid); if (v !== undefined && v !== '') return String(v); }
  return kitStr(w, key);
}
function patOpts(L: KitLayoutCtx, w: UIKitWidget): PrimOpts {
  const p = kitStr(w, 'pattern') as keyof typeof PAT;
  return { pattern: PAT[p] ?? 0, color2: col(L, kitStr(w, 'patternColor')), patternScale: kitNum(w, 'patternScale'),
    patternAngle: kitNum(w, 'patternAngle') * D2R, patternAmount: kitNum(w, 'patternAmount') };
}
/** Register a box (local) as a pointer target. */
function hitBox(L: KitLayoutCtx, id: string, cx: number, cy: number, hw: number, hh: number, skew = 0): void {
  const sk = skew * hh;
  L.hits.push({ id, z: L.z, poly: [L.list.map(cx - hw + sk, cy - hh), L.list.map(cx + hw + sk, cy - hh), L.list.map(cx + hw - sk, cy + hh), L.list.map(cx - hw - sk, cy + hh)] });
}

interface TextOpts { align?: 'c' | 'l' | 'r'; slant?: number; rot?: number; shadow?: { color: RGBA; dx: number; dy: number }; outlineW?: number; }
/** Draw a text run; returns its width in design px. Centered on (x, y) unless aligned. */
function text(L: KitLayoutCtx, str: string, font: string, size: number, x: number, y: number, fill: RGBA, outline: RGBA | null, o: TextOpts = {}): number {
  if (!str) return 0;
  const slant = o.slant ?? 0;
  const px = Math.max(4, Math.round(size * L.ks));
  const ow = outline ? Math.max(0, Math.round((o.outlineW ?? size * 0.08) * L.ks)) : 0;
  const width = L.text.measure(str, font, size) + Math.abs(slant) * size;
  const g = L.text.get({ text: str, font, px, outline: ow, slant });
  if (!g) return width;
  const gw = g.w / L.ks;
  const cx = o.align === 'l' ? x + gw / 2 : o.align === 'r' ? x - gw / 2 : x;
  const scaleK = L.list.k / L.ks;
  const rot = o.rot ?? 0;
  if (o.shadow) L.list.glyph(cx + o.shadow.dx, y + o.shadow.dy, g, o.shadow.color, o.shadow.color, 1, rot, scaleK);
  L.list.glyph(cx, y, g, fill, outline ?? fill, 0, rot, scaleK);
  return width;
}

/** Contrasting letter colour for a tile colour. */
function contrast(L: KitLayoutCtx, tile: RGBA): RGBA {
  const lum = 0.299 * tile[0] + 0.587 * tile[1] + 0.114 * tile[2];
  return lum > 0.55 ? col(L, 'ink') : col(L, 'paper');
}

/** Cut-out ransom letters centred at (0, 0). Returns [half width, half height]. */
function ransomText(L: KitLayoutCtx, str: string, size: number, seed: number, o: { jitter: number; spacing: number; tiles: boolean; mix: boolean; outlines: boolean }): V2 {
  const rng = kitRng(seed * 7919 + 13);
  const chars = [...str];
  const tileCols: RGBA[] = [col(L, 'paper'), col(L, 'ink'), col(L, 'primary'), col(L, 'paper'), col(L, 'accent'), col(L, 'ink')];
  let lastTile: RGBA | null = null;
  const cells = chars.map((ch) => {
    const font = o.mix ? KIT_FONTS[Math.floor(rng() * KIT_FONTS.length)] : 'impact';
    const mul = 0.84 + rng() * 0.34;
    const rot = (rng() - 0.5) * 2 * o.jitter * D2R;
    const dy = (rng() - 0.5) * 0.18 * size;
    let ti = Math.floor(rng() * tileCols.length);
    const same = (a: RGBA | null, b: RGBA) => !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    for (let k = 0; k < 4 && same(lastTile, tileCols[ti]); k++) ti = (ti + 1 + Math.floor(rng() * 3)) % tileCols.length;
    const tile = tileCols[ti];
    lastTile = tile;
    const hollow = o.outlines && rng() < 0.24;
    const jit = [rng(), rng(), rng(), rng(), rng(), rng(), rng(), rng()];
    const space = ch.trim() === '';
    const cw = space ? size * 0.36 : L.text.measure(ch, font, size * mul);
    const adv = space ? cw : cw + size * (o.tiles ? 0.34 : 0.1) + o.spacing * size;
    return { ch, font, mul, rot, dy, tile, hollow, jit, space, cw, adv };
  });
  const total = cells.reduce((a, c) => a + c.adv, 0);
  let x = -total / 2;
  for (const c of cells) {
    const cx = x + c.adv / 2;
    x += c.adv;
    if (c.space) continue;
    const s = size * c.mul;
    L.list.save(); L.list.translate(cx, c.dy); L.list.rotate(c.rot);
    if (o.tiles) {
      const hw = (c.cw + size * 0.26) / 2, hh = s * 0.6, j = size * 0.06;
      const q: V2[] = [[-hw - c.jit[0] * j, -hh - c.jit[1] * j], [hw + c.jit[2] * j, -hh - c.jit[3] * j], [hw + c.jit[4] * j, hh + c.jit[5] * j], [-hw - c.jit[6] * j, hh + c.jit[7] * j]];
      L.list.poly(size * 0.05, size * 0.06, q, withA(col(L, 'ink'), 0.85));   // cut-out shadow
      L.list.poly(0, 0, q, c.tile);
      const ink = contrast(L, c.tile);
      if (c.hollow) text(L, c.ch, c.font, s, 0, 0, c.tile, ink, { outlineW: s * 0.07 });
      else text(L, c.ch, c.font, s, 0, 0, ink, null);
    } else {
      const fill = c.hollow ? col(L, 'primary') : (c.jit[0] < 0.5 ? col(L, 'paper') : col(L, 'primary'));
      text(L, c.ch, c.font, s, 0, 0, fill, col(L, 'ink'), { outlineW: s * 0.09, shadow: { color: col(L, 'ink'), dx: size * 0.05, dy: size * 0.06 } });
    }
    L.list.restore();
  }
  return [total / 2 + size * 0.1, size * 0.7];
}

/** A slanted-end bar (frame, back, fill, gloss, label, number). */
function bar(L: KitLayoutCtx, cx: number, cy: number, w: number, h: number, sl: number, frac: number, fill: RGBA, label: string, num: string, back: RGBA, frame: RGBA): void {
  const f = clamp01(frac);
  L.list.slant(cx + 3, cy + 4, w + 8, h + 8, sl, withA(col(L, 'ink'), 0.9));
  L.list.slant(cx, cy, w + 8, h + 8, sl, frame);
  L.list.slant(cx, cy, w, h, sl, back, { pattern: PAT.lines, color2: withA(col(L, 'paper'), 0.08), patternScale: 6, patternAngle: 60 * D2R, patternAmount: 0.3 });
  if (f > 0.002) {
    const fw = w * f;
    L.list.slant(cx - w / 2 + fw / 2, cy, fw, h, sl, fill);
    L.list.slant(cx - w / 2 + fw / 2, cy - h * 0.27, fw, h * 0.2, sl, withA(col(L, 'paper'), 0.4));
  }
  if (label) text(L, label, 'impact', h * 1.45, cx - w / 2 - h * 0.25, cy - h * 0.05, col(L, 'paper'), col(L, 'ink'), { align: 'r', slant: 0.2, outlineW: h * 0.22 });
  if (num) text(L, num, 'impact', h * 1.25, cx + w / 2 - h * 0.2, cy - h * 1.05, col(L, 'paper'), col(L, 'ink'), { align: 'r', slant: 0.15, outlineW: h * 0.2 });
}

// ── per-kind layouts (local design px around 0,0). Each returns its hit half-extents [hw, hh]. ────────────────
type LayoutFn = (L: KitLayoutCtx, w: UIKitWidget) => V2;

const LAYOUTS: Record<UIKitWidget['kind'], LayoutFn> = {
  panel(L, w) {
    const W = kitNum(w, 'w'), H = kitNum(w, 'h'), sk = kitNum(w, 'skew');
    const jag = { jag: kitNum(w, 'jag'), jagWave: kitNum(w, 'jagWave'), seed: kitNum(w, 'seed') };
    if (kitBool(w, 'drop')) L.list.slant(kitNum(w, 'dropX'), kitNum(w, 'dropY'), W, H, sk, col(L, kitStr(w, 'dropColor')), { ...jag, seed: jag.seed + 11 });
    const b = kitNum(w, 'border');
    if (b > 0) L.list.slant(0, 0, W + 2 * b, H + 2 * b, sk, col(L, kitStr(w, 'borderColor')), jag);
    L.list.slant(0, 0, W, H, sk, col(L, kitStr(w, 'fill')), { ...patOpts(L, w), ...jag });
    return [W / 2 + Math.abs(sk) * H / 2, H / 2];
  },

  card(L, w) {
    const W = kitNum(w, 'w'), H = kitNum(w, 'h'), b = kitNum(w, 'border'), cut = Math.min(kitNum(w, 'cornerCut'), H * 0.8);
    const shape = (hw: number, hh: number): V2[] => [[-hw, -hh + cut], [hw, -hh], [hw, hh], [-hw, hh]];
    if (kitBool(w, 'drop')) L.list.poly(kitNum(w, 'dropX'), kitNum(w, 'dropY'), shape(W / 2 + b, H / 2 + b), col(L, kitStr(w, 'dropColor')));
    if (b > 0) L.list.poly(0, 0, shape(W / 2 + b, H / 2 + b), col(L, kitStr(w, 'borderColor')));
    L.list.poly(0, 0, shape(W / 2, H / 2), col(L, kitStr(w, 'fill')), patOpts(L, w));
    // emblem: a ringed burst
    const r = Math.min(W, H) * 0.26;
    L.list.star(0, -H * 0.06, r * 1.25, r * 1.25, 10, 0.55, col(L, 'paper'), {}, 0.3, 0.25);
    L.list.star(0, -H * 0.06, r * 1.0, r * 1.0, 10, 0.55, col(L, 'ink'), {}, 0.3, 0.25);
    L.list.ellipse(0, -H * 0.06, r * 0.42, r * 0.42, col(L, 'primary'));
    const title = tmpl(L, kitStr(w, 'title'));
    if (title) {
      const ts = kitNum(w, 'titleSize');
      const tw = L.text.measure(title, kitStr(w, 'font'), ts);
      L.list.slant(0, H / 2 - ts * 0.85, Math.min(W * 0.96, tw + ts * 1.2), ts * 1.15, -0.3, col(L, 'primary'));
      text(L, title, kitStr(w, 'font'), ts, 0, H / 2 - ts * 0.88, col(L, kitStr(w, 'titleColor')), col(L, 'ink'), { slant: 0.18, outlineW: ts * 0.1 });
    }
    return [W / 2 + b, H / 2 + b];
  },

  tone(L, w) {
    const W = kitNum(w, 'w'), H = kitNum(w, 'h');
    const p = kitStr(w, 'pattern') as keyof typeof PAT;
    const c = col(L, kitStr(w, 'color'));
    L.list.rect(0, 0, W, H, [0, 0, 0, 0], {
      pattern: PAT[p] ?? PAT.halftone, color2: withA(c, kitNum(w, 'alpha')), patternScale: kitNum(w, 'patternScale'),
      patternAngle: kitNum(w, 'patternAngle') * D2R, patternAmount: kitNum(w, 'patternAmount'), fade: FADE[kitStr(w, 'fade') as keyof typeof FADE] ?? 0,
    });
    return [0, 0];   // never a pointer target
  },

  heading(L, w) {
    const str = tmpl(L, kitStr(w, 'text')), size = kitNum(w, 'size'), font = kitStr(w, 'font'), slant = kitNum(w, 'slant');
    const tw = L.text.measure(str, font, size) + Math.abs(slant) * size;
    if (kitBool(w, 'underline')) {
      L.list.slant(size * 0.12, size * 0.44, tw * 1.08, size * 0.24, -1.1, col(L, 'ink'), {}, -0.035);
      L.list.slant(size * 0.04, size * 0.38, tw * 1.04, size * 0.2, -1.1, col(L, kitStr(w, 'underlineColor')), {}, -0.035);
    }
    text(L, str, font, size, 0, 0, col(L, kitStr(w, 'fill')), kitNum(w, 'outlineW') > 0 ? col(L, kitStr(w, 'outline')) : null, {
      slant, outlineW: kitNum(w, 'outlineW'),
      shadow: { color: col(L, kitStr(w, 'shadow')), dx: kitNum(w, 'shadowX'), dy: kitNum(w, 'shadowY') },
    });
    return [tw / 2, size * 0.6];
  },

  ransom(L, w) {
    return ransomText(L, tmpl(L, kitStr(w, 'text')), kitNum(w, 'size'), kitNum(w, 'seed'), {
      jitter: kitNum(w, 'jitter'), spacing: kitNum(w, 'spacing'), tiles: kitBool(w, 'tiles'), mix: kitBool(w, 'mixFonts'), outlines: kitBool(w, 'outlineLetters'),
    });
  },

  bar(L, w) {
    const v = numOrVar(L, w, 'value', 'valueVar'), mx = Math.max(1e-6, numOrVar(L, w, 'max', 'maxVar'));
    const W = kitNum(w, 'w'), H = kitNum(w, 'h');
    bar(L, 0, 0, W, H, kitNum(w, 'slant'), v / mx, col(L, kitStr(w, 'fillColor')), tmpl(L, kitStr(w, 'label')),
      kitBool(w, 'showNumber') ? String(Math.round(v)) : '', col(L, kitStr(w, 'back')), col(L, kitStr(w, 'frame')));
    return [W / 2 + H, H];
  },

  status(L, w) {
    const ink = col(L, 'ink'), paper = col(L, 'paper'), prim = col(L, 'primary');
    // body panel + red drop
    L.list.slant(70 + 14, 12, 430, 150, 0.24, prim, { jag: 2.5, jagWave: 40, seed: 5 });
    L.list.slant(70, 0, 430, 150, 0.24, ink, { pattern: PAT.lines, color2: withA(paper, 0.07), patternScale: 7, patternAngle: -30 * D2R, patternAmount: 0.25 });
    // portrait card
    L.list.save(); L.list.translate(-170, -6); L.list.rotate(-0.1);
    L.list.rect(10, 12, 158, 158, ink);
    L.list.rect(0, 0, 158, 158, paper);
    L.list.rect(0, 0, 140, 140, col(L, kitStr(w, 'portraitColor')), { pattern: PAT.gradient, color2: withA(ink, 0.55), patternScale: 9, patternAngle: 45 * D2R, patternAmount: 1 });
    const portrait = kitStr(w, 'portrait');
    if (portrait === 'silhouette') {
      L.list.ellipse(0, -14, 30, 34, ink);
      L.list.poly(0, 48, [[-56, 22], [-38, -16], [38, -16], [56, 22]], ink);
    } else if (portrait === 'star') {
      L.list.star(0, 0, 54, 54, 5, 0.45, ink, {}, -Math.PI / 2, 0);
    } else {   // a domino mask with sharp wings
      L.list.poly(0, -2, [[-62, -10], [62, -10], [44, 22], [-44, 22]], ink);
      L.list.poly(-60, -14, [[-14, -16], [10, 4], [-4, 12]], ink);
      L.list.poly(60, -14, [[14, -16], [-10, 4], [4, 12]], ink);
      L.list.ellipse(-24, 4, 14, 9, paper);
      L.list.ellipse(24, 4, 14, 9, paper);
    }
    L.list.restore();
    // name + level
    text(L, tmpl(L, kitStr(w, 'name')), 'impact', 54, -70, -42, paper, ink, { align: 'l', slant: 0.2, outlineW: 6, shadow: { color: prim, dx: 5, dy: 4 } });
    L.list.slant(224, -48, 92, 36, -0.35, col(L, 'accent'));
    text(L, `LV ${Math.round(kitNum(w, 'level'))}`, 'impact', 28, 224, -49, ink, null, { slant: 0.2 });
    const hp = numOrVar(L, w, 'hp', 'hpVar'), sp = numOrVar(L, w, 'sp', 'spVar');
    bar(L, 120, 14, 270, 22, 0.6, hp / Math.max(1, kitNum(w, 'hpMax')), col(L, kitStr(w, 'hpColor')), 'HP', String(Math.round(hp)), ink, paper);
    bar(L, 108, 56, 246, 16, 0.6, sp / Math.max(1, kitNum(w, 'spMax')), col(L, kitStr(w, 'spColor')), 'SP', '', ink, paper);
    text(L, String(Math.round(sp)), 'impact', 22, 250, 56, paper, ink, { align: 'l', slant: 0.15, outlineW: 4 });
    return [290, 90];
  },

  date(L, w) {
    const ink = col(L, 'ink'), paper = col(L, 'paper'), prim = col(L, 'primary');
    const day = numOrVar(L, w, 'day', 'dayVar');
    const wd = kitStr(w, 'weekday').toUpperCase(), time = strOrVar(L, w, 'time', 'timeVar').toUpperCase();
    const weather = strOrVar(L, w, 'weather', 'weatherVar');
    L.list.save(); L.list.rotate(-0.07);
    L.list.slant(16, -14, 380, 118, 0.3, prim, { jag: 3, jagWave: 34, seed: 9 });
    L.list.slant(0, -26, 380, 118, 0.3, ink, { pattern: PAT.halftone, color2: withA(paper, 0.12), patternScale: 9, patternAmount: 0.5 });
    text(L, `${Math.round(kitNum(w, 'month'))}/${Math.round(day)}`, 'impact', 118, -40, -30, paper, ink, { slant: 0.16, outlineW: 7, shadow: { color: prim, dx: 8, dy: 7 } });
    L.list.restore();
    // weekday tile
    L.list.save(); L.list.translate(150, -54); L.list.rotate(0.1);
    L.list.slant(5, 6, 112, 62, -0.3, ink);
    L.list.slant(0, 0, 112, 62, -0.3, paper);
    text(L, wd, 'impact', 50, 0, -1, wd === 'SUN' || wd === 'SAT' ? prim : ink, null, { slant: 0.15 });
    L.list.restore();
    // time-of-day strip
    const tsz = 38, tw = Math.max(200, L.text.measure(time, 'impact', tsz) + 70);
    L.list.slant(40 + 8, 72 + 7, tw, 54, -0.45, ink);
    L.list.slant(40, 72, tw, 54, -0.45, prim, { pattern: PAT.stripes, color2: withA(ink, 0.18), patternScale: 12, patternAngle: -60 * D2R, patternAmount: 0.35 });
    text(L, time, 'impact', tsz, 40, 70, paper, ink, { slant: 0.2, outlineW: 5 });
    // weather badge
    L.list.save(); L.list.translate(-176, 66);
    L.list.ellipse(4, 5, 48, 48, ink);
    L.list.ellipse(0, 0, 48, 48, paper);
    L.list.ellipse(0, 0, 48, 48, ink, {}, 5);
    if (weather === 'sunny') {
      L.list.star(0, 0, 34, 34, 12, 0.62, col(L, 'accent'), {}, L.interactive ? L.now * 0.0006 : 0, 0.1);
      L.list.ellipse(0, 0, 17, 17, prim);
    } else if (weather === 'night') {
      L.list.ellipse(0, 0, 26, 26, col(L, 'accent'));
      L.list.ellipse(11, -8, 22, 22, paper);
    } else {
      const cloud = weather === 'rain' ? withA(ink, 0.85) : withA(ink, 0.75);
      L.list.ellipse(-12, 2, 16, 13, cloud); L.list.ellipse(6, -6, 18, 16, cloud); L.list.ellipse(18, 5, 13, 11, cloud);
      L.list.rect(2, 9, 44, 12, cloud);
      if (weather === 'rain') for (let i = 0; i < 3; i++) L.list.slant(-12 + i * 13, 28, 4, 14, 0.5, col(L, '#3cc8ff'));
    }
    L.list.restore();
    return [230, 120];
  },

  minimap(L, w) {
    const S = kitNum(w, 'size'), shape = kitStr(w, 'shape');
    const ink = col(L, 'ink'), paper = col(L, 'paper'), prim = col(L, 'primary');
    const frameRot = shape === 'diamond' ? Math.PI / 4 : 0;
    const half = S / 2;
    // drop (screen-space offset)
    if (shape === 'circle') L.list.ellipse(12, 14, half + 12, half + 12, prim);
    else { L.list.save(); L.list.translate(12, 14); L.list.rotate(frameRot); L.list.rect(0, 0, S + 24, S + 24, prim); L.list.restore(); }
    L.list.save(); L.list.rotate(frameRot);
    const bg: RGBA = kitColor('#1b2030', L.pal);
    const inner = shape === 'circle' ? half * 0.7 : half * 0.94;
    if (shape === 'circle') L.list.ellipse(0, 0, half, half, bg, { pattern: PAT.lines, color2: withA(paper, 0.05), patternScale: 8, patternAmount: 0.2 });
    else L.list.rect(0, 0, S, S, bg, { pattern: PAT.lines, color2: withA(paper, 0.05), patternScale: 8, patternAmount: 0.2 });
    // streets (stylised): a seeded grid of avenues + lanes, kept inside the frame
    const rng = kitRng(kitNum(w, 'seed') * 31 + 7);
    const street = withA(paper, 0.78), lane = withA(paper, 0.4);
    for (let i = 0; i < 4; i++) {
      const t = -inner + (i + 0.5 + (rng() - 0.5) * 0.5) * (2 * inner / 4);
      L.list.rect(t, 0, S * (i % 2 ? 0.035 : 0.06), inner * 2, i % 2 ? lane : street);
      const u = -inner + (i + 0.5 + (rng() - 0.5) * 0.5) * (2 * inner / 4);
      L.list.rect(0, u, inner * 2, S * (i % 2 ? 0.035 : 0.055), i % 2 ? lane : street);
    }
    for (let i = 0; i < 5; i++) L.list.rect((rng() - 0.5) * inner * 1.6, (rng() - 0.5) * inner * 1.6, S * 0.07, S * 0.07, withA(col(L, 'accent'), 0.85));
    L.list.ellipse((rng() - 0.5) * inner, (rng() - 0.5) * inner, S * 0.035, S * 0.035, prim);
    // frame on top (clips any street end)
    if (shape === 'circle') { L.list.ellipse(0, 0, half + 2, half + 2, ink, {}, half * 0.3 + 6); L.list.ellipse(0, 0, half + 10, half + 10, paper, {}, 10); }
    else {
      const bw = S * 0.04 + 6;
      for (const [x, y, ww, hh] of [[0, -half - 2, S + 8, bw], [0, half + 2, S + 8, bw], [-half - 2, 0, bw, S + 8], [half + 2, 0, bw, S + 8]] as const) L.list.rect(x, y, ww, hh, ink);
      for (const [x, y, ww, hh] of [[0, -half - 10, S + 26, 10], [0, half + 10, S + 26, 10], [-half - 10, 0, 10, S + 26], [half + 10, 0, 10, S + 26]] as const) L.list.rect(x, y, ww, hh, paper);
    }
    L.list.restore();
    // player arrow (screen-relative heading)
    const hd = numOrVar(L, w, 'heading', 'headingVar') * D2R;
    L.list.save(); L.list.rotate(hd);
    L.list.poly(0, 0, [[0, -26], [19, 18], [-19, 18]], ink);
    L.list.poly(0, 2, [[0, -17], [12, 12], [-12, 12]], prim);
    L.list.restore();
    // north tile
    const top = shape === 'diamond' ? -half * Math.SQRT2 - 6 : -half - 14;
    L.list.ellipse(0, top, 21, 21, ink); L.list.ellipse(0, top, 21, 21, paper, {}, 3);
    text(L, 'N', 'impact', 26, 0, top, paper, null);
    // district label
    const label = tmpl(L, kitStr(w, 'label'));
    if (label) {
      const by = (shape === 'diamond' ? half * Math.SQRT2 : half) + 34;
      const lw = L.text.measure(label, 'impact', 34) + 60;
      L.list.slant(8, by + 6, lw, 46, -0.35, prim);
      L.list.slant(0, by, lw, 46, -0.35, ink);
      text(L, label, 'impact', 34, 0, by - 1, paper, null, { slant: 0.18 });
    }
    const ext = shape === 'diamond' ? half * Math.SQRT2 : half;
    return [ext + 14, ext + 14];
  },

  prompt(L, w) {
    const z = kitNum(w, 'size'), style = kitStr(w, 'style');
    const ink = col(L, 'ink'), paper = col(L, 'paper');
    const label = tmpl(L, kitStr(w, 'label'));
    const lw = label ? L.text.measure(label, 'impact', z * 0.62) + z * 0.9 : 0;
    if (label) {
      L.list.slant(z * 0.35 + lw / 2 + 4, 4, lw + z * 0.4, z * 0.82, -0.35, col(L, 'primary'));
      L.list.slant(z * 0.35 + lw / 2, 0, lw + z * 0.4, z * 0.82, -0.35, ink);
      text(L, label, 'impact', z * 0.62, z * 0.5 + lw / 2, -1, paper, null, { slant: 0.18 });
    }
    const key = tmpl(L, kitStr(w, 'key'));
    const kw = L.text.measure(key, 'impact', z * 0.66);
    const r = z * 0.58;
    if (style === 'circle' && kw < r * 1.3) { L.list.ellipse(3, 4, r, r, ink); L.list.ellipse(0, 0, r, r, paper); L.list.ellipse(0, 0, r, r, ink, {}, z * 0.08); }
    else if (style === 'diamond' && kw < r) { L.list.rect(3, 4, r * 1.5, r * 1.5, ink, {}, Math.PI / 4); L.list.rect(0, 0, r * 1.5, r * 1.5, paper, {}, Math.PI / 4); }
    else {   // a key cap as wide as its label (ESC, arrows…)
      const cw = Math.max(r * 1.8, kw + z * 0.5), cx = (cw - r * 1.8) / 2;
      L.list.slant(-cx + 3, 4, cw, r * 1.8, -0.12, ink); L.list.slant(-cx, 0, cw, r * 1.8, -0.12, paper);
      text(L, key, 'impact', z * 0.66, -cx, 0, ink, null);
      return [r + lw / 2 + z * 0.4 + cx, r];
    }
    text(L, key, 'impact', z * 0.7, 0, 0, ink, null);
    return [r + lw / 2 + z * 0.4, r];
  },

  menu(L, w) {
    const items = menuItems(w);
    const n = Math.max(1, items.length);
    const size = kitNum(w, 'size'), sp = kitNum(w, 'spacing'), stg = kitNum(w, 'stagger'), font = kitStr(w, 'font');
    const m = L.menu ?? { sel: kitNum(w, 'selected'), prev: kitNum(w, 'selected'), changedAt: -1e9 };
    const sel = Math.max(0, Math.min(n - 1, Math.round(m.sel))), prev = Math.max(0, Math.min(n - 1, Math.round(m.prev)));
    const pos = (i: number): V2 => [i * stg - (n - 1) * stg / 2, i * sp - (n - 1) * sp / 2];
    const widths = items.map((s) => L.text.measure(s, font, size) + size * 0.3);
    // snap + wobble of the highlight
    const t = (L.now - m.changedAt) / 260;
    const k = springSnap(t, 1.25, 6.5);
    const [px, py] = pos(prev), [sx, sy] = pos(sel);
    const hx = px + (sx - px) * k, hy = py + (sy - py) * k;
    const hwid = (widths[prev] ?? 0) + ((widths[sel] ?? 0) - (widths[prev] ?? 0)) * k;
    const wob = kitNum(w, 'wobble');
    const rot = wob * (0.15 * dampedSine(clamp01(t * 0.7), 2.4, 4.2) + (L.interactive ? 0.018 * Math.sin(L.now * 0.0042) : 0)) - 0.035;
    L.list.save(); L.list.translate(hx, hy); L.list.rotate(rot);
    L.list.slant(-size * 0.32, size * 0.16, hwid + size * 1.15, size * 1.18, -0.42, col(L, 'ink'));
    L.list.slant(size * 0.08, size * 0.02, hwid + size * 1.15, size * 1.12, -0.42, col(L, 'paper'));
    L.list.slant(0, 0, hwid + size * 0.95, size * 1.0, -0.42, col(L, kitStr(w, 'highlight')), { jag: size * 0.05, jagWave: size * 0.5, seed: sel * 3 + 1 });
    L.list.restore();
    items.forEach((label, i) => {
      const [x, y] = pos(i);
      const tilt = (((i * 7) % 5) - 2) * 0.03;
      const isSel = i === sel;
      L.list.save(); L.list.translate(x, y); L.list.rotate(tilt + (isSel ? rot : 0));
      if (isSel) {
        L.list.scale(1 + 0.12 * Math.min(1, k));
        text(L, label, font, size, 0, 0, col(L, kitStr(w, 'selText')), col(L, 'paper'), { slant: 0.2, outlineW: size * 0.07 });
      } else {
        text(L, label, font, size, 0, 0, col(L, kitStr(w, 'text')), col(L, 'ink'), { slant: 0.2, outlineW: size * 0.11, shadow: { color: withA(col(L, 'ink'), 0.9), dx: size * 0.06, dy: size * 0.07 } });
      }
      L.list.restore();
      L.list.save(); L.list.translate(x, y);
      hitBox(L, menuItemId(w, i), 0, 0, widths[i] / 2 + size * 0.4, sp * 0.45, -0.3);
      L.list.restore();
    });
    if (kitBool(w, 'cursor')) {
      const bob = L.interactive ? Math.sin(L.now * 0.012) * size * 0.12 : 0;
      L.list.save(); L.list.translate(hx - hwid / 2 - size * 0.95 + bob, hy + size * 0.05); L.list.rotate(rot * 1.5 - 0.12);
      const s = size * 1.15;
      const head: V2[] = [[-s * 0.2, -s * 0.46], [s * 0.5, 0], [-s * 0.2, s * 0.46]];
      L.list.poly(s * 0.07, s * 0.09, head, col(L, 'ink'));
      L.list.slant(-s * 0.42 + s * 0.07, s * 0.09, s * 0.5, s * 0.3, 0, col(L, 'ink'));
      L.list.poly(0, 0, head, col(L, 'paper'));
      L.list.slant(-s * 0.42, 0, s * 0.5, s * 0.3, 0, col(L, 'paper'));
      L.list.poly(s * 0.03, 0, [[-s * 0.08, -s * 0.28], [s * 0.34, 0], [-s * 0.08, s * 0.28]], col(L, 'primary'));
      L.list.slant(-s * 0.36, 0, s * 0.42, s * 0.14, 0, col(L, 'primary'));
      L.list.restore();
    }
    const maxW = Math.max(...widths, 1);
    return [maxW / 2 + Math.abs(stg) * n / 2 + size, n * sp / 2];
  },

  splash(L, w) {
    const size = kitNum(w, 'size'), str = tmpl(L, kitStr(w, 'text')), seed = kitNum(w, 'seed');
    const ink = col(L, 'ink'), paper = col(L, 'paper'), prim = col(L, 'primary');
    const spin = L.interactive ? L.now * 0.00025 : 0;
    const tw = L.text.measure(str, 'impact', size) * (kitStr(w, 'textStyle') === 'heading' ? 1 : 1.45);
    const rx = Math.max(size * 2.3, tw * 0.62), ry = size * 1.3;
    if (kitBool(w, 'stripes')) L.list.rays(0, 0, rx * 1.9, ry * 2.3, 20, withA(prim, 0.9), withA(ink, 0.85), spin, 0.2);
    if (kitBool(w, 'burst')) {
      const sp = Math.round(kitNum(w, 'spikes'));
      L.list.star(0, 0, rx * 1.16, ry * 1.3, sp, 0.66, ink, {}, -spin * 2, 0.35);
      L.list.star(0, 0, rx * 1.04, ry * 1.16, sp, 0.68, col(L, kitStr(w, 'burstColor')), { pattern: PAT.halftone, color2: withA(ink, 0.35), patternScale: 11, patternAmount: 0.45 }, -spin * 2, 0.35);
      L.list.star(0, 0, rx * 0.8, ry * 0.86, sp + 3, 0.8, paper, {}, 0.4 - spin * 2, 0.25);
    }
    L.list.save(); L.list.rotate(-0.09);
    if (kitStr(w, 'textStyle') === 'heading') text(L, str, 'impact', size, 0, 0, paper, ink, { slant: 0.2, outlineW: size * 0.09, shadow: { color: prim, dx: size * 0.07, dy: size * 0.06 } });
    else ransomText(L, str, size, seed, { jitter: 9, spacing: 0.02, tiles: true, mix: true, outlines: true });
    L.list.restore();
    return [rx, ry];
  },

  damage(L, w) {
    const size = kitNum(w, 'size'), crit = kitBool(w, 'crit');
    const ink = col(L, 'ink'), prim = col(L, 'primary');
    const str = tmpl(L, kitStr(w, 'value'));
    const tw = L.text.measure(str, 'impact', size);
    if (crit) {
      L.list.star(0, 0, tw * 0.85, size * 0.95, 12, 0.6, ink, {}, 0.2, 0.4);
      L.list.star(0, 0, tw * 0.75, size * 0.85, 12, 0.6, prim, {}, 0.2, 0.4);
      L.list.slant(0, -size * 0.78, size * 2.6, size * 0.36, -0.4, ink);
      text(L, 'CRITICAL', 'impact', size * 0.3, 0, -size * 0.79, col(L, 'accent'), null, { slant: 0.2 });
    }
    text(L, str, 'impact', size, 0, 0, col(L, kitStr(w, 'color')), ink, { slant: 0.2, rot: -0.06, outlineW: size * 0.1, shadow: { color: crit ? col(L, 'paper') : prim, dx: size * 0.06, dy: size * 0.06 } });
    return [tw / 2 + 10, size * 0.6];
  },

  banner(L, w) {
    const W = kitNum(w, 'w');
    const ink = col(L, 'ink'), paper = col(L, 'paper'), prim = col(L, 'primary');
    const fill = col(L, kitStr(w, 'fill')), stripe = col(L, kitStr(w, 'stripe'));
    L.list.slant(12, 12, W, 112, -0.36, prim);
    L.list.slant(0, 0, W, 112, -0.36, fill, { pattern: PAT.gradient, color2: withA(paper, 0.14), patternScale: 10, patternAngle: 30 * D2R, patternAmount: 1 });
    L.list.slant(-W * 0.3, -50, W * 0.36, 16, -0.36, stripe);
    L.list.slant(W * 0.42, 50, W * 0.12, 12, -0.36, paper);
    text(L, tmpl(L, kitStr(w, 'title')), 'impact', 68, -W / 2 + 64, -6, paper, null, { align: 'l', slant: 0.2, shadow: { color: stripe, dx: 5, dy: 4 } });
    const sub = tmpl(L, kitStr(w, 'subtitle'));
    if (sub) {
      const sw = L.text.measure(sub, 'impact', 28) + 40;
      L.list.slant(W * 0.5 - sw / 2 - 30, 64, sw, 40, -0.36, ink);
      L.list.slant(W * 0.5 - sw / 2 - 36, 58, sw, 40, -0.36, stripe);
      text(L, sub, 'impact', 28, W * 0.5 - sw / 2 - 36, 57, paper, null, { slant: 0.18 });
    }
    return [W / 2 + 20, 70];
  },

  callout(L, w) {
    const ink = col(L, 'ink'), paper = col(L, 'paper'), prim = col(L, 'primary');
    const z = kitNum(w, 'size');
    L.list.save(); L.list.scale(z);
    const tail = kitStr(w, 'tail');
    const tailPoly: V2[] | null = tail === 'down' ? [[-30, 0], [10, 0], [-34, 62]] : tail === 'left' ? [[0, -20], [0, 18], [-70, 30]] : tail === 'right' ? [[0, -20], [0, 18], [70, 30]] : null;
    const tailAt: V2 = tail === 'down' ? [-30, 40] : tail === 'left' ? [-140, 10] : [140, 10];
    if (tailPoly) { L.list.poly(tailAt[0] + 8, tailAt[1] + 8, tailPoly, ink); }
    L.list.slant(10, 10, 290, 96, -0.18, ink, { jag: 6, jagWave: 22, seed: 3 });
    if (tailPoly) L.list.poly(tailAt[0], tailAt[1], tailPoly, paper);
    L.list.slant(0, 0, 290, 96, -0.18, paper, { jag: 6, jagWave: 22, seed: 3 });
    L.list.ellipse(-110, -4, 36, 36, ink);
    L.list.ellipse(-110, -4, 31, 31, prim);
    text(L, tmpl(L, kitStr(w, 'icon')), 'impact', 50, -110, -5, paper, null);
    text(L, tmpl(L, kitStr(w, 'text')), 'impact', 50, 14, -2, ink, null, { slant: 0.2 });
    const key = tmpl(L, kitStr(w, 'key'));
    if (key) { L.list.rect(116, 40, 58, 58, prim, {}, Math.PI / 4); L.list.rect(112, 36, 58, 58, ink, {}, Math.PI / 4); text(L, key, 'impact', 34, 112, 35, paper, null); }
    L.list.restore();
    return [160 * z, 60 * z];
  },
};

/** Lay one widget out into `L.list` (device px) and register its pointer targets. `xf` = the animation transform.
 *  `pointer` = register the whole widget as a pointer target (it has interaction props). */
export function layoutWidget(L: KitLayoutCtx, w: UIKitWidget, Wd: number, Hd: number, xf: KitXf, pointer: boolean): void {
  const s = designScale(Wd, Hd), sc = w.scale ?? 1;
  const full = w.kind === 'tone' && kitBool(w, 'full');
  const [ax, ay] = full ? [Wd / 2, Hd / 2] : anchorPoint(w.anchor, Wd, Hd);
  const ox = full ? 0 : w.x, oy = full ? 0 : w.y;
  L.ks = s * sc;
  L.pal = kitPalette(w);
  const lst = L.list;
  lst.resetXf();
  lst.alpha = Math.max(0, Math.min(1, (w.opacity ?? 1) * xf.alpha));
  if (lst.alpha <= 0.001) return;
  lst.translate(ax + (ox + xf.dx) * s, ay + (oy + xf.dy) * s);
  lst.rotate(((full ? 0 : w.rotation ?? 0) * D2R) + xf.rot);
  lst.scale(s * sc * xf.scale);
  const ww = full ? { ...w, props: { ...w.props, w: Wd / s, h: Hd / s } } : w;
  const [hw, hh] = LAYOUTS[w.kind]?.(L, ww) ?? [0, 0];
  if (pointer && hw > 0 && hh > 0) hitBox(L, w.id, 0, 0, hw, hh);
}

// ── Transitions (full screen, device px) ──────────────────────────────────────────────────────────────────
export const KIT_TRANSITION_DEFAULT_MS: Record<UIKitTransitionType, number> = { slash: 700, shatter: 950, stripeBurst: 820, panelSlide: 650, zoomPunch: 460 };
/** Progress at which the screen is fully covered — the kit swaps old → new widgets there (0 = no cover). */
export const KIT_TRANSITION_COVER: Record<UIKitTransitionType, number> = { slash: 0.5, shatter: 0.36, stripeBurst: 0.46, panelSlide: 0, zoomPunch: 0 };

/** Draw a kit transition's full-screen overlay at eased progress p (0..1). */
export function layoutTransition(list: PrimList, type: UIKitTransitionType, p: number, W: number, H: number, pal: Required<UIKitPalette>, seed = 1): void {
  list.resetXf();
  const ink = kitColor('ink', pal), prim = kitColor('primary', pal), paper = kitColor('paper', pal);
  const diag = Math.hypot(W, H);
  if (type === 'slash') {
    const sk = 0.42, extra = sk * H / 2 + 40;
    let xL: number, xR: number, lead: number;
    if (p < 0.5) { const c = easeInOutCubic(p / 0.46); xL = -extra - 20; xR = -extra + (W + 2 * extra) * c; lead = 1; }
    else { const r = easeInOutCubic((p - 0.54) / 0.46); xL = -extra + (W + 2 * extra) * r; xR = W + extra + 20; lead = -1; }
    if (xR - xL > 1) list.slant((xL + xR) / 2, H / 2, xR - xL, H + 8, sk, ink, { pattern: PAT.halftone, color2: withA(prim, 0.22), patternScale: 14 * (H / 1080), patternAmount: 0.55 });
    if (p > 0.3 && p < 0.7) {   // the cut: a knife-thin red slash with a white core across the covered screen
      const q = (p - 0.3) / 0.4, th = H * 0.075 * Math.sin(Math.PI * q);
      list.slant(W / 2, H / 2, diag * 1.2, th, 0, prim, {}, -0.42);
      list.slant(W / 2, H / 2, diag * 1.2 * (0.4 + 0.6 * q), th * 0.22, 0, paper, {}, -0.42);
    }
    const bandW = W * 0.07, edge = lead > 0 ? xR : xL;
    if (p > 0.02 && p < 0.98) {
      list.slant(edge + lead * bandW * 0.5, H / 2, bandW, H + 8, sk, prim);
      list.slant(edge + lead * bandW * 1.25, H / 2, bandW * 0.18, H + 8, sk, paper);
      list.slant(edge + lead * bandW * 1.8, H / 2, bandW * 0.5, H + 8, sk, withA(prim, 0.8));
    }
    return;
  }
  if (type === 'shatter') {
    const cx = W / 2, cy = H / 2;
    if (p < 0.36) {
      const t = easeOutBack(p / 0.34, 1.2);
      list.star(cx, cy, diag * 0.78 * t, diag * 0.78 * t, 16, 0.62, ink, {}, p * 2, 0.3);
      list.star(cx, cy, diag * 0.7 * t, diag * 0.7 * t, 16, 0.62, prim, { pattern: PAT.halftone, color2: withA(ink, 0.3), patternScale: 16 * (H / 1080), patternAmount: 0.5 }, p * 2, 0.3);
      return;
    }
    const q = clamp01((p - 0.42) / 0.58), e = easeInCubic(q);
    const cols = 7, rows = 5, cw = W / cols, ch = H / rows;
    const rng = kitRng(seed * 97 + 5);
    const lat: V2[][] = [];
    for (let j = 0; j <= rows; j++) { lat.push([]); for (let i = 0; i <= cols; i++) {
      const edgeX = i === 0 || i === cols, edgeY = j === 0 || j === rows;
      lat[j].push([i * cw + (edgeX ? 0 : (rng() - 0.5) * cw * 0.7), j * ch + (edgeY ? 0 : (rng() - 0.5) * ch * 0.7)]);
    } }
    const pick = (r: number): RGBA => (r < 0.68 ? prim : r < 0.9 ? ink : paper);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const a = lat[j][i], b = lat[j][i + 1], c = lat[j + 1][i + 1], d = lat[j + 1][i];
      for (const tri of (((i + j) & 1) ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]]) as V2[][]) {
        const gx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, gy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
        const r1 = rng(), r2 = rng(), r3 = rng();
        const dx = gx - cx, dy = gy - cy, dl = Math.max(1, Math.hypot(dx, dy));
        const speed = (0.45 + r1 * 0.7) * diag * 0.85;
        const mx = gx + (dx / dl) * speed * e, my = gy + (dy / dl) * speed * e + H * 0.5 * e * e;
        const sc = 1 - 0.55 * e;
        list.save(); list.translate(mx, my); list.rotate((r2 - 0.5) * 5 * e); list.scale(sc);
        const color = withA(pick(r3), 1 - q * q);
        list.poly(0, 0, tri.map((v) => [v[0] - gx, v[1] - gy] as V2), color, r3 < 0.68 ? { pattern: PAT.halftone, color2: withA(ink, 0.25), patternScale: 14 * (H / 1080), patternAmount: 0.5 } : {});
        list.restore();
      }
    }
    return;
  }
  if (type === 'stripeBurst') {
    const cx = W / 2, cy = H / 2;
    const grow = easeOutCubic(p / 0.44), hole = p > 0.5 ? easeInCubic((p - 0.5) / 0.5) * 1.02 : 0;
    const R = diag * 0.62 * grow;
    if (R > 1 && hole < 1) {
      list.rays(cx, cy, R, R, 24, prim, ink, p * 1.6, hole);
      if (hole > 0.01) list.ellipse(cx, cy, R * hole + 14, R * hole + 14, paper, {}, 18);
      if (p < 0.5 && p > 0.18) list.ellipse(cx, cy, R * 0.22 * (p - 0.18) / 0.32, R * 0.22 * (p - 0.18) / 0.32, ink);
    }
    return;
  }
  if (type === 'panelSlide') {
    const sk = 0.5;
    for (let i = 0; i < 5; i++) {
      const t = clamp01((p - i * 0.07) / 0.55);
      if (t <= 0 || t >= 1) continue;
      const x = -W * 0.3 + (W * 1.6) * easeInOutCubic(t);
      const y = H * (0.18 + i * 0.16);
      const c = i % 3 === 0 ? prim : i % 3 === 1 ? ink : paper;
      list.slant(x + W * 0.012, y + H * 0.012, W * 0.55, H * (i % 2 ? 0.08 : 0.14), sk, withA(ink, 0.8 * (1 - t * 0.4)));
      list.slant(x, y, W * 0.55, H * (i % 2 ? 0.08 : 0.14), sk, withA(c, 1 - t * 0.4));
    }
    return;
  }
  if (type === 'zoomPunch') {
    if (p < 0.4) list.rect(W / 2, H / 2, W + 4, H + 4, withA(paper, 0.85 * (1 - p / 0.4)));
    const R = diag * (0.3 + 0.5 * easeOutCubic(p));
    list.rays(W / 2, H / 2, R, R, 28, withA(prim, 0.45 * (1 - p)), [0, 0, 0, 0], p * 0.8, 0.35 + 0.5 * p);
  }
}
