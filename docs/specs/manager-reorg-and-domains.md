# Manager Reorganization & Domain Structure — Spec

**Created 2026-08-17.** Grounded in a 4-agent code survey (ShapeManager anatomy · 2D-scene architecture · animation architecture · orchestration/persistence/DI). Companion to `god-object-status-and-mcp.md` and `armature-tangle-extraction-map.md`. Supersedes the flat "extract 9 things from shape-manager" queue in `god-object-status-and-mcp.md §3` — the survey shows that queue was organized by *what's inline* rather than *by domain*, and several of its items were mis-scoped.

---

## 0. TL;DR — the verdicts

The façade→domain→renderer structure **already largely exists**. This is a *finishing* job, not a re-architecture. Concretely:

- **NO `Scene2DManager`** (as a state owner). The 2D scene is already well-distributed (`SceneGraph` + shape classes + `InteractionService`/`SelectionService` + `RasterLayerManager` + `DrawingToolManager`). A Scene2DManager would mostly forward — it has nothing orphaned to own, unlike Scene3DManager did.
- **NO unified `AnimationManager`.** 2D and 3D animation are *separate paradigms*, not a shared core: 3D uses interpolated keyframe tracks; 2D uses **cel-swap** (no interpolation); "frame-link" exists on both sides but is **fully duplicated** (GPU UV-displacement shader vs CPU transform deltas). Unifying them behind an `Animatable` interface is a multi-week, high-risk rewrite with little payoff.
- **GARP stays a facade-layer registry**, wired into scene3d via the existing `setGarpLayerResolver` **dependency-inversion hook** — NOT moved into scene3d. That hook is the template to copy everywhere.
- The real work = move **5 inline glue blocks** into homes that *mostly already exist*, in dependency order.
- **Two genuine wins beyond organization:** (1) **async document restore** (`restoreProceduralFromSave3D` — the load bottleneck *and* the AI "generate a city" path), (2) a **shared frame-clock** DRY (two RAF loops today).
- **Name collision:** a class named `DocumentPersistence` already exists (the OPFS *storage* driver). The orchestrator to extract must be named differently — **`DocumentStateCoordinator`**.

**Bottom line: this is ~mostly organization + testability, with two real wins (async restore, shared clock). None of it is required for the SceneAuthoringAPI, which can be built now on the existing surface.**

---

## 1. Current architecture (grounded in the survey)

`ShapeManager` (`src/services/shape-manager.ts`, **14,262 lines**, ~1,160 public + 137 private members) is the host-facing facade (`sm.*`). Of it:
- **~5,400–5,900 lines** = its own inline subsystems (the extraction targets).
- **~4,000–4,500 lines** = thin delegators, overwhelmingly to ONE collaborator: **659 `this.scene3d.*` references** (281 are one-line `return this.scene3d.…`); + ~60 to procedural managers, 48 meshEdit, etc.
- **~1,200 lines** = constructor + `initDelegates` wiring (273–923).

**Three DI patterns already in play** (this is good — the inversions exist):
1. **`ManagerContext` bag** (`manager-context.ts`) → RasterManager, TextManager, AnimationManager, Scene3DManager. Explicitly breaks the circular dep (managers never import ShapeManager).
2. **Direct `Scene3DManager` injection** → WorldManager, the 11 creator managers (they take scene3d whole).
3. **Narrow-host bags** → `PackagingManager` gets a hand-built `PackagingHost` exposing only ~20 hooks.

**★ The exemplar inversion (copy this everywhere):** `Scene3DManager.setGarpLayerResolver(fn)` (scene3d-manager.ts:1690) — scene3d exposes a **callback slot**; ShapeManager wires `GarpManager` into it (shape-manager.ts:409–417). Scene3d holds only a *function pointer*, never a `GarpManager` reference. The renderer stays ignorant of the domain manager; the facade supplies resolution. This is exactly the target façade→(domain+renderer) shape.

**Dependency graph today:**
```
ShapeManager (facade)
├─ ManagerContext ──▶ RasterManager, TextManager, AnimationManager, Scene3DManager
├─ Scene3DManager ──▶ WebGPURenderer            [renderer tier]
│     ▲ setGarpLayerResolver(fn)  ← function pointer only   ★ INVERSION
├─ WorldManager, 11 creators ──▶ Scene3DManager
├─ PackagingManager (host) ──▶ Scene3DManager + rasterLayers + LiveTexture + Ephemera
├─ GarpManager (registry, no deps)      ◀── resolver + seeders wired by facade
├─ EphemeraService (registry, no deps)
├─ _uvPaintController (SHARED — character ∧ packaging)   ← the cross-cut
└─ DocumentPersistence (OPFS storage) ◀── stateProvider = gatherDocumentState()
```

---

## 2. Design principles (confirmed by the survey)

1. **Organize by DOMAIN; dependencies flow facade → domain → renderer, never backward.**
2. **Copy the GARP inversion:** a low-level tier exposes a callback slot; the facade wires the high-level manager in. The renderer never references the domain manager.
3. **Cross-cutting concerns = thin COORDINATORS that delegate to domain owners**, not monoliths that absorb domain logic.
4. **Extract into homes that already exist** (`GarpManager`, `PackagingManager`, `EphemeraService`) where possible; create new managers only where there's genuinely orphaned state.
5. **Don't invent state owners that have nothing to own** (the Scene2DManager trap).

---

## 3. Decisions on the open architectural questions

### 3.1 `Scene2DManager`? — NO (as a state owner)
The 2D scene is already decomposed into well-chosen homes: tree in `SceneGraph`, per-shape state/geometry/hit-test/`toJSON` on the shape classes, viewport+selection in `InteractionService`/`SelectionService`, tools in `drawing/*` + `DrawingToolManager`, layers/raster in `RasterLayerManager`/`RasterManager`. A Scene2DManager would mostly forward.
**Instead, two targeted 2D wins:**
- **(2D-a) Reconcile the two shape-creation entry points.** There are two public ways to make a rectangle/circle/triangle: `ShapeManager.createRectangle(x,y,w,h,strokeColor,strokeWidth)` (l.2585 — full-control: custom stroke + honors `_activeVectorLayerId`) and `DrawingToolManager.createRectangle(x,y,w,h)` (l.110 — defaults-baked: black 1px, ignores the active layer). **NOT verified to be a bug:** neither is called anywhere inside this repo (both are host-facing API), and there is no rectangle *drawing service*, so these ARE the two creation paths. The layer-awareness inconsistency is real, but whether it bites depends on which one Frogmarks calls and whether vector layers are in active use — verify host usage before assuming one is canonical / the other legacy. If confirmed, consolidate onto the layer-aware path and have the other forward.
- **(2D-b) Lift 2D deserialization out of `recreateNode`.** The 370-line `switch(type)` (l.11209–11582) mixes 2D+3D restore; shapes own `toJSON` but not their own restore (asymmetric/brittle). Give each shape a static `fromJSON` (mirroring `toJSON`), or a `ShapeSerializer` dispatch module.
- **(optional) A thin `scene2d` FAÇADE** (`shapeManager.scene2d`) composing `DrawingToolManager` + `SelectionService` + vector-layer wrappers — worth it ONLY as an API-shaping move for the MCP (verb-group symmetry), scoped as a few-hundred-line facade, not a state holder.
- **Cleanup:** `LayerManager` (63 lines) looks vestigial vs `RasterLayerManager` (the real illustration stack). Two conflicting "layer" concepts — consider retiring `LayerManager`.

### 3.2 Unified `AnimationManager`? — NO
2D and 3D animation share vocabulary, not logic:
- **Keyframes are 3D-only.** `keyframeTracks`/`sampleTrack`/interpolators exist only on 3D nodes (mesh/skeleton/gp). 2D vector shapes have **no** track storage. 2D animation = **cel-swap** (`AnimationCel` = a texture that occupies a frame range; `AnimationTimeline.getTextureAtFrame`), zero interpolation. 3D itself has *two* unrelated keyframe systems: property-track **lerp** (`keyframe-3d.ts`, mesh+camera) vs joint **slerp** (`skeleton-animator.ts`).
- **Frame-link is fully duplicated:** 2D = `FrameLinkAnimation` → **GPU WGSL shader** UV-displacement in `raster-compositor.ts` (wave/ripple/turbulence); 3D = `FrameLinkAnimation3D` → **CPU** `evalFrameLink3D` transform deltas (bounce/sway/spin). Different types, math, execution. Even shared `'shake'` is coded twice.
- An `Animatable {tracks; apply(frame)}` interface would fit Mesh3D/Camera (already effectively that shape), be **greenfield** for 2D vectors (nothing keyframes them), and **exclude** raster cels and skeletons. Impedance mismatch, not a small adapter.

**Instead, the real animation win — extract a shared CLOCK, not the model:** `AnimationTimeline` (2D, `animation-timeline.ts:265`) and `AnimationPlayer3D` (`animation-player-3d.ts:117`) are two RAF loops with near-identical fps / play-range / loop-mode / accumulation logic, bridged by `set3DPlaybackSync` + `attachKeyframesToTimeline`. Extract one `FrameClock` both sides drive (~2–3 day bounded DRY win). Also **retire the legacy `src/services/animation/animation-service.ts`** (setInterval scene-graph swap — dead/superseded). Keep the two frame-links intentionally separate (WGSL vs TS — don't merge).

### 3.3 `GarpManager` inside `scene3d`? — NO
Keep the `setGarpLayerResolver` inversion. GARP is orchestration (composes world + textures + scene3d); it belongs at the facade layer as `GarpManager`. Moving it into scene3d would make the renderer depend on high-level texture-pooling — backwards.

---

## 4. The extraction plan (dependency-ordered, verified line ranges)

Line ranges verified against the current 14,262-line file. Ordered by dependency + easiest-first.

| # | Unit | Lines (~) | Target owner | Order constraint | Difficulty | What it buys |
|---|---|---|---|---|---|---|
| 1 | **Ephemera overlay** | 13734–13873 + 13915–14218 (~440) | `EphemeraService` (exists) → + an `EphemeraOverlayView` | independent | low | 2D overlay render + placement hit-testing out of the facade |
| 2 | **Decals** | 5303–5526 + 5992–6089 (~320) | new `DecalManager` (3D-domain) | independent | low | id-keyed, self-contained pilot |
| 3 | **LiveText + custom shaders** | 9877–10386 (~510) | new `LiveTextManager` (2D) | independent | low | owns `TextEffectEngine` + LiveTextNode lifecycle |
| 4 | **2D shape deserialization** | recreateNode 11209–11582 (~375) | `ShapeSerializer` / per-shape `fromJSON` | independent | low-med | symmetric persistence; shrinks a god-method |
| 5 | **Reconcile shape-creation entry points** | 2585–2637 etc. | `DrawingToolManager` (exists) | independent | low | one layer-aware create path (unverified inconsistency — check host usage first) |
| 6 | **GARP seeders + paint-bridge** | 5528–5990 (~460) | `GarpManager` (exists) | paint-bridge waits on #7 | low-med | seeders/atlas into their owner |
| 7 | **UV-paint sessions** | 6759–7140 (~380) | new `UVPaintSessionManager` | **must precede #8** | **med** (the cross-cut) | one owner for the shared `_uvPaintController` + both session lifecycles |
| 8 | **Packaging composite** | host 4009–4540 + composite 4542–4929 (~920) | `PackagingManager` (exists) | after #7 | med | the 2D-layer-stack composite half joins the box half |
| 9 | **Shared frame-clock** | from `animation-timeline.ts` + `animation-player-3d.ts` | new `FrameClock` | independent | med | DRY the two RAF loops; retire legacy `animation-service.ts` |
| 10 | **Document state orchestrator** | 12713–13572 (~855) | new **`DocumentStateCoordinator`** (NOT `DocumentPersistence`) | **LAST** | high | thin coordinator once #1–8 own serialize/restore; the async-restore perf target |

**Sequencing rationale:** independents first (#1–5), the cross-cut chain next (#7 UV-paint → #8 packaging), the clock DRY (#9), then the persistence coordinator LAST (#10) once every subsystem owns its own (de)serialization.

---

## 5. The two real wins beyond organization

### 5.1 Async document restore (the load bottleneck + the AI "generate a city" path)
`restoreProceduralFromSave3D` (shape-manager.ts:6219–6239) is **fully synchronous** on the main thread inside the awaited restore (bracketed by the `_lap('★ procedural regen …')` timer at 13542 — the confirmed hotspot). It runs back-to-back with no yielding:
- `world.restoreFromSave()` — regenerates the **whole city** (layout/biome/streets/buildings);
- `blocks.restoreFromSave()`;
- a loop over **all 11 procedural creators**, each re-running its generator;
- `restoreDecalsFromSave3D()`; `packaging.restoreFromSave()`.
Because every generator is a pure param→geometry function, the fix is tractable and high-value: **(a) yield between creators** (unblocks paint/UI), **(b) worker-offload the heavy city build** (world.ts already uses worker offloads elsewhere), **(c) progressive reveal** (chunk block/creator regen). This is BOTH a load-time win AND makes an AI-driven "generate a big city" call non-blocking. Isolating `DocumentStateCoordinator` (#10) is the natural moment to do it.

### 5.2 Shared `FrameClock` DRY (#9)
Two RAF loops (`AnimationTimeline` 2D, `AnimationPlayer3D` 3D) with near-identical fps/play-range/loop/accumulation, today bridged by `set3DPlaybackSync`. One shared clock both drive → less drift, one place for playback semantics. ~2–3 days.

---

## 6. The cross-cutting bridges (the real design tension)

Everything else is mechanical; the design calls live here.

### 6.1 UV-paint (#7) — the single most entangled subsystem
ONE `_uvPaintController` (shape-manager.ts:199) serves TWO session kinds disambiguated by `_paintSessionKind: 'character' | 'packaging'` (214): character paint (keyed by mesh id, writes the mesh's `RasterTextureManager`) and packaging paint (keyed by layer id, calls `_pkgRecomposite` + `syncLiveTextures3D` on every stroke). The packaging session **reaches directly into `_pkgComposites`/`_pkgRecomposite`** — so UV-paint and Packaging are mutually entangled through this shared object.
**Fix:** `UVPaintSessionManager` owns the controller + both lifecycles and exposes **stroke-lifecycle hooks** (`onStrokeMove`/`onStrokeEnd`) that `PackagingManager` *subscribes* to — inverting the dependency so the paint session no longer reaches into packaging internals. This is why #7 must precede #8.

### 6.2 Packaging (#8) — a 3D box whose surface is a 2D layer-stack composite
`PackagingManager` (`src/packaging/packaging-manager.ts`) already owns the box (geometry/hinge-fold/editor). The **composite controller** is still inline in the facade (`_pkgComposites`/`_pkgRecomposite`/`_pkgRefreshVectorProxies`/vector-proxy rasterization). It fuses scene3d panels + rasterLayerManager + `RasterCompositor` + `LiveTextureMode` + `EphemeraService` + the shared UV-paint controller.
**Fix:** move the composite controller into `PackagingManager` (or a `PackagingComposite` sub-object it owns), consuming the clean `UVPaintSessionManager` stroke hooks from #7.

---

## 7. Effort, risk, and non-goals

**Effort:** multi-session, like scene3d. #1–5 are clean like the scene3d "easy tier." #7–8 are the scene3d-tangle-equivalent coupling (the UV-paint/packaging bridge). #10 is large but collapses to thin once #1–8 own their serialize/restore.

**Risk:** mostly low (behavior-preserving delegators + `tsc`/tests). BUT: #7–8 are **browser-gated** (interactive paint on 3D surfaces — unit tests can't cover the stroke path), and #10's async-restore work must **preserve the strict load-order constraints** (meshes → textures → rigs → procedural regen; `_isRestoring` guard; single terminal `emit`).

**Explicit NON-goals (from the survey):**
- No state-owning `Scene2DManager`.
- No unified `AnimationManager`; don't merge the two frame-links (WGSL vs TS).
- Don't name the orchestrator `DocumentPersistence` (collides with the OPFS driver) → `DocumentStateCoordinator`.
- Don't move GARP into scene3d (keep the resolver inversion).

---

## 8. Relationship to the SceneAuthoringAPI / "MCP"

**None of §4 is required for the SceneAuthoringAPI.** It can be built now over the existing clean surface (`createBox3D`, `world.generateWorld`, `createCreator3D` + `creatorParamSchema3D`, `createFullCharacter3D`, materials, lighting…). The decomposition tidies the file those live in; it doesn't unlock them.

Where the reorg *does* help the API: the **domain grouping falls out into clean verb groups** (`scene2d` / `scene3d` / `animate` / `world`), and **§5.1 async restore** is the same code path an AI "generate a city" call hits — so making it non-blocking is directly an AI-responsiveness win.

**Recommended value ordering (highest payoff first), independent of the full queue:**
1. **§5.1 async document restore** — the one concrete perf + AI-responsiveness win. Can be done semi-independently (doesn't strictly require #1–8 first, though it's cleaner after #10).
2. **The SceneAuthoringAPI** — the actual goal; buildable now.
3. **§4 #1–5** (independents) — clean organization + testability wins.
4. **§9 shared clock**, **§4 #6–8** (the bridges), **#10** — the heavier, mostly-organization tail.

---

# Appendix — raw survey detail (preserved verbatim; the granular tables the §-body condensed)

> These are the expensive-to-regenerate findings from the 4-agent survey (2026-08-17). Line numbers are against the current 14,262-line `shape-manager.ts` unless noted. **Reminder (see §3.1): intent-level claims below — "unused", "vestigial", "dead" — are LEADS, not verified facts; caller-trace before acting.**

## A1. ShapeManager inline-vs-delegation (survey: anatomy)
- 14,262 lines; ~1,160 `public` + 137 `private` members. Delegation funnels to ONE sink: **659 `this.scene3d.*`** refs (281 one-line `return this.scene3d.…`); +60 procedural managers, 48 `meshEdit`, 13 `meshPaint`, 12 `_uvEdit`, 9 `drawing`, 5 `layerManager`.
- Split: ~5,400–5,900 inline-subsystem lines · ~4,000–4,500 thin-delegator lines (doc-comment-inflated) · ~1,200 wiring (constructor+initDelegates 273–923).

**Public-API method groups:**
| Group | inline vs delegation | ~methods | key lines |
|---|---|---|---|
| Raster / brush / dither / grain | mixed (floodFill/fillSelection/flip/rotate/scale inline; brush/dither delegate) | ~130 | 924–2246 |
| Frame-link (2D) | thin delegation + config-merge → rasterLayerManager | ~16 | 2247–2343 |
| Layers (raster+vector) | thin delegation → layerManager/rasterLayerManager | ~40 | 1296–1432, 2345–2452, 13682–13712 |
| Vector shapes / connectors / speech balloon | thin (shapeFactory/connectorService); recreateNode inline | ~40 | 2659–2818, 10597–10782, 11209–11780 |
| Text / LiveText / custom shaders | mostly INLINE (own TextEffectEngine + LiveTextNode) | ~35 | 9752–10484, 11781–11924 |
| Procedural creators | ~pure thin one-liner delegation | ~90 | 5186–6255 |
| Packaging | INLINE host-wiring + composite | ~15 pub + ~20 priv | 3980–4929 |
| Decals | INLINE | ~20 | 5303–6089 |
| GARP | INLINE (owns GarpManager) | ~15 | 5528–5990 |
| UV paint | INLINE bridge (shared _uvPaintController) | ~15 | 6759–7140 |
| Kitbash/character/body/clothing/hair/face/attach | thin → scene3d (the 659 sink); setClothingParams3D partly inline | ~120 | 5030–5137, 6258–6309, 7147–7452 |
| Mesh-edit / UV-editor / modifiers / arrays | thin → meshEdit/_uvEdit/scene3d | ~150 | 6512–8190 |
| Armature/skeleton/IK/spring/poses/clips | thin → scene3d | ~110 | 3128–3850 |
| Mesh CRUD/materials/lighting/camera/gizmo/picking | thin → scene3d/renderer3D | ~140 | 2819–3120, 8190–8830 |
| Cloth/particles/ribbon/html-texture | thin → scene3d | ~70 | 9067–9672 |
| Ephemera / vector placements | INLINE (overlay render + hit-test) | ~45 | 13574–14218 |
| Animation/keyframes | thin → rasterLayerManager.getTimeline() + scene3d | ~60 | 8856–9060, 12140–12418 |
| Save/load/persistence/packaging-project | INLINE orchestration | ~35 | 12420–13572 |
| Panels (comic layout) | thin → PanelLayout nodes | ~15 | 10485–10595 |

**Verified inline-subsystem line ranges:** constructor+initDelegates 273–923 · frame-link-2D 2247–2343 · packaging host 4009–4540 + composite 4542–4929 · decals 5303–5526 + 5992–6089 · GARP 5528–5990 · UV-paint 6759–7140 (state decls 187–214) · livetext 9877–10386 · recreateNode 11209–11582 · doc-persistence gather 12970–13150 + restore 13152–13572 + helpers 12713–12968 · ephemera overlay 13734–13873 + placement 13915–14218.

## A2. Where 2D logic lives (survey: 2D architecture)
| 2D concern | Home | State |
|---|---|---|
| Scene tree | `SceneGraph` (scene-graph/core/scene-graph.ts, 53 ln) | separated (shared w/ 3D) |
| Shape state/geometry/hit-test/toJSON | shape classes (scene-graph/shapes/*) | separated (on shapes) |
| Construction | `ShapeFactory` (shape-factory.ts, 393 ln, stateless) | separated |
| Viewport/selection set/picking | `InteractionService` (434 ln) + `SelectionService` (53 ln) | separated |
| Tool interaction | `drawing/*` services + `DrawingToolManager` | separated |
| Raster + layer stack | `RasterManager` + `RasterLayerManager` (1538 ln) | separated (clean) |
| Shape CRUD (create/delete) | split — inline ShapeManager AND DrawingToolManager | see §3.1 (unverified) |
| Restore/deserialization | inline `recreateNode` (11209–11582) | inline |
| Vector-layer CRUD | ShapeManager wrappers → RasterLayerManager (13682+) | inline pass-through |
Notes: shape ctors take `InteractionService` (viewport coupling baked in → blocks headless build). `LayerManager` (63 ln, scene-graph children as "layers") looks vestigial vs `RasterLayerManager` (the real stack, also holds vector+ephemera layers). Vector shapes carry a bare `layerId` string indexing the raster manager's vector-layer list (cross-domain seam, no vector-side owner). No rectangle/circle/triangle *drawing service* exists (unlike line/scribble/text/polygon/etc.).

## A3. Animation surface map (survey: animation) — 2D & 3D are SEPARATE paradigms
| System | Data/types | Sampler/eval | Owner | Clock |
|---|---|---|---|---|
| 2D raster cels | AnimationCel (src/animation/) | none (texture swap) | AnimationTimeline + AnimationManager (sm.animation) | AnimationTimeline own RAF (timeline.ts:265) |
| 2D frame-link | FrameLinkAnimation (animation-types.ts:112) | **GPU WGSL** raster-compositor.ts (~897; params ~202) | RasterLayerManager | reads currentFrame |
| 3D mesh keyframes | Mesh3DKeyframeTracks (keyframe-3d.ts) | sampleTrack lerp/bezier (keyframe-3d.ts:113) | Scene3DKeyframes + applyMeshKeyframesAtFrame (scene3d-mgr:5928) | AnimationPlayer3D OR raster timeline |
| 3D camera keyframes | Camera3DKeyframeTracks | sampleTrack (shares mesh core) | scene3d _cameraKeyframeTracks (5917) | same |
| 3D frame-link | FrameLinkAnimation3D (keyframe-3d.ts:166) | **CPU** evalFrameLink3D (:201) | scene3d _frameLinkAnims3D (425,6007) | inside keyframe apply |
| 3D skeleton clips/NLA/IK | armature-3d.ts types | skeleton-animator.ts own sampleKeyframes + quat.slerp (:29) | Scene3DArmature/Skeleton3D | own path |
| Cloth/particles/ribbon | physics state | per-tick integrate | scene3d-cloth/particles/ribbons | wind via 3D frame-link |
| AnimationService (LEGACY) | scene-graph JSON frames | setInterval full child swap | services/animation/animation-service.ts | near-dead — retire |

**Frame-link 2D vs 3D (fully duplicated, name-only overlap):** 2D wave/shake/ripple/noise/turbulence → UV texel displacement, GPU shader, per-layer. 3D bounce/sway/spin/pulse/shake/scroll/wind → transform deltas+uvOffset+wind, CPU, per-mesh. Even shared `'shake'` coded twice.
**Playback bridge (the one real coupling):** raster `AnimationTimeline` = master clock. sm.animation.set3DPlaybackSync (shape-mgr:551) → raster play/pause drives scene3d.startSyncedPlayback/stopSyncedPlayback (scene3d-mgr:1172 → AnimationPlayer3D own RAF, animation-player-3d.ts:117). attachKeyframesToTimeline3D (shape-mgr:8881 → scene3d:5885) subscribes 3D keyframe apply to timeline `frame-changed`. **Two RAF clocks bridged by play/pause sync + frame-changed sub → the FrameClock DRY target (§5.2).**

## A4. Persistence sequences + DI (survey: orchestration/persistence/DI)
**★ Name collision:** `DocumentPersistence` class already exists = OPFS storage driver (src/services/persistence/document-persistence.ts; sm field `persistence` 243; `setStateProvider(()=>gatherDocumentState())` 12453). Orchestrator to extract ≠ that → **`DocumentStateCoordinator`**.

**gatherDocumentState (12970–13146):** canvas/layer meta → anim state+cels → manifest → raster pixel exports → 3D block (13063–13095: getGlobalScene3DSettings, serialize{Face,Clothing,Hair}Rigs, serializeBodyParams, serializeAttachments, serializeBakedParts, node states, skeletons, _packaging.serialize) → meshTextures (UV-paint PNGs keyed by STABLE `__cloth__:`/`__proc__:`/`__face__:` so regenerated meshes re-apply paint, 13097–13124) → baked-part GLBs → _ephemera.serialize (13140) → _garp.serialize (13143).
**restoreDocumentState (13152–13569):** scene-graph JSON → brushes → doc size → raster layers (setSize→clearAllLayers→recreate w/ saved id→uploadPixels→normalize, 13191–13261) → anim state → 3D scene JSON + registerRestoredArrayGroups + packaging.restoreFromJSON (13394–13410) → texture library (after meshes) → UV-paint textures split face/cloth/proc (13427–13453) → restore{Face,Clothing}Rigs → clothing textures → restoreHairRigs → restoreAttachments → restoreBakedParts → restoreBodyParams (13456–13495) → _ephemera.deserialize (13500) → _garp.restore + rebuildGarpAtlas3D (13511) → clearUndo3D → **restoreProceduralFromSave3D()** (13535) → frame sync → single onSceneGraphChanged.emit (13568). ORDERING IS LOAD-BEARING: meshes→textures→rigs→procedural; `_isRestoring` guard; single terminal emit.
**★ Load bottleneck restoreProceduralFromSave3D (6219–6239, timer _lap '★ procedural regen' @13542):** sync, main-thread — world.restoreFromSave (whole city) → blocks.restoreFromSave → loop all 11 creators m.restoreFromSave → restoreDecalsFromSave3D → packaging.restoreFromSave. All pure param→geometry, no yielding → async/worker/progressive-reveal target.

**DI patterns:** (1) ManagerContext bag (raster/text/animation/scene3d — never import ShapeManager; built 379–391). (2) Direct scene3d injection (WorldManager ctor world-manager.ts:164; 11 creators 418–429). (3) narrow-host bag PackagingHost (packaging-manager.ts:496, lazy `get packaging()` 4009, ~20 hooks). GarpManager (5528) + EphemeraService (247) = dep-free registries.
**★ GARP inversion:** scene3d.setGarpLayerResolver(fn) (scene3d-mgr:1690) ← wired by facade (shape-mgr:409–417); `(pool,slot,x,z,seed,skin?)=>layerIndex`; seeders idempotent+sync so layers assign same-frame as city instantiate. scene3d holds only the function pointer. **THE template.**
**UV-paint entanglement:** one `_uvPaintController` (shape-mgr:199), `_paintSessionKind:'character'|'packaging'` (214). Character = keyed by mesh id, writes mesh RasterTextureManager. Packaging = keyed by layer id, calls _pkgRecomposite + syncLiveTextures3D per stroke (7033–7042) → reaches into _pkgComposites. Fix: UVPaintSessionManager owns controller + both lifecycles, exposes onStrokeMove/onStrokeEnd hooks PackagingManager subscribes to (invert the dep) → must precede packaging extraction.

---

## Progress log

**2026-08-17 — §4 #1 Ephemera EXTRACTED (first ShapeManager decomposition move). tsc clean, 232 service tests green (+6), build clean.**
- ✅ **`EphemeraOverlay`** (`src/services/ephemera/ephemera-overlay.ts`, +6 tests) — the SVG overlay render + placement hit-test/select/move/resize/rotate subsystem (~350 lines, 14 methods + 5 state fields). Takes `ManagerContext` (interactionService/webgpuRenderer/rasterLayerManager/scheduleRender) + a narrow `EphemeraOverlayHost { ephemera, markPackageVectorLayerDirty, meshEditFocusHidesContent }` (3 hooks). Method bodies moved VERBATIM behind getters/bridges (`get _ephemera`→host.ephemera, `_pkgVectorLayerDirty`→host hook, etc.); the only non-verbatim edit was `scene3d?.meshEditFocusHidesContent?.()`→`host.meshEditFocusHidesContent()`.
- **Facade KEEPS** (correctly — not ephemera-overlay's job): the pure `_ephemera` registry delegators (categories/generators/sheets/elements/placement-CRUD/export/import), the **shared `_activeVectorLayerId`** (2D shape layer-tagging uses it too — see §3.1), vector-layer CRUD, and the rasterize-to-layer glue (`rasterizeEphemeraLayer`/`stampEphemeraToLayer`). ShapeManager keeps thin delegators for every moved public method. Manager 14,225 → **13,951 lines**.
- Tests cover the pure geometry (hit-test topmost + rotation-aware, resize anchor-pinning, rotate delta, handle hit-test) with a fake ephemera + mock ctx; the canvas-2D render path (`_renderEphemeraOverlay`, `getDefaultPlacementSize`, `setEphemeraOverlayCanvas`) needs a real overlay canvas → **browser-verify: place ephemera on a vector layer, select/move/resize/rotate, layer visibility toggle, package vector-layer composite refresh.**
- **Next in queue:** #2 Decals → #3 LiveText → #4 2D shape `fromJSON` (+ reconcile the two create entry points, host-usage check first).

**2026-08-17 — §4 #2 Decals: coupling audit + shared-helper prep (NOT a clean independent — spec label corrected).**
- ⚠️ **Decals is more coupled than §4 labeled it.** Three findings: (1) `_resolveDecalBitmap` is **shared with GARP** (registerGarpPool3D/addGarpSkin3D + demo seeders) and Mode-B baking — not decal-private. (2) **Mode B** (`stampDecalAtUV3D`/`_ensureDecalTexture`/`_stampImageIntoTexture`) writes the **shared `_uvPaintTextures`** map → it's UV-paint-coupled and should move WITH the UVPaintSessionManager phase, not now. (3) **Mode A** (floating quads + the interactive place-tool) is genuinely independent BUT **non-contiguous** in the file (5304–5507 + 6065–6095, GARP+ModeB interleaved) and its tool is **browser-gated** (canvas pointer listeners + scene3d pick).
- ✅ **Prep done:** `_resolveDecalBitmap` → free function `resolveDecalBitmap(source, ephemera)` in `src/services/managers/decal-source.ts`; the facade method is now a 1-line bridge (all callers — Mode A, Mode B, GARP — unchanged). tsc clean. This unblocks a future `DecalManager` (Mode A) without dragging GARP along.
- **Revised plan:** Mode A → its own `DecalManager` (ctx + `{scene3d, ephemera}` host), extracted + **browser-verified** as a focused move (the tool can't be unit-tested). Mode B → deferred to the UVPaintSessionManager phase. **Recommend doing #3 LiveText before Decals-Mode-A** (likely a cleaner contiguous independent).

**2026-08-17 — §4 #3 LiveText EXTRACTED. tsc clean, 237 service tests green (+5), build clean.**
- ✅ **`LiveTextManager`** (`src/services/managers/live-text-manager.ts`, +5 tests) — LiveTextNode create/style/edit/flatten + the edit-session state (`_editingLiveTextId`). ~305-line contiguous block, 12 methods, moved VERBATIM behind getters/bridges. Takes `ManagerContext` + a **2-hook** `LiveTextHost { getActiveVectorLayerId, getTextEffectEngine }` (the shared active-vector-layer + the facade-owned TextEffectEngine).
- **Facade KEEPS:** the `TextEffectEngine` (`getTextEffectEngine`) + `applyTextEffect`/`applyTextEffectChain` + the custom-WGSL-shader methods (they call the shared engine + now `getLiveTextNode` instead of the moved private `findLiveTextNode`). Rewired the two external `_editingLiveTextId` readers (`isInputActive`, `getEditingLiveTextId`) to the subsystem's `editingLiveTextId` accessor. Manager 13,951 → **13,689 lines**.
- Tests cover the CPU-safe surface (scene-graph traversal + missing-node null-guards + rect-draw-callback wiring) with a real empty SceneGraph; the DOM/HTML-in-Canvas + GPU flatten paths are **browser-verify** (create/edit/style/flatten a LiveText node).
- **Queue status:** #1 Ephemera ✅, #2 Decals (resolveDecalBitmap decoupled ✅; Mode A + tool deferred to a browser-verified session; Mode B → UVPaint phase), #3 LiveText ✅. **Next: #4 2D shape `fromJSON`** (lift the `recreateNode` switch; + reconcile the two create entry points, host-usage check first).

**2026-08-17 — §4 #4 2D shape deserialization EXTRACTED. tsc clean, 243 service tests green (+6), build clean.**
- ✅ **`recreate2DShape(data, deps)`** (`src/services/shape-serializer.ts`, +6 tests) — the 16 2D-leaf cases (Rectangle … Panel Layout, ~242 lines) lifted OUT of `ShapeManager.recreateNode`'s switch, VERBATIM (`this.*`→`deps.*`). Returns `null` for non-2D-leaf types (Group / 3D / unknown), which `recreateNode` still handles (they recurse + couple to scene3d) along with the common post-processing (id / transform / children). Deps bag `Shape2DRestoreDeps` (shapeFactory + the 4 drawing services + TextEffectEngine + renderer + interaction) assembled by `_shape2DRestoreDeps()`.
- **Honest note:** this is *relocation*, not decoupling — the deps bag is wide (8 collaborators) because 2D restore is genuinely coupled to the drawing services (Pattern/Stamp/SDFText atlases, LiveText engine+DOM). But it removes ~240 lines from the god-object, makes the dispatch unit-testable, and restores toJSON↔fromJSON symmetry. Manager 13,689 → ~13,461 lines.
- Tests pin the pure dispatch (arg routing for Rectangle/Circle/Line/Scribble/StickyNote + the null fall-through for Group/3D/unknown) with a mock deps bag; the atlas/engine/DOM cases (Pattern/Stamp/SDFText/LiveText) are **browser-verify** (open a doc containing each 2D shape type → restores correctly).
- **NOT done (separate):** the "reconcile the two create entry points" half of §3.1 (2D-a) — still needs the Frogmarks-usage check before touching it.
- **§4 independents complete:** #1 Ephemera ✅, #2 Decals (partial — see above), #3 LiveText ✅, #4 2D fromJSON ✅. **Remaining queue = the coupled tail:** UVPaintSessionManager → Packaging composite → FrameClock → DocumentStateCoordinator, + Decals Mode A/B.

**2026-08-17 — §4 #2 Decals MODE A EXTRACTED (independent half closed). tsc clean, 249 service tests green (+6), build clean.**
- ✅ **`DecalManager`** (`src/services/managers/decal-manager.ts`, +6 tests) — Mode A: floating-quad decals + the interactive place-tool + restore-from-markers (~225 lines across two non-contiguous blocks, moved VERBATIM behind getters/bridges). Takes `ManagerContext` + a 2-field host `{ scene3d, ephemera }`.
- **Facade KEEPS (correctly):** Mode B (`stampDecalAtUV3D`/`_ensureDecalTexture`/`_stampImageIntoTexture` — UV-paint-coupled, rides with the UVPaint phase), `cityMetresPerUnit` (city helper, uses `this.world`), and the shared `_resolveDecalBitmap` bridge (GARP + Mode B). Thin delegators for every moved public method. Manager ~13,461 → ~13,262 lines.
- Tests pin the CPU-safe surface (empty-state accessors, missing-id guards, tool-inactive no-ops, placeDecal3D registration with a real Mesh3D); the scene3d-pick + GPU-texture + canvas-pointer-tool paths are **browser-verify** (enter decal tool, hover ghost across surfaces, click-place, resize/rotate/remove, save+reload).
- **§4 INDEPENDENTS ALL DONE:** #1 Ephemera ✅, #2 Decals Mode A ✅ (Mode B deferred), #3 LiveText ✅, #4 2D fromJSON ✅. **Remaining = the coupled tail:** UVPaintSessionManager (next; unblocks Decals Mode B + Packaging) → Packaging composite → FrameClock → DocumentStateCoordinator.

**2026-08-17 — Coupled-tail progress: ephemera bugfix + UVPaint Step 2 + PackagingComposite. tsc clean, 479 services+packaging tests green.**
- 🐛 **Ephemera "Place on Canvas" lag FIXED** (pre-existing, not from the extraction): `addEphemeraPlacement`/`update`/`delete` mutated the registry but never `scheduleRender()`, so the overlay (a post-frame callback) waited for the next mouse-move. Added the schedule to all three.
- ✅ **UVPaint Step 2 (packaging dep INVERTED)** — browser-verified. `_armPackagingSurfacePaint` takes caller-supplied `readbackTexMgr`/`onBeforeStroke`/`onStrokeMove`/`onStrokeEnd`; the packaging host adapter supplies them. Banks the architectural win the spec wanted (Packaging's extraction reuses this seam). **Step 3 (full UVPaintSessionManager class move) DEFERRED** — re-scoped as a wide (~15-passthrough) browser-gated relocation for value already banked; see `uv-paint-session-extraction.md` execution note. Pivoted to Packaging instead.
- ✅ **`PackagingComposite`** (`src/packaging/packaging-composite.ts`, +4 tests) — the box-panel layer-stack compositor + vector proxies (~180 lines: `_pkgComposites`/`_pkgVectorProxies`/`_pkgCompositor` + 8 `_pkg*` methods) lifted VERBATIM out of the facade behind getters/bridges. Takes `ManagerContext` + a 2-field host `{ liveTexture, ephemera }` (no mutual-reference, no packaging-manager dep — cohesive). Clean public API (`link`/`unlink`/`recomposite`/`refreshVectorProxies`/`vectorLayerDirty`/`recompositeThrottled`/`hasComposite`/`getCompositeMgr`/`getComposite`/`getVectorProxy`/`dropVectorProxy`) = the seam the PackagingHost adapter + UV-paint packaging session + ephemera add/update/delete call. Manager ~13,262 → ~13,100 lines.
- Tests pin the CPU-safe surface (empty accessors, no-device link guard, unknown-id no-ops); GPU compositing (RasterCompositor passes + vector-proxy SVG raster + live-texture linking) is **browser-verify** (package box shows the stack composite; vector/ephemera layers composite onto the box; paint recomposites live; exportPng).

**2026-08-17 — Decals Mode B EXTRACTED → #2 COMPLETE. tsc clean, 250 service tests green (+1), build clean.**
- ✅ **Decals Mode B** (`_ensureDecalTexture` / `_stampImageIntoTexture` / `stampDecalAtUV3D` / `stampDecalAtScreen3D`, ~73 lines) moved into `DecalManager` VERBATIM. The one new dep — the SHARED `_uvPaintTextures` map (facade-owned; UV-paint + procedural restore also write it) — is passed by reference as a host field `uvPaintTextures`. `screenToMeshUV3D` came free (DecalManager already had `scene3d`). Facade keeps the 2 public delegators + the shared `_resolveDecalBitmap` bridge (GARP still uses it).
- **DecalManager now owns BOTH modes** (A: floating quads + tool; B: stamp-into-texture). Manager ~13,100 → ~13,039 lines. Tests: +1 (Mode B stamp resolves false when mesh/device/UV missing). GPU texture-stamp path is **browser-verify** (stamp a decal onto a mesh via the UV pane + via a 3D click; decals stack on existing paint).
- **§4 STATUS: all independents ✅ + Decals A&B ✅ + Packaging dep-inversion ✅ + PackagingComposite ✅.** Remaining: FrameClock (shared RAF DRY), DocumentStateCoordinator (persistence orchestrator, LAST), + optional UVPaint Step 3 (deferred).

**2026-08-17 — FrameClock investigated → NOT a clean DRY (recommend SKIP).** The spec (§5.2) called the two RAF loops "near-identical"; they aren't:
- **`AnimationPlayer3D`** (`src/renderer/3d/animation-player-3d.ts`, 148 lines) — accumulator catch-up (multi-frame/tick), loop|stop. It's ALREADY a clean, reusable clock: instantiated 3 ways (main `_animPlayer`, per-track `_nlaPlayers`, skeleton clips). The "FrameClock" essentially already exists on the 3D side.
- **`AnimationTimeline.tick`** (`src/animation/animation-timeline.ts`) — single-frame-modulo (≤1 frame/tick), richer loop modes (**ping-pong**), deep event integration (frame-changed / playback-state-changed) + rich 2D state (cels/layers/playRange).
- The two tick bodies are ~10 lines each and **semantically different**. Unifying onto one clock class would force a **behavioral change to 2D cel playback** (single-frame → accumulator catch-up) for marginal de-dup. The real "drift" concern (synced 2D+3D) is an *architectural* question (should 3D follow the timeline's `frame-changed`, or run its own synced RAF? — both mechanisms exist: `attachKeyframesToTimeline3D` vs `startSyncedPlayback`→`_animPlayer.play()`), NOT a code-DRY one; a shared clock class doesn't fix it by itself.
- **Verdict: skip.** Low value, browser-gated behavioral risk. Same pattern as the deferred UVPaint Step 3 — a spec-assumed "win" that inspection downgrades.

**Campaign state:** god-object ~15,267 → ~13,039 (~15%); ALL clean independents + Decals(A+B) + Packaging(inversion+composite) extracted with tested owners. Remaining tail = **DocumentStateCoordinator** (persistence orchestrator, restore-critical, high-care) + the two deferred low-value items (UVPaint Step 3, FrameClock). Decomposition is at diminishing returns; the domain-manager structure the **SceneAuthoringAPI** wanted now exists.
