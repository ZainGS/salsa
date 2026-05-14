# Frogmarks UI — Phase 4 Integration Guide
**Last Updated:** 2026-04-27  
**Covers:** Shadow mapping, 3D undo/redo, frustum culling, 3D animation sync, arrowheads, raster text, connection ports, SDF text cursor + word-wrap

All APIs are already implemented in the Salsa library. This document tells the Angular app what to build.

---

## 3D Features

### 1. Shadow Mapping

**Salsa API:**
```ts
sm.enableShadows3D(mapSize?, halfExtent?, bias?)
sm.disableShadows3D()
sm.shadowsEnabled3D  // getter: boolean
```

**Panel layout** — add a Shadows subsection inside the Lighting accordion:
```
▸ LIGHTING ─────────────────────────────────
  Direction  X [0.3] Y [-0.8] Z [-0.5]
  Color      [■ #ffffff]  Intensity [1.0]
  Ambient    [■ #272733]  Intensity [1.0]

  ── Shadows ──────────────────────────────
  Cast Shadows   [OFF ○]
  (when enabled:)
  Map Size       [1024 ▾]   ← 512 / 1024 / 2048 / 4096
  Shadow Extent  [15  ════●═══]  range 5–50
  Bias           [0.002 ══●═══]  range 0.0001–0.02
```

```ts
// Toggle on:
sm.enableShadows3D(mapSize, halfExtent, bias);
// Toggle off:
sm.disableShadows3D();
// Init state:
shadowToggle.checked = sm.shadowsEnabled3D;
```

- Map size / extent / bias changes: re-call `enableShadows3D(...)` with new values (recreates shadow texture)
- Show warning tooltip at 4096: "High VRAM usage"
- Transparent meshes do **not** cast/receive shadows — by design

---

### 2. 3D Undo / Redo

**Salsa API:**
```ts
sm.undo3D()              // returns true if something was undone
sm.redo3D()              // returns true if something was redone
sm.canUndo3D             // boolean
sm.canRedo3D             // boolean
sm.undoDescription3D     // string | null
sm.redoDescription3D     // string | null
sm.clearUndo3D()         // clear stack (e.g. on scene reset)
```

**Keyboard shortcut** — route based on which panel is active:
```ts
if (event.key === 'z' && (event.ctrlKey || event.metaKey)) {
  if (event.shiftKey) { if (sm.canRedo3D) sm.redo3D(); }
  else                { if (sm.canUndo3D) sm.undo3D(); }
  event.preventDefault();
}
```

The 3D undo stack is **separate** from the 2D raster undo stack. When a 3D mesh is selected / 3D panel is focused, Ctrl+Z undoes 3D actions; otherwise it undoes raster actions.

**Toolbar:** Add `[←Undo] [Redo→]` in the 3D Scene panel header:
```ts
undoBtn.disabled = !sm.canUndo3D;
undoBtn.title    = sm.undoDescription3D ?? 'Nothing to undo';
undoBtn.onclick  = () => sm.undo3D();
```

---

### 3. Frustum Culling Toggle

**Salsa API:**
```ts
sm.frustumCulling3D          // getter: boolean (default true)
sm.frustumCulling3D = false  // setter
```

**Placement:** Inside a collapsible **Advanced** section — this is a debugging escape hatch, not a primary control.

```
▸ ADVANCED ─────────────────────────────────
  Frustum Culling   [ON ●]
```

```ts
frustumCullingToggle.checked  = sm.frustumCulling3D;
frustumCullingToggle.onChange = (v) => { sm.frustumCulling3D = v; };
```

---

### 4. 3D Animation Sync with Raster Timeline

The raster timeline's play/pause/stop automatically drives `AnimationPlayer3D` — **no extra Frogmarks code needed** for the sync itself. Just create the player:

```ts
sm.createAnimationPlayer3D({ startFrame: 0, endFrame: 120, fps: 24, loop: true });
// player.play() fires automatically when sm.animation.play() is called
```

**3D Animation subsection** (visible when a mesh has keyframe tracks):
```
▸ 3D ANIMATION ─────────────────────────────
  Sync with Timeline   [ON ●]
  Start [0]  End [120]  FPS [24]  Loop [ON ●]
  [▶ Play]  [⏸ Pause]  [⏹ Stop]
  Frame: [----●-----------] 60 / 120
```

**Keyframe recording** — "K" shortcut when mesh selected:
```ts
const meshId = [...sm.getSelected3DIDs()][0];
const frame  = sm.animation.getCurrentFrame();
const mesh   = sm.getMesh3D(meshId);
if (mesh) {
  sm.setMeshKeyframe3D(meshId, 'position', frame, [mesh.x, mesh.y, mesh.z]);
  sm.setMeshKeyframe3D(meshId, 'rotation', frame, [mesh.rotationX, mesh.rotationY, mesh.rotation]);
  sm.setMeshKeyframe3D(meshId, 'scale',    frame, [mesh.scaleX, mesh.scaleY, mesh.scaleZ]);
}
```

---

### 5. Complete 3D Scene Panel Layout

```
┌─────────────────────────────────────────┐
│ 3D Scene                           [✕]  │
├─────────────────────────────────────────┤
│ [←] [→]   ← 3D Undo / Redo buttons     │
├─────────────────────────────────────────┤
│ VIEWPORT                                │
│  Mode: [Move▾]                          │
│  [Perspective▾]  [Frame All] [Reset]    │
│  FOV: [60°  ══════●═══]                 │
│  Orbit: [ON ●]                          │
├─────────────────────────────────────────┤
│ MESHES                                  │
│  ⬡ box                    [🗑]          │
│  ● sphere  ← selected     [🗑]          │
│  [+ Box] [+ Sphere] [+ Plane]           │
│  [+ Cylinder] [+ Torus]                 │
├─────────────────────────────────────────┤
│ ─── sphere ─────────────────────────── │
│ TRANSFORM                               │
│  Pos  X [0.0] Y [0.5] Z [0.0]          │
│  Rot  X [0  ] Y [0  ] Z [0  ]          │
│  Scale X [1.0] Y [1.0] Z [1.0]         │
│ MATERIAL                                │
│  Color [■]  Opacity [100%]             │
│ TEXTURE                                 │
│  [thumbnail]  [Upload] [Clear]          │
├─────────────────────────────────────────┤
│ ▸ PS1 RETRO STYLE                       │
├─────────────────────────────────────────┤
│ ▸ LIGHTING                              │
│   Direction  Intensity  Color           │
│   Ambient    Intensity  Color           │
│   ── Shadows ──────────────────────────│
│   Cast Shadows [OFF ○]                  │
│   Map Size [1024▾]  Extent [15]  Bias [0.002] │
├─────────────────────────────────────────┤
│ ▸ 3D ANIMATION                          │
│   Sync with Timeline [ON ●]             │
│   Start [0] End [120] FPS [24]          │
│   [▶] [⏸] [⏹]   Frame: 60/120         │
├─────────────────────────────────────────┤
│ ▸ ADVANCED                              │
│   Frustum Culling [ON ●]                │
└─────────────────────────────────────────┘
```

---

## 2D API Additions (also in Phase 4)

### 6. Arrowheads on Lines

```ts
type ArrowheadStyle = 'none' | 'triangle' | 'open';

sm.createArrow(x1, y1, x2, y2, strokeColor, strokeWidth, arrowStart?, arrowEnd?, arrowSize?)
sm.setArrowheads(shapeId, arrowStart?, arrowEnd?, arrowSize?)
sm.setDefaultArrowheads(arrowStart, arrowEnd)
ShapeManager.ArrowheadStyles  // ['none', 'triangle', 'open']
```

**Integration checklist:**
- [ ] Arrowhead controls in line/arrow toolbar section (dropdown from `ShapeManager.ArrowheadStyles`)
- [ ] Wire to `sm.setArrowheads(selectedLineId, arrowStart, arrowEnd)` on change
- [ ] "Arrow" shape type → `sm.setDefaultArrowheads('none', 'triangle')` then enable line tool

---

### 7. Raster Text Tool

Stamps text as pixels onto the active raster layer. Once committed, non-editable.

```ts
sm.enableRasterText()
sm.disableRasterText()
sm.getRasterTextState()   // → RasterTextState | null
sm.updateRasterTextProperties({ font?, fontSize?, bold?, italic?, align?, color?, maxWidth?, lineHeight? })
sm.commitRasterText()     // stamp onto layer, push undo
sm.cancelRasterText()
sm.onRasterTextStateChanged(cb)  // → { unsubscribe() }
```

Built-in keys: Enter = commit, Escape = cancel, Shift+Enter = newline, ←/→ = caret, Backspace = delete.

**Integration checklist:**
- [ ] "Text" button in raster toolbar → `sm.enableRasterText()`
- [ ] Font / size / color / bold / italic controls → `sm.updateRasterTextProperties({...})`
- [ ] Subscribe `sm.onRasterTextStateChanged(...)` to keep UI in sync

---

### 8. Connection Ports & Snap-to-Port Connectors

Every shape exposes named ports (`top`, `right`, `bottom`, `left`, `center`). Lines bind endpoints to ports and auto-track when shapes move.

```ts
sm.findSnapTarget(worldX, worldY, excludeShapeId?)  // → SnapResult | null
sm.getAllConnectionPoints(nearX?, nearY?, radius?)   // → { shapeId, point }[]
sm.bindLineStart(lineId, targetShapeId, portId)
sm.bindLineEnd(lineId, targetShapeId, portId)
sm.unbindLineStart(lineId)
sm.unbindLineEnd(lineId)
```

Port dots and connector auto-update render automatically when the line tool is active — **no Frogmarks overlay code needed** for the basic snap behavior.

**Integration checklist (flowchart mode only):**
- [ ] Render snap indicator dots via `sm.getAllConnectionPoints(mouseWorldX, mouseWorldY, 0.1)` (optional — already auto-rendered)
- [ ] Use `sm.bindLineStart/End` if building explicit "Connect shapes" mode

---

### 9. SDF Text Cursor Editing

Full cursor-based editing now built-in — no Frogmarks changes required:

| Key | Action |
|-----|--------|
| `←` / `→` | Move caret |
| `Shift+←/→` | Extend selection |
| `Home` / `End` | Line start/end |
| `Ctrl+A` | Select all |
| `Ctrl+C/X/V` | Copy/Cut/Paste |
| Click on active text | Position caret |

---

### 10. SDF Text Word Wrapping

```ts
sm.setSDFTextMaxWidth(worldUnits)   // for active tool; 0 = no wrap
sm.updateSDFText(nodeId, { maxWidth: number })  // for existing node
```

**Integration checklist:**
- [ ] "Max Width" slider/input in SDF text properties panel
- [ ] Wire to `sm.updateSDFText(nodeId, { maxWidth })` for existing nodes
- [ ] Wire to `sm.setSDFTextMaxWidth(value)` for active tool

---

## API Quick Reference

| Feature | Method | Default |
|---------|--------|---------|
| Enable shadows | `sm.enableShadows3D(size, extent, bias)` | disabled |
| Disable shadows | `sm.disableShadows3D()` | — |
| Shadow state | `sm.shadowsEnabled3D` | `false` |
| Undo 3D | `sm.undo3D()` | — |
| Redo 3D | `sm.redo3D()` | — |
| Can undo/redo | `sm.canUndo3D` / `sm.canRedo3D` | — |
| Undo label | `sm.undoDescription3D` | `null` |
| Frustum culling | `sm.frustumCulling3D = bool` | `true` |
| Create 3D player | `sm.createAnimationPlayer3D(config)` | — |
| Arrowhead style | `sm.setArrowheads(id, start, end)` | `'none'`/`'triangle'` |
| Raster text | `sm.enableRasterText()` | — |
| Snap target | `sm.findSnapTarget(x, y)` | — |
| SDF word-wrap | `sm.setSDFTextMaxWidth(units)` | `0` (none) |
