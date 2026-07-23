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
  let brick = mix(1.08, 0.86 + 0.15 * btint, brickMask);   // joints LIGHTER than the bricks (real mortar)
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
`;

// ═══════════════════════════════════════════════════════════════════
//  VERTEX SHADER
// ═══════════════════════════════════════════════════════════════════

export const MESH3D_VERTEX_SHADER = /* wgsl */ `

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
  ps1Config2:       vec4<f32>,    // 16 bytes  (floats 68-71, .x=ditherStrength .y=uvQuantizeSteps)
  lightCounts:      vec4<f32>,    // 16 bytes  (floats 72-75, .x = point-light count)
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

  let worldPos4   = inst.modelMatrix * vec4<f32>(in.position, 1.0);
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

@group(1) @binding(0) var diffuseTexture:   texture_2d_array<f32>;
@group(1) @binding(1) var diffuseSampler:   sampler;
@group(1) @binding(2) var normalMapTexture: texture_2d_array<f32>;
@group(1) @binding(3) var normalMapSampler: sampler;

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

  // Procedural pattern → the base albedo (primary = diffuse, secondary = patternColor). AA'd in-shader (no shimmer).
  // ALL fwidth-using helpers (patternMask ×3 for the relief gradient, windowsPattern) run UNCONDITIONALLY so
  // fwidth stays in uniform control flow; their results are gated afterwards.
  let patMask = patternMask(uv, patMode, inst.patternParams, scene.ps1Config2.z);
  let pEps = 0.35 / max(inst.patternParams.x, 0.001);
  let patMaskR = patternMask(uv + vec2<f32>(pEps, 0.0), patMode, inst.patternParams, scene.ps1Config2.z);
  let patMaskU = patternMask(uv + vec2<f32>(0.0, pEps), patMode, inst.patternParams, scene.ps1Config2.z);
  let winWL = windowsPattern(uv, inst.patternParams, scene.ps1Config2.z);
  var patBase = mix(inst.diffuseColor.rgb, inst.patternColor.rgb, patMask);
  var emissiveRGB = inst.emissiveColor.rgb;
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
  let texSample    = textureSample(diffuseTexture,   diffuseSampler,   sampUv, i32(inst.textureIndex));
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
  } else {
    // ── Cook-Torrance PBR ─────────────────────────────────────
    let roughness = max(inst.roughness, 0.04);
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
    lit = directLight + ambient + emissiveRGB;
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
    lit = lit + rimF * backlit * 0.6 * scene.lightColor.rgb;
  }

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
  if (fogMode != 0u) {
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
  if (cd > 0.0) {
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

  let worldPos4   = inst.modelMatrix * vec4<f32>(in.position, 1.0);
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
  var patBase = mix(inst.diffuseColor.rgb, inst.patternColor.rgb, patMask);
  var emissiveRGB = inst.emissiveColor.rgb;
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
    }
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
  } else {
    // ── Cook-Torrance PBR ─────────────────────────────────────
    let roughness = max(inst.roughness, 0.04);
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

    var total = directLight + ambient + emissiveRGB;
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
    lit = lit + rimF * backlit * 0.6 * scene.lightColor.rgb;
  }

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
    let up = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
    let sky = mix(vec3<f32>(0.52, 0.63, 0.80), vec3<f32>(0.40, 0.58, 0.92), up) * (0.55 + 0.9 * scene.lightColor.rgb);
    let fres = 0.14 + 0.86 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
    lit = mix(lit, sky, fres * select(0.6, 0.45, winGlass));   // windows a touch subtler than curtain walls
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
  let shadowFactor = sampleShadow(scene.lightSpaceMatrix * vec4<f32>(worldPos, 1.0));
  let shadowMul = mix(0.42, 1.0, shadowFactor);
  lit = lit * shadowMul + emissiveRGB * (1.0 - shadowMul);
`;

export const MESH3D_FRAGMENT_SHADER_SHADOW_MODERN = MESH3D_FRAGMENT_SHADER
    .replace('//__SHADOW_BINDINGS__', SHADOW_SAMPLE_WGSL(2))
    .replace('//__SHADOW_APPLY__', SHADOW_APPLY_WGSL);

export const MESH3D_FRAGMENT_SHADER_UNTEXTURED_SHADOW_MODERN = MESH3D_FRAGMENT_SHADER_UNTEXTURED
    .replace('//__SHADOW_BINDINGS__', SHADOW_SAMPLE_WGSL(1))
    .replace('//__SHADOW_APPLY__', SHADOW_APPLY_WGSL);
