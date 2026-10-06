// ── World generation — CROWD CHARACTERS: baked pedestrian archetypes from the character system ─────────────────────
// docs/specs/crowd-characters.md. City pedestrians built from the procedural CHARACTER (body + garments + lock hair)
// instead of the mannequin kit, but never as live characters: a small set of ARCHETYPES is generated once, CPU-posed
// into the crowd's mild poses, gated, decimated and palette-coded, and the crowd emits that shared geometry per person
// (crowd-instanced.ts CrowdCellBuilder, `crowdStyle: 'character'`). Faceless (no eyes / face kit — the body's head is
// plain skin), flat-shaded by the crowd material, coloured per person from the crowd palette.
//
// Pipeline per archetype (bakeCrowdArchetype):
//   crowdCharacterParams(i)  constrained body ranges (narrowed shoulders, slimmer / longer-legged, smaller head),
//                            a garment WHITELIST, a static lock-hair whitelist (no springs)
//   generateCharacterParts   body → body fit → garments → hair (the pure character pipeline, character-parts.ts)
//   layerOutfit + hide mask  the garments as drawn; body triangles under cloth dropped (pose-verified in the crowd poses)
//   per crowd pose:          skin every garment at full resolution → the CLOTHING GATE (poke-through / tear / pant-leg
//                            web) → a failing (archetype, pose) pair is DROPPED (the crowd falls back per person)
//   decimate (QEM)           once, on the bind-pose pieces (slot x body part), to the NEAR and MID budgets; the
//                            survivors keep their skin weights (mesh-simplify src), so each pose is a cheap re-skin
//   slot codes + rig parts   per vertex: crowd-palette slot (skin / top / legs / shoes / skirt / hair), body part CP_*
//                            (the live crowd's rig groups) and the joint pivots PV_* per pose
// Output in the mannequin's person-local frame (+X forward, +Y up, +Z to the person's right, metres, feet at y = 0,
// a canonical 1.70 m person) so it drops into the mannequin's emit transform.
//
// Pure + worker-safe (no DOM / scene graph / WebGPU): the near-cell worker lane bakes its own copy on first use.

import { mat4 } from 'gl-matrix';
import { generateCharacterParts, type GarmentGenResult } from '../services/managers/character-parts';
import { NEW_BODY_DEFAULTS, type BodyParams } from '../services/managers/body-generator';
import { clothingPreset, type TopParams, type BottomParams, type ShoeParams, type ClothingParams } from '../services/managers/clothing-generator';
import { DEFAULT_HAIR_PARAMS, hairStylePreset, type HairParams } from '../services/managers/hair-generator';
import { layerOutfit, limbSidesFromNames, type LayerSlot } from '../services/managers/garment-layers';
import { computePoseVerifiedHideMask, type MaskSkinned } from '../services/managers/body-hide-mask';
import { posedJointWorld, measureDeformation, type SkinnedMeshData, type PoseRotations } from '../services/managers/skin-deform-metrics';
import { relaxedStance, weightShift, armPose, qAxis, qMul, type ArmSpec, type Quat } from '../services/managers/pose-authoring';
import { packDualQuatSkin, skinMatrixForTS } from '../renderer/3d/dual-quat-skin';
import { simplifyMesh } from '../scene-graph/shapes/mesh-simplify';
import { CROWD_SLOT_BASE, crowdPaletteIndex } from '../renderer/3d/crowd-palette';
import { CP_PHONE, CP_LEGL, CP_LEGR, CP_SKIRT, CP_TORSO, CP_ARML, CP_ARMR, CP_HEAD, CP_COUNT, PV_UPPER, PV_HEAD, PV_ARML, PV_ARMR, PV_LEGL, PV_LEGR, PV_COUNT, type Pose } from './mannequin';
import { makeRng } from './util';

type V3 = [number, number, number];

// ── Palette slots (crowd-instanced.ts SLOT_* — the same numbers; crowd-character.test pins them) ─────────────────
export const CC_SLOT_TOP = 0, CC_SLOT_HAIR = 1, CC_SLOT_LEGS = 2, CC_SLOT_SHOES = 3, CC_SLOT_SKIRT = 4;
/** Vertex code of a fixed SKIN vertex (a palette index, below CROWD_SLOT_BASE). */
export const CC_CODE_SKIN = Math.max(0, crowdPaletteIndex('skin'));
/** Vertex code of the phone prop (a fixed black). */
export const CC_CODE_PHONE = Math.max(0, crowdPaletteIndex('black'));
/** Vertex code of a per-person slot. */
export const ccSlotCode = (slot: number): number => CROWD_SLOT_BASE + slot;

// ── Budgets (spec "Budget") ──────────────────────────────────────────────────────────────────────────────────────
/** NEAR = the spec's ≤ 4k. MID: the spec's 1.2k target is NOT reachable cleanly with border-locked QEM (2026-10-04
 *  Phase 0: the shirt shell tears open, the head collapses to a cone, the hair spikes); with per-part floors the clean
 *  result measures ~1.85k, so MID is capped at 2k. */
export const CROWD_CHAR_BUDGET = { near: 4000, mid: 2000 } as const;
/** Default archetype count (spec: ~24–32 eventually; the default set stays small so a first bake is cheap). */
export const CROWD_CHAR_COUNT = 24;

// ── Poses ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The crowd poses an archetype is baked in (the mannequin Pose names). Others (sit / lean / rail / stride / ride)
 *  stay on the mannequin for now. */
export const CROWD_CHAR_POSES: readonly Pose[] = ['stand', 'rest', 'clasp', 'phone', 'talk'];
const toList = (r: Record<string, Quat>): PoseRotations => Object.entries(r).map(([joint, q]) => ({ joint, q }));
/** Joint rotations of a crowd pose (body-generator conventions: arm L raise = z+, torso forward = x+, ...). Mild
 *  only — the gate drops anything the clothing can't follow. `flip` is applied at emit (a mirror), not here. */
export function crowdCharPose(pose: Pose): PoseRotations | null {
    const base = relaxedStance();
    const head = (pitch: number, yaw = 0): Record<string, Quat> => ({ head: qMul(qAxis('y', yaw), qAxis('x', pitch)) });
    switch (pose) {
        case 'stand': return toList(base);
        case 'rest': return toList({ ...base, ...weightShift('L', 4), ...armPose({ raise: 18, fwd: 4, twist: 22, elbow: 14, wrist: 6 }, 'R') });
        case 'clasp': {   // hands together in front, low
            const a: ArmSpec = { raise: 14, fwd: 24, twist: 52, elbow: 58, wrist: 8 };
            return toList({ ...base, ...armPose(a, 'L'), ...armPose(a, 'R'), ...head(6) });
        }
        case 'phone': {   // right hand up at the chest, looking down at it
            return toList({ ...base, ...armPose({ raise: 12, fwd: 28, twist: 46, elbow: 108, wrist: 6 }, 'R'), ...head(18), neck: qAxis('x', 6) });
        }
        case 'talk': {    // right forearm up, gesturing; weight shifted
            return toList({ ...base, ...weightShift('R', 3), ...armPose({ raise: 18, fwd: 22, twist: 40, elbow: 78, wrist: -8 }, 'R'), ...head(-2, 8) });
        }
        default: return null;
    }
}

// ── Constrained params ───────────────────────────────────────────────────────────────────────────────────────────
/** The silhouette CLASS a person's look is matched on (crowd-instanced picks an archetype of the same class). */
export interface CrowdCharClass { fem: boolean; skirt: boolean; longHair: boolean }

/** Garment WHITELIST — presets that pass clothing-regression.test.ts cleanly and read as everyday street clothes.
 *  No capes / long coats / hem swing / cloth sim (none exist as presets; the mannequin keeps coats + yukata). */
export const CROWD_TOPS = ['Tee', 'Long Sleeve'] as const;
export const CROWD_TROUSERS = ['Pants', 'Skinny'] as const;   // (Baggy Jeans / Wide Leg read as clown trousers at crowd scale)
export const CROWD_SKIRTS = ['Skirt'] as const;
export const CROWD_SHOES = { masc: ['Sneaker', 'High Top'], fem: ['Flat', 'Sneaker'] } as const;
/** Hair WHITELIST — lock styles with a clear silhouette, generated STATIC (every vertex on the head joint, no springs). */
export const CROWD_HAIR = { short: ['short-messy', 'spiky'], long: ['bob', 'long-straight', 'ponytail', 'bun', 'hime', 'side-swept'] } as const;
/** 2026-10-04: trousers were blocked while the pant-leg WEB (hem vertices layered onto the OTHER leg's sock / foot) was
 *  open. Fixed by the limb side mask in garment-layers.ts (passed to layerOutfit below) + the gate now counts a long
 *  edge only when it STRETCHED vs rest. Kept as a kill switch. */
export const CROWD_TROUSERS_BLOCKED = false;
/** Lock count multiplier (fewer, chunkier locks: cheaper and they read better at street distance). */
const LOCK_COUNT_MUL = 0.7;

export interface CrowdCharParams {
    index: number;
    cls: CrowdCharClass;
    body: Partial<BodyParams>;
    top: TopParams; bottom: BottomParams; shoes: ShoeParams;
    hair: HairParams;
    /** Names (reports / tests). */
    names: { top: string; bottom: string; shoes: string; hair: string };
}

/** The class of archetype `i` — a fixed rotation so any set of 8+ covers every class: ~45 % trousers + short hair
 *  (masc), ~30 % skirts, ~25 % fem in trousers. */
const CLASS_CYCLE: readonly CrowdCharClass[] = [
    { fem: false, skirt: false, longHair: false }, { fem: true, skirt: true, longHair: true },
    { fem: false, skirt: false, longHair: false }, { fem: true, skirt: false, longHair: true },
    { fem: false, skirt: false, longHair: false }, { fem: true, skirt: true, longHair: true },
    { fem: true, skirt: false, longHair: true }, { fem: false, skirt: false, longHair: false },
];
export function crowdCharClassOf(i: number): CrowdCharClass { return CLASS_CYCLE[((i % CLASS_CYCLE.length) + CLASS_CYCLE.length) % CLASS_CYCLE.length]; }

/** Constrained, deterministic character params for archetype `i` (crowd-safe ranges + whitelists). */
export function crowdCharacterParams(i: number, seed = 0x51a5): CrowdCharParams {
    const rng = makeRng(((seed * 2654435761) ^ (i * 40503 + 0x9e37)) >>> 0);
    const r = (a: number, b: number): number => rng.range(a, b);
    const pick = <T>(arr: readonly T[]): T => arr[Math.min(arr.length - 1, Math.floor(rng.next() * arr.length))];
    const cls = crowdCharClassOf(i);
    const fem = cls.fem;
    // Body: Persona-ish — slimmer limbs, longer legs than neutral (but well short of the dollcore 1.4), a slightly
    // smaller head than the creator default, and NARROWED shoulders (the wide-shoulder armpit issue).
    const body: Partial<BodyParams> = {
        ...NEW_BODY_DEFAULTS,
        height: 1, headSize: r(1.0, 1.08), legLength: r(1.18, 1.3), torsoLength: r(0.97, 1.03),
        limbThick: fem ? r(0.78, 0.84) : r(0.84, 0.9), torsoThick: fem ? r(0.84, 0.9) : r(0.9, 0.96),
        shoulderWidth: fem ? r(0.86, 0.92) : r(0.94, 1.0),
        bust: fem ? r(1.02, 1.12) : 1, waist: fem ? r(0.84, 0.92) : r(0.92, 1.0),
        hipWidth: fem ? r(1.0, 1.08) : r(0.94, 1.0), hipFront: r(0.65, 0.85), buttSize: r(0.9, 1.05),
    };
    const topName = pick(CROWD_TOPS);
    const top = { ...(clothingPreset('top', topName) as TopParams), hemHeight: -0.1 } as TopParams;   // to the hips (no midriff)
    const bottomName = cls.skirt ? pick(CROWD_SKIRTS) : pick(CROWD_TROUSERS);
    const bottom = { ...(clothingPreset('bottom', bottomName) as BottomParams), thickness: 0.017 } as BottomParams;
    const shoesName = pick(fem ? CROWD_SHOES.fem : CROWD_SHOES.masc);
    const shoes = clothingPreset('shoes', shoesName) as ShoeParams;
    const hairName = pick(cls.longHair ? CROWD_HAIR.long : CROWD_HAIR.short);
    const pre = hairStylePreset(hairName, Math.floor(rng.next() * 10000)) ?? { ...DEFAULT_HAIR_PARAMS };
    const hair: HairParams = {
        ...pre,
        lockCount: Math.max(8, Math.round((pre.lockCount ?? 15) * LOCK_COUNT_MUL)),
        hairlineFront: r(0.34, 0.44),
        frontDrape: 0,           // no over-the-shoulder drapes (they are spring tips in the creator)
        gradient: false,
    };
    return { index: i, cls, body, top, bottom, shoes, hair, names: { top: topName, bottom: bottomName, shoes: shoesName, hair: hairName } };
}

// ── Skinning (the GPU-exact blend, as clothing-audit-harness.skinAll) ───────────────────────────────────────────
interface Rig { m: SkinnedMeshData; names: string[] }
function skinBuffer(rig: Rig, pose: PoseRotations): Float32Array {
    const world = posedJointWorld(rig.m, pose);
    const skin = new Float32Array(world.length * 16);
    const tmp = mat4.create();
    world.forEach((w, j) => skin.set(mat4.multiply(tmp, w, rig.m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4), j * 16));
    return packDualQuatSkin(skin) ?? skin;
}
/** Skin xyz positions (`pos` stride 3) with 4 joints / weights per vertex. */
function skinPos(buf: Float32Array, pos: ArrayLike<number>, ji: ArrayLike<number>, jw: ArrayLike<number>, n: number): Float32Array {
    const out = new Float32Array(n * 3), jj = [0, 0, 0, 0], ww = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 4; k++) { jj[k] = ji[i * 4 + k]; ww[k] = jw[i * 4 + k]; }
        const s = skinMatrixForTS(buf, jj, ww);
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        out[i * 3] = s[0] * x + s[4] * y + s[8] * z + s[12];
        out[i * 3 + 1] = s[1] * x + s[5] * y + s[9] * z + s[13];
        out[i * 3 + 2] = s[2] * x + s[6] * y + s[10] * z + s[14];
    }
    return out;
}
const pos3Of = (v12: Float32Array): Float32Array => {
    const n = v12.length / 12, o = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { o[i * 3] = v12[i * 12]; o[i * 3 + 1] = v12[i * 12 + 1]; o[i * 3 + 2] = v12[i * 12 + 2]; }
    return o;
};
const dominant = (jw: ArrayLike<number>, ji: ArrayLike<number>, i: number): number => {
    let d = 0, bw = -1;
    for (let k = 0; k < 4; k++) if (jw[i * 4 + k] > bw) { bw = jw[i * 4 + k]; d = ji[i * 4 + k]; }
    return d;
};

// ── The clothing gate ────────────────────────────────────────────────────────────────────────────────────────────
/** Gate limits for the MILD crowd poses (far tighter than the 26-pose ROM gate's): visible skin poking through, the
 *  garment's EXCESS tear over the skin it follows, and the pant-leg WEB (a garment triangle joining the two lower
 *  legs, or one stretched past WEB_EDGE). */
export const CROWD_GATE = { pokePct: 2, pokeMm: 18, tearPct: 3, webEdgeM: 0.16, webStretch: 2.5 } as const;
export interface GateCell { garment: string; poke: number; pokeMm: number; tear: number; web: number; long: number; maxEdge: number; pass: boolean }

/** Small spatial hash: nearest point within r. */
function nearGrid(P: Float32Array, cell = 0.03): (x: number, y: number, z: number, r: number) => number {
    const map = new Map<number, number[]>();
    const K = (a: number, b: number, c: number): number => ((a + 512) * 1024 + (b + 512)) * 1024 + (c + 512);
    for (let i = 0; i < P.length / 3; i++) {
        const k = K(Math.floor(P[i * 3] / cell), Math.floor(P[i * 3 + 1] / cell), Math.floor(P[i * 3 + 2] / cell));
        let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i);
    }
    return (x, y, z, maxR) => {
        let best = -1, bd = maxR * maxR;
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell), rr = Math.ceil(maxR / cell);
        for (let a = -rr; a <= rr; a++) for (let b = -rr; b <= rr; b++) for (let c = -rr; c <= rr; c++) {
            const l = map.get(K(cx + a, cy + b, cz + c)); if (!l) continue;
            for (const i of l) { const d = (P[i * 3] - x) ** 2 + (P[i * 3 + 1] - y) ** 2 + (P[i * 3 + 2] - z) ** 2; if (d < bd) { bd = d; best = i; } }
        }
        return best;
    };
}
/** Area-weighted vertex normals (xyz stride 3). */
function vertexNormals(P: Float32Array, idx: ArrayLike<number>): Float32Array {
    const N = new Float32Array(P.length);
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const o of [a, b, c]) { N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
    }
    for (let i = 0; i < N.length; i += 3) { const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1; N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
    return N;
}

interface GarmentIn { name: string; g: GarmentGenResult; bottom: boolean }
function gateGarment(rig: Rig, bodyRest: Float32Array, bodyIdx: Uint32Array, bodyVisible: Uint8Array, gar: GarmentIn, pose: PoseRotations, buf: Float32Array, bodyPosed: Float32Array): GateCell {
    const g = gar.g, gv = g.geometry.vertices, n = gv.length / 12, gi = g.geometry.indices;
    const gRest = pos3Of(gv), gN = vertexNormals(gRest, gi);
    // covered + VISIBLE body verts (hidden ones are not drawn — they can't show through)
    const near = nearGrid(gRest);
    const covered: number[] = [];
    for (let b = 0; b < bodyRest.length / 3; b++) {
        if (!bodyVisible[b]) continue;
        const x = bodyRest[b * 3], y = bodyRest[b * 3 + 1], z = bodyRest[b * 3 + 2];
        const k = near(x, y, z, 0.04); if (k < 0) continue;
        if ((x - gRest[k * 3]) * gN[k * 3] + (y - gRest[k * 3 + 1]) * gN[k * 3 + 1] + (z - gRest[k * 3 + 2]) * gN[k * 3 + 2] < 0) covered.push(b);
    }
    const gP = skinPos(buf, gRest, g.jointIndices, g.jointWeights, n), gPN = vertexNormals(gP, gi);
    const nearP = nearGrid(gP);
    let poke = 0, maxD = 0;
    for (const b of covered) {
        const x = bodyPosed[b * 3], y = bodyPosed[b * 3 + 1], z = bodyPosed[b * 3 + 2];
        const k = nearP(x, y, z, 0.06); if (k < 0) continue;
        const d = (x - gP[k * 3]) * gPN[k * 3] + (y - gP[k * 3 + 1]) * gPN[k * 3 + 1] + (z - gP[k * 3 + 2]) * gPN[k * 3 + 2];
        if (d > 0.003) { poke++; if (d > maxD) maxD = d; }
    }
    // tear: the garment's stretched / folded share minus the skin's own under it (the harness's EXCESS)
    const gm: SkinnedMeshData = { ...rig.m, vertices: gv, indices: gi, jointIndices: g.jointIndices, jointWeights: g.jointWeights };
    const tr = measureDeformation(gm, pose, undefined, undefined, 'dqs');
    const region = [...new Set(covered.map((b) => rig.names[dominant(rig.m.jointWeights, rig.m.jointIndices, b)]))];
    const sk = region.length ? measureDeformation(rig.m, pose, region, undefined, 'dqs') : null;
    const tear = (100 * (tr.stretched + tr.folded)) / Math.max(1, gi.length / 3) - (sk && sk.tris ? (100 * (sk.stretched + sk.folded)) / sk.tris : 0);
    // web: a triangle joining the two lower legs, or an edge stretched past webEdgeM
    const legSide = (j: number): number => { const nm = rig.names[j]; return nm === 'lowerleg_L' || nm === 'foot_L' ? -1 : nm === 'lowerleg_R' || nm === 'foot_R' ? 1 : 0; };
    let web = 0, long = 0, maxEdge = 0;
    for (let t = 0; t < gi.length; t += 3) {
        const a = gi[t], b = gi[t + 1], c = gi[t + 2];
        // e = longest posed edge; st = its stretch vs REST. A long edge is only a web when it STRETCHED — trouser legs
        // have legitimately long (~20 cm) vertical edges at rest, so an absolute length cap failed every clean pant.
        let e = 0, st = 0;
        for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
            const L = Math.hypot(gP[p * 3] - gP[q * 3], gP[p * 3 + 1] - gP[q * 3 + 1], gP[p * 3 + 2] - gP[q * 3 + 2]);
            const R = Math.hypot(gRest[p * 3] - gRest[q * 3], gRest[p * 3 + 1] - gRest[q * 3 + 1], gRest[p * 3 + 2] - gRest[q * 3 + 2]);
            if (L > e) { e = L; st = L / Math.max(1e-6, R); }
        }
        if (e > maxEdge) maxEdge = e;
        if (gar.bottom) {
            const s = [legSide(dominant(g.jointWeights, g.jointIndices, a)), legSide(dominant(g.jointWeights, g.jointIndices, b)), legSide(dominant(g.jointWeights, g.jointIndices, c))];
            if (s.includes(-1) && s.includes(1)) web++;
            if (e > CROWD_GATE.webEdgeM && st > CROWD_GATE.webStretch) long++;
        }
    }
    void bodyIdx;
    const pokePct = covered.length ? (100 * poke) / covered.length : 0;
    const pass = pokePct <= CROWD_GATE.pokePct && maxD * 1000 <= CROWD_GATE.pokeMm && tear <= CROWD_GATE.tearPct && web === 0 && long === 0;
    return { garment: gar.name, poke: pokePct, pokeMm: maxD * 1000, tear, web, long, maxEdge, pass };
}

// ── The archetype ────────────────────────────────────────────────────────────────────────────────────────────────
/** One tier's geometry of one pose: positions / normals (stride 3, person-local metres), the vertex CODE (crowd
 *  palette: CC_CODE_SKIN or ccSlotCode(slot)), the body PART (CP_*) per vertex, and the indices GROUPED by part
 *  (`partRanges`: CP_COUNT + 1 starts into `indices`). */
export interface CrowdCharMesh {
    pos: Float32Array; nrm: Float32Array; code: Uint8Array; part: Uint8Array;
    indices: Uint32Array; partRanges: Uint32Array;
    tris: number;
}
export interface CrowdCharPoseBake {
    near: CrowdCharMesh; mid: CrowdCharMesh;
    /** Joint pivots PV_* x xyz (person-local metres). */
    pivots: Float32Array;
}
export interface CrowdArchetype {
    index: number;
    cls: CrowdCharClass;
    names: CrowdCharParams['names'];
    /** Poses that passed the gate. */
    poses: Map<Pose, CrowdCharPoseBake>;
    /** Every gate cell measured ((pose, garment) → metrics), incl. the failing ones. */
    gate: Record<string, GateCell[]>;
    /** Poses dropped by the gate. */
    dropped: Pose[];
    /** Full-resolution triangle count (after the hide mask) and the bake time (ms; reports only — never asserted). */
    fullTris: number;
    /** Full-resolution triangles per vertex code (reports). */
    fullByCode: Record<number, number>;
    bakeMs: number;
}

/** Body part (CP_*) of a body joint name. */
function partOfJoint(name: string): number {
    if (name === 'head' || name === 'neck') return CP_HEAD;
    if (/^(shoulder|lowerarm|hand)_L/.test(name)) return CP_ARML;
    if (/^(shoulder|lowerarm|hand)_R/.test(name)) return CP_ARMR;
    if (/^(upperleg|lowerleg|foot)_L/.test(name)) return CP_LEGL;
    if (/^(upperleg|lowerleg|foot)_R/.test(name)) return CP_LEGR;
    return CP_TORSO;
}

/** One decimation input piece: the triangles of one palette CODE, WELDED (co-located vertices merged, so the
 *  generators' uv seams are not open borders), bind pose, with their skin. Body parts are assigned per triangle
 *  after decimation (poseMesh), so the parts' cuts never become locked borders. */
interface Piece { code: number; /** 1 = the HEAD skin (kept finer: a decimated face goes to a cone) */ sub: number; P: Float32Array; ji: Uint8Array; jw: Float32Array; idx: Uint32Array }
interface Source { verts: Float32Array; idx: ArrayLike<number>; ji: ArrayLike<number>; jw: ArrayLike<number>; triCode: (t: number) => number; triSub?: (t: number) => number; keep?: (t: number) => boolean }

function piecesOf(src: Source, out: Piece[]): void {
    const groups = new Map<number, number[]>();
    for (let t = 0; t < src.idx.length / 3; t++) {
        if (src.keep && !src.keep(t)) continue;
        const key = src.triCode(t) * 4 + (src.triSub ? src.triSub(t) : 0);
        let g = groups.get(key); if (!g) { g = []; groups.set(key, g); } g.push(t);
    }
    for (const [key, tris] of [...groups].sort((a, b) => a[0] - b[0])) {
        const code = key >> 2, sub = key & 3;
        const map = new Map<number, number>(), weld = new Map<string, number>(), P: number[] = [], ji: number[] = [], jw: number[] = [], idx: number[] = [];
        for (const t of tris) {
            const tv = [0, 0, 0];
            for (let k = 0; k < 3; k++) {
                const v = src.idx[t * 3 + k];
                let m = map.get(v);
                if (m === undefined) {
                    const x = src.verts[v * 12], y = src.verts[v * 12 + 1], z = src.verts[v * 12 + 2];
                    const wk = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
                    m = weld.get(wk);
                    if (m === undefined) {
                        m = P.length / 3; weld.set(wk, m);
                        P.push(x, y, z);
                        for (let q = 0; q < 4; q++) { ji.push(src.ji[v * 4 + q]); jw.push(src.jw[v * 4 + q]); }
                    }
                    map.set(v, m);
                }
                tv[k] = m;
            }
            if (tv[0] !== tv[1] && tv[1] !== tv[2] && tv[0] !== tv[2]) idx.push(tv[0], tv[1], tv[2]);
        }
        out.push({ code, sub, P: Float32Array.from(P), ji: Uint8Array.from(ji), jw: Float32Array.from(jw), idx: Uint32Array.from(idx) });
    }
}

/** QEM-decimate every piece at its own ratio; survivors keep their bind position (moved) + the surviving vertex's
 *  skin. Borders are locked (lockBorderVerts), so hems / cuffs / the hidden-body cut keep meeting exactly. */
function decimatePieces(pieces: Piece[], ratioOf: (pc: Piece) => number): Piece[] {
    return pieces.map((pc) => {
        const ratio = ratioOf(pc);
        if (ratio >= 0.999) return pc;
        const n = pc.P.length / 3;
        const pos: V3[] = []; for (let i = 0; i < n; i++) pos.push([pc.P[i * 3], pc.P[i * 3 + 1], pc.P[i * 3 + 2]]);
        const tris: [number, number, number][] = []; for (let t = 0; t < pc.idx.length; t += 3) tris.push([pc.idx[t], pc.idx[t + 1], pc.idx[t + 2]]);
        const r = simplifyMesh(pos, tris, ratio, { lockBorderVerts: true });
        const m = r.positions.length, P = new Float32Array(m * 3), ji = new Uint8Array(m * 4), jw = new Float32Array(m * 4);
        for (let i = 0; i < m; i++) {
            P.set(r.positions[i], i * 3);
            const s = r.src[i];
            ji.set(pc.ji.subarray(s * 4, s * 4 + 4), i * 4); jw.set(pc.jw.subarray(s * 4, s * 4 + 4), i * 4);
        }
        const idx = new Uint32Array(r.tris.length * 3); r.tris.forEach((t, k) => idx.set(t, k * 3));
        return { ...pc, P, ji, jw, idx };
    });
}
const triCount = (ps: Piece[]): number => ps.reduce((s, p) => s + p.idx.length / 3, 0);
/** Relative detail per code: the clothes' silhouette + the hair keep more, the (mostly hidden / small) skin less. */
function detailWeight(code: number): number {
    if (code === ccSlotCode(CC_SLOT_HAIR)) return 1.15;
    if (code === ccSlotCode(CC_SLOT_TOP)) return 2.5;     // (a small mesh: decimating it opens holes at its side seams)
    if (code === ccSlotCode(CC_SLOT_SHOES)) return 0.5;
    if (code === CC_CODE_SKIN || code === ccSlotCode(CC_SLOT_LEGS)) return 0.9;
    return 1;
}
/** Least ratio per code: the thin garment shells (top, skirt) tear open below about half their triangles. */
function detailFloor(pc: Piece): number {
    return pc.code === ccSlotCode(CC_SLOT_TOP) || pc.code === ccSlotCode(CC_SLOT_SKIRT) ? 0.5 : pc.sub === 1 ? 0.4 : 0.02;
}
/** Decimate to at most `budget` triangles: per-piece ratio = k x detailWeight, k refined over a few passes (locked
 *  borders keep some pieces above their ratio). */
function decimateToBudget(pieces: Piece[], budget: number): Piece[] {
    const full = triCount(pieces);
    if (full <= budget) return pieces;
    let k = (budget / full) * 0.97, out = pieces;
    for (let pass = 0; pass < 10; pass++) {
        const kk = k;
        out = decimatePieces(pieces, (pc) => Math.min(1, Math.max(detailFloor(pc), kk * detailWeight(pc.code))));
        const t = triCount(out);
        if (t <= budget) return out;
        k *= (budget / t) * 0.95;
    }
    return out;
}

/** A phone slab (12 tris) bound to hand_R, in bind space: along the hand, a little past the wrist. */
function phonePiece(rig: Rig): Piece | null {
    const j = rig.names.indexOf('hand_R');
    if (j < 0) return null;
    const bind = mat4.invert(mat4.create(), rig.m.inverseBindMatrices.subarray(j * 16, j * 16 + 16) as unknown as mat4);
    if (!bind) return null;
    const hx = bind[12], hy = bind[13], hz = bind[14];
    const dir = Math.sign(rig.m.jointLocalPositions[j * 3]) || -1;   // the hand points along -X (right arm, T-pose bind)
    const c: V3 = [hx + dir * 0.075, hy, hz + 0.02], h: V3 = [0.035, 0.006, 0.065];   // (x along the hand, y palm normal, z across)
    const P: number[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) P.push(c[0] + sx * h[2] * 0.6, c[1] + sy * h[1], c[2] + sz * h[0]);
    // corners: index = (sx>0)*4 + (sy>0)*2 + (sz>0)
    const F: number[][] = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    const idx: number[] = [];
    for (const [a, b, cc, d] of F) idx.push(a, b, cc, a, cc, d);
    const ji = new Uint8Array(32), jw = new Float32Array(32);
    for (let i = 0; i < 8; i++) { ji[i * 4] = j; jw[i * 4] = 1; }
    return { code: CC_CODE_PHONE, sub: 0, P: Float32Array.from(P), ji, jw, idx: Uint32Array.from(idx) };
}

/** Map body space (front = +Z, left = +X) → the mannequin's person frame (+X forward, +Z to the right), scaled. */
interface Frame { s: number; lat: number; y0: number }
function toLocal(F: Frame, x: number, y: number, z: number, out: Float32Array, o: number): void {
    out[o] = z * F.s; out[o + 1] = (y - F.y0) * F.s; out[o + 2] = x * F.lat * F.s;
}

/** Pose the decimated pieces → one CrowdCharMesh: every triangle gets its body part (a skirt = CP_SKIRT, hair =
 *  CP_HEAD, else its first vertex's dominant joint), vertices are split per part (rigid live-crowd groups), and the
 *  indices are grouped by part. */
function poseMesh(pieces: Piece[], buf: Float32Array, F: Frame, names: readonly string[]): CrowdCharMesh {
    const triParts: number[][] = Array.from({ length: CP_COUNT }, () => []);   // flat [piece, tri] pairs per part
    const posed = pieces.map((pc) => skinPos(buf, pc.P, pc.ji, pc.jw, pc.P.length / 3));
    pieces.forEach((pc, pi) => {
        for (let t = 0; t < pc.idx.length / 3; t++) {
            const part = pc.code === CC_CODE_PHONE ? CP_PHONE : pc.code === ccSlotCode(CC_SLOT_SKIRT) ? CP_SKIRT : pc.code === ccSlotCode(CC_SLOT_HAIR) ? CP_HEAD
                : partOfJoint(names[dominant(pc.jw, pc.ji, pc.idx[t * 3])] ?? '');
            triParts[part].push(pi, t);
        }
    });
    const P: number[] = [], C: number[] = [], Pt: number[] = [], I: number[] = [];
    const partRanges = new Uint32Array(CP_COUNT + 1);
    const tmp = new Float32Array(3);
    for (let p = 0; p < CP_COUNT; p++) {
        partRanges[p] = I.length;
        const remap = new Map<number, number>();   // (piece, vertex) → output vertex, per part
        const L = triParts[p];
        for (let k = 0; k < L.length; k += 2) {
            const pi = L[k], t = L[k + 1], pc = pieces[pi];
            for (let c = 0; c < 3; c++) {
                const v = pc.idx[t * 3 + c], key = pi * 1048576 + v;
                let o = remap.get(key);
                if (o === undefined) {
                    o = P.length / 3; remap.set(key, o);
                    toLocal(F, posed[pi][v * 3], posed[pi][v * 3 + 1], posed[pi][v * 3 + 2], tmp, 0);
                    P.push(tmp[0], tmp[1], tmp[2]); C.push(pc.code); Pt.push(p);
                }
                I.push(o);
            }
        }
    }
    partRanges[CP_COUNT] = I.length;
    const pos = Float32Array.from(P), indices = Uint32Array.from(I);
    // the frame map is a proper rotation (det +1 with lat = -1), so the winding is kept
    return { pos, nrm: vertexNormals(pos, indices), code: Uint8Array.from(C), part: Uint8Array.from(Pt), indices, partRanges, tris: indices.length / 3 };
}

/** Bake one archetype (deterministic). `poses` = which crowd poses to try (default: all of CROWD_CHAR_POSES). */
export function bakeCrowdArchetype(params: CrowdCharParams, poses: readonly Pose[] = CROWD_CHAR_POSES, opts: { keepFailed?: boolean; noDecimate?: boolean } = {}): CrowdArchetype {
    const t0 = now();
    const parts = generateCharacterParts({ body: params.body, garments: [params.top, params.bottom, params.shoes] as ClothingParams[], hair: params.hair });
    const body = parts.body, s = body.skinning;
    const names = s.jointNames;
    const rig: Rig = {
        names,
        m: {
            vertices: body.geometry.vertices, stride: 12, posOffset: 0, indices: body.geometry.indices,
            jointIndices: s.jointIndices, jointWeights: s.jointWeights, jointNames: names,
            jointParents: s.jointParents!, jointLocalPositions: s.jointLocalPositions!, inverseBindMatrices: s.inverseBindMatrices,
        },
    };
    const skirt = params.bottom.bottomStyle === 'skirt';
    const bySlot: Partial<Record<LayerSlot, GarmentGenResult>> = {};
    for (const g of parts.garments) bySlot[g.params.slot as LayerSlot] = g.result;
    const layered = layerOutfit(bySlot, (sl) => sl === 'bottom' && skirt, limbSidesFromNames(names)) as Partial<Record<LayerSlot, GarmentGenResult>>;   // limb side mask: no cross-leg binding (the pants-web fix)
    const garments: GarmentIn[] = [];
    for (const [slot, name] of [['top', params.names.top], ['bottom', params.names.bottom], ['shoes', params.names.shoes]] as const) {
        const g = layered[slot] ?? bySlot[slot];
        if (g) garments.push({ name: `${slot}:${name}`, g, bottom: slot === 'bottom' && !skirt });
    }
    // Pose list → rotations
    const poseRots = new Map<Pose, PoseRotations>();
    for (const p of poses) { const r = crowdCharPose(p); if (r) poseRots.set(p, r); }
    // Hide the body under the clothes, verified in the crowd poses.
    const maskBody: MaskSkinned = { verts: body.geometry.vertices, indices: body.geometry.indices, ji: s.jointIndices, jw: s.jointWeights };
    const maskG: MaskSkinned[] = garments.map((g) => ({ verts: g.g.geometry.vertices, indices: g.g.geometry.indices, ji: g.g.jointIndices, jw: g.g.jointWeights }));
    const probe: Record<string, { joint: string; q: [number, number, number, number] }[]> = {};
    for (const [p, r] of poseRots) probe[p] = r.map((e) => ({ joint: e.joint, q: [e.q[0], e.q[1], e.q[2], e.q[3]] }));
    const hide = computePoseVerifiedHideMask(maskBody, body.geometry.indices, maskG,
        { names, parents: s.jointParents!, inverseBind: s.inverseBindMatrices, method: 'dualQuat' }, { poses: probe });
    const bodyRest = pos3Of(body.geometry.vertices), nb = bodyRest.length / 3;
    const bodyVisible = new Uint8Array(nb);
    const bi = body.geometry.indices;
    for (let t = 0; t < bi.length / 3; t++) if (!hide[t]) { bodyVisible[bi[t * 3]] = 1; bodyVisible[bi[t * 3 + 1]] = 1; bodyVisible[bi[t * 3 + 2]] = 1; }

    // GATE every (pose, garment) at full resolution.
    const gate: Record<string, GateCell[]> = {};
    const passed: Pose[] = [], dropped: Pose[] = [];
    const bufs = new Map<Pose, Float32Array>();
    for (const [p, rot] of poseRots) {
        const buf = skinBuffer(rig, rot); bufs.set(p, buf);
        const bodyPosed = skinPos(buf, bodyRest, s.jointIndices, s.jointWeights, nb);
        const cells = garments.map((g) => gateGarment(rig, bodyRest, bi, bodyVisible, g, rot, buf, bodyPosed));
        gate[p] = cells;
        (cells.every((c) => c.pass) ? passed : dropped).push(p);
    }

    // PIECES (bind pose): body (visible tris; skin, or LEGS-slot tights under a skirt), garments, static hair.
    const headIdx = names.indexOf('head');
    const pieces: Piece[] = [];
    const jn = (j: number): string => names[j] ?? '';
    const legJoint = (j: number): boolean => /^(upperleg|lowerleg)_/.test(jn(j));
    piecesOf({
        verts: body.geometry.vertices, idx: bi, ji: s.jointIndices, jw: s.jointWeights, keep: (t) => !hide[t],
        triSub: (t) => partOfJoint(jn(dominant(s.jointWeights, s.jointIndices, bi[t * 3]))) === CP_HEAD ? 1 : 0,
        triCode: (t) => skirt && legJoint(dominant(s.jointWeights, s.jointIndices, bi[t * 3])) ? ccSlotCode(CC_SLOT_LEGS) : CC_CODE_SKIN,
    }, pieces);
    for (const g of garments) {
        const slot = g.name.startsWith('top') ? CC_SLOT_TOP : g.name.startsWith('shoes') ? CC_SLOT_SHOES : skirt ? CC_SLOT_SKIRT : CC_SLOT_LEGS;
        const gi = g.g.geometry.indices;
        piecesOf({
            verts: g.g.geometry.vertices, idx: gi, ji: g.g.jointIndices, jw: g.g.jointWeights,
            triCode: () => ccSlotCode(slot),
        }, pieces);
    }
    if (parts.hair && headIdx >= 0) {
        const hv = parts.hair.result.geometry.vertices, hn = hv.length / 12;
        const ji = new Uint8Array(hn * 4), jw = new Float32Array(hn * 4);
        for (let i = 0; i < hn; i++) { ji[i * 4] = headIdx; jw[i * 4] = 1; }   // STATIC: every vertex rides the head
        piecesOf({ verts: hv, idx: parts.hair.result.geometry.indices, ji, jw, triCode: () => ccSlotCode(CC_SLOT_HAIR) }, pieces);
    }
    const fullTris = triCount(pieces);
    const fullByCode: Record<number, number> = {};
    for (const pc of pieces) fullByCode[pc.code] = (fullByCode[pc.code] ?? 0) + pc.idx.length / 3;
    const PHONE_TRIS = 12;   // (added in the phone pose after decimation)
    const near = opts.noDecimate ? pieces : decimateToBudget(pieces, CROWD_CHAR_BUDGET.near - PHONE_TRIS);
    const mid = opts.noDecimate ? pieces : decimateToBudget(pieces, CROWD_CHAR_BUDGET.mid - PHONE_TRIS);

    // FRAME: feet on the ground in the stand pose, the body scaled to a canonical 1.70 m, left → -Z.
    const standBuf = bufs.get('stand') ?? skinBuffer(rig, crowdCharPose('stand')!);
    const standBody = skinPos(standBuf, bodyRest, s.jointIndices, s.jointWeights, nb);
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < nb; i++) { const y = standBody[i * 3 + 1]; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const shL = names.indexOf('shoulder_L');
    const lat = shL >= 0 && s.jointLocalPositions![shL * 3] < 0 ? 1 : -1;   // the body's left is +X → mannequin -Z
    const F: Frame = { s: 1.7 / Math.max(0.5, y1 - y0), lat, y0 };

    // The phone prop (the 'phone' pose): a small slab in the right palm, rigid on hand_R (bind space).
    const phone = phonePiece(rig);
    const out = new Map<Pose, CrowdCharPoseBake>();
    for (const p of opts.keepFailed ? [...poseRots.keys()] : passed) {   // keepFailed: diagnostics only (reports)
        const buf = bufs.get(p)!;
        const world = posedJointWorld(rig.m, poseRots.get(p)!);
        const pivots = new Float32Array(PV_COUNT * 3);
        const put = (pv: number, joint: string): void => { const j = names.indexOf(joint); if (j >= 0) { const w = world[j]; toLocal(F, w[12], w[13], w[14], pivots, pv * 3); } };
        put(PV_UPPER, 'hips'); put(PV_HEAD, 'neck'); put(PV_ARML, 'shoulder_L'); put(PV_ARMR, 'shoulder_R'); put(PV_LEGL, 'upperleg_L'); put(PV_LEGR, 'upperleg_R');
        const extra = p === 'phone' && phone ? [phone] : [];
        out.set(p, { near: poseMesh([...near, ...extra], buf, F, names), mid: poseMesh([...mid, ...extra], buf, F, names), pivots });
    }
    return { index: params.index, cls: params.cls, names: params.names, poses: out, gate, dropped, fullTris, fullByCode, bakeMs: now() - t0 };
}
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── The session cache + the person → archetype match ─────────────────────────────────────────────────────────────
const _cache = new Map<number, CrowdArchetype>();
/** The baked archetype `i` (baked on first use, cached for the session: the bake is deterministic per index). */
export function crowdArchetype(i: number): CrowdArchetype {
    let a = _cache.get(i);
    if (!a) { a = bakeCrowdArchetype(crowdCharacterParams(i)); _cache.set(i, a); }
    return a;
}
/** Tests: forget the baked archetypes. */
export function clearCrowdArchetypeCache(): void { _cache.clear(); }
/** Whether archetype i is already baked (no bake triggered). */
export function crowdArchetypeBaked(i: number): boolean { return _cache.has(i); }

/** The archetype a person of this class would PREFER (a seeded pick among the archetypes of the same class), or -1
 *  when no archetype has the class. Cheap: no bake. The emitter falls back along `crowdArchetypeCandidates`. */
export function crowdArchetypeFor(cls: CrowdCharClass, seed: number, count = CROWD_CHAR_COUNT): number {
    const c = crowdArchetypeCandidates(cls, seed, count);
    return c.length ? c[0] : -1;
}
/** Every archetype of the class, starting at the seeded preference (the fallback order when a pose was dropped). */
export function crowdArchetypeCandidates(cls: CrowdCharClass, seed: number, count = CROWD_CHAR_COUNT): number[] {
    if (!cls.skirt && CROWD_TROUSERS_BLOCKED) return [];
    const same: number[] = [];
    for (let i = 0; i < count; i++) {
        const k = crowdCharClassOf(i);
        if (k.skirt === cls.skirt && k.fem === cls.fem && k.longHair === cls.longHair) same.push(i);
    }
    if (!same.length) return [];
    const s0 = Math.floor((((seed % 1) + 1) % 1) * same.length) % same.length;
    return [...same.slice(s0), ...same.slice(0, s0)];
}
