# Cinematic Cameras — Frogmarks UI Integration Guide

**Audience:** Frogmarks (Angular host) developers wiring the camera panel, the timeline "Cameras" lane, and the export button.
**Date:** 2026-08-24 · **Engine spec:** [../specs/cinematic-cameras.md](../specs/cinematic-cameras.md) · **Sibling:** [free-camera-and-targets.md](./free-camera-and-targets.md).
**Status:** engine P1–P4 + polish built (browser-unverified). The engine owns the cameras, cuts, preview, and frame capture; **you** own the panel, the lane, and the encode-to-file step.

---

## 0. The model in one line

A **camera node** is a placeable scene object whose transform *is* a shot (it looks down its own local −Z; aim it by rotating the gizmo). You keyframe it like any mesh to move it, drop **cuts** on the timeline to say "from frame F, show camera C," toggle **preview** to watch the timeline through those cuts, and **export** the sequence to a video.

```
place camera → aim (gizmo) → keyframe a move → drop cuts → ▶ preview → ⤓ export
   node          transform     setMeshKeyframe3D   setCameraCut3D  setPreview…  exportCinematicFrames3D
```

Everything reuses the existing 3D editor: cameras are meshes, so **selection, gizmo, keyframes, and persistence already work** — there's no new node type to special-case in your scene tree beyond an "is a camera" flag.

---

## 1. The API surface (all on `sm` = the ShapeManager)

### Camera nodes
| Call | Effect |
|---|---|
| `sm.createCameraNode3D(x, y, z, { name?, fov?, projection?, near?, far? })` → `id` | Create a camera at a point. `fov` in **radians** (default π/4), `projection` `'perspective'\|'orthographic'`. Returns the node id. It's a normal selectable/gizmo-able mesh. |
| `sm.listCameraNodes3D()` → `{ id, name, projection }[]` | Every camera in the scene — drive your camera list panel off this. |
| `sm.setCameraNodeSettings3D(id, { fov?, projection?, near?, far? })` → `bool` | Patch lens settings. |
| `sm.deleteCameraNode3D(id)` | Delete it (undoable; also prunes any cuts that referenced it, and undo brings both back). |
| `sm.lookThroughCamera3D(id \| null)` | Snap the viewport camera to that node's pose (a static preview). `null` restores the edit camera. Re-call after moving the node to refresh. |
| `sm.lookThroughCameraId3D` → `id \| null` | Which camera you're currently looking through. |
| `await sm.setCameraMarkerSprite3D(id, source, { size?, offsetY? })` | Attach **your** image (the frog-on-a-cloud) as the camera's billboard marker — it follows the camera and auto-hides in the shot. `source` is a `File`/`Blob`/`ImageBitmap`. `size`/`offsetY` in world units (default 0.5 / 0.35). |
| `sm.removeCameraMarkerSprite3D(id)` | Back to the plain box marker. |

> ⚠️ **Name it `createCameraNode3D`, not `createCamera3D`.** `createCamera3D` already exists and swaps the live *render* camera — a different thing. Use the `…CameraNode3D` family for placeable shot cameras.

### Animating a camera (reuses the mesh keyframe API)
| Call | Effect |
|---|---|
| `sm.setMeshKeyframe3D(id, 'position'\|'rotation'\|'scale', frame, value, easing?)` | Keyframe the camera's move exactly like any mesh. Rotation is **slerped** for camera nodes, so pans arc smoothly (no gimbal wobble). |
| `sm.setCameraFovKeyframe3D(id, frame, fovRadians, easing?)` | Keyframe FOV for an **in-shot zoom** (dolly-zoom). Sampled only while looking through / previewing / exporting that camera. Undoable. |

### Cuts (the shot list) + preview
| Call | Effect |
|---|---|
| `sm.setCameraCut3D(frame, cameraId)` | "From this frame, the timeline shows this camera." Add/replace at a frame. Undoable. |
| `sm.removeCameraCut3D(frame)` | Remove the cut at a frame. Undoable. |
| `sm.getCameraCuts3D()` → `readonly { frame, cameraId }[]` | The current cut list, frame-sorted — drive the timeline "Cameras" lane off this. Read on **save** to persist. |
| `sm.setCameraCuts3D(cuts)` | Replace the whole list — the **load** path (restore a saved document). `cuts: { frame, cameraId }[]`. Not undoable; fires `onCameraCutsChanged3D`. |
| `sm.clearCameraCuts3D()` | Remove every cut (undoable). |
| `sm.setPreviewThroughCameras3D(on)` | Toggle previewing the timeline through the cuts. While on, every frame the render camera follows whichever camera is active at that frame. |
| `sm.previewThroughCameras3D` → `bool` | Current preview state (for your toggle's pressed state). |

### Export
| Call | Effect |
|---|---|
| `sm.exportCinematicFrames3D(opts, onFrame)` → `Promise<meta>` | Deterministically render the cut sequence, calling `onFrame(pngBlob, index, total)` per frame. Returns `{ frameCount, fps, width, height, durationSec }`. **You** mux the PNGs into WebM/MP4. |

`opts: CinematicExportOptions = { fps, start, end, width, height, frameStep?, format? }` — `start`/`end` are 1-indexed **timeline** frames (inclusive); `width`/`height` are output pixels; the frame is **center-cropped to that aspect** (no stretch). `format` is advisory metadata.

### Events — refresh your panels off these (don't poll)
| Event | Fires when | Use it to |
|---|---|---|
| your existing **scene-graph-changed** subscription | a camera node is added or deleted (cameras are meshes → `createCameraNode3D`/`deleteCameraNode3D` emit the same event your outliner already listens to) | refresh the **camera list** panel |
| `sm.onCameraCutsChanged3D.subscribe(fn)` → returns unsubscribe | a cut is added/removed/cleared, **or changed via undo/redo, or dropped because its camera was deleted** | refresh the **timeline "Cameras" lane** |
| `sm.onViewStateChanged3D` / `sm.onPlayStateChanged3D` | view mode / Play toggles | reflect look-through / preview / Play button states |

You don't need a new event for camera add/delete — they're meshes, so whatever you already use to refresh the outliner covers it. Cuts are *not* scene nodes, so they get their own `onCameraCutsChanged3D` (this is what keeps the lane correct through **undo/redo**, which you can't catch by refreshing after your own setter calls).

---

## 2. Minimal wiring

```ts
// Camera list panel
function refreshCameraList() {
  cameraListPanel.setItems(sm.listCameraNodes3D());   // [{id, name, projection}]
}

// "Add camera" button — drop one where the camera is looking now, gizmo it, and hang the frog marker on it
addCameraBtn.onClick = async () => {
  const id = sm.createCameraNode3D(0, 1.6, 4, { name: `Camera ${sm.listCameraNodes3D().length + 1}` });
  sm.setSelectedNode(id);                              // your existing selection call → gizmo appears
  const frog = await fetch('assets/frog-cloud-camera.png').then(r => r.blob());   // YOUR Frogmarks asset
  await sm.setCameraMarkerSprite3D(id, frog);          // engine hangs it on the camera; auto-hides in the shot
  refreshCameraList();
};

// Look-through toggle (per camera row)
lookThroughBtn.onClick = (id) =>
  sm.lookThroughCamera3D(sm.lookThroughCameraId3D === id ? null : id);

// Drop a cut at the playhead
addCutBtn.onClick = (cameraId) =>
  sm.setCameraCut3D(timeline.getCurrentFrame(), cameraId);

// Preview toggle
previewBtn.onClick = () => sm.setPreviewThroughCameras3D(!sm.previewThroughCameras3D);
```

### Export button

```ts
exportBtn.onClick = async () => {
  const pngs: Blob[] = [];
  const meta = await sm.exportCinematicFrames3D(
    { fps: 30, start: 1, end: 120, width: 1920, height: 1080 },
    (blob) => { pngs.push(blob); progressBar.set(pngs.length); },
  );
  // pngs[] are frame images; mux them to a file (ffmpeg.wasm or your server):
  const file = await muxToMp4(pngs, meta.fps);   // YOUR code
  download(file, `clip-${meta.width}x${meta.height}.mp4`);
};
```

For a quick in-browser WebM instead of a server encode, the engine exposes `pickWebMMime(MediaRecorder.isTypeSupported)` (returns the best `video/webm` codec or `null`) — feed the PNGs through a canvas + `MediaRecorder`, or just keep them as a PNG sequence.

---

## 3. Rules & gotchas

- **Mutually exclusive modes.** Look-through, cut-preview, and ▶ Play all drive the render camera and can't overlap. The engine enforces it — entering Play drops preview/look-through; you can't turn preview on mid-Play. Just reflect `sm.previewThroughCameras3D` / `sm.lookThroughCameraId3D` / `sm.isPlaying3D` in your button states.
- **Markers hide themselves in the shot.** While looking through / previewing / exporting, the camera marker boxes, their frog sprites, and the selected-camera frustum are auto-hidden, so they never appear in the output. Nothing to do host-side.
- **The frog asset lives in Frogmarks, not Salsa.** The engine is content-agnostic — it provides the *mechanism* (`setCameraMarkerSprite3D` hangs a billboard on the camera), you provide the *image*. Bundle the PNG/SVG in the Angular app and pass it as a `File`/`Blob`/`ImageBitmap`. The sprite is drawn **unlit with alpha-cutout** (hard 0.5 alpha threshold, order-independent), so give it clean cut-out edges rather than a soft feathered alpha. Rasterize SVG to a bitmap first (e.g. draw to a canvas → `blob()`), then pass that.
- **Selecting a camera.** `sm.setSelectedNode(nodeId)` is the call — it exists today (selects the node **and** syncs the 3D gizmo; it's what the outliner uses). A camera is just a mesh, so if you already have a "select this mesh / show its gizmo" path, use that. (If your installed `@zaings/salsa` predates this camera work, bump to the build that ships `createCameraNode3D` — `setSelectedNode` is in it.)
- **Aiming.** There's no look-at target field (v1). The user rotates the camera's gizmo; it looks down local −Z. The **frustum wireframe** (amber) draws when a camera node is selected so aiming is visible.
- **Persistence.** Camera **nodes persist automatically** (they're meshes). **Cuts do NOT auto-save** into the document — persist them yourself: read `sm.getCameraCuts3D()` on save, and on load restore via `sm.setCameraCuts3D(cuts)`. (Same host-owns-it pattern as the legacy camera keyframe tracks.)
- **Export is deterministic & offline-ish.** It seeks each frame, renders, and reads pixels back — not a realtime screen-capture — so it's frame-accurate but takes ~one render per frame. Show a progress bar off the `onFrame` index/total. The engine restores the timeline frame, preview state, and edit camera when the export finishes (even on error).
- **Timeline frames are 1-indexed**; `start` must be ≥ 1.
- **FOV units are radians** everywhere in this API (matches `cameraSettings.fov`). Convert if your UI shows degrees.

---

## 4. Suggested panel layout

- **Cameras panel:** list from `listCameraNodes3D()` — each row: name (editable), projection badge, a *look-through* eye toggle, a *drop cut at playhead* button, delete. An "Add camera" button at top.
- **Lens sub-panel** (selected camera): FOV slider (→ `setCameraNodeSettings3D`), projection toggle, a keyframe-FOV button (→ `setCameraFovKeyframe3D` at the playhead) for zooms.
- **Timeline "Cameras" lane:** render markers from `getCameraCuts3D()`; dragging a marker = `removeCameraCut3D(old)` + `setCameraCut3D(new, id)`; a **Preview** toggle at the lane header (→ `setPreviewThroughCameras3D`).
- **Export dialog:** fps / resolution / frame range → `exportCinematicFrames3D`, with a progress bar and your mux-to-file step.
