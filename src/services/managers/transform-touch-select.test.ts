/**
 * transform-touch-select.test.ts: TOUCH-5 / TOUCH-6 / TOUCH-8 in TransformController3D. Synthetic pointer events on a
 * fake canvas; the mesh picker and gizmo renderer are stubbed (no GPU).
 *  - mouse selects on pointerDOWN (unchanged);
 *  - a finger selects on pointerUP, only when it moved ≤ TAP_SLOP_PX (an orbit drag never selects);
 *  - a 2nd finger drops the pending tap and CANCELS a gizmo drag (meshes restored, orbit re-enabled);
 *  - gizmo picks run with the touch hit scale under a finger, 1 for the mouse.
 */
import { describe, it, expect } from 'vitest';
import { TransformController3D, type TransformControllerCallbacks } from './transform-controller-3d';
import { Camera3D } from '../../renderer/3d/camera-3d';
import type { GizmoRenderer } from '../../renderer/3d/gizmo-renderer';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { OrbitController } from '../../renderer/3d/orbit-controller';

type Init = Partial<{ pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; shiftKey: boolean }>;

function fakeCanvas(): HTMLCanvasElement {
    const el = new EventTarget() as EventTarget & Record<string, unknown>;
    Object.assign(el, {
        style: {}, width: 800, height: 600,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        setPointerCapture: () => {}, releasePointerCapture: () => {},
    });
    return el as unknown as HTMLCanvasElement;
}
function fire(el: HTMLCanvasElement, type: string, init: Init): void {
    const e = new Event(type, { cancelable: true, bubbles: true });
    Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, altKey: false, ctrlKey: false, shiftKey: false, ...init });
    el.dispatchEvent(e);
}

function setup(opts: { gizmoHit?: boolean } = {}) {
    const meshA = { id: 'A', x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotation: 0, scaleX: 1, scaleY: 1, scaleZ: 1, localMatrix: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]) } as unknown as Mesh3D;
    let selected = new Set<string>();
    const orb = { enabled: true } as unknown as OrbitController;
    const hitScales: number[] = [];
    const gizmo = {
        hitScale: 1,
        hitTestArrayHandle: () => null,
        hitTestCorner: () => null,
        hitTest(this: { hitScale: number }) { hitScales.push(this.hitScale); return opts.gizmoHit ? 'x' : null; },
        computeCenter: () => new Float32Array([0, 0, 0]),
    } as unknown as GizmoRenderer;
    const cb: TransformControllerCallbacks = {
        getMeshes: () => [meshA],
        getCamera: () => new Camera3D({ position: [0, 0, 5], target: [0, 0, 0] }),
        getCanvasSize: () => ({ width: 800, height: 600 }),
        getSelectedIds: () => selected,
        setSelectedIds: (ids) => { selected = new Set(ids); },
        scheduleRender: () => {},
        getOrbitController: () => orb,
    };
    const tc = new TransformController3D(cb, gizmo);
    // Stub the raycast: the mesh 'A' covers the left half of the canvas (canvas px x < 400).
    let lastPickX = -1;
    (tc as unknown as { picker: unknown }).picker = {
        castRay: () => ({ origin: new Float32Array([0, 0, 5]), dir: new Float32Array([0, 0, -1]) }),
        pickMesh: (x: number) => { lastPickX = x; return x < 400 ? { mesh: meshA } : null; },
    };
    const el = fakeCanvas();
    tc.attach(el);
    return { tc, el, meshA, orb, hitScales, sel: () => selected, select: (ids: string[]) => { selected = new Set(ids); }, lastPickX: () => lastPickX };
}

describe('TransformController3D touch selection (TOUCH-6)', () => {
    it('mouse selects on pointerDOWN (unchanged)', () => {
        const { el, sel } = setup();
        fire(el, 'pointerdown', { clientX: 100, clientY: 100 });
        expect([...sel()]).toEqual(['A']);
    });

    it('a finger TAP selects on pointerUP, at the release position', () => {
        const { el, sel, lastPickX } = setup();
        fire(el, 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
        expect(sel().size).toBe(0);                          // nothing on down
        fire(el, 'pointermove', { pointerType: 'touch', clientX: 104, clientY: 103 });   // 5 px wobble: still a tap
        fire(el, 'pointerup', { pointerType: 'touch', clientX: 104, clientY: 103 });
        expect([...sel()]).toEqual(['A']);
        expect(lastPickX()).toBe(104);
    });

    it('a finger DRAG (orbit) past the slop never selects or deselects', () => {
        const { el, sel, select } = setup();
        select(['B']);
        fire(el, 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
        fire(el, 'pointermove', { pointerType: 'touch', clientX: 100 + TransformController3D.TAP_SLOP_PX + 2, clientY: 100 });
        fire(el, 'pointerup', { pointerType: 'touch', clientX: 600, clientY: 100 });
        expect([...sel()]).toEqual(['B']);
    });

    it('a tap on empty space deselects; a 2nd finger cancels the pending tap', () => {
        const { el, sel, select } = setup();
        select(['A']);
        fire(el, 'pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 });
        fire(el, 'pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 600, clientY: 100 });
        fire(el, 'pointerup', { pointerType: 'touch', pointerId: 2, clientX: 600, clientY: 100 });
        fire(el, 'pointerup', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 });
        expect([...sel()]).toEqual(['A']);                    // pinch/pan gesture: selection untouched
        fire(el, 'pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 600, clientY: 100 });
        fire(el, 'pointerup', { pointerType: 'touch', pointerId: 3, clientX: 600, clientY: 100 });
        expect(sel().size).toBe(0);
    });
});

describe('TransformController3D gizmo under a finger (TOUCH-5 / TOUCH-8)', () => {
    it('gizmo picks use the touch hit scale for a finger and 1 for the mouse; the scale resets after', () => {
        const { el, select, hitScales, tc } = setup();
        select(['A']);
        fire(el, 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
        fire(el, 'pointerup', { pointerType: 'touch', clientX: 100, clientY: 100 });
        fire(el, 'pointerdown', { pointerType: 'mouse', clientX: 100, clientY: 100 });
        expect(hitScales).toEqual([TransformController3D.TOUCH_HIT_SCALE, 1]);
        expect(((tc as unknown as { gizmoRenderer: { hitScale: number } }).gizmoRenderer).hitScale).toBe(1);
    });

    it('a 2nd finger CANCELS a finger gizmo drag: meshes restored, orbit re-enabled', () => {
        const { el, select, meshA, orb, tc } = setup({ gizmoHit: true });
        select(['A']);
        fire(el, 'pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 });
        expect(orb.enabled).toBe(false);                       // the gizmo drag owns the finger
        meshA.x = 3;                                           // (as if dragged)
        fire(el, 'pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 300, clientY: 100 });
        expect(meshA.x).toBe(0);
        expect(orb.enabled).toBe(true);
        expect((tc as unknown as { _drag: unknown })._drag).toBeNull();
    });

    it('pointercancel cancels a gizmo drag too', () => {
        const { el, select, meshA, orb } = setup({ gizmoHit: true });
        select(['A']);
        fire(el, 'pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 });
        meshA.y = 2;
        fire(el, 'pointercancel', { pointerType: 'touch', pointerId: 1 });
        expect(meshA.y).toBe(0);
        expect(orb.enabled).toBe(true);
    });
});
