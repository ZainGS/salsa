# Clothing Panel — Frogmarks UI Integration

**Last Updated:** 2026-06-28 (added the **Shoes** slot + the pants **Stack** (baggy) + the **shoe-floor coupling** — §4b/§6b · **shoe `topCover` vamp + `shaftHeight` ankle tube** — closed uppers, sandals, high-tops, boots · **colour stays editable after painting** — §5b re-tint · **Socks** slot — §4c, `legHeight` ankle→thigh-high)
**Engine spec:** [clothing-generation.md](../specs/clothing-generation.md) · [shoe-generation.md](../specs/shoe-generation.md) · [character-variety.md](../specs/character-variety.md) §6 (the baggy stack)
**Sibling UI docs:** [character-creator.md](./character-creator.md) (body + eyes), [hair.md](./hair.md) (same panel pattern), [kitbash.md](./kitbash.md) (part swap).

Build a **Clothing** panel under *Edit Character* with four sub-tabs — **Top**, **Bottom**, **Shoes**, and **Socks** — that generate **chunky low-poly garments** from presets + sliders. Each control writes into one `ClothingParams` object and calls `setClothingParams3D` for a **live** update. Garments are **auto-rigged** (joint-blend weights on the body's skeleton) so they pose with the body, and each saves as a **kitbash slot part**.

> **Status:** Top / Bottom / Shoes / Socks are fully wired — live sliders, presets, persistence (survives reload), bake-to-part. NEW: the **pants `stack`** (baggy/accordion) and the **§6b shoe-floor coupling** (pants pile *on* the equipped shoe, never clipping); **Socks** (`legHeight` ankle→thigh-high, under the shoe). Pixel-paint, dresses/jackets, and skirt jiggle are later phases.

---

## 0. Prerequisite

Clothing fits a **rigged body** (from the Body panel) — it reads the body's skeleton + surface. No body → `setClothingParams3D` is a no-op. Show the panel only once a body exists. Top and bottom are independent (two slots).

---

## 1. Flow

```
Edit Character ▸ Clothing      [ Top | Bottom ]
   ┌─────────────────────────────────────────────┐
   │  Preset: [ Tee ▾ ]                            │
   │  Neckline [round ▾]  height ●  hem ●          │   ← Top tab
   │  Sleeves  length ●  width ●  cap ●  inset ●   │   ← inset = shoulder seam: 0 bare-shoulder gap → 1 full
   │  Colour  base [■]  trim [■]  ☑ gradient        │
   │  [ Remove top ]            [ Save as part ]    │
   └─────────────────────────────────────────────┘
```

1. On open (per tab) → seed a local `ClothingParams` from `getDefaultClothingParams3D(slot)` and apply once.
2. Every control edits that object → `setClothingParams3D(bodyMeshId, params)` (live; debounce ~40 ms).
3. **Preset dropdown** → `getClothingPreset3D(slot, name)` → replace the params + re-apply.
4. **Remove** → `removeClothing3D(bodyMeshId, slot)`. **Save as part** → `bakeClothingToPart3D(bodyMeshId, slot, name)`.

> **⚠ Seed every control from the params object — not the slider's min/max.** Each slider/dropdown must initialize to the *value* from `getDefaultClothingParams3D(slot)` / the preset (e.g. **Hem starts at 0.2**, sleeve **Width at 0.01**), and stay two-way-bound to `params[field]`. A panel that defaulted its sliders to max shipped a chest-**cropped** shirt (Hem pinned at 1.0) with oversized sleeves — the values were right in the engine but the UI never read them.

---

## 2. API (✅ live now)

> **Base layers + patterns (2026-06-29).** Two more slots — **`undershirt`** + **`underpants`** — **skin-tight** layers worn UNDER the top/bottom that peek out below (undershirt `hemExtend` drops the hem below the main top, `crop` 0→1 raises it to a bare-midriff crop; underpants `legExtend` brief→boxer). Both base layers are built as the body's **own surface offset outward by ~1 mm** (the same offset-surface technique as the sleeves + socks) — so each literally *is* the skin + a hair: it can't clip, can't flare, isn't lumpy. The **undershirt** = the torso rings (and the captured rings stop at the pelvis, so it physically can't reach the split-legs zone); the **underpants** = the pelvis seat splitting into two short legs, with the crotch closed exactly like the body. They're **always skin-tight, always inside the outer garment, and never poke the skin** — **unconditionally**, with **no fit-gap slider** (the old `thickness` fit control is ignored; the host can drop that slider). **Any garment** can carry a `pattern` (`{ mode: stripes/dots/diamonds/checker/grid, secondaryColor, freq, angle, scale, spacing }`, optional on every `ClothingParams`) — rendered analytically in-shader, antialiased (crisp at any zoom). Base layers default to a pattern; add a **Pattern** sub-panel (mode dropdown + secondary colour + freq/angle/scale sliders) reusable across all garment tabs.
> **Presets:** `clothingPatternPresetNames3D()` → `['None','Pinstripe','Stripes','Diagonal','Polka Dots','Micro Dots','Argyle','Harlequin','Checkerboard','Gingham','Grid','Graph']`; `clothingPatternPreset3D(name)` → a `ClothingPattern` to drop on `params.pattern` (then `setClothingParams3D`) — wire these as the Pattern sub-panel's preset dropdown. See [procedural-patterns.md](../specs/procedural-patterns.md).

```ts
getDefaultClothingParams3D(slot: 'top'|'bottom'|'shoes'|'socks'|'undershirt'|'underpants'): ClothingParams;   // …undershirt = striped tee · underpants = dotted boxer
getClothingPresetNames3D(slot): string[];                          // Top: Tee/Crop/Tank/Long Sleeve · Bottom: Skirt/Mini Skirt/Shorts/Pants/Baggy Jeans/Wide Leg/Skinny · Shoes: Sneaker/Flat/Sandal/High Top/Boot/Heel · Socks: Crew/Ankle/Knee High/Thigh High/Tube Sock
getClothingPreset3D(slot, name): ClothingParams;

setClothingParams3D(bodyMeshId, params): void;                     // build/update that slot, live
getClothingParams3D(bodyMeshId, slot): ClothingParams | null;
removeClothing3D(bodyMeshId, slot): void;

bakeClothingToPart3D(bodyMeshId, slot, name): string | null;       // → kitbash slot part id (session-local GLB)
```

`params.slot` (`'top'` | `'bottom'` | `'shoes'` | `'socks'`) tells the engine which generator to run — keep it set correctly on the object.

---

## 3. `TopParams` → controls

| Field | Control | Range / options | Default |
|---|---|---|---|
| `neckline` | dropdown | `round` \| `v` \| `crew` \| `collar` | `round` |
| `necklineHeight` | slider | 0 (scoop, bares the sternum) – 1 (high crew at the throat) | **0.8** |
| `hemHeight` | slider | **−0.45 (long/tunic, ~crotch) · 0 (at hips) · 1 (crop, at chest)** — negative = longer than the hips | 0.2 |
| `thickness` | slider | 0 – 0.05 (offset off the body) | 0.012 |
| `shoulderCoverage` | slider | 0 (tank) – 1 (full shoulder) | 0.8 |
| `sleeveLength` | **slider** | **0 = none → 1 = full (wrist)**; ~0.2 cap · ~0.55 elbow · ~0.8 ¾-length (continuous) | 0.5 (short) |
| `sleeveWidth` | slider | **0 – 0.04** (whole-sleeve looseness over the arm; this is the sleeve's main looseness knob) — floored at the min gap, so low values can't clip | 0.005 |
| `sleeveCap` | slider | **0 – 1** (0 = fitted → 1 = puffy ≈ 1.3× the deltoid) — **shoulder flare only** | 0.1 |
| `sleeveInset` | slider | **0 – 1.5** — where the **shoulder seam** sits: **0 = flat armhole (bare-shoulder / strappy, a deliberate GAP)** · **1 = full shoulder coverage** · ~1.5 = climbs toward the neck. The sleeve's top edge sweeps in toward the torso, the armpit stays put | 1.0 |
| `baseColor` | colour | hex | `#e85a8a` |
| `trimColor` | colour | hex (hem/collar, used when gradient) | `#ffffff` |
| `gradient` | toggle | bool (off → flat base) | false |
| `trimWidth` | slider | 0 – 0.5 (gradient band size) | 0.12 |
| `chunkiness` | slider | 0 – 1 | 0.3 |

> **⚠ Relabel `hemHeight` → "Length" (recommended).** `hemHeight` reads *backwards* (1 = cropped, 0 = at hips, **negative = longer/tunic**). Show a **"Length"** slider where higher = longer, and map it: **`hemHeight = 1 − Length·1.45`** (Length **0** = crop · ~**0.69** = at the hips · **1** = tunic at ~the crotch — the longest a one-piece top reaches before the legs split). Seed it back with `Length = (1 − hemHeight)/1.45`. The engine clamps `hemHeight` to `[−0.45, 1]`, so the slider can't make the top run into the legs. (This is what lets a top go **longer than the hips** — the old 0–1 "Crop" slider bottomed out at the hips.) `thickness` is effectively a **"Looseness/Fit"** dial (see §5) — relabel that too.

> **⚠ `sleeveLength` is now a continuous slider (0 → 1), not a `none`/`short`/`long` dropdown.** Swap the dropdown for a 0–1 slider (0 = sleeveless, ~0.2 cap, ~0.55 elbow, ~0.8 ¾, 1 = full wrist). **Old saves migrate automatically** — the engine coerces the legacy strings, and `getClothingParams3D` / presets / `getDefaultClothingParams3D` now always return a **number** for this field, so the slider can bind to it directly. (Presets: Tee = 0.5, Crop/Tank = 0, Long Sleeve = 1.)

> **`sleeveInset` — where the shoulder seam sits (the "gap" knob).** Sweeps the **top** of the sleeve's armhole in toward the torso so it covers the long shoulder-top, while the armpit stays put. **0 = flat armhole** → the shoulder reads as a bare-shoulder / tank-top-strap **gap** (some looks want this — off-shoulder, strappy); **1 = full shoulder coverage** (a normal shirt — the default); **~1.5 = climbs toward the neck** (very covered, dropped-shoulder). It's a per-garment slider, so each top keeps its own value; **old saves default to 1** (full coverage). Independent of `shoulderCoverage`, which insets the **torso shell's** upper rings, not the sleeve.

## 4. `BottomParams` → controls

| Field | Control | Range / options | Default |
|---|---|---|---|
| `bottomStyle` | dropdown | `skirt` \| `shorts` \| `pants` | `skirt` |
| `waistWidth` | slider | 0.6 – 1.4 (**"Waist"** — scales the pants/shorts waistband, **wide real-authority range**: `0.6 → 0.6×` (**cinched**) · `1.0 → 1.0×` (natural) · `1.4 → 1.4×` (**baggy flare**). Front/sides slim with the slider; the back always rides over the butt (cinching never exposes it). **Floor = the body** — the de-collision won't let it clip *into* the hips, so you can't cinch tighter than the character's actual hips; to slim further, reduce the body's hip width or raise the **Rise** so the band sits at the narrower waist. Skirt uses its own waistR mapping.) | **0.7** (slim) |
| `waistHeight` | slider | −0.5 – 0.5 (**rise** — waistband up/down. At high rise the band now **samples the body at that height** (hips→spine), so it hugs the narrower waist instead of floating off it.) | 0 |
| `length` | slider | 0 – 1.15 (skirt/leg length; **0 = short, 1 = full to ankle** — works for pants now) | 0.45 |
| `flare` | slider | 1 – 3 (skirt hem widen; skirt only) | 1.6 |
| `legWidth` | slider | **1 – 3** (**"Leg Width"** — pants/shorts: **1 = fitted to the leg → 2-3 = wide/baggy drape**. The de-collision only pushes out, so a wider value is never pinned back. Ramped in below the waist) | **1** |
| `stack` | slider | 0 – **3** (**"Stack"** — pants only: gathers **bunched accordion folds** at the cuff at a **FIXED length** (does NOT extend the hem down). The hem rests on the shoe if one is equipped) | **0** |
| `cuffTaper` | slider | 0 – 1 (**"Taper"** — pants only: narrow the leg toward the cuff → **skinny jeans**; opposes Stack. The de-collision hugs it to the leg, no clip) | **0** |
| `thickness` | slider | 0 – 0.05 | 0.012 |
| `baseColor` | colour | hex | `#5a6ab0` |
| `trimColor` | colour | hex | `#ffffff` |
| `gradient` | toggle | bool | false |
| `trimWidth` | slider | 0 – 0.5 | 0.12 |
| `chunkiness` | slider | 0 – 1 | 0.3 |

The interfaces (for typing the local objects):

```ts
interface TopParams {
  slot: 'top';
  neckline: 'round' | 'v' | 'crew' | 'collar';
  necklineHeight: number; hemHeight: number; thickness: number; shoulderCoverage: number;
  sleeveLength: number;   // 0 none → 1 wrist (continuous; was 'none'|'short'|'long' — old saves auto-migrate)
  sleeveWidth: number; sleeveCap: number;
  sleeveInset: number;    // shoulder-seam slant: 0 = bare-shoulder gap → 1 = full coverage → ~1.5 toward neck (old saves → 1)
  baseColor: string; trimColor: string; gradient: boolean; trimWidth: number; chunkiness: number;
}
interface BottomParams {
  slot: 'bottom';
  bottomStyle: 'skirt' | 'shorts' | 'pants';
  waistWidth: number; waistHeight: number; length: number; flare: number; legWidth: number;
  stack: number;          // pants baggy stack — gathered cuff folds at a FIXED length (0 none · ~0.7 baggy jeans)
  cuffTaper: number;      // pants: taper the leg toward the cuff (0 straight · 1 skinny ankle)
  thickness: number;
  baseColor: string; trimColor: string; gradient: boolean; trimWidth: number; chunkiness: number;
}
interface ShoeParams {
  slot: 'shoes';
  shoeStyle: 'sneaker' | 'flat' | 'boot' | 'heel' | 'sandal';
  soleThickness: number;  // sole slab height
  heelHeight: number;     // heel lift (0..1)
  shaftHeight: number;    // ANKLE TUBE: wrap-around shaft up the ankle (0 none/slide · ~0.3 high-top · ~0.7 boot · 1+ calf)
  topCover: number;       // VAMP: instep coverage (0 open sandal/toes out → 1 closed upper to the ankle front)
  toePoint: number;       // 0 round → 1 pointed
  ankleCollar: number;    // collar-lip height at the ankle of the LOW shoe (× foot height)
  thickness: number;
  baseColor: string; trimColor: string; gradient: boolean; trimWidth: number; chunkiness: number;
}
interface SockParams {
  slot: 'socks';
  sockStyle: 'ankle' | 'crew' | 'knee' | 'thigh';   // cosmetic label — legHeight is the real driver
  legHeight: number;      // how far up the leg the tube rises (0 no-show · ~0.1 ankle · ~0.32 crew · ~0.62 knee · 1+ thigh-high)
  thickness: number;      // fabric offset (thin — socks hug)
  baseColor: string; trimColor: string; gradient: boolean; trimWidth: number;   // trim = the cuff/toe/heel band
  chunkiness: number;
}
type ClothingParams = TopParams | BottomParams | ShoeParams | SockParams;
```

---

## 4b. `ShoeParams` → controls (the **Shoes** tab)

Footwear is a **third clothing slot** (`slot: 'shoes'`), so it reuses the *exact same* panel pattern + APIs (preset dropdown, sliders → `setClothingParams3D`, Remove, Save as part). A shoe **wraps each foot** (auto-fit to the body's `foot_L/R` from the foot's surface) and **poses with the foot**.

| Field | Control | Range / options | Default |
|---|---|---|---|
| `shoeStyle` | dropdown | `sneaker` \| `flat` \| `boot` \| `heel` \| `sandal` | `sneaker` |
| `soleThickness` | slider | 0 – 0.06 (sole slab height) | 0.03 |
| `heelHeight` | slider | 0 – 1 (lift at the heel — heels / boots) | 0 |
| **`topCover`** | slider | **0 – 1** (**vamp / instep coverage** — 0 = open, toes out · ~0.85 = closed low-top · 1 = covered to the ankle front) | **0.85** |
| **`shaftHeight`** | slider | **0 – 1.5** (**ankle tube** — 0 = slide/low shoe · ~0.3 = high-top · ~0.7 = ankle boot · 1+ = up the calf) | 0 |
| `toePoint` | slider | 0 (round toe) – 1 (pointed) | 0.1 |
| `ankleCollar` | slider | 0 – 1 (collar-lip height at the back of the low shoe) | 0.25 |
| `thickness` | slider | 0 – 0.03 (offset over the foot) | 0.006 |
| `baseColor` / `trimColor` / `gradient` / `trimWidth` / `chunkiness` | as Top/Bottom | — | dark; **trim OFF by default** (`trimWidth 0`) |

- **`topCover`** closes the open top from the **toe backward**: low values bare the instep (sandal/slide), high values dome a closed upper over the foot up to the ankle front. The default sneaker is now **closed** (no more exposed toes).
- **`shaftHeight`** grows a **wrap-around tube around the ankle** (skinned foot→lower-leg, so it bends): slide → high-top → boot → calf. It hugs the ankle automatically (de-collision).
- **Presets:** `Sneaker` (closed low-top, default) · `Flat` · `Sandal` (open vamp) · `High Top` · `Boot` · `Heel` — via `getClothingPreset3D('shoes', name)`.
- **No extra action for the pants** — equipping shoes (or changing them) **auto-re-piles** the pants on top (§6b). Order doesn't matter.

---

## 4c. `SockParams` → controls (the **Socks** tab)

The **fourth clothing slot** (`slot: 'socks'`) — same panel pattern + APIs as the others. A sock = a **thin foot-hugging sock-foot** + a **leg tube** that climbs the ankle/shin/thigh, skinned foot→lower-leg→upper-leg so it bends. Socks layer **under shoes** (the shoe sits outside the thinner sock), so the visible part is the leg above the shoe.

| Field | Control | Range / options | Default |
|---|---|---|---|
| `sockStyle` | dropdown | `ankle` \| `crew` \| `knee` \| `thigh` (cosmetic label / preset hint) | `crew` |
| **`legHeight`** | slider | **0 – 1.3** (**how far up the leg** — ~0.1 ankle · ~0.32 crew · ~0.62 knee · ~1.0 thigh-high; 0 = no-show, foot only) | **0.32** |
| `thickness` | slider | 0 – 0.02 (looseness — **0 = skin-tight** (~1mm); socks hug the leg by default) | 0.0015 |
| `baseColor` / `trimColor` / `gradient` / `trimWidth` / `chunkiness` | as the others | — | cream; **trim = the cuff/toe/heel band** |

- **`legHeight`** is the one knob that matters — it grows the tube from the ankle up. The tube is **under-sized and hugged to the leg by the de-collision**, so it snaps to the calf/thigh shape automatically.
- **Trim band:** with `gradient:false` the `trimColor` lands as a crisp band at the **cuff (top), toe, and heel** (athletic-sock look). `trimWidth` sizes it; set `trimWidth:0` for a plain sock. `gradient:true` = a soft toe→cuff fade.
- **Presets:** `Crew` (default) · `Ankle` · `Knee High` · `Thigh High` (black, the aesthetic) · `Tube Sock` (white + red bands) — via `getClothingPreset3D('socks', name)`.
- **Layering with shoes is automatic** — both fit to the body, the shoe has the larger offset, so it encloses the sock-foot. No ordering or coupling needed.

---

## 5. Wiring sketch

```ts
// per tab, on open:
let params = shapeManager.getClothingParams3D(bodyMeshId, slot)
          ?? shapeManager.getDefaultClothingParams3D(slot);
shapeManager.setClothingParams3D(bodyMeshId, params);

// on control / dropdown change (debounced):
params = { ...params, [field]: value };
shapeManager.setClothingParams3D(bodyMeshId, params);

// preset:
params = shapeManager.getClothingPreset3D(slot, presetName);
shapeManager.setClothingParams3D(bodyMeshId, params);
```

- **Dropdowns must call `setClothingParams3D` too** (not just sliders), and keep `params.slot` intact.
- **Live preview is the real mesh** (regenerated each call — cheap; poses with the body automatically).
- **Auto-fit (no-clip):** the torso/legs are sized to **enclose the body's actual surface** at each level (per-direction, 12-sided rings → they follow the body closely, not boxy). The **sleeves are built as the body's *real* arm surface, offset outward** — the generator hands the clothing system its actual arm rings (armhole/socket → deltoid → … → wrist) and the sleeve *is* those rings pushed off the skin, cut to the chosen length. So a sleeve genuinely follows the **shoulder/deltoid bulge and the armpit** (it can't read as a straight tube, because it's the shoulder itself, offset). Skin never pokes through, on any body or height.
- **`thickness` = "Looseness".** It's the air-gap offset and is **floored at a minimum** — so no matter how low it goes the garment **can't clip into the body**. The **torso is fitted** (it uses only ~55% of Looseness, so the shirt body hugs the mesh), while the **sleeves use the full Looseness** — so raising it puffs the sleeves much more than the body. If you want *fully independent* body-vs-sleeve looseness, ask and I'll split it into two params.
- **Crotch (pants/shorts):** the two leg tops overlap past the inseam, so the crotch is filled with fabric (no skin poking through). Raise **Waist** for more coverage there if needed.
- **Each leg / shoe is independent — no web (posing):** when you kick/splay the legs, each pant leg + each shoe follows **its own limb** (no sheet stretching across to the other). The fit pass's weight transfer is **same-side guarded** (a left-limb vertex can never inherit a right-limb weight), plus the crotch fabric keeps its per-leg weight. (A skirt is a *separate* one-piece cone — `bottomStyle: 'skirt'` — and stays a sheet by design; a swishy/leg-aware skirt is a future **spring-bone** upgrade, see `docs/ui/armature.md` → Spring Bones.)
- **Pants ↔ shoes (§6b — the baggy stack):** with a **shoe equipped**, the pant cuff **rests on the shoe's top and PILES** there — the **Stack** slider drives how much fabric bunches **on** the shoe, and it **never clips below it**. No shoe → it pools at the ankle. This is automatic (the bottom reads the equipped shoe as its floor; adding/changing shoes re-piles the bottom). Equip **Baggy Jeans + Sneaker** and raise **Stack** for the stacked-jeans look. *(Pile/drape numbers are still being tuned from screenshots.)*
- **Butt coverage:** the hip cross-section is carried down over the butt (back hemisphere) so the projecting butt doesn't poke through the band just below the waist. Leg/torso rings are dense enough that the body can't slip through a face between rings. If a specific spot still clips on a pose, tell me where.

---

## 5b. Pixel-paint a garment ✅ (prints / seams / logos)

Garments are UV-paintable using the **same UV-paint pipeline as the body** — each piece (torso, each sleeve, each leg) now has its own non-overlapping UV island, so a stroke stays on the piece you're painting. The paint **persists** with the document and **survives shape-slider edits** (it's re-applied to the regenerated garment).

```ts
// Get the garment's mesh id for a slot, then enter paint mode on it (optionally with a UV pane):
const meshId = shapeManager.getClothingMeshId3D(bodyMeshId, 'top');
if (meshId) shapeManager.enterUVPaintMode3D(meshId, uvRenderer ?? null);
// …brush on the 3D garment (and/or the UV pane). Shared 2D brush (color/size/erase) applies.
shapeManager.exitUVPaintMode3D(meshId);
```

- Wire a **"Paint" toggle** in the Clothing panel (mirrors the body/UV-paint flow). While active, **pause Frogmarks's own UV-pane interaction** (the controller owns pointer input), exactly like the existing UV paint.
- **Trim:** openings get a crisp **trim colour band** (hem/collar/cuffs). *(The raised folded-cuff geometry is currently disabled — `ENABLE_CUFFS = false` in `clothing-generator.ts` — leaving just the flat trim band; flip it back on if you want folded cuffs.)*
- Entering paint **seeds the canvas from the garment's current base + trim colour**, so you paint *on top* of the existing look rather than over blank white.
- **Eraser has 3 modes ✅ (cloth only)** — set with `setGarmentEraseStyle3D('burn' | 'clean' | 'cutout')` (read back with `getGarmentEraseStyle3D()`); wire a little segmented control next to the eraser:
  - **`'burn'`** (default) — erases by painting white with the brush's **grain + soft edge**, leaving a scorched/feathered border (the cool look you noticed).
  - **`'clean'`** — a sharp, grainless, hard white dab — no border.
  - **`'cutout'`** — a real **alpha hole** (the body shows through) → **distressing / rips / mesh panels**. The brush's soft edge frays the rim. Holes **persist** + survive regens; paint any colour back over a hole to fill it. *(This is the wardrobe-expansion "cutouts" item — §see [wardrobe-expansion.md](../specs/wardrobe-expansion.md) Phase 1B.)*
- **Colour stays editable after painting ✅** — changing `baseColor` / `trimColor` / `gradient` / `trimWidth` on a *painted* garment **re-tints the fabric you didn't paint over and keeps your strokes** (the engine recolours only the texels still matching the old colour). So the **Base/Trim colour pickers keep working** after a paint — no need to reset. *(Caveat: a stroke painted in nearly the **exact** old base colour can re-tint with the background — paint a hair off the base colour if you want it pinned.)*

---

## 6. Caveats (Phase 1)

- **Color = flat base + crisp trim band (or gradient).** With `gradient:false` (default), you get a flat `baseColor` plus a **crisp `trimColor` band at every opening** — hem, collar, sleeve cuffs, leg cuffs — sized by `trimWidth` (this is the reference's clean white trim; defaults already ship it). With `gradient:true` you get the old soft `baseColor`→`trimColor` fade instead. Set `trimWidth:0` (or `trimColor = baseColor`) for no trim. *(Raised folded-cuff geometry exists but is currently OFF — `ENABLE_CUFFS = false`.)* **Pixel-paint** for prints/seams is now available (§5b).
- **Fit is rest-pose-guaranteed.** Garments enclose the body in the default pose; in extreme poses the coarse low-poly rings can nip slightly (inherent to low-poly skinning) — raise `thickness` if it shows.
- **Shorts/pants are basic** (two wide-topped leg tubes; the crotch join is rough and usually sits under the top). They still use the **simpler scalar fit** (the per-direction no-clip fit is on the **top + sleeves**) — if a leg clips, it can get the same treatment. The **skirt** (flares away from the body) is the polished default. Dresses/jackets = Phase 2.
- **Persistence works** — garments save with the document (params regenerate on load), incl. `.frogmarks` export.
- **Bake-to-part is session-local** — `bakeClothingToPart3D` registers a kitbash part via an in-memory GLB URL; the bytes aren't written to disk yet (full library persistence is a follow-up). The part swaps within the session.
- **First-cut geometry** — sizes/placement are tuned against live screenshots; field ranges may shift slightly.
