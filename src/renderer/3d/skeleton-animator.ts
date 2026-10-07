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

/** Reused slerp target for clip rotation tracks (was a fresh Float32Array(4) per rotation track per frame). */
const _clipSlerpQuat = quat.create();

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
export function sampleClipPose(
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
export function blendPoses(a: SkeletonPose, b: SkeletonPose, t: number): SkeletonPose {
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

/**
 * Composite an `overlay` pose over `base` for the joints in `mask` only — the layered-clip primitive (a wave over
 * a walk): masked joints take the overlay's local transform, all others keep `base`. Pure; result is a fresh pose.
 * Out-of-range or overlay-missing indices are skipped (keep base). animation-library-and-triggers.md §8.
 */
export function overlayPoseMasked(base: SkeletonPose, overlay: SkeletonPose, mask: Iterable<number>): SkeletonPose {
  const rotations = base.rotations.map(r => [...r] as [number,number,number,number]);
  const positions = base.positions.map(p => [...p] as [number,number,number]);
  const scales    = base.scales.map(s => [...s] as [number,number,number]);
  for (const i of mask) {
    if (i < 0 || i >= rotations.length) continue;
    if (overlay.rotations[i]) rotations[i] = [...overlay.rotations[i]] as [number,number,number,number];
    if (overlay.positions[i]) positions[i] = [...overlay.positions[i]] as [number,number,number];
    if (overlay.scales[i])    scales[i]    = [...overlay.scales[i]]    as [number,number,number];
  }
  return { rotations, positions, scales };
}

/**
 * ADDITIVE composite: add an `add` pose's motion RELATIVE to a `ref` pose onto `base`, for the joints in `mask`,
 * scaled by `weight` (0..1). Unlike {@link overlayPoseMasked} (which replaces), this LAYERS a delta — a subtle
 * lean/breathe/aim-offset on top of whatever the base is doing. Per joint: rotation gets `base * (ref⁻¹·add)^weight`
 * (the ref→add turn applied in base's local frame), position gets `base + weight·(add − ref)`, scale gets the
 * ratio `add/ref` blended in by weight. Pure. animation-library-and-triggers.md §8.
 */
export function addPoseMasked(base: SkeletonPose, add: SkeletonPose, ref: SkeletonPose, weight: number, mask: Iterable<number>): SkeletonPose {
  const rotations = base.rotations.map(r => [...r] as [number,number,number,number]);
  const positions = base.positions.map(p => [...p] as [number,number,number]);
  const scales    = base.scales.map(s => [...s] as [number,number,number]);
  const w = Math.max(0, Math.min(1, weight));
  const IDENT: quat = [0, 0, 0, 1] as unknown as quat;
  const invRef = new Float32Array(4), delta = new Float32Array(4), wDelta = new Float32Array(4), out = new Float32Array(4);
  for (const i of mask) {
    if (i < 0 || i >= rotations.length) continue;
    if (add.rotations[i] && ref.rotations[i]) {
      quat.invert(invRef as unknown as quat, ref.rotations[i] as unknown as quat);
      quat.multiply(delta as unknown as quat, invRef as unknown as quat, add.rotations[i] as unknown as quat);   // ref⁻¹·add
      quat.slerp(wDelta as unknown as quat, IDENT, delta as unknown as quat, w);                                  // scale the delta by weight
      quat.multiply(out as unknown as quat, base.rotations[i] as unknown as quat, wDelta as unknown as quat);     // apply in base's frame
      quat.normalize(out as unknown as quat, out as unknown as quat);
      rotations[i] = [out[0], out[1], out[2], out[3]];
    }
    const ap = add.positions[i], rp = ref.positions[i];
    if (ap && rp) { const b = positions[i]; positions[i] = [b[0] + w * (ap[0] - rp[0]), b[1] + w * (ap[1] - rp[1]), b[2] + w * (ap[2] - rp[2])]; }
    const as = add.scales[i], rs = ref.scales[i];
    if (as && rs) { const b = scales[i]; const r = (k: number) => rs[k] !== 0 ? (as[k] / rs[k] - 1) * w + 1 : 1; scales[i] = [b[0] * r(0), b[1] * r(1), b[2] * r(2)]; }
  }
  return { rotations, positions, scales };
}

/** Write a SkeletonPose into skeleton.data.joints (without calling computeWorldMatrices). */
export function writePoseToSkeleton(pose: SkeletonPose, skeleton: Skeleton3D): void {
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
/**
 * A copy of `clip` carried over onto the character's CURRENT pose: on each rotation track whose joint is in `base`, the
 * whole track is pre-multiplied by the offset (base · first⁻¹) between where the clip starts (its first keyframe = the
 * default stance it was authored from) and where this character actually stands. So a one-shot authored from the
 * default stance (stretch, scratch head) leaves from and settles back to THIS character's stance — e.g. arms fitted
 * wider on a heavier body. The offset FADES OUT as a key moves away from the rest pose (full at the rest keys, none
 * past ~60°): the correction that widens a hanging arm would, applied to an overhead arm, tip it into the head.
 * Tracks already starting at `base` are returned untouched. `onlyFrom` (optional): rebase a track ONLY if its first
 * keyframe equals this rotation for its joint (i.e. it really starts from the default stance) — other tracks keep their
 * authored values. Pure.
 */
/** Beyond this rotation away from a track's rest key, rebaseClipRest applies no offset. */
const REBASE_FADE_RAD = Math.PI / 3;

export function rebaseClipRest(clip: SkeletonAnimClip, base: Map<number, readonly number[]>, onlyFrom?: (jointIndex: number) => readonly number[] | undefined): SkeletonAnimClip {
  const off = quat.create(), inv = quat.create(), tmp = quat.create();
  return {
    ...clip,
    tracks: clip.tracks.map(t => {
      const b = base.get(t.jointIndex);
      if (t.channel !== 'rotation' || !b || t.keyframes.length === 0) return t;
      const first = t.keyframes[0].value;
      if (first.every((v, i) => Math.abs(v - b[i]) < 1e-6)) return t;
      const from = onlyFrom?.(t.jointIndex);
      if (onlyFrom && !(from && first.every((v, i) => Math.abs(v - from[i]) < 1e-6))) return t;
      quat.invert(inv, first as unknown as quat);
      quat.multiply(off, b as unknown as quat, inv);          // off · first = base
      const id = quat.create(), part = quat.create();
      return {
        ...t,
        keyframes: t.keyframes.map(k => {
          const away = quat.getAngle(first as unknown as quat, k.value as unknown as quat);   // rad from the rest key
          const w = Math.max(0, 1 - away / REBASE_FADE_RAD);
          quat.slerp(part, id, off, w);
          quat.multiply(tmp, part, k.value as unknown as quat);
          return { ...k, value: [tmp[0], tmp[1], tmp[2], tmp[3]] };
        }),
      };
    }),
  };
}

export function applySkeletonClipAtFrame(
  clip: SkeletonAnimClip,
  skeleton: Skeleton3D,
  frame: number,
  /** false = only write the joint/IK-chain inputs; the CALLER runs the FK pass (it edits the pose further first —
   *  the idle-break blend). Skipping it is exact only when nothing reads world matrices before that pass. */
  recompute = true,
): void {
  const { joints } = skeleton.data;

  for (const track of clip.tracks) {
    const joint = joints[track.jointIndex];
    if (!joint || track.keyframes.length === 0) continue;

    const [lo, hi, t] = sampleKeyframes(track.keyframes, frame);

    switch (track.channel) {
      case 'rotation': {
        const out = quat.slerp(_clipSlerpQuat, lo.value as unknown as quat, hi.value as unknown as quat, t);
        const lr = joint.localRotation as number[] | undefined;   // mutate in place; out is scratch → copy values
        if (lr) { lr[0] = out[0]; lr[1] = out[1]; lr[2] = out[2]; lr[3] = out[3]; }
        else joint.localRotation = [out[0], out[1], out[2], out[3]];
        break;
      }
      case 'translation': {
        const a = lo.value, b = hi.value;   // inline lerp (no lerpValues array) + mutate in place
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
        const lp = joint.localPosition as number[] | undefined;
        if (lp) { lp[0] = x; lp[1] = y; lp[2] = z; } else joint.localPosition = [x, y, z];
        break;
      }
      case 'scale': {
        const a = lo.value, b = hi.value;
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
        const ls = joint.localScale as number[] | undefined;
        if (ls) { ls[0] = x; ls[1] = y; ls[2] = z; } else joint.localScale = [x, y, z];
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

  if (recompute) skeleton.computeWorldMatrices();
}
