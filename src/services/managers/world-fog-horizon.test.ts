import { describe, it, expect } from 'vitest';
import { WorldManager } from './world-manager';
import { assignDrawDistances, distanceTierFogClass, distanceTierKind, cityDrawDistance } from './view-cull';
import { cityLodFamilies } from './world-lod-settings';

// FOG HORIZON (docs/specs/fog-horizon.md): every city family is classed building / attachment / other, and the stamp
// writes Mesh3D.fogClass (0 / 1 / 2) without changing any draw distance.

type N = { name: string; drawDistance?: number; drawDistanceBias?: number; shadowFeatureSize?: number; fogClass?: number; children?: N[] };
const mesh = (name: string, children?: N[]): N => ({ name, drawDistance: 0, drawDistanceBias: 1, shadowFeatureSize: 0, fogClass: 0, children });
const classOf = (name: string, F = 10): number => {
    const m = mesh(name);
    assignDrawDistances([m], WorldManager.cityDistanceTiers(F), WorldManager.fogClassify());
    return m.fogClass!;
};

describe('fog horizon classification', () => {
    it('every draw tier names its class explicitly', () => {
        const draw = WorldManager.cityDistanceTiers(1).filter((t) => distanceTierKind(t) === 'draw');
        for (const t of draw) expect(t.length, String(t[0])).toBe(6);
    });

    it('building shells, ground and structures stay; attachments and everything else are classed', () => {
        const want: Record<string, number> = {
            // building (0): bodies, roofs, landmarks, ground, roads, paving, water, the viaduct
            'world:buildings': 0, 'world:roofs': 0, 'world:detail-roof': 0, 'world:detail-wall': 0, 'world:lm-stone': 0,
            'world:roads': 0, 'world:ground': 0, 'world:sidewalks': 0, 'world:plaza': 0, 'world:canal': 0, 'world:rail-viaduct': 0,
            // attachment (1): signs, awnings, facade trim, rooftop equipment
            'world:detail-sign-a': 1, 'world:detail-sign-text': 1, 'world:sign-red': 1, 'world:screen-0': 1, 'textsign-shop': 1,
            'world:awning-red': 1, 'world:detail-windowtrim': 1, 'world:balcony': 1, 'world:roof-equip': 1, 'world:detail-roof-equip': 1,
            // other (2): props, trees, cars, crowd, street furniture, lamps, movers
            'world:tree-zelkova-0': 2, 'world:car-body': 2, 'world:ped-red': 2, 'world:bench': 2, 'world:util-pole': 2,
            'world:roadsign-stop': 2, 'world:warning': 2, 'world:vending-body': 2, 'world:contact-shadow': 2, 'world:lamplights': 2,
            'world:lamp-pool': 2, 'world:traffic-car': 2, 'world:busstop': 2,
        };
        const got: Record<string, number> = {};
        for (const k of Object.keys(want)) got[k] = classOf(k);
        expect(got).toEqual(want);
    });

    it('the class does not depend on the draw distances (LOD off = empty tiers still classifies)', () => {
        const a = mesh('world:tree-zelkova-0'), b = mesh('world:awning-red');
        assignDrawDistances([a, b], [], WorldManager.fogClassify());
        expect([a.fogClass, b.fogClass, a.drawDistance]).toEqual([2, 1, 0]);
    });

    it('a claimed subtree inherits the class; an untiered parent lets a tiered child claim its own', () => {
        const leaf = mesh('chunk-3');
        const group = mesh('world:tree-camphor', [leaf]);
        const signLetters = mesh('world:detail-sign-text#1');
        const street = mesh('streets', [group, signLetters, mesh('world:buildings')]);
        assignDrawDistances([street], WorldManager.cityDistanceTiers(10), WorldManager.fogClassify());
        expect([street.fogClass, group.fogClass, leaf.fogClass, signLetters.fogClass, street.children![2].fogClass]).toEqual([0, 2, 2, 1, 0]);
    });

    it('the stamp is unchanged by the classes (same distances as the class-free tiers)', () => {
        const F = 10, T = WorldManager.cityDistanceTiers(F);
        expect(cityDrawDistance('world:roadsign-stop', T)).toBe(cityDrawDistance('textsign-shop', T));   // split, same distance
        for (const t of T) if (distanceTierKind(t) === 'draw') expect(['building', 'attachment', 'other']).toContain(distanceTierFogClass(t));
    });

    it('the road signs are their own LOD family; the existing family ids are kept', () => {
        const ids = cityLodFamilies(WorldManager.cityDistanceTiers(1)).map((f) => f.id);
        for (const id of ['cans', 'crowd', 'railFine', 'tiny', 'smallProps', 'poles', 'signText', 'signs', 'roadSigns', 'facade', 'roof', 'trees', 'parkedCars', 'vending', 'props', 'flatmap', 'contact']) expect(ids).toContain(id);
    });

    it('a class change marks the mesh materialDirty (its GPU slot re-derives flags2); an unchanged class does not', () => {
        const m = { ...mesh('world:tree-zelkova-0'), materialDirty: false };
        assignDrawDistances([m], WorldManager.cityDistanceTiers(10), WorldManager.fogClassify());
        expect([m.fogClass, m.materialDirty]).toEqual([2, true]);
        m.materialDirty = false;
        assignDrawDistances([m], WorldManager.cityDistanceTiers(10), WorldManager.fogClassify());
        expect(m.materialDirty).toBe(false);
    });

    it('without the fog input the stamp leaves fogClass alone (old callers)', () => {
        const m = mesh('world:tree-zelkova-0'); m.fogClass = 0;
        assignDrawDistances([m], WorldManager.cityDistanceTiers(10));
        expect(m.fogClass).toBe(0);
    });
});
