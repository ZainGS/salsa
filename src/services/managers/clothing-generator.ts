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
export interface BodyMeshData { verts: Float32Array; ji: Uint8Array; jw: Float32Array; }
/** The body frame a garment is fit to — keyed by joint name (hips/spine/chest/neck/shoulder_L…),
 *  plus per-side arm radii for the sleeves and (optional) the body mesh for the final fit pass. */
export interface BodyFit { joints: Record<string, JointFit | undefined>; arms?: { L?: ArmFit; R?: ArmFit }; body?: BodyMeshData; armSurface?: { L?: ArmRing[]; R?: ArmRing[] }; }

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
    baseColor: string; trimColor: string; gradient: boolean; trimWidth: number;
    chunkiness: number;
}

export interface BottomParams {
    slot: 'bottom';
    bottomStyle: 'skirt' | 'shorts' | 'pants';
    waistWidth: number;         // TOP girth — scales the waist/pants-top width (× hip radius)
    waistHeight: number;        // raise/lower the waistband (× hip radius)
    length: number;             // skirt/leg length (0 = short, 1 = full to the ankle)
    flare: number;              // skirt hem widen (× waist radius; skirt only)
    thickness: number;
    baseColor: string; trimColor: string; gradient: boolean; trimWidth: number;
    chunkiness: number;
}

export type ClothingParams = TopParams | BottomParams;

export function defaultTopParams(): TopParams {
    return {
        slot: 'top', neckline: 'round', necklineHeight: 0.55, hemHeight: 0.2, thickness: 0.012,
        shoulderCoverage: 0.8, sleeveLength: 0.5, sleeveWidth: 0.005, sleeveCap: 0.1,
        baseColor: '#e85a8a', trimColor: '#ffffff', gradient: false, trimWidth: 0.12, chunkiness: 0.3,
    };
}
export function defaultBottomParams(): BottomParams {
    return {
        slot: 'bottom', bottomStyle: 'skirt', waistWidth: 0.7, waistHeight: 0.0, length: 0.45, flare: 1.6, thickness: 0.012,
        baseColor: '#5a6ab0', trimColor: '#ffffff', gradient: false, trimWidth: 0.12, chunkiness: 0.3,
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
    'Long Sleeve': () => ({ ...defaultTopParams(), sleeveLength: 1, necklineHeight: 0.7, baseColor: '#9a6ad0' }),
};
const BOTTOM_PRESETS: Record<string, () => BottomParams> = {
    'Skirt':      () => defaultBottomParams(),
    'Mini Skirt': () => ({ ...defaultBottomParams(), length: 0.3, flare: 1.9 }),
    'Shorts':     () => ({ ...defaultBottomParams(), bottomStyle: 'shorts', length: 0.5 }),
    'Pants':      () => ({ ...defaultBottomParams(), bottomStyle: 'pants', length: 1.0 }),
};
export function clothingPresetNames(slot: 'top' | 'bottom'): string[] {
    return Object.keys(slot === 'top' ? TOP_PRESETS : BOTTOM_PRESETS);
}
export function clothingPreset(slot: 'top' | 'bottom', name: string): ClothingParams {
    const m = slot === 'top' ? TOP_PRESETS : BOTTOM_PRESETS;
    return (m[name] ?? (slot === 'top' ? defaultTopParams : defaultBottomParams))();
}

// ── vec helpers ──
const sub = (a: V3, b: V3): V3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const add = (a: V3, b: V3): V3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const scl = (a: V3, s: number): V3 => [a[0]*s, a[1]*s, a[2]*s];
const cross = (a: V3, b: V3): V3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a: V3, b: V3): number => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
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

// ── Sleeve via OFFSET SURFACE — the sleeve IS the body's real arm, pushed outward ──
// rings = the body's actual arm rings [collar(=armhole/socket shape) → deltoid → upper → elbow → wrist],
// index-corresponding (band k→k). Each vertex is offset along its outward normal by the air gap; the chain
// is cut at length L (0..1 along the arm) with an interpolated end ring at exactly L (so the cuff trim
// lands on the real hem); UV runs by reach. Because the rings ARE the shoulder/armpit, the sleeve FOLLOWS
// them — no tube approximation, no straight bridge across the armpit. generateTop's shrink-wrap cleans up.
function buildSleeveOffset(ac: Accum, rings: ArmRing[], p: TopParams, L: number): void {
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

// Bottoms waistband fit: the "Waist" slider (0.6..1.4) now maps to a TINY body-relative OFFSET — NOT a
// radius multiplier (>1 ballooned the waist way off the body, <1 clipped). Min ≈ the air gap (hugs the
// mesh waist), max ≈ a thin belt. Keeps the slider (the looseness/belt feel the user liked) but bounded so
// the waistband is always "just off the mesh waist".
const WAIST_BELT_MAX = 0.02;   // world units — the loosest the waistband ever sits off the body
function waistbandR(bodyR: number, waistWidth: number, gap: number): number {
    const t = Math.max(0, Math.min(1, (waistWidth - 0.6) / 0.8));   // slider 0.6..1.4 → 0..1 belt amount
    return bodyR + Math.max(gap, MIN_GAP) + t * WAIST_BELT_MAX;
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
    const waistR = waistbandR(hugRadius(hips), p.waistWidth, MIN_GAP);   // front/side girth + belt only (no Looseness) → the waist hugs, then flares
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
function buildLegs(ac: Accum, fit: BodyFit, p: BottomParams, rings: number): void {
    const hips = fit.joints['hips'];
    if (!hips) return;
    const u: V3 = [1, 0, 0], v: V3 = [0, 0, 1];   // world-XZ ring frame → aligns with the directional radii sectors
    const legGap = Math.max(p.thickness, MIN_GAP); // air offset, floored so legs can't pull tight enough to clip
    const waistY = hips.pos[1] + hips.radius * p.waistHeight;
    // Waist fit: the "Waist" slider now SCALES the waistband's body-sampled radii (real authority) instead of
    // only nudging a 0–2cm belt — the belt-only mapping is why shrinking Waist did nothing once the band hugged.
    // 0.6 → 0.85× (tight — the de-collision pass pins it to the true body, so it still can't clip) · 1.0 → ~1.0×
    // (natural hug) · 1.4 → 1.20× (loose belt). The band read too big because hips.radii is sampled over the
    // whole hip span (the widest slice), so it oversized the higher waistband; the scale lets it cinch to the
    // body at that height. Faded back to the natural leg fit over the first rings (no step into the thigh).
    const wt = Math.max(0, Math.min(1, (p.waistWidth - 0.6) / 0.8));
    const waistScale = 0.85 + wt * 0.35;
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
        const endY = waistY - (waistY - ankleY) * Math.max(0.08, Math.min(1.15, p.length));   // length 0..1+ = ankle
        const ringList: number[][] = [];
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            const y = waistY + (endY - waistY) * t;
            const x = hips.pos[0] + (ul.pos[0] - hips.pos[0]) * pullAt(t);
            const c: V3 = [x, y, ul.pos[2]];
            if (i === 0) {
                // Hip yoke — directional (per-sector), sampled at the band height (hips→spine) so it hugs the
                // waist at high Rise, × Waist scale; weights blend to the spine too so a raised band deforms right.
                ringList.push(addRingDir(ac, c, u, v, yokeRadii.map(r => r * waistScale), 1, MIN_GAP, t, hips.idx, 1 - yokeF, spine?.idx ?? hips.idx, yokeF));
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
                    const thigh = (ra + (lo.radii[k] - ra) * lt) * sc;
                    if (seat <= 0) return thigh;
                    const dk = Math.min((k - backK + RING) % RING, (backK - k + RING) % RING);
                    const angW = Math.max(0, 1 - dk / (RING / 4));  // back hemisphere only (±90° from −Z)
                    return thigh + Math.max(0, hips.radii[k] * sc - thigh) * seat * angW;   // ADD only → projects over the butt, never shrinks the thigh
                });
                ringList.push(addRingDir(ac, c, u, v, radii, 1, legGap, t, j, 1, j, 0));
            }
            // Crotch-fill rings (top ~third, pulled toward centre so the two legs overlap): keep their ANALYTIC
            // per-leg weight — the body-fit pass would re-weight this fabric to the hips (nearest = the body's
            // hips-weighted crotch), fusing both legs into one sheet that webs like a dress on a kick/splits.
            // Protected, each leg's crotch fabric follows ITS leg → the legs separate cleanly when posed.
            if (t < 0.34) for (const vi of ringList[ringList.length - 1]) ac.noXfer.add(vi);
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
    for (let g = start; g < end; g++) {
        const gx = ac.pos[g*3], gy = ac.pos[g*3+1], gz = ac.pos[g*3+2];
        let best = -1, bestD = Infinity;
        for (let b = 0; b < bn; b++) {
            const dx = gx - body.verts[b*12], dy = gy - body.verts[b*12+1], dz = gz - body.verts[b*12+2];
            const d = dx*dx + dy*dy + dz*dz;
            if (d < bestD) { bestD = d; best = b; }
        }
        if (best < 0) continue;
        const o = best*12, nx = body.verts[o+3], ny = body.verts[o+4], nz = body.verts[o+5];
        const signed = (gx-body.verts[o])*nx + (gy-body.verts[o+1])*ny + (gz-body.verts[o+2])*nz;   // dist from surface
        const move = Math.max(-maxIn, Math.min(maxOut, gap - signed));
        ac.pos[g*3] += nx*move; ac.pos[g*3+1] += ny*move; ac.pos[g*3+2] += nz*move;
    }
}

/**
 * Generation-time fit pass — the "never clip" guarantee + pose robustness:
 *  1. Shrink-wrap / de-collision: any garment vertex inside the body (or closer than `gap`) is pushed
 *     OUT to the body surface + gap. The push is SMOOTHED over the garment surface so a corrected vert
 *     lifts its neighbours into a soft bump (no spikes); it only ever pushes out, so loose/flared areas
 *     are untouched (drape preserved).
 *  2. Weight transfer: each touching garment vertex copies the nearest body vertex's skin weights, so
 *     the garment folds with the body when posed (far less joint clipping than analytic ring weights).
 * Nearest-VERTEX query (the body is low-poly + the garment already hugs it, so corrections are small).
 */
function fitGarmentToBody(ac: Accum, body: BodyMeshData, gap: number, maxPush = MAX_DECOLLIDE_PUSH): void {
    const bn = body.verts.length / 12;
    if (bn === 0 || ac.count === 0) return;
    const push = new Float32Array(ac.count);                                   // outward distance per vert
    const pnx = new Float32Array(ac.count), pny = new Float32Array(ac.count), pnz = new Float32Array(ac.count);
    const near = new Int32Array(ac.count).fill(-1);
    const nearD = new Float32Array(ac.count);
    for (let g = 0; g < ac.count; g++) {
        const gx = ac.pos[g*3], gy = ac.pos[g*3+1], gz = ac.pos[g*3+2];
        let best = -1, bestD = Infinity;
        for (let b = 0; b < bn; b++) {
            const dx = gx - body.verts[b*12], dy = gy - body.verts[b*12+1], dz = gz - body.verts[b*12+2];
            const d = dx*dx + dy*dy + dz*dz;
            if (d < bestD) { bestD = d; best = b; }
        }
        near[g] = best; nearD[g] = Math.sqrt(bestD);
        const o = best*12, nx = body.verts[o+3], ny = body.verts[o+4], nz = body.verts[o+5];
        const signed = (gx-body.verts[o])*nx + (gy-body.verts[o+1])*ny + (gz-body.verts[o+2])*nz; // dist from surface
        push[g] = Math.min(maxPush, Math.max(0, gap - signed));   // cap → don't expose deep internals
        pnx[g] = nx; pny[g] = ny; pnz[g] = nz;
    }
    // Dilate/smooth the push so corrections are soft bumps, never spikes (max → never drops below required).
    const adj = buildAdjacency(ac);
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
            const sum = w0 + (w1 > 0 ? w1 : 0);
            if (sum > 0) {
                ac.j0[g] = i0; ac.w0[g] = w0 / sum;
                ac.j1[g] = w1 > 0 ? i1 : i0; ac.w1[g] = w1 > 0 ? w1 / sum : 0;
            }
        }
    }
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
    if (fit.body) fitGarmentToBody(ac, fit.body, MIN_GAP, 0.06);
    return finish(ac);
}

export function generateBottom(fit: BodyFit, p: BottomParams) {
    const ac = newAc();
    const rings = 4 + Math.round(Math.max(0, Math.min(1, p.chunkiness)) * 4);
    if (p.bottomStyle === 'skirt') buildSkirt(ac, fit, p, rings);
    else buildLegs(ac, fit, p, rings);
    // Bottoms get a BIG de-collision cap: the legs/hip have no deep internals to hide (unlike a sleeve
    // socket), and the projecting butt / fuller thighs can sit well inside the garment — so allow the
    // shrink-wrap to push the skin back out fully (no clip). Now the garment is at the body's resolution
    // (RING=24) the verts already line up, so this is mostly a safety net for the deepest spots.
    if (fit.body) fitGarmentToBody(ac, fit.body, MIN_GAP, 0.09);
    return finish(ac);
}
