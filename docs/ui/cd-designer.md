# CD Jewel-Case Designer — Frogmarks UI Integration Guide

**Audience:** Frogmarks (Angular host) developers wiring the CD-designer panel (component dropdown, scrub slider, upload, order).
**Date:** 2026-08-27 · **Engine spec:** [../specs/cd-jewel-case-designer.md](../specs/cd-jewel-case-designer.md) · **Siblings:** [package-designer.md](./package-designer.md), [cinematic-cameras.md](./cinematic-cameras.md) (for the spin/export share video).
**Status:** engine built (browser-unverified). The engine owns the 3D kit, the assembly scrub, isolation/framing, and art upload; **you** own the panel, dropdown, slider, file picker, and order flow.

---

## 0. The model in one line

A **CD kit** is the whole product — case + disc + front insert + tray card + booklet — as one 3D object with **one scrub** (closed → lid opens → exploded). The **component dropdown** switches between **Complete** (the whole assembly you scrub) and each **printed piece** (isolated + framed flat so the user drops art onto it).

```
enter designer → [Complete ⇄ Front insert ⇄ Tray card ⇄ Disc ⇄ Booklet] → upload art → scrub open → spin → export
```

Everything reuses the 3D editor + the cinematic-camera export.

---

## 1. The API surface (all on `sm` = the ShapeManager)

### Create / lifecycle
| Call | Effect |
|---|---|
| `sm.createCDKit3D(x?, y?, z?, { clearTray? })` → `{ rootId, pieces }` | Build the whole kit at a point. `pieces` maps each piece id (`lid`/`trayBack`/`disc`/`frontInsert`/`booklet`/`trayCard`) → its node id. `clearTray: true` = all-clear case (vs the classic black tray). |
| `sm.setCDTrayClear3D(rootId, clear)` / `sm.isCDTrayClear3D(rootId)` | Toggle / query the tray style (black ⇄ all-clear) at runtime. Persists. |
| `sm.setCDTrayCardFold3D(rootId, fold)` / `sm.getCDTrayCardFold3D(rootId)` | Fold the tray card's two spine flaps (0 flat → 1 folded 90° to wrap the case sides). In **Complete** the flaps auto-straighten with the open scrub; in **Tray Card** view it's flat by default with this as its own fold slider. |
| `sm.deleteCDKit3D(rootId)` | Delete the kit (also exits the designer if it was active). The Outliner X on the kit routes here automatically. |
| `sm.enterCDDesigner3D(rootId)` → bool | Enter the designer: 3D on, scene isolated to the kit, framed, starts on **Complete**. |
| `sm.exitCDDesigner3D()` | Leave: restores the assembly + the rest of the scene. |

### Component dropdown + scrub
| Call | Effect |
|---|---|
| `sm.setCDActiveComponent3D(component)` → bool | Switch the active component. `component`: `'complete' \| 'frontInsert' \| 'trayCard' \| 'disc' \| 'booklet'`. **Complete** shows the whole assembly (scrub live); a **piece** hides the others, lays that piece flat-on, and frames it for upload. |
| `sm.getCDActiveComponent3D()` → component \| null | The current component (for the dropdown's value). |
| `sm.setCDKitScrub3D(rootId, t)` → bool | Drive the Complete assembly: `t` 0 = closed → lid opens → 1 = exploded. (Only meaningful in Complete.) |
| `sm.isCDDesignerActive3D` / `sm.getCDDesignerRootId3D()` | Designer on? / which kit. |

### Art upload (the priority path)
| Call | Effect |
|---|---|
| `await sm.setCDPieceArt3D(rootId, piece, source)` → bool | Map an uploaded image onto a printed piece. `source` = `File`/`Blob`/`ImageBitmap`. Persists across save/reload. |
| `sm.getCDActivePieceNode3D()` → nodeId \| null | The node id of the piece currently being edited (null in Complete) — handy if you drive uploads off "the active piece". |

`CDComponent`, `CD_EDITABLE_COMPONENTS`, `CD_ALL_PIECES`, and `cdComponentView` are exported from `@zaings/salsa` for populating the dropdown.

### Print export (the order deliverable)
| Call | Effect |
|---|---|
| `await sm.exportCDKitPrintSet3D(rootId, { marks?, dpi? })` → `[{ piece, blob, widthMm, heightMm, dpi }]` | Render **all four** printed pieces to print-ready **PNG blobs** at their exact dieline size (default 300 DPI). **You** mux these into a print PDF (jsPDF / a print service). |
| `await sm.exportCDPiecePrint3D(rootId, piece, { marks?, dpi? })` → `Blob \| null` | One piece's PNG (null for a non-printed piece / missing kit). |

- `marks: false` (default) = **clean print art** at exact size. `marks: true` = a **proof** with crop / fold / bleed / safe marks drawn on. Export clean art for the printer; use marks for an on-screen proof or a "review before order" preview.
- Each result carries `widthMm` / `heightMm` / `dpi` so you can place it 1:1 on a PDF page.
- `cdPrintSpec(piece, dpi)` (exported from `@zaings/salsa`) gives you the sizing + marks **without** rasterizing — useful for laying out the order/preview UI or drawing your own proof.

---

## 2. Minimal wiring

```ts
// Open a CD designer — clearCase gives the all-clear case; omit / false = the classic black tray
newCdBtn.onClick = () => {
  const { rootId } = sm.createCDKit3D(0, 0, 0, { clearTray: caseStyle === 'clear' });
  currentKit = rootId;
  sm.enterCDDesigner3D(rootId);
  buildDropdown(['complete', ...CD_EDITABLE_COMPONENTS]);   // Complete + the 4 pieces
};

// CASE STYLE toggle — black tray ⇄ all-clear (works any time; persists)
clearCaseToggle.onChange = (isClear) => sm.setCDTrayClear3D(currentKit, isClear);

// Component dropdown
componentDropdown.onChange = (c) => {
  sm.setCDActiveComponent3D(c);
  scrubSlider.disabled     = (c !== 'complete');    // open/explode scrub is only live in Complete
  uploadBtn.disabled       = (c === 'complete');    // upload targets a piece
  foldSlider.style.display = (c === 'trayCard') ? '' : 'none';   // the fold slider is Tray-Card-only
};

// The scrub (Complete view) — opens the case, explodes the pieces, and straightens the tray-card flaps
scrubSlider.onInput = (t /* 0..1 */) => sm.setCDKitScrub3D(currentKit, t);

// Tray-card fold slider (Tray Card view only) — flat by default, fold the two spine flaps
foldSlider.onInput = (f /* 0..1 */) => sm.setCDTrayCardFold3D(currentKit, f);

// Upload art onto the current piece
uploadInput.onChange = async (file) => {
  const c = sm.getCDActiveComponent3D();
  if (c && c !== 'complete') await sm.setCDPieceArt3D(currentKit, c, file);
};

// Done
doneBtn.onClick = () => sm.exitCDDesigner3D();

// Order → print-ready files (you mux to PDF + send to fulfillment)
orderBtn.onClick = async () => {
  const set = await sm.exportCDKitPrintSet3D(currentKit);   // clean art, 300 DPI
  // set = [{ piece, blob, widthMm, heightMm, dpi }, ...]
  const pdf = await muxToPrintPdf(set);   // YOUR code: place each blob 1:1 at widthMm×heightMm
  await submitOrder(pdf, orderDetails);   // YOUR checkout + fulfillment
};
```

### Share video (the marketing hook)
In Complete, keyframe the scrub open + orbit and export a clip with the cinematic-camera API (see [cinematic-cameras.md](./cinematic-cameras.md)) — the "look what I made" moment.

---

## 3. Rules & gotchas

- **Complete vs piece.** Complete = the whole assembly, scrub live, no upload target. A piece = only that piece shows, laid flat-on and framed, and it's the upload target. Reflect that in your slider/upload enabled-state (or read `cdComponentView(component)` client-side: `.scrubEnabled`, `.focusPiece`).
- **The case isn't a component.** `lid` / `trayBack` are the plastic shells — not in `CD_EDITABLE_COMPONENTS`, not upload targets. Only front insert / tray card / disc / booklet take art.
- **Upload is the priority path.** Most users drop a finished image; painting onto the pieces is a later phase. `setCDPieceArt3D` maps the image onto the piece (disc uses a circular label UV so a square label lands correctly).
- **Case style (black ⇄ all-clear).** The tray is the classic **black** by default; pass `{ clearTray: true }` to `createCDKit3D`, or flip it live with `sm.setCDTrayClear3D(rootId, true/false)` (query with `isCDTrayClear3D`). It re-materialises just the tray and persists — expose it as a simple toggle.
- **Tray-card flaps fold.** The tray card has two spine flaps that wrap the case sides. In **Complete** they auto-straighten with the open scrub (folded closed → flat at 100%). In **Tray Card** view it's flat by default with its own fold slider (`setCDTrayCardFold3D`).
- **Persistence is automatic.** The kit (structure + scrub + case style + tray-card fold) and the uploaded art all survive save/reload — you don't persist anything CD-specific yourself. The **active component** is transient (designer UI state); re-enter on Complete.
- **Isolation is handled.** Entering the designer hides the rest of the scene and frames the kit; exiting restores everything. Don't toggle scene visibility yourself.
- **Deleting.** The Outliner X on the kit, or `deleteCDKit3D`, both tear it down cleanly (and exit the designer if active).
- **Units / dimensions** are real: front insert 120×120 mm, tray card 150×118 mm, disc 120 mm Ø / 15 mm hole. These are fixed for print correctness — the `CD_*` metric constants are exported if you need them for the order/preview UI.

---

## 4. Suggested panel layout

- **Component dropdown** (top): Complete · Front insert · Tray card · Disc · Booklet.
- **Case style toggle** (near the top, always visible): Black tray ⇄ Clear case → `setCDTrayClear3D`.
- **Complete view:** the open/explode **scrub slider** + an "Export clip" button (cinematic camera).
- **Tray Card view:** the **fold slider** (flat ⇄ folded flaps) alongside the upload zone.
- **Piece view:** a **file drop / upload** zone (→ `setCDPieceArt3D`), a fit/replace control, and the piece's real dimensions + a bleed/safe hint.
- **Order bar:** quantity, add-ons (charms/stickers), checkout — all host-side.
