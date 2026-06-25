# Character System — Improvement Backlog

**Created:** 2026-06-23 (review pass over body / face-eyes / hair / clothing / rig / persistence)
**Scope:** the procedural character creator (Dollz) and adjacent systems. Effort tags: **S** ≈ <½ day, **M** ≈ 1–2 days, **L** ≈ multi-day. Priority is top-down within each tier.

> Engine-only review. All fixes are Salsa-side unless tagged **[Frogmarks]**. Rule still applies: no `npm run build` — only `npx tsc --noEmit`; the user rebuilds.

---

## Progress (2026-06-23)

**✅ Shipped this session:** #1 hair persistence · #3 recreateNode (was already done) · #4 live body editing (`setBodyParams3D`) · #5 body shape params (bust/waist/hipWidth/shoulderWidth) · #6 live skin tone (`setSkinTone3D`) · #7 `bakeHairToPart3D` · #8 baked parts persist to the OPFS document · #9 pants/legs directional no-clip fit. All type-check clean.

**⬜ Remaining (see the tiers below):**
- **#2** iris-gradient fix (Tier 1) — ✅ **handled on the Frogmarks UI side** (gradient toggle + `irisColorTop`/`irisColorBottom` pickers). No Salsa work; leave the engine as-is.
- **Tier 3 polish:** ✅ #10 extremities — DONE 2026-06-23 · ✅ **garment fit hardened** 2026-06-23 (directional fit + RING12 + min-gap floor + shrink-wrap de-collision + weight transfer + sleeve cap/armpit fix — see clothing-generation.md §header/§14) · ✅ #11 **garment hems/cuffs/trim + UV-paint** — DONE 2026-06-23 (crisp trim band at all openings + raised folded cuffs; per-piece UV islands; paint persists keyed by rig + survives shape edits; paint canvas seeds from the garment's base+trim colour; `getClothingMeshId3D`→`enterUVPaintMode3D`. Remaining: just the Frogmarks Paint toggle) · ALSO fixed the **body UV island bug** (stitchLimb unwrapped-u spilled arm/leg paint onto neighbours) · #12 stacked-garment layer offset · #13 cloth/hair **draping/dynamics**.
- **Clothing Designer (future):** design a garment standalone on an invisible mannequin → save as a preset/part → fit to any character (the fit pass auto-resizes + re-weights). Spec: clothing-generation.md §14. Largely UI + a garment-preset store; core geometry is in place.
- **Tier 4 Frogmarks UI wiring:** hair / clothing / eyes / scene-grid / expressions / pose / constraints panels — plus the **new** APIs from this session need panels (`setBodyParams3D`, `setSkinTone3D`, `bakeHairToPart3D`, the 4 new body sliders).
- **Tier 5 perf/robustness:** #14 per-frame sync gating · #15 skinning-aware CPU pick/box · #16 generator validation · #17 verify GLB export bakes `objectTransform` · #18 centralize generator magic numbers.
- **Tier 6:** Shell UI · vector-layer interleaving · modifier drag-reorder.
- **Follow-up from #8:** `.frogmarks` export bundles `models3d` but **not** `meshTextures` or `bakedParts` (pre-existing gap) — add both for export parity.

---

## Tier 1 — Correctness gaps (quietly broken; fix first)

1. **Hair is lost on save/reload.** **[S–M]**
   Face rigs (`serializeFaceRigs`) and clothing rigs (`serializeClothingRigs`) are saved + rebuilt on load, but there is **no `serializeHairRigs`/`restoreHairRigs`**. Hair meshes are excluded from node persistence (like the decal/garments) and are meant to rebuild from a rig — but no hair rig is written, so **hair vanishes on reload**.
   *Fix:* mirror clothing exactly — serialize `_hairRigs` (`bodyMeshId`, `params`, `gradient`), add to the save payload ([shape-manager.ts:9493](../../src/services/shape-manager.ts#L9493)) and restore after `restoreClothingRigs` ([:9814](../../src/services/shape-manager.ts#L9814)). Files: `scene3d-manager.ts` (`_hairRigs`), `shape-manager.ts`.

2. **Iris color picker does nothing in the default mode.** **[S]**
   `irisColor` is only read when `irisGradient === false`; the default preset is `irisGradient: true`, so the iris is painted from `irisColorTop`/`irisColorBottom` and `irisColor` is ignored ([eye-generator.ts:197-203](../../src/services/managers/eye-generator.ts#L197)).
   *Fix (pick one):* (a) **[Frogmarks]** expose `irisColorTop`/`irisColorBottom` + an `irisGradient` toggle; or (b) **engine ergonomic** — when the stops aren't customized, auto-derive the gradient from `irisColor` so a single picker "just works." Recommend doing (b) so any UI is correct by default.

3. **`recreateNode` silently drops unknown node types on load.** **[S]** *(carried from backlog.md)*
   A scene JSON node type the switch doesn't handle hits the default case and is discarded — newer/foreign projects open with missing content and no error. *Fix:* warn + insert a placeholder node.

---

## Tier 2 — Creator capabilities (high user value)

4. **No live body editing — height/proportions are creation-only.** **[L]** ← the big unlock
   There is no `setBodyParams3D`; `BodyParams` bake in `createProceduralBody3D` and can't change afterward. You can't tweak height/limbs once a character is dressed.
   *Fix:* `setBodyParams3D(bodyMeshId, params)` that regenerates the body geometry + skeleton **in place** and **re-fits every attached rig** (face decal, hair, clothing) to the new body. Most of the machinery exists — `_buildBodyFit` re-derives clothing fit, hair/face use `HeadFrame` — so this is mostly orchestration + re-running the generators. Makes the whole creator iterative instead of one-shot. Pairs with #5/#6.

5. **Body-shape params are coarse (6 global multipliers).** **[M]**
   Only `height, limbThick, torsoThick, headSize, legLength, torsoLength` ([body-generator.ts:18](../../src/services/managers/body-generator.ts#L18)). A creator usually wants localized shape: **bust/chest, waist, hips, shoulder width, hand/foot size, neck length**.
   *Fix:* extend `BodyParams` + the `localRadii`/`localPositions` tables with per-region shaping. Natural companion to #4.

6. **No live skin tone / body surface.** **[S–M]**
   `skinTone` is applied once from `CharacterDefinition` at creation ([scene3d-manager.ts:2146](../../src/services/managers/scene3d-manager.ts#L2146)); there's no `setSkinTone3D`, it isn't persisted for procedural bodies, and the body is flat-shaded (no texture).
   *Fix:* `setSkinTone3D` + persist; optionally allow UV paint on the body (the UV-paint pipeline already exists) for blush/markings/tan lines.

7. **Hair can't be baked to a kitbash part.** **[S]**
   Clothing has `bakeClothingToPart3D`; hair has no equivalent. *Fix:* `bakeHairToPart3D` reusing the same GLB→`addKitbashParts` path.

8. **Baked parts are session-only.** **[M]**
   `bakeClothingToPart3D` registers an in-memory GLB URL; the bytes aren't written to disk, so baked parts disappear on reload. *Fix:* persist baked-part GLBs in the document package (kitbash-library persistence).

---

## Tier 3 — Polish / visual quality

9. **Pants/shorts still use the old scalar fit → can clip.** **[M]**
   The top + sleeves got the directional, body-enclosing no-clip fit (2026-06-23); `buildLegs` still uses a single scalar radius per joint. *Fix:* apply the same per-sector enclosing fit to the legs (the `JointFit.radii` profile already exists; thread it through `buildLegs`/`buildSkirt` waistband).

10. **Body is marked PROTOTYPE; extremities are rough.** **[M]**
    `body-generator.ts` is a "PROTOTYPE"; hands (palm + 4 fingers + thumb) and feet are basic. Worth a polish pass once the shape system (#5) stabilizes. (We just flattened the shoulder spike — verify on rebuild.)

11. **Garment UV-paint seam bleeding (no UV dilation).** **[M]** — Phase-2 paint follow-up.

12. **No layering/offset control for stacked garments.** **[M]**
    Two overlapping garments (e.g., jacket over shirt) will z-fight. Need a per-garment layer offset (small outward push by layer index).

13. **Cloth + hair are static (no dynamics).** **[L]** — skirt jiggle / hair sway (Phase 2 of each system).

---

## Tier 4 — Frogmarks UI wiring (engine ready, panels pending)

Engine APIs all exist; these are hand-off/build tasks. **[Frogmarks]**
- **Hair panel** — doc ready (`docs/ui/hair.md`).
- **Clothing panel** — doc just updated (`docs/ui/clothing.md`): heed the **seed-from-defaults** ⚠ and the **Hem relabel** ("Crop"/"Length").
- **Eyes** — procedural eye sliders + the iris-gradient fix (#2).
- **Scene grid toggles** — 3D ground grid + 2D canvas grid (`sceneGridVisible3D` / `canvasGridVisible`, both persisted).
- **Anime face / expressions panel**, **Pose library**, **Bone constraints** — APIs shipped, no panels.

---

## Tier 5 — Performance / robustness / testing

14. **Per-frame character sync callbacks.** **[S]**
    `_syncCharacterSkeletons` + `_ikSolveCallback` run every frame (version-gated). Fine for one character; for a crowd, gate on dirty/visible characters only.

15. **CPU picker + selection box use rest-pose geometry.** **[M]**
    A posed character mis-picks and its selection box is offset (GPU hover is skinning-aware; CPU picking/box isn't). Known limitation — would need a skinning-aware CPU path or GPU-readback pick.

16. **No generator validation.** **[M]**
    Nothing checks generated geometry for NaN / weights summing to 1 / degenerate tris / consistent winding. We've hit several silent geometry bugs (collapsed verts, armpit spikes). A dev-mode `validateBodyResult()` guard would catch generator regressions immediately.

17. **GLB export must include the skeleton `objectTransform` (Option B).** **[S]**
    With the character transform living on the skeleton, a **moved** character may export at the origin unless `exportSceneToGlb` bakes `objectTransform`. Verify before relying on baked exports.

18. **Magic numbers throughout the generators.** **[S, ongoing]**
    Lots of hand-tuned offsets/radii we keep revisiting (shoulder lifts, deltoid factors, hem mappings). Consider centralizing per-region tuning constants so a look-tweak is one edit, not a scavenger hunt.

---

## Tier 6 — From the existing backlog (non-character, still open)

- **Shell UI (WebGPU home screen)** — 8 phases; the largest remaining greenfield item (`docs/specs/shell-ui.md`).
- **Vector layer interleaving** — deferred by design.
- **Modifier-stack drag-reorder UI** — deferred by design (backend supports remove+re-add).

---

## Recommended order

1. **#1 Hair persistence** — quick; fixes real data loss.
2. **#2 Iris gradient** — quick; unblocks eye-color UI.
3. **#9 Pants directional fit** — completes the no-clip work.
4. **#7 `bakeHairToPart3D`** — quick parity win.
5. Then the headline: **#4 + #5 + #6 live body editing + shape params + skin tone** — turns the creator from one-shot into fully iterative.

Tier-1 items are all small and self-contained — good "first thing when I'm back" candidates.
