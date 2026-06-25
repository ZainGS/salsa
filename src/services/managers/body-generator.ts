/**
 * Procedural base-body generator (PROTOTYPE).
 *
 * Builds a low-poly humanoid as tapered tubes + capped blobs around a small humanoid
 * skeleton, auto-weighted (each ring blends between its two end joints) and auto-UV'd
 * (each part = a cylindrical island). Output is a `GltfSkinnedResult` so it drops straight
 * into the same path the kitbash assembler uses (`_createSkeletonFromResult` +
 * `_createSkinnedMeshForSlot`).
 *
 * This is the v1 proof: overlapping capsules around a rig → a recognizable, posable doll
 * body with free UV + free weights. Topology welding, finger/toe detail, packed UV atlas,
 * and the canonical 26-joint hierarchy are refinements (see docs/specs/character-creation-pipeline.md).
 */

import type { GltfSkinnedResult, GltfSkinningData } from '../../renderer/3d/gltf-importer';
import type { MeshGeometry } from '../../renderer/3d/mesh-generators';

export interface BodyParams {
  /** Overall height multiplier (1 ≈ ~1.5 world units tall). */
  height: number;
  /** Limb thickness multiplier. */
  limbThick: number;
  /** Torso thickness multiplier. */
  torsoThick: number;
  /** Head size multiplier. */
  headSize: number;
  /** Leg-length multiplier (doll proportions → >1 for long legs). */
  legLength: number;
  /** Torso-length multiplier — scales the spine/chest/neck segments (compact torso → <1 for the
   *  leggy dollcore silhouette). Raises the shoulders/arms/head; hips + legs stay put. */
  torsoLength: number;
  /** Bust fullness — pushes the chest ring's FRONT forward (1 = flat/neutral, >1 = fuller bust). */
  bust: number;
  /** Waist width — scales the mid-torso ring (1 = neutral, <1 = cinched, >1 = fuller). */
  waist: number;
  /** Hip/pelvis width — SIDE-TO-SIDE only (1 = neutral, >1 = wider hips). Independent of the front. */
  hipWidth: number;
  /** Hip/pelvis FRONT projection — the lower-belly/front depth, INDEPENDENT of width (1 = neutral). So a
   *  body can have wide hips without a protruding front (or a deep front without wide hips). */
  hipFront: number;
  /** Shoulder width — scales the shoulder-band rings (1 = neutral, >1 = broader shoulders). */
  shoulderWidth: number;
}

// Defaults lean DOLLCORE out of the box: long thin legs, slim limbs, a smaller torso, and a
// slightly oversized head — the silhouette IS the brand. Sliders let users dial back to neutral.
// The localized shape params (bust/waist/hipWidth/shoulderWidth) default to 1 (neutral) so existing
// bodies are unchanged.
export const DEFAULT_BODY_PARAMS: BodyParams = {
  height: 1, limbThick: 0.85, torsoThick: 0.9, headSize: 1.25, legLength: 1.4, torsoLength: 1,
  bust: 1, waist: 1, hipWidth: 1, hipFront: 1, shoulderWidth: 1,
};

type V3 = [number, number, number];

// ── Arm surface handed to the clothing generator ──
// So a sleeve can be built as the ACTUAL arm surface offset OUTWARD (it then truly follows the
// shoulder/deltoid/armpit — it IS the shoulder, offset), instead of an idealized tube. One ring per arm
// section (collar=socket/armhole shape → deltoid → upper → elbow → wrist), index-corresponding (band k→k).
export interface ArmRingVert { p: V3; n: V3; j0: number; w0: number; j1: number; w1: number; } // p = world pos, n = outward (radial) normal
export interface ArmRing { verts: ArmRingVert[]; center: V3; }
export interface ArmSurface { L: ArmRing[]; R: ArmRing[]; }

// ── Rest skeleton (local positions relative to parent; identity rotation, unit scale) ──
interface JointDef { name: string; parent: number; pos: V3; }
const JOINTS: JointDef[] = [
  { name: 'hips',        parent: -1, pos: [0,  0.90, 0] },   // 0
  { name: 'spine',       parent:  0, pos: [0,  0.12, 0] },   // 1
  { name: 'chest',       parent:  1, pos: [0,  0.18, 0] },   // 2
  { name: 'neck',        parent:  2, pos: [0,  0.16, 0] },   // 3
  { name: 'head',        parent:  3, pos: [0,  0.10, 0] },   // 4
  // Clavicles bridge chest-centre → up+out → shoulder, so the shoulder no longer bolts straight onto
  // the chest side (rounder collar + proper shoulder lift when arms raise). The shoulder's WORLD
  // position is unchanged (clavicle + shoulder offsets sum to the old [±0.075, 0.075]) — arms don't move.
  { name: 'clavicle_L',  parent:  2, pos: [ 0.03,  0.06,  0] }, // 5
  { name: 'shoulder_L',  parent:  5, pos: [ 0.045, 0.015, 0] }, // 6 (clavicle → shoulder)
  { name: 'lowerarm_L',  parent:  6, pos: [ 0.27,  0,     0] }, // 7 (upper arm spans 6→7)
  { name: 'hand_L',      parent:  7, pos: [ 0.23,  0,     0] }, // 8 (forearm spans 7→8)
  { name: 'clavicle_R',  parent:  2, pos: [-0.03,  0.06,  0] }, // 9
  { name: 'shoulder_R',  parent:  9, pos: [-0.045, 0.015, 0] }, // 10
  { name: 'lowerarm_R',  parent: 10, pos: [-0.27,  0,     0] }, // 11
  { name: 'hand_R',      parent: 11, pos: [-0.23,  0,     0] }, // 12
  { name: 'upperleg_L',  parent:  0, pos: [ 0.045, -0.14, 0] }, // 13 — legs brought CLOSER (was ±0.055); lowerleg/foot hang straight down, so the whole leg moves in
  { name: 'lowerleg_L',  parent: 13, pos: [0, -0.42, 0] },    // 14
  { name: 'foot_L',      parent: 14, pos: [0, -0.42, 0] },    // 15
  { name: 'upperleg_R',  parent:  0, pos: [-0.045, -0.14, 0] }, // 16 — legs brought CLOSER (was ±0.055)
  { name: 'lowerleg_R',  parent: 16, pos: [0, -0.42, 0] },    // 17
  { name: 'foot_R',      parent: 17, pos: [0, -0.42, 0] },    // 18
];
const NAME_TO_IDX = new Map(JOINTS.map((j, i) => [j.name, i]));

// Tubes: a tapered cylinder from joint a→b, ring weights blend a→b. Radii are pre-scale.
interface Bone { a: string; b: string; r0: number; r1: number; kind: 'torso' | 'limb' | 'neck'; }
// The whole body (torso, arms, head, legs) is built as one stitched surface (addStitchedBody), so
// there are no standalone tube BONES anymore. Kept as an (empty) extension point for extra tubes.
const BONES: Bone[] = [];
// Capped blobs weighted 100% to one joint.
interface Blob { at: string; r: number; kind: 'head' | 'limb' | 'torso'; }
// Head, pelvis, hands AND feet are now built as real geometry (addStitchedBody / buildHand /
// buildFoot), so no capped blobs remain.
const BLOBS: Blob[] = [];

const RING = 24; // 24-gon cross-section — smooth round butt cheeks (6 cols/cheek, peak on col 15=225°), smoother hips/legs/chest/face
// Directional columns on a ring (frame u=+X, v=+Z), derived from RING so the shaping is resolution-agnostic.
// RING MUST be divisible by 4 so a vertex lands exactly on each cardinal direction (+Z front, −X side, −Z back):
const COL_F  = Math.round(RING / 4);       // +Z FRONT-centre column  (8→2, 12→3, 16→4, 24→6)
const COL_B  = Math.round(RING * 3 / 4);   // −Z BACK-centre column   (8→6, 12→9, 16→12, 24→18)
const COL_NX = Math.round(RING / 2);       // −X side column (right-arm socket base) (8→4, 12→6, 16→8, 24→12)

// ── tiny vec3 helpers ──
const sub = (a: V3, b: V3): V3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const add = (a: V3, b: V3): V3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const scl = (a: V3, s: number): V3 => [a[0]*s, a[1]*s, a[2]*s];
const cross = (a: V3, b: V3): V3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };

interface Accum {
  pos: number[]; nrm: number[]; uv: number[];
  j0: number[]; w0: number[]; j1: number[]; w1: number[];
  idx: number[]; count: number;
  /** Current UV island rect [u0,v0,u1,v1] in atlas space. pushVert maps each part's local (0..1) UV into it. */
  island: [number, number, number, number];
}
function pushVert(ac: Accum, p: V3, n: V3, u: number, v: number, ja: number, wa: number, jb: number, wb: number): void {
  const I = ac.island;
  ac.pos.push(p[0], p[1], p[2]); ac.nrm.push(n[0], n[1], n[2]);
  ac.uv.push(I[0] + u * (I[2] - I[0]), I[1] + v * (I[3] - I[1]));  // local uv → this part's island sub-rect
  ac.j0.push(ja); ac.w0.push(wa); ac.j1.push(jb); ac.w1.push(wb); ac.count++;
}

/**
 * Weld coincident vertices (position-keyed). In the straight rest pose, adjacent limb-segment
 * tubes share an exact ring at each joint (same center, radius, and frame), so this fuses each
 * arm/leg into ONE continuous tube — connected topology, for free, with no risk. Keeps the first
 * occurrence's normal/uv/weights and remaps the index buffer; drops triangles that collapse.
 * (Limb↔torso shoulders/hips and the cap spheres still overlap — that's the "pass 2" stitch.)
 */
function weldAccum(ac: Accum, eps = 1e-4): Accum {
  const q = (x: number) => Math.round(x / eps);
  const map = new Map<string, number>();
  const remap = new Int32Array(ac.count);
  const out: Accum = { pos: [], nrm: [], uv: [], j0: [], w0: [], j1: [], w1: [], idx: [], count: 0, island: [0, 0, 1, 1] };
  for (let i = 0; i < ac.count; i++) {
    const key = `${q(ac.pos[i*3])},${q(ac.pos[i*3+1])},${q(ac.pos[i*3+2])}`;
    let ni = map.get(key);
    if (ni === undefined) {
      ni = out.count++;
      map.set(key, ni);
      out.pos.push(ac.pos[i*3], ac.pos[i*3+1], ac.pos[i*3+2]);
      out.nrm.push(ac.nrm[i*3], ac.nrm[i*3+1], ac.nrm[i*3+2]);
      out.uv.push(ac.uv[i*2], ac.uv[i*2+1]);
      out.j0.push(ac.j0[i]); out.w0.push(ac.w0[i]); out.j1.push(ac.j1[i]); out.w1.push(ac.w1[i]);
    }
    remap[i] = ni;
  }
  for (let i = 0; i < ac.idx.length; i += 3) {
    const a = remap[ac.idx[i]], b = remap[ac.idx[i+1]], c = remap[ac.idx[i+2]];
    if (a !== b && b !== c && a !== c) out.idx.push(a, b, c); // skip collapsed tris
  }
  return out;
}

function addTube(ac: Accum, p0: V3, p1: V3, r0: number, r1: number, ja: number, jb: number): void {
  const axis = norm(sub(p1, p0));
  const up: V3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(up, axis));
  const v = cross(axis, u); // (u, v, axis) right-handed
  const SEG = 2;
  const ringBase: number[] = [];
  for (let s = 0; s <= SEG; s++) {
    const t = s / SEG;
    const center = add(p0, scl(sub(p1, p0), t));
    const r = r0 + (r1 - r0) * t;
    ringBase.push(ac.count);
    for (let k = 0; k < RING; k++) {
      const ang = (k / RING) * Math.PI * 2;
      const dir = add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
      pushVert(ac, add(center, scl(dir, r)), dir, k / RING, t, ja, 1 - t, jb, t);
    }
  }
  for (let s = 0; s < SEG; s++) {
    const a = ringBase[s], b = ringBase[s + 1];
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      ac.idx.push(a + k, a + k2, b + k2);    // outward-facing (CCW from outside, frontFace 'ccw')
      ac.idx.push(a + k, b + k2, b + k);
    }
  }
}

// ── helpers for the stitched (connected) body ──────────────────────────────────
function perpFrame(axis: V3): { u: V3; v: V3 } {
  const a = norm(axis);
  const up: V3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(up, a));
  return { u, v: cross(a, u) };
}
/** Emit one ring of RING verts around `center` in the (u,v) plane; returns their vertex indices. */
function addRing(ac: Accum, center: V3, u: V3, v: V3, r: number, joint: number, uvV: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < RING; k++) {
    const ang = (k / RING) * Math.PI * 2;
    const dir = add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)));
    out.push(ac.count);
    pushVert(ac, add(center, scl(dir, r)), dir, k / RING, uvV, joint, 1, 0, 0);
  }
  return out;
}
/** Quad band between two equal-length rings (1:1 by index), outward winding. */
function bandRings(ac: Accum, a: number[], b: number[]): void {
  for (let k = 0; k < a.length; k++) {
    const k2 = (k + 1) % a.length;
    ac.idx.push(a[k], a[k2], b[k2]);
    ac.idx.push(a[k], b[k2], b[k]);
  }
}
// Wrap a UV coord into [0,1). The limb rings sweep an UNwrapped angle (loopAngs[0] + i/N·2π), so the
// raw u can run past 1 and spill a limb's verts OUT of its UV island into a neighbour's — which made
// painting an arm/leg land on the wrong part. Wrapping keeps every vert inside its own island (one
// clean vertical seam per tube, the normal cylinder-UV tradeoff). The torso uses k/RING so it was fine.
const wrap01 = (x: number): number => x - Math.floor(x);

/**
 * Stitch a limb onto an opening loop, GAP-FREE. The loop MUST already be a single cycle in
 * hole-BOUNDARY order (the order its edges run around the opening). For each segment we build a
 * ring whose vert i sits at loop[i]'s angular direction around the limb axis (u,v), then
 * prism-bridge loop→ring0→ring1→… by index. Bridging in boundary order is what actually seals the
 * hole: each loop[i]→loop[i+1] edge (a free edge of the torso opening) becomes a collar quad edge,
 * so it's shared by exactly two faces. (Sorting the loop by angle — the previous bug — reorders the
 * verts away from boundary order, so the real free edges never get sealed → holes.)
 */
function stitchLimb(ac: Accum, loop: number[], u: V3, v: V3, segs: { c: V3; r: number; j: number; uv: number; j2?: number; w2?: number }[]): { first: number[]; last: number[]; rings: number[][] } {
  const N = loop.length;
  let lc: V3 = [0, 0, 0];
  for (const vi of loop) lc = [lc[0]+ac.pos[vi*3], lc[1]+ac.pos[vi*3+1], lc[2]+ac.pos[vi*3+2]];
  lc = scl(lc, 1/N);
  const loopAngs = loop.map(vi => {
    const dx = ac.pos[vi*3]-lc[0], dy = ac.pos[vi*3+1]-lc[1], dz = ac.pos[vi*3+2]-lc[2];
    return Math.atan2(dx*v[0]+dy*v[1]+dz*v[2], dx*u[0]+dy*u[1]+dz*u[2]);
  });
  // Winding direction of the loop, then EVEN angles in that same order. Every limb ring is a
  // regular polygon (no spikes inherited from the irregular socket); the first morph band still
  // bridges the loop in boundary order, so the socket stays gap-free.
  let wind = 0;
  for (let i = 0; i < N; i++) {
    let d = loopAngs[(i+1)%N] - loopAngs[i];
    if (d > Math.PI) d -= 2*Math.PI; else if (d < -Math.PI) d += 2*Math.PI;
    wind += d;
  }
  const dir = wind >= 0 ? 1 : -1;
  const evenAngs = loop.map((_, i) => loopAngs[0] + dir * (i / N) * 2 * Math.PI);
  let prev = loop;
  let first: number[] = loop;
  const allRings: number[][] = [];
  segs.forEach((seg, si) => {
    let r: number[];
    if (si === 0) {
      // FIRST ring = a PARALLEL EXTRUSION of the opening loop (a translated copy) to seg.c. It
      // matches the socket/pants shape EXACTLY — so the bridge seals with no fold (no holes) and
      // cannot poke past a SHORT socket (that poke is the armpit-spike bug). The arm/leg then morphs
      // to clean even circles from the next ring on.
      const off = sub(seg.c, lc);
      r = loop.map((vi, idx) => {
        // RADIAL normal around the limb axis (NOT the copied socket normal, which points sideways and
        // makes the later smooth-normal orientation flip inward → dark shading on the arms).
        const rad = add(scl(u, Math.cos(loopAngs[idx])), scl(v, Math.sin(loopAngs[idx])));
        const i = ac.count;
        pushVert(ac,
          [ac.pos[vi*3]+off[0], ac.pos[vi*3+1]+off[1], ac.pos[vi*3+2]+off[2]],
          rad,
          wrap01((loopAngs[idx]/(Math.PI*2))+0.5), seg.uv, seg.j, 1-(seg.w2??0), seg.j2??0, seg.w2??0);
        return i;
      });
    } else {
      r = evenAngs.map(a => {
        const d = add(scl(u, Math.cos(a)), scl(v, Math.sin(a)));
        const i = ac.count;
        pushVert(ac, add(seg.c, scl(d, seg.r)), d, wrap01((a/(Math.PI*2))+0.5), seg.uv, seg.j, 1-(seg.w2??0), seg.j2??0, seg.w2??0);
        return i;
      });
    }
    bandRings(ac, prev, r);
    if (si === 0) first = r;
    allRings.push(r);
    prev = r;
  });
  return { first, last: prev, rings: allRings }; // last = wrist/ankle; first = root ring (to close the crotch); rings = every seg ring (for the sleeve offset-surface)
}

/** A small tapered, capped tube — one finger or toe. */
// A finger/toe: 4 tapering rings ending in a ROUNDED dome (not a spike), with an optional `curl`
// (world-space) that bends the digit quadratically toward the tip so a hand can relax instead of
// splaying rigidly straight. curl = [0,0,0] → a straight digit (thumb/toes).
function buildDigit(ac: Accum, base: V3, dir: V3, len: number, r0: number, joint: number, curl: V3 = [0, 0, 0]): void {
  const d = norm(dir);
  const { u, v } = perpFrame(d);
  const at = (t: number): V3 => add(add(base, scl(d, len * t)), scl(curl, len * t * t));
  const r1 = addRing(ac, at(0),    u, v, r0,        joint, 0);
  const r2 = addRing(ac, at(0.5),  u, v, r0 * 0.86, joint, 0.45);
  const r3 = addRing(ac, at(0.82), u, v, r0 * 0.66, joint, 0.78);
  const r4 = addRing(ac, at(1.0),  u, v, r0 * 0.46, joint, 1);     // small tip ring → the cap reads as a dome
  bandRings(ac, r1, r2); bandRings(ac, r2, r3); bandRings(ac, r3, r4);
  // Dome apex only r0*0.30 past the tip ring (was 0.60 past a wider ring) → a rounded pad, not a point.
  capRing(ac, r4, add(at(1.0), scl(d, r0 * 0.30)), joint);
}

/** One ring of RING verts with ELLIPTICAL radii (rU along u, rV along v) — for flat palms/soles. */
function addRingE(ac: Accum, center: V3, u: V3, v: V3, rU: number, rV: number, joint: number, uvV: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < RING; k++) {
    const a = (k / RING) * Math.PI * 2;
    const off = add(scl(u, rU * Math.cos(a)), scl(v, rV * Math.sin(a)));
    out.push(ac.count);
    pushVert(ac, add(center, off), norm(off), k / RING, uvV, joint, 1, 0, 0);
  }
  return out;
}

/** Hand off the wrist ring: a flattened palm (stitched to the wrist) + 4 fingers + a thumb.
 *  Everything weighted to the hand joint. dir = arm direction; u/v = arm perp frame (u across the
 *  palm, v = palm thickness). */
function buildHand(ac: Accum, wrist: number[], wc: V3, u: V3, v: V3, dir: V3, joint: number, lt: number): void {
  // derive the wrist ring's own angles so the palm bridges to it without twisting
  const angs = wrist.map(vi => {
    const dx = ac.pos[vi*3]-wc[0], dy = ac.pos[vi*3+1]-wc[1], dz = ac.pos[vi*3+2]-wc[2];
    return Math.atan2(dx*v[0]+dy*v[1]+dz*v[2], dx*u[0]+dy*u[1]+dz*u[2]);
  });
  const palmRing = (c: V3, rU: number, rV: number, uvV: number): number[] =>
    angs.map(a => {
      const off = add(scl(u, rU*Math.cos(a)), scl(v, rV*Math.sin(a)));
      const i = ac.count; pushVert(ac, add(c, off), norm(off), (a/(Math.PI*2))+0.5, uvV, joint, 1, 0, 0); return i;
    });
  const palm1 = palmRing(add(wc, scl(dir, 0.020)), 0.052*lt, 0.024*lt, 0.3); // wrist flattens into the palm
  const palm2 = palmRing(add(wc, scl(dir, 0.050)), 0.056*lt, 0.019*lt, 0.6); // knuckles (wide + thin)
  bandRings(ac, wrist, palm1); bandRings(ac, palm1, palm2);
  capRing(ac, palm2, add(wc, scl(dir, 0.058)), joint); // close the knuckle front (fingers overlap it)
  // 4 fingers across the knuckle (middle longest), extending along the arm with a gentle relaxed curl
  // (droop DOWN + slightly forward) so the hand reads as relaxed, not a rigid splayed starfish.
  const knuckle = add(wc, scl(dir, 0.052));
  const spread = [-0.036, -0.012, 0.012, 0.036];
  const length = [0.050, 0.064, 0.060, 0.046];
  const curlF  = [0.95, 1.0, 1.0, 1.08];           // outer fingers curl a touch more (natural)
  const fingerCurl: V3 = [0, -0.38, 0.12];          // world-space: down + slightly forward
  for (let k = 0; k < 4; k++)
    buildDigit(ac, add(knuckle, scl(u, spread[k]*lt)), dir, length[k]*lt, 0.011*lt, joint, scl(fingerCurl, curlF[k]));
  // thumb — lower on the palm, angled out + FORWARD. Anchored to world +Z so both hands' thumbs
  // point forward (u flips sign between the left/right arm, which would mirror the thumb wrongly).
  const fwd: V3 = [0, 0, 1];
  // base slid FORWARD along the hand (dir 0.010 → 0.040, near the knuckle at 0.052) so the thumb sits much
  // closer to the other fingers instead of way back at the wrist.
  buildDigit(ac, add(add(wc, scl(dir, 0.040)), scl(fwd, 0.040*lt)), norm(add(scl(dir, 0.6), scl(fwd, 0.8))), 0.044*lt, 0.013*lt, joint, [0, -0.20, 0.05]);
}

/** Foot off the ankle: a flattened sole extending forward (+Z) + 5 toes (big toe on the inner side,
 *  set by `inner` = the inward X sign). Overlaps the ankle (which the leg caps); weighted to foot. */
function buildFoot(ac: Accum, ft: V3, joint: number, lt: number, inner: number): void {
  const W: V3 = [1, 0, 0], Hg: V3 = [0, 1, 0]; // ring in the X-Y plane (around +Z forward)
  const drop = 0.050 * lt;
  const sec = (z: number, rX: number, rY: number): number[] =>
    addRingE(ac, [ft[0], ft[1] - drop + rY*lt, ft[2] + z*lt], W, Hg, rX*lt, rY*lt, joint, (z+0.035)/0.16);
  const heel = sec(-0.030, 0.030, 0.030);
  const arch = sec( 0.020, 0.038, 0.026);
  const ball = sec( 0.075, 0.042, 0.020);
  const toeB = sec( 0.110, 0.038, 0.016);
  bandRings(ac, heel, arch); bandRings(ac, arch, ball); bandRings(ac, ball, toeB);
  capRing(ac, heel, [ft[0], ft[1]-drop+0.030*lt, ft[2]-0.054*lt], joint); // heel (back)
  capRing(ac, toeB, [ft[0], ft[1]-drop+0.016*lt, ft[2]+0.124*lt], joint); // toe front (toes overlap)
  // 5 toes, inner→outer: big toe biggest
  const off = [0.030, 0.015, 0.000, -0.015, -0.029]; // X offset, inner first
  const tr  = [0.013, 0.0115, 0.0105, 0.0095, 0.0085]; // radius (big toe widest)
  const tl  = [0.030, 0.028, 0.025, 0.021, 0.017];     // length
  for (let k = 0; k < 5; k++)
    buildDigit(ac, [ft[0] + inner*off[k]*lt, ft[1]-drop+0.014*lt, ft[2]+0.108*lt], [0, 0, 1], tl[k]*lt, tr[k]*lt, joint);
}

/** Close a ring loop with a triangle fan to an apex vertex (e.g. the top of the head). */
function capRing(ac: Accum, loop: number[], apex: V3, joint: number): void {
  let c: V3 = [0, 0, 0];
  for (const vi of loop) c = [c[0]+ac.pos[vi*3], c[1]+ac.pos[vi*3+1], c[2]+ac.pos[vi*3+2]];
  c = scl(c, 1/loop.length);
  const ai = ac.count;
  pushVert(ac, apex, norm(sub(apex, c)), 0.5, 1, joint, 1, 0, 0);
  for (let k = 0; k < loop.length; k++) ac.idx.push(loop[k], loop[(k+1)%loop.length], ai);
}

/**
 * Build the WHOLE body as one connected surface (weld pass 2b). A vertical RING-sided torso tube;
 * ARMS bridge out of an open socket on each side via a WIDE deltoid ring that fills the socket then
 * tapers down the arm (defined shoulders, no funnel/gaps); the HEAD continues up from the neck ring
 * as capped rings; the LEGS split out of the pelvis-bottom ring (pants topology) sharing crotch
 * verts. Hands/feet stay as cap blobs. Everything is angle-bridged so collars don't twist.
 */
function addStitchedBody(ac: Accum, wp: V3[], p: BodyParams, H: number, armSurface?: ArmSurface): void {
  const J = (n: string) => NAME_TO_IDX.get(n)!;
  const tt = p.torsoThick * H, lt = p.limbThick * H, hs = p.headSize * H;
  const chest = wp[J('chest')], hips = wp[J('hips')], neck = wp[J('neck')], head = wp[J('head')];
  const lerp = (a: V3, b: V3, t: number): V3 => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
  const yAt = (c: V3, dy: number): V3 => [c[0], c[1] + dy*H, c[2]];

  // ── torso rings bottom→top. Frame u=+X (col 0 = LEFT arm), v=+Z (col 2 = front, col 4 = RIGHT) ──
  // Localized shape multipliers (default 1 = neutral): hips scale the pelvis rings, waist the mid-torso,
  // shoulderWidth the shoulder band; bust is a FRONT push applied after the ring is built (below).
  const fu: V3 = [1, 0, 0], fv: V3 = [0, 0, 1];
  const waistMul = p.waist ?? 1, hipW = p.hipWidth ?? 1, hipF = p.hipFront ?? 1, shMul = p.shoulderWidth ?? 1;
  const rdefs: { c: V3; r: number; j: number }[] = [
    { c: yAt(hips, -0.12),         r: 0.128*tt, j: J('hips')  }, // 0 pelvisBot — legs split here (hip width/front applied per-axis below, ring 0 partly)
    { c: yAt(hips, -0.09),         r: 0.129*tt, j: J('hips')  }, // 1 lower-cheek (NEW) — extra butt vertical resolution → a rounded DOME not a ridge
    { c: yAt(hips, -0.06),         r: 0.130*tt, j: J('hips')  }, // 2 pelvisMid — FULL (hips + buttocks); the cheek PEAK
    { c: yAt(hips, -0.03),         r: 0.132*tt, j: J('hips')  }, // 3 upper-cheek (NEW) — extra butt vertical resolution
    { c: hips,                     r: 0.134*tt, j: J('hips')  }, // 4 hips — widest
    { c: lerp(chest, hips, 0.46),  r: 0.100*tt * waistMul, j: J('chest') }, // 5 waist — PINCHED for the hourglass (front + sides); the lumbar shaping below curves the back in
    { c: chest,                    r: 0.115*tt, j: J('chest') }, // 6 chest ← arm socket BOTTOM (bust = front push, below)
    { c: lerp(chest, neck, 0.25),  r: 0.106*tt * shMul, j: J('chest') }, // 7 shoulder ← socket CENTER (up + in) — broader
    { c: lerp(chest, neck, 0.45),  r: 0.092*tt * shMul, j: J('chest') }, // 8 shoulderTop ← socket TOP — FULLER (the trapezius slope, was 0.076)
    { c: lerp(chest, neck, 0.66),  r: 0.070*tt, j: J('neck')  }, // 9 lowerNeck — FULLER neck base (traps rise into it; was 0.054 = thin/long-looking)
    { c: neck,                     r: 0.052*tt, j: J('neck')  }, // 10 neck — head above
  ];
  const NR = rdefs.length;

  // ── UV islands ──
  // Old UVs stacked EVERY part on the full 0–1 square → total overlap (painting a spot hit several
  // parts at once). Give each part its own non-overlapping sub-rect of the atlas; pushVert maps each
  // part's local (0..1) tube-unwrap into ac.island. Hands ride the arm island and feet ride the leg
  // island, so wrists/ankles stay seamless. (Part-boundary bridge rings — shoulder/hip/neck — span
  // two islands and so stretch a little in UV space; that's the normal UV-seam tradeoff.)
  const IS = {
    torso: [0.02, 0.52, 0.62, 0.98] as [number, number, number, number],
    head:  [0.64, 0.52, 0.99, 0.98] as [number, number, number, number],
    armL:  [0.02, 0.02, 0.25, 0.48] as [number, number, number, number],
    armR:  [0.27, 0.02, 0.50, 0.48] as [number, number, number, number],
    legL:  [0.52, 0.02, 0.75, 0.48] as [number, number, number, number],
    legR:  [0.77, 0.02, 0.99, 0.48] as [number, number, number, number],
  };

  ac.island = IS.torso;
  const ring: number[][] = rdefs.map((rd, ri) => addRing(ac, rd.c, fu, fv, rd.r, rd.j, ri/(NR-1)));

  // Hip shaping — width (X, side-to-side) and front projection (+Z, the lower belly) are INDEPENDENT, so a
  // body can have wide hips WITHOUT a protruding front (or vice-versa). Ring 0 (the leg-split ring) scales
  // partially so the leg junction stays clean. The BACK (−Z, the butt) is left to the sculpt below.
  if (Math.abs(hipW - 1) > 1e-3 || Math.abs(hipF - 1) > 1e-3) {
    for (const [ri, f] of [[0, 0.4], [1, 0.7], [2, 1], [3, 1], [4, 1]] as const) {   // pelvisBot..hips (ring 0 partial → clean leg junction)
      for (const vi of ring[ri]) {
        ac.pos[vi*3]     *= 1 + (hipW - 1) * f;                              // X — width (both sides)
        if (ac.pos[vi*3 + 2] > 0) ac.pos[vi*3 + 2] *= 1 + (hipF - 1) * f;    // +Z — front projection only
      }
    }
  }

  // ── Feminine silhouette sculpt. PURE rest-pose surface shaping (offsets vertices; the skeleton stays
  //    straight, so posing is unaffected). Side profile = an S-curve: bust forward · waist + lumbar in ·
  //    butt back. Column sets defined below (cFront/cBack/cCheek). dz = front(+)/back(−), dy = up(+)/down(−). ──
  const sculpt = (ri: number, cols: readonly (readonly [number, number])[], dz: number, dy = 0): void => {
    for (const [col, f] of cols) {
      const vi = ring[ri][col];
      ac.pos[vi*3 + 1] += dy * f * tt;
      ac.pos[vi*3 + 2] += dz * f * tt;
    }
  };
  // Column sets (RING=24, frame u=+X v=+Z): 0=+X side · 6=+Z FRONT · 12=−X side · 18=−Z BACK.
  const cFront = [[5, 0.6], [6, 1], [7, 0.6], [4, 0.2], [8, 0.2]] as const;   // front hemisphere (bust / belly) around col 6
  const cBack  = [[17, 0.85], [18, 0.72], [19, 0.85], [16, 0.4], [20, 0.4]] as const; // back hemisphere (lumbar) around col 18
  // Butt — the cheeks are built by SPHERICAL INFLATION (inflateCheek) AFTER the hip shaping below, not by a
  // per-column sculpt here (a separable vert×horiz sculpt pinches the corners → bony ridges; a sphere can't
  // be made that way). See "ROUND, FULL butt cheeks" further down.

  // Bust: push the chest ring's FRONT forward — a BASELINE so the default body is feminine (not flat), and
  // `bust` scales it. Projection, not a width scale, so the back/sides stay put.
  sculpt(6, cFront, Math.max(0, (p.bust ?? 1)) * 0.026);

  // (Buttocks are inflated AFTER the hip shaping — see inflateCheek below. The belly stays here.)
  sculpt(2, cFront, 0.008);           // a touch of lower-belly fullness so the front pelvis isn't dead flat

  // Lumbar curve — the "small of the back": pull the WAIST's back FORWARD (and ease the ribcage just above)
  // so the spine reads concave between the ribcage and the butt. This is the inflection that makes the
  // S-curve read; the waist radius pinch (rdefs above) shapes the front + sides.
  sculpt(5, cBack, 0.0025);  // very slight lower-back scoop → a nearly-straight (vertical) lower back
  sculpt(6, cBack, 0.0015);  // ease the ribcage just above so the curve flows up smoothly

  // Spine RIDGE — the groove down the back, continuing the butt crack UP to the shoulders. col 12 (back-
  // centre) is the furthest-back vert, so it must be carved HARD forward to recess below the erector
  // muscles either side; we ALSO flare those erectors (cols 11/13) OUT (back) so the spine reads as a clear
  // channel between two muscle ridges, not a flat back. Tapers off toward the shoulders (rings 5/6).
  for (const [ri, gv, er] of [[5, 0.026, 0.004], [6, 0.026, 0.004], [7, 0.017, 0.004], [8, 0.010, 0.002]] as const) {
    ac.pos[ring[ri][COL_B]*3 + 2]               += gv * tt;   // col 12 — spine groove pulled IN (forward)
    ac.pos[ring[ri][(COL_B + RING - 1) % RING]*3 + 2] -= er * tt;   // col 11 — erector flares OUT (back)
    ac.pos[ring[ri][(COL_B + 1) % RING]*3 + 2]        -= er * tt;   // col 13 — erector flares OUT (back)
  }

  // Rounded shoulders: push the shoulder-band rings (7 = socket centre, 8 = socket top) at each arm
  // column UP + OUT so the neck→shoulder reads as a curve (not a sharp point), following the clavicle.
  // Done BEFORE the arm stitch so the socket loop — and thus the arm collar — follows the rounded shape.
  const shoulderRound = (base: number, sign: number): void => {
    const cL = (base + RING - 1) % RING, cC = base, cR = (base + 1) % RING;
    for (const [ri, fy, fx] of [[8, 0.010, 0.020], [7, 0.007, 0.010]] as const) {
      for (const [col, f] of [[cC, 1], [cL, 0.55], [cR, 0.55]] as const) {
        const vi = ring[ri][col];
        ac.pos[vi*3]     += sign * fx * f * tt;   // outward (toward the arm)
        ac.pos[vi*3 + 1] += fy * f * tt;          // up (rounds the collar)
      }
    }
  };
  shoulderRound(0,      1);   // left arm (+X)
  shoulderRound(COL_NX, -1);  // right arm (−X)

  // Trapezius — fill the neck→shoulder slope so the thin neck stops reading long. Push the BACK of the upper
  // rings (shoulder → shoulderTop → lowerNeck) OUTWARD + UP, peaking at the back-centre (col 18) and FADING
  // to ZERO at the socket-adjacent cols (13/23) — so the trap rises into the neck base but does NOT lift the
  // socket top into a shoulder spike, and tapers cleanly into the deltoid. The FRONT (throat) is left slim.
  // Done BEFORE the arm stitch so the socket collar inherits the shape.
  for (const [ri, out, up] of [[7, 0.010, 0.003], [8, 0.020, 0.006], [9, 0.016, 0.005]] as const) {
    for (const col of [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
      const w = Math.cos((Math.abs(col - COL_B) / 5) * Math.PI * 0.5);   // 1 at back-centre (18) → 0 at the socket edges (13/23)
      const vi = ring[ri][col], x = ac.pos[vi*3], z = ac.pos[vi*3 + 2], rl = Math.hypot(x, z) || 1;
      ac.pos[vi*3]     += (x/rl) * out * w * tt;   // outward — fuller trap mass (tapered toward the sockets)
      ac.pos[vi*3 + 2] += (z/rl) * out * w * tt;
      ac.pos[vi*3 + 1] += up * w * tt;             // up — the traps rise, but ZERO at the sockets (no shoulder spike)
    }
  }

  // Scoop the UNDERARM: raise the socket BOTTOM (row 6 = chest) at each arm column. That bottom edge sits at
  // chest level and, extruded out along the arm, hung down as a flat SQUARE step under the armpit.
  // Raising it curves the armhole's lower edge up into the arm. Done before the stitch so the collar follows.
  const underarmScoop = (base: number): void => {
    const cL = (base + RING - 1) % RING, cC = base, cR = (base + 1) % RING;
    for (const [col, f] of [[cC, 1], [cL, 0.6], [cR, 0.6]] as const) {
      ac.pos[ring[6][col]*3 + 1] += 0.030 * f * tt;   // up → scoop the armhole, kill the flat square
    }
  };
  underarmScoop(0); underarmScoop(COL_NX);

  // Straighten the OUTER hip→thigh border. With the legs brought inward, the pelvis SIDES now shelf out
  // past the narrower/closer thighs. Pull the leg-side verts of the LOWER pelvis rings (0=pelvisBot,
  // 1=lower-cheek, 2=pelvisMid) IN toward centre (−X for the +X/left side, +X for the −X/right side) so the
  // OUTSIDE tapers smoothly down into the thigh instead of stepping. Outer col weighted most; the front/back
  // neighbours less (back kept light so the butt is untouched). Upper-cheek/hips (rings 3/4) — left.
  const taperHipSide = (ri: number, amt: number): void => {
    // +X side = col 0 (front-nbr 1, back-nbr 23); −X side = col 12 (front-nbr 11, back-nbr 13). Back nbrs light so the butt is untouched.
    for (const [col, f, sign] of [[0, 1, -1], [1, 0.5, -1], [23, 0.3, -1], [12, 1, 1], [11, 0.5, 1], [13, 0.3, 1]] as const) {
      ac.pos[ring[ri][col]*3] += sign * amt * f * tt;   // +X side pulls −X, −X side pulls +X → both taper toward the legs
    }
  };
  taperHipSide(0, 0.010);   // pelvisBot — most (nearest the thigh)
  taperHipSide(1, 0.007);   // lower-cheek
  taperHipSide(2, 0.004);   // pelvisMid — gentle

  // ROUND the hips (so they're never pointy, at ANY width). The side vertex (col 0/12) can jut as a sharp
  // POINT once the hips are scaled wide. Push the two DIAGONAL verts flanking each side (1/23 and 11/13)
  // OUTWARD in X toward that side vertex, so the hip side reads as a broad, gentle CURVE instead of a
  // single point — and more the wider the hips. X only (the front belly + back butt are shaped separately).
  const roundHip = (ri: number, side: number, dA: number, dB: number, amt: number): void => {
    const sx = ac.pos[ring[ri][side]*3];   // the widest (side) vert's x
    for (const d of [dA, dB]) ac.pos[ring[ri][d]*3] += (sx - ac.pos[ring[ri][d]*3]) * amt;
  };
  const hipRound = Math.min(0.45, 0.08 + Math.max(0, (p.hipWidth ?? 1) - 1) * 0.55);   // base round, MORE at high width
  for (const ri of [2, 3, 4]) { roundHip(ri, 0, 1, 23, hipRound); roundHip(ri, 12, 11, 13, hipRound); }   // pelvisMid · upper-cheek · hips

  // ── Butt — SEMI-SPHERICAL cheeks via a RADIAL bulge (not a back-only push) ────────────────────────────
  // The old "W-contour" only pushed BACK (−Z), which adds ZERO width → a flat projection that can never be
  // wide or round. A real cheek is a 3D DOME: it bulges OUT (sideways) + BACK + down. So push each back-
  // hemisphere vert OUTWARD radially from the pelvis Y-axis (in XZ) → the cheek gains WIDTH (X) as well as
  // projection (Z) and reads as a semi-sphere. Peak on the cheek centres (15/21), still FULL toward the
  // cleft (18) so the two domes MEET (a crease, not a gap), fading at the hips (13/23) so the bulge doesn't
  // shelf over the thigh. NO new geometry — 24-gon already has ~5 cols × 5 rings/cheek; this is the SHAPING.
  {
    const bulgeW: Record<number, number> = {            // radial-bulge weight per col (0 = none, 1 = full)
      13: 0.25, 14: 0.72, 15: 1.0, 16: 0.96, 17: 0.85,  // right cheek (peak 15) → toward the cleft
      18: 0.62,                                          // cleft — the two domes MEET here (full, then a crease is carved below)
      19: 0.85, 20: 0.96, 21: 1.0, 22: 0.72, 23: 0.25,  // cleft → left cheek (peak 21)
    };
    const vBell = [0.5, 0.88, 1.0, 0.84, 0.45];   // rings 0..4 — a smooth vertical dome (peak at the buttock)
    const MAXB = 0.0169;  // radial bulge magnitude — THE dial for how wide/full the cheeks are (bigger = bigger butt)
    for (let ri = 0; ri <= 4; ri++) for (const cs in bulgeW) {
      const col = +cs, vi = ring[ri][col];
      const x = ac.pos[vi*3], z = ac.pos[vi*3 + 2], rl = Math.hypot(x, z) || 1, push = MAXB * bulgeW[col] * vBell[ri];
      ac.pos[vi*3]     += (x / rl) * push;   // OUTWARD in XZ → width + back projection = a 3D dome (was −Z only)
      ac.pos[vi*3 + 2] += (z / rl) * push;
    }
    // CLEFT — a gentle forward carve at the centre so the meeting domes still read as TWO (a crease, no gap).
    for (const [ri, amt] of [[1, 0.007], [2, 0.011], [3, 0.007]] as const) ac.pos[ring[ri][COL_B]*3 + 2] += amt * tt;
    const cheekCols = [13, 14, 15, 16, 17, 19, 20, 21, 22, 23];   // both cheeks, EXCLUDING the cleft (col 18)
    // Gluteal fold — tuck the cheek BOTTOM (ring 0) down + forward so the cheek sits ON the thigh.
    for (const col of cheekCols) { const vi = ring[0][col]; ac.pos[vi*3+1] -= 0.006 * tt; ac.pos[vi*3+2] += 0.008 * tt; }
    // Pelvis TILT — droop the back verts DOWN ∝ how far they project (× a ring weight that fades at the top),
    // so the now-bigger butt HANGS instead of jutting as a flat shelf.
    const rw = [1, 1, 1, 0.8, 0.4];
    for (let ri = 0; ri <= 4; ri++) for (const col of [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
      const vi = ring[ri][col], back = Math.max(0, -ac.pos[vi*3 + 2]);
      ac.pos[vi*3 + 1] -= 0.15 * back * rw[ri];
    }
  }

  // arm sockets: rows {6,7} (the shoulder band) × the two cols straddling each side (0 = LEFT/+X, COL_NX = RIGHT/−X)
  const skip = new Set<string>();
  for (const base of [0, COL_NX]) for (const row of [6, 7]) for (const col of [(base+RING-1)%RING, base]) skip.add(row+','+col);
  for (let row = 0; row < NR - 1; row++) {
    for (let col = 0; col < RING; col++) {
      if (skip.has(row+','+col)) continue;
      const a = ring[row], b = ring[row+1], c2 = (col+1)%RING;
      ac.idx.push(a[col], a[c2], b[c2]);
      ac.idx.push(a[col], b[c2], b[col]);
    }
  }

  // ── arms: open socket → WIDE deltoid → tapering arm. GAP-FREE: every arm ring is built at the
  //    socket loop's OWN angles (around the arm axis), so each bridge is a direct i→i prism — no
  //    angle-sort clustering, no slivers, no holes. The arm cross-section inherits the socket shape.
  for (const sd of [{ s: 'L', base: 0 }, { s: 'R', base: COL_NX }]) {
    const cL = (sd.base+RING-1)%RING, cC = sd.base, cR = (sd.base+1)%RING;
    const loop = [ ring[6][cL], ring[6][cC], ring[6][cR], ring[7][cR], ring[8][cR], ring[8][cC], ring[8][cL], ring[7][cL] ];   // rows 6=chest(socket bottom) · 7=shoulder · 8=shoulderTop
    let sc: V3 = [0, 0, 0];
    for (const vi of loop) sc = [sc[0]+ac.pos[vi*3], sc[1]+ac.pos[vi*3+1], sc[2]+ac.pos[vi*3+2]];
    sc = scl(sc, 1/loop.length);

    const sh = wp[J('shoulder_'+sd.s)], lo = wp[J('lowerarm_'+sd.s)], ha = wp[J('hand_'+sd.s)];
    const dir = norm(sub(lo, sh));
    const { u: au, v: av } = perpFrame(dir);
    ac.island = sd.s === 'L' ? IS.armL : IS.armR;  // arm + hand share this island
    const armRes = stitchLimb(ac, loop, au, av, [
      // j2/w2 = secondary joint blend → smooth deformation across the shoulder/elbow/wrist (no hard creases).
      // Radii give the arm a SHAPE (like the leg's thigh/calf): deltoid cap → bicep/tricep → elbow PINCH →
      // forearm bulge → slim wrist. The elbow pinch (slimmer than both) is what makes the muscles read.
      { c: add(sc, scl(dir, 0.02)), r: 0, j: J('shoulder_'+sd.s), uv: 0, j2: J('clavicle_'+sd.s), w2: 0.4 }, // collar: seal OUT along the arm only — NO up-lift (the up-lift hoisted the socket top into a shoulder spike)
      { c: lerp(sh, lo, 0.13),      r: 0.062*lt, j: J('shoulder_'+sd.s), uv: 0.12 }, // deltoid — shoulder cap: FULLER + seated close to the socket so it rounds the torso→arm transition (was 0.052 @ 0.18)
      { c: lerp(sh, lo, 0.48),      r: 0.048*lt, j: J('shoulder_'+sd.s), uv: 0.38, j2: J('lowerarm_'+sd.s), w2: 0.20 }, // bicep / tricep — the upper-arm muscle belly (slightly fuller to flow off the bigger cap)
      { c: lo,                      r: 0.034*lt, j: J('lowerarm_'+sd.s), uv: 0.58, j2: J('shoulder_'+sd.s), w2: 0.35 }, // elbow — SLIM pinch (the contrast that makes the bicep + forearm read)
      { c: lerp(lo, ha, 0.30),      r: 0.044*lt, j: J('lowerarm_'+sd.s), uv: 0.75, j2: J('hand_'+sd.s),     w2: 0.20 }, // forearm — flexor bulge (clear, like the calf), upper forearm
      { c: ha,                      r: 0.027*lt, j: J('hand_'+sd.s),     uv: 0.92, j2: J('lowerarm_'+sd.s), w2: 0.30 }, // wrist — slim
    ]);
    const wrist = armRes.last;
    // Capture the arm surface (collar=socket/armhole → deltoid → … → wrist) for the clothing generator,
    // so a sleeve is built as these rings offset outward — following the real shoulder/armpit.
    if (armSurface) {
      armSurface[sd.s as 'L' | 'R'] = armRes.rings.map(ring => {
        let cx = 0, cy = 0, cz = 0;
        for (const vi of ring) { cx += ac.pos[vi*3]; cy += ac.pos[vi*3+1]; cz += ac.pos[vi*3+2]; }
        const m = ring.length;
        return {
          center: [cx/m, cy/m, cz/m] as V3,
          verts: ring.map(vi => ({
            p: [ac.pos[vi*3], ac.pos[vi*3+1], ac.pos[vi*3+2]] as V3,
            n: [ac.nrm[vi*3], ac.nrm[vi*3+1], ac.nrm[vi*3+2]] as V3,
            j0: ac.j0[vi], w0: ac.w0[vi], j1: ac.j1[vi], w1: ac.w1[vi],
          })),
        };
      });
    }
    buildHand(ac, wrist, ha, au, av, dir, J('hand_'+sd.s), lt);
  }

  // ── head: anime side profile. Lower rings start near NECK width and widen GRADUALLY (no pinch →
  //    no neck lump); upper rings sphere-dome (round skull). Front-center column pushed into the
  //    profile: jaw break → CHIN point → curve up over the mouth to the NOSE (forward-most) → a
  //    short straight-IN segment at the nose-top → then straight UP into the round skull. ──
  ac.island = IS.head;
  const hr = (dy: number, r: number, uvV: number) => addRing(ac, yAt(head, dy), fu, fv, r*hs, J('head'), uvV);
  const h0 = hr(-0.060, 0.040, 0.00);  // jaw base — ≈ neck width (smooth, no lump)
  const h1 = hr(-0.028, 0.050, 0.10);  // chin
  const h2 = hr(-0.006, 0.066, 0.22);  // mouth — LOWERED (shorten the nose→chin span)
  const h3 = hr( 0.026, 0.082, 0.34);  // nose — LOWERED toward the chin
  const h4 = hr( 0.040, 0.085, 0.42);  // nose-top / bridge start — LOWERED to match
  const h5 = hr( 0.078, 0.090, 0.54);  // brow — widest
  const h6 = hr( 0.112, 0.082, 0.68);  // forehead ┐
  const h7 = hr( 0.142, 0.058, 0.82);  // upper    ├ sphere dome → round top
  const h8 = hr( 0.162, 0.030, 0.93);  // crown    ┘
  bandRings(ac, ring[NR-1], h0); bandRings(ac, h0, h1); bandRings(ac, h1, h2); bandRings(ac, h2, h3);
  bandRings(ac, h3, h4); bandRings(ac, h4, h5); bandRings(ac, h5, h6); bandRings(ac, h6, h7); bandRings(ac, h7, h8);
  capRing(ac, h8, yAt(head, 0.172), J('head'));

  const FRONT = COL_F;   // +Z front-centre column of each head ring
  const pushFace = (rg: number[], dz: number, dy = 0): void => {
    ac.pos[rg[FRONT]*3 + 1] += dy * hs;
    ac.pos[rg[FRONT]*3 + 2] += dz * hs;
  };
  // Like pushFace but SPREADS the push across the front cols with a cosine falloff → a ROUNDED, sculpted
  // form (a soft chin) instead of a single jutting vertex (which reads as a sharp edge down the face).
  const pushFaceWide = (rg: number[], dz: number, dy: number, spread: number): void => {
    for (let o = -spread; o <= spread; o++) {
      const col = (FRONT + o + RING) % RING;
      const f = Math.cos((o / (spread + 1)) * Math.PI * 0.5);   // 1 at the centre → 0 at the edge of the spread
      ac.pos[rg[col]*3 + 1] += dy * f * hs;
      ac.pos[rg[col]*3 + 2] += dz * f * hs;
    }
  };
  pushFaceWide(h0, -0.014, 0, 3);       // under-jaw UNDERCUT — tuck the whole jaw base IN (not the old single -0.006 vert) → a crisp jaw↔neck BREAK = sharp jawline (less smooth neck→chin transition)
  pushFaceWide(h1, 0.026, -0.012, 3);   // CHIN — more forward + lower + TIGHTER falloff (spread 4→3) → a defined chin that the deeper undercut throws into sharp relief
  pushFaceWide(h2, 0.016, 0, 3);        // mouth — rounded, on the chin→nose curve
  pushFace(h3, 0.020);                  // NOSE — narrow (the nose tip is a point — stays a single col)
  pushFace(h4, 0.004, -0.012);          // nose-top — dropped to the nose-tip's height → top of nose is FLAT/horizontal
  pushFace(h5, -0.004);                 // brow — then straight UP
  pushFace(h6, -0.004);                 // forehead — curves into the skull

  // Jaw angle (gonial corner) — give the jawLINE a defined corner where the line from the chin turns back
  // toward the ear, instead of a smooth round jaw. Drop + tuck the jaw-corner cols (offset ±4/±5 from front)
  // of the two jaw rings so a crisp edge runs chin → corner.
  for (const o of [-5, -4, 4, 5]) {
    const col = (FRONT + o + RING) % RING;
    for (const [rg, dn, tuck] of [[h0, 0.004, 0.006], [h1, 0.007, 0.005]] as const) {
      ac.pos[rg[col]*3 + 1] -= dn * hs;                          // down — the jawline angles down to the corner
      const x = ac.pos[rg[col]*3], z = ac.pos[rg[col]*3 + 2], rl = Math.hypot(x, z) || 1;
      ac.pos[rg[col]*3]     -= (x/rl) * tuck * hs;               // in — tuck the corner → a crisp angle, not a round cheek
      ac.pos[rg[col]*3 + 2] -= (z/rl) * tuck * hs;
    }
  }

  // ── legs: pants split from the pelvis-bottom ring (shared crotch verts join the two legs) ──
  const pb = ring[0], pby = rdefs[0].c[1];
  const crotch = (z: number, dy: number): number => {
    const i = ac.count;
    pushVert(ac, [0, pby + dy*H, z*H], [0, -1, 0], 0.5, 0.5, J('hips'), 1, 0, 0);
    return i;
  };
  ac.island = IS.torso;  // crotch/pelvis verts belong to the torso island
  const cf = crotch(0.045, -0.02), cb = crotch(-0.045, -0.02), cm = crotch(0, -0.06);
  // Each leg takes its HALF of the 24-gon pelvis ring + the 3 shared crotch verts as the inner edge.
  // Inner edge (front-centre COL_F=6 → cf,cm,cb → back-centre COL_B=18), then the outer half-ring back→front.
  // Both loops traverse cols in increasing order so the winding matches (outward normals).
  const legLoops: Record<'L'|'R', number[]> = {
    L: [ pb[6], cf, cm, cb, pb[18], pb[19], pb[20], pb[21], pb[22], pb[23], pb[0], pb[1], pb[2], pb[3], pb[4], pb[5] ],   // +X (left) half
    R: [ pb[6], pb[7], pb[8], pb[9], pb[10], pb[11], pb[12], pb[13], pb[14], pb[15], pb[16], pb[17], pb[18], cb, cm, cf ], // −X (right) half
  };
  const legFirst: Partial<Record<'L'|'R', number[]>> = {};
  for (const s of ['L', 'R'] as const) {
    const ul = wp[J('upperleg_'+s)], ll = wp[J('lowerleg_'+s)], ft = wp[J('foot_'+s)];
    const { u: lu, v: lv } = perpFrame(sub(ll, ul));
    // Legs descend from just below the pelvis bottom (the upperleg JOINT sits above it, so bridging
    // straight to the joint looked kinked). A wide thigh-top + mid-thigh blends out of the pelvis.
    const legBase: V3 = [ul[0], rdefs[0].c[1] - 0.025, ul[2]];
    ac.island = s === 'L' ? IS.legL : IS.legR;  // leg + foot share this island
    const res = stitchLimb(ac, legLoops[s], lu, lv, [
      // j2/w2 = secondary joint blend → smooth deformation across the hip/knee/ankle. Radii give the leg a
      // SHAPE (not a straight taper): full upper thigh → slim knee → calf bulge → slim ankle.
      { c: legBase,                 r: 0.090*lt, j: J('upperleg_'+s), uv: 0,    j2: J('hips'),         w2: 0.45 }, // thigh top — FULL (gives the butt mass to sit on), eases out of the pelvis
      { c: lerp(legBase, ll, 0.18), r: 0.085*lt, j: J('upperleg_'+s), uv: 0.13, j2: J('hips'),         w2: 0.25 }, // upper thigh (GATHER ring) — the wide pelvis narrows gradually into the THIGH MUSCLE
      { c: lerp(legBase, ll, 0.5),  r: 0.075*lt, j: J('upperleg_'+s), uv: 0.32, j2: J('lowerleg_'+s), w2: 0.25 }, // mid thigh — FULL thigh, then tapers to the knee
      { c: ll,                      r: 0.044*lt, j: J('lowerleg_'+s), uv: 0.55, j2: J('upperleg_'+s), w2: 0.35 }, // knee — SLIM (the pinch that makes the now-fuller thigh + calf read)
      { c: lerp(ll, ft, 0.32),      r: 0.060*lt, j: J('lowerleg_'+s), uv: 0.72, j2: J('foot_'+s),     w2: 0.20 }, // calf — CLEAR muscle bulge (much fuller than the knee), upper shin
      { c: ft,                      r: 0.033*lt, j: J('foot_'+s),     uv: 0.92, j2: J('lowerleg_'+s), w2: 0.30 }, // ankle — slim
    ]);
    legFirst[s] = res.first;
    // SEAMLESS hip→leg OUTER surface. stitchLimb's parallel extrusion shifts the WHOLE first ring sideways
    // so its centre lands on the leg joint — but the loop centre is pulled INWARD by the crotch verts
    // (at x≈0), so that shift pushes the OUTER edge OUT past the pelvis = a bulge/seam at the hip↔leg.
    // The crotch verts NEED the shift (to separate L↔R and fill the crotch); the outer verts don't. So
    // re-apply the shift weighted by "innerness": crotch keeps it (separation), the OUTER snaps back ONTO
    // the pelvis, so the outer surface flows straight off the hip with no step. Only X (sideways) corrected.
    {
      let maxX = 1e-4; for (const vi of legLoops[s]) maxX = Math.max(maxX, Math.abs(ac.pos[vi*3]));
      let lcx = 0;     for (const vi of legLoops[s]) lcx += ac.pos[vi*3]; lcx /= legLoops[s].length;
      const offX = ul[0] - lcx;   // the sideways shift stitchLimb applied (legBase.x − loop centre)
      for (let i = 0; i < legLoops[s].length; i++) {
        const srcX = ac.pos[legLoops[s][i]*3];                          // the pelvis vert's x
        const inner = Math.max(0, 1 - Math.abs(srcX) / (maxX * 0.7));   // 1 at the crotch (x≈0) → 0 at the outer hip
        ac.pos[res.first[i]*3] = srcX + offX * inner;                   // outer → back on the pelvis; crotch → keeps the L/R separation
      }
    }
    // Round the UNDER-BUTT: nudge the thigh-top's back-centre vertex UP so the buttock folds smoothly into the
    // back of the thigh (the gluteal fold). Only a TINY back push now — the bigger one made the upper-thigh
    // back shelf OUT past the butt (the back-flatten below also keeps the thigh-back in).
    { const bc = s === 'L' ? 4 : 12; const vi = res.first[bc]; ac.pos[vi*3 + 1] += 0.012 * lt; ac.pos[vi*3 + 2] -= 0.005 * lt; }   // bc = back-centre's index in this leg's loop (L:4, R:12)
    // Hip Front also pulls the FRONT of the upper thigh IN, so a pulled-in lower belly (small hipFront) stays
    // FLUSH with the thigh-fronts instead of the legs shelving out past it. res.first (thigh top) already
    // follows the pelvis (it's extruded from ring 0); the gather/mid rings below are full-radius circles at
    // the leg axis (z≈0) that DON'T — so scale THEIR +Z (front) toward the axis by hipF, fading down the thigh.
    if (Math.abs(hipF - 1) > 1e-3) {
      for (const [rg, fade] of [[res.rings[1], 0.4], [res.rings[2], 0.18]] as const) {
        for (const vi of rg) if (ac.pos[vi*3 + 2] > 0) ac.pos[vi*3 + 2] *= 1 + (hipF - 1) * fade;
      }
    }
    // Flatten the FRONT of the very top of the thigh — the quad is fairly flat at the hip crease and bulges
    // only lower (mid-thigh); the full-radius top rings poke out otherwise. Pull +Z (front) IN toward the
    // leg axis, strongest at the very top, fading to natural by the mid-thigh.
    for (const [ri, fac] of [[0, 0.87], [1, 0.91], [2, 0.96]] as const) {
      for (const vi of res.rings[ri]) if (ac.pos[vi*3 + 2] > 0) ac.pos[vi*3 + 2] *= fac;
    }
    // BACK of the very top of the thigh — SEVERELY pull it in (the back of the upper thigh was bulging out
    // behind the butt). Strong −Z flatten on rings 0-2 so the thigh-back runs nearly straight down out of the
    // gluteal fold instead of carrying a big hamstring/under-butt volume.
    for (const [ri, fac] of [[0, 0.74], [1, 0.82], [2, 0.92]] as const) {
      for (const vi of res.rings[ri]) if (ac.pos[vi*3 + 2] < 0) ac.pos[vi*3 + 2] *= fac;
    }
    // INNER-THIGH CLAMP — the fuller thighs (radius > the close leg spacing) interpenetrate at the centreline
    // into a merged blob. Pull back ONLY the verts that actually CROSSED to the other leg's side (x past 0)
    // to a hair off-centre, so the two thighs MEET at a thin seam. Clamping at the gap (not at 0) flattened
    // the whole inner HALF into facing walls = a gap down the legs — so test crossing (x<0), not x<gap.
    { const inSign = ul[0] >= 0 ? 1 : -1, gap = 0.002;
      for (const ri of [1, 2, 3]) for (const vi of res.rings[ri]) {
        const x = ac.pos[vi*3];
        if (inSign > 0 ? x < 0 : x > 0) ac.pos[vi*3] = inSign * gap;   // only verts that crossed the centreline
      } }
    capRing(ac, res.last, add(ft, [0, -0.012, 0]), J('foot_'+s)); // close the leg end (the foot covers it)
    buildFoot(ac, ft, J('foot_'+s), lt, ft[0] > 0 ? -1 : 1);
  }

  // Close the inner CROTCH. The extrude gives each leg its OWN copy of the FIVE shared inner-pelvis
  // verts — front-center pb[COL_F], the 3 crotch verts (cf,cm,cb), back-center pb[COL_B] — and nothing
  // bridged the copies, leaving the crotch hole. Bridge the LEFT leg's whole inner edge (Lr[0..4]) to
  // the RIGHT leg's (Rr[0,15,14,13,12]); cap the front/back tops with the shared pelvis-center verts.
  const Lr = legFirst.L!, Rr = legFirst.R!;
  const Linner = [Lr[0], Lr[1], Lr[2], Lr[3], Lr[4]];        // frontC,cf,cm,cb,backC (extruded, left)  — loop order [6,cf,cm,cb,18,…]
  const Rinner = [Rr[0], Rr[15], Rr[14], Rr[13], Rr[12]];   // frontC,cf,cm,cb,backC (extruded, right) — loop order [6,…,18,cb,cm,cf]
  ac.idx.push(pb[COL_F], Linner[0], Rinner[0]); // front-top under the shared front-pelvis vert
  ac.idx.push(pb[COL_B], Rinner[4], Linner[4]); // back-top under the shared back-pelvis vert
  for (let i = 0; i < 4; i++) {             // bridge the two inner edges, front→back
    ac.idx.push(Linner[i], Linner[i+1], Rinner[i+1]);
    ac.idx.push(Linner[i], Rinner[i+1], Rinner[i]);
  }
}

function addSphere(ac: Accum, center: V3, r: number, joint: number): void {
  const LAT = 6, LON = RING;
  const base = ac.count;
  for (let i = 0; i <= LAT; i++) {
    const theta = (i / LAT) * Math.PI;       // 0..π
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let j = 0; j <= LON; j++) {
      const phi = (j / LON) * Math.PI * 2;
      const dir: V3 = [st * Math.cos(phi), ct, st * Math.sin(phi)];
      pushVert(ac, add(center, scl(dir, r)), dir, j / LON, i / LAT, joint, 1, 0, 0);
    }
  }
  const stride = LON + 1;
  for (let i = 0; i < LAT; i++) {
    for (let j = 0; j < LON; j++) {
      const a = base + i * stride + j, b = a + stride;
      ac.idx.push(a, a + 1, b + 1);  // outward-facing
      ac.idx.push(a, b + 1, b);
    }
  }
}

/** Forward-kinematics world position of each joint from a (possibly tweaked) local-position set. */
function worldPositions(local: V3[]): V3[] {
  const w: V3[] = [];
  for (let i = 0; i < JOINTS.length; i++) {
    w[i] = JOINTS[i].parent < 0 ? [...local[i]] as V3 : add(w[JOINTS[i].parent], local[i]);
  }
  return w;
}

/** Per-joint local positions with proportion params applied. legLength lengthens the leg
 *  segments; `height` is baked uniformly so the mesh + skeleton stay at identity transform
 *  (skinned meshes pose correctly when mesh and skeleton share one space — no node scale). */
function localPositions(p: BodyParams): V3[] {
  const longLeg  = new Set(['lowerleg_L', 'lowerleg_R', 'foot_L', 'foot_R']);
  const torsoSeg = new Set(['spine', 'chest', 'neck']);   // segment lengths up the torso
  return JOINTS.map(j => {
    let y = j.pos[1];
    if (longLeg.has(j.name))       y *= p.legLength;
    else if (torsoSeg.has(j.name)) y *= p.torsoLength;
    return [j.pos[0] * p.height, y * p.height, j.pos[2] * p.height] as V3;
  });
}

/** Generate a procedural humanoid body as a GltfSkinnedResult. */
export function generateBodyResult(partial?: Partial<BodyParams>): GltfSkinnedResult & { armSurface: ArmSurface } {
  const p = { ...DEFAULT_BODY_PARAMS, ...partial };
  const local = localPositions(p);
  const wp = worldPositions(local);
  let ac: Accum = { pos: [], nrm: [], uv: [], j0: [], w0: [], j1: [], w1: [], idx: [], count: 0, island: [0, 0, 1, 1] };
  const armSurface: ArmSurface = { L: [], R: [] };   // captured during addStitchedBody → for the sleeve offset-surface

  const thick = (kind: Bone['kind'] | Blob['kind']): number =>
    kind === 'torso' ? p.torsoThick : kind === 'head' ? p.headSize : kind === 'neck' ? p.torsoThick : p.limbThick;

  const H = p.height; // radii are baked by height too (positions already are, via localPositions)

  // Whole body as ONE stitched surface (weld pass 2b): torso + arms (deltoid collars) + head
  // (capped rings off the neck) + legs (pants split off the pelvis). Hands/feet stay as cap blobs.
  addStitchedBody(ac, wp, p, H, armSurface);

  for (const bone of BONES) {
    const ja = NAME_TO_IDX.get(bone.a)!, jb = NAME_TO_IDX.get(bone.b)!;
    const m = thick(bone.kind) * H;
    addTube(ac, wp[ja], wp[jb], bone.r0 * m, bone.r1 * m, ja, jb);
  }
  for (const blob of BLOBS) {
    const ji = NAME_TO_IDX.get(blob.at)!;
    addSphere(ac, wp[ji], blob.r * thick(blob.kind) * H, ji);
  }

  // Weld coincident verts → fuses each limb's segments into one continuous tube (and cleans
  // sphere-pole duplicates). Connected topology with no rewrite. See weldAccum.
  ac = weldAccum(ac);

  // Recompute SMOOTH vertex normals from the welded faces (area-weighted). Critical: every push
  // (nose, butt), extrude, and junction left STALE per-vertex normals, which read as hard shading
  // seams (e.g. the "edge" at the armpit). We keep each smoothed normal aligned to the vertex's
  // original outward normal so inconsistent face winding can't flip it inward.
  {
    const acc = new Float32Array(ac.count * 3);
    for (let i = 0; i < ac.idx.length; i += 3) {
      const a = ac.idx[i], b = ac.idx[i+1], c = ac.idx[i+2];
      const e1x = ac.pos[b*3]-ac.pos[a*3], e1y = ac.pos[b*3+1]-ac.pos[a*3+1], e1z = ac.pos[b*3+2]-ac.pos[a*3+2];
      const e2x = ac.pos[c*3]-ac.pos[a*3], e2y = ac.pos[c*3+1]-ac.pos[a*3+1], e2z = ac.pos[c*3+2]-ac.pos[a*3+2];
      let nx = e1y*e2z-e1z*e2y, ny = e1z*e2x-e1x*e2z, nz = e1x*e2y-e1y*e2x; // area-weighted face normal
      // Orient THIS FACE outward using the verts' (reliable, radial) original normals, BEFORE
      // accumulating — the mesh's winding is NOT globally consistent (torso vs extrude vs limb
      // loops), so a raw average + a per-vertex flip gives inward (dark) patches. Per-face fixes it.
      const rx = ac.nrm[a*3]+ac.nrm[b*3]+ac.nrm[c*3];
      const ry = ac.nrm[a*3+1]+ac.nrm[b*3+1]+ac.nrm[c*3+1];
      const rz = ac.nrm[a*3+2]+ac.nrm[b*3+2]+ac.nrm[c*3+2];
      if (nx*rx + ny*ry + nz*rz < 0) { nx=-nx; ny=-ny; nz=-nz; }
      for (const v of [a, b, c]) { acc[v*3]+=nx; acc[v*3+1]+=ny; acc[v*3+2]+=nz; }
    }
    for (let i = 0; i < ac.count; i++) {
      let x = acc[i*3], y = acc[i*3+1], z = acc[i*3+2];
      const l = Math.hypot(x, y, z);
      if (l < 1e-6) { x = ac.nrm[i*3]; y = ac.nrm[i*3+1]; z = ac.nrm[i*3+2]; } // degenerate → keep original
      else { x/=l; y/=l; z/=l; }
      ac.nrm[i*3]=x; ac.nrm[i*3+1]=y; ac.nrm[i*3+2]=z;
    }
  }

  // ── winding-consistency pass ──
  // The generator emits faces from many sites (rings, pushes, caps, pants split, hands/feet) with
  // INconsistent triangle winding. The normals pass above fixed shading, but winding also drives
  // backface CULLING — under a cull-back pipeline the back-wound faces vanish ("front half
  // invisible"). Re-orient every triangle CCW-outward using the now-correct outward vertex normals
  // as the reference, so the body is correct under any cull mode (and survives the edit-mesh round-trip).
  for (let i = 0; i < ac.idx.length; i += 3) {
    const a = ac.idx[i], b = ac.idx[i+1], c = ac.idx[i+2];
    const e1x = ac.pos[b*3]-ac.pos[a*3], e1y = ac.pos[b*3+1]-ac.pos[a*3+1], e1z = ac.pos[b*3+2]-ac.pos[a*3+2];
    const e2x = ac.pos[c*3]-ac.pos[a*3], e2y = ac.pos[c*3+1]-ac.pos[a*3+1], e2z = ac.pos[c*3+2]-ac.pos[a*3+2];
    const nx = e1y*e2z-e1z*e2y, ny = e1z*e2x-e1x*e2z, nz = e1x*e2y-e1y*e2x;  // face normal from winding
    const rx = ac.nrm[a*3]+ac.nrm[b*3]+ac.nrm[c*3];   // outward reference (vertex normals)
    const ry = ac.nrm[a*3+1]+ac.nrm[b*3+1]+ac.nrm[c*3+1];
    const rz = ac.nrm[a*3+2]+ac.nrm[b*3+2]+ac.nrm[c*3+2];
    if (nx*rx + ny*ry + nz*rz < 0) { ac.idx[i+1] = c; ac.idx[i+2] = b; }  // inward-wound → flip CCW
  }

  // ── interleave 12-float geometry [px,py,pz, nx,ny,nz, u,v, tx,ty,tz,tw] ──
  // MUST be 12-float (FLOATS_PER_VERT): the 3D mesh + skinned pipelines read a fixed vertex
  // stride, so an 8-float buffer is misread as garbage (exploded mesh). No normal map here, so
  // the tangent is just any unit vector ⟂ the normal (avoids degenerate-tangent NaN in shaders).
  const vcount = ac.count;
  const verts = new Float32Array(vcount * 12);
  for (let i = 0; i < vcount; i++) {
    const o = i * 12;
    const nx = ac.nrm[i*3], ny = ac.nrm[i*3+1], nz = ac.nrm[i*3+2];
    const ref: V3 = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t = norm(cross([nx, ny, nz], ref)); // ⟂ normal
    verts[o]    = ac.pos[i*3]; verts[o+1] = ac.pos[i*3+1]; verts[o+2]  = ac.pos[i*3+2];
    verts[o+3]  = nx;          verts[o+4]  = ny;           verts[o+5]  = nz;
    verts[o+6]  = ac.uv[i*2];  verts[o+7]  = ac.uv[i*2+1];
    verts[o+8]  = t[0];        verts[o+9]  = t[1];         verts[o+10] = t[2];  verts[o+11] = 1;
  }
  const geometry: MeshGeometry = {
    vertices: verts,
    indices: new Uint32Array(ac.idx),
    format: '12float',
  };

  // ── skinning arrays ──
  const jointIndices = new Uint8Array(vcount * 4);
  const jointWeights = new Float32Array(vcount * 4);
  for (let i = 0; i < vcount; i++) {
    const o = i * 4;
    jointIndices[o] = ac.j0[i]; jointIndices[o+1] = ac.j1[i];
    jointWeights[o] = ac.w0[i]; jointWeights[o+1] = ac.w1[i];
  }

  // ── skeleton arrays (identity rotations → inverse-bind is just translate(-worldPos)) ──
  const jc = JOINTS.length;
  const jointNames = JOINTS.map(j => j.name);
  const jointParents = new Int16Array(JOINTS.map(j => j.parent));
  const jointLocalPositions = new Float32Array(jc * 3);
  const jointLocalRotations = new Float32Array(jc * 4);
  const jointLocalScales = new Float32Array(jc * 3);
  const inverseBindMatrices = new Float32Array(jc * 16);
  for (let i = 0; i < jc; i++) {
    jointLocalPositions.set(local[i], i * 3);
    jointLocalRotations.set([0, 0, 0, 1], i * 4); // identity quat
    jointLocalScales.set([1, 1, 1], i * 3);
    // col-major translate(-worldPos)
    const m = inverseBindMatrices.subarray(i * 16, i * 16 + 16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    m[12] = -wp[i][0]; m[13] = -wp[i][1]; m[14] = -wp[i][2];
  }

  const skinning: GltfSkinningData = {
    jointIndices, jointWeights, inverseBindMatrices, jointNames,
    skinName: 'procedural_body', jointParents,
    jointLocalPositions, jointLocalRotations, jointLocalScales,
  };

  return {
    name: 'ProceduralBody',
    geometry,
    armSurface,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1], // identity — height/legLength are baked into geometry + joints (pose-safe)
    diffuseImage: null,
    normalMapImage: null,
    diffuseColor: [0.9, 0.78, 0.72, 1], // neutral skin
    isTransparent: false,
    morphTargets: [],
    skinning,
  };
}

// ── Preset poses ────────────────────────────────────────────────────────────────
// joint-name → local rotation quaternion [x,y,z,w], applied on top of the rest pose. Reference
// the generator's joint names. ⚠ The ANGLES below are first-guesses (rotation axis/direction is
// easy to get wrong without seeing it) — verify in-app and tweak this table. The apply-by-name
// system (applyBodyPose3D) is the durable part; the numbers are just data.
type Quat = [number, number, number, number];
function qz(deg: number): Quat { const r = (deg*Math.PI)/360; return [0, 0, Math.sin(r), Math.cos(r)]; } // arms down/up (frontal)
function qx(deg: number): Quat { const r = (deg*Math.PI)/360; return [Math.sin(r), 0, 0, Math.cos(r)]; } // tilt fwd/back
function qy(deg: number): Quat { const r = (deg*Math.PI)/360; return [0, Math.sin(r), 0, Math.cos(r)]; } // swing fwd/back (elbow)
function qmul(a: Quat, b: Quat): Quat { // a*b (applies b first, then a)
  return [
    a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
    a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
    a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
    a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2],
  ];
}

export const BODY_POSES: Record<string, { joint: string; q: Quat }[]> = {
  'T-pose':  [],
  'A-pose':  [
    { joint: 'shoulder_L', q: qz(-50) },
    { joint: 'shoulder_R', q: qz(50)  },
  ],
  // Natural relaxed stance: arms hang but angled slightly OUT + FORWARD (not pinned military-straight),
  // with a soft forward elbow bend so the hands rest in front of the thighs.
  'Relaxed': [
    { joint: 'shoulder_L', q: qmul(qx(-13), qz(-72)) }, { joint: 'shoulder_R', q: qmul(qx(-13), qz(72)) },
    { joint: 'lowerarm_L', q: qy(-24) },                { joint: 'lowerarm_R', q: qy(24) }, // soft forward elbow
  ],
  'Wave':    [
    { joint: 'shoulder_R', q: qz(-120) }, { joint: 'lowerarm_R', q: qz(-25) },
  ],
};
