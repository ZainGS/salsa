import { describe, it, expect, beforeEach } from 'vitest';
import { EphemeraOverlay, type EphemeraOverlayHost } from './ephemera-overlay';
import type { EphemeraService } from './ephemera-service';
import type { EphemeraPlacement } from './ephemera-types';
import type { ManagerContext } from '../managers/manager-context';

// ── Fakes ─────────────────────────────────────────────────────────────
class FakeEphemera {
    placements = new Map<string, EphemeraPlacement[]>();
    updates: { layerId: string; id: string; updates: Partial<EphemeraPlacement> }[] = [];
    getAllPlacements() { return this.placements; }
    getPlacementsForLayer(id: string) { return this.placements.get(id) ?? []; }
    updatePlacement(layerId: string, id: string, updates: Partial<EphemeraPlacement>) {
        this.updates.push({ layerId, id, updates });
        const p = this.placements.get(layerId)?.find(x => x.id === id);
        if (p) Object.assign(p, updates);
        return !!p;
    }
    getDefaultParams() { return {}; }
    generate() { return '<svg width="160" height="160"></svg>'; }
}

function pl(over: Partial<EphemeraPlacement>): EphemeraPlacement {
    return { id: 'p', layerId: 'L1', typeId: 't', params: {}, svg: '',
        x: 0, y: 0, width: 0.4, height: 0.4, rotation: 0, opacity: 1, visible: true, ...over };
}

let renderCalls: number;
let dirtyCalls: string[];
let eph: FakeEphemera;
let layers: { id: string; visible: boolean }[];

function makeOverlay() {
    renderCalls = 0; dirtyCalls = []; eph = new FakeEphemera();
    layers = [{ id: 'L1', visible: true }];
    const ctx = {
        interactionService: {
            getWorldMatrix: () => new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            canvas: { width: 800, height: 600 },
        },
        rasterLayerManager: { getLayers: () => layers },
        scheduleRender: () => { renderCalls++; },
    } as unknown as ManagerContext;
    const host: EphemeraOverlayHost = {
        ephemera: eph as unknown as EphemeraService,
        markPackageVectorLayerDirty: (id) => { dirtyCalls.push(id); },
        meshEditFocusHidesContent: () => false,
    };
    return new EphemeraOverlay(ctx, host);
}

describe('EphemeraOverlay', () => {
    let ov: EphemeraOverlay;
    beforeEach(() => { ov = makeOverlay(); });

    it('tracks placement selection state', () => {
        expect(ov.getSelectedPlacement()).toBeNull();
        ov.selectPlacement('L1', 'p1');
        expect(ov.getSelectedPlacement()).toEqual({ layerId: 'L1', placementId: 'p1' });
        expect(renderCalls).toBe(1);
        ov.clearPlacementSelection();
        expect(ov.getSelectedPlacement()).toBeNull();
    });

    it('hit-tests placements topmost-first and respects visibility', () => {
        eph.placements.set('L1', [
            pl({ id: 'back',  x: 0, y: 0 }),
            pl({ id: 'front', x: 0, y: 0 }),   // overlaps → drawn last → topmost
        ]);
        // point inside both → returns the topmost (last in array)
        expect(ov.hitTestEphemeraPlacement(0.2, 0.2)?.placementId).toBe('front');
        // point outside both → null
        expect(ov.hitTestEphemeraPlacement(5, 5)).toBeNull();
        // hidden layer → nothing hits
        layers[0].visible = false;
        expect(ov.hitTestEphemeraPlacement(0.2, 0.2)).toBeNull();
    });

    it('hit-test is rotation-aware', () => {
        // A tall thin placement rotated 90° becomes wide+short — a point off its long axis
        // hits only because of the rotation.
        eph.placements.set('L1', [pl({ id: 'r', x: 0, y: 0, width: 0.1, height: 0.6, rotation: 90 })]);
        // center is (0.05, 0.3); rotated 90°, the box spans ±0.3 in x, ±0.05 in y about the center
        expect(ov.hitTestEphemeraPlacement(0.30, 0.30)?.placementId).toBe('r');   // far in x, on-axis in y → inside when rotated
        expect(ov.hitTestEphemeraPlacement(0.05, 0.55)).toBeNull();               // far in y → outside when rotated
    });

    it('applyPlacementResize pins the anchor and recomputes size', () => {
        eph.placements.set('L1', [pl({ id: 'p1', x: 0, y: 0, width: 0.4, height: 0.4 })]);
        // Drag the BR handle from anchor TL=(0,0) out to (0.6,0.6) → a 0.6×0.6 box anchored at origin.
        ov.applyPlacementResize('L1', 'p1', 'BR', 0, 0, 0.6, 0.6);
        const u = eph.updates.at(-1)!.updates;
        expect(u.width).toBeCloseTo(0.6, 6);
        expect(u.height).toBeCloseTo(0.6, 6);
        expect(u.x).toBeCloseTo(0, 6);
        expect(u.y).toBeCloseTo(0, 6);
        expect(dirtyCalls).toContain('L1');
        expect(renderCalls).toBe(1);
    });

    it('applyPlacementRotate updates rotation from angular delta', () => {
        eph.placements.set('L1', [pl({ id: 'p1', rotation: 0 })]);
        // center (0.2,0.2); start pointing +x (angle 0), drag to +y → +90° delta.
        ov.applyPlacementRotate('L1', 'p1', 0.2, 0.2, 0, 0, 0.2, 1.2);
        expect(eph.updates.at(-1)!.updates.rotation).toBeCloseTo(90, 4);
        expect(dirtyCalls).toContain('L1');
    });

    it('hitTestPlacementHandle finds the rotate + resize handles of the selected placement', () => {
        eph.placements.set('L1', [pl({ id: 'p1', x: 0, y: 0, width: 0.4, height: 0.4, rotation: 0 })]);
        expect(ov.hitTestPlacementHandle(0, 0)).toBeNull();   // nothing selected yet
        ov.selectPlacement('L1', 'p1');
        // TL resize handle sits at the top-left corner world pos (0,0)
        const tl = ov.hitTestPlacementHandle(0, 0);
        expect(tl?.kind).toBe('resize');
        // Rotation handle sits above the top edge; center (0.2,0.2), ~0.247 above → y ≈ -0.047
        const rot = ov.hitTestPlacementHandle(0.2, -0.0467);
        expect(rot?.kind).toBe('rotate');
    });
});
