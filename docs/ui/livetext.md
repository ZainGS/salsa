# Frogmarks: LiveTextNode & Custom Shader Integration Spec
**Last Updated:** 2026-06-16  

> **Status:** Salsa implementation complete, build passing. **Updated June 16 2026.**  
> **Audience:** Frogmarks UI devs building the text tool sidebar, speech bubble sidebar, and custom shader editor.
>
> **What changed (June 17 — polish pass):**
> - **🆕 Resize = frame resize; the text no longer scales.** Dragging a LiveText's scaling handles now resizes its **text frame** (`LiveTextNode.resizeFrameWorld` → `frameWidth/frameHeight`) instead of applying a uniform `scaleX/scaleY`. The **font keeps its UI-set size** and the text reflows/clips inside the box — box size and text size are now fully **independent** (the earlier "size model" fix still scaled the glyphs with the box; this supersedes it). Because the resize writes `width/height` **every drag tick** (no `scaleX`), the selection box / any overlay reading `node.width/height` track the drag **live** — no more "updates only on mouse-up" lag and nothing to bake on release. (The render quad draws at the texture's own size — `renderWidth/renderHeight` — so the one-frame-late HTML capture is never stretched onto the freshly-resized frame; that was a transient "text pulled then snaps back" wobble while dragging.) Framed boxes are now **fixed width AND height** (`overflow:hidden`: text bigger than the box is clipped — make the box bigger or the font smaller). Auto-fit boxes (click *without* drag) still grow with content.
> - **Crisper text** — the HTML capture now **supersamples 2×** (`LiveTextNode._captureScale`), so glyphs stay sharp when zoomed instead of upscaling-blurry. Tunable; raise for more crispness at the cost of texture memory.
> - **Empty nodes auto-clean** — `endLiveTextEditing` now **removes a node left with empty/whitespace text** (clicked-but-never-typed, or fully backspaced), so you can't accumulate invisible empty boxes.
> - **✅ Scaling FIXED (size model)** — LiveText now stores its real size in `_width/_height` with `scaleX/scaleY` as a pure user multiplier (like every other shape), so the transform handles **scale instead of translate**, and the selection box hugs the content. **Saved docs migrate automatically** (a `sizeModel:'v2'` marker; legacy `scaleX/scaleY` reset to 1 + auto-fit). *Verify resize on a live build.*
> - **New: `createLiveTextInRect(rect, options?)`** — a drawn box becomes a **fixed text FRAME** (`frameWidth`/`frameHeight`): it keeps the size you drew, text wraps *inside* at the current font size, and the frame grows only if text overflows (vs. the old auto-fit-to-content that discarded your box). The font is **not** derived from the box (that made tall/narrow boxes huge) — pass a derived `fontSize` yourself if you want box-scaled text. See [Creating by click-drag](#creating-livetext-by-clickdrag-variable-size).
> - **New: `setRectDrawCallback(cb|null)`** — Salsa now **owns the click-drag interaction** too: while set, a drag draws the marching-ants box (no node selection) and calls back with the world rect. This fixes the **box-select tool competing** with the text-box drag. Frogmarks just sets it on text-tool activate / clears on deactivate (no custom pointer handling).
> - **New options:** `backgroundColor` (filled box behind the text) and `align` (left/center/right) — wired through `setLiveTextStyle` + serialization.
> - **Remaining slack note:** any leftover vertical space around short text is the **`padding`** (default 16px, for effect bleed) — expose it as a slider (it's already settable) or set `padding: 0` for tight text.
> - **Scaling handles now work on LiveText.** The shared scaling handler assumed a base size of 1 (unit-quad); fixed to divide by the real base. *Superseded by the frame-resize bullet at the top: LiveText handles now resize the frame (text reflows at the same font), not a uniform box+text zoom.*
> - **No more create flash** — a new node is pre-sized to its frame on creation (`applyInitialSize`), so the selection box no longer flashes at the default unit size before the first capture.
> - **Draw mode is now non-destructive to existing boxes.** The green draw-box only fires on **empty space**; existing LiveText boxes stay normally **selectable/movable/resizable**, **double-click still edits**, and Salsa draws a **green border around every box + a hover fill** so they're easy to find (empty/transient boxes are skipped so they don't flash on despawn). Focus after a draw is hardened (re-grabs until it holds). — If a just-drawn box still doesn't enter edit mode, confirm your `rectDrawCallback` calls `enterLiveTextEditingAt`.
>
> **What changed (June 16 — TRUE inline HTML-in-Canvas editing):**
> - On the **`webgpu-native`** path, the editable element is now the **real input surface** — no more blind hidden `<textarea>`. You type **directly into the text you see**, with a **live caret captured through the effect chain**.
> - New entry point **`enterLiveTextEditingAt(nodeId, clientX, clientY)`** — places the caret **where the user clicked** (the "caret-on-entry handshake"). Use it for click-driven editing; keep `beginLiveTextEditing(nodeId)` for the new-node path (no click coords).
> - **The text box now auto-grows as you type** (the old "squeezed into a fixed box" bug is fixed on this path).
> - The capture is sized per-axis to the canvas backing DPR, so it's **resize/DevTools-safe** (no more disappearing node).
> - **Input gating:** while `node.isEditing`, the element owns pointer events (it sits over the glyphs) — do **not** route that click into canvas picking/drag.
> - The `webgl-bridge` / `none` fallback is **unchanged** (blind textarea + OffscreenCanvas) — non-Chrome-150 builds behave exactly as before.
> - ⚠ Requires Chrome 150 + `chrome://flags/#canvas-draw-element`; it's an **origin-trial API**, auto-detected via `isHtmlInCanvasAvailable()`.
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

### Architecture: How Text Input Works (June 2026)

There are **two architectures**, chosen by capability:

**A. `webgpu-native` (Chrome 150 + flag) — TRUE inline editing.** The `contenteditable` element lives in the `<canvas layoutsubtree>` full-time (invisible), is captured into a GPU texture **inside `onpaint`** each frame, and **is itself the input + caret surface** — you type into the text you see. No hidden textarea. The element is `pointer-events:none` while idle (clicks reach canvas picking) and flips to `auto` on entry; its CSS transform is synced over the rendered quad each frame so clicks/caret land on the glyphs.

**B. `webgl-bridge` / `none` — fallback (the diagram below).** The blind hidden `<textarea>` is the keyboard path and the text is rasterized via OffscreenCanvas. This is the pre-June behavior, unchanged.

The fallback path (**two capture paths, one keyboard input path**):

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

**Key points (fallback path):**
- The hidden `<textarea>` handles ALL keyboard input (IME, Ctrl+Z, selection, etc.)
- The DOM `<div>` inside the canvas is only for visual capture (richer CSS rendering)
- The overlay textarea's blur does NOT end editing — it refocuses after clicking sidebar controls

**Key points (native inline path):**
- The `contenteditable` element **is** the input — IME, selection, Ctrl+Z all work natively on it; the live caret is captured through effects.
- Enter via **`enterLiveTextEditingAt(id, clientX, clientY)`** for caret-at-click; the element is `pointer-events:auto` while `isEditing` — **let it own clicks** (don't also start a canvas drag).
- The box **auto-grows** with the text (no fixed-size squeeze).

**Both paths:**
- The `<canvas>` gets the `layoutsubtree` attribute automatically when the first LiveTextNode is created.
- `isInputActive()` returns `true` during editing, suppressing hotkeys.

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

    // Enter edit mode. For a brand-NEW node there's no click position inside the
    // (empty) text, so beginLiveTextEditing() is correct here. Salsa handles:
    //  - isInputActive() returns true → hotkeys are suppressed
    //  - beginInteractive() → continuous rAF loop for live preview
    //  - native path: the element itself receives input (live caret); fallback: textarea
    shapeManager.beginLiveTextEditing(node.id);
    isLiveTextEditing = true;

  } else {
    // ── SDFText fallback ──
    // The SdfTextDrawingService handles this automatically
    // when its tool is enabled. No extra code needed.
  }
}
```

### Entering an EXISTING node by click — caret-on-entry handshake

When the user double-clicks an existing LiveTextNode to edit it, use **`enterLiveTextEditingAt`** with the click's viewport coords so the caret lands where they clicked. (Salsa swallows the double-click for hit-testing, so the element never sees it — replaying the coords is what puts the caret under the cursor instead of at the start/end.)

```ts
function onCanvasDoubleClick(e: PointerEvent, hit: { nodeId: string }) {
  const node = shapeManager.getLiveTextNode(hit.nodeId);
  if (!node) return;
  // clientX/clientY are VIEWPORT coords (not world) — Salsa maps them to the caret.
  shapeManager.enterLiveTextEditingAt(hit.nodeId, e.clientX, e.clientY);
  activeNodeId = hit.nodeId;
  isLiveTextEditing = true;
}
```

> **Input gating while editing:** once editing starts, the element is `pointer-events:auto`
> and sits directly over the glyphs, so it receives clicks/drags for caret + selection.
> **Do not** also route that `pointerdown` into your canvas pick/drag logic — guard it with
> `if (shapeManager.isInputActive()) return;` (or check `node.isEditing`). On the fallback
> path this matters less (textarea is off-screen), but gating on both is simplest.
>
> On builds without the native API, `enterLiveTextEditingAt` transparently falls back to
> plain begin-editing (textarea), so it's always safe to call.

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

## Creating LiveText by click-drag (variable size)

**Goal:** instead of click → fixed-size box, let the user **drag a rectangle** (showing the marching-ants outline reused from the selection tools) and get a text box whose **starting font size scales with the box they drew** — small box → small text, big box → big headline.

**Salsa owns the drag** via `setRectDrawCallback` — and this is what stops the **box-select tool from competing** (the symptom: a purple select box appearing during the drag). While the callback is set, a canvas drag **draws the box** (reusing the box-select marching-ants preview, no node selection), and on release calls back with the **world rect + the release client coords**. **Do not add your own canvas pointer handlers for this** — Salsa handles the whole drag.

```ts
// When the Text tool ACTIVATES — hand Salsa the create callback:
shapeManager.setRectDrawCallback((rect, clientX, clientY) => {
  const DRAG_MIN = 0.02; // world units — below this = a click, not a drag (tune to taste)
  const node = (rect.w < DRAG_MIN && rect.h < DRAG_MIN)
    // Click → default-size node at the click point (rect center)
    ? shapeManager.createLiveText(rect.x + rect.w / 2, rect.y + rect.h / 2, { text: '', fontSize: currentFontSize /*…*/ })
    // Drag → fixed text FRAME at the drawn size (text wraps inside, current font)
    : shapeManager.createLiveTextInRect(rect, { text: '' /* font, color, effects… */ });
  shapeManager.enterLiveTextEditingAt(node.id, clientX, clientY);
});

// When the Text tool DEACTIVATES (or you switch tools): clear it.
shapeManager.setRectDrawCallback(null);
```

**Draw-mode behavior (Salsa handles all of this):** while `rectDrawCallback` is set, Salsa only draws a box when you press on **empty space** — existing LiveText boxes behave like **normal selectable objects**: single-click **selects** (your selection-changed handler populates the sidebar), drag the handles to **move/resize**, and **double-click edits** (your existing `enterLiveTextEditingAt` dblclick wiring still fires). So nothing new to wire beyond `setRectDrawCallback` — and you can't accidentally edit while drawing, since editing is double-click only. Salsa also renders a **faint green outline on every LiveText box + a brighter hover highlight** so empty/transparent frames are easy to find. The drag box is green (vs purple box-select).

> A near-zero drag (a click) on empty space routes to the default-size path above; empty boxes still auto-clean on exit.

## Proposed panel improvements

Salsa-side options that would round out the tool (most are small additions to `LiveTextOptions` + `applyDomStyles`; flagged where they need Salsa work):

| Improvement | Notes |
|---|---|
| **Text background color / box fill** | ✅ **Built** — `backgroundColor?: RGBA \| null` → wire a color picker (`null`/transparent = off). |
| **Text alignment** (left/center/right) | ✅ **Built** — `align?: 'left'\|'center'\|'right'` → wire a 3-button toggle. |
| **Padding control** | Expose the existing `padding` in the sidebar — it's the main source of the "extra space" around short text (default 16px for effect bleed; `0` = tight). *(Already in `LiveTextOptions`; just needs a slider.)* |
| **Crispness slider** | Surface `_captureScale` (1–3) for users who want razor-sharp huge text vs. lighter memory. *(Salsa: expose a setter.)* |
| **Empty-state affordance** | A faint placeholder ("Type…") while empty + before first keystroke, so an empty box reads as intentional. *(Frogmarks overlay, or a Salsa placeholder option.)* |

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
| **Static** | `outline`, `glow`, `feather` | Apply once, look the same every frame | On-demand (single frame) |
| **Animated** | `wave`, `glitch`, `custom`, `chromatic-aberration` | Use `u.time` and/or `u.cursor` — change every frame | Continuous rAF loop |

> **`outline` upgrades (June 2026):** besides `thickness` + `color`, the outline now takes `offset:
> [dx,dy]` (drop-shadow-style directional shift, texels) and `gap` (transparent space between the
> glyph and the outline band, texels). Combined with the existing **effect stacking**, this is the
> whole layered manga-SFX / sticker recipe — stack several outlines with different color/gap/offset.
> **`feather` (new):** directional/radial alpha **fade-out** — `mode: 'linear' | 'radial'`, `angle`
> (degrees, linear), `start`/`end` (0–1 of the texture). Makes an element dissolve at an edge.

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
| | `offset` | [dx,dy] | −32 – 32 each | [0,0] | 1 |
| | `gap` | int | 0 – 32 | 0 | 1 |
| **Feather** | `mode` | enum | `'linear'` / `'radial'` | `'linear'` | — |
| | `angle` | float | 0 – 360 (linear) | 90 | 1 |
| | `start` | float | 0 – 1 | 0.6 | 0.05 |
| | `end` | float | 0 – 1 | 1.0 | 0.05 |

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
  padding?: number;                           // default: 16 (effect bleed; set 0 for tight)
  backgroundColor?: RGBA | null;              // default: null (no fill behind text)
  align?: 'left' | 'center' | 'right';        // default: 'left'
  frameWidth?: number;                        // CSS px. >0 = FIXED frame: box is exactly this
  frameHeight?: number;                       //   size, text reflows/clips inside (overflow
                                              //   hidden); 0 = auto-fit to content (default).
                                              //   Resize handles set these (resizeFrameWorld).
  userScaleX?: number;                        // legacy uniform scale, baked into size; ~always 1
  userScaleY?: number;                        //   now that resize writes frameWidth/Height
  arcAngle?: number;                          // arc the text, degrees. 0 = flat (default);
                                              //   +ve = arch up (∩, rainbow), −ve = arch down (∪).
                                              //   Render-only warp; set via setLiveTextStyle({arcAngle}).
  effects?: TextEffectConfig[];               // default: []
}
```

> **Arc text (June 2026):** `setLiveTextStyle(id, { arcAngle: 60 })` bends the text along a circular
> arc (the curved-banner look). It's a render-only quad warp — the text is still captured/edited
> FLAT, so outline/glow/feather curve with it for free. UI: a single **Arc** slider (−180…180°, 0 =
> flat). Caveat: editing an arced box places the caret on the flat layout — set arc to 0 to edit,
> then re-apply (or type first, then arc).

### `TextEffectConfig`

```ts
interface TextEffectConfig {
  type: 'chromatic-aberration' | 'glow' | 'wave' | 'glitch' | 'outline' | 'feather' | 'custom';
  params: TextEffectParams;
}

// OutlineParams: { thickness, color:[r,g,b,a], offset?:[dx,dy], gap? }
// FeatherParams: { mode:'linear'|'radial', angle?, start, end }
// Create defaults via the re-exported factories: defaultOutline(), defaultFeather(), defaultGlow(), …
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
| **createLiveText** | `(x, y, options?) → LiveTextNode` | Creates node (centered at x,y), wires engine, adds to scene, sets `layoutsubtree` |
| **createLiveTextInRect** | `(rect:{x,y,w,h}, options?) → LiveTextNode` | Create a **fixed text frame** at the drawn WORLD rect (sets `frameWidth/frameHeight`): keeps the drawn size, text wraps inside at `options.fontSize`. `w/h` may be negative; node fills the rect. |
| **setRectDrawCallback** | `(cb \| null) → void` | While set, a canvas **drag draws a box** (reuses box-select preview, **no node selection**) → on release calls `cb(rect, clientX, clientY)`. Set on text-tool activate, clear (`null`) on deactivate. Stops the box-select tool competing with the text-box drag. |
| **setLiveTextEffects** | `(nodeId, effects[]) → void` | Replace entire effect chain. Auto-manages `beginInteractive`/`endInteractive` |
| **setLiveTextContent** | `(nodeId, text) → void` | Update text string |
| **setLiveTextStyle** | `(nodeId, Partial<LiveTextOptions>) → void` | Update any style prop |
| **beginLiveTextEditing** | `(nodeId) → void` | Enter edit mode (no caret position). Native path: focuses the inline element; fallback: creates hidden textarea. Wires `onChange → scheduleRender`, enters interactive mode, sets `_isLiveTextEditing`. Use for the **new-node** path. |
| **enterLiveTextEditingAt** | `(nodeId, clientX, clientY) → void` | Like `beginLiveTextEditing` but **places the caret at the click** (viewport coords) — the caret-on-entry handshake. Use when entering an **existing** node by click/double-click. Falls back to plain begin-editing without the native API. |
| **endLiveTextEditing** | `(nodeId) → void` | Exit edit mode. Native path: blur + clear selection, element stays for display. Fallback: removes textarea. Clears `onChange`, exits interactive mode, clears `_isLiveTextEditing`. |
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

### Phase 1.5 (Done — June 16 2026) — TRUE inline HTML-in-Canvas editing
- [x] `webgpu-native` path: `contenteditable` element is the live input surface (no blind textarea); caret captured through effects
- [x] `enterLiveTextEditingAt(id, clientX, clientY)` — caret-on-entry handshake (`caretPositionFromPoint`)
- [x] `onpaint`-driven capture + `requestPaint` loop; per-frame overlay transform sync (hit region == glyphs)
- [x] Per-axis backing-DPR texture sizing (resize/DevTools-safe; fixes the disappearing-node crash)
- [x] Text box auto-grows with content (fixes the fixed-size squeeze)
- [x] OffscreenCanvas + textarea preserved as fallback (gated on `isHtmlInCanvasAvailable()`)
- [x] **Frame-resize model (June 17):** scaling handles resize the **text frame** (`resizeFrameWorld` → `frameWidth/frameHeight`), so the box and the font size are independent (text reflows/clips, never zooms). `width/height` update every drag tick (no `scaleX`) → live selection-box tracking, no bake-on-release. *(Supersedes the earlier "size model" pass that scaled glyphs with the box; the `_userScaleX/Y` plumbing remains for legacy docs and is ~always 1.)*
- [x] **`createLiveTextInRect`, `backgroundColor`, `align`** (June 17) — box-drag sizing + filled background + text alignment.

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
