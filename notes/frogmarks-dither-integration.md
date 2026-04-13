# Frogmarks — Dithering Effects Integration Spec

> **Context**: Salsa ships a GPU-accelerated `DitherEngine` (ordered dithering via
> WebGPU compute shaders) and Rust/WASM error diffusion (Floyd-Steinberg, Atkinson,
> etc.) as non-destructive post-process effects in the raster compositor pipeline.
> This document tells Frogmarks exactly which `ShapeManager` methods to call and what UI to build.

---

## 1. Pipeline Position

```
Layer 0 (bottom)
    ↓ ★ per-layer dither (if configured)
    ↓ blend mode / opacity / clipping
Layer 1
    ↓ ★ per-layer dither (if configured)
    ↓  ...
Layer N (top)
    ↓ ★ per-layer dither (if configured)
    ↓
  ┌──────────────────────────┐
  │  Compositor output       │  ← all layers flattened
  └──────────┬───────────────┘
             ↓
  ┌──────────────────────────┐
  │  ★ Global dither          │  ← applied to final composite
  └──────────┬───────────────┘
             ↓
  ┌──────────────────────────┐
  │  Paper grain overlay     │
  └──────────────────────────┘
```

**Two dither stages:**
- **Per-layer dither** — each layer can have its own `DitherConfig`. Applied to a
  non-destructive scratch copy *before* that layer is composited with the others.
  Different layers can use different algorithms, colors, and settings.
- **Global dither** — applied to the final composited output (all layers merged).
  Affects the entire canvas uniformly.

Both are non-destructive — original layer pixel data is never modified.
Toggle them off and the original image returns instantly.

---

## 2. Types (import from `@zaings/salsa`)

```ts
import ShapeManager, {
  DitherConfig,
  DitherAlgorithm,
  DitherColorMode,
  defaultDitherConfig,
} from '@zaings/salsa/shape-manager';
```

### `DitherAlgorithm`

```ts
type DitherAlgorithm =
  // GPU compute (ordered, real-time 60fps preview)
  | 'bayer'            // Classic crosshatch ordered dithering
  | 'halftone_dot'     // Circular dot halftone screen
  | 'halftone_line'    // Line/stripe halftone screen
  | 'halftone_diamond' // Diamond-shaped halftone screen
  | 'blue_noise'       // Organic, artifact-free void-and-cluster noise
  | 'noise'            // Simple random white noise threshold
  // Rust/WASM (error diffusion, async)
  | 'floyd_steinberg'      // Classic, most common error diffusion
  | 'atkinson'             // Lighter, retro Mac OS look (distributes only 75% of error)
  | 'jarvis_judice_ninke'  // Wide kernel, smooth gradients
  | 'stucki'               // Similar to JJN, slightly different weights
  | 'sierra'               // 3-row, good quality/speed balance
  | 'sierra_lite';         // 2-row simplified Sierra, fastest error diffusion
```

### `DitherColorMode`

```ts
type DitherColorMode =
  | 'quantize'   // Classic: quantize existing pixel colors to N levels (default)
  | 'duotone';   // Map to explicit foreground/background colors
```

### `DitherConfig`

```ts
interface DitherConfig {
  enabled: boolean;          // Master on/off
  algorithm: DitherAlgorithm;

  colorLevels: number;       // Output levels per channel (2 = 1-bit B&W, 4 = 2-bit, 256 = no-op)
  bayerLevel: number;        // Bayer matrix size: 0=2×2, 1=4×4, 2=8×8, 3=16×16, 4=32×32
  halftoneAngle: number;     // Screen rotation in degrees (0–360)
  halftoneFrequency: number; // Screen cells across texture width (2–200)
  strength: number;          // Blend: 0 = original, 1 = fully dithered
  patternScale: number;      // Pattern magnification (0.25–8)
  perChannel: boolean;       // true = dither R/G/B independently, false = luminance-only

  // ── Color Controls ──
  colorMode: DitherColorMode;   // 'quantize' or 'duotone'
  foregroundColor: [r, g, b, a]; // Duotone: lit/bright areas (0-1). Default: [0,0,0,1] (black)
  backgroundColor: [r, g, b, a]; // Duotone: dark/shadow areas (0-1). Default: [1,1,1,1] (white)
  invertPattern: boolean;        // Swap which areas get fg vs bg color. Default: false
  tintOpacity: number;           // Duotone blend: 0 = original, 1 = full duotone. Default: 1.0
}
```

---

## 3. ShapeManager API Reference

All methods are on the `ShapeManager` singleton (`shapeManager = ShapeManager.getInstance()`).

### 3.1 Global Dither — Full Config

| Method | Signature | Description |
|--------|-----------|-------------|
| `setDitherConfig` | `(config: DitherConfig) → void` | Set the complete **global** dither configuration. Triggers re-render. |
| `getDitherConfig` | `() → DitherConfig` | Get a copy of the current global config. |

### 3.2 Global Dither — Convenience Setters

These read the current global config, update one field, and call `setDitherConfig`.

| Method | Signature | Description |
|--------|-----------|-------------|
| `setDitherEnabled` | `(enabled: boolean) → void` | Master on/off toggle. |
| `setDitherAlgorithm` | `(algorithm: DitherAlgorithm) → void` | Switch the dithering algorithm. |
| `setDitherStrength` | `(strength: number) → void` | Blend 0–1 (clamped). |
| `setDitherColorLevels` | `(levels: number) → void` | Output levels 2–256 (rounded, clamped). |
| `setDitherPatternScale` | `(scale: number) → void` | Pattern magnification 0.25–8 (clamped). |
| `setDitherBayerLevel` | `(level: number) → void` | Bayer size 0–4 (rounded, clamped). |
| `setDitherHalftoneAngle` | `(degrees: number) → void` | Screen rotation 0–360 (wrapped). |
| `setDitherHalftoneFrequency` | `(freq: number) → void` | Screen frequency 2–200 (clamped). |
| `setDitherPerChannel` | `(perChannel: boolean) → void` | Color vs. mono dithering. |

### 3.3 Color Controls (apply to global dither)

| Method | Signature | Description |
|--------|-----------|-------------|
| `setDitherColorMode` | `(mode: 'quantize' \| 'duotone') → void` | Switch between classic quantization and duotone color mapping. |
| `setDitherForegroundColor` | `(r, g, b, a?) → void` | Set the **dot/lit-area** color (RGBA 0-1). Used in duotone mode. |
| `setDitherBackgroundColor` | `(r, g, b, a?) → void` | Set the **outside/shadow-area** color (RGBA 0-1). Used in duotone mode. |
| `swapDitherColors` | `() → void` | Swap foreground ↔ background colors. |
| `setDitherInvertPattern` | `(invert: boolean) → void` | Swap which areas of the dither pattern get fg vs bg color. |
| `setDitherTintOpacity` | `(opacity: number) → void` | Duotone blend: 0 = original colors, 1 = full duotone. |

### 3.4 Per-Layer Dithering

Each layer can have its own independent dither config. Per-layer dither is applied
*before* compositing, so different layers can have completely different effects.

| Method | Signature | Description |
|--------|-----------|-------------|
| `setLayerDitherConfig` | `(layerId: string, config: DitherConfig \| undefined) → boolean` | Set per-layer dither. Pass `undefined` to remove. Returns `false` if layer not found. |
| `getLayerDitherConfig` | `(layerId: string) → DitherConfig \| undefined` | Get layer’s dither config (copy), or `undefined` if not set. |

### 3.5 Static Helpers

| Property / Method | Value | Use |
|-------------------|-------|-----|
| `ShapeManager.DitherAlgorithms` | `DitherAlgorithm[]` — all 12 algorithm names | Populate a dropdown/selector in the UI |
| `ShapeManager.isErrorDiffusion(alg)` | `boolean` | Check if an algorithm runs via WASM (async) vs GPU (realtime). Use to show a “processing” indicator or disable live preview. |

---

## 4. Target UI Layout

### 4.1 Where It Lives

- **Global dither** → "Effects" panel (or bottom of Layer Panel)
- **Per-layer dither** → Layer settings popover / per-layer effects section

### 4.2 Global Effects Panel Wireframe

```
┌──────────────────────────────┐
│  ⚡ Effects                   │
├──────────────────────────────┤
│                              │
│  ☑ Dither                    │  ← setDitherEnabled(checked)
│                              │
│  Algorithm: [ Bayer       ▾] │  ← setDitherAlgorithm(value)
│                              │
│  ── General ──────────────── │
│  Color Levels: [ 2 ▾]       │  ← setDitherColorLevels(val)
│  Strength: [========○=] 100% │  ← setDitherStrength(val/100)
│  Scale:    [====○======] 1.0 │  ← setDitherPatternScale(val)
│  Per-Channel: [ ]            │  ← setDitherPerChannel(checked)
│                              │
│  ── Colors ──────────────── │
│  Mode: [ Quantize ▾]         │  ← setDitherColorMode(value)
│  Foreground: [■] #000000     │  ← setDitherForegroundColor(r,g,b,a)
│  Background: [□] #FFFFFF     │  ← setDitherBackgroundColor(r,g,b,a)
│  [⇄ Swap]  [☑ Invert]       │  ← swapDitherColors() / setDitherInvertPattern()
│  Tint: [========○=] 100%     │  ← setDitherTintOpacity(val/100)
│                              │
│  ── Bayer Settings ───────── │  (show when algorithm = 'bayer')
│  Matrix: [  8×8  ▾]         │  ← setDitherBayerLevel(2)
│                              │
│  ── Halftone Settings ────── │  (show when algorithm starts with 'halftone_')
│  Shape: [ Dot ▾]            │  ← setDitherAlgorithm('halftone_dot')
│  Angle:     [===○======] 45° │  ← setDitherHalftoneAngle(val)
│  Frequency: [======○===]  40 │  ← setDitherHalftoneFrequency(val)
│                              │
└──────────────────────────────┘
```

### 4.3 Per-Layer Dither (in Layer Settings)

```
┌──────────────────────────────┐
│  Layer: "Sketch"              │
├──────────────────────────────┤
│  ☑ Layer Dither               │  ← setLayerDitherConfig(id, cfg)
│  Algorithm: [ Halftone ▾]    │
│  Mode: [ Duotone ▾]          │
│  FG: [■] navy   BG: [□] cream │
│  [⇄ Swap]  [☑ Invert]        │
│  Strength: [======○===]  80% │
│  ...                         │
└──────────────────────────────┘
```

**Tip:** Use `defaultDitherConfig()` as the starting point when the user enables
per-layer dither for the first time.

### 4.4 Conditional Sections

| Active Algorithm | Show Section |
|-----------------|--------------|
| `bayer` | Bayer Settings (matrix level) |
| `halftone_dot`, `halftone_line`, `halftone_diamond` | Halftone Settings (shape, angle, frequency) |
| `blue_noise` | (no extra settings — just General) |
| `noise` | (no extra settings — just General) |
| `floyd_steinberg`, `atkinson`, `jarvis_judice_ninke`, `stucki`, `sierra`, `sierra_lite` | (no extra settings — just General + a “WASM/async” badge) |

### 4.5 Algorithm Dropdown Labels

| Value | UI Label | Category |
|-------|----------|----------|
| `bayer` | Bayer (Crosshatch) | 🟢 GPU |
| `halftone_dot` | Halftone — Dot | 🟢 GPU |
| `halftone_line` | Halftone — Line | 🟢 GPU |
| `halftone_diamond` | Halftone — Diamond | 🟢 GPU |
| `blue_noise` | Blue Noise (Organic) | 🟢 GPU |
| `noise` | Random Noise | 🟢 GPU |
| `floyd_steinberg` | Floyd–Steinberg | 🟡 WASM |
| `atkinson` | Atkinson (Mac Classic) | 🟡 WASM |
| `jarvis_judice_ninke` | Jarvis–Judice–Ninke | 🟡 WASM |
| `stucki` | Stucki | 🟡 WASM |
| `sierra` | Sierra (3-row) | 🟡 WASM |
| `sierra_lite` | Sierra Lite (fast) | 🟡 WASM |

> **UI tip:** Consider grouping algorithms in the dropdown with an "Ordered (GPU)"
> and "Error Diffusion (WASM)" section header. Show `ShapeManager.isErrorDiffusion(alg)`
> to display a subtle badge or spinner while error diffusion is processing.

### 4.5 Bayer Level Dropdown Labels

| Value | UI Label |
|-------|----------|
| `0` | 2×2 (coarse) |
| `1` | 4×4 |
| `2` | 8×8 (default) |
| `3` | 16×16 |
| `4` | 32×32 (fine) |

### 4.6 Color Levels Presets

| Value | UI Label | Description |
|-------|----------|-------------|
| `2` | 1-bit (B&W) | Classic monochrome dithering |
| `3` | 3-level | |
| `4` | 2-bit (4 tones) | Retro Game Boy feel |
| `8` | 3-bit (8 tones) | |
| `16` | 4-bit (16 tones) | Subtle poster effect |
| `256` | Off (no quantization) | Dithering disabled for this param |

---

## 5. Typical Code Flows

### 5.1 User enables global dither with Bayer

```ts
const sm = ShapeManager.getInstance();

// Quick enable with defaults (Bayer 8×8, 1-bit, full strength)
sm.setDitherEnabled(true);

// Or set everything at once (includes color defaults)
sm.setDitherConfig({
  ...defaultDitherConfig(),
  enabled: true,
  algorithm: 'bayer',
  colorLevels: 2,
  bayerLevel: 2,
  strength: 1.0,
});
```

### 5.2 User switches to halftone dot

```ts
sm.setDitherAlgorithm('halftone_dot');
sm.setDitherHalftoneAngle(30);
sm.setDitherHalftoneFrequency(60);
sm.setDitherColorLevels(4);
```

### 5.3 User enables duotone color mode

```ts
// Sepia-toned dithering
sm.setDitherColorMode('duotone');
sm.setDitherForegroundColor(0.2, 0.1, 0.05);  // dark brown (dots)
sm.setDitherBackgroundColor(1.0, 0.96, 0.87); // cream (outside dots)
sm.setDitherTintOpacity(1.0);
```

### 5.4 User swaps/inverts dither colors

```ts
// Swap foreground and background colors
sm.swapDitherColors();

// Or invert which areas of the pattern get which color
sm.setDitherInvertPattern(true);
```

### 5.5 User adjusts strength slider (real-time preview)

```ts
// Called on every slider `input` event (not just `change`)
sm.setDitherStrength(parseFloat(slider.value) / 100);
```

### 5.6 User enables per-layer dither on "Sketch" layer

```ts
import { defaultDitherConfig } from '@zaings/salsa/shape-manager';

const layerId = sm.getLayers()[0].id;

// Give this layer a halftone dot dither with navy/cream duotone
sm.setLayerDitherConfig(layerId, {
  ...defaultDitherConfig(),
  enabled: true,
  algorithm: 'halftone_dot',
  colorLevels: 2,
  halftoneFrequency: 50,
  colorMode: 'duotone',
  foregroundColor: [0.1, 0.1, 0.4, 1],   // navy
  backgroundColor: [1.0, 0.96, 0.87, 1], // cream
  strength: 0.8,
});

// Other layers remain un-dithered (or have their own configs)
```

### 5.7 User removes per-layer dither

```ts
sm.setLayerDitherConfig(layerId, undefined);
```

### 5.8 User disables global dither

```ts
sm.setDitherEnabled(false);
// All settings preserved — re-enabling restores the last config
```

### 5.9 Populate algorithm dropdown on mount

```ts
const algorithms = ShapeManager.DitherAlgorithms;
// → ['bayer', 'halftone_dot', 'halftone_line', 'halftone_diamond',
//    'blue_noise', 'noise',
//    'floyd_steinberg', 'atkinson', 'jarvis_judice_ninke',
//    'stucki', 'sierra', 'sierra_lite']

// Optionally separate GPU vs WASM for grouped dropdown:
const gpuAlgorithms = algorithms.filter(a => !ShapeManager.isErrorDiffusion(a));
const wasmAlgorithms = algorithms.filter(a => ShapeManager.isErrorDiffusion(a));
```

### 5.10 User applies Atkinson error diffusion

```ts
// Error diffusion runs through WASM — same API, no special handling needed.
// The renderer automatically uses async compositing when it detects error diffusion.
sm.setDitherAlgorithm('atkinson');
sm.setDitherColorLevels(2);  // 1-bit B&W, classic Mac look
sm.setDitherEnabled(true);

// Check if the chosen algorithm is async (for UI spinner/badge):
if (ShapeManager.isErrorDiffusion('atkinson')) {
  showProcessingIndicator();  // Optional: show a brief spinner
}
```

---

## 6. Performance Notes

### GPU Ordered Dithering (real-time)

| Algorithm | GPU Cost | Notes |
|-----------|----------|-------|
| Bayer | Very low | Procedural threshold — no texture reads |
| Halftone (all shapes) | Very low | Procedural — trig per pixel but trivial at 8×8 workgroups |
| Blue noise | Low | One 64×64 threshold texture lookup (pre-generated, tiling) |
| Noise | Very low | PCG hash per pixel, no texture reads |

All ordered algorithms run as a single compute dispatch — no CPU readback, no extra passes.
Real-time preview at 60fps on any WebGPU-capable GPU.

### WASM Error Diffusion (async)

| Algorithm | Typical Latency (2048×2048) | Notes |
|-----------|---------------------------|-------|
| Floyd–Steinberg | ~5–15ms | Classic, most widely used |
| Atkinson | ~5–15ms | Lighter look, only 75% of error distributed |
| Sierra Lite | ~4–10ms | Simplest kernel (2-row), fastest |
| Sierra | ~8–20ms | 3-row kernel, smoother |
| Stucki | ~8–20ms | Wide kernel, smooth gradients |
| Jarvis–Judice–Ninke | ~8–20ms | Widest kernel, smoothest but slowest |

Error diffusion requires GPU → CPU readback → WASM processing → GPU writeback.
The WASM Rust code runs at near-native speed (no GC, no JIT warmup).
For a 2K canvas the total round-trip is typically under 20ms — fast enough for
"click Apply and see the result" workflows, not meant for live slider preview.

> **UI guidance:** When the user selects an error diffusion algorithm, consider
> disabling the live strength slider preview and showing a brief processing
> indicator instead. Use `ShapeManager.isErrorDiffusion(alg)` to detect this.

---

## 7. Future Additions (P2)

These are planned but **not yet implemented**:

| Feature | Priority | Notes |
|---------|----------|-------|
| Retro palette presets (Game Boy, CGA, etc.) | P2 | Palette quantization compute shader |
| ~~Per-layer dithering~~ | ~~P2~~ | **✅ DONE** — `setLayerDitherConfig(layerId, config)` |
| ~~Color controls (duotone, fg/bg, invert, swap)~~ | ~~P2~~ | **✅ DONE** — see Section 3.3 |
| ~~Floyd-Steinberg error diffusion~~ | ~~P1~~ | **✅ DONE** — Rust/WASM, `algorithm: 'floyd_steinberg'` |
| ~~Atkinson error diffusion~~ | ~~P1~~ | **✅ DONE** — Rust/WASM, `algorithm: 'atkinson'` |
| ~~Jarvis-Judice-Ninke, Stucki, Sierra~~ | ~~P2~~ | **✅ DONE** — all 4 variants via Rust/WASM |
