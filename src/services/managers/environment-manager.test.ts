import { describe, it, expect } from 'vitest';
import { EnvironmentManager, normalizeEnvironmentState, DEFAULT_ENVIRONMENT, type EnvironmentApplyTarget } from './environment-manager';

describe('normalizeEnvironmentState', () => {
    it('fills a null/empty blob with today\'s defaults', () => {
        const s = normalizeEnvironmentState(null);
        expect(s.fog.mode).toBe(DEFAULT_ENVIRONMENT.fog.mode);
        expect(s.sun.intensity).toBe(1);
        expect(s.ambient.color).toEqual(DEFAULT_ENVIRONMENT.ambient.color);
        expect(s.sky!.model).toBe('gradient');
        expect(s.reflections!.ssr).toBe(false);
        expect(s.heightFog!.enabled).toBe(false);
    });
    it('keeps provided fields + defaults the rest', () => {
        const s = normalizeEnvironmentState({ fog: { mode: 'linear', color: [1, 0, 0], near: 2, far: 9, density: 0.2 }, sun: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 2 } });
        expect(s.fog.mode).toBe('linear');
        expect(s.fog.far).toBe(9);
        expect(s.sun.intensity).toBe(2);
        expect(s.ambient.intensity).toBe(1);   // defaulted
    });
    it('does not alias the default arrays (deep copy)', () => {
        const s = normalizeEnvironmentState(null);
        s.sun.direction[0] = 99;
        expect(DEFAULT_ENVIRONMENT.sun.direction[0]).not.toBe(99);
    });
});

describe('EnvironmentManager', () => {
    it('records sun/ambient/fog into the state', () => {
        const env = new EnvironmentManager();
        env.recordSun([0, -1, 0], [1, 0.9, 0.8], 1.5);
        env.recordAmbient([0.2, 0.2, 0.3], 0.8);
        env.recordFog({ mode: 'linear', far: 40 });
        expect(env.state.sun.intensity).toBe(1.5);
        expect(env.state.ambient.color).toEqual([0.2, 0.2, 0.3]);
        expect(env.state.fog.mode).toBe('linear');
        expect(env.state.fog.far).toBe(40);
    });

    it('applyAll pushes sun/ambient/fog to the target in order', () => {
        const calls: string[] = [];
        const target: EnvironmentApplyTarget = {
            setDirectionalLight: () => calls.push('dir'),
            setAmbientLight: () => calls.push('amb'),
            setFog: () => calls.push('fog'),
        };
        const env = new EnvironmentManager();
        env.recordSun([0, -1, 0], [1, 1, 1], 1);
        env.applyAll(target);
        expect(calls).toEqual(['dir', 'amb', 'fog']);
    });

    it('reflections default off with SSR knobs, and setReflections patches them', () => {
        const env = new EnvironmentManager();
        expect(env.state.reflections.ssr).toBe(false);
        expect(env.state.reflections.ssrMaxSteps).toBeGreaterThan(0);
        env.setReflections({ ssr: true, ssrIntensity: 0.5 });
        expect(env.state.reflections.ssr).toBe(true);
        expect(env.state.reflections.ssrIntensity).toBe(0.5);
        expect(env.state.reflections.ssrMaxSteps).toBe(DEFAULT_ENVIRONMENT.reflections.ssrMaxSteps);   // untouched
    });

    it('serialize → restore round-trips', () => {
        const env = new EnvironmentManager();
        env.recordFog({ mode: 'exponential', density: 0.05 });
        env.recordSun([1, -2, 3], [0.5, 0.6, 0.7], 0.9);
        const blob = env.serialize();
        const env2 = new EnvironmentManager();
        env2.restore(blob);
        expect(env2.state.fog.mode).toBe('exponential');
        expect(env2.state.sun.color).toEqual([0.5, 0.6, 0.7]);
    });
});
