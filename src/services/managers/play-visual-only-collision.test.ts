/**
 * Rise bug 2026-10-04 (docs/ui/play-mode.md "Rising forever"): in a city the Play player sometimes started rising on
 * its own, forever, until something overhead (the rail viaduct) stopped it. Cause: the city's moving contact-shadow
 * blobs (world-mover-shadows.ts) are ONE transparent radialFade mesh that also holds a blob under the player,
 * rewritten to its feet every frame — and it was collision. The ground ray stood the feet on their own blob, the blob
 * followed them up, repeat. Visual-only meshes (noCollide / radialFade, collision-filter.ts) are never collision now.
 *
 * Integration over a real Scene3DManager (stub GPU): a ground slab + a blob that follows the feet, Play with collision.
 * Ticks are counted through the ground sampler (no wall-clock assertions).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Scene3DManager } from './scene3d-manager';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { Node } from '../../scene-graph/shapes/base/node';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { CharacterController } from '../../game/character-controller';
import { isVisualOnlyMesh } from '../../game/collision-filter';
import type { InteractionService } from '../interaction-service';

const g = globalThis as { self?: unknown; crypto?: unknown; requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;
g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16);
g.cancelAnimationFrame ??= (h: ReturnType<typeof setTimeout>) => clearTimeout(h);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await wait(10);
}
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

function makeManager() {
    const perm = <T extends object>(t: T): T => new Proxy(t, { get: (o, k) => (k in o ? (o as Record<string | symbol, unknown>)[k] : () => undefined) });
    const cam = new Camera3D();
    const r3 = perm({ getCamera: () => cam });
    const wr = perm({ getRenderer3D: () => r3, getCanvas: () => null });
    const root = new Node();
    let ver = 0;
    const findNodeById = (id: string) => { let f: unknown = null; root.forEachDeep((n: Node & { id?: string }) => { if (n.id === id) f = n; }); return f; };
    const ctx = perm({
        webgpuRenderer: wr, sceneGraph: { root, findNodeById },
        sceneStructureVersion: () => ver, emitSceneGraphChanged: () => { ver++; }, scheduleRender: () => {},
        interactionService: perm({}),
    });
    return { m: new Scene3DManager(ctx as never), root, bump: () => { ver++; } };
}

/** A horizontal quad (two triangles, 12-float vertices) of half-size `h` at height `y`, centred on (cx, cz). */
function quadGeom(h: number, y: number, cx = 0, cz = 0) {
    const v = new Float32Array(4 * 12);
    const P = [[cx - h, y, cz - h], [cx + h, y, cz - h], [cx + h, y, cz + h], [cx - h, y, cz + h]];
    for (let i = 0; i < 4; i++) { v[i * 12] = P[i][0]; v[i * 12 + 1] = P[i][1]; v[i * 12 + 2] = P[i][2]; v[i * 12 + 4] = 1; }
    return { vertices: v, indices: new Uint32Array([0, 2, 1, 0, 3, 2]), format: '12float' as const };
}
/** Rewrite a quad's vertex heights in place (what the mover blobs do every frame: same arrays, new positions). */
function moveQuad(m: Mesh3D, x: number, y: number, z: number, h: number): void {
    const v = m.geometry.vertices as Float32Array;
    const P = [[x - h, z - h], [x + h, z - h], [x + h, z + h], [x - h, z + h]];
    for (let i = 0; i < 4; i++) { v[i * 12] = P[i][0]; v[i * 12 + 1] = y; v[i * 12 + 2] = P[i][1]; }
}

type Internals = { _playController: CharacterController | null; _isCollisionMesh(m: Mesh3D): boolean };

/** Ground slab at y = 0 + a blob that follows the player's feet (2 cm above them, like the mover blob's lift).
 *  `blobKind` = how the blob is flagged. Returns the feet heights over `ticks` ground samples. */
async function standStill(blobKind: 'radialFade' | 'noCollide', ticks: number): Promise<{ ys: number[]; blobIsCollision: boolean }> {
    const { m, root, bump } = makeManager();
    const ground = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: quadGeom(20, 0) });
    ground.name = 'ground'; ground.pickable = false; ground.gpuDirty = false;
    const blob = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: quadGeom(0.5, 0.02) });
    blob.name = 'world:mover-shadow'; blob.pickable = false;
    if (blobKind === 'radialFade') blob.material.radialFade = true; else blob.noCollide = true;
    blob.gpuDirty = true;   // linear scan over the LIVE vertices: the blob is always hittable where it is drawn
    root.addChild(ground); root.addChild(blob); bump();
    m.enterPlayMode3D({ keyboard: false, mouseLook: false, gamepad: false, start: [0, 0, 0] });
    const p = m as unknown as Internals;
    const cc = p._playController!;
    const ys: number[] = [];
    const sample = cc.groundSampler!;
    cc.groundSampler = (x, z) => {
        moveQuad(blob, x, cc.pos[1] + 0.02, z, 0.5);   // the blob follows the feet (world-mover-shadows update)
        const r = sample(x, z);
        ys.push(cc.pos[1]);
        return r;
    };
    await until(() => ys.length >= ticks);
    const blobIsCollision = p._isCollisionMesh(blob);
    m.exitPlayMode3D();
    return { ys, blobIsCollision };
}

describe('rise bug 2026-10-04: visual-only meshes are never Play collision', () => {
    afterEach(() => { Scene3DManager.visualOnlyNoCollide = true; CharacterController.stillRiseGuard = true; });

    it('isVisualOnlyMesh: noCollide or a radialFade material; a plain mesh is solid', () => {
        const plain = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: quadGeom(1, 0) });
        expect(plain.noCollide).toBe(false);
        expect(isVisualOnlyMesh(plain)).toBe(false);
        plain.noCollide = true;
        expect(isVisualOnlyMesh(plain)).toBe(true);
        const fade = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: quadGeom(1, 0), material: { radialFade: true } });
        expect(isVisualOnlyMesh(fade)).toBe(true);
    });

    it('a player standing still on a city street with its contact blob under it keeps its height (radialFade blob)', async () => {
        const { ys, blobIsCollision } = await standStill('radialFade', 90);
        expect(blobIsCollision).toBe(false);
        expect(ys.length).toBeGreaterThanOrEqual(90);
        for (const y of ys) expect(Math.abs(y)).toBeLessThan(1e-6);
    });

    it('same with a noCollide-flagged follower', async () => {
        const { ys, blobIsCollision } = await standStill('noCollide', 60);
        expect(blobIsCollision).toBe(false);
        for (const y of ys) expect(Math.abs(y)).toBeLessThan(1e-6);
    });

    it('A/B: with both fixes off the old feedback loop comes back (the test catches the bug)', async () => {
        Scene3DManager.visualOnlyNoCollide = false;
        CharacterController.stillRiseGuard = false;
        const { ys, blobIsCollision } = await standStill('radialFade', 90);
        expect(blobIsCollision).toBe(true);
        expect(ys[ys.length - 1]).toBeGreaterThan(0.02 * 40);   // ~2 cm a tick, forever
        // the safety net alone (blob still collision) holds it after one settle
        Scene3DManager.visualOnlyNoCollide = false;
        CharacterController.stillRiseGuard = true;
        const held = await standStill('radialFade', 90);
        expect(held.ys[held.ys.length - 1]).toBeLessThanOrEqual(0.02 + 1e-6);
    });

    it('the ground ray never accepts the player or anything parented to it', async () => {
        const { m, root, bump } = makeManager();
        const ground = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: quadGeom(20, 0) });
        ground.gpuDirty = false; ground.pickable = false;
        const body = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: quadGeom(0.3, 0.05) });
        const prop = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: quadGeom(0.4, 0.03) });   // a held / attached prop under the feet
        body.addChild(prop);
        root.addChild(ground); root.addChild(body); bump();
        m.setPlayerObject3D(body.id);
        m.enterPlayMode3D({ keyboard: false, mouseLook: false, gamepad: false });
        const p = m as unknown as Internals;
        expect(p._isCollisionMesh(body)).toBe(false);
        expect(p._isCollisionMesh(prop)).toBe(false);
        expect(p._isCollisionMesh(ground)).toBe(true);
        m.exitPlayMode3D();
    });
});
