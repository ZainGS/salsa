import { describe, it, expect } from 'vitest';
import { packFrogcart, unpackFrogcart, DEFAULT_PLAYER_CONFIG } from './frogcart';
import type { UILayerData } from '../../ui/ui-types';

function fakeScenePackage(): Blob {
    // Any bytes stand in for the inner .frogmarks zip — the envelope must round-trip them EXACTLY.
    return new Blob([new Uint8Array([80, 75, 3, 4, 42, 7, 99, 1, 2, 3])], { type: 'application/zip' });
}

function fakeLayers(): UILayerData[] {
    return [{
        id: 'L1', name: 'Menu', type: 'ui-layer', visible: true, passThroughPointer: false,
        shapeInteractions: { btn: { shapeId: 'btn', focusable: true } },
        stateMachine: { id: 'm', initialStateId: 'title', states: [{ id: 'title', name: 'Title' }], transitions: [], variables: [] },
    } as unknown as UILayerData];
}

describe('.frogcart packaging (spec §Packaging Format)', () => {
    it('round-trips manifest, player config, state machines, and the scene package byte-for-byte', async () => {
        const scene = fakeScenePackage();
        const cart = await packFrogcart({
            scenePackage: scene,
            meta: { title: 'My Scene', author: 'zain', description: 'a test', tags: ['ps1'] },
            stateMachineJSON: JSON.stringify(fakeLayers()),
            playerConfig: { initialState: 'title', canvasWidth: 640, canvasHeight: 480 },
            sceneId: 'cart-test',
            createdAt: '2026-09-07T00:00:00Z',
        });
        const out = await unpackFrogcart(cart);
        expect(out.manifest.title).toBe('My Scene');
        expect(out.manifest.author).toBe('zain');
        expect(out.manifest.sceneId).toBe('cart-test');
        expect(out.manifest.version).toBe('1.0');
        expect(out.manifest.tags).toEqual(['ps1']);
        expect(out.playerConfig.initialState).toBe('title');
        expect(out.playerConfig.canvasWidth).toBe(640);
        expect(out.playerConfig.deepLinkStateParam).toBe(DEFAULT_PLAYER_CONFIG.deepLinkStateParam);   // defaults fill in
        expect(out.uiLayers).toHaveLength(1);
        expect(out.uiLayers[0].stateMachine.initialStateId).toBe('title');
        const inBytes = new Uint8Array(await scene.arrayBuffer());
        const outBytes = new Uint8Array(await out.scenePackage.arrayBuffer());
        expect([...outBytes]).toEqual([...inBytes]);   // the inner project package survives untouched
        expect(out.sounds).toEqual([]);                // no audio bundled → empty, not missing
    });

    it('bundles sound assets and round-trips their bytes + mime by assetId', async () => {
        const click = new Uint8Array([1, 2, 3, 4]);
        const bgm = new Uint8Array([9, 8, 7, 6, 5]);
        const cart = await packFrogcart({
            scenePackage: fakeScenePackage(), meta: { title: 'S' }, stateMachineJSON: null,
            sounds: [
                { assetId: 'click', bytes: click, mime: 'audio/wav' },
                { assetId: 'bgm/theme A', bytes: bgm, mime: 'audio/mpeg' },   // ids with slashes/spaces are fine
            ],
        });
        const out = await unpackFrogcart(cart);
        expect(out.sounds).toHaveLength(2);
        const byId = new Map(out.sounds.map((s) => [s.assetId, s]));
        expect([...byId.get('click')!.bytes]).toEqual([...click]);
        expect(byId.get('click')!.mime).toBe('audio/wav');
        expect([...byId.get('bgm/theme A')!.bytes]).toEqual([...bgm]);
        expect(byId.get('bgm/theme A')!.mime).toBe('audio/mpeg');
    });

    it('tolerates a cart without state machines or player config (defaults apply)', async () => {
        const cart = await packFrogcart({ scenePackage: fakeScenePackage(), meta: { title: 'Bare' }, stateMachineJSON: null });
        const out = await unpackFrogcart(cart);
        expect(out.uiLayers).toEqual([]);
        expect(out.playerConfig).toEqual(DEFAULT_PLAYER_CONFIG);
        expect(out.manifest.title).toBe('Bare');
    });

    it('rejects a blob that is not a frogcart', async () => {
        const bogus = await packFrogcart({ scenePackage: fakeScenePackage(), meta: { title: 'x' }, stateMachineJSON: null });
        // Corrupt: re-zip without the required entries by handing arbitrary bytes.
        await expect(unpackFrogcart(new Blob([new Uint8Array([1, 2, 3, 4])]))).rejects.toThrow();
        await expect(unpackFrogcart(bogus)).resolves.toBeTruthy();   // sanity: the real one still parses
    });
});
