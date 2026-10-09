import { describe, it, expect } from 'vitest';
import { packFrogcart, unpackFrogcart, DEFAULT_PLAYER_CONFIG, FROGCART_VERSION, frogcartCdArtFile, frogcartCdArtBlob } from './frogcart';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { CD_DISC_ART_MAX_BYTES } from '../../renderer/3d/cd-disc/cd-disc-art';
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
        expect(out.manifest.version).toBe('1.1');
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

    // ── 1.1: the disc art + pattern seed (docs/specs/frogcart-cd-art-and-launch.md Part B) ──
    it('1.1: round-trips the disc art (a cd-art entry + manifest.cdArt) and the pattern seed', async () => {
        const art = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6]);
        const cart = await packFrogcart({
            scenePackage: fakeScenePackage(), stateMachineJSON: null,
            meta: { title: 'Art', cdArt: new Blob([art], { type: 'image/webp' }), cdArtSizePx: 512, cdPattern: { seed: 1234.7, family: 'dots' } },
        });
        const out = await unpackFrogcart(cart);
        expect(out.manifest.version).toBe(FROGCART_VERSION);
        expect(out.manifest.cdArt).toEqual({ file: 'cd-art.webp', mime: 'image/webp', sizePx: 512 });
        expect(out.manifest.cdPattern).toEqual({ seed: 1234, family: 'dots' });   // a clean uint32 seed
        expect(out.cdArt?.type).toBe('image/webp');
        expect([...new Uint8Array(await out.cdArt!.arrayBuffer())]).toEqual([...art]);
        const entries = unzipSync(new Uint8Array(await cart.arrayBuffer()));
        expect(Object.keys(entries)).toContain('cd-art.webp');
    });

    it('1.1: no art → manifest.cdArt null, no entry, unpack cdArt null; a PNG gets cd-art.png', async () => {
        const none = await unpackFrogcart(await packFrogcart({ scenePackage: fakeScenePackage(), meta: { title: 'N' }, stateMachineJSON: null }));
        expect(none.manifest.cdArt).toBeNull();
        expect(none.manifest.cdPattern).toBeNull();
        expect(none.cdArt).toBeNull();
        const png = await packFrogcart({ scenePackage: fakeScenePackage(), meta: { title: 'P', cdArt: new Blob([new Uint8Array([1])], { type: 'image/png' }) }, stateMachineJSON: null });
        expect((await unpackFrogcart(png)).manifest.cdArt?.file).toBe('cd-art.png');
        expect(frogcartCdArtFile('image/jpeg')).toBe('cd-art.jpg');
    });

    it('1.1: disc art over the 2 MB cap is refused', async () => {
        const big = new Blob([new Uint8Array(CD_DISC_ART_MAX_BYTES + 1)], { type: 'image/png' });
        await expect(packFrogcart({ scenePackage: fakeScenePackage(), meta: { title: 'B', cdArt: big }, stateMachineJSON: null })).rejects.toThrow(/disc art/);
    });

    it('an old 1.0 cart (no cdArt / cdPattern, no art entry) still loads', async () => {
        const manifest = { version: '1.0', frogmarksPlayerMinVersion: '1.0.0', sceneId: 'old', title: 'Old', author: '', description: '', thumbnail: null, createdAt: '', tags: [] };
        const zipped = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'scene.salsa': new Uint8Array([80, 75, 3, 4]) });
        const out = await unpackFrogcart(new Blob([zipped as unknown as BlobPart]));
        expect(out.manifest.version).toBe('1.0');
        expect(out.cdArt).toBeNull();
        expect(out.manifest.cdPattern).toBeUndefined();
    });

    it('frogcartCdArtBlob ignores a manifest pointing at a missing entry', () => {
        expect(frogcartCdArtBlob({ cdArt: { file: 'cd-art.png', mime: 'image/png', sizePx: 512 } }, {})).toBeNull();
        expect(frogcartCdArtBlob({ cdArt: null }, { 'cd-art.png': new Uint8Array([1]) })).toBeNull();
    });
});
