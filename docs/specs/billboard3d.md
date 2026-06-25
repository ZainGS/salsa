# Billboard3D — Spec

**Status:** Mesh generator built (`src/renderer/3d/billboard-3d.ts`); **integrated + browser-validated** — the shell's `CartridgeViewer` renders these cutouts (system-app icons, hero logo) with an always-front mirror flip. Grid-tile cutouts were superseded by the 3D **coins/CDs** ([shell-cd.md](shell-cd.md)).
**Last Updated:** 2026-06-12

A **Billboard3D** is a 3D "paper cutout" of a PNG: the image's alpha silhouette, extruded along Z, with the image textured on the front and back faces and a solid color on the cut edge (sides). It's the 3DS / Flipnote Studio look — a sprite printed on card stock and cut out with scissors. General-purpose Salsa primitive; first consumer is the Shell UI (app/cart icons).

---

## Two silhouette modes (auto-selected)

| Source | Silhouette | Result |
|---|---|---|
| **Opaque image** (≥ `opaqueRectThreshold` opaque) | Rounded rectangle of the bounding box | A clean rounded slab — for cart/project **thumbnails** (rectangular art) |
| **Transparent icon** | Traced alpha contour | A true cutout of the icon shape — for **system-app icons** |

> **Key consequence:** the *cutout pop* only happens for **shaped, transparent** icons. A rectangular thumbnail has no silhouette, so it degenerates to a rounded slab. To make the shell icons pop, system apps need **transparent PNG icons** (or procedurally drawn placeholders).

---

## Mesh generation (built)

`generateBillboard3DGeometry(rgba, w, h, config) → Billboard3DGeometry`

Pipeline:
1. **Alpha mask + bbox.** Threshold alpha; find opaque-pixel fraction + bounding box.
2. **Silhouette.** Opaque → `roundedRectOutline`. Transparent → `traceContour` (boundary-edge chaining, robust + winding-agnostic) → `simplify` (Douglas–Peucker).
3. **Normalize** to model space (larger trimmed axis ≈ 1.0, centered, y-up); UVs map the source image onto the face.
4. **Pad** the polygon outward (`padding`) so the cut edge sits proud of the art.
5. **Triangulate** the front polygon (self-contained ear clip).
6. **Extrude:** front (z = +depth/2, normal +Z, textured) + back (−Z, reversed, textured) + side quads (outward normal, `faceType = 1` → solid `sideColor`).

Output arrays: `positions`, `normals`, `uvs`, `faceType` (0 = textured face, 1 = solid side), `indices`, `aspect`.

```typescript
interface Billboard3DConfig {
  padding: number;            // outward expansion (model units). default 0.04
  depth: number;              // Z thickness. default 0.10
  cornerRadius: number;       // rounded-rect mode corner. default 0.06
  sideColor: [number,number,number,number]; // cut edge. default white
  alphaThreshold: number;     // 0–255 inside test. default 26
  opaqueRectThreshold: number;// opaque fraction → rect mode. default 0.92
}
```

---

## Render integration

The geometry is renderer-agnostic. Two consumers were planned:

> **Update (2026-06-12):** Consumer **A is built and validated** — `CartridgeViewer` renders these cutouts for system-app icons and the hero logo (with an always-front mirror flip so spinning text never reads backwards). Consumer **B (grid tiles) is also built**, but as a **full-perspective spinning cutout** at each tile (`drawBillboard`, e.g. Install Cart's download arrow) with its own depth buffer — not the original cavalier/oblique projection. Alongside it are the 3D **coins** (`drawDisc`) and **CDs** (`drawCD`). See [shell-cd.md](shell-cd.md).

### A — Cartridge viewer (quick, reuses infra)
The shell's `CartridgeViewer` already renders a spinning textured 3D mesh with depth + lighting. Feed it a Billboard mesh (generated from the selected slot's thumbnail/icon) instead of the box, sampling the thumbnail atlas for `faceType 0` and `sideColor` for `faceType 1`. The selected item then spins as a 3D cutout. *(For thumbnails this is a rounded slab until transparent icons exist.)*

### B — Grid tiles (the "pop", needs design)
To make the **grid icons** stand off the flat circle slots, render the Billboard meshes in the grid with an **oblique (cavalier) projection** — Z extrusion offsets screen x/y by a fixed amount so the front face stays at its exact 2D position (stable layout + hit-testing) while the thickness + lit top/side edges show. Add a contact shadow on the slot to ground it. Rectangular tiles share one rounded-slab mesh → instanced, one draw; transparent icons get their own meshes (few). Needs a depth buffer for the grid 3D pass.

---

## Asset dependency

System apps (Illustrator, Settings, Install Cart) currently have **no icon PNGs**. Options:
- Supply transparent PNG icons → true cutouts.
- Procedurally draw placeholder icon silhouettes (gear, pencil, star) to a canvas → Billboard generator → demo cutouts now.
- Leave system apps as flat circles; apply Billboard only to cart/project thumbnails (rounded slabs).

---

## Related
- [specs/shell-ui-upgrade.md](shell-ui-upgrade.md) — the shell visual upgrade that consumes this
- `src/renderer/3d/billboard-3d.ts` — the generator
- `src/renderer/shell/shell-cartridge.ts` — CartridgeViewer (integration target A)
