import { describe, it, expect } from 'vitest';
import { Scene3DKitbash, type Scene3DKitbashHost } from './scene3d-kitbash';
import type { ManagerContext } from './manager-context';
import type { KitbashPartMeta } from '../../types/kitbash-3d';

/** GPU-free harness: stub ctx + host; only the registry/serialization/library surfaces are exercised
 *  (createCharacter/swapCharacterSlot fetch GLBs — browser-gated, verified in-app). */
function env() {
    const emitted: string[] = [];
    const ctx = {
        sceneGraph: { root: { addChild: () => {} } },
        emitSceneGraphChanged: () => emitted.push('changed'),
        scheduleRender: () => emitted.push('render'),
        webgpuRenderer: { isLive: true, play: () => {}, pause: () => {}, addPreRenderCallback: () => {} },
    } as unknown as ManagerContext;
    const host: Scene3DKitbashHost = {
        getMesh: () => null,
        getSkeleton: () => null,
        createSkeletonFromResult: () => { throw new Error('not in unit env'); },
        createSkinnedMeshForSlot: () => { throw new Error('not in unit env'); },
        getModelStore: () => new Map(),
        pushUndo: () => {},
        getPicker: () => ({ evictMesh: () => {} }) as never,
        getRenderer3D: () => ({ evictMeshCaches: () => {} }) as never,
    };
    return { kb: new Scene3DKitbash(ctx, host), emitted };
}

const part = (id: string, slot: KitbashPartMeta['slot']): KitbashPartMeta =>
    ({ id, slot, name: id, thumbnail: '', glbUrl: `blob:${id}`, tags: [], styleSet: 't' });

describe('Scene3DKitbash — part library', () => {
    it('addKitbashParts → getKitbashParts/getKitbashSlots reflect the catalog', () => {
        const { kb } = env();
        kb.addKitbashParts([part('a', 'base_body'), part('b', 'hair'), part('c', 'hair')]);
        expect(kb.getKitbashParts('hair').map((p) => p.id).sort()).toEqual(['b', 'c']);
        expect(kb.getKitbashSlots().sort()).toEqual(['base_body', 'hair']);
        expect(kb.getKitbashParts('top')).toEqual([]);
    });
});

describe('Scene3DKitbash — character registry serialization', () => {
    it('restoreCharacterStates → getCharacter/getAllCharacters → getScene3DCharacterStates round-trips', () => {
        const { kb } = env();
        const states = [{
            id: 'char1',
            definition: { id: 'char1', name: 'Testy', slots: { base_body: 'a', hair: 'b' } },
            skeletonId: 'skel1',
            partMeshIds: { base_body: 'm1', hair: 'm2' },
        }];
        kb.restoreCharacterStates(states);
        const c = kb.getCharacter('char1')!;
        expect(c.skeletonId).toBe('skel1');
        expect(c.partMeshIds.get('hair')).toBe('m2');
        expect(kb.getAllCharacters()).toHaveLength(1);
        expect(kb.getCharacter('nope')).toBeNull();
        // Round-trip: serialize reproduces the input shape.
        expect(kb.getScene3DCharacterStates()).toEqual(states);
        // restore replaces (not merges) the catalog.
        kb.restoreCharacterStates([]);
        expect(kb.getAllCharacters()).toEqual([]);
    });
});

describe('Scene3DKitbash — baked parts', () => {
    it('registerBakedPart adds to the library and serializeBakedParts lists it', async () => {
        const { kb } = env();
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'model/gltf-binary' });
        const id = kb.registerBakedPart('part_x', 'top', 'Baked Top', blob);
        expect(id).toBe('part_x');
        expect(kb.getKitbashParts('top').map((p) => p.id)).toContain('part_x');
        expect(kb.serializeBakedParts().map((m) => m.id)).toEqual(['part_x']);
        const bufs = await kb.getBakedPartBuffers();
        expect(new Uint8Array(bufs['part_x'])).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('restoreBakedParts re-registers metas with fresh object URLs from the persisted bytes', () => {
        const { kb } = env();
        const meta = part('part_y', 'hair');
        kb.restoreBakedParts([meta], { part_y: new Uint8Array([9]).buffer });
        const restored = kb.getKitbashParts('hair').find((p) => p.id === 'part_y')!;
        expect(restored).toBeTruthy();
        expect(restored.glbUrl).not.toBe(meta.glbUrl);      // fresh URL, not the stale persisted one
        expect(kb.serializeBakedParts().map((m) => m.id)).toEqual(['part_y']);
        // Missing buffer → skipped, not registered.
        kb.restoreBakedParts([part('part_z', 'top')], {});
        expect(kb.getKitbashParts('top')).toEqual([]);
    });
});
