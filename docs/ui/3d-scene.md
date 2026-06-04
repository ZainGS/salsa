# Frogmarks: 3D Scene UI Spec (Revised)
**Last Updated:** 2026-06-02  

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
| `createSprite3D(x,y,z,w?,h?,mat?)` | **NEW** | Add a billboard-capable flat quad to the scene |
| `enterWeightPaintMode3D(meshId,skeletonId,jointIndex)` | **NEW** | Enter weight-paint; shows joint heatmap |
| `paintWeightDab3D(meshId,jointIndex,verts,target,strength)` | **NEW** | Brush vertices toward target weight |
| `normalizeWeights3D(meshId)` | **NEW** | Normalize all vertex weights to sum 1.0 |
| `exitWeightPaintMode3D()` | **NEW** | Exit weight-paint; restore original vertex colors |
| `getVerticesNearPoint3D(meshId,wx,wy,wz,radius)` | **NEW** | World-space radius query for brush picking |

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
│                                     │
│ TEXTURE                             │
│  [thumbnail 64x64]                 │
│  [Upload] [Replace] [Clear]        │
│  [Checker]                          │
│                                     │
│ ▸ PS1 RETRO STYLE ──────────────── │
│ ▸ LIGHTING ─────────────────────── │
│                                     │
│ GLOBAL SCENE                        │
│ ▸ SKYBOX / BACKGROUND ─────────── │
│ ▸ FOG ──────────────────────────── │
│  Mode [Off ▾]  Color [■ #cccccc]  │
│  Near [5]  Far [20]               │
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
```

### PS1 Retro Style (Collapsible)

```ts
const defaults = Scene3DManager.PS1Defaults;
// Sliders:
sm.scene3d.setPS1Config({
  vertexJitter: 0.6,     // 0-2, default 0.8
  snapGridSize: 160,     // 64-512, default 160
  colorDepth: 32,        // 8-256, default 32
  affineWarp: 0.5,       // 0-1, default 0.5 (texture warping)
});
```

| Parameter | Range | Default | Description |
|---|---|---|---|
| `vertexJitter` | 0–2 | 0.8 | Vertex snapping intensity (PS1 wobble) |
| `snapGridSize` | 64–512 | 160 | Grid resolution for vertex snapping |
| `colorDepth` | 8–256 | 32 | Color quantization levels |
| `affineWarp` | 0–1 | 0.5 | Affine texture mapping distortion |

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

// 3. Set the PS1 aesthetic
sm.scene3d.setPS1Config({ vertexJitter: 0.6, snapGridSize: 160, colorDepth: 32 });

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
