# Salsa → Frogmarks update (audit fixes, 2026-09-28)

Running handoff for everything from the 2026-09-28 audit fix pass that Frogmarks should know about. Full engine-side
detail: [../audit-2026-09-28.md](../audit-2026-09-28.md).

> **Status check 2026-10-04 (dist vs code).** Frogmarks reads `salsa/dist/` through the `file:` link. The dist was rebuilt
> **2026-10-04 03:20**, so every "(after a dist rebuild)" / "no-op until then" note in the sections up to and including
> *Hair styles part 1 (8 presets)* is stale: those APIs ARE in the dist → **browser check pending** only. **Still needs a
> dist rebuild** (source changed after 03:20): P22 `sm.world.setTileLanding` / packed vertices / prop culling;
> `setPlayLandingDust3D` / `setPlayIdleVariety3D` / `getPlayPolishStats3D`; `world.setRoofEquipment` / `roofEquipment`;
> the energetic run + jog (`jogMix`); hair styles part 2 (`twin-braids`, `curly-volume`, `lockCurl`, `lockSpike`, `hairPoof`,
> `tailForm`, `drillTurns`) and `BodyParams.headShape` (anime head); clothing fit round 2 (documented at the end: *Clothing fit round 2*). **Engine-only, no host UI needed** (A/B switches, session state; P16 / P19 / P20 / P21 are in the dist):
> `sm.setStreamHitchOptions3D` (P16), `sm.world.setStreamMotion` + `setStreamHlod({ ring })` (P19, ring off),
> `sm.world.setLighterTiles` (P20), `sm.setShaderVariants3D` (P21), `sm.world.setTileLanding` (P22). Some Frogmarks file
> paths below moved: perf / sim / step-3 controls → `world-panel.component.ts`, stats HUD → `scene-stats.service.ts`, device
> banner → `engine-status.service.ts`, fog / shadow quality → `scene3d-settings.service.ts` / `scene-render-settings.component.html`.
> Index of the week: [../STATUS-2026-10-04.md](../STATUS-2026-10-04.md).

**TL;DR — action items for Frogmarks**

1. **Show a "saving paused" notice** when `sm.getSaveBlockedReason()` is non-null (details below). Without it, a
   partially-failed load silently stops autosave and the user won't know. *(Status 2026-10-04: ✅ built in Frogmarks —
   `save-blocked-banner` + Keep / Reload in `illustration-persistence.service.ts`; other save-status spots don't show the
   reason yet.)*
2. **Remove the `(shapeManager as any)` casts** (~400) so renames break at compile time — see T6 in the audit doc.
   Not urgent, but must land before Salsa prunes unused public methods (audit A2). *(Status 2026-10-04: partly done —
   `illustration.component.ts` burned down; newer panels add guarded `as any` calls again, e.g. ~15 in
   `character-panel.component.ts`.)*
3. Nothing else is required — every other change below is automatic. Re-test the flows in *Please verify*.

---

## New APIs

| API | What it's for |
|---|---|
| `sm.getSaveBlockedReason(): string \| null` | Non-null = autosave is **paused** because the last document load failed or partly failed (saving would overwrite the good copy on disk with a partial scene). Show it to the user. |
| `sm.getLastRestoreIssues(): RestoreIssue[]` | Every step that failed during the last load. `RestoreIssue = { area: string; message: string; blocksSave: boolean }` (type exported from the package). Empty = clean load. |
| `sm.clearSaveBlock(): void` | Re-enable saving after a failed load — e.g. the user picks "Keep what loaded" in the notice. |
| `setBodyParams3D(id, { seamBlend })` | New body param **Joint smoothness** (0–1). Blends skin weights at the armpit/elbow seams so they stop folding when posed. Add a slider (0–1, step 0.05). Saved characters are 0 (unchanged); new ones start at 0.5. |
| `setSkinningMethod3D(id, 'linear' \| 'dualQuat')` / `getSkinningMethod3D(id)` | How a character's joints blend. `'dualQuat'` keeps volume at bent elbows/knees (no pinch); `'linear'` is the original. Pass the body id, a skeleton id, or any of the character's clothes/hair — the whole character switches together. Suggest a toggle next to Joint smoothness ("Joint blending: Linear / Dual quaternion"). Persists. New bodies are `'dualQuat'`; saved ones stay `'linear'`. |

| `sm.playClipOverIdle3D(bodyId, clip): boolean` | Play a clip (name like `'Wave'`, or id) **once, layered over the idle** — breathing / sway / weight shift keep going on everything the clip doesn't animate, it crossfades in and out, its eye events fire, and stock clips start/end on the character's real stance. Turns the idle on for the clip if it was off (and off after). Works in armature mode. **Suggested:** a "Play with idle" toggle next to the armature panel's Play — when on, `playClip()` calls `sm.playClipOverIdle3D(bodyId, clip.name)` instead of `playSkeletonClip3D` (it plays once; no player object to stop). |
| `sm.isPlayingOverIdle3D(bodyId): boolean` | Whether that one-shot (or an idle break) is still playing — e.g. to reset the Play button. |
| `salsaWorld.callbackStats()` (console) | Per-frame CPU profile: each per-frame callback (springs / IK / idle / gizmos …), whole-frame CPU, real fps. Call once to start, again after a few seconds. `salsaWorld.callbackStatsOff()` stops it. For the "armature Play drops to 40 fps" report. |
| `sm.setSketchPaper3D(amount)` / `getSketchPaper3D()` | **Sketch** render style's PAPER amount, 0–1, scene-wide: 1 = off-white paper with a colour wash (why Sketch looked washed out), 0 = the full colour with pencil hatching. Default 0.75 = exactly the old look, so saved scenes are unchanged. Suggested: a "Paper" slider (0–1, step 0.05) shown when Sketch is the style. Persists with the document. |
| `sm.setMeshOutlineRings3D(id, rings)` / `getMeshOutlineRings3D(id)` | **Stacked outlines** — extra rings OUTSIDE a mesh's outline, inner → outer (red outline + white ring around it). Each ring = `{ color, width, … }`, width = its own thickness; other fields default to the main outline's. `[]` clears. Persists. Suggested UI: a "Rings" list with **+ Add ring** under the Outline section — see [object-outlines.md](./object-outlines.md). |
| `sm.setPostProcessing3D({ film: { enabled, grain, grainSize, aberration, halation, halationTint } })` | **Film look** (the Orbitals / 90s-anime texture): animated grain (mid-tones, 24 fps), colour fringing toward the frame edges, halation = a warm tint on the bloom (needs bloom on). Off by default; persists with the other post settings. Suggested: a **Film** group — Grain (0–0.3), Grain size (1–3 px), Colour fringing (0–0.01), Halation (0–1) + tint. |
| `sm.setToonShadows3D({ bands, softness, shadowValue, shadowTint, saturation })` / `getToonShadows3D()` | **Coloured toon shadows** — the scene look for toon-shadowed materials in **Cel / Cel-HD**: 1–4 bands, terminator softness, how bright the shadow is, a shadow COLOUR tint (default lavender → anime purple/blue shadows), extra saturation. Persists. |
| `sm.setCharacterToonShadows3D(bodyId, on)` · `sm.setMeshToonShadow3D(meshId, on)` | Turn toon shadows on for a whole character (body + hair + every garment + charms) / one mesh. Only visible in the Cel styles. Persists; regenerated hair/clothes keep it. |
| `sm.setRimLight3D({ strength, width, hardness, color })` / `getRimLight3D()` | **Rim light** look for rim-enabled meshes (`setCharacterRimLight3D`): strength 0 = the original built-in rim (unchanged); >0 = this rim — width (how far in from the edge), hardness (soft → crisp toon edge), colour (e.g. cyan). Persists. |
| outline style `{ wobble, wobbleFreq, boilFps }` | **Line boil** on per-object outlines + rings: `wobble` 0–1 (thickness varies along the line), `boilFps` redraws/second (8–12 = hand-drawn animation; 0 = uneven but still), `wobbleFreq` wobbles per unit (default 10). 0 = today's even line. |
| `SkeletonAnimClip.faceTrack?` (type) | Optional eye events on a clip: `{ frame, gaze?: [x, y], blink?, restore? }` — gaze jumps (offset from the pre-clip gaze) and blinks, fired during playback. The default clips use it. Clips without it are unchanged. |

**Suggested UI:** after `loadDocument` / `unpackProject`, if `getSaveBlockedReason()` is set, show a banner: *"Some
parts of this document didn't load (…areas…). Autosave is paused so your saved copy isn't overwritten."* with
**[Keep what loaded & resume saving]** → `clearSaveBlock()`, and **[Reload]**. List `getLastRestoreIssues()` areas.
Note: an explicit `saveDocument()` also returns `false` while blocked.

## Behaviour changes (automatic — no code needed)

- **Saving is fenced off during a document load.** Autosave, the stroke-debounced save, and explicit `saveDocument()`
  all skip while a load is in progress (a pending debounced save is cancelled). Previously an autosave firing
  mid-load wrote the half-loaded new doc into the *previous* doc's folder.
- **`.frogmarks` format v2.** `packProject()` now writes exactly what autosave writes (it used to drop UV/face/garment
  paint, baked parts, GARP pools, packaging). `unpackProject()` restores through the normal load path. **Old v1
  `.frogmarks` files still import.** A file from a newer Salsa build is refused with an error.
  - `packProject()` no longer marks the scene as saved — the next autosave still writes everything.
- **Opening a doc no longer inherits the previous doc's state** — character rigs, CD kits, GARP pools, UI layers,
  loaded GLB models, kitbash character groupings, and global scene settings (fog/PS1/SSAO/…) are cleared/reset first.
  A doc with no 3D now clears the previous doc's 3D.
- **GARP pools and UI state machines now actually save to OPFS** (they were silently lost on reload before).
- **Kitbash character groupings now save with autosave** (only `.frogmarks` had them before).
- **Undo history is cleared on load** for 2D shapes too (Ctrl+Z after opening a doc could replay the previous doc).
- `enableAutoSave(...)` called again now stops the previous autosave instead of leaving it running.
- **New characters also use dual-quaternion skinning** — bent elbows/knees keep their volume instead of thinning.
  Expect a slight outward bulge on very sharp bends (the standard trade). Toggle per character to compare.
- **New characters bend better at the shoulders and elbows.** `createProceduralBody3D` now creates bodies with Joint
  smoothness 0.5 — the armpit no longer folds in on itself in the default Relaxed pose (measured: 16 folded triangles →
  ≤4; A-pose armpit/elbow folds → 0). Garments follow automatically. **Existing saved characters are untouched** (0).
  If a new character looks different from an old one next to it, that's why — the slider lets you compare.
- **Character presets (`exportCharacter3D` / `importCharacter3D`) are now complete — format v2.** Export adds skin
  tone, **all six clothing slots** (v1 exported them but import only applied top + bottom), charms, and procedural eye
  expressions. **Import now REPLACES the look** rather than layering onto it: slots the preset doesn't have are
  removed, charms are replaced, `hair: null` makes the character bald. Old v1 presets still import and leave
  skin/charms/eyes as they were. If a UI labels this "Apply preset", that's now accurate; if anything relied on
  import *adding* to an outfit, it now needs to merge before calling. Hand-drawn eyes aren't in presets (only
  slider-made ones).
- **Clothing on new characters tears / clips much less when posed** (measured across 26 poses: arm raises, walk,
  run, sit, squat, lunge, kicks, splits, torso bends/twists). Tops no longer tear at the waist when bending forward
  (Tank 10% → 4% of the shirt, now close to the skin's own), the undershirt stopped showing skin at the arm socket, and
  trousers stopped showing the seat when walking/sitting (up to 24% of covered skin, 3–4 cm → ≤7%, ~2 cm). No API
  change; garments just follow the body better. **Saved (classic) characters' clothes are bit-identical** — every
  preset verified against the previous code. Remaining known issues: deep squats still stretch the knee area of
  shorts/trousers (the skin itself stretches there too), and a long-sleeve collar can dip ~2 cm into the neck with
  both arms straight overhead.
- **Preset poses + default animations rewritten — they looked stiff, and several clipped or were plainly wrong.**
  Measured by rendering every pose/clip keyframe on the real body and counting arm skin inside the body/head:
  Wave swung the arm past vertical THROUGH the head; Thinking held the hand beside the head (now: hand at the chin,
  other arm folded under the elbow); Hand Behind Head / Scratch Head buried the hand 3–6 cm inside the skull;
  Stretch drove the arms through the ears. All now clean. **The default stance (Relaxed) is new:** arms a little
  out, hands hanging beside the thighs (not jutting forward — tuned from a side-view screenshot), soft asymmetric elbows, forearms turned in, relaxed wrists, dropped shoulders — instead of
  dead-straight mannequin arms. New characters stand like this; **saved characters keep their saved pose**.
- **The idle now moves the arms** (it only moved the torso/head before — why it read stiff): the arms trail the
  weight-shift like a pendulum, float out a hair and the shoulders lift on each breath, elbows soften, wrists
  drift; left and right on different phases. This applies to every character with the idle on (it's runtime
  motion, nothing saved changes).
- **Poses fit the body's shape.** Applying a preset / library pose, and changing body sliders, now nudges a HANGING
  arm out (or opens a bent elbow) just enough to clear THIS body — on a heavy/broad body the fixed angles sank the
  arms ~4 cm into the torso. A body the pose already clears is left exactly as posed. If a user-authored arms-down
  pose is on a body that's then made heavier, the arms move out slightly when the slider is released.
- **Idle "breaks" (Stretch / Scratch Head) start from and return to the character's CURRENT pose** instead of
  snapping to the default stance at their ends. The same applies when the user plays one of the stock one-shots
  (Stretch / Scratch Head / Wave) by hand — as long as it hasn't been edited.
- **🐛 FIXED: body sliders did nothing on an existing character** (only the creation preview). Cause, on Salsa's
  side: `getBodyParams3D` returned Salsa's live internal object; Frogmarks binds its sliders to what that returns, so
  each drag edited the stored params in place, and `setBodyParams3D`'s "nothing changed?" check then compared the
  object with itself and skipped the rebuild. `getBodyParams3D` / `getHairParams3D` / `getClothingParams3D` now
  return copies. **No Frogmarks change needed** — the existing slider code works as written.
- **Default animations re-authored with animation principles** (round 2 — "still stiff"). The clip player
  interpolates linearly (constant speed, dead stops), so the defaults are now authored as eased key poses and
  baked: slow-in/slow-out, overshoot-and-settle, anticipation, follow-through (forearm/hand/head trailing).
  Stretch dips first, sweeps the arms up in FRONT (not sideways through a T), reaches, settles; Look Around is
  quick glances with a settle (6 s loop, was a slow 9 s pan); Breathe has a real breath shape; Talk Gesture has
  beats; **new `Wave` clip** (one-shot, not a random idle break). The procedural idle uses organic rhythms.
  Clips/poses a user authored play exactly as before (no player change).
- **More of the body moves in the default clips.** Wave / Scratch Head / Talk Gesture / Shift Weight now shift the
  WEIGHT onto one leg — the pelvis tips, the thighs counter-rotate so the **feet stay planted** (tested: < 1.5 cm), the
  free knee softens, the torso stays upright. And the **eyes** join in: they jump ahead of head turns (Look Around),
  look up in Stretch, look aside/down in Scratch Head, and blink on the big moves. ⚠ The eye left/right direction is
  set on paper — if the eyes look AWAY from where the head turns, tell Salsa (it's one constant, `GAZE_TO_LEFT`).
- **🐛 FIXED: armature mode camera — (1) with several characters it stayed on the FIRST one.** Switching skeletons in
  the Armature panel now re-aims the camera, the isolation, and the face-front reset at THAT skeleton's character
  (the one passed as `bindMeshId` is used only if it belongs to the chosen skeleton; otherwise its own body). **(2)
  leaving armature mode didn't return you to your 3D Free view** — the "where you were" camera was captured AFTER
  `enterArmatureMode3D` had already framed the mesh, so exit restored the framing. It's now captured before. No
  Frogmarks change needed (the panel's existing calls work as they are).
- **🐛 FIXED: a pose made in armature mode was lost on leaving it when the character's IDLE was on** (it snapped back —
  e.g. "stuck in T-pose"). The idle re-applied the pose it captured when it was turned on. Now entering armature mode
  snaps to that base, and leaving adopts your new pose as the idle's base (it keeps breathing from there). An autosave
  mid-posing also keeps your edits. No Frogmarks change needed.
- **Skin "Ramp" now works in the Cel styles.** It used to be per-vertex and only visible in the **Gouraud** style (a Cel
  character with Skin style = Ramp showed no change). Now a Cel / Cel-HD skin with Ramp gets the banded warm shadow
  per-pixel. ⚠ A saved character that already had Ramp selected in Cel will now SHOW it (that's what was chosen).
- `setCharacterRimLight3D` now covers every part (was body/eyes/hair/top/bottom — shoes, socks, base layers and charms
  were missed) and survives regenerating/reloading hair + clothes. Charms are also now part of the character group.
- **Scene look settings — what persists (checked 2026-09-28):** lighting, ambient, shadows, fog, sky / IBL / reflections,
  SSAO, wind, texture filter, background, PS1, **post-processing incl. the new film block**, soft-light strength, skin
  ramp, Sketch paper, **toon shadows**, **rim light** — all saved with the document (Frogmarks' own settings blob also
  saves bloom / grade / vignette / film). **Newly persisted:** the screen-space **edge outline** (`enableOutlines3D`)
  and the particle **"Bloom Glow"** (`enableBloom3D`) — both were lost on reload before. Per-object outlines + rings,
  toon/rim flags live on the meshes. **Not persisted:** `setPointLights3D` lights (runtime — the city rebuilds its
  lamps; place-able point lights would need a node type).
- **🐛 FIXED: CHARACTER outlines didn't survive a reload** (regular-mesh outlines did). The three character restore paths
  returned before the outline was restored. Also: an outline set with a garment / the hair selected lived on that part,
  which is rebuilt from params on every reload + slider change → lost. A character's outline + rings now always live on
  its BODY (set / get / rings on any of its parts redirect there — it's one silhouette anyway), and setting an outline
  now marks the mesh for autosave. No Frogmarks change needed.
- **Per-object outlines are now one even band.** A character's outline is drawn per part (body, clothes, hair) and
  where the parts' bands overlapped they were blended 2–3× — with a translucent colour that showed as uneven grey/white
  layers. Each outline pixel is now drawn exactly once. (The slider next to the outline **Color** is OPACITY — at 1.0
  the band is solid; consider labelling it "Opacity".)
- **Wave + Thinking poses redone with body lines**: Wave — elbow at shoulder height, hand up, head tipped toward
  it, chest turned/leaning away; Thinking — head turned aside and tipped up ("hmm"), weight shifted.
- **Dependency security:** Salsa's `fflate` (zip) is now 0.8.3, which fixes an infinite loop on crafted ZIP64 files —
  relevant because `.frogmarks` / `.frogcart` imports parse user-supplied zips. `npm audit` on Salsa is now clean.
- `setSceneGraphJSON(json, opts?)` gained an optional `{ rethrow?: boolean }` (default behaviour unchanged).
- **Documents are now versioned** (`manifest.schemaVersion`). If a document was saved by a NEWER Salsa build than the
  one running (e.g. a stale cached build, or a second tab on an older build), it still opens, but **saving is
  blocked** — `getSaveBlockedReason()` explains it ("saved by a newer version of Salsa…"). Show the same notice as
  for a failed load; for this case the right advice is **"reload to get the latest version"** rather than "keep what
  loaded" (don't offer `clearSaveBlock()` — it would overwrite the newer data).
- **Autosave now also saves when the tab is hidden or closed** (`visibilitychange` / `pagehide`) — previously up
  to 30s of 3D/vector edits were lost on close. No wiring needed; it's attached by `enableAutoSave`.
- **Saves no longer overlap**: `saveDocument()` while an autosave is writing now waits for it, and saves hold a
  per-document Web Lock so two tabs on the same doc can't interleave writes. (Two tabs editing the SAME doc is still
  last-writer-wins — consider warning the user if Frogmarks can detect it.)
- **Replacing a library texture with a raw one no longer reverts on reload** (the stale library link re-bound the
  old texture); a normal-map flag with no map behind it is dropped on load.
- **Multi-material meshes (submesh slots) now save** — per-slot materials used to reset on reload.
- **Autosave pauses during UI preview (`setUIInteractive(true)`) and Player mode**, like it already did in Play mode,
  so a scrubbed/playing animation pose can't be saved over the authored one. It resumes when preview ends; an
  explicit `saveDocument()` still works during preview.

## Please verify in the browser

- Open doc A, draw, immediately open doc B → A and B are each intact after reload.
- Open a doc with an imported GLB, make one 2D stroke, wait for autosave, reload → the GLB is still there.
- Author a GARP skin variant / a UI state machine, reload → it's still there.
- Export `.frogmarks` from a character doc with UV paint + face → import into a fresh doc → paint, face, clothing all
  come back; procedural/city content isn't duplicated as loose meshes.
- Import an OLD `.frogmarks` file → loads as before.
- Open a doc with characters, then one without → the second has no leftover rigs/clothes.
- Hover outline on any mesh (not just the first) is positioned correctly (silhouette shader fix).
- (Hard to trigger by hand) a doc whose manifest has a higher `schemaVersion` opens read-only with the notice.
- Create a new character → arms at the sides (Relaxed): the armpit/underarm reads as a smooth crease, not a crushed
  notch. Drag Joint smoothness 0 ↔ 1 to compare; a saved character opened from before should look exactly as it did.
- ⚠ **First check after updating Salsa: any skinned mesh rendering black or missing** = a shader compile error in the
  new shared skinning code (WGSL can only be validated in the browser). Send Salsa the console error.
- New character: toggle `setSkinningMethod3D(bodyId, 'linear')` ↔ `'dualQuat'` while bending an elbow/knee — volume
  holds in dualQuat; body, clothes, hair, the outline and the shadow all move together in both modes.
- A dressed new character: sleeves follow the smoother armpit (no new clipping at the shoulder).
- Several characters in 3D Free → orbit/pan somewhere → open Armature → pick each skeleton in the list: the camera jumps to
  THAT character (the others hide) → close the panel: you're back exactly where you were in 3D Free.
- Idle ON → armature mode → change the pose → leave → the new pose stays (and breathes). Reload → still there.
- **Body sliders on an EXISTING character now reshape it** (select a created character → drag any body slider).
- Play Stretch / Look Around / Wave / Talk Gesture: motion eases in and out, arms overshoot and settle, hands trail.
- Film: `setPostProcessing3D({ bloom: { enabled: true }, film: { enabled: true } })` → soft grain that moves, slight
  colour fringe at the frame edges, warm glow around bright emissives. All off → identical to before.
- Toon: Cel character + `setCharacterToonShadows3D(id, true)` → two-tone lavender-shifted shadows; drag
  `setToonShadows3D({ shadowTint })`. Rim: `setCharacterRimLight3D(id, true)` + `setRimLight3D({ strength: 1, color: [0.5,0.9,1] })`
  → a crisp cyan edge. Outline boil: `setMeshOutline3D(id, { wobble: 0.35, boilFps: 10 })` → the line wiggles ~10×/s.
- Outline + rings on a character (select the body OR a garment) and on a plain mesh → reload → all still there.
- Stacked outline: `setMeshOutline3D(id, { color: [1,0,0,1] })` + `setMeshOutlineRings3D(id, [{ color: [1,1,1,1], width: 0.02 }])` →
  a red band with a white band around it, on a plain mesh AND on a dressed character.
- Outline a dressed character (Outline panel, opacity ~0.5): the band is one even tone all round — no darker
  patches where the sleeves / legs / hair overlap. Also check a regular (non-character) mesh outline still draws.
- **Environment Style (2026-09-29).** The city, blocks and creator props now keep a SAVED look (render style / toon
  shadows / rim light), which used to be lost on every rebuild and reload. There's also one Environment Style control
  that styles them all without touching characters. Full guide: **environment-style.md**. New API:
  `setEnvironmentStyle3D` / `setCityStyle3D` / `setBlockStyle3D` / `setCreatorStyle3D` (+ getters). UI built in
  Frogmarks: scene settings "Environment Style", an Edit Block "Style" strip, and City Look toon/rim checkboxes.
  Rebuild Salsa first; Frogmarks' type-check flags only these new methods until then. Check:
  1. Set Environment Style to Cel HD + Toon shadows. The city, blocks and vending machines change; characters don't.
  2. Give one block Cel instead, then add a building to it. It stays Cel.
  3. Reload. Every style (environment, city, block) is still there.
  4. Clear the city and make a new one. With an Environment style set, the new city gets it.
- **Only a plain left click selects in 3D (2026-09-29 fix).** Middle-click, right-click and Alt+left (orbit) used to
  select meshes or clear the selection, and in armature mode could pick joints or place bones. Fixed in three places:
  - Frogmarks `scene3dCanvasPointerDown`, which never checked the button: now `event.button !== 0 || event.altKey` →
    return. Edited in Frogmarks; see its salsa-tracker.md.
  - Salsa's transform controller, whose left-click select also fired on Alt.
  - Salsa's armature mouse-down, which checked neither.

  Check: in 3D Free and in Armature mode, Alt+drag orbit, middle-drag pan and right-drag over a mesh or joint →
  the selection doesn't change. A plain left click still selects.
- **Procedural ground grout no longer speckles or shimmers (2026-09-29 fix).** The grout drew as noisy dots that
  crawled when the camera moved, worse up close, because the shader estimated the tile scale per pixel from
  imprecise screen derivatives. It's now computed once per mesh. Check: zoom right into a paved plane and into city
  pavements, then orbit. The grout should be clean continuous lines that don't crawl, and tile sizes unchanged.
  (A ground mesh that also has a texture or normal map still uses the old estimate.) The fine checkerboard over
  everything in those shots is the PS1 **dither**, which is separate. With "Apply to: Opted-in only" you can keep
  it off the ground.
- **Retro colour on chosen objects only (2026-09-29).** The PS1 Color Depth + Dither can apply to opted-in
  objects only: `setRetroColorScope3D('optIn')` + `setCharacterRetroColor3D(id, true)` /
  `setMeshRetroColor3D(id, true)`. See character-shading.md "Retro colour on chosen objects only". Check:
  1. Set Color Depth 3 + Dither, Apply to "Opted-in only", and tick Retro colour on a character. Only that character
     is banded; the environment is full colour.
  2. Reload: the scope, the character's tick, the colour depth and the dither all stay.
  3. With Apply to "Everything", the scene looks exactly as before.
- **Persistence audit + fixes on the FROGMARKS side (2026-09-29).** Salsa already saved and restored the PS1
  settings and each character's render style; the losses were in Frogmarks. Edits made directly in
  `Frogmarks/ClientApp/src/app/illustrate/components/illustration/` (`illustration.component.ts` / `.html`):
  1. **PS1 panel synced from the engine after every load.** A new `_syncScene3dPS1FromEngine()` (extracted from
     `scene3dApplyRetroPreset`) is called in `markLoaded` once everything has loaded. Before this, the panel kept its
     defaults (colour depth 32, dither off). Since every PS1 control sends the whole panel (`scene3dApplyPS1`),
     touching any slider after a reload reset dither and colour depth.
  2. **Character Style dropdown synced.** `_syncSkinShading` (run on every character open/switch) now reads
     `getRenderStyle3D(id)` into `charRenderStyle`. It used to always show its `'cel'` default.
  3. **Local mode no longer re-applies a stale scene graph.** `loadIllustrationV2` (syncMode 2) used to call
     `setSceneGraphJSON(opfsMeta.sceneGraph)` after Salsa's `loadDocument` had already restored everything. That
     wiped the scene root and rebuilt it from Frogmarks' own snapshot, written at a different time: stale materials,
     skinned characters as empty placeholders. It now happens only when Salsa restored nothing; otherwise the layer
     tree is built from `getSceneStructureJSON()`.
  4. **New UI:** the "Apply to" select (PS1 panel, under Color Depth) and a "Retro colour" checkbox (character
     Style row), with `scene3dSetRetroColorScope` / `scene3dSetCharRetroColor` and the `scene3dRetroColorScope` /
     `charRetroColor` fields.

  ⚠ **Rebuild Salsa** before building Frogmarks: `setRetroColorScope3D`, `setCharacterRetroColor3D` and
  `getMeshRetroColor3D` are new, and Frogmarks reads Salsa's types from its built `dist/`. Until then, Frogmarks'
  type-check reports exactly those three as missing, and nothing else in the edited file.

  **Not changed (noted):** in local mode Frogmarks' metadata saves omit its `scene3dGlobalSettings` block. That's
  harmless now, since Salsa's copy is used, but inconsistent with the cloud path. In the cloud path, Frogmarks
  applies its own copy **after** Salsa's restore, so a stale Frogmarks copy would still win there.
- **Vending machine redesign (2026-09-29).** 3D cans on lit shelves, price strips and LED buttons, a control panel,
  a pickup bay. Each skin gains a **`labels`** slot, fed by `packVendingCanLabels3D(skin, pngs)`. See garp.md "Vending
  machine skins" (with a suggested "Can designs" UI) and vending-creator.md (new `shelves` / `cansPerShelf` / `stock`
  params). **Can PNGs don't have to share a size**; the packer fits each. Check:
  1. Regenerate a city: machines show shelves of colourful cans, with the control panel on the **right**.
  2. Add 2–3 PNGs to `red` via `packVendingCanLabels3D('red', […])` and regenerate: red machines show your cans
     (other brands don't), and a street shows different mixes.
  3. Any text on the cans and body reads the right way round (not mirrored).
  4. Each machine's body, backdrop and cans are always from the same skin.
- **Film grain no longer fades (2026-09-29 fix):** turn on film grain and leave the scene running for 5+ minutes;
  the grain should stay as strong as when it started. The old hash lost precision as the clock grew.
- **Focus backgrounds skip post-processing (2026-09-29 fix):**
  1. Turn on post effects (colour grade / bloom / film) and enter Armature mode.
  2. The wavy background looks exactly as it does with post off, not washed to white, while the character keeps its
     post look. The same applies in Mesh Edit.

  Exception: in lo-res (PS1) render mode the background is still processed.
- **Blink follows the open eyes (2026-09-29 fix):**
  1. Take a character with auto-blink on and set Neutral's deco dots to 0.
  2. Watch several blinks: no dots should appear.
  3. Switch to another state: the blink matches that state's eyes.
  4. A character saved before the fix is repaired on reload.
- **Sprite outline shapes (2026-09-29).** UI requested: an **Outline shape** dropdown for sprites. (Status 2026-10-04:
  BUILT in Frogmarks — `spriteShape` in `mesh-outline-section.component.ts`; browser check pending.) See
  object-outlines.md, "Sprite outline shape".
  1. Add a Sprite with a transparent PNG and outline it. After a frame or two, the outline follows the picture's
     shape, not the square.
  2. Add a ring and set `wobble` → both follow the shape.
  3. `{ spriteShape: 'square' }` → the square outline.
  4. `{ spriteShape: 'card' }` → the see-through parts fill with the outline colour and the rings go around the
     square.
  5. Try the Persona recipe in that doc.
  6. Check that an opaque-image sprite, a box, a GLB and a character outline all look **exactly** as before.
- Sketch style: `setSketchPaper3D(0)` → full colours with pencil hatching; `0.75` → the old look; check a SKINNED
  character in Sketch too (the scene uniform grew 832 → 848 bytes — a black/missing mesh = a shader layout error).
- `sm.playClipOverIdle3D(bodyId, 'Wave')` in normal view AND in armature mode: the wave plays while the body keeps
  breathing / swaying, the weight shifts onto the left leg, the feet don't slide, the eyes blink. Look Around: the eyes
  move BEFORE the head (check the direction — see ⚠ above).
- A NEW character: it stands relaxed (soft elbows, slight asymmetry); turn the idle on — the arms sway/breathe
  gently, never through the body. Apply each library pose (Wave, Cheer, Thinking, Hand Behind Head, Hands on Hips)
  — nothing through the head/body. Make the body heavy (sliders) → the arms move out to clear the belly.
  Turn idle breaks on → Stretch / Scratch Head leave from and return to the current stance smoothly.
- A NEW character in a tee/tank + trousers: bend forward (spine), walk, sit, squat → the shirt doesn't split at the
  waist and the seat stays covered. Open an OLD dressed character → its clothes look/move exactly as before.
- Export a fully-dressed character (shoes, socks, charms, eyes), import onto a fresh body → everything matches.
- Edit something in 3D, then close the tab within a few seconds → reopen → the edit is there.
- Give a mesh 2+ material slots with different materials, reload → the slots and materials are kept.
- Preview a UI machine that plays/seeks an animation, wait >30s, stop preview, reload → the character is in its
  authored pose, not the scrubbed one.

## City quality upgrade (Salsa, 2026-09-29) — panel reorganised in Frogmarks

The full API list and the new panel layout are in [city-quality.md](city-quality.md). Roadmap:
[city-quality-upgrade.md](../specs/city-quality-upgrade.md). **Needs a Salsa rebuild** before Frogmarks type-checks.

Automatic (no host code):
- Night is lit by real lamps. The old "everything glows a little" floor is gone, and signs, screens and shop glass
  glow at night.
- Shadows are coloured: blue at noon, violet at dusk, indigo at night. The sky, fog and grade follow the sun.
- Lamps light at head height. Lit layers are no longer culled when zooming out.
- A wide glow on neon at night. Hero-framing skips the sky dome.

New for the host (all wired in the reorganised City panel):
- Persona packs `persona5` / `persona4`, and palettes `phantom` / `inaba`.
- `world.setSkyLighting` / `setWetReflections` / `setSSAO` / `setCityOutlines` / `setHeightFog` / `setLampColor` /
  `setShadowTints` / `heroView`, plus getters.
- `world.styles` gives pack labels.
- Grade split-tone uses `setTimeGradeKey(phase, { shadowTint, highlightTint })`.

Please verify in the browser:
  1. Apply **Phantom Night**: red/black neon night, ink outlines, cel look. Apply **Inaba Dusk**: warm dusk with
     haze in the streets while rooftops stay crisp.
  2. Scrub the time of day: shadows change hue, and at t≈0.92 the sky is night (no orange band against navy fog).
     Lamps light the street at night.
  3. Toggle each Look control and check it changes the view. Reload: every look value comes back.
  4. Exit City mode and check the host's own outlines / SSAO / lighting return. Re-enter and check the city's
     outlines / SSAO come back.
  5. **Hero view** frames a low street-canyon angle.
  6. Panel: sections collapse and expand, and the state survives a page reload.
  7. Open an old city doc: it looks as before, apart from the automatic lighting fixes above.
  8. **Streets:**
     - Kerbs, gutters, dropped kerbs with yellow tactile paving, real-scale zebras.
     - Stairs and retaining walls only where the ground steps. Nothing floats on hills.
     - Watch for z-fighting of the thin stacked ground layers in perspective.
  9. **Buildings:**
     - A continuous street wall, with windows per storey and varied night windows.
     - Lit shop interiors, lettered kanji signs, AC and laundry clutter, Japanese roofs.
  10. **Life:**
      - Cars drive on the LEFT, stop at red lights, turn at junctions, and swerve around parked cars.
      - Walkers wait at zebras for the green, and walking legs swing.
      - Umbrellas in rain. Headlight pools appear only at night.
      - Check frame time with the ~770-person static crowd and ~120 walkers.

### Frontage dressing + painted sky (persona-polish D1 / E1 — built 2026-09-30)

New layout param (see [city-quality.md](city-quality.md)):
- `frontageDressing: boolean` (absent = on). Add a **Frontage dressing** checkbox next to Street furniture, sent
  through `updateCity({ frontageDressing })`. It is a selective rebuild of the furniture group.

Automatic (no host code):
- Shop streets get nobori flag runs (they sway in the scene wind), noren over small-shop doors, doorway pots, bikes
  against the wall, and extra crates and menu boards. Residential streets get light doorstep gardens. The shotengai
  gets flag rows.
- **Painted clouds** (the existing look toggle) now draws soft painted cloud cards on the horizon, with sunlit crowns
  (gold at golden hour). In clear weather it also replaces the small drifting puffs with a few big high clouds.
  Painted clouds are excluded from auto-framing, so Hero view frames tighter on the city.
- Weather decks (rain / snow / overcast) are unchanged.
- There is also a new internal param, `paintedClouds`, which WorldManager keeps in step with the look. Do not expose it.

Please verify in the browser:
- The nobori sway gently and stay attached to their poles, including in Play mode.
- At Golden Hour, clouds show warm crowns over lilac undersides. Nothing in the sky is cut by a straight edge.
- A walker never passes through a flag, a pot or a parked bike.

### Stairs, edge wear, character outlines (persona-polish B6 / E2 / E3 / E4 — built 2026-09-30)

New controls (see [city-quality.md](city-quality.md)):
- **Edge wear** dropdown (Off / Subtle / Heavy) in the Look group. It calls `world.setEdgeWear('off' | 'subtle' |
  'heavy')`; read it back with `world.edgeWear`. It is stored in the city params (`LayoutParams.edgeWear`) and
  persists with the city. Changing it rebuilds the layout and terraces groups only. A look object may carry
  `edgeWear`, but it applies only when present.
- **Character outlines** checkbox in the Look group. On calls `sm.setCharacterOutlines3D({})`, off calls
  `sm.setCharacterOutlines3D(null)`. Read the state with `sm.getCharacterOutlines3D()` (null = off). A colour or width
  control is optional: pass `{ color: [r,g,b,a], width }` and the rest of the style merges on. Saved with the scene.

Automatic (no host code):
- Street stairs have granite steps (one slab per step), dark or yellow grooved nosing strips, a flat landing, and a
  plain side wall matching the retaining wall.
- Static pedestrians' heads are a little smoother.

Please verify in the browser:
- Edge wear Heavy: walk up to a stair and a kerb. Chips appear within ~18 m, and the swap happens with no visible jump
  in the stone texture.
- Character outlines: the player character (and its clothes and hair) gets one ink silhouette. Buildings, cars and the
  crowd stay unoutlined.

### Facades (persona-polish B4 / D2 / D3 — built 2026-09-30)

Automatic (no host code):
- City buildings get varied facade materials: tile, concrete, painted render, metal panel and brick, weighted by district.
- Wall colours are muted, and there are floor bands and cornices.
- Windows are recessed, with a shaded reveal, a sill and sky reflections.
- AC units and pipes dress the first storeys of street faces.
- Saved cities rebuild with the new facades.

Building Creator: two new `BuildingParams` for the Facade / Features groups (see [building-creator.md](building-creator.md)):
- `material: 'panel'` (windowed metal-panel cladding). Add it, and `'siding'` if it is missing, to the Material dropdown.
- `windowSills: boolean` (default on). A checkbox next to `windowTrim`.

Please verify in the browser:
- At street level, windows read as recessed. Their reveal side follows the camera, and the room behind still slides
  the right way.
- Walls at mid distance show no shimmering grain.

### Light, shadows, AA, haze (persona-polish Pass A — built 2026-09-30)

New controls (details and defaults in [city-quality.md](city-quality.md), "Light, shadows, anti-aliasing, haze"):
- **AA:** `sm.scene3d.setAntiAliasing3D({ mode: 'fxaa' | 'off', quality: 'low' | 'medium' | 'high' })`, read
  `sm.scene3d.antiAliasing3D`. Global scene setting, saved with the doc, default FXAA medium.
- **Shadow quality:** `world.setShadowCascades({ cascades: 1 | 2 | 3, nearMetres })`, read `world.shadowCascades`.
  Scene level: `sm.scene3d.setShadowCascades3D({...})` / `sm.scene3d.shadowCascades3D`.
- **Ground contact (contact shadows):** `world.setGroundContact(on, strength?)`, read `world.groundContact`.
- **Key/fill contrast:** `world.setKeyFill(0..1)` / `world.keyFill`. **Aerial haze:** `world.setAerialHaze(0..1)` /
  `world.aerialHaze`; scene level `sm.scene3d.setAerialHaze3D(strength, reach, contrast, tint)`.
- New `CityLook` fields `keyFill`, `aerialHaze`; new post-process field `bloom.chromaGate`.
- Please verify in a real browser: FXAA edge quality on a HiDPI screen, shadow stability while walking in Play, and
  frame time at street level with 2 vs 3 cascades.

## Bug-hunt follow-ups (Salsa + Frogmarks, 2026-10-01)

Details: [bug-hunt-2026-10-01.md](../bug-hunt-2026-10-01.md), "FOLLOW-UP FIXES".

Frogmarks binding fixes (applied in Frogmarks; backups `*.bak` in the agent scratchpad):
- `armature-panel.component.ts` `globalLibPromotePose`: `sm.getSavedPoses3D` (never existed) → `sm.getPoses3D(sk.id)`,
  which returns `{ id, name, region? }[]`. "Promote pose to global" now uses the pose's own name instead of 'Pose'.
- `frog-file.service.ts` `getCelBlob`: removed the dead `sm.getCelPixelDataBlob` branch. `exportRasterLayerToBlob` was
  already the path that ran.
- `docs.component.ts` (Grease Pencil help text): `sm.getSkeleton3D(id)?.data.joints` → `sm.getSkeletonJoints3D(id)`
  (it returns the joint array directly), and `sm.scheduleRender3D()` → `sm.scheduleRender()`.

Engine behaviour changes the host should know about (no host code needed):
- **Save during Play is deferred.** `sm.saveDocument()` called while Play, UI preview or Player mode is active now
  resolves when that mode ends, with the save of the restored editor state. Several calls in one Play session share
  that one save. `raster-autosave.service` keeps showing "saving" until Stop. Before, it saved the in-game frame
  (walked-to player, hidden first-person body).
- **Save in City mode keeps the illustration's own look.** The saved scene lighting / fog / sky / SSAO / outlines /
  post stack are the pre-city ones. The city's look is still saved with the city.
- **Camera calls during Play.** `setCameraMode3D` / `setTarget3D` during Play are recorded (`onViewStateChanged`
  fires, so the toolbar stays in sync) and applied on Stop. `enterCityMode3D`, `enterMeshOrbit3D` and
  `enterGroupOrbit3D` stop Play first (`onPlayStateChanged` fires).
- Opening another document now resets the city look (time of day, grade, preset, placement, signal timing...) to the
  fresh-session defaults, so a new city no longer inherits the previous document's look.

Please verify in the browser:
- Press Ctrl+S during Play: the save indicator stays on "saving" until Stop, then the reloaded document shows the
  edit-time positions.
- Save while the City Tool is open, close the tool, reload: the illustration's own lighting comes back.

## Performance group: resolution scaling + LOD settings (Salsa, 2026-10-01)

Engine docs: `docs/ui/performance.md` §Resolution scaling and §LOD settings.

New engine APIs (all optional for a host):
- `sm.setResolutionScale3D({ mode: 'off' | 'fixed' | 'auto', scale, targetMs, minScale, maxScale })` /
  `sm.getResolutionScale3D()` (the setting + `current`, `gpuMs`, `timing`). Off by default; a per-machine viewport
  preference the engine keeps in localStorage, never in documents. Exports and thumbnails always render at native
  resolution.
- `sm.setCityLodSettings3D(patch)` / `sm.getCityLodSettings3D()` (settings + `familyList` with metres) /
  `sm.getCityLodStats3D()` (per-family shown / hidden counts and triangles + fps, GPU ms, triangles, draw calls,
  culled, LOD-hidden). Live (no regen), saved with the city only when changed.

Applied in Frogmarks (backups `*.perf.bak` in the agent scratchpad):
- The City Tool panel has a new collapsible **Performance** section (after Edge): live readout, resolution scaling
  (mode, scale, target fps, min scale, current scale), draw-distance multipliers (global + one per family, with the
  resulting metres), aerial bias, zoom-tier thresholds, near/far swap distances, shadow filter / cascades / slack, the
  LOD debug tint, a per-family stats list and **Reset to defaults**. Calls are `?.()`-guarded: the rows stay empty
  until the dist is rebuilt.

Please verify in the browser (after a dist rebuild):
- Performance → Mode Automatic at a full-screen window: walking the city holds ~60 fps and "Current scale" drops
  below 1; set Off and it returns to 1.00.
- Fixed 0.5: the 3D view is softer, but the gizmos, the grid, the panel text and the 2D layers stay sharp. Export a PNG:
  it is full resolution.
- Drag "Trees" to 0.3: far trees disappear sooner (the stats list shows more LOD-hidden). Turn on the LOD debug tint
  and fly around; turn it off and the colours come back exactly.
- Change a slider, save, reload: the setting is back. Reset to defaults, save, reload: the saved city has no `lod` field.

## Hard fog edge (2026-10-01) — BUILT in Frogmarks

- New engine API: `sm.setFogHardEdge3D(on)` / `sm.getFogHardEdge3D()` (see docs/ui/city-quality.md "Hard fog edge").
- Frogmarks: Global settings → Fog → **Hard edge** checkbox (`scene3dFogHardEdge`, `scene3dSetFogHardEdge`).
  Turning it on re-sends the panel's fog so it wins over the city's. Saved in the host scene settings
  (`fogHardEdge`, added to the settings type in illustration.service.ts); on restore it is applied BEFORE the fog.
- Needs a Salsa dist rebuild; until then the call is a no-op (cast + `?.()`).

## Fog horizon (2026-10-01) — BUILT in Frogmarks

- New engine API: `sm.setFogHorizon3D(patch)` / `sm.getFogHorizon3D()` (see docs/ui/city-quality.md "Fog horizon").
  Fields: `buildingsOnly` (false), `includeAttachments` (false), `fadeM` (15 m, 0 = pop), `fadeStyle`
  (`'dither'` | `'dither-coarse'`), `silhouetteOutlines` (true). Only active while Hard edge is on and the fog is linear.
- Frogmarks: Global settings → Fog, under Hard edge (only shown while it is on): Buildings only in fog, Include signs,
  awnings & rooftop equipment, Fade distance, Fade style, Silhouette outlines (`scene3dFogBuildingsOnly`,
  `scene3dFogIncludeAttachments`, `scene3dFogFadeM`, `scene3dFogFadeStyle`, `scene3dFogSilhouetteOutlines`,
  `scene3dApplyFogHorizon()`).
- Saved in the host scene settings as `fogHorizon` (type in illustration.service.ts), restored after the hard edge.
- Needs a Salsa dist rebuild; until then the calls are no-ops (cast + `?.()`).

Please verify in the browser (after a dist rebuild), in a city with Fog → Linear and Hard edge on:
- Buildings only in fog: past Far only flat building silhouettes remain; trees, cars, poles and people stop at the fog
  line. Include signs…: shop signs, awnings and rooftop units come back on the silhouettes.
- Fade distance 15–30 m: walking toward the fog line, props dissolve in and out with a dot pattern (no pop); their
  shadows fade with them. Fade style coarse: bigger dots. Fade 0: they pop at the line.
- Edge outlines on + Silhouette outlines off: no ink on the fog silhouettes; the clear zone keeps its outlines.
- Save, reload: the settings come back. Hard edge off: everything looks as before.

## Fog horizon follow-ups (2026-10-01) — BUILT in Frogmarks

- New engine API: `sm.setMeshNoFog3D(meshId, mode)` / `sm.getMeshNoFog3D(meshId)`, mode `false` (fogged), `true`
  (never fogged) or `'hardEdge'` (no fog only while Hard edge is on). It is `Material3D.noFog`, saved with the mesh.
- Frogmarks: 3D object material panel, under "True mirror": **No fog** select (Off / Always / Hard edge only)
  (`scene3dMeshNoFog`, `scene3dUpdateMeshNoFog()`), read back from the selected mesh's material.
- No other host changes. Characters now obey the fog horizon, the AO fades with dissolving objects, and the city's sky
  and clouds skip the fog under Hard edge; all of that is engine side.
- Needs a Salsa dist rebuild; until then the call is a no-op (cast + `?.()`).

Please verify in the browser (after a dist rebuild):
- City, Fog → Linear, Hard edge on, Far ~120 m, Painted clouds on: the clouds past Far are clouds, not fog-coloured
  blobs. Hard edge off: the clouds look as before.
- Select any object, No fog → Always: it ignores the fog at every distance. Hard edge only: it ignores the fog only
  while Hard edge is on. Save, reload: the setting comes back.
- With Buildings only in fog and a fade: characters past Far disappear and dissolve in the fade band, the Play player
  and the selected character never do.

## Streaming: the Tile radius window + Outside tiles (Salsa P10.D, 2026-10-01) — BUILT in Frogmarks

- Engine (no host code needed): with Stream to camera on in a Full tiled world, the Tile radius is the ACTIVE window
  of full tiles — 1×1 = 1, 3×3 = 9, 5×5 = 25 — centred on the tile directly below the camera eye (the player in Play),
  with a ~12 % hysteresis band at tile borders. The original centre city despawns when the window leaves it and is
  re-attached (not rebuilt) when you come back. See docs/ui/performance.md §Diorama vs tiled worlds.
- New engine API: `sm.world.setStreamOutsideTiles('none' | 'flat' | 'massing')` / `sm.world.streamOutsideTiles`
  (default `'flat'`; Flat switches to massing when zoomed far out). `getStreamStats()` gains `lite`, `flat`, `massing`,
  `previews`, `window` ('3×3'), `windowTiles`, `focusTile`, `centre` ('resident' | 'parked' | 'restoring'), `outside`,
  `eyeWindow`, `proxyCached`, `proxyCacheMB`; `full` is now the ACTUAL number of full tiles (it reported the constant 9).
  `sm.scene3d.getPlayerFeet3D()` returns the Play character's feet (null outside Play).
- Frogmarks (illustration.component.ts/.html, City panel → Layout): **Outside tiles** select under Stream to camera
  (Full detail only), `worldStreamOutside` + `worldSetStreamOutside()`; Tile radius tooltip; the stats line shows
  full N/window, flat, massing, lite and the centre state.

Please verify in the browser (after a dist rebuild):
- Tiled, Tile radius 1×1, Full, Stream to camera: the stats read "full 1/1" at any height; the full tile is the one
  under the camera. 3×3 → "full 9/9" around the camera (the centre city counts while you are over it).
- Fly away from the centre: the stats show "centre parked" and the centre reads as a flat tile; fly back: it returns.
- Outside tiles None / Flat / Massing changes the tiles beyond the window at once (no rebuild).

## Perf HUD: drawn vs scene triangles (Salsa P11 culling, 2026-10-01) — BUILT in Frogmarks

- Why: the 3D stats HUD showed `getRenderStats3D().triangles`, which is the whole SCENE (every loaded, visible-flagged
  mesh, before frustum culling / distance LOD / near-far twins). At street level it read 4.6 M (diorama) / 36 M (3×3
  tiled) whatever the view, while the colour pass really drew 0.9–1.7 M / 0.9–7.2 M. See performance-plan.md §P11.
- New engine fields (no breaking change; `triangles` still means the scene total):
  - `getRenderStats3D().drawn` and `.drawCalls`: `{ main, shadow, other, total, shadowThisFrame, passes: { main,
    skinned, farShadow, cascades, outline, prepass, planar, overlays } }`; `sceneTriangles`; `culling: { meshesCulled,
    groupsCulled, lodHidden, fogHidden, trisCulledMain }`. Shadow maps are cached / throttled, so `shadow` is each
    map's last refresh and `shadowThisFrame` the literal per-frame number.
  - `getCityLodStats3D().frame`: `trisMain`, `trisShadow`, `trisOther`, `drawsMain`, `drawsShadow`, `drawsOther`
    (`trisDrawn` still mixes every pass).
  - `Renderer3D.getFrameStats3D()`: `pass*` counters per pass, `occl*`, `range*`.
- Frogmarks (illustration.component.html / .ts):
  - The stats HUD headline is `drawn.main` ("tris drawn"), with a "shadow · other passes · draws" line and "in scene N
    tris". Without `drawn` (old dist) it falls back to the old line.
  - The City → Performance line shows "tris drawn · shadow" from `trisMain` / `trisShadow`, falling back to `trisDrawn`.
- Please verify in the browser (after a dist rebuild): in Play at street level the headline drops sharply when you look
  at the ground (frustum + range culling) while "in scene" stays put. Facing a wall it drops only a little: the view
  still reaches through the wall to the far plane, and hiding what is BEHIND walls is the occlusion cull, which is off
  by default (`sm.renderer3D.constructor.occlusionCulling = true` to try it).

## Simulation LOD (Salsa engine-roadmap step 1, performance-plan §P13, 2026-10-01) — BUILT in Frogmarks

Engine docs: `docs/ui/performance.md` §Simulation LOD.

- New engine APIs (optional for a host):
  - `sm.setSimLod3D(patch)` / `sm.getSimLod3D()`: `{ enabled, nearM, midM, midHz, farHz, offscreenHz, fogFreeze,
    hysteresis }`. Also reachable as `sm.setCityLodSettings3D({ sim })`; `getCityLodSettings3D().sim` reads it back.
    Saved with the city LOD settings (non-default fields only; a city that never touched it saves byte-identical).
  - `sm.getSimLodStats3D()`: `{ enabled, settings, total, systems: { walkers, cars, trains, otherMovers, liveCrowd,
    characters, springs }, fogSkippedCellBuilds }`, each system `{ near, mid, far, offscreen, frozen, updates, skipped,
    totalUpdates, totalSkipped }` for its last frame.
  - Console: `salsaWorld.simLod()` (stats), `salsaWorld.simLod(false)` (the A/B switch), `salsaWorld.simLod({ nearM: 60 })`.
- Applied in Frogmarks (illustration.component.html / .ts; backups `illustration.component.*.simlod.bak` in the agent
  scratchpad): the City → Performance section has a **Simulation** group above Debug: Simulation LOD on/off, Every frame
  (m), Mid range (m), Mid rate (Hz), Far rate (Hz), Off-screen rate (Hz), Freeze in fog, and a live line "near · mid ·
  far · off-screen · frozen · updated / skipped" from `getSimLodStats3D()` (polled with the existing 500 ms perf poll,
  only while the section is open). Calls are `?.()`-guarded (`perfSetSim` falls back to `setCityLodSettings3D({ sim })`).
- Please verify in the browser (after a dist rebuild):
  - Play in a diorama city: walkers and cars near the player move exactly as before; the line shows most movers far /
    off-screen and "skipped" well above "updated".
  - Turn Simulation LOD off: the line reads "off"; on again: no walker jumps.
  - Hard edge + Buildings only in fog, Far ~80 m: walk toward the fog line; people and cars come out of the fog where
    they should be (no pop, no teleport), and "frozen" counts the movers past the fog.
  - Change a slider, save, reload: it is back; Reset to defaults restores 40 m / 120 m / 10 / 2 / 2 Hz.

## Step 2: Angular off the per-frame path (Salsa engine-roadmap step 2, performance-plan §P13 "Step 2", 2026-10-01) — BUILT in Frogmarks

Engine docs: `docs/ui/performance.md` §Editor overhead and structure-change hitches, §Resolution scaling (camera-motion
drop).

- Engine side (no host wiring needed): the editor's per-frame 2D scans, the host renderer's node scans and the
  structure-change hitches are gone (tiled Play p95 frame 47 → 22 ms). A/B and stats: `sm.setFrameScanOptions3D(patch)`,
  `sm.getFrameScanOptions3D()`, `sm.getFrameScanStats3D()`. `getRenderStats3D()` returns the same values, cheaper.
- New resolution fields: `sm.setResolutionScale3D({ motion: 'auto' | 'always' | 'editor' | 'off', motionScale })`.
  Default `'auto'`: the 0.78 camera-motion drop applies to editor camera moves as before, and in Play only while the GPU
  frame is over budget (it used to stay on for the whole Play session in a streamed world). Optional host UI: a
  "While the camera moves" select next to the resolution mode in City → Performance (not added yet).
- Applied in Frogmarks (illustration.component.ts / .html; backups in the agent scratchpad `fm-backup-step2/`):
  - The 3D canvas `(pointermove)` template binding is removed. `_canvasPointerMoveOutsideZone` is registered with
    `ngZone.runOutsideAngular` (next to the document mousemove listener) and removed in `ngOnDestroy`. It calls the
    unchanged `scene3dCanvasPointerMove` and enters the zone only when that replaced `scene3dRibbonControlPoints` (a
    ribbon-handle drag) or while a mouse button is held outside Play (drags: engine callbacks such as viewport-changed
    → the artboard overlay update bound fields without entering the zone, and relied on this change detection).
    The landmark hover and the knife preview draw engine-side / on the handle canvas: no bound state.
  - Stats HUD (250 ms), Performance group (500 ms) and stream stats (500 ms) polls run outside the zone. The HUD enters
    the zone only when a shown value changed (`_scene3dStatsSig`, at the template's rounding); the perf and stream
    polls keep their bodies (`_perfPollTick`, `_streamStatsTick`) and trigger one change detection only when the
    displayed fields changed (`_perfSig`, `worldStreamStats`).
  - Measured on the Angular dev server: mouse-move storm 17.7 → 0 ms/s of change detection.
- Please verify in the browser (after a Salsa dist rebuild):
  - Hover over the 3D canvas with the World panel open: the landmark card still follows the mouse.
  - Drag a ribbon handle: the point list in the panel updates while dragging.
  - Pan / orbit with the mouse in an illustration: the artboard shadow and label follow during the drag.
  - Knife tool in mesh edit: the preview line follows the mouse.
  - Stats HUD on: the figures update (fps, drawn, draws); Performance group and stream stats lines update.

## Shadow quality presets + shadow caching (Salsa engine-roadmap step 7, performance-plan §P14, 2026-10-02) — BUILT in Frogmarks

Engine docs: `docs/ui/performance.md` §Shadows: caching and quality presets.

- Engine side (no host wiring needed): the far shadow map submits only the parts of each caster inside its box, the near
  cascades keep a cached static layer (only movers and characters redraw each frame), streamed tiles join the cached
  layers in batches, and the shadow maps follow the sun in 0.15° steps. Shadows look the same (frozen-clock A/B: 0
  differing pixels). A/B + counters: `sm.setShadowCacheOptions3D(patch)`, `sm.getShadowCacheStats3D()`.
- New API: shadow quality presets `'low' | 'medium' | 'high' | 'ultra'` ('high' = the current defaults):
  `sm.setCityLodSettings3D({ shadow: { quality } })` in City mode (saved with the city LOD settings;
  `getCityLodSettings3D().shadow.qualityShown` = the preset or `'custom'`), and `sm.setShadowQualityPreset3D(q)` /
  `sm.getShadowQualityPreset3D()` anywhere (outside a city it writes the scene's own shadow map size + cascades + filter).
- Applied in Frogmarks (backups in the agent scratchpad `frogmarks-backup/`):
  - City → Performance → Shadows: a **Shadow quality** select (Low / Medium / High / Ultra; a disabled Custom entry shows
    when the filter or cascades were changed by hand) above Shadow filter. `perfShadowQuality`,
    `perfSetShadowQuality(q)` → `perfSetLod({ shadow: { quality } })`; `_perfApplyView` reads
    `v.shadow.qualityShown`, and the Cascades / Shadow filter selects follow through the same view.
  - 3D Global settings → Shadows: a **Quality** select (same options, Custom by default) above Map Size.
    `scene3dShadowQuality`, `scene3dSetShadowQuality(q)` → `setShadowQualityPreset3D?.(q)`, then `scene3dShadowMapSize`
    is re-read from `scene3d.shadowMapSize3D`. A hand change of Map Size / Extent / Bias / Strength re-reads the shown
    preset (`getShadowQualityPreset3D?.()`). Saved in the host's 3D global settings as `shadowQuality`
    (illustration.service.ts type gains `shadowQuality?: string`) and re-applied on load after the shadows are enabled.
  - All calls `?.()`-guarded.
- Please verify in the browser (after a Salsa dist rebuild):
  - City → Performance → Shadow quality Low: Cascades drops to 1 and Shadow filter to Fast; High puts 2 / Soft back;
    changing Cascades by hand shows Custom.
  - Global settings → Shadows → Quality Ultra: Map Size reads 4096; save, reload: still Ultra.
  - Play in a city: walk and turn; the player's and the walkers' shadows follow as before.

## Step 3: lighter tiles, no hitches + scene budgets (Salsa engine-roadmap step 3, performance-plan §P13 "Step 3", 2026-10-02) — BUILT in Frogmarks

Engine docs: `docs/ui/performance.md` §Lighter tiles and no hitches, §Scene budgets.

- Engine side (no host wiring needed): the City bounds walk after a streamed tile settles is incremental + sliced (was up
  to 132 ms in one task); Play collision rays walk per-cell merged BVHs built in a worker (rays 1.4 → ~0.4 ms a frame,
  same hits); geometry uploads are capped at 4 MB a frame (big ones in slices, nearest-in-view first); the instanced
  crowd's near / mid cells build in a worker; road paint / wear / gutters / storefronts are culled past the fog
  horizon's Far; the apron / void grid / border glow follow the tile window; re-attached tiles take the current night
  glow / style. A/B: `sm.setStep3Options3D(patch)` / `sm.getStep3Options3D()`; stats `sm.getStep3Stats3D()`,
  `sm.getCollisionStats3D()`.
- New API: `sm.getSceneBudget3D()` → `{ drawnTris, drawCalls, geometryMB, instances, meshes, mainTris, shadowTris,
  limits, over: [{ key, value, limit, ratio }], ok, warning }` (`warning` = one line, e.g. "Over budget: 6.1 M tris
  (3.0 M tris), 3.4 k draws (2.0 k draws)", or null). `sm.setSceneBudget3D({ drawnTris, drawCalls, geometryMB,
  instances })` (0 = no limit; null = defaults 3 M / 2 k / 500 MB / 200 k). Session setting, never saved.
- Applied in Frogmarks (illustration.component.ts / .html / .scss; backups in the agent scratchpad `fm-backup-step3/`):
  - Stats HUD: an amber **⚠ Over budget …** line (`scene3dBudgetWarning`, `.scene3d-stats-warn`) above the GPU name. The
    250 ms poll (outside the zone) reads `getSceneBudget3D?.()?.warning` with the stats and enters the zone only when
    the stats signature or the warning changed.
  - City → Performance readout: a third line `perfBudgetLine` — the warning (amber, `.perf-budget-over`) or "Within
    budget · drawn / limit tris · draws / limit · MB / limit MB" — from the same 500 ms poll (`_perfPollTick`, part of
    `_perfSig`).
  - All calls `?.()`-guarded (an older dist shows no line).
- Please verify in the browser (after a Salsa dist rebuild):
  - Stats HUD on in a tiled 3×3 street view: the amber line appears (tiled street views draw > 3 M triangles); in an
    empty scene it is absent.
  - City → Performance open: the third readout line updates; `sm.setSceneBudget3D({ drawnTris: 0, drawCalls: 0,
    geometryMB: 0, instances: 0 })` in the console turns it into "Within budget".

## GPU culling mode: Auto / On / Off (Salsa engine-roadmap step 4, performance-plan §P15, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/performance.md` §GPU-driven rendering (§GPU culling mode).

- New API: `sm.setGpuCullingMode3D(mode)` (`'auto'` default / `'on'` / `'off'`; stored per machine in localStorage, never
  in documents) and `sm.getGpuCullingMode3D()` → `{ mode, active, reason, reasonText, warm, ready, timer, auto, subBundles }`.
  `reasonText` is display-ready: CPU-bound, GPU-bound, headroom, holding, measuring, no GPU timer, set to On / Off,
  GPU path unavailable.
- Applied in Frogmarks (backups in the agent scratchpad `fm-backup-gdauto/`):
  - City → Performance: a **GPU culling** group under Resolution scaling. Select (`perfGpuCull`, options from the static
    `WorldPanelComponent.GPU_CULL_OPTIONS`), the chosen option's description (`perfGpuCullDesc`), and the live line
    `perfGpuCullLine` = "Active: GPU · reason: CPU-bound", refreshed by the existing outside-zone poll. Reset to
    defaults sets Auto.
  - Global → Rendering: the same select (`scene3dGpuCull`), read from the engine when the section opens.
  - Option texts: **Auto (recommended)**: picks the faster path from moment to moment: GPU culling while the CPU is the
    bottleneck (big scenes, Play, window-sized views), the classic path while the GPU is the bottleneck (full-screen
    views of big tiled worlds); switching is seamless, at most every 1.5 s. **On**: the GPU decides what to draw; frees
    the CPU (about a third of the main-thread render time in a city); can cost a little GPU time in very large tiled
    worlds. **Off**: the classic CPU path.
- Please verify in the browser (after a Salsa dist rebuild): open City → Performance in a tiled 3×3 world; the live line
  shows "Active: GPU"; at full screen it may switch to "Active: CPU · reason: GPU-bound" within ~2 s; choosing Off shows
  "Active: CPU · reason: set to Off"; reload the page: the choice is kept.

## Graphic look toggle + visual-polish quick wins (Salsa visual-polish-next, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/city-quality.md` §Visual polish quick wins (2026-10-03).

- Engine API: the **Graphic** scene preset (`world.applyScenePreset('graphic')`, listed by `world.scenePresets`) and
  `world.setGraphicLook(on)` / `world.graphicLook` (the toon look over the current preset; off = that preset plain;
  with no preset active it uses Golden Hour).
- Applied in Frogmarks (backups in the agent scratchpad `frogmarks-backup-polish2/`):
  - City → Presets: the **Graphic** button appears automatically (the preset list is read from the engine and cached).
  - City → Presets: a **Graphic look** checkbox under the preset buttons (`worldGraphicLook`, `worldSetGraphicLook`;
    tooltip "Persona-style toon look over the current preset..."). It follows preset clicks and document loads.
- Not exposed (engine only, no panel needed): `CityLook.windowGlow` (set by the Phantom Night pack) and
  `LayoutParams.adScreens` (on for new cities; old saved cities keep the old screens).
- Please verify in the browser (after a Salsa dist rebuild): open a city, click **Graphic** (ink outlines + cel look
  at golden hour); tick / untick **Graphic look** on Night (toon night / plain night); save, reload: the checkbox state
  comes back.

## GPU device-lost recovery banner + "waiting for Play" toast (Salsa device recovery, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/device-recovery.md`.

- Engine API: `sm.getDeviceStatus()` / `sm.onDeviceStatusChange(fn)` (`status`: ok / lost / recovering / failed /
  unavailable, `unrecovered`: what the last recovery could not bring back), `sm.recoverDevice()`,
  `sm.simulateDeviceLoss()` (test), `sm.onPersistDeferred(fn)` (`{ kind: 'save' | 'export', reason: 'play' |
  'ui-preview' | 'player' | 'device-lost' }`, once per waiting request).
- Applied in Frogmarks (illustration.component.ts / .html / .scss; backups in the agent scratchpad
  `frogmarks-backup-devrec/`):
  - a top-centre banner: **"Graphics device was reset — recovering…"** (spinner) → **"Recovered."** for 2.5 s (8 s
    with Dismiss when something was not restored, listed after "Not restored:") → or **"Couldn't recover the graphics
    device — reload."** with a **Reload** button;
  - a toast when a save / export has to wait: **"Export will finish when you stop Play"** (and the UI preview / Player
    mode / device-recovery variants).
- Not changed: the engine's own full-canvas "couldn't recover" overlay still shows too (`WebGPURenderer.showDeviceOverlays`).
- Please verify in the browser (after a Salsa dist rebuild): call `simulateDeviceLoss()` on the ShapeManager from the console — the banner
  shows "recovering…" then "Recovered." and the scene comes back; start Play, click Export: the toast shows, and the
  file downloads after Stop.

## HLOD distant buildings + Skyline distance (Salsa engine-roadmap step 5, performance-plan §P17, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/performance.md` "HLOD (distant buildings)".

- Engine: Outside tiles `'hlod'` (`world.setStreamOutsideTiles('hlod')`) streams merged distant buildings beyond the
  active window, out to the Skyline distance (`world.setStreamHlod({ skylineTiles })`, default 10 tiles; also
  `midTiles`, `maxTiles`, `fade`, `fadeMs`; `world.streamHlod` reads them back). It is now the **default** outside tier
  (`WorldManager.DEFAULT_OUTSIDE_TILES`); ortho / 2D views keep Flat / Massing.
- Applied in Frogmarks (world-panel.component.ts / .html; backups in the agent scratchpad `fm-backup-hlod/`):
  - City → Layout → Outside tiles: **HLOD (distant buildings)** (first option, the panel default now);
  - **Skyline distance** slider (2-24 tiles), shown while HLOD is selected;
  - the stream stats line adds "HLOD n mid / n far".
- Please verify in the browser (after a Salsa dist rebuild): a Full tiled world with Stream to camera: the skyline runs
  to the horizon; Skyline distance 4 → 16 grows it live; switching to Flat brings the flat map back.

## Anti-aliasing / Upscaling: TAA + TAAU (Salsa engine-roadmap step 6, performance-plan §P18, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/performance.md` "Temporal anti-aliasing and upscaling".

- Engine: `sm.setTemporalAA3D({ mode: "off" | "taa" | "taau", scale, sharpen, retroOff, inkOff })` / `sm.getTemporalAA3D()`.
  TAA replaces FXAA at native resolution; TAAU renders the 3D scene at 65 % (or the Resolution scaling scale) and
  reconstructs full size. A per-machine preference kept by the engine (localStorage), never in documents. Default Off.
- Applied in Frogmarks (backups in the agent scratchpad `fm-backup-taa/`):
  - City → Performance → Resolution scaling: an **Anti-aliasing / Upscaling** select + description (world-panel.component.ts
    / .html: `perfTaa`, `perfSetTaa()`, `_perfReadTaa()`; Reset to defaults sets it Off);
  - Global → Rendering: the same select (scene-render-settings.component.html, scene3d-settings.service.ts
    `TEMPORAL_AA_OPTIONS`, `scene3dSetTaa()` / `scene3dSyncTaa()`).
  - Calls are guarded `(this.shapeManager as any).setTemporalAA3D?.(...)`; `npx tsc -p tsconfig.app.json --noEmit` clean.
- Please verify in the browser (after a Salsa dist rebuild): TAA smooths wires / pole edges; TAAU lowers the GPU ms in
  the Performance readout and stays sharp; the retro / PS1 looks show "Off for this look".

## Night light spill, wet streets, player light, ink on foliage (Salsa visual-polish-next #5 / #7c / #3, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/city-quality.md` §Night streets, player light, ink on foliage (2026-10-03).

- Engine API (world manager, `CityLook` fields, all opt-in: absent = off): `setNightSpill(0..1.5)` / `nightSpill`,
  `setWetSheen(0..1)` / `wetSheen`, `setPlayerLight(0..2)` / `playerLight`; `setCityOutlines({ ..., foliage:
  'full' | 'silhouette' | 'off', creaseFade: { near, far, minAlpha } })` (metres). Scene presets turn on the spill and
  the player light (night-gated); Night / Rainy Evening add the wet sheen; Graphic + Phantom Night ink foliage as a
  silhouette with a crease fade.
- Applied in Frogmarks (backups in the agent scratchpad `pupdrive/night/fm-backup/`), City panel → Look → Rendering:
  **Night light spill**, **Wet streets** and **Player light** sliders (`worldSetLookValue('setNightSpill' | 'setWetSheen'
  | 'setPlayerLight', ...)`), and **Ink on foliage** (Every leaf / Outline only / None, shown while Edge outlines is on;
  `worldSetInkFoliage()`, kept by `worldSetOutlines`). All read back in `_syncCityLookFromEngine`. Calls guarded;
  `npx tsc -p tsconfig.app.json --noEmit` clean.
- Please verify in the browser (after a Salsa dist rebuild): Night street: warm light in front of shops, coloured light
  under signs, warm soft lamp pools; Rainy Evening: sign reflections on the road; Play at night: the player stays lit;
  Graphic: one ink line round each tree, none between its leaves.

## Sky dome (visual-polish #9, 2026-10-03) — applied in Frogmarks

`world.setSkyDome({ stars?, moon?, cityGlow?, cityGlowColor?, moonAzimuthDeg?, moonElevationDeg?, clouds?: 'anime' | 'cards' } | null)`
/ `world.skyDome`. City → Look, under **Painted clouds**: a **Sky dome** checkbox, then Cloud style (Anime / Soft cards),
Stars, Moon, City glow sliders and a Glow colour picker. Synced back from the engine on panel open / preset apply.
Details: [city-quality.md](city-quality.md) §Sky dome.

## Face kit: brows, mouth, nose, hair shadow, blush + expressions (Salsa visual-polish-next #2, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/character-creator.md` §2.5b "Face kit".

- Engine API: `sm.getDefaultFaceFeatures3D()`, `sm.setFaceFeatures3D(bodyId, patch)` (live, persists; the first call turns the
  kit on for a face saved before it; `{ enabled: false }` hides it), `sm.getFaceFeatures3D(bodyId)` (null = off),
  `sm.getFaceFeatureOptions3D()` ({ browStyles, noseStyles, expressions }), `sm.setCharacterExpression3D(bodyId,
  'neutral' | 'smile' | 'open' | 'frown' | 'surprised' | 'default' | weights, { blendMs, weight, holdMs })`,
  `sm.getCharacterExpression3D(bodyId)`, `sm.pulseCharacterBrows3D(bodyId, amount)`. New random characters get the kit
  (`randomCharacterParams3D(...).face`); `createFullCharacter3D({ face })` (omit = defaults, false = eyes only). New eye
  param `lidShadow` (0..1). Old saved characters load unchanged (kit off).
- Applied in Frogmarks (backups in the agent scratchpad `pupdrive/face/backup/`), character-panel.component.html / .ts:
  a new **Face** menu button + section: Face kit checkbox; Expression preview buttons + **Resting** ("Use preview");
  Brows (style, thickness, length, height, tilt, follow hair colour / picker, over hair); Mouth (width, line, position);
  Nose (style, size); Shading (blush + colour + lines, cheeks, hair shadow + depth, eye shading, eyes over hair); Life
  (brow raise on blink, idle smiles). Eyes → Proc → Shape gained a **Lid shadow** slider. Option arrays cached for
  `*ngFor`; calls guarded `(this.shapeManager as any).fn?.()`; slider pushes throttled to one per frame;
  `npx tsc -p tsconfig.app.json --noEmit` clean.
- Please verify in the browser (after a Salsa dist rebuild): Generate a character → Face shows the kit on; the expression
  buttons blend the face; an old saved character shows the kit off until the checkbox is ticked.

## Persona face shading + character defaults (Salsa visual-polish-next #10, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/character-shading.md` "Anime face shading · matte · hair band · Play outlines"; random defaults in
`docs/ui/character-creator.md` "Random character".

- Engine: **anime face normals** (`BodyParams.faceNormals` 0..1 via `sm.setBodyParams3D(bodyId, { faceNormals })` — the Cel HD
  facet wedges across the nose / cheeks are gone; works in every style); **matte skin + cloth** (`sm.setCharacterMatte3D(bodyId,
  on)` / `getCharacterMatte3D`; `createFullCharacter3D({ matte })`); **hair highlight band** (`HairParams.sheenBand`, Cel / Cel HD);
  **outlines in Play** (`sm.setPlayCharacterOutlines3D(on)` / `getPlayCharacterOutlines3D()`, scene-wide, runtime-only, persists).
  New random characters get all four, plus a bang hairline kept above the eyes and no under-eye dots (the white "°°°" cheek
  specks). Saved characters / documents load exactly as they were (fields absent = the classic look).
- Applied in Frogmarks (backups in the agent scratchpad `pupdrive/face2/fm-backup/`), character-panel.component.html / .ts:
  shading section (after Rim light) gained an **Anime face** slider (0–1, writes `scene3dBodyParams.faceNormals` →
  `scene3dBodyParamChanged()`), a **Matte skin + cloth** checkbox and an **Outline in Play** checkbox (scene-wide); Hair →
  Render gained a **Highlight band** checkbox (`scene3dHairParams.sheenBand`). State read back in `_syncToonAndRim`. Calls guarded
  `(this.shapeManager as any).fn?.()`; no new `*ngFor`; `npx tsc -p tsconfig.app.json --noEmit` clean.
- Please verify in the browser (after a Salsa dist rebuild): Generate a character in Cel HD → a clean flat face, matte clothes, a
  light band on the hair; Anime face 0 brings back the faceted head; an old saved character shows Anime face 0 and Matte off;
  Play draws a thin ink outline round the characters and Stop removes it.

## Jump variety + motion looseness (Salsa animation feel, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/play-mode.md` §"Jump variety + a looser walk / run".

- **Engine (no wiring needed):**
  - The default Play jumps are a family: classic, tuck, reach, swing (layup) L/R, stride L/R and hop. One is picked per
    jump: seeded per character, never the same twice running, weighted by stand / walk / run and tap / hold.
  - The default walk / run got secondary motion: pelvis tilt and hip drop, a torso sway, a late head counter, the
    forearm and hand trailing the arm, the shoulders riding with the arms.
  - Also new: a stroll below the walk speed, a settle step on stops, a per-character walking personality, and an
    upper-body follow-through spring.
  - Authored clips / locomotion sets are unchanged. A set can opt in with `jumps: [...]`
    (`sm.setPlayerLocomotionSet3D({ ..., jumps })`).
- **API:**
  - `sm.setPlayJumpVariety3D(on)` / `getPlayJumpVariety3D()` (default on);
  - `sm.setPlayMotionLooseness3D(0..1 | null)` / `getPlayMotionLooseness3D()` (default 0.5; 0 = the clips exactly).
  - Both persist in `globalScene.play` only when not the default, and are live while playing.
  - `getPlayerAnimationState3D()` adds `jumpClip`, `jumpCount`, `strollMix`.
- **Applied in Frogmarks** (backups in the agent scratchpad `pupdrive/anim2/backup/fm__*`): in
  `scene-view-bar.component.html` / `.ts`, the Play settings popover gained, above "Auto default character":
  - a **Jump variety** checkbox;
  - a **Motion looseness** slider (0–1, step 0.05).
  State is read back in `_syncPlaySettings`. Calls are guarded `(this.shapeManager as any).fn?.()`, and each change
  emits `dirty`. `npx tsc -p tsconfig.app.json --noEmit` is clean.
- **Please verify in the browser** (after a Salsa dist rebuild):
  - Play, then jump a few times standing, walking and running: the jumps differ. A quick tap gives a small hop.
  - With Jump variety unticked, every jump is the classic.
  - Motion looseness at 0 vs 1 changes how much the upper body swings on a stop.

## Natural walk / run + "Walk style: Natural / Stomp" (Salsa gait pass, 2026-10-03) — BUILT in Frogmarks

Engine docs: `docs/ui/play-mode.md` §"Natural walk / run + the Stomp walk style".

- **Engine (no wiring needed):** the runtime default `Walk`, `Run` and `Stroll` clips were rebuilt.
  - Walk: heel-to-toe roll; the pelvis is a smooth wave, highest at mid-stance, fitted so the landing foot glides onto
    its heel (it used to hang about 4 cm up and drop: the "stomp"); the swing knee folds to about 60°; the feet land
    apart.
  - Run: a shorter stride at a higher cadence, the foot landing nearer under the body, a flight phase, a heel kick and
    knee drive, and a whole-body lean.
  - Authored clips, library entries and locomotion sets are unchanged.
- **The old walk is kept as the runtime clip `Stomp`** (for custom use, e.g. wading through swamp water).
- **API:**
  - `sm.setPlayWalkStyle3D('natural' | 'stomp')` / `getPlayWalkStyle3D()`. Default `'natural'`. It swaps only the
    runtime default Walk, is live while playing, and persists as `globalScene.play.walkStyle` only when `'stomp'`.
  - Per avatar: `sm.setPlayerLocomotionSet3D({ idle: 'Stand', walk: 'Stomp', run: 'Run' })`. A runtime default clip
    name the rig lacks is generated for it.
- **Applied in Frogmarks** (backups in the agent scratchpad `pupdrive/anim3/backup/`): the Play settings popover in
  `scene-view-bar.component.html` / `.ts` gained a **Walk style** select (Natural / Stomp) under "Motion looseness".
  - State is read back in `_syncPlaySettings`.
  - Calls are guarded `(this.shapeManager as any).fn?.()`, and a change emits `dirty`.
  - `npx tsc -p tsconfig.app.json --noEmit` is clean.
- **Please verify in the browser** (after a Salsa dist rebuild):
  - Play and walk: the steps should read light, heel to toe, with no foot dropping onto the ground.
  - Shift: the run should have both feet off the ground between steps.
  - Set Walk style to Stomp: the heavy tread comes back. Save and reload: the setting is kept.


## 2026-10-04 — Persona UI kit: HUD, menus, transitions (Salsa visual-polish-next #15) — BUILT in Frogmarks

Engine docs: `docs/ui/persona-ui-kit.md` (Salsa) and `docs/specs/ui-system.md` §"UI kit".

- **Engine:** screen-space kit widgets stored on a UI layer (`UILayerData.kit`, optional, so old documents load
  unchanged). They are laid out in a 1920x1080 design space by anchor, drawn by one instanced SDF / pattern shader on
  the final swapchain image (full resolution, unaffected by TAAU, resolution scaling, bloom and grading), and saved
  with the document like the rest of the UI layer.
- **Pieces (15 kinds, 21 presets):** slanted / torn panels, card, screen tone, heading, ransom letters, HP/SP bar,
  status panel, date / weather corner, mini-map frame, button prompt, menu list, splash text, damage number,
  location banner and call-out.
- **Transitions** (usable on any transition's Animation): `slash`, `shatter`, `stripeBurst`, `panelSlide` and
  `zoomPunch`. A covering transition keeps the old state's kit widgets on screen until the screen is covered.
- **Widgets act like shapes:** a widget id works in state shape visibility, show/hide actions, interactions and
  `playAnimation` (clips `intro | slide | pop | punch | drop | spin | shake | wobble | pulse`).
  - Menu items fire `click` triggers with targetId `<menuId>#<slug>` (e.g. `kit-1a2b3c4d#resume`).
  - Arrow keys, W/S, the d-pad, Enter and A drive a shown menu. `selectedVar` binds the selection to a variable.
- **API:**
  - `sm.listUIKitPresets()`, `sm.getUIKitSchema()` (property specs per kind for generic controls).
  - `sm.insertUIKitPreset(id, layerId?)`, `sm.insertUIKitDemo('hud' | 'pause')`.
  - `sm.getUIKitWidgets(layerId?)`, `sm.getUIKitWidget(id)`, `sm.updateUIKitWidget(id, patch)`,
    `sm.removeUIKitWidget(id)`, `sm.addUIKitWidget(kind, layerId?)`.
  - `sm.playUIKitClip(id, clip)`, `sm.previewUIKitTransition(type, ms?)`.
  - `sm.uiKitMenuMove(delta)`, `sm.uiKitMenuActivate()`, `sm.setUIKitClock(ms | null)` (frame capture).
- **Applied in Frogmarks** (backups: agent scratchpad `pupdrive/uikit/fm-backup/`): `ui-system-panel.component`
  `.ts` / `.html` / `.scss`.
  - A **Persona kit** section at the bottom of the UI panel (shown even before any UI layer exists):
    - **+ Persona HUD** and **+ Pause menu** demo buttons;
    - a preset select with **Insert**;
    - a transition select with **▶ Preview**;
    - the layer's piece list;
    - a property editor for the selected piece: name, anchor, x / y, scale, rotation, z, opacity, intro, play-clip,
      states, then every schema property (number / bool / select / colour token or custom colour / text);
    - **Delete piece**.
  - The transition **Animation** select gained a "Persona kit" option group.
  - Every call is guarded `(this.shapeManager as any).fn?.()`, and every `*ngFor` array is cached.
  - `npx tsc -p tsconfig.app.json --noEmit` is clean.
- **Please verify in the browser** (after a Salsa dist rebuild):
  - Click **+ Persona HUD**, then **+ Pause menu**, then **▶ Preview** in the UI panel.
  - Escape opens the pause menu with the stripe burst. The arrows move the highlight (it snaps and wobbles). Enter on
    RESUME closes it with the slash. F plays the splash.
  - Edit a piece's properties: the canvas updates live. Save and reload: the pieces and their edits are kept.

## 2026-10-04: Hair styles, big anime locks + style picker (Salsa hair-styles.md B–E) — BUILT in Frogmarks

- **Engine:** new `hairMode: 'locks'` (`src/services/managers/hair-locks.ts`): big shaped locks + a clean fringe, 8 presets
  (bob, long straight, side-swept, ponytail, twintails, short messy, bun, hime). (Status 2026-10-04: these 8 are in the 03:20
  dist → browser check only; 7 more styles (part 2, below) make 15 and need a dist rebuild.) Saved card / chunky hair is unchanged.
  New random characters (`randomCharacterParams3D` / `createRandomCharacter3D`) pick a style. Guide:
  [character-creator.md](./character-creator.md) §2.6 "Hair styles".
- **API:** `sm.getHairStyles3D()`, `sm.getHairStylePreset3D(name, lockSeed?)`, `sm.applyHairStyle3D(bodyId, name, keepColors = true)`.
- **Applied in Frogmarks** (backups: agent scratchpad `pupdrive/hair/backup/frogmarks/`):
  - `character-panel.component.ts` / `.html`, Edit Character → Hair:
    - a **Style** picker (presets) + **Vary** (re-roll the per-lock variation) at the top;
    - in Styled mode: **Fringe** (shape, height, locks, side), **Length + locks** (back, sides, lock count, width,
      thickness, volume, tips, flick, messiness, layers, ahoge), **Tails + bun** (tails, gathered, tail locks);
    - the Mode row gained **Styled** (Chunky / Cards unchanged); **Generate Hair** on a bald body now starts from a style.
  - `utils/character-randomizer.ts`: the Generate character button picks a random style (keeps its colour draws).
  - Every call is guarded `(this.shapeManager as any).fn?.()`; the `*ngFor` lists are cached;
    `npx tsc -p tsconfig.app.json --noEmit` is clean.
- **Please verify in the browser** (after a Salsa dist rebuild):
  - Generate a character: anime hair.
  - Hair → Style → each preset; Vary.
  - Drag Fringe height below about 0.15: the eyes hide (eyesThroughHair off).
  - Save + reload a document with OLD card hair: unchanged.

## 2026-10-04: District palette, roof variety, crowd + traffic density, mover shadows (Salsa visual-polish-next #11 / #16) — BUILT in Frogmarks

- **Engine (Salsa):** the city reads less like one tan / grey mass from above, the streets are busier, and moving
  people / cars / trains / the Play character sit on soft contact blobs. Guide: [city-quality.md](./city-quality.md)
  §District palette, roof variety, mover shadows, density.
- **API (`shapeManager.world`):**
  - `setDistrictPalette(on)` / `districtPalette`, `setRoofVariety(on)` / `roofVariety` (rebuild the buildings);
  - `setCrowdDensity(v)` / `crowdDensity` (the `pedestrianDensity` param, 0.1–20), `setTrafficDensity(v)` / `trafficDensity` (0–3);
  - `setMoverShadows(on, strength?)` / `moverShadows` → `{ on, strength }`, `moverShadowStats()`.
- **Applied in Frogmarks** (backups: agent scratchpad `pupdrive/life/backup/`): `world-panel.component.ts` / `.html`,
  in the city look section after Player light:
  - **District palette** and **Roof variety** checkboxes;
  - **Crowd density** (0.2–4×, shares its value with the layout section's Pedestrian density) and **Traffic density** (0–3×) sliders;
  - **Mover shadows** checkbox + **Strength** slider.
  - Synced from the engine in `_syncCityLookFromEngine`; every call guarded `(this.shapeManager.world as any)?.fn?.()`;
    `npx tsc -p tsconfig.app.json --noEmit` is clean.
- **Please verify in the browser** (after a Salsa dist rebuild):
  - New city: the overview shows light and dark buildings and coloured roofs; untick District palette / Roof variety: the
    old muted look comes back (a short rebuild).
  - Night street: walkers and cars carry a soft dark patch; untick Mover shadows: it goes.
  - Reload a city saved before this: it keeps the muted look, the old traffic count and no mover shadows.

## 2026-10-04: Roof equipment: Classic / Clustered (Salsa visual-polish-next #11 tail) — BUILT in Frogmarks

- **Engine (Salsa):** flat roofs carry fewer, larger pieces: one stair box, one coloured water tank and one AC bank at
  the back, plus a couple of district extras (solar panels, laundry, garden planters, neon frames, lit masts, the odd
  helipad), so the roof colours read from above. It is on for new cities and every scene preset. Saved cities stay
  'classic' until a preset is applied. Guide: [city-quality.md](./city-quality.md) §Roof equipment.
- **API (`shapeManager.world`):** `setRoofEquipment('classic' | 'clustered')` / `roofEquipment` (rebuilds the buildings);
  CityLook field `roofEquipment`.
- **Applied in Frogmarks** (backups: agent scratchpad `backup-roofeq/`): `world-panel.component.ts` / `.html`. A **Roof
  equipment** select (Classic / Clustered) sits next to Roof variety in the city look section and goes through
  `worldSetLookValue('setRoofEquipment', …)`, a guarded `w?.[method]?.()` call. It syncs from the engine in
  `_syncCityLookFromEngine`. `npx tsc -p tsconfig.app.json --noEmit` is clean.
- **Please verify in the browser** (after a Salsa dist rebuild):
  - New city, overview / air: roofs show a clear deck with a coloured tank and an AC bank at the back.
  - Switch to Classic: the scattered grey plant returns after a short rebuild.
  - Reload a city saved before this: the select shows Classic.

## 2026-10-04: Character scale: Scale / Height (m) / Fit to city (Salsa character-scale pass) — BUILT in Frogmarks

- **Engine (Salsa):** a whole character can be scaled as one (body, skeleton, clothes, hair, face kit, eyes, glasses,
  springs) with no regeneration, feet kept on the ground, saved with the document, undoable. Play follows the size:
  camera framing, eye height, collision capsule (radius + step height × H / 1.7 m, new) and stride (planted feet at any
  size, new). Also fixed: a Height / leg-length slider edit no longer sinks or lifts the feet; the first Play after a
  Height edit no longer frames the old size; a new city character stands its soles on the street (they were ~0.37 m
  under it); the gizmo / S shortcut scales a character body uniformly from its feet. Guide: [character-creator.md](./character-creator.md)
  §Scaling a character, [play-mode.md](./play-mode.md) §Player avatar → Character size.
- **API:** `sm.getCharacterScale3D(bodyId)` → `{ scale, height, heightMetres, restHeight, metresPerUnit, sceneMetresPerUnit }`;
  `sm.setCharacterScale3D(bodyId, s)`; `sm.setCharacterHeight3D(bodyId, metres, unit?)`; `sm.fitCharacterToScene3D(bodyId, metres = 1.7)`.
- **Applied in Frogmarks** (backups: agent scratchpad `pupdrive/scale/backup/`): `character-panel.component.ts` / `.html`,
  a **Size** group above Proportions: **Scale** slider (0.25–4) + number box, **Height (m)** number box, **Fit to city**
  button (enabled when a city exists). Synced in `scene3dInitBodyParams` and after a Height-slider edit; guarded
  `(this.shapeManager as any).fn?.()`; `npx tsc -p tsconfig.app.json --noEmit` is clean.
- **Please verify in the browser** (after a Salsa dist rebuild):
  - City: Generate → the character stands ON the street (feet visible). Size → Scale 2: twice as tall, feet still on the
    street, glasses / hair / face in place. Fit to city → back to 1.7 m.
  - Select the Character, Scale tool, drag the green (Y) handle: it grows uniformly from the feet. Ctrl+Z undoes it.
  - Play 3P / 1P at Scale 0.5 and 2: the camera frames the body, the eye height matches, walls stop the body at its edge,
    the feet don't slide.
  - Save + reload: the scale is kept; an old document loads unchanged.

## 2026-10-04: Landing dust + Idle variety (Salsa Play polish extras) — BUILT in Frogmarks

- **Engine (Salsa):** stylised **landing dust** in Play: an anime-style puff ring when the character lands, sized by
  the landing (Land Soft for a hop, Land, Land Deep for a long fall). While running on dry ground, tiny puffs come up at
  each foot strike. On a wet street (city rain or wet sheen) it splashes instead (droplets plus a low spray). The dust
  takes the ground's colour, is lit by the scene (darker and bluer at night) and is fogged with distance. It scales
  with the avatar and is skipped past the fog or sim-LOD edge. It costs nothing while nobody lands: no memory, no draw.
  **Idle variety**: standing still, the default Stand idle now and then plays a one-shot variant: Look Around, Stretch
  (with a yawn on the face kit), Check Wrist, Foot Tap, and Adjust Glasses (only with a glasses charm). Variants are
  seeded, never repeat back to back and blend in and out smoothly. Any input cancels one at once. An authored Idle clip
  always wins, and the procedural idle still yields to Play. Guide: [play-mode.md](./play-mode.md) §Landing dust + idle variety.
- **API:** `sm.setPlayLandingDust3D(on)` / `sm.getPlayLandingDust3D()`, `sm.setPlayIdleVariety3D(on)` /
  `sm.getPlayIdleVariety3D()` (both default on; saved as `globalScene.play.landingDust` / `idleVariety`, only when off);
  `sm.getPlayPolishStats3D()` (diagnostics: dust bursts by kind, live particles, idle variants played).
- **Applied in Frogmarks** (backups: agent scratchpad `pupdrive/extras/frogmarks-backup/`): `scene-view-bar.component.ts` /
  `.html`. The Play settings popover has two new checkboxes under Jump variety: **Landing dust** and **Idle variety**.
  Both sync in `_syncPlaySettings` and use guarded calls `(this.shapeManager as any).fn?.()`.
  `npx tsc -p tsconfig.app.json --noEmit` is clean.
- **Please verify in the browser** (after a Salsa dist rebuild):
  - Play 3P with the default character. Jump in place: a dust ring at the feet as it lands. A long fall off a ledge gives
    a bigger ring.
  - Run (Shift): small puffs behind the feet. In a city with rain (or wet streets) you should get splashes instead.
  - At night the dust is dim and blue-lit. Far away in fog it fades into the fog.
  - Stand still for ~5 s: the character looks around, stretches, checks the wrist, taps a foot (and pushes up the glasses
    if it wears a glasses charm). Press a key and it stops at once.
  - Untick each box: no dust, no idle variants (live, while playing). Save + reload keeps the setting.

## 2026-10-04: Anime head + chin shadow, 7 more hair styles, "controls that do nothing" panel audit — BUILT in Frogmarks

- **Engine (Salsa):**
  - **Anime head** for new bodies (`BodyParams.headShape: 1`): rounder cranium + cheeks, soft V-line jaw, small chin;
    same topology, so the face kit / eyes / hair fit unchanged. Saved characters keep the classic head.
  - **Chin shadow:** the grey / white neck band is gone (it was partly the rim light on down-facing neck normals). A soft V
    shadow under the jaw; the lit neck is never brighter than the face. character-shading.md "Anime head".
  - **Hair styles part 2** (Styled / locks): `braid`, `twin-braids`, `wavy`, `curls`, `spiky`, `drills`, `curly-volume`
    (15 in all; they appear in `sm.getHairStyles3D()` automatically). New HairParams: `lockCurl`, `lockCurlType`,
    `lockCurlFreq`, `lockSpike`, `hairPoof`, `tailForm` (`bundle` / `braid` / `drill`), `drillTurns`. hair-styles.md "part 2".
  - **Mode → control map:** Salsa `hair-control-modes.ts` (`HAIR_CONTROL_MODES`, `HAIR_GATHERED_INERT`), unit-tested against
    the generator and compared with the panel's copy. Engine bug it found: the chunky Front drape Wave sliders did nothing at
    the default chunkiness (fixed).
- **Applied in Frogmarks** (backups: agent scratchpad `pupdrive/look2/fm-backup/*.bak-2026-10-04-modes` and `-modes2`),
  `character-panel.component.ts` / `.html`:
  - Hair: **Hair type** (Styled / Chunky / Cards) moved to the top; every hair control is gated by `hairShow(key)` =
    `HAIR_CONTROL_MODES` + the gathered rule; Styled gets **Curl + volume** (Curl, Curl type, Curl freq, Spikes, Poof) and,
    under Tails, **Form** (Bundle / Braid / Drill curl) + **Drill turns**; Tail locks only for Bundle; End taper hidden for
    drills; Tail tip is Chunky-only; the Cap group is titled "Crown + hairline" in Styled; Styled bun size 0.15–1.2;
    Highlight band only with Sheen above 0; gathered Styled hair hides Sides / Flick / Messiness / Layers / Spikes.
  - Face kit: Nose size hidden for nose "None"; Shadow depth hidden when Hair shadow is 0 (the kit's controls were already
    hidden while it is off).
  - Eyes (procedural): a **Closed eye** hides Round, Lid shadow, Iris, Pupil, Lower lash, Double lid and Gaze (a closed eye
    draws only the lash arc, outer lashes and deco dots).
  - Clothing: Leg width also for **Shorts** (the generator applies it to both); Heel lift also shown when a non-heel shoe
    has a heel lift set.
  - Calls guarded `(this.shapeManager as any).fn?.()`; `*ngFor` arrays cached; `npx tsc -p tsconfig.app.json --noEmit` clean.
- **Please verify in the browser** (after a Salsa dist rebuild):
  - Generate a few characters: rounder faces with a small chin; the neck has a soft shadow under the jaw, no grey band.
  - Hair → Style → Braid, Twin braids, Wavy, Curls, Spiky, Drill curls, Curly volume.
  - Hair type Styled: no Cap thickness / Bangs / Spiky cap / Buzz / Front drape / Cards controls. Tick Gathered on a
    ponytail: Sides / Flick / Messiness / Layers / Spikes disappear. Switch to Chunky / Cards: the Styled groups disappear.
  - Eyes → Proc → tick Closed eye: the iris / pupil / gaze controls hide.

## Clothing fit round 2: hide body under clothes, skirt swing (2026-10-04)

- **What changed (automatic, on by default):**
  - The **body-hiding mask**: skin the opaque clothes cover isn't drawn, so knees and thighs no longer show through trousers on the run, nor the knee cap through a long skirt.
  - A dark **cloth lining** on skirts and tops.
  - Smoother **pelvis → thigh weights** on new bodies.
  - A strict **layer order**: a top over the skirt or trouser waistband, trousers over socks.
  - **Long hair** layered over the shirt's back.
  - The Play **skirt hem swing**.
  - Engine: salsa docs/specs/clothing-generation.md §16. UI: docs/ui/character-creator.md "Fit round 2", play-mode.md "Skirt hem swing".
- **New calls:**
  - `sm.getHideBodyUnderClothes3D(id)` / `sm.setHideBodyUnderClothes3D(id, on)`, persisted per garment as `hideBody`.
  - `sm.getSkirtSwing3D(id)` (null without a skirt) / `sm.setSkirtSwing3D(id, 0..1.5)`, persisted as `hemSwing`.
- **Frogmarks (built 2026-10-04, character panel):**
  - "Hide body under clothes" checkbox on the Top and Bottom tabs.
  - "Skirt swing" slider on the Bottom tab, skirts only.
  - The handlers also update the panel's own param copies, because a later slider change sends the whole params object back.
  - Calls are guarded `(this.shapeManager as any).fn?.()`; `npx tsc -p tsconfig.app.json --noEmit` is clean.
- **Saved characters regenerate sensibly**; they are not byte-identical. New bodies' weights change, classic bodies are unchanged, and every garment gets the mask, lining and layering on load.
- **Please verify in the browser** (after a dist rebuild):
  - Run in trousers: no skin patches at the knees.
  - Run in a long skirt: no knee cap; the inside is dark, not white; the hem trails and settles on a stop.
  - Untick Hide body under clothes: the old pokes may return. Skirt swing at 0: no swing.