# Vector Paths — pen tool, Bézier Path shape, node editing (spec)

**Date:** 2026-09-10 · **Status:** **P0 BUILT + harness-verified same day** — pen gesture live on the polygon tool (`src/scene-graph/core/bezier.ts` pure module +6 tests: cubicPoint/flattenCubic/sampleCubic/penEdgeControls; polygon-drawing-service: `handles[]`, pointerup finalize, handle-bar + curved staged preview via the `_setPolyline` node-recycling helper — ⚠ staged node ADD/REMOVE must emit onSceneGraphChanged or the new lines are invisible; commit flattens all edges incl. the implicit closing edge; staging SLOTS 256→1024). **P1 BUILT + harness-verified 2026-09-10:** `src/scene-graph/shapes/path-node.ts` (`PathNode`/`PathAnchor` — anchors persisted, lazy tessellation cached on `anchorsVersion`, tol = extent/2000; closed = ear-clip fill via the now-public `Polygon.earClipTriangulate`, open = smoothed-normal stroke quads; Polygon-pattern world bbox/selection/containsPoint; `toJSON` anchors+closed) + `Shape.hasUniqueGeometry` flag (generalizes the geometry cache's Polygon branch) + `ShapeFactory.createPath` (layer-stamped) + serializer `"Path"` case + the pen tool now commits a PathNode (anchors with mirrored handles, `kind` smooth/corner). 9 unit tests; driven-browser verified (commit = type 'Path', anchors carry the exact drag handle, renders identically, outliner lists 'Path'). **P2 BUILT + harness-verified 2026-09-10:** `src/services/drawing/path-edit-service.ts` (node editor per §6b — staged overlay markers: blue anchor squares / green selected / light-blue handle bars+tips for the selected anchor only, Illustrator-style; drag anchor, drag handle with smooth-mirror + Alt/cusp break; dblclick-insert via `nearestTOnCubic` + exact `splitCubic`, Delete/Backspace remove with min 3-closed/2-open, Escape or click-off-path exits — "off path" = fails containsPoint AND >8px from the outline, since a dblclick's first click lands exactly ON the outline where even-odd is a coin flip) + PathNode mutation methods (`moveAnchor`/`setHandle`/`insertAnchorOnSegment`/`removeAnchor`, all through `_mutated()` → anchorsVersion++/retessellate/markDirty) + bezier `splitCubic`/`nearestTOnCubic` + the gcache **growth fix** (update() on grown geometry orphans the old region + re-runs allocate — the P2 blocker noted below, now fixed) + ShapeManager API `enterPathEdit(id)`/`exitPathEdit()`/`isPathEditActive`/`getPathEditTarget()`/`onPathEdited(cb)` + `webgpuRenderer.onCanvasReinitialized` hook re-binding polygon + path-edit listeners on canvas swap (pre-existing gap). Browser-verified end-to-end (enter → drag anchor → drag handle → dblclick insert on-segment → Delete → Escape; overlay cleaned up, 0 GPU errors). **P2 tail (same day, harness-verified):** SESSION-SCOPED undo/redo for anchor edits (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y inside the editor; one drag = one step via drag-start snapshot committed on first mutation; stack cleared on enter/exit; keydown consumed via stopImmediatePropagation so host raster/3D undo routing never double-fires) + ENGINE-OWNED entry: dblclick a committed Path on canvas enters the editor (respects the vector-layer interactivity gate — the Path's layer must be ACTIVE; vetoed while suppressBoxSelect or the pen tool is enabled, whose dblclick means "close"). **P3 (partial) BUILT + harness-verified 2026-09-10:** SVG path import — `src/scene-graph/core/svg-path.ts` (pure parser, 13 tests: M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z, implicit repetition, compressed arc flags via a cursor scanner, quadratic→cubic exact elevation, arc→cubic per SVG F.6.5 + ≤90° slices with k = 4/3·tan(Δθ/4), Z merges a coincident terminal point so a two-arc circle becomes a 2-anchor ring; stays in SVG y-DOWN space) + `sm.importSVGPath(d, {x?, y?, width?, fillColor?, strokeColor?, strokeWidth?})` (one PathNode per subpath, y-flip to world-up, group bbox uniformly fit to `width`, active-layer stamped; exported `parseSVGPath`/`SVGSubpath` from main.ts) + `sm.convertPolygonToPath(id)` (corner anchors from `Polygon.points`, preserves fill/stroke/layerId/visible/transform/z-order slot, removes the Polygon, returns the editable PathNode). **P3 tail (2026-09-11, harness-verified): EVEN-ODD fill + authoring verbs.** Closed-path fill switched from ear-clip to `src/scene-graph/core/even-odd-fill.ts` — trapezoidal band decomposition with even-odd parity (band boundaries = vertex ys + ALL pairwise edge-intersection ys so no edges cross within a band; spanning edges sorted at band midline, paired [0,1],[2,3]…; one trapezoid = 2 triangles; exact shared band-seam coords ⇒ no cracks; O(E²) intersection scan cached on anchorsVersion; >60k-vert pathology falls back to ear-clip via `PathNode._buildClosedFill`). Self-intersecting outlines now RENDER by the same even-odd rule containsPoint always used — pentagram = hollow center, bowtie = empty waist (6 unit tests incl. a 450-point coverage≡ray-cast property check). And the AI façade grew the path verbs: `SceneAuthoringAPI.addPath` (friendly anchors — `out` alone auto-mirrors into a smooth point; kind inferred) + `importSVG` (wraps `sm.importSVGPath`, hex colors), tool schemas + dispatch in scene-authoring-tools.ts, backed by a new `sm.createPath` creator verb (factory + layer stamp + addChild + emit, the createRectangle pattern). Remaining P3 backlog: dashed strokes, boolean ops. 1371 tests green. · **Companions:** `docs/ui/vector-layer.md` (the freeform polygon tool this extends — FIXED + browser-verified 2026-09-10), `reference_selection_box_geometry` + the 2026-09-10 shape-transform lessons (getScaleFactors contract), `docs/specs/ui-system.md` (paths as interactive UI targets).

## The pitch in one line

Give Salsa true curves: **click places a corner, click-drag pulls out mirrored Bézier handles** (the industry pen-tool gesture), first baked into today's Polygon (P0), then persisted as an editable **Path** shape whose anchors/handles can be re-dragged after commit (P1–P2) — real vector-editor territory.

---

## 1. Concepts

- **Anchor**: a point the path passes through. Carries an optional **in-handle** and **out-handle** (tangent vectors). No handles ⇒ corner (straight segments). Mirrored handles ⇒ smooth (C1) point. Independent handles ⇒ cusp.
- **Segment**: between anchors A→B, a cubic Bézier `B(t) = (1−t)³P₀ + 3(1−t)²tP₁ + 3(1−t)t²P₂ + t³P₃` with `P₁ = A + A.out`, `P₂ = B − B.in`. Zero-length handles degrade it to a line — corners and curves mix freely in one path.
- **The gesture** (pen tool): pointerdown places the anchor at the press point; dragging before release pulls out `out = drag vector`, `in = −drag` (mirrored). Release finalizes. Click the first anchor / double-click / Enter closes; Escape / right-click cancels. Alt-drag on a handle (node editor, P2) breaks the mirror.
- **Tessellation**: curves are flattened to polylines for everything downstream (fill triangulation, stroke expansion, hit-testing). Adaptive De Casteljau subdivision: split a cubic until the control points deviate from the chord by less than a **screen-space** flatness tolerance (~0.25 px ÷ zoom → world units).

---

## 2. Data model (`PathNode extends Shape`)

```ts
interface PathAnchor {
  x: number; y: number;                 // ABSOLUTE world coords (like freeform Polygon points)
  in?:  { x: number; y: number };       // tangent INTO the anchor (offset from anchor); absent = corner side
  out?: { x: number; y: number };       // tangent OUT of the anchor
  kind?: 'smooth' | 'cusp' | 'corner';  // editor affordance: smooth keeps in/out mirrored while dragging
}

class PathNode extends Shape {
  anchors: PathAnchor[];
  closed: boolean;                      // closed = fillable ring; open = stroke-only
  // fillColor / strokeColor / strokeWidth / opacity from Shape
}
```

**Transform contract (hard-won 2026-09-10 — do not deviate):**
- Geometry is REAL-SIZE (absolute coords), so `getScaleFactors()` MUST return `[scaleX, scaleY]` — never bake bounds/size into the localMatrix (the Polygon/Line bug family: bounds-baked scale rendered commits displaced+scaled, NaN'd matrices got shapes viewport-culled).
- `getScaleFactors` runs during the BASE constructor before subclass fields exist (the Mesh3D-documented trap) — guard `if (!this.anchors) return [1,1]`.
- Selection box: override `getWorldSpaceBoundingBoxPolygon` from the tessellation's bounds (+ handle extents so a curve's belly isn't clipped) and `usesWorldSpaceBoundingBox() → true`, per the selection-box geometry contract.

---

## 3. Tessellation + caching

`tessellate(tolWorld): Float32Array` — walk segments; corners emit the chord; curves subdivide adaptively. Cache keyed by an `anchorsVersion` counter (bumped by every anchor/handle mutation) **plus a zoom bucket** (tolerance is screen-space, so zooming in must re-flatten; bucket = `ceil(log2(zoom))` keeps re-tessellation rare). Typical paths flatten to 50–400 points — the same magnitude the freeform Polygon already handles.

- **Fill** (closed paths): ear-clip the flattened ring — export `Polygon.earClipTriangulate` (it's static) rather than copying it. Self-intersecting rings triangulate ugly exactly as freeform polygons do today: acceptable v1, document it.
- **Stroke**: expand the flattened polyline into quads with the smoothed per-point normals technique the Scribble staging path uses (average prev→next tangents — seamless joins). Closed paths wrap the normal computation.
- **Render integration**: PathNode follows the Polygon lane through `shapes-render-gcache` — it's the second "unique geometry per shape" type (the cache already branches on `getType() != "Polygon"`; generalize that check to a `hasUniqueGeometry` flag on Shape rather than a growing type list). Uniforms via the existing shape uniform cache (localMatrix per §2). Dirty path: anchor mutation → `anchorsVersion++` → geometry cache re-upload (the Polygon update path at `shapes-render-gcache:180` generalizes the same way).

---

## 4. Hit-testing

- **Coarse**: world AABB from the tessellation cache (finite by construction; the NaN-cull guard from 2026-09-10 backstops it anyway).
- **Fill hit** (closed): point-in-polygon on the flattened ring in local space via inverse localMatrix — Polygon's `containsPoint` pattern verbatim.
- **Stroke hit** (open, or clicks near the outline): distance-to-segment over the flattened polyline against `max(strokeWidth/2, ~4 px ÷ zoom)` so hairlines stay clickable.
- Paths participate in the vector-layer interactivity gate + UI-system `shapeInteractions` like any shape (layerId stamped by the ShapeFactory choke point automatically).

---

## 5. Persistence

- `toJSON`: `{ type:'Path', anchors, closed, ...shared Shape fields }` — params-only, no baked tessellation (regenerated at load; matches the engine's params-are-source thesis).
- `recreate2DShape` (shape-serializer): one new case constructing via a new `ShapeFactory.createPath(anchors, closed, …)` (factory = layer stamp + the one creation choke point).
- Additive format change: old documents unaffected; a Path in a new doc simply fails to appear in an old build (standard forward-compat posture).

---

## 6. Tools

### 6a. Pen tool (P0 gesture, shared by both options)

Tool-side state only: `anchors: PathAnchor[]` + a live handle drag. Preview rides the **staging overlay** exactly like the polygon tool (it's the same service pattern — square markers for anchors, thin staged lines for the sampled curve; the 2026-09-10 staging-buffer append API draws many staged lines correctly, and staged nodes are never viewport-culled). Sampled preview = fixed 16 steps per curved segment (tolerance-precision matters at commit, not preview).

- pointerdown → provisional anchor; pointermove while down → `out = cursor − anchor`, `in = −out`, live-resample the two adjacent segments; pointerup → finalize.
- Click first-anchor marker / double-click / Enter → commit. Escape / right-click → cancel. Same close-snap distance logic as the polygon tool (screen-px converted to world).
- **P0 commit target: `Polygon`** — tessellate at commit and hand the flat points to the existing shape. **P1 flips this one call to `createPath(...)`.** That seam is the entire migration.

### 6b. Node editor (P2)

Select a Path → an **edit mode** (like mesh-edit for 3D) draws anchors + handle lines as staged overlay markers:
- Drag anchor = move (both handles follow). Drag handle = rotate/stretch tangent; `smooth` anchors mirror the opposite handle, Alt breaks to `cusp`.
- Double-click a segment = insert anchor at the nearest `t` (De Casteljau split — exact, curve shape unchanged). Delete key on a selected anchor = remove + heal. Double-click an endpoint of an open path = toggle close.
- All mutations bump `anchorsVersion` (re-tessellate + re-upload) and are undoable via the standard shape-mutation snapshot path.
- Suppress box-select while active (`interactionService.suppressBoxSelect`, the creator-mode pattern).

---

## 7. Phases

- **P0 — pen gesture on the polygon tool (~1 session):** hold-drag handles + curved staged preview + flatten-at-commit → Polygon. Ships user-visible curves with zero engine surface change. Browser-verify with the puppeteer harness (off-origin clicks, screenshot vs markers — the 2026-09-10 method).
- **P1 — PathNode (~1–2 sessions):** shape class + tessellation cache + fill/stroke render + hit-test + persistence + `createPath`; pen tool commit target flips to Path. Everything from P0 is reused verbatim.
- **P2 — node editor (~1–2 sessions, browser-gated):** edit mode per §6b + `sm.enterPathEdit3D`-style API for Frogmarks (enter/exit, selection events for an anchor-properties panel).
- **P3 — extras (as earned):** even-odd fill / proper self-intersection handling, dashed strokes, convert-Polygon→Path upgrade action, boolean ops on paths, SceneAuthoringAPI `addPath` verb + tool schema (AI-drawable curves), SVG path import (maps 1:1 onto anchors/handles — the ephemera SVGs become editable).

## 8. Order-of-operations verdict (option 1 vs option 2)

**Do P0 (option 1) first, then P1/P2 (option 2) — not straight to 2.** The pen tool's input layer, sampling math, and staged preview are byte-identical in both; the only "throwaway" in option 1 is the single commit call, which P1 replaces. Meanwhile option 2's genuinely new work (shape class, tessellation cache, hit-testing, persistence, editor) is the risky, browser-gated tail — sequencing it second means curves ship a session earlier and the Path work proceeds against a proven tool. Going straight to 2 buys nothing except delaying usable curves. Existing committed polygons stay polygons either way (a convert action is P3).

## 9. Non-goals (v1)

Variable-width strokes / pressure profiles, gradient fills along paths, text-on-path, path animation (morph targets), and live boolean path ops — all real features, none needed for the pen tool + editable curves core.
