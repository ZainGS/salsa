# 3D Surface Paint + Cursor Link — Design Spec

**Status:** In progress (Phase 1 building)
**Date:** 2026-06-14
**Extends:** the UV-paint feature ([ui/uv-editor.md](../ui/uv-editor.md), `UVPaintController`, `enterUVPaintMode3D`).

---

## 1. Summary

Two tightly-related upgrades to UV paint:

1. **Paint directly on the 3D mesh.** Brush on the model in the 3D viewport and the same texture is painted (so the 3D mesh *and* the UV pane both update live). The natural way to texture.
2. **Bidirectional cursor link.** Show a small ring on the 3D mesh at the point under the UV-pane cursor, and a ring on the UV pane at the point under the 3D cursor — so you always see where the two views correspond.

Both reduce to **one new primitive: a barycentric raycast → UV mapping** (and its inverse). Building #1 gives most of #2 for free.

---

## 2. The core primitive — screen ↔ UV mapping

The mesh picker ([mesh-picker.ts](../../src/renderer/3d/mesh-picker.ts)) already returns, for a screen ray hit on a mesh: `triangleIndex`, barycentric `baryU`/`baryV` (with `w0 = 1 − baryU − baryV` for the first vertex), `hitPoint`, `faceNormal`.

**Screen → UV** (`_screenToMeshUV`): pick the mesh → for `tri = triangleIndex`, read the three vertices' UVs from the compiled geometry (`geometry.vertices`, stride `FLOATS_PER_VERT = 12`, UV at offset `6,7`; indices via `geometry.indices[tri*3 + 0/1/2]`) → interpolate `uv = w0·uv0 + baryU·uv1 + baryV·uv2`. Texel = `uv · textureSize`.

**UV → 3D** (`_uvToMeshPoint`, for the UV→3D ring): given a UV point, scan triangles for the one whose **UV** triangle contains it (point-in-triangle in UV space → barycentric), then interpolate the same triangle's **positions** (offset `0,1,2`) → world point. O(tris) per hover query; fine for typical meshes (cache later if needed).

Both live on `Scene3DManager` (it owns the picker + meshes).

---

## 3. Phase 1 — Paint on the 3D mesh

Paint mode (entered via `enterUVPaintMode3D`) becomes **dual-input**: the UV pane *and* the 3D mesh both drive the same paint session.

- **`UVPaintController`** (refactor): factor the UV-pane handlers into public `strokeBeginUV(u,v,pressure)` / `strokeMoveUV(u,v,pressure)` / `strokeEndUV()`. These map UV→texel, dab the (existing) `RasterPaintEngine`, and `scheduleRender` + throttled readback (so painting from *either* input updates the mesh and the UV pane). The UV-pane pointer handlers call these.
- **`Scene3DManager`** (new): `enterSurfacePaintInput(meshId, { begin, move, end })` attaches capture-phase pointer listeners to the **3D canvas** (mirroring the GP-draw listener pattern). On left-drag: `_screenToMeshUV` → call the handler with `{u,v}` (skip when the ray misses the mesh). Alt-drag (orbit) and middle/right (pan) pass through. `exitSurfacePaintInput()` detaches.
- **`ShapeManager`**: `enterUVPaintMode3D` *also* calls `scene3d.enterSurfacePaintInput(meshId, → controller.stroke*UV)`. `exitUVPaintMode3D` tears both down. No new public API needed for the basic feature; optional `setSurfacePaintEnabled3D(bool)` to let the UI toggle 3D-paint independently.

Result: brush on the cube → strokes land on the texture at the hit UV → mesh updates live (same texture ref) → UV pane updates on readback. Persists via the existing `meshTextures` path.

**Brush radius in 3D:** the brush size is in **texels** (preset min/max). For 3D paint, reuse the controller's current texel diameter (already derived from the UV-pane brush radius). A future refinement is a screen-px → texel estimate from the hit's local UV density, but v1 uses the shared texel size.

---

## 4. Phase 2 — Bidirectional cursor rings

A single "cursor link" state on the controller/session: the current corresponding point in **both** spaces, regardless of which view the pointer is in.

- **3D → UV ring:** on 3D hover (no button), `_screenToMeshUV` → store `session.cursorUV = [u,v]`; `UVCanvasRenderer` draws a ring at that UV. (The 3D side already shows the brush/cursor on the mesh.)
- **UV → 3D ring:** on UV-pane hover, `_uvToMeshPoint(u,v)` → world point → a **3D ring overlay** draws there. Reuse an existing always-on-top overlay path (the GP draw-plane overlay / gizmo line pass draw rings; otherwise add a small billboard-ring overlay).
- Rings clear on `pointerleave` of each view. Keep the existing face cross-highlight as the coarse indicator; the ring is the precise one.

---

## 5. Files

- `src/services/managers/uv-paint-controller.ts` — public `strokeBeginUV/strokeMoveUV/strokeEndUV`; pane handlers call them; (Ph2) `cursorUV` + UV→3D hover hook.
- `src/services/managers/scene3d-manager.ts` — `_screenToMeshUV`, `_uvToMeshPoint`, `enterSurfacePaintInput`/`exitSurfacePaintInput` (3D-canvas listeners), (Ph2) the 3D ring overlay hook.
- `src/services/shape-manager.ts` — wire surface input into `enter/exitUVPaintMode3D`; optional `setSurfacePaintEnabled3D`.
- `src/services/managers/uv-canvas-renderer.ts` — (Ph2) draw the UV-pane cursor ring.
- (Ph2) a 3D ring overlay — reuse GP overlay / gizmo line pass, or a small new billboard.
- `docs/ui/uv-editor.md` — document dual-input paint + the cursor rings.

## 6. Reuse
- `RasterPaintEngine` + per-mesh paint texture + readback (UVPaintController) — unchanged.
- Mesh picker (`triangleIndex` + barycentric) — the whole basis of the mapping.
- GP-draw 3D-canvas listener pattern (`_setupGpDrawListeners`) — template for `enterSurfacePaintInput`.
- Mesh-edit orbit is already alt-only in UV mode, so plain left-drag is free for painting.

## 7. Verification
- `tsc --noEmit` per step; user rebuilds + `ng serve`.
- Paint on the cube in the 3D viewport → strokes appear on the model **and** on the UV pane; save/reload round-trips.
- Paint on the UV pane → still works (unchanged).
- (Ph2) hover UV pane → ring on the mesh; hover the mesh → ring on the UV pane; both track precisely.

## 8. Risks / notes
- **Seam bleeding** at island borders when painting across a 3D edge that maps to two UV islands (unchanged from UV paint; out of scope).
- **UV→3D ring** is O(tris) per hover; fine for modest meshes, cache or spatially index if it bites.
- **Input ownership:** the 3D surface-paint listeners must suppress left-drag mesh-edit selection while active (capture + stopPropagation), but let alt-orbit / pan / wheel pass through — same approach as the UV-pane controller.
