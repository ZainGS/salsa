/**
 * mobile-parity 7.2: brush presets are DOCUMENT data (the document's brushes.json), but the engine's preset library
 * outlives every document and a load only MERGED into it — document A's custom brushes (and A's edits to a built-in)
 * appeared in document B and were written into B's next save. A document load now starts the library over.
 * Real RasterPaintEngine on the CPU mirror.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { createCpuDevice, installGpuGlobals } from '../cpu-gpu-mirror';
import { RasterPaintEngine, createDefaultPresets } from './raster-paint-engine';
import ShapeManager from '../../../services/shape-manager';

beforeAll(() => installGpuGlobals());
afterEach(() => { vi.restoreAllMocks(); });

function engine(): RasterPaintEngine {
    return new RasterPaintEngine(createCpuDevice().device, () => {});
}

/** A custom brush the user made in document A (a built-in with a new id + name). */
function customJson(id: string): string {
    const base = createDefaultPresets()[0];
    return JSON.stringify({ ...JSON.parse(JSON.stringify(base)), id, name: 'A only' });
}

describe('RasterPaintEngine.resetPresetsForDocumentLoad', () => {
    it('drops the previous document\'s custom presets and restores the built-ins as shipped', () => {
        const e = engine();
        const builtIns = e.getPresets().map(p => p.id);
        const first = builtIns[0];
        const shipped = JSON.stringify(e.getPreset(first));
        e.importPreset(customJson('brush_docA'));
        e.updatePreset(first, { name: 'Edited in A' });
        expect(e.getPreset('brush_docA')).toBeDefined();

        e.resetPresetsForDocumentLoad();

        expect(e.getPreset('brush_docA')).toBeUndefined();
        expect(e.getPresets().map(p => p.id)).toEqual(builtIns);
        expect(JSON.stringify(e.getPreset(first))).toBe(shipped);   // A's edit to a built-in is gone too
        expect(e.exportAllPresets()).not.toContain('brush_docA');        // ...so B's save never carries it
    });

    it('A → B: B shows only the built-ins + its OWN presets, and B\'s save writes only those', () => {
        const e = engine();
        e.importPreset(customJson('brush_docA'));                         // document A
        const docB = JSON.stringify([...createDefaultPresets(), JSON.parse(customJson('brush_docB'))]);
        e.resetPresetsForDocumentLoad();                                   // load B (the restore's first step)
        e.importPresets(docB);                                             // B's brushes.json
        const ids = e.getPresets().map(p => p.id);
        expect(ids).toContain('brush_docB');
        expect(ids).not.toContain('brush_docA');
        const saved = JSON.parse(e.exportAllPresets()) as { id: string }[];
        expect(saved.map(p => p.id)).not.toContain('brush_docA');
    });

    it('keeps the active brush when it is a built-in, else falls back to the first built-in', () => {
        const e = engine();
        const builtIns = e.getPresets().map(p => p.id);
        e.setActivePreset(builtIns[2]);
        e.resetPresetsForDocumentLoad();
        expect(e.getActivePresetId()).toBe(builtIns[2]);
        e.importPreset(customJson('brush_docA'));
        e.setActivePreset('brush_docA');
        e.resetPresetsForDocumentLoad();
        expect(e.getActivePresetId()).toBe(builtIns[0]);
    });
});

describe('the document load resets the brush library', () => {
    it('clearDocumentRegistriesForLoad (the top of every restore, incl. startBlankDocument) calls it', () => {
        const inert: unknown = new Proxy(function () { /* inert */ }, { get: (_t, k) => (k === 'then' ? undefined : inert), apply: () => inert });
        const reset = vi.fn();
        const t: Record<string, unknown> = {
            _uvSessions: new Map(), uvPaint: { isActive: () => false },
            getRasterPaintEngine: () => ({ resetPresetsForDocumentLoad: reset }),
        };
        const self = new Proxy(t, { get: (o, k) => (k in o ? o[k as string] : inert) });
        ShapeManager.prototype.clearDocumentRegistriesForLoad.call(self as never);
        expect(reset).toHaveBeenCalledTimes(1);
    });
});
