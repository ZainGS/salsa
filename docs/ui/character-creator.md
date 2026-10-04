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
  seamBlend: 0.5,   // JOINT SMOOTHNESS 0..1 — blends skin weights across the armpit/elbow seams so they stop folding when posed.
                    //   0 = classic (every saved character); NEW bodies are created at 0.5. Slider range 0–1, step 0.05.
                    //   See docs/specs/character-skin-weights.md for the measured before/after.
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

### Random character ✅ (new 2026-09-29 — the 🎲 "Generate" defaults)

The engine now owns the NEW-random-character recipe (`src/services/managers/character-randomizer.ts`, seeded — same seed, same character). Use it for the Generate / 🎲 button instead of a host-side randomizer:

```ts
// One call (body = your body sliders; merges over the random waist/hipFront):
const { meshId, nodeIds } = await shapeManager.createRandomCharacter3D({ seed, position: center, body: { height, legLength, limbThick, torsoThick, torsoLength, headSize } });
// …or get the params, tweak/show them, then create:
const p = shapeManager.randomCharacterParams3D(seed, bodySliders);   // { body, eyes, hair, top, bottom, shoes, socks, skinTone, rimLight: true }
await shapeManager.createFullCharacter3D({ ...p, position: center });
```

Pinned defaults (the look signed off in polish-round-3 T6) — everything else (colours, hair style/tails, garment + shoe styles, socks) stays random:

| Part | Random-character value |
|---|---|
| Eyes | width **0.37–0.43** (≈0.4), height **0.18–0.22** (≈0.2), **no bottom lash** (`lowerLash: false`) |
| Hair | **one of the 8 anime lock STYLES** (`hairMode: 'locks'`, 2026-10-04: bob / long straight / side-swept / ponytail / twintails / short messy / bun / hime) with seeded per-character variation, the fringe above the eyes, flat colour (a root-to-tip gradient on about 30 %). Drawn from its own stream, so the clothes etc. of a seed are unchanged. See §2.6 *Hair styles*. (Was: cards, Cap Layers = 6.) |
| Rim light | **on** (`createFullCharacter3D({ rimLight: true })` → `setCharacterRimLight3D`) |
| Top | **Crop** (`hemHeight`) **−0.10 … 0** — never cropped; the belly stays covered |
| Bottom | **Looseness** (`thickness`) **0.016 – 0.020** (was the 0.012 default) |

`createFullCharacter3D` gained an optional `rimLight?: boolean` (omit = unchanged). Saved characters are untouched — their params persist and never pass through the randomizer. Guarded by `character-randomizer.test.ts` (500 seeds).

**Persona-look defaults (2026-10-03, visual-polish item 10)** — added on top of the T6 table, for NEW characters only:

| Part | Random-character value |
|---|---|
| Face shading | **anime face normals** — `BodyParams.faceNormals = 1` (every new procedural body: `NEW_BODY_DEFAULTS`, like the joint `seamBlend`). The face shades as one flat skin plane with at most a soft jaw / far-cheek shadow — no dark facet wedges across the nose and cheeks — in PBR, Gouraud, Cel, Cel HD and toon shadows. See [character-shading.md](character-shading.md#anime-face-shading--matte--hair-band--play-outlines-2026-10-03). |
| Skin + cloth | **matte** (`matte: true` → `setCharacterMatte3D`): no specular on the skin or any garment, so no glossy plastic streaks in Cel HD. Hair keeps its sheen. |
| Hair | the sheen drawn as **one highlight band** in Cel / Cel HD (`hair.sheenBand: true`). |
| Bang hairline | `hairlineFront` **0.28 – 0.46** (was 0 – 0.40). Below ≈0.25 the cap cards hung over the eyes on ≈40 % of seeds; now ≥ 90 % of seeds keep the fringe above the eye line (asserted on the generated hair). |
| Under-eye dots | **off** (`underDeco: false`). At face / Play distance the row of tiny accent dots read as stray white "°°°" specks on the cheeks (seeds 18, 32). The Eyes panel's Under-eye toggle still turns it on. |

Every other field of a seed is unchanged (the hairline keeps its draw, the dots keep theirs). `createFullCharacter3D` gained
`matte?: boolean` (omit = unchanged). **Chunky hair is not the random default:** with the random style ranges (no bangs, card
cap) chunky mode reads as a smooth helmet / hood with "cat ear" side points, and with bangs it is a row of small teeth — the big
solid P5 locks need the open hair-styles phases (B–E). Cards + the highlight band are the better default until then.
**Saved characters load exactly as they were** — every one of these is a saved param / material field, absent on old saves
(= the classic look); verified by a save → reload → pixel diff (0 for a new character; the old look matches a stripped save).

> **Frogmarks:** `illustration.component.ts` `_randomizeCharacterInputs()` still has its own ranges (eye width 0.15–0.45 / height up to 0.7×width, 40 % bottom lash, Crop −0.10…0.85, no capLayers/thickness/rim). Replace `scene3dGenerateCharacter()`'s randomize + `createFullCharacter3D` with `createRandomCharacter3D` (or `randomCharacterParams3D`), keep the bias-from-reference-character nudges on top if wanted, and set `scene3dCharRimLight = true` in `_syncCharEquipState`.

### In a city: real human size + spawned where you look ✅ (2026-10-01)

The generator builds a body about 0.75–1.7 units tall (height slider 0.5–1). A city is built at `cityMetresPerUnit()`
(about 15 m per unit), so a generated character used to be a 10–25 m giant there. Now, **while a city exists**:

- **Size.** Every NEW procedural character (`createFullCharacter3D`, `createRandomCharacter3D`, `createProceduralBody3D`,
  and a `character` asset-library instantiate) is scaled uniformly on its body transform to stand **1.7 m** tall,
  whatever its height slider. Proportions (head size, leg length, …) are unchanged. The skeleton follows the body
  transform and every overlay rides that skeleton in body space: face decal and eyes, hair (and its spring bones, which
  scale with the joint), garments and charms. So the whole character is consistent, and regenerating a part later (a
  hair or clothing slider, `setBodyParams3D`) keeps the size. It is an ordinary node scale: it is saved, and the gizmo
  can still change it. The Play auto default player is unaffected (it scales itself per run).
- **Spawn.** In a city, a default position (none, the origin, or `getIllustrationCenter3D()`, which is what Frogmarks
  passes and means nothing in a free-3D city) becomes **the floor the camera is looking at**: the first floor-like
  surface along the view ray. If the ray meets a facade first, the character stands on the pavement just in front of
  it. Looking at the sky, it stands on the ground under the camera target. Characters and far decoration (the sky
  clouds, the void grid) are never spawn surfaces. Any other explicit `position` is honoured as-is.
  `sm.scene3d.resolveCharacterSpawn3D(position?)` returns that point.
- **Live preview == result.** The ghost from `previewProceduralBody3D` uses the same rules: in a city it is drawn at
  the same 1.7 m scale (the same factor, computed from the same rest-geometry height) and stands on the same floor point
  a default-positioned Generate would use (`resolveCharacterSpawn3D`). It stays cheap on slider drags: the scale is one
  pass over the vertices per preview call, and the view-ray floor cast is cached per camera pose (re-cast only when the
  camera moved, at most every 120 ms while it moves). If the host commits with an explicit non-default `position`, the
  character goes there instead (the preview can't know it). Clothing / hair / eye edits have no separate preview: they
  regenerate live on the already-scaled body, so they are always at its size.
- **Outside a city** nothing changes (the generated size, at `position`; the ghost at the camera's look-at point).
- **Older giant characters** in a city save stay as they are. Scale the body down with the gizmo (every part follows).
  As a Player they now frame correctly too (see play-mode.md §Third-person camera).

> **Frogmarks:** no change is required. `scene3dGenerateCharacter()` already passes the illustration centre, which the
> engine now resolves. Optionally, after Generate in a city, frame the new character (it is 1.7 m and may be small on
> screen from an overview camera).

Tests: `play-auto-player.test.ts` §"2026-10-01" (1.7 m in a city for height 0.5 and 1, the skeleton and parts follow, a
hair regenerate keeps the scale, no city means unchanged, the spawn rules).

**Feet on the floor (2026-10-04).** The body's origin sits at its HIPS (the legs extend below it), so placing the origin
on the floor point used to bury the feet about 0.37 m into the street (Play hid it: the controller measures the feet).
A new city character now stands its **soles** on the spawn point, and the ghost preview uses the same lift. A/B:
`Scene3DManager.citySpawnFeetOnFloor = false`.

### Scaling a character ✅ (2026-10-04)

There are two size knobs, and they do different things:

| | **Height** body param (`setBodyParams3D(id, { height })`) | **Scale** (`setCharacterScale3D(id, s)`) |
|---|---|---|
| What changes | Re-makes the body: geometry + skeleton rest pose, then refits clothes, hair, face kit, eyes, charms | One uniform node scale on the body. Nothing is regenerated |
| Proportions | Same (height is a uniform factor; leg length / head size are their own sliders) | Same |
| Cost | A full refit (debounced on a slider drag) | Instant |
| Use it for | Designing the character | Fitting it to a scene: a city, a doll house, a kaiju |

Both keep every part attached and aligned (verified at 0.5×, 1×, 2×, height 0.5 / 1.5 and a 1.7 m city fit: clothes,
hair, glasses and face features stay in place; screenshots in the 2026-10-04 drive). Both keep the **feet on the
ground**: the soles stay at the same world height (before this, a height edit or a gizmo scale grew the body about its
hips, so it sank into or floated above the floor).

Why the scale works with no regeneration: the body's transform drives its skeleton (`transformViaSkeleton`), and every
overlay (face decal, eyes, face kit, hair, garments, charms) is skinned to that skeleton, so they all scale together.
Spring bones scale their lengths, collider radii and gravity with the joint scale. The scale is an ordinary node scale,
so it is **saved** with the body node and reloads identically (saved characters load unchanged).

```ts
sm.getCharacterScale3D(bodyId)
// → { scale, height, heightMetres, restHeight, metresPerUnit, sceneMetresPerUnit } | null
//   scale = the uniform factor (1 = the generated size); height = standing height in world units (rest pose, body only);
//   heightMetres = height × metresPerUnit (the city's scale in a city, else 1 unit = 1 m);
//   restHeight = the height at scale 1 (what the Height param gives); sceneMetresPerUnit = null outside a city.
sm.setCharacterScale3D(bodyId, 2);          // the whole character 2×, feet planted, one undo step → true
sm.setCharacterHeight3D(bodyId, 1.55);      // stand 1.55 m tall (metres); ('units') for world units → the new scale
sm.fitCharacterToScene3D(bodyId);           // "Fit to city": 1.7 m at the scene's metre scale → the new scale
sm.fitCharacterToScene3D(bodyId, 1.2);      // a 1.2 m child
```

- Clamped to 0.01–1000. Keeps any authored axis ratio (normally 1:1:1).
- **In Play** it applies live: the camera re-frames, the eye height, collision capsule and stride follow (see play-mode.md
  §Character size), and the new size is kept after Stop.
- **Gizmo / S shortcut:** scaling a character body is always **uniform and from the feet** (an axis handle, a corner
  handle or `S`+axis scales all three axes by the dragged factor). Selecting a part (hair, a garment) and scaling it does
  nothing, since the part's own transform is not used. Undo works as for any gizmo move.
- **Fit to city** outside a city uses 1 unit = 1 m (the default body is about 2.09 units = 2.09 m at height 1).

> **Frogmarks:** character panel, **Size** group above Proportions: **Scale** slider (0.25–4) + number box, **Height (m)**
> box and **Fit to city** (enabled when a city exists). Calls are guarded `(shapeManager as any).fn?.()`.

Tests: `src/game/character-scale.test.ts` (feet-anchored scale, the gizmo constraint, the capsule + camera framing
following the size, the scale through toJSON / the loader), `locomotion-animator.test.ts` §"character scale" (planted
feet at 0.25×–3×).

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

**Auto-blink panel (eye settings):** a **☑ Auto-blink** checkbox + **Frequency** (min/max s), **Blink speed** (`holdMs`), **Double-blink %** (`doubleProbability`), and **Double gap** (min/max ms). `setAutoBlink3D` **auto-creates a closed-eye blink frame** from the active eyes (`closed: true`) the first time you enable it on procedural eyes, so the user never has to draw/mark a blink state — the toggle just works. (Manual `setFaceBlinkExpression3D` is still there if someone wants a hand-drawn blink.) **The blink frame follows the open eyes** (2026-09-29): whenever the active state's eye settings change, or a different state becomes active, the closed-eye frame is re-drawn from them. So turning off the deco dots, changing the lash colour or moving the eyes carries into the blink. Before this, the blink was a one-time copy, and old settings flashed back during every blink. Characters saved before the fix repair themselves on load. To give the blink its own settings, use `setFaceBlinkConfig3D(id, { followOpenEyes: false })`. Hand-drawn blink frames are never changed.

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

### 2.5b Face kit: brows, mouth, nose, hair shadow, blush ✅ (2026-10-03)

The rest of an anime face, on top of the eyes: **eyebrows**, a **mouth** with simple expressions, a **nose** tick or shadow, the
hair's hard **shadow across the forehead**, **blush** and soft **cheek shading**, plus an upper-lid shadow on the eyes. Everything
is generated from parameters (no drawing) and follows the head through every pose. Engine: `face-features.ts` (pure) +
`Scene3DCharacter` (meshes, textures, expressions). Spec: visual-polish-next.md item 2.

**How it looks right in every style.** Two extra skinned overlays are raycast onto the head surface (so they hug the faceted face
and use the body's own skin weights): a *skin layer* (shadow, nose, mouth, blush) and a *brow layer*. Their textures are colour
**multipliers**, drawn with a **multiply blend** after the skin. They darken whatever the skin rendered — PBR, Cel, Cel HD, toon
shadows, the skin ramp, ink — so a brow in shade is a brow in shade. Brows (and, when bangs hang over them, the eyes) are drawn
**through the hair fringe** by a small depth pull toward the camera (flags2 bit 6); the screen position is unchanged, so nothing
further in front is affected. Lines get bolder automatically when the face is small on screen (Play distance) and return to the
close-up weight as you approach.

```ts
const p = sm.getDefaultFaceFeatures3D();             // seed the Face panel
sm.setFaceFeatures3D(bodyMeshId, { browStyle: 'arched', browThickness: 0.7 });   // live patch; persists
sm.getFaceFeatures3D(bodyMeshId);                    // a copy, or null (kit never turned on)
sm.setFaceFeatures3D(bodyMeshId, { enabled: false }); // hide (params kept); the eyes go back to classic
sm.getFaceFeatureOptions3D();                        // { browStyles, noseStyles, expressions } for dropdowns

// Expressions (runtime; the RESTING one is the `expression` param)
sm.setCharacterExpression3D(bodyMeshId, 'smile');                          // 'neutral' | 'smile' | 'open' | 'frown' | 'surprised' | 'default'
sm.setCharacterExpression3D(bodyMeshId, { smile: 0.6, open: 0.3 }, { blendMs: 250 });   // a blend
sm.setCharacterExpression3D(bodyMeshId, 'surprised', { holdMs: 1200 });   // then back to rest
sm.getCharacterExpression3D(bodyMeshId);             // { name, weights }
sm.pulseCharacterBrows3D(bodyMeshId, 0.5);           // a quick brow raise
```

| Group | Params (FaceFeatureParams) |
|---|---|
| Brows | `browStyle` soft / straight / arched / angled / short · `browThickness` 0–1 · `browLength` 0.5–1.5 · `browHeight` 0–1 · `browTilt` −1–1 · `browColor` ('' = follows the hair) · `browsThroughHair` |
| Mouth | `mouthWidth` 0.2–0.9 (× eye spacing) · `mouthThickness` · `mouthHeight` (nose → chin) · `mouthColor` ('' = warm dark line) · `expression` (resting) |
| Nose | `noseStyle` none / tick / shadow / dot / button · `noseSize` |
| Shading | `blush` + `blushColor` + `blushLines` · `cheekShade` · `hairShadow` + `hairShadowDepth` · `eyeShade` (how much scene light reaches the eyes; 0 = classic full-bright) |
| Eyes | `eyesThroughHair` (eyes visible through bangs; **default OFF since 2026-10-03**: bangs cover the eyes, and the brows hide with them. Frogmarks: Face → Shading → "Eyes over hair") — and on the eye params: `lidShadow` / `lidShadowColor` (EyeParams, optional) |
| Life | `lifeBrowRaise` (chance a blink comes with a brow raise) · `lifeSmile` (an occasional short smile while idle) |
| Render | `pixelResolution` (−1 = match the eyes' chunky look, 0 = crisp) |

**Brow colour** follows the hair's root colour (darkened, and always darker than the skin so blond / white hair still gets
readable brows). Custom brow / mouth colours are converted to multipliers for the current skin tone (a skin-tone change re-paints).

**Life + clips.** Blinks sometimes come with a brow raise; now and then an idle character smiles for a second or two (only from a
neutral rest). Clip face events gained `expression` / `weight` / `browRaise` (`ClipFaceEvent`); a clip's `restore` returns to the
resting expression. The default clips use them (Wave smiles, Stretch yawns open, Scratch Head frowns a little, Talk Gesture
alternates open / smile) — clips are baked at creation, so characters made earlier keep their old clips.

**Random characters** (`randomCharacterParams3D` / `createRandomCharacter3D`, the T6 ranges) now carry a `face` set: random brow
style / weight / height / tilt, mouth width, resting expression (mostly neutral), nose style, blush. It draws from its own
seed-derived stream, so every other field of a seed is unchanged. `createFullCharacter3D({ face })`: omit → defaults, `false` →
eyes only.

**Persistence.** Only the params are saved (`faceRigs[].features`); the overlays regenerate on load. **Faces saved before the kit
load exactly as before** (eyes only, classic full-bright eyes, no lid shadow) — the kit is opt-in for them: the Face panel's first
change (any `setFaceFeatures3D` call) turns it on with the defaults. `.frogchar` presets carry the kit (`face.features`). Params
are rounded to 1e-4 so a save reloads identically.

**2026-10-03 face shading follow-up.** The big dark wedges across the nose and cheeks in Cel / Cel HD were the BODY's shading of
the low-poly head, not the kit — fixed by the anime face normals ([character-shading.md](character-shading.md#anime-face-shading--matte--hair-band--play-outlines-2026-10-03)).
The same fix removes the "bright pasted rectangle" on the forehead under a gappy fringe in Cel HD (seed 25): it was the lit cel band
of a few forehead facets aimed at the light, framed by the hair-shadow polygon; with one flat face plane the forehead is the same
tone as the rest of the face and the hair shadow reads as a band under the fringe. The `'shadow'` nose style's side shadow is
shorter (0.75 instead of 1.5 nose sizes up the bridge, alpha 0.6) — on a flat face the long one read as a facet wedge again.

**Limits.** Lip-sync is out of scope (mouth shapes are expression blends). The hair shadow follows the fringe's rest shape (not the
spring-animated hair). Multiply can only darken, so a brow lighter than the skin clamps to the skin. Expression changes re-paint
two canvases (≈ a few ms per frame during a 180 ms blend).

**Anime head shape + chin shadow (2026-10-04).** New bodies get `BodyParams.headShape: 1` (in `NEW_BODY_DEFAULTS`; absent / 0 =
the classic head, bit-identical, so saved characters are unchanged). The classic head was circular rings tapering in a straight
line to a pointed jaw (a wide flat diamond with a spike chin from the front). The anime head keeps the **same topology** (rings,
UVs, weights), so the eye decal, this face kit's raycast, the hair head map and the clothing read it unchanged, but it has
elliptical rings (flatter face, fuller back of the skull), a rounder cranium, cheeks that stay full to the mouth, a **soft
V-line** jaw (the jaw rings rise from the chin toward the ears) into a small rounded chin, a smaller nose and no gonial corner.
`headShape` 0..1 blends between the two. With face normals on, the neck under it gets a shaped **chin shadow** instead of the
old grey band (see [character-shading.md](character-shading.md#anime-head-chin-shadow--the-neck-2026-10-04)). Tested:
face-features.test.ts "face kit placement on the anime head" (the overlay hugs the face, the mouth / nose / eye / brow rows land
on the face front, centred). Before / after sheets: agent scratchpad `pupdrive/look2/after/cmp-*.png`.

```ts
sm.setBodyParams3D(bodyId, { headShape: 1 });   // 0 = classic head, 1 = anime head (new bodies); regenerates in place
```

---

## 2.6 Procedural hair ✅ (available now)

Generate **chunky low-poly hairstyles** from presets + sliders — same flow as the body and eyes. A style skins to the **head joint** (follows poses), uses a **root→tip gradient** (the reference's blue tips), and can **bake into a kitbash hair part**. v1 covers the reference-girl set (cap + bangs + parting + twintails/ponytail/pigtails). **UI hand-off doc (build the panel from this): [hair.md](./hair.md).** Engine design: [hair-generation.md](../specs/hair-generation.md).

> **Status (2026-10-04):** named anime **styles** ✅ (below). **(2026-06-28):** live generator + sliders ✅, **persistence** ✅, **bake-to-part** ✅, **card mode** ✅ (Elden-Ring alpha-card hair), **Length / Curl / Layering** ✅ (Phase A — bob / long / hime / curly / wolf). **Named style presets** (Bob/Bun/Braid/etc.) are the 🔶 remaining piece (spec [hair-styles.md](../specs/hair-styles.md), phases B–E). See [hair.md](./hair.md) for the param→control mapping.

Panel (Edit Character → Hair): preset dropdown → sliders → live update; **Save as hair part**.
```ts
getHairPresetNames3D();                         // ['Twintails','Ponytail','Pigtails','Bob','Long']
setHairParams3D(bodyMeshId, params);            // build/update hair, live (per slider change)
bakeHairToPart3D(bodyMeshId, name);             // → GLB + kitbash hair slot
```

---

### Hair styles: big anime locks ✅ (2026-10-04; [hair-styles.md](../specs/hair-styles.md) phases B–E)

A third hair mode, `hairMode: 'locks'` (engine `src/services/managers/hair-locks.ts`): the hair is a few dozen big
**shaped locks** (tapered lens-section ribbons with pointed or blunt tips) over a solid scalp shell that hugs the real
skull, instead of alpha cards (ragged, noisy) or one dome (a helmet). Style parts:
- the crown + back mass (1 or 2 layers of tips at different lengths);
- the **fringe**: straight, side-swept, parted, choppy, or none (slicked back);
- face-framing **side locks**;
- **ponytail / twintails / low twins** (a bundle of locks on a spring-bone chain);
- **gathered** (pulled-back) hair, a **bun**, an **ahoge**.

It is opaque solid geometry, so it works in PBR, Gouraud, Cel, Cel HD, toon shadows and ink; the Cel / Cel HD highlight
band (`sheenBand`) runs along the locks. 5k to 9k triangles per style. The body + clothing shrink-wrap and the face kit's
fringe detection work as for the other modes. Eyes are visible by default; `eyesThroughHair` stays false, so a fringe
pulled below the eyes hides them.

```ts
sm.getHairStyles3D();                          // [{ name: 'bob', label: 'Bob' }, 'long-straight', 'side-swept', 'ponytail', 'twintails', 'short-messy', 'bun', 'hime']
sm.getHairStylePreset3D('hime', lockSeed?);    // full HairParams (hairMode 'locks', sheenBand on), or null
sm.applyHairStyle3D(bodyId, 'ponytail');       // apply a style, keeping the hair colours; false for an unknown name
sm.setHairParams3D(bodyId, { ...p, fringeStyle: 'swept', fringeHeight: 0.28 });   // then fine-tune live
```

| Param (locks mode) | Meaning | Range |
|---|---|---|
| `fringeStyle` | `straight`, `swept`, `parted`, `choppy`, `none` (slicked back) | |
| `fringeHeight` | fringe tip line, × head ry above the head centre (about 0.3 = above the eyes; below about 0.15 covers them) | −0.2..0.6 |
| `fringeCount`, `fringeSide` | bang locks; sweep direction / part position | 3..11; −1..1 |
| `hairLength`, `sideLength` | back / side hem depth below the head centre (× ry): 0.3 nape, 0.75 bob, 3 mid-back | 0..4.5 |
| `lockCount`, `lockWidth`, `lockThickness` | crown locks (fewer = chunkier), width overlap, depth | 8..24; 0.6..1.6; 0.1..0.6 |
| `lockVolume` | stand-off from the skull | 0..0.3 |
| `lockTaper` | 0 blunt cut (hime), 1 sharp points | 0..1 |
| `lockLayers`, `lockFlick`, `lockJitter` | 1 or 2 tip layers; −1 curl under to +1 flick out; messiness | |
| `tailLocks`, `gather`, `ahoge`, `lockSeed` | locks per tail; pull the hair into the tail / bun tie; antenna locks; variation seed | |
| `lockCurl`, `lockCurlType`, `lockCurlFreq` | curl / wave on the hanging crown, side and tail locks: `wave` (S-waves) or `spiral` (ringlets); waves per head height | 0..1; ; 0.5..6 (2) |
| `lockSpike` | shonen spikes: the crown locks jut out from the skull instead of hanging | 0..1 |
| `hairPoof` | curly volume: a big round mass (the locks stand off and bulge out) | 0..1 |
| `tailForm`, `drillTurns` | each tail as a `bundle` of locks, a 3-strand `braid` or a `drill` curl; drill coil turns | ; 2..7 (4) |
| reused | `tailStyle`, `tailHeight`, `tailLength`, `tailThickness`, `tailSpread`, `tailCurl`, `tailTaper`, `sideLock*`, `bunStyle`, `bunSize`, `hairlineFront`, colours, `sheen`, `sheenBand` | |

**More styles (2026-10-04, part 2):** `braid` (one low back braid), `twin-braids`, `wavy`, `curls` (spiral ringlets),
`spiky`, `drills` (twin ojou drill curls) and `curly-volume` — 15 styles in all, every one 3.6k to 9.2k triangles, with
the body + clothing collision, the face kit's fringe detection, and the eyes behind the hair by default (`eyesThroughHair`
off). Random characters pick a style by weight (`HAIR_STYLE_WEIGHTS`: everyday styles common, drills / curly volume
rarer). Spec: hair-styles.md "part 2".

**Which controls apply (the "Styled hair shows controls that do nothing" fix).** Each hair build reads its own keys:
`hair-control-modes.ts` exports `HAIR_CONTROL_MODES` (key → the modes that read it), `hairControlVisible(key, hairMode)`
and `hairControlVisibleFor(key, params)` (also hides Sides / Flick / Messiness / Layers / Spikes while Styled hair is
**gathered** into a tail or bun, since the gathered build replaces the loose crown). Show a control only when it returns
true; a unit test perturbs every key in every mode against the generator.

| Group | Styled (`locks`) | Chunky | Cards |
|---|---|---|---|
| Style picker + Vary, Fringe, Length + locks, Curl + volume, Tail form / drill turns / tail locks | ✓ | – | – |
| Crown, Hairline, Buns (Styled: one bun at the back, size 0.15–1.2), Facial hair, Side locks, Tails (style / height / spread / length / thickness / end taper / curl), Colour, Sheen + Highlight band | ✓ | ✓ | ✓ |
| Cap (V offset, thickness, volume, sweep, back length), Spiky cap, Buzz, Undercut, Length / Curl / Layering, Bangs, Start taper, Front drape, Chunkiness | – | ✓ | ✓ |
| Tail tip (point / flare / blunt) | – | ✓ | – |
| Card width / per clump / segments / strand density / alpha cutoff, Cardify cap, Cap layers, Detail | – | – | ✓ |

- **Compatibility:** saved hair (`cards` / `chunky`) loads unchanged. The style fields are ignored outside `locks` mode
  (unit-tested: identical geometry). Only new random characters, Frogmarks' Generate Hair, and choosing a style use it.
- **Spring bones:** the tails are tagged per tail exactly like the classic tails, so the existing hair jiggle
  (off by default) swings ponytails / twintails. Long loose locks are head-skinned (no jiggle yet). That is a later
  pass: they need a rigid scalp part like the front drape (`DRAPE_SPRING_FROM`) or they peel off the head.
- **Frogmarks:** Edit Character → Hair: **Hair type** (Styled / Chunky / Cards) first, then the **Style** picker +
  **Vary**, then (Styled) Fringe, Length + locks, Curl + volume; every group below shows only the controls the chosen
  build reads (the table above).
- Screenshots: agent scratchpad `pupdrive/hair/` (`sheet-before-*.png`, `after-*.png`, `presets-*.png`, `styles.png`).

---

## 3. Proportions from a drawing 🔶 (engine pending)

Instead of sliders, let the user **draw a front-view silhouette**; the engine solves the generator params to best match it ("draw your body type"). Same `createProceduralBody3D` output. UI: a 2D draw surface + a **Fit to drawing** button. (Spec §3 / §6 "silhouette → param fit".)

---

## 4. Clothing creation ✅ (procedural generator available now)

> **Built (2026-06-23 · shoes + baggy-stack 2026-06-28):** clothing is a **procedural generator** (presets + sliders → low-poly garments auto-rigged by joint-blend weights), matching the body/eyes/hair flow. **Three slots — Top · Bottom · Shoes** (footwear wraps the `foot_L/R` joints). Flat/gradient color. Garments **enclose the body, never clip** (directional fit + shrink-wrap + min-gap) and **deform with the body** when posed. NEW: pants **`stack`** (baggy/accordion) + the **§6b shoe-floor coupling** — baggy pants **pile ON the equipped shoe**, never clipping. Live, persisted, bake-to-part. **Build the panel from [clothing.md](./clothing.md)** (now incl. the **Shoes** tab + **Stack**); engine details in **[clothing-generation.md](../specs/clothing-generation.md)** + **[shoe-generation.md](../specs/shoe-generation.md)**.
>
> **Next (🔶):** procedural **hems/cuffs/trim** + **UV-paint** garments (prints/seams) + **draping**; then the **Clothing Designer** (design standalone on a mannequin → save as a preset → fit to any character — see clothing-generation.md §14).

### Skirts & dresses follow the legs ✅ (new 2026-09-30, polish-round-3 R6.3)

Skirts used to be skinned rigidly to the pelvis, so walking, running, climbing stairs or sitting pushed the thighs straight through the fabric. Measured over the default Walk and Run cycles plus a stride, lunge, stair step, high knee, sit and side step, the thighs went 47–53 mm into the old skirt. The skirt now swings with the legs.

**What the user sees:** the front of the skirt drapes over the forward leg, and the back over the trailing leg. A knee or long dress hem follows the calves. The fabric stretches between the legs in a stride instead of the legs clipping through. Nothing to set up: every skirt does it, including skirts on saved characters, which rebuild from their params on load.

**Knob (optional):** `legFollow` on the bottom params (skirt only). `1` is the default (and what a saved skirt without the field gets). `0` gives back the old rigid skirt, bit-identical.
```ts
sm.setClothingParams3D(bodyId, { ...sm.getClothingParams3D(bodyId, 'bottom'), legFollow: 0 });   // old rigid skirt
```
A UI slider isn't needed. If Frogmarks wants one, label it "Follow legs" (0–1).

**Rest look is unchanged.** Only the ANIMATED deformation changes. The skirt is fitted exactly as before, then subdivided along its length. The new rings lie on the old surface: a test checks every vertex is within 2 mm of it.

**How it works (two parts):**
1. **Static leg weights** (`clothing-generator.ts` `applySkirtLegWeights`). This is the standard game technique. Below the waist, each skirt vertex blends from the pelvis onto both thighs:
   - **Left or right:** set by where the vertex sits around the body. The front and back centre lines are 50/50; the sides follow their own leg.
   - **Height:** the blend fades in from just above the hip joint and is fully leg-driven 40% down the thigh.
   - **Knees:** below the knee, the hem takes part of the lower leg's weight. The back takes more of it, because a bending knee folds the calf into the back hem.
2. **Pose-driven steer** (`skirt-steer.ts`, applied each frame by `Scene3DCharacter`). Fixed weights can't fix the centre lines. In a stride the two thighs rotate opposite ways, so a 50/50 vertex stays put and the forward thigh pokes through the front. So each frame one number is read from the skeleton: the difference in forward pitch between the two thighs. That number shifts the front panel's weights toward the forward thigh and the back panel's toward the trailing one.
   - When the legs are level (rest, idle, sit, squat, side splits) the number is 0 and the weights are exactly the static ones.
   - Cost: the weights are only rewritten when the number moves by 0.04. Each rewrite re-uploads one skinned vertex buffer of a few hundred vertices. The callback measured ~0.00 ms per frame in the browser.
   - There are no new joints, no shader change and nothing persisted.

**Measured** (`skirt-leg-follow.test.ts`; worst depth into leg capsules fitted to the body's skin, over vertices and triangle centroids; new character):

| Skirt | Old rigid skirt: walk / run / worst | Now: walk / run / worst |
|---|---|---|
| Skirt (mid-thigh) | 0 / 10 / 53 mm | 0 / 0 / 0 mm |
| Mini Skirt | 0 / 0 / 47 mm | 0 / 0 / 0 mm |
| Knee-length dress | 51 / 51 / 51 mm | 0 / 0 / 0 mm |
| Ankle-length dress | 48 / 45 / 51 mm | 0 / 23 / 23 mm |

The clothing ROM gate (`clothing-regression.test.ts`) also improved for the Skirt, from poke 8% / 21 mm to 2.6% / 4.8 mm, with 0 excess tear. Its limit row was tightened.

**Limits:**
- **Stretch.** A skirt that follows both legs has to stretch between them. Up to 10–15% of a long dress's triangles stretch past 2× in a stride. That is fine on flat colours; a pattern will visibly stretch there. Almost no triangles fold (≤ 1.3%).
- **Long dress, running.** One residual clip remains: when running in an ankle-length dress, the swinging leg's calf is folded back under the hem at the moment the thighs cross (23 mm, 2 frames per stride). A calf-driven steer was tried and not kept, because it made a high-knee pose worse.
- **Saved (classic) characters** use linear skinning, which blends less cleanly. A knee dress still clips up to 17 mm running on those; walking is clean.
- **No fabric physics.** There is no sway or inertia. VRM-style skirt spring bones would add that later: they need new skirt joints in the skeleton, the same way hair tails and charms add theirs.

### Fit round 2: hide body under clothes, layer order, lining, skirt swing ✅ (2026-10-04)

Engine details and measurements: [clothing-generation.md §16](../specs/clothing-generation.md).

**What the user sees:**
- Running in trousers no longer shows the knees or the front of the thighs through the fabric. A long skirt no longer shows the knee cap through its front panel.
- The inside of a skirt (or of a top at the neck and sleeves) draws as fabric in shadow, not a white sheet.
- A top's hem always sits over the skirt or trouser waistband.
- Long hair rests on the shirt's back instead of sinking into it.
- In Play, a skirt's hem trails behind when running, swings past centre and settles on a stop, and flares on a jump or a quick turn. It never pushes into the legs.

**Two options for the character panel.** Both are already on for every character, so a panel doesn't need them to get the fixes:

| Control | Call | Notes |
|---|---|---|
| **Hide body under clothes** (checkbox, default on) | `sm.getHideBodyUnderClothes3D(id)` / `sm.setHideBodyUnderClothes3D(id, on)` | Skin that the opaque clothes cover, and keep covering through a set of probe poses, isn't drawn. Turn it off for a see-through look. It is persisted on each garment (`hideBody`). It takes effect about ¼ s after the outfit stops changing, and the body draws in full until then. |
| **Skirt swing** (slider 0–1.5, default 1; skirts only) | `sm.getSkirtSwing3D(id)` (null without a skirt) / `sm.setSkirtSwing3D(id, v)` | Play only. 0 = off. It is persisted as the bottom's `hemSwing`, with no garment rebuild. If the panel keeps its own copy of the bottom params, set `hemSwing` on it too. Otherwise the next slider change sends the old value back. |

**Saved characters** regenerate sensibly; they are not byte-identical.
- New characters' bodies get smoother hip and thigh weights, which changes skinning only. Joints, poses and animations still match.
- Classic bodies are unchanged.
- Every garment gets the mask, the lining and the layer order on load.
- Skirts get the swing at 1.

**Limits:**
- The mask is conservative near openings. Skin within 5 cm of a hem, cuff or neckline is always drawn.
- On a narrow torso with very wide shoulders (Torso 0.9, Shoulders ≥ 1.4), 1–4 skin verts still show deep in the front armpit crease. Hiding them would open a hole when the arms reach forward.

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
| **Joint smoothness** slider (`seamBlend`, 0–1) | `setBodyParams3D(id, { seamBlend })` | ✅ engine built 2026-09-28 — garments inherit it automatically |
| **Joint blending** toggle (Linear / Dual quaternion) | `setSkinningMethod3D(bodyId, 'linear' \| 'dualQuat')`, `getSkinningMethod3D(bodyId)` | ✅ engine built 2026-09-28 — per character (body + clothes + hair switch together); new bodies = dual quaternion |
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
| ↳ **Face kit** (brows / mouth / nose / hair shadow / blush) | `setFaceFeatures3D` / `setCharacterExpression3D` | ✅ (§2.5b; params persist, old faces opt-in) |
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
