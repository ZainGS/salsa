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

- **Move:** WASD / arrows (camera-relative; Play starts WALKING) · **Run:** Shift (toggle) · **Sneak:** Ctrl (hold) or C (toggle) · **Look / orbit:** mouse (click the canvas once to capture) or Q/E · **Jump:** Space (hold = higher) · **Use:** F.
- **Gamepad** (built in): left stick move · right stick orbit · A jump · X use · L3 / Y walk-run toggle · B sneak toggle.
- **While playing, no editor shortcut or editor pointer action runs** (Round 8, see *Play suspends the editor* below).
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
  gamepad?:     boolean,   // default true  — built-in gamepad (R6.2); false → ignore pads
  collision?:   boolean,   // default true  — walk real geometry + walls/steps; false → flat ground plane
  playerMeshId?: string,   // bind a Player avatar for this run (see below)
});
```

## First-person vs third-person

One toggle — `config.cameraMode`:

- `'first'` (default): camera sits at the character's eyes. If a Player avatar is bound it's **hidden** while playing (you're inside it).
- `'third'`: a released-game style follow camera (R6.2, 2026-09-30). See **Third-person controls + camera (R6.2)** below.

```ts
sm.enterPlayMode3D({ config: { cameraMode: 'third', thirdPersonDistance: 5, thirdPersonHeight: 0.5 } });
```

### Third-person controls + camera (R6.2, 2026-09-30)

**Movement is camera-relative, and the body turns toward where it moves.** W runs away from the camera, S runs toward
it, and A/D run screen-left/right. The character turns smoothly to face its direction of travel (`faceTurnRate` 14/s,
capped at `maxTurnSpeed` 12 rad/s). The **mouse / right stick / Q-E only orbit the camera**: standing still and
orbiting leaves the character alone. Holding W while orbiting runs in circles. Speed eases in and out
(`acceleration` 9/s, `deceleration` 11/s) so starts and stops don't snap. First-person is unchanged: the body faces
where you look, and it uses the same mouse-look.

**Gaits (Round 8): walk by default, Shift TOGGLES a true run, Ctrl HOLDS a sneak.**
- **Walk** (the default): a brisk 1.6 m/s (`walkSpeed`, the *Walk speed* setting).
- **Run**: Shift (a press, not a hold) toggles it. 5.2 m/s (`moveSpeed`, the *Move speed* setting, which is now the
  run speed). The state carries over to the next Play run.
- **Sneak**: hold Ctrl, or press C (gamepad B) to toggle. 1.0 m/s (`sneakSpeed`), crouched. Sneak wins over run;
  letting go returns to whichever of walk / run was active. Resets every Play run.
- An analog stick scales the active gait.
- **Ctrl + W caveat:** outside fullscreen, Chrome reserves **Ctrl+W** (close tab) and never gives it to the page, so
  holding Ctrl and then pressing W can close the tab. Ctrl + A / S / D and the arrows are fine (the engine suppresses
  their browser action). The engine requests the Keyboard Lock API on Play enter, which lets a FULLSCREEN page receive
  Ctrl+W. Windowed, prefer **C** (toggle) to sneak forward, or hold W before pressing Ctrl. Host option: a fullscreen
  Play button.

**Responsiveness (Round 8).** The planar velocity is a vector that approaches the input target with max(an exponential
step, a linear floor): full walk speed in about 0.05 s, full run in about 0.17 s, a stop from a run in about 0.15 s, and
a reversal decelerates through zero instead of snapping round. The body turns at up to 15 rad/s (half that in the air).
In the air the stick only steers (35 % of the ground acceleration) and releasing it keeps the momentum. On the engine's
own humanoid rigs the body also LEANS into acceleration and into turns, and the head leads a turn.

**Jump (Round 8).** Space / A. Responsive and game-like:
- **Height:** about 1.05 m holding the button, about 0.45 m on a tap (variable height: releasing early while rising cuts
  the jump). About 0.65 s in the air. `variableJumpHeight: false` makes every jump full height.
- **Snappy arc:** 20 m/s² rising, 1.6 × that past the apex, a short hang near the apex while held (0.55 ×), falls capped
  at 30 m/s.
- **Coyote time** (0.1 s): a jump just after walking off a ledge still works. **Jump buffer** (0.12 s): a press just
  before landing jumps on touch-down. Holding the button never bunny-hops.
- All lengths and speeds are metres and convert to city units, like the rest of Play.
- **Host input note:** `setPlayInput3D({ jump })` is now read as a HELD button: a press edge starts the jump, a release
  shortens it. Keep `jump: true` while the button is down; a one-frame pulse gives the short hop.

**Gamepad (built in, `gamepad: false` to opt out).** Standard mapping:

| Control | Action |
|---|---|
| Left stick | Move (analog speed) |
| Right stick | Orbit (3.2 rad/s yaw, 2 rad/s pitch at full tilt) |
| A | Jump (hold = higher) |
| X | Use |
| L3 (stick click) or Y | Walk/run toggle |
| B | Sneak toggle (Round 8) |

Both sticks use a radial dead zone, and the look stick has a response curve.

**Camera** (`ThirdPersonCamera`, `src/game/third-person-camera.ts`):
- **FOV:** 72° (`thirdPersonFovDeg`). First-person keeps the editor camera's FOV unless you set `firstPersonFovDeg`.
  The pre-play FOV is restored on Stop.
- **Pivot and distance:** a shoulder-height pivot (0.8 × the avatar height). The follow distance is 2.6 × the avatar
  height (about 4.4 m for 1.7 m), or 4.5 m with no avatar. The initial pitch is about 17° down, and the camera and
  body start along the avatar's authored facing, or along the edit camera's view.
- **Orbit and follow:** the orbit is crisp (mouse 1:1). The pivot follows with frame-rate-independent damping:
  horizontal `cameraFollowRate` 12/s and vertical `cameraVerticalFollowRate` 8/s (Round 8; they were 10 / 5, which felt
  floaty). During a jump the camera follows only 35 % of the rise above the take-off height, so the view doesn't bob
  with every hop, but it follows a drop below the take-off height fully. The lag is leashed to 35 % of the distance.
  The view leads the direction of travel by `cameraLookAhead` (0.22 s of velocity).
- **Collision:** a sphere cast (a 5-ray bundle of `cameraCollisionRadius` 0.2 m). A wall pulls the camera in at once;
  when it clears, the camera eases back out at `cameraRecoverRate` 4/s, with no pop. A thin prop that only one edge ray
  grazes (a signal housing, a lamp post) is ignored, as in released games.
- **The Player is never its own obstacle (2026-10-01).** Every part of the bound Player is left out of the camera,
  ground and wall rays: the body, its hair, garments, face decal and charms, any mesh skinned to its skeleton, and any
  mesh parented under the body or the skeleton. Before, only the auto default player's parts were excluded; a
  user-set Player excluded just its body, so from the shoulder pivot (inside the torso) the camera ray hit the back of
  its own top or hair and the camera was parked at the min distance, inside the head. Rebinding the Player mid-Play
  rebuilds the collision broadphase.
- **Sized to the avatar (2026-10-01).** With an avatar bound, `cameraMinDistance`, `cameraCollisionRadius` and
  `cameraCollisionPadding` scale with its measured height: the metre defaults × H / 1.7 m (`avatarCameraFraming` in
  `third-person-camera.ts`). A 1.7 m avatar gets exactly 0.5 / 0.2 / 0.25 m. A 25 m giant (a character generated
  before the city fix) gets 7.4 / 2.9 / 3.7 m, so a wall pull-in stops outside its body instead of 3 cm behind the
  pivot, and a small doll gets a proportionally small rig. Explicit `enterPlayMode3D({ config })` values still win.
  The min distance also floors a short "camera distance" setting, so the camera never ends up inside the avatar.
- **Pitch limits:** third-person pitch is clamped to `thirdPersonPitchMin/Max` (−1.25 … 0.6 rad).
- **Frame pacing:** the character and camera are drawn **interpolated between the 60 Hz sim steps**, and mouse /
  right-stick look is applied per rendered frame, so there is no stutter at 144 Hz or when the frame rate drops.

**Settings APIs (persisted with the document, live while playing):**

> **★ Host UI needed (Frogmarks Play settings panel, under Move speed):**
> - **"Camera distance"** slider (m) → `sm.setPlayCameraDistance3D(m)`; read `sm.getPlayCameraDistance3D()` (`null` =
>   auto). Suggested range 1.5–12 m, "Auto" passes `null`.
> - **"Field of view"** slider (°) → `sm.setPlayCameraFov3D(deg)`; read `sm.getPlayCameraFov3D()` (72 default; range
>   30–110). "Reset" passes `null`.
> - **Walk/Run HUD badge** (optional): `sm.getPlayerRunning3D()`; subscribe to `sm.onPlayerRunChanged3D` (emits the new
>   boolean). `sm.setPlayerRunning3D(bool)` forces it (e.g. an on-screen button).
> - **Round 8:** relabel the Move speed slider **"Run speed (m/s)"** (`setPlayerMoveSpeed3D`, default 5.2, suggested
>   range 2–12) and add **"Walk speed (m/s)"** → `sm.setPlayerWalkSpeed3D(v)` / `getPlayerWalkSpeed3D()` (default 1.6,
>   suggested range 0.5–3; "Reset" passes `null`). Optional **Sneak badge**: `sm.getPlayerSneaking3D()` +
>   `sm.onPlayerSneakChanged3D`. `sm.getPlayerGait3D()` returns `'walk' | 'run' | 'sneak'` (null when not playing).

| API | Meaning |
| --- | --- |
| `sm.setPlayCameraDistance3D(m: number \| null)` / `getPlayCameraDistance3D()` | Third-person follow distance in **metres** (converted with the city's metres-per-unit). `null` = automatic. Clamped 0.5–50. Stored as `play.cameraDistance` only when set. |
| `sm.setPlayCameraFov3D(deg: number \| null)` / `getPlayCameraFov3D()` | Third-person FOV in degrees. `null` / 72 = default (nothing stored). Clamped 30–110. Stored as `play.fovDeg`. |
| `sm.getPlayerRunning3D()` / `setPlayerRunning3D(on)` / `onPlayerRunChanged3D` | Walk/run state (true = run; Round 8: Play starts walking). Shift / L3 / Y toggle it while playing. |
| `sm.getPlayerSneaking3D()` / `setPlayerSneaking3D(on)` / `onPlayerSneakChanged3D` | Round 8 sneak. Ctrl holds it; C / B / `setPlayerSneaking3D` toggle it. Only while playing; resets every run. |
| `sm.getPlayerGait3D()` | `'walk' \| 'run' \| 'sneak'` while playing, else null. |
| `sm.getPlayCameraState3D()` | While playing: `{ mode, distance, targetDistance, fovDeg, yaw, pitch, facing }` (distance is the live, collision-limited one). |
| `sm.getPlayerAnimationState3D()` | While the engine drives the avatar: `{ state: 'idle'\|'move'\|'jump'\|'fall', weights, runMix, crouchMix, landWeight, speed, gait, lean: { pitch, roll, headYaw } }`. Since Round 8 `speed` is in world units/s. |

New `config` fields (all world units / radians unless noted; defaults are metres, converted in a city).
Round 8 added `walkSpeed` (1.6), `sneakSpeed` (1.0), `groundAccel` (20 m/s²), `groundDecel` (24 m/s²), `airControl`
(0.35), `fallGravityMultiplier` (1.6), `jumpCutGravityMultiplier` (2.6), `apexGravityMultiplier` (0.55),
`apexHangSpeed` (1.2 m/s), `maxFallSpeed` (30 m/s), `coyoteTime` (0.1 s), `jumpBufferTime` (0.12 s) and
`variableJumpHeight` (true). It changed these defaults: `moveSpeed` 3.5 → 5.2 (the run), `jumpSpeed` 4.5 → 6.5, `gravity`
12 → 20, `acceleration` / `deceleration` 9 / 11 → 10 / 12, `faceTurnRate` / `maxTurnSpeed` 14 / 12 → 16 / 15.
`walkSpeedFactor` is now legacy: 0 (the default) uses `walkSpeed`; > 0 walks at `moveSpeed` × it, the R6.2 behaviour.
R6.2 added `acceleration`, `deceleration`, `faceTurnRate`, `maxTurnSpeed`, `thirdPersonFovDeg`,
`firstPersonFovDeg`, `cameraCollisionRadius`, `cameraVerticalFollowRate`, `cameraLookAhead`, `cameraRecoverRate`,
`thirdPersonPitchMin`, `thirdPersonPitchMax`. The `thirdPersonDistance` default is now 4.5 m, and `thirdPersonHeight`
is −0.2 m (a shoulder pivot).

**Custom input note:** `setPlayInput3D({ lookYaw, lookPitch })` deltas are now consumed **once** per rendered frame
(before, they were re-applied every sim tick until overwritten). They also work alongside the built-in keyboard. Send
per-frame deltas, as documented.

There is no separate "avatar object" required for first-person — the controller is an invisible capsule driving the camera (its height = the **Player height** setting, below). Third-person without an avatar spawns the **auto default character** (below; opt-out-able), but you'll usually want to bind your own visible mesh:

## Play settings — Player height + auto default character (polish-round-3 T5, 2026-09-29)

Three document-level Play settings, **persisted with the document** (global scene settings, key `play`; only written when
non-default, so older saves load unchanged). All apply **live** while playing.

> **★ Host UI needed (Frogmarks Play settings panel):**
> - **"Player height"** slider → `sm.setPlayerEyeHeight3D(value, metresPerUnit?)`; read back with
>   `sm.getPlayerEyeHeight3D(metresPerUnit?)` (`null` = automatic). Initial slider value when automatic:
>   `sm.getDefaultPlayerEyeHeight3D()`. A "Reset" / "Auto" button passes `null`.
> - **"Move speed"** slider (Round 4, under Player height), labelled **m/s** → `sm.setPlayerMoveSpeed3D(v)`; read with
>   `sm.getPlayerMoveSpeed3D()` (always a number; 5.2 = default since Round 8). **Round 8: this is the RUN speed** (Shift),
>   so relabel it "Run speed", and add "Walk speed" → `sm.setPlayerWalkSpeed3D(v)` (1.6 default). Suggested range
>   0.5–12, step 0.1. "Reset" passes `null`.
>   No `metresPerUnit` argument: the value is metres/second everywhere and the engine converts it for a city itself.
> - **"Auto default character"** checkbox → `sm.setAutoDefaultPlayer3D(on)`; read with `sm.getAutoDefaultPlayer3D()`.

| API | Meaning |
| --- | --- |
| `sm.setPlayerEyeHeight3D(h: number \| null, metresPerUnit?: number)` | First-person **eye height** above the feet. `null` (or ≤ 0 / NaN) = automatic. Clamped to 0.01–10000 units. |
| `sm.getPlayerEyeHeight3D(metresPerUnit?): number \| null` | The set height (units, or metres when `metresPerUnit` is given), or `null` = automatic. |
| `sm.getDefaultPlayerEyeHeight3D(): number` | What "automatic" resolves to (world units): **1.6 m** (1.6 units, or 1.6 / `cityMetresPerUnit()` in a city), or 0.9 × the bound Player avatar's height while playing with one. |
| `sm.setPlayerMoveSpeed3D(mps: number \| null)` | Full-input **RUN speed in metres/second** (Round 8; Shift toggles the run). `null` / ≤ 0 / NaN / exactly 5.2 = default (nothing stored). Clamped 0.1–100. Stored as `play.moveSpeed` (m/s). **Backward compatible:** an older save's value always meant "full-input run speed" and loads as the run speed. |
| `sm.getPlayerMoveSpeed3D(): number` | The effective run speed in m/s (5.2 when unset). |
| `sm.setPlayerWalkSpeed3D(mps: number \| null)` / `getPlayerWalkSpeed3D()` | Round 8: full-input **WALK speed** (the default gait), m/s. `null` / exactly 1.6 = default (nothing stored). Stored as `play.walkSpeed`. Never above the run speed. |
| `sm.setAutoDefaultPlayer3D(on: boolean)` / `sm.getAutoDefaultPlayer3D()` | Third-person Play with no Player set spawns a default animated character. **Default on.** |
| `sm.autoPlayerId3D: string \| null` | The auto character's mesh id while it's in the scene (third-person Play), else null. |

**Units.** The Play controller works in **world units**; Creator/character content is 1 unit ≈ 1 metre, so for a normal
scene just pass metres as units (default 1.6). A **city** is built at `sm.cityMetresPerUnit()` metres per unit (the
city-gen convention `X*s` = 15·X metres), so a slider labelled in metres should pass that as `metresPerUnit`:
`sm.setPlayerEyeHeight3D(1.7, sm.cityMetresPerUnit())` stores 1.7 / mpu units, and `sm.getPlayerEyeHeight3D(sm.cityMetresPerUnit())`
reads metres back. The stored value is always units (so it survives a change of how the host labels it).

**Scale-correct in a city (Round 4, 2026-09-30).** While a city exists, Play converts every controller default from
metres to city units with `cityMetresPerUnit()` (ShapeManager installs the provider; `scene3d.getPlayMetresPerUnit3D()`
reads it, 1 elsewhere): eye height 1.6 m, move speed (the setting, m/s), jump 4.5 m/s, gravity 12 m/s², body radius
0.35 m, step height 0.4 m, third-person follow distance 4 m / pivot 0.4 m, camera collision padding 0.25 m and min
distance 0.5 m. Before, a city player was a 24 m giant walking at 52 m/s. This applies to a **user-set Player** too (its
camera framing still comes from its measured height; since 2026-10-01 the camera min distance / collision radius /
padding do too, see §Third-person camera). Outside a city every
number is exactly as before. Explicit `enterPlayMode3D({ config })` fields still win (they are taken as world units).

**Walk/run thresholds follow the gait speeds (Round 8).** The ENGINE animator gets real speeds: its walk ⇄ run blend
points are the controller's walk and run speeds, and every gait clip plays at speed / its own ground speed. A
HOST-owned clip handler (`setPlayerAnimation3D` plus the discrete driver, which switches walk/run at 2.2) gets the speed
re-mapped so the walk speed reads 1.5 and the run speed 3.5. A full-input walk then picks the walk clip and the run the
run clip, at any speed setting and scene scale. `setPlayerLocomotionBlend3D({ walkSpeed, runSpeed })` values are m/s.
The published `player.speed` UI variable is unchanged (raw world units/s).

**Ground (R6.2 supersedes Round 4 — see below).** The per-tick ground ray now starts just above the feet (at max(step height, ½ eye height), the
wall-ray height) instead of at y = 10 000, so a canopy / awning / cloud overhead is no longer "the floor" (at real scale
the city player spawned on a cloud). With no Player and no explicit start, the spawn stands on the ground under the
camera rather than at y = 0.

**Ground, R6.2 (2026-09-30): no more teleporting onto things overhead.** The Round-4 window (0.8 m above the feet) still
let the player pop 0.8 m onto a bench, and **cascade** up through stacked foliage cards or an awning valance: each
step started the next probe 0.8 m higher. A jump apex also put the probe inside a low canopy, so the player landed on
top of it. Now:
- The ground ray starts at **feet + step height** (0.4 m). A **step up needs headroom**: an upward ray of about the
  body height must be clear, or the surface isn't a floor and the search continues below it
  (`sampleStandableGround`).
- A jump is never pulled *up* onto a surface above where the feet started that tick. Walking stays glued to ground
  that drops by at most the step height (down stairs or slopes, with no "falling" flicker).
- Walls are cast at **knee** (just over the step height), **mid-body** and **head** height
  (`resolveHorizontalMove`). A bench or low wall blocks and slides instead of being climbed. A low beam at head height
  blocks instead of being walked through. Near-horizontal hits (a ramp up to about 45°) are ignored.
- The camera spawn walks down the column from the camera for the first surface with room to stand.
- Tests: `collision-math.test.ts` runs a controller through a box world with an awning and valance, a bridge deck, a
  tree canopy of cards, a jump under a low canopy, a bench, a curb, stairs, a curb under a low beam, and a ramp.
  Browser check: running (without jumping) under city bridge rails, retaining rails, zelkova / camphor canopies and
  border walls never lifts the feet (max rise 0.085 m, which is terrain).

**Precedence.** An explicit `enterPlayMode3D({ config: { eyeHeight } })` wins over the setting; the setting wins over the
automatic value (including the avatar-measured 0.9 × H). In third-person with an avatar the follow pivot stays at
~0.8 × the avatar's height (a shoulder pivot, R6.2) regardless of the eye height.

### Auto default character (third-person, no Player set)

When Play enters **third-person** and **no Player is set** (or the set one no longer exists), the engine spawns a default
character so there is something to follow: since Round 4 a **dressed seeded random character** (the same look as
`sm.randomCharacterParams3D(20260930)`: body shape, skin tone, face with procedural eyes, card hair, top, bottom, socks,
shoes, rim light), **scaled to 1.7 m in a city** (its generated size elsewhere), animated by **Breathe** (idle) / **Walk** / **Run** — the Walk/Run gait clips are generated for the procedural rig
(`default-locomotion.ts`; the pelvis drops so the stance foot stays planted), crossfaded by player speed exactly like a
user locomotion set. It is a **runtime object**:

- **never saved** — EVERY part (body, skeleton, face decal, hair, garments) is `excludeFromDocument` (both node save paths
  + the skeleton save skip them; `getSceneGraphJSONForDocument` drops them by id), and the body is marked **runtime** in
  the character subsystem (`Scene3DCharacter.markRuntimeBody`): its face / hair / clothing / body-param rigs work normally
  but `serializeFaceRigs` / `getFaceTextureExports` / `serializeHairRigs` / `serializeClothingRigs` / `serializeBodyParams`
  / `serializeAttachments` all skip it, and a document load keeps those rigs for the cache. It's only in the scene while
  playing (autosave is paused during Play anyway). Proven by `play-auto-player.test.ts` (a full `DocumentStateCoordinator.gather`
  mid-Play carries none of it, while a user character in the same scene still saves);
- **not in undo, not in the outliner** (`getScene3DHierarchy` filters it), not pickable, never frames the camera;
- **removed on ⏹ Stop**, but **cached**: the next Play re-attaches the same body instantly (the first spawn generates it
  asynchronously, a moment after Play starts — the camera frames it as soon as it's there);
- the user's own binding is untouched: `playerObjectId3D` stays null and the locomotion set isn't written. Scripts'
  `ctx.playerId` does return the auto character while it's live.

If the user sets a Player (`setPlayerObject3D`, even mid-play), theirs is used and the auto character is removed;
clearing the Player mid-play in third-person brings the auto character back. First-person never spawns it (you're the
camera). Opt out with `sm.setAutoDefaultPlayer3D(false)` (persisted).

## Player avatar (assign an object, camera follows it)

Bind any scene mesh as the Player. The controller then **moves that mesh** each frame (position + yaw), and — in third-person — the camera follows it. Set it once; it persists across enter/exit.

```ts
sm.setPlayerObject3D(selectedMeshId);   // e.g. the currently-selected mesh; null to clear
// then:
sm.enterPlayMode3D({ config: { cameraMode: 'third' } });   // spawns at the avatar, follows it
```

> **★ Host UI needed (not yet built in Frogmarks):** there is currently no button for this — add a
> **"Set as Player"** context item on 3D outliner rows (and/or a button in the Character panel),
> wired to `sm.setPlayerObject3D(rowId)`. Show a small 🎮 badge on the bound row
> (`sm.playerObjectId3D` tells you which), and a "Clear Player" action passing `null`. Pairs with
> the ▶ Play button from the top of this doc.

- **Spawn:** with an avatar bound and no explicit `start`, the character spawns at the avatar's current position.
- **Any size (2026-10-01):** the camera frames the avatar from its measured height (pivot 0.8·H, distance 2.6·H, and
  the collision min distance / radius / padding × H / 1.7 m), and none of the avatar's own parts (hair, garments, face
  decal, charms, anything on its skeleton) block the camera or the ground / wall rays. A character generated in a city
  is 1.7 m tall already (see character-creator.md §Random character); an older giant one still plays correctly, just
  as a giant. Scale it down with the gizmo or `sm.fitCharacterToScene3D(bodyId)` (every part follows, feet planted;
  character-creator.md §Scaling a character) for a human-size Player. (The pivot / distance ratios are now 0.76·H /
  1.8·H, visual-polish #7a.)
- **Character size (2026-10-04).** Play measures the avatar's CURRENT size (fresh bounds every Play enter, avatar swap
  and `setCharacterScale3D` call, so a height-param edit or a scale change is never framed at the old size; the first
  Play after a height edit used to read the old box). Everything follows the measured height H:
  - camera: chest pivot 0.76·H, distance 1.8·H, min distance / collision radius / padding / shoulder offset × H / 1.7 m;
  - first-person eye height 0.9·H (`getDefaultPlayerEyeHeight3D` reports the bound Player's current size outside Play too);
  - the collision **capsule**: radius and step height × H / 1.7 m (they stayed at 0.35 m / 0.4 m, so a 2× giant walked
    half into walls and a doll stopped short). A fitted 1.7 m city character gets exactly the defaults. A/B:
    `Scene3DManager.avatarScaledCapsule = false`;
  - the **stride**: walk / run speeds stay in metres per second, and the gait cadence follows the size (the engine
    locomotion's rate clamp widens to the rate that plants the clip at the walk / run speed), so a giant takes slow
    strides and a doll quick ones, with planted feet (a 2× character's foot slide went from ~20 % to ~3 %). A/B:
    `LocomotionAnimator.cfg.scaleRateClamp = false`;
  - the player light, the contact blob (both × eye height), the sim-LOD bands and the fog-horizon exemption (the skinned
    world box) already followed the size.
  - Explicit settings stay explicit: a Play-settings eye height / camera distance in metres, or `config.radius` /
    `stepHeight`, are used as given.
  - Scaling during Play (`setCharacterScale3D`) re-frames at once and the new size survives Stop.
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

> **★ Easier path (2026-09-17): `sm.setPlayerLocomotionSet3D({ idle, walk, run, jump, fall })`** binds the
> five slots to **Animation Library** entries (or clip names/ids on the avatar) and self-wires **crossfading**
> playback — no handler to write. Author a walk once, add it to the library, bind it here, and the avatar
> walks. Persisted with the player binding. See [animation-library.md](animation-library.md) §Phase B. Use
> `setPlayerAnimation3D` only if you want to own playback yourself.

### Engine locomotion state machine (R6.2, 2026-09-30)

When the ENGINE plays the avatar's locomotion, a state machine drives it every tick (`LocomotionAnimator`,
`src/game/locomotion-animator.ts`). The engine plays it for the auto default player, for a `setPlayerLocomotionSet3D`
set, and (new) for a user Player that is a humanoid with neither. The states are **idle · move · jump · fall**, and
`move` is a speed-driven walk ⇄ run blend.
> **Round 8 (supersedes the fade numbers and clip notes below).**
> - A CROUCH mix for the sneak: walk / run fade into the Sneak gait and the idle into the Crouch idle, eased at 8/s so
>   entering and leaving the sneak is a smooth dip.
> - The **Jump** clip is sampled by the controller's AIR PHASE: take-off, a tuck at the apex, then reaching for the
>   ground. A **Fall** loop takes over only after 1 s in the air. A walk off a curb (< 0.12 s airborne, no jump) never
>   flickers into the air pose.
> - An ADDITIVE **Land** squash plays on touch-down, weighted by the impact and lighter while moving, so a landing
>   blends into whatever the ground state is doing.
> - Fades: start 0.15 s, stop 0.24 s, take-off 0.08 s, landing 0.12 s. A move from a stand starts on the first step.
> - Stride matching uses each clip's GROUND SPEED (`SkeletonAnimClip.groundSpeed`, set on the runtime default gaits and
>   scaled by the avatar's size), so a planted foot stays planted at any speed.
> - On the engine's own humanoid rigs, a procedural lean into acceleration and turns plus a head lead is layered on top.
> - `setPlayerLocomotionSet3D` still binds idle / walk / run / jump / fall; `LocomotionClips` also takes `sneak`,
>   `crouch` and `land` (engine animator only).

- **Every change crossfades:** start 0.18 s, stop 0.28 s, take-off 0.12 s, landing 0.16 s. Stopping blends the gait
  into the idle loop. The old path left the legs **frozen in the last stride**: a crossfade held joints the idle clip
  doesn't animate (the legs) at the *from* pose. Now every clip is sampled against the rig's **rest pose**, so those
  joints return to rest.
- **Walk ⇄ run** mix continuously by speed. Shift / analog changes slide the mix, and one shared gait phase keeps the
  feet in step. The gait plays back at speed / nominal speed (stride matching, clamped 0.55–1.6×) so the feet don't
  skate.
- The walk and run blend points default to 1.5 / 3.5 m/s (the walk and run speeds). `setPlayerLocomotionBlend3D({
  walkSpeed, runSpeed })` tunes them. The blend tree is now always continuous; `null` restores the defaults.
- `jump` / `fall` are used when the set provides them. Otherwise airborne keeps the grounded state (no blank pose).
- The masked overlay (`setPlayerAnimationOverlay3D`) layers on top as before, and no longer needs the blend tree.
- **Stop restores the rig** to its pre-play pose.

**Default gait for a user Player.** A bound Player with a skinned humanoid rig, no locomotion set and no
`setPlayerAnimation3D` handler gets the default gait. It uses the rig's own `Walk` / `Run` clips when it has them, and
otherwise **runtime-generated** ones (`default-locomotion.ts`) that are never written to the skeleton, so they never
reach a saved document. It idles on the rig's `Breathe` clip (else `Idle`, else the rest pose).

**Clips (default-locomotion.ts, rebuilt in Round 8).** Seven runtime clips (2026-10-03: plus `Stroll`, the jump
variants and `Land Deep` / `Land Soft`; see §Jump variety + a looser walk / run):
- **Walk:** 1.6 m/s, heel-to-toe, a ~5 cm bob. (2026-10-03: rebuilt as the natural walk; the old one is now the
  `Stomp` clip. See §Natural walk / run.)
- **Run:** 4.6 m/s nominal. A flight phase twice a cycle, a heel kick to ~110°, a 13° lean, pumping bent arms.
  (2026-10-03: rebuilt; see §Natural walk / run.)
- **Sneak:** 0.9 m/s, crouched ~14 cm, long ground contact, arms held forward.
- **Crouch** (the sneak idle), **Jump** (the air pose, by air phase), **Fall** (a long-fall loop) and **Land** (the
  additive squash).

The gaits come from a biomechanical model: planted ankles rolling heel → flat → toe, a swing arc between footprints,
the pelvis at the height the stance legs allow, and 2-bone IK per leg, so a knee can't lock or hyper-extend. Gates:
- `default-locomotion.test.ts`: no skating, no ground penetration, stance / flight phases, knee range.
- `default-locomotion-pose.test.ts`: no limb through the body, on the real body. `LOCO_SHEETS=<dir>` writes contact
  sheets.
- The R6.3 skirt gate, which now covers every new clip too.

A host-owned `setPlayerAnimation3D(clips, handler)` is unchanged: it gets clip NAMES on transitions, and the host plays
them.

### Animation feel (visual-polish item 13, 2026-10-03)

Nothing to wire: these are engine defaults. They change only the runtime default clips (never saved) and the Play
loop. Clips a user authored, and Animation Library entries, play exactly as before.

- **Jump: Space taps are no longer lost.** A tap whose keydown and keyup both arrive between two 60 Hz ticks used to
  drop the jump, because the key was never "held" at a tick. In the review harness 3 of 4 instant taps never jumped,
  which is why the shot 250 ms after Space showed no air pose. `KeyboardInput.readTick()` now counts the key-down edge.
  A tap gives the short hop; a hold gives the full jump. Re-measured in the browser: 4 of 4 taps are in the air at
  250 ms.
- **Jump wind-up.** Play runs `jumpWindup` 0.06 s (`PLAY_JUMP_WINDUP`). A jump from the ground crouches for 4 ticks:
  knees bend, the torso folds and the arms swing back. Then it launches, with the toes pointed and the arms swinging up.
  A coyote jump, or leaving the ground mid-crouch, launches at once. The pure controller default is still 0.
  `locomotion().jumpWindup` reports the crouch progress (0 → 1). The default Jump clip records `takeoffPhase` (0.2):
  its crouch plays during the wind-up, and the air phase maps onto the rest of the clip. An authored Jump clip has no
  take-off, so it holds its first frame for those 60 ms and is otherwise sampled as before.
- **Landing.** The additive Land squash now applies as a delta from its own first frame. Before, its arm tracks
  "undid" the relaxed stance, so the arms flew up towards a T-pose for 0.4 s on every landing.
- **Idle: `Stand`.** A new runtime clip (9.6 s loop) replaces the torso-only `Breathe` as the auto player's idle and
  the default gait's idle. It has:
  - three breaths;
  - a slow left ↔ right weight shift, with the pelvis sliding over the standing foot and both feet IK-planted;
  - a glance with a small overshoot;
  - a right shoulder roll.

  A user Player still idles on its own `Idle` clip if it has one. After that the order is `Stand`, then `Breathe`, then
  the rest pose.
- **Walk / run / sneak.**
  - The walk has a loading DIP after each heel strike, so the knee takes the weight.
  - The walk has a fuller arm swing (±30°, elbows bending more as each arm comes forward), held 5° out, with a little
    more pelvis twist and chest counter-turn.
  - The run leans 16° (was 13°) with a ±50° arm pump. The run has no extra dip: it pushed the long-dress run past the
    skirt gate.
  - The stride is still matched to ground speed (foot slide in stance ≈ 0.06 m/s at a 1.6 m/s walk).
- **Arms clear the body and the OUTFIT.** At bind, the engine fits the relaxed arms on the body **plus its top**
  (`arm-clearance.withGarments` + `resolveArmClearance`), so the fit sees sleeves and forearms against a jacket's torso
  panel. Every default arm pose (gaits, crouch, jump, fall, Stand) is raised by that amount (`playArmClearance`, capped
  at 20°). Measured raises:

  | Body + top | Raise |
  |---|---|
  | Default body, tee | 0° |
  | Long sleeves | 6° |
  | Heavy body (`torsoThick` 1.3) + bulky long-sleeve top | 16.5° (the body alone fitted 9°) |

  The auto player's clips are re-fitted when Play binds it. The default gait's runtime clips are fitted when they are
  built. The fit is cached per body and top.
- **Turn anticipation.** `CharacterController.turnRemaining()` reports how far the body still has to turn toward the
  move direction. The head (and 40 % of it, the chest) turns toward the new direction by 16° per radian, with quicker
  smoothing, so the head looks round before the body arrives (a few frames ahead).
- **Skirt follow-through.** While Play runs, the skirt steer signal goes through a soft spring (`SkirtFollow`, 4 Hz,
  ζ 0.55), so the panels trail the legs by about 2 frames and settle. Editor posing is exact, as before.
  - A slower spring made the lag more visible, but the forward knee then pushed through the lagging front panel.
  - Skirts have no spring bones. A real hem swing needs skirt spring chains, which are not built. **Update 2026-10-04: the hem swing is built** without new joints; see "Skirt hem swing" below.

**Checking the motion.** `GAIT_PREVIEW=<dir> npx vitest run src/services/managers/gait-preview.test.ts` renders the
real Play chain on the CPU: controller → animator → `composeLocomotionPose` / `applyLocomotionLean`
(`locomotion-pose.ts`, the same code Scene3DManager runs). It covers four dressed bodies (long skirt, trousers, a heavy
body in a bulky jacket, a mini skirt) and writes idle / walk / run / stop / jump / turn / sneak sheets plus
`report.txt`. The report gives:
- foot slide;
- pelvis bob;
- forearm clearance;
- skirt poke-through;
- the clearance fit;
- the jump timeline.

### Idle vs gait: the Player's procedural idle yields in Play (fix, 2026-10-03)

**Symptom.** In Play, a Player with the procedural idle ON slid around in its idle stance, breathing and swaying, with
no walk or run cycle ("a chess piece wobbling about"). It looked fine in the editor. The character panel turns the idle
on for the character it edits (`setIdleAnimation3D(id, true)`), so most characters made in Frogmarks hit this.

**Cause.** Two writers posed the same rig every frame:
- the Play tick (the engine locomotion animator) wrote the gait pose;
- the procedural idle, a pre-render callback, then re-wrote the torso, arms and legs from its captured base just
  before the skin upload.

So the rendered pose was always the idle. The joints read back between frames still showed the gait, which made it
look like a GPU or skinning bug. Sim LOD exempts the Player from throttling, but nothing stopped the idle from running
on it. The 2026-10-02 snapshot has the same bug, so none of the recent changes caused it (sim LOD, face kit, TAA, the
GPU-driven path, stream slicing, the animation-feel work).

**Fix.** The idle callback skips any skeleton that the Play locomotion owns. The check is `isSkeletonPlayDriven` on the
Scene3DAnimation host, which calls `Scene3DManager._isSkeletonPlayDriven`. While Play runs, it covers two cases:
- the engine animator's rig (`_locoEngineSkelId`);
- the Player's rig under a host clip handler.

Idle breaks are skipped as well. While still, the Player plays the Stand idle clip instead. On Stop, the idle carries
on from its own base.

**Test.** In `play-auto-player.test.ts`, the test "a Player with the procedural idle ON still walks in Play" covers an
empty scene and a city (15 m/unit). Each step runs the captured `'idle'` pre-render callback, as a render frame does.
The thigh must swing more than 15° over the stride. Before the fix the range was 0°.

### Jump variety + a looser walk / run (2026-10-03)

These change only the RUNTIME default clips (never saved) and the Play animator. Clips a user authored, Animation Library
entries and `setPlayerLocomotionSet3D` sets play exactly as before (unless the set opts into `jumps`, below).

**Jump variety.** The default jump is now a family of variants, and each jump picks one:

| Clip | What it does | Picked mostly |
|---|---|---|
| `Jump` | The classic: a knee drives through, a moderate tuck, arms out | standing, walking |
| `Jump Tuck` | A deeper crouch, both knees pulled up, hands by the shins; lands deep | standing, walking |
| `Jump Reach` | Arms swing from behind to straight overhead, body extended, looking up | standing |
| `Jump Swing L` / `R` | A "layup": one knee drives, the opposite arm reaches high, the other drops back | walking, running |
| `Jump Stride L` / `R` | A running long jump: a stride split in the air, the trail leg comes through to land | running |
| `Jump Hop` | A tap: a shallow dip, a small spring, soft knees; lands soft | taps |

- Each variant has its own wind-up crouch, take-off, air pose (sampled by the air phase, as before) and landing
  (`Land`, `Land Deep` or `Land Soft`, the additive squash).
- **The pick** (`JumpVariantPicker`, `game/locomotion-animator.ts`) is seeded per character, never repeats the previous
  variant, and makes the one before that less likely. It is weighted by context: from a stand / walk / run (the
  animator's smoothed speed) and tap / hold. The stride never comes from a stand.
- **Tap vs hold.** The controller now reports `jumpHeld`. If the button is let go before the air phase passes 0.22 (a
  tap, which the variable jump height cuts short), the jump is re-picked among the tap-weighted variants (the hop),
  with a 0.1 s crossfade. It never re-picks the jump that played before.
- **Mirrored pairs.** `Swing` and `Stride` come in L / R versions, named by the leading leg. When moving, the side
  that matches the gait at take-off is used (the leg swinging forward leads).
- **A jump from the walk / run** skips the two-footed crouch: the stride blends straight into the variant's take-off
  pose (one foot pushing off) over 0.07 s, so the runner no longer pops upright through the clip's standing frame.
- **Setting:** `sm.setPlayJumpVariety3D(on)` / `getPlayJumpVariety3D()` (default on; stored as
  `globalScene.play.jumpVariety` only when off). Off = the classic `Jump` every time.
- **Authored jumps.** A Player with its own `Jump` clip plays it on every jump (no variants). A locomotion set can opt
  in with a list: `sm.setPlayerLocomotionSet3D({ idle, walk, run, jumps: ['JumpA', 'JumpB', 'JumpC'] })`. Two or more
  entries give one random pick per jump, unweighted and never the same twice running; `jump` defaults to the first.
- `getPlayerAnimationState3D()` now also reports `jumpClip`, `jumpCount` and `strollMix`.

**Walk / run: less stiff.**
- **In the clips** (`default-locomotion.ts` `GaitSpec`):
  - The pelvis tips forward as each leg takes the weight (`tilt`) and drops more on the swing side (walk roll 4.5°, was 3.5°).
  - The torso sways over the stance foot a beat after the pelvis (`chestSway`, `sideLag`).
  - The head's stabilising counter is slightly late (`headLag`), so it floats instead of being nailed level. The
    torso bob is smooth (it had a kink each step).
  - Overlap in the arms: the elbow flex trails the upper-arm swing (`forearmLag`: most bend just after the front of the
    swing), the hand trails the forearm (`handLag`, wrist deviation), and the shoulder rides forward with its arm
    (`protract`). The walk elbow bends a little more (17° + 27°).
- **Stroll.** A slow-walk clip (0.85 m/s, shorter steps, small loose arm swing) is blended in below the walk speed. A
  start, a stop and a half-tilted stick no longer play the full walk in slow motion. At a 45 % stick the foot slide
  went from 0.17 / 0.26 m/s (walk only) to 0.09 / 0.02 m/s.
- **Settle step (a smooth stop).** Gait clips record `passPhases` (mid-stance of each leg). On a stop the animator
  leaves the gait as soon as the body has stopped (the raw speed), and the gait steps on to the next passing position
  while it fades (0.16–0.42 s). The legs come together instead of freezing mid-stride and sliding.
- **Per-character variation.** `buildLocomotionClips(joints, { variation: id })` gives each character a walking
  personality (`gaitPersonality`: stride, cadence, arm swing, bounce, swagger, posture, each −1..1). The seed is the
  body's id; the auto player uses a fixed seed. A crowd of one body no longer moves in lockstep. Absent = the authored
  gaits exactly.
- **Secondary motion** (`LocomotionSecondary` + `applyLocomotionSecondary`, over the runtime gaits only):
  - every gait cycle draws a new swing scale for each arm (±12 % at the default), eased across the cycle;
  - an under-damped upper-body spring driven by the acceleration: the chest lags on a start, swings forward on a stop
    and settles with a small overshoot, and the arms swing with it;
  - a slow head drift while moving.
  `sm.setPlayMotionLooseness3D(0..1)` scales it (default 0.5; 0 = the clips exactly; stored as
  `globalScene.play.motionLooseness` when not 0.5).
- **Kept:** the lean into acceleration and the bank into turns (`LocomotionLean`) and the head leading a turn, as before.

**Numbers** (`GAIT_PREVIEW`, 4 dressed bodies; `skirt-leg-follow` report):
- **Clip feet:** planted for every personality (contact-point skate ≤ 0.009 m/s).
- **Walk foot slide in Play** (the preview's 30 fps measure): 0.043 / 0.048 m/s (skirt), 0.032 / 0.057 (trousers),
  0.019 / 0.061 (jacket), 0.054 / 0.055 (mini). It was 0.056 / 0.060 for all four. The run figure comes from 3 stance
  samples, so it is noise-dominated.
- **Skirt clip** (NEW body, steered):
  - Long dress: 23.8 mm (was 24.5; gate 25). With five personalities: 16.3–24.6 mm.
  - Skirt / mini / knee dress: 0 mm.
  - The CLASSIC body's knee dress in the tuck apex measures 13 mm. That body is not gated; the tuck was lowered from
    31 mm.

**Checking.**
- The gait preview now also runs a jump session: 12 jumps standing / walking / running, holds and taps, plus a
  45 %-stick stroll. It writes `<char>-jump-variants.png` (each variant from wind-up to landing),
  `<char>-jumps-{stand,walk,run}.png` and `<char>-stroll.png`.
- `report.txt` lists the picked sequence.
- Switches: `GAIT_SEED`, `GAIT_NOVARY`, `GAIT_NOVARIETY`, `GAIT_NOSTROLL`, `GAIT_LOOSE`.
- `SKIRT_VARY=<id>` runs the skirt gate with a personality.

### Natural walk / run + the Stomp walk style (2026-10-03)

Nothing to wire for the new gaits: they replace the RUNTIME default `Walk`, `Run` and `Stroll` clips (never saved).
Clips a user authored, Animation Library entries and `setPlayerLocomotionSet3D` sets play exactly as before. This
supersedes the walk / run notes in §Clips, §Animation feel ("loading DIP", "run leans 16°") and §Jump variety above.

**What was wrong (measured on the clips, `default-locomotion.ts`).**
- **Walk "stomping".** The pelvis followed the stance legs' reach ceiling, which has a cusp at every heel strike, and
  the leg about to land was not part of that fit. So the landing foot hung about 3.6 cm above the ground (its knee
  straight, out of reach) and dropped in one frame (about 1.1 m/s) as the pelvis fell 5 cm onto it. Then a knee dip
  followed. The bob PHASE was already right (highest at mid-stance), so it was not inverted. The foot roll existed but
  was small (14° heel strike, 26° toe-off), and the heel rise eased to a stop at toe-off. The feet tracked the hip
  joints (±4.5 cm), a near tightrope from the front.
- **Run "lunge".** The foot landed 35 cm ahead of the hip on the rig (49 cm on the default body). The rear leg left the
  ground with a straight knee (6°), stayed straight for 2 frames and folded late, under the body. The pelvis was lowest
  at contact / toe-off rather than at mid-stance. The lean was all in the spine (16°).

**The natural gait model** (the specs that set `bob`):
- **Pelvis.** A smooth wave twice a cycle, placed as high as EVERY leg allows: the stance legs and the leg about to land.
  The walk is highest just before mid-stance and lowest in double support. The run is lowest at mid-stance (compression)
  and highest mid-flight.
- **Swing leg.** It follows keyed thigh / knee angles, velocity-matched to the stance at both ends: zero world velocity
  at lift-off and touch-down, so no skid. The foot follows its shank, plus a mid-swing pitch.
  - Walk: the knee folds to about 60° just after toe-off for clearance, then opens to land.
  - Run: the rear leg folds at once (a heel kick toward the glutes), then the knee drives forward and up.
- **Foot roll.** The heel strikes with the toes up, rolls down to foot-flat, and the heel rise ACCELERATES into the
  push-off.

| | Walk | Run |
|---|---|---|
| Speed / cycle | 1.6 m/s, 0.86 s (≈ 140 steps/min) | 4.6 m/s, 0.66 s (≈ 210 steps/min at Play's 5.2 m/s) |
| Foot roll | heel strike 20° toes up → toe-off 46° | 8° → 50° |
| Knee | swing peak ≈ 60°; ≈ 10° at mid-stance | heel kick ≈ 100°, past 50° within 0.12 cycle of toe-off; drive: thigh ≈ 40° forward |
| Pelvis | highest ≈ mid-stance, lowest in double support | lowest at mid-stance, highest mid-flight |
| Other | feet ±8 cm apart on the rig (was ±4.5) | lands 25 cm ahead of the hip (was 35); flight ≈ 40 % of the cycle; 7° whole-body lean from the pelvis plus 8° in the spine (the legs stay planted) |

The per-character personalities, the stroll blend, the settle-step stop, the arm-clearance raise and the jump variants
are unchanged. The stroll uses the same model.

**Numbers** (`GAIT_PREVIEW`, 4 dressed bodies, Play chain at 30 fps).
- **Walk contact slide:** 0.004–0.019 m/s. This now measures the heel and the ball while each is down: the planted
  points of a rolling foot. The old ankle-joint measure (0.05–0.09) reads the ankle swinging over the roll as slide.
- **Pelvis vs gait phase** (cm, skirt; 0 = left heel strike, left mid-stance = 0.30):
  - walk: `0.0:-2.7 0.1:-0.1 0.2:+2.6 0.3:+1.7 0.4:-1.4 0.5:-2.7` (highest ≈ 0.25–0.3, lowest in double support);
  - run: `0.0:-2.1 0.1:-3.4 0.2:-0.5 0.3:+2.6 0.4:+2.3` (lowest at mid-stance 0.135, highest mid-flight ≈ 0.38).
  - Before, the run had its low at 0.2 (toe-off) and a 4.9 cm range; now the range is 5.8–7.0 cm.
- **Run flight:** 43–54 % of the frames have both feet more than 1 cm off the ground (39–50 % before, but the old
  "flight" was a long, low glide of the straight rear leg).
- **Skirt clip** (skirt-leg-follow, NEW body, steered): long-dress run 16.9 mm (was 23.8; gate 25). Walk 0 mm.

**Stomp: the old walk, kept for custom use** (e.g. stomping through swamp water). The Round 8 / item 13 walk is the
runtime clip `Stomp`, built alongside the others: the pelvis on the reach ceiling, the foot dropping onto the ground,
the knee dip. Two ways to use it:
- **The Play setting** swaps the default character's walk:
  ```ts
  sm.setPlayWalkStyle3D('stomp');    // 'natural' (default) | 'stomp'; live while playing
  sm.getPlayWalkStyle3D();           // → 'stomp'
  ```
  - It swaps only the RUNTIME default `Walk` (auto player, default gait); an authored walk is never replaced.
  - In stomp style the stroll blend is off (the natural slow walk would blend back in).
  - Stored as `globalScene.play.walkStyle` only when `'stomp'`.
- **Per avatar, in a locomotion set:**
  `sm.setPlayerLocomotionSet3D({ idle: 'Stand', walk: 'Stomp', run: 'Run' })`. A set slot naming a runtime default
  clip (`Stomp`, `Walk`, `Run`, `Stand`, …) that the rig doesn't have is generated for the rig at bind time. It is never
  written to the skeleton.

**Checking.**
- `GAIT_PREVIEW=<dir> npx vitest run src/services/managers/gait-preview.test.ts`. The report now adds the contact slide,
  `walk / run pelvis vs phase` and the run flight. New switches: `GAIT_TILE=<px>`, `GAIT_SHEETS=walk,run`,
  `GAIT_VIEW=side|front`, `GAIT_NAKED=1` (the body only, to read the legs).
- Tests (`default-locomotion.test.ts` §natural walk / run):
  - the walk / stroll bob peaks near mid-stance;
  - the run has a flight phase and a visible rise, lowest at mid-stance;
  - foot roll: toes up at contact, heel up at toe-off;
  - the landing heel's last drop is < 2 cm per frame (the Stomp's is > 3);
  - the swing knee, heel kick and knee drive;
  - step width;
  - `Stomp` exists and `applyWalkStyle` swaps it.
- PlaySettings walk-style persistence is tested in `play-auto-player.test.ts`.

## Skirt hem swing + clothes that hold up in a run (clothing fit round 2, 2026-10-04)

**What the player sees:**
- A skirt's hem trails behind while running. On a stop it swings past centre and settles. A jump, a landing or a quick turn flares it open.
- Trousers no longer show the knees or the thighs through the fabric on the run's deep knee bends.
- A long skirt no longer shows the knee cap through its front panel, and its inside reads as fabric in shadow.

**How:**
- `skirt-swing.ts`: a spring-damped lag (1.9 Hz, ζ 0.32) chases minus the pelvis velocity, and a flare spring chases vertical speed and turn rate. Both are read from the hips skin matrix each frame.
- The swing is an OUTWARD-only, bounded offset of the hem vertices, on top of the leg-follow steer, so it can't push cloth into the legs. The long dress stays inside its 25 mm gate at the worst lag in 8 directions plus full flare.
- It runs only while Play runs. The vertices return exactly to rest on Stop or once settled. Cost: one skinned-VB re-upload of the skirt per moving frame.
- The knee and skin fixes are the body-hiding mask plus smoother hip / thigh weights; see [clothing-generation.md §16](../specs/clothing-generation.md).

**Knobs:** `sm.setSkirtSwing3D(bodyId, 0..1.5)` (0 = off, 1 default; persisted as `hemSwing`) and `sm.setHideBodyUnderClothes3D(bodyId, on)`. Frogmarks has both in the character panel: "Skirt swing" on the Bottom tab, "Hide body under clothes" on the Top and Bottom tabs.
## An energetic run + the jog (2026-10-04)

User feedback: "the run is awkward bc it needs more airtime / energy to it and seems kinda stiff". This supersedes the
Run column of the table above. The walk, the Stomp, the stroll and the authored clips are unchanged.

**What was wrong (the 10-03 run, measured).**
- The knee drive was about 41° and the pelvis moved only 6–7 cm, with flight on 43–54 % of the frames.
- The knee was still bent about 33° at toe-off, so there was no push-off stretch.
- The arms pumped mostly behind the body (−61 … +40°). The hand never came above the shoulder, and the arms swung
  straight fore-aft.
- The cadence was about 210 steps/min, which reads as a stiff shuffle.

**The energetic model** (`default-locomotion.ts`, the `Run` and new `Jog` specs).
- **Spring-mass pelvis** (`air`, `pushRise`). Over each stance the pelvis dips in a half-sine (the landing SQUASH, with
  the knee taking about 50°). Over each flight it follows a ballistic arc. It leaves the ground higher than it lands,
  so the stance leg straightens over a pointed foot at toe-off (the STRETCH). This shape is still fitted under every
  leg's reach, so the feet stay planted.
- **Lower cadence, shorter contact.** The period is 0.74 s and the duty 0.22, about 180 steps/min at Play's 5.2 m/s.
- **Swing leg.**
  - The heel whips up at once, with a heel kick of about 107°.
  - The thigh then drives to about 75° on the rig (74–75° on the dressed bodies).
  - The keys are spaced so the leg whips through the middle of the swing and eases at the ends, rather than moving
    linearly.
  - While the knee drives forward, its fold is held at about 105° or less. A deeper fold pushed the long dress's
    running clip past its 25 mm gate.
- **Arms.**
  - The pump is bigger (`arm` 56, `armFwd` 18), and the elbow flexes more in front (76° + 26°).
  - In front, the hand reaches about chin height: 7–14 cm above the shoulder joint on the dressed bodies.
  - Behind, the elbow is about 23 cm back from the chest.
  - The upper arm rolls in as it swings forward (`armCross`), so the hand crosses toward the midline (about 9 cm from
    the chest centre, against 24 cm at the back of the swing).
- **Torso and head.**
  - The shoulders counter-turn the pelvis more (`twist` 11) and protract more (`protract` 10).
  - The chest bounces more (`chestBounce` 3°, forward at mid-stance).
  - The lean is 9° from the pelvis plus 9° in the spine.
  - A head NOD on each impact (`headNod`): a short dip just after touch-down, which arrives a beat late (`headLag`).
- **The JOG** is the same model at about 3 m/s, smaller. Its duty is 0.32, its float and compression are smaller, the
  knee drives to about 50°, the arm pump is smaller and the lean lighter (5° + 6°).
- **Speed-dependent.** The animator blends walk → jog → run by speed, so the lean, the air and the arm pump all grow
  with speed:
  - The jog is fully weighted at its own ground speed. The jog point is never above the run speed, so a slow top
    speed stays a jog.
  - The run is fully weighted at the run speed, or already at `runFullAt` (0.85) × the run clip's own ground speed if
    that is lower.
  - The settle-step stop, the personalities (`varyGait` also scales `air`), the arm-clearance raise and
    `scaleRateClamp` are unchanged.
- The idle variety yields to Player input as before.

```ts
sm.getPlayerAnimationState3D();  // → { …, runMix, jogMix, … } — jogMix 1 = fully the jog, 0 = fully the run
// Play's slots: { …, run: 'Run', jog: 'Jog' } (the jog only under the runtime Run, which it is matched to)
// LocomotionAnimatorConfig: jogSpeed / jogClipSpeed (null = automatic), runFullAt (0.85)
```

**Numbers.**

| | 10-03 run | Run now (rig / dressed) | Jog now (rig / dressed) |
|---|---|---|---|
| Knee drive (thigh forward) | 41° | 76° / 74–75° | 50° / 40–42° |
| Heel kick | 102° | 107° | 100° |
| Pelvis range | 4.5 cm / 6–7 cm | 8.4–8.9 cm / 11.0–12.7 cm | 5.2–5.5 cm / 5.0–6.0 cm |
| Flight (both feet > 1 cm up) | 40 % / 43–54 % | 45–48 % / 54–57 % | 26–33 % |
| Toe-off knee | 33° | 23–28° (at the duty frame) | 30° |
| Hand height vs shoulder | −3 cm | +5…+10 cm / +7…+14 cm | −7…−10 cm |
| Elbow behind the chest | 22 cm | 20–23 cm / 22–24 cm | 14–17 cm |

"Rig" is the test rig in `default-locomotion.test.ts` (neutral and two personalities). "Dressed" is `GAIT_PREVIEW`
on the skirt, trousers, jacket and mini bodies at 5.2 m/s (the jog row at a 3.4 m/s move speed).

- **Skirt clip** (`skirt-leg-follow`, NEW body, steered):
  - Long-dress run: 0.6 mm. Its worst pose is now the Jog at 16.9 mm (gate 25).
  - Knee dress: 0 mm. Skirt and mini: 0 mm.
  - No per-outfit knee-drive reduction was needed.
- **Poke-through** (body verts through the bottom garment, mean per frame) rises a little at a run, from the deeper
  stride. On the skirt it goes from 8.0 to 8.1. On the trousers it goes from 14.0 to 16.8. That belongs to the
  clothing pass, which handles knee flexion up to about 90°.

**Checking.**
- CPU sheets:
  - `GAIT_PREVIEW=<dir> GAIT_SHEETS=run,jog,stop npx vitest run src/services/managers/gait-preview.test.ts`.
  - `report.txt` adds a `run energy` line: speed, jog mix, knee drive, hand height and elbow-back. It also adds the
    jog's flight, pelvis range and knee drive.
- Tests in `default-locomotion.test.ts` §natural walk / run:
  - energetic run: airtime > 40 %, pelvis range 7.5–12 cm on the rig, knee drive 70–92°, heel kick > 100°, toe-off
    knee < 32°, the landing squash, an arm arc > 105° that reaches > 55° forward, and the impact nod (> 3° vs
    mid-flight);
  - the jog is smaller on every axis but still has a flight phase.
- The animator's walk → jog → run weights are tested in `locomotion-animator.test.ts`.

## Landing dust + idle variety (Play polish, 2026-10-04)

Two small touches that make the default character feel alive in Play. Both are on by default, both can be turned off
live, and both are saved with the document only when off.

```ts
sm.setPlayLandingDust3D(true);   // landing puffs, running footstep puffs, wet splashes
sm.setPlayIdleVariety3D(true);   // random one-shot standing idles over the default Stand
sm.getPlayPolishStats3D();       // → { dust: { land, landDeep, landSoft, step, splash, stepSplash }, dustLive, idleVariants, idleVariant }
```

Frogmarks: Play settings popover → **Landing dust** and **Idle variety** checkboxes.

### Landing dust

- **On a landing**, a ring of anime-style puffs spreads fast and then stalls. Each puff is hard-edged with a lumpy
  outline and a two-tone shade band, and it wears away with a ragged dissolve edge instead of fading out. The ring is
  sized by the landing:
  - **Land Soft** (a hop): a few small puffs.
  - **Land**: the standard ring.
  - **Land Deep** (a long fall, or a heavy landing): more puffs, faster and bigger, plus a central cloud that rises.
  The landing clip the animator played picks the variant; a rig without one goes by the impact. A moving landing carries
  the ring a little forward.
- **Running** on dry ground raises 2–3 tiny puffs behind the foot at each foot strike (the gait phase crossing 0 / 0.5).
  Walking and sneaking raise none.
- **Wet ground** (city rain, or the wet-sheen look ≥ 0.35) splashes instead: droplets arc out under gravity over a low
  spray ring. Running on a wet street gives a small splash per step.
- **Colour, light, fog.** The dust takes the colour of the surface under the feet (its material colour, lifted toward a
  pale dust). It is lit by the scene's ambient light and sun (with the sun's elevation), so it is darker and bluer at
  night, and fogged by the scene fog at its distance.
- **Scale.** Every size is in metres × the avatar's height / 1.7 m, so a doll gets a small puff, a giant a big one, and
  a city's 15 m per unit is respected.
- **Sim LOD.** Nothing is emitted past the fog-horizon edge (the edge that freezes the simulated crowd). A footstep puff
  is skipped past ~40 m from the camera and a landing ring past ~120 m.
- **Zero cost when not emitting.** The particle pool is allocated on the first burst and released as soon as the last
  puff dies. The system is registered with the renderer only while puffs are alive, so an idle Play frame does no dust
  work and no extra draw.

How it works:
- `src/game/landing-dust.ts`: the pure CPU simulation (`DustSystem`, `dustColor`, `landingDustKind`,
  `footStrikeBetween`). It is seeded and has no wall clock.
- `src/services/managers/play-dust-driver.ts` (`PlayDustDriver`): decides when to emit, from the animator's landing
  counter (`landCount` / `lastLanding`) or the controller's `landImpact`, and from the gait phase.
- Drawing: `Renderer3D.addTransientParticles` draws the puffs with the billboard particle pipeline, in a procedural
  shape mode (`texInfo.y`: 1 = cel puff, 2 = droplet; ordinary emitters pad it with 0).
- Wetness comes from `WorldManager.playWetness`, wired in ShapeManager to `scene3d.playWetness`.

### Idle variety

While the character stands still on the default **Stand** idle, it now and then plays a one-shot variant:

| Variant | What it does |
|---|---|
| Idle Look Around | Looks left, then right, then back. The eyes lead, the head overshoots a little, the neck and chest follow late. Blinks on each turn. |
| Idle Stretch | Arms forward and up over the head, chest arched back, a yawn (`open` expression on the face kit). |
| Idle Check Wrist | The left forearm comes up in front of the waist; the head dips and turns to look at it. |
| Idle Foot Tap | Weight onto the left leg; the right toes tap three times with the heel down. |
| Idle Adjust Glasses | The right hand comes up to the face; a brow raise. Only when the character wears a glasses, wire-glasses or sunglasses charm. |

- **Scheduling** (`IdleVariantScheduler` in `locomotion-animator.ts`):
  - The first variant comes after 4–7 s of standing, then one every 6–12 s.
  - It is seeded per character and never plays the same variant twice in a row (the one before that is less likely).
  - Each variant eases in over 0.5 s and back out over 0.6 s.
  - Any movement, crouch, jump wind-up, landing or airborne state cancels it at once (0.15 s fade) and restarts the
    wait, so locomotion always wins.
- **Authoring** (`src/services/managers/default-idle-variants.ts`):
  - The arms are written with `pose-authoring.ts` (raise / forward / twist / elbow / wrist) over the relaxed stance plus
    the body's arm clearance. The legs are solved with the gait IK every frame, so the feet stay planted.
  - Every variant starts and ends exactly in the neutral Stand pose.
  - Face events (gaze, blink, face-kit expression, brow raise) ride in the clip's `faceTrack`. The Play driver fires
    them as the variant plays and restores the face if the variant is cancelled.
  - They were checked with the pose preview report (`POSE_PREVIEW=<dir> POSE_ONLY=idlevar npx vitest run
    src/services/managers/pose-preview.test.ts`): every 0.5 s of every variant is clean (no limb inside the body or head).
- **Authored Idle clips win.** The variants only play over the runtime Stand: the default gait of a user Player with no
  idle of its own, and the auto default character. A rig with its own `Idle` (or `Stand`) clip, a locomotion set or a
  host clip handler plays as authored.
- **The procedural idle still yields.** The variants are layers of the engine animator, so the character panel's
  procedural idle keeps yielding to Play as before.
- Runtime-only: the variant clips are never written to the skeleton or saved.

**Tests:**
- `locomotion-animator.test.ts` §idle variety: seeded, no repeats, smooth fades, cancel on move, off / crouch / none,
  and the landing counter.
- `landing-dust.test.ts`: per landing type count and spread, splashes, scale, zero cost, colour / fog / night.
- `play-dust-driver.test.ts`: no particles while idle or walking, one burst per landing of the right kind, wet
  splashes, running footsteps, renderer registration, and the settings.
- `default-idle-variants.test.ts`: the set, ends in the Stand pose, arm clearance, face events.
- `play-auto-player.test.ts` §Play polish: variants play in Play with the procedural idle ON (it yields); a move
  cancels; an own Idle gets none; dust on a landing, none while standing.

**Browser check (2026-10-04)** (`pupdrive/extras/play-frames.js`, port 5253, IDLE=1):
- All five variants played with no repeats.
- Landings gave Land / Land Deep / Land Soft rings, and running gave footstep puffs.
- A forced wet street gave splashes and splash steps. At night the dust was dim and blue-lit.
- Standing still afterwards, nothing was allocated or registered.

## Play suspends the editor (Round 8)

While Play runs (`sm.isPlaying3D`), the engine turns the editor off, and restores it on Stop.
- **Keyboard:** the renderer's editor shortcuts never fire (Ctrl+Z / Ctrl+Y vector undo, Ctrl+D duplicate, G / U
  group, Delete). `undo3D` / `redo3D` return false. The host-called G/R/S modal transform family (`beginTransform3D`,
  `constrainAxis3D`, `appendNumericInput`, `commitTransform3D`) is inert, because Play's W/A/S/D also reach the host's
  document listener and S would start a scale. The UI system's own key hook still runs. The **host's** own hotkeys are
  the host's to gate (on `isPlaying3D` / `onPlayStateChanged3D`).
- **Pointer:** no 2D select / drag / pan / zoom / hover hit-tests. No 3D hover pick (a full-scene raycast per mouse move)
  or hover outline. No click-select and no gizmo drag: the pointer-lock click used to select or grab meshes mid-Play.
  No joint picking.
- **Overlays and per-frame editor work:** the selection box, transform gizmo, bone overlay, mesh-edit handles,
  vertex-snap viz, camera frustum and emitter icons aren't drawn, and the transform-gizmo sync and camera-frustum
  pre-render callbacks skip. The grid and the artboard frame still draw (they're scene display settings).
- Flag: `sm.interactionService.playActive` (true while playing).

## Movement → gameplay (`player.*` variables)

While playing, the engine publishes the player's motion into the **active UI state machine** as variables:
`player.speed` (number), `player.moving` / `player.grounded` / `player.airborne` / `player.rising` (booleans).
**Declare** the ones you want in the machine, then drive transitions off them (Unity-parameter style) — e.g.
`player.airborne == true → jump state`, or `player.speed > 2.2 → running`. Undeclared variables are ignored,
so there's no cost unless you opt in.

## Custom input (gamepad / on-screen pad)

Opt out of the built-ins and feed intent each frame:

```ts
sm.enterPlayMode3D({ keyboard: false, mouseLook: false });
// per animation frame:
sm.setPlayInput3D({
  forward,   // -1..1 (+ = walk where the camera looks)
  right,     // -1..1 (+ = strafe SCREEN-RIGHT)
  jump,      // edge-triggered boolean
  lookYaw,   // radians this frame; + = turn RIGHT (mouse/stick moved right)
  lookPitch, // radians this frame; + = look up
});
```

> **Analog speed (2026-09-29):** `forward`/`right` magnitudes below 1 now move proportionally slower (the move vector is
> clamped to length 1, no longer normalized), so a half-tilted stick walks and a full one runs. Keyboard is always full.

> Sign conventions fixed 2026-09-16 — A/D and mouse-turn were mirrored before (the controller
> assumed a −Z-forward handedness). If you wrote a custom input source against the old behavior,
> drop any sign flips you added to compensate.

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
