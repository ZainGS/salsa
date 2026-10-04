import { describe, it, expect } from 'vitest';
import { evaluateSceneBudget, formatBudgetValue, SCENE_BUDGET_DEFAULTS } from './scene-budget';

describe('scene budgets (step 3)', () => {
    it('within budget: no warning', () => {
        const r = evaluateSceneBudget({ drawnTris: 1e6, drawCalls: 900, geometryMB: 120, instances: 5000 }, SCENE_BUDGET_DEFAULTS);
        expect(r.over).toEqual([]);
        expect(r.warning).toBeNull();
    });
    it('over: every key over its limit, in order, with the ratio and one warning line', () => {
        const r = evaluateSceneBudget({ drawnTris: 6.1e6, drawCalls: 3400, geometryMB: 1100, instances: 10 }, SCENE_BUDGET_DEFAULTS);
        expect(r.over.map((o) => o.key)).toEqual(['drawnTris', 'drawCalls', 'geometryMB']);
        expect(r.over[0].ratio).toBeCloseTo(2.03, 2);
        expect(r.warning).toBe('Over budget: 6.1 M tris (3.0 M tris), 3.4 k draws (2.0 k draws), 1100 MB geometry (500 MB geometry)');
    });
    it('a limit of 0 = no limit', () => {
        expect(evaluateSceneBudget({ drawnTris: 9e9, drawCalls: 0, geometryMB: 0, instances: 0 }, { ...SCENE_BUDGET_DEFAULTS, drawnTris: 0 }).warning).toBeNull();
    });
    it('formats', () => {
        expect(formatBudgetValue('instances', 250000)).toBe('250 k instances');
        expect(formatBudgetValue('drawCalls', 812)).toBe('812 draws');
    });
});
