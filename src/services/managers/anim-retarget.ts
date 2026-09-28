/**
 * anim-retarget — pure joint-NAME-based clip/pose retargeting (animation-library-and-triggers.md §3).
 *
 * The one hard primitive behind both `retargetSkeletonClip3D` and the Animation Library: remap animation
 * data authored against one rig's joint INDICES onto another rig by matching joint NAMES (case-insensitive).
 * Extracted here as pure functions so the library can apply an entry without a live "source skeleton" and so
 * the matching logic is unit-testable in isolation.
 *
 * A joint is identified structurally by `{ index, name }` — real `Joint3D`s satisfy this, and library entries
 * carry a minimal `NamedJoint[]` snapshot of their source rig so an entry stays self-describing after the
 * source skeleton is gone.
 */

import type { SkeletonKeyframeTrack, SkeletonPose } from '../../types/armature-3d';

export interface NamedJoint { index: number; name: string; }

/** name(lowercased) → index, for a joint list. */
function nameIndex(joints: NamedJoint[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const j of joints) m.set(j.name.toLowerCase(), j.index);
  return m;
}
/** index → name(lowercased), for a joint list. */
function indexName(joints: NamedJoint[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const j of joints) m.set(j.index, j.name.toLowerCase());
  return m;
}

export interface RetargetResult<T> {
  data: T;
  matched: number;        // distinct source joints that landed on a target joint
  missing: string[];      // source joint names (as authored) with no target match
}

/** The distinct joint NAMES a clip's tracks actually animate (the entry's jointManifest). */
export function clipAnimatedJointNames(tracks: SkeletonKeyframeTrack[], srcJoints: NamedJoint[]): string[] {
  const idxName = new Map<number, string>();
  for (const j of srcJoints) idxName.set(j.index, j.name);   // preserve authored casing for display
  const out: string[] = [];
  const seen = new Set<number>();
  for (const t of tracks) {
    if (seen.has(t.jointIndex)) continue;
    seen.add(t.jointIndex);
    const n = idxName.get(t.jointIndex);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Remap clip tracks from the source rig onto the target rig by joint name. Tracks whose source joint has no
 * name, or whose name has no target joint, are dropped (and reported in `missing`). Keyframes are deep-copied.
 */
export function retargetClipTracks(
  tracks: SkeletonKeyframeTrack[], srcJoints: NamedJoint[], tgtJoints: NamedJoint[],
): RetargetResult<SkeletonKeyframeTrack[]> {
  const tgt = nameIndex(tgtJoints);
  const srcIdxName = indexName(srcJoints);
  const srcIdxDisplay = new Map<number, string>();
  for (const j of srcJoints) srcIdxDisplay.set(j.index, j.name);

  const out: SkeletonKeyframeTrack[] = [];
  const matchedJoints = new Set<number>();
  const missing = new Set<string>();

  for (const track of tracks) {
    const lname = srcIdxName.get(track.jointIndex);
    if (lname === undefined) continue;   // source index not in the snapshot — unremappable, skip silently
    const tgtIdx = tgt.get(lname);
    if (tgtIdx === undefined) { missing.add(srcIdxDisplay.get(track.jointIndex) ?? lname); continue; }
    matchedJoints.add(track.jointIndex);
    out.push({
      jointIndex: tgtIdx,
      channel: track.channel,
      keyframes: track.keyframes.map((kf) => ({ frame: kf.frame, value: [...kf.value] as number[] })),
    });
  }
  return { data: out, matched: matchedJoints.size, missing: [...missing] };
}

/** Remap a pose's per-joint rotations onto the target rig by joint name (rotations deep-copied). */
export function retargetPoseRotations(
  pose: Pick<SkeletonPose, 'rotations'>, srcJoints: NamedJoint[], tgtJoints: NamedJoint[],
): RetargetResult<{ jointIndex: number; rotation: [number, number, number, number] }[]> {
  const tgt = nameIndex(tgtJoints);
  const srcIdxName = indexName(srcJoints);
  const srcIdxDisplay = new Map<number, string>();
  for (const j of srcJoints) srcIdxDisplay.set(j.index, j.name);

  const out: { jointIndex: number; rotation: [number, number, number, number] }[] = [];
  const matched = new Set<number>();
  const missing = new Set<string>();

  for (const r of pose.rotations) {
    const lname = srcIdxName.get(r.jointIndex);
    if (lname === undefined) continue;
    const tgtIdx = tgt.get(lname);
    if (tgtIdx === undefined) { missing.add(srcIdxDisplay.get(r.jointIndex) ?? lname); continue; }
    matched.add(r.jointIndex);
    out.push({ jointIndex: tgtIdx, rotation: [...r.rotation] as [number, number, number, number] });
  }
  return { data: out, matched: matched.size, missing: [...missing] };
}

/**
 * Coarse rig classification by joint-name signature — a convenience LABEL for library filtering/grouping,
 * NOT the compatibility gate (clipCompatibility/jointManifest is the precise per-rig check). 'humanoid' when
 * the standard biped landmarks are present (hips + head + spine + a left/right limb); else 'generic'.
 * Extend with more signatures (quadruped, avian…) as those rigs appear.
 */
export function classifyRig(joints: NamedJoint[]): string {
  const names = new Set(joints.map((j) => j.name.toLowerCase()));
  const has = (n: string) => names.has(n);
  const hasLimb = [...names].some((n) => /^(shoulder|upperarm|lowerarm|hand|clavicle|upperleg|lowerleg|foot|thigh|shin)_[lr]$/.test(n));
  if (has('hips') && has('head') && has('spine') && hasLimb) return 'humanoid';
  return 'generic';
}

// ── Per-region joint masks (layered overlays) ────────────────────────────────
//
// A layer mask names the joints an OVERLAY clip drives while the rest of the rig keeps its base animation —
// e.g. a wave that moves the arms + torso over a walk that keeps driving the legs. Resolved by joint NAME
// against the target skeleton (so it works on any rig using the standard names), returning joint INDICES.
// animation-library-and-triggers.md §8. A preset name OR an explicit joint-name array.

export type RegionMask = 'upperBody' | 'lowerBody' | 'arms' | 'head' | string[];

const ARM_RE = /^(clavicle|shoulder|upperarm|lowerarm|forearm|hand)_[lr]$/;
const LEG_RE = /^(upperleg|lowerleg|thigh|shin|foot|toe)_[lr]$/;
const UPPER_TORSO = new Set(['spine', 'chest', 'upperchest', 'neck', 'head', 'spine1', 'spine2']);
const LOWER_TORSO = new Set(['hips', 'lowerback', 'pelvis', 'root']);

function regionMatch(region: Exclude<RegionMask, string[]>, name: string): boolean {
  switch (region) {
    case 'head':      return name === 'head' || name === 'neck';
    case 'arms':      return ARM_RE.test(name);
    case 'upperBody': return ARM_RE.test(name) || UPPER_TORSO.has(name);         // arms + torso above the spine
    case 'lowerBody': return LEG_RE.test(name) || LOWER_TORSO.has(name);          // legs + hips/lowerback (complement)
    default:          return false;
  }
}

/**
 * The joint INDICES a region mask covers on `joints`. A preset ('upperBody'/'lowerBody'/'arms'/'head') matches by
 * the standard joint-name signatures; an explicit string[] matches those joint names (case-insensitive). Names not
 * on the skeleton are simply absent from the result.
 */
export function resolveRegionMask(joints: NamedJoint[], region: RegionMask): number[] {
  if (Array.isArray(region)) {
    const want = new Set(region.map((n) => n.toLowerCase()));
    return joints.filter((j) => want.has(j.name.toLowerCase())).map((j) => j.index);
  }
  return joints.filter((j) => regionMatch(region, j.name.toLowerCase())).map((j) => j.index);
}

/** Compatibility preflight for the host UI ("18/19 joints match"). */
export function clipCompatibility(
  tracks: SkeletonKeyframeTrack[], srcJoints: NamedJoint[], tgtJoints: NamedJoint[],
): { matched: number; missing: string[] } {
  const { matched, missing } = retargetClipTracks(tracks, srcJoints, tgtJoints);
  return { matched, missing };
}
