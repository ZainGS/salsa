# Frogmarks UI Spec — Speech Balloon Controls

> **For**: Frogmarks front-end team  
> **Salsa version**: Current (`npm run build` passing)  
> **Date**: April 2026

Everything below is already wired in Salsa's engine. Frogmarks just needs UI to expose it.

---

## Quick Summary

The speech balloon system is now fully functional in Salsa. The body is a **Polygon** (not a Rectangle) with 5 style variants, and the tail is a separate **Polygon child** that renders automatically through the standard pipeline. No overlay rendering needed.

| What Changed | Before | After |
|---|---|---|
| Body shape | Plain sharp-cornered Rectangle | Style-specific Polygon (rounded-rect, ellipse, cloud, burst, thought) |
| Tail | Data only — never rendered | Polygon child — renders automatically |
| Style switching | Stored but ignored | Regenerates body outline + tail shape |
| Click selection | Selected child Rectangle, not balloon | Selects parent SpeechBalloon |
| Ungroup protection | U key destroyed balloon internals | Protected |
| Keyboard shortcuts | G/U fired during text editing | Suppressed when balloon is selected |

---

## 1. Creating a Speech Balloon

### API

```ts
const balloon = shapeManager.createSpeechBalloon(worldX, worldY, {
  text: 'Hello!',
  style: 'rounded-rect',       // 'rounded-rect' | 'ellipse' | 'cloud' | 'burst' | 'thought'
  font: 'Arial',
  fontSize: 90,
  writingMode: 'horizontal-tb', // or 'vertical-rl' for manga
  fillColor: { r: 1, g: 1, b: 1, a: 1 },
  strokeColor: { r: 0, g: 0, b: 0, a: 1 },
  strokeWidth: 2,
  tailSide: 'bottom',          // 'top' | 'right' | 'bottom' | 'left'
  tailPosition: 0.3,           // 0–1 along edge
  tailLength: 0.15,            // world units
  tailWidth: 0.08,             // world units
  showTail: true,
});
```

All options are optional — sensible defaults are applied. The balloon is automatically added to the scene and selected.

### Tool Activation Flow

```
User clicks speech balloon icon in sidebar
  → Frogmarks sets activeTool = 'speech-balloon'
  → Show speech balloon property panel
  → Set canvas cursor to crosshair

User clicks on canvas
  → Call shapeManager.createSpeechBalloon(worldX, worldY, panelOptions)
  → Store balloon.id as activeBalloonId
  → Optionally: immediately enter text editing mode

User clicks existing balloon
  → Normal selection handles this (Salsa auto-selects the parent SpeechBalloon)
  → Populate sidebar with current balloon properties (see §6)

User changes property in sidebar
  → Call the appropriate setter method
  → Salsa re-renders automatically
```

---

## 2. Balloon Style

### API

```ts
shapeManager.getSpeechBalloon(nodeId)?.setBalloonStyle('cloud');
```

Or via ShapeManager convenience method:

```ts
shapeManager.setSpeechBalloonStyle(nodeId, 'cloud');
```

### Available Styles

| Style | Value | Description |
|---|---|---|
| **Rounded Rectangle** | `'rounded-rect'` | Classic comic balloon with rounded corners (default) |
| **Ellipse** | `'ellipse'` | Smooth oval — clean manga style |
| **Cloud** | `'cloud'` | Scalloped bumpy edge — dreamy/fluffy |
| **Burst** | `'burst'` | Spiky starburst — shouting/impact |
| **Thought** | `'thought'` | Soft bumpy ellipse with circle-dot tail instead of triangle |

### UI Control

| Control | Type | Options | Default | Tooltip |
|---|---|---|---|---|
| **Style** | Segmented toggle or dropdown | Rounded / Ellipse / Cloud / Burst / Thought | Rounded | `"The shape of the balloon outline."` |

### Behavior Notes
- Changing style **immediately** regenerates the body polygon and tail.
- The `'thought'` style uses trailing circle dots for the tail instead of a triangle — this happens automatically.
- The balloon auto-resizes to fit text after style change.

---

## 3. Tail Controls

### API

```ts
const balloon = shapeManager.getSpeechBalloon(nodeId);

// Individual setters (each rebuilds the tail polygon immediately)
balloon?.setTailSide('bottom');       // 'top' | 'right' | 'bottom' | 'left'
balloon?.setTailPosition(0.3);        // 0–1 along the chosen edge
balloon?.setTailLength(0.15);         // world units
balloon?.setShowTail(true);           // show/hide

// Or aim the tail at a world position (auto-computes side, position, length)
balloon?.setTailTipWorld(worldX, worldY);

// Read current tail tip position
const tip = balloon?.getTailTipWorld(); // { x, y }
```

Or via ShapeManager convenience methods:

```ts
shapeManager.setSpeechBalloonTail(nodeId, 'bottom', 0.3, 0.15);
shapeManager.setSpeechBalloonTailTarget(nodeId, worldX, worldY);
```

### UI Controls

| Control | Type | Range | Default | Tooltip |
|---|---|---|---|---|
| **Show Tail** | Toggle | on/off | on | `"Show or hide the balloon tail pointer."` |
| **Tail Side** | Segmented toggle | Top / Right / Bottom / Left | Bottom | `"Which edge of the balloon the tail extends from."` |
| **Position** | Slider | 0 – 1 | 0.30 | `"Where along the edge the tail attaches. 0 = start, 1 = end."` |
| **Length** | Slider | 0.05 – 0.5 | 0.15 | `"How far the tail extends from the balloon body."` |

### Drag-to-Aim (Recommended UX)

Instead of manual Side/Position/Length sliders, consider a **drag handle** on the tail tip:

1. Show a small circle at `balloon.getTailTipWorld()`
2. On drag, call `balloon.setTailTipWorld(dragX, dragY)` each frame
3. The balloon auto-computes the best side, position, and length

This is the most intuitive UX — the user just drags the tail to point where they want.

### Behavior Notes
- When `showTail` is false, the tail polygon is hidden. No geometry change needed.
- For `'thought'` style, the "tail" is 3 decreasing circle dots. Same API, different visual.

---

## 4. Text Content

### API

```ts
const balloon = shapeManager.getSpeechBalloon(nodeId);

balloon?.setText('New text');
balloon?.setFont('Comic Sans MS');
balloon?.setFontSize(72);
balloon?.setLineHeight(1.3);
balloon?.setWritingMode('vertical-rl'); // manga vertical text
balloon?.setTextColor({ r: 0, g: 0, b: 0, a: 1 });
balloon?.setMaxWidth(2.0); // world units — text wraps beyond this

const text = balloon?.getText();
```

Or via ShapeManager:

```ts
shapeManager.setSpeechBalloonText(nodeId, 'New text');
shapeManager.setSpeechBalloonWritingMode(nodeId, 'vertical-rl');
```

### UI Controls

| Control | Type | Range | Default | Tooltip |
|---|---|---|---|---|
| **Text** | Text input / textarea | — | `''` | `"The dialog text inside the balloon."` |
| **Font** | Dropdown | System fonts | Arial | `"Font family for the balloon text."` |
| **Size** | Number input | 12 – 200 | 90 | `"Font size in atlas units."` |
| **Writing Mode** | Segmented: H / V | horizontal-tb / vertical-rl | H | `"Horizontal (standard) or Vertical (manga-style)."` |
| **Max Width** | Slider | 0.5 – 3.0 | 1.5 | `"Maximum balloon width before text wraps."` |

### Text Editing on Double-Click

1. On double-click of a selected SpeechBalloon, enter edit mode
2. Show a text input overlay positioned over the balloon
3. On each keystroke, call `balloon.setText(inputValue)` — balloon auto-resizes
4. On blur or Escape, exit edit mode

**With LiveText** (see §7): double-click → `balloon.getLiveTextNode().focus()` → native browser editing.

---

## 5. Colors

### API

```ts
const balloon = shapeManager.getSpeechBalloon(nodeId);

balloon?.setFillColor({ r: 1, g: 1, b: 0.8, a: 1 });     // body + tail fill
balloon?.setStrokeColor({ r: 0.2, g: 0.2, b: 0.2, a: 1 }); // body + tail stroke
balloon?.setTextColor({ r: 0, g: 0, b: 0, a: 1 });
```

### UI Controls

| Control | Type | Default | Tooltip |
|---|---|---|---|
| **Fill** | Color picker | White | `"Balloon background color. Applied to both body and tail."` |
| **Stroke** | Color picker | Black | `"Balloon outline color. Applied to both body and tail."` |
| **Stroke Width** | Slider (1–5) | 2 | `"Thickness of the balloon outline."` |
| **Text** | Color picker | Black | `"Text color inside the balloon."` |

### Behavior Notes
- `setFillColor` and `setStrokeColor` update **both** the body polygon and tail polygon automatically. The tail always matches.

---

## 6. Reading Balloon State (for Sidebar Sync)

When a SpeechBalloon is selected, populate the sidebar:

```ts
const balloon = shapeManager.getSpeechBalloon(selectedNodeId);
if (!balloon) return;

// All properties are directly readable
const style     = balloon.balloonStyle;        // 'rounded-rect' | 'ellipse' | etc.
const text      = balloon.getText();
const fill      = balloon.balloonFillColor;     // RGBA { r, g, b, a }
const stroke    = balloon.balloonStrokeColor;
const strokeW   = balloon.balloonStrokeWidth;
const side      = balloon.tailSide;             // 'top' | 'right' | 'bottom' | 'left'
const pos       = balloon.tailPosition;         // 0–1
const len       = balloon.tailLength;
const show      = balloon.showTail;
const mode      = balloon.writingMode;
const font      = balloon.textNode.font;
const fontSize  = balloon.textNode.fontSize;
const textColor = balloon.textNode.fillColor;
```

---

## 7. LiveText Integration (Recommended)

For rich text editing with browser-native IME, cursor, and selection support, attach a `LiveTextNode`:

```ts
const balloon = shapeManager.createSpeechBalloon(x, y, options);

const liveText = shapeFactory.createLiveText(x, y, {
  text: options.text ?? '',
  font: options.font ?? 'Arial',
  fontSize: options.fontSize ?? 90,
  color: options.textColor,
  writingMode: options.writingMode,
});

const engine = shapeManager.getTextEffectEngine();
if (engine) liveText.setEngine(engine);

// Compute worldUnitsPerPixel
const illBounds = renderer.getIllustrationBounds();
const pixelSize = renderer.getIllustrationPixelSize();
if (illBounds && pixelSize) {
  liveText.worldUnitsPerPixel = illBounds.width / pixelSize.w;
}

// Attach — SDFText is auto-hidden, LiveTextNode takes over rendering
balloon.setLiveTextNode(liveText);
```

| Without LiveText | With LiveText |
|---|---|
| Manual text input overlay | Browser-native contenteditable |
| No IME support | Full IME (CJK, emoji, etc.) |
| No cursor/selection | Native cursor + selection |
| SDFText rendering | HTML-in-Canvas with shader effects |

---

## 8. Preset Styles

Frogmarks can offer quick-apply presets using the existing buttons:

| Preset | Style | Tail | Stroke W | Font | Tooltip |
|---|---|---|---|---|---|
| **Clean** | `rounded-rect` | show, bottom, 0.3 | 2 | Arial | `"Standard clean speech balloon."` |
| **Shout** | `burst` | show, bottom, 0.5 | 3 | Impact | `"Spiky impact balloon for shouting."` |
| **Whisper** | `ellipse` | show, bottom, 0.3 | 1 | Arial | `"Soft elliptical balloon for quiet speech."` |
| **Thought** | `thought` | show, bottom, 0.3 | 2 | Arial | `"Thought bubble with trailing dots."` |
| **Scream** | `burst` | show, bottom, 0.5 | 4 | Impact | `"Heavy impact balloon for screams."` |
| **Narration** | `rounded-rect` | **hidden** | 1 | Georgia | `"Narrator box — no tail, thin border."` |

```ts
function applyPreset(balloon: SpeechBalloon, preset: string) {
  switch (preset) {
    case 'Clean':
      balloon.setBalloonStyle('rounded-rect');
      balloon.setShowTail(true);
      balloon.setFont('Arial');
      balloon.balloonStrokeWidth = 2;
      break;
    case 'Shout':
      balloon.setBalloonStyle('burst');
      balloon.setShowTail(true);
      balloon.setFont('Impact');
      balloon.balloonStrokeWidth = 3;
      break;
    case 'Thought':
      balloon.setBalloonStyle('thought');
      balloon.setShowTail(true);
      balloon.setFont('Arial');
      balloon.balloonStrokeWidth = 2;
      break;
    case 'Narration':
      balloon.setBalloonStyle('rounded-rect');
      balloon.setShowTail(false);
      balloon.setFont('Georgia');
      balloon.balloonStrokeWidth = 1;
      break;
    // ...
  }
}
```

---

## 9. Tooltip Reference

| Control | Tooltip |
|---|---|
| Style | `"The shape of the balloon outline."` |
| Style: Rounded | `"Classic comic balloon with rounded corners."` |
| Style: Ellipse | `"Smooth oval balloon — clean manga style."` |
| Style: Cloud | `"Scalloped bumpy edge — dreamy or fluffy."` |
| Style: Burst | `"Spiky starburst — shouting or impact."` |
| Style: Thought | `"Soft bumpy ellipse with trailing dot tail."` |
| Show Tail | `"Show or hide the balloon tail pointer."` |
| Tail Side | `"Which edge of the balloon the tail extends from."` |
| Tail Position | `"Where along the edge the tail attaches. 0 = start, 1 = end."` |
| Tail Length | `"How far the tail extends from the balloon body."` |
| Fill Color | `"Balloon background color. Applied to both body and tail."` |
| Stroke Color | `"Balloon outline color. Applied to both body and tail."` |
| Stroke Width | `"Thickness of the balloon outline."` |
| Text Color | `"Text color inside the balloon."` |
| Font | `"Font family for the balloon text."` |
| Font Size | `"Font size in atlas units."` |
| Writing Mode: H | `"Standard horizontal text — left to right, top to bottom."` |
| Writing Mode: V | `"Manga-style vertical text — top to bottom, right to left columns."` |
| Max Width | `"Maximum balloon width before text wraps."` |

---

## 10. Types Exported from Salsa

```ts
import type {
  SpeechBalloon,
  SpeechBalloonOptions,
  BalloonStyle,
  TailSide,
} from '@zaings/salsa/shape-manager';
```

---

## 11. Property Panel Layout (Suggested)

```
┌─────────────────────────────────┐
│ Style: [Rounded|Ellipse|Cloud|Burst|Thought] │
├─────────────────────────────────┤
│ Presets: [Clean] [Shout] [Whisper]            │
│          [Thought] [Scream] [Narration]       │
├─────────────────────────────────┤
│ Writing:  [H] [V]                             │
│ Font:     [Arial        ▾]                    │
│ Size:     [90] px                             │
│ Max W:    ──●──────── 1.5                     │
├─────────────────────────────────┤
│ Text:     ■ #000000                           │
│ Fill:     ■ #FFFFFF                           │
│ Stroke:   ■ #000000                           │
│ Stroke W: ──●──────── 2px                     │
├─────────────────────────────────┤
│ ▸ Tail                                        │
│   Show tail: [✓]                              │
│   Side: [T] [—] [B] [—]                      │
│   Position: ──●──── 0.30                      │
│   Length:   ──●──── 0.15                      │
├─────────────────────────────────┤
│ Text: [KABOOM!                ]               │
└─────────────────────────────────┘
```

Tail section should be collapsible. When `Show tail` is off, collapse sub-controls.
