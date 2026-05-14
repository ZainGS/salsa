# Frogmarks: LiveTextNode & Custom Shader Integration Spec
**Last Updated:** 2026-04-27  

> **Status:** Salsa implementation complete, build passing. **Updated April 11 2026.**  
> **Audience:** Frogmarks UI devs building the text tool sidebar, speech bubble sidebar, and custom shader editor.
> 
> **What changed (April 11):**
> - Effects now **animate** — wave ripples, glitch flickers, custom shaders have live `u.time`
> - Cursor-reactive uniforms (`u.cursor`, `u.mouseDown`) wired to pointer events
> - DPR sizing fix — text is now correct size on Retina/HiDPI displays
> - Input routing fixed — hotkeys are suppressed during LiveText editing
> - Overlay textarea is the single keyboard input path (HTML-in-Canvas div is visual-only)
> - `layoutsubtree` attribute auto-applied to canvas
> - Continuous rendering auto-managed for animated effects
> - Blur no longer auto-ends editing — only Escape or explicit `endLiveTextEditing()` does

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Detection & Progressive Enhancement](#detection--progressive-enhancement)
3. [Text Tool — Full Integration](#text-tool--full-integration)
4. [Speech Bubble Tool — Full Integration](#speech-bubble-tool--full-integration)
5. [Effect Chain UI](#effect-chain-ui)
6. [Custom Shader Editor](#custom-shader-editor)
7. [Selection Sync — Populating Sidebars](#selection-sync--populating-sidebars)
8. [Flatten to Layer](#flatten-to-layer)
9. [API Reference — Types](#api-reference--types)
10. [API Reference — ShapeManager Methods](#api-reference--shapemanager-methods)
11. [API Reference — SpeechBalloon Methods](#api-reference--speechballoon-methods)
12. [Preset Configurations](#preset-configurations)
13. [Example Shader Gallery](#example-shader-gallery)

---

## Quick Start

### Create a LiveTextNode with effects in 3 lines

```ts
const node = shapeManager.createLiveText(0, 0, {
  text: 'BOOM!',
  font: 'Impact',
  fontSize: 96,
  color: { r: 1, g: 0, b: 0, a: 1 },
  bold: true,
  padding: 24,
  effects: [
    { type: 'outline', params: { thickness: 4, color: [0, 0, 0, 1] } },
    { type: 'glow', params: { radius: 8, intensity: 2, color: [1, 0.3, 0] } },
  ],
});

// The node is now in the scene, rendering with effects every frame.
// Store node.id for sidebar binding.
```

### Create a speech balloon and enter edit mode

```ts
const balloon = shapeManager.createSpeechBalloon(x, y, {
  text: '',
  font: 'Noto Sans JP',
  fontSize: 48,
  style: 'rounded-rect',
  tailSide: 'bottom',
  tailPosition: 0.5,
  fillColor: { r: 1, g: 1, b: 1, a: 1 },
  strokeColor: { r: 0, g: 0, b: 0, a: 1 },
  strokeWidth: 2,
});

// CRITICAL: enter edit mode so the user can start typing immediately
const textNode = balloon.getTextNode();
if (textNode) {
  textNode.beginTyping(); // SDFText path — caret appears, keyboard input works
}
```

### Apply a custom shader from user input

```ts
const code = textareaElement.value; // user's WGSL code

// 1. Validate first (show errors before applying)
const result = await shapeManager.validateCustomShader(code);
if (!result.success) {
  showErrors(result.errors); // display in UI
  return;
}

// 2. Apply to the selected LiveTextNode
await shapeManager.setCustomShader(activeNodeId, code, false, [40, 5, 0.01, 0]);

// 3. Update params in real time via sliders (no recompilation)
slider.oninput = () => {
  shapeManager.setCustomShaderParams(activeNodeId, [
    sliderA.value, sliderB.value, sliderC.value, sliderD.value,
  ]);
};
```

---

## Detection & Progressive Enhancement

### Architecture: How Text Input Works (April 2026)

There are **two capture paths** but **one keyboard input path**:

```
┌─────────────────────────────────────────────────────────┐
│                    User types "hello"                    │
│                          │                              │
│                ┌─────────▼──────────┐                   │
│                │  Hidden <textarea> │  ← position: fixed│
│                │  (always created)  │    left: -9999px  │
│                └─────────┬──────────┘    opacity: 0.01  │
│                          │                              │
│                    'input' event                        │
│                          │                              │
│           ┌──────────────┼──────────────┐               │
│           ▼                             ▼               │
│   ┌───────────────┐            ┌────────────────┐       │
│   │ OffscreenCanvas│            │ DOM <div> inside│       │
│   │ captureText() │            │ <canvas layout- │       │
│   │ (fallback)    │            │  subtree>       │       │
│   └───────┬───────┘            │ captureElement()│       │
│           │                    └────────┬───────┘       │
│           ▼                             ▼               │
│   ┌─────────────────────────────────────────────┐       │
│   │        GPU Texture (source)                  │       │
│   ├─────────────────────────────────────────────┤       │
│   │  → Effect chain (wave, glow, outline, etc.) │       │
│   │  → Custom shader (user WGSL)                │       │
│   ├─────────────────────────────────────────────┤       │
│   │        GPU Texture (output)                  │       │
│   │  → Drawn as textured quad in WebGPU         │       │
│   └─────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

**Key points:**
- The hidden `<textarea>` handles ALL keyboard input (IME, Ctrl+Z, selection, etc.)
- The DOM `<div>` inside the canvas is only for visual capture (richer CSS rendering)
- The `<canvas>` gets `layoutsubtree` attribute automatically when first LiveTextNode is created
- The overlay textarea's blur does NOT end editing — it refocuses after clicking sidebar controls
- `isInputActive()` returns `true` during editing, suppressing hotkeys

```ts
// On app init, check what's available
const hasEffects = shapeManager.isHtmlInCanvasAvailable();
const captureMode = shapeManager.getHtmlInCanvasMode();
// captureMode: 'webgpu-native' | 'webgl-bridge' | 'none'

// Show/hide UI sections
effectsPanel.style.display       = hasEffects ? 'block' : 'none';
customShaderPanel.style.display  = hasEffects ? 'block' : 'none';
flattenButton.style.display      = hasEffects ? 'block' : 'none';

// The text editing UX is the same either way.
// When hasEffects=false, Salsa uses SDFText internally.
// Frogmarks calls the same ShapeManager API regardless.
```

---

## Text Tool — Full Integration

### Canvas Click Handler

```ts
function onCanvasClick_TextTool(worldX: number, worldY: number) {
  const hasLiveText = shapeManager.isHtmlInCanvasAvailable();

  if (hasLiveText) {
    // ── If already editing, end the current session ──
    if (activeNodeId && isLiveTextEditing) {
      shapeManager.endLiveTextEditing(activeNodeId);
      isLiveTextEditing = false;
      activeNodeId = null;
      return; // First click ends editing; next click creates new node
    }

    // ── Create new LiveTextNode ──
    const node = shapeManager.createLiveText(worldX, worldY, {
      text: '',
      font: currentFont,
      fontSize: currentFontSize,
      color: parseColor(currentColor),
      bold: currentBold,
      italic: currentItalic,
      writingMode: currentWritingMode,
      padding: 16,
      effects: [...currentEffects], // from sidebar effect chain
    });
    activeNodeId = node.id;

    // CRITICAL: Enter edit mode — this creates a hidden <textarea>, focuses
    // it after a setTimeout(0), and enters continuous rendering mode.
    // Salsa now handles:
    //  - isInputActive() returns true → hotkeys are suppressed
    //  - beginInteractive() → continuous rAF loop for live preview
    //  - The textarea receives ALL keyboard input (both paths)
    //  - The DOM element inside the canvas is visual-capture only
    shapeManager.beginLiveTextEditing(node.id);
    isLiveTextEditing = true;

  } else {
    // ── SDFText fallback ──
    // The SdfTextDrawingService handles this automatically
    // when its tool is enabled. No extra code needed.
  }
}
```

### Ending Edit Mode

```ts
// There are 3 ways editing ends:
//
// 1. Escape key — handled inside LiveTextNode's overlay textarea keydown handler.
//    Calls node.endEditing() internally. Frogmarks should ALSO listen for Escape
//    to update its own state:
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeNodeId && isLiveTextEditing) {
    shapeManager.endLiveTextEditing(activeNodeId);
    isLiveTextEditing = false;
    // Don't clear activeNodeId — the node is still selected, just not editing
  }
});

// 2. Click on canvas — handled in your click handler above (first click ends editing)

// 3. Programmatic — e.g. switching tools:
function onToolChange(newTool: string) {
  if (activeNodeId && isLiveTextEditing) {
    shapeManager.endLiveTextEditing(activeNodeId);
    isLiveTextEditing = false;
  }
}
```

> **Important:** Blur on the hidden textarea does NOT end editing anymore.
> If the user clicks a sidebar control (font dropdown, color picker), the textarea
> refocuses automatically so they can keep typing. Editing only ends via the 3
> explicit paths above.

### Sidebar → Salsa Wiring

```ts
// ── Font ──
fontDropdown.onchange = () => {
  shapeManager.setLiveTextStyle(activeNodeId, { font: fontDropdown.value });
};

// ── Size ──
fontSizeInput.onchange = () => {
  shapeManager.setLiveTextStyle(activeNodeId, { fontSize: Number(fontSizeInput.value) });
};

// ── Bold / Italic ──
boldToggle.onclick = () => {
  const newBold = !boldToggle.classList.contains('active');
  shapeManager.setLiveTextStyle(activeNodeId, { bold: newBold });
  boldToggle.classList.toggle('active', newBold);
};

italicToggle.onclick = () => {
  const newItalic = !italicToggle.classList.contains('active');
  shapeManager.setLiveTextStyle(activeNodeId, { italic: newItalic });
  italicToggle.classList.toggle('active', newItalic);
};

// ── Writing Mode ──
writingModeH.onclick = () => {
  shapeManager.setLiveTextStyle(activeNodeId, { writingMode: 'horizontal-tb' });
};
writingModeV.onclick = () => {
  shapeManager.setLiveTextStyle(activeNodeId, { writingMode: 'vertical-rl' });
};

// ── Text Color ──
textColorPicker.oninput = () => {
  shapeManager.setLiveTextStyle(activeNodeId, { color: parseColor(textColorPicker.value) });
};

// ── Max Width ──
maxWidthSlider.oninput = () => {
  shapeManager.setLiveTextStyle(activeNodeId, { maxWidth: Number(maxWidthSlider.value) });
};

// ── Line Height ──
lineHeightSlider.oninput = () => {
  shapeManager.setLiveTextStyle(activeNodeId, { lineHeight: Number(lineHeightSlider.value) });
};
```

### Keyboard — Hotkey Suppression

```ts
// CRITICAL: Salsa's shapeManager.isInputActive() now returns true when
// a LiveTextNode is being edited. Your handleHotkeys function should
// already check this — if it does, hotkeys are automatically suppressed.
//
// If you have a custom keydown handler, guard it like this:
window.addEventListener('keydown', (e) => {
  // Don't fire hotkeys while user is typing into LiveText (or SDF text, or raster text)
  if (shapeManager.isInputActive()) return;

  // ... your hotkey logic ...
});

// isInputActive() checks ALL text input paths:
//  - SDF text editing (sdfTextDrawingService.isUserTyping())
//  - Legacy canvas text (textDrawingService.isUserTyping())
//  - Raster text tool (rasterTextService active)
//  - LiveTextNode editing (new — _isLiveTextEditing flag)
```

### Text Tool Sidebar Layout

```
┌─────────────────────────────┐
│  TEXT TOOL                  │
├─────────────────────────────┤
│                             │
│  Font: [Arial         ▾]   │
│  Size: [48] px              │
│  Weight: [Regular     ▾]   │
│  Writing: [H] [V]          │
│                             │
│  ── Colors ──               │
│  Text:   [■ ●●●●●●]       │
│  Bg:     [none / ■]        │
│                             │
│  ── Effects ──  (if available) │
│  + Add Effect               │
│  ┌───────────────────┐      │
│  │ ✕ Outline          │      │
│  │   Thickness: ═══●  │      │
│  │   Color: [■]       │      │
│  ├───────────────────┤      │
│  │ ✕ Glow             │      │
│  │   Radius: ═══●     │      │
│  │   Intensity: ═══●  │      │
│  │   Color: [■]       │      │
│  └───────────────────┘      │
│                             │
│  ── Custom Shader ──        │
│  (see section below)        │
│                             │
│  ── Presets ──              │
│  [Impact] [Energy] [Ghost]  │
│  [Glitch] [Horror] [Clean]  │
│                             │
│  [Flatten to Layer]         │
│                             │
└─────────────────────────────┘
```

---

## Speech Bubble Tool — Full Integration

### Canvas Click Handler

```ts
function onCanvasClick_SpeechBubbleTool(worldX: number, worldY: number) {
  const balloon = shapeManager.createSpeechBalloon(worldX, worldY, {
    text: '',
    font: currentFont,
    fontSize: currentFontSize,
    writingMode: currentWritingMode,
    textColor: parseColor(currentTextColor),
    fillColor: parseColor(currentFillColor),
    strokeColor: parseColor(currentStrokeColor),
    strokeWidth: currentStrokeWidth,
    style: currentBalloonStyle,     // 'rounded-rect' | 'ellipse' | etc.
    tailSide: currentTailSide,      // 'bottom' | 'top' | 'left' | 'right'
    tailPosition: currentTailPos,   // 0–1 along edge
    showTail: currentShowTail,
  });

  activeBalloonId = balloon.id;

  // Enter text edit mode immediately
  const textNode = balloon.getTextNode();
  if (textNode) {
    textNode.beginTyping(); // SDFText: shows caret, accepts keyboard input
  }
}
```

### Sidebar → Salsa Wiring

```ts
// ── Balloon Style ──
onStyleChange(style: BalloonStyle) {
  shapeManager.setSpeechBalloonStyle(activeBalloonId, style);
}

// ── Text content (programmatic, not during live edit) ──
onTextChange(text: string) {
  shapeManager.setSpeechBalloonText(activeBalloonId, text);
}

// ── Writing Mode ──
onWritingModeChange(mode: 'horizontal-tb' | 'vertical-rl') {
  shapeManager.setSpeechBalloonWritingMode(activeBalloonId, mode);
}

// ── Tail Side ──
onTailSideChange(side: TailSide) {
  shapeManager.setSpeechBalloonTail(activeBalloonId, side, currentTailPosition);
}

// ── Tail Position ──
tailPositionSlider.oninput = () => {
  const pos = Number(tailPositionSlider.value); // 0–1
  shapeManager.setSpeechBalloonTail(activeBalloonId, currentTailSide, pos);
};

// ── Tail Length ──
tailLengthSlider.oninput = () => {
  const balloon = shapeManager.getSpeechBalloon(activeBalloonId);
  if (balloon) {
    balloon.setTailLength(Number(tailLengthSlider.value));
  }
};

// ── Show/Hide Tail ──
showTailCheckbox.onchange = () => {
  const balloon = shapeManager.getSpeechBalloon(activeBalloonId);
  if (balloon) balloon.setShowTail(showTailCheckbox.checked);
};

// ── Colors ──
textColorPicker.oninput = () => {
  const balloon = shapeManager.getSpeechBalloon(activeBalloonId);
  if (balloon) balloon.setTextColor(parseColor(textColorPicker.value));
};

fillColorPicker.oninput = () => {
  const balloon = shapeManager.getSpeechBalloon(activeBalloonId);
  if (balloon) balloon.setFillColor(parseColor(fillColorPicker.value));
};

strokeColorPicker.oninput = () => {
  const balloon = shapeManager.getSpeechBalloon(activeBalloonId);
  if (balloon) balloon.setStrokeColor(parseColor(strokeColorPicker.value));
};

// ── Font ──
fontDropdown.onchange = () => {
  const balloon = shapeManager.getSpeechBalloon(activeBalloonId);
  if (balloon) balloon.setFont(fontDropdown.value);
};

// ── Font Size ──
fontSizeInput.onchange = () => {
  const balloon = shapeManager.getSpeechBalloon(activeBalloonId);
  if (balloon) balloon.setFontSize(Number(fontSizeInput.value));
};

// ── Max Width ──
maxWidthSlider.oninput = () => {
  const balloon = shapeManager.getSpeechBalloon(activeBalloonId);
  if (balloon) balloon.setMaxWidth(Number(maxWidthSlider.value));
};
```

### Speech Bubble Sidebar Layout

```
┌──────────────────────────────────┐
│  SPEECH BUBBLE                   │
├──────────────────────────────────┤
│                                  │
│  ── Balloon Style ──             │
│  [Rounded] [Ellipse] [Cloud]    │
│  [Burst]   [Thought]            │
│                                  │
│  ── Text ──                      │
│  Font: [Arial            ▾]     │
│  Size: [48] px                   │
│  Writing: [H] [V]               │
│  Max Width: ════════●  1.5      │
│                                  │
│  ── Colors ──                    │
│  Text:    [■ ●●●●●●]           │
│  Fill:    [■ ●●●●●●]           │
│  Stroke:  [■ ●●●●●●]           │
│  Stroke W: ═●  2px              │
│                                  │
│  ── Tail ──                      │
│  Show: [✓]                       │
│  Side: [↑] [→] [↓] [←]         │
│  Position: ════●═══  0.3        │
│  Length: ═══●═════  0.1          │
│                                  │
│  ── Text Effects ──  (if avail)  │
│  + Add Effect                    │
│  (same effect chain UI as Text)  │
│                                  │
│  ── Presets ──                   │
│  [Clean] [Shout] [Whisper]       │
│  [Thought] [Scream] [Narration] │
│                                  │
└──────────────────────────────────┘
```

---

## Effect Chain UI

### Effect Categories

Effects fall into two categories:

| Category | Effects | Behavior | Rendering |
|----------|---------|----------|-----------|
| **Static** | `outline`, `glow` | Apply once, look the same every frame | On-demand (single frame) |
| **Animated** | `wave`, `glitch`, `custom`, `chromatic-aberration` | Use `u.time` and/or `u.cursor` — change every frame | Continuous rAF loop |

Salsa auto-manages the rendering mode. When you call `setLiveTextEffects()`:
- If any animated effect is added → `beginInteractive()` (continuous frames)
- When all animated effects are removed → `endInteractive()` (on-demand)
- No Frogmarks code needed to manage this

### Dynamic Uniforms (auto-set per frame)

These are fed into effects automatically. **Do not expose as sliders.**

| Uniform | Source | Used by |
|---------|--------|---------|
| `u.time` | `performance.now() / 1000` | wave, glitch, custom |
| `u.cursor` | Pointer UV [0–1, 0–1] | chromatic-aberration, custom |
| `u.mouseDown` | 0.0 or 1.0 | chromatic-aberration, custom |

### Adding / Removing Effects

```ts
// ── Add Effect button ──
function addEffect(type: TextEffectType) {
  const defaults = {
    'chromatic-aberration': { strength: 0.005, angle: 0 },
    'glow':    { radius: 4, intensity: 1.5 },
    'wave':    { amplitude: 3, frequency: 10, speed: 1, time: 0 },
    'glitch':  { intensity: 0.3, blockSize: 8, time: 0 },
    'outline': { thickness: 2, color: [0, 0, 0, 1] },
  };
  const params = defaults[type];
  if (!params) return;

  const node = shapeManager.getLiveTextNode(activeNodeId);
  if (!node) return;

  const effects = [...node.effects, { type, params }];
  shapeManager.setLiveTextEffects(activeNodeId, effects);
  refreshEffectsList();
}

// ── Remove Effect (✕ button) ──
function removeEffect(index: number) {
  const node = shapeManager.getLiveTextNode(activeNodeId);
  if (!node) return;

  const effects = [...node.effects];
  effects.splice(index, 1);
  shapeManager.setLiveTextEffects(activeNodeId, effects);
  refreshEffectsList();
}
```

### Effect Parameter Sliders

```ts
// When any slider changes, rebuild the full effect array and push it
function onEffectParamChange(index: number, paramKey: string, value: number) {
  const node = shapeManager.getLiveTextNode(activeNodeId);
  if (!node) return;

  const effects = [...node.effects];
  effects[index] = {
    ...effects[index],
    params: { ...effects[index].params, [paramKey]: value },
  };
  shapeManager.setLiveTextEffects(activeNodeId, effects);
}
```

### Effect Parameter Ranges

| Effect | Parameter | Type | Range | Default | Slider Step |
|--------|-----------|------|-------|---------|-------------|
| **Chromatic Aberration** | `strength` | float | 0 – 0.05 | 0.005 | 0.001 |
| | `angle` | float | 0 – 6.28 (2π) | 0 | 0.1 |
| | `cursorRadius` | float | 0 – 1.0 | 0.3 | 0.05 |
| **Glow** | `radius` | int | 1 – 32 | 4 | 1 |
| | `intensity` | float | 0 – 5.0 | 1.5 | 0.1 |
| | `color` | [r,g,b] | 0–1 each | text color | — |
| **Wave** | `amplitude` | float | 0 – 20 | 3 | 1 |
| | `frequency` | float | 1 – 50 | 10 | 1 |
| | `speed` | float | 0 – 10 | 1 | 0.1 |
| **Glitch** | `intensity` | float | 0 – 1 | 0.3 | 0.05 |
| | `blockSize` | int | 2 – 32 | 8 | 1 |
| **Outline** | `thickness` | int | 1 – 16 | 2 | 1 |
| | `color` | [r,g,b,a] | 0–1 each | [0,0,0,1] | — |

> **Note:** `time` on Wave and Glitch is set automatically per frame from `performance.now() / 1000`. Don't expose it as a slider. Same for `cursorUV` and `mouseDown` on Chromatic Aberration and Custom — these are auto-injected from pointer events.

---

## Custom Shader Editor

### UI Layout

```
┌─────────────────────────────────────┐
│  ── Custom Shader ──                │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ // Your WGSL code here      │    │
│  │ let c = textureLoad(src,    │    │
│  │   vec2<i32>(gid.xy), 0);   │    │
│  │ let grey = dot(c.rgb,       │    │
│  │   vec3(0.299, 0.587, 0.114));│   │
│  │ textureStore(dst, gid.xy,   │    │
│  │   vec4(vec3(grey), c.a));   │    │
│  └─────────────────────────────┘    │
│                                     │
│  [Validate]  [Apply]  [Remove]      │
│                                     │
│  ✓ Compiled successfully            │
│  ─── OR ───                         │
│  ✕ Line 3:12 — expected ';'        │
│                                     │
│  ── Params (u.params.xyzw) ──       │
│  A: ════════●═══  40.0             │
│  B: ════●════════  5.0             │
│  C: ●═══════════  0.01            │
│  D: ●═══════════  0.0             │
│                                     │
│  [ ] Advanced mode (raw WGSL)       │
│                                     │
│  ── Snippets ──                     │
│  [Grayscale] [Invert] [Sepia]      │
│  [Ripple] [Pixelate] [Vignette]    │
│                                     │
└─────────────────────────────────────┘
```

### Wiring the Editor

```ts
let isAdvancedMode = false;

// ── Validate button ──
validateBtn.onclick = async () => {
  const code = shaderTextarea.value;
  const result = await shapeManager.validateCustomShader(code, isAdvancedMode);

  if (result.success) {
    statusEl.textContent = '✓ Compiled successfully';
    statusEl.className = 'shader-status success';
  } else {
    statusEl.textContent = '✕ ' + result.errors!.join('\n✕ ');
    statusEl.className = 'shader-status error';
  }
};

// ── Apply button ──
applyBtn.onclick = async () => {
  if (!activeNodeId) return;

  const code = shaderTextarea.value;
  const params: [number, number, number, number] = [
    Number(paramSliderA.value),
    Number(paramSliderB.value),
    Number(paramSliderC.value),
    Number(paramSliderD.value),
  ];

  const result = await shapeManager.setCustomShader(
    activeNodeId,
    code,
    isAdvancedMode,
    params,
  );

  if (result.success) {
    statusEl.textContent = '✓ Shader applied';
    statusEl.className = 'shader-status success';
  } else {
    statusEl.textContent = '✕ ' + result.errors!.join('\n✕ ');
    statusEl.className = 'shader-status error';
  }
};

// ── Remove button ──
removeBtn.onclick = () => {
  if (activeNodeId) shapeManager.removeCustomShader(activeNodeId);
  statusEl.textContent = '';
};

// ── Param sliders (real-time, no recompilation) ──
[paramSliderA, paramSliderB, paramSliderC, paramSliderD].forEach((slider, i) => {
  slider.oninput = () => {
    if (!activeNodeId) return;
    const params: [number, number, number, number] = [
      Number(paramSliderA.value),
      Number(paramSliderB.value),
      Number(paramSliderC.value),
      Number(paramSliderD.value),
    ];
    shapeManager.setCustomShaderParams(activeNodeId, params);
  };
});

// ── Advanced mode checkbox ──
advancedCheckbox.onchange = () => {
  isAdvancedMode = advancedCheckbox.checked;
};
```

### Available Variables in Simplified Mode

Users write just the effect body. These variables are available automatically:

| Variable | Type | Description |
|----------|------|-------------|
| `gid` | `vec3<u32>` | Pixel coordinate (global invocation ID) |
| `uv` | `vec2<f32>` | Normalized coordinates [0–1] |
| `dim` | `vec2<u32>` | Texture dimensions in texels |
| `src` | `texture_2d<f32>` | Input texture (read) |
| `dst` | `texture_storage_2d<rgba8unorm, write>` | Output texture (write) |
| `u.resolution` | `vec2<f32>` | Same as dim but as float |
| `u.time` | `f32` | Animation time in seconds (auto-updated) |
| `u.mouseDown` | `f32` | 1.0 if mouse pressed, 0.0 otherwise |
| `u.cursor` | `vec2<f32>` | Cursor position in UV space [0–1] |
| `u.params` | `vec4<f32>` | 4 user-defined floats from sliders (A/B/C/D) |

### Safety

- WGSL runs in the **GPU sandbox** — no filesystem, network, or DOM access
- Worst case: GPU process crash → Chrome recovers automatically
- `validateCustomShader()` catches errors via `getCompilationInfo()` and returns line/column errors
- Pipelines are cached by code hash — editing evicts the old one
- `time`, `cursor`, `mouseDown` are auto-injected per frame

---

## Selection Sync — Populating Sidebars

```ts
// Listen for selection changes
shapeManager.onSelectionChanged((selected) => {
  if (selected.length !== 1) {
    activeNodeId = null;
    activeBalloonId = null;
    hideSidebar();
    return;
  }

  const node = selected[0];

  // ── Speech Balloon? ──
  const balloon = shapeManager.getSpeechBalloon(node.id);
  if (balloon) {
    activeBalloonId = node.id;
    activeNodeId = null;
    populateBalloonSidebar(balloon);
    return;
  }

  // ── LiveTextNode? ──
  const liveText = shapeManager.getLiveTextNode(node.id);
  if (liveText) {
    activeNodeId = node.id;
    activeBalloonId = null;
    populateTextSidebar(liveText);
    return;
  }

  // ── Other shape ──
  activeNodeId = null;
  activeBalloonId = null;
  showGenericSidebar(node);
});
```

### Populating the Text Sidebar

```ts
function populateTextSidebar(node: LiveTextNode) {
  showPanel('text-panel');

  fontDropdown.value      = node.font;
  fontSizeInput.value     = String(node.fontSize);
  boldToggle.classList.toggle('active', node.bold);
  italicToggle.classList.toggle('active', node.italic);
  writingModeH.classList.toggle('active', node.writingMode === 'horizontal-tb');
  writingModeV.classList.toggle('active', node.writingMode === 'vertical-rl');
  textColorPicker.value   = rgbaToHex(node.textColor);
  maxWidthSlider.value    = String(node.maxWidth);
  lineHeightSlider.value  = String(node.lineHeight);

  // Effects list
  refreshEffectsList(node.effects);

  // Custom shader
  const customFx = node.effects.find(e => e.type === 'custom');
  if (customFx) {
    const p = customFx.params as CustomShaderParams;
    shaderTextarea.value = p.rawCode ?? p.code ?? '';
    paramSliderA.value = String(p.params?.[0] ?? 0);
    paramSliderB.value = String(p.params?.[1] ?? 0);
    paramSliderC.value = String(p.params?.[2] ?? 0);
    paramSliderD.value = String(p.params?.[3] ?? 0);
    advancedCheckbox.checked = !!p.rawCode;
  } else {
    shaderTextarea.value = '';
  }

  // Show effects panel only if HTML-in-Canvas is available
  effectsPanel.style.display = shapeManager.isHtmlInCanvasAvailable() ? 'block' : 'none';
}
```

### Populating the Balloon Sidebar

```ts
function populateBalloonSidebar(balloon: SpeechBalloon) {
  showPanel('balloon-panel');

  // Style buttons
  setActiveStyleButton(balloon.balloonStyle);

  // Text
  fontDropdown.value    = balloon.textNode.font;
  fontSizeInput.value   = String(balloon.textNode.fontSize);
  writingModeH.classList.toggle('active', balloon.writingMode === 'horizontal-tb');
  writingModeV.classList.toggle('active', balloon.writingMode === 'vertical-rl');
  maxWidthSlider.value  = String(balloon.maxWidth);

  // Colors
  textColorPicker.value   = rgbaToHex(balloon.textNode.fillColor);
  fillColorPicker.value   = rgbaToHex(balloon.balloonFillColor);
  strokeColorPicker.value = rgbaToHex(balloon.balloonStrokeColor);
  strokeWidthSlider.value = String(balloon.balloonStrokeWidth);

  // Tail
  showTailCheckbox.checked  = balloon.showTail;
  setActiveTailButton(balloon.tailSide);
  tailPositionSlider.value  = String(balloon.tailPosition);
  tailLengthSlider.value    = String(balloon.tailLength);

  // Effects (if LiveTextNode is attached)
  const liveNode = balloon.getLiveTextNode();
  if (liveNode) {
    refreshEffectsList(liveNode.effects);
    effectsPanel.style.display = 'block';
  } else {
    effectsPanel.style.display = 'none';
  }
}
```

---

## Flatten to Layer

```ts
// Flatten button handler
flattenBtn.onclick = async () => {
  if (!activeNodeId) return;

  const success = await shapeManager.flattenLiveText(activeNodeId);
  if (success) {
    // Node is gone — clear selection
    activeNodeId = null;
    hideSidebar();
    showToast('Text flattened to raster layer');
  } else {
    showToast('Failed to flatten — no active raster layer?', 'error');
  }
};
```

> **Warning:** Flatten is destructive and one-way. The LiveTextNode is destroyed and its pixels are baked into the active raster layer. Consider showing a confirmation dialog.

---

## API Reference — Types

### `RGBA`

```ts
interface RGBA {
  r: number;  // 0–1
  g: number;  // 0–1
  b: number;  // 0–1
  a: number;  // 0–1
}
```

### `LiveTextOptions`

```ts
interface LiveTextOptions {
  text?: string;
  font?: string;                              // default: 'Arial'
  fontSize?: number;                          // default: 48
  color?: RGBA;                               // default: black
  bold?: boolean;                             // default: false
  italic?: boolean;                           // default: false
  writingMode?: 'horizontal-tb' | 'vertical-rl';  // default: 'horizontal-tb'
  maxWidth?: number;                          // default: 0 (no limit)
  lineHeight?: number;                        // default: 1.2
  padding?: number;                           // default: 16
  effects?: TextEffectConfig[];               // default: []
}
```

### `TextEffectConfig`

```ts
interface TextEffectConfig {
  type: 'chromatic-aberration' | 'glow' | 'wave' | 'glitch' | 'outline' | 'custom';
  params: TextEffectParams;
}
```

### `CustomShaderParams`

```ts
interface CustomShaderParams {
  code?: string;        // Simplified mode — just the effect body
  rawCode?: string;     // Advanced mode — full WGSL module
  params?: [number, number, number, number];  // user-defined floats → u.params
  time?: number;        // auto-set per frame
  cursorUV?: [number, number];  // auto-set per frame
  mouseDown?: number;   // auto-set per frame
}
```

### `CustomShaderCompileResult`

```ts
interface CustomShaderCompileResult {
  success: boolean;
  errors?: string[];    // Human-readable: "Line 3:12 — expected ';'"
}
```

### `SpeechBalloonOptions`

```ts
interface SpeechBalloonOptions {
  text?: string;
  font?: string;                  // default: 'Arial'
  fontSize?: number;              // default: 90
  lineHeight?: number;            // default: 1.25
  textColor?: RGBA;               // default: black
  fillColor?: RGBA;               // default: white
  strokeColor?: RGBA;             // default: black
  strokeWidth?: number;           // default: 2
  writingMode?: 'horizontal-tb' | 'vertical-rl';
  tailSide?: TailSide;           // default: 'bottom'
  tailPosition?: number;          // default: 0.3 (0–1 along edge)
  tailLength?: number;            // default: 0.15
  tailWidth?: number;             // default: 0.08
  showTail?: boolean;             // default: true
  style?: BalloonStyle;           // default: 'rounded-rect'
  minWidth?: number;              // default: 0.3
  minHeight?: number;             // default: 0.2
  maxWidth?: number;              // default: 1.5
}

type TailSide = 'top' | 'right' | 'bottom' | 'left';
type BalloonStyle = 'ellipse' | 'rounded-rect' | 'cloud' | 'burst' | 'thought';
```

---

## API Reference — ShapeManager Methods

### LiveTextNode

| Method | Signature | Notes |
|--------|-----------|-------|
| **createLiveText** | `(x, y, options?) → LiveTextNode` | Creates node, wires engine, adds to scene, sets `layoutsubtree` |
| **setLiveTextEffects** | `(nodeId, effects[]) → void` | Replace entire effect chain. Auto-manages `beginInteractive`/`endInteractive` |
| **setLiveTextContent** | `(nodeId, text) → void` | Update text string |
| **setLiveTextStyle** | `(nodeId, Partial<LiveTextOptions>) → void` | Update any style prop |
| **beginLiveTextEditing** | `(nodeId) → void` | Creates hidden textarea, focuses it, wires `onChange → scheduleRender`, enters interactive mode, sets `_isLiveTextEditing` |
| **endLiveTextEditing** | `(nodeId) → void` | Removes textarea, clears `onChange`, exits interactive mode, clears `_isLiveTextEditing` |
| **flattenLiveText** | `(nodeId) → Promise<boolean>` | Bake onto raster layer (destructive). Cleans up interactive mode if animated |
| **getLiveTextNode** | `(nodeId) → LiveTextNode \| null` | Get by ID |
| **isInputActive** | `() → boolean` | Returns `true` when any text input is active (SDF, legacy, raster, **or LiveText**) |

### LiveTextNode Properties (read from instance)

| Property | Type | Notes |
|----------|------|-------|
| `needsAnimation` | `boolean` | `true` if any effect uses `time`/`cursor` (wave, glitch, custom, chromatic-aberration) |
| `isEditing` | `boolean` | `true` while `beginEditing()` is active |
| `dynamicUniforms` | `DynamicUniforms` | `{ time, cursorUV, mouseDown }` — auto-set by render strategy each frame |

### Custom Shaders

| Method | Signature | Notes |
|--------|-----------|-------|
| **validateCustomShader** | `(code, rawCode?) → Promise<CompileResult>` | Validate without applying |
| **setCustomShader** | `(nodeId, code, rawCode?, params?) → Promise<CompileResult>` | Validate + apply |
| **setCustomShaderParams** | `(nodeId, [a,b,c,d]) → void` | Update params (no recompile) |
| **removeCustomShader** | `(nodeId) → void` | Remove custom effect, keep built-ins |

### Speech Balloon

| Method | Signature | Notes |
|--------|-----------|-------|
| **createSpeechBalloon** | `(x, y, options?) → SpeechBalloon` | Creates balloon, adds to scene |
| **getSpeechBalloon** | `(nodeId) → SpeechBalloon \| null` | Get by ID |
| **setSpeechBalloonText** | `(nodeId, text) → void` | |
| **setSpeechBalloonWritingMode** | `(nodeId, mode) → void` | |
| **setSpeechBalloonTail** | `(nodeId, side, position, length?) → void` | |
| **setSpeechBalloonTailTarget** | `(nodeId, worldX, worldY) → void` | Point tail at world pos |
| **setSpeechBalloonStyle** | `(nodeId, style) → void` | |
| **getSpeechBalloonTailPoints** | `(nodeId) → {x,y}[]` | For overlay rendering |

### Detection

| Method | Signature | Notes |
|--------|-----------|-------|
| **isHtmlInCanvasAvailable** | `() → boolean` | Any capture path works |
| **getHtmlInCanvasMode** | `() → 'webgpu-native' \| 'webgl-bridge' \| 'none'` | |

---

## API Reference — SpeechBalloon Methods

Called directly on the `SpeechBalloon` instance (from `getSpeechBalloon()`):

| Method | Notes |
|--------|-------|
| `getTextNode() → SDFText` | Always present (fallback + layout) |
| `getLiveTextNode() → LiveTextNode \| null` | Present when HTML-in-Canvas active |
| `setLiveTextNode(node)` | Attach LiveTextNode, hide SDFText |
| `setText(text)` | Syncs to both SDFText + LiveTextNode |
| `setFont(font)` | Syncs to both |
| `setFontSize(size)` | Syncs to both |
| `setWritingMode(mode)` | Syncs to both |
| `setTextColor(color)` | Syncs to both |
| `setFillColor(color)` | Background rectangle |
| `setStrokeColor(color)` | Background rectangle |
| `setTailSide(side)` | |
| `setTailPosition(pos)` | 0–1 along edge |
| `setTailLength(len)` | World units |
| `setShowTail(bool)` | |
| `setBalloonStyle(style)` | |
| `setMaxWidth(w)` | Triggers re-layout |
| `setLineHeight(lh)` | |
| `getTailPoints() → {x,y}[]` | Local coords, 3 points |
| `getTailTipWorld() → {x,y}` | World coords |
| `setTailTipWorld(x,y)` | Auto-computes side from angle |

---

## Preset Configurations

### Text Presets

```ts
const TEXT_PRESETS = {
  'Impact': {
    font: 'Impact', fontSize: 96, bold: true,
    effects: [
      { type: 'outline', params: { thickness: 4, color: [0, 0, 0, 1] } },
    ],
  },
  'Energy': {
    font: 'Impact', fontSize: 80, bold: true,
    color: { r: 1, g: 0.9, b: 0, a: 1 },
    effects: [
      { type: 'outline', params: { thickness: 3, color: [0, 0, 0, 1] } },
      { type: 'glow', params: { radius: 6, intensity: 2.0, color: [1, 0.5, 0] } },
    ],
  },
  'Ghost': {
    font: 'Georgia', fontSize: 64, italic: true,
    color: { r: 0.7, g: 0.7, b: 0.9, a: 0.8 },
    effects: [
      { type: 'glow', params: { radius: 12, intensity: 1.5, color: [0.5, 0.5, 1] } },
    ],
  },
  'Glitch': {
    font: 'Courier New', fontSize: 72, bold: true,
    effects: [
      { type: 'glitch', params: { intensity: 0.5, blockSize: 6, time: 0 } },
      { type: 'chromatic-aberration', params: { strength: 0.008, angle: 0 } },
    ],
  },
  'Horror': {
    font: 'Times New Roman', fontSize: 80,
    color: { r: 0.8, g: 0, b: 0, a: 1 },
    effects: [
      { type: 'outline', params: { thickness: 2, color: [0, 0, 0, 1] } },
      { type: 'wave', params: { amplitude: 2, frequency: 15, speed: 0.5, time: 0 } },
    ],
  },
  'Clean': {
    font: 'Arial', fontSize: 48,
    effects: [],
  },
};
```

### Speech Balloon Presets

```ts
const BALLOON_PRESETS = {
  'Clean': {
    style: 'rounded-rect', tailSide: 'bottom', tailPosition: 0.5, showTail: true,
    effects: [{ type: 'outline', params: { thickness: 2, color: [0, 0, 0, 1] } }],
  },
  'Shout': {
    style: 'burst', tailSide: 'bottom', tailPosition: 0.3, showTail: true,
    fontSize: 72, bold: true,
    effects: [
      { type: 'outline', params: { thickness: 3, color: [0, 0, 0, 1] } },
      { type: 'chromatic-aberration', params: { strength: 0.004, angle: 0 } },
    ],
  },
  'Whisper': {
    style: 'ellipse', tailSide: 'bottom', tailPosition: 0.5, showTail: true,
    fontSize: 36, italic: true,
    strokeWidth: 1, // dashed stroke (render-side)
    effects: [],
  },
  'Thought': {
    style: 'thought', tailSide: 'bottom', tailPosition: 0.3, showTail: true,
    effects: [],
  },
  'Scream': {
    style: 'burst', tailSide: 'bottom', tailPosition: 0.5, showTail: true,
    fontSize: 96, bold: true,
    effects: [
      { type: 'outline', params: { thickness: 4, color: [0, 0, 0, 1] } },
      { type: 'glow', params: { radius: 4, intensity: 1.5 } },
    ],
  },
  'Narration': {
    style: 'rounded-rect', showTail: false,
    fillColor: { r: 0.95, g: 0.95, b: 0.9, a: 1 },
    effects: [],
  },
};
```

---

## Example Shader Gallery

These can be loaded as snippets in the Custom Shader editor.

### Grayscale

```wgsl
let c = textureLoad(src, vec2<i32>(gid.xy), 0);
let grey = dot(c.rgb, vec3<f32>(0.299, 0.587, 0.114));
textureStore(dst, gid.xy, vec4<f32>(vec3(grey), c.a));
```

### Invert Colors

```wgsl
let c = textureLoad(src, vec2<i32>(gid.xy), 0);
textureStore(dst, gid.xy, vec4<f32>(1.0 - c.rgb, c.a));
```

### Sepia Tone

```wgsl
let c = textureLoad(src, vec2<i32>(gid.xy), 0);
let r = dot(c.rgb, vec3<f32>(0.393, 0.769, 0.189));
let g = dot(c.rgb, vec3<f32>(0.349, 0.686, 0.168));
let b = dot(c.rgb, vec3<f32>(0.272, 0.534, 0.131));
textureStore(dst, gid.xy, vec4<f32>(min(r, 1.0), min(g, 1.0), min(b, 1.0), c.a));
```

### Cursor-Reactive Ripple

Params: A=frequency(40), B=speed(5), C=amplitude(0.01), D=unused

```wgsl
let dist = distance(uv, u.cursor);
let ripple = sin(dist * u.params.x - u.time * u.params.y) * u.params.z;
let offset = vec2<i32>(vec2<f32>(f32(dim.x), f32(dim.y)) * vec2<f32>(ripple, 0.0));
let coord = clamp(vec2<i32>(gid.xy) + offset, vec2<i32>(0), vec2<i32>(i32(dim.x)-1, i32(dim.y)-1));
let c = textureLoad(src, coord, 0);
textureStore(dst, gid.xy, c);
```

### Pixelate

Params: A=pixel size(8)

```wgsl
let ps = max(u.params.x, 1.0);
let pixelCoord = vec2<i32>(vec2<f32>(floor(vec2<f32>(f32(gid.x), f32(gid.y)) / ps) * ps));
let c = textureLoad(src, pixelCoord, 0);
textureStore(dst, gid.xy, c);
```

### Vignette

Params: A=radius(0.7), B=softness(0.4)

```wgsl
let c = textureLoad(src, vec2<i32>(gid.xy), 0);
let center = vec2<f32>(0.5, 0.5);
let dist = distance(uv, center);
let vignette = smoothstep(u.params.x, u.params.x - u.params.y, dist);
textureStore(dst, gid.xy, vec4<f32>(c.rgb * vignette, c.a));
```

### Cursor Magnify

Params: A=radius(0.15), B=zoom(2.0)

```wgsl
let toCursor = uv - u.cursor;
let dist = length(toCursor);
var sampleUV = uv;
if (dist < u.params.x) {
  sampleUV = u.cursor + toCursor / u.params.y;
}
let coord = vec2<i32>(clamp(vec2<i32>(sampleUV * vec2<f32>(f32(dim.x), f32(dim.y))), vec2<i32>(0), vec2<i32>(i32(dim.x)-1, i32(dim.y)-1)));
let c = textureLoad(src, coord, 0);
textureStore(dst, gid.xy, c);
```

### RGB Split on Mouse Down

Params: A=offset(0.01)

```wgsl
let off = u.params.x * u.mouseDown;
let dimF = vec2<f32>(f32(dim.x), f32(dim.y));
let maxC = vec2<i32>(i32(dim.x)-1, i32(dim.y)-1);
let coordR = vec2<i32>(clamp(vec2<i32>(dimF * (uv + vec2<f32>(off, 0.0))), vec2<i32>(0), maxC));
let coordG = vec2<i32>(gid.xy);
let coordB = vec2<i32>(clamp(vec2<i32>(dimF * (uv - vec2<f32>(off, 0.0))), vec2<i32>(0), maxC));
let r = textureLoad(src, coordR, 0).r;
let g = textureLoad(src, coordG, 0).g;
let b = textureLoad(src, coordB, 0).b;
let a = textureLoad(src, coordG, 0).a;
textureStore(dst, gid.xy, vec4<f32>(r, g, b, a));
```

### Rainbow Cycle (time-only, no cursor)

Params: A=speed(1), B=saturation(0.3)

```wgsl
let c = textureLoad(src, vec2<i32>(gid.xy), 0);
let hue = fract(uv.x + u.time * u.params.x);
let hueR = abs(hue * 6.0 - 3.0) - 1.0;
let hueG = 2.0 - abs(hue * 6.0 - 2.0);
let hueB = 2.0 - abs(hue * 6.0 - 4.0);
let tint = clamp(vec3<f32>(hueR, hueG, hueB), vec3(0.0), vec3(1.0));
let mixed = mix(c.rgb, tint, u.params.y * c.a);
textureStore(dst, gid.xy, vec4<f32>(mixed, c.a));
```

### Breathing Glow (time-only)

Params: A=speed(2), B=min_brightness(0.6), C=max_brightness(1.4)

```wgsl
let c = textureLoad(src, vec2<i32>(gid.xy), 0);
let pulse = mix(u.params.y, u.params.z, (sin(u.time * u.params.x) + 1.0) * 0.5);
textureStore(dst, gid.xy, vec4<f32>(c.rgb * pulse, c.a));
```

### Scan Line (time-only)

Params: A=speed(2), B=line_width(0.05), C=intensity(0.5)

```wgsl
let c = textureLoad(src, vec2<i32>(gid.xy), 0);
let line = fract(u.time * u.params.x);
let dist = abs(uv.y - line);
let glow = smoothstep(u.params.y, 0.0, dist) * u.params.z;
textureStore(dst, gid.xy, vec4<f32>(c.rgb + vec3(glow), c.a));
```

---

## Roadmap

### Phase 1 (Done — April 11 2026)
- [x] DPR sizing fix for HTML-in-Canvas path
- [x] `dynamicUniforms.time` fed from `performance.now()` every frame
- [x] `dynamicUniforms.cursorUV` and `mouseDown` fed from pointer events
- [x] `needsAnimation` property on LiveTextNode
- [x] `beginInteractive()`/`endInteractive()` auto-managed for animated effects
- [x] `isInputActive()` includes LiveTextNode editing state
- [x] Overlay textarea: unified keyboard input path, no auto-end on blur
- [x] `layoutsubtree` attribute auto-set on canvas
- [x] Hotkey suppression during LiveText editing

### Phase 2 (Frogmarks UI — No Salsa Changes Needed)
- [ ] Effect chain stacking UI (already supported by API — array of effects)
- [ ] Per-effect param sliders (already documented above)
- [ ] Preview animation loop in sidebar
- [ ] Save/load effect chains as user presets (serialize `TextEffectConfig[]` + custom shader)
- [ ] Snippet library for custom shaders (gallery above)

### Phase 3 (Text Effect Designer — Future)
- [ ] State machine: `idle | hover | active | focus` each with own effect chain
- [ ] Transition blending between states (lerp between two textures)
- [ ] Save/export as portable preset format
- [ ] Requires one new Salsa feature: blend compute shader for state transitions
