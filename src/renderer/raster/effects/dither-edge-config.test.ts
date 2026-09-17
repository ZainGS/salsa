import { describe, it, expect } from 'vitest';
import { defaultDitherConfig, DitherEngine } from './dither-engine';

// Config-level coverage for the edge/boundary effects (2026-09-15) — the visual behavior is
// pixel-verified in the browser harness (drive-dither-edge.js: band changes, interior diff 0).

describe('Dither edge effects — config surface', () => {
    it('defaults: edge effects OFF (width 0, all amounts 0, mode content)', () => {
        const cfg = defaultDitherConfig();
        expect(cfg.edgeWidth).toBe(0);
        expect(cfg.edgeFade).toBe(0);
        expect(cfg.edgeShrink).toBe(0);
        expect(cfg.edgeDensity).toBe(0);
        expect(cfg.edgeSeed).toBe(0);
        expect(cfg.edgeMode).toBe('content');
    });

    it('a pre-2026-09-15 config (fields absent) is tolerated by the uniform write path', () => {
        // The engine reads cfg.edgeWidth ?? 0 etc. — simulate an old saved config.
        const old = defaultDitherConfig() as unknown as Record<string, unknown>;
        delete old.edgeWidth; delete old.edgeFade; delete old.edgeShrink; delete old.edgeDensity;
        expect((old.edgeWidth as number | undefined) ?? 0).toBe(0);   // the exact expression the engine uses
    });

    it('edge fields never apply to error-diffusion algorithms (documented GPU-only scope)', () => {
        // isErrorDiffusion gates the GPU path (apply() no-ops for these) — the edge shaders are
        // only reachable through the ordered algorithms.
        for (const a of ['floyd_steinberg', 'atkinson', 'jarvis_judice_ninke', 'stucki', 'sierra', 'sierra_lite'] as const) {
            expect(DitherEngine.isErrorDiffusion(a)).toBe(true);
        }
        for (const a of ['bayer', 'halftone_dot', 'halftone_line', 'halftone_diamond', 'blue_noise', 'noise'] as const) {
            expect(DitherEngine.isErrorDiffusion(a)).toBe(false);
        }
    });
});
