/**
 * mobile-parity 7.2 (the Delete fix's twin): Ctrl+D goes through the host's Edit › Duplicate when it set one — 3D
 * nodes sit in the 2D selection too, and the engine's own duplicate only copies 2D shapes — and a held Ctrl+D
 * duplicates once.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import ShapeManager from './shape-manager';
import { RasterInteractionController } from '../renderer/core/raster-interaction-controller';

afterEach(() => { vi.restoreAllMocks(); });

describe('ShapeManager.setDuplicateKeyHandler (Ctrl+D = the host\'s Edit › Duplicate)', () => {
    it('routes the engine\'s Ctrl+D hook to the host, and null restores the 2D shape duplicate', () => {
        const sm = { _duplicateKeyHandler: null as (() => void) | null, duplicateSelectedShapes: vi.fn() };
        const run = () => (ShapeManager.prototype as unknown as { _runDuplicateKey(): void })._runDuplicateKey.call(sm);
        run();
        expect(sm.duplicateSelectedShapes).toHaveBeenCalledTimes(1);
        const host = vi.fn();
        ShapeManager.prototype.setDuplicateKeyHandler.call(sm as never, host);
        run();
        expect(host).toHaveBeenCalledTimes(1);
        expect(sm.duplicateSelectedShapes).toHaveBeenCalledTimes(1);   // the 2D path did not also run
        ShapeManager.prototype.setDuplicateKeyHandler.call(sm as never, null);
        run();
        expect(sm.duplicateSelectedShapes).toHaveBeenCalledTimes(2);
    });
});

describe('the engine\'s Ctrl+D key (RasterInteractionController.handleKeyDown)', () => {
    function rig(o: { selected?: number; suppress?: boolean; play?: boolean } = {}) {
        const handler = vi.fn();
        const r = {
            _uiKeyHandler: null,
            _duplicateSelectedHandler: handler,
            interactionService: {
                playActive: !!o.play,
                suppressBoxSelect: !!o.suppress,
                selectedNodes: new Set(Array.from({ length: o.selected ?? 1 }, (_, i) => ({ i, getType: () => 'Rectangle' }))),
                vectorUndo: { canUndo: false, canRedo: false },
            },
        };
        const c = new RasterInteractionController(r as never);
        const press = (repeat = false) => {
            const e = { key: 'd', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
            c.handleKeyDown(e as unknown as KeyboardEvent);
            return e;
        };
        return { handler, press };
    }

    it('runs the duplicate hook once per press: a held key\'s auto-repeats stay claimed but duplicate nothing', () => {
        const { handler, press } = rig();
        const first = press();
        expect(handler).toHaveBeenCalledTimes(1);
        expect(first.preventDefault).toHaveBeenCalled();
        const held = press(true);
        press(true);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(held.preventDefault).toHaveBeenCalled();   // no browser bookmark dialog on the repeats either
    });

    it('leaves the key alone with nothing selected, while a creator mode owns input, and in Play', () => {
        for (const o of [{ selected: 0 }, { suppress: true }, { play: true }]) {
            const { handler, press } = rig(o);
            const e = press();
            expect(handler).not.toHaveBeenCalled();
            expect(e.preventDefault).not.toHaveBeenCalled();   // the host's keymap gets it (Ctrl+D = deselect pixels)
        }
    });
});
