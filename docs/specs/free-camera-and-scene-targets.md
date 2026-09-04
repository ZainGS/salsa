# Targets & Camera Modes — free-cam 3D + illustration/scene duality (spec)

**Date:** 2026-08-22 · **Status:** planned · **Companions:** `street-level-mode` notes, `depth-precision.md`, `viewport-clamps` (memory), `scene-authoring.md` (UI).

## The idea in one line

Decouple **what a document produces** from **how you look at it**. A document has a **target** (2D illustration *or* 3D interactive scene) and a **camera mode** (2D-ortho / 2D-perspective / 3D-free). The two are **independent axes** — every target supports every camera mode — and switching either is a **non-destructive view/intent change**, never a data conversion.

```
                 CAMERA MODE  →   2D-ortho        2D-perspective     3D-free (orbit/fly)
   TARGET ↓
   illustration  (X×Y output)     today's default  today's persp      NEW: free-navigate the
                                   (artboard cam)   (artboard cam)     illustration; artboard = render frame
   scene         (interactive)    ortho scene view perspective view   NEW: game-editor default; Play runs it
```

The current app = **illustration target × {2D-ortho, 2D-perspective}**. This spec adds the **3D-free camera** (both targets) and the **scene target** (with its own output + eventual Play mode). Nothing existing is removed; it's two new orthogonal capabilities.

## Why two axes (and not an a-vs-b choice)

Three things are currently fused and must be split:

1. **Scene** — the data: the 3D scene graph **+** the 2D raster/vector layers. Identical in all modes.
2. **Camera mode** — a *view/navigation* state. Non-destructive toggle.
3. **Target** — a per-document *intent*: produce an `X×Y` composite, or an interactive/playable world. Non-destructive; even switchable both ways (the data is the same; only Export/Play semantics change).

This means: the "illustrator who wants 3D as an edit mode" and the "game maker" are the **same engine** with a different `target` flag — and a doc can graduate illustration → scene later without losing anything.

---

## 1. State model (persisted per-document)

```ts
type Target     = 'illustration' | 'scene';
type CameraMode = 'ortho2D' | 'perspective2D' | 'free3D';

interface ViewState {
  target: Target;                      // default 'illustration'
  cameraMode: CameraMode;              // default 'ortho2D'
  // Each camera mode remembers its own pose so switching restores your vantage:
  flatCam?: { pan: [x,y], zoom };      // shared by the two 2D modes
  freeCam?: { target: V3, radius, yaw, pitch, projection: 'ortho'|'perspective' };
  showArtboardFrame?: boolean;         // free3D + illustration: draw the artboard RENDER SAFE-FRAME outline (default true)
}
```

- `flatCam`/`freeCam` persist so illustration keeps its Fit/zoom and scene keeps your orbit vantage across reloads (today pan/zoom isn't persisted — the free-cam pose SHOULD be, so returning to a scene lands where you left).
- The 2D raster/vector layer data always persists in the document regardless of target/camera — it's never touched by a mode switch.

## 2. Derived behaviour (target × cameraMode → what renders / what's editable)

Everything below is **computed from the two flags** — there is no separate "delete the 2D canvas" step.

| Behaviour | Rule |
|---|---|
| **Artboard scissor + 2D composite in the VIEWPORT** | on iff `target==illustration && cameraMode!=free3D` |
| **2D raster/vector TOOLS active** | on iff `target==illustration && cameraMode!=free3D` |
| **3D tools (gizmos, Add-Mesh, UV-paint) active** | on iff `cameraMode==free3D` OR `target==scene` |
| **Camera navigation** | ortho2D/perspective2D = locked pan/zoom (no orbit); free3D = orbit + pan + dolly (+ fly) |
| **Projection** | ortho2D = ortho; perspective2D = perspective; free3D = its own `projection` (default perspective) |
| **Viewport clamps** | 2D modes = illustration pan/zoom bounds; free3D = unclamped (already dropped via `setViewport3DPredicate`) |
| **The document OUTPUT** | illustration = `X×Y` composite from the **artboard/render camera** (see §3); scene = the interactive runtime (see §4) |

Key consequence: in **illustration × free3D**, the *edit* camera (free) ≠ the *render* camera (artboard). You navigate freely, but the exported/thumbnailed image still comes from the fixed artboard camera — the Blender **viewport-vs-render** split.

## 3. Illustration target — the artboard is the render frame

- Keeps everything it has today (artboard `X×Y`, the 2D compositor, raster/vector layers, export).
- **2D-ortho / 2D-perspective:** exactly today's behaviour — the camera you look through *is* the render camera; artboard scissor + 2D composite on.
- **3D-free (NEW):** free-navigate the same scene. The artboard renders as a **render SAFE-FRAME outline** (a rectangle at the artboard bounds, `showArtboardFrame`, default on) — a Blender-style "here's what the X×Y output captures" cue, so you can arrange 3D objects and know whether they're **in frame** without toggling back to 2D. 2D tools are hidden; 3D tools are active; UV-paint works on the objects. (NOT a textured composite of the 2D art — to *see* the art you just switch to a 2D camera mode; painting the composite onto a plane would be redundant.)
  - **Output stays 2D:** export / thumbnail / the "final render" always renders the artboard camera view *with* the 2D composite, regardless of where the edit camera is. So free-cam is a pure editing convenience — the illustration's identity is intact.
  - Objects created far from the artboard won't be *in* the 2D output (they're in the scene, outside the render frustum). Surface a subtle **"outside frame"** cue in the outliner/gizmo.

## 4. Scene target — output is the interactive world

- **No artboard scissor, no fixed 2D output.** The whole viewport is the 3D world; the 2D composite is not drawn (layers still persist as data, just dormant — you can graduate back to illustration and they return).
- All three camera modes still apply — they're just how you *view* the scene: `ortho2D` = isometric/top-down authoring view, `perspective2D` = a fixed perspective, `free3D` = the game-editor default (orbit/fly).
- The document's "output" is the runtime: eventually a **Play** button (§6) runs it with a character controller + game loop.
- Larger worlds: relax the orbit `maxRadius` clamp (today 50) for scene target; the `autoFar`/`autoNear` camera already tracks scene radius.

## 5. Non-destructive guarantees (the whole point)

- `target` and `cameraMode` are **view/intent flags**. Toggling them never creates/deletes/converts data.
- Raster + vector layers live in the document at all times; scene mode simply **doesn't draw or edit them** (no visibility mutation even needed — the renderer skips the 2D composite when the derived rule says so).
- Switching illustration ⇄ scene is reversible; the 3D scene graph and 2D layers are the same object either way.
- Play mode (§6) is also non-destructive: **snapshot on Play → restore on Stop** (Unity model), so running the game never mutates the authored scene.

## 6. Layer 3 — Play mode + character controller (BUILT — see `play-mode.md`)

> **Status update (2026-09-02):** this went far past the "boundary only" plan below. Play mode is now a full walkaround — collision (ground/wall-slide/step-up + spatial broadphase), mouse-look, first/third-person, a follow avatar, walk/idle/run/jump/fall animation hooks, **trigger volumes + an interaction "use" verb that dispatch into the UI state machine**, and non-destructive TRS snapshot/restore. The living spec is now **`docs/specs/play-mode.md`**; the host contract is **`docs/ui/play-mode.md`**. Still genuinely later: real rigid-body physics, capsule collision, third-person camera-vs-wall pull-in. The original roadmap is kept below for context.

Scene target unlocks a runtime, entered/exited non-destructively:

- `enterPlayMode()` → **snapshot** the scene graph + component state → start a fixed-timestep **game loop** (input sampling, character controller, later physics/scripts) → the active camera becomes the **game camera** (first/third-person driven by the controller). `exitPlayMode()` → **restore** the snapshot.
- New home `src/game/`: a `CharacterController` (capsule + move/jump/look), an input layer, a `GameLoop`. This is the same "SIM half" the street-level-mode notes call out — build the free-cam + scene target first; street-level and Play both plug into it.
- P1 ships the **boundary only** (the enter/exit hooks + snapshot/restore + an empty loop) so the surface exists; the controller/physics are later phases.

## 7. Engine API (what P1 adds; reuses existing hooks)

On `ShapeManager` / `scene3d` (the orchestrator that composes the derived rules of §2):

```ts
sm.setTarget3D(target: 'illustration' | 'scene'): void        // persisted; emits onViewStateChanged
sm.setCameraMode3D(mode: 'ortho2D'|'perspective2D'|'free3D'): void   // persisted per-mode pose
sm.getViewState3D(): ViewState
sm.onViewStateChanged: Event                                   // Frogmarks swaps toolbars off this
sm.setArtboardFrameVisible3D(on: boolean): void               // illustration × free3D
// L3 stubs:
sm.enterPlayMode3D() / exitPlayMode3D(): void                 // scene target; snapshot/restore
```

Reuses (no new camera code, mostly wiring):
- `syncIllustrationCamera` — the flat 2D camera (ortho2D/perspective2D).
- `enableOrbitControls` / `disableOrbitControls` — free3D nav (extend with a WASD **fly** in P2).
- `setViewport3DPredicate` — already drops the 2D pan/zoom clamps for free3D.
- `setIllustrationProjection` — ortho ⇄ perspective for the flat modes.
- `getArtboardInfo3D` / `getIllustrationBounds` — the artboard/render camera framing (the fixed `X×Y` output) even while the edit camera roams.
- The `RasterLayerManager` / vector layers stay as-is (dormant in scene/free3D).

## 8. 2D tools, brush, UV paint, vectors per cell

- **Raster/vector editing** — only in illustration × {2D modes} (needs the artboard-aligned flat view).
- **The brush system is reused for UV/surface paint in free3D and scene** — already built (`enterUVPaintMode3D`, surface-paint raycast + world-space brush + skin-aware picker). Just expose it in the 3D toolset.
- **Vectors-in-world (phase 2, optional):** reuse the **decal / billboard / LiveText** system, which already places 2D content at a 3D position, to drop a vector shape onto a plane/billboard anywhere in the world. Not in P1; vectors stay 2D-layer-only until then.

## 9. Frogmarks UI contract

- **Target picker** at document creation ("New Illustration" / "New Scene") + a switch in doc settings (with a "this changes what Export/Play do; your data is kept" note).
- **Camera-mode control** — a 3-way toggle (2D Ortho / 2D Perspective / 3D Free), always visible, both targets. (Replaces/extends today's ortho/persp toggle.)
- **Toolbar swap** driven by `onViewStateChanged`: show 2D raster/vector tools only in illustration × 2D modes; show 3D tools (gizmos, Add-Mesh, modifiers, UV-paint) in free3D or scene.
- **Artboard-frame toggle** (illustration × free3D): show/hide the render safe-frame outline.
- **Play button** (scene target): visible but stubbed in P1 (calls `enterPlayMode3D` → empty loop) — the affordance exists so the roadmap reads.

## 10. Persistence (save format additions)

- Add `viewState { target, cameraMode, flatCam, freeCam, showArtboardFrame }` to the document. All optional with the current defaults (`illustration` / `ortho2D`), so **existing saves load unchanged** as illustrations.
- The free-cam pose persists (new — today's flat pan/zoom is transient; scene mode needs its vantage remembered).

## 11. Phasing

- **P1 (core, non-destructive foundation):** `target` + `cameraMode` state machine + derived rules; the **3D-free camera** for the illustration target (orbit/pan/dolly, artboard-as-frame, 2D tools hidden, 3D tools + UV-paint on); persist the flags + free-cam pose; `onViewStateChanged` event. This alone gives the "edit my illustration in 3D" experience and is the mandatory groundwork for everything else.
- **P2:** the **scene target** (drop the artboard/composite, relax clamps, isometric/perspective/free views of a pure 3D world); WASD-fly nav; the "outside frame" cue; Frogmarks target picker.
- **P3:** **Play mode** boundary → then the `src/game/` `CharacterController` + game loop + input (the game-engine dream). Snapshot/restore non-destructive enter/exit.
- **P4 (optional):** vectors-in-world (billboards), render-the-artboard-from-a-roaming-scene export, physics.

## 12. Gotchas / open questions

- **Viewport vs. render camera (illustration × free3D):** the exported image comes from the artboard camera, not the edit camera — make that obvious in the UI (the render safe-frame outline + an "F to frame the render camera" shortcut).
- **World scale:** illustrations use tiny units (~2-unit artboard); scenes may be metres. Objects keep their coords across a target switch; free-cam handles any scale; relax orbit `maxRadius` for scene.
- **Coordinate cue:** objects outside the artboard frustum in an illustration are valid but invisible in the 2D output — flag them.
- **Play-mode input focus / escape** (P3): standard game-editor concerns; out of P1 scope.

## 13. Not doing (v1)

- Physics, scripting, multiplayer (far-future game layers).
- Converting existing 2D raster art into 3D geometry (it stays 2D layers; to view it, switch to a 2D camera mode).
- A textured-composite artboard "plane" in free3D — dropped as redundant (toggle to 2D to see the art; the outline already shows the render bounds).
- A separate render-camera *object* you can keyframe (the artboard camera is the render camera for now).
