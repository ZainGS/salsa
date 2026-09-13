import { describe, it, expect } from 'vitest';
import { ShapeFactory } from './shape-factory';
import type { InteractionService } from '../../services/interaction-service';
import type { CacheService } from '../../services/cache-service';

// Minimal stubs — the ctor just stores these; the creators under test don't touch GPU.
const isvc = { getViewportCenter: () => [0, 0] } as unknown as InteractionService;
const csvc = {} as unknown as CacheService;

describe('ShapeFactory — vector-layer stamping (the choke point every 2D creation flows through)', () => {
    it('stamps the provider layer onto created shapes (facade, tools, and services all share this path)', () => {
        const f = new ShapeFactory(isvc, csvc);
        f.setLayerStampProvider(() => 'layer-A');
        const rect = f.createRectangle(0, 0, 10, 10, { r: 1, g: 1, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 1);
        const line = f.createLine(0, 0, 5, 5, { r: 0, g: 0, b: 0, a: 1 }, 1);
        const scribble = f.createScribble(0, 0, { r: 0, g: 0, b: 0, a: 1 }, 1);
        const poly = f.createRegularPolygon(0, 0, 5, 6, { r: 1, g: 1, b: 1, a: 1 }, { r: 0, g: 0, b: 0, a: 1 }, 1);
        expect(rect.layerId).toBe('layer-A');
        expect(line.layerId).toBe('layer-A');
        expect(scribble.layerId).toBe('layer-A');
        expect(poly.layerId).toBe('layer-A');
    });

    it('no provider / provider returns undefined → shapes stay unassigned (legacy behavior)', () => {
        const f = new ShapeFactory(isvc, csvc);
        expect(f.createLine(0, 0, 1, 1, { r: 0, g: 0, b: 0, a: 1 }, 1).layerId).toBeUndefined();
        f.setLayerStampProvider(() => undefined);   // doc has no vector layer at all
        expect(f.createLine(0, 0, 1, 1, { r: 0, g: 0, b: 0, a: 1 }, 1).layerId).toBeUndefined();
    });

    it('the provider is read PER CREATION (switching the active layer re-targets new shapes)', () => {
        const f = new ShapeFactory(isvc, csvc);
        let active = 'layer-A';
        f.setLayerStampProvider(() => active);
        const first = f.createLine(0, 0, 1, 1, { r: 0, g: 0, b: 0, a: 1 }, 1);
        active = 'layer-B';
        const second = f.createLine(0, 0, 1, 1, { r: 0, g: 0, b: 0, a: 1 }, 1);
        expect(first.layerId).toBe('layer-A');
        expect(second.layerId).toBe('layer-B');
    });
});
