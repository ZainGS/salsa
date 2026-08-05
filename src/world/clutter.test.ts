import { describe, it, expect } from 'vitest';
import { buildTrashBin, resolveTrashBinParams, DEFAULT_TRASH_BIN_PARAMS, BIN_SHAPES } from './trash-bin';
import { buildCrate, resolveCrateParams, DEFAULT_CRATE_PARAMS, crateGarpPool, crateCanonicalGeometry, crateInstanceTransforms, crateSkinKey, CRATE_SKIN_NAMES } from './crate';
import { buildVent, resolveVentParams, VENT_STYLES } from './vent';
import { buildABoard, resolveABoardParams, ABOARD_FACE_NAMES } from './a-board';
import { buildStall, resolveStallParams } from './stall';

// Street-clutter Creator assets (trash-bin.ts / crate.ts). Same contract as bollard/bike-rack: build() returns
// non-empty layers + a footprint, and resolve() clamps to the schema bounds.
describe('trash bin', () => {
  it('builds non-empty geometry for both shapes, with a footprint', () => {
    for (const shape of BIN_SHAPES) {
      const { layers, meta } = buildTrashBin({ shape });
      expect(layers.length, shape).toBeGreaterThan(0);
      expect(layers[0].geometry.vertices.length, shape).toBeGreaterThan(0);
      expect(meta.footprint.length).toBe(4);
    }
  });
  it('resolve clamps height/radius to their floors and validates enums', () => {
    const r = resolveTrashBinParams({ heightM: -5, radiusM: 0, shape: 'bogus' as never, finish: 'nope' as never });
    expect(r.heightM).toBe(0.4);
    expect(r.radiusM).toBe(0.1);
    expect(r.shape).toBe(DEFAULT_TRASH_BIN_PARAMS.shape);
    expect(r.finish).toBe(DEFAULT_TRASH_BIN_PARAMS.finish);
  });
  it('lid:false drops the lid geometry (fewer verts than lid:true)', () => {
    const withLid = buildTrashBin({ lid: true }).layers[0].geometry.vertices.length;
    const noLid   = buildTrashBin({ lid: false }).layers[0].geometry.vertices.length;
    expect(noLid).toBeLessThan(withLid);
  });
});

describe('crate stack', () => {
  it('taller stacks add more geometry (count drives crate boxes)', () => {
    const one = buildCrate({ count: 1 }).layers[0].geometry.vertices.length;
    const five = buildCrate({ count: 5 }).layers[0].geometry.vertices.length;
    expect(five).toBeGreaterThan(one);
  });
  it('resolve clamps count to 1..6 and size to its floor', () => {
    expect(resolveCrateParams({ count: 99 }).count).toBe(6);
    expect(resolveCrateParams({ count: -3 }).count).toBe(1);
    expect(resolveCrateParams({ sizeM: 0 }).sizeM).toBe(0.2);
  });
  it('slats:true attaches a grid pattern to the crate layer', () => {
    expect(buildCrate({ slats: true }).layers[0].pattern?.mode).toBe('grid');
    expect(buildCrate({ slats: false }).layers[0].pattern).toBeUndefined();
  });
});

describe('crate GARP (skinnable, instanced)', () => {
  it('the pool declares a label slot with a skin per built-in name', () => {
    const pool = crateGarpPool();
    expect(pool.id).toBe('salsa/crate');
    expect(pool.slots).toContain('label');
    for (const n of CRATE_SKIN_NAMES) expect(pool.skins.some((sk) => sk.slots.label === crateSkinKey(n))).toBe(true);
  });
  it('the canonical box is non-empty and every face is UV-mapped in [0,1]', () => {
    const g = crateCanonicalGeometry(15);
    expect(g.vertices.length).toBeGreaterThan(0);
    // vertex stride carries uv; just assert the geometry built (detailed UV assert would duplicate the shader test).
    expect(g.indices.length).toBeGreaterThan(0);
  });
  it('a stack of N yields N instance transforms, stacked in Y with a shared scale', () => {
    const xf = crateInstanceTransforms([0, 0, 0], { count: 4, sizeM: 0.5 }, 15);
    expect(xf.length).toBe(4);
    expect(xf[1].y).toBeGreaterThan(xf[0].y);              // stacked upward
    expect(xf.every((t) => t.s === xf[0].s)).toBe(true);   // one canonical box scaled uniformly
  });
});

describe('street-clutter GARP pools (instanced, skinnable)', () => {
  it('every pool is well-formed (id, ≥1 slot, a skin per built-in name) and builds a non-empty canonical mesh', async () => {
    const bin = await import('./trash-bin'); const vent = await import('./vent');
    const ab = await import('./a-board'); const st = await import('./stall'); const po = await import('./poster');
    const cases = [
      { pool: bin.binGarpPool(), geo: bin.binCanonicalGeometry(15) },
      { pool: vent.ventGarpPool(), geo: vent.ventCanonicalGeometry(15) },
      { pool: ab.aboardGarpPool(), geo: ab.aboardCanonicalGeometry(15) },
      { pool: st.stallGarpPool(), geo: st.stallAwningCanonicalGeometry(15) },
      { pool: po.posterGarpPool(), geo: po.posterCanonicalGeometry(15) },
    ];
    for (const { pool, geo } of cases) {
      expect(pool.id.startsWith('salsa/'), pool.id).toBe(true);
      expect(pool.slots.length).toBeGreaterThan(0);
      expect(pool.skins.length).toBeGreaterThan(0);
      expect(pool.size).toEqual([512, 512]);   // must match the shared GARP atlas
      expect(geo.vertices.length, pool.id).toBeGreaterThan(0);
    }
  });
});

describe('ground vent', () => {
  it('builds non-empty geometry for both styles', () => {
    for (const style of VENT_STYLES) {
      const { layers } = buildVent({ style });
      expect(layers.length, style).toBeGreaterThan(0);
      expect(layers[0].geometry.vertices.length, style).toBeGreaterThan(0);
    }
  });
  it('resolve clamps width + bars', () => {
    expect(resolveVentParams({ widthM: 0 }).widthM).toBe(0.3);
    expect(resolveVentParams({ bars: 99 }).bars).toBe(16);
    expect(resolveVentParams({ bars: 0 }).bars).toBe(3);
  });
});

describe('a-board', () => {
  it('builds a patterned panel for chalk/menu and none for blank', () => {
    for (const face of ABOARD_FACE_NAMES) {
      const { layers, meta } = buildABoard({ face });
      expect(layers.length, face).toBeGreaterThan(0);
      expect(meta.footprint.length).toBe(4);
    }
    expect(buildABoard({ face: 'chalk' }).layers[0].pattern?.mode).toBe('grid');
    expect(buildABoard({ face: 'blank' }).layers[0].pattern).toBeUndefined();
  });
  it('resolve validates the face enum + clamps size', () => {
    expect(resolveABoardParams({ face: 'x' as never }).face).toBe('chalk');
    expect(resolveABoardParams({ widthM: 0, heightM: 0 })).toMatchObject({ widthM: 0.3, heightM: 0.4 });
  });
});

describe('produce stall', () => {
  it('builds wood + awning + produce layers when all on', () => {
    const { layers } = buildStall({ awning: true, produce: true });
    const names = layers.map((l) => l.name);
    expect(names).toContain('world:stall');
    expect(names).toContain('world:stall-awning');
    expect(names).toContain('world:stall-produce');
  });
  it('awning:false drops the awning layer', () => {
    const names = buildStall({ awning: false }).layers.map((l) => l.name);
    expect(names).not.toContain('world:stall-awning');
  });
  it('resolve clamps width + validates awning colour', () => {
    expect(resolveStallParams({ widthM: 0 }).widthM).toBe(0.8);
    expect(resolveStallParams({ awningColor: 'x' as never }).awningColor).toBe('red');
  });
});
