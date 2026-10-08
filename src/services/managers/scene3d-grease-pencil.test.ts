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
import type { GpStroke3D } from '../../types/grease-pencil-3d';

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

  // ── Grease Pencil fixes 2026-10-09 (docs/reviews/grease-pencil-2026-10-09.md) ──

  const black = { r: 0, g: 0, b: 0, a: 1 };
  const draw = (id: string, layerId: string, pts: [number, number, number][], frame?: number): boolean => {
    gp.beginStroke(id, layerId, black, 0.02, { frame });
    for (const [x, y, z] of pts) gp.addPoint(x, y, z);
    return gp.endStroke();
  };

  it('a kept stroke is a document change (onSceneGraphChanged → the host autosaves); a dropped dot is not', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    const before = env.calls.emitChanged;
    expect(draw(id, layerId, [[0, 0, 0]])).toBe(false);
    expect(env.calls.emitChanged).toBe(before);
    expect(draw(id, layerId, [[0, 0, 0], [1, 0, 0]])).toBe(true);
    expect(env.calls.emitChanged).toBe(before + 1);
  });

  it('addPoint skips a sample at the previous point (no zero-length segments) and non-finite points', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    gp.beginStroke(id, layerId, black, 0.02);
    gp.addPoint(0, 0, 0, 0.2); gp.addPoint(0, 0, 0, 0.8); gp.addPoint(NaN, 0, 0); gp.addPoint(1, 0, 0);
    gp.endStroke();
    const pts = gp.get(id)!.getLayer(layerId)!.strokes[0].points;
    expect(pts).toHaveLength(2);
    expect(pts[0].pressure).toBe(0.8);                     // the repeat kept the firmer pressure
  });

  it('cancelStroke() takes the open stroke back', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    gp.beginStroke(id, layerId, black, 0.02);
    gp.addPoint(0, 0, 0); gp.addPoint(1, 0, 0);
    expect(gp.hasActiveStroke).toBe(true);
    gp.cancelStroke();
    expect(gp.hasActiveStroke).toBe(false);
    expect(gp.get(id)!.getLayer(layerId)!.strokes).toHaveLength(0);
  });

  it('a stroke at a keyframed frame goes into that keyframe (what shows there); elsewhere into the base strokes', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    draw(id, layerId, [[0, 0, 0], [1, 0, 0]]);
    gp.setKeyframe(id, layerId, 5);
    expect(gp.hasKeyframe(id, layerId, 5)).toBe(true);
    draw(id, layerId, [[0, 1, 0], [1, 1, 0]], 5);
    const obj = gp.get(id)!;
    expect(obj.getActiveStrokes(layerId, 5)).toHaveLength(2);
    expect(obj.getActiveStrokes(layerId, 5)[1].points).toHaveLength(2);   // the keyframe stroke got its points
    expect(obj.getLayer(layerId)!.strokes).toHaveLength(1);                // base untouched
    draw(id, layerId, [[0, 2, 0], [1, 2, 0]], 7);                          // no keyframe at 7 → base
    expect(obj.getLayer(layerId)!.strokes).toHaveLength(2);
    expect(obj.getActiveStrokes(layerId, 5)).toHaveLength(2);
  });

  it('eraseStrokesNearRay removes the strokes the cursor ray passes near, at any depth, not behind the camera', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    draw(id, layerId, [[0, 0, -5], [0.1, 0, -5]]);          // straight ahead, far away
    draw(id, layerId, [[3, 0, -1], [3.1, 0, -1]]);          // off to the side
    draw(id, layerId, [[0, 0, 5], [0.1, 0, 5]]);            // behind the camera
    const n = gp.eraseStrokesNearRay(id, layerId, [0, 0, 0], [0, 0, -1], 0.05);
    expect(n).toBe(1);
    const left = gp.get(id)!.getLayer(layerId)!.strokes.map(s => s.points[0].z);
    expect(left).toEqual([-1, 5]);
  });

  it('getStrokeList / setStrokeList snapshot and restore a layer (the draw / erase undo step)', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    const before = gp.getStrokeList(id, layerId)!.slice();
    draw(id, layerId, [[0, 0, 0], [1, 0, 0]]);
    const after = gp.getStrokeList(id, layerId)!.slice();
    gp.setStrokeList(id, layerId, undefined, before.slice());
    expect(gp.get(id)!.getLayer(layerId)!.strokes).toHaveLength(0);
    gp.setStrokeList(id, layerId, undefined, after.slice());
    expect(gp.get(id)!.getLayer(layerId)!.strokes).toHaveLength(1);
  });

  it('removeLayer / restoreLayer and removeObject / reattachObject undo a delete', () => {
    const id = gp.createObject();
    const l1 = gp.getLayers(id)[0].id;
    const l2 = gp.addLayer(id, 'Ink');
    draw(id, l1, [[0, 0, 0], [1, 0, 0]]);
    const removed = gp.removeLayer(id, l1)!;
    expect(gp.getLayers(id).map(l => l.id)).toEqual([l2]);
    gp.restoreLayer(id, removed.layer, removed.index);
    expect(gp.getLayers(id).map(l => l.id)).toEqual([l1, l2]);
    expect(gp.get(id)!.getLayer(l1)!.strokes).toHaveLength(1);
    const node = gp.removeObject(id)!;
    expect(env.sceneGraph.root.children).toHaveLength(0);
    gp.reattachObject(node);
    expect(gp.get(id)).toBe(node);
    expect(env.sceneGraph.root.children).toContain(node);
  });

  it('strokes (with keyframes) survive the JSON round trip', () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    draw(id, layerId, [[0, 0, 0], [1, 2, 3]]);
    gp.setKeyframe(id, layerId, 3);
    draw(id, layerId, [[5, 5, 5], [6, 6, 6]], 3);
    const json = JSON.parse(JSON.stringify(gp.toStates()));
    const fresh = makeEnv();
    const gp2 = new Scene3DGreasePencil(fresh.ctx);
    gp2.restoreStates(json);
    const obj = gp2.get(id)!;
    expect(obj.getLayer(layerId)!.strokes[0].points[1]).toMatchObject({ x: 1, y: 2, z: 3 });
    expect(obj.getActiveStrokes(layerId, 3)).toHaveLength(2);
    expect(obj.getActiveStrokes(layerId, 3)[1].points[0]).toMatchObject({ x: 5, y: 5, z: 5 });
  });
});

// ── Surface placement + partial eraser (docs/reviews/grease-pencil-2026-10-09.md) ──

describe('Grease Pencil partial eraser + Surface strokes', () => {
  let env: ReturnType<typeof makeEnv>;
  let gp: Scene3DGreasePencil;
  beforeEach(() => { env = makeEnv(); gp = new Scene3DGreasePencil(env.ctx); });

  const red = { r: 1, g: 0, b: 0, a: 1 };
  const fill = { r: 0, g: 0, b: 1, a: 0.5 };
  /** A stroke along x at depth z = -5: points x = 0, 0.1, ... 1 with pressure = x. */
  const line = (id: string, layerId: string, opts?: { closed?: boolean; frame?: number }) => {
    gp.beginStroke(id, layerId, red, 0.03, { parentJoint: 'head', fillColor: fill, closed: opts?.closed, frame: opts?.frame });
    for (let i = 0; i <= 10; i++) gp.addPoint(i / 10, 0, -5, i / 10, 1);
    gp.endStroke();
  };
  const down: [number, number, number] = [0, 0, -1];
  const setup = () => {
    const id = gp.createObject();
    const layerId = gp.getLayers(id)[0].id;
    return { id, layerId, strokes: () => gp.getStrokeList(id, layerId)! };
  };
  const xs = (s: GpStroke3D) => s.points.map(p => +p.x.toFixed(6));

  it('a cut in the middle splits the stroke into 2, keeping style / bone / pressure', () => {
    const { id, layerId, strokes } = setup();
    line(id, layerId);
    const orig = strokes()[0];
    expect(gp.eraseStrokesNearRayPartial(id, layerId, [0.5, 0, 0], down, 0.12)).toBe(1);
    expect(strokes()).toHaveLength(2);
    const [a, b] = strokes();
    expect(xs(a)).toEqual([0, 0.1, 0.2, 0.3, 0.38]);
    expect(xs(b)).toEqual([0.62, 0.7, 0.8, 0.9, 1]);
    expect(a.points[4].pressure).toBeCloseTo(0.38, 9);        // cut points interpolate pressure
    for (const s of [a, b]) {
      expect(s.id).not.toBe(orig.id);
      expect(s).toMatchObject({ color: red, baseWidth: 0.03, parentJoint: 'head', fillColor: fill, closed: false });
    }
    expect(a.id).not.toBe(b.id);
  });

  it('a cut at an end leaves 1 shorter stroke; covering it all removes it', () => {
    const { id, layerId, strokes } = setup();
    line(id, layerId);
    gp.eraseStrokesNearRayPartial(id, layerId, [1, 0, 0], down, 0.15);
    expect(strokes()).toHaveLength(1);
    expect(xs(strokes()[0])).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85]);
    gp.eraseStrokesNearRayPartial(id, layerId, [0.5, 0, 0], down, 2);
    expect(strokes()).toHaveLength(0);
  });

  it('cuts a long segment even when no point is under the eraser; misses and strokes behind the camera are untouched', () => {
    const { id, layerId, strokes } = setup();
    gp.beginStroke(id, layerId, red, 0.02); gp.addPoint(0, 0, -5); gp.addPoint(1, 0, -5); gp.endStroke();
    gp.beginStroke(id, layerId, red, 0.02); gp.addPoint(0, 0, 5); gp.addPoint(1, 0, 5); gp.endStroke();   // behind
    const behind = strokes()[1];
    expect(gp.eraseStrokesNearRayPartial(id, layerId, [3, 0, 0], down, 0.1)).toBe(0);
    expect(gp.eraseStrokesNearRayPartial(id, layerId, [0.5, 0, 0], down, 0.1)).toBe(1);
    expect(strokes()).toHaveLength(3);
    expect(xs(strokes()[0])).toEqual([0, 0.4]);
    expect(xs(strokes()[1])).toEqual([0.6, 1]);
    expect(strokes()[2]).toBe(behind);                        // untouched strokes are kept as the same object
  });

  it('a cut closed loop becomes one open piece running round from the cut', () => {
    const { id, layerId, strokes } = setup();
    gp.beginStroke(id, layerId, red, 0.02, { closed: true, fillColor: fill });
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) gp.addPoint(x, y, -5);
    gp.endStroke();
    gp.eraseStrokesNearRayPartial(id, layerId, [0.5, 1, 0], down, 0.1);   // cut the top edge (1,1)→(0,1)
    expect(strokes()).toHaveLength(1);
    const s = strokes()[0];
    expect(s.closed).toBe(false);
    expect(s.points.map(p => [+p.x.toFixed(6), +p.y.toFixed(6)])).toEqual([[0.4, 1], [0, 1], [0, 0], [1, 0], [1, 1], [0.6, 1]]);
  });

  it('Whole-stroke mode is unchanged: the same eraser removes the whole stroke', () => {
    const { id, layerId, strokes } = setup();
    line(id, layerId);
    expect(gp.eraseStrokesNearRay(id, layerId, [0.5, 0, 0], down, 0.12)).toBe(1);
    expect(strokes()).toHaveLength(0);
  });

  it('a partial-erase drag is one undo step (the list snapshot from the press comes back exactly)', () => {
    const { id, layerId, strokes } = setup();
    line(id, layerId);
    gp.beginStroke(id, layerId, red, 0.03);
    for (let i = 0; i <= 10; i++) gp.addPoint(i / 10, 0.5, -5);
    gp.endStroke();
    const before = strokes().slice();
    for (const [x, y] of [[0.2, 0], [0.25, 0], [0.3, 0], [0.7, 0], [0.5, 0.5]]) gp.eraseStrokesNearRayPartial(id, layerId, [x, y, 0], down, 0.04);
    const after = strokes().slice();
    expect(Scene3DGreasePencil.sameStrokes(after, before)).toBe(false);
    expect(after).toHaveLength(5);                             // line 1 cut twice → 3 pieces, line 2 once → 2
    gp.setStrokeList(id, layerId, undefined, before.slice());  // undo
    expect(Scene3DGreasePencil.sameStrokes(strokes(), before)).toBe(true);
    expect(strokes()[0].points).toHaveLength(11);
    gp.setStrokeList(id, layerId, undefined, after.slice());   // redo
    expect(strokes()).toHaveLength(5);
    // an eraser that touched nothing changes nothing (no undo step)
    const now = strokes().slice();
    gp.eraseStrokesNearRayPartial(id, layerId, [9, 9, 0], down, 0.04);
    expect(Scene3DGreasePencil.sameStrokes(strokes(), now)).toBe(true);
  });

  it('a partial erase on a keyframed frame edits that keyframe only', () => {
    const { id, layerId } = setup();
    line(id, layerId);
    gp.setKeyframe(id, layerId, 4);
    gp.eraseStrokesNearRayPartial(id, layerId, [0.5, 0, 0], down, 0.12, 4);
    const obj = gp.get(id)!;
    expect(obj.getActiveStrokes(layerId, 4)).toHaveLength(2);
    expect(obj.getLayer(layerId)!.strokes).toHaveLength(1);
  });

  it('Surface events: a break ends the piece, the next point starts a new stroke with the same style', () => {
    const { id, layerId, strokes } = setup();
    const before = strokes().slice();
    const style = { color: red, baseWidth: 0.03, parentJoint: 'head', closed: true, fillColor: fill };
    gp.applyPlacedEvents(id, layerId, undefined, style, [
      { kind: 'point', x: 0, y: 0, z: 1, pressure: 0.5 }, { kind: 'point', x: 0.1, y: 0, z: 1, pressure: 1 },
      { kind: 'break' },
    ]);
    gp.applyPlacedEvents(id, layerId, undefined, style, [
      { kind: 'point', x: 1, y: 0, z: 1, pressure: 1 }, { kind: 'break' },          // a 1-point piece: dropped
      { kind: 'point', x: 2, y: 0, z: 1, pressure: 1 }, { kind: 'point', x: 2.1, y: 0, z: 1, pressure: 1 },
    ]);
    gp.endSurfaceStroke(id, layerId, undefined, before);
    expect(strokes()).toHaveLength(2);
    expect(strokes()[0].points.map(p => p.x)).toEqual([0, 0.1]);
    expect(strokes()[0].points[0].pressure).toBe(0.5);
    expect(strokes()[1].points.map(p => p.x)).toEqual([2, 2.1]);
    for (const s of strokes()) expect(s).toMatchObject({ color: red, baseWidth: 0.03, parentJoint: 'head', closed: false });
    expect(gp.hasActiveStroke).toBe(false);
    // one unbroken Surface stroke keeps Closed
    const before2 = strokes().slice();
    gp.applyPlacedEvents(id, layerId, undefined, style, [
      { kind: 'point', x: 0, y: 1, z: 1, pressure: 1 }, { kind: 'point', x: 1, y: 1, z: 1, pressure: 1 }, { kind: 'point', x: 1, y: 2, z: 1, pressure: 1 },
    ]);
    gp.endSurfaceStroke(id, layerId, undefined, before2);
    expect(strokes()[2].closed).toBe(true);
  });

  it('split and Surface strokes survive the JSON round trip; an old flat-sheet save loads unchanged', () => {
    const { id, layerId, strokes } = setup();
    line(id, layerId);
    gp.eraseStrokesNearRayPartial(id, layerId, [0.5, 0, 0], down, 0.12);
    const before = strokes().slice();
    gp.applyPlacedEvents(id, layerId, undefined, { color: red, baseWidth: 0.02 }, [
      { kind: 'point', x: 0, y: 1.01, z: 0, pressure: 1 }, { kind: 'point', x: 0.2, y: 0.99, z: 0.1, pressure: 0.7 },
    ]);
    gp.endSurfaceStroke(id, layerId, undefined, before);
    const saved = strokes().map(s => JSON.parse(JSON.stringify(s)));
    const gp2 = new Scene3DGreasePencil(makeEnv().ctx);
    gp2.restoreStates(JSON.parse(JSON.stringify(gp.toStates())));
    expect(gp2.getStrokeList(id, layerId)).toEqual(saved);
    expect(gp2.getStrokeList(id, layerId)).toHaveLength(3);

    // a save from before these modes (flat-sheet strokes, no new fields anywhere)
    const legacyStroke = { id: 's1', points: [{ x: 0, y: 0, z: 0.5, pressure: 1, opacity: 1 }, { x: 1, y: 0, z: 0.5, pressure: 0.5, opacity: 1 }],
      color: { r: 0, g: 0, b: 0, a: 1 }, baseWidth: 0.02, closed: false };
    const legacy = [{ id: 'gp-old', type: 'GpObject3D', name: 'GP Object', renderOrder: 0,
      layers: [{ id: 'L1', name: 'Layer 1', visible: true, opacity: 1, strokes: [legacyStroke], keyframes: {} }] }];
    const gp3 = new Scene3DGreasePencil(makeEnv().ctx);
    gp3.restoreStates(JSON.parse(JSON.stringify(legacy)));
    expect(gp3.getStrokeList('gp-old', 'L1')).toEqual([legacyStroke]);
    expect(gp3.get('gp-old')!.getActiveStrokesAllLayers(0).map(e => e.stroke)).toEqual([legacyStroke]);
  });
});
