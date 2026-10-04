// C1 Part 2 (2026-09-13): the scene-uniform MATH, extracted pure from renderer-3d.ts
// (the day-night precedent: math out, application stays). Three pieces:
//   • packSceneUniforms — the SceneUniforms struct layout (the fragile float-offset contract with
//     every 3D shader: mesh3d / skinned / vertex-color / shadow / water). The offsets live HERE now,
//     unit-testable; the renderer just builds the params and writes the buffer.
//   • selectNearestPointLights — the bounded-insertion nearest-K pick (P6), pure over its arrays.
//   • computeLightSpaceMatrix — the shadow-box cube ortho matrix, pure given scratch.
// State application (shadow-map staleness, effective box size, the GPU write) stays on Renderer3D.
import { vec3, mat4 } from 'gl-matrix';
import type { Light3DConfig, PS1Config, FogConfig } from './renderer-3d';
import type { SceneWind3D } from './material-3d';

/** Shader-side point-light array bound (mesh3d-shaders `MAX_POINT_LIGHTS` — keep in sync). */
export const MAX_POINT_LIGHTS = 16;
export type PointLight3D = { pos: [number, number, number]; radius: number; color: [number, number, number]; intensity: number };

export interface ScenePackParams {
  vp: Float32Array;                        // viewProjection mat4
  camPos: ArrayLike<number>;               // camera world position
  orthographic: boolean;                   // cameraPosition.w flag — shaders switch to a parallel-ray V
  ambientColor: [number, number, number];
  ambientIntensity: number;
  light: Light3DConfig;
  ps1: PS1Config;
  w: number; h: number;                    // canvas resolution
  shadowMinLight: number;                  // resolution.z repurposed: in-shadow light floor
  glassRefraction: number;                 // resolution.w repurposed: glass-refraction enable
  /** null = shadows off → the lightSpaceMatrix/shadowParams block is left UNTOUCHED (stale values
   *  remain in `data`, exactly the pre-extraction behavior — shaders don't read it when off). */
  lightSpaceMatrix: Float32Array | null;
  shadowPcfRadius: number; effBias: number; shadowMapSize: number; shadowSoftness: number;
  fog: FogConfig;
  aerialFog: number;                       // fogColor.w — aerial-perspective strength
  pointLights: PointLight3D[];
  wind: SceneWind3D;                       // rides the three free lightCounts slots
  glassQuality: number;                    // ps1Config2.w — stylized-glass toggle
  timeSec: number;                         // ps1Config2.z — scene time, already world-speed scaled + wrapped
  softLightStrength: number;               // lightColor.w — global wrapped/half-Lambert amount for softLighting materials (0..1)
  /** Skin toon-ramp look (skinRampParams vec4, floats 204-207): bands, softness, shadowFloor, tintPacked
   *  (rgb 8:8:8 via packRGB8). Read only by `skinRamp`-flagged materials in the vertex-Gouraud path. */
  skinRamp: { bands: number; softness: number; shadowFloor: number; tintPacked: number };
  /** Sketch render style (styleParams vec4, floats 208-211): .x = PAPER amount 0..1 (1 = off-white paper with a
   *  colour wash, 0 = the full colour with pencil hatching; default 0.75 = the original look). .yzw reserved. */
  sketchPaper: number;
  /** Packed rgb8 COLOURED-SHADOW tint (styleParams.w); 0 / absent = neutral grey (the original). */
  shadowTintPacked?: number;
  /** HEIGHT FOG (floats 220-223): density (0 = off), base height, falloff per unit, distance reach. */
  heightFog?: [number, number, number, number];
  /** Toon shadows (toonParams vec4 floats 212-215 + styleParams.yz): see material-3d ToonShadowSettings. */
  toon: { bands: number; softness: number; shadowValue: number; tintPacked: number; saturation: number };
  /** Rim light (rimParams vec4 floats 216-219): strength (0 = the original rim), width, hardness, colour packed. */
  rim: { strength: number; width: number; hardness: number; colorPacked: number };
  /** CASCADED SHADOWS (persona-polish A2, floats 224-263): the extra near cascades (the far map above stays cascade
   *  "last"). Absent / count 0 = off (single map, the original). */
  cascades?: CascadePack | null;
  /** AERIAL HAZE (persona-polish A5, floats 264-267): strength (0 = off), reach (world units), contrast, tint. */
  aerialHaze?: [number, number, number, number];
  /** P8 shader fast paths (cascadeBias.z, float 262): 1 = the bit-identical fragment shortcuts on, 0 / absent = off. */
  shaderFastPaths?: number;
  /** P8 ground relief LOD (cascadeBias.w, float 263): 1 = fade the procedural-ground relief past a 4-8 cm pixel. */
  groundReliefLod?: number;
  /** FOG EYE (fog-horizon, fogEye.xyz floats 268-270): the point every fog distance is measured from. Perspective =
   *  the camera position (absent = camPos, bit-identical); ortho = the equivalent-perspective eye (fog-horizon.ts). */
  fogEye?: ArrayLike<number>;
  /** Fog-horizon fade band width in world units (fogEye.w, float 271; 0 = no band). */
  fogFade?: number;
  /** Fog-horizon flag bits (toonParams.w, float 215; fog-horizon.ts FOG_HORIZON_*). 0 / absent = inert. */
  fogHorizonFlags?: number;
  /** TEMPORAL AA dither shift (cascadeParams.w, float 259; temporal-aa.ts): 0..15 = the Bayer offset the fade dithers
   *  use this frame (x = v % 4, y = v / 4). 0 / absent = off (bit-identical). */
  taaDitherShift?: number;
}

/** The packed cascade block: `count` near cascades (0..2), their light matrices (16 floats each, nearest first), the
 *  cascade map size, the blend-band fraction, and each cascade's NDC depth bias. */
export interface CascadePack { count: number; matrices: Float32Array; mapSize: number; band: number; bias: [number, number] }


/** Pack the whole SceneUniforms struct into `data` (floats; layout in the comments). Pure: no GPU,
 *  no renderer state — the caller uploads `data` afterwards. */
export function packSceneUniforms(data: Float32Array, p: ScenePackParams): void {
  // viewProjection mat4x4 (floats 0–15)
  data.set(p.vp, 0);

  // cameraPosition vec4 (floats 16–19). .w = ORTHOGRAPHIC flag (1 = ortho): in ortho the view rays are PARALLEL
  // (no finite eye), so the shaders use a constant forward for V instead of (eye - worldPos) — otherwise fresnel/
  // rim/water/reflection highlights track a fake perspective eye and wander as you pan/zoom the ortho view.
  data[16] = p.camPos[0]; data[17] = p.camPos[1]; data[18] = p.camPos[2]; data[19] = p.orthographic ? 1 : 0;

  // ambientColor vec4 (floats 20–23, .a = intensity)
  data[20] = p.ambientColor[0]; data[21] = p.ambientColor[1]; data[22] = p.ambientColor[2];
  data[23] = p.ambientIntensity;

  // lightDirection vec4 (floats 24–27, .w = intensity)
  data[24] = p.light.direction[0]; data[25] = p.light.direction[1]; data[26] = p.light.direction[2];
  data[27] = p.light.intensity;

  // lightColor vec4 (floats 28–31). .w repurposed: global soft-lighting (wrapped/half-Lambert) strength 0..1,
  // applied per-fragment only to materials with the softLighting flag (bit 28).
  data[28] = p.light.color[0]; data[29] = p.light.color[1]; data[30] = p.light.color[2];
  data[31] = p.softLightStrength;

  // ps1Config vec4 (floats 32–35)
  data[32] = p.ps1.vertexJitter;
  data[33] = p.ps1.snapGridSize;
  data[34] = p.ps1.affineStrength;
  // Colour depth; NEGATIVE = scope 'optIn' (only `retroColor` meshes quantize — see PS1Config.colorScope). Every
  // shader tests `> 0`, so a path that doesn't read the per-mesh bit just skips it in opt-in mode (fail-safe).
  data[35] = p.ps1.colorScope === 'optIn' ? -Math.abs(p.ps1.colorDepth) : p.ps1.colorDepth;

  // resolution vec4 (floats 36–39)
  data[36] = p.w;
  data[37] = p.h;
  data[38] = p.shadowMinLight;   // resolution.z repurposed: in-shadow light floor (shadow darkness)
  data[39] = p.glassRefraction;  // resolution.w repurposed: glass-refraction enable (0 off · 1 on) — scoped
                                 // to the CD kit so city glass (which also sets glassEnhance) stays unchanged

  // lightSpaceMatrix mat4x4 (floats 40–55) + shadowParams (floats 56–59)
  if (p.lightSpaceMatrix) {
    data.set(p.lightSpaceMatrix, 40);
    data[56] = p.shadowPcfRadius;  // PCF radius override (shadowParams.x): 0 = default 5x5, 1 = fast 3x3
    data[57] = p.effBias;          // effective bias (scaled to the zoom-adaptive box's texel size)
    data[58] = p.shadowMapSize;
    data[59] = p.shadowSoftness;   // PCF penumbra width multiplier (shadowParams.w)
  }

  // fogColor (floats 60–63) + fogParams (floats 64–67)
  data[60] = p.fog.color[0]; data[61] = p.fog.color[1]; data[62] = p.fog.color[2]; data[63] = 0;
  data[64] = p.fog.near;
  data[65] = p.fog.far;
  data[66] = p.fog.density;
  data[67] = p.fog.mode === 'linear' ? 1 : p.fog.mode === 'exponential' ? 2 : 0;

  // lightCounts vec4 (floats 72–75, .x = point-light count) + POINT LIGHTS (floats 76–203):
  // per light 2 vec4s — (pos.xyz, radius) + (color.rgb, intensity). Street lamps at night.
  data[72] = p.pointLights.length;
  // SCENE WIND (foliage-quality S1) rides the three FREE lightCounts slots — .y = heading in radians over
  // the world XZ plane, .z = strength (tip travel at windAmount 1), .w = speed. Read by every vertex
  // shader (mesh3d, vertex-color) AND the shadow depth pass, so shadows sway with the plants.
  data[73] = p.wind.dirDeg * (Math.PI / 180);
  data[74] = p.wind.strength;
  data[75] = p.wind.speed;
  for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
    const o = 76 + i * 8, pl = p.pointLights[i];
    if (pl) {
      data[o] = pl.pos[0]; data[o + 1] = pl.pos[1]; data[o + 2] = pl.pos[2]; data[o + 3] = pl.radius;
      data[o + 4] = pl.color[0]; data[o + 5] = pl.color[1]; data[o + 6] = pl.color[2]; data[o + 7] = pl.intensity;
    } else {
      data[o + 3] = 0; data[o + 7] = 0;
    }
  }

  // ps1Config2 (floats 68–71) — dithering + UV quantization
  const ditherEnabled = p.ps1.dither && (p.ps1.ditherStrength ?? 0.5) > 0;
  data[68] = ditherEnabled ? (p.ps1.ditherStrength ?? 0.5) : 0;
  const uvQEnabled = p.ps1.uvQuantize && (p.ps1.uvQuantizeSteps ?? 64) > 0;
  data[69] = uvQEnabled ? (p.ps1.uvQuantizeSteps ?? 64) : 0;
  data[70] = p.timeSec;          // ps1Config2.z = scene time (s) — world-speed scaled (UI freezeWorld)
  data[71] = p.glassQuality;     // ps1Config2.w = stylized-glass toggle (0 off · 1 on)
  data[63] = p.aerialFog;        // fogColor.w = aerial-perspective strength (0 off · >0 on) — deliberately
                                 // LAST: overrides the 0 written with fogColor above

  // skinRampParams vec4 (floats 204-207) — appended AFTER the point-light array (buffer bumped to 208 floats /
  // 832 bytes). Read only by materials with the skinRamp flag (bit 29) in the vertex-Gouraud paths; unused
  // elsewhere. .x = bands (≥1) .y = terminator softness (0..1) .z = shadowFloor (0..1) .w = tint rgb packed 8:8:8.
  data[204] = p.skinRamp.bands;
  data[205] = p.skinRamp.softness;
  data[206] = p.skinRamp.shadowFloor;
  data[207] = p.skinRamp.tintPacked;

  // styleParams vec4 (floats 208-211) — scene-global render-STYLE knobs (buffer bumped to 212 floats / 848 bytes).
  // .x = Sketch paper amount (read by sketch_lighting). .yzw reserved for later style settings.
  data[208] = p.sketchPaper;
  data[209] = p.toon.tintPacked;    // styleParams.y = toon shadow tint (rgb 8:8:8)
  data[210] = p.toon.saturation;    // styleParams.z = toon shadow saturation boost
  data[211] = p.shadowTintPacked ?? 0;   // styleParams.w = coloured-shadow tint (rgb 8:8:8; 0 = neutral)
  // heightFog vec4 (floats 220-223) — appended after rimParams (buffer 880 → 896 bytes). Guarded: callers that pack
  // into the old 220-float array stay safe.
  if (data.length >= 224) { const hf = p.heightFog ?? [0, 0, 0, 0]; data[220] = hf[0]; data[221] = hf[1]; data[222] = hf[2]; data[223] = hf[3]; }
  // CASCADES (persona-polish A2) — cascadeMatrices array<mat4x4, 2> (floats 224-255), cascadeParams (256-259: count,
  // map size, blend band, 0), cascadeBias (260-263: bias c0, bias c1, 0, 0). Buffer 896 → 1056 bytes. Guarded like
  // heightFog. count 0 → the shaders sample only the original map (bit-identical).
  if (data.length >= 264) {
    const c = p.cascades;
    const n = c ? Math.max(0, Math.min(2, c.count | 0)) : 0;
    if (c && n > 0) data.set(c.matrices.subarray(0, 32), 224);
    data[256] = n; data[257] = c ? c.mapSize : 0; data[258] = c ? c.band : 0; data[259] = p.taaDitherShift ?? 0;   // .w = temporal AA dither shift
    data[260] = c ? c.bias[0] : 0; data[261] = c ? c.bias[1] : 0; data[262] = p.shaderFastPaths ?? 0; data[263] = p.groundReliefLod ?? 0;   // .z = P8 fast paths, .w = P8 ground relief LOD
  }
  // aerialParams (floats 264-267, persona-polish A5): .x strength (0 = off), .y 1 / reach, .z contrast share, .w tint
  // share. Buffer 1056 → 1072 bytes.
  if (data.length >= 268) {
    const a = p.aerialHaze ?? [0, 1, 0, 0];
    data[264] = a[0]; data[265] = 1 / Math.max(1e-4, a[1]); data[266] = a[2]; data[267] = a[3];
  }
  // fogEye vec4 (floats 268-271, fog-horizon): .xyz = the fog eye (default = the camera position, so perspective fog is
  // bit-identical to the old length(cameraPosition - worldPos)), .w = the fade band width (world units, 0 = off).
  // Buffer 1072 -> 1088 bytes. Guarded like the blocks above.
  if (data.length >= 272) {
    const e = p.fogEye ?? p.camPos;
    data[268] = e[0]; data[269] = e[1]; data[270] = e[2]; data[271] = p.fogFade ?? 0;
  }

  // toonParams vec4 (floats 212-215) — buffer 220 floats / 880 bytes. Read by toonShadow (bit 30) materials in Cel.
  // .w (float 215, unread before 2026-10-01) = the fog-horizon flag bits (0 = inert, every shader path the original).
  data[212] = p.toon.bands; data[213] = p.toon.softness; data[214] = p.toon.shadowValue; data[215] = p.fogHorizonFlags ?? 0;
  // rimParams vec4 (floats 216-219). .x = 0 → the fragment shaders keep the ORIGINAL fixed rim (bit-identical).
  data[216] = p.rim.strength; data[217] = p.rim.width; data[218] = p.rim.hardness; data[219] = p.rim.colorPacked;
}

/** P6 nearest-K point-light pick by GROUND distance (the iso camera sits high; its target = where you
 *  look) into a REUSED output array via bounded insertion — no per-select map/sort/slice/map
 *  allocation, O(n·K) not O(n log n). `dist` is the parallel reused distance buffer. */
export function selectNearestPointLights(
  cands: PointLight3D[], tx: number, tz: number, K: number,
  out: PointLight3D[], dist: number[],
): void {
  out.length = 0;
  if (cands.length <= K) { for (let i = 0; i < cands.length; i++) out.push(cands[i]); return; }
  dist.length = 0;
  for (let i = 0; i < cands.length; i++) {
    const l = cands[i];
    const d = (l.pos[0] - tx) ** 2 + (l.pos[2] - tz) ** 2;
    if (out.length === K && d >= dist[K - 1]) continue;   // farther than the current worst-kept → drop it
    let j: number;
    if (out.length < K) { out.push(l); dist.push(d); j = out.length - 1; }
    else { j = K - 1; out[j] = l; dist[j] = d; }          // overwrite the worst, then bubble into place
    while (j > 0 && dist[j - 1] > dist[j]) {              // insertion-sort the newcomer left (ascending distance)
      const td = dist[j - 1]; dist[j - 1] = dist[j]; dist[j] = td;
      const tl = out[j - 1];  out[j - 1]  = out[j];  out[j]  = tl;
      j--;
    }
  }
}

/** Persistent scratch for computeLightSpaceMatrix — the caller owns it (allocation-free hot path). */
export interface LightSpaceScratch { eye: vec3; up: vec3; view: mat4; proj: mat4; out: mat4 }

/** The directional-shadow ortho matrix over a CUBE box centred at `c` with half-extent `he`.
 *  Allocation-free: this runs every frame while shadows are on (city + character) — reuses `s`. */
export function computeLightSpaceMatrix(
  d: ArrayLike<number>, he: number, c: vec3, s: LightSpaceScratch,
): Float32Array {
  // ── The box must be a CUBE, not a column ──────────────────────────────────────────────────────────────────
  // The ortho box's coverage of the GROUND is the box projected along the sun. If the box is deeper (along the
  // light axis) than it is wide, that projection stretches into an ellipse along the sun's horizontal direction,
  // which ROTATES with azimuth → shadows sweep across the city in a ring with a dead zone. So make depth ≈ width:
  // eye sits 2·he back, near/far bracket the centre by ~±he. A ~cube projects to an isotropic disc at every azimuth.
  const eyeDist = he * 2;
  const eye = vec3.set(s.eye, c[0] - d[0] * eyeDist, c[1] - d[1] * eyeDist, c[2] - d[2] * eyeDist);
  const up = Math.abs(d[1]) > 0.99
    ? vec3.set(s.up, 1, 0, 0)
    : vec3.set(s.up, 0, 1, 0);

  mat4.lookAt(s.view, eye, c, up);

  // near catches casters BETWEEN the sun and the region (they cast into it); far reaches just past the centre.
  mat4.ortho(s.proj, -he, he, -he, he, he * 0.05, eyeDist + he);

  mat4.multiply(s.out, s.proj, s.view);
  return s.out as Float32Array;
}

const _cascadeAt = vec3.create();

/** A near SHADOW CASCADE's light matrix (persona-polish A2): an ortho box of half-width `he` around `c`, seen along the
 *  light `d`, depth [-back, +fwd] around the centre (back reaches up toward the sun so tall casters outside the box
 *  still throw into it). STABILISED: the centre is snapped to whole shadow-map texels in LIGHT space, so a moving
 *  camera never makes the texels crawl (the classic CSM shimmer) at any sun angle. Uses a 0..1 depth range (orthoZO),
 *  the full precision of the depth texture. Writes `out` (16 floats) and returns it; allocation-free with `s`. */
export function computeCascadeMatrix(
  d: ArrayLike<number>, he: number, c: ArrayLike<number>, back: number, fwd: number, mapSize: number,
  s: LightSpaceScratch, out: Float32Array,
): Float32Array {
  return cascadeMatrixFromBox(cascadeLightBox(d, he, c, back, fwd, mapSize, s, _cascadeBoxScratch), s, out);
}

/** A near cascade's box in LIGHT space (engine-roadmap step 7 / performance-plan P14): the unit light direction, the
 *  half-width, the map size, the texel-snapped centre (sx, sy) and the view-space depth range [zn, zf]. The P14
 *  cascade cache keeps a box (and so its matrix) while the wanted box stays inside its slack (shadow-cache.ts). */
export interface CascadeLightBox { dx: number; dy: number; dz: number; he: number; size: number; sx: number; sy: number; zn: number; zf: number }
const _cascadeBoxScratch: CascadeLightBox = { dx: 0, dy: -1, dz: 0, he: 1, size: 1, sx: 0, sy: 0, zn: 0, zf: 1 };

/** The light-space box computeCascadeMatrix builds (the same snapped centre and depth range). Writes `out`. */
export function cascadeLightBox(
  d: ArrayLike<number>, he: number, c: ArrayLike<number>, back: number, fwd: number, mapSize: number,
  s: LightSpaceScratch, out: CascadeLightBox,
): CascadeLightBox {
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  const dx = d[0] / dl, dy = d[1] / dl, dz = d[2] / dl;
  const up = Math.abs(dy) > 0.99 ? vec3.set(s.up, 1, 0, 0) : vec3.set(s.up, 0, 1, 0);
  // Rotation-only light view (eye at the origin looking along d) — so the snap below is a pure light-space grid.
  vec3.set(s.eye, 0, 0, 0);
  const at = vec3.set(_cascadeAt, dx, dy, dz);
  mat4.lookAt(s.view, s.eye, at, up);
  const v = s.view;
  const lx = v[0] * c[0] + v[4] * c[1] + v[8] * c[2] + v[12];
  const ly = v[1] * c[0] + v[5] * c[1] + v[9] * c[2] + v[13];
  const lz = v[2] * c[0] + v[6] * c[1] + v[10] * c[2] + v[14];
  const texel = (2 * he) / Math.max(1, mapSize);
  out.dx = dx; out.dy = dy; out.dz = dz; out.he = he; out.size = mapSize;
  out.sx = Math.round(lx / texel) * texel; out.sy = Math.round(ly / texel) * texel;
  // View space looks down -z: the centre sits at depth -lz; near = toward the sun (smaller distance).
  out.zn = -lz - back; out.zf = -lz + fwd;
  return out;
}

/** The cascade matrix of a light-space box (orthoZO: the full 0..1 depth precision). Writes `out` (16 floats). */
export function cascadeMatrixFromBox(b: CascadeLightBox, s: LightSpaceScratch, out: Float32Array): Float32Array {
  const up = Math.abs(b.dy) > 0.99 ? vec3.set(s.up, 1, 0, 0) : vec3.set(s.up, 0, 1, 0);
  vec3.set(s.eye, 0, 0, 0);
  const at = vec3.set(_cascadeAt, b.dx, b.dy, b.dz);
  mat4.lookAt(s.view, s.eye, at, up);
  mat4.orthoZO(s.proj, b.sx - b.he, b.sx + b.he, b.sy - b.he, b.sy + b.he, b.zn, b.zf);
  mat4.multiply(s.out, s.proj, s.view);
  out.set(s.out as Float32Array);
  return out;
}

/** Where a near cascade sits (persona-polish A2). An ORBIT camera (far from its target) centres it on the target —
 *  the ground you look at; an eye-level / Play / fly camera centres it AHEAD of the eye (by `ahead` × he), so the
 *  whole box covers what is in front instead of wasting half of it behind the camera. Pure. */
export function cascadeCentre(
  pos: ArrayLike<number>, target: ArrayLike<number>, he: number, out: [number, number, number], ahead = 0.55,
): [number, number, number] {
  const fx = target[0] - pos[0], fy = target[1] - pos[1], fz = target[2] - pos[2];
  const dist = Math.hypot(fx, fy, fz);
  if (dist > 2 * he || dist < 1e-6) { out[0] = target[0]; out[1] = target[1]; out[2] = target[2]; return out; }
  // Horizontal forward (a pitched-down eye still pushes the box along the street, not into the pavement).
  const hl = Math.hypot(fx, fz);
  const k = hl > 1e-6 ? (he * ahead) / hl : 0;
  out[0] = pos[0] + fx * k; out[1] = pos[1]; out[2] = pos[2] + fz * k;
  return out;
}
