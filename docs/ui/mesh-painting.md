# Frogmarks UI — Mesh Painting Integration
**Last Updated:** 2026-05-10  
**Covers:** Entering paint mode, brush controls, painting on pointer events, undo/redo

All painting logic is in the Salsa engine (`MeshPaintManager`). Frogmarks provides the panel UI and routes pointer events. See [docs/reference/15 §Mesh Painting](../reference/15-3d-rendering-system.md#mesh-painting) for the engine internals.

---

## Prerequisites

The mesh must have valid UV coordinates. This is true for:
- All GLTF/GLB imported models
- All Salsa built-in primitives (box, sphere, plane, cylinder, torus)

---

## Mode Control

```ts
// Enter paint mode (allocates 1024×1024 texture by default)
const ok = sm.enterMeshPaintMode(meshId);
if (!ok) { /* mesh not found */ }

// Enter with a custom texture resolution
sm.enterMeshPaintMode(meshId, 2048);

// Exit — paint result is kept on the mesh permanently
sm.exitMeshPaintMode();
```

On `enterMeshPaintMode`, the mesh's diffuse channel is replaced with the paint texture. Any existing imported texture is temporarily overridden. The paint texture persists on the `Mesh3D` node after exit, and will be shown for the mesh going forward.

---

## Brush Panel Layout

Suggested panel section when paint mode is active:

```
▸ MESH PAINTING ──────────────────────────
  Color    [■ #ff5020]
  Radius   [24 px  ══════●═══]  range 1–256
  Hardness [80%    ══════●═══]  range 0–100%
  Opacity  [100%   ════════●═]  range 0–100%

  [← Undo]  [Redo →]

  [Exit Paint Mode]
```

Wire each control:

```ts
colorPicker.onChange    = (hex) => {
  const [r, g, b] = hexToRgb255(hex);
  sm.setMeshPaintBrushColor(r, g, b, Math.round(opacity * 255));
};
radiusSlider.onChange   = (v)   => sm.setMeshPaintBrushRadius(v);
hardnessSlider.onChange = (v)   => sm.setMeshPaintBrushHardness(v / 100);
// Opacity maps to the alpha channel of the brush color:
opacitySlider.onChange  = (v)   => {
  sm.setMeshPaintBrushColor(currentR, currentG, currentB, Math.round(v / 100 * 255));
};
```

---

## Pointer Event Loop

Paint mode requires Frogmarks to route canvas pointer events through `MeshPicker` and then into `sm.paintMeshDab`:

```ts
const canvas = /* your WebGPU canvas */;
const canvasRect = canvas.getBoundingClientRect();
let isPainting = false;

canvas.addEventListener('pointerdown', (ev) => {
  if (!sm.meshPaint.isActive) return;
  isPainting = true;
  canvas.setPointerCapture(ev.pointerId);
  paintAt(ev);
});

canvas.addEventListener('pointermove', (ev) => {
  if (!isPainting || !sm.meshPaint.isActive) return;
  paintAt(ev);
});

canvas.addEventListener('pointerup', (ev) => {
  if (!isPainting) return;
  isPainting = false;
  sm.endMeshPaintStroke();  // push undo snapshot
  // Update undo/redo button states
  undoBtn.disabled = !sm.canUndoMeshPaint;
  redoBtn.disabled = !sm.canRedoMeshPaint;
});

function paintAt(ev: PointerEvent) {
  const hit = sm.pickFromClient3D(ev.clientX, ev.clientY, canvasRect);
  // Only paint if the hit is on the mesh currently in paint mode
  if (hit && hit.mesh === sm.meshPaint.activeMesh) {
    sm.paintMeshDab(hit);
  }
}
```

**Important:** `sm.pickFromClient3D` is preferred over `sm.pick3D` — it handles DPR scaling automatically.

---

## Undo / Redo

Mesh paint undo is **separate** from the 3D transform undo stack and the raster undo stack. Route Ctrl+Z to the correct stack based on which mode is active:

```ts
document.addEventListener('keydown', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.key !== 'z') return;

  if (sm.meshPaint.isActive) {
    // Paint mode: undo/redo paint strokes
    if (ev.shiftKey) { sm.redoMeshPaint(); }
    else             { sm.undoMeshPaint(); }
  } else if (/* 3D mesh selected */) {
    if (ev.shiftKey) { sm.redo3D(); }
    else             { sm.undo3D(); }
  } else {
    // Raster undo (existing handler)
  }
  ev.preventDefault();
});
```

Undo button wiring:
```ts
undoBtn.disabled = !sm.canUndoMeshPaint;
undoBtn.onclick  = () => { sm.undoMeshPaint(); updateUndoRedoBtns(); };
redoBtn.disabled = !sm.canRedoMeshPaint;
redoBtn.onclick  = () => { sm.redoMeshPaint(); updateUndoRedoBtns(); };
```

---

## Entering / Exiting Paint Mode — UX Flow

Suggested Frogmarks flow:

1. User selects a Mesh3D in the outliner or by clicking
2. A **"Paint Mesh"** button appears in the mesh properties panel
3. Clicking it calls `sm.enterMeshPaintMode(meshId)` and:
   - Hides the transform gizmo (disable orbit/transform controller while painting)
   - Shows the Mesh Painting panel with brush controls
4. While in paint mode, pointer events on the canvas go to `paintAt()` instead of the orbit/pick controller
5. **Exit Paint Mode** button (or pressing Escape) calls `sm.exitMeshPaintMode()` and restores normal interaction

```ts
// Disable transform gizmo during paint
sm.scene3d.disableTransformControls?.();

// Re-enable on exit
sm.scene3d.enableTransformControls?.();
```

---

## Texture Resolution Guidance

| Use case | Recommended texSize |
|----------|-------------------|
| Small props, simple shapes | 512 |
| Character models (default) | 1024 |
| Large detailed models | 2048 |
| High-res hero assets | 4096 (high VRAM) |

Each texel at 1024 ≈ 1mm for a typical character-sized import. Brush radius is in texels.

---

## API Quick Reference

| Method | Description |
|--------|-------------|
| `sm.enterMeshPaintMode(meshId, texSize?)` | Allocate paint texture, set as diffuse |
| `sm.exitMeshPaintMode()` | Exit paint mode, keep result |
| `sm.paintMeshDab(hit: PickResult)` | Stamp brush at hit UV |
| `sm.endMeshPaintStroke()` | Push undo snapshot (call on pointerup) |
| `sm.setMeshPaintBrushColor(r, g, b, a?)` | 0–255 per channel |
| `sm.setMeshPaintBrushRadius(px)` | Brush radius in texels |
| `sm.setMeshPaintBrushHardness(h)` | 0 = feathered, 1 = hard |
| `sm.undoMeshPaint()` / `sm.redoMeshPaint()` | Stroke-level undo/redo |
| `sm.canUndoMeshPaint` / `sm.canRedoMeshPaint` | Boolean getters |
| `sm.meshPaint.isActive` | True when in paint mode |
| `sm.meshPaint.activeMesh` | The `Mesh3D` currently being painted |
