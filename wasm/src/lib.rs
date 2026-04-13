use wasm_bindgen::prelude::*;

// ─── Error Diffusion Dithering ──────────────────────────────────────────
//
// All functions operate on a flat RGBA `&mut [u8]` buffer (length = w × h × 4).
// They dither in-place: when the function returns, `pixels` contains the result.
// The caller (TypeScript) owns the memory — no allocations happen in Rust.
//
// `levels` = number of output color levels per channel (2 = 1-bit, 4 = 2-bit, etc.)
//
// Supported algorithms:
//   - Floyd-Steinberg      (classic, most common)
//   - Atkinson             (lighter, retro Mac look — only distributes 3/4 of error)
//   - Jarvis-Judice-Ninke  (wider kernel, smoother gradients)
//   - Stucki               (similar to JJN, slightly different weights)
//   - Sierra               (3-row, good quality/speed balance)
//   - Sierra Lite          (2-row simplified Sierra, fast)

/// Quantize a single channel value to the nearest level.
#[inline(always)]
fn quantize(val: f32, levels: f32) -> f32 {
    let step = 1.0 / (levels - 1.0);
    (val * (levels - 1.0)).round() * step
}

/// Distribute error to a neighbor pixel, clamping to [0, 255].
#[inline(always)]
fn distribute(pixels: &mut [u8], idx: usize, channel: usize, error: f32, weight: f32) {
    let offset = idx * 4 + channel;
    if offset < pixels.len() {
        let old = pixels[offset] as f32;
        let new_val = (old + error * weight).round().clamp(0.0, 255.0);
        pixels[offset] = new_val as u8;
    }
}

// ─── Floyd-Steinberg ─────────────────────────────────────────────────────
//
//         *   7/16
//   3/16  5/16  1/16
//
#[wasm_bindgen]
pub fn floyd_steinberg(pixels: &mut [u8], width: u32, height: u32, levels: u32) {
    let w = width as usize;
    let h = height as usize;
    let lvl = levels as f32;

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;

            for c in 0..3usize {
                let old = pixels[idx * 4 + c] as f32 / 255.0;
                let new_val = quantize(old, lvl);
                let err = (old - new_val) * 255.0;
                pixels[idx * 4 + c] = (new_val * 255.0).round().clamp(0.0, 255.0) as u8;

                // Right
                if x + 1 < w {
                    distribute(pixels, idx + 1, c, err, 7.0 / 16.0);
                }
                // Below-left
                if y + 1 < h && x > 0 {
                    distribute(pixels, idx + w - 1, c, err, 3.0 / 16.0);
                }
                // Below
                if y + 1 < h {
                    distribute(pixels, idx + w, c, err, 5.0 / 16.0);
                }
                // Below-right
                if y + 1 < h && x + 1 < w {
                    distribute(pixels, idx + w + 1, c, err, 1.0 / 16.0);
                }
            }
            // Alpha channel is preserved unchanged
        }
    }
}

// ─── Atkinson ────────────────────────────────────────────────────────────
//
//           *    1/8   1/8
//   1/8    1/8   1/8
//           1/8
//
// Only distributes 6/8 = 75% of the error (the rest is lost),
// giving a lighter, more contrasty look (classic Mac OS style).
//
#[wasm_bindgen]
pub fn atkinson(pixels: &mut [u8], width: u32, height: u32, levels: u32) {
    let w = width as usize;
    let h = height as usize;
    let lvl = levels as f32;

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;

            for c in 0..3usize {
                let old = pixels[idx * 4 + c] as f32 / 255.0;
                let new_val = quantize(old, lvl);
                let err = (old - new_val) * 255.0;
                pixels[idx * 4 + c] = (new_val * 255.0).round().clamp(0.0, 255.0) as u8;

                let w8 = err / 8.0;
                // Right
                if x + 1 < w { distribute(pixels, idx + 1, c, w8, 1.0); }
                // Right +2
                if x + 2 < w { distribute(pixels, idx + 2, c, w8, 1.0); }
                // Below-left
                if y + 1 < h && x > 0 { distribute(pixels, idx + w - 1, c, w8, 1.0); }
                // Below
                if y + 1 < h { distribute(pixels, idx + w, c, w8, 1.0); }
                // Below-right
                if y + 1 < h && x + 1 < w { distribute(pixels, idx + w + 1, c, w8, 1.0); }
                // Two below
                if y + 2 < h { distribute(pixels, idx + 2 * w, c, w8, 1.0); }
            }
        }
    }
}

// ─── Jarvis-Judice-Ninke ─────────────────────────────────────────────────
//
//               *   7/48  5/48
//   3/48  5/48  7/48  5/48  3/48
//   1/48  3/48  5/48  3/48  1/48
//
#[wasm_bindgen]
pub fn jarvis_judice_ninke(pixels: &mut [u8], width: u32, height: u32, levels: u32) {
    let w = width as usize;
    let h = height as usize;
    let lvl = levels as f32;
    let d = 48.0_f32;

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;

            for c in 0..3usize {
                let old = pixels[idx * 4 + c] as f32 / 255.0;
                let new_val = quantize(old, lvl);
                let err = (old - new_val) * 255.0;
                pixels[idx * 4 + c] = (new_val * 255.0).round().clamp(0.0, 255.0) as u8;

                // Row 0 (current row, right side)
                if x + 1 < w { distribute(pixels, idx + 1, c, err, 7.0 / d); }
                if x + 2 < w { distribute(pixels, idx + 2, c, err, 5.0 / d); }
                // Row 1
                if y + 1 < h {
                    let r = idx + w;
                    if x >= 2 { distribute(pixels, r - 2, c, err, 3.0 / d); }
                    if x >= 1 { distribute(pixels, r - 1, c, err, 5.0 / d); }
                    distribute(pixels, r, c, err, 7.0 / d);
                    if x + 1 < w { distribute(pixels, r + 1, c, err, 5.0 / d); }
                    if x + 2 < w { distribute(pixels, r + 2, c, err, 3.0 / d); }
                }
                // Row 2
                if y + 2 < h {
                    let r = idx + 2 * w;
                    if x >= 2 { distribute(pixels, r - 2, c, err, 1.0 / d); }
                    if x >= 1 { distribute(pixels, r - 1, c, err, 3.0 / d); }
                    distribute(pixels, r, c, err, 5.0 / d);
                    if x + 1 < w { distribute(pixels, r + 1, c, err, 3.0 / d); }
                    if x + 2 < w { distribute(pixels, r + 2, c, err, 1.0 / d); }
                }
            }
        }
    }
}

// ─── Stucki ──────────────────────────────────────────────────────────────
//
//               *   8/42  4/42
//   2/42  4/42  8/42  4/42  2/42
//   1/42  2/42  4/42  2/42  1/42
//
#[wasm_bindgen]
pub fn stucki(pixels: &mut [u8], width: u32, height: u32, levels: u32) {
    let w = width as usize;
    let h = height as usize;
    let lvl = levels as f32;
    let d = 42.0_f32;

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;

            for c in 0..3usize {
                let old = pixels[idx * 4 + c] as f32 / 255.0;
                let new_val = quantize(old, lvl);
                let err = (old - new_val) * 255.0;
                pixels[idx * 4 + c] = (new_val * 255.0).round().clamp(0.0, 255.0) as u8;

                if x + 1 < w { distribute(pixels, idx + 1, c, err, 8.0 / d); }
                if x + 2 < w { distribute(pixels, idx + 2, c, err, 4.0 / d); }
                if y + 1 < h {
                    let r = idx + w;
                    if x >= 2 { distribute(pixels, r - 2, c, err, 2.0 / d); }
                    if x >= 1 { distribute(pixels, r - 1, c, err, 4.0 / d); }
                    distribute(pixels, r, c, err, 8.0 / d);
                    if x + 1 < w { distribute(pixels, r + 1, c, err, 4.0 / d); }
                    if x + 2 < w { distribute(pixels, r + 2, c, err, 2.0 / d); }
                }
                if y + 2 < h {
                    let r = idx + 2 * w;
                    if x >= 2 { distribute(pixels, r - 2, c, err, 1.0 / d); }
                    if x >= 1 { distribute(pixels, r - 1, c, err, 2.0 / d); }
                    distribute(pixels, r, c, err, 4.0 / d);
                    if x + 1 < w { distribute(pixels, r + 1, c, err, 2.0 / d); }
                    if x + 2 < w { distribute(pixels, r + 2, c, err, 1.0 / d); }
                }
            }
        }
    }
}

// ─── Sierra (Full / 3-row) ───────────────────────────────────────────────
//
//               *   5/32  3/32
//   2/32  4/32  5/32  4/32  2/32
//         2/32  3/32  2/32
//
#[wasm_bindgen]
pub fn sierra(pixels: &mut [u8], width: u32, height: u32, levels: u32) {
    let w = width as usize;
    let h = height as usize;
    let lvl = levels as f32;
    let d = 32.0_f32;

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;

            for c in 0..3usize {
                let old = pixels[idx * 4 + c] as f32 / 255.0;
                let new_val = quantize(old, lvl);
                let err = (old - new_val) * 255.0;
                pixels[idx * 4 + c] = (new_val * 255.0).round().clamp(0.0, 255.0) as u8;

                if x + 1 < w { distribute(pixels, idx + 1, c, err, 5.0 / d); }
                if x + 2 < w { distribute(pixels, idx + 2, c, err, 3.0 / d); }
                if y + 1 < h {
                    let r = idx + w;
                    if x >= 2 { distribute(pixels, r - 2, c, err, 2.0 / d); }
                    if x >= 1 { distribute(pixels, r - 1, c, err, 4.0 / d); }
                    distribute(pixels, r, c, err, 5.0 / d);
                    if x + 1 < w { distribute(pixels, r + 1, c, err, 4.0 / d); }
                    if x + 2 < w { distribute(pixels, r + 2, c, err, 2.0 / d); }
                }
                if y + 2 < h {
                    let r = idx + 2 * w;
                    if x >= 1 { distribute(pixels, r - 1, c, err, 2.0 / d); }
                    distribute(pixels, r, c, err, 3.0 / d);
                    if x + 1 < w { distribute(pixels, r + 1, c, err, 2.0 / d); }
                }
            }
        }
    }
}

// ─── Sierra Lite (2-row) ─────────────────────────────────────────────────
//
//         *   2/4
//   1/4  1/4
//
#[wasm_bindgen]
pub fn sierra_lite(pixels: &mut [u8], width: u32, height: u32, levels: u32) {
    let w = width as usize;
    let h = height as usize;
    let lvl = levels as f32;

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;

            for c in 0..3usize {
                let old = pixels[idx * 4 + c] as f32 / 255.0;
                let new_val = quantize(old, lvl);
                let err = (old - new_val) * 255.0;
                pixels[idx * 4 + c] = (new_val * 255.0).round().clamp(0.0, 255.0) as u8;

                if x + 1 < w { distribute(pixels, idx + 1, c, err, 2.0 / 4.0); }
                if y + 1 < h {
                    let r = idx + w;
                    if x >= 1 { distribute(pixels, r - 1, c, err, 1.0 / 4.0); }
                    distribute(pixels, r, c, err, 1.0 / 4.0);
                }
            }
        }
    }
}