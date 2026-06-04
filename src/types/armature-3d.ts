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
}

/** Full skeleton definition (joints list + name). */
export interface SkeletonData {
  name: string;
  /** Joints in topological order: parents always precede children. */
  joints: Joint3D[];
  /** Authored animation clips stored on this skeleton. */
  clips?: SkeletonAnimClip[];
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

/** A named skeletal animation clip. */
export interface SkeletonAnimClip {
  /** Stable UUID for registry lookup (required for authored clips). */
  id: string;
  name: string;
  startFrame: number;
  endFrame: number;
  fps: number;
  tracks: SkeletonKeyframeTrack[];
}
