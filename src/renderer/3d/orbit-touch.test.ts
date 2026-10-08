/**
 * orbit-touch.test.ts: TOUCH-3 (docs/specs/mobile-parity.md §4, docs/ui/touch-controls.md). Synthetic pointer events
 * (touch vs mouse) on a fake canvas drive the real OrbitController listeners.
 */
import { describe, it, expect } from 'vitest';
import { OrbitController } from './orbit-controller';
import { Camera3D } from './camera-3d';
import { claimPointerEvent } from '../util/pointer-claims';

type Init = Partial<{ pointerId: number; pointerType: string; button: number; clientX: number; clientY: number; altKey: boolean; isPrimary: boolean }>;

function fakeCanvas() {
    const el = new EventTarget() as EventTarget & Record<string, unknown>;
    const captured = new Set<number>();
    Object.assign(el, {
        style: { touchAction: '' } as Record<string, string>,
        width: 800, height: 600, clientWidth: 800, clientHeight: 600,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
        setPointerCapture: (id: number) => { captured.add(id); },
        releasePointerCapture: (id: number) => { captured.delete(id); },
    });
    return { el: el as unknown as HTMLCanvasElement, captured };
}

function fire(el: HTMLCanvasElement, type: string, init: Init): void {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, altKey: false, isPrimary: true, ...init });
    el.dispatchEvent(e);
}
const touch = (el: HTMLCanvasElement, type: string, id: number, x: number, y: number) =>
    fire(el, type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, isPrimary: id === 1 });

function setup(cfg: ConstructorParameters<typeof OrbitController>[1] = {}, camCfg: ConstructorParameters<typeof Camera3D>[0] = {}) {
    const cam = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0], sceneRadius: 10, ...camCfg });
    const orb = new OrbitController(cam, { enableDamping: false, ...cfg });
    const { el, captured } = fakeCanvas();
    orb.attach(el);
    return { cam, orb, el, captured };
}
const tgt = (cam: Camera3D) => [cam.target[0], cam.target[1], cam.target[2]];
const pos = (cam: Camera3D) => [cam.position[0], cam.position[1], cam.position[2]];

describe('OrbitController — mouse path unchanged', () => {
    it('LMB drag orbits by exactly dx × orbitSpeed; MMB pans; no pointer capture', () => {
        const { orb, el, cam, captured } = setup();
        const az0 = orb.azimuth, el0 = orb.elevation;
        fire(el, 'pointerdown', { clientX: 100, clientY: 100 });
        fire(el, 'pointermove', { clientX: 110, clientY: 104 });
        expect(orb.azimuth).toBeCloseTo(az0 - 10 * orb.orbitSpeed, 12);
        expect(orb.elevation).toBeCloseTo(el0 + 4 * orb.orbitSpeed, 12);
        fire(el, 'pointerup', { clientX: 110, clientY: 104 });
        expect(captured.size).toBe(0);
        const t0 = tgt(cam);
        fire(el, 'pointerdown', { button: 1, clientX: 0, clientY: 0 });
        fire(el, 'pointermove', { clientX: 20, clientY: 0 });
        expect(tgt(cam)[0]).not.toBeCloseTo(t0[0], 6);
    });

    it('a SECOND pointer no longer makes the camera jump (shared _lastX fix)', () => {
        const { orb, el } = setup();
        const az0 = orb.azimuth;
        fire(el, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
        fire(el, 'pointermove', { pointerId: 2, pointerType: 'pen', clientX: 600, clientY: 400 });   // another pointer
        expect(orb.azimuth).toBe(az0);
        fire(el, 'pointermove', { pointerId: 1, clientX: 105, clientY: 100 });
        expect(orb.azimuth).toBeCloseTo(az0 - 5 * orb.orbitSpeed, 12);   // only the real 5 px, not the 500 px gap
        fire(el, 'pointerup', { pointerId: 2, pointerType: 'pen' });     // the other pointer lifting doesn't end it
        fire(el, 'pointermove', { pointerId: 1, clientX: 110, clientY: 100 });
        expect(orb.azimuth).toBeCloseTo(az0 - 10 * orb.orbitSpeed, 12);
    });

    it('altOrbitOnly still needs Alt for a mouse orbit', () => {
        const { orb, el } = setup({ altOrbitOnly: true });
        const az0 = orb.azimuth;
        fire(el, 'pointerdown', { clientX: 0, clientY: 0 });
        fire(el, 'pointermove', { clientX: 30, clientY: 0 });
        expect(orb.azimuth).toBe(az0);
    });

    it('sets touch-action:none on attach and restores it on detach', () => {
        const { orb, el } = setup();
        expect((el.style as unknown as Record<string, string>).touchAction).toBe('none');
        orb.detach();
        expect((el.style as unknown as Record<string, string>).touchAction).toBe('');
    });
});

describe('OrbitController — touch gestures per scheme', () => {
    it('classic: 1 finger orbits (captured), 2 fingers pan, pinch dollies', () => {
        const { orb, el, cam, captured } = setup();
        const az0 = orb.azimuth;
        touch(el, 'pointerdown', 1, 100, 100);
        expect(captured.has(1)).toBe(true);
        touch(el, 'pointermove', 1, 120, 100);
        expect(orb.azimuth).toBeCloseTo(az0 - 20 * orb.orbitSpeed, 12);
        // 2nd finger: parallel drag = pan (orbit angle unchanged, target moves), no jump on the finger joining.
        const az1 = orb.azimuth, t0 = tgt(cam);
        touch(el, 'pointerdown', 2, 300, 100);
        touch(el, 'pointermove', 1, 140, 100);
        touch(el, 'pointermove', 2, 320, 100);
        expect(orb.azimuth).toBeCloseTo(az1, 12);
        expect(Math.hypot(tgt(cam)[0] - t0[0], tgt(cam)[1] - t0[1], tgt(cam)[2] - t0[2])).toBeGreaterThan(1e-4);
        // Pinch apart → radius shrinks (zoom in), pinch together → grows.
        const r0 = orb.radius;
        touch(el, 'pointermove', 2, 520, 100);
        expect(orb.radius).toBeLessThan(r0);
        const r1 = orb.radius;
        touch(el, 'pointermove', 2, 240, 100);
        expect(orb.radius).toBeGreaterThan(r1);
    });

    it('classic pinch matches radius / spread-ratio exactly (classic dolly)', () => {
        const { orb, el } = setup();
        touch(el, 'pointerdown', 1, 100, 100);
        touch(el, 'pointerdown', 2, 200, 100);
        const r0 = orb.radius;
        touch(el, 'pointermove', 2, 300, 100);   // spread 100 → 200, midpoint moves 50 → also a pan (radius kept)
        expect(orb.radius).toBeCloseTo(r0 / ((200) / 100), 9);
    });

    it('freeLookNav: 1 finger free-looks in place, pinch dollies THROUGH (camera keeps moving forward)', () => {
        const { orb, el, cam } = setup({ freeLookNav: true });
        orb.dollyThrough = true; orb.minRadius = 1e-4; orb.maxRadius = 1e5; orb.dollyFloor = 1;
        const p0 = pos(cam), t0 = tgt(cam);
        touch(el, 'pointerdown', 1, 100, 100);
        touch(el, 'pointermove', 1, 140, 100);
        expect(pos(cam)[0]).toBeCloseTo(p0[0], 9); expect(pos(cam)[2]).toBeCloseTo(p0[2], 9);   // position stays put
        expect(tgt(cam)[0]).not.toBeCloseTo(t0[0], 4);                                            // the view swung
        touch(el, 'pointerup', 1, 140, 100);
        // Pinch in many times: dolly-through never stalls at the pivot.
        const z0 = cam.position[2];
        const fwd = [cam.target[0] - cam.position[0], cam.target[2] - cam.position[2]];
        touch(el, 'pointerdown', 3, 300, 300);
        touch(el, 'pointerdown', 4, 310, 300);
        for (let i = 0; i < 40; i++) touch(el, 'pointermove', 4, 310 + (i + 1) * 20, 300);
        const moved = [cam.position[0] - p0[0], cam.position[2] - z0];
        expect(moved[0] * fwd[0] + moved[1] * fwd[1]).toBeGreaterThan(5);   // flew far along the view (past the 5-unit pivot)
    });

    it('altOrbitOnly: 1 finger is left to the tool; 2 fingers orbit; 3 fingers pan; touchNavLock → 1 finger orbits', () => {
        const { orb, el, cam } = setup({ altOrbitOnly: true });
        const az0 = orb.azimuth, t0 = tgt(cam);
        touch(el, 'pointerdown', 1, 100, 100);
        touch(el, 'pointermove', 1, 160, 100);
        expect(orb.azimuth).toBe(az0);
        touch(el, 'pointerdown', 2, 300, 100);
        touch(el, 'pointermove', 1, 180, 100);
        touch(el, 'pointermove', 2, 320, 100);
        expect(orb.azimuth).toBeCloseTo(az0 - 20 * orb.orbitSpeed, 12);   // centroid moved 20 px → orbit
        expect(tgt(cam)).toEqual(t0);                                      // not a pan
        touch(el, 'pointerdown', 3, 200, 300);
        const az1 = orb.azimuth;
        touch(el, 'pointermove', 1, 210, 100); touch(el, 'pointermove', 2, 330, 100); touch(el, 'pointermove', 3, 210, 300);
        expect(orb.azimuth).toBeCloseTo(az1, 12);
        expect(tgt(cam)).not.toEqual(t0);                                  // three fingers pan
        for (const id of [1, 2, 3]) touch(el, 'pointerup', id, 0, 0);
        orb.touchNavLock = true;
        const az2 = orb.azimuth;
        touch(el, 'pointerdown', 5, 100, 100);
        touch(el, 'pointermove', 5, 110, 100);
        expect(orb.azimuth).toBeCloseTo(az2 - 10 * orb.orbitSpeed, 12);
    });

    it('ortho pinch goes to the host zoom hook (a dolly is invisible in ortho)', () => {
        const { orb, el } = setup({}, { mode: 'orthographic' });
        const zooms: number[] = [];
        orb.onTouchZoom = (ratio) => { zooms.push(ratio); };
        const r0 = orb.radius;
        touch(el, 'pointerdown', 1, 100, 100);
        touch(el, 'pointerdown', 2, 200, 100);
        touch(el, 'pointermove', 2, 300, 100);
        expect(zooms.length).toBe(1);
        expect(zooms[0]).toBeCloseTo(2, 9);
        expect(orb.radius).toBe(r0);
    });

    it('onTouchPan returning true replaces the orbit pan', () => {
        const { orb, el, cam } = setup();
        const pans: [number, number][] = [];
        orb.onTouchPan = (dx, dy) => { pans.push([dx, dy]); return true; };
        const t0 = tgt(cam);
        touch(el, 'pointerdown', 1, 100, 100);
        touch(el, 'pointerdown', 2, 200, 100);
        touch(el, 'pointermove', 1, 120, 100);
        expect(pans).toEqual([[10, 0]]);   // the midpoint moved 10 px
        expect(tgt(cam)).toEqual(t0);
    });

    it('after a pinch the last finger does nothing until it lifts; pointercancel ends the gesture', () => {
        const { orb, el } = setup();
        touch(el, 'pointerdown', 1, 100, 100);
        touch(el, 'pointerdown', 2, 200, 100);
        touch(el, 'pointerup', 2, 200, 100);
        const az0 = orb.azimuth;
        touch(el, 'pointermove', 1, 160, 100);
        expect(orb.azimuth).toBe(az0);
        touch(el, 'pointercancel', 1, 160, 100);
        expect(orb.activeTouchCount).toBe(0);
    });

    it('a finger that landed while DISABLED (gizmo drag) still counts: re-enabled + 2nd finger = two-finger gesture', () => {
        const { orb, el, cam } = setup();
        orb.enabled = false;
        touch(el, 'pointerdown', 1, 100, 100);
        orb.enabled = true;
        touch(el, 'pointerdown', 2, 200, 100);
        expect(orb.isTouchGesturing).toBe(true);
        const t0 = tgt(cam);
        touch(el, 'pointermove', 1, 130, 100);
        expect(tgt(cam)).not.toEqual(t0);
    });

    it('double-tap fires onDoubleTap; two far-apart taps or a drag do not', () => {
        const { orb, el } = setup();
        const taps: [number, number][] = [];
        orb.onDoubleTap = (x, y) => taps.push([x, y]);
        touch(el, 'pointerdown', 1, 100, 100); touch(el, 'pointerup', 1, 100, 100);
        touch(el, 'pointerdown', 2, 104, 102); touch(el, 'pointerup', 2, 104, 102);
        expect(taps).toEqual([[104, 102]]);
        touch(el, 'pointerdown', 3, 100, 100); touch(el, 'pointerup', 3, 100, 100);
        touch(el, 'pointerdown', 4, 400, 300); touch(el, 'pointerup', 4, 400, 300);   // too far apart
        touch(el, 'pointerdown', 5, 400, 300); touch(el, 'pointermove', 5, 440, 300); touch(el, 'pointerup', 5, 440, 300);   // a drag
        expect(taps.length).toBe(1);
    });
});

describe('OrbitController — a finger a tool CLAIMED (Grease Pencil / surface paint stroke)', () => {
    /** A capture-phase tool registered before the controller: it claims every touch press (pointer-claims). */
    function claimedSetup(cfg: ConstructorParameters<typeof OrbitController>[1] = {}) {
        const cam = new Camera3D({ position: [0, 0, 5], target: [0, 0, 0], sceneRadius: 10 });
        const orb = new OrbitController(cam, { enableDamping: false, ...cfg });
        const { el } = fakeCanvas();
        el.addEventListener('pointerdown', (e) => { if ((e as unknown as PointerEvent).pointerType === 'touch') claimPointerEvent(e); });
        orb.attach(el);
        return { cam, orb, el };
    }

    for (const scheme of [{}, { freeLookNav: true }] as const) {
        it(`one claimed finger neither orbits nor looks (${'freeLookNav' in scheme ? 'freeLookNav' : 'classic'}), and never double-taps`, () => {
            const { orb, el, cam } = claimedSetup(scheme);
            const taps: number[] = [];
            orb.onDoubleTap = () => taps.push(1);
            const az0 = orb.azimuth, p0 = pos(cam);
            touch(el, 'pointerdown', 1, 100, 100);
            touch(el, 'pointermove', 1, 160, 130);
            touch(el, 'pointerup', 1, 160, 130);
            expect(orb.azimuth).toBe(az0);
            expect(pos(cam)).toEqual(p0);
            touch(el, 'pointerdown', 1, 100, 100); touch(el, 'pointerup', 1, 100, 100);
            touch(el, 'pointerdown', 1, 101, 100); touch(el, 'pointerup', 1, 101, 100);
            expect(taps).toEqual([]);
        });
    }

    it('a second finger still pinches / pans (two fingers navigate while the pencil is out)', () => {
        const { orb, el, cam } = claimedSetup();
        touch(el, 'pointerdown', 1, 100, 100);
        touch(el, 'pointerdown', 2, 200, 100);
        expect(orb.isTouchGesturing).toBe(true);
        const t0 = tgt(cam);
        touch(el, 'pointermove', 1, 130, 100);
        touch(el, 'pointermove', 2, 230, 100);
        expect(tgt(cam)).not.toEqual(t0);
    });

    it('the Navigate lock still orbits with one finger', () => {
        const { orb, el } = claimedSetup();
        orb.touchNavLock = true;
        const az0 = orb.azimuth;
        touch(el, 'pointerdown', 1, 100, 100);
        touch(el, 'pointermove', 1, 140, 100);
        expect(orb.azimuth).not.toBe(az0);
    });
});

