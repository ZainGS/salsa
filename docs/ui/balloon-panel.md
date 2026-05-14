# Frogmarks UI Spec — Speech Balloons & Panel Layout
**Last Updated:** 2026-04-27  

> **For**: Frogmarks front-end team
> **Salsa version**: Current (125 modules, build passing)
> **Date**: April 2026

---

## Quick Summary

| Feature | What it is | Why it matters |
|---------|-----------|----------------|
| [Speech Balloons](#1-speech-balloons) | Auto-sizing text balloons with tails, vertical text support | Core manga/comic tool — every page has dialog |
| [Panel Layout](#2-panel-layout) | Page grid with gutters, bleed guides, panel borders, templates | Turns "drawing app" into "manga studio" |

---

## 1. Speech Balloons

### What it does
Creates a speech balloon (speech bubble) — an auto-sizing body with text inside and a pointed tail. Supports both horizontal (Western) and vertical (manga/CJK) text layout.

The balloon body auto-sizes to fit the text content. The tail can be attached to any edge and pointed at any world-space position (typically a character's mouth).

### Toolbar UI

| Control | Type | Default | Tooltip |
|---------|------|---------|---------|
| **Speech Balloon tool** | Toolbar button | — | `"Add a speech balloon. Click to place, then type your dialog."` |
| **Balloon style** | Dropdown | `rounded-rect` | `"Visual style of the balloon shape."` |
| **Writing mode** | Toggle (H / V) | H | `"H: Horizontal text (left-to-right). V: Vertical text (top-to-bottom, manga style)."` |
| **Tail side** | 4-button group (↑→↓←) | ↓ | `"Which edge the tail points from."` |
| **Tail position** | Slider (0–1) | 0.3 | `"Position of the tail along the selected edge."` |
| **Show tail** | Toggle | On | `"Show or hide the balloon tail."` |
| **Font** | Dropdown | Arial | `"Font family for the balloon text."` |
| **Font size** | Number input | 90 | `"Text size inside the balloon."` |
| **Text color** | Color picker | Black | `"Color of the dialog text."` |
| **Fill color** | Color picker | White | `"Background color of the balloon."` |
| **Stroke color** | Color picker | Black | `"Border color of the balloon."` |
| **Max width** | Slider | 1.5 | `"Maximum width before text wraps to the next line/column."` |

### Balloon Style Options

| Style | Visual | Best for |
|-------|--------|----------|
| `rounded-rect` | Standard rounded rectangle | General dialog |
| `ellipse` | Oval/elliptical shape | Softer dialog, thought adjacent |
| `cloud` | Cloud-shaped outline | Thought bubbles |
| `burst` | Jagged/spiky border | Shouting, emphasis |
| `thought` | Cloud body + circle dots for tail | Internal thoughts |

### Tool Options Panel

```
┌─ Speech Balloon ──────────────────────────────┐
│ Style: [Rounded ▾]                            │
│ Writing: [H] [V]                              │
│ Tail: [↑] [→] [↓] [←]  Position: ■■■□ 0.30  │
│ ☑ Show tail                                   │
│ ──────────────────────────────────────────────│
│ Font: [Arial ▾]   Size: [90]                  │
│ Text: [■]  Fill: [□]  Stroke: [■]            │
│ Max width: ■■■■■■■■□□□  1.50                  │
└───────────────────────────────────────────────┘
```

### API

```ts
// Create a speech balloon
const balloon = shapeManager.createSpeechBalloon(0.5, 0.3, {
  text: 'なんだこれ？！',
  writingMode: 'vertical-rl',   // manga vertical text
  tailSide: 'bottom',
  tailPosition: 0.3,
  style: 'rounded-rect',
  fillColor: { r: 1, g: 1, b: 1, a: 1 },
  strokeColor: { r: 0, g: 0, b: 0, a: 1 },
  fontSize: 90,
  maxWidth: 1.5,
});

// The balloon returns its node id for subsequent operations:
const balloonId = balloon.getId();

// Update text
shapeManager.setSpeechBalloonText(balloonId, 'New dialog');

// Toggle vertical/horizontal text
shapeManager.setSpeechBalloonWritingMode(balloonId, 'vertical-rl');
shapeManager.setSpeechBalloonWritingMode(balloonId, 'horizontal-tb');

// Configure tail
shapeManager.setSpeechBalloonTail(balloonId, 'bottom', 0.3, 0.15);

// Point tail at a character (auto-computes side + position)
shapeManager.setSpeechBalloonTailTarget(balloonId, characterWorldX, characterWorldY);

// Change visual style
shapeManager.setSpeechBalloonStyle(balloonId, 'burst');

// Get tail triangle geometry for overlay rendering
const tailPoints = shapeManager.getSpeechBalloonTailPoints(balloonId);
// → [{ x, y }, { x, y }, { x, y }]  (base-left, tip, base-right)
```

### Keyboard Shortcuts

| Key | Action | Tooltip |
|-----|--------|---------|
| `T` | Activate speech balloon tool | `"Place a speech balloon."` |
| `Enter` | Confirm text edit | `"Finish editing this balloon."` |
| `Escape` | Cancel text edit | `"Cancel editing."` |
| `Tab` | Cycle tail side (↓→↑←) | `"Move the tail to the next side."` |

### UX Notes — Speech Balloons

- **Click to place, then type.** When the balloon tool is active, clicking on the canvas creates a balloon at that position and immediately enters text editing mode (caret blinking inside the balloon).
- **Auto-sizing:** As the user types, the balloon body grows to fit. The width is capped at `maxWidth`, then text wraps.
- **Vertical text:** In `vertical-rl` mode, characters are stacked top-to-bottom. When a column fills up, the next column starts to the **left** (right-to-left column order, standard for manga).
- **Tail dragging:** The tail tip should be draggable. When the user drags the tail tip, call `setSpeechBalloonTailTarget(id, worldX, worldY)` — the engine auto-computes the side and attachment point.
- **The tail is rendered as a triangle overlay.** The three vertices are returned by `getSpeechBalloonTailPoints()`. Frogmarks should draw these as a filled triangle matching the balloon's fill color, with a stroked border matching the balloon's stroke color.
- **Double-click to edit text.** Double-clicking an existing balloon enters text edit mode (same as SDF text editing — caret, selection, clipboard ops all work).
- **Selection shows handles.** When a balloon is selected (not editing), show the standard 8-handle transform box. The balloon can be moved, scaled, and rotated like any shape.

### Vertical Text Notes

Vertical text is now a property on `SDFText` itself (not just on balloons). Any SDF text node can be set to vertical mode:

```ts
// Direct SDFText vertical mode (for standalone text, not inside a balloon)
const textNode = /* existing SDFText node */;
textNode.writingMode = 'vertical-rl';
textNode.refreshText();
```

This is serialized in `toJSON()` as `writingMode: 'vertical-rl'` and restored on load.

---

## 2. Panel Layout

### What it does
Creates a manga/comic page structure with a grid of panels. Each panel is a rectangular region with borders, gutters between panels, and bleed margins. Includes preset templates for common manga page layouts.

### Toolbar UI

| Control | Type | Default | Tooltip |
|---------|------|---------|---------|
| **Panel Layout tool** | Toolbar button | — | `"Create a manga page layout with panels."` |
| **Template** | Dropdown | `grid-3x2` | `"Pre-made page layout. Choose a template or customize."` |
| **Page size** | Preset dropdown | B4 (257×364mm) | `"Standard manga/comic page dimensions."` |
| **Gutter width** | Slider | 0.02 | `"Space between panels."` |
| **Bleed margin** | Slider | 0.01 | `"Artwork margin outside the trim edge."` |
| **Border width** | Slider | 0.004 | `"Thickness of panel borders."` |
| **Border color** | Color picker | Black | `"Color of panel borders."` |
| **Background** | Color picker | White | `"Page background color."` |
| **Show bleed guides** | Toggle | On | `"Show dashed bleed margin guides."` |
| **Show gutter guides** | Toggle | On | `"Show gutter center lines between panels."` |

### Template Presets

| Template | Grid | Description | Use case |
|----------|------|-------------|----------|
| `grid-2x2` | 2×2 | Four equal panels | Simple layouts |
| `grid-3x2` | 3×2 | Six equal panels | Standard manga page |
| `grid-2x3` | 2×3 | Six panels, landscape-oriented | Wide panels |
| `manga-4-panel` | 4×1 | Four horizontal strips | 4-koma (yonkoma) manga |
| `manga-action` | 3×2 | Big top panel + 2 small + big bottom | Action pages |
| `manga-dialog` | 4×2 | Alternating wide/narrow panels | Dialog-heavy pages |
| `full-page` | 1×1 | Single panel, full page | Splash pages |
| `two-strip` | 2×1 | Two horizontal strips | Web comics |
| `three-strip` | 3×1 | Three horizontal strips | Classic newspaper strips |

### Tool Options Panel

```
┌─ Panel Layout ────────────────────────────────┐
│ Template: [Manga Action ▾]                    │
│ Page: [B4 Manga ▾]   W: 2.00  H: 3.00       │
│ ──────────────────────────────────────────────│
│ Gutter:  ■■■□□□  0.020                        │
│ Bleed:   ■□□□□□  0.010                        │
│ Border:  ■□□□□□  0.004                        │
│ ──────────────────────────────────────────────│
│ Border color: [■]   Background: [□]           │
│ ☑ Bleed guides   ☑ Gutter guides              │
└───────────────────────────────────────────────┘
```

### Panel Context Menu (right-click on a panel)

```
┌─────────────────────────────────────────┐
│ ✂ Split Horizontal     (top + bottom)   │
│ ✂ Split Vertical       (left + right)   │
│ ────────────────────────────────────────│
│ 🔗 Merge with Adjacent…                │
│ 🗑 Remove Panel                         │
│ ────────────────────────────────────────│
│ #️ Set Reading Order…                   │
│ 📋 Export This Panel                    │
└─────────────────────────────────────────┘
```

### API

```ts
// Create a panel layout with a template
const layout = shapeManager.createPanelLayout(0, 0, 2, 3, {
  template: 'manga-action',
  gutterWidth: 0.02,
  bleedMargin: 0.01,
  borderWidth: 0.004,
  borderColor: { r: 0, g: 0, b: 0, a: 1 },
  backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
});
const layoutId = layout.getId();

// Apply a different template
shapeManager.applyPanelTemplate(layoutId, 'manga-4-panel');

// Split and merge panels
const newPanelId = shapeManager.splitPanelHorizontal(layoutId, panelId);
const newPanelId2 = shapeManager.splitPanelVertical(layoutId, panelId);
shapeManager.mergePanels(layoutId, panelIdA, panelIdB);
shapeManager.removePanel(layoutId, panelId);

// Configure
shapeManager.setPanelGutter(layoutId, 0.03);
shapeManager.setPanelBleed(layoutId, 0.015);

// Reading order (for export)
shapeManager.setPanelReadingOrder(layoutId, [panelId3, panelId1, panelId2]);

// Get panel list for UI (reading order + bounds)
const panels = shapeManager.getPanelList(layoutId);
// → [{ id, readingOrder, bounds: { x, y, w, h } }, ...]

// Get guide geometry for overlay rendering
const bleedRect = shapeManager.getPanelBleedGuide(layoutId);
// → { x, y, w, h } — draw as dashed rectangle

const gutters = shapeManager.getPanelGutterGuides(layoutId);
// → { horizontal: [y1, y2, ...], vertical: [x1, x2, ...] }
// — draw as dashed lines
```

### Keyboard Shortcuts

| Key | Action | Tooltip |
|-----|--------|---------|
| `G` | Activate panel layout tool | `"Create a panel layout."` |
| `Ctrl + \` | Toggle bleed guides | `"Show/hide bleed margin guides."` |
| `Ctrl + ;` | Toggle gutter guides | `"Show/hide gutter guides."` |

### Guide Rendering

The engine provides geometry data — Frogmarks renders the guides as overlays:

| Guide | Data | Rendering |
|-------|------|-----------|
| **Bleed guide** | `getPanelBleedGuide()` → rect | Dashed magenta rectangle at 50% opacity |
| **Gutter guides** | `getPanelGutterGuides()` → line positions | Dashed cyan lines at 30% opacity |
| **Panel borders** | Rendered by the engine (Rectangle stroke) | Solid black (configurable) |

### UX Notes — Panel Layout

- **One layout per page.** A PanelLayout is a Group node. Multiple layouts can exist in a scene (for multi-page documents), but typically one layout = one page.
- **Panels are clipping regions.** Children placed inside a panel (raster layers or vector shapes) can be clipped to the panel bounds during export. In the editor, clipping is optional (artists may want to see overflow for positioning).
- **Split creates equal halves.** Splitting a panel creates two new panels of equal size occupying the same grid space. The `rowSpan` or `colSpan` of the original panel must be ≥ 2 for the split to work (the grid is subdivided). If a 1×1 panel can't be split, the button should be disabled.
- **Merge requires adjacency.** Two panels can be merged only if they share an edge and have the same span in the perpendicular direction. If merge isn't possible, the menu item should be disabled.
- **Reading order** determines export sequence. For Japanese manga, reading order is typically right-to-left, top-to-bottom. The default order follows grid position, but can be manually reordered.
- **Templates are non-destructive.** Applying a template replaces all panels. If the user has content in panels, warn before applying.
- **Drag to resize gutters.** (Future enhancement) Dragging between panels adjusts gutter width. For now, gutter width is uniform and set via the slider.

### Page Size Presets

| Name | Dimensions | Use case |
|------|-----------|----------|
| B4 Manga | 257 × 364 mm | Standard Japanese manga |
| A4 Comic | 210 × 297 mm | Western comic / doujinshi |
| US Comic | 168 × 260 mm | American comic book |
| Webtoon Strip | 800 × 1280 px | Vertical scroll webtoon |
| Square | 1:1 | Instagram, social media |
| Custom | User input | Any dimensions |

---

## 3. Types Exported from Salsa

```ts
import ShapeManager from '@zaings/salsa/shape-manager';
import type {
  // Speech Balloons
  SpeechBalloonOptions,
  TailSide,              // 'top' | 'right' | 'bottom' | 'left'
  BalloonStyle,          // 'ellipse' | 'rounded-rect' | 'cloud' | 'burst' | 'thought'

  // Panel Layout
  PanelLayoutOptions,
  PanelTemplate,         // 'grid-2x2' | 'manga-action' | 'manga-4-panel' | ...
  PanelDef,              // { id, row, col, rowSpan, colSpan, readingOrder }
} from '@zaings/salsa/shape-manager';
```

---

## 4. Full Tooltip Reference

### Speech Balloons
| Element | Tooltip |
|---------|---------|
| Balloon tool | `"Add a speech balloon. Click to place, then type your dialog."` |
| Style dropdown | `"Visual style: rounded rectangle, ellipse, cloud, burst, or thought bubble."` |
| Writing mode: H | `"Horizontal text (left-to-right). Standard for Western comics."` |
| Writing mode: V | `"Vertical text (top-to-bottom, right-to-left columns). Standard for manga."` |
| Tail side buttons | `"Which edge the tail points from."` |
| Tail position | `"Position of the tail along the edge (0 = start, 1 = end)."` |
| Show tail | `"Show or hide the balloon's pointer tail."` |
| Max width | `"Maximum width before text wraps."` |

### Panel Layout
| Element | Tooltip |
|---------|---------|
| Panel tool | `"Create a manga page layout with panels."` |
| Template | `"Pre-made page layout. Choose a template or customize."` |
| Page size | `"Standard manga/comic page dimensions."` |
| Gutter width | `"Space between panels. Wider = more breathing room."` |
| Bleed margin | `"Artwork margin outside the trim edge for printing."` |
| Border width | `"Thickness of panel border lines."` |
| Bleed guides | `"Show dashed guides at the bleed margin."` |
| Gutter guides | `"Show dashed guides at gutter center lines."` |
| Split Horizontal | `"Split this panel into top and bottom halves."` |
| Split Vertical | `"Split this panel into left and right halves."` |
| Merge | `"Combine two adjacent panels into one."` |
| Reading Order | `"Set the sequence panels are read in (for export)."` |
