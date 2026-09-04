# Free-Camera & Targets — Frogmarks UI Integration Guide

**Audience:** Frogmarks (Angular host) developers wiring the view-mode toolbar + panel visibility.
**Date:** 2026-08-22 · **Engine spec:** [../specs/free-camera-and-scene-targets.md](../specs/free-camera-and-scene-targets.md) · **Sibling:** [scene-authoring.md](./scene-authoring.md).

---

## 0. The model in one line

A document has **two independent axes**: a **target** (what it produces) and a **camera mode** (how you navigate). All six combinations are valid, and switching either is **non-destructive** — it never touches the data, only what renders / which tools show / how the camera moves.

```
                CAMERA MODE →   ortho2D          perspective2D      free3D (orbit/pan/dolly + WASD-fly)
  TARGET ↓
  illustration  (X×Y output)    today's default  today's persp      NEW: free-navigate; artboard = render frame
  scene         (interactive)   iso view         fixed persp        NEW: game-editor view + ▶ Play
```

Today's app = `illustration × {ortho2D, perspective2D}`. P1 (engine-side, **done**) adds the machinery; Frogmarks wires the toolbar + panel show/hide. **The engine handles the camera; you handle the panels.**

---

## 1. The one pattern to implement

Everything is driven by **one event + one getter**:

```ts
sm.onViewStateChanged3D.subscribe(() => applyViewUI(sm.getViewRules3D()));

function applyViewUI(rules /* ViewRules */) {
  show2DPanels(rules.twoDToolsActive);   // raster layers / brush / vector tools
  // 3D panels (add-mesh, gizmos, modifiers, UV-paint) stay ALWAYS visible — see §3
  projectionIndicator.set(rules.projection);
  artboardFrameToggle.visible = rules.artboardFrame || sm.getViewState3D().cameraMode === 'free3D';
  playButton.visible = !rules.outputIsArtboard;   // scene target only (see §5)
  exportMode.set(rules.outputIsArtboard ? 'image' : 'scene');
}
```

`getViewRules3D()` returns the **derived** rules for the current state — you never compute the matrix yourself. (If you want it client-side, `deriveViewRules` is exported from `@zaings/salsa` too.)

---

## 2. The API surface (all on `sm`)

| Call | Effect |
|---|---|
| `sm.setCameraMode3D('ortho2D' \| 'perspective2D' \| 'free3D')` | Switches the camera. free3D = orbit/pan/dolly + nav gizmo; the 2D modes = the locked illustration camera at that projection. Fires `onViewStateChanged3D`. |
| `sm.setTarget3D('illustration' \| 'scene')` | Switches what the doc produces. Fires the event. |
| `sm.setArtboardFrameVisible3D(on)` | illustration × free3D: show/hide the artboard **render safe-frame outline** (marks what the X×Y output captures). |
| `sm.getViewState3D()` | `{ target, cameraMode, flatCam?, freeCam?, showArtboardFrame }`. |
| `sm.getViewRules3D()` | The derived `ViewRules` (below) — drive all UI off this. |
| `sm.onViewStateChanged3D` | `EventEmitter<void>` — `.subscribe(fn)`; fires on any target/camera/frame change (incl. on document load/restore). |
| `sm.setFlyEnabled3D(on)` · `sm.isFlyEnabled3D` | Editor **WASD-fly** of the free3D camera (opt-in, only active in free3D). See §4. |
| `sm.enterPlayMode3D(opts?)` · `sm.exitPlayMode3D()` · `sm.isPlaying3D` | **Play mode** — full walkaround (collision, mouse-look, 1st/3rd person, avatar, animation, triggers, interaction). See §5 + `docs/ui/play-mode.md`. |
| `sm.setPlayInput3D({forward,right,jump,lookYaw,lookPitch})` | Feed custom input while playing (if you passed `{keyboard:false, mouseLook:false}`). |
| `sm.setArtboardTextured3D(on)` · `sm.exportIllustrationTransparentPNG()` | Textured artboard in free3D + transparent PNG export. See `docs/ui/textured-artboard.md`. |
| `sm.onPlayStateChanged3D` | `EventEmitter<void>` — fires on Play enter/exit (toggle the ▶/⏹ button). |

**`ViewRules` fields** (what each drives):

| Field | Meaning / UI use |
|---|---|
| `twoDToolsActive` | **Show the 2D editing TOOLS** (brush/paint, vector-draw) iff true. NOTE: this is the *tools*, not the Layers panel — the Layers list follows `target`, not camera mode. See §3a. |
| `twoDComposite` / `artboardScissor` | Engine renders the 2D canvas + scissor (informational; you don't act on it). |
| `freeNavigation` | Orbit/pan/dolly is on (vs locked pan/zoom). Use for cursor hints / "Alt-drag to orbit" help. |
| `projection` | `'orthographic'` \| `'perspective'` — reflect in the projection indicator. |
| `unclampCamera` | The 2D pan/zoom bounds are dropped (free roam). Informational. |
| `artboardFrame` | The artboard render safe-frame outline should show (illustration × free3D + `showArtboardFrame`). |
| `outputIsArtboard` | `true` → doc exports an X×Y image (illustration); `false` → interactive scene. Gates Export mode + the Play button. |

---

## 3. What shows in each cell (2×3)

| | ortho2D | perspective2D | free3D |
|---|---|---|---|
| **illustration** | 2D panels ✅ + 3D panels ✅, locked ortho cam, artboard composite | same, perspective | **2D panels hidden**, 3D panels ✅, free orbit, clean bg + render safe-frame outline |
| **scene** | 3D panels ✅, locked ortho ("iso") cam | 3D panels ✅, fixed persp | 3D panels ✅, free orbit — the game-editor view |

**Key rule:** the **3D object tools always stay visible** (Add-Mesh, transform gizmos, modifiers, UV-paint) — you can put 3D objects in a 2D illustration today, so they're never hidden. There is intentionally **no `threeDToolsActive` flag**. Only the **2D editing tools** toggle (via `twoDToolsActive`). This matches how the 2D + 3D panels already coexist on-screen — P1 just adds "hide the 2D *tools* in free3D / scene."

---

## 3a. Layers panel vs 2D tools — keep them separate

A subtle but important distinction (and the cause of the "panel goes blank in 3D Free / Scene" bug):

- **2D editing TOOLS** (brush/paint, vector-draw) → follow **`twoDToolsActive`**: hidden in free3D and in scene (you can't paint the flat canvas without the aligned 2D view). Correct.
- **The LAYERS panel** (visibility toggles, reorder, rename, opacity, the 3D-scene entry, vector layers) → follows **`target`, NOT camera mode**. It's *management*, not *editing*, and the layers are the document's content in every view:

| `target` | Layers panel |
|---|---|
| **illustration** (incl. **free3D**) | Show the **full** list — raster + vector + 3d-scene + folders + ephemera. Switching to 3D Free must **not** blank it; you're still editing the same illustration, just viewing it in 3D. |
| **scene** | Show **vector + ephemera + 3d-scene + folders**; **drop raster** (`type === 'layer'`). The scene has no 2D composite output, so raster layers are meaningless — but vector layers are your UI/HUD overlays and the 3D outliner is the main content. |

**How to filter** (a few lines host-side — no new engine API):

```ts
const scene = sm.getViewState3D().target === 'scene';
const layers = sm.getLayers().filter(l => !(scene && l.type === 'layer'));  // drop raster in scene
// re-run on sm.onViewStateChanged (target/camera switch) AND sm.onLayerStructureChanged (add/remove)
```

`sm.getLayers()` entries each carry a **`type`**: `'layer'` (raster) · `'vector'` · `'ephemera'` · `'folder'` · `'3d-scene'`. (`sm.getVectorLayers()` returns just the vector/ephemera list if you want it separately.)

So: **Layers panel visibility keys off `target`; only the 2D drawing *tools* key off camera mode.** Hiding the whole panel in free3D is the bug to fix.

---

## 4. The toolbar (Frogmarks' call on placement — here's the recommendation)

Per your own feedback, put the controls in the **top toolbar with visible labels** (never silently left on):

- **Camera-mode toggle** — a 3-way segmented control: `2D Ortho · 2D Perspective · 3D Free`. Always visible, both targets. (Replaces/extends today's ortho/persp toggle.) → `sm.setCameraMode3D(mode)`.
- **Target switch** — `Illustration ⇄ Scene` (a toggle or a dropdown in doc settings). Add a one-time note: *"changes what Export/Play do; your layers and 3D objects are kept."* → `sm.setTarget3D(target)`.
- **Artboard-frame checkbox** — visible only in illustration × free3D. → `sm.setArtboardFrameVisible3D(on)`.
- **▶ Play button** — show it when `target === 'scene'`; it works now (§5).
- **🛩 Fly toggle** — an editor WASD-flythrough of the free3D camera. `sm.setFlyEnabled3D(on)` / `sm.isFlyEnabled3D`. Show it only in `free3D`; off by default (so it never captures WASD unless the user opts in). Aim by orbit-drag; W/S fly, A/D strafe, E/Space up, Q down, Shift boost.

`viewModeLabel(getViewState3D())` (exported) gives a stable label like `"Illustration · 3D Free"` for tooltips/analytics.

---

## 5. Play button (scene target) — WORKS NOW

`target: scene` gets a **▶ Play** button. It's live:

```ts
sm.enterPlayMode3D();     // first-person: WASD move, Q/E or ←/→ turn, Space jump — built-in keyboard, no wiring
sm.exitPlayMode3D();      // restores the pre-play camera + edit view (non-destructive)
sm.isPlaying3D;           // boolean
sm.onPlayStateChanged3D.subscribe(() => togglePlayStopButton(sm.isPlaying3D));
```

Play mode has grown well past a first-person walk — it now has **real collision** (walk on scene geometry, wall-slide, step-up, spatial broadphase), **mouse-look** (pointer-lock), **first/third-person** + a follow **avatar**, **walk/idle/run/jump/fall animation** hooks, and **trigger volumes + an interaction "use" verb** that dispatch into the UI state machine. **See `docs/ui/play-mode.md` for the full contract** — this section is just the entry point.

- **Built-in keyboard + mouse-look on by default** — WASD/arrows move, Q/E turn, **F use**, Space jump, mouse looks (click the canvas to capture the pointer). The host doesn't wire keys.
- **Custom input** (gamepad, on-screen pad): `enterPlayMode3D({ keyboard: false, mouseLook: false })` then feed `sm.setPlayInput3D({ forward, right, jump, lookYaw, lookPitch })` each frame.
- **Options:** `enterPlayMode3D({ start, config: { cameraMode:'first'|'third', moveSpeed, … }, collision, keyboard, mouseLook, playerMeshId })`.
- **UI:** show ▶ when `target === 'scene'`; flip it to ⏹ on `onPlayStateChanged3D`. Non-destructive (scene transforms snapshotted on enter, restored on stop).
- **Note:** Play also runs in **illustration × free3D**, not only scene target — but the 3D view (incl. Play) is dormant until the **"3D Scene" layer is the active layer** (see `play-mode.md` gotcha; auto-activate it on entering a 3D view).

---

## 6. Persistence & load

- **Automatic.** The view state (`target`, `cameraMode`, camera poses, `showArtboardFrame`, `showArtboardTexture`) is saved inside the scene settings and restored on load — `onViewStateChanged3D` fires during restore, so your `applyViewUI` runs and the panels come up correct. No save/load code needed on your side.
- **Back-compat:** documents saved before this feature have no view state → they load as `illustration / ortho2D` (unchanged).

---

## 7. Current engine status

✅ **All engine-side, DONE and building green — safe to wire against now:**
- **Camera modes** — `free3D` orbits/pans/dollies with the nav gizmo + a clean workspace bg (2D composite dropped); the 2D modes snap back to the locked illustration camera at the chosen projection.
- **Targets** — scene shows a clean 3D workspace (no 2D composite) in every camera mode; illustration keeps its composite. State + event + persistence + all getters.
- **Artboard render safe-frame outline** — drawn in illustration × free3D (`setArtboardFrameVisible3D`).
- **Textured artboard (NEW)** — the 2D illustration (raster + vectors + ephemera) drawn ON the artboard plane in illustration × free3D, so you arrange 3D objects against your art; plus a **transparent PNG export**. Default on; `sm.setArtboardTextured3D(on)`. **See `docs/ui/textured-artboard.md`.** (Supersedes the old "no textured version" note.)
- **Play mode** — full walkaround: collision + mouse-look + 1st/3rd person + avatar + walk/idle animation + trigger volumes + interaction verb (§5, `docs/ui/play-mode.md`).
- **WASD-fly editor camera** — opt-in, free3D only (§4).

⚠️ **Important:** the camera/render/input *feel* is **browser-gated** — the **UI contract** (events + rules + setters) is stable, wire against it, but expect small behavioral tweaks. The one host action still needed: **auto-activate the "3D Scene" layer on entering a 3D view** so the 3D render isn't dormant (see `play-mode.md`).

🚧 **Genuinely later:** real rigid-body physics; capsule collision; third-person camera-vs-wall pull-in; `.frogcart` export + standalone Player; relaxed far-clamp for very large worlds. (Play mouse-look, collision, and scene-snapshot are now **done**.)

---

## 8. Minimal wiring checklist

1. Subscribe `sm.onViewStateChanged3D` → `applyViewUI(sm.getViewRules3D())`; also call it once on load.
2. Camera-mode 3-way toggle → `sm.setCameraMode3D(...)`.
3. Target switch → `sm.setTarget3D(...)` (+ the "data is kept" note).
4. `applyViewUI`: hide the **2D editing tools** (brush/vector-draw) when `!twoDToolsActive`; keep the 3D panels always; **keep the Layers panel keyed to `target`, not camera mode** (§3a — full list in illustration incl. free3D; drop raster in scene); set the projection indicator; gate Export mode + the Play slot off `outputIsArtboard`.
5. Artboard-frame checkbox (illustration × free3D) → `sm.setArtboardFrameVisible3D(...)`.
6. **▶ Play** button for `target: scene` → `sm.enterPlayMode3D()` / `exitPlayMode3D()`; toggle its ▶/⏹ state off `sm.onPlayStateChanged3D`.
7. **🛩 Fly** toggle in free3D → `sm.setFlyEnabled3D(...)`.

---

## 9. Package exports (for your TypeScript)

From `@zaings/salsa`: `deriveViewRules`, `viewModeLabel`, `normalizeViewState`, `DEFAULT_VIEW_STATE` and types `ViewState`, `ViewRules`, `ViewTarget`, `CameraMode`. Also the runtime classes if you ever want them directly: `GameLoop`, `CharacterController`, `KeyboardInput`, `FlyController` (+ `CharacterInput`, `CharacterConfig` types). Normally you just call the `sm.*3D` methods above and never touch these.
