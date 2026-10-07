/**
 * view-gizmo.test.ts — the nav gizmo must never outlive / out-show its canvas (2026-10-07: "when I leave an
 * illustration I still see the world gizmo from 3D mode"). A minimal DOM stub (no happy-dom in this repo): document.body,
 * createElement('canvas') with a no-op 2D context, window as an EventTarget that counts listeners, and a manual
 * ResizeObserver. Covers:
 *  - the overlay hides when its canvas is removed / display:none (0×0 box), and comes back when the canvas does;
 *  - host hide (setHidden) and the render-debug switch, combined;
 *  - z-index below host panels / dialogs by default, overridable;
 *  - destroy() removes the element and every window listener (no leak), and is idempotent;
 *  - setCanvas re-anchors the observer;
 *  - Scene3DArmature: the host-hide flag is sticky across re-creation; a canvas SWAP disposes the stale gizmo;
 *    enableViewGizmo re-anchors a gizmo left on an old canvas instead of keeping it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ViewGizmo, VIEW_GIZMO_Z, VIEW_GIZMO_CLASS } from './view-gizmo';
import { Camera3D } from './camera-3d';
import { OrbitController } from './orbit-controller';
import { RD } from './render-debug';
import { Scene3DArmature, type Scene3DArmatureHost } from '../../services/managers/scene3d-armature';
import type { ManagerContext } from '../../services/managers/manager-context';

// ── DOM stub ────────────────────────────────────────────────────────────────────────────────────────────────────────
type Box = { left: number; top: number; width: number; height: number };
interface FakeEl extends EventTarget {
    style: Record<string, string> & { cssText: string };
    className: string; width: number; height: number;
    isConnected: boolean;
    remove(): void;
    getContext(kind: string): unknown;
    getBoundingClientRect(): Box & { right: number; bottom: number };
    setPointerCapture(id: number): void;
}

let bodyChildren: FakeEl[];
let roCallbacks: { cb: () => void; targets: Set<unknown> }[];
let winListeners: Map<string, number>;

function makeStyle(): FakeEl['style'] {
    const s: Record<string, string> = {};
    return new Proxy(s, {
        set(t, k: string, v: string) {
            if (k === 'cssText') { for (const part of String(v).split(';')) { const [a, b] = part.split(':'); if (a && b) t[a.trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = b.trim(); } }
            t[k] = v; return true;
        },
    }) as FakeEl['style'];
}
const noopCtx = new Proxy({}, { get: (_t, k) => (k === 'createRadialGradient' ? () => ({ addColorStop: () => {} }) : () => {}), set: () => true });

function fakeEl(box: Box = { left: 0, top: 0, width: 800, height: 600 }): FakeEl & { box: Box } {
    const el = new EventTarget() as FakeEl & { box: Box };
    Object.assign(el, {
        style: makeStyle(), className: '', width: 0, height: 0, isConnected: true, box,
        remove() { el.isConnected = false; const i = bodyChildren.indexOf(el); if (i >= 0) bodyChildren.splice(i, 1); },
        getContext: () => noopCtx,
        getBoundingClientRect() {
            const b = el.isConnected ? el.box : { left: 0, top: 0, width: 0, height: 0 };
            return { ...b, right: b.left + b.width, bottom: b.top + b.height };
        },
        setPointerCapture: () => {},
    });
    return el;
}
const fireRO = () => { for (const r of roCallbacks) if (r.targets.size) r.cb(); };

beforeEach(() => {
    bodyChildren = []; roCallbacks = []; winListeners = new Map();
    const win = new EventTarget();
    const add = win.addEventListener.bind(win), rem = win.removeEventListener.bind(win);
    win.addEventListener = (t: string, h: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) => { winListeners.set(t, (winListeners.get(t) ?? 0) + 1); add(t, h, o); };
    win.removeEventListener = (t: string, h: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) => { winListeners.set(t, (winListeners.get(t) ?? 0) - 1); rem(t, h, o); };
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', {
        createElement: () => fakeEl(),
        body: { appendChild: (el: FakeEl) => { el.isConnected = true; bodyChildren.push(el); return el; } },
    });
    vi.stubGlobal('ResizeObserver', class {
        private _rec: { cb: () => void; targets: Set<unknown> };
        constructor(cb: () => void) { this._rec = { cb, targets: new Set() }; roCallbacks.push(this._rec); }
        observe(t: unknown) { this._rec.targets.add(t); }
        unobserve(t: unknown) { this._rec.targets.delete(t); }
        disconnect() { this._rec.targets.clear(); }
    });
    RD.on = false; RD.f.noViewGizmo = false;
});
afterEach(() => { vi.unstubAllGlobals(); RD.on = false; RD.f.noViewGizmo = false; });

function makeGizmo(canvas = fakeEl({ left: 70, top: 0, width: 800, height: 600 })) {
    const cam = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0] });
    const orbit = new OrbitController(cam, { enableDamping: false });
    const g = new ViewGizmo(canvas as unknown as HTMLCanvasElement, cam, orbit, () => {}, { corner: 'top-left', offsetX: 100, offsetY: 52 });
    const el = g.element as unknown as FakeEl;
    return { g, el, canvas };
}
const shown = (el: FakeEl) => el.style.display !== 'none';

describe('ViewGizmo — visibility follows its canvas', () => {
    it('is a classed body overlay under host panels / dialogs, placed at the canvas corner + inset', () => {
        const { g, el } = makeGizmo();
        expect(bodyChildren).toContain(el);
        expect(el.className).toBe(VIEW_GIZMO_CLASS);
        expect(VIEW_GIZMO_Z).toBeLessThan(999);         // Frogmarks toolbars / panels start at 999, modals at 9000
        expect(el.style.zIndex).toBe(String(VIEW_GIZMO_Z));
        expect(el.style.left).toBe('170px');
        expect(el.style.top).toBe('52px');
        expect(g.visible).toBe(true);
        g.setPosition({ zIndex: 12 });
        expect(el.style.zIndex).toBe('12');
    });

    it('hides when its canvas leaves the document (route change) and stays hidden through frames', () => {
        const { g, el, canvas } = makeGizmo();
        canvas.isConnected = false;                     // Angular destroyed the editor: the canvas is gone
        fireRO();                                       // the observer reports the 0×0 box
        expect(shown(el)).toBe(false);
        expect(g.visible).toBe(false);
        g.draw();                                       // a stray frame must not bring it back
        expect(shown(el)).toBe(false);
    });

    it('hides even with NO observer callback: the per-frame draw sees the disconnected canvas', () => {
        const { g, el, canvas } = makeGizmo();
        canvas.isConnected = false;
        g.draw();
        expect(shown(el)).toBe(false);
    });

    it('hides for a 0×0 canvas (display:none pane) and returns, re-placed, when it is laid out again', () => {
        const { g, el, canvas } = makeGizmo();
        canvas.box = { left: 0, top: 0, width: 0, height: 0 };
        fireRO();
        expect(shown(el)).toBe(false);
        canvas.box = { left: 300, top: 40, width: 500, height: 400 };
        fireRO();
        expect(shown(el)).toBe(true);
        expect(el.style.left).toBe('400px');
        expect(el.style.top).toBe('92px');
        expect(g.visible).toBe(true);
    });

    it('host hide and the render-debug switch combine with the canvas state', () => {
        const { g, el } = makeGizmo();
        g.setHidden(true);
        expect(shown(el)).toBe(false);
        g.draw();
        expect(shown(el)).toBe(false);
        g.setHidden(false);
        expect(shown(el)).toBe(true);
        RD.on = true; RD.f.noViewGizmo = true;
        g.draw();
        expect(shown(el)).toBe(false);
        RD.f.noViewGizmo = false;
        g.draw();
        expect(shown(el)).toBe(true);
    });

    it('destroy() removes the element and every window listener; idempotent; later calls are no-ops', () => {
        const { g, el } = makeGizmo();
        expect(winListeners.get('scroll')).toBe(1);
        expect(winListeners.get('resize')).toBe(1);
        g.destroy();
        g.destroy();
        expect(bodyChildren).not.toContain(el);
        expect(winListeners.get('scroll')).toBe(0);
        expect(winListeners.get('resize')).toBe(0);
        expect(roCallbacks.every(r => r.targets.size === 0)).toBe(true);
        expect(g.visible).toBe(false);
        expect(() => { g.draw(); g.setHidden(false); g.setPosition({ offsetX: 1 }); }).not.toThrow();
    });

    it('setCanvas re-anchors the observer and the placement', () => {
        const { g, el, canvas } = makeGizmo();
        const b = fakeEl({ left: 0, top: 100, width: 400, height: 300 });
        g.setCanvas(b as unknown as HTMLCanvasElement);
        expect(g.canvas).toBe(b);
        expect(roCallbacks[0].targets.has(canvas)).toBe(false);
        expect(roCallbacks[0].targets.has(b)).toBe(true);
        expect(el.style.top).toBe('152px');
    });
});

// ── Scene3DArmature ownership ───────────────────────────────────────────────────────────────────────────────────────
function armature() {
    let canvas = fakeEl() as unknown as HTMLCanvasElement;
    const cam = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0] });
    const preRender = new Set<unknown>();
    const ctx = {
        webgpuRenderer: {
            getCanvas: () => canvas,
            getRenderer3D: () => ({ getCamera: () => cam }),
            addPreRenderCallback: (cb: unknown) => { preRender.add(cb); },
            removePreRenderCallback: (cb: unknown) => { preRender.delete(cb); },
        },
        scheduleRender: () => {},
    } as unknown as ManagerContext;
    const arm = new Scene3DArmature(ctx, {} as unknown as Scene3DArmatureHost);
    (arm as unknown as { _orbitController: OrbitController })._orbitController = new OrbitController(cam, { enableDamping: false });
    return { arm, preRender, swap: (c: HTMLCanvasElement) => { canvas = c; }, canvas: () => canvas };
}

describe('Scene3DArmature — the nav gizmo belongs to the current canvas', () => {
    it('host hide is sticky across disable / enable (modes re-create the gizmo)', () => {
        const { arm } = armature();
        arm.enableViewGizmo();
        expect(arm.isViewGizmoVisible()).toBe(true);
        arm.setViewGizmoHidden(true);
        expect(arm.isViewGizmoVisible()).toBe(false);
        arm.disableViewGizmo();
        arm.enableViewGizmo();
        expect(bodyChildren.length).toBe(1);
        expect(shown(bodyChildren[0])).toBe(false);
        arm.setViewGizmoHidden(false);
        expect(arm.isViewGizmoVisible()).toBe(true);
    });

    it('a canvas SWAP (route change) disposes the old gizmo: element, frame callback, window listeners', () => {
        const { arm, preRender, swap } = armature();
        arm.enableViewGizmo();
        expect(bodyChildren.length).toBe(1);
        expect(preRender.size).toBe(1);
        swap(fakeEl() as unknown as HTMLCanvasElement);
        arm.reattachCanvasListeners();
        expect(bodyChildren.length).toBe(0);
        expect(preRender.size).toBe(0);
        expect(winListeners.get('scroll')).toBe(0);
        expect(arm.isViewGizmoVisible()).toBe(false);
        // Re-entering a 3D mode on the new canvas makes exactly one new gizmo there.
        arm.enableViewGizmo();
        arm.enableViewGizmo();
        expect(bodyChildren.length).toBe(1);
    });

    it('reattach on the SAME canvas keeps the gizmo', () => {
        const { arm } = armature();
        arm.enableViewGizmo();
        arm.reattachCanvasListeners();
        expect(bodyChildren.length).toBe(1);
        expect(arm.isViewGizmoVisible()).toBe(true);
    });

    it('enableViewGizmo re-anchors a gizmo left on a stale canvas (no duplicate)', () => {
        const { arm, swap, canvas } = armature();
        arm.enableViewGizmo();
        const old = canvas();
        const next = fakeEl({ left: 0, top: 200, width: 640, height: 480 }) as unknown as HTMLCanvasElement;
        swap(next);
        arm.enableViewGizmo();
        expect(bodyChildren.length).toBe(1);
        expect(roCallbacks[0].targets.has(old)).toBe(false);
        expect(roCallbacks[0].targets.has(next)).toBe(true);
    });
});
