import { describe, it, expect } from 'vitest';
import { GameLoop } from './game-loop';

/** A fake clock + manual scheduler so the loop runs deterministically with no browser. */
function harness(step = 1 / 60, maxStepsPerFrame = 100) {
    let t = 0;                       // ms
    let pending: (() => void) | null = null;
    const loop = new GameLoop({
        step,
        maxStepsPerFrame,
        now: () => t,
        schedule: (cb) => { pending = cb; return 1; },
        cancel: () => { pending = null; },
    });
    return {
        loop,
        advance: (ms: number) => { t += ms; },          // move the clock
        frame: () => { const cb = pending; pending = null; cb?.(); },   // run the scheduled frame
        get hasPending() { return pending !== null; },
    };
}

describe('GameLoop', () => {
    it('runs fixed steps proportional to elapsed time (accumulator)', () => {
        const h = harness(1 / 60);   // 16.667ms/step
        let steps = 0, renders = 0;
        h.loop.start(() => steps++, () => renders++);
        h.advance(100);              // 100ms ≈ 6 steps
        h.frame();
        expect(steps).toBe(6);
        expect(renders).toBe(1);     // one render tick per frame regardless
    });

    it('carries the remainder across frames (no time lost)', () => {
        const h = harness(1 / 60);
        let steps = 0;
        h.loop.start(() => steps++);
        h.advance(10); h.frame();    // 10ms < one step → 0 steps, 10ms banked
        expect(steps).toBe(0);
        h.advance(10); h.frame();    // 20ms total → 1 step
        expect(steps).toBe(1);
    });

    it('caps steps per frame (no spiral of death on a huge hitch)', () => {
        const h = harness(1 / 60, 5);   // low cap
        let steps = 0;
        h.loop.start(() => steps++);
        h.advance(100000);           // enormous stall
        h.frame();
        expect(steps).toBe(5);       // capped, backlog dropped
    });

    it('start/stop gate the scheduler', () => {
        const h = harness();
        expect(h.loop.isRunning).toBe(false);
        h.loop.start(() => {});
        expect(h.loop.isRunning).toBe(true);
        expect(h.hasPending).toBe(true);
        h.loop.stop();
        expect(h.loop.isRunning).toBe(false);
        expect(h.hasPending).toBe(false);
        // A frame after stop is inert (double-stop safe).
        h.loop.stop();
    });

    it('reschedules itself each frame while running', () => {
        const h = harness();
        h.loop.start(() => {});
        h.advance(16); h.frame();
        expect(h.hasPending).toBe(true);   // queued the next frame
    });
});
