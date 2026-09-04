import { describe, it, expect } from 'vitest';
import { deriveViewRules, normalizeViewState, viewModeLabel, DEFAULT_VIEW_STATE, type ViewTarget, type CameraMode } from './view-state';

const rules = (target: ViewTarget, cameraMode: CameraMode, showArtboardFrame = true) => deriveViewRules({ target, cameraMode, showArtboardFrame });

describe('view-state — deriveViewRules (the 2×3 matrix)', () => {
    it('illustration × 2D modes = today\'s behaviour: 2D composite + tools, locked cam, artboard output', () => {
        for (const cam of ['ortho2D', 'perspective2D'] as const) {
            const r = rules('illustration', cam);
            expect(r.twoDComposite).toBe(true);
            expect(r.artboardScissor).toBe(true);
            expect(r.twoDToolsActive).toBe(true);
            expect(r.freeNavigation).toBe(false);
            expect(r.unclampCamera).toBe(false);
            expect(r.artboardFrame).toBe(false);
            expect(r.outputIsArtboard).toBe(true);
        }
        expect(rules('illustration', 'ortho2D').projection).toBe('orthographic');
        expect(rules('illustration', 'perspective2D').projection).toBe('perspective');
    });

    it('illustration × free3D = edit in 3D, 2D hidden, artboard becomes a live frame, output STILL the artboard', () => {
        const r = rules('illustration', 'free3D');
        expect(r.twoDComposite).toBe(false);      // no scissor/composite in the viewport
        expect(r.twoDToolsActive).toBe(false);    // 2D panels hidden
        expect(r.freeNavigation).toBe(true);
        expect(r.unclampCamera).toBe(true);
        expect(r.projection).toBe('perspective');
        expect(r.artboardFrame).toBe(true);       // the viewport-vs-render split: frame is shown...
        expect(r.outputIsArtboard).toBe(true);    // ...and export still renders the artboard camera
    });

    it('artboardFrame respects the showArtboardFrame toggle', () => {
        expect(rules('illustration', 'free3D', true).artboardFrame).toBe(true);
        expect(rules('illustration', 'free3D', false).artboardFrame).toBe(false);
    });

    it('scene target = no 2D composite/tools/artboard in ANY camera mode; output is the interactive scene', () => {
        for (const cam of ['ortho2D', 'perspective2D', 'free3D'] as const) {
            const r = rules('scene', cam);
            expect(r.twoDComposite).toBe(false);
            expect(r.artboardScissor).toBe(false);
            expect(r.twoDToolsActive).toBe(false);
            expect(r.artboardFrame).toBe(false);
            expect(r.outputIsArtboard).toBe(false);
        }
    });

    it('freeNavigation + projection track the camera mode in BOTH targets', () => {
        for (const t of ['illustration', 'scene'] as const) {
            expect(rules(t, 'ortho2D').freeNavigation).toBe(false);
            expect(rules(t, 'perspective2D').freeNavigation).toBe(false);
            expect(rules(t, 'free3D').freeNavigation).toBe(true);
            expect(rules(t, 'ortho2D').projection).toBe('orthographic');
            expect(rules(t, 'perspective2D').projection).toBe('perspective');
            expect(rules(t, 'free3D').projection).toBe('perspective');
        }
    });
});

describe('view-state — persistence normalization', () => {
    it('missing/empty → the default illustration/ortho2D (so old saves load unchanged)', () => {
        expect(normalizeViewState(undefined)).toEqual(DEFAULT_VIEW_STATE);
        expect(normalizeViewState(null)).toEqual(DEFAULT_VIEW_STATE);
        expect(normalizeViewState({})).toEqual(DEFAULT_VIEW_STATE);
    });
    it('coerces unknown enum values to safe defaults, preserves poses', () => {
        const n = normalizeViewState({ target: 'bogus' as ViewTarget, cameraMode: 'nope' as CameraMode, freeCam: { target: [1, 2, 3], radius: 5, yaw: 0, pitch: 0, projection: 'perspective' } });
        expect(n.target).toBe('illustration');
        expect(n.cameraMode).toBe('ortho2D');
        expect(n.freeCam?.radius).toBe(5);
    });
    it('round-trips a full scene/free3D state', () => {
        const n = normalizeViewState({ target: 'scene', cameraMode: 'free3D', showArtboardFrame: false });
        expect(n.target).toBe('scene'); expect(n.cameraMode).toBe('free3D'); expect(n.showArtboardFrame).toBe(false);
    });
});

describe('view-state — labels', () => {
    it('names each cell', () => {
        expect(viewModeLabel({ target: 'illustration', cameraMode: 'ortho2D' })).toBe('Illustration · 2D Ortho');
        expect(viewModeLabel({ target: 'scene', cameraMode: 'free3D' })).toBe('Scene · 3D Free');
    });
});
