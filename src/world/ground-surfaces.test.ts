import { describe, it, expect } from 'vitest';
import { GROUND_SURFACES, resolveGroundRecipe } from './ground-surfaces';
import { MESH3D_FRAGMENT_SHADER } from '../renderer/3d/shaders/mesh3d-shaders';

describe('ground-surfaces catalog', () => {
    it('includes the shingle surface (mode 9) alongside the existing modes', () => {
        expect(GROUND_SURFACES.shingle.mode).toBe(9);
        expect(GROUND_SURFACES.ashlar.mode).toBe(0);
        expect(GROUND_SURFACES.plank.mode).toBe(8);
    });

    it('resolveGroundRecipe(shingle) → mode 9, tile = [width, width/aspect]', () => {
        const r = resolveGroundRecipe('shingle');
        expect(r.mode).toBe(9);
        // tileMm 220, aspect 1.4 → p0 = 0.22 m (shingle width), p1 = 0.22/1.4 (row height)
        expect(r.tile[0]).toBeCloseTo(0.22, 6);
        expect(r.tile[1]).toBeCloseTo(0.22 / 1.4, 6);
    });

    it('overrides apply (tint recolors, tileMm resizes)', () => {
        const r = resolveGroundRecipe('shingle', { tint: [0.7, 0.2, 0.2], tileMm: 300 });
        expect(r.tint).toEqual([0.7, 0.2, 0.2]);
        expect(r.tile[0]).toBeCloseTo(0.3, 6);
    });

    it('half-timber is mode 10, plaster tint + brown beam seam', () => {
        expect(GROUND_SURFACES.halfTimber.mode).toBe(10);
        const r = resolveGroundRecipe('halfTimber');
        expect(r.mode).toBe(10);
        // seam (beam) is a wood brown — red channel dominates and it is dark
        expect(r.seam[0]).toBeGreaterThan(r.seam[2]);
        expect(Math.max(...r.seam)).toBeLessThan(0.5);
        // tint (plaster) is a bright off-white
        expect(Math.min(...r.tint)).toBeGreaterThan(0.6);
    });

    it('toonStone reuses the ashlar tiler (mode 0) with big low-jitter blocks', () => {
        const s = GROUND_SURFACES.toonStone;
        expect(s.mode).toBe(0);                 // no new shader — a recipe over ashlar
        expect(s.tileMm).toBeGreaterThan(1000); // big blocks
        expect(s.jitter).toBeLessThan(0.5);     // flat, cel-friendly
    });

    it('radialShingle is mode 11; tile = [scallopWidth, scallopWidth/aspect]', () => {
        expect(GROUND_SURFACES.radialShingle.mode).toBe(11);
        const r = resolveGroundRecipe('radialShingle');
        expect(r.mode).toBe(11);
        expect(r.tile[0]).toBeCloseTo(0.2, 6);          // scallop width 200mm
        expect(r.tile[1]).toBeCloseTo(0.2 / 1.25, 6);   // ring height
    });
});

describe('mesh3d shader — shingle + half-timber branches are wired', () => {
    it('defines groundShingle and dispatches mode 9 in groundSurface', () => {
        expect(MESH3D_FRAGMENT_SHADER).toContain('fn groundShingle(');
        expect(MESH3D_FRAGMENT_SHADER).toContain('if (mi == 9) { return groundShingle(');
    });

    it('defines groundHalfTimber and dispatches mode 10 in groundSurface', () => {
        expect(MESH3D_FRAGMENT_SHADER).toContain('fn groundHalfTimber(');
        expect(MESH3D_FRAGMENT_SHADER).toContain('if (mi == 10) { return groundHalfTimber(');
    });

    it('defines groundRadialShingle and dispatches mode 11 in groundSurface', () => {
        expect(MESH3D_FRAGMENT_SHADER).toContain('fn groundRadialShingle(');
        expect(MESH3D_FRAGMENT_SHADER).toContain('if (mi == 11) { return groundRadialShingle(');
    });

    it('applies the shared PBR deepening (micro-AO + groove roughness + stronger relief) on the ground path', () => {
        expect(MESH3D_FRAGMENT_SHADER, 'micro-AO').toContain('gW.grout * 0.22');           // crevice occlusion
        expect(MESH3D_FRAGMENT_SHADER, 'groove roughness').toContain('gW.grout * 0.12');
        expect(MESH3D_FRAGMENT_SHADER, 'deepened relief').toContain('(hD - hU)) * 0.45');
    });

    it('defines + dispatches the A5–A7 materials (thatch/clay/bark/metal/leaves/fabric, modes 12–17)', () => {
        const wired: [string, number][] = [
            ['groundThatch', 12], ['groundClayTile', 13], ['groundBark', 14],
            ['groundMetal', 15], ['groundLeaves', 16], ['groundFabric', 17],
            ['groundWicker', 18], ['groundRope', 19],
        ];
        for (const [fn, mode] of wired) {
            expect(MESH3D_FRAGMENT_SHADER, fn).toContain(`fn ${fn}(`);
            expect(MESH3D_FRAGMENT_SHADER, fn).toContain(`if (mi == ${mode}) { return ${fn}(`);
        }
    });
});

describe('ground-surfaces catalog — A5–A7 recipes', () => {
    it('registers thatch/clay/bark/metal/leaves/fabric with their modes and sane recipes', () => {
        const expected: Record<string, number> = { thatch: 12, clayTile: 13, bark: 14, metal: 15, leaves: 16, fabric: 17, wicker: 18, rope: 19 };
        for (const [name, mode] of Object.entries(expected)) {
            const s = GROUND_SURFACES[name as keyof typeof GROUND_SURFACES];
            expect(s.mode, name).toBe(mode);
            expect(s.tileMm, name).toBeGreaterThan(0);
            expect(s.groutMm / s.tileMm, name).toBeLessThan(0.2);   // seam never eats the pattern
            expect(resolveGroundRecipe(name as keyof typeof GROUND_SURFACES).mode).toBe(mode);
        }
        // Terracotta clay is red-dominant; steel metal is a neutral grey.
        expect(GROUND_SURFACES.clayTile.tint[0]).toBeGreaterThan(GROUND_SURFACES.clayTile.tint[2]);
        expect(Math.max(...GROUND_SURFACES.metal.tint) - Math.min(...GROUND_SURFACES.metal.tint)).toBeLessThan(0.1);
    });
});
