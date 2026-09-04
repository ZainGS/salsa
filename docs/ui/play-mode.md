# Play Mode — Frogmarks host integration

How to add the **▶ Play / ⏹ Stop** control and (optionally) a Player avatar. Engine spec: `docs/specs/play-mode.md`. All APIs are on `ShapeManager` (`sm`).

## Minimum: a Play button

Show it on *scene*-target documents; toggle its state off the engine event.

```ts
// visibility: scene target only
const isScene = sm.getViewState3D().target === 'scene';

// button click
function togglePlay() {
  if (sm.isPlaying3D) sm.exitPlayMode3D();
  else                sm.enterPlayMode3D();   // built-in WASD + mouse-look, walks real geometry
}

// keep the button label/state in sync (enter/exit can also happen internally)
const sub = sm.onPlayStateChanged3D.subscribe(() => {
  ngZone.run(() => { this.playing = sm.isPlaying3D; this.cdr.markForCheck(); });
});
// unsubscribe on destroy
```

That's the whole requirement. On enter, the engine attaches its own keyboard and pointer-lock mouse-look:

- **Move:** WASD / arrows · **Turn:** Q/E (or mouse) · **Look:** mouse (click the canvas once to capture) · **Jump:** Space.
- The player must **click the canvas** to grab pointer-lock (browser requires a user gesture). **Esc** releases the lock but does *not* exit Play — so always keep the ⏹ Stop button visible.
- Give the canvas focus when entering Play so keys register.

## Options

```ts
sm.enterPlayMode3D({
  start?:       [x, y, z],                 // spawn; default = the Player avatar, else under the camera
  config?:      { moveSpeed, jumpSpeed, eyeHeight, radius, stepHeight,
                  cameraMode: 'first' | 'third', thirdPersonDistance, thirdPersonHeight,
                  cameraCollision, cameraCollisionPadding, cameraMinDistance, cameraFollowRate, ... },
  keyboard?:    boolean,   // default true  — built-in WASD; false → feed setPlayInput3D yourself
  mouseLook?:   boolean,   // default true  — built-in pointer-lock look; false → feed lookYaw/lookPitch
  collision?:   boolean,   // default true  — walk real geometry + walls/steps; false → flat ground plane
  playerMeshId?: string,   // bind a Player avatar for this run (see below)
});
```

## First-person vs third-person

One toggle — `config.cameraMode`:

- `'first'` (default): camera sits at the character's eyes. If a Player avatar is bound it's **hidden** while playing (you're inside it).
- `'third'`: camera pulls back **behind and above** the character and looks at it. Follow framing = `thirdPersonDistance` (how far back) and `thirdPersonHeight` (pivot lift). Mouse-look orbits the camera around the character. The camera **trails smoothly** (`cameraFollowRate`, higher = snappier) and **pulls in when a wall is behind the character** so it never clips through geometry (`cameraCollision` on by default; `cameraCollisionPadding` / `cameraMinDistance` tune the gap). Expose these as sliders for a "camera feel" panel if you want.

```ts
sm.enterPlayMode3D({ config: { cameraMode: 'third', thirdPersonDistance: 5, thirdPersonHeight: 0.5 } });
```

There is no separate "avatar object" required for first-person — the controller is an invisible capsule driving the camera. Third-person works without an avatar too (the camera just follows an invisible point), but you'll usually want to bind a visible mesh:

## Player avatar (assign an object, camera follows it)

Bind any scene mesh as the Player. The controller then **moves that mesh** each frame (position + yaw), and — in third-person — the camera follows it. Set it once; it persists across enter/exit.

```ts
sm.setPlayerObject3D(selectedMeshId);   // e.g. the currently-selected mesh; null to clear
// then:
sm.enterPlayMode3D({ config: { cameraMode: 'third' } });   // spawns at the avatar, follows it
```

- **Spawn:** with an avatar bound and no explicit `start`, the character spawns at the avatar's current position.
- **Follow settings** are the `thirdPersonDistance` / `thirdPersonHeight` config values — expose them as sliders if you want live tuning (pass a new `config` on the next `enterPlayMode3D`).
- **Assumptions (v1):** the avatar's origin should be ≈ at its feet and it should face **+Z** at rest — the controller overrides position + yaw but keeps the mesh's authored scale and pitch/roll. A sideways-facing or offset-origin avatar will look wrong until re-authored.
- **Non-destructive:** the avatar's transform (and every other mesh's) is snapshotted on enter and restored on ⏹ Stop.

`sm.playerObjectId3D` returns the current binding (or null).

## Avatar animation (walk / idle / run / jump / fall)

Make the avatar animate as it moves. Give it clip names + a handler that plays a clip on the rig; the Play loop picks the right clip from the character's motion and calls the handler on each transition (idle↔walk↔run↔jump↔fall):

```ts
sm.setPlayerAnimation3D(
  { idle: 'Idle', walk: 'Walk', run: 'Run', jump: 'Jump', fall: 'Fall' },  // names of clips on the avatar
  (clipName) => playClipOnAvatarRig(clipName),                              // you play it (skeleton clip system)
);
```

- Only `idle` + `walk` are required; missing optional clips degrade gracefully (no `run` → `walk`, etc.).
- The handler fires **only on transitions**, not every frame. Walking into a wall correctly reads as idle (speed drops to ~0).
- Pass `(null, null)` to disable.

## Custom input (gamepad / on-screen pad)

Opt out of the built-ins and feed intent each frame:

```ts
sm.enterPlayMode3D({ keyboard: false, mouseLook: false });
// per animation frame:
sm.setPlayInput3D({
  forward,   // -1..1
  right,     // -1..1
  jump,      // edge-triggered boolean
  lookYaw,   // radians this frame (mouse/stick horizontal)
  lookPitch, // radians this frame (mouse/stick vertical)
});
```

## Trigger volumes → gameplay (walk into a zone → something happens)

Define scene zones that fire as the player walks through them. They **auto-dispatch into the active UI state machine**, so a creator gets game logic with no host glue:

```ts
sm.setTriggerVolumes3D([
  { id: 'door1',  shape: { kind: 'box',    min: [2,0,2], max: [4,3,4] } },
  { id: 'pickup', shape: { kind: 'sphere', center: [10,0,5], radius: 1 }, once: true },
]);
```

Then in the UI state machine, transitions can trigger on `{ type: 'enterVolume', volumeId: 'door1' }` / `{ type: 'exitVolume', … }` with any action (`goToState`, `setVariable`, `playAnimation`, `setCamera`, `emitEvent`, …). Walking into `door1` fires it automatically while playing.

- **Raw hook (optional):** `sm.setTriggerHandler3D((e) => …)` runs *in addition* to the UI dispatch — for custom game logic outside the state machine. `e = { type: 'enter'|'exit', id }`.
- Volumes are tested against the player's **feet**; `once` volumes fire `enter` a single time.

### Interaction ("use") verb

Register things the player can *use*, and drive an `interact` transition on the UI state machine:

```ts
sm.setInteractables3D([
  { id: 'chest', position: [8,0,3], range: 2.5 },
  { id: 'sign',  position: [1,0,9], range: 2 },
]);
```

- The built-in **F key** fires the **nearest in-range** interactable (or bind your own key → `sm.playerInteract3D()`).
- **Prompt:** `sm.nearestInteractable3D()` returns the id the player could use right now (or null) — poll it each frame to show "Press F to open".
- On use, an `{ type: 'interact', targetId: 'chest' }` transition fires in the UI state machine. Optional raw hook: `sm.setInteractHandler3D((id) => …)`.
- Also: `sm.triggersContainingPlayer3D()` lists trigger-volume ids the player stands in, if you want volume-based interact instead.

## Perf note

Collision raycasts against the whole scene, so mesh BVHs build lazily on the **first Play tick** — expect a one-time hitch entering Play on a large city. If it's disruptive, enter with `{ collision: false }` for a flat-ground demo, or wait for the broadphase (tracked in the spec).
