# City Props, Decals & GARP — closing the detail gap

**Status:** 📋 Not built (this document is the plan)
**Date:** 2026-07-27
**Related:** [city-detail.md](city-detail.md) · [city-visual-upgrade.md](city-visual-upgrade.md) · [building-generator.md](building-generator.md) · [procedural-ground.md](procedural-ground.md) · [instancing-blocks.md](instancing-blocks.md)

---

## 0 · Why this spec exists

The city's **materials** are now largely solved — after the 2026-07-27 sweep only **1.3%** of city
triangles render as pure flat colour, down from 9.0%. What remains is not a shading problem. It is that
much of the city's street-level content is **geometrically absent or trivial**:

| prop | triangles today | what it is |
|---|---:|---|
| vending machine | **12** | one box |
| post box | **12** | one box |
| utility cabinet | **12** | one box |
| shop sign / blade sign | **12** each | one box |
| lamp post | 34 | prism + blob + disc |
| bicycle | 40 | 2 blobs + 4 beams |
| bench | 56 | solid slab, no slats |
| traffic light | 122 | the most detailed prop in the city |

A texture on a 12-triangle box is a sticker on a brick. **Geometry first, then texture variety** is the
ordering principle of this whole spec: a pooled-texture system applied to boxes buys very little; applied
to well-formed props it is a large multiplier.

### Standing constraint: triangle budget is not the issue

Measured on a default seed-3 grid city (4.92 M triangles total):

| bucket | tris | share |
|---|---:|---:|
| foliage | 3,621,726 | **73.6%** |
| metal | 732,886 | 14.9% |
| pattern | 407,658 | 8.3% |
| flat | 66,250 | 1.3% |
| emissive / glass / ground / water | ~94,000 | 1.9% |

Every prop in this spec is rounding error against foliage. Props are a **quality** investment, not a perf
risk. If the city ever feels heavy, foliage is the thing to look at, not street furniture.

---

## 1 · Architecture: props become generators

Today every prop is emitted inline into a shared `Accum3D` merge accumulator inside `furniture.ts` /
`streets.ts`, keyed by colour. That is why they are boxes — there is nowhere to express structure.

**The move:** each significant prop becomes a small generator module with the same shape as the ones that
already work well — `conifer.ts`, `awnings.ts`, `signtext.ts`. A generator:

- takes a params object (size, style index, seed, and a variant/skin selection);
- returns **sub-layers**, one per material family, not one merged blob;
- is deterministic in its seed;
- carries a triangle budget stated in its header.

The sub-layer split is what makes materials work automatically. A vending machine is not "a metal thing";
it is a painted-metal body, a glass window, an emissive interior panel, and matte product boxes behind the
glass. Split that way, each sub-layer picks up the correct material family from the existing library with
no special cases.

### ⚠ The one-family-per-mesh rule

`pattern`, `ground`, `metal`, `water`, `neon` and `foliageShade` **all repurpose the same four instance
floats** (`patternColor` 48–51 / `patternParams` 52–55). A mesh is exactly one of them. Setting two does
not layer two effects — the renderer writes whichever branch it reaches first and the other is silently
gone, with no error anywhere.

This has already caused one 366k-triangle regression (a name-based classifier handed `metal` to layers
that carried an authored `grid` pattern, deleting the panel seams on rooftop plant and the glazing bars on
window trim). It is now guarded by `src/world/city-materials.test.ts`. **Every generator in this spec must
respect it: one family per sub-layer, and split the sub-layer if you need two.**

`glass` is a plain flag bit and does *not* touch the slots, so it composes freely.

---

## 2 · GARP — Grouped Asset Randomizer Pool

### 2.1 What the renderer already gives us

Better than expected. The 3D city path already has a `texture_2d_array` atlas, and **`textureIndex` is
per-instance** (instance float 44). The batcher explicitly permits meshes with *different* textures to
batch together when they are atlas-resident:

```
// atlas meshes: no texture-based break — they all share the atlas bind group
```

So "N objects each pulling a different texture from a pool" costs **one draw call**. The wiring needed is
small: a `texture?:` field on `LayoutPreviewLayer`, and a branch in `makeMesh` (`scene3d-manager.ts`) that
resolves it to a `textureLibraryId`.

### 2.2 Three hard constraints

1. **Uniform size + format per pool.** `_buildTextureAtlas` only packs a source when
   `width === W && height === H && format === 'rgba8unorm'`, where W/H come from the *first* entry.
   Mismatches silently fall back to layer 0 (solid white) **and** a standalone bind group — so a
   mis-sized texture both looks wrong and costs a draw call. A GARP pool is therefore a **fixed-resolution
   set by construction**, validated at registration time, not a loose bag of images.
2. **`arrayGroup` instances cannot vary texture yet.** Array-group instances copy floats 32–55 verbatim
   from the source mesh (`data.copyWithin(offset + 32, srcOffset + 32, srcOffset + 56)`), so every copy
   shares one `textureIndex`. Varying it means leaving float 44 per-instance and extending
   `InstanceOverride` (which today carries only `rotationEulerDeg` / `scale` / `visible`). See §5, Phase 4.
3. **No sub-tile atlasing.** There is no per-instance UV offset/scale and **no free instance float** — all
   eight shade modes already claim floats 48–55. Sprite-sheet cells are therefore out of reach. GARP is
   **full-tile only**.

Additional prep: `blob`, `beam`, `disc` and `hood` in `meshbuild.ts` emit **no UVs at all** (0,0), and
`obox` emits *world-unit* UVs rather than 0..1. Any prop that is going to be textured needs its UV
authoring fixed as part of its generator work.

### 2.3 ★ The design correction: pool coordinated SKINS, not loose textures

The naive reading of GARP — "a group holds N textures, the renderer picks one at random per object" —
breaks on the first real case. A vending machine has a *fascia* slot and a *products* slot. Random per
slot gives a Coca-Cola fascia over Pocari products. The unit of randomisation must be the **skin**: a
named set of textures that belong together.

```ts
interface GarpSkin {
  name: string;                          // 'pocari', 'coffee-boss', 'ramune'
  slots: Record<string, TextureId>;      // { fascia, products, side, glowMask }
  weight?: number;                       // relative pick frequency (default 1)
  tint?: [number, number, number];       // optional per-skin body colour
}

interface GarpPool {
  name: string;                          // 'vending-machines'
  size: [number, number];                // enforced; all skins must match
  slots: string[];                       // the slot names this pool defines
  skins: GarpSkin[];
}
```

Selection is **position-hashed**, never a running RNG — the same rule the rest of the city follows so
selective regeneration stays idempotent:

```ts
const skin = pool.skins[weightedPick(hash2(x * 13.7, z * 7.31, seed ^ POOL_SALT), pool.weights)];
```

There is direct precedent for this shape in `city-foliage.ts`, which buckets trees by `(kind, variant)`
and instances each bucket. GARP is the same idea with textures instead of geometry.

### 2.4 Registration and authoring

- Pools live alongside the existing texture library, registered by name at startup.
- A pool declares its slot names once; a skin missing a slot falls back to a pool-level default so a
  half-authored skin degrades rather than breaking.
- Validation at registration: dimension match, format match, all slots present-or-defaulted. **Fail loudly
  here** — the renderer's silent white fallback is exactly the kind of failure that ships green.
- Frogmarks gets a pool browser: see the skins in a group, add/remove, preview on the target prop.

### 2.5 Naming

"GARP" is fine as an internal shorthand but the user-facing concept is closer to **Skin Pool** — a group
of coordinated looks for one prop family. Suggest `Skin Pools` in UI, `garp` in code if the acronym is
liked.

---

## 3 · Decals — a separate, cheaper mechanism (and higher priority than GARP)

Posters, stickers, paste-up layers, tape residue, grime streaks and hand-painted shop text are the single
strongest visual tell of the anime-city look, and they are **not** a GARP problem:

- a decal is a **quad placed on a surface**, so it authors its own clean 0..1 UVs — none of the prop UV
  problems apply;
- it needs no per-instance texture variety, because each decal is its own small mesh;
- it composes with everything, since the wall underneath keeps its own material.

Design sketch:

- `placeDecals(surfaces, pool, seed)` — scatter along wall bands at plausible heights (poster height,
  eye-level stickers, high-up faded ads), position-hashed.
- Slight random rotation, overlap, and torn/partial variants; layered paste-up reads as *history*, which
  is most of the effect.
- Z-offset a hair off the wall; `singleSided: true` (see the sign-plate lesson in `signtext.ts` — a
  double-sided plate z-fights its own mirrored back face).
- Density driven by district: dense in market/downtown, sparse in residential.

**Recommendation: build decals before GARP.** Cheaper, fewer constraints, larger visual return.

---

## 4 · Prop backlog, prioritised

### Tier 1 — props that are currently one box

| prop | target | notes |
|---|---|---|
| **vending machine** | ~150 tris, 5 sub-layers | The flagship. Recessed product window, fascia lip, coin mech, interior products behind glass, spill light. Sub-layers: `body` (painted metal) · `fascia` (GARP slot) · `window` (glass) · `products` (GARP slot, matte) · `glow` (emissive). This prop alone settles the multi-slot material question concretely. |
| post box | ~60 | slot, dome top, plinth |
| utility cabinet | ~50 | door seam, hinges, louvred vents, decal surface |
| shop / blade signs | ~40 | bracket arm, real depth, edge return |
| bench | ~90 | slats with gaps (currently a solid slab) |
| **lamp post** | ~110 | base casting, fluted column, arm, luminaire housing — **plus double banner arms**, see below |
| bicycle | ~120 | frame diamond + spoked wheels; currently reads as blobs |

**Lamp-post banners** (user request): twin banners on cross-arms are an ideal early GARP consumer *and* a
free win on the existing wind system, since they are cloth — reuse the `wind` layer field the awnings and
foliage already use. Banner artwork is a natural pool (`street-banners`), and the two banners on one post
should draw from the **same skin** so a pole reads as one campaign.

### Tier 2 — props that do not exist at all

bike racks · bollards · trash bins · fire hydrants · phone boxes · newspaper boxes · A-boards ·
ashtray stands · drain grates · stacked crates · ground-level AC condensers.

Bike racks are worth pairing with the bicycle upgrade — the city has parked bicycles but nothing to park
them against.

### Tier 3 — atmosphere

- **Cable clutter.** Arterial power lines exist; the look wants messy service drops to buildings, junction
  boxes and cable bundles.
- **Vertical signage stacks.** Tall multi-tenant sign columns; we only have single signs.
- **Ground detail.** Manhole variety, drain channels, kerb paint wear, puddles reflecting neon (the water
  material already exists and is nearly free — 644 triangles for the whole fountain).

---

## 5 · Phasing

| Phase | Content | Depends on |
|---|---|---|
| **1** | **Vending machine generator** — the full sub-layer split, correct UVs, no textures yet (solid-colour slots). Proves the generator shape and the material split. | — |
| **2** | **Decals** — `placeDecals`, wall-band scatter, district density, a starter poster set. | — |
| **3** | **GARP core** — pool registry + skin selection + `texture?:` on `LayoutPreviewLayer` + `makeMesh` branch + registration validation. Wire to the vending machine's fascia/products slots. | 1 |
| **4** | **Per-instance texture on `arrayGroup`** — leave float 44 per-instance, extend `InstanceOverride`. Unlocks GARP on the instanced path (trees, building detail, and any prop that moves to instancing). | 3 |
| **5** | **Tier 1 prop sweep** — post box, cabinet, signs, bench, lamp post + banners, bicycle. | 1, 3 |
| **6** | **Tier 2 + Tier 3** — the missing props and atmosphere passes. | 5 |

Phases 1 and 2 are independent and can run in either order or in parallel.

---

## 6 · Cross-cutting requirements

- **Determinism.** Every placement and skin choice is position-hashed off the city seed, never a running
  RNG — selective region regeneration must stay idempotent.
- **One material family per sub-layer** (§1). Guarded by `city-materials.test.ts`; keep it green.
- **UVs.** Any textured prop must emit real 0..1 UVs. `blob`/`beam`/`disc`/`hood` emit none and `obox`
  emits world-unit UVs — fix at the generator, not in the shader.
- **Instancing.** Essentially no street furniture is instanced today; everything is CPU-merged per colour.
  New generators should emit instanceable geometry (canonical local-space + transforms) from the start so
  Phase 4 and [instancing-blocks.md](instancing-blocks.md) can pick them up without a rewrite.
- **Shadows.** Instanced draws must opt in via `castsInstancedShadow`, or the prop silently casts nothing.
- **Budget.** State a triangle budget in each generator's header and assert it in that generator's test,
  the way `conifer.test.ts` does.
- **Verification.** `npx tsc --noEmit` → `npx vitest run` → `npm run build` → restart `ng serve`.
  Note that **vitest does not typecheck** — a type error in a test only surfaces in the build.

---

## 7 · Appendix: canal / bridge geometry (fixed 2026-07-27)

Recorded here because it is the same class of error this spec is trying to prevent — a number derived two
different ways in two places.

A canal is one grid cell wide, but nothing that matters is one cell wide. `cellLevelAt` takes the minimum
across a street band (`streetBandHalf`) so a terrace step can never rise mid-carriageway; at a canal edge
that band resolves to the canal's own level. The excavated trench — the hole cut in the road base *and*
the embankment wall — therefore runs `streetBandHalf` **outside** the cell on every side, while the water
quad and the bridge deck were still built at raw cell width:

| quantity | value (world units) | ≈ metres |
|---|---:|---:|
| canal cell width | 1.818 | 27.3 |
| trench (road hole, wall to wall) | **2.566** | 38.5 |
| gap per bank | **0.374** | 5.6 |

That is 20.6% of the span missing at *each* end — visible as a strip you could see straight through, with
every bridge landing its abutments over open water.

**Fixed** by pushing each canal cell edge that faces land out to the same trench line (edges facing another
canal cell stay put, or the quads z-fight at a shared Y), and by extending the bridge span — not its width
— by the same band. Bridges additionally now **walk** across consecutive canal cells (so a two-cell reach
is spanned in one deck) and **skip** any crossing whose approach is itself inside the trench: at an
L-bend, the road on the far side runs along the other arm's bank, is cut away by the road hole, and a deck
built to it would arrive at no road at all.

Pinned by `src/world/canal-bridge.test.ts`, which asserts the *relationships* (water covers everywhere the
level system calls water; every deck reaches dry land at both ends; the span is always the long axis)
rather than the constants, so it survives changes to `streetBandHalf`, grid resolution or street widths.

**Latent, not yet fixed:** `addArchBridge` picks its span direction with `Math.max` on the quad's two edge
lengths, so a deck whose carriageway were wider than its span would arch *along* the road instead of
across the canal. Widening the span made this far less likely; the third test in `canal-bridge.test.ts`
asserts it stays impossible rather than merely unlikely.
