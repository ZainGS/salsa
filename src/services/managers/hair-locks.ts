/**
 * hair-locks.ts — the anime hair STYLE system (docs/specs/hair-styles.md phases B–E, `hairMode: 'locks'`).
 *
 * The hair is built from a few dozen big shaped LOCKS (tapered lens-section ribbons with a clean silhouette) laid
 * over a solid scalp shell, instead of hundreds of alpha cards (ragged / noisy) or one dome (a helmet):
 *
 *   • shell     — a solid shell hugging the real skull (no scalp shows between locks)
 *   • crown     — locks from the crown down the sides + back; per-region length, 1–2 overlapping layers whose
 *                 pointed tips end at different heights (the layered anime silhouette), flick in / out
 *   • fringe    — bang locks over the forehead: straight · swept · parted · choppy · none (slicked back)
 *   • side locks— face-framing locks in front of the ears
 *   • tails     — pony / twin / pig tails as a bundle of locks around a swept spine (spring-bone tagged)
 *   • gather    — pulled-back hair: the crown locks run from the hairline into the tail / bun tie
 *   • bun, ahoge
 *
 * Every lock surface hugs a RADIAL MAP of the real head (sampled from the body's rest verts) plus a volume offset,
 * so the hair sits on the sculpted skull, not on the head's bounding ellipsoid (the nose / jaw stretch that). The
 * caller (generateHair) then runs the same body + clothing shrink-wrap as the other modes.
 *
 * Lengths are factors of the head radius (scale-free), heights are × ry relative to the head centre (the eye line
 * is ≈ +0.05..+0.15, the brows ≈ +0.25, the chin ≈ −0.8). Pure + deterministic (seeded per-lock jitter).
 */

import type { HairParams, HeadFrame } from './hair-generator';
import { perpFrame, rotAxis } from '../../world/curve-frame';

type V3 = [number, number, number];

/** The vertex accumulator generateHair builds into (structurally = hair-generator's Accum). */
export interface LockAccum {
    pos: number[]; nrm: number[]; uv: number[]; idx: number[]; count: number;
    tailId: number[]; curTailId: number; nLock: number[]; curLock: boolean; tanDir: number[]; curTan: V3;
}

// ── vec3 helpers ──
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
const clamp01 = (x: number): number => clamp(x, 0, 1);
const smooth = (a: number, b: number, x: number): number => { const t = clamp01((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
/** Deterministic hash → [0,1). */
const hash11 = (n: number): number => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const jit = (n: number): number => hash11(n) * 2 - 1;

// ═══════════════════════════════════════════════════════════════════════════
//  Style parameters (all optional on HairParams; these are the fallbacks)
// ═══════════════════════════════════════════════════════════════════════════

export type FringeStyle = 'straight' | 'swept' | 'parted' | 'choppy' | 'none';

/** Resolved lock-style parameters (every field filled). */
interface LockStyle {
    fringeStyle: FringeStyle; fringeCount: number; fringeHeight: number; fringeSide: number;
    hairLength: number; sideLength: number;
    lockCount: number; lockWidth: number; lockThickness: number; lockVolume: number; lockTaper: number;
    lockLayers: number; lockFlick: number; lockJitter: number; lockSeed: number;
    tailLocks: number; ahoge: number; gather: boolean;
    lockCurl: number; lockCurlType: 'wave' | 'spiral'; lockCurlFreq: number; lockSpike: number; hairPoof: number;
    tailForm: 'bundle' | 'braid' | 'drill'; drillTurns: number;
}

export const LOCK_STYLE_DEFAULTS: LockStyle = {
    fringeStyle: 'choppy', fringeCount: 7, fringeHeight: 0.3, fringeSide: 0.6,
    hairLength: 0.9, sideLength: 0.8,
    lockCount: 15, lockWidth: 1, lockThickness: 0.28, lockVolume: 0.13, lockTaper: 0.75,
    lockLayers: 2, lockFlick: 0, lockJitter: 0.25, lockSeed: 0,
    tailLocks: 5, ahoge: 0, gather: false,
    lockCurl: 0, lockCurlType: 'wave', lockCurlFreq: 2, lockSpike: 0, hairPoof: 0, tailForm: 'bundle', drillTurns: 4,
};

function resolveStyle(p: HairParams): LockStyle {
    const d = LOCK_STYLE_DEFAULTS;
    const num = (v: unknown, dv: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dv);
    const fs = String(p.fringeStyle ?? d.fringeStyle).toLowerCase().trim();
    return {
        fringeStyle: (['straight', 'swept', 'parted', 'choppy', 'none'].includes(fs) ? fs : d.fringeStyle) as FringeStyle,
        fringeCount: Math.round(clamp(num(p.fringeCount, d.fringeCount), 2, 13)),
        fringeHeight: clamp(num(p.fringeHeight, d.fringeHeight), -0.6, 0.8),
        fringeSide: clamp(num(p.fringeSide, d.fringeSide), -1, 1),
        hairLength: clamp(num(p.hairLength, d.hairLength), 0, 5),
        sideLength: clamp(num(p.sideLength, d.sideLength), 0, 5),
        lockCount: Math.round(clamp(num(p.lockCount, d.lockCount), 6, 28)),
        lockWidth: clamp(num(p.lockWidth, d.lockWidth), 0.5, 2),
        lockThickness: clamp(num(p.lockThickness, d.lockThickness), 0.08, 0.8),
        lockVolume: clamp(num(p.lockVolume, d.lockVolume), 0, 0.45),
        lockTaper: clamp01(num(p.lockTaper, d.lockTaper)),
        lockLayers: Math.round(clamp(num(p.lockLayers, d.lockLayers), 1, 2)),
        lockFlick: clamp(num(p.lockFlick, d.lockFlick), -1, 1),
        lockJitter: clamp01(num(p.lockJitter, d.lockJitter)),
        lockSeed: Math.round(num(p.lockSeed, d.lockSeed)),
        tailLocks: Math.round(clamp(num(p.tailLocks, d.tailLocks), 3, 8)),
        ahoge: Math.round(clamp(num(p.ahoge, d.ahoge), 0, 2)),
        gather: p.gather === true,
        lockCurl: clamp01(num(p.lockCurl, d.lockCurl)),
        lockCurlType: String(p.lockCurlType ?? d.lockCurlType).toLowerCase() === 'spiral' ? 'spiral' : 'wave',
        lockCurlFreq: clamp(num(p.lockCurlFreq, d.lockCurlFreq), 0.5, 6),
        lockSpike: clamp01(num(p.lockSpike, d.lockSpike)),
        hairPoof: clamp01(num(p.hairPoof, d.hairPoof)),
        tailForm: ((f: string) => (f === 'braid' || f === 'drill' ? f : 'bundle'))(String(p.tailForm ?? d.tailForm).toLowerCase().trim()),
        drillTurns: clamp(num(p.drillTurns, d.drillTurns), 2, 7),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Head surface: a radial map of the real head (normalised ellipsoid space)
// ═══════════════════════════════════════════════════════════════════════════

const MAP_T = 18, MAP_P = 36;

/** The head the locks hug: centre + radii, a radial map ρ(θ, φ) (1 = the bbox ellipsoid) and the body's back
 *  profile (for routing long hair behind the shoulders). */
interface Head {
    c: V3; R: V3;
    rho: Float32Array;            // MAP_T × MAP_P, ρ of the skull along each direction (normalised space)
    backZ: (y: number) => number; // the body's back surface z at height y (min z near the centre line)
}

function buildHead(h: HeadFrame, body: Float32Array | undefined): Head {
    const c: V3 = [h.cx, h.cy, h.cz], R: V3 = [h.rx, h.ry, h.rz];
    const rho = new Float32Array(MAP_T * MAP_P).fill(0);
    if (body && body.length >= 12) {
        const n = body.length / 12;
        for (let i = 0; i < n; i++) {
            const x = (body[i * 12] - c[0]) / R[0], y = (body[i * 12 + 1] - c[1]) / R[1], z = (body[i * 12 + 2] - c[2]) / R[2];
            if (y < -0.35) continue;                                  // the head above the jaw (no shoulders / neck)
            const r = Math.hypot(x, y, z);
            if (r < 0.3 || r > 1.45) continue;
            const th = Math.acos(clamp(y / r, -1, 1)), ph = Math.atan2(z, x);
            const ti = Math.min(MAP_T - 1, Math.floor((th / Math.PI) * MAP_T));
            const pi = ((Math.floor(((ph + Math.PI) / (Math.PI * 2)) * MAP_P) % MAP_P) + MAP_P) % MAP_P;
            const k = ti * MAP_P + pi;
            if (r > rho[k]) rho[k] = r;
        }
    }
    // Fill empty bins (no body / the open neck below): the ellipsoid (1) above the equator, the bin above below it.
    for (let ti = 0; ti < MAP_T; ti++) for (let pi = 0; pi < MAP_P; pi++) {
        const k = ti * MAP_P + pi;
        if (rho[k] > 0) continue;
        rho[k] = ti > 0 && (ti + 0.5) / MAP_T > 0.5 ? rho[(ti - 1) * MAP_P + pi] || 0.95 : 0.95;
    }
    // Smooth (wrap in φ) so a lock rides the skull's shape, not individual vertices; keep within sane bounds.
    for (let it = 0; it < 2; it++) {
        const src = rho.slice();
        for (let ti = 0; ti < MAP_T; ti++) for (let pi = 0; pi < MAP_P; pi++) {
            let s = 0, w = 0;
            for (let dt = -1; dt <= 1; dt++) for (let dp = -1; dp <= 1; dp++) {
                const tj = ti + dt; if (tj < 0 || tj >= MAP_T) continue;
                const pj = (pi + dp + MAP_P) % MAP_P, ww = dt === 0 && dp === 0 ? 2 : 1;
                s += src[tj * MAP_P + pj] * ww; w += ww;
            }
            rho[ti * MAP_P + pi] = Math.max(src[ti * MAP_P + pi] * 0.92, s / w);   // smooth, but never sink far into the skull
        }
    }
    for (let k = 0; k < rho.length; k++) rho[k] = clamp(rho[k], 0.72, 1.12);
    let backZ = (_y: number): number => c[2] - R[2] * 1.0;
    if (body && body.length >= 12) {
        const n = body.length / 12;
        backZ = (y: number): number => {
            let m = Infinity;
            for (let i = 0; i < n; i++) {
                if (Math.abs(body[i * 12 + 1] - y) > R[1] * 0.35) continue;
                if (Math.abs(body[i * 12] - c[0]) > R[0] * 1.5) continue;
                m = Math.min(m, body[i * 12 + 2]);
            }
            return Number.isFinite(m) ? m : c[2] - R[2];
        };
    }
    return { c, R, rho, backZ };
}

/** Unit direction (normalised ellipsoid space) for polar θ (0 = top) and azimuth φ (0 = +x, π/2 = front +z). */
const dirOf = (th: number, ph: number): V3 => [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];

function rhoAt(H: Head, d: V3): number {
    const th = Math.acos(clamp(d[1], -1, 1)), ph = Math.atan2(d[2], d[0]);
    const ft = clamp((th / Math.PI) * MAP_T - 0.5, 0, MAP_T - 1);
    const fp = ((ph + Math.PI) / (Math.PI * 2)) * MAP_P - 0.5;
    const t0 = Math.floor(ft), t1 = Math.min(MAP_T - 1, t0 + 1), wt = ft - t0;
    const p0 = Math.floor(fp), wp = fp - p0;
    const pa = ((p0 % MAP_P) + MAP_P) % MAP_P, pb = (pa + 1) % MAP_P;
    const g = (t: number, p: number) => H.rho[t * MAP_P + p];
    return lerp(lerp(g(t0, pa), g(t0, pb), wp), lerp(g(t1, pa), g(t1, pb), wp), wt);
}

/** A point `off` (× the head radius) above the real skull along direction d. */
function onHead(H: Head, d: V3, off: number): V3 {
    const r = rhoAt(H, d) + off;
    return [H.c[0] + d[0] * H.R[0] * r, H.c[1] + d[1] * H.R[1] * r, H.c[2] + d[2] * H.R[2] * r];
}

function slerp(a: V3, b: V3, s: number): V3 {
    const d = clamp(dot(a, b), -1, 1), om = Math.acos(d);
    if (om < 1e-4) return norm(lerp3(a, b, s));
    const so = Math.sin(om);
    return norm(add(scl(a, Math.sin((1 - s) * om) / so), scl(b, Math.sin(s * om) / so)));
}

/** The "volume" normal of the hair mass at p: spherical over the head, cylindrical (horizontal) below its centre. */
function volNormal(H: Head, p: V3): V3 {
    const x = (p[0] - H.c[0]) / H.R[0], y = (p[1] - H.c[1]) / H.R[1], z = (p[2] - H.c[2]) / H.R[2];
    const v: V3 = [x, Math.max(0, y) + Math.min(0, y) * 0.08, z];
    return len(v) < 1e-5 ? [0, 0, -1] : norm(v);
}

// ═══════════════════════════════════════════════════════════════════════════
//  The lock primitive
// ═══════════════════════════════════════════════════════════════════════════

function pushV(ac: LockAccum, p: V3, n: V3, u: number, v: number): number {
    ac.pos.push(p[0], p[1], p[2]); ac.nrm.push(n[0], n[1], n[2]); ac.uv.push(u, v);
    ac.tailId.push(ac.curTailId); ac.nLock.push(ac.curLock ? 1 : 0);
    ac.tanDir.push(ac.curTan[0], ac.curTan[1], ac.curTan[2]);
    return ac.count++;
}

/** Resample a polyline evenly by arc length into n+1 points; also returns the cumulative length. */
function resample(pts: V3[], n: number): { pts: V3[]; length: number } {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
    const L = cum[cum.length - 1];
    if (L < 1e-6) return { pts: Array.from({ length: n + 1 }, () => [...pts[0]] as V3), length: 0 };
    const out: V3[] = [];
    let j = 0;
    for (let i = 0; i <= n; i++) {
        const s = (i / n) * L;
        while (j < cum.length - 2 && cum[j + 1] < s) j++;
        const seg = cum[j + 1] - cum[j], t = seg > 1e-9 ? (s - cum[j]) / seg : 0;
        out.push(lerp3(pts[j], pts[j + 1], clamp01(t)));
    }
    return { pts: out, length: L };
}

interface LockOpts {
    /** Absolute full width per spine sample (before the tip taper). */
    widths: number[];
    /** Thickness as a fraction of the local width. */
    thick: number;
    /** 0 = blunt cut tip · 1 = a sharp point. */
    tip: number;
    /** Where along the lock (0..1) the tip taper starts. */
    tipStart: number;
    /** uv.v at the root / tip (the colour gradient and, for tails, the spring-chain parameter). */
    v0: number; v1: number;
    /** Outward (thickness) direction at sample i (made ⊥ to the spine). */
    outAt: (p: V3, i: number) => V3;
    /** The hair-mass normal the lock's shading blends toward. */
    volAt: (p: V3, i: number) => V3;
    /** 0..1 shading blend: 0 = each lock is its own tube · 1 = the whole mass shades as one smooth volume. */
    volBlend: number;
}

const RING = 6;   // lens cross-section verts

/** Emit one lock: a lens cross-section (wide across, thin in depth, flatter on the inside) swept along `pts`,
 *  tapering to a point (or a blunt cut) at the tip. All verts carry analytic normals (locked through the smooth pass). */
function emitLock(ac: LockAccum, pts: V3[], o: LockOpts): void {
    const S = pts.length - 1;
    if (S < 1) return;
    ac.curLock = true;
    const T: V3[] = pts.map((_, i) => norm(sub(pts[Math.min(S, i + 1)], pts[Math.max(0, i - 1)])));
    const rings: number[][] = [];
    const endW = (1 - o.tip) * 0.8;                       // blunt → the tip keeps most of its width
    const pw = lerp(2.4, 1.15, o.tip);                    // convex taper: stays wide, then points
    for (let i = 0; i <= S; i++) {
        const t = i / S, p = pts[i];
        let out = o.outAt(p, i);
        out = sub(out, scl(T[i], dot(out, T[i])));
        out = len(out) < 1e-5 ? perpFrame(T[i]).u : norm(out);
        const side = norm(cross(T[i], out));
        const q = t <= o.tipStart ? 0 : (t - o.tipStart) / (1 - o.tipStart);
        const tf = 1 - (1 - endW) * Math.pow(q, pw);
        const w = Math.max(o.widths[i] * 0.02, o.widths[i] * tf);
        const th = Math.max(w * 0.12, o.widths[i] * o.thick * (0.35 + 0.65 * tf));
        const vn = o.volAt(p, i);
        ac.curTan = T[i];
        const ring: number[] = [];
        for (let k = 0; k < RING; k++) {
            const a = (k / RING) * Math.PI * 2 + Math.PI / RING;   // no vertex exactly on the flat edge
            const ca = Math.cos(a), sa = Math.sin(a);
            const depth = sa > 0 ? sa : sa * 0.45;                  // flatter on the inner (head) side
            const pos = add(p, add(scl(side, ca * w * 0.5), scl(out, depth * th * 0.5)));
            const ncs = norm(add(scl(side, ca / Math.max(w, 1e-5)), scl(out, sa / Math.max(th, 1e-5))));
            let n: V3 = sa >= 0 ? norm(add(scl(ncs, 1 - o.volBlend), scl(vn, o.volBlend))) : norm(add(scl(vn, 0.8), scl(side, ca * 0.3)));
            if (!Number.isFinite(n[0])) n = vn;
            ring.push(pushV(ac, pos, n, k / RING, lerp(o.v0, o.v1, t)));
        }
        rings.push(ring);
    }
    for (let i = 0; i < S; i++) {
        const a = rings[i], b = rings[i + 1];
        for (let k = 0; k < RING; k++) {
            const k2 = (k + 1) % RING;
            ac.idx.push(a[k], a[k2], b[k2], a[k], b[k2], b[k]);
        }
    }
    // Close both ends (root hidden in the mass; a blunt tip shows its cut face).
    const capEnd = (ring: number[], at: V3, n: V3, v: number) => {
        const ci = pushV(ac, at, n, 0.5, v);
        for (let k = 0; k < RING; k++) ac.idx.push(ring[k], ring[(k + 1) % RING], ci);
    };
    // The cap shades like the lock's outer face (a downward cap normal reads as a dark tooth under a blunt cut).
    ac.curTan = T[S]; capEnd(rings[S], pts[S], o.volAt(pts[S], S), o.v1);
    ac.curTan = T[0]; capEnd(rings[0], pts[0], o.volAt(pts[0], 0), o.v0);
    ac.curLock = false;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Path helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Samples on the skull from direction a to b (great arc in normalised space), `off(s)` above it. */
function headArc(H: Head, a: V3, b: V3, n: number, off: (s: number) => number, swirl = 0): V3[] {
    const out: V3[] = [];
    for (let i = 0; i <= n; i++) {
        const s = i / n;
        let d = slerp(a, b, s);
        if (swirl !== 0) {                                      // twist the path around the vertical a little
            const ang = swirl * s * s, c = Math.cos(ang), sn = Math.sin(ang);
            d = [d[0] * c - d[2] * sn, d[1], d[0] * sn + d[2] * c];
        }
        out.push(onHead(H, d, off(s)));
    }
    return out;
}

/** Cubic bezier samples (excluding the start). */
function cubic(P0: V3, P1: V3, P2: V3, P3: V3, n: number): V3[] {
    const out: V3[] = [];
    for (let i = 1; i <= n; i++) {
        const t = i / n, it = 1 - t;
        out.push([
            it * it * it * P0[0] + 3 * it * it * t * P1[0] + 3 * it * t * t * P2[0] + t * t * t * P3[0],
            it * it * it * P0[1] + 3 * it * it * t * P1[1] + 3 * it * t * t * P2[1] + t * t * t * P3[1],
            it * it * it * P0[2] + 3 * it * it * t * P1[2] + 3 * it * t * t * P2[2] + t * t * t * P3[2],
        ]);
    }
    return out;
}

const tangentAtEnd = (pts: V3[]): V3 => norm(sub(pts[pts.length - 1], pts[Math.max(0, pts.length - 3)]));

/** Lock segment count from its length (× ry): longer locks bend more, so they get more rings. */
const segsFor = (L: number, ry: number): number => Math.round(clamp(6 + (L / ry) * 3.2, 7, 18));

/** Segments for a CURLED lock: enough samples per wave (5 for S-waves, 7 for spiral ringlets), capped for the budget. */
function curlSegs(s: LockStyle, L: number, ry: number): number {
    const base = segsFor(L, ry);
    if (s.lockCurl <= 0) return base;
    const per = s.lockCurlType === 'spiral' ? 7 : 5;
    return Math.round(clamp(Math.max(base, (L / ry) * s.lockCurlFreq * per * 0.8), base, 30));
}

/**
 * CURL (lockCurl, 2026-10-04): displace a lock's spine with S-waves (sideways, around the head) or spiral ringlets
 * (around the spine, biased outward so a coil never digs into the head). The curl fades in below `yStart` (the crown
 * stays smooth, the hanging length curls) and grows a little toward the tip. `out(p)` is the lock's outward
 * direction. Arc-length phase, so the curl frequency is per head height whatever the lock's sampling.
 */
function curlSpine(c: Ctx, pts: V3[], seed: number, yStart: number, out: (p: V3) => V3, ampMul = 1): V3[] {
    const { s, h } = c;
    if (s.lockCurl <= 0 || pts.length < 3) return pts;
    const S = pts.length - 1;
    const A = s.lockCurl * h.rx * (s.lockCurlType === 'spiral' ? 0.15 : 0.19) * (0.8 + 0.4 * hash11(seed + 21)) * ampMul;
    const w = (2 * Math.PI * s.lockCurlFreq) / Math.max(h.ry, 1e-6);
    const ph0 = hash11(seed + 23) * Math.PI * 2;
    const fadeSpan = h.ry * 0.45;
    const res: V3[] = [];
    let arc = 0;
    for (let i = 0; i <= S; i++) {
        if (i > 0) arc += len(sub(pts[i], pts[i - 1]));
        const p = pts[i];
        const T = norm(sub(pts[Math.min(S, i + 1)], pts[Math.max(0, i - 1)]));
        let o = out(p); o = sub(o, scl(T, dot(o, T)));
        o = len(o) < 1e-5 ? perpFrame(T).u : norm(o);
        const sd = norm(cross(T, o));
        const k = smooth(0, 1, (yStart - p[1]) / fadeSpan) * (0.85 + 0.3 * (i / S));
        if (k <= 0) { res.push(p); continue; }
        const a = arc * w + ph0;
        const d = s.lockCurlType === 'spiral'
            ? add(scl(sd, Math.cos(a) * A), scl(o, (Math.sin(a) * 0.8 + 0.45) * A))
            : add(scl(sd, Math.sin(a) * A), scl(o, (0.5 + 0.5 * Math.cos(2 * a)) * A * 0.25));
        res.push(add(p, scl(d, k)));
    }
    return res;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Style parts
// ═══════════════════════════════════════════════════════════════════════════

interface Ctx {
    ac: LockAccum; H: Head; h: HeadFrame; p: HairParams; s: LockStyle;
    /** Half the azimuth span of the face sector (the fringe covers it; crown locks stay out of it). */
    faceHalf: number;
    /** uv.v reference length: the longest crown lock reaches v ≈ 1. */
    vRef: number;
    /** Base offset of the lock layer off the skull (× radius). */
    vol: number;
}

/** The solid shell under the locks: crown → perimeter (front stops at the hairline). Root colour, smooth normals. */
function buildShell(c: Ctx, frontTheta: number, backTheta: number, off: number): void {
    const { ac, H } = c;
    const LAT = 9, LON = 28;
    ac.curLock = true;
    const rows: number[][] = [];
    for (let i = 0; i <= LAT; i++) {
        const row: number[] = [];
        for (let k = 0; k < LON; k++) {
            const ph = (k / LON) * Math.PI * 2;
            const fr = Math.pow(Math.max(0, Math.sin(ph)), 1.5);                // 1 at the front
            const thMax = lerp(backTheta, frontTheta, fr);
            const th = (i / LAT) * thMax;
            const d = dirOf(th, ph);
            const p = onHead(H, d, off * (1 + 0.9 * Math.cos(th) * Math.cos(th)));   // fuller at the crown, where the locks converge
            ac.curTan = norm([Math.cos(th) * Math.cos(ph), -Math.sin(th), Math.cos(th) * Math.sin(ph)]);
            row.push(pushV(ac, p, volNormal(H, p), k / LON, 0.04));
        }
        rows.push(row);
    }
    for (let i = 0; i < LAT; i++) for (let k = 0; k < LON; k++) {
        const k2 = (k + 1) % LON, a = rows[i], b = rows[i + 1];
        ac.idx.push(a[k], a[k2], b[k2], a[k], b[k2], b[k]);
    }
    ac.curLock = false;
}

/** One HANGING crown lock at azimuth ph: crown → down the skull → (if long) a free hang to yEnd, with a flick. */
function crownLock(c: Ctx, ph: number, yEnd: number, width: number, layer: number, seed: number): void {
    const { H, h, s } = c;
    const J = s.lockJitter;
    if (s.lockSpike > 0.01) { spikeLock(c, ph, yEnd, width, layer, seed); return; }
    const poof = s.hairPoof;
    if (poof > 0) width *= 1 + poof * 0.35;
    const off = c.vol + layer * width * s.lockThickness * 0.55 / Math.max(h.rx, 1e-6);   // outer layer sits on top
    const swirl = jit(seed + 1) * 0.35 * J;
    const th0 = 0.05 * Math.PI + hash11(seed + 2) * 0.05;
    const yFall = H.c[1];                                         // the widest point: below it hair falls free
    const onHeadEnd = yEnd >= yFall;
    const thEnd = onHeadEnd ? Math.acos(clamp((yEnd - H.c[1]) / (H.R[1] * 1.05), -1, 1)) : 0.5 * Math.PI;
    const puff = 0.05 + c.vol * 0.4;
    const a = dirOf(th0, ph), b = dirOf(Math.max(th0 + 0.1, thEnd), ph + jit(seed + 3) * 0.12 * J);
    let pts = headArc(H, a, b, 9, (u) => off * (0.55 + 0.45 * smooth(0, 0.35, u)) + puff * Math.sin(Math.PI * Math.min(1, u * 1.1)) * 0.5, swirl);
    const P = pts[pts.length - 1], Tn = tangentAtEnd(pts);
    const hr = norm([P[0] - H.c[0], 0, P[2] - H.c[2]]);            // horizontal outward at the fall point
    const flick = s.lockFlick + jit(seed + 4) * 0.5 * J;
    if (!onHeadEnd) {
        const L = P[1] - yEnd;
        const long = yEnd < H.c[1] - H.R[1] * 1.35 && P[2] < H.c[2] + H.R[2] * 0.4;   // passes the shoulders → route behind
        let E: V3 = [H.c[0] + (P[0] - H.c[0]) * 0.97, yEnd, H.c[2] + (P[2] - H.c[2]) * 0.97];
        E = add(E, scl(hr, flick * h.ry * 0.22 * Math.min(1, L / h.ry) * Math.min(1, L / (h.ry * 0.6))));
        let C1 = add(P, scl(Tn, L * 0.3));
        let C2: V3 = add(add(E, [0, L * 0.4, 0]), scl(hr, -flick * h.ry * 0.12));
        if (poof > 0) {
            // CURLY VOLUME: the hang bulges out into a round mass (widest just below the head), the hem tucks back in a bit.
            const bulge = poof * h.rx * Math.min(1, L / (h.ry * 0.8));
            C1 = add(C1, scl(hr, bulge * 0.55));
            C2 = add(C2, scl(hr, bulge * 0.45));
            E = add(E, scl(hr, bulge * 0.15));
        }
        if (long) {
            const zb = H.backZ(H.c[1] - H.R[1] * 2.0) - width * 0.6;
            const ze = H.backZ(yEnd) - width * 0.5;
            E = [E[0] * 0.9 + H.c[0] * 0.1, E[1], Math.min(E[2], ze)];
            C2 = [C2[0] * 0.9 + H.c[0] * 0.1, C2[1], Math.min(C2[2], zb)];
        }
        pts = pts.concat(cubic(P, C1, C2, E, 10));
    } else if (flick > 0.05) {
        // A short cut ending on the skull: the tip lifts off, flicking out.
        const E = add(add(P, scl(Tn, h.ry * 0.13)), scl(hr, flick * h.ry * 0.09));   // short + soft (long needles read as whiskers)
        pts = pts.concat(cubic(P, add(P, scl(Tn, h.ry * 0.08)), lerp3(P, E, 0.7), E, 3));
    }
    let r = resample(pts, curlSegs(s, pathLen(pts), h.ry));
    if (s.lockCurl > 0) r = { pts: curlSpine(c, r.pts, seed, H.c[1] + h.ry * 0.25, (q) => volNormal(H, q)), length: r.length };
    // Width ∝ the head's circumference at each height (narrow at the crown where the locks converge).
    const widths = r.pts.map((q) => {
        const rho = Math.hypot((q[0] - H.c[0]) / H.R[0], (q[2] - H.c[2]) / H.R[2]);
        return width * clamp(rho, 0.22, 1.05);
    });
    emitLock(c.ac, r.pts, {
        widths, thick: s.lockThickness, tip: clamp01(s.lockTaper + jit(seed + 5) * 0.15 * J), tipStart: onHeadEnd ? 0.45 : 0.62,
        v0: 0.02, v1: clamp01(r.length / c.vRef),
        outAt: (q) => volNormal(H, q), volAt: (q) => volNormal(H, q), volBlend: 0.55,
    });
}

const pathLen = (pts: V3[]): number => { let L = 0; for (let i = 1; i < pts.length; i++) L += len(sub(pts[i], pts[i - 1])); return L; };

/**
 * One SPIKY crown lock (lockSpike, 2026-10-04 — the shonen look): from the crown it hugs the skull only to its leave
 * point (the outer layer leaves higher), then juts OUT along a blend of the skull tangent and the outward normal,
 * a wide root tapering to a long sharp point. Longer regions (the back) give longer spikes.
 */
function spikeLock(c: Ctx, ph: number, yEnd: number, width: number, layer: number, seed: number): void {
    const { H, h, s } = c;
    const sp = s.lockSpike, J = s.lockJitter;
    const off = c.vol + layer * width * s.lockThickness * 0.55 / Math.max(h.rx, 1e-6);
    const th0 = 0.05 * Math.PI + hash11(seed + 2) * 0.04;
    const thLeave = (layer === 0 ? 0.40 : 0.24) * Math.PI + jit(seed + 3) * 0.05 * Math.PI;
    const a = dirOf(th0, ph), b = dirOf(thLeave, ph + jit(seed + 6) * 0.1 * J);
    const arc = headArc(H, a, b, 6, (u) => off * (0.6 + 0.4 * u));
    const P = arc[arc.length - 1], Tn = tangentAtEnd(arc), n = volNormal(H, P);
    const hangL = Math.max(0, H.c[1] - yEnd) / h.ry;                       // the region's length (× ry), back > sides
    const Ls = h.ry * (0.26 + 0.16 * Math.min(2, hangL) + 0.1 * hash11(seed + 8)) * (layer === 0 ? 1 : 0.9);
    // Lower layer: out + down the skull; upper layer: up + back off the crown (the radiating shonen silhouette).
    const back: V3 = norm([P[0] - H.c[0], 0, P[2] - H.c[2]]);
    const dir = layer === 0
        ? norm(add(add(scl(Tn, 1 - sp * 0.6), scl(n, sp * 0.8)), [0, -0.22 - 0.12 * hash11(seed + 9), 0]))
        : norm(add(add(scl(n, 0.7 + 0.2 * sp), scl(back, 0.35)), [0, 0.35 * sp, 0]));
    const E = add(P, scl(dir, Ls));
    const pts = arc.concat(cubic(P, add(P, scl(Tn, Ls * 0.3)), add(E, scl(dir, -Ls * 0.45)), E, 7));
    const r = resample(pts, segsFor(pathLen(pts), h.ry));
    const tipStart = clamp(pathLen(arc) / Math.max(1e-6, r.length), 0.15, 0.7);   // taper only on the jut: a fat triangular clump
    const widths = r.pts.map((q) => width * 1.3 * clamp(Math.hypot((q[0] - H.c[0]) / H.R[0], (q[2] - H.c[2]) / H.R[2]), 0.45, 1.05));
    emitLock(c.ac, r.pts, {
        widths, thick: s.lockThickness * 1.5, tip: 1, tipStart,
        v0: 0.02, v1: clamp01(r.length / c.vRef), outAt: (q) => volNormal(H, q), volAt: (q) => volNormal(H, q), volBlend: 0.5,
    });
}

/** The crown/back mass: lockCount locks around the non-face azimuths, 1–2 overlapping layers. */
function buildCrown(c: Ctx): void {
    const { s, h, H } = c;
    const span = Math.PI * 2 - c.faceHalf * 2;
    const N = s.lockCount;
    const startPh = Math.PI / 2 + c.faceHalf;                    // the face sector's left edge, going round the back
    const Rm = Math.max(H.R[0], H.R[2]) * (1 + c.vol);
    for (let layer = 0; layer < s.lockLayers; layer++) {
        const n = layer === 0 ? N : Math.max(4, Math.round(N * 0.75));
        const step = span / n;
        const width = step * Rm * 1.42 * s.lockWidth * (layer === 0 ? 1 : 0.92);
        for (let i = 0; i < n; i++) {
            const seed = s.lockSeed * 977 + layer * 101 + i * 13.7;
            const ph = startPh + step * (i + 0.5 + (layer === 1 ? 0.5 : 0)) + jit(seed) * step * 0.18 * (0.4 + s.lockJitter);
            if (layer === 1 && i === n - 1) continue;              // keep the face edges single-layer
            const back = Math.max(0, -Math.sin(ph)), sideK = 1 - back;
            const L = lerp(s.sideLength, s.hairLength, Math.pow(back, 0.8));
            const lenJ = 1 + jit(seed + 9) * (0.06 + 0.3 * s.lockJitter) - (layer === 1 ? 0.18 + 0.1 * hash11(seed + 7) : 0);
            const yEnd = H.c[1] - h.ry * L * Math.max(0.05, lenJ) + (L < 0.4 ? h.ry * (0.4 - L) * 0.5 * sideK : 0)
                + jit(seed + 11) * h.ry * 0.22 * s.lockJitter * s.lockJitter;   // messy: absolute ragged hem
            crownLock(c, ph, yEnd, width, layer, seed);
        }
    }
}

/** GATHERED hair (pony / bun): every crown lock runs from the hairline / nape over the skull into the tie. */
function buildGathered(c: Ctx, ties: V3[]): void {
    const { s, h, H } = c;
    const N = Math.max(10, s.lockCount + 2) + (ties.length > 1 ? 4 : 0);
    const tieDirs = ties.map((t) => norm([(t[0] - H.c[0]) / H.R[0], (t[1] - H.c[1]) / H.R[1], (t[2] - H.c[2]) / H.R[2]]));
    const Rm = Math.max(H.R[0], H.R[2]);
    const hairlineTh = Math.acos(clamp(c.p.hairlineFront ?? 0.42, -0.2, 0.92));
    for (let i = 0; i < N; i++) {
        const seed = s.lockSeed * 977 + 500 + i * 7.3;
        const ph = (i / N) * Math.PI * 2 + jit(seed) * 0.05;
        const front = Math.pow(Math.max(0, Math.sin(ph)), 1.2);
        const thRoot = lerp(0.6 * Math.PI, hairlineTh, front);
        const a = dirOf(thRoot, ph);
        let ti = 0; for (let k = 1; k < tieDirs.length; k++) if (dot(a, tieDirs[k]) > dot(a, tieDirs[ti])) ti = k;   // the nearer tie
        const tieDir = tieDirs[ti], tie = ties[ti];
        if (dot(a, tieDir) > 0.93) continue;                      // right under the tie: nothing to gather
        const off = c.vol * 0.8;   // above the shell (fuller at the crown) so no gap opens under the fringe roots
        const pts = headArc(H, a, tieDir, 12, (u) => off * (0.75 + 0.35 * Math.sin(Math.PI * u)) + 0.02);
        const r = resample(pts, segsFor(pathLen(pts), h.ry));
        const width = (Math.PI * 2 / N) * Rm * 1.5 * s.lockWidth * lerp(1, 0.85, front);
        const widths = r.pts.map((q) => width * clamp(len(sub(q, tie)) / (Rm * 0.9), 0.18, 1));
        emitLock(c.ac, r.pts, {
            widths, thick: s.lockThickness * 0.7, tip: 0.2, tipStart: 0.9, v0: 0.02, v1: 0.08,
            outAt: (q) => volNormal(H, q), volAt: (q) => volNormal(H, q), volBlend: 0.6,
        });
    }
}

/** The FRINGE: bang locks from the crown front over the forehead to a styled tip line. */
function buildFringe(c: Ctx): void {
    const { s, h, H, p } = c;
    const style = s.fringeStyle;
    const n = s.fringeCount;
    const span = c.faceHalf * 2 * 0.98;
    const Rm = H.R[0] * (1 + c.vol);
    const hairlineY = clamp(p.hairlineFront ?? 0.42, -0.2, 0.92);
    if (style === 'none') {
        // Slicked back: short locks from the hairline up over the crown.
        for (let i = 0; i < n; i++) {
            const seed = s.lockSeed * 977 + 300 + i * 5.1;
            const ph = Math.PI / 2 + c.faceHalf - span * (i + 0.5) / n;
            const a = dirOf(Math.acos(hairlineY) * 0.98, ph), b = dirOf(0.12 * Math.PI, ph + (ph - Math.PI / 2) * 0.3);
            const pts = headArc(H, a, b, 8, (u) => c.vol * (0.5 + 0.6 * Math.sin(Math.PI * u)));
            const r = resample(pts, 8);
            const width = (span / n) * Rm * 1.45 * s.lockWidth;
            emitLock(c.ac, r.pts, {
                widths: r.pts.map((_, k) => width * lerp(1, 0.6, k / 8)), thick: s.lockThickness, tip: 0.6, tipStart: 0.6,
                v0: 0.02, v1: 0.12 + hash11(seed) * 0.02, outAt: (q) => volNormal(H, q), volAt: (q) => volNormal(H, q), volBlend: 0.6,
            });
        }
        return;
    }
    const side = s.fringeSide >= 0 ? 1 : -1;                     // sweep / part side: +1 = toward +x
    const partX = s.fringeSide * 0.45;                           // part position across the forehead (−1..1 of rx)
    const baseY = s.fringeHeight;
    const width0 = (span / n) * Rm * 1.7 * s.lockWidth;
    for (let i = 0; i < n; i++) {
        const seed = s.lockSeed * 977 + 200 + i * 3.3;
        const u = (i + 0.5) / n;                                 // 0 = the left (−x) edge → 1 = the right edge
        const ph = Math.PI / 2 + c.faceHalf * 0.98 - span * u;
        const xN = Math.cos(ph) / Math.max(1e-3, Math.cos(Math.PI / 2 - c.faceHalf));   // −1..1 across the forehead
        const overEye = Math.abs(xN) < 0.72;
        let tipY = baseY, tip = clamp01(s.lockTaper), swing = 0, wMul = 1;
        if (style === 'straight') {
            tip = Math.min(tip, 0.3);
            tipY = baseY + (Math.abs(xN) > 0.8 ? -0.04 : 0);
        } else if (style === 'choppy') {
            // alternating long / short points (seeded), no single dominant centre lock
            tipY = baseY - 0.04 + (i % 2 === 0 ? -0.035 : 0.025) + jit(seed) * 0.035 * (0.5 + s.lockJitter) + (Math.abs(xN) > 0.82 ? -0.1 : 0);
            tip = Math.max(tip, 0.88);
            wMul = 0.85 + hash11(seed + 1) * 0.35;
            swing = jit(seed + 2) * 0.08;
        } else if (style === 'swept') {
            const toward = clamp01((xN * side + 1) / 2);         // 0 = the far side → 1 = the side the bangs sweep to
            tipY = baseY - 0.02 - toward * 0.07;
            if (!overEye && toward > 0.6) tipY = baseY - 0.3 - (toward - 0.6) * 0.6;   // the long sweep beside the eye
            tip = Math.max(tip, 0.85);
            swing = side * -0.75 * (0.5 + 0.5 * toward);         // each lock's path swings toward the sweep side (−φ = +x)
            wMul = 1.1;
        } else if (style === 'parted') {
            const dx = xN - partX;
            if (Math.abs(dx) < 0.1) continue;                     // the part itself
            const nearPart = 1 - clamp01(Math.abs(dx) / 1.1);
            tipY = baseY - 0.05 + 0.1 * Math.pow(nearPart, 1.5) - (Math.abs(xN) > 0.8 ? 0.1 : 0) + jit(seed) * 0.02;
            tip = Math.max(tip, 0.8);
            swing = (dx > 0 ? -1 : 1) * 0.3 * nearPart;          // locks fall away from the part (−φ = toward +x)
        }
        const thTip = Math.acos(clamp(tipY / 1.05, -0.95, 0.98));
        const th0 = 0.07 * Math.PI + hash11(seed + 3) * 0.04;
        const a = dirOf(th0, ph - swing * 0.2), b = dirOf(thTip, ph + swing);
        // Curly volume (hairPoof): the root rides the big mass, the tips come back down to the forehead (no visor).
        const fv = Math.min(c.vol, s.lockVolume + s.hairPoof * 0.08);
        const lift = 0.04 + fv * 0.6;
        const pts = headArc(H, a, b, 12, (q) => lerp(c.vol, fv, smooth(0.15, 0.7, q)) * 0.8 + (i % 2) * 0.012 + lift * smooth(0.55, 1, q));
        const r = resample(pts, segsFor(pathLen(pts), h.ry));
        const widths = r.pts.map((q) => {
            const rho = Math.hypot((q[0] - H.c[0]) / H.R[0], (q[2] - H.c[2]) / H.R[2]);
            return width0 * wMul * clamp(rho * 1.1, 0.3, 1);
        });
        emitLock(c.ac, r.pts, {
            widths, thick: s.lockThickness * 0.85, tip, tipStart: style === 'straight' ? 0.82 : 0.66,
            v0: 0.02, v1: clamp01(r.length / c.vRef), outAt: (q) => volNormal(H, q), volAt: (q) => volNormal(H, q), volBlend: 0.5,
        });
    }
}

/** Face-framing SIDE LOCKS in front of the ears: temple → down the skull → hang to the side-lock length. */
function buildSideLocks(c: Ctx): void {
    const { p, s, h, H } = c;
    if (!p.sideLock) return;
    const n = Math.round(clamp(p.sideLockCount ?? 1, 1, 3));
    const Lr = clamp(p.sideLockLength ?? 1.2, 0.2, 5);
    const width = h.rx * clamp(p.sideLockWidth ?? 0.18, 0.04, 0.5) * 2.8;
    const blunt = s.fringeStyle === 'straight' && s.lockTaper < 0.35;   // hime: cut straight across
    for (const sx of [-1, 1]) {
        for (let k = 0; k < n; k++) {
            const seed = s.lockSeed * 977 + 700 + k * 11 + (sx > 0 ? 50 : 0);
            const ph = Math.PI / 2 - sx * (c.faceHalf + 0.06 + k * 0.2);
            const a = dirOf(0.3 * Math.PI, ph), b = dirOf(0.5 * Math.PI, ph);
            let pts = headArc(H, a, b, 6, () => c.vol * 0.9 + 0.02);
            const P = pts[pts.length - 1], Tn = tangentAtEnd(pts);
            const yEnd = H.c[1] + h.ry * (0.15 - Lr) * (1 - k * 0.12);
            const L = Math.max(h.ry * 0.1, P[1] - yEnd);
            // Hang straight down OUTSIDE the cheek line (an inward curve cut through the face and the shrink-wrap
            // then spread the lock over it); the tip swings a touch forward, framing the face.
            const outK = 1.04 + 0.04 * hash11(seed);
            const E: V3 = [H.c[0] + (P[0] - H.c[0]) * outK, yEnd, P[2] + h.rz * (blunt ? 0 : 0.06)];
            const C1 = add(P, scl(Tn, L * 0.35)), C2: V3 = [H.c[0] + (P[0] - H.c[0]) * outK, yEnd + L * 0.45, P[2]];
            pts = pts.concat(cubic(P, C1, C2, E, 9));
            const outF = (q: V3): V3 => norm([(q[0] - H.c[0]) / H.R[0], 0.1, (q[2] - H.c[2]) / H.R[2]]);
            let r = resample(pts, curlSegs(s, pathLen(pts), h.ry));
            if (s.lockCurl > 0) r = { pts: curlSpine(c, r.pts, seed, H.c[1], outF, 0.8), length: r.length };
            const widths = r.pts.map((_, i) => width * lerp(0.6, 1, smooth(0, 0.35, i / (r.pts.length - 1))));
            emitLock(c.ac, r.pts, {
                widths, thick: s.lockThickness, tip: blunt ? 0 : Math.max(0.75, s.lockTaper), tipStart: blunt ? 0.95 : 0.62,
                v0: 0.03, v1: clamp01(r.length / c.vRef), outAt: outF, volAt: outF, volBlend: 0.5,
            });
        }
    }
}

/** A TAIL bundle: `tailLocks` locks around a swept spine (quadratic bezier A→C→E), each ending in its own point. */
function buildTailBundle(c: Ctx, A: V3, C: V3, E: V3, r0: number, tailIdx: number): void {
    const { s, h } = c;
    c.ac.curTailId = tailIdx;
    const bez = (t: number): V3 => { const it = 1 - t; return [it * it * A[0] + 2 * it * t * C[0] + t * t * E[0], it * it * A[1] + 2 * it * t * C[1] + t * t * E[1], it * it * A[2] + 2 * it * t * C[2] + t * t * E[2]]; };
    const tan = (t: number): V3 => norm([2 * (1 - t) * (C[0] - A[0]) + 2 * t * (E[0] - C[0]), 2 * (1 - t) * (C[1] - A[1]) + 2 * t * (E[1] - C[1]), 2 * (1 - t) * (C[2] - A[2]) + 2 * t * (E[2] - C[2])]);
    const SEG = 16;
    // Parallel-transported frame down the spine (no spin / flip).
    const cs: V3[] = [], us: V3[] = [], vs: V3[] = [];
    let f = perpFrame(tan(0)), u = f.u, v = f.v, prevT = tan(0);
    for (let i = 0; i <= SEG; i++) {
        const t = i / SEG, T = tan(t);
        if (i > 0) { const ax = cross(prevT, T), sn = len(ax), co = dot(prevT, T); if (sn > 1e-6) { const k = scl(ax, 1 / sn); u = rotAxis(u, k, co, sn); v = rotAxis(v, k, co, sn); } prevT = T; }
        cs.push(bez(t)); us.push(u); vs.push(v);
    }
    const taper = clamp01(c.p.tailTaper ?? 0.6);
    const radius = (t: number): number => r0 * (0.5 + 0.5 * smooth(0, 0.16, t)) * (1 - t * taper * 0.55) * (1 + 0.15 * Math.sin(Math.PI * Math.min(1, t * 1.6)));
    const K = s.tailLocks;
    for (let k = 0; k < K; k++) {
        const seed = s.lockSeed * 977 + 900 + tailIdx * 61 + k * 7;
        const ang = (k / K) * Math.PI * 2 + jit(seed) * 0.25;
        const tEnd = 1 - hash11(seed + 1) * 0.16 - (k % 2) * 0.05;
        const pts: V3[] = [], outs: V3[] = [], widths: number[] = [];
        for (let i = 0; i <= SEG; i++) {
            const t = (i / SEG) * tEnd;
            const fi = t * SEG, i0 = Math.min(SEG - 1, Math.floor(fi)), w = fi - i0;
            const ctr = lerp3(cs[i0], cs[i0 + 1], w), uu = norm(lerp3(us[i0], us[i0 + 1], w)), vv = norm(lerp3(vs[i0], vs[i0 + 1], w));
            const rd = norm(add(scl(uu, Math.cos(ang)), scl(vv, Math.sin(ang))));
            const rr = radius(t);
            const splay = 1 + 0.35 * t * t + jit(seed + 2) * 0.1 * t;
            let q = add(ctr, scl(rd, rr * 0.5 * splay));
            if (s.lockCurl > 0) {   // wavy / ringlet tails: each lock waves (or coils) about its own line, growing down the tail
                const a = t * s.lockCurlFreq * Math.PI * 2 * (pathLen([A, C, E]) / Math.max(h.ry, 1e-6)) * 0.5 + hash11(seed + 3) * 6.28;
                const sd = norm(cross(tan(t), rd)), amp = s.lockCurl * h.rx * 0.16 * smooth(0.05, 0.3, t);
                q = s.lockCurlType === 'spiral' ? add(q, add(scl(sd, Math.cos(a) * amp), scl(rd, (Math.sin(a) * 0.7 + 0.3) * amp)))
                    : add(q, scl(sd, Math.sin(a) * amp));
            }
            pts.push(q);
            outs.push(rd);
            widths.push(Math.max(h.rx * 0.01, (Math.PI * 2 * rr / K) * 1.55 * s.lockWidth));
        }
        emitLock(c.ac, pts, {
            widths, thick: 0.45, tip: Math.max(0.7, s.lockTaper), tipStart: 0.55, v0: 0, v1: tEnd,
            outAt: (_q, i) => outs[i], volAt: (_q, i) => outs[i], volBlend: 0.45,
        });
    }
    // A thin core so the bundle never reads hollow between its locks.
    const core: V3[] = [], cw: number[] = [];
    for (let i = 0; i <= SEG; i++) { const t = (i / SEG) * 0.8; core.push(bez(t)); cw.push(radius(t) * 1.1); }
    emitLock(c.ac, core, {
        widths: cw, thick: 0.9, tip: 1, tipStart: 0.5, v0: 0, v1: 0.8,
        outAt: (_q, i) => us[Math.min(SEG, Math.round(i * 0.8))], volAt: (q, i) => norm(sub(q, core[i])), volBlend: 0.3,
    });
    c.ac.curTailId = -1;
}

/** Tails (pony / twin / pig). Returns the tie points (for gathered hair). */
function tailAttach(c: Ctx): { A: V3; out: V3 }[] {
    const { p, H } = c;
    const style = String(p.tailStyle ?? 'none').toLowerCase();
    if (style === 'none') return [];
    const hgt = clamp(p.tailHeight ?? 0.45, -0.6, 0.95);
    if (style === 'pony') {
        const d = dirOf(Math.acos(clamp(hgt, -0.6, 0.9)) , -Math.PI / 2);
        return [{ A: onHead(H, d, c.vol * 0.7), out: [0, 0.15, -1] }];
    }
    const y = style === 'pig' ? hgt - 0.5 : hgt;
    const th = Math.acos(clamp(y, -0.6, 0.9));
    return [-1, 1].map((sx) => {
        const ph = sx > 0 ? -0.35 : Math.PI + 0.35;              // side, a little behind the ear
        return { A: onHead(H, dirOf(th, ph), c.vol * 0.7), out: [sx, style === 'pig' ? 0 : 0.3, -0.3] as V3 };
    });
}

function buildTails(c: Ctx, attach: { A: V3; out: V3 }[]): void {
    const { p, h } = c;
    const L = h.ry * clamp(p.tailLength ?? 3, 0.3, 7), r0 = h.rx * clamp(p.tailThickness ?? 0.4, 0.1, 1);
    const spread = clamp(p.tailSpread ?? 0.5, 0, 1.2), curl = clamp(p.tailCurl ?? 0.3, -1, 1);
    attach.forEach(({ A, out }, ti) => {
        const o = norm(out), down: V3 = [0, -1, 0];
        const C = add(add(A, scl(o, L * spread * 0.5 + r0 * 0.6)), scl(down, L * 0.35));
        const E = add(add(A, scl(o, L * spread * 0.3)), scl(down, L * (1 + curl * 0.25)));
        E[2] -= L * curl * 0.2;
        if (c.s.tailForm === 'braid') buildBraid(c, A, C, E, r0, ti, o);
        else if (c.s.tailForm === 'drill') buildDrill(c, A, C, E, r0, ti, o);
        else buildTailBundle(c, A, C, E, r0, ti);
    });
}

/** A tail spine (quadratic bezier A→C→E) sampled at SEG+1 points with a parallel-transported frame whose `v` starts
 *  as the horizontal `face` direction (so a braid shows its flat side to the back / outward, not edge-on). */
function tailSpine(A: V3, C: V3, E: V3, SEG: number, face: V3): { cs: V3[]; us: V3[]; vs: V3[]; ts: V3[]; length: number } {
    const bez = (t: number): V3 => { const it = 1 - t; return [it * it * A[0] + 2 * it * t * C[0] + t * t * E[0], it * it * A[1] + 2 * it * t * C[1] + t * t * E[1], it * it * A[2] + 2 * it * t * C[2] + t * t * E[2]]; };
    const tan = (t: number): V3 => norm([2 * (1 - t) * (C[0] - A[0]) + 2 * t * (E[0] - C[0]), 2 * (1 - t) * (C[1] - A[1]) + 2 * t * (E[1] - C[1]), 2 * (1 - t) * (C[2] - A[2]) + 2 * t * (E[2] - C[2])]);
    const T0 = tan(0);
    let v = sub(face, scl(T0, dot(face, T0)));
    v = len(v) < 1e-4 ? perpFrame(T0).v : norm(v);
    let u = norm(cross(v, T0)), prevT = T0;
    const cs: V3[] = [], us: V3[] = [], vs: V3[] = [], ts: V3[] = [];
    for (let i = 0; i <= SEG; i++) {
        const t = i / SEG, T = tan(t);
        if (i > 0) { const ax = cross(prevT, T), sn = len(ax), co = dot(prevT, T); if (sn > 1e-6) { const k = scl(ax, 1 / sn); u = rotAxis(u, k, co, sn); v = rotAxis(v, k, co, sn); } prevT = T; }
        cs.push(bez(t)); us.push(u); vs.push(v); ts.push(T);
    }
    return { cs, us, vs, ts, length: pathLen(cs) };
}

/** Sample the spine frame at t ∈ [0,1] (linear between the SEG samples). */
function spineAt(sp: { cs: V3[]; us: V3[]; vs: V3[] }, t: number): { c: V3; u: V3; v: V3 } {
    const SEG = sp.cs.length - 1, fi = clamp01(t) * SEG, i0 = Math.min(SEG - 1, Math.floor(fi)), w = fi - i0;
    return { c: lerp3(sp.cs[i0], sp.cs[i0 + 1], w), u: norm(lerp3(sp.us[i0], sp.us[i0 + 1], w)), v: norm(lerp3(sp.vs[i0], sp.vs[i0 + 1], w)) };
}

/**
 * A BRAID tail (tailForm 'braid', 2026-10-04): three strands woven along the spine (the classic three-strand
 * lissajous — each strand swings across the braid's width once per two crossings and over / under in depth), a flat
 * plait showing its wide side to `face`, ending in a tie and a short pointed tuft. Spring-tagged like a bundle tail.
 */
function buildBraid(c: Ctx, A: V3, C: V3, E: V3, r0: number, tailIdx: number, face: V3): void {
    const { s, h } = c;
    c.ac.curTailId = tailIdx;
    const sp = tailSpine(A, C, E, 24, [face[0], 0, face[2]]);
    const taper = clamp01(c.p.tailTaper ?? 0.6);
    const tTie = 0.84;
    const crossings = Math.round(clamp(sp.length / (r0 * 0.95), 5, 16));
    const S = Math.min(64, crossings * 4);
    const half = (t: number): number => r0 * 0.62 * (0.55 + 0.45 * smooth(0, 0.1, t)) * (1 - t * taper * 0.45);
    for (let k = 0; k < 3; k++) {
        const phase = (k / 3) * Math.PI * 2;
        const pts: V3[] = [], outs: V3[] = [], widths: number[] = [];
        for (let i = 0; i <= S; i++) {
            const t = (i / S) * tTie, f = spineAt(sp, t);
            const a = t / tTie * crossings * Math.PI + phase, hw = half(t);
            pts.push(add(f.c, add(scl(f.u, Math.sin(a) * hw), scl(f.v, Math.sin(2 * a) * hw * 0.35))));
            outs.push(f.v);
            widths.push(hw * 1.25 * s.lockWidth);
        }
        emitLock(c.ac, pts, {
            widths, thick: 0.62, tip: 0, tipStart: 0.97, v0: 0, v1: tTie,
            outAt: (_q, i) => outs[i], volAt: (q, i) => norm(add(scl(outs[i], 0.6), scl(norm(sub(q, spineAt(sp, (i / S) * tTie).c)), 0.4))), volBlend: 0.4,
        });
    }
    // The tie (a short fat collar) + the tuft below it.
    const tie: V3[] = [], tw: number[] = [];
    for (let i = 0; i <= 3; i++) { const t = tTie - 0.025 + i * 0.012; tie.push(spineAt(sp, t).c); tw.push(half(tTie) * 1.5); }
    const tf = spineAt(sp, tTie);
    emitLock(c.ac, tie, { widths: tw, thick: 0.9, tip: 0, tipStart: 0.99, v0: tTie, v1: tTie + 0.02, outAt: () => tf.v, volAt: () => tf.v, volBlend: 0.5 });
    const K = 4;
    for (let k = 0; k < K; k++) {
        const ang = (k / K) * Math.PI * 2 + 0.4, pts: V3[] = [], outs: V3[] = [], widths: number[] = [];
        for (let i = 0; i <= 6; i++) {
            const t = tTie + (i / 6) * (1 - tTie) * (0.85 + 0.15 * hash11(tailIdx * 31 + k)), f = spineAt(sp, Math.min(1, t));
            const rd = norm(add(scl(f.u, Math.cos(ang)), scl(f.v, Math.sin(ang)))), q = (t - tTie) / (1 - tTie);
            pts.push(add(f.c, scl(rd, half(tTie) * (0.3 + 0.7 * q))));
            outs.push(rd);
            widths.push(half(tTie) * 1.3 * s.lockWidth);
        }
        emitLock(c.ac, pts, { widths, thick: 0.5, tip: 1, tipStart: 0.2, v0: tTie, v1: 1, outAt: (_q, i) => outs[i], volAt: (_q, i) => outs[i], volBlend: 0.45 });
    }
    void h;
    c.ac.curTailId = -1;
}

/**
 * A DRILL tail (tailForm 'drill', 2026-10-04 — the ojou-sama ringlet): one wide lock coiled `drillTurns` times
 * around the spine, the coil radius swelling from the tie to a full drill and narrowing to a point, the coils
 * overlapping so it reads solid; plus a cone core. Spring-tagged (uv.v = the spine parameter).
 */
function buildDrill(c: Ctx, A: V3, C: V3, E: V3, r0: number, tailIdx: number, face: V3): void {
    const { s, h } = c;
    c.ac.curTailId = tailIdx;
    const sp = tailSpine(A, C, E, 24, [face[0], 0, face[2]]);
    const turns = s.drillTurns, S = Math.round(clamp(turns * 14, 28, 100));
    const Rh = (t: number): number => r0 * 0.95 * (0.35 + 0.65 * smooth(0, 0.22, t)) * (1 - 0.82 * Math.pow(t, 1.6));
    const pitch = sp.length / turns;
    const pts: V3[] = [], outs: V3[] = [], widths: number[] = [];
    for (let i = 0; i <= S; i++) {
        const t = i / S, f = spineAt(sp, t), a = t * turns * Math.PI * 2;
        const rd = norm(add(scl(f.u, Math.cos(a)), scl(f.v, Math.sin(a))));
        pts.push(add(f.c, scl(rd, Rh(t))));
        outs.push(rd);
        widths.push(Math.min(pitch * 1.6, r0 * 1.8) * (0.5 + 0.5 * smooth(0, 0.12, t)) * (1 - 0.45 * t) * s.lockWidth);
    }
    emitLock(c.ac, pts, {
        widths, thick: 0.45, tip: 1, tipStart: 0.86, v0: 0, v1: 1,
        outAt: (_q, i) => outs[i], volAt: (_q, i) => outs[i], volBlend: 0.35,
    });
    const core: V3[] = [], cw: number[] = [];
    for (let i = 0; i <= 12; i++) { const t = (i / 12) * 0.92; core.push(spineAt(sp, t).c); cw.push(Rh(t) * 1.85); }
    emitLock(c.ac, core, {
        widths: cw, thick: 0.95, tip: 1, tipStart: 0.6, v0: 0, v1: 0.92,
        outAt: (_q, i) => spineAt(sp, (i / 12) * 0.92).v, volAt: (q, i) => norm(sub(q, core[i])), volBlend: 0.3,
    });
    void h;
    c.ac.curTailId = -1;
}

/** A BUN: a solid core + locks coiling around it. */
function buildBun(c: Ctx, center: V3, r: number): void {
    const { ac, s } = c;
    const B: Head = { c: center, R: [r, r * 0.85, r], rho: new Float32Array(MAP_T * MAP_P).fill(1), backZ: () => center[2] };
    const K = 7;
    for (let k = 0; k < K; k++) {
        const ph = (k / K) * Math.PI * 2;
        const a = dirOf(0.85 * Math.PI, ph), b = dirOf(0.12 * Math.PI, ph + 2.2);
        const pts = headArc(B, a, b, 12, (u) => 0.12 + 0.1 * Math.sin(Math.PI * u));
        const rr = resample(pts, 12);
        emitLock(ac, rr.pts, {
            widths: rr.pts.map((_, i) => r * 1.05 * Math.sin(Math.PI * (0.15 + 0.7 * i / 12))), thick: 0.4,
            tip: 0.9, tipStart: 0.6, v0: 0.05, v1: 0.12, outAt: (q) => norm(sub(q, center)), volAt: (q) => norm(sub(q, center)), volBlend: 0.5,
        });
    }
    // core sphere
    ac.curLock = true;
    const LAT = 6, LON = 10, rows: number[][] = [];
    for (let i = 0; i <= LAT; i++) {
        const row: number[] = [];
        for (let j = 0; j < LON; j++) {
            const d = dirOf((i / LAT) * Math.PI, (j / LON) * Math.PI * 2);
            ac.curTan = [Math.cos((j / LON) * Math.PI * 2), 0, Math.sin((j / LON) * Math.PI * 2)];
            row.push(pushV(ac, [center[0] + d[0] * r, center[1] + d[1] * r * 0.85, center[2] + d[2] * r], d, j / LON, 0.08));
        }
        rows.push(row);
    }
    for (let i = 0; i < LAT; i++) for (let j = 0; j < LON; j++) {
        const j2 = (j + 1) % LON, a = rows[i], b = rows[i + 1];
        ac.idx.push(a[j], a[j2], b[j2], a[j], b[j2], b[j]);
    }
    ac.curLock = false;
    void s;
}

/** AHOGE: an antenna lock springing up from the crown and arcing forward. */
function buildAhoge(c: Ctx, k: number): void {
    const { H, h, s } = c;
    const seed = s.lockSeed * 977 + 1300 + k * 17;
    const ph = Math.PI / 2 + jit(seed) * 0.5 + (k === 1 ? 0.7 : 0);
    const root = onHead(H, dirOf(0.12 * Math.PI, ph), c.vol * 0.9);
    const up: V3 = [0, 1, 0], fw: V3 = norm([Math.cos(ph), 0, Math.sin(ph)]);
    const sd: V3 = norm(cross(up, fw)), sx = k === 1 ? -1 : 1;
    const P1 = add(root, add(scl(up, h.ry * 0.32), scl(sd, -sx * h.ry * 0.06)));
    const P2 = add(root, add(add(scl(up, h.ry * 0.42), scl(sd, sx * h.ry * 0.22)), scl(fw, h.ry * 0.08)));
    const P3 = add(root, add(add(scl(up, h.ry * 0.24), scl(sd, sx * h.ry * 0.34)), scl(fw, h.ry * 0.12)));
    const pts = [root, ...cubic(root, P1, P2, P3, 12)];
    emitLock(c.ac, pts, {
        widths: pts.map(() => h.rx * 0.16), thick: 0.35, tip: 1, tipStart: 0.3, v0: 0.02, v1: 0.3,
        outAt: () => fw, volAt: (q) => norm(add(volNormal(H, q), scl(fw, 0.5))), volBlend: 0.4,
    });
}

/**
 * Build the whole lock hairstyle into `ac`. Returns the number of tails (their verts carry tailId 0..n-1, uv.v =
 * the tail's root→tip parameter — the caller builds a spring chain per tail exactly as for the other modes).
 */
export function buildLockHair(ac: LockAccum, h: HeadFrame, p: HairParams, bodyVerts?: Float32Array): number {
    const s = resolveStyle(p);
    const H = buildHead(h, bodyVerts);
    H.R = [h.rx, h.ry * (1 + clamp(p.crownRound ?? 0, 0, 0.5) * 0.35), h.rz];
    const vol = Math.min(0.6, s.lockVolume + s.hairPoof * 0.3);   // curly volume stands the whole mass off the skull
    const vRef = h.ry * (1.7 + Math.max(s.hairLength, s.sideLength));
    const c: Ctx = { ac, H, h, p, s, faceHalf: 0.98, vRef, vol };
    ac.curTailId = -1;
    const attach = tailAttach(c);
    const bunStyle = String(p.bunStyle ?? 'none').toLowerCase();
    const hairlineTh = Math.acos(clamp(p.hairlineFront ?? 0.42, -0.2, 0.92));
    // Gathered styles keep the shell tight + to the nape; loose ones run it down to the hair's own fall line.
    buildShell(c, hairlineTh, s.gather ? 0.6 * Math.PI : 0.56 * Math.PI, s.gather ? vol * 0.5 : vol * 0.45);
    let bunAt: V3 | null = null;
    if (bunStyle !== 'none') bunAt = onHead(H, dirOf(0.16 * Math.PI, -Math.PI / 2), vol * 0.5);
    if (s.gather && (attach.length || bunAt)) buildGathered(c, bunAt ? [bunAt] : attach.map((a) => a.A));
    else buildCrown(c);
    buildFringe(c);
    buildSideLocks(c);
    for (let k = 0; k < s.ahoge; k++) buildAhoge(c, k);
    if (bunAt) {
        const br = h.rx * clamp(p.bunSize ?? 0.5, 0.15, 1.2) * 0.75;
        const d = norm(sub(bunAt, H.c));
        buildBun(c, add(bunAt, scl(d, br * 0.55)), br);
    }
    buildTails(c, attach);
    ac.curTailId = -1;
    return attach.length;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Presets + random styles
// ═══════════════════════════════════════════════════════════════════════════

/** The style presets (named bundles over DEFAULT_HAIR_PARAMS; `hairStylePreset` in hair-generator merges them). */
export const HAIR_STYLE_PRESETS: Record<string, Partial<HairParams>> = {
    'bob': {
        fringeStyle: 'straight', fringeCount: 8, fringeHeight: 0.3,
        hairLength: 0.72, sideLength: 0.62, lockCount: 16, lockTaper: 0.5, lockFlick: -0.55, lockVolume: 0.15, lockJitter: 0.15,
        sideLock: false, tailStyle: 'none', bunStyle: 'none', gather: false, ahoge: 0,
    },
    'long-straight': {
        fringeStyle: 'choppy', fringeCount: 7, fringeHeight: 0.3,
        hairLength: 3.2, sideLength: 2.4, lockCount: 16, lockTaper: 0.85, lockFlick: 0.05, lockVolume: 0.12, lockJitter: 0.2,
        sideLock: true, sideLockCount: 1, sideLockLength: 2.2, sideLockWidth: 0.2, tailStyle: 'none', bunStyle: 'none', gather: false, ahoge: 0,
    },
    'side-swept': {
        fringeStyle: 'swept', fringeCount: 7, fringeHeight: 0.3, fringeSide: 1,
        hairLength: 1.5, sideLength: 1.1, lockCount: 15, lockTaper: 0.85, lockFlick: 0.25, lockVolume: 0.14, lockJitter: 0.3,
        sideLock: true, sideLockCount: 1, sideLockLength: 1.4, sideLockWidth: 0.18, tailStyle: 'none', bunStyle: 'none', gather: false, ahoge: 0,
    },
    'ponytail': {
        fringeStyle: 'choppy', fringeCount: 6, fringeHeight: 0.32,
        hairLength: 0.5, sideLength: 0.4, lockCount: 14, lockTaper: 0.8, lockFlick: 0, lockVolume: 0.08, lockJitter: 0.15,
        sideLock: true, sideLockCount: 1, sideLockLength: 1.2, sideLockWidth: 0.16,
        tailStyle: 'pony', tailHeight: 0.55, tailLength: 3.0, tailThickness: 0.42, tailSpread: 0.45, tailCurl: 0.3, tailTaper: 0.6,
        tailLocks: 6, bunStyle: 'none', gather: true, ahoge: 0,
    },
    'twintails': {
        fringeStyle: 'parted', fringeCount: 8, fringeHeight: 0.3, fringeSide: 0,
        hairLength: 0.85, sideLength: 0.7, lockCount: 15, lockTaper: 0.85, lockFlick: 0.1, lockVolume: 0.12, lockJitter: 0.2,
        sideLock: true, sideLockCount: 1, sideLockLength: 1.5, sideLockWidth: 0.16,
        tailStyle: 'twin', tailHeight: 0.5, tailLength: 3.4, tailThickness: 0.38, tailSpread: 0.55, tailCurl: 0.35, tailTaper: 0.6,
        tailLocks: 5, bunStyle: 'none', gather: true, ahoge: 0,
    },
    'short-messy': {
        fringeStyle: 'choppy', fringeCount: 7, fringeHeight: 0.33,
        hairLength: 0.3, sideLength: 0.15, lockCount: 18, lockTaper: 1, lockFlick: 0.6, lockVolume: 0.17, lockJitter: 0.85,
        sideLock: false, tailStyle: 'none', bunStyle: 'none', gather: false, ahoge: 1,
    },
    'bun': {
        fringeStyle: 'swept', fringeCount: 6, fringeHeight: 0.32, fringeSide: -1,
        hairLength: 0.5, sideLength: 0.4, lockCount: 14, lockTaper: 0.8, lockFlick: 0, lockVolume: 0.08, lockJitter: 0.15,
        sideLock: true, sideLockCount: 1, sideLockLength: 1.3, sideLockWidth: 0.15,
        tailStyle: 'none', bunStyle: 'round', bunSize: 0.62, gather: true, ahoge: 0,
    },
    'hime': {
        fringeStyle: 'straight', fringeCount: 9, fringeHeight: 0.27,
        hairLength: 3.4, sideLength: 3.0, lockCount: 18, lockTaper: 0.15, lockFlick: 0, lockVolume: 0.11, lockJitter: 0.05,
        sideLock: true, sideLockCount: 1, sideLockLength: 0.95, sideLockWidth: 0.24, tailStyle: 'none', bunStyle: 'none', gather: false, ahoge: 0,
    },
    // ── part 2 (2026-10-04): braids, curls / waves, spikes, drills, curly volume ──
    'braid': {
        fringeStyle: 'parted', fringeCount: 8, fringeHeight: 0.3, fringeSide: 0.3,
        hairLength: 0.5, sideLength: 0.45, lockCount: 14, lockTaper: 0.8, lockFlick: 0, lockVolume: 0.08, lockJitter: 0.12,
        sideLock: true, sideLockCount: 1, sideLockLength: 1.1, sideLockWidth: 0.15,
        tailStyle: 'pony', tailHeight: -0.1, tailLength: 3.4, tailThickness: 0.36, tailSpread: 0.12, tailCurl: 0.05, tailTaper: 0.5,
        tailForm: 'braid', bunStyle: 'none', gather: true, ahoge: 0,
    },
    'twin-braids': {
        fringeStyle: 'straight', fringeCount: 8, fringeHeight: 0.3,
        hairLength: 0.5, sideLength: 0.45, lockCount: 14, lockTaper: 0.8, lockFlick: 0, lockVolume: 0.08, lockJitter: 0.12,
        sideLock: false,
        tailStyle: 'pig', tailHeight: 0.4, tailLength: 2.8, tailThickness: 0.3, tailSpread: 0.15, tailCurl: 0.05, tailTaper: 0.5,
        tailForm: 'braid', bunStyle: 'none', gather: true, ahoge: 0,
    },
    'wavy': {
        fringeStyle: 'swept', fringeCount: 7, fringeHeight: 0.3, fringeSide: -1,
        hairLength: 2.6, sideLength: 2.0, lockCount: 13, lockLayers: 1, lockWidth: 1.15, lockTaper: 0.8, lockFlick: 0.1, lockVolume: 0.14, lockJitter: 0.2,
        lockCurl: 0.55, lockCurlType: 'wave', lockCurlFreq: 1.4,
        sideLock: true, sideLockCount: 1, sideLockLength: 2.0, sideLockWidth: 0.18, tailStyle: 'none', bunStyle: 'none', gather: false, ahoge: 0,
    },
    'curls': {
        fringeStyle: 'choppy', fringeCount: 7, fringeHeight: 0.32,
        hairLength: 1.6, sideLength: 1.3, lockCount: 14, lockLayers: 1, lockWidth: 1.1, lockTaper: 0.85, lockFlick: 0, lockVolume: 0.15, lockJitter: 0.25,
        lockCurl: 0.8, lockCurlType: 'spiral', lockCurlFreq: 2.2,
        sideLock: true, sideLockCount: 1, sideLockLength: 1.3, sideLockWidth: 0.16, tailStyle: 'none', bunStyle: 'none', gather: false, ahoge: 0,
    },
    'spiky': {
        fringeStyle: 'choppy', fringeCount: 6, fringeHeight: 0.36,
        hairLength: 0.7, sideLength: 0.3, lockCount: 11, lockLayers: 2, lockThickness: 0.34, lockTaper: 1, lockFlick: 0.3, lockVolume: 0.12, lockJitter: 0.4,
        lockSpike: 0.85,
        sideLock: false, tailStyle: 'none', bunStyle: 'none', gather: false, ahoge: 0,
    },
    'drills': {
        fringeStyle: 'straight', fringeCount: 9, fringeHeight: 0.3,
        hairLength: 1.2, sideLength: 0.9, lockCount: 15, lockTaper: 0.6, lockFlick: -0.1, lockVolume: 0.12, lockJitter: 0.1,
        sideLock: true, sideLockCount: 1, sideLockLength: 1.0, sideLockWidth: 0.16,
        tailStyle: 'twin', tailHeight: 0.4, tailLength: 2.6, tailThickness: 0.5, tailSpread: 0.15, tailCurl: 0, tailTaper: 0.5,
        tailForm: 'drill', drillTurns: 4.5, bunStyle: 'none', gather: false, ahoge: 0,
    },
    'curly-volume': {
        fringeStyle: 'choppy', fringeCount: 7, fringeHeight: 0.34,
        hairLength: 0.75, sideLength: 0.6, lockCount: 16, lockLayers: 1, lockWidth: 1.15, lockThickness: 0.34, lockTaper: 0.9, lockFlick: 0.2, lockVolume: 0.14, lockJitter: 0.35,
        lockCurl: 0.7, lockCurlType: 'spiral', lockCurlFreq: 3, hairPoof: 0.8, crownRound: 0.4,
        sideLock: false, tailStyle: 'none', bunStyle: 'none', gather: false, ahoge: 0,
    },
};

/** Display names for the presets (the Frogmarks style picker). */
export const HAIR_STYLE_LABELS: Record<string, string> = {
    'bob': 'Bob', 'long-straight': 'Long straight', 'side-swept': 'Side-swept', 'ponytail': 'Ponytail',
    'twintails': 'Twintails', 'short-messy': 'Short messy', 'bun': 'Bun', 'hime': 'Hime cut',
    'braid': 'Braid', 'twin-braids': 'Twin braids', 'wavy': 'Wavy', 'curls': 'Curls', 'spiky': 'Spiky',
    'drills': 'Drill curls', 'curly-volume': 'Curly volume',
};

/** Random-character weights per style (absent = 1): the everyday styles are common, the showy ones rarer. */
export const HAIR_STYLE_WEIGHTS: Record<string, number> = {
    'bob': 1.2, 'long-straight': 1.2, 'side-swept': 1, 'ponytail': 1.1, 'twintails': 0.9, 'short-messy': 1, 'bun': 0.8, 'hime': 0.7,
    'braid': 0.8, 'twin-braids': 0.7, 'wavy': 0.9, 'curls': 0.7, 'spiky': 0.7, 'drills': 0.5, 'curly-volume': 0.6,
};

/** A random lock style: one preset (weighted by HAIR_STYLE_WEIGHTS) + seeded per-character variation that keeps the
 *  fringe above the eyes. */
export function randomLockStyle(rand: () => number): Partial<HairParams> & { hairStyle: string } {
    const names = Object.keys(HAIR_STYLE_PRESETS);
    const wts = names.map((n) => Math.max(0, HAIR_STYLE_WEIGHTS[n] ?? 1));
    let x = rand() * wts.reduce((a, b) => a + b, 0), name = names[names.length - 1];
    for (let i = 0; i < names.length; i++) { x -= wts[i]; if (x < 0) { name = names[i]; break; } }
    const base = HAIR_STYLE_PRESETS[name];
    const r = (a: number, b: number) => a + (b - a) * rand();
    const out: Partial<HairParams> & { hairStyle: string } = {
        ...base,
        hairStyle: name,
        fringeHeight: clamp((base.fringeHeight ?? 0.3) + r(-0.02, 0.04), 0.26, 0.38),
        fringeSide: base.fringeStyle === 'parted' ? r(-0.35, 0.35) : (rand() < 0.5 ? -1 : 1) * r(0.6, 1),
        lockCount: Math.round((base.lockCount ?? 15) + r(-2, 2)),
        lockVolume: clamp((base.lockVolume ?? 0.12) + r(-0.02, 0.03), 0.05, 0.25),
        lockFlick: clamp((base.lockFlick ?? 0) + r(-0.15, 0.15), -1, 1),
        lockSeed: Math.floor(rand() * 10000),
    };
    if (base.hairLength !== undefined) out.hairLength = base.hairLength * r(0.88, 1.12);
    if (base.sideLength !== undefined) out.sideLength = base.sideLength * r(0.88, 1.12);
    if (base.tailLength !== undefined) out.tailLength = base.tailLength * r(0.85, 1.15);
    return out;
}
