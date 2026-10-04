// ── World generation — SIGN PALETTE discipline (persona-polish B5) ──────────────────────────────────
// Real Shibuya signage is not three primaries: it is a curated mix of hues AND values — white and black
// lightboxes, cream, deep navy, vermilion, amber, teal — whose mood follows the district (hot neon downtown,
// warm reds / creams in the market streets, quiet whites / sage / navy in the residential blocks). Buildings stay
// neutral; the colour lives on the signs.
//
// Pure + deterministic: picks are hashes of a lot key (NO RNG stream consumed — the rest of the building keeps its
// exact random sequence). Also decides the LETTERING treatment per face: light text on dark / coloured faces,
// dark (or coloured) ink on white / cream / yellow lightboxes, glowing coloured text on black boxes.

type C3 = [number, number, number];

export type SignMood = 'nightlife' | 'food' | 'shop' | 'quiet';

const WHITE: C3 = [0.93, 0.93, 0.9];
const CREAM: C3 = [0.94, 0.88, 0.72];
const BLACK: C3 = [0.07, 0.07, 0.08];
const NAVY: C3 = [0.13, 0.19, 0.4];

/** Curated sign colours per mood (face colours — the lightbox panel). Varied hue AND value; never pure primaries. */
export const SIGN_PALETTES: Readonly<Record<SignMood, readonly C3[]>> = {
    nightlife: [[0.86, 0.22, 0.52], [0.1, 0.64, 0.7], [0.96, 0.66, 0.16], [0.46, 0.27, 0.78], WHITE, BLACK, [0.9, 0.32, 0.2], [0.62, 0.8, 0.26]],
    food: [[0.82, 0.26, 0.17], CREAM, WHITE, BLACK, [0.88, 0.68, 0.22], [0.15, 0.4, 0.29], NAVY, [0.86, 0.47, 0.19]],
    shop: [WHITE, BLACK, [0.3, 0.57, 0.84], [0.18, 0.56, 0.47], [0.93, 0.53, 0.16], [0.8, 0.2, 0.22], NAVY, [0.95, 0.86, 0.46]],
    quiet: [WHITE, CREAM, [0.52, 0.63, 0.52], NAVY, [0.43, 0.29, 0.19], [0.58, 0.71, 0.83], [0.77, 0.52, 0.52], [0.21, 0.21, 0.23]],
};

/** District → sign mood (unknown / mixed districts read as everyday shops). */
export function signMoodFor(district: string | undefined, archetype?: string): SignMood {
    if (district === 'downtown' || archetype === 'neon-arcade') return 'nightlife';
    if (district === 'market') return 'food';
    if (district === 'residential') return 'quiet';
    return 'shop';
}

/** Perceived luminance (0..1) of a 0..1 colour. */
export const signLum = (c: readonly number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const mix32 = (a: number, b: number): number => {
    let h = Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul((b + 0x7f4a7c15) >>> 0, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
};

/** Temper a style palette's neon entry (the city look's own sign colours) so it sits with the curated set: pulled
 *  a little toward its own grey, the brightest channel capped — no clipped pure primaries. */
export function temperSignColor(c: readonly number[]): C3 {
    const g = signLum(c), k = 0.18;
    const t: C3 = [c[0] + (g - c[0]) * k, c[1] + (g - c[1]) * k, c[2] + (g - c[2]) * k];
    const m = Math.max(t[0], t[1], t[2]);
    const s = m > 0.94 ? 0.94 / m : 1;
    return [t[0] * s, t[1] * s, t[2] * s];
}

/** The three tenant sign colours for one building (`key` = a stable per-lot hash). Distinct entries of the mood's
 *  palette; a style palette's `neon` colours (tempered) join the pool. The trio always has VALUE spread: when all
 *  three landed mid-tone, one becomes white (or black) — a street of shops is never three same-weight blocks. */
export function pickSignColors(mood: SignMood, key: number, neon?: readonly (readonly number[])[] | null): [C3, C3, C3] {
    const pool: C3[] = [...SIGN_PALETTES[mood]];
    if (neon) for (const c of neon) pool.push(temperSignColor(c));
    const n = pool.length;
    const i0 = mix32(key, 1) % n;
    const i1 = (i0 + 1 + mix32(key, 2) % (n - 1)) % n;
    let i2 = (i0 + 1 + mix32(key, 3) % (n - 1)) % n;
    if (i2 === i1) i2 = (i2 + 1) % n === i0 ? (i2 + 2) % n : (i2 + 1) % n;
    const out: [C3, C3, C3] = [pool[i0], pool[i1], pool[i2]];
    const lums = out.map(signLum);
    if (Math.max(...lums) - Math.min(...lums) < 0.3) {
        // the third box turns white or black — whichever opens the wider value gap (the hash decides when both do)
        const lo = Math.min(lums[0], lums[1]), hi = Math.max(lums[0], lums[1]);
        const wGap = signLum(WHITE) - lo, bGap = hi - signLum(BLACK);
        out[2] = wGap >= 0.3 && bGap >= 0.3 ? ((mix32(key, 4) & 3) === 0 ? BLACK : WHITE) : wGap >= bGap ? WHITE : BLACK;
    }
    return [[...out[0]] as C3, [...out[1]] as C3, [...out[2]] as C3];
}

/** How a face of colour `face` is lettered: 'light' = cream glowing text (dark / saturated faces), 'ink' = dark
 *  paint (white / cream / yellow boxes), 'inkColor' = coloured paint on a light box, 'glowColor' = coloured glowing
 *  text on a black box. `key` varies the choice per building. */
export type SignLettering = 'light' | 'ink' | 'inkColor' | 'glowColor';
export function letteringFor(face: readonly number[], key: number): SignLettering {
    const L = signLum(face);
    // visual-polish #8 (contrast): a lit box GLOWS (x1.2..1.6 emissive), so a mid-light face (teal, orange, sage, dusty
    // pink, L 0.5..0.6) renders near-white and cream text vanished on it -> dark ink from L 0.5 (was 0.6). Coloured ink
    // (deep red / navy / green / orange, L up to ~0.4) only on a clearly LIGHT face, never a mid-tone one.
    if (L > 0.75) return (mix32(key, 7) & 1) ? 'inkColor' : 'ink';
    if (L > 0.5) return 'ink';
    if (L < 0.1) return (mix32(key, 8) % 3) ? 'glowColor' : 'light';
    return 'light';
}

/** The building's coloured INK (on light boxes): a deep red, navy or green, by key. */
export function signInkColor(key: number): C3 {
    const inks: C3[] = [[0.72, 0.1, 0.1], [0.1, 0.16, 0.42], [0.1, 0.36, 0.22], [0.78, 0.3, 0.06]];
    return inks[mix32(key, 9) % inks.length];
}

/** The building's GLOWING coloured text (on black boxes): its most saturated sign colour, lifted to read as light;
 *  amber when it has none. */
export function signGlowTextColor(colors: readonly (readonly number[])[]): C3 {
    let best: readonly number[] | null = null, bs = 0.25;
    for (const c of colors) { const s = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]); if (s > bs) { bs = s; best = c; } }
    if (!best) return [1.0, 0.72, 0.22];
    const m = Math.max(best[0], best[1], best[2]) || 1;
    return [Math.min(1, best[0] / m * 0.98 + 0.08), Math.min(1, best[1] / m * 0.98 + 0.08), Math.min(1, best[2] / m * 0.98 + 0.08)];
}

/** The lightbox FRAME finish per building: graphite, brushed aluminium, white or black casing. */
export function signFrameColor(key: number): C3 {
    const f: C3[] = [[0.2, 0.2, 0.22], [0.6, 0.61, 0.62], [0.84, 0.84, 0.82], [0.08, 0.08, 0.09]];
    return f[mix32(key, 11) % f.length];
}
