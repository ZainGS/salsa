/**
 * asset-references — the pure "reference + embed" logic for the Shared Asset Library (docs/specs/shared-asset-library.md §2.3).
 *
 * A document that USES a global asset stores two things: a **reference** (which asset + which version it was authored
 * against) and, on save, an **embedded copy** of the payload — so the document opens self-contained on any machine
 * (portability) yet still knows it came from a global asset (so it can offer "update to the newer version"). This
 * module is the GPU-free, persistence-free heart: how a reference resolves at load time. The `.frogmarks`
 * serialize/embed plumbing (DocumentStateCoordinator) is the integration layer that consumes these.
 */

import type { AssetRecord } from './asset-types';

/** A document's pointer to a global asset: the id + the version the document was authored against. */
export interface AssetReference {
  globalId: string;
  version: number;
}

/** A self-contained copy embedded in the document so it opens without the global library present. */
export interface EmbeddedAsset {
  ref: AssetReference;
  record: AssetRecord;   // the full payload-bearing record as it was when embedded
}

export type ReferenceSource = 'global' | 'embedded' | 'dangling';

export interface ResolvedReference {
  ref: AssetReference;
  source: ReferenceSource;       // where `record` came from
  record: AssetRecord | null;    // the record the document should use (null when dangling)
  updateAvailable: boolean;      // the global library has a NEWER version than the document referenced
}

/** Build the reference to store when a document starts using a global asset. */
export function makeReference(record: AssetRecord): AssetReference {
  return { globalId: record.id, version: record.version };
}

/** Build the embedded copy to write into the `.frogmarks` alongside the reference (deep-copied, self-contained). */
export function makeEmbedded(record: AssetRecord): EmbeddedAsset {
  const clone = JSON.parse(JSON.stringify(record)) as AssetRecord;
  return { ref: makeReference(record), record: clone };
}

/**
 * Resolve one reference against what's available on load. The **embedded copy is authoritative** for the document
 * (it renders exactly as authored); the global library being newer is a *notification*, never an auto-swap. So:
 * - embedded present → use it; flag `updateAvailable` when the global version is higher (offer, don't apply).
 * - no embedded but global present → use the global record (nothing else to fall back to).
 * - neither → dangling (surface it; the document is missing that asset).
 */
export function resolveReference(
  ref: AssetReference, globalRecord: AssetRecord | null, embedded: EmbeddedAsset | null,
): ResolvedReference {
  const updateAvailable = !!globalRecord && globalRecord.version > ref.version;
  if (embedded) return { ref, source: 'embedded', record: embedded.record, updateAvailable };
  if (globalRecord) return { ref, source: 'global', record: globalRecord, updateAvailable: false };
  return { ref, source: 'dangling', record: null, updateAvailable: false };
}

/**
 * Accept an available update: adopt the newer global record as the document's embedded copy + bump the reference to
 * its version. Returns the new `{ ref, embedded }` to store. No-op-safe: if `globalRecord` is null (shouldn't happen
 * when an update was flagged), returns the inputs unchanged.
 */
export function acceptUpdate(ref: AssetReference, globalRecord: AssetRecord | null, embedded: EmbeddedAsset | null):
  { ref: AssetReference; embedded: EmbeddedAsset | null } {
  if (!globalRecord) return { ref, embedded };
  return { ref: makeReference(globalRecord), embedded: makeEmbedded(globalRecord) };
}
