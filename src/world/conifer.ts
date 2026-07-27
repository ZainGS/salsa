// ── Foliage primitive: CONIFER (whorl-tiered cone) ──────────────────────────────────────────────
// The library's woody archetype (`branch`) grows a broadleaf: a gnarled trunk splitting into limbs that
// curve UP toward the light, with leaf masses at the twig tips. A conifer is the opposite shape and
// cannot be reached by re-tuning it — which is why the city's "conifer" was, until this, a narrowed
// small-tree with an honest disclaimer attached.
//
// What actually makes a conifer read:
//   · a single STRAIGHT LEADER running unbroken to the apex (a broadleaf's trunk disappears into its
//     limbs; a spruce's does not — you can trace it to the tip),
//   · branches in WHORLS — discrete tiers up the trunk, not a continuous scatter,
//   · a tier radius that shrinks toward the apex, giving the cone silhouette,
//   · branches that ANGLE DOWN, and more steeply the lower (and therefore older) the tier,
//   · NEEDLE SPRAYS carried along each branch's length rather than a mass at the tip.
// All five come from the whorl-tier loop below. The needles reuse `emitBlade` with the `pointed` width
// profile; the trunk and branches reuse `emitTube`, so nothing new was invented for the geometry itself.

import type { Accum3D } from './meshbuild';
import { emitTube } from './stalk';
import { emitBlade, type BladeParams } from './blade';
import { bezierSpine, sweepFrames } from './curve-frame';

/** Evenly spaced sweep stations — sweepFrames takes explicit (ascending) params. */
const stations = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

type V3 = [number, number, number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface ConiferSpec {
    /** Total height, metres. */
    height: number;
    /** Widest tier radius as a fraction of height (a spruce ≈ 0.22, a cypress ≈ 0.08). */
    spread: number;
    /** Number of whorls. */
    tiers: number;
    /** Branches per whorl (the lowest tier; upper tiers thin out). */
    perTier: number;
    /** Fraction of the height that is bare trunk before the first whorl. */
    bareTrunk: number;
    /** How far branches angle DOWN at the lowest tier, radians below horizontal. */
    droop: number;
    /** Needle spray length as a fraction of the branch length. */
    needle: number;
    /** Trunk radius at the base, metres. */
    trunkRadius: number;
    /** Sideways lean of the leader, 0 = ruler straight. */
    lean: number;
    /** Tube sides for trunk/branches — 3 is enough at city scale. */
    sides: number;
    /** 0..1 needle fullness — sprays per branch. The single knob that decides sparse vs lush. */
    needleDensity: number;
}

export const DEFAULT_CONIFER: ConiferSpec = {
    height: 7, spread: 0.2, tiers: 7, perTier: 6, bareTrunk: 0.16,
    droop: 0.42, needle: 0.55, trunkRadius: 0.085, lean: 0.06, sides: 3, needleDensity: 0.8,
};

export function resolveConifer(partial: Partial<ConiferSpec> = {}): ConiferSpec {
    return { ...DEFAULT_CONIFER, ...partial };
}

export interface ConiferResult {
    /** Measured apex height (metres). */
    height: number;
    /** Measured widest radius (metres). */
    radius: number;
    /** Needle strips emitted (for the leaf budget). */
    needles: number;
}

/** Hard cap so a high tier/branch count can never explode a city's geometry budget. */
const MAX_NEEDLES = 900;

/**
 * Emit a conifer at `base`. `trunk` takes the leader + branch tubes; `leaf`/`tip` take the needle sprays
 * (tip = the lighter new-growth colour near each spray's end, same convention as every other archetype).
 */
export function emitConifer(
    trunk: Accum3D, leaf: Accum3D, tip: Accum3D | null,
    base: V3, spec: ConiferSpec, rnd: () => number,
): ConiferResult {
    const H = Math.max(0.2, spec.height);
    const tiers = Math.max(2, Math.round(spec.tiers));
    const perTier = Math.max(3, Math.round(spec.perTier));
    const bare = Math.min(0.6, Math.max(0, spec.bareTrunk));
    const maxR = Math.max(0.02, spec.spread * H);
    const sides = Math.max(3, Math.round(spec.sides));

    // ── LEADER: one spine from base to apex, unbroken. A slight lean keeps it off ruler-straight without
    // ever forking — forking is precisely what would make it read as a broadleaf.
    const lx = (rnd() - 0.5) * spec.lean * H, lz = (rnd() - 0.5) * spec.lean * H;
    const apex: V3 = [base[0] + lx, base[1] + H, base[2] + lz];
    const mid: V3 = [base[0] + lx * 0.35, base[1] + H * 0.5, base[2] + lz * 0.35];
    const spine = bezierSpine(base, mid, apex);
    emitTube(trunk, sweepFrames(spine, stations(6)), spec.trunkRadius, spec.trunkRadius * 0.12, sides);

    // Position along the leader at parameter t (0 = base, 1 = apex).
    const along = (t: number): V3 => [base[0] + lx * t, base[1] + H * t, base[2] + lz * t];

    let needles = 0;
    let widest = 0;
    for (let ti = 0; ti < tiers; ti++) {
        // u = 0 at the lowest whorl, 1 at the apex.
        const u = tiers === 1 ? 0 : ti / (tiers - 1);
        const t = bare + (1 - bare) * u;
        const o = along(t);
        // Tier radius tapers to nothing at the apex. The slight power curve keeps the lower skirt full
        // instead of making the profile a straight-sided triangle.
        const tierR = maxR * Math.pow(1 - u, 0.78);
        if (tierR < 0.02) continue;
        widest = Math.max(widest, tierR);
        // Upper whorls carry fewer branches — a real crown thins as it narrows.
        const n = Math.max(3, Math.round(perTier * (1 - u * 0.45)));
        const phase = rnd() * Math.PI * 2;                       // whorls do not line up vertically
        // Lower (older) branches hang further. This gradient is most of the silhouette.
        const drop = spec.droop * (1 - u * 0.55);
        for (let bi = 0; bi < n; bi++) {
            const a = phase + (bi / n) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
            const len = tierR * (0.85 + rnd() * 0.3);
            const dx = Math.cos(a), dz = Math.sin(a);
            const endY = o[1] - Math.sin(drop) * len;
            const end: V3 = [o[0] + dx * len, endY, o[2] + dz * len];
            // A gentle sag: the mid control sits ABOVE the chord, so the branch leaves the trunk near
            // horizontal and droops toward its tip rather than being a straight spoke.
            const bm: V3 = [o[0] + dx * len * 0.5, o[1] - Math.sin(drop) * len * 0.18, o[2] + dz * len * 0.5];
            const bf = sweepFrames(bezierSpine(o, bm, end), stations(3));
            emitTube(trunk, bf, spec.trunkRadius * 0.22 * (1 - u * 0.5), spec.trunkRadius * 0.05, 3);

            // NEEDLE SPRAYS along the branch — not a blob at the tip. ★ Sprays run most of the branch's
            // length and scale with density. Two fixed sprays per branch gave a foliage:wood triangle ratio
            // of 1.7 against a broadleaf's 9.3 — i.e. a conifer was mostly visible stick, which is what
            // "bare and sparse" was. `density` also did almost nothing (it only moved the branch count, so
            // 0.5 -> 1.0 changed needle mass by 27%); now it drives the sprays too.
            if (needles >= MAX_NEEDLES) continue;
            const sprays = 3 + Math.round(clamp01(spec.needleDensity) * 4);
            for (let si = 0; si < sprays && needles < MAX_NEEDLES; si++) {
                // Spread from near the trunk to the very tip; a bare inner branch reads as a dead tree.
                const st = 0.18 + (si + 0.5) / sprays * 0.78;
                // Alternate the sprays either side of the branch line so they do not stack colinearly.
                const swing = (si % 2 === 0 ? 1 : -1) * 0.35;
                const sx = dx * Math.cos(swing) - dz * Math.sin(swing);
                const sz = dx * Math.sin(swing) + dz * Math.cos(swing);
                const p: V3 = [o[0] + dx * len * st, o[1] - Math.sin(drop) * len * st, o[2] + dz * len * st];
                const nb: BladeParams = {
                    length: len * spec.needle * (0.85 + rnd() * 0.45),
                    width: len * 0.2,
                    taper: 1, curve: 0.5 + rnd() * 0.3, segments: 3,
                    twist: (rnd() - 0.5) * 0.6, foldAngle: 0.42, lean: 0.5,
                    shape: 'pointed',
                    pitch: Math.PI * 0.5 + drop * 0.6,     // lie along the branch, angled down
                    axis: [0, 1, 0],
                };
                emitBlade(leaf, tip, 0.62, p, sx, sz, nb);
                needles++;
            }
        }
    }

    // APEX SPIKE — the leader's exposed last stretch. Without it the top reads snapped off.
    if (needles < MAX_NEEDLES) {
        const p = along(bare + (1 - bare) * 0.995);
        emitBlade(leaf, tip, 0.5, p, (rnd() - 0.5) || 0.5, (rnd() - 0.5) || 0.5, {
            length: maxR * 0.9, width: maxR * 0.16, taper: 1, curve: 0.06, segments: 3,
            twist: 0, foldAngle: 0.35, lean: 0.05, shape: 'pointed', axis: [0, 1, 0],
        });
        needles++;
    }
    return { height: H, radius: widest, needles };
}
