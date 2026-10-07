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
 * PHASE 1 (meshFsPhase1Num): every key that `*-BASE` covers is selected, in any render style (so every measured
 * illustration, UV-paint, character, CD and packaging key, and most of the city); a mesh with a pattern, procedural
 * ground, water, a leaf card, triplanar or an ad screen keeps today's pipelines.
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
  /** The procedural ground mode (0..21). */
  groundMode?: number;
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
  if (f & 0x40000) { feat |= MF.GROUND; gm = 1 << Math.max(0, Math.min(21, Math.floor(params.groundMode ?? 0))); }
  if (patMode === 7 && params.adScreen) feat |= MF.AD_SCREEN;
  return { tex, shadow: false, debug: false, ssrInline: false, lean: false, f16: false, styles: 1 << style, feat, pat: patMode ? 1 << patMode : 0, gm };
}

/** Scene-global key bits (MeshFsKey shadow / debug / ssrInline) packed: 1 shadow, 2 debug, 4 inline SSR. */
export const MESH_FS_G_SHADOW = 1;
export const MESH_FS_G_DEBUG = 2;
export const MESH_FS_G_SSR_INLINE = 4;
/** Reserved: the f16 precision bit (never set in phase 1). */
export const MESH_FS_G_F16 = 8;

/** PHASE 1 packed mesh key (feat | style << 24 | tex << 27), or -1 when `*-BASE` does not cover the mesh (it keeps
 *  today's pipelines). Cheap: called on every instance-slot write. */
export function meshFsPhase1Num(flags: number, flags2: number, tex: boolean): number {
  // memo on what the key reads: the flags, the static flags2 bits (4 crowd, 7 hair band, 8 lining) and the layout
  const f2 = flags2 >>> 0;
  const id = (flags >>> 0) * 16 + ((f2 >>> 4) & 1) + ((f2 >>> 6) & 2) + ((f2 >>> 6) & 4) + (tex ? 8 : 0);
  let n = phase1Memo.get(id);
  if (n === undefined) {
    const k = meshFsKeyOfFlags(flags, flags2, tex);
    n = (k.pat !== 0 || k.gm !== 0 || (k.feat & ~(tex ? MF_BASE_TEX : MF_BASE_UNTEX)) !== 0) ? -1
      : k.feat + ((Math.log2(k.styles) | 0) << 24) + (tex ? 1 << 27 : 0);
    phase1Memo.set(id, n);
  }
  return n;
}
const phase1Memo = new Map<number, number>();

/** The full key of packed mesh key `num` (meshFsPhase1Num) under the global bits `g` (MESH_FS_G_*). */
export function meshFsKeyOfNum(num: number, g: number): MeshFsKey {
  return {
    tex: (num & (1 << 27)) !== 0, shadow: (g & MESH_FS_G_SHADOW) !== 0, debug: (g & MESH_FS_G_DEBUG) !== 0,
    ssrInline: (g & MESH_FS_G_SSR_INLINE) !== 0, lean: false, f16: (g & MESH_FS_G_F16) !== 0,
    styles: 1 << ((num >>> 24) & 7), feat: num & MF_ALL, pat: 0, gm: 0,
  };
}

/** The `*-BASE` family for a layout + globals (spec §4.3): every style, the light features. */
export function meshFsBaseKey(tex: boolean, shadow: boolean, debug: boolean, ssrInline: boolean): MeshFsKey {
  return { tex, shadow, debug, ssrInline, lean: false, f16: false, styles: 0xff, feat: tex ? MF_BASE_TEX : MF_BASE_UNTEX, pat: 0, gm: 0 };
}

/** The `*-ALL` key: every feature (= today's FULL shader; DEBUG / SSR_INLINE as given). */
export function meshFsAllKey(tex: boolean, shadow: boolean, debug = true, ssrInline = true): MeshFsKey {
  return { tex, shadow, debug, ssrInline, lean: false, f16: false, styles: 0xff, feat: MF_ALL, pat: 0xfe, gm: (1 << 22) - 1 };
}

/** True when a shader for `a` draws every mesh of key `b` with b's pixels (a is a superset of b). */
export function meshFsKeyCovers(a: MeshFsKey, b: MeshFsKey): boolean {
  return a.tex === b.tex && a.shadow === b.shadow && a.debug === b.debug && a.ssrInline === b.ssrInline && a.f16 === b.f16
    && (!a.lean || b.lean)
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
  const g = [k.debug ? 'dbg' : '', k.ssrInline ? 'ssr' : '', k.lean ? 'lean' : '', k.f16 ? 'f16' : ''].filter(Boolean).join('+') || '-';
  return `${k.tex ? 'T' : 'U'}|${k.shadow ? 'sh' : '-'}|s=${(k.styles & 0xff).toString(16).padStart(2, '0')}|${feats}|p=${bitList(k.pat, 7)}|gm=${bitList(k.gm, 21)}|${g}`;
}

/** Every identifier the template's directives may use. */
export const MESH_FS_DEFINES: ReadonlySet<string> = new Set<string>([
  'TEX', 'SHADOW', 'DEBUG', 'SSR_INLINE', 'LEAN',
  ...Array.from({ length: 8 }, (_, i) => `STYLE_${i}`),
  ...MF_NAMES,
  ...Array.from({ length: 7 }, (_, i) => `PAT_${i + 1}`), 'PAT_ANY', 'PAT_TILED', 'PAT_RELIEF',
  ...Array.from({ length: 22 }, (_, i) => `GM_${i}`),
  'TEX_DIFFUSE',
]);

/** The defined identifiers of key `k` (including the derived PAT_ANY / PAT_TILED / PAT_RELIEF / TEX_DIFFUSE). */
export function meshFsDefines(k: MeshFsKey): Set<string> {
  const d = new Set<string>();
  if (k.tex) d.add('TEX');
  if (k.shadow) d.add('SHADOW');
  if (k.debug) d.add('DEBUG');
  if (k.ssrInline) d.add('SSR_INLINE');
  if (k.lean) d.add('LEAN');
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
