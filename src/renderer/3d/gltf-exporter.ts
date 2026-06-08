/**
 * GLTF 2.0 / GLB exporter for Salsa 3D scenes.
 *
 * Exports Mesh3D, SkinnedMesh3D, Skeleton3D, and SkeletonAnimClip data to a
 * self-contained GLB binary blob compatible with Blender, Unity, Unreal, etc.
 *
 * Scope:
 *   - Static and skinned meshes (position, normal, uv, tangent, vertex color)
 *   - Skeleton joint hierarchy with inverse bind matrices
 *   - All animation clips stored on each skeleton (rotation, translation, scale)
 *   - Blend shapes / morph targets (position + normal deltas)
 *
 * Not exported: raster layers, GP objects, particle emitters, post-processing.
 */

import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { FLOATS_PER_VERT } from './mesh-generators';

// ── GLTF / GLB constants ──────────────────────────────────────────────────────

const CT_FLOAT          = 5126;
const CT_UNSIGNED_INT   = 5125;
const CT_UNSIGNED_SHORT = 5123;
const CT_UNSIGNED_BYTE  = 5121;
const BV_ARRAY_BUFFER   = 34962;
const BV_ELEMENT_BUFFER = 34963;

const GLB_MAGIC   = 0x46546C67; // 'glTF'
const CHUNK_JSON  = 0x4E4F534A; // 'JSON'
const CHUNK_BIN   = 0x004E4942; // 'BIN\0'

// Interleaved vertex float offsets (matches FLOATS_PER_VERT = 12)
const V_POS  = 0; // vec3
const V_NORM = 3; // vec3
const V_UV   = 6; // vec2
const V_TAN  = 8; // vec4

// ── Minimal GLTF JSON types ───────────────────────────────────────────────────

interface GltfAccessor {
  bufferView: number;
  byteOffset: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  normalized?: boolean;
}

interface GltfBufferView {
  buffer: 0;
  byteOffset: number;
  byteLength: number;
  target?: number;
}

interface GltfNode {
  name: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  matrix?: number[];
}

interface GltfMeshPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  targets?: Array<Record<string, number>>;
}

interface GltfMesh {
  name: string;
  primitives: GltfMeshPrimitive[];
  extras?: { targetNames: string[] };
  weights?: number[];
}

interface GltfMaterial {
  name: string;
  pbrMetallicRoughness: {
    baseColorFactor: [number, number, number, number];
    metallicFactor: number;
    roughnessFactor: number;
  };
  emissiveFactor: [number, number, number];
  doubleSided: boolean;
  alphaMode?: string;
}

interface GltfSkin {
  name: string;
  joints: number[];
  skeleton?: number;
  inverseBindMatrices: number;
}

interface GltfAnimSampler {
  input: number;
  interpolation: 'LINEAR';
  output: number;
}

interface GltfAnimChannel {
  sampler: number;
  target: { node: number; path: 'translation' | 'rotation' | 'scale' };
}

interface GltfAnimation {
  name: string;
  channels: GltfAnimChannel[];
  samplers: GltfAnimSampler[];
}

interface GltfRoot {
  asset: { version: '2.0'; generator: string };
  scene: 0;
  scenes: Array<{ name: string; nodes: number[] }>;
  nodes: GltfNode[];
  meshes: GltfMesh[];
  materials: GltfMaterial[];
  skins?: GltfSkin[];
  animations?: GltfAnimation[];
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
  buffers: Array<{ byteLength: number }>;
}

// ── Binary buffer accumulator ─────────────────────────────────────────────────

class BinaryBuilder {
  private _chunks: Uint8Array[] = [];
  private _total = 0;

  get byteLength(): number { return this._total; }

  /** Append a typed array slice to the binary buffer. Returns byte offset. */
  write(view: ArrayBufferView): number {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const offset = this._total;
    this._chunks.push(bytes.slice());
    this._total += bytes.byteLength;
    return offset;
  }

  /** Insert zero-padding up to the next `boundary`-byte boundary. */
  align(boundary: number): void {
    const rem = this._total % boundary;
    if (rem === 0) return;
    this._chunks.push(new Uint8Array(boundary - rem));
    this._total += boundary - rem;
  }

  /** Finalize and return an ArrayBuffer padded to a 4-byte boundary with `padByte`. */
  finish(padByte = 0): ArrayBuffer {
    const rem = this._total % 4;
    if (rem !== 0) {
      const pad = new Uint8Array(4 - rem).fill(padByte);
      this._chunks.push(pad);
      this._total += pad.length;
    }
    const result = new Uint8Array(this._total);
    let off = 0;
    for (const c of this._chunks) { result.set(c, off); off += c.length; }
    return result.buffer;
  }
}

// ── Vertex attribute extraction ───────────────────────────────────────────────

/** De-interleave one attribute from an interleaved vertex buffer. */
function extractAttr(
  src: Float32Array,
  floatOff: number,
  components: number,
  vertCount: number,
): Float32Array {
  const out = new Float32Array(vertCount * components);
  for (let i = 0; i < vertCount; i++) {
    for (let c = 0; c < components; c++) {
      out[i * components + c] = src[i * FLOATS_PER_VERT + floatOff + c];
    }
  }
  return out;
}

/** Compute min/max for a tightly-packed VEC3 array (required on POSITION). */
function minMax3(arr: Float32Array, count: number): { min: number[]; max: number[] } {
  let x0 = Infinity,  y0 = Infinity,  z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

// ── Helpers to add accessors / bufferViews ────────────────────────────────────

function addAccessor(
  gltf: GltfRoot,
  bin: BinaryBuilder,
  data: ArrayBufferView,
  componentType: number,
  count: number,
  type: string,
  target?: number,
  minMax?: { min: number[]; max: number[] },
  normalized = false,
): number {
  bin.align(4);
  const byteOffset = bin.write(data);
  const bvIdx = gltf.bufferViews.length;
  const bv: GltfBufferView = { buffer: 0, byteOffset, byteLength: data.byteLength };
  if (target) bv.target = target;
  gltf.bufferViews.push(bv);
  const acc: GltfAccessor = { bufferView: bvIdx, byteOffset: 0, componentType, count, type };
  if (minMax) { acc.min = minMax.min; acc.max = minMax.max; }
  if (normalized) acc.normalized = true;
  gltf.accessors.push(acc);
  return gltf.accessors.length - 1;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface GltfExportResult {
  blob: Blob;
  meshCount: number;
  skeletonCount: number;
  animationCount: number;
  vertexCount: number;
}

/**
 * Export a set of Mesh3D and Skeleton3D objects to a self-contained GLB blob.
 * Pass `sm.scene3d.getAllMeshes()` and `sm.scene3d.getAllSkeletons()`.
 */
export function exportSceneToGlb(
  meshes: Mesh3D[],
  skeletons: Skeleton3D[],
): GltfExportResult {
  const bin = new BinaryBuilder();

  const gltf: GltfRoot = {
    asset: { version: '2.0', generator: 'Salsa' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };

  const sceneRootNodes = gltf.scenes[0].nodes;

  // Maps Skeleton3D.id → { skinIndex, jointToNode }
  const skelMap = new Map<string, { skinIndex: number; jointToNode: Map<number, number> }>();

  // ── 1. Skeletons ─────────────────────────────────────────────────────────────

  const skins: GltfSkin[] = [];
  let totalVerts = 0;

  for (const skel of skeletons) {
    const { joints } = skel.data;
    const n = joints.length;
    if (n === 0) continue;

    const jointToNode = new Map<number, number>();
    const jointNodeIdxs: number[] = [];

    // One GLTF node per joint
    for (let ji = 0; ji < n; ji++) {
      const j = joints[ji];
      const nodeIdx = gltf.nodes.length;
      jointToNode.set(ji, nodeIdx);
      jointNodeIdxs.push(nodeIdx);
      gltf.nodes.push({
        name: j.name || `joint_${ji}`,
        translation: [...j.localPosition] as [number, number, number],
        rotation:    [...j.localRotation] as [number, number, number, number],
        scale:       [...j.localScale]    as [number, number, number],
      });
    }

    // Wire children
    for (let ji = 0; ji < n; ji++) {
      const ch = joints[ji].children;
      if (ch.length > 0) {
        gltf.nodes[jointNodeIdxs[ji]].children = ch.map(ci => jointNodeIdxs[ci]);
      }
    }

    // Root joint(s) into scene root
    const rootIdx = joints.findIndex(j => j.parentIndex === -1);
    if (rootIdx !== -1) sceneRootNodes.push(jointNodeIdxs[rootIdx]);

    // Inverse bind matrices
    const ibm = new Float32Array(n * 16);
    for (let ji = 0; ji < n; ji++) ibm.set(joints[ji].inverseBindMatrix, ji * 16);
    const ibmAccIdx = addAccessor(gltf, bin, ibm, CT_FLOAT, n, 'MAT4');

    const skinIdx = skins.length;
    skins.push({
      name: skel.data.name || `Skeleton_${skinIdx}`,
      joints: jointNodeIdxs,
      skeleton: rootIdx !== -1 ? jointNodeIdxs[rootIdx] : undefined,
      inverseBindMatrices: ibmAccIdx,
    });

    skelMap.set(skel.id, { skinIndex: skinIdx, jointToNode });
  }

  if (skins.length > 0) gltf.skins = skins;

  // ── 2. Meshes ─────────────────────────────────────────────────────────────────

  for (const mesh of meshes) {
    const geom = mesh.geometry;
    const verts = geom.vertices;
    const idxBuf = geom.indices;
    if (!verts || verts.length === 0) continue;

    const vc = verts.length / FLOATS_PER_VERT;
    totalVerts += vc;
    const useShort = vc <= 65535;

    // ── Vertex attributes
    const pos  = extractAttr(verts, V_POS,  3, vc);
    const norm = extractAttr(verts, V_NORM, 3, vc);
    const uv   = extractAttr(verts, V_UV,   2, vc);

    const posAcc  = addAccessor(gltf, bin, pos,  CT_FLOAT, vc, 'VEC3', BV_ARRAY_BUFFER, minMax3(pos, vc));
    const normAcc = addAccessor(gltf, bin, norm, CT_FLOAT, vc, 'VEC3', BV_ARRAY_BUFFER);
    const uvAcc   = addAccessor(gltf, bin, uv,   CT_FLOAT, vc, 'VEC2', BV_ARRAY_BUFFER);

    const attributes: Record<string, number> = {
      POSITION: posAcc,
      NORMAL:   normAcc,
      TEXCOORD_0: uvAcc,
    };

    // Tangent (present when FLOATS_PER_VERT === 12)
    if (FLOATS_PER_VERT === 12) {
      const tan = extractAttr(verts, V_TAN, 4, vc);
      attributes.TANGENT = addAccessor(gltf, bin, tan, CT_FLOAT, vc, 'VEC4', BV_ARRAY_BUFFER);
    }

    // Vertex colors
    if (mesh.vertexColors && mesh.vertexColors.length === vc * 4) {
      attributes.COLOR_0 = addAccessor(gltf, bin, mesh.vertexColors, CT_FLOAT, vc, 'VEC4', BV_ARRAY_BUFFER);
    }

    // Skinning data
    if (mesh instanceof SkinnedMesh3D && mesh.jointIndices && mesh.jointWeights) {
      attributes.JOINTS_0  = addAccessor(gltf, bin, mesh.jointIndices,  CT_UNSIGNED_BYTE, vc, 'VEC4', BV_ARRAY_BUFFER);
      attributes.WEIGHTS_0 = addAccessor(gltf, bin, mesh.jointWeights,  CT_FLOAT,         vc, 'VEC4', BV_ARRAY_BUFFER);
    }

    // ── Blend shapes (morph targets)
    const morphTargets:   Array<Record<string, number>> = [];
    const morphWeights:   number[] = [];
    const morphTargetNames: string[] = [];

    for (let si = 0; si < mesh.blendShapes.length; si++) {
      const bs = mesh.blendShapes[si];
      const deltas = bs.deltaVertices;
      const dpos  = new Float32Array(vc * 3);
      const dnorm = new Float32Array(vc * 3);
      for (let vi = 0; vi < vc; vi++) {
        dpos[vi*3]   = deltas[vi*6];     dpos[vi*3+1]  = deltas[vi*6+1]; dpos[vi*3+2]  = deltas[vi*6+2];
        dnorm[vi*3]  = deltas[vi*6+3];  dnorm[vi*3+1] = deltas[vi*6+4]; dnorm[vi*3+2] = deltas[vi*6+5];
      }
      morphTargets.push({
        POSITION: addAccessor(gltf, bin, dpos,  CT_FLOAT, vc, 'VEC3', BV_ARRAY_BUFFER),
        NORMAL:   addAccessor(gltf, bin, dnorm, CT_FLOAT, vc, 'VEC3', BV_ARRAY_BUFFER),
      });
      morphWeights.push(mesh.blendWeights?.[si] ?? 0);
      morphTargetNames.push(bs.name);
    }

    // ── Build primitive(s)
    let primitives: GltfMeshPrimitive[];

    if (mesh.submeshes && mesh.submeshes.length > 1) {
      // Multi-material: one primitive per submesh
      primitives = mesh.submeshes.map(sub => {
        const sm = sub.material;
        const smMatIdx = gltf.materials.length;
        gltf.materials.push({
          name: `mat_${sub.label ?? 'sub'}_${mesh.id.slice(0, 6)}`,
          pbrMetallicRoughness: {
            baseColorFactor: [sm.diffuse.r, sm.diffuse.g, sm.diffuse.b, sm.opacity ?? 1],
            metallicFactor:  sm.metalness,
            roughnessFactor: sm.roughness,
          },
          emissiveFactor: [sm.emissive.r, sm.emissive.g, sm.emissive.b],
          doubleSided: sm.doubleSided ?? false,
          ...(( sm.opacity ?? 1) < 1 ? { alphaMode: 'BLEND' } : {}),
        });

        // Sub-index accessor
        const subSlice = idxBuf.slice(sub.indexOffset, sub.indexOffset + sub.indexCount);
        const subIdxBuf = useShort ? new Uint16Array(subSlice) : subSlice;
        const subIdxAcc = addAccessor(
          gltf, bin, subIdxBuf,
          useShort ? CT_UNSIGNED_SHORT : CT_UNSIGNED_INT,
          sub.indexCount, 'SCALAR', BV_ELEMENT_BUFFER,
        );
        const prim: GltfMeshPrimitive = { attributes, indices: subIdxAcc, material: smMatIdx };
        if (morphTargets.length > 0) prim.targets = morphTargets;
        return prim;
      });
    } else {
      // Single primitive
      const mat = mesh.material;
      const matIdx = gltf.materials.length;
      gltf.materials.push({
        name: `mat_${mesh.name || mesh.id.slice(0, 6)}`,
        pbrMetallicRoughness: {
          baseColorFactor: [mat.diffuse.r, mat.diffuse.g, mat.diffuse.b, mat.opacity],
          metallicFactor:  mat.metalness,
          roughnessFactor: mat.roughness,
        },
        emissiveFactor: [mat.emissive.r, mat.emissive.g, mat.emissive.b],
        doubleSided: mat.doubleSided ?? false,
        ...(mat.opacity < 1 ? { alphaMode: 'BLEND' } : {}),
      });

      const prim: GltfMeshPrimitive = { attributes, material: matIdx };

      if (idxBuf && idxBuf.length > 0) {
        const idxOut = useShort ? new Uint16Array(idxBuf) : idxBuf;
        prim.indices = addAccessor(
          gltf, bin, idxOut,
          useShort ? CT_UNSIGNED_SHORT : CT_UNSIGNED_INT,
          idxBuf.length, 'SCALAR', BV_ELEMENT_BUFFER,
        );
      }
      if (morphTargets.length > 0) prim.targets = morphTargets;
      primitives = [prim];
    }

    // ── GLTF mesh
    const gltfMeshIdx = gltf.meshes.length;
    const gltfMesh: GltfMesh = { name: mesh.name || `mesh_${gltfMeshIdx}`, primitives };
    if (morphWeights.length > 0) {
      gltfMesh.weights = morphWeights;
      gltfMesh.extras  = { targetNames: morphTargetNames };
    }
    gltf.meshes.push(gltfMesh);

    // ── GLTF node
    const meshNodeIdx = gltf.nodes.length;
    const meshNode: GltfNode = {
      name:   mesh.name || `node_${meshNodeIdx}`,
      mesh:   gltfMeshIdx,
      matrix: Array.from(mesh._localMatrix) as number[],
    };

    if (mesh instanceof SkinnedMesh3D && mesh.skeletonId) {
      const entry = skelMap.get(mesh.skeletonId);
      if (entry) meshNode.skin = entry.skinIndex;
    }

    gltf.nodes.push(meshNode);
    sceneRootNodes.push(meshNodeIdx);
  }

  // ── 3. Animations ─────────────────────────────────────────────────────────────

  const animations: GltfAnimation[] = [];
  let animCount = 0;

  for (const skel of skeletons) {
    const entry = skelMap.get(skel.id);
    if (!entry) continue;
    const { jointToNode } = entry;

    for (const clip of skel.data.clips ?? []) {
      if (clip.tracks.length === 0) continue;

      const channels: GltfAnimChannel[] = [];
      const samplers: GltfAnimSampler[] = [];

      for (const track of clip.tracks) {
        const nodeIdx = jointToNode.get(track.jointIndex);
        if (nodeIdx === undefined || track.keyframes.length === 0) continue;

        const kf = track.keyframes;
        const isRot = track.channel === 'rotation';
        const components = isRot ? 4 : 3;

        // TIME accessor (seconds)
        const times = new Float32Array(kf.length);
        for (let ki = 0; ki < kf.length; ki++) times[ki] = kf[ki].frame / clip.fps;
        const timeAcc = addAccessor(gltf, bin, times, CT_FLOAT, kf.length, 'SCALAR', undefined,
          { min: [times[0]], max: [times[kf.length - 1]] });

        // OUTPUT accessor
        const outputs = new Float32Array(kf.length * components);
        for (let ki = 0; ki < kf.length; ki++) {
          const v = kf[ki].value;
          for (let c = 0; c < components; c++) outputs[ki * components + c] = v[c];
        }
        const outAcc = addAccessor(gltf, bin, outputs, CT_FLOAT, kf.length,
          isRot ? 'VEC4' : 'VEC3');

        const samplerIdx = samplers.length;
        samplers.push({ input: timeAcc, interpolation: 'LINEAR', output: outAcc });

        const path: GltfAnimChannel['target']['path'] =
          track.channel === 'rotation'    ? 'rotation'    :
          track.channel === 'translation' ? 'translation' : 'scale';

        channels.push({ sampler: samplerIdx, target: { node: nodeIdx, path } });
      }

      if (channels.length > 0) {
        animations.push({ name: clip.name, channels, samplers });
        animCount++;
      }
    }
  }

  if (animations.length > 0) gltf.animations = animations;

  // ── 4. Pack GLB ───────────────────────────────────────────────────────────────

  const binBuf = bin.finish(0); // zero-padded to 4-byte boundary

  if (binBuf.byteLength > 0) {
    gltf.buffers.push({ byteLength: binBuf.byteLength });
  }

  // Serialize JSON, pad to 4 bytes with ASCII spaces (0x20)
  const jsonStr   = JSON.stringify(gltf);
  const jsonRaw   = new TextEncoder().encode(jsonStr);
  const jsonPad   = (4 - (jsonRaw.length % 4)) % 4;
  const jsonBytes = new Uint8Array(jsonRaw.length + jsonPad).fill(0x20);
  jsonBytes.set(jsonRaw);

  const binBytes  = new Uint8Array(binBuf);
  const hasBin    = binBytes.length > 0;

  const totalLen = 12
    + 8 + jsonBytes.length
    + (hasBin ? 8 + binBytes.length : 0);

  const glb  = new ArrayBuffer(totalLen);
  const view = new DataView(glb);
  let off = 0;

  // GLB header
  view.setUint32(off, GLB_MAGIC, true);  off += 4;
  view.setUint32(off, 2,         true);  off += 4;
  view.setUint32(off, totalLen,  true);  off += 4;

  // JSON chunk
  view.setUint32(off, jsonBytes.length, true); off += 4;
  view.setUint32(off, CHUNK_JSON,       true); off += 4;
  new Uint8Array(glb, off).set(jsonBytes);     off += jsonBytes.length;

  // BIN chunk (optional — omitted when there is no binary data)
  if (hasBin) {
    view.setUint32(off, binBytes.length, true); off += 4;
    view.setUint32(off, CHUNK_BIN,       true); off += 4;
    new Uint8Array(glb, off).set(binBytes);     off += binBytes.length;
  }

  return {
    blob: new Blob([glb], { type: 'model/gltf-binary' }),
    meshCount:     gltf.meshes.length,
    skeletonCount: skins.length,
    animationCount: animCount,
    vertexCount:   totalVerts,
  };
}
