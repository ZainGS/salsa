import { Mesh3D, type Mesh3DConfig } from './mesh-3d';
import type { Skeleton3D } from './skeleton-3d';
import type { InteractionService } from '../../services/interaction-service';

/**
 * SkinnedMesh3D — Mesh3D with per-vertex joint weights for LBS skinning.
 *
 * The renderer drives this through Renderer3D.drawSkinnedMeshes(), which:
 *  1. Builds a 72-byte-per-vertex GPU buffer (standard 48 bytes + joints uint8×4 + weights float32×4 + 4 pad).
 *  2. Uploads skeleton.skinMatrices to a per-mesh storage buffer.
 *  3. Draws with the skinned pipeline (group 1 or 2 = skinMatrices).
 *
 * Skinning data (jointIndices / jointWeights) and the skeleton reference
 * are set by the GLTF importer or ShapeManager; the mesh owns them at runtime.
 */
export class SkinnedMesh3D extends Mesh3D {
  /** ID of the associated Skeleton3D node (for serialization). */
  public skeletonId: string | null = null;

  /** Runtime reference to the skeleton that drives this mesh. */
  public skeleton: Skeleton3D | null = null;

  /**
   * Per-vertex joint indices (4 per vertex, packed in groups of 4).
   * Length = (vertex count) × 4.  Values are joint indices into skeleton.data.joints[].
   */
  public jointIndices: Uint8Array = new Uint8Array(0);

  /**
   * Per-vertex joint weights (4 per vertex, packed in groups of 4).
   * Length = (vertex count) × 4.  Each group must sum to 1.0.
   */
  public jointWeights: Float32Array = new Float32Array(0);

  /**
   * True when the GPU skinned-VB needs rebuilding (joint data changed or
   * geometry changed). Set to true by the importer; cleared by the renderer.
   */
  public skinDirty = true;

  constructor(
    interactionService: InteractionService,
    x = 0, y = 0, z = 0,
    config: Mesh3DConfig = {},
  ) {
    super(interactionService, x, y, z, config);
  }

  /** Always true — distinguishes SkinnedMesh3D from plain Mesh3D at runtime. */
  get isSkinned(): true { return true; }

  /** Override to also set skinDirty so the GPU skinned-VB is rebuilt after edit-mesh changes. */
  syncFromEditMesh(): void {
    super.syncFromEditMesh();
    this.skinDirty = true;
  }

  toJSON(): any {
    return {
      ...super.toJSON(),
      type: 'SkinnedMesh3D',
      skeletonId: this.skeletonId,
      jointIndicesB64: toBase64(this.jointIndices.buffer as ArrayBuffer),
      jointWeightsB64: toBase64(this.jointWeights.buffer as ArrayBuffer),
    };
  }
}

// ── Base64 helpers ──────────────────────────────────────────────────────────

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str);
}

function fromBase64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fromBase64ToFloat32(b64: string): Float32Array {
  const u8 = fromBase64ToUint8(b64);
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

export { toBase64, fromBase64ToUint8, fromBase64ToFloat32 };
