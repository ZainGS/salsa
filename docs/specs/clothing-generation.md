# Procedural Clothing Generation — Engine Spec

**Last Updated:** 2026-06-23 (fit hardening: directional fit + shrink-wrap + weight transfer + no-clip floor)
**Status:** ✅ Phase 1 implemented + **fit pass hardened** (`clothing-generator.ts` + live API + presets + persistence + bake). Garments now **enclose the body, never clip at rest, and deform with the body when posed**. Phase 2 (UV paint / hems / dresses) + the **Clothing Designer** (§14) pending.

> **Fit pipeline (2026-06-23) — the "perfect fit, no clip" path.** §4/§5 below describe the original scalar/joint-blend approach; the current pipeline layered on top is: (1) **directional per-sector radii** — each ring vertex is sized to the body's MAX extent in that direction (not one circle), so it hugs a non-circular cross-section; (2) **12-sided rings** (`RING=12`) — rounder, less boxy, ~3.5% chord clearance; (3) **min-gap floor** — every offset is `max(Looseness, MIN_GAP)`, so no slider can pull a garment tight enough to clip; (4) **shrink-wrap / de-collision** — a final pass (`fitGarmentToBody`) projects any vertex inside/within-gap of the body OUT to `surface + gap`, smoothed over the garment so it's a soft bump not a spike, push-only so drape is preserved; (5) **weight transfer** — touching vertices inherit the nearest body vertex's skin weights, so the garment folds WITH the body when posed. The torso uses a fraction of Looseness (fitted) while sleeves use the full value. This is the deterministic, generation-time "offset shell from the body surface" the designer asked about — it runs live on every slider change.
**Sibling docs:** [clothing.md](../ui/clothing.md) (**Frogmarks panel hand-off doc**), [character-creation-pipeline.md](./character-creation-pipeline.md) (the original offset-copy / draw-inflate clothing design — now reframed as a later "tailor exact" mode), [hair-generation.md](./hair-generation.md) (the pattern this mirrors), [dollz-creator.md](./dollz-creator.md) (clothing = kit slots), [character-creator.md](../ui/character-creator.md) §4, [kitbash.md](../ui/kitbash.md).

Generate **chunky low-poly garments** from presets + sliders — the same "no-modeling, sliders + live" path as the procedural **body**, **eyes**, and **hair**. A garment is a low-poly shell built around the body and **auto-rigged by joint-blend weights** (it shares the body's skeleton, so it deforms with every pose — no manual rigging). Each piece is a **kitbash slot part** (top, bottom) and can be **baked to GLB** for the library.

> **Decisions locked (2026-06-22):** authoring = **procedural generator** (not the offset-copy editor); v1 scope = **a top + a bottom** (a complete first outfit); color = **flat base + optional trim/gradient now, UV pixel-paint later**. The offset-copy / draw-silhouette flows from [character-creation-pipeline.md](./character-creation-pipeline.md) §4 stay valid as a **later** "tailor an exact piece" mode.

---

## 0. TL;DR

```
TopParams / BottomParams  ──►  clothing-generator (MeshGeometry + per-vertex joint weights)
   (preset + sliders)             low-poly shell around the body, ring weights blended joint→joint
                                       │
                       SkinnedMesh3D on the BODY's skeleton (deforms with poses)
                                       │
        live: setClothingParams3D() regenerates the piece each slider change (cheap)
        persist: params are the source of truth → regenerate on load
        export: bakeClothingToPart3D() → GLB → kitbash top/bottom slot
```

Unlike hair (skinned 100% to one joint), a garment spans **several joints**, so each ring blends weights between the two joints it sits between — exactly how `body-generator` weights the body. That's what makes it deform correctly with no rig step. The garment is **auto-fit** to the body by sampling the body's cross-section radius at each ring and adding a thickness offset, so it works for any body shape.

---

## 1. Where it fits

```
BODY  →  EYES  →  HAIR  →  CLOTHING (this spec)  →  POSE  →  RENDER
                            top + bottom, auto-rigged
```

Requires a **rigged body** (procedural or kitbashed) — the garment reads the body's skeleton (to place rings) and surface (to fit). Complements the hand-authored kit clothing in [dollz-creator.md](./dollz-creator.md); the generator both drives a live customizer **and** bakes new slot parts.

---

## 2. Architecture

Mirror the body/hair generators:

- **`clothing-generator.ts`** (new, `src/services/managers/`) — pure functions `generateTop(fit, params)` and `generateBottom(fit, params)` → `{ geometry: MeshGeometry; jointIndices: Uint8Array; jointWeights: Float32Array }`. `fit` = the body frame: the rest-pose **joint world positions** (from the body's skeleton) + a **radius sampler** (the body's cross-section radius near a given joint/level, from the body mesh's verts). No GPU, no scene.
- **`Scene3DManager`** owns a **clothing rig per (body, slot)**: `{ bodyMeshId, slot, clothingMeshId, params }`. It builds the `SkinnedMesh3D` on the **body's skeleton** (copies `body.skeletonId`/`skeleton`), uploads the generator's jointIndices/weights, sets a flat/gradient material, adds it under the scene root, and regenerates on param change / on load.
- **`ShapeManager`** exposes the public `*3D` API.

Reuses the existing skinned pipeline (the per-mesh skin-buffer fix already supports multiple skinned meshes sharing the body's skeleton — body + face decal + hair + garments). **Shared low-poly primitives** (ring extrusion, tapered tube, cap, band) overlap `body-generator`/`hair-generator` — factor them into a small shared module.

---

## 3. Components & geometry

All low-poly (a `chunkiness` knob sets ring/segment counts). Built around the body's joints in body-local space.

### 3a. Top  (`generateTop`)
- **Torso shell** — rings around the spine from a **neckline** ring (high, at `necklineHeight` up the chest/neck) down to a **hem** ring (at `hemHeight` — crop ≈ chest, long ≈ hips). Each ring's radius = body cross-section radius at that level + `thickness`. Wrapped `RING`-sided (chunky).
  - **Neckline shape** (`neckline`): `round` (even collar), `v` (front-center dips), `crew`/`collar` (raised band) — shape the top ring's front-center vert(s).
  - **Shoulder coverage** (`shoulderCoverage`): how far the shoulder band extends out (tank ↔ full shoulder).
- **Sleeves** (`sleeveLength` = `none` | `short` | `long`) — tapered tubes down the upper arm (shoulder→lowerarm) and, for `long`, the forearm (lowerarm→hand); radius = arm radius + `sleeveWidth`.

### 3b. Bottom  (`generateBottom`, `bottomStyle`)
- **`skirt`** — a flared cone from a **waist** ring (at `waistHeight`, hip radius + thickness) down to a wider **hem** ring (radius × `flare`), `length` down from the waist. Open bottom (capless) for a skirt.
- **`shorts` / `pants`** — pelvis yoke off the waist that **splits into two tapered leg tubes** (upperleg→lowerleg), `length` setting shorts (mid-thigh) vs pants (ankle); radius = leg radius + `thickness`.

> The torso/skirt/leg tubes reuse `body-generator`'s ring + tapered-tube construction, just sized to wrap (body radius + offset) instead of being the body.

---

## 4. Fit (auto-size to the body)

For each ring at world height `y` around axis joint `J`:
1. **Radius** = sample the body mesh's verts that are weighted mostly to `J` (or near `y`), take a robust max horizontal distance from the axis → the body's cross-section radius there; add `thickness`. → the garment **hugs any body shape** (the §4.1 "fits by construction" property, achieved parametrically).
2. **Centre** = the joint world position (rest pose).

A cheap fallback when sampling is sparse: interpolate radius from the two bracketing joints' sampled radii. Fit is computed once per generate (rest pose); the **skeleton handles posing**.

---

## 5. Weights (the auto-rig)

Each ring vertex blends between the **two joints it sits between**, by the ring's normalized position along that segment — identical to how `body-generator` weights its tubes. So:
- **Top torso:** neckline→hem rings blend `chest`↔`spine`↔`hips`. **Sleeves:** `shoulder`↔`lowerarm`↔`hand`.
- **Skirt:** weighted to `hips` (a stiff low-poly skirt swings from the pelvis — correct + simplest; a 2-bone skirt-jiggle is a later option). **Shorts/pants:** waist→legs blend `hips`↔`upperleg`↔`lowerleg`.

Because the garment shares the **body's skeleton** with body-like weights, it deforms with the body under any pose/animation with **zero manual rigging**.

---

## 6. Param schema

Two slot-specific interfaces (cleaner sliders than one merged set); `slot` discriminates.

```ts
interface TopParams {
  slot: 'top';
  neckline: 'round' | 'v' | 'crew' | 'collar';
  necklineHeight: number;     // collar height up the chest (× torso)
  hemHeight: number;          // bottom edge: crop (low number) → long (past hips)
  thickness: number;          // offset from the body surface
  shoulderCoverage: number;   // tank ↔ full shoulder (0..1)
  sleeveLength: 'none' | 'short' | 'long';
  sleeveWidth: number;        // offset over the arm
  baseColor: string; trimColor?: string; gradient: boolean; trimWidth: number;
  chunkiness: number;
}
interface BottomParams {
  slot: 'bottom';
  bottomStyle: 'skirt' | 'shorts' | 'pants';
  waistHeight: number;        // where the waistband sits (× torso)
  length: number;             // skirt/leg length (× leg)
  flare: number;              // skirt hem widen (skirt only)
  thickness: number;
  baseColor: string; trimColor?: string; gradient: boolean; trimWidth: number;
  chunkiness: number;
}
type ClothingParams = TopParams | BottomParams;
```

### Presets (v1)
`getClothingPresetNames3D(slot)` → a few tuned bundles:
- **Top:** *Tee* (round neck, short sleeve, hip hem), *Crop* (round, sleeveless, high hem), *Tank* (low shoulder, sleeveless). The reference's **pink tee** = the default.
- **Bottom:** *Skirt* (flared, mid-thigh) = default, *Shorts*, *Pants*.

---

## 7. Color (flat / gradient now; paint later)

- **Flat base** — `baseColor` straight on `material.diffuse` (no texture needed); lit by the scene (PS1 retro pipeline → on-aesthetic).
- **Optional trim + gradient** — a `trimColor` band at the hem/collar (and a `gradient` top→bottom) via the same small **gradient/▮-band texture** the hair uses (sampled by `uv.v` along the garment), `trimWidth` sizing the band. Off → pure flat.
- **Phase 2 — UV pixel-paint:** generate a simple per-piece UV (torso = cylindrical island, sleeves/legs = tube islands) and route the **existing UV paint pane** so users can pixel-paint garments. Not needed for v1.

---

## 8. Live preview + commit

Cheap to regenerate (a few hundred verts) → **no separate ghost**: `setClothingParams3D(bodyMeshId, params)` rebuilds the real garment for that slot on each slider change (same model as hair). First call creates it; later calls replace geometry + weights + material in place.

---

## 9. Persistence

Params are the **source of truth** (mirror hair / face rig):
- Each clothing rig serializes its **`{ slot, params }`** into `scene3dJSON` (a `clothingRigs` array).
- The generated meshes are **excluded from node persistence** (`isClothing` flag, like `isHair`) and **regenerated from params on load** (`restoreClothingRigs` after the body + skeletons relink).
- No texture payload for v1 (colors derive from params). Works for `.frogmarks` with no new payload fields. (Phase-2 painted garments persist their PNG via the existing `meshTextures` path.)

---

## 10. Save as a kitbash part

`bakeClothingToPart3D(bodyMeshId, slot, name)`:
- Export the garment `SkinnedMesh3D` → **GLB** (`exportSceneGltf3D`) and register a `KitbashPartMeta` in the **top/bottom slot** (per [kitbash.md](../ui/kitbash.md)). Since it's bound to the canonical skeleton, it swaps onto any character. This seeds the kit and lets users publish outfits.

---

## 11. API sketch (`ShapeManager`)

Mirrors the hair + body APIs.

```ts
getClothingPresetNames3D(slot: 'top'|'bottom'): string[];
getClothingPreset3D(slot, name): ClothingParams;
getDefaultClothingParams3D(slot): ClothingParams;     // top = pink Tee, bottom = Skirt

setClothingParams3D(bodyMeshId, params: ClothingParams): void;   // build/update that slot, live
getClothingParams3D(bodyMeshId, slot): ClothingParams | null;
removeClothing3D(bodyMeshId, slot): void;

bakeClothingToPart3D(bodyMeshId, slot, name): Promise<string>;   // → GLB + kitbash part id
```

Frogmarks panel — **Edit Character → Clothing**, two sub-tabs (**Top** / **Bottom**): preset dropdown + sliders → `setClothingParams3D` on change (live) → **Save as part**. Same shape as the Body/Eyes/Hair panels.

---

## 12. Phases

- **Phase 1 (v1) ✅ + hardened (2026-06-23):** `clothing-generator.ts` (top: torso shell + neckline + sleeves; bottom: skirt + shorts/pants), auto-fit + joint-blend weights, flat/gradient+trim color, `setClothingParams3D` live, the slot presets, params persistence (regenerate on load), `bakeClothingToPart3D` (now **persists** its GLB to the document). **Fit hardened:** directional per-sector radii, `RING=12`, min-gap floor, shrink-wrap de-collision + weight transfer (see header note), sleeve cap opens at the shoulder (no under-armpit flap).
- **Phase 2 (next):** **procedural hems/cuffs/trim** (a raised band of geometry at the neckline/sleeve-end/hem, like the reference's white trim) + **UV unwrap + pixel-paint** garments (prints, seams — route the existing UV paint pane); dresses (one-piece) + jackets; **layering offset** (jacket-over-shirt z-fight) and skirt **jiggle** (2-bone).
- **Phase 3:** **draping/gravity** — a post-pass on the offset shell (gravity-droop relaxation or a light cloth solver) so loose fabric hangs/folds instead of floating; **smoother topology** (optional subdivision). The **offset-copy "tailor exact"** editor (§4.1) + **draw-the-silhouette** loose garments for bespoke pieces.
- **Phase 4 — Clothing Designer (§14):** design a garment standalone (on an invisible mannequin), save it as a reusable preset/part, then fit it to any character.

---

## 13. Risks / open questions

- ~~**Radius sampling vs the rough mannequin:**~~ ✅ addressed — per-sector directional radii + the shrink-wrap pass enclose the body by construction (no clip at rest, any body shape).
- **Clip-through on extreme poses:** ✅ much improved — **weight transfer** makes the garment fold with the body, so joint clipping is far less. Not 100% (the hidden crotch-overlap can still nip when a leg lifts); a cloth/collision solver (Phase 3 draping) is the ceiling.
- ~~**Layering / z-fight with skin:**~~ ✅ the min-gap floor (`MIN_GAP`) guarantees a clearance the Looseness slider can't go under. **Garment-over-garment** layering (jacket on shirt) is still open (Phase 2 layer offset).
- ~~**Sleeve ↔ arm seam:**~~ ✅ the sleeve cap is sized to the deltoid and opens at the shoulder (no gap, no under-armpit flap). A proper *scooped* cap (higher over the shoulder, shorter at the underarm) is a Phase-2 polish.
- **Weight-copy:** ✅ now used as a **complementary** pass — touching garment verts copy the nearest body vertex's top-2 weights; far verts (skirt flare) keep analytic weights so they stay stiff.

---

## 14. Future — Clothing Designer (design standalone → save → fit to any character)

> **Idea (2026-06-23, deferred — documented for later).** Today clothing is generated **onto** a character. A **Clothing Designer** would let users design a garment **first**, independent of any character, then apply it. Design on a hidden, neutral **mannequin base**, edit/customize the garment, and **save it as a preset/part** the same way poses/parts are saved.

**Concept:**
- An **invisible/neutral mannequin body** (a standard `createProceduralBody3D` at default proportions, not rendered or ghosted) is the design substrate — the garment is generated + edited against it using the exact same generator + fit pipeline.
- The user tweaks the garment (sliders now; hems/trim/paint/silhouette later) and **saves it as a reusable definition** — store the `ClothingParams` (a "garment preset") and/or bake the mesh to a kitbash part.
- **Apply to a character:** because the fit pipeline (directional sizing + shrink-wrap + weight transfer) re-fits a garment to *whatever* body it's attached to, applying a saved garment to a different character **re-runs the fit against that body** → it auto-resizes and re-weights with no clipping. (This is the "any body wears any clothing, auto-fit" property — the engine is already most of the way there for shared-rig procedural bodies.)

**What's already in place:** the generator is pure (`generateTop/Bottom(fit, params)`), the fit pass conforms to any body, params are serializable (already persisted as `clothingRigs`), and bake-to-part already works + persists. So a Designer is largely **UI + a garment-preset store + a "fit saved garment to body" call**, not new core geometry.

**To build later:** (1) a standalone design mode with the mannequin substrate; (2) a **garment preset library** (save/load `ClothingParams` bundles, separate from a specific body); (3) `applyClothingPreset3D(bodyMeshId, presetId)` that runs the generator + fit pass against the target body; (4) eventually the hems/trim + UV-paint + silhouette tools so designs are more than slider bundles. Pairs with the kitbash library (a baked design is just a part).
