/**
 * The WAVY pattern maths, shared WGSL (no bindings): the domain warp behind the edit modes' "Wavy" / "Wavy Sage" focus
 * background (armature-bg-pass.ts) and the soft sin-sin checker field of its "Clover Picnic" checkers mode, reused by
 * the Shell's FrogCart disc pattern (cart-disc-pattern.ts) so the two never drift apart.
 *
 * Pure functions, spliced into a shader as a string. No backticks in the comments (they would end the template).
 */

export const WAVY_PATTERN_WGSL = /* wgsl */ `
// Two passes of sinusoidal domain warping (organic ribbons). a1 / a2 = the warp amplitudes of the two layers
// (the focus background uses 0.55 / 0.28); t = time in seconds (0 = a still frame).
fn wavy_warp(uv: vec2<f32>, t: f32, a1: f32, a2: f32) -> vec2<f32> {
    let w1 = vec2<f32>(
        sin(uv.y * 2.1 + sin(uv.x * 1.4) * 1.1 + t * 0.48),
        sin(uv.x * 2.6 + sin(uv.y * 1.8) * 0.9 + t * 0.32),
    );
    let p1 = uv + w1 * a1;
    let w2 = vec2<f32>(
        sin(p1.y * 3.5 + t * 0.20),
        sin(p1.x * 3.1 + t * 0.28),
    );
    return p1 + w2 * a2;
}

// The focus background's flowing wave (0..1): warped diagonal bands.
fn wavy_wave(uv: vec2<f32>, t: f32) -> f32 {
    let p2 = wavy_warp(uv, t, 0.55, 0.28);
    let raw = sin(p2.x * 3.14159 * 1.7 + p2.y * 2.3 + t * 0.24) * 0.5 + 0.5;
    return smoothstep(0.3, 0.7, raw);
}

// Soft checker field in CELL units (0..1): a smooth sin-sin checker, soft-stepped so the cell borders feather.
// 1 in the first colour's cells, 0 in the second's. blur = the soft-step half width (in sin units).
fn wavy_checker(p: vec2<f32>, blur: f32) -> f32 {
    let PI = 3.14159265;
    let cf = sin(p.x * PI) * sin(p.y * PI);
    return smoothstep(-blur, blur, cf);
}
`;
