import { describe, it, expect } from 'vitest';
import { DEFAULT_MATERIAL, encodeMaterialFlags } from './material-3d';

const NO_ENV_REFLECTION_BIT = 33554432;   // bit 25

describe('encodeMaterialFlags — noEnvReflection (per-object matte)', () => {
    it('sets bit 25 when noEnvReflection is on, clears it otherwise', () => {
        expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, noEnvReflection: true }) & NO_ENV_REFLECTION_BIT).toBe(NO_ENV_REFLECTION_BIT);
        expect(encodeMaterialFlags(DEFAULT_MATERIAL) & NO_ENV_REFLECTION_BIT).toBe(0);
    });

    it('composes with other flags without collision (raw u32, so bit 25 is safe)', () => {
        const f = encodeMaterialFlags({ ...DEFAULT_MATERIAL, noEnvReflection: true, garpTex: true, hasTexture: true });
        expect(f & NO_ENV_REFLECTION_BIT).toBe(NO_ENV_REFLECTION_BIT);   // bit 25
        expect(f & 16777216).toBe(16777216);                            // bit 24 garpTex intact
        expect(f & 1).toBe(1);                                          // bit 0 hasTexture intact
    });
});
