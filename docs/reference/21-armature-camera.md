# 21 — Armature & Edit Mesh Camera System
**Last Updated:** 2026-06-08 (rev 5 — direct ortho offset formula replaces incremental zoom/pan sync; box-select suppressed in edit mesh mode)

The armature and edit mesh cameras are specialized viewport modes that replace the illustration camera's pan/zoom-driven positioning with an interactive orbit controller. Both must satisfy two simultaneous constraints that are in direct tension:

1. **Orbit always around the mesh center** — the user should see the mesh spin in place regardless of how far they have panned.
2. **Pan is independent of orbit** — panning moves the mesh's on-screen position, and that position must stay fixed while orbiting.

This document explains why naive approaches fail, the mathematical invariant that makes the working solution possible, the full per-frame data flow, and every field involved.

---

## Files

| File | Role |
|------|------|
| `src/services/managers/scene3d-manager.ts` | Orchestrates armature and edit mesh camera state; contains all fields and the `_orbitUpdateCallback` |
| `src/renderer/3d/camera-3d.ts` | `orthoOffsetX / orthoOffsetY` — shifts the orthographic frustum without moving `target` |
| `src/renderer/3d/orbit-controller.ts` | `OrbitController` — handles pointer events, stores `azimuth / elevation / radius`, provides `applySpherical()`, `syncFromCamera()`, and `pan()` |

---

## The Core Tension

`OrbitController.applySpherical()` computes:
```
camera.position = camera.target + radius × spherical(azimuth, elevation)
```

The **orbit pivot** is always `camera.target`. To orbit around the mesh center `oc`, `target` must equal `oc`. But pan works by moving `target` away from `oc` — so after panning, `target = oc + panOffset`, and all subsequent orbits spin around that drifted point, not the mesh.

### Approaches that don't work

**Approach 1 — Apply panOffset to position only:**  
Set `target = oc`, `position = oc + spherical + panOffset`. The camera no longer looks at `oc` — it looks from `(oc + spherical + panOffset)` toward `oc`, which changes the view direction on every pan. The mesh tilts rather than translating.

**Approach 2 — Apply panOffset to both position and target:**  
Set `target = oc + panOffset`, `position = oc + spherical + panOffset`. View direction is unchanged (`target − position = −spherical`), and the mesh appears panned correctly. But `applySpherical()` now uses `oc + panOffset` as its pivot, so orbit drifts with the pan — back to the original bug.

**Approach 3 — Store panOffset in world-space, re-project each frame:**  
Accumulate the pan as a world-space vec3 `panWorld`. Each frame, project it onto the current `cameraRight / cameraUp` for the ortho offset. This fails because `cameraRight / cameraUp` **rotate** as you orbit, so the same world-space offset projects to different screen positions at different orbit angles. The mesh drifts on screen during orbit.

---

## The Working Solution: Screen-Space Ortho Accumulator

### The mathematical invariant

When `camera.target = oc` (mesh center) and `camera.position = oc + spherical(r, az, el)`, the mesh maps to camera-space coordinates:

```
x_cam(oc) = dot(oc − position, cameraRight)
           = dot(−spherical, cameraRight)
           = 0     ← always, for any azimuth / elevation
```

This is zero because `cameraRight` is always perpendicular to `spherical` — the radius vector is orthogonal to the tangent plane of the sphere. The same holds for Y:

```
y_cam(oc) = dot(−spherical, cameraUp) = 0
```

The orthographic projection maps camera-space X to NDC as:
```
ndcX = (x_cam − orthoOffsetX) / halfWidth
```

Substituting `x_cam = 0`:
```
ndcX_mesh = −orthoOffsetX / halfWidth
```

**This is constant as long as `orthoOffsetX` is constant.** Orbit changes `cameraRight` and `spherical`, but neither appears in the formula. The mesh stays at the same screen position during any orbit as long as the ortho offset doesn't change.

Pan is expressed by *changing* `orthoOffsetX / orthoOffsetY`. The offset is stored in screen-space (orthographic world units aligned with the screen), not world-space, so it never rotates.

---

## Camera3D: orthoOffsetX / orthoOffsetY

**File:** `src/renderer/3d/camera-3d.ts`

Two new fields shift the orthographic frustum bounds symmetrically:

```typescript
private _orthoOffsetX = 0;
private _orthoOffsetY = 0;

get orthoOffsetX() / set orthoOffsetX(v) → markProjDirty()
get orthoOffsetY() / set orthoOffsetY(v) → markProjDirty()
```

Applied in `getProjectionMatrix()`:
```typescript
const hh = this._orthoSize;
const hw = hh * this._aspect;
const ox = this._orthoOffsetX;
const oy = this._orthoOffsetY;
orthoZO(proj, −hw + ox, hw + ox, −hh + oy, hh + oy, near, far)
```

Shifting both bounds by the same value translates the visible window without changing its size or changing what `camera.target` means. The camera still geometrically "looks at" `target` — the offset is purely a projection-level shift.

**Sign convention:** For a positive `orthoOffsetX`, the visible window shifts right, so world objects appear to move *left*. Pan-right produces a negative `orthoOffsetX`, moving the mesh right — matching the orbit controller's drag convention.

---

## Scene3DManager: State Fields

All fields live in `src/services/managers/scene3d-manager.ts` near the other bone overlay state (~line 141).

```typescript
private _armatureOrbitCenter: [number, number, number] | null = null;
private _armatureOrthoX = 0;
private _armatureOrthoY = 0;
```

| Field | Type | Purpose |
|-------|------|---------|
| `_armatureOrbitCenter` | `[x, y, z] \| null` | World-space mesh center captured on armature entry. `camera.target` is reset to this point every frame. `null` when armature mode is inactive. |
| `_armatureOrthoX` | `number` | Cache of the last computed ortho offset X. Recomputed each frame as `cx − oc[0]`. Set as `cam.orthoOffsetX`. |
| `_armatureOrthoY` | `number` | Same for Y. |

---

## Lifecycle

### On armature entry (`showBoneOverlay3D(skeletonId, meshId)`)

The camera is **not moved**. The mesh stays exactly where it was on screen.

```typescript
// 1. Enable orbit (or flip altOrbitOnly flag if controller already exists).
//    OrbitController constructor calls syncFromCamera() — no camera snap.
if (!this._orbitController) {
    this.enableOrbitControls({ altOrbitOnly: true });
} else {
    this._orbitController.altOrbitOnly = true;
}

// 2. Point cam.target at the mesh's world-space bounding-box center.
//    syncFromCamera() re-derives r/az/el from the unchanged camera position.
const meshCenter = this.getMeshCenter(meshId);
cam.setTarget(meshCenter[0], meshCenter[1], meshCenter[2]);
this._orbitController.syncFromCamera();
this._armatureOrbitCenter = [meshCenter[0], meshCenter[1], meshCenter[2]];

// 3. Initialise ortho offset so the mesh appears at the same screen position.
//    Math: the mesh center projects to NDC_x = −orthoOffsetX / hw (by the invariant).
//    The illustration camera places it at NDC_x = (mx − cx) / hw.
//    For equality: orthoOffsetX = cx − mx.
const cx = -panX / (canvasH * zoom);
const cy =  panY / (canvasH * zoom);
this._armatureOrthoX = cx - meshCenter[0];
this._armatureOrthoY = cy - meshCenter[1];
cam.orthoOffsetX = this._armatureOrthoX;
cam.orthoOffsetY = this._armatureOrthoY;
```

The initial ortho offset encodes the mesh's current visual offset from the screen centre. On the next frame, the per-frame callback recomputes it exactly from the same formula.

**Why no `frameMesh` or `setSpherical(0, 0)` anymore:** those calls jumped the camera to a zoom-to-fit front view, which users experienced as the mesh suddenly snapping to a different position and size when entering armature mode. The no-jump entry keeps the mesh where it is; users can use the view gizmo to snap to a canonical view if desired.

### On armature exit (`showBoneOverlay3D(null)` and forced teardown)

```typescript
this._armatureOrbitCenter = null;
this._armatureOrthoX = 0;
this._armatureOrthoY = 0;
cam.orthoOffsetX = 0;
cam.orthoOffsetY = 0;
```

The ortho offset must be reset on exit so the illustration camera (`_applyIllustrationCamera`) takes back full control of the projection. Failing to clear it would shift the 2D viewport by the accumulated pan offset.

---

## Per-Frame Data Flow (`_orbitUpdateCallback`)

This callback is registered as a pre-render callback and fires every frame while orbit controls are active.

```
┌─────────────────────────────────────────────────────────┐
│  _orbitUpdateCallback (fires before each render)        │
│                                                         │
│  1. ctrl.update()                                       │
│     → applies azimuth/elevation damping velocity        │
│     → calls applySpherical() internally (uses           │
│       whatever target currently is — may be stale)      │
│                                                         │
│  2. cam.setTarget(oc)                                   │
│     → locks target back to mesh center                  │
│                                                         │
│  3. ctrl.applySpherical()                               │
│     → position = oc + spherical(r, az_new, el_new)      │
│     → overrides any wrong position from step 1          │
│                                                         │
│  4. Direct ortho offset + zoom (single authority):      │
│     cx = −panX / (canvasH × zoom)                       │
│     cy =  panY / (canvasH × zoom)                       │
│     _armatureOrthoX = cx − oc[0]   ← exact, no drift   │
│     _armatureOrthoY = cy − oc[1]                        │
│     cam.orthoSize   = 1 / zoom                          │
│                                                         │
│  5. cam.orthoOffsetX = _armatureOrthoX                  │
│     cam.orthoOffsetY = _armatureOrthoY                  │
│                                                         │
│  6. Calibrate pan speed:                                │
│     panSpeed = cam.orthoSize / (canvasH × radius)       │
│     → panSpeed × radius = orthoSize/canvasH             │
│     → matches illustration camera's world-units/pixel   │
└─────────────────────────────────────────────────────────┘
```

### Step 4: why the direct formula never drifts

The correct orthoOffset is always `cx − mesh_center_x`, derived from the NDC matching condition. This is recomputed exactly every frame from `_illustrationSync` and `_armatureOrbitCenter` — no accumulation, no scaling.

The earlier incremental approach (zoom-scale × accumulated offset) was mathematically flawed: scaling `_armatureOrthoX *= zoomScale` is equivalent to scaling both `cx` and `mesh_center_x` by the zoom factor, but `mesh_center_x` should not scale. The error is `mesh_center_x × (1 − zoomScale)` per zoom event, growing with mesh displacement from the world origin and with zoom magnitude. The direct formula eliminates this entirely.

### Why step 1's stale applySpherical doesn't matter

`update()` calls `applySpherical()` with whatever `target` currently is. If `pan()` moved target to `oc + delta` (from an orbit-controller middle-drag), step 1 briefly sets `position = (oc + delta) + spherical`. Step 3 immediately overrides this with the correct `position = oc + spherical_new`. No render happens between steps 1 and 3, so the briefly-wrong position is never seen.

---

## OrbitController Interaction

The orbit controller fires four types of events. The armature camera handles each:

| Event | What the controller does | How the callback handles it |
|-------|--------------------------|----------------------------|
| **Left drag (orbit)** with damping | Adds to `_azimuthVel / _elevationVel` (no immediate `applySpherical`) | `update()` applies velocity and calls `applySpherical`. Target = oc (from last frame), so orbit is correct. No pan delta. |
| **Left drag (orbit)** without damping | Updates azimuth/elevation, calls `applySpherical` immediately with current target | Same as above — target is oc from last frame, position correct. |
| **Middle/right drag (pan)** | Moves `camera.target` by `right×(−dx×panScale) + up×(dy×panScale)`, then calls `applySpherical`. On the same canvas element, the 2D illustration pan handler also fires and calls `adjustPan`. | Target reset to oc each frame; orbit-controller delta is discarded. Pan is captured via `_illustrationSync` (step 5) — the 2D illustration pan handler is the single source of truth for both the artboard boundary and the mesh offset. |
| **Scroll (zoom)** | Updates `radius`, calls `applySpherical` immediately | Target = oc, so position = oc + spherical at new radius. `panSpeed` recalibrated on next frame. |

---

## Pan Speed Calibration

The illustration camera maps pan deltas to world coordinates as:
```
worldUnitsPerPixel = orthoSize / canvasH   (= 1 / (canvasH × zoom))
```

The orbit controller maps screen pixels to world units as:
```
actualMovement = panSpeed × radius
```

To match: `panSpeed × radius = orthoSize / canvasH` → `panSpeed = orthoSize / (canvasH × radius)`.

Using `cam.orthoSize` (not `1/zoom` directly) is important: after a zoom change, `cam.orthoSize` is already at the new value when `panSpeed` is calibrated, so orbit-mode pan always matches the current visual scale.

This is recomputed every frame in the callback:
```typescript
if (this._illustrationSync) {
    const { canvasH } = this._illustrationSync;
    const r = Math.max(0.001, this._orbitController.radius);
    this._orbitController.panSpeed =
        this.renderer3D.getCamera().orthoSize / (canvasH * r);
}
```

The `Math.max(0.001, radius)` guard prevents division by zero if radius shrinks to zero during scroll.

---

## Render Loop Maintenance

When `_boneOverlayExplicit` is true, `_applyIllustrationCamera` returns early (orbit owns the camera). This breaks the continuous render loop that `_applyIllustrationCamera` used to maintain by calling `scheduleRender()` every frame.

The loop is kept alive by `syncIllustrationCamera`, which is called every frame by `_autoSyncCallback` with the current 2D pan/zoom:

```typescript
syncIllustrationCamera(...): void {
    if (this._boneOverlayExplicit || this._meshEditOrbitCenter) {
        this._illustrationSync = { panX, panY, zoom, canvasW, canvasH };
        this.ctx.scheduleRender();   // ← keeps the loop alive
        return;
    }
    // ... normal illustration camera path
}
```

`scheduleRender()` triggers the pre-render callbacks (including `_orbitUpdateCallback`), which apply damping, correct target, set the ortho offset, and schedule the next render if there is still momentum. When the user is idle and there is no orbit momentum, `hadMomentum` is false, `scheduleRender` is not called from the orbit callback, and `syncIllustrationCamera` alone drives the loop at whatever rate the 2D canvas ticks.

---

## OrthoSize Authority

`_applyIllustrationCamera` is suppressed while orbit owns the camera. `cam.orthoSize` is driven every frame by `1 / _illustrationSync.zoom` (step 4 of the per-render data flow) — the illustration zoom is the single zoom authority. The orbit controller's `radius` still controls camera distance but has no visual effect in orthographic mode.

Because the no-jump entry never calls `frameMesh()`, the orthoSize is already at `1/zoom` when these modes activate — no explicit restoration is needed. Scroll-wheel zoom works as before: Frogmarks calls `syncIllustrationCamera` with the new zoom, and the per-frame callback drives `cam.orthoSize` accordingly.

---


## Edit Mesh Mode

Edit mesh orbit uses exactly the same system as armature, with a parallel set of fields:

| Armature field | Edit mesh field |
|---------------|-----------------|
| `_armatureOrbitCenter` | `_meshEditOrbitCenter` |
| `_armatureOrthoX/Y` | `_meshEditOrthoX/Y` |
| `_armatureIllustrationCx/Y` | `_meshEditIllustrationCx/Y` |
| guard: `_boneOverlayExplicit` | guard: `_meshEditOrbitCenter !== null` |

Entry is via `enableMeshEditOrbit(meshId)` (called internally from `ShapeManager.enterMeshEditMode3D`). Exit is via `disableMeshEditOrbit()` (called from `exitMeshEditMode3D`). The `_orbitUpdateCallback` has an `else if (_meshEditOrbitCenter)` branch that runs the same per-frame logic as the armature branch.

Edit mesh orbit uses `altOrbitOnly: true` — plain left-drag falls through to vertex/edge/face selection; Alt+left-drag orbits.

`suppressBoxSelect` is set to `true` on `enableMeshEditOrbit` and cleared on `disableMeshEditOrbit`, preventing the 2D interaction service from drawing a drag-selection box during Alt+orbit gestures.

---

## OrbitController Constructor

`OrbitController` now calls `syncFromCamera()` instead of `applySpherical()` when no explicit `radius`, `azimuth`, or `elevation` are given in config. This means creating a controller from the current camera state never moves the camera to a default position — it derives its spherical state from wherever the camera already is.

```typescript
if (config.radius !== undefined || config.azimuth !== undefined || config.elevation !== undefined) {
    this.applySpherical(); // explicit angles: snap to them
} else {
    this.syncFromCamera(); // no explicit angles: read from current camera, no movement
}
```

---

## Failure Mode Reference

This section documents approaches that were implemented, tested, and abandoned during development, to prevent re-implementing them.

### Failed: Moving `camera.target` with pan, resetting in callback

```
End of frame N:  target = oc + panOffset,  position = oc + spherical + panOffset
```

`applySpherical()` uses `target` as its pivot. Even if we reset `target = oc` and call `applySpherical()` in the callback, the controller's internal `orbit()` (fired by left-drag pointer events) also calls `applySpherical()` directly — using the `target = oc + panOffset` value that was set at the end of frame N. The result orbits around `oc + panOffset`, not `oc`.

### Failed: World-space pan accumulator

Store pan as a world-space vec3 `panWorld`. Each frame, project onto current `cameraRight / cameraUp`:
```
orthoOffsetX = dot(panWorld, cameraRight)
```

As azimuth changes, `cameraRight` rotates. `dot(panWorld, cameraRight)` changes with orbit angle. The mesh position on screen changes during orbit — the world-space offset is effectively "rotating" with the camera, making the visible pan shrink/grow as you orbit around.

### Why the direct formula works at all orbit angles

The invariant `x_cam(oc) = 0` holds for any azimuth/elevation. The NDC position of the mesh center is `−orthoOffsetX / hw`, which depends only on `orthoOffsetX` and `orthoSize` — not on camera orientation. So any formula that produces the correct `orthoOffsetX = cx − oc.x` gives the correct screen position regardless of orbit angle.

### Failed: `K × radius` zoom authority

Drive `cam.orthoSize = K × radius` where `K = orthoSize/radius` captured at armature entry. Scroll changes `radius`, and `K` multiplies it back to orthoSize. **Fails** because `K × radius` is independent of `_illustrationSync.zoom`. When the 2D canvas zoom changes (zoom slider, pinch), `radius` doesn't change, so `cam.orthoSize` stays fixed while the canvas artboard grows/shrinks. Replaced by `cam.orthoSize = 1 / _illustrationSync.zoom`.

### Failed: orbit-pan delta accumulation (double-pan bug)

Project the 3D pan delta (`delta_3d = cam.target − oc`) onto `cameraRight / cameraUp` and add it to `_armatureOrthoX/Y` alongside the illustration pan delta. **Fails** because both paths fire on the same middle-drag gesture:

1. The orbit controller's `pan()` contributes `1 × dpix_css × orthoSize / canvasH_physical` to `_armatureOrthoX` via the projected delta.  
2. The 2D illustration pan handler (`WebGPURenderer.handlePointerMove`) fires on the same event at `2 × dpix_css`, updating `_illustrationSync.panX`, which then contributes `2 × dpix_css × orthoSize / canvasH_physical` via `dcx`.  

Total mesh movement: 1× + 2× = 3× per drag pixel. The artboard boundary moves at 2× (illustration only). The mesh moves 1.5× faster than the boundary — a constant visible desync.

Fixed by removing the orbit-pan delta block entirely. The 2D illustration pan handler alone drives `_armatureOrthoX/Y`, so both the boundary and the mesh move at the same 2× rate.

### Failed: `orthoOffsetX = cx` (missing orbit center offset)

Set `cam.orthoOffsetX = cx` directly each frame. **Fails** because the orthoOffset origin is the mesh center (`cam.target = oc`), not the world origin. Setting `orthoOffsetX = cx` shifts the mesh unexpectedly when `oc ≠ (cx, cy)`. The correct formula is `orthoOffsetX = cx − oc.x`.

### Failed: delta-accumulation zoom sync

Scale `_armatureOrthoX *= zoomScale` on each zoom event. **Fails** because `zoomScale` should only apply to the `cx` component, not to `oc.x`. The error is `oc.x × (1 − zoomScale)` per zoom event — grows with mesh displacement from world origin and with zoom magnitude. Replaced by recomputing `cx − oc.x` directly each frame.

### Failed: `frameMesh` + `setSpherical(0, 0)` on mode entry

Calling `frameMesh` re-positions the camera to zoom-to-fit the mesh, then `setSpherical(0, 0)` snaps to front view, then `cam.orthoSize` is restored from illustration zoom. **Fails** (as a UX experience) because users see the mesh jump to a different position and apparent size when entering armature or edit mesh mode. The correct approach is the no-jump entry: compute the mesh center directly from bounds, point `cam.target` at it, call `syncFromCamera()`, and initialise the ortho offset to preserve the mesh's current screen position.
