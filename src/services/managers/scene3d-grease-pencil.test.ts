import { describe, it, expect, beforeEach } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { Scene3DGreasePencil } from './scene3d-grease-pencil';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

// §5.1 extraction: the Grease-Pencil DATA MODEL depends only on ManagerContext (no gizmo/pick/canvas), so it is
// fully unit-testable with a real SceneGraph + a stubbed InteractionService. These pin the object/layer/stroke/
// keyframe lifecycle and the JSON round-trip — the state the god-object used to own inline.

function makeEnv() {
  const calls = { scheduleRender: 0, emitChanged: 0 };
  const sceneGraph = new SceneGraph();
  const ctx = {
    sceneGraph,
    interactionService: { maxGlobalZIndex: 0 } as unknown as InteractionService,
    scheduleRender: () => { calls.scheduleRender++; },
    emitSceneGraphChanged: () => { calls.emitChanged++; },
  } as unknown as ManagerContext;
  return { ctx, sceneGraph, calls };
}

describe('§5.1 Scene3DGreasePencil (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  let gp: Scene3DGreasePencil;
  beforeEach(() => { env = makeEnv(); gp = new Scene3DGreasePencil(env.ctx); });

  it('createObject() attaches a GpObject to the scene root with a default layer', () => {
    const id = gp.createObject('Sketch');
    expect(gp.get(id)).not.toBeNull();
    expect(gp.getAll()).toHaveLength(1);
    expect(env.sceneGraph.root.children).toContain(gp.get(id));
    expect(gp.getLayers(id)).toHaveLength(1);              // 'Layer 1'
    expect(gp.getAllDescriptors()[0]).toMatchObject({ id, name: 'Sketch' });
  });

  it('addLayer / removeLayer manage layers', () => {
    const id = gp.createObject();
    const l2 = gp.addLayer(id, 'Layer 2');
    expect(l2).toBeTruthy();
    expect(gp.getLayers(id)).toHaveLength(2);
    gp.removeLayer(id, l2);
    expect(gp.getLayers(id)).toHaveLength(1);
  });

  it('a stroke needs >= 2 points or it is discarded on endStroke()', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;

    // One point → discarded.
    gp.beginStroke(id, layerId, { r: 0, g: 0, b: 0, a: 1 }, 0.02);
    gp.addPoint(0, 0, 0);
    gp.endStroke();
    expect(gp.get(id)!.getLayer(layerId)!.strokes).toHaveLength(0);

    // Two points → kept.
    gp.beginStroke(id, layerId, { r: 1, g: 0, b: 0, a: 1 }, 0.02);
    gp.addPoint(0, 0, 0);
    gp.addPoint(1, 1, 1);
    gp.endStroke();
    expect(gp.get(id)!.getLayer(layerId)!.strokes).toHaveLength(1);
  });

  it('beginStroke() finalizes an already-open stroke first (no dangling cursor)', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    gp.beginStroke(id, layerId, { r: 0, g: 0, b: 0, a: 1 }, 0.02);
    gp.addPoint(0, 0, 0); gp.addPoint(1, 0, 0);      // 2 points → will be kept when auto-finalized
    gp.beginStroke(id, layerId, { r: 0, g: 0, b: 0, a: 1 }, 0.02);   // opens a second → finalizes the first
    gp.addPoint(2, 0, 0); gp.addPoint(3, 0, 0);
    gp.endStroke();
    expect(gp.get(id)!.getLayer(layerId)!.strokes).toHaveLength(2);
  });

  it('layer visibility + opacity clamp to [0,1]', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    gp.setLayerVisible(id, layerId, false);
    gp.setLayerOpacity(id, layerId, 5);
    const layer = gp.getLayers(id)[0];
    expect(layer.visible).toBe(false);
    expect(layer.opacity).toBe(1);
  });

  it('removeObject() detaches the node, and clears the active stroke if it belonged to that object', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    gp.beginStroke(id, layerId, { r: 0, g: 0, b: 0, a: 1 }, 0.02);   // active stroke on `id`
    gp.removeObject(id);
    expect(gp.getAll()).toHaveLength(0);
    expect(env.sceneGraph.root.children).toHaveLength(0);
    // The active-stroke cursor was cleared → a stray addPoint is a safe no-op (doesn't throw).
    expect(() => gp.addPoint(0, 0, 0)).not.toThrow();
  });

  it('toStates() / restoreStates() round-trips objects through JSON', () => {
    const id = gp.createObject('Round Trip');
    const layerId = gp.getLayers(id)[0].id;
    gp.beginStroke(id, layerId, { r: 0.2, g: 0.4, b: 0.6, a: 1 }, 0.03);
    gp.addPoint(0, 0, 0); gp.addPoint(1, 1, 0);
    gp.endStroke();

    const states = gp.toStates();
    expect(states).toHaveLength(1);

    const fresh = makeEnv();
    const gp2 = new Scene3DGreasePencil(fresh.ctx);
    gp2.restoreStates(states);
    expect(gp2.getAll()).toHaveLength(1);
    const rid = gp2.getAll()[0].id;
    expect(gp2.getAllDescriptors()[0].name).toBe('Round Trip');
    expect(gp2.get(rid)!.getLayer(gp2.getLayers(rid)[0].id)!.strokes).toHaveLength(1);
    expect(fresh.sceneGraph.root.children).toHaveLength(1);
  });

  it('dispose() drops all objects', () => {
    gp.createObject(); gp.createObject();
    gp.dispose();
    expect(gp.getAll()).toHaveLength(0);
  });
});
