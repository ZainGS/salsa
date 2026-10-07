/**
 * WGSL STATIC CHECKS — catch the shader mistakes that otherwise only show up as a browser "Error while parsing WGSL"
 * (WGSL compiles at runtime; Node can't). Scans every exported shader STRING from the 3D shader modules:
 *
 *  1. No name declared twice in the SAME scope (`let p` twice in one function — the 2026-09-28 Sketch-paper bug:
 *     "redeclaration of 'p'"). Nested-scope shadowing is legal WGSL and allowed.
 *  2. Every `scene.<field>` a shader reads is declared in THAT shader's `struct SceneUniforms` (the same day's second
 *     bug: styleParams added to one struct copy but read from a module whose copy lacked it).
 *
 * Deliberately lightweight (a brace-scope scanner, not a parser). If it ever false-positives on legal WGSL, narrow the
 * rule — don't delete the test.
 */
import { describe, it, expect } from 'vitest';
import * as mesh3d from './shaders/mesh3d-shaders';
import * as skinning from './shaders/skinning-shaders';
import * as style from './shaders/style-shaders';
import * as highlight from './shaders/highlight-shaders';
import * as outline from './shaders/outline-shaders';
import * as shadow from './shaders/shadow-shaders';
import * as silhouette from './shaders/silhouette-outline-shaders';
import * as ssao from './shaders/ssao-shaders';
import * as post from './shaders/post-process-shaders';
import * as particle from './shaders/particle-shaders';
import * as bloom from './shaders/bloom-shaders';
import * as gizmo from './shaders/gizmo-shaders';
import * as cloth from './shaders/cloth-shaders';
import * as gp from './shaders/gp-shaders';
import * as spriteOutline from './shaders/sprite-outline-shaders';
import * as postBgKeep from './post-bg-keep-pass';
import * as fxaa from './fxaa-pass';
import * as iblBake from './shaders/ibl-bake-shaders';
import * as shadowMinMax from './shadow-minmax';
import * as lofi from './lofi-pass';
import * as gpuCull from './shaders/gpu-cull-shaders';
import * as temporalAA from './temporal-aa';
import * as skyDome from './sky-dome-pass';
import { specialiseMeshFragment, VARIANT_FAMILIES } from './shader-variants';
import { generateMeshFs } from './shaders/mesh-fs-generate';
import { MF, MF_NAMES, meshFsAllKey, meshFsBaseKey, meshFsKeyString, type MeshFsKey } from './shaders/mesh-fs-key';

// Step 8 (shader-variants.ts): the specialised mesh fragment variants are checked like every other shader — each of
// the 8 base fragment shaders specialised with one key, plus every listed family (PBR and a Cel-HD + toon modifier) on
// the most common base (untextured, patterned, shadow-receiving).
const variants: Record<string, string> = {};
const MESH_FS = Object.keys(mesh3d).filter((k) => /^MESH3D_FRAGMENT_SHADER/.test(k));
for (const k of MESH_FS) variants[`${k}@ground`] = specialiseMeshFragment((mesh3d as unknown as Record<string, string>)[k], 262144, true);
for (const f of VARIANT_FAMILIES) for (const mod of [0, (5 << 2) | 0x40000000]) {
  variants[`MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN@${f | mod}`] = specialiseMeshFragment(mesh3d.MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN, (f | mod) >>> 0, true);
}

// SHADER SPLIT (shaders/mesh-fs-generate.ts): the generated fragment modules get the same checks - the families
// (BASE / ALL) per layout, every render style alone, every feature alone and every ground mode alone (shader-split.md §6.1.7).
const split: Record<string, string> = {};
for (const tex of [false, true]) for (const shadow of [false, true]) {
  const base: MeshFsKey = { tex, shadow, debug: false, ssrInline: false, lean: false, f16: false, styles: 1, feat: 0, pat: 0, gm: 0 };
  const keys: MeshFsKey[] = [meshFsBaseKey(tex, shadow, false, false), meshFsBaseKey(tex, shadow, true, false), meshFsAllKey(tex, shadow, false, false)];
  for (let st = 0; st < 8; st++) keys.push({ ...base, styles: 1 << st });
  for (const f of MF_NAMES) keys.push({ ...base, feat: MF[f] | MF.ENV_SPEC });
  for (let m = 1; m <= 7; m++) keys.push({ ...base, pat: 1 << m });
  for (let g = 0; g < 22; g++) keys.push({ ...base, feat: MF.GROUND | MF.ENV_SPEC, gm: 1 << g });   // per-mode ground keys (phase 2)
  for (const k of keys) split[meshFsKeyString(k)] = generateMeshFs(k);
}

const MODULES: Record<string, Record<string, unknown>> = { mesh3d, skinning, style, highlight, outline, shadow, silhouette, ssao, post, particle, bloom, gizmo, cloth, gp, spriteOutline, postBgKeep, fxaa, iblBake, shadowMinMax, lofi, gpuCull, temporalAA, skyDome, variants, split };

/** Every exported string that looks like WGSL (has a function or a struct). */
function shaderStrings(): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = [];
  for (const [mod, exports] of Object.entries(MODULES)) {
    for (const [k, v] of Object.entries(exports)) {
      if (typeof v === 'string' && /\bfn\s+\w+\s*\(|\bstruct\s+\w+/.test(v)) out.push({ name: `${mod}.${k}`, src: v });
    }
  }
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Names declared twice in one scope (let / var / const inside function bodies, plus a function's own params). */
function redeclarations(src: string): string[] {
  const code = stripComments(src);
  const bad: string[] = [];
  const re = /\bfn\s+(\w+)\s*\(([^)]*)\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const fnName = m[1];
    // function body = balanced braces from the opening '{'
    let i = re.lastIndex, depth = 1;
    const start = i;
    while (i < code.length && depth > 0) { if (code[i] === '{') depth++; else if (code[i] === '}') depth--; i++; }
    const body = code.slice(start, i - 1);
    const params = m[2].split(',').map((p) => p.trim().match(/^(?:@\w+(?:\([^)]*\))?\s*)*(\w+)\s*:/)?.[1]).filter(Boolean) as string[];
    // walk the body tracking brace scopes
    const scopes: Set<string>[] = [new Set(params)];
    const tok = /\{|\}|\b(?:let|var|const)\s+(\w+)/g;
    let t: RegExpExecArray | null;
    while ((t = tok.exec(body))) {
      if (t[0] === '{') scopes.push(new Set());
      else if (t[0] === '}') scopes.pop();
      else {
        const top = scopes[scopes.length - 1];
        if (top.has(t[1])) bad.push(`${fnName}: '${t[1]}'`);
        top.add(t[1]);
      }
    }
  }
  return bad;
}

/** scene.<field> reads missing from the module's own SceneUniforms struct (if it declares one). */
function missingSceneFields(src: string): string[] {
  const code = stripComments(src);
  const struct = code.match(/struct\s+SceneUniforms\s*\{([^}]*)\}/);
  if (!struct) return [];
  const declared = new Set([...struct[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]));
  const used = new Set([...code.matchAll(/\bscene\.(\w+)/g)].map((x) => x[1]));
  return [...used].filter((f) => !declared.has(f));
}

/** The float offsets packSceneUniforms (scene-uniforms.ts) writes each SceneUniforms field at. */
const SCENE_FLOAT_OFFSETS: Record<string, number> = {
  viewProjection: 0, cameraPosition: 16, ambientColor: 20, lightDirection: 24, lightColor: 28, ps1Config: 32, resolution: 36,
  lightSpaceMatrix: 40, shadowParams: 56, fogColor: 60, fogParams: 64, ps1Config2: 68, lightCounts: 72, pointLights: 76,
  skinRampParams: 204, styleParams: 208, toonParams: 212, rimParams: 216, heightFog: 220, cascadeMatrices: 224,
  cascadeParams: 256, cascadeBias: 260, aerialParams: 264, fogEye: 268,
};
/** Offset drifts in the module's SceneUniforms struct (vec4 / mat4x4 / arrays of them; stops at any other type). */
function sceneStructOffsetErrors(src: string): string[] {
  const code = stripComments(src);
  const struct = code.match(/struct\s+SceneUniforms\s*\{([^}]*)\}/);
  if (!struct) return [];
  const out: string[] = [];
  let off = 0;
  for (const m of struct[1].matchAll(/(\w+)\s*:\s*([^,]+?)\s*,/g)) {
    const [name, type] = [m[1], m[2].replace(/\s+/g, '')];
    const want = SCENE_FLOAT_OFFSETS[name];
    if (want === undefined) break;   // a private layout past here (not the packed scene struct)
    if (want !== off) out.push(`${name} at float ${off}, packed at ${want}`);
    const arr = type.match(/^array<(vec4<f32>|mat4x4<f32>),(\d+)>$/);
    const size = type === 'vec4<f32>' ? 4 : type === 'mat4x4<f32>' ? 16 : arr ? (arr[1] === 'vec4<f32>' ? 4 : 16) * +arr[2] : -1;
    if (size < 0) break;
    off += size;
  }
  return out;
}

describe('WGSL static checks (every exported shader string)', () => {
  const shaders = shaderStrings();

  it('found the shader sources', () => {
    expect(shaders.length).toBeGreaterThan(20);
    expect(shaders.some((s) => s.name === 'mesh3d.MESH3D_FRAGMENT_SHADER_UNTEXTURED')).toBe(true);
    expect(shaders.filter((s) => s.name.startsWith('variants.')).length).toBe(MESH_FS.length + VARIANT_FAMILIES.size * 2);
    expect(shaders.filter((s) => s.name.startsWith('split.')).length).toBeGreaterThan(100);
  });

  it('no name is declared twice in the same scope', () => {
    const bad = shaders.flatMap((s) => redeclarations(s.src).map((b) => `${s.name} → ${b}`));
    expect([...new Set(bad)]).toEqual([]);
  });

  it('every scene.<field> read is declared in that shader\'s SceneUniforms struct', () => {
    const bad = shaders.flatMap((s) => missingSceneFields(s.src).map((f) => `${s.name} reads scene.${f}`));
    expect(bad).toEqual([]);
  });

  it('every SceneUniforms copy puts each field at its packSceneUniforms float offset (no copy drifts)', () => {
    const bad = shaders.flatMap((s) => sceneStructOffsetErrors(s.src).map((e) => `${s.name}: ${e}`));
    expect([...new Set(bad)]).toEqual([]);
    // the checker sees a drift
    expect(sceneStructOffsetErrors('struct SceneUniforms { viewProjection: mat4x4<f32>, ambientColor: vec4<f32>, }')).toEqual(['ambientColor at float 16, packed at 20']);
  });

  it('flags2 lane (normalMatrix column 3): every normal-matrix product uses w = 0, column 3 is read only as flags2', () => {
    // material-3d.ts FLAGS2: the second per-object flags word lives in inst.normalMatrix[3].x. That is safe only while
    // every shader multiplies the normal matrix by vec4(v, 0.0) (column 3 times 0) and reads column 3 nowhere else
    // (.y = the P17 HLOD fade coverage, .z = the face-kit depth pull (flags2 bit 6, written only for face-kit brow
    // overlays, 0 for every other mesh) — the same 0-times lane).
    const bad: string[] = [];
    for (const s of shaders) {
      const code = stripComments(s.src);
      const re = /normalMatrix\s*\*\s*vec4<f32>\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        let j = re.lastIndex, depth = 1;
        const start = j;
        while (j < code.length && depth > 0) { if (code[j] === '(') depth++; else if (code[j] === ')') depth--; j++; }
        const args = code.slice(start, j - 1);
        let d = 0, last = 0;
        for (let k = 0; k < args.length; k++) { const c = args[k]; if (c === '(' || c === '<') d++; else if (c === ')' || c === '>') d--; else if (c === ',' && d === 0) last = k + 1; }
        if (args.slice(last).trim() !== '0.0') bad.push(`${s.name}: normalMatrix * vec4(${args})`);
      }
      for (const u of code.matchAll(/normalMatrix(\s*\[\d\](\.\w+)?|\s*\*|\s*:)?/g)) {
        const t = (u[1] ?? '').replace(/\s/g, '');
        if (!(t === ':' || t === '*' || t.startsWith('[2]') || t === '[3].x' || t === '[3].y' || t === '[3].z')) bad.push(`${s.name}: normalMatrix${u[1] ?? ''}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the checker itself catches both 2026-09-28 bugs', () => {
    expect(redeclarations('fn f(a: f32) -> f32 { let p = 1.0; let q = 2.0; let p = 3.0; return p; }')).toEqual(["f: 'p'"]);
    expect(redeclarations('fn f(a: f32) -> f32 { let p = 1.0; if (a > 0.0) { let p = 2.0; } return p; }')).toEqual([]);   // shadowing is legal
    expect(missingSceneFields('struct SceneUniforms { a: vec4<f32>, }\n fn g() { let x = scene.styleParams.x; }')).toEqual(['styleParams']);
  });
});
