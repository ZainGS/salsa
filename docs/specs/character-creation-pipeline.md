# Character & Clothing Creation Pipeline — Design Spec

**Status:** Proposal / design. **Update (2026-06-23): the procedural generator path is BUILT** — body (+ live editing + shape sliders + skin tone), eyes, hair, and **clothing (top + bottom)** are all live, persisted, and bake-to-part. The original **offset-copy / inflate / silhouette-fit** garment flows in this doc are reframed as a **later "tailor an exact piece" mode**; the primary clothing path is now the procedural generator (see [clothing-generation.md](./clothing-generation.md), incl. §14 Clothing Designer). Phase tables below predate that — treat them as design rationale, with the backlog ([character-system-backlog.md](./character-system-backlog.md)) + [character-creator.md](../ui/character-creator.md) as the live status.
**Date:** 2026-06-18 (updated 2026-06-23)
**UI integration:** [docs/ui/character-creator.md](../ui/character-creator.md)
**Extends:** [dollz-creator.md](./dollz-creator.md) (this is the *creation/authoring* layer it assumes as "art"), [fashion-creator.md](./fashion-creator.md) (kitbash + conform), [kitbash-armature-grease-pencil.md](./kitbash-armature-grease-pencil.md) (canonical 26-joint skeleton)
**Reuses (built):** `createCharacter3D` + kitbash slots + canonical skeleton ([scene3d-manager.ts:1995](../../src/services/managers/scene3d-manager.ts#L1995)), skinning, UV paint on mesh, mesh-edit, blend shapes, GLTF export, `meshTextures`/`models3d` persistence, PS1 retro render.

---

## 1. What this spec is (and isn't)

Dollz Creator assembles a character from **pre-authored** base bodies + clothing parts and makes it look right (retro render, pixel paint, card output). It explicitly leaves *"how those parts get made"* as an art/content cost.

**This spec is that missing piece: how a user (or we) CREATE a base body and custom clothing *inside Salsa*** — so the kit isn't only hand-authored in Blender, and end users can make their own body types and outfits. It is the **content-creation engine** behind the kitbash assembly system.

It is **not** the assembly/defaults/card layer (that's Dollz Creator) and **not** the retro look (that's `PS1Config`).

---

## 2. Locked decisions (the two that unlock everything)

These resolve the open questions we kept circling. Everything downstream depends on them.

### 2.1 The hero **body is PROCEDURALLY GENERATED around the canonical skeleton — not inflated, and not hand-authored per-body**

Silhouette inflation **cannot** produce good hands, feet, or faces (it yields blobby mittens). But hand-authoring a base body is also the wrong cost — the pain there is keeping **topology, UV, and weights consistent**, and those are exactly the things you get *for free* when you *generate* the mesh. So the base body is **code**, not content:

- **A procedural body generator builds the mesh as tubes of cross-section loops around the canonical 26-joint skeleton's bones** (radius parametric per region). The skeleton you already have *is* the body's spine.
- **Fixed topology, parametric geometry.** The vertex *connectivity* (edge flow, loops at joints) is designed once; the generator only *positions* vertices from a parameter set. This gives clean deformation **and** full parametric control.
- **UV and weights are guaranteed by construction:** each tube unwraps to a known island → the **consistent UV layout the clothing library needs**; each vertex belongs to the bone whose tube it's on → **auto-skinned to the canonical rig, zero manual rigging**.
- **Proportions ARE the parameters** (bone lengths from the skeleton + per-region radii: height, leg length, torso width, chunkiness, head size). So **"draw your body type" = solve the generator params to match a drawn silhouette** — no separate blend-shape authoring needed for proportions (blend shapes stay available for *non-parametric* shapes later).
- **Extremities by style:** hands = mitten caps, feet = wedge caps (both trivial to generate and *correct* for dollcore); the head is a shaped blob whose **face is texture** (eyes/mouth UV-painted — out of scope here). Fingers are a separate, harder generator — deferred.
- **The generator's output IS a valid `base_body`** — a `SkinnedMesh3D` bound to the canonical skeleton — so it drops straight into `createCharacter3D` with **no GLB authoring**. Art direction comes from tuning the generator's *defaults* (the dollcore proportions) once, not authoring each body.
- **Inflation is still NOT used for the hero body** — but the generator is its clean, rigged cousin, so building it also de-risks inflate (which is scoped to loose clothing/props, §4.2).

> **Why this is right, not a compromise:** it keeps extremities good (generated caps, not inflated blobs), makes UV + rig *guaranteed* (clothing library + animations just work), turns the biggest content cost (base bodies) into code, and makes proportions a solved parametric problem. It directly answers the "hands/fingers/toes won't be as good" worry — those are generated to a fixed, designed topology, not recovered from a silhouette.

### 2.2 Clothing fit comes from the **shared skeleton + surface-derived geometry**, not manual rigging

Two garment classes, by whether they change the **silhouette**:

- **Tight clothing (shirts, leggings, swimsuits, gloves) = an OFFSET COPY of the body's surface.** Select a body region (torso, arms…), duplicate those faces, push them out along the normal a hair, and you have a garment that **hugs by construction** and **inherits the body's UV *and* skin weights for free** — zero manual rigging, deforms perfectly with the body and animation.
- **Loose clothing (skirts, jackets, hats, hair) = a garment mesh SHRINKWRAPPED to the body + WEIGHT-COPIED.** Author/draw/inflate the garment, project its verts toward the body surface (+offset) so it conforms, then copy skin weights from the nearest body surface point. Handles any body shape automatically.

> Both classes end up as a `SkinnedMesh3D` on the canonical skeleton — i.e. a normal kitbash slot part. The creation pipeline's whole job is to *produce that*, snugly and auto-rigged, from cheap user input.

---

## 3. Flow A — Generate / shape a body

```
 set proportions (sliders / draw silhouette)  →  generate body  →  recolor skin  →  (optional) paint pixel detail
   params: bone lengths + region radii          procedural gen     skinTone tint     UV paint (built)
   (silhouette-fit solves the params)           tubes→mesh+UV+weights
```

- **Proportions:** parameter sliders (height, leg length, torso width, shoulder width, chunkiness, head/hand/foot size). **Optional silhouette-fit:** draw a front-view outline; solve the params so the generated body's projected silhouette best matches it (bounded least-squares over the parameter set). This is "draw your body type" with canonical topology guaranteed.
- **Generate:** the procedural generator (§2.1) positions a fixed vertex set around the canonical skeleton and emits a `SkinnedMesh3D` with auto UV islands + auto weights. Regenerating on a param change is cheap (it just repositions vertices).
- **Recolor / paint:** `skinTone` tint + `enterUVPaintMode3D` for belly-button/markings/etc. (eyes/face are a later expression system — out of scope here).
- **Output:** a generated `base_body`. The **params** ride in serialization (regenerate on load) — or bake the mesh to GLB once it's edited. Topology/UV/rig are canonical, so clothing fits.

**Editing:** high-level = param sliders / silhouette (safe; regenerates cleanly). Raw `mesh-edit` sculpting is an **escape hatch** that breaks the param→mesh link (the body becomes a baked one-off, and edits can break canonical UV/weights/clothing-fit) — advanced only.

---

## 4. Flow B — Create custom clothing (a slot part)

### 4.1 Tight clothing — "skin off the body" (the elegant path)

```
 select body region(s)  →  offset-copy surface  →  trim/extend edges  →  paint texture  →  save as part
   torso/arms/legs           new SkinnedMesh        mesh-edit (built)      UV paint (built)   → kitbash slot
   (inherits UV + weights, hugs by construction)
```

The garment starts as the exact body surface, so it fits perfectly, is already UV-unwrapped, and is already skinned. The user just trims the boundary (sleeve length, neckline), maybe extrudes a hem, and paints it. **No rigging step.** This covers the majority of dollcore outfits (crop tops, tiny shorts, leggings, swimwear).

### 4.2 Loose clothing — draw → inflate → conform

```
 draw garment silhouette (2D)  →  inflate/extrude  →  shrinkwrap to body  →  weight-copy from body  →  paint  →  save as part
        2D shape                   new mesh            conform (+offset)       auto-skin               UV paint   → kitbash slot
```

For skirts, jackets, hats, hair, capes — where the garment leaves the body surface. Inflate here is fine because silhouette *is* the point and topology quality doesn't have to be perfect (retro/chunky). Shrinkwrap + weight-copy make it conform and move with the body with no manual rig.

### 4.3 Saving as a part

A created mesh becomes a kitbash part via the **existing GLTF export** (`exportSceneGltf3D` walks `SkinnedMesh3D` + skeleton + weights) → register a `KitbashPartMeta` (slot, name, the exported GLB, thumbnail) in `KitbashLibrary`. From then on it's a normal swap-able slot part. (Alternatively, keep it in-memory in `_modelStore` for a session-local part; persistence rides `models3d` + `meshTextures`.)

---

## 5. Fit across body shapes (when the body reshapes)

Because tight clothing is a body-surface copy and all clothing is skinned to the shared skeleton, **animation** fit is automatic. **Reshape** fit (chunky vs. thin body) needs one of:

- **A. Shrinkwrap re-fit (automatic, recommended for custom parts):** after a body morph, re-project the garment onto the new surface. One pass, handles anything, no per-garment authoring.
- **B. Shared blend shapes (best for curated parts):** author the same morph set on the garment as on the body; the garment morphs in lockstep. Higher authoring cost, highest quality.
- **C. MVP punt:** author at one canonical proportion; add A or B when variants ship (matches Dollz Creator §13).

Recommend **A for user-created clothing, B for the curated hero kit.**

---

## 6. Engine pieces to build (small, surgical, on top of mesh-edit)

| Piece | What | Reuse |
|---|---|---|
| **Procedural body generator** *(Flow A — the base body)* | Ring cross-section loops around each canonical bone (radius per region), stitch into quad bands, cap head/hands (mitten)/feet (wedge); emit positions + normals + UV islands + joints + weights → `SkinnedMesh3D` on the canonical skeleton. **Fixed topology, parametric vertex positions.** | canonical skeleton, SkinnedMesh3D, skinning |
| **Offset-copy surface** | Duplicate selected `EditMesh` faces, displace along vertex normals by `t`, **carry UV + JOINTS/WEIGHTS** → new `SkinnedMesh3D`. | mesh-edit selection, skinning |
| **Shrinkwrap** | For each garment vert, find nearest point on body surface (BVH/triangle search), move to it + `offset·normal`. | edit-mesh geometry, AABB/BVH if present |
| **Weight transfer** | Copy `JOINTS_0/WEIGHTS_0` from nearest body vertex (or barycentric on nearest face) to each garment vert. | skinning data |
| **Silhouette → param fit** *(Flow A, optional)* | Solve the generator's params so the body's projected outline matches a drawn 2D silhouette (bounded least-squares over the param set). | the generator, 2D shapes |
| **Inflate** *(Flow B / props)* | 2D silhouette → puffy low-poly mesh (distance-field/medial inflation). Scoped to loose garments + props, **not** the hero body (the generator covers that, cleanly). | edit-mesh, polygon-extrude spec |
| **Save-as-part** | Created `SkinnedMesh3D` → GLB → `KitbashPartMeta` in `KitbashLibrary`. | `exportSceneGltf3D` (built), KitbashLibrary |

Everything else (assembly, skinning, paint, retro render, persistence, blend shapes) is **reused as-is**.

---

## 7. Phasing

| Phase | Scope | New engine |
|---|---|---|
| **0 — Procedural base body** | Generate the tube mesh around the canonical skeleton (params: bone lengths + per-region radii) → `SkinnedMesh3D` with auto UV + auto weights; viewable + skin-tintable. **Replaces "author a base body" with code.** | The generator (medium) |
| **1 — Param sliders / proportions** | Expose the generator params (height, leg length, torso/shoulder width, chunkiness, head/hand/foot size); regenerate live. | Param UI wiring |
| **2 — Tight clothing (offset-copy)** | Select region → offset-copy → trim → paint → save part. Highest-value, lowest-risk garment path; pristine on a procedural body. | Offset-copy + weight carry |
| **3 — Save-as-part loop** | Export created part to GLB + register in library; swap it in via `createCharacter3D`. | Save-as-part glue |
| **4 — Loose clothing** | Draw → inflate → shrinkwrap → weight-copy. | Shrinkwrap, weight-transfer, inflate |
| **5 — Silhouette-fit + reshape conform** | Solve generator params from a drawn outline; shrinkwrap re-fit garments after reshape. | Silhouette-fit, re-fit pass |

**MVP slice:** **generate a base body from params** → tweak proportions with sliders → **offset-copy a crop top + tiny shorts, paint them pixel-style, save as parts** → assemble + pose + retro-render → save/reload round-trips. The base body is *code*, the clothing is *derived from it*, and almost everything else is existing systems.

### 7a. Prototype status (June 2026)

**Phase 0 is prototyped and type-checks.** [body-generator.ts](../../src/services/managers/body-generator.ts) — `generateBodyResult(params)` emits a `GltfSkinnedResult` (a tube-and-blob humanoid: octagonal cross-sections, **17-joint** rig, 2-bone linear weights blended along each tube, per-part cylindrical UV). Wired via **`shapeManager.createProceduralBody3D({ height, limbThick, torsoThick, headSize, legLength })`** → adds a rigged, posable `SkinnedMesh3D` at the origin through the same `_createSkeletonFromResult` + `_createSkinnedMeshForSlot` path the kitbash assembler uses. Identity mesh transform (size baked into geometry + joints, pose-safe); double-sided for the prototype.

It proves the loop end-to-end (params → mesh + skeleton + weights, **no GLB**). Prototype gaps to close next: overlapping capsules (not welded/watertight), sphere hands/feet (no fingers/toes/wedge yet), per-part overlapping UV (no packed atlas), 17 joints (not the canonical 26), and rigid-ish 2-bone weights at joints. Tune dollcore proportions in the defaults, then weld + pack-UV.

---

## 8. Honest limits / open questions

- **Hands/feet/face = generated to fixed topology, never inflate.** Mittens/wedges + a head-form-with-texture-face are generated to a designed connectivity, not recovered from a silhouette. The worry is real; this is the mitigation.
- **Joint deformation is the generator's real craft** — the connectivity (loops at shoulder/hip/neck) is designed once; chunky low-poly hides residual pinching. Get the joint loops right and the rest is parametric.
- **Raw mesh-edit breaks auto-fit.** It's an escape hatch, not the main flow; surface it as "advanced."
- **Back/sides texture** on "draw-it-on" front projection — mirror, symmetric UV, or 2-view draw (defer; Flow A paints directly on the UV instead).
- **Inflate quality** is the riskiest new piece — keep it off the hero body; prototype on a skirt first.
- **Weight-transfer artifacts** at limb seams (armpit, crotch) — offset-copy avoids this (inherits exact weights); shrinkwrap garments may need a smoothing pass.
- **Where does authoring run** — in-app (this spec) vs. Blender for the *hero* kit? Likely both: Blender for the curated bodies, in-app creation for user clothing + body reshape. The save-as-part GLB path makes them interchangeable.

**One-line thesis:** *Generate the canonical body as parametric tubes around the skeleton you already have (free UV + free weights + proportions-as-params), derive clothing from that body surface (offset-copy) or conform it with shrinkwrap + weight-copy — so "make a character and dress it" becomes mostly code + assembly of systems Salsa already ships, with inflate scoped to loose garments/props where it actually works.*
