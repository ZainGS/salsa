# Clothing Panel — Frogmarks UI Integration

**Last Updated:** 2026-06-23 (Phase 1 + auto **no-clip fit**: garments now enclose the body's actual surface — see §5)
**Engine spec:** [clothing-generation.md](../specs/clothing-generation.md)
**Sibling UI docs:** [character-creator.md](./character-creator.md) (body + eyes), [hair.md](./hair.md) (same panel pattern), [kitbash.md](./kitbash.md) (part swap).

Build a **Clothing** panel under *Edit Character* with two sub-tabs — **Top** and **Bottom** — that generate **chunky low-poly garments** from presets + sliders. Each control writes into one `ClothingParams` object and calls `setClothingParams3D` for a **live** update. Garments are **auto-rigged** (joint-blend weights on the body's skeleton) so they pose with the body, and each saves as a **kitbash slot part**.

> **Status:** Phase 1 is fully wired — live sliders, presets, persistence (survives reload), and bake-to-part all ✅. Pixel-paint, dresses/jackets, and skirt jiggle are later phases.

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
   │  Sleeves  length ●  width ●  cap ●            │   ← length is now a slider (0=none → 1=wrist)
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

```ts
getDefaultClothingParams3D(slot: 'top'|'bottom'): ClothingParams;   // top = pink Tee, bottom = Skirt
getClothingPresetNames3D(slot): string[];                          // Top: Tee/Crop/Tank/Long Sleeve · Bottom: Skirt/Mini Skirt/Shorts/Pants
getClothingPreset3D(slot, name): ClothingParams;

setClothingParams3D(bodyMeshId, params): void;                     // build/update that slot, live
getClothingParams3D(bodyMeshId, slot): ClothingParams | null;
removeClothing3D(bodyMeshId, slot): void;

bakeClothingToPart3D(bodyMeshId, slot, name): string | null;       // → kitbash slot part id (session-local GLB)
```

`params.slot` (`'top'` | `'bottom'`) tells the engine which generator to run — keep it set correctly on the object.

---

## 3. `TopParams` → controls

| Field | Control | Range / options | Default |
|---|---|---|---|
| `neckline` | dropdown | `round` \| `v` \| `crew` \| `collar` | `round` |
| `necklineHeight` | slider | 0 (scoop) – 1 (high collar) | 0.55 |
| `hemHeight` | slider | **−0.45 (long/tunic, ~crotch) · 0 (at hips) · 1 (crop, at chest)** — negative = longer than the hips | 0.2 |
| `thickness` | slider | 0 – 0.05 (offset off the body) | 0.012 |
| `shoulderCoverage` | slider | 0 (tank) – 1 (full shoulder) | 0.8 |
| `sleeveLength` | **slider** | **0 = none → 1 = full (wrist)**; ~0.2 cap · ~0.55 elbow · ~0.8 ¾-length (continuous) | 0.5 (short) |
| `sleeveWidth` | slider | **0 – 0.04** (whole-sleeve looseness over the arm; this is the sleeve's main looseness knob) — floored at the min gap, so low values can't clip | 0.005 |
| `sleeveCap` | slider | **0 – 1** (0 = fitted → 1 = puffy ≈ 1.3× the deltoid) — **shoulder flare only** | 0.1 |
| `baseColor` | colour | hex | `#e85a8a` |
| `trimColor` | colour | hex (hem/collar, used when gradient) | `#ffffff` |
| `gradient` | toggle | bool (off → flat base) | false |
| `trimWidth` | slider | 0 – 0.5 (gradient band size) | 0.12 |
| `chunkiness` | slider | 0 – 1 | 0.3 |

> **⚠ Relabel `hemHeight` → "Length" (recommended).** `hemHeight` reads *backwards* (1 = cropped, 0 = at hips, **negative = longer/tunic**). Show a **"Length"** slider where higher = longer, and map it: **`hemHeight = 1 − Length·1.45`** (Length **0** = crop · ~**0.69** = at the hips · **1** = tunic at ~the crotch — the longest a one-piece top reaches before the legs split). Seed it back with `Length = (1 − hemHeight)/1.45`. The engine clamps `hemHeight` to `[−0.45, 1]`, so the slider can't make the top run into the legs. (This is what lets a top go **longer than the hips** — the old 0–1 "Crop" slider bottomed out at the hips.) `thickness` is effectively a **"Looseness/Fit"** dial (see §5) — relabel that too.

> **⚠ `sleeveLength` is now a continuous slider (0 → 1), not a `none`/`short`/`long` dropdown.** Swap the dropdown for a 0–1 slider (0 = sleeveless, ~0.2 cap, ~0.55 elbow, ~0.8 ¾, 1 = full wrist). **Old saves migrate automatically** — the engine coerces the legacy strings, and `getClothingParams3D` / presets / `getDefaultClothingParams3D` now always return a **number** for this field, so the slider can bind to it directly. (Presets: Tee = 0.5, Crop/Tank = 0, Long Sleeve = 1.)

## 4. `BottomParams` → controls

| Field | Control | Range / options | Default |
|---|---|---|---|
| `bottomStyle` | dropdown | `skirt` \| `shorts` \| `pants` | `skirt` |
| `waistWidth` | slider | 0.6 – 1.4 (**"Waist"** — now **scales** the waistband (real authority, pants/shorts): `0.6 ≈ 0.85×` (tight — the de-collision still pins it to the body so it can't clip) · `1.0 ≈ 1.0×` (natural hug) · `1.4 ≈ 1.20×` (loose belt). Per-sector directional (hugs the front, rides over the butt), faded into the legs so it doesn't step. **Can't go smaller than the body** — to slim the waist further, shrink the body's hips/waist or raise the Rise. Skirt still uses the old belt-offset.) | **0.7** |
| `waistHeight` | slider | −0.5 – 0.5 (**rise** — waistband up/down. At high rise the band now **samples the body at that height** (hips→spine), so it hugs the narrower waist instead of floating off it.) | 0 |
| `length` | slider | 0 – 1.15 (skirt/leg length; **0 = short, 1 = full to ankle** — works for pants now) | 0.45 |
| `flare` | slider | 1 – 3 (skirt hem widen; skirt only) | 1.6 |
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
  baseColor: string; trimColor: string; gradient: boolean; trimWidth: number; chunkiness: number;
}
interface BottomParams {
  slot: 'bottom';
  bottomStyle: 'skirt' | 'shorts' | 'pants';
  waistWidth: number; waistHeight: number; length: number; flare: number; thickness: number;
  baseColor: string; trimColor: string; gradient: boolean; trimWidth: number; chunkiness: number;
}
type ClothingParams = TopParams | BottomParams;
```

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
- **Pants split, don't web (posing):** when you kick/splay the legs, each pant leg's crotch fabric follows **its own leg**, so the legs **separate** cleanly instead of stretching a sheet between them. (A skirt is a *separate* one-piece cone — `bottomStyle: 'skirt'` — and stays a sheet by design; a swishy/leg-aware skirt is a future **spring-bone** upgrade, see `docs/ui/armature.md` → Spring Bones.)
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

---

## 6. Caveats (Phase 1)

- **Color = flat base + crisp trim band (or gradient).** With `gradient:false` (default), you get a flat `baseColor` plus a **crisp `trimColor` band at every opening** — hem, collar, sleeve cuffs, leg cuffs — sized by `trimWidth` (this is the reference's clean white trim; defaults already ship it). With `gradient:true` you get the old soft `baseColor`→`trimColor` fade instead. Set `trimWidth:0` (or `trimColor = baseColor`) for no trim. *(Raised folded-cuff geometry exists but is currently OFF — `ENABLE_CUFFS = false`.)* **Pixel-paint** for prints/seams is now available (§5b).
- **Fit is rest-pose-guaranteed.** Garments enclose the body in the default pose; in extreme poses the coarse low-poly rings can nip slightly (inherent to low-poly skinning) — raise `thickness` if it shows.
- **Shorts/pants are basic** (two wide-topped leg tubes; the crotch join is rough and usually sits under the top). They still use the **simpler scalar fit** (the per-direction no-clip fit is on the **top + sleeves**) — if a leg clips, it can get the same treatment. The **skirt** (flares away from the body) is the polished default. Dresses/jackets = Phase 2.
- **Persistence works** — garments save with the document (params regenerate on load), incl. `.frogmarks` export.
- **Bake-to-part is session-local** — `bakeClothingToPart3D` registers a kitbash part via an in-memory GLB URL; the bytes aren't written to disk yet (full library persistence is a follow-up). The part swaps within the session.
- **First-cut geometry** — sizes/placement are tuned against live screenshots; field ranges may shift slightly.
