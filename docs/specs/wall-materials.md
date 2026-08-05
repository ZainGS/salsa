# Wall Materials — bringing the ground's relief to building facades

> **Deliverable of this pass:** this SPEC + Phase 1. The rest lands phased, screenshot-tuned. Save as
> `docs/specs/wall-materials.md` (+ backlog line + memory pointer). Companion: [[city-visual-upgrade]] (the anime-city
> look — this is its "rich close-up material detail" pillar), [[city-detail]], [[procedural-ground]] (the relief
> technique this reuses).

## Context — the flatness, diagnosed
The city has a rich procedural **material library** (`GROUND_SURFACES` — ashlar/brick/granite/slate/sandstone/
concrete/cobble/plank/…) driven by the **`groundShade`** shader mode, which does the real thing: recessed grout
seams, a **height→normal relief**, per-tile roughness, and weathering profiles. **But it is wired to HORIZONTAL
surfaces only** — roads (asphalt), sidewalks (concrete), plaza (ashlar), courtyard (cobble), parking, biome rock.

**Building walls never got it.** A wall (`world:bldg-*`) is a flat `color` tint + the `windows` PATTERN (mode 6),
which punches window openings and paints a brick-course / concrete-speckle **albedo** multiplier between them. The
window OPENINGS already get relief (the FS bevels the reveal off the `patternMask` gradient), but the masonry
SURFACE — bricks, mortar joints, panel seams — is **albedo only, geometrically flat**. That is the "surfaces look
flat" the eye catches: the ground has 3-D material, the walls that fill most of the screen do not.

## The key realization — no new flag, no slot repurposing, no extra geometry
Walls already run the `windows` pattern (mode 6). The FS already computes a relief normal from **three
`patternMask` samples** (`patMask`, `patMask+εx`, `patMask+εy` → gradient → tilt `N`; mesh3d-shaders.ts ~L1471,
L1536). For mode 6, `patternMask` returns only the **window-opening mask**. And crucially, **for mode 6 the albedo
is overridden by `windowShade`** (`patBase = ws.base`), so `patMask`'s value is used ONLY for the relief gradient.

⇒ We can turn `patternMask`'s mode-6 return into a full **height field** (opening recess + masonry relief) purely
for the normal, and it costs nothing else: no new material flag (all 25 bits are used anyway), no instance-slot
repurposing (it's the SAME pattern mode walls already use), no new uniforms, no extra draws. The existing 3-sample
gradient machinery picks the masonry relief up automatically.

## Phase 1 — masonry relief in the windows height field  *(this pass)*
Enrich `patternMask(mode==6u)` to return `opening + masonry·(1−opening)`:
- **brick** (`wallStyle < 0.5`): recess the running-bond MORTAR joints — `masonry = (1 − brickFace)·k`, so mortar
  grooves and bricks stand proud. Reuse `windowsPattern`'s brick cell math (8×18 sub-cells, half-brick row offset).
- **concrete/precast** (`0.5 ≤ wallStyle < 1.5`): recess the PANEL SEAMS — `masonry = (1 − seam)·k` (shallower `k`).
- **curtain / ribbon** (`wallStyle ≥ 1.5`): no masonry relief (glass skin / spandrel) — keep just the opening bevel.

Constraints (verified in the shader):
- **fwidth uniformity**: `patternMask` runs inside `if (mode==6u)`, and a single instanced draw can batch mixed
  materials → that branch is NOT guaranteed uniform, so **no new `fwidth` inside it**. Use FIXED joint widths for
  the height field (the ±ε relief sampling already provides the anti-aliasing); the existing `w` at the top of
  `patternMask` (unconditional) stays as-is.
- **Height, not albedo**: only the returned scalar changes. `windowShade` still owns the wall COLOUR (bricks stay
  the painted brick/concrete tint) — we're adding the 3-D, not repainting.
- **Keep it subtle**: `k ≈ 0.15–0.20` of the opening depth. Bricks are ~1 cm proud, not trenches; over-driving it
  makes a wall of corduroy. Screenshot-tune `k` + `reliefK`.

## Phase 2 — a real wall SURFACE library + per-building identity
Today `wallStyle` is one float encoding brick(0)/concrete(1)/curtain(2)/ribbon(3), chosen per building in
`streets.ts`. Extend it into a proper facade-material set with distinct albedo + relief + roughness:
- **stucco** (troweled micro-relief + hairline cracks), **precast panel** (big panels, chamfered reveals),
  **glazed tile** (small ceramic grid, glossy), **corrugated/metal** (industrial), **timber** (machiya), on top of
  the existing brick / concrete / curtain / ribbon.
- Per-building selection from `category`/`district`/`seed` (mirrors the trim-colour + zone logic already there), so
  a street reads as varied materials, not tinted clones. Where a value can't fit `wallStyle`'s range, thread it via
  the window pattern's existing params (freq/inset/litFrac are taken; the spare is the material index) — still no new
  flag. If more knobs are needed, a follow-up can migrate walls to the `groundShade` recipe directly (they share the
  pattern slots — the wall would then own them, and windows move to a companion overlay layer).

## Phase 3 — trim, cornices, window surrounds
The flat brown/green boxes (window surrounds, cornices, parapets, sills) are plain-colour `obox`es with no surface
treatment. Give them a light value grain + edge/cavity darkening (cheap per-fragment, like the wall grain) or route
the metal-painted ones through the existing `metalShade`. Small geometry-free win once the walls read right.

## Phase 4 — lighting + glass (supporting)
- Rebalance ambient/key contrast so the new relief actually catches raking light (high flat ambient washes relief
  out — the relief is only as good as the lighting gradient over it).
- Ensure the glass-quality toggle is on so windows reflect the sky (they already can via `glassEnhance`); pairs with
  the interior-mapping depth already present.

## Phasing
1. **Masonry relief** (this pass) — brick mortar + concrete seams grooved in the windows height field. Contained,
   no new flag/slot/geometry. Typecheck + tests + build; then screenshot-tune `k`.
2. **Wall material library** — stucco/precast/tile/metal/timber + per-building selection.
3. **Trim/cornice/surround** grain + edge AO.
4. **Lighting + glass** support pass.

## Risk / rollback
Phase 1 touches ONE shared shader function (`patternMask` mode-6 return) + is height-only (albedo untouched). Worst
case a wrong sign makes bricks recess instead of proud — a one-line flip. No data/geometry/flag changes, so it can't
break persistence or other materials. Browser-verify the relief direction + `k` after build.
