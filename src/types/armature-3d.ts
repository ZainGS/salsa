/**
 * Armature (skeleton) types for Phase A 3D rigging.
 *
 * A skeleton is a hierarchy of joints stored as a flat array
 * with parentIndex links. Joint indices are stable IDs.
 */

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

/** Full skeleton definition (joints list + name). */
export interface SkeletonData {
  name: string;
  /** Joints in topological order: parents always precede children. */
  joints: Joint3D[];
  /** Authored animation clips stored on this skeleton. */
  clips?: SkeletonAnimClip[];
  /** IK chains defined on this skeleton. */
  ikChains?: IKChain[];
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
 * - 'dim'      — semi-transparent dark overlay drawn OVER the scene
 * - 'none'     — no background (scene visible as normal)
 */
export type ArmatureBgMode = 'wavy' | 'solid' | 'gradient' | 'dim' | 'none';

export interface ArmatureBgOptions {
    mode: ArmatureBgMode;
    /** Primary color [r, g, b, a] — background / top of gradient / wave color 1. */
    color1?: [number, number, number, number];
    /** Secondary color [r, g, b, a] — stripe / bottom of gradient / wave color 2. */
    color2?: [number, number, number, number];
    /** Darkness level for 'dim' mode, 0–1 (default 0.5). */
    dimStrength?: number;
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

/** A named skeletal animation clip. */
export interface SkeletonAnimClip {
  /** Stable UUID for registry lookup (required for authored clips). */
  id: string;
  name: string;
  startFrame: number;
  endFrame: number;
  fps: number;
  tracks: SkeletonKeyframeTrack[];
  /** IK chain property tracks (target, poleTarget, blendWeight). */
  ikTracks?: IKKeyframeTrack[];
}
