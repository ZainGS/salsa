# 13 — WASM Module

Salsa includes a Rust/WebAssembly module that accelerates error-diffusion dithering algorithms. These algorithms are inherently sequential (each pixel depends on its neighbors' quantization errors) and can't be efficiently parallelized on the GPU.

---

## Files

| Path | Purpose |
|------|---------|
| `wasm/src/lib.rs` | Rust source — 6 dithering algorithms |
| `wasm/Cargo.toml` | Rust project config (wasm-bindgen) |
| `wasm/pkg/wasm.js` | Auto-generated JS glue |
| `wasm/pkg/wasm.d.ts` | Auto-generated TypeScript declarations |
| `wasm/pkg/wasm_bg.wasm.d.ts` | Raw WASM export types |
| `src/wasm/wasm-bindings.ts` | Salsa's TypeScript wrapper |

---

## Available Algorithms

| Function | Algorithm | Quality | Speed |
|----------|-----------|---------|-------|
| `floyd_steinberg` | Floyd-Steinberg | Good general purpose | Fast |
| `atkinson` | Atkinson | Retro Mac aesthetic (only 75% error distributed) | Fast |
| `jarvis_judice_ninke` | Jarvis-Judice-Ninke | Smooth gradients (wide 3×5 kernel) | Slow |
| `stucki` | Stucki | Sharp output (3×5 kernel, ÷42) | Slow |
| `sierra` | Sierra | Full 3-row kernel (÷32) | Slow |
| `sierra_lite` | Sierra Lite | Lightweight 2-row variant | Fast |

All share the same signature:
```rust
pub fn floyd_steinberg(pixels: &mut [u8], width: u32, height: u32, levels: u32)
```

### Parameters

- `pixels` — mutable RGBA `Uint8Array` (width × height × 4 bytes)
- `width`, `height` — image dimensions
- `levels` — quantization levels per channel:
  - `2` = 1-bit (black/white, 2 colors per channel)
  - `4` = 2-bit (4 levels per channel)
  - `8` = 3-bit, etc.

### How Error Diffusion Works

```
For each pixel (left-to-right, top-to-bottom):
    1. old_value = pixel[channel]
    2. new_value = quantize(old_value, levels)
    3. pixel[channel] = new_value
    4. error = old_value - new_value
    5. Distribute error to neighboring pixels (right, below-left, below, below-right)
       weighted by the algorithm's kernel
```

Each algorithm differs only in the **error distribution kernel** — how much error goes to which neighbors:

**Floyd-Steinberg:**
```
        *   7/16
  3/16  5/16  1/16
```

**Atkinson:**
```
        *   1/8  1/8
  1/8  1/8  1/8
        1/8
```
(Only distributes 6/8 = 75% of error — gives a lighter, more contrasty look)

**Jarvis-Judice-Ninke:**
```
              *    7/48  5/48
  3/48  5/48  7/48  5/48  3/48
  1/48  3/48  5/48  3/48  1/48
```

---

## TypeScript Integration

**File:** `src/wasm/wasm-bindings.ts`

```typescript
// Initialize WASM (call once at startup)
export async function initWasm(): Promise<void>;

// Check if WASM is ready
export function isWasmReady(): boolean;

// Apply a dithering algorithm (dispatches to Rust)
export function applyErrorDiffusion(
    algorithm: ErrorDiffusionAlgorithm,
    pixels: Uint8Array,
    width: number,
    height: number,
    levels: number
): void;

export type ErrorDiffusionAlgorithm = 
    'floyd-steinberg' | 'atkinson' | 'jarvis-judice-ninke' | 
    'stucki' | 'sierra' | 'sierra-lite';
```

**Usage by the DitherEngine:**

```typescript
// In RasterCompositor or DitherEngine:

// 1. Read GPU texture back to CPU
const pixels = await readbackTexture(gpuTexture); // Uint8Array

// 2. Apply error diffusion on CPU via WASM
applyErrorDiffusion('floyd-steinberg', pixels, width, height, levels);

// 3. Upload modified pixels back to GPU
device.queue.writeTexture(gpuTexture, pixels, layout, size);
```

This readback-process-upload cycle is why error diffusion is slower than GPU-based ordered dithering (Bayer, halftone, blue noise), which operate entirely on-GPU as compute shaders.

---

## Building the WASM Module

```bash
cd wasm/
wasm-pack build --target web --release
```

This produces `wasm/pkg/` with the JS glue and `.wasm` binary. The project uses `wasm-bindgen` for automatic binding generation.

The `--release` flag is important for performance — error diffusion over a 2048×2048 image processes ~16M pixel-channel operations.
