import { describe, it, expect } from 'vitest';
import {
  retargetClipTracks, retargetPoseRotations, clipAnimatedJointNames, clipCompatibility, classifyRig, resolveRegionMask, type NamedJoint,
} from './anim-retarget';
import type { SkeletonKeyframeTrack } from '../../types/armature-3d';

// Source rig: hips(0), spine(1), head(2). Target rig SAME NAMES but DIFFERENT indices (+ an extra arm joint).
const SRC: NamedJoint[] = [{ index: 0, name: 'hips' }, { index: 1, name: 'spine' }, { index: 2, name: 'head' }];
const TGT: NamedJoint[] = [{ index: 5, name: 'Head' }, { index: 6, name: 'Hips' }, { index: 7, name: 'spine' }, { index: 8, name: 'arm' }];

const track = (jointIndex: number, channel: SkeletonKeyframeTrack['channel'], v: number[]): SkeletonKeyframeTrack =>
  ({ jointIndex, channel, keyframes: [{ frame: 0, value: [...v] }, { frame: 10, value: v.map((x) => x + 1) }] });

describe('anim-retarget — joint-name clip/pose remapping', () => {
  it('remaps track jointIndex by NAME (case-insensitive), deep-copying keyframes', () => {
    const tracks = [track(0, 'translation', [1, 2, 3]), track(2, 'rotation', [0, 0, 0, 1])];
    const { data, matched, missing } = retargetClipTracks(tracks, SRC, TGT);
    expect(matched).toBe(2);
    expect(missing).toEqual([]);
    // hips(0)→Hips(6), head(2)→Head(5)
    expect(data.find((t) => t.channel === 'translation')!.jointIndex).toBe(6);
    expect(data.find((t) => t.channel === 'rotation')!.jointIndex).toBe(5);
    // deep copy — mutating output never touches input
    data[0].keyframes[0].value[0] = 999;
    expect(tracks[0].keyframes[0].value[0]).toBe(1);
  });

  it('reports source joints with no target match and drops those tracks', () => {
    const orphan: NamedJoint[] = [...SRC, { index: 3, name: 'tail' }];
    const tracks = [track(1, 'rotation', [0, 0, 0, 1]), track(3, 'rotation', [0, 0, 0, 1])];
    const { data, matched, missing } = retargetClipTracks(tracks, orphan, TGT);
    expect(matched).toBe(1);            // only spine matched
    expect(missing).toEqual(['tail']);  // authored casing preserved
    expect(data).toHaveLength(1);
    expect(data[0].jointIndex).toBe(7); // spine→7
  });

  it('matched=0 when NO joints overlap (caller treats as un-appliable)', () => {
    const alien: NamedJoint[] = [{ index: 0, name: 'wing_L' }, { index: 1, name: 'wing_R' }];
    const { matched } = retargetClipTracks([track(0, 'rotation', [0, 0, 0, 1])], SRC, alien);
    expect(matched).toBe(0);
  });

  it('clipAnimatedJointNames lists distinct animated joints in authored casing', () => {
    const tracks = [track(0, 'translation', [0, 0, 0]), track(0, 'rotation', [0, 0, 0, 1]), track(2, 'rotation', [0, 0, 0, 1])];
    expect(clipAnimatedJointNames(tracks, SRC)).toEqual(['hips', 'head']);   // hips once despite two channels
  });

  it('retargetPoseRotations remaps by name + deep-copies rotations', () => {
    const pose = { rotations: [{ jointIndex: 0, rotation: [0, 0, 0, 1] as [number, number, number, number] },
                               { jointIndex: 1, rotation: [0.1, 0, 0, 0.99] as [number, number, number, number] }] };
    const { data, matched } = retargetPoseRotations(pose, SRC, TGT);
    expect(matched).toBe(2);
    expect(data.find((r) => r.jointIndex === 6)).toBeTruthy();  // hips→Hips(6)
    data[0].rotation[0] = 9;
    expect(pose.rotations[0].rotation[0]).toBe(0);
  });

  it('clipCompatibility mirrors the retarget matched/missing (preflight)', () => {
    const withTail: NamedJoint[] = [...SRC, { index: 3, name: 'tail' }];
    const tracks = [track(0, 'rotation', [0, 0, 0, 1]), track(3, 'rotation', [0, 0, 0, 1])];
    expect(clipCompatibility(tracks, withTail, TGT)).toEqual({ matched: 1, missing: ['tail'] });
  });

  it('classifyRig labels a biped signature humanoid, else generic', () => {
    const humanoid: NamedJoint[] = [
      { index: 0, name: 'hips' }, { index: 1, name: 'spine' }, { index: 2, name: 'head' },
      { index: 3, name: 'upperleg_L' }, { index: 4, name: 'hand_R' },
    ];
    expect(classifyRig(humanoid)).toBe('humanoid');
    expect(classifyRig(SRC)).toBe('generic');                                   // hips+spine+head but no limb → generic
    expect(classifyRig([{ index: 0, name: 'wing_L' }, { index: 1, name: 'body' }])).toBe('generic');
  });
});

describe('resolveRegionMask — per-region joint masks', () => {
  // The standard procedural rig (subset), preserving real names + indices.
  const RIG: NamedJoint[] = [
    { index: 0, name: 'hips' }, { index: 1, name: 'lowerback' }, { index: 2, name: 'spine' }, { index: 3, name: 'chest' },
    { index: 4, name: 'neck' }, { index: 5, name: 'head' },
    { index: 6, name: 'clavicle_L' }, { index: 7, name: 'shoulder_L' }, { index: 8, name: 'lowerarm_L' }, { index: 9, name: 'hand_L' },
    { index: 10, name: 'clavicle_R' }, { index: 11, name: 'shoulder_R' }, { index: 12, name: 'lowerarm_R' }, { index: 13, name: 'hand_R' },
    { index: 14, name: 'upperleg_L' }, { index: 15, name: 'lowerleg_L' }, { index: 16, name: 'foot_L' },
    { index: 17, name: 'upperleg_R' }, { index: 18, name: 'lowerleg_R' }, { index: 19, name: 'foot_R' },
  ];

  it('upperBody = arms + torso above the spine (no hips/lowerback/legs)', () => {
    const m = new Set(resolveRegionMask(RIG, 'upperBody'));
    expect(m.has(2)).toBe(true); expect(m.has(5)).toBe(true);           // spine, head
    expect(m.has(9)).toBe(true); expect(m.has(13)).toBe(true);          // hand_L, hand_R
    expect(m.has(0)).toBe(false); expect(m.has(1)).toBe(false);         // hips, lowerback excluded
    expect(m.has(14)).toBe(false); expect(m.has(16)).toBe(false);       // legs excluded
  });
  it('lowerBody = legs + hips/lowerback, and is the complement of upperBody', () => {
    const upper = resolveRegionMask(RIG, 'upperBody');
    const lower = resolveRegionMask(RIG, 'lowerBody');
    expect(new Set(lower).has(0)).toBe(true);                            // hips
    expect(new Set(lower).has(14)).toBe(true);                          // upperleg_L
    expect([...upper, ...lower].sort((a, b) => a - b)).toEqual(RIG.map((j) => j.index));   // partition
    expect(upper.filter((i) => lower.includes(i))).toEqual([]);          // disjoint
  });
  it('arms covers both arm chains only; head covers head+neck', () => {
    expect(resolveRegionMask(RIG, 'arms').sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
    expect(resolveRegionMask(RIG, 'head').sort((a, b) => a - b)).toEqual([4, 5]);
  });
  it('accepts an explicit joint-name array (case-insensitive)', () => {
    expect(resolveRegionMask(RIG, ['HAND_L', 'head']).sort((a, b) => a - b)).toEqual([5, 9]);
    expect(resolveRegionMask(RIG, ['nonexistent'])).toEqual([]);
  });
});
