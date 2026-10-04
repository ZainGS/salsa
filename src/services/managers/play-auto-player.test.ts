/**
 * Play settings + auto default player (polish-round-3 T5): the first-person eye height is persisted + applied to the
 * FP camera; third-person Play with no Player spawns a runtime default character that is never serialized and is
 * removed on Stop (cached for the next run).
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Scene3DManager } from './scene3d-manager';
import { Camera3D } from '../../renderer/3d/camera-3d';
import { Node } from '../../scene-graph/shapes/base/node';
import { PlaySettings } from './play-settings';
import { PlayAutoPlayer, dropRuntimeNodesFromSceneJSON, type AutoPlayerHost } from './play-auto-player';
import { DEFAULT_LOCOMOTION_CLIP_NAMES, JUMP_VARIANT_CLIPS } from './default-locomotion';
import { DocumentStateCoordinator } from '../persistence/document-state-coordinator';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';

const g = globalThis as { self?: unknown; crypto?: unknown; requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;
g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16);
g.cancelAnimationFrame ??= (h: ReturnType<typeof setTimeout>) => clearTimeout(h);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond` holds (or time out) — Play runs on a real (setTimeout-driven) game loop. */
async function until(cond: () => boolean, ms = 4000): Promise<void> {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await wait(20);
}

/** A universal no-op stand-in (callable, constructible, every property is itself) — a fake GPUDevice / canvas that
 *  lets the GPU-touching generator paths (face decal, hair, garment gradients) run in node. */
const U: any = new Proxy(function () { /* no-op */ }, {
    get: (_t, k) => (k === 'then' || k === Symbol.iterator ? undefined : k === Symbol.toPrimitive ? () => 0 : U),
    apply: () => U, construct: () => U,
});

/** A Scene3DManager over a stub context: a real scene-graph root + Camera3D, everything GPU-side a permissive no-op.
 *  `gpu` = hand the character generators a fake device, so the auto player is fully dressed (face/hair/garments). */
function makeManager(opts: { gpu?: boolean; preRender?: { cb: () => boolean | void; tag?: string }[] } = {}) {
    const perm = <T extends object>(t: T): T => new Proxy(t, { get: (o, k) => (k in o ? (o as Record<string | symbol, unknown>)[k] : () => undefined) });
    const cam = new Camera3D();
    const r3o: Record<string, unknown> = { getCamera: () => cam };   // tests may add renderer stubs (e.g. setGhostPreviewData)
    const r3 = perm(r3o);
    // `preRender` collects the pre-render callbacks (procedural idle, springs, …) + their tags so a test can run them.
    const pre = opts.preRender;
    const wr = perm({
        getRenderer3D: () => r3, getCanvas: () => null, ...(opts.gpu ? { getDevice: () => U } : {}),
        ...(pre ? { addPreRenderCallback: (cb: () => boolean | void, tag?: string) => { if (!pre.some((e) => e.cb === cb)) pre.push({ cb, tag }); } } : {}),
    });
    const root = new Node();
    let ver = 0;
    const findNodeById = (id: string) => { let f: unknown = null; root.forEachDeep((n: Node & { id?: string }) => { if (n.id === id) f = n; }); return f; };
    const ctx = perm({
        webgpuRenderer: wr, sceneGraph: { root, findNodeById },
        sceneStructureVersion: () => ver, emitSceneGraphChanged: () => { ver++; }, scheduleRender: () => {},
        interactionService: perm({}),   // the procedural idle's live-loop hold (beginInteractive / endInteractive)
    });
    return { m: new Scene3DManager(ctx as never), cam, root, r3o };
}
const PLAY = { keyboard: false, mouseLook: false, gamepad: false, collision: false } as const;
/** The DOMINANT locomotion clip of the engine animator (R6.2 state machine): idle → the idle clip, move → Walk or Run by
 *  the walk/run mix. '' when the engine isn't driving. */
function locoClip(m: Scene3DManager): string {
    const a = m.getPlayerAnimationState3D();
    if (!a) return '';
    if (a.state === 'idle') return a.weights.idle > 0.5 ? 'Breathe' : '';
    if (a.state === 'move') return a.runMix > 0.5 ? 'Run' : 'Walk';
    return a.state;
}

describe('PlaySettings (T5.1 persistence)', () => {
    it('defaults serialize to nothing (old saves stay identical) and a set height round-trips', () => {
        const s = new PlaySettings();
        expect(s.serialize()).toBeUndefined();
        s.setEyeHeight(2.2);
        s.setAutoDefaultPlayer(false);
        const saved = JSON.parse(JSON.stringify(s.serialize()));
        expect(saved).toEqual({ eyeHeight: 2.2, autoDefaultPlayer: false });
        const t = new PlaySettings();
        t.restore(saved);
        expect(t.getEyeHeight()).toBe(2.2);
        expect(t.autoDefaultPlayer).toBe(false);
        t.restore(undefined);                       // a doc without `play` resets (no inheritance from the last doc)
        expect(t.getEyeHeight()).toBeNull();
        expect(t.autoDefaultPlayer).toBe(true);
    });
    it('metres ↔ units via metresPerUnit (city scale), null / junk = automatic, clamped', () => {
        const s = new PlaySettings();
        s.setEyeHeight(1.5, 15);                    // 1.5 m in a 15 m/unit city
        expect(s.getEyeHeight()).toBeCloseTo(0.1);
        expect(s.getEyeHeight(15)).toBeCloseTo(1.5);
        s.setEyeHeight(null); expect(s.getEyeHeight()).toBeNull();
        s.setEyeHeight(-3); expect(s.getEyeHeight()).toBeNull();
        s.setEyeHeight(Number.NaN); expect(s.getEyeHeight()).toBeNull();
        s.setEyeHeight(1e9); expect(s.getEyeHeight()).toBe(10000);
        const r = new PlaySettings(); r.restore({ eyeHeight: -1 }); expect(r.getEyeHeight()).toBeNull();
    });
    it('fires onChange only on a real change', () => {
        const s = new PlaySettings(); let n = 0; s.onChange = () => n++;
        s.setEyeHeight(2); s.setEyeHeight(2); s.setAutoDefaultPlayer(true); s.setAutoDefaultPlayer(false);
        expect(n).toBe(2);
    });
});

describe('PlaySettings: jump variety + motion looseness (2026-10-03)', () => {
    it('defaults (on / 0.5) are never written; off / a looseness round-trip; a doc without them resets; clamped', () => {
        const s = new PlaySettings();
        expect(s.jumpVariety).toBe(true); expect(s.getMotionLooseness()).toBe(0.5);
        s.setJumpVariety(true); s.setMotionLooseness(0.5);
        expect(s.serialize()).toBeUndefined();
        let n = 0; s.onChange = () => n++;
        s.setJumpVariety(false); s.setMotionLooseness(0.8); s.setMotionLooseness(0.8);
        expect(n).toBe(2);
        const saved = JSON.parse(JSON.stringify(s.serialize()));
        expect(saved).toEqual({ jumpVariety: false, motionLooseness: 0.8 });
        const t = new PlaySettings(); t.restore(saved);
        expect(t.jumpVariety).toBe(false); expect(t.getMotionLooseness()).toBe(0.8);
        t.restore(undefined);
        expect(t.jumpVariety).toBe(true); expect(t.getMotionLooseness()).toBe(0.5);
        t.setMotionLooseness(7); expect(t.getMotionLooseness()).toBe(1);
        t.setMotionLooseness(-1); expect(t.getMotionLooseness()).toBe(0);
        t.setMotionLooseness(null); expect(t.getMotionLooseness()).toBe(0.5);
    });

    it('walk style (2026-10-03): natural by default and never written; stomp round-trips; junk = natural; a doc without it resets', () => {
        const s = new PlaySettings();
        expect(s.walkStyle).toBe('natural');
        s.setWalkStyle('natural'); expect(s.serialize()).toBeUndefined();
        let n = 0; s.onChange = () => n++;
        s.setWalkStyle('stomp'); s.setWalkStyle('stomp');
        expect(n).toBe(1);
        const saved = JSON.parse(JSON.stringify(s.serialize()));
        expect(saved).toEqual({ walkStyle: 'stomp' });
        const t = new PlaySettings(); t.restore(saved);
        expect(t.walkStyle).toBe('stomp');
        t.setWalkStyle('moonwalk'); expect(t.walkStyle).toBe('natural');
        t.setWalkStyle('stomp'); t.restore(undefined); expect(t.walkStyle).toBe('natural');
        expect(DEFAULT_LOCOMOTION_CLIP_NAMES).toContain('Stomp');
    });
});

describe('PlayAutoPlayer lifecycle (fake host)', () => {
    function fakeHost() {
        const root = new Set<unknown>();
        let created = 0, forgot: string[] = [];
        const mk = () => {
            const mesh = { id: `m${created}`, name: '', visible: true, parent: null as unknown, excludeFromDocument: false, frameExclude: false, pickable: true, setPosition3D() {}, setDiffuseColor() {} };
            const skeleton = { id: `s${created}`, parent: null as unknown, excludeFromDocument: false, data: { joints: [{ name: 'hips', localPosition: [0, 0.9, 0] }, { name: 'upperleg_L' }, { name: 'lowerleg_L', localPosition: [0, -0.42, 0] }, { name: 'foot_L', localPosition: [0, -0.42, 0] }], clips: [] as { name: string }[] } };
            created++;
            return { mesh, skeleton };
        };
        const host: AutoPlayerHost = {
            createBody: async () => { const b = mk(); b.mesh.parent = 'root'; b.skeleton.parent = 'root'; root.add(b.mesh); root.add(b.skeleton); return b as unknown as { mesh: Mesh3D; skeleton: Skeleton3D }; },
            markRuntimeBody: (id) => { forgot.push(id); },
            attach: (n) => { (n as { parent: unknown }).parent = 'root'; root.add(n); },
            detach: (n) => { (n as { parent: unknown }).parent = null; root.delete(n); },
        };
        return { host, root, get created() { return created; }, get forgot() { return forgot; } };
    }

    it('spawns only in third-person with no Player and the setting on', () => {
        expect(PlayAutoPlayer.shouldSpawn({ enabled: true, cameraMode: 'third', hasPlayer: false })).toBe(true);
        expect(PlayAutoPlayer.shouldSpawn({ enabled: true, cameraMode: 'third', hasPlayer: true })).toBe(false);
        expect(PlayAutoPlayer.shouldSpawn({ enabled: true, cameraMode: 'first', hasPlayer: false })).toBe(false);
        expect(PlayAutoPlayer.shouldSpawn({ enabled: false, cameraMode: 'third', hasPlayer: false })).toBe(false);
    });

    it('flags the body runtime-only, installs Walk/Run, and CACHES it across sessions (generated once)', async () => {
        const f = fakeHost(); const ap = new PlayAutoPlayer(f.host);
        const a = await ap.acquire(0, 0, 0);
        expect(a).not.toBeNull();
        expect(a!.mesh.excludeFromDocument).toBe(true);
        expect(a!.skeleton.excludeFromDocument).toBe(true);
        expect(a!.mesh.pickable).toBe(false);
        expect(f.forgot).toEqual([a!.mesh.id]);
        expect(a!.skeleton.data.clips!.map((c) => c.name)).toEqual(DEFAULT_LOCOMOTION_CLIP_NAMES);   // Round 8: + Sneak / Crouch / Jump / Fall / Land
        expect(ap.isLive).toBe(true);
        expect(ap.isRuntimeNode(a!.mesh.id) && ap.isRuntimeNode(a!.skeleton.id)).toBe(true);
        ap.release();
        expect(f.root.size).toBe(0);
        expect(ap.isLive).toBe(false);
        expect(ap.meshId).toBeNull();
        const b = await ap.acquire(1, 0, 1);
        expect(b!.mesh).toBe(a!.mesh);              // same cached body, re-attached
        expect(f.created).toBe(1);
        expect(f.root.size).toBe(2);
        expect(a!.skeleton.data.clips!.length).toBe(DEFAULT_LOCOMOTION_CLIP_NAMES.length);   // not re-installed
    });

    it('a Stop while the body is still generating leaves nothing in the scene', async () => {
        const f = fakeHost(); const ap = new PlayAutoPlayer(f.host);
        const p = ap.acquire(0, 0, 0);
        ap.release();                                 // Stop before generation finished
        expect(await p).toBeNull();
        expect(f.root.size).toBe(0);
        expect(ap.isCached).toBe(true);               // still cached for next time
    });
});

describe('Scene3DManager Play: eye height + auto default player (integration)', () => {
    it('the eye height setting drives the first-person camera and restores from a saved globalScene.play', async () => {
        const { m, cam } = makeManager();
        m.restoreGlobalScene3DSettings({ play: { eyeHeight: 2.5 } } as never);   // what a saved doc carries
        expect(m.playSettings.getEyeHeight()).toBe(2.5);
        m.enterPlayMode3D({ ...PLAY, start: [0, 0, 0] });
        await until(() => Math.abs(cam.position[1] - 2.5) < 1e-4);
        expect(cam.position[1]).toBeCloseTo(2.5, 4);   // feet at y=0 + 2.5
        // Live change while playing.
        m.playSettings.setEyeHeight(1.1);
        await until(() => Math.abs(cam.position[1] - 1.1) < 1e-4);
        expect(cam.position[1]).toBeCloseTo(1.1, 4);
        // A host config override still wins over the setting.
        m.exitPlayMode3D();
        m.enterPlayMode3D({ ...PLAY, start: [0, 0, 0], config: { eyeHeight: 0.5 } });
        await until(() => Math.abs(cam.position[1] - 0.5) < 1e-4);
        expect(cam.position[1]).toBeCloseTo(0.5, 4);
        m.exitPlayMode3D();
        // Absent from a save → automatic (the original 1.6). A real load resets first (clearForDocumentLoad3D); a
        // PARTIAL restore ({} / the city tool's lighting hand-back) must NOT touch it (bug-hunt 2026-10-01).
        m.restoreGlobalScene3DSettings({} as never);
        expect(m.playSettings.getEyeHeight()).toBe(1.1);
        m.clearForDocumentLoad3D();
        m.restoreGlobalScene3DSettings({} as never);
        expect(m.playSettings.getEyeHeight()).toBeNull();
        m.enterPlayMode3D({ ...PLAY, start: [0, 0, 0] });
        await until(() => Math.abs(cam.position[1] - 1.6) < 1e-4);
        expect(cam.position[1]).toBeCloseTo(1.6, 4);
        m.exitPlayMode3D();
    });

    it('bug-hunt 2026-10-01: partial restores keep document content; a load resets it and STOPS Play; destroy restores prior visibility', async () => {
        const { m } = makeManager();
        m.setScriptBehavior3D('n1', 'export function onTick() {}');
        m.restoreGlobalScene3DSettings({ play: { eyeHeight: 2 }, player: { meshId: 'hero', locomotionSet: null } } as never);
        expect(m.playerObjectId3D).toBe('hero');
        // The city tool's exit restores only lighting-ish keys — scripts / play / player must survive it.
        m.restoreGlobalScene3DSettings({ fog: undefined, shadowTint: null } as never);
        expect(m.getScriptBehavior3D('n1')).not.toBeNull();
        expect(m.playSettings.getEyeHeight()).toBe(2);
        expect(m.playerObjectId3D).toBe('hero');
        // Play with a Player that does not exist yet (still restoring) must not wipe the persisted binding.
        m.enterPlayMode3D({ ...PLAY, start: [0, 0, 0] });
        expect(m.playerObjectId3D).toBe('hero');
        // A document load while playing stops Play and forgets the previous doc's content.
        m.clearForDocumentLoad3D();
        expect(m.isPlaying3D).toBe(false);
        expect(m.getScriptBehavior3D('n1')).toBeNull();
        expect(m.playSettings.getEyeHeight()).toBeNull();
        expect(m.playerObjectId3D).toBeNull();
    });

    // bug-hunt 2026-10-01 (Play): editor camera calls during Play used to apply at once — the orbit controller and the
    // Play loop then fought over the camera. A camera-mode / target switch is now DEFERRED to Stop; an editor orbit
    // mode (city / mesh orbit) stops Play first.
    it('bug-hunt 2026-10-01: editor camera calls during Play are deferred (mode/target) or stop Play (orbit modes)', async () => {
        const { m, cam } = makeManager();
        m.enterPlayMode3D({ ...PLAY, start: [0, 0, 0] });
        await until(() => Math.abs(cam.position[1] - 1.6) < 1e-4);
        const playPos = [...cam.position];
        let changes = 0;
        m.onViewStateChanged.subscribe(() => changes++);
        m.setCameraMode3D('free3D');
        m.setTarget3D('scene');
        expect(m.isPlaying3D).toBe(true);
        expect(m.getViewState3D()).toMatchObject({ cameraMode: 'free3D', target: 'scene' });   // recorded for the host UI
        expect(changes).toBe(2);
        expect([...cam.position]).toEqual(playPos);   // ...but the Play camera was not touched
        m.exitPlayMode3D();
        expect(m.getViewState3D()).toMatchObject({ cameraMode: 'free3D', target: 'scene' });   // Stop lands in the requested mode
        m.enterPlayMode3D({ ...PLAY, start: [0, 0, 0] });
        try { m.enterCityMode3D([0, 0, 0]); } catch { /* the stub renderer lacks the focus-bg API — Play stops before that */ }
        expect(m.isPlaying3D).toBe(false);
    });

    // bug-hunt 2026-10-01 (Play perf): Stop rebuilt EVERY mesh's matrix (3 setters each) → a visible hitch in a big city.
    it('bug-hunt 2026-10-01: Stop restores only the meshes Play actually moved', () => {
        const { m } = makeManager();
        const mk = (id: string) => {
            const o = { id, x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotation: 0, scaleX: 1, scaleY: 1, scaleZ: 1, calls: 0,
                setRotation3D(a: number, b: number, c: number) { o.calls++; o.rotationX = a; o.rotationY = b; o.rotation = c; },
                setScale3D(a: number, b: number, c: number) { o.calls++; o.scaleX = a; o.scaleY = b; o.scaleZ = c; },
                setPosition3D(a: number, b: number, c: number) { o.calls++; o.x = a; o.y = b; o.z = c; } };
            return o;
        };
        const meshes = Array.from({ length: 1000 }, (_, i) => mk('m' + i));
        const p = m as unknown as { getAllMeshes(): unknown[]; _snapshotTransforms(): unknown; _restoreTransforms(s: unknown): void };
        p.getAllMeshes = () => meshes;
        const snap = p._snapshotTransforms();
        meshes[7].x = 5; meshes[7].rotationY = 1;   // the walked player
        p._restoreTransforms(snap);
        expect(meshes[7].x).toBe(0);
        expect(meshes[7].rotationY).toBe(0);
        expect(meshes.reduce((n, o) => n + o.calls, 0)).toBe(3);   // only the moved one rebuilt
    });

    it('third-person with no Player spawns an animated default character: not serialized, hidden from the outliner, removed on Stop', async () => {
        const { m } = makeManager();
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive);
        const id = m.autoPlayer.meshId!;
        expect(id).toBeTruthy();
        const mesh = m.getMesh(id)!;
        expect(mesh.excludeFromDocument).toBe(true);
        expect(m.getAllSkeletons().every((s) => s.excludeFromDocument)).toBe(true);
        expect(m.serializeBodyParams().some((b) => b.bodyMeshId === id)).toBe(false);
        expect(m.getScene3DHierarchy().some((n) => n.id === id)).toBe(false);
        expect(m.playerObjectId3D).toBeNull();                          // the persisted binding is untouched
        expect(m.getPlayerLocomotionSet3D()).toBeNull();
        // Idle → walks (Round 8: full input WALKS by default) → Shift → Run.
        await until(() => locoClip(m) === 'Breathe');
        expect(locoClip(m)).toBe('Breathe');
        m.setPlayInput3D({ forward: 0.4 });                             // partial (analog) input → a slow walk
        await until(() => locoClip(m) === 'Walk');
        expect(locoClip(m)).toBe('Walk');
        m.setPlayInput3D({ forward: 1 });
        await wait(300);
        expect(locoClip(m)).toBe('Walk');                               // full input: still the walk gait
        m.setPlayerRunning3D(true);
        await until(() => locoClip(m) === 'Run');
        expect(locoClip(m)).toBe('Run');
        m.setPlayerRunning3D(false);
        m.exitPlayMode3D();
        expect(m.autoPlayer.isLive).toBe(false);
        expect(m.getMesh(id)).toBeNull();
        expect(m.getAllSkeletons().length).toBe(0);
        // Next run re-uses the cached body (same id), instantly.
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive);
        expect(m.autoPlayer.meshId).toBe(id);
        m.exitPlayMode3D();
    });

    it('no auto player in first-person, with a user Player set, or with the opt-out flag', async () => {
        const { m } = makeManager();
        m.enterPlayMode3D({ ...PLAY });                                  // first-person
        await wait(300);
        expect(m.autoPlayer.isLive).toBe(false);
        m.exitPlayMode3D();
        m.playSettings.setAutoDefaultPlayer(false);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await wait(300);
        expect(m.autoPlayer.isLive).toBe(false);
        expect(m.autoPlayer.isCached).toBe(false);                       // never even generated
        m.exitPlayMode3D();
        expect(m.playSettings.serialize()).toEqual({ autoDefaultPlayer: false });
        // A user Player (any mesh) → theirs is used, no auto body.
        m.playSettings.setAutoDefaultPlayer(true);
        const box = (m as unknown as { createMesh(x: number, y: number, z: number, c: unknown): { id: string } }).createMesh(0, 0, 0, { primitive: 'cube' });
        expect(m.getMesh(box.id)).not.toBeNull();
        m.setPlayerObject3D(box.id);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await wait(300);
        expect(m.autoPlayer.isLive).toBe(false);
        expect((m as unknown as { _playerMesh: { id: string } | null })._playerMesh?.id).toBe(box.id);
        m.exitPlayMode3D();
    });
});

describe('Round 4: move speed setting (PlaySettings)', () => {
    it('m/s, default (5.2 run since Round 8) never written, clamped, round-trips, resets on a doc without it', () => {
        const s = new PlaySettings();
        expect(s.getMoveSpeed()).toBe(5.2);
        expect(s.moveSpeedIsDefault).toBe(true);
        s.setMoveSpeed(6);
        expect(s.getMoveSpeed()).toBe(6);
        expect(JSON.parse(JSON.stringify(s.serialize()))).toEqual({ moveSpeed: 6 });
        s.setMoveSpeed(5.2);                                  // dragged back to the default → nothing stored
        expect(s.serialize()).toBeUndefined();
        s.setMoveSpeed(0); expect(s.moveSpeedIsDefault).toBe(true);
        s.setMoveSpeed(Number.NaN); expect(s.moveSpeedIsDefault).toBe(true);
        s.setMoveSpeed(1e9); expect(s.getMoveSpeed()).toBe(100);
        s.setMoveSpeed(0.001); expect(s.getMoveSpeed()).toBe(0.1);
        const t = new PlaySettings();
        t.restore({ moveSpeed: 2 }); expect(t.getMoveSpeed()).toBe(2);
        t.restore({ moveSpeed: -1 }); expect(t.getMoveSpeed()).toBe(5.2);
        t.restore({ moveSpeed: 2 }); t.restore(undefined); expect(t.moveSpeedIsDefault).toBe(true);
        // An OLD save's moveSpeed keeps meaning the full-input run speed (loads unchanged); walk has its own default.
        t.restore({ moveSpeed: 3.5 }); expect(t.getMoveSpeed()).toBe(3.5); expect(t.getWalkSpeed()).toBe(1.6);
        expect(t.serialize()).toEqual({ moveSpeed: 3.5 });
    });

    it('Round 8 walk speed: m/s, default 1.6 never written, never above the run speed, round-trips', () => {
        const s = new PlaySettings();
        expect(s.getWalkSpeed()).toBe(1.6);
        s.setWalkSpeed(2); expect(s.getWalkSpeed()).toBe(2);
        expect(s.serialize()).toEqual({ walkSpeed: 2 });
        s.setMoveSpeed(1.5); expect(s.getWalkSpeed()).toBe(1.5);   // clamped to the run speed at use
        s.setWalkSpeed(1.6); s.setMoveSpeed(null); expect(s.serialize()).toBeUndefined();
        const t = new PlaySettings();
        t.restore({ walkSpeed: 1.2 }); expect(t.getWalkSpeed()).toBe(1.2);
        t.restore({}); expect(t.getWalkSpeed()).toBe(1.6);
    });
});

describe('Round 4: PlayAutoPlayer parts + height scaling (fake host)', () => {
    it('attaches/detaches EVERY part, flags them runtime-only, and scales the body to a target height', async () => {
        const root = new Set<unknown>();
        const mkMesh = (id: string) => ({
            id, name: '', visible: true, parent: null as unknown, excludeFromDocument: false, frameExclude: false, pickable: true,
            scaleX: 1, scaleY: 1, scaleZ: 1, obbCorners: null as [number, number, number][] | null,
            setPosition3D() { /* */ }, setScale3D(x: number, y: number, z: number) { this.scaleX = x; this.scaleY = y; this.scaleZ = z; },
        });
        const body = mkMesh('body');
        body.obbCorners = [[0, 0, 0], [0, 1.6, 0]];            // generated 1.6 units tall
        const hair = mkMesh('hair'), top = mkMesh('top');
        const skeleton = { id: 'skel', parent: null as unknown, excludeFromDocument: false, data: { joints: [], clips: [] as { name: string }[] } };
        const marked: string[] = [];
        const ap = new PlayAutoPlayer({
            createBody: async () => {
                for (const n of [body, skeleton, hair, top]) { n.parent = 'root'; root.add(n); }
                return { mesh: body, skeleton, parts: [hair, top] } as never;
            },
            markRuntimeBody: (id) => { marked.push(id); },
            attach: (n) => { (n as { parent: unknown }).parent = 'root'; root.add(n); },
            detach: (n) => { (n as { parent: unknown }).parent = null; root.delete(n); },
        });
        await ap.acquire(0, 0, 0, { height: 0.1 });            // e.g. 1.5 m in a 15 m/unit city
        expect(marked).toEqual(['body']);
        for (const m of [body, hair, top]) { expect(m.excludeFromDocument).toBe(true); expect(m.pickable).toBe(false); expect(m.frameExclude).toBe(true); }
        expect(skeleton.excludeFromDocument).toBe(true);
        expect(ap.runtimeNodeIds().sort()).toEqual(['body', 'hair', 'skel', 'top']);
        expect(ap.isRuntimeNode('hair') && ap.isRuntimeNode('top')).toBe(true);
        expect(body.scaleY).toBeCloseTo(0.1 / 1.6, 6);
        ap.release();
        expect(root.size).toBe(0);                              // the parts left with the body
        await ap.acquire(0, 0, 0);                              // no height (not a city) → generated size again
        expect(root.size).toBe(4);
        expect(body.scaleY).toBe(1);
        expect(ap.scaleForHeight(3.2)).toBeCloseTo(2, 6);
        ap.release();
    });
});

describe('Round 4: Play is scale-correct in a city (metres-per-unit provider)', () => {
    it('eye height, move speed, jump, camera follow all convert; live move-speed change applies', async () => {
        const { m, cam } = makeManager();
        const MPU = 15;
        m.setPlayMetresPerUnitProvider(() => MPU);
        expect(m.getPlayMetresPerUnit3D()).toBe(MPU);
        expect(m.getDefaultPlayerEyeHeight3D()).toBeCloseTo(1.6 / MPU, 6);
        m.enterPlayMode3D({ ...PLAY, start: [0, 0, 0] });
        await until(() => Math.abs(cam.position[1] - 1.6 / MPU) < 1e-5);
        expect(cam.position[1]).toBeCloseTo(1.6 / MPU, 5);     // 1.6 m, not 24 m
        const cc = (m as unknown as { _playController: { cfg: Record<string, number> } })._playController;
        expect(cc.cfg.moveSpeed).toBeCloseTo(5.2 / MPU, 6);          // Round 8: the RUN speed
        expect(cc.cfg.walkSpeed).toBeCloseTo(1.6 / MPU, 6);
        expect(cc.cfg.sneakSpeed).toBeCloseTo(1.0 / MPU, 6);
        expect(cc.cfg.jumpSpeed).toBeCloseTo(6.5 / MPU, 6);
        expect(cc.cfg.gravity).toBeCloseTo(20 / MPU, 6);
        expect(cc.cfg.groundAccel).toBeCloseTo(20 / MPU, 6);
        expect(cc.cfg.maxFallSpeed).toBeCloseTo(30 / MPU, 6);
        expect(cc.cfg.thirdPersonDistance).toBeCloseTo(3.0 / MPU, 6);   // visual-polish 7a default 3 m (R6.2: 4.5 m)
        expect(cc.cfg.cameraMinDistance).toBeCloseTo(0.5 / MPU, 6);
        expect(cc.cfg.stepHeight).toBeCloseTo(0.4 / MPU, 6);
        // Live move-speed change (m/s) → units/s at the city scale.
        m.playSettings.setMoveSpeed(7);
        expect(cc.cfg.moveSpeed).toBeCloseTo(7 / MPU, 6);
        m.exitPlayMode3D();
        // No city → today's numbers.
        m.setPlayMetresPerUnitProvider(() => null);
        m.playSettings.setMoveSpeed(null);
        m.enterPlayMode3D({ ...PLAY, start: [0, 0, 0] });
        const cc2 = (m as unknown as { _playController: { cfg: Record<string, number> } })._playController;
        expect(cc2.cfg.moveSpeed).toBe(5.2);
        expect(cc2.cfg.eyeHeight).toBe(1.6);
        m.exitPlayMode3D();
    });

    it('the auto player in a city walks by default and runs after the toggle (blend points follow city scale + speeds)', async () => {
        const { m } = makeManager();
        m.setPlayMetresPerUnitProvider(() => 15);
        m.playSettings.setMoveSpeed(3); m.playSettings.setWalkSpeed(1.2);   // custom gait speeds (m/s)
        const clip = () => locoClip(m);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive);
        await until(() => clip() === 'Breathe');
        m.setPlayInput3D({ forward: 1 });
        await until(() => clip() === 'Walk');
        expect(clip()).toBe('Walk');
        const cc = (m as unknown as { _playController: { lastPlanarSpeed: number } })._playController;
        await wait(400);
        expect(cc.lastPlanarSpeed * 15).toBeCloseTo(1.2, 1);          // 1.2 m/s in city units
        m.setPlayerRunning3D(true);
        await until(() => clip() === 'Run');
        expect(clip()).toBe('Run');
        await wait(400);
        expect(cc.lastPlanarSpeed * 15).toBeCloseTo(3, 1);
        m.setPlayerRunning3D(false);
        m.exitPlayMode3D();
    });
});

describe('Round 4: the DRESSED auto player is never serialized', () => {
    it('body + face + hair + garments spawn runtime-only; no save path carries any of it; a real character still saves', async () => {
        const g2 = globalThis as Record<string, unknown>;
        for (const k of ['GPUTextureUsage', 'GPUBufferUsage', 'OffscreenCanvas', 'document', 'createImageBitmap', 'ImageData']) g2[k] ??= U;
        const { m, root } = makeManager({ gpu: true });
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive, 20000);
        const id = m.autoPlayer.meshId!;
        const ids = m.autoPlayer.runtimeNodeIds();
        // Dressed: face decal, hair, the four garments of the seeded random character.
        const overlay = [m.getEyesMeshId(id), m.getHairMeshId(id), ...(['top', 'bottom', 'shoes', 'socks'] as const).map((s) => m.getClothingMeshId(id, s))];
        for (const o of overlay) { expect(o).toBeTruthy(); expect(ids).toContain(o); expect(m.getMesh(o!)!.excludeFromDocument).toBe(true); }
        // Every save block is empty of it.
        expect(m.serializeFaceRigs()).toEqual([]);
        expect(m.getFaceTextureExports()).toEqual([]);
        expect(m.serializeHairRigs()).toEqual([]);
        expect(m.serializeClothingRigs()).toEqual([]);
        expect(m.serializeBodyParams()).toEqual([]);
        expect(m.serializeAttachments()).toEqual([]);
        expect(m.getScene3DCharacterStates()).toEqual([]);
        // The node/skeleton filters both save paths use (document-state-coordinator + getScene3DNodeStates).
        expect(m.getAllMeshes().filter((x) => !x.isFaceDecal && !x.isHair && !x.isClothing && !x.isAttachment && !x.excludeFromDocument)).toEqual([]);
        expect(m.getAllSkeletons().filter((s) => !s.excludeFromDocument)).toEqual([]);
        expect(m.playerObjectId3D).toBeNull();                          // globalScene.player binding untouched
        expect(m.getScene3DHierarchy().some((n) => ids.includes(n.id))).toBe(false);
        // A FULL document gather mid-Play (the OPFS autosave / .frogmarks payload) carries none of it.
        const stubP = <T extends object>(o: Record<string, unknown>): T => new Proxy(o, { get: (t, k) => (k in t ? t[k as string] : k === 'then' ? undefined : () => undefined) }) as T;
        (m as unknown as { getGlobalScene3DSettings: () => unknown }).getGlobalScene3DSettings = () => ({});   // renderer-backed; not under test
        const sm = stubP({ scene3d: m, ui: { listUILayers: () => [] }, getSceneGraphJSONForDocument: () => '{}', exportAllBrushPresets: () => '[]' });
        const priv = stubP({
            getWebgpuRenderer: () => stubP({}), getDocIdentity: () => ({ id: 'd', name: 'n' }), getRasterLayerManager: () => undefined,
            buildMeshState: (x: { toJSON(): unknown }) => x.toJSON(), uvPaintTextures: new Map(), garp: { hasContent: () => false },
            packagingIfCreated: () => null, ephemera: null,
        });
        const payload = await new DocumentStateCoordinator(sm as never, priv as never).gather(true);
        for (const nid of ids) expect(payload.scene3dJSON).not.toContain(nid);
        expect(Object.keys(payload.meshTextures ?? {}).some((k) => ids.some((nid) => k.includes(nid)))).toBe(false);
        const parsed = JSON.parse(payload.scene3dJSON!);
        for (const k of ['nodes', 'skeletons', 'faceRigs', 'clothingRigs', 'hairRigs', 'bodyParams', 'attachments', 'characters']) expect(parsed[k]).toEqual([]);
        // The 2D scene-graph document JSON (ShapeManager.getSceneGraphJSONForDocument) drops them by id.
        const sg = JSON.parse(JSON.stringify(root.toJSON()));
        expect(JSON.stringify(sg)).toContain(id);                          // live in the graph while playing...
        expect(dropRuntimeNodesFromSceneJSON(sg, new Set(ids))).toBe(ids.length);
        for (const nid of ids) expect(JSON.stringify(sg)).not.toContain(nid);   // ...but never in the document
        m.exitPlayMode3D();
        for (const nid of ids) expect(m.getMesh(nid)).toBeNull();
        // A document load keeps the CACHED character's rigs (it outlives documents), and they still never serialize.
        m.clearForDocumentLoad3D();
        expect(m.getHairMeshId(id)).toBeTruthy();
        expect(m.serializeHairRigs()).toEqual([]);
        // A user's own character in the same scene still saves normally (the filter is per-body, not global).
        const real = await m.createProceduralBody3D(undefined, 3, 0, 0);
        m.setHairParams(real.meshId, m.getDefaultHairParams());
        expect(m.serializeBodyParams().map((b) => b.bodyMeshId)).toEqual([real.meshId]);
        expect(m.serializeHairRigs().map((h) => h.bodyMeshId)).toEqual([real.meshId]);
        expect(m.getScene3DHierarchy().some((n) => n.id === real.meshId)).toBe(true);
        // Next Play re-uses the cached dressed character (same ids).
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive);
        expect(m.autoPlayer.meshId).toBe(id);
        expect(m.getMesh(m.getHairMeshId(id)!)).not.toBeNull();
        m.exitPlayMode3D();
    }, 30000);
});

describe('R6.2: third-person game feel (integration)', () => {
    type Internals = { _playController: { yaw: number; facing: number; running: boolean; lastPlanarSpeed: number; cfg: Record<string, number> } };
    const internals = (m: Scene3DManager) => m as unknown as Internals;
    const legRot = (m: Scene3DManager, skelId: string) => {
        const s = m.getSkeleton(skelId)!;
        const j = s.data.joints.find((k) => k.name === 'upperleg_L')!;
        return [...j.localRotation];
    };
    const qDist = (a: number[], b: number[]) => 1 - Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);

    it('stop → idle: the legs blend back to rest (no frozen last stride); Stop restores the pre-play pose', async () => {
        const { m } = makeManager();
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive);
        const skelId = m.getAllSkeletons()[0].id;
        const rest = legRot(m, skelId);
        m.setPlayInput3D({ forward: 1 });
        await until(() => locoClip(m) === 'Walk');
        await wait(150);
        const stride = legRot(m, skelId);
        expect(qDist(stride, rest)).toBeGreaterThan(1e-4);          // mid-gait the thigh is swung
        m.setPlayInput3D({ forward: 0 });
        // A crossfade, not a snap: shortly after release the walk/run still has weight.
        await wait(60);
        const a = m.getPlayerAnimationState3D()!;
        expect(a.weights.move).toBeGreaterThan(0.05);
        await until(() => (m.getPlayerAnimationState3D()?.weights.idle ?? 0) > 0.999, 3000);
        expect(m.getPlayerAnimationState3D()!.state).toBe('idle');
        expect(qDist(legRot(m, skelId), rest)).toBeLessThan(1e-3);   // item 13: the Stand idle only shifts the weight a few degrees
        m.setPlayInput3D({ forward: 1 });
        await wait(200);
        const skel = m.getSkeleton(skelId)!;                          // (removed from the scene on Stop, cached)
        const legIdx = skel.data.joints.findIndex((k) => k.name === 'upperleg_L');
        // The pose the engine captured when it took the rig (item 13: the Stand idle moves the legs, so `rest` above —
        // read on a Play tick — is no longer the pre-play pose).
        const prePlay = [...(m as unknown as { _locoRest: { pose: { rotations: number[][] } } })._locoRest.pose.rotations[legIdx]];
        m.exitPlayMode3D();
        const leg = skel.data.joints[legIdx];
        expect(qDist([...leg.localRotation], prePlay)).toBeLessThan(1e-6);   // Stop puts the rig back
    });

    it('mouse orbits the camera only; moving turns the body toward the camera-relative direction', async () => {
        const { m } = makeManager();
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive);
        const mesh = m.getMesh(m.autoPlayer.meshId!)!;
        const cc = internals(m)._playController;
        const face0 = mesh.rotationY;
        for (let i = 0; i < 10; i++) { m.setPlayInput3D({ lookYaw: 0.15 }); await wait(20); }
        expect(Math.abs(cc.yaw - face0)).toBeGreaterThan(0.5);      // the camera swung round
        expect(mesh.rotationY).toBeCloseTo(face0, 6);               // the character stayed put
        m.setPlayInput3D({ forward: -1 });                          // S: run TOWARD the camera
        await wait(600);
        const toward = cc.yaw + Math.PI;
        const d = Math.atan2(Math.sin(mesh.rotationY - toward), Math.cos(mesh.rotationY - toward));
        expect(Math.abs(d)).toBeLessThan(0.1);
        m.exitPlayMode3D();
    });

    it('walk/run toggle: state getter + event; walking is slower; the third-person FOV is the default (50° since visual-polish 7a; was 72°) and restored on Stop', async () => {
        const { m, cam } = makeManager();
        const fov0 = cam.fov;
        const seen: boolean[] = [];
        const sub = m.onPlayerRunChanged.subscribe((v) => seen.push(v));
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        expect(cam.fov * 180 / Math.PI).toBeCloseTo(50, 6);
        expect(m.getPlayerRunning3D()).toBe(false);                  // Round 8: Play starts WALKING
        m.setPlayInput3D({ forward: 1 });
        await wait(600);
        const cc = internals(m)._playController;
        expect(cc.lastPlanarSpeed).toBeCloseTo(1.6, 1);
        m.setPlayerRunning3D(true);                                  // Shift → a true run
        expect(seen).toEqual([true]);
        await wait(600);
        expect(cc.lastPlanarSpeed).toBeCloseTo(5.2, 1);
        m.exitPlayMode3D();
        expect(cam.fov).toBeCloseTo(fov0, 9);
        expect(m.getPlayerRunning3D()).toBe(true);                  // carried to the next run
        m.setPlayerRunning3D(false);
        sub.unsubscribe?.();
        // Settings: FOV + camera distance persist only when non-default and apply to the next run.
        m.playSettings.setFov(80); m.playSettings.setCameraDistance(6);
        expect(m.playSettings.serialize()).toEqual({ fovDeg: 80, cameraDistance: 6 });
        m.enterPlayMode3D({ ...PLAY, start: [0, 0, 0], config: { cameraMode: 'third' } });
        expect(cam.fov * 180 / Math.PI).toBeCloseTo(80, 6);
        expect(internals(m)._playController.cfg.thirdPersonDistance).toBeGreaterThan(0);
        m.exitPlayMode3D();
    });

    it('a user Player (procedural character) gets the default gait at runtime — nothing is added to its saved clips', async () => {
        const { m } = makeManager();
        const r = await m.createProceduralBody3D({} as never, 0, 0, 0);
        const before = m.getSkeletonClips3D(r.skeletonId).map((c) => c.name);
        m.setPlayerObject3D(r.meshId);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await wait(100);
        expect(m.getPlayerAnimationState3D()).not.toBeNull();
        m.setPlayInput3D({ forward: 1 });
        m.setPlayerRunning3D(true);
        await until(() => locoClip(m) === 'Run');
        expect(locoClip(m)).toBe('Run');
        m.setPlayerRunning3D(false);
        expect(m.getSkeletonClips3D(r.skeletonId).map((c) => c.name)).toEqual(before);   // runtime clips only
        m.exitPlayMode3D();
        expect(m.getPlayerAnimationState3D()).toBeNull();
    });
});

describe('Round 8: gaits, sneak, jump + landing on the auto player (engine animator)', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const until = async (f: () => boolean, ms = 4000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await wait(10); };
    it('sneak: event + gait; the crouch mix eases in; the walk becomes the sneak; a jump plays the air pose and lands with an additive squash', async () => {
        const { m } = makeManager();
        const seen: boolean[] = [];
        const sub = m.onPlayerSneakChanged.subscribe((v) => seen.push(v));
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive);
        expect(m.getPlayerGait3D()).toBe('walk');
        m.setPlayerSneaking3D(true);
        expect(seen).toEqual([true]);
        expect(m.getPlayerSneaking3D()).toBe(true);
        expect(m.getPlayerGait3D()).toBe('sneak');
        await until(() => (m.getPlayerAnimationState3D()?.crouchMix ?? 0) > 0.99);
        expect(m.getPlayerAnimationState3D()!.crouchMix).toBeGreaterThan(0.99);
        m.setPlayInput3D({ forward: 1 });
        await wait(500);
        const cc = (m as unknown as { _playController: { lastPlanarSpeed: number } })._playController;
        expect(cc.lastPlanarSpeed).toBeCloseTo(1.0, 1);                 // sneak speed
        expect(m.getPlayerAnimationState3D()!.state).toBe('move');
        m.setPlayerSneaking3D(false);
        expect(seen).toEqual([true, false]);
        // Jump from the walk: the air state, then a landing squash on touch-down, then back to the gait.
        m.setPlayInput3D({ jump: true });
        await until(() => m.getPlayerAnimationState3D()?.state === 'jump', 1000);
        expect(m.getPlayerAnimationState3D()!.state).toBe('jump');
        let landed = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < 1500) { landed = Math.max(landed, m.getPlayerAnimationState3D()?.landWeight ?? 0); if (landed > 0 && m.getPlayerAnimationState3D()?.state === 'move') break; await wait(5); }
        expect(landed).toBeGreaterThan(0.3);
        m.setPlayInput3D({ jump: false });
        m.exitPlayMode3D();
        expect(m.getPlayerSneaking3D()).toBe(false);
        sub.unsubscribe?.();
    }, 10_000);
});

describe('2026-10-01: generated characters fit the city; a user Player never frames from inside itself', () => {
    const gpuGlobals = () => { const g2 = globalThis as Record<string, unknown>; for (const k of ['GPUTextureUsage', 'GPUBufferUsage', 'OffscreenCanvas', 'document', 'createImageBitmap', 'ImageData']) g2[k] ??= U; };
    const heightOf = (m: Scene3DManager, id: string) => {
        const c = m.getMesh(id)!.obbCorners!;
        let lo = Infinity, hi = -Infinity;
        for (const p of c) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
        return hi - lo;
    };
    /** A 40 x 40 floor slab whose top is at y = 0 (the city ground stand-in). */
    const addFloor = async (m: Scene3DManager) => {
        const { generateBox } = await import('../../renderer/3d/mesh-generators');
        const geometry = generateBox(40, 0.2, 40);
        const stride = geometry.vertices.length / 24;
        for (let i = 1; i < geometry.vertices.length; i += stride) geometry.vertices[i] -= 0.1;
        return m.addFlatColorMeshGroup('floor', [{ name: 'floor', geometry, color: [0.5, 0.5, 0.5] }]);
    };

    it('in a city a NEW character is 1.7 m tall (body, skeleton and every part), outside a city unchanged; regenerating a part keeps it', async () => {
        gpuGlobals();
        const { m } = makeManager({ gpu: true });
        const plain = await m.createProceduralBody3D(undefined, 0, 0, 0);
        expect(m.getMesh(plain.meshId)!.scaleX).toBe(1);                         // no city: the generated size
        expect(heightOf(m, plain.meshId)).toBeGreaterThan(1);
        m.setPlayMetresPerUnitProvider(() => 15);
        for (const height of [0.5, 1]) {                                           // the Frogmarks dollcore default and the generator default
            const top = m.getDefaultClothingParams('top');
            const r = await m.createProceduralCharacter3D({ body: { height }, garments: [top], hair: m.getDefaultHairParams() }, 2, 0, 0);
            m.ensureFace3D?.(r.meshId);
            m.setClothingParams(r.meshId, top);
            m.setHairParams(r.meshId, m.getDefaultHairParams());
            m.clearPrimedCharacterParts3D(r.meshId);
            expect(heightOf(m, r.meshId) * 15).toBeCloseTo(1.7, 3);
            // The skeleton follows (the head joint is at human height, in metres), so every skinned part does too.
            const skel = m.getSkeleton(r.skeletonId)!;
            const head = skel.data.joints.find((j) => j.name === 'head')!;
            expect(head.worldMatrix[13] * 15).toBeGreaterThan(1.1);
            expect(head.worldMatrix[13] * 15).toBeLessThan(1.7);
            const parts = [m.getHairMeshId(r.meshId), m.getClothingMeshId(r.meshId, 'top'), m.getEyesMeshId(r.meshId)].filter(Boolean) as string[];
            expect(parts.length).toBeGreaterThanOrEqual(2);
            for (const id of parts) expect((m.getMesh(id) as Mesh3D & { skeletonId?: string }).skeletonId).toBe(r.skeletonId);
            // Regenerating a part (a hair slider) keeps the character's scale; the new hair rides the same skeleton.
            const s0 = m.getMesh(r.meshId)!.scaleX;
            m.setHairParams(r.meshId, { ...m.getDefaultHairParams(), length: 0.8 } as never);
            expect(m.getMesh(r.meshId)!.scaleX).toBe(s0);
            expect((m.getMesh(m.getHairMeshId(r.meshId)!) as Mesh3D & { skeletonId?: string }).skeletonId).toBe(r.skeletonId);
        }
        // The auto player is NOT pre-scaled by creation (it scales per acquire; its cache outlives the city).
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive, 20000);
        expect(heightOf(m, m.autoPlayer.meshId!) * 15).toBeCloseTo(1.7, 3);
        m.exitPlayMode3D();
        m.setPlayMetresPerUnitProvider(() => null);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await until(() => m.autoPlayer.isLive);
        expect(heightOf(m, m.autoPlayer.meshId!)).toBeGreaterThan(1);               // generated size again outside a city
        m.exitPlayMode3D();
    }, 40000);

    it('city spawn: a default position becomes the floor the camera looks at; an explicit one is honoured; no city = unchanged', async () => {
        const { m, cam } = makeManager();
        await addFloor(m);
        cam.lookAt(3, 2, -6, 3, 0, 1);
        expect(m.resolveCharacterSpawn3D(undefined)).toEqual([0, 0, 0]);          // no city
        m.setPlayMetresPerUnitProvider(() => 15);
        const s = m.resolveCharacterSpawn3D(undefined);
        expect(s[1]).toBeCloseTo(0, 4);                                             // ON the floor
        expect(Math.hypot(s[0] - 3, s[2] - 1)).toBeLessThan(0.5);                   // where the camera looks
        expect(m.resolveCharacterSpawn3D([0, 0, 0])).toEqual(s);                    // the origin default too
        expect(m.resolveCharacterSpawn3D([5, 0.3, 5])).toEqual([5, 0.3, 5]);        // explicit: honoured
        cam.lookAt(3, 2, -6, 3, 2.5, 1);                                            // looking up into the sky: ground under the target
        const up = m.resolveCharacterSpawn3D(undefined);
        expect(up[1]).toBeCloseTo(0, 4);
        expect(up[0]).toBeCloseTo(3, 4);
        // Looking straight at a facade (a street-level view): stand on the floor just in front of it, not on its roof.
        const { generateBox } = await import('../../renderer/3d/mesh-generators');
        const wall = generateBox(10, 4, 0.2);
        const stride = wall.vertices.length / 24;
        for (let i = 0; i < wall.vertices.length; i += stride) { wall.vertices[i + 1] += 2; wall.vertices[i + 2] += 3; }
        m.addFlatColorMeshGroup('facade', [{ name: 'facade', geometry: wall, color: [0.6, 0.6, 0.6] }]);
        cam.lookAt(0, 0.12, -6, 0, 0.12, 0);
        const w = m.resolveCharacterSpawn3D(undefined);
        expect(w[1]).toBeCloseTo(0, 4);                                             // the floor, not the wall top (y = 4)
        expect(w[2]).toBeLessThan(2.9);                                             // on the camera's side of it
        expect(w[2]).toBeGreaterThan(2.8);
        // Far decoration (frameExclude: sky clouds, void grid) is never a spawn surface.
        const sky = generateBox(40, 0.1, 40);
        for (let i = 1; i < sky.vertices.length; i += stride) sky.vertices[i] += 1;
        const g = m.addFlatColorMeshGroup('clouds', [{ name: 'clouds', geometry: sky, color: [1, 1, 1], excludeFromFrame: true }]);
        expect(g).toBeTruthy();
        cam.lookAt(3, 2, -6, 3, 0, 1);
        expect(m.resolveCharacterSpawn3D(undefined)[1]).toBeCloseTo(0, 4);
    });

    it('the live body PREVIEW (ghost) uses the same scale + spawn as the committed character: 1.7 m on the looked-at floor in a city, unchanged outside', async () => {
        gpuGlobals();
        const { m, cam, r3o } = makeManager({ gpu: true });
        type Inst = { x: number; y: number; z: number; sx: number; sy: number; sz: number };
        let ghost: { instances: Inst[] } | null = null;
        r3o.setGhostPreviewData = (d: { instances: Inst[] } | null) => { ghost = d; };
        await addFloor(m);
        cam.lookAt(3, 2, -6, 3, 0, 1);
        const params = { height: 0.5 };
        // Outside a city: the ghost sits at the camera target at the generated size (as before).
        await m.previewProceduralBody3D(params);
        let g = ghost!.instances[0];
        expect([g.x, g.y, g.z]).toEqual([3, 0, 1]);
        expect([g.sx, g.sy, g.sz]).toEqual([1, 1, 1]);
        // In a city: the ghost == what Generate makes (same uniform scale, same spawn point).
        m.setPlayMetresPerUnitProvider(() => 15);
        await m.previewProceduralBody3D(params);
        g = ghost!.instances[0];
        const [sx, sy, sz] = m.resolveCharacterSpawn3D([0, 0, 0]);
        const r = await m.createProceduralBody3D(params, sx, sy, sz);
        const body = m.getMesh(r.meshId)!;
        expect(body.scaleX).toBeLessThan(1);
        expect(heightOf(m, r.meshId) * 15).toBeCloseTo(1.7, 3);
        expect(g.sx).toBeCloseTo(body.scaleX, 9);
        expect(g.sy).toBeCloseTo(body.scaleY, 9);
        expect(g.sz).toBeCloseTo(body.scaleZ, 9);
        expect(g.x).toBeCloseTo(body.x, 6);
        expect(g.y).toBeCloseTo(body.y, 6);
        expect(g.z).toBeCloseTo(body.z, 6);
        // On the floor where the camera looks — the SOLES, not the hips-level origin (2026-10-04: the feet were buried).
        const soles = Math.min(...body.obbCorners!.map((p) => p[1]));
        expect(soles).toBeCloseTo(0, 4);
        expect(g.y).toBeGreaterThan(0);                                              // the origin is lifted by the legs
        expect(Math.hypot(g.x - 3, g.z - 1)).toBeLessThan(0.5);
        // A slider drag (a new preview) with the camera still: no re-cast, same spot; the commit dropped the ghost.
        expect(ghost).toBeNull();
        await m.previewProceduralBody3D({ height: 1 });
        const g2 = ghost!.instances[0];
        expect([g2.x, g2.y, g2.z]).toEqual([g.x, g.y, g.z]);
        expect(g2.sx).toBeLessThan(g.sx);                                           // taller slider -> smaller factor, still 1.7 m
        m.clearProceduralBodyPreview();
    }, 20000);

    it('City mode keeps its sky backdrop through camera-mode switches (the black-sky-at-altitude bug); outside it the workspace grey returns', () => {
        const { m, r3o } = makeManager();
        let bg: { mode: string } = { mode: 'none' }, active = false;
        r3o.setMeshEditBgMode = (o: { mode: string }) => { bg = { ...o }; };
        r3o.getMeshEditBgMode = () => ({ ...bg });
        r3o.setMeshEditModeActive = (a: boolean) => { active = a; };
        Object.defineProperty(r3o, 'meshEditBgActive', { get: () => active });
        const is: Record<string, unknown> = { getPanOffset: () => ({ x: 0, y: 0 }), getZoomFactor: () => 1 };
        (m as unknown as { ctx: Record<string, unknown> }).ctx.interactionService = new Proxy(is, { get: (o, k) => (k in o ? o[k as string] : () => undefined) });
        m.enterCityMode3D();
        m.setMeshEditBgMode3D({ mode: 'gradient', color1: [0.4, 0.6, 0.86, 1], color2: [0.8, 0.86, 0.92, 1] } as never);   // the city's time-of-day sky
        m.setTarget3D('scene');
        m.setCameraMode3D('ortho2D');
        expect(bg.mode).toBe('gradient');
        expect(active).toBe(true);
        m.setCameraMode3D('free3D');
        expect(bg.mode).toBe('gradient');
        expect(active).toBe(true);
        m.setTarget3D('illustration');
        m.setCameraMode3D('ortho2D');
        expect(active).toBe(true);                                                  // no 2D composite over the city sky
        m.exitCityMode3D();                                                         // leaving City mode: the workspace backdrop again
        m.setTarget3D('scene');
        m.setCameraMode3D('free3D');
        expect(bg.mode).toBe('solid');
    });

    it('a giant user Player (hair + top) in a city: its own parts never pull the camera in, and the camera stays outside its body', async () => {
        gpuGlobals();
        const { m, cam } = makeManager({ gpu: true });
        await addFloor(m);
        const r = await m.createProceduralBody3D(undefined, 0, 0, 0);              // made before the city: a 1.7-unit = 25 m giant
        m.setClothingParams(r.meshId, m.getDefaultClothingParams('top'));
        m.setHairParams(r.meshId, m.getDefaultHairParams());
        const hairId = m.getHairMeshId(r.meshId)!, topId = m.getClothingMeshId(r.meshId, 'top')!;
        expect(hairId && topId).toBeTruthy();
        m.setPlayMetresPerUnitProvider(() => 15);
        m.setPlayerObject3D(r.meshId);
        m.enterPlayMode3D({ keyboard: false, mouseLook: false, gamepad: false, collision: true, config: { cameraMode: 'third' } });
        const priv = m as unknown as { _isPlayerPart(x: Mesh3D): boolean; _collisionSet: Set<Mesh3D> | null; _playerHeight: number; _playController: { cfg: Record<string, number> } };
        for (const id of [r.meshId, hairId, topId, m.getEyesMeshId(r.meshId)].filter(Boolean) as string[]) {
            expect(priv._isPlayerPart(m.getMesh(id)!)).toBe(true);
            expect([...priv._collisionSet!].some((x) => x.id === id)).toBe(false);   // not a ground / wall / camera obstacle
        }
        expect(priv._collisionSet!.size).toBeGreaterThan(0);                   // the floor still is
        const H = priv._playerHeight;
        expect(H).toBeGreaterThan(1);
        expect(priv._playController.cfg.cameraMinDistance).toBeCloseTo(0.5 * H / 1.7, 6);   // sized to the avatar, not 0.5 m
        for (const pitch of [-0.3, -0.9, 0.15]) {   // (looking up much further, the FLOOR rightly pulls it in)
            m.setPlayInput3D({ lookPitch: pitch - m.getPlayCameraState3D()!.pitch });
            await wait(250);
            const st = m.getPlayCameraState3D()!;
            expect(st.distance, `pitch ${pitch}`).toBeCloseTo(st.targetDistance, 3);   // nothing of its own in the way
            const c = m.getMesh(r.meshId)!.obbCorners!;
            const lo = [0, 1, 2].map((i) => Math.min(...c.map((p) => p[i]))), hi = [0, 1, 2].map((i) => Math.max(...c.map((p) => p[i])));
            const e = cam.position;
            const isInside = e[0] > lo[0] && e[0] < hi[0] && e[1] > lo[1] && e[1] < hi[1] && e[2] > lo[2] && e[2] < hi[2];
            expect(isInside, `pitch ${pitch} eye ${[...e].map((v) => v.toFixed(3))}`).toBe(false);
        }
        m.exitPlayMode3D();
    }, 40000);
});

describe('2026-10-03: a Player with the procedural idle ON still walks in Play (the "sliding chess piece" bug)', () => {
    // The character panel turns the procedural idle on for the edited character. The idle is a PRE-RENDER callback, so
    // it ran after every Play tick and re-posed the Player in its idle: the body slid around breathing, no walk cycle.
    const legSwing = async (city: boolean) => {
        const pre: { cb: () => boolean | void; tag?: string }[] = [];
        const { m } = makeManager({ preRender: pre });
        if (city) m.setPlayMetresPerUnitProvider(() => 15);
        const r = await m.createProceduralBody3D({} as never, 0, 0, 0);
        m.setIdleAnimation(r.meshId, true);
        m.setPlayerObject3D(r.meshId);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        m.setPlayInput3D({ forward: 1 });
        await until(() => locoClip(m) === 'Walk');
        const skel = m.getSkeleton(r.skeletonId)!;
        const thigh = skel.data.joints.find((j) => j.name === 'upperleg_L')!;
        // Pitch of the thigh as RENDERED: the Play tick poses it, then a render frame runs the pre-render callbacks.
        const pitches: number[] = [];
        for (let i = 0; i < 40; i++) {
            await wait(25);
            for (const e of pre) if (e.tag === 'idle') e.cb();   // the procedural idle's per-frame solve
            const q = thigh.localRotation;
            pitches.push((2 * Math.asin(Math.max(-1, Math.min(1, q[0]))) * 180) / Math.PI);
        }
        const st = m.getPlayerAnimationState3D();
        m.exitPlayMode3D();
        return { range: Math.max(...pitches) - Math.min(...pitches), state: st?.state, idleCb: pre.filter((e) => e.tag === 'idle').length };
    };
    it('empty scene: the thigh swings through a stride after the render-frame callbacks', async () => {
        const r = await legSwing(false);
        expect(r.idleCb).toBe(1);  // the idle callback really is registered (and was run each frame)
        expect(r.state).toBe('move');
        expect(r.range).toBeGreaterThan(15);     // a walk stride swings the thigh tens of degrees; the idle ~1°
    }, 20000);
    it('in a city (metres-per-unit provider): same', async () => {
        const r = await legSwing(true);
        expect(r.state).toBe('move');
        expect(r.range).toBeGreaterThan(15);
    }, 20000);
});

describe('2026-10-03: jump variety in Play (default gait vs an own Jump clip)', () => {
    const jumpsIn = async (m: Scene3DManager, n: number) => {
        const out: string[] = [];
        for (let k = 0; k < n; k++) {
            m.setPlayInput3D({ jump: true });
            await until(() => m.getPlayerAnimationState3D()?.state === 'jump');
            await wait(40);
            out.push(m.getPlayerAnimationState3D()?.jumpClip ?? '');
            await until(() => { const s = m.getPlayerAnimationState3D()?.state; return s === 'idle' || s === 'move'; }, 6000);
            m.setPlayInput3D({ jump: false });
            await wait(60);
        }
        return out;
    };
    it('the default gait picks a runtime variant per jump (never the same twice running); an own "Jump" plays every time', async () => {
        const { m } = makeManager();
        const r = await m.createProceduralBody3D({} as never, 0, 0, 0);
        m.setPlayerObject3D(r.meshId);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        const picked = await jumpsIn(m, 4);
        m.exitPlayMode3D();
        for (const j of picked) expect(JUMP_VARIANT_CLIPS).toContain(j);
        const fam = (n: string) => n.replace(/ [LR]$/, '');
        for (let i = 1; i < picked.length; i++) expect(fam(picked[i]), picked.join(', ')).not.toBe(fam(picked[i - 1]));
        // Jump variety off: the classic Jump every time.
        m.playSettings.setJumpVariety(false);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        expect(await jumpsIn(m, 2)).toEqual(['Jump', 'Jump']);
        m.exitPlayMode3D();
        m.playSettings.setJumpVariety(true);
        // An authored "Jump" clip on the rig: no variants, the user's clip every jump.
        const skel = m.getSkeleton(r.skeletonId)!;
        (skel.data.clips ??= []).push({ id: 'own-jump', name: 'Jump', startFrame: 0, endFrame: 10, fps: 24, tracks: [] });
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        expect(await jumpsIn(m, 3)).toEqual(['Jump', 'Jump', 'Jump']);
        m.exitPlayMode3D();
    }, 40000);
});

describe('2026-10-04: Play polish — idle variety + landing dust', () => {
    /** Shorten the idle-variant waits (the animator's config; the defaults are 4–7 s / 6–12 s of standing). */
    const quickIdles = (m: Scene3DManager) => {
        const cfg = (m as unknown as { _locoAnim: { cfg: { idleFirstDelay: [number, number]; idleDelay: [number, number] } } })._locoAnim.cfg;
        cfg.idleFirstDelay = [0.2, 0.3]; cfg.idleDelay = [0.2, 0.3];
    };
    it('standing still plays idle variants (no repeats); the procedural idle still YIELDS; moving cancels; off = none', async () => {
        const pre: { cb: () => boolean | void; tag?: string }[] = [];
        const { m } = makeManager({ preRender: pre });
        const r = await m.createProceduralBody3D({} as never, 0, 0, 0);
        m.setIdleAnimation(r.meshId, true);                       // the character panel's procedural idle left ON
        m.setPlayerObject3D(r.meshId);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        quickIdles(m);
        await until(() => m.getPlayPolishStats3D().idleVariant !== null, 6000);
        expect(m.getPlayPolishStats3D().idleVariant).toMatch(/^Idle /);
        await wait(300);
        // The procedural idle's per-frame solve must not re-pose the Play-driven rig mid-variant.
        const skel = m.getSkeleton(r.skeletonId)!;
        const head = skel.data.joints.find((j) => j.name === 'head')!;
        const before = [...head.localRotation];
        for (const e of pre) if (e.tag === 'idle') e.cb();
        expect([...head.localRotation]).toEqual(before);
        // Moving cancels the variant at once (locomotion wins).
        m.setPlayInput3D({ forward: 1 });
        await until(() => m.getPlayerAnimationState3D()?.state === 'move');
        await wait(250);
        expect(m.getPlayPolishStats3D().idleVariant).toBeNull();
        m.setPlayInput3D({ forward: 0 });
        await until(() => m.getPlayPolishStats3D().idleVariants.length >= 4, 15000);
        const seq = m.getPlayPolishStats3D().idleVariants;
        for (let i = 1; i < seq.length; i++) expect(seq[i], seq.join(', ')).not.toBe(seq[i - 1]);
        m.exitPlayMode3D();
        // Off: none.
        m.playSettings.setIdleVariety(false);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        quickIdles(m);
        await wait(1200);
        expect(m.getPlayPolishStats3D().idleVariants).toEqual([]);
        m.exitPlayMode3D();
        m.playSettings.setIdleVariety(true);
    }, 40000);

    it('an authored "Idle" clip wins: no variants over it', async () => {
        const { m } = makeManager();
        const r = await m.createProceduralBody3D({} as never, 0, 0, 0);
        const skel = m.getSkeleton(r.skeletonId)!;
        (skel.data.clips ??= []).push({ id: 'own-idle', name: 'Idle', startFrame: 0, endFrame: 48, fps: 24, tracks: [] });
        m.setPlayerObject3D(r.meshId);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        quickIdles(m);
        await wait(1200);
        expect(m.getPlayPolishStats3D().idleVariants).toEqual([]);
        m.exitPlayMode3D();
    }, 20000);

    it('landing dust: a burst on landing, nothing (and no memory) while standing; off = none', async () => {
        const { m } = makeManager();
        const r = await m.createProceduralBody3D({} as never, 0, 0, 0);
        m.setPlayerObject3D(r.meshId);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        await wait(400);
        expect(m.playDust.system.allocated).toBe(false);          // standing: zero cost
        const landings = () => { const d = m.getPlayPolishStats3D().dust; return d.land + d.landDeep + d.landSoft; };
        m.setPlayInput3D({ jump: true });
        await until(() => m.getPlayerAnimationState3D()?.state === 'jump');
        m.setPlayInput3D({ jump: false });
        await until(() => landings() > 0, 6000);
        expect(landings()).toBe(1);
        await until(() => !m.playDust.system.allocated, 4000);    // the puffs die and the pool is released
        expect(m.playDust.system.allocated).toBe(false);
        m.exitPlayMode3D();
        m.playSettings.setLandingDust(false);
        m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
        m.setPlayInput3D({ jump: true });
        await until(() => m.getPlayerAnimationState3D()?.state === 'jump');
        m.setPlayInput3D({ jump: false });
        await until(() => { const s = m.getPlayerAnimationState3D()?.state; return s === 'idle'; }, 6000);
        await wait(200);
        expect(landings()).toBe(0);
        m.exitPlayMode3D();
        m.playSettings.setLandingDust(true);
    }, 30000);
});
