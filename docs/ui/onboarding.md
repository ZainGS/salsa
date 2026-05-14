# Frogmarks × Salsa — Claude Code Handoff (April 27, 2026)
**Last Updated:** 2026-04-27  

This document is the onboarding brief for a new Claude Code instance working on the **Frogmarks** Angular UI. Read this first. It gives you architecture context, the current state of the 3D UI, and a precise list of what still needs to be built.

---

## 1. What Is Frogmarks / What Is Salsa

**Salsa** is a WebGPU rendering library (TypeScript). It lives in this repo (`src/`). It exposes a single public entry point: `ShapeManager` (`src/services/shape-manager.ts`). Salsa knows nothing about Angular — it only knows about GPUs and scene graphs.

**Frogmarks** is a separate Angular app that consumes Salsa. Frogmarks imports `ShapeManager`, mounts the WebGPU canvas, and builds all UI on top of it. Every button, panel, and slider in Frogmarks calls a `ShapeManager` method.

```
Frogmarks (Angular)
    ↓ calls
ShapeManager (Salsa public API)
    ↓ delegates to
sm.raster    — raster layers, paint engine, compositing
sm.text      — SDF text, LiveText, speech balloons
sm.animation — timeline, cel animation, frame playback
sm.scene3d   — 3D camera, meshes, gizmos, shadows, undo
sm.drawing   — brush/line/scribble/stamp tools
sm.persist   — document save/load/export
```

**Rule:** Frogmarks never reaches into Salsa internals. It only calls `sm.*` methods. If Frogmarks needs something Salsa doesn't expose yet, the Salsa side adds an API — not the other way around.

---

## 2. Existing Spec Files (Read These for Deep Detail)

All of these are in `docs/ui/` and describe completed or in-progress UI work:

| File | What it covers |
|------|----------------|
| `frogmarks-3d-scene-ui-spec.md` | Full 3D panel layout, mesh list, transform/material/texture controls, orbit, PS1 sliders, lighting |
| `frogmarks-3d-phase4-ui-spec.md` | Shadow mapping UI, 3D undo/redo buttons, frustum culling toggle, 3D animation sync panel |
| `frogmarks-brush-ui-spec.md` | Brush preset editor, tip controls, dynamics curves, stabilization |
| `frogmarks-animation-ui-spec.md` | Raster timeline, cel animation, frame controls |
| `frogmarks-raster-ui-spec.md` | Raster layer panel, blend modes, opacity, dithering, clipping |
| `frogmarks-layer-folders-3d-divider-spec.md` | Layer stack, 3D scene layer entry, folder layers |
| `frogmarks-phase4-api-reference.md` | Consolidated API reference for Phase 4 additions |

---

## 3. What the Previous Copilot Was Working On

The previous Copilot instance was implementing the **Phase 4 UI** as described in `frogmarks-3d-phase4-ui-spec.md`:

1. ✅ Shadow mapping controls (Cast Shadows toggle, map size, extent, bias sliders)
2. 🔲 **[YOU ARE HERE]** Outliner polish + normal map slot + expanded undo (see Section 4)
3. ✅ Frustum culling toggle (Advanced section)
4. ✅ 3D/raster animation sync panel

The previous instance was cut off mid-Phase 4 item #2. Items 1, 3, and 4 may be partially or fully implemented — verify current state in the Frogmarks codebase before rebuilding.

---

## 4. New Things Added to Salsa (April 27, 2026) — UI Not Yet Built

These were added to the Salsa library today. **None of them have Frogmarks UI yet.** This is your primary work.

### 4a. Undo Now Covers Create and Delete

Previously 3D undo only recorded gizmo drag transforms. Now it also records:
- Creating any mesh (`createBox`, `createSphere`, etc.)
- Deleting a mesh (`deleteMesh`)
- Creating a mesh group (`createMeshGroup`)
- Deleting a mesh group (`deleteMeshGroup`)

The existing Undo/Redo buttons in the 3D panel toolbar already call `sm.undo3D()` / `sm.redo3D()`. **No new UI needed** — but you should verify the buttons update their disabled state and tooltip after mesh create/delete operations, not just after gizmo drags.

```ts
// After any create/delete:
undoButton.disabled = !sm.canUndo3D;
undoButton.title = sm.undoDescription3D ?? 'Nothing to undo';
redoButton.disabled = !sm.canRedo3D;
redoButton.title = sm.redoDescription3D ?? 'Nothing to redo';
```

### 4b. Outliner Polish — Visibility, Rename, Delete Group

The mesh list in the 3D panel currently shows mesh names with delete buttons. It needs three new capabilities:

#### Visibility Toggle (eye icon per row)

```ts
// Eye icon click:
sm.setMeshVisible3D(meshId, !sm.isMeshVisible3D(meshId));
// or for groups:
sm.setGroupVisible3D(groupId, !sm.isGroupVisible3D(groupId));
```

When `visible = false`, the mesh still exists in the scene but is not rendered. Show the eye icon as dimmed/crossed-out when hidden.

#### Rename (double-click row label)

```ts
// On double-click: show inline text input, on blur/enter:
sm.setMeshName3D(meshId, newName);
// or for groups:
sm.setGroupName3D(groupId, newName);
```

#### Delete Group Button

Groups now have a delete action. Deleting a group **promotes its children to the scene root** — it does not delete the meshes inside.

```ts
// "Delete Group" button or context menu:
sm.deleteMeshGroup3D(groupId);
// Children are automatically lifted to root. Undo-able.
```

#### Hierarchy Data for the Outliner

Use `getScene3DHierarchy()` to drive the outliner tree instead of building it manually. It returns a snapshot — cache it and invalidate on scene-graph-changed events.

```ts
export interface Scene3DHierarchyNode {
  id:        string;
  name:      string;
  type:      '3DMesh' | '3DMeshGroup';
  visible:   boolean;
  locked:    boolean;
  collapsed?: boolean;
  children?: Scene3DHierarchyNode[];
}

const hierarchy = sm.getScene3DHierarchy();
// hierarchy is a tree: groups have children[], meshes do not
```

**Important:** Don't call `getScene3DHierarchy()` on every frame. Call it once on load, then again whenever you receive a scene-graph-changed event from Salsa.

### 4c. Normal Map Slot in Material Inspector

When a mesh is selected, the Material section currently shows diffuse color, opacity, and a diffuse texture slot. Add a second texture slot below it for the normal map.

**Layout addition to the Material section:**

```
MATERIAL
  Color [■]  Opacity [100%]
  Specular [■]  Shininess [16]

TEXTURE
  Diffuse
  [thumbnail or "None"]  [Upload] [Clear]

  Normal Map                        ← NEW
  [thumbnail or "None"]  [Upload] [Clear]
  (shows "Per-pixel lighting active" badge when set)
```

**API:**

```ts
// Upload normal map from file input:
await sm.uploadAndApplyNormalMap3D(meshId, file);
// Returns library ID (string) or null on failure.
// Console will warn if no diffuse texture was set — it auto-creates a 1×1 white one.

// Remove normal map:
sm.clearMeshNormalMap3D(meshId);

// Read current state (to initialize UI):
const mesh = sm.getMesh3D(meshId);
const hasNormalMap = mesh?.normalMapLibraryId != null;
```

**Behavior notes:**
- When a normal map is set, the mesh switches to per-pixel Phong lighting (you can display this as a badge: "Normal Map Active").
- When no normal map is set, the mesh uses PS1-style Gouraud (vertex-lit) shading.
- If the mesh has no diffuse texture when you set a normal map, Salsa auto-creates a white 1×1 diffuse internally. The console will warn about this. You can optionally show a soft UI hint: "No diffuse texture — using white."

---

## 5. Complete 3D Panel API Reference

This is the full `sm.*` surface the 3D panel needs. Use this as your implementation checklist.

### Camera

```ts
sm.scene3d.createCamera(config?)
sm.scene3d.resetCamera()                        // look at origin from (0, 2, 5)
sm.scene3d.setCameraMode('perspective' | 'orthographic')
sm.scene3d.setFOV(degrees)
sm.scene3d.frameAllMeshes(padding?)
sm.scene3d.frameMesh(nodeId, padding?)
sm.scene3d.enableOrbitControls(config?)
sm.scene3d.disableOrbitControls()
sm.scene3d.toggleOrbitControls(enabled?)
```

### Mesh Creation (all undo-able)

```ts
sm.scene3d.createBox(x, y, z, w?, h?, d?, material?)        → Mesh3D
sm.scene3d.createSphere(x, y, z, radius?, segments?)        → Mesh3D
sm.scene3d.createPlane(x, y, z, w?, h?)                     → Mesh3D
sm.scene3d.createCylinder(x, y, z, radius?, height?, segs?) → Mesh3D
sm.scene3d.createTorus(x, y, z, radius?, tubeRadius?)       → Mesh3D
sm.scene3d.createCustomMesh(x, y, z, geometry, material?)   → Mesh3D
```

### Mesh Manipulation (all undo-able where noted)

```ts
sm.scene3d.deleteMesh(nodeId)                    // undo-able
sm.scene3d.getAllMeshes()                         // → Mesh3D[]
sm.scene3d.getMesh(nodeId)                       // → Mesh3D | null (alias: getMesh3D)

sm.scene3d.setPosition(meshId, x, y, z)
sm.scene3d.setRotation(meshId, rx, ry, rz)       // radians
sm.scene3d.setScale(meshId, sx, sy, sz)
sm.scene3d.setDiffuseColor(meshId, r, g, b)      // 0-1 each
sm.scene3d.setOpacity(meshId, value)             // 0-1
```

### Outliner / Visibility (NEW April 27)

```ts
sm.setMeshVisible3D(meshId, visible)
sm.isMeshVisible3D(meshId)                       // → boolean
sm.setGroupVisible3D(groupId, visible)
sm.isGroupVisible3D(groupId)                     // → boolean

sm.setMeshName3D(meshId, name)
sm.getMeshName3D(meshId)                         // → string | null
sm.setGroupName3D(groupId, name)
sm.getGroupName3D(groupId)                       // → string | null

sm.getScene3DHierarchy()                         // → Scene3DHierarchyNode[]
```

### Groups (undo-able)

```ts
sm.scene3d.createMeshGroup(name?)                // → MeshGroup3D (undo-able)
sm.deleteMeshGroup3D(groupId)                    // children promoted to root (undo-able)
sm.scene3d.addMeshToGroup(meshId, groupId)
sm.scene3d.removeMeshFromGroup(meshId)
sm.scene3d.getMeshGroups()                       // → MeshGroup3D[]
```

### Textures

```ts
// Diffuse
await sm.scene3d.setMeshTexture(meshId, file)   // File | Blob | ImageBitmap
sm.scene3d.clearMeshTexture(meshId)

// Normal map (NEW April 27)
await sm.uploadAndApplyNormalMap3D(meshId, source, name?)  // → library ID | null
sm.setMeshNormalMap3D(meshId, gpuTexture)
sm.clearMeshNormalMap3D(meshId)
```

### Lighting

```ts
sm.scene3d.setDirectionalLight(dx, dy, dz, r, g, b, intensity)
sm.scene3d.setAmbientLight(r, g, b, intensity)
```

### PS1 Aesthetics

```ts
sm.scene3d.setPS1Config({
  vertexJitter: 0.8,    // 0-2
  snapGridSize: 160,    // 64-512
  colorDepth: 32,       // 8-256
  affineStrength: 0.5,  // 0-1
})
```

### Shadows

```ts
sm.enableShadows3D(mapSize?, halfExtent?, bias?)  // mapSize: 512/1024/2048/4096
sm.disableShadows3D()
sm.shadowsEnabled3D                               // → boolean
```

### Undo / Redo

```ts
sm.undo3D()                   // → boolean
sm.redo3D()                   // → boolean
sm.canUndo3D                  // → boolean
sm.canRedo3D                  // → boolean
sm.undoDescription3D          // → string | null
sm.redoDescription3D          // → string | null
sm.clearUndo3D()
```

### Gizmo / Picking

```ts
sm.scene3d.enableTransformControls()
sm.scene3d.disableTransformControls()
sm.scene3d.setGizmoMode('move' | 'rotate' | 'scale')
sm.scene3d.pick3D(mouseX, mouseY, w, h)
```

### Frustum Culling

```ts
sm.frustumCulling3D = true | false  // default true
sm.frustumCulling3D                 // getter
```

### Keyframe Animation

```ts
sm.setMeshKeyframe3D(meshId, prop, frame, value, easing?)
// prop: 'position' | 'rotation' | 'scale' | 'diffuseColor' | 'opacity' | 'visible'

sm.removeMeshKeyframe3D(meshId, prop, frame)
sm.getMeshKeyframeTracks3D(meshId)
sm.clearMeshKeyframeTracks3D(meshId)
sm.applyAllKeyframesAtFrame3D(frame)
sm.attachKeyframesToTimeline3D()     // auto-apply on raster frame changes
sm.detachKeyframesFromTimeline3D()
sm.createAnimationPlayer3D({ startFrame, endFrame, fps, loop })
sm.getAnimationPlayer3D()            // → AnimationPlayer3D | undefined
```

### 3D Scene Layer (Layer Panel)

```ts
sm.raster.add3DScene(name?)    // add the 3D scene entry to the layer stack
sm.raster.remove3DScene()
sm.raster.get3DScene()         // → { id, name } | null
sm.raster.has3DScene()         // → boolean
```

---

## 6. Updated 3D Panel Layout (Target State)

The full panel incorporating all Phase 4 additions including the April 27 work:

```
┌─────────────────────────────────────────┐
│ 3D Scene                           [✕]  │
├─────────────────────────────────────────┤
│ [←Undo]  [Redo→]                        │
├─────────────────────────────────────────┤
│ VIEWPORT                                │
│  Mode: [Move▾]                          │
│  [Perspective▾]  [Frame All]  [Reset]   │
│  FOV: [60°  ══════●═══]                 │
│  Orbit: [ON ●]                          │
├─────────────────────────────────────────┤
│ OUTLINER                                │
│  👁 📁 Props              [🗑]          │  ← group row
│  👁   ⬡ box              [🗑]          │  ← child mesh, indented
│  👁   ● sphere ← selected [🗑]          │
│  👁 ⬡ floor               [🗑]          │  ← root mesh
│                                         │
│  [+ Box] [+ Sphere] [+ Plane]           │
│  [+ Cylinder] [+ Torus] [+ Group]       │
├─────────────────────────────────────────┤
│ ─── sphere ──────────────────────────── │
│ TRANSFORM                               │
│  Pos  X [0.0] Y [0.5] Z [0.0]          │
│  Rot  X [0  ] Y [0  ] Z [0  ]          │
│  Scale X [1.0] Y [1.0] Z [1.0]         │
│                                         │
│ MATERIAL                                │
│  Color [■]  Opacity [100%]              │
│                                         │
│ TEXTURE                                 │
│  Diffuse                                │
│  [thumb]  [Upload]  [Clear]             │
│                                         │
│  Normal Map                  ← NEW      │
│  [thumb or "None"]  [Upload] [Clear]    │
│  [Per-pixel lighting active] ← badge    │
├─────────────────────────────────────────┤
│ ▸ PS1 RETRO STYLE                       │
├─────────────────────────────────────────┤
│ ▸ LIGHTING                              │
│   Direction  Intensity  Color           │
│   Ambient    Intensity  Color           │
│   ── Shadows ──────────────────────     │
│   Cast Shadows   [OFF ○]                │
│   Map Size [1024▾]  Extent [15]         │
│   Bias [0.002]                          │
├─────────────────────────────────────────┤
│ ▸ 3D ANIMATION                          │
│   Sync with Timeline  [ON ●]            │
│   Start [0]  End [120]  FPS [24]        │
│   [▶] [⏸] [⏹]   Frame: 60/120         │
├─────────────────────────────────────────┤
│ ▸ ADVANCED                              │
│   Frustum Culling  [ON ●]               │
└─────────────────────────────────────────┘
```

---

## 7. Outliner Row Behavior Details

Each row in the OUTLINER section:

| Element | Behavior |
|---------|----------|
| 👁 icon | Click → `setMeshVisible3D` / `setGroupVisible3D`. Dims when hidden. |
| Row label | Single-click → select mesh (`sm.setSelectedNode(id)`). Double-click → inline rename input → `setMeshName3D` / `setGroupName3D` on blur/enter. |
| 📁 icon | Group rows only. Click → collapse/expand children in the tree (local UI state, no API call needed). |
| 🗑 icon (mesh) | `sm.scene3d.deleteMesh(id)`. Undo-able. |
| 🗑 icon (group) | `sm.deleteMeshGroup3D(id)`. Children are promoted to root. Undo-able. |
| Indent | Children of a group are indented. Use `scene3DHierarchy[n].children` to determine nesting. |

Build the outliner list from:
```ts
const hierarchy = sm.getScene3DHierarchy();
// Re-fetch on every 'scene-graph-changed' event.
// Do NOT call this on every frame.
```

---

## 8. Key Facts About Salsa (Don't Get Wrong)

1. **`sm.scene3d` vs `sm.*3D()`** — Most APIs exist in both forms. `sm.scene3d.deleteMesh(id)` and `sm.deleteMesh3D(id)` do the same thing. Prefer the namespaced `sm.scene3d.*` form in new code.

2. **Undo stack is independent from raster undo.** When the 3D panel is active, Ctrl+Z should call `sm.undo3D()`. When a raster layer is active, Ctrl+Z should use the raster undo. Don't mix them.

3. **Transforms are in Salsa units, not pixels.** Position X/Y/Z and scale are in world units. Rotation is in radians. The UI should display rotation in degrees and convert: `degrees = radians * (180 / Math.PI)`.

4. **The 3D Scene layer entry is not paintable.** When the user selects it in the layer panel, show the 3D panel — do not show brush controls or call `sm.raster.selectLayer()`.

5. **Orbit disable during transform.** When the user starts dragging a gizmo, orbit is automatically disabled by `TransformController3D`. Frogmarks does not need to manage this.

6. **`getScene3DHierarchy()` is a snapshot.** It allocates a new array each call. Cache it. Invalidate on scene-graph-changed events.

7. **Normal maps require a diffuse texture.** Salsa auto-creates a 1×1 white diffuse if you apply a normal map to a mesh with no diffuse. A `console.warn` fires when this happens. You can show a soft hint in the UI.

8. **Raster ↔ 3D animation sync is automatic.** Once `sm.createAnimationPlayer3D(...)` is called, the raster timeline's play/pause/stop drives the 3D player automatically. No extra wiring needed in Frogmarks.

---

## 9. Salsa Documentation Index

If you need to go deeper on any system, the full documentation is at `docs/reference/`:

| File | What it covers |
|------|----------------|
| `00-architecture-overview.md` | Full system diagram, design decisions |
| `11-services-managers.md` | ShapeManager API surface, all delegate managers |
| `15-3d-rendering-system.md` | 3D renderer, pipeline, vertex format, normal maps, PS1 system |
| `16-3d-animation-system.md` | Keyframe tracks, AnimationPlayer3D, UndoManager3D |

---

## 10. Priority Order

Build in this order:

1. **Enable transform controls** — Call `sm.scene3d.enableTransformControls()` when the 3D panel becomes active. Without this, clicking meshes does nothing and no gizmos appear. This is the most impactful missing call. The entire picking + gizmo + drag-to-transform system is fully built in Salsa and self-activates once this is called.

   ```ts
   // When user opens / focuses the 3D panel:
   sm.scene3d.enableTransformControls();

   // When user closes / leaves the 3D panel:
   sm.scene3d.disableTransformControls();
   ```

   Add a mode strip to the panel header so the user can switch gizmo mode:
   ```ts
   sm.scene3d.setGizmoMode('move');    // default
   sm.scene3d.setGizmoMode('rotate');
   sm.scene3d.setGizmoMode('scale');
   ```

2. **Outliner rows** — visibility toggle, rename on double-click, delete group button. Drive from `getScene3DHierarchy()`.
3. **Normal map slot** — second texture slot in the Material section with Upload/Clear and the "per-pixel lighting" badge.
4. **Undo/redo button state refresh** — make sure the Undo/Redo buttons update after create/delete operations (not just after gizmo drags).
5. **Verify Phase 4 existing items** — confirm shadows UI, frustum culling toggle, and animation sync panel are working correctly from the previous Copilot's work.

---

## 11. Design Decisions (Do Not Change These)

### 3D does not pan with the 2D canvas — intentional

The 2D pan/zoom moves the illustration canvas. The 3D scene has its own `Camera3D` with a separate view-projection matrix. These are independent coordinate systems by design. Orbit controls navigate 3D space; pan/zoom navigates 2D space. Syncing them would make panning feel broken (3D objects would slide opposite to pan direction).

### 3D rendering is not clipped to the drawing area bounds — leave as-is for MVP

In-editor, 3D content can render outside the white page boundary. This is standard behavior (Figma, Spline, Blender all work this way). On export, the render target is exactly the drawing area size, so overflow is naturally clipped. If the bleed becomes visually distracting, a semi-transparent CSS overlay (`mix-blend-mode: multiply`) with a hole cut out for the page rect is the cheapest fix — no Salsa changes needed.
