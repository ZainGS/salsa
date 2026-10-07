/**
 * sm.getSceneGraphJSON2D (mobile-parity §7.3c): the scene graph Frogmarks' cloud save sends the server — the vector
 * (2D) content only; every 3D mesh goes up as its own blob. Cloud saves used to drop the vector shapes entirely.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const g0 = globalThis as Record<string, unknown>;
g0.self ??= globalThis;
g0.crypto ??= webcrypto;
import { Node } from '../../scene-graph/shapes/base/node';
import { Group } from '../../scene-graph/shapes/base/group';
import { Rectangle } from '../../scene-graph/shapes/rectangle';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { InteractionService } from '../interaction-service';
import { isSceneNode3D, vectorSceneObject } from './vector-scene-json';

const isvc = { getViewportCenter: () => [0, 0], maxGlobalZIndex: 0 } as unknown as InteractionService;
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
let nextId = 0;
function rect(x: number): Rectangle {
  const r = new Rectangle(x, 0, 10, 10, WHITE, BLACK, 1, isvc);
  r.setId(`v${nextId++}`);
  return r;
}
/** Stand-ins for the 3D shapes (their constructors need the GPU-side scene); only getType matters to the filter. */
class Fake3D extends Node {
  constructor(private readonly t: string) { super(); }
  getType(): string { return this.t; }
  toJSON(): unknown { return { type: this.t, geometry: 'HUGE' }; }
}

describe('vectorSceneObject', () => {
  it('keeps the 2D nodes (with their children and layer ids) and drops every 3D node', () => {
    const root = new Node();
    const a = rect(1); a.layerId = 'vec-1';
    const g = new Group(isvc); g.addChild(rect(2));
    root.addChild(a);
    for (const t of ['3DMesh', '3DMeshGroup', '3DArrayGroup', '3DClothMesh', 'ParticleEmitter3D', 'GpObject3D']) root.addChild(new Fake3D(t));
    root.addChild(new Skeleton3D({ name: 'rig', joints: [], clips: [] } as never));
    root.addChild(g);

    const json = vectorSceneObject(root) as { root: { children: Array<{ type?: string; layerId?: string; children?: unknown[] }> } };
    expect(json.root.children.length).toBe(2);
    expect(json.root.children[0]).toEqual(a.toJSON());
    expect(json.root.children[0].layerId).toBe('vec-1');
    expect(json.root.children[1]).toEqual(g.toJSON());
    expect(JSON.stringify(json)).not.toContain('HUGE');
    // the live graph is untouched
    expect(root.children.length).toBe(9);
  });

  it("the root's own fields are what Node.toJSON writes for it", () => {
    const root = new Node();
    root.addChild(rect(3));
    const full = root.toJSON();
    const two = vectorSceneObject(root).root as Record<string, unknown>;
    for (const k of Object.keys(full)) if (k !== 'children') expect(two[k]).toEqual(full[k]);
  });

  it('isSceneNode3D', () => {
    expect(isSceneNode3D(rect(4))).toBe(false);
    expect(isSceneNode3D(new Group(isvc))).toBe(false);
    expect(isSceneNode3D(new Fake3D('3DMesh'))).toBe(true);
    expect(isSceneNode3D(new Skeleton3D({ name: 's', joints: [], clips: [] } as never))).toBe(true);
    expect(isSceneNode3D(null)).toBe(false);
  });
});
