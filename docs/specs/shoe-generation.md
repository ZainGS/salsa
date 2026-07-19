# Procedural Shoe / Footwear Generation

**Last Updated:** 2026-06-28
**Status: ✅ Phase 1 + 1.5 BUILT (type-checks; not yet visually verified)** — `generateShoe` + the `'shoes'`
clothing slot are wired live + persisted via the clothing-rig system. Phase 1 = a foot-wrapping upper. **Phase 1.5
(2026-06-28):** a **`topCover` vamp** (per-ring top-gap closure → open sandal … closed upper to the ankle front;
fixes the bare-instep look — default sneaker is now closed) **+ a real `shaftHeight` ankle tube** (`buildAnkleTube`:
stacked rings around the ankle, skinned foot→lowerleg so it bends → slide / high-top / boot / calf). New presets:
**Sandal** (open vamp) + **High Top**. The heel is still OPEN (the leg plugs it).

## Context
The character creator generates a body, hair, and clothing (top + bottom), but the feet are bare. Shoes are
the missing outfit piece (the character-variety / dollz specs list "shoes" as a needed slot). This adds a
**procedural shoe generator** that wraps the body's foot, skinned to the foot joint so it deforms with poses,
covering sneaker / flat / boot / heel / (sandal) styles from a few params — exactly like the clothing
generator does for tops/bottoms. Engine: `src/services/managers/clothing-generator.ts` (+ `scene3d-manager.ts`).
Host: Frogmarks owns the UI.

## Architecture decision — shoes are a third CLOTHING SLOT
Footwear is clothing, and the clothing system is already slot-generic (`top` / `bottom`). So shoes are added as
**`slot: 'shoes'`** rather than a parallel system. This **reuses, for free**, the entire pipeline that was just
hardened: `ClothingRig` (keyed `${bodyId}:shoes`), `setClothingParams` (live), `_applyClothingColor`,
`serializeClothingRigs`/`restoreClothingRigs` persistence, the `isClothing` node-exclusion, and the
`fitGarmentToBody` de-collision. The only new code is the **geometry** (`generateShoe`) + threading the new slot
value through the dispatch, the `'top'|'bottom'` → `'top'|'bottom'|'shoes'` unions, and the per-slot loops
(refit / collision / save).

## Fit — wrap the real foot
The body's foot (`buildFoot` in body-generator) is a flattened sole + 5 toes off `foot_L/R`, extending **+Z**
(forward), **+Y** up, **±X** wide. `generateShoe` fits to it:
- **Foot box from the body mesh:** scan `BodyFit.body` verts weighted to the `foot_*` joint (weight > 0.5),
  take their bbox → heel (min Z), toe (max Z), width (±X), sole bottom (min Y), instep top (max Y). This
  auto-fits any foot size/shape. Fallback (no body mesh): derive a scale from the `foot` JointFit radius.
- Build in **world rest space** around that box, **skinned to the foot joint** (the shaft blends foot→lowerleg),
  so it deforms with the foot exactly like `buildFoot` does.
- Run the shared **`fitGarmentToBody`** de-collision so the upper never clips the foot.

## ShoeParams
```ts
interface ShoeParams {
  slot: 'shoes';
  shoeStyle: 'sneaker' | 'flat' | 'boot' | 'heel' | 'sandal';
  soleThickness: number;   // sole slab height (world units)
  heelHeight: number;      // extra lift at the HEEL only (heels / boots), 0..1
  shaftHeight: number;     // ANKLE TUBE up the ankle/leg: 0 = none/slide … ~0.3 high-top … ~0.7 boot … 1+ calf
  topCover: number;        // VAMP/instep coverage: 0 = open sandal (toes out) … 1 = closed upper to the ankle front
  toePoint: number;        // 0 = round toe → 1 = pointed (taper the front)
  ankleCollar: number;     // collar-lip height at the back of the LOW shoe (× foot height)
  thickness: number;       // upper offset over the foot (world units)
  baseColor: string; trimColor: string; gradient: boolean; trimWidth: number;
  chunkiness: number;      // poly density
}
```
**Style recipes** (a style is a default bundle; sliders fine-tune):
- **Flat** — thin sole, closed low upper (`topCover` ~0.78), no shaft.
- **Sneaker** — medium sole, closed upper (`topCover` 0.85) + a low ankle collar.
- **High Top** — sneaker + `shaftHeight` ~0.34 (ankle tube over the ankle).
- **Boot** — closed upper + `shaftHeight` ~0.7 tube up the lower leg (foot→lowerleg weights).
- **Heel** — thin sole + `heelHeight` lift at the back + `toePoint`.
- **Sandal** — open vamp (`topCover` ~0.2 → toes/instep out) on a thin sole. *(Discrete straps are still Phase 2.)*

## Geometry (`generateShoe(fit, params)` → `{ geometry, jointIndices, jointWeights }`)
Per side L/R:
1. **Sole** — a slab from heel→toe along the foot box bottom, `soleThickness` tall, `heelHeight` wedge at the
   back; toe tapered by `toePoint`. Width = foot box width + thickness.
2. **Upper** — per-ring X-Y arcs heel→toe (`shoeArc`). Each ring's **top gap** is driven by `topCover` (the
   **vamp**): open (~100°) over the ankle, ramping CLOSED toward the toe — and where closed, the rim rises ABOVE
   the foot so the instep is domed over, not clipped. `ankleCollar` adds a collar lip at the open back.
3. **Ankle tube** (`buildAnkleTube`) — when `shaftHeight > 0`, a stacked-ring cylinder wraps the ankle from inside
   the upper up to `shaftHeight` along the lower leg, drifting toward the shin so a tall shaft tracks the leg.
4. **Skin** — sole + upper = 100% `foot_*`; ankle-tube rings blend `foot_*`→`lowerleg_*` (bends at the ankle).
   Then `fitGarmentToBody` (hugs the vamp to the foot + the tube to the ankle).

Reuses the clothing-generator helpers (`Accum`/`pushVert`/`addRing`/`bandRings`/`capRing`/`finish`/`fitGarmentToBody`)
— `generateShoe` lives in `clothing-generator.ts`.

## Wiring (mirrors top/bottom; mostly free via the slot)
- **clothing-generator.ts:** `ShoeParams` + add to `ClothingParams` union; `defaultShoeParams()`; `SHOE_PRESETS`
  (Sneaker/Flat/Boot/Heel) folded into `clothingPresetNames`/`clothingPreset`/`clothingPreset` dispatch on slot;
  `generateShoe`.
- **scene3d-manager.ts:** `setClothingParams` dispatch `params.slot === 'shoes' ? generateShoe(fit, p) : …`;
  widen the `'top'|'bottom'` slot type → include `'shoes'` in `getDefaultClothingParams`/`getClothingPreset(Names)`/
  `getClothingParams`/`removeClothing`/`getClothingMeshId`/`bakeClothingToPart`/`clothingRigKeyForMesh`; add
  `'shoes'` to the per-slot loops (`_refitCharacterOverlays`, `_collisionVertsForHair`).
- **shape-manager.ts:** widen the slot type on the `*Clothing*3D` wrappers; `exportCharacter3D`/`importCharacter3D`
  already iterate clothing slots, so shoes ride along.
- **Persistence:** none new — `clothingRigs` already serialize/restore any slot; the body-only / .frogmarks fixes
  cover shoes automatically.
- **Frogmarks UI:** a **Shoes** sub-tab (like Top/Bottom) → style dropdown + sliders → `setClothingParams3D(bodyId,
  shoeParams)`; preset picker via `getClothingPreset3D('shoes', name)`. (docs/ui/clothing.md to be updated.)

## Phases
- **Phase 1 (built):** generator (sole + foot-wrapping upper) for sneaker/flat/heel; live + persist via the
  clothing-rig slot; default + presets.
- **Phase 1.5 (built, 2026-06-28):** `topCover` **vamp** (closed uppers, no bare instep — default sneaker closed)
  + `buildAnkleTube` real **`shaftHeight`** ankle tube (slide → high-top → boot); **Sandal** + **High Top** presets.
- **Phase 2:** discrete sandal/strap geometry; laces/trim detail; sole tread; per-foot asymmetry; UV-paint;
  bake-to-kitbash-part.

## Verification
`npx tsc --noEmit` → rebuild → `setClothingParams3D(bodyId, getDefaultClothingParams3D('shoes'))` → a shoe wraps
each foot, deforms when posed, survives save/reload (rides clothingRigs), and doesn't clip the foot.
