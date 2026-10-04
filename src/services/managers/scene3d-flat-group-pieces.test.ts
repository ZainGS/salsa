/**
 * Step 3b (performance-plan §P13 "Step 3b"): addFlatColorMeshGroup in PIECES (begin, addFlatColorLayer3D over arbitrary
 * unit ranges, attach) builds exactly the one-shot group: same children, same order, same transforms, materials and
 * geometry; the group is in the scene only after attach.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Scene3DManager, type FlatColorLayer3D } from './scene3d-manager';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { Node } from '../../scene-graph/shapes/base/node';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { generateBox } from '../../renderer/3d/mesh-generators';

const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

function makeManager(): { m: Scene3DManager; root: Node } {
    const perm = <T extends object>(t: T): T => new Proxy(t, { get: (o, k) => (k in o ? (o as Record<string | symbol, unknown>)[k] : () => undefined) });
    const cam = new Camera3D();
    const r3 = perm({ getCamera: () => cam });
    const wr = perm({ getRenderer3D: () => r3, getCanvas: () => null });
    const root = new Node();
    let ver = 0;
    const ctx = perm({ webgpuRenderer: wr, sceneGraph: { root, findNodeById: () => null }, sceneStructureVersion: () => ver, emitSceneGraphChanged: () => { ver++; }, scheduleRender: () => {} });
    return { m: new Scene3DManager(ctx as never), root };
}

function layers(): FlatColorLayer3D[] {
    const box = generateBox(1, 1, 1);
    const inst = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i * 2, y: 0.5 * i, z: -i, ry: i * 0.3, ...(i % 3 === 0 ? { tint: [0.1 * i % 1, 0.5, 0.2] as [number, number, number] } : {}) }));
    return [
        { name: 'world:road', geometry: box, color: [0.3, 0.3, 0.3], ground: { surface: 'asphalt' as never } },
        { name: 'world:lamp', geometry: box, color: [0.9, 0.8, 0.2], instances: inst(23), instanceKey: 'lamp', emissive: 0.8 },
        { name: 'world:tree', geometry: box, color: [0.2, 0.6, 0.2], instances: inst(40), arrayGroup: true, instanceKey: 'tree', leafCard: true },
        { name: 'world:sign', geometry: box, color: [1, 0, 0], pattern: { color: [1, 1, 1], freq: 3, mode: 'stripes' }, opacity: 0.5 },
        { name: 'world:bench', geometry: box, color: [0.5, 0.3, 0.1], instances: inst(7), instanceKey: 'bench', singleSided: true, nearTwin: { key: 'b', role: 'near', dist: 30 } },
    ];
}

/** A comparable description of a group's children (ids aside). */
function describeGroup(grp: Node): unknown[] {
    return grp.children.map((c) => {
        if (c instanceof Mesh3D) {
            const { id: _id, ...mat } = c.material as unknown as Record<string, unknown>;
            return { kind: 'mesh', name: c.name, x: c.x, y: c.y, z: c.z, ry: c.rotationY, geom: c.geometry, key: /^wld:/.test(c.geometryKey) ? c.geometryKey : '(own)',
                mat: JSON.stringify(mat), pick: c.pickable, twin: [c.lodTwinRole, c.lodTwinDist], visible: c.visible };
        }
        const a = c as unknown as { name: string; offsets?: unknown; instanceOverrides?: Map<number, unknown>; config?: unknown };
        return { kind: c.constructor.name, name: a.name, cfg: JSON.stringify(a.config ?? null), ov: JSON.stringify([...(a.instanceOverrides ?? new Map())]) };
    });
}

describe('scene3d: addFlatColorMeshGroup in pieces (step 3b)', () => {
    it('begin + addFlatColorLayer3D ranges + attach = the one-shot group', () => {
        const { m, root } = makeManager();
        const one = m.addFlatColorMeshGroup('World Tile 1_0 World Furniture', layers(), true);
        const L = layers();
        const pieces = m.beginFlatColorMeshGroup3D('World Tile 1_0 World Furniture');
        expect(pieces.parent).toBeNull();
        let step = 0;
        for (const layer of L) {
            const total = m.flatColorLayerUnits3D(layer);
            let u = 0;
            while (u < total) {
                const n = 1 + (step++ % 5);
                u = m.addFlatColorLayer3D(pieces, layer, u, n);
                expect(pieces.parent).toBeNull();   // nothing in the scene while it is being built
            }
            expect(m.addFlatColorLayer3D(pieces, layer, total, 3)).toBe(total);   // past the end: no more meshes
        }
        m.attachFlatColorMeshGroup3D(pieces, undefined, true);
        expect(pieces.parent).toBe(root);
        // (the layers' geometry objects differ between the two calls only by identity: compare the rest)
        const strip = (d: unknown[]) => d.map((x) => ({ ...(x as object), geom: undefined }));
        expect(strip(describeGroup(pieces))).toEqual(strip(describeGroup(one)));
        expect(pieces.children.length).toBe(1 + 23 + 2 + 1 + 7);   // road, 23 lamps, tree source + array group, sign, 7 benches
    });
});
