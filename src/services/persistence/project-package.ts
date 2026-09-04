/**
 * ProjectPackage — portable .frogmarks project file format.
 *
 * A .frogmarks file is a standard ZIP archive containing:
 *
 *   manifest.json        — DocumentManifest + 3D node list + package metadata
 *   scene.json           — vector scene graph (ShapeManager shapes)
 *   brushes.json         — brush presets
 *   scene3d.json         — 3D mesh node states (positions, materials, keyframes)
 *   textures3d.json      — TextureLibrary snapshot (base64 image data)
 *   layers/
 *     {layerId}.bin      — raster layer RGBA pixel data
 *   cels/
 *     {celId}.bin        — animation cel pixel data
 *   models3d/
 *     {meshId}.glb       — raw GLB for GLTF-imported meshes (re-imported on load)
 *
 * Why ZIP: single portable file, files are individually compressed,
 * users can inspect contents in any OS archive tool, Frogmarks can
 * trigger a browser download without any server round-trip.
 *
 * Why not cloud storage for models: GLB files can be 50–200 MB.
 * Storing them in the .frogmarks file keeps hosting costs at zero.
 */

import { zip, unzip, zipSync, unzipSync, strToU8, strFromU8, Zippable, AsyncZippable, Unzipped } from 'fflate';
import type { DocumentSavePayload, DocumentManifest } from './document-persistence';
import { PixelFormat, encodePixels, decodePixels } from './pixel-codec';

// ── Off-thread zip/unzip ───────────────────────────────────────────────────
// fflate's ASYNC APIs run the deflate/inflate in fflate's own internal workers (spawned from inlined
// blob code — no bundler asset resolution needed), keeping pack/unpack of large packages off the main
// thread. The SYNC variants are kept only as fallbacks: headless (no Worker), or the async path failing
// at runtime (e.g. a CSP that blocks blob workers) — the sync result is identical, just main-thread,
// so an export/import never fails outright because of a worker problem.

function zipOffThread(files: Zippable): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return Promise.resolve(zipSync(files));
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(files as unknown as AsyncZippable, (err, data) => (err ? reject(err) : resolve(data)));
  }).catch(() => zipSync(files));
}

function unzipOffThread(data: Uint8Array): Promise<Unzipped> {
  if (typeof Worker === 'undefined') return Promise.resolve(unzipSync(data));
  return new Promise<Unzipped>((resolve, reject) => {
    unzip(data, (err, out) => (err ? reject(err) : resolve(out)));
  }).catch(() => unzipSync(data));
}

// ── Package format types ───────────────────────────────────────────────────

/** Version of the .frogmarks package format. Increment on breaking changes. */
const PACKAGE_FORMAT_VERSION = 1;

/** A single 3D mesh node's serialized state. From Mesh3D.toJSON(). */
export interface Mesh3DNodeState {
  id: string;
  type: '3DMesh';
  name: string;
  x: number; y: number; z: number;
  rotationX: number; rotationY: number; rotation: number;
  scaleX: number; scaleY: number; scaleZ: number;
  primitive: string;
  config: any;
  material: any;
  textureLibraryId: string | null;
  normalMapLibraryId: string | null;
  keyframeTracks: any;
  /**
   * If this mesh was imported from a GLB file, the mesh ID used to look up
   * the buffer in models3d/. The loader re-imports from GLB on load so
   * the geometry config inside `config` is ignored for GLTF nodes.
   */
  glbMeshId?: string;
}

export interface PackageInput {
  /** Standard document data (from ShapeManager state provider). */
  docPayload: DocumentSavePayload;
  /** Serialized Grease Pencil objects (GpObject3D.toJSON() per object). */
  gpObjects3d: any[];
  /** Serialized 3D mesh nodes (Mesh3D.toJSON() per mesh). */
  nodes3d: Mesh3DNodeState[];
  /** Serialized Skeleton3D nodes (Skeleton3D.toJSON() per skeleton). */
  skeletons3d: any[];
  /** Serialized CharacterData records (kitbash assembled characters). */
  characters3d: any[];
  /** Raw GLB buffers keyed by mesh ID (populated for GLTF-imported meshes). */
  models3d: Map<string, ArrayBuffer>;
  /** TextureLibrary snapshot including base64 image data. Null if unused. */
  textureLibrary: { entries: any[] } | null;
  /** Serialized EphemeraService state (JSON string). Null if no ephemera. */
  ephemeraJSON: string | null;
  /** Serialized global scene settings (fog, PS1, lighting, post-process, etc.). Null if no 3D scene. */
  globalScene3d: any | null;
  /** Procedural character rig params — regenerate hair/clothing/face/body overlays on load (else a loaded
   *  bundle shows the bare body with no hair or clothes). */
  faceRigs?: any[];
  clothingRigs?: any[];
  hairRigs?: any[];
  bodyParams?: any[];
  attachments?: any[];
}

export interface PackageOutput {
  docPayload: DocumentSavePayload;
  nodes3d: Mesh3DNodeState[];
  /** Serialized Skeleton3D nodes. */
  skeletons3d: any[];
  /** Serialized CharacterData records. */
  characters3d: any[];
  /** Serialized GpObject3D records. */
  gpObjects3d: any[];
  /** Raw GLB buffers keyed by mesh ID. */
  models3d: Map<string, ArrayBuffer>;
  textureLibrary: { entries: any[] } | null;
  /** Serialized EphemeraService state (JSON string). Null if absent in file. */
  ephemeraJSON: string | null;
  /** Serialized global scene settings. Null if absent (older files). */
  globalScene3d: any | null;
  /** Procedural character rig params (regenerate the overlays on load). Empty for older bundles. */
  faceRigs: any[];
  clothingRigs: any[];
  hairRigs: any[];
  bodyParams: any[];
  attachments: any[];
}

// ── Pack ───────────────────────────────────────────────────────────────────

/**
 * Pack a full project into a .frogmarks ZIP Blob.
 * Returns a Blob; Frogmarks triggers a browser download with a filename like
 * `${documentName}.frogmarks`.
 */
export async function packProject(input: PackageInput): Promise<Blob> {
  const files: Zippable = {};

  // ── manifest.json ─────────────────────────────────────────────
  const manifestEnvelope = {
    formatVersion: PACKAGE_FORMAT_VERSION,
    packedAt: new Date().toISOString(),
    document: input.docPayload.manifest,
    nodes3dCount: input.nodes3d.length,
    models3dIds: [...input.models3d.keys()],
  };
  files['manifest.json'] = [strToU8(JSON.stringify(manifestEnvelope, null, 2)), { level: 6 }];

  // ── scene.json ────────────────────────────────────────────────
  if (input.docPayload.sceneGraphJSON) {
    files['scene.json'] = [strToU8(input.docPayload.sceneGraphJSON), { level: 6 }];
  }

  // ── brushes.json ──────────────────────────────────────────────
  if (input.docPayload.brushPresetsJSON) {
    files['brushes.json'] = [strToU8(input.docPayload.brushPresetsJSON), { level: 6 }];
  }

  // ── scene3d.json ──────────────────────────────────────────────
  files['scene3d.json'] = [strToU8(JSON.stringify({
    nodes:        input.nodes3d,
    skeletons:    input.skeletons3d,
    characters:   input.characters3d,
    gpObjects:    input.gpObjects3d,
    globalScene:  input.globalScene3d,
    faceRigs:     input.faceRigs ?? [],      // procedural overlay params → regenerate hair/clothing/face/body on load
    clothingRigs: input.clothingRigs ?? [],
    hairRigs:     input.hairRigs ?? [],
    bodyParams:   input.bodyParams ?? [],
    attachments:  input.attachments ?? [],
  }, null, 2)), { level: 6 }];

  // ── textures3d.json ───────────────────────────────────────────
  if (input.textureLibrary) {
    files['textures3d.json'] = [strToU8(JSON.stringify(input.textureLibrary, null, 2)), { level: 6 }];
  }

  // ── ephemera.json ─────────────────────────────────────────────
  if (input.ephemeraJSON) {
    files['ephemera.json'] = [strToU8(input.ephemeraJSON), { level: 6 }];
  }

  // ── ui.json (UI System: state machines + shape interactions per ui-layer) ──
  if (input.docPayload.uiLayersJSON) {
    files['ui.json'] = [strToU8(input.docPayload.uiLayersJSON), { level: 6 }];
  }

  // ── layers/{id}.bin ───────────────────────────────────────────
  const fmt: PixelFormat = input.docPayload.manifest.pixelFormat ?? 'png';
  // PNG/WebP/AVIF bytes are already compressed — re-deflating them wastes CPU for ~0% gain,
  // so store at level 0 (like the GLB path). Only raw RGBA benefits from zip compression.
  const pixelLevel = fmt === 'raw' ? 1 : 0;
  const w = input.docPayload.manifest.canvasWidth;
  const h = input.docPayload.manifest.canvasHeight;
  for (const layer of input.docPayload.layers) {
    const encoded = await encodePixels(layer.pixelData, w, h, fmt);
    files[`layers/${layer.id}.bin`] = [new Uint8Array(encoded), { level: pixelLevel }];
  }

  // ── cels/{id}.bin ─────────────────────────────────────────────
  for (const cel of input.docPayload.cels ?? []) {
    const encoded = await encodePixels(cel.pixelData, w, h, fmt);
    files[`cels/${cel.celId}.bin`] = [new Uint8Array(encoded), { level: pixelLevel }];
  }

  // ── models3d/{meshId}.glb ─────────────────────────────────────
  for (const [meshId, buffer] of input.models3d) {
    // GLB is already binary-compressed; store with level 0 (no re-compress)
    files[`models3d/${meshId}.glb`] = [new Uint8Array(buffer), { level: 0 }];
  }

  const zipped = await zipOffThread(files);
  return new Blob([zipped], { type: 'application/zip' });
}

// ── Unpack ─────────────────────────────────────────────────────────────────

/**
 * Unpack a .frogmarks ZIP file into a PackageOutput.
 * The caller (ShapeManager) is responsible for restoring each piece
 * of state into the appropriate manager.
 */
/**
 * Copy an fflate entry into an owned ArrayBuffer. fflate may return entries as
 * SUBARRAY views into a shared backing buffer — reading `.buffer` directly would
 * hand back the whole backing buffer (wrong bytes → corrupt layers/GLB), so
 * respect byteOffset/byteLength and only pass `.buffer` through when the view
 * spans it exactly.
 */
function toOwnedArrayBuffer(u8: Uint8Array): ArrayBuffer {
  // fflate never hands back SharedArrayBuffer-backed views — the cast just narrows ArrayBufferLike.
  return (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength)
    ? (u8.buffer as ArrayBuffer)
    : (u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);
}

export async function unpackProject(file: File | Blob): Promise<PackageOutput> {
  const buffer  = await file.arrayBuffer();
  const entries = await unzipOffThread(new Uint8Array(buffer));

  // ── manifest ──────────────────────────────────────────────────
  if (!entries['manifest.json']) throw new Error('.frogmarks: missing manifest.json');
  const envelope   = JSON.parse(strFromU8(entries['manifest.json']));
  if (envelope.formatVersion > PACKAGE_FORMAT_VERSION) {
    throw new Error(
      `.frogmarks: package version ${envelope.formatVersion} is newer than this build (${PACKAGE_FORMAT_VERSION}). Update Frogmarks.`,
    );
  }
  const docManifest: DocumentManifest = envelope.document;

  // ── scene / brushes ───────────────────────────────────────────
  const sceneGraphJSON   = entries['scene.json']   ? strFromU8(entries['scene.json'])   : null;
  const brushPresetsJSON = entries['brushes.json'] ? strFromU8(entries['brushes.json']) : null;

  // ── raster layers ─────────────────────────────────────────────
  // v2 saves have no pixelFormat in the manifest — treat as 'raw' for backwards compat.
  const fmt: PixelFormat = (docManifest.version >= 3 && docManifest.pixelFormat)
    ? docManifest.pixelFormat
    : 'raw';
  const layers = await Promise.all(docManifest.layers.map(async l => {
    const entry = entries[`layers/${l.id}.bin`];
    const raw = entry ? toOwnedArrayBuffer(entry) : new ArrayBuffer(0);
    if (!raw.byteLength) return { id: l.id, pixelData: raw };
    const { rgba } = await decodePixels(raw, fmt);
    return { id: l.id, pixelData: rgba };
  }));

  // ── cels ──────────────────────────────────────────────────────
  const cels: { celId: string; pixelData: ArrayBuffer }[] = [];
  for (const key of Object.keys(entries)) {
    if (!key.startsWith('cels/') || !key.endsWith('.bin')) continue;
    const celId = key.slice(5, -4);
    const raw = toOwnedArrayBuffer(entries[key]);
    const { rgba } = await decodePixels(raw, fmt);
    cels.push({ celId, pixelData: rgba });
  }

  // ── 3D nodes ──────────────────────────────────────────────────
  const scene3dParsed = entries['scene3d.json']
    ? JSON.parse(strFromU8(entries['scene3d.json']))
    : null;
  const nodes3d: Mesh3DNodeState[] = scene3dParsed?.nodes ?? [];
  const skeletons3d: any[]         = scene3dParsed?.skeletons ?? [];
  const characters3d: any[]        = scene3dParsed?.characters ?? [];
  const gpObjects3d: any[]         = scene3dParsed?.gpObjects ?? [];
  const globalScene3d: any | null  = scene3dParsed?.globalScene ?? null;
  const faceRigs: any[]            = scene3dParsed?.faceRigs ?? [];
  const clothingRigs: any[]        = scene3dParsed?.clothingRigs ?? [];
  const hairRigs: any[]            = scene3dParsed?.hairRigs ?? [];
  const bodyParams: any[]          = scene3dParsed?.bodyParams ?? [];
  const attachments: any[]         = scene3dParsed?.attachments ?? [];

  // ── GLTF model buffers ────────────────────────────────────────
  const models3d = new Map<string, ArrayBuffer>();
  for (const key of Object.keys(entries)) {
    if (!key.startsWith('models3d/') || !key.endsWith('.glb')) continue;
    const meshId = key.slice(9, -4);   // strip "models3d/" prefix + ".glb" suffix
    models3d.set(meshId, toOwnedArrayBuffer(entries[key]));
  }

  // ── Texture library ───────────────────────────────────────────
  const textureLibrary = entries['textures3d.json']
    ? JSON.parse(strFromU8(entries['textures3d.json']))
    : null;

  // ── Ephemera ──────────────────────────────────────────────────
  const ephemeraJSON = entries['ephemera.json']
    ? strFromU8(entries['ephemera.json'])
    : null;

  // ── UI System layers ──────────────────────────────────────────
  const uiLayersJSON = entries['ui.json'] ? strFromU8(entries['ui.json']) : null;

  const docPayload: DocumentSavePayload = {
    manifest: docManifest,
    sceneGraphJSON,
    brushPresetsJSON,
    layers,
    cels,
    uiLayersJSON,
  };

  return { docPayload, nodes3d, skeletons3d, characters3d, gpObjects3d, models3d, textureLibrary, ephemeraJSON, globalScene3d, faceRigs, clothingRigs, hairRigs, bodyParams, attachments };
}
