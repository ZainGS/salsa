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
- **Skirt:** weighted to `hips` (a stiff low-poly skirt swings from the pelvis — correct + simplest; a 2-bone skirt-jiggle is a later option). **Superseded 2026-09-30 (R6.3):** below the waist the skirt now blends onto the thighs and, at a long hem, the knees, and its front/back panels are steered each frame toward the forward/trailing thigh (`skirt-steer.ts`). `legFollow: 0` gives back the rigid pelvis skirt. See [character-creator.md](../ui/character-creator.md) §4 "Skirts & dresses follow the legs". **Shorts/pants:** waist→legs blend `hips`↔`upperleg`↔`lowerleg`.

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

## 15. Fixed 2026-10-03 — T-shirt torn at the side seam on wide torsos

**Symptom (editor, not Play).** On a T-shirt, a vertical slit at the side seam under the arm showed the skin, and flaps stuck out over the shoulder near the armpit and the sleeve. It happened at rest and in the default idle. It reproduced on any body with **Torso width ≳ 1.0 or Shoulders ≳ 1.2**. The Frogmarks sliders go to 1.6 / 2.0, so this is a common shape. Default bodies were fine.

**Not the render path.** The same tear showed with GPU culling auto, on and off, with cull ranges on and off, with TAA on and off, and with SSAO. It showed at rest and in idle. The live meshes, CPU-skinned with the live skeleton, match a fresh main-thread `generateTop` exactly. Matte, face normals and the face kit don't touch the garment geometry.

**Root cause: geometry, in the BODY.** The arm socket belongs to the torso (rows 6–8), so Torso width (`tt`) and Shoulders (`shoulderWidth`, which scales rows 7/8) push it outward. The shoulder joint does not move, and so neither does the arm. The deltoid ring sat at a fixed 13% down the upper arm (x ≈ 0.110 at height 1). Once the widened socket centre passed that point, the arm tube started by folding back inside the torso:
- default: socket 0.097 → deltoid 0.110;
- `tt` 1.1: socket 0.119 → deltoid 0.110;
- `tt` 1.2 + `shoulderWidth` 1.4: deltoid 4.8 cm inboard of the socket.

The shirt is built from the body's captured rings, so:
- the **sleeve**, which is `armSurface` offset outward (`buildSleeveOffset`), folded the same way. The sleeve cap became flaps, and `slantArmhole` took its axis from the reversed socket → deltoid vector;
- the shirt's **side panel under the arm** had the buried arm as its nearest skin. Weight transfer gave it shoulder weights (shoulder_L 0.27–0.35), so it followed the arm down and opened the slit.

**Fix (`body-generator.ts`, the arm loop).** The deltoid ring is kept at least `DELTOID_CLEAR` = 0.045 of the upper-arm length past the socket centre, measured after `filletShoulder`. On very wide torsos the bicep ring moves with it (`BICEP_GAP` 0.2 behind; `DELTOID_T_MAX` 0.75).
- Default bodies are unchanged: the socket sits about 8% down the arm, so 8% + 4.5% is under 13%.
- Only ring positions move. Joints, radii and weights are untouched, so stored skeletons still match.
- Saved wide characters regenerate their body from params, so they are repaired on load.

**Measured.** 40 bodies over `tt` 0.9–1.3 × `shoulderWidth` 0.8–1.4 × height 1 / 0.5, posed Relaxed + idle:
- exposed torso skin: 394 → 143 verts;
- garment verts that leave their skin by more than 5 cm (the flaps): 804 → 255.

On the regression shapes the flaps went from 48 to 0.

**Tried and rejected (measured worse):**
- a wider closest-surface search in `surfaceWeightsAt`: exposure 189 → 563;
- stripping arm joints from the torso panel's inherited weights: 48 → 84 once the body fix was in.

**Regression test:** `clothing-side-seam.test.ts`.
- The arm rings never fold back, over the full slider range (`tt` 0.6–1.6 × `shoulderWidth` 0.5–2).
- The default body's deltoid position is pinned.
- No torso skin shows through a Tee at rest, Relaxed or idle on four wide shapes.

Without the fix, every case fails.

**Still open:**
- On a narrow torso with very wide shoulders (`tt` 0.9, `shoulderWidth` 1.4), 1–2 skin verts stay visible deep in the front armpit crease where the sleeve cap meets the torso. The test allows 2.
- The back-centre crease (the spine sector radius dips) is a shading fold of the shirt itself, not skin. It predates this fix.
- Long card hair tips poke through the upper back of the shirt. That is a hair-collision issue.
- Classic (saved, `seamBlend` 0) bodies get the same geometry fix, because it is in the body.

## 16. Fit round 2 (2026-10-04) — body-hiding mask, hip weights, layer order, lining, hem swing

Five problems were reported: trousers tearing at the knees on deep run bends; a long skirt showing a little knee and its white inner back during the run; 1–2 skin verts in the armpit on very wide shoulders; long card hair poking through the shirt's upper back; and the skirt waist showing over the shirt hem. This round fixes the causes in the fit, and adds the standard game technique for what a fit can never fully stop: hiding the skin under the clothes.

### What changed (techniques)

**1. Pelvis → thigh weight smoothing (`hip-weight-smooth.ts`, body + trousers / shorts).** The body's pelvis rings and crotch bridge were 100 % `hips` next to a thigh-top ring at 55 % thigh. A raised thigh put the whole rotation into that one band. On a new body, 37 / 49 / 51 of the ~500 hip-region triangles stretched past 2× (run / sit / squat), and 14–32 folded, while knees and elbows had none. Every garment copies the body's weights, so trousers tore at the front hip crease. The fix is a few Jacobi (Laplacian) passes over the weight field inside a hip zone (hips joint height down to 35 % of the thigh, verts bound only to hips / thighs). Everything else is held fixed. It applies to seam-blended (new) bodies only.
- Hip-region stretched + folded triangles over 10 leg / torso poses: **409 → 102**. Classic bodies are unchanged at 399 (pinned by `body-hip-weights.test.ts`).
- Trousers and shorts (`legWidth` < 1.5) get a light pass of the same smoothing on their own mesh (4 × 0.5). The per-leg crotch fabric may never take the other thigh, so the two legs' sheets don't fuse (the webbing). Skirt base weights drop the leg joints; their leg part comes from the leg-follow ramp.
- Worst absolute tear over the 26 ROM poses: Pants / Skinny 10.2 → 7.6 %, Skirt 14.6 → 11.9 %, Shorts 30.2 → 22.6 %, Baggy 10.5 → 9.3 %. Wide Leg held (10.9 → 11.4 %). Smoothing loose legs raised their poke from 12 % to 20–29 %, so they keep their analytic weights.

**2. Mid-thigh knee share (body, new bodies only): 0.25 → 0.1.** The mid-thigh ring took a quarter of the knee's rotation. On a 90–105° run bend that caved the back of the thigh in, and the trousers folded open there. On the live Play run frames (grabbed from the browser and reproduced on the CPU), knee / thigh skin through the trousers roughly halved; 0 was no better than 0.1.

**3. The body-hiding mask (`body-hide-mask.ts`, `SkinnedMesh3D.drawIndices`).** Body triangles that the character's opaque garments fully cover are not drawn. They are collapsed to degenerate (a, a, a) in the body's draw index list. That list has the same length, so draw calls are unchanged. The renderer builds the skinned index buffer from it, and `geometry.indices` stays the full body. A vertex is hidden only when all of these hold:
- it is enclosed at rest: every one of 24 rays in a 60° cone from 5 mm under the skin meets cloth within 30 cm;
- it is not within 5 cm of a garment's open edge (hem, cuff, neckline, waistband). Seams count as covered, not as openings: an edge with another garment piece in front of it within 3.5 cm, such as a sleeve tube tucked against the torso;
- in each of 14 probe poses it passes three checks: the cloth along the posed normal stands off at most 10 cm more than at rest; or the skin pokes out with the cloth right behind it, which is the case the mask exists for; and no garment triangle within 5 cm stretches past 3.5×, a real tear you'd see through. The probe poses are strides, walks, run L/R at a 110° knee, squat, kicks, legs apart, arms up / forward / down, and a bend + twist.

A triangle hides when all three of its verts do. The work is a resumable job, one probe pose per tick: about 0.1–0.5 s of raycasting in total per outfit change, spread over frames, debounced 250 ms after the last garment change. Until it lands, the body draws in full, because a stale mask could hide skin a new garment no longer covers. It is measured with a two-pass rasteriser (`clothing-visibility.ts measureMaskHoles`). Over the 26 ROM poses plus every Walk / Run / Jump / Land frame on five outfits, see-through holes stay ≤ 12 px of a 260-px view (`clothing-fit-round2.test.ts`). Trousers knee skin over the Run cycle and two deep-run poses went from 340–1090 px to 0–48 px.
- Tried and rejected, all measured: the rest-only mask (see-through slits at the hip crease in a squat, 340 px); re-running the cone test in each pose (it un-hid exactly the skin poking through); counting FOLDED faces as tears (lost the whole knee); a 2.5 cm gape limit (a slim knee moves ~4 cm inside a loose trouser tube); hiding a triangle when 2 of its 3 verts are hidden (holes everywhere).

**4. Strict layer order (`garment-layers.ts`): underpants · undershirt · socks < trousers / skirt < top.** Each garment is fitted to the body on its own, so nothing decided which was outside where two overlapped. The outer garment's verts that sit inside the inner one, or within 6 mm of it, are pushed out along their own normal. This is tested against the inner TRIANGLES, past stacked surfaces such as a waistband rim. They also take the inner garment's weights within 6 mm, so the two move together. Skirts are never moved, because their steer rewrites their weights each frame. Scene3DCharacter keeps every garment's raw result and re-layers the outer garments in place whenever an inner one changes or is removed. The worker builds the hair's collision soup from the same layered outfit, so primed and synchronous characters stay byte-identical. A Long Sleeve top with a low hem over a skirt or trousers: 33 verts inside the bottom → 0.

**5. Outward winding + cloth lining (`orientOutward`, `Material3D.clothLining`, flags2 bit 8).** The ring builders wound their bands either way: the tee came out clockwise, the trousers counter-clockwise. This never showed while both faces drew the same. `finish()` now flips each face to agree with its smoothed normals, which is a test over every preset. Every procedural garment sets `clothLining`. In both mesh fragment shaders, a back-facing fragment draws as min(lit, albedo) × 0.32. The inside of a skirt under the hem reads as fabric in shadow, not a rim-white sheet.

**6. Long hair over the shirt (`Scene3DCharacter._layerHairOverTop`).** The head-bound hair verts below the nape are layered over the top / undershirt, using the same `layerOver` with a vertex filter. These are the back flap and cards; spring tails are left to their springs. Where the hair lies on the shirt it takes the shirt's weights, so the tips ride the upper back instead of sinking into it as the chest moves.

**7. Skirt hem swing (`skirt-swing.ts`, `BottomParams.hemSwing`, Play only).** This is secondary motion on top of the leg-follow steer. A spring-damped LAG vector (1.9 Hz, ζ 0.32) lives in the pelvis's horizontal plane and chases minus the pelvis velocity: a running skirt trails, and a stop swings it past centre and back. A FLARE spring chases vertical speed and turn rate: a jump or landing opens the hem, a quick turn fans it.
- The offset is `r̂ · (max(0, r̂·lag) + flare) · h²`, plus a small lift. r̂ is the vertex's outward horizontal direction; h is 0 at the waist and 1 at the hem.
- The offset is OUTWARD only: the trailing panel flares away from the legs and the leading panel stays where the steer put it, so it never pushes cloth into a leg. At the worst lag in 8 directions plus full flare, Skirt / Knee dress stay ≤ 3 mm and Long dress ≤ 25 mm (`skirt-leg-follow.test.ts`).
- It is bounded (|lag| ≤ 1.2 and flare ≤ 0.72 × the length-scaled amplitude, whatever the input) and settles at rest (`clothing-fit-round2.test.ts`).
- The live skirt vertices are rewritten each frame while it moves (a few hundred verts, one skinned-VB re-upload) and restored exactly when Play stops or it settles.

### Per problem

- **Trousers tearing at the knees on deep run bends.** The visible tears were the front hip crease (cause: hip weights, fixed in 1) and knee / back-of-thigh skin poking out (cause: the mid-thigh knee share, 2). What pokes in the 70–110° bends is now hidden (3). The ROM gate stays green.
- **Long skirt: a little knee + its white inner back during the run.** The knee cap poked through the front panel stretched over the raised thigh; the mask now hides it (the live browser frames show no knee). The "white" was the inside face lit with the outward normal; the lining draws it dark (5).
- **Armpit skin on very wide shoulders.** **Not fixed.** On `tt` 0.9 / `shoulderWidth` 1.4–1.6, 1–4 verts stay visible deep in the front armpit crease. The mask does NOT hide them: in the arms-forward probe the sleeve cap stretches open right there, so hiding them would open a see-through hole. The side-seam test still allows 2 (`tt` 0.9 / `sw` 1.4). The real fix is a garment-side cover for that crease (a scooped sleeve cap, §13).
- **Hair tips through the shirt's upper back.** Fixed by 6.
- **Skirt waist over the shirt hem.** Fixed by 4: the top is always outside the bottom.

### Saved characters

They **regenerate sensibly**; they are not byte-identical. Garments, hair and the mask are regenerated from params on load, as before.
- New (seam-blended) bodies get the hip smoothing and the 0.1 mid-thigh share. Only the weights change; joints, rest positions and topology are unchanged, so animations, poses and stored skeletons still match.
- Classic (`seamBlend` 0) bodies are bit-identical. Their trousers too: the garment smoothing is seam-blended-only.
- Skirts on any body drop leg joints from their base weights.
- Every garment gets outward winding, the lining, layering and the mask. That is on by default: a saved garment without `hideBody` hides.
- Skirts get the hem swing at 1 by default (`hemSwing` absent = 1).

### API

`sm.getHideBodyUnderClothes3D(bodyId)` / `sm.setHideBodyUnderClothes3D(bodyId, on)`: the character-wide switch, persisted as each garment's `hideBody` (absent = on). `sm.getSkirtSwing3D(bodyId)` / `sm.setSkirtSwing3D(bodyId, 0..1.5)`: `null` without a skirt; persisted as `hemSwing`.