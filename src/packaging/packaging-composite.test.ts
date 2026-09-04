import { describe, it, expect } from 'vitest';
import { PackagingComposite, type PackagingCompositeHost } from './packaging-composite';
import type { ManagerContext } from '../services/managers/manager-context';

// The compositor's real work (RasterCompositor passes, vector-proxy SVG rasterization, live-texture linking) needs a
// GPUDevice + DOM and is browser-verified. These pin the CPU-safe surface the god-object used to own inline: the
// accessors on empty state, and the no-device / unknown-package guards (nothing throws, nothing gets created).
function makeEnv({ device = null as unknown }: { device?: unknown } = {}) {
    const calls = { schedule: 0, linked: [] as string[], unlinked: [] as string[], syncAll: 0 };
    const layers = new Map<string, { type?: string; packageOwnerId?: string }>();
    const ctx = {
        rasterLayerManager: {
            getLayerById: (id: string) => layers.get(id) ?? null,
            getLayers: () => [...layers.keys()].map(id => ({ id, type: layers.get(id)?.type ?? 'layer' })),
        },
        webgpuRenderer: { getDevice: () => device, getIllustrationPixelSize: () => ({ w: 512, h: 512 }) },
        scheduleRender: () => { calls.schedule++; },
    } as unknown as ManagerContext;
    const host: PackagingCompositeHost = {
        liveTexture: { linkProvider: (id: string) => calls.linked.push(id), unlinkProvider: (id: string) => calls.unlinked.push(id), syncAll: () => { calls.syncAll++; } } as unknown as PackagingCompositeHost['liveTexture'],
        ephemera: { getPlacementsForLayer: () => [] } as unknown as PackagingCompositeHost['ephemera'],
    };
    return { pc: new PackagingComposite(ctx, host), calls, layers };
}

describe('PackagingComposite', () => {
    it('accessors are empty before anything is linked', () => {
        const { pc } = makeEnv();
        expect(pc.hasComposite('pkg')).toBe(false);
        expect(pc.getCompositeMgr('pkg')).toBeNull();
        expect(pc.getComposite('pkg')).toBeNull();
        expect(pc.getVectorProxy('layer')).toBeNull();
    });

    it('link is a no-op without a GPU device (nothing linked/created)', () => {
        const { pc, calls } = makeEnv({ device: null });
        pc.link('pkg', ['panel-1', 'panel-2'], () => ({ layerIds: [] }));
        expect(pc.hasComposite('pkg')).toBe(false);
        expect(calls.linked).toEqual([]);
    });

    it('vectorLayerDirty is a safe no-op for a layer not in any linked package stack', () => {
        const { pc } = makeEnv();
        expect(() => pc.vectorLayerDirty('orphan-layer')).not.toThrow();
    });

    it('unlink / recomposite / recompositeThrottled / dropVectorProxy on unknown ids are safe no-ops', () => {
        const { pc, calls } = makeEnv();
        expect(() => pc.unlink('nope')).not.toThrow();
        expect(() => pc.recomposite('nope')).not.toThrow();
        expect(() => pc.recompositeThrottled('nope')).not.toThrow();
        expect(() => pc.dropVectorProxy('nope')).not.toThrow();
        expect(calls.unlinked).toEqual([]);   // nothing was linked → nothing unlinked
    });
});
