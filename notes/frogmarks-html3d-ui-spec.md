# Frogmarks UI Spec: HTML-in-Canvas 3D & Ribbon Meshes

This document is the integration guide for building Frogmarks UI panels for the
HTML-in-Canvas 3D textures and ribbon mesh features.  All APIs are on
`shapeManager` (the global singleton).

---

## Concepts

| Concept | What it is | ShapeManager API |
|---|---|---|
| **Ribbon mesh** | A flat quad strip that follows a 3D spline path.  Ideal for banners, labels, scrolling text. | `addRibbon3D` / `updateRibbonPath3D` |
| **HTML texture** | Any HTML/CSS rendered to a GPU texture and applied to any 3D mesh. | `setHtmlTexture3D` / `updateHtmlTexture3D` |
| **Scroll animation** | Frame Link `'scroll'` type — drives UV scrolling on ribbons each frame. | `setFrameLinkAnimation3D` with `type:'scroll'` |

Ribbons and HTML textures are **independent** — you can put an HTML texture on a plain
plane, and you can put a regular image texture on a ribbon.  They combine to make a
scrolling HTML banner.

---

## 1. Create a Ribbon Mesh

### UI controls needed
- **Control points list** — draggable XYZ rows, add/remove buttons (min 2 points)
- **Width** — number input (world units; use `getIllustrationMeshDefaultScale3D()` × 0.3 as the default)
- **Segments** — number input or dropdown (8 / 16 / 32 / 64), default 16

### API call

```ts
const ribbon = shapeManager.addRibbon3D(
  cx, cy, cz,            // world-space origin of the mesh node
  [
    { x: -1.0, y: 0.0, z: 0.0 },
    { x:  0.0, y: 0.3, z: 0.0 },
    { x:  1.0, y: 0.0, z: 0.0 },
  ],
  0.3,    // width
  16,     // segments
);
// ribbon.id is the mesh node ID — store it for all subsequent calls
```

### Update path after creation

Whenever the user drags a control point in the viewport or edits the XYZ fields:

```ts
shapeManager.updateRibbonPath3D(ribbon.id, newControlPoints);
```

### Update width

```ts
shapeManager.updateRibbonWidth3D(ribbon.id, newWidth);
```

### Read current ribbon state (for populating UI on re-open)

```ts
const data = shapeManager.getRibbonData3D(ribbon.id);
// data: { meshId, controlPoints, width, segments, uvScrollOffset }
```

---

## 2. Apply an HTML Texture

### UI controls needed
- **HTML editor** — textarea or rich text editor
- **Texture width / height** — number inputs (pixels; typical values: 512×128, 1024×128, 256×64)
- **Background color** — color picker (CSS color string, e.g. `'transparent'`, `'#1a1a2e'`)
- **Apply button** — calls `setHtmlTexture3D`

### First-time apply

```ts
await shapeManager.setHtmlTexture3D(
  meshId,
  `<div style="
    font: bold 64px Impact, sans-serif;
    color: white;
    letter-spacing: 0.1em;
    white-space: nowrap;
    padding: 8px 20px;
  ">HELLO 3D WORLD</div>`,
  512,   // texture width  (pixels)
  128,   // texture height (pixels)
  { backgroundColor: 'transparent' },
);
```

### Live update (user typing in the HTML editor)

Once the texture exists, prefer `updateHtmlTexture3D` — it is faster because it reuses
the `GPUTexture` object:

```ts
await shapeManager.updateHtmlTexture3D(meshId, newHtmlString);
```

### Remove HTML texture

```ts
shapeManager.removeHtmlTexture3D(meshId);
```

### Check if a mesh already has an HTML texture

```ts
const hasHtml = shapeManager.hasHtmlTexture3D(meshId);
```

### Auto-size texture to fit ribbon (recommended default)

Instead of guessing pixel dimensions, call `computeRibbonTextureSize3D` after
creating the ribbon.  It sets the height to a target pixel size and derives
the width from the ribbon's arc-length-to-width aspect ratio so text fills the
ribbon face without distortion.  Both values are rounded to the nearest power of two.

```ts
// Default: 128 px tall, up to 2048 px wide
const size = shapeManager.computeRibbonTextureSize3D(ribbon.id)
          ?? { width: 512, height: 128 };
// size → e.g. { width: 1024, height: 128 } for a typical banner ribbon

// Higher quality (sharper text on large ribbons):
const hiRes = shapeManager.computeRibbonTextureSize3D(ribbon.id, 256, 4096);

await shapeManager.setHtmlTexture3D(ribbon.id, html, size.width, size.height);
```

For Frogmarks UI, use this as the default — no width/height controls needed.
Expose a **Quality** dropdown (`Compact = 64 px tall`, `Standard = 128`, `High = 256`)
if you want to give the user control without exposing raw pixel values.

---

## 3. Scroll Animation

### UI controls needed
- **Enable toggle**
- **Direction** — dropdown: `'Horizontal (U)'` → `axis:'x'`, `'Vertical (V)'` → `axis:'y'`
- **Speed** — slider or number input.  Recommend expressing as **"seconds per loop"**
  and converting: `framesPerCycle = secondsPerLoop × fps`
- **Amount per loop** — `amplitude` field (UV units, default 1.0 = one full texture width per loop)

### Apply scroll animation

```ts
shapeManager.setFrameLinkAnimation3D(meshId, {
  enabled:       true,
  type:          'scroll',
  axis:          'x',     // 'x' = horizontal (along ribbon path)
  amplitude:     1.0,     // scroll 1 full UV unit per framesPerCycle render frames
  framesPerCycle: 60,     // 60 render frames ≈ 1 second at 60 fps
  phase:         0,
});
```

Scroll is driven by a **pre-render callback**, not the timeline — it scrolls
continuously as long as the canvas is rendering, with no need to press Play.
`framesPerCycle` counts real render frames, not timeline frames.

If you also need auto-camera sync, call:

```ts
shapeManager.enableAutoSyncIllustrationCamera3D();
```

### Disable scroll

```ts
shapeManager.setFrameLinkAnimation3D(meshId, { enabled: false });
// or remove entirely:
shapeManager.removeFrameLinkAnimation3D(meshId);
```

### Read current animation state (for populating UI on re-open)

```ts
const anim = shapeManager.getFrameLinkAnimation3D(meshId);
// anim: { enabled, type, axis, amplitude, framesPerCycle, phase } | null
```

---

## 4. Full Worked Example (Banner Panel flow)

This is the full sequence for a user creating a scrolling HTML banner ribbon from scratch:

```ts
// ── Step 1: Create ribbon at canvas center ───────────────────────────
const center = shapeManager.getIllustrationCenter3D() ?? [0, 0, 0];
const scale  = shapeManager.getIllustrationMeshDefaultScale3D();
const [cx, cy, cz] = center;

const ribbon = shapeManager.addRibbon3D(
  cx, cy, cz,
  [
    { x: cx - scale,       y: cy,          z: cz },
    { x: cx - scale * 0.3, y: cy + scale * 0.25, z: cz },
    { x: cx + scale * 0.3, y: cy + scale * 0.25, z: cz },
    { x: cx + scale,       y: cy,          z: cz },
  ],
  scale * 0.3,  // ~30% of default mesh scale = readable height
  20,
);

// ── Step 2: Apply HTML texture (auto-sized to ribbon) ────────────────
const size = shapeManager.computeRibbonTextureSize3D(ribbon.id) ?? { width: 512, height: 128 };
await shapeManager.setHtmlTexture3D(ribbon.id, `
  <div style="
    font: bold 56px 'Arial Black', Arial, sans-serif;
    color: #ffffff;
    text-shadow: 0 0 16px rgba(100,180,255,0.8);
    letter-spacing: 0.12em;
    white-space: nowrap;
    padding: 12px 32px;
    background: linear-gradient(90deg, #0a0a1a 0%, #1a1a4a 50%, #0a0a1a 100%);
  ">★ FROGMARKS 3D ENGINE ★ &nbsp; ★ FROGMARKS 3D ENGINE ★ &nbsp;</div>
`, size.width, size.height);

// ── Step 3: Attach scroll animation ─────────────────────────────────
// Driven by pre-render callback — scrolls continuously, no Play needed.
shapeManager.setFrameLinkAnimation3D(ribbon.id, {
  enabled:        true,
  type:           'scroll',
  axis:           'x',
  amplitude:      1.0,
  framesPerCycle: 90,  // 1.5 seconds at 60 fps
  phase:          0,
});

// ── Step 4: Optional — auto-sync camera ─────────────────────────────
shapeManager.enableAutoSyncIllustrationCamera3D();
```

---

## 5. Suggested UI Panel Layout

```
┌─────────────────────────────────────────────┐
│  3D Banner / Ribbon                    [+ New] │
├─────────────────────────────────────────────┤
│  SHAPE                                        │
│    Width   [──────────●──────]  0.30          │
│    Segments  [8] [16] [32] [64]               │
│                                               │
│  PATH  (Control Points)                       │
│    [0]  X [-1.00]  Y [0.00]  Z [0.00]  [×]   │
│    [1]  X [ 0.00]  Y [0.30]  Z [0.00]  [×]   │
│    [2]  X [ 1.00]  Y [0.00]  Z [0.00]  [×]   │
│                               [+ Add Point]   │
├─────────────────────────────────────────────┤
│  HTML CONTENT                                 │
│  Texture  [512] × [128]  px                   │
│  Background  [transparent ▼]                  │
│  ┌─────────────────────────────────────────┐ │
│  │ <div style="font:bold 48px sans-serif;  │ │
│  │ color:white">Hello 3D!</div>            │ │
│  └─────────────────────────────────────────┘ │
│                            [Apply HTML]        │
├─────────────────────────────────────────────┤
│  SCROLL ANIMATION              ● Enabled      │
│    Direction  [Horizontal (U) ▼]              │
│    Speed      [──────●────────]  1.5 sec/loop │
│    Amount     [──────────●────]  1.0 UV/loop  │
└─────────────────────────────────────────────┘
```

---

## 6. Notes for the UI Implementation

### Re-opening the panel for an existing ribbon

When the user selects a mesh that is a ribbon, populate the panel by reading:
```ts
const ribbon = shapeManager.getRibbonData3D(selectedId);
const anim   = shapeManager.getFrameLinkAnimation3D(selectedId);
const hasHtml = shapeManager.hasHtmlTexture3D(selectedId);
```

If `ribbon` is null, the selected mesh is not a ribbon (it's a plane/box/etc.) — show only the
HTML texture and scroll sections, hide the path editor.

### Detecting a ribbon on selection

```ts
const isRibbon = !!shapeManager.getRibbonData3D(selectedMeshId);
```

### HTML debouncing

The `update()` call on `HtmlTexture3D` triggers an SVG blob + image load + GPU upload.
Debounce the HTML textarea input by ~300 ms before calling `updateHtmlTexture3D` to
avoid hammering the GPU on every keystroke.

### Speed ↔ framesPerCycle conversion

```ts
// UI shows seconds per loop; convert to framesPerCycle for the API
const fps = shapeManager.getAnimationPlayer3D()?.fps ?? 60;
const framesPerCycle = Math.round(secondsPerLoop * fps);
```

### HTML content tips to share with users

- Repeat the text several times with spacing so the loop is seamless: `text &nbsp;&nbsp;&nbsp; text &nbsp;&nbsp;&nbsp;`
- Use `white-space: nowrap` so text never wraps inside the texture
- Match the texture width to the amount of text — wider = higher quality, more GPU memory
- `background: transparent` works; the mesh material's diffuse color shows through transparent areas
- Emoji work: `★ 🎮 🔥 ✨`
