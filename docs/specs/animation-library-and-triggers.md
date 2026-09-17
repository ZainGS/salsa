# Animation Library & Animation Triggers

**Date:** 2026-09-16 · **Status: SPEC ONLY — nothing built.**
**Origin:** Play-mode walkaround testing surfaced the need for user-authored walk/run/etc. clips on the
Player avatar without hardcoding clip content or names engine-side. The user's framing (correct, and
industry-validated): *author animations once in Armature Mode → promote them to a reusable Library →
apply to any future creature/object → drive them with a trigger/blending system.*

**Industry model this follows:** Godot 4's `AnimationLibrary` (shareable named-clip resource) +
bone-map retargeting, and Unity's Animator (parameter-conditioned transitions with crossfade). We
deliberately do **NOT** build a second flowchart: Salsa's UI System state machine already *is* the
trigger graph (states, transitions, spatial triggers, variables, `playAnimation` actions); this spec
extends its animation vocabulary instead of adding a parallel Animator asset. Blend *trees* / 2D
blend spaces are out of scope (see §8).

---

## 1. What already exists (the foundation — verified 2026-09-16)

| Primitive | Where | Notes |
| --- | --- | --- |
| Clip authoring | Armature Mode → `SkeletonAnimClip` on `skeleton.data.clips` | Tracks are **joint-NAME-keyed** (+ `ikTracks`, `fps`, `startFrame/endFrame`, `region?` tag) — name-keying is what makes a library possible. `types/armature-3d.ts`. |
| **Retargeting** | `sm.retargetSkeletonClip3D(clipId, targetSkeletonId) → newClipId` | Joint-name matching, warns per missing joint. The hardest prerequisite — already done. |
| Clip playback | `sm.playSkeletonClip3D` / `AnimationPlayer3D` | Player has `loop` and an **on-finished hook** (fires when `loop=false` playback ends) — the seed of `animationFinished`. |
| Crossfade | NLA segment `fadeIn/fadeOut` weights + `crossfade3D()` | `scene3d-animation.ts`. Simple clip-player crossfade (§5.2) will mirror this weight-ramp approach. |
| Trigger graph | UI System state machine (`ui-types.ts`, `ui-state-machine.ts`) | Triggers incl. `enterVolume` / `exitVolume` / `interact` / `keyPress` / `variable` / `timer` / gamepad; actions incl. `playAnimation {targetId, clipId?, loop?}` (resolves clip by **id or name**, resumes same-clip, `stopAnimation`/`pause`/`seek` exist). |
| Movement params | `CharacterController.locomotion()` → `{planarSpeed, moving, grounded, airborne, rising}` | Already drives `LocomotionClipDriver` + name-agnostic `sm.setPlayerAnimation3D(clips, handler)`. |
| Library persistence precedents | Brush presets (`exportAllBrushPresets`/`importBrushPresets` JSON), `KitbashLibrary`, `TextureLibrary` | The document-payload + JSON-export pattern to copy. |
| Pose Library | per-skeleton `data.poses` + region filtering | Gets the same promote/apply treatment as clips (cheap rider). |

★ **Key correction from the discussion:** nothing engine-side hardcodes clip names — `playAnimation`
and `setPlayerAnimation3D` already take arbitrary names. The gap is (a) clips are trapped inside the
skeleton that authored them, and (b) the trigger vocabulary lacks crossfade/finish/movement-params.

---

## 2. Goals / non-goals

**Goals**
1. Promote authored clips (and poses) from skeleton-local storage to a named, reusable **Animation
   Library**; apply any library entry to any skeleton via the existing retarget path.
2. Library survives save/reload with the document, and exports/imports as JSON across documents
   (brush-preset pattern). App-global library later (§8).
3. Extend the UI state machine so animation control matches Unity-Animator expressiveness for our
   scope: **crossfade durations, one-shot chaining (`animationFinished`), movement-parameter
   conditions**.
4. Locomotion clip slots (idle/walk/run/jump/fall) become a per-character **binding picked from the
   library in UI**, not code — with an engine-side default handler so the host writes zero playback
   glue.

**Non-goals (v1):** 2D blend spaces / blend trees beyond a single crossfade; per-bone layer masks
(the `region` tag is the future seed); motion matching; GLB/Mixamo clip import (separate concern —
kitbash pipeline); editing clips *in* the library (edit on a skeleton, re-promote).

---

## 3. Phase A — Animation Library

### 3.1 Data model

```ts
/** One library entry — a clip lifted out of any particular skeleton. */
interface AnimLibraryEntry {
  id: string;                    // fresh UUID (NOT the source clip id)
  name: string;                  // unique within the library (promote dedupes: "Walk (2)")
  kind: 'clip' | 'pose';
  clip?: SkeletonAnimClip;       // deep copy; tracks stay joint-name-keyed — this IS the portability
  pose?: SkeletonPose;           // for kind 'pose'
  jointManifest: string[];       // joint names the entry animates (compat check + UI warning)
  sourceRig?: string;            // informational: e.g. 'procedural_body_19' | skeleton name
  tags?: string[];               // e.g. ['locomotion'], ['gesture'] — host filtering
  defaultLoop?: boolean;         // hint for apply/play UIs
}

interface AnimationLibraryData { version: 1; entries: AnimLibraryEntry[]; }
```

- New module `src/services/managers/animation-library.ts` — pure store + (de)serialize + the
  promote/apply orchestration via injected scene3d hooks (unit-testable without GPU, mirroring
  `Scene3DGrouping`'s host-interface pattern).
- **Copy semantics** (Godot-style assign-by-value): promote deep-copies the clip out; apply
  deep-copies in (via retarget). Skeletons stay self-contained → zero changes to skeleton
  persistence, undo, or the C4 animation subsystem. Reference-with-overrides is future work (§8).

### 3.2 Facade API (all on `sm`)

| API | Behavior |
| --- | --- |
| `addClipToLibrary3D(clipId, opts?: {name?, tags?}) → entryId` | Finds the clip on whichever skeleton owns it (existing clip-registry walk), deep-copies + builds `jointManifest` from its tracks. |
| `addPoseToLibrary3D(skeletonId, poseId, opts?) → entryId` | Same for poses. |
| `getAnimationLibrary3D() → AnimLibraryEntry[]` | Copies, for the host panel. |
| `applyLibraryEntry3D(entryId, targetSkeletonId, opts?: {rename?}) → newClipId \| newPoseId \| null` | Clip path: instantiate the entry as a temp clip and reuse `retargetSkeletonClip3D`'s joint-name matching core (refactor its inner loop into a shared `retargetClipData(clip, targetSkeleton)` so no fake source skeleton is needed). Pose path: same matching over rotations. Returns null + warn when **zero** joints match; partial matches apply with the existing per-joint warnings. |
| `removeLibraryEntry3D(entryId)` / `renameLibraryEntry3D(entryId, name)` | Bookkeeping. |
| `libraryCompatibility3D(entryId, skeletonId) → {matched, missing: string[]}` | Pre-flight for the host UI ("18/19 joints match"). |
| `exportAnimationLibrary3D() → string` / `importAnimationLibrary3D(json, {merge?: boolean}) → entryIds` | Brush-preset pattern. Import dedupes by name (suffix), never by id (fresh ids on import). |

### 3.3 Persistence

- Document save: new optional payload field `animationLibraryJSON` (serialize on gather, restore
  before the scene3d pass; absent in old saves → empty library). Follows `brushPresetsJSON`
  end-to-end (gather → manifest-adjacent payload → restore).
- ★ Registries-on-load rule applies (see `project_persistence_bug_family_2026_09` memory): the
  library store must be **cleared in `DocumentStateCoordinator.restore`** alongside packaging/decals
  before the incoming library is loaded.
- P6 round-trip drive gains a library entry in its scene (save→load→save equivalence must hold).

### 3.4 Host UI (Frogmarks — documented in a new `docs/ui/animation-library.md` when built)

- **Armature Mode / Clips panel:** "＋ Add to Library" per clip row; "Library" tab listing entries
  (name, tags, joint count, source rig) with Apply-to-selected-skeleton, rename, delete,
  export/import buttons. Compatibility chip from `libraryCompatibility3D` before Apply.
- **Character/Play panel:** the Phase B locomotion binding picker (§5.4).

### 3.5 Acceptance criteria (Phase A)

- Author a clip on character A in Armature Mode → Add to Library → create character B →
  Apply → clip plays on B identically (19-joint rig: lossless). Harness drive proves the joint
  rotations animate on B.
- Save → reload: library intact; steady-state persistence drive unchanged.
- Export JSON in doc 1 → import in doc 2 → apply works.
- Applying a hand-authored clip to a rig missing joints applies partially with warnings and
  `libraryCompatibility3D` predicts the miss count.

---

## 4. Phase B — Animation Triggers (extend the existing state machine)

★ **Design decision: no second flowchart.** Unity ships a separate Animator asset; we instead grow
the UI System machine (its Frogmarks graph editor is UI-System Phase 5, already planned). One
machine = spatial triggers, game logic, UI, and animation share variables and one mental model.

### 4.1 `playAnimation` gains crossfade + finish semantics

```ts
| { type: 'playAnimation'; targetId: string; clipId?: string; loop?: boolean;
    blendFrames?: number }          // NEW: crossfade duration from whatever is currently playing
```

- Implementation: `_uiPlayAnimation` currently destroys the old player and starts fresh. With
  `blendFrames > 0`, keep BOTH players alive for the window and weight-ramp old 1→0 / new 0→1
  (mirror the NLA `fadeIn/fadeOut` math; the pose write becomes a weighted mix for the window,
  then the old player is destroyed). v1 blends only within the same skeleton target.
- ★ Joint-write ordering: two players posing one skeleton must combine, not fight — route the blend
  through a single combiner tick (the NLA compositor already solves this shape; reuse its weighting,
  don't invent a second mixer).

### 4.2 New trigger: `animationFinished`

```ts
| { type: 'animationFinished'; targetId: string; clipId?: string }   // clipId optional = any clip on target
```

- Backed by `AnimationPlayer3D`'s existing finished hook (`loop=false` end-of-clip). `_uiClipPlayers`
  wires the hook → `UIManager.animationFinished(targetId, clipId)` → machine dispatch.
- Unlocks the montage pattern: `interact:chest → playAnimation Open (loop:false, blend 6)` then
  `animationFinished:Open → goToState opened`.

### 4.3 Auto-published player parameters (Unity-style conditions)

While Play mode runs, the Play loop publishes read-only machine variables each fixed tick (cheap —
values already computed by `locomotion()`):

| Variable | Source |
| --- | --- |
| `player.speed` (number) | `planarSpeed` |
| `player.moving` / `player.grounded` / `player.airborne` / `player.rising` (booleans) | same |

Existing `variable` triggers/conditions then express "when `player.speed > 2.2` crossfade to Run" —
no new trigger type needed. ★ Namespaced with `player.` and skipped by variable persistence.

### 4.4 Locomotion clip binding from the library (kills the hardcoding concern for good)

- New: `sm.setPlayerLocomotionSet3D({ idle?, walk?, run?, jump?, fall? })` where each value is a
  **library entry id or clip name**. Engine resolves each against the bound avatar's skeleton
  (applying from the library on demand if the skeleton lacks the clip), then self-wires
  `setPlayerAnimation3D` with an **engine-provided handler** that plays via the `_uiPlayAnimation`
  path with a small default `blendFrames` — so walk/run transitions crossfade out of the box and
  the host writes zero playback code.
- Persisted per-document next to the player binding (`playerObjectId3D` save location).
- The slots stay the fixed locomotion five ON PURPOSE — they're the controller's motion states, not
  an animation list. *Every other* animation is unlimited via the library + state machine
  (`N` animations = `N` library entries + transitions, no engine edits — the user's requirement).
- Host UI: five dropdowns (filtered to `tags:['locomotion']` first) in the Character/Play panel.

### 4.5 Acceptance criteria (Phase B)

- Chest demo entirely in data: interact → one-shot clip with crossfade → `animationFinished` →
  state change. No host code.
- Walk/run: bind library clips to the locomotion set → moving crossfades idle↔walk, speed past
  threshold crossfades walk↔run (drive asserts the active clip + a mid-blend mixed pose exists).
- `player.speed`-conditioned transition fires while walking (harness).
- All existing UI-machine tests keep passing (additive vocabulary only).

---

## 5. Testing plan

- **Unit (GPU-free):** animation-library store (promote/apply/dedupe/manifest/compat/import-export);
  retargetClipData refactor keeps existing retarget tests green; crossfade weight math; trigger
  matching for `animationFinished`; locomotion-set resolution.
- **Harness drives:** `drive-animlib.js` (author→promote→apply→plays on second character;
  save/reload; export/import), `drive-animtrig.js` (crossfade visible as mixed pose mid-blend;
  finished-chaining; `player.speed` condition during Play — reuses drive-playdir's input feeding).
- Extend `drive-persist.js` scene with a library entry.

## 6. Risks / gotchas

- ★ Two-player blend on one skeleton (§4.1) is the only genuinely new runtime math — reuse the NLA
  weighting; do NOT write a second mixer.
- ★ Clip ids: library entries mint fresh ids at promote/apply/import — never reuse source ids
  (id collisions across documents/skeletons; same rule the retarget already follows).
- ★ `_uiResolveClip` resolves by name OR id — library `name` collisions with skeleton-local clip
  names are therefore user-visible; promote-time dedupe (§3.1) plus apply-time `rename?` keep this
  manageable.
- Default-animation backfill (Breathe etc.) must NOT auto-promote into the library (noise); the
  library is user-curated.

## 7. Suggested build order

1. **A1:** library store + promote/apply (retarget refactor) + facade + unit tests.
2. **A2:** persistence (+ registry-clear on load) + export/import + P6 rider + `drive-animlib`.
3. **B1:** `animationFinished` + `blendFrames` crossfade (+ unit/harness).
4. **B2:** `player.*` variables + `setPlayerLocomotionSet3D` + `drive-animtrig`.
5. Host docs (`docs/ui/animation-library.md` + play-mode.md/ui-system.md updates) ride each phase.

## 8. Future (explicitly deferred)

App-global library (OPFS, cross-document, kitbash-library-shaped) · reference-semantics entries with
per-character overrides · 1D blend trees (walk↔run continuous mix by `player.speed` — the weight
plumbing from §4.1 is the prerequisite) · per-region layer masks (clips already carry `region`) ·
GLB animation import into the library · library thumbnails (pose-frame capture).
