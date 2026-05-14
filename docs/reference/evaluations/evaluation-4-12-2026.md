# Salsa Renderer — Evaluation (April 12, 2026)

**Evaluator:** GitHub Copilot (Claude Opus 4.6)
**Scope:** Full codebase audit — scene graph, WebGPU renderer, cache system, raster pipeline, text systems, services, WASM module, utilities

---

## Overall Verdict

This is genuinely impressive engineering. A custom WebGPU renderer with indirect draw batching, GPU compute compositing, SDF text via JFA, triple-buffered staging, WASM dithering, and an HTML-in-Canvas text pipeline — that's a serious technical achievement. The core rendering architecture is sound and well-thought-out. Most of the issues are organizational/maintenance, not fundamental design flaws.

---

## Critical Issues

### 1. `recreateNode` default case silently loses data

The `default` branch in `recreateNode` creates a bare `Node`, which means any unrecognized type string causes silent data loss on reload. If you add a new shape type and forget to add its case, users lose those shapes with no error.

**Severity:** Critical
**Impact:** User data loss on reload
**Recommendation:** Log a loud warning or throw in the default case. Consider a shape type registry so new types are auto-discovered.

### 2. No dimension validation on raster pixel uploads

The `writeTexture` mismatch bug (canvas size not restored before layer recreation) was found and fixed during this session. But the same class of bug exists in `uploadPixelsToCel` and potentially `restoreLayerCels`. Any path that writes pixel data to a texture should validate `pixels.byteLength === w * h * 4` before calling `writeTexture`, so you get a clear error instead of a WebGPU exception.

**Severity:** Critical
**Impact:** All raster layers fail to load if window size differs from save time
**Status:** Root cause fixed (added `setSize()` call in `restoreDocumentState`). Defensive validation still needed on all pixel upload paths.

### 3. The renderer owns both rendering AND interaction

`webgpu-renderer.ts` is doing two fundamentally different jobs: GPU rendering and pointer event handling (dragging, scaling, rotating, box selection, endpoint dragging). The interaction state machine (~1000 lines of pointer handling) should live in its own class. This is the single biggest maintainability issue outside ShapeManager. If a new developer wants to change how scaling works, they have to navigate a 3700+ line renderer file. If they want to add a new interaction mode, same thing.

**Severity:** Critical (maintainability)
**Impact:** High barrier to contribution, merge conflicts, difficulty reasoning about behavior
**Recommendation:** Extract interaction handling into a dedicated `InteractionController` class that the renderer delegates to.

---

## Significant but Non-Critical

### 4. Legacy dead code

- `AnimationManager` (`src/services/animation-manager.ts`) is entirely commented out
- `RenderCache` (legacy monolithic uniform cache) is superseded but still present
- `PatternLegacyGeometryCache` + `PatternLegacyUniformCache` + `LegacyDataRegistry` coexist with the modern pattern path
- Legacy `Text` shape is superseded by SDFText/LiveText

This isn't breaking anything, but it's confusing for someone new. A fresh contributor would see two pattern pipelines and not know which is active.

**Severity:** Moderate
**Impact:** Contributor confusion, increased cognitive load
**Recommendation:** Remove or clearly mark as deprecated with comments explaining which path is current.

### 5. Uniform layout duplication

The 64-float uniform struct (resolution + worldMatrix + localMatrix + color + strokeWidth) is manually written in 5+ uniform cache classes with copy-pasted logic. A shared `writeBaseUniforms(buffer, offset, shape)` helper would eliminate this. If you ever change the layout (e.g., add a field), you'd need to update every cache class.

**Severity:** Moderate
**Impact:** Maintenance burden, risk of layout drift between cache types
**Recommendation:** Extract a shared `writeBaseUniforms()` utility. Type-specific caches call it then append their extra fields.

### 6. SDF atlas never shrinks

The SDF atlas only grows (1024→2048→4096...). If you create 500 text nodes with unique characters, then delete them all, the atlas stays at its peak size forever. `sweepRetired()` cleans up old textures after growth, but doesn't reclaim glyph slots. For a whiteboard where users create/delete text frequently, this could slowly eat GPU memory.

**Severity:** Moderate
**Impact:** Gradual GPU memory growth in long sessions
**Recommendation:** Implement periodic atlas compaction — rebuild the atlas from only the glyphs currently referenced by live SDFText nodes.

### 7. Snapshot memory pressure

`RasterSnapshotManager` stores up to 50 full CPU-side texture copies. For a 2048×2048 illustration that's `2048 × 2048 × 4 × 50 = ~800MB` of RAM. Consider: differential snapshots (only store dirty rects), reducing the cap, or compressing snapshots.

**Severity:** Moderate
**Impact:** High memory usage for large illustrations with many undo steps
**Recommendation:** Store only dirty-rect regions per snapshot, or compress snapshots (e.g., LZ4/zstd via WASM).

---

## Possible Improvements (Not Flaws)

### 8. Error boundaries around GPU operations

Most `writeBuffer`/`writeTexture`/`copyBufferToBuffer` calls have no try-catch. A single corrupt shape or buffer overflow produces a WebGPU device loss with no recovery. Wrapping critical GPU paths in validation (at minimum, size checks) would make debugging much easier and prevent one bad shape from killing the entire session.

**Recommendation:** Add a `safeWriteBuffer()` / `safeWriteTexture()` wrapper that validates sizes before calling the GPU API. Log and skip rather than crash.

### 9. Drawing services are very repetitive

`ScribbleDrawingService`, `HighlightDrawingService`, `LineDrawingService`, `PatternDrawingService` all follow the same pattern: pointerDown → create staging shape → pointerMove → update shape → pointerUp → commit. A base `StrokeDrawingService` class with hooks would cut ~60% of the duplicated code.

**Recommendation:** Create a `BaseStrokeDrawingService` with template method pattern. Subclasses override `createShape()`, `updateShape()`, `commitShape()`.

### 10. `getScaleFactors()` is dead code

Every shape implements it, but the return value is never used — `updateLocalMatrix()` always reads `this.scaleX`/`this.scaleY` directly. It's a small thing but it confuses someone reading the abstract Shape contract.

**Recommendation:** Remove the abstract method and its implementations, or rewire `updateLocalMatrix()` to actually use it.

---

## What's Done Well

| Area | Assessment |
|------|-----------|
| **Indirect draw batching** | Textbook correct — shared geometry, slice-based uniforms, one draw call per pipeline type |
| **Triple-buffered staging** | Eliminates GPU/CPU sync stalls during interactive drawing |
| **SDF text pipeline** | JFA compute → atlas → smoothstep shader is the state-of-the-art approach |
| **Cache growth strategy** | Double-on-overflow with GPU copy, freed slot reuse, version-tracked dirty checking |
| **Compositor** | 12 blend modes, per-layer dithering, displacement animations, clipping masks — feature-rich and correct |
| **WASM for error diffusion** | Right architectural call — these algorithms can't parallelize on GPU |
| **Dirty tracking** | `localMatrixVersion` skips buffer writes for static shapes — big win for large scenes |
| **HTML-in-Canvas** | Cutting-edge approach with proper fallback path |
| **Scene graph design** | Clean separation: Node (tree) → Shape (renderable) → Concrete types. Lazy matrix invalidation is efficient. |
| **Serialization round-trip** | Full scene graph + raster layers + animation cels + brush presets — comprehensive save/restore |

---

## Summary

The rendering core is robust and well-architected. The main weaknesses are organizational: the renderer conflates rendering + interaction, there's legacy code that should be cleaned out, and some defensive validation is missing around GPU operations. None of these are fundamental design flaws — they're cleanup work appropriate for a pre-1.0 library.

---

## Bugs Fixed During This Session

| Bug | Root Cause | Fix Applied |
|-----|-----------|-------------|
| LiveText nodes disappear on reload | `recreateNode` had no `case "LiveText:"` | Added full LiveText case with engine/DOM/texture init |
| LiveText names reset to "Untitled" | Constructor left `name` as empty string | Set default name to `"Live Text"` |
| LiveText shrinks on rescale | Double-counting `_width` × `scaleX` in localMatrix | Changed to unit-quad model (`_width=1`, size in `scaleX/scaleY`) with `_hasUserScale` guard |
| Raster layers blank on reload | `restoreDocumentState` didn't call `setSize()` with saved dimensions | Added `setSize(savedW, savedH)` before layer recreation |
