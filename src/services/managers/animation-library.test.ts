import { describe, it, expect, beforeEach } from 'vitest';
import { AnimationLibrary, type AnimationLibraryHost } from './animation-library';
import type { NamedJoint } from './anim-retarget';
import type { SkeletonAnimClip, SkeletonPose, SkeletonKeyframeTrack } from '../../types/armature-3d';

// Mock scene: two "skeletons" (A = source rig, B = target rig, differently indexed, shared names) each holding
// a clip + pose store. No GPU, no real Skeleton3D — the library only touches the host surface.
function makeEnv() {
  const jointsA: NamedJoint[] = [{ index: 0, name: 'hips' }, { index: 1, name: 'spine' }, { index: 2, name: 'head' }];
  const jointsB: NamedJoint[] = [{ index: 9, name: 'Head' }, { index: 8, name: 'Spine' }, { index: 7, name: 'Hips' }];
  const clipA: SkeletonAnimClip = {
    id: 'clipA', name: 'Wave', startFrame: 0, endFrame: 24, fps: 24,
    tracks: [
      { jointIndex: 0, channel: 'rotation', keyframes: [{ frame: 0, value: [0, 0, 0, 1] }] },
      { jointIndex: 2, channel: 'rotation', keyframes: [{ frame: 12, value: [0.2, 0, 0, 0.98] }] },
    ] as SkeletonKeyframeTrack[],
  };
  const poseA: SkeletonPose = { id: 'poseA', name: 'Relaxed', rotations: [
    { jointIndex: 0, rotation: [0, 0, 0, 1] }, { jointIndex: 1, rotation: [0.1, 0, 0, 0.99] }] };

  const created: { skeletonId: string; name: string; tracks: SkeletonKeyframeTrack[]; fps: number; endFrame: number }[] = [];
  const posesAdded: { skeletonId: string; name: string; rotations: { jointIndex: number }[] }[] = [];
  let nextId = 1;

  const host: AnimationLibraryHost = {
    findClip: (id) => id === 'clipA' ? { clip: clipA, joints: jointsA, rig: 'A' } : null,
    findPose: (skid, pid) => (skid === 'A' && pid === 'poseA') ? { pose: poseA, joints: jointsA, rig: 'A' } : null,
    skeletonJoints: (id) => id === 'A' ? jointsA : id === 'B' ? jointsB
      : id === 'C' ? [{ index: 0, name: 'wing_L' }, { index: 1, name: 'wing_R' }]   // shares no names
      : null,
    createClip: (skeletonId, name, fps, endFrame, tracks) => { created.push({ skeletonId, name, tracks, fps, endFrame }); return `newclip${nextId++}`; },
    addPose: (skeletonId, name, rotations) => { posesAdded.push({ skeletonId, name, rotations }); return `newpose${nextId++}`; },
  };
  return { lib: new AnimationLibrary(host), created, posesAdded, jointsB };
}

describe('AnimationLibrary — promote / apply / persist', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('promotes a clip with fresh id, manifest, and a source-joint snapshot', () => {
    const id = env.lib.addClip('clipA', { tags: ['gesture'] })!;
    expect(id).toBeTruthy();
    const e = env.lib.get(id)!;
    expect(e.kind).toBe('clip');
    expect(e.name).toBe('Wave');
    expect(e.clip!.id).not.toBe('clipA');          // never the source id
    expect(e.jointManifest).toEqual(['hips', 'head']);
    expect(e.sourceJoints.map((j) => j.name)).toContain('spine');
    expect(e.tags).toEqual(['gesture']);
  });

  it('promote returns null for an unknown clip', () => {
    expect(env.lib.addClip('nope')).toBeNull();
  });

  it('buildClipEntry returns an entry WITHOUT storing it (for global-library promotion)', () => {
    const entry = env.lib.buildClipEntry('clipA', { tags: ['gesture'] });
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe('clip');
    expect(entry!.jointManifest.length).toBeGreaterThan(0);
    expect(env.lib.list()).toHaveLength(0);           // NOT added to the doc library
    expect(env.lib.buildClipEntry('nope')).toBeNull();
  });

  it('dedupes names on repeated promote: Wave → Wave (2) → Wave (3)', () => {
    env.lib.addClip('clipA'); env.lib.addClip('clipA'); env.lib.addClip('clipA');
    const names = env.lib.list().map((e) => e.name).sort();
    expect(names).toEqual(['Wave', 'Wave (2)', 'Wave (3)']);
  });

  it('applies a clip to another rig via joint-name retarget (indices remapped)', () => {
    const id = env.lib.addClip('clipA')!;
    const newId = env.lib.apply(id, 'B');
    expect(newId).toBe('newclip1');
    expect(env.created).toHaveLength(1);
    // hips(0)→Hips(7), head(2)→Head(9)
    const idxs = env.created[0].tracks.map((t) => t.jointIndex).sort((a, b) => a - b);
    expect(idxs).toEqual([7, 9]);
    expect(env.created[0].skeletonId).toBe('B');
  });

  it('apply returns null for an unknown skeleton, and (matched=0) for a no-shared-names rig', () => {
    const id = env.lib.addClip('clipA')!;
    expect(env.lib.apply(id, 'ZZZ')).toBeNull();   // unknown skeleton → null

    // Rig 'C' shares NO joint names with the source → matched 0 → apply null.
    const alien = makeEnv();
    const aid = alien.lib.addClip('clipA')!;
    expect(alien.lib.compatibility(aid, 'C')).toEqual({ matched: 0, missing: ['hips', 'head'] });
    expect(alien.lib.apply(aid, 'C')).toBeNull();
  });

  it('applies a pose (rotations remapped) to another rig', () => {
    const id = env.lib.addPose('A', 'poseA')!;
    const newId = env.lib.apply(id, 'B');
    expect(newId).toBe('newpose1');
    // hips(0)→7, spine(1)→8
    expect(env.posesAdded[0].rotations.map((r) => r.jointIndex).sort((a, b) => a - b)).toEqual([7, 8]);
  });

  it('compatibility reports matched/missing against a target rig', () => {
    const id = env.lib.addClip('clipA')!;
    expect(env.lib.compatibility(id, 'B')).toEqual({ matched: 2, missing: [] });
  });

  it('auto-derives rigType from the source rig and allows override', () => {
    // env's jointsA (hips/spine/head, no _L/_R limb) → generic; override to a custom label.
    const id = env.lib.addClip('clipA')!;
    expect(env.lib.get(id)!.rigType).toBe('generic');
    expect(env.lib.setRigType(id, 'creature')).toBe(true);
    expect(env.lib.get(id)!.rigType).toBe('creature');
    // rigType survives serialize→load
    const fresh = makeEnv().lib;
    const [nid] = fresh.load(JSON.stringify(env.lib.serialize()));
    expect(fresh.get(nid)!.rigType).toBe('creature');
  });

  it('rename / remove / list bookkeeping', () => {
    const id = env.lib.addClip('clipA')!;
    expect(env.lib.rename(id, 'Greeting')).toBe(true);
    expect(env.lib.get(id)!.name).toBe('Greeting');
    expect(env.lib.remove(id)).toBe(true);
    expect(env.lib.list()).toHaveLength(0);
  });

  it('serialize → load round-trips entries with FRESH ids (never collide across docs)', () => {
    const id = env.lib.addClip('clipA')!;
    const json = JSON.stringify(env.lib.serialize());
    const fresh = makeEnv().lib;
    const newIds = fresh.load(json);
    expect(newIds).toHaveLength(1);
    expect(newIds[0]).not.toBe(id);                 // re-minted
    expect(fresh.list()[0].name).toBe('Wave');
    expect(fresh.list()[0].jointManifest).toEqual(['hips', 'head']);
    // and the re-imported entry still applies
    expect(fresh.apply(newIds[0], 'B')).toBeTruthy();
  });

  it('load(merge:false) replaces; merge:true appends with dedupe; clearForDocumentLoad empties', () => {
    env.lib.addClip('clipA');
    const json = JSON.stringify(env.lib.serialize());
    env.lib.load(json, { merge: true });            // append a second "Wave"
    expect(env.lib.list().map((e) => e.name).sort()).toEqual(['Wave', 'Wave (2)']);
    env.lib.load(json, { merge: false });           // replace → one entry
    expect(env.lib.size).toBe(1);
    env.lib.clearForDocumentLoad();
    expect(env.lib.size).toBe(0);
  });
});
