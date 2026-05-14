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

/** A named skeletal animation clip. */
export interface SkeletonAnimClip {
  name: string;
  startFrame: number;
  endFrame: number;
  fps: number;
  tracks: SkeletonKeyframeTrack[];
}
