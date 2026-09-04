# CD Jewel-Case Designer → print & fulfillment (product spec)

**Date:** 2026-08-26 · **Status:** planned (spec only) · **Companions:** `packaging-system.md` + `packaging-templates.md` (the fold-box engine this extends — BUILT), `advanced-shaders.md` (§3 glass = the plastic), `free-camera-and-scene-targets.md` + `cinematic-cameras.md` (the spin/preview/export marketing hook), `decals.md`/`ephemera-system.md` (charms/stickers upsell), `docs/ui/package-designer.md`.

## The pitch in one line

A web CD-designer where a user designs the **case, cover/tray art, disc face, and booklet** in Salsa's editor, previews it as an **animated transparent jewel case they can open and spin**, and orders a **physically assembled, printed, (optionally burned), shrink-wrapped CD** — with Frogmarks charms/stickers as add-ons.

## Why this is the most feasible product to ship now

It's **assembly, not invention**. Every hard subsystem already exists:

| Product piece | Reuses (already built) |
|---|---|
| Jewel case that opens/closes | The **Package Designer** fold-box engine (`src/packaging/`): `BoxStyle` + templates, `foldAmount` 0→1 **tweened fold/unfold** (`PackagingManager.fold/unfold`) — the open/close animation is literally the existing hinge scrub |
| Transparent, slightly reflective plastic | **Glass material**, `advanced-shaders.md` §3 P1 (frosted/tinted Fresnel) — no refraction needed for MVP |
| Cover / tray / disc / booklet art | The **illustration + raster + vector editor** (Salsa's core) + the Package Designer **layer stack** + **live-texture dieline→panel** (draw flat, it wraps onto the 3D piece 1:1) |
| Print-ready output | Package Designer's **dieline PNG export** + **print pipeline** (its declared next milestone in `packaging-templates.md`) |
| "Show off my CD" | **Free-cam + cinematic cameras**: spin it, open it, **export a video/still** — the shareable marketing artifact, already built |
| Charms / stickers in the package | Existing **charms**/**ephemera**/**decals** systems as physical add-ons |

**The engineering is the cheap 20%. The expensive/risky 80% is physical fulfillment + print correctness + legal — none of it code.** This spec scopes the tool tightly and is explicit about the non-engineering risks so the product plan is honest.

---

## 1. The pieces to design (and their real-world dielines)

A standard CD jewel case has **fixed dimensions** — the tool's core credibility is that artwork lands on-spec. Enforce these as the templates:

| Piece | Standard size | Notes / safe zones |
|---|---|---|
| **Front cover / booklet cover** | 120 × 120 mm (booklet), commonly 121 × 120 | Front of a folded booklet; add bleed 2–3 mm, safe margin ~4 mm |
| **Tray card (J-card / inlay)** | 150 × 118 mm flat, with **two 6 mm spine folds** | The back+spines behind the tray; spine text reads on the shelf — a specific 3-panel fold |
| **Disc face** | 120 mm Ø, **center hole 15 mm**, non-printable **stacking ring ~23–38 mm** | Circular canvas with a **locked center safe zone**; art must not enter the hub |
| **Booklet interior** | 120 × 120 mm pages, **saddle-stitch → multiples of 4 pages** | MVP: a single 4-panel (front/inside-L/inside-R/back). Phase 2: N-page booklet |

**Engine implication:** each is a **new packaging template** (like `tuck-end.ts`/`rigid-two-piece.ts`) — a panel/fold layout + UV regions + guide lines (cut/fold/bleed/safe already exist as editor overlays). The **disc** is the one non-box piece: a circular dieline with a center-hole mask (a small new "disc" template, not a fold).

**Front vs. back = two separate pieces (not one sheet):**
- **Front art = the front insert / booklet cover** — sits under the clear lid; a separate sheet (front face; its reverse = inside-front, optionally printed).
- **Back art = the tray card (inlay/J-card)** — **one** sheet, but with the back panel **+ two spine flaps** that fold forward (the shelf-spine title). A single *folded* sheet, its own piece.

---

## 1.5 The multi-component "kit" model (the one new architectural idea)

A CD product isn't one package — it's a **kit of pieces**, each with its own dieline + its own uploaded/painted art:

| Piece | Kind | Paintable? |
|---|---|---|
| **Case** | fixed glass geometry | No — it's the plastic (glass material) |
| **Front insert / booklet cover** | printed dieline (flat or folded) | Yes |
| **Tray card (back)** | printed dieline (1 sheet, 2 spine folds) | Yes |
| **Disc** | fixed disc geometry + circular masked dieline face | Yes (the label face) |
| **Booklet interior** | printed multi-page dieline | Yes (P1 single fold → P2 N-page) |

**Model it as a thin container over the existing per-piece machinery.** The `PackagingManager` already tags layers per-package (`packageOwnerId`) and supports multiple coexisting packages, so a **`CDKit`** = a `productId` owning an ordered list of piece-packages **+ an assembly transform per piece** (for the Complete/exploded view). Each piece reuses the existing dieline / layer-stack / live-texture-onto-panel path; the kit just groups them and lays them out in 3D. **This grouping is the only genuinely new concept — everything below the piece is reuse.**

A "piece" is one of two shapes, both uniform in the kit:
- a **printed dieline** (front / tray / booklet) → reuse the fold-box templates; or
- a **fixed object with a mapped face** (disc = circular dieline; case = no art).

---

## 2. The jewel-case 3D model

A new `BoxStyle` = `'jewelCase'` (extend the union in `packaging-manager.ts:357`) with a template that builds:

- **Base tray** (opaque, usually black/clear/frosted) that holds the disc + has the tray card behind it.
- **Lid** hinged along one edge — its rotation is driven by the existing `foldAmount` tween (0 = closed, 1 = open ~110°). **This is the "animated open/close" for free.**
- **Front cover pocket** holding the booklet (front art visible through the clear lid).
- **The disc** on the hub (optionally animated: lift/spin).
- Plastic panels use the **glass material** (frosted-clear, slight Fresnel reflection); the printed pieces (booklet/tray/disc) use the normal **live-textured** panels.

> The hinge/fold hierarchy + tweened motion + contact shadow + studio stage/lighting are all already in the Package Designer — the jewel case is a new *rigid-panel hierarchy* fed into the same machinery, not new animation code.

---

## 3. The design flow (what the user does)

1. Enter **CD Designer** mode (a Creator mode, like Package/Char creators).
2. A **component dropdown** switches the active view/target:
   - **Complete** (default) — the whole kit assembled in 3D. The **scrub drives an open + exploded view**: 0 = closed case, → the lid opens and the disc/inserts/booklet slide out to reveal every piece. *This reuses the existing fold tween — instead of one hinge, the scrub interpolates each piece's assembly transform (same easing/scrub infra).* Not a paint target; it's the presentation/preview.
   - **Front insert · Tray card · Disc · Booklet** — selects that piece: the editor sizes to *its* dieline (Package Designer already sizes the doc to the dieline 1:1) and it becomes the paint/upload target. Edits live-texture back onto the piece in the Complete view.
   - **Case** — the plastic; no art (glass material), just a style/tint choice (clear/frosted/black/colored).
3. **Upload-first mapping (the priority path).** Most users drop in finished art, so the core interaction is: **place an uploaded image into the selected piece's print area** — fit/fill/crop/reposition/rotate, snapped to that piece's real **dieline + bleed + safe** guides — while the **full-res source is kept for print export** (the 3D preview shows a texture; export pulls the original). Painting is the same dieline (single source of truth), so upload + paint compose.
4. Full illustration toolset also applies — raster paint, vector, text (**LiveText** for crisp titles/tracklists), procedural patterns, ephemera/**charms**.
5. **Preview**: scrub the Complete view open, spin (free-cam), see art through the clear plastic.
6. **Order**: pick disc content option (§5), add-ons (charms/stickers), quantity → checkout.
7. **Export** a share video/still of the spinning/exploding case (cinematic camera) for social.

---

## 4. Print output (the product's credibility)

The deliverable to the printer, per piece:
- **CMYK PDF/X** at exact dieline size + **bleed** + crop marks + the **fold/cut/safe** guides (guides already computed for the editor overlay — reuse for the print marks).
- **Color:** the editor is RGB; print is CMYK. MVP: export high-res RGB + rely on the print partner's RGB→CMYK, but **warn on out-of-gamut neon** and show a "print may differ" proof. Phase 2: a soft-proof CMYK preview (a `render-style`/post grade approximating CMYK gamut).
- **Resolution:** rasterize dielines at **≥300 DPI** at physical size (the Package Designer export already produces the flattened stack PNG — pin its pixel size to `mm × 300/25.4`).
- **Disc:** export as the printer's disc template (circular, hub mask) — many use inkjet-printable or thermal disc printing; match their template.

**This section is where I'd spend the most tool effort** — a beautiful designer that prints wrong is worthless; a plain one that prints perfectly sells.

---

## 5. Fulfillment (the hard, non-engineering part — be honest)

Ordered roughly easiest→hardest; **start left, add right:**

1. **Design + digital delivery** (zero physical): sell the print-ready files / a digital "virtual CD" + the share video. Ships today, no logistics. *Good first revenue + demand test.*
2. **Print inserts only** via a print-on-demand partner; you or the buyer assembles. Low risk.
3. **Assembled case + printed inserts + printed disc (no data)** — you hand-assemble or use a duplication service; disc is a printed coaster/art object. Avoids all licensing.
4. **Burned data disc** — **the legal cliff.** Only with (a) user-uploaded content they attest they own, (b) original content, or (c) licensed catalog via a mechanical-license provider. **Do not burn arbitrary user audio without an ownership attestation + terms.** Flag to legal before this phase.
5. **Full: burn + assemble + shrink-wrap + charms + ship + returns.** A real light-manufacturing op — partner with a **CD duplication/fulfillment house** rather than building it in-house first.

**Risks to plan for (all non-code):** print color accuracy, per-order unit economics (short runs are pricey), shipping/breakage (jewel cases crack), returns, and the licensing wall at step 4. The tool is derisked; the *operation* is the venture.

---

## 6. Charms / stickers / Frogmarks upsell

- Physical **stickers** (die-cut from the sticker/ephemera art), **charms** (the existing charm system → physical trinket), a **Frogmarks-branded insert card**. All are add-on SKUs at checkout, designed with the same tools. Pure margin + brand.

---

## 7. Phasing / MVP

- **P0 — the demo (share-driven validation):** the `CDKit` container + component dropdown + `'jewelCase'` style + the **Complete-view open/exploded scrub** + glass material + **Front insert + Disc** pieces with **upload→dieline mapping** + the spin/export video. No commerce. Prove the "look what I made" share loop. *Almost entirely assembly of built systems + the one new kit container.*
- **P1 — sellable digital + print files:** add **Tray card** + **single-fold booklet** pieces; **300-DPI per-piece PDF export** with marks; checkout selling files / assembled-no-data cases via a print partner (§5 step 1–3).
- **P2 — physical assembled product:** fulfillment-partner integration, disc printing, charms/stickers add-ons, packaging/shipping, the CMYK soft-proof.
- **P3 — burned discs (post-legal):** ownership attestation, licensed-content path, data-burning at the duplication house; N-page booklet; multi-disc/digipak variants.

## 8. Engineering work items (the actual code)

Small, because it's assembly:
1. **`CDKit` container** — the one new concept (§1.5): a `productId` grouping N piece-packages + a per-piece **assembly transform**, laid out in 3D. Reuses per-package dieline/layer-stack/live-texture wholesale; adds grouping + the Complete-view layout. The **component dropdown** selects the active piece (or Complete).
2. **Exploded/open scrub** — drive each piece's assembly transform off the existing fold `foldAmount` tween (closed→open→exploded). Reuses the tween/easing; new = the per-piece transform curves.
3. `'jewelCase'` `BoxStyle` + template (`src/packaging/templates/jewel-case.ts`) — hinged lid + tray + clear panels, fed into the existing fold engine.
4. **`'disc'` circular template** with center-hole safe mask (new, small — a masked round dieline, not a fold).
5. **Upload→dieline mapping** — place/fit/crop/reposition an uploaded image into a piece's print area, snapped to bleed/safe, **retaining the full-res source for export** (preview = texture, export = original). The priority UX item.
6. **Glass material** (advanced-shaders §3 P1) on the plastic panels.
7. **300-DPI CMYK-ish print export** = extend the Package Designer's stack-PNG export to **per-piece** PDF at physical size + crop/fold/bleed marks (reuse the guide computation); pull upload sources at full res.
8. A thin **CD Designer Creator mode** wrapping the kit (mirrors Package/Char creator lifecycle).
9. **Booklet** = a multi-page dieline (P1 single fold; P2 N-page) — template + page-navigator.
10. Checkout/commerce + fulfillment integration = **host-side (Frogmarks)**, not engine.

## 9. Not doing (this spec)

- The commerce backend, payment, fulfillment-partner API, licensing system — host/business, separate specs.
- Digipak / cardboard-sleeve / vinyl / cassette variants (P3+ — but they're *more* Package Designer styles, so cheap later).
- True refraction/caustics on the plastic (advanced-shaders P2+; frosted Fresnel is plenty for MVP).
- In-house data burning / disc printing hardware (use a duplication partner).

---

### Bottom line
The **designer + preview + print-file** product (P0→P1) is a **small, high-confidence build** on top of the Package Designer + illustration editor + glass material + cinematic export — all built. It's genuinely shippable soon. The **physical fulfillment + legal** (P2→P3) is the real venture risk and should be de-risked with partners and an ownership-attestation gate, not more engineering.
