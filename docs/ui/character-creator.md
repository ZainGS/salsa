# Character Creator — Frogmarks UI Integration

**Last Updated:** 2026-06-28 (added **Shoes** slot + pants **Stack** / §6b shoe-floor coupling + hair **Length/Curl/Layering** (Phase A) + **Export/Import Character** preset) · 2026-06-24 (per-part texture upload + render style; garment trim/UV-paint)
**Engine spec:** [character-creation-pipeline.md](../specs/character-creation-pipeline.md) · [hair-generation.md](../specs/hair-generation.md) (procedural hair) · [clothing-generation.md](../specs/clothing-generation.md) (procedural clothing)
**Sibling UI docs:** [hair.md](./hair.md) (hair panel), [clothing.md](./clothing.md) (clothing panel), [kitbash.md](./kitbash.md) (assemble a character from existing parts), [uv-editor.md](./uv-editor.md) (pixel-paint a part), [armature.md](./armature.md) (pose). Product wrapper: [dollz-creator.md](../specs/dollz-creator.md).

This doc covers the **creation** half — making the **base body** and **custom clothing** in-app — as opposed to [kitbash.md](./kitbash.md), which covers **assembling** a character from a library of pre-made parts. The two panels chain: *create a body → dress it (assemble/create clothing) → pose → render.*

> **Status legend:** ✅ available now · 🔶 spec'd, engine pending. Each section is tagged.

---

## 1. Where this fits

```
 CREATE body          →  DRESS (assemble + create clothing)  →  POSE   →  RENDER / CARD
 procedural generator     kitbash slots + custom garments        rig       PS1 retro + 2D card
 (this doc §2–3)          (kitbash.md + this doc §4)            (armature) (dollz-creator.md)
```

The body, clothing parts, and assembled character all share **one canonical skeleton**, so posing and animation work the moment a part exists.

---

## 2. Procedural base body ✅ (available now — prototype)

Generate a low-poly humanoid base from a handful of proportion parameters — no GLB, no modeling.

### API

```ts
const { meshId, skeletonId } = await shapeManager.createProceduralBody3D({
  height: 1,        // overall height
  limbThick: 1,     // arm/leg thickness
  torsoThick: 1,    // torso thickness (width)
  torsoLength: 1,   // torso length (compact torso → <1 for the leggy dollcore look)
  headSize: 1,      // head scale
  legLength: 1.15,  // leg length (dollcore long-legs → raise this)
  // Localized shape (all default 1 = neutral):
  bust: 1,          // chest fullness (pushes the chest FORWARD; >1 fuller, <1 flatter)
  waist: 1,         // mid-torso width (<1 cinched, >1 fuller)
  hipWidth: 1,      // pelvis width — SIDE-TO-SIDE only (wide hips ≠ wide front)
  hipFront: 1,      // pelvis FRONT projection (lower-belly depth) — INDEPENDENT of hipWidth
  shoulderWidth: 1, // shoulder width — scales the torso shoulder band AND the arm's deltoid cap together, so a wider shoulder keeps the arm seamlessly matched (no gap where the arm meets the shoulder)
  buttSize: 1,      // buttock fullness — 0 flat · 1 neutral · >1 fuller (radial cheek bulge: width + back-projection + auto-hang)
});
```

- All params optional; omitted ones use the defaults above.

### Live body editing ✅ (new — edit after creation)

Body proportions are no longer create-only — `setBodyParams3D` regenerates the body **in place** (same mesh + skeleton ids; a moved character stays put) and **re-fits everything attached** (hair, garments, face decal) to the new shape. Merge-style, so pass only the changed field(s). Wire it to the same sliders for a live edit on an existing character.

```ts
await shapeManager.setBodyParams3D(meshId, { hipWidth: 1.2 });  // live; re-fits hair/clothing/face
const cur = shapeManager.getBodyParams3D(meshId);               // current params (to seed the sliders)
```

> **All six base proportions are editable post-create too** (height / limbThick / torsoThick / torsoLength / headSize / legLength) — `setBodyParams3D` regenerates the geometry **and the skeleton** in place. Apply them while the character is in **rest pose** (the creation stage), since it rebuilds the rest pose. So Frogmarks should keep *every* body slider live after Generate, not just the localized-shape ones.

### Save / load a whole character ✅ (portable preset)

Export a character's procedural look (**body + hair + clothing/shoes params + render style**) to a portable **JSON string**, and re-apply it to any body — independent of the document save (a reliable backup, or a "character preset" library).

```ts
const json = shapeManager.exportCharacter3D(meshId);   // JSON string (meshId optional → first procedural body)
// …keep `json` (clipboard / file / your own preset store)…
await shapeManager.importCharacter3D(meshId, json);    // re-apply (body first, then hair / clothing / render style)
```

- Covers the **procedural generators** (body / hair / top / bottom / shoes params + render style). Face eye-**textures** (PNGs) ride the full document save, not this preset.
- Wire **"Save Character Preset" / "Load Preset"** buttons. (Full persistence — survives reload / `.frogmarks` — is automatic + separate; this is the portable-preset path.)

### Skin tone ✅ (new)

```ts
shapeManager.setSkinTone3D(meshId, '#e8b89a');     // live; persists with the document
const hex = shapeManager.getSkinTone3D(meshId);    // current tone (to seed a color picker)
```
- Returns the new mesh + skeleton node ids. The body is added at the world origin, **already rigged and posable** (skinned to the generated skeleton).
- It's a `SkinnedMesh3D` — paint it (`enterUVPaintMode3D(meshId)`), tint it (`setMeshDiffuseColor`-style skin tone), and pose it via the skeleton like any character.
- **Pre-bound flag — hide "Bind Mesh" for these.** The mesh *and* its skeleton are tagged `isProceduralBody = true`. The armature panel should **hide the Bind Mesh section** when the active mesh/skeleton is procedural — re-binding replaces the generator's tube weights with distance-based auto-weights. Read it the way that fits your panel:
  ```ts
  shapeManager.getAllMeshes3D().find(m => m.id === meshId)?.isProceduralBody  // direct off the mesh
  shapeManager.isProceduralBody3D(meshId)               // mesh-keyed query
  shapeManager.isProceduralBodySkeleton3D(skeletonId)   // skeleton-keyed (panel keys off the skeleton)
  ```
  The skeleton flag is **persisted**, so it stays correct across save/reload (prefer the skeleton-keyed query for robustness).

### Suggested panel

```
┌──────────────────────────────┐
│  Base Body                    │
│  Height      ●────────  1.00  │   0.6 – 1.6   (defaults lean dollcore:
│  Leg length        ●── 1.40  │   0.8 – 1.8    long legs, slim limbs,
│  Limb thick  ●─────    0.85  │   0.6 – 1.6    smaller torso, bigger head)
│  Torso width ●──────   0.90  │   0.6 – 1.6
│  Torso length   ●───   1.00  │   0.6 – 1.4   ← compact torso = leggier
│  Head size      ●───   1.25  │   0.7 – 1.6
│  Bust         ●─────   1.00  │   0.6 – 1.6   ← localized shape (default 1)
│  Waist        ●─────   1.00  │   0.6 – 1.4
│  Hip width    ●─────   1.00  │   0.7 – 1.5
│  Shoulders    ●─────   1.00  │   0.7 – 1.4
│  Skin tone    [■ #e8b89a]     │   color picker → setSkinTone3D
│  [ Generate body ]            │
└──────────────────────────────┘
```

> The **same sliders** drive `previewProceduralBody3D` (live ghost, pre-create) **and** `setBodyParams3D` (live edit, post-create) — wire both so the panel works before and after Generate.

### Live ghost preview ✅ (the system you asked for)

As soon as the user picks **"Character…"** (and on every slider change), show a **translucent live ghost** that updates instantly — *before* committing. It's a hologram (no scene node, no undo/selection churn), so dragging sliders is smooth.

```ts
// On tool-open AND on every slider change (debounce ~30–60ms is plenty):
await shapeManager.previewProceduralBody3D(params);   // updates the live ghost

// On "Generate body" (commit → real rigged SkinnedMesh3D; auto-clears the ghost):
const { meshId, skeletonId } = await shapeManager.createProceduralBody3D(params);

// On Cancel / leaving the Character tool without committing:
shapeManager.clearProceduralBodyPreview3D();
```

So the flow is: **pick "Character…" → ghost appears → drag sliders → ghost morphs live → Generate → it becomes the real body.** No need to spawn/delete real meshes per tweak — the ghost handles the live part, `createProceduralBody3D` handles the commit.

The ghost **stands in the Relaxed stance and gently breathes** (not a static T-pose) — handled automatically inside `previewProceduralBody3D` (a throwaway skeleton CPU-skins the preview each frame), so it matches the character that spawns. No extra host call.

**Spawn-in juice (POST-steps — call AFTER your full Generate: body + clothing + hair + any scaling).** Both take the body mesh id and never touch your Generate flow:

```ts
const { meshId } = await shapeManager.createProceduralBody3D(params);  // Generate
// …assemble + scale the rest of the character…

shapeManager.playSpawnSpin3D(meshId);     // just spin in (eases to front; { turns?: 1.25, durationSec?: 1.2 })
// — or —
shapeManager.playSpawnReveal3D(meshId);   // the MATERIALIZE effect: a bright line sweeps top→bottom developing
                                          //   the character out of a blue hologram, AND spins it (includes the spin)
```

`playSpawnReveal3D` overlays a Relaxed body ghost **matched to the character's transform** (so it lines up at the right scale) and **drawn on top** (so it covers the clothing rather than hiding behind it), then wipes it away with the line. v1 caveat: the ghost is body-shaped, so loose hair pops in rather than materializing. Runtime-only.

### Prototype caveats (set expectations in the UI)
It's currently a **rough mannequin**: faceted octagonal cross-sections, **20-joint rig** (clavicles — `chest → clavicle → shoulder` — for a rounder collar + proper shoulder lift; **plus a `lowerback` lumbar joint** between `hips` and `spine` so the lower back **arches** instead of hinging at the chest — the spine chain is now `hips → lowerback → spine → chest`, weighted as a smooth cross-fade; shoulder + spine world positions unchanged, so arms/clothing/the rest pose don't shift). Defaults lean dollcore (long legs / slim limbs / bigger head). **Weld pass 2b — whole body is now ONE stitched surface:** the torso is an 8-sided tube; **arms** bridge out of an open shoulder socket via a wide **deltoid collar** (fills the socket, then tapers — defined shoulders); the **head** continues up from the neck ring as capped rings; the **legs** split out of the pelvis-bottom ring (**pants** topology, shared crotch verts). Only the **hands/feet** remain as cap blobs. **UVs are per-part islands** (torso / head / each arm / each leg, packed into non-overlapping atlas rects; hands ride the arm island, feet the leg island) so painting a spot maps to one part — part-boundary bridge rings stretch a little (welded-mesh seam tradeoff; seam-splitting is a follow-up). Still on the engine to-do (spec §7a/§8): smoother joint weights, mitten/wedge hands/feet, head/face shaping (angular chin, nose vertex), and the rest of the canonical 26-joint rig (**clavicles done**; fingers/toes next). Don't ship it as the final look yet; it's the engine proving ground.

### Preset poses ✅
The generated body ships with named preset poses so animating isn't from-scratch:

```ts
const names = await shapeManager.getBodyPoseNames3D();   // ['T-pose','A-pose','Relaxed','Wave']
await shapeManager.applyBodyPose3D(skeletonId, 'A-pose'); // skeletonId from createProceduralBody3D
```

Wire a small pose dropdown to these. (The pose *angles* are first-cut and easy to tweak in
`body-generator.ts` `BODY_POSES`; un-stitched shoulders/hips may gap on extreme poses until weld
pass 2.)

---

## 2.5 Anime face / eye expressions ✅ (available now)

Give the character **drawn anime eyes** that follow the head and switch between **expressions/states** — including an automatic **blink**. The eyes live on a thin **face decal** (a quad skinned 100% to the head joint), so they ride along with every pose for free. Each expression is **one image** (a "cel" — no in-state animation).

Each state can be made **two ways** — both just fill the same expression texture:
- **Draw** — freehand on the flat eye canvas (below). Full control, for people who like to draw.
- **Procedural** — generate the eyes from **sliders** (see *Procedural eyes*), for anyone who'd rather customize through the UI. Pick whichever per state; a procedural state stays re-editable via its sliders.

### Frogmarks flow

```
Edit Character ▸ Eyes
   ┌─────────────────────────────────────────────┐
   │  States                  ┌────────────────┐  │
   │  ● Neutral   (active)     │                │  │   ← draw pane (UVCanvasRenderer):
   │  ○ Happy                  │   ◕     ◕      │  │     the flat eye canvas. Brush =
   │  ○ Blink   [blink ▾]      │                │  │     same raster brush as UV paint;
   │  [ + New state ]          └────────────────┘  │     erase = remove (transparent).
   │                            [ Draw ]  [ Done ]  │
   │  Blink:  ◉ random  2.5 – 6.0 s   hold 110 ms   │
   └─────────────────────────────────────────────┘
```

1. **Edit Character → Eyes** → `ensureFace3D(bodyMeshId)` once (lazily grows the decal).
2. **+ New state** → `createFaceExpression3D` → returns an `exprId` (the first one becomes active).
3. **Draw** → `enterEyeDrawMode3D(bodyMeshId, exprId, uvRenderer)` opens the flat eye canvas and routes the brush at *that* expression's texture; strokes appear **live on the face**. It also **auto-aims the 3D view at the face** and turns on **drawing guides** (see below). **Done** → `exitEyeDrawMode3D()`.
4. Mark one state as the **blink** (`setFaceBlinkExpression3D`) and set its timing.

**Recommended layout — split pane:** flat eye canvas (left, for precision) + the live 3D viewport framed on the face (right, for truth). They stay in sync automatically (paint on either updates the same texture), and the eye canvas is an **undistorted 1:1 map of the face front** (the decal has trivial flat UVs — no unwrap warp), so a circle drawn left lands as a circle on the face.

### API

```ts
shapeManager.ensureFace3D(bodyMeshId);                       // grow the eye decal (idempotent)

const exprId = shapeManager.createFaceExpression3D(bodyMeshId, 'Happy');
shapeManager.renameFaceExpression3D(bodyMeshId, exprId, 'Cheerful');
shapeManager.deleteFaceExpression3D(bodyMeshId, exprId);

shapeManager.setActiveFaceExpression3D(bodyMeshId, exprId);  // the held face (between blinks)

// Draw this expression's eyes on the flat canvas (uvRenderer = a UVCanvasRenderer over your pane):
const uvRenderer = shapeManager.createUVCanvasRenderer(eyeCanvas);
shapeManager.enterEyeDrawMode3D(bodyMeshId, exprId, uvRenderer); // brush → that expr's texture, live on face
// Brush = the SHARED 2D brush: the live color / size / preset / erase mirror onto the eye
// texture at the start of every stroke, so your normal brush panel just works:
shapeManager.setRasterBrushColor('#222');   // e.g. dark eye lines
shapeManager.setRasterBrushSize(6);
// (erase mode on the shared brush removes eyes → transparent. Optional one-shot brush at enter:
//  enterEyeDrawMode3D(body, expr, uvRenderer, { color, radius, erase }).)
shapeManager.exitEyeDrawMode3D();                                // leave draw mode (eyes stay)

// Draw aids (enterEyeDrawMode3D turns both on automatically):
shapeManager.frameFace3D(bodyMeshId);              // re-aim the orbit camera dead-front on the face
shapeManager.setFaceDrawGuide3D(bodyMeshId, true); // toggle the symmetry-axis + eye-line + eye-box guides

// Blink (manual — point it at a blink expression yourself):
shapeManager.setFaceBlinkExpression3D(bodyMeshId, blinkExprId);  // null disables blinking
shapeManager.setFaceBlinkConfig3D(bodyMeshId, {
  mode: 'random',   // 'fixed' = blink every minSec; 'random' = wait minSec–maxSec between blinks
  minSec: 2.5, maxSec: 6.0,
  holdMs: 110,      // how long the blink frame is shown
});

// Auto-blink (the eye-settings TOGGLE — recommended; auto-makes a closed-eye frame for procedural eyes):
shapeManager.setAutoBlink3D(bodyMeshId, {
  enabled: true,
  minSec: 2.5, maxSec: 6.0,        // FREQUENCY — a small random range (irregular = natural)
  holdMs: 110,                     // SPEED — how long the eyes stay closed
  doubleProbability: 0.15,         // chance a blink is a DOUBLE blink (0–1)
  doubleGapMinMs: 150, doubleGapMaxMs: 320,  // random gap between the two blinks of a double
});
shapeManager.setAutoBlink3D(bodyMeshId, { enabled: false });   // stop blinking

const face = shapeManager.getFaceExpressions3D(bodyMeshId);
// → { expressions: [{id,name,isBlink}], activeId, blinkId, blink } | null  — drive the panel from this
//   `blink` now carries enabled / doubleProbability / doubleGap* too (persisted) — seed the toggle + sliders from it
```

**Auto-blink panel (eye settings):** a **☑ Auto-blink** checkbox + **Frequency** (min/max s), **Blink speed** (`holdMs`), **Double-blink %** (`doubleProbability`), and **Double gap** (min/max ms). `setAutoBlink3D` **auto-creates a closed-eye blink frame** from the active eyes (`closed: true`) the first time you enable it on procedural eyes, so the user never has to draw/mark a blink state — the toggle just works. (Manual `setFaceBlinkExpression3D` is still there if someone wants a hand-drawn blink.)

### How it works (and what to expect)

- **Follows the head for free.** The decal is skinned 100% to the head joint, so it moves/rotates with any pose — no per-frame transform. (It rides the head *joint*; translating the whole body still carries it, since the skeleton moves too.)
- **Crisp eyes on an invisible face.** The expression texture is **transparent** except where the user draws; the shader discards near-zero alpha, so you see *only* the drawn eyes — no quad edges, no background plane. The decal is **unlit** (full-bright), so eyes read at any lighting.
- **Blink is cheap.** Driven by `setTimeout` (wait → show blink frame for `holdMs` → revert → repeat), not a per-frame cost. A state with `isBlink`/no texture won't flash.
- **Eye placement.** The decal sits at ~60% up the head, ~42% of head height tall. If eyes feel crowded by the nose, lower the nose vertex in `body-generator.ts` (head shaping is still on the engine to-do, §2 caveats).
- **Draw aids.** Entering eye mode **auto-frames** the orbit camera dead-front on the head (`frameFace3D`) and overlays faint **drawing guides** on the eye canvas — a vertical symmetry axis, a horizontal eye line (v=0.5), and two eye boxes where the eyes roughly sit (`setFaceDrawGuide3D` toggles them). The guides are pane-only; they never touch the texture. The frame targets the rest-pose head (eye editing is usually done neutral) — orbit/zoom freely afterward.
- **Persistence is automatic.** Expressions, active/blink ids, blink timing, and each drawn eye image are saved with the document (and `.frogmarks` export) and restored on load — the decal is rebuilt from the rig metadata, so it isn't a separate node you manage. No extra save wiring on the Frogmarks side.

### Procedural eyes (the no-drawing path) ✅

For users who don't want to draw: generate the eyes from parameters. It composites the eyes with **Canvas2D** (mirror-symmetric — tweak one set, both eyes follow) into the **same** expression texture a brush would paint, so the decal, blink, and persistence are all unchanged. Live: call it on every slider change.

```ts
const p = shapeManager.getDefaultEyeParams3D();        // the "anime girl" preset to seed sliders
p.irisColor = '#b39ddb';                               // … bind sliders to fields, then:
shapeManager.setFaceExpressionProcedural3D(bodyMeshId, exprId, p);   // renders → live on the face

const cur = shapeManager.getFaceExpressionParams3D(bodyMeshId, exprId); // params back (null if drawn)
```

**Param groups** (all in `EyeParams`):
- **Placement** — `spacing`, `verticalPos` (eye-line height on the face).
- **Shape** — `width`, `height`, `tilt` (cat-eye lift), `roundness` (almond ↔ big round). *Aspect-corrected:* the generator pre-squishes each eye by the decal's width/height, so a round iris renders **round** (not stretched) on the wide face plane, and `width`/`height` map directly to the **visual** proportions.
- **Iris** — `irisColor`, `irisRadius`, optional `irisGradient` (`irisColorTop`/`Bottom`), optional `limbalRing` (`limbalColor`/`limbalThickness`).
- **Pupil** — `pupilColor`, `pupilRadius`.
- **Gaze** — `gazeX`/`gazeY` (−1..1; x:+right, y:+down) shift the iris so the eyes **look** in a direction; the lid clips the iris at the boundary as it moves. For live "look at" use `setFaceGaze3D(bodyMeshId, x, y)` (cheap re-render — drive it off a cursor/target; it applies to the active procedural expression and sticks on its params).
- **Highlights** — a list of `{ x, y, radius, color }` catchlights (preset: 1 big + 1 small).
- **Lashes/lids** — `upperLashThickness`/`Color`, `outerLashLength`, `lowerLash`, `doubleEyelid`.
- **Render** — `pixelResolution` (px): renders the eyes small and upscales **nearest-neighbour** for the chunky low-res **PS1/dollcore** look (default ~200; `0` = crisp full-res).
- **Under-eye deco** — `underDeco`/`underDecoColor`/`underDecoCount` (the reference girl's dots).
- **Blink** — `closed: true` renders a closed-eye lash arc, so the **blink state can be procedural too** (no second drawing).

**Persistence:** the params ride in the rig metadata (`faceRigs`), *and* the baked image persists as the PNG — so reload shows the eyes instantly and the sliders still work. The optional `irisGradient` / `limbalRing` / big offset highlight get you toward the fancier (Blender-style) look without extra code. A procedural state can still be hand-touched-up later (switch it to **Draw**; re-generating would overwrite).

### Limits (first cut)
One image per state (no in-state animation — use multiple states + blink for life). Eyes are a flat overlay on the front of the head (great head-on and at moderate angles; extreme profile shows the flat plane). Brush radius maps screen-px→texel via the pane zoom (same as UV paint) and may want tuning against a live build. Procedural eyes are front-facing 2D art (no per-eye 3D refraction like the Blender reference) — by design, to stay simple and match the PS1/dollcore look.

---

## 2.6 Procedural hair ✅ (available now)

Generate **chunky low-poly hairstyles** from presets + sliders — same flow as the body and eyes. A style skins to the **head joint** (follows poses), uses a **root→tip gradient** (the reference's blue tips), and can **bake into a kitbash hair part**. v1 covers the reference-girl set (cap + bangs + parting + twintails/ponytail/pigtails). **UI hand-off doc (build the panel from this): [hair.md](./hair.md).** Engine design: [hair-generation.md](../specs/hair-generation.md).

> **Status (2026-06-28):** live generator + sliders ✅, **persistence** ✅, **bake-to-part** ✅, **card mode** ✅ (Elden-Ring alpha-card hair), **Length / Curl / Layering** ✅ (Phase A — bob / long / hime / curly / wolf). **Named style presets** (Bob/Bun/Braid/etc.) are the 🔶 remaining piece (spec [hair-styles.md](../specs/hair-styles.md), phases B–E). See [hair.md](./hair.md) for the param→control mapping.

Panel (Edit Character → Hair): preset dropdown → sliders → live update; **Save as hair part**.
```ts
getHairPresetNames3D();                         // ['Twintails','Ponytail','Pigtails','Bob','Long']
setHairParams3D(bodyMeshId, params);            // build/update hair, live (per slider change)
bakeHairToPart3D(bodyMeshId, name);             // → GLB + kitbash hair slot
```

---

## 3. Proportions from a drawing 🔶 (engine pending)

Instead of sliders, let the user **draw a front-view silhouette**; the engine solves the generator params to best match it ("draw your body type"). Same `createProceduralBody3D` output. UI: a 2D draw surface + a **Fit to drawing** button. (Spec §3 / §6 "silhouette → param fit".)

---

## 4. Clothing creation ✅ (procedural generator available now)

> **Built (2026-06-23 · shoes + baggy-stack 2026-06-28):** clothing is a **procedural generator** (presets + sliders → low-poly garments auto-rigged by joint-blend weights), matching the body/eyes/hair flow. **Three slots — Top · Bottom · Shoes** (footwear wraps the `foot_L/R` joints). Flat/gradient color. Garments **enclose the body, never clip** (directional fit + shrink-wrap + min-gap) and **deform with the body** when posed. NEW: pants **`stack`** (baggy/accordion) + the **§6b shoe-floor coupling** — baggy pants **pile ON the equipped shoe**, never clipping. Live, persisted, bake-to-part. **Build the panel from [clothing.md](./clothing.md)** (now incl. the **Shoes** tab + **Stack**); engine details in **[clothing-generation.md](../specs/clothing-generation.md)** + **[shoe-generation.md](../specs/shoe-generation.md)**.
>
> **Next (🔶):** procedural **hems/cuffs/trim** + **UV-paint** garments (prints/seams) + **draping**; then the **Clothing Designer** (design standalone on a mannequin → save as a preset → fit to any character — see clothing-generation.md §14).

The original two bespoke flows (kept as a **later** "tailor an exact piece" mode), by whether the garment changes the silhouette (spec §4):

### 4a. Tight clothing — "skin off the body"
Select a body region (torso / arms / legs) → **offset-copy** it into a garment that hugs by construction and inherits UV + weights → trim the boundary (sleeve/neckline) → pixel-paint → **save as part**.

```
[ Select region ]  →  [ Make garment ]  →  [ Trim ] [ Paint ]  →  [ Save as Top ▸ ]
```

### 4b. Loose clothing — draw → inflate → conform
Draw a garment silhouette in 2D → inflate → **shrinkwrap** onto the body + **weight-copy** → paint → save as part. For skirts, jackets, hats, hair.

### Save-as-part
A created garment exports to GLB and registers as a `KitbashPartMeta` in the kitbash library, so it appears in the **swap panel** ([kitbash.md](./kitbash.md)) like any other part. UI: pick the slot (top/bottom/shoes/hair/accessory), name it, **Save** → it shows up in that slot's grid.

---

## 4.5 Texturing & styling any part ✅ (upload / paint / render style)

Every character part — **body, hair, top, bottom, eyes** — can take an uploaded texture, be pixel-painted, and get a render style. The engine **carries these across regenerates**, so nudging a slider (or changing body proportions, which re-fits hair/garments/eyes) never silently wipes them.

### Get a part's mesh id
```ts
sm.getClothingMeshId3D(bodyMeshId, 'top' | 'bottom');   // garment
sm.getHairMeshId3D(bodyMeshId);                         // hair      (null until setHairParams3D)
sm.getEyesMeshId3D(bodyMeshId);                         // eye decal (null until ensureFace3D)
```
> These ids **change every time the part regenerates** (a hair/clothing slider), so **re-fetch after a param change** — don't cache.

### Upload / clear a texture
Route the **"Texture → Upload / ✕ Clear"** buttons through these (⚠️ **not** a raw `mesh.diffuseTexture` set — that won't be tracked, so it'd vanish on the next regenerate):
```ts
sm.setPartTexture3D(meshId, imageBitmap);   // upload an image as the part's diffuse (tracked → carried + persisted)
sm.clearPartTexture3D(meshId);              // revert to generated colour (garment/hair gradient, eyes → active expression, body → skin tone)
```
`setPartTexture3D` takes an already-decoded `ImageBitmap` / `<img>` / `<canvas>`. Uploaded textures ride the same per-rig persistence as painted ones, so they survive save/reload.

### Pixel-paint a part
`sm.enterUVPaintMode3D(meshId, uvRenderer?)` / `exitUVPaintMode3D(meshId)` — same flow as the body; each garment piece has its own UV island (see [clothing.md §5b](./clothing.md)). Paint persists + carries across regenerates too.

### Render style
Set `material.renderStyle` (`'default' | 'cel' | 'sketch' | 'ink' | 'gouraud'`) per mesh (e.g. a `scene3dSetCharRenderStyle()` that applies it to body/hair/top/bottom/eyes). However it's set, it's **carried across regenerates** (the engine reads it off the old mesh and re-applies it to the rebuilt one).

---

## 5. The full creator flow (newcomer path)

```
1. Generate base body      (§2 — sliders or draw)            ✅ body API live
2. Skin tone / paint        (skin tint + UV paint)            ✅ (paint live)
3. Draw eyes / expressions  (§2.5 — states + blink)           ✅ face API live
   • or generate eyes        (§2.5 — procedural + gaze)         ✅ procedural live
4. Hair                      (§2.6 — presets + sliders)         ✅ live + persisted + bake
5. Dress
     • generate clothing    (§4 — top + bottom + SHOES)       ✅ live, no-clip fit, persisted; baggy STACK piles on shoes
     • swap library parts   (kitbash.md slot grid)            ✅ assembly live (needs parts)
     • create custom parts  (§4 offset-copy / draw-inflate)   🔶 later "tailor exact" mode
6. Pose                     (armature pose library)           ✅
7. Render / card            (PS1 retro + 2D card)             ✅ (dollz-creator.md)
```

Steps 1–7 are usable now (body + live editing, skin tone, eyes, hair, **procedural clothing** with trim/cuffs + UV-paint, per-part texture/style with carry-across-regen, pose, render). Remaining polish: garment **draping/dynamics**, then the **Clothing Designer** (design standalone → save preset → fit any body); bespoke offset-copy/draw-inflate stays a later "tailor exact" mode.

---

## 6. Status summary

| Feature | API | Status |
|---|---|---|
| Procedural base body | `createProceduralBody3D(params)` | ✅ prototype (dollcore defaults; rough mannequin) |
| Body proportions sliders | (param wiring) | ✅ ready to wire (incl. bust/waist/**hipWidth + hipFront** (separate side-vs-front)/shoulderWidth/**buttSize**) |
| **Live body editing** (post-create, re-fits rigs) | `setBodyParams3D` / `getBodyParams3D` | ✅ |
| **Skin tone** | `setSkinTone3D` / `getSkinTone3D` | ✅ (live + persisted) |
| **Live ghost preview** | `previewProceduralBody3D` / `clearProceduralBodyPreview3D` | ✅ |
| **Preset poses** | `applyBodyPose3D` / `getBodyPoseNames3D` | ✅ (angles first-cut) |
| Body from drawn silhouette | silhouette→param fit | 🔶 pending |
| Skin tone + pixel paint | skin tint + `enterUVPaintMode3D` | ✅ |
| **Anime face / eye expressions** | `ensureFace3D` / `createFaceExpression3D` / `enterEyeDrawMode3D` | ✅ (states + blink, drawn eyes, persisted) |
| ↳ Draw aids (auto-frame + guides) | `frameFace3D` / `setFaceDrawGuide3D` | ✅ |
| ↳ **Procedural eyes (no drawing)** | `getDefaultEyeParams3D` / `setFaceExpressionProcedural3D` | ✅ (sliders → eyes, low-res look, aspect-correct, persisted) |
| ↳ Eye gaze / look-at | `setFaceGaze3D` (or `gazeX`/`gazeY`) | ✅ (iris shifts, lid-clipped) |
| **Procedural hair** | `setHairParams3D` / `bakeHairToPart3D` | ✅ live + persisted + bake (named presets 🔶) |
| **Procedural clothing (top + bottom)** | `setClothingParams3D` / `bakeClothingToPart3D` | ✅ live + persisted + bake; enclose/no-clip fit ([clothing.md](./clothing.md)) |
| ↳ Garment **trim + UV-paint** | (trim params + `enterUVPaintMode3D`) | ✅ (crisp trim band; per-piece UV islands; paint persists). Raised folded cuffs exist but are OFF (`ENABLE_CUFFS=false`) |
| ↳ Garment **draping/dynamics** | — | 🔶 next (clothing-generation.md §13) |
| ↳ **Clothing Designer** (standalone → preset → fit any body) | — | 🔶 future (clothing-generation.md §14) |
| **Per-part mesh ids** (for texture/style) | `getClothingMeshId3D` / `getHairMeshId3D` / `getEyesMeshId3D` | ✅ (§4.5) |
| **Upload / clear a part texture** | `setPartTexture3D` / `clearPartTexture3D` | ✅ (tracked → carried across regen + persisted) |
| **Carry across regen** (texture + render style) | (auto in `setHairParams3D`/`setClothingParams3D`/`setBodyParams3D`) | ✅ (slider nudges no longer wipe uploads/style) |
| **Hide whole 3D scene** ("3D Scene" layer eye) | `scene3DVisible` | ✅ (render-only; Frogmarks persists the toggle — [3d-scene.md](./3d-scene.md)) |
| Assemble from parts | `createCharacter3D` / `swapCharacterSlot3D` | ✅ (needs parts library — see kitbash.md) |
| Tight/loose bespoke clothing (offset-copy / draw-inflate) | — | 🔶 later "tailor exact" mode |
| Save created part to library | `bakeClothingToPart3D` / `bakeHairToPart3D` | ✅ (GLB persists to the document) |
| Pose | armature / pose library | ✅ |
| Retro render + card | `PS1Config` + 2D-hybrid | ✅ |
