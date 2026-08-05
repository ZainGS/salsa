/**
 * WGSL shaders for 3D mesh rendering — Cook-Torrance PBR + SH-based IBL.
 *
 * Lighting model (renderStyle == 0 "default"):
 *  - Cook-Torrance BRDF: GGX NDF + Smith geometry + Schlick Fresnel
 *  - Direct: single directional light (scene.lightDirection / lightColor)
 *  - Ambient (IBL off): constant ambient from scene.ambientColor
 *  - Ambient (IBL on):  SH L0+L1+L2 irradiance from ibl.shCoeffs (9 vec4<f32>)
 *
 * Render styles (bits 2-3 of material flags — see material-3d.ts):
 *  0 = default   Cook-Torrance PBR (replaces Phong/Gouraud)
 *  1 = cel       toon shading (stepped diffuse bands + hard specular)
 *  2 = sketch    crosshatch shading (pencil-drawn look)
 *  3 = ink       flat + silhouette rim darkening (manga look)
 *
 * Vertex format: position(vec3) + normal(vec3) + uv(vec2) + tangent(vec4) = 48 bytes
 *
 * Uniform layout:
 *  Bind group 0, binding 0: per-mesh instance storage buffer (model matrix, material, roughness, metalness)
 *  Bind group 0, binding 1: scene-wide uniform buffer (viewProj, camera, lights, PS1 params)
 *  Bind group 0, binding 2: IBL uniform buffer (SH coefficients, iblEnabled, iblIntensity)
 *  Bind group 1, binding 0: diffuse texture
 *  Bind group 1, binding 1: diffuse sampler
 *  Bind group 1, binding 2: normal map texture  (flat-normal 1×1 default when not set)
 *  Bind group 1, binding 3: normal map sampler
 */

import { STYLE_WGSL_FUNCTIONS } from './style-shaders';

// ── Shared PBR + IBL WGSL (included in both fragment shader variants) ──────

const PBR_IBL_WGSL = /* wgsl */`

struct IBLUniforms {
  shCoeffs:    array<vec4<f32>, 9>,  // L0+L1+L2 SH irradiance coefficients (rgb, w unused)
  iblEnabled:  f32,                  // 0 = off (use scene.ambientColor), 1 = on
  iblIntensity:f32,                  // scale multiplier
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(2) var<uniform> ibl: IBLUniforms;

const PBR_PI: f32 = 3.14159265359;

// GGX (Trowbridge-Reitz) normal distribution function
fn D_GGX(NdotH: f32, roughness: f32) -> f32 {
  let a  = roughness * roughness;
  let a2 = a * a;
  let d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PBR_PI * d * d);
}

// Smith-Schlick-GGX geometry term (one lobe)
fn G_SchlickGGX(NdotX: f32, roughness: f32) -> f32 {
  let k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  return NdotX / (NdotX * (1.0 - k) + k);
}

// Smith combined geometry (both view and light lobes)
fn G_Smith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  return G_SchlickGGX(max(NdotV, 0.0001), roughness) *
         G_SchlickGGX(max(NdotL, 0.0001), roughness);
}

// Schlick Fresnel approximation
fn F_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  let f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return F0 + (1.0 - F0) * f;
}

// Roughness-aware Fresnel for the ambient/environment specular term (rough surfaces don't get a harsh grazing rim).
fn F_SchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  let f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * f;
}

// Evaluate L0+L1+L2 SH irradiance.  Coefficients must be pre-multiplied by the
// Ramamoorthi & Hanrahan (2001) cosine-lobe ZH factors (baked CPU-side).
fn evalSHIrradiance(N: vec3<f32>) -> vec3<f32> {
  let x = N.x; let y = N.y; let z = N.z;
  // Normalization constants: Y00=0.2821, Y1x=0.4886, Y2-2/Y2-1/Y21=1.0925, Y20=0.3154, Y22=0.5463
  var e: vec3<f32> =
      0.282095 * ibl.shCoeffs[0].rgb
    + 0.488603 * (ibl.shCoeffs[1].rgb * y + ibl.shCoeffs[2].rgb * z + ibl.shCoeffs[3].rgb * x)
    + 1.092548 * (ibl.shCoeffs[4].rgb * (x*y) + ibl.shCoeffs[5].rgb * (y*z) + ibl.shCoeffs[7].rgb * (x*z))
    + 0.315392 *  ibl.shCoeffs[6].rgb * (3.0*z*z - 1.0)
    + 0.546274 *  ibl.shCoeffs[8].rgb * (x*x - y*y);
  return max(e, vec3<f32>(0.0));
}

// Specular environment reflection — what makes METAL read as metal (it reflects the surroundings tinted by F0
// instead of going black off the key light) and gives dielectrics a subtle grazing sheen. Modulated by a
// roughness-aware Fresnel.
//   IBL on:  the SH irradiance is diffuse-convolved (low-frequency), so it doubles as a soft reflection probe
//            sampled along the reflection vector R.
//   IBL off: a cheap FAKE environment so metals still look reflective out-of-the-box (not flat-dark) — a soft
//            sky/ground hemisphere (floored so it is never black) + the key light reflected as a soft sun glint.
//            (L = direction toward the light; lightColor/lightIntensity = the key light.)
fn envSpecular(N: vec3<f32>, V: vec3<f32>, F0: vec3<f32>, roughness: f32, NdotV: f32,
               iblOn: bool, iblIntensity: f32, ambientFlat: vec3<f32>,
               L: vec3<f32>, lightColor: vec3<f32>, lightIntensity: f32) -> vec3<f32> {
  let R = reflect(-V, N);
  var env: vec3<f32>;
  if (iblOn) {
    env = max(evalSHIrradiance(R), vec3<f32>(0.0)) * iblIntensity;
  } else {
    let envBase = max(ambientFlat, vec3<f32>(0.22));        // a floor so metal is lit, not black
    let up      = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);          // 0 = looking down (ground), 1 = up (sky)
    let sky     = envBase * mix(0.7, 1.3, up);               // hemisphere gradient → reflective variation
    let sun     = pow(max(dot(R, L), 0.0), 24.0);            // the key light reflected as a soft highlight
    env = sky + lightColor * lightIntensity * sun * 0.5;
  }
  return env * F_SchlickRoughness(NdotV, F0, roughness);
}

// Cheap GPU hash, vec3 cell -> vec3 in 0..1.
fn hash33(p: vec3<f32>) -> vec3<f32> {
  let q = vec3<f32>(dot(p, vec3<f32>(127.1, 311.7, 74.7)),
                    dot(p, vec3<f32>(269.5, 183.3, 246.1)),
                    dot(p, vec3<f32>(113.5, 271.9, 124.6)));
  return fract(sin(q) * 43758.5453);
}

// Procedural SPARKLE / glint — tiny per-cell micro-facets on the surface that FLASH when they happen to align with
// the light half-vector H. They scintillate as the camera / light move and twinkle slowly over time. Returns a
// white glint intensity. density = sparkle grain (cells per world unit); higher = finer flecks.
fn sparkleGlint(worldPos: vec3<f32>, N: vec3<f32>, H: vec3<f32>, time: f32, density: f32) -> f32 {
  let cell = floor(worldPos * density) + floor(vec3<f32>(time * 1.3));   // step the cells over time -> twinkle
  let jit  = hash33(cell) * 2.0 - 1.0;                                   // per-cell jitter in -1..1
  let micro = normalize(N + jit * 0.7);                                  // a jittered micro-normal
  let g = pow(max(dot(micro, H), 0.0), 220.0);                          // VERY tight -> a pinpoint glint
  let sparsity = smoothstep(0.6, 0.95, hash33(cell + 4.7).x);           // only some cells fire -> sparse flecks
  return g * sparsity;
}

// Anime STAR sparkle — bigger, sparser 4-point cross twinkles (the idol-bling look) vs the fine glint. Surface-
// aligned (a frame derived from N) so the stars sit on the metal; each fades in/out over time. No view dependence,
// so they pop on their own. Returns a white star intensity.
fn sparkleStar(worldPos: vec3<f32>, N: vec3<f32>, time: f32, density: f32) -> f32 {
  let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(N.y) > 0.9);
  let tu = normalize(cross(N, up));
  let tv = cross(N, tu);
  let cell = floor(worldPos * density) + floor(vec3<f32>(time * 0.8));   // step cells over time -> twinkle
  let r = hash33(cell);
  let fire = step(0.86, r.x);                                            // sparse: only ~14 percent of cells
  let lc = fract(worldPos * density) - vec3<f32>(0.5);
  let x = dot(lc, tu); let y = dot(lc, tv);                             // surface-plane local coords within the cell
  let rayX = max(0.0, 1.0 - abs(y) / 0.07) * max(0.0, 1.0 - abs(x) / 0.5);
  let rayY = max(0.0, 1.0 - abs(x) / 0.07) * max(0.0, 1.0 - abs(y) / 0.5);
  let star = max(rayX, rayY);                                            // a plus-shaped cross
  let twinkle = 0.5 + 0.5 * sin(time * 5.0 + r.y * 6.2832);
  return star * star * fire * twinkle;                                  // star^2 sharpens the rays
}

// Procedural geometric PATTERN mask (0..1) over the garment UV, ANALYTICALLY ANTIALIASED with fwidth so it stays
// crisp up close and resolves to the correct average at distance (no shimmer/moire). mode: 1 stripes · 2 dots ·
// 3 diamonds · 4 checker · 5 grid · 6 windows (handled by windowsPattern below) · 7 animated waves.
// params = (freq, angleRad, scale, spacing). albedo = mix(primary, secondary, mask). time = scene seconds.
fn patternMask(uv: vec2<f32>, mode: u32, params: vec4<f32>, time: f32) -> f32 {
  let freq = max(params.x, 0.001);
  let ca = cos(params.y); let sa = sin(params.y);
  let cc = uv - vec2<f32>(0.5);
  let p = vec2<f32>(cc.x * ca - cc.y * sa, cc.x * sa + cc.y * ca) * freq;   // rotated, scaled UV
  let dp = fwidth(p);                                  // screen-space change → AA width (computed before the branch)
  let w = max(dp.x, dp.y) + 1e-5;
  let scale = clamp(params.z, 0.02, 0.98);
  if (mode == 1u) {                                    // stripes
    return 1.0 - smoothstep(scale * 0.5 - w, scale * 0.5 + w, abs(fract(p.x) - 0.5));
  } else if (mode == 2u) {                             // dots
    return 1.0 - smoothstep(scale * 0.5 - w, scale * 0.5 + w, length(fract(p) - vec2<f32>(0.5)));
  } else if (mode == 3u) {                             // diamonds
    let cell = abs(fract(p) - vec2<f32>(0.5));
    return 1.0 - smoothstep(scale - w, scale + w, cell.x + cell.y);
  } else if (mode == 4u) {                             // checker
    let q = floor(p);
    return abs((q.x + q.y) - 2.0 * floor((q.x + q.y) * 0.5));
  } else if (mode == 5u) {                             // grid lines (spacing > 0.5 = SHINGLE variant, see below)
    var q = p;
    let shingle = params.w > 0.5;
    if (shingle) { q.x = q.x + step(0.5, fract(q.y * 0.5)) * 0.5; }   // stagger alternate rows half a cell (running bond)
    let cell = abs(fract(q) - vec2<f32>(0.5));
    let lw = scale * 0.5;
    var m = max(smoothstep(0.5 - lw - w, 0.5 - lw + w, cell.x), smoothstep(0.5 - lw - w, 0.5 - lw + w, cell.y));
    if (shingle) {
      // SHINGLE realism: the HORIZONTAL course line dominates (each row shadows the one below), vertical
      // joints stay subtle; every tile gets a hash shade; and a two-scale WEATHERING MOTTLE (large soft
      // patches + mid clusters) breaks the tiling so big roofs stop reading as one repeated texture.
      let courseShadow = smoothstep(0.5 - lw * 1.6 - w, 0.5 - lw * 0.4, cell.y) * 0.55;
      let id = floor(q);
      let tile = fract(sin(id.x * 127.1 + id.y * 311.7) * 43758.5453) - 0.5;
      let mot1 = fract(sin(dot(floor(q * 0.09), vec2<f32>(26.7, 63.1))) * 9157.33) - 0.5;
      let mot2 = fract(sin(dot(floor(q * 0.27), vec2<f32>(71.9, 13.7))) * 5417.11) - 0.5;
      m = clamp(m + courseShadow + tile * 0.34 + mot1 * 0.30 + mot2 * 0.18, 0.0, 1.0);
    }
    return m;
  } else if (mode == 7u) {                             // ANIMATED WAVES — big screens / water. spacing = scroll speed.
    // scale picks the WAVEFORM: <0.35 soft drifting bands (the wavy-bg vibe) · <0.65 zigzag sweep · else blocky
    // glitch scanlines — so a wall of screens can run visibly different animations from one shader mode.
    let spd = params.w;
    let ph = p.x + sin(p.y * 1.9 + time * spd * 0.7) * 0.7 + sin(p.y * 0.6 - time * spd * 0.23) * 0.5 - time * spd;
    if (scale < 0.35) { return 0.5 + 0.5 * sin(ph * 3.1416); }
    let tri = abs(fract(ph) - 0.5) * 2.0;
    if (scale < 0.65) { return tri * tri * (3.0 - 2.0 * tri); }
    return step(0.5, fract(ph * 2.0 + tri * 0.4));
  }
  if (mode == 6u) {
    // windows: the OPENING mask (inset rectangle per cell), so the FS relief gradient can bevel the reveal.
    // Uses windowsPattern's UNROTATED convention (uv*freq) so the groove aligns to the real window cells; for
    // mode 6 params.y is wallStyle (not an angle), so the rotated p above must not drive the window grid.
    let pw = uv * freq;
    let fw = fract(pw);
    let ins = clamp(params.z, 0.05, 0.45);
    let iwx = smoothstep(ins - w, ins + w, fw.x) * (1.0 - smoothstep(1.0 - ins - w, 1.0 - ins + w, fw.x));
    let iwy = smoothstep(ins - w, ins + w, fw.y) * (1.0 - smoothstep(1.0 - ins - w, 1.0 - ins + w, fw.y));
    return iwx * iwy;
  }
  return 0.0;
}

// WINDOWS pattern (mode 6): the UV grid becomes window CELLS (inset rectangles) and a per-cell hash decides
// which are LIT. Returns (isWindow, isLit, wallShade, 0). params = (freq, wallStyle, inset 0..0.45, lit fraction
// 0..1) — wallStyle < 0.5 = running-bond BRICK courses, else CONCRETE panel speckle: a per-texel albedo
// multiplier for the wall BETWEEN the windows, so facades read as material instead of flat paint up close.
// The lit set slowly reshuffles over scene time. Wall UVs are world-proportional (walls()).
fn windowsPattern(uv: vec2<f32>, params: vec4<f32>, time: f32) -> vec4<f32> {
  let freq = max(params.x, 0.001);
  let p = uv * freq;
  let cell = floor(p);
  let f = fract(p);
  let ws = params.y;                                   // FACADE TYPE: 0 brick · 1 concrete · 2 CURTAIN wall · 3 RIBBON
  let inset = clamp(params.z, 0.05, 0.45);
  let dp = fwidth(p);
  let w = max(dp.x, dp.y) + 1e-4;
  // glazing MASK insets vary by facade type: masonry = punched windows; curtain = thin mullions (near-full glass
  // panels); ribbon = thin VERTICAL mullions + tall spandrel bands (continuous horizontal glazing strips).
  var insetX = inset; var insetY = inset;
  if (ws < 1.5) { insetX = max(inset, 0.2); insetY = insetX * 0.5; }   // masonry: PORTRAIT windows (tall rectangles, not squares)
  if (ws > 1.5 && ws < 2.5) { insetX = 0.05; insetY = 0.05; }
  if (ws > 2.5) { insetX = 0.04; insetY = 0.22; }
  let inX = smoothstep(insetX - w, insetX + w, f.x) * (1.0 - smoothstep(1.0 - insetX - w, 1.0 - insetX + w, f.x));
  let inY = smoothstep(insetY - w, insetY + w, f.y) * (1.0 - smoothstep(1.0 - insetY - w, 1.0 - insetY + w, f.y));
  let slot = floor(time * 0.02);                       // the lit set drifts every ~50 s
  let h = fract(sin(dot(cell + vec2<f32>(slot), vec2<f32>(127.1, 311.7))) * 43758.5453);
  let litFrac = clamp(params.w, 0.0, 1.0);
  // CURTAIN towers light whole FLOORS (per-row hash → glowing horizontal floor bands, the NTE glass-tower look);
  // masonry lights individual windows (per-cell hash).
  let hRow = fract(sin((cell.y + slot) * 91.7 + 12.3) * 43758.5453);
  let lit = select(step(1.0 - litFrac, h), step(1.0 - litFrac, hRow), ws > 1.5 && ws < 2.5);
  // BRICK: realistically SMALL running-bond bricks (≈1/8 of a window cell wide) with LIGHT mortar joints and a
  // per-brick tint spread — the red-brick/rowhouse look. fwidth-AA'd so it settles to a clean average far away.
  let bc = vec2<f32>(p.x * 8.0, p.y * 18.0);
  let brow = floor(bc.y);
  let bx = bc.x + fract(brow * 0.5);                   // running bond: alternate rows shift half a brick
  let bf = vec2<f32>(fract(bx), fract(bc.y));
  let db = fwidth(bc);
  let mw = vec2<f32>(max(db.x * 1.5, 0.08), max(db.y * 1.5, 0.14));
  let brickMask = min(smoothstep(0.0, mw.x, bf.x) * (1.0 - smoothstep(1.0 - mw.x, 1.0, bf.x)),
                      smoothstep(0.0, mw.y, bf.y) * (1.0 - smoothstep(1.0 - mw.y, 1.0, bf.y)));
  let btint = fract(sin(dot(vec2<f32>(floor(bx), brow), vec2<f32>(41.3, 289.1))) * 34761.77);
  // Joints DARKER + brick faces LIGHTER — PAINT polarity matches the RELIEF (mortar recessed/dark, brick proud/
  // light) so they REINFORCE into one coherent 3-D brick instead of competing. Restored the per-brick tint spread
  // (0.14) + a bit more contrast than the muddy first attempt so individual bricks read crisply, not blurry.
  let brick = mix(0.85, 1.0 + 0.14 * btint, brickMask);
  // CONCRETE: large panels with faint seams + per-panel value speckle (office/civic).
  let cpan = p * vec2<f32>(1.0, 1.5);
  let cf = vec2<f32>(fract(cpan.x), fract(cpan.y));
  let dc = fwidth(cpan);
  let cw = vec2<f32>(max(dc.x * 1.5, 0.02), max(dc.y * 1.5, 0.03));
  let seam = min(smoothstep(0.0, cw.x, cf.x) * (1.0 - smoothstep(1.0 - cw.x, 1.0, cf.x)),
                 smoothstep(0.0, cw.y, cf.y) * (1.0 - smoothstep(1.0 - cw.y, 1.0, cf.y)));
  let conc = mix(0.9, 1.0, seam) * (0.96 + 0.06 * fract(sin(dot(floor(cpan), vec2<f32>(12.99, 78.23))) * 43758.5453));
  var shade = select(brick, conc, ws >= 0.5);
  // STONE PLINTH: the ground-floor band (below the first window row) reads as a darker masonry base course.
  let plinth = 1.0 - smoothstep(0.85, 1.0, p.y);
  shade = mix(shade, min(shade, 1.0) * 0.8, plinth * 0.9);
  // WINDOW FRAME: a light stone SILL below + HEADER above + thin JAMBS at the sides, hugging each opening — so a
  // window reads as a framed window, not a hole. (Masonry only — curtain/ribbon override the shade below.)
  let onBot  = inX * (1.0 - smoothstep(0.0, 0.055, abs(f.y - insetY)));
  let onTop  = inX * (1.0 - smoothstep(0.0, 0.045, abs(f.y - (1.0 - insetY))));
  let onSide = inY * (1.0 - smoothstep(0.0, 0.03, min(abs(f.x - insetX), abs(f.x - (1.0 - insetX)))));
  let frame  = clamp(max(max(onBot, onTop * 0.7), onSide * 0.55), 0.0, 1.0) * (1.0 - inX * inY);
  shade = mix(shade, 1.24, frame * 0.85 * (1.0 - plinth));
  // CURTAIN / RIBBON override the between-glass shade: curtain = clean metal MULLION grid (no masonry/plinth/sill);
  // ribbon = solid SPANDREL bands in the wall colour (the horizontal strips between glazing).
  if (ws > 1.5) { shade = select(0.58, 1.0, ws > 2.5); }
  return vec4<f32>(inX * inY, lit, shade, 0.0);
}

// Structured MASONRY HEIGHT for the wall BETWEEN the windows (facade relief normal). Returns 0..1 where the brick
// faces / concrete panel faces stand PROUD and the mortar joints / panel seams RECESS, so a facade reads as real
// material instead of flat paint. NO fwidth (fixed joint widths) — the FS samples this at a fine FIXED eps, so it
// stays uniform-safe in a possibly-batched draw, and the eps is brick-scale (finer than the window-cell relief eps
// which is too coarse to resolve courses). wallStyle (params.y): <0.5 running-bond BRICK · <1.5 CONCRETE/precast
// panels · else curtain / ribbon (a flat glass skin, no relief).
fn wallMasonryH(uv: vec2<f32>, params: vec4<f32>) -> f32 {
  let freq = max(params.x, 0.001);
  let pw = uv * freq;
  let ws = params.y;
  if (ws < 0.5) {
    // BRICK: full running-bond relief — bed joints (horizontal) AND head joints (vertical) recessed, brick faces
    // proud, so it reads as real 3-D brick. ★ The cell math MUST MATCH windowsPattern's albedo bricks EXACTLY
    // (bc = (p.x*8, p.y*18), half-brick row offset fract(brow*0.5), p = uv*freq) so every groove lands on a
    // painted mortar line. The earlier "basket-weave" was a course MOIRÉ (relief 14 vs albedo 18) + a coarse eps
    // undersampling the courses — both fixed here (exact 8x18 match + the finer FS eps).
    let bc = vec2<f32>(pw.x * 8.0, pw.y * 18.0);
    let brow = floor(bc.y);
    let bx = bc.x + fract(brow * 0.5);                                // running bond: alternate rows shift half a brick
    let bf = vec2<f32>(fract(bx), fract(bc.y));
    // Joint widths MATCHED to windowsPattern's albedo mortar (mw floors 0.08 x / 0.14 y) so the relief groove and
    // the painted mortar band are the SAME width + position — one line, not a thin groove inside a fat paint band.
    let hx = smoothstep(0.0, 0.08, bf.x) * (1.0 - smoothstep(0.92, 1.0, bf.x));   // head joint (vertical)
    let hy = smoothstep(0.0, 0.14, bf.y) * (1.0 - smoothstep(0.86, 1.0, bf.y));   // bed joint (horizontal)
    return min(hx, hy);                                               // brick FACE proud, ANY joint recessed
  }
  if (ws < 1.5) {
    // Concrete / precast panels — the panel FACE proud, the seams recessed. A DENSER panel grid (was 1x1.5) +
    // full depth (was 0.7) so grey/stone facades read as material like the brick ones, not flat paint.
    let cpan = pw * vec2<f32>(2.0, 3.0);
    let cf = vec2<f32>(fract(cpan.x), fract(cpan.y));
    let seam = min(smoothstep(0.0, 0.05, cf.x) * (1.0 - smoothstep(0.95, 1.0, cf.x)),
                   smoothstep(0.0, 0.06, cf.y) * (1.0 - smoothstep(0.94, 1.0, cf.y)));
    return seam;
  }
  return 0.0;
}

// ── INTERIOR MAPPING ────────────────────────────────────────────────────────────
// Raycast a fake unit ROOM behind a window opening (the Spider-Man / Cities: Skylines trick): the view ray
// enters at the glass plane and hits the back wall / floor / ceiling / side walls of a virtual box, giving
// true PARALLAX depth per window for zero geometry. Hashed per room: depth, warm-home vs cool-office light,
// a furniture silhouette band and wall hangings on the back wall. No fwidth inside → safe in branches.
fn interiorRoom(win: vec2<f32>, rd0: vec3<f32>, seed: f32, time: f32) -> vec3<f32> {
  let h1 = fract(sin(seed * 12.9898) * 43758.5453);              // depth
  let h2 = fract(h1 * 91.17 + 0.37);                             // room TYPE (warm home vs cool office)
  let h3 = fract(h2 * 137.31 + 0.71);                            // dressing (blinds / curtains / TV)
  let depth = 1.3 + h1 * 1.4;                                    // room depth, in half-window units
  let office = h2 > 0.55;

  // WINDOW DRESSING at the glass plane: 18% horizontal BLINDS (slat stripes), 16% side CURTAINS.
  let blinds = step(0.82, h3);
  let curtains = step(0.66, h3) * (1.0 - blinds);
  let blindMask = blinds * smoothstep(0.35, 0.65, fract(win.y * 7.0));
  let curtainMask = curtains * (1.0 - smoothstep(0.14, 0.30, min(win.x, 1.0 - win.x)));

  var rd = rd0;
  rd.z = min(rd.z, -0.08);                                       // guard grazing rays
  let ro = vec3<f32>(win * 2.0 - 1.0, 0.0);
  let tx = (select(-1.0, 1.0, rd.x > 0.0) - ro.x) / rd.x;
  let ty = (select(-1.0, 1.0, rd.y > 0.0) - ro.y) / rd.y;
  let tz = -depth / rd.z;
  let t = min(tx, min(ty, tz));
  let hit = ro + rd * t;
  let tint = select(vec3<f32>(1.0, 0.80, 0.55), vec3<f32>(0.80, 0.88, 1.0), office);

  var c = tint * 0.48;                                           // side walls…
  if (office && t < tz - 1e-4 && t < ty - 1e-4) {
    // …offices get SHELF rows on the side walls (horizontal darker bands with depth)
    c = c * mix(0.62, 1.0, smoothstep(0.1, 0.28, abs(fract(hit.y * 1.6) - 0.5)));
  }
  if (t >= tz - 1e-4) {
    if (office) {
      // OFFICE back wall: a cubicle/desk band + a row of small MONITOR glows above it
      let desk = smoothstep(0.1, -0.2, hit.y);
      c = tint * mix(0.68, 0.30, desk);
      let mcol = fract(hit.x * 2.6 + seed);
      let mrow = smoothstep(0.02, 0.12, hit.y) * (1.0 - smoothstep(0.22, 0.32, hit.y));
      let monOn = step(0.5, fract(sin(floor(hit.x * 2.6 + seed) * 47.3) * 761.7));
      let mon = monOn * step(0.3, mcol) * (1.0 - step(0.7, mcol)) * mrow;
      c = mix(c, vec3<f32>(0.55, 0.85, 1.0) * 1.6, mon);
    } else {
      // HOME back wall: sofa band + hashed wall hangings; ~35% have a flickering TV
      let band = smoothstep(0.15, -0.25, hit.y);
      let pic = fract(sin(dot(floor(hit.xy * 1.8 + vec2<f32>(seed)), vec2<f32>(31.7, 71.3))) * 4571.7);
      c = tint * mix(0.72, 0.28, band) * (0.8 + 0.35 * pic);
      let tvOn = step(0.65, fract(h3 * 51.7));
      let tv = tvOn * step(abs(hit.x + 0.25), 0.28) * step(abs(hit.y - 0.12), 0.2);
      let flick = 0.75 + 0.25 * sin(time * 9.0 + seed * 6.28) * sin(time * 23.0 + seed);
      c = mix(c, vec3<f32>(0.6, 0.7, 1.0) * (1.2 * flick), tv);
    }
  } else if (t >= ty - 1e-4 && rd.y > 0.0) {
    // CEILING: offices get repeating strip fixtures; homes one round fixture near the centre
    var fix = max(0.0, 1.0 - length(hit.xz) * 0.8);
    if (office) { fix = step(abs(fract(hit.x * 1.4) - 0.5), 0.12) * step(abs(hit.z * 0.5), 0.6); }
    c = tint * (0.6 + 0.7 * fix);
  } else if (t >= ty - 1e-4) {
    // FLOOR: warm wood in homes, grey carpet in offices
    c = select(tint * vec3<f32>(0.52, 0.38, 0.26), tint * 0.30, office);
  }
  var room = c / (1.0 + t * 0.45);                               // deep rooms fall off
  room = mix(room, tint * 0.22, clamp(blindMask + curtainMask, 0.0, 1.0));   // dressing occludes the view
  return room;
}

struct WinShade { base: vec3<f32>, emk: vec3<f32> }

// Window-cell SURFACE: wall shade outside the opening; inside it, the interior-mapped room seen through the
// glass — faint behind dark day glass, GLOWING per-texel when the cell is lit (the glow itself carries the
// room's parallax: bright ceilings, dark furniture bands). Tangent frame derived from the wall normal.
fn windowShade(uv: vec2<f32>, params: vec4<f32>, winWL: vec4<f32>, worldPos: vec3<f32>, N0: vec3<f32>,
               camPos: vec3<f32>, diffuse: vec3<f32>, patCol: vec3<f32>, emisIn: vec3<f32>, time: f32) -> WinShade {
  let freq = max(params.x, 0.001);
  let p = uv * freq;
  let cell = floor(p);
  let f = fract(p);
  let inset = clamp(params.z, 0.05, 0.45);
  let winUV = clamp((f - vec2<f32>(inset)) / max(1.0 - 2.0 * inset, 1e-3), vec2<f32>(0.0), vec2<f32>(1.0));
  let N = normalize(N0);
  var T = cross(vec3<f32>(0.0, 1.0, 0.0), N);
  let tl = length(T);
  T = select(vec3<f32>(1.0, 0.0, 0.0), T / max(tl, 1e-4), tl > 1e-3);
  let B = cross(N, T);
  let Vv = normalize(camPos - worldPos);
  let rd = vec3<f32>(-dot(Vv, T), -dot(Vv, B), -dot(Vv, N));     // the view ray INTO the room
  let seed = dot(cell, vec2<f32>(7.13, 3.71)) + freq;
  let room = interiorRoom(winUV, rd, seed, time);
  // curtain / ribbon (params.y > 1.5) use lighter, cleaner glass (a modern glazed skin) vs masonry punched-window glass.
  let glass = select(vec3<f32>(0.09, 0.10, 0.13), vec3<f32>(0.20, 0.27, 0.36), params.y > 1.5);
  // DAY interior: desaturate the room so it reads as dim glass, not a glowing yellow square (the warm home tint was
  // showing through as a yellow block). NIGHT (lit) keeps the full warm glow.
  let roomDay = mix(room, vec3<f32>(dot(room, vec3<f32>(0.34, 0.5, 0.16))), 0.5);
  let unlitC = mix(glass, roomDay, 0.32);                        // faint, subdued interior behind day glass
  let litC = mix(room, patCol, 0.2) * 1.1;                       // warm-lit interior (night)
  var o: WinShade;
  // WALL GRAIN: a world-stable micro value noise over the masonry (NOT the glass) — subtle roughness.
  let grain = 0.94 + 0.12 * fract(sin(dot(floor(uv * 300.0), vec2<f32>(12.9898, 78.233))) * 43758.5453);
  // The between-glass colour: masonry = the wall colour + grain; CURTAIN = a clean METAL mullion (grey, no grain);
  // ribbon = the solid spandrel in the wall colour (no grain).
  let isCurtain = params.y > 1.5 && params.y < 2.5;
  let g = select(grain, 1.0, params.y > 1.5);
  let wallCol = select(diffuse, vec3<f32>(0.50, 0.52, 0.56), isCurtain) * winWL.z * g;
  o.base = mix(wallCol, mix(unlitC, litC, winWL.y), winWL.x);
  let roomLum = dot(room, vec3<f32>(0.35, 0.5, 0.15));
  o.emk = emisIn * mix(winWL.z, mix(0.35, 1.6 + roomLum * 3.4, winWL.y), winWL.x);
  return o;
}

// ── PAPERBOARD GRAIN (packaging boardShade) — fine paper TOOTH (the original two-scale value noise
//    at a raised frequency so it reads as fine grain rather than a coarse grid) plus smooth
//    directional machine-direction fibre STREAKS. Returns a multiplicative shade around 1.0;
//    amp = patternColor.a (white 0.06, kraft 0.16). ──
fn pg_hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}
fn pg_vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);                    // smoothstep interpolation → organic, NO grid
  let a = pg_hash21(i + vec2<f32>(0.0, 0.0));
  let b = pg_hash21(i + vec2<f32>(1.0, 0.0));
  let c = pg_hash21(i + vec2<f32>(0.0, 1.0));
  let d = pg_hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn paperGrain(uv: vec2<f32>, amp: f32) -> f32 {
  // Fine paper TOOTH — the original two-scale value noise, frequency RAISED for the box net so it
  // reads as fine grain, not a coarse grid. No flecks/specks (they read as square dots on the box).
  let f1 = fract(sin(dot(floor(vec2<f32>(uv.x * 780.0, uv.y * 150.0)), vec2<f32>(12.9898, 78.233))) * 43758.5453);
  let f2 = fract(sin(dot(floor(vec2<f32>(uv.x * 165.0, uv.y * 700.0)), vec2<f32>(39.3468, 11.135)))  * 24634.6345);
  let tooth = (f1 - 0.5) + (f2 - 0.5) * 0.6;
  // Directional machine-direction fibre streaks (smooth, anisotropic — fibres run lengthwise).
  let streak = (pg_vnoise(vec2<f32>(uv.x * 130.0, uv.y * 9.0)) - 0.5) * 0.5;
  return 1.0 + (tooth + streak) * amp;
}

// == PROCEDURAL GROUND (groundShade, bit 18) — P1 ASHLAR LIMESTONE ==============================
// A shader-generated stone-paver floor. Reuses pg_hash21 / pg_vnoise above. NO textures. Returns
// per-fragment albedo + a height field (for the relief normal) + a roughness. Kept cheap: no Voronoi,
// just a running-bond rectangular tiler + a couple of value-noise octaves.
struct GroundOut {
  rgb: vec3<f32>,
  height: f32,
  rough: f32,
  grout: f32,
};
// Compact RGB<->HSV (IQ) so per-tile jitter can nudge hue/sat/value, not just brightness.
fn gr_rgb2hsv(c: vec3<f32>) -> vec3<f32> {
  let K = vec4<f32>(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4<f32>(c.b, c.g, K.w, K.z), vec4<f32>(c.g, c.b, K.x, K.y), step(c.b, c.g));
  let q = mix(vec4<f32>(p.x, p.y, p.w, c.r), vec4<f32>(c.r, p.y, p.z, p.x), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1e-10;
  return vec3<f32>(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
fn gr_hsv2rgb(c: vec3<f32>) -> vec3<f32> {
  let K = vec4<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(vec3<f32>(c.x, c.x, c.x) + K.xyz) * 6.0 - vec3<f32>(K.w, K.w, K.w));
  return c.z * mix(vec3<f32>(K.x, K.x, K.x), clamp(p - vec3<f32>(K.x, K.x, K.x), vec3<f32>(0.0), vec3<f32>(1.0)), c.y);
}
// ★ METRIC SPACE — world METRES per UV unit, along u and v, recovered from screen-space derivatives
// (the standard cotangent-frame solve). Every ground tiler works in metres rather than UV because of two
// bugs that share this root cause:
//   (a) ANISOTROPIC GROUT — an edge distance in uv-u and one in uv-v were compared against a single grout
//       width, so on any mesh whose uv->world scale differs per axis (a stretched cube, a non-square
//       plane) the row seams rendered thicker than the column seams.
//   (b) ARBITRARY TILE SIZE — mm->uv used a caller-declared extentMeters that defaulted to 20, so
//       applying the material to a mesh that never declares its size produced whatever density a
//       fictional 20 m plane implied, then stretched it by the mesh's scale.
// Deriving the scale here fixes both AND removes the need for the caller to declare anything: a 600 mm
// paver is 600 mm on a plane, on a cube face, at any non-uniform scale. tile/grout params are METRES.
// Degenerate uv (det ~ 0, e.g. a fully collapsed uv triangle) falls back to 1 m per uv unit.
// ⚠ dpdx/dpdy require UNIFORM control flow — call this at fragment top level, never inside the
// groundShade branch (same rule the fwidth-using patternMask calls already follow).
fn gr_uvMetres(uv: vec2<f32>, worldPos: vec3<f32>) -> vec2<f32> {
  let dpx = dpdx(worldPos);
  let dpy = dpdy(worldPos);
  let dux = dpdx(uv);
  let duy = dpdy(uv);
  let det = dux.x * duy.y - dux.y * duy.x;
  if (abs(det) < 1e-12) { return vec2<f32>(1.0, 1.0); }
  let inv = 1.0 / det;
  let dPdu = (dpx * duy.y - dpy * dux.y) * inv;
  let dPdv = (dpy * dux.x - dpx * duy.x) * inv;
  return vec2<f32>(clamp(length(dPdu), 1e-3, 1e5), clamp(length(dPdv), 1e-3, 1e5));
}
// The ASHLAR tiler: which paver owns this point, and the distance to its nearest border — all in METRES
// (p = uv * gr_uvMetres). Returns (colId, rowId, edgeDistMetres). Rows alternate a half-tile offset
// (running bond), so row N+1's vertical seams land at the MIDPOINT of row N's pavers — that mid-tile
// line is the bond, not an artifact.
fn groundCell(p: vec2<f32>, tileW: f32, tileH: f32) -> vec3<f32> {
  let tw = max(tileW, 1e-4);
  let th = max(tileH, 1e-4);
  let row = floor(p.y / th);
  let odd = row - 2.0 * floor(row * 0.5);          // 0 or 1
  let u = p.x + odd * tw * 0.5;                     // running-bond half-offset on odd rows
  let col = floor(u / tw);
  let lx = fract(u / tw);
  let ly = fract(p.y / th);
  let edgeU = min(lx, 1.0 - lx) * tw;              // metres to the L/R border
  let edgeV = min(ly, 1.0 - ly) * th;             // metres to the T/B border — same units as edgeU now
  return vec3<f32>(col, row, min(edgeU, edgeV));
}
// Cheap height-only field from a cell id + edge distance (no colour math) so the ±eps relief samples
// stay light. Shared by ALL tilers (ashlar/radial/border) via groundHeightM.
fn gr_cellHeight(cellId: vec2<f32>, edge: f32, groutW: f32) -> f32 {
  let groutMask = 1.0 - smoothstep(groutW * 0.8, groutW * 1.2, edge);
  let wear = (1.0 - groutMask) * (1.0 - smoothstep(groutW, groutW * 3.5, edge));
  var h = (pg_hash21(cellId + vec2<f32>(5.7, 2.3)) - 0.5) * 0.5;   // per-tile height ~ +/- 3mm-ish
  return h - groutMask * 1.0 + wear * 0.3;                         // grout recess + rounded edge bevel
}
// Shade ONE stone cell — per-tile jitter + macro cloud + grain + pits + grout + edge-wear + height +
// roughness. The P1 machinery, factored out so the radial + border tilers reuse it verbatim (only the
// cell-id / edge-distance differs — §3). cellId identifies the stone; edge = uv distance to its border.
fn gr_shadeCell(p: vec2<f32>, base: vec3<f32>, grout: vec3<f32>, groutW: f32, jitter: f32,
                cellId: vec2<f32>, edge: f32) -> GroundOut {
  // GROUT + EDGE WEAR masks — computed FIRST so the pit term below can be gated by them (a pit that
  // straddles a seam reads as a rendering error, not as stone).
  let groutMask = 1.0 - smoothstep(groutW * 0.8, groutW * 1.2, edge);
  let wear = (1.0 - groutMask) * (1.0 - smoothstep(groutW, groutW * 3.5, edge));
  // PER-TILE jitter — brightness +/-8%, hue +/-2deg, sat +/-5%; neighbours never identical.
  let h1 = pg_hash21(cellId + vec2<f32>(0.13, 0.71));
  let h2 = pg_hash21(cellId * 1.7 + vec2<f32>(4.2, 1.1));
  let h3 = pg_hash21(cellId * 2.3 + vec2<f32>(9.1, 3.3));
  var hsv = gr_rgb2hsv(base);
  hsv.x = fract(hsv.x + (h2 - 0.5) * (2.0 / 360.0) * 2.0 * jitter);
  hsv.y = clamp(hsv.y * (1.0 + (h3 - 0.5) * 0.10 * jitter), 0.0, 1.0);
  hsv.z = clamp(hsv.z * (1.0 + (h1 - 0.5) * 0.16 * jitter), 0.0, 1.0);
  var col = gr_hsv2rgb(hsv);
  // MACRO cloud — very-low-freq drift kills tiled-floor uniformity (some areas yellower/darker).
  // Frequencies are now CYCLES PER METRE, so feature size is physical and identical on every mesh.
  let cloud = pg_vnoise(p * 0.15) - 0.5;
  col = col * (1.0 + cloud * 0.10);
  // MICRO grain.
  let grain = pg_vnoise(p * 11.0) - 0.5;
  col = col * (1.0 + grain * 0.05);
  // PITS — sparse shallow chips in the stone. Previously floor(uv * 160) + a hard step(), which darkened
  // a WHOLE grid cell to 55%: on a 20 m plane that is a 12 cm axis-aligned black SQUARE that also ran
  // straight through the grout. Now 2.5 cm cells with a round soft-edged falloff, and multiplied by
  // (1 - groutMask) so pitting stops at the seam.
  let pc = p * 40.0;                                     // 2.5 cm cells
  let ph = pg_hash21(floor(pc));
  let pd = 1.0 - smoothstep(0.10, 0.34, length(fract(pc) - vec2<f32>(0.5)));
  let pitAmt = step(0.985, ph) * pd * (1.0 - groutMask);
  col = col * mix(1.0, 0.72, pitAmt);
  col = mix(col, col * 1.12, wear * 0.6);          // polished edge is brighter
  col = mix(col, grout, groutMask);                // recessed seam colour
  // HEIGHT (per-tile + grout recess + edge bevel) and ROUGHNESS.
  var h = (pg_hash21(cellId + vec2<f32>(5.7, 2.3)) - 0.5) * 0.5;
  h = h - groutMask * 1.0 + wear * 0.3;
  var rough = 0.55 + (pg_hash21(cellId + vec2<f32>(2.1, 8.4)) - 0.5) * 0.10;  // 0.45..0.65 per tile
  rough = rough + groutMask * 0.25 - wear * 0.15;                             // +grout, -worn edge
  var o: GroundOut;
  o.rgb = col;
  o.height = h;
  o.rough = clamp(rough, 0.04, 1.0);
  o.grout = groutMask;
  return o;
}
// ASHLAR (mode 0): running-bond rectangular pavers — the P1 courtyard field. Thin wrapper over gr_shadeCell.
// p = metric surface coords (metres); tileW/tileH/groutW are metres too.
fn groundAshlar(p: vec2<f32>, base: vec3<f32>, grout: vec3<f32>, groutW: f32,
                tileW: f32, tileH: f32, jitter: f32) -> GroundOut {
  let c = groundCell(p, tileW, tileH);
  return gr_shadeCell(p, base, grout, groutW, jitter, vec2<f32>(c.x, c.y), c.z);
}

// == PROCEDURAL GROUND P2 — WEATHERING MASKS + PROFILES (procedural-ground.md §5) ================
// Usage-biased aging layered OVER the P1 ashlar output — the #1 walked-on realism cue. Four cheap
// per-fragment masks from uv (reuse pg_vnoise / pg_hash21, capped octaves). Each is a small fn so the
// P5 scatter pass can mirror the CPU formula later (CPU-side equivalent = future work). One PROFILE
// knob scales all four contributions → five looks.
fn gr_fbm2(p: vec2<f32>) -> f32 {
  // 2-octave value noise — organic low-freq usage field. Cheap.
  return pg_vnoise(p) * 0.65 + pg_vnoise(p * 2.3 + vec2<f32>(7.1, 3.7)) * 0.35;
}
// edgeMask: 1 at the region/UV border, 0 interior; .y = CORNER extreme (near TWO borders at once).
// CPU-side equivalent (future): signed distance to the zone polygon border.
fn gr_edgeMask(uv: vec2<f32>) -> vec2<f32> {
  let dx = min(uv.x, 1.0 - uv.x);
  let dy = min(uv.y, 1.0 - uv.y);
  let band = 0.16;
  let edge = 1.0 - smoothstep(0.0, band, min(dx, dy));
  let ex = 1.0 - smoothstep(0.0, band, dx);
  let ey = 1.0 - smoothstep(0.0, band, dy);
  return vec2<f32>(clamp(edge, 0.0, 1.0), clamp(ex * ey, 0.0, 1.0));
}
// wearMask: the walked-on field — low-freq usage noise OR an explicit wear PATH (center pc + radius pr;
// pr 0 = noise only). CPU-side equivalent (future): distance to the world graph's path splines (§5).
fn gr_wearMask(uv: vec2<f32>, pc: vec2<f32>, pr: f32) -> f32 {
  let noiseWear = smoothstep(0.52, 0.9, gr_fbm2(uv * 2.2 + vec2<f32>(1.3, 4.8)));
  var pathWear = 0.0;
  if (pr > 1e-4) {
    pathWear = 1.0 - smoothstep(pr * 0.5, pr, distance(uv, pc));   // bright smooth worn track
  }
  return clamp(max(noiseWear * 0.7, pathWear), 0.0, 1.0);
}
// moistureMask: edge + low-freq noise, lifted into the grout seams → moss tint.
fn gr_moistMask(uv: vec2<f32>, edge: f32, groutMask: f32) -> f32 {
  let n = gr_fbm2(uv * 1.6 + vec2<f32>(9.2, 2.1));
  let m = clamp(edge * 0.6 + smoothstep(0.55, 0.95, n) * 0.7, 0.0, 1.0);
  return clamp(m * (0.4 + 0.6 * groutMask), 0.0, 1.0);
}
// dirtMask: accumulation at edges/corners + noise → darker + rougher.
fn gr_dirtMask(uv: vec2<f32>, edge: f32, corner: f32) -> f32 {
  let n = gr_fbm2(uv * 3.1 + vec2<f32>(4.4, 8.9));
  return clamp(edge * 0.5 + corner * 0.5 + smoothstep(0.6, 0.95, n) * 0.5, 0.0, 1.0);
}
// PROFILE weights (edgeW, wearW, mossW, dirtW): new / worn / ancient / mossy / dirty. One knob, five looks.
fn gr_profile(idx: f32) -> vec4<f32> {
  let i = i32(idx + 0.5);
  if (i <= 0) { return vec4<f32>(0.06, 0.06, 0.0, 0.04); }    // new — nearly off
  if (i == 2) { return vec4<f32>(1.3, 0.8, 0.9, 0.9); }       // ancient — heavy edge-round + moss + dirt
  if (i == 3) { return vec4<f32>(0.7, 0.5, 1.7, 0.4); }       // mossy — moss dominant
  if (i == 4) { return vec4<f32>(0.9, 0.5, 0.2, 1.6); }       // dirty — dirt dominant
  return vec4<f32>(0.7, 1.0, 0.5, 0.6);                       // worn (default)
}
// Layer the four masks over a P1 GroundOut: wear brightens + polishes + rounds; dirt/edge darken +
// roughen; moss tints seams/edges; corners chip (deeper bevel + darker). Subtle — ages, not repaints.
// mc = the MASK coordinate. For a standalone plane that is the uv (a 0..1 region) and edgeAmt is 1. For
// CITY ground — where uv is a world parameterisation (worldXZ * 0.5) so adjacent meshes tile continuously —
// it is a world-scaled coordinate and edgeAmt is 0: gr_edgeMask would otherwise see a border distance far
// outside 0..1, saturate to 1 across the ENTIRE city, and darken + corner-chip every road and pavement.
fn groundWeather(g: GroundOut, mc: vec2<f32>, edgeAmt: f32, profile: f32, pc: vec2<f32>, pr: f32) -> GroundOut {
  let w = gr_profile(profile);
  let ec = gr_edgeMask(mc) * edgeAmt;
  let edge = ec.x;
  let corner = ec.y;
  let wear = gr_wearMask(mc, pc, pr) * w.y;
  let dirt = gr_dirtMask(mc, edge, corner) * w.w;
  let moss = gr_moistMask(mc, edge, g.grout) * w.z;
  let edgeD = edge * w.x;
  let inv = 1.0 - wear;                              // high wear washes out dirt/moss/edge
  var col = g.rgb;
  var rough = g.rough;
  var h = g.height;
  // WEAR — brighter, smoother (-rough), edges flatter/rounded (raise height in the relief).
  col = mix(col, col * 1.14, wear);
  rough = rough - wear * 0.28;
  h = h + wear * 0.22;
  // DIRT — darken + roughen (warm grime), biased to edges/corners.
  col = mix(col, col * vec3<f32>(0.80, 0.76, 0.70), dirt * inv);
  rough = rough + dirt * 0.22;
  // EDGE — darker at region borders.
  col = mix(col, col * 0.78, edgeD * inv);
  // MOSS — green tint in seams + at edges, slightly darker + rougher.
  col = mix(col, vec3<f32>(0.30, 0.42, 0.22), moss * 0.55 * inv);
  rough = rough + moss * 0.15;
  // CORNER CHIP — deeper bevel + darker (edge-wear extreme).
  let chip = corner * w.x;
  h = h - chip * 0.6;
  col = mix(col, col * 0.7, chip * 0.5 * inv);
  var o: GroundOut;
  o.rgb = col;
  o.height = h;
  o.rough = clamp(rough, 0.04, 1.0);
  o.grout = g.grout;
  return o;
}

// == PROCEDURAL GROUND P3 — RADIAL MEDALLION + BORDER STRIP TILERS (procedural-ground.md §3) =====
// Two more cell-id / edge-distance functions; they feed the SAME gr_shadeCell + gr_cellHeight + P2
// weathering as ashlar (only the cell layout differs). radialMedallion = POLAR tiling (rings x wedges),
// the courtyard centrepiece; borderStrip = long linear pavers, the plaza frame band.
// RADIAL (mode 1): centred on the disc mesh's uv centre, expressed in METRES (centre = uvM * 0.5, i.e.
// half the mesh's world extent). ringSpacing is metres. Returns (ring, wedge, edgeDistMetres).
fn groundCellRadial(p: vec2<f32>, centre: vec2<f32>, ringSpacing: f32, wedges: f32) -> vec3<f32> {
  let d = p - centre;
  let r = length(d);
  let TAU = 6.28318530718;
  var theta = atan2(d.y, d.x);
  theta = theta - TAU * floor(theta / TAU);        // 0..TAU
  let rs = max(ringSpacing, 1e-4);
  let wn = max(wedges, 1.0);
  let ring = floor(r / rs);
  let wf = theta / TAU * wn;                        // 0..wedges
  let wedge = floor(wf);
  let lr = fract(r / rs);
  let edgeR = min(lr, 1.0 - lr) * rs;              // metres to the nearest ring border
  let lw = fract(wf);
  let arc = (TAU / wn) * max(r, 1e-4);            // wedge arc LENGTH in metres at this radius
  let edgeW = min(lw, 1.0 - lw) * arc;            // metres to the nearest wedge border
  return vec3<f32>(ring, wedge, min(edgeR, edgeW));
}
// BORDER (mode 2): long linear stones tiled along the strip length (metres), with rowCount rows spread
// across the strip's WIDTH. Row height stays a fraction of the band (uvM.y / rowCount) rather than an
// absolute metre value, because the caller sizes the band relative to the plaza, not in stone units.
fn groundCellBorder(p: vec2<f32>, uvM: vec2<f32>, stoneLen: f32, rowCount: f32) -> vec3<f32> {
  let sl = max(stoneLen, 1e-4);
  let sw = max(uvM.y / max(rowCount, 1.0), 1e-4);   // row height in metres
  let col = floor(p.x / sl);
  let row = floor(p.y / sw);
  let lx = fract(p.x / sl);
  let ly = fract(p.y / sw);
  let edgeU = min(lx, 1.0 - lx) * sl;
  let edgeV = min(ly, 1.0 - ly) * sw;
  return vec3<f32>(col, row, min(edgeU, edgeV));
}
fn groundRadial(p: vec2<f32>, centre: vec2<f32>, base: vec3<f32>, grout: vec3<f32>, groutW: f32,
                ringSpacing: f32, wedges: f32, jitter: f32) -> GroundOut {
  let c = groundCellRadial(p, centre, ringSpacing, wedges);
  return gr_shadeCell(p, base, grout, groutW, jitter, vec2<f32>(c.x, c.y), c.z);
}
fn groundBorder(p: vec2<f32>, uvM: vec2<f32>, base: vec3<f32>, grout: vec3<f32>, groutW: f32,
                stoneLen: f32, rowCount: f32, jitter: f32) -> GroundOut {
  let c = groundCellBorder(p, uvM, stoneLen, rowCount);
  return gr_shadeCell(p, base, grout, groutW, jitter, vec2<f32>(c.x, c.y), c.z);
}

// == PROCEDURAL GROUND P4 — GRASS SURFACE + DIRT-PATH BLEND (procedural-ground.md §8-§9) =========
// Tiler NONE: pure layered noise (no pavers/grout). base = green tint, dirt = the bare-path colour the
// lawn blends toward where the P2 wear mask (wpc + wpr = the wear PATH, §5/§9) is high. High roughness,
// very subtle height (no hard tile edges).
// p = metric coords (metres) for the physical noise; mc is the MASK coordinate the wear/moisture masks
// are defined in (position within the zone / across the world, not physical size).
fn groundGrass(p: vec2<f32>, mc: vec2<f32>, base: vec3<f32>, dirt: vec3<f32>, jitter: f32,
               wpc: vec2<f32>, wpr: f32) -> GroundOut {
  // ★ TURF IS THREE SCALES. A lawn reads as (a) broad mow/health drift over metres, (b) hand-sized
  // CLUMPS each with its own green, and (c) blade-scale striation *inside* a clump running whichever way
  // that clump happens to lie. The first version had only (a) plus one globally-aligned anisotropic
  // streak, which smears into wet mud at any zoom, and dry flecks drawn by a hard step() on
  // floor(p * 4.5) — 22 cm axis-aligned tan SQUARES, the same defect as the old ashlar pits.
  var col = base;
  // (a) BROAD drift — health/mow patches, several metres across.
  // NB: macro is a RESERVED keyword in WGSL — never name an identifier that (it fails at
  // CreateShaderModule at runtime, NOT at build time). Hence macroBlob.
  let macroBlob = gr_fbm2(p * 0.2);
  col = mix(col, col * vec3<f32>(1.10, 1.04, 0.74), smoothstep(0.62, 0.96, macroBlob) * 0.26 * jitter); // dry/yellow patch
  col = col * (1.0 + (macroBlob - 0.5) * 0.13);
  // (b) CLUMPS — smooth noise, NOT a hash grid (a floor() grid is exactly what drew squares). Vary hue,
  // saturation and value separately: same-value/different-hue is what real turf does.
  let clump = gr_fbm2(p * 2.6 + vec2<f32>(11.3, 4.9));
  let clumpB = pg_vnoise(p * 5.1 + vec2<f32>(2.2, 7.7));
  var hsv = gr_rgb2hsv(col);
  hsv.x = fract(hsv.x + (clump - 0.5) * 0.030 * jitter);
  hsv.y = clamp(hsv.y * (1.0 + (clumpB - 0.5) * 0.22 * jitter), 0.0, 1.0);
  hsv.z = clamp(hsv.z * (1.0 + (clump - 0.5) * 0.28 * jitter), 0.0, 1.0);
  col = gr_hsv2rgb(hsv);
  // (c) BLADE striation — fine, and ROTATED PER CLUMP so the surface never reads as combed one way.
  let ang = clump * 6.28318530718;
  let ca = cos(ang);
  let sa = sin(ang);
  let pr = vec2<f32>(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  let blade = pg_vnoise(vec2<f32>(pr.x * 26.0, pr.y * 150.0));   // ~4 cm across the blades, ~7 mm along
  col = col * (1.0 + (blade - 0.5) * 0.17);
  // (d) SPARSE dead/dry flecks — small, round and soft-edged (see the note above).
  let fc = p * 26.0;                                             // ~4 cm cells
  let fh = pg_hash21(floor(fc));
  let fd = 1.0 - smoothstep(0.06, 0.30, length(fract(fc) - vec2<f32>(0.5)));
  col = mix(col, vec3<f32>(0.55, 0.50, 0.30), step(0.972, fh) * fd * 0.55);
  // MOISTURE / moss tint (reuse the P2 mask; damp areas darker + greener).
  let moist = gr_moistMask(mc, 0.0, 0.0);
  col = mix(col, col * vec3<f32>(0.80, 0.95, 0.72), moist * 0.40);
  var h = (pg_vnoise(p * 2.5) - 0.5) * 0.15;       // soft, no tile edges
  var rough = 0.90;
  // DIRT-PATH BLEND (§9): grass 100->0% across the wear band, exposing bare dirt where worn.
  let wear = gr_wearMask(mc, wpc, wpr);
  let bare = smoothstep(0.25, 0.85, wear);
  var dcol = dirt * (1.0 + (pg_vnoise(p * 6.0) - 0.5) * 0.16);
  let pit = pg_hash21(floor(p * 3.5));
  dcol = dcol * mix(1.0, 0.80, step(0.90, pit));   // scattered dark specks in the dirt
  col = mix(col, dcol, bare);
  rough = mix(rough, 1.0, bare);
  h = mix(h, h * 0.4 - 0.08, bare);                // path a touch lower + flatter
  var o: GroundOut;
  o.rgb = col;
  o.height = h;
  o.rough = clamp(rough, 0.04, 1.0);
  o.grout = 0.0;
  return o;
}

// == NEON / SCREEN SIGN (neonShade, bit 22) ======================================================
// The holoboards and neon panels used the waves pattern motif — a colour band scrolled across the
// ALBEDO — and leaned on a high emissive to be seen at all. Same failure as the old water: it is a
// painted animation. A sign reads as EMITTING when it has structure that light does not explain:
//   1. SCANLINES across the panel, drifting slowly (a screen is scanned, not lit evenly);
//   2. per-sign FLICKER on its own hashed phase, with an occasional deeper dropout — a tube warming up
//      or failing is the single most recognisable neon cue, and it must differ per sign or the whole
//      street pulses in unison;
//   3. an EDGE FALLOFF so the panel is brightest at its centre, which is what a diffuser actually does;
//   4. a BLOOM-ish rim that lifts the accent colour where the panel meets its border.
// Slots: patternColor = (glow.rgb, packed accent rgb), patternParams = (scanDensity, flicker, scroll, phase).
fn neonSign(uv: vec2<f32>, glow: vec3<f32>, accent: vec3<f32>, scanDensity: f32,
            flicker: f32, scroll: f32, phase: f32, time: f32) -> vec3<f32> {
  let t = time;
  // SCANLINES — a sharp-ish band, drifting. pow() keeps the dark gaps thin so it reads as a screen
  // rather than as stripes.
  let scan = pow(0.5 + 0.5 * sin((uv.y * max(scanDensity, 1.0) + t * scroll) * 6.2831853), 1.6);
  // FLICKER — two incommensurate rates so it never looks like a clean sine, plus a rare deep dropout.
  let f1 = sin(t * 11.3 + phase * 6.28);
  let f2 = sin(t * 27.7 + phase * 12.9);
  let dropout = step(0.986, fract(sin(floor(t * 7.0 + phase * 31.0) * 12.9898) * 43758.5453));
  let flick = 1.0 - flicker * (0.5 + 0.25 * f1 + 0.25 * f2) * 0.5 - dropout * 0.55;
  // EDGE FALLOFF — brightest in the middle, like a lit diffuser panel.
  let e = uv * 2.0 - vec2<f32>(1.0);
  let vign = clamp(1.0 - dot(e, e) * 0.35, 0.35, 1.0);
  // ACCENT RIM where the panel meets its border.
  let rim = smoothstep(0.72, 1.0, max(abs(e.x), abs(e.y)));
  let body = glow * (0.55 + 0.45 * scan) * vign;
  return (body + accent * rim * 0.8) * max(flick, 0.0);
}

// == PAINTED METAL (metalShade, bit 23) ==========================================================
// The city's largest remaining flat-colour mass: rooftop plant and vents, every railing, every pole,
// signal housings, guardrails — ~70 000 triangles of one grey. Metal is not a colour, it is a RESPONSE:
// it streaks where rain runs down it, collects grime on its upward faces, and its paint rubs bright at
// the edges. None of that comes from a diffuse tint, which is why these read as plastic.
//
// Four cues, all cheap and all driven by WORLD position so neighbouring objects never match:
//   1. per-object TONE, so a row of poles is not one colour;
//   2. RAIN STREAKS — noise stretched hard along Y, gated to near-vertical faces (a flat top has no runs);
//   3. GRIME on upward faces, which is what makes rooftop plant look like rooftop plant;
//   4. a micro roughness break-up so the specular is not a single uniform sheen.
// Slots: patternColor = (tint.rgb, packed streak/grime colour), patternParams = (roughness, streak, grime, scale).
// WARNING: scale is CYCLES PER WORLD UNIT — the city is a diorama (1 unit = 15 m), set it per world.

struct MetalOut { rgb: vec3<f32>, rough: f32 }

fn metalSurface(worldPos: vec3<f32>, N: vec3<f32>, tint: vec3<f32>, streakCol: vec3<f32>,
                rough0: f32, streakAmt: f32, grimeAmt: f32, scale: f32) -> MetalOut {
  let p = worldPos * max(scale, 1e-4);
  // 1 · PER-OBJECT TONE — a coarse cell hash, so each pole/unit sits at its own value.
  let tone = 0.90 + 0.20 * pg_hash21(floor(p.xz * 0.9 + vec2<f32>(p.y * 0.4)));
  var col = tint * tone;
  // 2 · RAIN STREAKS — stretched ~14x along Y and only where the surface is near-vertical.
  let vertical = clamp(1.0 - abs(N.y), 0.0, 1.0);
  let st = pg_vnoise(vec2<f32>(p.x * 5.0 + p.z * 4.0, p.y * 0.35));
  let streak = smoothstep(0.52, 0.95, st) * vertical * streakAmt;
  col = mix(col, streakCol, streak * 0.5);
  // 3 · GRIME on upward faces — rooftop equipment is filthy on top and comparatively clean on its sides.
  let upFace = clamp(N.y, 0.0, 1.0);
  let grime = pg_vnoise(p.xz * 2.2) * upFace * grimeAmt;
  col = mix(col, streakCol * 0.75, grime * 0.4);
  // 4 · MICRO break-up — keeps the specular from reading as one flat sheen across a whole railing.
  // Two ORTHOGONAL 2D samples, not one: pg_vnoise is vec2-only, and sampling p.xz alone is constant
  // along Y, which is exactly the axis a lamp post or a downpipe runs along — it would have striped.
  let micro = pg_vnoise(p.xz * 22.0) * 0.5 + pg_vnoise(vec2<f32>(p.y, p.x + p.z) * 22.0) * 0.5;
  col = col * (1.0 + (micro - 0.5) * 0.10);
  var o: MetalOut;
  o.rgb = col;
  // Wet streaks are SMOOTHER (darker + shinier); grime is rougher.
  o.rough = clamp(rough0 - streak * 0.18 + grime * 0.22 + (micro - 0.5) * 0.10, 0.05, 1.0);
  return o;
}

// == WATER (waterShade, bit 21) ==================================================================
// Replaces the old "waves" pattern motif, which was an ANIMATED ALBEDO BAND — scrolling stripes painted
// on a flat surface. It could not shimmer, because nothing about it touched the surface NORMAL, and light
// is what makes water read as water. This builds a real ripple normal and lights it:
//
//   1. a sum of directional sine waves (each octave rotated, higher frequency, lower amplitude) whose
//      analytic derivative IS the surface gradient — no texture, no normal map, exact normals;
//   2. a second much finer octave set for the micro-chop that produces the glitter;
//   3. FRESNEL — grazing angles reflect, steep angles show the water body colour;
//   4. a tight specular lobe off the ripple normal, which is the sun scintillation;
//   5. the reflection tint comes from the SCENE FOG colour, so the water follows the sky through the
//      day/night cycle without carrying its own sky parameter.
//
// Slots (repurposed pattern instance slots, exclusive with pattern/board/ground/foliage on a mesh):
//   patternColor  = (deep.rgb, packed shallow rgb)
//   patternParams = (waveScale, waveSpeed, choppiness, glitter)
// ⚠ waveScale is CYCLES PER WORLD UNIT, so it must be set for the world's scale — the city is a diorama
// at 1 unit = 15 m, so a ~1.5 m swell is ~10 cycles/unit there and ~0.7 on a 1:1 pond.

struct WaterWave { h: f32, dx: f32, dz: f32 }

// Four rotated octaves. Returns the height and its exact x/z derivatives (the gradient = the normal).
fn wt_waves(p: vec2<f32>, t: f32) -> WaterWave {
  var h = 0.0;
  var dx = 0.0;
  var dz = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  var spd = 1.0;
  var dir = vec2<f32>(0.862, 0.507);
  for (var i: i32 = 0; i < 4; i = i + 1) {
    let ph = dot(p, dir) * freq + t * spd;
    h = h + sin(ph) * amp;
    let c = cos(ph) * amp * freq;
    dx = dx + c * dir.x;
    dz = dz + c * dir.y;
    amp = amp * 0.52;
    freq = freq * 1.93;
    spd = spd * 1.31;
    // Rotate each octave ~49 degrees so the sum never lines up into visible parallel banding.
    dir = vec2<f32>(dir.x * 0.656 - dir.y * 0.755, dir.x * 0.755 + dir.y * 0.656);
  }
  var o: WaterWave;
  o.h = h; o.dx = dx; o.dz = dz;
  return o;
}

struct WaterOut { rgb: vec3<f32>, N: vec3<f32>, rough: f32, glint: f32 }

fn waterSurface(worldPos: vec3<f32>, N0: vec3<f32>, V: vec3<f32>, L: vec3<f32>, sky: vec3<f32>,
                deep: vec3<f32>, shallow: vec3<f32>, waveScale: f32, waveSpeed: f32,
                choppy: f32, glitter: f32, time: f32) -> WaterOut {
  let p = worldPos.xz * max(waveScale, 1e-4);
  let t = time * waveSpeed;
  let big = wt_waves(p, t);
  // MICRO CHOP — the fine detail that makes the specular scintillate rather than slide.
  let fine = wt_waves(p * 5.7 + vec2<f32>(13.1, 7.9), t * 2.1);
  let gx = (big.dx + fine.dx * 0.42) * choppy;
  let gz = (big.dz + fine.dz * 0.42) * choppy;
  // Gradient -> normal. Blended toward the surface's own normal so a tilted water plane still reads right.
  var N = normalize(vec3<f32>(-gx, 1.0, -gz));
  N = normalize(N * 0.82 + N0 * 0.18);

  // CREST vs TROUGH: crests catch more light and read shallower. Cheap stand-in for real depth (there is
  // no depth buffer read here) and it keeps the body from being one flat colour.
  let crest = clamp(big.h * 0.35 + 0.5, 0.0, 1.0);
  var col = mix(deep, shallow, crest * 0.45);

  // FRESNEL — the single biggest cue. Nearly all reflection at grazing angles, body colour looking down.
  let fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  col = mix(col, sky, clamp(fres, 0.0, 1.0) * 0.72);

  // SUN GLITTER — a very tight lobe off the perturbed normal. The fine octave above is what makes this
  // break into moving sparkles instead of one smeared highlight.
  let H = normalize(L + V);
  let spec = pow(max(dot(N, H), 0.0), 260.0);
  let sparkle = pow(max(dot(N, H), 0.0), 900.0) * 1.6;
  var o: WaterOut;
  o.rgb = col;
  o.N = N;
  o.rough = clamp(0.10 + (1.0 - crest) * 0.06, 0.02, 1.0);
  o.glint = (spec + sparkle) * max(glitter, 0.0);
  return o;
}

// == PROCEDURAL GROUND P6 — MATERIAL LIBRARY (procedural-ground.md §11) ==========================
// Five more surfaces on the SAME groundShade path — no new pipeline, no new instance slots, just more
// groundMode branches. Two families:
//   TILED   (reuse gr_shadeCell verbatim — only the cell layout differs): cobble, plank, concrete.
//   ORGANIC (their own shading, no cells): asphalt, dirt.
// The stone LOOKS (brick / granite / slate / sandstone) are NOT modes — they are CPU-side presets over
// the ashlar tiler, because a brick and a limestone paver differ in size, colour and jitter, not in
// geometry. See GROUND_SURFACES in shape-manager.

// VORONOI — irregular cells over a jittered grid. Returns (cellIdX, cellIdY, edgeDist) where edgeDist
// is the F2-F1 border distance the grout mask needs. 3x3 neighbourhood is enough for jitter <= 1.
fn gr_worley(p: vec2<f32>) -> vec3<f32> {
  let g = floor(p);
  let f = p - g;
  var best = 1e9;
  var second = 1e9;
  var bid = vec2<f32>(0.0, 0.0);
  for (var j: i32 = -1; j <= 1; j = j + 1) {
    for (var i: i32 = -1; i <= 1; i = i + 1) {
      let o = vec2<f32>(f32(i), f32(j));
      let id = g + o;
      let jit = vec2<f32>(pg_hash21(id), pg_hash21(id + vec2<f32>(7.3, 1.9)));
      let d = length(o + jit - f);
      if (d < best) { second = best; best = d; bid = id; }
      else if (d < second) { second = d; }
    }
  }
  return vec3<f32>(bid.x, bid.y, (second - best) * 0.5);
}
// COBBLE (mode 7): irregular set stones. Pure layout change — the shading is gr_shadeCell, same as ashlar.
fn groundCellCobble(p: vec2<f32>, cellSize: f32) -> vec3<f32> {
  let cs = max(cellSize, 1e-4);
  let w = gr_worley(p / cs);
  return vec3<f32>(w.x, w.y, w.z * cs);              // edge distance back into metres
}
// PLANK (mode 8): boards running along +x, with each ROW's joints staggered so ends never line up.
fn groundCellPlank(p: vec2<f32>, boardLen: f32, boardW: f32) -> vec3<f32> {
  let bl = max(boardLen, 1e-4);
  let bw = max(boardW, 1e-4);
  let row = floor(p.y / bw);
  let stagger = pg_hash21(vec2<f32>(row, 3.1)) * bl;  // per-row offset — the whole point of a plank floor
  let u = p.x + stagger;
  let col = floor(u / bl);
  let lx = fract(u / bl);
  let ly = fract(p.y / bw);
  let edgeU = min(lx, 1.0 - lx) * bl;
  let edgeV = min(ly, 1.0 - ly) * bw;
  return vec3<f32>(col, row, min(edgeU, edgeV));
}
// GRID (mode 5, concrete): plain stack-bond slabs — NO running-bond offset. Poured concrete is cut on a
// square grid; offsetting alternate rows is the single fastest way to make it read as masonry instead.
fn groundCellGrid(p: vec2<f32>, slabW: f32, slabH: f32) -> vec3<f32> {
  let sw = max(slabW, 1e-4);
  let sh = max(slabH, 1e-4);
  let col = floor(p.x / sw);
  let row = floor(p.y / sh);
  let lx = fract(p.x / sw);
  let ly = fract(p.y / sh);
  return vec3<f32>(col, row, min(min(lx, 1.0 - lx) * sw, min(ly, 1.0 - ly) * sh));
}
// WOOD grain over a plank cell — rings stretched hard along the board, plus a per-board tone.
fn groundPlank(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, gapW: f32,
               boardLen: f32, boardW: f32, jitter: f32) -> GroundOut {
  let c = groundCellPlank(p, boardLen, boardW);
  var g = gr_shadeCell(p, base, seam, gapW, jitter * 0.8, vec2<f32>(c.x, c.y), c.z);
  // GRAIN — anisotropic rings. abs(fract*2-1) turns smooth noise into ring LINES, which is what makes
  // wood read as wood rather than as stretched marble.
  let bh = pg_hash21(vec2<f32>(c.x, c.y) + vec2<f32>(1.7, 6.2));
  let gr = pg_vnoise(vec2<f32>(p.x * 1.6 + bh * 40.0, p.y * 34.0));
  let rings = abs(fract(gr * 5.0) * 2.0 - 1.0);
  g.rgb = g.rgb * (1.0 - (1.0 - rings) * 0.20 * jitter);
  g.rgb = g.rgb * (1.0 + (bh - 0.5) * 0.14 * jitter);      // board-to-board tone
  g.rough = clamp(g.rough * 0.85 + (1.0 - rings) * 0.06, 0.04, 1.0);
  return g;
}
// CONCRETE (mode 5): near-uniform slabs — pores, faint trowel mottling, darker expansion joints. The
// restraint IS the material; per-slab hue jitter would read as stone.
fn groundConcrete(p: vec2<f32>, base: vec3<f32>, seam: vec3<f32>, jointW: f32,
                  slabW: f32, slabH: f32, jitter: f32) -> GroundOut {
  let c = groundCellGrid(p, slabW, slabH);
  var col = base;
  let slabTone = pg_hash21(vec2<f32>(c.x, c.y) + vec2<f32>(2.9, 5.4));
  col = col * (1.0 + (slabTone - 0.5) * 0.07 * jitter);    // pours never match exactly
  col = col * (1.0 + (gr_fbm2(p * 0.9) - 0.5) * 0.10);     // trowel mottling
  col = col * (1.0 + (pg_vnoise(p * 34.0) - 0.5) * 0.06);  // fine surface tooth
  // POROSITY — sparse tiny dark air pockets.
  let pc = p * 55.0;
  let phh = pg_hash21(floor(pc));
  let pdd = 1.0 - smoothstep(0.10, 0.34, length(fract(pc) - vec2<f32>(0.5)));
  col = col * mix(1.0, 0.80, step(0.980, phh) * pdd);
  let jointMask = 1.0 - smoothstep(jointW * 0.7, jointW * 1.3, c.z);
  col = mix(col, seam, jointMask * 0.9);
  var o: GroundOut;
  o.rgb = col;
  o.height = -jointMask * 0.8 + (pg_vnoise(p * 34.0) - 0.5) * 0.06;
  o.rough = clamp(0.80 + (slabTone - 0.5) * 0.08, 0.04, 1.0);
  o.grout = jointMask;
  return o;
}
// ASPHALT (mode 4): loose AGGREGATE, not a tiled surface. Dense stone speckle at two scales, a few
// bright chips, low-freq patch/repair drift, and a thin crack network from ridged noise.
fn groundAsphalt(p: vec2<f32>, base: vec3<f32>, jitter: f32) -> GroundOut {
  var col = base;
  col = col * (1.0 + (gr_fbm2(p * 0.35) - 0.5) * 0.22 * jitter);      // age / patch repairs
  let a1 = pg_vnoise(p * 60.0);
  let a2 = pg_vnoise(p * 150.0 + vec2<f32>(5.1, 2.3));
  let agg = a1 * 0.6 + a2 * 0.4;
  col = col * (1.0 + (agg - 0.5) * 0.42 * jitter);
  // BRIGHT CHIPS — pale aggregate catching the light.
  let cc = p * 85.0;
  let chh = pg_hash21(floor(cc));
  let cdd = 1.0 - smoothstep(0.10, 0.32, length(fract(cc) - vec2<f32>(0.5)));
  col = mix(col, col * 2.1, step(0.978, chh) * cdd * 0.75);
  // CRACKS — ridged noise: |n - 0.5| is near zero along a whole contour, i.e. a LINE network.
  let cr = abs(gr_fbm2(p * 1.6 + vec2<f32>(9.9, 1.7)) - 0.5) * 2.0;
  let crack = 1.0 - smoothstep(0.0, 0.055, cr);
  col = col * mix(1.0, 0.42, crack * 0.85);
  var o: GroundOut;
  o.rgb = col;
  o.height = (agg - 0.5) * 0.10 - crack * 0.55;
  o.rough = clamp(0.84 + (agg - 0.5) * 0.12, 0.04, 1.0);
  o.grout = crack;
  return o;
}
// DIRT (mode 6): clumped earth — soft lumps, embedded grit, and dry cracks that only show on the
// high/raised clumps (mud does not craze evenly, which is what makes flat noise read as fabric).
fn groundDirt(p: vec2<f32>, base: vec3<f32>, jitter: f32) -> GroundOut {
  var col = base;
  let broad = gr_fbm2(p * 0.5);
  col = col * (1.0 + (broad - 0.5) * 0.30 * jitter);
  let lump = gr_fbm2(p * 3.4 + vec2<f32>(3.3, 8.8));
  col = col * (1.0 + (lump - 0.5) * 0.26 * jitter);
  col = col * (1.0 + (pg_vnoise(p * 44.0) - 0.5) * 0.12);             // grit
  // SMALL STONES — pale, sparse, soft.
  let sc = p * 30.0;
  let shh = pg_hash21(floor(sc));
  let sdd = 1.0 - smoothstep(0.08, 0.30, length(fract(sc) - vec2<f32>(0.5)));
  col = mix(col, col * 1.55, step(0.972, shh) * sdd * 0.85);
  // CRAZING — gated by the lump field so cracks sit on the dried crests only.
  let cr = abs(gr_fbm2(p * 5.5 + vec2<f32>(1.1, 4.2)) - 0.5) * 2.0;
  let crack = (1.0 - smoothstep(0.0, 0.07, cr)) * smoothstep(0.45, 0.75, lump);
  col = col * mix(1.0, 0.62, crack * 0.7);
  var o: GroundOut;
  o.rgb = col;
  o.height = (lump - 0.5) * 0.5 + (broad - 0.5) * 0.3 - crack * 0.35;
  o.rough = 0.95;
  o.grout = 0.0;
  return o;
}

// SURFACE DISPATCH — pick the tiler by groundMode; P2 weathering (groundWeather) then applies over ALL
// modes uniformly in the fragment shader (weathering is surface-agnostic — not duplicated per mode).
// seam = grout rgb (tilers) OR dirt tint (grass); p0/p1 = tileW/tileH · ringSpacing/wedges · stoneLen/rowW.
// uvM = world metres per uv unit (gr_uvMetres); p = uv * uvM is the metric surface coordinate every
// tiler tiles in, so paver size and grout width are physical and axis-independent.
// mc = the MASK coordinate (see groundWeather) — grass runs the wear/moisture masks itself for its
// dirt-path blend, so it needs the same coordinate the weathering pass uses, not the raw uv.
fn groundSurface(uv: vec2<f32>, uvM: vec2<f32>, mc: vec2<f32>, mode: f32, base: vec3<f32>, seam: vec3<f32>, groutW: f32,
                 p0: f32, p1: f32, jitter: f32, wpc: vec2<f32>, wpr: f32) -> GroundOut {
  let mi = i32(mode + 0.5);
  let p = uv * uvM;
  if (mi == 1) { return groundRadial(p, uvM * 0.5, base, seam, groutW, p0, p1, jitter); }
  if (mi == 2) { return groundBorder(p, uvM, base, seam, groutW, p0, p1, jitter); }
  if (mi == 3) { return groundGrass(p, mc, base, seam, jitter, wpc, wpr); }
  if (mi == 4) { return groundAsphalt(p, base, jitter); }
  if (mi == 5) { return groundConcrete(p, base, seam, groutW, p0, p1, jitter); }
  if (mi == 6) { return groundDirt(p, base, jitter); }
  if (mi == 7) {
    let c = groundCellCobble(p, p0);
    return gr_shadeCell(p, base, seam, groutW, jitter, vec2<f32>(c.x, c.y), c.z);
  }
  if (mi == 8) { return groundPlank(p, base, seam, groutW, p0, p1, jitter); }
  return groundAshlar(p, base, seam, groutW, p0, p1, jitter);
}
// Mode-aware height field for the ±eps relief normal (matches whichever tiler groundSurface used).
// Takes the METRIC coordinate directly so the caller can offset by an epsilon in metres.
fn groundHeightM(p: vec2<f32>, uvM: vec2<f32>, mode: f32, groutW: f32, p0: f32, p1: f32) -> f32 {
  let mi = i32(mode + 0.5);
  // Non-tiled surfaces: cheap height-only mirrors of their shading fields (must track them, or the
  // relief lights a groove that the albedo does not draw).
  if (mi == 3) { return (pg_vnoise(p * 2.5) - 0.5) * 0.15; }   // grass: soft noise, no tile edges
  if (mi == 4) {
    let agg = pg_vnoise(p * 60.0) * 0.6 + pg_vnoise(p * 150.0 + vec2<f32>(5.1, 2.3)) * 0.4;
    let cr = abs(gr_fbm2(p * 1.6 + vec2<f32>(9.9, 1.7)) - 0.5) * 2.0;
    return (agg - 0.5) * 0.10 - (1.0 - smoothstep(0.0, 0.055, cr)) * 0.55;
  }
  if (mi == 6) {
    let broad = gr_fbm2(p * 0.5);
    let lump = gr_fbm2(p * 3.4 + vec2<f32>(3.3, 8.8));
    let cr = abs(gr_fbm2(p * 5.5 + vec2<f32>(1.1, 4.2)) - 0.5) * 2.0;
    let crack = (1.0 - smoothstep(0.0, 0.07, cr)) * smoothstep(0.45, 0.75, lump);
    return (lump - 0.5) * 0.5 + (broad - 0.5) * 0.3 - crack * 0.35;
  }
  var c: vec3<f32>;
  if (mi == 1) { c = groundCellRadial(p, uvM * 0.5, p0, p1); }
  else if (mi == 2) { c = groundCellBorder(p, uvM, p0, p1); }
  else if (mi == 5) { c = groundCellGrid(p, p0, p1); }
  else if (mi == 7) { c = groundCellCobble(p, p0); }
  else if (mi == 8) { c = groundCellPlank(p, p0, p1); }
  else { c = groundCell(p, p0, p1); }
  return gr_cellHeight(vec2<f32>(c.x, c.y), c.z, groutW);
}

// == FOLIAGE SHADE (foliageShade, bit 20) — foliage-quality.md S2 =================================
// The FRAGMENT half of the shared foliage layer: leaf TRANSLUCENCY (the anime backlit cue), a base AO
// and a ground-colour bleed at the plant's base. Instance slots are repurposed exactly like board/ground
// shading: patternColor = (translucency, groundBlend, baseAO, packedGroundTint) and
// patternParams = (windHeight, windStiffness, windAmount, packedTranslucencyColor).
// The two colours are packed 8:8:8 into one float each (packRGB8 in material-3d.ts) because the six
// scalars + two colours do not fit in the eight repurposed floats otherwise.
fn fq_unpackRGB(v: f32) -> vec3<f32> {
  let p = u32(max(v, 0.0));
  return vec3<f32>(f32((p >> 16u) & 255u), f32((p >> 8u) & 255u), f32(p & 255u)) * (1.0 / 255.0);
}
// TRANSMISSION — light that passes THROUGH a thin leaf. Two lobes: a back-lambert (max(0, dot(-N, L)))
// which lights leaves whose BACK faces the sun, plus a view-dependent WRAP (pow(max(0, dot(V, -L)), k))
// so the glow peaks when you look toward the sun through the canopy. Tinted by translucencyColor and
// scaled by translucency; the caller ADDS it on top of the lit result, so it COMPOSES with the rim
// (bit 8) rather than fighting it. Thin cards/blades set it high, trunks/vessels set it 0.
fn foliageTransmission(N: vec3<f32>, L: vec3<f32>, V: vec3<f32>, tint: vec3<f32>, amount: f32,
                       lightCol: vec3<f32>, lightInt: f32) -> vec3<f32> {
  if (amount <= 0.0) { return vec3<f32>(0.0); }
  let back = max(dot(-N, L), 0.0);                       // light coming through from behind the leaf
  let wrap = pow(max(dot(V, -L), 0.0), 3.0);             // view-aligned backlight bloom
  return tint * ((back * 0.7 + wrap * 0.5) * amount) * lightCol * max(lightInt, 0.0);
}
// BASE AO + GROUND BLEND — the lowest ~15% of the plant (by the SAME normalized local Y the wind grading
// uses) darkens and picks up the ground colour, so blades/cards read as GROWING FROM the ground instead
// of stuck into it. localY01 = clamp(localY / windHeight, 0, 1) interpolated from the vertex stage.
fn foliageBase(albedo: vec3<f32>, localY01: f32, aoAmount: f32, blend: f32, groundTint: vec3<f32>) -> vec3<f32> {
  let ramp = 1.0 - smoothstep(0.0, 0.15, clamp(localY01, 0.0, 1.0));
  var c = albedo * (1.0 - clamp(aoAmount, 0.0, 1.0) * ramp);
  c = mix(c, groundTint, clamp(blend, 0.0, 1.0) * ramp);
  return c;
}
`;

// ── FOLIAGE WIND (windSway, bit 19) — foliage-quality.md S1, the VERTEX half ──────────────────────
// Included by EVERY vertex shader foliage renders through (mesh3d, vertex-color, and the shadow DEPTH
// pass — a swaying plant whose shadow is static looks broken). Displacement is computed in LOCAL space
// and added BEFORE the model transform, so each instanced copy bends about its own base.
export const FOLIAGE_WIND_WGSL = /* wgsl */ `
fn fq_hash12(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
// windHeight/stiffness/amount come from the instance's repurposed patternParams.xyz;
// dirRad/strength/speed are SCENE-level (the free lightCounts.yzw slots); time = scene seconds.
fn foliageWindOffset(localPos: vec3<f32>, originWorld: vec3<f32>, windHeight: f32, stiffness: f32,
                     amount: f32, dirRad: f32, strength: f32, speed: f32, time: f32) -> vec3<f32> {
  if (amount <= 0.0 || strength <= 0.0) { return vec3<f32>(0.0); }
  // HEIGHT GRADING: the base stays planted (grade 0 at localY 0), the tip travels. stiffness is the
  // exponent — grass floppy ~1.2, hedge stiff ~3.
  let grade = pow(clamp(localPos.y / max(windHeight, 1e-3), 0.0, 1.0), max(stiffness, 0.05));
  if (grade <= 0.0) { return vec3<f32>(0.0); }
  let dir = vec2<f32>(cos(dirRad), sin(dirRad));
  // PER-INSTANCE PHASE hashed from the instance's WORLD TRANSLATION — a meadow never pulses in unison,
  // and no extra per-instance data is needed (the model matrix already differs per copy).
  let phase = fq_hash12(floor(originWorld.xz * 7.31)) * 6.2831853;
  let t = time * max(speed, 0.0);
  // TRAVELLING GUSTS: a low-frequency wave moving ACROSS the world along the wind direction, so the wind
  // visibly sweeps through a field instead of shimmering in place.
  let gust = 0.55 + 0.45 * sin(dot(originWorld.xz, dir) * 0.35 - t * 0.6);
  // TWO BANDS: a slow sway (the trunk-scale bend) + a faster ripple (the leaf/blade chatter).
  let sway   = sin(t * 1.10 + phase) * 0.75 + sin(t * 0.37 + phase * 1.7) * 0.25;
  let ripple = sin(t * 4.30 + phase * 2.3 + localPos.y * 3.1) * 0.28;
  let mag = strength * amount * grade * gust;
  let side = vec2<f32>(-dir.y, dir.x);
  let off = dir * (mag * (sway + ripple)) + side * (mag * ripple * 0.6);
  // A small downward pull keeps the tip on an arc instead of stretching the plant taller as it leans.
  return vec3<f32>(off.x, -abs(mag * sway) * 0.12 * grade, off.y);
}
`;

// ═══════════════════════════════════════════════════════════════════
//  VERTEX SHADER
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_VERTEX_SHADER = /* wgsl */ `
${FOLIAGE_WIND_WGSL}

// ── Per-mesh instance data (storage buffer) ─────────────────────

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,    // 64 bytes
  normalMatrix:   mat4x4<f32>,    // 64 bytes  (inverse-transpose of model for normals)
  diffuseColor:   vec4<f32>,      // 16 bytes  (r,g,b,a)
  specularColor:  vec4<f32>,      // 16 bytes  (r,g,b, shininess in .a)
  emissiveColor:  vec4<f32>,      // 16 bytes  (r,g,b, flags in .a)
  // flags.a: bit0 = hasTexture, bit1 = hasNormalMap, bits2-3 = renderStyle
  textureIndex:   u32,            //  4 bytes  layer index into diffuse texture_2d_array
  normalMapIndex: u32,            //  4 bytes  layer index into normal map texture_2d_array
  roughness:      f32,            //  4 bytes  PBR roughness (0 = mirror, 1 = rough)
  metalness:      f32,            //  4 bytes  PBR metalness (0 = dielectric, 1 = metal)
  patternColor:   vec4<f32>,      // 16 bytes  procedural pattern SECONDARY colour (primary = diffuseColor)
  patternParams:  vec4<f32>,      // 16 bytes  freq, angle, scale, spacing
                                  //  total 224 bytes
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

// ── Scene-wide uniforms ─────────────────────────────────────────

struct SceneUniforms {
  viewProjection: mat4x4<f32>,    // 64 bytes  (floats  0-15)
  cameraPosition: vec4<f32>,      // 16 bytes  (floats 16-19, .xyz = position)
  ambientColor: vec4<f32>,        // 16 bytes  (floats 20-23, .rgb = color, .a = intensity)
  lightDirection: vec4<f32>,      // 16 bytes  (floats 24-27, .xyz = dir, .w = intensity)
  lightColor: vec4<f32>,          // 16 bytes  (floats 28-31, .rgb = color)
  ps1Config: vec4<f32>,           // 16 bytes  (floats 32-35, .x=jitter .y=snapGrid .z=affine .w=colorDepth)
  resolution:       vec4<f32>,    // 16 bytes  (floats 36-39, .xy = render target pixels)
  lightSpaceMatrix: mat4x4<f32>,  // 64 bytes  (floats 40-55)
  shadowParams:     vec4<f32>,    // 16 bytes  (floats 56-59)
  fogColor:         vec4<f32>,    // 16 bytes  (floats 60-63, .rgb = fog color)
  fogParams:        vec4<f32>,    // 16 bytes  (floats 64-67, .x=near .y=far .z=density .w=mode)
  ps1Config2:       vec4<f32>,    // 16 bytes  (floats 68-71, .x=ditherStrength .y=uvQuantizeSteps .z=time .w=glass)
  lightCounts:      vec4<f32>,    // 16 bytes  (floats 72-75, .x = point-light count,
                                  //            .y = WIND direction (radians, xz) .z = wind strength .w = wind speed)
  pointLights:      array<vec4<f32>, 32>,   // 16 lights x 2 vec4s: (pos.xyz, radius) + (color.rgb, intensity)
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

// ── Vertex I/O ──────────────────────────────────────────────────

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) uv:       vec2<f32>,
  @location(3) tangent:  vec4<f32>,  // .xyz = tangent dir, .w = handedness
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color:     vec4<f32>,  // Gouraud-lit color (used when no normal map)
  @location(1) uv:        vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) worldPos:      vec3<f32>,  // for per-pixel lighting
  @location(4) worldNormal:   vec3<f32>,  // TBN: N
  @location(5) worldTangent:  vec3<f32>,  // TBN: T
  @location(6) worldBitangent:vec3<f32>,  // TBN: B
  // Same UV but interpolated WITHOUT perspective correction (PS1 affine warp).
  // The fragment blends this with the perspective uv by affineStrength.
  @location(7) @interpolate(linear) uvAffine: vec2<f32>,
  // Normalized LOCAL height (localY / windHeight, 0..1) — the foliage base-AO / ground-blend ramp (bit 20).
  // Same denominator as the wind grading, so the two agree. Meaningless (and unread) off foliage materials.
  @location(8) foliageY: f32,
};

// ── Helpers ─────────────────────────────────────────────────────

fn snapToGrid(pos: vec4<f32>, gridSize: f32) -> vec4<f32> {
  if (gridSize <= 0.0) { return pos; }
  var snapped = pos;
  let w = pos.w;
  let screenX = pos.x / w;
  let screenY = pos.y / w;
  let grid = gridSize;
  snapped.x = round(screenX * grid) / grid * w;
  snapped.y = round(screenY * grid) / grid * w;
  return snapped;
}

fn quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  let levels = depth;
  return floor(c * levels + 0.5) / levels;
}

// ── Main vertex shader ──────────────────────────────────────────

@vertex
fn vs_main(
  in: VertexInput,
  @builtin(instance_index) idx: u32
) -> VertexOutput {
  let inst = u_instances[idx];

  // ── FOLIAGE WIND (windSway, bit 19) — height-graded sway in LOCAL space, BEFORE the model transform,
  //    so each instanced copy bends about its own base. Phase is hashed from the model matrix's world
  //    translation (per-instance, no extra data). See foliageWindOffset / foliage-quality.md S1.
  var localPos = in.position;
  let vFlags = bitcast<u32>(inst.emissiveColor.a);
  if ((vFlags & 524288u) != 0u) {
    let originW = vec3<f32>(inst.modelMatrix[3].x, inst.modelMatrix[3].y, inst.modelMatrix[3].z);
    localPos = localPos + foliageWindOffset(in.position, originW,
      inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
      scene.lightCounts.y, scene.lightCounts.z, scene.lightCounts.w, scene.ps1Config2.z);
  }

  let worldPos4   = inst.modelMatrix * vec4<f32>(localPos, 1.0);
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);

  // Clip-space position
  var clipPos = scene.viewProjection * worldPos4;

  // PS1 vertex jitter
  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // ── Gouraud lighting (always computed; used when hasNormalMap = 0) ──

  var lit = inst.diffuseColor.rgb * scene.ambientColor.rgb * scene.ambientColor.a;
  let L = normalize(-scene.lightDirection.xyz);
  let NdotL = max(dot(worldNormal, L), 0.0);
  lit += inst.diffuseColor.rgb * scene.lightColor.rgb * scene.lightDirection.w * NdotL;
  let V = normalize(scene.cameraPosition.xyz - worldPos4.xyz);
  let H = normalize(L + V);
  let shininess = inst.specularColor.a;
  let spec = pow(max(dot(worldNormal, H), 0.0), max(shininess, 1.0));
  lit += inst.specularColor.rgb * scene.lightColor.rgb * spec;
  lit += inst.emissiveColor.rgb;
  let colorDepth = scene.ps1Config.w;
  if (colorDepth > 0.0) { lit = quantizeColor(lit, colorDepth); }

  // ── TBN for normal mapping ──────────────────────────────────
  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
  // Gram-Schmidt re-orthogonalize
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos       = clipPos;
  out.color         = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  out.uv            = in.uv;
  out.uvAffine      = in.uv;   // perspective-free copy for PS1 affine warp
  out.instanceIdx   = idx;
  out.worldPos      = worldPos4.xyz;
  out.worldNormal   = worldNormal;
  out.worldTangent  = T;
  out.worldBitangent = B;
  out.foliageY      = clamp(in.position.y / max(inst.patternParams.x, 1e-3), 0.0, 1.0);
  return out;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  FRAGMENT SHADER — textured (with optional normal map + render styles)
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_FRAGMENT_SHADER = /* wgsl */ `

${STYLE_WGSL_FUNCTIONS}
${PBR_IBL_WGSL}

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissiveColor:  vec4<f32>,
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
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
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

// SSAO ambient-occlusion buffer (docs/specs/ssao.md). Screen-space, sampled at this pixel and multiplied into the
// AMBIENT term ONLY (direct sun is already shadow-mapped). 1×1 white is bound when SSAO is off → exact no-op.
@group(0) @binding(3) var ssaoTexture: texture_2d<f32>;
@group(0) @binding(4) var ssaoSampler: sampler;

@group(1) @binding(0) var diffuseTexture:   texture_2d_array<f32>;
@group(1) @binding(1) var diffuseSampler:   sampler;
@group(1) @binding(2) var normalMapTexture: texture_2d_array<f32>;
@group(1) @binding(3) var normalMapSampler: sampler;
// GARP dedicated pool atlas (docs/specs/city-props-garp.md). A GARP_TEX-flagged mesh reads its skin here at
// the SAME per-instance textureIndex, instead of the diffuse atlas. Sampled unconditionally + select()ed below
// so textureSample stays in uniform control flow (a per-instance branch condition would fail WGSL uniformity).
@group(1) @binding(4) var garpTexture: texture_2d_array<f32>;

//__SHADOW_BINDINGS__

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

@fragment
fn fs_main(
  @builtin(position)              fragPos:      vec4<f32>,
  @location(0)                    gouraudColor: vec4<f32>,
  @location(1)                    uv:           vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx:  u32,
  @location(3)                    worldPos:     vec3<f32>,
  @location(4)                    worldNormal:  vec3<f32>,
  @location(5)                    worldTangent: vec3<f32>,
  @location(6)                    worldBitangent: vec3<f32>,
  @location(7) @interpolate(linear) uvAffine:   vec2<f32>,
  @location(8)                    foliageY:     f32,
) -> @location(0) vec4<f32> {
  let inst        = u_instances[instanceIdx];
  let flags       = bitcast<u32>(inst.emissiveColor.a);
  let hasTexture   = (flags & 1u) != 0u;
  let hasNormalMap = (flags & 2u) != 0u;
  let renderStyle  = (flags >> 2u) & 7u;
  let alphaCutout  = (flags & 32u) != 0u;
  let hairSheen    = (flags & 64u) != 0u;
  let rimEnabled   = (flags & 128u) != 0u;
  let sparkleOn    = (flags & 256u) != 0u;
  let starSparkle  = (flags & 4096u) != 0u;
  let patMode      = (flags >> 9u) & 7u;
  let texOverBase  = (flags & 32768u) != 0u;
  let garpTex      = (flags & 16777216u) != 0u;   // bit 24: sample the dedicated GARP pool atlas, not diffuse

  // Procedural pattern → the base albedo (primary = diffuse, secondary = patternColor). AA'd in-shader (no shimmer).
  // ALL fwidth-using helpers (patternMask ×3 for the relief gradient, windowsPattern) run UNCONDITIONALLY so
  // fwidth stays in uniform control flow; their results are gated afterwards.
  let patMask = patternMask(uv, patMode, inst.patternParams, scene.ps1Config2.z);
  let pEps = 0.35 / max(inst.patternParams.x, 0.001);
  let patMaskR = patternMask(uv + vec2<f32>(pEps, 0.0), patMode, inst.patternParams, scene.ps1Config2.z);
  let patMaskU = patternMask(uv + vec2<f32>(0.0, pEps), patMode, inst.patternParams, scene.ps1Config2.z);
  let winWL = windowsPattern(uv, inst.patternParams, scene.ps1Config2.z);
  // Ground tiling works in METRES, not uv — see gr_uvMetres. dpdx/dpdy demand uniform control flow, so
  // this runs for every fragment (a handful of ALU ops) and is consumed inside the groundShade branch.
  let gUvM = gr_uvMetres(uv, worldPos);
  var patBase = mix(inst.diffuseColor.rgb, inst.patternColor.rgb, patMask);
  var emissiveRGB = inst.emissiveColor.rgb;
  var roughOverride = inst.roughness;   // ground shading (bit 18) overrides this; default = the material roughness
  if (patMode == 6u) {
    // windows: brick/concrete wall → INTERIOR-MAPPED rooms behind the glass (parallax; lit cells glow per-texel).
    let ws = windowShade(uv, inst.patternParams, winWL, worldPos, worldNormal, scene.cameraPosition.xyz,
                         inst.diffuseColor.rgb, inst.patternColor.rgb, inst.emissiveColor.rgb, scene.ps1Config2.z);
    patBase = ws.base;
    emissiveRGB = ws.emk;
  } else if (patMode == 7u) {
    emissiveRGB = emissiveRGB * (0.3 + 1.5 * patMask);   // animated bands carry the glow (neon screens / shimmer water)
  }

  let L = normalize(-scene.lightDirection.xyz);
  let V = normalize(scene.cameraPosition.xyz - worldPos);

  // PS1 affine texture mapping — blend perspective-correct uv toward the
  // non-perspective (linear) uvAffine by affineStrength, so textures warp on
  // angled/large polys the way PS1 hardware did.
  var sampUv = mix(uv, uvAffine, clamp(scene.ps1Config.z, 0.0, 1.0));
  // UV quantization — snap UVs to a texel grid before sampling (PS1 texel crawl).
  let uvQSteps = scene.ps1Config2.y;
  if (uvQSteps > 0.5) {
    sampUv = floor(sampUv * uvQSteps) / uvQSteps;
  }

  // Sample textures unconditionally — textureSample requires uniform control flow.
  // GARP: also sample the pool atlas unconditionally, then select() by the per-instance flag (no branch around
  // the sample → uniformity holds). Non-GARP fragments pay one extra fetch into the 1×1/small GARP atlas
  // (cache-hot); it's discarded by the select. Reuses diffuseSampler (same filtering + format).
  let diffSample   = textureSample(diffuseTexture,   diffuseSampler,   sampUv, i32(inst.textureIndex));
  let garpSample   = textureSample(garpTexture,      diffuseSampler,   sampUv, i32(inst.textureIndex));
  let texSample    = select(diffSample, garpSample, garpTex);
  let normalSample = textureSample(normalMapTexture, normalMapSampler, sampUv, i32(inst.normalMapIndex));

  // Alpha-test cutout (alpha-card hair): drop transparent strand texels. Order-independent (no blending).
  // Samples above are unconditional → uniform; the discard after them is fine.
  if (alphaCutout && texSample.a < 0.5) { discard; }

  // Resolve surface normal
  var N = normalize(worldNormal);
  if (hasNormalMap) {
    let mapN = normalSample.xyz * 2.0 - 1.0;
    N = normalize(worldTangent * mapN.x + worldBitangent * mapN.y + worldNormal * mapN.z);
  }

  // PATTERN RELIEF + GRAIN (modes 1-6): a micro normal perturbation from the procedural mask gradient so seams
  // groove, tiles step, and WINDOW REVEALS catch raking light (openings read recessed, sills/frames bevel) instead
  // of flat paint, plus a subtle world-stable value grain on the tiled modes. Reuses the 3x patternMask samples.
  if (patMode >= 1u && patMode <= 6u) {
    var Tb = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let tbl = length(Tb);
    let flat_ = tbl <= 1e-3;
    Tb = select(Tb / max(tbl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), flat_);
    let Bb = select(cross(N, Tb), vec3<f32>(0.0, 0.0, 1.0), flat_);
    // windows (mode 6): a SOFTER groove — interior mapping already conveys the depth; this just bevels the reveal.
    let reliefK = select(1.3, 0.85, patMode == 6u);
    N = normalize(N + (Tb * (patMask - patMaskR) + Bb * (patMask - patMaskU)) * reliefK);
    if (patMode <= 5u) {
      patBase = patBase * (0.95 + 0.10 * fract(sin(dot(floor(uv * 260.0), vec2<f32>(12.9898, 78.233))) * 43758.5453));
    }
  }
  if (patMode == 6u) {
    // FACADE ROUGHNESS: a gentle stucco-facet normal dither on the masonry between the windows (not the
    // glass) — walls catch the light unevenly instead of reading as flat paint. World-stable hash cells.
    var Tw2 = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let twl = length(Tw2);
    if (twl > 1e-3) {
      Tw2 = Tw2 / twl;
      let Bw2 = cross(N, Tw2);
      let gc = floor(uv * 140.0);
      let g1 = fract(sin(dot(gc, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
      let g2 = fract(sin(dot(gc, vec2<f32>(39.3468, 11.135))) * 24634.6345) - 0.5;
      N = normalize(N + (Tw2 * g1 + Bw2 * g2) * 0.22 * (1.0 - winWL.x));
      // STRUCTURED MASONRY RELIEF: brick courses / concrete panel seams GROOVE so the wall reads as 3-D material,
      // not painted brick. Sampled at a fine FIXED eps (brick-scale; no fwidth → uniform-safe) — the window-cell
      // relief eps above is far too coarse to resolve courses. On the masonry only (1 - winWL.x = not the glass).
      let mEps = 0.014 / max(inst.patternParams.x, 0.001);
      // CENTERED difference (both sides of uv). A forward difference (uv+eps only) biases the relief HALF A STEP in
      // the +eps direction — up the wall for the y term — so the grooves read as sitting ABOVE the painted mortar
      // (user spotted this). Centering removes the bias so the relief lands ON the courses. 2x magnitude → half k.
      let mhL = wallMasonryH(uv - vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhR = wallMasonryH(uv + vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhD = wallMasonryH(uv - vec2<f32>(0.0, mEps), inst.patternParams);
      let mhU = wallMasonryH(uv + vec2<f32>(0.0, mEps), inst.patternParams);
      N = normalize(N + (Tw2 * (mhL - mhR) + Bw2 * (mhD - mhU)) * (0.42 * (1.0 - winWL.x)));
    }
  }

  // BOARD GRAIN (boardShade, bit 16 — packaging paperboard): a faint two-scale paper-fiber value
  // grain on the BASE colour, applied BEFORE the texOverBase artwork composite so painted strokes
  // stay clean on top (the grain is the board, not the ink). Instance slots are repurposed here
  // (packaging panels never use patterns): patternColor = (rimU, rimV, rimStrength, grainAmp),
  // patternParams = this panel's UV rect in the dieline texture.
  let boardShade = (flags & 65536u) != 0u;
  if (boardShade) {
    patBase = patBase * paperGrain(uv, inst.patternColor.a);
  }

  // DECAL-OVER-BASE (texOverBase, bit 15): composite the diffuse texture OVER the base albedo by its
  // alpha BEFORE lighting — albedo = mix(base, tex.rgb, tex.a) — so a transparent texel shows the base
  // material and painted strokes are lit like paint ON the surface (the packaging dieline-over-kraft
  // blend). The post-lighting multiply below is skipped for this mode, and texture alpha never thins
  // the surface (an empty transparent layer renders the plain base material, not black).
  if (hasTexture && texOverBase) {
    patBase = mix(patBase, texSample.rgb, texSample.a);
  }

  // BOARD EDGE RIM (same bit 16): darken toward the panel's UV-rect borders so panels read as THICK
  // board, not paper. Applied AFTER the artwork composite (a real board edge shades the ink too).
  // Edge distance is normalized per axis by patternColor.rg = rim width in dieline-UV units (~1.6 mm).
  if (boardShade) {
    let rect = inst.patternParams;
    let dEdge = vec2<f32>(min(uv.x - rect.x, rect.z - uv.x), min(uv.y - rect.y, rect.w - uv.y));
    let eN = min(dEdge.x / max(inst.patternColor.r, 1e-5), dEdge.y / max(inst.patternColor.g, 1e-5));
    patBase = patBase * (1.0 - inst.patternColor.b * (1.0 - smoothstep(0.0, 1.0, clamp(eN, 0.0, 1.0))));
  }

  // PROCEDURAL GROUND (groundShade, bit 18): a standalone surface (ashlar/radialMedallion/borderStrip/grass).
  // Exclusive with pattern/board/texOverBase (a mesh is a ground tile OR a panel). Slots repurposed:
  // patternColor = (seamR, seamG, seamB, groutWidthUv) — seam = grout (tilers) OR dirt tint (grass);
  // patternParams = (p0, p1, jitter, groundMode) — p0/p1 = tileW/H · ring/wedge · stoneLen/rowW.
  let groundShade = (flags & 262144u) != 0u;
  if (groundShade) {
    let gSeam = inst.patternColor.rgb;
    let gGroutW = inst.patternColor.a;
    let gP0 = inst.patternParams.x;
    let gP1 = inst.patternParams.y;
    let gJit = inst.patternParams.z;
    // groundMode packs METRES PER WORLD UNIT: mode + 100 * round(scale * 10). 0 = a standalone mesh
    // authored 1 unit = 1 m whose uv is a 0..1 region. Non-zero = part of a scaled WORLD (the city is a
    // diorama at 1 unit = 15 m), which means two things at once:
    //   · gr_uvMetres yields world UNITS per uv, so the metric coordinate must be multiplied by the scale
    //     or every tile size and noise frequency is off by exactly that factor;
    //   · the uv is a world parameterisation (city ground = worldXZ * 0.5, so neighbouring road/pavement
    //     meshes tile continuously), so the P2 masks need a world-scaled coordinate and must drop the
    //     edge/corner term — gr_edgeMask would otherwise saturate to 1 across the whole city.
    // See Material3D.groundWorldScale.
    let gScale10 = floor(inst.patternParams.w / 100.0);
    let gMode = inst.patternParams.w - gScale10 * 100.0;
    let gIsWorld = gScale10 > 0.0;
    let gUnitM = select(1.0, gScale10 * 0.1, gIsWorld);   // metres per world unit
    let gMaskC = select(uv, uv * 0.02, gIsWorld);         // world mode: ~1 mask cycle per 45 m
    let gEdgeAmt = select(1.0, 0.0, gIsWorld);            // a continuous ground has no region border
    let gUvMs = gUvM * gUnitM;                            // METRES per uv unit (uvM alone is world units)
    // P2 WEATHERING — specularColor repurposed: .r = profile (0-4), .gba = wear center uv + radius.
    let gPc = vec2<f32>(inst.specularColor.g, inst.specularColor.b);
    let gPr = inst.specularColor.a;
    let g0 = groundSurface(uv, gUvMs, gMaskC, gMode, inst.diffuseColor.rgb, gSeam, gGroutW, gP0, gP1, gJit, gPc, gPr);
    let gW = groundWeather(g0, gMaskC, gEdgeAmt, inst.specularColor.r, gPc, gPr);
    patBase = gW.rgb;
    roughOverride = gW.rough;
    // HEIGHT -> NORMAL relief. ★ The epsilon must resolve the GROUT GROOVE, not the tile. It used to be a
    // fraction of the tile size (0.15 * 0.6 m = 9 cm, against a 1.5 cm seam), and the difference was
    // ONE-SIDED — so the shading responded both where this fragment sat in the groove AND where the
    // fragment 9 cm away did, drawing a SECOND ghost seam a fixed distance from every real one. That is
    // the "duplicate grout line", and it showed on all three tilers (including borderStrip, which has no
    // running bond) precisely because it comes from the relief, not from the tiling.
    // Now: CENTRAL differences at ~one grout width. Symmetric (no shift) and landing on the actual groove,
    // so the seam still reads recessed and bevelled — just once.
    let gP = uv * gUvMs;
    let gE = max(gGroutW * 0.9, 0.002);
    let hL = groundHeightM(gP - vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
    let hR = groundHeightM(gP + vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
    let hD = groundHeightM(gP - vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
    let hU = groundHeightM(gP + vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
    var Tg = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let tgl = length(Tg);
    let gflat = tgl <= 1e-3;
    Tg = select(Tg / max(tgl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), gflat);
    let Bg = select(cross(N, Tg), vec3<f32>(0.0, 0.0, 1.0), gflat);
    N = normalize(N + (Tg * (hL - hR) + Bg * (hD - hU)) * 0.3);
  }

  // PAINTED METAL (metalShade, bit 23) — albedo + roughness; lighting does the rest.
  let metalShade = (flags & 8388608u) != 0u;
  if (metalShade) {
    let mS = metalSurface(worldPos, N, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                          inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                          inst.patternParams.w);
    patBase = mS.rgb;
    roughOverride = mS.rough;
  }

  // NEON / SCREEN (neonShade, bit 22) — emissive-only: it replaces the emissive term, not the albedo.
  let neonShade = (flags & 4194304u) != 0u;
  if (neonShade) {
    emissiveRGB = neonSign(uv, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                           inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                           inst.patternParams.w, scene.ps1Config2.z);
    patBase = inst.diffuseColor.rgb * 0.35;   // the unlit panel body behind the glow
  }

  // WATER (waterShade, bit 21). Exclusive with pattern/board/ground/foliage — a mesh is one of them.
  // Slots: patternColor = (deep.rgb, packed shallow), patternParams = (waveScale, waveSpeed, choppy, glitter).
  // The reflection tint is the scene FOG colour, so water tracks the sky through the day/night cycle.
  let waterShade = (flags & 2097152u) != 0u;
  var waterGlint = 0.0;
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

  // FOLIAGE SHADE (foliageShade, bit 20 — foliage-quality S2): base AO + ground-colour bleed on the
  // ALBEDO (so they are lit, not pasted on), and the leaf TRANSMISSION which is added AFTER lighting so it
  // composes with the rim. Slots: patternColor = (translucency, groundBlend, baseAO, packedGroundTint),
  // patternParams = (windHeight, windStiffness, windAmount, packedTranslucencyColor).
  let foliageShade = (flags & 1048576u) != 0u;
  var fqTrans = vec3<f32>(0.0);
  if (foliageShade) {
    patBase = foliageBase(patBase, foliageY, inst.patternColor.b, inst.patternColor.g, fq_unpackRGB(inst.patternColor.a));
    fqTrans = foliageTransmission(N, L, V, fq_unpackRGB(inst.patternParams.w), inst.patternColor.r,
                                  scene.lightColor.rgb, scene.lightDirection.w);
  }

  var lit: vec3<f32>;

  if (renderStyle == 1u) {
    lit = cel_lighting(
      patBase, inst.specularColor.rgb, inst.specularColor.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else if (renderStyle == 2u) {
    lit = sketch_lighting(
      patBase, N, L, worldPos,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else if (renderStyle == 3u) {
    lit = ink_lighting(
      patBase, N, L, V,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else if (renderStyle == 4u) {
    // ── Gouraud — per-vertex lighting (computed in VS), no per-pixel PBR ──
    lit = gouraudColor.rgb;
  } else if (renderStyle == 5u) {
    // ── Cel-HD — cel's flat stepped diffuse + a smooth glossy specular ──
    lit = cel_hd_lighting(
      patBase, inst.specularColor.rgb, inst.specularColor.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else if (renderStyle == 6u) {
    // ── Unlit — output the albedo directly, UNAFFECTED by scene lighting (UI cards / labels / overlays) ──
    lit = patBase;
  } else {
    // ── Cook-Torrance PBR ─────────────────────────────────────
    let roughness = max(roughOverride, 0.04);
    let metalness = inst.metalness;
    let albedo    = patBase;
    let F0        = mix(vec3<f32>(0.04), albedo, metalness);

    let H     = normalize(L + V);
    let NdotL = max(dot(N, L), 0.0);
    let NdotV = max(dot(N, V), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let HdotV = max(dot(H, V), 0.0);

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
    // Environment specular: metals reflect the surroundings (chrome/gold) instead of going black; dielectrics get a
    // faint grazing sheen. This is the per-material light response that makes a metal chain read as metal.
    ambient = ambient + envSpecular(N, V, F0, roughness, NdotV, iblOn, ibl.iblIntensity, ambFlat, L, scene.lightColor.rgb, scene.lightDirection.w);

    // colorDepth is applied to the FINAL color (after texture) below, not here.
    // SSAO: multiply AMBIENT only (not directLight — the sun is shadow-mapped). textureSampleLevel (explicit LOD)
    // is legal in non-uniform control flow. 1×1 white when SSAO off → ×1 no-op.
    let ssaoAO = textureSampleLevel(ssaoTexture, ssaoSampler, fragPos.xy / max(scene.resolution.xy, vec2<f32>(1.0)), 0.0).r;
    lit = directLight + ambient * ssaoAO + emissiveRGB;
  }

  // Anisotropic hair sheen (Kajiya-Kay): a highlight band ALONG the strands. The strand tangent is the mesh
  // tangent (= the hair generator's stored flow direction — meridian on the cap → the crown highlight ring,
  // spine along the tails; transformed by the skin so it tracks the posed head). Intensity = specularColor.rgb,
  // tightness = specularColor.a; only on the lit side.
  if (hairSheen) {
    let tl = length(worldTangent);
    let strandT = worldTangent / max(tl, 1e-4);
    let Hs   = normalize(L + V);
    let tDotH = dot(strandT, Hs);
    let sinTH = sqrt(max(0.0, 1.0 - tDotH * tDotH));
    let sheenAmt = pow(sinTH, max(1.0, inst.specularColor.a)) * max(dot(N, L), 0.0);
    lit = lit + inst.specularColor.rgb * sheenAmt * scene.lightColor.rgb * scene.lightDirection.w;
  }

  // Rim light (silhouette back-light glow) — render-style-independent modifier; Fresnel edge tinted by the
  // scene light, stronger where the key light doesn't hit (backlit). Layers on top of any style.
  if (rimEnabled) {
    let rimF = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    let backlit = mix(0.35, 1.0, 1.0 - max(dot(N, L), 0.0));
    lit = lit + rimF * backlit * 0.42 * scene.lightColor.rgb;
  }

  // LEAF TRANSMISSION (bit 20) — added ON TOP of the lit result, right after the rim so the two COMPOSE
  // (rim = silhouette Fresnel, transmission = light through the blade). This is the backlit-grass glow.
  // ★ HEADROOM-GATED: a SHADOWED backlit leaf (lit low → headroom high) still glows, but a leaf that is
  // already brightly lit (headroom near 0) can't be pushed past white. Without this the sun-facing canopy
  // blew out to white — the transmission + rim were pure additive light with no ceiling.
  lit = lit + fqTrans * clamp(1.0 - max(lit.r, max(lit.g, lit.b)), 0.0, 1.0);
  // WATER glitter is added AFTER lighting: it is a specular scintillation off the ripple normal,
  // not an albedo term, so it must not be multiplied by the diffuse response.
  lit = lit + scene.lightColor.rgb * waterGlint;

  // Sparkle / glint — sparse twinkling micro-glints (the metal "glisten in the light"). Scintillates as the camera /
  // light move; twinkles over scene time (ps1Config2.z). Bright + light-tinted so it reads as a reflection.
  if (sparkleOn || starSparkle) {
    var spk = 0.0;
    if (starSparkle) { spk = sparkleStar(worldPos, N, scene.ps1Config2.z, 45.0); }          // ✦ anime star bling
    else             { spk = sparkleGlint(worldPos, N, normalize(L + V), scene.ps1Config2.z, 150.0); }   // fine glint
    lit = lit + spk * scene.lightColor.rgb * scene.lightDirection.w * 3.5;
  }

  // POINT LIGHTS (street lamps at night): additive lambert with a smooth radius falloff � moving cars,
  // walkers and walls entering a lamp's radius pick up its warm pool. PBR / cel / cel-HD paths only.
  if (renderStyle == 0u || renderStyle == 1u || renderStyle == 5u) {
    var plAdd = vec3<f32>(0.0);
    let plN = min(i32(scene.lightCounts.x), 16);
    for (var pi = 0; pi < plN; pi++) {
      let lp = scene.pointLights[pi * 2];
      let lc = scene.pointLights[pi * 2 + 1];
      let dv = lp.xyz - worldPos;
      let d = length(dv);
      let att = clamp(1.0 - d / max(lp.w, 1e-3), 0.0, 1.0);
      let ndl = max(dot(N, dv / max(d, 1e-4)), 0.0);
      plAdd = plAdd + lc.rgb * (lc.a * att * att * (0.3 + 0.7 * ndl));
    }
    lit = lit + patBase * plAdd;
  }
  //__SHADOW_APPLY__

  var finalColor = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);

  if (hasTexture && !texOverBase) {   // texOverBase already composited the texture into the albedo pre-lighting
    if (renderStyle == 2u) {
      finalColor = vec4<f32>(mix(finalColor.rgb, finalColor.rgb * texSample.rgb, 0.5), finalColor.a * texSample.a);
    } else {
      finalColor = vec4<f32>(finalColor.rgb * texSample.rgb, finalColor.a * texSample.a);
    }
  }

  if (finalColor.a < 0.01) { discard; }
  let fogMode = u32(scene.fogParams.w);
  if (fogMode != 0u && renderStyle != 6u) {   // unlit (UI cards) ignore atmospheric fog
    let fogDist = length(scene.cameraPosition.xyz - worldPos);
    var fogFactor: f32;
    if (fogMode == 1u) {
      fogFactor = clamp((fogDist - scene.fogParams.x) / max(scene.fogParams.y - scene.fogParams.x, 0.001), 0.0, 1.0);
    } else {
      fogFactor = 1.0 - exp(-scene.fogParams.z * fogDist);
    }
    finalColor = vec4<f32>(mix(finalColor.rgb, scene.fogColor.rgb, fogFactor), finalColor.a);
  }

  // PS1 color-depth quantization — applied to the FINAL color (after texture + fog)
  // so it bands the actual output, including textured and non-PBR surfaces (the
  // old version quantized only the PBR lighting pre-texture, so it was invisible
  // on textured meshes).
  let cd = scene.ps1Config.w;
  if (cd > 0.0 && renderStyle != 6u) {   // unlit (UI cards) keep crisp full-range colour
    if (scene.ps1Config2.x > 0.0) {
      finalColor = vec4<f32>(quantizeColorDithered(finalColor.rgb, cd, fragPos), finalColor.a);
    } else {
      finalColor = vec4<f32>(quantizeColor(finalColor.rgb, cd), finalColor.a);
    }
  }
  return finalColor;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  VERTEX SHADER — vertex color (slot 1 float32x4 per-vertex color)
// ═══════════════════════════════════════════════════════════════════

/**
 * Vertex shader variant for EditMesh vertex-painted geometry.
 * Identical to MESH3D_VERTEX_SHADER except it reads a per-vertex RGBA color
 * from @location(4) (a second vertex buffer slot, stride 16) and uses it
 * in place of inst.diffuseColor.rgb for Gouraud lighting.
 * Fragment shader: reuse MESH3D_FRAGMENT_SHADER_UNTEXTURED unchanged.
 */
export const MESH3D_VERTEX_SHADER_VERTEX_COLOR = /* wgsl */ `
${FOLIAGE_WIND_WGSL}

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissiveColor:  vec4<f32>,
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
};

@group(0) @binding(0)
var<storage, read> u_instances: array<MeshInstance>;

struct SceneUniforms {
  viewProjection:   mat4x4<f32>,
  cameraPosition:   vec4<f32>,
  ambientColor:     vec4<f32>,
  lightDirection:   vec4<f32>,
  lightColor:       vec4<f32>,
  ps1Config:        vec4<f32>,
  resolution:       vec4<f32>,
  lightSpaceMatrix: mat4x4<f32>,
  shadowParams:     vec4<f32>,
  fogColor:         vec4<f32>,
  fogParams:        vec4<f32>,
  ps1Config2:       vec4<f32>,
  lightCounts:      vec4<f32>,
  pointLights:      array<vec4<f32>, 32>,
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

struct VertexInput {
  @location(0) position:    vec3<f32>,
  @location(1) normal:      vec3<f32>,
  @location(2) uv:          vec2<f32>,
  @location(3) tangent:     vec4<f32>,
  @location(4) vertexColor: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color:      vec4<f32>,
  @location(1) uv:         vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx: u32,
  @location(3) worldPos:       vec3<f32>,
  @location(4) worldNormal:    vec3<f32>,
  @location(5) worldTangent:   vec3<f32>,
  @location(6) worldBitangent: vec3<f32>,
  // location 7 is reserved (uvAffine in the main VS); 8 = the foliage local-height ramp, which the SHARED
  // untextured fragment shader reads — both vertex shaders that pair with it must output it at 8.
  @location(8) foliageY:       f32,
};

fn vc_snapToGrid(pos: vec4<f32>, gridSize: f32) -> vec4<f32> {
  if (gridSize <= 0.0) { return pos; }
  var snapped = pos;
  let w = pos.w;
  snapped.x = round(pos.x / w * gridSize) / gridSize * w;
  snapped.y = round(pos.y / w * gridSize) / gridSize * w;
  return snapped;
}

fn vc_quantizeColor(c: vec3<f32>, depth: f32) -> vec3<f32> {
  if (depth <= 0.0) { return c; }
  return floor(c * depth + 0.5) / depth;
}

@vertex
fn vs_main(
  in: VertexInput,
  @builtin(instance_index) idx: u32
) -> VertexOutput {
  let inst = u_instances[idx];

  // FOLIAGE WIND (bit 19) — same local-space, height-graded displacement as the main VS.
  var localPos = in.position;
  let vFlags = bitcast<u32>(inst.emissiveColor.a);
  if ((vFlags & 524288u) != 0u) {
    let originW = vec3<f32>(inst.modelMatrix[3].x, inst.modelMatrix[3].y, inst.modelMatrix[3].z);
    localPos = localPos + foliageWindOffset(in.position, originW,
      inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
      scene.lightCounts.y, scene.lightCounts.z, scene.lightCounts.w, scene.ps1Config2.z);
  }

  let worldPos4   = inst.modelMatrix * vec4<f32>(localPos, 1.0);
  let worldNormal = normalize((inst.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);

  var clipPos = scene.viewProjection * worldPos4;

  let jitter   = scene.ps1Config.x;
  let gridSize = scene.ps1Config.y;
  if (jitter > 0.0 && gridSize > 0.0) {
    clipPos = vc_snapToGrid(clipPos, gridSize * (1.0 - jitter) + gridSize * jitter);
  }

  // Gouraud lighting — use per-vertex color instead of instance diffuse color
  let vcol = in.vertexColor;
  var lit = vcol.rgb * scene.ambientColor.rgb * scene.ambientColor.a;
  let L = normalize(-scene.lightDirection.xyz);
  let NdotL = max(dot(worldNormal, L), 0.0);
  lit += vcol.rgb * scene.lightColor.rgb * scene.lightDirection.w * NdotL;
  let V = normalize(scene.cameraPosition.xyz - worldPos4.xyz);
  let H = normalize(L + V);
  let shininess = inst.specularColor.a;
  let spec = pow(max(dot(worldNormal, H), 0.0), max(shininess, 1.0));
  lit += inst.specularColor.rgb * scene.lightColor.rgb * spec;
  lit += inst.emissiveColor.rgb;
  let colorDepth = scene.ps1Config.w;
  if (colorDepth > 0.0) { lit = vc_quantizeColor(lit, colorDepth); }

  let worldTangent3 = normalize((inst.normalMatrix * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
  let T = normalize(worldTangent3 - dot(worldTangent3, worldNormal) * worldNormal);
  let B = cross(worldNormal, T) * in.tangent.w;

  var out: VertexOutput;
  out.clipPos        = clipPos;
  out.color          = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), vcol.a);
  out.uv             = in.uv;
  out.instanceIdx    = idx;
  out.worldPos       = worldPos4.xyz;
  out.worldNormal    = worldNormal;
  out.worldTangent   = T;
  out.worldBitangent = B;
  out.foliageY       = clamp(in.position.y / max(inst.patternParams.x, 1e-3), 0.0, 1.0);
  return out;
}
`;

// ═══════════════════════════════════════════════════════════════════
//  UNTEXTURED FRAGMENT SHADER — Gouraud/style, no texture group needed
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_FRAGMENT_SHADER_UNTEXTURED = /* wgsl */`

${STYLE_WGSL_FUNCTIONS}
${PBR_IBL_WGSL}

struct MeshInstance {
  modelMatrix:    mat4x4<f32>,
  normalMatrix:   mat4x4<f32>,
  diffuseColor:   vec4<f32>,
  specularColor:  vec4<f32>,
  emissiveColor:  vec4<f32>,
  textureIndex:   u32,
  normalMapIndex: u32,
  roughness:      f32,
  metalness:      f32,
  patternColor:   vec4<f32>,
  patternParams:  vec4<f32>,
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
};

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

// SSAO ambient-occlusion buffer (docs/specs/ssao.md) — multiplied into the AMBIENT term only. 1×1 white when off.
@group(0) @binding(3) var ssaoTexture: texture_2d<f32>;
@group(0) @binding(4) var ssaoSampler: sampler;

//__SHADOW_BINDINGS__

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

// One pointed-almond leaf at centre c, rotated ang, scaled sc, over the card UV. Coverage 0..1 (no fwidth → the
// discard it feeds is safe in non-uniform flow).
fn leafLobe(uv: vec2<f32>, c: vec2<f32>, ang: f32, sc: f32) -> f32 {
  let d = (uv - c) / sc;
  let ca = cos(ang); let sa = sin(ang);
  let q = vec2<f32>(d.x * ca - d.y * sa, d.x * sa + d.y * ca);      // leaf-local; q.y = length axis in [-1,1]
  let ly = clamp(q.y * 0.5 + 0.5, 0.0, 1.0);                        // 0 base .. 1 tip
  let hw = 0.5 * pow(sin(ly * 3.14159), 0.6);
  let body = smoothstep(-0.06, 0.06, hw - abs(q.x));
  let ends = step(-1.0, q.y) * step(q.y, 1.0);
  return body * ends;
}
// LEAF-CLUSTER silhouette: a small SPRIG of ~5 leaves over the 0..1 card UV — one card = a clump of leaves (the
// technique real foliage layers through a volume), not a single leaf. Returns coverage 0..1.
fn leafCluster(uv: vec2<f32>) -> f32 {
  var m = leafLobe(uv, vec2<f32>(0.50, 0.54), 0.00, 0.44);
  m = max(m, leafLobe(uv, vec2<f32>(0.33, 0.42), 0.85, 0.34));
  m = max(m, leafLobe(uv, vec2<f32>(0.67, 0.44), -0.85, 0.34));
  m = max(m, leafLobe(uv, vec2<f32>(0.42, 0.67), 0.55, 0.30));
  m = max(m, leafLobe(uv, vec2<f32>(0.60, 0.65), -0.55, 0.30));
  return m;
}

@fragment
fn fs_main(
  @builtin(position)              fragPos:      vec4<f32>,
  @location(0)                    gouraudColor: vec4<f32>,
  @location(1)                    uv:           vec2<f32>,
  @location(2) @interpolate(flat) instanceIdx:  u32,
  @location(3)                    worldPos:     vec3<f32>,
  @location(4)                    worldNormal:  vec3<f32>,
  @location(8)                    foliageY:     f32,
) -> @location(0) vec4<f32> {
  let inst        = u_instances[instanceIdx];
  let flags       = bitcast<u32>(inst.emissiveColor.a);
  let renderStyle = (flags >> 2u) & 7u;
  let rimEnabled  = (flags & 128u) != 0u;
  let sparkleOn   = (flags & 256u) != 0u;
  let starSparkle = (flags & 4096u) != 0u;
  let leafCard    = (flags & 8192u) != 0u;
  let glassEnhance = (flags & 16384u) != 0u;
  let patMode     = (flags >> 9u) & 7u;
  let boardShade  = (flags & 65536u) != 0u;
  let radialFade  = (flags & 131072u) != 0u;

  // Procedural pattern → the base albedo; AA'd in-shader. fwidth helpers unconditional → uniform control flow.
  let patMask = patternMask(uv, patMode, inst.patternParams, scene.ps1Config2.z);
  let pEps = 0.35 / max(inst.patternParams.x, 0.001);
  let patMaskR = patternMask(uv + vec2<f32>(pEps, 0.0), patMode, inst.patternParams, scene.ps1Config2.z);
  let patMaskU = patternMask(uv + vec2<f32>(0.0, pEps), patMode, inst.patternParams, scene.ps1Config2.z);
  let winWL = windowsPattern(uv, inst.patternParams, scene.ps1Config2.z);
  // Ground tiling works in METRES, not uv — see gr_uvMetres. dpdx/dpdy demand uniform control flow, so
  // this runs for every fragment (a handful of ALU ops) and is consumed inside the groundShade branch.
  let gUvM = gr_uvMetres(uv, worldPos);
  var patBase = mix(inst.diffuseColor.rgb, inst.patternColor.rgb, patMask);
  var emissiveRGB = inst.emissiveColor.rgb;
  var roughOverride = inst.roughness;   // ground shading (bit 18) overrides this; default = the material roughness
  if (patMode == 6u) {
    // windows: INTERIOR-MAPPED rooms behind the glass (see windowShade) — parallax depth per window.
    let ws = windowShade(uv, inst.patternParams, winWL, worldPos, worldNormal, scene.cameraPosition.xyz,
                         inst.diffuseColor.rgb, inst.patternColor.rgb, inst.emissiveColor.rgb, scene.ps1Config2.z);
    patBase = ws.base;
    emissiveRGB = ws.emk;
  } else if (patMode == 7u) {
    emissiveRGB = emissiveRGB * (0.3 + 1.5 * patMask);
  }

  // BOARD SHADING (bit 16, packaging paperboard — untextured panels, e.g. a box before its dieline
  // links): paper-fiber grain + panel-border rim darkening. Slots as in the textured FS:
  // patternColor = (rimU, rimV, rimStrength, grainAmp), patternParams = the panel's dieline-UV rect.
  if (boardShade) {
    patBase = patBase * paperGrain(uv, inst.patternColor.a);
    let rect = inst.patternParams;
    let dEdge = vec2<f32>(min(uv.x - rect.x, rect.z - uv.x), min(uv.y - rect.y, rect.w - uv.y));
    let eN = min(dEdge.x / max(inst.patternColor.r, 1e-5), dEdge.y / max(inst.patternColor.g, 1e-5));
    patBase = patBase * (1.0 - inst.patternColor.b * (1.0 - smoothstep(0.0, 1.0, clamp(eN, 0.0, 1.0))));
  }

  // LEAF CARD: cut the quad to a leaf silhouette (alpha-test, order-independent) + a midrib/edge shade. Placed AFTER
  // the fwidth pattern helpers above (they ran uniformly) so the discard doesn't make a later derivative non-uniform.
  if (leafCard) {
    let leaf = leafCluster(uv);
    if (leaf < 0.5) { discard; }
    // per-card shade: darker toward the base (uv.y low) + a touch darker at leaf edges → leafy depth (Ghibli-ish
    // when combined with the cel style + rim). Random card orientation makes the uv.y gradient read as variation.
    patBase = patBase * (0.72 + 0.4 * uv.y) * (0.86 + 0.14 * smoothstep(0.5, 0.95, leaf));
  }

  let L = normalize(-scene.lightDirection.xyz);
  let V = normalize(scene.cameraPosition.xyz - worldPos);
  var N = normalize(worldNormal);

  // PATTERN RELIEF + GRAIN (modes 1-6, incl. window-reveal groove) — see the main FS for the rationale.
  if (patMode >= 1u && patMode <= 6u) {
    var Tb = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let tbl = length(Tb);
    let flat_ = tbl <= 1e-3;
    Tb = select(Tb / max(tbl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), flat_);
    let Bb = select(cross(N, Tb), vec3<f32>(0.0, 0.0, 1.0), flat_);
    let reliefK = select(1.3, 0.85, patMode == 6u);
    N = normalize(N + (Tb * (patMask - patMaskR) + Bb * (patMask - patMaskU)) * reliefK);
    if (patMode <= 5u) {
      patBase = patBase * (0.95 + 0.10 * fract(sin(dot(floor(uv * 260.0), vec2<f32>(12.9898, 78.233))) * 43758.5453));
    }
  }
  if (patMode == 6u) {
    // FACADE ROUGHNESS: a gentle stucco-facet normal dither on the masonry between the windows (not the
    // glass) — walls catch the light unevenly instead of reading as flat paint. World-stable hash cells.
    var Tw2 = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let twl = length(Tw2);
    if (twl > 1e-3) {
      Tw2 = Tw2 / twl;
      let Bw2 = cross(N, Tw2);
      let gc = floor(uv * 140.0);
      let g1 = fract(sin(dot(gc, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
      let g2 = fract(sin(dot(gc, vec2<f32>(39.3468, 11.135))) * 24634.6345) - 0.5;
      N = normalize(N + (Tw2 * g1 + Bw2 * g2) * 0.22 * (1.0 - winWL.x));
      // STRUCTURED MASONRY RELIEF: brick courses / concrete panel seams GROOVE so the wall reads as 3-D material,
      // not painted brick. Sampled at a fine FIXED eps (brick-scale; no fwidth → uniform-safe) — the window-cell
      // relief eps above is far too coarse to resolve courses. On the masonry only (1 - winWL.x = not the glass).
      let mEps = 0.014 / max(inst.patternParams.x, 0.001);
      // CENTERED difference (both sides of uv). A forward difference (uv+eps only) biases the relief HALF A STEP in
      // the +eps direction — up the wall for the y term — so the grooves read as sitting ABOVE the painted mortar
      // (user spotted this). Centering removes the bias so the relief lands ON the courses. 2x magnitude → half k.
      let mhL = wallMasonryH(uv - vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhR = wallMasonryH(uv + vec2<f32>(mEps, 0.0), inst.patternParams);
      let mhD = wallMasonryH(uv - vec2<f32>(0.0, mEps), inst.patternParams);
      let mhU = wallMasonryH(uv + vec2<f32>(0.0, mEps), inst.patternParams);
      N = normalize(N + (Tw2 * (mhL - mhR) + Bw2 * (mhD - mhU)) * (0.42 * (1.0 - winWL.x)));
    }
  }

  // PROCEDURAL GROUND (groundShade, bit 18 — ashlar/radial/border/grass) — see the textured FS for the rationale.
  // Slots: patternColor = (seamRGB, groutWidthUv), patternParams = (p0, p1, jitter, groundMode).
  let groundShade = (flags & 262144u) != 0u;
  if (groundShade) {
    let gSeam = inst.patternColor.rgb;
    let gGroutW = inst.patternColor.a;
    let gP0 = inst.patternParams.x;
    let gP1 = inst.patternParams.y;
    let gJit = inst.patternParams.z;
    // groundMode packs METRES PER WORLD UNIT: mode + 100 * round(scale * 10). 0 = a standalone mesh
    // authored 1 unit = 1 m whose uv is a 0..1 region. Non-zero = part of a scaled WORLD (the city is a
    // diorama at 1 unit = 15 m), which means two things at once:
    //   · gr_uvMetres yields world UNITS per uv, so the metric coordinate must be multiplied by the scale
    //     or every tile size and noise frequency is off by exactly that factor;
    //   · the uv is a world parameterisation (city ground = worldXZ * 0.5, so neighbouring road/pavement
    //     meshes tile continuously), so the P2 masks need a world-scaled coordinate and must drop the
    //     edge/corner term — gr_edgeMask would otherwise saturate to 1 across the whole city.
    // See Material3D.groundWorldScale.
    let gScale10 = floor(inst.patternParams.w / 100.0);
    let gMode = inst.patternParams.w - gScale10 * 100.0;
    let gIsWorld = gScale10 > 0.0;
    let gUnitM = select(1.0, gScale10 * 0.1, gIsWorld);   // metres per world unit
    let gMaskC = select(uv, uv * 0.02, gIsWorld);         // world mode: ~1 mask cycle per 45 m
    let gEdgeAmt = select(1.0, 0.0, gIsWorld);            // a continuous ground has no region border
    let gUvMs = gUvM * gUnitM;                            // METRES per uv unit (uvM alone is world units)
    let gPc = vec2<f32>(inst.specularColor.g, inst.specularColor.b);
    let gPr = inst.specularColor.a;
    let g0 = groundSurface(uv, gUvMs, gMaskC, gMode, inst.diffuseColor.rgb, gSeam, gGroutW, gP0, gP1, gJit, gPc, gPr);
    // P2 WEATHERING — specularColor repurposed: .r = profile (0-4), .gba = wear center uv + radius.
    let gW = groundWeather(g0, gMaskC, gEdgeAmt, inst.specularColor.r, gPc, gPr);
    patBase = gW.rgb;
    roughOverride = gW.rough;
    // Relief: CENTRAL differences at ~one grout width — see the textured shader for why a tile-sized
    // one-sided epsilon drew a ghost seam beside every real one.
    let gP = uv * gUvMs;
    let gE = max(gGroutW * 0.9, 0.002);
    let hL = groundHeightM(gP - vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
    let hR = groundHeightM(gP + vec2<f32>(gE, 0.0), gUvMs, gMode, gGroutW, gP0, gP1);
    let hD = groundHeightM(gP - vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
    let hU = groundHeightM(gP + vec2<f32>(0.0, gE), gUvMs, gMode, gGroutW, gP0, gP1);
    var Tg = cross(vec3<f32>(0.0, 1.0, 0.0), N);
    let tgl = length(Tg);
    let gflat = tgl <= 1e-3;
    Tg = select(Tg / max(tgl, 1e-4), vec3<f32>(1.0, 0.0, 0.0), gflat);
    let Bg = select(cross(N, Tg), vec3<f32>(0.0, 0.0, 1.0), gflat);
    N = normalize(N + (Tg * (hL - hR) + Bg * (hD - hU)) * 0.3);
  }

  // PAINTED METAL (metalShade, bit 23) — albedo + roughness; lighting does the rest.
  let metalShade = (flags & 8388608u) != 0u;
  if (metalShade) {
    let mS = metalSurface(worldPos, N, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                          inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                          inst.patternParams.w);
    patBase = mS.rgb;
    roughOverride = mS.rough;
  }

  // NEON / SCREEN (neonShade, bit 22) — emissive-only: it replaces the emissive term, not the albedo.
  let neonShade = (flags & 4194304u) != 0u;
  if (neonShade) {
    emissiveRGB = neonSign(uv, inst.patternColor.rgb, fq_unpackRGB(inst.patternColor.a),
                           inst.patternParams.x, inst.patternParams.y, inst.patternParams.z,
                           inst.patternParams.w, scene.ps1Config2.z);
    patBase = inst.diffuseColor.rgb * 0.35;   // the unlit panel body behind the glow
  }

  // WATER (waterShade, bit 21). Exclusive with pattern/board/ground/foliage — a mesh is one of them.
  // Slots: patternColor = (deep.rgb, packed shallow), patternParams = (waveScale, waveSpeed, choppy, glitter).
  // The reflection tint is the scene FOG colour, so water tracks the sky through the day/night cycle.
  let waterShade = (flags & 2097152u) != 0u;
  var waterGlint = 0.0;
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

  // FOLIAGE SHADE (foliageShade, bit 20 — foliage-quality S2): base AO + ground-colour bleed on the albedo;
  // the leaf TRANSMISSION is added after lighting (below) so it composes with the rim. See the textured FS.
  let foliageShade = (flags & 1048576u) != 0u;
  var fqTrans = vec3<f32>(0.0);
  if (foliageShade) {
    patBase = foliageBase(patBase, foliageY, inst.patternColor.b, inst.patternColor.g, fq_unpackRGB(inst.patternColor.a));
    fqTrans = foliageTransmission(N, L, V, fq_unpackRGB(inst.patternParams.w), inst.patternColor.r,
                                  scene.lightColor.rgb, scene.lightDirection.w);
  }

  var lit: vec3<f32>;
  if (renderStyle == 1u) {
    lit = cel_lighting(
      patBase, inst.specularColor.rgb, inst.specularColor.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else if (renderStyle == 2u) {
    lit = sketch_lighting(
      patBase, N, L, worldPos,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else if (renderStyle == 3u) {
    lit = ink_lighting(
      patBase, N, L, V,
      scene.ambientColor.a, scene.lightDirection.w,
    );
  } else if (renderStyle == 4u) {
    // ── Gouraud — per-vertex lighting (computed in VS), no per-pixel PBR ──
    lit = gouraudColor.rgb;
  } else if (renderStyle == 5u) {
    // ── Cel-HD — cel's flat stepped diffuse + a smooth glossy specular ──
    lit = cel_hd_lighting(
      patBase, inst.specularColor.rgb, inst.specularColor.a,
      N, L, V,
      scene.ambientColor.rgb, scene.ambientColor.a,
      scene.lightColor.rgb,   scene.lightDirection.w,
      emissiveRGB,
    );
  } else if (renderStyle == 6u) {
    // ── Unlit — output the albedo directly, UNAFFECTED by scene lighting (UI cards / labels / overlays) ──
    lit = patBase;
  } else {
    // ── Cook-Torrance PBR ─────────────────────────────────────
    let roughness = max(roughOverride, 0.04);
    let metalness = inst.metalness;
    let albedo    = patBase;
    let F0        = mix(vec3<f32>(0.04), albedo, metalness);

    let H     = normalize(L + V);
    let NdotL = max(dot(N, L), 0.0);
    let NdotV = max(dot(N, V), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let HdotV = max(dot(H, V), 0.0);

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
    // Environment specular: metals reflect the surroundings (chrome/gold) instead of going black; dielectrics get a
    // faint grazing sheen. This is the per-material light response that makes a metal chain read as metal.
    ambient = ambient + envSpecular(N, V, F0, roughness, NdotV, iblOn, ibl.iblIntensity, ambFlat, L, scene.lightColor.rgb, scene.lightDirection.w);

    // SSAO: multiply AMBIENT only (see textured FS). 1×1 white when SSAO off → ×1 no-op.
    let ssaoAO = textureSampleLevel(ssaoTexture, ssaoSampler, fragPos.xy / max(scene.resolution.xy, vec2<f32>(1.0)), 0.0).r;
    var total = directLight + ambient * ssaoAO + emissiveRGB;
    let cd = scene.ps1Config.w;
    if (cd > 0.0) {
      if (scene.ps1Config2.x > 0.0) {
        total = quantizeColorUntexDithered(total, cd, fragPos);
      } else {
        total = quantizeColorUntex(total, cd);
      }
    }
    lit = total;
  }

  // Rim light (silhouette back-light glow) — render-style-independent modifier; Fresnel edge tinted by the
  // scene light, stronger where the key light doesn't hit (backlit). Layers on top of any style.
  if (rimEnabled) {
    let rimF = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    let backlit = mix(0.35, 1.0, 1.0 - max(dot(N, L), 0.0));
    lit = lit + rimF * backlit * 0.42 * scene.lightColor.rgb;
  }

  // LEAF TRANSMISSION (bit 20) — added right after the rim so the two COMPOSE (backlit grass glow).
  // ★ HEADROOM-GATED: a SHADOWED backlit leaf (lit low → headroom high) still glows, but a leaf that is
  // already brightly lit (headroom near 0) can't be pushed past white. Without this the sun-facing canopy
  // blew out to white — the transmission + rim were pure additive light with no ceiling.
  lit = lit + fqTrans * clamp(1.0 - max(lit.r, max(lit.g, lit.b)), 0.0, 1.0);
  // WATER glitter is added AFTER lighting: it is a specular scintillation off the ripple normal,
  // not an albedo term, so it must not be multiplied by the diffuse response.
  lit = lit + scene.lightColor.rgb * waterGlint;

  // Sparkle / glint — sparse twinkling micro-glints (the metal "glisten in the light"). See the textured fragment.
  if (sparkleOn || starSparkle) {
    var spk = 0.0;
    if (starSparkle) { spk = sparkleStar(worldPos, N, scene.ps1Config2.z, 45.0); }          // ✦ anime star bling
    else             { spk = sparkleGlint(worldPos, N, normalize(L + V), scene.ps1Config2.z, 150.0); }   // fine glint
    lit = lit + spk * scene.lightColor.rgb * scene.lightDirection.w * 3.5;
  }

  // POINT LIGHTS (street lamps at night): additive lambert with a smooth radius falloff — moving cars,
  // walkers and walls entering a lamp's radius pick up its warm pool. PBR / cel / cel-HD paths only.
  if (renderStyle == 0u || renderStyle == 1u || renderStyle == 5u) {
    var plAdd = vec3<f32>(0.0);
    let plN = min(i32(scene.lightCounts.x), 16);
    for (var pi = 0; pi < plN; pi++) {
      let lp = scene.pointLights[pi * 2];
      let lc = scene.pointLights[pi * 2 + 1];
      let dv = lp.xyz - worldPos;
      let d = length(dv);
      let att = clamp(1.0 - d / max(lp.w, 1e-3), 0.0, 1.0);
      let ndl = max(dot(N, dv / max(d, 1e-4)), 0.0);
      plAdd = plAdd + lc.rgb * (lc.a * att * att * (0.3 + 0.7 * ndl));
    }
    lit = lit + patBase * plAdd;
  }

  // ENHANCED-VISUALS · STYLIZED GLASS: a fresnel sky-reflection on glass surfaces (curtain walls / storefronts), so
  // towers catch the sky and read as glass instead of flat blue paint. Gated by the global glass toggle
  // (ps1Config2.w) so it falls back to the plain look for performance. Style-independent (sits on top of lit).
  let winGlass = patMode == 6u && winWL.x > 0.5;   // a WINDOW opening is glass too → let it catch the sky (fixes "windows look flat")
  if ((glassEnhance || winGlass) && scene.ps1Config2.w > 0.5) {
    let R = reflect(-V, N);
    // ★ Reflect the SCENE's sky, not a hardcoded daytime blue. The fog colour is keyed to the time of day
    // by the day/night cycle and the cinematic grade, so glass now goes warm at dusk and dark at night
    // instead of staying noon-blue at midnight. (Same source the water reflection uses.)
    let skyC = scene.fogColor.rgb;
    // HORIZON SPLIT — glass reflects bright sky ABOVE the horizon and the darker ground BELOW it. Blending
    // two blues across the whole hemisphere (what this did) loses the horizon line that makes a tall
    // facade read as reflective rather than painted.
    let up = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
    let ground = skyC * 0.42;
    let sky = mix(ground, skyC * 1.12, smoothstep(0.42, 0.62, up)) * (0.55 + 0.9 * scene.lightColor.rgb);
    // Reflectivity vs view angle. A higher BASE (0.30) means panes catch the sky even head-on (not only at
    // grazing angles), and the softer exponent (2.0 vs 4.0) widens the falloff so mid-angle facades read as
    // glass too — fixes "window effects only show up at very low viewing angles".
    let fres = 0.30 + 0.70 * pow(1.0 - max(dot(N, V), 0.0), 2.0);
    // PER-PANE VARIATION — real glazing is never perfectly coplanar, so neighbouring panes catch the sky
    // at slightly different angles. Without it a curtain wall reads as one printed gradient.
    let pane = 0.92 + 0.16 * pg_hash21(floor(worldPos.xz * 6.3 + vec2<f32>(worldPos.y * 4.1)));
    // SUN GLINT — the sharp mirror of the sun off a pane. The single most recognisable glass cue, and the
    // reason a glazed facade flashes as the camera orbits.
    let glint = pow(max(dot(R, L), 0.0), 320.0) * 1.4;
    lit = mix(lit, sky * pane, fres * select(0.6, 0.45, winGlass));
    lit = lit + scene.lightColor.rgb * glint * fres;
  }
  //__SHADOW_APPLY__

  var finalColor = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), inst.diffuseColor.a);
  // RADIAL FADE (bit 17): soft circular alpha falloff from the UV centre — the packaging stage
  // CONTACT-SHADOW blob (a dark ground quad grounding the box; edges dissolve to nothing).
  if (radialFade) {
    let rd = length(uv - vec2<f32>(0.5, 0.5)) * 2.0;
    let fade = 1.0 - smoothstep(0.2, 1.0, rd);
    finalColor = vec4<f32>(finalColor.rgb, finalColor.a * fade * fade);
  }
  if (finalColor.a < 0.01) { discard; }
  let fogMode = u32(scene.fogParams.w);
  if (fogMode != 0u) {
    let fogDist = length(scene.cameraPosition.xyz - worldPos);
    var fogFactor: f32;
    if (fogMode == 1u) {
      fogFactor = clamp((fogDist - scene.fogParams.x) / max(scene.fogParams.y - scene.fogParams.x, 0.001), 0.0, 1.0);
    } else {
      fogFactor = 1.0 - exp(-scene.fogParams.z * fogDist);
    }
    // ENHANCED-VISUALS · AERIAL PERSPECTIVE: distant geometry DESATURATES with distance before fading to the (pale-
    // blue) fog colour → the vast atmospheric-depth look. Strength = fogColor.w (0 = plain fog). Fog must be on.
    let aerial = scene.fogColor.w;
    if (aerial > 0.0) {
      let lum = dot(finalColor.rgb, vec3<f32>(0.299, 0.587, 0.114));
      finalColor = vec4<f32>(mix(finalColor.rgb, vec3<f32>(lum), fogFactor * aerial * 0.75), finalColor.a);
    }
    finalColor = vec4<f32>(mix(finalColor.rgb, scene.fogColor.rgb, fogFactor), finalColor.a);
  }
  return finalColor;
}
`;


// ═══════════════════════════════════════════════════════════════════
//  SHADOW-RECEIVING VARIANTS of the modern fragment shaders
// ═══════════════════════════════════════════════════════════════════
// Built by marker substitution so the FULL modern feature set (patterns, interiors, relief, point lights,
// PBR/styles) RECEIVES shadows — the legacy gouraud shadow FS predates all of it. lightSpacePos is computed
// in-fragment from worldPos (no VS change). shadowParams.w = PCF penumbra width multiplier (soft shadows).
// The emissive part is restored un-shadowed (neon must not dim inside a building's shadow).

const SHADOW_SAMPLE_WGSL = (group: number): string => /* wgsl */ `
@group(${group}) @binding(0) var shadowMap:     texture_depth_2d;
@group(${group}) @binding(1) var shadowSampler: sampler_comparison;

fn sampleShadow(lightSpacePos: vec4<f32>) -> f32 {
  let ndc = lightSpacePos.xyz / lightSpacePos.w;
  let suv = vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));
  let inRange   = suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0;
  let clampedUV = clamp(suv, vec2<f32>(0.0), vec2<f32>(1.0));
  let depth = ndc.z - scene.shadowParams.y;
  let mapSize = max(scene.shadowParams.z, 1.0);
  let soft = select(1.0, scene.shadowParams.w, scene.shadowParams.w > 0.01);   // penumbra width multiplier
  let texel = soft / mapSize;
  // PCF QUALITY TIER (shadowParams.x): 0 = default radius 2 (5x5 = 25 taps, unchanged look), 1 = fast 3x3
  // (9 taps, ~2.7x fewer compares per lit fragment - a big win on city-scale fill). Set via setShadowQuality.
  let r = select(2, i32(scene.shadowParams.x), scene.shadowParams.x > 0.5);
  var shadow = 0.0;
  for (var dy = -r; dy <= r; dy++) {
    for (var dx = -r; dx <= r; dx++) {
      shadow += textureSampleCompare(shadowMap, shadowSampler, clampedUV + vec2<f32>(f32(dx), f32(dy)) * texel, depth);
    }
  }
  let taps = f32((2 * r + 1) * (2 * r + 1));
  return select(1.0, shadow / taps, inRange);
}
`;

const SHADOW_APPLY_WGSL = /* wgsl */ `
  // RECEIVE the sun shadow (PCF above). Emissive light is restored un-shadowed.
  // The in-shadow light floor is scene.resolution.z (shadow darkness): 0.42 default, lower = darker (host-tunable).
  let shadowFactor = sampleShadow(scene.lightSpaceMatrix * vec4<f32>(worldPos, 1.0));
  let shadowMul = mix(scene.resolution.z, 1.0, shadowFactor);
  lit = lit * shadowMul + emissiveRGB * (1.0 - shadowMul);
`;

export const MESH3D_FRAGMENT_SHADER_SHADOW_MODERN = MESH3D_FRAGMENT_SHADER
    .replace('//__SHADOW_BINDINGS__', SHADOW_SAMPLE_WGSL(2))
    .replace('//__SHADOW_APPLY__', SHADOW_APPLY_WGSL);

export const MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN = MESH3D_FRAGMENT_SHADER_UNTEXTURED
    .replace('//__SHADOW_BINDINGS__', SHADOW_SAMPLE_WGSL(1))
    .replace('//__SHADOW_APPLY__', SHADOW_APPLY_WGSL);
