# Procedural Hair Generation — Engine Spec

**Last Updated:** 2026-06-23 (Phase 1 built; persistence + bake done) · 2026-06-26 (**card mode** / alpha-card hair spec'd — §14)
**Status:** ✅ Phase 1 implemented (`hair-generator.ts` + live `setHairParams3D` + gradient), **persistence ✅** (`serialize/restoreHairRigs`), **bake ✅** (`bakeHairToPart3D`, GLB persists). Named presets (`getHairPresetNames3D`) the one 🔶 piece left.
**Sibling docs:** [character-creation-pipeline.md](./character-creation-pipeline.md) (body + clothing pipeline), [dollz-creator.md](./dollz-creator.md) (product; hair is a signature kit slot), [hair.md](../ui/hair.md) (**Frogmarks panel hand-off doc**), [character-creator.md](../ui/character-creator.md) (UI integration), [kitbash.md](../ui/kitbash.md) (part swap library).

Generate **chunky low-poly hairstyles** from a parameter set — the same "no-modeling, sliders + presets, live preview" path as the procedural **body** ([body-generator.ts](../../src/services/managers/body-generator.ts)) and **eyes** ([eye-generator.ts](../../src/services/managers/eye-generator.ts)). A generated style **skins to the head joint** (follows poses for free, like the eye decal), is colored with a **root→tip vertex gradient** (the reference's blue tips), and can be **baked into a kitbash hair part** to seed/expand the library.

> **Decisions locked (2026-06-22):** geometry = **chunky low-poly mesh** (not alpha cards); authoring = **presets + sliders**; v1 scope = **reference-girl set** (cap + bangs + parting + twintails/ponytail/pigtails + tip color). Silhouette-draw authoring and tail jiggle-physics are explicitly **later phases**.
>
> **Amended (2026-06-26):** chunky mesh stays the **default**, but **alpha cards** are added as an opt-in **second `hairMode`** (§14) for the Elden-Ring/FF realism lean — a different *output mode of the same generator*, decoupled from render style, **cutout-first** (so it ships without the translucency-sorting problem). Not a replacement.

---

## 0. TL;DR

```
HairParams  ──►  hair-generator (MeshGeometry)  ──►  SkinnedMesh3D (100% → head joint)
  (preset + sliders)        chunky low-poly                follows head pose; vertex root→tip gradient
                                                           │
                          live: setHairParams3D() regenerates the mesh each slider change (cheap)
                          persist: params are the source of truth → regenerate on load
                          export: bakeHairToPart3D() → GLB → kitbash hair slot
```

Hair is a **secondary mesh on an existing body** (it needs the body's head joint), built the way the body is — rings/strips/tubes of low-poly geometry — but assembled from four **components**: a **cap**, **bangs**, **side locks**, and **tails**.

---

## 1. Where it fits

```
CREATE body  →  EYES (draw/procedural)  →  HAIR (this spec)  →  DRESS  →  POSE  →  RENDER
 §2 body gen      §2.5 face/eyes            generate or kit       clothing   armature  PS1 card
```

Hair attaches to a body's **head joint**, so it requires a rigged body first (procedural or kitbashed). It complements the **hand-authored kit hair** in [dollz-creator.md](./dollz-creator.md) (§"Iconic starter parts"): the generator can both drive a live customizer **and** bake out new library parts.

Distinct from the **loose-clothing pipeline** in [character-creation-pipeline.md](./character-creation-pipeline.md) §"Loose clothing" (draw → inflate → shrinkwrap → weight-copy). That is the *freeform/manual* path; this is the *parametric* path. They can coexist (a future "draw the silhouette" hair mode would lean on that pipeline — Phase 3).

---

## 2. Architecture

Mirror the body generator:

- **`hair-generator.ts`** (new, in `src/services/managers/`) — a pure function `generateHair(params, head): { geometry: MeshGeometry; vertexColors: Float32Array; strandRoots: ... }`. No GPU, no scene — just geometry + per-vertex colors. `head` = the scalp frame (centre, radius, front/up axes) derived from the body's head region.
- **`Scene3DManager`** owns a **hair rig** per body (like the face rig): `{ bodyMeshId, hairMeshId, params }`. It builds the `SkinnedMesh3D`, skins it 100% to the head joint, uploads `vertexColors`, adds it under the scene root, and regenerates on param change / on load.
- **`ShapeManager`** exposes the public `*3D` API (presets, set params, bake to part).

The generated `SkinnedMesh3D` reuses the **existing skinned pipeline** — including the `cullMode:'none'` + per-mesh skin buffer fix (see [renderer-3d.ts](../../src/renderer/3d/renderer-3d.ts) — a hair mesh is a *second* skinned mesh sharing the body's skeleton, which the skin-matrix fix already supports). Vertex-colored skinned rendering already exists (the weight-paint path), so root→tip gradient hair needs no new shader.

### Scalp frame
From `_headRegionBBox(body, headJointIdx)` (already used by the face rig): centre `c`, half-extents `(hX, hY, hZ)`. Define:
- **up** = +Y, **front** = +Z (the face side, where the eye decal lives), **right** = +X.
- **crown** = `c + up*hY`, **scalp radius** ≈ `max(hX, hZ)`.
- **hairline** ring = a closed loop around the head at the chosen front/side/back heights.

All hair geometry is built in this head-local frame, then the whole mesh is skinned 100% to the head joint → it rides every head pose with zero per-frame cost.

---

## 3. Components & geometry

All low-poly (a `chunkiness` knob sets ring/segment counts; default chunky). Built in the scalp frame.

### 3a. Cap / crown
A conformed dome shell — the hair "helmet."
- Rings of `capSides` verts (default 8–10) from the **crown** down to the **hairline**, offset outward from the scalp by `capThickness` so it floats just above the skin.
- The hairline height differs front/side/back (`hairlineFront`, `hairlineSide`, `hairlineBack`) so it reads as a real hair edge (lower at the back/nape, higher at the forehead).
- **Back length** (`backLength`): below the nape, extend the back rings **downward** as a tapering sheet (bob ≈ 0, long ≈ down the back). `crownRound` adds pouf/volume by pushing the upper rings out.

### 3b. Bangs / fringe
Clumps hanging from the **front hairline** over the forehead.
- `bangCount` clumps spread across the front arc; each clump = a short **tapered strip** (≈2 wide × `bangSegments` long) that hangs down and bends **forward** (`bangCurve`) to a point (`bangPointiness`).
- **Parting** carves a gap: `partingStyle` = `fringe` (no gap) | `parted` (centre gap) | `swept` (offset gap); `partingPosition` (−1..1) slides the gap, `partingWidth` sizes it. Parted/swept push clumps to either side of the gap.

### 3c. Side locks (face-framing)
Optional strips beside the face (`sideLock`, `sideLockLength`, `sideLockThickness`) dropping from the temples — frames the face, key to the reference look.

### 3d. Tails (twintails / ponytail / pigtails)
The signature. `tailStyle` = `none` | `twin` (2 high sides) | `pony` (1 back) | `pig` (2 low sides) | `buns` (2 short — Phase 2).
- Each tail = a **tapered tube** (`tailSides`≈6) swept along a curve from an **attach point** on the head.
- Attach points come from `tailStyle` + `tailHeight` (how high on the head) + `tailSpread` (angle out from the head).
- Per-tail params: `tailLength`, `tailThickness` (root), `tailTaper` (root→tip thinning), `tailCurl` (downward curve / S-wave), `tailTip` = `point` | `flare` | `blunt`.

> Geometry utilities (ring extrusion, tapered tube sweep, cap triangulation) overlap the body generator's tube/ring code — factor shared helpers so hair and body share the chunky-extrusion primitives.

---

## 4. Param schema (`HairParams`)

Grouped; all optional in the API (omitted → preset/default).

| Group | Fields |
|---|---|
| **Meta** | `preset?` (the base style it came from, for the UI) |
| **Cap** | `capThickness`, `hairlineFront`, `hairlineSide`, `hairlineBack`, `backLength`, `crownRound`, `capSides` |
| **Bangs** | `partingStyle` (`fringe`\|`parted`\|`swept`), `partingPosition`, `partingWidth`, `bangCount`, `bangLength`, `bangCurve`, `bangPointiness`, `bangSegments` |
| **Side locks** | `sideLock`, `sideLockLength`, `sideLockThickness` |
| **Tails** | `tailStyle` (`none`\|`twin`\|`pony`\|`pig`\|`buns`), `tailHeight`, `tailSpread`, `tailLength`, `tailThickness`, `tailTaper`, `tailCurl`, `tailTip` (`point`\|`flare`\|`blunt`), `tailSides` |
| **Color** | `rootColor`, `tipColor`, `gradient` (bool), `tipFade` (0..1 — how far up the tip colour reaches) |
| **Render** | `chunkiness` (poly density 0..1; default low/chunky) |

---

## 5. Presets (v1 — the reference-girl set)

Named bundles of `HairParams`; `getHairPresetNames3D()` → seed the slider panel, then the user tweaks.

- **Twintails** *(the reference)* — parted bangs, side locks, two high `twin` tails, cream `rootColor` + blue `tipColor`.
- **Ponytail** — fringe/parted bangs, single `pony` tail.
- **Pigtails** — low `pig` tails, fuller bangs.
- **Bob** — cap + bangs, short `backLength`, no tails.
- **Long** — cap + bangs, long `backLength`, no tails.

Each preset is a tuned `HairParams` literal in `hair-generator.ts` (like `BODY_POSES` / `defaultEyeParams`). Buns / braids / hime = Phase 2.

---

## 6. Coloring

- **Per-vertex root→tip gradient**: each vertex carries a normalized `t` = distance from its root (scalp/hairline/attach point) to the strand tip. Vertex colour = `lerp(rootColor, tipColor, smoothstep(1−tipFade, 1, t))` when `gradient`, else flat `rootColor`. This nails the reference's **blue tips** with no texture.
- Uploaded as the mesh's `vertexColors` (existing skinned vertex-colour path). Renders through the **PS1 retro pipeline** automatically (lighting + colour-depth → on-aesthetic).
- **Optional UV paint (Phase 2):** unwrap the hair (simple planar/per-strip) so the existing UV paint pane can add detail (streaks, ombre). Not required for v1 — the gradient covers the look.

---

## 7. Attachment & follow

- One `SkinnedMesh3D`, **100% weighted to the head joint** (`jointIndices` all = headIdx, weights 1) — identical to the eye decal. Follows head pose for free; no per-frame work.
- Built in head-local space, placed at the body's transform (procedural bodies sit at origin → local = world).
- `isHair = true` flag on the mesh (mirrors `isFaceDecal`) so it's excluded from node persistence and rebuilt from params (see §9), and so tools can recognize it.
- **Phase 2 — jiggle:** skin the tails to a tiny chain of dedicated tail joints (added to the skeleton) for secondary motion; v1 is rigid-to-head.

---

## 8. Live preview + commit

Hair is **cheap to regenerate** (a few hundred low-poly verts), so — unlike the body — it needs **no separate ghost**: `setHairParams3D(bodyMeshId, params)` rebuilds the real hair mesh on every slider change, live (same model as `setFaceExpressionProcedural3D`). First call creates it; subsequent calls replace its geometry + colours in place.

---

## 9. Persistence

Params are the **source of truth** (mirror the face rig):
- The hair rig (`{ bodyMeshId, hairMeshId, params }`) serializes its **params** into `scene3dJSON` (a `hairRigs` array, alongside `faceRigs`).
- The generated mesh is **excluded from node persistence** (`isHair` filter, like `isFaceDecal`) and **regenerated from params on load** (a `restoreHairRigs(states)` after the body + skeletons relink — like `restoreFaceRigs`).
- No PNG payload needed (vertex colours are derived from params). Works for the `.frogmarks` export with no new payload fields.

---

## 10. Save as a kitbash part

`bakeHairToPart3D(bodyMeshId, name)`:
- Export the hair `SkinnedMesh3D` to **GLB** (existing `exportSceneGltf3D` path) and register a `KitbashPartMeta` in the **hair slot** (per [kitbash.md](../ui/kitbash.md) / [dollz-creator.md](./dollz-creator.md)).
- The part inherits the canonical skeleton's head binding, so it swaps onto any character. This is how the generator **seeds the kit** ("hair ×5+") and lets users publish their own styles.

---

## 11. API sketch (`ShapeManager`)

Mirrors `createProceduralBody3D` + the face API the panel already uses.

```ts
getHairPresetNames3D(): string[];                         // ['Twintails','Ponytail','Pigtails','Bob','Long']
getHairPreset3D(name: string): HairParams;                // a preset bundle to seed sliders
getDefaultHairParams3D(): HairParams;                     // = Twintails (the reference)

setHairParams3D(bodyMeshId: string, params: HairParams): void;   // build/update hair, live (per slider change)
getHairParams3D(bodyMeshId: string): HairParams | null;
removeHair3D(bodyMeshId: string): void;

bakeHairToPart3D(bodyMeshId: string, name: string): Promise<string>;  // → GLB + kitbash hair part id
```

Frogmarks panel: **Edit Character → Hair** → preset dropdown (`getHairPresetNames3D`) → sliders bound to `HairParams` → `setHairParams3D` on change (live) → optional **Save as hair part** (`bakeHairToPart3D`). Same shape as the Body and Eyes panels.

---

## 12. Phases

- **Phase 1 (v1 — this spec):** `hair-generator.ts` (cap + bangs + side locks + tails), the 5 presets, vertex root→tip gradient, skinned-to-head mesh, `setHairParams3D` live, params persistence (regenerate on load), `bakeHairToPart3D`. Frogmarks Hair panel.
- **Phase 2:** buns/braids/hime presets; optional UV unwrap + paint detail; tail **jiggle** joints; per-strand chunk variation/noise for less uniform clumps.
- **Phase 3:** **draw-the-silhouette** hair (front outline → inflate → shrinkwrap → weight-copy, via the loose-clothing pipeline) as an alternate authoring mode feeding the same part-export.
- **Phase 4 — card mode (alpha cards):** §14. **Cutout-first**: `hairMode:'cards'` + the card emitter (reuses the existing flow curves/regions) + a procedural strand-alpha texture + an alpha-test discard in the skinned-textured path. Then: UV-paintable strand textures, and (deferred) soft-blend + translucency sorting for photoreal.
- **Phase 5 — card-hair fidelity (toward Elden Ring):** §15. **15a first** (volume-following normals + anisotropic sheen — the "hair not plastic" lever), then 15b (more cards + per-card jitter), 15c (richer/assignable strand textures, per-region not per-card), 15d (volume offset).

---

## 13. Risks / open questions

- **Head-shape coupling:** the cap conforms to `_headRegionBBox`. Very non-spherical heads (the current elongated prototype) may need the hairline heights tuned per body — expose them as params (done) and tune presets against the real base body.
- **Bang ↔ eye overlap:** long bangs can cross the eye decal. That's stylistically fine (hair over eyes), and both are on the head so they pose together; no z-fighting (bangs sit forward of the face plane via `capThickness`). Worth a visual check.
- **Chunk uniformity:** purely parametric clumps can look too regular. A small per-clump random jitter (seeded) fixes it cheaply (Phase 2).
- **Part-bake skeleton:** baked hair must reference the **canonical** head joint so it swaps across bodies — verify against the kitbash binding convention before shipping the export.
- **Poly budget:** keep default `chunkiness` low (PS1/dollcore) — target a few hundred verts per style so a dressed character stays light.

---

## 14. Card mode — alpha-card hair (the realism lean)

A **second output mode** of the same generator: instead of closing the flow into solid low-poly tubes, emit **alpha-textured ribbon cards** along the *same* curves. This is how Elden Ring / FF / Genshin hair is built (layered translucent strips). It's selectable per character via `hairMode` and is **independent of render style** — *cel + cutout cards* = the anime look (Genshin/Honkai literally do this); *PBR + cards* = the AAA lean.

### 14a. What transfers — reuse the LOGIC, not the triangles
The valuable part of the generator is that it already knows **where hair goes and how it flows**: the scalp fit, the cap/bangs/sidelock regions, and (tails) the **parallel-transport flow curves**. Card mode reuses all of it; only the *emit-geometry* step changes:
- **Tails are already ribbons.** A parallel-transport tail is a swept strip with a spine curve + width — ~90% of a hair card. Card mode: don't close the tube; texture the strip with a strand-alpha map; stack `cardsPerClump` slightly-offset copies for density.
- **Cap → card shells.** Overlapping rows of short cards across the scalp dome (crown → hairline), layered outward.
- **Bangs / side locks → card clumps.** Each existing clump becomes 1–3 alpha cards instead of a tapered strip.

Everything else is unchanged: head-local build (§2 scalp frame), **100%-to-head skinning** (§7), the rig, persistence (§9), bake (§10), and the **root→tip gradient** (§6, which now multiplies over the strand texture).

### 14b. The card primitive
A card = a flat quad **ribbon** (a strip of `cardSegments` quads following a spine curve), textured with a **strand-alpha image**: opaque hair strands separated by transparent gaps, so overlapping cards read as full hair. Width = `cardWidth`; UVs run along the spine (root→tip) so both the gradient and the strand texture map cleanly. Two-sided (`cullMode:'none'`, already set for hair).

### 14c. Strand-alpha texture
- **Procedural (default):** a tileable strip of vertical strands — a few opaque lines with hard/soft alpha gaps + seeded jitter for irregularity. Cheap, no assets; the §6 root→tip colour multiplies over it.
- **Paintable:** each ribbon UV-unwraps to a clean rectangle, so the **existing UV-paint pane** can author strand detail / streaks / ombre — the same path as garment paint. Big synergy: hair textures become user content.

### 14d. The difficulty switch — cutout first, blend later
Two flavours, very different cost:
- **Cutout (default, ships first):** alpha-**test** — `discard` where the strand alpha < `alphaCutoff`. **Order-independent** (no sorting), hard strand edges, reads anime/Genshin, works under **any** render style. This is the whole realism unlock with *none* of the hard part.
- **Soft-blend (deferred):** alpha-**blend** for wispy photoreal hair needs **translucency sorting** (depth pre-pass / OIT / alpha-to-coverage) — the classic hair hard problem. Deferred until a true photoreal target is wanted.

### 14e. Rendering
Reuse the **existing skinned-textured pipeline** (the UV-paint / eye-decal path already samples a texture and supports transparency): sample the strand-alpha texture, multiply by the per-vertex gradient colour, and **alpha-test discard** below `alphaCutoff` (gated by a material flag so only card hair discards). No new pipeline, no depth sorting in cutout mode.

### 14f. Params (add to `HairParams`)
| Group | Fields |
|---|---|
| **Mode** | `hairMode` (`'chunky'` \| `'cards'`; default `'chunky'`) |
| **Cards** | `cardWidth`, `cardsPerClump`, `cardSegments`, `strandDensity` (texture), `alphaCutoff`, `hairTexture?` (procedural seed or a painted-texture ref) |

All chunky params (cap/bangs/tail shapes, the colour gradient) **still apply** — card mode lays cards along the *same* shapes. So flipping `hairMode` keeps the silhouette and swaps the surface.

### 14g. Persistence / bake
No new machinery: `hairMode` + card params serialize in the hair rig like everything else (§9). A procedural strand texture regenerates from its seed; a painted one persists via the existing mesh-texture path. `bakeHairToPart3D` (§10) exports card hair to GLB fine (geometry + a texture).

---

## 15. Card-hair FIDELITY — toward the Elden Ring look

**Premise:** a card *is* a ribbon textured with a hair texture (not either/or — §14, §"card hair primer"). The DS3 → ER jump was **not** strand rendering; it was better card **arrangement + textures + normals + volume**. All of those map onto *procedural* enhancements, so we stay **card-based** (true per-strand / groom — TressFX, UE5 Nanite hair — is out of scope: cost + off-aesthetic). Prioritized below; **15a is the biggest "hair, not plastic" lever and ships first.**

### 15a. Volume-following normals + sheen ⭐ (implementing first)
A flat card lit by its **flat face normal** reads as a shiny plastic strip. Make the hair light as a smooth **volume**, and add the lengthwise highlight:
- **Cap (solid + cap-cards):** lock vertex normals **scalp-outward** (the dome normal) so the whole "helmet" lights as one continuous mass instead of faceted cards.
- **Tail cards:** **bend the normals across the card width** (tilt toward ±width) so a flat fin lights like a rounded tube.
- **Anisotropic sheen (Kajiya-Kay):** the bright band that runs **along** the strands — the thing the ER screenshot is really showing off. Needs (a) the **strand tangent** per vertex (= the root→tip / `uv.v` direction, stored at generation), and (b) a hair-specular term in the shared fragment gated by a material flag. Driven by a **`sheen`** param (intensity). Works under any render style.

> Implementation: a per-vertex **strand tangent** + a **normal-lock** flag in the generator's accumulator; `recomputeNormals` skips locked verts; `Material3D.hairSheen` (a flags bit) + a Kajiya-Kay highlight in `MESH3D_FRAGMENT_SHADER`.

### 15b. More cards + per-card randomness (the "thousands of strands" illusion)
More / smaller / overlapping cards; **seeded per-card jitter** on width, length, rotation, offset, and tint. Cheap and fully procedural — a `cardDetail` / `cardJitter` knob. This is what turns uniform ribbons into a believable mass.

### 15c. Richer + ASSIGNABLE strand textures (per hairstyle / per region — NOT per card)
- Enrich the procedural strand texture: fine strands, broken ends, flyaways, softer alpha transitions.
- A small strand-texture **library** (straight / wavy / fine / coarse) — *textures*, not card meshes (we generate cards procedurally along flow curves, so no card-mesh library is needed).
- **Assignable / paintable** per hairstyle (the cards UV-unwrap to clean rectangles → route the existing UV-paint pane); optional **per-region** overrides (cap / bangs / side-locks / each tail — groups the generator already tracks via `tailId`).
- **DECISION — per-CARD texture assignment is overkill.** Hair is dozens–hundreds of cards; real hair shares one (or a few) strand textures; variety comes from **arrangement + tint**, not per-card images; and per-card hand-editing fights the procedural / crowd-scale thesis. Right granularity = **per-hairstyle, optionally per-region**. (A hover-highlight *card list* is the anti-pattern here.)

### 15d. Volume offset
Float the cards a touch further off the skull for believable thickness — a `volume` knob (bigger outward offset).

**Priority:** 15a (normals + sheen) → 15b (density + jitter) → 15c (textures) → 15d (offset).

### 15e. Status + deferred (future possible features)
**Built (2026-06-26):** 15a (volume-following normals + Kajiya-Kay **sheen**, incl. the **stored per-vertex strand tangent** → correct crown-ring + side highlights that track the posed head — replaced the world-down approximation), 15b (more cards + per-card jitter — **`cardDetail`**), 15c (richer strand texture — broken ends / varied width / brightness breakup), 15d (**`volume`** float-off-the-skull). Card params total: `hairMode`, `cardWidth`, `cardsPerClump`, `cardSegments`, `strandDensity`, `alphaCutoff`, `cardifyCap`, `sheen`, `cardDetail`, `volume`.

**Deferred — future possible features** (effort · what's involved):
- **UV-paintable / assignable strand textures — [M].** Foundation already exists (the UV-paint engine, the cards' clean rectangular UVs, and the carry-texture-across-regeneration in `setHairParams`). Work = route the hair mesh into `enterUVPaintMode3D`, seed the canvas from the procedural strand texture, and author **alpha** (strand = opaque / gap = transparent, for the cutout) — plus an optional small strand-texture library + **per-region** overrides (per §15c: per-hairstyle/per-region, *not* per-card). Mostly UI on top of existing systems.
- **Soft-blend / OIT for photoreal — [L], the hard one.** Cutout is order-independent; soft wispy edges need transparency **sorting** or **order-independent transparency** (Weighted-Blended OIT for WebGPU: a transparent pass + two accumulation targets + a resolve pass, integrated with depth + every render style). Real renderer-architecture work, and it partially fights the retro aesthetic. **Cheaper middle ground: alpha-to-coverage (MSAA) — [S–M]** = order-independent softer/dithered edges without a full OIT pipeline → reach for this first if "softer than cutout" is wanted.
