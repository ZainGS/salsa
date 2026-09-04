# Play Mode — walk the scene (character controller) — spec + to-do

**Date:** 2026-09-01 · **Status:** engine v1 building · **Parent:** `free-camera-and-scene-targets.md` (L3 = Play mode) · **Home:** `src/game/`

## One line

Press **▶ Play** on a *scene*-target document and a character controller takes over the camera: WASD to move, mouse to look, Space to jump, walking on the real scene geometry. **▶ Stop** restores the exact edit view — Play is fully non-destructive (Unity model: snapshot on enter, restore on exit).

## What already existed (before this pass)

The Play runtime is real and unit-tested — this was never "spec only":

- `src/game/game-loop.ts` — `GameLoop`, fixed-timestep accumulator ("fix your timestep"), spiral-of-death guard, injectable clock for headless tests.
- `src/game/character-controller.ts` — `CharacterController`, kinematic yaw-relative WASD + gravity + jump.
- `src/game/keyboard-input.ts` — `KeyboardInput`, WASD/arrows/Q-E/Space → `CharacterInput`.
- `src/game/fly-controller.ts` — `FlyController`, the *editor* WASD fly-cam (distinct from Play).
- `Scene3DManager.enterPlayMode3D()/exitPlayMode3D()/isPlaying3D/setPlayInput3D/onPlayStateChanged`, surfaced on `ShapeManager` (`sm.enterPlayMode3D` …). Snapshotted + restored the **camera**.

The gap was: flat-plane collision only, yaw-only look, first-person only, camera-only snapshot, and **no UI to press Play**.

## Gap items & status

| # | Item | Effort | Status |
|---|------|--------|--------|
| 1 | ▶ Play button in Frogmarks | S (host) | **Engine ready** — hook exists; host wires it (`docs/ui/play-mode.md`). |
| 2 | Ground collision vs real geometry | M | ✅ **Built** — injected down-ray ground sampler. |
| 3 | Mouse-look (pitch) + pointer-lock | S–M | ✅ **Built** — `MouseLook` (pointer-lock) + controller `pitch`. |
| 4 | Horizontal / wall collision | L | ✅ **v1 built** — ray-stop **+ wall-slide + step-up** (curbs/stairs). No capsule / step-clearance beyond the ground clamp. |
| 5 | Third-person camera option | M | ✅ **Built** — `cameraMode: 'first' \| 'third'`. |
| 6 | Full scene-graph snapshot/restore | M | ✅ **Built** — TRS snapshot on enter, restore on exit. |
| + | **Player avatar** binding (assign a mesh, camera follows) | M | ✅ **Built** — `setPlayerObject3D(meshId)` / `enterPlayMode3D({ playerMeshId })`. |

## Engine design (what this pass added)

All collision is **injected into the pure controller as callbacks**, so `CharacterController` stays deterministic + unit-testable and the raycast machinery lives in the manager:

- `controller.groundSampler = (x,z) => number|null` — world ground height under the character (null = fall to the flat fallback `cfg.groundY`).
- `controller.moveResolver = (fx,fz,tx,tz,r) => [x,z]` — resolved horizontal move for a body of radius `r` (a wall cancels the into-wall component).

`Scene3DManager._resolveWallMove` backs those with `MeshPicker`, casting only against the **broadphase candidate set** (the meshes near the character — see Performance notes), never the whole scene:
- **Ground:** `MeshPicker.sampleGroundHeight(x,z,meshes)` — a ray straight down from far above, closest hit's `y`.
- **Step-up:** if the destination ground rises ≤ `cfg.stepHeight` above the feet (`isClimbableStep`), it's a curb/stair — allow the move and let the ground clamp lift the feet. Otherwise:
- **Walls + slide:** cast `MeshPicker.raycastWorld` horizontally from mid-body along the move; if a wall is within `dist + radius`, `slideAlongWall` (pure, in `src/game/collision-math.ts`) advances up to the wall then spends the rest sliding along the wall tangent. A second cast along the slide prevents tunnelling a perpendicular wall (corner). No wall-slide across *stacked* corners yet.

**Mouse-look:** `src/game/mouse-look.ts` `MouseLook` grabs pointer-lock on canvas click and accumulates `movementX/Y` → per-tick yaw/pitch radian deltas, consumed each fixed step and merged into the controller input as `lookYaw`/`lookPitch`. The controller applies keyboard rate-turn (`look`) *and* direct deltas (`lookYaw`/`lookPitch`) so keyboard-turn (Q/E) and mouse-look coexist. Pitch is clamped to `cfg.pitchMin/pitchMax` (~±80°).

**Third-person:** `cfg.cameraMode='third'` pulls the camera back `thirdPersonDistance` behind the head along the look direction and looks at the raised head pivot (`thirdPersonHeight`); pitch orbits it vertically. First-person uses `cameraEye()`/`cameraTarget()` directly (rigid to the head). Third-person goes through `Scene3DManager._thirdPersonCamera`, which adds two feel layers:
- **Follow smoothing** — the eye *trails* the desired position via frame-rate-independent `expSmooth` at `cfg.cameraFollowRate` (higher = snappier; ≤0 = instant). The look target (pivot) tracks tightly (no lag). First frame after enter snaps.
- **Camera-vs-wall collision** — a ray from the pivot toward the (smoothed) eye; if a wall is nearer than the eye, `clampCameraDistance` pulls the eye in to `hitDist − cameraCollisionPadding` (never closer than `cameraMinDistance`, so it can't clip into the avatar). Pull-in is instant (applied each frame); ease-out is smoothed. Toggle with `cfg.cameraCollision`.

**Player avatar:** `setPlayerObject3D(meshId)` (or `enterPlayMode3D({ playerMeshId })`) binds a scene mesh; `_drivePlayerMesh` writes its position + yaw from the controller each tick (via `setPosition3D`/`setRotation3D` — the TRS source of truth, keeping authored scale + pitch/roll). First-person hides it (you're inside it); third-person shows it and the camera follows via `cameraEye()`/`cameraTarget()`. Spawn defaults to the avatar's position. v1 assumes origin ≈ feet and rest-facing +Z.

**Non-destructive snapshot:** `enterPlayMode3D` captures every mesh's **TRS** (position/rotation/scale — the source of truth, since `localMatrix` is derived and the Player mesh moves via TRS); `exitPlayMode3D` restores it (plus the camera + the avatar's visibility). Camera-only Play with no avatar never mutates transforms, so restore is a safe no-op there — it's the guarantee that holds once the avatar (or later physics/scripts) moves objects.

### `enterPlayMode3D` options

```ts
sm.enterPlayMode3D({
  start?:    [x,y,z],                    // spawn (default: under the current camera)
  config?:   Partial<CharacterConfig>,   // moveSpeed, cameraMode:'first'|'third', eyeHeight, radius, …
  keyboard?: boolean,   // default true  — built-in WASD/Q-E/Space
  mouseLook?: boolean,  // default true  — built-in pointer-lock look (click canvas to capture)
  collision?: boolean,  // default true  — walk real geometry + wall-block; false = flat fallback plane
  playerMeshId?: string,// bind a Player avatar for this run (else use setPlayerObject3D)
});
```

## Frogmarks host contract (gap #1 — the only host work)

1. Show **▶ Play / ⏹ Stop** on the *scene* target (`getViewState3D().target === 'scene'`). Toggle it off `sm.onPlayStateChanged3D`.
2. Play → `sm.enterPlayMode3D()`; Stop → `sm.exitPlayMode3D()`. Built-in keyboard + mouse-look mean **zero per-key wiring** — the canvas just needs focus, and the player clicks it once to capture the pointer.
3. **Esc** releases pointer-lock (browser default); keep a visible Stop button since Esc won't exit Play.
4. Custom input instead of the built-ins: pass `{ keyboard:false, mouseLook:false }` and feed `sm.setPlayInput3D({ forward, right, jump, lookYaw, lookPitch })` each frame (gamepad / on-screen pad).
5. Third-person toggle → `enterPlayMode3D({ config: { cameraMode: 'third' } })`.

## Performance notes (browser-gated)

- **Broadphase (built):** an XZ spatial grid (`src/game/spatial-grid.ts` `SpatialGridXZ`) is built over the static mesh set on Play-enter; ground/wall casts query only the meshes near the character, so cost is O(nearby), not O(city). Oversized AABBs (a city-spanning ground plane) go in an always-tested list so they don't flood cells. BVHs still build lazily per mesh on first contact — but only for meshes the character actually approaches, so the first-tick hitch is bounded to the spawn neighbourhood.
- The grid indexes the scene as **static** at enter — moving city traffic isn't re-indexed during Play (a v1 limitation; the mover meshes are usually small/irrelevant to walking). Grid build is one pass over meshes' `obbCorners` on enter.
- Two casts per fixed step (ground + wall), each over the small candidate set. Fine at one character; revisit for crowds.

## Remaining / future

- **Capsule** collision (currently a point + radius; only the ground clamp + `stepHeight` handle vertical — no head clearance, no true step *geometry*, low ceilings ignored).
- **Dynamic broadphase** — re-index moving meshes (traffic) during Play if they turn out to matter for collision; today the grid is a static enter-time snapshot.
- **Real physics** (rigid bodies, dynamic props) — spec P4 / a from-scratch or library add; out of scope here.
- **Component/script snapshot** — extend the TRS snapshot once Play can mutate more than transforms.
- **Player avatar polish** — re-origin/re-face helper so any authored mesh can be a Player without the origin≈feet / faces-+Z assumption.
- ✅ **Avatar walk/idle animation hooks (BUILT 2026-09-02):** `CharacterController.locomotion()` reports {planarSpeed, moving, grounded, airborne, rising} (planarSpeed = actual post-collision planar distance/dt, so a wall drops it to idle); `game/locomotion.ts` `pickLocomotionClip(state, clips, cfg)` maps it to a clip name (idle/walk/run/jump/fall, graceful fallback for missing optional clips) and `LocomotionClipDriver` emits a name only on transitions. Play loop calls `sm.setPlayerAnimation3D(clips, handler)`'s handler with the clip name each transition — the HOST plays it on the avatar rig. Pure core fully unit-tested; actual clip playback is browser-gated (host-wired to the skeleton clip system).
- Verify in-browser: ground-follow on terrain/streets, mouse-look feel + sensitivity, third-person framing + follow distance, wall-slide + step-up on curbs/stairs, Player avatar tracks + Stop restores everything. (All appearance/feel items are browser-gated — unit tests cover the math only.)
