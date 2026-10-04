/**
 * Armature (skeleton) types for Phase A 3D rigging.
 *
 * A skeleton is a hierarchy of joints stored as a flat array
 * with parentIndex links. Joint indices are stable IDs.
 */

/**
 * Constraint applied to a joint after FK and IK are evaluated.
 * All constraint types are serialized as part of the joint in toJSON/fromJSON.
 */
export type JointConstraint =
  | { type: 'lookAt';       targetJointIdx: number; axis: 'x' | 'y' | 'z'; influence: number }
  | { type: 'copyRotation'; sourceJointIdx: number; influence: number }
  | { type: 'stretchTo';    targetJointIdx: number; influence: number; volumePreserve: number }
  // Clamp this joint's local rotation to a per-axis angle range (DEGREES; omit a bound for "free").
  // Used for anti-hyperextension hinges (elbows/knees) + locking twist on the off-axes.
  | { type: 'limitRotation'; minX?: number; maxX?: number; minY?: number; maxY?: number; minZ?: number; maxZ?: number; influence: number };

/** One joint in a skeleton hierarchy. */
export interface Joint3D {
  index: number;
  name: string;
  /** Index of the parent joint, or -1 for a root joint. */
  parentIndex: number;
  /** Indices of child joints (derived; used for traversal). */
  children: number[];
  localPosition: [number, number, number];
  /** Quaternion XYZW — local rotation relative to parent. */
  localRotation: [number, number, number, number];
  localScale: [number, number, number];
  /**
   * Visual tail tip offset in the joint's own local frame (i.e. applied through
   * worldMatrix). For leaf joints this defines the diamond-stick tip and the
   * draggable tail handle. Defaults to [0, 0.3, 0].
   */
  tailOffset: [number, number, number];
  /** World-space mat4 (16 floats), recomputed each frame. */
  worldMatrix: Float32Array;
  /** Inverse bind-pose mat4 (16 floats), constant after import. */
  inverseBindMatrix: Float32Array;
  /**
   * IK-solved local rotation for this frame (quaternion XYZW).
   * Written by the FABRIK solver; computeWorldMatrices uses this instead of
   * localRotation when present. Never serialized — ephemeral per-frame state.
   */
  ikRotation?: [number, number, number, number];
  /** Constraint-solved rotation (lookAt / copyRotation). Ephemeral — never serialized. */
  constraintRotation?: [number, number, number, number];
  /** Constraint-solved scale (stretchTo). Ephemeral — never serialized. */
  constraintScale?: [number, number, number];
  /** Per-joint constraints evaluated after FK and IK. Serialized in toJSON/fromJSON. */
  constraints?: JointConstraint[];
}

/** One IK chain on a skeleton. Stored in SkeletonData and serialized. */
export interface IKChain {
  /** Stable nanoid. */
  id: string;
  /** Index of the end-effector joint (e.g. hand, foot). */
  endJointIdx: number;
  /**
   * Number of bones in the chain. chainLength=3: end→parent→grandparent,
   * with great-grandparent as the fixed anchor.
   */
  chainLength: number;
  /** Current IK target world position — dragged by the user. */
  target: [number, number, number];
  /**
   * Optional pole vector target world position.
   * When set, the solver constrains intermediate joints to the plane defined by
   * (chain anchor, IK target, poleTarget), controlling which way the chain bends.
   */
  poleTarget?: [number, number, number];
  /**
   * FK/IK blend weight: 0 = pure FK (localRotation), 1 = pure IK (default).
   * Values in between slerp between localRotation and the FABRIK-solved rotation,
   * allowing smooth transitions between FK poses and IK-driven poses.
   */
  blendWeight: number;
  /** When false the solver skips this chain; joints fall back to FK. */
  enabled: boolean;
}

/**
 * One captured arm pose at a known body "girth", used to make a hand-on-body pose ADAPT to any body by
 * BLENDING real captured poses (vs IK-solving, which picks awkward solutions for redundant hand-on-body
 * poses). `left` holds the LEFT-arm joint rotations; the right arm is mirrored. Blended by body metric on apply.
 */
export interface AdaptivePoseSample {
  /** The body metric value this sample was authored at (see SkeletonPose.adaptive.metric). */
  at: number;
  /** Left-arm joint name → local rotation quaternion [x,y,z,w]. */
  left: Record<string, [number, number, number, number]>;
}

/**
 * Spatial REGION a pose/clip emphasises — for filtering the library by a Left/Right/Top/Bottom/Center
 * selector. `left`/`right` = that side/hand (wave right, kick left); `top` = head/upper (nod, stretch);
 * `bottom` = legs/lower (kick, crouch); `center` = whole-body / symmetric (idle, jump, hands-on-hips).
 */
export type AnimRegion = 'left' | 'right' | 'top' | 'bottom' | 'center';

/** A named snapshot of all joint FK rotations. Stored in SkeletonData and serialized. */
export interface SkeletonPose {
  id: string;
  name: string;
  rotations: { jointIndex: number; rotation: [number, number, number, number] }[];
  /** Spatial region for library filtering (Left/Right/Top/Bottom/Center). */
  region?: AnimRegion;
  /**
   * Optional body-adaptive arm blend: applying the pose slerps these samples by a body metric (`girth` =
   * torsoThick + hipWidth) and writes the result to the arm joints (left mirrored to right) — so a
   * hand-on-hip pose fits thin AND fat bodies without clipping. Endpoints are exact captured poses.
   */
  adaptive?: { metric: 'girth'; samples: AdaptivePoseSample[] };
}

/**
 * A collider the spring bones bounce off (the body). A SPHERE at `offset` from joint `jointIdx`, or a
 * CAPSULE from `offset` → `tail` (both in that joint's LOCAL frame) when `tail` is set, with `radius`.
 * Resolved to world space each frame via the joint's worldMatrix. Serialized in SkeletonData.
 */
export interface SpringCollider {
  /** Body joint this collider is parented to (head/chest/hips/…). */
  jointIdx: number;
  /** Sphere centre (or capsule start) in the joint's local frame. */
  offset: [number, number, number];
  /** Collision radius (world units). */
  radius: number;
  /** When set, the collider is a CAPSULE from `offset` → `tail` (local frame). */
  tail?: [number, number, number];
}

/**
 * A spring-bone chain — a run of joints simulated with damped-spring physics AFTER FK/IK/constraints each
 * frame, colliding against the skeleton's spring colliders. Rotation-ONLY (bones keep their rest length),
 * VRM-style: each bone springs back toward its FK/rest pose with inertia, drag, and gravity. Drives dynamic
 * hair tails / cloth / accessories. Stored in SkeletonData + serialized; ephemeral tip state lives in the solver.
 */
export interface SpringChain {
  /** Stable id. */
  id: string;
  /** Joint indices ROOT-first → tip. Each is simulated; the root's PARENT (not in the list) is the anchor. */
  jointIndices: number[];
  /** 0..1 — how strongly each bone springs back toward its rest (FK) pose each frame. */
  stiffness: number;
  /** 0..1 — velocity damping (higher = less swing, settles faster). */
  drag: number;
  /** Gravity magnitude (world units, per 60fps frame) along `gravityDir`. */
  gravity: number;
  /** Gravity direction (unit; usually [0,-1,0]). */
  gravityDir: [number, number, number];
  /** The hair's own thickness, added to every collider's radius. */
  hitRadius: number;
  /** When false the solver skips this chain (its joints stay at their FK pose). */
  enabled: boolean;
}

/** Full skeleton definition (joints list + name). */
export interface SkeletonData {
  name: string;
  /** Joints in topological order: parents always precede children. */
  joints: Joint3D[];
  /** Authored animation clips stored on this skeleton. */
  clips?: SkeletonAnimClip[];
  /** IK chains defined on this skeleton. */
  ikChains?: IKChain[];
  /** NLA tracks for multi-clip blending on this skeleton. */
  nlaTracks?: NLATrack[];
  /** Bind-pose snapshot the NLA evaluator blends from (persisted with the tracks — 2026-09-12 fix:
   *  tracks used to be pushed here at runtime but never serialized). Shape mirrors the
   *  skeleton-animator SkeletonPose (kept structural to avoid a types→renderer import). */
  nlaBindPose?: { rotations: [number, number, number, number][]; positions: [number, number, number][]; scales: [number, number, number][] };
  /** Saved FK poses (T-pose, A-pose, etc.). */
  poses?: SkeletonPose[];
  /** Spring-bone chains (dynamic hair/cloth) simulated after FK/IK/constraints each frame. */
  springChains?: SpringChain[];
  /** Colliders the spring bones bounce off (the body). */
  springColliders?: SpringCollider[];
}

/** Per-joint keyframe value. */
export interface JointKeyframe {
  frame: number;
  /** 3 floats for translation/scale; 4 floats (xyzw) for rotation. */
  value: number[];
}

/** Animation track for one joint, one channel. */
export interface SkeletonKeyframeTrack {
  jointIndex: number;
  channel: 'translation' | 'rotation' | 'scale';
  keyframes: JointKeyframe[];
}

// ── Armature Focus Mode Background ───────────────────────────────────────────

/**
 * Visual style for the background shown in armature editing focus mode.
 *
 * - 'wavy'     — animated domain-warped wave pattern (default; blue + cream)
 * - 'solid'    — flat single color (color1)
 * - 'gradient' — vertical gradient from color1 (top) to color2 (bottom)
 * - 'checkers' — kawaii green/yellow (color1/color2) checkerboard fading to white at the bottom,
 *                with slowly-spinning clover/flower motifs scattered through the cells
 * - 'dim'      — semi-transparent dark overlay drawn OVER the scene
 * - 'none'     — no background (scene visible as normal)
 * - 'sky'      — the stylised SKY DOME (visual-polish #9): a view-direction sky (zenith → horizon gradient, horizon
 *                glow, sun, moon + halo, stars, painted anime clouds) from `sky`; color1/color2 = the screen
 *                gradient it falls back to while its pipeline compiles or without a camera.
 */
export type ArmatureBgMode = 'wavy' | 'solid' | 'gradient' | 'checkers' | 'dim' | 'none' | 'sky';

type SkyC3 = [number, number, number];
/** The stylised SKY DOME's per-frame look (ArmatureBgMode 'sky'; src/renderer/3d/sky-dome-pass.ts). All colours are
 *  display values like the gradient's; directions point TOWARD the body (unit, Y up). Built per time of day by
 *  src/world/sky.ts `skyDomeParams` for the city; any host may fill it by hand. */
export interface SkyDomeParams {
    zenith: SkyC3;
    horizon: SkyC3;
    /** Below the horizon (the city's fog colour, so far geometry meets the backdrop with no seam). */
    ground: SkyC3;
    /** Horizon → zenith curve: t = 1 - (1 - up)^bias (larger = the zenith colour reaches lower; 3 ≈ the old screen
     *  gradient's look at street level, with a finite slope at the horizon so it never reads as a line). */
    gradientBias: number;
    /** Horizon GLOW band (city light pollution at night): colour, strength 0..1 and e-folding height in radians. */
    glowColor: SkyC3; glowAmount: number; glowHeight: number;
    sunDir: SkyC3; sunColor: SkyC3;
    /** Sun disc visibility 0..1 and the halo strength (both 0 = no sun drawn). */
    sunDisc: number; sunHalo: number;
    moonDir: SkyC3; moonColor: SkyC3;
    /** Moon visibility 0..1, angular RADIUS in radians, halo strength. */
    moon: number; moonSize: number; moonHalo: number;
    /** Star brightness 0..1 (0 = none). */
    stars: number;
    /** Painted cloud layer opacity 0..1 (0 = none); colours of the lit tops / shaded undersides / the bright rim. */
    clouds: number; cloudLit: SkyC3; cloudShade: SkyC3; cloudRim: SkyC3; cloudRimAmount: number;
    /** Toward the light the clouds take (sun by day, moon at night). */
    cloudLightDir: SkyC3;
    /** Added to the undersides of low clouds (the city glow at night). */
    cloudGlow: SkyC3;
    /** The cloud SHAPES: seed + coverage 0..1 (re-laid out only when these change) and the drift in rad/s. */
    cloudSeed: number; cloudCoverage: number; cloudDrift: number;
}

export interface ArmatureBgOptions {
    mode: ArmatureBgMode;
    /** Primary color [r, g, b, a] — background / top of gradient / wave color 1. */
    color1?: [number, number, number, number];
    /** Secondary color [r, g, b, a] — stripe / bottom of gradient / wave color 2. */
    color2?: [number, number, number, number];
    /** Darkness level for 'dim' mode, 0–1 (default 0.5). */
    dimStrength?: number;
    /** 'sky' mode: the dome's look (absent = the screen gradient). */
    sky?: SkyDomeParams;
}

/**
 * Keyframe track for one IK chain property inside a SkeletonAnimClip.
 * Values are linearly interpolated: vec3 for 'target'/'poleTarget', scalar for 'blendWeight'.
 */
export interface IKKeyframeTrack {
  /** ID of the IKChain this track belongs to. */
  chainId: string;
  /** Which IK chain property is animated. */
  property: 'target' | 'poleTarget' | 'blendWeight';
  /**
   * Keyframes — same structure as JointKeyframe.
   *   'target' / 'poleTarget' → value is [x, y, z]
   *   'blendWeight'           → value is [w]  (clamped to 0–1 on apply)
   */
  keyframes: JointKeyframe[];
}

// ── Non-Linear Animation (NLA) ───────────────────────────────────────────────

/**
 * A single clip placed on an NLA timeline.
 * The clip plays at NLA frame `startFrame`, running for the clip's full duration.
 */
export interface NLAClipSegment {
  /** References SkeletonAnimClip.id stored on the skeleton. */
  clipId: string;
  /** NLA timeline frame at which this segment begins. */
  startFrame: number;
  /**
   * How many frames into the clip to begin playback (default 0).
   * Useful for trimming the head of a clip on the NLA timeline.
   */
  clipStartOffset: number;
  /**
   * Blend contribution weight (0–1, default 1.0).
   * In replace mode: how strongly this segment overrides the pose below it.
   * In additive mode: how much of the delta to apply.
   */
  weight: number;
  /**
   * replace — blends this clip's pose into the accumulated result (crossfade, walk→idle).
   * additive — adds weighted deltas (clip pose − bind pose) on top of the replace result.
   */
  blendMode: 'replace' | 'additive';
  /** Frames over which weight ramps 0 → weight at the start of the segment (default 0). */
  fadeIn: number;
  /** Frames over which weight ramps weight → 0 at the end of the segment (default 0). */
  fadeOut: number;
}

/**
 * An NLA track: a named, ordered set of clip segments placed on a shared timeline.
 * One AnimationPlayer3D drives the track's frame clock; the NLA evaluator blends all
 * active segments each tick and writes the result to the skeleton.
 */
export interface NLATrack {
  /** Stable UUID. */
  id: string;
  name: string;
  /** ID of the Skeleton3D this track drives. */
  skeletonId: string;
  segments: NLAClipSegment[];
  /** Playback FPS for this track's clock (default 24). */
  fps: number;
  /** Whether the track loops back to frame 0 (default true). */
  loop: boolean;
}

/** A named skeletal animation clip. */
export interface SkeletonAnimClip {
  /** Stable UUID for registry lookup (required for authored clips). */
  id: string;
  name: string;
  /** Spatial region for library filtering (Left/Right/Top/Bottom/Center). */
  region?: AnimRegion;
  startFrame: number;
  endFrame: number;
  fps: number;
  tracks: SkeletonKeyframeTrack[];
  /** Locomotion cycle clips only (optional): the ground speed the clip's feet are planted for at playback rate 1, in
   *  the rig's local units per second. The Play-mode animator plays the clip at speed / groundSpeed so the feet don't
   *  skate (the runtime default gaits in default-locomotion.ts set it; authored clips usually don't). */
  groundSpeed?: number;
  /** Jump clips only (optional): the clip phase (0..1) where the feet leave the ground — the wind-up crouch plays
   *  before it, the air (by air phase) after it (the runtime default Jump sets it; authored clips don't = 0). */
  takeoffPhase?: number;
  /** Jump VARIANT clips only (optional, runtime default jumps): when the Play animator picks this variant — relative
   *  weights from a stand / walk / run and for a tap / hold, a mirrored-pair `family`, the leg that leads (`side`) and
   *  its own landing clip (`land`). See game/locomotion-animator.ts JumpVariantInfo. */
  jumpVariant?: { stand: number; walk: number; run: number; tap: number; hold: number; family?: string; side?: 'L' | 'R'; land?: string };
  /** Locomotion cycle clips only (optional, runtime default gaits): the cycle phases where the legs PASS each other
   *  (mid-stance of each leg) — the Play animator's settle step on a stop walks on to the nearest one while fading. */
  passPhases?: number[];
  /** IK chain property tracks (target, poleTarget, blendWeight). */
  ikTracks?: IKKeyframeTrack[];
  /** Optional FACE events for a procedural character's eyes, fired as playback crosses each frame: a gaze JUMP
   *  (eyes move in saccades, not glides — and each gaze change re-renders the eye texture, so a few discrete jumps
   *  are both realistic and cheap) and/or a blink. Gaze is an OFFSET from the character's gaze when the clip started;
   *  `restore` returns the eyes there. Clips without it play exactly as before. */
  faceTrack?: ClipFaceEvent[];
}

/** One face event in a clip — see SkeletonAnimClip.faceTrack. Gaze: x + = screen-right, y + = down (−1..1). */
export interface ClipFaceEvent {
  frame: number;
  gaze?: [number, number];
  blink?: boolean;
  /** Return the eyes to where they were when the clip started (and the face kit to its resting expression, if the
   *  clip changed it). */
  restore?: boolean;
  /** FACE KIT (face-features.ts): blend to an expression ('neutral' | 'smile' | 'open' | 'frown' | 'surprised', or
   *  'default' = the character's resting one). Ignored by faces without the kit. */
  expression?: string;
  /** 0..1 strength of `expression` (default 1). */
  weight?: number;
  /** A quick brow raise (brow-raise units, ~0.3–0.6). */
  browRaise?: number;
}
