# Frogmarks: Text Effects & HTML-in-Canvas — Integration Spec
**Last Updated:** 2026-05-07  

## Overview

Salsa now includes a **TextEffectEngine** that provides:

1. **Text-to-texture capture** — render styled text to a GPU texture (works everywhere)
2. **HTML-in-Canvas capture** — capture live DOM elements as GPU textures (Chrome Canary flag)
3. **5 GPU compute shader effects** — chromatic aberration, glow, wave, glitch, outline
4. **Effect chaining** — stack multiple effects in sequence
5. **Raster layer stamping** — stamp effected text directly onto a raster layer

---

## Two Capture Paths

### Path A: OffscreenCanvas (works everywhere, today)

Renders text via Canvas 2D `fillText()`. Supports basic styling (font, size, bold, italic, color, wrapping). No CSS layout, no complex styling.

```ts
const tex = shapeManager.captureTextToTexture({
  text: 'KABOOM!',
  font: 'Impact',
  fontSize: 120,
  color: [1, 0, 0, 1],
  bold: true,
  padding: 24,       // extra space for effects that bleed (glow, outline)
  maxWidth: 400,      // word wrap width (optional)
});
// tex = { texture: GPUTexture, width: number, height: number }
```

### Path B: HTML-in-Canvas (Chrome Canary with flag)

Captures **any DOM element** — full CSS, fonts, borders, backgrounds, child elements, `writing-mode: vertical-rl`, emoji, IME text. Requires setup.

**Check availability:**
```ts
if (shapeManager.isHtmlInCanvasAvailable()) {
  // API is available — use native capture
  const mode = shapeManager.getHtmlInCanvasMode();
  // 'webgpu-native'  → GPUQueue.copyElementImageToTexture (best, zero-copy)
  // 'webgl-bridge'   → texElementImage2D → WebGL → WebGPU transfer
}
```

**One-time canvas setup:**
```ts
// Call once during initialization
const cleanup = shapeManager.setupHtmlInCanvas((changedElements) => {
  // Optional: called each frame when canvas children's rendering changes.
  // Use this to re-capture elements that updated.
  for (const el of changedElements) {
    // Update your texture cache for this element...
  }
});

// Later, to tear down:
// cleanup();
```

**Add elements as canvas children:**
```ts
// Elements MUST be direct children of the <canvas>
const canvas = document.querySelector('canvas');

const el = document.createElement('div');
el.style.cssText = `
  font: bold 80px 'Noto Sans JP';
  color: white;
  writing-mode: vertical-rl;
  padding: 12px;
  background: transparent;
`;
el.textContent = '何だこれ？！';
canvas.appendChild(el);
```

> **Important:** Elements inside a `<canvas layoutsubtree>` are laid out and participate in hit testing / accessibility, but they are **invisible** until explicitly captured. They don't visually appear on their own.

**Capture the element:**
```ts
// Ensure the browser has painted at least once
shapeManager.requestHtmlPaint();

// On next frame (e.g., in onpaint callback or after rAF):
const tex = shapeManager.captureElementToTexture(el);
// tex = { texture: GPUTexture, width: number, height: number } | null
```

**Progressive enhancement pattern:**
```ts
function captureText(text: string, font: string, fontSize: number, color: [number,number,number,number]) {
  if (shapeManager.isHtmlInCanvasAvailable()) {
    // Rich path — full CSS rendering
    const el = document.createElement('div');
    el.style.cssText = `font: ${fontSize}px ${font}; color: rgba(${color.map(c => Math.round(c*255)).join(',')}); padding: 16px;`;
    el.textContent = text;
    canvas.appendChild(el);
    shapeManager.requestHtmlPaint();
    // Capture after paint (use requestAnimationFrame or onpaint callback)
    return shapeManager.captureElementToTexture(el);
  } else {
    // Fallback — Canvas 2D text rendering
    return shapeManager.captureTextToTexture({
      text, font, fontSize, color, padding: 16,
    });
  }
}
```

---

## Applying Effects

### Single Effect

```ts
const effected = shapeManager.applyTextEffect(tex.texture, 'chromatic-aberration', {
  strength: 0.008,
  angle: 0.3,
});
// effected = GPUTexture (caller owns it — destroy when done)
```

### Effect Chain

Effects apply in order. Intermediate textures are destroyed automatically.

```ts
const result = shapeManager.applyTextEffectChain(tex.texture, [
  { type: 'outline',              params: { thickness: 3, color: [0, 0, 0, 1] } },
  { type: 'glow',                 params: { radius: 6, intensity: 2.0, color: [1, 0.5, 0] } },
  { type: 'chromatic-aberration', params: { thickness: 0.004, angle: 0 } },
]);
// result = GPUTexture with all three effects applied
```

### One-liner: Capture + Effects

```ts
const result = shapeManager.createEffectedText(
  { text: '何だ?!', font: 'Noto Sans JP', fontSize: 80, color: [1,1,1,1], padding: 16 },
  [{ type: 'glow', params: { radius: 8, intensity: 2, color: [0.2, 0.6, 1] } }]
);
// result = { texture: GPUTexture, width: number, height: number }
```

### Stamp onto Raster Layer

Stamps the effected text directly onto the active raster layer at a texel position. Destructive — becomes pixels.

```ts
const success = await shapeManager.stampEffectedText(
  100, 50,  // destX, destY in texel space
  { text: 'POW!', font: 'Impact', fontSize: 96, color: [1,1,0,1], bold: true, padding: 20 },
  [
    { type: 'outline', params: { thickness: 4, color: [0,0,0,1] } },
    { type: 'chromatic-aberration', params: { strength: 0.006, angle: 0.2 } },
  ]
);
// success = true if stamped, false if no active layer or device
```

---

## Effect Reference

### Chromatic Aberration
Splits RGB channels with offset sampling. Classic manga impact text look.

```ts
type: 'chromatic-aberration'
params: {
  strength: number;  // 0–0.05 typical. Default: 0.005
  angle: number;     // Radians. 0 = horizontal split. Default: 0
}
```

### Glow / Bloom
Two-pass separable Gaussian blur composited behind the original text.

```ts
type: 'glow'
params: {
  radius: number;              // Blur radius in texels. Default: 4
  intensity: number;           // Brightness multiplier. Default: 1.5
  color?: [number, number, number];  // Glow tint RGB 0–1. Default: same as text
}
```

### Wave Distortion
Sine-wave UV displacement. Ghostly, underwater, or ethereal text.

```ts
type: 'wave'
params: {
  amplitude: number;  // Displacement in texels. Default: 3
  frequency: number;  // Wave frequency. Default: 10
  speed: number;      // Animation speed (0 = static). Default: 1
  time: number;       // Current time — update each frame for animation. Default: 0
}
```

To animate: update `time` each frame and re-apply the effect.

### Glitch
Block-based row displacement with RGB channel splitting. Digital corruption.

```ts
type: 'glitch'
params: {
  intensity: number;   // 0–1. Default: 0.3
  blockSize: number;   // Block height in texels. Default: 8
  time: number;        // Changes which rows glitch. Default: 0
}
```

To animate: update `time` each frame. Different time values produce different glitch patterns.

### Outline / Stroke
Dilates the text alpha to create a solid outline behind the original text.

```ts
type: 'outline'
params: {
  thickness: number;                      // Outline width in texels. Default: 2
  color: [number, number, number, number]; // RGBA 0–1. Default: [0,0,0,1]
}
```

---

## Recommended Effect Combos for Manga

| Use Case | Effect Chain |
|---|---|
| **Screaming / anger** | `outline(3, black)` → `chromatic-aberration(0.008, 0)` |
| **Power-up / energy** | `glow(8, 2.5, [0.2, 0.6, 1.0])` → `chromatic-aberration(0.004, 0)` |
| **Ghost / spirit text** | `wave(4, 8, 1, t)` → `glow(6, 1.5, [0.8, 0.8, 1.0])` |
| **Digital / cyberpunk** | `glitch(0.4, 6, t)` → `chromatic-aberration(0.006, 0)` |
| **Horror drip** | `wave(6, 3, 0.5, t)` → `outline(2, [0.3, 0, 0, 1])` |
| **Clean speech bubble** | `outline(2, [0, 0, 0, 1])` |
| **Neon sign** | `outline(1, black)` → `glow(10, 3.0, [1, 0, 0.5])` |
| **Impact SFX (BOOM!)** | `outline(4, black)` → `glow(4, 1.5)` → `chromatic-aberration(0.01, 0.3)` |

---

## Animated Effects

Wave and glitch support animation via their `time` parameter. To animate:

```ts
let textTexture: GPUTexture | null = null;
let effectTexture: GPUTexture | null = null;

// Capture once
textTexture = shapeManager.captureTextToTexture({
  text: 'ゴゴゴゴゴ',
  font: 'Noto Sans JP',
  fontSize: 72,
  color: [1, 1, 1, 1],
  padding: 24,
})?.texture ?? null;

// In your render loop:
function onFrame(t: number) {
  if (!textTexture) return;

  // Destroy previous frame's effect texture
  effectTexture?.destroy();

  // Re-apply with updated time
  effectTexture = shapeManager.applyTextEffectChain(textTexture, [
    { type: 'wave', params: { amplitude: 3, frequency: 10, speed: 1, time: t * 0.001 } },
    { type: 'glow', params: { radius: 6, intensity: 1.5, color: [0.5, 0.2, 1.0] } },
  ]);

  // Use effectTexture in your rendering...
  requestAnimationFrame(onFrame);
}
requestAnimationFrame(onFrame);
```

> **Performance note:** The source `textTexture` is captured once and reused. Only the effect shaders run each frame — those are fast GPU compute dispatches.

---

## API Summary

| Method | Signature | Notes |
|---|---|---|
| `captureTextToTexture` | `(config: TextCaptureConfig) → {texture, width, height} \| null` | OffscreenCanvas path (universal) |
| `isHtmlInCanvasAvailable` | `() → boolean` | Feature detect |
| `getHtmlInCanvasMode` | `() → 'webgpu-native' \| 'webgl-bridge' \| 'none'` | Which capture path |
| `setupHtmlInCanvas` | `(onPaint?) → cleanup function \| null` | One-time setup for HTML-in-Canvas |
| `requestHtmlPaint` | `() → void` | Force paint event next frame |
| `captureElementToTexture` | `(element: HTMLElement) → {texture, width, height} \| null` | Capture DOM element (needs flag) |
| `applyTextEffect` | `(src, effect, params) → GPUTexture \| null` | Single effect |
| `applyTextEffectChain` | `(src, effects[]) → GPUTexture \| null` | Chained effects |
| `createEffectedText` | `(textConfig, effects[]) → {texture, width, height} \| null` | Capture + effects one-liner |
| `stampEffectedText` | `(destX, destY, textConfig, effects[]) → Promise<boolean>` | Capture + effects + stamp to raster layer |

---

## Exported Types

All available from the `salsa` package:

```ts
import type {
  TextEffectType,          // 'chromatic-aberration' | 'glow' | 'wave' | 'glitch' | 'outline'
  TextEffectConfig,        // { type: TextEffectType, params: TextEffectParams }
  TextEffectParams,        // Union of all param types below
  TextCaptureConfig,       // Text content + styling for captureTextToTexture
  ChromaticAberrationParams,
  GlowParams,
  WaveParams,
  GlitchParams,
  OutlineParams,
} from 'salsa';

// Default param factories:
import {
  defaultChromaticAberration,
  defaultGlow,
  defaultWave,
  defaultGlitch,
  defaultOutline,
} from 'salsa';
```

---

## UI Suggestions for Frogmarks

### Text Effect Panel (speech balloon property panel extension)

Add an "Effects" section to the existing speech balloon sidebar:

| Control | Maps to |
|---|---|
| **Effect** dropdown | `TextEffectType` selection |
| **Add Effect** button | Appends to the effect chain |
| **Drag to reorder** | Reorders the chain array |
| **Remove** (× button) | Removes from chain |
| **Strength** slider | `ChromaticAberrationParams.strength` (0–0.02) |
| **Angle** slider | `ChromaticAberrationParams.angle` (0–6.28) |
| **Radius** slider | `GlowParams.radius` (1–20) |
| **Intensity** slider | `GlowParams.intensity` (0.5–5) |
| **Color** picker | `GlowParams.color` / `OutlineParams.color` |
| **Thickness** slider | `OutlineParams.thickness` (1–10) |
| **Amplitude** slider | `WaveParams.amplitude` (1–20) |
| **Frequency** slider | `WaveParams.frequency` (1–30) |
| **Animate** toggle | Starts/stops updating `time` in render loop |

### Preset Buttons

Quick-apply the recommended combos from the table above:
- 🔥 **Impact** — outline + chromatic aberration
- ✨ **Energy** — glow + chromatic aberration
- 👻 **Ghost** — wave + glow
- 💀 **Horror** — wave + outline
- 🤖 **Glitch** — glitch + chromatic aberration
- 💬 **Clean** — outline only
