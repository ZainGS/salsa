import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorldManager } from './world-manager';
import { buildCentreGroups } from '../../world/centre-build';
import type { LayoutParams } from '../../world';
import type { TileLayerGroup } from '../../world/tile-build';

// performance-plan P5 follow-ups:
//  P5.W1 the FIRST city (enterCityMode with no city) builds asynchronously: the call returns a layout-only graph at
//       once, the City-mode setup is deferred to the reveal swap, an updateCity issued meanwhile joins (same params)
//       or supersedes (merged) the in-flight build, and leaving the mode before the reveal cancels the setup.
//  P5.W2 TILED worlds build their centre through the async machinery too, landing the same centre as the sync build.
//  P5.W3 the glow pass classifies names once and an incremental (sliced) pass lands the same materials as a sync one.

const P: Partial<LayoutParams> = { seed: 5, radius: 6, traffic: false };   // (the recording scene has no real meshes for movers)

type Child = { name: string; visible: boolean; material: Record<string, unknown> & { diffuse: { r: number; g: number; b: number; a: number } }; materialDirty?: boolean };
type Rec = { name: string; layers: TileLayerGroup['layers']; children: Child[] };
function scene(log: Rec[], calls: string[]): unknown {
    const base: Record<string, unknown> = {
        getPostProcessing3D: () => ({}), findExistingCityContainer: () => null, createCityContainer: () => ({ children: [] }),
        addFlatColorMeshGroup: (name: string, layers: TileLayerGroup['layers']) => {
            const g: Rec = { name, layers, children: layers.map(L => ({ name: L.name, visible: true,
                material: { diffuse: { r: L.color[0], g: L.color[1], b: L.color[2], a: 1 }, patternMode: L.pattern?.mode } })) };
            log.push(g);
            return g;
        },
        getAllMeshes: () => [],
        enterCityMode3D: () => { calls.push('enterCityMode3D'); },
        exitCityMode3D: () => { calls.push('exitCityMode3D'); },
        shadowsEnabled: false,
    };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}

/** Layer content independent of how a build partitioned it (see world-jobs.test.ts `content`). */
function content(groups: Array<{ name: string; layers: TileLayerGroup['layers'] }>): Record<string, string> {
    const acc = new Map<string, number>();
    for (const g of groups) for (const L of g.layers) {
        if (/contact-shadow/.test(L.name) || (L as { crowdAux?: boolean }).crowdAux) continue;   // (P12: the instanced crowd's AUX layers never become meshes)
        // per (group, layer): triangles × copies — survives spatial chunking (cells split the triangle list) and the
        // reassembly's instance slicing; any missing / extra / different geometry still changes it
        const inst = (L as { instances?: unknown[] }).instances;
        const tris = L.geometry.indices ? L.geometry.indices.length / 3 : L.geometry.vertices.length;
        const k = `${g.name}|${L.name}`;
        acc.set(k, (acc.get(k) ?? 0) + tris * (inst ? inst.length : 1));
    }
    return Object.fromEntries([...acc].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, String(v)]));
}

// A setTimeout-backed frame loop (the async paths need rAF); `live` stops new frames before the globals go away.
let live = true;
const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
beforeAll(() => {
    live = true;
    g.requestAnimationFrame = (cb: (t: number) => void) => live ? (setTimeout(() => cb(performance.now()), 0) as unknown as number) : 0;
    g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
});
afterAll(async () => {
    live = false;
    await new Promise(r => setTimeout(r, 50));
    delete g.requestAnimationFrame; delete g.cancelAnimationFrame;
});
const settle = async (w: WorldManager): Promise<void> => {
    for (let i = 0; i < 2000 && w.isBuildingCity(); i++) await new Promise(r => setTimeout(r, 2));
    expect(w.isBuildingCity()).toBe(false);
};
const groups = (w: WorldManager): Rec[] => (w as unknown as { _groups: Rec[] })._groups;

describe('P5.W1 first city — async enterCityMode', () => {
    it('returns a layout-only graph at once and defers the City-mode setup to the reveal', async () => {
        const log: Rec[] = [], calls: string[] = [];
        const w = new WorldManager(scene(log, calls) as never);
        const states: boolean[] = [];
        w.onCityBuildStateChange.subscribe(({ building, reason }) => { states.push(building); if (building) expect(reason).toBe('load'); });
        const preview = w.enterCityMode({ ...P });
        expect(w.hasWorld).toBe(false);
        expect(w.isBuildingCity()).toBe(true);
        expect(calls).toEqual([]);                       // nothing applied over the empty scene
        expect(w.regions.length).toBe(preview.regions.length);   // the host's district list is available right away
        expect(preview.params.seed).toBe(5);
        await settle(w);
        expect(calls).toEqual(['enterCityMode3D']);      // the setup ran exactly once, at the reveal
        expect(w.hasWorld).toBe(true);
        expect(w.cityMode).toBe(true);
        expect(w.graph!.regions.map(r => r.id)).toEqual(preview.regions.map(r => r.id));
        expect(states).toEqual([true, false]);

        // same city as the classic synchronous build
        const slog: Rec[] = [];
        const s = new WorldManager(scene(slog, []) as never);
        s.generateWorld({ ...P });
        expect(content(groups(w))).toEqual(content(groups(s)));
        w.exitCityMode(); w.clear(); s.clear();
    }, 120000);

    it('an updateCity with the SAME params joins the in-flight build; a different one supersedes (merged)', async () => {
        const log: Rec[] = [], calls: string[] = [];
        const w = new WorldManager(scene(log, calls) as never);
        w.enterCityMode({ ...P });
        const first = (w as unknown as { _async: unknown })._async;
        w.updateCity({ ...P });
        expect((w as unknown as { _async: unknown })._async).toBe(first);   // not restarted
        w.updateCity({ seed: 9 });
        expect((w as unknown as { _async: unknown })._async).not.toBe(first);
        await settle(w);
        expect(w.params!.seed).toBe(9);
        expect(w.params!.radius).toBe(6);                // merged onto the first build's params
        expect(calls).toEqual(['enterCityMode3D']);
        w.exitCityMode(); w.clear();
    }, 120000);

    it('leaving City mode before the reveal cancels the deferred setup (the city still lands, placed)', async () => {
        const log: Rec[] = [], calls: string[] = [];
        const w = new WorldManager(scene(log, calls) as never);
        w.enterCityMode({ ...P });
        w.exitCityMode();
        await settle(w);
        expect(calls).toEqual([]);
        expect(w.cityMode).toBe(false);
        expect(w.hasWorld).toBe(true);
        w.clear();
    }, 120000);

    it('bug-hunt 2026-10-01: a document load mid-first-build drops it (nothing of doc A lands in doc B) and leaves City mode', async () => {
        const log: Rec[] = [], calls: string[] = [];
        const w = new WorldManager(scene(log, calls) as never);
        w.enterCityMode({ ...P });
        expect(w.isBuildingCity()).toBe(true);
        w.clearForDocumentLoad();                         // the restore's forget-the-previous-doc step
        expect(w.cityMode).toBe(false);
        expect(w.isBuildingCity()).toBe(false);
        const before = log.length;
        await new Promise(r => setTimeout(r, 300));      // let any stale async step run
        expect(log.length).toBe(before);                 // no doc-A groups were staged into doc B
        expect(w.hasWorld).toBe(false);
        expect(w.params).toBeNull();
        expect(calls).toEqual([]);                        // the deferred City-mode setup never ran
    }, 120000);

    it('headless (no frame loop) keeps the synchronous build', () => {
        live = false;
        const raf = g.requestAnimationFrame;
        delete g.requestAnimationFrame;
        try {
            const calls: string[] = [];
            const w = new WorldManager(scene([], calls) as never);
            const graph = w.enterCityMode({ ...P });
            expect(w.hasWorld).toBe(true);
            expect(w.graph).toBe(graph);
            expect(calls).toEqual(['enterCityMode3D']);
            w.exitCityMode(); w.clear();
        } finally { g.requestAnimationFrame = raf; live = true; }
    }, 120000);
});

describe('P5.W2 tiled centre — async build == sync build', () => {
    const T: Partial<LayoutParams> = { ...P, worldMode: 'tiled', tileRadius: 1, tileDetail: 'focus' };
    const centre = (w: WorldManager): Rec[] => {
        const tiles = (w as unknown as { _tileGroups: Set<Rec> })._tileGroups;
        return groups(w).filter(x => !tiles.has(x));
    };
    it('main-thread staged async centre lands the sync centre (and the same graph)', async () => {
        live = false;
        const raf = g.requestAnimationFrame;
        delete g.requestAnimationFrame;
        let syncContent: Record<string, string>, syncGraph: string;
        try {
            const s = new WorldManager(scene([], []) as never);
            s.generateWorld({ ...T });
            syncContent = content(centre(s)); syncGraph = JSON.stringify(s.graph);
            const a = new WorldManager(scene([], []) as never);
            a._forceAsyncFull = true;
            a.generateWorld({ ...P });                    // an existing diorama → updateCity goes tiled-async
            a.updateCity({ worldMode: 'tiled', tileRadius: 1, tileDetail: 'focus' });
            expect(a.params!.worldMode).toBe('tiled');
            expect(content(centre(a))).toEqual(syncContent);
            expect(JSON.parse(JSON.stringify(a.graph))).toEqual(JSON.parse(syncGraph));   // (params key order differs: merged onto the diorama's)
            s.clear(); a.clear();
        } finally { g.requestAnimationFrame = raf; live = true; }
    }, 120000);
    it('the worker centre job (tiled) builds the same centre as the sync path', () => {
        live = false;
        const raf = g.requestAnimationFrame;
        delete g.requestAnimationFrame;
        try {
            const s = new WorldManager(scene([], []) as never);
            s.setCullChunks(false);
            s.generateWorld({ ...T });
            const res = buildCentreGroups({ ...T }, { parkedTrain: true, activeRegions: null, chunk: null, contact: null });
            // (World Sign Text is rasterised main-side after either build — not part of the centre job)
            expect(content(res.groups)).toEqual(content(centre(s).filter(x => x.name !== 'World Sign Text')));
            expect(res.centreFrame).toBeTruthy();
            // the widened frame + the street plan match (lots get main-side text-sign claims after either build)
            for (const k of ['border', 'bounds', 'roads', 'blocks', 'regions'] as const) expect(JSON.stringify(res.graph[k])).toBe(JSON.stringify(s.graph![k]));
            s.clear();
        } finally { g.requestAnimationFrame = raf; live = true; }
    }, 120000);
});

describe('P5.W3 glow pass — cached traits + slicing', () => {
    it('a sliced incremental pass lands the same materials as a one-shot pass', async () => {
        const snap = (w: WorldManager): string => JSON.stringify(groups(w).map(x => x.children.map(c => [c.visible, c.material.emissive, c.material.roughness, c.material.patternSpacing])));
        const run = async (sliced: boolean): Promise<string> => {
            const w = new WorldManager(scene([], []) as never);
            w.generateWorld({ ...P });
            const m = w as unknown as { _applyGlow(n: number): void; _lastGlowNight: number; _glowPass: unknown; _glowStats: { mode: string; slices: number } };
            m._applyGlow(0.5);                          // throttle baseline (generateWorld left it forced)
            if (!sliced) m._lastGlowNight = -1;          // forced → one shot
            const old = WorldManager.GLOW_SLICE_MS;
            WorldManager.GLOW_SLICE_MS = 0;              // slice every 64 meshes
            try {
                m._applyGlow(0.8);
                for (let i = 0; i < 5000 && m._glowPass; i++) await new Promise(r => setTimeout(r, 0));
            } finally { WorldManager.GLOW_SLICE_MS = old; }
            expect(m._glowStats.mode).toBe(sliced ? 'sliced' : 'sync');
            if (sliced) expect(m._glowStats.slices).toBeGreaterThan(1);
            const out = snap(w);
            w.clear();
            return out;
        };
        expect(await run(true)).toBe(await run(false));
    }, 120000);
});
