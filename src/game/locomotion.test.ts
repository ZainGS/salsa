import { describe, it, expect } from 'vitest';
import { pickLocomotionClip, LocomotionClipDriver, type LocomotionState, type LocomotionClips } from './locomotion';

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
