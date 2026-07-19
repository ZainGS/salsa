/**
 * clothing-generator.ts — procedural chunky low-poly garments (top + bottom).
 *
 * Like the body/hair generators, but a garment spans MULTIPLE joints, so each ring blends skin
 * weights between the two joints it sits between (exactly how body-generator weights its tubes) —
 * the garment shares the body's skeleton and deforms with every pose, no manual rig. Auto-fit: each
 * ring's radius = the body's sampled cross-section radius at that level + a thickness offset.
 *
 * The caller passes a `BodyFit` (resolved joint indices + rest-pose world positions + sampled radii)
 * and gets back geometry + jointIndices/jointWeights to drop onto a SkinnedMesh3D on the body's
 * skeleton. See docs/specs/clothing-generation.md.
 */

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import type { ArmRing } from './body-generator';   // the body's actual arm rings → sleeve = these offset outward
import { VertGrid } from './vert-grid';

type V3 = [number, number, number];

/** One body joint, resolved for fitting: skeleton index, rest-pose world pos, a scalar sampled radius,
 *  and a per-sector (RING) directional radius profile (world-XZ) so a torso ring can hug a non-circular
 *  cross-section instead of approximating it with one circle. */
export interface JointFit { idx: number; pos: V3; radius: number; radii: number[]; }
/** Clean arm radii for sleeve fitting — sampled from arm-dominant verts only, so the torso/deltoid
 *  junction never inflates the cap: the body's extent at the shoulder cap, elbow, and wrist. */
export interface ArmFit { capR: number; elbowR: number; wristR: number; }
/** The body's skinned geometry, for the generation-time shrink-wrap + weight-transfer fit pass.
 *  verts = 12-float interleaved (pos3/normal3/uv2/tangent4); ji/jw = 4 joints+weights per vertex. */
export interface BodyMeshData {
    verts: Float32Array; ji: Uint8Array; jw: Float32Array;
    /** Optional per-fit VertGrid cache, keyed by cell size. When the SAME BodyMeshData is threaded through
     *  several garment fits (a multi-slot body refit), each distinct cell size builds its grid ONCE instead
     *  of once per garment. Callers that build a fresh fit per call simply rebuild as before. Only valid
     *  while `verts` is unmutated (grids index into it). */
    gridCache?: Map<number, VertGrid>;
}

/** Get-or-build the body VertGrid for `cell`, using the fit's cache when present. Identical cell size
 *  ⇒ identical grid, so cached lookups return exactly what a fresh build would. */
function bodyGrid(body: BodyMeshData, cell: number): VertGrid {
    let g = body.gridCache?.get(cell);
    if (!g) { g = new VertGrid(body.verts, cell); body.gridCache?.set(cell, g); }
    return g;
}
/** The body frame a garment is fit to — keyed by joint name (hips/spine/chest/neck/shoulder_L…),
 *  plus per-side arm radii for the sleeves and (optional) the body mesh for the final fit pass. */
export interface BodyFit { joints: Record<string, JointFit | undefined>; arms?: { L?: ArmFit; R?: ArmFit }; body?: BodyMeshData; armSurface?: { L?: ArmRing[]; R?: ArmRing[] }; legSurface?: { L?: ArmRing[]; R?: ArmRing[] }; torsoSurface?: ArmRing[]; drapeSurface?: { verts: Float32Array }; head?: { cx: number; cy: number; cz: number; rx: number; ry: number; rz: number }; eyeY?: number; }

/** A procedural geometric pattern on a garment (applied to the mesh material in-shader, antialiased — see
 *  docs/specs/procedural-patterns.md). Persists with the garment; re-applied on every rebuild. */
export interface ClothingPattern {
    mode: 'none' | 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid';
    secondaryColor: string;   // hex; primary = the garment's baseColor
    freq: number;             // repeats across the UV
    angle: number;            // radians
    scale: number;            // stripe width / dot radius / line thickness (0..1)
    spacing: number;          // per-pattern extra
}

export interface TopParams {
    slot: 'top';
    neckline: 'round' | 'v' | 'crew' | 'collar';
    necklineHeight: number;     // collar height, 0 (scoop, at chest) → 1 (high, at neck)
    hemHeight: number;          // bottom edge, 0 (long, at hips) → 1 (crop, at chest)
    thickness: number;          // offset from the body surface (world units)
    shoulderCoverage: number;   // 0 tank ↔ 1 full shoulder (insets the upper rings)
    sleeveLength: number;       // 0 = none → 1 = full (wrist). ~0.2 cap · ~0.55 elbow · ~0.8 three-quarter
    sleeveWidth: number;        // sleeve offset over the arm (world units; scales the whole sleeve)
    sleeveCap: number;          // extra flare at the SHOULDER only (0 = fitted tube, ~0.5 = puffed)
    sleeveInset: number;        // sleeve-cap slant / where the shoulder seam sits: 0 = flat armhole (bare-shoulder, a deliberate GAP) · 1 = full shoulder coverage · ~1.5 climbs toward the neck
    baseColor: string; trimColor: string; gradient: boolean; trimWidth: number;
    chunkiness: number;
    pattern?: ClothingPattern;
}

export interface BottomParams {
    slot: 'bottom';
    bottomStyle: 'skirt' | 'shorts' | 'pants';
    waistWidth: number;         // TOP girth — scales the waist/pants-top width (× hip radius)
    waistHeight: number;        // raise/lower the waistband (× hip radius)
    length: number;             // skirt/leg length (0 = short, 1 = full to the ankle)
    flare: number;              // skirt hem widen (× waist radius; skirt only)
    legWidth: number;           // pants/shorts: leg WIDTH/bagginess (1 = fitted to the leg … 2-3 = wide/baggy, drapey)
    stack: number;              // pants: baggy "STACK" — lower-cuff accordion folds + flare (0 = none · ~0.7 baggy jeans). §6
    cuffTaper: number;          // pants: TAPER the leg toward the cuff (0 = straight … 1 = skinny ankle). Phase 1A
    thickness: number;
    baseColor: string; trimColor: string; gradient: boolean; trimWidth: number;
    chunkiness: number;
    pattern?: ClothingPattern;
}

export interface ShoeParams {
    slot: 'shoes';
    shoeStyle: 'sneaker' | 'flat' | 'boot' | 'heel' | 'sandal';
    soleThickness: number;   // sole slab height below the foot (world units)
    heelHeight: number;      // extra lift at the HEEL only (0..1) — heels / boots
    shaftHeight: number;     // ANKLE TUBE: a wrap-around shaft up the ankle/leg (0 = none/slide … 0.3 high-top … 1+ boot→knee)
    topCover: number;        // VAMP: how much of the top/instep is covered (0 = open sandal, toes out … 1 = closed upper to the ankle front)
    toePoint: number;        // 0 = round toe → 1 = pointed (tapers the front)
    ankleCollar: number;     // collar-lip height at the ankle / back of the LOW shoe (× foot height)
    thickness: number;       // upper offset over the foot (world units)
    baseColor: string; trimColor: string; gradient: boolean; trimWidth: number;
    chunkiness: number;
    pattern?: ClothingPattern;
}

export interface SockParams {
    slot: 'socks';
    sockStyle: 'ankle' | 'crew' | 'knee' | 'thigh';   // cosmetic / preset label — legHeight is the real driver
    legHeight: number;       // how far up the leg the sock TUBE rises: 0 = no-show … ~0.1 ankle … ~0.32 crew … ~0.62 knee … 1+ thigh-high
    thickness: number;       // fabric offset (thin — socks HUG; the de-collision pins them to the leg)
    baseColor: string; trimColor: string; gradient: boolean; trimWidth: number;   // trim = the cuff/toe/heel band
    chunkiness: number;
    pattern?: ClothingPattern;
}

/** A skin-tight UNDERSHIRT base layer (a tight top with a longer hem that can peek below the main top). Built by
 *  mapping to a tight `TopParams` + `generateTop` (negative hem = below the hips). */
export interface UndershirtParams {
    slot: 'undershirt';
    sleeves: number;            // 0 tank … 0.5 tee … 1 long
    shoulderCoverage: number;   // 0 narrow … 1 full
    neckline: 'round' | 'crew' | 'v';
    hemExtend: number;          // 0 = at the hips … 1 = mid-thigh (drops the hem BELOW the main top so it shows)
    crop?: number;              // 0 = full (hem at the hips) … 1 = cropped to the underbust (bare midriff). Raises the hem; opposes hemExtend.
    thickness: number;          // thin — it HUGS (the de-collision pins it to the body)
    baseColor: string; trimColor: string; gradient: boolean; trimWidth: number; chunkiness: number;
    pattern?: ClothingPattern;
}

/** A skin-tight UNDERPANTS base layer (briefs → boxers). Built by mapping to a tight `BottomParams` shorts. */
export interface UnderpantsParams {
    slot: 'underpants';
    legExtend: number;          // 0 = brief (high cut) … 1 = boxer (mid-thigh; peeks below shorts/skirts)
    waistHeight: number;        // raise/lower the waistband (× hip radius)
    thickness: number;          // thin — HUGS
    baseColor: string; trimColor: string; gradient: boolean; trimWidth: number; chunkiness: number;
    pattern?: ClothingPattern;
}

export type ClothingParams = TopParams | BottomParams | ShoeParams | SockParams | UndershirtParams | UnderpantsParams;

export function defaultTopParams(): TopParams {
    return {
        slot: 'top', neckline: 'round', necklineHeight: 0.8, hemHeight: 0.2, thickness: 0.012,
        shoulderCoverage: 0.8, sleeveLength: 0.5, sleeveWidth: 0.005, sleeveCap: 0.1, sleeveInset: 1.0,
        baseColor: '#e85a8a', trimColor: '#ffffff', gradient: false, trimWidth: 0.12, chunkiness: 0.3,
    };
}
export function defaultBottomParams(): BottomParams {
    return {
        slot: 'bottom', bottomStyle: 'skirt', waistWidth: 0.7, waistHeight: 0.0, length: 0.45, flare: 1.6, legWidth: 1, stack: 0, cuffTaper: 0, thickness: 0.012,
        baseColor: '#5a6ab0', trimColor: '#ffffff', gradient: false, trimWidth: 0.12, chunkiness: 0.3,
    };
}
export function defaultShoeParams(): ShoeParams {
    return {
        slot: 'shoes', shoeStyle: 'sneaker', soleThickness: 0.03, heelHeight: 0.0, shaftHeight: 0.0,
        topCover: 0.85, toePoint: 0.1, ankleCollar: 0.25, thickness: 0.006,
        baseColor: '#3a3a44', trimColor: '#3a3a44', gradient: false, trimWidth: 0, chunkiness: 0.3,
    };
}
export function defaultSockParams(): SockParams {
    return {
        slot: 'socks', sockStyle: 'crew', legHeight: 0.32, thickness: 0.0015,
        baseColor: '#f4f0e8', trimColor: '#d8cebc', gradient: false, trimWidth: 0.08, chunkiness: 0.3,
    };
}
export function defaultUndershirtParams(): UndershirtParams {
    return {
        slot: 'undershirt', sleeves: 0.25, shoulderCoverage: 0.7, neckline: 'crew', hemExtend: 0.5, crop: 0, thickness: 0.0008,
        baseColor: '#ffffff', trimColor: '#1a1a1a', gradient: false, trimWidth: 0.08, chunkiness: 0.3,
        pattern: { mode: 'stripes', secondaryColor: '#1a1a1a', freq: 16, angle: 0, scale: 0.5, spacing: 0 },
    };
}
export function defaultUnderpantsParams(): UnderpantsParams {
    return {
        slot: 'underpants', legExtend: 0.4, waistHeight: 0.0, thickness: 0.0008,
        baseColor: '#ffffff', trimColor: '#1a1a1a', gradient: false, trimWidth: 0.08, chunkiness: 0.3,
        pattern: { mode: 'dots', secondaryColor: '#1a1a1a', freq: 14, angle: 0, scale: 0.35, spacing: 0 },
    };
}

/** Coerce a sleeve length onto the continuous 0..1 scale, migrating old enum saves
 *  ('none' | 'short' | 'long'). 0 = none · ~0.2 cap · ~0.55 elbow · ~0.8 ¾ · 1 = full wrist. */
export function normSleeveLength(v: number | string | undefined | null): number {
    if (typeof v === 'number') return Math.max(0, Math.min(1, v));
    if (v === 'long')  return 1;
    if (v === 'short') return 0.5;
    if (v === 'none')  return 0;
    return 0.5;
}

// ── Presets ──
const TOP_PRESETS: Record<string, () => TopParams> = {
    'Tee':         () => defaultTopParams(),
    'Crop':        () => ({ ...defaultTopParams(), hemHeight: 0.72, sleeveLength: 0, baseColor: '#ff8fb0' }),
    'Tank':        () => ({ ...defaultTopParams(), necklineHeight: 0.35, sleeveLength: 0, shoulderCoverage: 0.4, hemHeight: 0.1 }),
    'Long Sleeve': () => ({ ...defaultTopParams(), sleeveLength: 1, necklineHeight: 0.88, baseColor: '#9a6ad0' }),
};
const BOTTOM_PRESETS: Record<string, () => BottomParams> = {
    'Skirt':      () => defaultBottomParams(),
    'Mini Skirt': () => ({ ...defaultBottomParams(), length: 0.3, flare: 1.9 }),
    'Shorts':     () => ({ ...defaultBottomParams(), bottomStyle: 'shorts', length: 0.5 }),
    'Pants':      () => ({ ...defaultBottomParams(), bottomStyle: 'pants', length: 1.0 }),
    'Baggy Jeans':() => ({ ...defaultBottomParams(), bottomStyle: 'pants', length: 1.05, stack: 0.7, waistWidth: 1.1, baseColor: '#4a5a78' }),
    'Wide Leg':   () => ({ ...defaultBottomParams(), bottomStyle: 'pants', length: 1.1, legWidth: 2.4, stack: 1.2, waistWidth: 1.0, waistHeight: -0.18, baseColor: '#586b54' }),
    'Skinny':     () => ({ ...defaultBottomParams(), bottomStyle: 'pants', length: 1.0, cuffTaper: 0.8, waistWidth: 0.7, baseColor: '#2a2a33' }),
};
const SHOE_PRESETS: Record<string, () => ShoeParams> = {
    'Sneaker':  () => defaultShoeParams(),
    'Flat':     () => ({ ...defaultShoeParams(), shoeStyle: 'flat',  soleThickness: 0.008, topCover: 0.78, ankleCollar: 0.1, baseColor: '#7a4a3a' }),
    'Sandal':   () => ({ ...defaultShoeParams(), shoeStyle: 'sandal', soleThickness: 0.012, topCover: 0.2, ankleCollar: 0.05, baseColor: '#6a4636' }),
    'High Top': () => ({ ...defaultShoeParams(), shoeStyle: 'sneaker', topCover: 0.9, shaftHeight: 0.34, ankleCollar: 0.15, baseColor: '#2a2a30' }),
    'Boot':     () => ({ ...defaultShoeParams(), shoeStyle: 'boot',  topCover: 0.9, shaftHeight: 0.7, soleThickness: 0.02, ankleCollar: 0.15, baseColor: '#2a2a30' }),
    'Heel':     () => ({ ...defaultShoeParams(), shoeStyle: 'heel',  soleThickness: 0.006, heelHeight: 0.6, topCover: 0.7, toePoint: 0.6, ankleCollar: 0.1, baseColor: '#202024' }),
};
const SOCK_PRESETS: Record<string, () => SockParams> = {
    'Crew':       () => defaultSockParams(),
    'Ankle':      () => ({ ...defaultSockParams(), sockStyle: 'ankle', legHeight: 0.09 }),
    'Knee High':  () => ({ ...defaultSockParams(), sockStyle: 'knee',  legHeight: 0.62, baseColor: '#ffffff', trimColor: '#202024', trimWidth: 0.06 }),
    'Thigh High': () => ({ ...defaultSockParams(), sockStyle: 'thigh', legHeight: 1.02, baseColor: '#2a2a30', trimColor: '#d8cebc', trimWidth: 0.05 }),
    'Tube Sock':  () => ({ ...defaultSockParams(), sockStyle: 'crew',  legHeight: 0.4, baseColor: '#ffffff', trimColor: '#d83a5a', trimWidth: 0.16 }),
};
export function clothingPresetNames(slot: ClothingParams['slot']): string[] {
    if (slot === 'undershirt' || slot === 'underpants') return [];   // no curated presets yet (params-driven)
    return Object.keys(slot === 'top' ? TOP_PRESETS : slot === 'bottom' ? BOTTOM_PRESETS : slot === 'shoes' ? SHOE_PRESETS : SOCK_PRESETS);
}
export function clothingPreset(slot: ClothingParams['slot'], name: string): ClothingParams {
    if (slot === 'undershirt') return defaultUndershirtParams();
    if (slot === 'underpants') return defaultUnderpantsParams();
    const m = slot === 'top' ? TOP_PRESETS : slot === 'bottom' ? BOTTOM_PRESETS : slot === 'shoes' ? SHOE_PRESETS : SOCK_PRESETS;
    const def = slot === 'top' ? defaultTopParams : slot === 'bottom' ? defaultBottomParams : slot === 'shoes' ? defaultShoeParams : defaultSockParams;
    return (m[name] ?? def)();
}

// ── Pattern presets (reusable on ANY garment's `pattern` field) ───────────────
// `secondaryColor` = the pattern colour (over the garment's baseColor); tuned to read on a light base, recolour freely.
const PATTERN_PRESETS: Record<string, () => ClothingPattern> = {
    'None':         () => ({ mode: 'none',     secondaryColor: '#1a1a1a', freq: 8,  angle: 0,     scale: 0.5,  spacing: 0 }),
    'Pinstripe':    () => ({ mode: 'stripes',  secondaryColor: '#23233a', freq: 44, angle: 0,     scale: 0.12, spacing: 0 }),
    'Stripes':      () => ({ mode: 'stripes',  secondaryColor: '#1a1a1a', freq: 12, angle: 0,     scale: 0.5,  spacing: 0 }),
    'Diagonal':     () => ({ mode: 'stripes',  secondaryColor: '#1a1a1a', freq: 14, angle: 0.785, scale: 0.5,  spacing: 0 }),
    'Polka Dots':   () => ({ mode: 'dots',     secondaryColor: '#1a1a1a', freq: 14, angle: 0,     scale: 0.35, spacing: 0 }),
    'Micro Dots':   () => ({ mode: 'dots',     secondaryColor: '#5a5a5a', freq: 32, angle: 0,     scale: 0.3,  spacing: 0 }),
    'Argyle':       () => ({ mode: 'diamonds', secondaryColor: '#9c4a4a', freq: 7,  angle: 0.785, scale: 0.55, spacing: 0 }),
    'Harlequin':    () => ({ mode: 'diamonds', secondaryColor: '#1a1a1a', freq: 5,  angle: 0,     scale: 0.62, spacing: 0 }),
    'Checkerboard': () => ({ mode: 'checker',  secondaryColor: '#1a1a1a', freq: 10, angle: 0,     scale: 0.5,  spacing: 0 }),
    'Gingham':      () => ({ mode: 'checker',  secondaryColor: '#7088c0', freq: 18, angle: 0,     scale: 0.5,  spacing: 0 }),
    'Grid':         () => ({ mode: 'grid',     secondaryColor: '#888888', freq: 12, angle: 0,     scale: 0.14, spacing: 0 }),
    'Graph':        () => ({ mode: 'grid',     secondaryColor: '#6a8ab0', freq: 28, angle: 0,     scale: 0.08, spacing: 0 }),
};
export function patternPresetNames(): string[] { return Object.keys(PATTERN_PRESETS); }
export function patternPreset(name: string): ClothingPattern { return (PATTERN_PRESETS[name] ?? PATTERN_PRESETS['None'])(); }

// ── vec helpers ──
const sub = (a: V3, b: V3): V3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const add = (a: V3, b: V3): V3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const scl = (a: V3, s: number): V3 => [a[0]*s, a[1]*s, a[2]*s];
const cross = (a: V3, b: V3): V3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a: V3, b: V3): number => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const h11 = (x: number): number => { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };   // seeded 0..1 hash (per-ring jitter)
const perpFrame = (axis: V3): { u: V3; v: V3 } => {
    const a = norm(axis);
    const up: V3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(up, a));
    return { u, v: cross(a, u) };
};

// Each garment PIECE (torso, each sleeve, each leg) gets its own non-overlapping UV island (a u-COLUMN,
// full v) so a brush stroke on one piece can't bleed onto another. Keeping v = [0,1] means the trim band
// (texture v-ends) still lands on every piece's openings. pushVert maps a piece's local (u,v) into it.
type Island = [number, number, number, number];   // [u0, v0, u1, v1] in atlas space
const GARMENT_IS: Record<string, Island> = {
    torso:   [0.00, 0, 0.50, 1],
    sleeveL: [0.50, 0, 0.75, 1],
    sleeveR: [0.75, 0, 1.00, 1],
    legL:    [0.00, 0, 0.50, 1],
    legR:    [0.50, 0, 1.00, 1],
    skirt:   [0.00, 0, 1.00, 1],
};

interface Accum {
    pos: number[]; nrm: number[]; uv: number[]; j0: number[]; w0: number[]; j1: number[]; w1: number[]; idx: number[]; count: number; island: Island;
    // Vertices whose analytic skin weights the body-fit pass must NOT overwrite (it would re-weight them to
    // the nearest body vert). Used for the crotch-fill rings: each pant leg's crotch fabric stays weighted to
    // ITS OWN leg, so a kick/splits SEPARATES the two legs instead of leaving a hips-weighted sheet (a "dress").
    noXfer: Set<number>;
}
function pushVert(ac: Accum, p: V3, n: V3, u: number, v: number, ja: number, wa: number, jb: number, wb: number): number {
    const I = ac.island;
    ac.pos.push(p[0], p[1], p[2]); ac.nrm.push(n[0], n[1], n[2]);
    ac.uv.push(I[0] + u * (I[2] - I[0]), I[1] + v * (I[3] - I[1]));   // local (0..1) → this piece's island sub-rect
    ac.j0.push(ja); ac.w0.push(wa); ac.j1.push(jb); ac.w1.push(wb);
    return ac.count++;
}
export const RING = 24;   // garment ring resolution — MATCHES the body's 24-gon (was 12). When the garment
                          // ring count == the body's, garment verts line up angularly with body verts, so the
                          // body can't poke through a garment FACE (the cause of clipping on the 24-gon body);
                          // it also samples the body radii (GARMENT_RING = this) per-sector at full resolution,
                          // so the yoke hugs the projecting butt + fuller thighs instead of a coarse average.
// Minimum air gap between a garment and the skin (world units). The Looseness/thickness offset is
// clamped to at least this, so NO slider value can pull a garment tight enough to clip into the body.
// Tight: on a thin doll arm (~0.03 radius) even a few mm reads as a floating sleeve, so keep this small —
// the de-collision pass still guarantees no clip (it pushes any inside vertex back out to this gap).
const MIN_GAP = 0.003;
const BASE_GAP = 0.0012;   // base layers (undershirt/underpants) HUG — just off the skin (no z-fight) yet always INSIDE the outer top/bottom
// Raised folded cuffs at the openings (hem / sleeve end / leg end) — DISABLED for now (the trim COLOUR
// band stays; only the extra geometry is off). Flip to true to bring the folded cuffs back.
const ENABLE_CUFFS = false;
/** Ring of RING verts in the (u,v) plane, weighted (ja,wa)/(jb,wb). */
function addRing(ac: Accum, c: V3, u: V3, v: V3, r: number, uvV: number, ja: number, wa: number, jb: number, wb: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < RING; k++) {
        const ang = (k / RING) * Math.PI * 2;
        const dir = add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
        out.push(pushVert(ac, add(c, scl(dir, r)), dir, k / RING, uvV, ja, wa, jb, wb));
    }
    return out;
}
/** Like addRing, but vertex k uses its own radius radii[k] (× inset) + thickness — so the ring hugs a
 *  non-circular body cross-section (covers the skin) instead of a single circle (which clips or balloons). */
function addRingDir(ac: Accum, c: V3, u: V3, v: V3, radii: number[], inset: number, thickness: number, uvV: number, ja: number, wa: number, jb: number, wb: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < RING; k++) {
        const ang = (k / RING) * Math.PI * 2;
        const dir = add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
        out.push(pushVert(ac, add(c, scl(dir, radii[k] * inset + thickness)), dir, k / RING, uvV, ja, wa, jb, wb));
    }
    return out;
}
/** A raised cuff/hem at a garment OPENING: steps the edge loop OUT (radially) then extends a short rim
 *  along `out`, reading as a folded/rolled cuff (not just a colour stripe). Each new vertex inherits the
 *  edge vertex's skin weights + u, and gets uv.v = `vEdge` (the trim band) so it takes the trim colour.
 *  Returns the new (raised) open ring — cap it for a closed end (pant leg) or leave it open (sleeve/hem). */
function addCuff(ac: Accum, edge: number[], out: V3, vEdge: number, cuffLen: number, raise: number): number[] {
    let cx = 0, cy = 0, cz = 0;
    for (const vi of edge) { cx += ac.pos[vi*3]; cy += ac.pos[vi*3+1]; cz += ac.pos[vi*3+2]; }
    const n = edge.length; cx /= n; cy /= n; cz /= n;
    const I = ac.island, du = (I[2] - I[0]) || 1;   // pushVert re-maps u into the island, so un-map the edge's u first
    const step: number[] = [], lip: number[] = [];
    for (const vi of edge) {
        const px = ac.pos[vi*3], py = ac.pos[vi*3+1], pz = ac.pos[vi*3+2];
        let dx = px - cx, dy = py - cy, dz = pz - cz;
        const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;        // radial dir from the ring centre
        const ja = ac.j0[vi], wa = ac.w0[vi], jb = ac.j1[vi], wb = ac.w1[vi];    // inherit the edge ring's weights
        const uu = (ac.uv[vi*2] - I[0]) / du, nrm: V3 = [dx, dy, dz];            // edge's mapped u → local u
        const sx = px + dx*raise, sy = py + dy*raise, sz = pz + dz*raise;        // step OUT radially (the fold's rise)
        step.push(pushVert(ac, [sx, sy, sz], nrm, uu, vEdge, ja, wa, jb, wb));
        lip.push(pushVert(ac, [sx + out[0]*cuffLen, sy + out[1]*cuffLen, sz + out[2]*cuffLen], nrm, uu, vEdge, ja, wa, jb, wb));
    }
    bandRings(ac, edge, step);   // annular step face (fabric edge → raised cuff)
    bandRings(ac, step, lip);    // the cuff rim
    return lip;
}
function bandRings(ac: Accum, a: number[], b: number[]): void {
    for (let k = 0; k < a.length; k++) {
        const k2 = (k + 1) % a.length;
        ac.idx.push(a[k], a[k2], b[k2]);
        ac.idx.push(a[k], b[k2], b[k]);
    }
}
function capRing(ac: Accum, loop: number[], apex: V3, ja: number): void {
    let c: V3 = [0, 0, 0];
    for (const vi of loop) c = [c[0]+ac.pos[vi*3], c[1]+ac.pos[vi*3+1], c[2]+ac.pos[vi*3+2]];
    c = scl(c, 1/loop.length);
    const ai = pushVert(ac, apex, norm(sub(apex, c)), 0.5, 1, ja, 1, 0, 0);
    for (let k = 0; k < loop.length; k++) ac.idx.push(loop[k], loop[(k+1)%loop.length], ai);
}

// ── Torso shell: vertical rings from the hem up to the neckline, weighted hips↔spine↔chest↔neck ──
interface Col { y: number; x: number; z: number; r: number; radii: number[]; idx: number; }
/** Interpolate the torso column at height y → centre, per-sector radii, and the two bracketing joints. */
function sampleCol(cols: Col[], y: number): { c: V3; radii: number[]; ja: number; wa: number; jb: number; wb: number } {
    if (y <= cols[0].y) { const a = cols[0]; return { c: [a.x, y, a.z], radii: a.radii, ja: a.idx, wa: 1, jb: a.idx, wb: 0 }; }
    const top = cols[cols.length - 1];
    if (y >= top.y) return { c: [top.x, y, top.z], radii: top.radii, ja: top.idx, wa: 1, jb: top.idx, wb: 0 };
    let i = 0; while (i < cols.length - 1 && cols[i + 1].y < y) i++;
    const a = cols[i], b = cols[i + 1];
    const f = (y - a.y) / Math.max(1e-5, b.y - a.y);
    const radii = a.radii.map((ra, k) => ra + (b.radii[k] - ra) * f);
    return { c: [a.x + (b.x-a.x)*f, y, a.z + (b.z-a.z)*f], radii, ja: a.idx, wa: 1-f, jb: b.idx, wb: f };
}

function buildTorso(ac: Accum, fit: BodyFit, p: TopParams, rings: number): void {
    const hips = fit.joints['hips'], spine = fit.joints['spine'], chest = fit.joints['chest'], neck = fit.joints['neck'];
    if (!hips || !chest || !neck) return;
    ac.island = GARMENT_IS.torso;
    const cols: Col[] = [hips, spine ?? hips, chest, neck]
        .map(j => ({ y: j!.pos[1], x: j!.pos[0], z: j!.pos[2], r: j!.radius, radii: j!.radii, idx: j!.idx }))
        .sort((a, b) => a.y - b.y);
    const u: V3 = [1, 0, 0], v: V3 = [0, 0, 1];
    // hemHeight: 1 = crop (chest) · 0 = at the hips · NEGATIVE = LONGER (below the hips). A one-piece top
    // can hang down to ~the crotch/upper-thigh (−0.45) before the legs split; clamped so it can't run past
    // that into the legs. The torso samples the hip cross-section below the waist, so it hangs straight (tunic).
    const hh = Math.max(-0.45, Math.min(1, p.hemHeight));
    const hemY  = hips.pos[1] + (chest.pos[1] - hips.pos[1]) * hh;                 // <0 hips … 1 chest
    const neckY = chest.pos[1] + (neck.pos[1] - chest.pos[1]) * p.necklineHeight;   // 0 chest → 1 neck
    // The torso is FITTED: it uses only a fraction of Looseness (floored at MIN_GAP) so the body part of
    // the shirt hugs the mesh, while the sleeves get the full Looseness. Can never pull tight enough to clip.
    const bodyGap = Math.max(p.thickness * 0.55, MIN_GAP);
    const ringList: number[][] = [];
    for (let i = 0; i <= rings; i++) {
        const t = i / rings;
        const y = hemY + (neckY - hemY) * t;
        const s = sampleCol(cols, y);
        // Inset the upper rings for low shoulder coverage (tank feel).
        const inset = 1 - (1 - p.shoulderCoverage) * 0.25 * t;
        // Per-sector radii (each ≥ the body's extent in that direction) → the ring hugs the body and
        // never lets skin poke through, without ballooning on the narrow axis.
        ringList.push(addRingDir(ac, s.c, u, v, s.radii, inset, bodyGap, t, s.ja, s.wa, s.jb, s.wb));
    }
    for (let i = 0; i < rings; i++) bandRings(ac, ringList[i], ringList[i + 1]);

    // Neckline shape on the top ring. front (+Z) = vertex RING/4. A 'v' dips the front-centre into a V;
    // round/crew/collar stay a clean circular collar (use necklineHeight for a scoop).
    const top = ringList[rings];
    if (p.neckline === 'v') ac.pos[top[Math.round(RING / 4)]*3 + 1] -= (neckY - hemY) * 0.5;
    // Raised hem cuff (folds down + out) so the trim reads as a folded band, not just a colour stripe.
    if (ENABLE_CUFFS && p.trimWidth > 0.001) addCuff(ac, ringList[0], [0, -1, 0], 0, 0.018, 0.010);
}

/** Sample the captured torso surface at world-height `y` → an interpolated ring (vert k ↔ vert k between the two
 *  bracketing captured rings). Clamps at the pelvis (bottom) / neck (top) ends. */
function torsoSurfaceAt(rings: ArmRing[], y: number): ArmRing['verts'] {
    if (y <= rings[0].center[1]) return rings[0].verts;
    const top = rings[rings.length - 1];
    if (y >= top.center[1]) return top.verts;
    let i = 0; while (i < rings.length - 1 && rings[i + 1].center[1] < y) i++;
    const a = rings[i].verts, b = rings[i + 1].verts;
    const f = (y - rings[i].center[1]) / Math.max(1e-5, rings[i + 1].center[1] - rings[i].center[1]);
    const m = Math.min(a.length, b.length), out: ArmRing['verts'] = [];
    for (let k = 0; k < m; k++) {
        const va = a[k], vb = b[k], use = f < 0.5 ? va : vb;
        out.push({
            p: [va.p[0] + (vb.p[0] - va.p[0]) * f, va.p[1] + (vb.p[1] - va.p[1]) * f, va.p[2] + (vb.p[2] - va.p[2]) * f] as V3,
            n: norm([va.n[0] + (vb.n[0] - va.n[0]) * f, va.n[1] + (vb.n[1] - va.n[1]) * f, va.n[2] + (vb.n[2] - va.n[2]) * f] as V3),
            j0: use.j0, w0: use.w0, j1: use.j1, w1: use.w1,
        });
    }
    return out;
}

/** Torso surface EXTENTS at a height: the front-most z and the side-most x on each side. For routing straps/bands
 *  ON the actual body surface (so they hug the chest + wrap the ribs instead of cutting through). */
export function torsoExtentAt(rings: ArmRing[] | undefined, y: number): { frontZ: number; sideXpos: number; sideXneg: number } | null {
    if (!rings || rings.length < 2) return null;
    const ring = torsoSurfaceAt(rings, y);
    let frontZ = -Infinity, maxX = -Infinity, minX = Infinity;
    for (const vtx of ring) { const p = vtx.p; if (p[2] > frontZ) frontZ = p[2]; if (p[0] > maxX) maxX = p[0]; if (p[0] < minX) minX = p[0]; }
    return { frontZ, sideXpos: maxX, sideXneg: minX };
}

/** UNDERSHIRT torso shell = the body's OWN torso rings offset OUTWARD by `off` → genuinely skin-tight + clip-free
 *  (the sleeve/sock trick, now for the torso). Samples the captured surface from the hem up to the neckline; the
 *  captured rings stop at the pelvis/crotch, so a torso layer PHYSICALLY can't reach the split legs (no more web).
 *  A 'v' neckline dips the collar's front-centre. */
function buildTorsoOffset(ac: Accum, rings: ArmRing[], hemY: number, neckY: number, off: number, p: TopParams): void {
    ac.island = GARMENT_IS.torso;
    const NSEG = 12;
    const pushOffsetRing = (verts: ArmRing['verts'], uvV: number): number[] => {
        const m = verts.length, out: number[] = [];
        for (let k = 0; k < m; k++) {
            const vv = verts[k];
            out.push(pushVert(ac, [vv.p[0] + vv.n[0] * off, vv.p[1] + vv.n[1] * off, vv.p[2] + vv.n[2] * off] as V3, vv.n, k / m, uvV, vv.j0, vv.w0, vv.j1, vv.w1));
        }
        return out;
    };
    const built: number[][] = [];
    for (let i = 0; i <= NSEG; i++) {
        const t = i / NSEG;
        built.push(pushOffsetRing(torsoSurfaceAt(rings, hemY + (neckY - hemY) * t), t));
    }
    if (p.neckline === 'v') {                                  // dip the front-centre of the collar (body ring vert m/4 = +Z front)
        const top = built[NSEG], m = top.length;
        ac.pos[top[Math.round(m / 4)] * 3 + 1] -= (neckY - hemY) * 0.5;
    }
    for (let i = 0; i < NSEG; i++) bandRings(ac, built[i], built[i + 1]);
}

// Slant the armhole ring (rings[0]) into a real sleeve-cap SEAM: its TOP sweeps IN toward the torso (−armAxis)
// scaled by how far UP each vert sits, while the armpit stays out — so the sleeve covers the long span of the
// shoulder-top instead of a flat perpendicular circle (which reads as a tank-top strap). `inset`: 0 = flat
// armhole (bare-shoulder / strappy GAP — some looks want this) · 1 = full shoulder · >1 climbs toward the neck.
// Returns a NEW array (ring 0 = slanted vert COPIES) so the shared body armSurface is never mutated across regens.
function slantArmhole(rings: ArmRing[], inset: number): ArmRing[] {
    if (rings.length < 2 || Math.abs(inset) < 1e-4) return rings;
    const c = rings[0].center;
    const axis = norm(sub(rings[1].center, c));   // armhole → deltoid = the arm axis (points out, down the arm)
    let socketR = 0;
    for (const v of rings[0].verts) socketR += len(sub(v.p, c));
    socketR /= rings[0].verts.length || 1;
    const verts = rings[0].verts.map(v => {
        const up = Math.max(0, (v.p[1] - c[1]) / (socketR || 1));   // 0 at armpit/sides → 1 at the shoulder-top
        const s = inset * up * socketR;
        return { ...v, p: [v.p[0] - axis[0]*s, v.p[1] - axis[1]*s, v.p[2] - axis[2]*s] as V3 };
    });
    return [{ center: c, verts }, ...rings.slice(1)];
}

// ── Sleeve via OFFSET SURFACE — the sleeve IS the body's real arm, pushed outward ──
// rings = the body's actual arm rings [collar(=armhole/socket shape) → deltoid → upper → elbow → wrist],
// index-corresponding (band k→k). Each vertex is offset along its outward normal by the air gap; the chain
// is cut at length L (0..1 along the arm) with an interpolated end ring at exactly L (so the cuff trim
// lands on the real hem); UV runs by reach. Because the rings ARE the shoulder/armpit, the sleeve FOLLOWS
// them — no tube approximation, no straight bridge across the armpit. generateTop's shrink-wrap cleans up.
function buildSleeveOffset(ac: Accum, rings: ArmRing[], p: TopParams, L: number): void {
    rings = slantArmhole(rings, p.sleeveInset ?? 1);   // shoulder-seam slant (per-garment; old saves → full coverage)
    const off = Math.max(MIN_GAP, p.thickness * 0.25 + Math.max(0, p.sleeveWidth) * 0.5);
    const flare = Math.max(0, p.sleeveCap);
    const reach: number[] = [0];
    for (let i = 1; i < rings.length; i++) reach[i] = reach[i-1] + len(sub(rings[i].center, rings[i-1].center));
    const total = reach[reach.length - 1] || 1;
    for (let i = 0; i < reach.length; i++) reach[i] /= total;
    const offAt = (rc: number): number => off + flare * 0.02 * (1 - Math.min(1, rc));   // a touch of cap puff near the shoulder
    const pushOffsetRing = (verts: ArmRing['verts'], uvV: number, rc: number): number[] => {
        const m = verts.length, o = offAt(rc), out: number[] = [];
        for (let k = 0; k < m; k++) {
            const vv = verts[k];
            out.push(pushVert(ac, [vv.p[0]+vv.n[0]*o, vv.p[1]+vv.n[1]*o, vv.p[2]+vv.n[2]*o] as V3, vv.n, k/m, uvV, vv.j0, vv.w0, vv.j1, vv.w1));
        }
        return out;
    };
    const built: number[][] = [];
    let lastI = 0;
    for (let i = 0; i < rings.length; i++) {
        if (reach[i] <= L + 1e-3) { built.push(pushOffsetRing(rings[i].verts, Math.min(1, reach[i] / Math.max(1e-4, L)), reach[i])); lastI = i; }
        else {
            // interpolate the bracketing body rings at exactly reach L (vert k ↔ vert k), then stop.
            const a = rings[lastI].verts, b = rings[i].verts, f = (L - reach[lastI]) / Math.max(1e-4, reach[i] - reach[lastI]);
            const m = Math.min(a.length, b.length), end: ArmRing['verts'] = [];
            for (let k = 0; k < m; k++) {
                const va = a[k], vb = b[k], use = f < 0.5 ? va : vb;
                end.push({
                    p: [va.p[0]+(vb.p[0]-va.p[0])*f, va.p[1]+(vb.p[1]-va.p[1])*f, va.p[2]+(vb.p[2]-va.p[2])*f] as V3,
                    n: norm([va.n[0]+(vb.n[0]-va.n[0])*f, va.n[1]+(vb.n[1]-va.n[1])*f, va.n[2]+(vb.n[2]-va.n[2])*f] as V3),
                    j0: use.j0, w0: use.w0, j1: use.j1, w1: use.w1,
                });
            }
            built.push(pushOffsetRing(end, 1, L));
            break;
        }
    }
    for (let i = 0; i < built.length - 1; i++) bandRings(ac, built[i], built[i + 1]);
}

// ── Sleeves: dispatch to the offset-surface builder (preferred) per arm, else the analytic-tube fallback.
// The cap is sized to the actual DELTOID (not the elbow), held across the bulge, then tapered to the
// elbow/wrist. One frame for the whole near-straight arm so rings stay aligned (no twist at the elbow). ──
function buildSleeves(ac: Accum, fit: BodyFit, p: TopParams): void {
    const L = normSleeveLength(p.sleeveLength);   // 0 none → 1 wrist (continuous)
    if (L <= 0.001) return;
    const w = p.sleeveWidth, OCT = 1 / Math.cos(Math.PI / RING);
    // Sleeve air offset: a FITTED base — Looseness counts only ×0.4 (Width is the sleeve's own looseness
    // knob, ×0.5) so default sleeves hug the arm instead of ballooning; floored at MIN_GAP so a low /
    // negative Width can't clip. (Was full thickness + full Width = way too loose on a thin arm.)
    const off = Math.max(MIN_GAP, p.thickness * 0.25 + Math.max(0, w) * 0.5);
    const capFlare = 1 + Math.max(0, p.sleeveCap) * 0.3;   // Cap flare 0..1 → 1.0× (fitted) .. 1.3× (puffed) — gentle
    const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
    for (const s of ['L', 'R'] as const) {
        const sh = fit.joints['shoulder_' + s], lo = fit.joints['lowerarm_' + s], ha = fit.joints['hand_' + s];
        if (!sh || !lo) continue;
        ac.island = s === 'L' ? GARMENT_IS.sleeveL : GARMENT_IS.sleeveR;
        // OFFSET-SURFACE path (preferred): the sleeve IS the body's real arm rings (collar=armhole →
        // deltoid → … → wrist) pushed outward, so it genuinely follows the shoulder/armpit. Falls back to
        // the analytic tube below only if the body didn't hand over its arm surface.
        const surf = fit.armSurface?.[s];
        if (surf && surf.length >= 2) { buildSleeveOffset(ac, surf, p, L); continue; }
        // Body radii sampled from arm-dominant verts (clean; no torso contamination). The CAP covers the
        // deltoid — the part the old elbow-based sizing clipped. Enclose (near-max × octagon) + offset.
        const af = fit.arms?.[s];
        // Clamp the deltoid sample to ~1.3× the forearm: the shoulder-dominant verts include the WIDE
        // socket/collar near the torso, which over-samples the deltoid and balloons the cap into a puff.
        const elbowBase = af ? af.elbowR : lo.radius;
        const capBase   = Math.min(af ? af.capR : lo.radius * 1.25, elbowBase * 1.3);
        const capR   = capBase * OCT * capFlare + off;
        const elbowR = elbowBase * OCT + off;
        const wristR = (af ? af.wristR : (ha ? ha.radius : lo.radius * 0.7)) * OCT + off;
        // Single frame for the whole arm (shoulder→wrist) → consistent ring orientation, no twist.
        const { u, v } = perpFrame(sub((ha ?? lo).pos, sh.pos));
        const upper = sub(lo.pos, sh.pos);
        const ring = (c: V3, r: number, uvV: number, ja: number, wa: number, jb: number, wb: number): number[] =>
            addRing(ac, c, u, v, r, uvV, ja, wa, jb, wb);
        const rings: number[][] = [];
        const armDir = norm(sub((ha ?? lo).pos, sh.pos));   // outward along the arm
        // The body's arm SOCKET is not a flat disc at shoulder height: its underside sits at CHEST level —
        // well below the arm centreline — and curves UP to the arm, while its top rides over the shoulder.
        // So the sleeve cap must DIP at the underarm into that armpit pocket and curve up; a flat
        // perpendicular ring reads as a straight tube floating off the torso (the bug being fixed).
        // downInPlane = the cap's "down"/underarm direction; `armpit` = a point in that pocket the underarm
        // verts pull toward. The de-collision pass then conforms the result to the real skin.
        const DOWN: V3 = [0, -1, 0];
        const dW = sub(DOWN, scl(armDir, dot(DOWN, armDir)));   // world-down with the arm-axis part removed
        const downInPlane = len(dW) > 1e-4 ? norm(dW) : v;
        const ch = fit.joints['chest'];
        const armpit: V3 = ch
            ? [ sh.pos[0] + (ch.pos[0] - sh.pos[0]) * 0.45,    // inboard, toward the chest side
                ch.pos[1] + (sh.pos[1] - ch.pos[1]) * 0.32,    // ≈ chest level (the scooped socket bottom)
                sh.pos[2] ]
            : add(sh.pos, scl(downInPlane, capR * 1.2));
        // Like `ring`, but the lower (underarm) verts lerp toward `armpit` by `dip` → a teardrop armhole
        // that hugs the socket. dip eases to 0 by the deltoid, so the underarm curves back up to the arm.
        const capRing = (c: V3, r: number, uvV: number, dip: number): number[] => {
            const out: number[] = [];
            for (let k = 0; k < RING; k++) {
                const ang = (k / RING) * Math.PI * 2;
                const dir = add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
                let px = c[0] + dir[0]*r, py = c[1] + dir[1]*r, pz = c[2] + dir[2]*r;
                const dn = Math.max(0, dot(dir, downInPlane));   // 1 = straight underarm, 0 = top/side
                if (dip > 0 && dn > 0) { const t = dn * dip; px += (armpit[0]-px)*t; py += (armpit[1]-py)*t; pz += (armpit[2]-pz)*t; }
                out.push(pushVert(ac, [px, py, pz], dir, k / RING, uvV, sh.idx, 1, lo.idx, 0));
            }
            return out;
        };
        // Continuous length L (0 none → 1 wrist). armAt maps a reach sr∈[0,1] (shoulder→wrist; elbow at
        // SPLIT) to centre/radius/weights — cap radius held, then tapering elbow→wrist. Lend = the effective
        // end (never below a cap); uvAt puts the cuff trim at v=1.
        const SPLIT = 0.55;
        const wristC = ha ? add(lo.pos, scl(sub(ha.pos, lo.pos), 0.85)) : add(lo.pos, scl(upper, 0.4));
        const lerpV = (a: V3, b: V3, f: number): V3 => add(a, scl(sub(b, a), f));
        const Lend = Math.max(L, 0.16);
        const uvAt = (sr: number): number => Math.min(1, Math.max(0, sr) / Lend);
        const armAt = (sr: number): { c: V3; r: number; ja: number; wa: number; jb: number; wb: number } => {
            if (sr <= SPLIT) {                                       // upper arm: shoulder → elbow
                const f = sr / SPLIT;
                const r = f < 0.5 ? capR : mix(capR, elbowR, (f - 0.5) / 0.5);   // hold the cap, then taper in
                const wb = Math.max(0, (f - 0.3) / 0.7);             // ease the elbow joint in (deltoid stays shoulder-weighted)
                return { c: lerpV(sh.pos, lo.pos, f), r, ja: sh.idx, wa: 1 - wb, jb: lo.idx, wb };
            }
            const f = (sr - SPLIT) / (1 - SPLIT);                    // forearm: elbow → wrist
            return { c: lerpV(lo.pos, wristC, f), r: mix(elbowR, wristR, f), ja: (ha ?? lo).idx, wa: f, jb: lo.idx, wb: 1 - f };
        };
        // CURVED CAP that FOLLOWS THE BODY (the "offset the mesh surface" fit): 4 rings from the inboard
        // socket out to the pre-deltoid, the underarm dipped toward the armpit (ramping 0.8→0.12 so it
        // curves up to the arm), THEN snapped onto the real body surface (snapToBody — BOTH directions: into
        // the concave armpit AND off convex parts). A push-only de-collision can't fill a concavity; the snap
        // can, so the start hugs the socket/armpit instead of bridging straight across. Socket ring tucks
        // UNDER the torso (its gap < the shirt body's) → the seam is hidden.
        const sleeveStart = ac.count;
        rings.push(capRing(sub(sh.pos, scl(armDir, 0.05)), capR * 1.10, 0,          0.80));   // socket (hidden under torso)
        rings.push(capRing(sub(sh.pos, scl(armDir, 0.02)), capR * 1.04, 0,          0.55));
        rings.push(capRing(sh.pos,                         capR,        0,          0.32));   // shoulder
        rings.push(capRing(add(sh.pos, scl(upper, 0.14)),  capR,        uvAt(0.08), 0.12));   // toward the deltoid
        // Arm rings from the deltoid out to the end.
        const stations: number[] = [];
        for (let sr = 0.22; sr < Lend - 0.04; sr += 0.20) stations.push(sr);
        stations.push(Lend);   // exact end
        for (const sr of stations) { const a = armAt(sr); rings.push(ring(a.c, a.r, uvAt(sr), a.ja, a.wa, a.jb, a.wb)); }
        // Snap the WHOLE sleeve onto the real body surface (+gap, both directions) — not just the hidden
        // cap — so the VISIBLE shoulder follows the deltoid bulge and the underside follows the armpit
        // hollow, instead of reading as a straight tube. (The arm is straight in rest pose, so the forearm
        // stays straight, which is correct; only the shoulder/armpit region actually has a curve to follow.)
        if (fit.body) snapToBody(ac, sleeveStart, ac.count, fit.body, off, 0.045, 0.05);
        for (let i = 0; i < rings.length - 1; i++) bandRings(ac, rings[i], rings[i + 1]);
        // Raised sleeve cuff at the open end (folds out along the arm).
        if (ENABLE_CUFFS && p.trimWidth > 0.001) addCuff(ac, rings[rings.length - 1], norm(sub((ha ?? lo).pos, sh.pos)), 1, 0.016, 0.010);
    }
}

/** The scalar joint radius is the ~90th-pctile distance over ALL weighted verts, so a projecting BUTT
 *  inflates the HIP radius → a waistband sized to it sticks out at the front/sides. This averages only the
 *  FRONT + SIDE sectors of the directional profile (drops the back/butt quarter), giving the true girth the
 *  band should hug; the butt is a back feature the garment rides over via the leg/skirt rings below. */
function hugRadius(j: JointFit | undefined): number {
    if (!j) return 0;
    const r = j.radii;
    if (!r || r.length < 4) return j.radius;
    const n = r.length, back = Math.round(n * 0.75);   // sector index nearest −Z (the butt)
    let sum = 0, cnt = 0;
    for (let k = 0; k < n; k++) {
        const d = Math.min((k - back + n) % n, (back - k + n) % n);   // sector steps from the back
        if (d > n / 4) { sum += r[k]; cnt++; }                        // keep front + sides (>90° from −Z)
    }
    return cnt ? sum / cnt : j.radius;
}

// ── Bottom: skirt (flared cone, hip-weighted) ──
function buildSkirt(ac: Accum, fit: BodyFit, p: BottomParams, rings: number): void {
    const hips = fit.joints['hips'], ll = fit.joints['lowerleg_L'];
    if (!hips) return;
    ac.island = GARMENT_IS.skirt;
    const legSpan = ll ? (hips.pos[1] - ll.pos[1]) : hips.radius * 4;
    const u: V3 = [1, 0, 0], v: V3 = [0, 0, 1];
    const waistY = hips.pos[1] + hips.radius * p.waistHeight;
    const botY   = waistY - legSpan * p.length;
    // Waist slider has REAL authority on skirts too (was a dead 0–2cm belt offset via waistbandR): scale the
    // waistband's body-sampled front/side girth 0.9×(cinched)..1.25×(loose), like the pants yoke. Flares below.
    const wt = Math.max(0, Math.min(1, (p.waistWidth - 0.6) / 0.8));
    const waistR = hugRadius(hips) * (0.9 + wt * 0.35) + MIN_GAP;
    const ringList: number[][] = [];
    for (let i = 0; i <= rings; i++) {
        const t = i / rings;
        const y = waistY + (botY - waistY) * t;
        const r = waistR * (1 + (p.flare - 1) * t);
        ringList.push(addRing(ac, [hips.pos[0], y, hips.pos[2]], u, v, r, t, hips.idx, 1, hips.idx, 0));
    }
    for (let i = 0; i < rings; i++) bandRings(ac, ringList[i], ringList[i + 1]);
}

// ── Bottom: shorts / pants — two leg tubes, WIDE at the top (cover the hips) → taper into the legs.
//    EVERY ring — including the hip yoke — uses the body's per-sector directional radii (like the
//    torso/sleeves), so the whole bottom HUGS the body's actual cross-section: tight at the front, around
//    the butt at the back, never a boxy/ballooned circle. ──
function buildLegs(ac: Accum, fit: BodyFit, p: BottomParams, rings: number, shoe: ShoeParams | null = null): void {
    const hips = fit.joints['hips'];
    if (!hips) return;
    const u: V3 = [1, 0, 0], v: V3 = [0, 0, 1];   // world-XZ ring frame → aligns with the directional radii sectors
    const legGap = Math.max(p.thickness, MIN_GAP); // air offset, floored so legs can't pull tight enough to clip
    const waistY = hips.pos[1] + hips.radius * p.waistHeight;
    // Waist fit: the "Waist" slider SCALES the waistband's body-sampled radii. WIDE range so it has real visible
    // authority (the old 0.85–1.2 was so narrow + so pinned by the de-collision that the bottom ⅔ did nothing):
    // 0.6 → 0.6× (CINCH — pulled to the true body; the de-collision floors it there so it can't clip) · 1.0 → 1.0×
    // (natural) · 1.4 → 1.4× (BAGGY flare). The default reads SLIM (0.7 → 0.7×) — the band was flaring because it
    // was sized to `hips.radii`, the WIDEST hip slice (the feminine silhouette's wide hips), at a height where the
    // body is narrower. NOTE: you can't cinch TIGHTER than the character's actual hips (the fabric won't clip into
    // the body) — to slim further, reduce the body's hip width or raise the Rise so the band sits at the waist.
    const wt = Math.max(0, Math.min(1, (p.waistWidth - 0.6) / 0.8));
    const waistScale = 0.6 + wt * 0.8;
    const scaleAt = (i: number): number => i === 0 ? waistScale : i === 1 ? (waistScale + 1) * 0.5 : 1;
    // Yoke cross-section sampled at the ACTUAL waistband height. At Rise 0 it's the hip section; raising Rise
    // lifts the band toward the narrower WAIST, so blend hips→spine radii (and skin weights) by waistY — else the
    // band stays hip-WIDE up high and floats off the waist (the gap the user saw at high Rise; the de-collision
    // can't close it, it only pushes OUT). Falls back to the hip section when there's no spine joint.
    const spine = fit.joints['spine'], sr = spine?.radii;
    const yokeF = (sr && spine && spine.pos[1] > hips.pos[1])
        ? Math.max(0, Math.min(1, (waistY - hips.pos[1]) / (spine.pos[1] - hips.pos[1]))) : 0;
    const yokeRadii = (yokeF > 0 && sr) ? hips.radii.map((r, k) => r + (sr[k] - r) * yokeF) : hips.radii;
    const N = Math.max(16, rings * 3);  // DENSER legs (was 8–16, orig 4–8) → more rings make the vertex-only
                                        // de-collision effectively face-aware + shorten each band face, closing
                                        // the rare spots where the body pokes through between rings; finer
                                        // wrinkles too. Generation-time only (~a few ms/regen) so cheap.
    // Keep the leg TOPS pulled toward centre over the top ~half (by t, not raw ring, since N is denser now):
    // the two legs OVERLAP past the inseam so the crotch is filled with fabric and the body can't poke through.
    const pullAt = (t: number): number => Math.min(1, 0.18 + t * 1.64);   // 0.18 at the waist → 1 by mid-thigh
    for (const s of ['L', 'R'] as const) {
        const ul = fit.joints['upperleg_' + s], lo = fit.joints['lowerleg_' + s], ft = fit.joints['foot_' + s];
        if (!ul || !lo) continue;
        ac.island = s === 'L' ? GARMENT_IS.legL : GARMENT_IS.legR;
        const ankleY = ft ? ft.pos[1] : lo.pos[1] - hips.radius * 2;
        // SHOE-FLOOR coupling (§6b): with a shoe equipped, the cuff RESTS on the shoe's top — it never descends
        // INTO/below the shoe. `restY` = the shoe-top rest height; `footH` = the foot/shoe vertical scale.
        const fb = (shoe && ft) ? footBox(fit.body, ft.idx) : null;
        const footH = fb ? Math.max(0.001, fb.maxY - fb.minY) : hips.radius * 0.3;
        const restY = fb ? (fb.minY + footH * 0.35) : ankleY;
        const stackAmt = Math.max(0, Math.min(3, p.stack ?? 0));
        const naturalEndY = waistY - (waistY - ankleY) * Math.max(0.08, Math.min(1.15, p.length));   // length 0..1+ = ankle
        // The hem is set by LENGTH only (clamped to rest ON the shoe, never below it). STACK does NOT change the
        // length — it gathers FOLDS above the hem, so the cloth bunches/stacks instead of getting longer.
        const endY = fb ? Math.max(naturalEndY, restY) : naturalEndY;
        const ringList: number[][] = [];
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            let y = waistY + (endY - waistY) * t;
            // STACK gather (§6): in the cuff zone the cloth BUNCHES into folds — rings undulate UP from the hem
            // (never below it, so the LENGTH stays put), reading as gathered/stacked fabric instead of getting
            // longer. Pairs with the radius accordion below (the fold ridges). Pants only.
            if (stackAmt > 0 && p.bottomStyle === 'pants') {
                const cz = Math.max(0, (t - 0.55) / 0.45);
                if (cz > 0) {
                    const folds = 3 + Math.round(stackAmt * 2);
                    y += Math.abs(Math.sin(cz * folds * Math.PI)) * footH * 0.5 * stackAmt * cz;   // bunch UP into folds; the hem (t=1) stays at endY
                }
            }
            const x = hips.pos[0] + (ul.pos[0] - hips.pos[0]) * pullAt(t);
            const c: V3 = [x, y, ul.pos[2]];
            if (i === 0) {
                // Hip yoke — directional (per-sector), sampled at the band height (hips→spine RADII) so it hugs the
                // waist at high Rise, × Waist scale. WEIGHT is hips-only (NOT blended to spine): the waistband must
                // stay on the PELVIS, not chase the lumbar/spine arch — else it shears against the leg-weighted pants
                // body when you pose the back (that's the "messed-up waist when posing"). yokeF still drives the
                // RADII/shape; only the skin weight is pinned to hips.
                ringList.push(addRingDir(ac, c, u, v, yokeRadii.map(r => r * waistScale), 1, MIN_GAP, t, hips.idx, 1, hips.idx, 0));
            } else {
                // Hug the thigh→calf with per-sector radii (already octagon-inflated); addRingDir adds the gap.
                const lt = (i - 1) / Math.max(1, N - 1);
                const j = lt < 0.5 ? ul.idx : lo.idx;
                const sc = scaleAt(i);
                // BUTT coverage: the jump from the hip yoke (covers the butt) straight to the thigh radii left
                // the butt poking through the band just below the waist — and the de-collision CAN'T catch it
                // (each garment vert's NEAREST body vert is the thigh, not the further-back butt, so it reads as
                // "not colliding" while the butt pokes through the FACE between rings). Fix: blend the hip
                // cross-section's BACK sectors (which DO project over the butt) additively into the upper rings,
                // faded out by ~the gluteal fold + limited to the back hemisphere (front/sides stay thigh-sized).
                const backK = Math.round(RING * 0.75);              // −Z sector = the butt
                const seat = Math.max(0, 1 - lt / 0.45);            // 1 just below the waist → 0 BELOW the fold (extended to wrap the LOWER butt too)
                const radii = ul.radii.map((ra, k) => {
                    const thigh = (ra + (lo.radii[k] - ra) * lt) * sc;   // sc = the Waist slider slims the front/sides
                    if (seat <= 0) return thigh;
                    const dk = Math.min((k - backK + RING) % RING, (backK - k + RING) % RING);
                    const angW = Math.max(0, 1 - dk / (RING / 4));  // back hemisphere only (±90° from −Z)
                    // Butt coverage uses the FULL hip width (NOT ×sc), so cinching the Waist slims the front/sides
                    // but the back still reaches over the butt (cinching never exposes it).
                    return thigh + Math.max(0, hips.radii[k] - thigh) * seat * angW;   // ADD only → projects over the butt, never shrinks the thigh
                });
                // ── Baggy/stacked jeans (§6): the lower cuff RIPPLES (accordion folds: alternating wider/narrower
                //    rings) + FLARES (pooling) + per-ring jitter, driven by `stack` — the radius half of the gather
                //    (the Y-undulation above bunches it UP at a FIXED length). The de-collision pins a too-tight
                //    fold valley back onto the leg. ──
                const stack = Math.max(0, Math.min(3, p.stack ?? 0));
                const fz = (stack > 0 && p.bottomStyle === 'pants') ? Math.max(0, (lt - 0.55) / 0.45) : 0;   // 0 above mid-calf → 1 at the cuff
                let radii2 = radii;
                if (fz > 0) {
                    const folds = 3 + Math.round(stack * 2);
                    const acc   = 1 + stack * 0.34 * fz * Math.sin(fz * folds * Math.PI);   // alternating wide/narrow rings = horizontal folds
                    const flare = 1 + stack * 0.30 * fz;                                    // widen toward the cuff (pooling)
                    const jit   = 1 + (h11(i * 1.7 + (s === 'L' ? 3 : 7)) - 0.5) * stack * 0.14 * fz;
                    radii2 = radii.map(r => r * Math.max(0.6, acc * flare * jit));
                }
                // ── TAPER (Phase 1A): narrow the leg toward the cuff (skinny jeans). Pants only; opposes the
                //    baggy stack. The de-collision pins it to the leg so a hard taper HUGS the calf/ankle, no clip. ──
                const taper = Math.max(0, Math.min(1, p.cuffTaper ?? 0));
                if (taper > 0 && p.bottomStyle === 'pants' && lt > 0.55) {
                    const tf = 1 - taper * 0.45 * ((lt - 0.55) / 0.45);   // straight above mid-calf → up to ~45% tighter at the cuff
                    radii2 = radii2.map(r => r * tf);
                }
                // ── BAGGY WIDTH: widen the leg below the yoke (1 = fitted to the leg … 2-3 = wide/baggy drape). The
                //    de-collision only pushes OUT, so a WIDER radius is never pinned back → genuinely loose legs
                //    (vs the hugging default). Ramped in over the upper thigh so the waist stays fitted. ──
                const legWidth = Math.max(1, Math.min(3, p.legWidth ?? 1));
                if (legWidth > 1.001) {
                    const wm = 1 + (legWidth - 1) * Math.min(1, lt / 0.12);   // 1 at the waist → full width by the upper thigh
                    radii2 = radii2.map(r => r * wm);
                }
                const ring = addRingDir(ac, c, u, v, radii2, 1, legGap, t, j, 1, j, 0);
                ringList.push(ring);
            }
            // Crotch-fill rings — the WHOLE pulled-to-centre region (t < 0.5, where pullAt reaches the natural leg
            // position; was only the top third 0.34, which left the 0.34→0.5 band exposed). Keep their ANALYTIC
            // per-leg weight: the body-fit pass would re-weight this overlapping fabric to the hips (nearest body
            // vert = the hips-weighted crotch), fusing BOTH legs' crotch sheets into one central panel that stays
            // put when the legs spread = the SKIRT/dress webbing. Protected, each leg's crotch fabric follows ITS
            // upperleg → the inseam opens and the legs separate cleanly on a kick / wide stance / splits.
            if (t < 0.5) for (const vi of ringList[ringList.length - 1]) ac.noXfer.add(vi);
        }
        for (let i = 0; i < N; i++) bandRings(ac, ringList[i], ringList[i + 1]);
        // Raised cuff at the leg end (folds down) → trim band reads as a rolled hem; then cap it closed.
        const cuff = ENABLE_CUFFS && p.trimWidth > 0.001;
        const endRing = cuff ? addCuff(ac, ringList[N], [0, -1, 0], 1, 0.018, 0.010) : ringList[N];
        const capDrop = (lo.radius + legGap) * 0.3 + (cuff ? 0.018 : 0);
        capRing(ac, endRing, [ul.pos[0], endY - capDrop, ul.pos[2]], lo.idx);
    }
}

/** Smooth, outward-oriented per-vertex normals (area-weighted) — matches body/hair generators. */
function recomputeNormals(ac: Accum): void {
    const accN = new Float32Array(ac.count * 3);
    for (let i = 0; i < ac.idx.length; i += 3) {
        const a = ac.idx[i], b = ac.idx[i+1], c = ac.idx[i+2];
        const e1x = ac.pos[b*3]-ac.pos[a*3], e1y = ac.pos[b*3+1]-ac.pos[a*3+1], e1z = ac.pos[b*3+2]-ac.pos[a*3+2];
        const e2x = ac.pos[c*3]-ac.pos[a*3], e2y = ac.pos[c*3+1]-ac.pos[a*3+1], e2z = ac.pos[c*3+2]-ac.pos[a*3+2];
        let nx = e1y*e2z-e1z*e2y, ny = e1z*e2x-e1x*e2z, nz = e1x*e2y-e1y*e2x;
        const rx = ac.nrm[a*3]+ac.nrm[b*3]+ac.nrm[c*3], ry = ac.nrm[a*3+1]+ac.nrm[b*3+1]+ac.nrm[c*3+1], rz = ac.nrm[a*3+2]+ac.nrm[b*3+2]+ac.nrm[c*3+2];
        if (nx*rx + ny*ry + nz*rz < 0) { nx=-nx; ny=-ny; nz=-nz; }
        for (const vtx of [a, b, c]) { accN[vtx*3]+=nx; accN[vtx*3+1]+=ny; accN[vtx*3+2]+=nz; }
    }
    for (let i = 0; i < ac.count; i++) {
        let x = accN[i*3], y = accN[i*3+1], z = accN[i*3+2];
        const l = Math.hypot(x, y, z);
        if (l < 1e-6) { x = ac.nrm[i*3]; y = ac.nrm[i*3+1]; z = ac.nrm[i*3+2]; } else { x/=l; y/=l; z/=l; }
        ac.nrm[i*3]=x; ac.nrm[i*3+1]=y; ac.nrm[i*3+2]=z;
    }
}

function finish(ac: Accum): { geometry: MeshGeometry; jointIndices: Uint8Array; jointWeights: Float32Array } {
    recomputeNormals(ac);
    const vc = ac.count;
    const verts = new Float32Array(vc * 12);
    for (let i = 0; i < vc; i++) {
        const o = i * 12;
        const nx = ac.nrm[i*3], ny = ac.nrm[i*3+1], nz = ac.nrm[i*3+2];
        const ref: V3 = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const t = norm(cross([nx, ny, nz], ref));
        verts[o]   = ac.pos[i*3]; verts[o+1] = ac.pos[i*3+1]; verts[o+2]  = ac.pos[i*3+2];
        verts[o+3] = nx;          verts[o+4] = ny;            verts[o+5]  = nz;
        verts[o+6] = ac.uv[i*2];  verts[o+7] = ac.uv[i*2+1];
        verts[o+8] = t[0];        verts[o+9] = t[1];          verts[o+10] = t[2]; verts[o+11] = 1;
    }
    const ji = new Uint8Array(vc * 4), jw = new Float32Array(vc * 4);
    for (let i = 0; i < vc; i++) { ji[i*4] = ac.j0[i]; ji[i*4+1] = ac.j1[i]; jw[i*4] = ac.w0[i]; jw[i*4+1] = ac.w1[i]; }
    return { geometry: { vertices: verts, indices: new Uint32Array(ac.idx), format: '12float' }, jointIndices: ji, jointWeights: jw };
}

const newAc = (): Accum => ({ pos: [], nrm: [], uv: [], j0: [], w0: [], j1: [], w1: [], idx: [], count: 0, island: [0, 0, 1, 1], noXfer: new Set() });

/** Per-vertex one-ring neighbours (from the garment triangles) — used to smooth the de-collision push. */
function buildAdjacency(ac: Accum): number[][] {
    const adj: Set<number>[] = Array.from({ length: ac.count }, () => new Set<number>());
    for (let i = 0; i < ac.idx.length; i += 3) {
        const a = ac.idx[i], b = ac.idx[i+1], c = ac.idx[i+2];
        adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
    }
    return adj.map(s => [...s]);
}

// Verts within this distance of the body are treated as "touching" → they inherit the body's skin
// weights (deform WITH the body). Verts further out (a flared skirt / loose drape) keep their analytic
// weights so they stay stiff and don't swing with the nearest limb.
const WEIGHT_TRANSFER_DIST = 0.06;

// Cap on the de-collision push. The pass only fixes SHALLOW residual clips (the garment dipping a hair
// under the body); a vertex that's deep inside is intentionally internal — e.g. a sleeve opening tucked
// under the torso — so we must NOT shove it out (that pokes it through as an armpit notch). Capping
// keeps deep internals hidden while still clearing real clips.
const MAX_DECOLLIDE_PUSH = 0.014;

/** Pull a RANGE of garment verts onto the body surface + gap, in BOTH directions (into concavities like the
 *  armpit AND off convex parts) — each moved along its nearest body vertex's normal. The global shrink-wrap
 *  only pushes OUT (it can't fill a concave armpit); this snap can, so a sleeve cap actually FOLLOWS the
 *  body's socket curve — the "offset the mesh surface" fit. Capped (maxIn/maxOut) so a stray nearest-match
 *  can't fling a vert; verts left deeper than maxOut inside (the socket tucked under the torso) stay hidden.
 *  Nearest-VERTEX query (low-poly body + the cap already sits close → matches are local). */
function snapToBody(ac: Accum, start: number, end: number, body: BodyMeshData, gap: number, maxIn: number, maxOut: number): void {
    const bn = body.verts.length / 12;
    if (bn === 0) return;
    // Spatial hash over body verts (was O(garmentVerts × bodyVerts)). snapToBody also PULLS loose verts IN, so a
    // vert farther than the cell falls back to a full scan (rare — base layers/sleeves are built hugging the body)
    // so the exact hug behaviour is preserved for the odd far vert.
    const grid = bodyGrid(body, Math.max(gap + maxIn, gap + maxOut, 0.05));
    for (let g = start; g < end; g++) {
        const gx = ac.pos[g*3], gy = ac.pos[g*3+1], gz = ac.pos[g*3+2];
        let best = grid.nearest(gx, gy, gz).best;
        if (best < 0) {                                                                     // far from the body → true nearest via full scan (rare)
            let bestD = Infinity;
            for (let b = 0; b < bn; b++) {
                const dx = gx - body.verts[b*12], dy = gy - body.verts[b*12+1], dz = gz - body.verts[b*12+2];
                const d = dx*dx + dy*dy + dz*dz;
                if (d < bestD) { bestD = d; best = b; }
            }
            if (best < 0) continue;
        }
        const o = best*12, nx = body.verts[o+3], ny = body.verts[o+4], nz = body.verts[o+5];
        const signed = (gx-body.verts[o])*nx + (gy-body.verts[o+1])*ny + (gz-body.verts[o+2])*nz;   // dist from surface
        const move = Math.max(-maxIn, Math.min(maxOut, gap - signed));
        ac.pos[g*3] += nx*move; ac.pos[g*3+1] += ny*move; ac.pos[g*3+2] += nz*move;
    }
}

/**
 * Generation-time fit pass — the "never clip" guarantee + pose robustness:
 *  1. Shrink-wrap / de-collision: any garment vertex inside the body (or closer than `gap`) is pushed
 *     OUT to the body surface + gap. FACE-AWARE: triangle centroids + edge midpoints are sampled too, so a
 *     body bulge poking through the middle of a garment FACE (not just at a vertex) is caught and the face is
 *     lifted out. The push is SMOOTHED over the garment surface so a corrected vert lifts its neighbours into
 *     a soft bump (no spikes); it only ever pushes out, so loose/flared areas are untouched (drape preserved).
 *  2. Weight transfer: each touching garment vertex copies the nearest body vertex's skin weights, so
 *     the garment folds with the body when posed (far less joint clipping than analytic ring weights).
 * Nearest-VERTEX query (the body is low-poly + the garment already hugs it, so corrections are small).
 * `sides` (optional) = the L/R limb joint-index sets: the weight transfer then NEVER lets a left-limb garment
 *  vert inherit a RIGHT-limb body weight (or vice versa). Without it, an inner vert of one leg/shoe grabs the
 *  OTHER limb's weight (their verts are nearby in the rest pose) and stretches across to it on a kick — the
 *  "the legs/shoes are webbed together" bug. (The crotch centre/hips case is handled separately by `noXfer`.)
 */
/** The L/R limb joint-INDEX sets (from the `_L`/`_R` joint name suffixes) — passed to `fitGarmentToBody` so the
 *  weight transfer can't cross limbs (the cross-leg/shoe web fix). */
function limbSideSets(fit: BodyFit): { L: Set<number>; R: Set<number> } {
    const L = new Set<number>(), R = new Set<number>();
    for (const [name, jf] of Object.entries(fit.joints)) {
        if (!jf) continue;
        if (name.endsWith('_L')) L.add(jf.idx);
        else if (name.endsWith('_R')) R.add(jf.idx);
    }
    return { L, R };
}

function fitGarmentToBody(ac: Accum, body: BodyMeshData, gap: number, maxPush = MAX_DECOLLIDE_PUSH, sides?: { L: Set<number>; R: Set<number> }): void {
    const bn = body.verts.length / 12;
    if (bn === 0 || ac.count === 0) return;
    const push = new Float32Array(ac.count);                                   // outward distance per vert
    const pnx = new Float32Array(ac.count), pny = new Float32Array(ac.count), pnz = new Float32Array(ac.count);
    const near = new Int32Array(ac.count).fill(-1);
    const nearD = new Float32Array(ac.count);
    // Spatial hash over body verts so each garment vert tests only its LOCAL 3×3×3 cells (was O(garmentVerts × bodyVerts)).
    // cell = the max distance that affects the fit (push reach OR weight transfer), so a vert farther than that
    // (best = -1) correctly gets no push and no weight transfer — same result the old full scan would produce.
    const grid = bodyGrid(body, Math.max(gap + maxPush, WEIGHT_TRANSFER_DIST));
    for (let g = 0; g < ac.count; g++) {
        const gx = ac.pos[g*3], gy = ac.pos[g*3+1], gz = ac.pos[g*3+2];
        const { best, d2 } = grid.nearest(gx, gy, gz);
        near[g] = best;
        if (best < 0) { nearD[g] = Infinity; continue; }          // no body vert nearby → no push / no weight transfer
        nearD[g] = Math.sqrt(d2);
        const o = best*12, nx = body.verts[o+3], ny = body.verts[o+4], nz = body.verts[o+5];
        const signed = (gx-body.verts[o])*nx + (gy-body.verts[o+1])*ny + (gz-body.verts[o+2])*nz; // dist from surface
        push[g] = Math.min(maxPush, Math.max(0, gap - signed));   // cap → don't expose deep internals
        pnx[g] = nx; pny[g] = ny; pnz[g] = nz;
    }
    const adj = buildAdjacency(ac);
    // FACE-AWARE pass — the per-vertex test above only catches garment VERTICES inside the body, but a body
    // bulge (butt / knee / hip) can poke through the middle of a garment FACE between verts and never touch a
    // garment vertex. So sample each triangle CENTROID and each EDGE MIDPOINT too: if a sample sits inside the
    // body, lift that face/edge's garment verts out enough to clear it. The sample's nearest body vertex is
    // local to its corners, so reuse the per-corner near[] as candidates (no extra full search → ~O(verts),
    // negligible vs the per-vertex loop). It only ever RAISES push (max) along each vert's own normal, so the
    // smoothing + cap below still bound it (no new spikes; deep internals stay hidden) — strictly additive.
    const coverSample = (sx: number, sy: number, sz: number, cands: number[], verts: number[]): void => {
        let nb = -1, nd = Infinity;
        for (const c of cands) {                                   // nearest body vert among the corners' picks
            if (c < 0) continue;
            const o = c*12, dx = sx-body.verts[o], dy = sy-body.verts[o+1], dz = sz-body.verts[o+2], d = dx*dx+dy*dy+dz*dz;
            if (d < nd) { nd = d; nb = c; }
        }
        if (nb < 0) return;
        const o = nb*12;
        const signed = (sx-body.verts[o])*body.verts[o+3] + (sy-body.verts[o+1])*body.verts[o+4] + (sz-body.verts[o+2])*body.verts[o+5];
        if (signed >= gap) return;                                 // sample safely outside the body → no poke
        const need = Math.min(maxPush, gap - signed);              // lift needed to clear it (same cap as the verts)
        for (const g of verts) if (need > push[g]) push[g] = need; // raise each corner's push (applied along its own normal)
    };
    for (let t = 0; t + 2 < ac.idx.length; t += 3) {               // triangle centroids
        const a = ac.idx[t], b = ac.idx[t+1], c = ac.idx[t+2];
        coverSample(
            (ac.pos[a*3]+ac.pos[b*3]+ac.pos[c*3])/3, (ac.pos[a*3+1]+ac.pos[b*3+1]+ac.pos[c*3+1])/3, (ac.pos[a*3+2]+ac.pos[b*3+2]+ac.pos[c*3+2])/3,
            [near[a], near[b], near[c]], [a, b, c]);
    }
    for (let g = 0; g < ac.count; g++) {                           // edge midpoints (each edge once, via adjacency)
        for (const n of adj[g]) {
            if (n <= g) continue;
            coverSample((ac.pos[g*3]+ac.pos[n*3])*0.5, (ac.pos[g*3+1]+ac.pos[n*3+1])*0.5, (ac.pos[g*3+2]+ac.pos[n*3+2])*0.5, [near[g], near[n]], [g, n]);
        }
    }
    // Dilate/smooth the push so corrections are soft bumps, never spikes (max → never drops below required).
    for (let iter = 0; iter < 3; iter++) {
        const next = push.slice();
        for (let g = 0; g < ac.count; g++) {
            const nb = adj[g]; if (!nb.length) continue;
            let s = 0; for (const k of nb) s += push[k];
            next[g] = Math.max(push[g], 0.6 * (s / nb.length));
        }
        push.set(next);
    }
    for (let g = 0; g < ac.count; g++) {
        if (push[g] > 0) { ac.pos[g*3] += pnx[g]*push[g]; ac.pos[g*3+1] += pny[g]*push[g]; ac.pos[g*3+2] += pnz[g]*push[g]; }
        if (nearD[g] <= WEIGHT_TRANSFER_DIST && !ac.noXfer.has(g)) {   // touching → inherit the body's deformation (unless protected: the crotch fabric keeps its per-leg weight)
            const b = near[g];
            let i0 = 0, w0 = -1, i1 = 0, w1 = -1;
            for (let k = 0; k < 4; k++) {
                const w = body.jw[b*4+k], jx = body.ji[b*4+k];
                if (w > w0) { i1 = i0; w1 = w0; i0 = jx; w0 = w; }
                else if (w > w1) { i1 = jx; w1 = w; }
            }
            // SAME-SIDE GUARD: never let a LEFT-limb garment vert inherit a RIGHT-limb body weight (or vice versa).
            // Their verts sit close in the rest pose, so the nearest-vert query grabs the wrong limb and the
            // garment stretches to it on a kick. Keep this vert's analytic (per-limb) weight instead.
            const crossSide = !!sides && (
                (sides.L.has(ac.j0[g]) && sides.R.has(i0)) || (sides.R.has(ac.j0[g]) && sides.L.has(i0))
            );
            const sum = w0 + (w1 > 0 ? w1 : 0);
            if (sum > 0 && !crossSide) {
                ac.j0[g] = i0; ac.w0[g] = w0 / sum;
                ac.j1[g] = w1 > 0 ? i1 : i0; ac.w1[g] = w1 > 0 ? w1 / sum : 0;
            }
        }
    }
}

/** The "always skin-tight, never clips" conform for the BASE LAYERS (undershirt / underpants). Unlike the outer
 *  garments (which only de-collide outward and keep their own looser drape), a base layer must HUG: so first
 *  `snapToBody` pulls every loose vert IN and pushes every clipped vert OUT to the body surface + a hair (BOTH
 *  directions, with a generous outward cap so even a deep-inside vert clears the skin — the old 0.02 cap left
 *  >2cm-deep verts poking through). Then `fitGarmentToBody` runs the FACE-AWARE pass (a body bulge poking through
 *  a garment FACE between verts is lifted out) + copies the body's skin weights so it folds with the skin when
 *  posed. There is deliberately NO gap/fit slider — the gap is a fixed hair so it's always form-fit. */
function conformBaseLayer(ac: Accum, fit: BodyFit): void {
    if (!fit.body) return;
    // TWO snap passes — pass 1 uses a BIG inward cap (0.22) so even a hip-wide hem ring hanging off the body
    // collapses fully onto the skin (the old single 0.07 cap left anything looser standing off = the flare). A
    // far vert's nearest-body-VERTEX query can pick the wrong surface, so pass 2 (now that every vert sits close)
    // re-snaps onto the CORRECT local surface with a tight cap → clean skin-tight fit, no residual flare.
    snapToBody(ac, 0, ac.count, fit.body, BASE_GAP, 0.22, 0.12);
    snapToBody(ac, 0, ac.count, fit.body, BASE_GAP, 0.05, 0.05);
    fitGarmentToBody(ac, fit.body, BASE_GAP, MAX_DECOLLIDE_PUSH, limbSideSets(fit));   // face-aware lift + body-weight transfer (no face poke-through, poses with the skin)
}

export function generateTop(fit: BodyFit, p: TopParams) {
    const ac = newAc();
    const rings = 4 + Math.round(Math.max(0, Math.min(1, p.chunkiness)) * 4);   // denser → smoother shrink-wrap
    // DENSER torso rings (like the legs) → the shell follows the body's vertical curves (waist / chest / crop
    // hem) so skin can't poke through a band face between rings; bumped again for extra collision support.
    buildTorso(ac, fit, p, Math.max(12, rings * 3));
    buildSleeves(ac, fit, p);
    // Bigger de-collision cap for the top (was the tiny 0.014 default). The offset-surface sleeve (the default)
    // sits OUTSIDE the body so its verts get push=0 regardless of the cap — raising it only clears real TORSO
    // clips (deep concavities the small cap left poking through), not the hidden sleeve socket. Slightly under
    // the bottoms' 0.09 to stay gentle on the rare analytic-tube sleeve fallback (which does tuck a socket).
    if (fit.body) fitGarmentToBody(ac, fit.body, MIN_GAP, 0.06, limbSideSets(fit));
    return finish(ac);
}

export function generateBottom(fit: BodyFit, p: BottomParams, shoe: ShoeParams | null = null) {
    const ac = newAc();
    const rings = 4 + Math.round(Math.max(0, Math.min(1, p.chunkiness)) * 4);
    if (p.bottomStyle === 'skirt') buildSkirt(ac, fit, p, rings);
    else buildLegs(ac, fit, p, rings, shoe);
    // Bottoms get a BIG de-collision cap: the legs/hip have no deep internals to hide (unlike a sleeve
    // socket), and the projecting butt / fuller thighs can sit well inside the garment — so allow the
    // shrink-wrap to push the skin back out fully (no clip). Now the garment is at the body's resolution
    // (RING=24) the verts already line up, so this is mostly a safety net for the deepest spots.
    if (fit.body) fitGarmentToBody(ac, fit.body, MIN_GAP, 0.09, limbSideSets(fit));
    return finish(ac);
}

// ── Shoes ────────────────────────────────────────────────────────────────────
// A foot-wrapping upper swept heel→toe (flat sole bottom, rounded top, toe-capped, HEEL OPEN so the leg
// plugs the ankle hole), skinned 100% to the foot joint so it deforms with the ankle. The foot box is taken
// from the body mesh (verts weighted to the foot joint) so it auto-fits any foot size. Phase 1: sneaker /
// flat / heel via params; a real boot SHAFT (up the lower leg) is Phase 1.5. See docs/specs/shoe-generation.md.

/** Axis-aligned bbox of the body verts weighted to `footIdx` (weight > 0.5), or null if not enough. */
function footBox(body: BodyMeshData | undefined, footIdx: number):
    { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null {
    if (!body) return null;
    const n = body.verts.length / 12;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity, cnt = 0;
    for (let i = 0; i < n; i++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (body.ji[i*4+k] === footIdx) w = Math.max(w, body.jw[i*4+k]);
        if (w < 0.5) continue;
        const x = body.verts[i*12], y = body.verts[i*12+1], z = body.verts[i*12+2];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
        cnt++;
    }
    return cnt >= 4 ? { minX: mnx, maxX: mxx, minY: mny, maxY: mxy, minZ: mnz, maxZ: mxz } : null;
}

/** One shoe cross-section ARC around +Z (X-Y plane). `gap` = the open angle at the TOP (radians): a wide gap
 *  (~100°) leaves the foot exposed like a slipper; gap→0 domes the section CLOSED over the instep (the vamp).
 *  Bottom FLATTENED onto the sole. Skinned j. */
function shoeArc(ac: Accum, cx: number, footBottom: number, soleBot: number, topY: number, z: number, rw: number, uvV: number, j: number, gap: number): number[] {
    const midY = (soleBot + topY) * 0.5, rh = (topY - soleBot) * 0.5;
    const a0 = Math.PI / 2 + gap / 2, arc = Math.PI * 2 - gap;
    const out: number[] = [];
    for (let k = 0; k <= RING; k++) {                    // open arc (RING+1 verts, NOT wrapped)
        const a = a0 + (k / RING) * arc, cw = Math.cos(a), sh = Math.sin(a);
        let y = midY + sh * rh;
        if (y < footBottom) y = soleBot;                 // flatten below the foot → flat sole
        out.push(pushVert(ac, [cx + cw * rw, y, z], norm([cw, sh, 0]), k / RING, uvV, j, 1, j, 0));
    }
    return out;
}
/** Band two OPEN arcs (no wrap-around — keeps the top open). */
function bandStrip(ac: Accum, a: number[], b: number[]): void {
    const n = Math.min(a.length, b.length);
    for (let k = 0; k < n - 1; k++) { ac.idx.push(a[k], a[k + 1], b[k + 1]); ac.idx.push(a[k], b[k + 1], b[k]); }
}

/** Wrap-around ANKLE TUBE above the low shoe — a stacked ring cylinder around the ankle, skinned
 *  foot→lowerleg so it bends with the ankle. shaftHeight 0 = none (slide/low shoe), ~0.3 = high-top,
 *  ~0.7 = ankle boot, 1+ = up the calf. The base overlaps the shoe upper (buried) so there's no seam;
 *  the de-collision pass hugs it to the ankle. */
function buildAnkleTube(
    ac: Accum, fit: BodyFit, s: 'L' | 'R', j: number,
    box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
    cx: number, halfW: number, th: number, p: ShoeParams,
): void {
    const shaft = Math.max(0, Math.min(1.6, p.shaftHeight ?? 0));
    if (shaft < 0.02) return;                                  // no tube → the low shoe's collar lip is enough
    const lower = fit.joints['lowerleg_' + s];
    const footH = box.maxY - box.minY, spanZ = box.maxZ - box.minZ;
    const ankleZ = box.minZ + spanZ * 0.32;                   // ankle sits forward of the heel, under the shin
    const baseY  = box.minY + footH * 0.45;                   // start INSIDE the shoe upper (overlap → no gap)
    const ankleR = (lower?.radius ?? halfW * 0.6) + th;       // ankle radius + upper offset
    const legUnit = lower ? Math.max(footH * 2, lower.pos[1] - box.maxY) : footH * 3;
    const topY = box.minY + footH * 0.55 + shaft * legUnit * 1.15;   // visible height grows from the shoe rim
    const topX = lower ? cx + (lower.pos[0] - cx) * 0.6 : cx;        // drift toward the shin so a tall shaft tracks the leg
    const topZ = lower ? ankleZ + (lower.pos[2] - ankleZ) * 0.6 : ankleZ;
    const jb = lower?.idx ?? j;
    const u: V3 = [1, 0, 0], v: V3 = [0, 0, 1];
    const tubeRings = 2 + Math.round(shaft * 5);
    const mix = (a: number, b: number, f: number) => a + (b - a) * f;
    const loops: number[][] = [];
    for (let i = 0; i <= tubeRings; i++) {
        const f = i / tubeRings;
        const c: V3 = [mix(cx, topX, f), mix(baseY, topY, f), mix(ankleZ, topZ, f)];
        const r = ankleR * (1 - 0.12 * f);                    // taper slightly up the shaft
        loops.push(addRing(ac, c, u, v, r, f, j, 1 - f, jb, f));   // skin foot(base)→lowerleg(top)
    }
    for (let i = 0; i < tubeRings; i++) bandRings(ac, loops[i], loops[i + 1]);
}

export function generateShoe(fit: BodyFit, p: ShoeParams) {
    const ac = newAc();
    const rings = 5 + Math.round(Math.max(0, Math.min(1, p.chunkiness)) * 5);
    const th = Math.max(MIN_GAP, p.thickness);
    for (const s of ['L', 'R'] as const) {
        const foot = fit.joints['foot_' + s];
        if (!foot) continue;
        ac.island = s === 'L' ? GARMENT_IS.legL : GARMENT_IS.legR;
        const j = foot.idx;
        let box = footBox(fit.body, j);
        if (!box) {                                       // no body mesh → derive from the foot joint radius (≈ 0.04·limbScale)
            const lt = (foot.radius || 0.0015) / 0.04, f = foot.pos;
            box = { minX: f[0]-0.046*lt, maxX: f[0]+0.046*lt, minY: f[1]-0.052*lt, maxY: f[1]+0.012*lt, minZ: f[2]-0.056*lt, maxZ: f[2]+0.14*lt };
        }
        const cx = (box.minX + box.maxX) * 0.5;
        const halfW = (box.maxX - box.minX) * 0.5 + th;
        const footH = box.maxY - box.minY;
        const soleBot0 = box.minY - Math.max(0.002, p.soleThickness);
        const heelZ = box.minZ - th, toeZ = box.maxZ + th, span = (toeZ - heelZ) || 0.1, cenY = (box.minY + box.maxY) * 0.5;
        // VAMP coverage: close the top gap from the toe BACK toward the ankle as topCover rises.
        // 0 = open trough (toes/instep out, sandal) … 1 = closed upper up to the ankle front.
        const cover = Math.max(0, Math.min(1, p.topCover ?? 0.85));
        const vampBackT = 1 - cover * 0.62;               // covered region is t >= vampBackT  (toe=1 … 0.38 when cover=1)
        const OPEN_GAP = Math.PI * 0.55;                  // ~100° slipper opening (where the foot is exposed)
        const arcs: number[][] = [];
        for (let i = 0; i <= rings; i++) {
            const t = i / rings;                          // 0 heel → 1 toe
            const z = heelZ + span * t;
            const toeT = Math.max(0, (t - 0.72) / 0.28);  // taper toward the toe
            const rw = halfW * (1 - toeT * (0.3 + 0.5 * p.toePoint));
            const wedge  = p.heelHeight  * footH * 1.2 * Math.max(0, 0.35 - t) / 0.35;   // heel lift at the back
            const collar = p.ankleCollar * footH        * Math.max(0, 0.40 - t) / 0.40;  // raised back / ankle lip
            // coverAmt: 0 (open) behind the vamp edge → 1 (domed shut) toward the toe, ramped over a short band.
            const coverAmt = Math.max(0, Math.min(1, (t - vampBackT) / 0.16));
            const lowTopY  = box.minY + footH * 0.55 + th + collar;   // open trough rim (the foot rises out here)
            const highTopY = box.maxY + th + footH * 0.14;            // dome ABOVE the foot top → instep covered, no clip
            const topY = lowTopY + (highTopY - lowTopY) * coverAmt;
            const gap  = OPEN_GAP * (1 - coverAmt);                   // → 0 over the vamp (closed), full over the ankle (open)
            arcs.push(shoeArc(ac, cx, box.minY, soleBot0 - wedge, topY, z, rw, t, j, gap));
        }
        for (let i = 0; i < rings; i++) bandStrip(ac, arcs[i], arcs[i + 1]);
        capRing(ac, arcs[rings], [cx, cenY, toeZ + footH * 0.3 * (1 - p.toePoint)], j);   // close the toe
        capRing(ac, arcs[0],     [cx, cenY, heelZ - footH * 0.15], j);                    // close the heel (counter)
        buildAnkleTube(ac, fit, s, j, box, cx, halfW, th, p);                             // shaft / collar tube (slide→high-top→boot)
    }
    if (fit.body) fitGarmentToBody(ac, fit.body, MIN_GAP, 0.05, limbSideSets(fit));
    return finish(ac);
}

/** The sock LEG = the body's ACTUAL leg rings (thigh→ankle, captured in body-generator) OFFSET outward by the thin
 *  sock gap, cut at `legHeight`. Because it IS the leg surface + a tiny offset, it's skin-tight AND can't clip
 *  (the same offset-surface trick that fixed the sleeves). Skin weights ride the captured ring verts → it bends. */
function buildSockLegOffset(ac: Accum, legRings: ArmRing[], off: number, legH: number): void {
    const rings = [...legRings].reverse();   // body order is thigh-top→ankle; the sock grows UP from the ankle → reverse
    const reach: number[] = [0];
    for (let i = 1; i < rings.length; i++) reach[i] = reach[i - 1] + len(sub(rings[i].center, rings[i - 1].center));
    const total = reach[reach.length - 1] || 1;
    for (let i = 0; i < reach.length; i++) reach[i] /= total;       // 0 = ankle … 1 = thigh-top
    const L = Math.max(0.04, Math.min(1, legH * 0.72));            // legHeight → how far up (≈0.32 crew · 0.62 knee · 1 thigh-high)
    const pushOffsetRing = (verts: ArmRing['verts'], uvV: number): number[] => {
        const m = verts.length, out: number[] = [];
        for (let k = 0; k < m; k++) {
            const vv = verts[k];
            out.push(pushVert(ac, [vv.p[0] + vv.n[0] * off, vv.p[1] + vv.n[1] * off, vv.p[2] + vv.n[2] * off] as V3, vv.n, k / m, uvV, vv.j0, vv.w0, vv.j1, vv.w1));
        }
        return out;
    };
    const built: number[][] = [];
    let lastI = 0;
    for (let i = 0; i < rings.length; i++) {
        if (reach[i] <= L + 1e-3) { built.push(pushOffsetRing(rings[i].verts, Math.min(1, reach[i] / Math.max(1e-4, L)))); lastI = i; }
        else {
            // Interpolate the bracketing rings at exactly reach L (vert k ↔ vert k) → the cuff, then stop.
            const a = rings[lastI].verts, b = rings[i].verts, f = (L - reach[lastI]) / Math.max(1e-4, reach[i] - reach[lastI]);
            const m = Math.min(a.length, b.length), end: ArmRing['verts'] = [];
            for (let k = 0; k < m; k++) {
                const va = a[k], vb = b[k], use = f < 0.5 ? va : vb;
                end.push({
                    p: [va.p[0] + (vb.p[0] - va.p[0]) * f, va.p[1] + (vb.p[1] - va.p[1]) * f, va.p[2] + (vb.p[2] - va.p[2]) * f] as V3,
                    n: norm([va.n[0] + (vb.n[0] - va.n[0]) * f, va.n[1] + (vb.n[1] - va.n[1]) * f, va.n[2] + (vb.n[2] - va.n[2]) * f] as V3),
                    j0: use.j0, w0: use.w0, j1: use.j1, w1: use.w1,
                });
            }
            built.push(pushOffsetRing(end, 1));
            break;
        }
    }
    for (let i = 0; i < built.length - 1; i++) bandRings(ac, built[i], built[i + 1]);
}

/** The sock LEG tube above the foot. Preferred path: OFFSET the body's real leg rings (buildSockLegOffset) →
 *  skin-tight + clip-free. Fallback (no captured surface, e.g. a non-procedural body): a smooth joint-radii tube. */
function buildSockLeg(
    ac: Accum, fit: BodyFit, s: 'L' | 'R',
    box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
    cx: number, footTopY: number, th: number, p: SockParams,
): void {
    const lo = fit.joints['lowerleg_' + s], ul = fit.joints['upperleg_' + s], foot = fit.joints['foot_' + s];
    if (!lo || !foot) return;
    const legH = Math.max(0, Math.min(1.3, p.legHeight ?? 0.32));
    if (legH < 0.02) return;                                  // no-show sock → just the foot
    const surf = fit.legSurface?.[s];
    if (surf && surf.length >= 2) { buildSockLegOffset(ac, surf, th, legH); return; }   // ← the real fix

    // ── Fallback (no captured leg surface): a smooth joint-radii tube, round ankle → calf → thigh. ──
    const cl = (x: number) => Math.max(0, Math.min(1, x));
    const u: V3 = [1, 0, 0], v: V3 = [0, 0, 1];
    const ankleY = footTopY, kneeY = lo.pos[1];
    const thighTopY = ul ? lo.pos[1] + (ul.pos[1] - lo.pos[1]) * 0.78 : kneeY + (kneeY - ankleY) * 0.9;
    const topY = ankleY + legH * Math.max(0.001, thighTopY - ankleY);
    const baseY = box.minY + (footTopY - box.minY) * 0.55;
    const NL = Math.max(12, Math.round(legH * 18));
    const ankleZ = box.minZ + (box.maxZ - box.minZ) * 0.32;
    const ankleR = (box.maxX - box.minX) * 0.5 * 0.65;
    const loops: number[][] = [];
    for (let i = 0; i <= NL; i++) {
        const y = baseY + (topY - baseY) * (i / NL);
        let cxr: number, czr: number, radii: number[], ja: number, wa: number, jb: number, wb: number;
        if (y <= kneeY) {
            const sf = cl((y - ankleY) / Math.max(1e-4, kneeY - ankleY));
            cxr = cx + (lo.pos[0] - cx) * sf; czr = ankleZ + (lo.pos[2] - ankleZ) * sf;
            radii = lo.radii.map(r => (ankleR + (r - ankleR) * sf) * 0.88);
            ja = foot.idx; wa = 1 - sf; jb = lo.idx; wb = sf;
        } else {
            const tf = cl((y - kneeY) / Math.max(1e-4, thighTopY - kneeY));
            cxr = lo.pos[0] + ((ul ? ul.pos[0] : lo.pos[0]) - lo.pos[0]) * tf;
            czr = lo.pos[2] + ((ul ? ul.pos[2] : lo.pos[2]) - lo.pos[2]) * tf;
            radii = lo.radii.map((r, k) => (r + ((ul ? ul.radii[k] : r) - r) * tf) * 0.88);
            ja = lo.idx; wa = 1 - tf; jb = ul ? ul.idx : lo.idx; wb = tf;
        }
        loops.push(addRingDir(ac, [cxr, y, czr], u, v, radii, 1, th, i / NL, ja, wa, jb, wb));
    }
    for (let i = 0; i < NL; i++) bandRings(ac, loops[i], loops[i + 1]);
}

/** UNDERSHIRT = a genuinely SKIN-TIGHT torso base layer. PREFERRED path: build it as the body's OWN torso rings
 *  offset outward by a hair (`buildTorsoOffset`) → it literally IS the torso surface + 1mm, so it can't clip or
 *  flare and isn't lumpy (the same offset-surface fix as the sleeves + socks). The captured rings stop at the
 *  pelvis/crotch, so the hem can never reach the split legs. Sleeves come from the arm surface (already offset).
 *  Fallback (a non-procedural body with no captured surface): the old tube + both-way conform. */
export function generateUndershirt(fit: BodyFit, p: UndershirtParams) {
    const ac = newAc();
    const tp: TopParams = {
        slot: 'top', neckline: p.neckline, necklineHeight: 0.5,
        // hem position: crop RAISES it toward the underbust (+), hemExtend DROPS it below the top (−). 0/0 = at the hips.
        // The drop is capped at −0.28 (≈ the crotch) — the captured torso rings end there anyway (no split-leg zone).
        hemHeight: 0.78 * Math.max(0, Math.min(1, p.crop ?? 0)) - 0.28 * Math.max(0, Math.min(1, p.hemExtend)),
        thickness: BASE_GAP,
        shoulderCoverage: Math.max(0, Math.min(1, p.shoulderCoverage)),
        sleeveLength: Math.max(0, Math.min(1, p.sleeves)),
        sleeveWidth: 0.001, sleeveCap: 0, sleeveInset: 1.0,
        baseColor: p.baseColor, trimColor: p.trimColor, gradient: p.gradient, trimWidth: p.trimWidth, chunkiness: p.chunkiness,
    };
    const hips = fit.joints['hips'], chest = fit.joints['chest'], neck = fit.joints['neck'];
    if (fit.torsoSurface && fit.torsoSurface.length >= 2 && hips && chest && neck) {
        const hemY  = hips.pos[1] + (chest.pos[1] - hips.pos[1]) * tp.hemHeight;          // crop up / extend down
        const neckY = chest.pos[1] + (neck.pos[1] - chest.pos[1]) * tp.necklineHeight;    // crew neckline
        buildTorsoOffset(ac, fit.torsoSurface, hemY, neckY, BASE_GAP, tp);                // ← the real fix: IS the body surface + 1mm
        buildSleeves(ac, fit, tp);                                                        // arm-surface offset (already clip-free); no-op at sleeveLength 0
        return finish(ac);
    }
    // Fallback (no captured torso surface): the old tube + both-way conform.
    const rings = 4 + Math.round(Math.max(0, Math.min(1, p.chunkiness)) * 4);
    buildTorso(ac, fit, tp, Math.max(12, rings * 3));
    buildSleeves(ac, fit, tp);   // no-op when sleeveLength = 0
    if (fit.body) conformBaseLayer(ac, fit);   // ALWAYS skin-tight to the body (no fit-gap slider, no clipping)
    return finish(ac);
}

/** UNDERPANTS as the body's OWN lower-body surface offset OUTWARD — a pelvis SEAT (torso rings) that splits into two
 *  short LEGS (leg rings), with the crotch closed exactly like the body. Genuinely skin-tight + clip-free (the same
 *  offset-surface fix as the undershirt/sleeves/socks, now for the harder split-leg topology). MIRRORS the body's
 *  pelvis→leg→crotch construction (addStitchedBody): ring 0 (`pb`, a 24-gon) splits into two 16-gon leg loops that
 *  share 3 crotch verts; here those shared verts are RECOVERED as the midpoint of each leg's captured copies (they
 *  were one vert before the body extruded the two legs). Returns false (→ caller falls back) if no captured surface. */
function buildUnderpantsOffset(ac: Accum, fit: BodyFit, p: UnderpantsParams, off: number): boolean {
    const rings = fit.torsoSurface, legL = fit.legSurface?.L, legR = fit.legSurface?.R, hips = fit.joints['hips'];
    if (!rings || rings.length < 5 || !legL || legL.length < 2 || !legR || legR.length < 2 || !hips) return false;
    const pby = rings[0].center[1];                                            // pelvis-bottom (ring 0) = where the legs split
    const waistY = Math.max(pby + 1e-3, hips.pos[1] + hips.radius * (p.waistHeight ?? 0));
    const pushRing = (verts: ArmRing['verts'], uvV: number): number[] => {     // offset a captured ring outward → new indices
        const m = verts.length, out: number[] = [];
        for (let k = 0; k < m; k++) { const vv = verts[k]; out.push(pushVert(ac, [vv.p[0] + vv.n[0] * off, vv.p[1] + vv.n[1] * off, vv.p[2] + vv.n[2] * off] as V3, vv.n, k / m, uvV, vv.j0, vv.w0, vv.j1, vv.w1)); }
        return out;
    };

    // ── SEAT: offset torso rings from the waistband down to the pelvis bottom (one 24-gon tube; covers the butt) ──
    ac.island = GARMENT_IS.torso;
    const NS = 6, seat: number[][] = [];
    for (let i = 0; i <= NS; i++) { const t = i / NS; seat.push(pushRing(torsoSurfaceAt(rings, waistY + (pby - waistY) * t), t === 0 ? 0 : 0.5)); }   // uvV 0 at the waistband = trim band
    for (let i = 0; i < NS; i++) bandRings(ac, seat[i], seat[i + 1]);
    const pb = seat[NS];                                                       // the 24 offset verts of pelvis-bottom (ring 0)

    // ── CROTCH verts (shared, on the pelvis edge): midpoint of each leg's captured copies (one vert pre-extrusion) ──
    const mid = (a: ArmRing['verts'][number], b: ArmRing['verts'][number]): number => {
        const nx = a.n[0] + b.n[0], ny = a.n[1] + b.n[1], nz = a.n[2] + b.n[2], nl = Math.hypot(nx, ny, nz) || 1;
        const n: V3 = [nx / nl, ny / nl, nz / nl];
        return pushVert(ac, [(a.p[0] + b.p[0]) / 2 + n[0] * off, (a.p[1] + b.p[1]) / 2 + n[1] * off, (a.p[2] + b.p[2]) / 2 + n[2] * off] as V3, n, 0.5, 0.5, a.j0, a.w0, a.j1, a.w1);
    };
    const cf = mid(legL[0].verts[1], legR[0].verts[15]);   // front-crotch  (legLoop index 1 ↔ R 15)
    const cm = mid(legL[0].verts[2], legR[0].verts[14]);   // mid-crotch
    const cb = mid(legL[0].verts[3], legR[0].verts[13]);   // back-crotch

    // ── LEGS: offset each leg's rings, thigh-top → the brief/boxer cut, banded onto its pelvis-edge loop ──
    const L = Math.max(0.05, Math.min(0.6, 0.05 + 0.3 * Math.max(0, Math.min(1, p.legExtend))));   // fraction down the whole leg
    const buildLeg = (legRings: ArmRing[], side: 'L' | 'R', pelvisLoop: number[]): number[] => {
        ac.island = side === 'L' ? GARMENT_IS.legL : GARMENT_IS.legR;
        const reach: number[] = [0];
        for (let i = 1; i < legRings.length; i++) reach[i] = reach[i - 1] + len(sub(legRings[i].center, legRings[i - 1].center));
        const total = reach[reach.length - 1] || 1;
        for (let i = 0; i < reach.length; i++) reach[i] /= total;
        const built: number[][] = [pelvisLoop];
        let lastI = 0;
        for (let i = 0; i < legRings.length; i++) {
            if (reach[i] <= L + 1e-3) { built.push(pushRing(legRings[i].verts, Math.min(1, reach[i] / Math.max(1e-4, L)))); lastI = i; }
            else {
                const a = legRings[lastI].verts, b = legRings[i].verts, f = (L - reach[lastI]) / Math.max(1e-4, reach[i] - reach[lastI]);
                const m = Math.min(a.length, b.length), end: ArmRing['verts'] = [];
                for (let k = 0; k < m; k++) { const va = a[k], vb = b[k], use = f < 0.5 ? va : vb;
                    end.push({ p: [va.p[0] + (vb.p[0] - va.p[0]) * f, va.p[1] + (vb.p[1] - va.p[1]) * f, va.p[2] + (vb.p[2] - va.p[2]) * f] as V3,
                        n: norm([va.n[0] + (vb.n[0] - va.n[0]) * f, va.n[1] + (vb.n[1] - va.n[1]) * f, va.n[2] + (vb.n[2] - va.n[2]) * f] as V3),
                        j0: use.j0, w0: use.w0, j1: use.j1, w1: use.w1 }); }
                built.push(pushRing(end, 1)); break;
            }
        }
        for (let i = 0; i < built.length - 1; i++) bandRings(ac, built[i], built[i + 1]);
        return built[1];   // the offset thigh-top ring (for the crotch bridge)
    };
    // pelvis-edge loops — mirror the body's legLoops (half of ring 0 + the 3 shared crotch verts), same vert order
    const Lloop = [pb[6], cf, cm, cb, pb[18], pb[19], pb[20], pb[21], pb[22], pb[23], pb[0], pb[1], pb[2], pb[3], pb[4], pb[5]];
    const Rloop = [pb[6], pb[7], pb[8], pb[9], pb[10], pb[11], pb[12], pb[13], pb[14], pb[15], pb[16], pb[17], pb[18], cb, cm, cf];
    const Ltop = buildLeg(legL, 'L', Lloop), Rtop = buildLeg(legR, 'R', Rloop);

    // ── Close the crotch NOTCH between the two thigh-top inner edges (mirror the body's crotch bridge) ──
    const Lin = [Ltop[0], Ltop[1], Ltop[2], Ltop[3], Ltop[4]];          // frontC, cf, cm, cb, backC (L)
    const Rin = [Rtop[0], Rtop[15], Rtop[14], Rtop[13], Rtop[12]];      // frontC, cf, cm, cb, backC (R)
    ac.idx.push(pb[6], Lin[0], Rin[0]);                                 // front-top under the shared front-pelvis vert
    ac.idx.push(pb[18], Rin[4], Lin[4]);                                // back-top
    for (let i = 0; i < 4; i++) { ac.idx.push(Lin[i], Lin[i + 1], Rin[i + 1]); ac.idx.push(Lin[i], Rin[i + 1], Rin[i]); }
    return true;
}

/** UNDERPANTS = SKIN-TIGHT short SHORTS (briefs → boxers). PREFERRED path: the body's lower-body surface offset
 *  outward (`buildUnderpantsOffset`) → IS the skin + 1mm, can't clip. Fallback: the old scalar-tube + conform. */
export function generateUnderpants(fit: BodyFit, p: UnderpantsParams) {
    const ac = newAc();
    if (buildUnderpantsOffset(ac, fit, p, BASE_GAP)) return finish(ac);   // ← the real fix (offset-surface)
    // Fallback (a non-procedural body with no captured surface): the old scalar-tube shorts + both-way conform.
    const bp: BottomParams = {
        slot: 'bottom', bottomStyle: 'shorts', waistWidth: 0.58, waistHeight: p.waistHeight,
        length: 0.04 + 0.32 * Math.max(0, Math.min(1, p.legExtend)),  // brief … boxer (mid-thigh)
        flare: 0, legWidth: 1.0, stack: 0, cuffTaper: 0, thickness: BASE_GAP,
        baseColor: p.baseColor, trimColor: p.trimColor, gradient: p.gradient, trimWidth: p.trimWidth, chunkiness: p.chunkiness,
    };
    const rings = 4 + Math.round(Math.max(0, Math.min(1, p.chunkiness)) * 4);
    buildLegs(ac, fit, bp, rings, null);
    if (fit.body) conformBaseLayer(ac, fit);
    return finish(ac);
}

export function generateSock(fit: BodyFit, p: SockParams) {
    const ac = newAc();
    const rings = 7 + Math.round(Math.max(0, Math.min(1, p.chunkiness)) * 6);   // denser foot Z-slices → the de-collision hugs the foot, no balloon
    const SOCK_GAP = 0.001;                       // socks HUG — a much tighter floor than MIN_GAP (looseness 0 = skin-tight, not a 3mm gap)
    const th = Math.max(SOCK_GAP, p.thickness);
    for (const s of ['L', 'R'] as const) {
        const foot = fit.joints['foot_' + s];
        if (!foot) continue;
        ac.island = s === 'L' ? GARMENT_IS.legL : GARMENT_IS.legR;
        const j = foot.idx;
        let box = footBox(fit.body, j);
        if (!box) {                                          // no body mesh → derive from the foot joint radius
            const lt = (foot.radius || 0.0015) / 0.04, f = foot.pos;
            box = { minX: f[0]-0.046*lt, maxX: f[0]+0.046*lt, minY: f[1]-0.052*lt, maxY: f[1]+0.012*lt, minZ: f[2]-0.056*lt, maxZ: f[2]+0.14*lt };
        }
        const cx = (box.minX + box.maxX) * 0.5;
        const footW = box.maxX - box.minX;
        const footH = box.maxY - box.minY;
        // The foot-JOINT bbox runs up the ANKLE (foot weights extend past it), so box height ≈ 2× the real foot —
        // an ellipse THAT tall reads as a bulbous BALL. Cap the cover at a realistic INSTEP height (the LEG part
        // takes over above it). Size the ellipse to the ACTUAL foot + the thin gap so it's skin-tight WITHOUT the
        // de-collision (which made the low-poly foot LUMPY). Slightly loose at the narrow heel/toe — fine (and it's
        // inside the shoe anyway).
        const footThick = Math.min(footH, footW * 0.62);
        const footTopY = box.minY + footThick + th;
        const cenY = (box.minY + footTopY) * 0.5;
        const heelZ = box.minZ - th, toeZ = box.maxZ + th, span = (toeZ - heelZ) || 0.1;
        const arcs: number[][] = [];
        for (let i = 0; i <= rings; i++) {
            const t = i / rings;
            const z = heelZ + span * t;
            const toeT = Math.max(0, (t - 0.74) / 0.26);
            const rw = (footW * 0.5 + th) * (1 - toeT * 0.42);            // sized to the foot + gap (round toe)
            arcs.push(shoeArc(ac, cx, box.minY, box.minY - th, footTopY, z, rw, t, j, 0));
        }
        for (let i = 0; i < rings; i++) bandStrip(ac, arcs[i], arcs[i + 1]);
        capRing(ac, arcs[rings], [cx, cenY, toeZ + footThick * 0.3], j);    // toe
        capRing(ac, arcs[0],     [cx, cenY, heelZ - footThick * 0.18], j);  // heel
        buildSockLeg(ac, fit, s, box, cx, footTopY, th, p);                 // leg = the body's real rings offset out (skin-tight, clip-free)
    }
    // NO de-collision: the LEG is the body's real surface offset outward (buildSockLegOffset → can't clip) and the
    // FOOT ellipse is already sized to the foot + gap. Running the shrink-wrap here only re-introduced the low-poly
    // LUMPINESS it caused before. Both pieces are skin-tight by construction.
    return finish(ac);
}
