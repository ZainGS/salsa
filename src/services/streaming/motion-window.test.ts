import { describe, it, expect } from 'vitest';
import { FocusMotion, MOTION_DEFAULTS, MOTION_TELEPORT_TILES, MOTION_GAP_MS, sanitizeMotion, predictedWindowTiles, fastWindowTier, keepUpTiles, corridorTiles, CORRIDOR_LATENCY_MARGIN } from './motion-window';
import { oldTierFadeLevel } from './hlod-select';

// performance-plan P19 — the speed-aware window: the motion estimate (explicit times, no wall clock), the prediction,
// the fast state's hysteresis, the predicted window's order, the fast tier rule, the old-tier dissolve levels.

const SPAN = 20;
/** Feed a straight run at `tps` tiles/s along +x for `ms`, in `dt` steps, starting at (x0, 0) at time t0. */
function run(m: FocusMotion, tps: number, ms: number, t0 = 0, x0 = 0, dt = 16): { t: number; x: number; flips: number } {
    let t = t0, x = x0, flips = 0;
    for (let e = 0; e < ms; e += dt) { t += dt; x += tps * SPAN * dt / 1000; if (m.update(x, 0, t, SPAN)) flips++; }
    return { t, x, flips };
}

describe('P19 FocusMotion (velocity, prediction, fast state)', () => {
    it('a steady run converges to its speed and direction; still = zero', () => {
        const m = new FocusMotion();
        expect(m.update(0, 0, 0, SPAN)).toBe(false);   // first sample: no estimate yet
        run(m, 0.5, 2000);
        expect(m.speed).toBeCloseTo(0.5, 3);
        expect(m.vx).toBeCloseTo(0.5, 3);
        expect(m.vz).toBeCloseTo(0, 6);
        const s = new FocusMotion();
        for (let t = 0; t < 1000; t += 16) s.update(5, 5, t, SPAN);
        expect(s.speed).toBe(0);
        expect(s.lead()).toEqual([0, 0]);
    });

    it('the lead is velocity × look-ahead, capped at maxLeadTiles', () => {
        const m = new FocusMotion();
        run(m, 0.25, 3000);
        const [lx, lz] = m.lead();
        expect(lx).toBeCloseTo(Math.min(MOTION_DEFAULTS.maxLeadTiles, 0.25 * MOTION_DEFAULTS.lookAheadS), 2);
        expect(lz).toBeCloseTo(0, 6);
        run(m, 3, 3000, 3000, 3000 * 0.25 * SPAN / 1000);
        expect(Math.hypot(...m.lead())).toBeCloseTo(MOTION_DEFAULTS.maxLeadTiles, 6);
        expect(m.landingLead()[0]).toBeCloseTo(6, 6);   // 3 tiles/s × 3 s = 9 → capped at 6
    });

    it('fast: entered at fastTiles, held above slowTiles, left only after settleMs under slowTiles', () => {
        const m = new FocusMotion();
        let r = run(m, 0.6, 3000);
        expect(m.state).toBe('slow');                  // 0.6 < 0.75
        r = run(m, 1, 2000, r.t, r.x);
        expect(m.state).toBe('fast');
        expect(r.flips).toBe(1);
        r = run(m, 0.5, 3000, r.t, r.x);               // between slow (0.4) and fast: held
        expect(m.state).toBe('fast');
        // stop: the estimate decays; the state leaves once under 0.4 for settleMs, not before
        let t = r.t, left = -1, under = -1;
        for (let i = 0; i < 200; i++) {
            t += 16;
            m.update(r.x, 0, t, SPAN);
            if (under < 0 && m.speed < MOTION_DEFAULTS.slowTiles) under = t;
            if (m.state === 'slow') { left = t; break; }
        }
        expect(under).toBeGreaterThan(0);
        expect(left - under).toBeGreaterThanOrEqual(MOTION_DEFAULTS.settleMs - 16);
        expect(left - under).toBeLessThanOrEqual(MOTION_DEFAULTS.settleMs + 16);
        expect(m.settling).toBe(true);   // still decaying: callers keep rendering a little longer
        for (let i = 0; i < 400; i++) { t += 16; m.update(r.x, 0, t, SPAN); }
        expect(m.settling).toBe(false);
    });

    it('a brief dip under slowTiles does not end the fast state', () => {
        const m = new FocusMotion();
        let r = run(m, 1.2, 2000);
        expect(m.state).toBe('fast');
        // ~150 ms nearly stopped (a speed dip shorter than settleMs), then fast again
        r = run(m, 0.05, 150, r.t, r.x);
        r = run(m, 1.2, 1500, r.t, r.x);
        expect(m.state).toBe('fast');
    });

    it('a teleport or a long gap restarts the estimate (no phantom speed)', () => {
        const m = new FocusMotion();
        const r = run(m, 0.3, 2000);
        m.update(r.x + (MOTION_TELEPORT_TILES + 1) * SPAN, 0, r.t + 16, SPAN);
        expect(m.speed).toBe(0);
        expect(m.state).toBe('slow');
        const n = new FocusMotion();
        const q = run(n, 0.3, 2000);
        n.update(q.x + SPAN * 0.5, 0, q.t + MOTION_GAP_MS + 1, SPAN);   // half a tile after a stall: not 0.5 tile/frame
        expect(n.speed).toBe(0);
        // a one-frame jump of a tile (a camera cut): not motion either
        const c = new FocusMotion();
        const q2 = run(c, 0.3, 2000);
        c.update(q2.x + SPAN * 1.1, 0, q2.t + 16, SPAN);
        expect(c.speed).toBe(0);
        expect(c.state).toBe('slow');
        // same timestamp / bad input: ignored
        expect(n.update(q.x, 0, q.t + MOTION_GAP_MS + 1, SPAN)).toBe(false);
        expect(n.update(NaN, 0, q.t + 5000, SPAN)).toBe(false);
        n.reset(); expect(n.speed).toBe(0); expect(n.state).toBe('slow');
    });

    it('adaptive: the window keeps up only while a new row lands before the focus reaches it', () => {
        // 3×3, lead 1: the new row's near edge is 1.88 tiles ahead → 3 s latency keeps up to 0.63 tiles/s
        expect(keepUpTiles(3, 1, 1)).toBeCloseTo(1.88 / 3, 6);
        expect(keepUpTiles(6, 1, 1)).toBeCloseTo(1.88 / 6, 6);   // a slower landing (a busy main thread) lowers it
        expect(keepUpTiles(0.1, 1, 1)).toBeCloseTo(1.88 / 0.5, 6); // latency floored at 0.5 s
        expect(keepUpTiles(3, 0, 0)).toBeCloseTo(0.05 / 3, 6);   // 1×1, no lead: the floor
        const m = new FocusMotion();
        m.keepUp = keepUpTiles(8, 1, 1);   // ~0.24 tiles/s
        expect(m.capAt).toBeCloseTo(0.235, 3);
        expect(m.fastAt).toBe(MOTION_DEFAULTS.fastTiles);
        let r = run(m, 0.35, 2000);
        expect(m.state).toBe('capped');    // 0.35 tiles/s: the full window cannot keep up at 8 s a tile → the corridor
        r = run(m, 0.2, 1500, r.t, r.x);
        expect(m.state).toBe('capped');    // under 0.235 but above its band (0.235 × 0.4 / 0.75 = 0.125)
        r = run(m, 1.2, 1500, r.t, r.x);
        expect(m.state).toBe('fast');      // a fly speed: no new full builds
        r = run(m, 0.3, 2000, r.t, r.x);
        expect(m.state).toBe('capped');    // under slowTiles for settleMs, still above the capped band → back to capped
        run(m, 0.05, 2000, r.t, r.x);
        expect(m.state).toBe('slow');
        const o = new FocusMotion({ ...MOTION_DEFAULTS, adaptive: false });
        o.keepUp = 0.1;
        expect(o.capAt).toBe(MOTION_DEFAULTS.fastTiles);
        run(o, 0.35, 2000);
        expect(o.state).toBe('slow');      // adaptive off: no capped band
        const big = new FocusMotion(); big.keepUp = 50;
        expect(big.capAt).toBe(MOTION_DEFAULTS.fastTiles);   // never above fastTiles
        const b = run(big, 0.6, 2000);
        expect(big.state).toBe('slow');
        run(big, 1, 1000, b.t, b.x);
        expect(big.state).toBe('fast');
    });

    it('capped corridor: the own tile, then the tiles along the path out to speed × latency × margin + pad', () => {
        // still / no speed: just the own tile
        expect(corridorTiles([4, 0], 4.3, 0.2, 0, 0, 3, 4, 4)).toEqual([[4, 0]]);
        // 0.35 tiles/s, 3 s latency: reach 0.35 × 3 × 1.25 + 0.75 = 2.06 → x 4.3 .. 6.36 → tiles 4, 5, 6
        expect(CORRIDOR_LATENCY_MARGIN).toBe(1.25);
        expect(corridorTiles([4, 0], 4.3, 0.2, 0.35, 0, 3, 4, 4)).toEqual([[4, 0], [5, 0], [6, 0]]);
        // a slower landing reaches further, up to the cap of tiles / of reach
        expect(corridorTiles([4, 0], 4.3, 0.2, 0.35, 0, 8, 9, 4)).toEqual([[4, 0], [5, 0], [6, 0], [7, 0], [8, 0]]);
        expect(corridorTiles([4, 0], 4.3, 0.2, 0.35, 0, 8, 3, 4)).toEqual([[4, 0], [5, 0], [6, 0]]);
        // the hysteretic own tile may differ from the tile under the focus: both are in, own first
        expect(corridorTiles([3, 0], 3.6, 0, 0.35, 0, 0, 4, 4)).toEqual([[3, 0], [4, 0]]);   // reach 0.75 → x 4.35
        // a diagonal path crosses the tiles it passes through (each once)
        const d = corridorTiles([0, 0], 0, 0, 0.3, 0.3, 4, 9, 4);
        expect(d[0]).toEqual([0, 0]);
        expect(new Set(d.map(t => t.join())).size).toBe(d.length);
        expect(d[d.length - 1][0]).toBeGreaterThan(0); expect(d[d.length - 1][1]).toBeGreaterThan(0);
        // walk the focus at 0.35 tiles/s: every tile joins the corridor at least latency × margin before the focus
        // reaches its near edge (a build dispatched then lands in time)
        const first = new Map<number, number>(), L = 3, v = 0.35;
        for (let t = 0; t <= 20; t += 0.05) {
            const f = 4 + v * t;
            for (const [tx] of corridorTiles([Math.round(f), 0], f, 0, v, 0, L, 9, 8)) if (!first.has(tx)) first.set(tx, t);
        }
        for (const [tx, t0] of first) {
            if (tx <= 5) continue;   // the tiles in the corridor at the start
            const reach = (tx - 0.5 - 4) / v;   // when the focus reaches the tile's near edge
            expect(reach - t0).toBeGreaterThanOrEqual(L * CORRIDOR_LATENCY_MARGIN - 0.125 / v - 0.05);
        }
    });

    it('sanitizeMotion clamps and ignores junk; slowTiles never above fastTiles', () => {
        const o = sanitizeMotion({ ...MOTION_DEFAULTS }, { fastTiles: 0.5, slowTiles: 9, lookAheadS: -3, fast: 'landing', tauMs: NaN } as never);
        expect(o.fastTiles).toBe(0.5);
        expect(o.slowTiles).toBe(0.5);
        expect(o.lookAheadS).toBe(0);
        expect(o.fast).toBe('landing');
        expect(o.tauMs).toBe(MOTION_DEFAULTS.tauMs);
        expect(sanitizeMotion(o, { fast: 'bogus' } as never).fast).toBe('landing');
        expect(sanitizeMotion(o, null)).toEqual(o);
    });
});

describe('P19 predicted window', () => {
    it('3×3 around the predicted tile, ordered ahead-first (by distance to the predicted point)', () => {
        const t = predictedWindowTiles([5, 0], [4, 0], 1, 5.3, 0);
        expect(t.length).toBe(9);
        expect(t[0]).toEqual([5, 0]);
        expect(t[1]).toEqual([6, 0]);                                 // ahead before behind
        expect(t.findIndex(x => x[0] === 6 && x[1] === 0)).toBeLessThan(t.findIndex(x => x[0] === 4 && x[1] === 0));
        expect(t.some(x => x[0] === 4 && x[1] === 0)).toBe(true);   // the own tile is inside the 3×3 already (no extra)
    });
    it('1×1: the tile under the focus stays in when the lead moved the centre off it', () => {
        expect(predictedWindowTiles([5, 0], [4, 0], 0, 5.1, 0)).toEqual([[5, 0], [4, 0]]);
        expect(predictedWindowTiles([4, 0], [4, 0], 0, 4.2, 0)).toEqual([[4, 0]]);
    });
    it('fast tier rule: already-full tiles stay full; others are stand-ins (landing: the landing tile full); slow / off = full', () => {
        expect(fastWindowTier(false, 'hlod', false, false)).toBe('full');
        expect(fastWindowTier(true, 'off', false, false)).toBe('full');
        expect(fastWindowTier(true, 'hlod', true, false)).toBe('full');
        expect(fastWindowTier(true, 'hlod', false, true)).toBe('stand');
        expect(fastWindowTier(true, 'landing', false, true)).toBe('full');
        expect(fastWindowTier(true, 'landing', false, false)).toBe('stand');
    });
});

describe('P19 old-tier dissolve levels', () => {
    it('quantised: whole (-1) near 1, then 3/4, 1/2, 1/4; never 0 (the tier is disposed at the end instead)', () => {
        expect(oldTierFadeLevel(1, 4)).toBe(-1);
        expect(oldTierFadeLevel(0.9, 4)).toBe(-1);
        expect(oldTierFadeLevel(0.8, 4)).toBe(0.75);
        expect(oldTierFadeLevel(0.5, 4)).toBe(0.5);
        expect(oldTierFadeLevel(0.3, 4)).toBe(0.25);
        expect(oldTierFadeLevel(0.01, 4)).toBe(0.25);
        expect(oldTierFadeLevel(0.5, 1)).toBe(-1);
        // a smooth 1 → 0 ramp visits each level once, in order (a few material rewrites per tile, not one per frame)
        const seen: number[] = [];
        for (let v = 1; v >= 0; v -= 0.01) { const l = oldTierFadeLevel(v, 4); if (seen[seen.length - 1] !== l) seen.push(l); }
        expect(seen).toEqual([-1, 0.75, 0.5, 0.25]);
    });
});
