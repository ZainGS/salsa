/**
 * Skeleton animation utilities — apply SkeletonAnimClip keyframes
 * to a Skeleton3D at a given frame number.
 *
 * GPU-free module: can be called from anywhere (scene manager,
 * ShapeManager callbacks, tests).  After calling
 * applySkeletonClipAtFrame(), the skeleton's skinMatrices are current
 * and Renderer3D.drawSkinnedMeshes() picks them up automatically.
 */

import { quat } from 'gl-matrix';
import type { SkeletonAnimClip, JointKeyframe } from '../../types/armature-3d';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';

// ── Internal helpers ────────────────────────────────────────────────────────

/** Linear interpolation between two same-length value arrays. */
function lerpValues(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + (b[i] - v) * t);
}

/**
 * Find the two surrounding keyframes for a given frame and return [lo, hi, t].
 * t = 0 → fully lo, t = 1 → fully hi.
 */
function sampleKeyframes(
  keyframes: JointKeyframe[],
  frame: number,
): [JointKeyframe, JointKeyframe, number] {
  if (keyframes.length === 1) return [keyframes[0], keyframes[0], 0];

  const first = keyframes[0];
  const last  = keyframes[keyframes.length - 1];

  if (frame <= first.frame) return [first, first, 0];
  if (frame >= last.frame)  return [last,  last,  0];

  for (let k = 0; k < keyframes.length - 1; k++) {
    const lo = keyframes[k];
    const hi = keyframes[k + 1];
    if (frame >= lo.frame && frame <= hi.frame) {
      const range = hi.frame - lo.frame;
      const t     = range > 0 ? (frame - lo.frame) / range : 0;
      return [lo, hi, t];
    }
  }

  return [last, last, 0];
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply a SkeletonAnimClip at `frame` to `skeleton` and recompute world
 * matrices + skin matrices.  Call this inside an AnimationPlayer3D.onFrame
 * handler to drive skeletal animation.
 *
 * Interpolation: quaternion slerp for 'rotation', linear for 'translation' / 'scale'.
 */
export function applySkeletonClipAtFrame(
  clip: SkeletonAnimClip,
  skeleton: Skeleton3D,
  frame: number,
): void {
  const { joints } = skeleton.data;

  for (const track of clip.tracks) {
    const joint = joints[track.jointIndex];
    if (!joint || track.keyframes.length === 0) continue;

    const [lo, hi, t] = sampleKeyframes(track.keyframes, frame);

    switch (track.channel) {
      case 'rotation': {
        const out = new Float32Array(4);
        quat.slerp(
          out as unknown as quat,
          lo.value as unknown as quat,
          hi.value as unknown as quat,
          t,
        );
        joint.localRotation = [out[0], out[1], out[2], out[3]];
        break;
      }
      case 'translation': {
        const v = lerpValues(lo.value, hi.value, t);
        joint.localPosition = [v[0], v[1], v[2]];
        break;
      }
      case 'scale': {
        const v = lerpValues(lo.value, hi.value, t);
        joint.localScale = [v[0], v[1], v[2]];
        break;
      }
    }
  }

  skeleton.computeWorldMatrices();
}
