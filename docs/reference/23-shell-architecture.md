# 23 — Shell Architecture (WebGPU Dashboard / "Console OS")

**Last Updated:** 2026-06-12
**Status:** Phases 1–3 built and **browser-validated** (shell renders + state + document integration + readiness signal). Canvas model evolved to **per-route canvases sharing one device** (see below). 3D tile forms added — coins for system apps, CDs for carts. Cart install (Phase 4) and launch (Phase 6) not built.

This doc explains how the Shell UI fits into the engine as a whole — the overarching architecture, the layers, and the "who owns the GPU surface" lifecycle. For *design intent* see [specs/shell-ui.md](../specs/shell-ui.md); for the *Frogmarks integration contract* see [ui/shell-ui.md](../ui/shell-ui.md); for the *API listing* see [11 — Services & Managers §ShellUIManager](11-services-managers.md).

---

## The core idea

The WebGPU renderer did **not** grow into an OS. Instead we added a thin **orchestration layer above it that shares its GPU surface**. The editing engine (`WebGPURenderer`) is almost untouched — it gained a few read-only getters and a readiness promise, nothing more.

So the relationship is the inverse of "the engine became a shell": **a shell now orchestrates the engine** (and, later, other runtimes) on a single shared canvas. The "OS-ness" lives entirely in `ShellUIManager`, not in the renderer.

The whole system reduces to one principle:

> **One `GPUDevice`, with runtimes taking turns owning the render loop, coordinated by the shell.**

That is exactly the model a game console uses: a home screen and games/apps that take over the display and hand it back. The cartridge metaphor is not decoration — it is the literal architecture.

> **Canvas model (revised 2026-06-12).** We first tried a *single persistent `<canvas>`* shared by shell + editor (host canvas in `AppComponent`). In practice that coupled the two renderers hard and caused white/black-screen bugs — a dropped on-demand repaint when the rAF loop was live (`scheduleRender` never set `needsFrame`), plus a missing post-load layout refresh on a full-viewport canvas that never fires a resize. We reverted to **per-route canvases that share the one device**: the editor canvas lives in the illustration route, the shell canvas (`shellCanvas`) in the studio route; only one is mounted at a time, and the singleton renderer moves between them via `reinitialize` / `initializeScene`. The "shared device, runtimes take turns" invariant holds — the *canvas* is just no longer persistent.

---

## The layer stack

```
┌─ HOST (Frogmarks / Angular) ──────────────────────────────┐
│  FrogmarksStudioComponent (persistent, route '')           │
│    owns the <canvas>, constructs ShapeManager,             │
│    awaits whenWebGPUReady(), toggles shell ↔ editor        │
│    + thin HTML overlays (Install dialog, Settings, ARIA)   │
└────────────────────────────────────────────────────────────┘
            │ calls
┌─ ORCHESTRATION (Salsa) ───────────────────────────────────┐
│  ShapeManager (facade)                                      │
│    └── ShellUIManager  ← the "OS shell"                     │
│         • state: mode, selection, hover                     │
│         • cart registry (ShellStorage / OPFS)               │
│         • project list = VIEW over documents (docSource)    │
│         • lifecycle: initializeScene / destroyScene         │
└────────────────────────────────────────────────────────────┘
            │ shares
┌─ SHARED GPU FOUNDATION ───────────────────────────────────┐
│  ONE <canvas>   +   ONE GPUDevice                          │
│  (created/owned by WebGPURenderer; borrowed by the shell)  │
└────────────────────────────────────────────────────────────┘
            │ taken turns by
┌─ RUNTIMES (take turns owning the surface) ────────────────┐
│  • Editor runtime   → WebGPURenderer (the illustration     │
│                        engine: 2D/3D, GP, armature, etc.)  │
│  • Shell scene      → ShellRenderer (grid + cartridge)     │
│  • Cart runtimes    → Phase 6, NOT BUILT (launchSlot throws)│
└────────────────────────────────────────────────────────────┘
```

The crucial decoupling: **"who owns the GPU surface and lifecycle"** (the shell) is separated from **"what draws to it"** (the runtimes). That separation is what makes the cartridge vision possible.

---

## Component responsibilities

| Component | Role | File |
|---|---|---|
| `FrogmarksStudioComponent` | Host wrapper; persistent owner of canvas + ShapeManager; shell↔editor toggle | *(Frogmarks repo)* |
| `ShapeManager` | Facade; constructs the renderer; exposes `whenWebGPUReady()`, wires the document source | `src/services/shape-manager.ts` |
| `ShellUIManager` | The shell/orchestration layer: state, registry, project view, scene lifecycle, interaction | `src/services/managers/shell-ui-manager.ts` |
| `ShellRenderer` | The shell's own renderer (tiles + labels + cartridge); borrows device+context; own rAF loop | `src/renderer/shell/shell-renderer.ts` |
| `ShellLabelAtlas` | Canvas-2D rasterized label atlas | `src/renderer/shell/shell-text.ts` |
| `ShellThumbnailAtlas` | Async data-URL → packed thumbnail texture atlas | `src/renderer/shell/shell-thumbnails.ts` |
| `CartridgeViewer` | Procedural cartridge/sketchbook 3D viewer (top region) | `src/renderer/shell/shell-cartridge.ts` |
| `shell-layout.ts` | Pure layout + theming + hit-testing (no GPU) | `src/renderer/shell/shell-layout.ts` |
| `ShellStorage` | OPFS for the cart registry + exported `.frogmarks`/cart binaries | `src/services/persistence/shell-storage.ts` |
| `ShellDocumentSource` | Bridge so the project list is a *view* over `DocumentPersistence` | wired in `shape-manager.ts` |
| `WebGPURenderer` | The illustration engine (the editor runtime); owns canvas + device | `src/renderer/core/webgpu-renderer.ts` |
| `DocumentPersistence` | The real project/document store (`/salsa-documents/{docId}/`) | `src/services/persistence/document-persistence.ts` |

---

## 3D tile forms (coins + CDs)

The shell grid isn't only flat riso circles. Two tile classes render as small **3D meshes** in a depth pass over the panel (own pipelines in `CartridgeViewer`, a per-draw uniform pool, drawn at each tile's screen rect):

| Form | For | Mesh | Surface |
|---|---|---|---|
| **Coin** (`drawDisc`) | system apps (Illustrator, Settings) | solid extruded disc | dark body + app icon on the face (sampled from the thumbnail atlas) |
| **Billboard cutout** (`drawBillboard`) | Install Cart | extruded icon silhouette (download arrow) | textured cutout + ink edge — a spinning [Billboard3D](../specs/billboard3d.md) |
| **CD** (`drawCD`) | FrogCarts (`remote`/`local` slots) | annulus + center hole | silver/chrome + iridescent diffraction rainbow — see [specs/shell-cd.md](../specs/shell-cd.md) |

A tile opts into a 3D form via `discIcon` (coin), `billboardKey` (cutout), or `cd` (CD) on `RenderTile`; such tiles are **excluded from the 2D tile pass** so only the 3D form shows. The icon-drawing placeholders live in `shell-icons.ts` (`drawPlaceholderIcon`). The **hero logo** uses the same cutout viewer with an "always-front" mirror flip — the back face is mirrored at edge-on so its text never reads backwards. Backdrop, blob/squiggle colors, and the panel border are themed (pinwheel / frog / moon). See [specs/billboard3d.md](../specs/billboard3d.md) and [specs/shell-cd.md](../specs/shell-cd.md).

---

## Lifecycle: surface ownership hand-off

### Boot

```
FrogmarksStudioComponent.ngOnInit
  → new ShapeManager(canvas, …)         // constructs WebGPURenderer → async device init
  → await sm.whenWebGPUReady()          // resolves at end of initWebGPU() (immediate if already up)
  → await sm.shell.load()               // cart registry from OPFS + refresh project list
  → await sm.shell.initializeScene(canvas)
        • borrow sm.getDevice()
        • configure the PASSED canvas's context (device, format, premultiplied)
        • main.pause()                  // editor render loop stops
        • ShellRenderer starts its own rAF loop (idle cartridge spin + grid)
```

### Shell → editor (open a project / launch a cart)

```
sm.shell.destroyScene()
  • stop shell rAF loop, release shell GPU resources
  • main.play()                         // editor render loop resumes
host then loads the document/cart into the editor runtime on the SAME canvas
```

### Editor → shell (return home)

```
host saves the document (autosave captures manifest thumbnail)
  → sm.shell.recordProjectSave(docId)   // refresh the project view
  → sm.shell.initializeScene(canvas)    // shell takes the surface back
```

The only thing that changes across these transitions is **which runtime owns the render loop**. The canvas and device never get torn down. That invariant is why the model must be a *state toggle*, not Angular routing (routing destroys components → would destroy the canvas/device → races the hand-off). See the Frogmarks app-architecture decision (Path B: persistent studio wrapper) in [ui/shell-ui.md](../ui/shell-ui.md).

---

## Two storage worlds (and why)

| | Documents (projects) | Carts |
|---|---|---|
| What | The user's editable `.frogmarks` work | Packaged distributable apps |
| Store | `DocumentPersistence` → `/salsa-documents/{docId}/` | `ShellStorage` → `/carts/…` + registry |
| Shell sees it via | `ShellDocumentSource` (a **view**, `ProjectEntry.id === docId`) | `ShellRegistry` (the shell's own index) |
| Open/run | host's existing `sm.loadDocument(docId)` | `launchSlot()` — Phase 6, not built |

The shell deliberately does **not** own a parallel project store: the Illustrations dashboard is a thin view over the documents the editor already saves, so opening/saving reuses the proven document path and thumbnails come straight from the manifest.

---

## What's real vs. scaffolded

This is the honest status — the *shape* is console-like, but it is a foundation, not a finished OS.

| Capability | Status |
|---|---|
| Shell renders (grid, labels, 3D cartridge, thumbnails) | **Built** (Phases 1–3), **not browser-validated** |
| Shell ↔ editor surface hand-off (pause/resume) | **Built**, not browser-validated |
| "Illustrator" app → Illustrations dashboard → open a project in the editor | **Built** (the editor *is* the existing engine) |
| "Settings" app | An HTML overlay Frogmarks renders — its job, not built here |
| Projects = a view over existing documents | **Built** |
| `whenWebGPUReady()` readiness signal | **Built** |
| Installing a FrogCart (Phase 4) | **Not built** — APIs exist, flow doesn't |
| Launching a FrogCart (`launchSlot`, Phase 6) | **Stubbed — throws.** Carts cannot run yet |

Today there are exactly **two** runtimes (shell + editor). Cart runtimes are the third class, and Phase 6 is where they first exercise the same swap the editor uses. **The shell + editor rendering and the hand-off are now browser-validated** (2026-06-12) — the white/black-screen bugs found during that validation drove the per-route-canvas + `scheduleRender` fixes noted in the canvas-model callout above.

---

## Why this matters

Separating "who owns the surface and lifecycle" from "what draws to it" is precisely what a console OS does. It is the foundation that makes the cartridge vision *possible*:

- **Phase 4 (install)** populates the registry with real carts.
- **Phase 6 (launch)** plugs cart runtimes into the same surface hand-off the editor already uses — turning the two-runtime swap into a genuine multi-app model.

Until then, this is a validated-by-types architecture with one proven runtime (the editor), one new renderer (the shell), and a clean seam between them.

---

## Related

- [specs/shell-ui.md](../specs/shell-ui.md) — design intent, phase plan, layout/visual spec
- [ui/shell-ui.md](../ui/shell-ui.md) — Frogmarks integration contract (the host's how-to)
- [11 — Services & Managers §ShellUIManager](11-services-managers.md) — API listing
