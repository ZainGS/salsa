/**
 * mobile-parity 7.2: leaving UV paint / the UV editor must ALWAYS bring the mesh-edit orbit + the wavy focus background
 * down. The host closed the engine session by the CURRENT selection's id; once the selection had moved, the session
 * survived and pinned the orbit + background. Also: the Delete key's host route (the key and Edit › Delete identical).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ShapeManager from './shape-manager';

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

function engine(open: string[], o: { painting?: string | null; editing?: boolean } = {}) {
    let active: string | null = o.painting ?? null;
    const self = {
        _uvSessions: new Map(open.map(id => [id, { meshId: id }])),
        _uvPaintCanvases: new Map(),
        _uvPaintController: { activeMeshId: () => active },
        exitUVPaintMode3D: vi.fn(() => { active = null; }),
        meshEdit: { isEditing: !!o.editing },
        scene3d: { disableMeshEditOrbit: vi.fn() },
        scheduleRender: vi.fn(),
        closeUVEditor3D: ShapeManager.prototype.closeUVEditor3D,
    };
    return self;
}

describe('ShapeManager.closeAllUVEditors3D', () => {
    it('the bug: closing by a different (moved) selection id leaves the session — and the orbit / focus bg — up', () => {
        const sm = engine(['mesh-a'], { painting: 'mesh-a' });
        ShapeManager.prototype.closeUVEditor3D.call(sm as never, 'mesh-b');
        expect(sm._uvSessions.size).toBe(1);
        expect(sm.scene3d.disableMeshEditOrbit).not.toHaveBeenCalled();
    });

    it('exits paint and closes every session, so the orbit + focus background come down once', () => {
        const sm = engine(['mesh-a', 'mesh-b'], { painting: 'mesh-a' });
        ShapeManager.prototype.closeAllUVEditors3D.call(sm as never);
        expect(sm.exitUVPaintMode3D).toHaveBeenCalled();
        expect(sm._uvSessions.size).toBe(0);
        expect(sm.scene3d.disableMeshEditOrbit).toHaveBeenCalledTimes(1);
    });

    it('leaves full mesh-edit mode\'s orbit alone, and is a no-op with nothing open', () => {
        const editing = engine(['mesh-a'], { editing: true });
        ShapeManager.prototype.closeAllUVEditors3D.call(editing as never);
        expect(editing._uvSessions.size).toBe(0);
        expect(editing.scene3d.disableMeshEditOrbit).not.toHaveBeenCalled();
        const idle = engine([]);
        ShapeManager.prototype.closeAllUVEditors3D.call(idle as never);
        expect(idle.scene3d.disableMeshEditOrbit).not.toHaveBeenCalled();
    });
});

describe('clearDocumentRegistriesForLoad closes the previous document\'s UV editor', () => {
    // Everything the reset touches besides the UV editor is inert here.
    const inert: unknown = new Proxy(function () { /* inert */ }, {
        get: (_t, k) => (k === 'then' ? undefined : inert),
        apply: () => inert,
    });
    function self(sessions: number, painting: boolean) {
        const t: Record<string, unknown> = {
            _uvSessions: new Map(Array.from({ length: sessions }, (_, i) => [`m${i}`, {}])),
            uvPaint: { isActive: () => painting },
            closeAllUVEditors3D: vi.fn(),
        };
        return new Proxy(t, { get: (o, k) => (k in o ? o[k as string] : inert) }) as typeof t & { closeAllUVEditors3D: ReturnType<typeof vi.fn> };
    }

    it('when a session or paint is still open', () => {
        for (const s of [self(1, false), self(0, true)]) {
            ShapeManager.prototype.clearDocumentRegistriesForLoad.call(s as never);
            expect(s.closeAllUVEditors3D).toHaveBeenCalledTimes(1);
        }
        const none = self(0, false);
        ShapeManager.prototype.clearDocumentRegistriesForLoad.call(none as never);
        expect(none.closeAllUVEditors3D).not.toHaveBeenCalled();
    });
});

describe('ShapeManager.setDeleteKeyHandler (the Delete key = the host\'s Edit › Delete)', () => {
    it('routes the engine\'s Delete hook to the host, and null restores the 2D shape delete', () => {
        const sm = { _deleteKeyHandler: null as (() => void) | null, deleteSelectedShapes: vi.fn() };
        const run = () => (ShapeManager.prototype as unknown as { _runDeleteKey(): void })._runDeleteKey.call(sm);
        run();
        expect(sm.deleteSelectedShapes).toHaveBeenCalledTimes(1);
        const host = vi.fn();
        ShapeManager.prototype.setDeleteKeyHandler.call(sm as never, host);
        run();
        expect(host).toHaveBeenCalledTimes(1);
        expect(sm.deleteSelectedShapes).toHaveBeenCalledTimes(1);
        ShapeManager.prototype.setDeleteKeyHandler.call(sm as never, null);
        run();
        expect(sm.deleteSelectedShapes).toHaveBeenCalledTimes(2);
    });
});
