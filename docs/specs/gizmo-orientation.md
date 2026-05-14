# Gizmo Orientation Modes

## Overview

The 3D transform gizmo (move / rotate / scale) supports two orientation modes that control how the handles are aligned relative to the scene and the selected object.

| Mode | Handle direction | Use case |
|---|---|---|
| **World** | Always aligned with world X/Y/Z axes | Consistent reference frame; predictable for grid-aligned scenes |
| **Local** | Rotates with the selected mesh's orientation | Intuitive when working with angled objects (e.g. scaling a tilted mesh along its own face) |

World mode is the default. Users toggle between modes via `ShapeManager.setGizmoOrientation3D('world' | 'local')`.

---

## Behavior by Transform Type

### Move

| Mode | Single-axis (X/Y/Z) | Plane (XY/XZ/YZ) |
|---|---|---|
| World | Drag stays on the world axis | Drag stays in the world-aligned plane |
| Local | Drag stays on the mesh's local axis | Drag stays in the mesh-local plane |

In both modes the drag plane is computed to face the camera as much as possible so the cursor stays on the handle.

### Rotate

| Mode | Rotation axis |
|---|---|
| World | World X/Y/Z (rings are world-aligned) |
| Local | Each mesh's own local X/Y/Z axis (rings rotate with the mesh) |

Rotation is always accumulated as a quaternion delta applied to the initial orientation, so there is no gimbal lock.

### Scale

| Mode | Screen-space projection |
|---|---|
| World | Tip of each handle is projected using world axis direction |
| Local | Tip of each handle is projected using the mesh's local axis direction |

The underlying per-axis scale values (`scaleX/Y/Z`) are unchanged in both modes — they always scale along the mesh's local axes. The difference is only in which screen direction is treated as "dragging toward the tip".

---

## Implementation

### GizmoRenderer (`src/renderer/3d/gizmo-renderer.ts`)

```
orientationMode: 'world' | 'local'  — public field, default 'world'
```

In `drawGizmo` and `hitTest` the gizmo model matrix is built as:

```
translate(center)  →  [rotate(meshRotation) if local]  →  scale(gizmoScale)
```

The rotation is extracted from the first selected mesh's `localMatrix` by normalising its column vectors (strips scale, keeps pure rotation). Because both draw and hit-test use the exact same matrix, picking always matches the visual.

### TransformController3D (`src/services/managers/transform-controller-3d.ts`)

```
orientationMode: 'world' | 'local'  — getter/setter
```

Setting `orientationMode` also forwards the value to `GizmoRenderer.orientationMode`.

At drag start, when `orientationMode === 'local'`, a `localBasis` (`{ x, y, z }: vec3 × 3`) is computed from the first selected mesh's rotation columns and stored in `DragState`. This avoids re-extracting it every frame.

- **`applyMove`** — for single-axis drags projects `delta` onto `localBasis.x/y/z`; for plane drags removes the component along the local normal (`localBasis.z/y/x` respectively). Also passes `localBasis` to `rayPlanePt` so the drag plane is mesh-oriented.
- **`applyScale`** — replaces world-axis `worldDir` with `localBasis.x/y/z` for the screen-space tip projection.
- **`applyRotate`** — sets per-mesh rotation axis to the corresponding local axis column instead of the world axis.

### Scene3DManager (`src/services/managers/scene3d-manager.ts`)

```typescript
setGizmoOrientation(mode: 'world' | 'local'): void
getGizmoOrientation(): 'world' | 'local'
```

### ShapeManager (`src/services/shape-manager.ts`)

```typescript
shapeManager.setGizmoOrientation3D(mode: 'world' | 'local'): void
shapeManager.getGizmoOrientation3D(): 'world' | 'local'
```

---

## UI Integration

The host application (Frogmarks) should expose a toggle button in the toolbar — typically two icons: a globe (World) and a cube/mesh icon (Local). The active mode is highlighted.

Recommended keyboard shortcut: none by default (short-circuit future decision).

The toggle should persist per-document or per-session based on Frogmarks' preferences.

---

## Known Limitations

- When multiple meshes with different orientations are selected, the gizmo aligns to the **first** selected mesh. A future improvement could offer "average orientation" for multi-selection.
- Corner-drag scale (OBB corner handles) always operates in the mesh's own space and is unaffected by this setting.
- Screen-mode (align to screen/camera plane) is a possible third mode but is not implemented.
