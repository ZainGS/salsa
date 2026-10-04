import { describe, it, expect } from 'vitest';
import { planSpanCompaction, planPoolShrink } from './geom-compaction';

// Simulate the plan on a byte array exactly as the renderer encodes it: each move = copy src → scratch, then
// scratch → dst (two separate copies, in order). Every span must end up, byte for byte, at its new offset.
function run(spans: { off: number; size: number }[], cap: number, scratch: number, seed: number, coalesce = false): number {
    const buf = new Uint8Array(cap);
    let x = seed >>> 0;
    const rnd = (): number => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x; };
    const want = spans.map(sp => { const b = new Uint8Array(sp.size); for (let i = 0; i < sp.size; i++) b[i] = rnd() & 255; buf.set(b, sp.off); return b; });
    // dead space between spans gets garbage too (a stale geometry the compaction must not resurrect)
    const plan = planSpanCompaction(spans, scratch, coalesce);
    const tmp = new Uint8Array(scratch);
    for (const [src, dst, size] of plan.moves) {
        expect(size).toBeLessThanOrEqual(scratch);
        tmp.set(buf.subarray(src, src + size), 0);
        buf.set(tmp.subarray(0, size), dst);
    }
    let total = 0;
    spans.forEach((sp, k) => {
        total += sp.size;
        expect(plan.newOff[k]).toBeLessThanOrEqual(sp.off);
        expect(Array.from(buf.subarray(plan.newOff[k], plan.newOff[k] + sp.size))).toEqual(Array.from(want[k]));
    });
    expect(plan.tail).toBe(total);
    // dense + disjoint: sorted new spans tile [0, tail) exactly
    const sorted = spans.map((sp, k) => [plan.newOff[k], sp.size]).sort((a, b) => a[0] - b[0]);
    let cur = 0;
    for (const [o, s] of sorted) { expect(o).toBe(cur); cur += s; }
    return plan.moves.length;
}

describe('planSpanCompaction (P10.B6 GPU geometry-pool compaction)', () => {
    it('packs disjoint spans into a dense prefix, preserving every byte (random layouts, chunked moves)', () => {
        for (let t = 0; t < 60; t++) {
            let x = (t * 2654435761) >>> 0;
            const rnd = (n: number): number => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x % n; };
            const spans: { off: number; size: number }[] = [];
            let off = rnd(64) * 4;
            const n = 1 + rnd(40);
            for (let i = 0; i < n; i++) {
                const size = (1 + rnd(50)) * 4;
                spans.push({ off, size });
                off += size + rnd(4) * rnd(30) * 4;   // gaps (dead space), often none
            }
            for (let i = spans.length - 1; i > 0; i--) { const j = rnd(i + 1); [spans[i], spans[j]] = [spans[j], spans[i]]; }   // input order ≠ offset order
            run(spans, off + 64, 4 * (1 + rnd(12)), t);   // tiny scratch → big spans move in many chunks
        }
    });

    it('emits no move for spans already in place, and handles empty spans', () => {
        const plan = planSpanCompaction([{ off: 0, size: 16 }, { off: 16, size: 0 }, { off: 16, size: 8 }, { off: 40, size: 8 }], 64);
        expect(plan.newOff).toEqual([0, 16, 16, 24]);
        expect(plan.moves).toEqual([[40, 24, 8]]);
        expect(plan.tail).toBe(32);
    });

    it('moves a span that overlaps its own destination in ascending chunks (never reads overwritten bytes)', () => {
        run([{ off: 12, size: 40 }], 64, 8, 7);   // dst [0,40) overlaps src [12,52)
    });
});

// performance-plan P10.D4 (bug-hunt D-R1): the pool releases capacity once streaming has moved on.
describe('planPoolShrink', () => {
    const MB = 1 << 20;
    it('shrinks a buffer > 3x its live bytes to 1.6x (4-byte aligned), never below the floor', () => {
        expect(planPoolShrink(1800 * MB, 100 * MB)).toBe(160 * MB);
        expect(planPoolShrink(1800 * MB, 10 * MB)).toBe(64 * MB);          // floor
        expect(planPoolShrink(1800 * MB, 0)).toBe(64 * MB);                // empty pool → the floor
        expect(planPoolShrink(1800 * MB, 100 * MB + 1)! % 4).toBe(0);
    });
    it('keeps the buffer when it is not oversized, or already at the floor', () => {
        expect(planPoolShrink(900 * MB, 400 * MB)).toBeNull();             // 2.25x — inside the trigger
        expect(planPoolShrink(250 * MB, 100 * MB)).toBeNull();             // a fresh rebuild's 2.5x headroom never shrinks
        expect(planPoolShrink(64 * MB, 1 * MB)).toBeNull();                // at the floor
        expect(planPoolShrink(100 * MB, 70 * MB)).toBeNull();
    });
    it('a shrink then a regrow to the same live size does not oscillate', () => {
        let cap = 2000 * MB;
        const live = 200 * MB;
        cap = planPoolShrink(cap, live) ?? cap;
        expect(cap).toBe(320 * MB);
        expect(planPoolShrink(cap, live)).toBeNull();                       // stable
        expect(planPoolShrink(Math.ceil(live * 1.5), live)).toBeNull();     // the x1.5 growth path doesn't trigger it either
    });
});

describe('planSpanCompaction P16 coalesced runs', () => {
    it('same bytes at the same new offsets as the per-span plan, with far fewer moves on run-heavy layouts', () => {
        let fewer = 0;
        for (let t = 0; t < 60; t++) {
            let x = (t * 40503 + 7) >>> 0;
            const rnd = (n: number): number => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x % n; };
            const spans: { off: number; size: number }[] = [];
            let off = rnd(64) * 4;
            for (let i = 0, n = 1 + rnd(60); i < n; i++) {
                const size = (1 + rnd(50)) * 4;
                spans.push({ off, size });
                off += size + (rnd(6) === 0 ? rnd(30) * 4 : 0);   // long adjacent runs, a hole now and then (tiles that left)
            }
            const shuffled = spans.slice();
            for (let i = shuffled.length - 1; i > 0; i--) { const j = rnd(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
            const scratch = 4 * (1 + rnd(40));
            const a = planSpanCompaction(shuffled, scratch), b = planSpanCompaction(shuffled, scratch, true);
            expect(b.newOff).toEqual(a.newOff);
            expect(b.tail).toBe(a.tail);
            const nPer = run(shuffled, off + 64, scratch, t), nRun = run(shuffled, off + 64, scratch, t, true);
            expect(nRun).toBeLessThanOrEqual(nPer);
            if (nRun < nPer) fewer++;
        }
        expect(fewer).toBeGreaterThan(30);
    });
    it('an in-place prefix emits nothing; a run is one move', () => {
        const plan = planSpanCompaction([{ off: 0, size: 16 }, { off: 16, size: 8 }, { off: 40, size: 8 }, { off: 48, size: 8 }, { off: 56, size: 0 }, { off: 56, size: 4 }], 64, true);
        expect(plan.newOff).toEqual([0, 16, 24, 32, 40, 40]);
        expect(plan.moves).toEqual([[40, 24, 20]]);
    });
});
