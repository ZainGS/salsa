# Frogmarks Phase 2 — Layer Compositor UI Spec

> **Prerequisite**: Phase 1 (brush presets, dynamics, stabilization) is already integrated.
> This phase adds **blend modes**, **per-layer opacity**, **clipping masks**, **lock transparency**,
> **layer reordering**, and updates the layer panel UI accordingly.

---

## 1. What Changed in Salsa

A new `RasterCompositor` GPU compute shader now flattens all raster layers back-to-front with proper blend modes. Each layer carries four new properties:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `blendMode` | `LayerBlendMode` (enum, 0-11) | `Normal` (0) | How this layer mixes with layers below |
| `opacity` | `number` (0-1) | `1.0` | Per-layer opacity applied during compositing |
| `clipped` | `boolean` | `false` | Clip to the alpha of the layer immediately below |
| `lockTransparency` | `boolean` | `false` | Paint only where alpha > 0 on this layer |

---

## 2. The `LayerBlendMode` Enum

```ts
enum LayerBlendMode {
  Normal     = 0,
  Multiply   = 1,
  Screen     = 2,
  Overlay    = 3,
  SoftLight  = 4,
  HardLight  = 5,
  ColorDodge = 6,
  ColorBurn  = 7,
  Darken     = 8,
  Lighten    = 9,
  Add        = 10,   // Also known as "Linear Dodge" or "Glow"
  Difference = 11,
}
```

Access the enum from ShapeManager:
```ts
const BlendMode = ShapeManager.LayerBlendMode;
```

**UI-friendly labels** to use in dropdowns:

| Value | Label | Category | Tooltip |
|-------|-------|----------|---------|
| 0 | Normal | — | Standard alpha compositing |
| 1 | Multiply | Darken | Darkens; great for shadows |
| 2 | Screen | Lighten | Lightens; great for glows |
| 3 | Overlay | Contrast | Increases contrast |
| 4 | Soft Light | Contrast | Subtle contrast shift |
| 5 | Hard Light | Contrast | Strong contrast shift |
| 6 | Color Dodge | Lighten | Bright highlight pop |
| 7 | Color Burn | Darken | Deep shadow burn |
| 8 | Darken | Darken | Keeps darkest pixels |
| 9 | Lighten | Lighten | Keeps lightest pixels |
| 10 | Add (Glow) | Lighten | Additive blending for fire/light effects |
| 11 | Difference | Utility | Inverts based on brightness difference |

---

## 3. Updated Layer Panel UI

Replace the current simple layer list with:

```
┌──────────────────────────────────────┐
│  Layers                              │
├──────────────────────────────────────┤
│  [Search layers...]                  │
│                                      │
│  ┌──────────────────────────────┐    │
│  │ 👁️  Layer 3         🔗 🔒 🖼️ │    │   ← 🔗 = clipping, 🔒 = lock transparency
│  │     [Multiply ▾]  Opacity: 80%│    │
│  ├──────────────────────────────┤    │
│  │ 👁️  Layer 2              🖼️ │    │
│  │     [Normal ▾]   Opacity: 100%│   │
│  ├──────────────────────────────┤    │
│  │ 👁️  Layer 1              🖼️ │    │
│  │     [Normal ▾]   Opacity: 100%│   │
│  ├──────────────────────────────┤    │
│  │ 👁️  Background           🖼️ │    │
│  │     [Normal ▾]   Opacity: 100%│   │
│  └──────────────────────────────┘    │
│                                      │
│  [+ Add] [🗑 Del] [⬆] [⬇]          │
└──────────────────────────────────────┘
```

### 3.1 Per-Layer Row Controls

Each layer row now shows:

| Element | UI | Description |
|---------|----|-------------|
| 👁️ Eye | Toggle button | Visibility — `shapeManager.setRasterLayerVisibility(id, visible)` |
| Layer name | Editable text | Double-click to rename |
| 🔗 Clip icon | Toggle button | Clipping mask — only appears on non-bottom layers |
| 🔒 Lock icon | Toggle button | Lock transparency |
| 🖼️ Thumbnail | Small preview | Layer content preview |
| Blend mode | Dropdown | 12 blend modes (see enum above) |
| Opacity | Slider (0-100%) | Per-layer opacity |

### 3.2 Blend Mode Dropdown

Place a small dropdown **below** the layer name in each row:

```ts
// On change:
const BlendMode = ShapeManager.LayerBlendMode;
shapeManager.setRasterLayerBlendMode(layerId, BlendMode.Multiply);
```

Group the dropdown options by category for easier scanning:
```
─── Normal ───
  Normal
─── Darken ───
  Multiply
  Color Burn
  Darken
─── Lighten ───
  Screen
  Color Dodge
  Lighten
  Add (Glow)
─── Contrast ───
  Overlay
  Soft Light
  Hard Light
─── Utility ───
  Difference
```

### 3.3 Opacity Slider

A compact horizontal slider (0-100%) on each layer row:

```ts
// On change:
shapeManager.setRasterLayerOpacity(layerId, sliderValue / 100);
```

Display the current percentage as a label next to the slider.

### 3.4 Clipping Mask Toggle (🔗)

A small toggle icon on the right side of each layer row (except the bottom layer). When active, it should show a visual indicator: indent the layer row slightly and show a downward arrow connecting it to the layer below.

```ts
// On toggle:
shapeManager.setRasterLayerClipping(layerId, !currentClipped);
```

**Visual cue**: When a layer is clipped, indent its row or show a small arrow pointing down to the layer it clips to. This is how Photoshop and Clip Studio show clipping.

### 3.5 Lock Transparency Toggle (🔒)

A small lock icon on each layer row. When active, painting on this layer only affects pixels where alpha > 0 — transparent areas stay transparent.

```ts
// On toggle:
shapeManager.setRasterLayerLockTransparency(layerId, !currentLocked);
```

**Use case**: Flat-color a character silhouette, then lock transparency and paint shading on the same layer without going outside the silhouette.

### 3.6 Layer Reordering (Drag & Drop)

Allow drag-and-drop reordering of layer rows. On drop:

```ts
// Collect layer ids in the new visual order (bottom-to-top)
const orderedIds = visibleLayerRows.map(row => row.layerId);
shapeManager.reorderRasterLayers(orderedIds);
```

As a simpler alternative, use ⬆ / ⬇ buttons:
```ts
// Move layer up (toward front):
const ids = shapeManager.getRasterLayers().map(l => l.id);
const idx = ids.indexOf(selectedLayerId);
if (idx < ids.length - 1) {
  [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
  shapeManager.reorderRasterLayers(ids);
}
```

---

## 4. Data Source: Updated `getRasterLayers()`

The method now returns these additional fields per layer:

```ts
const layers = shapeManager.getRasterLayers();
// Each layer: {
//   id: string,
//   name: string,
//   visible: boolean,
//   locked: boolean,
//   blendMode: LayerBlendMode,   // ← NEW
//   opacity: number,             // ← NEW (0-1)
//   clipped: boolean,            // ← NEW
//   lockTransparency: boolean,   // ← NEW
// }
```

---

## 5. Full API Cheat Sheet (New Methods Only)

```ts
// ── Layer Blend Mode ──
const BlendMode = ShapeManager.LayerBlendMode;
shapeManager.setRasterLayerBlendMode(layerId, BlendMode.Multiply)  // returns boolean
shapeManager.setRasterLayerBlendMode(layerId, BlendMode.Screen)
shapeManager.setRasterLayerBlendMode(layerId, BlendMode.Normal)    // reset

// ── Layer Opacity ──
shapeManager.setRasterLayerOpacity(layerId, 0.8)   // 80% — returns boolean

// ── Clipping Mask ──
shapeManager.setRasterLayerClipping(layerId, true)  // clip to layer below
shapeManager.setRasterLayerClipping(layerId, false) // un-clip

// ── Lock Transparency ──
shapeManager.setRasterLayerLockTransparency(layerId, true)  // lock
shapeManager.setRasterLayerLockTransparency(layerId, false) // unlock

// ── Layer Reorder ──
shapeManager.reorderRasterLayers(['bg_id', 'layer1_id', 'layer2_id'])  // bottom-to-top

// ── Read layer state ──
const layers = shapeManager.getRasterLayers()
// layers[i].blendMode, layers[i].opacity, layers[i].clipped, layers[i].lockTransparency
```

---

## 6. Keyboard Shortcuts (New)

| Shortcut | Action | Notes |
|----------|--------|-------|
| `/` | Toggle lock transparency on active layer | Quick workflow toggle |
| `Alt+Click` layer row | Toggle clipping mask | Matches Photoshop convention |

---

## 7. Common Artist Workflows (for UX reference)

### Shadow/Highlight Workflow
1. Paint flat colors on **Layer 1** (Normal blend, 100% opacity)
2. Add **Layer 2** above, set to **Multiply** blend mode
3. Enable **Clipping Mask** on Layer 2 (clips to Layer 1's silhouette)
4. Paint dark tones on Layer 2 — shadows appear only inside the silhouette
5. Add **Layer 3** above, set to **Screen** or **Add**, clip to Layer 1
6. Paint highlights — glow appears only inside the silhouette

### Atmospheric Lighting
1. Paint scene on base layers (Normal)
2. Add a **Layer** at the top, set to **Add (Glow)**
3. Lower opacity to 40-60%
4. Paint bright warm colors — creates soft light/fire/sunbeam effects

### Color Adjustment
1. Fill a layer with a solid color
2. Set blend mode to **Overlay** at 30-50% opacity
3. Shifts the entire color temperature of layers below (warm/cool tint)

---

## 8. Implementation Priority

1. **Blend mode dropdown** per layer — highest visual impact, enables all pro workflows
2. **Layer opacity slider** — very quick to add, needed for all blend mode workflows
3. **Clipping mask toggle** — critical for character art / silhouette painting
4. **Lock transparency toggle** — important for shading workflows
5. **Layer reorder** (drag & drop or ⬆/⬇ buttons) — needed once users have 3+ layers
6. **Grouped dropdown categories** — nice UX polish for the blend mode picker

---

## 9. Visual Design Notes

- **Blend mode dropdown**: Keep it compact (80-100px wide). Show the mode name only, not the enum number.
- **Opacity slider**: A thin horizontal slider (50-80px) with a percentage label. Can also accept direct number input on click.
- **Clipping indicator**: When clipped, indent the layer row ~16px and show a small `⤵` arrow on the left edge pointing to the layer below. Use a subtle border/line connecting clipped layers.
- **Lock transparency icon**: Use a checkerboard-pattern lock icon (🔒 with a checkerboard background) to visually communicate "transparency is locked".
- **Active layer highlight**: Keep the existing selected-layer highlight, but also dim layers that are invisible (reduced opacity on the row itself).
