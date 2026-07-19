# Pose-Driven Character Animation — Spec

**Status:** core built (capture + girth-blend + base idle); idle-break system + auto-blink built 2026-06-30; pose library being captured. **Engine:** `scene3d-manager.ts`, `default-animations.ts`, `eye-generator.ts`. **Host:** Frogmarks (UI). **Constraint:** `npx tsc --noEmit` only — never `npm run build`.

## 1. The core idea
**You don't author animations directly — you capture POSES, and animations are SEQUENCES of poses** the clip system slerps between. ~90% of the work is the pose library; once a pose exists it's reused across many animations (Relaxed is the return pose for almost everything; the walk poses build walk + run + sneak). This makes a BotW/Animal-Crossing-class animation set tractable for a procedural, any-body character creator: capture a vocabulary of poses, sequence them into clips.

The full pose + animation roadmap lives in [docs/armature-reference/pose-animation-catalog.md](../armature-reference/pose-animation-catalog.md); captured poses + their body context are catalogued in [docs/armature-reference/](../armature-reference/README.md).

## 2. Capturing a pose
Pose the character in Edit Armature (FK or IK), then:
- `shapeManager.exportPoseData3D()` → per-joint quaternion + Euler° for every joint off rest (effective FK/IK rotation).
- `shapeManager.exportBodyData3D()` → body params (mesh shape) + rest bone lengths.

Wire one **"Copy pose + body for Claude"** button (`pose + '\n\n' + body` → clipboard). Claude bakes the exact quaternions into `default-animations.ts` (poses) or a clip keyframe. This replaces authoring arm angles blind — the rotation conventions are unintuitive (e.g. a hand-on-hip elbow bend lives on Z, not the Y you'd guess).

## 3. Body adaptation — capture cost per pose
A pose's rotations don't all generalize across bodies the same way:
- 🟢 **Orientation** (wave, point, cheer, stretch, breathe, look) — body-INDEPENDENT. "Arm up" is the same rotation on any body. **1 capture.**
- 🟡 **Hand-on-body** (hands on hips, scratch head, thinking) — body-DEPENDENT. A fixed rotation lands the hand at a spot set by the body's width, so it clips/floats on different bodies. **Capture 2 (thin + fat)**; the engine blends them.
- 🔵 **Leg/ground** (sit, kneel, walk, crouch) — depends on leg length / hip height. **Capture 2 (short + tall)**; some need foot-planting (future).

### 3.1 Girth-blend (the hand-on-body adaptation) — IMPLEMENTED
`SkeletonPose.adaptive = { metric: 'girth', samples: [{ at, left }] }` (serialized). Each sample is a LEFT-arm capture at a known **girth = `torsoThick + hipWidth`**; the right arm is mirrored `[x,-y,-z,w]`. On `applyPose`, `_applyAdaptivePose` reads the body's girth, **slerps the two bracketing samples** (clamped outside the range) and writes the arm joints. Endpoints are exact captures, in-betweens are smooth — far more reliable than IK (which, for redundant hand-on-body targets, picks awkward solutions: an early IK attempt splayed the arms straight out). Observed pattern: girth ↑ → shoulder abducts LESS, elbow bends MORE. Add a 3rd sample only if the mid-range drifts. Different poses may key off a different metric (scratch-head → head size + arm reach); the metric is per-pose.

## 4. Animations = keyframed clips of poses — IMPLEMENTED (clip system)
A clip (`SkeletonAnimClip`) is per-joint rotation keyframes; the animator slerps between them. So an animation is just poses placed at frames:
- **Wave** = Relaxed → Wave → (hand oscillation) → Relaxed.
- **Walk** (loop) = Contact-L → Passing → Contact-R → Passing.
- **Sit down** = Stand → Crouch → Sit → (Sit-idle loop).
- **Jump** = Crouch → Launch → Airborne → Land.
For repetitive motion (wave, clap, walk) only the KEY poses are captured; the oscillation/in-betweens are synthesized. Clips can be retargeted, layered on NLA tracks, and adaptive poses can seed adaptive keyframes.

## 5. The idle system — "alive even when idle"
Two layers:
### 5.1 Base idle (always-on) — IMPLEMENTED
`setIdleAnimation3D(bodyMeshId, on)` runs procedural breathing + weight-shift + look-around (no clips). Drives lumbar/spine/chest/neck/head/shoulders (NOT the root, so feet stay planted), layered on the captured base pose; hair/chains swing with it. See [project_procedural_idle].

### 5.2 Idle breaks (random one-shots) — IMPLEMENTED
This is the BotW "alive" multiplier. Between the base idle, every `[minSec, maxSec]` (small random range) fire a random **one-shot break clip** (Stretch, Scratch Head, Hands-on-Hips, Yawn, Arms-crossed, Look-around…), then settle back to the base idle. API `setIdleBreaks3D(bodyMeshId, { enabled, minSec, maxSec, clips })` — `clips` defaults to the one-shot personality clips installed on the skeleton (pose-agnostic: any one-shot clip you add becomes an eligible break). A break drives the joints it animates while the **base idle keeps breathing on the untracked joints** (legs, the far arm), and **crossfades** in/out (per-joint slerp, ~0.25 s ease) so it blends rather than cuts. Springs stay alive across both.

## 6. Auto-blink (eyes) — IMPLEMENTED
Built on the existing blink driver (a `setTimeout` scheduler that flashes a "blink" expression; the procedural eye renders a closed eye via `EyeParams.closed`). `FaceBlinkConfig` (persisted) extended with:
- `enabled` — master toggle (eye-settings checkbox).
- `minSec` / `maxSec` — **blink frequency** as a small RANDOM range (irregular = natural; e.g. 2.5–6 s).
- `holdMs` — **blink speed** = how long the eyes stay closed (e.g. ~110 ms).
- `doubleProbability` (0–1) — chance the blink is a **double blink**.
- `doubleGapMinMs` / `doubleGapMaxMs` — random gap between the two blinks of a double.

`setAutoBlink3D(bodyMeshId, opts)` toggles + configures, and **auto-ensures a closed-eye blink expression** for procedural eyes (creates one from the active eye params with `closed: true`) so the toggle "just works." `_fireBlink`: show closed → hold `holdMs` → open; with `doubleProbability`, schedule a second blink after a random `[doubleGapMin, doubleGapMax]` gap before resuming the normal interval. `enabled:false` cancels the scheduler. Refinements worth doing later: asymmetric close/open easing (close faster than open), and blink-on-gaze-shift (people blink when they look away).

## 6.5 Squash & stretch (procedural appeal) — IMPLEMENTED
A volume-preserving **squash/stretch** that makes any animation less rigid — built as a global toggle, not per-clip authoring (Option B). `setSquashStretch3D(bodyMeshId, { enabled, intensity })`. Each frame, in the idle/break finalize (`_finishIdleRig`), it measures the body's **vertical span** (highest non-hair joint − lowest) on the CLEAN pose (scale reset first, so the signal can't feed back), compares to the rest span (lazily calibrated on enable), and applies a volume-preserving torso scale to `lowerback`+`spine`: `Y = clamp(1 + (ratio−1)·intensity, 0.88, 1.15)`, `X/Z = 1/√Y`. So **reach/arms-up → stretch** (taller + thinner — the Stretch clip registers because the raised hands extend the span), **crouch → squash** (shorter + wider). It auto-returns because it's derived from the live pose. Requires the base idle ON (it applies in that loop; generalizing to the clip-player path is a follow-up). Caveat: non-uniform torso scale + raised arms can shear → keep `intensity` subtle (default **0.06** — 0.05 read well in testing; ~0.04–0.12 range, clamped). This is the reusable appeal trick (jump-land squash, idle breathing scale, …).

## 7. Why this scales
- **Poses are shared** across animations → the library is the investment, animations are cheap sequencing.
- **Adaptive poses** mean one captured pose covers the whole body-shape range (2–3 captures).
- **Procedural layers** (idle, idle-breaks, blink, spring hair) run on top of any pose/clip for free secondary life.
- Capture order: Tier-1 poses → idle-break system (done) → Tier-2/3 as the game needs.

## 8. Open items / roadmap
- Capture the Tier-1 pose set (catalog) → wire idle-breaks to fire them.
- Leg/ground adaptation metric + foot-planting (IK) for sit/walk poses.
- Per-pose metric override (scratch-head etc.).
- Blink easing (asymmetric close/open) + gaze-linked blink.
