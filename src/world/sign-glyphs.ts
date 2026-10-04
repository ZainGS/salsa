// ─────────────────────────────────────────────────────────────────────────────
// Sign GLYPHS — real Japanese shop words as geometry strokes (persona-polish C1).
//
// Japanese street signs read as signs because of their LETTERING: blocky kanji down vertical stacks, katakana
// across shop fascias. The city has no text atlas on the building path (world/ is texture-free, it runs in the
// tile Worker where there is no canvas, and the rasterized text-sign path in world-manager is one mesh + one
// bitmap per label — far too many draws for hundreds of shops), so the letters are built as thin flat stroke
// quads laid just proud of the sign face.
//
// The font is a hand-drawn SIMPLIFIED stroke font covering exactly the characters of a curated word list (ラーメン,
// 薬, カラオケ, 居酒屋, 不動産 …): every glyph is a set of straight polyline strokes on a 0..4 design grid, detailed
// enough that a real character is recognisable at street distance (complex kanji like 薬 / 動 keep their
// radicals, ~12–15 segments). Words are picked per shop / district type ({@link signWordKind}).
//
// Pure + deterministic: a sign's word is picked by an integer seed (no RNG stream), so a building's signs never
// change between regens. Budget: 2 tris per stroke segment, ~4–15 segments per glyph (≈16 tris average).
// ─────────────────────────────────────────────────────────────────────────────

import type { Accum3D } from './meshbuild';
import { ihash } from './building-geom';

type V3 = [number, number, number];
/** One stroke SEGMENT in a glyph cell: x0,y0 → x1,y1 on a 4×4 design grid, y DOWN (as the glyph is drawn). */
type Stroke = [number, number, number, number];
/** A polyline stroke: x0,y0, x1,y1, x2,y2 … (expanded to segments). */
type Poly = number[];

// ── shared radicals ──
const ROOF: Poly[] = [[2, 0, 2, 0.4], [0.4, 1.0, 0.4, 0.5, 3.6, 0.5, 3.6, 1.0]];                    // 宀
const CORPSE: Poly[] = [[0.6, 0.4, 3.4, 0.4, 3.4, 1.2, 0.6, 1.2], [0.6, 0.4, 0.6, 2.6, 0.1, 3.8]];    // 尸
const GRASS: Poly[] = [[0.2, 0.6, 3.8, 0.6], [1.3, 0.1, 1.3, 1.1], [2.7, 0.1, 2.7, 1.1]];            // 艹
const DAKU: Poly[] = [[2.9, 0.1, 3.2, 0.7], [3.5, 0.0, 3.8, 0.6]];                                   // ゛
const HANDAKU: Poly[] = [[2.95, 0.0, 3.85, 0.0, 3.85, 0.9, 2.95, 0.9, 2.95, 0.0]];              // ゜
const box = (x0: number, y0: number, x1: number, y1: number): Poly => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];

// ── katakana ──
const KA_TO: Poly[] = [[1.4, 0.1, 1.4, 3.9], [1.4, 1.8, 3.2, 2.6]];
const KA_KU: Poly[] = [[1.8, 0.1, 0.5, 1.9], [1.4, 0.8, 3.4, 0.8, 2.9, 2.4, 1.4, 3.9]];
const KA_KE: Poly[] = [[1.3, 0.1, 0.3, 1.9], [0.9, 1.3, 3.7, 1.3], [2.6, 1.3, 2.4, 2.7, 1.3, 3.9]];
const KA_HA: Poly[] = [[1.5, 0.9, 0.9, 2.5, 0.3, 3.4], [2.5, 0.9, 3.1, 2.4, 3.8, 3.4]];
const KA_HI: Poly[] = [[1.0, 0.3, 1.0, 3.5, 3.6, 3.5], [1.0, 1.9, 3.0, 1.3]];
// ── hiragana ──
const HI_HA: Poly[] = [[0.6, 0.3, 0.5, 3.6], [1.4, 1.2, 3.5, 1.2], [2.6, 0.3, 2.6, 3.1, 1.7, 3.3, 2.1, 3.9, 3.7, 3.4]];
const HI_TO: Poly[] = [[1.3, 0.3, 1.6, 1.7], [3.1, 0.9, 1.1, 2.3, 1.0, 3.2, 1.8, 3.6, 3.4, 3.6]];

/** The font: character → polyline strokes (0..4 grid, y down). */
const FONT: Record<string, Poly[]> = {
    // katakana
    'ラ': [[1, 0.4, 3, 0.4], [0.5, 1.6, 3.4, 1.6, 2.9, 2.9, 1.6, 3.9]],
    'ー': [[0.3, 2, 3.7, 2]],
    'メ': [[3.1, 0.3, 2.2, 2.2, 0.7, 3.8], [1.1, 1.4, 3.3, 3.3]],
    'ン': [[0.8, 0.9, 1.6, 1.5], [0.6, 3.8, 2.4, 3.0, 3.6, 1.1]],
    'カ': [[0.4, 1.2, 3.3, 1.2, 3.2, 3.0, 2.7, 3.8], [1.9, 0.1, 1.7, 2.2, 0.6, 3.8]],
    'オ': [[0.3, 1.3, 3.7, 1.3], [2.5, 0.1, 2.5, 3.8, 1.9, 3.5], [2.4, 1.4, 1.4, 2.7, 0.4, 3.4]],
    'ケ': KA_KE,
    'ゲ': [...KA_KE, ...DAKU],
    'ム': [[1.9, 0.2, 0.5, 3.2, 3.2, 2.9], [2.6, 2.0, 3.6, 3.6]],
    'ハ': KA_HA,
    'バ': [...KA_HA, ...DAKU],
    'パ': [...KA_HA, ...HANDAKU],
    'チ': [[3.3, 0.2, 1.8, 0.6, 0.8, 0.8], [0.3, 1.8, 3.7, 1.8], [2.1, 0.7, 2.0, 2.8, 1.2, 3.9]],
    'コ': [[0.5, 0.6, 3.4, 0.6, 3.4, 3.4, 0.5, 3.4]],
    'ホ': [[0.3, 1.2, 3.7, 1.2], [2, 0.1, 2, 3.8, 1.6, 3.5], [1.2, 2.0, 0.4, 3.2], [2.8, 2.0, 3.6, 3.2]],
    'テ': [[0.8, 0.4, 3.2, 0.4], [0.3, 1.5, 3.7, 1.5], [2, 1.5, 2, 2.6, 1.2, 3.8]],
    'ル': [[1.2, 0.5, 1.1, 2.3, 0.3, 3.7], [2.4, 0.3, 2.4, 3.5, 3.8, 2.5]],
    'ス': [[0.8, 0.6, 3.2, 0.6, 2.2, 2.3, 0.5, 3.8], [2.2, 2.4, 3.6, 3.8]],
    'ナ': [[0.2, 1.3, 3.8, 1.3], [2.3, 0.1, 2.3, 2.4, 1.2, 3.8]],
    'ッ': [[1.0, 1.9, 1.3, 2.6], [1.9, 1.8, 2.2, 2.5], [3.1, 1.7, 2.8, 2.9, 1.7, 3.7]],             // small tsu
    'ク': KA_KU,
    'グ': [...KA_KU, ...DAKU],
    'フ': [[0.5, 0.8, 3.5, 0.8, 3.0, 2.4, 1.5, 3.9]],
    'ェ': [[1.1, 1.9, 2.9, 1.9], [2, 1.9, 2, 3.4], [0.8, 3.4, 3.2, 3.4]],                             // small e
    'ト': KA_TO,
    'ド': [...KA_TO, ...DAKU],
    'ヒ': KA_HI,
    'ビ': [...KA_HI, ...DAKU],
    'ニ': [[0.8, 1, 3.2, 1], [0.3, 3.1, 3.7, 3.1]],
    'リ': [[1, 0.5, 1, 2.5], [3, 0.1, 3, 2.8, 1.8, 3.9]],
    // hiragana
    'い': [[0.8, 0.7, 0.8, 2.6, 1.3, 3.4], [2.8, 1.1, 3.4, 2.6]],
    'そ': [[1.0, 0.3, 2.8, 0.3, 0.5, 1.8, 3.5, 1.6], [1.9, 1.8, 1.4, 2.8, 1.8, 3.6, 2.9, 3.7]],
    'は': HI_HA,
    'ば': [...HI_HA, ...DAKU],
    'う': [[1.4, 0.2, 2.6, 0.5], [0.9, 1.4, 2.4, 1.2, 3.1, 1.9, 2.8, 3.0, 1.6, 3.8]],
    'と': HI_TO,
    'ど': [...HI_TO, ...DAKU],
    'ん': [[2.3, 0.2, 0.4, 3.7], [1.2, 2.3, 2.1, 1.9, 2.4, 3.4, 3.7, 2.6]],
    // kanji
    '本': [[0.2, 1.2, 3.8, 1.2], [2, 0.1, 2, 3.9], [2, 1.3, 0.4, 3.0], [2, 1.3, 3.6, 3.0], [1.2, 3.1, 2.8, 3.1]],
    '中': [box(0.5, 1, 3.5, 2.8), [2, 0.1, 2, 3.9]],
    '古': [[0.3, 1.0, 3.7, 1.0], [2, 0.1, 2, 1.9], box(0.8, 1.9, 3.2, 3.8)],
    '占': [[1.8, 0.1, 1.8, 1.8], [1.8, 0.9, 3.2, 0.9], box(0.8, 1.8, 3.2, 3.8)],
    '不': [[0.3, 0.5, 3.7, 0.5], [2.3, 0.5, 1.4, 1.8, 0.3, 2.7], [2, 1.5, 2, 3.9], [2.4, 1.8, 3.5, 2.8]],
    '動': [[0.5, 0.4, 1.8, 0.2], [0.2, 0.9, 2.0, 0.9], box(0.5, 1.3, 1.7, 2.5), [0.5, 1.9, 1.7, 1.9], [1.1, 0.3, 1.1, 3.4],
        [0.4, 2.9, 1.8, 2.9], [0.1, 3.5, 2.0, 3.3], [2.3, 1.3, 3.7, 1.3, 3.5, 3.6, 3.0, 3.3], [3.0, 0.2, 2.9, 2.2, 2.2, 3.8]],
    '産': [[2, 0.1, 2, 0.5], [0.6, 0.6, 3.4, 0.6], [1.2, 0.9, 1.4, 1.4], [2.8, 0.9, 2.6, 1.4], [0.3, 1.5, 3.7, 1.5],
        [0.8, 1.5, 0.7, 2.8, 0.2, 3.8], [1.5, 2.0, 1.2, 2.6], [1.3, 2.4, 3.5, 2.4], [2.3, 1.9, 2.3, 3.7], [1.4, 3.0, 3.3, 3.0], [1.0, 3.7, 3.8, 3.7]],
    '美': [[1.3, 0.1, 1.6, 0.5], [2.7, 0.1, 2.4, 0.5], [0.5, 0.7, 3.5, 0.7], [0.8, 1.3, 3.2, 1.3], [0.3, 1.9, 3.7, 1.9],
        [2, 0.7, 2, 2.6], [0.2, 2.6, 3.8, 2.6], [2, 2.6, 0.4, 3.9], [2, 2.6, 3.6, 3.9]],
    '容': [...ROOF, [1.4, 0.9, 1.0, 1.4], [2.6, 0.9, 3.0, 1.4], [2, 1.2, 0.5, 2.3], [2, 1.2, 3.5, 2.3], box(1.2, 2.5, 2.8, 3.8)],
    '室': [...ROOF, [0.7, 1.2, 3.3, 1.2], [1.9, 1.3, 1.0, 2.2, 3.0, 2.1], [2.6, 1.7, 3.1, 2.3], [2, 2.2, 2, 3.7], [0.9, 2.9, 3.1, 2.9], [0.3, 3.8, 3.7, 3.8]],
    '定': [...ROOF, [0.9, 1.3, 3.1, 1.3], [2, 1.3, 2, 3.2], [2, 2.2, 3.0, 2.2], [1.1, 2.0, 1.1, 3.0, 0.3, 3.7], [1.1, 3.0, 2.0, 3.5, 3.8, 3.6]],
    '寿': [[0.6, 0.6, 3.4, 0.6], [0.9, 1.2, 3.1, 1.2], [0.2, 1.9, 3.8, 1.9], [2, 0.1, 2, 1.9, 0.6, 3.7], [0.5, 2.6, 3.6, 2.6],
        [2.9, 2.0, 2.9, 3.8, 2.4, 3.5], [1.4, 2.9, 1.8, 3.3]],
    '司': [[0.6, 0.4, 3.4, 0.4, 3.4, 3.6, 2.9, 3.3], [0.9, 1.2, 2.6, 1.2], box(1.0, 1.9, 2.5, 3.0)],
    '焼': [[0.4, 1.2, 0.6, 1.8], [1.5, 1.0, 1.3, 1.6], [0.9, 0.4, 0.9, 2.3, 0.3, 3.6], [0.9, 2.3, 1.5, 3.2], [1.9, 0.6, 3.7, 0.6],
        [2.8, 0.1, 2.8, 1.2], [3.5, 0.9, 1.9, 1.6], [1.8, 2.0, 3.8, 2.0], [2.4, 2.0, 2.3, 3.0, 1.8, 3.8], [3.1, 2.0, 3.1, 3.6, 3.8, 3.6]],
    '肉': [[0.5, 3.9, 0.5, 0.6, 3.5, 0.6, 3.5, 3.9, 3.1, 3.7], [2, 0.1, 2, 1.2, 0.9, 2.2], [2, 1.3, 3.0, 2.2], [2, 2.0, 2, 2.5, 0.9, 3.4], [2, 2.6, 3.0, 3.4]],
    '牛': [[1.2, 0.2, 0.6, 1.4], [0.9, 1.0, 3.5, 1.0], [0.2, 2.3, 3.8, 2.3], [2, 0.1, 2, 3.9]],
    '丼': [[0.4, 1.2, 3.6, 1.2], [0.2, 2.6, 3.8, 2.6], [1.3, 0.2, 1.3, 2.6, 0.5, 3.8], [2.7, 0.2, 2.7, 3.9], [1.8, 1.6, 2.2, 2.1]],
    '食': [[2, 0.1, 0.2, 1.5], [2, 0.1, 3.8, 1.5], [1.4, 1.25, 2.6, 1.25], [1.0, 3.8, 1.0, 1.7, 3.0, 1.7, 3.0, 2.9, 1.0, 2.9], [1.0, 2.3, 3.0, 2.3],
        [1.0, 3.8, 1.8, 3.4], [1.9, 2.9, 3.6, 3.9], [3.3, 2.9, 2.6, 3.3]],
    '酒': [[0.3, 0.5, 0.7, 0.9], [0.2, 1.6, 0.6, 2.0], [0.2, 3.6, 0.8, 2.6], [1.1, 0.4, 3.8, 0.4], box(1.3, 1.1, 3.6, 3.8),
        [2.1, 0.4, 2.1, 2.3], [2.8, 0.4, 2.8, 2.3], [1.3, 2.3, 3.6, 2.3], [1.3, 3.1, 3.6, 3.1]],
    '居': [...CORPSE, [1.2, 1.8, 3.7, 1.8], [2.4, 1.3, 2.4, 2.5], box(1.4, 2.5, 3.4, 3.8)],
    '屋': [...CORPSE, [1.2, 1.6, 3.6, 1.6], [2.3, 1.6, 1.6, 2.3, 3.2, 2.2], [2.4, 2.4, 2.4, 3.6], [1.4, 3.0, 3.4, 3.0], [1.0, 3.8, 3.8, 3.8]],
    '薬': [...GRASS, box(1.5, 1.2, 2.5, 2.2), [1.5, 1.7, 2.5, 1.7], [0.6, 1.4, 1.0, 1.9], [3.4, 1.4, 3.0, 1.9],
        [0.3, 2.6, 3.7, 2.6], [2, 2.2, 2, 3.9], [2, 2.7, 0.5, 3.7], [2, 2.7, 3.5, 3.7]],
    '八': [[1.5, 0.8, 1.3, 2.4, 0.3, 3.6], [2.5, 0.8, 2.7, 2.2, 3.8, 3.5]],
    '百': [[0.3, 0.4, 3.7, 0.4], [2.1, 0.4, 1.7, 1.1], box(0.8, 1.1, 3.2, 3.8), [0.8, 2.45, 3.2, 2.45]],
    '花': [...GRASS, [1.4, 1.3, 0.3, 2.7], [0.9, 2.1, 0.9, 3.9], [3.4, 1.6, 2.0, 2.5], [2.0, 1.3, 2.0, 3.6, 3.7, 3.6, 3.7, 3.1]],
    '内': [[0.5, 3.9, 0.5, 1.0, 3.5, 1.0, 3.5, 3.9, 3.0, 3.6], [2, 0.1, 2, 1.6, 1.0, 2.9], [2, 1.7, 3.0, 2.8]],
    '科': [[1.5, 0.2, 0.3, 0.6], [0.2, 1.3, 1.8, 1.3], [1.0, 0.5, 1.0, 3.9], [1.0, 1.4, 0.2, 2.8], [1.0, 1.5, 1.7, 2.3],
        [2.3, 0.7, 2.7, 1.0], [2.2, 1.5, 2.6, 1.8], [2.0, 2.6, 3.9, 2.2], [3.2, 0.1, 3.2, 3.9]],
};
/** Glyphs that change shape in VERTICAL (tate) text: the long-vowel bar runs down the column. */
const VERTICAL_FONT: Record<string, Poly[]> = { 'ー': [[2, 0.3, 2, 3.7]] };

const toSegs = (polys: readonly Poly[]): Stroke[] => {
    const out: Stroke[] = [];
    for (const p of polys) for (let i = 0; i + 3 < p.length; i += 2) out.push([p[i], p[i + 1], p[i + 2], p[i + 3]]);
    return out;
};
const SEGS = new Map<string, Stroke[]>(Object.entries(FONT).map(([k, v]) => [k, toSegs(v)]));
const SEGS_V = new Map<string, Stroke[]>(Object.entries(VERTICAL_FONT).map(([k, v]) => [k, toSegs(v)]));

/** Every character the font can draw. */
export const GLYPH_NAMES: readonly string[] = Object.keys(FONT);

/** Stroke segments of a glyph (design grid 0..4, y down), the tate variant when `vertical`. Empty for an unknown
 *  character. */
export function glyphStrokes(name: string, vertical = false): readonly Stroke[] {
    return (vertical ? SEGS_V.get(name) : undefined) ?? SEGS.get(name) ?? [];
}

// ── The word list (C1) ──────────────────────────────────────────────────────────────────────────────
/** What a sign advertises — picks the word list. */
export type SignWordKind = 'nightlife' | 'food' | 'shop' | 'quiet' | 'konbini' | 'izakaya' | 'lantern';

/** Real shop / trade words per kind (generic trades, no brand names). Order is stable: seeded picks index into it. */
export const SIGN_WORDS: Readonly<Record<SignWordKind, readonly string[]>> = {
    nightlife: ['カラオケ', 'ゲーム', 'パチンコ', 'バー', 'ホテル', 'スナック', '居酒屋', '焼肉', 'ラーメン', '占い', 'カフェ', '中古', '不動産', '美容室'],
    food: ['ラーメン', '寿司', '焼肉', '牛丼', '定食', 'そば', 'うどん', '居酒屋', '酒', 'カフェ', '八百屋', '肉'],
    shop: ['薬', 'ドラッグ', '本', '中古', '花', '八百屋', '美容室', '不動産', '占い', 'コンビニ', 'カフェ', 'ラーメン'],
    quiet: ['薬', '本', '美容室', '不動産', '内科', 'クリニック', 'カフェ', '花', 'そば', '定食', 'コンビニ'],
    konbini: ['コンビニ'],
    izakaya: ['居酒屋', '酒', '焼肉', '定食'],
    lantern: ['酒', '焼', '食'],
};

/** The word kind for a building's signs: its archetype first (konbini / izakaya are identities), else the
 *  district's mood (downtown = nightlife, market = food, residential = quiet, anything else = everyday shops). */
export function signWordKind(archetype: string, district?: string): SignWordKind {
    if (archetype === 'konbini') return 'konbini';
    if (archetype === 'izakaya') return 'izakaya';
    if (archetype === 'neon-arcade') return 'nightlife';
    if (district === 'downtown') return 'nightlife';
    if (district === 'market') return 'food';
    if (district === 'residential') return 'quiet';
    if (archetype === 'retro-shophouse' || archetype === 'machiya') return 'food';
    if (archetype === 'zakkyo') return 'nightlife';
    return 'shop';
}

/** A deterministic real word (as its characters) for sign `seed`, preferring one that fills about `n` glyph cells
 *  (length n-2 … n; any shorter word next; the shortest as a last resort). */
export function signWord(seed: number, n: number, vertical = false, kind: SignWordKind = 'shop'): string[] {
    void vertical;
    const list = SIGN_WORDS[kind] ?? SIGN_WORDS.shop;
    const lenOf = (w: string): number => [...w].length;
    const cap = Math.max(1, n);
    let pool = list.filter(w => lenOf(w) <= cap && lenOf(w) >= cap - 2);
    if (!pool.length) pool = list.filter(w => lenOf(w) <= cap);
    if (!pool.length) { const m = Math.min(...list.map(lenOf)); pool = list.filter(w => lenOf(w) === m); }
    return [...pool[ihash(seed, 0x5157) % pool.length]];
}

/** Glyph cell layout for a run of `n` glyphs in a `w × h` box: returns each glyph's cell centre (box-local, x right
 *  / y up from the box centre) and the cell size. Vertical runs stack top→bottom, horizontal runs left→right; the
 *  cell is square and fits the box with a margin, so text never spills off its sign. */
export function glyphCells(n: number, w: number, h: number, vertical: boolean, margin = 0.12): { cell: number; centres: [number, number][] } {
    const cn = Math.max(1, n);
    const along = vertical ? h : w, across = vertical ? w : h;
    const cell = Math.max(0, Math.min(across * (1 - 2 * margin), along * (1 - 2 * margin) / cn));
    const centres: [number, number][] = [];
    for (let i = 0; i < cn; i++) {
        const t = (i - (cn - 1) / 2) * cell;
        centres.push(vertical ? [0, -t] : [t, 0]);
    }
    return { cell, centres };
}

/** Emit a run of glyph strokes onto a sign face. `c` = the face centre (world), `right`/`up` = the face's in-plane
 *  axes (unit), `out` = the face normal; strokes sit `lift` in front of the face; `weight` scales the stroke
 *  thickness (dark ink on a backlit box is drawn bolder — the glowing face's bloom eats into thin strokes).
 *  Returns the segment count. */
export function emitGlyphRun(acc: Accum3D, c: V3, right: V3, up: V3, out: V3, w: number, h: number,
    word: readonly string[], vertical: boolean, lift = 0.012, weight = 1): number {
    const { cell, centres } = glyphCells(word.length, w, h, vertical);
    if (cell <= 0.02) return 0;
    const g = cell * 0.84 / 4;                 // design-grid unit → metres (glyph fills 84% of its cell)
    let count = 0;
    const P = (lx: number, ly: number): V3 => [
        c[0] + right[0] * lx + up[0] * ly + out[0] * lift,
        c[1] + right[1] * lx + up[1] * ly + out[1] * lift,
        c[2] + right[2] * lx + up[2] * ly + out[2] * lift,
    ];
    for (let k = 0; k < word.length; k++) {
        const [cx, cy] = centres[k];
        const segs = glyphStrokes(word[k], vertical);
        // bold sign lettering, thinner for the dense kanji so their strokes stay separate
        const th = Math.max(0.008, cell * weight * (segs.length > 10 ? 0.05 : segs.length > 6 ? 0.06 : 0.072));
        for (const [x0, y0, x1, y1] of segs) {
            const ax = cx + (x0 - 2) * g, ay = cy - (y0 - 2) * g, bx = cx + (x1 - 2) * g, by = cy - (y1 - 2) * g;
            let dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
            // extend each end by the half-thickness so joints close (boxes read as boxes, not four sticks)
            const ex = dx * th, ey = dy * th, nx = -dy * th, ny = dx * th;
            acc.quad4(P(ax - ex - nx, ay - ey - ny), P(bx + ex - nx, by + ey - ny), P(bx + ex + nx, by + ey + ny), P(ax - ex + nx, ay - ey + ny));
            count++;
        }
    }
    return count;
}
