# Emotes — vector reaction/emotion overlays for characters (spec)

> **Status:** SPEC (not built). Phased A→C. Build order + integration points below.
> **Naming:** "**Emotes**" — deliberately distinct from face **Expressions** (the eye-decal textures:
> Neutral / Blink / procedural eyes, `_faceRigs`). Emotes = 2D symbols that float *near* the character to
> convey emotion; Expressions = the face itself. Do not overload "expression."

## 1. Goal
Animal-Crossing / anime reaction symbols that pop above or beside a character — sweat drop, anger vein,
sparkle, music notes, "!"/"?", dizzy swirl, steam puffs, hearts, ellipsis "…", lightbulb. They read emotion
instantly for almost no cost, extending the "characters feel alive" thread (idle sway, blinking) with
*reactive* liveliness. Triggered manually, **bound to a frame of an animation clip**, or fired on idle.

## 2. Vector-only (decided)
Emotes are authored + stored as **vector** (paths/primitives + procedural animation), never raster sprite
sheets. Rationale: tiny storage (bytes vs KB–MB of frames — consistent with the params-only save philosophy),
resolution-independent crispness, and procedural transform animation *is* the AC emote style. Trade-off
accepted: no painterly/photographic emotes (not wanted). Vectors are **rasterized on demand** to a small
billboard texture for display (§4) — vector is the source of truth + what persists; pixels are generated,
never saved.

## 3. Data model
An **Emote** = vector art + a procedural animation + an anchor. Small, declarative, library-friendly (mirrors
the pose / clip / hair-style preset pattern).

```ts
interface Emote {
  id: string;
  name: string;                    // 'Sweat', 'Anger', 'MusicNote', 'Question', 'Dizzy', 'Hearts', …
  symbol: EmoteSymbol;             // the vector art (a built-in id in P1, or custom paths in P3)
  palette: string[];               // fill/stroke colours (tint the symbol; e.g. blue drop, red vein)
  anchor: EmoteAnchor;             // where it sits on the character
  size: number;                    // world units at scale 1 (e.g. 0.12 of head height)
  duration: number;                // seconds for one play; loop=true → repeats until stopped
  loop: boolean;
  instances: EmoteInstance[];      // 1..N copies (e.g. 3 staggered music notes); P1 kit uses a `behavior` shorthand (§3.1)
}

interface EmoteAnchor {
  joint: string;                   // skeleton joint the emote tracks (its WORLD position): 'head' | 'neck' | 'hand_R' | …
  offset: [number, number, number];// WORLD-space offset from that joint — mostly +Y so it sits ABOVE the head IN 3D
                                   //   (world-up, NOT screen-up; stays above as the character moves/turns)
  faceCamera: boolean;             // billboard: always faces the camera, but POSITION stays world-anchored. Always true.
}

interface EmoteInstance {          // one copy of the symbol with its own motion
  spawnAt: number;                 // 0..1 normalized spawn time (stagger multiple copies)
  tracks: {                        // keyed over normalized local time 0..1 (see EmoteTrack)
    pos?:     EmoteTrack;          // 2D offset in the billboard plane (units of `size`)
    rot?:     EmoteTrack;          // degrees
    scale?:   EmoteTrack;          // multiplier
    opacity?: EmoteTrack;          // 0..1
  };
}
type EmoteTrack = { t: number; v: number | [number, number] }[];  // few keyframes, linear/eased between
```

### 3.1 P1 shorthand — `behavior`
Authoring full `instances`/`tracks` by hand is the expensive part. The **built-in kit uses named
behaviors** so an emote is one line of data:

```ts
type EmoteBehavior =
  | 'pop-fade'   // scale 0→1 bounce-in, hold, fade out           (sparkle, "!", lightbulb)
  | 'drip'       // pop in, slide down, fade                       (sweat)
  | 'float-up'   // spawn low, rise + drift + fade (N staggered)   (music notes, hearts, steam)
  | 'pulse'      // scale oscillate + hold, fade                   (anger vein)
  | 'spin'       // continuous rotate + bob (loop)                 (dizzy swirl)
  | 'blink-in';  // 2-state flash                                  ("?", ellipsis)
```
A behavior is a factory that produces `instances`/`tracks` from `{ count?, amount?, speed? }`. Custom emotes
(P3) can drop the shorthand and key `tracks` directly — same runtime.

## 4. Rendering — billboard-in-3D (reuse the eye-decal path)
Each active emote is a **camera-facing billboard quad** positioned at `anchorJointWorldPos + offset`, textured
with the rasterized vector symbol. This composites correctly in the 3D scene, moves with the character for
free, and needs no screen-space reprojection.

- **Vector → texture:** render `symbol` (+ palette) to a small Canvas2D (e.g. 256²) and upload — the SAME
  pattern as `eye-generator.ts` / `_renderEyeParamsToTexture` (canvas draw → `copyExternalImageToTexture`).
  Cache per (symbol, palette); most animation is transform-only so the texture is drawn ONCE, not per frame.
  Re-raster only for shape-changing emotes.
- **Billboard:** a dedicated `EmoteBillboardRenderer` (mirror `GhostPreviewRenderer` / the snap-viz billboard
  — camera-facing quad, depth-test on, alpha blend, drawn after the character). Instances = the live emote
  copies; per-instance the vertex shader applies `pos/rot/scale/opacity` from the tracks at the current local
  time. Anchor world pos comes from the skeleton joint (`skeleton.data.joints[i].worldMatrix`), like the decal.
- **Multi-instance (notes/steam):** N quads from one emote's `instances` — cheap. For *stochastic* emitters
  (endless steam) P3 can route through the existing `ParticleEmitter3D` instead.
- **Render style:** emotes ignore the character's cel/PBR style (they're flat unlit vector art). Not affected
  by `setRenderStyle*`.

## 5. Triggering
Three sources, all landing on one runtime `playEmote(bodyMeshId, emoteId)`:
1. **Manual / event:** `playEmote3D(bodyId, name)` — host fires it (button, hover, chat reaction). One-shot
   (or loop until `stopEmote3D`).
2. **Frame-bound (the requested feature):** an **event track** on a `SkeletonAnimClip` — `{ frame, emoteId }`.
   When the clip's playhead crosses `frame`, fire the emote. Reuses the existing clip/keyframe/timeline infra
   (`setCurrentFrame`, the clip player) — it's a new *event* keyframe type alongside the rotation tracks. This
   is how "the surprised swirl appears at frame 20 of the Talk clip" works.
3. **Idle (optional, P2+):** hook the idle-break scheduler (`_idleBreaks`) to occasionally fire a mood emote —
   free ambient liveliness, same mechanism as random idle-break clips.

Concurrency: a small active-emote list per body; a default cap (e.g. 3) + replace-oldest so triggers don't pile
up. `stopEmote3D(bodyId, name?)` clears one/all.

## 6. Authoring
- **Phase A — built-in kit only.** The classic set (§9) is defined in code as vector symbols + a behavior each.
  Zero authoring UI; instantly useful. This is ~80% of the value.
- **Phase C — custom vector authoring.** Reuse the existing 2D **vector shapes** (`shapeFactory`:
  Circle/Polygon/Line/Scribble/Path, SDFText for "!"/"?") on a small emote canvas → "Save as Emote" → pick a
  behavior (or key tracks) + anchor + palette → lands in the library. Mirrors how poses/clips/hair-styles are
  saved. The library IS the persisted unit.

## 7. Persistence
- **Emote definitions** ride the document (or a shared library) as JSON — vector paths + behavior/track params
  + anchor + palette. Tiny; gzips with the rest of `scene3d.json` (the new `writeText` gzip). No pixels saved.
- **Frame bindings** live on the clip as the event track → already inside `skeleton.toJSON` clips (extend the
  clip serialize with an `events?: {frame,emoteId}[]`, like `region`/`ikTracks`).
- **Built-in kit** is code, not saved (like default animations) — only *custom* emotes + *bindings* persist.
  Re-install/resolve built-ins by id on load (idempotent), same pattern as `installDefaultAnimations`.

## 8. Phasing & build order
- **Phase A — Kit + billboard + manual trigger.** `EmoteBillboardRenderer`, the vector→texture cache, the
  built-in kit with behaviors, joint-anchored camera-facing quads, `playEmote3D`/`stopEmote3D`. *Playable
  immediately, no authoring.* Highest value, reuses decal/billboard + eye-generator machinery.
- **Phase B — Frame binding + idle.** Event track on clips (`bindEmoteToClipFrame3D`), fire on playhead
  cross; optional idle-triggered mood emotes. This is the "bind to a frame" ask.
- **Phase C — Custom authoring + emitters.** Vector authoring via the 2D shape tools → emote library +
  persistence; stochastic emitters (steam) through `ParticleEmitter3D`. The expensive part, last, on a proven
  base.

## 9. Built-in kit (Phase A)
| Name | Symbol | Behavior | Anchor | Palette |
|---|---|---|---|---|
| Sweat | teardrop | drip | head (upper side) | pale blue |
| Anger | 4-spoke cross vein | pulse | head (temple) | red |
| Sparkle | 4-point star ×2 | pop-fade | head (above) | white/gold |
| MusicNote | eighth-note ×3 | float-up | head (side) | black/accent |
| Exclaim | "!" | pop-fade | above head | yellow |
| Question | "?" | blink-in | above head | white |
| Dizzy | swirl spiral | spin (loop) | above head | grey/blue |
| Hearts | heart ×3 | float-up | head (side) | pink/red |
| Steam | puff ×2 | float-up | head (top) | white |
| Ellipsis | "…" | blink-in | above head | grey |
| Idea | lightbulb | pop-fade | above head | yellow |

## 10. API surface
```ts
// scene3d-manager → shape-manager *3D wrappers
playEmote3D(bodyMeshId, emoteId, opts?: { loop?: boolean }): void
stopEmote3D(bodyMeshId, emoteId?): void
getEmoteNames3D(): string[]                     // built-in + custom
bindEmoteToClipFrame3D(clipId, frame, emoteId): void      // Phase B
unbindEmoteFromClipFrame3D(clipId, frame): void
addCustomEmote3D(emote: Emote): string          // Phase C
setEmoteAnchor3D(emoteId, anchor): void
```

## 11. Integration points (nothing is from-scratch)
- **Billboard render** → `GhostPreviewRenderer` / snap-viz billboard pattern; anchor via joint `worldMatrix`
  like the eye decal (`_buildFaceDecal`).
- **Vector → texture** → `eye-generator.ts` canvas→texture pattern (`_renderEyeParamsToTexture`).
- **Frame binding** → `SkeletonAnimClip` + the clip player + `setCurrentFrame` timeline (new event keyframe).
- **Idle firing** → `_idleBreaks` scheduler.
- **Multi-particle (P3)** → `ParticleEmitter3D` (`_particleEmitters`).
- **Custom authoring (P3)** → the 2D vector `shapeFactory` (Circle/Polygon/Line/Scribble/SDFText) + the
  save-to-library pattern of poses/clips/hair-styles.
- **Persistence** → rides `scene3d.json` (gzipped); bindings on clip JSON; built-ins resolved by id on load.

## 12. Decisions & open questions
**DECIDED (2026-07-01):**
- **Library scope:** ✔ **GLOBAL** shared library (like brush presets), with **per-document bindings**. A custom
  emote is authored once and available everywhere; each doc only stores *which* emote is bound to *which* clip
  frame.
- **Anchor space:** ✔ **WORLD-anchored** — the emote sits above the character's head **in the 3D world** (tracks
  the head joint's world position + a world-up `offset`; the billboard faces the camera but its *position* is
  world-space). NOT screen-space. It stays above the head as the character moves/turns and occludes/composites
  like any other 3D object.
- **Scale with distance:** ✔ **WORLD-SCALED** (`size` in world units) — the emote shrinks with the character /
  in a crowd, so it composites naturally. A per-emote override is allowed if a specific emote wants a fixed size.

**Still open:**
- **Sound hook:** emotes are a natural place to fire a SFX id later (out of scope here, but leave the seam).
