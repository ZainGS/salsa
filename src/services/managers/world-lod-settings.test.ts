import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import { assignDrawDistances, cityDrawDistance, cityDrawDistanceBias, type DistanceTier } from './view-cull';
import {
  defaultCityLodSettings, sanitizeCityLodSettings, cityLodSettingsDiff, cityLodFamilies, scaleDistanceTiers,
  stampTwinDistances, collectCityLodStats, LodDebugTint, cityLodSettingsView,
} from './world-lod-settings';
import { PED_NEAR_M } from '../../world/pedestrians';
import { EDGE_CHIP_NEAR_M } from '../../world/meshbuild';

// docs/ui/performance.md §LOD settings — the City panel's Performance group.

const F = 10;
const fine = F * WorldManager.DIST_LOD_FINE;

describe('LOD families (data-driven over cityDistanceTiers)', () => {
  const fams = cityLodFamilies(WorldManager.cityDistanceTiers(1));
  const ids = fams.map(f => f.id);

  it('names every tier, with the families the panel asks for', () => {
    expect(fams.length).toBe(WorldManager.cityDistanceTiers(1).length);
    for (const id of ['cans', 'crowd', 'railFine', 'tiny', 'smallProps', 'poles', 'signText', 'signs', 'facade', 'roof', 'trees', 'parkedCars', 'vending', 'props', 'flatmap', 'contact'])
      expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);   // unique
    const trees = fams.find(f => f.id === 'trees')!;
    expect(trees.factor).toBeCloseTo(1.2);
    expect(trees.bias).toBe(1);
    expect(fams.find(f => f.id === 'crowd')!.bias).toBe(WorldManager.DIST_LOD_TINY_BIAS);
  });

  it('a tier added later appears by itself, under an id from its regex', () => {
    const t: DistanceTier[] = [...WorldManager.cityDistanceTiers(1), [/world:tree-far-|world:impostor/, 3]];
    const f = cityLodFamilies(t);
    expect(f[f.length - 1]).toMatchObject({ id: 'tree-far', factor: 3, bias: 1 });
  });

  it('the family split leaves every stamped distance and bias as before (first-match subsets)', () => {
    const tiers = WorldManager.cityDistanceTiers(F);
    const cases: [string, number, number][] = [
      ['world:ped-skin', fine, WorldManager.DIST_LOD_TINY_BIAS], ['world:traffic-walker-top', fine, WorldManager.DIST_LOD_TINY_BIAS],
      ['world:rail-fine-sleepers', fine, WorldManager.DIST_LOD_TINY_BIAS], ['world:util-wire', fine, WorldManager.DIST_LOD_TINY_BIAS],
      ['world:textsign-shop3', fine, 1], ['world:roadsign-stop', fine, 1], ['world:detail-juliet', fine, 1],
      ['world:tree-camphor-0:foliage:leaf', F * 1.2, 1], ['world:tree-grate', fine, WorldManager.DIST_LOD_TINY_BIAS],
      ['world:car-white', F * 1.2, 1], ['world:car-trim', fine, WorldManager.DIST_LOD_TINY_BIAS],
      ['world:vending-body', F * 1.2, 1], ['world:vending-stock-0', fine * WorldManager.DIST_LOD_CANS, WorldManager.DIST_LOD_TINY_BIAS],
      ['world:busstop', F * 1.2, 1], ['world:sidewalks', F * 1.4, 1], ['world:buildings', 0, 1],
    ];
    for (const [n, d, b] of cases) {
      expect(cityDrawDistance(n, tiers), n).toBeCloseTo(d);
      expect(cityDrawDistanceBias(n, tiers), n).toBe(b);
    }
  });
});

describe('LOD settings', () => {
  it('sanitize clamps, null resets a family, reset starts from the defaults', () => {
    let s = sanitizeCityLodSettings({ global: 99, families: { trees: 0.5, crowd: 1 }, zoom: { props: -1 }, shadow: { pcf: '3x3', slackTexels: 3.6 }, twins: { crowdM: 45 } });
    expect(s.global).toBe(8);
    expect(s.families).toEqual({ trees: 0.5 });
    expect(s.zoom.props).toBe(0.05);
    expect(s.shadow).toEqual({ pcf: '3x3', slackTexels: 4, quality: 'high' });
    expect(s.twins).toEqual({ crowdM: 45, chipsM: EDGE_CHIP_NEAR_M });
    s = sanitizeCityLodSettings({ families: { trees: null } }, s);
    expect(s.families).toEqual({});
    expect(sanitizeCityLodSettings({ reset: true }, s)).toEqual(defaultCityLodSettings());
    expect(sanitizeCityLodSettings('junk')).toEqual(defaultCityLodSettings());
  });

  it('the marker diff is null at the defaults and round-trips the changed fields (never the debug tint)', () => {
    expect(cityLodSettingsDiff(defaultCityLodSettings())).toBeNull();
    expect(cityLodSettingsDiff(sanitizeCityLodSettings({ debugTint: true }))).toBeNull();
    const s = sanitizeCityLodSettings({ aerialBias: false, families: { props: 2 }, zoom: { roof: 2 }, shadow: { pcf: '3x3' } });
    const d = cityLodSettingsDiff(s)!;
    expect(d).toEqual({ aerialBias: false, families: { props: 2 }, zoom: { roof: 2 }, shadow: { pcf: '3x3' } });
    expect(sanitizeCityLodSettings(JSON.parse(JSON.stringify(d)))).toEqual(s);
  });

  it('family multipliers scale only their tier and keep the bias / shadow-size elements', () => {
    const unit = WorldManager.cityDistanceTiers(1), fams = cityLodFamilies(unit);
    const tiers = WorldManager.cityDistanceTiers(F, 1 / 15);
    const s = sanitizeCityLodSettings({ families: { trees: 2, crowd: 0.5 } });
    const out = scaleDistanceTiers(tiers, fams, s);
    expect(cityDrawDistance('world:tree-zelkova', out)).toBeCloseTo(F * 1.2 * 2);
    expect(cityDrawDistance('world:ped-skin', out)).toBeCloseTo(fine * 0.5);
    expect(cityDrawDistance('world:busstop', out)).toBeCloseTo(F * 1.2);
    const crowd = out[fams.findIndex(f => f.id === 'crowd')];
    const before = tiers[fams.findIndex(f => f.id === 'crowd')];
    expect(crowd.length).toBe(before.length);
    expect(crowd.slice(2)).toEqual(before.slice(2));
    const leaf = { name: 'world:ped-skin', drawDistance: 0, drawDistanceBias: 1 };
    assignDrawDistances([leaf], out);
    expect(leaf.drawDistance).toBeCloseTo(fine * 0.5);
  });

  it('twin distances rescale from their built value (idempotent), crowd and chips apart', () => {
    const base = new WeakMap<object, [number, number]>();
    const ped = { name: 'world:ped-red', lodTwinRole: 1, lodTwinDist: 2 };
    const chip = { name: 'world:stairs', lodTwinRole: 2, lodTwinDist: 1.2 };
    const root = { name: 'g', children: [ped, { name: 'h', children: [chip] }] };
    const s = sanitizeCityLodSettings({ twins: { crowdM: PED_NEAR_M * 2, chipsM: EDGE_CHIP_NEAR_M / 2 } });
    expect(stampTwinDistances([root], s, base)).toBe(2);
    stampTwinDistances([root], s, base);   // again: no compounding
    expect(ped.lodTwinDist).toBeCloseTo(4);
    expect(chip.lodTwinDist).toBeCloseTo(0.6);
    stampTwinDistances([root], defaultCityLodSettings(), base);
    expect(ped.lodTwinDist).toBeCloseTo(2);
    // P8: the tree crown twins are tier-driven (their own 'twin' family) — the chip multiplier leaves them alone
    const tree = { name: 'world:tree-zelkova-0:foliage:leaf#0', lodTwinRole: 2, lodTwinDist: 10 };
    stampTwinDistances([tree], s, base);
    expect(tree.lodTwinDist).toBe(10);
  });

  it('the panel view lists each family with its distance in units and metres', () => {
    const fams = cityLodFamilies(WorldManager.cityDistanceTiers(1));
    const v = cityLodSettingsView(sanitizeCityLodSettings({ global: 2, families: { trees: 0.5 } }), fams, F, 15, { cascades: 2, nearMetres: 24 });
    const t = v.familyList.find(f => f.id === 'trees')!;
    expect(t.multiplier).toBe(0.5);
    expect(t.distance).toBeCloseTo(1.2 * F * 2 * 0.5);
    expect(t.metres).toBeCloseTo(t.distance * 15);
    expect(v.shadow.cascades).toBe(2);
  });
});

describe('LOD stats + debug tint', () => {
  const mesh = (name: string, tris: number, o: Record<string, unknown> = {}) => ({
    id: name + tris, name, visible: true, drawDistance: 1, triangleCount: tris, lodHidden: false, lodTwinRole: 0, lodTwinNear: false,
    material: { diffuse: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, emissive: { r: 0, g: 0, b: 0, a: 1 } }, materialDirty: false, ...o,
  });
  const tiers = WorldManager.cityDistanceTiers(F);
  const fams = cityLodFamilies(WorldManager.cityDistanceTiers(1));

  it('counts shown / LOD-hidden / zoom-hidden per family, instanced groups by every copy', () => {
    const treeSrc = mesh('world:tree-zelkova-0', 100);
    const group = { id: 'grp', name: 'world:tree-zelkova-0', visible: true, sourceId: treeSrc.id, arrayParams: { mode: 'explicit', offsets: [1, 2, 3] } };
    const roots = [{
      name: 'City', visible: true, children: [
        treeSrc, group,
        mesh('world:ped-red', 50, { lodHidden: true }),
        mesh('world:ped-blue', 40, { lodTwinRole: 1, lodTwinNear: false }),   // near twin while far → not in use
        { name: 'world:roof-detail', visible: false, children: [mesh('world:roof-equip', 10)] },
        mesh('world:buildings', 1000),
      ],
    }];
    const rows = collectCityLodStats(roots, tiers, fams, id => id === 'grp', p => (p as { offsets: unknown[] }).offsets.length);
    const row = (id: string) => rows.find(r => r.id === id)!;
    expect(row('trees')).toMatchObject({ objects: 2, shown: 1, lodHidden: 1, trisShown: 100, trisHidden: 300 });
    expect(row('crowd')).toMatchObject({ objects: 2, shown: 0, lodHidden: 2, trisHidden: 90 });
    expect(row('roof')).toMatchObject({ objects: 1, zoomHidden: 1 });
    expect(row('other')).toMatchObject({ objects: 1, shown: 1, trisShown: 1000 });
  });

  it('the debug tint colours by family, greys the rest, and restores exactly', () => {
    const a = mesh('world:tree-x', 1), b = mesh('world:buildings', 1);
    const tint = new LodDebugTint();
    expect(tint.apply([{ name: 'City', children: [a, b] }], tiers)).toBe(2);
    expect(a.material.diffuse).not.toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
    expect(a.materialDirty).toBe(true);
    expect(b.material.diffuse.r).toBeCloseTo(0.32);
    expect(tint.apply([{ name: 'City', children: [a, b] }], tiers)).toBe(0);   // already tinted
    expect(tint.restore()).toBe(2);
    expect(a.material.diffuse).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
    expect(a.material.emissive).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(tint.active).toBe(false);
  });
});

// A WorldManager over a do-nothing scene (the world-bug-hunt pattern).
function scene(extra: Record<string, unknown> = {}): unknown {
  const base: Record<string, unknown> = { getCamera: () => ({ mode: 'perspective', position: [0, 0, 0], target: [0, 0, 0] }), getAllMeshes: () => [], shadowsEnabled: false, ...extra };
  return new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
}
type Priv = { _cityContainer: { worldParams?: Record<string, unknown> } | null; _graph: unknown; _lodCityR: number; _params: unknown; _groups: unknown[];
  _stampDrawDistances(roots: unknown[], force: boolean): void; _stampWorldParams(): void };

describe('WorldManager LOD settings', () => {
  const mk = () => {
    const w = new WorldManager(scene() as never);
    const p = w as unknown as Priv;
    p._cityContainer = {};
    p._graph = { params: { radius: 10, seed: 1 } };
    p._params = { radius: 10 };
    p._lodCityR = 10;
    return { w, p };
  };

  it('saves only a changed setting in the city marker (absent = today)', () => {
    const { w, p } = mk();
    p._stampWorldParams();
    expect(p._cityContainer!.worldParams).not.toHaveProperty('lod');
    w.setLodSettings({ families: { trees: 0.5 }, aerialBias: false });
    expect(p._cityContainer!.worldParams!.lod).toEqual({ aerialBias: false, families: { trees: 0.5 } });
    w.setLodSettings({ reset: true });
    expect(p._cityContainer!.worldParams).not.toHaveProperty('lod');
  });

  it('re-stamps live: a family multiplier changes that family only', () => {
    const { w, p } = mk();
    const tree = { name: 'world:tree-a', drawDistance: 0, drawDistanceBias: 1 };
    const bus = { name: 'world:busstop', drawDistance: 0, drawDistanceBias: 1 };
    p._stampDrawDistances([tree, bus], true);
    const t0 = tree.drawDistance, b0 = bus.drawDistance;
    expect(t0).toBeGreaterThan(0);
    w.setLodSettings({ families: { trees: 2 } });
    p._stampDrawDistances([tree, bus], false);   // the settings version is in the stamp key → re-stamps
    expect(tree.drawDistance).toBeCloseTo(t0 * 2);
    expect(bus.drawDistance).toBeCloseTo(b0);
    w.setLodSettings({ global: 0.5 });
    p._stampDrawDistances([tree, bus], false);
    expect(bus.drawDistance).toBeCloseTo(b0 * 0.5);
  });

  it('restores from the marker and forgets on a document load', () => {
    const { w, p } = mk();
    w.setLodSettings({ zoom: { props: 3 }, shadow: { pcf: '3x3' } });
    const saved = JSON.parse(JSON.stringify(p._cityContainer!.worldParams));
    w.clearForDocumentLoad();
    expect(w.getLodSettings()).toEqual(defaultCityLodSettings());
    const w2 = new WorldManager(scene({ findExistingCityContainer: () => ({ worldParams: saved }) }) as never);
    try { w2.restoreFromSave(); } catch { /* the do-nothing scene cannot build; the settings are read first */ }
    expect(w2.getLodSettings().zoom.props).toBe(3);
    expect(w2.getLodSettings().shadow.pcf).toBe('3x3');
  });

  it('P14 shadow quality: a preset sets the PCF kernel and the cascade count, its sizes and refresh reach the scene', () => {
    const calls: Record<string, unknown[]> = {};
    const rec = (k: string) => (...a: unknown[]) => { (calls[k] ??= []).push(a); };
    const w = new WorldManager(scene({ shadowsEnabled: true, shadowMapSize3D: 2048, setShadowCascades3D: rec('casc'), setShadowMapSize3D: rec('size'), setShadowIntervalScale3D: rec('interval'), setShadowQuality3D: rec('pcf') }) as never);
    const p = w as unknown as Priv & { _cityMode: boolean };
    p._cityContainer = {}; p._graph = { params: { radius: 10, seed: 1 } }; p._params = { radius: 10 }; p._lodCityR = 10; p._cityMode = true;
    w.setLodSettings({ shadow: { quality: 'low' } });
    expect(w.getLodSettings().shadow).toMatchObject({ quality: 'low', pcf: '3x3' });
    expect(w.shadowCascades.cascades).toBe(1);
    expect(w.getLodSettingsView().shadow.qualityShown).toBe('low');
    expect((calls.casc.at(-1) as unknown[])[0]).toMatchObject({ cascades: 1, mapSize: 1024, updateInterval: 3 });
    expect(calls.size.at(-1)).toEqual([1024]);
    expect(calls.interval.at(-1)).toEqual([2]);
    expect(calls.pcf.at(-1)).toEqual([1]);
    expect(p._cityContainer!.worldParams!.lod).toEqual({ shadow: { pcf: '3x3', quality: 'low' } });
    w.setLodSettings({ shadow: { cascades: 3 } });   // one setting on its own → custom
    expect(w.getLodSettingsView().shadow.qualityShown).toBe('custom');
    w.setLodSettings({ shadow: { quality: 'high' } });
    expect(w.shadowCascades.cascades).toBe(2);
    expect(w.getLodSettingsView().shadow.qualityShown).toBe('high');
  });

  it('sim LOD (P13): its settings ride the LOD settings — saved only when changed, restored on load', () => {
    const { w, p } = mk();
    expect(w.getLodSettings().sim.enabled).toBe(true);
    w.setSimLod({ midHz: 5, enabled: false });
    expect(p._cityContainer!.worldParams!.lod).toEqual({ sim: { enabled: false, midHz: 5 } });
    expect(w.getLodSettingsView().sim.midHz).toBe(5);
    const saved = JSON.parse(JSON.stringify(p._cityContainer!.worldParams));
    w.setLodSettings({ reset: true });
    expect(p._cityContainer!.worldParams).not.toHaveProperty('lod');
    const w2 = new WorldManager(scene({ findExistingCityContainer: () => ({ worldParams: saved }) }) as never);
    try { w2.restoreFromSave(); } catch { /* the do-nothing scene cannot build; the settings are read first */ }
    expect(w2.getLodSettings().sim).toMatchObject({ enabled: false, midHz: 5, nearM: 40 });
  });
});
