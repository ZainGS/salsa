# Procedural Foliage Generator

> **Deliverable of this pass:** this SPEC. Built after in 4 ordered items (below). A sibling sub-object generator to the
> [[building-generator]] / character / hair systems: a pure `buildFoliage(spec) → { layers, meta }` reused in TWO
> contexts. Ends the "buildings sit on bare ground" problem and delivers the **lush-nature-bleeding-into-architecture**
> that is the single most NTE-defining thing the city still lacks ([[city-visual-upgrade]] Phase 5 lives here).

## Context — why + reuse
Reference (Neverness-to-Everness): hedges + bushes hugging building bases, ivy climbing walls, flower baskets under
windows, planters flanking doors, street trees, rooftop gardens. Today the city has only scattered `biome.ts` trees/rocks
and no building-relative greenery at all. A dedicated generator makes foliage a **fresh parameterized instance** (variety
+ detail by default), and it reuses machinery we already have: `biome.ts` `addTree`/`addRock`, the hair system's **alpha
CARD** leaf technique (cheap soft-edged foliage), the pattern shader (leaf speckle), and the building's `meta` anchors
(window positions, wall faces, footprint edges) for placement.

## THE key architecture — two kinds of foliage, one generator
The standalone-vs-building-mode question resolves cleanly once you see there are **two kinds** with different owners:

- **Building-ATTACHED foliage** — vines/ivy up walls · window boxes under windows · hedges hugging the base · planters
  flanking the door. These are part of the building's *identity*: they need the building's geometry to place, and they
  **must travel with the building when the city places it** (you can't hand-vine hundreds of procedural buildings). So
  attached foliage is stored **in the building's params** (`foliage: FoliagePlacement[]`), regenerated + transformed +
  persisted *with* the building.
- **FREESTANDING foliage** — a bush on the sidewalk, a hedgerow, a potted plant, a street tree. Independent scene
  objects tied to nothing, placed anywhere. These get their **own thin-wrapper containers** (like buildings), via a
  Foliage Creator.

**⇒ One shared `buildFoliage` generator, consumed in BOTH.** Not "standalone only" (that throws away the window-boxes/
vines that make it read NTE and breaks city integration); not "building-mode only" (that loses freestanding landscaping).
The generator is the reusable core; the two UIs are thin consumers — exactly the building pattern (pure generator +
manager + API).

## The foliage CONTRACT
`buildFoliage(spec) → { layers: LayoutPreviewLayer[], meta: FoliageMeta }`, authored in real metres like the building
generator (so the same metres→units display scale applies, and the city can size it to a lot).
```
FoliageSpec {
  type: FoliageType            // bush | hedge | shrub | grass-tuft | flower-bed | planter | potted | small-tree
                               // | vine | ivy | window-box | hanging-basket | climber
  seed: number
  size: number                 // overall scale (m)  ·  width/length/height where relevant
  density: number              // leaf/branch fullness
  render: 'card' | 'chunky'    // alpha-card clumps (ER/anime lean) vs low-poly blobs (matches building/hair modes)
  // colour + material
  foliageColor / tipColor      // leaf gradient (root→tip)
  bloom: boolean; bloomColor   // flowers/berries speck
  potColor / potMaterial       // planter/box vessel
  // context (attached foliage only — the building supplies these)
  anchor?: { kind: 'wall' | 'window' | 'base-edge' | 'ground'; pos; normal; span }
}
FoliageMeta { footprint: V2[]; height; kind }   // footprint → the placement overlap test
```

## Foliage type library (the "what")
- **Ground:** bush · shrub · **hedge** (extruded run along an edge) · grass-tuft · **flower-bed** (low mound + bloom
  speck) · **planter** (vessel + plant) · **potted plant** · **small tree** (reuse `biome.addTree`).
- **Wall:** **vine / ivy** (leaf cards scattered up a wall face, following it) · **climber** (trellis + leaves).
- **Window:** **window box / hanging basket** (vessel under/beside a window + spilling leaves + bloom).
Each is a preset composition of the same primitives (a **clump** = scattered leaf cards or blobs on a branch/mound) +
optional **vessel** (pot/box) + optional **bloom** speck — the same "primitives + modifiers + presets" model as hair.

## Placement — attached foliage + the grid tool
The building supplies context; foliage consumes it (mirrors the building's frontage/party-wall model):
- **base hedges/bushes** → along `meta.footprint` street edges, inset to the sidewalk.
- **window boxes/baskets** → at `meta` window anchors (needs the building to expose window centres — a small addition to
  BuildingMeta: `windowAnchors: {pos,out}[]`).
- **vines/ivy** → scattered over chosen wall faces, conforming to the face plane.
- **planters** → flanking `meta.door`.
**Manual placement (the grid tool, item 4):** in Building Editor mode a **flat ground grid** (reuse `sceneGrid`) shows
valid cells around the base; the user drops foliage blocks; a placement is rejected if its `meta.footprint` **overlaps**
the building footprint or an existing foliage footprint (a simple 2D AABB/poly test). Game-like, satisfying, prevents
clipping. Each placed block is a `FoliagePlacement { spec, x, z, rot }` appended to the building's `foliage[]`.

## Building Editor mode (the container for building-authoring tools)
A dedicated mode like Character Creator's edit modes: **isolate + frame + alt-orbit** the selected building, show a tool
palette. First tool = **Foliage**; later = paint / materials / door authoring. Parallels
`enterArmatureMode3D`/`enterMeshEditMode3D`; new `enterBuildingEditMode3D(id)` / `exitBuildingEditMode3D()`. The foliage
tool renders the placement grid + previews; commits write to the building's `foliage[]` (regenerated with the building →
params-only persistence, travels into the city).

## Feature roadmap — the 4 items, in order
1. **`buildFoliage` generator** — the pure engine + the type library (bush/hedge/shrub/grass/flower-bed/planter/potted/
   small-tree + vine/ivy + window-box/basket) in `card` + `chunky`, colour/material params, `meta.footprint`. Reuse
   biome + hair-cards. Standalone-testable (a `salsaFoliage.*` console harness + a smoke test), no UI yet.
2. **Parametric building-attached foliage** — a **greenery pass** in the building generator: params `baseHedge` /
   `vines` / `windowBoxes` / `planters` (+ amount/colour), **auto-placed** from building `meta` (footprint edges, wall
   faces, window anchors, door). Instant NTE lift on every building, travels into the city for free. Add
   `windowAnchors` to BuildingMeta. (Biggest visual payoff for least UX work — do it right after the generator.)
3. **Standalone Foliage Creator** — freestanding foliage objects: a `FoliageManager` (own thin-wrapper container per
   object, params-only marker `worldParams.kind:'foliage'`, create/setParams/move/scale/persist) + ShapeManager `*3D`
   API + `docs/ui/foliage-creator.md` host contract. Mirrors BuildingManager exactly.
4. **Building Editor mode + manual foliage grid tool** — `enterBuildingEditMode3D`, the ground placement grid, drop/
   overlap-reject, per-placement edit, commit to `building.foliage[]`. The richest UX; last because it's the heaviest.

## Cross-cutting
- **Reuse first** — biome tree/rock, hair alpha-cards, `sceneGrid`, the flat-colour-group pipeline, params-only persist.
- **Determinism** — seeded per placement; same seed → same plant.
- **Materials/colour** — leaves get a colour gradient + optional bloom speck; vessels get colour + material (terracotta/
  ceramic/metal/wood). (Ties into the parallel building request to give storefront/awning/**doors** their own colours +
  materials — same "every sub-part is independently colourable/material'd" principle.)
- **Performance** — foliage can explode card counts; cap per plant + LOD (far = a couple of billboards, near = full
  clumps), same LOD-by-view principle as buildings. Crowd-scale foliage in the city rides the tiled LOD.
- **Wind/sway (later)** — a vertex-anim sway (like the spec's Phase-5 nature) once the geometry lands; hook, not v1.
- **Frogmarks** — the Foliage Creator panel (type picker + sliders) + the Building Editor mode's foliage tool.

## Recommended build order
**1 → 2 → 3 → 4** (as listed). Item 2 (parametric attached foliage) is the fast, high-payoff win right after the
generator; item 4 (editor mode + grid) is the biggest build, last.

## Open questions
- Attached foliage: params-only auto (item 2) vs manual-placement list (item 4) — do BOTH (auto as the default, manual to override/augment); store both in `building.foliage[]`.
- Leaf rendering: alpha-cards (crisp, needs the alpha-cutout material) vs chunky blobs (cheaper, matches low-poly) — support both like hair; default `card` for hero, `chunky` for crowd LOD.
- Does freestanding foliage snap to a ground grid too, or free-place? (free-place standalone; grid only in Building Editor mode.)
