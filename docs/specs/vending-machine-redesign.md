# Vending machine redesign — 3D cans + a packed label sheet

**Status:** ✅ BUILT 2026-09-29 (browser-unverified; CPU-preview-verified with `VENDING_PREVIEW=<png> npx vitest run
src/world/vending-preview.test.ts`).

Also found and fixed while building:
- **The body unwrap was mirrored on every face**: u ran viewer-right → left. The regions are unchanged; only the
  direction inside each face flipped.
- **The front "right" axis was the viewer's left**: the control column sat on the wrong side, and the box basis was
  left-handed.
**References:** the Persona 4/5 machines (the look to match), plus the illustrated businessman scene (worldbuilding
through graphics).
**Replaces:** the box-and-boxes machine in `src/world/vending.ts`.

## Goal

One style of machine, a Japanese street *jihanki*, that reads as a vending machine from the city's distance and up
close. The user reskins it with their own art:
- **logos and graphics** UV-painted or dropped onto the **body**;
- **their own can designs**: separate PNGs that Salsa packs into one label sheet;
- optionally a **backdrop image** behind the cans (or instead of them).

No toy/rounded variant.

## Anatomy

Front of the cabinet. Heights are a fraction of the machine's height H, measured from the floor. Widths are a
fraction of its width W, measured from the centre.

| Part | Where | Built as | Material |
|---|---|---|---|
| Plinth | y 0–0.04, slightly inset | merged box | dark trim metal |
| Pickup bay | y 0.07–0.19, x −0.30…+0.22 | recessed dark opening + a frame + a flap | trim / chrome |
| Lower art panel | y 0.20–0.40 | the **body texture** (nothing on top) | body skin |
| Control strip | y 0.41–0.50, right side | coin slot, bill slot, return lever (chrome), a small LED display (emissive) | chrome / buttons |
| Product window | y 0.53–0.95, x ±0.44 | frame bars protruding to the glass depth | trim |
| ↳ backdrop | the window's back wall | the **`products` slot** (instanced, emissive) over the lit glow backing | products skin |
| ↳ shelves | `shelves` rows (default 3) | a shelf lip under each row + a light strip under the shelf above | trim / glow |
| ↳ price strip | the front of each shelf | a light strip + one glowing button per can | strip / buttons |
| ↳ cans | `cansPerShelf` per row (default 8) | **instanced 3D cans** textured from the **`labels` sheet** | labels skin |
| ↳ glass | the front of the window | one pane | glass |

The body shell keeps today's **six-face unwrap** (`VENDING_BODY_UV_REGIONS`, pool contract v2). Existing body skins
painted against it stay correct: the front region still covers the whole front, and the window and control parts
cover their areas of it. The header, lower art panel, sides and top are the paintable brand surfaces.

## Stock: 3D cans from a packed label sheet

- **The sheet is one GARP texture**, slot `labels`, at 512×512 like every GARP texture. It is a **4×2 grid of 8
  cells**, each 128×256 px (a can's front view, 1:2).
- Each cell has a **silver rim band** at the top, which the can tops and necks sample, and the **label** below it.
- Cells are **padded**: art is drawn inset, with its edge pixels extended into the gap, so filtering never bleeds a
  neighbour's label into a can.
- **Each can samples one cell.** Its front half shows the label across the cell's width; the back mirrors it.
- **Variety:** the city builds 4 can-arrangement variants (cells assigned by seed per slot), and each machine
  instances one of them by position hash. Machines on the same street show different mixes of the same skin's
  drinks.
- **Cost:** a can is 8 sides plus a neck ring and a top cap, 40 triangles. 3×8 cans ≈ 960 triangles per machine,
  instanced, so hundreds of machines stay a handful of draws.

### The packer (images → sheet)

`sm.packVendingCanLabels3D(skinName, images)` takes 1–8 image data URLs, one per can design, and:
1. **fits each image to its cell** (stretched to the label area; author at 1:2 for no distortion — any size is
   accepted, and sizes need not match);
2. repeats the list to fill all 8 cells if fewer are given;
3. draws the rim bands and padding;
4. registers the sheet as the skin's `labels` texture and rebuilds the atlas.

A generic `sm.packGarpSheet3D(images, cols, rows, size)` returns the sheet's data URL for other props (books,
snacks).

### Templates

`sm.garpSlotRegions3D('salsa/vending', 'labels')` returns the 8 cell rects, so the host can overlay the grid on an
authoring canvas. `sm.vendingLabelTemplate3D()` returns a PNG data URL of a blank template: cells, rim bands and a
safe area.

## Backdrop (`products` slot) and stock modes

`stock: 'cans' | 'image'` (default `'cans'`):
- `'cans'`: the `products` image is the **lit back wall** behind the cans (default placeholder: a soft white wall).
- `'image'`: no cans. The `products` image is the whole display, the flat Persona 4 look (for snacks or anything
  that isn't a can).

The city uses `'cans'`.

## Correctness fix: one skin per machine

A skin is picked per **instance position** (`pickSkin(x, z)` on a ~23 cm grid). The products panel's instance was
placed ~30 cm in front of the body's origin, so **a machine's body and products could pick different skins**, which
breaks GARP's rule. Every per-machine instanced part (body, backdrop, cans) now has its origin at the **machine's
foot**, with its offset built into the geometry, so all of them pick at the same (x, z).

## Pool upgrade (without losing user skins)

The pool gains the `labels` slot plus a default (placeholder can sheet). `addSkin` bumps a pool's version on every
added skin, so **version can't detect** a saved pool that predates `labels`. The upgrade checks for the slot
instead: a registered vending pool without `labels` gets the slot and the default added **in place, keeping every
skin**. Skins without their own `labels` use the default sheet.

## Params

New fields on `VendingParams`:
- `shelves` (1–5, default 3);
- `cansPerShelf` (2–12, default 8);
- `stock` (`'cans' | 'image'`).

The old `productCols` / `productRows` are kept for old saves but no longer drive the shape.

## Later (not in this build)

- **Night light pool**: soft glow on the ground in front, with a radial fade.
- **Bottles** as a second stock shape.
- **Bevelled cabinet edges** (changes the body unwrap → pool v3 + a skin remap).
- **Bigger side regions** in the unwrap, for large side logos (same v3 change).
- **Detail levels**: drop cans to the flat backdrop when far.
- **Frogmarks UI**: a "Can designs" list (add/remove PNGs → `packVendingCanLabels3D`) and the template download.
