// ── World generation — the LIVE near-field crowd (pure half) ─────────────────────────────────────────────────────
// The static crowd (pedestrians.ts) is MERGED per colour into a handful of big layers, so an individual can't move.
// To make the standing crowd look alive, the N people nearest the camera are PROMOTED: their triangles are lifted
// out of the merged layers (degenerated in place — renderer patchMeshIndices, a few KB of index upload, no pool
// rebuild) and re-drawn by small per-part LIVE meshes built from EXACTLY those triangles (so the swap is invisible:
// same vertices, same normals, same materials), posed every frame by subtle pose-matched IDLE behaviours
// (breathing, weight shifts, head turns, phone scrolling, talking gestures + nods toward the group's speaker,
// shifting on benches, leaners and rail-watchers looking about). Everything is scaled by an ENVELOPE that ramps
// 0 → 1 after promotion and back to 0 before demotion — at 0 the live pose IS the static pose.
//
// This module is the pure, allocation-free-per-frame core, shared by the services-side WorldLiveCrowd and the
// tests: the per-layer metadata the builder attaches (CrowdMeta), the rig-group mapping, the deterministic idle
// channels (a function of person + time only — no state), the part-geometry extraction / rebase, and the
// hysteresis selection. See docs/specs/polish-round-3.md "Round 7 — live crowd".

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { ArmHold, Pose } from './mannequin';
import { CP_LEGL, CP_LEGR, CP_ARML, CP_ARMR, CP_PHONE, CP_HEAD, PV_COUNT } from './mannequin';

/** One static person, as recorded by buildPedestrians (build/layout space — before the drape + domain warp). */
export interface CrowdPerson {
    /** Anchor (feet / seat) in build space (world units). */
    x: number; z: number;
    /** Heading: the Ry angle (Mesh3D rotateY) that maps the person's +X (face) to their facing direction. */
    yaw: number;
    pose: Pose;
    kind: string;
    /** Conversation GROUP id (people in one ring), −1 when alone. */
    group: number;
    /** Per-person hash (0‥1) — desynchronises every idle channel. */
    seed: number;
    /** Height scale (heightM / 1.70) and world units per metre. */
    k: number; u: number;
    /** The relaxed / leading leg (the one that shuffles on a weight shift). */
    lead: -1 | 1;
    holdL: ArmHold; holdR: ArmHold;
    /** Joint pivots (PV_* × xyz, build space). */
    piv: number[];
}

/** Metadata on each static-crowd layer GEOMETRY (`geometry.crowd`): which index sub-range of THIS layer holds which
 *  body part of which person. Carried through the drape (in place), the worker transfer (spread copy), and the
 *  chunk split (remapped person-aware — a person never straddles two cells). */
export interface CrowdMeta {
    /** Shared by every layer of one build (same array). */
    people: CrowdPerson[];
    /** Stride 4: person index, part (CP_*), index start, index count — in index order. */
    ranges: Uint32Array;
    /** Stride 3: build-space position of the vertex `indices[start]` of each range — its drift to the final
     *  (draped / warped / tile-offset) vertex is the person's build → render offset. */
    refs: Float32Array;
}
export type CrowdGeometry = MeshGeometry & { crowd?: CrowdMeta };

// ── Rig groups ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Live rig groups — one set of per-colour meshes each, posed rigidly about its pivot. */
export const RG_LOWER = 0, RG_LEAD = 1, RG_UPPER = 2, RG_HEAD = 3, RG_ARML = 4, RG_ARMR = 5;
export const RG_COUNT = 6;

/** Whether an arm with this hold may move on its own (a hand on a rail / a strap / a bag / an umbrella / clasped
 *  with the other hand must stay put). */
export function armAnimatable(hold: ArmHold): boolean {
    return hold === 'free' || hold === 'phone' || hold === 'talk' || hold === 'pocket' || hold === 'lap';
}
/** Standing poses whose relaxed leg may shuffle on a weight shift. */
function standing(p: Pose): boolean { return p !== 'sit' && p !== 'lean' && p !== 'rail' && p !== 'ride'; }

/** Which rig group a recorded body part rides in, for this person. */
export function rigGroupOf(person: CrowdPerson, part: number): number {
    switch (part) {
        case CP_LEGL: case CP_LEGR: {
            const side = part === CP_LEGL ? -1 : 1;
            return standing(person.pose) && side === person.lead ? RG_LEAD : RG_LOWER;
        }
        case CP_HEAD: return RG_HEAD;
        case CP_ARML: return armAnimatable(person.holdL) ? RG_ARML : RG_UPPER;
        case CP_ARMR: case CP_PHONE: return armAnimatable(person.holdR) ? RG_ARMR : RG_UPPER;
        default: return RG_UPPER;   // skirt, torso + collars, bag, umbrella
    }
}
/** The pivot (PV_*) a rig group rotates about. */
export function rigPivot(person: CrowdPerson, group: number): number {
    switch (group) {
        case RG_LOWER: return 0;   // (never moves — any pivot)
        case RG_LEAD: return person.lead < 0 ? 4 : 5;
        case RG_HEAD: return 1;
        case RG_ARML: return 2;
        case RG_ARMR: return 3;
        default: return 0;
    }
}

// ── Idle channels ────────────────────────────────────────────────────────────────────────────────────────────────
export const CH_UROLL = 0, CH_UPITCH = 1, CH_UYAW = 2, CH_UDY = 3, CH_UDZ = 4;   // upper body: roll / pitch / twist / breathe / hip shift
export const CH_HYAW = 5, CH_HPITCH = 6, CH_HROLL = 7;                               // head
export const CH_ALP = 8, CH_ALR = 9, CH_ARP = 10, CH_ARR = 11;                       // arms: pitch (swing fwd) / roll (abduct)
export const CH_LEAD = 12;                                                            // relaxed leg: hip swing
export const CH_COUNT = 13;

const TAU = Math.PI * 2;
const smooth = (t: number): number => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);

// ALLOCATION-FREE hot path. V8 passes doubles between non-inlined functions as boxed HeapNumbers (and boxes a double
// return value), so the per-frame helpers below take only small INTEGERS (Smis: keys, salts, milliseconds, permille)
// and exchange their doubles through this scratch: HN[0] = the evaluation time (s), HN[1] = the helper's result.
const HN = new Float64Array(2);
const IH = 1 / 1073741824;
const IHN = 1073741824;
/** Integer hash of three ints → [0, 2^30) (always a Smi). */
function ih(a: number, b: number, c: number): number {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
    return (h ^ (h >>> 16)) >>> 2;
}
/** SMOOTH RANDOM HOLD at t = HN[0], written to HN[1] in [−1, 1]: a new hashed target every `periodMs` (phase-shifted
 *  per key), eased into over the first `transPm` permille of the window, then held — "look over there … a while
 *  later look elsewhere". */
function hold(key: number, salt: number, periodMs: number, transPm: number): void {
    const x = HN[0] * 1000 / periodMs + ih(key, salt, 0x51f3) * IH;
    const w = Math.floor(x), f = x - w, wi = w | 0;
    const a = ih(key, wi - 1, salt) * IH * 2 - 1, b = ih(key, wi, salt) * IH * 2 - 1;
    let e = f * 1000 / transPm;
    e = e >= 1 ? 1 : e * e * (3 - 2 * e);
    HN[1] = a + (b - a) * e;
}
/** The hold as a plain function of (key, salt, t, period s, trans fraction) — for tests / tools. Pure. */
export function holdNoise(key: number, salt: number, t: number, period: number, trans: number): number {
    HN[0] = t;
    hold(key | 0, salt | 0, Math.max(1, Math.round(period * 1000)), Math.max(1, Math.round(trans * 1000)));
    return HN[1];
}

/** Per-person constants the idle evaluation needs besides the CrowdPerson itself: the direction (person frame,
 *  radians of head yaw) to each other member of its group, and which member is the group's speaker slot. */
export interface IdleContext {
    /** Head-yaw angles (person frame) toward up to 4 other group members; `nLook` valid entries. */
    look: Float32Array; nLook: number;
    /** This person's slot in its group (0‥n−1) and the group size (0 = alone). */
    slot: number; groupN: number;
}
export function makeIdleContext(): IdleContext { return { look: new Float32Array(4), nLook: 0, slot: 0, groupN: 0 }; }

/** Fill `ctx` for person `i` of `people` (promotion-time, not per frame). */
export function buildIdleContext(people: readonly CrowdPerson[], i: number, groupMembers: readonly number[], ctx: IdleContext): void {
    const p = people[i];
    ctx.nLook = 0; ctx.slot = 0; ctx.groupN = 0;
    if (p.group < 0 || groupMembers.length < 2) return;
    ctx.groupN = groupMembers.length;
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    for (let m = 0; m < groupMembers.length; m++) {
        const j = groupMembers[m];
        if (j === i) { ctx.slot = m; continue; }
        if (ctx.nLook >= 4) continue;
        const q = people[j], dx = q.x - p.x, dz = q.z - p.z;
        // world → person frame (Ry(yaw) maps +X to (cos, −sin)): fwd = (c, −s), lateral = (s, c)
        const fx = dx * c - dz * s, lz = dx * s + dz * c;
        let a = Math.atan2(-lz, fx);
        if (a > 0.75) a = 0.75; else if (a < -0.75) a = -0.75;
        ctx.look[ctx.nLook++] = a;
    }
}

/** Evaluate every idle channel for one person at time `t` (seconds), scaled by the envelope `env` (0 = exactly the
 *  static pose). Writes CH_COUNT floats into `out` at `o`. Pure + allocation-free. Angles in radians, offsets in
 *  WORLD UNITS (metres × u). */
export function evalIdle(p: CrowdPerson, ctx: IdleContext, t: number, env: number, out: Float32Array, o = 0): void {
    for (let c = 0; c < CH_COUNT; c++) out[o + c] = 0;
    if (env <= 0) return;
    HN[0] = t;
    const key = Math.floor(p.seed * 1e6) | 0;
    const ph = p.seed * TAU, m = p.u * p.k;   // metres (x height) -> world units
    const pose = p.pose, sit = pose === 'sit';
    // BREATHING (everyone): a 3.4–4.6 s cycle — the chest rises and the upper body sways back a touch.
    const br = Math.sin(t * TAU / (3.4 + 1.2 * p.seed) + ph);
    out[o + CH_UDY] = 0.005 * m * (br * 0.5 + 0.5);
    out[o + CH_UPITCH] = 0.008 * br;
    // WEIGHT SHIFTS (standing): the hips settle over one foot, then the other every ~5–9 s — the upper body rolls
    // toward the standing side and the relaxed leg shuffles while the weight moves.
    const periodMs = 5000 + ((4000 * ih(key, 3, 0x77) * IH) | 0);
    if (standing(pose)) {
        hold(key, 0x1a, periodMs, 300);
        const w = HN[1];
        out[o + CH_UROLL] = 0.032 * w;
        out[o + CH_UDZ] = 0.01 * m * w;
        // …and now and then a slow half-turn of the shoulders (looking round without stepping)
        hold(key, 0x1c, 11000 + ((5000 * p.seed) | 0), 250); out[o + CH_UYAW] = 0.12 * HN[1];
        // shuffle: the lead leg's hip swings while the hold eases (a bump over the transition), plus a slow drift
        const x = t * 1000 / periodMs + ih(key, 0x1a, 0x51f3) * IH, f = x - Math.floor(x);
        const bump = f < 0.3 ? Math.sin((f / 0.3) * Math.PI) : 0;
        out[o + CH_LEAD] = 0.07 * bump * ((ih(key, Math.floor(x) | 0, 0x1b) & 1) ? 1 : -1) + 0.02 * w;
    } else if (sit) {   // SHIFTING ON THE BENCH: lean forward / sit back, a slow twist
        hold(key, 0x2a, 7000 + ((4000 * p.seed) | 0), 350); out[o + CH_UPITCH] += -0.05 * (HN[1] * 0.5 + 0.5);
        hold(key, 0x2b, 9000, 300); out[o + CH_UYAW] = 0.08 * HN[1];
        hold(key, 0x2c, 6000, 400); out[o + CH_UROLL] = 0.01 * HN[1];
    } else {   // leaners / rail-watchers: a slow settle
        hold(key, 0x3a, 8000, 400); out[o + CH_UROLL] = 0.012 * HN[1];
        hold(key, 0x3b, 10000, 300); out[o + CH_UYAW] = 0.05 * HN[1];
    }
    // HEAD: look around (hold targets), with a small nod / tilt; phone readers keep their eyes down and glance up.
    let hy = 0, hp = 0;
    const phone = p.holdR === 'phone';
    if (ctx.groupN >= 2) {
        // CONVERSATION: a speaker slot rotates every ~3–5 s (hash over the group + window); the speaker looks from
        // listener to listener with emphasis nods, the listeners turn toward the speaker (now and then glancing at
        // another member) and nod along. Roles cross-fade over the first quarter of each window (no head snaps).
        const gpMs = 3200 + ((1800 * ih(p.group, 1, 0x9c) * IH) | 0);
        const gx = t * 1000 / gpMs + ih(p.group, 2, 0x9d) * IH, gw = Math.floor(gx) | 0, gf = gx - Math.floor(gx);
        const sb = gf >= 0.25 ? 1 : smooth(gf / 0.25);
        for (let k = 0; k < 2; k++) {
            const wt = k === 0 ? 1 - sb : sb;
            if (wt <= 0) continue;
            const w = gw - 1 + k, speaker = ih(p.group, w, 0x9e) % ctx.groupN;
            let y = 0, pc = 0;
            if (speaker === ctx.slot) {
                hold(key, 0x4a, 1400, 400); y = 0.18 * HN[1];
                pc = -0.035 * Math.max(0, Math.sin(t * TAU / 0.75 + ph));
            } else {
                const target = speaker > ctx.slot ? speaker - 1 : speaker;   // the speaker's index among the OTHERS
                const glance = ih(key, w, 0x9f) < 0.2 * IHN && ctx.nLook > 1 ? (target + 1) % ctx.nLook : target;
                y = ctx.nLook ? ctx.look[glance < ctx.nLook ? glance : ctx.nLook - 1] * 0.85 : 0;
                const nx = t / 1.7, nf = nx - Math.floor(nx);
                pc = ih(key, Math.floor(nx) | 0, 0xa0) < 0.35 * IHN ? -0.07 * Math.max(0, Math.sin(nf * TAU)) : 0;
            }
            hy += wt * y; hp += wt * pc;
        }
        hold(key, 0x4b, 2300, 400); hy += 0.05 * HN[1];
        out[o + CH_UYAW] += 0.3 * hy;   // the shoulders follow the gaze a little
        hy *= 0.7;
    } else if (phone) {
        hold(key, 0x5a, 4000 + ((3000 * p.seed) | 0), 500);
        const up = HN[1], look = up > 0.4 ? smooth((up - 0.4) / 0.5) : 0;   // now and then: look up from the screen, glance about
        hold(key, 0x5b, 2200, 300);
        hp = 0.04 * Math.sin(t * TAU / 2.6 + ph) * (1 - look) - 0.16 * look;
        hy = 0.35 * look * HN[1];
    } else {
        const amp = pose === 'rail' ? 0.55 : pose === 'stride' ? 0.3 : 0.5;
        hold(key, 0x6a, 2600 + ((2400 * p.seed) | 0), 300); hy = amp * HN[1];
        hold(key, 0x6b, 3700, 300); hp = 0.07 * HN[1];
    }
    out[o + CH_HYAW] = hy;
    out[o + CH_HPITCH] = hp;
    hold(key, 0x6c, 5100, 350); out[o + CH_HROLL] = 0.04 * HN[1];
    // ARMS: phone scrolling (a small bob + a thumb-flick tilt), talking gestures in bursts, free arms drift with the
    // weight shift, seated hands shift on the lap.
    for (let side = -1; side <= 1; side += 2) {
        const hd = side < 0 ? p.holdL : p.holdR, pc = o + (side < 0 ? CH_ALP : CH_ARP), rc = pc + 1;
        let pa = 0, ra = 0;
        if (hd === 'phone') { hold(key, 0x7a, 3100, 300); pa = 0.035 * Math.sin(t * TAU / 1.9 + ph) + 0.02 * HN[1]; }
        else if (hd === 'talk') {
            hold(key, 0x7b, 2200, 350);
            const burst = smooth(HN[1] * 1.5 - 0.2), talking = ctx.groupN >= 2 ? 1 : 0.5;
            pa = 0.16 * burst * (0.6 + 0.4 * Math.sin(t * TAU / 0.9 + ph)) * talking;
            ra = 0.08 * burst * Math.sin(t * TAU / 1.3 + ph * 2) * talking;
        } else if (hd === 'free') { hold(key, 0x7c + side, periodMs, 300); pa = 0.025 * HN[1]; ra = -0.5 * out[o + CH_UROLL]; }   // hangs ~plumb as the hips roll
        else if (hd === 'pocket') { hold(key, 0x7e + side, periodMs, 300); pa = 0.012 * HN[1]; }
        else if (hd === 'lap') { hold(key, 0x7f + side, 6500, 300); pa = 0.03 * HN[1]; }
        out[pc] = pa; out[rc] = ra;
    }
    for (let c = 0; c < CH_COUNT; c++) out[o + c] *= env;
}

// ── Promotion (hysteresis selection) ─────────────────────────────────────────────────────────────────────────────
/** Pick which candidates are LIVE. Inputs per candidate i (< n): `d2` = squared camera distance, `inView` (0/1),
 *  `live` (0/1, currently promoted). A live person stays while inside `rOut` (and within the budget, nearest-first);
 *  a static one is promoted inside `rIn` when there's room — people in view before people off-screen, nearest first.
 *  Writes 0/1 into `want`. `order` is caller-owned scratch (length ≥ n). Allocation-free. Returns the live count. */
export function selectLive(n: number, d2: Float32Array, inView: Uint8Array, live: Uint8Array, rIn: number, rOut: number,
    budget: number, want: Uint8Array, order: Int32Array, key: Float32Array): number {
    const rIn2 = rIn * rIn, rOut2 = rOut * rOut;
    let m = 0;
    for (let i = 0; i < n; i++) {
        want[i] = 0;
        const keep = live[i] ? d2[i] < rOut2 : d2[i] < rIn2;
        if (!keep) continue;
        // priority key: live people get a hysteresis bonus (their distance counts ×0.8), off-screen ones a penalty
        key[i] = d2[i] * (live[i] ? 0.64 : 1) * (inView[i] ? 1 : 4);
        order[m++] = i;
    }
    // partial selection of the `budget` smallest keys (insertion sort on the small candidate list — m is the
    // people within ~rOut of the camera, typically < 150)
    for (let a = 1; a < m; a++) {
        const v = order[a], kv = key[v];
        let b = a - 1;
        while (b >= 0 && key[order[b]] > kv) { order[b + 1] = order[b]; b--; }
        order[b + 1] = v;
    }
    const cnt = Math.min(budget, m);
    for (let a = 0; a < cnt; a++) want[order[a]] = 1;
    return cnt;
}

// ── Part geometry (lifted from the merged layer) ─────────────────────────────────────────────────────────────────
const FPV = 12;

/** Copy the triangles of `ranges` (pairs start,count into `geo.indices`) into a compact standalone geometry whose
 *  vertices are REBASED into a rig frame: v' = Ry(−yaw)·(v − pivot), normals rotated likewise. Placing the result
 *  at `pivot` with rotateY(yaw) (and no other rotation) reproduces the source vertices exactly. */
export function extractPart(geo: MeshGeometry, ranges: readonly number[], pivot: ArrayLike<number>, yaw: number): MeshGeometry {
    const idx = geo.indices, v = geo.vertices;
    let nIdx = 0;
    for (let r = 0; r < ranges.length; r += 2) nIdx += ranges[r + 1];
    const io = new Uint32Array(nIdx);
    // remap pass (first-use order)
    const remap: number[] = [];
    let k = 0, nv = 0;
    const map = new Map<number, number>();
    for (let r = 0; r < ranges.length; r += 2) {
        const s = ranges[r], e = s + ranges[r + 1];
        for (let i = s; i < e; i++) {
            const vi = idx[i];
            let o = map.get(vi);
            if (o === undefined) { o = nv++; map.set(vi, o); remap.push(vi); }
            io[k++] = o;
        }
    }
    const vo = new Float32Array(nv * FPV);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // Ry(yaw): x' = x c + z s, z' = −x s + z c  →  inverse: x = x' c − z' s, z = x' s + z' c
    for (let j = 0; j < nv; j++) {
        const si = remap[j] * FPV, di = j * FPV;
        for (let f = 0; f < FPV; f++) vo[di + f] = v[si + f];
        const dx = v[si] - pivot[0], dy = v[si + 1] - pivot[1], dz = v[si + 2] - pivot[2];
        vo[di] = dx * c - dz * s; vo[di + 1] = dy; vo[di + 2] = dx * s + dz * c;
        const nx = v[si + 3], nz = v[si + 5];
        vo[di + 3] = nx * c - nz * s; vo[di + 5] = nx * s + nz * c;
    }
    return { vertices: vo, indices: io, format: geo.format ?? '12float' };
}

/** Degenerate (hide) the triangles of index range [start, start+count) in place — every index becomes the range's
 *  first index (zero-area triangles the rasterizer drops). Returns the original indices (for the restore). */
export function degenerateRange(indices: Uint32Array, start: number, count: number): Uint32Array {
    const backup = indices.slice(start, start + count);
    const v0 = indices[start];
    indices.fill(v0, start, start + count);
    return backup;
}

/** Person rig: a 3×3 rotation Ry(a)·Rx(b)·Rz(c) (Mesh3D's Y → X → Z order) applied to `p`, written to `out`. */
export function rotYXZ(a: number, b: number, c: number, px: number, py: number, pz: number, out: Float64Array | Float32Array, o = 0): void {
    // Rz(c)
    const cc = Math.cos(c), sc = Math.sin(c);
    let x = px * cc - py * sc, y = px * sc + py * cc, z = pz;
    // Rx(b)
    const cb = Math.cos(b), sb = Math.sin(b);
    const y2 = y * cb - z * sb, z2 = y * sb + z * cb; y = y2; z = z2;
    // Ry(a): x' = x ca + z sa, z' = −x sa + z ca
    const ca = Math.cos(a), sa = Math.sin(a);
    out[o] = x * ca + z * sa; out[o + 1] = y; out[o + 2] = -x * sa + z * ca;
}

/** A live person's render-space rig pivots (RG_COUNT × xyz, from the build-space PV_* pivots + the build → render
 *  offset) and each group's pivot relative to the UPPER pivot in the person frame (Ry(−yaw)). */
export function rigFrames(p: CrowdPerson, ox: number, oy: number, oz: number, piv: Float64Array, rel: Float64Array): void {
    for (let rg = 0; rg < RG_COUNT; rg++) {
        const k = rigPivot(p, rg) * 3;
        piv[rg * 3] = p.piv[k] + ox; piv[rg * 3 + 1] = p.piv[k + 1] + oy; piv[rg * 3 + 2] = p.piv[k + 2] + oz;
    }
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw), U = RG_UPPER * 3;
    for (let rg = 0; rg < RG_COUNT; rg++) {
        const dx = piv[rg * 3] - piv[U], dy = piv[rg * 3 + 1] - piv[U + 1], dz = piv[rg * 3 + 2] - piv[U + 2];
        rel[rg * 3] = dx * c - dz * s; rel[rg * 3 + 1] = dy; rel[rg * 3 + 2] = dx * s + dz * c;
    }
}

function putRig(out: Float64Array, rg: number, x: number, y: number, z: number, ry: number, rz: number, rx: number): void {
    const o = rg * RIG_STRIDE; out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = ry; out[o + 4] = rz; out[o + 5] = rx;
}
/** Stride of {@link poseRig}'s output per rig group: x, y, z, ry, rz, rx (Mesh3D setPoseXYZYaw order). */
export const RIG_STRIDE = 6;
/** Every rig group's mesh transform for the idle channels `ch` (zeros → the static pose exactly: each group sits at
 *  its pivot with rotateY(yaw)). The upper body rolls / pitches / twists about the hip and carries the head + arms
 *  (their pivots swing with it); the head and arms add their own rotation; the relaxed leg swings about its hip;
 *  the lower body never moves. Allocation-free (`tmp` ≥ 3). */
export function poseRig(yaw: number, piv: Float64Array, rel: Float64Array, ch: Float32Array, out: Float64Array, tmp: Float64Array): void {
    const c = Math.cos(yaw), sn = Math.sin(yaw), U = RG_UPPER * 3;
    const uy = yaw + ch[CH_UYAW], ur = ch[CH_UROLL], up = ch[CH_UPITCH];
    const ux = piv[U] + sn * ch[CH_UDZ], uY = piv[U + 1] + ch[CH_UDY], uz = piv[U + 2] + c * ch[CH_UDZ];
    putRig(out, RG_LOWER, piv[RG_LOWER * 3], piv[RG_LOWER * 3 + 1], piv[RG_LOWER * 3 + 2], yaw, 0, 0);
    putRig(out, RG_LEAD, piv[RG_LEAD * 3], piv[RG_LEAD * 3 + 1], piv[RG_LEAD * 3 + 2], yaw, ch[CH_LEAD], 0);
    putRig(out, RG_UPPER, ux, uY, uz, uy, up, ur);
    for (let rg = RG_HEAD; rg <= RG_ARMR; rg++) {
        rotYXZ(uy, ur, up, rel[rg * 3], rel[rg * 3 + 1], rel[rg * 3 + 2], tmp, 0);
        let ry = uy, rx = ur, rz = up;
        if (rg === RG_HEAD) { ry += ch[CH_HYAW]; rz += ch[CH_HPITCH]; rx += ch[CH_HROLL]; }
        else if (rg === RG_ARML) { rz += ch[CH_ALP]; rx += ch[CH_ALR]; }
        else { rz += ch[CH_ARP]; rx += ch[CH_ARR]; }
        putRig(out, rg, ux + tmp[0], uY + tmp[1], uz + tmp[2], ry, rz, rx);
    }
}

export { PV_COUNT };
