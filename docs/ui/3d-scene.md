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
| `getRenderStats3D()` | **NEW** | Perf-HUD stats: triangles/vertices/objects + per-category triangle breakdown + frame ms / fps / GPU name — see §Perf |
| `setLightAngles3D(azimuthDeg, elevationDeg)` | **NEW** | Aim the key light by **sun position** (az + elevation); keeps colour/intensity — see §Lighting |
| `getLight3D()` | **NEW** | Current key light: `{direction, azimuthDeg, elevationDeg, color, intensity}` (to init the UI) |
| `setLightIntensity3D(intensity)` | **NEW** | Key-light intensity only (preserves direction + colour) |
| `setLightColor3D(r,g,b)` | **NEW** | Key-light colour only (0..1; preserves direction + intensity) |
| `setDirectionalLight3D(dx,dy,dz,r?,g?,b?,intensity?)` | — | Raw: set the light's travel direction + colour + intensity |
| `setAmbientLight3D(r,g,b,intensity?)` | — | Constant ambient fill (no effect while IBL is on) |
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
| `snapMode3D` / `snapGridSize3D` / `snapAngle3D` / `snapScaleStep3D` | **NEW** | Snap **mode** + **increments** — cell size, rotate step (**RADIANS**, default π/12 = 15°), scale step. **All persist with the scene** (2026-06-24). Bind to the Snap panel; **on document load, read these back to populate the inputs** (the engine restores them, but the panel won't reflect them unless it reads — and it must not re-write its defaults over the restored values). |
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

**Vertex snap "double-circle" viz** (richer than the single dot) — an outer ring previews every snappable vertex as a square, an inner ring is the snap threshold, and the vertex that will snap is the **front-most** one (nearest the camera — so it never locks onto something hidden behind your model).

**Salsa renders this natively** — it's drawn inside the 3D viewport (billboarded, depth-always, so it sits on top of everything). **No Frogmarks drawing needed**: just set `snapMode3D = 'vertex'` and Ctrl-drag — the rings + orange candidate squares appear automatically. Tunables:

- `snapVertexRadiusPx3D` (default 20) — inner/snap radius (and inner circle).
- `snapCandidateRadiusPx3D` (default 50) — outer/preview radius (and outer circle).
- Candidate squares are capped to the ~40 nearest on screen so a dense mesh won't flood the view; the active (will-snap) one is bigger/brighter, the rest fade with depth.

If you'd rather draw your **own** overlay instead, the data is still exposed via `getSnapViz3D()` → `{ centerWorld, innerPx, outerPx, candidates: [{ world, depthT, active }] }` (world positions; project with `worldToScreen3D`). But the native viz already covers it.

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

### Visible Ground Grid

A **drawn** reference grid on the Y=0 plane — distinct from the *snap math* above, but its spacing **tracks `snapGridSize3D`**, so the grid you see is the grid you snap to. Minor lines use your chosen color/opacity; the **X axis is red and the Z axis is blue** through the origin (Blender-like origin read). It's depth-tested, so the model occludes it like a real floor, and it renders even in an empty scene.

All three are **properties** (matching the snap settings), not setters:

```ts
sm.sceneGridVisible3D = true;            // show/hide      (default false)
sm.sceneGridColor3D   = [0.42, 0.42, 0.5]; // minor-line [r,g,b] 0..1 (default muted gray-blue)
sm.sceneGridOpacity3D = 0.32;            // line alpha 0..1 (default 0.32)
```

Suggested panel — sits right under **Snap Settings**:

```
☐ Show grid     ■ [color]   Opacity ●────── 0.32
```

Notes:
- **Spacing is automatic** — it follows `snapGridSize3D` ("Grid size N units"). Change the snap size and the visible grid re-spaces to match; no separate grid-size control needed.
- **Persisted in the saved scene** (per-illustration — a character sheet can keep a grid, a painted background can leave it off). Saved alongside the other scene settings (fog/PS1/lighting/snap); Salsa restores it on load, so the panel just **reflects the restored values** via the three properties — no separate UI-pref storage needed.
- **Default off** for a new scene so renders/cards start clean — flip `sceneGridVisible3D = true` when modeling/posing. Hide it before exporting a card if you don't want it in frame.
- **Context hide (render-only, NOT persisted):** to hide the ground grid while a 2D/vector layer is active — and the 2D canvas grid while a 3D scene is active — without disturbing the saved setting, use the override gates `sceneGridVisible3DOverride` and `canvasGridVisibleOverride` (set `false` to hide). Effective visibility = `visible && override`; flip them on active-layer change. Saves always write the real `*Visible` value, so the user's preference survives.
- The grid spans ±10 world units around the origin (line count is capped, so very small snap sizes stay performant).
- **Known issue (v1):** the translucent grid lines can faintly blend over the opaque transform gizmo (depth-sorting transparent lines vs. opaque gizmos). Cosmetic only; deferred.

### "3D Scene" layer visibility (eye icon)

To give the **3D Scene** a layer row with an eye icon in the Layers panel, use the master gate:

```ts
sm.scene3DVisible = false;   // hide ALL 3D output; true to show again
```

It skips the **entire** 3D pass in one go — meshes, ground grid, gizmos, bones, particles, and 3D grease-pencil — **without touching any object's `.visible` state**, so flipping it back on restores the scene exactly (no per-object bookkeeping needed). It's a **render-only** gate (not written to the saved scene), so **persist the toggle on the Frogmarks side** (with the layer's visibility state) and re-apply it on load. Frogmarks just adds the eye icon to the 3D Scene row and sets this property.

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

> **Per-material light response (2026-06-29).** The PBR shader now adds an **environment-specular** term (sampled along the reflection vector × a roughness-aware Fresnel), so **metals reflect the surroundings** (chrome/gold) instead of going black, and every surface gets a subtle Fresnel grazing sheen. With **IBL on** it reflects the real SH probe; with **IBL off** it falls back to a **cheap fake environment** (a floored sky/ground hemisphere + the key light reflected as a soft glint) so **metals still look shiny out-of-the-box** — IBL just makes it richer. Dielectrics (skin/cloth) only pick up ~4% of it, so they aren't affected. Procedural characters ship with **per-material defaults** instead of the flat plastic 0.5: **skin** `roughness 0.72`, **tops/bottoms** `0.85/0.88` (matte cloth), **shoes** `0.5` (leather), **socks** `0.92`, **metal charms** `metalness 1, roughness ~0.28` (see [charms.md](./charms.md)). Default/PBR render style only. A per-garment fabric/finish control can ride `ClothingParams` later.
>
> **Update (2026-09-04):** the environment-specular term got a major upgrade — with a procedural sky applied, metals now reflect a **crisp, roughness-graded prefiltered cubemap** (no longer the soft SH blob), optionally plus **screen-space reflections** of the actual scene on floors/glancing surfaces, and a per-mesh **"Matte (no reflections)"** override exists (`setMeshNoEnvReflection3D`). See [environment-sky.md](./environment-sky.md) for the full sky/reflections host guide.

> **Procedural patterns (2026-06-29).** `shapeManager.setMeshPattern3D(meshId, { mode, color, freq, angle, scale, spacing })` overlays a crisp geometric pattern on any mesh's albedo — **stripes · dots · diamonds · checker · grid** — with a primary (the mesh's diffuse) + secondary (`color`) colour. Rendered analytically per-fragment with `fwidth` antialiasing, so it stays sharp up close and clean at distance (no shimmer/moire) and is free to re-tweak (just a uniform write). Best on the **default/PBR** style. Spec: [procedural-patterns.md](../specs/procedural-patterns.md). Phase 2 = skin-tight **undershirt/underpants** base layers that wear them.

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

#### Animating blend shape weights over time

Blend shape weights support full keyframing via the timeline. Use the same easing options available for mesh transforms (`linear`, `ease-in`, `ease-out`, `ease-in-out`, `step`).

```ts
// Set a keyframe for a shape weight at a specific frame (undoable):
sm.setBlendShapeKeyframe3D(meshId, 'smile', 0,  0);                    // frame 0: neutral
sm.setBlendShapeKeyframe3D(meshId, 'smile', 24, 1, 'ease-in-out');     // frame 24: full smile

// Remove a keyframe:
sm.removeBlendShapeKeyframe3D(meshId, 'smile', 24);

// Read back all weight tracks for a mesh:
// Returns Record<shapeName, { frame, value, easing }[]> or null
const tracks = sm.getBlendShapeKeyframeTracks3D(meshId);
```

The engine samples these tracks in `applyAllKeyframesAtFrame`, which fires automatically when the timeline plays. No extra wiring needed beyond what's already in place for mesh transform keyframes.

**Optional UI addition:** a keyframe diamond button (◆) beside each weight slider lets users set/clear a keyframe at the current frame without opening the full timeline — identical to the pattern used for transform channels.

```ts
// "◆ Key" button next to the smile slider:
const currentFrame = sm.getCurrentFrame?.() ?? 0;
setKeyBtn.onclick = () => sm.setBlendShapeKeyframe3D(meshId, shapeName, currentFrame, currentWeight);
```

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

// Kawaii "Clover Picnic" — green/yellow checkerboard, fades to white at the bottom, spinning clovers.
// Defaults to green/yellow with no colors; pass color1/color2 to recolor. (preset: ARMATURE_BG_CHECKERS_CLOVER)
sm.scene3d.setSceneBg3D({ mode: 'checkers' });

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
| `'checkers'` | Kawaii `color1`/`color2` checkerboard, fades to white at the bottom edge, with slowly-spinning clover/flower motifs in scattered cells (animated). Works for the armature bg too. |

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

### Perf / Stats HUD (optional overlay)

`getRenderStats3D()` returns everything for a three.js-style stats overlay — poll it on a timer (e.g. every ~250 ms):
```ts
const s = sm.getRenderStats3D();
// {
//   triangles, vertices, objects,                              // VISIBLE scene geometry (the render cost)
//   byCategory: { body, hair, clothing, charms, face, scenery }, // triangles per category → WHAT to simplify
//   geometryBytes,                                             // exact mesh vertex+index buffer bytes (not full VRAM)
//   gpStrokes,                                                 // grease-pencil objects (separate render path)
//   frameMs,                                                   // last frame's CPU encode time
//   fps,                                                       // render rate over the last second (0 when idle — on-demand renderer)
//   gpuName,                                                   // the adapter description, if the browser exposes it
// }
```
- **Make it useful, not decorative:** show a **triangle-count budget light** (🟢/🟡/🔴 vs a target you pick) so non-technical users get a "simplify" signal, and surface the **`byCategory`** breakdown — *that's* what tells them what to cut (hair cards + clothing `chunkiness` + GP strokes are the usual culprits here).
- **`fps` is 0 when idle** — this renderer draws on demand, so it only ticks while something changes (drag / animation). `frameMs` is the always-meaningful number.
- **What's NOT here (be honest in the UI):** true GPU-time, GPU-usage %, and VRAM — WebGPU has no API for those. `frameMs` is CPU encode time; `geometryBytes` is mesh buffers only (textures not summed). **Tier-2 follow-ups:** real GPU ms (needs the `timestamp-query` device feature) + multiplying array-tool GPU instances into the triangle count.

### Lighting — the key light (Collapsible, GLOBAL SCENE)

The 3D scene is lit by **one directional ("key") light + a constant ambient fill** (+ optional IBL, below). A directional light has a **direction, not a position** — it's treated as infinitely far (like the sun), so it has a *from-direction*, an intensity, and a colour. It is **fixed in world space** (does **not** follow the camera), and it's what casts the shadow. Default ≈ a high front-ish key (az **−31°**, el **54°**); ambient defaults to a dim cool fill.

**Aim it by "sun position" (recommended UI):**
```ts
sm.setLightAngles3D(azimuthDeg, elevationDeg);  // where the light shines FROM
// azimuth: 0 = front (+Z, camera side) · +90 = +X side · 180 = behind · -90/270 = -X side
// elevation: 0 = level · 90 = straight overhead · negative = from below
const L = sm.getLight3D();   // { direction, azimuthDeg, elevationDeg, color, intensity } — seed the sliders
sm.setLightIntensity3D(1.4); // intensity only (keeps direction/colour)
sm.setLightColor3D(1, 0.95, 0.85); // warm key, 0..1 (keeps direction/intensity)
```
- **UI idea:** two sliders (**Azimuth** −180…180, **Elevation** −90…90) seeded from `getLight3D()`, or a small **drag-the-sun** dot on a hemisphere. Both just call `setLightAngles3D`.
- **Persistence:** lighting is saved with the scene (`lighting.directional` = direction + colour + intensity) and restored on load — so a moved key light sticks. (Lighting changes don't flip the *mesh* dirty flag, so trigger a scene save the same way the existing intensity control does.)
- **Ambient** (`setAmbientLight3D`) is the flat fill that lifts the shadow side; it has **no effect while IBL is on** (the env map provides the ambient).

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

### Ambient Occlusion — SSAO (Collapsible, GLOBAL SCENE)

Screen-space ambient occlusion. Darkens **creases, contact points, and cavities** (building bases, under eaves/awnings,
rooftop clutter, window reveals, dense foliage) so detail reads as *placed in the world* instead of floating. It
multiplies the **ambient term only** — the sun's cast shadows are untouched (no double-darkening) — so it composes with
the directional shadows, it doesn't replace them. **Off by default.** Spec: [../specs/ssao.md](../specs/ssao.md).

```
┌─────────────────────────────────────┐
│ ▸ AMBIENT OCCLUSION (SSAO) ───────── │
│                                     │
│  [OFF ○] Enable                     │
│  Radius     [0.6  ══●═════]  (world) │
│  Intensity  [1.0  ═══●════]  0–2     │
│  Power      [1.5  ═══●════]  contrast│
│  Bias       [0.02 ══●═════]          │
│  Quality    [Half ▾] resScale 0.5×  │  ← ½=fast (default) · 1×=crisp (perf ★)
│  Samples    [8   ══●═════]  4–32     │
│                                     │
│  [ ] Debug: show raw AO buffer      │  ← greyscale AO, verification only
└─────────────────────────────────────┘
```

```ts
sm.scene3d.setSSAO3D(true, { radius: 0.6, intensity: 1.0, bias: 0.02, power: 1.5 });  // enable + tune
sm.scene3d.setSSAO3D(false);                 // disable (zero overhead when off)
sm.scene3d.setSSAO3D(true, { intensity: 1.6 });  // partial update — merges onto the current config
sm.scene3d.setSSAO3D(true, { resolutionScale: 1.0, samples: 16 });  // ★ high quality (full res, 16 samples) — costs fps
const ao = sm.scene3d.ssao3D;                // { enabled, radius, intensity, bias, power, resolutionScale, samples } — seed the panel
sm.scene3d.setSSAODebug3D(true);             // ★ render the raw AO buffer to screen (a mostly-WHITE "clay" view:
                                             //   white = unoccluded, dark = creases). The ONLY reliable way to
                                             //   verify AO — composited it just reads as "slightly dimmer".
```

| Param | Range | What it does |
|---|---|---|
| `radius` | world units (~0.3–1.5) | How far to search for occluders. Bigger = larger cavities darkened, softer. |
| `intensity` | 0–2 (default 1) | Occlusion strength. >1 = deeper. |
| `power` | ≥0.1 (default 1.5) | Contrast curve on the AO term. Higher = punchier, darker creases. |
| `bias` | world units (default 0.02) | Self-occlusion guard; raise if flat surfaces get a faint dirty tint. |
| `resolutionScale` | 0.25–1 (default **0.5**) | ★ PERF. AO renders at this fraction of canvas res; ½ ≈ 4× cheaper, near-invisible (AO is low-frequency, upsampled linearly). `1` = crisp/expensive. The main fps dial. |
| `samples` | 4–32 (default **8**) | ★ PERF. Hemisphere samples/pixel; fewer = faster (blur hides the noise). |

- **Enable toggle** → `setSSAO3D(on)` (keeps the last config). **Sliders** → `setSSAO3D(true, { …changed })`.
- **Gating (host):** best on the **default/PBR** look. It still applies under cel/PS1/sketch styles today (a Salsa-side
  style gate is a planned follow-up) — if the stylized looks want it off, the host can just call `setSSAO3D(false)` when
  those styles are active.
- **Perf:** a depth prepass + two fullscreen passes; only runs while enabled. Heaviest on large **tiled `full`** worlds
  (screen-res bound) — a quality tier + auto-off there is a planned follow-up.
- **Persistence:** ✅ saved with the scene (`globalScene3d.ssao`, alongside post-processing/shadows) and restored on
  load — the panel just reflects the restored `ssao3D` values, no separate storage. (The **debug** view is transient —
  not persisted.) *(Dev harness: `salsaSSAO.on()/.debug()/.set({…})/.off()`.)*

### Idle Animation (procedural — the easy default)

A one-toggle, **keyframe-free** idle for a standing character: gentle **breathing**, **weight-shift / sway**, and a slow **head drift**, generated procedurally each frame. It **layers on top of the current pose** (captures it as the base), **pauses while you edit the armature** (Salsa's native bone overlay), and — because it runs *before* the spring solve — the **hair and dangle chains swing with it** (free secondary motion). It holds the renderer in continuous mode while active, so it animates in the normal preview, not only while something else is driving redraws. This is the recommended way to make a freshly-created character feel alive without touching the clip/NLA workflow.

```ts
sm.setIdleAnimation3D(bodyMeshId, true);        // start idling (intensity defaults to 1)
sm.setIdleAnimation3D(bodyMeshId, true, 1.5);   // livelier
sm.setIdleAnimation3D(bodyMeshId, false);       // stop → settles back to the rest stance
sm.isIdleAnimating3D(bodyMeshId);               // → boolean
```
- **UX:** a simple **"Idle" toggle** (+ optional intensity slider) on the character/preview panel — good to **default ON** for the standing preview. No timeline needed.
- It drives only the torso/head/shoulder joints (`lowerback · spine · chest · neck · head · shoulder_L/R`); everything else follows via FK. It sways from the **lumbar** (above the leg roots), so the **feet stay planted**. It's a *runtime preview* state (not saved with the document).
- For authored, looping/blended motion (walks, gestures), use **NLA clips** below. The procedural idle is the zero-effort baseline; an NLA idle clip can replace it when you want art-directed breathing.

### Idle Breaks (random one-shots — the "alive" multiplier)

On top of the base idle, occasionally play a random **one-shot personality clip** (Stretch, Scratch Head, …) then settle back — the trick that makes BotW/Animal-Crossing NPCs feel alive. **Requires the base idle ON** (breaks ride its per-frame loop).

```ts
sm.setIdleAnimation3D(bodyMeshId, true);                          // base idle (required first)
sm.setIdleBreaks3D(bodyMeshId, { enabled: true, minSec: 8, maxSec: 20 });  // a break every 8–20s
sm.setIdleBreaks3D(bodyMeshId, { enabled: true, clips: ['Stretch', 'Scratch Head'] });  // curate the set
sm.setIdleBreaks3D(bodyMeshId, { enabled: false });              // stop breaks (base idle continues)
```
- **UX:** a **"Idle breaks" toggle** under the Idle toggle, optionally with a frequency range (min/max seconds). Default ON for a lively preview.
- **Pose-agnostic:** `clips` defaults to the built-in **one-shot** clips present on the skeleton — so every one-shot clip you add (yawn, arms-crossed, …) automatically becomes an eligible break, no rewiring. Looping clips (Breathe/Shift Weight/Look Around) are the *base* idle, never breaks.
- A break **crossfades** in/out (~0.25 s ease, per-joint) over the base idle — and the body keeps breathing on the joints the break doesn't animate, so it blends instead of cutting. Runtime-only (not saved). See [pose-driven-animation spec](../specs/pose-driven-animation.md) §5.

### Squash & Stretch (procedural appeal)

A volume-preserving **squash/stretch** that makes any animation less rigid, with **no per-clip authoring** — a global toggle that watches how extended/compressed the body is and scales the torso accordingly (reach/arms-up → taller+thinner, crouch → shorter+wider). Requires the base idle ON.

```ts
sm.setIdleAnimation3D(bodyMeshId, true);                          // base idle (required)
sm.setSquashStretch3D(bodyMeshId, { enabled: true, intensity: 0.06 });  // subtle (~0.04–0.12)
sm.setSquashStretch3D(bodyMeshId, { enabled: false });           // off → torso back to normal
```
- **UX:** a **"Squash & stretch" checkbox + intensity slider** in the character/preview panel.
- It auto-returns (derived from the live pose). Volume-preserved (`X/Z = 1/√Y`). Runtime-only.
- **Keep intensity subtle** — pushed too high, raised arms can shear (it drives the lower torso). Default **0.06** (~0.05 read well in testing), clamped. See [spec](../specs/pose-driven-animation.md) §6.5.

#### Driving frames (host render-tick — usually not needed)

While idle/breaks are active, Salsa holds its own render loop alive, so it animates in the normal preview without host help. These exist for hosts whose compositor only repaints on demand:

```ts
sm.renderFrame3D();        // run a FULL frame NOW incl. pre-render callbacks (idle/spring/IK) — the render() path
sm.requestRender3D();      // request an on-demand frame (scheduleRender; may be coalesced by the host)
sm.getRenderFps3D();       // → current 3D render FPS (0 = on-demand/idle) — diagnostic
```
If the character ever freezes during idle in your view, run an rAF loop calling **`renderFrame3D()`** (the full path, *not* `requestRender3D`) while `isIdleAnimating3D(bodyId)` is true. Most hosts don't need this.

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
