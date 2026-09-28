/**
 * schema-version.ts — document schema versioning + load-time migrations (audit 2026-09-28 P10).
 *
 * Every save stamps `manifest.schemaVersion = DOCUMENT_SCHEMA_VERSION`. On load:
 *   • OLDER docs are migrated forward by {@link migrateDocumentPayload} (ordered, pure steps).
 *   • NEWER docs (written by a later Salsa build) still LOAD best-effort, but saving is BLOCKED — this build doesn't
 *     know the newer fields, so autosaving would silently drop them and overwrite the newer copy.
 * The write path also refuses to overwrite a doc whose on-disk manifest is newer (another tab / newer build saved it
 * after this one opened it) — see DocumentPersistence.writeToOPFS.
 *
 * Bump DOCUMENT_SCHEMA_VERSION whenever a change would make an OLDER build lose or misread data, and add the matching
 * migration step below. Additive optional fields that older builds can safely ignore do NOT need a bump.
 */

import type { DocumentSavePayload } from './document-persistence';

/**
 * v1 — everything saved before versioning existed (manifest has no `schemaVersion`).
 * v2 — 2026-09-28 audit pass: garp.json + ui.json on disk, kitbash `characters` + `gpObjects` in scene3dJSON,
 *      `submeshes` on mesh nodes, manifest-last commit. (All additive — v1 docs load unchanged.)
 */
export const DOCUMENT_SCHEMA_VERSION = 2;

/** The schema version a manifest was written with (absent = v1). */
export function schemaVersionOf(manifest: { schemaVersion?: number } | null | undefined): number {
  const v = manifest?.schemaVersion;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : 1;
}

/** True when a document was written by a NEWER build than this one (so this build must not save over it). */
export function isNewerThanThisBuild(manifest: { schemaVersion?: number } | null | undefined): boolean {
  return schemaVersionOf(manifest) > DOCUMENT_SCHEMA_VERSION;
}

/** One forward migration: turns a payload at schema `from` into schema `from + 1`. Must be pure (return a new/updated
 *  payload) and tolerate missing sections. */
type Migration = { from: number; describe: string; migrate: (p: DocumentSavePayload) => DocumentSavePayload };

/** Ordered migration steps. v1 → v2 is additive (no data rewrite needed), so it is a no-op marker kept to show the
 *  pattern and to prove the runner advances versions correctly. */
const MIGRATIONS: Migration[] = [
  { from: 1, describe: 'v1 → v2: additive (garp/ui files, catalog/GP, submeshes) — nothing to rewrite', migrate: (p) => p },
];

/**
 * Bring an OLDER payload up to DOCUMENT_SCHEMA_VERSION by running each applicable step in order. A payload that is
 * already current, or NEWER than this build, is returned untouched (a newer doc is handled by blocking saves, not by
 * guessing at a downgrade). Returns the steps applied, for logging.
 */
export function migrateDocumentPayload(payload: DocumentSavePayload): { payload: DocumentSavePayload; applied: string[] } {
  let v = schemaVersionOf(payload.manifest);
  const applied: string[] = [];
  let out = payload;
  while (v < DOCUMENT_SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === v);
    if (!step) throw new Error(`no migration from document schema v${v}`);
    out = step.migrate(out);
    applied.push(step.describe);
    v++;
  }
  if (applied.length) out = { ...out, manifest: { ...out.manifest, schemaVersion: DOCUMENT_SCHEMA_VERSION } };
  return { payload: out, applied };
}
