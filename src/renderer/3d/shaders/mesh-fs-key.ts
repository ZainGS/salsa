/**
 * THE MESH FRAGMENT SHADER KEY (docs/specs/shader-split.md §4): which feature blocks of the merged template
 * (mesh3d-fs-template.ts) a specialised fragment shader compiles in.
 *
 * A key = the layout axes (textured, shadow-receiving), two scene-global switches (render-debug hooks, the inline SSR
 * trace), the render styles, the material features, the pattern / ground modes, plus `lean` (bisect keys only).
 *
 * DERIVATION (meshFsKeyOfFlags): from the material flags and flags2 EXACTLY as the renderer wrote them into the mesh's
 * instance slot (floats 43 and 28), so a key describes what the shader will read. A feature bit is set only when its
 * block can do something for that mesh (for example ENV_SPEC only for style 0 without the matte bit, TOON only for the
 * Cel styles), so meshes do not split into keys for nothing. Bits that change per frame (fog fade, HLOD dissolve,
 * no-fog, the PS1 retro opt-in) are RUNTIME: their blocks stay in every shader that has them today.
 *
 * GUARD: MATERIAL_FLAG_BITS / FLAGS2_BITS classify every bit of encodeMaterialFlags / encodeMeshFlags2
 * (material-3d.ts). shader-split.test.ts fails when a bit is used that is not classified, so a new feature can never
 * silently miss the key (a missing key bit = a removed block = wrong pixels).
 *
 * STYLE IS ITS OWN AXIS (shader-split-combos.md): a key = a feature set + the exact render style(s). A FAMILY is a
 * feature set only; its pipeline is compiled for a style mask (all 8 for the boot fallback), so a Cel, Graphic or PBR
 * scene finds the same family.
 *
 * SUPERSETS: a shader compiled for key S draws any mesh whose key is a subset of S with the same pixels (the template
 * keeps each block's runtime gate). meshFsKeyCovers is that relation; the `*-BASE` families (meshFsBaseKey) are broad
 * keys pre-warmed as the fallback while an exact key compiles.
 *
 * COVERAGE: every material key (phase 2 covered every feature, pattern mode and ground mode; since phase 4, 2026-10-08,
 * there is no other mesh fragment path, so there is no coverage switch and no per-family exclusion any more).
 *
 * PACKED KEY (meshFsKeyNum): the exact material key of one instance slot as one number (feat, style, tex, pattern
 * mode, ground-mode index), memoised on what it reads, so the slot write and the draw walk compare plain numbers.
 */

/** Material feature bits of a key (MeshFsKey.feat). */
export const MF = {
  TEXSAMPLE: 1 << 0,
  NORMAL_MAP: 1 << 1,
  CUTOUT: 1 << 2,
  TRIPLANAR: 1 << 3,
  GARP: 1 << 4,
  TEX_OVER_BASE: 1 << 5,
  HAIR: 1 << 6,
  HAIR_BAND: 1 << 7,
  TOON: 1 << 8,
  RIM: 1 << 9,
  ENV_SPEC: 1 << 10,
  PLANAR: 1 << 11,
  CROWD: 1 << 12,
  LINING: 1 << 13,
  BOARD: 1 << 14,
  RADIAL: 1 << 15,
  LEAF: 1 << 16,
  GLASS: 1 << 17,
  METAL: 1 << 18,
  NEON: 1 << 19,
  WATER: 1 << 20,
  FOLIAGE: 1 << 21,
  GROUND: 1 << 22,
  AD_SCREEN: 1 << 23,
} as const;
export type MeshFsFeature = keyof typeof MF;
/** Feature names in bit order. */
export const MF_NAMES = Object.keys(MF) as MeshFsFeature[];
/** Every feature bit. */
export const MF_ALL = (1 << MF_NAMES.length) - 1;
/** Features only the textured template has (worldTangent, the samples, the hair sheen). */
export const MF_TEX_ONLY = MF.TEXSAMPLE | MF.NORMAL_MAP | MF.CUTOUT | MF.TRIPLANAR | MF.GARP | MF.TEX_OVER_BASE | MF.HAIR | MF.HAIR_BAND;
/** Features only the untextured template has (spec §2.6: a textured glassEnhance mesh gets no glass, etc.). */
export const MF_UNTEX_ONLY = MF.RADIAL | MF.LEAF | MF.GLASS;

/** The light, look-modifier features (spec §4.3 `*-BASE`): toon, rim, env specular, planar, crowd, lining. */
export const MF_LIGHT = MF.TOON | MF.RIM | MF.ENV_SPEC | MF.PLANAR | MF.CROWD | MF.LINING;
/** The cheap surface features (shader-split-combos.md §0: +~600 SPIR-V instructions make every measured non-city scene
 *  100 % covered by `*-BASE` and the city 84-90 %). */
export const MF_CHEAP = MF.METAL | MF.NEON | MF.FOLIAGE | MF.BOARD;
/** `U-BASE`: every style + the light + cheap features + the untextured-only radial fade and glass. */
export const MF_BASE_UNTEX = MF_LIGHT | MF_CHEAP | MF.RADIAL | MF.GLASS;
/** `T-BASE`: every style + the light + cheap features + the texture sample / normal map / cutout / hair / band /
 *  texture-over-base / GARP pool atlas. */
export const MF_BASE_TEX = MF_LIGHT | MF_CHEAP | MF.TEXSAMPLE | MF.NORMAL_MAP | MF.CUTOUT | MF.HAIR | MF.HAIR_BAND | MF.TEX_OVER_BASE | MF.GARP;
/** The SHADOW-receiving `*-BASE` leaves these out (shader-split.md §11.1: with them it measured 4,249 / 4,440 SPIR-V
 *  instructions, over the 4,000 budget; without them 3,809 / 3,876). None of them occurs in a measured shadowed scene
 *  (shader-split-combos.md: neon, planar and CD never appear in the city, boards are packaging, textured hair is a
 *  skinned character part, and skinned parts never receive shadows). A shadowed key with one of them is still drawn
 *  exactly; it waits for its own (small) shader instead of borrowing BASE. */
export const MF_BASE_SHADOW_DROP = MF.NEON | MF.PLANAR | MF.BOARD | MF.HAIR | MF.HAIR_BAND;
/** The styles of the shadow-receiving `*-BASE`: every style but CD (7; see MF_BASE_SHADOW_DROP). */
export const MESH_FS_STYLES_BASE_SHADOW = 0x7f;

/** A specialised mesh fragment shader. */
export interface MeshFsKey {
  /** Textured layout (material.hasTexture || hasNormalMap, as today): bind group 1 = textures. */
  tex: boolean;
  /** Shadow-receiving layout (Renderer3D._shadowsEnabled; skinned: always false). */
  shadow: boolean;
  /** The render-debug hooks (ibl.dbgShade / ibl.dbgFlags non-zero). */
  debug: boolean;
  /** The inline SSR trace (ssrEnabled && !ssrDeferred). */
  ssrInline: boolean;
  /** BISECT ONLY: the runtime blocks (fog, fog horizon, fade bands, point lights, PS1) are removed too. */
  lean: boolean;
  /** RESERVED PRECISION BIT (shader-split.md "Future: shader-f16"): false = f32 (always, in phase 1). An f16 key gets
   *  the f16 prelude (enable f16 + the hf aliases) and its own pipelines; f32 and f16 pipelines can then coexist. */
  f16: boolean;
  /** Bit n = render style n compiled in. */
  styles: number;
  /** MF bits. */
  feat: number;
  /** Bit m (1..7) = pattern mode m compiled in. */
  pat: number;
  /** Bit n (0..21) = procedural ground mode n (phase 2; the template compiles every mode while GROUND is set). */
  gm: number;
  /** PLAIN-ROUTED (phase 4; template PLAIN_ROUTE): the pattern block takes its PLAIN defaults, as the pre-split PLAIN
   *  uber shader did for the face-kit multiply axis and the planar mirror's multi-material entry (meshFsNumPlain).
   *  Its own identity: a plain-routed key is only drawn by plain-routed supersets. Absent = false. */
  plain?: boolean;
}

// ── Bit classification (the guard) ─────────────────────────────────────────────────────────────────────────────

/** KEY = a key bit (feature named), RUNTIME = stays a runtime test in every shader that has it today, VS_ONLY = read
 *  by the vertex shader only, FREE = unused. */
export type MeshFsBitClass = 'KEY' | 'RUNTIME' | 'VS_ONLY' | 'FREE';
export interface MeshFsBitInfo { bit: number; name: string; cls: MeshFsBitClass; feature?: string }

/** Every bit of encodeMaterialFlags (material-3d.ts), 0..31. */
export const MATERIAL_FLAG_BITS: readonly MeshFsBitInfo[] = [
  { bit: 0, name: 'hasTexture', cls: 'KEY', feature: 'TEXSAMPLE' },
  { bit: 1, name: 'hasNormalMap', cls: 'KEY', feature: 'NORMAL_MAP' },
  { bit: 2, name: 'renderStyle0', cls: 'KEY', feature: 'STYLE_n' },
  { bit: 3, name: 'renderStyle1', cls: 'KEY', feature: 'STYLE_n' },
  { bit: 4, name: 'renderStyle2', cls: 'KEY', feature: 'STYLE_n' },
  { bit: 5, name: 'alphaCutout', cls: 'KEY', feature: 'CUTOUT' },
  { bit: 6, name: 'hairSheen', cls: 'KEY', feature: 'HAIR' },
  { bit: 7, name: 'rimEnabled', cls: 'KEY', feature: 'RIM' },
  { bit: 8, name: '(free: was sparkleEnabled)', cls: 'FREE' },
  { bit: 9, name: 'patternMode0', cls: 'KEY', feature: 'PAT_n' },
  { bit: 10, name: 'patternMode1', cls: 'KEY', feature: 'PAT_n' },
  { bit: 11, name: 'patternMode2', cls: 'KEY', feature: 'PAT_n' },
  { bit: 12, name: '(free: was sparkleStar)', cls: 'FREE' },
  { bit: 13, name: 'leafCard', cls: 'KEY', feature: 'LEAF' },
  { bit: 14, name: 'glassEnhance', cls: 'KEY', feature: 'GLASS' },
  { bit: 15, name: 'texOverBase', cls: 'KEY', feature: 'TEX_OVER_BASE' },
  { bit: 16, name: 'boardShade', cls: 'KEY', feature: 'BOARD' },
  { bit: 17, name: 'radialFade', cls: 'KEY', feature: 'RADIAL' },
  { bit: 18, name: 'groundShade', cls: 'KEY', feature: 'GROUND' },
  { bit: 19, name: 'windSway', cls: 'VS_ONLY' },
  { bit: 20, name: 'foliageShade', cls: 'KEY', feature: 'FOLIAGE' },
  { bit: 21, name: 'waterShade', cls: 'KEY', feature: 'WATER' },
  { bit: 22, name: 'neonShade', cls: 'KEY', feature: 'NEON' },
  { bit: 23, name: 'metalShade', cls: 'KEY', feature: 'METAL' },
  { bit: 24, name: 'garpTex', cls: 'KEY', feature: 'GARP' },
  { bit: 25, name: 'noEnvReflection (matte)', cls: 'KEY', feature: 'ENV_SPEC' },
  { bit: 26, name: 'planarReflector', cls: 'KEY', feature: 'PLANAR' },
  { bit: 27, name: 'worldTriplanar', cls: 'KEY', feature: 'TRIPLANAR' },
  { bit: 28, name: 'softLighting', cls: 'VS_ONLY' },
  { bit: 29, name: 'skinRamp', cls: 'KEY', feature: 'TOON' },
  { bit: 30, name: 'toonShadow', cls: 'KEY', feature: 'TOON' },
  { bit: 31, name: 'retroColor (PS1 opt-in)', cls: 'RUNTIME' },
];

/** Every bit of encodeMeshFlags2 (material-3d.ts FLAGS2_*), 0..8 (9..23 are free). */
export const FLAGS2_BITS: readonly MeshFsBitInfo[] = [
  { bit: 0, name: 'FLAGS2_DISTANCE_FADE', cls: 'RUNTIME' },
  { bit: 1, name: 'FLAGS2_DISTANCE_FADE_ATTACH', cls: 'RUNTIME' },
  { bit: 2, name: 'FLAGS2_NO_FOG', cls: 'RUNTIME' },
  { bit: 3, name: 'FLAGS2_NO_FOG_HARD_EDGE', cls: 'RUNTIME' },
  { bit: 4, name: 'FLAGS2_CROWD_PALETTE', cls: 'KEY', feature: 'CROWD' },
  { bit: 5, name: 'FLAGS2_HLOD_FADE', cls: 'RUNTIME' },
  { bit: 6, name: 'FLAGS2_FACE_DEPTH_PULL', cls: 'VS_ONLY' },
  { bit: 7, name: 'FLAGS2_HAIR_BAND', cls: 'KEY', feature: 'HAIR_BAND' },
  { bit: 8, name: 'FLAGS2_CLOTH_LINING', cls: 'KEY', feature: 'LINING' },
];

// ── Derivation ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Material parameters a key needs beyond the flags (phase 2: the ad-screen switch and the ground mode). */
export interface MeshFsKeyParams {
  /** patternParams.z > 1.5 on a pattern-mode-7 material (an ad screen). */
  adScreen?: boolean;
  /** The procedural ground mode INDEX the shader dispatches on (0..21; meshFsGroundModeIndex of the slot value). */
  groundMode?: number;
}

/** The ground-mode index groundSurface / groundHeightM dispatch on for a slot whose patternParams.w is `w` (float 55):
 *  the template's gScale10 = floor(w / 100), gMode = w - gScale10 * 100, mi = i32(gMode + 0.5), in f32. A mode outside
 *  1..21 falls through to the ashlar tiler, which is GM_0. (Only an exact multiple of 100 sits near a floor boundary,
 *  where GPU division error could give 0 or 100: both are ashlar, so the index is robust.) */
export function meshFsGroundModeIndex(w: number): number {
  const f = Math.fround;
  const s10 = Math.floor(f(f(w) / 100));
  const mode = f(f(w) - f(s10 * 100));
  const mi = Math.trunc(f(mode + 0.5));
  return mi >= 1 && mi <= 21 ? mi : 0;
}

/** The material part of a key (globals false) from the instance flags + flags2 exactly as written to the slot. */
export function meshFsKeyOfFlags(flags: number, flags2: number, tex: boolean, params: MeshFsKeyParams = {}): MeshFsKey {
  const f = flags >>> 0, f2 = flags2 >>> 0;
  const style = (f >>> 2) & 7;
  const cel = style === 1 || style === 5;
  const patMode = (f >>> 9) & 7;
  let feat = 0;
  if (tex) {
    if (f & 1) feat |= MF.TEXSAMPLE;
    if (f & 2) feat |= MF.NORMAL_MAP;
    if (f & 32) feat |= MF.CUTOUT;
    if (f & 0x8000000) feat |= MF.TRIPLANAR;
    if (f & 0x1000000) feat |= MF.GARP;
    if (f & 0x8000) feat |= MF.TEX_OVER_BASE;
    if (f & 64) feat |= MF.HAIR;
    if ((f & 64) && (f2 & 128) && cel) feat |= MF.HAIR_BAND;
  } else {
    if (f & 0x20000) feat |= MF.RADIAL;
    if (f & 0x2000) feat |= MF.LEAF;
    if (f & 0x4000) feat |= MF.GLASS;
  }
  if (cel && (f & (0x20000000 | 0x40000000))) feat |= MF.TOON;
  if (f & 128) feat |= MF.RIM;
  const matte = (f & 0x2000000) !== 0;
  if (style === 0 && !matte) {
    feat |= MF.ENV_SPEC;
    if (f & 0x4000000) feat |= MF.PLANAR;
  }
  if (f2 & 16) feat |= MF.CROWD;
  if (f2 & 256) feat |= MF.LINING;
  if (f & 0x10000) feat |= MF.BOARD;
  if (f & 0x800000) feat |= MF.METAL;
  if (f & 0x400000) feat |= MF.NEON;
  if (f & 0x200000) feat |= MF.WATER;
  if (f & 0x100000) feat |= MF.FOLIAGE;
  let gm = 0;
  if (f & 0x40000) { feat |= MF.GROUND; const gi = Math.floor(params.groundMode ?? 0); gm = 1 << (gi >= 1 && gi <= 21 ? gi : 0); }
  if (patMode === 7 && params.adScreen) feat |= MF.AD_SCREEN;
  return { tex, shadow: false, debug: false, ssrInline: false, lean: false, f16: false, styles: 1 << style, feat, pat: patMode ? 1 << patMode : 0, gm };
}

/** Scene-global key bits (MeshFsKey shadow / debug / ssrInline) packed: 1 shadow, 2 debug, 4 inline SSR. */
export const MESH_FS_G_SHADOW = 1;
export const MESH_FS_G_DEBUG = 2;
export const MESH_FS_G_SSR_INLINE = 4;
/** Reserved: the f16 precision bit (never set in phase 1). */
export const MESH_FS_G_F16 = 8;

// ── Coverage + the packed key ───────────────────────────────────────────────────────────────────────────────────

const P24 = 2 ** 24, P27 = 2 ** 27, P28 = 2 ** 28, P31 = 2 ** 31, P36 = 2 ** 36;
/** The packed key's PLAIN-ROUTE bit (meshFsNumPlain): above every material field. */
const PLAIN_BIT = P36;

/** The PACKED exact key of one instance slot: feat + style * 2^24 + tex * 2^27 + patMode * 2^28 + groundModeIndex *
 *  2^31 (< 2^36; always >= 0). `pz` / `pw` are the slot's patternParams.z / .w (floats 54 / 55: read only for an ad
 *  screen / procedural ground). Cheap: called on every instance-slot write. */
export function meshFsKeyNum(flags: number, flags2: number, tex: boolean, pz = 0, pw = 0): number {
  // memo on what the key reads: the flags, the static flags2 bits (4 crowd, 7 hair band, 8 lining), the layout, and
  // (only where the shader reads them) the ad-screen switch and the ground-mode index
  const f = flags >>> 0, f2 = flags2 >>> 0;
  const ad = ((f >>> 9) & 7) === 7 && pz > 1.5;
  const gi = (f & 0x40000) !== 0 ? meshFsGroundModeIndex(pw) : -1;
  const id = f * 16 + ((f2 >>> 4) & 1) + ((f2 >>> 6) & 2) + ((f2 >>> 6) & 4) + (tex ? 8 : 0) + ((ad ? 1 : 0) + (gi + 1) * 2) * P36;
  let n = keyNumMemo.get(id);
  if (n === undefined) {
    const k = meshFsKeyOfFlags(f, f2, tex, { adScreen: ad, groundMode: gi < 0 ? 0 : gi });
    n = k.feat + Math.round(Math.log2(k.styles)) * P24 + (tex ? P27 : 0) + ((f >>> 9) & 7) * P28 + (gi > 0 ? gi : 0) * P31;
    keyNumMemo.set(id, n);
  }
  return n;
}
const keyNumMemo = new Map<number, number>();
/** @deprecated phase-1 name of meshFsKeyNum (kept for callers outside the engine). */
export const meshFsPhase1Num = meshFsKeyNum;

/** The full key of packed key `num` (meshFsKeyNum, or a PLAIN-routed meshFsNumPlain) under the global bits `g`
 *  (MESH_FS_G_*). */
export function meshFsKeyOfNum(num: number, g: number): MeshFsKey {
  const plain = num >= PLAIN_BIT;
  const n = plain ? num - PLAIN_BIT : num;
  const feat = n % P24, r = Math.floor(n / P24);
  const style = r % 8, tex = Math.floor(r / 8) % 2 === 1, pm = Math.floor(r / 16) % 8, gi = Math.floor(r / 128);
  const k: MeshFsKey = {
    tex, shadow: (g & MESH_FS_G_SHADOW) !== 0, debug: (g & MESH_FS_G_DEBUG) !== 0,
    ssrInline: (g & MESH_FS_G_SSR_INLINE) !== 0, lean: false, f16: (g & MESH_FS_G_F16) !== 0,
    styles: 1 << style, feat, pat: pm ? 1 << pm : 0, gm: (feat & MF.GROUND) !== 0 ? 1 << gi : 0,
  };
  if (plain) k.plain = true;
  return k;
}

/** True when packed key `num` has no pattern mode, no procedural ground and no ad screen (the pattern block of such a
 *  key is the PLAIN default already). */
export function meshFsNumPlainSafe(num: number): boolean {
  return num >= 0 && num < PLAIN_BIT && Math.floor(num / P28) % 8 === 0 && ((num % P24) & (MF.GROUND | MF.AD_SCREEN)) === 0;
}

/** The PLAIN-ROUTED key of packed key `num` (MeshFsKey.plain): the key itself with the pattern block on its PLAIN
 *  defaults. The two draw sites that drew with the pre-split PLAIN uber shader by a material other than the slot's
 *  (the face-kit multiply axis; the planar mirror's multi-material entry routed by the MESH material) draw with it,
 *  so they keep those exact pixels (shader-split.md §14). Identity for a PLAIN-safe key (its pattern block is the
 *  default already) and for -1. */
export function meshFsNumPlain(num: number): number {
  return num < 0 || num >= PLAIN_BIT || meshFsNumPlainSafe(num) ? num : num + PLAIN_BIT;
}

/** The `*-BASE` family for a layout + globals (spec §4.3): every style, the light + cheap features. The shadow-receiving
 *  BASE leaves out MF_BASE_SHADOW_DROP and the CD style (the 4,000-instruction budget; shader-split.md §11.1). */
export function meshFsBaseKey(tex: boolean, shadow: boolean, debug: boolean, ssrInline: boolean): MeshFsKey {
  const feat = (tex ? MF_BASE_TEX : MF_BASE_UNTEX) & ~(shadow ? MF_BASE_SHADOW_DROP : 0);
  return { tex, shadow, debug, ssrInline, lean: false, f16: false, styles: shadow ? MESH_FS_STYLES_BASE_SHADOW : 0xff, feat, pat: 0, gm: 0 };
}

/** KEY CAP WIDENING (spec §4.5, shader-split-combos.md §5 rec. 2): step 1 = every ground mode; step 2 = every style AND
 *  the light features (TOON, RIM, ENV_SPEC, PLANAR, CROWD, LINING) together (styles alone merged none of the 58 city
 *  keys); step 3 = + the `*-BASE` features. Each step keeps everything the key had, so the result still covers it. */
export function meshFsWidenKey(k: MeshFsKey, step: 1 | 2 | 3): MeshFsKey {
  let w = { ...k };
  if (step >= 1 && (w.feat & MF.GROUND)) w.gm = (1 << 22) - 1;
  if (step >= 2) w = { ...w, styles: 0xff, feat: w.feat | MF_LIGHT };
  if (step >= 3) w = { ...w, feat: w.feat | (w.tex ? MF_BASE_TEX : MF_BASE_UNTEX) };
  return w;
}

/** The `*-ALL` key: every feature (= today's FULL shader; DEBUG / SSR_INLINE as given). */
export function meshFsAllKey(tex: boolean, shadow: boolean, debug = true, ssrInline = true): MeshFsKey {
  return { tex, shadow, debug, ssrInline, lean: false, f16: false, styles: 0xff, feat: MF_ALL, pat: 0xfe, gm: (1 << 22) - 1 };
}

/** True when a shader for `a` draws every mesh of key `b` with b's pixels (a is a superset of b). */
export function meshFsKeyCovers(a: MeshFsKey, b: MeshFsKey): boolean {
  return a.tex === b.tex && a.shadow === b.shadow && a.debug === b.debug && a.ssrInline === b.ssrInline && a.f16 === b.f16
    && !!a.plain === !!b.plain && (!a.lean || b.lean)
    && (b.styles & ~a.styles) === 0 && (b.feat & ~a.feat) === 0 && (b.pat & ~a.pat) === 0 && (b.gm & ~a.gm) === 0;
}

/** The phase-1 bisect transforms (spec §7 phase-1 risk: "the rainbow may not be purely size"). 'noTexSample' = a
 *  textured key without the diffuse sample (texture not shown); 'minimal' = only the styles + the texture features
 *  (TEXSAMPLE, CUTOUT, NORMAL_MAP, TEX_OVER_BASE), no debug hooks, and LEAN (no fog / fog horizon / fade bands / point
 *  lights / PS1). Both change pixels only where a removed feature was active ('minimal' is exact for a plain document
 *  with no fog, PS1, point lights, rim, metals or SSR). */
export type MeshFsBisect = 'none' | 'noTexSample' | 'minimal';
export function meshFsBisectKey(k: MeshFsKey, mode: MeshFsBisect): MeshFsKey {
  if (mode === 'noTexSample') return k.tex ? { ...k, feat: k.feat & ~MF.TEXSAMPLE } : k;
  if (mode === 'minimal') {
    return { ...k, debug: false, ssrInline: false, lean: true, feat: k.feat & (MF.TEXSAMPLE | MF.CUTOUT | MF.NORMAL_MAP | MF.TEX_OVER_BASE) };
  }
  return k;
}

// ── Strings + directive identifiers ─────────────────────────────────────────────────────────────────────────────

const bitList = (mask: number, max: number): string => { const o: number[] = []; for (let i = 0; i <= max; i++) if (mask & (1 << i)) o.push(i); return o.join(','); };

/** Canonical key string, e.g. `U|sh|s=01|RIM,ENV_SPEC|p=|gm=|-` (pipeline labels, the id registry, memo keys). */
export function meshFsKeyString(k: MeshFsKey): string {
  const feats = MF_NAMES.filter((n) => (k.feat & MF[n]) !== 0).join(',');
  const g = [k.debug ? 'dbg' : '', k.ssrInline ? 'ssr' : '', k.lean ? 'lean' : '', k.f16 ? 'f16' : '', k.plain ? 'plain' : ''].filter(Boolean).join('+') || '-';
  return `${k.tex ? 'T' : 'U'}|${k.shadow ? 'sh' : '-'}|s=${(k.styles & 0xff).toString(16).padStart(2, '0')}|${feats}|p=${bitList(k.pat, 7)}|gm=${bitList(k.gm, 21)}|${g}`;
}

/** The key of canonical string `s` (meshFsKeyString), or null when it is not one (the seen-keys journal reads keys
 *  stored by an older build: anything unknown is dropped, never guessed). */
export function meshFsKeyParse(s: string): MeshFsKey | null {
  const p = s.split('|');
  if (p.length !== 7 || (p[0] !== 'U' && p[0] !== 'T') || (p[1] !== 'sh' && p[1] !== '-') || !/^s=[0-9a-f]{2}$/.test(p[2])) return null;
  let feat = 0;
  for (const n of p[3] ? p[3].split(',') : []) { if (!(n in MF)) return null; feat |= MF[n as MeshFsFeature]; }
  const bits = (t: string, pre: string, max: number): number | null => {
    if (!t.startsWith(pre)) return null;
    let m = 0;
    for (const x of t.slice(pre.length) ? t.slice(pre.length).split(',') : []) { const i = Number(x); if (!Number.isInteger(i) || i < 0 || i > max) return null; m |= 1 << i; }
    return m;
  };
  const pat = bits(p[4], 'p=', 7), gm = bits(p[5], 'gm=', 21);
  if (pat === null || gm === null) return null;
  const g = p[6] === '-' ? [] : p[6].split('+');
  if (g.some((x) => x !== 'dbg' && x !== 'ssr' && x !== 'lean' && x !== 'f16' && x !== 'plain')) return null;
  const k: MeshFsKey = { tex: p[0] === 'T', shadow: p[1] === 'sh', debug: g.includes('dbg'), ssrInline: g.includes('ssr'), lean: g.includes('lean'), f16: g.includes('f16'),
    styles: parseInt(p[2].slice(2), 16), feat, pat, gm };
  if (g.includes('plain')) k.plain = true;
  return meshFsKeyString(k) === s ? k : null;
}

/** Every identifier the template's directives may use. */
export const MESH_FS_DEFINES: ReadonlySet<string> = new Set<string>([
  'TEX', 'SHADOW', 'DEBUG', 'SSR_INLINE', 'LEAN',
  ...Array.from({ length: 8 }, (_, i) => `STYLE_${i}`),
  ...MF_NAMES,
  ...Array.from({ length: 7 }, (_, i) => `PAT_${i + 1}`), 'PAT_ANY', 'PAT_TILED', 'PAT_RELIEF',
  ...Array.from({ length: 22 }, (_, i) => `GM_${i}`),
  'TEX_DIFFUSE', 'PLAIN_ROUTE',
]);

/** The defined identifiers of key `k` (including the derived PAT_ANY / PAT_TILED / PAT_RELIEF / TEX_DIFFUSE). */
export function meshFsDefines(k: MeshFsKey): Set<string> {
  const d = new Set<string>();
  if (k.tex) d.add('TEX');
  if (k.shadow) d.add('SHADOW');
  if (k.debug) d.add('DEBUG');
  if (k.ssrInline) d.add('SSR_INLINE');
  if (k.lean) d.add('LEAN');
  if (k.plain) d.add('PLAIN_ROUTE');
  for (let i = 0; i < 8; i++) if (k.styles & (1 << i)) d.add(`STYLE_${i}`);
  for (const n of MF_NAMES) if (k.feat & MF[n]) d.add(n);
  for (let m = 1; m <= 7; m++) if (k.pat & (1 << m)) d.add(`PAT_${m}`);
  if (k.pat & 0xfe) d.add('PAT_ANY');
  if (k.pat & 0x3e) d.add('PAT_TILED');
  if (k.pat & 0x7e) d.add('PAT_RELIEF');
  for (let i = 0; i < 22; i++) if (k.gm & (1 << i)) d.add(`GM_${i}`);
  if (k.tex && (k.feat & (MF.TEXSAMPLE | MF.CUTOUT | MF.TRIPLANAR | MF.GARP))) d.add('TEX_DIFFUSE');
  return d;
}
