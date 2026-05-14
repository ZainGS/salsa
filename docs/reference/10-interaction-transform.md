# 10 — Interaction & Transform System
**Last Updated:** 2026-04-27  

Salsa handles all user interaction through two connected systems: the `InteractionService` (viewport state + coordinate conversion) and the `WebGPURenderer` (pointer event handling + interaction modes).

---

## InteractionService

**File:** `src/services/interaction-service.ts`

The central state manager for the viewport and selection.

### Viewport State

| Property | Type | Purpose |
|----------|------|---------|
| `zoomFactor` | `number` | Current zoom level (1.0 = 100%) |
| `panOffset` | `{x, y}` | Camera pan offset in world units |
| `worldMatrix` | `mat4` | The view/camera transform matrix |
| `canvas` | `HTMLCanvasElement` | The rendering surface |
| `viewportBounds` | `ViewportBounds` | Cached viewport AABB for frustum culling |
| `lastPointerUV` | `[number, number]` | Normalized cursor position (0–1) |
| `pointerDown` | `boolean` | Whether the mouse button is held |

### World Matrix

The world matrix is the camera transform applied to all geometry:

```
identity
  → translate(panOffset.x, panOffset.y, 0)
  → scale(1/aspectRatio, 1, 1)
  → scale(zoomFactor, zoomFactor, 1)
```

Updated by `updateWorldMatrix()` whenever pan or zoom changes.

### Coordinate Conversion

```typescript
// Screen pixel → world coordinates
toWorldCoords(event: MouseEvent): [number, number]
    1. (event.clientX, event.clientY) → canvas-relative
    2. Canvas-relative → NDC: x ∈ [-1, 1], y ∈ [-1, 1]
    3. NDC → world: inverse(worldMatrix) × vec4(ndcX, ndcY, 0, 1)
    
// Canvas pixel → world coordinates (no event needed)
toWorldCoordsFromCanvas(canvasX: number, canvasY: number): [number, number]
```

### Pan & Zoom

**Zoom (`adjustZoom`):**
- Delta-based (mouse wheel) with zoom-to-cursor
- Computes the world point under the cursor before zoom
- Applies zoom factor change
- Re-centers so the same world point stays under the cursor
- In illustration mode: clamps to illustration bounds

**Pan (`adjustPan`):**
- Translates `panOffset` by (dx, dy) in world units
- In illustration mode: clamps to illustration bounds

### Selection State

```typescript
selectedNodes: Set<Node>              // Currently selected shapes
maxGlobalZIndex: number               // Monotonically increasing for z-ordering

selectNode(node)                      // Add to selection, emit event
deselectNode(node)                    // Remove from selection
toggleNodeSelection(node)             // Toggle with Shift-click
clearSelectedNodes()                  // Deselect all
deselectNodeRecursively(node)         // Deselect node + all descendants (for group drill-out)
```

### Events

The InteractionService uses an `EventEmitter` for:
- `onSelectionChanged` — selection set changed
- `onSceneGraphChanged` — scene graph structure changed
- `onRequestRender` — something changed, schedule a render
- `onBeginInteractive` / `onEndInteractive` — enter/exit continuous rendering mode
- `onRequestBackgroundRender` — low-priority render request

---

## Interaction Modes (in the Renderer)

**File:** `src/renderer/core/webgpu-renderer.ts`

The renderer implements a state machine for pointer interaction:

```
         ┌──────────────────────────────────────────────────────────┐
         │                        idle                              │
         │  • Hover cursor updates (resize/rotate/move icons)      │
         │  • No pointer capture                                    │
         └─────┬───────┬───────┬───────┬───────┬──────┬────────────┘
               │       │       │       │       │      │
     middle   click   click   click   click   click   click on
     mouse    on      on      on      on      empty   line
     button   shape   scale   rotate  line    space   endpoint
               │    handle   handle  endpt     │      │
               ▼       ▼       ▼       ▼       ▼      ▼
           dragging scaling rotating endpt  boxSel  endptDrag
               │       │       │    Drag     │      │
               │       │       │       │     │      │
               └───────┴───────┴───────┴─────┴──────┘
                              pointer up
                                  │
                                  ▼
                                idle
```

### Mode Details

#### Panning

**Trigger:** Middle mouse button or pan tool active.

```
pointerDown → save lastClient position
pointerMove → compute delta = (current - last) in screen pixels
              → convert to world-unit delta
              → interactionService.adjustPan(dx, dy)
              → update lastClient
pointerUp   → idle
```

#### Dragging

**Trigger:** Click on already-selected shape (or click selects it first).

**Data stored:**
```typescript
{
    primary: Node,            // The clicked node
    offsets: Map<Node, Vec2>, // Offset from each selected node to the cursor
    initialPositions: Map<Node, {x, y}>,
    inverseParentMatrices: Map<Node, mat4>, // For converting world delta to parent-local
    groupChildPositions: Map<string, Map<string, {x, y}>>, // For groups
}
```

**Per-frame update:**
```
worldDelta = currentWorldMouse - dragStartWorldMouse

For each selected node:
    parentLocalDelta = inverseParentMatrix × worldDelta
    node.x = initialPos.x + parentLocalDelta.x
    node.y = initialPos.y + parentLocalDelta.y
    node.updateLocalMatrix()
```

The per-node inverse parent matrix ensures correct behavior even when nodes are nested in groups with transforms.

**Section child handling:** When dragging a Section, the renderer compensates its children's positions so they move with the section (even though sections use `transformMode: "translate-only"`).

#### Scaling

**Trigger:** Click on one of 8 scale handles (corners + edges) of a selected shape.

**Handle detection** (`src/renderer/util/handles.ts`):
1. Transform mouse to shape's local space (inverse localMatrix)
2. Compute bounding box corners and edge midpoints in local space
3. Find the closest handle (distance-based, with anisotropic scaling for edge handles)
4. Return the handle ID if within threshold

**Data stored:**
```typescript
{
    side: 'topLeft' | 'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left',
    anchorWorld: [x, y],    // Mouse position at drag start
    initial: {
        x, y,               // Shape center at drag start
        width, height,      // Effective size (baseW × scaleX)
        baseW, baseH,       // Shape._width, Shape._height
        scaleX, scaleY,     // Shape.scaleX, Shape.scaleY
    },
    prevCenter: [x, y],     // For Section child compensation
}
```

**Per-frame update:**
```
1. Decompose mouse movement into rotation-aligned axes:
   alongW =  (deltaX × cos(rot) + deltaY × sin(rot))
   alongH = (-deltaX × sin(rot) + deltaY × cos(rot))

2. Based on side, compute new dimensions:
   - right:       newW = initial.width + alongW
   - left:        newW = initial.width - alongW
   - top:         newH = initial.height + alongH
   - bottom:      newH = initial.height - alongH
   - corners:     both newW and newH change

3. Apply:
   - Groups: shape.scaleX = newW / initial.baseW  (ratio)
   - Others: shape.scaleX = max(0.05, newW)        (absolute)

4. Compute center shift for edge/corner scaling:
   dxCenter = shift * cos(rot) + shift * sin(rot)
   shape.x = initial.x + dxCenter
```

**Why the difference between Group and non-Group scaling:**
- Groups need ratio-based scaling so children scale proportionally
- Non-Group shapes (incl. LiveTextNode with `_width = 1`) use absolute scaleX/scaleY as effective size

#### Rotation

**Trigger:** Click near the rotation handle (top of bounding box, slightly outside).

**Detection** (`handles.ts → isNearRotationHandle()`):
- Transforms mouse to local space
- Checks if mouse is within threshold of the shape's top-center + handle offset

**Per-frame update:**
```
currentAngle = atan2(mouseY - shape.y, mouseX - shape.x)
deltaAngle = currentAngle - initialMouseAngle
shape.rotation = initialRotation + deltaAngle
```

#### Endpoint Dragging

**Trigger:** Click on either endpoint of a Line shape.

```
pointerMove → update line.x1/y1 or line.x2/y2 to cursor position
pointerUp   → check for connector port snap:
              - Find all shapes near the endpoint
              - If a shape has a connection port within threshold:
                  line.startBinding = { shapeId, portId }
              - Else: clear binding
```

#### Box Selection

**Trigger:** Click on empty space (no shape under cursor).

```
pointerDown → record start position
pointerMove → compute rectangle [start → current]
              → interactionService.boxSelectPreview = rectangle
              → selectionService.boxSelect(rectPolygon) — SAT intersection
pointerUp   → selectedNodes = intersected shapes
              → clear preview
```

Box selection uses `polygonsIntersect()` (Separating Axis Theorem) to test each shape's world-space bounding polygon against the selection rectangle.

---

## Hit Testing

**File:** `src/services/selection-service.ts`

### `findFirstNodeUnderMouse(worldX, worldY)`

1. Walk the scene graph tree in **reverse z-order** (deepest, highest-z first)
2. For each visible, non-locked shape: call `shape.containsPoint(worldX, worldY)`
3. Return the first hit

### `containsPoint(x, y)` — per shape

Each shape implements this differently:

| Shape | Method |
|-------|--------|
| Rectangle, Section | Transform to local space (inverse localMatrix), check ±halfW/halfH |
| Circle | Distance from center ≤ radius |
| Triangle | Barycentric coordinates |
| Group | AABB check on group bounds |
| LiveTextNode | Transform to local space, check ±0.5 (unit quad) |
| Scribble | Not hit-testable (uses bounding box only) |

---

## Frustum Culling

**File:** `src/renderer/util/viewport-bounds.ts`

Before rendering, shapes that are entirely outside the viewport are marked `visible = false`.

`ViewportBounds` caches the viewport's world-space AABB and uses two strategies:

1. **Regular shapes** (Rectangle, Circle, etc.): AABB overlap test between shape bounding box and viewport
2. **Control-point shapes** (Scribble, Highlight, Line, Pattern): Check if any control point or line segment intersects the viewport

The cache is invalidated on pan/zoom via `markDirty()`. `updateVisibility()` batch-processes the entire node array.
