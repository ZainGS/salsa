# FrogCart CD Tile — Spec

**Status:** Built + browser-validated — annulus geometry + a physically-based **diffraction-grating** shader (Zucconi) + `drawCD`, previewed via a temporary demo cart. Cover art (Phase 2) and real-cart wiring (Phase 3) pending.
**Last Updated:** 2026-06-12

A **FrogCart** (installed cart) renders in the shell grid as a **spinning holographic CD** — a silver/chrome disc with a punched center hole, a hub ring, and a rainbow diffraction sheen that sweeps as it turns about the Y axis. The reference is the clear-jewel-case CD aesthetic (Yeezus / *Yandhi*): the cart *is* a disc you can almost pop out of the case. It's the cart counterpart to the **3D coins** used for system-app tiles — same disc pipeline, different mesh + shader.

---

## Why a CD

Carts are distributable, swappable "media" — the console metaphor wants them to read as physical objects, not flat icons. A coin says "button / app"; a CD says "media you slot in." Reusing the disc render path (one mesh, per-instance uniform pool, Y-spin) makes it cheap, and the holographic sheen is a pure shader effect that costs nothing extra.

| | System app | FrogCart |
|---|---|---|
| 3D form | **Coin** (solid disc, icon on face) | **CD** (annulus + hole, iridescent) |
| Surface | dark body + flat icon | silver/chrome + rainbow diffraction |
| Front face | app icon (atlas) | Phase 1: holographic · Phase 2: cover art (thumbnail) |
| Tile flag | `discIcon` (atlas key) | `cd` (boolean) |

Both replace the flat 2D tile (excluded from the 2D tile pass) and draw in the 3D disc pass over the panel.

---

## Geometry — annulus (built by `buildCD`)

A thin **ring** (disc with a punched hole), extruded along Z. Reuses the coin's vertex format (`pos3, nrm3, uv2, isFront1`) and the disc pipeline pattern.

```
outer radius   R       = 1.00     (normalized like the coin)
hole radius    rHole   ≈ 0.17     (the spindle hole)
hub radius     rHub    ≈ 0.30     (silver clamping ring around the hole)
thickness      D       ≈ 0.05     (much thinner than the 0.34 coin)
segments       48
```

Faces:
- **Top ring** (z = +D/2, normal +Z, `isFront = 1`) — UVs map the *outer* disc to [0,1]² for cover art; the shader derives the groove **tangent** from the local position.
- **Bottom ring** (z = −D/2, normal −Z, `isFront = 0`) — always holographic.
- **Outer rim** + **inner rim** (the hole wall) — short side walls; catch the Fresnel glint.

The hub ring is a **shader zone** (radius `< rHub` → plain silver, no rainbow), not separate geometry — keeps the mesh a clean annulus.

---

## Iridescence — `CD_SHADER` (diffraction grating)

The first cut faked the rainbow from radius + angle and produced **concentric rings / a swirl** — wrong. The shipping version is the **physically-based diffraction grating** from Alan Zucconi's CD-ROM shader series. The crucial idea: a CD's tracks are **circular**, so the diffraction must be measured against the **slit tangent** (the local groove direction), *not* the surface normal — that's what makes the rainbow a **radial band** instead of rings.

Fragment, per ring face:
1. **Tangent.** Local radial direction (`normalize(lxy)`) rotated 90° → the groove tangent, transformed to world space by the model matrix: `T = normalize((model · vec4(-radial.y, radial.x, 0, 0)).xyz)`.
2. **Grating term.** `u = |dot(L,T) − dot(V,T)| = |sinθ_L − sinθ_V|` — the light/view angles measured against `T` (`L` is a fixed key light, `V` the view direction). Because `T` depends only on the **angle**, `u` is constant along each radial line → the rainbow forms **radial bands** that cycle color around the disc and sweep as it spins.
3. **Spectral sum.** For harmonics `n = 1..8`, accumulate `spectral_zucconi6(u·d/n)` — the visible wavelengths satisfying `|sinθ_L − sinθ_V| = n·w/d` — then saturate. `spectral_zucconi6(w)` maps a wavelength (nm) to RGB (the real visible spectrum, not an HSV hue).
4. **Composite.** Dark steel base + a tight specular glint + a Fresnel rim, then **add** the diffraction rainbow (scaled in outside the hub). Result: dark metal between the fans, bright spectral fans over it — the high-contrast look of a real disc.
5. **Hub zone.** `r < rHub` → bright silver clamping ring.
6. **Phase 2:** on the **front** face (`isFront`), sample the thumbnail and composite the cover art under the sheen; the back stays pure spectral.

The camera is fixed (`[0,0,6.5]` looking at origin, from `drawCD`), so `V` is reconstructable in the shader. Because the mesh spins, `T` (via the model matrix) and `V` change every frame → the fans sweep for free; no time uniform needed.

**Tuning knobs:** `DGRATING` (the groove gap in nm — band density + which colors show; the dominant knob), the key-light `L`, the additive rainbow scale, and the steel base color.

> Reference: Alan Zucconi, *CD-ROM Shader: Diffraction Grating* — <https://www.alanzucconi.com/2017/07/15/cd-rom-shader-2/>

---

## Animation

Y-axis spin like the coins, but **faster** (disc-whirring feel) and **thinner**, with the same gentle bob + fixed tilt so you read the face, not the edge. Unlike the logo billboard there's no "always-front" mirror — a CD reads fine from both sides (both holographic).

---

## Render path

Extends `src/renderer/shell/shell-cartridge.ts` (the `CartridgeViewer`), alongside the coin `drawDisc`:

| Piece | What |
|---|---|
| `buildCD(R, D, rHole, segs)` | annulus geometry |
| `CD_SHADER` + `cdPipeline` | diffraction-grating shader, cullMode `none`, depth (`spectral_zucconi6` + `bump3y` helpers) |
| per-CD uniform pool | shared with the coin pool (one buffer per draw per frame) |
| `drawCD(encoder, view, w, h, region, cover, timeSec, slot)` | one CD into a tile's screen rect, own depth pass; `cover` = cover-art rect (P2, `null` for now) |

Wiring: `cd?: boolean` on `ShellTileSpec` + `RenderTile`. The manager sets it for `remote`/`local` cart slots (`shell-ui-manager.ts → buildSpecs`). The renderer excludes `cd` tiles from the 2D tile pass and renders them in the 3D disc loop (`cd → drawCD`, else `discIcon → drawDisc`).

---

## Phases

- **P1 — holographic (current).** Both faces silver + rainbow; previewed via a **temporary demo cart** tile (a `kind:'remote'` spec with `cd:true`, in-memory only) so the look can be tuned before the upload path exists.
- **P2 — cover art.** Front face composites the cart thumbnail under the sheen.
- **P3 — real carts.** When FrogCart upload → OPFS lands (Shell Phase 4), installed carts populate `remote`/`local` slots and get CDs automatically; drop the demo.

---

## Related
- [specs/billboard3d.md](billboard3d.md) — the 3D-cutout primitive (system-app icons / hero logo)
- [specs/shell-ui.md](shell-ui.md) — shell design intent + phase plan
- [reference/23-shell-architecture.md](../reference/23-shell-architecture.md) — shell architecture + the disc/coin tile system
- `src/renderer/shell/shell-cartridge.ts` — coins (`drawDisc`) + CDs (`drawCD`)
