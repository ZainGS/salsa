import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { packProject, unpackProject, PACKAGE_FORMAT_VERSION } from './project-package';
import type { DocumentManifest, DocumentSavePayload } from './document-persistence';

/** Minimal manifest with no raster layers (so packing skips pixel encoding — no canvas needed in Node). */
function manifest(): DocumentManifest {
  return {
    version: 3, docId: 'd1', name: 'Test', createdAt: 'a', savedAt: 'b',
    canvasWidth: 1, canvasHeight: 1, layers: [], animation: null, pixelFormat: 'raw',
  };
}

function payload(over: Partial<DocumentSavePayload> = {}): DocumentSavePayload {
  return { manifest: manifest(), sceneGraphJSON: null, brushPresetsJSON: null, layers: [], cels: [], ...over };
}

const bytes = (...b: number[]) => new Uint8Array(b).buffer;
const arr = (buf: ArrayBuffer | undefined) => (buf ? [...new Uint8Array(buf)] : undefined);

describe('project-package — the package IS the autosave payload (audit 2026-09-28 P4)', () => {
  it('round-trips EVERY payload section, incl. the ones v1 dropped (meshTextures, bakedParts, GARP)', async () => {
    const scene3dJSON = JSON.stringify({
      nodes: [{ id: 'm1', type: '3DMesh' }], skeletons: [{ id: 's1' }],
      characters: [{ id: 'c1' }], gpObjects: [{ id: 'gp1' }], packaging: [{ id: 'pk1' }],
      globalScene: { fog: { enabled: true } }, clothingRigs: [{ slot: 'top' }],
    });
    const input = payload({
      sceneGraphJSON: '{"root":{}}',
      brushPresetsJSON: '[{"name":"ink"}]',
      scene3dJSON,
      models3d: { m1: bytes(1, 2, 3) },
      meshTextures: { m1: bytes(9), '__face__:b:e1': bytes(8), '__cloth__:b:top': bytes(7) },
      bakedParts: { part1: bytes(5, 5) },
      textureLibrary: { entries: [{ id: 't1' }] },
      ephemeraJSON: '{"placements":[]}',
      uiLayersJSON: '[{"id":"ui1"}]',
      garpJSON: { pools: [{ id: 'p1' }], textures: {} },
    });

    const out = await unpackProject(await packProject(input));
    const p = out.docPayload;

    expect(out.formatVersion).toBe(PACKAGE_FORMAT_VERSION);
    expect(p.sceneGraphJSON).toBe(input.sceneGraphJSON);
    expect(p.brushPresetsJSON).toBe(input.brushPresetsJSON);
    expect(p.scene3dJSON).toBe(scene3dJSON);                            // verbatim — incl. packaging/catalog/GP
    expect(arr(p.models3d?.m1)).toEqual([1, 2, 3]);
    expect(Object.keys(p.meshTextures ?? {}).sort()).toEqual(['__cloth__:b:top', '__face__:b:e1', 'm1']);
    expect(arr(p.meshTextures?.['__face__:b:e1'])).toEqual([8]);
    expect(arr(p.bakedParts?.part1)).toEqual([5, 5]);
    expect(p.textureLibrary).toEqual(input.textureLibrary);
    expect(p.ephemeraJSON).toBe(input.ephemeraJSON);
    expect(p.uiLayersJSON).toBe(input.uiLayersJSON);
    expect(p.garpJSON).toEqual(input.garpJSON);

    // convenience views (the standalone viewer reads these)
    expect(out.nodes3d.map((n) => n.id)).toEqual(['m1']);
    expect(out.characters3d).toEqual([{ id: 'c1' }]);
    expect(out.models3d.get('m1')?.byteLength).toBe(3);
  });

  it('an empty project unpacks its optional sections as null/empty', async () => {
    const out = await unpackProject(await packProject(payload()));
    expect(out.docPayload.uiLayersJSON).toBeNull();
    expect(out.docPayload.garpJSON).toBeNull();
    expect(out.docPayload.scene3dJSON).toBeNull();
    expect(out.docPayload.meshTextures).toEqual({});
    expect(out.nodes3d).toEqual([]);
  });

  it('still reads a legacy v1 package (scene3d.json shape is compatible with the normal restore)', async () => {
    const v1scene3d = { nodes: [{ id: 'old' }], skeletons: [], characters: [], gpObjects: [], globalScene: null,
      faceRigs: [], clothingRigs: [], hairRigs: [], bodyParams: [], attachments: [] };
    const zipped = zipSync({
      'manifest.json': strToU8(JSON.stringify({ formatVersion: 1, document: manifest(), nodes3dCount: 1, models3dIds: ['old'] })),
      'scene.json': strToU8('{"root":{}}'),
      'scene3d.json': strToU8(JSON.stringify(v1scene3d)),
      'ui.json': strToU8('[]'),
      'models3d/old.glb': new Uint8Array([4, 2]),
    });
    const out = await unpackProject(new Blob([zipped as BlobPart]));
    expect(out.formatVersion).toBe(1);
    expect(JSON.parse(out.docPayload.scene3dJSON!).nodes[0].id).toBe('old');
    expect(arr(out.docPayload.models3d?.old)).toEqual([4, 2]);
    expect(out.docPayload.uiLayersJSON).toBe('[]');
  });

  it('refuses a package from a newer build', async () => {
    const zipped = zipSync({ 'manifest.json': strToU8(JSON.stringify({ formatVersion: 99, document: manifest() })) });
    await expect(unpackProject(new Blob([zipped as BlobPart]))).rejects.toThrow(/newer than this build/);
  });
});
