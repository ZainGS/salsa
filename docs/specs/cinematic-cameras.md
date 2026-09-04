# Cinematic Cameras — placeable camera objects, timeline cuts, and video output (spec)

**Date:** 2026-08-23 · **Status:** P1–P4 CORE BUILT 2026-08-24 (browser-unverified) · **Companions:** `free-camera-and-scene-targets.md` (targets/Play/free-cam), the animation timeline, `depth-precision.md`. **Goal it serves:** turn a scene into a **shareable clip** — the missing "cinematic" layer between "a 3D scene" and "content worth posting."

> **Implementation status (2026-08-24):** the P1–P4 engine core + the functional polish pass are built + unit-tested + type-check + build; browser verification is pending (done at the end of the batch). Done: **P1** CameraNode entity (`createCameraNode3D`/`listCameraNodes3D`/`setCameraNodeSettings3D`/`deleteCameraNode3D` + `lookThroughCamera3D`) & frustum wireframe; **P2** quaternion slerp for camera rotation; **P3** cut track (`setCameraCut3D`/`removeCameraCut3D`/`getCameraCuts3D`, undoable) + timeline preview driver (`setPreviewThroughCameras3D`); **P4** deterministic frame-sequence export (`exportCinematicFrames3D`, PNG-per-frame, host muxes to WebM/MP4). **Polish pass:** Play↔preview↔look-through are now mutually exclusive; cut edits are undoable (and deleting a camera restores its cuts on undo); export center-crops to the OUTPUT aspect (`computeAspectCropRect`, no stretch); **fov-per-camera zoom track** (`setCameraFovKeyframe3D` / the `fov` keyframe track, radians) for in-shot zoom; camera marker boxes auto-hide while looking through / previewing / exporting so they never appear in the shot. Not yet done (cosmetic/host-side): frog-on-cloud billboard marker, in-viewport letterbox bars (WYSIWYG framing during preview), Frogmarks timeline "Cameras" lane / look-through / preview / export UI (see `docs/ui/cinematic-cameras.md`).

## Why

Today you can keyframe **one** camera (the viewport camera — `_cameraKeyframeTracks`: position/target/fov over the timeline). That gives a single moving shot. What's missing is the thing every 3D tool has: **multiple placeable camera OBJECTS you cut between on the timeline** — a static wide, a slow push-in, a close-up — sequenced into a shot list, previewed on playback, and **exported to video**. That sequence *is* the content pipeline, and it composes directly with the free-cam/scene work (author in free3D → drop cameras → sequence → play → export).

## What exists vs. what's new

- **Exists (reuse):** `Camera3D` render camera; per-node transform **keyframe tracks** + evaluation (Mesh3D `setMeshKeyframe3D`); the animation **timeline/clip** system; **billboard/sprite** meshes; the **gizmo/selection**; the **line-overlay pipe** (`drawGrid`/`drawArtboardFrame`); scene-graph nodes + `toJSON` persistence; the single-camera track `_cameraKeyframeTracks` (becomes a special case — see §10).
- **New (this spec):** the **CameraNode** entity, the **cut/shot track**, the **preview driver** ("play through cameras"), the **markers** (frog billboard + frustum), and **P4 video export**.

---

## 1. CameraNode — a placeable camera entity

A scene-graph node like a mesh but with **no geometry** — it carries a camera. Placeable, transformable with the existing gizmo, selectable, keyframable, persisted.

```ts
interface CameraNode extends Node {          // same base as Mesh3D → gets transform + keyframeTracks for free
  kind: 'camera';
  name: string;                              // "Wide", "Push-in", "Close-up"
  fov: number;                               // vertical FOV (radians) — perspective
  projection: 'perspective' | 'orthographic';
  orthoSize?: number;                        // half-height (ortho)
  near: number; far: number;
  // pose is DERIVED from the node transform: eye = world position; look dir = rotation · (0,0,-1);
  //   up = rotation · (0,1,0). So you AIM by rotating the gizmo — no separate target field in v1.
  aimTargetId?: string | null;              // OPTIONAL (P2+): look-at constraint → overrides rotation to face a node
  // DOF / motion-blur reserved for later.
}
```

- **Deriving the render camera** from a CameraNode: `eye = node.worldPosition`; `forward = mat3(node.worldMatrix)·(0,0,-1)`; `up = …·(0,1,0)`; then `cam.lookAt(eye, eye+forward, up); cam.fov = node.fov; cam.mode = node.projection`. (Same `cam.lookAt` path Play/fly already use.)
- **Aspect** is NOT stored on the camera — it comes from the **output** (§4), so one camera frames correctly at any output aspect (like a real render camera).
- **Static vs moving falls out of keyframes** (§2): no keyframes → fixed pose; keyframed transform → a move/rotate. Nothing camera-specific to build for animation.

**API (mirrors the mesh factory):**
```ts
sm.createCamera3D(x,y,z, opts?: { name?, fov?, projection?, near?, far? }): string   // returns node id
sm.listCameras3D(): { id, name, projection }[]
sm.setCameraSettings3D(id, { fov?, projection?, orthoSize?, near?, far?, name? })
sm.deleteCamera3D(id)
sm.lookThroughCamera3D(id | null)      // preview the render camera through this camera (null = back to edit cam)
```

---

## 2. Animating a camera — REUSE transform keyframes

A CameraNode has the same `keyframeTracks` as a Mesh3D, so the **existing** keyframe API animates it:
```ts
sm.setMeshKeyframe3D(cameraId, 'positionX'|'positionY'|'positionZ'|'rotationX'|'rotationY'|'rotationZ', frame, value, easing?)
sm.setCameraFovKeyframe3D(cameraId, frame, value, easing?)   // fov is camera-specific → its own track
```
- Rotation interpolates via the node's existing rotation interpolation; **use quaternion slerp** for camera rotation to avoid gimbal/lerp wobble on big turns (verify the node rotation track slerps; if it euler-lerps, add a slerp path for cameras).
- FOV gets one extra scalar track (dolly-zoom = animate position + fov together).
- Evaluate a camera's pose at frame `f` = evaluate its keyframeTracks at `f` (existing evaluator) → derive the render pose (§1).

## 3. The cut / shot track — which camera is active when

A single timeline track of **cuts** (step-interpolated → hard cuts):
```ts
interface CameraCut { frame: number; cameraId: string; }        // sorted by frame
// active camera at frame f = the cut with the largest frame ≤ f (else: no override → edit camera)
sm.setCameraCut3D(frame, cameraId)      // add/replace a cut
sm.removeCameraCut3D(frame)
sm.getCameraCuts3D(): CameraCut[]
sm.clearCameraCuts3D()
```
- Lives on the **document** (one shot list per doc/clip), NOT per-object.
- **Default (no cuts):** playback uses the edit camera or the legacy single-camera track (§10) — non-breaking.
- **Blends/crossfades** between cameras (ease over N frames) = P4; v1 is hard cuts.

## 4. Preview driver — "play through cameras"

A toggle (`previewThroughCameras`) that, while ON, **drives the render camera from the cut track** every frame (playback AND scrubbing):
```ts
sm.setPreviewThroughCameras3D(on: boolean)
sm.isPreviewingCameras3D: boolean
```
Per frame `f`:
1. `active = cutTrack.activeAt(f)` (§3). If none → keep the edit/legacy camera.
2. Evaluate `active`'s pose at `f` (§2) → drive the render camera (§1).
3. **Letterbox to the OUTPUT aspect** (e.g. 16:9, or the illustration's X×Y aspect) with a safe-frame overlay, so you see the true output framing (reuse the artboard-frame line pipe for the letterbox bars/frame).
4. **Hide the camera markers** (§5) while previewing (esp. the active camera's own marker) — you don't want them in shot.
On toggle OFF (or exit) → restore the edit camera (same snapshot/restore pattern as Play mode).

**Relationship to Play:** Play mode (character controller) and camera-preview are **different drivers of the render camera** — mutually exclusive (entering one disables the other). Cinematic preview = "watch the movie"; Play = "walk around."

## 5. Markers — the frog-with-a-camera-on-a-cloud + frustum

**(a) The billboard marker** — a `sprite`/billboard at each CameraNode's position, textured with a **frog-on-a-cloud-holding-a-camera** icon (on-brand, a single 2D texture). Reuses the existing billboard mesh path (faces the viewport camera).
- **Visibility:** editor only. Hidden during **camera preview** (§4) and in the **final export** (§7). A per-node `showMarker` and a global toggle.
- Clicking a marker selects the CameraNode (so you can gizmo it / look through it).

**(b) The frustum (on select)** — when a CameraNode is selected, draw its **view frustum** as a wireframe pyramid (apex at the eye, the 4 rays to the far-plane rectangle sized by `fov`/`near`/`far`, + the near/far rects). This shows *exactly what the camera captures*, Blender-style.
- **Cheap:** it's ~12 line segments → reuse the `_boneLinePipe` line path exactly like `drawArtboardFrame` (a new `drawCameraFrustum(pass, camera, node)` in the gizmo renderer; renderer-3d gates it on "a CameraNode is selected").
- Optionally draw a thin frustum for ALL cameras faintly, the selected one bright.

---

## 6. Engine API summary

```ts
// entity
createCamera3D(x,y,z,opts?) → id · listCameras3D() · setCameraSettings3D(id,patch) · deleteCamera3D(id) · lookThroughCamera3D(id|null)
// animation (reuse mesh keyframes on the camera id) + fov track
setMeshKeyframe3D(camId, 'positionX'|…|'rotationZ', frame, value, easing?) · setCameraFovKeyframe3D(camId, frame, value, easing?)
// shot list
setCameraCut3D(frame,camId) · removeCameraCut3D(frame) · getCameraCuts3D() · clearCameraCuts3D()
// preview
setPreviewThroughCameras3D(on) · isPreviewingCameras3D
// markers
setCameraMarkersVisible3D(on) · (frustum auto on selection)
// events
onCamerasChanged3D  (list/cuts changed → refresh the camera panel + timeline track)
```
All undoable via the existing stack (create/delete/keyframe/cut are scene-graph ops).

## 7. P4 — video export (the piece that makes it monetizable)

A cinematic preview you can't export is just a preview. Export renders the frame range through the sequenced cameras to a **video**:
```ts
exportCinematic3D({ fps, startFrame, endFrame, width, height, format: 'webm'|'frames' }): Promise<Blob | Blob[]>
```
- **Simplest browser path:** drive the timeline frame-by-frame with camera-preview on, render each frame at the target resolution, capture via `canvas.captureStream(fps)` + `MediaRecorder` → a **WebM** blob. (No native deps; social-ready.)
- **Higher quality:** render each frame to an offscreen target at `width×height`, read back a PNG per frame → hand the frame sequence to the host (Frogmarks) to encode (server ffmpeg or `ffmpeg.wasm`) → MP4/H.264 (the format social platforms prefer).
- **Deterministic:** step the timeline manually (not the realtime GameLoop) so every frame renders fully regardless of encode speed.
- Markers/gizmos/grid **off** during export; letterbox baked to the output aspect.

## 8. Frogmarks UI

- **Camera panel** (a list, like the outliner section): each camera row = name + [look-through 👁] + [select/gizmo] + settings (fov slider, projection, near/far). "＋ Add Camera" → `createCamera3D` at the current view. Drive off `onCamerasChanged3D`.
- **Timeline: a "Cameras" track** — a lane of cut markers; drag to move a cut, click a gap to add one (pick a camera), delete to remove. Renders `getCameraCuts3D()`.
- **▣ Look-through toggle** (per camera) + a **"Preview through cameras"** play-mode toggle on the timeline transport → `setPreviewThroughCameras3D`.
- **Markers toggle** (show/hide the frog billboards).
- **Export button** → `exportCinematic3D(...)` with fps/resolution/range/format pickers; show progress; hand back the blob to download/share.
- Camera-preview and Play are mutually exclusive transport modes — reflect that in the UI.

## 9. Persistence

- **CameraNodes** persist as scene nodes (transform + fov/projection/near/far/name + keyframeTracks) via the existing node `toJSON` — params-only, no baked geometry. They restore like any node.
- **The cut track** persists on the document (alongside the timeline/clip data): `cameraCuts: CameraCut[]` + `previewThroughCameras` flag.
- Back-compat: old docs have no cameras/cuts → the legacy single-camera track still drives playback (§10).

## 10. Coexistence with the legacy single-camera track

`_cameraKeyframeTracks` (the current one-camera timeline animation) stays working:
- If there are **no CameraNodes / no cuts**, playback uses the legacy track exactly as today (non-breaking).
- When cuts exist and preview-through-cameras is ON, the **cut track wins**.
- **Optional migration:** a one-click "convert the legacy camera animation into a CameraNode" (wrap the existing tracks in a single CameraNode + a cut at frame 0). Nice-to-have, not required.

## 11. Phasing (each phase ships + tests independently)

- **P1 — cameras you can place and look through.** CameraNode entity (create/list/settings/delete, gizmo, select, persist) + `lookThroughCamera3D` (drive the render camera from a static camera) + the **frog billboard marker** + the **frustum-on-select**. Tests: create→persist round-trip; pose derivation (position/forward/up/fov) is correct; frustum corner math.
- **P2 — animate a camera.** Per-camera transform keyframes (reuse) + the fov track + **quaternion slerp** for camera rotation. Test: a keyframed camera evaluates to the right interpolated pose at in-between frames.
- **P3 — cut between cameras.** The cut track + `previewThroughCameras` driver (active-camera resolution, drive render camera, letterbox, hide markers) + the timeline Cameras lane. Tests: `activeAt(frame)` resolution (step); preview drives the right camera per frame.
- **P4 — export to video.** `exportCinematic3D` (WebM via captureStream first; frames→MP4 path second) + deterministic frame stepping + markers/gizmos off. Test: frame stepping visits every frame with the right active camera; export produces a non-empty blob (integration/browser).

## 12. Gotchas / decisions

- **Rotation interpolation:** camera turns MUST slerp (quaternion), not euler-lerp, or a >90° pan wobbles/gimbals. Verify the node rotation track; add a camera slerp path if needed. (P2.)
- **Aspect ratio:** the camera stores `fov` (vertical); horizontal FOV = derived from the OUTPUT aspect, not the editor viewport. Preview letterboxes to the output aspect so what you see = what exports.
- **Ortho cameras:** support `projection:'orthographic'` + `orthoSize` (for iso/architectural shots). The frustum becomes a box.
- **Cut vs blend:** v1 = hard cuts (step). A crossfade needs blending two camera poses (slerp position + look) over N frames — P4 polish.
- **Near/far + depth:** big worlds want a large `far`; keep the reversed-Z / autoNear work in mind (`depth-precision.md`) so far shots don't z-fight.
- **Illustration vs scene target:** cameras + video make most sense for a **scene / animated timeline** output. In an **illustration** doc they still work (preview + export a video of the animated illustration), but the doc's *still* X×Y output is unchanged — the camera video is an additional output, not a replacement.
- **Play vs preview:** mutually exclusive render-camera drivers; guard so entering one exits the other.
- **Marker in shot:** always hide the active camera's own marker (and ideally all markers) during preview + export.

## 13. Not doing (v1)

- Crossfade/blend transitions (P4 polish), camera shake, depth-of-field / motion blur, focus pull.
- Aim/look-at constraints (P2+ optional `aimTargetId`).
- Multi-track audio, timeline markers, a full NLE. This is a *camera* system, not a video editor.
- Physical-camera lens sim (sensor size, real focal lengths) — `fov` is enough for stylized content.
