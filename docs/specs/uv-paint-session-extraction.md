# UVPaintSessionManager — Extraction Design Plan

**Created 2026-08-17.** The first move of the shape-manager *coupled tail* (see `manager-reorg-and-domains.md` §4). Unlike the four independents (Ephemera / LiveText / 2D-fromJSON / Decals-A), this is **design work, not a verbatim splice** — the packaging dependency must be *inverted*, and the piece is the live-painting system (browser-gated). This doc is the approved shape to execute from; **do not start cutting until (a) the stacked independents are browser-verified and (b) this design is signed off.**

## 0. Why this, why now

- It's the spec's stated prerequisite: *"UVPaintSessionManager owns controller + both lifecycles, exposes onStrokeMove/onStrokeEnd hooks PackagingManager subscribes to (invert the dep) → must precede packaging extraction."*
- Doing it unblocks **two** downstream items at once: **Decals Mode B** (stamp-into-texture, which shares `_uvPaintTextures`) and the **Packaging composite** extraction.

## 1. Current coupling map (what makes this hard)

One shared `UVPaintController` drives two session *kinds* that can never coexist (`_paintSessionKind`), but whose teardown state differs per-mesh. The two `enter` paths (`enterUVPaintMode3D` character, l.6689; `_armPackagingSurfacePaint` packaging, l.6786) + `exitUVPaintMode3D` (l.6751) reach into **four subsystems**:

| Subsystem | Touch points | Disposition |
|---|---|---|
| **UV editor** | `_uvSessions` (Map), `openUVEditor3D`, `closeUVEditor3D`, `UVEditorSession`, `_uvPaintOpenedEditor` | `_uvSessions` **STAYS** (shared w/ `UVEditManager` l.580 + mesh-edit gate l.597 + persistence l.7427); reached via host hooks |
| **Packaging** | `_packaging.isPackageNode`, `_pkgComposites`, `_pkgRecomposite`, `_pkgStrokeRecompositeLast`, `syncLiveTextures3D` | **INVERTED** — passed in as stroke-hook callbacks (see §3) |
| **Brush system** | `rasterDrawingService.getPaintEngine`/`getEraseMode`, `_mirrorBrushToUVEngine`, `_garmentEraseStyle` | `_mirrorBrushToUVEngine` **MOVES**; brush engine via ctx/host |
| **scene3d + textures** | `scene3d.getMesh`/`enterSurfacePaintInput`/`enterSurfacePaintInputMulti`/`exitSurfacePaintInput`, shared `_uvPaintTextures` map | scene3d via host; `_uvPaintTextures` **STAYS** (see §2) |

## 2. Ownership split — the load-bearing decision

**UVPaintSessionManager OWNS** (moves out of the facade):
- `_uvPaintController?: UVPaintController` + its full lifecycle (create-on-demand, enter character, arm packaging, exit).
- `_paintSessionKind: 'character' | 'packaging' | null`.
- `_uvPaintDoubleSided`, `_uvPaintOpenedEditor` (per-session teardown state).
- `_uvPaintCanvases` (if only paint uses it — verify at cut time).
- Methods: `enterUVPaintMode3D`, `armPackagingPaint` (renamed from `_armPackagingSurfacePaint`), `exitUVPaintMode3D`, `isUVPaintActive3D`, `_mirrorBrushToUVEngine`, pane attach/detach + `debugState` passthroughs.

**STAYS in the facade** (shared resources — moving them would create *new* coupling, not remove it):
- **`_uvPaintTextures` (Map<meshId, RasterTextureManager>)** — also written by **Decals Mode B** (`_ensureDecalTexture`), **procedural-prop restore** (`_pendingProcTextures` / `_restoreProceduralMeshTextures`), render-style caps (l.5179), delete-cleanup (l.3998). The session manager reads it through a host hook `ensureUVPaintTexture(meshId)`. ★ When Decals Mode B moves later, it takes the *same* hook — the map has ONE owner (facade) throughout.
- **`_uvSessions`** — shared with `UVEditManager` + persistence. Session manager gets `getUVSession`/`openUVEditor`/`closeUVEditor` host hooks.
- `_ensureUVPaintTexture` impl, `openUVEditor3D`/`closeUVEditor3D` impls, all packaging internals (`_pkgComposites`, `_pkgRecomposite`, `syncLiveTextures3D`), `_garmentEraseStyle` + garment retint (character-paint-adjacent but not session-lifecycle).

## 3. The dependency inversion (the core of the design)

Today `_armPackagingSurfacePaint` **reaches down** into packaging inside the controller's stroke hooks:
```ts
// BEFORE (in shape-manager, packaging knowledge baked into the paint session):
this._uvPaintController.onStrokeMove = () => { …throttle…; this._pkgRecomposite(pkgId); };
this._uvPaintController.onStrokeEnd  = () => { this.syncLiveTextures3D(); this._pkgRecomposite(pkgId); };
```
After: `armPackagingPaint` takes an **options bag of callbacks** the caller supplies; the session manager wires them onto the controller but knows nothing about packaging:
```ts
// AFTER — UVPaintSessionManager (packaging-agnostic):
armPackagingPaint(meshIds: string[], opts: {
    resolveTexMgr: () => RasterTextureManager | null;     // dieline layer's live manager (by layer id)
    readbackTexMgr: () => RasterTextureManager | null;    // whole-stack composite the box samples
    onStrokeMove?: () => void;                            // caller throttles + recomposites
    onStrokeEnd?: () => void;                             // caller syncs live-textures + recomposites
}): boolean { … }

// The PACKAGING host adapter (still in the facade, owns _pkgComposites/_pkgRecomposite) supplies them:
armSurfacePaint: (meshIds, layerId) => this._uvPaint.armPackagingPaint(meshIds, {
    resolveTexMgr:  () => this.rasterLayerManager?.getLayerById(layerId)?.manager ?? null,
    readbackTexMgr: () => { const p = this._packaging?.isPackageNode(meshIds[0]); return p ? this._pkgComposites.get(p)?.mgr ?? null : null; },
    onStrokeMove:   () => this._pkgRecompositeThrottled(meshIds[0]),   // 33ms throttle moves here
    onStrokeEnd:    () => { this.syncLiveTextures3D(); this._pkgRecompositeNow(meshIds[0]); },
}),
```
Result: `UVPaintSessionManager` imports nothing from packaging. Packaging (facade for now, `PackagingManager` later) subscribes to the paint session — exactly the inversion the spec wants, and the seam Packaging's own extraction will reuse.

## 4. Host / ctx interface (proposed)

From `ManagerContext`: `webgpuRenderer` (getDevice), `interactionService`, `scheduleRender`, `rasterLayerManager`.

Narrow host (facade supplies; ~7 hooks — wide, but each is a genuine shared-owner seam, not incidental):
```ts
export interface UVPaintSessionHost {
    readonly scene3d: Scene3DManager;                                  // getMesh + surface-paint input
    getPaintEngine(): PaintEngine | null;                             // rasterDrawingService.getPaintEngine()
    getEraseMode(): unknown | null;                                    // rasterDrawingService.getEraseMode()
    ensureUVPaintTexture(meshId: string, size?: number): RasterTextureManager | null;   // facade owns _uvPaintTextures
    getUVSession(meshId: string): UVEditorSession | undefined;         // facade owns _uvSessions
    openUVEditor(meshId: string): UVEditorSession;                     // openUVEditor3D
    closeUVEditor(meshId: string): void;                               // closeUVEditor3D
    getGarmentEraseStyle(): 'burn' | 'clean' | 'cutout';              // read for _mirrorBrushToUVEngine
}
```
(Exact set finalized at cut time by grepping every `this.` in the moved bodies — the getter/bridge technique keeps bodies verbatim.)

## 5. Public API preserved (facade delegators)

`enterUVPaintMode3D`, `exitUVPaintMode3D`, `isUVPaintActive3D`, the packaging `armSurfacePaint`/`disarmSurfacePaint` host-adapter entries, pane `attach`/`detach`, `debugState`. Internal callers (garment paint l.5627, decal paint l.7302, re-enter-after-id-change l.7161) call the facade delegators unchanged.

## 6. Migration steps (each tsc-checkpointed; STOP if any step isn't green)

1. **Add `ensureUVPaintTexture` / `openUVEditor` / `closeUVEditor` / `getUVSession` as facade methods** if not already public-ish, so the host bag can reference them (no behavior change).
2. **Introduce the callback bag on `_armPackagingSurfacePaint`** IN PLACE (still in the facade): move the `_pkgRecomposite`/`syncLiveTextures3D` logic into caller-supplied `onStrokeMove`/`onStrokeEnd` passed from the packaging host adapter (l.4125). Verify packaging paint still works **in the browser** — this is the risky behavioral change, done BEFORE the file move so it's isolated.
3. **Create `UVPaintSessionManager`** (ctx + host) and move the controller + lifecycle + state VERBATIM behind getters/bridges. Facade keeps delegators.
4. **Rewire** the 3 internal `enterUVPaintMode3D` callers + the packaging adapter to the delegators/`_uvPaint`.
5. **tsc + vitest + build**; then the browser matrix (§7).

## 7. Verification — almost entirely browser (I cannot unit-test live painting)

Unit-testable (thin): `isUVPaintActive3D` false initially; exit is a safe no-op when nothing armed; `armPackagingPaint` returns false when mesh/device/texMgr missing; the callback bag is invoked on stroke events (with a fake controller). **Everything else is browser-verify:**
- **Character:** paint a garment + hair (brush colour/erase/grain from the 2D panel), orbit to the far side (double-sided restore), exit (editable wireframe + mesh-edit orbit/background all close), save + reload → paint persists.
- **Packaging:** enter a box, paint the dieline via 3D drag AND via the UV pane, confirm the box updates live (throttled recomposite) + on stroke-end, freshly-created package shows paint, reloaded package shows paint (the `resolveTexMgr` re-resolve fix), disarm cleanly.
- **Cross-kind:** arm character → arm packaging without exiting → the character session's double-sided/editor state doesn't leak onto the package (the `_paintSessionKind` guard).

## 8. Risks

- **Step 2 is the real risk** (moving the recomposite logic to caller callbacks) — a behavioral change to live packaging paint. Isolate + browser-verify it BEFORE the file move.
- **Wide host (7 hooks)** reflects genuine shared ownership; acceptable, but if it grows past ~10 during the cut, reconsider whether `_uvPaintTextures` or `_uvSessions` should have a smaller façade rather than raw hooks.
- **Not a size win** — like 2D-fromJSON, this is mostly *decoupling for its own sake* (it unblocks Decals-B + Packaging). The payoff is the inverted seam, not lines removed.

## 9. Open decision for sign-off

Only one real fork: **where the throttled-recomposite + composite-lookup live.** This plan puts them in the **packaging host adapter** (facade now → `PackagingManager` later), keeping `UVPaintSessionManager` packaging-agnostic. Alternative: a `PackagingPaintBinding` helper object. Recommendation: **host-adapter callbacks** (simplest, and it's exactly what `PackagingManager` will own after its own extraction). Confirm and I execute §6.

---

## Execution note — 2026-08-17 (after Step 2)

**Step 2 DONE + browser-verified** (packaging dieline paint works). The packaging dependency is inverted: `_armPackagingSurfacePaint` takes caller-supplied `readbackTexMgr`/`onBeforeStroke`/`onStrokeMove`/`onStrokeEnd`; the packaging host adapter supplies them. **This banks the actual architectural win** the spec wanted (the seam Packaging's extraction reuses).

**Step 3 re-scoped (wider than §4 assumed):**
- `_mirrorBrushToUVEngine` must **stay in the facade** (refs `_packaging.isPackageNode` + `rasterDrawingService` + `_garmentEraseStyle`) → session manager calls it via a `mirrorBrush()` host hook, and the facade copy reads the controller via `_uvPaint.getEngine()`/`activeMeshId()` (a mutual-reference seam).
- The controller needs ~11 public passthroughs re-exposed (`setBrush`/`attachPane`/`paneUVToCanvas`/`detachPane`/`debugState`/`activePane`/`activeMeshId`/`refreshPane`/`getEngine`/`isActive`) for ~10 external call sites (pane attach l.4403, id-swap re-arm l.7180, closeUVEditor l.7467, dispose l.7494, debugState l.4872, setBrush l.6955…).
- `_uvPaintCanvases` **stays** (UV-editor-scoped, not paint-session).
- Net: ~250 lines relocated behind a ~15-method surface + ~10 rewires, fully **browser-gated** (character garment/hair paint + package dieline paint + the id-swap re-arm), for value **already captured by Step 2**.

**Recommendation:** treat Step 3 as OPTIONAL god-object shrink. Higher-value next moves (both unblocked by Step 2) = **Packaging composite extraction** and **Decals Mode B** (needs only a `_uvPaintTextures` host hook). Do Step 3 later (or skip) unless the god-object line-count is the priority.
