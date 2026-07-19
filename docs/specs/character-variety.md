# Character Variety — Wardrobe, Materials, Collections & Randomizer

**Status:** 📋 Spec / not started — consolidates scattered "more clothes / more hair" notes into one prioritized buildout.
**Created:** 2026-06-26
**Related:** [fashion-creator.md](./fashion-creator.md) (the slot/paint UX umbrella) · [clothing-generation.md](./clothing-generation.md) (the top/bottom generator) · [hair-generation.md](./hair-generation.md) · [dollz-creator.md](./dollz-creator.md) (collection #1 = dollcore) · [character-creation-pipeline.md](./character-creation-pipeline.md) (the shrinkwrap/drape path) · [kitbash-armature-grease-pencil.md](./kitbash-armature-grease-pencil.md) (attach slots) · [character-system-backlog.md](./character-system-backlog.md) (correctness / live-edit / fit work).
**Effort tags:** **S** ≈ <½ day · **M** ≈ 1–2 days · **L** ≈ multi-day. Engine-only unless **[Frogmarks]**. Rule still holds: no `npm run build` — only `npx tsc --noEmit`; the user rebuilds.

---

## 0. Why this exists

The character-randomizer screenshot proved the thesis: **silhouette variety reads as different *people* before any detail does.** The payoff of going procedural is combinatorial — *N* hair × *M* tops × *K* bottoms × shoes × accessories × materials = a believable crowd out of a handful of generators. We won't need hundreds of hand-built NPCs; we need ~15 hair, ~20 tops, ~20 bottoms, ~10 shoes, ~15 accessories, and a materials layer, and the space explodes.

This spec turns the scattered backlog notes into:
1. a **prioritized silhouette catalog** (tagged by *how* each item is built — the real cost driver),
2. three **force-multipliers** that make variety feel *intentional* instead of arbitrary: **materials/patterns**, a **seeded randomizer**, and **fashion collections**,
3. the **garment ↔ footwear interaction** model (the baggy-jean stack), and
4. the **crowd/NPC hook** for the city generator.

**Guiding principle:** breadth of silhouette **>** fidelity of any single mesh. Retro/chunky is on-brand; *consistency* matters more than realism (per [character-creation-pipeline.md](./character-creation-pipeline.md)).

---

## 1. The variety budget

Target counts to hit "believable crowd" (current = what the generators ship today):

| Slot | Current | Target | Gap driver |
|---|---|---|---|
| Hair | 5 presets (twin/pony/pig/bob/long) | ~15 | buns/braid/afro/curls/wolf/hime/pixie/spiky |
| Tops | ~3 (tee/crop/tank + sleeve params) | ~20 | outerwear (hoodie/cardigan/blazer/bomber/kimono/trench/puffer), sweater |
| Bottoms | ~2 (pants/skirt) | ~20 | shorts/joggers/leggings/wide-leg/cargo/pleated/overalls/**baggy-stacked** |
| Footwear | 0 procedural (boots = authored kit only) | ~10 | a whole new `shoe-generator` |
| Accessories | attach *slots* exist, few parts | ~15 | glasses/headphones/bags/hats/scarf/jewelry |
| Materials | UV-paint + PBR (no library) | a fabric+pattern library | the cheap multiplier |

---

## 2. Silhouette catalog (the buildout)

Organized by **construction class** (the cost), not by fashion category:

- **Class P — parameter variation** of an existing generator. New ranges/presets only. **S each.**
- **Class G — new generator template** (new base topology: a hood, an open front, a sole). **M each.**
- **Class W — shrinkwrap/drape** garment (loose, leaves the body surface) via the [character-creation-pipeline](./character-creation-pipeline.md) inflate→shrinkwrap→weight-copy path. **M each, but they all share one pipeline.**

> The whole point of the split: ChatGPT's "just add a generator" is only true for **Class P**. The big-silhouette items (hoodie/blazer/kimono/trench/puffer) are **G or W** and need real geometry work — budget accordingly.

### Tops & outerwear — extend [clothing-generator.ts](../../src/services/managers/clothing-generator.ts)
| Garment | Class | Notes |
|---|---|---|
| Sweater / longsleeve | **P** | thicker base tee + full sleeve; ribbed cuff trim (hem system exists) |
| Tank / crop / tee | ✅ P | shipped |
| Hoodie (oversized) | **G** | needs a **hood** (ring set behind the neck) + a kangaroo-pocket detail; oversized = looser fit + lower hem |
| Cardigan / blazer / bomber | **G** | the **open front** template: a center seam split + lapel/collar + (blazer) structured shoulder. One template, three presets. |
| Sweater-vest | P | sweater minus sleeves |
| Kimono / trench / poncho | **W** | draped panels that leave the body — shrinkwrap path; belt cinch for the trench |
| Puffer | **G** | quilted shell — segmented rings with an outward bulge per baffle + a quilt-line pattern (ties to §3) |

### Bottoms — extend `buildLegs` / `buildSkirt`
| Garment | Class | Notes |
|---|---|---|
| Pants / skirt | ✅ P | shipped |
| Shorts | **P** | leg length short |
| Joggers | **P** | mild taper + gathered ankle cuff (a light version of §6) |
| Leggings | **P** | skin-tight fit (small looseness) |
| Wide-leg / flare | **P** | radius profile widens toward the hem |
| Cargo | **P+** | wide-leg + rigid pocket detail meshes |
| Pleated skirt | **P** | radial pleat modulation on the skirt rings |
| Overalls | **G** | bib panel + straps over the shoulders (crosses into the top slot) |
| **Baggy / stacked jeans** | **P+** | wide-leg + the **gather/stack** system — see **§6** |

### Footwear — **new** `shoe-generator.ts` (new slot)
A genuine gap: there's no procedural shoe today. Build a small generator: **last** (foot shell) + **upper** + **sole**. One Class-G family, then P variations:
`sneaker · boots · loafers · sandals · heels · chunky/platform`. Couples to the pants stack (§6) and to the body's foot joint. **[L for the family, then S per variant.]**

### Hair — extend [hair-generator.ts](../../src/services/managers/hair-generator.ts) (cap/bangs/locks/tails)
| Style | Class | Notes |
|---|---|---|
| twin / pony / pig / bob / long | ✅ P | shipped presets |
| bun / messy bun | **P** | the `buns` tailStyle stub (Phase 2 in hair spec) |
| braid | **G** | a plaited tube (over-under strand weave) along a tail path |
| afro / curls | **G** | afro = noisy displaced shell on the cap; curls = helix strips (reuse parallel-transport from tails) |
| wolf cut / shag / layered | **P+** | layered back-length + face-framing locks |
| hime | **P** | blunt sidelocks + straight bang (Phase 2 in hair spec) |
| pixie / short male | **P** | short cap, minimal back |
| spiky | **G** | tapered cone clumps off the cap |

### Accessories — small rigid parts on existing attach joints
The [kitbash spec](./kitbash-armature-grease-pencil.md) already defines attach slots (`accessory_head` / `accessory_back` / `accessory_left/right` / `face_overlay`). Most accessories are tiny meshes parented there — almost free per item:
`glasses · sunglasses · headphones · earrings · necklace · belt · watch / wristband · hat / beret / baseball cap · scarf (W) · backpack / messenger bag (back) · frog backpack 😊`.

---

## 3. Materials & patterns — the cheap multiplier

**Highest variety-per-effort in the whole spec.** One shirt × ten fabrics = ten shirts, for ~no geometry. Reuses the PBR/IBL system + UV-paint that already exist. Two orthogonal layers:

- **Material (surface):** `denim · linen · cotton · wool · leather · satin · corduroy` → PBR `roughness`/`metalness`/sheen presets + an optional subtle **procedural weave** normal/texture. (Satin = low roughness sheen; denim = mid roughness + twill normal; leather = low roughness + grain.)
- **Pattern (print):** `solid · striped · plaid · gingham/check · polka · floral · camo · houndstooth` → a **tileable procedural texture** generated into the garment's diffuse (deterministic from a seed), **or** hand-drawn via the existing UV-paint pane for one-offs/logos.

```ts
sm.setGarmentMaterial3D(meshId, {
  material: 'denim',
  pattern: { kind: 'plaid', colors: ['#2b3a55', '#c44', '#eee'], scale: 0.4, seed: 1234 },
});
```

Patterns are **seeded** → reproducible (a collection's plaid is the same plaid every roll). This layer is also where **collections get their identity** (denim + bold pattern = streetwear; wool + solid muted = office).

---

## 4. The randomizer — seeded, weighted, deterministic

Formalize the ad-hoc Frogmarks tester into a first-class, **reproducible** feature.

```ts
interface RandomizeOpts {
  seed?: number;                 // omitted → fresh random; same seed → identical character
  collection?: CollectionId;     // bias the rolls (§5); omitted → 'all'
  accessoryCount?: [number, number];   // range, default [0, 2]
  bodyRanges?: Partial<BodyParams>;    // proportion variance
  lockSlots?: Partial<Record<Slot, string>>;   // keep some slots fixed while re-rolling others
}
sm.randomizeCharacter3D(opts?): CharacterDefinition;   // builds/replaces the character
sm.getCharacterSeed3D(): number;                       // current seed (for sharing)
```

- **Deterministic:** same `seed` → byte-identical character. Uses the existing `hashRand(seed, slotIndex, channel)` precedent from the [array-tool](./array-tool.md) — *not* `Math.random()`. So a character is a single shareable number.
- **Weighted per-slot pick** from the allowed set, honoring the collection's weights + combination rules (§5).
- **Lockable slots** so "re-roll just the hair" works (great for the creator + the tester).
- **[Frogmarks]:** a 🎲 button (re-roll → new seed) + a seed text field (paste to reproduce) — mirrors the ephemera 🎲/seed pattern ([ephemera-system.md](./ephemera-system.md)).

---

## 5. Fashion collections — the strategic payoff

A **collection** converts "random clutter" into "intentional outfit." It's the single most valuable idea here and it's *cheap*: data tables over the existing generators.

```ts
interface Collection {
  id: CollectionId;
  name: string;                                   // 'Tokyo Casual'
  slots: Record<Slot, WeightedSet<string>>;       // which parts, how likely, per slot
  palette: ColorPalette;                          // allowed colors / harmonies
  materials: WeightedSet<MaterialPattern>;        // §3 fabrics this collection favors
  paramRanges: Partial<Record<Slot, ParamRange>>; // e.g. tops trend oversized
  rules: CombinationRule[];                        // hard constraints (see below)
  accessoryBudget: [number, number];
}
```

**Starter set** (each reuses the same generators with different ranges/allowed sets):
`Tokyo Casual · Streetwear · Office · School · Sportswear · Traditional · Cyberpunk · Fantasy`. **Dollcore ([dollz-creator.md](./dollz-creator.md)) becomes collection #1** — it's already exactly this shape (curated kit + auto-styled pick).

**Combination rules** are what sell it:
- *Office* → no crop tops, closed shoes only, muted palette, ≤1 accessory, structured outerwear (blazer).
- *Streetwear* → oversized top + sneakers + 2 accessories + bold pattern + baggy/stacked jeans.
- *School* → uniform top + pleated skirt/slacks + loafers + minimal accessories.

This is the difference between "a pile of random clothes" and "an outfit a person would actually wear," and it's the bridge to §7.

---

## 6. Garment ↔ footwear interaction — the baggy-jean stack ⭐

> **Status: 🔄 §6a BUILT (2026-06-28).** `BottomParams.stack` (0..~1) drives lower-cuff **accordion folds**
> (alternating wider/narrower rings) + flare (pooling) + per-ring jitter + a **front-break droop** (front sectors
> lower than back) in `buildLegs` (pants only); the de-collision pins any too-tight fold back onto the leg. Pools
> at the ankle. **§6b SHOE-FLOOR coupling BUILT (2026-06-28):** with a shoe equipped, the pant cuff RESTS on the
> shoe's top (`restY` from the foot bbox), the surplus **piles** there (Y clamped to never descend below the shoe
> → no clipping), draping over it; `setClothingParams('bottom')` reads the equipped shoe rig as its floor, and
> `setClothingParams('shoes')` re-piles the bottom. No shoe → pools to the ankle. Preset: **Baggy Jeans**.
> **TODO:** tune the pile/drape from a screenshot; cuff FLARE wider to wrap the shoe sides; chunkier shoe.

The worked example, and a reusable mechanic. Three parts:

### 6a. Stacking / pooling (length-driven accordion)
Drive it off the **pant length past the ankle threshold** (the user's insight). Extra length can't descend straight (ground/foot is there), so it **bunches**:
- Each unit of length beyond the ankle spawns one or more **fold rings** packed into a short Y span at the cuff.
- Each fold ring's **radius is accordion-modulated** (out → in → out) and **compressed in Y**, with small **per-ring jitter** (seeded) so it reads as organic bunched denim, not a bellows.
- **Front "break" bias:** the drape is *longer in front, shorter in back* (per-azimuth modulation) — that's the real-world stack catching on the shoe tongue.

### 6b. Shoe-rest (no clip)
The shoe gives the stack a **floor** so fabric arcs over the instep instead of clipping through:
- Read the equipped shoe's **top profile** — ankle-opening height + instep width — from its bbox / a simple collision proxy.
- The lowest folds rest **on** that profile; the cuff radius flares to wrap the shoe's width; the front folds drape further down the instep.
- **No shoe equipped** → pool to the ankle bone instead.
- **v1 = a proxy** (`shoeProfile { topHeight, instepWidth, heelHeight }`), *not* true per-triangle mesh collision — cheap, robust, good enough for the chunky style.

### 6c. Implementation sketch
```ts
// in buildLegs (clothing-generator.ts)
interface LegStack { extraLength: number; foldFreq: number; jitter: number; frontBias: number; }
// when hemY would fall below ankleY, redirect the surplus into fold rings:
//   foldCount = ceil(extraLength / foldPitch)
//   for each fold i: y = lerp(cuffY, restY, ...) with accordion radius + jitter
//   restY / restRadius come from shoeProfile (or ankle if none)
```
- New param on the pants generator: `stack` (or simply derived when `length > ankleThreshold`), plus an optional `shoeProfile` input (from the equipped shoe).
- **Ties to backlog #12** (per-garment layer offset) so the stack sits *over* the boot without z-fighting, and to **#9** (directional leg fit).
- **Generalizes:** any cuff meeting a surface — sock-over-shoe, sleeve-over-glove, sleeve push-up — reuses the gather mechanic.

---

## 7. Crowd / NPC hook

The reason all of the above matters for the Shibuya/city goal:

```ts
const npc = sm.randomizeCharacter3D({
  collection: districtStyle(tileX, tileY),   // Harajuku → Streetwear, business → Office
  seed: cityHash(tileX, tileY, citizenIdx),  // deterministic → the city is reproducible
  accessoryCount: [1, 3],
});
```
- A 500-citizen district becomes believable from one generator set + per-district **collection mapping** — zero handcrafted NPCs.
- **Perf:** gate per-frame skeleton sync to visible/dirty characters (backlog **#14**); distant NPCs **bake to a static part** (`bakeClothingToPart3D` / `bakeHairToPart3D`) as a LOD; share materials.

---

## 8. Recommended build order

1. **Materials & patterns (§3)** — biggest multiplier, reuses PBR + UV-paint. **M.**
2. **Class-P silhouette batch** — joggers/leggings/wide-leg/shorts/sweater + hair buns/pixie/wolf. Fast, broad variety. **S each.**
3. **Randomizer + collections (§4–5)** — formalize the tester; ship Dollcore + Streetwear + Office first. **M.**
4. **Footwear generator (§2) + baggy-jean stack (§6)** — the coupled pair (the stack needs the shoe profile). **M–L.**
5. **Class-G/W big silhouettes** — hoodie/blazer/kimono/trench/puffer + braid/afro hair. **L, ongoing.**
6. **Accessory batch** — glasses/headphones/bags/hats. **S each.**
7. **Crowd hook (§7)** — depends on 1–5. **L.**

---

## 9. Open questions

- **Shoe collision:** bbox proxy (v1) vs true mesh collision for the stack? Proxy is almost certainly enough for the style.
- **Pattern delivery:** generated-texture vs pure shader-param vs UV-paint composite? (Likely generated tileable texture for stock patterns, UV-paint for custom.)
- **Collection authoring:** hardcoded tables vs a data file users can edit/share (collections-as-content, like ephemera sheets)?
- **Constrain vs weight:** how hard should a collection's rules be — strict filters, or just heavy weights that still allow surprises?
- **Overalls/bib** crosses the top↔bottom slot boundary — one part spanning two slots, or a linked pair?
