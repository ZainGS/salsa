/**
 * play-input.test.ts: TOUCH-4. The host-fed Play intent (a virtual joystick / Jump / Use) is merged with the keyboard
 * reading (like the gamepad) instead of being ignored whenever the built-in keyboard is attached; setPlayInput3D
 * copies `interact`; Play runs with mouseLook:false (touch: pointer-lock mouse-look doesn't work on Android).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { mergeHostPlayInput } from './play-input';
import { Scene3DManager } from '../services/managers/scene3d-manager';
import { Camera3D } from '../renderer/3d/camera-3d';
import { Node } from '../scene-graph/shapes/base/node';
import type { CharacterController, CharacterInput } from './character-controller';

describe('mergeHostPlayInput', () => {
    const kb = (o: Partial<CharacterInput> = {}): CharacterInput => ({ forward: 0, right: 0, look: 0, jump: false, ...o });
    it('adds + clamps axes, ORs the buttons, never mutates its inputs', () => {
        const base = kb({ forward: 1, right: -0.5 });
        const host = { forward: 0.8, right: -0.75, look: 0.25, jump: true, interact: true };
        const m = mergeHostPlayInput(base, host);
        expect(m).toEqual({ forward: 1, right: -1, look: 0.25, jump: true, interact: true });
        expect(base).toEqual(kb({ forward: 1, right: -0.5 }));
    });
    it('a host joystick alone drives the merged input (keyboard idle)', () => {
        expect(mergeHostPlayInput(kb(), { forward: -0.6, right: 0.3 })).toMatchObject({ forward: -0.6, right: 0.3, jump: false });
    });
    it('opposite keyboard + stick cancel; non-finite host values are ignored', () => {
        expect(mergeHostPlayInput(kb({ forward: 1 }), { forward: -1, right: NaN }).forward).toBe(0);
        expect(mergeHostPlayInput(kb({ right: 0.5 }), { right: NaN }).right).toBe(0.5);
    });
});

// ── Integration: a real Scene3DManager Play run (stub GPU), keyboard ON + mouseLook OFF ──
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

function makeManager(): Scene3DManager {
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
    return new Scene3DManager(ctx as never);
}

type Internals = { _playController: CharacterController | null; _keyboard: unknown; _mouseLook: unknown; _playInput: CharacterInput; _lastPlayBase: CharacterInput | null };

describe('Play with the keyboard attached + a host virtual joystick (TOUCH-4)', () => {
    let m: Scene3DManager | null = null;
    afterEach(() => { try { m?.exitPlayMode3D(); } catch { /* */ } m = null; });

    it('enters with mouseLook:false, merges the host stick with the keyboard, copies interact', async () => {
        m = makeManager();
        m.enterPlayMode3D({ keyboard: true, mouseLook: false, gamepad: false, collision: false, start: [0, 0, 0] });
        const p = m as unknown as Internals;
        expect(m.isPlaying3D).toBe(true);
        expect(p._keyboard).not.toBeNull();            // the built-in keyboard IS attached…
        expect(p._mouseLook).toBeNull();               // …and no pointer-lock mouse-look
        const cc = p._playController!;
        const z0 = cc.pos[2], x0 = cc.pos[0];
        m.setPlayInput3D({ forward: 1, interact: true });
        expect(p._playInput.interact).toBe(true);      // was dropped before
        await until(() => Math.hypot(cc.pos[0] - x0, cc.pos[2] - z0) > 0.05);
        expect(Math.hypot(cc.pos[0] - x0, cc.pos[2] - z0)).toBeGreaterThan(0.05);   // the stick moved the player
        expect(p._lastPlayBase?.interact).toBe(true);  // Use reached the merged tick input
        m.setPlayerSneaking3D(true);                    // the public sneak setter (on-screen Sneak button)
        expect(m.getPlayerSneaking3D()).toBe(true);
        m.setPlayerSneaking3D(false);
        expect(m.getPlayerSneaking3D()).toBe(false);
    });
});
