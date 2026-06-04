# Salsa — Ephemera System
**Last Updated:** 2026-06-03  
**Status:** ✅ All phases complete

---

## What This Is

**Ephemera** is a procedural generator system for editorial design objects: barcodes, globe wireframes, crosshair reticles, warning labels, serial number strings, registration marks, waveforms, and other graphic vocabulary native to the Y2K / techwear / PS1-packaging / Japanese product design aesthetic.

The output of every generator is a scalable vector graphic placed as an **EphemeraElement** on a dedicated vector layer in the illustration. Users configure parameters in a live-preview panel, save elements to named **EphemeraElementSheets** (collections), and stamp them onto raster layers when finished. Sheets can be exported and sold as asset packs or imported from the community.

This is not a general-purpose vector drawing tool. It is a catalog of opinionated, parametric generators that produce one thing each — but produce it perfectly and with real typographic/technical authenticity (real barcode checksums, real globe projections, real QR data encoding).

---

## Terminology

| Term | Definition |
|------|------------|
| **EphemeraElement** | One generated vector object: a barcode, a globe, a label, etc. Stores type ID + parameter snapshot + rendered SVG. |
| **EphemeraElementSheet** | A named, ordered collection of EphemeraElements. Like a die-cut sticker sheet — a curated set for a particular project or style. |
| **EphemeraGenerator** | One generator implementation (one per type). Accepts params, returns an SVG string. |
| **EphemeraGeneratorRegistry** | Maps type IDs to generator instances. |
| **EphemeraService** | Top-level service: owns sheets, routes generation requests, handles persistence, exposes public API. |
| **Vector Layer** | A special illustration layer that holds EphemeraElements as scalable, positionable vector objects. See dependency note below. |

---

## Architecture

### Data Types

```typescript
/** A single generated element — the output of one generator run. */
interface EphemeraElement {
  id: string;
  typeId: string;              // e.g. 'barcode:code128', 'globe:orthographic'
  label: string;               // user-editable display name
  params: Record<string, unknown>;  // parameter snapshot (fully serializable)
  svg: string;                 // rendered SVG string (cached; regenerate on param change)
  thumbnailDataUrl: string;    // 64×64 PNG for sheet browser
  createdAt: number;           // unix ms
}

/** An ordered, named collection of EphemeraElements. */
interface EphemeraElementSheet {
  id: string;
  name: string;
  elements: EphemeraElement[];
  createdAt: number;
  modifiedAt: number;
}

/** What every generator must implement. */
interface IEphemeraGenerator {
  readonly typeId: string;
  readonly categoryId: string;
  readonly displayName: string;
  readonly description: string;
  getDefaultParams(): Record<string, unknown>;
  getParamSchema(): EphemeraParamSchema[];  // drives the editor UI
  generate(params: Record<string, unknown>): string;  // returns SVG string
}

/** One control in the editor UI — declarative, generator-defined. */
interface EphemeraParamSchema {
  key: string;
  label: string;
  type: 'text' | 'number' | 'range' | 'select' | 'toggle' | 'color' | 'seed';
  default: unknown;
  min?: number;       // for range/number
  max?: number;
  step?: number;
  options?: { value: unknown; label: string }[];  // for select
  group?: string;     // optional grouping header in the editor
}
```

### Service Structure

```
EphemeraService
├── EphemeraGeneratorRegistry       ← maps typeId → IEphemeraGenerator
├── sheets: EphemeraElementSheet[]  ← in-memory state, persisted to project
├── generate(typeId, params)        → EphemeraElement (svg cached)
├── saveToSheet(element, sheetId?)  → adds to sheet (default if sheetId omitted)
├── createSheet(name)               → EphemeraElementSheet
├── deleteSheet(id)
├── moveElement(elementId, toSheetId)
├── exportSheet(id)                 → Blob (.ephemera JSON)
├── exportElement(id)               → Blob (.ephemera JSON)
├── importSheet(blob)               → EphemeraElementSheet
└── serialize() / deserialize()     ← for .frogmarks project save/restore
```

### Vector Layer Dependency

> **Open dependency.** Salsa has vector-ish objects (speech balloons, gizmo overlays) but currently no general-purpose **vector layer** in the raster layer stack that can hold EphemeraElements as freely positioned, scalable objects.

Two options for Phase 1:

**Option A — Dedicated Ephemera Layer (preferred)**  
Add a new `EphemeraLayer` layer type to the layer stack. It holds a list of placed `EphemeraPlacement` objects (element ref + x/y position + scale + rotation). Rendered above all raster layers. "Rasterize to Layer" stamps selected placements onto a raster layer below.

**Option B — Direct Rasterize-Only**  
Skip the persistent vector layer entirely. When the user clicks "Add to Canvas", immediately rasterize the element at the chosen size and stamp it onto the active raster layer. No repositioning after placement. Simpler to build, less flexible.

**Recommendation:** Start with Option B for Phase 1 (it's correct behavior without requiring a new layer architecture). Promote to Option A in Phase 2 when the vector layer is designed properly.

---

## Generator Catalog

### Category 1: Barcodes (1D Linear)

**Types:** Code 128, EAN-13, UPC-A, ITF-14, Code 39

**Shared params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `value` | text | `"0123456789"` | Data to encode |
| `width` | number | 200 | px |
| `height` | number | 80 | px |
| `barColor` | color | `#000000` | |
| `bgColor` | color | `#ffffff` | |
| `showText` | toggle | true | Human-readable text below |
| `fontSize` | range | 10 | 6–16 |
| `quietZone` | range | 10 | Minimum side margin in modules |

**Implementation notes:**
- Code 128 requires checksum computation (mod 103). Must produce a valid scannable barcode.
- EAN-13 requires check digit. Pad with leading zeros if input < 12 digits.
- Render as SVG `<rect>` elements per bar — no font dependency for bars themselves.

---

### Category 2: 2D Codes

**Types:** QR Code, Data Matrix, Aztec Code

**Shared params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `value` | text | `"FROGMARKS"` | Data to encode |
| `size` | number | 200 | px (square) |
| `errorCorrection` | select | `M` | L / M / Q / H |
| `foreColor` | color | `#000000` | |
| `bgColor` | color | `#ffffff` | |
| `margin` | range | 4 | Quiet zone modules |

**QR-specific params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `eyeStyle` | select | `square` | `square` / `rounded` / `dot` |
| `moduleStyle` | select | `square` | `square` / `rounded` / `dot` |

**Implementation notes:**
- QR requires a proper Reed-Solomon encoder. Use a well-tested JS library (e.g., `qrcode-generator` or equivalent) rather than reimplementing.
- Render as SVG `<path>` for compact output.

---

### Category 3: Globe / Wireframe Sphere

**Types:** Orthographic (solid), Orthographic (outline), Mollweide (elliptical outline), Flat grid

**Params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `size` | number | 200 | px |
| `latLines` | range | 8 | Number of latitude bands |
| `lonLines` | range | 12 | Number of longitude meridians |
| `rotationY` | range | 0 | Degrees, rotates the visible hemisphere |
| `rotationX` | range | 20 | Tilt angle |
| `style` | select | `outline` | `outline` / `filled` / `filled-outline` |
| `fillColor` | color | `#000000` | Used when style includes fill |
| `strokeColor` | color | `#000000` | |
| `strokeWidth` | range | 1.5 | 0.5–4 |
| `showEquator` | toggle | true | Bold equator line |
| `bgColor` | color | `#ffffff` | `transparent` option |

**Implementation notes:**
- Orthographic projection: project sphere surface (r=1) through `(sin(lat)cos(lon), cos(lat), sin(lat)sin(lon))` onto the XY plane. Clip to hemisphere facing viewer. Render as SVG `<ellipse>` for outer circle + `<path>` for each grid arc.
- Mollweide: map lat/lon to Mollweide XY (`x = 2√2 λ cos(θ)/π`, `y = √2 sin(θ)` where θ is solved iteratively). Clip to ellipse boundary.
- Only visible arcs (facing the virtual camera) should be drawn; occluded back-hemisphere lines are either omitted or drawn as dashed.

---

### Category 4: Crosshair / Reticle

**Types:** Simple cross, Mil-dot, Tactical scope, HUD targeting, Circular rings

**Params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `size` | number | 200 | px |
| `style` | select | `tactical` | `simple` / `tactical` / `mil-dot` / `hud` / `rings` |
| `strokeWidth` | range | 1.5 | |
| `centerGap` | range | 15 | Gap at center as % of radius |
| `ringCount` | range | 2 | Number of concentric rings |
| `ringSpacing` | range | 25 | % of radius |
| `tickCount` | range | 4 | Radial tick marks per ring |
| `rotation` | range | 0 | Degrees |
| `color` | color | `#000000` | |
| `bgColor` | color | `transparent` | |
| `showDot` | toggle | false | Center dot |

---

### Category 5: Warning / Caution Label

**Types:** Caution, Danger, Do Not Remove, Do Not Open, High Voltage, Biohazard, Prototype, Priority Mail

**Params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `type` | select | `CAUTION` | Predefined label type |
| `customText` | text | `""` | Overrides label type text if non-empty |
| `subtext` | text | `""` | Smaller text below main label |
| `width` | number | 240 | px |
| `height` | number | 80 | px |
| `borderStyle` | select | `solid` | `solid` / `dashed` / `double` / `hazard-stripe` |
| `icon` | select | `auto` | `auto` / `none` / `lightning` / `skull` / `biohazard` / `eye` |
| `language` | select | `en` | `en` / `ja` / `en-ja` |
| `invertColors` | toggle | false | White text on black |
| `cornerStyle` | select | `sharp` | `sharp` / `rounded` / `clipped` (angled cut corner) |

**Implementation notes:**
- Icons (lightning bolt, skull, biohazard) are pure SVG paths — no external font required.
- Japanese kanji variants: 注意 (caution), 危険 (danger), モデル (model) — embed as literal UTF-8 SVG text with fallback to system font.
- Hazard stripe border: alternating black/yellow diagonal stripes at 45° as a `<pattern>` fill.

---

### Category 6: Serial / Data String

**Types:** Serial number, Model code, Order number, Tracking code, Version string, Coordinate

**Params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `format` | text | `"XXXX-0000-XXXX"` | `X` = letter, `0` = digit, literal chars pass through |
| `seed` | seed | random | Randomize button; same seed = same output |
| `prefix` | text | `""` | e.g. `"S/N:"` |
| `suffix` | text | `""` | |
| `fontFamily` | select | `monospace` | `monospace` / `condensed` / `wide` |
| `fontSize` | range | 14 | |
| `letterSpacing` | range | 2 | px |
| `color` | color | `#000000` | |
| `bgColor` | color | `transparent` | |
| `showContainer` | toggle | false | Draws a bordered box around the string |
| `containerPadding` | range | 8 | |

**Format pattern language:**
- `X` → random uppercase letter (A–Z)
- `0` → random digit (0–9)
- `#` → random hex digit (0–9, A–F)
- `A` → random alphanumeric
- Any other character → literal

---

### Category 7: Registration / Print Marks

**Types:** Crop corner marks, Color target (CMYK circle), Crosshair target, Dot grid, Halftone patch

**Params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `type` | select | `crop-corners` | |
| `size` | number | 120 | px total area |
| `markSize` | range | 10 | Length of crop arms / radius of circles |
| `strokeWidth` | range | 0.75 | |
| `color` | color | `#000000` | |
| `bgColor` | color | `transparent` | |
| `gap` | range | 5 | Gap between mark and content boundary |

---

### Category 8: Speed / Motion Lines

**Types:** Chevron row, Diagonal stripes, Dashed speed lines, Converging lines, Zigzag

**Params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `style` | select | `chevron` | |
| `width` | number | 300 | px |
| `height` | number | 40 | px |
| `lineCount` | range | 6 | |
| `angle` | range | 45 | Degrees |
| `strokeWidth` | range | 2 | |
| `gap` | range | 4 | Space between lines |
| `taper` | toggle | false | Perspective taper (lines converge toward a point) |
| `color` | color | `#000000` | |
| `bgColor` | color | `transparent` | |

---

### Category 9: Waveform / Data Bars

**Types:** Audio spectrum bars, EQ equalizer, ECG/heartbeat, Data histogram

**Params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `style` | select | `spectrum` | |
| `width` | number | 200 | px |
| `height` | number | 60 | px |
| `barCount` | range | 24 | |
| `barWidth` | range | 4 | px |
| `gap` | range | 2 | px between bars |
| `seed` | seed | random | Randomizes bar heights |
| `minHeight` | range | 10 | % of total height |
| `rounded` | toggle | false | Rounded bar tops |
| `mirror` | toggle | false | Symmetric top+bottom |
| `color` | color | `#000000` | |
| `bgColor` | color | `transparent` | |

---

### Category 10: Geometric Frame / Border

**Types:** Bracket corners, Circuit board border, Hexagonal border, Military document frame, Target frame

**Params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `style` | select | `bracket` | |
| `width` | number | 200 | px |
| `height` | number | 150 | px |
| `strokeWidth` | range | 1.5 | |
| `cornerSize` | range | 20 | Length of corner elements |
| `cornerStyle` | select | `sharp` | `sharp` / `rounded` / `clipped` |
| `inset` | range | 0 | Inner offset line |
| `color` | color | `#000000` | |
| `bgColor` | color | `transparent` | |

---

### Category 11: Stars / Sparkles

**Types:** 4-point star, 5-point star, 6-point star, 8-point star, Starburst, Sparkle cluster

**Params:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `points` | select | `4` | 4 / 5 / 6 / 8 |
| `outerRadius` | number | 80 | px |
| `innerRatio` | range | 0.4 | Inner radius as % of outer |
| `rotation` | range | 0 | Degrees |
| `style` | select | `filled` | `filled` / `outline` |
| `strokeWidth` | range | 1.5 | For outline only |
| `count` | range | 1 | 1–5 (cluster mode) |
| `scatter` | range | 0 | Cluster spread radius when count > 1 |
| `seed` | seed | random | For cluster positions |
| `color` | color | `#000000` | |
| `bgColor` | color | `transparent` | |

---

## UI / UX Spec

### Panel Layout

The Ephemera panel opens from a toolbar button in Frogmarks. It is a tall side panel, similar in structure to the Cloth simulation panel.

```
┌─────────────────────────────────────┐
│ EPHEMERA              [?]  [Sheet ▾]│
├─────────────────────────────────────┤
│ ┌─ PREVIEW ───────────────────────┐ │
│ │                                 │ │
│ │         [Live SVG Preview]      │ │
│ │                                 │ │
│ │         200 × 80 px             │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ Category:  [Barcodes (1D)      ▾]   │
│ Type:      [Code 128           ▾]   │
├─────────────────────────────────────┤
│ ── Data ─────────────────────────── │
│ Value      [0123456789012       ]   │
│ Show text  [✓]                      │
│ Font size  [──●──────] 10           │
│                                     │
│ ── Appearance ───────────────────── │
│ Width      [200  ] Height [80   ]   │
│ Bar color  [■]  Bg color  [□]       │
│ Quiet zone [──●──────] 10           │
├─────────────────────────────────────┤
│ Target sheet: [Default Sheet    ▾]  │
│  [Add to Canvas]   [Save to Sheet]  │
└─────────────────────────────────────┘
```

### Preview Canvas

- Renders the live SVG into a `<img>` or `<canvas>` element via a blob URL.
- Updates debounced at 150ms after last param change.
- Checkered background when element has transparent bg.
- Zoom-to-fit the preview area — shows actual visual output at scale.
- Click the preview to copy SVG to clipboard.

### Category / Type Selection

- Category dropdown: 11 categories listed above.
- Type dropdown: types within the selected category.
- Switching type resets params to defaults but preserves category.
- Switching category resets both.

### Parameter Editor

- Controls rendered declaratively from `getParamSchema()` — no per-generator UI code needed.
- Groups shown as inline section headers.
- `seed` type renders a number input + a 🎲 randomize button (re-rolls to a new random seed).
- `color` type renders a color swatch that opens the existing color picker.
- Real-time preview: every param change triggers regeneration (debounced).

### Sheet Browser (Sheet ▾ menu)

Opens a secondary panel alongside or as a slide-over:

```
┌───────────────────────────────┐
│ SHEETS                  [+ New]│
│ Default Sheet  (12)       [▾]  │
│ PS1 Label Pack (8)        [▾]  │
│ Techwear Set   (5)        [▾]  │
├───────────────────────────────┤
│ [Grid of element thumbnails]  │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐         │
│  │▓▓│ │▓▓│ │▓▓│ │▓▓│         │
│  └──┘ └──┘ └──┘ └──┘         │
├───────────────────────────────┤
│ [Export Sheet] [Import Sheet] │
└───────────────────────────────┘
```

- Click a thumbnail: loads that element's type + params back into the editor for re-editing.
- Drag a thumbnail: places the element on the canvas (Phase 2 with vector layer).
- Right-click thumbnail: Rename / Move to Sheet / Export Element / Delete.
- Each sheet row: rename inline, delete (with confirmation), export.

### Canvas Placement

**Phase 1 (Option B — direct rasterize):**
- "Add to Canvas" button renders the SVG at a chosen size and stamps it centered on the active raster layer at the current viewport center.
- Size dialog appears: user picks px dimensions before stamping.
- This is destructive (merged into raster); undo works normally via the existing undo stack.

**Phase 2 (Option A — Ephemera Layer):**
- "Add to Canvas" places a non-destructive EphemeraPlacement on the Ephemera Layer.
- User can move, scale, rotate it freely.
- "Rasterize" in the layer context menu stamps selected placements to a chosen raster layer below.

---

## Import / Export

### File Format: `.ephemera`

JSON, gzipped optionally. Can contain one sheet or an array of sheets.

```jsonc
{
  "format": "frogmarks-ephemera",
  "version": 1,
  "sheets": [
    {
      "id": "abc123",
      "name": "PS1 Label Pack",
      "elements": [
        {
          "id": "el1",
          "typeId": "barcode:code128",
          "label": "Custom Barcode",
          "params": { "value": "TTB-987", "height": 80 },
          "svg": "<svg>...</svg>",
          "thumbnailDataUrl": "data:image/png;base64,...",
          "createdAt": 1748908800000
        }
      ]
    }
  ]
}
```

### Export Paths

| Action | What | When |
|--------|------|------|
| Export Sheet | One `.ephemera` file with one sheet | Right-click sheet → Export Sheet |
| Export Element | One `.ephemera` file with one sheet containing one element | Right-click element → Export Element |
| Export All Sheets | One `.ephemera` file with all sheets | File menu → Export Ephemera Library |

### Import

- Drag `.ephemera` file into the Sheet Browser panel, or use Import button.
- On conflict (same sheet name): prompt "Merge into existing" vs. "Import as new sheet."
- Element IDs are re-generated on import to avoid collisions.
- SVG is validated before import (must be well-formed XML, must have `<svg>` root).

---

## Persistence

- Sheets are serialized in `ephemera.json` within the `.frogmarks` ZIP.
- Loaded into `EphemeraService` on project open; saved on project save.
- The Default Sheet is always created on first open if no sheets exist.
- SVG strings are stored verbatim (they are small; a typical barcode SVG is < 4KB).
- Thumbnails are omitted from the project file and regenerated on load to save space.

---

## Integration with Shape Manager

```typescript
// Public API surface on ShapeManager:

// Generate without saving
sm.ephemera.generate(typeId: string, params: Record<string, unknown>): EphemeraElement

// Save to sheet
sm.ephemera.saveToSheet(element: EphemeraElement, sheetId?: string): void

// Sheet management
sm.ephemera.createSheet(name: string): EphemeraElementSheet
sm.ephemera.getSheets(): EphemeraElementSheet[]
sm.ephemera.getDefaultSheet(): EphemeraElementSheet
sm.ephemera.deleteSheet(id: string): void
sm.ephemera.moveElement(elementId: string, toSheetId: string): void

// Stamp to canvas (Phase 1 direct rasterize)
sm.ephemera.stampToLayer(element: EphemeraElement, layerId: string, x: number, y: number, width: number, height: number): void

// Import / export
sm.ephemera.exportSheet(sheetId: string): Promise<Blob>
sm.ephemera.exportElement(elementId: string): Promise<Blob>
sm.ephemera.importFromBlob(blob: Blob): Promise<EphemeraElementSheet[]>

// Static: get all available generators (for populating the UI dropdowns)
sm.ephemera.getCategories(): EphemeraCategory[]
sm.ephemera.getGeneratorsForCategory(categoryId: string): IEphemeraGenerator[]
```

---

## Open Questions

1. **Vector layer architecture.** ✅ Resolved — unified `'vector'` layer type owns both scene graph shapes and ephemera placements. See [vector-layer spec](vector-layer.md).

2. **3D texture export path.** Should "Add to Canvas" have an option "Export as 3D Texture" with custom power-of-two dimensions (256, 512, 1024, 2048)? This would let Ephemera feed directly into the 3D texture pipeline without going through the canvas layer. Probably Phase 2.

3. **QR library dependency.** QR encoding (Reed-Solomon) is non-trivial to reimplement correctly. Should we vendor a small existing JS library, or write from scratch? Given correctness requirements (scannable output), vendoring is strongly preferred. Aztec and Data Matrix add further complexity — may want to scope Phase 1 to QR only.

4. **Monospace font for serial strings.** SVG text with `font-family: monospace` will render differently across OS. For authentic results, consider embedding a subset of a specific monospace font (e.g., a subset of Courier or a free alternative) as a base64 `<font-face>` in generated SVGs. Adds ~15KB to SVGs using text but ensures consistency.

5. **Undo for stamp.** "Add to Canvas" stamps onto a raster layer. This must integrate with the existing raster undo stack, not the 3D undo stack. Confirm existing raster undo captures full-layer state before stamp.

6. **Community marketplace.** Once export/import works, the natural extension is a Frogmarks asset marketplace for `.ephemera` sheet packs. This is a product decision out of scope for this spec but should be kept in mind when designing the file format (include creator metadata fields in v1 even if not displayed yet).

---

## Phasing

### Phase 1 — Core generators + direct rasterize ✅ Complete
- `EphemeraService`, `EphemeraGeneratorRegistry`, `EphemeraElement`, `EphemeraElementSheet`
- Generators: Code 128, Globe (orthographic), Crosshair, Warning Label, Serial String, Motion Lines
- `stampEphemeraToLayer` via `compositeImageOntoLayer` in `RasterLayerManager`
- Sheet CRUD: create, rename, delete, move element between sheets
- Persistence: `ephemera.json` in `.frogmarks` ZIP (pack + unpack wired)
- Full public API on `ShapeManager` (`generateEphemera`, `addEphemeraElement`, etc.)

### Phase 2 — Full generator catalog + import/export ✅ Complete
- New generators: EAN-13, UPC-A, Globe (Mollweide), Registration Marks, Waveform/Data Bars, Geometric Frame/Border, Stars/Sparkles (13 generators total)
- `duplicateElement` in EphemeraService
- Import/Export: `exportSheet`, `exportElement`, `exportAllSheets`, `importFromBlob` (`.ephemera` JSON format)
- 4 new categories in `EPHEMERA_CATEGORIES`
- Public API additions on ShapeManager

### Phase 3 — Vector Layer + live overlay + 3D texture export ✅ Complete

The `'ephemera'` layer type was superseded by the unified `'vector'` layer (see [vector-layer spec](vector-layer.md)). Old `'ephemera'` project entries are automatically restored as vector layers.

**What shipped:**
- `EphemeraPlacement` objects held on the vector layer (x/y/width/height/rotation/opacity/visible)
- Live SVG overlay canvas renders placements every frame (no rasterize required to see them)
- Click-to-select + drag-to-move wired through the WebGPU pointer pipeline
- Rotation-aware AABB hit-testing
- "Rasterize to Layer" stamps all visible placements onto a target raster layer (single undo snapshot)
- `exportEphemeraAs3DTexture(typeId, params, size)` renders SVG to an OffscreenCanvas at a power-of-two size and returns a PNG blob for use as a 3D material texture
- Persistence: placements saved in `ephemera.json`, restored via `addVectorLayerWithId`
- Frogmarks UI: EphemeraPanel with category tabs, live preview, param form, placement list, Rasterize Layer button
