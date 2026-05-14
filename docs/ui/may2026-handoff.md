# Frogmarks UI Handoff — May 2026
**Last Updated:** 2026-05-10  

**Date:** 2026-05-10  
**Covers:** New engine APIs added in this session (brush bleed, brush smudge, Salsa Viewer web component, keyframe undo/redo).

---

## 1. Brush Bleed / Diffusion

Paint can now spread/bleed beyond the stroke edge, simulating wet-on-wet watercolor or ink diffusion.

### Settings interface

```typescript
interface BleedSettings {
  enabled: boolean;
  /** Blur radius in pixels (1–32). Higher = more spread. */
  radius: number;
  /** Blend strength of the blurred result (0–1). */
  strength: number;
  /** true = apply blur after every dab (live spread). false = apply once at end of stroke. */
  perDab: boolean;
}
```

### ShapeManager API

```typescript
shapeManager.setBrushBleed(presetId: string, settings: BleedSettings): boolean
```

### Recommended UI

- Checkbox "Bleed" in the brush panel (maps to `enabled`)
- Slider "Radius" 1–32 px (maps to `radius`)
- Slider "Strength" 0–100% (maps to `strength`)
- Toggle "Per Dab / End of Stroke" — "Per Dab" is more dramatic/real-time, "End of Stroke" is cheaper

### Example

```typescript
shapeManager.setBrushBleed('watercolor-wash', {
  enabled: true,
  radius: 8,
  strength: 0.6,
  perDab: false, // apply once when stroke ends
});
```

---

## 2. Brush Smudge (Color Mixing)

The smudge tool mixes the current canvas color under the cursor into the stroke color, creating a finger-smear / blending effect.

**Implementation note:** GPU readback is async, so there is a 1-dab lag before the picked-up canvas color takes effect. This is intentional and prevents GPU pipeline stalls.

### Settings interface

```typescript
interface SmudgeSettings {
  enabled: boolean;
  /** How much of the canvas color mixes into the stroke (0–1). Higher = more smear. */
  strength: number;
  /** Radius of the pixel sample point (currently unused — samples 1px at dab center). */
  sampleRadius: number;
}
```

### ShapeManager API

```typescript
shapeManager.setBrushSmudge(presetId: string, settings: SmudgeSettings): boolean
```

### Recommended UI

- Checkbox "Smudge" in the brush panel (maps to `enabled`)
- Slider "Smear Strength" 0–100% (maps to `strength`)

> **Note:** Smudge and bleed can coexist on the same preset — smudge picks up color, bleed spreads it.

### Example

```typescript
shapeManager.setBrushSmudge('blending-brush', {
  enabled: true,
  strength: 0.8,
  sampleRadius: 1,
});
```

---

## 3. Salsa Viewer Web Component

The engine now ships a self-contained `<salsa-viewer>` custom element. Frogmarks can embed it in share pages or export previews with zero Angular dependency.

### Build

```bash
npm run build:viewer
# → dist-viewer/viewer.js  (single ES module, all deps bundled)
```

### Embed in any HTML page

```html
<script type="module" src="https://cdn.frogmarks.app/viewer/viewer.js"></script>

<salsa-viewer
  url="https://cdn.frogmarks.app/docs/my-scene.frogmarks"
  style="width: 800px; height: 600px;"
></salsa-viewer>
```

### Programmatic usage (Angular / React / vanilla JS)

```typescript
import { SalsaViewerElement } from '@zaings/salsa/viewer';

const viewer = document.querySelector('salsa-viewer') as SalsaViewerElement;

// Load from URL
viewer.setAttribute('url', 'https://...');

// Or load a Blob directly (e.g. from a file picker or OPFS)
const blob: Blob = /* ... */;
await viewer.load(blob);
```

### What the element renders

- **3D meshes** (box, sphere, plane, cylinder, torus, GLTF-imported)
- **Particle emitters** (ticking in real-time via rAF loop)
- **Raster layers** (composited behind 3D content with correct blend modes)
- **Mesh textures** from the TextureLibrary

### Loading states

The element handles three states automatically:

| State | What the user sees |
|-------|--------------------|
| **Loading** | CSS spinner overlay while the `.frogmarks` file downloads and parses |
| **Thumbnail shown** | The JPEG thumbnail embedded in the file is shown immediately while the 3D scene initializes |
| **Rendered** | Full WebGPU scene; thumbnail fades out |
| **No WebGPU** | If the browser doesn't support WebGPU, the thumbnail is shown as a static image fallback |

### Thumbnail auto-capture

`packProject()` now automatically captures a 512×512 JPEG thumbnail at save time and embeds it in the `.frogmarks` manifest. No extra call needed from Frogmarks — just call `packProject()` as before.

```typescript
// unchanged — thumbnail capture is now automatic
const blob = await shapeManager.packProject();
```

### SalsaViewerCore — programmatic access

If you need to control the viewer runtime directly (e.g. to set a camera position before rendering):

```typescript
import { SalsaViewerCore } from '@zaings/salsa/viewer';

const core = new SalsaViewerCore(canvas);
await core.init();
await core.loadUrl('https://...');
core.resize();

// Peek thumbnail without full parse (useful for list/gallery previews)
const thumb = await SalsaViewerCore.peekThumbnailFromBlob(blob);
// → returns base64 JPEG data URL, or null if no thumbnail
```

---

## 4. Keyframe Undo/Redo (3D Animation)

Setting and removing 3D mesh keyframes now participates in the `UndoManager3D` stack. Ctrl+Z / Ctrl+Y from Frogmarks will correctly undo/redo keyframe edits.

### What's covered

| Operation | Undo support |
|-----------|-------------|
| `scene3d.setMeshKeyframe(...)` | ✅ Undoes to previous keyframe value, or removes if keyframe was new |
| `scene3d.removeMeshKeyframe(...)` | ✅ Re-inserts the removed keyframe with original value + easing |
| `scene3d.clearMeshKeyframeTracks(...)` | ✅ Restores all tracks from before the clear |

### No API change needed

The undo push is internal. Frogmarks calls the same methods as before:

```typescript
shapeManager.scene3d.setMeshKeyframe(meshId, 'position', frame, [x, y, z], 'ease-in-out');
shapeManager.scene3d.removeMeshKeyframe(meshId, 'rotation', frame);
shapeManager.scene3d.clearMeshKeyframeTracks(meshId);

// Undo / redo (existing API, unchanged)
shapeManager.scene3d.undo3D();
shapeManager.scene3d.redo3D();
shapeManager.scene3d.canUndo3D; // boolean
shapeManager.scene3d.canRedo3D; // boolean
```

---

## 5. CDN Publish Flow (Frogmarks-side — ✅ Implemented)

The engine side is complete. Frogmarks needs to add:

1. **"Publish" button** in the document header
2. On click: call `packProject()` → upload the returned `Blob` to object storage (S3/R2/GCS)
3. Return a public URL, display a **share dialog** containing:

```html
<!-- Embed code shown to user -->
<salsa-viewer url="https://cdn.frogmarks.app/docs/{docId}.frogmarks"
              style="width: 100%; height: 500px;"></salsa-viewer>

<script type="module"
  src="https://cdn.frogmarks.app/viewer/viewer.js"></script>
```

4. Optional: add a "Copy embed code" button

The engine export is already compressed (fflate ZIP). No server processing needed — just a PUT to object storage with `Content-Type: application/zip`.

---

## Type reference

All types below are exported from `@zaings/salsa`:

```typescript
import type {
  BleedSettings,
  SmudgeSettings,
} from '@zaings/salsa';

import type {
  SalsaViewerElement,
  SalsaViewerCore,
} from '@zaings/salsa/viewer'; // only available in viewer build
```

To import the viewer custom element in an Angular app (side-effect import):

```typescript
// In your AppModule or standalone component:
import '@zaings/salsa/viewer';
// → registers <salsa-viewer> globally
```
