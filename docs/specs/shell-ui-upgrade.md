# Shell UI Upgrade — Spec (Glass Direction)

**Status:** First pass landed (layered "3DS" look) — typechecks clean, **not browser-validated**.
**Last Updated:** 2026-06-10
**Direction:** **Liquid-glass** premium aesthetic (Apple-style), with 3DS-style solid bevel/parallax as the documented fallback if backdrop blur proves too expensive.

> **Implementation note (first pass).** Built the layered/faux-3D version that matches the 3DS reference (depth via layers + parallax + SDF bevel/shadow, not thick extrusion):
> - **Smaller tiles** — `shell-layout.ts` now uses a cell-pitch grid (~7 columns, roughly half the previous tile size) and emits `GridParams` for the panel.
> - **Inset panel** — `shell-renderer.ts` `PANEL_SHADER`: a debossed repeating grid of empty slots behind the tiles (the look you asked for).
> - **3D-look tiles** — `TILE_SHADER`: drop shadow + beveled rim (finite-difference SDF normal, lit up-left) + specular sheen + thumbnail + animated selection ring. One instanced draw.
> - **Motion (U2)** — per-tile hover/select eased over time in `ShellRenderer.tickAnim`; pointer **parallax** between the panel and tile layers (tiles drift more); hover-lift raises the tile + deepens its shadow.
> - **Background (U3-lite)** — `BG_SHADER`: vertical gradient + soft vignette (also the future blur source).
> - **Transition (U5-partial)** — staggered **appear** animation on mount (tiles rise + fade in by index).
>
> **Still to do:** true backdrop-blur glass (U4 proper — current "glass" is specular/sheen only), particle background (U3 proper), dashboard-swap crossfade + launch zoom (U5 proper — only mount stagger done), real breadcrumb nav (U6 — still the interim "‹ Back" tile), and visual tuning (the panel/viewer seam at the 40% line, exact parallax/bevel amounts).

This spec covers the *visual + interaction* upgrade of the Shell UI now that it renders end-to-end. It does not change the architecture ([reference/23-shell-architecture.md](../reference/23-shell-architecture.md)) or the host contract ([ui/shell-ui.md](../ui/shell-ui.md)); it upgrades how the slot grid, tiles, background, and transitions look and feel.

References: Nintendo 3DS home screen (solid extruded tiles, parallax) and Apple "liquid glass" control surfaces (translucent, blurred, specular).

---

## Goals

1. Tiles that read as **physical 3D objects** — extruded, lit, with depth — not flat rectangles.
2. A **glass material**: translucent, frosted (backdrop blur), with a specular rim and inner shadow.
3. A **living background** worth refracting through the glass.
4. **Motion**: eased hover/select/press, parallax, dashboard transitions, cartridge swap, launch zoom.
5. Proper **navigation** (a real back/breadcrumb, replacing the interim "‹ Back" grid tile).

Non-goals: changing storage, the document-source model, or the cart/launch flow.

---

## 1 — Tiles as instanced 3D geometry (still one draw call)

Every tile is the **same mesh**, so the grid stays a **single instanced draw** even in 3D — swap today's unit quad for an instanced **extruded rounded-rect** mesh and `drawIndexed(indexCount, N)`. Geometry cost is negligible; per-instance data carries everything that varies.

```
Per-instance (extends today's tile instance):
  rect          : vec4   // x, y, w, h (px)  → builds the model transform
  fill / border : vec4 each
  params        : vec4   // cornerRadius, borderWidth, useThumb, depth
  uvRect        : vec4   // thumbnail atlas
  anim          : vec4   // hoverT, selectT, pressT, _   (0..1 eased progress)
```

Geometry: a rounded-rect prism — front face (thumbnail/label), beveled rim, shallow sides. Reuse the rounded-rect SDF for the front face; extrude by `depth` (small, e.g. 6–10% of tile size). Lighting: one key light + ambient (as the cartridge viewer already does), so tiles catch a highlight and cast a subtle self-shadow on the bevel.

The grid renders in a **shallow perspective (or tilt-shifted ortho)** pass with its own depth buffer — the same pattern as `CartridgeViewer`, just instanced. This gives real parallax when tiles tilt.

**Decision point:** *real 3D extrusion* (recommended — cheap at 1 draw call, true parallax) vs *faux-3D* (bevel/specular in a 2D fragment shader + tilt). Real 3D is the bias; faux-3D is the fallback only if the 3D pass complicates the glass compositing below.

---

## 2 — Glass material

Frosted glass needs three ingredients; the first is the expensive one:

1. **Backdrop blur.** Render the background environment (§3) to an offscreen texture, produce a blurred mip (separable Gaussian, 2 passes, at half/quarter res), and have each tile sample that blurred texture at its screen position for the "frosted" fill. This is the cost center.
2. **Translucency + tint.** Composite the blurred backdrop with the tile's tint color at ~70–85% — the cart/project art shows through faintly, or sits as an inset over the frost.
3. **Specular rim + inner shadow.** A Fresnel-ish bright edge on the top/left rim (key-light direction) and a soft inner shadow on the bottom/right sell the thickness. Cheap, big payoff.

Selection/hover modulate glass parameters (more opaque + brighter rim when selected; subtle lift + rim on hover).

**Fallback (3DS):** if backdrop blur costs too much on low-end GPUs, drop ingredient 1 and ship **solid** extruded tiles with bevel + specular + a flat tint. Visually still strong (the 3DS look), and the geometry/lighting work from §1 is unchanged — only the fill source differs. Gate this behind a quality setting.

---

## 3 — Background environment

Glass is only glass if there's something behind it. Replace the flat clear color with an animated backdrop (also the blur source for §2):

- **Base:** slow-moving multi-stop gradient (creative-OS calm), ~20s loop.
- **Drift:** a few hundred soft particles / bokeh dots, CPU-simulated, additive — gentle depth and life.
- **Optional hero:** a very low-poly stylized scene (shelf/room) far behind the grid, camera locked.

Keep it subtle — it must not compete with the carts/cartridge. It exists to be refracted and to make the glass legible.

---

## 4 — Motion & transitions

The shell already runs a continuous rAF loop, so add a per-tile **eased animation state** that interpolates toward targets each frame (e.g. `t += (target - t) * (1 - exp(-dt/τ))`):

| Interaction | Animation |
|---|---|
| Hover | tile lifts (Z + scale), rim brightens, slight tilt toward pointer (parallax) |
| Select | settles raised, white rim ring animates in, cartridge viewer swaps |
| Press / activate | quick scale-down then release |
| Dashboard swap (shell ↔ illustrations) | crossfade + slide; tiles stagger in |
| Cartridge / sketchbook swap | the already-specced 120ms out / 200ms in (wire it up) |
| Launch (cart) | selected tile zooms toward camera → screen wipe → cart runtime |
| Grid parallax | whole grid shifts slightly opposite pointer; rows at different depths move at different rates |

All of this is driven by the `anim` per-instance vec4 (§1) plus a couple of global uniforms (pointer position, dashboard-transition progress). No new draw calls.

---

## 5 — Navigation

Replace the interim **"‹ Back" grid tile** (currently the first slot in Illustrations mode) with a proper **breadcrumb/back affordance** rendered above the grid:

```
‹ Shell  /  Illustrations
```

Rendered as its own small element (SDF/atlas text + a hit-rect), not a grid slot, so it doesn't consume a tile. Click ‹ or the "Shell" crumb → `closeIllustratorDashboard()`. Esc already works. (The grid tile stays as the zero-effort fallback until this lands.)

---

## Implementation phases

| Phase | What | Notes |
|---|---|---|
| **U1 — 3D tiles** | Instanced extruded rounded-rect mesh, perspective/tilt pass, lighting, per-instance transform; port thumbnail + label onto the 3D front face | Geometry + lighting; still 1 draw call |
| **U2 — Motion** | Per-tile eased anim state; hover lift/tilt, select ring, press, grid parallax | Drives `anim` vec4 |
| **U3 — Background** | Animated gradient + particle drift; render to offscreen texture | Becomes the blur source |
| **U4 — Glass** | Backdrop-blur passes + translucent tile fill + specular rim/inner shadow; quality toggle with 3DS-solid fallback | The expensive part |
| **U5 — Transitions** | Dashboard crossfade/stagger, cartridge swap wiring, launch zoom + screen wipe | |
| **U6 — Navigation + polish** | Breadcrumb/back bar, label typography, spacing, selection states | Replaces the interim back tile |

U1+U2 alone (solid 3D tiles + motion) already deliver most of the "impressive" feel; U3+U4 add the glass; U5+U6 finish it.

---

## Open questions

- **Quality tiers:** auto-detect GPU and pick glass-vs-solid, or expose a Settings toggle? (Lean: detect + override in Settings.)
- **Tilt model:** perspective camera vs orthographic with per-row depth offset? (Ortho is easier to keep tiles rectangular; perspective is more dramatic.)
- **Background as blur source:** half-res or quarter-res blur target? (Start quarter-res; frosted glass hides the resolution.)

---

## Related

- [reference/23-shell-architecture.md](../reference/23-shell-architecture.md) — architecture (unchanged by this upgrade)
- [specs/shell-ui.md](shell-ui.md) — base Shell UI spec
- [ui/shell-ui.md](../ui/shell-ui.md) — host integration contract
- [specs/billboard3d.md] *(future)* — the Billboard3D primitive could render sprite-cutout tiles/mini-scenes
