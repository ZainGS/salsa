/**
 * SHADER SPLIT phase 1 (docs/specs/shader-split.md §6.1): the preprocessor, the tree-shaker, the GOLDEN equivalence of
 * the merged template with today's uber-shaders, the dead-feature lint, the key derivation + its bit-classification
 * guard, and the fallback choice. The pixel identity and the compile check run on a real GPU (Dawn) outside vitest;
 * see shader-split.md "Phase 1 status".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as legacy from './mesh3d-shaders';
import * as material from '../material-3d';
import { encodeMaterialFlags, encodeMeshFlags2, type Material3D } from '../material-3d';
import { preprocessWgsl, compactWgsl, evalDirectiveExpr, stripWgslComments } from './wgsl-preprocess';
import { treeShakeWgsl, splitWgslItems } from './wgsl-treeshake';
import { generateMeshFs, meshFsSize, meshFsPrelude } from './mesh-fs-generate';
import { MESH3D_FS_TEMPLATE } from './mesh3d-fs-template';
import {
  MF, MF_ALL, MF_NAMES, MF_BASE_TEX, MF_BASE_UNTEX, MF_BASE_SHADOW_DROP, MF_LIGHT, MATERIAL_FLAG_BITS, FLAGS2_BITS, MESH_FS_DEFINES,
  MESH_FS_G_SHADOW, meshFsKeyOfFlags, meshFsKeyNum, meshFsKeyOfNum, meshFsBaseKey, meshFsAllKey, meshFsKeyCovers, meshFsKeyString,
  meshFsBisectKey, meshFsDefines, meshFsGroundModeIndex, meshFsNumPlainSafe, meshFsKeyParse, meshFsWidenKey, meshFsCovered,
  meshFsCoverageExcluding, setMeshFsCoverage, MESH_FS_FAMILIES, type MeshFsKey,
} from './mesh-fs-key';
import { smallestCovering, MeshFsPipelines, SHADER_SPLIT_JOURNAL_KEY } from '../mesh-fs-pipelines';
import type { GPUPipelineCache } from '../../core/gpu-pipeline-cache';

const KNOWN = new Set(['A', 'B', 'C']);
const pp = (src: string, defs: string[]) => preprocessWgsl(src, new Set(defs), { known: KNOWN });
const key = (o: Partial<MeshFsKey>): MeshFsKey => ({ tex: false, shadow: false, debug: false, ssrInline: false, lean: false, f16: false, styles: 1, feat: 0, pat: 0, gm: 0, ...o });

describe('wgsl-preprocess', () => {
  it('keeps the true branches; elif / else; nesting; strips directives, comments and blank lines', () => {
    const src = ['x0;', '//#if A', 'a1;   // comment', '//#if B', 'ab;', '//#else', 'a!b;', '//#endif', '//#elif C', 'c1;', '//#else', 'none;', '//#endif', '', 'tail; /* block */'].join('\n');
    expect(pp(src, ['A', 'B'])).toBe('x0;\na1;\nab;\ntail;');
    expect(pp(src, ['A'])).toBe('x0;\na1;\na!b;\ntail;');
    expect(pp(src, ['C'])).toBe('x0;\nc1;\ntail;');
    expect(pp(src, [])).toBe('x0;\nnone;\ntail;');
  });
  it('expressions: !, &&, ||, parentheses', () => {
    const d = new Set(['A']);
    expect(evalDirectiveExpr('A && !B', d, KNOWN)).toBe(true);
    expect(evalDirectiveExpr('!(A || B)', d, KNOWN)).toBe(false);
    expect(evalDirectiveExpr('B || C || A', d, KNOWN)).toBe(true);
    expect(evalDirectiveExpr('(A && B) || !C', d, KNOWN)).toBe(true);
  });
  it('fails loud: unknown names (also in dead branches), unbalanced, elif after else, misspelled directives', () => {
    expect(() => pp('//#if Q\n//#endif', [])).toThrow(/unknown identifier "Q"/);
    expect(() => pp('//#if B\n//#if Q\n//#endif\n//#endif', [])).toThrow(/unknown identifier/);
    expect(() => pp('//#if A\nx;', ['A'])).toThrow(/unterminated/);
    expect(() => pp('x;\n//#endif', [])).toThrow(/without/);
    expect(() => pp('//#if A\n//#else\n//#elif B\n//#endif', [])).toThrow(/after \/\/#else/);
    expect(() => pp('//#ifdef A\n//#endif', [])).toThrow(/unknown directive/);
    expect(() => pp('//#if A &&\n//#endif', [])).toThrow(/unexpected end/);
  });
  it('keepComments keeps everything but the directive lines', () => {
    expect(preprocessWgsl('// c\n//#if A\n  a; // x\n//#endif\n', new Set(['A']), { known: KNOWN, keepComments: true })).toBe('// c\n  a; // x\n');
  });
  it('strips line and nested block comments', () => {
    expect(stripWgslComments('a /* x /* y */ z */ b // c\nd')).toBe('a  b \nd');
  });
});

describe('wgsl-treeshake', () => {
  const mod = [
    'struct S { a: f32, };', 'struct Unused { b: f32, };',
    '@group(0) @binding(0) var<uniform> u: S;', '@group(0) @binding(1) var tex: texture_2d<f32>;',
    'const K: f32 = 2.0;', 'const DEAD = array<f32, 2>(1.0, 2.0);', 'var<private> pv: bool = false;',
    'fn leaf(x: f32) -> f32 { return x * K; }', 'fn mid(x: f32) -> f32 { if (pv) { return 0.0; } return leaf(x) + u.a; }',
    'fn dead() -> f32 { return textureLoad(tex, vec2<i32>(0), 0).x; }',
    '@fragment', 'fn fs_main(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> { let s = S(1.0); return vec4<f32>(mid(s.a)); }',
  ].join('\n');
  it('keeps the transitive closure of fs_main and drops the rest (fn, struct, const, binding)', () => {
    const names = splitWgslItems(treeShakeWgsl(mod)).map((i) => i.name);
    expect(names).toEqual(['S', 'u', 'K', 'pv', 'leaf', 'mid', 'fs_main']);
  });
  it('member accesses are not references', () => {
    const out = treeShakeWgsl('fn a() -> f32 { return 1.0; }\nfn fs_main() -> f32 { let s = vec2<f32>(0.0); return s.a; }');
    expect(out).not.toContain('fn a(');
  });
  it('throws on a missing root and unbalanced braces', () => {
    expect(() => treeShakeWgsl('fn x() {}')).toThrow(/root "fs_main"/);
    expect(() => splitWgslItems('fn fs_main() { ')).toThrow(/unbalanced/);
  });
});

// ── golden equivalence (spec §6.1.3) ─────────────────────────────────────────────────────────────────────────────

/** Comments + blank lines stripped, tree-shaken, whitespace collapsed. */
const norm = (s: string): string => treeShakeWgsl(compactWgsl(s)).replace(/\s+/g, ' ').trim();

describe('golden: the merged template with every feature = today\'s uber-shaders', () => {
  const cases: [keyof typeof legacy, boolean, boolean][] = [
    ['MESH3D_FRAGMENT_SHADER_SHADOW_MODERN', true, true],
    ['MESH3D_FRAGMENT_SHADER', true, false],
    ['MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN', false, true],
    ['MESH3D_FRAGMENT_SHADER_UNTEXTURED', false, false],
  ];
  for (const [name, tex, shadow] of cases) {
    it(`${name} (tex ${tex}, shadow ${shadow})`, () => {
      const today = norm(legacy[name] as string);
      const gen = norm(generateMeshFs(meshFsAllKey(tex, shadow, true, true)));
      if (gen !== today) {
        let i = 0; while (i < gen.length && gen[i] === today[i]) i++;
        expect(gen.slice(Math.max(0, i - 120), i + 120)).toBe(today.slice(Math.max(0, i - 120), i + 120));
      }
      expect(gen.length).toBeGreaterThan(100000);
    });
  }
  it('every directive identifier the template uses is known, and every known feature name is used', () => {
    const used = new Set<string>();
    for (const m of MESH3D_FS_TEMPLATE.matchAll(/^\s*\/\/#(?:if|elif)\s+(.*)$/gm)) for (const id of m[1].match(/[A-Z][A-Z0-9_]*/g) ?? []) used.add(id);
    for (const id of used) expect(MESH_FS_DEFINES.has(id), id).toBe(true);
    for (const n of MF_NAMES) expect(used.has(n), n).toBe(true);
  });
});

// ── dead-feature lint (spec §6.1.4) ──────────────────────────────────────────────────────────────────────────────

/** identifiers that must NOT survive when the feature is off (function / binding names unique to it). */
const DEAD: [string, (k: MeshFsKey) => boolean, RegExp][] = [
  ['GROUND', (k) => !(k.feat & MF.GROUND), /\b(groundSurface|groundWeather|groundHeightM|gr_uvMetres)\b/],
  ['PAT_6', (k) => !(k.pat & 64), /\b(windowsPattern|windowShade|wallMasonryH|interiorRoom)\b/],
  ['PAT_ANY', (k) => !(k.pat & 0xfe), /\bpatternMask\b/],
  ['AD_SCREEN', (k) => !(k.feat & MF.AD_SCREEN), /\badScreen\b/],
  ['DEBUG', (k) => !k.debug, /\b(ibl\.dbgShade|ibl\.dbgFlags|textureNumLayers|dbgFinal|rdState)\b/],   // (the IBLUniforms struct keeps its fields)
  ['SSR_INLINE', (k) => !k.ssrInline, /\b(traceSSR|ssrProbeS)\b/],
  ['TEX', (k) => !k.tex, /\b(diffuseTexture|normalMapTexture|garpTexture|quantizeColor)\b/],
  ['!TEX', (k) => k.tex, /\b(quantizeColorUntex|bayer4Untex)\b/],
  ['SHADOW', (k) => !k.shadow, /\b(shadowMap|sampleShadowCascaded|shadowMM)\b/],
  ['PLANAR', (k) => !(k.feat & MF.PLANAR), /\bplanarReflectionTex\b/],
  ['ENV_SPEC', (k) => !(k.feat & MF.ENV_SPEC), /\b(envSpecular|prefilteredEnvMap|brdfLUT)\b/],
  ['CROWD', (k) => !(k.feat & MF.CROWD), /\b(crowdTint|CROWD_PAL)\b/],
  ['LEAF', (k) => !(k.feat & MF.LEAF), /\bleafCardCoverage\b/],
  ['TOON', (k) => !(k.feat & MF.TOON), /\btoon_lighting\b/],
  ['STYLE_7', (k) => !(k.styles & 128), /\b(cd_lighting|spectral_zucconi6)\b/],
  ['STYLE_2', (k) => !(k.styles & 4), /\bsketch_lighting\b/],
  ['STYLE_1', (k) => !(k.styles & 2), /\bcel_lighting\b/],
  ['METAL', (k) => !(k.feat & MF.METAL), /\bmetalSurface\b/],
  ['NEON', (k) => !(k.feat & MF.NEON), /\bneonSign\b/],
  ['WATER', (k) => !(k.feat & MF.WATER), /\bwaterSurface\b/],
  ['FOLIAGE', (k) => !(k.feat & MF.FOLIAGE), /\b(foliageBase|foliageTransmission|foliageY)\b/],
  ['BOARD', (k) => !(k.feat & MF.BOARD), /\bpaperGrain\b/],
  ['RIM', (k) => !(k.feat & MF.RIM), /\brim_param\b/],
  ['LINING / STYLE_7', (k) => !(k.feat & MF.LINING) && !(k.styles & 128), /\bfrontFacing\b/],
  ['HAIR / NORMAL_MAP', (k) => !(k.feat & (MF.HAIR | MF.NORMAL_MAP)), /\bworldTangent\b/],
];

/** A matrix of keys: every style x the phase-1 features, the families, and single phase-2 features. */
function keyMatrix(): MeshFsKey[] {
  const out: MeshFsKey[] = [];
  for (const tex of [false, true]) for (const shadow of [false, true]) for (const debug of [false, true]) {
    for (let s = 0; s < 8; s++) {
      out.push(key({ tex, shadow, debug, styles: 1 << s }));
      out.push(key({ tex, shadow, debug, styles: 1 << s, feat: (tex ? MF_BASE_TEX : MF_BASE_UNTEX) & ~MF.PLANAR }));
    }
    for (const f of MF_NAMES) out.push(key({ tex, shadow, debug, feat: MF[f] | MF.ENV_SPEC }));
    for (let m = 1; m <= 7; m++) out.push(key({ tex, shadow, debug, pat: 1 << m }));
    out.push(meshFsBaseKey(tex, shadow, debug, false), meshFsBaseKey(tex, shadow, debug, true));
  }
  return out;
}

describe('dead-feature lint: no identifier of an OFF feature survives in a generated shader', () => {
  it('every key of the matrix', () => {
    const bad: string[] = [];
    for (const k of keyMatrix()) {
      const code = generateMeshFs(k);
      for (const [name, off, re] of DEAD) if (off(k) && re.test(code)) bad.push(`${meshFsKeyString(k)}: ${name} -> ${code.match(re)![0]}`);
    }
    expect(bad).toEqual([]);
  });
  it('the plain / textured PBR keys are a small fraction of the uber-shader', () => {
    const u = meshFsSize(generateMeshFs(key({ styles: 1, feat: MF.ENV_SPEC })));
    const t = meshFsSize(generateMeshFs(key({ tex: true, styles: 1, feat: MF.ENV_SPEC | MF.TEXSAMPLE })));
    const today = meshFsSize(compactWgsl(legacy.MESH3D_FRAGMENT_SHADER_PLAIN));
    expect(u.bytes).toBeLessThan(today.bytes * 0.2);
    expect(t.bytes).toBeLessThan(today.bytes * 0.2);
    expect(u.fns).toBeLessThan(25);
  });
});

// ── key derivation + the classification guard (spec §4.1, §6.1.5) ───────────────────────────────────────────────

describe('mesh FS key', () => {
  it('classifies all 32 material flag bits and the flags2 bits', () => {
    expect(MATERIAL_FLAG_BITS.map((b) => b.bit)).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(FLAGS2_BITS.map((b) => b.bit)).toEqual(Array.from({ length: FLAGS2_BITS.length }, (_, i) => i));
  });

  it('GUARD: every bit encodeMaterialFlags sets is classified as used (a new feature bit must be added to the key)', () => {
    const src = readFileSync(fileURLToPath(new URL('../material-3d.ts', import.meta.url)), 'utf8');
    const body = src.slice(src.indexOf('export function encodeMaterialFlags'), src.indexOf('return flags >>> 0', src.indexOf('export function encodeMaterialFlags')));
    const bits = new Set<number>();
    for (const m of body.matchAll(/flags\s*\|=\s*(0x[0-9a-fA-F]+|\d+)\s*;/g)) { const v = Number(m[1]) >>> 0; for (let b = 0; b < 32; b++) if (v & (2 ** b)) bits.add(b); }
    for (const m of body.matchAll(/&\s*(\d+)\)\s*<<\s*(\d+)/g)) { const mask = Number(m[1]), sh = Number(m[2]); for (let b = 0; b < 32; b++) if (mask & (1 << b)) bits.add(b + sh); }
    expect(bits.size).toBeGreaterThan(25);
    for (const b of bits) expect(MATERIAL_FLAG_BITS[b].cls, `material flag bit ${b} is set by encodeMaterialFlags but classified FREE`).not.toBe('FREE');
  });

  it('GUARD: every FLAGS2_* bit is classified', () => {
    const consts = Object.entries(material).filter(([k, v]) => /^FLAGS2_/.test(k) && k !== 'FLAGS2_FLOAT' && typeof v === 'number') as [string, number][];
    expect(consts.length).toBeGreaterThan(8);
    for (const [k, v] of consts) {
      const bit = Math.log2(v);
      expect(Number.isInteger(bit), k).toBe(true);
      expect(FLAGS2_BITS[bit]?.name, k).toBe(k);
    }
  });

  const mat = (o: Partial<Material3D>): Material3D => ({ diffuse: { r: 1, g: 1, b: 1 }, specular: { r: 0, g: 0, b: 0 }, emissive: { r: 0, g: 0, b: 0 }, shininess: 32, opacity: 1, ...o } as Material3D);
  const keyOfMat = (m: Material3D, f2: Record<string, unknown> = {}) => meshFsKeyOfFlags(encodeMaterialFlags(m), encodeMeshFlags2({ material: m, ...f2 }), !!(m.hasTexture || m.hasNormalMap));

  it('vertex-only and runtime bits never split a key', () => {
    const base = keyOfMat(mat({}));
    for (const o of [{ windSway: true }, { softLighting: true }, { retroColor: true }] as Partial<Material3D>[]) expect(keyOfMat(mat(o))).toEqual(base);
    for (const f2 of [{ fogClass: 2 }, { fogClass: 1 }, { hlodFade: 0.5 }, { faceDepthPull: 0.1 }]) expect(keyOfMat(mat({}), f2)).toEqual(base);
    expect(keyOfMat(mat({ noFog: true }))).toEqual(base);
  });

  it('no-op bits are dropped where the block cannot run (shader-split-combos.md §0)', () => {
    expect(keyOfMat(mat({ renderStyle: 'cel' })).feat & MF.ENV_SPEC).toBe(0);                    // env spec only in PBR
    expect(keyOfMat(mat({ renderStyle: 'default', noEnvReflection: true })).feat & MF.ENV_SPEC).toBe(0);   // matte
    expect(keyOfMat(mat({ renderStyle: 'default' })).feat & MF.ENV_SPEC).toBe(MF.ENV_SPEC);
    expect(keyOfMat(mat({ hasTexture: true, hairSheen: true, hairBand: true })).feat & MF.HAIR_BAND).toBe(0);   // band: Cel only
    expect(keyOfMat(mat({ hasTexture: true, hairSheen: true, hairBand: true, renderStyle: 'cel' })).feat & MF.HAIR_BAND).toBe(MF.HAIR_BAND);
    expect(keyOfMat(mat({ toonShadow: true, skinRamp: true })).feat & MF.TOON).toBe(0);           // toon: Cel only
    expect(keyOfMat(mat({ toonShadow: true, renderStyle: 'cel-hd' })).feat & MF.TOON).toBe(MF.TOON);
    expect(keyOfMat(mat({ texOverBase: true, boardShade: true })).feat & MF.TEX_OVER_BASE).toBe(0);   // untextured board
    expect(keyOfMat(mat({ hasTexture: true, glassEnhance: true })).feat & MF.GLASS).toBe(0);      // no glass in the textured FS
  });

  it('packed keys round-trip (styles, pattern modes, ground modes, ad screens) and the split covers every single-material key', () => {
    for (let s = 0; s < 8; s++) for (const tex of [false, true]) {
      const f = (s << 2) | (tex ? 1 : 0) | 128;
      const n = meshFsKeyNum(f, 0, tex);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(meshFsKeyOfNum(n, 0)).toEqual(meshFsKeyOfFlags(f, 0, tex));
    }
    for (const o of [{ groundShade: true }, { patternMode: 'stripes' }, { patternMode: 'windows' }, { waterShade: true }, { leafCard: true }, { hasTexture: true, worldTriplanar: true },
      { metalShade: true }, { neonShade: true }, { foliageShade: true }, { boardShade: true }, { radialFade: true }, { glassEnhance: true }, { hasTexture: true, garpTex: true }] as Partial<Material3D>[]) {
      const m = mat(o); expect(meshFsKeyNum(encodeMaterialFlags(m), 0, !!m.hasTexture), JSON.stringify(o)).toBeGreaterThanOrEqual(0);
    }
    // ad screen (pattern mode 7 + patternParams.z > 1.5) and the ground-mode index ride in the packed key
    const waves = encodeMaterialFlags(mat({ patternMode: 'waves' }));
    expect(meshFsKeyOfNum(meshFsKeyNum(waves, 0, false, 2.0), 0)).toMatchObject({ pat: 1 << 7, feat: MF.ENV_SPEC | MF.AD_SCREEN });
    expect(meshFsKeyOfNum(meshFsKeyNum(waves, 0, false, 1.5), 0)).toMatchObject({ pat: 1 << 7, feat: MF.ENV_SPEC });
    expect(meshFsKeyNum(encodeMaterialFlags(mat({ patternMode: 'stripes' })), 0, false, 9)).toBe(meshFsKeyNum(encodeMaterialFlags(mat({ patternMode: 'stripes' })), 0, false, 0));   // z read only for mode 7
    const ground = encodeMaterialFlags(mat({ groundShade: true }));
    for (let gm = 0; gm <= 21; gm++) for (const scale10 of [0, 15, 20]) {
      const k = meshFsKeyOfNum(meshFsKeyNum(ground, 0, false, 0, gm + 100 * scale10), MESH_FS_G_SHADOW);
      expect(k).toMatchObject({ gm: 1 << gm, shadow: true, feat: MF.GROUND | MF.ENV_SPEC, pat: 0 });
    }
    expect(meshFsKeyOfNum(meshFsKeyNum(ground, 0, false, 0, 25), 0).gm).toBe(1);   // out of range: the ashlar fall-through
    // a random sweep: the memoised packed key = the direct derivation, for every flags / flags2 / slot params
    let x = 12345;
    for (let i = 0; i < 4000; i++) {
      x = (x * 1103515245 + 12345) >>> 0; const f = x;
      x = (x * 1103515245 + 12345) >>> 0; const f2 = x & 0x1ff;
      x = (x * 1103515245 + 12345) >>> 0; const pz = (x % 400) / 100;
      x = (x * 1103515245 + 12345) >>> 0; const pw = x % 3000;
      const tex = (i & 1) === 1;
      const n = meshFsKeyNum(f, f2, tex, pz, pw);
      const k = meshFsKeyOfFlags(f, f2, tex, { adScreen: ((f >>> 9) & 7) === 7 && pz > 1.5, groundMode: meshFsGroundModeIndex(pw) });
      expect(n).toBeGreaterThanOrEqual(0);
      expect(meshFsCovered(k)).toBe(true);
      expect(meshFsKeyOfNum(n, 0)).toEqual(k);
      expect(n).toBeLessThan(2 ** 36);
    }
  });

  it('family exclusion (the per-device safety valve) narrows the coverage and restores it', () => {
    const win = encodeMaterialFlags(mat({ patternMode: 'windows' })), stripes = encodeMaterialFlags(mat({ patternMode: 'stripes' })), ground = encodeMaterialFlags(mat({ groundShade: true }));
    try {
      setMeshFsCoverage(meshFsCoverageExcluding(['windows']));
      expect(meshFsKeyNum(win, 0, false)).toBe(-1);
      expect(meshFsKeyNum(stripes, 0, false)).toBeGreaterThanOrEqual(0);
      setMeshFsCoverage(meshFsCoverageExcluding(['ground', 'patterns']));
      expect(meshFsKeyNum(ground, 0, false, 0, 4)).toBe(-1);
      expect(meshFsKeyNum(stripes, 0, false)).toBe(-1);
      expect(meshFsKeyNum(win, 0, false)).toBeGreaterThanOrEqual(0);
      setMeshFsCoverage(meshFsCoverageExcluding(['phase2']));   // = phase 1: the BASE features only
      expect(meshFsKeyNum(win, 0, false)).toBe(-1);
      expect(meshFsKeyNum(encodeMaterialFlags(mat({ waterShade: true })), 0, false)).toBe(-1);
      expect(meshFsKeyNum(encodeMaterialFlags(mat({ metalShade: true, renderStyle: 'cel' })), 0, false)).toBeGreaterThanOrEqual(0);
    } finally { setMeshFsCoverage(meshFsCoverageExcluding([])); }
    expect(meshFsKeyNum(win, 0, false)).toBeGreaterThanOrEqual(0);
    expect(MESH_FS_FAMILIES).toContain('phase2');
  });

  it('ground-mode index = the template dispatch (mode + 100 * scale10; outside 1..21 = the ashlar GM_0)', () => {
    expect([0, 1, 4, 20, 21, 22, 25, 99].map(meshFsGroundModeIndex)).toEqual([0, 1, 4, 20, 21, 0, 0, 0]);
    expect([1504, 2021, 1500, 3000, 1519.4, 1520.6].map(meshFsGroundModeIndex)).toEqual([4, 21, 0, 0, 19, 21]);
  });

  it('PLAIN-safe keys (the face-kit multiply axis, the planar dedup): no pattern block, no ground metric', () => {
    expect(meshFsNumPlainSafe(meshFsKeyNum(encodeMaterialFlags(mat({ renderStyle: 'unlit', hasTexture: true, rimEnabled: true })), 0, true))).toBe(true);
    expect(meshFsNumPlainSafe(meshFsKeyNum(encodeMaterialFlags(mat({ patternMode: 'stripes' })), 0, true))).toBe(false);
    expect(meshFsNumPlainSafe(meshFsKeyNum(encodeMaterialFlags(mat({ groundShade: true })), 0, false, 0, 4))).toBe(false);
    expect(meshFsNumPlainSafe(-1)).toBe(false);
  });

  it('the shadow-receiving BASE leaves out the features no measured shadowed scene uses (the 4,000 budget)', () => {
    for (const tex of [false, true]) {
      const b = meshFsBaseKey(tex, true, false, false), b0 = meshFsBaseKey(tex, false, false, false);
      expect(b.feat & MF_BASE_SHADOW_DROP).toBe(0);
      expect(b.styles & 128).toBe(0);
      expect(b.feat | MF_BASE_SHADOW_DROP).toBe(b0.feat | MF_BASE_SHADOW_DROP);
      expect(b0.styles).toBe(0xff);
    }
    // every measured shadowed city key is still covered (shader-split-combos.md §2.1: PBR / Cel / Cel-HD; METAL, GLASS,
    // FOLIAGE, CROWD, RIM, TOON; GARP posters)
    const ub = meshFsBaseKey(false, true, false, false), tb = meshFsBaseKey(true, true, false, false);
    for (const k of [key({ shadow: true, feat: MF.ENV_SPEC | MF.METAL }), key({ shadow: true, feat: MF.ENV_SPEC | MF.GLASS }), key({ shadow: true, feat: MF.ENV_SPEC | MF.FOLIAGE }),
      key({ shadow: true, feat: MF.ENV_SPEC | MF.CROWD }), key({ shadow: true, styles: 2 }), key({ shadow: true, styles: 32, feat: MF.RIM | MF.TOON | MF.METAL })]) expect(meshFsKeyCovers(ub, k), meshFsKeyString(k)).toBe(true);
    expect(meshFsKeyCovers(tb, key({ tex: true, shadow: true, feat: MF.ENV_SPEC | MF.TEXSAMPLE | MF.GARP }))).toBe(true);
  });

  it('key strings parse back (the seen-keys journal); malformed strings are refused', () => {
    for (const k of keyMatrix().slice(0, 400)) expect(meshFsKeyParse(meshFsKeyString(k)), meshFsKeyString(k)).toEqual(k);
    const g = key({ feat: MF.GROUND | MF.ENV_SPEC, gm: (1 << 4) | (1 << 20), pat: 0 });
    expect(meshFsKeyParse(meshFsKeyString(g))).toEqual(g);
    for (const bad of ['', 'U|-|s=01|NOPE|p=|gm=|-', 'X|-|s=01||p=|gm=|-', 'U|-|s=01||p=9|gm=|-', 'U|-|s=1||p=|gm=|-', 'U|-|s=01||p=|gm=|zzz', 'U|-|s=01||p=|gm=']) expect(meshFsKeyParse(bad), bad).toBeNull();
  });

  it('widening (the key cap): ground modes, then styles + the light features together, then BASE; always a superset', () => {
    for (const k of [key({ feat: MF.GROUND | MF.ENV_SPEC, gm: 1 << 4 }), key({ styles: 32, feat: MF.RIM | MF.TOON, pat: 1 << 2 }), key({ tex: true, shadow: true, feat: MF.TEXSAMPLE | MF.ENV_SPEC })]) {
      for (const step of [1, 2, 3] as const) expect(meshFsKeyCovers(meshFsWidenKey(k, step), k)).toBe(true);
    }
    expect(meshFsWidenKey(key({ feat: MF.GROUND, gm: 1 << 4 }), 1).gm).toBe((1 << 22) - 1);
    const w2 = meshFsWidenKey(key({ styles: 32, feat: MF.RIM }), 2);
    expect(w2.styles).toBe(0xff); expect(w2.feat & MF_LIGHT).toBe(MF_LIGHT);
    expect(meshFsKeyCovers(meshFsWidenKey(key({ styles: 2 }), 3), meshFsBaseKey(false, false, false, false))).toBe(true);
  });

  it('superset relation, families and bisect keys', () => {
    const plain = key({ feat: MF.ENV_SPEC });
    const base = meshFsBaseKey(false, false, false, false);
    expect(meshFsKeyCovers(base, plain)).toBe(true);
    expect(meshFsKeyCovers(plain, base)).toBe(false);
    expect(meshFsKeyCovers(meshFsBaseKey(false, true, false, false), plain)).toBe(false);   // layouts must match
    expect(meshFsKeyCovers(meshFsBaseKey(true, false, false, false), plain)).toBe(false);
    expect(meshFsKeyCovers(meshFsBaseKey(false, false, true, false), plain)).toBe(false);   // debug must match
    expect(meshFsKeyCovers(meshFsAllKey(false, false, false, false), base)).toBe(true);
    for (let s = 0; s < 8; s++) expect(meshFsKeyCovers(base, key({ styles: 1 << s, feat: MF.RIM | MF.CROWD | MF.LINING }))).toBe(true);
    const min = meshFsBisectKey(key({ tex: true, debug: true, feat: MF.TEXSAMPLE | MF.ENV_SPEC | MF.RIM }), 'minimal');
    expect(min).toMatchObject({ lean: true, debug: false, feat: MF.TEXSAMPLE });
    expect(meshFsKeyCovers(meshFsBaseKey(true, false, false, false), min)).toBe(true);    // a lean key falls back to BASE
    expect(meshFsKeyCovers(min, key({ tex: true, feat: MF.TEXSAMPLE }))).toBe(false);     // a non-lean key never draws with a lean one
    expect(meshFsBisectKey(key({ tex: true, feat: MF.TEXSAMPLE }), 'noTexSample').feat).toBe(0);
    const lean = generateMeshFs(min);
    expect(lean).not.toMatch(/\b(scene\.fogParams|scene\.pointLights|quantizeColor|fhDitherKeep)\b/);
  });

  it('f16-ready: the prelude is f32 and tree-shaken away in phase 1; an f16 key starts with enable f16 and has its own identity', () => {
    const k = key({ feat: MF.ENV_SPEC });
    expect(meshFsPrelude(k)).toContain('alias hf3 = vec3<f32>;');
    expect(generateMeshFs(k)).not.toMatch(/\balias hf|enable f16/);
    const h = { ...k, f16: true };
    expect(generateMeshFs(h).startsWith('enable f16;')).toBe(true);
    expect(meshFsKeyString(h)).not.toBe(meshFsKeyString(k));
    expect(meshFsKeyCovers(h, k)).toBe(false);
    expect(meshFsKeyCovers(k, h)).toBe(false);
    expect(meshFsKeyOfNum(meshFsKeyNum(0, 0, false), 0).f16).toBe(false);
  });

  it('defines: derived identifiers', () => {
    expect([...meshFsDefines(key({ tex: true, feat: MF.CUTOUT, pat: 1 << 3 }))].sort()).toEqual(['CUTOUT', 'PAT_3', 'PAT_ANY', 'PAT_RELIEF', 'PAT_TILED', 'STYLE_0', 'TEX', 'TEX_DIFFUSE']);
    expect(meshFsDefines(key({ tex: false, feat: MF.TEXSAMPLE })).has('TEX_DIFFUSE')).toBe(false);
    expect(meshFsKeyString(key({ shadow: true, feat: MF.RIM | MF.ENV_SPEC }))).toBe('U|sh|s=01|RIM,ENV_SPEC|p=|gm=|-');
    expect(MF_ALL).toBe((1 << 24) - 1);
  });
});

describe('per-mode ground keys (GM_n directives)', () => {
  it('a one-mode ground key compiles only that mode\'s dispatch arms; the ashlar-less key returns a zero fall-through', () => {
    for (let gm = 0; gm <= 21; gm++) {
      const code = generateMeshFs(key({ feat: MF.GROUND | MF.ENV_SPEC, gm: 1 << gm }));
      const arms = [...code.matchAll(/\bmi == (\d+)\b/g)].map((m) => Number(m[1]));
      expect(new Set(arms), `GM_${gm}`).toEqual(new Set(gm === 0 ? [] : [gm]));
      expect(code.includes('groundAshlar('), `GM_${gm}`).toBe(gm === 0);
    }
    const two = generateMeshFs(key({ feat: MF.GROUND, gm: (1 << 4) | (1 << 21) }));
    expect(new Set([...two.matchAll(/\bmi == (\d+)\b/g)].map((m) => Number(m[1])))).toEqual(new Set([4, 21]));
    expect(two).toContain('var gz: GroundOut;');
  });
});

/** A minimal GPUPipelineCache + handles (no GPU): `ready` per label, `inFrame` settable. */
function fakeRegistry(readyLabels: (label: string) => boolean, inFrame = true) {
  const handles: { label: string; warmed: number[] }[] = [];
  const cache = {
    inFrame,
    render: (_d: unknown, label: string) => {
      const h = { label, warmed: [] as number[], get ready() { return readyLabels(label); }, failed: false, pending: false,
        get: () => (readyLabels(label) ? ({ label } as unknown as GPURenderPipeline) : null), descriptor: () => ({}),
        warm: (p: number) => { h.warmed.push(p); return Promise.resolve(null); } };
      handles.push(h);
      return h;
    },
  } as unknown as GPUPipelineCache;
  const reg = new MeshFsPipelines({} as GPUDevice, cache, () => ({} as GPURenderPipelineDescriptor), (c) => c);
  return { reg, handles };
}

describe('MeshFsPipelines: cap, shadow stand-in, journal', () => {
  const plain = meshFsKeyNum(0, 0, false);                      // U PBR
  const cel = meshFsKeyNum(1 << 2, 0, false);                   // U Cel
  it('past maxKeys a new key is widened to a registered superset (never refused)', () => {
    const prev = MeshFsPipelines.maxKeys;
    MeshFsPipelines.maxKeys = 2;
    try {
      const { reg } = fakeRegistry(() => false, false);
      reg.warm('opaque', meshFsBaseKey(false, false, false, false));
      reg.warmNum('opaque', plain, 0); reg.warmNum('opaque', cel, 0);
      reg.warmNum('opaque', meshFsKeyNum(3 << 2, 0, false), 0);     // Ink: past the cap -> widened (to BASE: step 3)
      reg.warmNum('opaque', meshFsKeyNum((3 << 2) | 128, 0, false), 0);
      const st = reg.stats();
      expect(st.exactKeys).toBe(2);
      expect(st.widened).toBe(2);
      expect(st.list.map((e) => e.key)).toEqual([meshFsKeyString(meshFsBaseKey(false, false, false, false)), meshFsKeyString(meshFsKeyOfNum(plain, 0)), meshFsKeyString(meshFsKeyOfNum(cel, 0))]);
    } finally { MeshFsPipelines.maxKeys = prev; }
  });
  it('a shadow key whose no-shadow pipeline is compiled draws with it (stand-in) instead of holding', () => {
    const noShadow = meshFsKeyString(meshFsKeyOfNum(plain, 0));
    const { reg, handles } = fakeRegistry((l) => l.endsWith(':' + noShadow));
    expect(reg.pick('opaque', plain, 0)).not.toBeNull();             // the no-shadow key is drawn first
    const p = reg.pick('opaque', plain, MESH_FS_G_SHADOW);
    expect((p as unknown as { label: string }).label).toBe(`MeshFS:opaque:${noShadow}`);
    const st = reg.stats();
    expect(st.standIn).toBe(1); expect(st.held).toBe(0);
    expect(handles.find((h) => h.label.includes('|sh|') && h.label.endsWith(meshFsKeyString({ ...meshFsKeyOfNum(plain, MESH_FS_G_SHADOW) })))!.warmed).toEqual([1]);   // DOCUMENT, not NOW
    reg.opts.noStandIn = true;
    expect(reg.pick('opaque', plain, MESH_FS_G_SHADOW)).toBeNull();  // held
    expect(reg.stats().held).toBe(1);
  });
  it('the seen-keys journal keeps the exact keys drawn (not debug / bisect ones) and a new registry reads them back', () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const prevLS = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    try {
      const { reg } = fakeRegistry(() => true);
      reg.pick('opaque', plain, 0); reg.pick('skinned', cel, 0); reg.pick('opaque', cel, 2 /* debug */);
      (reg as unknown as { _journalStore(): void })._journalStore();
      expect(JSON.parse(store.get(SHADER_SPLIT_JOURNAL_KEY)!).keys).toEqual([`opaque:${meshFsKeyString(meshFsKeyOfNum(plain, 0))}`, `skinned:${meshFsKeyString(meshFsKeyOfNum(cel, 0))}`]);
      const { reg: r2, handles } = fakeRegistry(() => false, false);
      expect(r2.journal().map((j) => j.axis)).toEqual(['opaque', 'skinned']);
      expect(r2.warmJournal(2)).toBe(2);
      expect(handles.map((h) => h.warmed[0])).toEqual([2, 2]);
      store.set(SHADER_SPLIT_JOURNAL_KEY, JSON.stringify({ v: 1, keys: ['opaque:U|-|s=01|ENV_SPEC|p=|gm=|-'] }));   // an older version: dropped
      expect(fakeRegistry(() => false).reg.journal()).toEqual([]);
    } finally { g.localStorage = prevLS; }
  });
});

describe('fallback choice', () => {
  const c = (k: MeshFsKey, bytes: number) => ({ key: k, bytes });
  it('the smallest compiled superset, never a non-superset, never itself', () => {
    const want = key({ styles: 2, feat: MF.RIM });
    const exact = c(want, 10);
    const base = c(meshFsBaseKey(false, false, false, false), 300);
    const all = c(meshFsAllKey(false, false, false, false), 900);
    const celRim = c(key({ styles: 2 | 32, feat: MF.RIM | MF.TOON }), 120);
    const pbr = c(key({ styles: 1, feat: MF.RIM | MF.ENV_SPEC }), 50);   // smaller, but not a superset (style)
    expect(smallestCovering(want, [exact, base, all, celRim, pbr], exact)).toBe(celRim);
    expect(smallestCovering(want, [exact, base, all], exact)).toBe(base);
    expect(smallestCovering(want, [exact, pbr], exact)).toBeNull();
    expect(smallestCovering(want, [c(meshFsBaseKey(false, true, false, false), 1)], exact)).toBeNull();   // shadow layout differs
  });
});
