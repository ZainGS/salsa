# Charms & Accessories Panel — Frogmarks UI Integration

**Last Updated:** 2026-06-29 (engine v1 — 9 types incl. **loop/D-ring**, joint-anchored, spring-bone dangle, swag chains + **loop→loop connection**, belt-loop row)
**Engine spec:** [wardrobe-expansion.md](../specs/wardrobe-expansion.md) Phase 2 · **Sibling UI docs:** [clothing.md](./clothing.md), [hair.md](./hair.md), [armature.md](./armature.md) (Spring Bones — the dangle is wired there later).

Build a **Charms / Accessories** panel under *Edit Character* that pins small parametric meshes — chains, pockets, pendants, bracelets, watches, chokers, hair clips, flowers, **loops/D-rings** — onto the character. Each charm is **anchored to a body joint** + a local offset, **skinned 100% to that joint**, so it poses with the body. A character can hold **many** charms (a list, not slots).

> **Status:** ✅ engine live — 9 types, live params/placement, persistence (survives reload + `.frogmarks`), re-anchors on body-shape change, picking a charm selects the body, the chain + pendant dangle SWINGS when posed (spring-bone), swag (both-ends) chains, **placeable loops/D-rings + chains that CONNECT loop→loop and track them**, a **belt-loop row** helper, **surface-pin placement (CLICK a garment to drop a charm exactly there)**, **PBR materials — metal types render as shiny metal (chrome/gold)**, and an optional **✨ sparkle/glint** (twinkling micro-glints). 🔶 pending (engine v2+): **bake-to-part**, more types. **Charm painting is intentionally NOT supported** — charms are defined by colour + metalness/roughness, not pixel paint (painting would fight the metal material).

---

## 0. Prerequisite
Charms anchor to a **rigged body's joints** (from the Body panel). No body → `addAttachment3D` returns `null`. Show the panel once a body exists.

---

## 1. The flow
```
Edit Character ▸ Charms
   ┌──────────────────────────────────────────────┐
   │  + Add:  [ Chain ▾ ]                           │   ← type picker → addAttachment3D
   │                                                │
   │  Placed:                                       │
   │   • Chain   (hips)        [edit] [✕]            │   ← list of placed charms
   │   • Pocket  (upperleg_R)  [edit] [✕]            │
   │                                                │
   │  ── editing: Chain ──                          │
   │   Anchor [ hips ▾ ]                             │   ← joint dropdown
   │   Offset  x● y● z●     Scale ●                  │   ← position on/around the joint
   │   Links ●  Span ●  Sag ●  Thickness ●           │   ← per-type sliders
   │   Colour [■]                                    │
   └──────────────────────────────────────────────┘
```
1. **Add** → pick a type → `addAttachment3D(bodyMeshId, type)` (spawns at the type's default joint+offset). Push the returned `id` into your list.
2. **Edit** → sliders write the `params`/`placement` object → `setAttachmentParams3D(id, params)` / `setAttachmentPlacement3D(id, placement)` (live; debounce ~40 ms).
3. **Remove** → `removeAttachment3D(id)`.

---

## 2. API (✅ live)
```ts
shapeManager.attachmentTypeNames3D();                       // ['chain','pocket','pendant','bracelet','watch','choker','clip','flower','loop','beltloop','button']
const params    = shapeManager.getDefaultAttachmentParams3D(type);     // seed the sliders
const placement = shapeManager.getDefaultAttachmentPlacement3D(type);  // { joint, offset:[x,y,z], scale }
const id = shapeManager.addAttachment3D(bodyMeshId, type, placement?, params?);   // → id | null

shapeManager.setAttachmentParams3D(id, params);             // live tune
shapeManager.setAttachmentPlacement3D(id, placement);       // move it
shapeManager.getAttachment3D(id);                           // { id, type, placement, params } | null
shapeManager.listAttachments3D(bodyMeshId);                 // all charms on a body (seed the list)
shapeManager.removeAttachment3D(id);
shapeManager.getAttachmentMeshId3D(id);                     // the current mesh id (changes each rebuild)

shapeManager.addBeltLoops3D(bodyMeshId, count = 5);         // → string[] CLOTH belt-loop ids, flush on the pants waistband (auto-placed + they FOLLOW the pants)
shapeManager.setCharacterSparkle3D(bodyMeshId, on, 'glint'|'star');   // ✨ glints (default) or anime ✦ STAR bling on ALL metal charms (per-charm: params.sparkle = true|'glint'|'star')

// Surface-pin: click a garment/body to DROP a charm exactly where tapped (resolves to that surface's joint + offset).
shapeManager.beginAttachmentPlacePick3D(bodyMeshId, type, { onPlaced:(id)=>…, onHover:(world|null)=>… });
shapeManager.endAttachmentPlacePick3D();                    // leave place mode

// GHOST PREVIEW (recommended): select a type → show a translucent ghost at its default spot that FOLLOWS the cursor
// over the body; "Add" commits it. (e.g. select Choker → ghost at the neck → Add → spawns there.)
shapeManager.showAttachmentPreview3D(bodyMeshId, type, params?, placement?);   // ghost on + hover-to-reposition
shapeManager.updateAttachmentPreview3D(params?, type?);     // live-tweak colour/size or switch type while previewing
shapeManager.commitAttachmentPreview3D();                   // → id — spawn the real charm where the ghost is, hide ghost
shapeManager.hideAttachmentPreview3D();                     // cancel (deselect / panel close)

// Click TWO points on any garment/body → string a chain between them (no hoops, no xyz). Click A, then B; repeat for more.
shapeManager.beginChainPick3D(bodyMeshId, { params?, onPlaced:(id)=>…, onProgress:(p)=>… /* 'first'|'second' */, onHover:(world|null)=>… });
// (uses the same endAttachmentPlacePick3D() to leave the mode)
```

## 3. Placement
```ts
interface AttachmentPlacement { joint: string; offset: [number, number, number]; scale: number; }
```
- **`joint`** — any body joint name: `hips · spine · chest · neck · head · clavicle_L/R · shoulder_L/R · lowerarm_L/R · hand_L/R · upperleg_L/R · lowerleg_L/R · foot_L/R`. A **dropdown** of these.
- **`offset`** — local offset from the joint in the **rest pose** (world units; ~−0.2…0.2). Three small sliders (x/y/z) or a drag handle. +Z = the character's front.
- **`scale`** — overall size (0.5…2).

> **⚠️ WRAP types — bracelet · watch · choker — IGNORE `offset` & `scale`.** They can only sit on a limb, so a free x/y/z + scale just lets you break them (a bracelet floating off the wrist). Instead they **shrink-fit** the limb radius and **auto-orient** along the bone, and expose a single **`position`** slider (0…1) that slides the band along the limb — wrist↔elbow (bracelet/watch) or up/down the neck (choker). For these, show only: **Anchor joint** (`lowerarm_L/R` or `neck`) + **Position** + **thickness** (+ watch face `width`/`height`) + **colour**. Hide the offset/scale controls.

## 4. `AttachmentParams` → controls (per type)
All types share one `AttachmentParams` object (start from `getDefaultAttachmentParams3D(type)`); show only the fields that matter for the chosen type. `color` is shown for every type.

| Type | Anchor (default) | Key sliders | Notes |
|---|---|---|---|
| **chain** | `hips` | `chainMode` (dangle/swag) · `linkCount` (4–24) · `thickness` (**0.0015–0.005**, wire radius) · `span`/`sag` · `endJoint`/`endOffset`/`swagSoftness` (swag) | **interlocking oval links** (real chain-link geometry, alternating 90°). **Two modes** + a far-end joint + a sway slider (see below). Keep `thickness` small — it's a wallet chain, not a rope |
| **pocket** | `upperleg_R` | `width` · `height` · `flap` · `thickness` | a panel + flap (cargo pocket). Auto-oriented: **faces outward from the limb + runs PARALLEL to the leg** (its up = the bone axis), flap at the top — `offset` only sets WHERE on the limb (front/side/back), not the tilt |
| **pendant** | `neck` | `dropLength` · `width` · `thickness` | a diamond on a short bail that **DRAPES down the surface + lies ON it facing out** (rests on the cloth, no clip). **Surface-pin / ghost-preview it** onto a shirt/strap; it's rigid (stays where pinned, no longer a free-swinging pendulum) |
| **bracelet** | `lowerarm_L` | **`position`** (0–1, slide along the arm) · `thickness` (band width) | a band **shrink-fitted** to the forearm, auto-oriented; `position` = wrist(1)↔elbow(0). **No offset/scale** |
| **watch** | `lowerarm_L` | **`position`** · `thickness` · `width` · `height` (face) | bracelet + a face box **on TOP of the wrist, facing up** (the back of the wrist); **shrink-fits** the arm. **No offset/scale** |
| **choker** | `neck` | **`position`** (0–1, up/down the neck) · `thickness` | a band **shrink-fitted** to the neck + a front charm. **No offset/scale** |
| **clip** | `head` | `width` · `height` · `thickness` | a small flat bar (hair clip) |
| **flower** | `head` | `width` (petal reach) | 5 petals (hair flower / appliqué) |
| **loop** | `hips` | `width` (ring radius) · `thickness` (strap) | a small **metal D-ring** on the surface (faces out along `offset`). A **chain anchors to it** (`fromLoop`/`toLoop`) |
| **beltloop** | `hips` | `height` (strip) · `width` · `thickness` | a **cloth jeans belt loop** — a fabric strip arching over the waistband (matte; set `color` to match the pants). What **`addBeltLoops3D`** now drops (flush + pants-tracking). A **chain anchors to it** too |
| **button** | `chest` | `width` (radius) · `thickness` (proud) · `metalness`/`roughness` | a **clothing button** — a domed disc with a dished centre, facing OUT. Default slightly metallic (jeans button); drop `metalness` for plastic. **Surface-pin / ghost-preview it** onto the placket/fly |

```ts
interface AttachmentParams {
  type: 'chain'|'pocket'|'pendant'|'bracelet'|'watch'|'choker'|'clip'|'flower'|'loop'|'beltloop'|'button';
  color: string;
  linkCount: number; span: number; sag: number; thickness: number;   // chain: linkCount=length, thickness=wire radius (small!), span/sag=lean. (thickness also = band width for bracelet/choker/watch)
  chainMode?: 'dangle' | 'swag';                                      // chain: dangle (hangs + swings) | swag (draped catenary A→B)
  endJoint?: string;                                                  // chain swag: anchor the FAR end to a DIFFERENT joint (hip→thigh tracks the leg). Unset = same joint
  endOffset?: [number, number, number];                              // chain swag: the far end's offset (relative to endJoint if set, else the anchor)
  swagSoftness?: number;                                             // chain swag: deepens the SAG (0 = taut … 1 = deep droop). Swag is rigid + both-ends-pinned + draped on the garment
  fromLoop?: string;                                                 // chain: start AT a loop charm (its id) instead of joint+offset — connects to + tracks the loop
  toLoop?: string;                                                   // chain: connect the END to a loop charm (auto-swag) → a wallet chain strung loop→loop
  width: number; height: number; flap: number;                        // pocket / watch face / clip / flower
  dropLength: number;                                                  // pendant
  position?: number;                                                  // WRAP types (bracelet/watch/choker): 0..1 slide along the limb (replaces offset/scale)
  metalness?: number;                                                 // PBR: 0 = dielectric … 1 = chrome. Metal types default to 1, pocket/flower to 0
  roughness?: number;                                                 // PBR: 0 = mirror … 1 = matte. Metal default ~0.28
  sparkle?: boolean;                                                  // ✨ procedural twinkling micro-glints ("glisten in the light"). Default off
}
```

### Material (what it's made of)
Charms are **PBR-shaded**, so they react to light by material, not all the same. The **metal types** (chain · loop · bracelet · watch · choker · pendant · clip) default to **shiny metal** (`metalness 1`, low `roughness`) — a chain reads as a chain, reflecting the surroundings; **`pocket`/`flower`/`beltloop` default to matte** (cloth); **`button`** is low-metal (jeans-button look — raise/drop `metalness`). `color` **tints the metal** (a yellow colour = gold, light grey = silver/steel, dark = gunmetal). Optional **`metalness`** (Metallic) + **`roughness`** (0 glossy … 1 matte) sliders fine-tune the finish — e.g. drop `metalness` to 0 for a matte-black rubber cord, or a "Finish" preset dropdown (Chrome / Gold / Gunmetal / Matte). *(Best with the **default/PBR** render style; cel/gouraud styles shade flatter by design.)*

**✨ Sparkle (glint):** an optional **`sparkle`** boolean adds procedural **twinkling micro-glints** — sparse pinpoints that flash as the camera/light move and twinkle over time, so metals *glisten*. A simple **"Sparkle ✨" checkbox** per charm (writes `params.sparkle` → `setAttachmentParams3D`), **or** one character-wide toggle: `shapeManager.setCharacterSparkle3D(bodyMeshId, on)` (flips it on every metal charm at once). It **twinkles during any motion** (orbit / the idle animation / spring) and scintillates as you rotate; on a fully static, idle-off character the glints sit still (still sparkly, just not animated). Default off.

### Chain modes
- **`dangle`** (default) — links hang from the single anchor and **swing** (spring bones). `linkCount` = length, `span`/`sag` = a slight sideways/forward lean at rest.
- **`swag`** — a **catenary draped between two points** (the wallet-chain look): **A** = the anchor (joint + `offset`), **B** = the far end. **BOTH ends are pinned (rigid)** and the curve is **draped onto the equipped garment surface** at build time, so it rests ON the real (baggy/wrinkly) pants instead of clipping — and it's identical in and out of armature mode. It droops below the chord by a **`span`-driven depth** (`sag` adds a little); link density auto-fills from `thickness`, so **`linkCount` is ignored**. Two knobs shape it:
  - **`endJoint`** — where the **far end** is anchored:
    - *unset* (default) → both ends ride the **anchor joint** (B = `A + endOffset`); the whole drape moves rigidly with the hip — a belt-loop→pocket chain on one hip.
    - *set to another joint* (e.g. `upperleg_R`) → the far end tracks **that** joint (B = `endJoint.pos + endOffset`); each link blend-skins anchor→endJoint along its length, so a **hip→thigh** chain **stretches/bends as the leg moves**. Offer a joint dropdown (same list as the anchor) + an "— (same joint)" option.
    - `endOffset` places the far end relative to whichever joint applies (a drag-handle or x/y/z sliders).
  - **`swagSoftness`** (0…1) — **deepens the SAG** (a looser drape): 0 = taut, 1 = a deep droop. (The swag is rigid + both-ends-pinned, so this is the sag depth, not a physical sway — a one-rooted spring can't pin both ends, so its far tip droops free.) A "Sag" slider.

### Loops / D-rings + connecting chains
A **`loop`** charm is a small D-ring you place on the body/garment (joint + offset, like a pocket). On its own it's decoration; its real job is to be a **named anchor a chain clips to**, so a chain connects to a *specific spot* (not just a joint).
- A **chain** has `fromLoop?` / `toLoop?` (loop **ids**):
  - `fromLoop` → the chain's **start** rides that loop (instead of its own joint+offset).
  - `toLoop` → the chain's **end** clips to that loop and the chain auto-becomes a **swag** strung between the two.
  - The chain **inherits the loops' joints**, so when the loops (or the body) move, the chain **tracks them** — a real connection, not just a coincidence of position. Delete a referenced loop → the chain falls back to its own placement.
- **Belt loops:** `addBeltLoops3D(bodyMeshId, count)` drops a row of **cloth jeans belt loops** (`beltloop`) — sampled **flush onto the equipped pants waistband** and **pants-tracking** (they re-derive + follow when you tweak the pants). Returns their ids. Then string a wallet chain between two of them.
- **EASIEST chain UX (recommended): `beginChainPick3D`** — click two points on any garment/body and a chain is strung between them, draped onto the cloth. No hoops, no xyz offsets, no loop ids to manage. Click A → click B → repeat. This is the preferred flow over `fromLoop`/`toLoop` + offsets.
- **UI:** a **"⛓ Draw chain"** button → `beginChainPick3D` (show a "click start → click end" prompt via `onProgress`); a **"+ Belt loops"** button → `addBeltLoops3D`. The `fromLoop`/`toLoop` + Start/End joint pickers remain for precise/manual control.

---

## 5. Notes
- **Poses with the body** automatically (skinned 100% to the anchor joint) and **re-anchors** when the body shape changes — nothing to wire.
- **Persists** with the document (params + placement; the mesh regenerates on load) and rides the `.frogmarks` export — like the other rigs.
- **Picking** any charm selects the **body** (so the character stays the selection target).
- **Many per body** — keep your own ordered list of `id`s (seed it from `listAttachments3D` on open).
- ✅ **Draping + dangle:** every chain (and the pendant) is **draped onto the EQUIPPED GARMENT surface** at build time, so it rests ON the real (baggy/wrinkly) pants/shirt instead of clipping — no body-margin guessing. A **`dangle`** chain additionally **swings** when posed/animated (each link is a spring bone hanging from the anchor, colliding off pants-sized body capsules; see `docs/ui/armature.md` → Spring Bones). A **`swag`** chain and the **`pendant`** are **rigid** (both-ends-pinned / pinned-flat), so they stay put and read identically in and out of armature mode. (bracelet · watch · choker · clip · flower · pocket · button · beltloop are rigid too.)
- **Why a dangle chain "stops short":** a `dangle` chain is pinned at ONE end and hangs free to its length (`linkCount` × link size), so the bottom just ends in space — that's by design. For the looped wallet-chain look, give it a **second anchor**: `chainMode: 'swag'` (drape between two points) or **connect it to a loop** (`toLoop`). Or raise `linkCount` to hang it longer.
- ✅ **Surface-pin placement** (click a garment/body to drop a charm exactly where you tap) — `beginAttachmentPlacePick3D` (see §6). It resolves the tapped point to that surface's **dominant skin joint + offset**, so the charm follows that region (a loop dropped on the thigh tracks the thigh). Pin in the **neutral/rest pose** (picking is against the rest geometry).

---

## 6. Placement: ghost preview (recommended) + click-to-drop
**Ghost preview (recommended):** when a charm type is selected, call `showAttachmentPreview3D(bodyMeshId, type)` — a **translucent ghost** appears at the type's default spot (e.g. Choker → the neck) and **follows the cursor** as the user hovers the body. **"Add"** → `commitAttachmentPreview3D()` spawns the real charm where the ghost is; deselect/close → `hideAttachmentPreview3D()`. Live-tweak colour/size or switch type with `updateAttachmentPreview3D(params?, type?)`. This is the smoothest flow — the user sees exactly where it'll land before committing.

**Click-to-drop (for dropping several):** click it directly onto the body/garment instead of dialing offsets.

```ts
shapeManager.beginAttachmentPlacePick3D(bodyMeshId, 'loop', {
  onPlaced: (id) => { myList.push(id); },               // fires per click — a new charm id
  onHover:  (world) => { showGhost(world); },           // optional: world point under the cursor, or null off-body
});
// … user clicks the model (drop as many as they like) …
shapeManager.endAttachmentPlacePick3D();                // when they click "Done" / switch tools
```
- **Each left-click on the body/garment drops a `type` charm** at that point and calls `onPlaced(id)`. The mode **stays active** so the user can drop several (great for belt loops / patches). Clicks that **miss** the model, **alt**-drag (orbit) and middle/right (pan) pass through normally.
- It resolves the hit to the surface's **dominant skin joint + a rest-pose offset**, then spawns a normal joint-anchored charm — so it **persists, re-anchors, and poses** like any other (a loop on the jacket back follows the spine).
- **⚠️ Do it in the neutral/rest pose** (armature/posing OFF). Picking tests the rest geometry, so on a posed body the drop point won't line up with what's on screen.
- **UX:** a "📍 Place on model" toggle next to **+ Add**. While on, show a hint ("click the model to drop a {type}; Esc/Done to finish") and call `endAttachmentPlacePick3D()` on Esc / toggle-off / panel close. Pair with the loop type for "drop belt loops wherever," then string a chain between two of them (`fromLoop`/`toLoop`).
