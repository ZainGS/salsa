import { describe, it, expect } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION, schemaVersionOf, isNewerThanThisBuild, migrateDocumentPayload } from './schema-version';
import type { DocumentSavePayload } from './document-persistence';

const payload = (schemaVersion?: number): DocumentSavePayload =>
  ({ manifest: { version: 3, docId: 'd', name: 'n', layers: [], ...(schemaVersion !== undefined ? { schemaVersion } : {}) }, layers: [] } as unknown as DocumentSavePayload);

describe('document schema versioning (audit 2026-09-28 P10)', () => {
  it('a manifest with no schemaVersion is v1; junk values fall back to v1', () => {
    expect(schemaVersionOf({})).toBe(1);
    expect(schemaVersionOf(null)).toBe(1);
    expect(schemaVersionOf({ schemaVersion: 0 })).toBe(1);
    expect(schemaVersionOf({ schemaVersion: NaN })).toBe(1);
    expect(schemaVersionOf({ schemaVersion: DOCUMENT_SCHEMA_VERSION })).toBe(DOCUMENT_SCHEMA_VERSION);
  });

  it('isNewerThanThisBuild only for a strictly higher version', () => {
    expect(isNewerThanThisBuild({ schemaVersion: DOCUMENT_SCHEMA_VERSION + 1 })).toBe(true);
    expect(isNewerThanThisBuild({ schemaVersion: DOCUMENT_SCHEMA_VERSION })).toBe(false);
    expect(isNewerThanThisBuild({})).toBe(false);
  });

  it('migrates an older payload up to the current version and stamps it', () => {
    const { payload: out, applied } = migrateDocumentPayload(payload());
    expect(applied.length).toBe(DOCUMENT_SCHEMA_VERSION - 1);
    expect(out.manifest.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
  });

  it('leaves a current or NEWER payload untouched (a newer doc is blocked, never guessed-downgraded)', () => {
    const cur = payload(DOCUMENT_SCHEMA_VERSION);
    expect(migrateDocumentPayload(cur)).toEqual({ payload: cur, applied: [] });
    const newer = payload(DOCUMENT_SCHEMA_VERSION + 5);
    expect(migrateDocumentPayload(newer).payload).toBe(newer);
  });
});
