/**
 * character-randomizer.ts — the parameters for a NEW randomized procedural character (docs/ui/character-creator.md
 * "Random character"). Pure + seeded: the same seed gives the same character. Feed the result straight into
 * `createFullCharacter3D` (or call `sm.createRandomCharacter3D`, which does exactly that).
 *
 * Ranges ported from the host's old randomizer, then pinned to the look the user signed off on (polish-round-3 T6):
 *   • eyes ≈ 0.4 wide × 0.2 tall (small variance), NO bottom lash — the wide random ranges "were usually bad"
 *   • hair: one of the anime lock STYLES (hair-locks.ts, 2026-10-04; was cards, Cap Layers = 6)
 *   • rim light ON
 *   • (visual-polish item 10, 2026-10-03) matte cel cloth, the hair sheen as one highlight band, the bang hairline
 *     kept above the eyes (RANDOM_CHARACTER_LIMITS.hairlineFront), no under-eye dots; the body's anime face normals
 *     come from the new-body defaults (NEW_BODY_DEFAULTS), not from here
 *   • tops never cropped (crop / hemHeight ≤ 0 → the belly stays covered)
 *   • bottoms' Looseness (thickness) ≥ 0.016 (the 0.012 default read skin-tight)
 * Everything else (colours, hair style, garment styles, shoes, socks) stays random.
 *
 * Only NEW characters are affected: saved characters persist their own params and never pass through here.
 */

import { makeRng, type Rng } from '../../world/util';
import { defaultEyeParams, type EyeParams } from './eye-generator';
import { randomFaceFeatureParams, type FaceFeatureParams } from './face-features';
import { DEFAULT_HAIR_PARAMS, hairStylePreset, type HairParams } from './hair-generator';
import { randomLockStyle } from './hair-locks';
import {
    defaultTopParams, defaultBottomParams, defaultShoeParams, defaultSockParams,
    type TopParams, type BottomParams, type ShoeParams, type SockParams,
} from './clothing-generator';
import type { BodyParams } from './body-generator';

/** Hard limits the randomizer guarantees (also asserted by character-randomizer.test.ts). */
export const RANDOM_CHARACTER_LIMITS = {
    eyeWidth:  [0.37, 0.43] as const,
    eyeHeight: [0.18, 0.22] as const,
    capLayers: 6,
    hairlineFront: [0.28, 0.46] as const,  // bang hairline (× ry): low values hang the fringe over the eyes
    topHemMax: 0,                         // hemHeight ("Crop") — 0 = hem at the hips; negative = longer
    bottomThickness: [0.016, 0.020] as const,
} as const;

export interface RandomCharacterParams {
    body: Partial<BodyParams>;
    eyes: EyeParams;
    hair: HairParams;
    top: TopParams;
    bottom: BottomParams;
    shoes: ShoeParams;
    socks: SockParams;
    skinTone: string;
    rimLight: true;
    /** Matte cel skin + cloth (no specular — visual-polish item 10; setCharacterMatte3D). */
    matte: true;
    /** Face kit (face-features.ts): brows follow the hair, mouth / nose / blush random within the T6 look. */
    face: FaceFeatureParams;
}

const SKIN_TONES   = ['#f5c5a3', '#e8b492', '#d9956b', '#c07846', '#8d5633', '#6b3a22', '#f2d5b0', '#fce4cc', '#a0724f', '#7a4f2d'];
const HAIR_COLORS  = ['#1a0a00', '#3d1a00', '#6b3a1f', '#9b6b3a', '#c49a6c', '#e8c87a', '#f5e6c8', '#cc3300', '#990033', '#4a0066', '#1a1a66', '#005533', '#444444', '#888888', '#cccccc', '#80bc80', '#ff6699', '#ff9900'];
const EYE_COLORS   = ['#6d523b', '#4a7c59', '#3a5f8a', '#6b4a8a', '#8a6a3a', '#2a5a3a', '#5a3a6b', '#8a4a2a', '#3a6b8a', '#1a6b4a'];
const ACCENTS      = ['#80bc80', '#bc8080', '#8080bc', '#bc80bc', '#80bcbc', '#bcbc80', '#bc9060', '#60bc90'];
const SHOE_COLORS  = ['#1a1a1a', '#2d2d2d', '#4a3728', '#6b4c35', '#8b6848', '#c4a882', '#f5f5f5', '#2c3e6b', '#8b4513', '#d2691e'];
const SOCK_COLORS  = ['#ffffff', '#f5f5f5', '#e0e0e0', '#cccccc', '#1a1a1a', '#2d2d2d', '#8b3a3a', '#3a5a8b', '#3a6b3a', '#6b3a6b', '#d4a574'];
const CLOTH_PAIRS: [string, string][] = [
    ['#419041', '#315e31'], ['#404763', '#030407'], ['#c0392b', '#8e2020'],
    ['#2980b9', '#1a5276'], ['#8e44ad', '#4a235a'], ['#e67e22', '#7d5a0a'],
    ['#16a085', '#0e6655'], ['#2c3e50', '#1a1a2e'], ['#f39c12', '#876500'],
    ['#d35400', '#7a2e00'], ['#1abc9c', '#0a6b50'], ['#e74c3c', '#6b1010'],
    ['#9b59b6', '#5b2c6f'], ['#3498db', '#1a4a7a'], ['#f1c40f', '#7d6608'],
    ['#e8d5b0', '#9a8060'], ['#34495e', '#1a2530'], ['#bdc3c7', '#7f8c8d'],
];

/** Shift a hex colour's lightness by `delta` (−1..1), clamped. */
function varyLightness(hex: string, delta: number): string {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const v = delta >= 0 ? c + (255 - c) * delta : c * (1 + delta);
        return Math.max(0, Math.min(255, Math.round(v)));
    });
    return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** Parameters for a new random character. `seed` omitted → Math.random-seeded. `body` merges over the random body. */
export function randomCharacterParams(seed?: number, body: Partial<BodyParams> = {}): RandomCharacterParams {
    const s0 = seed ?? Math.floor(Math.random() * 0x7fffffff);
    const rng: Rng = makeRng(s0);
    const r = (a: number, b: number) => rng.range(a, b);
    const pick = <T>(arr: readonly T[]): T => arr[Math.min(arr.length - 1, Math.floor(rng.next() * arr.length))];
    const L = RANDOM_CHARACTER_LIMITS;

    // ── Eyes: pinned near 0.4 × 0.2, no bottom lash ──
    const iris = pick(EYE_COLORS);
    const eyes: EyeParams = {
        ...defaultEyeParams(),
        spacing: r(0.36, 0.46),
        verticalPos: r(0.45, 0.65),
        width: r(L.eyeWidth[0], L.eyeWidth[1]),
        height: r(L.eyeHeight[0], L.eyeHeight[1]),
        tilt: r(-0.15, 0.30),
        roundness: r(0.50, 1.00),
        irisRadius: r(0.70, 1.00),
        irisGradient: true,
        irisColorTop: iris, irisColorBottom: varyLightness(iris, 0.35), irisColor: iris,
        pupilRadius: r(0.35, 0.60),
        upperLashThickness: r(0.10, 0.18),
        outerLashLength: r(0.20, 0.60),
        lowerLash: false,
        doubleEyelid: rng.chance(0.5),
        // Under-eye dots OFF (2026-10-03): at play / face distance the row of tiny accent dots on the cheeks read as
        // stray white "°°°" specks (seed 32, seed 18), not as decoration. The draw stays so every later field of a
        // seed is unchanged; the host's Under-eye deco toggle still turns it on per character.
        underDeco: rng.chance(0.5) && false,
        underDecoColor: pick(ACCENTS),
        underDecoCount: rng.int(1, 5),
    };

    // ── Hair: cards, 6 cap layers; the style stays random ──
    const hair: HairParams = {
        ...DEFAULT_HAIR_PARAMS,
        hairMode: 'cards',
        cardifyCap: true,
        capLayers: L.capLayers,
        verticalOffset: r(0.60, 0.80),
        capThickness: r(-0.20, 0.15),
        backLength: r(0.00, 4.00),
        crownRound: r(0.00, 0.40),
        // Bang hairline height. Below ~0.25 the cap cards hang over the eyes (about 40% of seeds with the old
        // 0..0.40 range); RANDOM_CHARACTER_LIMITS.hairlineFront keeps most random faces' eyes clear (asserted by
        // character-randomizer.test.ts on the generated hair). Same draw → every other field of a seed is unchanged.
        hairlineFront: r(L.hairlineFront[0], L.hairlineFront[1]),
        partingStyle: pick(['fringe', 'parted', 'swept'] as const),
        partingPosition: r(-0.50, 0.50),
        partingWidth: r(0.10, 0.40),
        bangCount: 0,
        sideLock: rng.chance(0.5),
        sideLockLength: r(0.30, 2.00),
        sideLockWidth: r(0.05, 0.25),
        sideLockCount: rng.int(1, 4),
        tailStyle: pick(['none', 'twin', 'pony', 'pig'] as const),
        tailHeight: r(-0.20, 0.70),
        tailSpread: r(0.20, 0.90),
        tailLength: r(1.00, 5.50),
        tailThickness: r(0.15, 0.70),
        tailTaper: r(0.20, 1.00),
        tailCurl: r(-0.80, 0.80),
        tailTip: pick(['point', 'flare', 'blunt'] as const),
        rootColor: pick(HAIR_COLORS),
        tipColor: pick(HAIR_COLORS),
        gradient: true,
        tipFade: r(0.30, 1.00),
        chunkiness: r(0.30, 1.00),
        // Item 10: the sheen as one crisp highlight band in Cel / Cel-HD (material only; no rng draw).
        sheenBand: true,
    };
    delete hair.preset;   // a custom mix, not a named preset
    // ── Hair STYLE (hair-styles.md B–E, 2026-10-04): new random characters get one of the anime lock styles
    //    (hairMode 'locks') — bob / long / side-swept / ponytail / twintails / short messy / bun / hime — with seeded
    //    variation and the fringe above the eyes. Drawn from its OWN stream so every later field of a seed (clothes,
    //    shoes …) is unchanged; the colour draws above are kept (gradient only sometimes — P5 hair is mostly flat). ──
    {
        const hs = makeRng((s0 ^ 0x2545f491) >>> 0);
        const style = randomLockStyle(() => hs.next());
        Object.assign(hair, hairStylePreset(style.hairStyle, style.lockSeed), style, {
            rootColor: hair.rootColor, tipColor: hair.tipColor, tipFade: hair.tipFade, hairlineFront: hair.hairlineFront,
            gradient: hs.chance(0.3), sheenBand: true,
        });
    }

    // ── Top: never cropped ──
    const [topColor, topTrim] = pick(CLOTH_PAIRS);
    const top: TopParams = {
        ...defaultTopParams(),
        hemHeight: r(-0.10, L.topHemMax),
        gradient: true,
        trimWidth: r(0.10, 0.45),
        baseColor: topColor, trimColor: topTrim,
    };

    // ── Bottom: looser than the 0.012 default ──
    const [bottomColor, bottomTrim] = pick(CLOTH_PAIRS);
    const bottomStyle = pick(['skirt', 'shorts', 'pants'] as const);
    const bottom: BottomParams = {
        ...defaultBottomParams(),
        bottomStyle,
        waistWidth: r(0.05, 0.45),
        waistHeight: r(-0.20, 0.30),
        length: bottomStyle === 'shorts' ? r(0.35, 0.50) : bottomStyle === 'pants' ? r(0.60, 1.00) : r(0.60, 1.40),
        thickness: r(L.bottomThickness[0], L.bottomThickness[1]),
        gradient: true,
        trimWidth: r(0.10, 0.45),
        baseColor: bottomColor, trimColor: bottomTrim,
    };

    // ── Shoes + socks ──
    const shoeStyle = pick(['sneaker', 'sneaker', 'sneaker', 'boot', 'boot', 'heel'] as const);
    const shoeBase = pick(SHOE_COLORS);
    const shoes: ShoeParams = {
        ...defaultShoeParams(),
        shoeStyle,
        soleThickness: 0.010,
        topCover: r(0.30, 0.80),
        shaftHeight: shoeStyle === 'boot' ? r(0.40, 1.20) : r(0.00, 0.25),
        heelHeight: shoeStyle === 'heel' ? r(0.20, 0.70) : 0.10,
        toePoint: r(0.00, 0.40),
        ankleCollar: r(0.20, 0.70),
        thickness: r(0.005, 0.015),
        baseColor: shoeBase, trimColor: varyLightness(shoeBase, r(-0.20, 0.20)),
        gradient: rng.chance(0.5),
        trimWidth: r(0.10, 0.35),
        chunkiness: r(0.30, 0.80),
    };
    const sockBase = pick(SOCK_COLORS);
    const socks: SockParams = {
        ...defaultSockParams(),
        sockStyle: pick(['ankle', 'crew'] as const),
        legHeight: r(0.00, 0.50),
        thickness: 0.008,
        baseColor: sockBase,
        trimColor: varyLightness(sockBase, rng.chance(0.5) ? r(0.15, 0.25) : r(-0.25, -0.15)),
        gradient: rng.chance(0.4),
        trimWidth: r(0.10, 0.30),
    };

    const out = {
        body: { waist: r(0.75, 1.05), hipFront: r(0.60, 0.90), ...body },
        eyes, hair, top, bottom, shoes, socks,
        skinTone: pick(SKIN_TONES),
        rimLight: true as const,
        matte: true as const,
    };
    // ── Face kit: its OWN stream (seed-derived), drawn last, so every pre-kit field of a seed is unchanged ──
    const face = randomFaceFeatureParams(makeRng((s0 ^ 0x5f3759df) >>> 0));
    return { ...out, face };
}
