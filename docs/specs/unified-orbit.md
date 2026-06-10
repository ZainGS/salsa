# Unified Orbit — Alt+Left-Drag & View Gizmo for Armature and Edit Mesh
**Status:** Complete (Phases 1–5 implemented in Salsa). No-jump entry fix applied post-implementation.
**Date:** 2026-06-08

---

## Problem

Orbit behavior is inconsistent across the three core modes:

| Mode | Current orbit | Problem |
|------|--------------|---------|
| Scene view | Left-drag = orbit | ✅ Works, expected |
| Armature | Left-drag on empty space = orbit | Works by accident — only because bones are sparse targets. Left-drag on a bone = interact. No explicit orbit gesture. |
| Edit Mesh | No orbit at all | Orbit was disabled entirely to avoid conflicting with vertex/edge/face interactions. Camera is frozen while editing. |

Both Armature and Edit Mesh need a deliberate, unambiguous orbit gesture that doesn't conflict with their left-drag editing interactions. The view gizmo (already present in Armature) should also appear in Edit Mesh for consistency.

---

## Solution

### Alt + left-drag to orbit

Add an `altOrbitOnly` flag to `OrbitController`. When enabled:

- **Alt + left-drag** → orbit (azimuth + elevation)
- **Plain left-drag** → ignored by orbit controller (falls through to the mode's own handlers)
- **Middle / right drag** → pan (unchanged)
- **Scroll wheel** → zoom (unchanged)

This applies to **both Armature and Edit Mesh**. Scene view is unchanged (no `altOrbitOnly` — plain left-drag still orbits there).

### View gizmo in Edit Mesh

The view gizmo (the orientation cube in the corner) is already implemented and shown in Armature mode. It needs to be enabled when entering Edit Mesh mode as well — it gives users a second orbit mechanism (click a face of the cube to snap to that view) without any gesture conflict.

---

## Behaviour changes per mode

### Armature mode

| Gesture | Before | After |
|---------|--------|-------|
| Left-drag on empty space | Orbits | Does nothing (future: box-select bones) |
| Alt + left-drag anywhere | No effect | Orbits |
| Middle / right drag | Pans | Pans (unchanged) |
| Scroll | Zooms | Zooms (unchanged) |
| View gizmo click | Snaps view | Snaps view (unchanged) |

> **Note:** Removing "left-drag on empty space = orbit" is intentional. The empty-space orbit was an accidental side effect of bones being sparse targets — it will be replaced by box-select multi-bone selection in a future phase.

### Edit Mesh mode

| Gesture | Before | After |
|---------|--------|-------|
| Left-drag | Vertex/edge/face interact | Vertex/edge/face interact (unchanged) |
| Alt + left-drag | No effect | Orbits |
| Middle / right drag | Pans (if orbit enabled by Frogmarks) | Pans |
| Scroll | Zooms (if orbit enabled by Frogmarks) | Zooms |
| View gizmo | Not shown | Snaps view |

---

## Engine changes

### 1. `OrbitController` — add `altOrbitOnly` config flag ✅

`OrbitControllerConfig` now has:

```typescript
/** When true, orbit only activates on Alt+left-drag. Plain left-drag is ignored. */
altOrbitOnly?: boolean;
```

`OrbitController` stores `readonly altOrbitOnly: boolean` (readable by Frogmarks if needed). In `handlePointerDown`, plain left-drag returns early when `altOrbitOnly` is set and `e.altKey` is false. Middle/right drag and scroll are unaffected.

---

### 2. `scene3d-manager.ts` — view gizmo control + teardown fix ✅

`_ensureViewGizmo()` now delegates to a public `enableViewGizmo()`. Added:

```typescript
/** Show the view gizmo. Requires orbit controls to be active. No-op if already shown. */
enableViewGizmo(): void

/** Hide the view gizmo and remove its frame callback. */
disableViewGizmo(): void
```

`disableOrbitControls()` now calls `disableViewGizmo()` first — fixing the latent bug where the view gizmo's frame callback was left registered after orbit teardown.

The inline gizmo teardown that was duplicated inside `showBoneOverlay3D(null)` has been removed; it now goes through `disableOrbitControls()` → `disableViewGizmo()`.

Armature mode (`showBoneOverlay3D`) now passes `{ altOrbitOnly: true }` when calling `enableOrbitControls()` internally — this is a Salsa-internal change, no Frogmarks wiring needed.

---

### 3. ShapeManager API additions ✅

```typescript
/** Enable the view gizmo (requires orbit controls to be active). */
sm.enableViewGizmo3D(): void

/** Disable the view gizmo. */
sm.disableViewGizmo3D(): void
```

---

## Frogmarks changes

### Armature mode enter/exit

No Frogmarks changes needed. The `altOrbitOnly: true` flag is now set internally by Salsa when `showBoneOverlay3D` enables orbit, and `disableOrbitControls()` already tears down the view gizmo as of Phase 2.

```typescript
// No change required — Salsa handles altOrbitOnly internally for armature.
```

### Edit Mesh mode enter/exit

No Frogmarks changes needed. `enterMeshEditMode3D` (and its alias `enterEditMode3D`) now internally enables orbit with `altOrbitOnly: true` and shows the view gizmo on success. `exitMeshEditMode3D` / `exitEditMode3D` disables orbit and tears down the gizmo.

```typescript
// No change required — Salsa handles orbit + gizmo inside enterMeshEditMode3D / exitMeshEditMode3D.
```

---

## Future: Box-select in Armature

When box-select for multi-bone selection is added to Armature mode, plain left-drag on empty space will become a box-select drag. This works cleanly with `altOrbitOnly: true` — plain left-drag is free to be claimed for box-select without any orbit conflict.

---

## Implementation phases

| Phase | What | Owner | Status |
|-------|------|-------|--------|
| **1** | Add `altOrbitOnly` to `OrbitController` + `OrbitControllerConfig` | Salsa | ✅ Done |
| **2** | Add `enableViewGizmo()` / `disableViewGizmo()` to `scene3d-manager`; fix `disableOrbitControls` teardown; wire `altOrbitOnly: true` into armature internally | Salsa | ✅ Done |
| **3** | Expose `sm.enableViewGizmo3D()` / `sm.disableViewGizmo3D()` on ShapeManager | Salsa | ✅ Done |
| **4** | Armature: no Frogmarks change needed — Salsa handles `altOrbitOnly` internally | Frogmarks | ✅ N/A |
| **5** | Edit Mesh: wire orbit + gizmo into `enterMeshEditMode3D` / `exitMeshEditMode3D` internally | Salsa | ✅ Done |

---

## Out of scope

- **Box-select in Armature** — deferred; plain left-drag in armature does nothing after this change, ready for box-select to claim it later.
- **Alt+left-drag in scene view** — scene view keeps plain left-drag for orbit; `altOrbitOnly` is only for editing modes.
- **Touch / trackpad gestures** — two-finger pinch/rotate is a separate system; this spec only covers mouse input.
