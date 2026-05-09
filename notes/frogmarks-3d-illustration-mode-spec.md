# Frogmarks — 3D Illustration Mode

## What it is

**3D Illustration mode** is a fixed-camera 3D overlay for the Frogmarks canvas. The user sees 3D meshes sitting on top of the 2D drawing area. The camera always looks straight at the canvas (no orbit). Panning and zooming the canvas moves the 3D objects with it. Users individually transform meshes (translate, rotate, scale) using the gizmo.

This is distinct from a future **3D Scene mode** that would support a dynamic, orbitable camera and independent 3D viewport.

---

## Coordinate System — read this before placing meshes

Salsa's 2D canvas is **Y-down** (origin top-left, Y increases downward). Salsa's 3D renderer is **Y-up** (standard OpenGL convention). The illustration camera compensates for this, but 3D mesh positions do **not** auto-flip.

| If you want a 3D mesh to align with 2D world point… | Place the mesh at 3D coords… |
|------|------|
| (x, y) | (x, −y, z) |

Example: a 2D rect at world (200, 150) should have its 3D counterpart at mesh position (200, −150, z).

For the **depth axis (Z)**: Z=0 is the canvas plane. Positive Z comes toward the viewer. Negative Z goes into the canvas. Most mesh depth (visual layering) lives in the range −50 to +50.

---

## Salsa API — two new methods

Both are on `ShapeManager`:

```typescript
// Call this on every viewport change (pan or zoom)
shapeManager.syncIllustrationCamera3D(panX, panY, zoom, canvasW, canvasH);

// Call when the user toggles projection
shapeManager.setIllustrationProjection3D('perspective' | 'orthographic');
```

`panX` / `panY` — screen-pixel pan offsets (`interactionService.panOffset.x/y`)  
`zoom` — current zoom factor (`interactionService.zoomFactor`)  
`canvasW` / `canvasH` — canvas element pixel dimensions

`setIllustrationProjection3D` re-syncs the camera immediately using the last `syncIllustrationCamera3D` values — you do not need to call both.

---

## Setup sequence (call once on init)

```typescript
// 1. Set up the 3D environment
shapeManager.enableTransformControls();   // click-to-select + gizmos
shapeManager.setIllustrationProjection3D('orthographic');  // default mode

// 2. Initial camera sync
const { panOffset, zoomFactor } = interactionService;
shapeManager.syncIllustrationCamera3D(
  panOffset.x, panOffset.y, zoomFactor,
  canvas.width, canvas.height
);
```

Do **not** call `enableOrbitControls()` in illustration mode — the camera is driven by `syncIllustrationCamera3D`, not the orbit controller.

---

## Subscribing to viewport changes

Frogmarks must call `syncIllustrationCamera3D` every time the user pans or zooms. Subscribe to the interaction service events (or wherever Frogmarks already fires viewport-change callbacks):

```typescript
// Angular example — wherever your pan/zoom handler lives
onViewportChanged(): void {
  const { panOffset, zoomFactor } = this.interactionService;
  this.shapeManager.syncIllustrationCamera3D(
    panOffset.x, panOffset.y, zoomFactor,
    this.canvas.nativeElement.width,
    this.canvas.nativeElement.height
  );
}
```

Also call on canvas resize.

---

## Perspective / Orthographic toggle

Add a toggle button in the 3D panel toolbar:

```
[ Ortho ]  [ Perspective ]   ← segmented control or icon buttons
```

On click:
```typescript
shapeManager.setIllustrationProjection3D(selectedMode);
// No need to re-call syncIllustrationCamera3D — setIllustrationProjection3D does it
```

**Behavior difference visible to users:**
- **Orthographic**: no perspective foreshortening, sizes are pixel-accurate regardless of Z depth. Best for flat illustrations, reference sheets.
- **Perspective**: objects at negative Z appear smaller; gives a sense of depth. Best when the user intentionally layers objects at different depths for a 3D look.

Default: **orthographic** (matches 2D canvas feel).

---

## Mesh depth (Z) explained to users

In the UI, expose Z as a **"Depth"** slider (or input field) in the mesh properties panel. Label it clearly:

```
Depth  [  0  ]   ← 0 = on canvas, + = toward viewer, − = behind canvas
```

Range suggestion: −200 to +200 (matches typical canvas px scale).

---

## 3D Panel UI additions

The existing 3D panel from `frogmarks-3d-scene-ui-spec.md` needs these additions in the **Toolbar** row:

```
[ Ortho | Perspective ]   ← new segmented toggle, right of existing tools
```

No other layout changes are needed. The projection toggle is a global camera setting, not per-mesh.

---

## Things to NOT do

- Do **not** call `enableOrbitControls()` while in illustration mode. It will fight with `syncIllustrationCamera3D`.
- Do **not** call `resetCamera3D()` during illustration mode — it will snap the camera to the default look-at-origin position, breaking the sync.
- Do **not** store projection state only in the UI — store it in a component field so you can pass it back to `setIllustrationProjection3D` after re-init or hot reload.

---

## Relationship to future 3D Scene mode

| | 3D Illustration (now) | 3D Scene (future) |
|---|---|---|
| Camera | Fixed, front-facing | Orbitable, free |
| Pan/zoom sync | Yes | No |
| Projection | Perspective or Ortho toggle | Perspective (primary) |
| Entry point | `syncIllustrationCamera3D` | `enableOrbitControls` |
| Mesh coords | (x, −y, z) to align with 2D | Arbitrary 3D world space |

When the future 3D Scene mode is added, it will be a separate Frogmarks UI mode — the user explicitly switches between them. No Salsa API changes needed; the camera is just driven differently.
