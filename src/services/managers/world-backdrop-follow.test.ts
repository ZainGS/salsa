import { describe, it, expect, afterEach } from 'vitest';
import { WorldManager } from './world-manager';

// Engine-roadmap step 3: the world-extent backdrop (apron / void grid / border glow) is rebuilt around the tile window's
// focus tile — a selective-group build moved by whole tiles before the drape — instead of staying around the origin.
type G = { name: string; visible: boolean; children: unknown[]; parent?: unknown };
function scene(): unknown {
    const base: Record<string, unknown> = {
        findExistingCityContainer: () => null, createCityContainer: () => ({ children: [] }),
        getAllMeshes: () => [], shadowsEnabled: false,
        removeFlatColorMeshGroup: (g: G) => { g.parent = null; }, reattachFlatColorMeshGroup: (g: G) => { g.parent = 'city'; },
        getPlayerFeet3D: () => null,
    };
    return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}
const SPAN = 20;
const cam = (x: number, z: number) => ({ position: [x, 30, z], target: [x, 0, z], mode: 'perspective', orthoSize: 1, getViewProjectionMatrix: () => new Float32Array(16) });
const g = globalThis as { requestAnimationFrame?: unknown };
const hadRaf = 'requestAnimationFrame' in g;
afterEach(() => { WorldManager.STEP3.backdropFollowsWindow = true; WorldManager.STEP3B.scopedBackdropLod = true; if (!hadRaf) delete g.requestAnimationFrame; });

function world() {
    g.requestAnimationFrame ??= () => 0;
    const w = new WorldManager(scene() as never) as unknown as Record<string, any>;
    const params = { worldMode: 'tiled', tileDetail: 'full', radius: 10, tileRadius: 0, groundY: 0 };
    w._params = params; w._cityContainer = { children: [] }; w._outsideTiles = 'none';
    w._groups = [{ name: 'World Layout', visible: true, children: [] }, { name: 'World Apron', visible: true, children: [] }];
    w._graph = { params, border: [], bounds: { min: [-10, -10], max: [10, 10] } };
    w._workersEnabled = true;
    const reqs: any[] = [];
    w._ensureTilePool = () => ({ buildGroups: (req: any, key: string, mode: string, quiet: boolean) => { reqs.push({ req, key, quiet }); return Promise.resolve({ groups: [], patch: [] }); } });
    const keys = (x: number, z: number) => w._windowTileKeys(params, cam(x, z), SPAN);
    return { w, reqs, keys };
}

describe('step 3: the backdrop follows the tile window', () => {
    it('a new focus tile rebuilds the backdrop around it (quiet worker job, moved by whole tiles)', () => {
        const { w, reqs, keys } = world();
        keys(1, 1);
        expect(reqs.length).toBe(0);                    // over the origin: nothing to move
        keys(3 * SPAN, -2 * SPAN);
        expect(reqs.length).toBe(1);
        expect(reqs[0].req.offset).toEqual([60, -40]);
        expect(reqs[0].req.names).toEqual(['World Apron', 'World Void Grid', 'World Border Glow']);
        expect(reqs[0].quiet).toBe(true);
        expect(reqs[0].req.graph.border).toEqual([[10, 10], [-10, 10], [-10, -10], [10, -10]]);   // built at the origin
        expect(w.getBackdropCentre()).toEqual([60, -40]);
        keys(3 * SPAN + 1, -2 * SPAN);                  // same tile: no rebuild
        expect(reqs.length).toBe(1);
        keys(0, 0);                                     // back home
        expect(reqs[1].req.offset).toEqual([0, 0]);
    });
    it('switch off: the backdrop stays around the origin', () => {
        WorldManager.STEP3.backdropFollowsWindow = false;
        const { reqs, keys } = world();
        keys(5 * SPAN, 0);
        expect(reqs.length).toBe(0);
    });
});

describe('step 3: ortho centres the window on the view centre', () => {
    it('an oblique ortho camera far off along its axis: the window is around the target, not the eye', () => {
        const { w } = world();
        WorldManager.STEP3.backdropFollowsWindow = false;
        const ortho = { position: [-100, 80, -100], target: [2 * SPAN, 0, 0], mode: 'orthographic', orthoSize: 5, getViewProjectionMatrix: () => new Float32Array(16) };
        w._windowTileKeys(w._params, ortho, SPAN);
        expect(w._focusTile).toEqual([2, 0]);
        WorldManager.STEP3.orthoViewCentre = false;
        w._focusTile = null;
        w._windowTileKeys(w._params, ortho, SPAN);
        expect(w._focusTile).toEqual([-5, -5]);   // the old rule: the tile under the eye
        WorldManager.STEP3.orthoViewCentre = true;
    });
    it('step 3b scopedBackdropLod: the swap applies the LOD to the new groups only (no whole-world epoch bump)', async () => {
        for (const scoped of [true, false]) {
            WorldManager.STEP3B.scopedBackdropLod = scoped;
            const { w, keys } = world();
            g.requestAnimationFrame = (cb: (t: number) => void) => { setTimeout(() => cb(0), 0); return 1; };
            const geometry = { vertices: new Float32Array(36), indices: new Uint32Array([0, 1, 2]) };
            w._ensureTilePool = () => ({ buildGroups: () => Promise.resolve({ groups: [{ name: 'World Apron', layers: [{ name: 'apron', geometry, color: [1, 1, 1] }] }], patch: [] }) });
            w.scene3d.addFlatColorMeshGroup = (name: string) => ({ name, visible: true, children: [{ name: 'apron', visible: false }] });
            const scopedCalls: string[] = [];
            const orig = w._applyLodToGroup.bind(w);
            w._applyLodToGroup = (grp: G) => { scopedCalls.push(grp.name); orig(grp); };
            const e0 = w._sceneEpoch;
            keys(3 * SPAN, 0);
            for (let i = 0; i < 50 && !w._groups.some((x: G) => x.name === 'World Apron' && x.children.length); i++) await new Promise(r => setTimeout(r, 5));
            const apron = w._groups.find((x: G) => x.name === 'World Apron' && x.children.length);
            expect(apron).toBeTruthy();
            expect((apron.children[0] as G).visible).toBe(true);
            if (scoped) { expect(w._sceneEpoch).toBe(e0); expect(scopedCalls).toEqual(['World Apron']); }
            else { expect(w._sceneEpoch).toBe(e0 + 1); expect(scopedCalls).toEqual([]); }
        }
    });
});
