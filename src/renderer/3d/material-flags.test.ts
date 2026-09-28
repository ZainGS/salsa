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

describe('encodeMaterialFlags — softLighting (bit 28)', () => {
    const SOFT_BIT = 268435456;   // bit 28
    it('sets bit 28 when softLighting is on, clears it otherwise', () => {
        expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, softLighting: true }) & SOFT_BIT).toBe(SOFT_BIT);
        expect(encodeMaterialFlags(DEFAULT_MATERIAL) & SOFT_BIT).toBe(0);
    });
    it('composes with worldTriplanar (bit 27) + hasTexture (bit 0)', () => {
        const f = encodeMaterialFlags({ ...DEFAULT_MATERIAL, softLighting: true, worldTriplanar: true, hasTexture: true });
        expect(f & SOFT_BIT).toBe(SOFT_BIT);
        expect(f & 134217728).toBe(134217728);
        expect(f & 1).toBe(1);
    });
});

describe('encodeMaterialFlags — skinRamp (bit 29)', () => {
    const RAMP_BIT = 536870912;   // bit 29
    it('sets bit 29 when skinRamp is on, clears it otherwise', () => {
        expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, skinRamp: true }) & RAMP_BIT).toBe(RAMP_BIT);
        expect(encodeMaterialFlags(DEFAULT_MATERIAL) & RAMP_BIT).toBe(0);
    });
    it('composes with softLighting (bit 28) — the two stack on skin', () => {
        const f = encodeMaterialFlags({ ...DEFAULT_MATERIAL, skinRamp: true, softLighting: true });
        expect(f & RAMP_BIT).toBe(RAMP_BIT);
        expect(f & 268435456).toBe(268435456);   // bit 28 softLighting intact
    });
});

describe('encodeMaterialFlags — worldTriplanar (bit 27)', () => {
    const TRIPLANAR_BIT = 134217728;   // bit 27
    it('sets bit 27 when worldTriplanar is on, clears it otherwise', () => {
        expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, worldTriplanar: true }) & TRIPLANAR_BIT).toBe(TRIPLANAR_BIT);
        expect(encodeMaterialFlags(DEFAULT_MATERIAL) & TRIPLANAR_BIT).toBe(0);
    });
    it('composes with hasTexture + planarReflector (bits 0/26) without collision', () => {
        const f = encodeMaterialFlags({ ...DEFAULT_MATERIAL, worldTriplanar: true, planarReflector: true, hasTexture: true });
        expect(f & TRIPLANAR_BIT).toBe(TRIPLANAR_BIT);   // bit 27
        expect(f & 67108864).toBe(67108864);             // bit 26 planarReflector intact
        expect(f & 1).toBe(1);                           // bit 0 hasTexture intact
    });
});
