/**
 * End-to-end persistence round trip (audit 2026-09-28 P12).
 *
 * The engine needs a GPU, so this runs at the level where the save/load bug family actually lived: the WHOLE document
 * payload through every storage path —
 *   1. autosave write → load gives back every section,
 *   2. write → load → write is IDEMPOTENT (byte-identical files — nothing drifts, nothing is dropped on re-save),
 *   3. the .frogmarks package yields the same payload as the autosave folder (the two paths can't drift apart).
 *
 * ★ The fixture is typed `Required<DocumentSavePayload>`: adding a field to the payload is a COMPILE error here until
 * it's added — and the round-trip then checks it. That is the guard against the P3 class ("gathered, never written").
 * A field that is intentionally NOT persisted must be listed in NOT_PERSISTED, with a reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentPersistence, type DocumentSavePayload } from './document-persistence';
import { packProject, unpackProject } from './project-package';
import { installFakeOPFS, type FakeDir } from './opfs-fake';
import { DOCUMENT_SCHEMA_VERSION } from './schema-version';

/** Payload keys that are control signals for ONE save, not document content — never written to disk. */
const NOT_PERSISTED = new Set<keyof DocumentSavePayload>([
  '_onWriteComplete',      // post-write callback
  'models3dComplete',      // prune-safety flag for this save
  'meshTexturesComplete',  // prune-safety flag for this save
  'pixelContentKeys',      // incremental-autosave content keys (which files this save may leave as they are)
]);

const buf = (...b: number[]): ArrayBuffer => new Uint8Array(b).buffer;

/** Every section populated. Pixel format 'raw' so encoding needs no canvas. */
function fullPayload(): Required<DocumentSavePayload> {
  return {
    manifest: {
      version: 3, schemaVersion: DOCUMENT_SCHEMA_VERSION, docId: 'rt', name: 'Round trip',
      createdAt: '2026-09-28T00:00:00Z', savedAt: '2026-09-28T00:00:01Z',
      canvasWidth: 1, canvasHeight: 1, pixelFormat: 'raw', documentSize: { w: 1, h: 1 },
      layers: [{ id: 'L1', name: 'Ink', visible: true, locked: false, opacity: 1, blendMode: 'normal',
        clipped: false, lockTransparency: false, celIds: [] }],
      animation: null,
    } as unknown as DocumentSavePayload['manifest'],
    sceneGraphJSON: JSON.stringify({ root: { id: 'root', children: [{ id: 's1', type: 'Rect' }] } }),
    brushPresetsJSON: JSON.stringify([{ name: 'ink', size: 4 }]),
    layers: [{ id: 'L1', pixelData: buf(10, 20, 30, 255) }],
    cels: [],
    scene3dJSON: JSON.stringify({
      nodes: [{ id: 'm1', type: '3DMesh', submeshes: [{ indexOffset: 0, indexCount: 3, material: {} }] }],
      skeletons: [{ id: 'sk1' }], characters: [{ id: 'c1' }], gpObjects: [{ id: 'gp1' }],
      packaging: [{ id: 'pk1' }], globalScene: { fog: { enabled: true }, scriptBehaviors: [{ nodeId: 'm1' }] },
      faceRigs: [{ bodyMeshId: 'b' }], clothingRigs: [{ slot: 'top' }], hairRigs: [], bodyParams: [], attachments: [],
    }),
    models3d: { m1: buf(1, 2, 3, 4) },
    models3dComplete: true,
    meshTexturesComplete: true,
    meshTextures: { m1: buf(9, 9), '__face__:b:smile': buf(8), '__cloth__:b:top': buf(7), '__proc__:c:door': buf(6) },
    bakedParts: { part1: buf(5, 5, 5) },
    textureLibrary: { entries: [{ id: 'tex1', name: 'bricks' }] },
    ephemeraJSON: JSON.stringify({ placements: [{ id: 'e1' }] }),
    garpJSON: { pools: [{ id: 'salsa/vending', version: 3 }], textures: { k: { kind: 'image' } } },
    uiLayersJSON: JSON.stringify([{ id: 'ui1', name: 'Menu' }]),
    pixelContentKeys: { layers: { L1: 'k1' }, cels: {} },
    _onWriteComplete: () => {},
  };
}

/** ArrayBuffers → byte arrays (recursively) so toEqual compares CONTENT. */
function plain(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return [...new Uint8Array(v)];
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** The persisted content of a payload: every key except NOT_PERSISTED. */
function persisted(p: DocumentSavePayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (!NOT_PERSISTED.has(k as keyof DocumentSavePayload)) out[k] = plain(v);
  return out;
}

/** Snapshot every file under a fake OPFS dir → { path: bytes } for byte-identity checks. */
async function snapshot(dir: FakeDir, prefix = ''): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  for (const [name, e] of dir.children) {
    const path = `${prefix}${name}`;
    if (e.kind === 'directory') Object.assign(out, await snapshot(e, `${path}/`));
    else out[path] = [...new Uint8Array(await (await e.getFile()).arrayBuffer())];
  }
  return out;
}

let root: FakeDir;
beforeEach(() => {
  root = installFakeOPFS(vi.stubGlobal);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function persistenceFor(payload: () => DocumentSavePayload): DocumentPersistence {
  const p = new DocumentPersistence({ intervalMs: 0, strokeDebounceMs: 0, pixelFormat: 'raw' });
  p.setStateProvider(async () => payload());
  return p;
}

describe('persistence round trip — every section, every path (audit 2026-09-28 P12)', () => {
  it('the fixture covers every payload key (a new field fails to compile until it is added here)', () => {
    const keys = Object.keys(fullPayload()) as (keyof DocumentSavePayload)[];
    for (const k of NOT_PERSISTED) expect(keys).toContain(k);   // the exemption list can't go stale either
    expect(keys.length).toBeGreaterThan(NOT_PERSISTED.size);
  });

  it('autosave: write → load returns every persisted section unchanged', async () => {
    const full = fullPayload();
    expect(await persistenceFor(() => full).saveNow()).toBe(true);
    const loaded = await persistenceFor(() => full).loadDocument('rt');
    expect(loaded).not.toBeNull();
    expect(persisted(loaded!)).toEqual(persisted(full));
  });

  it('autosave: write → load → write is idempotent (byte-identical files)', async () => {
    const full = fullPayload();
    await persistenceFor(() => full).saveNow();
    const first = await snapshot(root);
    const loaded = (await persistenceFor(() => full).loadDocument('rt'))!;
    await persistenceFor(() => loaded).saveNow();          // a fresh instance → save #0 → prunes too
    expect(await snapshot(root)).toEqual(first);
  });

  it('.frogmarks yields exactly the payload the autosave folder does (the two paths cannot drift)', async () => {
    const full = fullPayload();
    await persistenceFor(() => full).saveNow();
    const fromOPFS = (await persistenceFor(() => full).loadDocument('rt'))!;
    const fromPackage = (await unpackProject(await packProject(full))).docPayload;
    expect(persisted(fromPackage)).toEqual(persisted(fromOPFS));
  });
});
