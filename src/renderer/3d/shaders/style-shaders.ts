/**
 * Stylised lighting functions shared by the 3D fragment shaders.
 *
 * Render styles (encoded in material flags bits 2-3):
 *   0 = default  — standard Phong/Gouraud (handled by existing code paths)
 *   1 = cel      — stepped diffuse bands + hard specular cutoff (toon/anime look)
 *   2 = sketch   — procedural crosshatch shading (pencil-drawn look)
 *   3 = ink      — flat base color + view-space rim darkening (manga ink look)
 *
 * These are pure WGSL functions injected as a string prefix into the fragment
 * shaders that need them. No new bind groups or pipeline changes required.
 */

import { CD_DISC_WGSL } from '../cd-disc/cd-disc-wgsl';

export const STYLE_WGSL_FUNCTIONS = /* wgsl */ `

// RENDER DEBUG safeLightingMath (render-debug.ts; ibl.dbgFlags bit 2 = value 4). The mesh fragment shaders set this
// at the top of fs_main; every other module that splices these functions leaves it false, which keeps the original
// maths. Used ONLY through select(), so it never shapes control flow (uniformity) and off = exactly today's result.
var<private> rdSafeMath: bool = false;
// pow with a base that may dip below 0 by rounding (1 - dot of unit vectors): pow(x, y) is undefined for x < 0
// (often exp2(y * log2(x)) = NaN on mobile GPUs, while desktop compilers expand small integer powers to x * x * x).
fn rdPow(x: f32, y: f32) -> f32 {
  return select(pow(x, y), pow(max(x, 1e-6), y), rdSafeMath);
}
// normalize of a vector that may be (near) zero: normalize(0) is undefined (NaN / Inf on some GPUs).
fn rdNormalize(v: vec3<f32>) -> vec3<f32> {
  return select(normalize(v), v * inverseSqrt(max(dot(v, v), 1e-12)), rdSafeMath);
}
// a dot of two unit vectors, which rounding can push a few ulp past 1; safe mode clamps it into 0..1.
fn rdDot01(a: vec3<f32>, b: vec3<f32>) -> f32 {
  let d = max(dot(a, b), 0.0);
  return select(d, min(d, 1.0), rdSafeMath);
}

// ── Cel shading ──────────────────────────────────────────────────
// Stepped diffuse (3 bands) + hard specular cutoff → cartoon / anime look.
fn cel_lighting(
    diffuse: vec3<f32>, specular: vec3<f32>, shininess: f32,
    N: vec3<f32>, L: vec3<f32>, V: vec3<f32>,
    ambientRgb: vec3<f32>, ambientI: f32,
    lightRgb: vec3<f32>, lightI: f32,
    emissive: vec3<f32>,
) -> vec3<f32> {
    var lit = diffuse * ambientRgb * ambientI;
    let NdotL   = max(dot(N, L), 0.0);
    let stepped = floor(NdotL * 3.0 + 0.01) / 3.0;   // 3 hard bands: shadow / mid / lit
    lit += diffuse * lightRgb * lightI * stepped;
    let H    = rdNormalize(L + V);
    let spec = step(0.97, pow(max(dot(N, H), 0.0), max(shininess, 1.0)));
    lit += specular * lightRgb * spec;
    lit += emissive;
    return lit;
}

// ── Cel-HD ───────────────────────────────────────────────────────
// Cel's stepped diffuse + a SMOOTH (Blinn-Phong) specular instead of the hard toon cutoff — the
// "flat shading + glossy highlight" hybrid for polished stylised characters.
fn cel_hd_lighting(
    diffuse: vec3<f32>, specular: vec3<f32>, shininess: f32,
    N: vec3<f32>, L: vec3<f32>, V: vec3<f32>,
    ambientRgb: vec3<f32>, ambientI: f32,
    lightRgb: vec3<f32>, lightI: f32,
    emissive: vec3<f32>,
) -> vec3<f32> {
    var lit = diffuse * ambientRgb * ambientI;
    let NdotL   = max(dot(N, L), 0.0);
    let stepped = floor(NdotL * 3.0 + 0.01) / 3.0;             // same 3 hard diffuse bands as cel
    lit += diffuse * lightRgb * lightI * stepped;
    let H    = rdNormalize(L + V);
    let spec = pow(max(dot(N, H), 0.0), max(shininess, 1.0));  // SMOOTH highlight (no hard step) → glossy
    lit += specular * lightRgb * spec * step(0.0001, NdotL);   // only on the lit side
    lit += emissive;
    return lit;
}

// ── Toon shadows (bit 30; also skinRamp materials in Cel) ────────
// Banded diffuse with a COLOURED shadow: the shadow tone is the diffuse colour times a tint, slightly saturated —
// the anime "multiply layer" shadow — instead of just a darker copy. p = (bands, softness, shadowValue, _),
// tintPacked = rgb 8:8:8, sat = shadow saturation boost. hdSpec: false = cel's hard specular dot, true = Cel-HD's
// smooth highlight. Same band maths as the skin ramp (skinRamp in mesh3d-shaders.ts).
fn toon_unpack_rgb8(v: f32) -> vec3<f32> {
    let r = floor(v / 65536.0);
    let g = floor((v - r * 65536.0) / 256.0);
    let b = v - r * 65536.0 - g * 256.0;
    return vec3<f32>(r, g, b) / 255.0;
}
fn toon_band(ndl: f32, bands: f32, soft: f32) -> f32 {
    let nb      = max(bands, 1.0);
    let stepped = floor(ndl * nb) / nb;
    let edge    = fract(ndl * nb);
    let s       = smoothstep(0.5 - max(soft, 0.001), 0.5 + max(soft, 0.001), edge);
    return clamp(mix(stepped, stepped + 1.0 / nb, s), 0.0, 1.0);
}
fn toon_lighting(
    diffuse: vec3<f32>, specular: vec3<f32>, shininess: f32,
    N: vec3<f32>, L: vec3<f32>, V: vec3<f32>,
    ambientRgb: vec3<f32>, ambientI: f32,
    lightRgb: vec3<f32>, lightI: f32,
    emissive: vec3<f32>,
    p: vec3<f32>, tintPacked: f32, sat: f32, hdSpec: bool,
) -> vec3<f32> {
    let NdotL  = max(dot(N, L), 0.0);
    let band   = toon_band(NdotL, p.x, p.y);
    var shadow = diffuse * toon_unpack_rgb8(tintPacked) * p.z;
    let sl     = dot(shadow, vec3<f32>(0.2126, 0.7152, 0.0722));
    shadow     = max(mix(vec3<f32>(sl), shadow, 1.0 + sat), vec3<f32>(0.0));
    var lit    = mix(shadow, diffuse, band) * (ambientRgb * ambientI + lightRgb * lightI);
    let H      = rdNormalize(L + V);
    let sp     = pow(max(dot(N, H), 0.0), max(shininess, 1.0));
    if (hdSpec) { lit += specular * lightRgb * sp * step(0.0001, NdotL); }
    else        { lit += specular * lightRgb * step(0.97, sp); }
    return lit + emissive;
}

// ── Parameterised rim light (rimEnabled materials when scene rimParams.x > 0) ──
// rp = (strength, width, hardness, colourPacked). Width = how far in from the silhouette; hardness blends a soft
// Fresnel falloff into a crisp toon edge. Stronger on the side the key light doesn't hit (back-lit), like the
// original rim.
fn rim_param(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, rp: vec4<f32>) -> vec3<f32> {
    let edge = 1.0 - max(dot(N, V), 0.0);
    let w    = clamp(rp.y, 0.02, 1.0);
    let soft = rdPow(edge, mix(8.0, 1.5, w));
    let hard = smoothstep(1.0 - w - 0.03, 1.0 - w + 0.03, edge);
    let m    = mix(soft, hard, clamp(rp.z, 0.0, 1.0));
    let backlit = mix(0.35, 1.0, 1.0 - max(dot(N, L), 0.0));
    return m * backlit * rp.x * toon_unpack_rgb8(rp.w);
}

// ── Sketch / crosshatch ──────────────────────────────────────────
// Simulates hand-drawn crosshatching: paper base colour with ink lines
// that grow denser as the surface turns away from the light.
fn sketch_lighting(
    diffuse: vec3<f32>,
    N: vec3<f32>, L: vec3<f32>,
    worldPos: vec3<f32>,
    ambientI: f32, lightI: f32,
    paperAmt: f32,
) -> vec3<f32> {
    let NdotL     = max(dot(N, L), 0.0);
    let intensity = clamp(ambientI + NdotL * lightI, 0.0, 1.0);

    // Three layers of hatching at increasing densities
    let sc   = 14.0;
    let p    = worldPos * sc;
    let h1   = step(0.55, fract(p.x + p.z));           // diagonal A
    let h2   = step(0.55, fract(p.x - p.z));           // diagonal B (cross)
    let h3   = step(0.55, fract(p.x * 0.7 + p.y));     // tertiary

    // Paper: off-white washed with the diffuse colour. paperAmt (scene styleParams.x): 1 = all paper, 0 = the full
    // colour (pencil hatching only). At the default 0.75 this is EXACTLY the original mix(paper, lifted, 0.25);
    // the small colour lift fades out with the paper so paperAmt 0 shows the true colour.
    let paperK = clamp(paperAmt, 0.0, 1.0);   // (not 'p' — that's the hatch coordinate above; WGSL forbids redeclaring)
    let lifted = mix(diffuse, diffuse * 0.9 + 0.1, min(1.0, paperK / 0.75));
    let paper  = mix(lifted, vec3<f32>(0.96, 0.94, 0.88), paperK);
    // Ink: very dark version of diffuse
    let ink    = diffuse * 0.12;

    // Progressively heavier hatching in shadow regions
    var hatch = 0.0;
    if (intensity < 0.18) { hatch = h1 * h2;         }   // dense crosshatch
    else if (intensity < 0.40) { hatch = h1 * h3;    }   // medium cross
    else if (intensity < 0.65) { hatch = h1 * 0.6;   }   // light hatch
    else if (intensity < 0.82) { hatch = h1 * 0.25;  }   // very light hatch

    return mix(paper, ink, hatch);
}

// ── Ink / manga ───────────────────────────────────────────────────
// Flat-shaded base colour with a sharp rim darkening at silhouette edges,
// producing the look of a manga or comic-book ink drawing.
fn ink_lighting(
    diffuse: vec3<f32>,
    N: vec3<f32>, L: vec3<f32>, V: vec3<f32>,
    ambientI: f32, lightI: f32,
) -> vec3<f32> {
    // Basic two-tone (lit / shadow) so the shape still reads
    let NdotL = max(dot(N, L), 0.0);
    let twoTone = mix(0.25, 1.0, step(0.35, NdotL * lightI + ambientI));
    var base = diffuse * twoTone;

    // Rim darkening at silhouette (where N·V → 0)
    let NdotV    = max(dot(N, V), 0.0);
    let rim      = 1.0 - NdotV;
    let rimFactor = rdPow(rim, 4.0);
    base = mix(base, diffuse * 0.05, rimFactor);

    return base;
}

// CD / iridescent disc (render style 7, the CD Kit disc): the shared CD_DISC_WGSL surface (Zucconi diffraction
// grating, radial rainbow, silver hub) + its print composite. On the FRONT face (frontFace) with a label texture, the
// label (already composited over the grey ink base by the caller) prints over the disc, outside the clear hub ring.
// lxy is the disc-plane position derived from UV (uv maps the disc to 0..1 centred at 0.5).
${CD_DISC_WGSL}
fn cd_lighting(
    N: vec3<f32>, L: vec3<f32>, V: vec3<f32>, uv: vec2<f32>,
    labelRGB: vec3<f32>, hasLabel: bool, frontFace: bool,
) -> vec3<f32> {
    let lxy = (uv - vec2<f32>(0.5)) * 2.0;   // disc-plane position, -1..1
    let r = length(lxy);
    let radial = normalize(lxy + vec2<f32>(1e-5, 0.0));
    let tangent = vec3<f32>(-radial.y, radial.x, 0.0);   // track tangent (disc ~unrotated in the kit)
    let uu = abs(dot(L, tangent) - dot(V, tangent));     // |sin thetaL - sin thetaV|
    var col = cd_disc_surface(N, L, V, r, uu);
    if (frontFace && hasLabel) { col = cd_print(col, labelRGB, 1.0, r); }   // printed label on the front only
    return col;
}
`;
