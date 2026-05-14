# Frame Link Animations — Frogmarks Integration Spec
**Last Updated:** 2026-04-28  

## Overview

Frame Link Animations add **procedural UV displacement** to any raster layer, making its pixels (including dither patterns, brush strokes, etc.) ripple, shake, or flow across the canvas during animation playback. The effect is computed entirely in the compositor's existing compute shader — **zero extra passes, zero extra textures, zero pre-baking**.

### How it works (for the curious)

When compositing layers, the GPU already reads every pixel. Frame Link Animation adds one step: before reading the layer's pixel, it offsets the sample coordinates by a displacement value computed from a formula like `amplitude * sin(frequency * position + frame * speed)`. The result: the layer's content appears to physically move per-frame, but the actual texture data never changes.

**No frames are pre-computed.** If the timeline goes from 90 to 200 frames, frame 150 "just works" — the shader evaluates the formula at frame=150 on the fly. Changing any parameter (amplitude, speed, etc.) takes effect on the next rendered frame instantly.

---

## Quick Start

```ts
import ShapeManager, {
  DEFAULT_FRAME_LINK_ANIMATION,
  type FrameLinkAnimation,
  type FrameLinkAnimationType,
  type FrameLinkLoopMode,
} from 'salsa';

const sm = ShapeManager.getInstance();

// Enable a wave displacement on a layer
sm.setLayerFrameLinkAnimation(layerId, {
  ...DEFAULT_FRAME_LINK_ANIMATION,
  enabled: true,
  type: 'wave',
  amplitude: 15,    // texels of displacement
  frequency: 4,     // waves per texture width
  speed: 0.2,       // phase advance per frame
  direction: 0,     // degrees — wave propagates rightward
  displaceX: true,
  displaceY: false,
});

// Or use convenience setters for individual parameters
sm.setLayerFrameLinkEnabled(layerId, true);
sm.setLayerFrameLinkType(layerId, 'wave');
sm.setLayerFrameLinkAmplitude(layerId, 15);

// Remove the animation
sm.setLayerFrameLinkAnimation(layerId, undefined);
```

---

## API Reference

### Full Config Setter/Getter

| Method | Signature | Description |
|--------|-----------|-------------|
| `setLayerFrameLinkAnimation` | `(layerId: string, config: FrameLinkAnimation \| undefined) → boolean` | Set the full config. Pass `undefined` to remove. Returns `false` if layer not found. |
| `getLayerFrameLinkAnimation` | `(layerId: string) → FrameLinkAnimation \| undefined` | Get layer's config (copy), or `undefined` if not set. |
| `getDefaultFrameLinkAnimation` | `() → FrameLinkAnimation` | Returns a fresh default config (disabled, wave, sensible defaults). |

### Convenience Setters

Each reads the current config (or creates a default), updates one property, and writes it back.

| Method | Signature | Notes |
|--------|-----------|-------|
| `setLayerFrameLinkEnabled` | `(layerId, enabled: boolean) → boolean` | Master on/off toggle. |
| `setLayerFrameLinkType` | `(layerId, type: FrameLinkAnimationType) → boolean` | `'wave'`, `'shake'`, `'ripple'`, `'noise'`, `'turbulence'`. |
| `setLayerFrameLinkAmplitude` | `(layerId, amplitude: number) → boolean` | Displacement strength in texels. 0 = off, 50 = dramatic. Clamped ≥ 0. |
| `setLayerFrameLinkFrequency` | `(layerId, frequency: number) → boolean` | Spatial frequency (waves per width). 0.1 = huge waves, 20 = tight ripples. Clamped ≥ 0.01. |
| `setLayerFrameLinkSpeed` | `(layerId, speed: number) → boolean` | Phase advance per frame. 0.05 = slow, 0.5 = fast. Clamped ≥ 0. |
| `setLayerFrameLinkDirection` | `(layerId, degrees: number) → boolean` | Wave propagation direction. 0 = right, 90 = down, 180 = left, 270 = up. |
| `setLayerFrameLinkPhase` | `(layerId, phase: number) → boolean` | Starting phase offset in radians. Useful for staggering multiple layers. |
| `setLayerFrameLinkLoopMode` | `(layerId, mode: FrameLinkLoopMode) → boolean` | `'free'` (continuous) or `'loop-to-fit'` (one cycle per cel). |
| `setLayerFrameLinkAxes` | `(layerId, displaceX, displaceY) → boolean` | Which axes are affected. Both true = diagonal displacement. |
| `setLayerFrameLinkRippleCenter` | `(layerId, x, y: number) → boolean` | Ripple origin, normalized 0–1. Only used by `'ripple'` type. |
| `setLayerFrameLinkNoiseParams` | `(layerId, octaves, lacunarity, persistence) → boolean` | Turbulence noise params. Octaves 1–4, lacunarity ≥ 1, persistence 0–1. |

---

## Animation Types

### 1. Wave (`'wave'`)
Classic sinusoidal displacement along a configurable direction. Think flag in wind.

**Key parameters:** `amplitude`, `frequency`, `speed`, `direction`

**UI suggestion:** Direction dial (0–360°), amplitude slider (0–50), frequency slider (0.5–20), speed slider (0.01–1.0)

```
Frame N: each pixel shifts by A * sin(freq * perpendicular_position + N * speed)
```

### 2. Shake (`'shake'`)
Random whole-layer jitter per frame. The entire layer jumps to a random offset each frame.

**Key parameters:** `amplitude`, `shakeSeed`, `displaceX`, `displaceY`

**UI suggestion:** Amplitude slider (0–30), seed number input, X/Y checkboxes

> Note: `frequency` and `speed` are ignored for shake — it's purely per-frame random offset.

### 3. Ripple (`'ripple'`)
Radial waves emanating from a center point, like a stone dropped in water.

**Key parameters:** `amplitude`, `frequency`, `speed`, `rippleCenterX`, `rippleCenterY`

**UI suggestion:** Clickable center point on canvas preview (normalized 0–1), plus the standard amplitude/frequency/speed sliders.

### 4. Noise (`'noise'`)
Organic displacement using gradient noise. Each pixel gets a different offset based on its position and the current frame, producing a flowing, lava-lamp-like distortion.

**Key parameters:** `amplitude`, `frequency`, `speed`

**UI suggestion:** Same sliders as wave. Frequency here controls the noise scale (low = broad warps, high = tight squiggles).

### 5. Turbulence (`'turbulence'`)
Multi-octave layered noise. Same as noise but stacks multiple noise layers at different scales for richer detail. This is the most expensive type but still very fast.

**Key parameters:** `amplitude`, `frequency`, `speed`, `noiseOctaves`, `noiseLacunarity`, `noisePersistence`

**UI suggestion:**
- Octaves: dropdown or stepper (1, 2, 3, 4)
- Lacunarity: slider (1.0–4.0) — how much each octave zooms in
- Persistence: slider (0.0–1.0) — how much each octave contributes

---

## FrameLinkAnimation Interface

```ts
interface FrameLinkAnimation {
  enabled: boolean;
  type: FrameLinkAnimationType;      // 'wave' | 'shake' | 'ripple' | 'noise' | 'turbulence'
  amplitude: number;                 // 0–100+, texels
  frequency: number;                 // 0.01–50+, waves per width
  speed: number;                     // 0–2+, phase per frame
  direction: number;                 // 0–360, degrees
  phase: number;                     // radians, starting offset
  loopMode: FrameLinkLoopMode;       // 'free' | 'loop-to-fit'
  rippleCenterX: number;             // 0–1
  rippleCenterY: number;             // 0–1
  noiseOctaves: number;              // 1–4
  noiseLacunarity: number;           // ≥1
  noisePersistence: number;          // 0–1
  shakeSeed: number;                 // integer
  displaceX: boolean;                // affect X axis
  displaceY: boolean;                // affect Y axis
}
```

### Defaults

```ts
const DEFAULT_FRAME_LINK_ANIMATION: FrameLinkAnimation = {
  enabled: false,
  type: 'wave',
  amplitude: 10,
  frequency: 3.0,
  speed: 0.15,
  direction: 0,
  phase: 0,
  loopMode: 'free',
  rippleCenterX: 0.5,
  rippleCenterY: 0.5,
  noiseOctaves: 2,
  noiseLacunarity: 2.0,
  noisePersistence: 0.5,
  shakeSeed: 0,
  displaceX: true,
  displaceY: false,
};
```

---

## UI Panel Layout Suggestion

```
┌─ Frame Link Animation ──────────────────────┐
│ [✓] Enabled                                  │
│                                              │
│ Type: [▾ Wave        ]                       │
│                                              │
│ Amplitude:   ─────●──── 15 px                │
│ Frequency:   ──●──────── 3.0                 │
│ Speed:       ────●────── 0.15                │
│ Direction:   ●─────────── 0°                 │
│ Phase:       ●─────────── 0.0 rad            │
│                                              │
│ Axes: [✓] X  [ ] Y                          │
│ Loop: (●) Free  ( ) Loop to Fit             │
│                                              │
│ ┌─ Ripple ─────────────────────┐             │
│ │ Center X: ────●──── 0.5      │             │
│ │ Center Y: ────●──── 0.5      │             │
│ └──────────────────────────────┘             │
│                                              │
│ ┌─ Turbulence ─────────────────┐             │
│ │ Octaves:     [▾ 2 ]          │             │
│ │ Lacunarity:  ───●── 2.0      │             │
│ │ Persistence: ───●── 0.5      │             │
│ └──────────────────────────────┘             │
└──────────────────────────────────────────────┘
```

The "Ripple" and "Turbulence" sub-sections should be shown/hidden based on the selected type:
- **Wave**: hide Ripple, hide Turbulence
- **Shake**: hide Ripple, hide Turbulence, hide Frequency/Direction
- **Ripple**: show Ripple, hide Turbulence
- **Noise**: hide Ripple, hide Turbulence
- **Turbulence**: hide Ripple, show Turbulence

---

## Persistence

Frame Link Animation configs are automatically saved and restored with the document. They live in the layer manifest:

```json
{
  "layers": [{
    "id": "r_abc1234",
    "name": "Dithered Layer",
    "frameLinkAnimation": {
      "enabled": true,
      "type": "wave",
      "amplitude": 15,
      "frequency": 4,
      "speed": 0.2,
      "direction": 0,
      "phase": 0,
      "loopMode": "free",
      "rippleCenterX": 0.5,
      "rippleCenterY": 0.5,
      "noiseOctaves": 2,
      "noiseLacunarity": 2.0,
      "noisePersistence": 0.5,
      "shakeSeed": 0,
      "displaceX": true,
      "displaceY": false
    }
  }]
}
```

No special handling needed — it's a plain JSON object that serializes/deserializes alongside the existing layer state.

---

## Performance Characteristics

| Type | GPU cost per pixel | Notes |
|------|-------------------|-------|
| Wave | ~3 ops (1 sin) | Cheapest. Free to spam. |
| Shake | 0 per pixel (1 hash per frame) | Whole-layer uniform offset. |
| Ripple | ~5 ops (1 sin + 1 length + 1 normalize) | Still very cheap. |
| Noise | ~10 ops (4 hash + interpolation) | Noticeable on 4K at >60fps, fine otherwise. |
| Turbulence | ~15–25 ops (noise × octaves) | 4 octaves at 4K is the ceiling. |

For comparison: the halftone dither shader already does ~20 ops per pixel. Even turbulence is comparable to what's already running every frame.

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Cel duration changes | Nothing to recompute — procedural. |
| Loop-to-fit + duration change | `speed` is recalculated as `2π / celDuration`. One float update. |
| Layer merge | Displacement should be baked into pixels before merge (future work). |
| Export (PNG sequence / GIF) | Works automatically — export renders each frame, displacement evaluates per-frame. |
| Onion skinning | Adjacent frames show displaced positions (they receive different frame numbers). |
| Scrubbing timeline | Instant — just a uniform update, no recomputation. |
| Undo/redo | Config changes emit scene-graph-changed, so undo snapshots capture them. |
| Layer duplication | Config is a plain object, gets shallow-copied with the layer. |
| Non-animated (static) layers | Works fine — the layer just shows the same displacement at whatever the current frame is. Useful for "always wiggling" effects. |

---

## Roadmap / Future Extensions

- [ ] **Custom WGSL snippets** — Let advanced users write their own displacement formula
- [ ] **Easing curves** — Apply ease-in/ease-out to the phase advance over the cel duration
- [ ] **Per-axis independent parameters** — Different amplitude/frequency for X vs Y
- [ ] **Displacement map texture** — Sample from a user-provided texture instead of procedural math
- [ ] **Vertex displacement** — For vector layers, displace control points instead of UV coords
- [ ] **Keyframed parameters** — Animate amplitude/frequency/etc. over time with keyframes
