import { describe, it, expect } from 'vitest';
import { AssetReferenceStore, type DocumentAssetReference } from './asset-reference-store';

const ref = (docLocalId: string, globalId: string, version = 1): DocumentAssetReference =>
  ({ docLocalId, globalId, version, kind: 'anim-clip', name: 'Walk' });

describe('AssetReferenceStore', () => {
  it('records by docLocalId, lists copies, and reports size', () => {
    const s = new AssetReferenceStore();
    s.record(ref('clip1', 'g1'));
    s.record(ref('clip2', 'g2'));
    expect(s.size).toBe(2);
    const list = s.list();
    expect(list.map(r => r.docLocalId).sort()).toEqual(['clip1', 'clip2']);
    list[0].name = 'mutated';                       // list returns copies — store is untouched
    expect(s.list().every(r => r.name === 'Walk')).toBe(true);
  });
  it('re-recording the same docLocalId replaces (e.g. re-instantiated)', () => {
    const s = new AssetReferenceStore();
    s.record(ref('clip1', 'g1', 1));
    s.record(ref('clip1', 'g1', 3));
    expect(s.size).toBe(1);
    expect(s.list()[0].version).toBe(3);
  });
  it('ignores a record with no docLocalId', () => {
    const s = new AssetReferenceStore();
    s.record({ docLocalId: '', globalId: 'g', version: 1, kind: 'anim-clip', name: 'x' });
    expect(s.size).toBe(0);
  });
  it('remove + clear', () => {
    const s = new AssetReferenceStore();
    s.record(ref('clip1', 'g1'));
    expect(s.removeByDocLocalId('clip1')).toBe(true);
    expect(s.removeByDocLocalId('clip1')).toBe(false);
    s.record(ref('clip2', 'g2'));
    s.clearForDocumentLoad();
    expect(s.size).toBe(0);
  });
  it('serialize → load round-trips (with clear-on-load)', () => {
    const s = new AssetReferenceStore();
    s.record(ref('clip1', 'g1', 2));
    const data = s.serialize();
    const s2 = new AssetReferenceStore();
    s2.record(ref('stale', 'gX'));     // load must clear this first
    s2.load(data);
    expect(s2.list().map(r => r.docLocalId)).toEqual(['clip1']);
    expect(s2.list()[0].version).toBe(2);
    s2.load(null);                      // null clears
    expect(s2.size).toBe(0);
  });
});
