# Remaining Fixes Spec — Salsa Engine

Prioritized by impact. Each section includes the problem, affected files, root cause, and the fix plan.

---

## 1. Polygon Shape — Geometry Stubs

**Priority:** 🔴 High — broken shape type, silently never renders

### Problem

`Polygon.getGeometryVertices()` returns an empty `Float32Array` and `getGeometryIndices()` returns `null`. The bounding box is computed correctly (from the points array), but the GPU gets zero triangles.

### Files

| File | Lines | Issue |
|------|-------|-------|
| `src/scene-graph/shapes/polygon.ts` | ~L80 | `getGeometryVertices()` returns `new Float32Array()` with `// TODO` |
| `src/scene-graph/shapes/polygon.ts` | ~L84 | `getGeometryIndices()` returns `null` with `// TODO` |

### Fix Plan

1. **Triangulate** the polygon's `points[]` array using ear-clipping (the polygon is simple/convex in most cases, so a basic fan works too).
2. **`getGeometryVertices()`** — emit interleaved `[x, y]` pairs for each triangle vertex in the same coordinate space as other shapes (local/world depending on the pipeline).
3. **`getGeometryIndices()`** — emit a `Uint16Array` of triangle indices.
4. For concave polygons, use the `earcut` algorithm (a single-file library, or inline a 50-line implementation).
5. Verify the polygon renders through the existing `shapePipeline` (it should — same vertex layout as Rectangle).

### Complexity

Small — ~40 lines of triangulation code.

---

## ~~2. Pattern Draw Pass — Commented Out~~

**Status:** ✅ Not an issue — Pattern rendering works via the current draw path. The commented-out block is legacy code from an earlier indirect-draw approach that was replaced. Can be deleted for cleanliness but is not a bug.

---

## 3. TransformController — Orphaned Code

**Priority:** 🟡 Medium — working duplicate logic exists, but this is cleaner

### Problem

`TransformController` is a fully-implemented class (143 lines) with hit-test, cursor mapping, move/rotate/scale lifecycle methods (`begin → update → end`). But it's never instantiated — the renderer's `handlePointerDown/Move/Up` implements the same logic inline (spread across ~500 lines).

### Files

| File | Lines | Issue |
|------|-------|-------|
| `src/services/transform-controller.ts` | 1–143 | Complete but unused |
| `src/renderer/core/webgpu-renderer.ts` | ~L760–1560 | Inline drag/rotate/scale duplicates what TransformController does |

### Fix Plan (two options)

**Option A — Wire it in (recommended if refactoring pointer loop):**

1. Instantiate `TransformController` in the renderer constructor.
2. In `handlePointerDown`, replace the inline hit-test + mode-setting with `tc.hitTest()` → `tc.begin()`.
3. In `handlePointerMove`, replace the inline drag/rotate/scale math with `tc.update(worldPos)`.
4. In `handlePointerUp`, call `tc.end()`.
5. Remove the ~500 lines of inline transform logic.

**Option B — Delete it:**

If the inline logic has diverged significantly (Section children, Group baking, etc.), delete `transform-controller.ts` to reduce confusion.

### Complexity

Medium-large for Option A (refactor pointer loop). Trivial for Option B (delete one file).

### Recommendation

Compare the TransformController's logic against the inline code. If the inline code handles Section-child-fixup, Group-scale-baking, and multi-selection that the controller doesn't, **Option B** is safer. If they're equivalent, **Option A** is the cleaner architecture.

---

## 4. GPU Cache Leak on Shape Delete

**Priority:** 🟡 Medium — memory leak over time, especially in long sessions

### Problem

`deleteSelectedShapes()` removes shapes from the scene graph but never removes their GPU resources (geometry buffers, uniform cache entries, texture atlas slots) from `CacheService`.

### Files

| File | Lines | Issue |
|------|-------|-------|
| `src/services/shape-manager.ts` | ~L1455 | `// TODO: Remove from Cache also` before `deleteSelectedShapes()` |
| `src/services/cache-service.ts` | — | No `removeShape()` method exists |

### Fix Plan

1. **Add `removeShape(node: Node)` to CacheService** that:
   - Removes from `shapeUniformCache` (by shape ID or instance)
   - Removes from `strokeUniformCache` / `lineUniformCache` / `highlightUniformCache` (based on shape type)
   - Removes from `sdfTextUniformCache`
   - Removes geometry from the relevant geometry cache (`shapeGeometryCache`, `strokeGeometryCache`, etc.)
   - Releases texture atlas layers if the shape held a texture reference
   - Removes bounding box entries from `boundingBoxUniformCache`
2. **Call `this.cacheService.removeShape(node)`** inside `deleteSelectedShapes()` before removing from scene graph.
3. **Also call on undo (undelete)** — if undo re-adds a shape, it will need to re-register with caches. But that already happens via `markDirty()` on re-add, so just cleaning up on delete is sufficient.

### Complexity

Medium — each cache type needs a removal method. The main risk is getting the shape-type → cache mapping right.

---

## 5. Raster Selection Union/Subtract Modes

**Priority:** 🟡 Medium — needed for real selection workflows but raster selection still works for basic use

### Problem

`SelectionMode` is defined as `'new' | 'add' | 'subtract'` but only `'new'` is implemented. The mode is never branched on in the selection-creation logic.

### Files

| File | Lines | Issue |
|------|-------|-------|
| `src/renderer/raster/selection/raster-selection-engine.ts` | ~L17 | `export type SelectionMode = 'new' \| 'add' \| 'subtract'; // for future use` |
| `src/renderer/raster/selection/raster-selection-engine.ts` | — | Selection creation methods ignore the mode parameter |

### Fix Plan

1. **In the selection-creation method** (wherever the mask texture is written):
   - `'new'` → Clear mask, then write new selection (current behavior)
   - `'add'` → Don't clear mask. Render new selection with `max(existing, new)` blend.
   - `'subtract'` → Render new selection as `existing * (1 - new)` — multiply the mask by the inverse of the new region.
2. **Blend modes on the GPU** — use a compute pass or a render pass with custom blend state:
   - `add`: `blendOp: max`, or write `max(old, new)` in a compute shader
   - `subtract`: multiply pass → `old.a * (1.0 - new.a)`
3. **Expose the mode** through `RasterSelectionService` → `ShapeManager` so Frogmarks can offer Shift+click = add, Alt+click = subtract.

### Complexity

Medium — the GPU mask composition is the main work. The API surface is small.

---

## 6. Depth Buffer TODO

**Priority:** 🟢 Low — affects edge cases with overlapping shapes at same z-index

### Problem

`getZDepthFor(zIndex)` in the render strategy has a TODO flag. The fallback path (when all shapes share the same zIndex) uses `0.5 - (zIndex * 0.001)` which can produce identical depths, causing z-fighting. The normalization also depends on `_zMin` / `_zMax` being updated correctly each frame.

### Files

| File | Lines | Issue |
|------|-------|-------|
| `src/renderer/render-strategies/webgpu-render-strategy.ts` | ~L302 | `//TODO: Get depth buffering to work....` |

### Fix Plan

1. **Replace the zIndex-based approach** with a simple draw-order counter:
   - Assign depth `= 1.0 - (drawIndex / totalShapeCount)` during the render list build.
   - This guarantees unique depths and correct painter's-algorithm ordering.
2. **Alternatively**, set `depthCompare: 'always'` and rely purely on draw order (which the renderer already does). Remove the depth logic entirely — it's a vestige of an earlier attempt.
3. The current `depthWriteEnabled: false, depthCompare: 'always'` on all overlay pipelines (carets, selection highlights, dots) already ignores depth. The main shape pipelines may not actually use depth either. **Audit whether depth is read/written on any pipeline** before investing in fixing the depth calculation.

### Complexity

Small — likely just removing dead code if no pipeline actually reads depth.

---

## 7. Bounding Box Hacks

**Priority:** 🟢 Low — visual artifact, not a crash, affects selection/hit-test accuracy

### 7a — Highlight Magic `* 12` Constant

**Files:** `src/scene-graph/shapes/highlight.ts` ~L251

```ts
// TODO: fix this... this random 12 makes it close
const strokeExpansion = this.strokeWidth * 12 * 0.035;
```

**Root Cause:** The `strokeWidth` is in a different coordinate space than the bounding box. The `* 12 * 0.035` (net ≈ `* 0.42`) is compensating for a missing px-to-world conversion.

**Fix:** Compute `strokeExpansion = this.strokeWidth * pxToWorld * 0.5` using the correct conversion factor (the same `pxToWorldX` / `pxToWorldY` that SDFText uses). The factor of `0.5` is because expansion goes both directions from the stroke centerline.

### 7b — Diamond Squared Dimensions

**Files:** `src/scene-graph/shapes/diamond.ts` ~L62–63

```ts
// TODO: Find out exactly why I have to square the dimensions
const correctedWidth = (this.width) * this.width;
const correctedHeight = this.height * this.height;
```

**Root Cause:** The Diamond's geometry generation likely already applies `width`/`height` as a scale factor, and then the world matrix applies it again. Squaring in the bounding box compensates for the double application — but the real fix is in the geometry or the matrix chain.

**Fix:**
1. Check `Diamond.getGeometryVertices()` — does it multiply by `width`/`height` internally?
2. Check `Diamond.updateLocalMatrix()` — does it call `mat4.scale(..., [scaleX, scaleY, 1])`?
3. If both apply the dimension, remove one (probably from the geometry generation, keeping the matrix-based approach consistent with other shapes).
4. Then change the bounding box to use plain `this.width` / `this.height` instead of squaring.

### Complexity

Small per shape — the hard part is understanding the coordinate-space chain.

---

## Implementation Order (Recommended)

| Order | Issue | Risk | Effort |
|-------|-------|------|--------|
| 1 | Polygon stubs | None | Small |
| 2 | GPU cache leak | Low | Medium |
| 3 | Bounding box hacks | Low (localized) | Small |
| 4 | Raster selection modes | Medium (GPU blend logic) | Medium |
| 5 | Depth buffer | Low | Small |
| 6 | TransformController | High (refactors pointer loop) | Large |

*Pattern draw pass was incorrectly flagged — it works via the current path. Legacy commented code can be cleaned up.*
