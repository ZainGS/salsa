# Block Creator — Frogmarks UI Integration

Host-facing contract for **Neighborhood Blocks** — many procedural buildings authored, saved, and moved as ONE unit,
with their repeated detail (juliet balconies / window trim) collapsed to a handful of GPU-instanced draws across the
whole block. A Block is the standalone extraction of the city's Region→District→**Block**→Lot level. Salsa owns the
generator + scene lifecycle + persistence; Frogmarks owns the panels/buttons (same split as
[building-creator.md](building-creator.md)). Spec: [../specs/instancing-blocks.md](../specs/instancing-blocks.md).

## Why a Block (not just N buildings)
Placing 20 detailed buildings individually spawns thousands of little balcony/trim meshes. A Block **collects** all
its buildings' repeated detail and draws each unique geometry ONCE (instanced) — e.g. a 24-building block's ~2,300
balconies render from ~8 geometries in ~16 nodes instead of ~2,300 meshes (**~10× fewer scene nodes**). It's also an
authoring convenience: arrange a row/courtyard once, then move/scale/save the whole thing as a unit.

## The flow (what the host builds)
1. **Add Block** → `createBlock3D()` → an empty block container appears (one outliner item). Keep the returned `id`.
2. **Add buildings into it** → `addBuildingToBlock3D(id, params, { x, z, ry })` — `params` is a normal
   `BuildingParams` partial (same as the Building Creator); `{x, z, ry}` is the building's **block-local placement in
   metres** (+ yaw radians). Returns the building's index within the block.
3. **Arrange / edit** — `setBlockBuildingPlacement3D(id, index, {x,z,ry})` to move one building;
   `setBlockBuildingParams3D(id, index, {...})` to restyle one; `removeBlockBuilding3D(id, index)` to drop one. The
   block regenerates in place.
4. **Move / scale the whole block** — `setBlockTransform3D(id, {x,y,z,ry})` / `setBlockScale3D(id, unitsPerMetre)`,
   or just drag the block's gizmo (persists automatically — it's a thin-wrapper container like a building).

## API surface (on `ShapeManager`)
| Method | Purpose |
|---|---|
| `createBlock3D(transform?, opts?) → id` | New block. `transform` = `{x?,y?,z?,ry?}` world placement. **Seeded with a starter row of 3 buildings by default** (so it renders immediately); pass `{ starter: false }` for empty, `{ starter: N }` for N. Auto-frames when non-empty. |
| `isBlock3D(id) → bool` | **Gate the "Edit Block" affordance on this** (mirrors `isProceduralBuilding3D`). True for block containers. |
| `addBuildingToBlock3D(id, params, placement?) → index` | Add a building at block-local `{x?,y?,z?,ry?}` metres. |
| `setBlockBuildingPlacement3D(id, index, {x?,y?,z?,ry?}) → bool` | Move/rotate one building in the block. |
| `setBlockBuildingParams3D(id, index, params) → bool` | Restyle one building — takes the **full `BuildingParams`** (floors/colours/windows/features/…), same as a standalone building. |
| `getBlockBuildingParams3D(id, index) → BuildingParams \| null` | Read one building's params (to **seed the edit panel**). |
| `getBlockBuildings3D(id) → { index, archetype, category, placement }[]` | List the block's buildings (for the per-building list/editor). |
| `removeBlockBuilding3D(id, index) → bool` | Drop one building. |
| `setBlockTransform3D(id, {x?,y?,z?,ry?}) → bool` · `setBlockScale3D(id, unitsPerMetre) → bool` | Move / scale the whole block. |
| `removeBlock3D(id) → bool` | Delete the block + everything in it. |
| `listBlocks3D() → { id, name, buildings }[]` | Host outliner / picker. |
| `getBlockStats3D(id) → { buildings, distinctInstancedGeometries, totalInstances }` | Diagnostics (proves the instancing win). |
| `restoreBlocksFromSave3D() → number` | Regenerate blocks from a loaded save. Covered by `restoreProceduralFromSave3D()`. |

`BuildingParams` and its colour/coercion rules are exactly as in [building-creator.md](building-creator.md) — a Block
building is a normal building; the Block just owns placement + the shared instancing.

### Editing a building's LOOK (full params, not just archetype)
A building inside a block is fully editable — **reuse the Building Creator's params panel.** The intended host flow:
select a building in the block (from `getBlockBuildings3D(id)`) → open the same panel seeded from
`getBlockBuildingParams3D(id, index)` → every slider/toggle change calls `setBlockBuildingParams3D(id, index, {...changed})`
(exactly like `setBuildingParams3D` does for a standalone building) → the block regenerates in place. So the Block panel
is really: a **buildings list** + placement, and selecting one opens the **normal Building Editor**. (Block buildings
default `julietBalconies` + `windowTrim` ON so they render with detail — the panel can toggle those off per building.)

## Persistence
Params-only, automatic — the Block serializes as a lightweight marker (`worldParams.kind === 'block'`) holding each
building's `{params, placement}` + the block transform/scale, **not** baked geometry. On load it restores as an empty
container that must be **regenerated** — covered by the one call every host must make on doc load:

> ⚠️ **On doc load:** `restoreProceduralFromSave3D()` now returns `{ city, buildings, blocks, foliage }` and
> regenerates blocks too. (Same call that restores the City + standalone buildings + foliage.)

## Scale
A Block has ONE display scale (world units per metre, default 1:10) applied to the whole block; buildings inside sit
in block-local **metres**, so their relative sizes are consistent and the block moves/scales as a unit.

## Dev/testing without the UI
```js
const b = salsaBlock.create()
salsaBlock.add(b, { archetype:'brick-townhouse', julietBalconies:true, windowTrim:true }, { x:0,  z:0 })
salsaBlock.add(b, { archetype:'brick-townhouse', julietBalconies:true, windowTrim:true }, { x:16, z:0 })
salsaBlock.stats(b)     // { buildings, distinctInstancedGeometries, totalInstances }
salsaBlock.move(b, { x: 20 }) · salsaBlock.remove(b) · salsaBlock.list() · salsaBlock.restore()
```

## Not yet (later work)
Block **editor mode** (a ground grid to click-place/drag buildings, like the Building Creator's foliage tool); a
building **palette** (preset pool to stamp from); and **city integration** — the City Creator using Blocks/detailed
buildings per city-block (with the current basic city buildings as a fallback). See the spec.
