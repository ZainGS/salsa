/**
 * Step 3 SCENE BUDGETS (docs/ui/performance.md §Budgets): a frame's drawn triangles / draw calls, the resident
 * geometry and the instanced copies against limits, with a one-line warning for a HUD. Pure (Scene3DManager feeds it
 * the renderer's counters), so it is unit-tested headless.
 */

export interface SceneBudgetLimits { drawnTris: number; drawCalls: number; geometryMB: number; instances: number }
export type SceneBudgetKey = keyof SceneBudgetLimits;
export interface SceneBudgetOver { key: SceneBudgetKey; value: number; limit: number; ratio: number }

/** The defaults: about 3 M triangles drawn, 2 k draw calls, 500 MB of geometry, 200 k instanced copies. */
export const SCENE_BUDGET_DEFAULTS: Readonly<SceneBudgetLimits> = { drawnTris: 3_000_000, drawCalls: 2000, geometryMB: 500, instances: 200_000 };

/** A value as the HUD shows it ("6.1 M tris", "3.4 k draws", "812 MB geometry", "40 k instances"). */
export function formatBudgetValue(key: SceneBudgetKey, v: number): string {
    if (key === 'drawnTris') return `${(v / 1e6).toFixed(1)} M tris`;
    if (key === 'drawCalls') return `${v >= 1000 ? (v / 1000).toFixed(1) + ' k' : Math.round(v)} draws`;
    if (key === 'geometryMB') return `${Math.round(v)} MB geometry`;
    return `${v >= 1000 ? (v / 1000).toFixed(0) + ' k' : Math.round(v)} instances`;
}

/** The keys over their limit (a limit of 0 = none) and the warning line (null when everything is within). */
export function evaluateSceneBudget(values: SceneBudgetLimits, limits: SceneBudgetLimits): { over: SceneBudgetOver[]; warning: string | null } {
    const over: SceneBudgetOver[] = [];
    for (const key of ['drawnTris', 'drawCalls', 'geometryMB', 'instances'] as const) {
        const lim = limits[key], v = values[key];
        if (lim > 0 && v > lim) over.push({ key, value: v, limit: lim, ratio: +(v / lim).toFixed(2) });
    }
    const warning = over.length ? 'Over budget: ' + over.map((o) => `${formatBudgetValue(o.key, o.value)} (${formatBudgetValue(o.key, o.limit)})`).join(', ') : null;
    return { over, warning };
}
