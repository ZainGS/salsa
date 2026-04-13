# Frogmarks: Text & Speech Bubble Tool — Architecture & UI Spec

## Architecture Overview

### The Problem Right Now

| Tool | What Happens | What's Broken |
|---|---|---|
| **Text tool** | Creates a `Text` shape (Canvas 2D rasterized) | Works, but no editing, no IME, no effects |
| **Speech Bubble tool** | Creates `SpeechBalloon` (Rectangle + SDFText) | Shows a square; can't edit text; Frogmarks didn't wire up the interaction |

### The New Architecture

**HTML-in-Canvas** is the default text rendering path. SDFText remains in the codebase as a fallback for browsers without the API.

```
Text Rendering Stack (priority order):

  1. HTML-in-Canvas (preferred)
     └─ Live DOM element as child of <canvas layoutsubtree>
     └─ Browser handles: fonts, IME, CJK, emoji, cursor, selection, wrapping
     └─ Captured as GPU texture each frame → shader effects applied
     └─ Requires: Chrome Canary + flag (today), Chrome stable (future)

  2. SDFText (fallback)
     └─ GPU SDF atlas rendering
     └─ Salsa handles: caret, selection, text insertion, wrapping
     └─ No shader effects (rendered as instanced quads, not a texture)
     └─ Works everywhere today

Detection:
  if (shapeManager.isHtmlInCanvasAvailable()) → use path 1
  else → use path 2
```

### Node Hierarchy After This Change

```
Scene Graph Node Types for Text:

  LiveTextNode (NEW — HTML-in-Canvas)
  ├── Owns a hidden <div> child of the canvas
  ├── Gets captured + effected + composited each frame
  ├── Editable: double-click → focus div → browser text editing
  ├── Supports: effects, animation, cursor-reactive shaders
  └── Used by: Text tool, Speech Bubble tool (as text child)

  SDFText (existing — fallback)
  ├── GPU SDF atlas + instanced quads
  ├── Editable: caret + keyboard handling in Salsa
  └── Used by: Text tool fallback, Speech Bubble fallback

  SpeechBalloon (existing Group — updated)
  ├── Rectangle (background with rounded corners)
  ├── LiveTextNode OR SDFText (text child — based on detection)
  └── Tail (configurable triangle pointer)

  Text (existing — Canvas 2D, legacy)
  └── Keep for backward compat, not used by either tool going forward
```

---

## Tool 1: Text Tool

### What It Does

User clicks canvas → a text node appears at that position → user types → text renders live with optional effects.

### Canvas Interaction

```
Click on canvas (Text tool active)
  ├── if (isHtmlInCanvasAvailable)
  │     Create LiveTextNode at world position
  │     Focus the hidden DOM element → browser cursor blinks
  │     User types → text updates live each frame
  │     Effects apply in real-time
  │
  └── else (fallback)
        Create SDFText at world position (existing behavior)
        beginTyping() → caret visible
        Keyboard events → insertAtCaret()

Click on existing text node
  └── Enter edit mode (re-focus the element)

Click elsewhere / press Escape
  └── Commit text, deselect, stop editing

Double-click on existing text node
  └── Enter edit mode + select all text
```

### Text Tool Sidebar

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
│  ── Effects ──              │
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
│  ── Presets ──              │
│  [Impact] [Energy] [Ghost]  │
│  [Glitch] [Horror] [Clean]  │
│                             │
│  [Flatten to Layer]         │
│                             │
└─────────────────────────────┘
```

### Implementation Notes

- **Font dropdown**: Use `document.fonts` or a curated list. HTML-in-Canvas supports any installed/loaded font.
- **Writing mode**: `horizontal-tb` or `vertical-rl`. Applied via CSS on the DOM element.
- **"Flatten to Layer"**: Calls `stampEffectedText()` to bake the current text + effects onto the active raster layer. Removes the live text node. This is a one-way operation.
- **Effects section**: Same effect chain UI as described in `frogmarks-text-effects-spec.md`.

---

## Tool 2: Speech Bubble Tool

### What It Does

User clicks canvas → a speech balloon appears (rounded rect + text + optional tail) → user immediately types → balloon auto-sizes to fit text.

### Canvas Interaction

```
Click on canvas (Speech Bubble tool active)
  └── shapeManager.createSpeechBalloon(worldX, worldY, {
        text: '',
        style: currentStyle,        // from Style dropdown
        writingMode: currentMode,    // from H/V toggle
        tailSide: currentTailSide,   // from tail buttons
        tailPosition: currentTailPos,
        showTail: currentShowTail,
        font: currentFont,
        fontSize: currentFontSize,
        textColor: parseColor(textColor),
        fillColor: parseColor(fillColor),
        strokeColor: parseColor(strokeColor),
        strokeWidth: currentStrokeWidth,
      })

  The balloon appears. Focus goes to the text child.
  User types → text updates → balloon auto-sizes.

Click on existing speech balloon
  └── Select it (transform handles appear)
      Sidebar populates with current properties.

Double-click on existing speech balloon
  └── Enter text edit mode (focus the text child)

Drag a selected speech balloon
  └── Move it (standard transform behavior)

Press Escape while editing
  └── Exit text edit mode, keep selection
```

### Speech Bubble Sidebar

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
│  ── Text Effects ──              │
│  + Add Effect                    │
│  (same effect chain UI as Text)  │
│                                  │
│  ── Presets ──                   │
│  [Clean] [Shout] [Whisper]       │
│  [Thought] [Scream] [Narration] │
│                                  │
└──────────────────────────────────┘
```

### Balloon Style Visual Reference

```
Rounded-rect (default):          Ellipse:
┌─────────────────────┐          ╭─────────────────────╮
│                     │          │                     │
│   Text here         │          │   Text here         │
│                     │          │                     │
└──────────┐──────────┘          ╰──────────╲──────────╯
           │                                 ╲
           ▽                                  ▽

Cloud:                           Burst (shout):
  ╭──╮╭──╮╭──╮╭──╮                ╱╲   ╱╲   ╱╲
 ╭╯              ╰╮             ╱    ╲╱    ╲╱    ╲
 │   Text here    │            │                  │
 ╰╮              ╭╯            │   Text here      │
  ╰──╯╰──╯╰──╯╰─╯             │                  │
        ○                       ╲    ╱╲    ╱╲    ╱
       ○                          ╲╱   ╲╱   ╲╱
      ○

Thought:
  ╭──────────────────╮
  │   Text here      │
  ╰──────────────────╯
        ◯
       ◯
      ◯
```

### Preset Configurations

| Preset | Style | Tail | Text Effect | Notes |
|---|---|---|---|---|
| **Clean** | `rounded-rect` | bottom, 0.5 | outline(2, black) | Default manga speech |
| **Shout** | `burst` | bottom, 0.3 | outline(3, black) + chromatic(0.004) | Bold font, larger size |
| **Whisper** | `ellipse` | bottom, 0.5 | none | Smaller font, dashed stroke |
| **Thought** | `thought` | bottom-left, 0.3 | none | Connected circles as tail |
| **Scream** | `burst` | bottom, 0.5 | outline(4, black) + glow(4, 1.5) | Extra bold, large |
| **Narration** | `rounded-rect` | none | none | No tail, subtle fill |

---

## Property Panel ↔ Salsa API Wiring

### On Property Change → Call Salsa

```ts
// Store the active balloon/text node ID after selection
let activeNodeId: string | null = null;

// Listen for selection changes
shapeManager.onSelectionChanged((selected) => {
  if (selected.length === 1) {
    activeNodeId = selected[0].id;
    // Populate sidebar from node properties
    const balloon = shapeManager.getSpeechBalloon(activeNodeId);
    if (balloon) {
      populateBalloonSidebar(balloon);
    }
  } else {
    activeNodeId = null;
    hideSidebar();
  }
});

// --- Sidebar event handlers ---

// Style buttons
onStyleChange(style: BalloonStyle) {
  shapeManager.setSpeechBalloonStyle(activeNodeId, style);
}

// Writing mode toggle
onWritingModeChange(mode: 'horizontal-tb' | 'vertical-rl') {
  shapeManager.setSpeechBalloonWritingMode(activeNodeId, mode);
}

// Text input (for initial text or when not in HTML-in-Canvas edit mode)
onTextChange(text: string) {
  shapeManager.setSpeechBalloonText(activeNodeId, text);
}

// Tail controls
onTailSideChange(side: TailSide) {
  shapeManager.setSpeechBalloonTail(activeNodeId, side, currentTailPosition);
}
onTailPositionChange(pos: number) {
  shapeManager.setSpeechBalloonTail(activeNodeId, currentTailSide, pos);
}

// Colors
onFillColorChange(color: RGBA) {
  // Needs: shapeManager.setSpeechBalloonFillColor(nodeId, color)
  // Or update via the SpeechBalloon node directly
}
```

### Reading State Back (sidebar population)

```ts
function populateBalloonSidebar(balloon: SpeechBalloon) {
  styleDropdown.value    = balloon.getBalloonStyle();
  writingToggle.value    = balloon.getWritingMode();
  tailSideButtons.value  = balloon.getTailSide();
  tailPositionSlider.value = balloon.getTailPosition();
  showTailCheckbox.checked = balloon.getShowTail();
  fontDropdown.value     = balloon.getFont?.() ?? 'Arial';
  fontSizeInput.value    = balloon.getFontSize?.() ?? 48;
  // ... etc
}
```

---

## What Frogmarks Needs to Fix (Current Bugs)

### Speech Bubble Tool — Not Working

**Symptom:** Click canvas → square appears, can't edit text.

**Root cause (likely):** Frogmarks calls `createSpeechBalloon()` but:
1. Doesn't pass a `text` option (appears empty)
2. Doesn't enter edit mode after creation (no text cursor)
3. Doesn't forward keyboard events to the SDFText node
4. May not have the SDFText atlas loaded (renders as blank quads)

**Fix:**
```ts
// After creating the balloon:
const balloon = shapeManager.createSpeechBalloon(x, y, {
  text: '',           // Empty is fine — user will type
  font: 'Arial',
  fontSize: 48,
  style: 'rounded-rect',
  tailSide: 'bottom',
  tailPosition: 0.5,
  fillColor: { r: 1, g: 1, b: 1, a: 1 },
  strokeColor: { r: 0, g: 0, b: 0, a: 1 },
  strokeWidth: 2,
});

// CRITICAL: Enter edit mode on the text child
// This is what makes the cursor appear and keyboard events work
const textNode = balloon.getTextNode();  // SDFText child
if (textNode) {
  textNode.beginTyping();  // Shows caret, starts accepting input
}
```

### Text Tool — Basic but Working

The current Text tool uses `TextDrawingService` which creates Canvas 2D `Text` shapes. These work but have no editing, effects, or IME support. The migration to HTML-in-Canvas LiveTextNode will replace this.

---

## Migration Path

### Phase 1: Fix What's Broken (Now)
- Fix speech bubble creation in Frogmarks (pass options, enter edit mode)
- Wire up sidebar controls to existing Salsa API
- Everything uses SDFText — works in all browsers today

### Phase 2: HTML-in-Canvas LiveTextNode (When Salsa Implements It)
- Salsa builds `LiveTextNode` scene graph node
- Update `SpeechBalloon` to use `LiveTextNode` when API available
- Text tool creates `LiveTextNode` instead of `Text`/`SDFText`
- Effects become available on all text
- Frogmarks detects mode and shows/hides effects panel accordingly

### Phase 3: Polish
- Animated effects (wave, glitch with cursor reactivity)
- Text effect presets
- Flatten-to-layer workflow

### Detection in Frogmarks

```ts
// Show/hide effects panel based on capability
const hasEffects = shapeManager.isHtmlInCanvasAvailable();
effectsPanel.style.display = hasEffects ? 'block' : 'none';

// The text editing UX is the same either way — Frogmarks doesn't
// need to know which rendering path Salsa is using internally.
// Just call the same API: createSpeechBalloon(), setSpeechBalloonText(), etc.
```

---

## Summary: What Frogmarks Should Build

1. **Speech Bubble tool canvas handler** — Call `createSpeechBalloon()` on click with sidebar settings, enter edit mode
2. **Speech Bubble sidebar** — Style, text, colors, tail, effects sections (see wireframe above)
3. **Text tool canvas handler** — Create text node on click, enter edit mode
4. **Text sidebar** — Font, size, writing mode, colors, effects sections
5. **Selection sync** — When user selects a text/balloon node, populate sidebar from its current state
6. **Effect chain UI** — Add/remove/reorder effects, sliders for each param, preset buttons
7. **Progressive enhancement** — Show effects panel only when `isHtmlInCanvasAvailable()` returns true
