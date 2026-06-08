# Frogmarks: 3D Scene UI Spec (Revised)
**Last Updated:** 2026-06-07  

> **Date:** April 17, 2026  
> **Fixes:** Multi-mesh rendering, orbit damping, API additions  
> **Renames:** `'3d-divider'` → `'3d-scene'` everywhere

---

## Bug Fixes in This Build

1. **Multi-mesh rendering now works.** Previously only the first mesh was visible — a storage buffer stride mismatch (256 vs 176 bytes) caused mesh 1+ to read garbage data from the GPU. Fixed.

2. **Orbit controller damping now works.** `update()` was never called per-frame. Now runs via `preRenderCallback` and auto-schedules frames while momentum is active.

3. **Mesh3D nodes no longer culled.** They were being view-frustum culled because they had no 2D bounding box. Fixed — they now always appear in the render list.

---

## Terminology Change

| Old | New |
|---|---|
| `'3d-divider'` (type discriminator) | `'3d-scene'` |
| `add3DDivider()` / `remove3DDivider()` | `add3DScene()` / `remove3DScene()` (old names still work as aliases) |
| `addRaster3DDivider()` | `addRaster3DScene()` (old name still works) |
| "3D Divider" in UI | **"3D Scene"** |

The concept: the "3D Scene" is a layer stack entry that represents where 3D meshes render. Raster layers below it = background, raster layers above it = foreground. Users should think of it as "the 3D scene sits here in my layer stack."

**Insertion position:** `addRaster3DScene()` inserts the 3D Scene entry at the top of the layer stack (above all existing layers). All existing layers start behind 3D content. Drag any layer above the entry to place it in front of 3D. (Prior to 2026-06-06, the entry was incorrectly inserted at the middle of the stack.)

---

## New/Updated API Methods

### `shapeManager.scene3d.*` — Original (April 2026)

| Method | New? | Description |
|---|---|---|
| `resetCamera()` | **NEW** | Reset camera to default position `(0, 2, 5)` looking at origin |
| `setCameraMode(mode)` | **NEW** | Switch `'perspective'` / `'orthographic'` |
| `setFOV(degrees)` | **NEW** | Set field of view in degrees |
| `toggleOrbitControls(enabled?)` | **NEW** | Toggle orbit on/off without destroying controller |
| `getAllMeshes()` | **NEW** | Return all `Mesh3D` nodes in the scene |
| `deleteMesh(nodeId)` | **NEW** | Remove a mesh from the scene graph |
| `frameAllMeshes(padding?)` | **NEW** | Frame all meshes in current camera view |
| `frameMesh(nodeId, padding?)` | **NEW** | Frame one mesh in current camera view |
| `setMeshTexture(nodeId, source)` | **NEW** | Upload/apply diffuse texture to a mesh |
| `clearMeshTexture(nodeId)` | **NEW** | Remove diffuse texture from mesh |
| `createMeshGroup(name?)` | **NEW** | Create 3D mesh group container |
| `getMeshGroups()` | **NEW** | List all mesh groups |
| `addMeshToGroup(meshId, groupId)` | **NEW** | Parent mesh under a 3D group |
| `removeMeshFromGroup(meshId)` | **NEW** | Unparent mesh back to scene root |
| `enableOrbitControls(config?)` | Updated | Now properly wires `update()` per-frame for damping |

### `shapeManager.scene3d.*` — Added June 2026

| Method | New? | Description |
|---|---|---|
| `setFog3D(config)` | **NEW** | Set global fog (mode, near, far, density, color) |
| `getFog3D()` | **NEW** | Return current `FogConfig` |
| `setSceneBg3D(opts)` | **NEW** | Set global skybox / gradient / solid-color background |
| `getSceneBg3D()` | **NEW** | Return current `ArmatureBgOptions` |
| `setTextureFilterMode3D(mode)` | **NEW** | `'nearest'` (pixel-art) or `'linear'` (smooth) |
| `setEnvironmentMap3D(imageData, intensity?)` | **NEW** | Set equirectangular env map for IBL diffuse lighting |
| `clearEnvironmentMap3D()` | **NEW** | Remove env map; revert to ambient-color diffuse |
| `iblEnabled3D` | **NEW** | Read-only: `true` when IBL is active |
| `createSprite3D(x,y,z,w?,h?,mat?)` | **NEW** | Add a billboard-capable flat quad to the scene |
| `enterWeightPaintMode3D(meshId,skeletonId,jointIndex)` | **NEW** | Enter weight-paint; shows joint heatmap |
| `paintWeightDab3D(meshId,jointIndex,verts,target,strength)` | **NEW** | Brush vertices toward target weight |
| `normalizeWeights3D(meshId)` | **NEW** | Normalize all vertex weights to sum 1.0 |
| `exitWeightPaintMode3D()` | **NEW** | Exit weight-paint; restore original vertex colors |
| `getVerticesNearPoint3D(meshId,wx,wy,wz,radius)` | **NEW** | World-space radius query for brush picking |
| `addBlendShape3D(meshId,name,delta)` | **NEW** | Attach a morph target delta buffer; returns shape index |
| `setBlendWeight3D(meshId,index,weight)` | **NEW** | Set blend shape weight 0–1; evaluates immediately before skinning |
| `getBlendShapes3D(meshId)` | **NEW** | Return `{ name, weight }[]` for all shapes on a mesh |
| `removeBlendShape3D(meshId,index)` | **NEW** | Remove shape by index; re-evaluates remaining shapes |
| `setPostProcessing3D(config)` | **NEW** | Enable/configure bloom, color grade, vignette (partial update) |
| `getPostProcessing3D()` | **NEW** | Return current `PostProcessConfig` |
| `setRetroPreset3D(preset)` | **NEW** | Apply `'wobble'` / `'pocket'` / `'off'` preset to PS1Config; `'off'` zeroes all lo-fi params |
| `createNLATrack3D(skelId,name,fps?,loop?)` | **NEW** | Create a Non-Linear Animation track; returns track ID |
| `addNLASegment3D(trackId,clipId,startFrame,opts?)` | **NEW** | Place a clip on the NLA timeline; returns segment index |
| `removeNLASegment3D(trackId,segIndex)` | **NEW** | Remove a clip segment from an NLA track |
| `updateNLASegment3D(trackId,segIndex,updates)` | **NEW** | Patch weight, blendMode, fadeIn/fadeOut, etc. on a segment |
| `getNLATracks3D(skelId)` | **NEW** | Return all NLA tracks for a skeleton |
| `playNLATrack3D(trackId)` | **NEW** | Return AnimationPlayer3D that drives the track (starts paused) |
| `stopNLATrack3D(trackId)` | **NEW** | Stop and destroy the player for a track |
| `seekNLATrack3D(trackId,frame)` | **NEW** | Evaluate the track at a single frame without a player |
| `crossfade3D(trackId,fromSeg,toSeg,dur)` | **NEW** | Schedule a crossfade between two segments over N frames |
| `exportSceneGltf3D()` | **NEW** | Export all meshes + skeletons to a GLB `Blob`; returns `{ blob, meshCount, skeletonCount, animationCount, vertexCount }` |
| `snapMode3D` | **NEW** | `'none' \| 'grid' \| 'vertex'` — persistent snap mode; bind to panel dropdown |
| `getSnapTarget3D()` | **NEW** | World pos `[x,y,z]` of active vertex snap target during drag; `null` otherwise |
| `worldToScreen3D(pt)` | **NEW** | Project world `[x,y,z]` → canvas `[px,py]`; use for snap dot and angle label placement |
| `beginTransform3D(mode)` | **NEW** | Start a keyboard-driven transform (`'grab'`/`'rotate'`/`'scale'`) on the selected mesh; snapshots pre-transform state |
| `constrainAxis3D(axis)` | **NEW** | Lock the active shortcut to `'x'`/`'y'`/`'z'` |
| `appendNumericInput(char)` | **NEW** | Append one digit/`.`/`-` to the numeric input buffer (requires axis set first) |
| `commitTransform3D()` | **NEW** | Commit the shortcut transform; fires undo callbacks |
| `cancelTransform3D()` | **NEW** | Cancel the active shortcut (restores snapshot) **or** cancel a gizmo drag in-flight |
| `isShortcutActive3D` | **NEW** | `true` while a keyboard-driven transform is in progress |
| `shortcutMode3D` | **NEW** | Active shortcut mode (`'grab'`/`'rotate'`/`'scale'`) or `null` |
| `shortcutAxis3D` | **NEW** | Active axis constraint (`'x'`/`'y'`/`'z'`) or `null` |
| `shortcutNumericDisplay3D` | **NEW** | Current numeric input buffer (e.g. `"-4.5"`) for HUD display |

### `shapeManager.raster.*`

| Method | New? | Description |
|---|---|---|
| `add3DScene(name?)` | **NEW** | Preferred name for adding the 3D scene entry |
| `remove3DScene()` | **NEW** | Remove 3D scene entry |
| `get3DScene()` | **NEW** | Get `{ id, name }` or `null` |
| `has3DScene()` | **NEW** | Boolean check |

Old `add3DDivider` etc. still work as aliases.

---

## UI Design Guide: 3D Scene Panel

### Priority UX Improvements (Do These Next)

When the `3d-scene` entry is selected, prioritize these changes for a much better editing workflow:

1. **Mode strip at top of 3D panel:** `Select | Move | Rotate | Scale | Camera`
2. **Camera quick actions row:** `Frame All`, `Frame Selected`, `Reset`, projection toggle
3. **Mesh list with type chips + visibility/lock icons:** faster scan on large scenes
4. **Selection-aware panel body:**
  - No mesh selected: show scene controls (camera, lighting, PS1)
  - Mesh selected: show transform/material/texture controls first
5. **Texture slot UX:** thumbnail + `Upload`, `Replace`, `Clear`, `Use Checker`
6. **Group controls in list:** `Create Group`, drag mesh into group, collapse/expand groups
7. **Inline numeric scrubbers:** drag on X/Y/Z labels for fast transform tweaks
8. **Keep orbit available while editing:** hold `Alt` for temporary orbit even in transform modes

This should feel close to Spline/Blender interaction, but simplified for illustration workflows.

### When the 3D Scene Entry is Selected in the Layer List

When the user clicks the `3d-scene` entry in the layer panel, show the **3D Scene panel** in the right sidebar. This should feel like an integrated part of the layer workflow, not a separate mode.

### Layout

```
┌─────────────────────────────────────┐
│ 3D Scene                       [✕]  │  ← Header with remove button
├─────────────────────────────────────┤
│                                     │
│ VIEWPORT                            │
│ ┌─────────────────────────────────┐ │
│ │ 🎥 Camera                      │ │
│ │ [Perspective ▾]  [Frame All]    │ │
│ │ [Frame Selected] [Reset View]   │ │
│ │ FOV: [60°  ═══════●══]         │ │
│ │ Orbit: [ON ●]                   │ │
│ └─────────────────────────────────┘ │
│                                     │
│ MESHES                              │
│ ┌─────────────────────────────────┐ │
│ │ ⬡ box          [🗑]            │ │  ← click to select, purple = active
│ │ ● sphere        [🗑]            │ │
│ │ ▬ plane         [🗑]            │ │
│ └─────────────────────────────────┘ │
│ [+ Box] [+ Sphere] [+ Plane]       │
│ [+ Cylinder] [+ Torus] [+ Sprite]  │
│                                     │
│ ─── Selected Mesh: "sphere" ─────── │
│                                     │
│ TRANSFORM                           │
│  Pos   X [0.0] Y [0.0] Z [0.0]    │
│  Rot   X [0  ] Y [0  ] Z [0  ]    │
│  Scale X [1.0] Y [1.0] Z [1.0]    │
│                                     │
│ MATERIAL                            │
│  Color [■ #cc3333]  Opacity [100%] │
│  Roughness [0.5 ══════●═══]        │
│  Metalness [0.0 ●══════════]       │
│                                     │
│ TEXTURE                             │
│  [thumbnail 64x64]                 │
│  [Upload] [Replace] [Clear]        │
│  [Checker]                          │
│                                     │
│ ▸ BLEND SHAPES ─────────────────── │
│  smile     [0.0 ●═════════════]   │
│  blink_L   [0.0 ●═════════════]   │
│ ▸ PS1 RETRO STYLE ──────────────── │
│  Presets: [PS1] [3DS] [Off]        │
│  Jitter [0.8] Grid [160]           │
│  Dither [●] UV Quantize [●]        │
│  Lo-Res [●] [320]×[240]            │
│ ▸ LIGHTING ─────────────────────── │
│                                     │
│ GLOBAL SCENE                        │
│ ▸ SKYBOX / BACKGROUND ─────────── │
│ ▸ FOG ──────────────────────────── │
│  Mode [Off ▾]  Color [■ #cccccc]  │
│  Near [5]  Far [20]               │
│ ▸ ENVIRONMENT / IBL ─────────────  │
│  [Upload HDR / Equirect]           │
│  Intensity [1.0 ══════●══]        │
│  [Clear]                           │
│ ▸ TEXTURE SAMPLING ──────────────  │
│  [Nearest (PS1) ●] [Linear ○]     │
└─────────────────────────────────────┘
```

### Key UX Principles

1. **The 3D Scene entry in the layer list is NOT a paintable layer.** When selected, don't show brush options. Show the 3D panel instead.

2. **The 3D panel replaces the layer property area** (opacity slider, blend mode, etc.) when the 3D scene entry is selected. When a regular raster layer is selected, show the normal layer properties again.

3. **Mesh list should mirror the layer panel style** — same selection highlight color (purple), same click-to-select behavior. When a mesh is selected in the mesh list, update the Transform/Material sections.

4. **Orbit toggle should be prominent.** When orbit is ON, left-drag on the canvas orbits the camera (not painting). When OFF, tools work normally. Consider a keyboard shortcut (e.g., hold Alt to temporarily orbit).

5. **Camera section should be compact.** Most users won't touch FOV/projection — collapse by default, or make it a single row.

### Orbit Controls Interaction

```ts
// When user toggles orbit ON:
sm.scene3d.enableOrbitControls({
  radius: 5,
  elevation: 0.4,
  azimuth: 0,
  enableDamping: true,
  dampingFactor: 0.08,
});

// When user toggles orbit OFF:
sm.scene3d.disableOrbitControls();

// Temporary orbit (e.g., Alt+drag):
// Don't destroy/recreate — just toggle:
sm.scene3d.toggleOrbitControls(true);   // on alt-down
sm.scene3d.toggleOrbitControls(false);  // on alt-up
```

**Orbit controls now support damping/momentum.** When the user releases a drag, the camera coasts to a stop. This requires multiple frames — the engine handles this automatically via `preRenderCallback`. No Frogmarks action needed.

### Mesh Creation

```ts
// Each "Add Mesh" button:
sm.scene3d.createBox(0, 0, 0);        // places at origin
sm.scene3d.createSphere(0, 0, 0);
sm.scene3d.createPlane(0, 0, 0);
sm.scene3d.createCylinder(0, 0, 0);
sm.scene3d.createTorus(0, 0, 0);
sm.scene3d.createSprite(0, 0, 0);     // flat textured quad; upload a texture to show an image
// OR via shape-manager public API:
sm.createSprite3D(0, 0, 0, 1, 1);     // (x, y, z, width, height)

// Enable billboard mode so the sprite always faces the camera:
const sprite = sm.createSprite3D(0, 1, 0, 2, 2);
sprite.billboard = true;              // auto-updated by renderer each frame
```

A **Sprite** is a flat XY quad useful for placing images, decals, or billboards in 3D space. Apply a texture via `setMeshTexture` to show an image. Set `billboard: true` in the config (or `mesh.billboard = true` after creation) to make the sprite automatically face the camera every frame.

After creation, the mesh is auto-selected (`setSelectedNode` is called internally). Update the mesh list UI to reflect the new mesh.

### Mesh List

```ts
// Get all meshes for the list:
const meshes = sm.scene3d.getAllMeshes();
// Each mesh has: .id, .name, .meshPrimitive, .material, .x, .y, .z

// When user clicks a mesh in the list:
sm.setSelectedNode(mesh.id);

// Get currently selected mesh (if it's a Mesh3D):
const selected = sm.getSelectedNode();
if (selected?.getType() === '3DMesh') {
  // Show transform + material for this mesh
}

// Delete:
sm.scene3d.deleteMesh(mesh.id);
```

### Viewport Snapping

Ctrl+drag activates the current snap mode. Bind a panel dropdown to `snapMode3D`:

```ts
// Panel dropdown: "None" / "Grid" / "Vertex"
sm.snapMode3D = 'vertex'; // or 'grid' | 'none'
```

**Vertex snap indicator dot** — draw on the overlay canvas during drags:

```ts
// On pointermove (or in render loop):
const snap = sm.getSnapTarget3D();
if (snap) {
  const scr = sm.worldToScreen3D(snap);
  if (scr) {
    overlayCtx.beginPath();
    overlayCtx.arc(scr[0], scr[1], 6, 0, Math.PI * 2);
    overlayCtx.strokeStyle = '#00e5ff';
    overlayCtx.lineWidth = 2;
    overlayCtx.stroke();
  }
} else {
  // clear snap dot from previous frame
}
```

**Drag angle label** — `worldToScreen3D` also fixes the gizmo center projection:

```ts
const info = sm.getDragInfo3D();
if (info.isDragging && info.gizmoCenterWorld) {
  const [cx, cy] = sm.worldToScreen3D(info.gizmoCenterWorld) ?? [0, 0];
  showAngleLabel(`${info.angleDeg?.toFixed(1)}°`, cx, cy);
}
```

**SCSS snap badge** — reflect active mode (e.g. `.scene3d-snap-badge` text):

```ts
// "SNAP: VERTEX" / "SNAP: GRID" / "SNAP: OFF"
const modeLabel = sm.snapMode3D === 'none' ? 'OFF' : sm.snapMode3D.toUpperCase();
snapBadgeEl.textContent = `SNAP: ${modeLabel}`;
snapBadgeEl.classList.toggle('snap-active', sm.snapMode3D !== 'none' && sm.snapActive3D);
```

### Viewport Transform Shortcuts (G / R / S)

Frogmarks drives the shortcut state machine from its existing `@HostListener('document:keydown')` handler. Salsa owns all state; no second key listener is attached.

```ts
// In Frogmarks keydown handler:
if (is3DViewActive()) {
  if (e.key === 'g') { sm.beginTransform3D('grab');   e.preventDefault(); }
  if (e.key === 'r') { sm.beginTransform3D('rotate');  e.preventDefault(); }
  if (e.key === 's') { sm.beginTransform3D('scale');   e.preventDefault(); }

  if (sm.isShortcutActive3D) {
    if (e.key === 'x') { sm.constrainAxis3D('x'); e.preventDefault(); }
    if (e.key === 'y') { sm.constrainAxis3D('y'); e.preventDefault(); }
    if (e.key === 'z') { sm.constrainAxis3D('z'); e.preventDefault(); }
    if (e.key === 'Enter')  { sm.commitTransform3D(); e.preventDefault(); }
    if (/^[\d.\-]$/.test(e.key)) { sm.appendNumericInput(e.key); e.preventDefault(); }
  }

  if (e.key === 'Escape') sm.cancelTransform3D(); // also cancels in-flight gizmo drags
}
```

**HUD overlay** — use the read-only getters to render a status line while a shortcut is active:

```ts
// Example: "ROTATE  Z  -45.0°"
if (sm.isShortcutActive3D) {
  const mode  = sm.shortcutMode3D;       // 'grab' | 'rotate' | 'scale'
  const axis  = sm.shortcutAxis3D;       // 'x' | 'y' | 'z' | null
  const value = sm.shortcutNumericDisplay3D; // e.g. "-45" or ""
  showShortcutHUD(mode, axis, value);
} else {
  hideShortcutHUD();
}
```

Numeric input semantics: grab = world units, rotate = degrees, scale = multiplicative factor. Axis constraint is required before numeric input is accepted.

### Transform Inputs

```ts
// Position — when user changes X/Y/Z number inputs:
sm.scene3d.setPosition(meshId, x, y, z);

// Rotation — degrees in UI, the API takes radians:
sm.scene3d.setRotation(meshId, rx * Math.PI/180, ry * Math.PI/180, rz * Math.PI/180);

// Scale:
sm.scene3d.setScale(meshId, sx, sy, sz);
```

**Important:** Call these on every input change (debounce ~16ms or on `input` event, not just `change`). The engine re-renders on each call.

### Material

```ts
// Color picker:
sm.scene3d.setDiffuseColor(meshId, r, g, b);   // r,g,b in 0-1 range

// Opacity slider:
sm.scene3d.setOpacity(meshId, value);            // 0-1

// PBR material properties:
const mesh = sm.scene3d.getMesh(meshId);
mesh.material.roughness = 0.4;   // 0 = mirror-smooth, 1 = fully rough
mesh.material.metalness = 0.0;   // 0 = dielectric (plastic/stone), 1 = metallic
sm.scene3d.updateMeshMaterial(meshId, mesh.material);
```

These properties are used by the Cook-Torrance BRDF (GGX NDF + Smith geometry + Schlick Fresnel) that runs on the default render style. Cel/sketch/ink render styles ignore PBR and continue using their own shading functions.

| Property | Range | Default | Description |
|----------|-------|---------|-------------|
| `roughness` | 0–1 | 0.5 | Surface micro-roughness. 0 = mirror, 1 = chalk |
| `metalness` | 0–1 | 0.0 | Whether the surface conducts light. 0 = dielectric, 1 = metal |

**Render style** — controls the shading model for this mesh:

```ts
mesh.material.renderStyle = 'gouraud';   // PS1-style per-vertex lighting
sm.scene3d.updateMeshMaterial(meshId, mesh.material);
```

| Style | Description |
|-------|-------------|
| `'default'` | Cook-Torrance PBR (roughness + metalness used) |
| `'cel'` | Quantized toon shading; roughness/metalness ignored |
| `'sketch'` | Pencil-sketch cross-hatch overlay |
| `'ink'` | Screen-space ink outline pass |
| `'gouraud'` | PS1-authentic per-vertex ambient+diffuse; no per-pixel PBR cost. Pair with lo-fi preset for full PS1 look |

### Blend Shapes (Collapsible, per selected mesh)

Blend shapes allow smooth interpolation between the mesh's base geometry and any number of sculpted variants. Weights are 0–1 per shape. Evaluation runs on the CPU before skinning, so facial expressions compose with skeletal animation automatically.

```ts
// Get all blend shapes on the selected mesh:
const shapes = sm.getBlendShapes3D(meshId);
// → [{ name: 'smile', weight: 0 }, { name: 'blink_L', weight: 0 }, ...]

// Set a weight (0–1):
sm.setBlendWeight3D(meshId, 0, 0.7);    // 70% smile
sm.setBlendWeight3D(meshId, 1, 1.0);    // full left blink

// Add a custom shape programmatically (deltaVertices = Float32Array, 6 floats/vertex):
const idx = sm.addBlendShape3D(meshId, 'custom_frown', deltaVertices);

// Remove a shape by index:
sm.removeBlendShape3D(meshId, idx);
```

GLTF/GLB files from VRoid, Character Creator, Blender, etc. include morph targets automatically. They appear in `getBlendShapes3D` immediately after import, all at weight 0.

**UI for each shape:**
- Shape name label
- Weight slider `[0.0 ═══════●══]` (0 to 1)
- Numeric input for exact value

If the mesh has no blend shapes, hide this section entirely.

### PS1 Retro Style (Collapsible)

Apply a preset or configure parameters individually:

```ts
// One-shot presets:
sm.setRetroPreset3D('wobble');  // full wobble look: jitter + dither + UV quantize + 320×240
sm.setRetroPreset3D('pocket'); // pocket look: 400×240, clean (no dither or UV quantize)
sm.setRetroPreset3D('off');    // disable all lo-fi effects

// Fine-grained config (partial update — omitted fields are unchanged):
sm.scene3d.setPS1Config({
  vertexJitter: 0.6,
  snapGridSize: 160,
  colorDepth: 32,
  affineStrength: 0.5,
  renderResolution: [320, 240],
  dither: true,
  ditherStrength: 0.45,
  uvQuantize: true,
  uvQuantizeSteps: 64,
});
```

| Parameter | Range | Default | Description |
|---|---|---|---|
| `vertexJitter` | 0–2 | 0.8 | Vertex snapping intensity — the wobbly PS1 polygon creep |
| `snapGridSize` | 64–512 | 160 | Grid resolution for vertex snapping |
| `colorDepth` | 8–256 | 32 | Color quantization steps (lower = more banding) |
| `affineStrength` | 0–1 | 0.6 | Affine texture-mapping distortion (PS1 UV warping) |
| `renderResolution` | `[w, h]` | `undefined` | If set, renders 3D to this lo-res buffer and nearest-neighbor blits to canvas |
| `renderScale` | 0.1–1.0 | `undefined` | Alternative to `renderResolution`: scale factor relative to canvas size |
| `dither` | boolean | `false` | Enable ordered Bayer 4×4 dithering before color quantization |
| `ditherStrength` | 0–1 | 0.5 | Dither threshold spread (0 = none, 1 = maximum noise) |
| `uvQuantize` | boolean | `false` | Snap UV coordinates to a fixed-point grid before sampling |
| `uvQuantizeSteps` | 8–256 | 64 | Grid steps for UV quantization (lower = blockier textures) |

**PS1 preset values:** `vertexJitter=0.8`, `snapGridSize=160`, `affineStrength=0.6`, `colorDepth=32`, `renderResolution=[320,240]`, `dither=true ditherStrength=0.45`, `uvQuantize=true uvQuantizeSteps=64`

**3DS preset values:** `vertexJitter=0`, `snapGridSize=512`, `affineStrength=0`, `colorDepth=256`, `renderResolution=[400,240]`, `dither=false`, `uvQuantize=false`

**Panel layout** — recommended collapsible section:

```
▸ PS1 RETRO STYLE ─────────────────────
  Presets: [PS1] [3DS] [Off]
  ─────────────────────────────────────
  Vertex Jitter  [0.8 ═══════●═══════]
  Snap Grid      [160 ═══●═══════════]
  Color Depth    [32  ══●════════════]
  Affine Warp    [0.6 ════●══════════]
  ─────────────────────────────────────
  Lo-Res Buffer  [ON ●]
  Resolution     [320] × [240]
  ─────────────────────────────────────
  Dither         [ON ●]
  Dither Strength [0.45 ══●═══════]
  UV Quantize    [ON ●]
  UV Steps       [64  ════●══════════]
```

Note: `renderResolution` and `renderScale` are mutually exclusive. If both are set, `renderResolution` takes priority. Setting `renderScale: 0.5` on a 1920×1080 canvas produces a 960×540 lo-res buffer.

### Skybox / Scene Background (Collapsible, GLOBAL SCENE)

A global scene background rendered before all meshes. Replaces the canvas background color inside the 3D viewport. When the armature panel is open, the armature-specific background overrides this.

```ts
// Solid color background:
sm.scene3d.setSceneBg3D({ mode: 'solid', color1: [0.1, 0.12, 0.18, 1.0] });

// Vertical gradient (top → bottom):
sm.scene3d.setSceneBg3D({
  mode: 'gradient',
  color1: [0.1, 0.1, 0.3, 1.0],   // top
  color2: [0.6, 0.7, 1.0, 1.0],   // bottom
});

// Animated wavy procedural:
sm.scene3d.setSceneBg3D({ mode: 'wavy', color1: [0.72, 0.83, 0.91, 1], color2: [0.94, 0.92, 0.85, 1] });

// Clear (transparent / canvas shows through):
sm.scene3d.setSceneBg3D({ mode: 'none' });

// Read current background:
const bg = sm.scene3d.getSceneBg3D();   // ArmatureBgOptions
// OR via shape-manager public API:
sm.setSceneBg3D({ mode: 'solid', color1: [0.05, 0.05, 0.05, 1] });
sm.getSceneBg3D();                       // returns current ArmatureBgOptions
```

| Mode | Description |
|------|-------------|
| `'none'` | No background drawn; canvas background shows through |
| `'solid'` | Flat fill with `color1` |
| `'gradient'` | Top-to-bottom gradient, `color1` → `color2` |
| `'wavy'` | Animated domain-warped wave between `color1` and `color2` |

### Fog (Collapsible, GLOBAL SCENE)

Fog blends the rendered scene color toward a target color based on distance from the camera. Applied in fragment shaders for all mesh variants (textured, untextured, shadow, skinned).

```ts
// Linear fog — full effect at `far`, none at `near`:
sm.scene3d.setFog3D({ mode: 'linear', color: [0.7, 0.8, 0.9], near: 5, far: 30 });

// Exponential fog — denser as distance grows:
sm.scene3d.setFog3D({ mode: 'exponential', color: [0.8, 0.8, 0.8], density: 0.08 });

// Disable:
sm.scene3d.setFog3D({ mode: 'off' });
// OR via shape-manager public API:
sm.setFog3D({ mode: 'linear', color: [0.7, 0.8, 0.9], near: 5, far: 30 });
```

| Property | Type | Description |
|----------|------|-------------|
| `mode` | `'off' \| 'linear' \| 'exponential'` | Fog formula (default `'off'`) |
| `color` | `[r, g, b]` (0–1) | Fog color (default `[0.8, 0.8, 0.8]`) |
| `near` | number | Linear: fog starts at this world distance (default 5) |
| `far` | number | Linear: fog reaches full opacity at this distance (default 20) |
| `density` | number | Exponential: fog density factor (default 0.1) |

Defaults from `Scene3DManager.FogDefaults` or `ShapeManager.FogDefaults`.

### Environment Map / IBL (Collapsible, GLOBAL SCENE)

Image-Based Lighting (IBL) replaces the flat `ambientColor` diffuse term with a physically-accurate irradiance field derived from an equirectangular environment map. When enabled, the Cook-Torrance PBR fragment shader evaluates pre-projected spherical harmonics (L0+L1+L2, 9 coefficients) against the world-space surface normal.

```ts
// Load an equirectangular HDR/LDR image as ImageData and upload it:
const img = new Image();
img.src = 'forest_env.jpg';
await img.decode();
const canvas = document.createElement('canvas');
canvas.width = img.width;
canvas.height = img.height;
canvas.getContext('2d')!.drawImage(img, 0, 0);
const imageData = canvas.getContext('2d')!.getImageData(0, 0, img.width, img.height);

sm.setEnvironmentMap3D(imageData, 1.0);     // intensity default 1.0
// OR via scene3d:
sm.scene3d.setEnvironmentMap3D(imageData, 1.0);

// Check status:
console.log(sm.iblEnabled3D);   // true

// Remove and revert to flat ambient lighting:
sm.clearEnvironmentMap3D();
// OR pass null:
sm.setEnvironmentMap3D(null);
```

**How it works:**
1. `setEnvironmentMap3D` projects the equirectangular image to 9 RGB SH coefficients on the CPU using discrete solid-angle integration (Ramamoorthi & Hanrahan 2001 ZH pre-multiplication).
2. The coefficients are written to a 160-byte `IBLUniforms` GPU buffer at group 0 binding 2 (present on all pipelines).
3. The fragment shader evaluates the SH polynomial against `worldNormal` to produce an irradiance value, which replaces `ambientColor * albedo` in the diffuse term.
4. While IBL is active, `ambientColor` / `ambientIntensity` have no effect on the default render style.

**Performance:** The SH projection is a one-time CPU operation when the image is uploaded. GPU evaluation is a few dot products per fragment — cheaper than a cube map lookup.

**Non-default render styles (cel/sketch/ink):** IBL has no effect. Those styles use their own shading functions that take `ambientColor` directly.

### Post-Processing (Collapsible, GLOBAL SCENE)

Fullscreen effects applied after the entire scene (3D meshes + raster layers) is rendered. All effects are disabled by default.

```
┌─────────────────────────────────────┐
│ ▸ POST-PROCESSING ────────────────── │
│                                     │
│  BLOOM                              │
│  [ON ●] Threshold [0.80 ═══●═══]   │
│         Intensity  [1.0  ══●════]   │
│                                     │
│  COLOR GRADE                        │
│  [OFF ○] Brightness [ 0.00]         │
│          Contrast   [ 0.00]         │
│          Saturation [ 0.00]         │
│          Tint [■ #ffffff]           │
│                                     │
│  VIGNETTE                           │
│  [ON ●]  Intensity [0.45 ════●══]  │
│          Radius    [0.75 ══●════]   │
│          Softness  [0.45 ══●════]   │
└─────────────────────────────────────┘
```

```ts
// Bloom — good for glowing emissives, particle halos, backlit hair
sm.setPostProcessing3D({
  bloom: { enabled: true, threshold: 0.8, intensity: 1.2 },
});

// Color grade — warm cinematic look
sm.setPostProcessing3D({
  colorGrade: {
    enabled: true,
    contrast: 0.12,
    saturation: 0.15,
    brightness: 0.02,
    tint: [1.0, 0.97, 0.93],   // warm tint
  },
});

// Vignette — draw focus to the center
sm.setPostProcessing3D({
  vignette: { enabled: true, intensity: 0.45, radius: 0.7, softness: 0.4 },
});

// Read current config:
const pp = sm.getPostProcessing3D();

// Disable all effects:
sm.setPostProcessing3D({
  bloom:      { enabled: false },
  colorGrade: { enabled: false },
  vignette:   { enabled: false },
});
```

Effects chain in order: bloom → color grade → vignette. When all are disabled, zero GPU overhead (the stack is skipped entirely).

| Effect | Parameters | Notes |
|--------|-----------|-------|
| **Bloom** | `threshold` (0–1), `intensity` (≥0) | Bright-pixel extract + 9-tap Gaussian blur + additive composite |
| **Color grade** | `brightness`, `contrast`, `saturation` (–1 to +1); `tint` [r,g,b] | All in one pass; neutral defaults = pass-through |
| **Vignette** | `intensity` (0–1), `radius` (0–1), `softness` (0–1) | Radial darkening; combined with color grade pass |

### Non-Linear Animation — NLA (Per Skeleton)

An NLA track places multiple animation clips on a shared timeline. Clips can overlap and blend — earlier replace segments fade into later ones, and additive segments layer on top of the accumulated result. This is the primary way to build complex character animations (e.g., idle loop with a breathing additive layer, or a walk-to-run crossfade).

```
NLA Timeline (skeleton "Character"):
  ─────────────────────────────────────── frame →
  Track "Locomotion":
    [── idle ──────────] (replace, w=1, fadeOut=8)
                    [── walk ───────────────] (replace, w=1, fadeIn=8)

  Track "Breathing":
    [── breathe ──────────────────────────] (additive, w=0.6)
```

```ts
// 1. Create a track (binds the skeleton's current pose as the base/bind pose)
const trackId = sm.createNLATrack3D(skeletonId, 'Locomotion', 24, true);

// 2. Add clips as segments
const idleClip = skeleton.data.clips.find(c => c.name === 'idle');
const walkClip = skeleton.data.clips.find(c => c.name === 'walk');

sm.addNLASegment3D(trackId, idleClip.id, 0,  {
  weight: 1, blendMode: 'replace', fadeOut: 8,
});
sm.addNLASegment3D(trackId, walkClip.id, 16, {
  weight: 1, blendMode: 'replace', fadeIn: 8,
});

// 3. Add a breathing layer as additive
const breatheClip = skeleton.data.clips.find(c => c.name === 'breathe');
const breatheTrackId = sm.createNLATrack3D(skeletonId, 'Breathing', 24, true);
sm.addNLASegment3D(breatheTrackId, breatheClip.id, 0, {
  weight: 0.6, blendMode: 'additive',
});

// 4. Play tracks (both run simultaneously — each evaluates its skeleton independently)
const locoPlayer  = sm.playNLATrack3D(trackId);
const breathPlayer = sm.playNLATrack3D(breatheTrackId);
locoPlayer.play();
breathPlayer.play();

// Seek without a player (for scrubbing a timeline UI):
sm.seekNLATrack3D(trackId, 12);

// Crossfade two segments (ramps from→to over 10 frames):
sm.crossfade3D(trackId, 0, 1, 10);   // idle (seg 0) → walk (seg 1)

// Patch a segment's weight at runtime (e.g. breathing depth slider):
sm.updateNLASegment3D(breatheTrackId, 0, { weight: 0.3 });

// Stop:
sm.stopNLATrack3D(trackId);
sm.stopNLATrack3D(breatheTrackId);
```

**Blend modes:**
- `replace` — lerps the accumulated pose toward the segment's sampled pose, weighted by `effectiveWeight`. The first replace segment blends from the bind pose.
- `additive` — adds weighted delta `(segPose − bindPose)` on top of the replace result. Useful for secondary motion (breathing, eye blinks, secondary arm sway) that should layer over any locomotion state.

**Fade-in/out:** When `fadeIn > 0`, the segment's effective weight ramps 0 → `weight` over that many frames at the segment start. `fadeOut` ramps in reverse at the end. Use `crossfade3D` to schedule overlapping fades automatically.

**Bind pose:** Captured once when `createNLATrack3D` is called. All blending is relative to this pose. If you want to reset the bind pose (e.g. after posing the skeleton), call `createNLATrack3D` again for a fresh snapshot.

### Export to GLB

Exports all Mesh3D and Skeleton3D objects in the scene — including skinning, animation clips, and blend shapes — to a self-contained `.glb` file compatible with Blender, Unity, Unreal, and three.js.

```ts
// Trigger a "Save As" download from Frogmarks:
const result = sm.exportSceneGltf3D();
const url = URL.createObjectURL(result.blob);
const a = document.createElement('a');
a.href = url;
a.download = 'scene.glb';
a.click();
URL.revokeObjectURL(url);

// result also exposes summary stats:
console.log(`Exported ${result.meshCount} meshes, ${result.skeletonCount} skeletons, `
  + `${result.animationCount} animation clips, ${result.vertexCount} vertices`);
```

**What's included in the GLB:**
- All `Mesh3D` nodes (position, normal, UV, tangent, vertex color if painted)
- All `SkinnedMesh3D` nodes (above + joint indices + joint weights)
- All `Skeleton3D` nodes → GLTF skins with inverse bind matrices
- All `SkeletonAnimClip` entries → GLTF animations (rotation/translation/scale, LINEAR interpolation)
- Blend shapes → GLTF morph targets with initial weights and target names

**What's not included:**
- Raster layers, GP objects, particle emitters, post-processing
- GPU-side textures (material colors export as `baseColorFactor`)
- IK-solved poses (only keyframed FK channels)

**Limitations to communicate to users:**
- Cel/sketch/ink render styles export as standard PBR — appearance will differ in external tools
- NLA blend state is not exported; each individual `SkeletonAnimClip` exports as a separate animation

### Texture Sampling (Toggle, GLOBAL SCENE)

Controls whether GPU texture sampling uses nearest-neighbor (PS1 pixel art look) or bilinear filtering (smooth).

```ts
// PS1 nearest-neighbor (default, hard pixel edges):
sm.scene3d.setTextureFilterMode3D('nearest');

// Bilinear (smooth, no pixel aliasing):
sm.scene3d.setTextureFilterMode3D('linear');
// OR via shape-manager public API:
sm.setTextureFilterMode3D('linear');
```

Changing filter mode immediately invalidates all cached texture bind groups so the new sampler takes effect on the next frame. Affects all textured meshes and the shared atlas.

### Lighting (Collapsible, GLOBAL SCENE)

```ts
// Directional light:
sm.scene3d.setDirectionalLight(
  dx, dy, dz,    // direction vector (will be normalized in shader)
  r, g, b,       // color (0-1)
  intensity       // multiplier
);

// Ambient light:
sm.scene3d.setAmbientLight(r, g, b, intensity);
```

Default directional: `(0.3, -0.8, -0.5)` direction, white, intensity 1.0.  
Default ambient: `(0.15, 0.15, 0.2)`, intensity 1.0.

### Camera Controls

```ts
// Projection toggle:
sm.scene3d.setCameraMode('perspective');    // or 'orthographic'

// FOV (degrees):
sm.scene3d.setFOV(60);                     // default 60°

// Reset to default view:
sm.scene3d.resetCamera();                  // looks at origin from (0, 2, 5)

// Frame utilities:
sm.scene3d.frameAllMeshes();               // frame all meshes
sm.scene3d.frameMesh(meshId);              // frame selected mesh
```

### Grouping Controls

```ts
// Create group and parent meshes under it:
const g = sm.scene3d.createMeshGroup('Props');
sm.scene3d.addMeshToGroup(meshIdA, g.id);
sm.scene3d.addMeshToGroup(meshIdB, g.id);

// Unparent:
sm.scene3d.removeMeshFromGroup(meshIdA);

// List groups for outliner:
const groups = sm.scene3d.getMeshGroups();
```

### Texture Controls

```ts
// Apply texture from file input:
await sm.scene3d.setMeshTexture(meshId, file);

// Remove texture:
sm.scene3d.clearMeshTexture(meshId);
```

---

## Layer Panel Integration

### Layer Entry for 3D Scene

The `3d-scene` type entry should look **distinct** from raster layers:

```
╌╌╌╌╌╌╌ 🎲 3D Scene ╌╌╌╌╌╌╌╌ [✕]
```

- Uses `type === '3d-scene'` (was `'3d-divider'`)
- **Draggable** — user can drag it up/down to change which raster layers are BG vs FG
- **Not paintable** — clicking it shows the 3D panel, not brush controls
- The `[✕]` calls `sm.raster.remove3DScene()`
- Shows a horizontal rule / divider aesthetic — it visually separates BG layers (below) from FG layers (above)

### "+ Add" Dropdown

```
┌──────────────┐
│ 2D Layer     │   → sm.raster.addLayer()
│ 3D Scene     │   → sm.raster.add3DScene()  ← disabled if has3DScene()
│ Folder       │   → sm.raster.addFolder()
└──────────────┘
```

### Selecting the 3D Scene Entry

When the user clicks the 3D Scene entry in the layer list:

1. **Don't** call `sm.raster.selectLayer()` (it's not a paintable layer — no texture to paint on)
2. **Do** switch the right panel to show the 3D Scene controls (Camera, Meshes, Transform, Material, PS1, Lighting)
3. **Do** highlight it in the layer list as "active" (purple border or similar)
4. If a mesh was previously selected, keep it selected. If not, show just the Camera section and mesh list.

### Selecting a Raster Layer

When a raster layer is selected again:
1. Call `sm.raster.selectLayer(id)` as before
2. Switch the right panel back to normal layer properties (opacity, blend mode, etc.)
3. 3D Scene panel hides

---

## Example: Complete 3D Scene Setup

```ts
const sm = shapeManager;

// 1. Add the 3D scene to the layer stack
sm.raster.add3DScene();

// 2. Create a camera + enable orbit
sm.scene3d.createCamera({ position: [0, 2, 5], target: [0, 0, 0] });
sm.scene3d.enableOrbitControls({ radius: 5, elevation: 0.4 });

// 3. Set the PS1 aesthetic (preset or fine-grained)
sm.setRetroPreset3D('wobble');  // or: sm.scene3d.setPS1Config({ vertexJitter: 0.6, ... })

// 4. Add meshes
const box = sm.scene3d.createBox(0, 0.5, 0, 1, 1, 1, { diffuse: { r: 0.9, g: 0.2, b: 0.2, a: 1 } });
const sphere = sm.scene3d.createSphere(2, 0.5, 0, 0.5, 16, { diffuse: { r: 0.2, g: 0.5, b: 0.9, a: 1 } });
const ground = sm.scene3d.createPlane(0, 0, 0, 5, 5, { diffuse: { r: 0.3, g: 0.6, b: 0.3, a: 1 } });

// 5. Set lighting
sm.scene3d.setDirectionalLight(0.3, -0.8, -0.5, 1, 0.95, 0.9, 1.2);
sm.scene3d.setAmbientLight(0.15, 0.15, 0.2, 1);

// Users can now:
// - Orbit the camera with left-drag
// - Pan with right/middle-drag
// - Zoom with scroll wheel
// - Paint on raster layers above/below the 3D scene
```
