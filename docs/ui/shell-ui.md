# Frogmarks — Shell UI Integration

**Last Updated:** 2026-06-10
**Salsa status:** Phases 1–3 implemented (storage, state, slot grid, labels, cartridge viewer, thumbnails). Not yet browser-validated. `launchSlot()` is a Phase 6 stub.

This is the host-integration contract for the WebGPU **Shell UI** — the console-style home screen that replaces Frogmarks's legacy HTML/SCSS dashboard. Salsa renders everything (grid, labels, 3D cartridge); Frogmarks owns the canvas element, the launch/open routing, and a thin HTML overlay for text input and accessibility.

Design rationale: [specs/shell-ui.md](../specs/shell-ui.md). Architecture overview: [reference/23-shell-architecture.md](../reference/23-shell-architecture.md). Engine API listing: [reference/11-services-managers.md §ShellUIManager](../reference/11-services-managers.md).

---

## Mental model

```
┌──────────────────────────────────────────────┐
│  CARTRIDGE VIEWER  (top 40%)                   │  ← spinning cartridge / sketchbook
│  Salsa-rendered 3D                             │     of the SELECTED slot
├──────────────────────────────────────────────┤
│  SLOT GRID  (bottom 60%)                        │  ← system apps + carts (shell mode)
│  [Illustrator][Settings][cart][cart][ + ]       │     or projects (illustrations mode)
└──────────────────────────────────────────────┘
        ▲ one <canvas>, one WebGPU context
```

Two dashboard **modes**, both rendered by the same shell scene:
- `shell` — system apps (Illustrator, Settings) + installed FrogCarts, with a trailing `+` install tile.
- `illustrations` — the user's `.frogmarks` projects, with a leading `New Project` tile. Entered by clicking the **Illustrator** system app; exited with Esc (handled internally) or `closeIllustratorDashboard()`.

**Two file types — keep them distinct:**
| | `.frogmarks` project | `.frogcart` |
|---|---|---|
| What | Editable work file (like `.psd`) | Packaged distributable app (like `.app`) |
| Where | **DocumentPersistence** (`/salsa-documents/{docId}/`) | `/carts/{id}.frogcart` (OPFS) |
| Shown in | Illustrations dashboard | Shell grid |
| Created by | Editing + save | "Export as cart" from a project |

> **Important — projects are your existing documents.** The Illustrations dashboard is a **view over the documents you already save via `DocumentPersistence`**, not a parallel store. A shell project's `id` **is** its `docId`. You open with `sm.loadDocument(docId)` and the thumbnail comes straight from the document manifest — the same path your old dashboard uses.

---

## What Salsa handles vs. what Frogmarks must do

| Concern | Owner |
|---|---|
| Rendering the grid, labels, cartridge, thumbnails, idle animation | **Salsa** |
| Pointer hover/select, double-click activation, Esc-to-exit-dashboard | **Salsa** |
| OPFS persistence of the cart registry + project index | **Salsa** |
| Pausing/resuming the main illustration renderer on mount/unmount | **Salsa** |
| Providing the `<canvas>` element | **Frogmarks** |
| **Opening a project** in the editor (load `.frogmarks` → restore scene) | **Frogmarks** |
| **Launching a cart** (load `.frogcart` → run) — Phase 6, not built | **Frogmarks** + Salsa |
| **Installing a cart** (file picker / Install-by-URL dialog) — Phase 4 | **Frogmarks** + Salsa |
| Capturing a project **thumbnail** on save and handing it back | **Frogmarks** |
| HTML overlay: Install-by-URL text field, file picker, ARIA tree | **Frogmarks** |

---

## Lifecycle — mounting the shell

**One canvas, one owner.** The shell and the editor share a single persistent `<canvas>` and a single `GPUDevice`. There is **no routing** — "shell" vs "editor" is a state toggle, not a navigation. The shell borrows the device, configures the shared canvas's context, and **pauses** the main renderer while it owns the surface. This mirrors a game console: home screen and game are one continuous surface.

```typescript
// One persistent component, one canvas:
//   AppComponent
//     └── <canvas #mainCanvas>     ← never destroyed
//     └── mode: 'shell' | 'editor'

// Show the shell (app default state, or when the user exits a document):
await sm.whenWebGPUReady();                          // wait for the device (resolves immediately if already up)
await sm.shell.load();                              // load registry + refresh project list
await sm.shell.initializeScene(sm.getRendererCanvas()); // borrow device, configure canvas, suspend editor, start loop

// Switch to the editor (same canvas):
sm.shell.destroyScene();                // release shell GPU resources, RESUME the editor renderer
```

### Branding — inject your logo

The default "hero" Billboard3D (the spinning mesh shown when nothing is hovered) is a frog placeholder. Hand Salsa your logo and it generates + renders the 3D cutout for you:

```typescript
sm.setShellLogo('assets/logo.png');   // URL or data URL; transparent background → clean cutout
```

Safe to call any time (before or after `initializeScene`) — it's applied as soon as the renderer is available, and re-applied on each mount. The image's **alpha channel is the silhouette**, so use a PNG with a transparent background. (Hovering "Install Cart" shows a star; the system apps show pencil/gear cutouts.)

### HTML-in-Canvas (experimental) — interactive DOM in the scene

The shell can render a **live DOM element into the WebGPU scene** (so it gets the riso grain / scene treatment) while staying fully interactive, via Chrome's experimental [HTML-in-Canvas API](https://developer.chrome.com/blog/html-in-canvas-origin-trial) (`GPUQueue.copyElementImageToTexture`). First use is a local-model-URL field:

```typescript
sm.showShellLocalModelField();         // mount a styled input + SAVE into the scene
sm.hideShellLocalModelField();
sm.shellHtmlInCanvasSupported;         // true = composited in-canvas, false = overlay fallback
sm.getShellLocalModelUrl();            // persisted value (localStorage)
```

**It degrades gracefully:** when the API isn't available the element is mounted as a plain **positioned overlay** over the canvas — fully interactive, just not composited in-scene. So it works today and *upgrades* automatically when the API turns on.

To enable the true in-canvas path:
- **Dev:** Chrome 148+ / Canary with `chrome://flags/#canvas-draw-element`.
- **Prod:** register for the **Origin Trial** and add the token `<meta>` to the host page.
- Salsa sets `layoutsubtree` on the canvas itself; the host doesn't need to nest anything for the built-in field (Salsa appends the element to the canvas). Custom elements you want in-scene should also be canvas children.

Caveat: experimental, **Chrome-only**, API may change — fine for a Chrome-first product, not a cross-browser guarantee. Salsa feature-detects, so non-Chrome users get the overlay.

Rules:
- Pass the **same canvas** the editor renderer draws to. The safest way is **`sm.getRendererCanvas()`** rather than re-looking-up by id — that guarantees the shell renders to the exact surface the editor owns, with no hidden-canvas mismatch. (In the default `main.ts` bootstrap the editor uses the `#webgpuCanvas` element you pass to `startWebGPURendering`, so they're the same — but `getRendererCanvas()` removes any doubt.)
- The editor renderer is **hard-suspended** while the shell is mounted (`suspendRendering()`), which blocks *both* its loop and its on-demand `scheduleRender()` path — so editor pointer/resize events can't repaint the whiteboard over the shell. `destroyScene()` calls `resumeRendering()`.
- The **device must already be initialized** before the first mount. A shared canvas can't hold a second device, so the shell borrows the editor's. **`await sm.whenWebGPUReady()`** before the first `initializeScene` — it resolves once the device is up (immediately if it already is). `initializeScene` throws a clear error if the device isn't ready.
- `initializeScene` is idempotent; `destroyScene` resumes the editor only if it was live when the shell mounted.
- Always `destroyScene()` before the editor takes over, and `initializeScene()` again on the way back.

`sm.shell.isSceneActive` → boolean, if you need to guard.

---

## Handling activation — the one event you must wire

Salsa handles selection/hover internally and updates the cartridge viewer. The **only** thing Frogmarks must respond to is **activation** — a double-click on a tile, or a click on a tile whose primary action is a route (New Project, Settings, the `+` tile).

```typescript
sm.shell.onActivate.subscribe(({ id, kind }) => {
  switch (kind) {
    case 'project':
      // Open this .frogmarks project in the editor.
      void openProjectInEditor(id);
      break;

    case 'local':
    case 'remote':
      // Launch a cart. Phase 6 (sm.shell.launchSlot) is not built yet —
      // for now, do nothing or show a "coming soon" toast.
      break;

    case 'system':
      // A non-Illustrator system app (currently only Settings).
      if (id === 'system:settings') openSettingsOverlay();
      break;

    case 'empty':
      // The trailing "+" install tile (id === SHELL_ADD_CART_ID).
      openInstallCartDialog();
      break;
  }
});
```

Notes:
- Clicking **Illustrator** does **not** fire `onActivate` — Salsa switches to the Illustrations dashboard internally.
- Clicking **New Project** creates a blank `.frogmarks` entry and fires `onActivate({ kind: 'project' })` so you open it immediately — handle it the same as opening any project.
- Import the synthetic ids (and the event type) from the managers barrel if you need to compare against them:
  ```typescript
  import { SHELL_ADD_CART_ID, SHELL_NEW_PROJECT_ID, type ShellActivateEvent } from 'salsa/services/managers';
  ```
  (Adjust the package path to however Frogmarks resolves the Salsa source.)

`onChange.subscribe(reason => …)` also exists (`reason`: `'loaded' | 'registry' | 'projects' | 'mode' | 'selection' | 'hover'`) if you want to mirror shell state into an HTML overlay (e.g. show the selected cart's full description). It is **not** required for the shell to function.

---

## Opening a project (`= a document`)

A shell project id **is** a `docId`, so opening is just your existing document-load path — no `.frogmarks` unpack in the normal loop.

```typescript
async function openProjectInEditor(projectId /* === docId */) {
  // 1. Hand the canvas back to the editor.
  sm.shell.destroyScene();

  // 2. Load the document. For a brand-new project created via the New tile,
  //    loadDocument returns success:false (nothing saved yet) — start blank
  //    with that same id so the first save lands on it.
  const res = await sm.loadDocument(projectId);
  if (!res?.success) startBlankDocument(projectId);

  currentProjectId = projectId;
}
```

### Saving a project — thumbnails come for free

Your existing autosave already writes the document and captures `manifest.thumbnail`. After a save, just ping the shell so its cached list refreshes (timestamp + thumbnail). You do **not** need to pass a thumbnail — but you may, for an instant optimistic update.

```typescript
async function afterSave() {
  await sm.shell.recordProjectSave(currentProjectId);          // reconciles from the manifest
  // optional instant update:
  // await sm.shell.recordProjectSave(currentProjectId, { thumbnailDataUrl });
}
```

> Because the thumbnail is read from the document manifest, **project tiles and the sketchbook light up automatically after your first autosave** — no extra capture step required.

### Other project operations

These delegate to the document store on the Salsa side — call them from your `⋯` menus:

```typescript
sm.shell.renameProject(id, name);  // rewrites the document manifest name
sm.shell.deleteProject(id);        // deletes the document (+ any exported .frogcart copy)
sm.shell.getProjects();            // cached list, newest first (for your own overlays)
sm.shell.refreshProjects();        // force a re-pull from the document store
sm.shell.duplicateProject(id);     // returns null unless a duplicate hook is provided (deferred)
```

**New project** (from the New tile, handled internally) mints a fresh `docId`, optimistically shows the tile, and fires `onActivate({ kind: 'project' })` so you open it immediately. `loadDocument` returns `success:false` for it until the first save — start a blank document with that id.

### Custom document source (if your projects aren't in DocumentPersistence)

By default the shell lists projects from `DocumentPersistence` (`/salsa-documents`). If your illustrations live somewhere else (e.g. IndexedDB via your own service), **override the source** so the shell lists/opens *your* store — the project id becomes whatever your store uses:

```typescript
sm.shell.setDocumentSource({
  // Only id + name are required. thumbnailDataUrl is strongly recommended
  // (drives tile + cartridge art); lastModified is optional (drives sort).
  listProjects: async () => (await myStore.getAll()).map(i => ({
    id: i.uuid, name: i.name, thumbnailDataUrl: i.thumbnailDataUrl, lastModified: i.updatedAt,
  })),
  deleteProject: (id) => myStore.delete(id),
  renameProject: (id, name) => myStore.rename(id, name),
  newProjectId: () => crypto.randomUUID(),

  // RECOMMENDED: create the entry in YOUR store up front so the New tile's
  // onActivate id is openable immediately by your existing open-by-id route.
  // Without this, the New tile id won't exist in your store yet — your opener
  // must treat an unknown id as a fresh blank document.
  createProject: async (name) => {
    const item = await myStore.create(name);
    return { id: item.uuid, name: item.name, thumbnailDataUrl: item.thumbnailDataUrl };
  },
});
```

Then your `onActivate({ kind: 'project', id })` handler opens with *your* opener (the id matches your store). This is the **Path B** wiring — the shell is pure presentation over your existing store.

---

## Installing a cart (Phase 4 — not built yet, but here's the contract)

There is **no built-in storefront**. The `+` tile fires `onActivate({ kind: 'empty' })`; Frogmarks shows an HTML dialog offering **Install from file** (`.frogcart` picker / drag-drop) or **Install by URL** (paste a manifest URL). Once you have the cart bytes + metadata, register it:

```typescript
// After unpacking the .frogcart (you have its manifest + thumbnail):
const id = crypto.randomUUID();
await sm.shell.fileStore.writeLocalCart(id, frogcartBytes);   // → '/carts/{id}.frogcart'
await sm.shell.upsertCartSlot({
  id,
  order: 0,                         // ignored for new carts; appended to the end
  type: 'local',
  name: manifest.name,
  description: manifest.description,
  thumbnailDataUrl: manifest.thumbnail,   // base64 — makes the tile + cartridge show art
  opfsPath: `/carts/${id}.frogcart`,
});
```

For remote carts, set `type: 'remote'` and the `registryUrl` / `packageUrl` / `packageHash` / `autoUpdate` fields (see `ShellSlot` in `shell-storage.ts`). The auto-update flow itself is Phase 6.

Remove / reorder:
```typescript
sm.shell.removeCartSlot(id);          // deletes slot + its OPFS binaries
sm.shell.reorderCartSlot(id, order);  // system apps stay pinned at the front
```

---

## Launching a cart (Phase 6 — not built)

`sm.shell.launchSlot(id)` currently **throws** by design. When Phase 6 lands it will: update-check (remote) → load the `.frogcart` → tear down the shell → hand the canvas to the cart runtime. Until then, treat `onActivate({ kind: 'local' | 'remote' })` as a no-op or a "coming soon" message.

---

## HTML overlay responsibilities

The shell is fully WebGPU; Frogmarks supplies a thin overlay (`pointer-events: none` except where active) for the things a canvas can't do:

1. **Install-by-URL dialog** — a text field + confirm, opened from the `+` tile or Settings.
2. **File picker / drag-drop** for `.frogcart` (and `.frogmarks` import).
3. **Settings overlay** — opened from the Settings system app (`onActivate`, `id === 'system:settings'`).
4. **Accessibility tree** — mirror the slots as offscreen ARIA elements so screen readers can navigate the grid. Read the slot list from `sm.shell.getSlots()` / `getProjects()` and update on `onChange`.

Keep the overlay sized to the canvas. The shell does not need it to render or to handle pointer interaction — it's purely for text entry and a11y.

---

## Minimal end-to-end wiring

```typescript
// ── app boot (FrogmarksStudioComponent ngOnInit) ──
await sm.whenWebGPUReady();            // device ready before we borrow it
await sm.shell.load();

sm.shell.onActivate.subscribe(({ id, kind }) => {
  if (kind === 'project') openProjectInEditor(id);
  else if (kind === 'empty') openInstallCartDialog();
  else if (kind === 'system' && id === 'system:settings') openSettingsOverlay();
  // 'local' / 'remote' cart launch → Phase 6
});

// ── show the home screen ──
await sm.shell.initializeScene(shellCanvas);

// ── user picks a project → editor (projectId === docId) ──
async function openProjectInEditor(projectId) {
  sm.shell.destroyScene();
  const res = await sm.loadDocument(projectId);
  if (!res?.success) startBlankDocument(projectId);   // new, never-saved project
  currentProjectId = projectId;
}

// ── back to home from editor ──
async function returnToShell() {
  await saveCurrentDocument();          // your existing autosave (captures the thumbnail)
  await sm.shell.recordProjectSave(currentProjectId);
  await sm.shell.initializeScene(shellCanvas);
}
```

---

## Troubleshooting

**"I see the editor whiteboard (dot grid), not the shell."** The editor renders to the **same** canvas as the shell (`#webgpuCanvas` in the default bootstrap) — this is *not* a hidden-canvas problem. Note the `z-index: 10` canvas in the DOM is the editor's **2D ephemera overlay** (`pointer-events: none`, transparent), not a render surface. Work through:

1. **Is the shell in the build?** Console: `ShapeManager.getInstance().shell` → should be a `ShellUIManager`. If `undefined`, you're on a stale Salsa build — rebuild Salsa.
2. **Did `initializeScene` run without throwing?** It throws only if the device isn't ready (await `sm.whenWebGPUReady()` first) or the canvas can't return a WebGPU context. Wrap the call in try/catch and log.
3. **Are you passing the renderer's canvas?** Use `sm.getRendererCanvas()`. Passing a different element renders the shell to a surface the editor isn't on.
4. **Is the editor overdrawing the shell?** This was a Salsa bug (`pause()` didn't stop the on-demand `scheduleRender()` path) — fixed via `suspendRendering()`. Confirm with `ShapeManager.getInstance().getRendererCanvas` and that your Salsa build includes `WebGPURenderer.suspendRendering`. While the shell is mounted, `webgpuRenderer.isSuspended` should be `true`.

**"I opened a project and the editor canvas is BLACK (but the document loaded — logs show layers restored)."** Two causes, both Shell-UI related, both now safety-netted in Salsa:
1. **Dropped `COPY_DST` (the real one).** The shell borrows the editor's canvas context and reconfigures it. The editor configures with `RENDER_ATTACHMENT | COPY_DST` (its compositor copies into the swapchain); the shell must too, or the editor's copy silently no-ops → black. Fixed: the shell now configures with `COPY_DST`, and `resumeRendering()` re-asserts the full editor config.
2. **Hard-suspend not released.** `suspendRendering()` blocks all draws; if shell→editor doesn't release it the document never draws.

What's handled for you now: `sm.loadDocument()` tears down the shell if still mounted, re-asserts the context config, and resumes. Still, **call `sm.shell.destroyScene()` when leaving the shell** (e.g. shell component `ngOnDestroy`) as the clean contract. Diagnostics: `ShapeManager.getInstance().isRenderingSuspended`, `ShapeManager.getInstance().shell.isSceneActive`, and `sm.resumeEditorRendering()` to force-recover.

## Gotchas

- **One canvas, one owner at a time.** The shell pauses the editor renderer and draws to the same surface. Never run both simultaneously — always `destroyScene()` before editing, `initializeScene()` after. Pass the **same** canvas the editor uses.
- **The device must be initialized before the first mount.** Shared canvas ⇒ shared device; let ShapeManager finish WebGPU init first. `initializeScene` throws if the device isn't ready.
- **Projects ARE documents.** `ProjectEntry.id === docId`. Open via `sm.loadDocument(id)`, not a `.frogmarks` unpack. Thumbnails come from the document manifest automatically.
- **New, never-saved projects return `success:false` from `loadDocument`.** Start a blank document with that id, don't error.
- **System apps are hardcoded.** You can't add/remove/reorder Illustrator or Settings via the registry APIs (they're re-derived each load).
- **Not yet browser-validated.** This is the first integration; smoke-test the mount/unmount hand-off and the viewport split before building UI on top.
