# Animation Library — Frogmarks host integration

Author an animation once, reuse it on any creature. Engine spec:
[../specs/animation-library-and-triggers.md](../specs/animation-library-and-triggers.md). All APIs on
`ShapeManager` (`sm`). **Phase A (library) + Phase B (triggers/blending) are BUILT** (2026-09-17), including the
**1D locomotion blend tree** (continuous idle↔walk↔run mix): `sm.setPlayerLocomotionBlend3D(true)` (or
`{ walkSpeed, runSpeed }` to tune, `null` to go back to discrete crossfades) on top of a locomotion set —
airborne jump/fall stay discrete. Also **per-region layer masks**: `sm.setPlayerAnimationOverlay3D(clipRef, region)`
layers a masked clip (e.g. a wave or aim) over the locomotion so it drives only `region`'s joints
(`'upperBody'`/`'lowerBody'`/`'arms'`/`'head'`, or an explicit joint-name array) while the rest keep walking;
`clipRef` is a library-entry id/clip id/name, `null` clears. Requires the blend tree. Both persist with the player binding.
The overlay defaults to `replace` (overrides the masked joints); pass `{ mode: 'additive', weight }` to instead **layer**
the clip's motion (relative to its start frame) on top — for a subtle lean/breathe/aim-offset that adds onto the base.

## The idea

Clips + poses authored in Armature Mode live on the skeleton that made them. The **Animation Library**
lifts them out into a document-level, reusable store; applying an entry to another skeleton **retargets by
joint name** (case-insensitive), so a clip authored on one character drops onto any other — losslessly when
they share a rig (all procedural bodies share the 19-joint rig), partially with a warning when they don't.

Non-destructive + copy-based: promote deep-copies out, apply deep-copies in; skeletons stay self-contained.

## API

| Method | Use |
| --- | --- |
| `sm.addClipToLibrary3D(clipId, {name?, tags?}) → entryId \| null` | Promote a clip. `entryId` null if the clip id isn't found. Names dedupe ("Walk (2)"). |
| `sm.addPoseToLibrary3D(skeletonId, poseId, {name?, tags?}) → entryId \| null` | Promote a pose. |
| `sm.getAnimationLibrary3D() → AnimLibraryEntry[]` | List entries (copies) for the panel. Each = `{ id, name, kind: 'clip'\|'pose', jointManifest: string[], rigType?, sourceRig?, tags?, defaultLoop? }`. |
| `sm.applyLibraryEntry3D(entryId, targetSkeletonId, {rename?}) → newClipId \| newPoseId \| null` | Apply via retarget. Null if the entry/skeleton is missing **or zero joints matched**. |
| `sm.libraryCompatibility3D(entryId, skeletonId) → {matched, missing: string[]} \| null` | Preflight for a compat chip ("18/19 joints — missing: tail"). Call before Apply. |
| `sm.renameLibraryEntry3D(entryId, name)` / `sm.removeLibraryEntry3D(entryId)` | Bookkeeping. |
| `sm.setLibraryEntryRigType3D(entryId, rigType)` | Override an entry's rig-type label (e.g. `'creature'`). |
| `sm.getSkeletonRigType3D(skeletonId) → string \| null` | A skeleton's coarse type — pre-filter the panel to likely-fit entries. |
| `sm.exportAnimationLibrary3D() → string` | JSON, for cross-document reuse / a shared file. |
| `sm.importAnimationLibrary3D(json, {merge?}) → entryIds[]` | Import. `merge:true` appends (dedupes names); default replaces. **Ids are always re-minted** — libraries never collide across documents. |

`AnimLibraryEntry.jointManifest` is the list of joint names the entry animates — show it (and the
`sourceRig`) so the user knows what a clip needs; pair with `libraryCompatibility3D` before applying to a
different creature.

### Rig type (`rigType`) — a filter label, not a gate

Each entry auto-classifies its source rig as `'humanoid'` (standard biped: hips + spine + head + a
left/right limb) or `'generic'`, stored on `entry.rigType`. Use it to **group/filter** the library ("show
humanoid clips") and to gray-out entries that likely won't fit before the user tries — call
`getSkeletonRigType3D(targetSkeletonId)` and compare. Authors can relabel via `setLibraryEntryRigType3D`
(e.g. tag hand-made quadruped clips `'creature'`). **It is NOT the compatibility check** — a clip that only
moves an arm applies to any rig with that arm regardless of type. `libraryCompatibility3D` (joint-exact)
remains the source of truth for whether an Apply will actually land; `rigType` is just the coarse,
human-readable bucket for a tidy panel.

## Persistence

The library is saved **inside the document** (in the 3D scene settings) and restored on load. Nothing to
wire host-side. Old documents load with an empty library. A library with zero entries isn't written (keeps
saves clean).

## Suggested UI

- **Armature Mode → Clips/Poses panels:** a "＋ Add to Library" action per clip/pose row.
- **A "Library" tab/panel:** list `getAnimationLibrary3D()` (name, kind icon, `rigType` badge, tags,
  joint-count, source rig). Per row: **Apply to selected skeleton** (show the `libraryCompatibility3D` chip
  first — green "19/19", amber "17/19, missing hips…"), Rename, Delete, and a rig-type dropdown
  (`setLibraryEntryRigType3D`). Panel-level Export / Import buttons.
- **Filters:** by `rigType` (Humanoid / Creature / Generic) and by tag (`locomotion`, `gesture`) — a mature
  library gets long. Optionally default the filter to `getSkeletonRigType3D(selectedSkeleton)` so the panel
  opens showing clips that fit the current character.

## Phase B — Triggers & blending (BUILT 2026-09-17)

These extend the **UI state machine** (no separate Animator flowchart) and Play mode.

- **Crossfade** — the `playAnimation` action/effect takes an optional **`blendFrames`**. When something is
  already playing on the target, the new clip is blended in over that many frames instead of snapping. Add it
  to a transition's `playAnimation` action.
- **`animationFinished` trigger** — `{ type: 'animationFinished', targetId, clipId? }` fires when a
  **non-looping** clip (`loop: false`) on `targetId` reaches its end (`clipId` omitted = any clip on that
  target). This is the one-shot chain: `interact:chest → playAnimation Open (loop:false, blend 6)` then
  `animationFinished:Open → goToState opened`.
- **`player.*` machine variables** — while Play mode runs, the engine publishes `player.speed` (number) and
  `player.moving` / `player.grounded` / `player.airborne` / `player.rising` (booleans) into the **active UI
  layer**. **Declare the ones you use** as variables in the machine (Unity-parameter style), then condition
  `variable` triggers on them, e.g. `player.speed > 2.2 → crossfade to Run`. Undeclared = ignored.
- **`sm.setPlayerLocomotionSet3D({ idle, walk, run, jump, fall })`** — bind the five locomotion slots to
  **Animation Library entry ids** (or clip names/ids already on the avatar). The engine resolves + applies
  them onto the avatar's skeleton and self-wires crossfading playback, so binding a character makes it walk
  with **zero host playback code**. `idle` + `walk` are required; the rest are optional. Persisted with the
  player binding, so a game's avatar + walk survive reload. `sm.getPlayerLocomotionSet3D()` reads it back.
  Host UI: five dropdowns (filter to `tags:['locomotion']`) in the Character/Play panel.

## Player animation composition (BUILT 2026-09-17)

On top of a locomotion set, the Player avatar's animation composes three layers — all persisted with the player
binding, all reusing the same pose primitives (no separate mixer):

- **1D locomotion blend tree** — `sm.setPlayerLocomotionBlend3D(true)` turns the discrete idle→walk→run *switching*
  into a **continuous mix by speed**, so accelerating reads as a smooth gait change. Pass `{ walkSpeed, runSpeed }`
  (world u/s at which each clip is fully weighted; defaults 1.2 / 3.2) to tune, `null`/`false` to revert to
  crossfades. Airborne (jump/fall) stays discrete. `sm.getPlayerLocomotionBlend3D()` reads it back.
  Host UI: a "Smooth locomotion" toggle + two speed sliders in the Character/Play panel.
- **Masked overlay** — `sm.setPlayerAnimationOverlay3D(clipRef, region, opts?)` layers a clip over the locomotion so
  it drives only `region`'s joints (a **wave while walking**). `region` is a preset — `'upperBody'` / `'lowerBody'`
  / `'arms'` / `'head'` — or an explicit joint-name array. `clipRef` is a library-entry id / clip id / name; `null`
  clears. `opts.mode` is `'replace'` (default — overrides those joints) or `'additive'` (layers the clip's motion
  *relative to its start frame* on top, weighted by `opts.weight` 0..1 — for a subtle lean/breathe/aim-offset).
  **Requires the blend tree to be on.** `sm.getPlayerAnimationOverlay3D()` reads it back.
  Host UI: an "Upper-body action" clip dropdown + region picker + a replace/additive toggle with a weight slider.

## Animated thumbnails / previews (BUILT 2026-09-17)

Instead of a static thumbnail, render a **rotating turntable loop** of a clip — it shows the motion *and* the pose
from every side, which a still frame of a walk cycle can't.

**API:** `sm.captureAnimationPreview3D(skeletonId, clipRef, opts?) → Promise<{ frames: string[]; width; height; frameCount; fps } | null>`

- `frames` is an array of **PNG data URLs**, one per turntable step, in order. Play them back as a loop (swap an
  `<img>` `src` on a timer at `fps`), or lay them out as a CSS sprite strip. The heavy rendering happens **once**
  here — playback is just cheap image swaps, so a panel of many previews costs nothing at display time.
- `clipRef` is a **clip id or name already on `skeletonId`**. Non-destructive: camera, pose, and mesh visibility are
  all restored afterwards. Returns `null` if the skeleton or clip isn't found.
- `opts`: `frames` (steps, default 24), `size` (px square, default 256), `turns` (camera revolutions across the
  strip, default 1), `pitchDeg` (camera tilt, default 12), `margin` (framing padding, default 1.4), `fps` (playback
  hint, default 24), `isolate` (default `true` — hide everything except the meshes driven by this skeleton, for a
  clean subject on the current background).

**Two-step flow to preview a Library ENTRY** (an entry lives in the store, not on a skeleton):
```ts
// Use any character in the scene as the stand-in rig (e.g. the selected/player body).
const clipId = sm.applyLibraryEntry3D(entry.id, standInSkeletonId);      // retargets the entry onto the rig
if (clipId) {
  const preview = await sm.captureAnimationPreview3D(standInSkeletonId, clipId, { frames: 24, size: 192 });
  // preview.frames → play as a loop in the library card
}
```
A **static** thumbnail is just `frames: 1`. Poses (`kind: 'pose'`) preview too — apply the pose, then capture with
`frames: 24` for a rotating still (or 1 for a flat thumbnail).

**Perf / UX notes for the host:**
- Capturing is real GPU rendering (~`frames` render+readbacks), so do it **lazily** — when a card scrolls into view
  or on hover — not for the whole library at once. Cache the returned frames (they're plain data URLs; persist them
  as the entry's thumbnail if you like).
- Keep `size` modest for cards (128–256) and `frames` around 16–24 for a smooth-enough loop at low cost.
- It runs against the live 3D scene, so call it when a 3D scene exists and a stand-in skeleton is available.

Still open (spec §8): GLB clip import, app-global (OPFS) library, reference-semantics entries.
