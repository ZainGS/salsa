/**
 * raster-undo-key-mode.test.ts — the engine's own Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (the 2D-object undo stack,
 * RasterInteractionController.handleKeyDown) stands down while Edit Mesh / the Armature panel is up
 * (InteractionService.undoKeysOwnedByEditMode3D), so the host's mode-scoped undo gets the key. Elsewhere unchanged:
 * consumed only when the 2D stack can undo / redo.
 */
import { describe, it, expect, vi } from 'vitest';
import { RasterInteractionController } from './raster-interaction-controller';

function rig(o: { canUndo?: boolean; canRedo?: boolean; owned?: boolean | null } = {}) {
    const vectorUndo = { canUndo: o.canUndo ?? true, canRedo: o.canRedo ?? true, undo: vi.fn(), redo: vi.fn() };
    const r = {
        _uiKeyHandler: null,
        _duplicateSelectedHandler: null,
        interactionService: {
            playActive: false, suppressBoxSelect: false, selectedNodes: new Set(), vectorUndo,
            undoKeysOwnedByEditMode3D: o.owned == null ? null : () => o.owned!,
        },
    };
    const c = new RasterInteractionController(r as never);
    const press = (key: string, shiftKey = false) => {
        const e = { key, ctrlKey: true, metaKey: false, altKey: false, shiftKey, repeat: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
        c.handleKeyDown(e as unknown as KeyboardEvent);
        return e;
    };
    return { vectorUndo, press };
}

describe('Ctrl+Z / Ctrl+Y in 3D edit modes (the host\'s mode-scoped undo owns them)', () => {
    it('Edit Mesh / Armature: undo, redo (Y and Shift+Z) are NOT consumed and the 2D stack is untouched', () => {
        const { vectorUndo, press } = rig({ owned: true });
        for (const [key, shift] of [['z', false], ['Z', true], ['y', false], ['Y', false]] as const) {
            const e = press(key, shift);
            expect(e.preventDefault).not.toHaveBeenCalled();
            expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
        }
        expect(vectorUndo.undo).not.toHaveBeenCalled();
        expect(vectorUndo.redo).not.toHaveBeenCalled();
    });

    it('outside those modes: unchanged — consumed when the 2D stack can undo / redo, left alone when it cannot', () => {
        for (const owned of [false, null]) {
            const { vectorUndo, press } = rig({ owned });
            const z = press('z');
            expect(vectorUndo.undo).toHaveBeenCalledTimes(1);
            expect(z.preventDefault).toHaveBeenCalled();
            expect(z.stopImmediatePropagation).toHaveBeenCalled();
            press('y');
            press('Z', true);
            expect(vectorUndo.redo).toHaveBeenCalledTimes(2);
        }
        const empty = rig({ canUndo: false, canRedo: false, owned: false });
        const e = empty.press('z');
        expect(empty.vectorUndo.undo).not.toHaveBeenCalled();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('Scene3DManager.isArmatureModeActive3D: the bone overlay pinned, armature mode entered, or the armature background on', async () => {
        const { Scene3DManager } = await import('../../services/managers/scene3d-manager');
        const fn = Scene3DManager.prototype.isArmatureModeActive3D;
        const self = (overlay: boolean, entered: boolean, bg: boolean | 'throws') => ({
            _armature: { isBoneOverlayActive: () => overlay },
            _armatureEntryCaptured: entered,
            get renderer3D() { if (bg === 'throws') throw new Error('no renderer'); return { armatureModeActive: bg }; },
        });
        expect(fn.call(self(false, false, false) as never)).toBe(false);
        expect(fn.call(self(true, false, false) as never)).toBe(true);
        expect(fn.call(self(false, true, false) as never)).toBe(true);
        expect(fn.call(self(false, false, true) as never)).toBe(true);
        expect(fn.call(self(false, false, 'throws') as never)).toBe(false);
    });
});
