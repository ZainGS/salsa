# Grease Pencil — Drawing Plane Selection
**Status:** Phases 1–3 complete in Salsa engine; Phase 4 is Frogmarks-side UI wiring  
**Date:** 2026-06-08

---

## Problem

The current GP drawing mode snaps strokes to whichever mesh face is under the pointer at the time of each point addition. This causes:

- The drawing surface to shift mid-stroke as the pointer crosses face boundaries on curved geometry.
- Unpredictable stroke depth over empty space (falls back to a stale NDC depth value).
- No visual feedback for where strokes will land before the user starts drawing.

## Solution: Explicit Face-Selected Drawing Plane

The user explicitly picks one face before drawing. That face's plane is locked as the drawing surface for all subsequent strokes until the user picks again. An offset field pushes the plane slightly above the face to avoid Z-fighting.

---

## Workflow

```
1. Open GP panel, select/create a GP object and layer.
2. "Select Face" mode activates automatically — cursor is an arrow, draw is disabled.
3. Hover the mesh → hovered face edges highlight in white/cyan.
4. Click a face → plane is locked; a translucent quad appears showing the drawing surface.
5. Adjust the Offset field if needed (default 0.003 world units).
6. Click Draw → cursor becomes a crosshair; all strokes land on the locked plane.
7. To move the drawing plane, click a new face at any time (even mid-session).
8. Clicking empty space (no mesh hit) clears the selection.
```

---

## Visual Indicators

### Hovered face highlight
- Thin wireframe overlay on the two triangles of the hovered face.
- Color: white at 60% opacity, 1-pixel line width (same pass as bone gizmo overlay — no depth test).
- Only shown in GP face-select mode, not during active drawing.

### Locked drawing plane
- A translucent quad centered at the face center, extending ±`planeExtent` along the plane's local U/V axes.
- `planeExtent` = 1.5 × the face's world-space bounding radius (so it always extends beyond the face).
- Fill: current GP stroke color at 12% opacity.
- Border: current GP stroke color at 50% opacity.
- A small crosshair (+) at the face center.
- Rendered as a camera-facing-edge-only quad (no depth test, always on top).
- Updates live when the Offset value changes.

---

## Engine Changes

### 1. Add `faceNormal` to `PickResult` (mesh-picker.ts)

```typescript
export interface PickResult {
  mesh:          Mesh3D;
  distance:      number;
  triangleIndex: number;
  hitPoint:      [number, number, number];
  faceNormal:    [number, number, number]; // ← new: world-space flat face normal
  baryU:         number;
  baryV:         number;
}
```

Compute in `intersectMesh()` after the BVH/linear-scan path resolves `hitTri`:

```typescript
// Local-space face normal from cross product of triangle edges
const stride = FLOATS_PER_VERT; // 12
const idx3 = hitTri * 3;
const i0 = idxs[idx3] * stride, i1 = idxs[idx3+1] * stride, i2 = idxs[idx3+2] * stride;
const e1x = verts[i1]   - verts[i0],   e1y = verts[i1+1] - verts[i0+1], e1z = verts[i1+2] - verts[i0+2];
const e2x = verts[i2]   - verts[i0],   e2y = verts[i2+1] - verts[i0+1], e2z = verts[i2+2] - verts[i0+2];
const nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;

// Transform to world space: normal = normalize((M^-T) * localNormal)
// For a mat4 with uniform scale, normalMatrix = modelMatrix (upper-left 3×3).
// Use vec4 transform with w=0 to strip translation.
// Stored in result:
faceNormal: [nx/len in world space, ...]
```

Also update `pickFromClient3D` return type to forward `faceNormal`.

### 2. New state in Scene3DManager

```typescript
// The locked drawing plane
private _gpDrawPlane: {
    point:         [number, number, number]; // world-space face centroid + offset
    normal:        [number, number, number]; // world-space face normal (unit)
    meshId:        string;
    triangleIndex: number;
    faceCenter:    [number, number, number]; // raw face centroid (no offset)
    offset:        number;                   // world units along normal
} | null = null;

// Face under the pointer in face-select mode (for hover highlight)
private _gpHoveredFace: { meshId: string; triangleIndex: number } | null = null;
private _gpFaceSelectActive = false;
private _gpFaceSelectCleanup?: () => void;
```

### 3. New methods in Scene3DManager

```typescript
/** Enter face-select mode: hover shows face highlight, click locks the draw plane. */
enterGpFaceSelectMode(): void

/** Exit face-select mode and remove listeners. Does NOT clear the locked plane. */
exitGpFaceSelectMode(): void

/** Update the offset on the currently locked plane (re-projects the draw point). */
setGpDrawPlaneOffset(offset: number): void

/** Clear the locked draw plane (user must re-select a face before drawing again). */
clearGpDrawPlane(): void

/** Read back the current plane (for UI display). */
getGpDrawPlane(): { meshId: string; triangleIndex: number; offset: number } | null
```

**`enterGpFaceSelectMode` listener logic:**

```typescript
const onMove = (e: PointerEvent) => {
    const hit = this.pickFromClient3D(e.clientX, e.clientY, rect);
    const prev = this._gpHoveredFace;
    this._gpHoveredFace = hit
        ? { meshId: hit.meshId, triangleIndex: hit.triangleIndex }
        : null;
    if (prev?.triangleIndex !== this._gpHoveredFace?.triangleIndex) this.ctx.scheduleRender();
};

const onClick = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const hit = this.pickFromClient3D(e.clientX, e.clientY, rect);
    if (!hit) { this._gpDrawPlane = null; this.ctx.scheduleRender(); return; }
    const offset = this._gpDrawPlane?.offset ?? 0.003;
    const [px, py, pz] = hit.hitPoint;
    const [nx, ny, nz] = hit.faceNormal;
    this._gpDrawPlane = {
        faceCenter:    [px, py, pz],
        point:         [px + nx * offset, py + ny * offset, pz + nz * offset],
        normal:        [nx, ny, nz],
        meshId:        hit.meshId,
        triangleIndex: hit.triangleIndex,
        offset,
    };
    this.ctx.scheduleRender();
};
```

### 4. Update `_gpDrawUnproject` to use the locked plane

Replace the current surface-snap / fixed-depth fallback with a ray-plane intersection:

```typescript
private _gpDrawUnproject(e: PointerEvent, canvas: HTMLCanvasElement): [number, number, number] {
    const rect = canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const sy = (e.clientY - rect.top)  * (canvas.height / rect.height);

    if (this._gpDrawPlane) {
        const ray = this._getRayFromScreen(sx, sy, canvas.width, canvas.height);
        const plane = this._gpDrawPlane;
        const denom = ray.dir[0]*plane.normal[0] + ray.dir[1]*plane.normal[1] + ray.dir[2]*plane.normal[2];
        if (Math.abs(denom) > 1e-6) {
            const dx = plane.point[0] - ray.origin[0];
            const dy = plane.point[1] - ray.origin[1];
            const dz = plane.point[2] - ray.origin[2];
            const t = (dx*plane.normal[0] + dy*plane.normal[1] + dz*plane.normal[2]) / denom;
            if (t > 0) {
                return [
                    ray.origin[0] + ray.dir[0] * t,
                    ray.origin[1] + ray.dir[1] * t,
                    ray.origin[2] + ray.dir[2] * t,
                ];
            }
        }
    }

    // Fallback: no plane selected → unproject at mid-depth
    const w = this.unprojectScreenToWorld3D(sx, sy, 0.5, canvas.width, canvas.height);
    return [w.x, w.y, w.z];
}
```

### 5. Drawing plane visualization (GpRenderer3D or overlay)

A new method `drawGpDrawPlane(plane, hoverFace, color)` called from the WebGPU pre-render or post-render pass:

**Hovered face:**
- Retrieve the two triangle vertex positions for `hoverFace.triangleIndex` from the mesh geometry.
- Draw as a 3-vertex wireframe triangle (line-list) via the existing gizmo line draw pass.
- Color: `vec4(1, 1, 1, 0.6)`.

**Locked plane quad:**
- Compute two orthonormal basis vectors in the plane: `U = normalize(cross(normal, up_or_right))`, `V = cross(normal, U)`.
- Quad corners: `planePoint ± extent*U ± extent*V` where `extent = faceRadius * 1.5`.
- `faceRadius` = max distance from face centroid to any of its 3 vertices.
- Draw as a filled quad (2 triangles) with `color @ 12% opacity` + a border line-list at `50% opacity`.
- Use a depth-ignore pipeline (same as gizmo overlay).

---

## ShapeManager API additions

```typescript
/** Enter face-select mode for GP drawing plane selection. */
sm.enterGpFaceSelectMode3D(): void

/** Exit face-select mode (does not clear the locked plane). */
sm.exitGpFaceSelectMode3D(): void

/** Update the plane offset for the currently locked GP drawing plane. */
sm.setGpDrawPlaneOffset3D(offset: number): void

/** Clear the currently locked GP drawing plane. */
sm.clearGpDrawPlane3D(): void

/** Whether GP face-select mode is currently active. */
sm.isGpFaceSelectMode3D: boolean  // getter
```

---

## Frogmarks Panel Changes

Add a **Drawing Plane** section between the layer list and stroke settings:

```
• DRAWING PLANE

  [ ✦ Click mesh face to set plane ]    ← shown when no face selected
  or
  [ Cube — face 47  ×  ]   Offset [0.003]  ← shown when face locked
                                              (× clears the selection)
```

**Behaviour gating:**
- Draw and Erase buttons are **disabled** (greyed, tooltip "Select a face first") until a drawing plane is locked.
- When face-select mode is active, the "Click mesh face…" chip pulses or shows an active border.
- When the user clicks a face, the chip updates to show the mesh name + triangle index and the offset field appears.
- When the offset field is changed, call `sm.setGpDrawPlaneOffset3D(value)` immediately (live preview).
- When `×` is clicked, call `sm.clearGpDrawPlane3D()` and re-enter face-select mode.

**Mode transitions:**
```
Panel open              → enterGpFaceSelectMode3D()
Face clicked            → [plane locked] → Draw/Erase enabled
Draw button clicked     → exitGpFaceSelectMode3D() + enterGpDrawMode3D(...)
Erase button clicked    → exitGpFaceSelectMode3D() + enterGpDrawMode3D(..., { mode: 'erase' })
Draw/Erase stops (btn)  → exitGpDrawMode3D() + enterGpFaceSelectMode3D()
Panel closed            → exitGpFaceSelectMode3D() + exitGpDrawMode3D()
```

---

## Implementation Phases

| Phase | What | Status |
|-------|------|--------|
| **1 — Core** | `faceNormal` in `PickResult`; `_gpDrawPlane` state; `enterGpFaceSelectMode` + click listener; ray-plane intersection in `_gpDrawUnproject`; ShapeManager API | ✅ Done 2026-06-08 |
| **2 — Hover highlight** | Hovered face wireframe overlay (white, line-list, depth always) | ✅ Done 2026-06-08 |
| **3 — Plane visualization** | Translucent fill quad + border rendered via `GpRenderer3D.drawOverlay()` | ✅ Done 2026-06-08 |
| **4 — Frogmarks UI** | Drawing Plane section, gating of Draw/Erase, offset field, mode transitions | 📋 Frogmarks-side |

Phases 1–3 are fully implemented in Salsa. Phase 4 is Frogmarks-side wiring. See `docs/ui/grease-pencil.md` for the complete API and lifecycle calls.

---

## Out of Scope

- Multiple simultaneous draw planes (one at a time is sufficient).
- Animating the draw plane to follow a bone (stroke `parentJoint` handles that at the stroke level).
- Curved surface drawing (strokes still lie on the flat face plane; true surface-wrapping is a future enhancement).
- Undo/redo for face selection (plane selection is ephemeral tool state, not document state).
