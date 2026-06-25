# Arc / Curve Text — Design Spec
**Status:** ✅ Approach A implemented (June 2026) — Phase 3 of the retro text work ([retro-text-ephemera-polish.md](./retro-text-ephemera-polish.md))
**Goal:** Bend LiveText along an arc (the "ポケモンカ" curved-banner look), composable with the existing outline/glow/feather effects.

> **Implemented (Approach A — geometry warp):** `LiveTextNode.arcAngle` (degrees, 0 = flat, +ve =
> arch up ∩, −ve = arch down ∪), serialized + set via `setLiveTextStyle({ arcAngle })`. The renderer
> (`webgpu-renderer.drawArcedLiveTextNodes`) bends arc nodes onto a 24-segment curved strip:
> `x = R·sin(φ)`, `R = W/|arcRad|`, columns rotated by the local tangent so glyphs stand on the arc;
> effects run on the FLAT capture first, so outline/glow/feather curve with it. Flat nodes
> (`arcAngle == 0`) are pixel-identical to before. **Known v1 limits:** glyphs *warp* (texture
> stretch), not per-glyph re-orientation; editing happens on the FLAT element (caret aligns to the
> un-arced layout — set arc to 0 to edit precisely, then re-apply); the selection box stays the flat
> rect. See Approach B below for the future true-textPath upgrade.

This is split out from the Phase 1–2 spec because it does **not** fit the flat-quad capture model and needs its own approach decision.

---

## The problem

LiveText works by capturing a **flat** HTML element to a texture, running the effect chain, then drawing it on a **4-vertex quad** ([drawLiveTextNodes](../../src/renderer/core/webgpu-renderer.ts)). Arc text has no flat representation — the glyphs follow a curve. So either the geometry must curve, or the text layout itself must happen on a path.

---

## Two approaches

### Approach A — Geometry warp (recommended for v1)

Keep capturing the text **flat**, then bend the **render quad** into a curved strip.

- In `drawLiveTextNodes`, when a node has an arc, emit a **subdivided strip** (N segments) instead of 4 vertices. Each segment is positioned along an arc of `arcAngle` (total sweep) at `bend`/`radius`; the flat texture maps across the strip via UVs (u = 0→1 across the arc, v = 0→1 top→bottom).
- New fields on `LiveTextNode`: `arcAngle` (degrees, 0 = flat), `arcDirection` (concave up/down), optional `arcRadius`. Serialized in `toJSON`.
- Effects run on the flat texture **before** the warp, so outline/glow/feather curve *with* the text for free.

**Pros:** reuses the entire capture + effect pipeline; **inline editing still works** (edit the flat element, display it curved — the editor overlay stays flat, which is an acceptable "edit flat / view curved" UX); cheap (just more vertices).
**Cons:** glyphs are *warped* along the arc (texture stretch), not individually re-oriented — vertical strokes don't stay perfectly radial. **Fine for gentle arcs** (which is the retro look); distorts on tight arcs.

**Details to resolve:**
- Bounding box / selection: compute the arc's AABB, or accept a slightly loose flat-bounds box in v1.
- `syncOverlayTransform` during editing stays flat (edit mode shows the un-arced element).
- Segment count: scale with `arcAngle` (more sweep → more segments) to keep the curve smooth.

### Approach B — SVG `<textPath>` (true arc, future)

Render the text as `<svg><path d=…/><text><textPath>…</textPath></text></svg>` so the **browser** lays each glyph along the path (correct per-glyph orientation).

**Pros:** true text-on-path; glyphs rotate to the tangent; tight arcs look right.
**Cons:** breaks the contenteditable inline-editing model (no caret inside `textPath`) → needs a separate edit field (edit plain text, render SVG); capture sizing + overlay alignment get more complex. More work.

---

## Recommendation

Ship **Approach A** first — it nails the gentle-arc retro banner, composes with the new outline/feather/glow effects, and preserves live editing. Add **Approach B** later as a "true arc" toggle only if tight arcs with correct glyph orientation become necessary.

## Verification
- `npx tsc --noEmit`; user rebuilds.
- `arcAngle = 0` ⇒ pixel-identical to today (no regression).
- A gentle arc with a stacked outline reads as a clean curved banner; editing still places a caret (on the flat element).
