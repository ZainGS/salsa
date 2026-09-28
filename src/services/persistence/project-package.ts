/**
 * ProjectPackage — portable .frogmarks project file format.
 *
 * A .frogmarks file is a standard ZIP archive. Since format v2 it holds exactly the files the OPFS autosave writes —
 * the package IS the autosave payload (audit 2026-09-28 P4), so export/import can never drift from autosave again:
 *
 *   manifest.json        — { formatVersion, packedAt, document: DocumentManifest }
 *   scene.json           — vector scene graph (ShapeManager shapes)
 *   brushes.json         — brush presets
 *   scene3d.json         — 3D nodes, skeletons, rigs, global scene settings, packaging, kitbash catalog, GP
 *   textures3d.json      — TextureLibrary snapshot (base64 image data)
 *   ephemera.json · ui.json · garp.json
 *   layers/{layerId}.bin — raster layer pixels          cels/{celId}.bin — animation cel pixels
 *   models3d/{meshId}.glb        — raw GLB for GLTF-imported meshes
 *   meshTextures/{key}.png       — UV paint / face / garment / procedural-prop paint
 *   bakedParts/{partId}.glb      — baked kitbash parts
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

/**
 * Version of the .frogmarks package format. Increment on breaking changes.
 *  v1 — a hand-assembled subset (scene3d nodes/rigs, GLBs, texture library, ephemera, ui). Dropped UV paint + face
 *       textures, baked parts, GARP; unpack restored out of order. Still READ — its scene3d.json has the same shape.
 *  v2 — the package is the autosave payload (same files, same content).
 */
export const PACKAGE_FORMAT_VERSION = 2;

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

/**
 * What unpackProject returns. `docPayload` is the FULL document payload — restore it through the normal document
 * restore (ShapeManager.restoreDocument / unpackProject). The other fields are convenience views over scene3d.json
 * for lightweight readers such as the standalone viewer.
 */
export interface PackageOutput {
  /** Format version the file was written with (1 = legacy). */
  formatVersion: number;
  docPayload: DocumentSavePayload;
  nodes3d: Mesh3DNodeState[];
  /** Serialized Skeleton3D nodes. */
  skeletons3d: any[];
  /** Serialized kitbash CharacterData records. */
  characters3d: any[];
  /** Serialized GpObject3D records. */
  gpObjects3d: any[];
  /** Raw GLB buffers keyed by mesh ID. */
  models3d: Map<string, ArrayBuffer>;
  textureLibrary: { entries: any[] } | null;
  /** Serialized EphemeraService state (JSON string). Null if absent in file. */
  ephemeraJSON: string | null;
  /** Serialized global scene settings. Null if absent. */
  globalScene3d: any | null;
  /** Procedural character rig params. */
  faceRigs: any[];
  clothingRigs: any[];
  hairRigs: any[];
  bodyParams: any[];
  attachments: any[];
}

// ── Pack ───────────────────────────────────────────────────────────────────

/**
 * Pack a document payload into a .frogmarks ZIP Blob. Pass the SAME payload the autosave writes (ShapeManager
 * gathers it with every 3D part forced in), so an export contains exactly what autosave would persist.
 */
export async function packProject(payload: DocumentSavePayload): Promise<Blob> {
  const files: Zippable = {};
  const text = (name: string, value: string | null | undefined): void => {
    if (value) files[name] = [strToU8(value), { level: 6 }];
  };
  // Already-compressed binaries (GLB / PNG) — stored, not re-deflated.
  const binDir = (dir: string, ext: string, map: Record<string, ArrayBuffer> | undefined): void => {
    for (const [key, buf] of Object.entries(map ?? {})) files[`${dir}/${key}${ext}`] = [new Uint8Array(buf), { level: 0 }];
  };

  files['manifest.json'] = [strToU8(JSON.stringify({
    formatVersion: PACKAGE_FORMAT_VERSION,
    packedAt: new Date().toISOString(),
    document: payload.manifest,
  }, null, 2)), { level: 6 }];

  text('scene.json', payload.sceneGraphJSON);
  text('brushes.json', payload.brushPresetsJSON);
  text('scene3d.json', payload.scene3dJSON);
  text('ephemera.json', payload.ephemeraJSON);
  text('ui.json', payload.uiLayersJSON);
  if (payload.textureLibrary) text('textures3d.json', JSON.stringify(payload.textureLibrary));
  if (payload.garpJSON) text('garp.json', JSON.stringify(payload.garpJSON));

  // Raster layers + cels. PNG/WebP/AVIF bytes are already compressed — re-deflating wastes CPU for ~0% gain, so
  // store at level 0; only raw RGBA benefits from zip compression.
  const fmt: PixelFormat = payload.manifest.pixelFormat ?? 'png';
  const pixelLevel = fmt === 'raw' ? 1 : 0;
  const w = payload.manifest.canvasWidth;
  const h = payload.manifest.canvasHeight;
  for (const layer of payload.layers) {
    files[`layers/${layer.id}.bin`] = [new Uint8Array(await encodePixels(layer.pixelData, w, h, fmt)), { level: pixelLevel }];
  }
  for (const cel of payload.cels ?? []) {
    files[`cels/${cel.celId}.bin`] = [new Uint8Array(await encodePixels(cel.pixelData, w, h, fmt)), { level: pixelLevel }];
  }

  // Already-compressed binaries (GLB / PNG) → level 0.
  binDir('models3d', '.glb', payload.models3d);
  binDir('meshTextures', '.png', payload.meshTextures);
  binDir('bakedParts', '.glb', payload.bakedParts);

  const zipped = await zipOffThread(files);
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

// ── Unpack ─────────────────────────────────────────────────────────────────

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

/** Every `dir/<key><ext>` entry → Record keyed by <key>. */
function readBinDir(entries: Unzipped, dir: string, ext: string): Record<string, ArrayBuffer> {
  const out: Record<string, ArrayBuffer> = {};
  const prefix = `${dir}/`;
  for (const key of Object.keys(entries)) {
    if (!key.startsWith(prefix) || !key.endsWith(ext)) continue;
    out[key.slice(prefix.length, -ext.length)] = toOwnedArrayBuffer(entries[key]);
  }
  return out;
}

/**
 * Unpack a .frogmarks ZIP into a full DocumentSavePayload (+ convenience views). Reads v1 and v2 — both store
 * scene3d.json in the shape the document restore already understands, so either restores through the one path.
 */
export async function unpackProject(file: File | Blob): Promise<PackageOutput> {
  const buffer  = await file.arrayBuffer();
  const entries = await unzipOffThread(new Uint8Array(buffer));
  const str = (name: string): string | null => (entries[name] ? strFromU8(entries[name]) : null);

  // ── manifest ──────────────────────────────────────────────────
  const envelopeText = str('manifest.json');
  if (!envelopeText) throw new Error('.frogmarks: missing manifest.json');
  const envelope = JSON.parse(envelopeText);
  const formatVersion: number = envelope.formatVersion ?? 1;
  if (formatVersion > PACKAGE_FORMAT_VERSION) {
    throw new Error(
      `.frogmarks: package version ${formatVersion} is newer than this build (${PACKAGE_FORMAT_VERSION}). Update Frogmarks.`,
    );
  }
  const docManifest: DocumentManifest = envelope.document;

  // ── raster layers + cels ──────────────────────────────────────
  // Manifest-v2 docs have no pixelFormat — treat as 'raw' for backwards compat.
  const fmt: PixelFormat = (docManifest.version >= 3 && docManifest.pixelFormat) ? docManifest.pixelFormat : 'raw';
  const layers = await Promise.all(docManifest.layers.map(async l => {
    const entry = entries[`layers/${l.id}.bin`];
    const raw = entry ? toOwnedArrayBuffer(entry) : new ArrayBuffer(0);
    if (!raw.byteLength) return { id: l.id, pixelData: raw };
    const { rgba } = await decodePixels(raw, fmt);
    return { id: l.id, pixelData: rgba };
  }));
  const cels: { celId: string; pixelData: ArrayBuffer }[] = [];
  for (const [celId, raw] of Object.entries(readBinDir(entries, 'cels', '.bin'))) {
    const { rgba } = await decodePixels(raw, fmt);
    cels.push({ celId, pixelData: rgba });
  }

  // ── the full payload ──────────────────────────────────────────
  const scene3dJSON = str('scene3d.json');
  const textureLibText = str('textures3d.json');
  const garpText = str('garp.json');
  const models3d = readBinDir(entries, 'models3d', '.glb');
  const docPayload: DocumentSavePayload = {
    manifest: docManifest,
    sceneGraphJSON: str('scene.json'),
    brushPresetsJSON: str('brushes.json'),
    layers,
    cels,
    scene3dJSON,
    models3d,
    meshTextures: readBinDir(entries, 'meshTextures', '.png'),
    bakedParts: readBinDir(entries, 'bakedParts', '.glb'),
    textureLibrary: textureLibText ? JSON.parse(textureLibText) : null,
    ephemeraJSON: str('ephemera.json'),
    uiLayersJSON: str('ui.json'),
    garpJSON: garpText ? JSON.parse(garpText) : null,
  };

  // ── convenience views over scene3d.json (lightweight readers, e.g. the standalone viewer) ──
  const s3 = scene3dJSON ? JSON.parse(scene3dJSON) : null;
  const obj = s3 && !Array.isArray(s3) ? s3 : null;
  return {
    formatVersion,
    docPayload,
    nodes3d:        Array.isArray(s3) ? s3 : (obj?.nodes ?? []),
    skeletons3d:    obj?.skeletons ?? [],
    characters3d:   obj?.characters ?? [],
    gpObjects3d:    obj?.gpObjects ?? [],
    models3d:       new Map(Object.entries(models3d)),
    textureLibrary: docPayload.textureLibrary ?? null,
    ephemeraJSON:   docPayload.ephemeraJSON ?? null,
    globalScene3d:  obj?.globalScene ?? null,
    faceRigs:       obj?.faceRigs ?? [],
    clothingRigs:   obj?.clothingRigs ?? [],
    hairRigs:       obj?.hairRigs ?? [],
    bodyParams:     obj?.bodyParams ?? [],
    attachments:    obj?.attachments ?? [],
  };
}
