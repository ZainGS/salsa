// ── World generation — PEDESTRIAN MANNEQUIN KIT ─────────────────────────────────────────────────
// The city's crowd, modelled on Persona 5's background NPCs: FACELESS (plain pale skin, no features) but otherwise
// realistically built at medium poly — smooth rounded lofts (no faceting), believable anatomy (a neck, sloping
// shoulders, a waist and hips, knees, calves, slim ankles, hands with a thumb), fitted clothes with real silhouettes
// (shirt collars, lapels + tie, sleeves that stop short of the wrist or short sleeves, A-line / pencil / pleated
// skirts with a flared hem, trousers that break over the shoe, coats, yukata with wide sleeves), hair with volume
// and a clean shape (short cuts, bobs, ponytails, buns, long hair), real shoes (dress shoes, loafers, pumps,
// sneakers, geta) and accessories (shoulder bags, totes, briefcases, backpacks, open or CLOSED umbrellas).
// Proportions are adult: the hip at 53 % of height, the head ≈ 1/7.5 of height.
// They are shaded FLATTER than hero characters (PED_SHADE: a darker diffuse + an emissive lift → low light/shadow
// contrast) so the crowd reads as soft colour blocks. Authored in REAL METRES in a person-local frame
//   +X = forward (the way they face / walk) · +Y = up · +Z = their left-to-right lateral axis
// and mapped into the world by a (base, forward, units-per-metre) transform. The SAME recipe feeds the baked static
// crowd (pedestrians.ts, merged per colour) and the instanced walkers (traffic.ts, one archetype geometry per part:
// rigid body + two thighs + two shins (knee bend) + optional shoes + up to two swinging arms + hands).
//
// Limbs are 2-bone chains: arms are solved by a small analytic IK (shoulder → elbow → wrist, fixed bone lengths)
// toward a per-HOLD wrist target, legs by (hip angle, knee flex) so a pose can bend the knee, lift a heel, strike
// with the heel, or cross a foot back against a wall. A stance's lowest foot point sets how far the body sinks.
//
// Palette: Persona-grade streets are mostly navy / black / charcoal / grey suits and uniforms, white shirts, beige and
// camel, a few pastels and muted accents — weighted so a crowd reads as a real Tokyo pavement, not a bag of sweets.

import { Accum3D } from './meshbuild';
import { hash2 } from './util';
import type { V2 } from './types';

type V3 = [number, number, number];
export type RGB = [number, number, number];

/** Named palette — static-crowd layers merge per entry (`world:ped-<name>`). Muted, realistic. */
export const PED_PALETTE: Record<string, RGB> = {
    navy: [0.12, 0.14, 0.24], charcoal: [0.19, 0.19, 0.21], black: [0.075, 0.075, 0.085], grey: [0.45, 0.46, 0.48],
    shirt: [0.88, 0.88, 0.89], beige: [0.74, 0.67, 0.56], khaki: [0.52, 0.48, 0.38], denim: [0.25, 0.32, 0.45],
    camel: [0.62, 0.49, 0.35], brown: [0.32, 0.23, 0.17], red: [0.60, 0.20, 0.20], mustard: [0.72, 0.58, 0.28],
    teal: [0.20, 0.38, 0.40], cream: [0.90, 0.87, 0.79], blush: [0.84, 0.66, 0.66], olive: [0.35, 0.37, 0.25],
    tights: [0.13, 0.12, 0.14], worker: [0.24, 0.33, 0.47],
    sky: [0.62, 0.70, 0.80], sage: [0.58, 0.64, 0.54], oat: [0.80, 0.76, 0.67],
    skin: [0.90, 0.77, 0.66], hairBlack: [0.06, 0.055, 0.055], hairBrown: [0.26, 0.17, 0.11], hairGrey: [0.62, 0.62, 0.63],
    hairTea: [0.46, 0.30, 0.17],
    vinyl: [0.84, 0.88, 0.90], umbNavy: [0.13, 0.16, 0.28], umbRed: [0.62, 0.15, 0.16],
};
export type PedColor = keyof typeof PED_PALETTE;

/** FLAT crowd shading (Persona's background NPCs read flatter than the heroes). Every crowd layer's colour is scaled by
 *  `diffuse` and the scene's glow pass gives it an emissive of that (darker) colour × `emissive` (day) … `emissiveNight`
 *  — output ≈ colour · diffuse · (light + emissive): about the same brightness in sun, but a shadowed side only drops to
 *  ~half instead of ~quarter, so the crowd sits back as soft colour blocks. No shader or flag bit — it is the city's
 *  existing per-layer emissive, keyed on the `world:ped-` / `world:traffic-walker` names (world-manager GLOW). */
export const PED_SHADE = { diffuse: 0.6, emissive: 0.62, emissiveNight: 0.24 } as const;
/** A crowd layer's material colour (the palette colour dimmed by PED_SHADE.diffuse). */
export function pedShadeColor(c: RGB): RGB {
    const d = PED_SHADE.diffuse;
    return [c[0] * d, c[1] * d, c[2] * d];
}

export type HairStyle = 'short' | 'bob' | 'long' | 'bun' | 'pony';
export type BagKind = 'none' | 'briefcase' | 'shoulder' | 'backpack' | 'tote';
export type HatKind = 'none' | 'cap' | 'brim';
/** Top garment cut: `jacket` / `top` end at the hips, `coat` at the knee, `robe` (yukata) at the ankle. */
export type Garment = 'jacket' | 'top' | 'coat' | 'robe';
/** Sleeve cut: long (stops just short of the wrist) · short (blouse / tee — bare forearm) · wide (yukata). */
export type SleeveCut = 'long' | 'short' | 'wide';
/** Skirt cut: A-line (knee) · pencil (straight, below the knee) · pleat (school, above the knee) · flare (midi). */
export type SkirtCut = 'aline' | 'pencil' | 'pleat' | 'flare';
export type ShoeKind = 'dress' | 'loafer' | 'pump' | 'sneaker' | 'geta';
/** Standing idle · seated · waiting with hands clasped · looking at a phone · mid-stride (static strollers) · riding ·
 *  weight on one leg (hand in a pocket / on the bag strap) · talking (a hand gesturing) · leaning back on a wall ·
 *  leaning over a railing (hands on the rail). */
export type Pose = 'stand' | 'sit' | 'clasp' | 'phone' | 'stride' | 'ride' | 'rest' | 'talk' | 'lean' | 'rail';

/** Everything that makes one person look like one person. Colours are PED_PALETTE names. */
export interface PersonLook {
    top: PedColor; legs: PedColor; shoes: PedColor; skirt: PedColor | null;
    hair: PedColor; hairStyle: HairStyle;
    bag: BagKind; bagColor: PedColor;
    heightM: number;   // standing height
    build: number;     // width multiplier (0.9 slight … 1.1 broad)
    /** Accent collar / shirt front on the top (a salaryman's shirt, the sailor collar) — or the OBI on a yukata. */
    collar: PedColor | null;
    /** Female figure: narrower shoulders + waist, a touch more hip. */
    fem: boolean;
    garment: Garment;
    hat: HatKind; hatColor: PedColor;
    /** Walks along reading a phone (walkers; the static crowd picks its pose per person). */
    phone: boolean;
    sleeve: SleeveCut;
    skirtCut: SkirtCut;
    shoe: ShoeKind;
    /** Suit jacket worn open (the shirt shows down to the hem). */
    open: boolean;
}

interface Archetype { name: string; weight: number; make(h: (k: number) => number): PersonLook; }
const pick = <T>(arr: readonly T[], r: number): T => arr[Math.min(arr.length - 1, (r * arr.length) | 0)];
type LookBase = Omit<PersonLook, 'fem' | 'garment' | 'hat' | 'hatColor' | 'phone' | 'sleeve' | 'skirtCut' | 'shoe' | 'open'> & Partial<PersonLook>;
const look = (b: LookBase): PersonLook => ({
    fem: false, garment: 'jacket', hat: 'none', hatColor: 'black', phone: false, sleeve: 'long', skirtCut: 'aline',
    shoe: b.shoes === 'shirt' ? 'sneaker' : 'dress', open: false, ...b,
});

/** ~12 street archetypes. `make` draws its variety from a per-person hash stream `h(k)`. */
export const ARCHETYPES: readonly Archetype[] = [
    { name: 'salaryman', weight: 16, make: h => { const suit = pick(['navy', 'charcoal', 'black', 'grey', 'navy'] as const, h(1)); return look({
        top: suit, legs: h(9) < 0.8 ? suit : 'charcoal', shoes: 'black', skirt: null,
        hair: h(2) < 0.85 ? 'hairBlack' : 'hairGrey', hairStyle: 'short', bag: h(3) < 0.55 ? 'briefcase' : 'none', bagColor: 'black',
        heightM: 1.67 + h(4) * 0.14, build: 1.0 + h(5) * 0.06, collar: 'shirt', phone: h(11) < 0.25, open: h(13) < 0.3 }); } },
    { name: 'office', weight: 10, make: h => { const top = pick(['shirt', 'charcoal', 'navy', 'beige', 'oat', 'sky'] as const, h(1)); return look({
        top, legs: 'tights', shoes: 'black', skirt: pick(['black', 'charcoal', 'navy', 'grey'] as const, h(6)),
        hair: pick(['hairBlack', 'hairBrown', 'hairTea'] as const, h(2)), hairStyle: pick(['bob', 'long', 'bun', 'pony'] as const, h(7)),
        bag: h(3) < 0.7 ? 'shoulder' : 'tote', bagColor: pick(['black', 'brown', 'camel'] as const, h(8)),
        heightM: 1.55 + h(4) * 0.12, build: 0.92 + h(5) * 0.05, collar: top === 'shirt' ? null : 'shirt', fem: true, garment: 'top', phone: h(11) < 0.3,
        sleeve: top === 'shirt' || top === 'sky' ? (h(13) < 0.6 ? 'short' : 'long') : 'long', skirtCut: h(14) < 0.55 ? 'pencil' : 'aline', shoe: 'pump' }); } },
    { name: 'cardigan', weight: 6, make: h => { const fem = h(10) < 0.7; return look({
        top: pick(['oat', 'beige', 'grey', 'sage', 'cream'] as const, h(1)), legs: fem ? 'tights' : pick(['khaki', 'charcoal', 'denim'] as const, h(6)),
        shoes: pick(['brown', 'black'] as const, h(8)), skirt: fem ? pick(['navy', 'khaki', 'brown', 'charcoal'] as const, h(6)) : null,
        hair: pick(['hairBlack', 'hairBrown', 'hairTea'] as const, h(2)), hairStyle: fem ? pick(['bob', 'long', 'bun', 'pony'] as const, h(7)) : 'short',
        bag: h(3) < 0.5 ? 'tote' : 'shoulder', bagColor: pick(['camel', 'brown', 'cream'] as const, h(9)),
        heightM: (fem ? 1.54 : 1.64) + h(4) * 0.13, build: (fem ? 0.92 : 0.98) + h(5) * 0.06, collar: 'shirt', fem, garment: 'top', phone: h(11) < 0.25,
        skirtCut: h(14) < 0.5 ? 'flare' : 'aline', shoe: fem ? 'loafer' : 'dress' }); } },
    { name: 'gakuran', weight: 8, make: h => look({ top: 'black', legs: 'black', shoes: 'black', skirt: null,
        hair: 'hairBlack', hairStyle: 'short', bag: h(3) < 0.7 ? 'backpack' : 'shoulder', bagColor: h(8) < 0.5 ? 'black' : 'navy',
        heightM: 1.62 + h(4) * 0.13, build: 0.95 + h(5) * 0.05, collar: null, phone: h(11) < 0.3, shoe: h(13) < 0.5 ? 'loafer' : 'dress' }) },
    { name: 'sailor', weight: 8, make: h => { const summer = h(1) < 0.5; return look({ top: summer ? 'shirt' : 'navy', legs: h(9) < 0.6 ? 'tights' : 'skin', shoes: 'brown', skirt: 'navy',
        hair: h(2) < 0.8 ? 'hairBlack' : 'hairBrown', hairStyle: pick(['bob', 'long', 'pony', 'bun'] as const, h(7)), bag: 'shoulder', bagColor: 'navy',
        heightM: 1.53 + h(4) * 0.1, build: 0.9 + h(5) * 0.05, collar: summer ? 'navy' : 'shirt', fem: true, garment: 'top', phone: h(11) < 0.3,
        sleeve: summer ? 'short' : 'long', skirtCut: 'pleat', shoe: 'loafer' }); } },
    { name: 'casual', weight: 9, make: h => { const bag: BagKind = h(3) < 0.4 ? 'backpack' : 'none'; return look({
        top: pick(['grey', 'black', 'olive', 'cream', 'sky', 'sage'] as const, h(1)), legs: pick(['denim', 'black', 'khaki'] as const, h(6)), shoes: pick(['shirt', 'black'] as const, h(8)), skirt: null,
        hair: pick(['hairBlack', 'hairBrown', 'hairTea'] as const, h(2)), hairStyle: 'short', bag, bagColor: 'black',
        heightM: 1.63 + h(4) * 0.15, build: 0.96 + h(5) * 0.08, collar: null, garment: 'top',
        hat: h(12) < 0.3 ? 'cap' : 'none', hatColor: 'black', phone: h(11) < 0.3, sleeve: h(13) < 0.5 ? 'short' : 'long', shoe: 'sneaker' }); } },
    { name: 'accent', weight: 4, make: h => { const fem = h(9) < 0.5; return look({
        top: pick(['red', 'mustard', 'teal', 'blush'] as const, h(1)), legs: fem ? 'tights' : pick(['black', 'denim', 'charcoal'] as const, h(6)), shoes: 'black', skirt: fem ? 'black' : null,
        hair: pick(['hairBlack', 'hairTea', 'hairBrown'] as const, h(2)), hairStyle: fem ? pick(['bob', 'long', 'pony'] as const, h(7)) : 'short', bag: h(3) < 0.5 ? 'tote' : 'none', bagColor: 'cream',
        heightM: (fem ? 1.55 : 1.64) + h(4) * 0.14, build: 0.93 + h(5) * 0.08, collar: null, fem, garment: 'top', shoe: fem ? 'pump' : 'sneaker' }); } },
    { name: 'elder', weight: 6, make: h => { const fem = h(9) < 0.45, bag: BagKind = h(3) < 0.4 ? 'tote' : 'none'; return look({
        top: pick(['beige', 'camel', 'grey', 'olive', 'oat'] as const, h(1)), legs: fem ? 'tights' : pick(['brown', 'grey', 'khaki'] as const, h(6)), shoes: 'brown', skirt: fem ? pick(['brown', 'navy', 'grey'] as const, h(6)) : null,
        hair: 'hairGrey', hairStyle: fem ? 'bun' : 'short', bag, bagColor: 'brown',
        heightM: (fem ? 1.49 : 1.58) + h(4) * 0.12, build: 0.96 + h(5) * 0.08, collar: null, fem, garment: 'jacket',
        hat: h(12) < 0.45 ? 'brim' : 'none', hatColor: bag !== 'none' ? 'brown' : 'beige', skirtCut: 'flare', shoe: 'loafer' }); } },
    { name: 'student', weight: 8, make: h => look({ top: pick(['black', 'navy', 'khaki', 'denim', 'grey'] as const, h(1)), legs: pick(['khaki', 'black', 'denim'] as const, h(6)), shoes: pick(['shirt', 'black', 'brown'] as const, h(8)), skirt: null,
        hair: pick(['hairBlack', 'hairBrown'] as const, h(2)), hairStyle: 'short', bag: h(3) < 0.6 ? 'backpack' : 'shoulder', bagColor: pick(['black', 'olive', 'navy'] as const, h(10)),
        heightM: 1.64 + h(4) * 0.15, build: 0.95 + h(5) * 0.07, collar: null, garment: 'top', phone: h(11) < 0.35,
        hat: h(12) < 0.15 ? 'cap' : 'none', hatColor: 'navy', sleeve: h(13) < 0.3 ? 'short' : 'long', shoe: 'sneaker' }) },
    { name: 'parent', weight: 6, make: h => look({ top: pick(['cream', 'blush', 'sky', 'beige', 'sage'] as const, h(1)), legs: 'tights', shoes: 'brown', skirt: pick(['brown', 'navy', 'khaki'] as const, h(6)),
        hair: pick(['hairBlack', 'hairBrown', 'hairTea'] as const, h(2)), hairStyle: pick(['bob', 'bun', 'long', 'pony'] as const, h(7)), bag: 'tote', bagColor: pick(['cream', 'camel'] as const, h(3)),
        heightM: 1.54 + h(4) * 0.11, build: 0.94 + h(5) * 0.05, collar: null, fem: true, garment: 'top', phone: h(11) < 0.2,
        sleeve: h(13) < 0.4 ? 'short' : 'long', skirtCut: 'flare', shoe: 'loafer' }) },
    { name: 'worker', weight: 5, make: h => { const uni = h(1) < 0.6; return look({ top: uni ? 'worker' : 'grey', legs: uni ? 'worker' : 'charcoal', shoes: 'black', skirt: null,
        hair: 'hairBlack', hairStyle: 'short', bag: 'none', bagColor: 'black',
        heightM: 1.64 + h(4) * 0.13, build: 1.02 + h(5) * 0.08, collar: null, garment: 'top',
        hat: h(12) < 0.6 ? 'cap' : 'none', hatColor: uni ? 'worker' : 'grey', shoe: 'sneaker' }); } },
    { name: 'coat', weight: 7, make: h => { const fem = h(9) < 0.4; return look({
        top: pick(['camel', 'black', 'charcoal', 'navy', 'beige'] as const, h(1)), legs: fem ? 'tights' : pick(['black', 'charcoal', 'denim'] as const, h(6)), shoes: 'black', skirt: null,
        hair: pick(['hairBlack', 'hairBrown'] as const, h(2)), hairStyle: fem ? pick(['bob', 'long', 'pony'] as const, h(7)) : 'short', bag: h(3) < 0.5 ? 'shoulder' : 'none', bagColor: 'black',
        heightM: (fem ? 1.56 : 1.65) + h(4) * 0.14, build: 1.0 + h(5) * 0.06, collar: null, fem, garment: 'coat', phone: h(11) < 0.2, shoe: fem ? 'pump' : 'dress' }); } },
    { name: 'yukata', weight: 3, make: h => { const fem = h(9) < 0.75, top = pick(['navy', 'blush', 'sky', 'cream'] as const, h(1)); return look({
        top, legs: 'skin', shoes: 'brown', skirt: null,
        hair: pick(['hairBlack', 'hairBrown'] as const, h(2)), hairStyle: fem ? pick(['bun', 'bun', 'bob'] as const, h(7)) : 'short',
        bag: 'none', bagColor: 'cream', heightM: (fem ? 1.54 : 1.66) + h(4) * 0.12, build: 0.94 + h(5) * 0.06,
        collar: top === 'navy' ? pick(['red', 'mustard', 'cream'] as const, h(6)) : pick(['navy', 'red', 'mustard'] as const, h(6)), fem, garment: 'robe',
        sleeve: 'wide', shoe: 'geta' }); } },
];
const TOTAL_W = ARCHETYPES.reduce((n, a) => n + a.weight, 0);

/** Pick an archetype index from a 0..1 roll (weighted). */
export function archetypeIndex(r: number): number {
    let acc = 0;
    for (let i = 0; i < ARCHETYPES.length; i++) { acc += ARCHETYPES[i].weight / TOTAL_W; if (r < acc) return i; }
    return ARCHETYPES.length - 1;
}

/** A deterministic look for (archetype, variant seed). */
export function personLook(arch: number, seed: number): PersonLook {
    const a = ARCHETYPES[((arch % ARCHETYPES.length) + ARCHETYPES.length) % ARCHETYPES.length];
    return a.make(k => hash2(seed | 0, k, 0x5e0a1 + arch * 31));
}

// ── Transform + vector helpers ───────────────────────────────────────────────────────────────────
/** Person-local metres → world: `o` + (f·x + c·z)·u + up·y·u, with c = (−f.z, f.x) (matches Mesh3D rotateY).
 *  `lean` (optional) tilts the local geometry first, in order: each entry rotates every point about the local Z axis
 *  through (0, y, 0) so that points ABOVE it move forward by `a` radians (negative = backward). The upper body leans
 *  over a railing about the hip; a wall-leaner tilts back about the feet. */
export interface PersonXf { o: V3; f: V2; u: number; lean?: { a: number; y: number }[]; }
const leanPt = (L: { a: number; y: number }[] | undefined, x: number, y: number): [number, number] => {
    if (L) for (const l of L) {
        const c = Math.cos(l.a), s = Math.sin(l.a), dy = y - l.y;
        const nx = x * c + dy * s; y = l.y - x * s + dy * c; x = nx;
    }
    return [x, y];
};
const P = (T: PersonXf, x: number, y: number, z: number): V3 => {
    if (T.lean) [x, y] = leanPt(T.lean, x, y);
    const cx = -T.f[1], cz = T.f[0];
    return [T.o[0] + (T.f[0] * x + cx * z) * T.u, T.o[1] + y * T.u, T.o[2] + (T.f[1] * x + cz * z) * T.u];
};
const Nv = (T: PersonXf, x: number, y: number, z: number): V3 => {
    if (T.lean) for (const l of T.lean) { const c = Math.cos(l.a), s = Math.sin(l.a), nx = x * c + y * s; y = -x * s + y * c; x = nx; }
    const cx = -T.f[1], cz = T.f[0];
    const n: V3 = [T.f[0] * x + cx * z, y, T.f[1] * x + cz * z];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
};
/** Undo a PersonXf's lean (a world-local target → the leaned frame's coordinates, for the arm IK). */
const unlean = (L: { a: number; y: number }[] | undefined, p: V3): V3 => {
    if (!L) return p;
    let x = p[0], y = p[1];
    for (let i = L.length - 1; i >= 0; i--) {
        const l = L[i], c = Math.cos(l.a), s = Math.sin(l.a), dy = y - l.y;
        const nx = x * c - dy * s; y = l.y + x * s + dy * c; x = nx;
    }
    return [x, y, p[2]];
};
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Rotate local point `p` about `pv` in the forward/up plane (about local Z) by `a` — positive swings a point BELOW
 *  the pivot forward (+X). Leg/arm swing (walkers swing whole meshes the same way). */
function rotZ(p: V3, pv: V3, a: number): V3 {
    if (!a) return p;
    const dx = p[0] - pv[0], dy = p[1] - pv[1], c = Math.cos(a), s = Math.sin(a);
    return [pv[0] + dx * c - dy * s, pv[1] + dx * s + dy * c, p[2]];
}

// ── Primitives ───────────────────────────────────────────────────────────────────────────────────
/** Tessellation for one detail level (`PersonOpts.lod`): 0 = HIGH (walkers, the static crowd's NEAR twin, the live
 *  near-field crowd) · 1 = the cheaper FAR twin of the static crowd. Every shape is built from the same profile
 *  at either level; HIGH just samples it finer (more ring sides, Hermite-resampled profiles, subdivided limb paths)
 *  and adds the small reads that vanish at distance (fingers + thumb, ears, hem / cuff turn-backs, lapels, the
 *  hair's part line and bangs). */
export interface Detail {
    torso: number; tsub: number;      // torso / skirt ring sides · profile resampling (rings per original span)
    limb: number; lsub: number;       // limb ring sides · limb path subdivision
    head: number; hsub: number;       // head ring sides · head profile resampling
    hair: number; hairRings: number;  // hair shell azimuth segments · latitude bands
    shoe: number;                     // shoe ring sides
    small: number;                    // small round parts (buns, bags, straps' pads, umbrella shafts)
    fine: boolean;                    // fingers / thumbs / ears / hem lips / lapels / part lines
    tiny?: boolean;                   // P9 XLO: hands as one blob, the neck at the head's side count
}
const DETAIL_HI: Detail = { torso: 14, tsub: 1.5, limb: 8, lsub: 2, head: 16, hsub: 1.4, hair: 20, hairRings: 6, shoe: 8, small: 8, fine: true };
const DETAIL_LO: Detail = { torso: 10, tsub: 1, limb: 6, lsub: 1, head: 10, hsub: 1, hair: 10, hairRings: 4, shoe: 6, small: 6, fine: false };
/** P9 XLO (lod 2): the static crowd's third, cheapest tier, past ~100 m (a person is ~15 px tall there). */
const DETAIL_XLO: Detail = { torso: 5, tsub: 0.5, limb: 3, lsub: 1, head: 5, hsub: 0.5, hair: 5, hairRings: 2, shoe: 3, small: 3, fine: false, tiny: true };
export const detailFor = (lod: number): Detail => lod === 2 ? DETAIL_XLO : lod ? DETAIL_LO : DETAIL_HI;

/** A horizontal loft ring: centre (x, y, z), semi-axes rx (fwd) / rz (lateral) and optional SHAPE terms — `sq`
 *  squares the section off (a superellipse: shoulders, a boxy jacket), `fb` / `bb` push the FRONT / BACK half out
 *  (a chest or bust, shoulder blades, the back of the skull; negative pulls in — the jaw under the ear). `t` =
 *  the ring's position in the ORIGINAL (pre-resampling) profile, for mods keyed to a profile span. */
interface Ring { x: number; y: number; z: number; rx: number; rz: number; sq?: number; fb?: number; bb?: number; t?: number }

/** Resample a loft profile SMOOTHLY: a cubic Hermite through every ring as a function of height (tangents = the
 *  neighbours' finite differences), with ~`sub` new rings per average span (long spans get more, short ones fewer).
 *  The original rings are kept exactly (the hem / waist / shoulder heights are unchanged). A profile whose heights
 *  do not strictly increase is returned as is. */
function smoothRings(r: Ring[], sub: number): Ring[] {
    const n = r.length;
    const plain = (): Ring[] => r.map((q, k) => ({ ...q, t: q.t ?? k }));
    // P9 XLO (0 < sub < 1): every other ring (both ends kept) — the cheapest crowd tier's coarser loft.
    if (sub > 0 && sub < 1 && n > 3) return plain().filter((_, k) => k === 0 || k === n - 1 || k % 2 === 0);
    if (sub <= 1 || n < 3) return plain();
    for (let k = 1; k < n; k++) if (!(r[k].y > r[k - 1].y)) return plain();
    const KEYS = ['x', 'z', 'rx', 'rz', 'sq', 'fb', 'bb'] as const;
    const val = (q: Ring, key: typeof KEYS[number]): number => (q[key] as number | undefined) ?? 0;
    const tan = (key: typeof KEYS[number], k: number): number => {
        const a = r[Math.max(0, k - 1)], b = r[Math.min(n - 1, k + 1)];
        return (val(b, key) - val(a, key)) / (b.y - a.y);
    };
    const avg = (r[n - 1].y - r[0].y) / (n - 1), out: Ring[] = [];
    for (let k = 0; k < n - 1; k++) {
        const A = r[k], B = r[k + 1], h = B.y - A.y;
        const m = Math.max(1, Math.min(sub * 2, Math.round(sub * h / avg)));
        out.push({ ...A, t: k });
        for (let s = 1; s < m; s++) {
            const t = s / m, t2 = t * t, t3 = t2 * t;
            const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
            const q: Ring = { x: 0, y: A.y + h * t, z: 0, rx: 0, rz: 0, t: k + t };
            for (const key of KEYS) (q as unknown as Record<string, number>)[key] = h00 * val(A, key) + h10 * h * tan(key, k) + h01 * val(B, key) + h11 * h * tan(key, k + 1);
            const lo = (key: 'rx' | 'rz'): number => Math.min(A[key], B[key]) * 0.7;
            q.rx = Math.max(q.rx, lo('rx'), 1e-4); q.rz = Math.max(q.rz, lo('rz'), 1e-4);
            out.push(q);
        }
    }
    out.push({ ...r[n - 1], t: n - 1 });
    return out;
}

/** Emit a quad GRID of local points (rows × cols, cols wrap around) with SMOOTH numeric normals: each vertex's
 *  normal is the cross of its row-to-row and around-the-ring tangents (central differences), oriented by `out`
 *  (+1 = cross(dRow, dCol), −1 = the reverse) — correct for any section (superellipse, bulges, pleats, lips, a hair
 *  shell's per-azimuth drop) without an analytic model. A degenerate tangent falls back to `fb(k, i)`. Returns the
 *  vertex index rows. */
function gridSurface(acc: Accum3D, T: PersonXf, rows: V3[][], out: 1 | -1, fb: (k: number, i: number) => V3): number[][] {
    const nr = rows.length, nc = rows[0].length, idx: number[][] = [];
    for (let k = 0; k < nr; k++) {
        const up = rows[Math.min(nr - 1, k + 1)], dn = rows[Math.max(0, k - 1)], row = rows[k], ir: number[] = [];
        for (let i = 0; i < nc; i++) {
            const a = row[(i + 1) % nc], b = row[(i - 1 + nc) % nc], u = up[i], d = dn[i];   // (inlined: this is the hot loop)
            const cx = a[0] - b[0], cy = a[1] - b[1], cz = a[2] - b[2], rx = u[0] - d[0], ry = u[1] - d[1], rz = u[2] - d[2];
            let nx = ry * cz - rz * cy, ny = rz * cx - rx * cz, nz = rx * cy - ry * cx;
            const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (!(l > 1e-12)) { const f = fb(k, i); nx = f[0]; ny = f[1]; nz = f[2]; } else { const s = out / l; nx *= s; ny *= s; nz *= s; }
            ir.push(acc.vertex(P(T, row[i][0], row[i][1], row[i][2]), Nv(T, nx, ny, nz), i / nc, k / Math.max(1, nr - 1)));
        }
        idx.push(ir);
    }
    for (let k = 0; k < nr - 1; k++) {
        const A = idx[k], B = idx[k + 1];
        for (let i = 0; i < nc; i++) { const j = (i + 1) % nc; acc.triangle(A[i], A[j], B[j]); acc.triangle(A[i], B[j], B[i]); }
    }
    return idx;
}

/** Elliptic LOFT through a list of HORIZONTAL rings — torsos, skirts, robes, the head, hats, backpacks. `sub`
 *  resamples the profile smoothly (smoothRings); `lipBot` / `lipTop` turn the open bottom / top edge BACK inside by
 *  that fraction of the radius over `lipH` metres (a hem / collar with thickness instead of a paper edge). `mod(i, t)`
 *  scales ring vertex i radially (`t` = position in the original profile — skirt pleats). Smooth numeric normals. */
function loft(acc: Accum3D, T: PersonXf, rings0: Ring[], sides: number, capTop: boolean, capBot: boolean, mod?: (i: number, t: number) => number,
    o: { sub?: number; lipBot?: number; lipTop?: number; lipH?: number } = {}): void {
    let rings = o.sub ? smoothRings(rings0, o.sub) : rings0.map((q, k) => ({ ...q, t: q.t ?? k }));
    const lh = o.lipH ?? 0.012;
    if (o.lipBot) { const f = rings[0]; rings = [{ ...f, y: f.y + lh, rx: f.rx * (1 - o.lipBot), rz: f.rz * (1 - o.lipBot) }, ...rings]; }
    if (o.lipTop) { const f = rings[rings.length - 1]; rings = [...rings, { ...f, y: f.y - lh, rx: f.rx * (1 - o.lipTop), rz: f.rz * (1 - o.lipTop) }]; }
    const pos = rings.map((r) => {
        const row: V3[] = [];
        const e = 2 + 2.5 * (r.sq ?? 0);
        for (let i = 0; i < sides; i++) {
            const an = (i / sides) * Math.PI * 2, ca = Math.cos(an), sa = Math.sin(an);
            const s = r.sq ? Math.pow(Math.pow(Math.abs(ca), e) + Math.pow(Math.abs(sa), e), -1 / e) : 1;
            let px = ca * s * r.rx;
            const pz = sa * s * r.rz;
            const bulge = ca > 0 ? (r.fb ?? 0) : (r.bb ?? 0);
            if (bulge) px *= 1 + bulge * ca * ca;
            const m = mod ? mod(i, r.t ?? 0) : 1;
            row.push([r.x + px * m, r.y, r.z + pz * m]);
        }
        return row;
    });
    const idx = gridSurface(acc, T, pos, 1, (_k, i) => { const an = (i / sides) * Math.PI * 2; return [Math.cos(an), 0, Math.sin(an)]; });
    const cap = (row: number[], r: Ring, up: number): void => {
        const c = acc.vertex(P(T, r.x, r.y + up * Math.min(r.rx, r.rz) * 0.35, r.z), Nv(T, 0, up, 0), 0.5, 0.5);
        for (let i = 0; i < sides; i++) { const j = (i + 1) % sides; if (up > 0) acc.triangle(c, row[j], row[i]); else acc.triangle(c, row[i], row[j]); }
    };
    if (capTop && !o.lipTop) cap(idx[idx.length - 1], rings[rings.length - 1], 1);
    if (capBot && !o.lipBot) cap(idx[0], rings[0], -1);
}

/** Catmull-Rom subdivision of a polyline + its per-point radii (`sub` pieces per span) — a knee / elbow bend or a
 *  ponytail's fall becomes a smooth curve instead of a kink. */
function subPath(pts: V3[], rs: (number[] | null)[], sub: number): { pts: V3[]; rs: (number[] | null)[] } {
    const n = pts.length;
    if (sub <= 1 || n < 2) return { pts, rs };
    const P2: V3[] = [], R2: (number[] | null)[] = rs.map((r) => r ? [] : null);
    const g = (k: number): V3 => pts[Math.max(0, Math.min(n - 1, k))];
    const cr = (a: number, b: number, c: number, d: number, t: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
    for (let k = 0; k < n - 1; k++) {
        const a = g(k - 1), b = g(k), c = g(k + 1), d = g(k + 2);
        for (let s = 0; s < sub; s++) {
            const t = s / sub;
            P2.push(s ? [cr(a[0], b[0], c[0], d[0], t), cr(a[1], b[1], c[1], d[1], t), cr(a[2], b[2], c[2], d[2], t)] : b);
            rs.forEach((r, ri) => {
                if (!r) return;
                const ra = r[Math.max(0, k - 1)], rb = r[k], rc = r[k + 1], rd = r[Math.min(n - 1, k + 2)];
                R2[ri]!.push(s ? Math.max(Math.min(rb, rc) * 0.8, cr(ra, rb, rc, rd, t)) : rb);
            });
        }
    }
    P2.push(pts[n - 1]);
    rs.forEach((r, ri) => { if (r) R2[ri]!.push(r[n - 1]); });
    return { pts: P2, rs: R2 };
}

/** A SWEEP through a polyline of local points with elliptic cross-sections (radius `ra` along the ring's "up" axis —
 *  `ref` projected off the path tangent — and `rb` across it; `down` = a different radius for the LOWER half of the
 *  "up" axis: a flat-soled shoe, a D-shaped bag). Limbs (thigh → knee → calf → ankle, shoulder → elbow → wrist),
 *  shoes (heel → ball → toe, `ref` = up), bag bodies, ponytails, closed umbrellas. `sub` = Catmull-Rom path
 *  subdivision; `lipB` turns the open far end back inside (a cuff / trouser hem with thickness). Smooth numeric
 *  normals; optional domed end caps. */
function sweep(acc: Accum3D, T: PersonXf, pts0: V3[], ra0: number[], rb0: number[] | null, sides: number,
    o: { ref?: V3; capA?: boolean; capB?: boolean; sub?: number; down?: number[]; lipB?: number } = {}): void {
    const sp = subPath(pts0, [ra0, rb0, o.down ?? null], o.sub ?? 1);
    let pts = sp.pts, ra = sp.rs[0]!, rB = sp.rs[1] ?? ra, dn = sp.rs[2];
    if (o.lipB && pts.length >= 2) {   // the turn-back: a ring just inside the open end
        const n0 = pts.length, t = norm3(sub3(pts[n0 - 1], pts[n0 - 2])), k = 1 - o.lipB;
        pts = [...pts, sub3(pts[n0 - 1], mul3(t, 0.006))];
        ra = [...ra, ra[n0 - 1] * k]; rB = [...rB, rB[n0 - 1] * k]; if (dn) dn = [...dn, dn[n0 - 1] * k];
    }
    const n = pts.length;
    const d0 = norm3(sub3(pts[n - 1], pts[0]));
    const ref: V3 = o.ref ?? (Math.abs(d0[1]) > 0.7 ? [1, 0, 0] : [0, 1, 0]);
    const rows: V3[][] = [], frames: { t: V3; u: V3; v: V3 }[] = [];
    for (let k = 0; k < n; k++) {
        const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
        const seg = sub3(b, a), sl = Math.hypot(seg[0], seg[1], seg[2]) || 1e-4;
        const t = mul3(seg, 1 / sl);
        let u = sub3(ref, mul3(t, dot3(ref, t)));
        if (Math.hypot(u[0], u[1], u[2]) < 1e-4) u = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
        u = norm3(u);
        const v = cross3(t, u);
        frames.push({ t, u, v });
        const row: V3[] = [];
        for (let i = 0; i < sides; i++) {
            const an = (i / sides) * Math.PI * 2, ca = Math.cos(an), sa = Math.sin(an);
            const rU = ca < 0 && dn ? dn[k] : ra[k];
            row.push(add3(pts[k], add3(mul3(u, ca * rU), mul3(v, sa * rB[k]))));
        }
        rows.push(row);
    }
    const idx = gridSurface(acc, T, rows, -1, (k, i) => {
        const an = (i / sides) * Math.PI * 2, f = frames[k];
        return norm3(add3(mul3(f.u, Math.cos(an)), mul3(f.v, Math.sin(an))));
    });
    const cap = (k: number, dir: number): void => {
        const f = frames[k], r = Math.min(ra[k], rB[k], dn ? dn[k] : Infinity);
        const c = add3(pts[k], mul3(f.t, dir * r * 0.6));
        const ci = acc.vertex(P(T, c[0], c[1], c[2]), Nv(T, f.t[0] * dir, f.t[1] * dir, f.t[2] * dir), 0.5, 0.5);
        const row = idx[k];
        for (let i = 0; i < sides; i++) { const j = (i + 1) % sides; if (dir > 0) acc.triangle(ci, row[i], row[j]); else acc.triangle(ci, row[j], row[i]); }
    };
    if (o.capA) cap(0, -1);
    if (o.capB && !o.lipB) cap(n - 1, 1);
}

/** An ORIENTED ELLIPSOID: semi-axis `ra` along unit `ax`, `rb` along `side` (orthogonalised), `rc` along ax × side.
 *  `rings` latitude bands pole to pole. Hands, thumbs, buns, ears. */
function oellip(acc: Accum3D, T: PersonXf, c: V3, ax: V3, side: V3, ra: number, rb: number, rc: number, segs: number, rings: number): void {
    const b = norm3(sub3(side, mul3(ax, dot3(side, ax)))), cc = cross3(ax, b);
    const pt = (lat: number, az: number): { p: V3; n: V3 } => {
        const sl = Math.sin(lat), cl = Math.cos(lat), ca = Math.cos(az), sa = Math.sin(az);
        const p = add3(c, add3(mul3(ax, sl * ra), add3(mul3(b, cl * ca * rb), mul3(cc, cl * sa * rc))));
        const n = norm3(add3(mul3(ax, sl / ra), add3(mul3(b, cl * ca / rb), mul3(cc, cl * sa / rc))));
        return { p, n };
    };
    const vtx = (q: { p: V3; n: V3 }, u: number, v: number): number => acc.vertex(P(T, q.p[0], q.p[1], q.p[2]), Nv(T, q.n[0], q.n[1], q.n[2]), u, v);
    const top = vtx(pt(Math.PI / 2, 0), 0.5, 0), bot = vtx(pt(-Math.PI / 2, 0), 0.5, 1);
    const rows: number[][] = [];
    for (let k = 1; k < rings; k++) {
        const lat = Math.PI / 2 - Math.PI * k / rings, row: number[] = [];
        for (let i = 0; i < segs; i++) row.push(vtx(pt(lat, (i / segs) * Math.PI * 2), i / segs, k / rings));
        rows.push(row);
    }
    for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; acc.triangle(top, rows[0][j], rows[0][i]); acc.triangle(bot, rows[rows.length - 1][i], rows[rows.length - 1][j]); }
    for (let k = 0; k < rows.length - 1; k++) {
        const A = rows[k], B = rows[k + 1];
        for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; acc.triangle(A[i], A[j], B[j]); acc.triangle(A[i], B[j], B[i]); }
    }
}

/** Oriented BOX in person-local metres (centre + half-extents along the local axes). Briefcases, the phone, a cap
 *  brim. `bevel` (m) chamfers every edge (a clean highlight instead of a cardboard edge). */
function box(acc: Accum3D, T: PersonXf, c: V3, hx: number, hy: number, hz: number, bevel = 0): void {
    let f: V3, up: V3, cz: V3;
    if (T.lean) { f = Nv(T, 1, 0, 0); up = Nv(T, 0, 1, 0); cz = Nv(T, 0, 0, 1); }   // (a leaned box: rotate its axes with the lean)
    else { f = [T.f[0], 0, T.f[1]]; up = [0, 1, 0]; cz = [-T.f[1], 0, T.f[0]]; }
    if (bevel > 0) acc.bevelBox(P(T, c[0], c[1], c[2]), f, up, cz, hx * T.u, hy * T.u, hz * T.u, bevel * T.u);
    else acc.obox(P(T, c[0], c[1], c[2]), f, up, cz, hx * T.u, hy * T.u, hz * T.u);
}

// ── The body ─────────────────────────────────────────────────────────────────────────────────────
/** Target layer for each body part — the static crowd resolves these to colour-merged accumulators, walkers to
 *  per-part archetype accumulators. */
export interface PersonSink {
    top(): Accum3D; skin(): Accum3D; hair(): Accum3D;
    /** Leg (thigh + shin) for one side. Static people: merged per colour; walkers build theirs separately. */
    leg(side: -1 | 1): Accum3D;
    shoes(): Accum3D;
    skirt(): Accum3D | null;
    bag(): Accum3D;
    umbrella(): Accum3D | null;
    /** Shirt-front / sailor-collar plate (null = skip; walkers skip it to save a mesh). */
    collar(): Accum3D | null;
    /** Small accessories in a named colour — hat, obi, phone, tie. Walkers fold these into an existing same-colour part. */
    extra?(c: PedColor): Accum3D | null;
    /** Called at each BODY-PART boundary (CP_* below) — the static crowd records per-part index sub-ranges so the live
     *  near-field crowd (crowd-live.ts) can lift one person's head / arms / legs out of the merged layers. */
    mark?(part: number): void;
}

/** Body-part ids for {@link PersonSink.mark} (emission order inside emitPerson). */
export const CP_LEGL = 0, CP_LEGR = 1, CP_SKIRT = 2, CP_TORSO = 3, CP_ARML = 4, CP_ARMR = 5, CP_PHONE = 6, CP_HEAD = 7, CP_BAG = 8, CP_UMB = 9;
export const CP_COUNT = 10;
/** Joint pivots written by emitPerson into {@link PersonOpts.pivots} (× 3 floats, world/layout units). */
export const PV_UPPER = 0, PV_HEAD = 1, PV_ARML = 2, PV_ARMR = 3, PV_LEGL = 4, PV_LEGR = 5;
export const PV_COUNT = 6;

export interface PersonOpts {
    pose?: Pose;
    umbrella?: PedColor | null;
    /** The umbrella is CLOSED (carried at the side, tip down) — people waiting under a shelter / an awning. */
    umbrellaClosed?: boolean;
    /** 0 = full (walkers) · 1 = the cheaper static-crowd tessellation. */
    lod?: 0 | 1 | 2;
    /** false = skip the legs (walkers build swinging legs separately, in hip / knee pivot space). */
    legs?: boolean;
    /** Arms NOT to emit into the body (walkers build their swinging arms separately, in shoulder-pivot space). */
    skipArm?: (side: -1 | 1) => boolean;
    /** Mirror the pose's asymmetry (which leg carries the weight, which leg leads a stride). */
    flip?: boolean;
    /** 'rail' pose: the rail top height (m above the feet) and its distance ahead (m). */
    rail?: { y: number; d: number };
    /** Upper-body forward lean (radians, about the hip) — walkers lean in a touch. */
    lean?: number;
    /** OUT: the person's joint pivots (PV_* × xyz, same space as the emitted vertices) — the live crowd rotates the
     *  lifted parts about these. */
    pivots?: number[] | Float32Array;
}

/** The leg that leads a pose / is the relaxed one (legAngles' `lead`). */
export function poseLeadSide(flip: boolean): -1 | 1 { return flip ? -1 : 1; }

/** Proportions shared by the body, the walkers' pivots and the tests (metres for a 1.70 m person; Y scales by k). */
const HIP_Y = 0.90, SHOULDER_Y = 1.37, HEAD_Y = 1.592, HEAD_RY = 0.113;
const KNEE_Y = 0.49, ANKLE_Y = 0.085, UPPER_ARM = 0.29, FOREARM = 0.255;
const shoulderHalf = (look: PersonLook): number => (look.fem ? 0.158 : 0.172) * look.build;
const hipHalf = (look: PersonLook): number => (look.fem ? 0.084 : 0.08) * look.build;

/** Hip joint of a leg in person-local metres (walkers place their thigh meshes here and swing about local Z). */
export function legPivot(look: PersonLook, side: -1 | 1): V3 {
    const k = look.heightM / 1.70;
    return [0, HIP_Y * k, side * hipHalf(look)];
}
/** Knee joint (rest) of a leg in person-local metres (walkers hang their shin meshes here). */
export function kneePivot(look: PersonLook, side: -1 | 1): V3 {
    const k = look.heightM / 1.70;
    return [0.014 * k, KNEE_Y * k, side * hipHalf(look) * 0.97];
}
/** Shoulder joint of an arm in person-local metres (walkers swing their arm meshes about it). */
export function armPivot(look: PersonLook, side: -1 | 1): V3 {
    const k = look.heightM / 1.70;
    return [0, SHOULDER_Y * k, side * (shoulderHalf(look) - 0.026)];
}
/** Head-to-height ratio (top of hair excluded) — Persona's adult crowd sits at ≈ 1/7.5. Exported for the tests. */
export function headFraction(look: PersonLook): number {
    return (2 * HEAD_RY * headScale(look)) / look.heightM;
}
const headScale = (look: PersonLook): number => 0.55 + 0.45 * (look.heightM / 1.70);

/** What an arm is doing: hanging free (can swing), or holding something / posed. */
export type ArmHold = 'free' | 'phone' | 'umbrella' | 'bag' | 'clasp' | 'bar' | 'lap' | 'talk' | 'pocket' | 'strap' | 'rail' | 'cane';
/** The hand that carries a closed umbrella (the other one when the right already carries a briefcase / tote). */
const caneSide = (look: PersonLook): -1 | 1 => look.bag === 'briefcase' || look.bag === 'tote' ? -1 : 1;
export function armHold(look: PersonLook, pose: Pose, side: -1 | 1, umbrella: PedColor | null, closed = false): ArmHold {
    if (pose === 'sit') return 'lap';
    if (pose === 'ride') return 'bar';
    if (pose === 'rail') return 'rail';
    if (umbrella && closed && side === caneSide(look) && pose !== 'clasp') return 'cane';
    if (pose === 'clasp') return 'clasp';
    const trousers = !look.skirt && look.garment !== 'robe';
    if (side > 0) {
        if (umbrella && !closed) return 'umbrella';
        if (pose === 'phone' || look.phone) return 'phone';
        if (look.bag === 'briefcase' || look.bag === 'tote') return 'bag';
        if (pose === 'talk') return 'talk';
        if (pose === 'lean' && trousers) return 'pocket';
        return 'free';
    }
    if (pose === 'rest' || pose === 'talk' || pose === 'lean' || pose === 'phone') {
        if (look.bag === 'shoulder') return 'strap';
        if (trousers && pose !== 'phone') return 'pocket';
    }
    return 'free';
}

/** Two-bone IK: an elbow for (shoulder, wrist target) with fixed bone lengths, bending toward `pole`. The target is
 *  pulled in when out of reach (the arm straightens along it). */
function ik2(sh: V3, target: V3, L1: number, L2: number, pole: V3): { el: V3; wr: V3 } {
    let d = sub3(target, sh), dl = Math.hypot(d[0], d[1], d[2]) || 1e-4;
    const max = (L1 + L2) * 0.995, min = Math.abs(L1 - L2) + 0.02;
    const dir = mul3(d, 1 / dl);
    if (dl > max) dl = max; else if (dl < min) dl = min;
    d = mul3(dir, dl);
    const a = (L1 * L1 - L2 * L2 + dl * dl) / (2 * dl), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    let pp = sub3(pole, mul3(dir, dot3(pole, dir)));
    if (Math.hypot(pp[0], pp[1], pp[2]) < 1e-4) pp = [-1, 0, 0];
    pp = norm3(pp);
    return { el: add3(sh, add3(mul3(dir, a), mul3(pp, h))), wr: add3(sh, d) };
}

/** Shoulder, elbow + wrist of one arm (person-local metres, in the upper body's leaned frame) for a hold + a swing. */
function armJoints(look: PersonLook, hold: ArmHold, side: -1 | 1, swing: number, T?: PersonXf, rail?: { y: number; d: number }): { sh: V3; el: V3; wr: V3 } {
    const k = look.heightM / 1.70, w = look.build, sx = shoulderHalf(look), hz = hipHalf(look);
    const sh = armPivot(look, side);
    let tg: V3, pole: V3 = [-1, -0.1, side * 0.35];
    switch (hold) {
        case 'phone': tg = [0.2, 1.15 * k, side * 0.05 * w]; pole = [-0.3, -1, side * 0.7]; break;
        case 'umbrella': tg = [0.15, 1.1 * k, side * 0.11 * w]; pole = [-0.3, -1, side * 0.9]; break;
        case 'clasp': tg = [0.13, 0.93 * k, side * 0.035 * w]; pole = [-0.3, -1, side * 1.0]; break;
        case 'bar': tg = [0.4, 0.9, side * 0.22]; pole = [-0.3, -1, side * 0.9]; break;   // the handlebar (1.0 m in the bike frame, minus the rider's 0.1 m lift)
        case 'lap': tg = [0.3, 0.98 * k, side * 0.14 * w]; pole = [-0.2, -1, side * 0.9]; break;
        case 'talk': tg = [0.26, 1.13 * k, side * 0.13 * w]; pole = [-0.3, -1, side * 0.7]; break;
        case 'pocket': tg = [0.035, 0.9 * k, side * (hz + 0.085 * w)]; pole = [-1, -0.2, side * 0.8]; break;
        case 'strap': tg = [0.1, 1.23 * k, side * 0.1 * w]; pole = [-0.3, -1, side * 0.9]; break;
        case 'bag': tg = [0.02, 0.87 * k, side * (sx + 0.05)]; break;
        case 'cane': tg = [0.06, 0.88 * k, side * (sx + 0.04)]; break;
        case 'rail': {
            const r = rail ?? { y: 0.95, d: 0.3 };
            tg = unlean(T?.lean, [r.d, r.y, side * 0.17 * w]); pole = [-0.2, 0.2, side * 1.0]; break;
        }
        default: tg = [0.035, 0.86 * k, side * (sx + 0.035)]; break;
    }
    const j = ik2(sh, tg, UPPER_ARM * k, FOREARM * k, pole);
    return { sh, el: rotZ(j.el, sh, swing), wr: rotZ(j.wr, sh, swing) };
}

/** One HAND at the wrist, along the forearm direction `d`. HIGH: a flattened palm, the four fingers as one slightly
 *  curled blade (a relaxed hand — or rolled into the palm for a grip), and a two-joint thumb on the forward side.
 *  FAR: a single flattened ellipsoid + a thumb nub. */
function emitHand(acc: Accum3D, T: PersonXf, wr: V3, d: V3, side: -1 | 1, w: number, D: Detail, fist = false): void {
    const lat: V3 = [0, 0, side];
    const b = norm3(sub3(lat, mul3(d, dot3(lat, d))));         // the BACK of the hand faces out (the palm faces the thigh)
    const e = cross3(d, b), fw = dot3(e, [1, 0.4, 0]) >= 0 ? e : mul3(e, -1);   // the thumb side (forward)
    if (D.tiny) { const len = fist ? 0.045 : 0.062; oellip(acc, T, add3(wr, mul3(d, len * 0.85)), d, lat, len, 0.017 * w, 0.037 * w, 3, 2); return; }
    if (!D.fine) {
        const len = fist ? 0.045 : 0.062;
        oellip(acc, T, add3(wr, mul3(d, len * 0.85)), d, lat, len, 0.017 * w, 0.037 * w, 5, 3);
        const td = norm3(add3(d, mul3(fw, 0.9)));
        oellip(acc, T, add3(add3(wr, mul3(d, 0.03)), mul3(fw, 0.03 * w)), td, lat, 0.03, 0.011, 0.012, 3, 2);
        return;
    }
    const pl = 0.046;
    const pc = add3(add3(wr, mul3(d, pl * 0.78)), mul3(fw, 0.003));
    oellip(acc, T, pc, d, b, pl, 0.0155 * w, 0.041 * w, 8, 5);                                        // palm
    if (!fist) {   // a relaxed hand: the fingers continue the palm, curling a little toward it
        const fd = norm3(sub3(d, mul3(b, 0.32)));
        oellip(acc, T, add3(add3(pc, mul3(d, pl * 0.95)), mul3(b, -0.009)), fd, b, 0.043, 0.0115 * w, 0.037 * w, 8, 4);
    } else {       // a grip: the fingers rolled into the palm (a bar along the knuckle line)
        oellip(acc, T, add3(add3(pc, mul3(d, pl * 0.72)), mul3(b, -0.02)), fw, b, 0.039 * w, 0.02, 0.022, 8, 4);
    }
    // the thumb: from the heel of the palm, two joints, along the forward edge (over the fingers in a grip)
    const t0 = add3(add3(wr, mul3(d, 0.018)), mul3(fw, 0.024 * w));
    const t1 = add3(add3(t0, mul3(d, 0.03)), mul3(fw, 0.014));
    const t2 = fist ? add3(add3(t1, mul3(d, 0.022)), mul3(b, -0.022)) : add3(add3(add3(t1, mul3(d, 0.028)), mul3(fw, 0.002)), mul3(b, -0.008));
    sweep(acc, T, [t0, t1, t2], [0.0125, 0.0105, 0.0085], null, 6, { capB: true });
}

/** One arm (sleeve + bare forearm + hand) into `sleeve` / `skin`, offset by `off` (the shoulder pivot for walker arm
 *  meshes). Returns the wrist (un-offset). The sleeve has a real shoulder cap, a slight bicep, a soft elbow and a
 *  turned-back CUFF / hem (HIGH); the bare forearm swells below the elbow and slims to the wrist. */
function emitArm(sleeve: Accum3D, skin: Accum3D, T: PersonXf, look: PersonLook, hold: ArmHold, side: -1 | 1, swing: number, drop: number, D: Detail,
    off: V3 = [0, 0, 0], rail?: { y: number; d: number }): V3 {
    const w = look.build, ls = D.limb, sub = D.lsub, lip = D.fine ? 0.2 : 0;
    const j = armJoints(look, hold, side, swing, T, rail);
    const q = (p: V3): V3 => [p[0] - off[0], p[1] - drop - off[1], p[2] - off[2]];
    const sh = q(j.sh), el = q(j.el), wr = q(j.wr);
    const cut = look.sleeve;
    const shIn = add3(sh, [0, -0.012, -side * 0.012]);   // the sleeve cap starts inside the shoulder (no pad above the slope)
    if (cut === 'short') {
        sweep(sleeve, T, [shIn, lerp3(sh, el, 0.28), lerp3(sh, el, 0.55)], [0.045 * w, 0.047 * w, 0.049 * w], null, ls, { sub, lipB: lip });
        sweep(skin, T, [lerp3(sh, el, 0.42), lerp3(sh, el, 0.75), el, lerp3(el, wr, 0.35), wr],
            [0.035 * w, 0.032 * w, 0.028 * w, 0.03 * w, 0.021 * w], null, ls, { sub });
    } else if (cut === 'wide') {   // a yukata's hanging sleeve: wide from the elbow down, the forearm + hand below it
        const lo = add3(lerp3(el, wr, 0.62), [0, -0.05, 0]);
        sweep(sleeve, T, [shIn, el, lo], [0.044 * w, 0.075 * w, 0.085 * w], [0.05 * w, 0.06 * w, 0.055 * w], ls + 2, { sub, lipB: lip ? 0.12 : 0 });
        sweep(skin, T, [lerp3(el, wr, 0.4), lerp3(el, wr, 0.75), wr], [0.029 * w, 0.026 * w, 0.021 * w], null, Math.max(5, ls - 2), { sub });
    } else {
        const cuff = lerp3(el, wr, 0.9);
        sweep(sleeve, T, [shIn, lerp3(sh, el, 0.45), el, lerp3(el, wr, 0.5), cuff], [0.045 * w, 0.042 * w, 0.037 * w, 0.036 * w, 0.034 * w], null, ls, { sub, lipB: lip });
        sweep(skin, T, [lerp3(el, wr, 0.78), wr], [0.026 * w, 0.021 * w], null, Math.max(5, ls - 2));
    }
    if (hold !== 'pocket') {
        const d = norm3(sub3(wr, el));
        emitHand(skin, T, wr, d, side, w, D, hold === 'bag' || hold === 'cane' || hold === 'umbrella' || hold === 'bar' || hold === 'strap');
    }
    return j.wr;
}

/** Leg angles for a pose: hip angle (+ = thigh forward) and knee flex (+ = shin folds back). `flip` mirrors. */
function legAngles(pose: Pose, side: -1 | 1, flip: boolean): { th: number; kf: number } {
    const lead = (flip ? -1 : 1) as -1 | 1;   // the leading / free leg
    switch (pose) {
        case 'stride': return side === lead ? { th: 0.28, kf: 0.05 } : { th: -0.26, kf: 0.42 };
        case 'rest': case 'talk': return side === lead ? { th: 0.2, kf: 0.3 } : { th: 0, kf: 0.02 };
        case 'phone': case 'clasp': return side === lead ? { th: 0.08, kf: 0.14 } : { th: 0, kf: 0.02 };
        case 'lean': return side === lead ? { th: -0.1, kf: 1.25 } : { th: 0.05, kf: 0.04 };   // one foot back flat on the wall
        case 'rail': return side === lead ? { th: 0.06, kf: 0.16 } : { th: -0.02, kf: 0.08 };
        default: return { th: 0, kf: 0 };
    }
}

/** A shoe's heel + toe points relative to the ankle (m, before k): the lowest point of a posed foot. */
const HEEL: V3 = [-0.058, -ANKLE_Y + 0.004, 0], TOE: V3 = [0.19, -ANKLE_Y + 0.006, 0];

/** How far the lowest foot point rises above the ground for (hip angle, knee flex) — the body sinks by the lower
 *  foot's value (a stride / bent knee shortens the leg). Metres. */
function footLift(look: PersonLook, th: number, kf: number): number {
    const k = look.heightM / 1.70;
    const hip: V3 = [0, HIP_Y * k, 0], knee: V3 = [0.014 * k, KNEE_Y * k, 0], ankle: V3 = [0, ANKLE_Y * k, 0];
    const R = (p: V3): V3 => rotZ(rotZ(p, knee, -kf), hip, th);
    return Math.min(R(add3(ankle, mul3(HEEL, k)))[1], R(add3(ankle, mul3(TOE, k)))[1]);
}

/** How far to bend forward at the hip (radians) for the hands to reach a rail (top `y`, `d` ahead, metres) —
 *  ~0.2 for a waist-high rail, more (peering over) for a low bridge parapet. */
function railLean(look: PersonLook, rail: { y: number; d: number }): number {
    const k = look.heightM / 1.70, reach = (UPPER_ARM + FOREARM) * k * 0.97, arm = (SHOULDER_Y - HIP_Y) * k;
    for (let a = 0.15; a < 0.9; a += 0.05) {
        const sx = arm * Math.sin(a), sy = HIP_Y * k + arm * Math.cos(a);
        if (Math.hypot(rail.d - sx, rail.y - sy) <= reach) return a;
    }
    return 0.9;
}

/** Emit one person. Standing people have their feet at T.o; seated ones their seat (hips) at T.o.y + 0.47 m·k. */
export function emitPerson(sink: PersonSink, T0: PersonXf, look: PersonLook, opts: PersonOpts = {}): void {
    const k = look.heightM / 1.70, w = look.build, lod = opts.lod ?? 0, D = detailFor(lod);
    const pose: Pose = opts.pose ?? 'stand', sit = pose === 'sit';
    const flip = !!opts.flip;
    const rs = D.torso;                                        // torso ring sides
    const extra = (c: PedColor): Accum3D | null => sink.extra ? sink.extra(c) : null;
    const umbrella = opts.umbrella ?? null, closedUmb = !!(umbrella && opts.umbrellaClosed);
    const fem = look.fem, robe = look.garment === 'robe';
    const lip = D.fine ? 0.14 : 0;                             // hem / collar turn-backs (HIGH only)

    // STANCE: the legs' angles, and how far the body sinks so the lower foot meets the ground.
    // a narrow skirt / a coat / a yukata keeps the thighs together (the legs would push through the hem)
    const tight = look.garment === 'robe' ? 0.3 : look.skirt && look.skirtCut === 'pencil' ? 0.3 : look.skirt || look.garment === 'coat' ? 0.6 : 1;
    const la = (side: -1 | 1): { th: number; kf: number } => { const a = legAngles(pose, side, flip); return pose === 'lean' ? a : { th: a.th * tight, kf: a.kf }; };
    const LA = { [-1]: la(-1), [1]: la(1) } as Record<-1 | 1, { th: number; kf: number }>;
    const sink0 = sit ? 0 : Math.max(0, Math.min(footLift(look, LA[-1].th, LA[-1].kf), footLift(look, LA[1].th, LA[1].kf)));
    const tilt = pose === 'lean' ? [{ a: -0.07, y: 0 }] : [];                       // a wall-leaner tilts back from the feet
    const T: PersonXf = { ...T0, o: [T0.o[0], T0.o[1] - sink0 * T0.u, T0.o[2]], ...(tilt.length || T0.lean ? { lean: [...(T0.lean ?? []), ...tilt] } : {}) };
    const rail = pose === 'rail' ? { y: (opts.rail?.y ?? 0.95) + sink0, d: opts.rail?.d ?? 0.25 } : undefined;
    const upperLean = rail ? railLean(look, rail) : pose === 'phone' ? 0.04 : (opts.lean ?? 0);
    const TU: PersonXf = upperLean ? { ...T, lean: [{ a: upperLean, y: HIP_Y * k }, ...(T.lean ?? [])] } : T;

    const drop = sit ? (HIP_Y - 0.47) * k : 0;                 // seated: the upper body sits lower
    const Y = (y: number): number => y * k - drop;
    const shF = fem ? 0.92 : 1, waF = fem ? 0.86 : 1, hiF = fem ? 1.06 : 1;
    if (opts.pivots) {   // joint pivots for the live near-field crowd (same frames the parts below are emitted in)
        const pv = opts.pivots, put = (i: number, q: V3): void => { pv[i * 3] = q[0]; pv[i * 3 + 1] = q[1]; pv[i * 3 + 2] = q[2]; };
        put(PV_UPPER, P(T, 0, Y(HIP_Y), 0));
        put(PV_HEAD, P(TU, 0.004, Y(1.43), 0));
        for (const side of [-1, 1] as const) {
            const sh = armPivot(look, side);
            put(side < 0 ? PV_ARML : PV_ARMR, P(TU, sh[0], sh[1] - drop, sh[2]));
            put(side < 0 ? PV_LEGL : PV_LEGR, sit ? P(T, -0.04, 0.47 * k, side * hipHalf(look) * 0.8) : P(T, 0, HIP_Y * k, side * hipHalf(look)));
        }
    }

    // LEGS (+ shoes). Walkers skip this (`legs:false`) and build their thighs / shins in pivot space (walkerParts).
    if (opts.legs !== false) for (const side of [-1, 1] as const) {
        sink.mark?.(side < 0 ? CP_LEGL : CP_LEGR);
        const acc = sink.leg(side);
        if (sit) {
            const hz = side * hipHalf(look);
            const hip: V3 = [-0.04, 0.47 * k, hz * 0.8], knee: V3 = [0.42 * k, 0.47 * k, hz * 1.05], ankle: V3 = [0.45 * k, ANKLE_Y * k, hz * 1.05];
            const bare = !!look.skirt || robe;
            sweep(acc, T, [hip, lerp3(hip, knee, 0.5), knee], bare ? [0.068 * w, 0.058 * w, 0.042 * w] : [0.072 * w, 0.064 * w, 0.054 * w], null, D.limb, { sub: D.lsub, capB: D.fine });
            sweep(acc, T, [knee, [0.435 * k, 0.33 * k, hz * 1.05], [0.448 * k, 0.18 * k, hz * 1.05], ankle],
                bare ? [0.042 * w, 0.047 * w, 0.031 * w, 0.023 * w] : [0.054 * w, 0.053 * w, 0.051 * w, 0.052 * w], null, D.limb, { sub: D.lsub, lipB: bare ? 0 : lip });
            emitShoe(sink.shoes(), acc, T, look, ankle, 0, D);
            continue;
        }
        emitLeg(acc, acc, sink.shoes(), T, look, side, null, LA[side].th, LA[side].kf, D);
    }

    // SKIRT (from the waist; the legs read as tights / bare below it) — per cut: A-line to the knee, a straight pencil
    // below it, a short PLEATED school skirt (knife pleats that fade toward the waistband), a flared midi. A turned
    // hem gives it thickness.
    sink.mark?.(CP_SKIRT);
    const sk = look.skirt && !robe ? sink.skirt() : null;
    if (sk) {
        if (sit) loft(sk, T, [{ x: 0.22 * k, y: Y(0.47) - 0.01, z: 0, rx: 0.26 * w, rz: 0.2 * w }, { x: 0.06, y: Y(0.8), z: 0, rx: 0.16 * w, rz: 0.17 * w * hiF }, { x: 0.02, y: Y(1.0), z: 0, rx: 0.1 * w, rz: 0.135 * w * hiF }], rs, false, false, undefined, { lipBot: lip });
        else {
            const cut = look.skirtCut;
            const hem = cut === 'pleat' ? 0.58 : cut === 'pencil' ? 0.44 : cut === 'flare' ? 0.4 : 0.5;
            const hr = cut === 'pencil' ? [0.112, 0.15] : cut === 'pleat' ? [0.16, 0.195] : cut === 'flare' ? [0.19, 0.22] : [0.165, 0.195];
            const mid = (hem + 0.84) / 2, mr = cut === 'pencil' ? [0.115, 0.155] : [(hr[0] + 0.123) / 2 + 0.004, (hr[1] + 0.163) / 2 + 0.004];
            const rings: Ring[] = [
                { x: 0.012, y: Y(hem), z: 0, rx: hr[0] * w, rz: hr[1] * w * hiF },
                { x: 0.009, y: Y(mid), z: 0, rx: mr[0] * w, rz: mr[1] * w * hiF },
                { x: 0.006, y: Y(0.84), z: 0, rx: 0.123 * w, rz: 0.163 * w * hiF },
                { x: 0.003, y: Y(0.93), z: 0, rx: 0.109 * w, rz: 0.15 * w * hiF },
                { x: 0, y: Y(1.01), z: 0, rx: 0.094 * w, rz: 0.13 * w * waF * 1.08 },
            ];
            const pleatN = cut === 'pleat' ? (D.fine ? 24 : 12) : cut === 'flare' && D.fine ? 20 : rs;
            // pleats: full depth over the lower skirt, fading out by the hip ring (t = 2); a flared midi gets soft folds
            const pleats = cut === 'pleat' ? (i: number, t: number): number => { const a = Math.max(0, Math.min(1, 2 - t)); return 1 + a * (i % 2 ? 0.045 : -0.04); }
                : cut === 'flare' && D.fine ? (i: number, t: number): number => 1 + Math.max(0, 1.6 - t) / 1.6 * 0.035 * Math.cos(i * Math.PI * 2 / 4) : undefined;
            loft(sk, T, rings, pleatN, false, false, pleats, { sub: D.tsub, lipBot: lip, lipTop: lip ? 0.1 : 0, lipH: 0.01 });
        }
    }

    // TORSO: hem → hips → belly → waist → ribs → chest (bust) → armpits → squared SHOULDERS → trapezius slope → neck
    // base — one smooth loft (Hermite-resampled), the chest pushed forward and the shoulder blades back. The hem sits
    // at the crotch for a jacket / top (it covers the thighs' hip joints), at the knee for a coat, the ankle for a
    // yukata, the waistband when a top is tucked into a skirt; a turned hem gives the cloth its thickness.
    sink.mark?.(CP_TORSO);
    const top = sink.top(), jacket = look.garment === 'jacket' || look.garment === 'coat';
    const belly: Ring = { x: 0.003, y: Y(0.99), z: 0, rx: 0.093 * w, rz: 0.134 * w * waF * 1.05 };
    const hemRings: Ring[] = sit ? [{ x: 0.03, y: Y(0.9), z: 0, rx: 0.115 * w, rz: 0.15 * w * hiF }]
        : robe ? [{ x: 0.01, y: Y(0.1), z: 0, rx: 0.14 * w, rz: 0.158 * w }, { x: 0.012, y: Y(0.5), z: 0, rx: 0.125 * w, rz: 0.152 * w * hiF }, { x: 0.008, y: Y(0.88), z: 0, rx: 0.106 * w, rz: 0.146 * w * hiF }]
        : look.garment === 'coat' ? [{ x: 0.01, y: Y(0.48), z: 0, rx: 0.155 * w, rz: 0.19 * w * hiF }, { x: 0.008, y: Y(0.7), z: 0, rx: 0.13 * w, rz: 0.17 * w * hiF, sq: 0.1 }, { x: 0.006, y: Y(0.88), z: 0, rx: 0.112 * w, rz: 0.155 * w * hiF }, belly]
        : look.skirt ? [{ x: 0.002, y: Y(0.975), z: 0, rx: 0.087 * w, rz: 0.13 * w * waF * 1.02 }]   // TUCKED IN: inside the skirt's waistband (no crossing seam)
        : [{ x: 0.005, y: Y(jacket ? 0.77 : 0.8), z: 0, rx: (jacket ? 0.108 : 0.102) * w, rz: (jacket ? 0.158 : 0.15) * w * hiF, sq: jacket ? 0.12 : 0 },
            { x: 0.004, y: Y(0.9), z: 0, rx: 0.1 * w, rz: 0.148 * w * hiF, bb: fem ? 0.1 : 0.05 }, belly];
    const torsoRaw: Ring[] = [
        ...hemRings,
        { x: 0.0, y: Y(1.06), z: 0, rx: 0.088 * w, rz: 0.124 * w * waF },
        { x: fem ? 0.008 : 0.006, y: Y(1.16), z: 0, rx: 0.097 * w, rz: 0.137 * w * shF, fb: fem ? 0.06 : 0.02 },
        { x: fem ? 0.016 : 0.01, y: Y(1.25), z: 0, rx: (fem ? 0.108 : 0.106) * w, rz: 0.151 * w * shF, fb: fem ? 0.16 : 0.06, bb: 0.04 },
        { x: 0.004, y: Y(1.315), z: 0, rx: 0.103 * w, rz: 0.16 * w * shF * (jacket ? 1.02 : 1), fb: fem ? 0.05 : 0.03, bb: 0.07, sq: 0.15 },
        { x: 0.0, y: Y(1.37), z: 0, rx: 0.092 * w, rz: 0.166 * w * shF * (jacket ? 1.03 : 1), sq: jacket ? 0.5 : 0.35, bb: 0.04 },
        { x: -0.004, y: Y(1.42), z: 0, rx: 0.072 * w, rz: 0.117 * w * shF, sq: 0.15 },
        { x: 0.003, y: Y(1.458), z: 0, rx: 0.05 * w, rz: 0.057 * w },
    ];
    const torso = smoothRings(torsoRaw, D.tsub);
    const hemLip = !sit && D.fine && !look.skirt;   // a tucked-in top has no free hem
    loft(top, TU, torso, rs, false, false, undefined, { lipBot: hemLip ? 0.1 : 0 });   // caps hidden by the neck / the legs
    /** The torso surface x (front) at height y (m, pre-k) and lateral offset z (m) — shirt fronts, lapels, ties hug it. */
    const surfX = (y: number, z = 0): number => {
        const yy = Y(y);
        let a = torso[torso.length - 1], b = a, t = 0;
        for (let i = 0; i < torso.length - 1; i++) if (yy >= torso[i].y && yy <= torso[i + 1].y) { a = torso[i]; b = torso[i + 1]; t = (yy - a.y) / (b.y - a.y || 1); break; }
        const L = (key: 'fb' | 'sq'): number => (a[key] ?? 0) + ((b[key] ?? 0) - (a[key] ?? 0)) * t;
        const rx = a.rx + (b.rx - a.rx) * t, rz = a.rz + (b.rz - a.rz) * t, cx = a.x + (b.x - a.x) * t, fb = L('fb'), e = 2 + 2.5 * L('sq');
        const zr = Math.min(1, Math.abs(z / rz)), c = Math.pow(Math.max(0, 1 - Math.pow(zr, e)), 1 / e);   // the loft's superellipse
        const ca2 = c * c / (c * c + zr * zr || 1);
        return cx + rx * c * (1 + fb * ca2);
    };
    /** A panel hugging the chest: a strip of (y, zA, zB) rows (m, pre-k), pushed out `lift` metres off the surface. */
    const strip = (acc: Accum3D, rows0: [number, number, number][], lift: number): void => {
        // resample every ~2 cm so the strip follows the chest's curve between its authored rows (a flat span would
        // let a convex chest / bust poke through it)
        const rows: [number, number, number][] = [rows0[0]];
        for (let i = 1; i < rows0.length; i++) {
            const a = rows0[i - 1], b = rows0[i], n = D.fine ? Math.max(1, Math.ceil(Math.abs(b[0] - a[0]) / 0.02)) : 1;
            for (let s = 1; s <= n; s++) { const t = s / n; rows.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
        }
        let prev: [number, number] | null = null;
        for (const [y, za, zb] of rows) {
            // (+ a little extra near the neck: the loft's facets between the steep trapezius rings sit proud of surfX)
            const up = Math.min(1, Math.max(0, (y - 1.33) / 0.11));
            const mk = (z: number): number => { const x = surfX(y, z) + lift + 0.007 * up * up * (0.3 + Math.abs(z) * 14); return acc.vertex(P(TU, x, Y(y), z), Nv(TU, 1, 0.12, z * 4), 0, 0); };
            const a = mk(za), b = mk(zb);
            if (prev) { acc.triangle(prev[0], a, b); acc.triangle(prev[0], b, prev[1]); }
            prev = [a, b];
        }
    };
    /** A symmetric strip (y, half-width) about z0. */
    const panel = (acc: Accum3D, pts: [number, number][], lift: number, z0 = 0): void =>
        strip(acc, pts.map(([y, hw]) => [y, z0 - hw, z0 + hw] as [number, number, number]), lift);

    // COLLARS + FRONTS: a shirt collar band (+ its points, HIGH) round the neck, the V of shirt between the lapels
    // (open jacket: down to the hem), a tie on suits, notched LAPELS on jackets + coats (HIGH), the sailor collar's back
    // flap + V + ribbon, a standing collar on a gakuran / coat; the yukata's OBI (a sash band at the waist).
    if (robe && look.collar) {
        const obi = extra(look.collar) ?? sink.collar();
        if (obi) loft(obi, TU, [{ x: 0.0, y: Y(0.97), z: 0, rx: 0.1 * w, rz: 0.14 * w }, { x: 0.0, y: Y(1.13), z: 0, rx: 0.098 * w, rz: 0.135 * w }], rs, false, false, undefined, { lipBot: lip, lipTop: lip });
        // the crossed front collar (left over right) in the top colour, a shade proud of the robe
        panel(top, [[1.1, 0.012], [1.3, 0.05], [1.44, 0.05]], 0.004, 0.02);
    } else {
        const col = look.collar && look.collar !== look.top ? sink.collar() : null;
        const sailor = look.skirtCut === 'pleat' && !!look.skirt;
        const band = (acc: Accum3D, y0: number, y1: number, r0: number, r1: number): void =>
            loft(acc, TU, [{ x: 0.006, y: Y(y0), z: 0, rx: r0 * w, rz: (r0 + 0.008) * w }, { x: 0.01, y: Y(y1), z: 0, rx: r1 * w, rz: (r1 + 0.008) * w }], D.fine ? 14 : 8, false, false, undefined, { lipTop: D.fine ? 0.12 : 0, lipH: 0.008 });
        const vb = look.open && look.garment === 'jacket' ? (look.skirt ? 1.0 : 0.8) : 1.22;
        if (col && !sailor) {
            band(col, 1.44, 1.478, 0.052, 0.049);
            if (D.fine) for (const s of [-1, 1] as const) strip(col, [[1.47, s * 0.004, s * 0.036], [1.435, s * 0.006, s * 0.04], [1.405, s * 0.004, s * 0.012]], 0.004);   // collar points
            panel(col, vb < 1.1 ? [[1.44, 0.05], [1.3, 0.036], [1.1, 0.03], [vb, 0.036]] : [[1.44, 0.05], [1.33, 0.024], [vb, 0.002]], 0.002);
            const tie = look.garment === 'jacket' && look.collar === 'shirt' && !fem ? extra(look.top === 'navy' ? 'charcoal' : 'navy') : null;
            if (tie) {
                panel(tie, [[1.438, 0.012], [1.4, 0.009], [1.2, 0.022], [vb < 1.1 ? 1.02 : 1.22, 0.0]], 0.005);
                if (D.fine) panel(tie, [[1.452, 0.013], [1.438, 0.012]], 0.009);   // the knot
            }
        } else if (col && sailor) {
            // big square flap across the back of the shoulders + the front V + a ribbon at its point
            const bx = (y: number): number => -(surfX(y) - 0.012) - 0.004;
            const f0 = col.vertex(P(TU, bx(1.43), Y(1.43), -0.11 * w), Nv(TU, -1, 0.3, 0), 0, 0), f1 = col.vertex(P(TU, bx(1.43), Y(1.43), 0.11 * w), Nv(TU, -1, 0.3, 0), 1, 0);
            const f2 = col.vertex(P(TU, bx(1.27) - 0.006, Y(1.27), 0.12 * w), Nv(TU, -1, 0, 0), 1, 1), f3 = col.vertex(P(TU, bx(1.27) - 0.006, Y(1.27), -0.12 * w), Nv(TU, -1, 0, 0), 0, 1);
            col.triangle(f0, f1, f2); col.triangle(f0, f2, f3);
            panel(col, [[1.45, 0.07], [1.36, 0.05], [1.26, 0.004]], 0.003);
            const rib = extra('red');
            if (rib) panel(rib, [[1.29, 0.035], [1.25, 0.012], [1.2, 0.03]], 0.008);
        } else if (!look.collar && (look.garment === 'jacket' || look.garment === 'coat') && !fem) {
            band(top, 1.44, 1.49, 0.054, 0.052);   // a standing collar (gakuran / coat) in the top colour
        } else if (!look.collar && look.garment === 'coat') {
            band(top, 1.44, 1.48, 0.056, 0.058);
        }
        // LAPELS (suit jackets + coats with a shirt / open front): two notched lapels in the top colour, from the collar
        // round the neck down to the button point, lying just proud of the chest either side of the shirt V.
        if (D.fine && jacket && (look.collar || look.garment === 'coat') && !sailor) {
            const lb = vb < 1.1 ? Math.max(vb, 1.05) : vb;
            for (const s of [-1, 1] as const) strip(top, [
                [1.44, s * 0.045, s * 0.066], [1.405, s * 0.043, s * 0.08], [1.386, s * 0.04, s * 0.072],   // collar → the NOTCH
                [1.372, s * 0.037, s * 0.092], [1.3, s * 0.03, s * 0.088], [(1.3 + lb) / 2, s * 0.02, s * 0.062], [lb, s * 0.002, s * 0.016],
            ], 0.005);
        }
    }

    // ARMS (sleeves) + HANDS.
    let umbHand: V3 | null = null, phoneHand: V3 | null = null, caneHand: V3 | null = null;
    const stride = pose === 'stride' ? 0.26 * (flip ? -1 : 1) : 0;
    const holds = { [-1]: armHold(look, pose, -1, umbrella, closedUmb), [1]: armHold(look, pose, 1, umbrella, closedUmb) } as Record<-1 | 1, ArmHold>;
    for (const side of [-1, 1] as const) {
        const hold = holds[side];
        const armSwing = hold === 'free' ? -side * stride * 0.8 : 0;
        const wr = armJoints(look, hold, side, armSwing, TU, rail).wr;
        if (hold === 'umbrella') umbHand = wr;
        if (hold === 'phone') phoneHand = wr;
        if (hold === 'cane') caneHand = wr;
        if (opts.skipArm?.(side)) continue;
        sink.mark?.(side < 0 ? CP_ARML : CP_ARMR);
        emitArm(top, sink.skin(), TU, look, hold, side, armSwing, drop, D, [0, 0, 0], rail);
    }
    if (phoneHand) {
        sink.mark?.(CP_PHONE);
        const ph = extra('black') ?? sink.bag();
        box(ph, TU, [phoneHand[0] + 0.045, phoneHand[1] - drop + 0.035, phoneHand[2] - Math.sign(phoneHand[2] || 1) * 0.012], 0.006, 0.06, 0.03, D.fine ? 0.003 : 0);
    }

    // NECK + HEAD (faceless: plain skin, the hair shell frames it). An egg-shaped head loft: a narrow chin and a jaw
    // that pulls in under the ears, full cheeks, a rounder back of the skull (the face is flatter than the back);
    // ears on the HIGH head. A phone-reader's head dips forward.
    sink.mark?.(CP_HEAD);
    const skin = sink.skin(), hs = headScale(look);
    const look_down = phoneHand ? 1 : 0;
    const hc: V3 = [0.018 + 0.03 * look_down, Y(HEAD_Y) - 0.014 * look_down, 0];
    sweep(skin, TU, [[0.002, Y(1.425), 0], [0.006 + 0.006 * look_down, (Y(1.425) + hc[1] - 0.065 * hs) / 2, 0], [0.012 + 0.012 * look_down, hc[1] - 0.065 * hs, 0]],
        [0.041 * w, 0.037 * w, 0.035 * w], [0.043 * w, 0.038 * w, 0.037 * w], D.fine ? 12 : D.tiny ? D.head : 7);
    const HR: [number, number, number, number, number, number][] = [   // (dy, dx, rx, rz, front bulge, back bulge) × hs
        [-0.106, 0.036, 0.014, 0.016, 0, 0], [-0.097, 0.03, 0.038, 0.034, 0.05, -0.3], [-0.078, 0.019, 0.063, 0.055, 0.03, -0.25],
        [-0.046, 0.008, 0.086, 0.071, 0, -0.08], [-0.008, 0.002, 0.097, 0.079, 0, 0.04], [0.03, -0.003, 0.099, 0.08, -0.02, 0.08],
        [0.064, -0.008, 0.088, 0.074, 0, 0.06], [0.092, -0.013, 0.062, 0.054, 0, 0.02], [0.109, -0.016, 0.026, 0.024, 0, 0],
    ];
    loft(skin, TU, HR.map(([dy, dx, rx, rz, fb, bb]) => ({ x: hc[0] + dx * hs, y: hc[1] + dy * hs, z: 0, rx: rx * hs, rz: rz * hs, fb, bb })), D.head, true, true, undefined, { sub: D.hsub });
    if (D.fine && (look.hairStyle === 'short' || look.hairStyle === 'bun' || look.hairStyle === 'pony')) for (const s of [-1, 1] as const) {   // EARS (bobs + long hair cover them)
        oellip(skin, TU, [hc[0] - 0.012 * hs, hc[1] - 0.012 * hs, s * 0.079 * hs], norm3([0.15, 1, 0]), [0, 0, s], 0.029 * hs, 0.009, 0.017 * hs, 6, 4);
    }
    emitHair(sink.hair(), TU, look, hc, hs, D);
    if (look.hat !== 'none') {
        const hat = extra(look.hatColor) ?? sink.hair();
        const hrx = 0.097 * hs, hry = HEAD_RY * hs, hrz = 0.08 * hs;
        loft(hat, TU, [{ x: hc[0] - 0.006, y: hc[1] + 0.03, z: 0, rx: hrx * 1.17, rz: hrz * 1.25 }, { x: hc[0] - 0.008, y: hc[1] + 0.03 + hry * 0.62, z: 0, rx: hrx * 1.0, rz: hrz * 1.06 },
            { x: hc[0] - 0.01, y: hc[1] + 0.03 + hry * 0.95, z: 0, rx: hrx * 0.55, rz: hrz * 0.6 }], D.fine ? 16 : 8, true, false, undefined, { sub: D.hsub, lipBot: D.fine ? 0.08 : 0, lipH: 0.008 });
        if (look.hat === 'cap') {
            if (D.fine) {   // a curved bill: a thin sweep across the brow
                const bx = hc[0] + hrx * 1.12, by = hc[1] + 0.034;
                sweep(hat, TU, [[bx - 0.02, by + 0.004, -hrz * 0.8], [bx + 0.03, by - 0.003, 0], [bx - 0.02, by + 0.004, hrz * 0.8]], [0.004, 0.004, 0.004], [0.04, 0.06, 0.04], 6, { ref: [0, 1, 0], sub: 2 });
            } else box(hat, TU, [hc[0] + hrx * 1.12, hc[1] + 0.034, 0], 0.06, 0.005, hrz * 0.9);
        } else {   // a flat brim disc (one fan — double-sided)
            const n = D.fine ? 16 : 8, c0 = hat.vertex(P(TU, hc[0] - 0.008, hc[1] + 0.034, 0), Nv(TU, 0, 1, 0), 0.5, 0.5), rim: number[] = [];
            for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; rim.push(hat.vertex(P(TU, hc[0] - 0.008 + Math.cos(a) * 0.17 * hs, hc[1] + 0.026 - (D.fine ? 0.006 : 0), Math.sin(a) * 0.16 * hs), Nv(TU, Math.cos(a) * 0.15, 1, Math.sin(a) * 0.15), 0.5, 0.5)); }
            for (let i = 0; i < n; i++) hat.triangle(c0, rim[(i + 1) % n], rim[i]);
        }
    }

    // BAG.
    sink.mark?.(CP_BAG);
    const bag = sink.bag(), sx = shoulderHalf(look), bev = D.fine ? 0.008 : 0;
    const front = pose === 'clasp' && (look.bag === 'briefcase' || look.bag === 'tote');
    switch (look.bag) {
        case 'briefcase': {
            if (front) { const c = armJoints(look, 'clasp', 1, 0, TU).wr; box(bag, TU, [c[0] + 0.03, c[1] - drop - 0.15 * k, 0], 0.035, 0.13 * k, 0.19, bev); break; }
            const wr = armJoints(look, 'bag', 1, 0, TU).wr;   // hanging from the right hand
            box(bag, TU, [wr[0] + 0.03, wr[1] - drop - 0.2 * k, wr[2] + 0.01], 0.19, 0.13 * k, 0.035, bev);
            tube2(bag, TU, [wr[0] - 0.02, wr[1] - drop - 0.05, wr[2] + 0.01], [wr[0] + 0.08, wr[1] - drop - 0.05, wr[2] + 0.01], 0.008);
            break;
        }
        case 'shoulder': {   // a soft bag at the left hip, the strap up to the left shoulder
            const z = -(0.2 * w * hiF + 0.025), y = Y(0.95);
            if (!D.fine) box(bag, TU, [-0.03, y, z], 0.12, 0.095 * k, 0.04);
            else sweep(bag, TU, [[-0.15, y, z], [-0.1, y + 0.004, z], [-0.03, y + 0.006, z], [0.04, y + 0.004, z], [0.09, y, z]],
                [0.085 * k, 0.098 * k, 0.102 * k, 0.098 * k, 0.085 * k], [0.03, 0.042, 0.046, 0.042, 0.03], 10, { ref: [0, 1, 0], capA: true, capB: true, down: [0.07 * k, 0.09 * k, 0.095 * k, 0.09 * k, 0.07 * k] });
            sweep(bag, TU, [[0.0, y + 0.09 * k, z + 0.01], [0.0, Y(1.2), -(sx * 0.95)], [0.0, Y(1.38), -(sx * 0.62)]], [0.004, 0.004, 0.004], [0.014, 0.014, 0.014], 4, { sub: D.fine ? 2 : 1 });
            break;
        }
        case 'backpack': {
            loft(bag, TU, [{ x: -0.16 * w, y: Y(1.0), z: 0, rx: 0.06, rz: 0.13 * w, sq: 0.4 }, { x: -0.175 * w, y: Y(1.05), z: 0, rx: 0.075, rz: 0.14 * w, sq: 0.45 },
                { x: -0.178 * w, y: Y(1.3), z: 0, rx: 0.075, rz: 0.135 * w, sq: 0.45 }, { x: -0.16 * w, y: Y(1.38), z: 0, rx: 0.05, rz: 0.11 * w, sq: 0.3 }], D.fine ? 14 : 6, true, true, undefined, { sub: D.fine ? 2 : 0 });
            if (D.fine) for (const s of [-1, 1] as const) {   // the shoulder straps: over the shoulder, down the front to the armpit
                const zS = s * sx * 0.62;
                sweep(bag, TU, [[-0.15 * w, Y(1.36), zS], [-0.05, Y(1.455), zS], [surfX(1.36, zS) - 0.01, Y(1.36), zS * 1.1], [surfX(1.22, zS * 1.3) + 0.004, Y(1.2), zS * 1.35]],
                    [0.006, 0.006, 0.006, 0.006], [0.02, 0.02, 0.02, 0.02], 4, { sub: 2 });
            }
            break;
        }
        case 'tote': {
            if (front) { const c = armJoints(look, 'clasp', 1, 0, TU).wr; box(bag, TU, [c[0] + 0.04, c[1] - drop - 0.17 * k, 0], 0.03, 0.15 * k, 0.16, bev * 0.6); break; }
            box(bag, TU, [-0.04, Y(1.0), sx + 0.07], 0.15, 0.15 * k, 0.03, bev * 0.6);   // on the right shoulder, under the arm
            tube2(bag, TU, [0.02, Y(1.14), sx + 0.05], [0.0, Y(1.4), sx * 0.7], 0.009);
            break;
        }
        default: break;
    }

    // UMBRELLA: open (rain, walking) — a shaft from the holding hand + an 8-rib domed canopy with scalloped points
    // just above the head; CLOSED — furled, carried at the side by the handle, tip near the ground.
    sink.mark?.(CP_UMB);
    const umb = umbrella ? sink.umbrella() : null;
    if (umb && umbHand) {
        const hand: V3 = [umbHand[0] + 0.02, umbHand[1] - drop + 0.02, umbHand[2]], topP: V3 = [0.05, Y(1.98), 0.03];
        tube2(umb, TU, [hand[0], hand[1] - 0.06, hand[2]], topP, 0.011);
        const R = 0.52, segs = 8, apex = umb.vertex(P(TU, topP[0], topP[1] + 0.03, topP[2]), Nv(TU, 0, 1, 0), 0.5, 0.5);
        // rings of the dome (radius fraction, drop): the canopy curves down between the ribs' tips
        const RG: [number, number, number][] = D.fine ? [[0.3, -0.015, 0.2], [0.6, -0.06, 0.35], [0.84, -0.13, 0.55], [1, -0.2, 0.7]] : [[0.6, -0.06, 0.35], [1, -0.2, 0.7]];
        const rows = RG.map(([f, dy, nt]) => Array.from({ length: segs }, (_, i) => {
            const a = (i / segs) * Math.PI * 2;
            return umb.vertex(P(TU, topP[0] + Math.cos(a) * R * f, topP[1] + dy, topP[2] + Math.sin(a) * R * f), Nv(TU, Math.cos(a) * nt, 1, Math.sin(a) * nt), 0.5, 0.5);
        }));
        for (let i = 0; i < segs; i++) {
            const j = (i + 1) % segs;
            umb.triangle(apex, rows[0][j], rows[0][i]);
            for (let r = 0; r < rows.length - 1; r++) { umb.triangle(rows[r][i], rows[r][j], rows[r + 1][j]); umb.triangle(rows[r][i], rows[r + 1][j], rows[r + 1][i]); }
        }
    }
    if (umb && caneHand) {
        const h: V3 = [caneHand[0] + 0.02, caneHand[1] - drop, caneHand[2]];
        const tip: V3 = [h[0] + 0.1, 0.02, h[2] + Math.sign(h[2] || 1) * 0.02];
        sweep(umb, TU, [lerp3(h, tip, 0.06), lerp3(h, tip, 0.3), lerp3(h, tip, 0.75), tip], [0.012, 0.032, 0.022, 0.005], null, D.fine ? 8 : 5, { capA: true, sub: D.fine ? 2 : 1 });
        tube2(umb, TU, [h[0] - 0.035, h[1] + 0.03, h[2]], [h[0] + 0.01, h[1] + 0.05, h[2]], 0.009);   // the J handle's crook (in the fist)
    }
}

/** A thin 4-sided rod (straps, handles, shafts). */
function tube2(acc: Accum3D, T: PersonXf, a: V3, b: V3, r: number): void {
    sweep(acc, T, [a, b], [r, r], null, 4);
}

/** The HAIR: a shell over the skull that opens a FACE WINDOW at the front (the fringe line) and hangs lower at the
 *  sides and back per style — a short cut with volume on top that clears the ears and tapers to the nape, a
 *  jaw-length BOB flaring out at its ends, LONG hair with a curtain down the back and locks in front of the
 *  shoulders, a PONYTAIL from the crown, a BUN. HIGH adds a side PART line, piecey BANGS and a turned-in edge
 *  (the shell has thickness instead of a paper rim). Smooth numeric normals over the whole shell. */
function emitHair(hair: Accum3D, T: PersonXf, look: PersonLook, hc: V3, hs: number, D: Detail): void {
    const style = look.hairStyle;
    const segs = D.hair, rings = D.hairRings;
    const rx = 0.097 * hs * 1.1, ry = HEAD_RY * hs * (style === 'short' ? 1.1 : 1.07), rz = 0.08 * hs * 1.16;
    // lowest latitude of the shell (radians): at the FRONT (the fringe line), the SIDES (over / past the ear), the BACK (nape)
    const [loF, loS, loB] = style === 'short' ? [0.36, D.fine ? -0.16 : -0.45, -0.62] : style === 'bob' ? [0.18, -0.98, -0.98]
        : style === 'long' ? [0.24, -1.05, -1.05] : [0.26, D.fine ? -0.34 : -0.55, -0.66];
    const flare = style === 'bob' ? 0.16 : style === 'long' ? 0.06 : 0.0;
    const c: V3 = [hc[0] - 0.006, hc[1] + 0.012, 0];
    const partA = (((Math.round(look.heightM * 1000) + (look.fem ? 1 : 0)) & 1) ? 1 : -1) * 0.55;   // side-part azimuth
    const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
    const rows: V3[][] = [];
    const point = (i: number, kk: number, inset: number): V3 => {
        const a = (i / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const f = Math.min(1, Math.max(0, (ca - 0.1) / 0.6));        // 1 at the face
        const g = Math.min(1, Math.max(0, (-ca - 0.05) / 0.7));      // 1 at the back
        let lo = loS + (loF - loS) * f + (loB - loS) * g;
        if (D.fine) lo -= (style === 'short' ? 0.02 : 0.05) * f * (i % 2);   // piecey bangs / a textured short fringe
        const lat = Math.PI / 2 - (Math.PI / 2 - lo) * (kk / rings) + inset * 0.12;
        const cl = Math.cos(lat), sl = Math.sin(lat);
        const fl = 1 + flare * Math.max(0, -sl) * (1 - f);          // the ends kick out (bob)
        const back = ca < 0 ? 1 + 0.06 * -ca : 1;                    // a fuller back of the head
        const d = wrap(a - partA), groove = D.fine && kk / rings < 0.6 ? 1 - 0.035 * Math.exp(-(d * d) / 0.012) * (ca > -0.2 ? 1 : 0.4) : 1;
        const s = groove * (1 - inset * 0.1);
        return [c[0] + ca * cl * rx * back * fl * s, c[1] + sl * ry * s, c[2] + sa * cl * rz * fl * s];
    };
    for (let kk = 1; kk <= rings; kk++) rows.push(Array.from({ length: segs }, (_, i) => point(i, kk, 0)));
    if (D.fine) rows.push(Array.from({ length: segs }, (_, i) => point(i, rings, 1)));   // the edge turns in (thickness)
    const top = hair.vertex(P(T, c[0] - 0.004, c[1] + ry, 0), Nv(T, 0, 1, 0), 0.5, 0);
    const idx = gridSurface(hair, T, rows, -1, (k, i) => { const q = rows[k][i]; return norm3([(q[0] - c[0]) / rx, (q[1] - c[1]) / ry, (q[2] - c[2]) / rz]); });
    for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; hair.triangle(top, idx[0][j], idx[0][i]); }
    const side = D.small;
    if (style === 'long') {   // a curtain down the back to the shoulder blades, thin front-to-back, tapering (+ locks in front of the shoulders)
        sweep(hair, T, [[c[0] - 0.07 * hs, c[1] - 0.04, 0], [c[0] - 0.085 * hs, c[1] - 0.17, 0], [c[0] - 0.09 * hs, c[1] - 0.3, 0]],
            [0.05, 0.035, 0.022], [0.085, 0.085, 0.07], side, { ref: [1, 0, 0], capB: true, sub: D.fine ? 2 : 1 });
        if (D.fine) for (const s of [-1, 1] as const) sweep(hair, T, [[c[0] + 0.01 * hs, c[1] - 0.05, s * 0.083 * hs], [c[0] + 0.012 * hs, c[1] - 0.13, s * 0.088 * hs], [c[0] + 0.02 * hs, c[1] - 0.21, s * 0.095 * hs]],
            [0.02, 0.017, 0.01], [0.022, 0.02, 0.014], 6, { ref: [1, 0, 0], capB: true, sub: 2 });
    } else if (style === 'pony') {   // a tie at the back of the crown, the tail falls and tapers
        const b0: V3 = [c[0] - 0.1 * hs, c[1] + 0.02, 0];
        sweep(hair, T, [b0, [b0[0] - 0.02, b0[1] - 0.01, 0], [b0[0] - 0.045, b0[1] - 0.06, 0], [b0[0] - 0.048, b0[1] - 0.16, 0], [b0[0] - 0.03, b0[1] - 0.25, 0]],
            [0.028, 0.03, 0.033, 0.025, 0.008], null, side, { capA: true, sub: D.fine ? 2 : 1 });
    } else if (style === 'bun') {
        oellip(hair, T, [c[0] - 0.085 * hs, c[1] + 0.07 * hs, 0], norm3([-0.6, 0.8, 0]), [0, 0, 1], 0.045, 0.048, 0.05, D.fine ? 12 : 6, D.fine ? 7 : 4);
    }
}

/** One SHOE at `ankle` (person-local, rest frame; `pitch` rotates it with the shin): a sweep heel → counter → instep
 *  → ball → toe box → tip with a FLAT sole (the lower half of the section is shallow) and a little toe spring.
 *  Dress shoes are low with a slim toe, pumps slimmer still, sneakers chunkier and round, loafers in between; geta
 *  are a flat wooden sole under a bare foot (the foot goes in `foot`). */
function emitShoe(shoes: Accum3D, foot: Accum3D, T: PersonXf, look: PersonLook, ankle: V3, pitch: number, D: Detail, R?: (p: V3) => V3): void {
    const k = look.heightM / 1.70, w = look.build * (look.fem ? 0.92 : 1);
    const kind = look.shoe;
    const rot = R ?? ((p: V3): V3 => rotZ(p, ankle, pitch));
    const g = ankle[1] - ANKLE_Y * k;   // ground under the rest ankle
    const at = (x: number, h: number): V3 => rot([ankle[0] + x * k, g + h, ankle[2]]);
    if (kind === 'geta') {
        const sole = [at(-0.06, 0.018), at(0.08, 0.018), at(0.18, 0.018)];
        sweep(shoes, T, sole, [0.016, 0.016, 0.016], [0.045 * w, 0.048 * w, 0.042 * w], D.fine ? 6 : 4, { ref: [0, 1, 0], capA: true, capB: true });
        sweep(foot, T, [at(-0.04, 0.06), at(0.06, 0.05), at(0.16, 0.042)], [0.028, 0.022, 0.012], [0.03 * w, 0.038 * w, 0.03 * w], D.fine ? 8 : 5, { ref: [0, 1, 0], capA: true, capB: true, sub: D.fine ? 2 : 1 });
        return;
    }
    type SP = { x: number; h: number; wd: number };
    let prof: SP[];
    if (D.fine) prof =
        kind === 'sneaker' ? [{ x: -0.058, h: 0.04, wd: 0.038 }, { x: -0.04, h: 0.046, wd: 0.043 }, { x: 0.03, h: 0.05, wd: 0.047 }, { x: 0.105, h: 0.036, wd: 0.05 }, { x: 0.16, h: 0.027, wd: 0.043 }, { x: 0.182, h: 0.018, wd: 0.028 }]
            : kind === 'pump' ? [{ x: -0.052, h: 0.04, wd: 0.024 }, { x: -0.035, h: 0.045, wd: 0.029 }, { x: 0.03, h: 0.032, wd: 0.034 }, { x: 0.105, h: 0.022, wd: 0.038 }, { x: 0.155, h: 0.015, wd: 0.03 }, { x: 0.178, h: 0.009, wd: 0.016 }]
                : kind === 'loafer' ? [{ x: -0.058, h: 0.035, wd: 0.032 }, { x: -0.04, h: 0.04, wd: 0.037 }, { x: 0.03, h: 0.042, wd: 0.042 }, { x: 0.105, h: 0.029, wd: 0.045 }, { x: 0.16, h: 0.02, wd: 0.037 }, { x: 0.182, h: 0.013, wd: 0.022 }]
                    : [{ x: -0.06, h: 0.035, wd: 0.032 }, { x: -0.042, h: 0.04, wd: 0.037 }, { x: 0.03, h: 0.04, wd: 0.041 }, { x: 0.11, h: 0.027, wd: 0.043 }, { x: 0.165, h: 0.017, wd: 0.034 }, { x: 0.19, h: 0.01, wd: 0.02 }];
    else {
        const P4 = kind === 'sneaker' ? [{ x: -0.05, h: 0.045, wd: 0.042 }, { x: 0.11, h: 0.034, wd: 0.05 }, { x: 0.17, h: 0.024, wd: 0.038 }]
            : kind === 'pump' ? [{ x: -0.045, h: 0.045, wd: 0.028 }, { x: 0.11, h: 0.022, wd: 0.038 }, { x: 0.17, h: 0.013, wd: 0.022 }]
                : kind === 'loafer' ? [{ x: -0.05, h: 0.04, wd: 0.036 }, { x: 0.11, h: 0.028, wd: 0.045 }, { x: 0.172, h: 0.018, wd: 0.032 }]
                    : [{ x: -0.052, h: 0.04, wd: 0.036 }, { x: 0.115, h: 0.026, wd: 0.043 }, { x: 0.18, h: 0.014, wd: 0.028 }];
        prof = P4;
    }
    // section: total height 2h over a 4 mm sole line; the lower (sole) half is shallow (flat bottom, rounded welt)
    const n = prof.length;
    const hd = (p: SP): number => p.h * (D.fine ? 0.42 : 1), hu = (p: SP): number => 2 * p.h - hd(p);
    const spring = (i: number): number => D.fine && i === n - 1 ? 0.005 : 0;
    sweep(shoes, T, prof.map((p, i) => at(p.x, 0.004 + hd(p) + spring(i))), prof.map(hu), prof.map(p => p.wd * w), D.shoe,
        { ref: [0, 1, 0], capA: true, capB: true, down: prof.map(hd) });
}

/** One standing leg + shoe for a (hip angle `th`, knee flex `kf`). The thigh goes to `thigh`, the shin to `shin`
 *  (static people: the same merged accumulator; walkers: separate meshes). `pivots` (walkers) builds the thigh in
 *  HIP-pivot space and the shin + shoe in KNEE-pivot space (angles 0), each with a domed knee end so a bent knee
 *  never opens a gap. Bare legs (under a skirt / yukata) are shapely — a full thigh, a narrow knee, a calf that
 *  bulges at the back, a slim ankle; trousers are straighter and break over the shoe with a turned hem. A yukata
 *  hides the thigh, so only the shin + geta are built. */
function emitLeg(thigh: Accum3D, shin: Accum3D, shoes: Accum3D, T: PersonXf, look: PersonLook, side: -1 | 1, pivots: { hip: V3; knee: V3 } | null,
    th: number, kf: number, D: Detail): void {
    const k = look.heightM / 1.70, w = look.build, hz = side * hipHalf(look), ls = D.limb, sub = D.lsub;
    const hip: V3 = [0, HIP_Y * k, hz], knee: V3 = [0.014 * k, KNEE_Y * k, hz * 0.97], ankle: V3 = [0, ANKLE_Y * k, hz * 0.93];
    const Rt = (p: V3): V3 => { const r = rotZ(p, hip, th); return pivots ? sub3(r, pivots.hip) : r; };
    const Rs = (p: V3): V3 => { const r = rotZ(rotZ(p, knee, -kf), hip, th); return pivots ? sub3(r, pivots.knee) : r; };
    const bare = !!look.skirt || look.garment === 'robe';
    const at = (a: V3, b: V3, t: number, dx = 0): V3 => { const p = lerp3(a, b, t); return [p[0] + dx, p[1], p[2]]; };
    const dome = !!pivots && D.fine;
    if (look.garment !== 'robe') {
        const top: V3 = [0, (HIP_Y + 0.035) * k, hz * 0.8];
        if (!D.fine) {
            const r = bare ? [0.064, 0.058, 0.043] : [0.067, 0.064, 0.055];
            sweep(thigh, T, bare ? [Rt(top), Rt(knee)] : [Rt(top), Rt(at(hip, knee, 0.45)), Rt(knee)], (bare ? [r[0], r[2]] : r).map(v => v * w), null, ls);
        } else if (bare) {
            sweep(thigh, T, [Rt(top), Rt(at(hip, knee, 0.35, 0.004)), Rt(at(hip, knee, 0.75, 0.003)), Rt(knee)], [0.066, 0.061, 0.05, 0.043].map(v => v * w), null, ls, { sub, capB: dome });
        } else {
            sweep(thigh, T, [Rt(top), Rt(at(hip, knee, 0.45)), Rt(knee)], [0.069, 0.064, 0.055].map(v => v * w), null, ls, { sub, capB: dome });
        }
    }
    let pts: V3[], radii: number[];
    if (!D.fine) {
        const calf = at(knee, ankle, 0.3, -0.008 * k), low = at(knee, ankle, 0.72);
        const p4 = look.garment === 'robe' ? [at(knee, ankle, 0.2), calf, low, ankle] : [knee, calf, low, ankle];
        const r4 = bare ? [0.042, 0.047, 0.031, 0.024] : [0.055, 0.053, 0.05, 0.051];
        const keep = bare ? [0, 1, 3] : [0, 2, 3];   // trousers drop the calf ring (straight legs), bare legs the lower shin
        pts = keep.map(i => p4[i]); radii = keep.map(i => r4[i]);
    } else if (bare) {
        const k0 = look.garment === 'robe' ? at(knee, ankle, 0.2) : knee;
        pts = [k0, at(knee, ankle, 0.12, -0.003 * k), at(knee, ankle, 0.32, -0.009 * k), at(knee, ankle, 0.58, -0.004 * k), at(knee, ankle, 0.8), ankle];
        radii = [0.042, 0.044, 0.049, 0.04, 0.029, 0.023];
        if (look.garment === 'robe') { pts = pts.slice(1); radii = radii.slice(1); }
    } else {
        pts = [knee, at(knee, ankle, 0.3), at(knee, ankle, 0.72), ankle];
        radii = [0.055, 0.054, 0.051, 0.053];
    }
    sweep(shin, T, pts.map(Rs), radii.map(v => v * w), null, ls, { sub: D.fine ? sub : 1, capA: dome && look.garment !== 'robe', lipB: D.fine && !bare ? 0.12 : 0 });
    emitShoe(shoes, shin, T, look, ankle, 0, D, Rs);
}

/** A mamachari-style BICYCLE in person-local metres (ring wheels ~0.66 m, frame, saddle, bars, front basket), nose
 *  along +X. Used by the cyclist walkers (the rider stands on it at saddle height) and by parked bikes. */
export function emitBicycle(frame: Accum3D, tyre: Accum3D, T: PersonXf, opts: { basket?: boolean } = {}): void {
    const r = 0.33, wb = 0.53, ringSegs = 10;
    const ring = (cx: number): void => {
        for (let i = 0; i < ringSegs; i++) {
            const a0 = (i / ringSegs) * Math.PI * 2, a1 = ((i + 1) / ringSegs) * Math.PI * 2;
            tube(tyre, T, [cx + Math.cos(a0) * r, r + Math.sin(a0) * r, 0], [cx + Math.cos(a1) * r, r + Math.sin(a1) * r, 0], 0.022, 0.022, 3);
        }
        tube(frame, T, [cx, r, -0.035], [cx, r, 0.035], 0.02, 0.02, 4);   // hub
    };
    ring(wb); ring(-wb);
    const bb: V3 = [-0.02, 0.3, 0], seat: V3 = [-0.2, 0.86, 0], head: V3 = [0.4, 0.86, 0], fh: V3 = [wb, r, 0], rh: V3 = [-wb, r, 0];
    for (const [a, b] of [[rh, bb], [bb, seat], [rh, seat], [bb, head], [seat, [0.38, 0.8, 0] as V3], [head, fh]] as [V3, V3][]) tube(frame, T, a, b, 0.02, 0.02, 3);
    box(frame, T, [-0.22, 0.9, 0], 0.12, 0.025, 0.06);                                     // saddle
    tube(frame, T, [0.42, 1.0, -0.26], [0.42, 1.0, 0.26], 0.016, 0.016, 3);               // handlebar
    tube(frame, T, [0.4, 0.86, 0], [0.42, 1.0, 0], 0.018, 0.018, 3);
    if (opts.basket) box(frame, T, [0.6, 0.86, 0], 0.13, 0.1, 0.17);                      // front basket
}

/** A tapered TUBE between two local points (bicycle frames). Open ends. */
function tube(acc: Accum3D, T: PersonXf, a: V3, b: V3, r0: number, r1: number, sides: number): void {
    sweep(acc, T, [a, b], [r0, r1], null, sides, { ref: Math.abs(b[1] - a[1]) > 0.7 * Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) ? [1, 0, 0] : [0, 1, 0] });
}

// ── Walker archetype geometry (instanced movers) ─────────────────────────────────────────────────
export interface WalkerParts {
    /** Body layers that move rigidly with the walker (name suffix → colour → geometry). */
    body: { part: string; color: RGB; pc: PedColor; acc: Accum3D }[];
    /** The two THIGH geometries (hip-pivot space) + their colour. (For a yukata: the whole visible lower leg.) */
    leg: { color: RGB; pc: PedColor; accL: Accum3D; accR: Accum3D };
    /** The two SHIN geometries (knee-pivot space, the shoe included when it shares the leg colour) — null for a
     *  yukata (its legs swing whole, no knee bend). */
    shin: { accL: Accum3D; accR: Accum3D } | null;
    /** Separate SHOE geometries (knee-pivot space, ride with the shin) when the shoes differ from the legs. */
    shoe: { color: RGB; pc: PedColor; accL: Accum3D; accR: Accum3D } | null;
    /** The FREE arms (shoulder-pivot space, sleeve colour) — null for an arm that holds something (phone / umbrella /
     *  briefcase / tote / handlebar), which stays in the rigid body. */
    arm: { color: RGB; pc: PedColor; accL: Accum3D | null; accR: Accum3D | null };
    /** The free arms' HANDS (+ bare forearm) in skin, shoulder-pivot space — they swing with their arm. */
    hand: { accL: Accum3D | null; accR: Accum3D | null };
    pivotY: number; pivotZ: number;   // hip joint, metres (×units in the caller)
    armY: number; armZ: number;       // shoulder joint, metres
    /** Knee (rest) relative to the hip + heel / toe relative to the knee (metres) — the ticker bends the knee and
     *  keeps the lower foot on the ground with these. Null for a yukata. */
    knee: { x: number; y: number; heel: [number, number]; toe: [number, number] } | null;
    /** Leg swing amplitude (radians) — shorter steps in a skirt, tiny ones in a yukata. */
    amp: number;
}

/** Build a walker's part geometries at the origin facing +X, in WORLD units (`u` = world units per metre). */
export function walkerParts(look: PersonLook, u: number, umbrella: PedColor | null, bike = false): WalkerParts {
    const accs = new Map<string, { part: string; color: RGB; pc: PedColor; acc: Accum3D }>();
    const get = (part: string, color: PedColor): Accum3D => {
        const key = part + ':' + color;
        let e = accs.get(key);
        if (!e) { e = { part, color: PED_PALETTE[color], pc: color, acc: new Accum3D() }; accs.set(key, e); }
        return e.acc;
    };
    const lift = bike ? 0.1 : 0;    // a cyclist sits at saddle height (hip just above the 0.9 m saddle)
    const T: PersonXf = { o: [0, lift * u, 0], f: [1, 0], u };
    const pose: Pose = bike ? 'ride' : 'stand';
    const free = (side: -1 | 1): boolean => armHold(look, pose, side, umbrella) === 'free';
    const noAcc = new Accum3D();
    const lean = bike ? 0.12 : 0.035;
    // Accessories fold into an existing same-colour part (hat in the top / hair / bag colour → no extra mesh).
    const extra = (c: PedColor): Accum3D => c === look.top ? get('top', c) : c === look.hair ? get('hair', c) : get('bag', c);
    emitPerson({
        top: () => get('top', look.top), skin: () => get('skin', 'skin'), hair: () => get('hair', look.hair),
        leg: () => noAcc, shoes: () => noAcc,
        skirt: () => look.skirt ? get('skirt', look.skirt) : null, bag: () => get('bag', look.bagColor),
        umbrella: () => umbrella ? get('umbrella', umbrella) : null, collar: () => look.collar && look.collar !== look.top ? get('collar', look.collar) : null, extra,
    }, T, look, { umbrella, legs: false, lod: 0, pose, skipArm: free, lean });
    // Legs are authored in their OWN pivot frames — the thigh about the hip joint, the shin (+ shoe) about the knee —
    // so the ticker swings the thigh and bends the knee. Free arms likewise in shoulder-pivot space (sleeve + a
    // separate skin hand mesh that swings with it).
    const LT: PersonXf = { o: [0, 0, 0], f: [1, 0], u };
    const robe = look.garment === 'robe';
    const shoeSep = look.shoes !== look.legs && lum(PED_PALETTE[look.shoes]) + lum(PED_PALETTE[look.legs]) > 0.18;
    const th = { [-1]: new Accum3D(), [1]: new Accum3D() }, sh = { [-1]: new Accum3D(), [1]: new Accum3D() }, so = { [-1]: new Accum3D(), [1]: new Accum3D() };
    for (const side of [-1, 1] as const) {
        const pv = { hip: legPivot(look, side), knee: robe ? legPivot(look, side) : kneePivot(look, side) };
        const shinAcc = robe ? th[side] : sh[side];
        emitLeg(th[side], shinAcc, shoeSep ? so[side] : shinAcc, LT, look, side, pv, 0, 0, detailFor(0));
    }
    const arms: [Accum3D | null, Accum3D | null] = [null, null], hands: [Accum3D | null, Accum3D | null] = [null, null];
    const LU: PersonXf = { ...LT };
    for (const side of [-1, 1] as const) {
        if (!free(side)) continue;
        const a = new Accum3D(), hnd = new Accum3D();
        emitArm(a, hnd, LU, look, 'free', side, 0, 0, detailFor(0), armPivot(look, side));
        arms[side > 0 ? 1 : 0] = a; hands[side > 0 ? 1 : 0] = hnd;
    }
    if (bike) emitBicycle(get('bike', 'charcoal'), get('tyre', 'black'), { o: [0, 0, 0], f: [1, 0], u }, { basket: true });
    const pv = legPivot(look, 1), ap = armPivot(look, 1), kp = kneePivot(look, 1), kk = look.heightM / 1.70;
    const amp = robe ? 0.16 : look.skirt ? 0.32 : 0.4;
    const ank: V3 = [0, ANKLE_Y * kk, 0];
    return {
        body: [...accs.values()], leg: { color: PED_PALETTE[look.legs], pc: look.legs, accL: th[-1], accR: th[1] },
        shin: robe ? null : { accL: sh[-1], accR: sh[1] },
        shoe: shoeSep ? { color: PED_PALETTE[look.shoes], pc: look.shoes, accL: so[-1], accR: so[1] } : null,
        arm: { color: PED_PALETTE[look.top], pc: look.top, accL: arms[0], accR: arms[1] },
        hand: { accL: hands[0], accR: hands[1] },
        pivotY: pv[1] + lift, pivotZ: pv[2], armY: ap[1] + lift, armZ: ap[2],
        knee: robe ? null : {
            x: kp[0] - pv[0], y: kp[1] - pv[1],
            heel: [ank[0] + HEEL[0] * kk - kp[0], ank[1] + HEEL[1] * kk - kp[1]],
            toe: [ank[0] + TOE[0] * kk - kp[0], ank[1] + TOE[1] * kk - kp[1]],
        },
        amp,
    };
}
const lum = (c: RGB): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
