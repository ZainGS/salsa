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

export const STYLE_WGSL_FUNCTIONS = /* wgsl */ `

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
    let H    = normalize(L + V);
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
    let H    = normalize(L + V);
    let spec = pow(max(dot(N, H), 0.0), max(shininess, 1.0));  // SMOOTH highlight (no hard step) → glossy
    lit += specular * lightRgb * spec * step(0.0001, NdotL);   // only on the lit side
    lit += emissive;
    return lit;
}

// ── Sketch / crosshatch ──────────────────────────────────────────
// Simulates hand-drawn crosshatching: paper base colour with ink lines
// that grow denser as the surface turns away from the light.
fn sketch_lighting(
    diffuse: vec3<f32>,
    N: vec3<f32>, L: vec3<f32>,
    worldPos: vec3<f32>,
    ambientI: f32, lightI: f32,
) -> vec3<f32> {
    let NdotL     = max(dot(N, L), 0.0);
    let intensity = clamp(ambientI + NdotL * lightI, 0.0, 1.0);

    // Three layers of hatching at increasing densities
    let sc   = 14.0;
    let p    = worldPos * sc;
    let h1   = step(0.55, fract(p.x + p.z));           // diagonal A
    let h2   = step(0.55, fract(p.x - p.z));           // diagonal B (cross)
    let h3   = step(0.55, fract(p.x * 0.7 + p.y));     // tertiary

    // Paper: off-white tinted by the diffuse colour
    let paper  = mix(vec3<f32>(0.96, 0.94, 0.88), diffuse * 0.9 + 0.1, 0.25);
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
    let rimFactor = pow(rim, 4.0);
    base = mix(base, diffuse * 0.05, rimFactor);

    return base;
}
`;
