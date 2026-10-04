# GARP — Frogmarks UI Integration

Host-facing contract for **GARP** (**G**rouped **A**sset **R**andomizer **P**ool) — the system that gives a
repeated city prop **varied, user-authorable skins**. Today's consumer is the **vending machine** (its opaque
**body** shell). **Salsa owns the pool registry, the atlas, per-instance skin selection, and persistence; Frogmarks
owns the authoring UI** (a per-slot canvas, an upload button, a "Save as variant" action). Spec:
[../specs/city-props-garp.md](../specs/city-props-garp.md).

> **What's built.** The dedicated GARP atlas + shader path, the vending pool (3 built-in brand skins with
> solid-colour placeholder art), per-machine instancing of **both** slots in the real city — **`body`** (the whole
> opaque cabinet shell, a per-face unwrap) and **`products`** (a flat display panel behind the glass) — with glass +
> lit glow kept as their own material families, the "add a variant" capability (upload / 2D-raster / UV-paint
> readback → skin), the **Skins↔UV-Paint bridges**, and **save/reload persistence**. Not yet: a live single-stroke
> 3D preview, and real (non-placeholder) brand art — which is exactly what this doc is for you to supply.

---

## Where it lives (information architecture)

GARP is a **LIBRARY**, not a per-object edit mode — a project-level pool of skins applied across *many* instances
of a prop type. So it gets its **own always-available "Skins" panel**, a sibling of (not nested inside) the
per-object modes (UV Paint / Mesh Edit / Armature Edit). Rule of thumb: *edit modes* are verbs on the selected
object (contextual, mutually exclusive); *libraries* are collections you draw from / add to (always available).

The Skins panel and UV Paint **bridge** — they cross-link, they don't contain each other. Both bridges are engine-
supported (contract below); ⚠ different destinations: UV Paint edits a mesh's **own** texture (`meshTextures`, per-
mesh); a GARP skin is a **pool** texture (`garpJSON`, many) — the bridge *copies* the painted result into the pool.

### Bridge 1 — Skins → UV Paint ("author a variant by painting the 3D form")
From the Skins panel's "New variant → Paint" action:
```ts
const meshId = sm.paintGarpSlot3D(poolId, slot);   // e.g. ('salsa/vending','body'); null if the slot has no 3D form
// convenience: sm.paintVendingBody3D()
```
This spawns a **temporary, paintable preview** of the slot's canonical geometry (its real per-face unwrap — draw the
`garpSlotRegions3D` overlays on the UV pane), enters **UV Paint mode**, and returns the mesh id. The preview is
plain-textured (strokes show live), `excludeFromDocument` (never saved), and **tagged** with its pool/slot. The user
paints on the 3D form + the UV pane; then Bridge 2 commits or `sm.cancelGarpPaint3D()` discards.
*(Both vending slots have a form: `body` = the shell (per-face unwrap), `products` = a flat panel. A flat-quad slot
can be painted here or just authored on the flat canvas — same 0→1 result. `paintGarpSlot3D` returns `null` only for a
slot with no registered form.)*

### Bridge 2 — UV Paint → Skins ("Save as skin variant" button)
In the **UV Paint panel**, on the currently-painted mesh:
```ts
const target = sm.garpPaintTargetOf3D(meshId);     // { poolId, slot, poolName } | null
// target != null → show a "Save as {poolName} variant" button (name field + Save)
const errs = await sm.saveMeshAsGarpSkin3D(meshId, skinName);   // [] = OK; then Regenerate City to see it
```
`garpPaintTargetOf3D` returns non-null only for a mesh that's a GARP paint target (today: a `paintGarpSlot3D`
preview; later, any pooled prop) — so the button appears exactly when saving makes sense. `saveMeshAsGarpSkin3D`
exports the painted texture, adds it as a new skin to the tagged pool/slot, and tears the preview down. A body-only
save is valid (unpainted sibling slots fall back to the pool default). Same collision rule as `addGarpSkin3D` (an
existing name overwrites — warn first).

| Bridge call | Purpose |
|---|---|
| `sm.paintGarpSlot3D(poolId, slot): string \| null` | Spawn a tagged paint-preview of the slot's real unwrap + enter UV Paint. Returns mesh id. |
| `sm.paintVendingBody3D(): string \| null` | Convenience for `('salsa/vending','body')`. |
| `sm.garpPaintTargetOf3D(meshId): {poolId,slot,poolName} \| null` | Is this mesh a GARP paint target? (gates the "Save as variant" button) |
| `sm.saveMeshAsGarpSkin3D(meshId, skinName): Promise<string[]>` | Export the paint + add it as a skin to the tagged pool/slot; tears down the preview. |
| `sm.cancelGarpPaint3D(): void` | Discard the preview without saving. |

---

## Vending machine skins — the three slots (redesign 2026-09-29)

The machine was redesigned (spec: [../specs/vending-machine-redesign.md](../specs/vending-machine-redesign.md)). It
now has a framed window of **3D cans on lit shelves**, price strips with LED buttons, a control panel, a pickup bay
and a plinth. A skin has three slots:

| Slot | What it is | How the user makes it |
|---|---|---|
| `body` | The cabinet: logos and art on the front, sides and top (six-face unwrap, `garpSlotRegions3D(…,'body')`). The window and controls cover part of the front; the **lower panel, the area above the window, the sides and the top** show your art. | UV Paint (Bridge 1), or upload a 512² image laid out on the regions. |
| `products` | The **lit back wall** behind the cans, or the whole display when a machine uses `stock: 'image'`. | Upload / paint a 512² image. Default: a soft white wall. |
| `labels` | The **can designs**: one packed sheet the cans sample. | **Add separate PNGs, one per can design**; Salsa packs them (below). |

### Can designs (`labels`) ✅

```ts
const errs = await sm.packVendingCanLabels3D(skinName, [pngDataUrl1, pngDataUrl2, /* …up to 8 */]);
// [] = OK. Then regenerate the city to see it (like any skin change).
```

- **1–8 images, one per can design.** Salsa packs them into a 4×2 sheet, with padding so labels never bleed into
  each other, and draws the silver rims. With fewer than 8, designs repeat. Each machine shows a mix of them.
- **Sizes don't need to match; no need to enforce it.** Each image is **stretched to its can's label**, so any
  size works. For no distortion, author at **1:2 portrait** (e.g. 256×512). What you draw is the **front of the
  can**; the back mirrors it.
- The skin must already exist (a built-in `red` / `blue` / `cyan`, or one added with `addGarpSkin3D`, which gives it
  a body). The skin's other slots are kept.
- **Guide image:** `sm.vendingLabelTemplate3D()` returns a PNG data URL of the sheet layout (numbered cells, rims,
  safe area). `sm.garpSlotRegions3D('salsa/vending', 'labels')` returns the 8 label rects, if you'd rather overlay
  them.

**Suggested UI** (in the Skins panel, on a vending skin): a **"Can designs"** strip of thumbnails, with **+ Add
PNG**, ✕ per design and drag-to-reorder. On any change, call `packVendingCanLabels3D(skin, allImages)`. Keep the
PNG list in Frogmarks' own state so the user can edit it later: Salsa stores only the packed sheet.

> ⚠ **Body skins made before 2026-09-29 appear mirrored.** The body unwrap mapped every face mirrored (an imported
> logo read backwards). The face regions are unchanged; only the direction inside each face was fixed. A body skin
> painted or uploaded before this needs flipping horizontally within each face region, or repainting. The built-in
> solid-colour skins are unaffected.

## Adverts — your own images on the city's signs ✅ (2026-09-29)

The `salsa/signage` pool puts the user's own images on the city's advertising signage: the dense wall of real
pictures on a Shibuya street. Add vertical kanban, billboards, square panels and long shop strips, and every sign
in the city shows one of them.

**How it works**
- **Four buckets, by aspect (width ÷ height).**

  | Bucket | Aspect | Typical signs | Per page | Cell (px) | Author at |
  |---|---|---|---|---|---|
  | `portrait` | below 0.6 (1:3 – 1:4) | vertical blade signs, sign stacks | 4 | 120×504 | 256×1024 |
  | `square` | 0.6 – 1.4 | small panels, the lower sign of a stack | 4 | 248×248 | 512×512 |
  | `landscape` | 1.4 – 4 (16:9 – 3:1) | rooftop billboards, LED screens | 2 | 504×248 | 1024×512 |
  | `fascia` | 4 and over (~6:1) | tenant signs over shops, konbini bands, floor signs, wrap bands | 4 | 504×120 | 1536×256 |

  Every sign face is classified by **its own** aspect, so a wide LED screen can land in `square` or `landscape`.
- **Salsa packs.** Each bucket's images go onto 512² pages (the GARP atlas size). Each image is stretched to its
  cell, and its edges bleed into the padding so neighbours never mix. You never see the pages.
- **Cover crop.** On each sign, the image **fills the face and is cropped to fit**, centred. It's never letterboxed
  or distorted. Keep the important part of the image near the centre.
- **Lit or unlit, per image.** Lit (the default) is a backlit lightbox: the image glows at full brightness at night.
  Unlit is a poster: the scene lights it, so it goes dark at night. LED screens are always lit.
- **Picking.** Each sign picks an image from its bucket by a stable hash, so the same sign shows the same image on
  every rebuild. Adding an image only changes the signs that the new image takes over; every other sign keeps its
  picture. Both faces of a blade sign show the same image.
- **Fallback.** If a bucket has no images, its signs keep the procedural lightbox with lettering. With no images
  at all, the city is exactly as before, and saved cities look identical.
- **Procedural signs** (2026-09-30, persona-polish C1/C2/B5) spell **real Japanese shop words** (ラーメン, 薬,
  カラオケ, 居酒屋, 不動産 …) chosen by the district and the shop type, in horizontal or vertical (tate) layouts. Each
  sign is a **lightbox**: a casing with side faces, a bevelled lit face, and brackets on blade signs. Sign colours
  come from a curated palette per district mood, including white and black lightboxes. None of this needs host
  wiring.
- **The sign stays.** The lightbox stays as the sign's frame and edges. The image sits just in front of its face
  and replaces the lettering.
- **The city rebuilds on its own.** After a change, it rebuilds in the background. Several changes in quick
  succession cause only one rebuild.
- **Saved with the document.** The images are saved in `garp.json` (key `signage`). The pages are packed again on
  load.

**API** (all on `sm`)

| Call | Purpose |
|---|---|
| `sm.addSignageImage3D(bucket \| 'auto', source, { lit?, name?, regen? }): Promise<{ id, bucket, errors }>` | Add an image. `source` = a data URL (or any URL the image loader can read). `'auto'` picks the bucket from the image's aspect. The image is flattened onto white, capped at 1024 px and stored as JPEG. `errors` is empty on success. |
| `sm.removeSignageImage3D(id, regen = true): Promise<boolean>` | Remove an image. Returns `false` if the id is unknown. |
| `sm.setSignageImageLit3D(id, lit, regen = true): boolean` | Switch an image between lit and unlit. The pages aren't repacked; only the city rebuilds. |
| `sm.listSignageImages3D(): { id, bucket, lit, aspect, name?, dataUrl }[]` | Every sign image, in the order added. Use `dataUrl` as the thumbnail. Shop-window images are listed separately (see [Shop windows](#shop-windows--interiors-and-posters-on-the-shop-glass--2026-09-30)). |
| `sm.signageBuckets3D(): { bucket, label, aspect, minAspect, maxAspect, recommendedPx, perPage, cellPx, count }[]` | The four sign buckets: one drop zone each. `maxAspect` is `Infinity` for fascia. |
| `sm.packSignage3D(): Promise<void>` | Force a repack and an atlas rebuild. You don't normally need this. |
| `sm.setSignageShare3D(share, regen = true)` / `sm.getSignageShare3D()` | The share of eligible signs that show an image, from 0 to 1 (default 1). Lower it to mix images with procedural lettered signs. Saved with the document. |
| `sm.clearSignage3D(regen = true): Promise<void>` | Remove every sign image. The city goes back to procedural signs. Shop-window images stay. |

**Suggested Frogmarks "Adverts" panel.** This is a library, like Skins: an always-available panel, not an edit mode.
- **One section per bucket** from `signageBuckets3D()`. Each shows its label, the aspect hint, the recommended
  size and the count.
- A **drop zone** per section: files dropped there call `addSignageImage3D(bucket, dataUrl, { name: file.name })`.
  A drop zone for the whole panel can use `'auto'` and let Salsa sort the images. The response's `bucket` shows
  where each image went.
- A **thumbnail grid** per section from `listSignageImages3D()`. Each thumbnail has a ✕ button
  (`removeSignageImage3D`) and a **Lit** toggle (`setSignageImageLit3D`, with a small bulb icon).
- Optionally, a **"Signs with images" slider** (`setSignageShare3D`) and a **Clear all** button.
- No "Regenerate" button is needed: every call rebuilds the city by default. Pass `regen: false` to batch changes
  yourself, then call the last change with `regen` on.
- The engine owns the image list. It persists with the document, so the panel can always re-read
  `listSignageImages3D()`.
- The `salsa/signage` pool is **hidden** from `sm.garp.listPools()`, so the Skins panel never shows it.

**Console harness:** `salsaGarp.demoAdverts()` adds 12 generated test images (3 per bucket; the third of each is
unlit). Each shows its bucket letter and number, with an arrow pointing right: if the arrow points left, the face
is mirrored. `salsaGarp.pickAdverts('auto')` opens a file dialog, `salsaGarp.adverts()` lists the images and
`salsaGarp.clearAdverts()` removes them all.

**Limits (v1)**
- Resolution is one cell of a 512² page, as in the table above. At street distance that reads well. Close up, a
  billboard is about 500 px wide.
- The GARP atlas has no mipmaps (the same as the vending machines), so distant signs can shimmer a little.
- There's no video for screens yet.
- Picking uses a stable hash only: there are no per-image weights yet.

## Shop windows — interiors and posters on the shop glass ✅ (2026-09-30)

The same pool also puts the user's images **inside the city's shopfronts**. Without images, every shop window shows
the procedural interior (fluorescent ceiling and rows of coloured shelf blocks). Add a few photos or drawings of shop
interiors and posters, and the shopfronts show those instead.

**How it works**
- **Two buckets, no aspect sorting.** A sign never picks these, and `'auto'` never sorts into them.

  | Bucket | What it is | Per page | Cell (px) | Author at |
  |---|---|---|---|---|
  | `interior` | The back wall of a shop, seen through the glass: shelves, a counter, a menu wall | 2 | 504×248 | 1024×512 (3:2 – 2:1) |
  | `poster` | A sheet stuck on the inside of the glass: a sale poster, an opening-hours card | 6 | 162×248 | 512×724 (A-series) |

- **Real depth, not a flat picture.** A bay that picks an interior image becomes a real recessed room behind a clear
  pane. The image is on the back wall, 0.6 – 1.1 m deep, with pale lit floor, ceiling and side walls. Walk past it and
  the room shifts with true parallax. The image is cover-cropped to each bay's shape.
- **Posters** go on about half the shop bays, at eye height, at a stable spot across the pane. They go on the glass
  of an image-interior bay and of a procedural one.
- **Lit or unlit, per image.** Lit (the default) glows with the shop at night. Unlit is lit by the scene only.
- **Picking and fallback** work as for adverts: a stable hash per bay, with the same bay showing the same picture on
  every rebuild. With an empty `interior` bucket, every bay keeps the procedural interior. With no shop images at
  all, the city is exactly as before. The bays on a corner shared by two shopfront edges keep the procedural
  interior, so the rooms never cross.
- **Saved with the document** in `garp.json`, alongside the adverts. The share is saved as `signage.shopShare`.

**API** (all on `sm`)

| Call | Purpose |
|---|---|
| `sm.addShopImage3D('interior' \| 'poster', source, { lit?, name?, regen? }): Promise<{ id, bucket, errors }>` | Add a shop-window image. `source` is a data URL (or any URL the image loader can read). Stored as for adverts: flattened onto white, capped at 1024 px, JPEG. |
| `sm.removeShopImage3D(id, regen = true): Promise<boolean>` | Remove a shop-window image. |
| `sm.setShopImageLit3D(id, lit, regen = true): boolean` | Switch an image between lit and unlit. |
| `sm.listShopImages3D(): { id, bucket, lit, aspect, name?, dataUrl }[]` | Every shop-window image, in the order added. |
| `sm.shopImageBuckets3D(): { bucket, label, aspect, minAspect, maxAspect, recommendedPx, perPage, cellPx, count }[]` | The two shop buckets: one drop zone each. |
| `sm.setShopImageShare3D(share, regen = true)` / `sm.getShopImageShare3D()` | The share of shop bays that show a shop image, from 0 to 1 (default 1). Lower it to mix images with procedural interiors. Saved with the document. |
| `sm.clearShopImages3D(regen = true): Promise<void>` | Remove every shop-window image. The shops go back to procedural interiors. Adverts stay. |

**Suggested Frogmarks "Shop windows" panel,** next to Adverts and built the same way:
- **Two sections** from `shopImageBuckets3D()` (Shop interior, Window poster). Each has a drop zone that calls
  `addShopImage3D(bucket, dataUrl, { name: file.name })`.
- A **thumbnail grid** per section from `listShopImages3D()`, with a ✕ button (`removeShopImage3D`) and a **Lit**
  toggle (`setShopImageLit3D`).
- Optionally, a **"Shops with images" slider** (`setShopImageShare3D`) and a **Clear all** button
  (`clearShopImages3D`).

**Console harness:** `salsaGarp.demoShopImages()` adds 3 generated interiors (BOOKS 本 / DRUG 薬 / CAFE カフェ shelf
walls) and 3 posters. `salsaGarp.shopImages()` lists them and `salsaGarp.clearShopImages()` removes them.

**Limits (v1)**
- Only the back wall is an image. The floor, ceiling and side walls are plain pale surfaces.
- An interior cell is 504×248 px, which is fine at street distance but soft when you press your nose to the glass.

---

## The mental model (three nouns)

- **Pool** — a family of skins for one prop type. It has an **id** (`salsa/vending`), a **version**, and a list
  of **slots**. The vending pool's slots are `['body', 'products', 'labels']`.
- **Skin** — one coordinated look: **a texture per slot** (`body` + `products` + `labels`). The randomizer picks a
  **whole skin**, so a machine can never wear brand A's body over brand B's cans.
- **Variant** = a skin the *user* authored and added at runtime. Adding one makes it eligible on every machine
  from the **next city (re)generation** (selection is a deterministic position hash over the *current* pool).

A skin's texture for a slot is a **`DecalSource`** — the same type decals use:

```ts
type DecalSource =
  | { kind: 'ephemera'; typeId: string; params: Record<string, unknown> }  // a generator
  | { kind: 'image'; dataUrl: string };                                    // an uploaded / painted image
```

---

## The flow the host builds — "add your own skin"

**One 512×512 canvas per slot** (read the pool's slots). Each slot has a **UV contract** — what regions of the
square map to which surfaces. **Ask the engine for the layout and draw it as labelled overlays** so the user knows
which patch lands where:

```ts
sm.garpSlotRegions3D(poolId, slot): { label, u0, v0, u1, v1 }[]   // rects in 0..1, y-down (image space)
```

- **`body`** (the machine's opaque cabinet shell) → a **full per-face unwrap**, front-dominant: `garpSlotRegions3D`
  returns six labelled rects — **`front`** (the left ~half, full resolution — the detail-critical brand face) plus
  **`back` / `top` / `left` / `right` / `bottom`** packed into the right half. Draw each rect + its label on the
  canvas so the user paints the right patch onto each face. *(This layout is a **contract** — Salsa bumps the pool
  `version` if it changes, invalidating skins painted against the old one. Regions have gaps so paint never bleeds
  between faces.)*
- **`products`** (and any banner/poster slot) → a single `(full)` region `[0,0,1,1]` — the whole square is the face.

Any of these three sources produce a slot texture:

1. **Upload an image** → read the file to a data URL.
2. **Draw it on the 2D raster document** (recommended for logos — it has fill/bucket, layers, and image import,
   which UV Paint does not) → capture the active layer with **`sm.exportActiveLayerDataUrl()`** → a PNG data URL
   (`null` if there's no raster doc / selected layer). This is the **"Use canvas"** button.
3. **Paint it in UV Paint mode** (draw on the 3D mesh *or* the 2D UV pane) → read the painted texture back with
   **`sm.exportMeshTextureDataUrl3D(meshId)`** → a PNG data URL. **Returns `null` (never throws)** for a mesh
   that has no UV-paint texture — only meshes painted/uploaded through the UV-paint path qualify; a mesh textured
   via `setMeshTexture3D` has no readback.

All three end as a `DecalSource { kind: 'image', dataUrl }`. Then **one call saves the variant**:

```ts
// Add (or replace, by name) a skin in a pool, then rebuild the atlas. Returns validation problems ([] = OK).
await sm.addGarpSkin3D('salsa/vending', 'coke', {
  body:     { kind: 'image', dataUrl: bodyDataUrl },      // the cabinet shell (six-face unwrap)
  products: { kind: 'image', dataUrl: productsDataUrl },
});
// Then REGENERATE the city (updateCity / generateWorld) to see the variant on machines.
```

> **Why regenerate?** Which machine wears which skin is chosen when the city is built (a position hash over the
> pool). Existing machines keep the choice they were built with; a fresh generation re-picks over the enlarged
> pool, so your new variant starts appearing. (A future targeted-refresh could avoid the regen — not built yet.)

### Registering a whole pool at once (or seeding real brand art)

To replace the ephemera placeholders with real brand skins, register the pool with your own sources:

```ts
const errs = sm.registerGarpPool3D(pool, textures);   // sync; assigns atlas layers; returns validation problems
await sm.rebuildGarpAtlas3D([512, 512]);              // resolves every source → uploads the atlas
```

- `pool: GarpPool` = `{ id, name, version, size:[512,512], slots:['body','products'], skins:[…] }`.
- `textures: Record<string, DecalSource>` maps each skin-slot **texture key** to its source. For the vending
  pool, the key convention is **`vending/<brand>/<slot>`** (`sm` uses this internally; match it to override a
  built-in brand's art in place).

---

## API surface (all on `ShapeManager`, i.e. `sm`)

| Call | Purpose |
|---|---|
| `sm.registerGarpPool3D(pool, textures): string[]` | Register/replace a pool + its skin-slot texture sources. Synchronous; returns validation problems. |
| `sm.addGarpSkin3D(poolId, skinName, { slot: DecalSource, … }): Promise<string[]>` | Add/replace one user variant, then rebuild. The save-as-variant entry point. |
| `sm.removeGarpSkin3D(poolId, skinName): Promise<string[]>` | Delete a skin (built-in or user) + rebuild — the panel's delete/iterate action. Regenerate the city to drop it from machines. |
| `sm.rebuildGarpAtlas3D(size?): Promise<void>` | Resolve every registered source → (re)upload the dedicated atlas. Called for you by the three above. |
| `sm.exportActiveLayerDataUrl(): Promise<string \| null>` | Export the active 2D raster layer as a PNG data URL — the **"Use canvas"** path. `null` if no raster doc / selected layer. |
| `sm.exportMeshTextureDataUrl3D(meshId): Promise<string \| null>` | Read a UV-painted mesh's current texture out as a PNG data URL (for "save current paint as a variant"). |
| `sm.garp.listPools(): {id,name,version,slots,skins}[]` | Enumerate pools. **`slots` is `{ name, live }[]`** (one authoring canvas per slot). **`skins` is `{ name }[]`** — the LIST of existing skins: map it for the variant list + per-skin delete button (`.length` for the count). |
| `sm.setGarpSlotLive3D(poolId, slot, live)` | Declare whether a custom pool's slot renders in-world (drives the badge). The engine sets vending's for you. |
| `sm.garpSlotRegions3D(poolId, slot): {label,u0,v0,u1,v1}[]` | The slot canvas's UV regions (0..1, y-down) — draw as labelled overlays. `body` → six face rects; `labels` → 8 can-label rects; plain quads → one `(full)`. |
| `sm.packVendingCanLabels3D(skinName, images): Promise<string[]>` | Pack 1–8 can-design images (data URLs) into the skin's `labels` sheet + rebuild. See "Can designs". |
| `sm.vendingLabelTemplate3D(): string` | A PNG data URL showing the label-sheet layout (a guide for artists). |
| `sm.packGarpSheet3D(images, cols, rows, size?, padPx?): Promise<string \| null>` | Generic: pack images into a padded grid sheet (data URL) — for other props with many small varied items. |
| `sm.garp.getPool(id)` / `removePool(id)` | Inspect / drop a pool. |

*(The Adverts calls, `addSignageImage3D` / `removeSignageImage3D` / `setSignageImageLit3D` / `listSignageImages3D` / `packSignage3D` / `signageBuckets3D` / `setSignageShare3D` / `clearSignage3D`, are in the [Adverts](#adverts--your-own-images-on-the-citys-signs--2026-09-29) section. The Shop windows calls, `addShopImage3D` / `removeShopImage3D` / `setShopImageLit3D` / `listShopImages3D` / `shopImageBuckets3D` / `setShopImageShare3D` / `clearShopImages3D`, are in the [Shop windows](#shop-windows--interiors-and-posters-on-the-shop-glass--2026-09-30) section.)*

*(The Skins↔UV-Paint bridge calls — `paintGarpSlot3D` / `paintVendingBody3D` / `garpPaintTargetOf3D` / `saveMeshAsGarpSkin3D` / `cancelGarpPaint3D` — are in the [Bridges](#bridge-1--skins--uv-paint-author-a-variant-by-painting-the-3d-form) section above.)*

> **Per-slot `live` — drive the "not shown in-city yet" badge from data.** `listPools()` gives each slot a
> `live` boolean. Slots are live by default; the engine marks the ones with no in-world consumer yet.
> Today **both vending slots are `live:true`** (`body` = the cabinet shell, `products` = the flat display panel) —
> both instanced on city machines. The mechanism stays: a slot with no in-world consumer reports `live:false` and
> you badge it "not shown in-city". Don't hardcode which slot is shown; read `live`.

> **Name collisions replace.** `addGarpSkin3D` with an existing skin name (including built-ins `red`/`blue`/`cyan`)
> **overwrites** that skin. Warn before overwriting — e.g. *"A skin named 'coke' already exists. Overwrite?"* —
> since a user may not realize they're clobbering a built-in brand. (`listPools()`/`getPool()` give the existing
> names to check against.)

**Persistence is automatic.** Pools + skin sources ride in the document save (`garpJSON`) and restore before the
city regenerates, so authored variants survive reload. Atlas layer indices are **never** saved (session-local);
skins are referenced by name, so a saved city stays correct even as pools load/unload. You don't call anything.

---

## Try it now (console harness, no panel needed)

A `window.salsaGarp` dev harness exercises the whole path before you build UI:

```js
salsaGarp.vending(6)                         // drop a row of demo machines with coordinated body+products skins
salsaGarp.pools()                            // list registered pools (id, version, slot names, skin count)
salsaGarp.addVendingSkin('coke', myDataUrl)  // add a BODY variant from an uploaded/base64 image → regenerate to see it
salsaGarp.saveVendingSkin(meshId, 'mybrand') // save a UV-painted mesh's texture as a variant (paint it first)
salsaGarp.pickCans('red')                    // pick 1–8 can PNGs (file dialog) → packed into red's labels → regenerate
salsaGarp.packCans('red', [url1, url2])      // same, from data URLs
salsaGarp.labelTemplate()                    // the label-sheet layout guide (PNG data URL)
salsaGarp.rebuild()                          // force an atlas rebuild
```

To test the real city path: `addVendingSkin`/`saveVendingSkin`, then regenerate the city — the variant starts
appearing on corner machines (position-hashed, so it's stable across regenerations).

---

## Constraints & ownership

- **Fixed size per pool (512×512 for vending).** Every texture is packed at one resolution. **Non-512² uploads
  are auto-resized** (contain-fit: preserved aspect, letterboxed — the whole image, undistorted), so any upload
  shows. Authoring on a **square 512²** surface avoids the letterbox bars and is recommended.
- **Both slots instanced in the city.** Machines instance the **body shell** (whole opaque cabinet — a full per-face
  unwrap, all faces paintable) and the **products** panel (a flat 0→1 quad, the drink display behind the glass). Both
  are GARP-skinnable + coordinated (one skin supplies both).
- **UV contract + versioning.** A slot's UV layout (`body`'s six-face unwrap from `garpSlotRegions3D`) is a contract
  user skins are painted against. Salsa **bumps the pool `version`** on any layout change; a saved city can compare
  versions to know a skin predates the current unwrap. Trivial 0→1-quad slots (banners, `products`) are stable.
- **Alignment.** All city machines share one size, so the lit window sits at a **fixed spot on the `front` region**
  across every machine — one skin's front art aligns to all. (Region rects have small gaps so bilinear filtering
  never bleeds one face's paint onto its neighbour.)
- **Placeholder art.** Until you register real skins, machines wear solid brand-colour placeholders so the city
  reads cleanly (not a stretched pattern).
- **Salsa owns:** the pool registry, the dedicated GARP atlas, per-instance skin selection (position hash), the
  shader, and persistence. **Frogmarks owns:** the per-slot authoring canvas, the upload/import buttons, and the
  "Save as variant" action — all of which reduce to the API calls above.
