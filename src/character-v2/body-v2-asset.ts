/**
 * body-v2-asset.ts — the FROZEN Character v2 base body (`body-v2@2`) and its slider tables (docs/specs/character-v2.md
 * Phase 1). Pure + deterministic + worker-safe (no DOM, no GPU, no scene graph).
 *
 * The v2 body generator (body-v2-generator.ts) runs ONLY here, at bake time:
 *   • the BASE (Persona fem / masc proportions) gives the one canonical topology: index buffer, UVs, skin weights, the
 *     20-joint skeleton;
 *   • every slider KEY (an extreme, plus in-between keys on the non-linear sliders) is generated once and stored as a
 *     SPARSE blend-shape delta (generator(key) − base, position + normal, only the vertices it moves) PLUS a joint
 *     local-position delta (the bone offsets: legLength / torsoLength / shoulderWidth / hipWidth move joints);
 *   • corrective combo shapes for the slider pairs whose effects do not add.
 * At runtime a slider change is: tent weights over its keys → blend weights + joint offsets + recomputed inverse
 * binds. Nothing is regenerated, so nothing can tear.
 *
 * Slider values are NORMALISED: 0 = the base, −1 / +1 = the slider's min / max generator value ON THAT BASE (per-base
 * ranges, balanced around the base). `height` is not a blend shape: it is a uniform node scale (the generator's height
 * is an exact uniform scale).
 *
 * Every shape is held ONCE, as the dense 6-float-per-vertex array Mesh3D.blendShapes takes (zero outside the shape's
 * `idx` support), shared read-only by every character of the base — no second sparse copy.
 *
 * FROZEN means pinned: BODY_V2_FINGERPRINTS holds a hash of the baked tables per base, checked in CI
 * (body-v2-asset.test.ts). Any generator / base / table change that alters the asset fails until it is made a
 * deliberate decision: before the user signs the current version off, re-pin; after (saves, templates or paint bound
 * to it), bump BODY_V2_ASSET_VERSION and write the migration.
 *
 * Versions (the sliders are semantic — 0 = the base — so every older save restores onto the current asset with its
 * slider values: BODY_V2_COMPATIBLE; the placement is migrated so the feet stay where they stood):
 *   • `body-v2@1` (2026-10-05) froze v1's generator topology (2928 verts);
 *   • `body-v2@2` (2026-10-05) = the v2 generator (4039 verts), absolute slider ranges shared by both bases;
 *   • `body-v2@3` (2026-10-06) = body-v2@2 after the adversarial review: the reviewed geometry, proportions, UVs and
 *     weights (4186 verts / 6808 tris, generator v3), per-base slider ranges, 20 corrective terms. Its saves carry the
 *     marker schema v 2 (origin = the soles), so later bumps need no placement migration.
 * A pre-review save's soles: bodyV2LegacySoleY (v2@1: v1's generator; v2@2: a closed form of the pre-review generator).
 */
import { generateBodyV2, BODY_V2_GENERATOR_VERSION, type BodyV2GenParams, type BodyV2GenResult } from './body-v2-generator';
import type { BodyParams } from '../services/managers/body-generator';

export const BODY_V2_ASSET_ID = 'body-v2';
export const BODY_V2_ASSET_VERSION = 3;
/** The versioned asset id saved with a character (a new topology / table = a new version, with a migration). */
export const BODY_V2_ASSET = `${BODY_V2_ASSET_ID}@${BODY_V2_ASSET_VERSION}`;
/** Older asset ids whose saves restore onto the current asset with their (semantic) slider values; the shape is the
 *  current asset's. Placement: a marker of schema v ≥ 2 stores the soles (asset-independent); an older one is moved
 *  from the soles of the asset that wrote it (`transform.soleY`, else bodyV2LegacySoleY). The rig's joint offsets are
 *  relative to the saved rest (`rig.rest`), so they survive the bump too. */
export const BODY_V2_COMPATIBLE: readonly string[] = ['body-v2@1', 'body-v2@2'];

export type BodyV2Base = 'fem' | 'masc';

/**
 * Persona base proportions for the v2 generator (tuned 2026-10-05 on the contact sheets against the reference;
 * measured proportions in the spec): slim, long legs, parted thighs, natural shoulders, mid-thigh reach. The masc base
 * has visibly broader shoulders, a straight torso, slim limbs and a smaller head (≈ 9.5 heads; headSize is a uniform
 * head scale since the review fixes); the fem base a defined (not corseted) waist, natural bust and hips (≈ 8.4 heads).
 * Review retune (G1, 2026-10-05): masc headSize 0.98 → 0.92, limbThick 1.08 → 1.02; the waist / hip / thigh / hand /
 * foot changes are in the generator (the same param values now give the reviewed shapes).
 */
export const BODY_V2_BASES: Readonly<Record<BodyV2Base, BodyV2GenParams>> = {
  fem: {
    height: 1, legLength: 1.2, torsoLength: 1, headSize: 1.0, limbThick: 0.94, torsoThick: 0.9,
    bust: 1.1, waist: 0.86, hipWidth: 1.1, hipFront: 1, shoulderWidth: 1.02, buttSize: 1.05, headShape: 1,
  },
  masc: {
    height: 1, legLength: 1.28, torsoLength: 1.05, headSize: 0.92, limbThick: 1.02, torsoThick: 1.0,
    bust: 0.3, waist: 1.06, hipWidth: 0.92, hipFront: 0.95, shoulderWidth: 1.28, buttSize: 0.8, headShape: 1,
  },
};

/** The body-v2@1 bases (v1's generator) — kept for side-by-side comparison sheets / metrics and to migrate body-v2@1
 *  saves (bodyV2LegacySoleY). */
export const BODY_V2_AT1_BASES: Readonly<Record<BodyV2Base, BodyParams>> = {
  fem: {
    height: 1, legLength: 1.2, torsoLength: 1, headSize: 1.12, limbThick: 0.95, torsoThick: 0.88,
    bust: 1.15, waist: 0.84, hipWidth: 1.04, hipFront: 1, shoulderWidth: 1.02, buttSize: 1.05, seamBlend: 0.5, faceNormals: 1, headShape: 1,
  },
  masc: {
    height: 1, legLength: 1.2, torsoLength: 1.02, headSize: 1.08, limbThick: 1.1, torsoThick: 1.04,
    bust: 0.35, waist: 1.04, hipWidth: 0.9, hipFront: 0.95, shoulderWidth: 1.2, buttSize: 0.8, seamBlend: 0.5, faceNormals: 1, headShape: 1,
  },
};

export type BodyV2SliderName =
  | 'bust' | 'waist' | 'hipWidth' | 'hipFront' | 'buttSize' | 'shoulderWidth' | 'torsoThick' | 'limbThick'
  | 'headShape' | 'headSize' | 'legLength' | 'torsoLength';

/** A slider's generator values at −1 / +1 on one base. */
export interface BodyV2SliderRange { readonly min: number; readonly max: number }

export interface BodyV2SliderDef {
  name: BodyV2SliderName;
  /**
   * The slider's half-range in generator units, PER BASE: −1 / +1 = the base's own value ∓ / ± span, so 0 = the base
   * and the two halves are symmetric — and they follow the base when it is retuned. Clamped to `bounds` where the
   * generator value is bounded (bust ≥ 0: the masc − half is shorter; headShape ≤ 1 = the anime head on both bases, so
   * its + half is empty by design). Gated in body-v2-asset.test: both halves move the body ≥ 8 mm and within 2×. Before
   * the 2026-10-05 review fix one ABSOLUTE range served both bases, so a base near one end had a dead half (masc
   * shoulderWidth +1 moved 8.7 mm, −1 51.6 mm; headSize −1 ≈ 3–5 mm on both).
   */
  span: Readonly<Record<BodyV2Base, number>>;
  /** Hard limits of the generator value (a range end never passes them). */
  bounds?: { readonly min?: number; readonly max?: number };
  /** The generator values at slider −1 / +1 per base (derived: base ∓ span, clamped to bounds). */
  range: Readonly<Record<BodyV2Base, BodyV2SliderRange>>;
  /** Normalised key positions (excluding 0 = the base). More keys = in-betweens for a non-linear slider. */
  keys: readonly number[];
  /** 'shape' = vertices only; 'proportion' = also moves joints (bone offsets). Informational: every key stores both. */
  kind: 'shape' | 'proportion';
}

const LIN = [-1, 1] as const, INB = [-1, -0.5, 0.5, 1] as const, INB4 = [-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1] as const;
type SliderSpec = Omit<BodyV2SliderDef, 'range' | 'span'> & { span: number | Readonly<Record<BodyV2Base, number>> };
const slider = (d: SliderSpec): BodyV2SliderDef => {
  const span = typeof d.span === 'number' ? { fem: d.span, masc: d.span } : d.span;
  const lo = d.bounds?.min ?? -Infinity, hi = d.bounds?.max ?? Infinity;
  const end = (b: BodyV2Base): BodyV2SliderRange => {
    const v = (BODY_V2_BASES[b][d.name] as number | undefined) ?? 1;
    return { min: Math.max(lo, Math.min(v, v - span[b])), max: Math.min(hi, Math.max(v, v + span[b])) };
  };
  return { ...d, span, range: { fem: end('fem'), masc: end('masc') } };
};
export const BODY_V2_SLIDERS: readonly BodyV2SliderDef[] = [
  slider({ name: 'bust',          span: { fem: 0.9, masc: 0.5 }, bounds: { min: 0 }, keys: INB, kind: 'shape' }),   // masc − half: floor 0 = flat
  slider({ name: 'waist',         span: 0.2,                     keys: LIN, kind: 'shape' }),
  slider({ name: 'hipWidth',      span: { fem: 0.22, masc: 0.15 }, keys: INB, kind: 'proportion' }),   // also spreads the hip sockets
  slider({ name: 'hipFront',      span: { fem: 0.25, masc: 0.2 }, keys: LIN, kind: 'shape' }),
  slider({ name: 'buttSize',      span: { fem: 0.65, masc: 0.5 }, bounds: { min: 0 }, keys: LIN, kind: 'shape' }),
  slider({ name: 'shoulderWidth', span: { fem: 0.2, masc: 0.23 }, keys: INB, kind: 'proportion' }),   // also lengthens the clavicles
  slider({ name: 'torsoThick',    span: { fem: 0.2, masc: 0.24 }, keys: INB4, kind: 'shape' }),
  slider({ name: 'limbThick',     span: { fem: 0.21, masc: 0.26 }, keys: INB4, kind: 'shape' }),
  slider({ name: 'headShape',     span: 1, bounds: { min: 0, max: 1 }, keys: LIN, kind: 'shape' }),   // base = 1 (anime): − half only
  slider({ name: 'headSize',      span: 0.19,                    keys: LIN, kind: 'shape' }),
  slider({ name: 'legLength',     span: { fem: 0.25, masc: 0.24 }, keys: LIN, kind: 'proportion' }),
  slider({ name: 'torsoLength',   span: 0.15,                    keys: INB, kind: 'proportion' }),
];
/** The ONE absolute range table both bases shared in body-v2@1 and in body-v2@2 before the 2026-10-05 review fixes —
 *  kept only to rebuild the body such a save described (bodyV2LegacySoleY). */
export const BODY_V2_AT1_SLIDER_RANGES: Readonly<Record<BodyV2SliderName, BodyV2SliderRange>> = {
  bust: { min: 0, max: 2 }, waist: { min: 0.72, max: 1.25 }, hipWidth: { min: 0.82, max: 1.3 }, hipFront: { min: 0.75, max: 1.25 },
  buttSize: { min: 0.3, max: 1.7 }, shoulderWidth: { min: 0.85, max: 1.35 }, torsoThick: { min: 0.75, max: 1.3 },
  limbThick: { min: 0.75, max: 1.35 }, headShape: { min: 0, max: 1 }, headSize: { min: 0.95, max: 1.4 },
  legLength: { min: 0.95, max: 1.5 }, torsoLength: { min: 0.85, max: 1.2 },
};
/** A corrective term: 2 (or 3, `c`) sliders whose effects do not add, on a coarse key GRID (a subset of each slider's
 *  keys). One shape per grid node = the generator there minus everything the lower-order terms already give, weighted
 *  by the product of the sliders' tent weights over the grid → the term is bilinear (trilinear) on the grid and exact
 *  at its nodes. The generator's multiplicative params need them: every torso cross-section is × torsoThick, the
 *  anchors × waist / hipWidth / hipFront, the bust / butt amplitude × torsoThick, the hip sockets × hipWidth · limbThick.
 *  Chosen by body-v2-asset.test (every pair at its ±1 corners ≤ 2.5 mm; 200 seeded random 4–6-slider combos). */
export interface BodyV2CorrectiveDef { a: BodyV2SliderName; b: BodyV2SliderName; c?: BodyV2SliderName; grid: readonly number[] }
export const BODY_V2_CORRECTIVES: readonly BodyV2CorrectiveDef[] = [
  { a: 'torsoThick', b: 'shoulderWidth', grid: LIN },
  { a: 'limbThick', b: 'torsoThick', grid: INB },
  { a: 'headSize', b: 'headShape', grid: LIN },
  { a: 'torsoLength', b: 'bust', grid: LIN },   // the bust rides the under-bust / armpit heights, which torsoLength moves (3.6 mm without)
  { a: 'hipWidth', b: 'limbThick', grid: LIN },
  { a: 'torsoThick', b: 'bust', grid: LIN },
  { a: 'torsoThick', b: 'hipWidth', grid: LIN },
  { a: 'torsoThick', b: 'waist', grid: LIN },
  { a: 'torsoThick', b: 'hipFront', grid: LIN },
  { a: 'torsoThick', b: 'buttSize', grid: LIN },
  { a: 'torsoThick', b: 'torsoLength', grid: LIN },
  { a: 'hipFront', b: 'limbThick', grid: LIN },
  { a: 'hipWidth', b: 'hipFront', grid: LIN },
  { a: 'waist', b: 'shoulderWidth', grid: LIN },
  { a: 'waist', b: 'hipWidth', grid: LIN },
  { a: 'waist', b: 'hipFront', grid: LIN },
  { a: 'shoulderWidth', b: 'torsoLength', grid: LIN },   // the shoulder pivot rides the armhole, which both move
  { a: 'shoulderWidth', b: 'limbThick', grid: LIN },
  { a: 'limbThick', b: 'torsoLength', grid: LIN },
  // 3-way: the pelvis side where the thigh top meets the hip (pelvis width × torsoThick, the socket × limbThick) — each
  // pair ≤ 0.3 mm there, all three 4.7 mm without it. Triples come after the pairs (their residual is over them).
  { a: 'hipWidth', b: 'limbThick', c: 'torsoThick', grid: LIN },
];
/** Height = a uniform node scale over this range (slider −1 / +1). */
export const BODY_V2_HEIGHT_RANGE = { min: 0.85, max: 1.15 } as const;

export type BodyV2Sliders = Partial<Record<BodyV2SliderName | 'height', number>>;

/** Every slider name a character takes (the 12 shape / proportion sliders + `height`). */
export const BODY_V2_SLIDER_NAMES: ReadonlySet<string> = new Set<string>([...BODY_V2_SLIDERS.map((d) => d.name), 'height']);

function rangeValue(r: BodyV2SliderRange, b: number, x: number): number {
  const t = Math.max(-1, Math.min(1, x));
  return t >= 0 ? b + t * (r.max - b) : b + t * (b - r.min);
}
/** The generator value a normalised slider stands for on a base (named, `{ base, params }`, or its params object —
 *  see BodyV2BaseRef). */
export function sliderParamValue(def: BodyV2SliderDef, ref: BodyV2BaseRef, x: number): number {
  const { base, params } = resolveBase(ref);
  return rangeValue(def.range[base], (params[def.name] as number | undefined) ?? 1, x);
}
/** The height scale a normalised height slider stands for. */
export function heightScale(x: number | undefined): number {
  const t = Math.max(-1, Math.min(1, x ?? 0));
  return t >= 0 ? 1 + t * (BODY_V2_HEIGHT_RANGE.max - 1) : 1 + t * (1 - BODY_V2_HEIGHT_RANGE.min);
}

/** A base, named or as a baked asset's `{ base, params }`; a bare params object is accepted when it is (a copy of) a
 *  base's params, e.g. `asset.params` (the ranges are per base, so the base must be known). */
export type BodyV2BaseRef = BodyV2Base | { readonly base: BodyV2Base; readonly params: BodyV2GenParams } | BodyV2GenParams;
const _paramsBase = new WeakMap<object, BodyV2Base>();   // asset.params objects → their base (set by the bake)
function resolveBase(ref: BodyV2BaseRef): { base: BodyV2Base; params: BodyV2GenParams } {
  if (typeof ref === 'string') return { base: ref, params: BODY_V2_BASES[ref] };
  if ('base' in ref && typeof ref.base === 'string') return { base: ref.base, params: ref.params };
  const p = ref as BodyV2GenParams;
  const tagged = _paramsBase.get(p);
  if (tagged) return { base: tagged, params: p };
  for (const b of ['fem', 'masc'] as const) {
    const q = BODY_V2_BASES[b];
    if ((Object.keys(q) as (keyof BodyV2GenParams)[]).every((k) => p[k] === q[k])) return { base: b, params: p };
  }
  throw new Error('[body-v2] unknown base params: pass the base name or the asset (slider ranges are per base)');
}

/** The full generator params equivalent to a slider state (the accuracy reference; `height` excluded = node scale). */
export function sliderParams(ref: BodyV2BaseRef, sliders: BodyV2Sliders): BodyV2GenParams {
  const { base, params } = resolveBase(ref);
  const p: BodyV2GenParams = { ...params };
  for (const d of BODY_V2_SLIDERS) {
    const x = sliders[d.name];
    if (x !== undefined && x !== 0) (p as unknown as Record<string, number>)[d.name] = sliderParamValue(d, { base, params }, x);
  }
  return p;
}

/** Per base, every slider's −1 / 0 / +1 generator values (for a UI: where 0 sits; for docs / tests). */
export function bodyV2SliderTable(base: BodyV2Base): { name: BodyV2SliderName; min: number; base: number; max: number; kind: BodyV2SliderDef['kind'] }[] {
  return BODY_V2_SLIDERS.map((d) => ({ name: d.name, min: d.range[base].min, base: (BODY_V2_BASES[base][d.name] as number | undefined) ?? 1, max: d.range[base].max, kind: d.kind }));
}

// ── Slider values from callers (UI / console / LLM façade / saves) ───────────────────────────────────────────────
/**
 * One slider value from a caller → a value in [−1, 1], or null when it is not a number. ±Infinity clamps to ±1; a
 * numeric string (an HTML input's `.value`, a JSON tool call) is accepted; NaN / '' / null / undefined / objects are
 * REJECTED (null) — a live setter then returns false and keeps the previous value instead of silently resetting it.
 */
export function coerceBodyV2Slider(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Math.max(-1, Math.min(1, n));
}
/** LOAD-time cleaning (lenient: a corrupt save falls back to the base): known names only, coerced, 0 entries dropped. */
export function cleanBodyV2Sliders(s: unknown): BodyV2Sliders {
  const out: BodyV2Sliders = {};
  if (!s || typeof s !== 'object') return out;
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (!BODY_V2_SLIDER_NAMES.has(k)) continue;
    const x = coerceBodyV2Slider(v);
    if (x !== null && x !== 0) out[k as BodyV2SliderName] = x;
  }
  return out;
}
/** LIVE-edit validation (strict + atomic): the cleaned new state for merging (or with `replace`, setting) `edit` onto
 *  `cur`, or null — apply nothing — when any key is unknown or any value is rejected by coerceBodyV2Slider. */
export function editBodyV2Sliders(cur: BodyV2Sliders, edit: unknown, replace = false): BodyV2Sliders | null {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return null;
  const next: Record<string, unknown> = replace ? {} : { ...cur };
  for (const [k, v] of Object.entries(edit as Record<string, unknown>)) {
    if (!BODY_V2_SLIDER_NAMES.has(k)) return null;
    const x = coerceBodyV2Slider(v);
    if (x === null) return null;
    next[k] = x;
  }
  return cleanBodyV2Sliders(next);
}

// ── The baked asset ──────────────────────────────────────────────────────────────────────────────────────────────
/** A blend shape, held ONCE: the dense Mesh3D.blendShapes array (6 floats per vertex) + its support. */
export interface BodyV2Shape {
  name: string;
  /** The moved vertices (ascending) — exactly the non-zero support of `dense` (what Mesh3D's blendSupport finds). */
  idx: Uint32Array;
  /** 6 floats per vertex (dPos xyz, dNrm xyz), zero outside `idx`: the array Mesh3D.blendShapes takes, shared read-only
   *  by every character of the base (never edit it in place). */
  dense: Float32Array;
  /** 3 floats per joint: the joint LOCAL-position delta at full weight (bone offset). */
  jointDelta: Float32Array;
}
export interface BodyV2Key { at: number; shape: number }
/** A corrective shape at one node (ka, kb[, kc]) of its term's key grid (BodyV2CorrectiveDef): residual = generator at
 *  the node − base − every shape the asset already had, weighted there (the keys and the lower-order correctives). */
export interface BodyV2Corrective { a: BodyV2SliderName; b: BodyV2SliderName; c?: BodyV2SliderName; ka: number; kb: number; kc?: number; shape: number }

export interface BodyV2Asset {
  asset: string;          // 'body-v2@3'
  generatorVersion: number;
  base: BodyV2Base;
  params: BodyV2GenParams;   // the base's generator params
  /** Canonical 12-float vertices (rest, bind space) + index buffer + UVs (in the vertices) of the base. */
  vertices: Float32Array;
  indices: Uint32Array;
  jointIndices: Uint8Array;
  jointWeights: Float32Array;
  jointNames: string[];
  jointParents: Int16Array;
  /** Base joint local positions (3 per joint; identity rest rotations). */
  jointLocal: Float32Array;
  shapes: BodyV2Shape[];
  /** Per slider, its keys (sorted by `at`, base 0 excluded). */
  sliders: Record<BodyV2SliderName, BodyV2Key[]>;
  correctives: BodyV2Corrective[];
  vertexCount: number;
}

type GenFn = (p: BodyV2GenParams) => BodyV2GenResult;

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
/** Dense delta of a generator run vs the base (12-float vertices → 6 floats per vertex) + the joint delta. Every run
 *  must keep the base's topology exactly — the index buffer AND the skin weights, byte for byte (the asset uses the
 *  base's), so a generator change that breaks constant topology at any key fails the bake loudly. */
function denseDiff(base: BodyV2GenResult, other: BodyV2GenResult, name: string): { d: Float32Array; jd: Float32Array } {
  const bv = base.geometry.vertices, ov = other.geometry.vertices;
  if (ov.length !== bv.length || !sameBytes(other.geometry.indices, base.geometry.indices))
    throw new Error(`[body-v2] topology changed at ${name}: ${ov.length / 12} vs ${bv.length / 12} verts / index buffer differs`);
  if (!sameBytes(other.skinning.jointIndices, base.skinning.jointIndices) || !sameBytes(other.skinning.jointWeights, base.skinning.jointWeights))
    throw new Error(`[body-v2] skin weights changed at ${name} (the asset uses the base's weights for every slider state)`);
  const n = bv.length / 12, d = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) d[i * 6 + k] = ov[i * 12 + k] - bv[i * 12 + k];
  const bj = base.skinning.jointLocalPositions!, oj = other.skinning.jointLocalPositions!;
  const jd = new Float32Array(bj.length);
  for (let i = 0; i < bj.length; i++) jd[i] = oj[i] - bj[i];
  return { d, jd };
}
/** A shape from a dense delta: a vertex is kept when it moves more than 1 µm or its normal turns more than ~1e-5; the
 *  others are ZEROED in place, so the array's non-zero support is exactly `idx`. */
function toShape(name: string, d: Float32Array, jd: Float32Array): BodyV2Shape {
  const n = d.length / 6, keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    if (Math.abs(d[o]) > 1e-6 || Math.abs(d[o + 1]) > 1e-6 || Math.abs(d[o + 2]) > 1e-6 || Math.abs(d[o + 3]) > 1e-5 || Math.abs(d[o + 4]) > 1e-5 || Math.abs(d[o + 5]) > 1e-5) keep.push(i);
    else d.fill(0, o, o + 6);
  }
  return { name, idx: new Uint32Array(keep), dense: d, jointDelta: jd };
}

/**
 * The bake as a step generator: it yields after every generator run, so the async path can hand the main thread back
 * between runs (no ~1–3 s block on the first create) while the sync path runs it straight through — one code path, so
 * both give byte-identical tables.
 */
function* bakeSteps(base: BodyV2Base, gen: GenFn): Generator<void, BodyV2Asset, void> {
  const params = { ...BODY_V2_BASES[base] };
  _paramsBase.set(params, base);
  const ref = { base, params };
  const b = gen(params);
  yield;
  const shapes: BodyV2Shape[] = [];
  const sliders = {} as Record<BodyV2SliderName, BodyV2Key[]>;
  for (const def of BODY_V2_SLIDERS) {
    const keys: BodyV2Key[] = [];
    const bv = (params[def.name] as number | undefined) ?? 1;
    for (const at of [...def.keys].sort((x, y) => x - y)) {
      const v = sliderParamValue(def, ref, at);
      if (Math.abs(v - bv) < 1e-9) continue;   // a side with no range on this base (headShape is already 1)
      const name = `v2:${def.name}${at > 0 ? '+' : ''}${at}`;
      const dd = denseDiff(b, gen({ ...params, [def.name]: v }), name);
      yield;
      const s = toShape(name, dd.d, dd.jd);
      keys.push({ at, shape: shapes.length });
      shapes.push(s);
    }
    sliders[def.name] = keys;
  }
  const correctives: BodyV2Corrective[] = [];
  const defOf = (n: BodyV2SliderName) => BODY_V2_SLIDERS.find((d) => d.name === n)!;
  // Lower-order terms first (a triple's residual is taken over the pairs); stable within an order.
  const terms = [...BODY_V2_CORRECTIVES].sort((p, q) => (p.c ? 3 : 2) - (q.c ? 3 : 2));
  const partial = { shapes, sliders, correctives } as unknown as BodyV2Asset;   // what bodyV2Weights reads
  for (const term of terms) {
    const axes = term.c ? [term.a, term.b, term.c] : [term.a, term.b];
    const nodes = axes.map((n) => sliders[n].filter((k) => term.grid.includes(k.at)).map((k) => k.at));
    let combos: number[][] = [[]];
    for (const ns of nodes) combos = combos.flatMap((cmb) => ns.map((at) => [...cmb, at]));
    for (const at of combos) {
      const state: BodyV2Sliders = {}, gp: BodyV2GenParams = { ...params };
      axes.forEach((n, i) => { state[n] = at[i]; (gp as unknown as Record<string, number>)[n] = sliderParamValue(defOf(n), ref, at[i]); });
      const name = `v2:${axes.map((n, i) => `${n}${at[i]}`).join('x')}`;
      const corner = denseDiff(b, gen(gp), name);
      yield;
      // the residual against the STORED shapes (thresholded keys + the lower-order correctives), weighted at the node,
      // so the asset is exact at every grid node
      const w = bodyV2Weights(partial, state);
      for (let s = 0; s < shapes.length; s++) {
        const ws = w[s];
        if (!ws) continue;
        const { idx, dense, jointDelta } = shapes[s];
        for (let k = 0; k < idx.length; k++) { const q = idx[k] * 6; for (let c = 0; c < 6; c++) corner.d[q + c] -= ws * dense[q + c]; }
        for (let i = 0; i < corner.jd.length; i++) corner.jd[i] -= ws * jointDelta[i];
      }
      correctives.push({ a: term.a, b: term.b, ka: at[0], kb: at[1], ...(term.c ? { c: term.c, kc: at[2] } : {}), shape: shapes.length });
      shapes.push(toShape(name, corner.d, corner.jd));
    }
  }
  return {
    asset: BODY_V2_ASSET, generatorVersion: BODY_V2_GENERATOR_VERSION, base, params,
    vertices: new Float32Array(b.geometry.vertices), indices: new Uint32Array(b.geometry.indices),
    jointIndices: new Uint8Array(b.skinning.jointIndices), jointWeights: new Float32Array(b.skinning.jointWeights),
    jointNames: [...b.skinning.jointNames], jointParents: new Int16Array(b.skinning.jointParents!),
    jointLocal: new Float32Array(b.skinning.jointLocalPositions!),
    shapes, sliders, correctives, vertexCount: b.geometry.vertices.length / 12,
  };
}

/** Bake the asset for a base (synchronously). Deterministic: same generator + base → byte-identical tables. */
export function bakeBodyV2(base: BodyV2Base = 'fem', gen: GenFn = generateBodyV2): BodyV2Asset {
  const it = bakeSteps(base, gen);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/** The default hand-back between bake steps: a MessageChannel task. Unlike chained setTimeout(0) it is not clamped to
 *  ≥ 4 ms per nested timer, and it is not throttled in a hidden tab (Chrome's throttling — 1 s, or 1 min "intensive" —
 *  only applies to timers), so a document loaded in a background tab still finishes its bake. setTimeout elsewhere. */
function taskYielder(): { yieldFn: () => Promise<void>; close: () => void } {
  if (typeof MessageChannel === 'function') {
    const ch = new MessageChannel();
    let wake: (() => void) | null = null;
    ch.port1.onmessage = () => { const w = wake; wake = null; w?.(); };
    return {
      yieldFn: () => new Promise<void>((res) => { wake = res; ch.port2.postMessage(0); }),
      close: () => { ch.port1.onmessage = null; ch.port1.close(); ch.port2.close(); },
    };
  }
  return { yieldFn: () => new Promise<void>((res) => setTimeout(res, 0)), close: () => {} };
}
/** The same bake, handing the thread back between generator runs (`yieldFn`, default a MessageChannel task). */
export async function bakeBodyV2Async(base: BodyV2Base = 'fem', gen: GenFn = generateBodyV2, yieldFn?: () => Promise<void>): Promise<BodyV2Asset> {
  const own = yieldFn ? null : taskYielder();
  const y = yieldFn ?? own!.yieldFn;
  try {
    const it = bakeSteps(base, gen);
    for (;;) { const r = it.next(); if (r.done) return r.value; await y(); }
  } finally { own?.close(); }
}

/**
 * Baked assets, once per base per session. ONE asset object per base (the dense shape arrays are shared by every
 * character of it): a sync bake that lands while an async one is pending wins, and the async result then resolves to
 * the cached object. A FAILED async bake is not cached: the next call bakes again.
 */
export class BodyV2AssetCache {
  private readonly _cache = new Map<BodyV2Base, BodyV2Asset>();
  private readonly _pending = new Map<BodyV2Base, Promise<BodyV2Asset>>();
  constructor(
    private readonly bakeSync: (base: BodyV2Base) => BodyV2Asset = (b) => bakeBodyV2(b),
    private readonly bakeAsync: (base: BodyV2Base) => Promise<BodyV2Asset> = (b) => bakeBodyV2Async(b),
  ) {}
  get(base: BodyV2Base): BodyV2Asset {
    let a = this._cache.get(base);
    if (!a) { a = this.bakeSync(base); this._cache.set(base, a); }
    return a;
  }
  getAsync(base: BodyV2Base): Promise<BodyV2Asset> {
    const a = this._cache.get(base);
    if (a) return Promise.resolve(a);
    let p = this._pending.get(base);
    if (!p) {
      p = this.bakeAsync(base).then(
        (x) => {
          this._pending.delete(base);
          const c = this._cache.get(base);
          if (c) return c;
          this._cache.set(base, x);
          return x;
        },
        (e: unknown) => { this._pending.delete(base); throw e; },
      );
      this._pending.set(base, p);
    }
    return p;
  }
  has(base: BodyV2Base): boolean { return this._cache.has(base); }
}
const _assets = new BodyV2AssetCache();
/** The baked asset for a base, baked once per session (the tables are immutable — never mutate them). */
export function getBodyV2Asset(base: BodyV2Base = 'fem'): BodyV2Asset { return _assets.get(base); }
/** The baked asset without blocking: a cached asset resolves at once; otherwise a time-sliced bake (shared by every
 *  concurrent caller; retried after a failure). The result is byte-identical to getBodyV2Asset. */
export function getBodyV2AssetAsync(base: BodyV2Base = 'fem'): Promise<BodyV2Asset> { return _assets.getAsync(base); }

/** A shape's DENSE delta array (6 floats per vertex — what Mesh3D.blendShapes takes): the asset's own array, shared
 *  read-only by every character of the base (no copy). */
export function denseShapeDelta(asset: BodyV2Asset, shape: number): Float32Array {
  return asset.shapes[shape].dense;
}
/** Resident bytes of the shape tables (the dense arrays + their supports + joint deltas — the whole cost, shared with
 *  every Mesh3D of the base), and what the same shapes would take stored sparse (a serialized / engine-sparse form). */
export function bodyV2DeltaBytes(asset: BodyV2Asset): { resident: number; dense: number; support: number; sparse: number } {
  let dense = 0, support = 0, joint = 0, moved = 0;
  for (const s of asset.shapes) { dense += s.dense.byteLength; support += s.idx.byteLength; joint += s.jointDelta.byteLength; moved += s.idx.length; }
  return { resident: dense + support + joint, dense, support, sparse: support + moved * 24 + joint };
}

// ── Evaluation (no generator) ────────────────────────────────────────────────────────────────────────────────────
/** Tent (piecewise-linear) weights of a slider value over its keys, with the base (0) as an implicit zero key. */
export function keyWeights(keys: readonly BodyV2Key[], x: number): { shape: number; w: number }[] {
  const t = Math.max(-1, Math.min(1, x));
  if (t === 0 || keys.length === 0) return [];
  const pts: { at: number; shape: number }[] = [...keys, { at: 0, shape: -1 }].sort((p, q) => p.at - q.at);
  if (t < pts[0].at || t > pts[pts.length - 1].at) return [];   // outside this base's range on that side
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    if (t >= p.at && t <= q.at) {
      const u = (t - p.at) / (q.at - p.at), out: { shape: number; w: number }[] = [];
      if (p.shape >= 0 && u < 1) out.push({ shape: p.shape, w: 1 - u });
      if (q.shape >= 0 && u > 0) out.push({ shape: q.shape, w: u });
      return out;
    }
  }
  return [];
}

/** Every shape's blend weight (parallel to asset.shapes) for a slider state — all in [0, 1]. */
export function bodyV2Weights(asset: BodyV2Asset, sliders: BodyV2Sliders): Float32Array {
  const w = new Float32Array(asset.shapes.length);
  for (const def of BODY_V2_SLIDERS) {
    const x = sliders[def.name];
    if (!x) continue;
    for (const k of keyWeights(asset.sliders[def.name], x)) w[k.shape] += k.w;
  }
  // Correctives: the product of the sliders' tent weights over the term's coarse grid (bilinear / trilinear on it).
  const tentOf = (n: BodyV2SliderName, grid: readonly number[]): Map<number, number> => {
    const m = new Map<number, number>();
    const nodes = asset.sliders[n].map((k) => k.at).filter((at) => grid.includes(at));   // this slider's keys on the grid
    const keys = nodes.map((at, i) => ({ at, shape: i }));
    for (const k of keyWeights(keys, sliders[n] ?? 0)) m.set(nodes[k.shape], k.w);
    return m;
  };
  for (const { a, b, c: cc, grid } of BODY_V2_CORRECTIVES) {
    const ta = tentOf(a, grid), tb = tentOf(b, grid), tc = cc ? tentOf(cc, grid) : null;
    for (const c of asset.correctives) {
      if (c.a !== a || c.b !== b || c.c !== cc || c.shape >= w.length) continue;
      w[c.shape] = (ta.get(c.ka) ?? 0) * (tb.get(c.kb) ?? 0) * (tc ? (tc.get(c.kc!) ?? 0) : 1);
    }
  }
  return w;
}

/** Joint local positions (3 per joint) for a set of blend weights: base + Σ w · jointDelta (the bone offsets). */
export function bodyV2JointLocal(asset: BodyV2Asset, weights: Float32Array): Float32Array {
  const out = new Float32Array(asset.jointLocal);
  for (let s = 0; s < asset.shapes.length; s++) {
    const w = weights[s];
    if (!w) continue;
    const d = asset.shapes[s].jointDelta;
    for (let i = 0; i < out.length; i++) out[i] += w * d[i];
  }
  return out;
}

/** World rest positions + column-major inverse binds (identity rest rotations → translate(−world)). */
export function bodyV2InverseBinds(jointParents: Int16Array, jointLocal: Float32Array): { world: Float32Array; inverseBind: Float32Array } {
  const n = jointParents.length, world = new Float32Array(n * 3), ibm = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) {
    const p = jointParents[i];
    for (let k = 0; k < 3; k++) world[i * 3 + k] = jointLocal[i * 3 + k] + (p >= 0 ? world[p * 3 + k] : 0);   // parents precede children
    const m = ibm.subarray(i * 16, i * 16 + 16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    m[12] = -world[i * 3]; m[13] = -world[i * 3 + 1]; m[14] = -world[i * 3 + 2];
  }
  return { world, inverseBind: ibm };
}

/** CPU evaluation of the rest geometry — the same arithmetic as Mesh3D.evaluateBlendShapes (same shapes, same order,
 *  same support), so it is bit-identical to a full mesh evaluation (tests, soles, previews). */
export function bodyV2Vertices(asset: BodyV2Asset, weights: Float32Array): Float32Array {
  const out = new Float32Array(asset.vertices);
  for (let s = 0; s < asset.shapes.length; s++) {
    const w = weights[s];
    if (Math.abs(w) < 1e-7) continue;
    const { idx, dense } = asset.shapes[s];
    for (let k = 0; k < idx.length; k++) { const v = idx[k], o = v * 12, q = v * 6; for (let c = 0; c < 6; c++) out[o + c] += w * dense[q + c]; }
  }
  return out;
}

// ── Fingerprint: the frozen-asset guard (pipeline#1) ─────────────────────────────────────────────────────────────
/** A 64-bit content hash: two 32-bit multiply-xor lanes over 32-bit words (change detection, not cryptographic). */
class Hash64 {
  private a = 0x811c9dc5 | 0;
  private b = 0x9747b28c | 0;
  words(u: Uint32Array): this {
    let a = this.a, b = this.b;
    for (let i = 0; i < u.length; i++) {
      const w = u[i];
      a = Math.imul(a ^ w, 0x01000193);
      b = Math.imul(b ^ w, 0x5bd1e995); b ^= b >>> 15;
    }
    this.a = a; this.b = b;
    return this;
  }
  u32(x: number): this { return this.words(Uint32Array.of(x >>> 0)); }
  bytes(v: ArrayBufferView): this {
    this.u32(v.byteLength);
    if (v.byteOffset % 4 === 0 && v.byteLength % 4 === 0) return this.words(new Uint32Array(v.buffer, v.byteOffset, v.byteLength / 4));
    const pad = new Uint8Array((v.byteLength + 3) & ~3);
    pad.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    return this.words(new Uint32Array(pad.buffer));
  }
  str(s: string): this { return this.bytes(new TextEncoder().encode(s)); }
  hex(): string { return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0'); }
}

/** What a body-v2 asset IS, hashed in parts so a mismatch says what moved (paint binds to `uv`, templates to
 *  `topology` + `shape`). */
export interface BodyV2Fingerprint {
  /** All of the below. */
  full: string;
  /** Index buffer, skin joint indices + weights, joint names + parents, vertex count. */
  topology: string;
  /** The UV layout (the paint surface). */
  uv: string;
  /** Base positions / normals / tangents, base joint positions, every shape's support + deltas + bone offsets, the key
   *  and corrective tables. */
  shape: string;
  /** The tables that define the bake: asset id, generator version, the base params, slider ranges / keys, correctives,
   *  height range. */
  tables: string;
}
/** The fingerprint of a baked asset (node CI pins it; float BYTES are hashed, so compare it only on one JS engine —
 *  the generator's Math.sin / pow / … results may differ in the last bit between engines). */
export function bodyV2Fingerprint(asset: BodyV2Asset): BodyV2Fingerprint {
  const n = asset.vertexCount, V = asset.vertices;
  const uv = new Float32Array(n * 2), rest = new Float32Array(n * 10);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = V[i * 12 + 6]; uv[i * 2 + 1] = V[i * 12 + 7];
    for (let k = 0; k < 6; k++) rest[i * 10 + k] = V[i * 12 + k];
    for (let k = 0; k < 4; k++) rest[i * 10 + 6 + k] = V[i * 12 + 8 + k];
  }
  const topology = new Hash64().u32(n).bytes(asset.indices).bytes(asset.jointIndices).bytes(asset.jointWeights)
    .str(asset.jointNames.join('|')).bytes(asset.jointParents).hex();
  const uvh = new Hash64().bytes(uv).hex();
  const sh = new Hash64().bytes(rest).bytes(asset.jointLocal).u32(asset.shapes.length);
  for (const s of asset.shapes) sh.str(s.name).bytes(s.idx).bytes(s.dense).bytes(s.jointDelta);
  sh.str(JSON.stringify(asset.sliders)).str(JSON.stringify(asset.correctives));
  const tables = new Hash64().str(JSON.stringify({
    asset: asset.asset, generatorVersion: asset.generatorVersion, base: asset.base, params: asset.params,
    sliders: BODY_V2_SLIDERS.map((d) => ({ name: d.name, range: d.range[asset.base], keys: d.keys, kind: d.kind })),
    correctives: BODY_V2_CORRECTIVES, height: BODY_V2_HEIGHT_RANGE,
  })).hex();
  const shape = sh.hex();
  return { full: new Hash64().str(`${topology}:${uvh}:${shape}:${tables}`).hex(), topology, uv: uvh, shape, tables };
}

/**
 * The PINNED fingerprint of each body-v2 asset version, recomputed by body-v2-asset.test.ts in CI. A mismatch means
 * the generator, a base or a table changed what the asset bakes to — which silently changes every saved character,
 * the fit of every garment template and the UVs paint is bound to. Make it a decision:
 *   • `signedOff: false` (the body is still being tuned, nothing is bound to it): re-pin the new values here;
 *   • `signedOff: true` (saves / templates / paint exist): never re-pin — bump BODY_V2_ASSET_VERSION, add the new
 *     version's entry, keep this one, and write the migration (old slider values + placement → the new asset).
 */
export const BODY_V2_FINGERPRINTS: Readonly<Record<string, {
  generatorVersion: number; signedOff: boolean; fem: BodyV2Fingerprint; masc: BodyV2Fingerprint;
}>> = {
  // body-v2@2 (2026-10-05) predates the pin: it was released unpinned, and the entry it carried during the review was
  // an intermediate state of the fixes that never shipped. Its saves migrate (BODY_V2_COMPATIBLE, bodyV2LegacySoleY).
  'body-v2@3': {
    generatorVersion: 3, signedOff: false,
    fem: { full: '6ca244d94a4fb973', topology: 'd4ed3c29880d818a', uv: '8f3bef6601dae4f7', shape: '93b6af3883653b74', tables: 'b6fb9ab427aac470' },
    masc: { full: '6a388c32a51468aa', topology: 'd4ed3c29880d818a', uv: 'a5bcb19b0de4d5c8', shape: '532fbf7fc005793f', tables: '8f135566a6c85cf5' },
  },
};

// ── Migration of older saves (pipeline#7) ────────────────────────────────────────────────────────────────────────
function minYOf(v: Float32Array): number {
  let lo = Infinity;
  for (let i = 1; i < v.length; i += 12) if (v[i] < lo) lo = v[i];
  return Number.isFinite(lo) ? lo : 0;
}
/**
 * The pre-review body-v2@2 bases (2026-10-05, generator v2), only the two params its soles depend on (masc limbThick
 * was 1.08 then; the review retuned it to 1.02). The other params never reached the soles.
 */
export const BODY_V2_AT2_SOLE_BASES: Readonly<Record<BodyV2Base, { legLength: number; limbThick: number }>> = {
  fem: { legLength: 1.2, limbThick: 0.94 },
  masc: { legLength: 1.28, limbThick: 1.08 },
};
/**
 * The pre-review body-v2@2 generator's soles, in closed form: its foot joint sat at y = 0.90 − 0.14 − 0.84·legLength
 * (the hips 0.90, the hip socket −0.14, the shin + the foot 0.42 each × legLength; height 1) and its lowest vertex —
 * the same toe vertex at every param set — 0.95·(0.050 + 0.0002)·limbThick below it (the sole drop + the toe dome's
 * dip under the sole). Exact to float32 against that generator (body-v2-asset.test pins its outputs), so the migration
 * keeps no copy of the old generator.
 */
export function bodyV2At2SoleY(legLength: number, limbThick: number): number {
  return 0.90 - 0.14 - 0.84 * legLength - 0.95 * 0.0502 * limbThick;
}
/**
 * The rest-sole height (the lowest mesh-space y, before the node scale) of the body a marker WITHOUT a saved `soleY`
 * was placed against — the body the asset that WROTE it built for those sliders — so a restore can keep its feet where
 * they stood (a marker of schema v < 2 stores the mesh ORIGIN, which is only sole-relative to the asset that saved it):
 *   • 'body-v2@1': v1's generator at BODY_V2_AT1_BASES with the old absolute ranges (the v2@1 bake reproduced it
 *     within ~2 mm);
 *   • 'body-v2@2' (the pre-review generator, the old absolute ranges): bodyV2At2SoleY. (Before the integration fix this
 *     ran the CURRENT generator at the current bases, which put restored feet 0.2–15.7 mm off.)
 *   • anything else: null (no better guess than the current asset; body-v2@3 writes schema v 2, whose origin is the
 *     soles, so it never needs this).
 */
export async function bodyV2LegacySoleY(assetId: string | undefined, base: BodyV2Base, sliders: BodyV2Sliders): Promise<number | null> {
  if (assetId !== 'body-v2@1' && assetId !== 'body-v2@2') return null;
  const s = cleanBodyV2Sliders(sliders);
  const apply = <T extends object>(p: T): T => {
    const q = { ...p } as Record<string, number>;
    for (const [k, r] of Object.entries(BODY_V2_AT1_SLIDER_RANGES)) {
      const x = s[k as BodyV2SliderName];
      if (x) q[k] = rangeValue(r, q[k] ?? 1, x);
    }
    return q as T;
  };
  if (assetId === 'body-v2@2') { const p = apply(BODY_V2_AT2_SOLE_BASES[base]); return bodyV2At2SoleY(p.legLength, p.limbThick); }
  const { generateBodyResult } = await import('../services/managers/body-generator');
  return minYOf(generateBodyResult(apply(BODY_V2_AT1_BASES[base])).geometry.vertices);
}
