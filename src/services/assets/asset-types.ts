/**
 * asset-types — the domain-agnostic envelope for the account-global Shared Asset Library
 * (docs/specs/shared-asset-library.md).
 *
 * The store never understands animation/material/brush internals. It wraps every asset in a common `AssetRecord`
 * and delegates the domain body to an `AssetProvider`. `payload` is the EXISTING per-domain entry, verbatim (an
 * `anim-clip` payload is today's `AnimLibraryEntry`), so folding a domain in needs zero payload rewrites. `meta` is
 * the small, indexable projection the library panel filters/sorts on WITHOUT unpacking the payload.
 */

/** Open set — new creators add kinds without touching the store. */
export type AssetKind =
  | 'anim-clip' | 'pose' | 'material' | 'character-part' | 'brush' | 'effect' | 'texture'
  | (string & {});

export interface AssetRecord<P = unknown> {
  id: string;                       // account-stable id (NOT a document node id)
  kind: AssetKind;
  name: string;
  tags: string[];
  version: number;                  // bumped on each overwrite of the same id
  createdAt: number;
  updatedAt: number;
  createdBy?: string;               // user id/email, for shared libraries
  thumbnailAssetId?: string;        // → a blob in the same store
  meta: Record<string, unknown>;    // indexable projection (rigType, duration, swatch…) — no payload unpack to read
  payload: P;                       // the domain body — the existing per-domain entry shape
}

/** The index row: the envelope MINUS the payload (payload lives in its own blob). Drives fast listing. */
export type AssetIndexEntry = Omit<AssetRecord, 'payload'>;

/** Where an asset is being applied — domain-specific, kept open (`{ skeletonId }`, `{ meshId }`, …). */
export type InstantiateTarget = Record<string, unknown>;

/**
 * A domain plugs into the store by registering one of these. `instantiate` is the only real work and it already
 * exists per domain (retarget a clip onto a skeleton, assign a material, register a brush) — the store just calls it.
 */
export interface AssetProvider<P = unknown> {
  kind: AssetKind;
  /** Build the indexable projection surfaced on the card without unpacking the payload. */
  meta(payload: P): Record<string, unknown>;
  /** Apply the asset into the open document; returns the new document-local id (or null on failure). May be async —
   *  some kinds (e.g. a character that regenerates a rigged body) instantiate asynchronously. */
  instantiate(payload: P, target: InstantiateTarget): string | null | Promise<string | null>;
  /** Optional preview capture (anim → a turntable strip frame). */
  thumbnail?(payload: P): Promise<Blob | null>;
}

/**
 * Storage abstraction: the index + payload blobs. An in-memory backend backs the unit tests; the OPFS backend
 * (extends ShellStorage's conventions) backs the browser. The library orchestrates; the backend just persists.
 */
export interface AssetStorageBackend {
  loadIndex(): Promise<AssetIndexEntry[]>;
  saveIndex(index: AssetIndexEntry[]): Promise<void>;
  loadPayload(id: string): Promise<unknown | null>;
  savePayload(id: string, payload: unknown): Promise<void>;
  deletePayload(id: string): Promise<void>;
}

/** A shareable subset of the library (`.frogpack`) — records WITH payloads. Ids are re-minted on import. */
export interface AssetBundle {
  version: 1;
  assets: AssetRecord[];
}
