# Frogmarks Shell UI — Spec
**Status:** Not yet started  
**Last Updated:** 2026-06-10

The Shell UI replaces Frogmarks's existing HTML/SCSS dashboard with a WebGPU-rendered interactive environment. It is the first thing the user sees when they open Frogmarks — a spatial home screen inspired by Nintendo 3DS LiveArea, rendered entirely by the Salsa engine.

---

## Vision

The shell is not a web dashboard. It is a browser-native console home screen.

- Every visual element (slot grid, cartridge, background, transitions) is rendered by Salsa's WebGPU pipeline
- HTML is used only for text inputs and accessibility overlays — no structural layout
- The experience should feel spatial, tactile, and cohesive — consistent rendering style from home screen through launching a cart
- System apps (Illustrator, Settings) live alongside user carts in the grid; the **Illustrator** app is the gateway to the user's saved `.frogmarks` projects via a dedicated sub-dashboard

---

## Layout

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│              CARTRIDGE VIEWER                       │
│         (top ~40% of the viewport)                  │
│                                                     │
│   [3D cartridge mesh — spins idly, label texture   │
│    shows selected cart's thumbnail]                 │
│                                                     │
│   Cart name         [LAUNCH]  [⋯]                  │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│              SLOT GRID                              │
│       (bottom ~60% of the viewport)                 │
│                                                     │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │
│  │      │ │      │ │      │ │      │ │      │    │
│  │ slot │ │ slot │ │ slot │ │ slot │ │ slot │    │
│  │      │ │      │ │      │ │      │ │      │    │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘    │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │
│  │      │ │      │ │      │ │ [+]  │ │ [+]  │    │
│  │ slot │ │ slot │ │ slot │ │empty │ │empty │    │
│  │      │ │      │ │      │ │      │ │      │    │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘    │
│                                                     │
└─────────────────────────────────────────────────────┘
```

The divider between the two sections is not a hard line — the cartridge viewer fades into the slot grid via a subtle depth/ambient gradient.

---

## Cartridge Viewer (Top Section)

### The cartridge mesh

A standard "Frogmarks Cartridge" mesh is shipped as a built-in static asset — a GBA/DS-style rectangular slab with beveled edges and a recessed label inset on the front face. Dimensions: roughly 2:3:0.4 (width:height:depth) in local units. One mesh definition is shared for all carts; only the label texture changes.

The label face UV-maps directly to the selected cart's `manifest.thumbnail`. For system apps, the label uses a dedicated icon texture.

```
Front face:
┌─────────────────────┐
│  ╔═══════════════╗  │
│  ║               ║  │  ← label inset (thumbnail texture)
│  ║   [thumbnail] ║  │
│  ║               ║  │
│  ╚═══════════════╝  │
│         ▼▼▼          │  ← connector teeth at bottom
└─────────────────────┘
```

### Future enhancement — custom mini-scenes and Billboard3D

In the future, the generic cartridge can be replaced with a **custom shell scene** defined per cart — a small embedded Salsa scene that plays in the cartridge viewer area while the cart is selected, similar to how 3DS applications each had their own animated home-screen presentation (see: Flipnote Studio 3D showing its frog and pencil characters floating above the launch button).

The `CartManifest` would gain an optional `shellSceneUrl` field pointing to a compact `.frogscene` file bundled with the cart. When present, the viewer loads that scene instead of the generic cartridge mesh. When absent, the cartridge fallback is used.

These mini-scenes are the natural use case for a new Salsa renderer primitive: **`Billboard3D`** — a 3D "paper cutout" of a PNG sprite. You provide a PNG with transparency; the engine generates a solid extruded mesh shaped to the sprite's alpha silhouette, giving it physical thickness. The result looks like the sprite was printed on card stock and cut out with scissors — exactly the effect seen on the Flipnote Studio 3D launch screen.

**How `Billboard3D` works:**

1. The PNG alpha channel is analyzed to trace the silhouette boundary (marching squares / contour tracing)
2. The boundary polygon is expanded outward by `padding` world units
3. Optionally, the polygon is subdivided to produce smooth `borderRadius` rounded edges
4. The polygon is extruded along Z by `depth` world units, producing front face + back face + side strip
5. Front/back faces display the original PNG texture (alpha-transparent regions reveal the background)
6. The side strip (the cut edge) is a solid `sideColor` — typically white or a neutral color to look like card stock

```typescript
interface Billboard3DConfig {
  imageUrl:        string;                   // PNG with alpha channel
  padding:         number;                   // world units beyond alpha boundary (default 0.05)
  depth:           number;                   // extrusion thickness in world units (default 0.1)
  borderRadius:    number;                   // rounding on extruded corners (0 = sharp, default 0.02)
  sideColor:       [number,number,number,number]; // RGBA of cut edge; default [1,1,1,1]
  alphaThreshold:  number;                   // 0–1; below this is "outside" (default 0.1)
}

// Usage (future API — not yet implemented)
const frog = sm.createBillboard3D(x, y, z, config);
// Behaves like a Mesh3D — parented, keyframeable, can use FrameLinkAnimation3D
```

`Billboard3D` is a **general-purpose Salsa primitive**, not a shell-only feature. Any scene — illustration, FrogCart, or shell — can use it to place stylized sprite characters alongside 3D geometry. The shell mini-scene is just the first obvious use case.

Salsa already has `earClip()` (from the GP fill path in `edit-mesh.ts`) for polygon triangulation, which covers the hard part of the mesh generation. The alpha-contour extraction and extrusion are the new pieces.

**Spec:** see `docs/specs/billboard3d.md` (to be written when this feature is prioritized).

### Idle state

When a cart is selected, the cartridge:
- Spins slowly around its Y axis (continuous, ~12 seconds per revolution)
- Bobs gently on the Y axis (sine wave, ~2 second period, ~5% of height amplitude)
- Tilts slightly toward the viewer (fixed ~10° tilt on X)

The thumbnail texture on the label renders at full quality. The rest of the cartridge uses a simple PBR material: dark matte plastic with subtle specular highlights.

### Transition: selecting a new cart

When the user clicks a different slot:
1. The current cartridge tilts back (ease-in, ~120ms), scales down, and fades out
2. The new cartridge rises up from below the divider (ease-out, ~200ms) and settles into the idle position
3. The label texture swaps during the rise (while the cart is below the fold and not yet visible)

### Sketchbook mode (Illustrations dashboard)

When the user enters the Illustrations dashboard (via the Illustrator system app), the cartridge mesh is replaced by an **open sketchbook mesh** — a flat-lay open notebook with a branded cover and two open pages. The right-hand page UV-maps to the selected project's thumbnail. The sketchbook uses the same idle bob animation as the cartridge (2s/cycle, Y axis). When no project is selected, both pages show blank ruled paper.

The sketchbook is a second built-in static mesh asset (`src/renderer/shell/sketchbook-mesh.ts`), similar to the cartridge but with a different shape and UV layout. The thumbnail swaps on the right page the same way the label texture swaps on the cartridge.

### Empty / default state

When no cart is selected (first load, or after deselect):
- The Frogmarks logo cartridge is shown (built-in system asset, branded)
- No launch button visible

### Action buttons

"LAUNCH" and "⋯" (more options) are rendered as SDF-text quads in the cartridge viewer, not HTML buttons. They appear below the cartridge on a dark translucent panel strip.

More options (`⋯`) expands to: Rename, Remove from Shell, Details (version/size/origin), Add to Favorites.

For remote carts with `autoUpdate: true`, a small "🔄 Update available" badge appears near the `⋯` button when an update is detected.

---

## Slot Grid (Bottom Section)

### Grid dimensions

Default: **5 columns × 3 rows = 15 visible slots**. Scrolls vertically if the user has more than 15 entries. The grid scrolls smoothly (eased) on pointer drag or scroll wheel.

Slot aspect ratio: 1:1 square tiles with ~8px gap between them. Rounded corners (radius ~12% of tile size).

### Slot types

| Type | Visual | Behavior |
|------|--------|----------|
| `system` | Built-in icon + label | Launches a system screen or sub-dashboard; no cartridge mesh |
| `local-cart` | Thumbnail + label | Launches from OPFS directly |
| `remote-cart` | Thumbnail + label + optional badge | Fetches/updates on launch |
| `frogmarks-project` | Document thumbnail + name + last-modified | Opens project in editor; only appears inside the Illustrations dashboard |
| `empty` | Dimmed placeholder with `+` | Opens the "Add Cart" flow (main grid) or "New Project" (Illustrations dashboard) |

System app slots are pinned to the beginning of the grid and cannot be reordered away from the front. User carts follow.

### Slot states

| State | Visual |
|-------|--------|
| Default | Thumbnail fills tile, label below at 80% opacity |
| Hovered | Tile lifts (slight Y translation + drop shadow deepens), label 100% opacity |
| Selected | Tile stays lifted; white border ring animates in (0.5px → 2px, 150ms); cartridge viewer updates |
| Launching | Tile scales down briefly (~80%), then fades as the full experience opens |

### Parallax depth

The slot grid has a subtle parallax effect on pointer move: tiles in the foreground rows shift more than tiles in the background rows, giving the grid a sense of depth. Maximum displacement: ~4px at the edges of the viewport.

### Labels

Cart name rendered as SDF text directly on the WebGPU canvas, centered below each tile. Font: the Frogmarks shell system font (same as used elsewhere in the renderer). Overflow: truncate with ellipsis at ~12 characters.

---

## Storage Model

### Project storage (`.frogmarks` files)

`.frogmarks` files are the user's own illustration projects. They are distinct from carts — carts are authored and packaged for distribution; projects are the raw work files.

Projects live in OPFS at `/projects/{id}.frogmarks`. A lightweight project index is maintained at `OPFS:/shell/projects.json`:

```typescript
interface ProjectRegistry {
  version: 1;
  projects: ProjectEntry[];
}

interface ProjectEntry {
  id: string;                  // stable UUID
  name: string;
  thumbnailDataUrl?: string;   // base64 PNG; cached on save for fast grid load
  lastModified: number;        // Unix timestamp
  opfsPath: string;            // '/projects/{id}.frogmarks'
  sizeBytes?: number;
}
```

New projects are added when the user saves for the first time. The thumbnail is captured on each save (via `captureDocumentBoundsToBlob`) and cached in `thumbnailDataUrl`, so the Illustrations dashboard renders the full grid instantly without opening any `.frogmarks` files.

### Three tiers (carts)

```
Tier 1 — System apps
  Hardcoded in shell config.
  No storage. No update mechanism.
  Examples: New (blank doc), Illustrator, Settings

Tier 2 — Local carts
  Stored as .frogcart in OPFS under /carts/{id}.frogcart
  Metadata (name, thumbnail, id) indexed in a shell registry (OPFS JSON)
  Never network-fetched after install. Launch from OPFS directly.
  Created in two ways:
    A. The user saves/exports a Frogmarks project as a .frogcart
    B. The user drags a .frogcart file into the shell (file picker or drag-drop)

Tier 3 — Remote carts
  Registered via URL. Metadata + thumbnail cached in OPFS.
  Binary (.frogcart package) fetched on first launch, then cached.
  Update behavior controlled per cart by autoUpdate flag.
```

### Cart Registry (OPFS)

The shell maintains a single registry file at `OPFS:/shell/registry.json`:

```typescript
interface ShellRegistry {
  version: 2;
  slots: ShellSlot[];
}

interface ShellSlot {
  id: string;                        // stable UUID
  order: number;                     // position in the grid
  type: 'system' | 'local' | 'remote';
  name: string;
  description?: string;
  thumbnailDataUrl?: string;         // base64 PNG; cached here for fast dashboard load
  
  // local only
  opfsPath?: string;                 // '/carts/{id}.frogcart'
  
  // remote only
  registryUrl?: string;              // URL to the cart's manifest JSON
  packageUrl?: string;               // URL to the .frogcart blob
  packageHash?: string;              // SHA-256 of the cached binary
  installedVersion?: string;
  cachedOpfsPath?: string;           // '/carts/cache/{id}.frogcart'
  autoUpdate?: boolean | 'prompt';   // default: false
  requiresNetwork?: boolean;         // multiplayer carts that can't run offline
  lastChecked?: number;              // timestamp of last update check
}
```

The `thumbnailDataUrl` field is the critical one for fast dashboard load — the shell reads the registry and renders all tiles immediately from cached thumbnail data, with no need to unpack `.frogcart` files or make network requests just to show the grid.

### Auto-update flow

```
User selects cart → "LAUNCH" clicked
  if type === 'local':
    load from opfsPath → launch
  
  if type === 'remote':
    if autoUpdate === true:
      fetch registryUrl → compare hash to packageHash
      if changed:
        download new .frogcart → save to cachedOpfsPath → update registry
      launch from cachedOpfsPath
    
    if autoUpdate === 'prompt':
      same hash check
      if changed:
        show "Update available (v1.2 → v1.3) — Update now or Play current version?"
      launch from choice
    
    if autoUpdate === false (or absent):
      if cachedOpfsPath exists: launch from cache (no network)
      else: first launch → fetch packageUrl → cache → launch
    
    if requiresNetwork && offline:
      show "This cart requires a network connection"
      block launch
```

Update checks are gated by `lastChecked` — a cart with `autoUpdate: true` only re-checks the registry if `Date.now() - lastChecked > 5 * 60 * 1000` (5 minutes) to avoid spamming on rapid re-launches.

### Installing a remote cart

There is **no built-in storefront or browse screen.** Creators share their carts through their own channels — websites, social media, community Discord servers, anywhere they can post a link. The discovery layer is intentionally decentralized.

The install flow is: user finds a manifest URL → pastes it into the "Install by URL" dialog (accessible from any empty slot `+` or from the Settings system app) → the shell fetches the manifest, previews the cart name and thumbnail, and confirms the install.

The manifest URL points to a **cart manifest JSON** hosted by the creator:

```typescript
interface CartManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  packageUrl: string;       // URL to .frogcart blob
  packageHash: string;      // SHA-256
  thumbnailUrl: string;     // PNG for label and grid tile
  autoUpdate?: boolean | 'prompt';
  requiresNetwork?: boolean;
  shellSceneUrl?: string;   // future: URL to .frogscene for custom cartridge viewer
}
```

A creator hosts this file at a stable URL (e.g. `https://mysite.com/mycart/manifest.json`). They update the file when they ship a new version; the shell polls it on next launch if `autoUpdate` is set.

---

## Rendering Architecture

### Shell scene vs illustration scene

The shell runs as a separate Salsa render context. It is not an illustration. When the user launches a cart, the shell scene tears down (or pauses) and the cart's scene loads into the canvas.

```
Browser window
└── <canvas> (one WebGPU canvas, full viewport)
    ├── Shell mode:   ShellScene → Salsa WebGPU renderer
    └── Cart mode:    FrogCart runtime → Salsa WebGPU renderer
```

The transition between shell and cart is a screen-wipe or fade managed by the shell before it hands the canvas off to the cart runtime.

### What Salsa renders

All of the following are rendered by the Salsa WebGPU pipeline:

- Background environment (animated gradient / subtle particle field / stylized BG mesh)
- Cartridge viewer: 3D cartridge mesh, label texture, PBR lighting, idle animation
- Slot grid: 2D quads with thumbnail textures, SDF text labels, border rings
- Transition animations: cartridge rise/fall, tile lift, screen wipe
- Badges and status indicators (update available dot, network-required icon)

### What HTML handles

A thin HTML overlay sits above the WebGPU canvas (pointer-events: none except where active):

- Text input fields (the "Install by URL" dialog, search/filter if added)
- File picker trigger for local cart import
- Accessibility tree (ARIA labels for all slots, so screen readers see the grid)
- Native context menus if used (as fallback to the `⋯` SDF menu)

No structural layout. No divs driving visual composition.

### New Salsa APIs needed

```typescript
// Shell scene lifecycle
sm.shell.initialize(canvas: HTMLCanvasElement): Promise<void>
sm.shell.destroy(): void

// Registry management
sm.shell.getRegistry(): ShellRegistry
sm.shell.addLocalCart(file: File): Promise<ShellSlot>
sm.shell.addRemoteCart(manifestUrl: string): Promise<ShellSlot>
sm.shell.removeSlot(slotId: string): void
sm.shell.reorderSlot(slotId: string, newOrder: number): void
sm.shell.updateRegistry(patches: Partial<ShellSlot>[]): void

// Thumbnail management
sm.shell.refreshThumbnail(slotId: string): Promise<void>
// Unpacks the cart's manifest.thumbnail and caches as thumbnailDataUrl in registry

// Update checks
sm.shell.checkForUpdate(slotId: string): Promise<'current' | 'available' | 'error'>
sm.shell.applyUpdate(slotId: string): Promise<void>

// Cart launch
sm.shell.launchSlot(slotId: string): Promise<void>
// Handles the full flow: update check (if applicable) → load .frogcart → swap renderer → launch

// Render state
sm.shell.setSelectedSlot(slotId: string | null): void  // drives cartridge viewer
sm.shell.setHoveredSlot(slotId: string | null): void

// Illustrations dashboard
sm.shell.openIllustratorDashboard(): void   // transitions grid to project browser, swaps to sketchbook mesh
sm.shell.closeIllustratorDashboard(): void  // returns to main shell grid, restores cartridge viewer

// Project registry
sm.shell.getProjects(): ProjectEntry[]
sm.shell.createProject(name?: string): Promise<ProjectEntry>   // creates blank .frogmarks in OPFS
sm.shell.openProject(projectId: string): Promise<void>         // loads .frogmarks → swaps to editor
sm.shell.deleteProject(projectId: string): Promise<void>
sm.shell.renameProject(projectId: string, name: string): Promise<void>
sm.shell.duplicateProject(projectId: string): Promise<ProjectEntry>
sm.shell.exportProjectAsCart(projectId: string): Promise<void> // packs .frogmarks → .frogcart → install flow
sm.shell.refreshProjectThumbnail(projectId: string): Promise<void>  // re-captures from document bounds
```

### Cartridge mesh

The standard Frogmarks cartridge is a built-in static mesh bundled with the Salsa shell assets. It is a `Mesh3D` node with:
- Geometry defined in `src/renderer/shell/cartridge-mesh.ts` (procedural, no external file)
- One submesh for the body (dark matte plastic material)
- One submesh for the label face (thumbnail texture, slight gloss)
- `gpuDirty` triggered when thumbnail texture swaps

Thumbnail textures are uploaded from the `thumbnailDataUrl` in the registry (via `copyExternalImageToTexture`) whenever the selected slot changes.

---

## Background Environment

The shell background should feel alive but not distracting. Three options for the spec author to choose from (final decision at implementation time):

| Option | Description | Cost |
|--------|-------------|------|
| **A — Gradient field** | Animated slow-moving gradient (2–3 color stops, shift over ~20s); no geometry | Trivial |
| **B — Particle drift** | Very subtle floating particles (dust/sparkle), few hundred, CPU-simulated | Low |
| **C — Environment mesh** | A low-poly stylized room/shelf scene behind the grid; camera locked, no interaction | Medium |

Option B is recommended as the default — adds life without competing with the carts.

---

## System App Slots

These are pinned slots with no `.frogcart` file. Their `type === 'system'` in the registry. They sit at the front of the grid and cannot be reordered.

| Slot | Icon | Action |
|------|------|--------|
| **Illustrator** | Sketchbook/brush icon | Opens the Illustrations sub-dashboard (`.frogmarks` project browser) |
| **Settings** | Gear icon | Opens a settings overlay panel; also hosts the "Install by URL" flow for remote carts |

Two system apps. "New Project" lives inside the Illustrator dashboard — it's a button/tile there that signals Frogmarks to route to a blank illustration, not a top-level shell slot. No Explore, no built-in storefront.

System app slots never show a cartridge in the viewer. When one is selected, the viewer shows a stylized icon graphic instead. In the future they can use the same `shellSceneUrl` mechanism as regular carts for custom mini-scenes.

---

## Illustrations Dashboard

Entered when the user selects the **Illustrator** system app. The shell layout stays intact but the slot grid content transitions to show saved `.frogmarks` projects, and the cartridge viewer swaps to the sketchbook mesh.

### Navigation

A breadcrumb bar renders at the top of the slot grid area (SDF text, WebGPU rendered):

```
← Shell  /  Illustrations
```

Clicking ← or pressing Escape transitions back to the main shell grid. The cartridge viewer reverts to the last selected cart (or the default Frogmarks logo if nothing was previously selected).

### Grid contents

- First slot is always a **New Project** tile — identical in function to the "New" system app, but contextually placed inside the dashboard
- Remaining slots are `frogmarks-project` type, sorted by `lastModified` descending (most recently edited first)
- Grid scrolls vertically the same way as the main shell grid

### Slot interactions (`frogmarks-project`)

| Interaction | Result |
|-------------|--------|
| Single click | Selects slot; sketchbook viewer updates with project thumbnail |
| Double-click or LAUNCH | Opens project in the Frogmarks editor |
| `⋯` menu | Rename, Duplicate, Delete, Export as `.frogcart` |

### Viewer in sketchbook mode

The open sketchbook mesh shows the selected project's thumbnail on the right-hand page. Selecting a new project swaps the thumbnail using the same transition timing as the cartridge (120ms ease-in swap-out, 200ms ease-out swap-in). The LAUNCH button reads "Open" instead of "LAUNCH" in this mode.

### New Project flow

Clicking the New Project tile immediately creates a blank `.frogmarks` entry in the project registry (with a generated UUID and default name "Untitled Project") and opens the Frogmarks editor. On first save, the thumbnail is captured and the registry entry is updated.

---

## Animations Reference

| Animation | Duration | Easing | Trigger |
|-----------|----------|--------|---------|
| Cartridge idle spin | 12s/rev | Linear | Always |
| Cartridge idle bob | 2s/cycle | `ease-in-out` sine | Always |
| Cartridge swap out | 120ms | `ease-in` | New slot selected |
| Cartridge swap in | 200ms | `ease-out` | After swap out |
| Tile hover lift | 80ms | `ease-out` | Pointer enter slot |
| Tile hover drop | 150ms | `ease-in` | Pointer leave slot |
| Selection border ring | 150ms | `ease-out` | Slot clicked |
| Launch scale-down | 100ms | `ease-in` | Launch confirmed |
| Screen wipe to cart | 300ms | `ease-in-out` | After scale-down |
| Grid parallax | Per-frame | Linear | Pointer move |

---

## Implementation Phases

| Phase | What | Effort |
|-------|------|--------|
| **1 — Shell scaffold** | ShellScene type, canvas swap (shell ↔ cart), registry read/write (OPFS), system app slots hardcoded, slot grid quads rendered (no thumbnails yet), SDF labels | ~2 sessions |
| **2 — Cartridge viewer** | Cartridge mesh (procedural), label texture upload, idle spin/bob animation, selection transition (swap in/out) | ~1 session |
| **3 — Thumbnails** | thumbnailDataUrl caching in registry, texture upload from data URL per tile, refresh on install | ~1 session |
| **4 — Local cart install** | File picker, .frogcart drag-drop, unpack manifest, cache thumbnail, add to registry, display in grid | ~1 session |
| **5 — Illustrations dashboard** | Project registry (OPFS), sketchbook mesh, Illustrator system app slot, grid sub-navigation (breadcrumb + back), New/Open/Rename/Delete/Duplicate project flows, thumbnail capture on save | ~2 sessions |
| **6 — Remote cart install** | CartManifest fetch by URL, first-launch binary download, OPFS cache, hash verification | ~1 session |
| **7 — Auto-update flow** | Update check on launch, apply/prompt logic, lastChecked throttle, update badge in slot | ~1 session |
| **8 — Polish** | Background environment (particle drift), parallax effect, hover lift, transition animations, screen wipe | ~1 session |
| **9 — System app panels** | Settings overlay (including Install by URL), Illustrator → New Project routing signal to Frogmarks, Export as Cart from Illustrator | Frogmarks-side |

Phases 1–8 are Salsa engine + thin Frogmarks wiring. Phase 9 is Frogmarks-side panel work.

---

## Open Questions

**Q: How does a cart get a thumbnail?**  
When a user exports a `.frogcart` from Frogmarks, `packProject()` already captures a 512px JPEG thumbnail (via `captureDocumentBoundsToBlob`) and stores it in `manifest.thumbnail` as a base64 data URL. The shell reads this on install and caches it in `thumbnailDataUrl`. For remote carts, the CartManifest provides a `thumbnailUrl` which is fetched and converted to a data URL on install.

**Q: What happens when a cart is opened from outside the shell (e.g. a direct URL)?**  
The shell should still initialize and briefly show the cart in the viewer before auto-launching. This gives the shell a chance to add the cart to the registry ("add to your shell?") and preserves the visual continuity of the cartridge metaphor.

**Q: Can the user reorder slots?**  
Yes. Drag-reorder within the slot grid. The `order` field in `ShellSlot` is updated in the registry. System app slots are exempt from reordering (they stay pinned at the front).

**Q: Multiplayer carts — how does the runtime know it needs a connection?**  
The `requiresNetwork: true` flag in the ShellSlot. If the device is offline when launching a `requiresNetwork` cart, the shell blocks the launch and shows an error. The cart runtime itself also needs to handle dropped connections, but that is the cart author's responsibility (via the `httpRequest` Action and state machine's `onError` path).

**Q: Can carts be shared peer-to-peer without hosting a manifest URL?**  
Yes, for local carts: export `.frogcart` → share file → recipient drags into their shell. This is the "physical cartridge trading" flow. No server needed.

**Q: What is the relationship between a `.frogmarks` project and a `.frogcart`?**  
A `.frogmarks` file is the raw editable work file (like a Photoshop `.psd`). A `.frogcart` is a packaged, distributable application (like an `.app` bundle). A project is "published" by exporting it as a cart — the export step strips editor-only metadata and packages it as a runtime. The "Export as .frogcart" action in the Illustrations dashboard `⋯` menu triggers this flow. The two formats are distinct; you can have a project without a corresponding cart (most users will), and carts can exist without a source project on the local device (carts installed by URL are just the distributable).

**Q: Should the Illustrator dashboard show carts that were built from local projects (linking them back)?**  
Possibly. If a project was exported as a cart and that cart is installed in the main shell, a subtle "Published" badge or link-back would be useful. Deferred — requires tracking a `sourceProjectId` field in `ShellSlot`. Out of scope for initial phases.
