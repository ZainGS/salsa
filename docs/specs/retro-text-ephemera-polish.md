# Retro Text & Ephemera Polish — Design Spec
**Status:** ✅ Phase 1 engine done · ✅ Phase 2 COMPLETE (blendMode + 9-generator kit + glow/feather) · ✅ Phase 3 arc text done ([arc-text.md](./arc-text.md))

> **Phase 2 (June 2026) — complete (Salsa side):** placement `blendMode` wired (type + overlay draw
> + rasterize + `updateEphemeraPlacement`). **Full generator kit shipped + registered** (9):
> `worn-edges:standard`, `media-icons:format`, `holo-seal:standard`, `badge:standard`,
> `memphis:confetti`, `halftone:dots`, `scanline:crt`, `rainbow-strip:standard`, `wireframe:solid` —
> each with its own category, auto-surfacing via `getEphemeraCategories()` /
> `getEphemeraGeneratorsByCategory()`. **Ephemera glow/feather DONE:** `decorateEphemeraSvg()`
> ([svg-effects.ts](../../src/services/ephemera/svg-effects.ts)) injects a glow filter / feather
> mask into the SVG; placement gained `glow?` / `feather?`; `updateEphemeraPlacement` regenerates +
> re-decorates. **Remaining Phase 2 = Frogmarks UI:** blend-mode dropdown + glow/feather controls on
> the placement inspector. (Glow clips at the SVG edge for edge-touching content — fine for icons/badges.)

> **Phase 1 done (Salsa side):** `OutlineParams` gained `offset` + `gap` (color was already
> there); the outline WGSL now does an offset ring-test. New `'feather'` effect (`FeatherParams`:
> linear/radial alpha fade-out) with its own compute pass. `defaultFeather()` is re-exported from
> ShapeManager alongside the other effect defaults. Type-checks clean. **Remaining Phase 1 = Frogmarks
> UI:** expose outline Color/OffsetX-Y/Gap, glow Color, and add Feather to the "+ Add Effect" list.
**Goal:** Hit the late-90s/Y2K Japanese OBI / cassette / MiniDisc aesthetic — layered sticker outlines, soft edge fades, glow, worn media damage, and a kit of period-correct decorative marks.

This spec covers **Phase 1 (text effects)** and **Phase 2 (ephemera)**. Arc/curve text is its own spec ([arc-text.md](./arc-text.md), Phase 3) because it doesn't fit the flat-quad capture model.

---

## What already exists (reuse — do NOT rebuild)

- **Text effect chain** — [text-effect-engine.ts](../../src/renderer/raster/effects/text-effect-engine.ts). `TextEffectConfig[]` applied in sequence by `applyChain` (so **stacking is free** — multiple outlines already work). Each effect is a WGSL compute pass.
- **`outline`** effect — dilation in `applyOutline`. **`OutlineParams.color` already exists** (RGBA) — it's just not exposed in the Frogmarks panel (which shows only Thickness). `offset` and `gap` do **not** exist yet.
- **`glow`** effect — `GlowParams` with `radius`, `intensity`, and **`glowColor`**. Edge glow for text is **already done**; the panel may not expose color.
- **Ephemera generators** — [ephemera/generators/](../../src/services/ephemera/generators/), each a pure `IEphemeraGenerator` returning an SVG string. Adding one = one self-contained class + registration in `EphemeraService`.
- **Ephemera placements** — have `opacity` and an overlay 2D draw (`drawImage`). **No `blendMode`** yet.

---

## Phase 1 — Text effects (small, high ROI)

### 1a. Outline: offset + gap (color already there)

Extend `OutlineParams`:

```ts
export interface OutlineParams {
  thickness: number;                         // existing — band width in texels
  color: [number, number, number, number];   // existing (UI just needs to expose it)
  offset?: [number, number];                  // NEW — dx, dy in texels (drop-shadow-style outline)
  gap?: number;                               // NEW — transparent gap between glyph and outline, texels
}
```

**Shader change** (`ensureOutlinePipeline` WGSL): pack `offset` + `gap` into `params[2] = [offsetX, offsetY, gap, 0]` (the param buffer already has room — 48 bytes = 3×vec4). The dilation becomes a **ring test around the offset sample**:
- `outer = gap + thickness`; sample the source neighborhood around `coord − offset`.
- A pixel is outline iff `centerAlpha ≤ 0.5` **and** coverage within `outer` radius `> 0.5` **and** coverage within `gap` radius `≤ 0.5`.
- `gap = 0`, `offset = [0,0]` ⇒ identical to today (no regression). Clamp `outer` to a sane max (~64) to bound the loop.

**Why it matters:** combined with the existing chain-stacking, this is the whole manga-SFX / sticker recipe — e.g. stack `outline(gap:0, white)` + `outline(gap:4, black)` + `outline(offset:[6,6], magenta)` for the layered "KABOOM!" look.

### 1b. Feather-fade effect (new)

A directional/radial **alpha fade-out** so an element dissolves at an edge instead of a hard cut (very common on the OBI covers).

```ts
export interface FeatherParams {
  mode: 'linear' | 'radial';   // linear = fade along an axis; radial = fade from center outward
  angle?: number;              // degrees, linear mode (0 = →, 90 = ↓)
  start: number;               // 0–1 of the texture — where alpha is still full
  end: number;                 // 0–1 — where alpha reaches 0
  softness?: number;           // optional extra smoothstep ease
}
```

Single compute pass: compute `t` (projection onto the angle for linear, or normalized radius for radial), then `out = src; out.a *= smoothstep(end, start, t)`. Add `'feather'` to `TextEffectType`, a `defaultFeather()`, the `apply` switch case, and an `applyFeather` + pipeline (mirror `applyOutline`).

> Note: "feather" here = soft **fade-out**, distinct from edge-softening (blurring the glyph boundary). If you want true edge-softening too, that's a second small effect (`'soft-edge'`, an alpha-only blur remap) — flag it and I'll add it.

### 1c. Glow — already done

`glow` exists (`radius`, `intensity`, `glowColor`). **No Salsa work** — just expose `glowColor` in the Frogmarks panel.

### Frogmarks UI (Phase 1)
- Outline effect row: add **Color** swatch, **Offset X/Y** steppers, **Gap** slider (Thickness already there).
- Glow effect row: add **Color** swatch.
- New **Feather** effect in the "+ Add Effect" list: mode toggle (Linear/Radial), Angle dial (linear), Start/End sliders.
- The effect list already supports add/remove/reorder + stacking — no new architecture.

---

## Phase 2 — Ephemera (the retro kit)

### 2a. Placement blend mode (enabler)

Add `blendMode?: GlobalCompositeOperation` (default `'source-over'`) to `EphemeraPlacement`; the overlay draw sets `ctx.globalCompositeOperation` before `drawImage` and restores after. Also thread it into `rasterizeEphemeraLayer` (the OffscreenCanvas composite) so the burned-in result matches. **This is what makes worn edges / grunge sit *into* the art** (`multiply`/`overlay`) instead of looking like a flat sticker, and it's what ephemera glow/feather will lean on.

### 2b. New generators

Each is an `IEphemeraGenerator` (params → SVG string). Priority order:

| Generator | Notes / params |
|---|---|
| **Worn edges / creases** ✅ | DONE — `worn-edges:standard` (torn/creases/scuffed/all, wear, foldCount, seeded). Place full-canvas + `multiply`. |
| **Media-format icons** ✅ | DONE — `media-icons:format` (minidisc/cassette/cd/cartridge/floppy, body/accent colors). |
| **Holographic foil seal** ✅ | DONE — `holo-seal:standard` (iridescent radial gradient, scalloped edge, shine streaks, optional center text). |
| **Badge / stamp** ✅ | DONE — `badge:standard` (starburst/circle/seal/ribbon, text, points, tilt). Covers PROMO / 1ST EDITION / SALE. |
| **Memphis confetti** ✅ | DONE — `memphis:confetti` (triangles/zigzags/squiggles/dots/crosses/arcs, density, 4 palettes, seeded). |
| **Halftone dots** ✅ | DONE — `halftone:dots` (spacing, dot size, angle, none/radial/linear gradient). |
| **Scanline / CRT** ✅ | DONE — `scanline:crt` (line spacing/opacity, vignette, screen sheen). Use with `multiply`/`overlay`. |
| **Rainbow spectrum strip** ✅ | DONE — `rainbow-strip:standard` (smooth/banded, horizontal/vertical, emits a wide strip). |
| **Wireframe primitive** ✅ | DONE — `wireframe:solid` (cube/pyramid/octahedron, rotX/rotY, gentle perspective). |

### 2c. Ephemera glow / feather

Two routes (decide at build time):
- **SVG filters baked into the generator** — wrap output in `<filter><feGaussianBlur>`/alpha-gradient masks. Pro: correct at any zoom, rasterizes cleanly. Con: per-generator.
- **Overlay post-process** — apply blur/alpha-ramp when drawing the placement. Pro: generic, one place. Con: re-blurs every frame.

Recommendation: **SVG-filter route** for glow/feather (consistent with the "generators emit complete SVG" model and the rasterize path), gated by placement params `glow?` / `feather?`.

---

## Phasing / effort

| Phase | Items | Effort |
|---|---|---|
| **1** | Outline offset+gap, feather-fade effect (glow already done) | Small — engine + WGSL only |
| **2** | `blendMode` + the generator kit + ephemera glow/feather | Medium — mostly additive generators |
| **3** | Arc/curve text → [arc-text.md](./arc-text.md) | Large — separate spec |

## Verification
- `npx tsc --noEmit` after each effect (safe). User rebuilds + restarts `ng serve`.
- Phase 1 end-to-end: stack 3 outlines with color/gap/offset → layered sticker look; add a feather → element fades at an edge.
- Phase 2: place a worn-edges ephemera with `multiply` → damage sits into the art; place a MiniDisc icon; rasterize → burned result matches the overlay (blend mode included).
