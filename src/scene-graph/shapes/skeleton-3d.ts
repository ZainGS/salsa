import { mat4, quat, vec3 } from 'gl-matrix';
import { Node } from './base/node';
import type { SkeletonData, SkeletonAnimClip, IKChain, IKKeyframeTrack, SkeletonPose } from '../../types/armature-3d';

/**
 * Skeleton3D — scene-graph node that owns a joint hierarchy.
 *
 * After any joint rotation/position change call computeWorldMatrices()
 * to rebuild both joint world matrices and the flattened skinMatrices
 * array (skinMatrix[i] = worldMatrix[i] × inverseBindMatrix[i]).
 * The renderer reads skinMatrices directly from this node.
 */
export class Skeleton3D extends Node {
  public id: string = crypto.randomUUID();
  public data: SkeletonData;
  /**
   * Flat skin-matrix array: data.joints.length × 16 floats.
   * Each entry is skinMatrix[i] = worldMatrix[i] × inverseBindMatrix[i].
   * Written by computeWorldMatrices(); read by Renderer3D each frame.
   */
  public skinMatrices: Float32Array;
  /** Set to true by computeWorldMatrices(); cleared by the renderer after upload. */
  public matricesDirty = true;

  constructor(data: SkeletonData) {
    super();
    this.data = data;
    this.skinMatrices = new Float32Array(data.joints.length * 16);
    this.computeWorldMatrices();
  }

  /**
   * Recompute world matrices for all joints (parent-first order assumed),
   * then update the flat skinMatrices array.
   */
  computeWorldMatrices(): void {
    const { joints } = this.data;
    const local = mat4.create() as Float32Array;
    const tmp   = mat4.create() as Float32Array;

    for (const j of joints) {
      const rot   = (j.constraintRotation ?? j.ikRotation ?? j.localRotation) as unknown as quat;
      const scale = (j.constraintScale ?? j.localScale) as unknown as vec3;
      mat4.fromRotationTranslationScale(
        local as unknown as mat4,
        rot,
        j.localPosition as unknown as vec3,
        scale,
      );

      if (j.parentIndex < 0) {
        j.worldMatrix.set(local);
      } else {
        mat4.mul(
          j.worldMatrix as unknown as mat4,
          joints[j.parentIndex].worldMatrix as unknown as mat4,
          local as unknown as mat4,
        );
      }

      // skinMatrix = worldMatrix × inverseBindMatrix
      mat4.mul(
        tmp as unknown as mat4,
        j.worldMatrix as unknown as mat4,
        j.inverseBindMatrix as unknown as mat4,
      );
      this.skinMatrices.set(tmp, j.index * 16);
    }
    this.matricesDirty = true;
  }

  /** Override one joint's local rotation (quaternion xyzw) and recompute. */
  setJointRotation(jointIndex: number, q: [number, number, number, number]): void {
    if (jointIndex < 0 || jointIndex >= this.data.joints.length) return;
    this.data.joints[jointIndex].localRotation = q;
    this.computeWorldMatrices();
  }

  /** Override one joint's local position and recompute. */
  setJointPosition(jointIndex: number, p: [number, number, number]): void {
    if (jointIndex < 0 || jointIndex >= this.data.joints.length) return;
    this.data.joints[jointIndex].localPosition = p;
    this.computeWorldMatrices();
  }

  // ── Joint authoring ───────────────────────────────────────────────────────

  /**
   * Append a new joint as a child of `parentIndex` (-1 = root).
   * Returns the new joint's index.
   */
  addJoint(parentIndex: number, localPos: [number, number, number], name?: string): number {
    const { joints } = this.data;
    const idx = joints.length;
    joints.push({
      index: idx,
      name: name ?? `joint_${idx}`,
      parentIndex,
      children: [],
      localPosition: [...localPos] as [number, number, number],
      localRotation: [0, 0, 0, 1],
      localScale: [1, 1, 1],
      tailOffset: [0, 0.3, 0],
      worldMatrix: new Float32Array(16),
      inverseBindMatrix: new Float32Array(16),
    });
    if (parentIndex >= 0 && parentIndex < joints.length - 1) {
      joints[parentIndex].children.push(idx);
    }
    // Grow skinMatrices
    const newSkin = new Float32Array(joints.length * 16);
    newSkin.set(this.skinMatrices);
    this.skinMatrices = newSkin;
    this.computeWorldMatrices();
    return idx;
  }

  /**
   * Remove joint at `jointIndex` and all its descendants.
   * Re-indexes remaining joints so indices stay contiguous.
   */
  removeJoint(jointIndex: number): void {
    const { joints } = this.data;
    if (jointIndex < 0 || jointIndex >= joints.length) return;

    // Collect joint + descendants
    const toRemove = new Set<number>();
    const stack = [jointIndex];
    while (stack.length) {
      const ji = stack.pop()!;
      toRemove.add(ji);
      for (const c of joints[ji].children) stack.push(c);
    }

    // Build old→new index map for survivors
    const oldToNew = new Array<number>(joints.length).fill(-1);
    let ni = 0;
    for (let i = 0; i < joints.length; i++) {
      if (!toRemove.has(i)) oldToNew[i] = ni++;
    }

    const newJoints = joints
      .filter((_, i) => !toRemove.has(i))
      .map(j => ({
        ...j,
        index: oldToNew[j.index],
        parentIndex: j.parentIndex < 0 ? -1 : oldToNew[j.parentIndex],
        children: j.children.filter(c => !toRemove.has(c)).map(c => oldToNew[c]),
      }));

    this.data.joints = newJoints;
    this.skinMatrices = new Float32Array(newJoints.length * 16);
    this.computeWorldMatrices();
  }

  /** Move a joint's local position without changing parent or children. */
  moveJoint(jointIndex: number, localPos: [number, number, number]): void {
    if (jointIndex < 0 || jointIndex >= this.data.joints.length) return;
    this.data.joints[jointIndex].localPosition = [...localPos] as [number, number, number];
    this.computeWorldMatrices();
  }

  /** Rename a joint. */
  renameJoint(jointIndex: number, name: string): void {
    if (jointIndex < 0 || jointIndex >= this.data.joints.length) return;
    this.data.joints[jointIndex].name = name;
  }

  /** Set the visual tail offset (in the joint's own local frame). Leaf joints use
   *  this to draw the diamond-stick tip and the draggable tail handle sphere. */
  setJointTailOffset(jointIndex: number, offset: [number, number, number]): void {
    if (jointIndex < 0 || jointIndex >= this.data.joints.length) return;
    this.data.joints[jointIndex].tailOffset = [...offset] as [number, number, number];
  }

  /** Recompute inverseBindMatrix for all joints from their current worldMatrix. */
  computeInverseBindMatrices(): void {
    for (const j of this.data.joints) {
      mat4.invert(j.inverseBindMatrix as unknown as mat4, j.worldMatrix as unknown as mat4);
    }
  }

  /** Clear all per-frame IK rotations, reverting joints to their FK localRotation. */
  clearIKRotations(): void {
    for (const j of this.data.joints) {
      j.ikRotation = undefined;
    }
  }

  toJSON(): any {
    return {
      ...super.toJSON(),
      type: 'Skeleton3D',
      id: this.id,
      skeletonData: {
        name: this.data.name,
        joints: this.data.joints.map(j => ({
          index:             j.index,
          name:              j.name,
          parentIndex:       j.parentIndex,
          children:          [...j.children],
          localPosition:     [...j.localPosition],
          localRotation:     [...j.localRotation],
          localScale:        [...j.localScale],
          tailOffset:        [...j.tailOffset],
          inverseBindMatrix: Array.from(j.inverseBindMatrix),
          // ikRotation/constraintRotation/constraintScale intentionally omitted — ephemeral
          ...(j.constraints?.length ? { constraints: j.constraints } : {}),
        })),
        clips: (this.data.clips ?? []).map(c => ({
          id:         c.id,
          name:       c.name,
          startFrame: c.startFrame,
          endFrame:   c.endFrame,
          fps:        c.fps,
          tracks:     c.tracks,
          ...(c.ikTracks && c.ikTracks.length > 0 ? { ikTracks: c.ikTracks } : {}),
        })),
        ikChains: (this.data.ikChains ?? []).map(ch => ({
          id:          ch.id,
          endJointIdx: ch.endJointIdx,
          chainLength: ch.chainLength,
          target:      [...ch.target] as [number, number, number],
          ...(ch.poleTarget ? { poleTarget: [...ch.poleTarget] as [number, number, number] } : {}),
          blendWeight: ch.blendWeight ?? 1,
          enabled:     ch.enabled,
        })),
        poses: (this.data.poses ?? []).map(p => ({ ...p })),
      },
    };
  }

  /** Reconstruct a Skeleton3D from JSON produced by toJSON(). */
  static fromJSON(data: any): Skeleton3D {
    const joints: import('../../types/armature-3d').Joint3D[] = (data.skeletonData?.joints ?? []).map((j: any) => ({
      index:             j.index,
      name:              j.name ?? `joint_${j.index}`,
      parentIndex:       j.parentIndex ?? -1,
      children:          j.children ?? [],
      localPosition:     j.localPosition ?? [0, 0, 0],
      localRotation:     j.localRotation ?? [0, 0, 0, 1],
      localScale:        j.localScale ?? [1, 1, 1],
      tailOffset:        j.tailOffset ?? [0, 0.3, 0],
      worldMatrix:       new Float32Array(16),
      inverseBindMatrix: new Float32Array(j.inverseBindMatrix ?? new Array(16).fill(0)),
      ...(j.constraints?.length ? { constraints: j.constraints } : {}),
    }));
    const clips: SkeletonAnimClip[] = (data.skeletonData?.clips ?? []).map((c: any) => ({
      id:         c.id ?? crypto.randomUUID(),
      name:       c.name ?? 'clip',
      startFrame: c.startFrame ?? 0,
      endFrame:   c.endFrame ?? 24,
      fps:        c.fps ?? 24,
      tracks:     c.tracks ?? [],
      ...(c.ikTracks && c.ikTracks.length > 0
        ? { ikTracks: (c.ikTracks as any[]).map((t: any): IKKeyframeTrack => ({
              chainId:   t.chainId ?? '',
              property:  t.property ?? 'target',
              keyframes: t.keyframes ?? [],
            })) }
        : {}),
    }));
    const ikChains: IKChain[] = (data.skeletonData?.ikChains ?? []).map((ch: any) => ({
      id:          ch.id ?? crypto.randomUUID(),
      endJointIdx: ch.endJointIdx ?? 0,
      chainLength: ch.chainLength ?? 2,
      target:      ch.target ?? [0, 0, 0],
      ...(ch.poleTarget ? { poleTarget: ch.poleTarget as [number, number, number] } : {}),
      blendWeight: ch.blendWeight ?? 1,
      enabled:     ch.enabled ?? true,
    }));
    const poses: SkeletonPose[] = (data.skeletonData?.poses ?? []).map((p: any) => ({
      id:        p.id,
      name:      p.name,
      rotations: p.rotations,
    }));
    const skel = new Skeleton3D({ name: data.skeletonData?.name ?? 'skeleton', joints, clips, ikChains, poses });
    if (data.id) skel.id = data.id;
    skel.name = data.name ?? '';
    return skel;
  }
}
