/**
 * body-v2-generator.ts — the Character v2 base-body generator (asset `body-v2@3`, generator v3; docs/specs/character-v2.md
 * Phase 1 item 2, "body-v2@2" + its review fixes).
 *
 * A NEW generator, derived from v1's body-generator.ts (copied + evolved here; v1 is never edited). Pure + deterministic
 * + worker-safe (no DOM / GPU / scene graph). Runs ONLY at bake time (body-v2-asset.ts): the base + every slider key.
 *
 * Why a new generator: v1's torso rings are hard-indexed throughout its build (11 rings, an 8-vertex arm socket = 8-gon
 * arms), so it could not gain resolution additively. This one is built TOPOLOGICALLY:
 *   • unique POSITIONS (a closed 2-manifold per part: the body incl. its feet, the fingers, the toes) with dense weights;
 *   • faces whose corners name a UV CHART (+ a seam side / pole column) → the final vertex = a unique (position, chart,
 *     side) corner. So every UV seam and island boundary duplicates its vertices by construction (no smear), normals are
 *     computed on the positions (so seams never show in the shading), and the vertex order is param-independent
 *     (constant topology across every slider value — asserted over a sweep in body-v2-generator.test.ts).
 *   • weights come from ring FRACTIONS along the bones + topological smoothing → identical for every param set.
 *
 * Topology (counts asserted in the tests):
 *   • torso: TORSO_COLS (24) columns — the v1 clothing generator's underpants read torso ring 0 as a 24-gon with the
 *     16-vertex leg loops (pb[6] / pb[18], crotch verts at loop indices 1–3 / 13–15), so 24 keeps every v1 garment
 *     working on this body (see the spec's Phase 2 notes); 29 rings, densest at the bust (its apex is a ring), the
 *     shoulder band and the neck;
 *   • arms: 16-gon tubes (a 4×4-quad arm socket → a 16-vertex armhole loop), 3+ loops across the shoulder, elbow, wrist;
 *   • legs: 16-gon tubes from the pants split (v1's crotch topology), 3+ loops across the hip and knee; the leg tube
 *     runs on through the ankle into the FOOT (10 rings turning round the heel, then forward to the toe dome);
 *   • head: v1's anime head rows (the same face) with a denser cranium, scaled UNIFORMLY by headSize; hands: v1's
 *     construction with 8-gon digits; toes: 8-gon digits on the foot.
 * The 2026-10-05 adversarial review fixes (G1, geometry): the legs keep a gap by construction (a soft medial cap + wider
 * sockets), the hip → thigh outline has no notch, natural shoulders (the pivot from the armhole), longer arms + real-size
 * hands / feet, the stitched ankle, the uniform head + v1-compatible head landmarks, no jaw ledge, upright non-mirrored
 * UVs with UV tangents, continuous normals — see the spec, "body-v2@2 review fixes — G1", and body-v2-shape.test.ts.
 * The review fixes (G2, skin weights): mirror-symmetric smoothing (weightAdjacency), the knee hinge field on the true
 * back of the knee (kneeFlex), a 6-ring chest → neck → head grade (NECK_GRADE; the face-normal proxy keyed on the head
 * rings, not the weight), a longer shoulder-cap ease (forward raises; the arm below the cap stays on its bone) — see "body-v2@2 review fixes —
 * G2" and body-v2-metrics.test.ts / body-v2-generator.test.ts.
 * Same 20-joint skeleton (names, parents, identity rest rotations) as v1, so the gait / Play / retargeting / spring
 * bones work unchanged. Output = v1's result shape (GltfSkinnedResult + armSurface / legSurface / torsoSurface) plus
 * `landmarks`, so the v1 clothing generator's BodyFit (buildBodyFitFrom) fits garments on it.
 */
import type { GltfSkinnedResult, GltfSkinningData } from '../renderer/3d/gltf-importer';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { ArmSurface, ArmRing } from '../services/managers/body-generator';

type V3 = [number, number, number];

/** Generator version (bumped with any change to the output; the asset id carries it). 2 = body-v2@2 (2026-10-05);
 *  3 = the review fixes (G1 geometry + G2 weights) → body-v2@3. */
export const BODY_V2_GENERATOR_VERSION = 3;

export interface BodyV2GenParams {
  /** Uniform scale (the asset uses a node scale instead; kept so the generator is complete). */
  height: number;
  legLength: number;
  torsoLength: number;
  /** Head size: a UNIFORM head scale about the jaw row (v2@2 and v1: width only). */
  headSize: number;
  limbThick: number;
  torsoThick: number;
  bust: number;
  waist: number;
  hipWidth: number;
  hipFront: number;
  /** Shoulder width — the shoulder band AND the clavicle length (v2: the arms move out, a bone offset). */
  shoulderWidth: number;
  buttSize: number;
  /** 0 = v1's classic head … 1 = the anime head. */
  headShape: number;
}

export const BODY_V2_GEN_DEFAULTS: Readonly<BodyV2GenParams> = {
  height: 1, legLength: 1.2, torsoLength: 1, headSize: 1.1, limbThick: 1, torsoThick: 1,
  bust: 1, waist: 1, hipWidth: 1, hipFront: 1, shoulderWidth: 1, buttSize: 1, headShape: 1,
};

export type BodyV2GenResult = GltfSkinnedResult & { armSurface: ArmSurface; legSurface: ArmSurface; torsoSurface: ArmRing[]; landmarks: BodyV2Landmarks };

/** Named geometry landmarks of a generated body (rest pose, rig units) — what downstream fitting reads instead of
 *  guessing from weights (the face / hair head frame, the shoulder line, the torso ring indices). */
export interface BodyV2Landmarks {
  /** Torso ring indices into torsoSurface: waist, under-bust, bust apex, armpit, shoulder top, neck base, top neck ring. */
  rings: { W: number; UB: number; A: number; AP: number; ST: number; NB: number; JAW: number };
  /** The front-view shoulder line: the neck-base half-width and the acromion (armhole top) half-width. */
  shoulder: { neckBaseX: number; acromionX: number };
  head: BodyV2HeadFrame;
}
/** The head frame (rest pose): every value is the head joint + headSize·H × a fixed offset, so it is exact for any
 *  slider state. `v1Box` = the box v1's face / hair placement computes on v1's anime head (headRegionBBoxOf: verts with
 *  head weight ≥ 0.5, which on v1 reach the upper-neck ring at −0.100 head units) — feed it to the v1 eye decal / face
 *  kit / hair HeadFrame instead of headRegionBBoxOf on a v2 body (whose head weights stop at the chin, review
 *  downstream#1), and they land exactly where they do on v1. */
export interface BodyV2HeadFrame {
  joint: [number, number, number];
  /** headSize · height (the head-unit scale). */
  unit: number;
  chinY: number; jawRowY: number; eyeY: number; browY: number; crownY: number;
  faceFrontZ: number; faceHalfWidth: number;
  v1Box: { min: [number, number, number]; max: [number, number, number] };
  /** The head's row 0 (the under-jaw ring the neck joins), TORSO_COLS points, column 0 = +X, increasing toward the front. */
  jawRing: [number, number, number][];
}

// ── Skeleton (v1's 20 joints: names, parents, rest offsets) ────────────────────────────────────────────────────────
interface JointDef { name: string; parent: number; pos: V3 }
const JOINTS: readonly JointDef[] = [
  { name: 'hips',       parent: -1, pos: [0, 0.90, 0] },
  { name: 'lowerback',  parent: 0,  pos: [0, 0.035, 0] },
  { name: 'spine',      parent: 1,  pos: [0, 0.085, 0] },
  { name: 'chest',      parent: 2,  pos: [0, 0.18, 0] },
  { name: 'neck',       parent: 3,  pos: [0, 0.16, 0] },
  { name: 'head',       parent: 4,  pos: [0, 0.10, 0] },
  { name: 'clavicle_L', parent: 3,  pos: [0.03, 0.06, 0] },
  { name: 'shoulder_L', parent: 6,  pos: [0.045, 0.015, 0] },
  { name: 'lowerarm_L', parent: 7,  pos: [0.27, 0, 0] },
  { name: 'hand_L',     parent: 8,  pos: [0.23, 0, 0] },
  { name: 'clavicle_R', parent: 3,  pos: [-0.03, 0.06, 0] },
  { name: 'shoulder_R', parent: 10, pos: [-0.045, 0.015, 0] },
  { name: 'lowerarm_R', parent: 11, pos: [-0.27, 0, 0] },
  { name: 'hand_R',     parent: 12, pos: [-0.23, 0, 0] },
  { name: 'upperleg_L', parent: 0,  pos: [0.045, -0.14, 0] },
  { name: 'lowerleg_L', parent: 14, pos: [0, -0.42, 0] },
  { name: 'foot_L',     parent: 15, pos: [0, -0.42, 0] },
  { name: 'upperleg_R', parent: 0,  pos: [-0.045, -0.14, 0] },
  { name: 'lowerleg_R', parent: 17, pos: [0, -0.42, 0] },
  { name: 'foot_R',     parent: 18, pos: [0, -0.42, 0] },
];
const JN = JOINTS.length;
const JI = new Map(JOINTS.map((j, i) => [j.name, i]));
const J = (n: string): number => JI.get(n)!;
const SIDE_OF: ('L' | 'R' | 'C')[] = JOINTS.map((j) => (j.name.endsWith('_L') ? 'L' : j.name.endsWith('_R') ? 'R' : 'C'));

/** The head's row 0 (the jaw / under-chin ring, at the back) in head units below the head joint. headSize scales the
 *  WHOLE head uniformly about this row (so the neck join never moves); the head joint itself is a bone offset that
 *  rides with the scale (review fix proportions#7: v1 / v2@2 scaled only the width). */
export const HEAD_ROW0_DY = -0.040;
/** Upper arm / forearm lengths at torsoLength 1 (v1 0.27 / 0.23; +4 %: the review measured the wrist ≈ 1.5 % H high). */
const UPPER_ARM = 0.28, FOREARM = 0.24;
/** Hip socket half-spacing at hipWidth 1, limbThick 1 (v1 0.05: the thighs could not fit between the sockets). */
const HIP_SOCKET = 0.057;
/** Arm-length coupling to torsoLength (a long torso lifts the shoulders; without it the fingertips end above the crotch). */
const armLenF = (p: BodyV2GenParams): number => lerp(1, p.torsoLength, 0.5);
/** Hip socket half-spacing (rig units, before × height): hipWidth spreads the pelvis, limbThick a little too, so thick
 *  thighs widen the stance instead of crossing (both bone offsets in the asset). */
export const hipSocketX = (p: BodyV2GenParams): number => HIP_SOCKET * (1 + 0.7 * (p.hipWidth - 1)) * (1 + 0.45 * (p.limbThick - 1));

/** v2 joint local positions: v1's proportions (legLength / torsoLength / height), the hip sockets (hipSocketX), the arm
 *  lengths (+ the torsoLength coupling) and the head joint (it rides the uniform head scale). The shoulder joint's x is
 *  set later from the armhole (generateBodyV2: shoulderPivot) — here it is v1's clavicle-based placeholder. */
function localPositions(p: BodyV2GenParams): V3[] {
  const longLeg = new Set(['lowerleg_L', 'lowerleg_R', 'foot_L', 'foot_R']);
  // (v2: the clavicle rise scales with the torso too, so a short torso keeps room between the shoulder top and the neck)
  const torsoSeg = new Set(['lowerback', 'spine', 'chest', 'neck', 'clavicle_L', 'clavicle_R']);
  return JOINTS.map((j) => {
    let [x, y, z] = j.pos;
    if (longLeg.has(j.name)) y *= p.legLength;
    else if (torsoSeg.has(j.name)) y *= p.torsoLength;
    if (j.name === 'shoulder_L' || j.name === 'shoulder_R') { x = Math.sign(x) * (0.047 + 0.12 * (p.shoulderWidth - 1)); y += SHOULDER_RAISE; }
    if (j.name === 'lowerarm_L' || j.name === 'lowerarm_R') x = Math.sign(x) * UPPER_ARM * armLenF(p);
    if (j.name === 'hand_L' || j.name === 'hand_R') x = Math.sign(x) * FOREARM * armLenF(p);
    if (j.name === 'upperleg_L' || j.name === 'upperleg_R') x = Math.sign(x) * hipSocketX(p);
    if (j.name === 'head') y += HEAD_ROW0_DY * (1 - p.headSize);
    return [x * p.height, y * p.height, z * p.height] as V3;
  });
}
/** The shoulder line is lifted a little over v1's (with the neck-base rise from the run, below: a natural slope without
 *  stretching the neck — review fix proportions#6). */
const SHOULDER_RAISE = 0.008;
function worldPositions(local: V3[]): V3[] {
  const w: V3[] = [];
  for (let i = 0; i < JN; i++) w[i] = JOINTS[i].parent < 0 ? [...local[i]] as V3 : add(w[JOINTS[i].parent], local[i]);
  return w;
}

// ── vec helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const smooth = (e0: number, e1: number, x: number): number => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const gauss = (d: number, s: number): number => Math.exp(-(d * d) / (2 * s * s));
function perpFrame(axis: V3): { u: V3; v: V3 } {
  const a = norm(axis);
  const up: V3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(up, a));
  return { u, v: cross(a, u) };
}
/** Wrapped angle difference a − b in (−π, π]. */
const angDiff = (a: number, b: number): number => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d <= -Math.PI) d += 2 * Math.PI; return d; };

// ── Topology constants ──────────────────────────────────────────────────────────────────────────────────────────────
/** Torso / head columns. 24 = what the v1 clothing generator's underpants + body fit index (see the header). */
export const TORSO_COLS = 24;
/** Arm + leg sides (the arm socket is a 4×4-quad hole → a 16-vertex armhole loop; the pants split gives 16 per leg). */
export const LIMB_SIDES = 16;
const DIGIT_SIDES = 8;

// ── Leg + foot shape tables (rig units at height 1; × limbThick for girth) ──────────────────────────────────────────
/** [t along hip→knee (or 1 + s along knee→ankle), r_front/back (u), r_side (v)] × limbThick. The thighs are ~7 % slimmer
 *  than v2@2's (the reference's legs are slim and parted; v2@2's could not fit between the hip sockets). */
const LEG_RINGS: readonly (readonly [number, number, number])[] = [
  [0.13, 0.083, 0.079], [0.24, 0.079, 0.077], [0.38, 0.074, 0.072], [0.52, 0.069, 0.067], [0.66, 0.062, 0.060],
  [0.79, 0.054, 0.053], [0.90, 0.050, 0.048], [1.00, 0.047, 0.046], [1.07, 0.048, 0.046], [1.20, 0.055, 0.050],
  [1.36, 0.054, 0.048], [1.54, 0.045, 0.041], [1.70, 0.038, 0.035], [1.82, 0.034, 0.031], [1.92, 0.032, 0.030], [2.00, 0.031, 0.029],
];
const legSideR = (t: number): number => {
  if (t <= LEG_RINGS[0][0]) return LEG_RINGS[0][2];
  for (let i = 0; i + 1 < LEG_RINGS.length; i++) {
    const [t0, , r0] = LEG_RINGS[i], [t1, , r1] = LEG_RINGS[i + 1];
    if (t <= t1) return lerp(r0, r1, (t - t0) / (t1 - t0));
  }
  return LEG_RINGS[LEG_RINGS.length - 1][2];
};
/** The clearance (× height) each leg keeps from the body's midline at leg fraction t (0 = hip … 1 = knee … 2 = ankle):
 *  the legs meet at the crotch, part through the thigh, and keep a 12 mm gap from the knee down. */
export function legClearance(t: number): number {
  return 0.0015 + 0.0025 * smooth(0.15, 0.6, t) + 0.002 * smooth(0.6, 1.0, t);
}
/** The thigh's outward offset at t: 30 % of what its round section would cross the clearance by (smooth), fading out by
 *  the knee — part of the girth the medial cap takes off the inner side goes back on the outer side. */
function legEcc(p: BodyV2GenParams, sockX: number, t: number): number {
  const H = p.height;
  return 0.3 * softplus(legSideR(t) * p.limbThick * H - (sockX - legClearance(t) * H), 0.004 * H) * (1 - smooth(0.45, 0.85, t));
}
/** The foot, from the ankle ring on: [nominal t (weights), F y, F z, B y, B z (× foot length, about the ankle joint),
 *  half-width (× foot girth), sole flattening]. F = the ring's front / top point (the instep), B = its back / bottom
 *  point (the Achilles → heel → sole); the ring planes turn from horizontal to vertical around the heel. */
const FOOT_RINGS: readonly (readonly [number, number, number, number, number, number, number])[] = [
  [2.06, -0.008, 0.032, -0.016, -0.033, 0.029, 0],
  [2.12, -0.012, 0.038, -0.031, -0.039, 0.028, 0],
  [2.18, -0.015, 0.045, -0.043, -0.040, 0.028, 0.10],
  [2.24, -0.017, 0.053, -0.051, -0.026, 0.030, 0.25],
  [2.30, -0.019, 0.062, -0.052, 0.005, 0.032, 0.45],
  [2.36, -0.021, 0.073, -0.052, 0.045, 0.034, 0.55],
  [2.42, -0.024, 0.088, -0.052, 0.088, 0.036, 0.55],
  [2.48, -0.028, 0.104, -0.052, 0.104, 0.037, 0.55],
  [2.54, -0.032, 0.118, -0.052, 0.118, 0.036, 0.50],
  [2.60, -0.037, 0.127, -0.050, 0.127, 0.031, 0.35],
];
/** The ankle joint's height above the sole (× foot length; v2@2 0.045). */
const FOOT_ANKLE_H = 0.052;
/** The toe-end dome's apex: [height above the sole, z] (× foot length). */
const FOOT_APEX: readonly [number, number] = [0.009, 0.133];

/** Smooth max(0, x) (softplus with knee k) and a smooth min(a, b) that never exceeds either. */
function softplus(x: number, k: number): number { return x > 0 ? x + k * Math.log1p(Math.exp(-x / k)) : k * Math.log1p(Math.exp(x / k)); }
function smin(a: number, b: number, k: number): number { return Math.min(a, b) - k * Math.log1p(Math.exp(-Math.abs(a - b) / k)); }
/** The top neck ring (under the jaw, absolute half-width / front / back): 65 % the neck's own thickness, 35 % the head's
 *  under-jaw ring — so neither torsoThick nor the head scale can leave a ledge or an undercut there. */
function neckTopRing(p: BodyV2GenParams): { a: number; f: number; b: number } {
  const H = p.height, tt = p.torsoThick * H, hs = p.headSize * H, nf = neckF(p), h0 = ANIME_HEAD[0], k = 0.65;
  return { a: k * 0.050 * tt * nf + (1 - k) * 0.98 * h0[2] * hs, f: k * 0.046 * tt * nf + (1 - k) * 0.98 * h0[3] * hs, b: k * 0.046 * tt * nf + (1 - k) * 0.98 * h0[4] * hs };
}
const COLF = TORSO_COLS / 4, COLB = (TORSO_COLS * 3) / 4, COLNX = TORSO_COLS / 2;   // 6 front, 18 back, 12 = −X side

// ── Mesh builder: positions + charted corners ───────────────────────────────────────────────────────────────────────
type Chart =
  | { kind: 'tube'; rings: number[][]; seam: number; closed: boolean; apex?: number; apexCols?: number; virt?: Float64Array | null; area: number[];
      /** v runs DOWN the island from the last ring (torso / head: ring 0 is at the bottom) — image-down = body-down. */
      flipV?: boolean;
      /** The island's texel-density factor in the pack (the head gets more). */
      uvScale?: number }
  | { kind: 'planar'; axes: [V3, V3] };

class Builder {
  pos: number[] = [];
  /** Reference outward direction per position (orients the faces). */
  ref: number[] = [];
  W: number[] = [];   // dense JN weights per position
  tris: number[] = [];
  /** Per triangle corner: chart index and sub key (seam side 0/1, or the pole column for an apex corner). */
  cChart: number[] = [];
  cSub: number[] = [];
  charts: Chart[] = [];
  /** Every tube quad's UNUSED diagonal (A[c+1], B[c]) — the weight smoothing graph links both diagonals, so it is
   *  mirror-symmetric (review weights#4; the triangles' diagonals all run one way, which mirrors onto the other). */
  altDiag: number[] = [];
  get count(): number { return this.pos.length / 3; }
  vert(p: V3, refDir: V3, weights?: [number, number][]): number {
    const i = this.count;
    this.pos.push(p[0], p[1], p[2]);
    this.ref.push(refDir[0], refDir[1], refDir[2]);
    for (let j = 0; j < JN; j++) this.W.push(0);
    if (weights) for (const [j, w] of weights) this.W[i * JN + j] += w;
    return i;
  }
  P(i: number): V3 { return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]; }
  setP(i: number, p: V3): void { this.pos[i * 3] = p[0]; this.pos[i * 3 + 1] = p[1]; this.pos[i * 3 + 2] = p[2]; }
  setW(i: number, weights: [number, number][]): void {
    for (let j = 0; j < JN; j++) this.W[i * JN + j] = 0;
    for (const [j, w] of weights) this.W[i * JN + j] += w;
  }
  tri(a: number, b: number, c: number, chart: number, sa = 0, sb = 0, sc = 0): void {
    this.tris.push(a, b, c);
    this.cChart.push(chart, chart, chart);
    this.cSub.push(sa, sb, sc);
  }
  addChart(c: Chart): number { this.charts.push(c); return this.charts.length - 1; }
}

/**
 * A TUBE chart over rings (each ring a closed loop of the same length, index-corresponding), optional apex cap at the
 * end. Quads between ring r and r+1; the column that crosses `seam` gets sub 1 on its seam-column corners (so the
 * island is cut there). `skipQuad(r, c)` leaves holes (the arm sockets). Returns the chart index.
 */
function tubeChart(b: Builder, rings: number[][], seam: number, opts: { apex?: number; skipQuad?: (r: number, c: number) => boolean; virt?: Float64Array | null; startApex?: number; flipV?: boolean; uvScale?: number } = {}): number {
  const n = rings[0].length;
  const ch = b.addChart({ kind: 'tube', rings, seam, closed: true, apex: opts.apex, apexCols: n, virt: opts.virt ?? null, area: [], flipV: opts.flipV, uvScale: opts.uvScale });
  for (let r = 0; r + 1 < rings.length; r++) {
    const A = rings[r], B = rings[r + 1];
    for (let c = 0; c < n; c++) {
      if (opts.skipQuad?.(r, c)) continue;
      const c2 = (c + 1) % n;
      const s2 = c2 === seam ? 1 : 0;   // the quad that wraps onto the seam column uses its far copy
      b.tri(A[c], A[c2], B[c2], ch, 0, s2, s2);
      b.tri(A[c], B[c2], B[c], ch, 0, s2, 0);
      b.altDiag.push(A[c2], B[c]);
    }
  }
  if (opts.apex !== undefined) {
    const L = rings[rings.length - 1];
    for (let c = 0; c < n; c++) {
      const c2 = (c + 1) % n, s2 = c2 === seam ? 1 : 0;
      b.tri(L[c], L[c2], opts.apex, ch, 0, s2, 2 + c);   // apex corner keyed by its column (a pole: one copy per wedge)
    }
  }
  if (opts.startApex !== undefined) {
    const F = rings[0];
    for (let c = 0; c < n; c++) {
      const c2 = (c + 1) % n, s2 = c2 === seam ? 1 : 0;
      b.tri(F[c2], F[c], opts.startApex, ch, s2, 0, 2 + n + c);
    }
  }
  return ch;
}

// ── Parameters of the shape (fractions of the rig height H; multiplied by torsoThick / limbThick) ───────────────────
/** Torso cross-section at a ring: half-width a (±X), front depth f (+Z), back depth b (−Z), superellipse exponent. */
interface Section { y: number; a: number; f: number; b: number; zc: number; ex: number; spine: [number, number][] }

/** Superellipse point at parametric angle th (col 0 = +X, increasing toward +Z front). */
function sectionPoint(s: Section, th: number): V3 {
  const c = Math.cos(th), sn = Math.sin(th), e = 2 / s.ex;
  const x = s.a * Math.sign(c) * Math.pow(Math.abs(c), e);
  const z = (sn >= 0 ? s.f : s.b) * Math.sign(sn) * Math.pow(Math.abs(sn), e);
  return [x, s.y, s.zc + z];
}

/** The torso's ring heights + anatomical levels (world y). Every ring sits at a FIXED fraction between anchors, so the
 *  ring structure is the same for any params. Densest where the shape turns: the pelvis (butt / crotch), the bust, the
 *  shoulder band and the neck. */
function torsoLevels(p: BodyV2GenParams, wp: V3[]) {
  const H = p.height, tt = p.torsoThick * H;
  const yH = wp[J('hips')][1], yC = wp[J('chest')][1], yN = wp[J('neck')][1], yHd = wp[J('head')][1], ySh = wp[J('shoulder_L')][1];
  const yPB = yH - 0.12 * H;                       // pelvis bottom: the legs split here (v1)
  const yW = lerp(yC, yH, 0.5);                    // the waist
  const armRy = 0.050 * H * lerp(1, p.limbThick, 0.6) * lerp(1, p.torsoThick, 0.25);   // armhole half-height
  const armRz = 0.046 * H * lerp(1, p.limbThick, 0.6) * lerp(1, p.torsoThick, 0.25);   // armhole half-depth
  const yAHC = ySh - 0.010 * H;                   // the armhole centre sits a little under the joint (a natural shoulder slope)
  const yAP = yAHC - armRy, yST = yAHC + armRy;    // armpit ring / shoulder-top ring
  // The top neck ring sits a fixed band under the head's row 0 (which the uniform head scale never moves).
  const yJawRow = yHd + HEAD_ROW0_DY * p.headSize * H;
  const yJaw = yJawRow - 0.022 * H;                // upper neck (just under the jaw ring h0)
  // Neck base (the trapezius meets the neck): the shoulder line rises from the acromion to it at a natural slope —
  // from the RUN (acromion x − neck-base x), not a fixed fraction of the neck (v2@2: 34° rest / 42° Relaxed on the fem,
  // review proportions#6), capped at v2@2's rise so the neck never gets shorter than it was.
  // (bilinear in shoulderWidth × torsoThick, so the slider keys + their corrective reproduce it; a smooth cap)
  const aNB = NECK_BASE_A * neckF(p) * tt;
  const rise = smin((0.97 * 0.128 * p.shoulderWidth * tt - aNB) * SHOULDER_TAN, 0.40 * (yJaw - yST), 0.003 * H);
  const yNB = yST + rise;
  const yUB = yC - 0.072 * H * p.torsoLength;      // under-bust crease
  const hip0 = yH + 0.008 * H;
  // Ring heights. Densest where the shape turns: the pelvis (butt / crotch), the bust (its apex is a ring: review
  // topology#4), the shoulder band and the neck; the hip → waist band has 3 interior rings (topology#7: 57 mm before).
  const ringY: number[] = [
    yPB, yH - 0.095 * H, yH - 0.07 * H, yH - 0.045 * H, yH - 0.02 * H, hip0,                 // 0–5 pelvis (crotch → hip)
    lerp(hip0, yW, 0.24), lerp(hip0, yW, 0.5), lerp(hip0, yW, 0.76), yW,                     // 6–9 lower belly → waist
    lerp(yW, yUB, 0.35), lerp(yW, yUB, 0.7), yUB,                                            // 10–12 ribs → under-bust
    lerp(yUB, yAP, 0.21), lerp(yUB, yAP, 0.33), lerp(yUB, yAP, BUST_APEX_T), lerp(yUB, yAP, 0.66),   // 13–16 the bust (15 = apex)
    yAP, lerp(yAP, yST, 0.25), lerp(yAP, yST, 0.5), lerp(yAP, yST, 0.75), yST,               // 17–21 the socket rows
  ];
  const R_W = 9, R_UB = 12, R_BA = 15, R_AP = 17, R_ST = 21;
  // Trapezius rings: the shoulder line from the shoulder top to the neck, flat over the shoulder, rising into the neck
  // (t^1.8). The samples are spread so the first one is no sliver at the front / back (topology#7: 4 mm before).
  const trapT = [0.45, 0.68, 0.87];
  for (const t of trapT) ringY.push(yST + (yNB - yST) * Math.pow(t, 1.8));
  const R_NB = ringY.length; ringY.push(yNB);
  ringY.push(lerp(yNB, yJaw, 0.4), lerp(yNB, yJaw, 0.75), yJaw);                              // lower / mid / upper neck
  const R_JAW = ringY.length - 1;
  return { yH, yC, yN, yHd, ySh, yPB, yW, yUB, yAP, yST, yNB, yJaw, yJawRow, yAHC, armRy, armRz, ringY, R_W, R_UB, R_BA, R_AP, R_ST, R_NB, R_JAW, trapT };
}
/** The armhole's x extent: its bottom (the armpit) at the ribcage's side wall, its top out at the shoulder width. */
function armholeX(sections: Section[], R_AP: number, R_ST: number, H: number): { bot: number; top: number; mid: number } {
  const bot = sections[R_AP - 1].a * 0.99, top = Math.max(bot + 0.012 * H, sections[R_ST].a * 0.97);
  return { bot, top, mid: (bot + top) / 2 };
}
/** The shoulder joint's inset from the armhole centre (× height). */
const SHOULDER_INSET = 0.010;
/** The waist's half-width at waist 1 (× torsoThick). v2@2 had 0.100: the fem base's waist was 0.080 of the height,
 *  waist / hip 0.59 (review proportions#3); the same param values now give a defined but natural waist. */
const WAIST_A = 0.114;
/** The bust apex's fraction from the under-bust crease to the armpit ring (a ring sits exactly on it). */
const BUST_APEX_T = 0.42;
/** Neck-base half-width at torsoThick 1 (v2@2 0.074) and the neck's thickness coupling (a broad-shouldered masc gets a
 *  visibly thicker neck: review proportions#12 measured masc ≈ fem). */
const NECK_BASE_A = 0.071;
const neckF = (p: BodyV2GenParams): number => lerp(1, p.shoulderWidth, 0.6);
/** tan of the rest-pose shoulder-line slope (the Relaxed stance adds a few degrees: the clavicles drop, the arms hang). */
const SHOULDER_TAN = Math.tan((17 * Math.PI) / 180);

/** Generate a Character v2 base body. Deterministic: same params → byte-identical output. */
export function generateBodyV2(partial: Partial<BodyV2GenParams> = {}): BodyV2GenResult {
  const p: BodyV2GenParams = { ...BODY_V2_GEN_DEFAULTS, ...partial };
  const local = localPositions(p);
  let wp = worldPositions(local);
  const H = p.height, tt = p.torsoThick * H, lt = p.limbThick * H;
  const b = new Builder();
  const jw = (name: string, w = 1): [number, number] => [J(name), w];

  const head = wp[J('head')];
  const sw = p.shoulderWidth;

  // ── TORSO RINGS ───────────────────────────────────────────────────────────────────────────────────────────────────
  // The arm socket: an ellipse in the plane x = ±xAH around (yAHC, ~0); its bottom row = the armpit ring, its top row
  // = the shoulder-top ring, with 3 rows between (a 4×4-quad hole → the 16-vertex armhole loop).
  const lv = torsoLevels(p, wp);
  const { yH, yC, yW, yUB, yAP, yST, yNB, yPB, yJaw, yAHC, armRy, armRz, ringY, R_UB, R_AP, R_ST, R_NB, R_JAW, trapT } = lv;
  const NR = ringY.length;
  // Skin weights read the ring heights of the DEFAULT body (fixed fractions) → identical weights for every param set.
  const lv0 = torsoLevels(BODY_V2_GEN_DEFAULTS, worldPositions(localPositions(BODY_V2_GEN_DEFAULTS)));

  // Cross-section anchors (y, a, f, b, exponent) as functions of the params (× tt). Interpolated by a monotone cubic.
  const hw = p.hipWidth, hf = p.hipFront, wm = p.waist;
  // The hip → thigh outline (review proportions#4: the pelvis bottom was narrower than both the hips above it and the
  // thigh tops below — a notch at the leg split). The pelvis-bottom ring (the trochanter level) takes the wider of the
  // hip band and the thigh tops' outer extent (smoothly), and the hip anchors above blend toward it, so the outer
  // contour runs unimodal from the waist through the hip into the outer thigh for any hipWidth / limbThick / torsoThick.
  const sockX = Math.abs(wp[J('upperleg_L')][0]);
  const thighOut = sockX + legEcc(p, sockX, LEG_RINGS[0][0]) + LEG_RINGS[0][2] * lt;
  const hipA = 0.131 * hw * tt, mid = 0.5 * (hipA + thighOut);
  const W = mid + softplus(thighOut - mid, 0.004 * H);
  const toward = (a: number, k: number) => a + k * softplus(W / tt - a, 0.004 * H / tt);
  // the waist widens more than it deepens (v2@2's section was nearly round: width / depth 1.19, people ≈ 1.35)
  const top = neckTopRing(p);   // the top neck ring follows the head's under-jaw ring (review topology#6 note)
  const nf = neckF(p);
  const anchors: [number, number, number, number, number, number][] = [
    // y              a (half-width)       f (front)               b (back)  ex    zc (posture)
    [yPB,            W / tt,              0.086 * lerp(1, hf, 0.6), 0.096, 2.15, -0.004],
    [yH - 0.07 * H,  toward(0.130 * hw, 0.6), 0.090 * hf,         0.102, 2.25, -0.006],
    [yH - 0.02 * H,  toward(0.131 * hw, 0.25), 0.090 * hf,        0.096, 2.25, -0.005],
    [yH + 0.03 * H,  lerp(0.118 * hw, 0.104 * wm, 0.25), 0.086 * lerp(1, hf, 0.6), 0.084, 2.2, -0.002],
    [yW,             WAIST_A * wm,        0.077 * lerp(1, wm, 0.4), 0.072 * lerp(1, wm, 0.3), 2.1, 0.000],
    [yUB,            0.112 * lerp(1, wm, 0.35), 0.088,         0.086, 2.15, 0.004],
    [yAP,            0.122,               0.090,                  0.090, 2.2, 0.004],
    [yST,            0.128 * sw,          0.078,                  0.086, 2.3, 0.000],
    [yNB,            NECK_BASE_A * nf,    0.056 * nf,             0.064 * nf, 2.0, -0.004],
    [yJaw,           top.a / tt,          top.f / tt,             top.b / tt, 2.0, -0.002],
  ];
  const ys = anchors.map((a) => a[0]);
  const chan = (k: number) => monotoneCubic(ys, anchors.map((a) => a[k]));
  const fa = chan(1), ff = chan(2), fb = chan(3), fe = chan(4), fz = chan(5);
  // Trapezius rings: the side half-width follows the shoulder line (wide at the top of the arm, the neck at the base).
  const aST = 0.128 * sw;
  // Spine weights over height (v1's ring weights, interpolated) — on the DEFAULT body's heights (see lv0).
  const D = lv0, H0 = BODY_V2_GEN_DEFAULTS.height;
  const spineKeys: [number, [number, number][]][] = [
    [D.yH - 0.03 * H0, [jw('hips')]],
    [D.yH + 0.008 * H0, [jw('hips', 0.8), jw('lowerback', 0.2)]],
    [lerp(D.yH, D.yW, 0.55), [jw('hips', 0.35), jw('lowerback', 0.65)]],
    [D.yW, [jw('lowerback', 0.5), jw('spine', 0.5)]],
    [lerp(D.yW, D.yUB, 0.6), [jw('spine', 0.8), jw('chest', 0.2)]],
    [D.yUB, [jw('spine', 0.45), jw('chest', 0.55)]],
    [D.yAP, [jw('chest', 0.9), jw('spine', 0.1)]],
    [D.yST, [jw('chest')]],
    // the neck: chest → neck → head graded over the trapezius top, the neck base and the 3 neck rings (NECK_GRADE)
    ...([D.ringY[D.R_NB - 2], D.ringY[D.R_NB - 1], D.yNB, D.ringY[D.R_NB + 1], D.ringY[D.R_NB + 2], D.yJaw].map((y, i): [number, [number, number][]] => {
      const ch = NECK_GRADE.chest[i], hd = i >= 3 ? NECK_GRADE.head[i - 3] : 0;
      return [y, [jw('chest', ch), jw('neck', 1 - ch - hd), jw('head', hd)].filter((x) => x[1] > 0)];
    })),
  ];
  const spineAt = (y: number): [number, number][] => {
    if (y <= spineKeys[0][0]) return spineKeys[0][1];
    for (let i = 0; i + 1 < spineKeys.length; i++) {
      const [y0, w0] = spineKeys[i], [y1, w1] = spineKeys[i + 1];
      if (y <= y1) {
        const t = (y - y0) / Math.max(1e-9, y1 - y0), m = new Map<number, number>();
        for (const [j, w] of w0) m.set(j, (m.get(j) ?? 0) + w * (1 - t));
        for (const [j, w] of w1) m.set(j, (m.get(j) ?? 0) + w * t);
        return [...m];
      }
    }
    return spineKeys[spineKeys.length - 1][1];
  };
  const yNom = (ri: number): number => D.ringY[ri];

  const sections: Section[] = ringY.map((y, ri) => {
    let a = fa(y), f = ff(y), bb = fb(y), ex = fe(y);
    if (ri > R_ST && ri < R_NB) {   // trapezius rings: side width on the shoulder line, front/back from the anchors
      const t = trapT[ri - R_ST - 1];
      a = lerp(aST, NECK_BASE_A * nf, t);
      ex = lerp(2.3, 2.05, t);
    }
    return { y, a: a * tt, f: f * tt, b: bb * tt, zc: fz(y) * H, ex, spine: spineAt(yNom(ri)) };
  });
  // The upper neck rings follow the jaw's own front drop (the head's row 0 dips 0.016 head units at the front), so the
  // strip under the chin is ~16 mm, not 6 (review topology#6: it stretched > 2× at a 14° nod).
  const neckDrop = (ri: number): number => (ri === R_NB + 1 ? 0.19 : ri === R_NB + 2 ? 0.38 : ri === R_JAW ? 0.63 : 0) * ANIME_HEAD[0][1] * p.headSize * H;
  // The shoulder band's rings rise toward the neck base faster at the BACK (the trapezius climbs to C7) and a little at
  // the front than at the side, where they trace the shoulder line: with the natural slope the side rise is only ~1.6 cm,
  // and planar rings packed 4 intervals into it (4 mm strips at the front / back centre).
  const shoulderLift = (ri: number): number => (ri > R_ST && ri < R_NB ? trapT[ri - R_ST - 1] : ri === R_NB ? 1 : ri === R_NB + 1 ? 0.6 : ri === R_NB + 2 ? 0.3 : 0) * 0.020 * H;

  // Ring vertices + shaping (bust, butt, belly, spine groove, shoulder blades, trapezius, clavicles).
  const thOf = (c: number) => (c / TORSO_COLS) * Math.PI * 2;
  const ring: number[][] = [];
  for (let ri = 0; ri < NR; ri++) {
    const s = sections[ri], out: number[] = [];
    for (let c = 0; c < TORSO_COLS; c++) {
      const th = thOf(c);
      let pt = sectionPoint(s, th);
      const rad: V3 = norm([Math.cos(th), 0, Math.sin(th)]);
      const dirXZ = norm([pt[0], 0, pt[2] - s.zc]);
      const sn = Math.sin(th), cs = Math.cos(th);
      let push = 0, up = 0, fwd = 0, outX = 0;
      // BUST: two lobes at ±26° off the front centre; a sharper underside, a long upper slope. The apex sits on a ring;
      // the footprint grows with the size (σ ∝ √fullness), so a full bust stays round underneath instead of a cone with
      // a shelf (review topology#4 / proportions#11: 34° at the base, 57° at bust 2 between two rings).
      {
        const amp = Math.max(0, p.bust) * 0.034 * tt;
        const full = Math.sqrt(Math.max(1, Math.max(0, p.bust) * p.torsoThick));
        const yA = lerp(yUB, yAP, BUST_APEX_T), dy = s.y - yA;
        const vy = dy < 0 ? gauss(dy, 0.031 * H * full) : gauss(dy, 0.056 * H * lerp(1, full, 0.5));
        const lob = (gauss(angDiff(th, Math.PI / 2 - 0.5), 0.40) + gauss(angDiff(th, Math.PI / 2 + 0.5), 0.40)) / (1 + gauss(1.0, 0.40));
        const w = amp * vy * lob;
        fwd += w; outX += cs * 0.45 * w;
        up += -0.12 * w * Math.max(0, p.bust - 1);   // a fuller bust settles a touch
      }
      // BUTT: two radial domes at ±36° off the back centre, peak at the hip, a crisp gluteal fold below.
      {
        const amp = Math.max(0, p.buttSize) * 0.024 * tt;
        const yB = yH - 0.06 * H, dy = s.y - yB;
        const vy = dy < 0 ? gauss(dy, 0.030 * H) : gauss(dy, 0.040 * H);
        const lob = (gauss(angDiff(th, -Math.PI / 2 - 0.62), 0.42) + gauss(angDiff(th, -Math.PI / 2 + 0.62), 0.42)) / (1 + gauss(1.24, 0.42));
        push += amp * vy * lob;
        // the cleft: a narrow crease at the back centre over the lower pelvis
        push -= 0.007 * tt * gauss(angDiff(th, -Math.PI / 2), 0.13) * smooth(yH + 0.01 * H, yH - 0.04 * H, s.y) * Math.min(1, p.buttSize);
      }
      // LOWER BELLY: a soft front fullness at the hip line.
      push += 0.006 * tt * gauss(angDiff(th, Math.PI / 2), 0.7) * gauss(s.y - (yH + 0.005 * H), 0.03 * H);
      // SPINE GROOVE (waist → upper back) + the erector ridges either side.
      {
        const span = smooth(yH, yW, s.y) * (1 - smooth(yST - 0.02 * H, yNB, s.y));
        const d = angDiff(th, -Math.PI / 2);
        push += (-0.0075 * gauss(d, 0.11) + 0.0028 * (gauss(d - 0.3, 0.13) + gauss(d + 0.3, 0.13))) * tt * span;
      }
      // SHOULDER BLADES: two flat pads on the upper back.
      push += 0.005 * tt * (gauss(angDiff(th, -Math.PI / 2 - 0.62), 0.32) + gauss(angDiff(th, -Math.PI / 2 + 0.62), 0.32)) * gauss(s.y - (yC + 0.045 * H), 0.04 * H);
      // TRAPEZIUS: fill the back of the shoulder band → the neck base (no shoulder spike: zero at the socket sides).
      push += 0.010 * tt * Math.max(0, -sn) * Math.pow(Math.abs(sn), 1.5) * gauss(s.y - lerp(yST, yNB, 0.5), 0.03 * H);
      // CLAVICLES: a faint ridge across the upper chest.
      push += 0.003 * tt * Math.max(0, sn) * Math.abs(cs) * gauss(s.y - (yST + 0.004 * H), 0.012 * H) * (1 - gauss(cs, 0.25));
      up -= neckDrop(ri) * Math.max(0, sn) ** 2;
      up += shoulderLift(ri) * (Math.max(0, -sn) ** 2 + 0.45 * Math.max(0, sn) ** 2);
      pt = [pt[0] + dirXZ[0] * push + outX, pt[1] + up, pt[2] + dirXZ[2] * push + fwd];
      out.push(b.vert(pt, rad, s.spine));
    }
    ring.push(out);
  }

  // The torso's VIRTUAL grid (before the sockets move the armhole) — the torso UV chart + the torsoSurface use it.
  const virt = new Float64Array(b.pos);

  // ── SHOULDER PIVOT ────────────────────────────────────────────────────────────────────────────────────────────────
  // The shoulder joint sits just inside the armhole centre for EVERY param set (a bone offset), not at a clavicle length
  // of its own: v2@2's pivot ignored torsoThick (the frozen shoulder weights then drifted 3 → 10 cm off the loop, review
  // weights#3) and sat 3 cm inside the loop, so a hanging arm dragged the armhole top down (proportions#6: 42° Relaxed).
  const armX = armholeX(sections, R_AP, R_ST, H);
  // ≈ the armhole centre from the anchors (bilinear in torsoThick × shoulderWidth: the slider keys + the corrective
  // reproduce the bone offset exactly) less the inset
  const pivotX = 0.5 * tt * (0.99 * 0.119 + 0.97 * 0.128 * sw) - SHOULDER_INSET * H;
  for (const s of ['L', 'R'] as const) {
    const sg = s === 'L' ? 1 : -1, ic = J('clavicle_' + s), is = J('shoulder_' + s);
    local[is] = [sg * (pivotX - Math.abs(local[ic][0])), local[is][1], local[is][2]];
  }
  wp = worldPositions(local);

  // ── ARM SOCKETS ───────────────────────────────────────────────────────────────────────────────────────────────────
  const inHoleQuad = (base: number) => (r: number, c: number): boolean => {
    const d = ((c - base + TORSO_COLS + TORSO_COLS / 2) % TORSO_COLS) - TORSO_COLS / 2;   // signed col offset of the quad's left col
    return r >= R_AP && r < R_ST && d >= -2 && d < 2;
  };
  const holeL = inHoleQuad(0), holeR = inHoleQuad(COLNX);
  const skipTorso = (r: number, c: number) => holeL(r, c) || holeR(r, c);
  const isHoleInterior = (r: number, c: number): boolean => {
    for (const base of [0, COLNX]) {
      const d = ((c - base + TORSO_COLS + TORSO_COLS / 2) % TORSO_COLS) - TORSO_COLS / 2;
      if (r > R_AP && r < R_ST && d > -2 && d < 2) return true;
    }
    return false;
  };

  const armSurface: ArmSurface = { L: [], R: [] };
  const sockets: { side: 'L' | 'R'; loop: number[]; loopAng: number[]; rings: number[][]; wrist: number[]; center: V3; frame: { u: V3; v: V3; dir: V3 } }[] = [];
  for (const sd of [{ s: 'L' as const, base: 0, sign: 1 }, { s: 'R' as const, base: COLNX, sign: -1 }]) {
    const col = (d: number) => (sd.base + d + TORSO_COLS) % TORSO_COLS;
    const loop: number[] = [];
    for (let d = -2; d <= 2; d++) loop.push(ring[R_AP][col(d)]);            // bottom row
    for (let r = R_AP + 1; r < R_ST; r++) loop.push(ring[r][col(2)]);        // up one side
    for (let d = 2; d >= -2; d--) loop.push(ring[R_ST][col(d)]);             // top row
    for (let r = R_ST - 1; r > R_AP; r--) loop.push(ring[r][col(-2)]);       // down the other side
    const sh = wp[J('shoulder_' + sd.s)], lo = wp[J('lowerarm_' + sd.s)];
    const dir = norm(sub(lo, sh));
    const { u, v } = perpFrame(dir);
    // The armhole: an ellipse (taller than deep) around the arm axis, TILTED like a real armscye — its bottom (the
    // armpit) sits at the ribcage's side wall, its top out at the shoulder width. A planar loop at the shoulder width
    // left a horizontal shelf under a broad shoulder (v1's "square step"), which folded as the arm came down.
    const { bot: xBot, top: xTop } = armX;
    const xAH = sd.sign * armX.mid;
    const c0: V3 = [xAH, yAHC, 0.004 * H];
    // Even angles around the arm axis starting at "straight down" for the bottom-row middle (loop[2]).
    const ang = (q: V3) => { const d = sub(q, c0); return Math.atan2(dot(d, v), dot(d, u)); };
    let wind = 0;
    for (let i = 0; i < loop.length; i++) wind += angDiff(ang(b.P(loop[(i + 1) % loop.length])), ang(b.P(loop[i])));
    const wdir = wind >= 0 ? 1 : -1;
    const a0 = Math.atan2(-1, 0);   // straight down (−v) — loop[2]
    const loopAng = loop.map((_, k) => a0 + wdir * ((k - 2) / LIMB_SIDES) * Math.PI * 2);
    for (let k = 0; k < loop.length; k++) {
      const a = loopAng[k], ca = Math.cos(a), sa = Math.sin(a);
      // rz along u (horizontal), ry along v (vertical); the tilt along the arm axis: the bottom in, the top out.
      const along = sa * (xTop - xBot) / 2;
      const q: V3 = add(add(c0, add(scl(u, armRz * ca), scl(v, armRy * sa))), scl(dir, along));
      b.setP(loop[k], q);
    }
    sockets.push({ side: sd.s, loop, loopAng, rings: [], wrist: [], center: c0, frame: { u, v, dir } });
  }
  // Propagate the socket moves into the surrounding torso (harmonic displacement, zone = 3 grid steps around the hole;
  // the loop is the moved boundary, the zone edge stays put) → the torso bends smoothly into the armhole, no step.
  {
    const disp = new Float64Array(b.count * 3);
    for (const so of sockets) for (const vi of so.loop) for (let k = 0; k < 3; k++) disp[vi * 3 + k] = b.pos[vi * 3 + k] - virt[vi * 3 + k];
    const fixed = new Set<number>();
    for (const so of sockets) for (const vi of so.loop) fixed.add(vi);
    const zone: [number, number][] = [];
    for (const base of [0, COLNX]) {
      for (let r = R_UB; r <= R_ST + 3; r++) for (let d = -5; d <= 5; d++) {
        if (r < 0 || r >= NR) continue;
        const c = (base + d + TORSO_COLS) % TORSO_COLS;
        if (isHoleInterior(r, c) || fixed.has(ring[r][c])) continue;
        const edge = r === R_UB || r === R_ST + 3 || Math.abs(d) === 5;
        if (!edge) zone.push([r, c]);
      }
    }
    for (let it = 0; it < 60; it++) {
      for (const [r, c] of zone) {
        const vi = ring[r][c];
        const nb: number[] = [];
        for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const rr = r + dr, cc = (c + dc + TORSO_COLS) % TORSO_COLS;
          if (rr < 0 || rr >= NR || isHoleInterior(rr, cc)) continue;
          nb.push(ring[rr][cc]);
        }
        for (let k = 0; k < 3; k++) {
          let s = 0; for (const q of nb) s += disp[q * 3 + k];
          disp[vi * 3 + k] = s / nb.length;
        }
      }
    }
    for (const [r, c] of zone) { const vi = ring[r][c]; for (let k = 0; k < 3; k++) b.pos[vi * 3 + k] = virt[vi * 3 + k] + disp[vi * 3 + k]; }
  }

  // Torso faces (the hole quads skipped) + the torso chart (UVs from the virtual grid).
  // (the torso island ends at the neck base: the neck goes on the head's island, so no texture seam runs along the jaw
  //  line — review downstream#3)
  const torsoChart = tubeChart(b, ring.slice(0, R_NB + 1), COLB, { skipQuad: skipTorso, virt, flipV: true });

  // ── ARMS (16-gon) ─────────────────────────────────────────────────────────────────────────────────────────────────
  // Rings along the arm (fraction t of shoulder→elbow, then s of elbow→wrist): [t or 1+s, rv (vertical), ru (horizontal)]
  // × limbThick. The first rings blend the armhole loop's shape into the round arm (3 loops across the shoulder).
  const ARM_RINGS: [number, number, number][] = [
    [0.24, 0.057, 0.051], [0.33, 0.055, 0.049], [0.44, 0.051, 0.047], [0.56, 0.048, 0.045], [0.68, 0.045, 0.043],
    [0.80, 0.041, 0.040], [0.90, 0.038, 0.037], [1.00, 0.036, 0.036], [1.08, 0.039, 0.040], [1.20, 0.041, 0.044],
    [1.36, 0.037, 0.041], [1.54, 0.032, 0.037], [1.70, 0.027, 0.033], [1.84, 0.024, 0.031], [1.93, 0.023, 0.030], [2.00, 0.022, 0.029],
  ];
  const armCharts: number[] = [];
  const T_LOOP = 0.14;   // the armhole's nominal fraction along the upper arm (on the default body)
  for (const so of sockets) {
    const s = so.side, sh = wp[J('shoulder_' + s)], lo = wp[J('lowerarm_' + s)], ha = wp[J('hand_' + s)];
    const { u, v, dir } = so.frame;
    const loopC = so.center;
    const loopRel = so.loop.map((vi) => sub(b.P(vi), loopC));
    const angs = so.loopAng;   // arm vertex k sits at the loop vertex k's angle → band k → k, no twist
    const rings: number[][] = [so.loop];
    const iSh = J('shoulder_' + s), iLo = J('lowerarm_' + s), iHa = J('hand_' + s), iCl = J('clavicle_' + s);
    for (let ri = 0; ri < ARM_RINGS.length; ri++) {
      const [t, rv0, ru0] = ARM_RINGS[ri];
      // upper-arm rings sit at fractions from the armhole (its centre's projection on the arm axis) to the elbow, so they
      // stay outboard of the loop for any shoulder width; t is the ring's NOMINAL fraction (the weights read t).
      const sLoop = dot(sub(loopC, sh), dir), uLen = len(sub(lo, sh));
      const f = (t - T_LOOP) / (1 - T_LOOP);
      const c = t <= 1 ? add(sh, scl(dir, lerp(sLoop, uLen, f))) : lerp3(lo, ha, t - 1);
      // centre: from the loop centre's height/depth to the joint axis over the first rings
      const m = smooth(0, 3, ri + 1);   // 0 at the loop → 1 by ring 3
      const cc: V3 = [c[0], lerp(loopC[1], c[1], m), lerp(loopC[2], c[2], m)];
      const rv = rv0 * lt, ru = ru0 * lt;
      const out: number[] = [];
      for (let k = 0; k < LIMB_SIDES; k++) {
        const ca = Math.cos(angs[k]), sa = Math.sin(angs[k]);
        let q: V3 = add(cc, add(scl(u, ru * ca), scl(v, rv * sa)));
        // deltoid cap: the top rides higher/outward near the shoulder; blend from the loop shape on the first 2 rings
        if (ri === 0) q = lerp3(add(cc, loopRel[k]), q, 0.55);
        else if (ri === 1) q = lerp3(add(cc, loopRel[k]), q, 0.85);
        const rdir = add(scl(u, ca), scl(v, sa));
        const wts = armWeights(t, iCl, iSh, iLo, iHa, rdir[2]);   // the elbow flexes forward (+Z): the inner elbow
        out.push(b.vert(q, norm(rdir), wts));
      }
      rings.push(out);
    }
    so.rings = rings;
    so.wrist = rings[rings.length - 1];
    armCharts.push(tubeChart(b, rings, 2));
  }

  // ── HANDS ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const so of sockets) {
    const s = so.side, ha = wp[J('hand_' + s)], iHa = J('hand_' + s);
    const { u, v, dir } = so.frame;
    const wc = add(ha, [0, 0, 0]);
    const wr = so.wrist;
    const angs = wr.map((vi) => { const d = sub(b.P(vi), wc); return Math.atan2(dot(d, v), dot(d, u)); });
    const fwd: V3 = [0, 0, 1];   // the thumb side (both hands: palms down in the rest pose, thumbs forward)
    // palm rings; `thenar` = the ball of the thumb, a bulge on the thumb side near the wrist the thumb grows out of
    const palm = (along: number, rU: number, rV: number, thenar = 0): number[] => angs.map((a) => {
      let off = add(scl(u, rU * Math.cos(a)), scl(v, rV * Math.sin(a)));
      const t = Math.max(0, dot(norm(off), fwd));
      off = add(off, scl(fwd, thenar * t * t));
      return b.vert(add(add(wc, scl(dir, along)), off), norm(off), [[iHa, 1]]);
    });
    // Hand LENGTH follows the height (a girth slider must not grow the hand 1.8×), its GIRTH the limb thickness. Sized
    // to the reference (review proportions#1: v2@2's hand was 0.42 head heights, ≈ 0.6× the reference; the fingertips
    // ended at the crotch): wrist → middle fingertip ≈ 0.077 of the stature, the palm a little longer than the fingers.
    const hl = H * lerp(1, p.limbThick, 0.25), hg = H * lerp(1, p.limbThick, 0.8);
    const p1 = palm(0.022 * hl, 0.032 * hg, 0.019 * hg, 0.006 * hg);
    const p2 = palm(0.050 * hl, 0.036 * hg, 0.016 * hg, 0.004 * hg);
    const p3 = palm(0.076 * hl, 0.037 * hg, 0.0135 * hg);
    const apex = b.vert(add(wc, scl(dir, 0.090 * hl)), dir, [[iHa, 1]]);
    tubeChart(b, [wr, p1, p2, p3], 2, { apex });
    const knuckle = add(wc, scl(dir, 0.078 * hl));
    // index → pinky from the thumb side backward; the across axis is SIDE-SIGNED (the arm frame's u flips between the
    // arms — v2@2 put the right hand's pinky next to its thumb: review weights#5)
    const sg = s === 'L' ? 1 : -1;
    const spread = [-0.026, -0.0087, 0.0087, 0.026];
    const lengthF = [0.055, 0.066, 0.062, 0.048];
    const curlF = [0.95, 1.0, 1.0, 1.08];
    const knuckleBack = [0.003, 0, 0.002, 0.008];   // the knuckles on an arc (the middle one furthest out)
    const fan = [-0.06, -0.02, 0.02, 0.07];          // the fingers splay a touch
    const fingerCurl: V3 = [0, -0.38, 0.12];
    for (let k = 0; k < 4; k++) {
      const base = add(add(knuckle, scl(u, sg * spread[k] * hg)), scl(dir, -knuckleBack[k] * hl));
      digit(b, base, norm(add(dir, scl(u, sg * fan[k]))), lengthF[k] * hl, 0.0085 * hg, iHa, scl(fingerCurl, curlF[k]));
    }
    // the thumb grows out of the thenar bulge, along the index side, angled ~35° off the hand and a little palm-ward
    digit(b, add(add(add(wc, scl(dir, 0.028 * hl)), scl(fwd, 0.026 * hg)), scl(v, -0.004 * hg)), norm(add(add(scl(dir, 0.80), scl(fwd, 0.55)), scl(v, -0.22))), 0.050 * hl, 0.0108 * hg, iHa, [0, -0.16, 0.02]);
  }

  // ── LEGS (pants split, 16-gon) ────────────────────────────────────────────────────────────────────────────────────
  const pb = ring[0];
  const pDepthF = sections[0].f, pDepthB = sections[0].b;
  const crotch = (z: number, dy: number): number => b.vert([0, yPB + dy * H, z], [0, -1, 0], [[J('hips'), 1]]);
  const cf = crotch(pDepthF * 0.50, -0.022), cb = crotch(-pDepthB * 0.50, -0.022), cm = crotch(0, -0.052);
  const legLoops: Record<'L' | 'R', number[]> = {
    L: [pb[6], cf, cm, cb, pb[18], pb[19], pb[20], pb[21], pb[22], pb[23], pb[0], pb[1], pb[2], pb[3], pb[4], pb[5]],
    R: [pb[6], pb[7], pb[8], pb[9], pb[10], pb[11], pb[12], pb[13], pb[14], pb[15], pb[16], pb[17], pb[18], cb, cm, cf],
  };
  const legSurface: ArmSurface = { L: [], R: [] };
  const legRingsOf: Record<'L' | 'R', number[][]> = { L: [], R: [] };
  const footRingsOf: Record<'L' | 'R', number[][]> = { L: [], R: [] };
  for (const s of ['L', 'R'] as const) {
    const ul = wp[J('upperleg_' + s)], ll = wp[J('lowerleg_' + s)], ft = wp[J('foot_' + s)];
    const { u: lu, v: lv } = perpFrame(sub(ll, ul));
    const loop = legLoops[s];
    let lc: V3 = [0, 0, 0];
    for (const vi of loop) lc = add(lc, b.P(vi));
    lc = scl(lc, 1 / loop.length);
    const loopAngs = loop.map((vi) => { const d = sub(b.P(vi), lc); return Math.atan2(dot(d, lv), dot(d, lu)); });
    let wind = 0;
    for (let i = 0; i < loop.length; i++) wind += angDiff(loopAngs[(i + 1) % loop.length], loopAngs[i]);
    const wd = wind >= 0 ? 1 : -1;
    const even = loop.map((_, i) => loopAngs[0] + wd * (i / loop.length) * Math.PI * 2);
    const slotDir = (k: number): V3 => add(scl(lu, Math.cos(even[k])), scl(lv, Math.sin(even[k])));
    const iUL = J('upperleg_' + s), iLL = J('lowerleg_' + s), iFt = J('foot_' + s), iHp = J('hips');
    const outer = Math.sign(ul[0]) || 1;
    const rings: number[][] = [loop];
    const legBase: V3 = [ul[0], yPB - 0.028 * H, ul[2]];
    const boneAt = (t: number): V3 => (t <= 1 ? lerp3(legBase, ll, t) : lerp3(ll, ft, t - 1));
    /** The leg TUBE point of slot k at fraction t: an ellipse (ru front/back, rv side) shaped (quads, calf, shin …),
     *  centred on the bone line, shifted OUTWARD on the thigh (legEcc: real thigh flesh sits lateral of the hip joint),
     *  and with a SOFT MEDIAL CAP — the inner side never comes nearer the midline than legClearance(t) (review
     *  topology#1 / weights#2 / proportions#5: v2@2 snapped rings 0–4 onto a flat wall at x = 2 mm and let the rings below
     *  cross the other leg by up to 4 cm). A soft-min (never above the plain radius) keeps it smooth in the sliders. */
    const tubeAt = (t: number, ru: number, rv: number, k: number): V3 => {
      const a = even[k], dirW = slotDir(k);
      const fz = dirW[2], sx = dirW[0] * outer;   // front (+Z) / outer (+) components
      let r = Math.hypot(ru * Math.cos(a), rv * Math.sin(a)) / Math.max(1e-9, Math.hypot(Math.cos(a), Math.sin(a)));
      if (t < 1) {
        r *= 1 + 0.06 * Math.max(0, fz) ** 2 * smooth(0.1, 0.45, t) * (1 - smooth(0.7, 0.95, t));   // the quads
        r *= 1 - 0.07 * Math.max(0, -fz) ** 2 * (1 - smooth(0.0, 0.35, t));                         // under the butt
      } else {
        const s2 = t - 1;
        r *= 1 + 0.16 * Math.max(0, -fz) ** 2 * gauss(s2 - 0.3, 0.13);                              // the calf
        r *= 1 - 0.05 * Math.max(0, fz) ** 2 * smooth(0.1, 0.5, s2);                                  // the shin
        r *= 1 + 0.05 * Math.max(0, -fz) ** 2 * gauss(s2 - 0.02, 0.05);                               // back of the knee
      }
      const e = legEcc(p, sockX, t);
      if (sx < -1e-6) r = smin(r, (sockX + e - legClearance(t) * H) / -sx, 0.004 * H);
      return add(add(boneAt(t), [outer * e, 0, 0]), scl(dirW, r));
    };
    // ring 0 = the thigh top: the pelvis loop shifted down (its outline: the hip contour), its crotch side moved across
    // onto the leg tube (separates L / R, the medial cap applies), the back tucked up + in under the butt (the gluteal fold).
    {
      let maxX = 1e-4; for (const vi of loop) maxX = Math.max(maxX, Math.abs(b.P(vi)[0]));
      const r0: number[] = loop.map((vi, i) => {
        const q = b.P(vi), wl = smooth(0.25, 0.85, Math.abs(q[0]) / maxX);
        const tq = tubeAt(0.04, LEG_RINGS[0][1] * lt, LEG_RINGS[0][2] * lt, i);
        const dirW = slotDir(i);
        const back = Math.max(0, -dirW[2]);
        // (x only from the tube: the depth stays the pelvis loop's, so the butt flows into the thigh without a step)
        const np: V3 = [lerp(tq[0], q[0], wl), q[1] - 0.028 * H + 0.010 * H * back * back, q[2] * 0.96 + 0.006 * H * back];
        return b.vert(np, norm([dirW[0], 0, dirW[2]]), legW(0.04, iHp, iUL, iLL, iFt));
      });
      rings.push(r0);
    }
    for (let ri = 0; ri < LEG_RINGS.length; ri++) {
      const [t, ru0, rv0] = LEG_RINGS[ri];
      const c = boneAt(t);
      const out: number[] = [];
      const m = ri === 0 ? 0.55 : ri === 1 ? 0.85 : 1;   // the first rings still carry the thigh top's shape
      for (let k = 0; k < LIMB_SIDES; k++) {
        let q = tubeAt(t, ru0 * lt, rv0 * lt, k);
        if (m < 1) q = lerp3(add(c, sub(b.P(rings[1][k]), legBase)), q, m);
        // the knee flexes backward: its flexion side is the BACK of the knee. Read from the slot's angle ON THE DEFAULT
        // BODY (kneeFlex), not this body's geometry, so the weights are identical for every param set.
        out.push(b.vert(q, slotDir(k), legW(t, iHp, iUL, iLL, iFt, kneeFlex(s, k))));
      }
      rings.push(out);
    }
    legRingsOf[s] = rings;
    // ── FOOT: the leg tube flows on through the ankle into the foot (review topology#3: v2@2 capped the leg at the ankle
    // and stuck a separate foot shell on, so the ankle bent in the shin). From the ankle ring the ring planes turn from
    // horizontal to vertical around the heel (front point F sliding down the instep, back point B down the Achilles,
    // round the heel, along the sole), then vertical sections run forward to the ball and a dome closes the toe end.
    // Sized by the HEIGHT (a limbThick key must not grow the foot 1.8× — review proportions#2: 0.72 head heights, a
    // cone heel), girth by limbThick.
    // (a longer-legged frame gets a slightly longer foot: the masc's reads ≈ 2 % of the stature longer than the fem's)
    const fl = H * lerp(1, p.limbThick, 0.2) * lerp(1, p.legLength / 1.2, 0.6), fw = H * lerp(1, p.limbThick, 0.6);
    const sole = ft[1] - FOOT_ANKLE_H * fl;
    const fRings: number[][] = [];
    for (const [tn, fy, fz, by, bz, rx, flat] of FOOT_RINGS) {
      const F: V3 = [ft[0], ft[1] + fy * fl, ft[2] + fz * fl], B: V3 = [ft[0], ft[1] + by * fl, ft[2] + bz * fl];
      const C = lerp3(F, B, 0.5), A = scl(sub(F, B), 0.5);
      const out: number[] = [];
      for (let k = 0; k < LIMB_SIDES; k++) {
        const d = slotDir(k);   // (x, 0, z): x = across the foot, z = front (+1, the instep / top) … back (−1, heel / sole)
        let q: V3 = add(add(C, scl(A, d[2])), [d[0] * rx * fw, 0, 0]);
        if (flat > 0 && d[2] < 0) q = [q[0], lerp(q[1], sole, flat * d[2] * d[2]), q[2]];   // the flat sole
        if (q[1] < sole) q = [q[0], sole, q[2]];
        const nrm = norm(add(scl(norm(A), d[2]), [d[0], 0, 0]));
        out.push(b.vert(q, nrm, legW(tn, iHp, iUL, iLL, iFt)));
      }
      fRings.push(out);
    }
    footRingsOf[s] = fRings;
    const toeApex = b.vert([ft[0], sole + FOOT_APEX[0] * fl, ft[2] + FOOT_APEX[1] * fl], [0, 0, 1], [[iFt, 1]]);
    tubeChart(b, [...rings, ...fRings], s === 'L' ? 2 : 14, { apex: toeApex });
    // the toes (rigid digits, foot-weighted), the big toe on the inner side
    const inner = ft[0] > 0 ? -1 : 1;
    const off = [0.024, 0.0105, -0.0010, -0.0120, -0.0225], tr = [0.0125, 0.0105, 0.0097, 0.0090, 0.0082], tl = [0.030, 0.026, 0.024, 0.021, 0.018];
    for (let k = 0; k < 5; k++) digit(b, [ft[0] + inner * off[k] * fw, sole + tr[k] * fw, ft[2] + (0.110 - 0.004 * Math.abs(k - 1)) * fl], [0, 0, 1], tl[k] * fl, tr[k] * fw, iFt, [0, -0.15, 0]);
  }
  // (No crotch "bridge": the two leg bands already share the crotch line pb[6]–cf–cm–cb–pb[18], so the surface is closed
  //  there. v1 also bridged the two thigh tops' inner edges, which stacks a third face on those edges — non-manifold.)
  void footRingsOf;

  // ── HEAD (v1's anime head, denser cranium) ────────────────────────────────────────────────────────────────────────
  const headRings = buildHead(b, head, p.headSize * H, clamp01(p.headShape), J('head'));
  const headFrame = ((): BodyV2HeadFrame => {
    const u = p.headSize * H, k = clamp01(p.headShape);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const rg of headRings.rings) for (const vi of rg) { const q = b.P(vi); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
    const crownY = head[1] + (0.172 + 0.002 * k) * u, v1Min = head[1] - 0.100 * u;
    return {
      joint: [head[0], head[1], head[2]], unit: u,
      chinY: head[1] + (ANIME_HEAD[0][0] - ANIME_HEAD[0][1]) * u, jawRowY: head[1] + HEAD_ROW0_DY * u,
      eyeY: v1Min + 0.55 * (crownY - v1Min), browY: head[1] + lerp(CLASSIC_HEAD[5][0], ANIME_HEAD[5][0], k) * u, crownY,
      faceFrontZ: z1, faceHalfWidth: (x1 - x0) / 2,
      v1Box: { min: [x0, v1Min, z0], max: [x1, crownY, z1] },
      jawRing: headRings.rings[0].map((vi) => b.P(vi)),
    };
  })();
  // the neck + head island, at 1.5x the body's texel density (the face is where painted detail goes)
  const headChart = tubeChart(b, [...ring.slice(R_NB), ...headRings.rings], COLB, { apex: headRings.apex, flipV: true, uvScale: HEAD_UV_SCALE });
  void headChart; void torsoChart;

  // ── WEIGHTS: shoulder + hip zones, then smoothing ─────────────────────────────────────────────────────────────────
  neckHeadWeights(b, headRings.rings, J('neck'), J('head'));
  shoulderWeights(b, ring, sockets, R_AP, R_ST, NR, R_UB);
  hipWeights(b, ring, legRingsOf, [cf, cm, cb]);

  // ── orientation, normals ──────────────────────────────────────────────────────────────────────────────────────────
  orientFaces(b);
  const N = vertexNormals(b);
  // (always on, at every headShape — v2@2 switched it off at exactly 0, a 59° normal jump the blend shapes then smeared
  //  over the whole −1…0 slider range: review pipeline#3)
  // (the face proxy is keyed on the head RINGS, not the head weight: the neck → head grade below puts head weight on the
  //  neck rings and neck weight on the jaw rows — the proxy's face box and blend must not move with it)
  const faceW = new Float64Array(b.count);
  for (const rg of headRings.rings) for (const vi of rg) faceW[vi] = 1;
  faceW[headRings.apex] = 1;
  faceNormalProxy(b, N, faceW, J('neck'), head, H, p.headSize * H, clamp01(p.headShape), lv.yNB);

  // ── surfaces for the v1 clothing generator (final positions, normals, top-2 weights) ──────────────────────────────
  const ringOut = (ids: number[], usePos: (i: number) => V3 = (i) => b.P(i)): ArmRing => {
    let c: V3 = [0, 0, 0];
    const verts = ids.map((vi) => {
      const q = usePos(vi);
      c = add(c, q);
      const [j0, w0, j1, w1] = top2(b, vi);
      return { p: q, n: [N[vi * 3], N[vi * 3 + 1], N[vi * 3 + 2]] as V3, j0, w0, j1, w1 };
    });
    return { center: scl(c, 1 / ids.length), verts };
  };
  for (const so of sockets) armSurface[so.side] = so.rings.slice(0, so.rings.length).map((rg) => ringOut(rg));
  for (const s of ['L', 'R'] as const) legSurface[s] = legRingsOf[s].slice(1).map((rg) => ringOut(rg));
  // Torso rings: real positions; the socket-hole interior (3 × 3 grid points with no faces) is filled by a Coons patch
  // over the moved armhole loop, so a torso-offset garment (the v1 undershirt) spans the armhole flush with the loop
  // the sleeve starts from, instead of cutting across it along the pre-socket surface (inside the shoulder).
  const holeFill = new Map<number, V3>();
  for (const base of [0, COLNX]) {
    const G = (r: number, d: number) => b.P(ring[R_AP + r][(base + d + TORSO_COLS) % TORSO_COLS]);
    for (let r = 1; r < 4; r++) for (let d = -1; d <= 1; d++) {
      const u = (d + 2) / 4, v = r / 4;
      const Lp = G(r, -2), Rp = G(r, 2), Bp = G(0, d), Tp = G(4, d);
      const c00 = G(0, -2), c10 = G(0, 2), c01 = G(4, -2), c11 = G(4, 2);
      const q: V3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) q[k] = (1 - u) * Lp[k] + u * Rp[k] + (1 - v) * Bp[k] + v * Tp[k]
        - ((1 - u) * (1 - v) * c00[k] + u * (1 - v) * c10[k] + (1 - u) * v * c01[k] + u * v * c11[k]);
      holeFill.set(ring[R_AP + r][(base + d + TORSO_COLS) % TORSO_COLS], q);
    }
  }
  const torsoSurface: ArmRing[] = ring.map((rg) => ringOut(rg, (vi) => holeFill.get(vi) ?? b.P(vi)));

  // ── emit vertices (unique position × chart × sub), UVs packed ─────────────────────────────────────────────────────
  const { vertices, indices, ji, jwts } = emit(b, N);

  // ── skeleton arrays ───────────────────────────────────────────────────────────────────────────────────────────────
  const jointLocalPositions = new Float32Array(JN * 3), jointLocalRotations = new Float32Array(JN * 4), jointLocalScales = new Float32Array(JN * 3);
  const inverseBindMatrices = new Float32Array(JN * 16);
  for (let i = 0; i < JN; i++) {
    jointLocalPositions.set(local[i], i * 3);
    jointLocalRotations.set([0, 0, 0, 1], i * 4);
    jointLocalScales.set([1, 1, 1], i * 3);
    const m = inverseBindMatrices.subarray(i * 16, i * 16 + 16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    m[12] = -wp[i][0]; m[13] = -wp[i][1]; m[14] = -wp[i][2];
  }
  const skinning: GltfSkinningData = {
    jointIndices: ji, jointWeights: jwts, inverseBindMatrices, jointNames: JOINTS.map((j) => j.name),
    skinName: 'character_v2_body', jointParents: new Int16Array(JOINTS.map((j) => j.parent)),
    jointLocalPositions, jointLocalRotations, jointLocalScales,
  };
  const geometry: MeshGeometry = { vertices, indices, format: '12float' };
  return {
    name: 'CharacterV2Body', geometry, armSurface, legSurface, torsoSurface,
    landmarks: {
      rings: { W: lv.R_W, UB: R_UB, A: lv.R_BA, AP: R_AP, ST: R_ST, NB: R_NB, JAW: R_JAW },
      shoulder: { neckBaseX: sections[R_NB].a, acromionX: armX.top },
      head: headFrame,
    },
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], diffuseImage: null, normalMapImage: null,
    diffuseColor: [0.9, 0.78, 0.72, 1], isTransparent: false, morphTargets: [], skinning,
  };
}

// ── weights ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** Arm ring weights by fraction t (0 = shoulder joint … 1 = elbow … 2 = wrist): clavicle → shoulder over the first
 *  rings, shoulder → lowerarm across the elbow (3 loops), lowerarm → hand across the wrist. */
function armWeights(t: number, iCl: number, iSh: number, iLo: number, iHa: number, flex = 0): [number, number][] {
  // the shoulder cap: the clavicle's share fades 0.45 → 0 over t 0.16 … 0.65 (v2@2: 0.30 over 0.20 … 0.45) — a longer,
  // C¹ ease so a forward raise past horizontal spreads over the cap and the arm below it stays on its bone (see
  // SHOULDER_SMOOTH_*; review deformation#1)
  const cl = 0.45 * (1 - smooth(0.16, 0.65, t));
  // (the wrist window stays: a wider one spreads a hand ROLL further up the forearm but bends the forearm under a wrist
  //  FLEX — measured 2026-10-05, review deformation#4: smooth(1.66, 2.10) took the roll's σ ratio 2.35 → 1.92 while the
  //  forearm 3–6 cm up moved 12 → 20 mm at a 70° flex. The roll belongs to an engine twist helper — see the spec.)
  const lo = hinge(t, 0.99, 0.15, flex), ha = smooth(1.74, 2.06, t);
  const w: [number, number][] = [];
  if (cl > 0) w.push([iCl, cl]);
  w.push([iSh, (1 - cl) * (1 - lo)]);
  if (lo > 0) w.push([iLo, (1 - cl) * lo * (1 - ha)]);
  if (ha > 0) w.push([iHa, (1 - cl) * lo * ha]);
  return w.filter((x) => x[1] > 1e-6);
}
/** A hinge joint's child share at fraction t (joint at c, half-width w). `flex` ∈ [−1, 1] = how much the vertex faces
 *  the FLEXION side (the inner elbow / the back of the knee). That side gets a WIDER transition (× 1 + 0.6·flex), so a
 *  deep bend spreads its compression over more loops instead of folding the crease; the extensor side (the elbow / knee
 *  point) a tighter one, so the point stays defined. Swept 2026-10-05 over −0.5…0.7 (elbow 120 / knee 130 / squat /
 *  sit / gait): folds 0.24 % → 0 at ≥ 0.5, collapse 1.13 → 0.68 %. Reads only the ring fraction + the vertex's slot →
 *  param-independent. */
const HINGE_FLEX = 0.6;
/** Leg slot 0's angle about the leg axis on the DEFAULT body (deg; the slot direction = sin·X − cos·Z, so 0 = the back,
 *  ±180 = the front): slot 0 is the pelvis front-centre vertex pb[6], which sits 38.5° MEDIAL of the knee's front (L at
 *  −141.5°, R mirrored), and the slots run +22.5° each on both legs. v2@2 read flex = −cos(2πk/16), i.e. slot 0 = the
 *  front: the wide (flexion-side) transition sat at the back-OUTER side — a twisted crease (inner vs outer 19–28 mm apart
 *  at knee 130–150) and the outer-front bulge (radial 1.20; review topology#2 / deformation#2). Fixed per side so the
 *  weights stay param-independent (over the slider ranges slot 0 moves 137–142°); gated in body-v2-generator.test. */
export const KNEE_SLOT0_DEG = 141.54;
/** The knee's flex field for leg slot k: +1 at the back of the knee (the flexion side), −1 at the kneecap. */
function kneeFlex(s: 'L' | 'R', k: number): number {
  return Math.cos(((s === 'L' ? -KNEE_SLOT0_DEG : KNEE_SLOT0_DEG) * Math.PI) / 180 + (2 * Math.PI * k) / LIMB_SIDES);
}
function hinge(t: number, c: number, w: number, flex: number): number {
  const k = 1 + HINGE_FLEX * flex;
  return smooth(c - w * k, c + w * k, t);
}
/** Leg ring weights by t (0 = hip … 1 = knee … 2 = ankle): hips → thigh at the top (smoothed later), 3 loops across the
 *  knee, lowerleg → foot at the ankle. */
function legW(t: number, iHp: number, iUL: number, iLL: number, iFt: number, flex = 0): [number, number][] {
  const hp = 0.45 * (1 - smooth(0.0, 0.32, t));
  // the ankle: centred ON the joint ring (t 2.0 = 0.5), now that the foot continues the leg tube (v2@2's
  // smooth(1.76, 2.06) put 0.55 foot weight 4 cm up the shin, so the shin bent 22° at a 40° plantarflex)
  const lo = hinge(t, 0.985, 0.165, flex), ft = smooth(1.88, 2.12, t);
  const w: [number, number][] = [];
  if (hp > 0) w.push([iHp, hp]);
  w.push([iUL, (1 - hp) * (1 - lo)]);
  if (lo > 0) w.push([iLL, (1 - hp) * lo * (1 - ft)]);
  if (ft > 0) w.push([iFt, (1 - hp) * lo * ft]);
  return w.filter((x) => x[1] > 1e-6);
}

/** Topological adjacency of the position graph (from the triangles). */
function adjacency(b: Builder): number[][] {
  const nb: Set<number>[] = Array.from({ length: b.count }, () => new Set<number>());
  for (let t = 0; t < b.tris.length; t += 3) {
    const a = b.tris[t], c = b.tris[t + 1], d = b.tris[t + 2];
    nb[a].add(c); nb[a].add(d); nb[c].add(a); nb[c].add(d); nb[d].add(a); nb[d].add(c);
  }
  return nb.map((s) => [...s].sort((x, y) => x - y));
}

/** The WEIGHT smoothing graph: the triangle graph plus every tube quad's other diagonal (the quad 8-neighbourhood).
 *  The triangles split every quad the same way, which the x-mirror maps onto the OTHER diagonal, so smoothing over the
 *  triangle graph alone made the L / R weights differ by up to 0.11 (review weights#4; posed twins 4–11 mm apart in
 *  symmetric poses). With both diagonals the graph is mirror-symmetric by construction; a no-diagonal 4-neighbour
 *  graph is symmetric too but folded more (review: shoulder folds 82 → 128). Normals keep adjacency() (G1's shading). */
function weightAdjacency(b: Builder): number[][] {
  const nb: Set<number>[] = Array.from({ length: b.count }, () => new Set<number>());
  for (let t = 0; t < b.tris.length; t += 3) {
    const a = b.tris[t], c = b.tris[t + 1], d = b.tris[t + 2];
    nb[a].add(c); nb[a].add(d); nb[c].add(a); nb[c].add(d); nb[d].add(a); nb[d].add(c);
  }
  for (let k = 0; k < b.altDiag.length; k += 2) { const a = b.altDiag[k], c = b.altDiag[k + 1]; if (a !== c) { nb[a].add(c); nb[c].add(a); } }
  return nb.map((x) => [...x].sort((p, q) => p - q));
}

/** Jacobi smoothing of the weight field over `zone` (others fixed), joints restricted to `allowed`; a vertex never
 *  takes a joint of the opposite side (`sideOf`). Topology only → param-independent. */
function smoothWeights(b: Builder, adj: number[][], zone: Set<number>, allowed: number[], iters: number, lambda: number, sideOf: (i: number) => 'L' | 'R' | 'C', forbid?: (i: number, j: number) => boolean): void {
  const W = b.W;
  const cur = new Float64Array(W), nxt = new Float64Array(W);
  const zl = [...zone].sort((x, y) => x - y);
  for (let it = 0; it < iters; it++) {
    for (const i of zl) {
      const nb = adj[i];
      if (!nb.length) continue;
      for (const j of allowed) {
        let s = 0; for (const q of nb) s += cur[q * JN + j];
        nxt[i * JN + j] = (1 - lambda) * cur[i * JN + j] + lambda * (s / nb.length);
      }
      const sd = sideOf(i);
      if (sd !== 'C') for (const j of allowed) if (SIDE_OF[j] !== 'C' && SIDE_OF[j] !== sd) nxt[i * JN + j] = 0;
      if (forbid) for (const j of allowed) if (forbid(i, j)) nxt[i * JN + j] = 0;
      let tot = 0; for (let j = 0; j < JN; j++) tot += nxt[i * JN + j];
      if (tot > 0) for (let j = 0; j < JN; j++) nxt[i * JN + j] /= tot;
    }
    cur.set(nxt);
  }
  for (const i of zl) for (let j = 0; j < JN; j++) W[i * JN + j] = cur[i * JN + j];
}

/** The neck → head transition, graded over 6 rings (review weights#1 / deformation#6 / topology#6): head share on the
 *  lower / mid / upper neck rings (spineKeys) and on the head's rows 0–2 (h0 = the under-jaw ring, h1 the jaw line, h2
 *  the mouth row) — the rest of the head is rigid. v2@2 handed 0 → 40 → 100 % head over the top two strips (4–6 cm
 *  below the head pivot), so a 20° nod swung the head-rigid jaw ring back into the throat (21–30 triangles inverted,
 *  18–26 vertices buried, v1 0) and a head turn sheared one strip (σ ratio 7–19). The neck rings stay neck-dominant
 *  (< 0.5) and the head rows head-dominant, so every head-weight classifier (the chin in proportions, the head box)
 *  reads the same rings as before. Ring-fixed → identical weights for every param set. */
export const NECK_GRADE: { readonly chest: readonly number[]; readonly head: readonly number[] } = Object.freeze({
  /** chest share on the trapezius top 2 rings, the neck base and the lower / mid / upper neck rings — the neck's own turn
   *  is spread too (v2@2: chest 0.8 → 0.45 across a 4–6 mm strip at the neck base, σ ratio 15 in a 75° turn) */
  chest: Object.freeze([0.9, 0.75, 0.55, 0.3, 0.05, 0]),
  /** head share on the lower / mid / upper neck rings and the head rows h0 / h1 / h2 */
  head: Object.freeze([0.18, 0.38, 0.46, 0.62, 0.92, 1]),
});
function neckHeadWeights(b: Builder, headRings: number[][], iNeck: number, iHead: number): void {
  for (let r = 0; r < 3; r++) {
    const g = NECK_GRADE.head[3 + r];
    if (g >= 1) continue;
    for (const vi of headRings[r]) b.setW(vi, [[iHead, g], [iNeck, 1 - g]]);
  }
}

/** The shoulder smoothing: arm rings 1–2 (t 0.24 / 0.33) with the loop + the torso around the hole, 12 passes. v2@2: 6
 *  passes and the clavicle share 0.30 over t 0.20 … 0.45, so the shoulder weight stepped 0.32 → 0.59 → 0.81 → 1 across
 *  the loop and the first rings and a forward raise past horizontal (the default Idle Stretch / Jump Reach go to
 *  140–160° from the T-bind) creased the front armpit (fwd-up 150: 11 / 22 triangles inverted; review deformation#1).
 *  With the longer clavicle ease (armWeights) the cap grades over t 0.16 … 0.65 and the arm is rigid from t 0.68.
 *  Swept 2026-10-05 against BOTH failure modes — the armpit crease in the raises AND the silhouette of the hanging arm:
 *  smoothing further down the arm (rings 1…3 – 1…6, 60–200 passes) removes the last few raise creases but leaves the
 *  cap lagging a rigid arm — the mid upper arm 3–6 cm off its bone at 150° (a rubber arm) and a notch in the outer
 *  outline of the RELAXED arm (column kink 42° vs 24–26° before) — so the reach stops at the cap. The armhole loop's
 *  height-based weights and the 'below the armpit never takes the upper arm' rule stay (around-the-loop weights and a
 *  narrower rule measured worse in the review). Gated in body-v2-metrics (inverted / crease / stretch, the arm on its
 *  bone, the outline kink). */
const SHOULDER_SMOOTH_ARM_RINGS = 2, SHOULDER_SMOOTH_ITERS = 12;
function shoulderWeights(b: Builder, ring: number[][], sockets: { side: 'L' | 'R'; loop: number[]; rings: number[][] }[], R_AP: number, R_ST: number, NR: number, R_UB: number): void {
  const iCh = J('chest');
  const adj = weightAdjacency(b);
  for (const so of sockets) {
    const s = so.side, iCl = J('clavicle_' + s), iSh = J('shoulder_' + s);
    const base = s === 'L' ? 0 : COLNX;
    // The armhole loop: chest / clavicle / shoulder by height on the loop (the armpit more chest, the top more clavicle).
    so.loop.forEach((vi, k) => {
      const top = (1 - Math.cos(((k - 2) / LIMB_SIDES) * Math.PI * 2)) / 2;   // 0 at the armpit (loop[2]) → 1 at the top
      b.setW(vi, [[iCh, lerp(0.55, 0.25, top)], [iCl, lerp(0.20, 0.45, top)], [iSh, lerp(0.25, 0.30, top)]]);
    });
    // the trapezius / upper chest near the shoulder: some clavicle
    for (let r = R_ST; r < Math.min(NR, R_ST + 4); r++) for (let d = -4; d <= 4; d++) {
      const c = (base + d + TORSO_COLS) % TORSO_COLS, vi = ring[r][c];
      if (so.loop.includes(vi)) continue;
      const k = (1 - Math.abs(d) / 5) * (1 - (r - R_ST) / 4);
      const cur: [number, number][] = [];
      for (let j = 0; j < JN; j++) if (b.W[vi * JN + j] > 0) cur.push([j, b.W[vi * JN + j] * (1 - 0.5 * k)]);
      cur.push([iCl, 0.5 * k]);
      b.setW(vi, cur);
    }
    // Smooth the shoulder zone: the torso grid within 3 steps of the hole + the loop + arm rings 1–2 (SHOULDER_SMOOTH_*).
    const zone = new Set<number>();
    // (the lower bound is the under-bust ring R_UB: the same physical reach as v2@2's R_AP − 3 before the bust rings)
    for (let r = R_UB; r <= R_ST + 3; r++) for (let d = -5; d <= 5; d++) {
      if (r < 0 || r >= NR) continue;
      const c = (base + d + TORSO_COLS) % TORSO_COLS;
      if (Math.abs(d) <= 4 && r > R_UB && r < R_ST + 3) zone.add(ring[r][c]);
    }
    for (let k = 1; k <= SHOULDER_SMOOTH_ARM_RINGS; k++) for (const vi of so.rings[k]) zone.add(vi);
    const allowed = [iCh, iCl, iSh, J('spine'), J('neck')];
    // The ribcage side BELOW the armpit never takes the upper arm: with shoulder weight it swung outward about the
    // shoulder joint as the arm came down (out through a shirt's side panel; garment test, 2026-10-05).
    const below = new Set<number>();
    for (let r = 0; r < R_AP; r++) for (const vi of ring[r]) below.add(vi);
    smoothWeights(b, adj, zone, allowed, SHOULDER_SMOOTH_ITERS, 0.5, () => s, (i, j) => j === iSh && below.has(i));
  }
}

function hipWeights(b: Builder, ring: number[][], legs: Record<'L' | 'R', number[][]>, crotch: number[]): void {
  const iHp = J('hips'), iL = J('upperleg_L'), iR = J('upperleg_R');
  // pelvis rings near the legs pick up a little thigh (the side follows the leg), then a smoothing pass spreads it.
  for (let r = 0; r <= 2; r++) for (let c = 0; c < TORSO_COLS; c++) {
    const vi = ring[r][c], x = b.P(vi)[0];
    if (Math.abs(x) < 1e-6) continue;
    const k = [0.30, 0.12, 0.04][r];
    const cur: [number, number][] = [];
    for (let j = 0; j < JN; j++) if (b.W[vi * JN + j] > 0) cur.push([j, b.W[vi * JN + j] * (1 - k)]);
    cur.push([x > 0 ? iL : iR, k]);
    b.setW(vi, cur);
  }
  const adj = weightAdjacency(b);
  const zone = new Set<number>();
  for (let r = 0; r <= 4; r++) for (const vi of ring[r]) zone.add(vi);
  for (const s of ['L', 'R'] as const) for (let k = 1; k <= 4; k++) for (const vi of legs[s][k]) zone.add(vi);
  for (const vi of crotch) zone.add(vi);
  const legSide = new Map<number, 'L' | 'R'>();
  for (const s of ['L', 'R'] as const) for (let k = 1; k < legs[s].length; k++) for (const vi of legs[s][k]) legSide.set(vi, s);
  const sideOf = (i: number): 'L' | 'R' | 'C' => {
    const s = legSide.get(i);
    if (s) return s;
    const x = b.pos[i * 3];
    return Math.abs(x) < 1e-6 ? 'C' : x > 0 ? 'L' : 'R';
  };
  smoothWeights(b, adj, zone, [iHp, iL, iR, J('lowerback')], 14, 0.55, sideOf);
}

function top2(b: Builder, vi: number): [number, number, number, number] {
  let j0 = 0, w0 = -1, j1 = 0, w1 = -1;
  for (let j = 0; j < JN; j++) {
    const w = b.W[vi * JN + j];
    if (w > w0) { j1 = j0; w1 = w0; j0 = j; w0 = w; } else if (w > w1) { j1 = j; w1 = w; }
  }
  if (w1 <= 0) return [j0, 1, j0, 0];
  const s = w0 + w1;
  return [j0, w0 / s, j1, w1 / s];
}

// ── digits ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A finger / toe: an 8-gon tapering tube with a curl, closed by a rounded dome (its own UV chart). */
function digit(b: Builder, base: V3, dir: V3, length: number, r0: number, joint: number, curl: V3 = [0, 0, 0]): void {
  const d = norm(dir), { u, v } = perpFrame(d);
  const at = (t: number): V3 => add(add(base, scl(d, length * t)), scl(curl, length * t * t));
  const PROF: [number, number][] = [[0, 1], [0.25, 0.95], [0.5, 0.86], [0.7, 0.8], [0.86, 0.7], [1, 0.5]];
  const rings = PROF.map(([t, rf]) => {
    const out: number[] = [];
    for (let k = 0; k < DIGIT_SIDES; k++) {
      const a = (k / DIGIT_SIDES) * Math.PI * 2, dd = add(scl(u, Math.cos(a)), scl(v, Math.sin(a)));
      out.push(b.vert(add(at(t), scl(dd, r0 * rf)), dd, [[joint, 1]]));
    }
    return out;
  });
  const tip = b.vert(add(at(1), scl(d, r0 * 0.34)), d, [[joint, 1]]);
  const back = b.vert(add(at(0), scl(d, -r0 * 0.3)), scl(d, -1), [[joint, 1]]);
  tubeChart(b, rings, DIGIT_SIDES / 4 * 3, { apex: tip, startApex: back });
}

// ── head ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// v1's head ring tables (body-generator.ts CLASSIC_HEAD_RINGS / ANIME_HEAD_RINGS), copied: [dy, r] and
// [dy, front drop, rx, rzFront, rzBack] in head units (× headSize·H), dy × H about the head joint.
const CLASSIC_HEAD: readonly (readonly [number, number])[] = [[-0.060, 0.040], [-0.028, 0.050], [-0.006, 0.066],
  [0.026, 0.082], [0.040, 0.085], [0.078, 0.090], [0.112, 0.082], [0.142, 0.058], [0.162, 0.030]];
const ANIME_HEAD: readonly (readonly [number, number, number, number, number])[] = [
  [-0.040, 0.016, 0.046, 0.042, 0.040], [-0.020, 0.026, 0.060, 0.058, 0.050], [-0.004, 0.000, 0.076, 0.063, 0.066],
  [0.022, 0.000, 0.085, 0.071, 0.081], [0.040, 0.000, 0.088, 0.073, 0.085], [0.078, 0.000, 0.091, 0.075, 0.092],
  [0.112, 0.000, 0.088, 0.071, 0.090], [0.142, 0.000, 0.070, 0.057, 0.073], [0.162, 0.000, 0.044, 0.036, 0.047],
];
/** Ring rows of the v2 head: the v1 rows 0–5 (jaw → brow) as-is, then the cranium as an ellipsoid cap through v1's
 *  rows 6–8 at 6 elevations (v1 had 3) → a smooth round skull. Each row: [dy, drop, rx, rzF, rzB] at shape k. */
function headRows(k: number): [number, number, number, number, number][] {
  const L = (a: number, c: number) => a + (c - a) * k;
  const row = (i: number): [number, number, number, number, number] => {
    const [cdy, cr] = CLASSIC_HEAD[i], [ady, drop, arx, arzF, arzB] = ANIME_HEAD[i];
    return [L(cdy, ady), drop * k, L(cr, arx), L(cr, arzF), L(cr, arzB)];
  };
  // row 0 (the jaw / under-chin ring) is the ANIME row at every headShape: the neck → jaw band is then the same for
  // every value (review proportions#10: the classic row 0 sat 2 mm above the neck's top ring — a ledge round the jaw)
  const out = [0, 1, 2, 3, 4, 5].map((i) => (i === 0 ? [...ANIME_HEAD[0]] as [number, number, number, number, number] : row(i)));
  const brow = out[5], top = L(0.172, 0.174);
  const cy = brow[0], ry = top - cy;
  for (const deg of [19, 34, 48, 61, 73, 83]) {
    const e = (deg * Math.PI) / 180, cosE = Math.cos(e);
    // the classic head's cranium is a little narrower (its rows 6–8 taper faster) — follow it as k → 0
    const taper = L(0.93, 1);
    out.push([cy + ry * Math.sin(e), 0, brow[2] * cosE * taper, brow[3] * cosE * taper, brow[4] * cosE * taper]);
  }
  return out;
}

/** The head: every row offset (heights AND radii) × hs = headSize·H about the head joint — a UNIFORM head scale (the
 *  head joint is a bone offset that keeps row 0 still, localPositions). v2@2 scaled only the widths (review
 *  proportions#7/#8: headSize +1 made a head wider than tall, −1 did nothing). */
function buildHead(b: Builder, head: V3, hs: number, k: number, joint: number): { rings: number[][]; apex: number } {
  const rows = headRows(k);
  const rings: number[][] = [];
  for (const [dy, dr, rx0, rzF0, rzB0] of rows) {
    const rx = rx0 * hs, rzF = rzF0 * hs, rzB = rzB0 * hs;
    const out: number[] = [];
    for (let c = 0; c < TORSO_COLS; c++) {
      const ang = (c / TORSO_COLS) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
      const rz = sa > 0 ? rzF : rzB;
      const y = head[1] + (dy - (sa > 0 ? dr * sa * sa : 0)) * hs;
      out.push(b.vert([head[0] + rx * ca, y, head[2] + rz * sa], norm([ca / Math.max(rx, 1e-6), 0, sa / Math.max(rz, 1e-6)]), [[joint, 1]]));
    }
    rings.push(out);
  }
  const apex = b.vert([head[0], head[1] + (0.172 + (0.174 - 0.172) * k) * hs, head[2]], [0, 1, 0], [[joint, 1]]);
  // v1's profile pushes on the front column(s) (classic × (1 − k), anime × k) — rows 0–6 are v1's rows 0–5 + the first
  // cranium row (≈ v1 row 6).
  const push = (rg: number[], dz: number, dy: number, spread: number): void => {
    for (let o = -spread; o <= spread; o++) {
      const col = (COLF + o + TORSO_COLS) % TORSO_COLS, f = spread === 0 ? 1 : Math.cos((o / (spread + 1)) * Math.PI * 0.5);
      const vi = rg[col];
      b.pos[vi * 3 + 1] += dy * f * hs; b.pos[vi * 3 + 2] += dz * f * hs;
    }
  };
  const [h0, h1, h2, h3, h4, h5, h6] = rings;
  const c = 1 - k;
  if (c > 0) {
    // (no classic push on h0: row 0 stays the anime jaw ring — see headRows)
    push(h1, 0.026 * c, -0.012 * c, 3); push(h2, 0.016 * c, 0, 3);
    push(h3, 0.020 * c, 0, 0); push(h4, 0.004 * c, -0.012 * c, 0); push(h5, -0.004 * c, 0, 0); push(h6, -0.004 * c, 0, 0);
  }
  push(h0, -0.003, 0, 3); push(h1, 0.008 * k, 0, 2); push(h2, 0.008 * k, 0, 3);
  push(h3, 0.013 * k, 0, 0); push(h4, 0.003 * k, -0.010 * k, 0); push(h5, -0.002 * k, 0, 0); push(h6, -0.002 * k, 0, 0);
  return { rings, apex };
}

// ── orientation + normals ─────────────────────────────────────────────────────────────────────────────────────────
/** Outward winding PER CHART (a tube's faces are consistently wound by construction, so one majority vote per chart
 *  decides it) — never per face, which would let a concave spot flip with the params (= a changing index buffer). */
function orientFaces(b: Builder): void {
  const P = b.pos, R = b.ref, vote = new Float64Array(b.charts.length);
  for (let t = 0; t < b.tris.length; t += 3) {
    const a = b.tris[t], c = b.tris[t + 1], d = b.tris[t + 2];
    const e1: V3 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const e2: V3 = [P[d * 3] - P[a * 3], P[d * 3 + 1] - P[a * 3 + 1], P[d * 3 + 2] - P[a * 3 + 2]];
    const r: V3 = [R[a * 3] + R[c * 3] + R[d * 3], R[a * 3 + 1] + R[c * 3 + 1] + R[d * 3 + 1], R[a * 3 + 2] + R[c * 3 + 2] + R[d * 3 + 2]];
    vote[b.cChart[t]] += Math.sign(dot(cross(e1, e2), r));
  }
  for (let t = 0; t < b.tris.length; t += 3) {
    if (vote[b.cChart[t]] >= 0) continue;
    const c = b.tris[t + 1]; b.tris[t + 1] = b.tris[t + 2]; b.tris[t + 2] = c;
    const s1 = b.cSub[t + 1]; b.cSub[t + 1] = b.cSub[t + 2]; b.cSub[t + 2] = s1;
  }
}
/** Angle-weighted smooth vertex normals on the POSITION graph (so UV seams never show). */
function vertexNormals(b: Builder): Float64Array {
  const P = b.pos, N = new Float64Array(b.count * 3);
  for (let t = 0; t < b.tris.length; t += 3) {
    const ids = [b.tris[t], b.tris[t + 1], b.tris[t + 2]];
    const p0 = b.P(ids[0]), p1 = b.P(ids[1]), p2 = b.P(ids[2]);
    const fn = cross(sub(p1, p0), sub(p2, p0));
    const fl = len(fn);
    if (fl < 1e-14) continue;
    const n = scl(fn, 1 / fl);
    const ps = [p0, p1, p2];
    for (let k = 0; k < 3; k++) {
      const e1 = norm(sub(ps[(k + 1) % 3], ps[k])), e2 = norm(sub(ps[(k + 2) % 3], ps[k]));
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(e1, e2))));
      for (let q = 0; q < 3; q++) N[ids[k] * 3 + q] += n[q] * ang;
    }
  }
  for (let i = 0; i < b.count; i++) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
    if (l < 1e-12) { N[i * 3] = b.ref[i * 3]; N[i * 3 + 1] = b.ref[i * 3 + 1]; N[i * 3 + 2] = b.ref[i * 3 + 2]; continue; }
    N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l;
  }
  void P;
  return N;
}

/** v1's ANIME FACE NORMALS (faceNormalProxy, body-generator.ts) on the v2 head: the face front shades as one calm plane
 *  (an ellipsoid proxy bent toward +Z), fading in over the jaw. Normals only. */
function faceNormalProxy(b: Builder, N: Float64Array, faceW: Float64Array, neckIdx: number, head: V3, H: number, hs: number, k: number, yNB: number): void {
  const n = b.count, W = b.W;
  const headW = (i: number) => faceW[i];
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (headW(i) < 0.5) continue;
    const x = b.pos[i * 3], y = b.pos[i * 3 + 1], z = b.pos[i * 3 + 2];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  if (!(x1 > x0) || !(y1 > y0) || !(z1 > z0)) return;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2, rz = (z1 - z0) / 2;
  const FLATTEN = 0.9;
  const jawAt = (x: number, z: number): [number, number] => {
    const dx = x - head[0], dz = z - head[2], r = Math.hypot(dx, dz), sf = r > 1e-9 ? dz / r : 0, s2 = sf > 0 ? sf * sf : 0;
    // row 0 is the anime jaw ring at every k (headRows); row 1 blends classic → anime
    const dy0 = ANIME_HEAD[0][0] - ANIME_HEAD[0][1] * s2;
    const dy1 = CLASSIC_HEAD[1][0] + (ANIME_HEAD[1][0] - CLASSIC_HEAD[1][0]) * k - ANIME_HEAD[1][1] * k * s2;
    return [head[1] + dy0 * hs, head[1] + dy1 * hs];
  };
  for (let i = 0; i < n; i++) {
    const w = headW(i);
    if (w <= 0) continue;
    const x = b.pos[i * 3], y = b.pos[i * 3 + 1], z = b.pos[i * 3 + 2];
    let ex = (x - cx) / (rx * rx), ey = (y - cy) / (ry * ry), ez = (z - cz) / (rz * rz);
    let el = Math.hypot(ex, ey, ez);
    if (el < 1e-9) continue;
    ex /= el; ey /= el; ez /= el;
    const fz = clamp01((ez - 0.05) / 0.45), f = FLATTEN * fz * fz * (3 - 2 * fz);
    ex *= 1 - f; ey *= 1 - f; ez += (1 - ez) * f;
    el = Math.hypot(ex, ey, ez); ex /= el; ey /= el; ez /= el;
    const [d0, d1] = jawAt(x, z);
    const t = clamp01(((y - d0) / Math.max(1e-6, d1 - d0) - 0.3) / 0.7);
    const kk = Math.min(1, w) * t * t * (3 - 2 * t);
    if (kk <= 0) continue;
    let nx = N[i * 3] + (ex - N[i * 3]) * kk, ny = N[i * 3 + 1] + (ey - N[i * 3 + 1]) * kk, nz = N[i * 3 + 2] + (ez - N[i * 3 + 2]) * kk;
    const l = Math.hypot(nx, ny, nz); if (l < 1e-6) continue;
    nx /= l; ny /= l; nz /= l;
    N[i * 3] = nx; N[i * 3 + 1] = ny; N[i * 3 + 2] = nz;
  }
  // v1's animeNeckShade: the under-jaw + upper neck normals tip down (a soft V shadow under the chin), never lit above
  // the face plane. The jaw ring is the same at every headShape now, so the shade is too (a = 1); its radial reach fades
  // out smoothly (a hard r > maxR cut flipped a nape vertex 34° as torsoThick crossed it: review pipeline#3).
  const a = 1, maxR = 0.075 * hs;
  const gain = new Float64Array(n);   // how strongly each vertex was re-aimed (0 at the zone's edge) → the smoothing below
  for (let i = 0; i < n; i++) {
    const x = b.pos[i * 3], y = b.pos[i * 3 + 1], z = b.pos[i * 3 + 2];
    const dx = x - head[0], dz = z - head[2], r = Math.hypot(dx, dz);
    const rf = 1 - smooth(0.7 * maxR, 1.35 * maxR, r);
    if (rf <= 0 || y > head[1]) continue;
    const [yy0, yy1] = jawAt(x, z);
    if (y > yy1 + 1e-6) continue;
    const sf = r > 1e-9 ? dz / r : 0, front = sf > 0 ? sf * sf : 0;
    let w: number;
    if (y > yy0) w = rf * a * (1 - smooth(0.2, 0.75, (y - yy0) / Math.max(1e-6, yy1 - yy0)));
    else { const depth = (yy0 - y) / H, span = 0.028 + 0.055 * front; w = rf * a * (1 - smooth(span * 0.35, span, depth)); }
    let nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    if (w > 0) {
      const ox = r > 1e-9 ? dx / r : 0, oz = r > 1e-9 ? dz / r : 0, D = norm([ox * 0.95, -0.9, oz * 0.95]);
      nx += (D[0] - nx) * w; ny += (D[1] - ny) * w; nz += (D[2] - nz) * w;
    }
    // the neck proper (v2: faded in ABOVE the neck base ring, so the trapezius → neck seam has no shading step)
    const neckK = W[i * JN + neckIdx] >= 0.3 || (yy0 - y) < 0.15 * H ? rf * a * smooth(yNB, yNB + 0.03 * H, y) : 0;
    if (neckK > 0) {
      const n0: V3 = [nx, ny, nz];
      if (ny > 0) ny *= 1 - neckK;
      const fl = neckK * 0.8 * smooth(-0.2, 0.6, sf) * (1 - w);
      if (fl > 0) { nx -= nx * fl; ny -= ny * fl; nz += (1 - nz) * fl; }
      ny = Math.min(ny, lerp(n0[1], -0.2, neckK));
    } else if (w <= 0) continue;
    const l = Math.hypot(nx, ny, nz); if (l < 1e-6) continue;
    N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nz / l;
    gain[i] = Math.max(w, neckK);
  }
  // Relax the re-aimed normals over the position graph (3 Jacobi passes, each vertex by its own gain, so the zone's
  // edge stays continuous in the params): the per-vertex shade varies fast across a ring, and under a toon ramp the
  // shadow under the chin read as a sawtooth along the triangle diagonals (review proportions#13).
  const adj = adjacency(b);
  for (let it = 0; it < 3; it++) {
    const cur = new Float64Array(N);
    for (let i = 0; i < n; i++) {
      const g = Math.min(1, 2 * gain[i]);
      if (g <= 0 || !adj[i].length) continue;
      let sx = 0, sy = 0, sz = 0;
      for (const j of adj[i]) { sx += cur[j * 3]; sy += cur[j * 3 + 1]; sz += cur[j * 3 + 2]; }
      const m = adj[i].length, lam = 0.6 * g;
      const nx = cur[i * 3] + (sx / m - cur[i * 3]) * lam, ny = cur[i * 3 + 1] + (sy / m - cur[i * 3 + 1]) * lam, nz = cur[i * 3 + 2] + (sz / m - cur[i * 3 + 2]) * lam;
      const l = Math.hypot(nx, ny, nz); if (l < 1e-6) continue;
      N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nz / l;
    }
  }
}

// ── emission: unique (position, chart, sub) corners → vertices; per-chart UV unwrap + a uniform-scale shelf pack ──────
function emit(b: Builder, N: Float64Array): { vertices: Float32Array; indices: Uint32Array; ji: Uint8Array; jwts: Float32Array } {
  const key = (p: number, ch: number, s: number) => (p * 4096 + ch) * 4096 + s;
  const map = new Map<number, number>();
  const corners: { p: number; ch: number; s: number }[] = [];
  const indices = new Uint32Array(b.tris.length);
  for (let t = 0; t < b.tris.length; t++) {
    const p = b.tris[t], ch = b.cChart[t], s = b.cSub[t], k = key(p, ch, s);
    let vi = map.get(k);
    if (vi === undefined) { vi = corners.length; map.set(k, vi); corners.push({ p, ch, s }); }
    indices[t] = vi;
  }
  // chart-local UVs (metres), then per island: v DOWN the body (flipV), the head's density factor, and u mirrored where
  // the island read mirrored (a majority vote of the UV winding against the outward 3D winding, per island, never per
  // face — the image-down convention, v = 0 at the image top). v2@2's legs / feet / digits were mirrored and its torso /
  // head islands upside down, so painted text read backwards (review downstream#2).
  const uv = new Float64Array(corners.length * 2);
  const chartUV = b.charts.map((c) => chartUnwrap(b, c));
  corners.forEach((c, i) => {
    const ch = b.charts[c.ch], q = chartUV[c.ch](c.p, c.s), k = ch.kind === 'tube' ? (ch.uvScale ?? 1) : 1;
    uv[i * 2] = q[0] * k; uv[i * 2 + 1] = (ch.kind === 'tube' && ch.flipV ? -q[1] : q[1]) * k;
  });
  {
    const vote = new Float64Array(b.charts.length);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], c1 = indices[t + 1], c2 = indices[t + 2];
      const det = (uv[c1 * 2] - uv[a * 2]) * (uv[c2 * 2 + 1] - uv[a * 2 + 1]) - (uv[c2 * 2] - uv[a * 2]) * (uv[c1 * 2 + 1] - uv[a * 2 + 1]);
      vote[corners[a].ch] += Math.sign(det);
    }
    corners.forEach((c, i) => { if (vote[c.ch] > 0) uv[i * 2] = -uv[i * 2]; });
  }
  // pack: bounding boxes per chart → shelves, uniform scale (texel density is the same on every island)
  const nC = b.charts.length, bb = Array.from({ length: nC }, () => [Infinity, Infinity, -Infinity, -Infinity]);
  corners.forEach((c, i) => {
    const r = bb[c.ch];
    r[0] = Math.min(r[0], uv[i * 2]); r[1] = Math.min(r[1], uv[i * 2 + 1]); r[2] = Math.max(r[2], uv[i * 2]); r[3] = Math.max(r[3], uv[i * 2 + 1]);
  });
  const pad = 0.018;   // gutters: about 8 px at 1024 (v2@2: 5-6 px, gone by mip 2)
  const order = [...Array(nC).keys()].filter((c) => bb[c][2] >= bb[c][0]).sort((x, y) => ((bb[y][3] - bb[y][1]) - (bb[x][3] - bb[x][1])) || (x - y));
  let area = 0; for (const c of order) area += (bb[c][2] - bb[c][0] + pad) * (bb[c][3] - bb[c][1] + pad);
  let best: { off: Map<number, [number, number]>; size: number } | null = null;
  for (let wTry = Math.sqrt(area) * 0.9; wTry <= Math.sqrt(area) * 1.6; wTry += Math.sqrt(area) * 0.05) {
    const off = new Map<number, [number, number]>();
    let x = 0, y = 0, rowH = 0, maxW = 0;
    for (const c of order) {
      const w = bb[c][2] - bb[c][0] + pad, h = bb[c][3] - bb[c][1] + pad;
      if (x + w > wTry && x > 0) { x = 0; y += rowH; rowH = 0; }
      off.set(c, [x - bb[c][0] + pad / 2, y - bb[c][1] + pad / 2]);
      x += w; rowH = Math.max(rowH, h); maxW = Math.max(maxW, x);
    }
    const size = Math.max(maxW, y + rowH);
    if (!best || size < best.size - 1e-12) best = { off, size };
  }
  const vertices = new Float32Array(corners.length * 12), ji = new Uint8Array(corners.length * 4), jwts = new Float32Array(corners.length * 4);
  corners.forEach((c, i) => {
    const o = i * 12, p = c.p;
    const nx = N[p * 3], ny = N[p * 3 + 1], nz = N[p * 3 + 2];
    vertices[o] = b.pos[p * 3]; vertices[o + 1] = b.pos[p * 3 + 1]; vertices[o + 2] = b.pos[p * 3 + 2];
    vertices[o + 3] = nx; vertices[o + 4] = ny; vertices[o + 5] = nz;
    const off = best!.off.get(c.ch)!;
    vertices[o + 6] = (uv[i * 2] + off[0]) / best!.size; vertices[o + 7] = (uv[i * 2 + 1] + off[1]) / best!.size;
    // top 4 influences (ties → the lower joint index), renormalised
    const ws: [number, number][] = [];
    for (let j = 0; j < JN; j++) { const w = b.W[p * JN + j]; if (w > 1e-5) ws.push([j, w]); }
    ws.sort((x, y) => (y[1] - x[1]) || (x[0] - y[0]));
    const top = ws.slice(0, 4);
    let s = 0; for (const [, w] of top) s += w;
    top.forEach(([j, w], k) => { ji[i * 4 + k] = j; jwts[i * 4 + k] = w / s; });
  });
  uvTangents(vertices, indices);
  return { vertices, indices, ji, jwts };
}

/** Tangents from the UVs (dP/du, Gram-Schmidt against the normal) with the handedness in w (the shader's bitangent is
 *  cross(N, T) * w = dP/dv) - v2@2 wrote cross(N, up) with w = +1, unrelated to the UVs, so no normal map could shade. */
function uvTangents(V: Float32Array, I: Uint32Array): void {
  const n = V.length / 12, T = new Float64Array(n * 3), B = new Float64Array(n * 3);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b1 = I[t + 1], c = I[t + 2];
    const e1 = [V[b1 * 12] - V[a * 12], V[b1 * 12 + 1] - V[a * 12 + 1], V[b1 * 12 + 2] - V[a * 12 + 2]];
    const e2 = [V[c * 12] - V[a * 12], V[c * 12 + 1] - V[a * 12 + 1], V[c * 12 + 2] - V[a * 12 + 2]];
    const du1 = V[b1 * 12 + 6] - V[a * 12 + 6], dv1 = V[b1 * 12 + 7] - V[a * 12 + 7], du2 = V[c * 12 + 6] - V[a * 12 + 6], dv2 = V[c * 12 + 7] - V[a * 12 + 7];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-14) continue;
    const f = 1 / det;
    for (const vi of [a, b1, c]) for (let k = 0; k < 3; k++) {
      T[vi * 3 + k] += f * (dv2 * e1[k] - dv1 * e2[k]);
      B[vi * 3 + k] += f * (du1 * e2[k] - du2 * e1[k]);
    }
  }
  for (let i = 0; i < n; i++) {
    const o = i * 12, nx = V[o + 3], ny = V[o + 4], nz = V[o + 5];
    let tx = T[i * 3], ty = T[i * 3 + 1], tz = T[i * 3 + 2];
    const d = nx * tx + ny * ty + nz * tz; tx -= nx * d; ty -= ny * d; tz -= nz * d;
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-12) { const q = norm(cross([nx, ny, nz], Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0])); [tx, ty, tz] = q; l = 1; }
    tx /= l; ty /= l; tz /= l;
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    V[o + 8] = tx; V[o + 9] = ty; V[o + 10] = tz; V[o + 11] = cx * B[i * 3] + cy * B[i * 3 + 1] + cz * B[i * 3 + 2] < 0 ? -1 : 1;
  }
}
/** The neck + head island's texel-density factor (the face carries the painted detail). */
const HEAD_UV_SCALE = 1.5;

/** A chart's local unwrap: (position, sub) → [u, v] in metres. Tubes: u = arc length around the ring from the seam
 *  (sub 1 = the far copy of the seam column), v = cumulative distance along each column; poles at the column midpoint. */
function chartUnwrap(b: Builder, c: Chart): (p: number, s: number) => [number, number] {
  if (c.kind === 'planar') return (p) => { const q = b.P(p); return [dot(q, c.axes[0]), dot(q, c.axes[1])]; };
  const src = c.virt ?? b.pos;
  const P = (i: number): V3 => [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]];
  const n = c.rings[0].length, R = c.rings.length;
  const where = new Map<number, [number, number]>();
  c.rings.forEach((rg, r) => rg.forEach((vi, k) => { if (!where.has(vi)) where.set(vi, [r, k]); }));
  // u: per ring, arc length from the seam; centred on the ring's half length so the island is symmetric
  const U: number[][] = [], Ltot: number[] = [];
  for (let r = 0; r < R; r++) {
    const rg = c.rings[r], u = new Array(n + 1).fill(0);
    for (let i = 1; i <= n; i++) u[i] = u[i - 1] + len(sub(P(rg[(c.seam + i) % n]), P(rg[(c.seam + i - 1) % n])));
    Ltot.push(u[n]); U.push(u);
  }
  // v = the cumulative MEAN ring-to-ring step (every ring a straight row): per-column distances shear wherever the
  // columns' lengths differ between two rings — the foot's bend (the instep column ~3 cm, the heel's ~10 cm) gave
  // slivers with anisotropy in the thousands.
  const V: number[][] = [];
  for (let r = 0; r < R; r++) {
    let step = 0;
    if (r > 0) { for (let k = 0; k < n; k++) step += len(sub(P(c.rings[r][k]), P(c.rings[r - 1][k]))); step /= n; }
    V.push(new Array(n).fill(r > 0 ? V[r - 1][0] + step : 0));
  }
  // u = the arc FRACTION around the ring x a SMOOTHED ring length (Gaussian over the rings' mean v, sigma 3 cm): where
  // the rings change length fast (the shoulder band -> the neck, the cranium) the seam edge no longer slants across a few
  // millimetres of v (v2@2: UV anisotropy up to ~3900 at the nape - review downstream#3).
  const Vm = V.map((row) => row.reduce((x, y) => x + y, 0) / n);
  const Ls = Ltot.map((_, r) => {
    let sw = 0, sl = 0;
    for (let j = 0; j < R; j++) { const w = Math.exp(-((Vm[r] - Vm[j]) ** 2) / (2 * 0.03 * 0.03)); sw += w; sl += w * Ltot[j]; }
    return sl / sw;
  });
  const uOf = (r: number, k: number, s: number): number => {
    const idx = (k - c.seam + n) % n, uu = idx === 0 && s === 1 ? U[r][n] : U[r][idx];
    return (uu / Math.max(1e-12, Ltot[r]) - 0.5) * Ls[r];
  };
  return (p, s) => {
    const w = where.get(p);
    if (w) return [uOf(w[0], w[1], s), V[w[0]][w[1]]];
    // a pole (apex): s = 2 + col (end apex) or 2 + n + col (start apex)
    const end = s - 2 < n, col = (s - 2) % n, r = end ? R - 1 : 0;
    const k2 = (col + 1) % n, s2 = k2 === c.seam ? 1 : 0;
    const um = (uOf(r, col, 0) + uOf(r, k2, s2)) / 2;
    const ap = P(p), ring = c.rings[r];
    const vm = (V[r][col] + V[r][k2]) / 2, d = len(sub(ap, lerp3(P(ring[col]), P(ring[k2]), 0.5)));
    return [um, end ? vm + d : -d];
  };
}

// ── monotone cubic interpolation (Fritsch–Carlson) ────────────────────────────────────────────────────────────────
function monotoneCubic(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length, d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i + 1 < n; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-12, xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i + 1 < n; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i + 1 < n; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], c = m[i + 1] / d[i], s = a * a + c * c;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * c * d[i]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (i + 1 < n - 1 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
