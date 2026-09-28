import { describe, it, expect } from 'vitest';
import {
    pickLocomotionClip, LocomotionClipDriver, resolveBlend1D, locomotionBlendStops,
    DEFAULT_LOCOMOTION_BLEND, type LocomotionState, type LocomotionClips, type BlendStop,
} from './locomotion';

const CLIPS: LocomotionClips = { idle: 'Idle', walk: 'Walk', run: 'Run', jump: 'Jump', fall: 'Fall' };
const st = (p: Partial<LocomotionState>): LocomotionState => ({ planarSpeed: 0, moving: false, grounded: true, airborne: false, rising: false, ...p });

describe('pickLocomotionClip', () => {
    it('idle when grounded + not moving', () => {
        expect(pickLocomotionClip(st({}), CLIPS)).toBe('Idle');
    });
    it('walk when moving below the run threshold', () => {
        expect(pickLocomotionClip(st({ moving: true, planarSpeed: 1.0 }), CLIPS)).toBe('Walk');
    });
    it('run when moving at/above the run threshold', () => {
        expect(pickLocomotionClip(st({ moving: true, planarSpeed: 3.0 }), CLIPS)).toBe('Run');
    });
    it('jump when airborne + rising, fall when airborne + descending', () => {
        expect(pickLocomotionClip(st({ grounded: false, airborne: true, rising: true }), CLIPS)).toBe('Jump');
        expect(pickLocomotionClip(st({ grounded: false, airborne: true, rising: false }), CLIPS)).toBe('Fall');
    });
    it('falls back gracefully when optional clips are missing', () => {
        const min: LocomotionClips = { idle: 'Idle', walk: 'Walk' };
        expect(pickLocomotionClip(st({ moving: true, planarSpeed: 5 }), min)).toBe('Walk');   // no run → walk
        expect(pickLocomotionClip(st({ grounded: false, airborne: true, rising: true, moving: true, planarSpeed: 1 }), min)).toBe('Walk'); // no jump/fall → grounded choice
        const withFall: LocomotionClips = { idle: 'Idle', walk: 'Walk', fall: 'Fall' };
        expect(pickLocomotionClip(st({ grounded: false, airborne: true, rising: true }), withFall)).toBe('Fall'); // no jump → fall
    });
    it('respects a custom run threshold', () => {
        expect(pickLocomotionClip(st({ moving: true, planarSpeed: 1.5 }), CLIPS, { runThreshold: 1.0 })).toBe('Run');
    });
});

describe('LocomotionClipDriver', () => {
    it('emits a clip name only when it changes', () => {
        const d = new LocomotionClipDriver();
        expect(d.update(st({}), CLIPS)).toBe('Idle');                              // first → emit
        expect(d.update(st({}), CLIPS)).toBe(null);                                // unchanged → null
        expect(d.update(st({ moving: true, planarSpeed: 1 }), CLIPS)).toBe('Walk'); // change → emit
        expect(d.update(st({ moving: true, planarSpeed: 1.2 }), CLIPS)).toBe(null); // still walk → null
        expect(d.update(st({ moving: true, planarSpeed: 4 }), CLIPS)).toBe('Run');  // change → emit
        expect(d.current).toBe('Run');
    });
    it('re-emits after reset', () => {
        const d = new LocomotionClipDriver();
        d.update(st({}), CLIPS);
        d.reset();
        expect(d.current).toBe(null);
        expect(d.update(st({}), CLIPS)).toBe('Idle');   // emits again after reset
    });
});

describe('locomotionBlendStops', () => {
    it('lays out idle@0, walk@walkSpeed, run@runSpeed', () => {
        const stops = locomotionBlendStops(CLIPS, { walkSpeed: 1.2, runSpeed: 3.2 });
        expect(stops).toEqual([
            { speed: 0, clip: 'Idle' }, { speed: 1.2, clip: 'Walk' }, { speed: 3.2, clip: 'Run' },
        ]);
    });
    it('omits the run stop when no run clip', () => {
        const stops = locomotionBlendStops({ idle: 'Idle', walk: 'Walk' }, DEFAULT_LOCOMOTION_BLEND);
        expect(stops.map(s => s.clip)).toEqual(['Idle', 'Walk']);
    });
    it('keeps stops strictly ascending even if run<walk in config', () => {
        const stops = locomotionBlendStops(CLIPS, { walkSpeed: 2, runSpeed: 1 });
        expect(stops[2].speed).toBeGreaterThan(stops[1].speed);   // run nudged above walk
    });
});

describe('resolveBlend1D', () => {
    const STOPS: BlendStop[] = [{ speed: 0, clip: 'Idle' }, { speed: 1.2, clip: 'Walk' }, { speed: 3.2, clip: 'Run' }];
    it('clamps at/below the first stop to a single clip', () => {
        expect(resolveBlend1D(STOPS, 0)).toEqual({ a: 'Idle', b: 'Idle', t: 0 });
        expect(resolveBlend1D(STOPS, -5)).toEqual({ a: 'Idle', b: 'Idle', t: 0 });
    });
    it('clamps at/above the last stop to a single clip', () => {
        expect(resolveBlend1D(STOPS, 3.2)).toEqual({ a: 'Run', b: 'Run', t: 0 });
        expect(resolveBlend1D(STOPS, 99)).toEqual({ a: 'Run', b: 'Run', t: 0 });
    });
    it('mixes idle↔walk in the low bracket', () => {
        const r = resolveBlend1D(STOPS, 0.6);   // halfway from 0 to 1.2
        expect(r.a).toBe('Idle'); expect(r.b).toBe('Walk');
        expect(r.t).toBeCloseTo(0.5, 5);
    });
    it('mixes walk↔run in the high bracket', () => {
        const r = resolveBlend1D(STOPS, 2.2);   // halfway from 1.2 to 3.2
        expect(r.a).toBe('Walk'); expect(r.b).toBe('Run');
        expect(r.t).toBeCloseTo(0.5, 5);
    });
    it('single stop or empty degrade safely', () => {
        expect(resolveBlend1D([{ speed: 0, clip: 'Idle' }], 5)).toEqual({ a: 'Idle', b: 'Idle', t: 0 });
        expect(resolveBlend1D([], 5)).toEqual({ a: '', b: '', t: 0 });
    });
});
