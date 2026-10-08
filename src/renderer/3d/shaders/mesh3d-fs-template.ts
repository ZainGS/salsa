/**
 * THE MERGED MESH FRAGMENT SHADER TEMPLATE (docs/specs/shader-split.md §3.4; phase 1 of the shader split).
 *
 * ONE source for every mesh fragment shader: the textured and untextured fragment templates of the old uber-shader
 * (mesh3d-shaders.ts until shader-split phase 4, 2026-10-08) merged line by line, with `//#if` directives
 * (wgsl-preprocess.ts) around every feature block. The generator
 * (mesh-fs-generate.ts) keeps a key's blocks, removes the rest, and the tree-shaker (wgsl-treeshake.ts) then drops every
 * helper, struct, constant and binding nothing calls any more. So a plain cube's shader contains the plain PBR path,
 * not the ground / window / SSR / CD / toon code the uber-shader carries for every pixel.
 *
 * THE RULE THAT KEEPS PIXELS IDENTICAL: a block is either present WITH ITS ORIGINAL RUNTIME GATE, or absent. A gate is
 * never replaced by `true`. A shader built for feature set S therefore draws any mesh whose features are a subset of S
 * exactly as the uber-shader does (the fallback and the families rely on it). Where a surviving line reads a value
 * whose producer was removed, the `//#else` arm gives the value the removed code produces for every mesh outside the
 * feature (for example `winWL = vec4(0)`, `patBase = diffuse`: the PLAIN defaults of today's PATTERN_BLOCK_PLAIN).
 *
 * Directive identifiers (mesh-fs-key.ts MESH_FS_DEFINES is the complete list; unknown names throw):
 *   TEX                    textured layout (bind group 1 = textures; shadow bindings at group 2, else group 1)
 *   SHADOW                 shadow-receiving layout (PCF + cascades + the receive)
 *   DEBUG                  render-debug hooks (ibl.dbgShade / ibl.dbgFlags, render-debug.ts)
 *   SSR_INLINE             the inline SSR trace in envSpecular (setSSRDeferred3D(false))
 *   LEAN                   bisect-only (never in a normal key): drops the runtime blocks (fog, fog horizon, fade
 *                          bands, point lights, PS1)
 *   STYLE_0 .. STYLE_7     render styles
 *   TEXSAMPLE NORMAL_MAP CUTOUT TRIPLANAR GARP TEX_OVER_BASE HAIR HAIR_BAND TOON RIM ENV_SPEC PLANAR CROWD LINING
 *   BOARD RADIAL LEAF GLASS METAL NEON WATER FOLIAGE GROUND AD_SCREEN
 *                          material features (mesh-fs-key.ts maps them to flag bits)
 *   PAT_1 .. PAT_7         procedural pattern modes; derived: PAT_ANY (1-7), PAT_TILED (1-5), PAT_RELIEF (1-6)
 *   TEX_DIFFUSE            derived: the diffuse texture is sampled (TEX and any of TEXSAMPLE, CUTOUT, TRIPLANAR, GARP)
 *   PLAIN_ROUTE            the pattern block takes its PLAIN defaults (no pattern mask, window / footprint, ground
 *                          metric, ad screen), every later block stays as the key says: exactly the pre-split PLAIN
 *                          uber shader, for the two draw sites that routed a slot to it by another material (the
 *                          face-kit multiply axis; the planar mirror's multi-material entry). MeshFsKey.plain.
 *
 * The two old templates differ in places (§2.6: inputs 5-7, the fog-horizon fast path, PS1 placement, fog of unlit,
 * glass, board, CD label, debug unlit, the *Untex names, the shadow group). Every difference is kept as a
 * `//#if TEX` / `//#else` pair, so the generated shaders reproduce each template exactly.
 *
 * DRIFT GUARD: until phase 4 shader-split.test.ts compared the all-features key with the uber-shaders after
 * normalisation (equal when they were deleted, 2026-10-08); it now checks a frozen sha256 of that normalised text. A
 * deliberate change to this template or the helper library (mesh3d-shaders.ts) updates the hashes there; treat it as a
 * pixel change and verify it like one (shader-split.md §6.4). This file is now the ONLY mesh fragment source.
 *
 * No backticks anywhere in the WGSL below (it is a template string).
 */

import { STYLE_WGSL_FUNCTIONS } from './style-shaders';
import { CROWD_PALETTE_WGSL } from '../crowd-palette';
import { PBR_IBL_WGSL, FOG_FADE_WGSL, LEAF_CARD_WGSL, SHADOW_SAMPLE_WGSL } from './mesh3d-shaders';

/** Insert directive lines into a copy of the shared helper library without touching the original text (the library
 *  strings in mesh3d-shaders.ts are shared with other passes; moving the directives into the library itself is an
 *  optional clean-up). Every anchor must occur exactly once: a drifted anchor throws at module load. */
function injectLibraryDirectives(lib: string): string {
  const edits: [string, string][] = [
    // P4b planar mirror sample (bit 26): its `if` arm and the `else` that chains the SSR arm onto it.
    ['      if (planarOn) {\n', '//#if PLANAR\n      if (planarOn) {\n'],
    ['      } else if (ibl.ssrEnabled > 0.5 && roughness < ibl.ssrMaxRoughness) {',
     '      } else\n//#endif\n      if (ibl.ssrEnabled > 0.5 && roughness < ibl.ssrMaxRoughness) {'],
    // the inline SSR trace (the escape hatch): only reachable while ssrEnabled && !ssrDeferred
    ['          ssr = traceSSR(worldPos, N, R, viewProj);   // origin bias + self-plane rejection live inside traceSSR\n',
     '//#if SSR_INLINE\n          ssr = traceSSR(worldPos, N, R, viewProj);   // origin bias + self-plane rejection live inside traceSSR\n//#endif\n'],
  ];
  let out = lib;
  for (const [anchor, repl] of edits) {
    const n = out.split(anchor).length - 1;
    if (n !== 1) throw new Error(`mesh3d-fs-template: library anchor found ${n} times (drifted?): ${anchor.trim()}`);
    out = out.replace(anchor, repl);
  }
  return injectGroundModeDirectives(out);
}

/** PER-MODE GROUND KEYS (shader-split.md §3.4 / phase 2): wrap every mode arm of groundSurface and groundHeightM in
 *  `//#if GM_<n>`, so a ground key compiles only its own tiler(s). Lines are only wrapped (an `else if` line is split
 *  into `else` + `if`, which the golden normalisation reads as the same text), never changed, so the all-modes key
 *  equals today's dispatch. A key without GM_0 (the ashlar fall-through) returns a zero result there instead: that
 *  path is unreachable for every mesh of the key (meshFsGroundModeIndex maps every mode outside 1..21 to GM_0).
 *  Every expected arm must be found exactly once, so a drifted library throws at module load. */
function injectGroundModeDirectives(lib: string): string {
  const lines = lib.split('\n');
  const find = (from: number, pred: (l: string) => boolean, what: string): number => {
    for (let i = from; i < lines.length; i++) if (pred(lines[i])) return i;
    throw new Error(`mesh3d-fs-template: ground dispatch anchor not found (drifted?): ${what}`);
  };
  const armRe = /^\s*(?:else\s+)?if \(mi == (\d+)\)/;
  /** The arms between lines [a, b): [mode, first line, last line] (braces balanced per arm). */
  const arms = (a: number, b: number): [number, number, number][] => {
    const out: [number, number, number][] = [];
    for (let i = a; i < b; i++) {
      const m = armRe.exec(lines[i]);
      if (!m) { if (lines[i].trim() && !lines[i].trim().startsWith('//')) throw new Error(`mesh3d-fs-template: unexpected ground dispatch line: ${lines[i].trim()}`); continue; }
      let depth = 0, j = i;
      for (; j < b; j++) { const code = lines[j].replace(/\/\/.*$/, ''); for (const ch of code) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0; if (depth === 0) break; }
      if (depth !== 0) throw new Error('mesh3d-fs-template: unbalanced ground dispatch arm');
      out.push([Number(m[1]), i, j]); i = j;
    }
    return out;
  };
  const expect = (got: number[], want: number[], what: string): void => {
    if (got.slice().sort((x, y) => x - y).join() !== want.slice().sort((x, y) => x - y).join()) throw new Error(`mesh3d-fs-template: ground dispatch ${what} arms drifted: ${got.join()}`);
  };
  const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const gm = (ms: number[]): string => ms.map((m) => `GM_${m}`).join(' || ');
  const edits: { at: number; end: number; repl: string[] }[] = [];

  // groundSurface: independent early-return arms 1..21, then the ashlar fall-through (mode 0)
  const s0 = find(find(0, (l) => l.startsWith('fn groundSurface('), 'fn groundSurface'), (l) => l === '  let p = uv * uvM;', 'groundSurface p');
  const sEnd = find(s0, (l) => l === '  return groundAshlar(p, base, seam, groutW, p0, p1, jitter);', 'groundSurface ashlar');
  const sArms = arms(s0 + 1, sEnd);
  expect(sArms.map((a) => a[0]), range(1, 21), 'groundSurface');
  for (const [m, a, b] of sArms) edits.push({ at: a, end: b, repl: [`//#if GM_${m}`, ...lines.slice(a, b + 1), '//#endif'] });
  edits.push({ at: sEnd, end: sEnd, repl: ['//#if GM_0', lines[sEnd], '//#else', '  var gz: GroundOut;', '  return gz;', '//#endif'] });

  // groundHeightM: early-return arms (3, 4, 20, 21, 6), then the cell chain (if / else if ... / else = mode 0)
  const h0 = find(find(0, (l) => l.startsWith('fn groundHeightM('), 'fn groundHeightM'), (l) => l === '  let mi = i32(mode + 0.5);', 'groundHeightM mi');
  const hVar = find(h0, (l) => l === '  var c: vec3<f32>;', 'groundHeightM var c');
  const hElse = find(hVar, (l) => l === '  else { c = groundCell(p, p0, p1); }', 'groundHeightM else');
  const hRet = find(hElse, (l) => l === '  return gr_cellHeight(vec2<f32>(c.x, c.y), c.z, groutW);', 'groundHeightM return');
  if (hRet !== hElse + 1) throw new Error('mesh3d-fs-template: groundHeightM tail drifted');
  const hEarly = arms(h0 + 1, hVar);
  expect(hEarly.map((a) => a[0]), [3, 4, 20, 21, 6], 'groundHeightM early');
  for (const [m, a, b] of hEarly) edits.push({ at: a, end: b, repl: [`//#if GM_${m}`, ...lines.slice(a, b + 1), '//#endif'] });
  const chain = arms(hVar + 1, hElse);
  const chainModes = chain.map((a) => a[0]);
  expect(chainModes, [1, 2, 5, 7, 8, ...range(9, 19)], 'groundHeightM chain');
  const tailModes = [0, ...chainModes];
  const repl: string[] = [`//#if ${gm(tailModes)}`, lines[hVar]];
  chain.forEach(([m, a, b], j) => {
    const body = lines.slice(a, b + 1);
    body[0] = body[0].replace(/^(\s*)else\s+if /, '$1if ');
    repl.push(`//#if GM_${m}`);
    if (j > 0) repl.push(`//#if ${gm(chainModes.slice(0, j))}`, '  else', '//#endif');
    repl.push(...body, '//#endif');
  });
  repl.push('//#if GM_0', `//#if ${gm(chainModes)}`, '  else', '//#endif', '  { c = groundCell(p, p0, p1); }', '//#endif', lines[hRet], '//#else', '  return 0.0;', '//#endif');
  edits.push({ at: hVar, end: hRet, repl });

  for (const e of edits.sort((x, y) => y.at - x.at)) lines.splice(e.at, e.end - e.at + 1, ...e.repl);
  return lines.join('\n');
}

/** The pattern footprint the tiled pattern modes (1-5) read as winWL.w: EXACTLY the w windowsPattern computes
 *  (mesh3d-shaders.ts windowsPattern: freq, p, dp = fwidth(p), w), so a roof / paving key need not carry the whole
 *  facade helper for one number. Derivative: called at the top level of fs_main only. */
const PAT_FOOTPRINT_WGSL = /* wgsl */ `
fn patFootprint(uv: vec2<f32>, params: vec4<f32>) -> f32 {
  let freq = max(params.x, 0.001);
  let p = uv * freq;
  let dp = fwidth(p);
  return max(dp.x, dp.y) + 1e-4;
}
`;

/** The merged template (directives included). Generate a key's module with mesh-fs-generate.ts generateMeshFs. */
export const MESH3D_FS_TEMPLATE = /* wgsl */ `

${STYLE_WGSL_FUNCTIONS}
${injectLibraryDirectives(PBR_IBL_WGSL)}

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissive:       vec3<f32>,   // emissive rgb (floats 40-42)
  flags:          u32,         // material flags (float 43, setUint32): DECLARED u32, never f32 + bitcast (subnormal flush on mobile, CLOTH-3)
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
  uvTransform:    vec4<f32>,
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

struct SceneUniforms {
  viewProjection: mat4x4<f32>,
  cameraPosition: vec4<f32>,
  ambientColor:   vec4<f32>,
  lightDirection: vec4<f32>,
  lightColor:     vec4<f32>,
  ps1Config:        vec4<f32>,
  resolution:       vec4<f32>,
  lightSpaceMatrix: mat4x4<f32>,
  shadowParams:     vec4<f32>,
  fogColor:         vec4<f32>,
  fogParams:        vec4<f32>,
  ps1Config2:       vec4<f32>,  // .x=ditherStrength .y=uvQuantizeSteps
  lightCounts:      vec4<f32>,  // .x = point-light count
  pointLights:      array<vec4<f32>, 32>,
  skinRampParams:   vec4<f32>,  // (declared so styleParams lands at its buffer offset, floats 208-211)
  styleParams:      vec4<f32>,  // .x = Sketch paper amount, .y = toon shadow tint (rgb8), .z = toon saturation
  toonParams:       vec4<f32>,  // toon shadows: .x bands .y softness .z shadow value
  rimParams:        vec4<f32>,  // rim light: .x strength (0 = original rim) .y width .z hardness .w colour (rgb8)
  heightFog:        vec4<f32>,  // height fog (city-quality P9): .x density (0 = off) .y base height .z falloff per unit .w distance reach
  cascadeMatrices:  array<mat4x4<f32>, 2>,  // persona-polish A2: the near shadow cascades (nearest first)
  cascadeParams:    vec4<f32>,  // .x cascade count (0 = off) .y cascade map size .z blend band (fraction of the box)
  cascadeBias:      vec4<f32>,  // .x / .y depth bias of cascade 0 / 1
  aerialParams:     vec4<f32>,  // persona-polish A5 aerial haze: .x strength (0 = off) .y 1/reach .z contrast share .w tint share
  fogEye:           vec4<f32>,  // fog-horizon: .xyz the point fog is measured from (perspective = cameraPosition) .w fade band width
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

// SSAO ambient-occlusion buffer (docs/specs/ssao.md), multiplied into the AMBIENT term only. 1x1 white when off.
@group(0) @binding(3) var ssaoTexture: texture_2d<f32>;
@group(0) @binding(4) var ssaoSampler: sampler;

// (bindings 5/6 sceneColorTexture/sceneColorSampler - for GLASS REFRACTION + SSR - are declared in PBR_IBL_WGSL above)

//#if TEX
@group(1) @binding(0) var diffuseTexture:   texture_2d_array<f32>;
@group(1) @binding(1) var diffuseSampler:   sampler;
@group(1) @binding(2) var normalMapTexture: texture_2d_array<f32>;
@group(1) @binding(3) var normalMapSampler: sampler;
// GARP dedicated pool atlas (docs/specs/city-props-garp.md), sampled at the same textureIndex as the diffuse.
@group(1) @binding(4) var garpTexture: texture_2d_array<f32>;
//#endif

//#if SHADOW
//#if TEX
${SHADOW_SAMPLE_WGSL(2)}
//#else
${SHADOW_SAMPLE_WGSL(1)}
//#endif
//#endif
${FOG_FADE_WGSL}
${CROWD_PALETTE_WGSL}

//#if TEX
const bayer4 = array<f32, 16>(
   0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
  12.0/16.0,  4.0/16.0, 14.0/16.0,  6.0/16.0,
   3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
  15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0,
);

fn quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

fn quantizeColorDithered(c: vec3<f32>, depth: f32, fragPos: vec4<f32>) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  let px = vec2<u32>(fragPos.xy) % 4u;
  let threshold = bayer4[px.y * 4u + px.x] * scene.ps1Config2.x;
  return floor(c * depth + threshold) / depth;
}
//#else
const bayer4Untex = array<f32, 16>(
   0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
  12.0/16.0,  4.0/16.0, 14.0/16.0,  6.0/16.0,
   3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
  15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0,
);

fn quantizeColorUntex(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

fn quantizeColorUntexDithered(c: vec3<f32>, depth: f32, fragPos: vec4<f32>) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  let px = vec2<u32>(fragPos.xy) % 4u;
  let threshold = bayer4Untex[px.y * 4u + px.x] * scene.ps1Config2.x;
  return floor(c * depth + threshold) / depth;
}
//#endif

${LEAF_CARD_WGSL}
${PAT_FOOTPRINT_WGSL}

@fragment
fn fs_main(
  @builtin(position)              fragPos:      vec4<f32>,
//#if STYLE_7 || LINING
  @builtin(front_facing)          frontFacing:  bool,
//#endif
//#if STYLE_4 || DEBUG
  @location(0)                    gouraudColor: vec4<f32>,
//#endif
  @location(1)                    uv:           vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx:  u32,
  @location(3)                    worldPos:     vec3<f32>,
  @location(4)                    worldNormal:  vec3<f32>,
//#if TEX && (NORMAL_MAP || HAIR)
  @location(5)                    worldTangent: vec3<f32>,
//#endif
//#if TEX && NORMAL_MAP
  @location(6)                    worldBitangent: vec3<f32>,
//#endif
//#if TEX && !LEAN
  @location(7) @interpolate(linear) uvAffine:   vec2<f32>,
//#endif
//#if FOLIAGE
  @location(8)                    foliageY:     f32,
//#endif
) -> @location(0) vec4<f32> {
  let inst        = u_instances[instanceIdx];
  let flags       = inst.flags;
//#if TEX
  let hasTexture   = (flags & 1u) != 0u;
  let hasNormalMap = (flags & 2u) != 0u;
  let renderStyle  = (flags >> 2u) & 7u;
  let alphaCutout  = (flags & 32u) != 0u;
  let hairSheen    = (flags & 64u) != 0u;
  let rimEnabled   = (flags & 128u) != 0u;
  let toonOn       = (flags & 1073741824u) != 0u;   // bit 30 - toon shadows (Cel styles)
  let skinToonOn   = (flags & 536870912u) != 0u;    // bit 29 - skin ramp, per-pixel in Cel styles
  let patMode      = (flags >> 9u) & 7u;
  let texOverBase  = (flags & 32768u) != 0u;
  let garpTex      = (flags & 16777216u) != 0u;   // bit 24: sample the dedicated GARP pool atlas, not diffuse
//#else
  let renderStyle = (flags >> 2u) & 7u;
  let rimEnabled  = (flags & 128u) != 0u;
  let toonOn      = (flags & 1073741824u) != 0u;   // bit 30 - toon shadows (Cel styles)
  let skinToonOn  = (flags & 536870912u) != 0u;    // bit 29 - skin ramp, per-pixel in Cel styles
  let leafCard    = (flags & 8192u) != 0u;
  let glassEnhance = (flags & 16384u) != 0u;
  let patMode     = (flags >> 9u) & 7u;
  let boardShade  = (flags & 65536u) != 0u;
  let radialFade  = (flags & 131072u) != 0u;
//#endif
  // FOG HORIZON fast path (fog-horizon.ts; scene.toonParams.w bit 0, set only with Hard edge on and a linear fog, so
  // aerial haze and height fog are off): a pixel at or past the fog edge ends exactly as the fog colour. The textured
  // template excludes unlit UI cards (style 6, no fog); the untextured one fogs every style.
//#if LEAN
  let fhSkip = false;
//#else
  let fhFlags = u32(scene.toonParams.w);
  let fhNoFogM = fhNoFog(u32(inst.normalMatrix[3].x), fhFlags);   // Material3D.noFog (flags2 bits 2 / 3)
//#if TEX
  let fhSkip = (fhFlags & 1u) != 0u && u32(scene.fogParams.w) == 1u && renderStyle != 6u && !fhNoFogM
//#else
  let fhSkip = (fhFlags & 1u) != 0u && u32(scene.fogParams.w) == 1u && !fhNoFogM
//#endif
    && length(scene.fogEye.xyz - worldPos) >= scene.fogParams.x + max(scene.fogParams.y - scene.fogParams.x, 0.001);
//#endif

//#if DEBUG
  // RENDER DEBUG (render-debug.ts; ibl.dbgShade, 0 = off: the normal path below runs unchanged). A uniform value, so
  // these early returns keep the control flow uniform for the samples and derivatives below.
  // RENDER DEBUG safeLightingMath (ibl.dbgFlags value 4; rdSafeMath is declared with rdPow / rdNormalize in
  // STYLE_WGSL_FUNCTIONS). Read only through select(), so off keeps every result exactly as before.
  rdSafeMath = (u32(ibl.dbgFlags) & 4u) != 0u;
  if (ibl.dbgShade > 1.5) {
    let dbgM = u32(ibl.dbgShade + 0.5);
    if (dbgM == 3u) { return vec4<f32>(1.0, 0.0, 1.0, 1.0); }
    if (dbgM == 4u) {
      // Branch-free on the (varying) index so the samples / derivatives below stay in uniform control flow.
      let dbgH = (instanceIdx + 1u) * 2654435761u;
      let dbgC = vec3<f32>(f32((dbgH >> 8u) & 255u), f32((dbgH >> 16u) & 255u), f32((dbgH >> 24u) & 255u)) / 255.0;
      return vec4<f32>(select(dbgC, vec3<f32>(1.0, 0.0, 0.0), instanceIdx >= arrayLength(&u_instances)), 1.0);
    }
    if (dbgM == 5u) { return vec4<f32>(u_instances[0].diffuseColor.rgb, 1.0); }
    if (dbgM == 6u) { return vec4<f32>(gouraudColor.rgb, 1.0); }
    // 10 = the instance's material flag bits as a colour: GREEN = rim (bit 7) on a dark-blue base.
    if (dbgM == 10u) {
      return vec4<f32>(0.0, select(0.0, 1.0, (inst.flags & 128u) != 0u), 0.3, 1.0);
    }
    // 7 / 8 = solid grey / white; 9 = the raw interpolated world normal.
    if (dbgM == 7u) { return vec4<f32>(0.5, 0.5, 0.5, 1.0); }
    if (dbgM == 8u) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
    if (dbgM == 9u) { return dbgFinal(vec4<f32>(worldNormal * 0.5 + 0.5, 1.0), 0u); }
    return vec4<f32>(inst.diffuseColor.rgb, 1.0);
  }
//#endif

  // ── PATTERN BLOCK: procedural pattern -> the base albedo (primary = diffuse, secondary = patternColor). Every
  // fwidth-using helper (patternMask x3, windowsPattern / the footprint, the ground metric) runs at the TOP LEVEL so
  // fwidth stays in uniform control flow; results are gated afterwards. A key without the feature gets the PLAIN
  // default instead (today's PATTERN_BLOCK_PLAIN values: identical for every mesh outside the feature).
//#if PAT_ANY && !PLAIN_ROUTE
  let patMask = patternMask(uv, patMode, inst.patternParams, scene.ps1Config2.z);
  // Relief step in pattern CELLS. DOTS (mode 2) use a fine step: at 0.35 cell the shifted mask of a small stud
  // never overlaps the stud itself, so every dot grew an offset ghost twin (tactile paving, city-quality S3).
  let pEpsK = select(f32(0.35), f32(0.06), patMode == 2u);
  let pEps = pEpsK / max(inst.patternParams.x, 0.001);
  let patMaskR = patternMask(uv + vec2<f32>(pEps, 0.0), patMode, inst.patternParams, scene.ps1Config2.z);
  let patMaskU = patternMask(uv + vec2<f32>(0.0, pEps), patMode, inst.patternParams, scene.ps1Config2.z);
//#else
  let patMask = 0.0;
  let patMaskR = 0.0;
  let patMaskU = 0.0;
//#endif
  // P8 shader fast paths (Renderer3D.shaderFastPaths -> scene.cascadeBias.z): bit-identical shortcuts in the facade
  // pattern (windowsPattern / windowShade) and the procedural ground; 0 = the original code paths (A/B).
  let p8Fast = scene.cascadeBias.z > 0.5;
//#if (GROUND || AD_SCREEN) && !PLAIN_ROUTE
  let gUvFw = fwidth(uv);                                        // P8 ground relief LOD footprint (uniform flow)
//#else
  let gUvFw = vec2<f32>(0.0, 0.0);
//#endif
//#if PAT_6 && !PLAIN_ROUTE
  let winWL = windowsPattern(uv, inst.patternParams, scene.ps1Config2.z, patMode == 6u, p8Fast);
//#elif PAT_TILED && !PLAIN_ROUTE
  let winWL = vec4<f32>(0.0, 0.0, 0.0, patFootprint(uv, inst.patternParams));   // modes 1-5 read only the footprint .w
//#else
  let winWL = vec4<f32>(0.0, 0.0, 0.0, 0.0);
//#endif
//#if GROUND && !PLAIN_ROUTE
  let gUvM = gr_uvMetres(uv, worldPos);
//#else
  let gUvM = vec2<f32>(0.0, 0.0);
//#endif
//#if (PAT_6 || AD_SCREEN) && !PLAIN_ROUTE
  let winAx = uvWorldAxes(uv, worldPos);                         // interior-mapping cell frame (uniform flow)
//#endif
//#if PAT_ANY && !PLAIN_ROUTE
  var patBase = mix(inst.diffuseColor.rgb, inst.patternColor.rgb, patMask);
//#else
  var patBase = inst.diffuseColor.rgb;
//#endif
  var emissiveRGB = inst.emissive;
//#if CROWD
  // CROWD PALETTE (flags2 bit 4, performance-plan P12): the per-vertex palette code tints the base + emissive.
  let crowdK = crowdTint(u32(inst.normalMatrix[3].x), uv, inst.patternColor.xyz);
  patBase = patBase * crowdK;
  emissiveRGB = emissiveRGB * crowdK;
//#endif
  var roughOverride = inst.roughness;
//#if PAT_6 && !PLAIN_ROUTE
  if (patMode == 6u && !fhSkip) {   // fog horizon: a fogged pixel needs no window interior
    let ws = windowShade(uv, inst.patternParams, winWL, worldPos, worldNormal, winAx, scene.cameraPosition.xyz,
                         inst.diffuseColor.rgb, inst.patternColor.rgb, inst.emissive, scene.ps1Config2.z, p8Fast, inst.patternColor.a);
    patBase = ws.base;
    emissiveRGB = ws.emk;
  }
//#if PAT_7
  else
//#endif
//#endif
//#if PAT_7 && !PLAIN_ROUTE
  if (patMode == 7u) {
//#if AD_SCREEN
    if (inst.patternParams.z > 1.5) {
      // visual-polish #6: an AD SCREEN (designed loop, see adScreen) - the colour IS the light; the layer's glow factor
      // (emissive / diffuse, set by the day-night glow walk) scales it.
      let adAsp = select(1.6, clamp(length(winAx.u) / max(length(winAx.v), 1e-12), 0.3, 6.0), dot(winAx.v, winAx.v) > 1e-24);
      let adC = adScreen(uv, gUvFw, adAsp, scene.ps1Config2.z);
      patBase = adC;
      let adE = inst.emissive / max(inst.diffuseColor.rgb, vec3<f32>(0.05));
      emissiveRGB = adC * max(adE.x, max(adE.y, adE.z)) * 0.9;
    } else {
      emissiveRGB = emissiveRGB * (0.3 + 1.5 * patMask);
    }
//#else
    emissiveRGB = emissiveRGB * (0.3 + 1.5 * patMask);
//#endif
  }
//#endif

//#if TEX
  let L = normalize(-scene.lightDirection.xyz);
  // Orthographic view = PARALLEL rays: constant camera forward instead of a finite eye (see the worldPos4 site).
  let V = select(rdNormalize(scene.cameraPosition.xyz - worldPos), -normalize(vec3<f32>(scene.viewProjection[0].z, scene.viewProjection[1].z, scene.viewProjection[2].z)), scene.cameraPosition.w > 0.5);

  // PS1 affine texture mapping (blend the perspective-correct uv toward the linear uvAffine), texture tiling + offset
  // (uvTransform, default no-op) and PS1 UV quantisation. Applies to the diffuse / normal / GARP samples only.
//#if LEAN
  var sampUv = uv;
//#else
  var sampUv = mix(uv, uvAffine, clamp(scene.ps1Config.z, 0.0, 1.0));
//#endif
  sampUv = sampUv * inst.uvTransform.xy + inst.uvTransform.zw;
//#if !LEAN
  let uvQSteps = scene.ps1Config2.y;
  if (uvQSteps > 0.5) {
    sampUv = floor(sampUv * uvQSteps) / uvQSteps;
  }
//#endif

  // Sample textures unconditionally - textureSample requires uniform control flow. GARP and world TRIPLANAR (bit 27)
  // sample too and are select()ed by their flags (no branch around a sample).
//#if TRIPLANAR
  let triplanar = (flags & 134217728u) != 0u;
  let tpFreq    = inst.uvTransform.x;
  let tpOff     = inst.uvTransform.zw;
//#endif
//#if DEBUG
  // RENDER DEBUG clampTexLayers (ibl.dbgFlags bit 0): clamp the layer indices to the bound arrays. Off, select() keeps
  // the instance values unchanged.
  let dbgClampL = (u32(ibl.dbgFlags) & 1u) != 0u;
//#if TEX_DIFFUSE
  let texLayer  = select(i32(inst.textureIndex), min(i32(inst.textureIndex), i32(textureNumLayers(diffuseTexture)) - 1), dbgClampL);
//#endif
//#if GARP
  let garpLayer = select(i32(inst.textureIndex), min(i32(inst.textureIndex), i32(textureNumLayers(garpTexture)) - 1), dbgClampL);
//#endif
//#if NORMAL_MAP
  let nrmLayer  = select(i32(inst.normalMapIndex), min(i32(inst.normalMapIndex), i32(textureNumLayers(normalMapTexture)) - 1), dbgClampL);
//#endif
//#else
//#if TEX_DIFFUSE
  let texLayer  = i32(inst.textureIndex);
//#endif
//#if GARP
  let garpLayer = i32(inst.textureIndex);
//#endif
//#if NORMAL_MAP
  let nrmLayer  = i32(inst.normalMapIndex);
//#endif
//#endif
//#if TRIPLANAR
  let tpDx = textureSample(diffuseTexture, diffuseSampler, worldPos.zy * tpFreq + tpOff, texLayer);
  let tpDy = textureSample(diffuseTexture, diffuseSampler, worldPos.xz * tpFreq + tpOff, texLayer);
  let tpDz = textureSample(diffuseTexture, diffuseSampler, worldPos.xy * tpFreq + tpOff, texLayer);
  var tpB  = abs(normalize(worldNormal));
  tpB = tpB / (tpB.x + tpB.y + tpB.z + 1e-5);
  let triDiff      = tpDx * tpB.x + tpDy * tpB.y + tpDz * tpB.z;
//#endif
//#if TEX_DIFFUSE
  let uvDiff       = textureSample(diffuseTexture,   diffuseSampler,   sampUv, texLayer);
//#if TRIPLANAR
  let diffSample   = select(uvDiff, triDiff, triplanar);
//#else
  let diffSample   = uvDiff;
//#endif
//#if GARP
  let garpSample   = textureSample(garpTexture,      diffuseSampler,   sampUv, garpLayer);
  let texSample    = select(diffSample, garpSample, garpTex);
//#else
  let texSample    = diffSample;
//#endif
//#endif
//#if NORMAL_MAP
  let normalSample = textureSample(normalMapTexture, normalMapSampler, sampUv, nrmLayer);
//#endif

//#if CUTOUT
  // Alpha-test cutout (alpha-card hair): drop transparent strand texels. Samples above are unconditional; the
  // discard after them is fine.
  if (alphaCutout && texSample.a < 0.5) { discard; }
//#endif
//#else
//#if BOARD
  // BOARD SHADING (bit 16, packaging paperboard - untextured panels): paper-fiber grain + panel-border rim darkening.
  // patternColor = (rimU, rimV, rimStrength, grainAmp), patternParams = the panel's dieline-UV rect.
  if (boardShade) {
    patBase = patBase * paperGrain(uv, inst.patternColor.a);
    let rect = inst.patternParams;
    let dEdge = vec2<f32>(min(uv.x - rect.x, rect.z - uv.x), min(uv.y - rect.y, rect.w - uv.y));
    let eN = min(dEdge.x / max(inst.patternColor.r, 1e-5), dEdge.y / max(inst.patternColor.g, 1e-5));
    patBase = patBase * (1.0 - inst.patternColor.b * (1.0 - smoothstep(0.0, 1.0, clamp(eN, 0.0, 1.0))));
  }
//#endif

//#if LEAF
  // LEAF CARD: cut the quad to a leaf silhouette (alpha-test) + a midrib/edge shade. AFTER the fwidth pattern helpers
  // above (they ran uniformly) so the discard doesn't make a later derivative non-uniform.
  if (leafCard) {
    let leaf = leafCardCoverage(uv);
    if (leaf < 0.5) { discard; }
    if (uv.x > 1.5) {
      // CLUMP card: the spherised normals carry the light/dark, so the per-card shade stays QUIET.
      patBase = patBase * (0.93 + 0.07 * smoothstep(0.5, 0.95, leaf));
    } else {
      // SPRIG card: darker toward the base (uv.y low) + a touch darker at leaf edges.
      patBase = patBase * (0.72 + 0.4 * uv.y) * (0.86 + 0.14 * smoothstep(0.5, 0.95, leaf));
    }
  }
//#endif
//#if RADIAL
  // RADIAL FADE early out (visual-polish #5 perf): past the unit circle the fade below is exactly 0 and the tail
  // discards the fragment anyway, so skip the lighting for the corners of the spill / pool / blob quads.
  if (radialFade && length(uv - vec2<f32>(0.5, 0.5)) >= 0.5) { discard; }
//#endif
//#endif

//#if !LEAN
  // FOG HORIZON FADE BAND (P2; scene flag bit 1, flags2 in normalMatrix column 3 .x): a fading family dissolves over
  // the band before the fog edge with a screen-door dither (after the samples, like every discard in this FS).
  if ((fhFlags & 2u) != 0u && fhFades(u32(inst.normalMatrix[3].x), fhFlags)) {
    let fhEdge = scene.fogParams.x + max(scene.fogParams.y - scene.fogParams.x, 0.001);
    if (!fhDitherKeep(fhCoverage(length(scene.fogEye.xyz - worldPos), fhEdge, scene.fogEye.w), fragPos.xy + fhTaaShift(scene.cascadeParams.w, (fhFlags & 4u) != 0u), (fhFlags & 4u) != 0u)) { discard; }
  }
  // HLOD CROSS-FADE (performance-plan P17; flags2 bit 5): a streamed HLOD tile dissolving in / out over its tier
  // swap; the coverage rides in normalMatrix column 3 .y (multiplied by 0 in every normal transform).
  if ((u32(inst.normalMatrix[3].x) & 32u) != 0u && !fhDitherKeep(inst.normalMatrix[3].y, fragPos.xy + fhTaaShift(scene.cascadeParams.w, false), false)) { discard; }

  // FOG HORIZON fast path (see fhSkip): after every implicit-derivative sample and the cut-outs, so nothing below runs
  // in non-uniform control flow that needs derivatives. Same alpha, the same alpha discard (and, textured, the same
  // PS1 quantisation) as the slow path's tail; the colour is the fog colour the tail's mix(colour, fog, 1.0) ends at.
  if (fhSkip) {
    var fhA = inst.diffuseColor.a;
//#if TEX
//#if TEXSAMPLE
    if (hasTexture && !texOverBase && renderStyle != 7u) { fhA = fhA * texSample.a; }
//#endif
//#else
//#if RADIAL
    if (radialFade) {
      let fhRd = length(uv - vec2<f32>(0.5, 0.5)) * 2.0;
      let fhFade = 1.0 - smoothstep(0.2, 1.0, fhRd);
      fhA = fhA * fhFade * fhFade;
    }
//#endif
//#endif
    if (fhA < 0.01) { discard; }
//#if TEX
    var fhC = scene.fogColor.rgb;
    let fhCd = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (flags & 2147483648u) != 0u);
    if (fhCd > 0.0) {
      if (scene.ps1Config2.x > 0.0) { fhC = quantizeColorDithered(fhC, fhCd, fragPos); } else { fhC = quantizeColor(fhC, fhCd); }
    }
    return vec4<f32>(fhC, fhA);
//#else
    return vec4<f32>(scene.fogColor.rgb, fhA);
//#endif
  }
//#endif

//#if DEBUG
  // RENDER DEBUG unlit (ibl.dbgShade 1): the base colour (x texture), no lighting / shadows / IBL / fog.
  if (ibl.dbgShade > 0.5) {
//#if TEX
    var dbgC = vec4<f32>(patBase, inst.diffuseColor.a);
//#if TEXSAMPLE
    if (hasTexture) { dbgC = dbgC * texSample; }
//#endif
    if (dbgC.a < 0.01) { discard; }
    return dbgC;
//#else
    if (inst.diffuseColor.a < 0.01) { discard; }
    return vec4<f32>(patBase, inst.diffuseColor.a);
//#endif
  }
//#endif

//#if !TEX
  let L = normalize(-scene.lightDirection.xyz);
  // Orthographic view = PARALLEL rays: constant camera forward instead of a finite eye (see the worldPos4 site).
  let V = select(rdNormalize(scene.cameraPosition.xyz - worldPos), -normalize(vec3<f32>(scene.viewProjection[0].z, scene.viewProjection[1].z, scene.viewProjection[2].z)), scene.cameraPosition.w > 0.5);
//#endif
  // Resolve surface normal
  var N = rdNormalize(worldNormal);
//#if TEX && NORMAL_MAP
  if (hasNormalMap) {
    let mapN = normalSample.xyz * 2.0 - 1.0;
    N = rdNormalize(worldTangent * mapN.x + worldBitangent * mapN.y + worldNormal * mapN.z);
  }
//#endif

//#if PAT_RELIEF
  // PATTERN RELIEF + GRAIN (modes 1-6): a micro normal perturbation from the procedural mask gradient so seams
  // groove, tiles step, and WINDOW REVEALS catch raking light, plus a subtle world-stable value grain on the tiled
  // modes. Reuses the 3x patternMask samples.
  if (patMode >= 1u && patMode <= 6u) {
    var Tb = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let tbl = length(Tb);
    let flat_ = tbl <= 1e-3;
    Tb = select(Tb / max(tbl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), flat_);
    let Bb = select(cross(N, Tb), vec3<f32>(0.0, 0.0, 1.0), flat_);
    // windows (mode 6): a SOFTER groove - interior mapping already conveys the depth; this just bevels the reveal.
    let reliefK = select(1.3, 0.85, patMode == 6u);
    N = normalize(N + (Tb * (patMask - patMaskR) + Bb * (patMask - patMaskU)) * reliefK);
//#if PAT_TILED
    if (patMode <= 5u) {
      // (B4: the 260-per-uv grain cells go sub-pixel fast - winWL.w is the pixel footprint in THIS pattern's cells, so
      // w * 260 / freq = grain cells per pixel; fade it out past ~1 so roofs / trim stop shimmering at mid distance.)
      let grainK = 1.0 - smoothstep(0.6, 2.0, winWL.w * 260.0 / max(inst.patternParams.x, 0.001));
      patBase = patBase * (1.0 + grainK * 0.10 * (fract(sin(dot(floor(uv * 260.0), vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5));
    }
//#endif
  }
//#endif
//#if PAT_6
  if (patMode == 6u) {
    // FACADE ROUGHNESS: a gentle stucco-facet normal dither on the masonry between the windows (not the glass).
    var Tw2 = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let twl = length(Tw2);
    if (twl > 1e-3) {
      Tw2 = Tw2 / twl;
      let Bw2 = cross(N, Tw2);
      let gc = floor(uv * 140.0);
      let g1 = fract(sin(dot(gc, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
      let g2 = fract(sin(dot(gc, vec2<f32>(39.3468, 11.135))) * 24634.6345) - 0.5;
      // (B4: the 7 mm facets are sub-pixel past a few metres, where they only sparkle - faded by the cell footprint.)
      N = normalize(N + (Tw2 * g1 + Bw2 * g2) * 0.16 * (1.0 - winWL.x) * (1.0 - smoothstep(0.0015, 0.005, winWL.w)));
      // STRUCTURED MASONRY RELIEF: brick courses / concrete panel seams GROOVE (fixed brick-scale eps, no fwidth, so
      // uniform-safe); CENTERED differences so the relief lands ON the courses. On the masonry only (1 - winWL.x).
      let mEps = 0.014 / max(inst.patternParams.x, 0.001);
      let mhL = wallMasonryH(uv - vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhR = wallMasonryH(uv + vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhD = wallMasonryH(uv - vec2<f32>(0.0, mEps), inst.patternParams);
      let mhU = wallMasonryH(uv + vec2<f32>(0.0, mEps), inst.patternParams);
      // (B4: joint relief fades once a joint is sub-pixel - past that it only aliases into a moire grid.)
      N = normalize(N + (Tw2 * (mhL - mhR) + Bw2 * (mhD - mhU)) * (0.42 * (1.0 - winWL.x) * (1.0 - smoothstep(0.01, 0.04, winWL.w))));
    }
  }
//#endif

//#if TEX
  // BOARD GRAIN (boardShade, bit 16 - packaging paperboard): a faint two-scale paper-fiber value grain on the BASE
  // colour, BEFORE the texOverBase artwork composite so painted strokes stay clean on top. Instance slots repurposed:
  // patternColor = (rimU, rimV, rimStrength, grainAmp), patternParams = this panel's UV rect in the dieline texture.
  let boardShade = (flags & 65536u) != 0u;
//#if BOARD
  if (boardShade) {
    patBase = patBase * paperGrain(uv, inst.patternColor.a);
  }
//#endif
//#if TEXSAMPLE && TEX_OVER_BASE
  // DECAL-OVER-BASE (texOverBase, bit 15): composite the diffuse texture OVER the base albedo by its alpha BEFORE
  // lighting, so painted strokes are lit like paint ON the surface. The post-lighting multiply below skips this mode.
  if (hasTexture && texOverBase) {
    patBase = mix(patBase, texSample.rgb, texSample.a);
  }
//#endif
//#if BOARD
  // BOARD EDGE RIM (same bit 16): darken toward the panel's UV-rect borders so panels read as THICK board. AFTER the
  // artwork composite (a real board edge shades the ink too).
  if (boardShade) {
    let rect = inst.patternParams;
    let dEdge = vec2<f32>(min(uv.x - rect.x, rect.z - uv.x), min(uv.y - rect.y, rect.w - uv.y));
    let eN = min(dEdge.x / max(inst.patternColor.r, 1e-5), dEdge.y / max(inst.patternColor.g, 1e-5));
    patBase = patBase * (1.0 - inst.patternColor.b * (1.0 - smoothstep(0.0, 1.0, clamp(eN, 0.0, 1.0))));
  }
//#endif
//#endif

  // PROCEDURAL GROUND (groundShade, bit 18): a standalone surface (ashlar/radialMedallion/borderStrip/grass ...).
  // Exclusive with pattern/board/texOverBase. Slots repurposed: patternColor = (seamR, seamG, seamB, groutWidthUv),
  // patternParams = (p0, p1, jitter, groundMode).
  let groundShade = (flags & 262144u) != 0u;
//#if GROUND
  if (groundShade) {
    let gSeam = inst.patternColor.rgb;
    let gGroutW = inst.patternColor.a;
    let gP0 = inst.patternParams.x;
    let gP1 = inst.patternParams.y;
    let gJit = inst.patternParams.z;
    // groundMode packs METRES PER WORLD UNIT: mode + 100 * round(scale * 10). 0 = a standalone mesh authored
    // 1 unit = 1 m whose uv is a 0..1 region; non-zero = part of a scaled WORLD (see Material3D.groundWorldScale).
    let gScale10 = floor(inst.patternParams.w / 100.0);
    let gMode = inst.patternParams.w - gScale10 * 100.0;
    let gIsWorld = gScale10 > 0.0;
    let gUnitM = select(1.0, gScale10 * 0.1, gIsWorld);   // metres per world unit
    let gMaskC = select(uv, uv * 0.02, gIsWorld);         // world mode: ~1 mask cycle per 45 m
    let gEdgeAmt = select(1.0, 0.0, gIsWorld);            // a continuous ground has no region border
    // The per-mesh scale computed on the CPU (renderer _writeGroundUvScale; uvTransform.z = the marker) replaces the
    // per-pixel derivative estimate. Untextured ground only (nothing else reads its uvTransform).
    let gUvMw = select(gUvM, inst.uvTransform.xy, inst.uvTransform.z < -12000.0);
    let gUvMs = gUvMw * gUnitM;                           // METRES per uv unit (uvM alone is world units)
    // P2 WEATHERING - specularColor repurposed: .r = profile (0-4), .gba = wear center uv + radius.
    let gPc = vec2<f32>(inst.specularColor.g, inst.specularColor.b);
    let gPr = inst.specularColor.a;
    let g0 = groundSurface(uv, gUvMs, gMaskC, gMode, inst.diffuseColor.rgb, gSeam, gGroutW, gP0, gP1, gJit, gPc, gPr);
    let gW = groundWeather(g0, gMaskC, gEdgeAmt, inst.specularColor.r, gPc, gPr);
    // PBR DEEPENING: micro-AO darkens crevices/grout, grooves read a touch rougher.
    patBase = gW.rgb * (1.0 - gW.grout * 0.22);
    roughOverride = clamp(gW.rough + gW.grout * 0.12, 0.04, 1.0);
    // WET SHEEN (visual-polish #5): a material roughness under 0.3 glosses the procedural surface down to it, with
    // ~4 m PUDDLES near mirror-smooth and the asphalt a little darker.
    if (inst.roughness < 0.3) {
      let wetK = clamp((0.3 - inst.roughness) / 0.26, 0.0, 1.0);
      let pud = smoothstep(0.52, 0.72, pg_vnoise(worldPos.xz * gUnitM * 0.25));
      roughOverride = min(roughOverride, mix(max(inst.roughness, 0.04) * 1.5, 0.04, pud) + gW.grout * 0.12);
      patBase = patBase * (1.0 - 0.18 * wetK);
    }
    // HEIGHT -> NORMAL relief: CENTRAL differences at ~one grout width (a one-sided tile-sized epsilon drew a ghost
    // seam beside every real one).
    let gP = uv * gUvMs;
    let gE = max(gGroutW * 0.9, 0.002);
    // P8 GROUND RELIEF LOD (scene.cascadeBias.w = Renderer3D.groundReliefLod; off by default): fades the relief out
    // between a 4 and an 8 cm pixel footprint; the four height samples are skipped where it is gone.
    let gFootM = max(gUvFw.x * gUvMs.x, gUvFw.y * gUvMs.y);
    let gReliefK = select(1.0, 1.0 - smoothstep(0.04, 0.08, gFootM), scene.cascadeBias.w > 0.5);
    if (gReliefK > 0.0) {
      let hL = groundHeightM(gP - vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
      let hR = groundHeightM(gP + vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
      let hD = groundHeightM(gP - vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
      let hU = groundHeightM(gP + vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
      var Tg = cross(vec3<f32>(0.0, 1.0, 0.0), N);
      let tgl = length(Tg);
      let gflat = tgl <= 1e-3;
      Tg = select(Tg / max(tgl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), gflat);
      let Bg = select(cross(N, Tg), vec3<f32>(0.0, 0.0, 1.0), gflat);
      N = normalize(N + (Tg * (hL - hR) + Bg * (hD - hU)) * (0.45 * gReliefK));   // deepened relief
    }
  }
//#endif

  // PAINTED METAL (metalShade, bit 23) - albedo + roughness; lighting does the rest.
  let metalShade = (flags & 8388608u) != 0u;
//#if METAL
  if (metalShade) {
    let mS = metalSurface(worldPos, N, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                          inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                          inst.patternParams.w);
    patBase = mS.rgb;
    roughOverride = mS.rough;
  }
//#endif

  // NEON / SCREEN (neonShade, bit 22) - emissive-only: it replaces the emissive term, not the albedo.
  let neonShade = (flags & 4194304u) != 0u;
//#if NEON
  if (neonShade) {
    emissiveRGB = neonSign(uv, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                           inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                           inst.patternParams.w, scene.ps1Config2.z);
    patBase = inst.diffuseColor.rgb * 0.35;   // the unlit panel body behind the glow
  }
//#endif

  // WATER (waterShade, bit 21). Slots: patternColor = (deep.rgb, packed shallow), patternParams = (waveScale,
  // waveSpeed, choppy, glitter). The reflection tint is the scene FOG colour (tracks the day/night cycle).
  let waterShade = (flags & 2097152u) != 0u;
  var waterGlint = 0.0;
//#if WATER
  if (waterShade) {
    let wS = waterSurface(worldPos, N, V, L, scene.fogColor.rgb,
                          inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                          inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                          inst.patternParams.w, scene.ps1Config2.z);
    patBase = wS.rgb;
    roughOverride = wS.rough;
    N = wS.N;
    waterGlint = wS.glint;
  }
//#endif

  // FOLIAGE SHADE (foliageShade, bit 20 - foliage-quality S2): base AO + ground-colour bleed on the ALBEDO, and the
  // leaf TRANSMISSION added AFTER lighting so it composes with the rim.
  let foliageShade = (flags & 1048576u) != 0u;
  var fqTrans = vec3<f32>(0.0);
//#if FOLIAGE
  if (foliageShade) {
    patBase = foliageBase(patBase, foliageY, inst.patternColor.b, inst.patternColor.g, fq_unpackRGB(inst.patternColor.a));
    fqTrans = foliageTransmission(N, L, V, fq_unpackRGB(inst.patternParams.w), inst.patternColor.r,
                                  scene.lightColor.rgb, scene.lightDirection.w);
  }
//#endif

  var lit: vec3<f32>;
  // Procedural GROUND meshes (bit 18) repurpose specularColor for their weathering data, so it is NOT a colour: the
  // stylised paths get no specular on ground.
  let styleSpec = select(inst.specularColor, vec4<f32>(0.0, 0.0, 0.0, 1.0), groundShade);

  // ── RENDER STYLE CHAIN. Each arm is "if (style test) { ... } else"; a key keeps only its styles' arms, and the PBR
  // arm (or an empty block) ends the chain.
//#if TOON
  // Toon shadows (film-look-and-toon-shadows.md §B): a Cel / Cel-HD material with bit 30 (or the skin ramp, bit 29)
  // gets the banded COLOURED shadow. Skin uses the skin ramp's bands / softness / floor / tint.
  let toonSkin  = skinToonOn;
  let toonP     = select(scene.toonParams.xyz, scene.skinRampParams.xyz, toonSkin);
  let toonTint  = select(scene.styleParams.y, scene.skinRampParams.w, toonSkin);
  let toonSat   = select(scene.styleParams.z, 0.0, toonSkin);
  if ((renderStyle == 1u || renderStyle == 5u) && (toonOn || skinToonOn)) {
    lit = toon_lighting(
      patBase, styleSpec.rgb, styleSpec.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
      toonP, toonTint, toonSat, renderStyle == 5u,
    );
  } else
//#endif
//#if STYLE_1
  if (renderStyle == 1u) {
    lit = cel_lighting(
      patBase, styleSpec.rgb, styleSpec.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else
//#endif
//#if STYLE_2
  if (renderStyle == 2u) {
    lit = sketch_lighting(
      patBase, N, L, worldPos,
      scene.ambientColor.a, scene.lightDirection.w,
      scene.styleParams.x,
    );
  } else
//#endif
//#if STYLE_3
  if (renderStyle == 3u) {
    lit = ink_lighting(
      patBase, N, L, V,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else
//#endif
//#if STYLE_4
  if (renderStyle == 4u) {
    // Gouraud - per-vertex lighting (computed in VS), no per-pixel PBR
    lit = gouraudColor.rgb;
  } else
//#endif
//#if STYLE_5
  if (renderStyle == 5u) {
    // Cel-HD - cel's flat stepped diffuse + a smooth glossy specular
    lit = cel_hd_lighting(
      patBase, styleSpec.rgb, styleSpec.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else
//#endif
//#if STYLE_6
  if (renderStyle == 6u) {
    // Unlit - output the albedo directly, UNAFFECTED by scene lighting (UI cards / labels / overlays)
    lit = patBase;
  } else
//#endif
//#if STYLE_7
  if (renderStyle == 7u) {
    // CD / iridescent disc - Zucconi diffraction rainbow; label on the FRONT face only (front = the +Z ring in the
    // DISC'S OWN space: the fragment normal against the instance's local z axis, normalMatrix column 2).
    let discAxis = vec3<f32>(inst.normalMatrix[2].x, inst.normalMatrix[2].y, inst.normalMatrix[2].z);
//#if TEX
    // The label enters through cd_lighting's FRONT-GATED composite (texSample over the disc base); the late texture
    // multiply below EXCLUDES style 7 (it painted the label on both faces).
//#if TEXSAMPLE
    let cdLabel = select(patBase, mix(patBase, texSample.rgb, texSample.a), (flags & 1u) != 0u);
//#else
    let cdLabel = patBase;
//#endif
    lit = cd_lighting(N, L, V, uv, cdLabel, (flags & 1u) != 0u, dot(worldNormal, discAxis) > 0.0 && frontFacing);
//#else
    // Untextured: the label flag (bit 0) is never set without a texture, so patBase is the (label-less) input.
    lit = cd_lighting(N, L, V, uv, patBase, (flags & 1u) != 0u, dot(worldNormal, discAxis) > 0.0 && frontFacing);
//#endif
  } else
//#endif
//#if STYLE_0
  {
    // Cook-Torrance PBR
    let roughness = max(roughOverride, 0.04);
    let metalness = inst.metalness;
    let albedo    = patBase;
    let F0        = mix(vec3<f32>(0.04), albedo, metalness);

    let H     = rdNormalize(L + V);
    let NdotL = rdDot01(N, L);
    let NdotV = rdDot01(N, V);
    let NdotH = rdDot01(N, H);
    let HdotV = rdDot01(H, V);

    let D  = D_GGX(NdotH, roughness);
    let G  = G_Smith(NdotV, NdotL, roughness);
    let F  = F_Schlick(HdotV, F0);
    let kD = (1.0 - F) * (1.0 - metalness);
    let specularBRDF = D * G * F / max(4.0 * NdotV * NdotL, 0.0001);
    let directLight  = (kD * albedo / PBR_PI + specularBRDF)
                     * scene.lightColor.rgb * scene.lightDirection.w * NdotL;

    let iblOn = ibl.iblEnabled > 0.5;
    let ambFlat = scene.ambientColor.rgb * scene.ambientColor.a;
    var ambient: vec3<f32>;
    if (iblOn) {
      ambient = evalSHIrradiance(N) * albedo * (1.0 - metalness) * ibl.iblIntensity;
    } else {
      ambient = ambFlat * albedo * (1.0 - metalness);
    }
//#if ENV_SPEC
    // Environment specular for METALS, or (SSR on) smooth DIELECTRICS too; matte-flagged meshes (bit 25) always skip.
    // envSpecular uses only explicit-LOD samples, so this non-uniform branch is uniformity-safe.
    if ((metalness > 0.05 || (ibl.ssrEnabled > 0.5 && roughness < ibl.ssrMaxRoughness) || (flags & 67108864u) != 0u) && (flags & 33554432u) == 0u) {
      ambient = ambient + envSpecular(N, V, F0, roughness, NdotV, iblOn, ibl.iblSpecularIntensity, ambFlat, L, scene.lightColor.rgb, scene.lightDirection.w, worldPos, scene.viewProjection, (flags & 67108864u) != 0u);
    }
//#endif

    // SSAO: multiply AMBIENT only (not directLight - the sun is shadow-mapped). Explicit LOD, legal in non-uniform
    // control flow. 1x1 white when SSAO off.
    let ssaoAO = textureSampleLevel(ssaoTexture, ssaoSampler, fragPos.xy / max(scene.resolution.xy, vec2<f32>(1.0)), 0.0).r;
//#if TEX
    // (textured: the PS1 colour depth is applied to the FINAL colour below)
    lit = directLight + ambient * ssaoAO + emissiveRGB;
//#else
    var total = directLight + ambient * ssaoAO + emissiveRGB;
//#if !LEAN
    let cd = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (flags & 2147483648u) != 0u);   // < 0 = opt-in scope: only bit-31 meshes
    if (cd > 0.0) {
      if (scene.ps1Config2.x > 0.0) {
        total = quantizeColorUntexDithered(total, cd, fragPos);
      } else {
        total = quantizeColorUntex(total, cd);
      }
    }
//#endif
    lit = total;
//#endif
  }
//#else
  {
  }
//#endif

//#if TEX && (HAIR || HAIR_BAND)
  var hairBandK = 0.0;
//#endif
//#if TEX && HAIR
  // Anisotropic hair sheen (Kajiya-Kay): a highlight band ALONG the strands (strand tangent = the mesh tangent).
  // HAIR HIGHLIGHT BAND (flags2 bit 7, Cel / Cel-HD only): one crisp flat band applied after the texture multiply.
  let hairBandOn = hairSheen && (u32(inst.normalMatrix[3].x) & 128u) != 0u && (renderStyle == 1u || renderStyle == 5u);
  if (hairSheen) {
    let tl = length(worldTangent);
    let strandT = worldTangent / max(tl, 1e-4);
    let Hs   = rdNormalize(L + V);
    let tDotH = dot(strandT, Hs);
    let sinTH = sqrt(max(0.0, 1.0 - tDotH * tDotH));
    let sheenAmt = pow(sinTH, max(1.0, inst.specularColor.a)) * max(dot(N, L), 0.0);
    if (hairBandOn) { hairBandK = smoothstep(0.55, 0.62, sheenAmt) * clamp(inst.specularColor.r * 2.0, 0.0, 1.0); }
    else { lit = lit + inst.specularColor.rgb * sheenAmt * scene.lightColor.rgb * scene.lightDirection.w; }
  }
//#endif

//#if RIM
  // Rim light (silhouette back-light glow) - render-style-independent modifier. Layers on top of any style.
  if (rimEnabled) {
    if (scene.rimParams.x > 0.0) {
      // Parameterised rim (setRimLight3D): width / hardness / colour - a crisp toon edge light.
      lit = lit + rim_param(N, V, L, scene.rimParams);
    } else {
      let rimF = rdPow(1.0 - max(dot(N, V), 0.0), 3.0);
      let backlit = mix(0.35, 1.0, 1.0 - max(dot(N, L), 0.0));
      lit = lit + rimF * backlit * 0.42 * scene.lightColor.rgb;
    }
  }
//#endif

//#if FOLIAGE
  // LEAF TRANSMISSION (bit 20) - added right after the rim so the two COMPOSE; HEADROOM-GATED so a brightly lit leaf
  // can't be pushed past white.
  lit = lit + fqTrans * clamp(1.0 - max(lit.r, max(lit.g, lit.b)), 0.0, 1.0);
//#endif
//#if WATER
  // WATER glitter is added AFTER lighting (a specular scintillation off the ripple normal).
  lit = lit + scene.lightColor.rgb * waterGlint;
//#endif

  // POINT LIGHTS (street lamps at night): additive lambert with a smooth radius falloff, PBR / cel / ink / cel-HD.
  // Collected into plPost and added AFTER the sun shadow (lamp light is never sun/moon-shadowed). A small highlight
  // weighted by (1 - roughness) squared makes wet roads streak.
  var plPost = vec3<f32>(0.0);
//#if !LEAN && (STYLE_0 || STYLE_1 || STYLE_3 || STYLE_5)
  if (renderStyle == 0u || renderStyle == 1u || renderStyle == 3u || renderStyle == 5u) {
    var plAdd = vec3<f32>(0.0);
    var plSpec = vec3<f32>(0.0);
    let plGloss = (1.0 - clamp(inst.roughness, 0.0, 1.0)) * (1.0 - clamp(inst.roughness, 0.0, 1.0));
    let plN = min(i32(scene.lightCounts.x), 16);
    for (var pi = 0; pi < plN; pi++) {
      let lp = scene.pointLights[pi * 2];
      let lc = scene.pointLights[pi * 2 + 1];
      let dv = lp.xyz - worldPos;
      let d = length(dv);
      let att = clamp(1.0 - d / max(lp.w, 1e-3), 0.0, 1.0);
      let ndl = max(dot(N, dv / max(d, 1e-4)), 0.0);
      plAdd = plAdd + lc.rgb * (lc.a * att * att * (0.3 + 0.7 * ndl));
      let plH = rdNormalize(dv / max(d, 1e-4) + V);
      plSpec = plSpec + lc.rgb * (lc.a * att * pow(max(dot(N, plH), 0.0), 48.0) * plGloss * 1.6);
    }
    plPost = patBase * plAdd + plSpec;
  }
//#endif

//#if !TEX
//#if GLASS
  // SCREEN-SPACE REFRACTION (glassEnhance + resolution.w gate, the CD kit only): sample the PREVIOUS frame's final
  // image at this pixel, offset by the surface normal, so the case contents show THROUGH the clear plastic.
  if (glassEnhance && scene.resolution.w > 0.5) {
    let refrScreenUV = fragPos.xy / max(scene.resolution.xy, vec2<f32>(1.0));
    let refrUV = clamp(refrScreenUV + N.xy * vec2<f32>(0.045, -0.045), vec2<f32>(0.0), vec2<f32>(1.0));
    let refracted = textureSampleLevel(sceneColorTexture, sceneColorSampler, refrUV, 0.0).rgb;
    lit = mix(refracted, lit, 0.15);
  }
//#endif
//#if GLASS || PAT_6
  // ENHANCED-VISUALS STYLIZED GLASS: a fresnel sky-reflection on glass surfaces (curtain walls / storefronts / window
  // openings), gated by the global glass toggle (ps1Config2.w). Sky = the scene's fog colour, horizon split, per-pane
  // variation and a sun glint.
  let winGlass = patMode == 6u && winWL.x > 0.5;
  if ((glassEnhance || winGlass) && scene.ps1Config2.w > 0.5) {
    let R = reflect(-V, N);
    let skyC = scene.fogColor.rgb;
    let up = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
    let ground = skyC * 0.42;
    let sky = mix(ground, skyC * 1.12, smoothstep(0.42, 0.62, up)) * (0.55 + 0.9 * scene.lightColor.rgb);
    let fres = 0.30 + 0.70 * rdPow(1.0 - max(dot(N, V), 0.0), 2.0);
    let pane = 0.92 + 0.16 * pg_hash21(floor(worldPos.xz * 6.3 + vec2<f32>(worldPos.y * 4.1)));
    let glint = pow(max(dot(R, L), 0.0), 320.0) * 1.4;
    lit = mix(lit, sky * pane, fres * select(0.6, 0.45, winGlass));
    lit = lit + scene.lightColor.rgb * glint * fres;
  }
//#endif
//#endif

//#if SHADOW
  // RECEIVE the sun shadow (PCF above). Emissive light is restored un-shadowed. The in-shadow light floor is
  // scene.resolution.z (shadow darkness).
  let shadowFactor = sampleShadowCascaded(worldPos);   // near cascades (persona-polish A2) + the original map
  // COLOURED SHADOW (city-quality L3): styleParams.w packs an rgb8 tint, normalised to unit luminance.
  let shTintRaw = toon_unpack_rgb8(scene.styleParams.w);
  let shTint = select(vec3<f32>(1.0), shTintRaw / max(dot(shTintRaw, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-3), scene.styleParams.w > 0.5);
//#if DEBUG
  // RENDER DEBUG (ibl.dbgFlags, uniform): 8 = skip the shadow receive (shadowMul 1); 16 = show shadowFactor as grey
  // (red above 1, blue below 0, green NaN / Inf).
  let rdSh = u32(ibl.dbgFlags);
  let shadowMul = select(mix(vec3<f32>(scene.resolution.z) * shTint, vec3<f32>(1.0), shadowFactor), vec3<f32>(1.0), (rdSh & 8u) != 0u);
//#else
  let shadowMul = mix(vec3<f32>(scene.resolution.z) * shTint, vec3<f32>(1.0), shadowFactor);
//#endif
  lit = lit * shadowMul + emissiveRGB * (vec3<f32>(1.0) - shadowMul);
//#if DEBUG
  if ((rdSh & 16u) != 0u) {
    let rdSfBad = (bitcast<u32>(shadowFactor) & 0x7f800000u) == 0x7f800000u;
    var rdSf = vec3<f32>(clamp(shadowFactor, 0.0, 1.0));
    rdSf = select(rdSf, vec3<f32>(1.0, 0.0, 0.0), shadowFactor > 1.0001);
    rdSf = select(rdSf, vec3<f32>(0.0, 0.0, 1.0), shadowFactor < -0.0001);
    lit = select(rdSf, vec3<f32>(0.0, 1.0, 0.0), rdSfBad);
  }
//#endif
//#endif
  lit = lit + plPost;   // lamp light is never sun/moon-shadowed (see the point-light block)

//#if DEBUG
  // RENDER DEBUG dbgNanCheck (ibl.dbgFlags value 2): also test the UNCLAMPED lit colour. Uniform branch.
  var rdPre = 0u;
  if ((u32(ibl.dbgFlags) & 2u) != 0u) { rdPre = rdState(vec4<f32>(lit, 1.0)); }
//#endif
  var finalColor = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);

//#if TEX
//#if TEXSAMPLE
  // The diffuse texture as a LATE whole-mesh multiply. texOverBase already composited it pre-lighting; CD (7)
  // composites its label inside cd_lighting behind the front gate.
  if (hasTexture && !texOverBase && renderStyle != 7u) {
//#if STYLE_2
    if (renderStyle == 2u) {
      finalColor = vec4<f32>(mix(finalColor.rgb, finalColor.rgb * texSample.rgb, 0.5), finalColor.a * texSample.a);
    } else
//#endif
    {
      finalColor = vec4<f32>(finalColor.rgb * texSample.rgb, finalColor.a * texSample.a);
    }
  }
//#endif
//#if HAIR_BAND
  if (hairBandK > 0.0) { finalColor = vec4<f32>(mix(finalColor.rgb, min(finalColor.rgb * 1.55 + vec3<f32>(0.10), vec3<f32>(1.0)), hairBandK), finalColor.a); }
//#endif
//#else
//#if RADIAL
  // RADIAL FADE (bit 17): soft circular alpha falloff from the UV centre (the packaging CONTACT-SHADOW blob).
  if (radialFade) {
    let rd = length(uv - vec2<f32>(0.5, 0.5)) * 2.0;
    let fade = 1.0 - smoothstep(0.2, 1.0, rd);
    finalColor = vec4<f32>(finalColor.rgb, finalColor.a * fade * fade);
  }
//#endif
//#endif
//#if LINING
  // CLOTH LINING (flags2 bit 8, Material3D.clothLining): the inside of a garment (its back face) reads as the fabric
  // in shadow - capped at the albedo and darkened.
  if ((u32(inst.normalMatrix[3].x) & 256u) != 0u && !frontFacing) {
//#if TEX
//#if TEXSAMPLE
    let lnAlb = inst.diffuseColor.rgb * select(vec3<f32>(1.0), texSample.rgb, hasTexture);
//#else
    let lnAlb = inst.diffuseColor.rgb;
//#endif
    finalColor = vec4<f32>(min(finalColor.rgb, lnAlb) * 0.32, finalColor.a);
//#else
    finalColor = vec4<f32>(min(finalColor.rgb, inst.diffuseColor.rgb) * 0.32, finalColor.a);
//#endif
  }
//#endif

  if (finalColor.a < 0.01) { discard; }
//#if !LEAN
  let fogMode = u32(scene.fogParams.w);
//#if TEX
  if (fogMode != 0u && renderStyle != 6u && !fhNoFogM) {   // unlit (UI cards) and no-fog meshes ignore atmospheric fog
//#else
  if (fogMode != 0u && !fhNoFogM) {   // no-fog meshes (Material3D.noFog) ignore atmospheric fog
//#endif
    let fogDist = length(scene.fogEye.xyz - worldPos);   // fog-horizon: the fog eye (perspective = the camera, bit-identical)
    var fogFactor: f32;
    if (fogMode == 1u) {
      fogFactor = clamp((fogDist - scene.fogParams.x) / max(scene.fogParams.y - scene.fogParams.x, 0.001), 0.0, 1.0);
    } else {
      fogFactor = 1.0 - exp(-scene.fogParams.z * fogDist);
    }
//#if !TEX
    // ENHANCED-VISUALS AERIAL PERSPECTIVE (untextured only): distant geometry DESATURATES with distance before fading
    // to the fog colour. Strength = fogColor.w (0 = plain fog).
    let aerial = scene.fogColor.w;
    if (aerial > 0.0) {
      let lum = dot(finalColor.rgb, vec3<f32>(0.299, 0.587, 0.114));
      finalColor = vec4<f32>(mix(finalColor.rgb, vec3<f32>(lum), fogFactor * aerial * 0.75), finalColor.a);
    }
//#endif
    // HEIGHT FOG (city-quality P9): a ground-hugging layer that thickens toward heightFog.y and with distance.
    if (scene.heightFog.x > 0.0) {
      let hfH = exp(-max(worldPos.y - scene.heightFog.y, 0.0) * max(scene.heightFog.z, 1e-4));
      let hfD = 1.0 - exp(-fogDist * max(scene.heightFog.w, 1e-4));
      fogFactor = max(fogFactor, clamp(scene.heightFog.x * hfH * hfD, 0.0, 1.0));
    }
    // AERIAL PERSPECTIVE (persona-polish A5): contrast fades toward the haze and the colour leans to the horizon
    // colour from the first metres out. strength 0 = off.
    if (scene.aerialParams.x > 0.0) {
      let ah = scene.aerialParams.x * (1.0 - exp(-fogDist * scene.aerialParams.y));
      let lw = vec3<f32>(0.2126, 0.7152, 0.0722);
      let midL = 0.5 * (dot(finalColor.rgb, lw) + dot(scene.fogColor.rgb, lw));
      let flatC = mix(finalColor.rgb, vec3<f32>(midL), ah * scene.aerialParams.z);
      finalColor = vec4<f32>(mix(flatC, scene.fogColor.rgb, ah * scene.aerialParams.w), finalColor.a);
    }
    finalColor = vec4<f32>(mix(finalColor.rgb, scene.fogColor.rgb, fogFactor), finalColor.a);
  }
//#if TEX
  // PS1 color-depth quantization (textured) - applied to the FINAL color (after texture + fog), not to unlit cards.
  let cd = select(scene.ps1Config.w, -scene.ps1Config.w, scene.ps1Config.w < 0.0 && (flags & 2147483648u) != 0u);   // < 0 = opt-in scope: only bit-31 meshes
  if (cd > 0.0 && renderStyle != 6u) {
    if (scene.ps1Config2.x > 0.0) {
      finalColor = vec4<f32>(quantizeColorDithered(finalColor.rgb, cd, fragPos), finalColor.a);
    } else {
      finalColor = vec4<f32>(quantizeColor(finalColor.rgb, cd), finalColor.a);
    }
  }
//#endif
//#endif
//#if DEBUG
  return dbgFinal(finalColor, rdPre);
//#else
  return finalColor;
//#endif
}
`;
