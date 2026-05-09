# Document Size & Artboard — Frogmarks Spec

## Overview

Illustrations in Frogmarks can operate in two modes:

| Mode | Description |
|---|---|
| **Infinite canvas** | Default. No fixed boundary. Pan/zoom freely. |
| **Bounded artboard** | User-defined pixel dimensions. Shows a bordered artboard region, constrains pan/zoom, and enables accurate thumbnail capture. |

The bounded mode mirrors the "new document" experience in Photoshop / Krita / GIMP — the user picks a width, height, and unit, and the drawing surface is that rectangle.

---

## Salsa API

### Setting / clearing document size

```typescript
// Set a bounded document (pixels are the canonical unit)
shapeManager.setDocumentSize(widthPx: number, heightPx: number): void

// Return to infinite canvas
shapeManager.clearDocumentSize(): void

// Read back the current size (null = infinite)
shapeManager.getDocumentSize(): { w: number; h: number } | null
```

`setDocumentSize` does everything atomically:
- Resizes the raster layer canvas to exactly `widthPx × heightPx`.
- Enables the artboard overlay (checkerboard background clipped to the artboard,
  pan/zoom constraints so the user can't drift far from the artboard).
- Stores the canonical pixel size for thumbnail capture.

`clearDocumentSize` reverses all of that — raster layers revert to the display canvas size and the artboard overlay disappears.

### Thumbnail capture

```typescript
shapeManager.captureDocumentBoundsToBlob(
  format?: 'png' | 'jpeg',   // default 'png'
  maxSize?: number,           // default 2048 — max pixel dimension of output
): Promise<Blob>
```

- **Bounded artboard**: crops the rendered frame to the artboard region, then scales to fit within `maxSize × maxSize` while preserving the document aspect ratio. Output matches the document proportions exactly.
- **Infinite canvas**: captures the full viewport, scaled to `maxSize`.

For dashboard thumbnails, call with `format: 'jpeg', maxSize: 512` for small fast previews, or `format: 'png', maxSize: 2048` for high-quality exports.

---

## "New Illustration" Dialog — UX spec

### When to show it

Show this dialog when the user creates a new illustration — before the canvas opens. Optionally also accessible via **File → Document Settings** once the illustration is open.

### Layout

```
┌─────────────────────────────────────────────┐
│  New Illustration                           │
│                                             │
│  Preset   [ Social Square ▾ ]               │
│                                             │
│  Width   [  1080  ]  ─────────┐             │
│  Height  [  1080  ]           │ px ▾        │
│                               └─────────────│
│  ○ Portrait   ● Landscape   ○ Square        │
│                                             │
│  Canvas    ● Bounded   ○ Infinite           │
│                                             │
│  ─────────────────────────────────────────  │
│                                             │
│  Artboard preview  [1:1 thumbnail preview]  │
│                                             │
│           [ Cancel ]   [ Create ]           │
└─────────────────────────────────────────────┘
```

### Fields

#### Preset dropdown
Common sizes as a starting point. User can override width/height after selecting.

| Preset | W | H | Notes |
|---|---|---|---|
| Square | 1080 | 1080 | |
| Instagram Post | 1080 | 1080 | |
| Instagram Story | 1080 | 1920 | |
| Twitter/X Post | 1200 | 675 | |
| A4 Print | 2480 | 3508 | 300 dpi |
| 4K | 3840 | 2160 | |
| HD | 1920 | 1080 | |
| Custom | — | — | User-entered |

Selecting any preset fills in Width / Height but keeps the unit selector in sync. Changing W or H manually switches the preset dropdown to "Custom".

#### Width / Height fields
- Numeric text inputs. Integer only (no decimal).
- Min: 1 × 1. Max: 8192 × 8192 (reject silently and clamp).
- Linked by default (lock icon between them). When linked, changing one recalculates the other to maintain aspect ratio. Click the lock icon to unlink.
- Below both fields: a small label showing the aspect ratio e.g. `16 : 9`.

#### Unit selector
`px` only for now (the only unit Salsa works in at this stage). Design the selector as a dropdown so `cm`, `mm`, `in` can be added later without a redesign.

#### Orientation buttons
Portrait / Landscape / Square. Tapping one swaps W and H (or forces W = H for square). These are cosmetic shortcuts — they don't add a constraint.

#### Canvas mode
- **Bounded** (default): artboard is the document rect.
- **Infinite**: W/H fields are greyed out; document has no fixed boundary.

When **Infinite** is selected, hide the width/height/preset/orientation section entirely (or grey it out) to avoid confusion.

#### Artboard preview
A small proportional rectangle (max ~80 × 80 px rendered) showing the aspect ratio. Updates live as W/H change. For portrait docs it shows a tall rectangle; landscape shows wide; square is square. No content — just the shape.

### Validation & edge cases
- Non-numeric input: clear the field and show a subtle shake animation. Do not allow the Create button to be pressed.
- Width or Height = 0: replace with 1 on blur.
- Extremely large sizes (> 4096 in either dimension): show a warning label beneath the fields: *"Large canvases may be slow on some devices."* Allow anyway.

### On Create
```typescript
if (mode === 'bounded') {
  shapeManager.setDocumentSize(widthPx, heightPx);
} else {
  shapeManager.clearDocumentSize(); // ensure infinite mode
}
```

Then open the illustration normally.

---

## Document Settings (existing illustration)

**File → Document Settings** (or a gear icon in the illustration header) opens a lighter version of the same dialog:
- Same Width / Height / Unit fields.
- A **"Resize canvas"** vs **"Resize content"** toggle (for when the user changes dimensions on an existing doc).
  - **Resize canvas** (default): changes the artboard boundary but leaves all drawn content at its current world-space positions. Content outside the new bounds is not deleted.
  - **Resize content**: scales all content to fill the new artboard (use with caution — this is destructive).
- Changing from Bounded → Infinite calls `clearDocumentSize()`.
- Changing from Infinite → Bounded calls `setDocumentSize(w, h)`.

> **Note for v1:** Implement Document Settings as read-only (show the current size, no editing). The full resize-content flow can wait.

---

## Dashboard thumbnails

### With bounded document

```typescript
// On save / autosave
const thumb = await shapeManager.captureDocumentBoundsToBlob('jpeg', 512);
// Store thumb as the illustration's preview image
```

The thumbnail card in the dashboard grid uses the document's aspect ratio for its card shape:

```
┌─────────┐  ┌──────────────────┐  ┌───┐
│         │  │                  │  │   │
│  1:1    │  │    16:9          │  │9:│
│         │  │                  │  │16 │
└─────────┘  └──────────────────┘  └───┘
```

Cards have a fixed HEIGHT (e.g., 200 px) and variable WIDTH derived from the document aspect ratio. Cap the card width at some reasonable max (e.g., 2× the column unit) to prevent very wide landscape docs from breaking the grid.

Frogmarks should store `documentAspect = w / h` in the illustration's metadata so the dashboard can lay out the correct card shape before the thumbnail image loads.

### With infinite canvas

Thumbnail is captured from the current viewport — whatever was visible at save time. Card shape is a fixed square or 4:3 rectangle (designer's choice).

### Thumbnail refresh
- Capture on every save (auto-save or manual).
- Do NOT capture on every frame — it triggers a GPU readback which stalls the pipeline.
- If a thumbnail hasn't been captured yet (new file), show a placeholder grey card.

---

## Pan / Zoom constraints in bounded mode

Salsa automatically constrains pan and zoom when a document size is set:
- **Minimum zoom**: sized so the full artboard is always visible (user can't zoom out so far the artboard disappears).
- **Maximum pan**: the artboard stays within the viewport; the user can't pan so far that the artboard scrolls fully off-screen.

These constraints are active automatically after `setDocumentSize()`. No additional calls needed.

Frogmarks UI should show a **"Fit artboard"** button (or keyboard shortcut, e.g., `F`) that recenters and fits the artboard:

```typescript
// Fit artboard to viewport: reset pan to 0, set zoom so the artboard fills ~80% of the viewport
const docSize = shapeManager.getDocumentSize();
if (docSize) {
  const canvas = renderer.getCanvas();
  const fitZoom = Math.min(
    canvas.clientWidth  / docSize.w * 0.85,
    canvas.clientHeight / docSize.h * 0.85,
  );
  interactionService.setZoom(fitZoom);
  interactionService.setPan(0, 0);
}
```

---

## Visual design of the artboard

When bounded mode is active Salsa renders:
- **Checkerboard pattern** clipped to the artboard rect (already implemented).
- **Drop shadow** outside the artboard rect — dark/transparent halo to separate artboard from the infinite background. Implemented in Frogmarks as an absolutely-positioned `<div>` with `box-shadow` overlaid on the canvas, positioned using `getArtboardScissor()`:

```typescript
const scissor = shapeManager.webgpuRenderer.getArtboardScissor();
// scissor: { x, y, w, h } in physical pixels — divide by devicePixelRatio for CSS
if (scissor) {
  const dpr = window.devicePixelRatio;
  artboardShadowEl.style.left   = scissor.x / dpr + 'px';
  artboardShadowEl.style.top    = scissor.y / dpr + 'px';
  artboardShadowEl.style.width  = scissor.w / dpr + 'px';
  artboardShadowEl.style.height = scissor.h / dpr + 'px';
}
```

  Style: `box-shadow: 0 4px 32px rgba(0,0,0,0.55)`. Update on every pan/zoom event.

- **Artboard label** (optional): small text label above-left of the artboard showing the document name and pixel dimensions, e.g. `my-illustration  1920 × 1080`. Same absolute-positioned overlay pattern as the drop shadow.

---

## Serialisation

Store document size in the illustration's metadata so it survives save/load:

```typescript
// In the manifest / scene.json
{
  "documentSize": { "w": 1920, "h": 1080 } | null
}
```

On load:
```typescript
if (manifest.documentSize) {
  shapeManager.setDocumentSize(manifest.documentSize.w, manifest.documentSize.h);
} else {
  shapeManager.clearDocumentSize();
}
```

`setDocumentSize` / `clearDocumentSize` are idempotent — safe to call on every load.

> The `canvasWidth` / `canvasHeight` fields already in the manifest record the raster layer resolution. When `documentSize` is present, those two values should match `documentSize.w` and `documentSize.h`. Treat them as redundant and keep in sync.
