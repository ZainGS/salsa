# Frogmarks UI Spec: 3D Ribbon & HTML Banner Panel

Complete integration guide for the ribbon mesh + HTML texture + scroll animation system.
All APIs live on `shapeManager` (the global singleton).

---

## Concepts at a glance

| Concept | What it is | Key API |
|---|---|---|
| **Ribbon** | Flat quad strip that follows a 3D Catmull-Rom spline | `addRibbon3D` |
| **HTML texture** | HTML/CSS string rendered to a GPU texture, applied to any mesh | `setHtmlTexture3D` |
| **Stretch-to-fit** | Scales text to fill the texture exactly, regardless of content length | `stretchToFit` option |
| **Auto-size** | Computes texture dimensions to match the ribbon's arc/width aspect ratio | `computeRibbonTextureSize3D` |
| **Path mode** | Controls how ribbon cross-sections are oriented along the path | `setRibbonPathMode3D` |
| **Segments** | Curve subdivision count — controls smoothness vs. triangle count | `updateRibbonSegments3D` |
| **Double-sided** | Whether both faces render; set false to hide reversed text inside spirals | `setRibbonDoubleSided3D` |
| **Renderer handles** | Emissive sphere meshes at each control point — no HTML overlay | `showRibbonHandles3D` |
| **Scroll animation** | Continuously shifts UVs each real render frame — no timeline needed | `setFrameLinkAnimation3D` |

Ribbons and HTML textures are **independent** — a ribbon can have a plain image texture, and a plane can have an HTML texture.

---

## 1. Create a Ribbon

```ts
const center = shapeManager.getIllustrationCenter3D() ?? [0, 0, 0];
const scale  = shapeManager.getIllustrationMeshDefaultScale3D();
const [cx, cy, cz] = center;

const ribbon = shapeManager.addRibbon3D(
  cx, cy, cz,                    // mesh world-space origin
  [                              // control points (≥ 2)
    { x: cx - scale,       y: cy,               z: cz },
    { x: cx - scale * 0.3, y: cy + scale * 0.3, z: cz },
    { x: cx + scale * 0.3, y: cy + scale * 0.3, z: cz },
    { x: cx + scale,       y: cy,               z: cz },
  ],
  scale * 0.3,   // width in world units
  20,            // curve subdivisions (higher = smoother, more triangles)
);
// ribbon.id — store this, it's the handle for all subsequent calls
```

---

## 2. Read ribbon state (re-opening the panel)

```ts
const data = shapeManager.getRibbonData3D(ribbon.id);
// data: {
//   meshId, controlPoints, width, segments,
//   uvScrollOffset, uvScrollOffsetV, uvEndPadding,
//   pathMode,    // 'normal' | 'world-up' | 'camera-facing'
//   doubleSided  // boolean — false = front face only
// } | null

// null = selected mesh is not a ribbon — hide the path editor section.
const isRibbon = !!shapeManager.getRibbonData3D(selectedMeshId);
```

---

## 3. Shape controls — Width, Segments, Orientation

### Width

```ts
shapeManager.updateRibbonWidth3D(ribbon.id, newWidth);
```

### Segments (smoothness)

The segments buttons (8 / 16 / 32 / 64) must call `updateRibbonSegments3D` — **not** `addRibbon3D`:

```ts
// Called immediately when the user clicks 8 / 16 / 32 / 64:
shapeManager.updateRibbonSegments3D(ribbon.id, 16);
```

Rebuilds geometry immediately and schedules a render.

### Orientation (path mode)

```ts
// Called immediately when the user clicks Normal / Upright / Cam-Face:
shapeManager.setRibbonPathMode3D(ribbon.id, 'normal');
shapeManager.setRibbonPathMode3D(ribbon.id, 'world-up');
shapeManager.setRibbonPathMode3D(ribbon.id, 'camera-facing');
```

The geometry is rebuilt and the canvas re-renders immediately.

> **Seeing the difference:** The change is most obvious on a 3D spiral path with an HTML
> texture. On a near-flat path or a solid-colored ribbon viewed head-on, the modes can look
> similar. Orbit the camera after switching — with `'camera-facing'` the ribbon face always
> tracks you as you orbit; with `'world-up'` it stands like a wall; with `'normal'` it twists
> with the path.

| Mode | Effect |
|---|---|
| `'normal'` | Ribbon lies in the path plane, twisting with curves (default) |
| `'world-up'` | Ribbon stands upright regardless of path direction — like a wall sign |
| `'camera-facing'` | Face always points at the camera — text always readable; geometry rebuilt every frame |

---

## 4. Edit the path

### Replace all control points (bulk upload / presets)

```ts
shapeManager.updateRibbonPath3D(ribbon.id, newControlPoints);
// After a bulk path change, resync handle spheres if they're visible:
shapeManager.syncRibbonHandlePositions3D(ribbon.id);
```

> **Auto-update for path presets:** Call `updateRibbonPath3D` directly on every `input` event
> (slider change, parameter tweak) — do not wait for an "Apply" button. The call is cheap and
> the canvas re-renders immediately.

### Move a single control point

```ts
shapeManager.setRibbonControlPoint3D(ribbon.id, index, newX, newY, newZ);
```

---

## 5. Renderer-side drag handles

Control-point handles are **emissive sphere meshes** rendered directly by the 3D pipeline.
They stay attached to the scene — no HTML overlay to drift when panning or orbiting.

### Show / hide handles

```ts
// Call when the user opens the path editor for a ribbon:
const handleIds = shapeManager.showRibbonHandles3D(ribbon.id);
// handleIds[i] corresponds to ribbon.controlPoints[i]

// Call when the user closes the path editor or selects a different mesh:
shapeManager.hideRibbonHandles3D(ribbon.id);
```

Handle spheres are excluded from scene-graph-changed events, so they won't appear in
Frogmarks' layer list. They are however pickable by the normal 3D pick system.

### Detect a handle click (after any mesh pick)

```ts
const meta = shapeManager.getRibbonHandleMeta3D(pickedMeshId);
if (meta) {
  // meta.ribbonId — the parent ribbon
  // meta.index    — which control point
  activeHandleId = pickedMeshId;
  shapeManager.beginRibbonHandleDrag3D(pickedMeshId, canvas.width, canvas.height);
}
```

### Drag a handle

```ts
// On pointermove while dragging a handle:
shapeManager.moveRibbonHandle3D(
  activeHandleId,
  e.offsetX, e.offsetY,
  canvas.width, canvas.height,
);
// The handle sphere, ribbon control point, and ribbon geometry all update in one call.
// Read the new world position back if you need to update number inputs:
const { controlPoints } = shapeManager.getRibbonData3D(meta.ribbonId)!;
const cp = controlPoints[meta.index]; // { x, y, z }

// On pointerup:
shapeManager.endRibbonHandleDrag3D(activeHandleId);
activeHandleId = null;
```

### Full handle lifecycle pattern

```ts
let activeHandleId: string | null = null;

canvas.addEventListener('pointerdown', async (e) => {
  const hit = await shapeManager.pickMesh3D(e.offsetX, e.offsetY, canvas.width, canvas.height);
  if (!hit) return;

  const meta = shapeManager.getRibbonHandleMeta3D(hit.meshId);
  if (meta) {
    // It's a handle — begin drag, skip normal selection logic
    activeHandleId = hit.meshId;
    canvas.setPointerCapture(e.pointerId);
    shapeManager.beginRibbonHandleDrag3D(hit.meshId, canvas.width, canvas.height);
    e.stopPropagation();
  } else {
    // Normal mesh selection
    shapeManager.selectMesh3D(hit.meshId);
    // If the newly selected mesh has visible handles from the previous ribbon, hide them:
    if (activeRibbonId && activeRibbonId !== hit.meshId) {
      shapeManager.hideRibbonHandles3D(activeRibbonId);
    }
    activeRibbonId = hit.meshId;
    if (shapeManager.getRibbonData3D(hit.meshId)) {
      shapeManager.showRibbonHandles3D(hit.meshId);
    }
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!activeHandleId || !(e.buttons & 1)) return;
  shapeManager.moveRibbonHandle3D(activeHandleId, e.offsetX, e.offsetY, canvas.width, canvas.height);
  // Optionally: update XYZ inputs
  const meta = shapeManager.getRibbonHandleMeta3D(activeHandleId)!;
  const cp = shapeManager.getRibbonData3D(meta.ribbonId)!.controlPoints[meta.index];
  updateXYZInputs(meta.index, cp);
});

canvas.addEventListener('pointerup', (e) => {
  if (activeHandleId) {
    shapeManager.endRibbonHandleDrag3D(activeHandleId);
    activeHandleId = null;
  }
});
```

---

## 6. Apply an HTML texture

### Auto-size (recommended default)

```ts
const quality = 128; // 64 = Compact, 128 = Standard, 256 = High
const size = shapeManager.computeRibbonTextureSize3D(ribbon.id, quality)
          ?? { width: 512, height: 128 };

await shapeManager.setHtmlTexture3D(
  ribbon.id,
  `<div style="
    font: bold 1px sans-serif;
    color: white;
    letter-spacing: 0.08em;
    white-space: nowrap;
    padding: 8px 20px;
    background: linear-gradient(90deg, #0a0a1a, #1a1a4a, #0a0a1a);
  ">★ YOUR TEXT HERE ★ &nbsp;&nbsp; ★ YOUR TEXT HERE ★ &nbsp;&nbsp;</div>`,
  size.width,
  size.height,
  { stretchToFit: true },
);
```

> **Font size tip:** With `stretchToFit: true`, set `font-size: 1px` — the renderer overrides it.

> **Seamless loop tip:** Repeat the text 2–3× with `&nbsp;&nbsp;` so the scroll loops invisibly.

### Background color — use a color picker

Replace the text-input-plus-Update-button with an `<input type="color">` and a **"Transparent" checkbox**:

```ts
// On color picker change (fires on every drag, debounce is fine):
colorPicker.addEventListener('input', async () => {
  await shapeManager.updateHtmlTexture3D(ribbon.id, currentHtml, {
    stretchToFit: true,
    backgroundColor: transparentCheckbox.checked ? 'transparent' : colorPicker.value,
  });
});

// On transparent toggle:
transparentCheckbox.addEventListener('change', async () => {
  await shapeManager.updateHtmlTexture3D(ribbon.id, currentHtml, {
    stretchToFit: true,
    backgroundColor: transparentCheckbox.checked ? 'transparent' : colorPicker.value,
  });
});
```

`backgroundColor` accepts any CSS color string or `'transparent'`. When transparent, the mesh's
diffuse color shows through. Initial state: transparent checkbox unchecked, picker pre-filled
with the color from `getHtmlTextureOptions3D` if available, otherwise `#1a1a2e`.

### Quality presets

| Label | `targetHeight` | GPU memory (1024-wide) |
|---|---|---|
| Compact | 64 | ~256 KB |
| Standard | 128 | ~512 KB |
| High | 256 | ~1 MB |

### Live update (debounce 300 ms on typing)

```ts
await shapeManager.updateHtmlTexture3D(ribbon.id, newHtmlString, { stretchToFit: true });
```

### Remove / check

```ts
shapeManager.removeHtmlTexture3D(ribbon.id);
shapeManager.hasHtmlTexture3D(ribbon.id); // → boolean
```

---

## 7. Scroll animation

```ts
const fps = shapeManager.getAnimationPlayer3D()?.fps ?? 60;
shapeManager.setFrameLinkAnimation3D(ribbon.id, {
  enabled:        true,
  type:           'scroll',
  axis:           'x',    // 'x' = along ribbon (U), 'y' = across width (V)
  amplitude:      1.0,
  framesPerCycle: Math.round(secondsPerLoop * fps),
  phase:          0,
});
```

### Disable / remove

```ts
shapeManager.setFrameLinkAnimation3D(ribbon.id, { enabled: false });
shapeManager.removeFrameLinkAnimation3D(ribbon.id);
```

### Speed conversion

```ts
const framesPerCycle = Math.round(secondsPerLoop * fps);  // store
const secondsPerLoop = framesPerCycle / fps;               // display
```

---

## 8. Scroll seam — what actually works

Repeat the text content 2–3× in the HTML string so the texture tiles seamlessly:

```html
★ HELLO ★ &nbsp;&nbsp;&nbsp; ★ HELLO ★ &nbsp;&nbsp;&nbsp;
```

`setRibbonEndPadding3D` is for static non-scrolling ribbons (adds a tiny mesh overlap at the
ends). Do not expose it in the scroll UI. Valid range 0–0.1; values above 0.1 scramble.

---

## 9. Optional: auto-sync camera

```ts
shapeManager.enableAutoSyncIllustrationCamera3D();
```

---

## 10. Full worked example — scrolling HTML banner (camera-facing spiral)

```ts
// ── Step 1: Create ribbon ────────────────────────────────────────────
const center = shapeManager.getIllustrationCenter3D() ?? [0, 0, 0];
const scale  = shapeManager.getIllustrationMeshDefaultScale3D();
const [cx, cy, cz] = center;

const ribbon = shapeManager.addRibbon3D(
  cx, cy, cz,
  [
    { x: cx - scale,       y: cy,               z: cz },
    { x: cx - scale * 0.3, y: cy + scale * 0.3, z: cz },
    { x: cx + scale * 0.3, y: cy + scale * 0.3, z: cz },
    { x: cx + scale,       y: cy,               z: cz },
  ],
  scale * 0.3,
  20,
);

// ── Step 2: Path mode ────────────────────────────────────────────────
shapeManager.setRibbonPathMode3D(ribbon.id, 'camera-facing');

// ── Step 3: Apply HTML texture ───────────────────────────────────────
const size = shapeManager.computeRibbonTextureSize3D(ribbon.id, 128)
          ?? { width: 512, height: 128 };

await shapeManager.setHtmlTexture3D(ribbon.id, `
  <div style="
    font: bold 1px 'Arial Black', Arial, sans-serif;
    color: #ffffff;
    letter-spacing: 0.12em;
    white-space: nowrap;
    padding: 12px 32px;
    background: linear-gradient(90deg, #0a0a1a 0%, #1a1a4a 50%, #0a0a1a 100%);
  ">★ FROGMARKS 3D ★ &nbsp;&nbsp; ★ FROGMARKS 3D ★ &nbsp;&nbsp;</div>
`, size.width, size.height, { stretchToFit: true });

// ── Step 4: Scroll animation ─────────────────────────────────────────
const fps = shapeManager.getAnimationPlayer3D()?.fps ?? 60;
shapeManager.setFrameLinkAnimation3D(ribbon.id, {
  enabled: true, type: 'scroll', axis: 'x',
  amplitude: 1.0, framesPerCycle: Math.round(2.0 * fps), phase: 0,
});

// ── Step 5: Camera sync ──────────────────────────────────────────────
shapeManager.enableAutoSyncIllustrationCamera3D();
```

---

## 11. Panel layout reference

```
┌──────────────────────────────────────────────────┐
│  3D Ribbon Banner                       [+ New]   │
├──────────────────────────────────────────────────┤
│  SHAPE                                            │
│    Width        [──────────●──────]  0.30         │
│    Segments     [8] [16 ●] [32] [64]              │
│    Orientation  [Normal ●] [Upright] [Cam-Face]   │
│      ↳ hint text changes with selection           │
│    Sides        ● Double  ○ Front only             │
│                                                   │
│  PATH  (Control Points)                           │
│    [●] 0  X [-1.00]  Y [0.00]  Z [0.00]  [×]    │
│    [●] 1  X [ 0.00]  Y [0.30]  Z [0.00]  [×]    │
│    [●] 2  X [ 1.00]  Y [0.00]  Z [0.00]  [×]    │
│                               [+ Add Point]       │
│                            [Upload Path JSON]     │
│                    [Path Presets ▼]  (auto-apply) │
├──────────────────────────────────────────────────┤
│  HTML CONTENT                                     │
│  Quality   [Compact] [Standard ●] [High]          │
│  Stretch   ● Auto-fill  ○ Manual align            │
│  Background  [■ color picker]  ☐ Transparent      │
│  ┌────────────────────────────────────────────┐  │
│  │ <div style="...">★ HELLO ★ …</div>        │  │
│  └────────────────────────────────────────────┘  │
│                                [Apply HTML]       │
├──────────────────────────────────────────────────┤
│  SCROLL ANIMATION                  ● Enabled      │
│    Direction   [Horizontal ▼]                     │
│    Speed       [──────●────────]  2.0 sec/loop    │
│    Amount      [──────────●────]  1.0 UV/loop     │
└──────────────────────────────────────────────────┘
```

---

## 12. Re-opening the panel for an existing ribbon

```ts
const data = shapeManager.getRibbonData3D(selectedId);
const anim = shapeManager.getFrameLinkAnimation3D(selectedId);

// SHAPE section
width         = data.width;
segments      = data.segments;    // set the active button: 8 / 16 / 32 / 64
pathMode      = data.pathMode;    // set the active orientation button
doubleSided   = data.doubleSided; // set the Double / Front-only toggle

// PATH section
controlPoints = data.controlPoints;

// Show renderer-side handles
shapeManager.showRibbonHandles3D(selectedId);

// SCROLL section
if (anim) {
  scrollEnabled  = anim.enabled;
  scrollAxis     = anim.axis;
  scrollAmp      = anim.amplitude;
  secondsPerLoop = anim.framesPerCycle / (shapeManager.getAnimationPlayer3D()?.fps ?? 60);
}

// Is there already an HTML texture?
const hasHtml = shapeManager.hasHtmlTexture3D(selectedId);
```

When the user **deselects** the ribbon or switches to another mesh, call:

```ts
shapeManager.hideRibbonHandles3D(previousRibbonId);
```

---

## 13. API quick-reference

```ts
// ── Ribbon lifecycle ──────────────────────────────────────────────────
shapeManager.addRibbon3D(x, y, z, controlPoints, width, segments?, material?)
shapeManager.getRibbonData3D(meshId)              // → RibbonData | null
shapeManager.updateRibbonPath3D(meshId, controlPoints)
shapeManager.updateRibbonWidth3D(meshId, width)
shapeManager.updateRibbonSegments3D(meshId, segments)  // 8 / 16 / 32 / 64
shapeManager.setRibbonControlPoint3D(meshId, index, x, y, z)
shapeManager.setRibbonEndPadding3D(meshId, uvEndPadding)  // 0–0.1 only
shapeManager.setRibbonPathMode3D(meshId, mode)
  // mode: 'normal' | 'world-up' | 'camera-facing'
shapeManager.setRibbonDoubleSided3D(meshId, doubleSided)
  // false = front face only (no reversed text inside spirals)

// ── Renderer-side handles (replaces HTML overlay) ────────────────────
shapeManager.showRibbonHandles3D(ribbonId, handleRadius?)  // → string[] (IDs)
shapeManager.hideRibbonHandles3D(ribbonId)
shapeManager.getRibbonHandleMeta3D(meshId)   // → { ribbonId, index } | null
shapeManager.beginRibbonHandleDrag3D(handleMeshId, canvasW, canvasH)
shapeManager.moveRibbonHandle3D(handleMeshId, screenX, screenY, canvasW, canvasH)
shapeManager.endRibbonHandleDrag3D(handleMeshId)
shapeManager.syncRibbonHandlePositions3D(ribbonId) // call after updateRibbonPath3D

// ── HTML texture ──────────────────────────────────────────────────────
shapeManager.computeRibbonTextureSize3D(meshId, targetHeight?, maxWidth?)
  // → { width, height } | null
await shapeManager.setHtmlTexture3D(meshId, html, width, height, options?)
  // options: { backgroundColor?, containerStyle?, stretchToFit? }
await shapeManager.updateHtmlTexture3D(meshId, html, options?)
shapeManager.removeHtmlTexture3D(meshId)
shapeManager.hasHtmlTexture3D(meshId)         // → boolean

// ── Scroll animation ──────────────────────────────────────────────────
shapeManager.setFrameLinkAnimation3D(meshId, {
  enabled, type: 'scroll', axis, amplitude, framesPerCycle, phase
})
shapeManager.getFrameLinkAnimation3D(meshId)  // → FrameLinkAnimation3D | null
shapeManager.removeFrameLinkAnimation3D(meshId)

// ── World ↔ Screen projection ─────────────────────────────────────────
shapeManager.projectWorldToScreen3D(x, y, z, canvasW, canvasH)
  // → { x, y, depth } | null
shapeManager.unprojectScreenToWorld3D(screenX, screenY, depth, canvasW, canvasH)
  // → { x, y, z }

// ── Camera / scene ────────────────────────────────────────────────────
shapeManager.getIllustrationCenter3D()             // → [x, y, z] | null
shapeManager.getIllustrationMeshDefaultScale3D()   // → number
shapeManager.enableAutoSyncIllustrationCamera3D()
shapeManager.getAnimationPlayer3D()?.fps
```
