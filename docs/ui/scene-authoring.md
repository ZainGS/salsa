# Frogmarks UI Integration Guide — Driving Salsa from the UI

**Audience:** Frogmarks (Angular host) developers building panels/tools so **users** can do everything the AI can — directly in the UI, not only via prompts.

**Date:** 2026-08-19 · Companion to `docs/specs/god-object-status-and-mcp.md` (the AI surface).

---

## 0. The one thing to know

Frogmarks already holds a **`ShapeManager`** instance (`sm`) — the single public entry point to the whole engine. Everything below is a method on it. There are two consumer surfaces:

- **AI surface** = `sm.authoring` (`SceneAuthoringAPI`) — a *thin curated* façade (~90 verbs). Great for the AI; too coarse for a full UI.
- **UI surface** = `sm.*3D(...)` methods **directly** — the granular API. **Build UI panels against these.**

Every create verb returns the new node (or its `.id`). Every op is **undoable** via `sm.undo3D()` / `sm.redo3D()`. State changes fire `sm.scene3d.onSceneGraphChanged` — subscribe to refresh your outliner/panels.

> **What already has engine-native UI:** Edit-Mesh mode, transform gizmos, the outliner, the Creator modes (Character/Building/Package/etc.), material panels, animation timeline. Frogmarks mostly needs to **surface** those. The **new** capabilities (parametric shapes, boolean, displace, vertex bevel) need **new** panel buttons — those are called out with 🆕.

---

## 1. Add objects (primitives + parametric shapes)

A "Add Mesh ▾" menu → each item calls one method, then selects the result.

| UI item | Method | Notes |
|---|---|---|
| Box | `sm.createBox3D(x,y,z, w,h,d, material?)` | |
| Sphere | `sm.createSphere3D(x,y,z, radius, segments, material?)` | |
| Cylinder | `sm.createCylinder3D(x,y,z, radius, height, radialSegments, material?, radiusTop?)` | `radiusTop` 🆕 = taper |
| 🆕 Cone / taper | same, with `radiusTop: 0` (cone) or `< radius` (frustum) | |
| Torus | `sm.createTorus3D(x,y,z, radius, tubeRadius, material?)` | |
| Plane | `sm.createPlane3D(x,y,z, w,h, material?)` | |
| 🆕 Revolve (lathe) | `sm.createRevolve3D(x,y,z, profile, radialSegments, material?)` | `profile` = `[radius,y][]` — see §1a |
| 🆕 Tube / loft | `sm.createTube3D(x,y,z, path, radii, radialSegments, material?)` | `path` = `[x,y,z][]`, `radii` per-point |
| 🆕 Metaballs (organic) | `sm.createMetaballMesh3D(x,y,z, blobs, resolution?, material?)` | `blobs` = SDF primitives that smooth-fuse — see §1b |
| 🆕 Creature | `sm.createCreature3D(params, x,y,z, resolution?, material?)` | parametric animal — see §1b |
| Custom geometry | `sm.createCustomMesh3D(x,y,z, geometry, material?)` | for imports / CSG results |

**Import:** `sm.importObjFile3D`, `sm.importGltfFile3D` (async).

### 1a. Profile / path editors 🆕
Revolve and tube are the big new "smooth shape" tools and deserve small 2D editors:
- **Revolve profile editor** — a 2D canvas where the user drags `[radius, y]` points (the silhouette); on change call `createRevolve3D` (or rebuild). radius 0 at an end = a point/tip.
- **Tube path editor** — points along a spine + a radius slider per point. Great for horns/pipes/branches.
Both persist params-only (regenerate on load), so the editor can round-trip from the saved node's config.

### 1b. Organic: metaballs + creatures 🆕
The SDF/metaball path makes **organic, branching** forms (creatures, slime, coral, clouds) that box-modeling can't.

- **Metaball editor** — a list panel of blobs, each a row: shape (sphere/capsule/ellipsoid/box/torus), position `a` (+ `b` for capsules), radius, `blend` (fuse smoothness), and a `subtract` toggle (carve). A drag-in-viewport gizmo per blob is ideal. On change → `sm.createMetaballMesh3D(x,y,z, blobs, resolution)`. Higher `resolution` (8..96) = smoother but slower — expose a slider with a "draft/final" toggle (low res while dragging, high res on release). **Perf:** it's O(res³); keep the live-edit resolution low. (Worker offload is planned — Phase 1b in the spec.)
- **Creature panel** — the easy path: a species dropdown (`sm.creatureSpecies?()` → dog/cat/horse/lizard/generic — or hard-code) + sliders for `bodyLength / bodyRadius / legCount(4|2) / legLength / neckLength / headSize / tailLength / tailCurl / earSize / blend`, plus a **`seed`** field with a "🎲 Randomize" button (deterministic proportion variety — same seed = same individual), a **`roughness`** slider (skin/scale/fur relief via displace), and an **`eyes`** checkbox (default on — adds dark eye spheres). On change → `sm.createCreature3D(params, x,y,z, resolution)`. This is the "make me a dog" tool for users — no blob-wrangling.
- **Roughness:** run `sm.addDisplaceModifier3D` on a metaball/creature result for skin/scale/fur bump.
- Both persist **params-only** (blobs/creature params in config → regenerate on load), so the editor round-trips from the saved node.
- **Rig toggle 🆕:** pass `rigged: true` to `createCreature3D` — it builds a matching bone skeleton and binds the mesh (upgrading it to a SkinnedMesh with the same id). Add a "Rigged" checkbox to the creature panel; when on, the creature becomes poseable/animatable with the §7 rig panels (`sm.getSkeletonIdForMesh3D(meshId)` → its skeleton → pose/clip tools). *(Note: rigged creatures persist as baked geometry rather than params-only.)*

---

## 2. Transform

Gizmos already exist — surface them. For numeric panels:
- `sm.setPosition3D(id, x,y,z)` · `sm.setRotation3D(id, x,y,z)` (radians) · `sm.setScale3D(id, x,y,z)`
- Read current: `sm.getNodeById(id)` → `.x/.y/.z`, `.rotationX/Y`, `.scaleX/Y/Z`.
- Selection: `sm.getSelected3DIDs()` / `sm.setSelected3DIDs(new Set([...]))`.
- Framing: `sm.frameAllMeshes3D(padding?)`; `sm.fitContentToArtboard3D(padding?)` 🆕 (scale+center all content into the artboard).

---

## 3. Materials

A material panel patches the selected object's material:
- `sm.scene3d.setMaterial(id, { diffuse:{r,g,b,a}, roughness, metalness, emissive, ... })`
- Read: `sm.getMesh3D(id)?.material`.
- **Procedural surfaces 🆕** — a "Material" dropdown **driven dynamically by `sm.surfaceMaterials3D()`** (so it always reflects the full catalog — do NOT hardcode the list), applied with `sm.applyGroundMaterial3D(id, { surface, tint, tileMm, groutMm, weather })`. Real stone/wood/grass/roof surfacing, no image needed — the way to "texture" without painting. The catalog now ships **23 surfaces** (procedural-material-library.md Part A COMPLETE): stone family (ashlar/brick/granite/slate/sandstone/toonStone/cobble/concrete) · ground (grass/dirt/asphalt) · wood (plank/bark) · roofs (shingle/radialShingle/thatch/clayTile/metal) · walls (halfTimber) · nature (leaves) · cloth (fabric) · accents (radialMedallion/borderStrip). `tint` (hex or rgb) recolors; `tileSize`/`tileMm` scales; `weather` = new|worn|ancient|mossy|dirty. Also `sm.setRenderStyle3D(id, 'cel')` for the stylized/toon look on top. ★ Note the method is named `applyGroundMaterial3D` for legacy reasons but works on **any mesh**, not just ground.
- **Render style 🆕** — `renderStyle` on the material: `'cel'` (toon/hand-painted), `sketch`, `ink`, `gouraud`, `unlit`, `default` (PBR). A style dropdown + a scene-wide "Toon" toggle (`renderStyle:'cel'` on all meshes) — this is what gives a stylized/diorama look.
- Geometric patterns: `sm.setMeshPattern3D(id, { mode:'stripes'|'checker'|'grid'|… })` + `sm.clothingPatternPresetNames3D()`.
- Image textures: `sm.setPartTexture3D(...)`, texture library methods; UV paint has its own mode.
- Environment/reflection: `sm.setEnvironmentMap3D(imageData, intensity)` (drives IBL + soft metal reflections).

---

## 4. Mesh editing (Edit-Mesh mode) — mostly EXISTS

The engine already has an Edit-Mesh mode with selection + gizmos. A "Edit Mesh" toolbar drives these:

**Enter / exit / read-back**
- `sm.enterMeshEditMode3D(id)` / `sm.exitMeshEditMode3D()` · `sm.makeEditable3D(id)` (headless-safe).
- `sm.getEditMesh3D(id)` → live `EditMesh` (`.vertices`, `.faces`, `.halfEdges`); `getFaceCenter/getFaceNormal/getFaceVertices` for hover/labels.

**Selection** (index-based; for a mouse UI, pick → index)
- `sm.selectVertex3D(id, vIdx, add?)` · `sm.selectFace3D(id, fIdx, add?)` · `sm.selectEdge3D(id, halfEdgeIdx, add?)` · `sm.getEditSelection3D(id)`.

**Ops** (each a toolbar button; the ones with a magnitude get a slider/drag)
| Tool | Method |
|---|---|
| Extrude faces | `sm.extrudeFaces3D(id, faceSet\|null, distance)` |
| Inset faces | `sm.insetFaces3D(id, faceSet\|null, amount)` |
| Bevel edge | `sm.bevelEdge3D(id, halfEdgeIdx, amount)` |
| 🆕 Bevel vertex | `sm.bevelVertex3D(id, vertexIndex, amount)` |
| Loop cut | `sm.loopCut3D(id, halfEdgeIdx, t)` |
| Subdivide face | `sm.subdivideFace3D(id, fIdx)` |
| Move vertex | `sm.moveVertex3D(id, vIdx, dx,dy,dz)` (gizmo-driven) |
| Proportional (soft) edit | `sm.meshEdit.setProportionalEdit(id, enabled, radius?, falloff?)` |
| Weld / merge | `sm.weldVertices3D(id, a,b)` · `sm.mergeByDistance3D(id, threshold)` |
| Delete / flip / separate | `sm.deleteFaces3D` · `sm.flipFaces3D` · `sm.separateFaces3D` |
| Fill hole / bridge | `sm.fillHole3D(id, boundaryHE)` · `sm.bridgeEdgeLoops3D(id, loopA, loopB)` |
| Knife | `sm.knifeCut3D(id, x0,y0,x1,y1, canvasW, canvasH)` (screen-space line) |
| UV unwrap | `sm.autoUnwrap3D` / `unwrapIslands3D` / `packUVIslands3D` |

---

## 5. Modifiers (non-destructive stack) 🆕 mostly

A "Modifiers" panel (add / reorder / toggle / apply):
- `sm.addSubdivisionModifier3D(id, iterations)` — smooth (Catmull-Clark).
- `sm.addMirrorModifier3D(id, axis, clipping)` — symmetry.
- 🆕 `sm.addDisplaceModifier3D(id, { strength, frequency, seed, octaves, direction })` — surface roughness/relief.
- `sm.setModifierEnabled3D(id, index, on)` · `sm.applyModifier3D(id, index)` (bake).
- **Recipe hint in UI:** displace works best after subdivision (needs vertices) — a "Rock/terrain" preset can chain Subdivision → Displace.
- 🆕 **Decimate** `sm.simplifyMesh3D(id, ratio)` — QEM-simplify a dense mesh (metaballs/creatures/boolean results) to `ratio` (0..1) of its triangles, same silhouette, leaner. Undoable; drops UVs (re-apply a material after). Creatures also take a `decimate` param on creation (default 0.4). **Full panel wiring: [mesh-decimation.md](./mesh-decimation.md).**

---

## 6. Boolean CSG 🆕

Select two meshes → a "Boolean ▾" button (Union / Subtract / Intersect):
- `sm.booleanMesh3D(idA, idB, 'union'|'subtract'|'intersect', { keepOperands? })` → new mesh id (operands consumed by default).
- **Subtract** = cut idB out of idA (holes, hollows, notches, windows). Inputs should be closed solids.
- v1 result is triangulated/flat-shaded — offer a "clean up" that runs `mergeByDistance3D` after.

---

## 7. Rigging + animation

Much exists (bone-placement mode, weight paint, the timeline). Panels map to:

**Skeleton / bones**
- `sm.createEmptySkeleton3D(name?)` → id · `sm.addBone3D(skelId, parentIndex, [x,y,z], name?)` → jointIndex · `moveBone3D`/`removeBone3D`/`renameBone3D`.
- `sm.bindMeshToSkeleton3D(meshId, skelId)` (skin) · `sm.getSkeletonJoints3D(skelId)` (outliner) · `sm.getSkeletonIdForMesh3D(meshId)`.
- Interactive bone-draw: `sm.enterBonePlacementMode3D(skelId)` (exists).

**Pose** (a pose panel + gizmos)
- `sm.setJointRotation3D(skelId, jointIdx, quaternion)` (gizmo-driven; UI can offer Euler sliders → quat).
- IK: `sm.setIKTarget3D(skelId, chainId, x,y,z)` + chain enable/length/weight.
- Pose library: `sm.capturePose3D` / `applyPose3D` / `getPoses3D`.

**Animation** (timeline)
- Clips: `sm.createSkeletonClip3D(skelId, name, fps, endFrame)` → id · `sm.recordSkeletonPose3D(skelId, clipId, frame)` (pose-then-record) · `sm.setClipJointKeyframe3D` · `sm.playSkeletonClip3D`.
- Transform/camera/blend-shape keyframes: `setMeshKeyframe3D` / `setCameraKeyframe3D` / `setBlendShapeKeyframe3D`.
- Procedural: `sm.setIdleAnimation3D(bodyId, on, intensity)` (breathing) · NLA tracks (`createNLATrack3D` …).

---

## 8. Generators (Creator modes — mostly EXIST)

These already have Creator-mode UIs; surface them + expose params:
- **City:** `sm.world.generateWorld(params?, draft?)` — a params panel (seed/radius/districts) with a draft toggle for live drag.
- **Building:** `sm.createProceduralBuilding3D(params?, x,y,z)` (11 archetypes; seed reproduces).
- **Props:** `sm.creatorTypes3D()` (list) → `sm.creatorParamSchema3D(typeId)` (**drive a dynamic form from this**) → `sm.createCreator3D(typeId, params, transform)`.
- **Character:** `sm.createFullCharacter3D({ body, hair, top, bottom, skinTone, ... })` — the Character Creator; slots are param-driven.
- **Particles:** `sm.addParticleEmitter3D(x,y,z, config?, preset?)` (dust/sparks/snow/magic).

> The **prop param schema** (`creatorParamSchema3D`) is machine-readable — render a form directly from it (same data the AI's tool schema uses).

---

## 9. Scene / lighting / framing / settings

- **Lighting:** `sm.setDirectionalLight3D(dx,dy,dz, r,g,b, intensity)` · `sm.setAmbientLight3D(r,g,b, intensity)` · 🆕 a "Studio lighting" button = dir 1.3 + white ambient 0.5 (the engine default is dim).
- **Framing:** `sm.getArtboardInfo3D()` 🆕 (center/upAxis/recommendedScale/bounds — the fixed artboard) · `sm.getSceneBounds3D()` 🆕 · `sm.isMeshInView3D(id)` 🆕.
- **Global settings:** `sm.scene3d.getGlobalScene3DSettings()` / `restoreGlobalScene3DSettings(partial)` — projection (ortho/persp), fog, PS1, SSAO, shadows, grid, bg. Build toggles/sliders against this object.
- **Camera:** `sm.getCamera3D()`, `sm.setCameraMode('perspective'|'orthographic')`, `sm.setIllustrationProjection(...)`.
- 🆕 **View mode (target × camera):** `sm.setCameraMode3D('ortho2D'|'perspective2D'|'free3D')` + `sm.setTarget3D('illustration'|'scene')` — the two-axis view model (free-cam 3D over the same scene, non-destructive). Drive panel/tool visibility off `sm.onViewStateChanged3D` + `sm.getViewRules3D()`. **Full panel wiring: [free-camera-and-targets.md](./free-camera-and-targets.md).**

---

## 10. 2D vector + text + illustration (illustration mode)

- Shapes: `sm.createRectangle` / `createCircle` / `createTriangle` / `createLine` (return the shape; set fill via `sm.setShapeColor(hex)` first).
- Text: `sm.createLiveText(x,y,{text})` (HTML-in-canvas).
- Ephemera / decals / packaging have their own subsystems (`sm.addEphemeraPlacement`, decal place tools, the Package Creator mode).
- Raster paint: brush tools bound in the raster layer manager (a separate 2D toolset).

---

## 11. Undo, persistence, events

- **Undo/redo:** `sm.undo3D()` / `sm.redo3D()` — every `*3D` op is on the stack. Wire Ctrl+Z/Y.
- **Batch:** wrap a multi-op UI action in `sm.beginSceneGraphBatch3D()` … `sm.endSceneGraphBatch3D()` for ONE change event + undo entry.
- **Persistence is params-only + automatic** — the engine saves params/markers and regenerates geometry on load. New parametric shapes (revolve/tube), modifiers (displace), and edits persist for free. No UI work needed beyond the existing save.
- **Events:** subscribe to `sm.scene3d.onSceneGraphChanged` (refresh outliner/panels) and the selection/animation events the timeline already uses.

---

## 12. Suggested UI shape (summary)

1. **Left rail:** Add-Mesh menu (§1) + Creator modes (§8).
2. **Top toolbar:** mode switch (Object / Edit-Mesh §4 / Pose §7 / Paint) + Undo/Redo.
3. **Right panels (contextual on selection):** Transform (§2), Material (§3), Modifiers (§5 🆕), and — in Edit-Mesh — the mesh-op tools (§4).
4. **Selection ≥2 meshes:** Boolean bar (§6 🆕).
5. **Bottom:** animation timeline (§7) + the artboard/scene settings (§9).
6. **AI panel** stays too — it and the manual UI drive the *same* `ShapeManager`, so they compose (AI builds a base, user refines by hand, or vice-versa).

The 🆕 items (parametric shapes + profile editors, displace modifier, boolean, vertex bevel, studio-lighting/framing helpers) are the only genuinely new panels to build; the rest is surfacing engine UI that already exists.
