# Salsa Packaging System — Spec

**Status:** Not yet started  
**Last Updated:** 2026-06-09

A packaging design and order-submission system built on Salsa's renderer. Lets creators build custom packaging configurators: the user draws artwork on a flat dieline, watches it fold into a 3D box, and submits an order via a custom endpoint — all inside a `.frogcart` experience.

---

## Vision

A print shop builds a Frogmarks scene. Their customer opens it in the Frogmarks Player, draws on a flat dieline canvas (adds their logo, picks colors, types a name), clicks a button, and the dieline folds into a 3D box in front of them. They review it, fill in quantity and shipping, hit Submit. The order arrives at the shop's API. No web dev required on the shop's side — just Frogmarks.

This is only possible because the dieline canvas IS the UV texture of the 3D mesh. Drawing on the flat canvas and watching it appear on the folded box is the same operation. There is no "export then re-import" step.

---

## Module Boundary

### What goes into Salsa core

These additions are general-purpose — useful beyond packaging — and belong in Salsa proper:

| Addition | Why it's general |
|----------|-----------------|
| `httpRequest` Action type in the UI system | Any app-in-frogcart needs to call external APIs |
| `FoldMesh` primitive | Useful for pages, envelopes, origami, maps, folded menus |
| `LiveTextureMode` — raster layer auto-syncs to mesh diffuse | Useful for any "draw on a 3D surface" workflow |

### What goes into `src/packaging/`

These are packaging-specific and should live in a dedicated subdirectory `src/packaging/`. It imports from Salsa core and extends it with packaging-domain logic. It can be extracted to a separate npm package (`salsa-packaging`) later if the feature is productized, but starting as a subdirectory avoids build complexity while the API is still forming.

| Component | Description |
|-----------|-------------|
| `DieligneTemplate` | Standard box type generators (tuck-end, sleeve, mailer, etc.) |
| `PackagingNode` | High-level scene node wrapping FoldMesh + dieline canvas |
| Dimension-driven geometry | W×H×D → auto-generated net geometry + UV mapping |
| Safe zone / bleed overlay | Canvas guides drawn over the dieline |
| Print-ready export | Flatten canvas to UV map, export PNG / print-ready PDF |
| ShapeManager packaging extension | Public API mounted at `sm.packaging.*` |

---

## Core Salsa Additions

### 1. `httpRequest` Action

Add to the `Action` union in `ui-system.md` and its runtime executor:

```typescript
| {
    type: 'httpRequest';

    /** Full URL. May include template variables: {{variableId}} is replaced at runtime. */
    url: string;

    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

    /**
     * Request body. Keys are literal strings or {{variableId}} tokens.
     * Nested objects allowed. Evaluated at transition-fire time.
     */
    body?: Record<string, unknown>;

    /** Static headers (e.g. Authorization). Do not put secrets here — use emitEvent for that. */
    headers?: Record<string, string>;

    /**
     * On success (2xx): fire this transition (optional).
     * The response body is stored in variableId (if set) as a JSON string.
     */
    onSuccess?: { stateId?: string; variableId?: string };

    /**
     * On failure (non-2xx or network error): fire this transition (optional).
     * The error message is stored in variableId (if set).
     */
    onError?: { stateId?: string; variableId?: string };
  }
```

**Implementation:** The action executor calls `fetch(url, { method, body, headers })` inside a try/catch. Template variables in `url` and `body` are resolved from the state machine's variable store before the call. The action is fire-and-forget from the state machine's perspective; `onSuccess`/`onError` fire as synthetic state transitions when the Promise settles.

**Security note:** Never put API keys directly in `body` or `headers` — those fields are visible in the `.frogcart` ZIP. The intended pattern for authenticated endpoints is `emitEvent` → host page → host makes the authenticated request. `httpRequest` is for unauthenticated or token-in-variable flows (e.g. the user's session token is stored in a variable).

---

### 2. `FoldMesh` Primitive

A scene node representing a flat sheet divided into panels by crease lines. Each crease has a `foldAngle` property that animates the panel on one side of it. At `foldAngle = 0` all panels are coplanar (the flat net). At target angles the net forms the 3D shape.

#### Data model

```typescript
interface FoldCrease {
  id: string;

  /** Index of vertex pair in panelVertices that defines this crease line. */
  vertexA: number;
  vertexB: number;

  /**
   * Current fold angle in degrees. 0 = flat. 90 = right angle. 180 = folded back.
   * Negative values fold in the opposite direction.
   */
  foldAngle: number;

  /** Which panel (by index in FoldMeshData.panels) rotates around this crease. */
  foldedPanelIndex: number;

  /** Whether child creases (attached to the folded panel) rotate with it. Default true. */
  cascades: boolean;
}

interface FoldPanel {
  id: string;
  name: string; // "front", "back", "left-side", "top-flap", etc.

  /**
   * Vertex indices (into FoldMeshData.vertices) forming this panel's outline.
   * Assumed to be a convex or simple polygon; triangulated by FoldMesh on compile.
   */
  vertices: number[];

  /** UV coordinates parallel to vertices[]. Maps panel area to dieline texture space. */
  uvs: [number, number][];

  /** Index of parent crease. -1 for the root panel (stays fixed in world space). */
  parentCreaseIndex: number;
}

interface FoldMeshData {
  /** Flat 2D vertex positions in the unfolded net, in dieline units (mm or px). */
  vertices: [number, number][];

  panels: FoldPanel[];
  creases: FoldCrease[];

  /** Physical dimensions of the dieline canvas in pixels. Used for UV normalization. */
  dielineWidth: number;
  dielineHeight: number;
}
```

#### Node

```typescript
class FoldMesh extends Mesh3D {
  data: FoldMeshData;

  /**
   * Set the fold angle of a single crease (by id or index).
   * If the crease has cascades=true, all child creases move with it.
   * Marks gpuDirty so the renderer re-uploads geometry.
   */
  setCreaseFoldAngle(creaseId: string, angleDeg: number): void;

  /**
   * Set all crease fold angles simultaneously (e.g. from a keyframe).
   * More efficient than calling setCreaseFoldAngle in a loop.
   */
  setAllFoldAngles(angles: Record<string, number>): void;

  /**
   * Compile the current fold state into a MeshGeometry.
   * Called automatically before each GPU upload when geometry is dirty.
   * Can be called manually to read vertex positions for e.g. collision.
   */
  compile(): MeshGeometry;
}
```

#### Keyframing

`FoldMesh` integrates with the existing `Mesh3DKeyframeTracks` system. Crease fold angles are exposed as keyframeable tracks named `crease:{id}`. The animation player calls `setAllFoldAngles` at each frame. This means the fold-flat → fold-box animation is authored in the standard timeline and driven by `AnimationPlayer3D` — no special animation system needed.

```typescript
// Example: author a fold animation
sm.setMeshKeyframe3D(meshId, 'crease:top-flap', 0,  0);    // frame 0: flat
sm.setMeshKeyframe3D(meshId, 'crease:top-flap', 30, 90);   // frame 30: closed
```

#### Geometry compilation

The geometry compiler works in two passes:

1. **Transform pass**: Traverse the panel tree (root → children via `parentCreaseIndex`). For each crease in order from root, build a rotation matrix around the crease axis (the 3D line through `vertexA` and `vertexB` in the current world position of the parent panel). Apply it to all vertices in the folded panel (and recursively to all descendant panels if `cascades = true`).

2. **Triangulate pass**: For each panel, fan-triangulate its vertex polygon. Emit position, normal (computed from the panel's current world plane), UV, and tangent per triangle vertex.

Normals and tangents are recomputed from the folded geometry on every compile, ensuring lighting is correct regardless of fold angle.

---

### 3. `LiveTextureMode`

A mode on a `Mesh3D` (or `FoldMesh`) where a designated raster layer is kept in sync with the mesh's diffuse GPU texture in real time.

```typescript
// Enable: rasterLayerId's GPU texture becomes mesh's diffuse texture.
// After each raster stroke-end, the layer pixels are re-uploaded to the mesh diffuse.
sm.enableLiveTexture3D(meshId: string, rasterLayerId: string): void;

// Disable: mesh returns to whatever diffuseTexture it had before.
sm.disableLiveTexture3D(meshId: string): void;

// Query
sm.getLiveTextureSource3D(meshId: string): string | null; // rasterLayerId or null
```

**Implementation:** `enableLiveTexture3D` registers a `postStrokeCallback` on the `RasterLayerManager` for `rasterLayerId`. On each callback, it calls `renderer3D.setMeshTexture(meshId, layer.texture)` — which is a zero-copy operation since `layer.texture` is already a `GPUTexture`. The overhead is one `setBindGroup` update per stroke-end. No pixel readback, no CPU round-trip.

The raster layer and the mesh live in different coordinate spaces: the layer is in canvas pixels; the mesh UV maps to dieline space. The UV mapping (set when `FoldMesh` is constructed from a dieline template) already handles the correspondence. The user draws on the raster canvas exactly where they see the dieline; the UV ensures it appears in the right place on the 3D mesh.

**Constraint:** The raster layer's pixel dimensions must match the `FoldMeshData.dielineWidth × dielineHeight`. `enableLiveTexture3D` throws if they don't match.

---

## `src/packaging/` — Packaging Module

### Dieline Templates

A template is a pure function: given box dimensions and bleed, it returns a `FoldMeshData` and a set of guide annotations.

```typescript
interface DieligneParams {
  /** Outer dimensions of the finished box in millimeters. */
  width: number;
  height: number;
  depth: number;

  /** Bleed margin in mm (artwork extends this far beyond the cut line). Default 3. */
  bleed?: number;

  /** Glue tab width in mm. Default 10. */
  tabWidth?: number;

  /** DPI for converting mm to pixels in the raster canvas. Default 300. */
  dpi?: number;
}

interface DieligneResult {
  foldMeshData: FoldMeshData;

  /** Canvas size in pixels (at the specified DPI) for the raster layer. */
  canvasWidth: number;
  canvasHeight: number;

  /** Guide lines to draw as a canvas overlay (cut lines, fold lines, bleed boundary). */
  guides: DieligneGuide[];

  /** Human-readable panel names for the Frogmarks UI. */
  panelLabels: Record<string, string>; // panelId → display name
}

type DieligneGuideType = 'cut' | 'fold' | 'bleed' | 'safeZone';

interface DieligneGuide {
  type: DieligneGuideType;
  /** Line segments in canvas pixel coordinates. */
  segments: [[number, number], [number, number]][];
  color: string; // CSS color for the overlay
}
```

#### Built-in templates

```typescript
// Straight tuck-end box (most common retail box)
import { straightTuckEnd } from 'salsa/packaging/templates/straight-tuck-end';

// Reverse tuck-end (top and bottom tuck in opposite directions)
import { reverseTuckEnd } from 'salsa/packaging/templates/reverse-tuck-end';

// Sleeve (wrap-around, no top/bottom flaps)
import { sleeve } from 'salsa/packaging/templates/sleeve';

// Mailer / shipper box (self-locking bottom, tuck-in top)
import { mailerBox } from 'salsa/packaging/templates/mailer-box';

// Pillow / gusset bag (rounded side gussets)
import { pillowBox } from 'salsa/packaging/templates/pillow-box';

// Two-piece (lid + tray, like a gift box)
import { lidAndTray } from 'salsa/packaging/templates/lid-and-tray';
```

Each template function takes `DieligneParams` and returns `DieligneResult`. The geometry for the 3D counterpart (the closed box) is embedded in the same file — it's the same vertex set as the net, just with all fold angles at their target values.

---

### `PackagingNode`

A high-level scene node that wraps a `FoldMesh`, its raster canvas layer, and the guide overlay. Created via the packaging API rather than directly.

```typescript
interface PackagingNodeState {
  id: string;
  name: string;
  templateType: 'straightTuckEnd' | 'reverseTuckEnd' | 'sleeve' | 'mailerBox' | 'pillowBox' | 'lidAndTray';
  params: DieligneParams;
  rasterLayerId: string;    // the dieline canvas layer
  foldMeshId: string;       // the FoldMesh scene node
  guideLayerId: string;     // the overlay canvas layer (cut/fold line guides)
  foldAnimationClipId: string; // pre-generated clip: 0 → fully folded
  unfoldAnimationClipId: string;
}
```

---

### ShapeManager Packaging Extension

Mounted at `sm.packaging.*` and also aliased at the top level for convenience.

```typescript
// ── Setup ────────────────────────────────────────────────────

/**
 * Create a packaging node from a template.
 * Generates: FoldMesh, raster layer (blank at DPI resolution),
 * guide overlay layer, LiveTextureMode binding, and fold/unfold animation clips.
 * Returns the PackagingNodeState.
 */
sm.packaging.create(
  templateType: PackagingNodeState['templateType'],
  params: DieligneParams,
  name?: string,
): PackagingNodeState;

/**
 * Remove a packaging node and all associated resources.
 */
sm.packaging.remove(packagingId: string): void;

/**
 * Update dimensions and regenerate geometry.
 * Preserves raster canvas content (resizes with anchor top-left).
 */
sm.packaging.setDimensions(packagingId: string, params: DieligneParams): void;

/**
 * Get current state.
 */
sm.packaging.get(packagingId: string): PackagingNodeState | null;
sm.packaging.getAll(): PackagingNodeState[];

// ── Fold control ─────────────────────────────────────────────

/**
 * Animate from flat (0) to fully folded (1) over durationMs.
 * Drives the pre-generated fold animation clip.
 */
sm.packaging.fold(packagingId: string, durationMs?: number): void;

/**
 * Animate from fully folded back to flat.
 */
sm.packaging.unfold(packagingId: string, durationMs?: number): void;

/**
 * Set fold position directly (0 = flat, 1 = fully folded). No animation.
 */
sm.packaging.setFoldAmount(packagingId: string, amount: number): void;

// ── Guide overlay ─────────────────────────────────────────────

sm.packaging.showGuides(packagingId: string): void;
sm.packaging.hideGuides(packagingId: string): void;

/**
 * Toggle visibility of individual guide types.
 */
sm.packaging.setGuideVisibility(
  packagingId: string,
  type: DieligneGuideType,
  visible: boolean,
): void;

// ── Export ────────────────────────────────────────────────────

/**
 * Export the dieline canvas as a flat PNG at full DPI.
 * Guides are NOT included (they are an overlay, not part of the artwork).
 * Bleed area IS included.
 */
sm.packaging.exportDielinePng(packagingId: string): Promise<Blob>;

/**
 * Export a print-ready PDF with:
 *   - Artwork layer (raster canvas flattened to CMYK approximation)
 *   - Die layer (cut + fold lines as vector paths, standard colors: cyan for fold, magenta for cut)
 *   - Bleed marks and registration marks
 *
 * The PDF is sized to the dieline canvas dimensions at the specified DPI.
 */
sm.packaging.exportPrintPdf(
  packagingId: string,
  options?: {
    includeBleedMarks?: boolean;   // default true
    includeRegistrationMarks?: boolean; // default true
    colorMode?: 'rgb' | 'cmyk-approx'; // default 'rgb'
  },
): Promise<Blob>;

/**
 * Export a 3D render of the folded box as a PNG.
 * Uses the current camera position and lighting.
 */
sm.packaging.exportFoldedRender(
  packagingId: string,
  width?: number,
  height?: number,
): Promise<Blob>;
```

---

## User Flow

The complete flow inside a `.frogcart` packaging experience:

```
1. CONFIGURE (state: "configure")
   ├── User picks box type from a shape-interaction menu
   ├── goToState("design") with the chosen template pre-set via setVariable
   └── PackagingNode is created (or pre-created by the author)

2. DESIGN (state: "design")
   ├── Dieline canvas is visible and active — user draws with Salsa's raster tools
   ├── FoldMesh is behind/beside the canvas, live-texture-synced (updates on each stroke-end)
   ├── "Preview fold" button → playAnimation("fold_preview") → box folds and unfolds
   └── "Next" button → goToState("order")

3. ORDER (state: "order")
   ├── HTML form elements: quantity, material, finish, shipping address
   ├── Variable bindings: orderQuantity, orderMaterial, orderFinish, etc.
   ├── 3D folded box is visible (rotating or static)
   ├── "Submit" button → httpRequest action:
   │     url: "https://your-api.com/orders"
   │     method: POST
   │     body: {
   │       quantity:  "{{orderQuantity}}",
   │       material:  "{{orderMaterial}}",
   │       finish:    "{{orderFinish}}",
   │       dielineB64: "{{dielineImageB64}}",   ← set by a prior action
   │     }
   │     onSuccess: { stateId: "confirmation" }
   │     onError:   { stateId: "orderError", variableId: "errorMessage" }
   └── goToState("confirmation") or goToState("orderError")

4. CONFIRMATION (state: "confirmation")
   └── Thank-you screen with order reference number
       (populated from httpRequest onSuccess variable)
```

**Attaching the dieline image to the order:** Before the `httpRequest` fires, a prior action in the transition calls `emitEvent({ eventName: "captureArtwork" })`. The Frogmarks host page listens, calls `sm.packaging.exportDielinePng(packagingId)`, base64-encodes it, and calls `sm.setUIVariable(layerId, 'dielineImageB64', base64String)`. Then the `httpRequest` fires with the image embedded. This two-step (emitEvent → capture → httpRequest) is the intended pattern for anything that requires async Salsa API calls before submission.

Alternatively, if the creator controls the Player page, they can wire this up more tightly. For a fully self-contained frogcart with no host page, a future `captureArtwork` Action type could be added that captures the export and stores it directly in a variable.

---

## Serialization

`PackagingNodeState` is serialized as a new section in `scene3d.json` inside the `.frogmarks` / `.frogcart` archive:

```json
{
  "nodes": [...],
  "skeletons": [...],
  "globalScene": {...},
  "packagingNodes": [
    {
      "id": "pkg-1",
      "templateType": "straightTuckEnd",
      "params": { "width": 80, "height": 120, "depth": 30, "bleed": 3, "dpi": 300 },
      "rasterLayerId": "layer-abc",
      "foldMeshId": "mesh-xyz",
      "guideLayerId": "layer-guides",
      "foldAnimationClipId": "clip-fold",
      "unfoldAnimationClipId": "clip-unfold"
    }
  ]
}
```

The `FoldMesh` itself serializes as a normal `Mesh3D` node in `nodes[]` with `type: 'FoldMesh'` and its `FoldMeshData` in `config.foldMeshData`. The raster canvas layer serializes normally in `layers/*.bin`. The guide layer serializes as a vector or raster layer.

---

## Frogmarks Editor Integration

### Packaging Panel

When a `PackagingNode` is selected (or created):

```
▸ PACKAGING ─────────────────────────────
  Template   [Straight Tuck-End ▾]
  Width      [80   mm]
  Height     [120  mm]
  Depth      [30   mm]
  Bleed      [3    mm]
  DPI        [300     ]

  [✓] Show guides    Cut [■]  Fold [■]  Bleed [■]

  ──────────────────────────────────────
  [▶ Fold Preview]  [↺ Unfold]

  ──────────────────────────────────────
  Export
  [↓ PNG (flat)]   [↓ Print PDF]   [↓ 3D Render]
```

### State Machine Integration

Pre-built action presets in the State Machine Editor's action picker:

- **Fold box** → `playAnimation(foldClipId)`
- **Unfold box** → `playAnimation(unfoldClipId)`
- **Submit order** → `httpRequest` template pre-filled with standard order fields

---

## Implementation Phases

### Phase 1 — FoldMesh primitive (~2 sessions)

- `FoldMeshData` types in `src/scene-graph/shapes/fold-mesh.ts`
- Geometry compiler (transform pass + triangulate pass)
- Keyframeable crease tracks wired into `Mesh3DKeyframeTracks`
- `sm.createFoldMesh3D(data)`, `sm.setCreaseFoldAngle3D(meshId, creaseId, angle)`

### Phase 2 — LiveTextureMode (~1 session)

- `enableLiveTexture3D` / `disableLiveTexture3D` on ShapeManager
- Post-stroke callback in RasterLayerManager
- Zero-copy GPU texture update (no pixel readback)

### Phase 3 — `httpRequest` Action (~1 session)

- Add `httpRequest` to UI system Action type union
- Implement in state machine action executor (fetch + Promise → synthetic transitions)
- Template variable substitution in URL and body

### Phase 4 — Dieline templates (~2 sessions)

- `src/packaging/templates/` directory
- Implement `straightTuckEnd` and `mailerBox` first (highest demand)
- Guide generation (cut/fold/bleed line segments)
- `DieligneParams` → `FoldMeshData` + canvas dimensions

### Phase 5 — PackagingNode + ShapeManager extension (~2 sessions)

- `PackagingNode` type and lifecycle (create, remove, setDimensions)
- Auto-generate fold/unfold animation clips from template target angles
- Guide overlay layer management
- `sm.packaging.*` API surface

### Phase 6 — Export (~1–2 sessions)

- `exportDielinePng` — flatten raster layer to Blob
- `exportFoldedRender` — canvas capture of the 3D viewport
- `exportPrintPdf` — PDF with artwork + die layers
  (PDF generation: use `pdf-lib` or a similar zero-dependency library; embed raster artwork as image, add die lines as vector paths)

### Phase 7 — Frogmarks editor panel (~2 sessions)

- Packaging panel with dimension inputs and template picker
- Guide visibility toggles
- Fold preview button
- Export buttons wired to `sm.packaging.export*`

### Phase 8 — Additional templates (ongoing)

- `reverseTuckEnd`, `sleeve`, `pillowBox`, `lidAndTray`
- Each is a few hours per template once the template API is stable

---

## Open Questions

**Q: Should the user be able to draw directly on the 3D folded box (not just the flat dieline)?**  
Possible via UV-reprojection paint (click on the 3D surface → MeshPicker returns UV coords → paint at those UV coords on the raster layer). MeshPicker already returns `baryU`/`baryV`. This would be a Phase 9 enhancement and requires computing UV from barycentric coords at the hit triangle.

**Q: Should `foldAmount` be a single global parameter or per-crease?**  
Per-crease is more expressive and already how `FoldMesh` works internally. But for simple boxes, a single `foldAmount` 0→1 that lerps all creases to their target angles simultaneously is what 99% of authors want. Implement both: `setFoldAmount(amount)` drives all creases proportionally; `setCreaseFoldAngle` gives fine-grained control.

**Q: CMYK export accuracy?**  
True CMYK requires ICC profile conversion which is non-trivial in a browser. `exportPrintPdf` in Phase 6 will use sRGB-to-CMYK approximation (subtract from 1, scale). For professional print accuracy, the PNG export + external conversion in the print shop's RIP is the recommended path. Note this in the export UI.

**Q: Is `src/packaging/` the right location, or a separate repo/package?**  
Start as `src/packaging/` for simplicity. Extract to `packages/salsa-packaging/` (monorepo) when:
- A third party wants to use the packaging module without the full Salsa bundle
- The packaging template library grows large enough to warrant independent versioning
- A packaging-specific Frogmarks plan tier is introduced

The internal API surface (`sm.packaging.*`) doesn't change on extraction — it's just a build boundary shift.
