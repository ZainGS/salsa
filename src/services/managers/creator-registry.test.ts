/**
 * src/services/managers/creator-registry.test.ts — the 3D creator param schemas.
 *
 * A schema is only useful if it agrees with the generator it describes: every schema key must be a real
 * param, its default must match the generator's DEFAULT_*_PARAMS, and its declared min/max must be the SAME
 * bounds the generator's resolve*() actually enforces — otherwise a slider lets the user pick a value the
 * generator silently clamps away, and the panel lies. These tests tie the schema to the generator so the
 * two cannot drift.
 */

import { describe, it, expect } from 'vitest';
import { VENDING_SCHEMA, FOLIAGE_SCHEMA, CREATOR_3D_DEFS, creator3DDef, creator3DSchema, creator3DDefaults, creator3DTypes } from './creator-registry';
import { DEFAULT_VENDING_PARAMS, resolveVendingParams, VENDING_BRANDS } from '../../world/vending';
import { DEFAULT_FOLIAGE_PARAMS, resolveFoliageParams, foliageTypeNames } from '../../world/foliage';

describe('creator registry — lookup surface', () => {
  it('registers vending and returns it by typeId', () => {
    expect(creator3DTypes().some((t) => t.typeId === 'vending')).toBe(true);
    expect(creator3DDef('vending')?.label).toBe('Vending Machine');
    expect(creator3DDef('nope')).toBeUndefined();
    expect(creator3DSchema('vending')).toBe(VENDING_SCHEMA);
    expect(creator3DSchema('nope')).toEqual([]);
  });

  it('creator3DDefaults derives a params object from the schema keys', () => {
    const d = creator3DDefaults('vending');
    expect(d.brand).toBe(DEFAULT_VENDING_PARAMS.brand);
    expect(d.heightM).toBe(DEFAULT_VENDING_PARAMS.heightM);
    // The derived defaults must survive the generator's own resolver unchanged (they ARE the defaults).
    expect(resolveVendingParams(d as never)).toEqual(DEFAULT_VENDING_PARAMS);
  });
});

describe('the vending schema agrees with the vending generator', () => {
  it('every schema key is a real VendingParams field with a matching default', () => {
    for (const f of VENDING_SCHEMA) {
      expect(f.key in DEFAULT_VENDING_PARAMS, `schema key "${f.key}" is not a VendingParams field`).toBe(true);
      expect(f.default, `schema default for "${f.key}" disagrees with DEFAULT_VENDING_PARAMS`)
        .toBe((DEFAULT_VENDING_PARAMS as unknown as Record<string, unknown>)[f.key]);
    }
  });

  it('covers every editable param (only `seed` may be a non-range, but it is present)', () => {
    const keys = new Set(VENDING_SCHEMA.map((f) => f.key));
    for (const k of Object.keys(DEFAULT_VENDING_PARAMS)) {
      expect(keys.has(k), `param "${k}" has no schema field → no slider for it`).toBe(true);
    }
  });

  it("the schema's declared min/max are the SAME bounds resolveVendingParams enforces", () => {
    // Push each ranged field past both ends and confirm the generator clamps to exactly the schema bound.
    for (const f of VENDING_SCHEMA) {
      if (f.type !== 'range' || f.min == null || f.max == null) continue;
      const low = resolveVendingParams({ [f.key]: f.min - 1000 } as never) as unknown as Record<string, number>;
      const high = resolveVendingParams({ [f.key]: f.max + 1000 } as never) as unknown as Record<string, number>;
      // Below-min clamps to the schema min (integer fields round, so allow the rounded floor).
      expect(low[f.key], `${f.key}: generator floor ${low[f.key]} ≠ schema min ${f.min}`).toBeGreaterThanOrEqual(f.min);
      expect(low[f.key], `${f.key}: generator floor exceeds schema min`).toBeLessThanOrEqual(f.min);
      // Above-max: integer fields (step 1) clamp to max; continuous fields are unbounded above in resolve,
      // so only assert the integer ones, which are the ones with a hard cap.
      if (f.step === 1) expect(high[f.key], `${f.key}: generator ceil ${high[f.key]} ≠ schema max ${f.max}`).toBe(f.max);
    }
  });

  it('the brand select lists exactly the real brands, by index', () => {
    const brand = VENDING_SCHEMA.find((f) => f.key === 'brand')!;
    expect(brand.type).toBe('select');
    expect(brand.options).toHaveLength(VENDING_BRANDS.length);
    brand.options!.forEach((o, i) => expect(o.value).toBe(i));
  });

  it('every field declares a group so the panel can section it', () => {
    for (const f of VENDING_SCHEMA) expect(f.group, `field "${f.key}" has no group`).toBeTruthy();
  });
});

describe('the foliage schema (curated) agrees with the foliage generator', () => {
  it('is registered as a second creator type', () => {
    expect(creator3DTypes().some((t) => t.typeId === 'foliage')).toBe(true);
    expect(creator3DSchema('foliage')).toBe(FOLIAGE_SCHEMA);
  });

  it('every schema key is a real FoliageParams field with a matching default', () => {
    for (const f of FOLIAGE_SCHEMA) {
      expect(f.key in DEFAULT_FOLIAGE_PARAMS, `schema key "${f.key}" is not a FoliageParams field`).toBe(true);
      expect(f.default, `schema default for "${f.key}" disagrees with DEFAULT_FOLIAGE_PARAMS`)
        .toBe((DEFAULT_FOLIAGE_PARAMS as unknown as Record<string, unknown>)[f.key]);
    }
  });

  it('the derived defaults are a valid PARTIAL the generator resolves (curated: not every param present)', () => {
    // A curated schema only lists SOME params; the generic create relies on resolve*() filling the rest.
    const d = creator3DDefaults('foliage');
    expect(() => resolveFoliageParams(d as never)).not.toThrow();
    expect(resolveFoliageParams(d as never).type).toBe(DEFAULT_FOLIAGE_PARAMS.type);
  });

  it('the type select lists exactly the real foliage types', () => {
    const type = FOLIAGE_SCHEMA.find((f) => f.key === 'type')!;
    expect(type.type).toBe('select');
    expect(type.options!.map((o) => o.value)).toEqual(foliageTypeNames());
  });
});

describe('every registered creator schema is self-consistent (generic panel contract)', () => {
  // Runs over ALL creators so a new registration can't ship a malformed schema that the panel chokes on.
  for (const def of CREATOR_3D_DEFS) {
    it(`${def.typeId}: fields have unique keys, a group, and select fields carry options`, () => {
      const keys = new Set<string>();
      for (const f of def.schema) {
        expect(keys.has(f.key), `${def.typeId}: duplicate key "${f.key}"`).toBe(false);
        keys.add(f.key);
        expect(f.group, `${def.typeId}.${f.key}: no group`).toBeTruthy();
        expect(f.default, `${def.typeId}.${f.key}: no default`).not.toBeUndefined();
        if (f.type === 'select') expect((f.options?.length ?? 0), `${def.typeId}.${f.key}: select with no options`).toBeGreaterThan(0);
        if (f.type === 'range') { expect(typeof f.min).toBe('number'); expect(typeof f.max).toBe('number'); expect(f.min!).toBeLessThan(f.max!); }
      }
    });
  }
});
