/**
 * face-features.ts — the anime FACE KIT (docs/specs/visual-polish-next.md item 2; docs/ui/character-creator.md §2.6).
 *
 * The eyes already live on a skinned decal (eye-generator.ts + Scene3DCharacter's face rig). This module adds the rest
 * of a stylised anime face: eyebrows, a mouth with simple expressions, a nose tick / shadow, a fake hair shadow across
 * the forehead, blush and cheek shading. Everything here is PURE (no GPU, no DOM): parameters, expression shapes and
 * their blend, the face layout maths, the overlay-mesh builder and the Canvas2D painter. Scene3DCharacter owns the
 * meshes + textures and calls in.
 *
 * HOW IT SITS IN THE SKIN. Two extra skinned meshes per face, both built by RAYCASTING the body's own head surface, so
 * they hug the real (faceted) face and follow the head through every pose:
 *   • the SKIN layer (whole face front): hair shadow, nose, mouth, blush, cheek shading;
 *   • the BROW layer (the brow band): the brows, drawn with a depth PULL toward the camera (flags2 bit 6) so they show
 *     through the hair fringe just in front of them — the anime convention — but not through anything further away.
 * Their textures are MULTIPLIERS (white = no change) uploaded premultiplied, and the renderer draws them with a
 * MULTIPLY blend after the opaque skin. So they darken whatever the skin rendered — PBR, Cel, Cel HD, toon shadows,
 * the skin ramp, ink — and pick up its lighting for free: a brow in shade is a brow in shade. Colours are therefore
 * stored as "target colour on this skin" and converted with `featureMultiplier`.
 *
 * Coordinates: head-LOCAL rest space (the body geometry's), x = screen-right when viewed from the front (+z), y up.
 * A layer's texture maps u: x0→x1 and v: y1 (top) → y0 (bottom).
 */

import type { EyeParams } from './eye-generator';

// ═══════════════════════════════════════════════════════════════════════════
//  Parameters
// ═══════════════════════════════════════════════════════════════════════════

export type FaceExpressionName = 'neutral' | 'smile' | 'open' | 'frown' | 'surprised';
export const FACE_EXPRESSION_NAMES: readonly FaceExpressionName[] = ['neutral', 'smile', 'open', 'frown', 'surprised'];

export type BrowStyle = 'soft' | 'straight' | 'arched' | 'angled' | 'short';
export const BROW_STYLES: readonly BrowStyle[] = ['soft', 'straight', 'arched', 'angled', 'short'];

export type NoseStyle = 'none' | 'tick' | 'shadow' | 'dot' | 'button';
export const NOSE_STYLES: readonly NoseStyle[] = ['none', 'tick', 'shadow', 'dot', 'button'];

/** Everything the face kit draws. Flat on purpose (easy to patch from sliders: `setFaceFeatures3D(id, { browThickness: .7 })`). */
export interface FaceFeatureParams {
    /** Master switch. Off = no brows / mouth / nose / shading and the eyes back to their classic full-bright look. */
    enabled: boolean;

    // ── Brows ──
    browStyle: BrowStyle;
    /** 0..1 (thin → bold). */
    browThickness: number;
    /** 0.5..1.5 × the eye width. */
    browLength: number;
    /** 0..1 gap above the eye (low → high). */
    browHeight: number;
    /** −1..1: + lifts the outer end (sharp / cool), − drops it (soft / sad). */
    browTilt: number;
    /** '' = follow the hair (its root colour, darkened). Otherwise a hex colour. */
    browColor: string;
    /** Draw the brows over the hair fringe (the anime convention). */
    browsThroughHair: boolean;
    /** Draw the EYES over bangs that hang in front of them (the anime "see-through bangs" read). Off = bangs cover
     *  the eyes (and then the brows hide too). */
    eyesThroughHair: boolean;

    // ── Mouth ──
    /** 0.2..0.9 × the distance between the eye centres. */
    mouthWidth: number;
    /** 0..1 line weight. */
    mouthThickness: number;
    /** 0..1 position from just under the nose (0) to the chin (1). */
    mouthHeight: number;
    /** '' = a warm dark line that suits any skin. Otherwise a hex colour. */
    mouthColor: string;
    /** The held (resting) expression. */
    expression: FaceExpressionName;

    // ── Nose ──
    noseStyle: NoseStyle;
    /** 0..1. */
    noseSize: number;

    // ── Shading ──
    /** 0..1 cheek blush. */
    blush: number;
    blushColor: string;
    /** Draw the anime hatch lines over the blush. */
    blushLines: boolean;
    /** 0..1 soft contour shading on the cheeks / jaw sides. */
    cheekShade: number;
    /** 0..1 strength of the hair's hard shadow across the forehead. */
    hairShadow: number;
    /** 0..1 how far below the fringe the shadow reaches. */
    hairShadowDepth: number;
    /** 0..1 how much scene light reaches the eyes (0 = the classic full-bright eyes; 0.4 sits them in the face). */
    eyeShade: number;

    // ── Life (the idle / personality hooks) ──
    /** 0..1 chance that a blink comes with a small brow raise. */
    lifeBrowRaise: number;
    /** Now and then, a short smile while idle (only from the resting expression). */
    lifeSmile: boolean;

    // ── Render ──
    /** Internal resolution across the face (px): −1 = match the eyes' pixelResolution (chunky together), 0 = crisp. */
    pixelResolution: number;
}

/** The new-character default: soft brows following the hair, a small neutral mouth, a nose tick, light blush. */
export function defaultFaceFeatureParams(): FaceFeatureParams {
    return {
        enabled: true,
        browStyle: 'soft', browThickness: 0.5, browLength: 1.0, browHeight: 0.45, browTilt: 0.1, browColor: '', browsThroughHair: true, eyesThroughHair: false,
        mouthWidth: 0.42, mouthThickness: 0.5, mouthHeight: 0.42, mouthColor: '', expression: 'neutral',
        noseStyle: 'tick', noseSize: 0.5,
        blush: 0.3, blushColor: '#ff8a9a', blushLines: false, cheekShade: 0.25,
        hairShadow: 0.6, hairShadowDepth: 0.5,
        eyeShade: 0.4,
        lifeBrowRaise: 0.25, lifeSmile: true,
        pixelResolution: -1,
    };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** Clamped + rounded to 1e-4, so a save (which writes ~6 significant digits) reloads to the exact same params. */
const num = (v: unknown, d: number, a: number, b: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(clamp(v, a, b) * 1e4) / 1e4 : d);
const pickOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);

/** A full, valid parameter set from anything (a partial patch, a document saved by an older / newer build). Unknown
 *  keys are dropped, missing or invalid ones take the default, numbers are clamped. Pure. */
export function normalizeFaceFeatureParams(p?: Partial<FaceFeatureParams> | null): FaceFeatureParams {
    const d = defaultFaceFeatureParams(), q = (p ?? {}) as Partial<FaceFeatureParams>;
    return {
        enabled: typeof q.enabled === 'boolean' ? q.enabled : d.enabled,
        browStyle: pickOf(q.browStyle, BROW_STYLES, d.browStyle),
        browThickness: num(q.browThickness, d.browThickness, 0, 1),
        browLength: num(q.browLength, d.browLength, 0.5, 1.5),
        browHeight: num(q.browHeight, d.browHeight, 0, 1),
        browTilt: num(q.browTilt, d.browTilt, -1, 1),
        browColor: isHex(q.browColor) ? q.browColor : '',
        browsThroughHair: typeof q.browsThroughHair === 'boolean' ? q.browsThroughHair : d.browsThroughHair,
        eyesThroughHair: typeof q.eyesThroughHair === 'boolean' ? q.eyesThroughHair : d.eyesThroughHair,
        mouthWidth: num(q.mouthWidth, d.mouthWidth, 0.2, 0.9),
        mouthThickness: num(q.mouthThickness, d.mouthThickness, 0, 1),
        mouthHeight: num(q.mouthHeight, d.mouthHeight, 0, 1),
        mouthColor: isHex(q.mouthColor) ? q.mouthColor : '',
        expression: pickOf(q.expression, FACE_EXPRESSION_NAMES, d.expression),
        noseStyle: pickOf(q.noseStyle, NOSE_STYLES, d.noseStyle),
        noseSize: num(q.noseSize, d.noseSize, 0, 1),
        blush: num(q.blush, d.blush, 0, 1),
        blushColor: isHex(q.blushColor) ? q.blushColor : d.blushColor,
        blushLines: typeof q.blushLines === 'boolean' ? q.blushLines : d.blushLines,
        cheekShade: num(q.cheekShade, d.cheekShade, 0, 1),
        hairShadow: num(q.hairShadow, d.hairShadow, 0, 1),
        hairShadowDepth: num(q.hairShadowDepth, d.hairShadowDepth, 0, 1),
        eyeShade: num(q.eyeShade, d.eyeShade, 0, 1),
        lifeBrowRaise: num(q.lifeBrowRaise, d.lifeBrowRaise, 0, 1),
        lifeSmile: typeof q.lifeSmile === 'boolean' ? q.lifeSmile : d.lifeSmile,
        pixelResolution: num(q.pixelResolution, d.pixelResolution, -1, 1024),
    };
}

/** Random-character ranges (the T6 randomizer, character-randomizer.ts). `r(a,b)` / `pick` / `chance` come from the
 *  caller's seeded RNG; the brows follow the hair colour (browColor ''). */
export function randomFaceFeatureParams(rng: { range(a: number, b: number): number; next(): number; chance(p: number): boolean }): FaceFeatureParams {
    const pick = <T>(arr: readonly T[]): T => arr[Math.min(arr.length - 1, Math.floor(rng.next() * arr.length))];
    return normalizeFaceFeatureParams({
        browStyle: pick(['soft', 'soft', 'straight', 'arched', 'angled', 'short'] as const),
        browThickness: rng.range(0.35, 0.8),
        browLength: rng.range(0.85, 1.15),
        browHeight: rng.range(0.3, 0.65),
        browTilt: rng.range(-0.25, 0.4),
        mouthWidth: rng.range(0.32, 0.55),
        mouthThickness: rng.range(0.35, 0.7),
        mouthHeight: rng.range(0.36, 0.5),
        expression: pick(['neutral', 'neutral', 'neutral', 'smile', 'smile'] as const),
        noseStyle: pick(['tick', 'tick', 'shadow', 'dot', 'button'] as const),
        noseSize: rng.range(0.35, 0.7),
        blush: rng.chance(0.6) ? rng.range(0.2, 0.55) : 0,
        blushColor: pick(['#ff8a9a', '#ff9a8a', '#f07a90', '#ffa0b0'] as const),
        blushLines: rng.chance(0.25),
        cheekShade: rng.range(0.15, 0.35),
        hairShadow: rng.range(0.5, 0.8),
        hairShadowDepth: rng.range(0.35, 0.7),
    });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Expressions
// ═══════════════════════════════════════════════════════════════════════════

/** The numbers an expression moves. Blends are linear in these. */
export interface ExpressionShape {
    /** Both brows up (+) / down (−), in eye half-heights × 0.55. */
    browRaise: number;
    /** Inner brow ends: + up (worried / surprised), − down (cross). */
    browInner: number;
    /** −1 frown … +1 smile (mouth corners). */
    mouthCurve: number;
    /** 0..1 jaw open. */
    mouthOpen: number;
    /** 0..1 how round the open mouth is (an "O"). */
    mouthRound: number;
    /** Width change, × the mouth width (−0.5..0.5). */
    mouthWide: number;
    /** Extra blush 0..1. */
    blush: number;
}

const ZERO: ExpressionShape = { browRaise: 0, browInner: 0, mouthCurve: 0, mouthOpen: 0, mouthRound: 0, mouthWide: 0, blush: 0 };

export const EXPRESSION_SHAPES: Readonly<Record<FaceExpressionName, Readonly<ExpressionShape>>> = {
    neutral:   ZERO,
    smile:     { browRaise: 0.15, browInner: 0.1, mouthCurve: 0.85, mouthOpen: 0, mouthRound: 0, mouthWide: 0.15, blush: 0.2 },
    open:      { browRaise: 0.35, browInner: 0.15, mouthCurve: 0.6, mouthOpen: 0.65, mouthRound: 0.1, mouthWide: 0.1, blush: 0.25 },
    frown:     { browRaise: -0.25, browInner: -0.7, mouthCurve: -0.75, mouthOpen: 0, mouthRound: 0, mouthWide: -0.1, blush: 0 },
    surprised: { browRaise: 1.0, browInner: 0.35, mouthCurve: 0, mouthOpen: 0.75, mouthRound: 1, mouthWide: -0.35, blush: 0.1 },
};

export type ExpressionWeights = Partial<Record<FaceExpressionName, number>>;

/** Weighted sum of expression shapes (+ an additive `extra`). Weights are clamped ≥ 0 and normalised only when they sum
 *  past 1, so `{ smile: 0.5 }` is half a smile and `{ smile: 1, open: 1 }` is the average of the two. Pure. */
export function blendExpressionShapes(weights: ExpressionWeights, extra?: Partial<ExpressionShape>): ExpressionShape {
    let sum = 0;
    for (const n of FACE_EXPRESSION_NAMES) sum += Math.max(0, weights[n] ?? 0);
    const k = sum > 1 ? 1 / sum : 1;
    const out: ExpressionShape = { ...ZERO };
    for (const n of FACE_EXPRESSION_NAMES) {
        const w = Math.max(0, weights[n] ?? 0) * k;
        if (!w) continue;
        const s = EXPRESSION_SHAPES[n];
        for (const key of Object.keys(out) as (keyof ExpressionShape)[]) out[key] += s[key] * w;
    }
    if (extra) for (const key of Object.keys(out) as (keyof ExpressionShape)[]) out[key] += extra[key] ?? 0;
    return out;
}

/** a → b by t (0..1). Pure. */
export function lerpExpressionShape(a: ExpressionShape, b: ExpressionShape, t: number): ExpressionShape {
    const out = { ...a };
    for (const key of Object.keys(out) as (keyof ExpressionShape)[]) out[key] = a[key] + (b[key] - a[key]) * t;
    return out;
}

/** An expression argument (a name or weights) → weights. Unknown names → neutral. */
export function expressionWeights(e: FaceExpressionName | ExpressionWeights | string): ExpressionWeights {
    if (typeof e === 'string') return FACE_EXPRESSION_NAMES.includes(e as FaceExpressionName) ? { [e]: 1 } : { neutral: 1 };
    const w: ExpressionWeights = {};
    for (const n of FACE_EXPRESSION_NAMES) if (typeof e[n] === 'number' && Number.isFinite(e[n])) w[n] = Math.max(0, e[n]!);
    return w;
}

/** The dominant expression name of a weight set (for the UI's "current expression"). */
export function dominantExpression(w: ExpressionWeights): FaceExpressionName {
    let best: FaceExpressionName = 'neutral', bw = 0;
    for (const n of FACE_EXPRESSION_NAMES) if ((w[n] ?? 0) > bw) { bw = w[n]!; best = n; }
    return best;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Colour
// ═══════════════════════════════════════════════════════════════════════════

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
    let h = (hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The multiplier that turns `skin` into `target` (per channel, clamped to [0, cap]): multiply blending can only
 *  darken, so a target lighter than the skin clamps. Pure. */
export function featureMultiplier(target: RGB, skin: RGB, cap = 1): RGB {
    return [0, 1, 2].map((i) => clamp(target[i] / Math.max(skin[i], 1e-3), 0, cap)) as RGB;
}

const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** The brow colour (a TARGET colour on the skin): the explicit browColor, else the hair root darkened; always at most
 *  ~60% of the skin's luminance so brows read on any skin (a blonde / white-haired character gets soft grey-brown
 *  brows instead of invisible ones). Pure. */
export function resolveBrowColor(browColor: string, hairRoot: string | null, skin: RGB): RGB {
    let c: RGB;
    if (isHex(browColor)) c = hexToRgb(browColor);
    else if (hairRoot && isHex(hairRoot)) { const h = hexToRgb(hairRoot); c = [h[0] * 0.62, h[1] * 0.58, h[2] * 0.58]; }
    else c = [0.18, 0.12, 0.10];
    const cap = lum(skin) * 0.6, l = lum(c);
    if (l > cap && l > 1e-4) { const k = cap / l; c = [c[0] * k, c[1] * k, c[2] * k]; }
    return c;
}

// Multipliers (skin-relative by nature — multiply blending): the shared shading tints.
/** Warm skin shadow (nose / cheek / hair shadow), the same family as the skin ramp's rose tint. */
export const SHADE_MULT: RGB = [0.80, 0.64, 0.68];
/** The hair's cast shadow on the forehead: deeper and warmer (anime skin shadow is rosy, never grey). */
export const HAIR_SHADE_MULT: RGB = [0.76, 0.56, 0.60];
/** The default mouth / nose line: a warm dark brown-red on any skin. */
export const LINE_MULT: RGB = [0.40, 0.24, 0.25];
/** Open-mouth interior and tongue. */
const MOUTH_MULT: RGB = [0.36, 0.12, 0.15];
const TONGUE_MULT: RGB = [0.92, 0.48, 0.52];

// ═══════════════════════════════════════════════════════════════════════════
//  Layout (where things go on a given head)
// ═══════════════════════════════════════════════════════════════════════════

export interface FaceEyeLayout {
    cx: number; cy: number;
    /** Visual half extents (the eye generator's aspect-corrected width / height). */
    halfW: number; halfH: number;
    tilt: number; roundness: number;
    /** +1 = the outer corner is on +x (the screen-right eye). */
    outerSign: number;
}

export interface FaceRect { x0: number; x1: number; y0: number; y1: number }

export interface FaceLayout {
    /** The skin layer's rect and the brow layer's rect (local units). */
    skin: FaceRect;
    brow: FaceRect;
    midX: number;
    eyes: [FaceEyeLayout, FaceEyeLayout];
    /** Nose tip and chin (front-most / lowest front points), local y. */
    noseY: number; chinY: number;
    /** Face half width at the mouth line. */
    faceHalfW: number;
    /** The hair fringe: per column, the y of the bottom of the hair that hangs in front of the forehead (NaN = no hair
     *  there). Columns span the skin rect's x range. Null = no hair. */
    fringe: { y: Float32Array } | null;
}

/** The eye decal frame (Scene3DCharacter._buildFaceDecal): centre x, eye-band centre y, half width, half height. */
export interface EyeDecalFrame { cx: number; cy: number; hw: number; hh: number }

/** The two eyes' visual layout from their params on the eye decal (mirrors eye-generator.renderEyes + its aspect
 *  squish: half width = width·hh, half height = height·hh, centres at cx ± spacing·hw on the eye line). Pure. */
export function eyeLayoutFromParams(ep: Pick<EyeParams, 'spacing' | 'verticalPos' | 'width' | 'height' | 'tilt' | 'roundness'>, f: EyeDecalFrame): [FaceEyeLayout, FaceEyeLayout] {
    const cy = f.cy + f.hh - ep.verticalPos * 2 * f.hh;
    const one = (s: number): FaceEyeLayout => ({
        cx: f.cx + s * ep.spacing * f.hw, cy, halfW: ep.width * f.hh, halfH: ep.height * f.hh,
        tilt: ep.tilt, roundness: ep.roundness, outerSign: s,
    });
    return [one(-1), one(1)];
}

/**
 * The hair FRINGE profile over a rect: rasterise the hair triangles that hang in FRONT of the face (z > zMin) into a
 * coarse occupancy grid, then walk each column down from the top while it stays covered (one-cell gaps bridged). The
 * first uncovered cell is the fringe edge. Columns with no hair at the top give NaN. Pure.
 */
export function computeFringe(hairVerts: Float32Array, hairIdx: Uint32Array | number[], rect: FaceRect, zMin: number, cols = 64, rows = 64, stride = 12, vMax = Infinity): Float32Array {
    const occ = new Uint8Array(cols * rows);
    const W = rect.x1 - rect.x0, H = rect.y1 - rect.y0;
    if (!(W > 0) || !(H > 0)) return new Float32Array(cols).fill(NaN);
    const cx = (x: number) => ((x - rect.x0) / W) * cols, cy = (y: number) => ((rect.y1 - y) / H) * rows;   // row 0 = top
    for (let t = 0; t + 2 < hairIdx.length; t += 3) {
        const a = hairIdx[t] * stride, b = hairIdx[t + 1] * stride, c = hairIdx[t + 2] * stride;
        if (hairVerts[a + 2] < zMin && hairVerts[b + 2] < zMin && hairVerts[c + 2] < zMin) continue;
        const ax = cx(hairVerts[a]), ay = cy(hairVerts[a + 1]), bx = cx(hairVerts[b]), by = cy(hairVerts[b + 1]), qx = cx(hairVerts[c]), qy = cy(hairVerts[c + 1]);
        const minX = Math.max(0, Math.floor(Math.min(ax, bx, qx))), maxX = Math.min(cols - 1, Math.floor(Math.max(ax, bx, qx)));
        const minY = Math.max(0, Math.floor(Math.min(ay, by, qy))), maxY = Math.min(rows - 1, Math.floor(Math.max(ay, by, qy)));
        if (minX > maxX || minY > maxY) continue;
        const d = (bx - ax) * (qy - ay) - (qx - ax) * (by - ay);
        if (Math.abs(d) < 1e-9) { occ[minY * cols + minX] = 1; continue; }
        for (let j = minY; j <= maxY; j++) for (let i = minX; i <= maxX; i++) {
            // Conservative: the cell centre, or a near miss (thin hair cards must still register).
            const px = i + 0.5, py = j + 0.5;
            const w1 = ((bx - px) * (qy - py) - (qx - px) * (by - py)) / d;
            const w2 = ((qx - px) * (ay - py) - (ax - px) * (qy - py)) / d;
            const w3 = 1 - w1 - w2, e = -0.35;
            if (!(w1 >= e && w2 >= e && w3 >= e)) continue;
            // Hair CARDS are alpha-cut strands: only the solid root part (uv.v < vMax) of a card casts the fringe.
            if (vMax < Infinity && w1 * hairVerts[a + 7] + w2 * hairVerts[b + 7] + w3 * hairVerts[c + 7] > vMax) continue;
            occ[j * cols + i] = 1;
        }
    }
    const out = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
        if (!occ[i]) { out[i] = NaN; continue; }
        let j = 0;
        while (j + 1 < rows && (occ[(j + 1) * cols + i] || (j + 2 < rows && occ[(j + 2) * cols + i]))) j++;
        out[i] = rect.y1 - ((j + 1) / rows) * H;
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Overlay geometry (raycast onto the head surface)
// ═══════════════════════════════════════════════════════════════════════════

export interface FaceOverlayGeometry {
    vertices: Float32Array;   // 12-float stride: pos, normal, uv, tangent
    indices: Uint32Array;
    jointIndices: Uint8Array;
    jointWeights: Float32Array;
}

/**
 * A grid over `rect` projected onto the body's head surface along −z (front-most hit), lifted `offset` toward +z and
 * at least to `minZ(x, y)` (e.g. just in front of the eye decal). Each vertex takes the hit triangle's interpolated
 * skin weights (top 4, normalised) so the overlay deforms exactly with the face. Quads whose corners miss the head or
 * span a depth break are dropped. UVs: u = 0..1 over x0→x1, v = 0..1 over y1→y0. Pure.
 */
export function buildFaceOverlayGeometry(
    body: { vertices: Float32Array; indices: Uint32Array | number[]; jointIndices: ArrayLike<number>; jointWeights: ArrayLike<number> },
    headIdx: number, rect: FaceRect, cols: number, rows: number, offset: number,
    minZ?: (x: number, y: number) => number, maxDz = Infinity,
): FaceOverlayGeometry | null {
    const V = body.vertices, I = body.indices, JI = body.jointIndices, JW = body.jointWeights, S = 12;
    const headW = (v: number) => { let w = 0; for (let k = 0; k < 4; k++) if (JI[v * 4 + k] === headIdx) w += JW[v * 4 + k]; return w; };
    // Candidate triangles: touching the head (a vertex ≥ 50% head) and overlapping the rect.
    const tris: number[] = [];
    for (let t = 0; t + 2 < I.length; t += 3) {
        const a = I[t], b = I[t + 1], c = I[t + 2];
        if (headW(a) < 0.5 && headW(b) < 0.5 && headW(c) < 0.5) continue;
        const xs = [V[a * S], V[b * S], V[c * S]], ys = [V[a * S + 1], V[b * S + 1], V[c * S + 1]];
        if (Math.max(...xs) < rect.x0 || Math.min(...xs) > rect.x1 || Math.max(...ys) < rect.y0 || Math.min(...ys) > rect.y1) continue;
        tris.push(a, b, c);
    }
    if (!tris.length) return null;
    const NV = cols * rows;
    const pos = new Float32Array(NV * 3), nrm = new Float32Array(NV * 3), ok = new Uint8Array(NV);
    const ji = new Uint8Array(NV * 4), jw = new Float32Array(NV * 4);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1), v = r / (rows - 1);
        const x = rect.x0 + u * (rect.x1 - rect.x0), y = rect.y1 - v * (rect.y1 - rect.y0);
        let best = -Infinity, bt = -1, b0 = 0, b1 = 0, b2 = 0;
        for (let t = 0; t < tris.length; t += 3) {
            const a = tris[t] * S, b = tris[t + 1] * S, q = tris[t + 2] * S;
            const ax = V[a], ay = V[a + 1], bx = V[b], by = V[b + 1], qx = V[q], qy = V[q + 1];
            const d = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy);
            if (Math.abs(d) < 1e-12) continue;
            const w0 = ((by - qy) * (x - qx) + (qx - bx) * (y - qy)) / d;
            const w1 = ((qy - ay) * (x - qx) + (ax - qx) * (y - qy)) / d;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const z = w0 * V[a + 2] + w1 * V[b + 2] + w2 * V[q + 2];
            if (z > best) { best = z; bt = t; b0 = w0; b1 = w1; b2 = w2; }
        }
        if (bt < 0) continue;
        const i = r * cols + c;
        let z = best + offset;
        if (minZ) z = Math.max(z, minZ(x, y));
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        // Normal: the hit triangle's, facing +z (the overlay is unlit; this only keeps tools that read normals sane).
        const a = tris[bt] * S, b = tris[bt + 1] * S, q = tris[bt + 2] * S;
        const e1 = [V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]], e2 = [V[q] - V[a], V[q + 1] - V[a + 1], V[q + 2] - V[a + 2]];
        let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const nl = Math.hypot(nx, ny, nz) || 1;
        nrm[i * 3] = nx / nl; nrm[i * 3 + 1] = ny / nl; nrm[i * 3 + 2] = nz / nl;
        // Skin weights: the barycentric blend of the hit triangle's three vertices, top 4 joints.
        const acc = new Map<number, number>();
        const add = (vi: number, bw: number) => { for (let k = 0; k < 4; k++) { const w = JW[vi * 4 + k] * bw; if (w > 0) acc.set(JI[vi * 4 + k], (acc.get(JI[vi * 4 + k]) ?? 0) + w); } };
        add(tris[bt], b0); add(tris[bt + 1], b1); add(tris[bt + 2], b2);
        const top = [...acc].sort((p, q2) => q2[1] - p[1]).slice(0, 4);
        const sw = top.reduce((s, e) => s + e[1], 0) || 1;
        if (!top.length) { ji[i * 4] = headIdx; jw[i * 4] = 1; }
        top.forEach(([j, w], k) => { ji[i * 4 + k] = j; jw[i * 4 + k] = w / sw; });
        ok[i] = 1;
    }
    const idx: number[] = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, q = a + cols, d = q + 1;
        if (!ok[a] || !ok[b] || !ok[q] || !ok[d]) continue;
        const zs = [pos[a * 3 + 2], pos[b * 3 + 2], pos[q * 3 + 2], pos[d * 3 + 2]];
        if (Math.max(...zs) - Math.min(...zs) > maxDz) continue;
        idx.push(a, q, d, a, d, b);
    }
    if (!idx.length) return null;
    // Compact to the used vertices.
    const remap = new Int32Array(NV).fill(-1);
    let n = 0;
    for (const v of idx) if (remap[v] < 0) remap[v] = n++;
    const vertices = new Float32Array(n * 12), jointIndices = new Uint8Array(n * 4), jointWeights = new Float32Array(n * 4);
    for (let v = 0; v < NV; v++) {
        const m = remap[v];
        if (m < 0) continue;
        const r = Math.floor(v / cols), c = v % cols;
        vertices.set([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2], c / (cols - 1), r / (rows - 1), 1, 0, 0, 1], m * 12);
        for (let k = 0; k < 4; k++) { jointIndices[m * 4 + k] = ji[v * 4 + k]; jointWeights[m * 4 + k] = jw[v * 4 + k]; }
    }
    return { vertices, indices: new Uint32Array(idx.map((v) => remap[v])), jointIndices, jointWeights };
}

/** The eye decal's surface z at (x, y): its NC×NR grid (Scene3DCharacter._buildFaceDecal) interpolated over the SAME
 *  triangles it is drawn with (a,c,d / a,d,b). −Infinity outside the decal. Pure. */
export function eyeDecalSurfaceZ(decalVerts: Float32Array, NC: number, NR: number): (x: number, y: number) => number {
    const S = 12;
    const X0 = decalVerts[0], X1 = decalVerts[(NC - 1) * S], Y0 = decalVerts[1], Y1 = decalVerts[((NR - 1) * NC) * S + 1];   // row 0 = top
    return (x: number, y: number) => {
        let s = ((x - X0) / (X1 - X0)) * (NC - 1), t = ((Y0 - y) / (Y0 - Y1)) * (NR - 1);
        const e = 1e-4;
        if (!(s >= -e && s <= NC - 1 + e && t >= -e && t <= NR - 1 + e)) return -Infinity;
        s = clamp(s, 0, NC - 1); t = clamp(t, 0, NR - 1);
        const c = Math.min(NC - 2, Math.floor(s)), r = Math.min(NR - 2, Math.floor(t));
        const fs = s - c, ft = t - r;
        const z = (rr: number, cc: number) => decalVerts[(rr * NC + cc) * S + 2];
        const za = z(r, c), zb = z(r, c + 1), zc = z(r + 1, c), zd = z(r + 1, c + 1);
        return ft >= fs ? za + ft * (zc - za) + fs * (zd - zc) : za + fs * (zb - za) + ft * (zd - zb);
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Painting (Canvas2D)
// ═══════════════════════════════════════════════════════════════════════════

type Ctx2D = CanvasRenderingContext2D;
const css = (m: RGB) => `rgb(${Math.round(clamp(m[0], 0, 1) * 255)},${Math.round(clamp(m[1], 0, 1) * 255)},${Math.round(clamp(m[2], 0, 1) * 255)})`;

export interface FacePaintColors {
    /** The body's skin colour (its diffuse), for custom-colour multipliers. */
    skin: RGB;
    /** The hair's root colour (brows follow it), or null. */
    hairRoot: string | null;
    /** Distance LOD: line-weight multiplier (1 = close-up). Scene3DCharacter raises it when the face is small on screen
     *  (Play distance), so brows and the mouth line stay a pixel or two wide instead of breaking up. */
    bold?: number;
}

/** The line-weight multiplier for a face whose width is `frac` of the viewport width (with hysteresis on `prev`). */
export function faceLodBold(frac: number, prev = 1): number {
    const levels = [{ k: 1, min: 0.14 }, { k: 1.6, min: 0.055 }, { k: 2.4, min: 0 }];
    const want = levels.find((l) => frac >= l.min)!.k;
    if (want === prev) return prev;
    // Hysteresis: only switch once the face is 15% past the boundary toward the new level.
    const cur = levels.find((l) => l.k === prev);
    if (cur) { const idx = levels.indexOf(cur); const up = want < prev; const edge = up ? levels[idx - 1]?.min ?? 0 : cur.min; if (up ? frac < edge * 1.15 : frac > edge * 0.87) return prev; }
    return want;
}

/**
 * Paint one overlay layer into `ctx` (w×h): 'skin' = hair shadow, cheek shade, blush, nose, mouth; 'brow' = the brows.
 * Cleared to transparent first. Draws MULTIPLIERS (see the file header) in head-local units through a canvas
 * transform, so shapes keep their proportions whatever the rect's aspect. Pure apart from the canvas.
 */
export function renderFaceLayer(ctx: Ctx2D, layer: 'skin' | 'brow', p: FaceFeatureParams, L: FaceLayout, shape: ExpressionShape, colors: FacePaintColors, w: number, h: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!p.enabled) return;
    const R = layer === 'skin' ? L.skin : L.brow;
    const sx = w / (R.x1 - R.x0), sy = h / (R.y1 - R.y0);
    ctx.setTransform(sx, 0, 0, -sy, -R.x0 * sx, R.y1 * sy);   // local (x right, y up) → canvas px
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (layer === 'brow') { for (const e of L.eyes) drawBrow(ctx, p, e, shape, colors); return; }
    if (p.hairShadow > 0 && L.fringe) drawHairShadow(ctx, p, L);
    if (p.cheekShade > 0) drawCheekShade(ctx, p, L);
    const blush = clamp(p.blush + shape.blush, 0, 1);
    if (blush > 0) for (const e of L.eyes) drawBlush(ctx, p, e, blush);
    drawNose(ctx, p, L, colors);
    drawMouth(ctx, p, L, shape, colors);
}

/** A tapered stroke along `pts` (filled polygon), half-width hw(t). */
function taperedStroke(ctx: Ctx2D, pts: [number, number][], hw: (t: number) => number): void {
    const n = pts.length, up: [number, number][] = [], dn: [number, number][] = [];
    for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        let tx = b[0] - a[0], ty = b[1] - a[1];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const r = hw(i / (n - 1));
        up.push([pts[i][0] - ty * r, pts[i][1] + tx * r]);
        dn.push([pts[i][0] + ty * r, pts[i][1] - tx * r]);
    }
    ctx.beginPath();
    ctx.moveTo(up[0][0], up[0][1]);
    for (let i = 1; i < n; i++) ctx.lineTo(up[i][0], up[i][1]);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(dn[i][0], dn[i][1]);
    ctx.closePath();
    ctx.fill();
}

function drawBrow(ctx: Ctx2D, p: FaceFeatureParams, e: FaceEyeLayout, s: ExpressionShape, colors: FacePaintColors): void {
    const hh = e.halfH, os = e.outerSign;
    const short = p.browStyle === 'short';
    const len = p.browLength * e.halfW * (short ? 1.15 : 2.15);
    const bx = e.cx + os * e.halfW * (short ? -0.2 : 0.08);
    const inX = bx - os * len * 0.5, outX = bx + os * len * 0.5;
    const base = e.cy + hh * (1.0 + 0.2 * e.roundness) + hh * (0.25 + 0.9 * p.browHeight) + s.browRaise * hh * 0.6;
    const inDy = (s.browInner * 0.55 - p.browTilt * 0.25) * hh;
    const outDy = (p.browTilt * 0.45 - s.browInner * 0.12 + e.tilt * 0.3) * hh;
    const arch = ({ soft: 0.3, straight: 0.05, arched: 0.55, angled: 0.42, short: 0.08 } as const)[p.browStyle] * hh;
    const T = (0.2 + 0.5 * p.browThickness) * hh * (short ? 1.45 : 1) * Math.min(colors.bold ?? 1, 1.6);
    const N = 18, pts: [number, number][] = [];
    for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const bump = p.browStyle === 'angled' ? (t < 0.62 ? t / 0.62 : 1 - (t - 0.62) / 0.38 * 0.9) : Math.sin(Math.PI * t);
        pts.push([inX + (outX - inX) * t, base + inDy + (outDy - inDy) * t + arch * bump]);
    }
    const prof = (t: number): number => {
        switch (p.browStyle) {
            case 'straight': return 0.95 - 0.35 * t;
            case 'arched':   return 0.8 + 0.2 * Math.sin(Math.PI * t * 0.8) - 0.55 * t * t;
            case 'angled':   return 1.0 - 0.7 * t;
            case 'short':    return Math.max(0.35, Math.sin(Math.PI * (0.12 + 0.76 * t)));
            default:         return Math.min(1, 0.55 + t * 5) * (1 - 0.72 * Math.pow(t, 1.25));   // soft: rounded head, long taper
        }
    };
    ctx.fillStyle = css(featureMultiplier(resolveBrowColor(p.browColor, colors.hairRoot, colors.skin), colors.skin));
    ctx.globalAlpha = 1;
    taperedStroke(ctx, pts, (t) => 0.5 * T * prof(t));
}

function drawHairShadow(ctx: Ctx2D, p: FaceFeatureParams, L: FaceLayout): void {
    const f = L.fringe!.y, n = f.length, R = L.skin;
    const eyeTop = Math.min(L.eyes[0].cy, L.eyes[1].cy) + 0.2 * L.eyes[0].halfH;   // never deeper than the upper eye
    const depth = L.eyes[0].halfH * (0.35 + 1.4 * p.hairShadowDepth);
    const col = (i: number) => R.x0 + ((i + 0.5) / n) * (R.x1 - R.x0);
    // Smooth the raster steps (5-tap mean of a 3-tap median) but keep the fringe's dips and points.
    const med = (i: number) => {
        const v = [f[Math.max(0, i - 1)], f[i], f[Math.min(n - 1, i + 1)]].filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : NaN;
    };
    const m3 = Array.from({ length: n }, (_, i) => med(i));
    const sm = (i: number) => { let s = 0, k = 0; for (let j = i - 2; j <= i + 2; j++) { const v = m3[Math.max(0, Math.min(n - 1, j))]; if (!Number.isNaN(v)) { s += v; k++; } } return k ? s / k : NaN; };
    // The cast shadow is deepest over the forehead and fades out toward the temples (side hair hangs THERE, so its
    // "fringe" would otherwise frame the face in a grey hood).
    const foreHalf = Math.abs(L.eyes[1].cx - L.midX) + L.eyes[1].halfW * 1.5;
    const taper = (x: number) => clamp(1 - (Math.abs(x - L.midX) / foreHalf - 0.7) / 0.45, 0, 1);
    const top = R.y1 + (R.y1 - R.y0);   // well above the rect (the hair hides it anyway)
    ctx.beginPath();
    ctx.moveTo(R.x0, top);
    let any = false;
    for (let i = 0; i < n; i++) {
        const m = sm(i), x = col(i);
        const y = Number.isNaN(f[i]) || Number.isNaN(m) ? top : Math.max(eyeTop, m - depth * taper(x));
        if (y < R.y1) any = true;
        ctx.lineTo(x, y);
    }
    ctx.lineTo(R.x1, top);
    ctx.closePath();
    if (!any) return;
    ctx.fillStyle = css(HAIR_SHADE_MULT);
    ctx.globalAlpha = 0.9 * p.hairShadow;
    ctx.fill();
    ctx.globalAlpha = 1;
}

function softEllipse(ctx: Ctx2D, x: number, y: number, rx: number, ry: number, m: RGB, a: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, css(m)); g.addColorStop(0.55, css(m));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.globalAlpha = a;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
}

function drawCheekShade(ctx: Ctx2D, p: FaceFeatureParams, L: FaceLayout): void {
    const e = L.eyes[1], y = (e.cy + L.noseY) * 0.5 - e.halfH * 0.6;
    for (const s of [-1, 1]) softEllipse(ctx, L.midX + s * L.faceHalfW * 0.98, y, L.faceHalfW * 0.32, e.halfH * 3.2, SHADE_MULT, 0.75 * p.cheekShade);
}

function drawBlush(ctx: Ctx2D, p: FaceFeatureParams, e: FaceEyeLayout, a: number): void {
    const x = e.cx + e.outerSign * e.halfW * 0.2, y = e.cy - e.halfH * 1.9;
    const rx = e.halfW * 0.85, ry = e.halfH * 0.5;
    const m = hexToRgb(p.blushColor);
    softEllipse(ctx, x, y, rx, ry, m, 0.7 * a);
    if (p.blushLines) {
        ctx.strokeStyle = css(m.map((c) => c * 0.82) as RGB);
        ctx.lineWidth = e.halfH * 0.07;
        ctx.globalAlpha = Math.min(1, 0.4 + a);
        for (let k = -1; k <= 1; k++) {
            const lx = x + k * rx * 0.42;
            ctx.beginPath(); ctx.moveTo(lx - rx * 0.12, y - ry * 0.45); ctx.lineTo(lx + rx * 0.12, y + ry * 0.45); ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }
}

function lineMult(hex: string, colors: FacePaintColors): RGB {
    return isHex(hex) ? featureMultiplier(hexToRgb(hex), colors.skin) : LINE_MULT;
}

function drawNose(ctx: Ctx2D, p: FaceFeatureParams, L: FaceLayout, colors: FacePaintColors): void {
    if (p.noseStyle === 'none') return;
    const s = L.eyes[0].halfH * (1.2 + 1.4 * p.noseSize), x = L.midX, y = L.noseY;
    const lm = lineMult(p.mouthColor, colors);
    ctx.strokeStyle = css(lm);
    ctx.fillStyle = css(lm);
    ctx.lineWidth = L.eyes[0].halfH * 0.2 * (colors.bold ?? 1);
    switch (p.noseStyle) {
        case 'shadow': {
            ctx.fillStyle = css(SHADE_MULT);
            // A short side shadow off the tip (it used to run 1.5 s up to the eye line, which on the new flat-shaded faces
            // read as a long dark wedge down the bridge — the very facet look the face normals remove).
            ctx.globalAlpha = 0.6;
            ctx.beginPath(); ctx.moveTo(x - s * 0.05, y + s * 0.75); ctx.lineTo(x - s * 0.42, y - s * 0.05); ctx.lineTo(x - s * 0.02, y - s * 0.2); ctx.closePath(); ctx.fill();
            ctx.globalAlpha = 0.9;
            ctx.beginPath(); ctx.moveTo(x - s * 0.18, y - s * 0.22); ctx.lineTo(x + s * 0.12, y - s * 0.16); ctx.stroke();
            break;
        }
        case 'dot':
            ctx.globalAlpha = 0.85;
            ctx.beginPath(); ctx.ellipse(x + s * 0.04, y - s * 0.12, s * 0.12, s * 0.09, 0, 0, Math.PI * 2); ctx.fill();
            break;
        case 'button':
            ctx.globalAlpha = 0.85;
            ctx.beginPath(); ctx.moveTo(x - s * 0.28, y - s * 0.05); ctx.quadraticCurveTo(x, y - s * 0.32, x + s * 0.28, y - s * 0.05); ctx.stroke();
            break;
        default:   // 'tick': the classic small line down the light side of the tip
            ctx.globalAlpha = 0.9;
            ctx.beginPath(); ctx.moveTo(x + s * 0.3, y + s * 0.55); ctx.quadraticCurveTo(x + s * 0.22, y + s * 0.05, x - s * 0.02, y - s * 0.14); ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

function drawMouth(ctx: Ctx2D, p: FaceFeatureParams, L: FaceLayout, s: ExpressionShape, colors: FacePaintColors): void {
    const [l, r] = L.eyes;
    const spacing = Math.abs(r.cx - l.cx);
    const w = Math.max(spacing * 0.08, spacing * p.mouthWidth * (1 + clamp(s.mouthWide, -0.6, 0.6)));
    const hh = l.halfH;
    const mx = L.midX;
    const top = L.noseY - hh * 0.55, bot = L.chinY + hh * 0.5;
    const my = top + (bot - top) * p.mouthHeight;
    const curve = clamp(s.mouthCurve, -1, 1), open = clamp(s.mouthOpen, 0, 1), round = clamp(s.mouthRound, 0, 1);
    const lm = lineMult(p.mouthColor, colors);
    const lw = hh * (0.10 + 0.16 * p.mouthThickness) * (colors.bold ?? 1);
    const cornerY = my + curve * w * 0.16;   // smile → corners up
    const midY = my - curve * w * 0.08;      // … and the middle dips
    const N = 16;
    // Upper lip (L → R) and lower lip (R → L) of the open shape; blended toward an ellipse by `round`.
    const ow = w * (1 - 0.5 * round), oh = Math.max(open * w * 0.55, 1e-6);
    const upper: [number, number][] = [], lower: [number, number][] = [];
    for (let i = 0; i < N; i++) {
        const t = i / (N - 1), x = mx - w / 2 + w * t;
        const qy = (1 - t) * (1 - t) * cornerY + 2 * t * (1 - t) * (midY + open * hh * 0.1) + t * t * cornerY;
        const qyl = (1 - t) * (1 - t) * cornerY + 2 * t * (1 - t) * (midY - oh * 2) + t * t * cornerY;
        const ang = Math.PI * (1 - t);
        const ex = mx + Math.cos(ang) * ow / 2, eyU = my + open * w * 0.05 + Math.sin(ang) * oh * 0.45, eyL = my + open * w * 0.05 - Math.sin(ang) * oh * 0.55;
        upper.push([x + (ex - x) * round, qy + (eyU - qy) * round]);
        lower.push([x + (ex - x) * round, qyl + (eyL - qyl) * round]);
    }
    if (open > 0.04) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(upper[0][0], upper[0][1]);
        for (const q of upper) ctx.lineTo(q[0], q[1]);
        for (let i = N - 1; i >= 0; i--) ctx.lineTo(lower[i][0], lower[i][1]);
        ctx.closePath();
        ctx.fillStyle = css(MOUTH_MULT);
        ctx.globalAlpha = 1;
        ctx.fill();
        ctx.clip();
        // Tongue low in the mouth; a hint of teeth under the upper lip on a wide open smile.
        ctx.fillStyle = css(TONGUE_MULT);
        ctx.beginPath(); ctx.ellipse(mx, my - oh * 1.15, ow * 0.32, oh * 0.6, 0, 0, Math.PI * 2); ctx.fill();
        if (curve > 0.3 && round < 0.5) {
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            for (let i = 0; i < N; i++) { const q = upper[i]; if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); }
            for (let i = N - 1; i >= 0; i--) ctx.lineTo(upper[i][0], upper[i][1] - oh * 0.28 * Math.sin(Math.PI * i / (N - 1)));
            ctx.closePath(); ctx.fill();
        }
        ctx.restore();
        // Outline: the upper lip heavy, the lower light.
        ctx.strokeStyle = css(lm);
        ctx.lineWidth = lw * 0.8;
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.moveTo(upper[0][0], upper[0][1]); for (const q of upper) ctx.lineTo(q[0], q[1]); ctx.stroke();
        ctx.lineWidth = lw * 0.45;
        ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.moveTo(lower[0][0], lower[0][1]); for (const q of lower) ctx.lineTo(q[0], q[1]); ctx.stroke();
        ctx.globalAlpha = 1;
    } else {
        // Closed: a tapered line, heavier in the middle, thin at the corners (+ little corner ticks on a smile).
        ctx.fillStyle = css(lm);
        ctx.globalAlpha = 1;
        taperedStroke(ctx, upper, (t) => lw * (0.3 + 0.7 * Math.sin(Math.PI * t)) * 0.6);
        if (curve > 0.4) {
            ctx.strokeStyle = css(lm);
            ctx.lineWidth = lw * 0.35;
            ctx.globalAlpha = 0.8;
            for (const sgn of [-1, 1]) {
                const cx0 = mx + sgn * w / 2;
                ctx.beginPath(); ctx.moveTo(cx0, cornerY); ctx.lineTo(cx0 + sgn * w * 0.05, cornerY + w * 0.05 * curve); ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }
    }
    // Lower-lip shadow: a short soft dash under the mouth (sells the lip volume at any distance).
    const lipY = my - (open > 0.04 ? oh * 1.9 : hh * 0.32) - Math.max(0, -curve) * w * 0.05;
    ctx.strokeStyle = css(SHADE_MULT.map((c) => c * 0.9) as RGB);
    ctx.lineWidth = hh * 0.12 * (colors.bold ?? 1);
    ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.moveTo(mx - w * 0.14, lipY); ctx.lineTo(mx + w * 0.14, lipY); ctx.stroke();
    ctx.globalAlpha = 1;
}
