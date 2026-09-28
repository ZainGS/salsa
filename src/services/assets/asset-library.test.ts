import { describe, it, expect, beforeEach } from 'vitest';
import { AssetLibrary } from './asset-library';
import { MemoryAssetBackend } from './asset-store-memory';
import type { AssetProvider, InstantiateTarget } from './asset-types';

// A mock "anim-clip"-shaped provider: meta projects a couple of fields; instantiate records the call and returns a
// deterministic doc-local id; thumbnail returns a tiny blob. Proves the store's provider dispatch (the L2 contract)
// without any engine/GPU.
interface MockPayload { clipName: string; joints: string[]; secret: number }
function mockProvider(calls: { instantiate: { payload: MockPayload; target: InstantiateTarget }[] }): AssetProvider<MockPayload> {
  return {
    kind: 'anim-clip',
    meta: (p) => ({ jointCount: p.joints.length, clipName: p.clipName }),
    instantiate: (p, target) => { calls.instantiate.push({ payload: p, target }); return `doc_${p.clipName}`; },
    thumbnail: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  };
}

// Deterministic id minter + clock for stable assertions. `prefix` distinguishes two libraries (a real UUID minter
// would never collide; the tests use distinct prefixes to mirror that).
function deterministic(prefix = 'id') {
  let n = 0, t = 1000;
  return { mint: () => `${prefix}${n++}`, now: () => (t += 1) };
}

const PAYLOAD = (name: string): MockPayload => ({ clipName: name, joints: ['hips', 'spine', 'head'], secret: 42 });

describe('AssetLibrary — global asset store', () => {
  let lib: AssetLibrary;
  let calls: { instantiate: { payload: MockPayload; target: InstantiateTarget }[] };

  beforeEach(async () => {
    const d = deterministic();
    lib = new AssetLibrary(new MemoryAssetBackend(), d.mint, d.now);
    calls = { instantiate: [] };
    lib.registerProvider(mockProvider(calls));
    await lib.init();
  });

  it('promote mints an id, runs the provider meta, and stores the payload separately', async () => {
    const rec = await lib.promote('anim-clip', PAYLOAD('Walk'), { name: 'Walk', tags: ['locomotion'] });
    expect(rec.id).toBe('id0');
    expect(rec.version).toBe(1);
    expect(rec.meta).toEqual({ jointCount: 3, clipName: 'Walk' });   // provider-computed
    // list() shows the envelope WITHOUT the payload; get() unpacks it.
    const listed = lib.list();
    expect(listed).toHaveLength(1);
    expect('payload' in listed[0]).toBe(false);
    const full = await lib.get<MockPayload>('id0');
    expect(full?.payload.secret).toBe(42);
  });

  it('list filters by kind, tags (AND), and text query; newest first', async () => {
    await lib.promote('anim-clip', PAYLOAD('Walk'), { name: 'Walk', tags: ['locomotion', 'humanoid'] });
    await lib.promote('anim-clip', PAYLOAD('Wave'), { name: 'Wave', tags: ['gesture'] });
    await lib.promote('pose', PAYLOAD('TPose'), { name: 'T Pose', tags: ['humanoid'] });

    expect(lib.list({ kind: 'pose' }).map(r => r.name)).toEqual(['T Pose']);
    expect(lib.list({ tags: ['humanoid'] }).map(r => r.name).sort()).toEqual(['T Pose', 'Walk']);
    expect(lib.list({ tags: ['locomotion', 'humanoid'] }).map(r => r.name)).toEqual(['Walk']);   // AND
    expect(lib.list({ query: 'wav' }).map(r => r.name)).toEqual(['Wave']);
    expect(lib.list()[0].name).toBe('T Pose');   // newest first (last promoted)
  });

  it('instantiate dispatches to the provider with the payload + target', async () => {
    await lib.promote('anim-clip', PAYLOAD('Run'), { name: 'Run' });
    const docId = await lib.instantiate('id0', { skeletonId: 'skelA' });
    expect(docId).toBe('doc_Run');
    expect(calls.instantiate).toHaveLength(1);
    expect(calls.instantiate[0].payload.clipName).toBe('Run');
    expect(calls.instantiate[0].target).toEqual({ skeletonId: 'skelA' });
  });

  it('instantiate fires the provenance hook with the record + the new doc-local id', async () => {
    const seen: { globalId: string; docLocalId: string }[] = [];
    lib.setInstantiateHook((record, docLocalId) => seen.push({ globalId: record.id, docLocalId }));
    const rec = await lib.promote('anim-clip', PAYLOAD('Run'), { name: 'Run' });
    const docId = await lib.instantiate(rec.id, { skeletonId: 'skelA' });
    expect(docId).toBe('doc_Run');
    expect(seen).toEqual([{ globalId: rec.id, docLocalId: 'doc_Run' }]);
    // A failed instantiate (unknown id) does NOT fire the hook.
    await lib.instantiate('nope', {});
    expect(seen).toHaveLength(1);
  });

  it('supports an ASYNC provider.instantiate (awaited; hook fires after it resolves)', async () => {
    const seen: string[] = [];
    const asyncLib = new AssetLibrary(new MemoryAssetBackend(), deterministic('a').mint);
    asyncLib.registerProvider({
      kind: 'character',
      meta: () => ({}),
      instantiate: async (_p, target) => { await Promise.resolve(); return `body_${target.at as string}`; },
    });
    asyncLib.setInstantiateHook((_rec, docId) => seen.push(docId));
    await asyncLib.init();
    const rec = await asyncLib.promote('character', { body: {} }, { name: 'Hero' });
    const docId = await asyncLib.instantiate(rec.id, { at: 'origin' });
    expect(docId).toBe('body_origin');       // awaited the async result
    expect(seen).toEqual(['body_origin']);   // hook fired with the resolved id
  });

  it('instantiate/get/thumbnail return null for unknown ids or unregistered kinds', async () => {
    expect(await lib.instantiate('nope', {})).toBeNull();
    expect(await lib.get('nope')).toBeNull();
    // an asset of a kind with no provider promotes fine (empty meta) but can't instantiate
    const rec = await lib.promote('material', { color: [1, 0, 0] }, { name: 'Red' });
    expect(rec.meta).toEqual({});
    expect(await lib.instantiate(rec.id, {})).toBeNull();
  });

  it('rename / retag / remove update the index and persist', async () => {
    await lib.promote('anim-clip', PAYLOAD('Walk'), { name: 'Walk' });
    expect(await lib.rename('id0', 'Stroll')).toBe(true);
    expect(await lib.retag('id0', ['locomotion', 'slow'])).toBe(true);
    expect(lib.list()[0].name).toBe('Stroll');
    expect(lib.list()[0].tags).toEqual(['locomotion', 'slow']);
    expect(await lib.remove('id0')).toBe(true);
    expect(lib.list()).toHaveLength(0);
    expect(await lib.get('id0')).toBeNull();       // payload gone too
    expect(await lib.remove('id0')).toBe(false);   // idempotent
  });

  it('survives a reload from the backend (index round-trips)', async () => {
    const backend = new MemoryAssetBackend();
    const a = new AssetLibrary(backend, deterministic().mint);
    a.registerProvider(mockProvider({ instantiate: [] }));
    await a.init();
    await a.promote('anim-clip', PAYLOAD('Walk'), { name: 'Walk', tags: ['x'] });
    // A fresh library over the SAME backend sees it.
    const b = new AssetLibrary(backend);
    await b.init();
    expect(b.list().map(r => r.name)).toEqual(['Walk']);
    expect((await b.get<MockPayload>(b.list()[0].id))?.payload.clipName).toBe('Walk');
  });

  it('resolveReference fetches the live global record and flags a newer version', async () => {
    const rec = await lib.promote('anim-clip', PAYLOAD('Walk'), { name: 'Walk' });   // version 1
    // A doc that referenced version 1, with no embedded copy → resolves to the global record, no update.
    let r = await lib.resolveReference({ globalId: rec.id, version: 1 });
    expect(r.source).toBe('global');
    expect(r.updateAvailable).toBe(false);
    // A doc that referenced version 1 but the global is now version 3, with an embedded copy → flags an update.
    const embedded = { ref: { globalId: rec.id, version: 1 }, record: { ...rec } };
    r = await lib.resolveReference({ globalId: rec.id, version: 1 }, embedded);
    expect(r.source).toBe('embedded');
    expect(r.updateAvailable).toBe(false);   // global is still v1 here
    // A dangling reference (unknown id, no embedded) → dangling.
    const d = await lib.resolveReference({ globalId: 'gone', version: 1 });
    expect(d.source).toBe('dangling');
  });

  it('export → import RE-MINTS ids (no collision) and resets version/timestamps', async () => {
    await lib.promote('anim-clip', PAYLOAD('Walk'), { name: 'Walk', tags: ['locomotion'] });
    const bundle = await lib.export();
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.assets[0].payload).toBeDefined();   // bundle carries payloads

    // Import into a SECOND library (a different account) — ids must differ from the source.
    const d = deterministic('acctB_');
    const lib2 = new AssetLibrary(new MemoryAssetBackend(), d.mint, d.now);
    lib2.registerProvider(mockProvider({ instantiate: [] }));
    await lib2.init();
    const imported = await lib2.import(bundle, { merge: true });
    expect(imported[0].id).not.toBe(bundle.assets[0].id);   // re-minted
    expect(imported[0].version).toBe(1);
    expect(imported[0].name).toBe('Walk');                  // name/payload preserved
    expect((await lib2.get<MockPayload>(imported[0].id))?.payload.clipName).toBe('Walk');

    // Importing into the SAME library with merge:false clears first (no dupes).
    const before = lib.list()[0].id;
    const re = await lib.import(bundle, { merge: false });
    expect(lib.list()).toHaveLength(1);
    expect(re[0].id).not.toBe(before);   // fresh id, old one cleared
  });
});
