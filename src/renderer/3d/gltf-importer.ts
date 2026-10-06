/**
 * GLTF/GLB importer — parses binary GLB or JSON+BIN GLTF into MeshGeometry.
 *
 * Handles:
 *   GLB binary container (header + JSON chunk + BIN chunk)
 *   GLTF 2.0 JSON with external/embedded buffers
 *   Static mesh primitives (TRIANGLES mode only — mode 4, the spec default)
 *   POSITION / NORMAL / TEXCOORD_0 / TANGENT vertex attributes
 *   Every accessor component type (i8 / u8 / i16 / u16 / u32 / f32), tightly packed or
 *   interleaved (bufferView.byteStride), honouring accessor.normalized (signed + unsigned)
 *   Sparse accessors (over a bufferView or over zeros) and bufferView-less accessors (= zeros)
 *   u8 / u16 / u32 index buffers
 *   Skinning: JOINTS_0/WEIGHTS_0 (+ JOINTS_1/WEIGHTS_1 reduced to the top 4 by weight)
 *   Morph targets: names from primitive.extras.targetNames or mesh.extras.targetNames,
 *   default weights from mesh.weights (GltfMeshResult.morphWeights)
 *   extensionsRequired guard: unsupported required extensions (Draco, meshopt, ...) throw
 *   Per-node TRS transforms (translation, quaternion rotation, scale, matrix)
 *   Embedded images (bufferView byte ranges + base64 data URIs)
 *   Diffuse texture (baseColorTexture) and normal map (normalTexture) per material
 *   Diffuse color factor (baseColorFactor) from PBR metallic-roughness
 *   Multi-mesh scenes (each node with a mesh → separate GltfMeshResult)
 *   Missing NORMAL / TANGENT → recomputed automatically
 *
 * Not supported (deferred):
 *   External URI buffers/images, animations, compressed geometry (Draco / meshopt),
 *   material extensions (KHR_materials_*, KHR_texture_transform, VRM MToon) are ignored.
 *
 * Output: GltfMeshResult[] — one entry per mesh node, ready for createCustomMesh().
 */

import { MeshGeometry, computeTangents, FLOATS_PER_VERT } from './mesh-generators';
import type { BlendShape } from '../../scene-graph/shapes/mesh-3d';

// ── Public types ───────────────────────────────────────────────────────────

export interface GltfMeshResult {
  /** Node name from the GLTF file. */
  name: string;
  /** 12-float interleaved geometry, ready for createCustomMesh(). */
  geometry: MeshGeometry;
  /** Object-space position from node TRS (metres). */
  position: [number, number, number];
  /** Euler XYZ rotation in radians, derived from node quaternion/matrix. */
  rotation: [number, number, number];
  /** Per-axis scale from node TRS. */
  scale: [number, number, number];
  /** Diffuse texture pixels, or null if the mesh has no texture. */
  diffuseImage: ImageBitmap | null;
  /** Normal map texture pixels, or null if absent. */
  normalMapImage: ImageBitmap | null;
  /** RGBA base-color factor (0–1 each). Defaults to [1,1,1,1]. */
  diffuseColor: [number, number, number, number];
  /** True when alphaMode is BLEND or opacity < 1. */
  isTransparent: boolean;
  /** Morph targets (blend shapes) parsed from prim.targets[]. Empty when absent. */
  morphTargets: BlendShape[];
  /**
   * Default morph weights from mesh.weights (parallel to morphTargets; 0 when absent).
   * Exposed on the import result only — not yet applied to the scene mesh by the importers.
   */
  morphWeights?: number[];
}

// ── Skinning types ─────────────────────────────────────────────────────────

/** Per-mesh skinning data extracted from a GLTF skin. */
export interface GltfSkinningData {
  /** Joint indices per vertex: 4 values × vertexCount (uint8, clamped to 255). */
  jointIndices: Uint8Array;
  /** Blend weights per vertex: 4 values × vertexCount (normalised float). */
  jointWeights: Float32Array;
  /** Inverse bind-pose matrices: 16 floats × jointCount (col-major mat4 per joint). */
  inverseBindMatrices: Float32Array;
  /** Name of each joint (parallel to inverseBindMatrices). */
  jointNames: string[];
  /** The gltf skin name. */
  skinName: string;
  /** Parent index per joint (-1 for roots). Length = jointCount. */
  jointParents: Int16Array;
  /** Local translation per joint: 3 floats × jointCount. */
  jointLocalPositions: Float32Array;
  /** Local rotation per joint (quaternion xyzw): 4 floats × jointCount. */
  jointLocalRotations: Float32Array;
  /** Local scale per joint: 3 floats × jointCount. */
  jointLocalScales: Float32Array;
}

/** GltfMeshResult extended with skeletal skinning data. */
export interface GltfSkinnedResult extends GltfMeshResult {
  skinning: GltfSkinningData;
}

// ── Entry points ───────────────────────────────────────────────────────────

/**
 * Parse a .glb ArrayBuffer into mesh results.
 * This is the primary entry point for drag-and-drop File import.
 */
export async function parseGLB(buffer: ArrayBuffer): Promise<GltfMeshResult[]> {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546C67) throw new Error('Not a valid GLB file');
  if (view.getUint32(4, true) !== 2)           throw new Error('Only GLTF 2.0 is supported');

  let offset = 12;
  let jsonText = '';
  let binChunk: ArrayBuffer | null = null;

  while (offset < buffer.byteLength) {
    const chunkLen  = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;

    if (chunkType === 0x4E4F534A) {              // JSON chunk
      jsonText = new TextDecoder().decode(new Uint8Array(buffer, offset, chunkLen));
    } else if (chunkType === 0x004E4942) {        // BIN chunk
      binChunk = buffer.slice(offset, offset + chunkLen);
    }
    offset += chunkLen;
  }

  if (!jsonText) throw new Error('GLB contains no JSON chunk');
  const json = JSON.parse(jsonText) as GltfJson;
  const binaries = binChunk ? [binChunk] : [];
  return buildResults(json, binaries);
}

/**
 * Parse a GLTF JSON string with an optional pre-loaded binary buffer.
 * Use this when the .gltf and .bin files have been loaded separately.
 */
export async function parseGLTF(
  jsonText: string,
  binaries: ArrayBuffer[] = [],
): Promise<GltfMeshResult[]> {
  const json = JSON.parse(jsonText) as GltfJson;

  // Resolve base64 data URIs embedded directly in the JSON buffers array
  const resolved: ArrayBuffer[] = [...binaries];
  for (let i = resolved.length; i < (json.buffers?.length ?? 0); i++) {
    const buf = json.buffers![i];
    if (buf.uri?.startsWith('data:')) {
      resolved[i] = decodeDataUri(buf.uri);
    }
  }

  return buildResults(json, resolved);
}

// ── Internal GLTF types ────────────────────────────────────────────────────

interface GltfJson {
  asset:       { version: string };
  extensionsUsed?:     string[];
  extensionsRequired?: string[];
  scene?:      number;
  scenes?:     { nodes?: number[] }[];
  nodes?:      GltfNode[];
  meshes?:     GltfMesh[];
  skins?:      GltfSkin[];
  accessors?:  GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?:    { uri?: string; byteLength: number }[];
  materials?:  GltfMaterial[];
  textures?:   { source?: number }[];
  images?:     { uri?: string; mimeType?: string; bufferView?: number }[];
}

interface GltfNode {
  name?:        string;
  mesh?:        number;
  skin?:        number;  // index into json.skins[]
  children?:    number[];
  translation?: [number, number, number];
  rotation?:    [number, number, number, number]; // quaternion xyzw
  scale?:       [number, number, number];
  matrix?:      number[];                          // col-major mat4, 16 values
}

interface GltfSkin {
  name?:                string;
  joints:               number[];            // node indices of joints
  inverseBindMatrices?: number;              // accessor index → mat4[joints.length]
}

interface GltfMesh {
  name?:       string;
  primitives:  GltfPrimitive[];
  weights?:    number[];   // default morph target weights
  extras?:     { targetNames?: string[] };
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?:   number;
  material?:  number;
  mode?:      number;  // 4 = TRIANGLES (default)
  targets?:   Array<Record<string, number>>;  // morph target attribute accessors
  extras?:    { targetNames?: string[] };
}

interface GltfAccessor {
  bufferView?:    number;
  byteOffset?:    number;
  componentType:  number;
  count:          number;
  type:           string;
  normalized?:    boolean;
  sparse?: {
    count:   number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values:  { bufferView: number; byteOffset?: number };
  };
}

interface GltfBufferView {
  buffer:      number;
  byteOffset?: number;
  byteLength:  number;
  byteStride?: number;
}

interface GltfMaterial {
  name?:   string;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  pbrMetallicRoughness?: {
    baseColorFactor?:   [number, number, number, number];
    baseColorTexture?:  { index: number };
  };
  normalTexture?: { index: number };
}

// ── Constants ──────────────────────────────────────────────────────────────

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};
const TYPE_COUNT: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

// ── Core builder ───────────────────────────────────────────────────────────

// ── Debug switch ───────────────────────────────────────────────────────────
// Set to true to bake IDENTITY instead of the real worldMat.
// If the model looks correctly assembled with this on, the GLB vertices are
// already in world space and we have a double-transform.
// If all parts collapse to the same origin, the worldMat is needed but wrong.
const DEBUG_SKIP_WORLD_TRANSFORM = false;

async function buildResults(
  json: GltfJson,
  binaries: ArrayBuffer[],
): Promise<GltfMeshResult[]> {
  assertRequiredExtensionsSupported(json);
  const results: GltfMeshResult[] = [];
  if (!json.meshes || json.meshes.length === 0) return results;

  // Gather all nodes that carry a mesh, traversing from scene root
  const rootNodes = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const identityMat = mat4Identity();

  console.log('[GLTF hierarchy] scene rootNodes:', rootNodes,
    '  totalNodes:', json.nodes?.length ?? 0,
    '  totalMeshes:', json.meshes.length);

  function visitNode(nodeIdx: number, parentMat: number[], depth = 0): void {
    const node = json.nodes?.[nodeIdx];
    if (!node) return;

    const localMat = nodeLocalMatrix(node);
    const worldMat = mat4Mul(parentMat, localMat);
    const effectiveMat = DEBUG_SKIP_WORLD_TRANSFORM ? identityMat : worldMat;

    const hasMesh = node.mesh !== undefined;
    const tx = worldMat[12].toFixed(3), ty = worldMat[13].toFixed(3), tz = worldMat[14].toFixed(3);
    const sx = Math.sqrt(worldMat[0]**2+worldMat[1]**2+worldMat[2]**2).toFixed(3);
    console.log(`${'  '.repeat(depth)}node[${nodeIdx}] "${node.name ?? ''}"  mesh=${hasMesh ? node.mesh : '-'}  worldT=(${tx},${ty},${tz})  worldScale≈${sx}`);

    if (hasMesh && json.meshes![node.mesh!]) {
      const mesh = json.meshes![node.mesh!];
      for (const prim of mesh.primitives) {
        if ((prim.mode ?? 4) !== 4) continue;  // skip non-triangle primitives
        const result = buildPrimitive(json, binaries, node, mesh, prim, effectiveMat);
        if (result) results.push(result);
      }
    }
    for (const child of node.children ?? []) {
      visitNode(child, worldMat, depth + 1);
    }
  }

  if (rootNodes.length > 0) {
    for (const n of rootNodes) visitNode(n, identityMat);
  } else {
    // Fallback: import all meshes directly with no transform
    for (let mi = 0; mi < json.meshes.length; mi++) {
      const mesh = json.meshes[mi];
      for (const prim of mesh.primitives) {
        if ((prim.mode ?? 4) !== 4) continue;
        const result = buildPrimitive(
          json, binaries,
          { name: mesh.name },
          mesh, prim,
          identityMat,
        );
        if (result) results.push(result);
      }
    }
  }

  // Async: resolve images for each result
  await resolveImages(results, json, binaries);
  return results;
}

function buildPrimitive(
  json: GltfJson,
  binaries: ArrayBuffer[],
  node: Pick<GltfNode, 'name' | 'translation' | 'rotation' | 'scale' | 'matrix'>,
  mesh: GltfMesh,
  prim: GltfPrimitive,
  worldMat: number[],
): GltfMeshResult | null {
  // ── Read indices ─────────────────────────────────────────────────
  let indices32: Uint32Array;
  if (prim.indices !== undefined) {
    const raw = readAccessorRaw(json, binaries, prim.indices);
    if (raw instanceof Uint32Array) {
      indices32 = raw;
    } else if (raw instanceof Uint16Array || raw instanceof Uint8Array) {
      indices32 = new Uint32Array(raw.length);
      for (let i = 0; i < raw.length; i++) indices32[i] = raw[i];
    } else {
      return null;
    }
  } else {
    // Non-indexed: generate sequential indices
    const posAcc = json.accessors?.[prim.attributes['POSITION']];
    if (!posAcc) return null;
    indices32 = new Uint32Array(posAcc.count);
    for (let i = 0; i < posAcc.count; i++) indices32[i] = i;
  }

  // ── Read vertex attributes ────────────────────────────────────────
  const posRaw  = prim.attributes['POSITION']   !== undefined
    ? readAccessorFloat32(json, binaries, prim.attributes['POSITION'])  : null;
  const nrmRaw  = prim.attributes['NORMAL']     !== undefined
    ? readAccessorFloat32(json, binaries, prim.attributes['NORMAL'])    : null;
  const uvRaw   = prim.attributes['TEXCOORD_0'] !== undefined
    ? readAccessorFloat32(json, binaries, prim.attributes['TEXCOORD_0']): null;
  const tanRaw  = prim.attributes['TANGENT']    !== undefined
    ? readAccessorFloat32(json, binaries, prim.attributes['TANGENT'])   : null;

  if (!posRaw) return null;
  const vertCount = posRaw.length / 3;

  // ── Assemble 8-float layout: pos(3) + normal(3) + uv(2) ──────────
  const verts8 = new Float32Array(vertCount * 8);
  for (let vi = 0; vi < vertCount; vi++) {
    const o8 = vi * 8;
    verts8[o8]     = posRaw[vi * 3];
    verts8[o8 + 1] = posRaw[vi * 3 + 1];
    verts8[o8 + 2] = posRaw[vi * 3 + 2];

    if (nrmRaw) {
      verts8[o8 + 3] = nrmRaw[vi * 3];
      verts8[o8 + 4] = nrmRaw[vi * 3 + 1];
      verts8[o8 + 5] = nrmRaw[vi * 3 + 2];
    }

    if (uvRaw) {
      verts8[o8 + 6] = uvRaw[vi * 2];
      verts8[o8 + 7] = uvRaw[vi * 2 + 1];
    }
  }

  const geom8: MeshGeometry = { vertices: verts8, indices: indices32, format: '8float' };
  if (!nrmRaw) recomputeNormals(verts8, indices32);

  // Bake world transform directly into vertex data, then return identity TRS.
  // This avoids the worldMatrix → decompose → TRS → recompose roundtrip which
  // introduces errors when parent nodes have rotation + scale (shear, Euler drift).
  // After baking, all mesh parts share a common world-space vertex basis so
  // autoScaleToFit measures true world extents and preserves relative layout.
  let geometry: MeshGeometry;
  if (tanRaw) {
    // GLTF provides tangents as VEC4 (xyz = tangent, w = handedness)
    const v12 = new Float32Array(vertCount * FLOATS_PER_VERT);
    for (let vi = 0; vi < vertCount; vi++) {
      const o8 = vi * 8, o12 = vi * FLOATS_PER_VERT;
      v12[o12]     = verts8[o8];     v12[o12 + 1] = verts8[o8 + 1]; v12[o12 + 2] = verts8[o8 + 2];
      v12[o12 + 3] = verts8[o8 + 3]; v12[o12 + 4] = verts8[o8 + 4]; v12[o12 + 5] = verts8[o8 + 5];
      v12[o12 + 6] = verts8[o8 + 6]; v12[o12 + 7] = verts8[o8 + 7];
      v12[o12 + 8] = tanRaw[vi * 4]; v12[o12 + 9] = tanRaw[vi * 4 + 1];
      v12[o12 + 10] = tanRaw[vi * 4 + 2]; v12[o12 + 11] = tanRaw[vi * 4 + 3];
    }
    bakeWorldTransform(v12, 12, worldMat);
    geometry = { vertices: v12, indices: indices32, format: '12float' };
  } else {
    bakeWorldTransform(verts8, 8, worldMat);
    geometry = computeTangents(geom8);
  }

  // ── Material metadata ─────────────────────────────────────────────
  const mat = prim.material !== undefined ? json.materials?.[prim.material] : undefined;
  const pbr = mat?.pbrMetallicRoughness;
  const diffuseColor: [number, number, number, number] =
    pbr?.baseColorFactor ?? [1, 1, 1, 1];
  const isTransparent = mat?.alphaMode === 'BLEND' || diffuseColor[3] < 1;

  // ── Morph targets ─────────────────────────────────────────────────
  const morphTargets: BlendShape[] = [];
  const morphWeights: number[] = [];
  if (prim.targets && prim.targets.length > 0) {
    // Per-primitive names win (some exporters, incl. VRM tooling, write them there).
    const targetNames = prim.extras?.targetNames ?? mesh.extras?.targetNames;
    for (let ti = 0; ti < prim.targets.length; ti++) morphWeights.push(mesh.weights?.[ti] ?? 0);
    for (let ti = 0; ti < prim.targets.length; ti++) {
      const target = prim.targets[ti];
      const posDelta = target['POSITION'] !== undefined
        ? readAccessorFloat32(json, binaries, target['POSITION']) : null;
      const nrmDelta = target['NORMAL']   !== undefined
        ? readAccessorFloat32(json, binaries, target['NORMAL'])   : null;

      const delta6 = new Float32Array(vertCount * 6);
      for (let vi = 0; vi < vertCount; vi++) {
        if (posDelta) {
          delta6[vi*6]     = posDelta[vi*3];
          delta6[vi*6 + 1] = posDelta[vi*3 + 1];
          delta6[vi*6 + 2] = posDelta[vi*3 + 2];
        }
        if (nrmDelta) {
          delta6[vi*6 + 3] = nrmDelta[vi*3];
          delta6[vi*6 + 4] = nrmDelta[vi*3 + 1];
          delta6[vi*6 + 5] = nrmDelta[vi*3 + 2];
        }
      }
      bakeWorldTransformDeltas(delta6, worldMat);
      morphTargets.push({
        name: targetNames?.[ti] ?? `shape_${ti}`,
        deltaVertices: delta6,
      });
    }
  }

  return {
    name: node.name ?? mesh.name ?? 'Mesh',
    geometry,
    // World transform is baked into vertex data — TRS is identity.
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale:    [1, 1, 1],
    diffuseImage: null,   // filled in by resolveImages()
    normalMapImage: null,
    diffuseColor,
    isTransparent,
    morphTargets,
    morphWeights,
    // Stash texture indices for resolveImages() to pick up
    _diffuseTexIdx:  pbr?.baseColorTexture?.index ?? -1,
    _normalMapTexIdx: mat?.normalTexture?.index   ?? -1,
  } as GltfMeshResult & { _diffuseTexIdx: number; _normalMapTexIdx: number };
}

// ── Image resolution (async) ───────────────────────────────────────────────

async function resolveImages(
  results: GltfMeshResult[],
  json: GltfJson,
  binaries: ArrayBuffer[],
): Promise<void> {
  // Build a shared image cache so the same image isn't decoded twice
  const imageCache = new Map<number, ImageBitmap | null>();

  async function getImage(texIdx: number): Promise<ImageBitmap | null> {
    if (texIdx < 0) return null;
    const srcIdx = json.textures?.[texIdx]?.source;
    if (srcIdx === undefined) return null;
    if (imageCache.has(srcIdx)) return imageCache.get(srcIdx)!;

    const img = json.images?.[srcIdx];
    if (!img) { imageCache.set(srcIdx, null); return null; }

    try {
      let blob: Blob;
      if (img.bufferView !== undefined) {
        const bv = json.bufferViews![img.bufferView];
        const buf = binaries[bv.buffer];
        if (!buf) { imageCache.set(srcIdx, null); return null; }
        const bytes = new Uint8Array(buf, bv.byteOffset ?? 0, bv.byteLength);
        blob = new Blob([bytes], { type: img.mimeType ?? 'image/png' });
      } else if (img.uri?.startsWith('data:')) {
        const ab = decodeDataUri(img.uri);
        const mime = img.uri.slice(5, img.uri.indexOf(';'));
        blob = new Blob([ab], { type: mime });
      } else {
        imageCache.set(srcIdx, null); return null;  // external URI not supported
      }
      const bitmap = await createImageBitmap(blob);
      imageCache.set(srcIdx, bitmap);
      return bitmap;
    } catch {
      imageCache.set(srcIdx, null);
      return null;
    }
  }

  for (const r of results) {
    const ext = r as GltfMeshResult & { _diffuseTexIdx?: number; _normalMapTexIdx?: number };
    r.diffuseImage   = await getImage(ext._diffuseTexIdx   ?? -1);
    r.normalMapImage = await getImage(ext._normalMapTexIdx ?? -1);
    delete (ext as any)._diffuseTexIdx;
    delete (ext as any)._normalMapTexIdx;
  }
}

// ── Accessor reading ───────────────────────────────────────────────────────

/** Any typed array an accessor can decode to (one per glTF componentType). */
type AccessorArray = Float32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array | Int8Array;

type AccessorCtor = new (lengthOrBuffer: number | ArrayBuffer) => AccessorArray;

const COMPONENT_CTOR: Record<number, AccessorCtor> = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};

/**
 * Read `elemCount` elements of `numComps` components each, starting at `byteOffset` in `buf`.
 * Tightly packed data is copied with one slice (so the result is always aligned); a
 * `byteStride` larger than the element size is deinterleaved with a DataView.
 * Returns null when the type is unknown or the range runs past the end of the buffer.
 */
function readComponents(
  buf: ArrayBuffer,
  byteOffset: number,
  componentType: number,
  elemCount: number,
  numComps: number,
  byteStride?: number,
): AccessorArray | null {
  const Ctor = COMPONENT_CTOR[componentType];
  const compSize = COMPONENT_SIZE[componentType];
  if (!Ctor || !compSize) return null;
  const elemSize = compSize * numComps;
  const stride = byteStride && byteStride > 0 ? byteStride : elemSize;
  const lastByte = elemCount > 0 ? byteOffset + (elemCount - 1) * stride + elemSize : byteOffset;
  if (lastByte > buf.byteLength) {
    console.warn(`[GLTF] accessor range ${byteOffset}..${lastByte} exceeds buffer (${buf.byteLength} bytes)`);
    return null;
  }

  if (stride === elemSize) {
    return new Ctor(buf.slice(byteOffset, byteOffset + elemCount * elemSize));
  }

  const out = new Ctor(elemCount * numComps);
  const dv = new DataView(buf);
  let get: (o: number) => number;
  switch (componentType) {
    case 5120: get = (o) => dv.getInt8(o); break;
    case 5121: get = (o) => dv.getUint8(o); break;
    case 5122: get = (o) => dv.getInt16(o, true); break;
    case 5123: get = (o) => dv.getUint16(o, true); break;
    case 5125: get = (o) => dv.getUint32(o, true); break;
    default:   get = (o) => dv.getFloat32(o, true);
  }
  for (let el = 0; el < elemCount; el++) {
    const src = byteOffset + el * stride;
    for (let c = 0; c < numComps; c++) out[el * numComps + c] = get(src + c * compSize);
  }
  return out;
}

/**
 * Decode an accessor into a typed array of its own component type (no normalisation).
 *  - No bufferView: zeros (glTF spec; common for morph targets, usually with `sparse`).
 *  - `sparse`: the listed elements are replaced over the base (bufferView data or zeros).
 */
function readAccessorRaw(
  json: GltfJson,
  binaries: ArrayBuffer[],
  accIdx: number,
): AccessorArray | null {
  const acc = json.accessors?.[accIdx];
  if (!acc) return null;
  const Ctor = COMPONENT_CTOR[acc.componentType];
  if (!Ctor) return null;
  const numComps = TYPE_COUNT[acc.type] ?? 1;

  let out: AccessorArray | null;
  if (acc.bufferView === undefined) {
    out = new Ctor(acc.count * numComps);
  } else {
    const bv  = json.bufferViews?.[acc.bufferView];
    const buf = bv ? binaries[bv.buffer] : undefined;
    if (!bv || !buf) return null;
    out = readComponents(
      buf, (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0),
      acc.componentType, acc.count, numComps, bv.byteStride,
    );
    if (!out) return null;
  }

  const sp = acc.sparse;
  if (sp && sp.count > 0) {
    const ibv = json.bufferViews?.[sp.indices.bufferView];
    const vbv = json.bufferViews?.[sp.values.bufferView];
    const ibuf = ibv ? binaries[ibv.buffer] : undefined;
    const vbuf = vbv ? binaries[vbv.buffer] : undefined;
    if (!ibv || !vbv || !ibuf || !vbuf) return out;
    const idx = readComponents(
      ibuf, (ibv.byteOffset ?? 0) + (sp.indices.byteOffset ?? 0), sp.indices.componentType, sp.count, 1,
    );
    const vals = readComponents(
      vbuf, (vbv.byteOffset ?? 0) + (sp.values.byteOffset ?? 0), acc.componentType, sp.count, numComps,
    );
    if (!idx || !vals) return out;
    for (let i = 0; i < sp.count; i++) {
      const target = idx[i];
      if (target >= acc.count) continue;
      for (let c = 0; c < numComps; c++) out[target * numComps + c] = vals[i * numComps + c];
    }
  }
  return out;
}

/**
 * Decode an accessor to floats. Integer data is normalised only when `accessor.normalized`
 * is set (glTF formulas: u8 c/255, u16 c/65535, i8 max(c/127,-1), i16 max(c/32767,-1));
 * otherwise integers convert as-is (KHR_mesh_quantization style).
 * `forceNormalized` treats integer data as normalised even without the flag. It is used for
 * WEIGHTS_n, which the spec only allows as float or normalised u8/u16.
 */
function readAccessorFloat32(
  json: GltfJson,
  binaries: ArrayBuffer[],
  accIdx: number,
  forceNormalized = false,
): Float32Array | null {
  const acc = json.accessors?.[accIdx];
  if (!acc) return null;
  const raw = readAccessorRaw(json, binaries, accIdx);
  if (!raw) return null;
  if (raw instanceof Float32Array) return raw;

  const out = new Float32Array(raw.length);
  if (!(acc.normalized || forceNormalized)) {
    for (let i = 0; i < raw.length; i++) out[i] = raw[i];
    return out;
  }
  switch (acc.componentType) {
    case 5121: for (let i = 0; i < raw.length; i++) out[i] = raw[i] / 255; break;
    case 5123: for (let i = 0; i < raw.length; i++) out[i] = raw[i] / 65535; break;
    case 5120: for (let i = 0; i < raw.length; i++) out[i] = Math.max(raw[i] / 127, -1); break;
    case 5122: for (let i = 0; i < raw.length; i++) out[i] = Math.max(raw[i] / 32767, -1); break;
    default:   for (let i = 0; i < raw.length; i++) out[i] = raw[i];  // u32 cannot be normalised
  }
  return out;
}

// ── Extension guard ────────────────────────────────────────────────────────

/** Required extensions the importer can honour (geometry decodes correctly). */
const SUPPORTED_REQUIRED_EXTENSIONS = new Set<string>([
  'KHR_mesh_quantization',          // integer attributes, handled via componentType + normalized
]);

/**
 * Required extensions that only change shading. Ignoring them gives correct geometry with a
 * simplified look, so they are accepted with a warning rather than rejected.
 */
const SHADING_ONLY_REQUIRED_EXTENSIONS = new Set<string>([
  'KHR_texture_transform',
  'KHR_materials_unlit',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_volume',
  'KHR_materials_clearcoat',
  'KHR_materials_sheen',
]);

/**
 * glTF spec: a loader that does not support an extension in `extensionsRequired` must fail.
 * Throws a clear error instead of importing garbage (e.g. Draco-compressed vertex data).
 * Extensions listed only in `extensionsUsed` are ignored.
 */
function assertRequiredExtensionsSupported(json: GltfJson): void {
  const required = json.extensionsRequired ?? [];
  const unsupported: string[] = [];
  for (const ext of required) {
    if (SUPPORTED_REQUIRED_EXTENSIONS.has(ext)) continue;
    if (SHADING_ONLY_REQUIRED_EXTENSIONS.has(ext)) {
      console.warn(`[GLTF] required extension ${ext} is ignored (shading only)`);
      continue;
    }
    unsupported.push(ext);
  }
  if (unsupported.length === 0) return;
  const compressed = unsupported.some(e => e === 'KHR_draco_mesh_compression' || e === 'EXT_meshopt_compression'
    || e === 'KHR_meshopt_compression');
  throw new Error(
    `glTF import failed: the file requires unsupported extension(s): ${unsupported.join(', ')}.`
    + (compressed
      ? ' Re-export the model without mesh compression (e.g. gltf-transform copy, or Blender export with Draco off).'
      : ''),
  );
}

// ── Skin influences ────────────────────────────────────────────────────────

/**
 * Read JOINTS_0/WEIGHTS_0 (and JOINTS_1/WEIGHTS_1 when present) into the engine's fixed
 * 4-influence layout. With 8 influences the top 4 by weight are kept and renormalised.
 * Joint indices are integers (never normalised) clamped to u8.
 */
function readSkinInfluences(
  json: GltfJson,
  binaries: ArrayBuffer[],
  prim: GltfPrimitive,
  numVerts: number,
): { jointIndices: Uint8Array; jointWeights: Float32Array } {
  const jointIndices = new Uint8Array(numVerts * 4);
  const jointWeights = new Float32Array(numVerts * 4);
  const a = prim.attributes;
  const j0 = a['JOINTS_0']  !== undefined ? readAccessorRaw(json, binaries, a['JOINTS_0']) : null;
  const w0 = a['WEIGHTS_0'] !== undefined ? readAccessorFloat32(json, binaries, a['WEIGHTS_0'], true) : null;
  const j1 = a['JOINTS_1']  !== undefined ? readAccessorRaw(json, binaries, a['JOINTS_1']) : null;
  const w1 = a['WEIGHTS_1'] !== undefined ? readAccessorFloat32(json, binaries, a['WEIGHTS_1'], true) : null;

  if (!j1 || !w1) {
    if (j0) for (let i = 0; i < numVerts * 4; i++) jointIndices[i] = Math.min(255, j0[i] ?? 0);
    if (w0) jointWeights.set(w0.subarray(0, numVerts * 4));
    return { jointIndices, jointWeights };
  }

  const js = new Array<number>(8), ws = new Array<number>(8);
  for (let v = 0; v < numVerts; v++) {
    // Gather up to 8 influences, merging duplicate joints.
    let n = 0;
    for (let k = 0; k < 8; k++) {
      const j = k < 4 ? (j0?.[v * 4 + k] ?? 0) : j1[v * 4 + k - 4] ?? 0;
      const w = k < 4 ? (w0?.[v * 4 + k] ?? 0) : w1[v * 4 + k - 4] ?? 0;
      if (!(w > 0)) continue;
      let m = 0;
      while (m < n && js[m] !== j) m++;
      if (m < n) ws[m] += w;
      else { js[n] = j; ws[n] = w; n++; }
    }
    // Partial selection sort: top 4 by weight.
    const keep = Math.min(4, n);
    let sum = 0;
    for (let s = 0; s < keep; s++) {
      let best = s;
      for (let t = s + 1; t < n; t++) if (ws[t] > ws[best]) best = t;
      if (best !== s) {
        const tj = js[s]; js[s] = js[best]; js[best] = tj;
        const tw = ws[s]; ws[s] = ws[best]; ws[best] = tw;
      }
      sum += ws[s];
    }
    for (let s = 0; s < keep; s++) {
      jointIndices[v * 4 + s] = Math.min(255, js[s]);
      jointWeights[v * 4 + s] = sum > 0 ? ws[s] / sum : 0;
    }
  }
  return { jointIndices, jointWeights };
}

// ── Geometry helpers ───────────────────────────────────────────────────────

function recomputeNormals(verts: Float32Array, indices: Uint32Array): void {
  const S = 8;
  for (let i = 3; i < verts.length; i += S) { verts[i] = 0; verts[i+1] = 0; verts[i+2] = 0; }
  for (let i = 0; i < indices.length; i += 3) {
    const b0 = indices[i]*S, b1 = indices[i+1]*S, b2 = indices[i+2]*S;
    const ax = verts[b1]-verts[b0],   ay = verts[b1+1]-verts[b0+1], az = verts[b1+2]-verts[b0+2];
    const bx = verts[b2]-verts[b0],   by = verts[b2+1]-verts[b0+1], bz = verts[b2+2]-verts[b0+2];
    const nx = ay*bz-az*by, ny = az*bx-ax*bz, nz = ax*by-ay*bx;
    for (const b of [b0, b1, b2]) { verts[b+3]+=nx; verts[b+4]+=ny; verts[b+5]+=nz; }
  }
  for (let vi = 0, o = 0; vi < verts.length/S; vi++, o += S) {
    const nx = verts[o+3], ny = verts[o+4], nz = verts[o+5];
    const l = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
    verts[o+3] = nx/l; verts[o+4] = ny/l; verts[o+5] = nz/l;
  }
}

// ── Transform helpers ──────────────────────────────────────────────────────

function nodeLocalMatrix(node: Pick<GltfNode, 'translation'|'rotation'|'scale'|'matrix'>): number[] {
  if (node.matrix && node.matrix.length === 16) return [...node.matrix];
  const t = node.translation ?? [0, 0, 0];
  const q = node.rotation    ?? [0, 0, 0, 1];
  const s = node.scale       ?? [1, 1, 1];
  return trsToMat4(t, q, s);
}

function mat4Identity(): number[] {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

function mat4Mul(a: number[], b: number[]): number[] {
  // Column-major mat4 multiply: result = a * b
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k*4 + row] * b[col*4 + k];
      }
      out[col*4 + row] = sum;
    }
  }
  return out;
}

/** TRS components → col-major mat4 */
function trsToMat4(
  t: [number,number,number],
  q: [number,number,number,number],
  s: [number,number,number],
): number[] {
  const [qx, qy, qz, qw] = q;
  const x2=qx+qx, y2=qy+qy, z2=qz+qz;
  const xx=qx*x2, xy=qx*y2, xz=qx*z2;
  const yy=qy*y2, yz=qy*z2, zz=qz*z2;
  const wx=qw*x2, wy=qw*y2, wz=qw*z2;
  // col-major: m[col*4 + row]
  return [
    (1-(yy+zz))*s[0], (xy+wz)*s[0],     (xz-wy)*s[0],     0,
    (xy-wz)*s[1],     (1-(xx+zz))*s[1], (yz+wx)*s[1],     0,
    (xz+wy)*s[2],     (yz-wx)*s[2],     (1-(xx+yy))*s[2], 0,
    t[0],             t[1],             t[2],             1,
  ];
}

/**
 * Bake the rotation+scale part of a col-major mat4 into morph-target deltas.
 * Layout: 6 floats per vertex — dX dY dZ dNX dNY dNZ.
 * Position deltas use the 3×3 rotation+scale (no translation — they're deltas).
 * Normal deltas use the inverse-transpose of the 3×3 (same as bakeWorldTransform).
 * Normal deltas are NOT renormalized: they are additive and small; the GPU normalizes
 * base+delta in the vertex shader.
 */
function bakeWorldTransformDeltas(deltas: Float32Array, m: number[]): void {
  const sx2 = m[0]*m[0] + m[1]*m[1] + m[2]*m[2] || 1;
  const sy2 = m[4]*m[4] + m[5]*m[5] + m[6]*m[6] || 1;
  const sz2 = m[8]*m[8] + m[9]*m[9] + m[10]*m[10] || 1;
  for (let i = 0; i < deltas.length; i += 6) {
    const px = deltas[i], py = deltas[i+1], pz = deltas[i+2];
    deltas[i]   = m[0]*px + m[4]*py + m[8]*pz;
    deltas[i+1] = m[1]*px + m[5]*py + m[9]*pz;
    deltas[i+2] = m[2]*px + m[6]*py + m[10]*pz;
    const nx = deltas[i+3], ny = deltas[i+4], nz = deltas[i+5];
    deltas[i+3] = m[0]*nx/sx2 + m[4]*ny/sy2 + m[8]*nz/sz2;
    deltas[i+4] = m[1]*nx/sx2 + m[5]*ny/sy2 + m[9]*nz/sz2;
    deltas[i+5] = m[2]*nx/sx2 + m[6]*ny/sy2 + m[10]*nz/sz2;
  }
}

/**
 * Bake a col-major mat4 world transform into a flat vertex array in-place.
 * stride=8  → layout: pos(3) normal(3) uv(2)          (geom8)
 * stride=12 → layout: pos(3) normal(3) uv(2) tangent(4) (geom12)
 *
 * Positions are transformed by the full 4×4 matrix.
 * Normals and tangent.xyz are transformed by the inverse-transpose of the
 * upper-3×3 (= R × S⁻¹), then renormalized. Tangent.w (handedness) is unchanged.
 */
function bakeWorldTransform(verts: Float32Array, stride: 8 | 12, m: number[]): void {
  const sx2 = m[0]*m[0] + m[1]*m[1] + m[2]*m[2] || 1;  // |col0|²
  const sy2 = m[4]*m[4] + m[5]*m[5] + m[6]*m[6] || 1;  // |col1|²
  const sz2 = m[8]*m[8] + m[9]*m[9] + m[10]*m[10] || 1; // |col2|²
  for (let i = 0; i < verts.length; i += stride) {
    // Position: full affine transform
    const px = verts[i], py = verts[i+1], pz = verts[i+2];
    verts[i]   = m[0]*px + m[4]*py + m[8]*pz  + m[12];
    verts[i+1] = m[1]*px + m[5]*py + m[9]*pz  + m[13];
    verts[i+2] = m[2]*px + m[6]*py + m[10]*pz + m[14];
    // Normal: inverse-transpose of upper-3×3 (M/|col|²), then renormalize
    const nx = verts[i+3], ny = verts[i+4], nz = verts[i+5];
    let rnx = m[0]*nx/sx2 + m[4]*ny/sy2 + m[8]*nz/sz2;
    let rny = m[1]*nx/sx2 + m[5]*ny/sy2 + m[9]*nz/sz2;
    let rnz = m[2]*nx/sx2 + m[6]*ny/sy2 + m[10]*nz/sz2;
    const nl = Math.sqrt(rnx*rnx + rny*rny + rnz*rnz) || 1;
    verts[i+3] = rnx/nl; verts[i+4] = rny/nl; verts[i+5] = rnz/nl;
    // Tangent (stride-12 only): same rotation as normal, w unchanged
    if (stride === 12) {
      const tx = verts[i+8], ty = verts[i+9], tz = verts[i+10];
      let rtx = m[0]*tx/sx2 + m[4]*ty/sy2 + m[8]*tz/sz2;
      let rty = m[1]*tx/sx2 + m[5]*ty/sy2 + m[9]*tz/sz2;
      let rtz = m[2]*tx/sx2 + m[6]*ty/sy2 + m[10]*tz/sz2;
      const tl = Math.sqrt(rtx*rtx + rty*rty + rtz*rtz) || 1;
      verts[i+8] = rtx/tl; verts[i+9] = rty/tl; verts[i+10] = rtz/tl;
    }
  }
}

/** Decompose a col-major mat4 world matrix into TRS. */
function decomposeWorldMatrix(
  m: number[],
): [[number,number,number], [number,number,number], [number,number,number]] {
  // Translation
  const tx = m[12], ty = m[13], tz = m[14];

  // Scale = length of each basis column
  const sx = Math.sqrt(m[0]*m[0] + m[1]*m[1] + m[2]*m[2]);
  const sy = Math.sqrt(m[4]*m[4] + m[5]*m[5] + m[6]*m[6]);
  const sz = Math.sqrt(m[8]*m[8] + m[9]*m[9] + m[10]*m[10]);

  // Normalise rotation columns (rij = row i, col j in row-major; stored col-major)
  const r10=m[1]/sx;
  const r11=m[5]/sy;
  const r02=m[8]/sz, r12=m[9]/sz, r22=m[10]/sz;
  const r20=m[2]/sx;
  const r00=m[0]/sx;

  // Decompose as R = Ry * Rx * Rz to match the engine's updateLocalMatrix order
  // (rotateY → rotateX → rotateZ). Formulas:
  //   r12 = -sin(rx)                     → rx = asin(-r12)
  //   r02 = sin(ry)*cos(rx), r22 = cos(ry)*cos(rx)  → ry = atan2(r02, r22)
  //   r10 = cos(rx)*sin(rz), r11 = cos(rx)*cos(rz)  → rz = atan2(r10, r11)
  let ry: number, rx: number, rz: number;
  if (Math.abs(r12) < 0.9999) {
    rx = Math.asin(-r12);
    ry = Math.atan2(r02, r22);
    rz = Math.atan2(r10, r11);
  } else {
    // Gimbal lock: rx = ±π/2; absorb remaining freedom into ry, set rz = 0
    rx = r12 < 0 ? Math.PI / 2 : -Math.PI / 2;
    ry = Math.atan2(-r20, r00);
    rz = 0;
  }

  return [
    [tx, ty, tz],
    [rx, ry, rz],
    [sx, sy, sz],
  ];
}

// ── Skinned GLTF parsing ───────────────────────────────────────────────────

/**
 * Parse a .glb ArrayBuffer and return skinned mesh results.
 * Only meshes whose node has a `skin` reference and whose primitive
 * has JOINTS_0 / WEIGHTS_0 attributes will be included.
 */
export async function parseSkinnedGLB(buffer: ArrayBuffer): Promise<GltfSkinnedResult[]> {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546C67) throw new Error('Not a valid GLB file');
  if (view.getUint32(4, true) !== 2)           throw new Error('Only GLTF 2.0 is supported');

  let offset = 12;
  let jsonText = '';
  let binChunk: ArrayBuffer | null = null;

  while (offset < buffer.byteLength) {
    const chunkLen  = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (chunkType === 0x4E4F534A) jsonText = new TextDecoder().decode(new Uint8Array(buffer, offset, chunkLen));
    else if (chunkType === 0x004E4942) binChunk = buffer.slice(offset, offset + chunkLen);
    offset += chunkLen;
  }

  if (!jsonText) throw new Error('GLB contains no JSON chunk');
  const json = JSON.parse(jsonText) as GltfJson;
  const binaries = binChunk ? [binChunk] : [];
  return buildSkinnedResults(json, binaries);
}

/**
 * Parse a GLTF JSON string and return skinned mesh results.
 */
export async function parseSkinnedGLTF(
  jsonText: string,
  binaries: ArrayBuffer[] = [],
): Promise<GltfSkinnedResult[]> {
  const json = JSON.parse(jsonText) as GltfJson;
  const resolved: ArrayBuffer[] = [...binaries];
  for (let i = resolved.length; i < (json.buffers?.length ?? 0); i++) {
    const buf = json.buffers![i];
    if (buf.uri?.startsWith('data:')) resolved[i] = decodeDataUri(buf.uri);
  }
  return buildSkinnedResults(json, resolved);
}

async function buildSkinnedResults(
  json: GltfJson,
  binaries: ArrayBuffer[],
): Promise<GltfSkinnedResult[]> {
  assertRequiredExtensionsSupported(json);
  if (!json.skins || json.skins.length === 0) return [];

  const results: GltfSkinnedResult[] = [];
  const rootNodes = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const identityMat = mat4Identity();

  function visitNode(nodeIdx: number, parentMat: number[]): void {
    const node = json.nodes?.[nodeIdx];
    if (!node) return;

    const localMat = nodeLocalMatrix(node);
    const worldMat = mat4Mul(parentMat, localMat);

    if (node.mesh !== undefined && node.skin !== undefined && json.meshes![node.mesh]) {
      const skin = json.skins![node.skin];
      const mesh = json.meshes![node.mesh];

      for (const prim of mesh.primitives) {
        if ((prim.mode ?? 4) !== 4) continue;
        if (!('JOINTS_0' in prim.attributes) || !('WEIGHTS_0' in prim.attributes)) continue;

        // Build the static mesh part
        const baseResult = buildPrimitive(json, binaries, node, mesh, prim, worldMat);
        if (!baseResult) continue;

        const numVerts = baseResult.geometry.vertices.length / 12; // FLOATS_PER_VERT

        // Joint indices (u8/u16, clamped to u8) + weights (float or normalised u8/u16);
        // JOINTS_1/WEIGHTS_1 are reduced to the top 4 influences.
        const { jointIndices, jointWeights } = readSkinInfluences(json, binaries, prim, numVerts);

        // Read inverse bind matrices
        let ibm: Float32Array;
        if (skin.inverseBindMatrices !== undefined) {
          const raw = readAccessorFloat32(json, binaries, skin.inverseBindMatrices);
          ibm = raw ? new Float32Array(raw) : new Float32Array(skin.joints.length * 16);
          if (!raw) {
            // Fill identity matrices
            for (let ji = 0; ji < skin.joints.length; ji++) {
              ibm[ji * 16 + 0]  = 1; ibm[ji * 16 + 5]  = 1;
              ibm[ji * 16 + 10] = 1; ibm[ji * 16 + 15] = 1;
            }
          }
        } else {
          ibm = new Float32Array(skin.joints.length * 16);
          for (let ji = 0; ji < skin.joints.length; ji++) {
            ibm[ji * 16 + 0] = 1; ibm[ji * 16 + 5] = 1;
            ibm[ji * 16 + 10] = 1; ibm[ji * 16 + 15] = 1;
          }
        }

        // Collect joint names
        const jointNames = skin.joints.map(jIdx => json.nodes?.[jIdx]?.name ?? `joint_${jIdx}`);

        // Build joint hierarchy: parent index per joint
        const nodeToJoint = new Map(skin.joints.map((ni, ji) => [ni, ji]));
        const jointParents = new Int16Array(skin.joints.length).fill(-1);
        const jointLocalPositions = new Float32Array(skin.joints.length * 3);
        const jointLocalRotations = new Float32Array(skin.joints.length * 4);
        const jointLocalScales    = new Float32Array(skin.joints.length * 3);

        for (let ji = 0; ji < skin.joints.length; ji++) {
          const jn = json.nodes?.[skin.joints[ji]];
          for (const child of jn?.children ?? []) {
            const ci = nodeToJoint.get(child);
            if (ci !== undefined) jointParents[ci] = ji;
          }
          const t = jn?.translation ?? [0, 0, 0];
          const q = jn?.rotation    ?? [0, 0, 0, 1];
          const s = jn?.scale       ?? [1, 1, 1];
          jointLocalPositions.set(t, ji * 3);
          jointLocalRotations.set(q, ji * 4);
          jointLocalScales.set(s, ji * 3);
        }

        results.push({
          ...baseResult,
          skinning: {
            jointIndices,
            jointWeights,
            inverseBindMatrices: ibm,
            jointNames,
            skinName: skin.name ?? `skin_${node.skin}`,
            jointParents,
            jointLocalPositions,
            jointLocalRotations,
            jointLocalScales,
          },
        });
      }
    }

    for (const child of node.children ?? []) visitNode(child, worldMat);
  }

  if (rootNodes.length > 0) {
    for (const n of rootNodes) visitNode(n, identityMat);
  } else if (json.meshes) {
    for (let mi = 0; mi < json.meshes.length; mi++) {
      const mesh = json.meshes[mi];
      for (const prim of mesh.primitives) {
        if ((prim.mode ?? 4) !== 4) continue;
        const result = buildPrimitive(json, binaries, { name: mesh.name }, mesh, prim, identityMat);
        if (result && 'JOINTS_0' in prim.attributes) {
          // Fallback: use skin 0 if available
          const skin: GltfSkin | undefined = json.skins?.[0];
          if (!skin) continue;
          const numVerts = result.geometry.vertices.length / 12;
          const { jointIndices, jointWeights } = readSkinInfluences(json, binaries, prim, numVerts);
          const ibmLen = skin.joints.length * 16;
          const ibm = new Float32Array(ibmLen);
          const ibmRaw = skin.inverseBindMatrices !== undefined
            ? readAccessorFloat32(json, binaries, skin.inverseBindMatrices) : null;
          if (ibmRaw) ibm.set(ibmRaw);
          else { for (let ji = 0; ji < skin.joints.length; ji++) { ibm[ji*16]=1; ibm[ji*16+5]=1; ibm[ji*16+10]=1; ibm[ji*16+15]=1; } }
          const fbNodeToJoint: Map<number, number> = new Map();
          for (let ji2 = 0; ji2 < skin.joints.length; ji2++) fbNodeToJoint.set(skin.joints[ji2], ji2);
          const fbParents: Int16Array = new Int16Array(skin.joints.length).fill(-1);
          const fbPos: Float32Array = new Float32Array(skin.joints.length * 3);
          const fbRot: Float32Array = new Float32Array(skin.joints.length * 4);
          const fbScl: Float32Array = new Float32Array(skin.joints.length * 3);
          for (let ji2 = 0; ji2 < skin.joints.length; ji2++) {
            const jn: GltfNode | undefined = json.nodes?.[skin.joints[ji2]];
            for (const c2 of jn?.children ?? []) {
              const ci: number | undefined = fbNodeToJoint.get(c2);
              if (ci !== undefined) fbParents[ci] = ji2;
            }
            fbPos.set(jn?.translation ?? [0, 0, 0], ji2 * 3);
            fbRot.set(jn?.rotation    ?? [0, 0, 0, 1], ji2 * 4);
            fbScl.set(jn?.scale       ?? [1, 1, 1], ji2 * 3);
          }
          results.push({ ...result, skinning: {
            jointIndices, jointWeights, inverseBindMatrices: ibm,
            jointNames: skin.joints.map((j: number) => json.nodes?.[j]?.name ?? `joint_${j}`),
            skinName: skin.name ?? 'skin_0',
            jointParents: fbParents,
            jointLocalPositions: fbPos,
            jointLocalRotations: fbRot,
            jointLocalScales: fbScl,
          }});
        }
      }
    }
  }

  await resolveImages(results, json, binaries);
  return results;
}

// ── Utility ────────────────────────────────────────────────────────────────

function decodeDataUri(uri: string): ArrayBuffer {
  const comma = uri.indexOf(',');
  const b64   = uri.slice(comma + 1);
  const bin   = atob(b64);
  const ab    = new ArrayBuffer(bin.length);
  const u8    = new Uint8Array(ab);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return ab;
}
