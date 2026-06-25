# Fashion Creator — Design Spec

> **2026-06-16:** Fashion Creator is now the **Kitbash + Edit/Paint stage** of the broader
> **[Dollz Creator](dollz-creator.md)** pipeline (PS1/dollcore character + card creator).
> This spec (garment library + fabric paint) is reused verbatim; Dollz Creator adds curated
> doll base bodies, the "looks right by default" retro/pixel layer, pose, and the 2D-hybrid
> character-card output. Read Dollz Creator first for the product framing.

**Status:** Proposal / design. **Update (2026-06-23):** the **procedural clothing generator** (top + bottom, sliders, enclose/no-clip fit, persisted, bake-to-part) is now BUILT and is the primary clothing path — see [clothing-generation.md](./clothing-generation.md). This spec's garment-library + fabric-paint flows remain valid as the **kitbash + paint stage** on top of generated/baked parts; the **Clothing Designer** (clothing-generation.md §14) is the standalone-design future direction.
**Date:** 2026-06-14 (updated 2026-06-23)
**Owner:** TBD
**Related:** [kitbash-armature-grease-pencil.md](kitbash-armature-grease-pencil.md) (canonical character system), [ui/uv-editor.md](../ui/uv-editor.md) (UV paint), [ui/cloth-handoff.md](../ui/cloth-handoff.md) (cloth sim), [ui/armature.md](../ui/armature.md) (skinning/posing)

---

## 1. Summary

Let casual users **dress 3D characters**: pick a garment for a slot (top, bottom, dress, shoes, accessory…), **customize its fabric by drawing/painting it in 2D**, tweak fit, and pose — without modeling anything from scratch.

The critical realization: **most of the hard 3D plumbing already exists.** Salsa has a kitbash character-assembly system (canonical skeleton + slotted skinned meshes + a part catalog + swap + persistence) and a brand-new UV-paint system (paint a mesh's texture directly on its unwrapped UV). Fashion Creator is mainly **(a) a garment content library, (b) a fabric-design layer that points UV paint at garment slots, and (c) a simple "Fashion" UI** — plus optional parametric-fit and cloth-drape extensions.

**The differentiator:** the *shape* of clothing is handled by a preset library (the hard, unfun part), while the *creative* part — fabric, prints, colors, logos — is done with Salsa's drawing tools. "Pick a hoodie → paint its fabric → pose." That plays to Salsa's strengths instead of fighting them.

---

## 2. Goals / Non-goals

**Goals**
- A basic user can dress a character in <2 minutes: choose garments per slot, recolor/print the fabric, pose, done.
- Reuse the existing kitbash character system, armature/skinning, UV paint, and persistence — minimize new engine work.
- Garments deform correctly with poses/animation (they're skinned to the same skeleton).
- Fabric design is the headline feature and is almost entirely reuse of UV paint + (host-side) AI textures.

**Non-goals (v1)**
- Full sewing/pattern-making (Marvelous/CLO style).
- Physically accurate cloth or per-thread simulation.
- Arbitrary **AI image-to-mesh garments** in the core path (parked as experimental — today's output is messy, non-riggable topology that won't fit/skin cleanly).
- A full character creator (only the minimal body/skin/hair that already falls out of the slot system).

---

## 3. What already exists (reuse — do NOT rebuild)

| System | Where | What it gives Fashion Creator |
|--------|-------|-------------------------------|
| **Kitbash character assembly** ("Phase B") | [shape-manager.ts:3290-3368](../../src/services/shape-manager.ts#L3290), [types/kitbash-3d.ts](../../src/types/kitbash-3d.ts) | Canonical 26-joint skeleton; per-slot `SkinnedMesh3D` parts; part catalog; `createCharacter3D`, `swapCharacterSlot3D`, `setCharacterSlotColor3D`, `removeCharacter3D`, `getAllCharacters3D`; **clothing slots already defined**: `top`, `bottom`, `shoes`, `accessory_head/back/left/right`, plus `base_body`, `hair`, `face_overlay`, `overlay`. |
| **Part catalog** | `loadKitbashLibrary3D(manifestUrl)`, `addKitbashParts3D`, `getKitbashParts3D(slot)`, `getKitbashSlots3D` | Browse garments by slot; `KitbashPartMeta` = {id, slot, name, thumbnail, glbUrl, tags, styleSet}. |
| **Armature / skinning** | [armature.md](../ui/armature.md) | Auto-skin (heat diffusion), pose library, animation clips, IK/FK. Parts are authored against the canonical skeleton and remapped at assembly, so **fit + rig is "free."** |
| **UV paint** (new) | [uv-editor.md](../ui/uv-editor.md), `enterUVPaintMode3D` | Paint a mesh's texture directly on its unwrapped UV; persists as `meshTextures/{meshId}.png`. **This is the fabric-design engine.** |
| **Cloth sim** | [cloth-handoff.md](../ui/cloth-handoff.md), [cloth-simulator.ts](../../src/renderer/3d/cloth-simulator.ts) | Grid cloth, pinning, drape onto **sphere/box/ground** proxies, live sim, bake-to-mesh. **No arbitrary-mesh collision yet** → relevant only for Phase 4. |
| **Morph targets / blend shapes** | mesh-3d.ts, [theory/blend-shapes.md](../theory/blend-shapes.md) | Parametric garment fit (length/sleeve/looseness sliders). |
| **PBR/IBL materials, GLTF import/export** | renderer/3d | Garment materials; GLB is the part format. |
| **Persistence** | [document-persistence.ts](../../src/services/persistence/document-persistence.ts), [project-package.ts](../../src/services/persistence/project-package.ts) | `CharacterData` records already serialized; `scene3dJSON`, `models3d`, `meshTextures` already saved/restored. |

**Implication:** a basic **character creator** is also ~80% implied by the same system (`base_body` / `hair` / `face_overlay` slots + `skinTone`/`hairColor` on `CharacterDefinition`). Don't gate Fashion on a separate character-creator feature.

---

## 4. The gap (what Fashion Creator actually adds)

1. **Garment content library** — GLB parts authored against the canonical skeleton, with UVs, registered as `KitbashPartMeta`. *(Biggest cost; it's art/content, not engine.)*
2. **Fabric-design layer** — point UV paint at a character slot's mesh; fabric/print presets; AI-generated prints; persist per-slot fabric. *(Mostly reuse + a thin API.)*
3. **Parametric fit** — garment morph sliders. *(Per-garment authoring + small API.)*
4. **Fashion UI mode** (Frogmarks) — browse/swap garments, fabric controls, pose, export.
5. **(Advanced) Cloth drape** for loose garments — needs body-mesh collision. *(Real new engine work.)*

---

## 5. Data model

- **Character** = canonical `Skeleton3D` + one `SkinnedMesh3D` per filled `CharacterSlot` (existing `CharacterData` / `CharacterDefinition`).
- **Garment** = a catalog part (`KitbashPartMeta`) instantiated into a clothing slot, optionally with morph values and a **fabric**.
- **Fabric** = the slot mesh's diffuse: a solid color (existing tint), a tileable pattern, an AI print, and/or a hand-painted texture (UV paint → `meshTextures`).
- **Outfit** = the set of filled clothing slots on a character.

**`CharacterDefinition` extension** (additive, back-compatible):
```ts
interface CharacterDefinition {
  // ...existing: id, name, slots, skinTone, hairColor
  /** Per-slot fabric overrides (color / pattern id / painted texture id / print prompt). */
  fabrics?: Partial<Record<CharacterSlot, FabricSpec>>;
  /** Per-slot garment morph values, keyed by morph name. */
  morphs?: Partial<Record<CharacterSlot, Record<string, number>>>;
}
interface FabricSpec {
  baseColor?: { r: number; g: number; b: number };
  patternId?: string;            // texture-library tileable pattern
  paintedTextureMeshId?: string; // → meshTextures/{id}.png (UV paint)
  aiPrompt?: string;             // record the prompt that generated the print
}
```

---

## 6. Phasing

| Phase | Scope | New engine? | Notes |
|-------|-------|-------------|-------|
| **0 — Base** | Ship one rigged **mannequin** (base_body GLB + canonical skeleton + standard pose). | Minimal | The linchpin everything is authored against. Largely exists; needs the actual base-body asset + a default standing pose. |
| **1 — Wear** | Garment **library** + browse/swap UI. | Low | Reuse `getKitbashParts3D`/`createCharacter3D`/`swapCharacterSlot3D`. Build the catalog content + Fashion panel. |
| **2 — Fabric** | Per-slot **fabric design**: UV paint on a garment + fabric/print presets + AI prints. | Low | Reuse UV paint; wire it to slot meshes; AI is host-side. **The headline feature.** |
| **3 — Fit** | **Parametric** garment morph sliders. | Low–med | Per-garment morph authoring + `setGarmentMorph3D`. |
| **4 — Drape** | **Cloth** for loose garments (dresses/coats). | High | Needs body-mesh collision (capsule rig from the skeleton, or SDF) — see §7.5. Advanced/optional. |
| **5 — Character** | Minimal **character creator** (body/skin/hair via existing slots + tints). | Low | Falls out of the same slot system; mostly content + UI. |

---

## 7. Detailed design

### 7.1 Garment authoring pipeline (content)
- Each garment is a **GLB** modeled in **T-pose**, sized to the **standard mannequin**, **UV-unwrapped**, rigged/weighted to (a subset of) the **canonical 26-joint skeleton**, occupying one `CharacterSlot`. Registered as a `KitbashPartMeta` (slot, name, thumbnail, glbUrl, tags, styleSet).
- Optional **morph targets** named by convention (e.g. `len`, `loose`, `sleeve`) for Phase 3 sliders.
- Deliverable: an **authoring template** (a Salsa scene / blend file with the base body + canonical skeleton + slot guides + naming conventions) so artists — or AI-assisted base meshes refined by hand — produce conformant parts. The `CharacterAssembler` already remaps part joint indices → canonical at assembly time, so parts only need to follow the joint **names**, not exact indices.

### 7.2 Fit & skinning (reuse, no new work for MVP)
- Because garments are authored against the standard body and skeleton, **fit and rig are by construction.** `createCharacter3D` / `swapCharacterSlot3D` instantiate the GLB, remap joints, and the part deforms with poses via existing skinning.
- **Body-shape variation (later):** add morphs to `base_body`, then a **conform pass** on garments — a new `shrinkwrap`-style EditMesh modifier that projects garment vertices onto the nearest body-surface point + a thickness offset, and copies skin weights from the nearest body vertex. Keep out of MVP.

### 7.3 Fabric design (Phase 2 — headline)
- A clothing slot's mesh is a `SkinnedMesh3D` with UVs from its GLB → **point UV paint at it**: `enterUVPaintMode3D(slotMeshId, uvRenderer, opts)`. Strokes paint the garment's diffuse live; the painted texture **persists** via the existing `meshTextures/{meshId}.png` path.
- **Fabric presets:**
  - *Solid* — existing `setCharacterSlotColor3D`.
  - *Pattern* — a tileable texture from the texture library set as the slot diffuse.
  - *AI print* — host-side: prompt → image → (tileable) texture → slot diffuse / paint layer. Record `aiPrompt` in `FabricSpec`.
  - *Hand-painted* — UV paint (above), optionally seeded from a pattern/print.
- **New API:** `setCharacterSlotFabric3D(charId, slot, FabricSpec)` and `paintCharacterSlotFabric3D(charId, slot, uvRenderer)` (opens UV paint on that slot). Persist `FabricSpec` per slot in `CharacterDefinition`.

### 7.4 Parametric fit (Phase 3)
- Expose a garment's morph targets as sliders. `setGarmentMorph3D(charId, slot, morphName, value)` / `getGarmentMorphs3D(charId, slot)`. Reuse the blend-shape system. Persist in `CharacterDefinition.morphs`.

### 7.5 Cloth drape (Phase 4 — advanced)
- Mark a garment "dynamic" → simulate instead of (or after) skinning.
- **Required new engine work — body collision:** the cloth sim currently collides only with `{none|ground|sphere|box}` proxies ([cloth-simulator.ts:39](../../src/renderer/3d/cloth-simulator.ts#L39)). To drape on a character, generate a **capsule/sphere collision rig** from the canonical skeleton (one capsule per major bone, radius sampled from the body mesh) and extend the cloth collision shader to test against a **set** of proxies. (An SDF of the body is the higher-fidelity alternative; capsules are the tractable MVP.)
- Pin the garment's attachment ring (waistband / shoulders) so it stays on the body; run live-sim or bake to geometry. Reuse the existing live-cloth handle + bake.

### 7.6 Persistence
- `CharacterData` already serializes (scene3d + project-package). Add `fabrics` + `morphs` to `CharacterDefinition` (additive). Painted fabrics ride the existing `meshTextures` save/restore. Catalog GLBs are referenced by `glbUrl` (not re-saved); only custom/edited meshes go through `models3d`.

---

## 8. ShapeManager API

**Reuse:** `loadKitbashLibrary3D`, `addKitbashParts3D`, `getKitbashParts3D`, `getKitbashSlots3D`, `createCharacter3D`, `swapCharacterSlot3D`, `setCharacterSlotColor3D`, `removeCharacter3D`, `getCharacterDefinition3D`, `getAllCharacters3D`, `enterUVPaintMode3D`/`setUVPaintBrush3D`, pose-library + clip APIs.

**New:**
```ts
createMannequin3D(basePartId?): Promise<string>        // character from a default base body
setCharacterSlotFabric3D(charId, slot, spec: FabricSpec): void
paintCharacterSlotFabric3D(charId, slot, uvRenderer): void  // → UV paint on that slot
setGarmentMorph3D(charId, slot, morph: string, value: number): void
getGarmentMorphs3D(charId, slot): Record<string, number>
getOutfit3D(charId): Partial<Record<CharacterSlot, { partId; fabric?; morphs? }>>
enableGarmentCloth3D(charId, slot, opts?): void         // Phase 4
```

---

## 9. Frogmarks "Fashion" UI mode

A dedicated mode (like the UV editor): **character viewport (left) + Fashion panel (right)**, following the same "keep it simple" philosophy as the simplified UV editor.

```
FASHION ─────────────────────────────────
 Category tabs:  [Tops][Bottoms][Dresses][Outerwear][Shoes][Accessories] | [Body][Hair][Face]
 ── Garments ──  thumbnail grid (getKitbashParts3D(slot))   → click = swapCharacterSlot3D
 ── Fabric ──    Color ▢   Pattern ▾   [✦ Paint fabric]   [✦ AI print: ____]
 ── Fit ──       (morph sliders, only if the garment has morphs)
 ── Pose ──      pose dropdown (pose library)   |   [Animate ▾] (clips)
 ── Export ──
```
- "Paint fabric" → `paintCharacterSlotFabric3D` (UV paint on the selected slot's mesh).
- Layering handled by slot order (outerwear over top) + a small per-slot z/offset to reduce clipping.

---

## 10. AI integration (host-side, Frogmarks)

- **Fabric/prints, not meshes.** Prompt → image → tileable texture → slot diffuse (or a paint layer to refine). This is the safe, high-value use of AI and feeds the UV-paint flow directly.
- Optional later: **outfit suggestions** (AI proposes slot combinations from a vibe/prompt). 
- **Image-to-mesh garments:** parked as an experimental "generate a rough base, refine by hand" — not core, because the output won't fit/skin cleanly enough for basic users.

---

## 11. Content strategy (the real cost)

The library is the dominant effort. Recommended starter set authored against the canonical skeleton: ~3–5 each of tops, bottoms, dresses, outerwear, shoes; a handful of accessories; 1–2 base bodies + a few hairstyles. Define the authoring template + naming conventions up front. Consider AI-assisted base generation **refined by hand** to accelerate, and a versioned `styleSet` so the catalog can evolve.

---

## 12. Risks / open questions

- **Content authoring cost** — the garment library is the bottleneck; engine work is comparatively small.
- **Clipping & layering** between garments (top vs outerwear; thick shoes vs pants). Mitigate with slot draw-order + small offsets + optional "hide underlying slot" flags per garment.
- **Body-shape variation vs pre-authored fit** — morphs + a conform modifier (Phase 3+), or ship a single canonical body for MVP.
- **Cloth-on-body collision** (Phase 4) is genuine new tech (capsule rig or SDF) — scope carefully.
- **AI infra/cost** — lives host-side (Frogmarks); define the contract (prompt → texture URL/data).
- **Accessory attachment** (belts, hats, bags) — bone-parented transforms vs surface conform; per-accessory choice in `KitbashPartMeta`.

---

## 13. Out of scope (v1)
Sewing/pattern-making; physically accurate cloth; AI mesh garments in core; multi-character "runway" scenes; marketplace/sharing of garments (later).

---

## 14. MVP vertical slice (validate before investing)

Build the thinnest end-to-end first:
1. **One mannequin** — base_body GLB + canonical skeleton + a default standing pose.
2. **One garment** — a tee authored against it in the `top` slot, registered in the catalog.
3. **Swap UI** — minimal panel: pick the tee → it's worn (reuse `swapCharacterSlot3D`).
4. **Fabric** — paint the tee's fabric with UV paint; verify it shows live and persists.
5. **Pose** — apply one pose; verify the tee deforms with the body.
6. **Save → reload** — the dressed, painted, posed character round-trips.

If that slice feels good, the rest is "more content + UI + the optional cloth/morph extensions." If it doesn't, we've spent days, not months, finding out.

---

## 15. Effort summary

- **Mostly done (reuse):** character assembly, slots, swap, skinning, posing, UV-paint fabric, persistence.
- **New but small:** fabric API (`setCharacterSlotFabric3D`/`paintCharacterSlotFabric3D`), morph API, Fashion UI mode.
- **New and large:** the **garment content library** (art), and **Phase 4 cloth-on-body collision** (engine).
- **Host-side:** AI texture/print generation.
