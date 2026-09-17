import { describe, it, expect } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { rebase3DNodeToParent, worldTRS3D, captureLocalTRS3D, restoreLocalTRS3D } from './transform-rebase-3d';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { InteractionService } from '../interaction-service';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

function world(n: Mesh3D | MeshGroup3D): [number, number, number] {
    const { t } = worldTRS3D(n);
    return [t[0], t[1], t[2]];
}

describe('rebase3DNodeToParent — reparent without moving in world space (P3)', () => {
    it('into a TRANSLATED group: world position holds, local is rebased', () => {
        const sg = new SceneGraph();
        const grp = new MeshGroup3D(isvc);
        grp.setXYZ(10, 0, -5);
        grp.updateLocalMatrix();
        sg.root.addChild(grp);
        const m = new Mesh3D(isvc, 2, 3, 4, { primitive: 'box' });
        sg.root.addChild(m);

        rebase3DNodeToParent(m, grp);

        expect(m.parent).toBe(grp);
        expect(m.x).toBeCloseTo(-8);           // 2 - 10
        expect(m.z).toBeCloseTo(9);            // 4 - (-5)
        const [wx, wy, wz] = world(m);
        expect([wx, wy, wz].map((v) => +v.toFixed(6))).toEqual([2, 3, 4]);
    });

    it('into a ROTATED group: world position AND orientation hold', () => {
        const sg = new SceneGraph();
        const grp = new MeshGroup3D(isvc);
        grp.rotationY = Math.PI / 2;
        grp.updateLocalMatrix();
        sg.root.addChild(grp);
        const m = new Mesh3D(isvc, 1, 0, 0, { primitive: 'box' });
        sg.root.addChild(m);

        rebase3DNodeToParent(m, grp);

        const [wx, , wz] = world(m);
        expect(wx).toBeCloseTo(1);
        expect(wz).toBeCloseTo(0);
        // group yaw +90° absorbed as local yaw −90° so world orientation is unchanged
        expect(m.rotationY).toBeCloseTo(-Math.PI / 2);
    });

    it('OUT of a rotated+scaled group to root: transform composes in (nothing jumps)', () => {
        const sg = new SceneGraph();
        const grp = new MeshGroup3D(isvc);
        grp.setXYZ(5, 1, 0);
        grp.rotationY = Math.PI / 2;
        grp.scaleX = 2; grp.scaleY = 2; grp.scaleZ = 2;   // uniform — exact TRS case
        grp.updateLocalMatrix();
        sg.root.addChild(grp);
        const m = new Mesh3D(isvc, 1, 0, 0, { primitive: 'box' });
        grp.addChild(m);

        const before = world(m);                // (5, 1, -2): +x child lands on -z after yaw, ×2
        expect(before[0]).toBeCloseTo(5);
        expect(before[2]).toBeCloseTo(-2);

        rebase3DNodeToParent(m, sg.root);

        expect(m.parent).toBe(sg.root);
        const after = world(m);
        expect(after.map((v) => +v.toFixed(6))).toEqual(before.map((v) => +v.toFixed(6)));
        expect(m.rotationY).toBeCloseTo(Math.PI / 2);
        expect(m.scaleX).toBeCloseTo(2);
    });

    it('already a direct child of the target parent: exact no-op', () => {
        const sg = new SceneGraph();
        const m = new Mesh3D(isvc, 1, 2, 3, { primitive: 'box' });
        m.rotationY = 0.4;
        sg.root.addChild(m);
        rebase3DNodeToParent(m, sg.root);
        expect([m.x, m.y, m.z, m.rotationY]).toEqual([1, 2, 3, 0.4]);
    });

    it('capture/restore round-trips the local TRS fields', () => {
        const sg = new SceneGraph();
        const m = new Mesh3D(isvc, 1, 2, 3, { primitive: 'box' });
        m.rotationX = 0.1; m.rotationY = 0.2; m.rotation = 0.3;
        m.scaleX = 2; m.scaleY = 3; m.scaleZ = 4;
        sg.root.addChild(m);
        const snap = captureLocalTRS3D(m);
        m.setXYZ(9, 9, 9); m.rotationY = 1.5; m.scaleX = 7;
        restoreLocalTRS3D(m, snap);
        expect([m.x, m.y, m.z]).toEqual([1, 2, 3]);
        expect([m.rotationX, m.rotationY, m.rotation]).toEqual([0.1, 0.2, 0.3]);
        expect([m.scaleX, m.scaleY, m.scaleZ]).toEqual([2, 3, 4]);
    });
});
