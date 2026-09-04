# Scene3DCharacter Extraction Spec

**Created 2026-08-10.** The plan for pulling the entire character subsystem out of `scene3d-manager.ts` into one cohesive `Scene3DCharacter` (`scene3d-character.ts`). Follows the six completed §5.1 extractions (see `docs/specs/god-objects-and-perf.md`). This is the largest single extraction (~2.5–3k lines) and the reason it's **one** class, not several.

> **Working-tree rule:** shared tree, no state-mutating git. Verify with `npx tsc --noEmit` + `npx vitest run` after each stage. **Browser-verify** after the whole thing — it's device + character-visual with no automated coverage.

---

## Why ONE class (the core decision)

The cleanly-separable subsystems (cloth, ribbon, particles, …) had *thin* seams. Face/hair/clothing/attachments do not — they mutually cross-reference:
- change body → **refit clothing** → **refit hair** (hair shrink-wraps over the garments, so it must run *after* clothing)
- attachments (glasses) are placed at the **face's** eye-line (`_eyeYForBody`)
- `reapplyPartColor` walks `_clothingRigs`, `_hairRigs`, **and** `_faceRigs` together
- body-fit (`_buildBodyFit`) + colliders (`_ensureBodyColliders`) are shared by clothing, hair, and attachments

Splitting *between* face and hair means inventing host-callbacks to paper over real coupling. Putting the cluster in one class makes those cross-references plain internal `this.…` calls. **The boundary is drawn at the low-coupling seam — around the whole character cluster.** Internal sub-decomposition (a FaceRig helper, HairRig helper) is a *later* refinement, not part of this move.

The pure generators (`body-generator.ts`, `clothing-generator.ts`, `hair-generator.ts`, `attachment-generator.ts`) already live in their own files as pure `params → geometry`. `Scene3DCharacter` is only the **orchestration** around them (rigs, GPU upload, texture rendering, refit order, persistence).

---

## State fields to move (→ `Scene3DCharacter`)

| Field | Purpose |
|---|---|
| `_characterMap: Map<string, CharacterData>` | kitbash-assembled characters |
| `_kitbashLibrary: KitbashLibrary` | part catalog (readonly) |
| `_bodyParams: Map<string, BodyParams>` | per-body generator params |
| `_sharedBodyFit: { bodyMeshId; fit } \| null` | body-fit shared across a multi-slot refit |
| `_faceRigs: Map<string, FaceRig>` | eye decal + expressions + blink |
| `_hairRigs: Map<string, HairRig>` | hair mesh + params + gradient |
| `_clothingRigs: Map<string, ClothingRig>` | key `${bodyMeshId}:${slot}` |
| `_attachments: Map<string, AttachmentRig>` | charms/glasses/etc. |
| `_suppressHairRefit: boolean` | re-entrancy guard during body refit |
| `_bodyColliders` (if a field) | collider cache for drape |
| Idle/spring animation: `_charSkelSyncVer`, `_charSkelHasBodies`, `_charSkelStructVer`, plus the idle-callback + spring-keepalive state | per-frame character animation |

Types (`FaceRig`, `HairRig`, `ClothingRig`, `AttachmentRig`, `FaceRigState`, `CharacterData`) move or are imported.

---

## Method clusters to move

1. **Kitbash + assembly** — `loadKitbashManifest`, `addKitbashParts`, `getKitbashPartsBySlot`, `getKitbashSlots`, `createCharacter`, `getCharacter`, `restoreCharacterStates`, part-assembly internals.
2. **Body generator orchestration** — `createProceduralBody3D`, `getBodyParams`, `setBodyParams` (+ the debounced refit: clothing-first-then-hair-once, using `_suppressHairRefit` + `_sharedBodyFit`).
3. **Face rig** (~25 methods) — `ensureFace3D`, `createFaceExpression`, `delete/rename/setActive`, `setFaceBlinkExpression`, `setFaceBlinkConfig`, `setAutoBlink`, `getFaceExpressions`, `getFaceExpressionTextureManager`, `setFaceExpressionProcedural`, `getFaceExpressionParams`, `setFaceGaze`, `getFaceDecalMeshId`/`getEyesMeshId`, `getDefaultEyeParams`, `frameFace3D`, serialize/restore (`serializeFaceRigs`, `getFaceTextureExports`, `restoreFaceRigs`) + internals (`_ensureRig`, `_buildFaceDecal`, `_headRegionBBox`, `_faceAspect`, `_ensureExpressionTexture`, `_applyTexture`, `_renderEyeParamsToTexture`, `_eyeVPosForBody`, `_eyeYForBody`, blink timers `_cancelBlink`/`_restartBlink`/`_fireBlink`).
4. **Hair** — `getDefaultHairParams`, `getHairParams`, `getHairMeshId`, `setHairParams`, `removeHair`, `_renderHairGradient`, serialize/restore (`serializeHairRigs`, `restoreHairRigs`).
5. **Clothing** — `getDefaultClothingParams`, presets, `getClothingParams`, `setClothingParams`, `removeClothing`, serialize/restore, `_applyClothingColor`, `_chainDrapeSurface`.
6. **Attachments / charms** — `addAttachment`, `setAttachmentParams`, `removeAttachment`, serialize/restore.
7. **Character animation** — `setHairSimulation`, `setIdleAnimation`, `setSquashStretch`, `setLegIdleMode`/`setIdleBreaks` (idle rig), `_ensureIdleCallback`, `_springsActiveFor`, `_keepSpringsAlive`, `_syncCharacterSkeletons` + its per-frame spring-bone solve hook.
8. **Shared internals + skin** — `_buildBodyFit`, `_ensureBodyColliders`, `reapplyPartColor` (the multi-rig revert), `setSkinTone`/`getSkinTone`.

---

## External touchpoints (into character — must go through the public API or a host callback FROM the manager)

- **Constructor** registers `_syncCharacterSkeletons` as a pre-render callback (`~645`) → after extraction the manager registers `() => this._character.syncSkeletons()`.
- **Spring-bone solve** in the main render path (`~1667–1681`) calls `_springsActiveFor` / `_ensureIdleCallback` → route to `this._character.*`.
- **`restoreMeshState`** (`~3137–3217`) re-flags `isProceduralBody` and restores `bodyParams` → calls `this._character.registerRestoredBody(...)`.
- **Category stats** (`~3644`) counts `isProceduralBody` — reads the mesh flag, no change needed.
- **Undo integration** (`~8603`) drops/restores a face rig on body delete/undo → `this._character.detachFaceRig(id)` / `reattachFaceRig(...)`, or expose `getFaceRig`/`cancelBlink`/`restartBlink`.
- **Id-mapping helpers** (`~9292`, `9302`, `9311`) resolve a part mesh → owning body, and gather a body's part ids, by scanning `_faceRigs`/`_hairRigs`/`_clothingRigs`/`_attachments` → move these helpers into `Scene3DCharacter` (they're pure character queries) and delegate.
- **Document save/restore** (ShapeManager persistence) calls each `serialize*`/`restore*` — keep those as manager delegators.

---

## Host interface (`Scene3DCharacterHost`) — what character needs FROM the manager

```ts
interface Scene3DCharacterHost {
  getMesh(id: string): Mesh3D | null;
  getAllMeshes(): Mesh3D[];
  createMesh(x, y, z, config): Mesh3D;                // for hair/clothing/attachment meshes
  // camera framing for frameFace3D:
  getOrbitController(): OrbitController | null;
  getCamera(): Camera3D;
}
```
Everything else (device, sceneGraph, interactionService, scheduleRender, emitSceneGraphChanged, webgpuRenderer, structureVersion) comes through `ctx: ManagerContext`. The pure generators + `RasterTextureManager` + eye/hair renderers are imported directly.

*Open question to resolve during stage 1:* whether the idle/spring **per-frame solve** stays partly in the manager's render loop (it iterates all skeletons, not just character ones) or moves wholesale. Likely: the character manager owns the character-skeleton sync + idle + spring-keepalive; the manager's render-loop hook just calls `this._character.syncSkeletons()` and the spring solve reads `this._character.springsActiveFor(id)`.

---

## Staging (all into the SAME new class; typecheck after each)

1. **Scaffold** — create `Scene3DCharacter` with `ctx` + host; move the state fields + the id-mapping helpers + `_buildBodyFit` + `_ensureBodyColliders` (the shared internals everything else needs). Wire the host in the constructor. Manager keeps the fields temporarily? No — move them; typecheck will flag every method still referencing them, which becomes the worklist.
2. **Face rig** cluster → subsystem; manager delegators.
3. **Hair** cluster.
4. **Clothing** cluster.
5. **Attachments** cluster.
6. **Body orchestration** + kitbash/assembly.
7. **Character animation** (idle/spring/sync) + wire the render-loop + undo + restore touchpoints.
8. **Test** (`scene3d-character.test.ts`) — the CPU-testable slices (body params round-trip via the pure generator, id-mapping queries, refit ordering flags, serialize/restore shapes) with a mock host; **browser-verify** faces/eyes/blink/hair/clothing/attachments/idle.

Because the clusters cross-reference, stages 2–6 will not individually typecheck-clean until their siblings also move — that's expected; the goal is a clean typecheck at the END of the character move, with the compiler enumerating every unmoved reference along the way.

---

## ⭐ REFINED BOUNDARY (determined 2026-08-10 by reading the whole system — supersedes the "everything" framing above)

Reading all ~3,000 lines revealed a **cleaner seam than "all character in one class"**: the split is **overlay CONTENT vs skeleton/orchestration**, because `createProceduralBody3D`/`createCharacter`/`setBodyParams` are coupled to the *armature* god-cluster (`_createSkeletonFromResult`, `_createSkinnedMeshForSlot`, `addIKChain`, `setPoleTarget`, `installDefaultAnimations`, `applyBodyPose3D`, `_undoManager`, `_modelStore`, `parseSkinnedGLB`) — NOT to the character content. Forcing body-orchestration into `Scene3DCharacter` would need a huge host interface into the armature system. So:

**MOVES into `Scene3DCharacter` (the overlay content, ~1,800 lines, mutually cyclic → atomic):**
- Face ✅ (done) · Hair (`setHairParams`, `_buildHairSpringRig`, `_collisionVertsForHair`, `removeHair`, `_renderHairGradient`, getters) · Clothing (getters, `setClothingParams`, `removeClothing`, `_applyClothingColor`, `_drawGarmentColorCanvas`, `seedGarmentPaintTexture`, `retintGarmentPaint`, `clothingRigKeyForMesh`, `getClothingMeshId`, serialize/restore) · Attachments/charms (`addAttachment`/`setAttachmentParams`/`setAttachmentPlacement`/`getAttachment`/`listAttachments`/`removeAttachment`/`getAttachmentMeshId`, `_buildAttachment`, `_waistbandLoopOffset`, `addBeltLoops`, `setCharacterSparkle`, `_chainDrapeSurface`, `_rebuildAllCharms`, serialize/restore) · Colliders (`_ensureBodyColliders`, `_garmentRadiusAt`, `_garmentHalfDepthAt`) · `_buildBodyFit` + body-surface caches (`_bodyArmSurface`/`_legSurface`/`_torsoSurface`) + `_bodyParams` + `getBodyParams` · `_refitCharacterOverlays` → `refitOverlays()` + `_sharedBodyFit` + `_suppressHairRefit` · skin tone (`setSkinTone`/`getSkinTone`) · the id-map queries (already partly done for face).

**STAYS in the manager (skeleton/orchestration side):** `createProceduralBody3D`, `createCharacter`, kitbash assembly (`loadKitbashManifest`/`addKitbashParts`/`getKitbashParts`/`getKitbashSlots`), `setBodyParams` (regenerates body geometry + skeleton IN PLACE, then calls `_character.refitOverlays()`), `_updateSkeletonFromResult`, ghost preview (`previewProceduralBody3D`/`_ghostIdle`/`_ghostReveal`/`_IDLE_JOINTS`), character animation (idle/spring/`_syncCharacterSkeletons`/`_keepSpringsAlive`), bake-to-part (`bakeClothingToPart`/`bakeHairToPart` — read overlay via `_character.getClothingMeshId`/`getHairMeshId`, call `_registerBakedPart`), IK/skeleton/import.

**Host (subsystem → manager), 6 methods:** `getMesh`, `getAllMeshes`, `getOrbitController`, `getCamera` (face has these) + `setRenderStyle(id, style)` (restore) + `keepSpringsAlive(skelId)` (attachment settle).

**Bridges (manager → subsystem):** `registerBody(meshId, params, armSurface, legSurface, torsoSurface)` (from create/setBodyParams), `getBodyParams`/`setBodyParamsCache`, `refitOverlays(bodyMeshId)`.

**Status:** Face cluster DONE + green (792 tests). The overlay batch above is a single atomic write+surgery (~1,800 lines, no green typecheck until it all lands) — a dedicated execution pass with browser-verify. This section is turnkey for that pass.

## Risk + verification

- **Blast radius:** character faces, eyes, blink, hair, clothing fit, attachments, idle animation, spring bones. None has automated coverage.
- **Safety net:** typecheck (private-field references become compile errors when a method is left behind) + faithful moves (relocate logic verbatim; only re-route `getMesh`/`createMesh`/orbit to the host).
- **Must browser-verify:** create a procedural body; edit body params (watch clothing+hair refit); draw/procedural eyes + gaze + blink; add hair; add each garment slot; add a charm/glasses (eye-line placement); toggle idle animation; save + reload a character.
