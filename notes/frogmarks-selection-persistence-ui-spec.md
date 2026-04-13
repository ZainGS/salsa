# Frogmarks UI Spec — Magic Wand, Transform & Auto-Save

> **For**: Frogmarks front-end team  
> **Salsa version**: Current (`npm run build` passing, 123 modules)  
> **Date**: April 2026

All features below are wired in Salsa's engine. Frogmarks needs UI to expose them.

---

## Quick Summary

| Feature | What it is | Why it matters |
|---------|-----------|----------------|
| [Magic Wand Selection](#1-magic-wand-selection) | Click a region → select all similar-color pixels | The #1 selection tool for coloring workflows. Required for efficient flat coloring. |
| [Transform Operations](#2-transform-operations) | Flip, rotate, scale selected pixels | Every drawing app needs these. Basic editing essentials. |
| [Auto-Save / OPFS Persistence](#3-auto-save--opfs-persistence) | Automatic document saving to browser storage | Non-negotiable before any real use. One crash = lost art = user never returns. |

---

## 1. Magic Wand Selection

### What it does
Click on a pixel → select all connected pixels of a similar color. This creates a selection mask (the "marching ants" boundary). Once selected, the artist can fill, delete, transform, or paint within the selection.

### Toolbar UI

The magic wand is a new selection sub-tool alongside Rectangle, Ellipse, and Lasso.

| Control | Type | Tooltip |
|---------|------|---------|
| **Magic Wand tool** | Toolbar button (in selection tool group) | `"Select a region by color. Click on a pixel to select all connected pixels of a similar color. Adjust tolerance to control how much color variation is included."` |
| **Tolerance** | Slider (0–255) | `"How much color variation to include in the selection. 0 = exact color match only. 32 = good for clean lineart. 64+ = for rough sketches with anti-aliasing."` |
| **Contiguous** | Toggle (on/off) | `"ON: select only the connected region you clicked (standard magic wand). OFF: select ALL pixels of the same color across the entire layer."` |
| **Mode** | Segmented toggle (New / Add / Subtract) | `"New: replace any existing selection. Add (Shift+click): expand the selection. Subtract (Alt+click): remove from the selection."` |
| **Reference Layer** | Dropdown (layer list) | `"Use another layer's colors to determine the selection boundary, but create the selection on the current layer."` |

### Tool Options Panel

```
┌─ Magic Wand ───────────────────────────────┐
│ Tolerance:  ■■■■■■■■□□□□□□□□  32           │
│ ☑ Contiguous                               │
│ Mode: [New] [+Add] [−Subtract]             │
│ Reference:  [None ▾]                       │
└────────────────────────────────────────────┘
```

### API

```ts
// Activate magic wand as the selection tool
shapeManager.enableRasterSelection('magic-wand');

// Configure magic wand options
shapeManager.setMagicWandOptions({
  tolerance: 32,
  contiguous: true,
  referenceLayerId: inkLayerId,   // optional
});

// Programmatic magic wand (without pointer interaction)
await shapeManager.rasterSelectMagicWand(120, 80, 32, {
  contiguous: true,
  mode: 'add',
  referenceLayerId: inkLayerId,
});

// Select by color (non-contiguous — all similar pixels on the layer)
await shapeManager.rasterSelectByColor(120, 80, 32, 'new');
```

### Keyboard Shortcuts

| Key | Action | Tooltip |
|-----|--------|---------|
| `W` | Activate magic wand tool | `"Switch to the magic wand selection tool."` |
| `Shift + click` | Add to selection | `"Add the clicked region to the existing selection."` |
| `Alt + click` | Subtract from selection | `"Remove the clicked region from the existing selection."` |

### Behavior
- A single click triggers the wand — no drag required.
- The selection respects the current selection mode (new/add/subtract).
- Shift+click forces "add" mode, Alt+click forces "subtract" regardless of the UI toggle.
- The marching ants appear immediately after click.
- If no pixels match (e.g., exact tolerance 0 on a gradient), the selection is empty.
- The wand works on the **active layer** unless a reference layer is set.

### Tolerance Guide

| Tolerance | Best for |
|-----------|----------|
| 0 | Pixel art (exact match) |
| 8–16 | Clean digital lineart |
| 24–48 | Standard hand-drawn ink |
| 64–128 | Rough sketches, anti-aliased edges |
| 255 | Select everything |

---

## 2. Transform Operations

### What they do
Flip, rotate, and scale the currently selected pixels. These operate on the **floating selection** — the pixels are lifted from the layer, transformed, and stamped back down when committed.

### UI Controls

| Action | Trigger | API | Tooltip |
|--------|---------|-----|---------|
| **Flip Horizontal** | Menu → Edit → Flip Horizontal | `shapeManager.rasterFlipHorizontal()` | `"Mirror the selection left-to-right."` |
| **Flip Vertical** | Menu → Edit → Flip Vertical | `shapeManager.rasterFlipVertical()` | `"Mirror the selection top-to-bottom."` |
| **Rotate 90° CW** | Menu → Edit → Rotate 90° CW | `shapeManager.rasterRotate(90)` | `"Rotate the selection 90 degrees clockwise."` |
| **Rotate 90° CCW** | Menu → Edit → Rotate 90° CCW | `shapeManager.rasterRotate(-90)` | `"Rotate the selection 90 degrees counter-clockwise."` |
| **Rotate 180°** | Menu → Edit → Rotate 180° | `shapeManager.rasterRotate(180)` | `"Rotate the selection 180 degrees."` |
| **Free transform** | Enter key on selection, or Ctrl+T | `shapeManager.rasterBeginTransform()` | `"Enter free transform mode. Drag corners to scale, drag outside to rotate."` |
| **Scale** | Drag corner handles during transform | `shapeManager.rasterUpdateTransform(dx, dy, scaleX, scaleY, rotation)` | `"Drag corners to resize."` |
| **Commit** | Enter key or click outside | `shapeManager.rasterCommitTransform()` | `"Apply the transform."` |
| **Cancel** | Escape key | `shapeManager.rasterCancelTransform()` | `"Cancel the transform and restore the original."` |

### API

```ts
// Quick operations (auto begin + commit)
await shapeManager.rasterFlipHorizontal();
await shapeManager.rasterFlipVertical();
await shapeManager.rasterRotate(90);     // degrees: 90, -90, 180, or any angle
await shapeManager.rasterScale(2.0, 2.0); // 2x scale

// Manual transform workflow (for interactive drag)
shapeManager.rasterBeginTransform();
shapeManager.rasterUpdateTransform(dx, dy, scaleX, scaleY, rotation);
shapeManager.rasterCommitTransform();
shapeManager.rasterCancelTransform();

// Read transform state for UI handles
const info = shapeManager.getRasterSelectionInfo();
// info.isTransforming → boolean
// info.transform → { translateX, translateY, scaleX, scaleY, rotation }
// info.bounds → { x, y, w, h }
```

### Keyboard Shortcuts

| Key | Action | Tooltip |
|-----|--------|---------|
| `Ctrl + T` | Enter free transform mode | `"Transform the selected pixels."` |
| `Ctrl + Shift + H` | Flip horizontal | `"Mirror left-to-right."` |
| `Ctrl + Shift + V` | Flip vertical | `"Mirror top-to-bottom."` |
| `Enter` | Commit transform | `"Apply the current transform."` |
| `Escape` | Cancel transform | `"Discard the transform."` |

### Edit Menu Layout

```
┌─ Edit ────────────────────────────────────┐
│ Undo                         Ctrl+Z       │
│ Redo                         Ctrl+Y       │
│ ────────────────────────────────────────── │
│ Cut                          Ctrl+X       │
│ Copy                         Ctrl+C       │
│ Paste                        Ctrl+V       │
│ Delete                       Del          │
│ ────────────────────────────────────────── │
│ Select All                   Ctrl+A       │
│ Deselect                     Ctrl+D       │
│ Invert Selection             Ctrl+Shift+I │
│ ────────────────────────────────────────── │
│ Free Transform               Ctrl+T       │
│ Flip Horizontal              Ctrl+Shift+H │
│ Flip Vertical                Ctrl+Shift+V │
│ ▸ Rotate                                  │
│   ├ 90° Clockwise                         │
│   ├ 90° Counter-clockwise                 │
│   └ 180°                                  │
│ ────────────────────────────────────────── │
│ Fill Selection               Alt+Bksp     │
└───────────────────────────────────────────┘
```

### UX Notes
- **All transform operations require an active selection.** If no selection exists, the commands should be grayed out / disabled in the menu.
- The quick flip/rotate methods automatically begin a transform, apply it, and commit in one step. The user sees the result instantly — no interactive handle step.
- Free transform mode shows **8 handles** (4 corners + 4 edge midpoints) around the selection bounding box. Dragging corners scales, dragging edges scales in one axis, dragging outside the box rotates.
- During free transform, the selected pixels are shown as a floating overlay with the transform applied in real-time (the engine's transform preview).

---

## 3. Auto-Save / OPFS Persistence

### What it does
Automatically saves the entire document (layers, animation, shapes, brush presets) to the browser's Origin Private File System (OPFS). No server required. Survives page reloads, tab closes, and crashes.

### How it works
- OPFS is a browser-local file system API that provides fast, persistent storage without user prompts.
- Documents are stored as structured directories with binary pixel data (not base64 — fast and compact).
- Auto-save fires on a timer (default: every 30 seconds) and after every brush stroke ends (debounced by 5 seconds).
- Saves are atomic — a complete snapshot is written each time.

### UI Controls

| Control | Type | Tooltip |
|---------|------|---------|
| **Auto-save indicator** | Status bar icon (cloud/check/spinner) | `"Auto-save is active. Your work is saved automatically every 30 seconds."` |
| **Save button** | Toolbar / menu (Ctrl+S) | `"Save your document now."` |
| **Document name** | Editable text in title bar | `"Click to rename your document."` |
| **Open document** | File menu / gallery | `"Open a previously saved document."` |
| **Delete document** | Gallery context menu | `"Permanently delete this saved document."` |
| **Auto-save toggle** | Settings | `"Enable or disable automatic saving."` |
| **Save interval** | Settings dropdown | `"How often to auto-save. More frequent = safer but may cause brief pauses on very large documents."` |

### API

```ts
// Check if OPFS is available
shapeManager.isAutoSaveAvailable();  // → true/false

// Start auto-saving
shapeManager.enableAutoSave('doc-uuid-123', 'My Illustration', {
  intervalMs: 30000,        // save every 30s
  strokeDebounceMs: 5000,   // save 5s after stroke ends
  pixelFormat: 'raw',       // fast saves (or 'webp' for smaller files)
});

// Stop auto-saving
shapeManager.disableAutoSave();

// Manual save (Ctrl+S)
const success = await shapeManager.saveDocument();

// Load a document
const success = await shapeManager.loadDocument('doc-uuid-123');

// List all saved documents (for gallery)
const docs = await shapeManager.listSavedDocuments();
// → [{ docId, name, savedAt, canvasWidth, canvasHeight, layerCount }, ...]

// Delete a document
await shapeManager.deleteSavedDocument('doc-uuid-123');

// Subscribe to save events (for UI indicator)
shapeManager.onSaveEvent(
  () => showSavingSpinner(),
  (success) => success ? showSavedCheck() : showSaveError(),
);

// Set document name
shapeManager.setDocumentName('My Cool Drawing');
shapeManager.getDocumentName(); // → 'My Cool Drawing'

// Notify stroke end (call from brush engine callback)
shapeManager.notifyStrokeEnd();
```

### Document Gallery UI

When the user clicks "Open" or visits the app:

```
┌─ Your Documents ───────────────────────────────────────┐
│                                                        │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐      │
│  │ thumb  │  │ thumb  │  │ thumb  │  │   +    │      │
│  │        │  │        │  │        │  │  New   │      │
│  └────────┘  └────────┘  └────────┘  └────────┘      │
│  Cat Drawing  Walk Cycle  Logo v2     New Document     │
│  2 min ago    Yesterday   Apr 3                        │
│  3 layers     12 frames   1 layer                      │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### Save Indicator States

| State | Icon | Text | When |
|-------|------|------|------|
| **Idle** | ☁️ or ✓ | "Saved" | Document is up to date |
| **Saving** | ⟳ (spinner) | "Saving…" | Save in progress |
| **Saved** | ✓ (green) | "Saved ✓" | Save just completed (show for 3s then fade to idle) |
| **Error** | ⚠️ (yellow) | "Save failed" | Save error (click for details) |
| **Unavailable** | — | "Auto-save unavailable" | OPFS not supported (incognito mode, old browser) |

### Auto-Save Interval Options

| Option | Value | Tooltip |
|--------|-------|---------|
| Frequent | 15s | `"Save every 15 seconds. Safest, but may cause brief pauses on large documents."` |
| Normal (default) | 30s | `"Save every 30 seconds. Good balance of safety and performance."` |
| Relaxed | 60s | `"Save every minute. Less frequent saves, fewer interruptions."` |
| Manual only | 0 | `"Only save when you press Ctrl+S. Not recommended — you may lose work."` |

### What gets saved

| Data | How it's stored | Size impact |
|------|----------------|-------------|
| Vector shapes (scene graph) | JSON (~1-50 KB) | Tiny |
| Raster layers (pixel data) | Raw RGBA binary (~4 MB per 1024×1024 layer) | Large |
| Animation cels | Raw RGBA binary (same as layers, per cel) | Large if many cels |
| Layer metadata | JSON (~1 KB) | Tiny |
| Animation timeline state | JSON (~1 KB) | Tiny |
| Brush presets | JSON (~5-20 KB) | Tiny |

### Browser Compatibility

| Browser | OPFS Support | Notes |
|---------|-------------|-------|
| Chrome 86+ | ✅ Full | Best support |
| Edge 86+ | ✅ Full | Same as Chrome |
| Firefox 111+ | ✅ Full | Works well |
| Safari 15.2+ | ✅ Full | Works well |
| Incognito/Private | ❌ No | OPFS not available — show "auto-save unavailable" |

### Keyboard Shortcuts

| Key | Action | Tooltip |
|-----|--------|---------|
| `Ctrl + S` | Save now | `"Save your document."` |
| `Ctrl + O` | Open document | `"Open a saved document."` |
| `Ctrl + Shift + S` | Save as (rename + save) | `"Save with a new name."` |

### UX Notes
- **Auto-save should be ON by default.** Don't make the user opt in — losing work is unacceptable.
- When OPFS isn't available, show a **persistent warning** at the top: "Auto-save is unavailable in this browser mode. Please save your work manually."
- The save indicator should be **always visible** in the status bar or title bar — not hidden in a menu.
- On app startup, check for existing documents and offer to resume the most recent one.
- The document gallery should show a **thumbnail** preview if possible (render the first frame at low res).
- `notifyStrokeEnd()` should be wired into the brush engine's existing stroke-end callback so saves happen automatically after drawing.

---

## 4. Types Exported from Salsa

```ts
import ShapeManager from '@zaings/salsa/shape-manager';
import type {
  // Auto-save
  AutoSaveConfig,
  DocumentInfo,
  DocumentManifest,
  // Selection
  SelectionTool,     // 'rect' | 'ellipse' | 'lasso' | 'magic-wand'
  // Stabilizer (from previous spec)
  StabilizationMethod,
  BrushStabilization,
  // Flood fill (from previous spec)
  FloodFillOptions,
  // Animation (from animation spec)
  OnionSkinConfig,
  LoopMode,
  PlaybackState,
  TimelineState,
} from '@zaings/salsa/shape-manager';
```

---

## 5. Full Tooltip Reference

### Magic Wand
| Element | Tooltip |
|---------|---------|
| Magic wand tool | `"Select a region by color. Click on a pixel to select all connected similar-color pixels."` |
| Tolerance slider | `"Color similarity threshold. 0 = exact match, 32 = standard, 64+ = rough sketches."` |
| Contiguous toggle | `"ON: connected region only. OFF: all similar pixels on the layer."` |
| Mode: New | `"Replace any existing selection."` |
| Mode: Add | `"Expand the selection (Shift+click)."` |
| Mode: Subtract | `"Remove from the selection (Alt+click)."` |
| Reference layer | `"Use another layer's colors to determine the selection boundary."` |

### Transform
| Element | Tooltip |
|---------|---------|
| Free Transform | `"Transform the selected pixels. Drag corners to scale, outside to rotate."` |
| Flip Horizontal | `"Mirror the selection left-to-right."` |
| Flip Vertical | `"Mirror the selection top-to-bottom."` |
| Rotate 90° CW | `"Rotate 90 degrees clockwise."` |
| Rotate 90° CCW | `"Rotate 90 degrees counter-clockwise."` |
| Rotate 180° | `"Rotate 180 degrees."` |
| Commit (Enter) | `"Apply the current transform."` |
| Cancel (Escape) | `"Discard the transform and restore the original."` |

### Auto-Save
| Element | Tooltip |
|---------|---------|
| Auto-save indicator | `"Your work is saved automatically."` |
| Save button | `"Save your document now. Keyboard: Ctrl+S"` |
| Document name | `"Click to rename your document."` |
| Save interval: 15s | `"Save every 15 seconds. Safest."` |
| Save interval: 30s | `"Save every 30 seconds. Recommended."` |
| Save interval: 60s | `"Save every minute."` |
| Save interval: Manual | `"Only saves when you press Ctrl+S. Not recommended."` |
| Gallery: Open | `"Open a previously saved document."` |
| Gallery: Delete | `"Permanently delete this saved document."` |
| Gallery: New | `"Start a new blank document."` |
