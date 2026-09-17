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
}

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

  // lightColor vec4 (floats 28–31)
  data[28] = p.light.color[0]; data[29] = p.light.color[1]; data[30] = p.light.color[2];
  data[31] = 0;

  // ps1Config vec4 (floats 32–35)
  data[32] = p.ps1.vertexJitter;
  data[33] = p.ps1.snapGridSize;
  data[34] = p.ps1.affineStrength;
  data[35] = p.ps1.colorDepth;

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
