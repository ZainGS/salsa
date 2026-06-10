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

import { zipSync, unzipSync, strToU8, strFromU8, Zippable } from 'fflate';
import type { DocumentSavePayload, DocumentManifest } from './document-persistence';
import { PixelFormat, encodePixels, decodePixels } from './pixel-codec';

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
    nodes:       input.nodes3d,
    skeletons:   input.skeletons3d,
    characters:  input.characters3d,
    gpObjects:   input.gpObjects3d,
    globalScene: input.globalScene3d,
  }, null, 2)), { level: 6 }];

  // ── textures3d.json ───────────────────────────────────────────
  if (input.textureLibrary) {
    files['textures3d.json'] = [strToU8(JSON.stringify(input.textureLibrary, null, 2)), { level: 6 }];
  }

  // ── ephemera.json ─────────────────────────────────────────────
  if (input.ephemeraJSON) {
    files['ephemera.json'] = [strToU8(input.ephemeraJSON), { level: 6 }];
  }

  // ── layers/{id}.bin ───────────────────────────────────────────
  const fmt: PixelFormat = input.docPayload.manifest.pixelFormat ?? 'png';
  const w = input.docPayload.manifest.canvasWidth;
  const h = input.docPayload.manifest.canvasHeight;
  for (const layer of input.docPayload.layers) {
    const encoded = await encodePixels(layer.pixelData, w, h, fmt);
    files[`layers/${layer.id}.bin`] = [new Uint8Array(encoded), { level: 1 }];
  }

  // ── cels/{id}.bin ─────────────────────────────────────────────
  for (const cel of input.docPayload.cels ?? []) {
    const encoded = await encodePixels(cel.pixelData, w, h, fmt);
    files[`cels/${cel.celId}.bin`] = [new Uint8Array(encoded), { level: 1 }];
  }

  // ── models3d/{meshId}.glb ─────────────────────────────────────
  for (const [meshId, buffer] of input.models3d) {
    // GLB is already binary-compressed; store with level 0 (no re-compress)
    files[`models3d/${meshId}.glb`] = [new Uint8Array(buffer), { level: 0 }];
  }

  const zipped = zipSync(files);
  return new Blob([zipped], { type: 'application/zip' });
}

// ── Unpack ─────────────────────────────────────────────────────────────────

/**
 * Unpack a .frogmarks ZIP file into a PackageOutput.
 * The caller (ShapeManager) is responsible for restoring each piece
 * of state into the appropriate manager.
 */
export async function unpackProject(file: File | Blob): Promise<PackageOutput> {
  const buffer  = await file.arrayBuffer();
  const entries = unzipSync(new Uint8Array(buffer));

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
    const raw = entries[`layers/${l.id}.bin`]?.buffer as ArrayBuffer ?? new ArrayBuffer(0);
    if (!raw.byteLength) return { id: l.id, pixelData: raw };
    const { rgba } = await decodePixels(raw, fmt);
    return { id: l.id, pixelData: rgba };
  }));

  // ── cels ──────────────────────────────────────────────────────
  const cels: { celId: string; pixelData: ArrayBuffer }[] = [];
  for (const key of Object.keys(entries)) {
    if (!key.startsWith('cels/') || !key.endsWith('.bin')) continue;
    const celId = key.slice(5, -4);
    const raw = entries[key].buffer as ArrayBuffer;
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

  // ── GLTF model buffers ────────────────────────────────────────
  const models3d = new Map<string, ArrayBuffer>();
  for (const key of Object.keys(entries)) {
    if (!key.startsWith('models3d/') || !key.endsWith('.glb')) continue;
    const meshId = key.slice(9, -4);   // strip "models3d/" prefix + ".glb" suffix
    models3d.set(meshId, entries[key].buffer as ArrayBuffer);
  }

  // ── Texture library ───────────────────────────────────────────
  const textureLibrary = entries['textures3d.json']
    ? JSON.parse(strFromU8(entries['textures3d.json']))
    : null;

  // ── Ephemera ──────────────────────────────────────────────────
  const ephemeraJSON = entries['ephemera.json']
    ? strFromU8(entries['ephemera.json'])
    : null;

  const docPayload: DocumentSavePayload = {
    manifest: docManifest,
    sceneGraphJSON,
    brushPresetsJSON,
    layers,
    cels,
  };

  return { docPayload, nodes3d, skeletons3d, characters3d, gpObjects3d, models3d, textureLibrary, ephemeraJSON, globalScene3d };
}
