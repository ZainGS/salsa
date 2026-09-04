import { describe, it, expect } from 'vitest';
import { SceneAuthoringAPI } from './scene-authoring-api';
import type ShapeManager from './shape-manager';

/** Stub ShapeManager that captures the opts addCharacter forwards to createFullCharacter3D. */
function stubSm() {
    let last: Record<string, unknown> | null = null;
    const sm = {
        createFullCharacter3D: async (o: Record<string, unknown>) => { last = o; return { meshId: 'body1', skeletonId: 'sk1', nodeIds: [] }; },
    } as unknown as ShapeManager;
    return { api: new SceneAuthoringAPI(sm), get: () => last };
}

describe('SceneAuthoringAPI.addCharacter — clothing/hair defaults', () => {
    it('dresses + hairs the character by default (no more nude mannequin)', async () => {
        const { api, get } = stubSm();
        await api.addCharacter({});
        const a = get()!;
        expect(a.top).toBeDefined();
        expect(a.bottom).toBeDefined();
        expect(a.hair).toBeDefined();
        // the synthesized garment carries its slot so createFullCharacter3D routes it correctly
        expect((a.top as { slot?: string }).slot).toBe('top');
        expect((a.bottom as { slot?: string }).slot).toBe('bottom');
    });

    it('clothed:false leaves a bare base body', async () => {
        const { api, get } = stubSm();
        await api.addCharacter({ clothed: false });
        const a = get()!;
        expect(a.top).toBeUndefined();
        expect(a.bottom).toBeUndefined();
        expect(a.hair).toBeUndefined();
        expect('clothed' in a).toBe(false);   // the flag is consumed, not forwarded
    });

    it('does not override explicitly-provided slots', async () => {
        const { api, get } = stubSm();
        const customTop = { slot: 'top', marker: 'MINE' } as unknown as Parameters<ShapeManager['createFullCharacter3D']>[0]['top'];
        await api.addCharacter({ top: customTop });
        const a = get()!;
        expect((a.top as { marker?: string }).marker).toBe('MINE');
        expect(a.bottom).toBeDefined();   // still fills the unspecified slots
    });
});
