# 01 — Scene Graph & Node System
**Last Updated:** 2026-04-27  

The scene graph is the backbone of Salsa's data model. Every shape, group, and text element lives in a tree of `Node` objects rooted at a single `SceneGraph` instance.

---

## SceneGraph

**File:** `src/scene-graph/core/scene-graph.ts`

The `SceneGraph` class is a thin wrapper around a root `Node`:

```
SceneGraph
├── root: Node (always exists, never rendered directly)
│   ├── child 0 (e.g., Rectangle)
│   ├── child 1 (e.g., Scribble)
│   ├── child 2 (e.g., Group)
│   │   ├── child 0 (e.g., Circle)
│   │   └── child 1 (e.g., SDFText)
│   └── ...
```

**Key features:**
- **O(1) node lookup:** `findNodeById(id)` uses an internal `Map<string, Node>` keyed by `Shape.id`. Falls back to a tree walk if the map misses.
- **Registration:** `registerNode(node)` / `unregisterNode(node)` maintain the map.
- **Serialization:** `toJSON()` recursively serializes the tree via `root.toJSON()`.

The scene graph itself has **no traversal methods**. All traversal is done through `Node.forEachDeep()`.

---

## Node — The Base Class

**File:** `src/scene-graph/shapes/base/node.ts`

`Node` is the minimal unit of the scene tree. It stores transforms and parent-child relationships but has **no visual representation**.

### Properties

| Property | Type | Default | Purpose |
|----------|------|---------|---------|
| `_x` | `number` | `0` | Position X (world units) |
| `_y` | `number` | `0` | Position Y (world units) |
| `_scaleX` | `number` | `1` | Horizontal scale |
| `_scaleY` | `number` | `1` | Vertical scale |
| `_rotation` | `number` | `0` | Rotation in radians |
| `_zIndex` | `number` | `0` | Draw order (ascending) |
| `_name` | `string` | `""` | Display name (for object list) |
| `visible` | `boolean` | `true` | Whether the node renders |
| `locked` | `boolean` | `false` | Whether the node is selectable/draggable |
| `children` | `Node[]` | `[]` | Child nodes |
| `parent` | `Node \| null` | `null` | Back-pointer to parent |
| `renderBelowRaster` | `boolean` | `false` | If true, renders below raster layers (used by PanelLayout) |
| `transformMode` | `"inherit" \| "translate-only"` | `"inherit"` | Controls how the parent chain matrix propagates |

### Transform System

Every node has a **local transform** defined by (x, y, rotation, scaleX, scaleY). This is combined with the parent's transform to compute the node's world-space position.

**Two matrices:**

1. **`_localMatrix` (mat4):** The node's own transform. Computed by `Shape.updateLocalMatrix()`:
   ```
   identity → translate(x, y, 0) → rotateZ(rotation) → scale(scaleX, scaleY, 1)
   ```

2. **`parentChainMatrix` (mat4):** The accumulated transform from the root down to this node's parent. Computed lazily by walking up the ancestor chain and multiplying each ancestor's `_localMatrix`.

The **world-space transform** (`localMatrix` getter) is:
```
localMatrix = parentChainMatrix × _localMatrix
```

**Dirty propagation:**
- Setting `x`, `y`, `scaleX`, `scaleY`, or `rotation` on a node calls `updateLocalMatrix()` (rebuilds `_localMatrix`) and `markChildrenParentChainDirty()` (invalidates every descendant's cached `parentChainMatrix`).
- The `parentChainMatrix` is recomputed on demand when accessed if dirty.
- This lazy invalidation avoids redundant matrix multiplications when multiple properties change in sequence.

### Parent-Child Relationships

```typescript
node.addChild(child)    // Sets child.parent, pushes to children[], invalidates transforms
node.removeChild(child) // Searches recursively, nulls parent
```

Children are maintained in array order. The `zIndex` setter calls `parent.sortChildrenByZIndex()` to re-sort siblings by ascending `zIndex`.

### Traversal

```typescript
node.forEachDeep(callback)  // Depth-first: visits self, then each child recursively
```

This is the primary traversal method used throughout Salsa.

### `isRenderBelowRaster()`

Walks up the parent chain and returns `true` if any ancestor has `renderBelowRaster = true`. Used to split the render list into pre-raster and post-raster groups.

---

## Shape — The Renderable Base

**File:** `src/scene-graph/shapes/base/shape.ts`

`Shape` extends `Node` and adds everything needed for rendering: geometry, colors, bounding boxes, and an ID system.

### Properties

| Property | Type | Purpose |
|----------|------|---------|
| `_id` | `string` | UUID (lazy `crypto.randomUUID()`) |
| `_width` | `number` | Shape width in local units |
| `_height` | `number` | Shape height in local units |
| `_fillColor` | `RGBA` | Fill color |
| `_strokeColor` | `RGBA` | Stroke/outline color |
| `_strokeWidth` | `number` | Stroke thickness |
| `_localMatrix` | `mat4` | Local transform (translate × rotate × scale) |
| `_localMatrixVersion` | `number` | Monotonically increasing, bumped on every updateLocalMatrix() |
| `_boundingBox` | `BoundingBox` | Axis-aligned bounding box |
| `_previousBoundingBox` | `BoundingBox` | For dirty-rect tracking |
| `_isSelected` | `boolean` | Selection state |
| `isPreview` | `boolean` | Shape is being previewed (e.g., shape tool cursor) |
| `isStaging` | `boolean` | Shape is in-progress (e.g., stroke being drawn) |
| `wasCommitted` | `boolean` | Staging is finished, ready for cache commit |
| `cachedVertices` | `Float32Array?` | CPU-side vertex cache |
| `cachedIndices` | `Uint16Array?` | CPU-side index cache |

### Abstract Methods (must be implemented by every shape)

```typescript
getType(): string                         // e.g., "Rectangle", "Scribble", "LiveText"
getScaleFactors(): [number, number]       // Scale factors for geometry (see note)
getGeometryVertices(): Float32Array | null // CPU-side vertex data
getGeometryIndices(): Uint16Array | null  // CPU-side index data
```

> **Note on `getScaleFactors()`:** This method is called in `updateLocalMatrix()` but **its return value is currently unused** — `mat4.scale` always uses `this.scaleX` / `this.scaleY` directly. It exists as an override point but is effectively dead code.

### Bounding Box System

The bounding box is an axis-aligned rectangle in **local space** (centered at origin):

```typescript
calculateBoundingBox() {
    const halfWidth = this.width / 2;
    const halfHeight = this.height / 2;
    this.boundingBox.x = this.x - halfWidth;
    this.boundingBox.y = this.y - halfHeight;
    this.boundingBox.width = this.width;
    this.boundingBox.height = this.height;
}
```

Some shapes (LiveTextNode) override this to set `vertices` instead, which provides per-corner coordinates for more precise hit-testing.

**World-space bounding polygon:**
```typescript
getWorldSpaceBoundingBoxPolygon(): [number, number][]
// Transforms the 4 local-space corners by the full localMatrix (parent chain + own transform)
// Returns a quadrilateral that accounts for rotation and non-uniform scaling
```

This is used for:
- **Frustum culling** — `ViewportBounds` checks if the polygon overlaps the viewport
- **Box selection** — `SelectionService.boxSelect()` uses `polygonsIntersect()` (SAT)
- **Group bounds** — `Group.recalculateSize()` unions all children's world polygons

### Selection Guard

```typescript
static selectionGuard: (() => boolean) | null
```

A global function that prevents selection while drawing tools are active. When set, `select()` checks this guard before allowing selection.

### Dirty / Rerender Flow

1. Something changes on the shape (text, color, transform)
2. `markDirty()` is called → clears cached vertices → calls `triggerRerender()`
3. `triggerRerender()` saves previous bounding box, recalculates current, sets `isDirty = true`
4. During `beginFrame()`, the render strategy checks `isDirty` and re-uploads geometry/uniforms
5. After uploading, `isDirty` is set to `false`

---

## Group

**File:** `src/scene-graph/shapes/base/group.ts`

Groups are `Shape` subclasses that contain children but have **no geometry of their own**.

| Property | Type | Purpose |
|----------|------|---------|
| `clipChildren` | `boolean` | Clip children to group bounds (stencil-based) |
| `drawBackground` | `boolean` | Draw a filled rectangle behind children |
| `backgroundColor` | `RGBA` | Background fill color |

### `recalculateSize()`

The most complex method in the group system. When children move or resize:

1. Computes world-space AABB from all children's bounding polygons
2. Converts the AABB center to parent-local space (inverse parent chain matrix)
3. Computes the offset between old center and new center
4. Adjusts every child's (x, y) in group-local space so they stay visually fixed
5. Updates `width`/`height` from the parent-local AABB

This ensures that when a group's children change, the group's bounds shrink/grow to fit, but the children don't visually jump.

---

## Z-Ordering

Salsa uses a simple z-index system:

1. Every `Node` has a `zIndex` (default 0)
2. Setting `zIndex` triggers `parent.sortChildrenByZIndex()` (ascending sort)
3. `InteractionService` maintains a `maxGlobalZIndex` counter, incremented for every new shape
4. The renderer flattens the tree into a `renderList` sorted by zIndex for draw order
5. Hit-testing walks in **reverse** z-order (top-most shape first)

---

## Serialization

Every node serializes recursively:

```typescript
// Node.toJSON()
{ name, x, y, scaleX, scaleY, rotation, zIndex, visible, locked, children: [...] }

// Shape.toJSON() (extends Node)
{ id, type, fillColor, strokeColor, strokeWidth, width, height, ...Node.toJSON() }

// Subclass.toJSON() (extends Shape)
{ ...Shape.toJSON(), <subclass-specific fields> }
```

Deserialization flows through `ShapeManager.recreateNode(data)`, which switches on `data.type` to reconstruct the correct class. See the [Services & Managers](11-services-managers.md) doc for details.
