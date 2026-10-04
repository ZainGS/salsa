import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';

// bug-hunt 2026-10-01 follow-ups (docs/bug-hunt-2026-10-01.md) — WorldManager seams.

/** A recording scene: every unknown member is a no-op function; `live` is the global look the renderer holds. */
function scene(live: Record<string, unknown>): unknown {
    const base: Record<string, unknown> = {
        getGlobalScene3DSettings: () => JSON.parse(JSON.stringify(live)),
        getPostProcessing3D: () => live.postProcess,
        findExistingCityContainer: () => null, createCityContainer: () => ({ children: [] }),
        getAllMeshes: () => [], shadowsEnabled: false,
    };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}
type Priv = { _cityMode: boolean; _snapshotGlobalLighting(): void; _preCityCascades: unknown };

describe('D-P1 — a save in City mode keeps the document base look', () => {
    it('overlayPreCityState swaps the city-scoped keys for the pre-city snapshots', () => {
        const base = {
            lighting: { directional: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }, ambient: { color: [1, 1, 1], intensity: 0.3 } },
            fog: { enabled: false }, bg: { mode: 'solid' }, shadows: { enabled: false, mapSize: 1024, halfExtent: 5, bias: 0.001 },
            ssao: { enabled: false }, edgeOutlines: null, shadowTint: null, heightFog: [0, 0, 1, 0.05],
            postProcess: { bloom: { enabled: false } }, snap: 'none', projection: 'perspective',
        };
        const live: Record<string, unknown> = JSON.parse(JSON.stringify(base));
        const w = new WorldManager(scene(live) as never);
        const p = w as unknown as Priv;
        // enter a city session: snapshot first, then the city writes its own look into the live uniforms
        p._snapshotGlobalLighting();
        p._cityMode = true;
        p._preCityCascades = { count: 0 };
        w.setCinematicGrade(true);   // captures the host post stack
        live.lighting = { directional: { direction: [1, -0.3, 0], color: [1, 0.6, 0.3], intensity: 2.5 }, ambient: { color: [0.2, 0.2, 0.5], intensity: 0.1 } };
        live.fog = { enabled: true }; live.ssao = { enabled: true }; live.edgeOutlines = { color: [0, 0, 0, 1] };
        live.shadows = { enabled: true, mapSize: 2048, halfExtent: 40, bias: 0.002, cascades: { count: 3 } };
        live.postProcess = { bloom: { enabled: true, intensity: 2 } };
        live.snap = 'grid';   // a NON-city key edited in City mode is the document's own and must survive

        const saved = w.overlayPreCityState(JSON.parse(JSON.stringify(live))) as unknown as typeof base & { shadows: { cascades: unknown } };
        expect(saved.lighting).toEqual(base.lighting);
        expect(saved.fog).toEqual(base.fog);
        expect(saved.ssao).toEqual(base.ssao);
        expect(saved.edgeOutlines).toBeNull();
        expect(saved.shadows.halfExtent).toBe(5);
        expect(saved.shadows.cascades).toEqual({ count: 0 });
        expect((saved.postProcess as { bloom: { enabled: boolean } }).bloom.enabled).toBe(false);
        expect(saved.snap).toBe('grid');
    });

    it('outside a city session the settings come back unchanged', () => {
        const live = { lighting: { a: 1 }, postProcess: { b: 2 } };
        const w = new WorldManager(scene(live) as never);
        expect(w.overlayPreCityState(live as never)).toEqual(live);
    });
});

describe('D-P3 — a document load forgets the previous city LOOK', () => {
    const LOOK = ['_cityTransform', '_timeOfDay', '_overrideGlobalLighting', '_sunAzimuth', '_cycleOn', '_gradeKeys', '_skyKeys',
        '_shadowTints', '_lampColor', '_skyLighting', '_reflections', '_ssaoOn', '_outlinesCfg', '_scenePreset', '_groundFinish',
        '_paving', '_buildingMute', '_paintedClouds', '_shadowSoft', '_sunWarmth', '_shadowCascades', '_shadowNearM', '_keyFill',
        '_aerialHazeAmt', '_heightFog', '_groundContact', '_groundContactStrength', '_skyDome'];
    it('clearForDocumentLoad resets every look field to the constructor defaults', () => {
        const fresh = new WorldManager(scene({}) as never) as unknown as Record<string, unknown>;
        const w = new WorldManager(scene({}) as never);
        const m = w as unknown as Record<string, unknown>;
        // the previous doc's city look
        Object.assign(m, { _cityTransform: { x: 3, y: 1, z: 2, rx: 0, ry: 1, rz: 0 }, _timeOfDay: 0.8, _overrideGlobalLighting: false, _sunAzimuth: 2,
            _cycleOn: true, _lampColor: [0, 1, 0], _skyLighting: true, _reflections: true, _ssaoOn: true, _outlinesCfg: { color: [0, 0, 0, 1], threshold: 0.2 },
            _scenePreset: 'dusk', _groundFinish: 'clean', _paving: 'tiles', _buildingMute: 0.5, _paintedClouds: true, _shadowSoft: 3, _sunWarmth: 0.7,
            _shadowCascades: 3, _shadowNearM: 40, _keyFill: 0.6, _aerialHazeAmt: 0.4, _heightFog: 0.3, _groundContact: false, _groundContactStrength: 0.1,
            _skyDome: null });
        (m._gradeKeys as Record<string, { vignette: number }>).noon.vignette = 9;
        (m._skyKeys as Record<string, { top: number[] }>).noon.top = [9, 9, 9];
        (m._shadowTints as Record<string, number[]>).noon = [9, 9, 9];
        w.setSignalTiming({ green: 30 });
        w.clearForDocumentLoad();
        for (const k of LOOK) expect([k, m[k]]).toEqual([k, fresh[k]]);
        expect(w.signalTiming).toEqual((fresh as unknown as WorldManager).signalTiming);
    });
});

describe('D-W3 — clear / exit cancels the centre worker job', () => {
    it('_abortAsync cancels an in-flight centre build at the job service', () => {
        const w = new WorldManager(scene({}) as never);
        const calls: string[] = [];
        Object.assign(w as unknown as Record<string, unknown>, {
            _tilePool: { cancelSelective: () => calls.push('selective'), cancelCentre: () => calls.push('centre') },
            _asyncW: { merged: {}, t0: 0, ctx: null },
        });
        w.clear();
        expect(calls).toContain('centre');
    });

    it('the centre job kind recycles its worker when cancelled while running', async () => {
        const { registerWorldLane } = await import('../workers/world-lane');
        const { WORLD_JOB } = await import('../workers/world-jobs');
        const kinds: Record<string, { terminateOnCancel?: boolean }> = {};
        registerWorldLane({ registerLane() {}, hasKind: () => false, registerKind: (s: { kind: string; terminateOnCancel?: boolean }) => { kinds[s.kind] = s; } } as never);
        expect(kinds[WORLD_JOB.centre].terminateOnCancel).toBe(true);
        expect(kinds[WORLD_JOB.tile].terminateOnCancel).toBeFalsy();
    });
});

describe('D-W5 — zoom LOD never re-shows statics the live sim replaced', () => {
    it('showing PROPS_LOD keeps the raised static crossing arm hidden while traffic runs', () => {
        const w = new WorldManager(scene({}) as never);
        const m = w as unknown as { _groups: unknown[]; _traffic: { staticsHidden: boolean }; _applyLOD(re: RegExp, show: boolean): void };
        const staticArm = { name: 'world:local-xing-arm', visible: false };
        const liveArm = { name: 'world:local-xing-arm-live-0', visible: false };
        const bench = { name: 'world:bench', visible: false };
        m._groups.push({ name: 'World Local Line', visible: true, children: [staticArm, liveArm, bench] });
        m._traffic.staticsHidden = true;
        const re = (WorldManager as unknown as { PROPS_LOD: RegExp }).PROPS_LOD;
        m._applyLOD(re, true);
        expect(staticArm.visible).toBe(false);
        expect(liveArm.visible).toBe(true);
        expect(bench.visible).toBe(true);
        m._traffic.staticsHidden = false;   // traffic off → the static arm is the only arm again
        m._applyLOD(re, true);
        expect(staticArm.visible).toBe(true);
    });
});

describe('D-W6 — streamed tiles move the mesh-set epoch (signal / crossing-lamp rescans)', () => {
    it('a tile landing or being disposed bumps _meshSetEpoch (not the LOD _sceneEpoch)', () => {
        const added: unknown[] = [];
        const live: Record<string, unknown> = {};
        const sc = scene(live) as Record<string, unknown>;
        const w = new WorldManager(new Proxy({}, { get: (_t, k: string) => k === 'addFlatColorMeshGroup'
            ? (name: string) => { const g = { name, children: [{ name: 'world:signal-red-0a', visible: true }] }; added.push(g); return g; }
            : (sc as Record<string, unknown>)[k] }) as never);
        const m = w as unknown as { _meshSetEpoch: number; _sceneEpoch: number; _assembleTile(g: unknown[], full: boolean): unknown[]; _disposeTileGroups(g: unknown[], key?: string): void };
        const e0 = m._meshSetEpoch, s0 = m._sceneEpoch;
        const out = m._assembleTile([{ name: 'World Signals', layers: [{ name: 'world:signal-red-0a', color: [1, 0, 0], geometry: { vertices: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) } }] }], false);
        expect(out.length).toBe(1);
        const e1 = m._meshSetEpoch;
        expect(e1).toBeGreaterThan(e0);
        expect(m._sceneEpoch).toBe(s0);   // the LOD epoch stays put (scoped LOD apply — see _addTracked)
        m._disposeTileGroups(out);
        expect(m._meshSetEpoch).toBeGreaterThan(e1);
    });
});
