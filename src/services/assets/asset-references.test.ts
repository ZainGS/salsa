import { describe, it, expect } from 'vitest';
import { makeReference, makeEmbedded, resolveReference, acceptUpdate, type EmbeddedAsset } from './asset-references';
import type { AssetRecord } from './asset-types';

const rec = (id: string, version: number, name = 'Walk'): AssetRecord => ({
  id, kind: 'anim-clip', name, tags: [], version, createdAt: 0, updatedAt: 0, meta: {}, payload: { v: version },
});

describe('makeReference / makeEmbedded', () => {
  it('reference captures id + version; embedded deep-copies the record', () => {
    const r = rec('g1', 3);
    expect(makeReference(r)).toEqual({ globalId: 'g1', version: 3 });
    const emb = makeEmbedded(r);
    expect(emb.ref).toEqual({ globalId: 'g1', version: 3 });
    expect(emb.record).toEqual(r);
    (emb.record.payload as { v: number }).v = 999;   // mutating the copy must not touch the source
    expect((r.payload as { v: number }).v).toBe(3);
  });
});

describe('resolveReference — the load-time matrix', () => {
  const ref = { globalId: 'g1', version: 2 };

  it('embedded present + no newer global → use embedded, no update', () => {
    const emb = makeEmbedded(rec('g1', 2));
    const r = resolveReference(ref, rec('g1', 2), emb);
    expect(r.source).toBe('embedded');
    expect(r.updateAvailable).toBe(false);
    expect(r.record?.version).toBe(2);
  });
  it('embedded present + global NEWER → use embedded (authored state) but FLAG update', () => {
    const emb = makeEmbedded(rec('g1', 2));
    const r = resolveReference(ref, rec('g1', 5), emb);
    expect(r.source).toBe('embedded');       // does NOT auto-swap to the newer payload
    expect(r.record?.version).toBe(2);        // still the version the doc was authored with
    expect(r.updateAvailable).toBe(true);     // but the panel can offer the update
  });
  it('no embedded but global present → fall back to global', () => {
    const r = resolveReference(ref, rec('g1', 2), null);
    expect(r.source).toBe('global');
    expect(r.record?.version).toBe(2);
    expect(r.updateAvailable).toBe(false);
  });
  it('portability: no global (another machine, empty library) but embedded present → use embedded', () => {
    const emb = makeEmbedded(rec('g1', 2));
    const r = resolveReference(ref, null, emb);
    expect(r.source).toBe('embedded');
    expect(r.record?.version).toBe(2);
  });
  it('neither present → dangling', () => {
    const r = resolveReference(ref, null, null);
    expect(r.source).toBe('dangling');
    expect(r.record).toBeNull();
    expect(r.updateAvailable).toBe(false);
  });
});

describe('acceptUpdate', () => {
  it('adopts the newer global record as the new reference + embedded copy', () => {
    const ref = { globalId: 'g1', version: 2 };
    const oldEmb: EmbeddedAsset = makeEmbedded(rec('g1', 2));
    const next = acceptUpdate(ref, rec('g1', 5), oldEmb);
    expect(next.ref).toEqual({ globalId: 'g1', version: 5 });
    expect(next.embedded?.record.version).toBe(5);
  });
  it('is a no-op when the global record is gone', () => {
    const ref = { globalId: 'g1', version: 2 };
    const emb = makeEmbedded(rec('g1', 2));
    expect(acceptUpdate(ref, null, emb)).toEqual({ ref, embedded: emb });
  });
});
