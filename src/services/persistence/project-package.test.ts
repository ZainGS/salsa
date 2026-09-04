import { describe, it, expect } from 'vitest';
import { packProject, unpackProject, type PackageInput } from './project-package';
import type { DocumentManifest, DocumentSavePayload } from './document-persistence';

/** Minimal manifest with no raster layers (so packing skips pixel encoding — no canvas needed in Node). */
function manifest(): DocumentManifest {
  return {
    version: 3, docId: 'd1', name: 'Test', createdAt: 'a', savedAt: 'b',
    canvasWidth: 1, canvasHeight: 1, layers: [], animation: null, pixelFormat: 'raw',
  };
}

function baseInput(uiLayersJSON: string | null): PackageInput {
  const docPayload: DocumentSavePayload = {
    manifest: manifest(), sceneGraphJSON: null, brushPresetsJSON: null, layers: [], cels: [], uiLayersJSON,
  };
  return {
    docPayload, gpObjects3d: [], nodes3d: [], skeletons3d: [], characters3d: [],
    models3d: new Map(), textureLibrary: null, ephemeraJSON: null, globalScene3d: null,
  };
}

describe('project-package — UI System round-trip', () => {
  it('carries uiLayersJSON through pack → unpack', async () => {
    const uiLayers = [{
      id: 'ui1', name: 'Main Menu', type: 'ui-layer', visible: true, passThroughPointer: true,
      backgroundOverlay: { color: [0, 0, 0, 0.6] },
      shapeInteractions: { btn: { shapeId: 'btn', cursor: 'pointer', focusable: true } },
      stateMachine: {
        id: 'm', initialStateId: 'title',
        states: [{ id: 'title', name: 'Title' }, { id: 'game', name: 'Game' }],
        transitions: [{ id: 't1', fromState: 'title', toState: 'game', trigger: { type: 'click', targetId: 'btn' } }],
        variables: [{ id: 'coins', name: 'Coins', type: 'number', defaultValue: 0 }],
      },
    }];
    const json = JSON.stringify(uiLayers);

    const blob = await packProject(baseInput(json));
    const out = await unpackProject(blob);

    expect(out.docPayload.uiLayersJSON).toBe(json);
    const parsed = JSON.parse(out.docPayload.uiLayersJSON!);
    expect(parsed[0].stateMachine.initialStateId).toBe('title');
    expect(parsed[0].stateMachine.transitions[0].trigger.targetId).toBe('btn');
    expect(parsed[0].shapeInteractions.btn.cursor).toBe('pointer');
    expect(parsed[0].backgroundOverlay.color).toEqual([0, 0, 0, 0.6]);
  });

  it('a project with no UI layers unpacks uiLayersJSON as null (backwards compatible)', async () => {
    const blob = await packProject(baseInput(null));
    const out = await unpackProject(blob);
    expect(out.docPayload.uiLayersJSON).toBeNull();
  });
});
