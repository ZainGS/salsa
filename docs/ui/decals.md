# Decals — Frogmarks UI Integration

Host-facing contract for the **Decal tool** (place a poster/sticker/logo on a 3D surface). **Salsa owns
geometry / texture / placement / persistence; Frogmarks owns the tool button + source subpanel.** Spec:
[../specs/decals.md](../specs/decals.md).

> **Mode A (floating quad) is what's built.** A decal is a flat textured quad laid on a surface, oriented to
> the face normal, alpha-cut. It's its own selectable/movable outliner node and persists automatically.
> Baked-into-texture decals (curved surfaces) and a hover-ghost preview are later phases (spec §5, §4.3).

## The flow the host builds
1. **Decal tool** button → opens a **source subpanel**: the ephemera catalog (reuse the existing ephemera
   picker) **and** an image upload. The chosen source is a `DecalSource` (below).
2. Call **`sm.enterDecalPlaceMode3D(source, { size, metresPerUnit })`**. A **live ghost follows the cursor**
   over any surface, oriented to the face; **a single left-click places** a decal there. No separate select
   step. **Alt-drag still orbits.** `sm.exitDecalPlaceMode3D()` on deselect/Esc; `sm.setDecalToolSize3D(m, mpu)` /
   `sm.setDecalToolRotation3D(rad)` retune the ghost live; `sm.decalPlaceModeActive` gates the tool. The
   hovered mesh is outlined so you see what you're aiming at.
   - *(Perf note: the ghost raycasts only the last-hovered mesh cheaply, and re-acquires a new surface with a
     throttled full pick (~8×/sec) — so it stays smooth over the whole city.)*
   - *(Lower-level: `sm.placeDecalAtScreen3D(source, x, y, rect, opts)` raycasts + places in one call.)*

> **SIZE — pass metres via `metresPerUnit` (recommended).** All the place/tool calls accept an optional
> **`metresPerUnit`** in `opts`. When you pass it, **`size` is interpreted as METRES** and converted for you:
> a "Size (m)" slider of `2.8` with `metresPerUnit: 15` → a correct ~2.8 m decal. The city's metresPerUnit is
> `CITY_FLOOR_M / (0.2·radius/10)` (≈ 15 at the default radius). **Without** `metresPerUnit`, `size` is world
> units (default 0.2 ≈ a small city poster) — so a raw `2.8` becomes a 42 m decal covering the whole face,
> which is what "broken-looking huge decal" was.

> **Where decals CAN land.** Building **walls and roofs** are world-baked meshes → fully placeable. The
> **decorative trim** (balconies, window trim, greenery) is GPU-instanced and invisible to the raycast, so a
> click that lands only on a balcony (missing the wall behind it) won't stick. Aim at flat wall.

> **Front-facing is automatic.** The raycast returns the raw geometric triangle normal (winding-dependent,
> often pointing *into* the wall); the tool re-orients every hit toward the camera, so a decal always sits on
> the side you clicked from — never buried behind the surface.
3. The decal is then a normal selectable node — gizmo moves it, the outliner lists it, delete removes it.
   Re-select → the tool panel can offer **size** / **rotation** / **swap source** (below).

> **Placement lands on decoration too.** The city / props / buildings are `pickable=false` (so selection
> stays fast), but decal placement opts into them via an `includeNonPickable` raycast — so you *can* stick a
> poster on a city wall. Selection/hover elsewhere is unchanged.

The quad appears immediately (light-grey) and its image **resolves + applies asynchronously**, re-sizing to
the image's aspect ratio when it lands.

## `DecalSource` (both sources ship today)
```ts
type DecalSource =
  | { kind: 'ephemera'; typeId: string; params: Record<string, unknown> }   // an ephemera generator, rasterised
  | { kind: 'image';    dataUrl: string };                                    // an uploaded image
```
Ephemera type ids come from the existing catalog (`getEphemeraCategories3D()` → `getEphemeraGeneratorsByCategory3D(id)`).
The source is **stored on the decal** and re-rasterised on reload — documents stay small (params over pixels).

## API surface (on `ShapeManager`)
| Method | Purpose |
|---|---|
| `enterDecalPlaceMode3D(source, { size?, rotation? }) → boolean` | **The main call.** Start the tool: ghost-follows-cursor + click-to-place. |
| `exitDecalPlaceMode3D()` · `decalPlaceModeActive → boolean` | End the tool / query it. |
| `setDecalToolSize3D(m)` · `setDecalToolRotation3D(rad)` | Retune the ghost while the tool is active. |
| `placeDecalAtScreen3D(source, clientX, clientY, rect, { size?, rotation? }) → id \| null` | Lower-level: raycast a click → place, if you own the click loop. |
| `placeDecal3D(source, { hitPoint, faceNormal }, { size?, rotation? }) → id` | Place from an already-resolved hit (if you did your own pick). |
| `setDecalSize3D(id, size) → boolean` | Resize (world units; height follows the image aspect). |
| `setDecalRotation3D(id, radians) → boolean` | Spin the decal in its own plane. |
| `setDecalSource3D(id, source) → Promise<boolean>` | Swap the image (re-resolves the texture). |
| `isDecal3D(id) → boolean` | Gate the decal-edit panel on the selection. |
| `listDecals3D() → { id, source }[]` | Outliner / management. |
| `removeDecal3D(id) → boolean` | Delete. |

`size` defaults to 0.6 world units; the decal lifts a hair off the surface (no z-fighting) and orients its
"up" to point up-the-wall automatically (posters hang upright; the near-horizontal floor/ceiling case is
handled).

## Persistence
Automatic and params-only — a `worldParams.kind: 'decal'` marker storing `{ source, size, aspect, rotation,
place }`. **No extra host call** beyond the shared `restoreProceduralFromSave3D()` you already run on load (it
now regenerates decals alongside city/buildings/foliage/vending). The quad geometry + texture are
regenerated from the marker; gizmo moves persist.

## Mode B — baked decals (stamp INTO the surface texture) ✅ built (engine side)

Mode A is a floating quad. **Mode B bakes the decal into the target mesh's own texture** at the clicked UV, lit as
part of the surface — so it **curves/wraps** the mesh (a label around a vending machine, a sticker on a curved prop),
with no z-fight and no transparency ordering. It's the natural companion to **UV Paint**: while painting a mesh, the
host's "decal stamp" tool drops a decal into that mesh's texture.

| Method | Purpose |
|---|---|
| `stampDecalAtScreen3D(meshId, source, clientX, clientY, rect, { size?, rotation? }) → Promise<boolean>` | **The click call.** Raycast the click onto `meshId` → bake the decal into its texture at that surface point. Call this on click while your "decal stamp" tool is active in UV Paint. |
| `stampDecalAtUV3D(meshId, source, u, v, { size?, rotation? }) → Promise<boolean>` | Same, but from a UV coordinate directly — the **UV-pane** path (stamp while working in the 2D UV pane). |

- **`size`** = fraction of the texture width (default `0.25`); the image aspect is preserved. **`rotation`** in radians.
- The target mesh gets a **transparent decal layer** + `texOverBase`, so the base surface shows everywhere a decal
  isn't, and stamps composite over each other (and over any UV paint). Each stamp is **undoable** (a texture snapshot).
- The baked texture rides the same **UV-paint persistence** — it survives reload (procedural props via the stable key).
- ⚠ **Host wiring:** Salsa owns the blit; **Frogmarks owns the "decal stamp" tool button + a ghost preview** inside UV
  Paint (a tool toggle that routes clicks to `stampDecalAtScreen3D` instead of a brush stroke). Same `DecalSource` +
  ephemera/upload picker as Mode A.
- *(Dev harness: `salsaDecal.stampDemo(salsaDecal.ephemera()[0])` drops a grey box + bakes a decal on its front face;
  `salsaDecal.stampUV(meshId, typeId, u, v, size)` stamps onto an existing mesh.)*

## Not-yet (later phases — spec §6, §7)
- **Conforming grid** (Mode C) — a movable, curving, non-destructive decal (geometry that hugs the surface).
- **City auto-scatter** — the generator peppering walls with poster decals; deliberately last.

## Dev harness (before the panel exists)
```js
salsaDecal.ephemera()              // → list of source typeIds to try
salsaDecal.tool(salsaDecal.ephemera()[0])   // ★ THE TOOL: ghost follows cursor, click a surface to place
salsaDecal.off()                   // exit the tool
salsaDecal.demo('poster-typeid')   // one-shot: drop at eye height facing +Z (no raycast) — quick render check
salsaDecal.image(dataUrl) / .imageTool(dataUrl)   // uploaded-image decal (one-shot / tool)
salsaDecal.list() / .size(id, 1.2) / .rotate(id, 0.3) / .remove(id)
```
