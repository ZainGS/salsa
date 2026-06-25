# Inked Flat — Screen-Print / Riso 3D Style — Spec

**Status:** Proposed. Most ingredients already exist in the engine.
**Last Updated:** 2026-06-11

A render style that makes **3D geometry read as flat 2D illustration** — the retro **screen-print / risograph** look: flat (or hard-banded) fills, a bold **ink outline** around every form, a **limited spot-color palette**, and optional **halftone grain**. Reference: Kaleb Gonyea's pencil-box illustrations and the "CREATE / CREATE MORE STUFF" box being modeled in Frogmarks (3D forms, blue outlines, flat cream/red/blue fills — depth cues removed so the object reads as a print).

The point: you build in 3D (rotate, light, animate) but it *looks* hand-printed. This fits the Frogmarks brand and is a strong candidate for the **dashboard** look and a first-class **illustration render style**.

---

## Why this is mostly already built

Salsa's 3D engine already has the core pieces. The style is a **composition** of them, not new rendering tech:

| Ingredient | Status | Where |
|---|---|---|
| **Flat / cel shading** | ✅ Built | `style-shaders.ts` — `cel` (3 hard diffuse bands + hard specular), `ink` (flat base + view-space rim darkening — manga look), `sketch` (crosshatch). `sm.scene3d.setRenderStyle(id, 'cel'\|'ink'\|'sketch')` |
| **Bold outlines** | ✅ Built | `outline-shaders.ts` + `sm.scene3d.enableOutlines(color, width)` / `setOutlineColor` / `setOutlineThreshold` — screen-space silhouette from the depth buffer, `cullMode:'none'` so it's correct from any angle |
| **Halftone / grain** | ✅ Built | `DitherEngine` — ordered halftone (dot/line/diamond) + blue-noise; can post-process the composite |
| **Flat spot colors** | ✅ Built | per-mesh flat `diffuseColor`; vertex colors |

So **`ink` (or `cel`) render style + `enableOutlines` + flat palette ≈ the look today.** The gaps below are what make it *cohesive* and *print-authentic*.

---

## The full recipe (ingredients + gaps)

1. **Flat fills** — `ink` style (flattest; flat base color + a thin rim of darkening) or `cel` (2–3 banded). For the truest print look, also support a **fully unlit flat** mode (constant color, lighting only via the bands you choose). *Gap: an `'flat'` style = pure albedo, no shading, relying entirely on outlines for form.*
2. **Ink outline** — `enableOutlines` gives the silhouette. *Gap: interior edge lines* (creases / where faces meet at a sharp angle), which the reference has (the box's edges, not just its silhouette). Needs a normal/depth-discontinuity edge detector in the outline pass, not just silhouette.
3. **Limited palette (spot colors)** — the riso look uses ~3–5 inks. *Gap: a palette-quantization post* that snaps the composited image to N chosen spot colors (cream/red/blue/yellow). A small LUT/nearest-color pass.
4. **Halftone grain** — `DitherEngine` halftone over the flat fills sells the print. Apply per-region or globally at low strength.
5. **Paper** — a flat **cream paper background** + optional subtle paper texture, instead of a gradient.
6. *(Optional) Misregistration* — offset each spot-color channel by 1–2px (the riso "off-register" charm). A cheap post.

Gaps to build, in priority order: **(a) interior edge lines** (biggest visual gap), **(b) palette quantization post**, **(c) a flat/unlit style**, then (d) misregistration.

---

## Applying it to the dashboard

The shell renders its viewer meshes (cartridge, billboards) with **its own simplified shaders**, not `Renderer3D`'s style system. Two ways to bring the style in:

- **A — Port cel+ink+outline into the shell shaders** (`shell-cartridge.ts`). Self-contained, keeps the shell decoupled, but duplicates the style math. Outlines in the shell would be a second pass (silhouette from the viewer's depth buffer) — modest work.
- **B — Route the shell viewer through `Renderer3D`** so it inherits `setRenderStyle` + `enableOutlines` for free. Cleaner reuse, but couples the shell to the heavier renderer (the thing we deliberately avoided).

**Recommendation: A**, scoped tight — give the shell's billboard/cartridge shader an **ink-flat fragment** (flat albedo + thin rim) and add a **silhouette outline pass** for the viewer. Then the dashboard hero/icons match the brand print style. The full grid is 2D already; a thin dark outline + the cream-paper background + the spot palette would carry the style across the whole shell.

Dashboard palette (from the reference): cream `#EFE6D0`, ink-blue `#1A4C7C`, red `#E23B2E`, yellow `#F4C842`. Swap the current dark-navy theme for cream-paper + these inks to fully commit.

---

## Phases

| Phase | What | Notes |
|---|---|---|
| **F1 — Prove it** | Apply existing `ink` + `enableOutlines` to a few illustration meshes; tune | Validates the base look with zero new code |
| **F2 — Interior edges** | Extend the outline pass with a normal/depth-discontinuity detector (creases, not just silhouette) | Biggest visual gap |
| **F3 — Flat style + palette post** | Add a `'flat'` render style (unlit albedo) + a spot-color quantization post (LUT) | The "print" commitment |
| **F4 — Dashboard adoption** | ✅ **Done.** Cream-paper theme + spot palette; ink-flat billboard shader (flat albedo + ink-blue cut edge & silhouette band); ink-blue icon outlines | Approach A. The billboard's dilated border + ink `sideColor` *is* the outline — no separate silhouette pass needed for cutouts. 3D box meshes (cartridge/sketchbook) not yet inked. |
| **F5 — Print extras** | Halftone grain pass + optional misregistration | Polish toward true riso |

F1 alone (existing `ink` + outlines on real meshes) will tell us if the style sings before investing in F2–F5.

---

## Open questions

- **Style scope:** is this a *global* document style (everything inked-flat), a *per-mesh* style, or a *theme* the user picks? (Lean: per-document theme, since the look only works if everything commits.)
- **Interior edges:** crease angle threshold — fixed, or per-material? (Start fixed ~35°.)
- **Dashboard:** fully commit to cream-paper + spot palette, or keep the dark theme and just ink the 3D viewer? (Recommend committing — half-measures read as inconsistent.)

---

## Related
- `src/renderer/3d/shaders/style-shaders.ts` — cel / sketch / ink
- `src/renderer/3d/shaders/outline-shaders.ts` — silhouette outline pass
- [16 — 3D Animation System](../reference/16-3d-animation-system.md) · [specs/shell-ui-upgrade.md](shell-ui-upgrade.md)
- `DitherEngine` (`src/renderer/raster/effects/dither-engine.ts`) — halftone
