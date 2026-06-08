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
import type { SkeletonAnimClip, JointKeyframe, IKKeyframeTrack, NLATrack, NLAClipSegment } from '../../types/armature-3d';
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

// ── Pose snapshot helpers ────────────────────────────────────────────────────

/**
 * A lightweight per-joint pose snapshot used for NLA blending.
 * Indices correspond to skeleton.data.joints indices.
 */
export interface SkeletonPose {
  rotations: Array<[number, number, number, number]>;
  positions: Array<[number, number, number]>;
  scales:    Array<[number, number, number]>;
}

/** Snapshot the skeleton's current joint local transforms into a SkeletonPose. */
export function snapshotSkeletonPose(skeleton: Skeleton3D): SkeletonPose {
  const { joints } = skeleton.data;
  return {
    rotations: joints.map(j => [...j.localRotation] as [number,number,number,number]),
    positions: joints.map(j => [...j.localPosition] as [number,number,number]),
    scales:    joints.map(j => [...j.localScale]    as [number,number,number]),
  };
}

/**
 * Sample a clip at `frame` and return a pose snapshot.
 * Joints not covered by any clip track fall back to `bindPose` values.
 * Does NOT mutate the skeleton.
 */
function sampleClipPose(
  clip: SkeletonAnimClip,
  bindPose: SkeletonPose,
  frame: number,
): SkeletonPose {
  const result: SkeletonPose = {
    rotations: bindPose.rotations.map(r => [...r] as [number,number,number,number]),
    positions: bindPose.positions.map(p => [...p] as [number,number,number]),
    scales:    bindPose.scales.map(s    => [...s] as [number,number,number]),
  };

  for (const track of clip.tracks) {
    if (track.keyframes.length === 0) continue;
    const [lo, hi, t] = sampleKeyframes(track.keyframes, frame);
    switch (track.channel) {
      case 'rotation': {
        const out = new Float32Array(4);
        quat.slerp(out as unknown as quat, lo.value as unknown as quat, hi.value as unknown as quat, t);
        result.rotations[track.jointIndex] = [out[0], out[1], out[2], out[3]];
        break;
      }
      case 'translation': {
        const v = lerpValues(lo.value, hi.value, t);
        result.positions[track.jointIndex] = [v[0], v[1], v[2]];
        break;
      }
      case 'scale': {
        const v = lerpValues(lo.value, hi.value, t);
        result.scales[track.jointIndex] = [v[0], v[1], v[2]];
        break;
      }
    }
  }

  return result;
}

/** Lerp pose A toward pose B by factor t (rotation via quat.slerp, position/scale via lerp). */
function blendPoses(a: SkeletonPose, b: SkeletonPose, t: number): SkeletonPose {
  const n = a.rotations.length;
  const rot: Array<[number,number,number,number]> = [];
  const pos: Array<[number,number,number]> = [];
  const scl: Array<[number,number,number]> = [];

  const tmp = new Float32Array(4);
  for (let i = 0; i < n; i++) {
    quat.slerp(tmp as unknown as quat, a.rotations[i] as unknown as quat, b.rotations[i] as unknown as quat, t);
    rot.push([tmp[0], tmp[1], tmp[2], tmp[3]]);
    const p = lerpValues(a.positions[i], b.positions[i], t);
    pos.push([p[0], p[1], p[2]]);
    const s = lerpValues(a.scales[i], b.scales[i], t);
    scl.push([s[0], s[1], s[2]]);
  }
  return { rotations: rot, positions: pos, scales: scl };
}

/** Write a SkeletonPose into skeleton.data.joints (without calling computeWorldMatrices). */
function writePoseToSkeleton(pose: SkeletonPose, skeleton: Skeleton3D): void {
  const { joints } = skeleton.data;
  for (let i = 0; i < joints.length; i++) {
    joints[i].localRotation = pose.rotations[i];
    joints[i].localPosition = pose.positions[i];
    joints[i].localScale    = pose.scales[i];
  }
}

// ── NLA Evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate an NLATrack at `frame` and write the blended pose to `skeleton`.
 *
 * Replace segments are blended sequentially from `bindPose`.
 * Additive segments add weighted deltas (segPose − bindPose) on top.
 * Fade-in/out ramps the effective weight at segment boundaries.
 */
export function evaluateNLAAtFrame(
  track: NLATrack,
  clips: SkeletonAnimClip[],
  skeleton: Skeleton3D,
  bindPose: SkeletonPose,
  frame: number,
): void {
  const clipMap = new Map<string, SkeletonAnimClip>();
  for (const c of clips) clipMap.set(c.id, c);

  type ActiveSeg = { seg: NLAClipSegment; clip: SkeletonAnimClip; localFrame: number; weight: number };
  const replaceSegs: ActiveSeg[] = [];
  const additiveSegs: ActiveSeg[] = [];

  for (const seg of track.segments) {
    const clip = clipMap.get(seg.clipId);
    if (!clip) continue;
    const clipDuration = clip.endFrame - clip.startFrame;
    if (clipDuration <= 0) continue;
    const segEnd = seg.startFrame + (clipDuration - seg.clipStartOffset);
    if (frame < seg.startFrame || frame >= segEnd) continue;

    const localFrame = clip.startFrame + seg.clipStartOffset + (frame - seg.startFrame);
    const elapsed    = frame - seg.startFrame;
    const remaining  = segEnd - frame;
    let effectiveWeight = seg.weight;
    if (seg.fadeIn  > 0 && elapsed   < seg.fadeIn)  effectiveWeight *= elapsed   / seg.fadeIn;
    if (seg.fadeOut > 0 && remaining < seg.fadeOut)  effectiveWeight *= remaining / seg.fadeOut;
    effectiveWeight = Math.max(0, Math.min(1, effectiveWeight));

    const entry: ActiveSeg = { seg, clip, localFrame, weight: effectiveWeight };
    if (seg.blendMode === 'replace') replaceSegs.push(entry);
    else                             additiveSegs.push(entry);
  }

  // Start from a mutable copy of the bind pose.
  let pose: SkeletonPose = {
    rotations: bindPose.rotations.map(r => [...r] as [number, number, number, number]),
    positions: bindPose.positions.map(p => [...p] as [number, number, number]),
    scales:    bindPose.scales.map(s    => [...s] as [number, number, number]),
  };

  // Sequential replace blend — each segment lerps current pose toward its sampled pose.
  for (const { clip, localFrame, weight } of replaceSegs) {
    const segPose = sampleClipPose(clip, bindPose, localFrame);
    pose = blendPoses(pose, segPose, weight);
  }

  // Additive deltas — add weighted (segPose − bindPose) on top of the replace result.
  if (additiveSegs.length > 0) {
    const n = pose.rotations.length;
    const tmp          = new Float32Array(4);
    const invBind      = new Float32Array(4);
    const deltaQ       = new Float32Array(4);
    const weightedDelta = new Float32Array(4);
    const identityQ: [number, number, number, number] = [0, 0, 0, 1];

    for (const { clip, localFrame, weight } of additiveSegs) {
      const segPose = sampleClipPose(clip, bindPose, localFrame);
      for (let i = 0; i < n; i++) {
        // Rotation: delta = segQ * inv(bindQ); apply as slerp(identity, delta, w) * currentQ
        quat.invert(invBind      as unknown as quat, bindPose.rotations[i] as unknown as quat);
        quat.multiply(deltaQ     as unknown as quat, segPose.rotations[i]  as unknown as quat, invBind as unknown as quat);
        quat.slerp(weightedDelta as unknown as quat, identityQ             as unknown as quat, deltaQ  as unknown as quat, weight);
        quat.multiply(tmp        as unknown as quat, weightedDelta         as unknown as quat, pose.rotations[i] as unknown as quat);
        pose.rotations[i] = [tmp[0], tmp[1], tmp[2], tmp[3]];

        // Translation: additive offset
        pose.positions[i] = [
          pose.positions[i][0] + (segPose.positions[i][0] - bindPose.positions[i][0]) * weight,
          pose.positions[i][1] + (segPose.positions[i][1] - bindPose.positions[i][1]) * weight,
          pose.positions[i][2] + (segPose.positions[i][2] - bindPose.positions[i][2]) * weight,
        ];

        // Scale: multiplicative delta
        pose.scales[i] = [
          pose.scales[i][0] * (1 + (segPose.scales[i][0] - bindPose.scales[i][0]) * weight),
          pose.scales[i][1] * (1 + (segPose.scales[i][1] - bindPose.scales[i][1]) * weight),
          pose.scales[i][2] * (1 + (segPose.scales[i][2] - bindPose.scales[i][2]) * weight),
        ];
      }
    }
  }

  writePoseToSkeleton(pose, skeleton);
  skeleton.computeWorldMatrices();
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

  // Apply IK chain property tracks (target, poleTarget, blendWeight)
  if (clip.ikTracks && clip.ikTracks.length > 0) {
    const chains = skeleton.data.ikChains;
    if (chains && chains.length > 0) {
      for (const ikTrack of clip.ikTracks) {
        if (ikTrack.keyframes.length === 0) continue;
        const chain = chains.find(c => c.id === ikTrack.chainId);
        if (!chain) continue;
        const [lo, hi, t] = sampleKeyframes(ikTrack.keyframes, frame);
        const v = lerpValues(lo.value, hi.value, t);
        switch (ikTrack.property) {
          case 'target':
            chain.target = [v[0], v[1], v[2]];
            break;
          case 'poleTarget':
            chain.poleTarget = [v[0], v[1], v[2]];
            break;
          case 'blendWeight':
            chain.blendWeight = Math.max(0, Math.min(1, v[0]));
            break;
        }
      }
    }
  }

  skeleton.computeWorldMatrices();
}
