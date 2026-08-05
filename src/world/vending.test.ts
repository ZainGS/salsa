/**
 * src/world/vending.test.ts — the vending-machine generator (the first prop rebuilt from a box, and the
 * first city prop with real params — the shape a Vending Creator mode will bind sliders to).
 *
 * Pins the CONTRACT, not just the output: real sub-layers exist, each carries exactly ONE material family
 * (the invariant that shares four instance floats across metal/glass/pattern/glow), params drive the shape,
 * the metres-authored geometry scales correctly, the triangle budget holds, and it is deterministic.
 */

import { describe, it, expect } from 'vitest';
import { buildVendingMachine, resolveVendingParams, DEFAULT_VENDING_PARAMS, VENDING_BRANDS, vendingGarpPool, vendingSkinKey,
    vendingShellGeometry, vendingShellTransform, VENDING_BODY_UV_REGIONS, vendingProductsGeometry, vendingProductsTransform,
    emitVending, newVendingAccum } from './vending';
import { validateGarpPool, pickSkin, skinSlot } from './garp';
import type { LayoutPreviewLayer } from './types';

const tris = (ls: LayoutPreviewLayer[]): number => ls.reduce((n, L) => n + L.geometry.indices.length / 3, 0);

/** The families that share the pattern instance slots — a layer may set at most one. `glass` is a plain
 *  flag bit (not a slot), so it is allowed alongside, and `emissive` is a scalar, not a family. */
const SLOT_FAMILIES = ['pattern', 'ground', 'metal', 'water', 'neon', 'foliageShade'] as const;
const familiesOn = (L: LayoutPreviewLayer): string[] =>
  SLOT_FAMILIES.filter((f) => (L as unknown as Record<string, unknown>)[f] != null);

describe('vending machine — a real prop, not a box', () => {
  it('emits the sub-layers that make it read: metal body, glass, lit glow, products', () => {
    const { layers } = buildVendingMachine({ brand: 0 });
    const names = layers.map((L) => L.name);
    expect(names.some((n) => /vending-red$/.test(n)), 'no metal cabinet').toBe(true);
    expect(layers.find((L) => L.name === 'world:vending-glass')?.glass, 'no glass pane').toBe(true);
    expect((layers.find((L) => L.name === 'world:vending-glow')?.emissive ?? 0), 'window not lit').toBeGreaterThan(0);
    expect(names.some((n) => /vending-product-/.test(n)), 'no products').toBe(true);
    expect(names.some((n) => n === 'world:vending-trim'), 'no coin/tray trim').toBe(true);
  });

  it('the cabinet and trim are painted METAL, not flat colour', () => {
    for (const L of buildVendingMachine({ brand: 1 }).layers) {
      if (/vending-(blue|trim)$/.test(L.name)) expect(L.metal, `${L.name} is flat`).toBeTruthy();
    }
  });

  it('★ every sub-layer carries at most ONE slot-consuming material family', () => {
    // The whole reason the prop is split into sub-layers: metal, glow and glass coexist on one object only
    // because each lives on its OWN mesh. If a future edit puts two families on one layer, the renderer
    // silently drops one — this catches it at the generator, not on screen.
    for (const L of buildVendingMachine().layers) {
      expect(familiesOn(L).length, `${L.name} claims [${familiesOn(L).join(' + ')}]`).toBeLessThanOrEqual(1);
    }
  });

  it('stays within a small triangle budget — a city plants hundreds', () => {
    expect(tris(buildVendingMachine().layers)).toBeLessThan(200);
    expect(tris(buildVendingMachine().layers)).toBeGreaterThan(60);
  });

  it('is deterministic per params', () => {
    expect(tris(buildVendingMachine({ brand: 2, seed: 9 }).layers))
      .toBe(tris(buildVendingMachine({ brand: 2, seed: 9 }).layers));
  });

  it('every brand builds without throwing and produces geometry', () => {
    VENDING_BRANDS.forEach((_b, i) => {
      expect(tris(buildVendingMachine({ brand: i }).layers), `brand ${i} is empty`).toBeGreaterThan(0);
    });
  });
});

describe('vending params drive the shape', () => {
  it('resolveVendingParams fills defaults, clamps ranges, and wraps the brand index', () => {
    expect(resolveVendingParams()).toEqual(DEFAULT_VENDING_PARAMS);
    expect(resolveVendingParams({ brand: VENDING_BRANDS.length }).brand).toBe(0);   // wraps
    expect(resolveVendingParams({ brand: -1 }).brand).toBe(VENDING_BRANDS.length - 1);
    expect(resolveVendingParams({ productCols: 99 }).productCols).toBe(4);          // clamped
    expect(resolveVendingParams({ productCols: 0 }).productCols).toBe(1);
    expect(resolveVendingParams({ heightM: 0.1 }).heightM).toBe(0.6);               // floored
  });

  it('the product grid size actually changes the geometry', () => {
    const small = tris(buildVendingMachine({ productCols: 1, productRows: 1 }).layers);
    const big = tris(buildVendingMachine({ productCols: 4, productRows: 4 }).layers);
    expect(big).toBeGreaterThan(small);
  });

  it('a 1x1 product grid does not divide by zero (centres the single box)', () => {
    // productCols/Rows === 1 makes the `/(cols-1)` grid term a divide-by-zero — the guard must centre it.
    const layers = buildVendingMachine({ productCols: 1, productRows: 1 }).layers;
    for (const L of layers) for (const v of L.geometry.vertices) expect(Number.isFinite(v)).toBe(true);
  });

  it('meta reports real height + a footprint sized from the params (metres)', () => {
    const { meta } = buildVendingMachine_meta();
    expect(meta.height).toBe(1.8);
    // footprint is the ±width/2 × ±depth/2 rectangle in metres.
    const xs = meta.footprint.map((p) => Math.abs(p[0])), zs = meta.footprint.map((p) => Math.abs(p[1]));
    expect(Math.max(...xs)).toBeCloseTo(0.42, 6);   // 0.84 / 2
    expect(Math.max(...zs)).toBeCloseTo(0.30, 6);   // 0.60 / 2
  });

  it('is authored in METRES (1 unit = 1 m) — the tallest extent equals heightM', () => {
    // The standalone build authors 1:1, so the geometry's Y span should be ~heightM (the manager applies
    // the display scale afterward, exactly like Building/Foliage).
    let maxY = -Infinity, minY = Infinity;
    for (const L of buildVendingMachine({ heightM: 2.2 }).layers) {
      const v = L.geometry.vertices;
      for (let i = 1; i < v.length; i += 12) { maxY = Math.max(maxY, v[i]); minY = Math.min(minY, v[i]); }
    }
    expect(maxY - minY).toBeGreaterThan(2.2 * 0.9);
    expect(maxY - minY).toBeLessThan(2.2 * 1.15);
  });
});

describe('vendingGarpPool — the GARP consumer pool', () => {
    it('is a valid pool: one skin per brand, each supplying both body + products slots', () => {
        const pool = vendingGarpPool();
        expect(validateGarpPool(pool)).toEqual([]);
        expect(pool.slots).toEqual(['body', 'products']);
        expect(pool.skins.map((s) => s.name)).toEqual(VENDING_BRANDS.map((b) => b.name));
    });

    it('★ a picked skin is COORDINATED — body + products always come from the SAME brand, never mixed', () => {
        const pool = vendingGarpPool();
        for (let x = 0; x < 60; x++) {
            const skin = pickSkin(pool, x * 1.4, 0, 7)!;
            // Both slot keys embed the brand name — a machine can't wear brand A's body over brand B's products.
            expect(skinSlot(pool, skin, 'body')).toBe(vendingSkinKey(skin.name, 'body'));
            expect(skinSlot(pool, skin, 'products')).toBe(vendingSkinKey(skin.name, 'products'));
        }
    });
});

describe('vending body shell — the instanced GARP surface (city integration)', () => {
    it('vendingShellGeometry is a 6-face box (12 tris) whose extents scale with the machine + worldPerMetre', () => {
        const g = vendingShellGeometry({}, 1);
        expect(g.vertices.length).toBeGreaterThan(0);
        expect(g.indices.length).toBe(36);   // 6 faces × 2 tris × 3 indices
        // Doubling worldPerMetre doubles the box.
        const spanX = (verts: Float32Array) => { let mn = Infinity, mx = -Infinity; for (let i = 0; i < verts.length; i += 12) { mn = Math.min(mn, verts[i]); mx = Math.max(mx, verts[i]); } return mx - mn; };
        expect(spanX(vendingShellGeometry({}, 2).vertices)).toBeCloseTo(2 * spanX(g.vertices), 4);
    });

    it('full per-face unwrap: every VENDING_BODY_UV_REGIONS rect is covered by geometry UVs, and they do not overlap', () => {
        // Verts are 12-float (pos3·nrm3·uv2·pad4): uv at offsets 6,7.
        const v = vendingShellGeometry({}, 1).vertices;
        const uvs: [number, number][] = [];
        for (let i = 0; i < v.length; i += 12) uvs.push([v[i + 6], v[i + 7]]);
        // Each region's 4 corners should appear among the geometry UVs (the face maps exactly to its rect).
        for (const { rect } of VENDING_BODY_UV_REGIONS) {
            const [u0, v0, u1, v1] = rect;
            for (const [cu, cv] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as const) {
                expect(uvs.some(([u, w]) => Math.abs(u - cu) < 1e-4 && Math.abs(w - cv) < 1e-4)).toBe(true);
            }
        }
        // Regions are disjoint (with gaps) — no two rects overlap.
        const rects = VENDING_BODY_UV_REGIONS.map((r) => r.rect);
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
            const [a0, b0, a1, b1] = rects[i], [c0, d0, c1, d1] = rects[j];
            const overlap = a0 < c1 && c0 < a1 && b0 < d1 && d0 < b1;
            expect(overlap).toBe(false);
        }
        // Front is the biggest region (detail-critical).
        const area = (r: number[]) => (r[2] - r[0]) * (r[3] - r[1]);
        const front = VENDING_BODY_UV_REGIONS.find((r) => r.label === 'front')!.rect;
        expect(VENDING_BODY_UV_REGIONS.every((r) => r.label === 'front' || area(r.rect) < area(front))).toBe(true);
    });

    it('vendingShellTransform centres the box at the cabinet centre and yaws +Z to the display dir', () => {
        const t = vendingShellTransform([10, 0, 5], [1, 0], {}, 1);
        expect(t.x).toBeCloseTo(10, 6);           // box centred over the foot (no front offset — the shell IS the cabinet)
        expect(t.z).toBeCloseTo(5, 6);
        expect(t.y).toBeCloseTo(0.9, 6);          // half of a 1.8 m machine
        expect(t.ry).toBeCloseTo(Math.PI / 2, 6); // atan2(1,0) — +Z rotates to +X
    });

    it('products panel: a flat 0..1-UV quad in the window, placed between the backing and the glass', () => {
        const g = vendingProductsGeometry({}, 1);
        expect(g.indices.length).toBe(6);         // one quad (flat display panel)
        const t = vendingProductsTransform([10, 0, 5], [1, 0], {}, 1);
        expect(t.x).toBeGreaterThan(10);          // pushed out along the facing dir (in front of the cabinet)
        expect(t.y).toBeGreaterThan(0.9);         // upper-middle window (cabinet centre + the window shift)
        expect(t.ry).toBeCloseTo(Math.PI / 2, 6);
    });

    it('emitVending skipProducts drops the merged product boxes (the city instances a panel instead)', () => {
        const withBoxes = newVendingAccum(); emitVending(withBoxes, [0, 0, 0], [0, 1], resolveVendingParams(), 1, 1);
        const noBoxes = newVendingAccum(); emitVending(noBoxes, [0, 0, 0], [0, 1], resolveVendingParams(), 1, 1, false, true);
        const prodVerts = (a: ReturnType<typeof newVendingAccum>) => a.prod.reduce((n, acc) => n + acc.geometry().vertices.length, 0);
        expect(prodVerts(withBoxes)).toBeGreaterThan(0);
        expect(prodVerts(noBoxes)).toBe(0);       // no product boxes when skipped
    });
});

// tiny helper so the meta test reads cleanly
function buildVendingMachine_meta(): ReturnType<typeof buildVendingMachine> { return buildVendingMachine(); }
