/**
 * src/renderer/3d/cd-disc/cd-disc-wgsl.ts
 *
 * The CD disc's surface + print maths, shared WGSL (no bindings): spliced into the engine's style library
 * (style-shaders.ts: cd_lighting, render style 7, the CD Kit disc) and into the Shell's FrogCart CD shader
 * (shell-cartridge.ts), so the two discs keep one look. It was duplicated between them until 2026-10-09.
 *
 *   cd_disc_surface  the bare disc: dark steel + a specular glint + Fresnel + Alan Zucconi's physically based
 *                    diffraction rainbow (radial: measured against the track tangent) + the silver hub ring
 *   cd_print         printed art over the disc, CD_PRINT_OPACITY strong, never inside the clear hub ring
 *                    (CD_DISC_ART_INNER_RATIO, the stacking-ring safe radius of a real printed CD)
 *
 * The callers differ only in how they get the track tangent (the Shell disc spins: model-space tangent; the kit
 * uses the unrotated disc) and in what shows through transparent art (Shell: the rainbow; kit: its grey ink base).
 * Keep the names spectral_zucconi6 / cd_lighting: shader-split.test.ts greps them. No backticks in the comments.
 */

import { CD_DISC_ART_INNER_RATIO } from './cd-disc-geometry';

/** How strongly printed art covers the disc (the rest is the disc's sheen showing through the ink). */
export const CD_PRINT_OPACITY = 0.85;

const f = (x: number): string => x.toFixed(4);

export const CD_DISC_WGSL = /* wgsl */ `
fn cd_bump3y(x: vec3<f32>, yoffset: vec3<f32>) -> vec3<f32> {
    return clamp((vec3<f32>(1.0) - x * x) - yoffset, vec3<f32>(0.0), vec3<f32>(1.0));
}
// Zucconi-6 spectral approximation: a visible wavelength (nm) to RGB.
fn spectral_zucconi6(w: f32) -> vec3<f32> {
    let x = clamp((w - 400.0) / 300.0, 0.0, 1.0);
    let c1 = vec3<f32>(3.54585104, 2.93225262, 2.41593945);
    let x1 = vec3<f32>(0.69549072, 0.49228336, 0.27699880);
    let y1 = vec3<f32>(0.02312639, 0.15225084, 0.52607955);
    let c2 = vec3<f32>(3.90307140, 3.21182957, 3.96587128);
    let x2 = vec3<f32>(0.11748627, 0.86755042, 0.66077860);
    let y2 = vec3<f32>(0.84897130, 0.88445281, 0.73949448);
    return cd_bump3y(c1 * (vec3<f32>(x) - x1), y1) + cd_bump3y(c2 * (vec3<f32>(x) - x2), y2);
}
// The diffraction rainbow for uu = |sin thetaL - sin thetaV| against the track tangent: the sum of every visible
// wavelength that satisfies the grating equation (orders 1..8, grating gap 2400 nm).
fn cd_rainbow(uu: f32) -> vec3<f32> {
    var rainbow = vec3<f32>(0.0);
    for (var k = 1; k <= 8; k = k + 1) {
        rainbow = rainbow + spectral_zucconi6(uu * 2400.0 / f32(k));
    }
    return clamp(rainbow, vec3<f32>(0.0), vec3<f32>(1.0));
}
// The bare disc at radius r (fraction of the outer radius): steel base, glint, Fresnel, the radial rainbow outside
// the hub, the silver clamping ring around the hole.
fn cd_disc_surface(N: vec3<f32>, L: vec3<f32>, V: vec3<f32>, r: f32, uu: f32) -> vec3<f32> {
    let fres = pow(max(1.0 - abs(dot(N, V)), 0.0), 3.0);
    var col = vec3<f32>(0.26, 0.28, 0.33);
    col = col + pow(max(0.0, dot(reflect(-L, N), V)), 24.0) * 0.5;   // specular glint
    col = col + fres * 0.18;
    col = col + cd_rainbow(uu) * smoothstep(0.33, 0.42, r);         // radial rainbow, outside the hub
    let hub = 1.0 - smoothstep(0.28, 0.34, r);
    return mix(col, vec3<f32>(0.62, 0.64, 0.70), hub * 0.9);        // silver clamp ring
}
// Printed-art coverage at radius r: 0 inside the clear hub ring (no ink there on a real disc), 1 outside.
fn cd_print_mask(r: f32) -> f32 {
    return smoothstep(${f(CD_DISC_ART_INNER_RATIO - 0.006)}, ${f(CD_DISC_ART_INNER_RATIO + 0.006)}, r);
}
// Composite printed art (labelA = the art pixel's coverage) over the disc colour col at radius r.
fn cd_print(col: vec3<f32>, labelRGB: vec3<f32>, labelA: f32, r: f32) -> vec3<f32> {
    return mix(col, labelRGB, clamp(labelA, 0.0, 1.0) * ${f(CD_PRINT_OPACITY)} * cd_print_mask(r));
}
`;
