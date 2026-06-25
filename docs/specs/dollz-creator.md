# Dollz Creator — Design Spec

**Status:** Proposal / design (not started)
**Date:** 2026-06-16
**Owner:** TBD
**Supersedes/extends:** [fashion-creator.md](fashion-creator.md) (the kitbash + fabric stage is a *component* of this pipeline)
**Related:** [ui/uv-editor.md](../ui/uv-editor.md) (UV/mesh paint), [ui/armature.md](../ui/armature.md) (pose), kitbash character system, PS1/retro render (`PS1Config`, `WOBBLE_PRESET`), **[character-creation-pipeline.md](./character-creation-pipeline.md)** (how base bodies + custom clothing get *made* in-app — the authoring layer this spec assumes as "art")

---

## 1. Summary

Let a casual user make a **PS1/PS2-era low-poly anime "dollz"** character + scene — and have it **look "right" the instant they start**, without modeling, UV-wrangling, or shader-graph nodes in Blender.

The reference aesthetic (lordstingray, alec.fbx, maitooo.8 — the Y2K / dollcore / SLUMLORDZ scene): chunky low-poly anime figures with **hand-painted pixel textures**, **affine/warpy PS1 texture mapping**, **nearest-neighbor (unfiltered) low-res textures**, flat/vertex lighting, a low-res render upscaled with nearest-neighbor, signature **doll proportions** (long thin legs, tiny shorts, small torso, big hair, chunky white boots), posed and presented as a **character card/scene** (the "Hinata & Toodie — Loves/Hates" layout) over a 2D/photo backdrop.

**North star: "looks right off the bat."** A newcomer who picks a base doll and a couple of parts should already have something that reads as *this style* — before any skill is applied. Customization (edit geo, paint pixels, restage) is the *next* layer, not the price of entry.

**Why Salsa is the right tool for this (and Blender isn't):**
1. **The pixel-texture workflow** the style is built on = our UV-paint-on-mesh + auto-unwrap + shared brush system (already built).
2. **The PS1 render** the artists hand-build with nodes = our `PS1Config` + lo-fi pass as a **one-click default**.
3. **The character card is the native output** — a 3D doll composited over a 2D-drawn/photo backdrop with text and decoration is *one canvas* in Salsa (2D illustration + 3D mesh), two tools elsewhere.

---

## 2. The aesthetic, decomposed (visual → technical requirements)

The style is specific; the tooling must hit these, not "generic 3D anime":

| Visual trait | Technical requirement | Salsa system |
|---|---|---|
| Chunky, faceted low-poly geo | Low-poly base + parts; flat/faceted normals; editable | mesh-edit, GLB parts |
| **Hand-painted pixel textures** (faces, clothes) | Low-res texture (128²–256²), **nearest-neighbor sampling**, painted on UVs | UV paint (✅ built) — *needs a nearest-filter toggle (see §9.2)* |
| Warpy/affine texture mapping | `affineStrength`, `uvQuantize` (texel crawl) | `PS1Config` (✅) |
| Vertex wobble / snap | `vertexJitter`, `snapGridSize` | `PS1Config` (✅) |
| Low-res render, nearest upscale | `renderResolution` + lo-fi blit | `PS1Config` + `LoFiPass` (✅) |
| Banded color / dither | `colorDepth`, `dither` | `PS1Config` (✅) |
| Flat / vertex lighting (not PBR) | Low/flat lighting preset | light config (✅) — needs a "flat" preset |
| **Doll proportions** (legs/boots/hair) | Opinionated base bodies + iconic parts | curated kit (**to author**) |
| Posed | Skeleton + pose library | armature (✅) |
| **Character card / scene** over 2D/photo bg | 3D doll composited into a 2D illustration + text/decoration | 2D+3D hybrid canvas (✅) |

**Takeaway:** ~70% of the *engine* exists. The two real investments are **(a) the curated base-body + parts kit** (art/content) and **(b) the "looks right by default" wiring** that turns all the existing knobs ON and sane the moment you enter Dollz mode.

---

## 3. Design principles

1. **Newcomers first, tweaks always one click away.** Default to opinionated, curated, "right." Every default is also an entry point to edit (proportions slider, swap part, paint texture, restage). Target user is a *mix*, prioritizing newcomers — so the floor is "pick and it looks good," the ceiling is "edit the geo + paint every texel."
2. **Right by default, not right after work.** The retro render, pixel-texture defaults, lighting, and a starting pose/scene are **on** from the first frame. The user should never see a flat, smooth, PBR, perspective-correct "wrong" version first.
3. **The kit carries the look.** Cohesion comes from a shared skeleton + shared proportions + a shared palette + the retro preset — so *every* user's output lands in the same visual family (the "cohesive gallery" effect).
4. **House style: nail the reference first, brand later.** v1 goal is to *reproduce* the reference aesthetic faithfully. Once that's solid and the pipeline is proven, fork a distinct house style (unique base bodies/parts/palette) on top of the same pipeline. (User is leaning distinct, but explicitly wants the reference look working first.)
5. **Reuse > rebuild.** This is mostly an *assembly + defaults + content* project on top of finished engine systems. Resist new engine work outside the small gaps in §7.

---

## 4. The pipeline

```
  ┌─────────┐   ┌──────────┐   ┌────────────┐   ┌──────┐   ┌──────────────┐   ┌──────────────┐
  │  BASE   │ → │  KITBASH │ → │ EDIT/PAINT │ → │ POSE │ → │ CARD / SCENE │ → │ RETRO RENDER │
  │  body   │   │  parts   │   │ geo+pixels │   │ rig  │   │  2D + 3D     │   │  (default ON)│
  └─────────┘   └──────────┘   └────────────┘   └──────┘   └──────────────┘   └──────────────┘
   curated      Fashion         mesh-edit +      armature   2D illustration    PS1Config +
   bodies       Creator         UV paint +       + pose      layers + text     lo-fi pass
   (author)     (spec'd)        focus bg         library     + the 3D doll     (WOBBLE-ish)
```

Each stage maps to an existing system; the **retro render is applied across the whole pipeline from the start**, so what you see while kitbashing/painting/posing already looks like the final.

---

## 5. The "Looks Right Off the Bat" system  *(the heart of this spec)*

Four cross-cutting enablers. Without these, you have a generic kitbash tool; with them, you have *this style*.

### 5.1 Retro render preset — default ON in Dollz mode
A single **"Dollz / Retro" preset** mapped to `PS1Config` (the existing `WOBBLE_PRESET` is ~90% of it):
```
vertexJitter ~0.4–0.8 · snapGridSize ~160 · affineStrength ~0.5 · colorDepth 32
renderResolution [320,240]→[480,360] · dither on (~0.4) · uvQuantize on (64)
+ flat/low lighting preset · optional light fog
```
Applied via `setPS1Config` / lo-fi pass the moment the user enters Dollz mode. Expose a small **intensity dial** (Off → Subtle → Full) so non-fans can dial it back, but **Full-ish is the default**. This is the single biggest "instantly right" lever — it's the look artists fight nodes for.

### 5.2 Pixel-texture defaults
- Every paintable surface (base, parts) ships **UV-unwrapped** and backed by a **low-res texture (128² or 256²)** sampled **nearest-neighbor**, so any brush stroke *is* pixel art automatically.
- Ship **pixel brush presets** (1px hard square, dither, etc.) and a **limited Y2K palette** as the default swatches. (The brush system + palettes already exist — this is config + content.)
- Faces especially: parts like `face_overlay` default to a small texture so the iconic pixel-eyes/mouth read correctly.

### 5.3 The curated kit (proportions + iconic parts)
- **2–3 base bodies** sharing the **canonical 26-joint skeleton**, each nailing the doll proportions (long legs, small torso, big-hair allowance, chunky-boot stance). Proportions *are* the brand — author them deliberately.
- **Iconic starter parts**, pre-unwrapped + retro-ready: hair (several), tops, bottoms, **the chunky boots** (multiple — signature), accessories (hearts, ears, headphones), props (guns/mascots), and **companion blobs** (Toodie-style mascots as a part type).
- All authored against one template so swap/pose/retarget is free (Fashion Creator §7.1).

### 5.4 Card / scene templates  *(the 2D-hybrid differentiator)*
- **Scene presets**: checkerboard floor + gradient sky, the "white turntable platform," a "photo/illustration backdrop" slot (draw or drop a 2D city bg, pose the doll over it).
- **Character-card templates**: the "Hinata!" layout — name banner, Loves/Hates bubbles, decorative dots/checker, the 3D doll composited in. These are **Salsa illustration documents with a 3D character node** — pre-built layouts the user fills in. This makes the *finished post* (not just the model) the one-click output, which is what actually gets shared.

---

## 6. Relationship to Fashion Creator

Fashion Creator **is the Kitbash + Edit/Paint stage** of this pipeline, scoped to clothing. Dollz Creator is the **superset**: it wraps that with (a) the curated *doll* base bodies + parts, (b) the aesthetic-enforcement layer (§5.1–5.2), (c) pose, and (d) the card/scene + retro output (§5.4, §5.1). Everything in Fashion Creator §3 "what exists" and §8 "API" is reused verbatim. Build order: Fashion Creator's MVP slice (§14) is also Dollz Creator's stage-2 slice.

---

## 7. What exists vs what's new

| Stage | Exists (reuse) | New (build) |
|---|---|---|
| Base | canonical skeleton, GLB import, skinning, default pose | **2–3 doll base bodies** (art); a default standing pose |
| Kitbash | `createCharacter3D`/`swapCharacterSlot3D`/slots/catalog | **parts library** (art); Dollz part manifest |
| Edit/Paint | mesh-edit, UV paint, focus bg, brush system | nearest-filter texture toggle; pixel brush/palette defaults |
| Pose | armature, pose library, clips, IK/FK | a few doll-friendly default poses |
| Card/Scene | 2D illustration layers + 3D mesh compositing, bg options, fog | **scene + card templates**; "place 3D character in a 2D doc" UX |
| Retro | `PS1Config`, `LoFiPass`, `WOBBLE_PRESET`, dither | **Dollz/Retro preset** + intensity dial + flat-light preset; default-ON wiring |
| Persistence | `CharacterData`, `scene3dJSON`, `models3d`, `meshTextures` | `DollzProject` wrapper (render preset + scene/card refs) |

**Net new engine work is small.** The dominant cost is the **curated art kit** (§12).

---

## 8. Data model

Reuse `CharacterDefinition` (+ Fashion Creator's `fabrics`/`morphs` additions). Add a thin project wrapper so a "doll" carries its look:

```ts
interface DollzProject {
  characterId: string;              // the kitbashed character (CharacterDefinition)
  renderPreset: 'retro' | 'pocket' | 'custom';
  ps1?: Partial<PS1Config>;         // custom overrides (intensity dial → presets)
  scene?: DollzScene;               // floor/sky/backdrop preset
  cardTemplateId?: string;          // optional character-card layout
  poseId?: string;                  // active pose-library entry
}
interface DollzScene {
  floor: 'checker' | 'platform' | 'none';
  sky: 'gradient' | 'solid' | 'image';   // image → a 2D illustration layer / photo
  bgColor1?: [number,number,number,number];
  bgColor2?: [number,number,number,number];
}
```
Painted textures ride the existing `meshTextures/{meshId}.png` path; the edited base/parts geometry rides `models3d` + the new editable-geometry serialization (so a *carved* doll round-trips). Catalog parts are referenced by id, not re-saved.

---

## 9. Detailed stage notes

### 9.1 Base bodies & kitbash
Per Fashion Creator §7.1–7.2. The only Dollz-specific point: **proportions + the boots/hair are the look** — author the bases with intent, and ship enough hair/boot variety that the *first* random-ish pick already reads as dollcore.

### 9.2 Edit / paint (reuse + one gap)
- Editing geo → mesh-edit; painting pixels → UV paint on the part mesh (`enterUVPaintMode3D(meshId)`), with the new **focus background** hiding 2D clutter for a clean workspace.
- **Gap — nearest-neighbor texture sampling.** The pixel look needs the *mesh diffuse sampler* set to `nearest` (not linear). Verify the mesh pipeline's sampler; if it's linear, add a per-material/global "pixelated textures" flag (small). `PS1Config.uvQuantize` gives texel-crawl but not the crisp-texel look — both matter. **Action: confirm/add nearest sampling for mesh diffuse.**

### 9.3 Pose
Reuse armature + pose library. Ship a handful of doll-friendly default poses (the "holding props," "peace sign," "idle"). Poses are shared across all kitbashed bodies (same skeleton) → a newcomer poses any doll instantly.

### 9.4 Card / scene (the differentiator)
- A Dollz scene is a normal Salsa illustration document with: background raster/vector layers (drawn or photo), a **3D character node** (the doll), and foreground decoration/text layers (card UI). The existing 2D+3D compositing already supports a 3D mesh between 2D layers.
- **Templates** are saved documents with placeholder layers + the character node pre-placed; "New Dollz Card → Hinata layout" instantiates one. Filling in name/Loves/Hates = editing text layers.
- This reframes the product output from "a model" to "a shareable character card," which is what the reference accounts actually post.

### 9.5 Retro render
Per §5.1. Apply on Dollz-mode entry; persist `renderPreset`/`ps1` in `DollzProject`. The intensity dial maps Off→`DEFAULT_PS1_CONFIG`, Subtle→`POCKET_PRESET`-ish, Full→`WOBBLE_PRESET`-ish.

---

## 10. Newcomer UX flow (opinionated)

```
NEW DOLL
 1. Pick a base body         (2–3 thumbnails — already proportioned + retro-rendered)
 2. Auto-styled              (lands wearing a default hair+top+bottom+boots so it looks "right" immediately)
 3. Swap parts               (slot grid — hair/top/bottom/shoes/accessory/prop)   ← Fashion Creator panel
 4. Make it yours (optional) [Recolor] [Paint pixels] [Edit shape] [Proportions]   ← one click each
 5. Pose                     (pose dropdown)
 6. Stage                    (scene preset / card template; draw or drop a backdrop)
 7. Render/Export            (Retro preset already on; intensity dial; export image/card)
```
Steps 1–3 + 5–6 require **zero skill** and already look right. Step 4 is the depth for the "pro-ish" half. Everything is the existing engine + the curated kit + the defaults.

---

## 11. Phasing & MVP

| Phase | Scope | New engine? |
|---|---|---|
| **0 — Retro-by-default** | Wire the Dollz/Retro `PS1Config` preset + flat light + nearest texture sampling; verify on *any* existing mesh. | Tiny (nearest sampler) |
| **1 — One doll, right** | One base body (proportioned) + default outfit, entered with retro on → it *looks like the reference*. | Content + defaults |
| **2 — Kitbash** | Parts library + swap panel (= Fashion Creator MVP). | Low (reuse) |
| **3 — Paint** | Pixel-paint a part (UV paint + nearest + pixel brushes/palette), persist. | Low (reuse) |
| **4 — Pose + Scene** | Default poses + one scene/card template (2D bg + doll + text). | Low (reuse) |
| **5 — Customize** | Proportions/morphs + mesh-edit access; "make it yours." | Low–med |

### MVP vertical slice (prove "looks right off the bat" *first*)
1. Take **one existing low-poly mesh**, enter Dollz mode → **Retro preset auto-applies** + nearest textures. Does it read as PS1 dollcore? *(This validates the cheapest, highest-leverage piece before any character art.)*
2. Author **one base body** with the doll proportions + a default outfit; it appears already-retro and already-dressed.
3. **Pose** it from the library; **paint** one pixel texture; **drop it on a checker+gradient scene**.
4. **Save → reload** round-trips the doll + paint + scene + render preset.

If step 1 already feels like the reference, the rest is content + UI. If it doesn't, we learn the render gap in a day, not a quarter.

---

## 12. Content strategy (the real cost)

The **curated kit is the dominant effort and the brand.** Recommended v1 set, all on the canonical skeleton + retro-ready + pre-unwrapped with low-res textures:
- **2–3 base bodies** (the proportions — author with intent).
- **Hair** ×5+, **tops** ×4, **bottoms** ×4, **boots/shoes** ×4 (signature), **accessories** ×6 (hearts/ears/headphones), **props** ×3 (guns/mascots), **companion blobs** ×2.
- A **Y2K palette** + **pixel brush presets** as defaults.
- **2–3 scene presets** + **1–2 card templates**.

Define the authoring template + naming conventions up front (Fashion Creator §7.1). AI-assisted base generation **refined by hand** can accelerate; a versioned `styleSet` lets the kit evolve toward the eventual house style without breaking saved dolls.

---

## 13. Risks / open questions

- **The kit is the bottleneck** (art, not engine) — and it's also where the "looks right" cohesion lives. Don't under-invest.
- **Nearest texture sampling** for mesh diffuse — confirm/add (§9.2); it's load-bearing for the pixel look.
- **Proportions vs. fit** — if base bodies vary a lot, garments need a conform pass (Fashion Creator §7.2). MVP: one canonical proportion, add variants behind morphs later. **Now specced in detail** in [character-creation-pipeline.md](./character-creation-pipeline.md) §5 (shrinkwrap re-fit for custom parts / shared blend shapes for the curated kit) — and that spec locks the key decision: the hero body is an **authored canonical template reshaped via blend shapes, NOT inflated** (inflation can't do hands/feet/face).
- **How "house style" diverges from the reference** — deferred by user decision: nail the reference first, then fork brand bodies/parts/palette on the same pipeline.
- **Affine/jitter intensity** is taste-dependent — the intensity dial + good defaults mitigate; gather user feedback on the default level.
- **2D-hybrid card export** — confirm the export path captures 2D layers + the 3D doll (retro-rendered) into one image at card resolution.

---

## 14. Effort summary

- **Mostly done (reuse):** kitbash assembly/slots/swap, skinning, pose library, UV/mesh paint, focus bg, 2D+3D compositing, `PS1Config`/lo-fi retro, persistence.
- **New but small:** Dollz/Retro preset + intensity dial + flat-light preset, nearest texture sampling, `DollzProject` wrapper, scene/card templates, Dollz UI mode (extends the Fashion panel).
- **New and large:** the **curated base-body + parts kit** (art) — the look, the brand, the bottleneck.
- **Host-side (Frogmarks):** the Dollz/Fashion panel UI, AI prints (optional), card-layout editing.

**One-line thesis:** *Salsa already has the PS1 render and the pixel-paint pipeline these artists hand-build in Blender — Dollz Creator is the curated kit + "right-by-default" wiring + the 2D-hybrid character card that turns those into a one-click dollcore creator.*
