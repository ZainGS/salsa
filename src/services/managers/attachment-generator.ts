// ── Attachment / charm generator ──────────────────────────────────────────────
// Small parametric meshes "pinned" to a body joint and skinned 100% to it, so they follow the pose. This is the
// foundation of the charms/accessories engine (docs/specs/wardrobe-expansion.md Phase 2): one placement + skin
// pipeline, then each charm TYPE is a tiny generator. First types: a hanging CHAIN and an appliqué POCKET.
// (Bracelet / choker / pendant / clip / flower etc. slot in here the same way later.)
//
// Joint-anchored placement only for v1: `placement.joint` (e.g. 'hips', 'upperleg_L', 'neck') + a local `offset`
// in the rest pose. Surface-pinned (click on a garment) + spring-bone dangle are follow-ups.

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import type { BodyFit, BodyMeshData } from './clothing-generator';
import { torsoExtentAt } from './clothing-generator';
import type { ArmRing } from './body-generator';

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** The "down-limb" child joint name (gives the limb's long axis), by the rig's naming convention. Null = no limb axis. */
function childOf(name: string): string | null {
    const s = name.endsWith('_L') ? '_L' : name.endsWith('_R') ? '_R' : '';
    if (name.startsWith('upperleg')) return 'lowerleg' + s;
    if (name.startsWith('lowerleg')) return 'foot' + s;
    if (name.startsWith('upperarm') || name.startsWith('shoulder')) return 'lowerarm' + s;
    if (name.startsWith('lowerarm')) return 'hand' + s;
    if (name === 'hips' || name === 'lowerback') return 'spine';
    if (name === 'spine') return 'chest';
    if (name === 'chest') return 'neck';
    if (name === 'neck') return 'head';
    return null;
}

/** A stable perpendicular basis for a direction (parallel-transport-free; fine for static charms). */
function frame(dir: V3): { u: V3; v: V3 } {
    const d = norm(dir);
    const ref: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(d, ref));
    return { u, v: norm(cross(d, u)) };
}

type BandFit = { center: V3; radius: number };

/** The body's true cross-section at a wrap band: sample the body verts in a thin slab around the band (skinned to the
 *  limb joint(s)), take their in-plane CENTROID (so the band recentres onto the flesh — the bone isn't always centred
 *  in it) + the median distance from that centroid (the radius). HUGS the limb, unlike the joint's SCALAR radius
 *  (inflated by the jaw/shoulders on the neck, the palm on the wrist). Null if too few samples. */
function sampleLimbFit(body: BodyMeshData, C: V3, axis: V3, idxA: number, idxB: number, slabHalf: number): BandFit | null {
    const v = body.verts, ji = body.ji, jw = body.jw, n = v.length / 12;
    const pts: V3[] = [];
    for (let i = 0; i < n; i++) {
        let w = 0;
        for (let k = 0; k < 4; k++) { const j = ji[i * 4 + k]; if (j === idxA || j === idxB) w += jw[i * 4 + k]; }
        if (w < 0.5) continue;                                       // only verts that belong to this limb
        const px = v[i * 12] - C[0], py = v[i * 12 + 1] - C[1], pz = v[i * 12 + 2] - C[2];
        const t = px * axis[0] + py * axis[1] + pz * axis[2];        // distance along the bone from the band
        if (Math.abs(t) > slabHalf) continue;                        // thin slab around the band height only
        pts.push([px - t * axis[0], py - t * axis[1], pz - t * axis[2]]);   // project into the band plane (rel. to C)
    }
    if (pts.length < 3) return null;
    let cx = 0, cy = 0, cz = 0; for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
    cx /= pts.length; cy /= pts.length; cz /= pts.length;            // flesh centroid in the band plane
    const ds = pts.map(p => Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz)).sort((a, b) => a - b);
    return { center: [C[0] + cx, C[1] + cy, C[2] + cz], radius: ds[ds.length >> 1] };
}

/** The clean arm fit at a band position from the NEAREST captured arm-surface RING (the same per-ring cross-sections
 *  the sleeves fit to): its centroid (kept at the band's height) + average radius. More robust than the raw-vert slab
 *  for arms — it can't catch the elbow / wrist / a muscle bulge from a neighbouring section. */
function ringFitAt(rings: ArmRing[], C: V3, axis: V3): BandFit | null {
    let best: ArmRing | undefined, bestD = Infinity;
    for (const ring of rings) {
        const d = Math.abs((ring.center[0] - C[0]) * axis[0] + (ring.center[1] - C[1]) * axis[1] + (ring.center[2] - C[2]) * axis[2]);
        if (d < bestD) { bestD = d; best = ring; }                  // the ring whose plane is nearest the band
    }
    if (!best || best.verts.length === 0) return null;
    let sum = 0;
    for (const rv of best.verts) sum += Math.hypot(rv.p[0] - best.center[0], rv.p[1] - best.center[1], rv.p[2] - best.center[2]);
    // recentre laterally onto the ring but keep the band at the user's chosen height (project the ring centre to C's plane)
    const dx = best.center[0] - C[0], dy = best.center[1] - C[1], dz = best.center[2] - C[2];
    const ax = dx * axis[0] + dy * axis[1] + dz * axis[2];
    return { center: [best.center[0] - axis[0] * ax, best.center[1] - axis[1] * ax, best.center[2] - axis[2] * ax], radius: sum / best.verts.length };
}

type RingBracket = { a: ArmRing; b: ArmRing; f: number };

/** The two arm-surface rings BRACKETING the band's height along the bone + the lerp fraction `f` — so the band slides
 *  SMOOTHLY (interpolating between rings) instead of snapping to the nearest one. Clamps to an end ring out of range. */
function bracketRings(rings: ArmRing[], C: V3, axis: V3): RingBracket | null {
    const tC = C[0] * axis[0] + C[1] * axis[1] + C[2] * axis[2];   // band height projected onto the bone
    let lo: ArmRing | undefined, hi: ArmRing | undefined, loT = -Infinity, hiT = Infinity;
    for (const r of rings) {
        const t = r.center[0] * axis[0] + r.center[1] * axis[1] + r.center[2] * axis[2];
        if (t <= tC && t > loT) { loT = t; lo = r; }                // nearest ring below
        if (t >= tC && t < hiT) { hiT = t; hi = r; }                // nearest ring above
    }
    if (lo && hi) return { a: lo, b: hi, f: hiT > loT ? (tC - loT) / (hiT - loT) : 0 };
    const only = lo ?? hi;
    return only ? { a: only, b: only, f: 0 } : null;
}

/** A band that CONFORMS to the arm cross-section (oval / faceted / off-centre) so it can't gap or clip — and slides
 *  SMOOTHLY: it INTERPOLATES between the two bracketing rings by `f`, outsets each vert radially by `clearance`, and
 *  extrudes ±`hw` along the bone. (Per-vert lerp assumes both rings share vert count + ordering — true for the tube;
 *  if they differ it just uses the lower ring.) */
function bandConform(a: Acc, br: RingBracket, axis: V3, hw: number, clearance: number, j: number): void {
    const same = br.a.verts.length === br.b.verts.length;
    const A = br.a, B = same ? br.b : br.a, f = same ? br.f : 0, m = A.verts.length;
    if (m < 3) return;
    const mix = (p: V3, q: V3): V3 => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f];
    const c = mix(A.center, B.center);
    const edge = (off: number): number[] => {
        const out: number[] = [];
        for (let k = 0; k < m; k++) {
            const pk = mix(A.verts[k].p as V3, B.verts[k].p as V3);
            const rad = sub(pk, c), rl = len(rad) || 1e-4;
            out.push(vert(a, add(add(c, scl(rad, (rl + clearance) / rl)), scl(axis, off)), [k / m, off > 0 ? 1 : 0], j));
        }
        return out;
    };
    const r0 = edge(-hw), r1 = edge(hw);
    for (let k = 0; k < m; k++) { const k2 = (k + 1) % m; quad(a, r0[k], r0[k2], r1[k2], r1[k]); }
}

export type AttachmentType = 'chain' | 'pocket' | 'pendant' | 'bracelet' | 'watch' | 'choker' | 'clip' | 'flower' | 'loop' | 'beltloop' | 'button' | 'backpack' | 'headphones' | 'sunglasses' | 'glasses' | 'wireglasses' | 'tote';

export interface AttachmentPlacement {
    joint: string;                      // anchor joint name (must exist on the body skeleton)
    offset: [number, number, number];   // local offset from the joint, in the REST pose (world units)
    scale: number;                      // overall size multiplier
    waistAngle?: number;                // BELT LOOP only: its angle around the waist. When set, `offset` is RE-DERIVED from the
                                        // current pants waistband surface on every build → the loop (and its chains) stay flush + FOLLOW pant tweaks.
}

export interface AttachmentParams {
    type: AttachmentType;
    color: string;
    // chain: interlocking oval links. Two modes (chainMode): `dangle` = hangs + SWINGS from one end (linkCount = length,
    // span/sag = lean); `swag` = a static catenary draped between TWO points A→B (the wallet-chain look), drooping below
    // the chord — A = anchor, B = anchor + endOffset, droop depth driven by span (+ sag), link density auto from thickness.
    linkCount: number; span: number; sag: number; thickness: number;
    chainMode?: 'dangle' | 'swag';
    endJoint?: string;                       // swag: anchor the FAR end to a DIFFERENT joint (e.g. hip→thigh tracks the leg). Unset = the same joint
    endOffset?: [number, number, number];   // swag: the far end's offset (relative to endJoint if set, else the anchor joint). B = endBase + endOffset
    swagSoftness?: number;                   // swag: 0 = a rigid drape; >0 = the droop SWAYS (a spring chain pulls the middle, ends stay pinned)
    fromLoop?: string;                       // chain: anchor the START at a LOOP charm (its id) instead of joint+offset — the chain CONNECTS to + tracks the loop
    toLoop?: string;                         // chain: connect the END to a LOOP charm (auto-switches to swag) → a wallet chain strung loop→loop
    // pocket (appliqué panel): a flat patch sitting on the surface, facing OUT along `offset`, with a top flap
    width: number; height: number; flap: number;
    // pendant: a small charm shape on a short drop
    dropLength: number;
    // WRAP types (bracelet/watch/choker): a single position along the limb — 0 = at the joint, 1 = at its child
    // (wrist / jaw). The band shrink-fits the limb radius there + auto-orients along the bone (no offset / rotation).
    position?: number;
    // MATERIAL (PBR) — what the charm is MADE of. Metal types (chain/loop/bracelet/watch/choker/pendant/clip) default
    // to shiny metal so a chain reads as metal, not plastic; pocket/flower default to matte. `color` tints it (gold vs
    // silver = the colour). metalness 0 = dielectric … 1 = chrome; roughness 0 = mirror … 1 = matte.
    metalness?: number;
    roughness?: number;
    sparkle?: boolean | 'glint' | 'star';    // twinkling: true/'glint' = fine micro-glints · 'star' = anime ✦ stars · false/'none' = off
    cuffStyle?: 'rect' | 'round';            // headphones: 'rect' = boxy cups (default) · 'round' = rounded disc cups
}

export function attachmentTypeNames(): AttachmentType[] {
    return ['chain', 'pocket', 'pendant', 'bracelet', 'watch', 'choker', 'clip', 'flower', 'loop', 'beltloop', 'button', 'backpack', 'headphones', 'sunglasses', 'glasses', 'wireglasses', 'tote'];
}

export function defaultAttachmentPlacement(type: AttachmentType): AttachmentPlacement {
    switch (type) {
        case 'chain':   return { joint: 'hips', offset: [0.1, -0.02, 0.12], scale: 1 };       // off the front-right hip (belt loop / pocket)
        case 'pocket':  return { joint: 'upperleg_R', offset: [0.06, -0.02, 0.05], scale: 1 };// cargo pocket on the thigh
        case 'pendant': return { joint: 'neck', offset: [0, -0.03, 0.05], scale: 1 };         // a neck pendant
        case 'bracelet':return { joint: 'lowerarm_L', offset: [0, 0, 0], scale: 1 };          // wrist band (axis = the forearm)
        case 'watch':   return { joint: 'lowerarm_L', offset: [0, 0, 0], scale: 1 };          // wristwatch
        case 'choker':  return { joint: 'neck', offset: [0, 0, 0], scale: 1 };                // neck band
        case 'clip':    return { joint: 'head', offset: [0.05, 0.05, 0.02], scale: 1 };       // hair clip
        case 'flower':  return { joint: 'head', offset: [0.06, 0.03, 0.02], scale: 1 };       // hair flower
        case 'loop':    return { joint: 'hips', offset: [0.08, 0.04, 0.11], scale: 1 };       // a metal D-ring on the front waistband
        case 'beltloop':return { joint: 'hips', offset: [0.08, 0.04, 0.11], scale: 1 };       // a cloth jeans belt loop (placed flush by addBeltLoops)
        case 'button':  return { joint: 'chest', offset: [0, -0.04, 0.1], scale: 1 };          // a clothing button on the front placket (surface-pin it where you want)
        case 'backpack':   return { joint: 'chest', offset: [0, -0.02, 0], scale: 1 };         // pack on the upper back + straps over the shoulders
        case 'headphones': return { joint: 'head',  offset: [0, 0, 0], scale: 1 };             // band over the crown + ear cups
        case 'sunglasses': return { joint: 'head',  offset: [0, 0, 0], scale: 1 };             // lenses over the eyes + temple arms
        case 'glasses':    return { joint: 'head',  offset: [0, 0, 0], scale: 1 };             // clear-lens eyeglasses — frame over the eyes + temple arms
        case 'wireglasses':return { joint: 'head',  offset: [0, 0, 0], scale: 1 };             // round wire-frame eyeglasses
        case 'tote':       return { joint: 'chest', offset: [0.1, 0, 0], scale: 1 };           // shoulder bag — offset.x sign picks the side
    }
}

/** Charm types that are MADE of metal → shiny PBR by default (chrome/gold reflection, not matte plastic). */
const METAL_TYPES = new Set<AttachmentType>(['chain', 'loop', 'bracelet', 'watch', 'choker', 'pendant', 'clip', 'wireglasses']);
/** Resolve a charm's PBR material (params override the per-type default). `color` tints it (gold vs silver = colour). */
export function attachmentMaterial(p: AttachmentParams): { metalness: number; roughness: number } {
    const metal = METAL_TYPES.has(p.type);
    return { metalness: p.metalness ?? (metal ? 1.0 : 0.0), roughness: p.roughness ?? (metal ? 0.28 : 0.8) };
}

export function defaultAttachmentParams(type: AttachmentType): AttachmentParams {
    const m = attachmentMaterial({ type } as AttachmentParams);
    const base: AttachmentParams = {
        type, color: '#cfd2d8',                                    // bright steel — reads as shiny metal by default
        linkCount: 20, span: 0.05, sag: 0.04, thickness: 0.0035,   // chain: thickness = wire radius (small); span/sag = lean
        chainMode: 'dangle', endOffset: [-0.05, -0.12, 0.04], swagSoftness: 0,   // swag mode → drapes anchor → here (front-hip wallet chain)
        width: 0.07, height: 0.09, flap: 0.025,
        dropLength: 0.08,
        metalness: m.metalness, roughness: m.roughness,
    };
    switch (type) {
        case 'pocket':   base.color = '#3f4a3a'; break;
        case 'bracelet': base.color = '#d8d2c0'; base.thickness = 0.012; base.position = 0.85; break;  // band half-width; near the wrist
        case 'watch':    base.color = '#2a2a30'; base.thickness = 0.012; base.width = 0.024; base.height = 0.03; base.position = 0.8; base.roughness = 0.18; break;  // face size; glossy
        case 'choker':   base.color = '#202024'; base.thickness = 0.008; base.position = 0.3; break;   // low on the neck
        case 'clip':     base.color = '#c64b8a'; base.width = 0.045; base.height = 0.012; base.thickness = 0.006; base.metalness = 0.2; base.roughness = 0.5; break;  // glossy enamel
        case 'flower':   base.color = '#e08ab0'; base.width = 0.03; break;               // petal reach
        case 'loop':     base.color = '#3a3a40'; base.width = 0.014; base.thickness = 0.004; break;  // dark gunmetal D-ring
        case 'beltloop': base.color = '#33343c'; base.width = 0.013; base.height = 0.024; base.thickness = 0.0025; break;  // cloth jeans loop (matte fabric — match the pants colour host-side)
        case 'button':   base.color = '#2a2a30'; base.width = 0.006; base.thickness = 0.002; base.metalness = 0.2; base.roughness = 0.45; break;  // a domed disc; metalness up for a jeans/metal button
        case 'backpack':   base.color = '#3a3f4a'; base.metalness = 0;   base.roughness = 0.85; break;   // matte fabric
        case 'headphones': base.color = '#202028'; base.metalness = 0.1; base.roughness = 0.4;  break;   // plastic
        case 'sunglasses': base.color = '#111114'; base.metalness = 0.1;  base.roughness = 0.12; break;   // glossy dark lenses
        case 'glasses':    base.color = '#22222a'; base.metalness = 0.15; base.roughness = 0.3;  break;   // dark plastic frame (clear/omitted lens) — recolour for tortoise/wire
        case 'wireglasses':base.color = '#c9a24b'; base.metalness = 1.0;  base.roughness = 0.22; break;   // thin ROUND gold wire — recolour for silver/gunmetal
        case 'tote':       base.color = '#8a7a5c'; base.metalness = 0;   base.roughness = 0.85; break;   // canvas tote
    }
    return base;
}

// ── minimal skinned-mesh builder (up to 4 bones/vertex; bone indices are BONE-LOCAL) ──────────
type Bind4 = { bi: [number, number, number, number]; bw: [number, number, number, number] };
interface Acc { pos: number[]; uv: number[]; bi: number[]; bw: number[]; idx: number[]; n: number; }
const acc = (): Acc => ({ pos: [], uv: [], bi: [], bw: [], idx: [], n: 0 });
function vert(a: Acc, p: V3, uv: [number, number], joint: number): number {
    a.pos.push(p[0], p[1], p[2]); a.uv.push(uv[0], uv[1]);
    a.bi.push(joint, 0, 0, 0); a.bw.push(1, 0, 0, 0); return a.n++;                 // 100% to one bone
}
/** A vertex with an explicit up-to-4-bone bind (bone-local indices + weights; weights should sum to ~1). */
function vertB(a: Acc, p: V3, uv: [number, number], b: Bind4): number {
    a.pos.push(p[0], p[1], p[2]); a.uv.push(uv[0], uv[1]);
    a.bi.push(b.bi[0], b.bi[1], b.bi[2], b.bi[3]); a.bw.push(b.bw[0], b.bw[1], b.bw[2], b.bw[3]); return a.n++;
}
function quad(a: Acc, i0: number, i1: number, i2: number, i3: number): void { a.idx.push(i0, i1, i2, i0, i2, i3); }

/** An oriented box (frame ux/uy/uz, half-extents hx/hy/hz) — a chain link / charm. */
function box(a: Acc, c: V3, ux: V3, uy: V3, uz: V3, hx: number, hy: number, hz: number, j: number): void {
    const corner = (sx: number, sy: number, sz: number): V3 =>
        add(c, add(scl(ux, sx * hx), add(scl(uy, sy * hy), scl(uz, sz * hz))));
    const p = [
        corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1),
        corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1),
    ];
    const v = p.map(pp => vert(a, pp, [0, 0], j));
    quad(a, v[0], v[3], v[2], v[1]); quad(a, v[4], v[5], v[6], v[7]);   // -Z, +Z
    quad(a, v[0], v[1], v[5], v[4]); quad(a, v[2], v[3], v[7], v[6]);   // -Y, +Y
    quad(a, v[1], v[2], v[6], v[5]); quad(a, v[0], v[4], v[7], v[3]);   // +X, -X
}

/** One oval chain LINK — a low-poly elongated torus. Centre `c`; the loop lies in the plane spanned by long axis
 *  `aAx` (half-length `L`) and short axis `bAx` (half-width `W`), with wire radius `wire`. Skinned to bone `j`.
 *  Build consecutive links with `aAx`/`bAx` swapped (rotated 90° about the run) so they INTERLOCK like a real chain. */
function link(ac: Acc, c: V3, aAx: V3, bAx: V3, L: number, W: number, wire: number, bind: number | Bind4, maj = 8, min = 4): void {
    const n = norm(cross(aAx, bAx));                          // loop normal (one of the wire circle's two axes)
    const emit = (p: V3, uv: [number, number]): number => typeof bind === 'number' ? vert(ac, p, uv, bind) : vertB(ac, p, uv, bind);
    const rings: number[][] = [];
    for (let i = 0; i <= maj; i++) {                          // points around the oval centreline (closes at i=maj)
        const t = (i / maj) * Math.PI * 2, ct = Math.cos(t), st = Math.sin(t);
        const centre = add(c, add(scl(aAx, ct * L), scl(bAx, st * W)));
        const radial = norm(add(scl(aAx, ct), scl(bAx, st)));  // outward-in-plane → the wire circle's other axis
        const ring: number[] = [];
        for (let k = 0; k < min; k++) {                        // a small circle of `min` verts around the wire
            const w = (k / min) * Math.PI * 2;
            ring.push(emit(add(centre, add(scl(radial, Math.cos(w) * wire), scl(n, Math.sin(w) * wire))), [i / maj, k / min]));
        }
        rings.push(ring);
    }
    for (let i = 0; i < maj; i++) for (let k = 0; k < min; k++) {
        const k2 = (k + 1) % min;
        quad(ac, rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]);
    }
}

function finishAcc(a: Acc): { geometry: MeshGeometry; jointIndices: Uint8Array; jointWeights: Float32Array } {
    const vc = a.n;
    const nrm = new Float32Array(vc * 3);
    for (let t = 0; t + 2 < a.idx.length; t += 3) {           // accumulate face normals
        const i0 = a.idx[t], i1 = a.idx[t + 1], i2 = a.idx[t + 2];
        const p0: V3 = [a.pos[i0 * 3], a.pos[i0 * 3 + 1], a.pos[i0 * 3 + 2]];
        const p1: V3 = [a.pos[i1 * 3], a.pos[i1 * 3 + 1], a.pos[i1 * 3 + 2]];
        const p2: V3 = [a.pos[i2 * 3], a.pos[i2 * 3 + 1], a.pos[i2 * 3 + 2]];
        const fn = cross(sub(p1, p0), sub(p2, p0));
        for (const i of [i0, i1, i2]) { nrm[i * 3] += fn[0]; nrm[i * 3 + 1] += fn[1]; nrm[i * 3 + 2] += fn[2]; }
    }
    const verts = new Float32Array(vc * 12);
    for (let i = 0; i < vc; i++) {
        const o = i * 12;
        const n = norm([nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]]);
        const ref: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const t = norm(cross(n, ref));
        verts[o] = a.pos[i * 3]; verts[o + 1] = a.pos[i * 3 + 1]; verts[o + 2] = a.pos[i * 3 + 2];
        verts[o + 3] = n[0]; verts[o + 4] = n[1]; verts[o + 5] = n[2];
        verts[o + 6] = a.uv[i * 2]; verts[o + 7] = a.uv[i * 2 + 1];
        verts[o + 8] = t[0]; verts[o + 9] = t[1]; verts[o + 10] = t[2]; verts[o + 11] = 1;
    }
    const ji = new Uint8Array(a.bi), jw = new Float32Array(a.bw);   // 4 bone-local indices + weights per vertex
    return { geometry: { vertices: verts, indices: new Uint32Array(a.idx), format: '12float' }, jointIndices: ji, jointWeights: jw };
}

// ── type generators ───────────────────────────────────────────────────────────

/** The CHAIN type. `dangle` (default) = interlocking oval links HANGING from the anchor on a spring chain (each link
 *  its own bone, bone-local i+1) so it swings. `swag` = a catenary draped between two points (see buildChainSwag).
 *  Returns spring-chain param overrides (swag-soft wants a stiffer chain), or undefined for the default. */
function buildChain(a: Acc, A: V3, fit: BodyFit, placement: AttachmentPlacement, p: AttachmentParams, s: number, bindJoints: string[], bones: V3[]): AttachmentSpringParams | undefined {
    if ((p.chainMode ?? 'dangle') === 'swag') return buildChainSwag(a, A, fit, placement, p, s, bindJoints, bones);
    const N = Math.max(3, Math.round(p.linkCount));
    const wire = Math.max(0.0012, p.thickness * s);            // wire radius — keep it small (it's a real chain link now)
    const L = wire * 2.8, W = wire * 1.8;                      // oval link half-length (along the run) / half-width
    const seg = L * 1.3;                                       // spacing < 2L → adjacent links overlap + interlock
    const driftX = p.span * 0.3 * s, driftZ = p.sag * 0.2 * s; // a gentle sideways / forward lean at rest (not dead-straight)
    for (let i = 0; i < N; i++) {
        const t = (i + 0.5) / N;
        let c: V3 = [A[0] + driftX * t, A[1] - seg * (i + 0.5), A[2] + driftZ * t];   // link centre, hanging down
        c = pushOutsideBody(c, fit, DRAPE_GAP);   // drape the rest shape ON the garment/skin, not through it — the spring + colliders then handle the swing
        bones.push(c);                                         // bone i (local index i+1) sits here
        const flip = i % 2 === 0;
        link(a, c, [0, 1, 0], flip ? [1, 0, 0] : [0, 0, 1], L, W, wire, i + 1);   // long axis = run; short axis alternates 90°
    }
    // The rest shape is already draped on the garment; keep the live collision radius SMALL so a swinging dangle
    // settles close to that drape (the default 0.015 floated it ~2cm off) yet still clears the link half-width.
    return { stiffness: 0.5, drag: 0.6, gravity: 0.004, hitRadius: 0.006 };
}

/** A chain drapes this far OFF the surface it rests on (the equipped garment, else the skin). */
const DRAPE_GAP = 0.007;

/** Push a point OUT to the nearest surface + `margin` → a chain's catenary rests ON the surface, not through it. The
 *  surface is the EQUIPPED GARMENT (`fit.drapeSurface` — the OUTER clothing verts, so it tracks baggy/wrinkly pants
 *  exactly, not a body+margin guess) when dressed, else the body. The push is along a CONSISTENT outward direction (the
 *  horizontal radial from the body's central axis), NOT the local surface normal: a convex bump's normals fan out
 *  radially, so pushing each link along its own normal spreads the strand sideways AROUND the bump — pushing them all
 *  the same way out makes the strand ride straight OVER it. Falls back to the normal where the radial runs ~tangent to
 *  the surface (e.g. the top of a shoulder), so it still de-collides there. Build-time; no live spring/collider needed. */
function pushOutsideBody(pt: V3, fit: BodyFit, margin: number): V3 {
    const surf = fit.drapeSurface ?? fit.body;
    if (!surf) return pt;
    const v = surf.verts, n = v.length / 12;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
        const dx = pt[0] - v[i * 12], dy = pt[1] - v[i * 12 + 1], dz = pt[2] - v[i * 12 + 2], d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return pt;
    const o = best * 12, nx = v[o + 3], ny = v[o + 4], nz = v[o + 5];
    const signed = (pt[0] - v[o]) * nx + (pt[1] - v[o + 1]) * ny + (pt[2] - v[o + 2]) * nz;   // distance from the surface along its normal
    if (signed >= margin) return pt;
    const push = margin - signed;
    const hips = fit.joints['hips'];                          // the body's central axis (x,z) → the consistent "out"
    let ox = pt[0] - (hips?.pos[0] ?? 0), oz = pt[2] - (hips?.pos[2] ?? 0);
    const ol = Math.hypot(ox, oz);
    if (ol > 1e-3) {
        ox /= ol; oz /= ol;
        const dotON = ox * nx + oz * nz;                     // horizontal radial · surface normal
        if (dotON > 0.35) { const d = Math.min(push / dotON, push * 2.5); return [pt[0] + ox * d, pt[1], pt[2] + oz * d]; }   // ride OVER the bump (out, not around)
    }
    return [pt[0] + nx * push, pt[1] + ny * push, pt[2] + nz * push];   // ~tangent here → de-collide along the normal
}

/** A SWAG chain — a catenary draped between two fixed points A → B (the wallet-chain hip→pocket look). It is RIGID:
 *  BOTH ends are pinned (each link blend-skins anchor → far-end by its position), and the catenary is shaped at BUILD
 *  time to drape OUTSIDE the body + a clothing margin (`pushOutsideBody`) so it rests ON the pants, not through them.
 *  NO spring chain: a one-rooted spring can only pin ONE end, so its far tip droops free under gravity (the "hanging
 *  off the second loop / clips outside armature mode" bug). Link density auto-fills so it always interlocks.
 *  • **endJoint** (optional) anchors the FAR end to a DIFFERENT joint (B = endJoint.pos + endOffset) so e.g. a
 *    hip→thigh chain stretches as the leg moves. • **swagSoftness** (0..1) DEEPENS the sag (a looser drape). */
function buildChainSwag(a: Acc, A: V3, fit: BodyFit, _placement: AttachmentPlacement, p: AttachmentParams, s: number, bindJoints: string[], _bones: V3[]): AttachmentSpringParams | undefined {
    const wire = Math.max(0.0012, p.thickness * s);
    const L = wire * 2.8, W = wire * 1.8;
    const eo: V3 = (p.endOffset ?? [0, 0, 0]) as V3;
    const endJointObj = p.endJoint ? fit.joints[p.endJoint] : undefined;   // far-end on a DIFFERENT joint?
    const endJ = endJointObj ? (p.endJoint as string) : '';
    const endBase: V3 = endJointObj ? (endJointObj.pos as V3) : A;          // endJ → its joint pos; else A (already has the anchor offset)
    const B: V3 = [endBase[0] + eo[0], endBase[1] + eo[1], endBase[2] + eo[2]];
    let endLocal = 0;                                                       // bone-local of the far end (0 = same as the anchor)
    if (endJ) { bindJoints.push(endJ); endLocal = 1; }
    const soft = Math.max(0, Math.min(1, p.swagSoftness ?? 0));
    const droop = Math.max(0, p.span * 0.6 + p.sag * 0.4 + soft * 0.06);   // span/sag droop depth; softness deepens it (looser drape)
    const cat = (t: number): V3 => {                                        // the catenary point at t∈[0,1]
        const d = 4 * t * (1 - t) * droop;
        return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t - d, A[2] + (B[2] - A[2]) * t];
    };
    const chord = len(sub(B, A));
    const N = Math.max(3, Math.min(160, Math.round((chord + droop * 1.2) / (L * 1.3))));   // auto link count → consistent interlock
    // Drape the catenary ONTO the equipped garment surface (or skin). The push fades to 0 at the two ends (they stay
    // pinned AT the loops) and peaks mid-span, so the chain rests on the real (baggy/wrinkly) pants, not through them.
    const pts: V3[] = [];
    for (let i = 0; i < N; i++) {
        const t = N > 1 ? i / (N - 1) : 0.5;
        const w = 4 * t * (1 - t);                                          // 0 at the pinned ends → 1 mid-span
        const c = cat(t), pushed = pushOutsideBody(c, fit, DRAPE_GAP);
        pts.push([c[0] + (pushed[0] - c[0]) * w, c[1] + (pushed[1] - c[1]) * w, c[2] + (pushed[2] - c[2]) * w]);
    }
    for (let i = 0; i < N; i++) {
        const t = N > 1 ? i / (N - 1) : 0.5;
        let tang = sub(pts[Math.min(N - 1, i + 1)], pts[Math.max(0, i - 1)]);   // tangent from the draped neighbours
        tang = norm(len(tang) > 1e-5 ? tang : sub(B, A));
        const fr = frame(tang);
        // bind: anchor(0) + far-end(endLocal) blend by t → BOTH ends pinned (no free tip). endLocal=0 ⇒ slots sum on the anchor.
        const bind: Bind4 = { bi: [0, endLocal, 0, 0], bw: [1 - t, t, 0, 0] };
        link(a, pts[i], tang, i % 2 === 0 ? fr.u : fr.v, L, W, wire, bind);   // short axis alternates 90° → interlock
    }
    return undefined;   // RIGID swag (both ends pinned + pushed clear of the pants); no spring → nothing to flop
}

/** An appliqué POCKET: a flat patch facing OUT along the offset direction, with a small angled top flap. */
function buildPocket(a: Acc, anchor: V3, outDir: V3, p: AttachmentParams, s: number, j: number, upRef: V3): void {
    const out = norm(len(outDir) > 1e-5 ? outDir : [0, 0, 1]);
    // v = the limb's long axis (`upRef`) projected ⊥ to out → the pocket runs PARALLEL to the leg/limb (not just
    // world-upright, which read tilted on an angled thigh). frame()'s v was an arbitrary perpendicular (pointed down).
    const d = upRef[0] * out[0] + upRef[1] * out[1] + upRef[2] * out[2];
    let v = norm([upRef[0] - out[0] * d, upRef[1] - out[1] * d, upRef[2] - out[2] * d]);
    if (len(v) < 1e-4) v = [0, 0, 1];                       // upRef ∥ out → fall back
    const u = norm(cross(v, out));                          // panel side axis
    const w = Math.max(0.01, p.width * s) * 0.5, h = Math.max(0.01, p.height * s) * 0.5;
    const lift = Math.max(0.002, p.thickness * s + 0.003);  // sit just off the surface
    const c = add(anchor, scl(out, lift));
    const corner = (sx: number, sy: number, dome: number): V3 =>
        add(add(c, add(scl(u, sx * w), scl(v, sy * h))), scl(out, dome));
    // panel (slightly domed centre) — front quad + a thin rim so it reads as a pouch
    const tl = vert(a, corner(-1, 1, 0), [0, 0], j), tr = vert(a, corner(1, 1, 0), [1, 0], j);
    const br = vert(a, corner(1, -1, 0), [1, 1], j), bl = vert(a, corner(-1, -1, 0), [0, 1], j);
    const mid = vert(a, add(c, scl(out, w * 0.35)), [0.5, 0.5], j);   // domed centre
    a.idx.push(tl, tr, mid, tr, br, mid, br, bl, mid, bl, tl, mid);
    // flap — a quad at the top, angled outward/down over the panel
    const f = Math.max(0, p.flap * s);
    if (f > 0.002) {
        const ftl = vert(a, corner(-1, 1, 0), [0, 0], j), ftr = vert(a, corner(1, 1, 0), [1, 0], j);
        const fbl = vert(a, add(corner(-1, 1, f * 1.2), scl(v, -f)), [0, 1], j);
        const fbr = vert(a, add(corner(1, 1, f * 1.2), scl(v, -f)), [1, 1], j);
        quad(a, ftl, ftr, fbr, fbl);
    }
}

/** A PENDANT — a short bail/cord + a diamond, DRAPED down the body/clothing surface from the pin and resting ON it
 *  (faces OUT along the surface normal, pushed clear of the cloth → no clip). RIGID: skinned 100% to the anchor `j`,
 *  so it stays where you surface-pin it — NOT the old free-swinging pendulum that settled vertical + hung off the
 *  surface clipping things. `out` = the surface normal; the drop direction = world-down draped onto the surface. */
function buildPendant(a: Acc, A: V3, fit: BodyFit, outDir: V3, p: AttachmentParams, s: number, j: number): void {
    const out = norm(len(outDir) > 1e-5 ? outDir : [0, 0, 1]);
    let down = norm([out[1] * out[0], -1 + out[1] * out[1], out[1] * out[2]]);   // world-down projected ⊥ to out (drapes DOWN the surface)
    if (len(down) < 1e-4) down = [0, -1, 0];
    const side = norm(cross(down, out));
    const drop = Math.max(0.012, p.dropLength * s * 0.6);   // a short drop for a pinned pendant
    const th = Math.max(0.0025, p.thickness * s), wire = th * 0.55;
    const N = 4;
    const pts: V3[] = [];
    for (let k = 0; k <= N; k++) pts.push(pushOutsideBody(add(A, scl(down, drop * (k / N))), fit, DRAPE_GAP));   // the drop, draped onto the surface (rests on the cloth)
    for (let k = 0; k < N; k++) {                          // bail/cord segments along the draped drop
        const seg = sub(pts[k + 1], pts[k]), c = scl(add(pts[k], pts[k + 1]), 0.5);
        box(a, c, norm(len(seg) > 1e-5 ? seg : down), side, out, Math.max(1e-4, len(seg) * 0.5), wire, wire, j);
    }
    const r = Math.max(0.008, p.width * s * 0.3);          // the diamond — at the drop end, lying on the surface, facing OUT
    box(a, pts[N], norm(add(down, side)), norm(sub(side, down)), out, r, r, Math.max(0.003, th), j);
}

/** A thin cylinder BAND around `axis` (bracelet / choker / watch strap), radius `r`, half-width `hw`. */
function band(a: Acc, center: V3, axis: V3, r: number, hw: number, j: number, segs = 14): void {
    const { u, v } = frame(axis);
    const ring = (off: number): number[] => {
        const out: number[] = [];
        for (let k = 0; k < segs; k++) {
            const ang = (k / segs) * Math.PI * 2;
            const dir = add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
            out.push(vert(a, add(add(center, scl(axis, off)), scl(dir, r)), [k / segs, off > 0 ? 1 : 0], j));
        }
        return out;
    };
    const r0 = ring(-hw), r1 = ring(hw);
    for (let k = 0; k < segs; k++) { const k2 = (k + 1) % segs; quad(a, r0[k], r0[k2], r1[k2], r1[k]); }
}

/** The band's ring radius — HUGS the limb (`limbR` is the true sampled surface radius) with just a small clearance
 *  so it sits on the skin without clipping. Decoupled from `thickness` (which is the band's WIDTH, not its offset —
 *  a wide band still hugs). */
const bandRadius = (limbR: number): number => limbR * 1.02 + 0.0015;

/** Bracelet / anklet — a band wrapping the limb. With an arm-ring `br` it CONFORMS to the real cross-section (no gap /
 *  clip) and slides smoothly; otherwise a circle at the shrink-fit radius `limbR`. `thickness` = the band's WIDTH only. */
function buildBracelet(a: Acc, c: V3, axis: V3, limbR: number, p: AttachmentParams, s: number, j: number, br?: RingBracket | null): void {
    const hw = Math.max(0.005, p.thickness * s * 1.4);
    if (br) bandConform(a, br, axis, hw, 0.002, j);
    else band(a, c, axis, bandRadius(limbR), hw, j);
}
/** Watch — a band + a small face box on the TOP of the wrist (the back), face-up. */
function buildWatch(a: Acc, c: V3, axis: V3, limbR: number, p: AttachmentParams, s: number, j: number, br?: RingBracket | null): void {
    buildBracelet(a, c, axis, limbR, p, s, j, br);
    // Face the watch UP: the radial direction closest to world-UP, ⊥ to the forearm axis (was `frame(axis).u`, a
    // horizontal SIDE direction → the face sat on the side of the arm). Falls back to a side dir if the arm is vertical.
    let fd = norm([-axis[0] * axis[1], 1 - axis[1] * axis[1], -axis[2] * axis[1]]);   // world-up projected ⊥ to the bone
    if (len(fd) < 1e-4) fd = frame(axis).u;
    const r = bandRadius(limbR) + Math.max(0.002, p.thickness * s * 0.5);   // sit the face just proud of the band
    box(a, add(c, scl(fd, r)), fd, axis, norm(cross(axis, fd)),
        Math.max(0.003, p.thickness * s * 0.6), Math.max(0.008, p.height * s), Math.max(0.008, p.width * s), j);
}
/** Choker / necklace — a band around the neck at the shrink-fit radius `limbR` + a small front charm. */
function buildChoker(a: Acc, c: V3, axis: V3, limbR: number, p: AttachmentParams, s: number, j: number): void {
    const r = bandRadius(limbR);
    band(a, c, axis, r, Math.max(0.004, p.thickness * s), j, 16);
    const cz = Math.max(0.003, p.thickness * s * 1.6);
    box(a, add(c, [0, -r * 0.55, r]), [1, 0, 0], [0, 1, 0], [0, 0, 1], cz, cz, cz * 0.6, j);   // front charm
}
/** Hair clip / barrette — a small flat bar on the surface, facing OUT along the offset. */
function buildClip(a: Acc, anchor: V3, outDir: V3, p: AttachmentParams, s: number, j: number): void {
    const out = norm(len(outDir) > 1e-5 ? outDir : [0, 0, 1]);
    const { u, v } = frame(out);
    const c = add(anchor, scl(out, Math.max(0.002, p.thickness * s + 0.002)));
    box(a, c, u, v, out, Math.max(0.008, p.width * s), Math.max(0.004, p.height * s), Math.max(0.002, p.thickness * s), j);
}
/** Flower — a few petals radiating from a centre, facing OUT along the offset. */
function buildFlower(a: Acc, anchor: V3, outDir: V3, p: AttachmentParams, s: number, j: number): void {
    const out = norm(len(outDir) > 1e-5 ? outDir : [0, 0, 1]);
    const { u, v } = frame(out);
    const c = add(anchor, scl(out, 0.004));
    const pr = Math.max(0.01, p.width * s);
    const petals = 5;
    const centre = vert(a, add(c, scl(out, pr * 0.3)), [0.5, 0.5], j);
    const dir = (ang: number): V3 => add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
    for (let i = 0; i < petals; i++) {
        const a0 = (i / petals) * Math.PI * 2, a1 = ((i + 1) / petals) * Math.PI * 2, am = (a0 + a1) / 2;
        const p0 = vert(a, add(c, scl(dir(a0), pr * 0.4)), [0, 0], j);
        const tip = vert(a, add(c, scl(dir(am), pr)), [0.5, 1], j);
        const p1 = vert(a, add(c, scl(dir(a1), pr * 0.4)), [1, 0], j);
        a.idx.push(centre, p0, tip, centre, tip, p1);
    }
}

/** A LOOP / D-ring — a small upright ring sitting on the surface (facing OUT along the offset) that a chain clips to.
 *  `width` = ring radius, `thickness` = strap radius. The ring stands vertical so a chain hangs THROUGH it. */
function buildLoop(a: Acc, anchor: V3, outDir: V3, p: AttachmentParams, s: number, j: number): void {
    const out = norm(len(outDir) > 1e-5 ? outDir : [0, 0, 1]);
    const wire = Math.max(0.0015, p.thickness * s);
    const R = Math.max(0.006, p.width * s);
    const side = norm(cross([0, 1, 0], out));                    // horizontal, ⊥ to out (the ring's short axis)
    const c = add(anchor, add(scl(out, wire), [0, -R, 0]));      // just off the surface + HANGS below the anchor (its top at the sew point, not centred → won't poke above the waistband)
    link(a, c, [0, 1, 0], len(side) > 1e-4 ? side : [1, 0, 0], R, R * 0.78, wire, j, 10, 5);   // upright oval ring, loop opening faces out
}

/** A cloth BELT LOOP — a little fabric strip that arches OUT over the waistband (jeans style), sewn at top + bottom
 *  and bulging forward so a belt/chain passes BEHIND it. Matte fabric (not metal). Skinned 100% to the anchor (j=0). */
function buildBeltLoop(a: Acc, anchor: V3, outDir: V3, p: AttachmentParams, s: number): void {
    let out = norm([outDir[0], 0, outDir[2]]);                   // horizontal outward = the bulge direction
    if (len(out) < 1e-4) out = [0, 0, 1];
    const up: V3 = [0, 1, 0];
    let side = norm(cross(up, out));
    if (len(side) < 1e-4) side = [1, 0, 0];
    const len2 = 2 * Math.max(0.012, p.height * s);             // full strip length — it HANGS DOWN from the anchor (the top sew point), not centred on it (else it pokes above the waistband)
    const halfW = Math.max(0.004, p.width * s) * 0.5;            // half the strip width
    const bulge = Math.max(0.005, p.thickness * s + 0.006);      // how far it arches OUT (the opening behind it)
    const SEG = 6;
    const rows: number[][] = [];
    for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;                                       // 0 = the TOP sew point (at the anchor) → 1 = the bottom
        const c = add(anchor, add(scl(up, -len2 * t), scl(out, bulge * Math.sin(Math.PI * t))));   // hangs down; arches out mid-span, flat at both sewn ends
        rows.push([vert(a, add(c, scl(side, -halfW)), [0, t], 0), vert(a, add(c, scl(side, halfW)), [1, t], 0)]);
    }
    for (let i = 0; i < SEG; i++) { const [l0, r0] = rows[i], [l1, r1] = rows[i + 1]; quad(a, l0, r0, r1, l1); }   // the doubleSided material shows both faces
}

/** A clothing BUTTON — a small disc facing OUT with a shallow recessed centre (the stitch-hole dish) + a thin side
 *  wall, so it reads as a shirt/jeans button sitting proud of the surface. Skinned to the anchor (j). */
function buildButton(a: Acc, anchor: V3, outDir: V3, p: AttachmentParams, s: number, j: number): void {
    const out = norm(len(outDir) > 1e-5 ? outDir : [0, 0, 1]);
    const { u, v } = frame(out);                            // any perpendicular basis is fine — a disc is radially symmetric
    const R = Math.max(0.004, p.width * s);
    const th = Math.max(0.0012, p.thickness * s);
    const top = add(anchor, scl(out, th));                  // the disc face sits `th` proud of the surface
    const SEG = 14;
    const ring = (c: V3, r: number, push: number): number[] => {
        const o: number[] = [];
        for (let i = 0; i < SEG; i++) {
            const ang = (i / SEG) * Math.PI * 2, dir = add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
            o.push(vert(a, add(add(c, scl(dir, r)), scl(out, push)), [0.5 + Math.cos(ang) * 0.5, 0.5 + Math.sin(ang) * 0.5], j));
        }
        return o;
    };
    const rim = ring(top, R, 0);                            // raised outer rim
    const inner = ring(top, R * 0.55, -th * 0.5);           // recessed inner ring (the hole dish)
    const centre = vert(a, add(top, scl(out, -th * 0.7)), [0.5, 0.5], j);
    const base = ring(anchor, R, 0);                        // base ring on the surface
    for (let i = 0; i < SEG; i++) { const n = (i + 1) % SEG;
        quad(a, rim[i], rim[n], inner[n], inner[i]);        // dished top: rim → inner
        a.idx.push(centre, inner[n], inner[i]);             // dish floor: inner → centre
        quad(a, rim[i], base[i], base[n], rim[n]);          // side wall
    }
}

export type AttachmentSpringParams = { stiffness: number; drag: number; gravity: number; hitRadius: number };

/** Geometry result. Vertex `jointIndices` are BONE-LOCAL, in this layout: **0 = the anchor joint**, then
 *  `1..bindJoints.length` = extra REAL joints (e.g. the swag's far-end joint), then `dangleBones` = a spring-bone
 *  chain hanging from the anchor (so the charm SWINGS). scene3d (`_buildAttachment`) resolves 0/bindJoints to real
 *  skeleton joints, appends `dangleBones` as a spring chain, and remaps. `springParams` overrides the chain's
 *  stiffness/drag/etc. (the swag's sway wants a stiffer chain than a free dangle). */
export interface AttachmentMesh {
    geometry: MeshGeometry; jointIndices: Uint8Array; jointWeights: Float32Array;
    bindJoints: string[];   // extra real joint NAMES bound at bone-local 1.. (besides the anchor)
    dangleBones: V3[];       // rest-pose spring-bone positions (empty = no spring); bone-local (1+bindJoints.length)..
    springParams?: AttachmentSpringParams;
}

// ── Bags / worn hardware (backpack, headphones, sunglasses): rigid geometry anchored to (skinned to) a joint. ──
/** A flat strap swept along centreline `pts` (half-width `halfW`, half-thickness `thick`) — one oriented box per segment. */
function segBand(a: Acc, pts: V3[], halfW: number, thick: number, j: number): void {
    for (let i = 0; i < pts.length - 1; i++) {
        const d0 = sub(pts[i + 1], pts[i]); const L = len(d0); if (L < 1e-6) continue;
        const d = scl(d0, 1 / L); const { u, v } = frame(d);
        box(a, scl(add(pts[i], pts[i + 1]), 0.5), d, u, v, L * 0.5, halfW, thick, j);
    }
}
/** Sample a quadratic bezier A→(control C)→E into n+1 points (smooth straps / bands). */
function qbez(A: V3, C: V3, E: V3, n: number): V3[] {
    const out: V3[] = [];
    for (let i = 0; i <= n; i++) { const t = i / n, it = 1 - t, w0 = it * it, w1 = 2 * it * t, w2 = t * t;
        out.push([w0*A[0]+w1*C[0]+w2*E[0], w0*A[1]+w1*C[1]+w2*E[1], w0*A[2]+w1*C[2]+w2*E[2]]); }
    return out;
}
const jr = (jt: { pos: readonly number[] } | undefined): number => ((jt as unknown as { radius?: number } | undefined)?.radius) ?? 0.09;
/** A rectangular FRAME border (4 thin bars) around a rect centred at `c`, in the XY plane facing +Z. */
function rimRect(a: Acc, c: V3, halfW: number, halfH: number, rimW: number, thick: number, j: number): void {
    box(a, [c[0], c[1] + halfH + rimW, c[2]], [1,0,0],[0,1,0],[0,0,1], halfW + rimW * 2, rimW, thick, j);   // top
    box(a, [c[0], c[1] - halfH - rimW, c[2]], [1,0,0],[0,1,0],[0,0,1], halfW + rimW * 2, rimW, thick, j);   // bottom
    box(a, [c[0] - halfW - rimW, c[1], c[2]], [1,0,0],[0,1,0],[0,0,1], rimW, halfH, thick, j);              // left
    box(a, [c[0] + halfW + rimW, c[1], c[2]], [1,0,0],[0,1,0],[0,0,1], rimW, halfH, thick, j);              // right
}
/** A closed elliptical WIRE ring (a round lens rim for wire-frame glasses): n points on an ellipse → a thin band. */
function eyeRing(a: Acc, c: V3, rw: number, rh: number, wire: number, n = 18): void {
    const pts: V3[] = [];
    for (let i = 0; i <= n; i++) { const th = (i / n) * Math.PI * 2; pts.push([c[0] + Math.cos(th) * rw, c[1] + Math.sin(th) * rh, c[2]]); }
    segBand(a, pts, wire, wire, 0);
}
/** A round (elliptical-disc) EARCUP: a short elliptical cylinder facing outward along ±X with a capped outer face —
 *  the rounded-cuff variant (vs the rectangular box cup). Winding matches the D-ring dish so faces sit outward. */
function roundCup(a: Acc, c: V3, sx: number, depth: number, rY: number, rZ: number, j: number, n = 16): void {
    const out: V3 = [sx, 0, 0]; const { u, v } = frame(out);   // u,v span the YZ plane, u×v = out
    const ringAt = (centre: V3): number[] => {
        const o: number[] = [];
        for (let i = 0; i < n; i++) { const ang = (i / n) * Math.PI * 2;
            o.push(vert(a, add(centre, add(scl(u, Math.cos(ang) * rZ), scl(v, Math.sin(ang) * rY))), [0.5 + Math.cos(ang) * 0.5, 0.5 + Math.sin(ang) * 0.5], j)); }
        return o;
    };
    const inner = ringAt(c), outerC = add(c, scl(out, depth)), outer = ringAt(outerC), cap = vert(a, outerC, [0.5, 0.5], j);
    for (let i = 0; i < n; i++) { const m = (i + 1) % n;
        quad(a, outer[i], inner[i], inner[m], outer[m]);       // side wall (faces radially out)
        a.idx.push(cap, outer[m], outer[i]);                   // outer cap fan (faces +out)
    }
}

/** BACKPACK: a pack body on the upper back (SWAYS subtly on a spring bone) + two straps over the shoulders (rigid). */
function buildBackpack(a: Acc, fit: BodyFit, placement: AttachmentPlacement, s: number, dangleBones: V3[]): AttachmentSpringParams | undefined {
    const chest = fit.joints[placement.joint] ?? fit.joints['chest']; if (!chest) return undefined;
    const shL = fit.joints['shoulder_L'], shR = fit.joints['shoulder_R'], hips = fit.joints['hips'];
    const cw = jr(chest) * s;
    const cx = chest.pos[0] + placement.offset[0], cz = chest.pos[2] + placement.offset[2];
    const cyTop = chest.pos[1] + cw * 0.5 + placement.offset[1];
    const cyBot = (hips?.pos[1] ?? chest.pos[1] - cw * 2.2) + cw * 0.6;
    const midY = (cyTop + cyBot) * 0.5, backZ = cz - cw * 1.15;
    dangleBones.push([cx, midY, backZ]);   // ONE spring bone at the pack centre → the pack sways; verts on it use local index 1
    const jb = 1;
    box(a, [cx, midY, backZ], [1,0,0],[0,1,0],[0,0,1], cw * 1.0, (cyTop - cyBot) * 0.5 + cw * 0.25, cw * 0.62, jb);   // pack body (sways)
    box(a, [cx, midY - cw * 0.25, backZ - cw * 0.5], [1,0,0],[0,1,0],[0,0,1], cw * 0.62, cw * 0.62, cw * 0.22, jb);   // outer pocket (sways)
    for (const sx of [-1, 1]) {
        const sh = sx > 0 ? shL : shR;   // shoulder_L sits at +X → use it for the +X strap (was inverted → straps crossed to the wrong shoulder)
        const shX = sh ? sh.pos[0] : cx + sx * cw * 0.9, shY = sh ? sh.pos[1] : cyTop, shZ = sh ? sh.pos[2] : cz;
        // FULL strap LOOP that HUGS THE BODY: pack-top → over the shoulder → down the chest FRONT → wrap the ribs UNDER
        // the arm → pack-bottom. Uses the REAL torso surface (torsoExtentAt) for the front depth + side half-width, so
        // it can't cut through the chest (the old control point sat inside the torso). All rigid on the torso (j=0).
        const chestY = chest.pos[1] - cw * 0.35, armY = chest.pos[1] - cw * 0.8, botY = cyBot + cw * 0.5;
        const M = cw * 0.14;                                                                 // proud margin — sits just outside the surface/shirt
        const chEx = torsoExtentAt(fit.torsoSurface, chestY), upEx = torsoExtentAt(fit.torsoSurface, shY - cw * 0.45), amEx = torsoExtentAt(fit.torsoSurface, armY);
        const chFront = (chEx ? chEx.frontZ : cz + cw * 0.6) + M;                            // chest front surface (+margin)
        const upFront = (upEx ? upEx.frontZ : cz + cw * 0.55) + M;                           // upper-chest front surface
        const Rx = Math.abs((amEx ? (sx > 0 ? amEx.sideXpos : amEx.sideXneg) : cx + sx * cw) - cx);   // rib half-width at the armpit
        const Rz = Math.max(cw * 0.45, (amEx ? amEx.frontZ : cz + cw * 0.55) - cz);          // torso half-depth there
        // FRONT: pack-top → (bezier over the shoulder) → upper chest → straight down to mid-chest — all in FRONT of the body.
        const topBack: V3 = [cx + sx * cw * 0.45, cyTop + cw * 0.05, backZ + cw * 0.55];     // attach at the pack TOP (front face)
        const overSh:  V3 = [shX, shY + cw * 0.32, shZ + cw * 0.15];                         // control: up + forward OVER the shoulder top
        const upChest: V3 = [shX * 0.84, shY - cw * 0.45, upFront];                          // just below the shoulder, in front
        const chestF:  V3 = [shX * 0.72, chestY, chFront];                                   // mid-chest, in front (the buckle sits here)
        const overCurve = qbez(topBack, overSh, upChest, 8);
        // RETURN: wrap around the torso ELLIPSE on side sx (surface radii + margin), descending to the pack bottom → never clips.
        const wrap: V3[] = []; const a0 = 0.28 * Math.PI, a1 = 0.92 * Math.PI, WN = 8;
        for (let i = 1; i <= WN; i++) { const t = i / WN, ang = a0 + (a1 - a0) * t;
            wrap.push([cx + sx * (Rx + M) * Math.sin(ang), chestY + (botY - chestY) * t, cz + (Rz + M) * Math.cos(ang)]); }
        const botBack: V3 = [cx + sx * cw * 0.5, botY, backZ + cw * 0.55];                   // attach at the pack BOTTOM (front face)
        segBand(a, [...overCurve, chestF, ...wrap, botBack], cw * 0.15, cw * 0.05, 0);
        box(a, [chestF[0], chestF[1] + cw * 0.08, chestF[2] + cw * 0.02], [1,0,0],[0,1,0],[0,0,1], cw * 0.11, cw * 0.12, cw * 0.05, 0);   // sternum strap buckle (rigid, on the strap)
    }
    // Detail (all sway with the pack except the rigid strap buckles): top flap, zippers, side pockets, buckles.
    box(a, [cx, cyTop - cw * 0.06, backZ - cw * 0.06], [1,0,0],[0,1,0],[0,0,1], cw * 1.02, cw * 0.14, cw * 0.64, jb);            // top flap
    box(a, [cx, midY, backZ - cw * 0.63], [1,0,0],[0,1,0],[0,0,1], cw * 0.025, (cyTop - cyBot) * 0.42, cw * 0.05, jb);           // main vertical zipper (raised seam)
    box(a, [cx, midY - cw * 0.02, backZ - cw * 0.73], [1,0,0],[0,1,0],[0,0,1], cw * 0.5, cw * 0.025, cw * 0.03, jb);             // outer-pocket zipper (horizontal)
    for (const sx of [-1, 1]) box(a, [cx + sx * cw * 1.0, midY - cw * 0.35, backZ], [1,0,0],[0,1,0],[0,0,1], cw * 0.13, cw * 0.45, cw * 0.42, jb);   // side pockets
    return { stiffness: 0.82, drag: 0.72, gravity: 0.0015, hitRadius: cw * 0.3 };        // VERY subtle: stiff + damped + low gravity
}
/** HEADPHONES: a band ARCING OVER THE CROWN (outside the hair) connecting two ear cups. Skinned to the head.
 *  The band must clear the hair — a crown control at ~1.3× the head radius sits on top of typical hair instead of
 *  vanishing inside it (the old 1.15× band was buried in the cap). */
function buildHeadphones(a: Acc, fit: BodyFit, placement: AttachmentPlacement, s: number, round = false): void {
    const H = fit.head, head = fit.joints[placement.joint] ?? fit.joints['head']; if (!H && !head) return;
    const jr0 = jr(head);
    // The head JOINT sits at the base/jaw — use the head bbox CENTRE + extents (accounts for Head-size + shape). Verts
    // are still skinned to the head joint (j=0) so it all moves with the head; the geometry just sits at the real centre.
    const cx = (H ? H.cx : head!.pos[0]) + placement.offset[0];
    const cy = (H ? H.cy : head!.pos[1] + jr0) + placement.offset[1];
    const cz = (H ? H.cz : head!.pos[2]) + placement.offset[2];
    const rx = (H ? H.rx : jr0) * s, ry = (H ? H.ry : jr0 * 1.3) * s, rz = (H ? H.rz : jr0) * s;
    const cupX = rx * 1.06, cupY = cy - ry * 0.03;   // cups raised a touch (were ry*0.08 low)
    // Band: ELLIPTICAL arc over the crown — Rx reaches the cups, Ry clears the crown (cy+ry) + the hair → stays OUTSIDE.
    const Rx = cupX, Ry = ry * 1.16, N = 16;
    const band: V3[] = [];
    for (let i = 0; i <= N; i++) { const th = Math.PI * (1 - i / N); band.push([cx + Rx * Math.cos(th), cy + Ry * Math.sin(th), cz]); }
    segBand(a, band, rz * 0.15, ry * 0.07, 0);
    for (const sx of [-1, 1]) {
        const c: V3 = [cx + sx * cupX, cupY, cz];
        if (round) {
            roundCup(a, c, sx, rz * 0.4, ry * 0.32, rz * 0.44, 0);                                            // rounded disc earcup (housing)
            roundCup(a, [c[0] - sx * rz * 0.02, c[1], c[2]], sx, rz * 0.06, ry * 0.36, rz * 0.5, 0);           // ear cushion ring (slightly larger, at the head)
            roundCup(a, [c[0] + sx * rz * 0.4, c[1], c[2]], sx, rz * 0.03, ry * 0.14, rz * 0.2, 0);            // small centre driver detail (proud on the outer face)
        } else {
            box(a, c, [1,0,0],[0,1,0],[0,0,1], rx * 0.12, ry * 0.28, rz * 0.5, 0);                            // cup housing (over the ear)
            box(a, [c[0] - sx * rx * 0.1, c[1], c[2]], [1,0,0],[0,1,0],[0,0,1], rx * 0.05, ry * 0.2, rz * 0.38, 0);   // inner ear pad
        }
    }
}
/** SUNGLASSES: recessed lens panels + a PROUD frame rim around each + a bridge + two temple arms. Skinned to the head.
 *  (One material, so frame-vs-lens reads from the geometry: the rim sticks out, the glass is set back.) */
function buildSunglasses(a: Acc, fit: BodyFit, placement: AttachmentPlacement, s: number): void {
    const H = fit.head, head = fit.joints[placement.joint] ?? fit.joints['head']; if (!H && !head) return;
    const jr0 = jr(head);
    const cx = (H ? H.cx : head!.pos[0]) + placement.offset[0];
    const cy = (H ? H.cy : head!.pos[1] + jr0) + placement.offset[1];
    const cz = (H ? H.cz : head!.pos[2]) + placement.offset[2];
    const rx = (H ? H.rx : jr0) * s, ry = (H ? H.ry : jr0 * 1.3) * s, rz = (H ? H.rz : jr0) * s;
    // EXACT eye line: `fit.eyeY` is the face rig's true eye-line world Y (tracks the "V pos" slider); + the manual
    // offset so hand-nudges still apply. Falls back to 55% of the head bbox (cy + ry*0.10) when no face rig exists.
    const eyeY = (fit.eyeY != null ? fit.eyeY + placement.offset[1] : cy + ry * 0.10);
    const eyeZ = cz + rz * 0.92, eyeX = rx * 0.42;
    const lensW = rx * 0.34, lensH = ry * 0.16, lensT = rz * 0.04, rimW = rx * 0.035;
    for (const sx of [-1, 1]) {
        const c: V3 = [cx + sx * eyeX, eyeY, eyeZ];
        box(a, c, [1,0,0],[0,1,0],[0,0,1], lensW, lensH, lensT, 0);                        // lens (glass, set back)
        rimRect(a, [c[0], c[1], eyeZ + lensT * 1.3], lensW, lensH, rimW, rimW * 1.4, 0);   // frame rim (proud, around the lens)
    }
    box(a, [cx, eyeY + ry * 0.03, eyeZ + lensT * 1.3], [1,0,0],[0,1,0],[0,0,1], Math.max(0.002, eyeX - lensW - rimW), rimW, rimW * 1.4, 0);   // bridge (over the nose)
    for (const sx of [-1, 1]) {                                                            // temple arms → the ears
        const A: V3 = [cx + sx * (eyeX + lensW + rimW * 2), eyeY, eyeZ];
        const E: V3 = [cx + sx * rx * 1.02, eyeY + ry * 0.04, cz - rz * 0.2];
        segBand(a, [A, E], rimW * 0.9, rimW * 0.9, 0);
    }
}
/** GLASSES: clear-lens eyeglasses. A thin PROUD frame rim around each (EMPTY) lens opening + a bridge + two temple
 *  arms. No lens fill — with a single opaque material a "clear" lens = omit it, so the eyes show through and it reads
 *  as eyeglasses, not shades. Skinned to the head; uses the exact eye line (`fit.eyeY`, tracks the V-pos slider). */
function buildGlasses(a: Acc, fit: BodyFit, placement: AttachmentPlacement, s: number, wire = false): void {
    const H = fit.head, head = fit.joints[placement.joint] ?? fit.joints['head']; if (!H && !head) return;
    const jr0 = jr(head);
    const cx = (H ? H.cx : head!.pos[0]) + placement.offset[0];
    const cy = (H ? H.cy : head!.pos[1] + jr0) + placement.offset[1];
    const cz = (H ? H.cz : head!.pos[2]) + placement.offset[2];
    const rx = (H ? H.rx : jr0) * s, ry = (H ? H.ry : jr0 * 1.3) * s, rz = (H ? H.rz : jr0) * s;
    const eyeY = (fit.eyeY != null ? fit.eyeY + placement.offset[1] : cy + ry * 0.10);   // same exact eye line as sunglasses
    const eyeZ = cz + rz * 0.92, eyeX = rx * 0.42;
    if (wire) {
        // WIRE-FRAME: ROUND thin metal rims (ellipse loops) + a thin bridge + temples — the iconic wire look.
        const rw = rx * 0.30, rh = ry * 0.19, wt = rx * 0.013;
        for (const sx of [-1, 1]) eyeRing(a, [cx + sx * eyeX, eyeY, eyeZ], rw, rh, wt);
        segBand(a, [[cx - (eyeX - rw * 0.9), eyeY + ry * 0.02, eyeZ], [cx + (eyeX - rw * 0.9), eyeY + ry * 0.02, eyeZ]], wt, wt, 0);   // bridge (inner edge → inner edge, over the nose)
        for (const sx of [-1, 1]) {                                   // temple arms → the ears
            const A: V3 = [cx + sx * (eyeX + rw), eyeY, eyeZ];
            const E: V3 = [cx + sx * rx * 1.02, eyeY + ry * 0.04, cz - rz * 0.2];
            segBand(a, [A, E], wt * 0.9, wt * 0.9, 0);
        }
        return;
    }
    // PLASTIC: chunky RECTANGULAR rims (rimRect) + bridge + temples.
    const lensW = rx * 0.32, lensH = ry * 0.185, rimW = rx * 0.028;   // thinner + slightly taller (rounder) openings than shades
    for (const sx of [-1, 1]) {
        const c: V3 = [cx + sx * eyeX, eyeY, eyeZ];
        rimRect(a, c, lensW, lensH, rimW, rimW * 1.3, 0);            // frame rim ONLY — the lens is clear (omitted)
    }
    box(a, [cx, eyeY + ry * 0.02, eyeZ], [1,0,0],[0,1,0],[0,0,1], Math.max(0.002, eyeX - lensW - rimW), rimW, rimW * 1.3, 0);   // bridge (over the nose)
    for (const sx of [-1, 1]) {                                       // temple arms → the ears (thinner than shades)
        const A: V3 = [cx + sx * (eyeX + lensW + rimW * 2), eyeY, eyeZ];
        const E: V3 = [cx + sx * rx * 1.02, eyeY + ry * 0.04, cz - rz * 0.2];
        segBand(a, [A, E], rimW * 0.8, rimW * 0.8, 0);
    }
}

/** TOTE / shoulder bag: a flat bag at one hip (SWAYS subtly on a spring bone) + a strap looped over that shoulder
 *  (rigid). Side = sign of the offset x. */
function buildTote(a: Acc, fit: BodyFit, placement: AttachmentPlacement, s: number, dangleBones: V3[]): AttachmentSpringParams | undefined {
    const chest = fit.joints[placement.joint] ?? fit.joints['chest']; if (!chest) return undefined;
    const hips = fit.joints['hips'];
    const side = placement.offset[0] >= 0 ? 1 : -1;
    const shoulder = side > 0 ? fit.joints['shoulder_L'] : fit.joints['shoulder_R'];   // shoulder_L sits at +X
    const cw = jr(chest) * s;
    const bagX = chest.pos[0] + side * cw * 1.05, bagZ = chest.pos[2] + cw * 0.35;
    const bagY = (hips?.pos[1] ?? chest.pos[1] - cw * 2.2) + cw * 0.5;                 // hip level
    const bw = cw * 0.74, bh = cw * 0.9, bd = cw * 0.22;                               // half-extents — a flat, wide canvas tote
    dangleBones.push([bagX, bagY + bh, bagZ]);   // spring bone at the bag TOP (handle junction) → the bag swings below it; local index 1

    // BODY (sways, j=1): a flat rectangular bag + a flat bottom edge so it isn't a bare slab, a folded top hem
    // around the mouth (front + back bands), and a front patch pocket — geometric detail on one canvas material.
    box(a, [bagX, bagY, bagZ], [1,0,0],[0,1,0],[0,0,1], bw, bh, bd, 1);                                   // bag body
    box(a, [bagX, bagY - bh, bagZ], [1,0,0],[0,1,0],[0,0,1], bw, cw * 0.05, bd * 1.12, 1);                // flat bottom base
    for (const dz of [bd, -bd]) box(a, [bagX, bagY + bh * 0.96, bagZ + dz], [1,0,0],[0,1,0],[0,0,1], bw, cw * 0.055, cw * 0.02, 1);   // top hem (front + back)
    box(a, [bagX, bagY - bh * 0.22, bagZ + bd + cw * 0.012], [1,0,0],[0,1,0],[0,0,1], bw * 0.58, bh * 0.4, cw * 0.014, 1);           // front patch pocket (proud)

    // TWO PARALLEL HANDLES over the shoulder (rigid, j=0): each arcs bag-front-top → over the shoulder → bag-back-top.
    const shX = shoulder ? shoulder.pos[0] : chest.pos[0] + side * cw * 0.9, shY = shoulder ? shoulder.pos[1] : chest.pos[1] + cw * 0.5;
    for (const hx of [-bw * 0.45, bw * 0.45]) {
        const rootF: V3 = [bagX + hx, bagY + bh, bagZ + bd * 0.55];
        const rootB: V3 = [bagX + hx, bagY + bh, bagZ - bd * 0.55];
        const over:  V3 = [shX + side * cw * 0.05 + hx * 0.35, shY + cw * 0.18, chest.pos[2]];   // +hx*0.35 keeps the two handles parallel over the shoulder
        segBand(a, qbez(rootF, over, rootB, 12), cw * 0.05, cw * 0.028, 0);
    }
    return { stiffness: 0.8, drag: 0.72, gravity: 0.0018, hitRadius: cw * 0.4 };       // VERY subtle
}

export function generateAttachment(fit: BodyFit, placement: AttachmentPlacement, params: AttachmentParams): AttachmentMesh | null {
    const joint = fit.joints[placement.joint];
    if (!joint) return null;
    const s = Math.max(0.1, placement.scale || 1);
    const anchor: V3 = [joint.pos[0] + placement.offset[0], joint.pos[1] + placement.offset[1], joint.pos[2] + placement.offset[2]];
    const jointR = (joint as any).radius ?? 0.03;
    // WRAP types (bracelet / watch / choker) auto-fit the limb instead of using a freeform offset: a single
    // `position` (0..1) slides the band along the bone toward its child (wrist / jaw), the band AUTO-ORIENTS along
    // the bone axis, and the radius SHRINK-FITS the limb there. No x/y/z offset or rotation — they can only sit on
    // the limb anyway, so those DOF just let you break it.
    let wrapC: V3 = anchor, wrapAxis: V3 = [0, 1, 0], wrapR = jointR, wrapBracket: RingBracket | null = null;
    if (params.type === 'bracelet' || params.type === 'watch' || params.type === 'choker') {
        const side = placement.joint.endsWith('_L') ? '_L' : placement.joint.endsWith('_R') ? '_R' : '';
        const child = fit.joints[params.type === 'choker' ? 'head' : 'hand' + side];
        const pos = Math.max(0, Math.min(1, params.position ?? (params.type === 'choker' ? 0.3 : 0.85)));
        if (child) {
            const seg = sub(child.pos as V3, joint.pos as V3);
            const segLen = len(seg) || 0.1;
            const reach = params.type === 'choker' ? pos * 0.55 : pos;        // choker stays on the neck (don't ride into the head)
            wrapC = add(joint.pos as V3, scl(seg, reach));
            wrapAxis = norm(seg);
            const rChild = (child as any).radius ?? jointR;
            wrapR = params.type === 'choker' ? jointR : jointR + (rChild - jointR) * pos;   // fallback: the (inflated) joint radius
            // The joint scalar radius is inflated by the jaw/shoulders (neck) or palm (wrist) weighted to the same
            // joint, floating the band off. Get the TRUE fit at the band: arm bands grab the nearest clean arm-surface
            // RING — the band then CONFORMS to its real (oval / faceted) cross-section so it can't gap or clip — else
            // sample the body verts in a THIN slab (recentre onto the flesh + median radius). Choker = neck sample.
            let bf: BandFit | null = null;
            const armSide = placement.joint.endsWith('_L') ? 'L' : placement.joint.endsWith('_R') ? 'R' : '';
            if ((params.type === 'bracelet' || params.type === 'watch') && armSide) {
                const rings = fit.armSurface?.[armSide as 'L' | 'R'];
                if (rings && rings.length) { wrapBracket = bracketRings(rings, wrapC, wrapAxis); bf = ringFitAt(rings, wrapC, wrapAxis); }
            }
            if (!bf && fit.body) bf = sampleLimbFit(fit.body, wrapC, wrapAxis, joint.idx, child.idx, segLen * 0.12);
            if (bf && bf.radius > 0.004) { wrapC = bf.center; wrapR = bf.radius; }   // recentre onto the flesh + true radius
        }
    }
    const a = acc();
    const dangleBones: V3[] = [];
    const bindJoints: string[] = [];
    let springParams: AttachmentSpringParams | undefined;
    switch (params.type) {   // 0 = anchor bone-local; the chain may add bindJoints + dangle/sway bones
        case 'chain':    springParams = buildChain(a, anchor, fit, placement, params, s, bindJoints, dangleBones); break;
        case 'pocket': {   // up = the limb's long axis (so the pocket stays PARALLEL to the leg); out = the offset's radial part (faces outward)
            const cn = childOf(placement.joint), cj = cn ? fit.joints[cn] : undefined;
            let up: V3 = cj ? norm(sub(joint.pos as V3, cj.pos as V3)) : [0, 1, 0];
            if (up[1] < 0) up = [-up[0], -up[1], -up[2]];                                      // orient toward world-up (the pocket's TOP)
            const off = placement.offset as V3, dp = off[0] * up[0] + off[1] * up[1] + off[2] * up[2];
            let outR: V3 = [off[0] - up[0] * dp, off[1] - up[1] * dp, off[2] - up[2] * dp];     // radial (⊥ to the limb)
            if (len(outR) < 1e-4) outR = off;
            buildPocket(a, anchor, outR, params, s, 0, up);
            break;
        }
        case 'pendant': {   // out = the offset's radial part (⊥ to the limb) → the pendant faces outward + drapes down the surface
            const cn = childOf(placement.joint), cj = cn ? fit.joints[cn] : undefined;
            let up: V3 = cj ? norm(sub(joint.pos as V3, cj.pos as V3)) : [0, 1, 0];
            if (up[1] < 0) up = [-up[0], -up[1], -up[2]];
            const off = placement.offset as V3, dp = off[0] * up[0] + off[1] * up[1] + off[2] * up[2];
            let outR: V3 = [off[0] - up[0] * dp, off[1] - up[1] * dp, off[2] - up[2] * dp];
            if (len(outR) < 1e-4) outR = off.some(c => c !== 0) ? off : [0, 0, 1];
            buildPendant(a, anchor, fit, outR, params, s, 0);
            break;
        }
        case 'bracelet': buildBracelet(a, wrapC, wrapAxis, wrapR, params, s, 0, wrapBracket); break;
        case 'watch':    buildWatch(a, wrapC, wrapAxis, wrapR, params, s, 0, wrapBracket); break;
        case 'choker':   buildChoker(a, wrapC, wrapAxis, wrapR, params, s, 0); break;
        case 'clip':     buildClip(a, anchor, placement.offset as V3, params, s, 0); break;
        case 'flower':   buildFlower(a, anchor, placement.offset as V3, params, s, 0); break;
        case 'loop':     buildLoop(a, anchor, placement.offset as V3, params, s, 0); break;
        case 'beltloop': buildBeltLoop(a, anchor, placement.offset as V3, params, s); break;
        case 'button':   buildButton(a, anchor, placement.offset as V3, params, s, 0); break;
        case 'backpack':   springParams = buildBackpack(a, fit, placement, s, dangleBones); break;
        case 'headphones': buildHeadphones(a, fit, placement, s, params.cuffStyle === 'round'); break;
        case 'sunglasses': buildSunglasses(a, fit, placement, s); break;
        case 'glasses':    buildGlasses(a, fit, placement, s); break;
        case 'wireglasses':buildGlasses(a, fit, placement, s, true); break;
        case 'tote':       springParams = buildTote(a, fit, placement, s, dangleBones); break;
    }
    if (a.n === 0) return null;
    return { ...finishAcc(a), bindJoints, dangleBones, springParams };
}
