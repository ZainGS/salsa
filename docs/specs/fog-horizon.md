# Fog horizon — silhouette skyline + fog-bounded detail

**Date:** 2026-10-01 · **Status:** P1 BUILT + browser-verified · P2 BUILT + browser-verified · fog-eye refactor BUILT ·
follow-ups BUILT + browser-verified (no-fog objects, AO fade, characters, crowd stamping, CPU: §0
"Follow-ups") · P3 / P4 not built (decision brief: §6) — **status 2026-10-04: P3 BUILT as HLOD (performance-plan §P17,
default on); P4 PARTLY built (HLOD / P19 tier dissolves only; per-object twin / crowd / tree swaps still pop); see
[../STATUS-2026-10-04.md](../STATUS-2026-10-04.md)** · **Builds on:** Hard fog edge (docs/ui/city-quality.md), distance LOD (docs/ui/performance.md
"How LOD works"), tiled streaming (StreamManager), P7/P8/P9 in performance-plan.md. User notes: docs/ui/city-quality.md
"Fog horizon".

## 0. As built (2026-10-01)

Everything defaults off. With Hard edge off (or the fog not linear) every new path is inert, and with Hard edge on but
the new settings at their defaults the only change is the silhouette fast path, which is pixel-identical.

### API and persistence
- `sm.setFogHorizon3D(patch)` → the merged settings (`{ reset: true }` = the defaults first); `sm.getFogHorizon3D()`.
  ShapeManager forwards straight to `Renderer3D.setFogHorizon` / `.fogHorizon` (the owner; no scene3d-manager hop).
- Fields (defaults): `buildingsOnly` (false), `includeAttachments` (false), `fadeM` (15 m, clamped 0..500, 0 = pop),
  `fadeStyle` ('dither' | 'dither-coarse'), `silhouetteOutlines` (true). Types / sanitize / diff:
  `src/renderer/3d/fog-horizon.ts`.
- Active only while `fogHardEdge` is on and `fog.mode === 'linear'` (`Renderer3D.fogHorizonActive`). Re-evaluated every
  frame, so a fog Far change, a mode change or a camera-mode change applies on the next frame with no regen.
- Saved in the document's global scene settings as `fogHorizon` with ONLY the non-default fields (`fogHorizonDiff`), so
  older saves stay byte-identical. `resetGlobalScene3DSettingsForLoad` pins `fogHorizon: {}` (= defaults) like
  `fogHardEdge: false`; restore = `setFogHorizon({ ...saved, reset: true })`.
- The fade band is in metres; the city tells the renderer its scale (`Renderer3D.fogHorizonUnitsPerMetre`, set in the
  WorldManager LOD pre-render callback; 1 without a city).

### The fog eye (all view modes)
The fog used to be measured as `length(cameraPosition - worldPos)`. In ortho the camera position is an arbitrary dolly
(the 2D ortho camera sits 10 units in front of the artboard; a free-3D ortho orbit at its radius), so ortho fog was
wrong. Now every fog distance is measured from a **fog eye** (`computeFogEye`, fog-horizon.ts):
- **Perspective** (free 3D, City, Play, 2D perspective): the camera position, copied float for float, so perspective
  fog is bit-identical to before.
- **Orthographic** (2D ortho, a free-3D ortho projection): the equivalent-perspective eye
  `target - forward × orthoSize / tan(fovY / 2)`. The illustration camera sync (scene3d-armature
  `_applyIllustrationCamera`) puts the 2D PERSPECTIVE camera at exactly that point for the same pan / zoom, so 2D ortho
  and 2D perspective now fog the same objects (verified: same 4 of 8 receding boxes fogged in both; before, ortho
  measured from z = 10 instead of z = 2.41). With the default 45° fov this is also the distance the ortho distance LOD
  uses (`orthoLodDistance = orthoSize / tan(22.5°)`).
- Note: the 2D modes are a front view of the artboard (the illustration sync), not the free-3D pose; the eye above
  matches what the 2D perspective view shows for that framing.
- Packed as `fogEye` (scene floats 268-270, .w = the fade band width in world units; buffer 1072 → 1088 bytes,
  guarded write `data.length >= 272`, default = the camera position). Used by: both mesh fragment templates (textured
  and untextured / vertex-colour; the skinned path reuses them), the legacy shadow-receive FS in shadow-shaders.ts,
  the height fog and aerial haze (they share `fogDist`), the silhouette fast path, the fade band, the outline cut and
  the CPU fog cull. The planar-mirror pass mirrors it like the camera.
- Every `SceneUniforms` copy that reads it declares the full layout; a new test (wgsl-static-check) checks EVERY copy's
  field offsets against packSceneUniforms.

### P1 — fog-bounded culling + silhouette fast path (BUILT)
- **Classes** (`Mesh3D.fogClass`, 0 / 1 / 2): each draw tier of `WorldManager.cityDistanceTiers` carries a sixth element,
  its class ('building' | 'attachment' | 'other'; `distanceTierFogClass`), padded by `WorldManager._fogTier` so the
  stamped distances are unchanged (tested). Untiered layers are classed by name in `WorldManager.FOG_EXTRA_CLASSES`.
  `assignDrawDistances(roots, tiers, WorldManager.fogClassify())` stamps the class in the same tree walk (also with
  distance LOD off, and on every streamed tile at attach).
  - building (kept): bodies, roofs, roof decks, walls, parapets, storefronts, shutters, landmarks, roads, ground,
    paving (the flat-map family: ground must stay continuous), water, the rail viaduct, bridges, sky meshes.
  - attachment (kept only with `includeAttachments`): facade detail (window trim, sills, juliet balconies, balconies,
    awnings, greenery, noren), roof objects + roof equipment, sign lettering, name plates (`textsign-`), and the
    untiered lit signs, lightboxes, screens, frosted balcony panels, stall awnings, station signs.
  - other (culled): cans, crowd, rail sleepers, tiny clutter, small props, poles, road / warning signs (split out of
    the name-plate tier with the same distance: new LOD family `roadSigns`), trees, parked cars, vending, other props,
    contact blobs, and the untiered lamps / lamp pools / lanterns, traffic movers, stalls, crates, bins, vents, posters.
- **CPU cull** (renderer draw-list build): with `buildingsOnly`, a class-2 (and, unless attachments are included,
  class-1) mesh or instanced group stops drawing in every pass, its shadow included, once its whole box is past the fog
  edge × 1.01 measured from the fog eye. TRUE distance (no lens / aerial bias / resolution scaling): the fog line is a
  real distance, so this is the "effective draw distance min(own, Far + margin)". Placed after the near/far twin update
  (pairs keep their hysteresis), also in the hierarchical-cull static-shadow path. Off while a planar mirror is live
  (the mirror sees what the eye's fog hides). Building shells past Far stay casters. Counters `fogHidden` /
  `fogTrisHidden` in `getFrameStats3D()`. A/B: `Renderer3D.fogHorizonCpuCull = false`.
- **GPU fast path**: `scene.toonParams.w` (float 215, verified unread before) carries the fog-horizon flag bits
  (fog-horizon.ts `FOG_HORIZON_*`; bit 0 = fast path, set whenever Hard edge + linear fog). In both mesh fragment
  templates a fragment whose fog-eye distance is ≥ `near + max(far - near, 0.001)` (exactly where the linear factor
  clamps to 1; height fog and aerial haze are off under Hard edge) skips the window-interior shading in the pattern
  block and returns right after the texture samples and the alpha cutout / leaf-card cut, before lighting, shadows,
  ground shading and IBL, with the same alpha, the same alpha discard and the same PS1 quantization as the slow path's
  tail. WGSL uniformity: every implicit-derivative sample / fwidth / dpdx runs before the return (shadow taps are
  CompareLevel). Unlit UI cards (style 6) take no fog in the textured FS, so never this path. A/B:
  `Renderer3D.fogHorizonFastPath = false`.
  - **Pixel-identical** (A/B screenshots with the world clock frozen, Far 60 m, diorama): rooftop / low / sky poses
    0 differing pixels; street 398 px vs a 260 px noise floor (two identical frames), all on the one live pedestrian.
- **Silhouette outlines off**: the outline Sobel pass gets the inverse view-projection + the fog eye + the edge in its
  params (buffer 32 → 112 bytes) and reconstructs each pixel's world position from the pre-pass depth: no ink at or past
  the fog edge. `fogCut.w = 0` = off (the original pass). Verified: ink on the silhouettes with it on, none with it off,
  the clear zone keeps its outlines.

### P2 — dither fade band (BUILT)
- **coverage = smoothstep(edge, edge − fade, d)** (written out: WGSL smoothstep wants low < high), d = fog-eye distance.
  A pixel draws while coverage beats its 4×4 Bayer threshold `(bayer + 0.5) / 16`; 'dither-coarse' uses the same pattern
  in 2×2-pixel cells (an 8×8-pixel tile). Helpers `FOG_FADE_WGSL` (mesh3d-shaders.ts: fhCoverage / fhDitherKeep /
  fhFades), spliced into:
  - both mesh fragment templates (the discard sits after the samples, before the fast-path return);
  - the shadow depth pass `fs_shadow` (the same coverage from the fog eye, dithered in shadow-map texels, so the
    PCF-filtered shadow fades with the caster);
  - the outline depth pre-pass, which writes the coverage into the normal target's alpha; the Sobel pass scales the ink
    by min(coverage of the pixel, of the neighbour that made the edge), so outlines fade instead of popping.
- Scene flag bits: 1 = band live (`buildingsOnly` and fade > 0), 2 = coarse, 3 = attachments kept. `fogEye.w` = band
  width in world units.
- **Which meshes fade: flags2** (below): bit 0 = class 2, bit 1 = class 1 (fades only while attachments are excluded).
- **CPU cull for faders** = the fog edge (+1 % for vertex sway), as P1: coverage is 0 there, so the cull is invisible.
- **Static shadow cache**: a fading caster whose box reaches into the band is treated as DYNAMIC (its coverage changes
  with the camera, and the cached static map is not re-rendered for a camera move); casters wholly inside the clear
  zone stay static.
- **Verified** (headless Chrome, RTX 2070 SUPER):
  - No pop: image with the CPU cull vs without it, at Far 50 / 80 / 110 m, from the rooftop: pop mode (fade 0) 566-815
    px change (the culled silhouettes vanish), dither and coarse 0 px. At street level the dither difference is at the
    noise floor of the moving pedestrian.
  - Walk / fly toward the fog line: frames in the agent scratchpad (pupdrive/fogh/twalk-vista-*.png,
    walk-street-*.png); roof equipment and props dissolve by distance, no frame where an object appears at once.
  - Shadows fade with their objects (rooftop at Far 80 m, band 25 m: the water tank, billboard and AC units dither and
    their roof shadows thin with them; pupdrive/fogh/zoom-shadow.png).
  - Off: with the feature off the frames match the P1 frames (0 px on the rooftop pose; the other poses only differ by
    moving traffic between sessions), and the fast-path A/B stays 0 px with the P2 code.
  - Cost: band on vs pop, buildingsOnly on, tiled Far 150 m: +0.04 ms main pass (paired median), +0.08-0.16 ms all passes.

### flags2 — the second per-object flags word (decided)
(Bits as of the follow-ups: 0 = distanceFade, 1 = distanceFadeAttach, 2 = noFog, 3 = noFogHardEdge; skinned parts
get bit 0 per frame from the skinned upload. The full table is in material-3d.ts.)
All 32 bits of `emissiveColor.a` are used, so per-object switches beyond them live in **`MeshInstance.normalMatrix`
column 3 .x** (instance float 28; WGSL `u32(inst.normalMatrix[3].x)`), documented in material-3d.ts (`FLAGS2_FLOAT`,
`FLAGS2_DISTANCE_FADE` = bit 0, `FLAGS2_DISTANCE_FADE_ATTACH` = bit 1, `encodeMeshFlags2`) as the place future flags go
(parallax eyes next).
- **Why it is free:** normalMatrix is the 4×4 inverse-transpose; every shader multiplies it by `vec4(n, 0.0)` and keeps
  `.xyz` (mesh3d / vertex-colour / skinned VS, the shadow-receive VS, the SSAO + outline pre-passes); the CD disc reads
  column 2 only. So column 3 is multiplied by 0 and never reaches a result. Row 3 (floats 3 / 7 / 11) only reaches the
  discarded `.w` and holds the inverse translation, so column 3 was the cleaner choice. It held 0 for every affine model
  matrix and billboards wrote 0, so 0 (non-faders) is the old value.
- **Integer-valued float, not a bitcast:** the lane is multiplied by 0, and a bitcast pattern can be NaN / Inf
  (0 × NaN = NaN would poison the normal). Values stay below 2^24.
- **Every writer:** `_writeGroundUvScale` (which every mesh slot writer calls after the matrices: the full writer incl.
  billboards, `_writeIncSlot`, `_writeIncSlotMatrices`, the transforms fast path, material-only rewrites, the skinned
  instance buffer) writes it first; array-group copies take their source's (`_packArrayGroupInstances`, after the
  per-instance normal matrix / override recompute). It derives from the mesh, so `assignDrawDistances` marks a mesh
  `materialDirty` (the cheap budgeted slot rewrite) when its class changes. No compute shader or CPU reader touches the
  lane (the material stamp compares floats 32+).
- **Guarded by a test:** wgsl-static-check fails if any shader multiplies normalMatrix by anything but `vec4(…, 0.0)` or
  reads column 3 other than `.x`.

### Measurements (P1, 2026-10-01)
Headless Chrome on the RTX 2070 SUPER, 1300 × 850, seed-3 city, time 0.62, traffic frozen, Hard edge on, fog colour
violet; paired A/B GPU timer (p8/abtime.js, 2 frames in flight, 7 rounds, idle GPU checked before each). Triangles =
main-pass visible triangles; GPU = main colour pass, buildingsOnly off / on, with Δ the paired median; "fast path" =
the silhouette fast path alone (on vs off, buildingsOnly off). CPU = wall time of one render call (median of 12).

| World | Far | Pose | Triangles off → on | Draw calls off → on | CPU ms off / on | GPU ms off / on | Δ GPU | Fast path Δ |
|---|---|---|---|---|---|---|---|---|
| tiled 3×3 | 150 m | street | 6.78 M → 2.23 M | 3844 → 1874 | 14.2 / 15.7 | 5.59 / 5.84 | −0.80 | −0.15 |
| tiled 3×3 | 150 m | rooftop | 6.56 M → 1.90 M | 4056 → 1837 | 15.6 / 13.5 | 9.58 / 7.34 | −2.18 | −2.79 |
| tiled 3×3 | 150 m | Play lens* | 7.93 M → 3.37 M | 4420 → 2405 | 14.8 / 13.7 | 5.49 / 5.43 | −0.80 | +0.01 |
| tiled 3×3 | 300 m | street | 6.75 M → 6.54 M | 3822 → 3396 | 15.0 / 15.4 | 5.80 / 6.06 | +0.04 | −0.02 |
| tiled 3×3 | 300 m | rooftop | 6.53 M → 6.21 M | 4039 → 3403 | 14.7 / 14.3 | 9.55 / 9.41 | −0.16 | −1.14 |
| tiled 3×3 | 300 m | Play lens* | 7.93 M → 7.75 M | 4420 → 4012 | 14.7 / 15.7 | 5.69 / 6.02 | +0.04 | −0.04 |
| streaming | 150 m | street | 8.08 M → 2.54 M | 4502 → 2128 | 16.7 / 14.9 | 7.21 / 5.77 | −1.07 | −0.34 |
| streaming | 150 m | rooftop | 9.42 M → 2.49 M | 6148 → 2644 | 15.9 / 14.8 | 11.11 / 8.15 | −2.96 | −3.36 |
| streaming | 150 m | Play lens* | 6.62 M → 2.74 M | 4556 → 2625 | 16.7 / 15.8 | 6.01 / 6.36 | −0.50 | −0.15 |
| streaming | 300 m | street | 8.05 M → 6.86 M | 4479 → 3650 | 16.6 / 15.8 | 6.70 / 6.70 | +0.00 | +0.01 |
| streaming | 300 m | rooftop | 9.21 M → 6.81 M | 6059 → 4210 | 17.2 / 17.9 | 11.09 / 10.36 | −0.72 | −1.44 |
| streaming | 300 m | Play lens* | 6.62 M → 6.05 M | 4556 → 3947 | 16.9 / 16.1 | 6.07 / 6.70 | +0.06 | −0.25 |

\* The Play camera emulated: a 72° lens (streaming: at the street eye; tiled: a 2 m eye that sat in an awning, so its
image is grey, but the counts are valid). Streaming = streamFollow on, 36 tiles live, 9 full.
- At Far 150 m the triangles drop 55-75 % and the draw calls ~50 %; the GPU gains are 0.5-1 ms at street level and
  2-3 ms from a rooftop (fogged screen area). At 300 m little of the city is past Far.
- The fast path alone is worth up to 3.4 ms when much of the screen is fog (rooftop), ~0 at street level.
- CPU: unchanged within noise. This scene is CPU-bound (~15 ms) by the per-mesh draw-list walk, which still visits the
  culled meshes (it is where they are culled) — fewer draws do not shorten it. A per-cluster fog reject in the P9
  hierarchical cull would (open item). Addressed in the follow-ups (§0 Follow-ups, item 4: −2.6 to −3.9 ms with the
  feature on; the gain came mostly from the geometry-pool walk, not the cull itself).
- Screenshots: pupdrive/fogh/sky-vista-*.png (skyline: off / buildings only / + attachments / + fade),
  vista-skyline.png (the skyline strip), cmp-outline.png (silhouette outlines on / off), zoom-dither.png (4×4 / coarse
  dither on rooftop equipment).

### Follow-ups (2026-10-01, round 2) — BUILT + browser-verified
Drivers and frames: agent scratchpad pupdrive/fogh2/ (verify.js, scene.js, live.js, cpu.js, prof.js, p3est.js).

**1. Per-object no fog (`Material3D.noFog`, the clouds).**
- Before: under Hard edge the sky meshes past Far took the fog like any mesh, so the painted clouds were fog-coloured
  blobs. After: they stay clouds (pupdrive/fogh2/clouds-hard-fogged.png vs clouds-hard-nofog.png).
- `Material3D.noFog?: boolean | 'hardEdge'` is carried in flags2. `FLAGS2_NO_FOG` (bit 2) means always.
  `FLAGS2_NO_FOG_HARD_EDGE` (bit 3) applies only while the new scene flag `FOG_HORIZON_HARD` (toonParams.w bit 4) says
  Hard edge is on, in any fog mode. `encodeMeshFlags2` never gives a no-fog mesh the fade bits. The value is read per
  mesh (`mesh.material`).
- Every fog path skips it:
  - **Both mesh fragment templates** (`fhNoFog` in FOG_FADE_WGSL). The linear / exp fog, the height fog and both aerial
    hazes sit inside the one skipped block, and the silhouette fast path (`fhSkip`) is off for these meshes. The skinned
    path reuses these templates.
  - **The legacy textured shadow-receive FS** also skips it. The untextured one has no instance access. Both are dead
    code: pipeline-3d uses the _MODERN variants.
  - **The fade band** (no fade bits).
  - **The fog-horizon CPU cull** (`!material.noFog`): the mesh loop, the cluster reject, the static-shadow path, array
    groups, and the static/dynamic caster split.
  - **The silhouette outline cut.** A new scene flag `FOG_HORIZON_OUTLINE_CUT` (bit 5) is set under the same condition
    the renderer sets `fogCut` under. While it is set:
    - the outline pre-pass writes alpha exactly 1 for a no-fog mesh and caps every other mesh at 254/255;
    - the Sobel pass skips the cut on alpha-1 pixels and rescales the rest by 255/254, so ink coverage is unchanged.
- **City default.** These layers get `noFog: 'hardEdge'`:
  - world:sky-clouds, world:sky-clouds-rim, world:sky-stars and world:sky-moon (sky.ts);
  - the drifting clouds world:traffic-cloud / -rim, both painted and legacy puffs (traffic.ts).

  This goes through a new `LayoutPreviewLayer.noFog`, which addFlatColorMeshGroup copies to the material.
- **Why 'hardEdge' and not always.** The horizon banks sit 2.6-3.1 R out, placed so the soft haze blends them ("near
  enough that the haze leaves them contrast"). Always-no-fog would change the default look. Verified: under soft fog,
  'hardEdge' clouds vs fogged clouds = 0 px. Airplanes are objects, not sky, so they keep the fog.
- **API:** `sm.setMeshNoFog3D(meshId, false | true | 'hardEdge')` / `sm.getMeshNoFog3D(meshId)`. It is material-only
  (applyMaterialPatch) and persists with the material, which Mesh3D.toJSON saves whole. Frogmarks: material panel
  "No fog".

**2. AO fades with the object.**
- Before: the SSAO / SSR world-position pre-pass drew a dissolving object whole, so it kept darkening the AO behind it
  inside the band.
- After: the pre-pass and the SSR depth-peel pre-pass discard the same pixels (`PREPASS_FOG_FADE_WGSL` in
  ssao-shaders.ts: coverage from the fog eye, the same Bayer pattern).
- **Half resolution.** The pre-pass runs at half resolution, so the pattern is indexed by the colour pass's pixel. That
  pixel is re-projected from the fragment's world position with `scene.resolution`, in cells of one pre-pass texel
  (`round(dpdx)`):
  - at full res it matches pixel for pixel;
  - at half res each texel stands for its 2×2 pixels. The coarse style then matches exactly, and the fine style keeps
    its coverage per texel.
- Both pre-pass shaders now declare the full SceneUniforms layout (checked by wgsl-static-check).
- **Verified** on a controlled scene with props in the band, in the AO debug view (pupdrive/fogh2/sc-ao-crops.png).
  Class 0 props keep solid AO. Class 2 props get dotted AO that follows the dissolving boxes (colour pass below).

**3. Characters.**
- Before: skinned characters (generated characters, NPCs, the player) were never fog-culled or faded. They are not
  stamped, and `_cullSkinned` had no fog test.
- After, with "Buildings only in fog":
  - A part whose whole box is past the fog edge × 1.01 is dropped from every pass (`flags = 0`). It is counted in
    `skinnedCulled` and the new `skinnedFogHidden`. Its idle keeps running within a margin of half the part's size.
  - While the fade band is live, every part carries the flags2 fade bit (set per frame in `_uploadSkinnedInstances`).
    So it dissolves in the colour pass and in the skinned shadow pass. The shadow pass uses a new depth-only FS,
    `fs_skshadow`, with the same dither; it discards nothing otherwise, so the depth is the old one.
  - Never culled or faded:
    - the active Play player (`Renderer3D.fogCullExempt`, set by scene3d-manager on Play enter: `_isPlayerPart`);
    - the selection (`_selectedMeshIds`, the selected group target, or a selected ancestor);
    - no-fog parts.
  - A/B: `Renderer3D.skinnedFogHorizon = false`.
- **Verified** with 4 characters at 12 / 26 / 32 / 46 m, Far 30 m, band 14 m (pupdrive/fogh2/sc-chars-*.png):
  - feature off: 28/28 parts drawn;
  - on: 14 drawn, 14 fog-hidden, and the 26 m character dissolves;
  - selecting the far character brings it back (21 drawn);
  - a close-up shows a band character dissolving with its shadow (sc-chars-zoom-pair.png).
- Rigid city meshes keep their behaviour: a selected city prop past Far is still culled, and its flags2 would dissolve
  it anyway.

**3b. The city crowd (the "always rendered" question).**
- **Static crowd** (pedestrians.ts + mannequins, `world:ped-*`). It is merged per colour × twin tier and chunked in
  ~110 m cells in the centre city. It was already, and still is:
  - distance-LOD'd (crowd tier, 411 m, no aerial bias);
  - split into near/mid/far twins (30 / 100 m);
  - fog class 2.
- **Streamed tiles** are stamped on attach, but each tile's crowd layers are one mesh (not chunked). So the LOD, twin and
  fog decisions are made per tile. That is coarse granularity, not always-drawn.
- **Moving walkers** (traffic.ts, one group per walker) were already, and still are, tiered (crowd tier) and fog class 2.
- **Always drawn, fixed:**
  - **The live near-field crowd** (world-live-crowd.ts: up to 48 people within ~30-38 m, promoted to rigged live meshes).
    - Before: its meshes were never stamped (not in `WorldManager._groups`). They had drawDistance 0 and **fog class 0
      (building)**, so they were never distance-culled, fog-culled or faded.
    - Now each live mesh copies its source layer's drawDistance, bias, shadow feature size and fog class, and
      re-derives flags2.
    - Verified (pupdrive/fogh2/live.js): 305 live meshes, fog class 2, drawDistance = the crowd distance. With Far 8 m,
      297 of them are fog-hidden.
  - **The walkers' chat bubbles** (`world:traffic-emote`). They were untiered, so they drew at any distance while shown
    (they were already fog class 2). They are now in the crowd draw tier.
- **CPU.** The walkers' route sim still runs for every walker, by design. The pose gate now also drops to every 8th frame
  for a mover whose every mesh is fog-culled (`Mesh3D.fogHidden`, a new renderer-owned flag), as it already did for
  hidden and off-screen movers.
  - This does not apply to distance-LOD-hidden movers. They reappear at full opacity, so a stale pose would jump.
  - A fog-culled mover comes back through coverage 0, so its stale pose is never seen.

**4. CPU.**
- **Cluster-level fog reject** (P9; cull-clusters.ts `CullCluster.fogPast`, Renderer3D `hcFog`):
  - Each frame, each cluster tests its union box against the fog edge × 1.01, alongside the view verdict.
  - A member is dropped in a few reads, from the main and shadow lists alike, when it is of a culled class (`fogClass` 2,
    or 1 without attachments), is not no-fog, and still has its build-time box.
  - Building and no-fog members of the same cluster are processed normally.
  - A/B: `Renderer3D.hcFogReject = false`.
- **The fog test now runs before the distance-LOD / twin updates** in the per-mesh path.
  - A fog-culled mesh holds its hysteresis state (lodHidden, the twin choice) while it is past the fog, and picks it up
    when it comes back. Both twins of a pair share one box and class, so they stay in step.
  - This is what makes the cluster reject exact (it skips the same updates). Fog-culled meshes also skip the LOD work in
    the per-mesh path.
- **Identical lists, tested.** cull-clusters-fog.test.ts runs the real `_buildDrawLists` (mock GPU device) over a
  123-frame camera path through and out of the fog, with distance LOD and twins. It asserts that, with the reject on and
  off, these are identical:
  - the opaque, transparent, shadow, static / dynamic shadow and cascade lists;
  - every mesh's lodHidden / twin / fogHidden state.

  It also checks that the test fails when the reject is deliberately made wrong.
- **Other per-mesh work: the geometry-pool walk.**
  - `_ensureGeomPool` walked all ~13 k meshes every frame to find new or dirty geometry (geometry getter + id + Map
    lookup), ~1.5 ms in the tiled city.
  - It now skips a resident, clean mesh whose P9 slot cache is current, and fills that cache itself (the hierarchical
    cull skips the draw-list refresh for off-view meshes).
  - Same result by construction, and it helps with the feature off too. A/B: `Renderer3D.geomPoolFastSkip = false`.
- **Measured** in headless Chrome, 1300 × 850, RTX 2070 SUPER, Far 150 m, Hard edge, traffic frozen. Each value is the
  median of 60 render() calls per mode, over 6 interleaved rounds. The GPU sat at ~37 % from other load, so wall times
  carry some noise.

  | World | Pose | Mode | CPU ms (render) | msTotal | msCull | Draw calls | Fog-hidden / by cluster |
  |---|---|---|---|---|---|---|---|
  | tiled 3×3 | street | feature off, before | 14.7 | 9.9 | 3.2 | 3846 | – |
  | tiled 3×3 | street | feature off, after | 13.5 | 8.6 | 3.4 | 3846 | – |
  | tiled 3×3 | street | buildingsOnly, before | 13.9 | 8.9 | 3.4 | 1874 | 5364 / 0 |
  | tiled 3×3 | street | buildingsOnly, after | **12.1** | 7.4 | 3.4 | 1874 | 5364 / 1896 |
  | tiled 3×3 | rooftop | feature off, before | 14.5 | 9.7 | 3.4 | 4058 | – |
  | tiled 3×3 | rooftop | buildingsOnly, before | 13.0 | 8.3 | 3.1 | 1837 | 5791 / 0 |
  | tiled 3×3 | rooftop | buildingsOnly, after | **11.9** | 7.1 | 3.3 | 1837 | 5791 / 1948 |
  | streaming | street | feature off, before | 16.3 | 10.7 | 3.6 | 5245 | – |
  | streaming | street | buildingsOnly, before | 14.9 | 9.4 | 3.6 | 2869 | 6528 / 0 |
  | streaming | street | buildingsOnly, after | **13.3** | 7.9 | 3.6 | 2869 | 6528 / 4191 |
  | streaming | rooftop | feature off, before | 17.4 | 11.8 | 3.9 | 6150 | – |
  | streaming | rooftop | buildingsOnly, before | 14.9 | 9.7 | 3.5 | 2644 | 8231 / 0 |
  | streaming | rooftop | buildingsOnly, after | **13.5** | 8.0 | 3.5 | 2644 | 8231 / 5742 |

  - "Before" means `hcFogReject` and `geomPoolFastSkip` off, i.e. the P1/P2 CPU path. The fog-first reorder and the pose
    gate cannot be switched off, so they are in both columns.
  - Feature on (after) vs feature off (before): −2.6 ms (tiled), −3.0 / −3.9 ms (streaming street / rooftop).
  - Of the after-vs-before gain at the same setting, ~1.2-1.5 ms is the geometry-pool walk. The cluster reject itself is
    inside msCull's noise: a fog-culled mesh's per-mesh test was already cheap (a cached box and one distance).
  - msCull (~3.4 ms) is now split about evenly between the 13 k-mesh loop and the 3.9 k array groups, which are not
    clustered.
  - The rest of the frame is per-object bookkeeping that does not depend on the fog: the instance upload scan and the 2D
    strategy's walk over the 3D nodes, ~2 ms (see Open).

### Open
- Array groups (3.9 k in the tiled city, half of msCull) are not in the P9 clusters, so their fog test stays per group.
- Some per-frame walks are unrelated to the fog, ~2 ms together in the tiled city:
  - `uploadMeshInstances` / `_fastPathInstances` scan every mesh (dirty flags, one Map lookup per mesh);
  - the 2D render strategy's `beginFrame` / `collectActiveCarets` walk all 13 k 3D nodes.

  They are candidates for a version-counter early out.
- Streamed tiles' crowd layers are one mesh per tile (unchunked), so their LOD / fog decisions are per tile.
- The prepass dither indexes the canvas pixel from `scene.resolution` (the canvas size). At a render scale below 1 the AO
  pattern no longer lines up pixel for pixel with the colour pass, though the coverage still matches.
- A selected rigid city mesh past Far is still culled (only characters are exempt).
- P3 (silhouette-only tiles past the streaming ring) and P4 (dither cross-fades for all LOD swaps) are not built. §6 has
  the brief. **(Status 2026-10-04: P3 is BUILT as HLOD — performance-plan §P17, see the P3 status in §6; P4 is partly
  built: the HLOD tier swaps and the P19 old-tier dissolves dither (flags2 bit 5), the per-object swaps — P9 prop twins,
  crowd tiers, trees, vending cut-off — still pop.)**

---

*The original plan follows (kept for the reasoning; §0 above is what was built and supersedes it where they differ —
notably ortho / 2D views are now supported through the fog eye, and signs / awnings / rooftop equipment are a toggle).*

## 1. The idea

With **Hard edge** fog, everything past **Far** becomes one flat colour. Seen against the sky backdrop, distant
buildings read as a stylised silhouette skyline. Far = Near, so this is a hard line, not a haze. That gives three bands, measured from the camera:

| Band | Distance | What draws |
|---|---|---|
| Clear | `d < Far − fade` | everything, full detail (today) |
| Fade band | `Far − fade ≤ d < Far` | non-building objects dissolve in / out |
| Fog | `d ≥ Far` | **buildings only**, as flat fog-colour silhouettes |

Inside the fog, a building's pixels are only ever the fog colour. So its textures, lighting, shadows, window
interiors and SSAO are wasted work, and small things (props, crowd, cars, trees) only add noisy silhouette
speckle. Draw only the building outlines there, as cheaply as possible.

## 2. Is it a good system? Yes, with three adjustments

1. **Buildings need no fade.** The fog line is applied per pixel, so a building crossing it is already part
   silhouette, part lit, with no pop. Only the families we *stop drawing* in the fog need the fade band.
2. **Fade with a dither, not real transparency.** True alpha blending on every distant object would:
   - need back-to-front sorting every frame;
   - lose depth writes, so silhouettes would show what's behind them;
   - break SSAO, ink outlines and SSR;
   - add overdraw.

   Making everything beyond the fog permanently transparent has the same problems at much larger scale.

   A **screen-door dither** gets the same "materialize" look while staying opaque: a per-pixel threshold
   pattern decides which pixels of the object draw. The pipeline, depth, outlines and shadows all keep working,
   and it costs one compare per pixel. Most modern games do their LOD fades this way. With FXAA, or as a
   deliberate Persona-style pattern, it reads well.
3. **One rule covers fade-in and fade-out.** Coverage is a function of distance:
   `coverage = smoothstep(Far, Far − fade, d)`. So walking toward an object fades it in and walking away
   fades it out, with no state, no hysteresis and no flicker. Past Far, coverage is 0 and the object is culled
   on the CPU, so it costs nothing.

Fade **per pixel** (pixel distance), not per object: the dissolve line then lines up exactly with the fog line,
and long objects (railings, wires, trains) dissolve along their length instead of all at once.

## 3. Settings (Global settings → Fog, under Hard edge)

- **Buildings only in fog** (checkbox, default off). Non-building families get a draw distance of `Far`, and
  buildings past Far take the silhouette fast path.
- **Fade distance** (metres, default ~15 m; 0 = hard pop at the fog line). The width of the fade band.
- **Fade style:** Dither (default) / Dither-coarse (bigger cells, stylised).
- **Silhouette outlines** (checkbox): whether ink outlines draw on fog silhouettes. Outlines are a post pass,
  so they would otherwise draw on silhouettes too. Could look cool, so keep it as a choice.

All are saved with the document's global settings, opt-in, so older documents load identically. The rules
apply only while Hard edge is on and the camera is perspective (free 3D / Play). Ortho measures fog from a
far-away camera position, so it is skipped there.

## 4. Phases

### P1 — Fog-bounded culling + silhouette fast path (the performance win)
- **CPU:** when *Buildings only in fog* is on, every non-building `cityDistanceTiers` family gets
  `drawDistance = min(own, Far)`.
  - This is applied as a live override, the same way the Performance-panel multipliers work, with no regen.
  - Zoom tiers and the per-family sliders still apply on top, using the min.
  - Building families are identified by tier/layer kind (to verify: facade, roof and building-shell layers count
    as buildings; signs on facades probably count as props).
- **GPU fast path:** at the top of the main fragment shaders, if hard edge is on and `dist ≥ Far`, write the fog
  colour and return.
  - This skips texturing, lighting, shadow sampling, windows and SSAO for every fogged pixel.
  - Per pixel, so it is pixel-identical to today's output (today these pixels already compute all that, then
    mix 100 % to fog).
  - Flags travel in the scene uniform. No material flag bit is needed: all 32 are used.
- **Shadows:** buildings just past Far can still cast into the clear zone, so they stay in the shadow pass
  (their shadow-box test already handles this). Non-building casters past Far drop out (they are culled).
- **Measure:** tiled 3×3 and streaming, street and Play, with Far at ~150 / 300 m. Expect large triangle and
  draw-call drops, since props, crowd, trees and cars are most of the triangles (P7 tables). Expect fragment
  savings proportional to the fogged screen area.

### P2 — Dither fade band
- A per-pixel dither discard for *fading* meshes, in the main pass **and** the shadow depth pass, so shadows
  fade with the object.
  - Uses a 4×4 Bayer pattern or a small blue-noise texture in screen space.
  - The shadow pass uses the same rule, measured from the camera, so the shadow dissolves with its caster.
- **Which meshes fade:** the non-building families. This needs a per-mesh "fades" value in the shader, and
  the flag bits are full. Options, to decide when building:
  - a free lane in the per-mesh/instance uniform;
  - a second flags word (the scheme parallax eyes also needs);
  - drawing faders in their own pipeline variant.
- **CPU cull distance for faders** = Far (coverage is 0 beyond it), so the band costs only its own pixels.

### P3 — Silhouette tiles for streaming / big worlds
- **Status (2026-10-03): BUILT as HLOD, the default outside tier** (performance-plan §P17, engine-roadmap step 5).
  Instead of a fog-only silhouette ring, every outside tile is HLOD: MID (merged shells in colour buckets, ~12 draws)
  near the camera and FAR (ground + walls + roofs, 3 draws, ~0.65 MB) further out, streamed to the Skyline distance
  (default 10 tiles, `setStreamHlod({ skylineTiles })`). The fog rule is the plan's: under the fog horizon a tile wholly
  past Far × 1.45 is always FAR, and swaps back before Far × 1.3 (hlod-select.ts), so its swap happens in flat fog
  colour. Swaps dissolve (flags2 bit 5) in the colour, shadow and AO / SSR passes. Verified: Hard edge + linear fog
  (Far 120) with the skyline at 16 tiles shows a hard-edged fog-colour skyline to the horizon (pupdrive/hlod/visual.js).
  Not built: the impostor-card ring past the last tile. **(Status 2026-10-04: built in P19 as a box stand-in ring, not
  cards — `src/world/skyline-ring.ts`, `sm.world.setStreamHlod({ ring: true, ringDepth })`, default OFF.)**
- Past the full-detail streaming ring, build **silhouette-only tiles**: building shells merged into one mesh per
  tile, one draw call each, with no textures or materials.
  - Built in the worker, and far cheaper than full tiles: a box or extruded footprint per building.
  - This is P7 #6 ("merged distant proxies"), made much easier: proxies past the fog line never need lit
    facades, because they are flat fog colour.
- The streaming radius can then reach well past the full-detail ring, for an effectively endless skyline at
  low cost.
- Optional ring of skyline impostor cards past the last tile, for a horizon that never ends.

### P4 (optional) — Dither cross-fades everywhere
- Reuse the P2 dither for **all** distance-LOD transitions inside the clear zone (a vending can at 144 m, the
  near/far twin swaps for crowd, props and trees). Every pop in the city becomes a short dissolve.
- Cross-fade twins: near fades out while far fades in over the same band.

## 5. Risks / to verify
- **Building classification:** which layers count as "building" (shop fronts, awnings, facade signs, rooftop
  equipment). It decides what the silhouette skyline looks like.
- **Per-mesh fade value** (P2): the flag-bit shortage. See the options above.
- **Post passes on silhouettes:**
  - SSAO is applied in-shader before the fog mix, so fogged pixels are safe.
  - Ink outlines (post) and bloom (bright fog colour) will touch silhouettes. Hence the setting.
  - SSR reflections of silhouettes should be fine.
- **Dither shimmer** in motion with only FXAA: may need a coarse/stable pattern option, or temporal
  stabilisation later.
- **Play camera collision:** culled props past Far are never near the player, so collision is unaffected. The
  collision hood only gathers nearby meshes.
- **Ortho / 2D views:** ~~off (see §3)~~ — supported since the fog-eye refactor (§0).

## 6. Phase 3 and phase 4 — decision brief (2026-10-01)

Both phases build on what already exists: flags2, `FOG_FADE_WGSL` and the fog eye. flags2 bits 4..23 are free, and so are
normalMatrix column 3 .y / .z / .w, because every shader multiplies column 3 by 0.

### Measured starting point for P3
Streaming world, Far 150 m, Buildings only on (pupdrive/fogh2/p3est.js). The table counts what is still drawn although
its whole box is past the fog edge, so it renders as flat fog colour:

| Pose | Meshes past Far / drawn | Triangles past Far / drawn | Largest layers past Far |
|---|---|---|---|
| street | 766 / 2049 (37 %) | 0.66 M / 2.24 M (29 %) | storefronts 140 k, road paint 82 k, kerbs 79 k, sidewalks 76 k, road wear 35 k, gutters 28 k |
| rooftop | 1366 / 2567 (53 %) | 0.96 M / 2.20 M (44 %) | storefronts 218 k, road paint 116 k, kerbs 109 k, sidewalks 105 k, road wear 50 k |

**A cheap step before P3 (hours, not days).** Past Far, overlays that lie ON the ground or ON a facade are invisible:
road paint, road wear, gutters, storefronts. They are fog colour over fog colour; only the outline pass could still see
a crease.
- Reclassifying them as class 'attachment' / 'other' would drop ~0.3-0.5 M of these triangles and ~40 % of the past-Far
  draw calls, with no visible change.
- To verify with P1's A/B screenshot method, including Silhouette outlines on.

### P3 — silhouette-only streaming tiles
**Status (2026-10-03):** built as HLOD (see §4 P3 above and performance-plan §P17); the brief below is the original plan.
**Goal:** past the fog's Far, a streamed tile becomes one merged, material-less mesh of its building shells. It is fog
colour by construction, so the stream radius can grow (an endless skyline) at a fraction of today's cost.

Steps:
1. **Worker job "silhouette tile"** (tile-worker). Start from the tile's block / building footprints and heights; tile-build
   already has this data.
   - Extrude each building's footprint to its roof height.
   - Add landmarks, the viaduct deck and a flat ground slab.
   - Output one merged mesh: positions only (no UVs, no material variety), class 0, `castShadow` off.
2. **StreamManager ring.** Add a third LOD state beyond the full / proxy rings.
   - A tile whose box lies wholly past Far × 1.05 (from the fog eye) uses the silhouette build.
   - Only while the fog horizon is active with Buildings only.
   - Swap back to the full build before the tile's box reaches Far, with a hysteresis ring. A swap is then never visible,
     since both builds are pure fog colour there.
3. **Renderer.** Silhouette meshes take the existing fast path (fog colour, early return). Alternatively, a dedicated
   depth + flat-colour pipeline with no textures bound gives one draw per tile. Nothing casts shadows past Far plus the
   sun's reach.
4. **Radius.** At ~1 draw per tile, raise the streaming distance while the fog horizon is on (e.g. 5 → 10 tiles), and
   keep the orbit zoom cap in step. Optional: a ring of skyline impostor cards past the last tile.
5. **Measure** tris, draw calls, CPU and GPU at Far 150 / 300 m, street / rooftop / Play, before and after. Take A/B
   screenshots to confirm zero visible change at the swap.

Effort: ~3-5 days.
- Worker build: 1 day.
- Stream ring + swap rules: 1-2 days.
- Renderer path, measurements, verification: 1-2 days.

Risks:
- **Skyline match.** The silhouette must match the full tile's skyline exactly: roof shapes, parapets, landmarks, and
  rooftop equipment when attachments are included. Swapping only past Far helps, because both builds are flat fog colour
  there, but a mismatched outline still shows against the sky.
- **Settings churn.** Changing a setting (Far shortened, Buildings only toggled, attachments included) must re-swap
  tiles: a burst of worker jobs and VRAM churn.
- **More resident tiles** means more meshes in the per-frame walks. Each silhouette is one mesh, so this is small.
- **Views that need full tiles.** Ortho / 2D views and the planar mirror need the full tiles. The fog cull is already
  off while a mirror is live.

Expected wins:
- A past-Far tile goes from hundreds of draws and ~0.1-0.3 M triangles to 1 draw and a few thousand triangles. At
  today's radius that removes most of the 30-45 % of triangles and draw calls above.
- ~1-2 ms GPU from a rooftop. This is vertex / raster work; the fast path already cuts the fragment cost.
- Fewer full tiles resident (VRAM, build time).
- The bigger win is qualitative: a skyline that reaches 2-3× farther at about today's cost.

### P4 — dither cross-fade for every LOD swap
**Goal:** every distance-LOD pop (props, crowd, cans, trees, near / far twins) becomes a short dissolve, using the same
stateless per-pixel coverage as the fade band.

Steps:
1. **Per-mesh distances in the slot.**
   - flags2 bit 4 = "LOD fade".
   - normalMatrix column 3: .y = the mesh's draw distance, .z = its aerial-bias weight, .w = its twin swap distance (all
     multiplied by 0 today).
   - The scene uniform carries the frame's lens / resolution / bias scale and the band width, so a slot is rewritten only
     when the mesh's stamp changes.
2. **Shader.** coverage = smoothstep(far, far − band, d), measured from the LOD camera.
   - Add one more dither test wherever the fog one is: colour pass, shadow depth, and the outline and AO pre-passes.
   - Twins: the near twin keeps a pixel when coverage beats the Bayer threshold, the far twin when it does not. The pair
     then partitions the pixels: no double draw, no holes.
3. **CPU.** Replace the hysteresis with the band.
   - A mesh is culled only when its box's nearest point is past `far`; every pixel's coverage is then 0.
   - Both twins stay in the lists while the camera is inside the swap band.
4. **Shadows.** Either send fading casters to the dynamic list (as P2 does), or fade only in the colour pass and keep
   today's shadow swap (cheaper, but a small shadow pop).
5. **Measure and tune.** Set the band per family, and try shorter distances where the dissolve hides the swap.

Effort: ~4-6 days.
- Slot lanes + shader: 1-2 days.
- Twins + CPU band logic: 1-2 days.
- Shadows, ortho, verification, measurements: 2 days.

Risks:
- **Dither shimmer.** Today only the fog line dissolves; with P4, many objects at many distances do. With FXAA only, a
  moving camera shows crawling dots, so the coarse style or a temporal stabiliser may be needed.
- **Static shadow cache churn.** Casters inside a band are dynamic while the camera moves.
- **Double draws.** Twins inside the band are both drawn: more draws and vertex work there, roughly +5-10 % draws at
  street level.
- **Pixel vs box distance.** Near the threshold, a long object starts dissolving at its near end first. That is fine for
  props but odd for long rails / wires.
- **Ortho** uses one distance for the whole view, so everything in a family fades at once on zoom.

Expected wins:
- Visual: no pops.
- By itself, a small cost: +0.1-0.3 ms GPU and a few % more draws.
- The performance lever is indirect. Once swaps are invisible, clutter / prop distances can be cut 20-30 %, giving fewer
  triangles and draws at every height. That is where a net gain would come from.

**Recommendation:** do the overlay reclassification first; it is cheap and measurable. Then do P3 if large streaming
worlds with Hard edge are a target look. P4 is a polish feature, and its payoff depends on accepting the dither in
motion.
