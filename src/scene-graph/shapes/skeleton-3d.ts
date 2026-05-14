import { mat4, quat, vec3 } from 'gl-matrix';
import { Node } from './base/node';
import type { SkeletonData } from '../../types/armature-3d';

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
      mat4.fromRotationTranslationScale(
        local as unknown as mat4,
        j.localRotation as unknown as quat,
        j.localPosition as unknown as vec3,
        j.localScale    as unknown as vec3,
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
          inverseBindMatrix: Array.from(j.inverseBindMatrix),
        })),
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
      worldMatrix:       new Float32Array(16),
      inverseBindMatrix: new Float32Array(j.inverseBindMatrix ?? new Array(16).fill(0)),
    }));
    const skel = new Skeleton3D({ name: data.skeletonData?.name ?? 'skeleton', joints });
    if (data.id) skel.id = data.id;
    skel.name = data.name ?? '';
    return skel;
  }
}
