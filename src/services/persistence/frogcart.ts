/**
 * src/services/persistence/frogcart.ts
 *
 * `.frogcart` — the distributable interactive-scene package (docs/specs/ui-system.md §`.frogcart` Packaging
 * Format). A ZIP envelope around the existing `.frogmarks` project package:
 *
 *   my-scene.frogcart (ZIP)
 *     manifest.json          ← FrogcartManifest (title/author/thumbnail/…)
 *     scene.salsa            ← the FULL project package (ShapeManager.packProject() bytes — itself a zip)
 *     state-machine.json     ← extracted UI layers (pre-parsed convenience copy for the Player; the same data
 *                              also lives inside scene.salsa's ui.json and is what actually restores)
 *     player-config.json     ← FrogcartPlayerConfig (canvas size, initial state, deep-link param, …)
 *     audio.json             ← [{ assetId, file, mime }] — sound registry (only when the cart has audio)
 *     audio/<n>              ← the sound bytes the playSound actions reference (importFrogcart re-registers
 *                              them as object URLs, so a published cart's audio Just Works in the Player)
 *
 * Pure module (fflate only) — unit-tested round-trip; ShapeManager provides the export/import entry points.
 */

import { zipSync, unzipSync, strToU8, strFromU8, type Zippable } from 'fflate';
import type { UILayerData } from '../../ui/ui-types';

export interface FrogcartMeta {
  title: string;
  author?: string;
  description?: string;
  tags?: string[];
  /** Data-URL or bundled path of a thumbnail (optional; packProject already embeds one in the scene manifest). */
  thumbnail?: string;
}

export interface FrogcartManifest {
  version: string;
  frogmarksPlayerMinVersion: string;
  sceneId: string;
  title: string;
  author: string;
  description: string;
  thumbnail: string | null;
  createdAt: string;
  tags: string[];
}

export interface FrogcartPlayerConfig {
  /** State the Player enters on load (falls back to each machine's initialStateId when empty). */
  initialState: string;
  aspectRatio: string;
  canvasWidth: number;
  canvasHeight: number;
  lockAspectRatio: boolean;
  allowFullscreen: boolean;
  backgroundColor: string;
  showLoadingScreen: boolean;
  loadingScreenColor: string;
  /** URL query param the Player reads for deep-linking into a state (spec: `?state=settingsMenu`). */
  deepLinkStateParam: string;
}

export const DEFAULT_PLAYER_CONFIG: FrogcartPlayerConfig = {
  initialState: '',
  aspectRatio: '4:3',
  canvasWidth: 1280,
  canvasHeight: 960,
  lockAspectRatio: true,
  allowFullscreen: true,
  backgroundColor: '#000000',
  showLoadingScreen: true,
  loadingScreenColor: '#000000',
  deepLinkStateParam: 'state',
};

/** A sound asset bundled into (or read out of) a cart. */
export interface FrogcartSound {
  assetId: string;
  bytes: Uint8Array;
  /** Content type used to rebuild a playable Blob/object URL on import (e.g. 'audio/mpeg'). */
  mime: string;
}

export interface FrogcartPackInput {
  /** The full project package (ShapeManager.packProject() output). */
  scenePackage: Blob;
  meta: FrogcartMeta;
  /** Serialized UI layers (JSON of UILayerData[]) — the Player's pre-parsed state machines; null when none. */
  stateMachineJSON: string | null;
  playerConfig?: Partial<FrogcartPlayerConfig>;
  /** Sound assets referenced by the machines' playSound actions (exportFrogcart fetches the registered URLs). */
  sounds?: FrogcartSound[];
  /** Stable scene id (defaults to a random id) + creation stamp (defaults to now). */
  sceneId?: string;
  createdAt?: string;
}

export interface FrogcartUnpacked {
  manifest: FrogcartManifest;
  playerConfig: FrogcartPlayerConfig;
  /** Parsed UI layers from state-machine.json (empty when the cart has none). */
  uiLayers: UILayerData[];
  /** The inner project package — feed to ShapeManager.unpackProject() to load the scene. */
  scenePackage: Blob;
  /** Bundled sound assets (empty when the cart has none) — re-register these so playSound actions work. */
  sounds: FrogcartSound[];
}

/** Build a `.frogcart` blob (spec §Export API). */
export async function packFrogcart(input: FrogcartPackInput): Promise<Blob> {
  const manifest: FrogcartManifest = {
    version: '1.0',
    frogmarksPlayerMinVersion: '1.0.0',
    sceneId: input.sceneId ?? `cart-${Math.random().toString(36).slice(2, 10)}`,
    title: input.meta.title,
    author: input.meta.author ?? '',
    description: input.meta.description ?? '',
    thumbnail: input.meta.thumbnail ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    tags: input.meta.tags ?? [],
  };
  const playerConfig: FrogcartPlayerConfig = { ...DEFAULT_PLAYER_CONFIG, ...(input.playerConfig ?? {}) };
  const sceneBytes = new Uint8Array(await input.scenePackage.arrayBuffer());
  const files: Zippable = {
    'manifest.json': [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }],
    'player-config.json': [strToU8(JSON.stringify(playerConfig, null, 2)), { level: 6 }],
    // scene.salsa is already a zip — storing it uncompressed avoids double-compression for nothing.
    'scene.salsa': [sceneBytes, { level: 0 }],
  };
  if (input.stateMachineJSON) files['state-machine.json'] = [strToU8(input.stateMachineJSON), { level: 6 }];
  if (input.sounds?.length) {
    // Audio codecs are already compressed — store the bytes; audio.json maps assetId → entry + mime.
    const registry = input.sounds.map((s, i) => ({ assetId: s.assetId, file: `audio/${i}`, mime: s.mime }));
    files['audio.json'] = [strToU8(JSON.stringify(registry)), { level: 6 }];
    input.sounds.forEach((s, i) => { files[`audio/${i}`] = [s.bytes, { level: 0 }]; });
  }
  const zipped = zipSync(files);
  return new Blob([zipped as unknown as BlobPart], { type: 'application/zip' });
}

/** Parse a `.frogcart` blob (the Player + ShapeManager.importFrogcart use this). Throws on a malformed cart. */
export async function unpackFrogcart(file: Blob): Promise<FrogcartUnpacked> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const manifestBytes = entries['manifest.json'];
  const sceneBytes = entries['scene.salsa'];
  if (!manifestBytes || !sceneBytes) throw new Error('Not a .frogcart: missing manifest.json or scene.salsa');
  const manifest = JSON.parse(strFromU8(manifestBytes)) as FrogcartManifest;
  const playerConfig: FrogcartPlayerConfig = {
    ...DEFAULT_PLAYER_CONFIG,
    ...(entries['player-config.json'] ? (JSON.parse(strFromU8(entries['player-config.json'])) as Partial<FrogcartPlayerConfig>) : {}),
  };
  let uiLayers: UILayerData[] = [];
  if (entries['state-machine.json']) {
    try { uiLayers = JSON.parse(strFromU8(entries['state-machine.json'])) as UILayerData[]; } catch { uiLayers = []; }
  }
  const sounds: FrogcartSound[] = [];
  if (entries['audio.json']) {
    try {
      const registry = JSON.parse(strFromU8(entries['audio.json'])) as { assetId: string; file: string; mime: string }[];
      for (const r of registry) {
        const bytes = entries[r.file];
        if (bytes) sounds.push({ assetId: r.assetId, bytes, mime: r.mime });
      }
    } catch { /* corrupt audio registry → cart still loads, just silent */ }
  }
  return {
    manifest,
    playerConfig,
    uiLayers,
    scenePackage: new Blob([sceneBytes as unknown as BlobPart], { type: 'application/zip' }),
    sounds,
  };
}
