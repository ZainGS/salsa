import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorldManager } from './world-manager';
import type { SignTextInfo } from '../../world/sign-text-all';

// Text-sign plates are textured by LAYER NAME (not by child index — the group can hold extra meshes, e.g. a contact
// shadow layer, or split ones), one GPU texture per distinct plate per batch, and a plate that was detached when its
// texture landed is picked up on re-attach (2026-10-04: streamed tiles' STOP / street-name / road-sign lettering).

type FakeMesh = { id: string; name: string; material: { hasTexture: boolean }; diffuseTexture: unknown; textureLibraryId?: string | null; materialDirty?: boolean };
const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeAll(() => {
    for (const k of ['document', 'createImageBitmap', 'requestAnimationFrame']) saved[k] = g[k];
    g.document = {}; g.createImageBitmap = () => Promise.resolve({});
    g.requestAnimationFrame = undefined;   // rasterize synchronously
});
afterAll(() => { for (const k of Object.keys(saved)) g[k] = saved[k]; });

function world(attached: Set<string>, uploads: string[]): WorldManager {
    const scene = new Proxy({
        getPostProcessing3D: () => ({}), shadowsEnabled: false,
        setMeshTexture: async (id: string, bmp: { label: string }) => {
            const m = meshes.get(id);
            if (!m || !attached.has(id)) return false;
            uploads.push(id);
            m.diffuseTexture = { tex: bmp.label }; m.material.hasTexture = true;
            return true;
        },
    } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : () => undefined) });
    const w = new WorldManager(scene as never);
    (w as unknown as { _rasterSign: (s: SignTextInfo) => Promise<unknown> })._rasterSign = (s) => Promise.resolve({ label: s.label });
    return w;
}
const meshes = new Map<string, FakeMesh>();
const mesh = (id: string, name: string): FakeMesh => { const m: FakeMesh = { id, name, material: { hasTexture: false }, diffuseTexture: null }; meshes.set(id, m); return m; };
const info = (label: string): SignTextInfo => ({ label, color: [0.9, 0.16, 0.13], square: label === 'STOP' });
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

describe('text-sign texturing by layer name', () => {
    it('maps by name despite extra / reordered meshes, and shares one texture per plate', async () => {
        meshes.clear();
        const kids = [mesh('c', 'world:contact-shadow'), mesh('n', 'world:signaltext-name1'), mesh('s0', 'world:signaltext-stop0'), mesh('s2', 'world:signaltext-stop2')];
        const byName = new Map([['world:signaltext-stop0', info('STOP')], ['world:signaltext-name1', info('OAK ST')], ['world:signaltext-stop2', info('STOP')]]);
        const uploads: string[] = [];
        const w = world(new Set(meshes.keys()), uploads);
        const n = (w as unknown as { _textureSignGroups: (g: unknown[], b: unknown) => number })._textureSignGroups([{ name: 'World Tile 1_0 World Sign Text', children: kids }], byName);
        expect(n).toBe(3);
        await flush(); await flush();
        expect(meshes.get('c')!.diffuseTexture).toBeNull();                         // not a plate
        expect(meshes.get('n')!.diffuseTexture).toEqual({ tex: 'OAK ST' });
        expect(meshes.get('s0')!.diffuseTexture).toEqual({ tex: 'STOP' });
        expect(meshes.get('s2')!.diffuseTexture).toBe(meshes.get('s0')!.diffuseTexture);   // shared, not re-uploaded
        expect(uploads.sort()).toEqual(['n', 's0']);
    });
    it('a plate detached when its texture landed is textured on re-attach (by its remembered label)', async () => {
        meshes.clear();
        const kids = [mesh('a', 'world:roadsign-reg0')];
        const attached = new Set<string>(), uploads: string[] = [];
        const w = world(attached, uploads) as unknown as { _textureSignGroups: (g: unknown[], b: unknown) => number };
        const grp = { name: 'World Sign Text', children: kids };
        w._textureSignGroups([grp], new Map([['world:roadsign-reg0', info('NO PARKING')]]));
        await flush(); await flush();
        expect(meshes.get('a')!.diffuseTexture).toBeNull();   // detached: setMeshTexture failed
        attached.add('a');
        expect(w._textureSignGroups([grp], null)).toBe(1);     // re-attach: label remembered per mesh
        await flush(); await flush();
        expect(meshes.get('a')!.diffuseTexture).toEqual({ tex: 'NO PARKING' });
        expect(w._textureSignGroups([grp], null)).toBe(0);     // already textured → nothing to do
    });
    it('groups that are not Sign Text groups are ignored', () => {
        meshes.clear();
        const w = world(new Set(), []) as unknown as { _textureSignGroups: (g: unknown[], b: unknown) => number };
        expect(w._textureSignGroups([{ name: 'World Signals', children: [mesh('x', 'world:signaltext-stop0')] }], new Map([['world:signaltext-stop0', info('STOP')]]))).toBe(0);
    });
});
