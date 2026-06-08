# Viewport Snapping — Spec

**Status:** Completed June 2026  
**Files:** `src/services/managers/transform-controller-3d.ts`, `src/services/managers/scene3d-manager.ts`, `src/services/shape-manager.ts`

---

## Goal

Add vertex-to-vertex snapping during gizmo move drags, and expose a persistent snap mode API so Frogmarks can surface a mode selector in the 3D panel.

---

## Scope

| Feature | Status |
|---------|--------|
| Grid snap | Pre-existing (Ctrl+drag with `snapGridSize3D`) |
| Grid snap visual indicator | Via `getSnapTarget3D()` (returns null for grid; badge text uses `snapMode3D`) |
| Vertex snap | **Implemented** |
| Surface snap | **Deferred** — requires ray-mesh BVH/brute-force triangle scan, separate scope |

---

## Design Decisions

**Ctrl = "activate current snap mode."**  
`snapMode3D` is a persistent panel setting (dropdown: none / grid / vertex). Ctrl+drag activates whatever mode is set. No new modifier keys. Matches the pre-existing Ctrl=grid pattern.

**Vertex snap overrides axis constraint.**  
When a snap target is found, the mesh origin moves directly to the snapped vertex — the axis constraint is not applied. This matches Blender's default snap behavior.

**Screen-space threshold (20 px).**  
The snap radius is measured in screen pixels, not world units. Snap sensitivity is consistent at all zoom levels. The search projects both the proposed origin and each candidate vertex to canvas coordinates and checks pixel distance.

**O(V) brute-force scan.**  
For each non-selected mesh: transform each vertex from geometry space to world space (mat4 × vec4), project to screen, check pixel distance against proposed new origin. No spatial index. Fine for typical scenes (< ~100k total verts); spatial hashing can be added later without changing the API.

**`_snapTarget` for vertex snap only.**  
Grid snap does not set `_snapTarget` (grid alignment is visually obvious from position; no dot needed). `getSnapTarget3D()` returns non-null only when vertex snap is actively holding a target during a drag.

**Centroid as snap reference for multi-selection.**  
When multiple meshes are selected, the vertex search uses the centroid of all initial positions + delta as the proposed position. The snap delta is applied uniformly to all selected meshes, preserving their relative positions.

---

## API

```ts
// Persistent snap mode (panel setting)
sm.snapMode3D = 'vertex';           // 'none' | 'grid' | 'vertex'
sm.snapMode3D;                      // current mode

// Snap indicator (read during drag)
sm.getSnapTarget3D()                // [x, y, z] | null — world pos of snap vertex; null when not snapping
sm.worldToScreen3D([x, y, z])       // [canvasX, canvasY] | null — project world pos to canvas pixels
```

---

## Snap Indicator Pattern (Frogmarks)

```typescript
// On pointermove or in the render loop:
const snap = sm.getSnapTarget3D();
if (snap) {
  const scr = sm.worldToScreen3D(snap);
  if (scr) drawSnapDot(overlayCtx, scr[0], scr[1]);
} else {
  clearSnapDot(overlayCtx);
}
```

---

## worldToScreen3D

General-purpose world-to-canvas projection. Also fixes the pre-existing gap where `getDragInfo3D().gizmoCenterWorld` was a vec3 with no screen-space equivalent:

```typescript
// Rotation angle label (previously had no easy screen positioning):
const info = sm.getDragInfo3D();
if (info.gizmoCenterWorld) {
  const [cx, cy] = sm.worldToScreen3D(info.gizmoCenterWorld) ?? [0, 0];
  showAngleLabel(`${info.angleDeg?.toFixed(1)}°`, cx, cy);
}
```

Returns `null` when the point is behind the camera (w < 1e-6) or the canvas is unavailable.

---

## Vertex Scan Algorithm

```
For each non-selected Mesh3D in scene:
  For each vertex i in mesh.geometry.vertices (stride = FLOATS_PER_VERT = 12):
    localPos = [vertices[i], vertices[i+1], vertices[i+2]]
    worldPos = mesh.localMatrix × localPos  (col-major mat4 × vec3)
    screenPos = VP × worldPos → NDC → canvas pixels
    dist = distance(screenPos, proposedOriginScreenPos)
    if dist < 20px and dist < bestDist:
      bestDist = dist; snapTarget = worldPos
```

`mesh.geometry.vertices` is the modifier-evaluated (post-modifier stack) geometry, correctly reflecting any active geometry modifiers.

---

## Snap Mode vs. Ctrl Interaction

| Ctrl held | snapMode3D | Result |
|-----------|-----------|--------|
| No | any | No snap — raw drag delta applied |
| Yes | `'none'` | No snap — raw drag delta applied |
| Yes | `'grid'` | Grid snap (existing behavior): position rounded to `snapGridSize3D` |
| Yes | `'vertex'` + target found | Mesh origin snaps to vertex; `getSnapTarget3D()` returns vertex world pos |
| Yes | `'vertex'` + no target | No snap — raw drag delta applied; `getSnapTarget3D()` returns null |

Snap only applies to move (translate) drags. Rotate and scale drags continue to use angle/factor snapping as before.

---

## Known Limitations

- **Vertex snap only, no surface snap** — the mesh origin snaps to a vertex position, not to the mesh surface. An object placed on terrain will snap to terrain vertices, not interpolated surface points.
- **No backface culling in vertex scan** — vertices behind the visible surface are candidates for snapping. In practice this rarely causes issues since the screen-space proximity check tends to pick forward-facing vertices.
- **No spatial index** — the O(V) scan is fine for scenes with < ~100k total vertices across non-selected meshes. For larger scenes, a spatial hash or BVH would be the next optimization.
- **World-space only** — vertex snap uses world-space vertex positions after the mesh's full local matrix transform, which is the correct behavior for all use cases.
