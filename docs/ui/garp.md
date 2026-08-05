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

## The mental model (three nouns)

- **Pool** — a family of skins for one prop type. It has an **id** (`salsa/vending`), a **version**, and a list
  of **slots**. The vending pool's slots are `['body', 'products']`.
- **Skin** — one coordinated look: **a texture per slot** (`body` + `products`). The randomizer picks a
  **whole skin**, so a machine can never wear brand A's body over brand B's products.
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
| `sm.garpSlotRegions3D(poolId, slot): {label,u0,v0,u1,v1}[]` | The slot canvas's UV regions (0..1, y-down) — draw as labelled overlays. `body` → six face rects; plain quads → one `(full)`. |
| `sm.garp.getPool(id)` / `removePool(id)` | Inspect / drop a pool. |

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
salsaGarp.addVendingSkin('coke', myDataUrl)  // add a variant from an uploaded/base64 image → regenerate to see it
salsaGarp.saveVendingSkin(meshId, 'mybrand') // save a UV-painted mesh's texture as a variant (paint it first)
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
