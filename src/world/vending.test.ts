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
    emitVending, newVendingAccum, vendingLayout, vendingLabelCell, VENDING_LABEL_CELLS, vendingStockGeometry, vendingStockVariant,
    VENDING_STOCK_VARIANTS, vendingFootTransform, vendingCanCell } from './vending';
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

  it('stays within a triangle budget — a city plants hundreds', () => {
    // ~24 cans × 40 tris + the frame / shelves / strips / controls / bay. (The city instances the cans.)
    expect(tris(buildVendingMachine().layers)).toBeLessThan(1600);
    expect(tris(buildVendingMachine().layers)).toBeGreaterThan(400);
  });

  it('has the jihanki parts: chrome controls, a dark pickup bay, price strips, LED buttons', () => {
    const L = buildVendingMachine().layers, by = (n: string) => L.find((x) => x.name === n);
    expect(by('world:vending-chrome')?.metal).toBeTruthy();
    expect(by('world:vending-bay')).toBeTruthy();
    expect(by('world:vending-strip')).toBeTruthy();
    expect(by('world:vending-buttons')?.emissive ?? 0).toBeGreaterThan(0);
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
    expect(resolveVendingParams({ cansPerShelf: 99 }).cansPerShelf).toBe(12);       // clamped
    expect(resolveVendingParams({ cansPerShelf: 0 }).cansPerShelf).toBe(2);
    expect(resolveVendingParams({ shelves: 9 }).shelves).toBe(5);
    expect(resolveVendingParams({ stock: 'weird' as never }).stock).toBe('cans');
    // a pre-redesign save's box-grid params are dropped, not carried along
    expect('productCols' in resolveVendingParams({ productCols: 3 } as never)).toBe(false);
    expect(resolveVendingParams({ heightM: 0.1 }).heightM).toBe(0.6);               // floored
  });

  it('shelves × cans per shelf actually change the geometry; stock:image drops the cans', () => {
    const small = tris(buildVendingMachine({ shelves: 1, cansPerShelf: 2 }).layers);
    const big = tris(buildVendingMachine({ shelves: 5, cansPerShelf: 12 }).layers);
    expect(big).toBeGreaterThan(small);
    const img = buildVendingMachine({ stock: 'image' }).layers;
    expect(img.some((L) => /vending-product-/.test(L.name))).toBe(false);
  });

  it('the smallest + largest grids stay finite', () => {
    for (const q of [{ shelves: 1, cansPerShelf: 2 }, { shelves: 5, cansPerShelf: 12 }]) {
      for (const L of buildVendingMachine(q).layers) for (const v of L.geometry.vertices) expect(Number.isFinite(v)).toBe(true);
    }
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
    it('is a valid pool: one skin per brand, each supplying body + products + labels', () => {
        const pool = vendingGarpPool();
        expect(validateGarpPool(pool)).toEqual([]);
        expect(pool.slots).toEqual(['body', 'products', 'labels']);
        expect(pool.defaults?.labels).toBeTruthy();   // body-only user skins still get cans
        expect(pool.skins.map((s) => s.name)).toEqual(VENDING_BRANDS.map((b) => b.name));
    });

    it('★ a picked skin is COORDINATED — body + products always come from the SAME brand, never mixed', () => {
        const pool = vendingGarpPool();
        for (let x = 0; x < 60; x++) {
            const skin = pickSkin(pool, x * 1.4, 0, 7)!;
            // Both slot keys embed the brand name — a machine can't wear brand A's body over brand B's products.
            expect(skinSlot(pool, skin, 'body')).toBe(vendingSkinKey(skin.name, 'body'));
            expect(skinSlot(pool, skin, 'products')).toBe(vendingSkinKey(skin.name, 'products'));
            expect(skinSlot(pool, skin, 'labels')).toBe(vendingSkinKey(skin.name, 'labels'));
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

    it('backdrop panel: one 0..1-UV quad, its window offset BAKED IN (origin = the foot)', () => {
        const g = vendingProductsGeometry({}, 1), L = vendingLayout(resolveVendingParams());
        expect(g.indices.length).toBe(6);
        for (let i = 0; i < g.vertices.length; i += 12) {
            expect(g.vertices[i + 1]).toBeGreaterThanOrEqual(L.win.y0 - 1e-6);   // window height, from the foot
            expect(g.vertices[i + 1]).toBeLessThanOrEqual(L.win.y1 + 1e-6);
            expect(g.vertices[i + 2]).toBeGreaterThan(L.hd);                    // in front of the cabinet face
            expect(g.vertices[i + 2]).toBeLessThan(L.hd + L.z.can);             // …and behind the cans
        }
        const t = vendingProductsTransform([10, 0, 5], [1, 0], {}, 1);
        expect([t.x, t.y, t.z]).toEqual([10, 0, 5]);   // the FOOT
        expect(t.ry).toBeCloseTo(Math.PI / 2, 6);
    });

    it('★ every per-machine instanced part picks its skin at the SAME (x,z) → one skin per machine', () => {
        const base: [number, number, number] = [3.21, 0.4, -7.77], dir: [number, number] = [0.6, 0.8];
        const shell = vendingShellTransform(base, dir, {}, 0.07), foot = vendingFootTransform(base, dir), prod = vendingProductsTransform(base, dir);
        const pool = vendingGarpPool();
        const pick = (t: { x: number; z: number }) => pickSkin(pool, t.x, t.z, 11)!.name;
        expect([foot.x, foot.z]).toEqual([shell.x, shell.z]);
        expect(pick(prod)).toBe(pick(shell));
        expect(pick(foot)).toBe(pick(shell));
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

// ── The redesign: label sheet + 3D cans (docs/specs/vending-machine-redesign.md) ─────────────────────────────────
describe('vending label sheet — 8 padded cells, rim band over the label', () => {
    it('cells are inside the sheet, disjoint, padded, and the rim sits above the label', () => {
        const cells = Array.from({ length: VENDING_LABEL_CELLS }, (_, i) => vendingLabelCell(i));
        expect(cells).toHaveLength(8);
        for (const { cell, rim, label } of cells) {
            for (const v of cell) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1); }   // padded off the sheet edge
            expect(rim[3]).toBeCloseTo(label[1], 9);                  // rim directly above the label
            expect(rim[1]).toBeCloseTo(cell[1], 9); expect(label[3]).toBeCloseTo(cell[3], 9);
            expect((label[3] - label[1]) / (label[2] - label[0])).toBeGreaterThan(1.5);   // portrait (a can front)
        }
        for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
            const a = cells[i].cell, b = cells[j].cell;
            expect(a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]).toBe(false);
        }
        expect(vendingLabelCell(8).cell).toEqual(vendingLabelCell(0).cell);   // wraps
    });
});

describe('vending 3D cans — the instanced, label-textured stock', () => {
    const P = resolveVendingParams(), L = vendingLayout(P);
    const g = vendingStockGeometry({}, 1, 0);
    const verts = (geo: typeof g) => { const out: { p: number[]; n: number[]; uv: number[] }[] = []; for (let i = 0; i < geo.vertices.length; i += 12) out.push({ p: [geo.vertices[i], geo.vertices[i + 1], geo.vertices[i + 2]], n: [geo.vertices[i + 3], geo.vertices[i + 4], geo.vertices[i + 5]], uv: [geo.vertices[i + 6], geo.vertices[i + 7]] }); return out; };

    it('one can per slot at 40 tris each', () => {
        expect(g.indices.length / 3).toBe(P.shelves * P.cansPerShelf * 40);
        expect(vendingStockGeometry({ shelves: 2, cansPerShelf: 5 }, 1, 0).indices.length / 3).toBe(2 * 5 * 40);
    });

    it('every can sits inside the window, between the backdrop and the glass', () => {
        for (const v of verts(g)) {
            expect(Math.abs(v.p[0])).toBeLessThanOrEqual(L.win.x + 1e-6);
            expect(v.p[1]).toBeGreaterThanOrEqual(L.win.y0 - 1e-6);
            expect(v.p[1]).toBeLessThanOrEqual(L.win.y1 + 1e-6);
            expect(v.p[2]).toBeGreaterThan(L.hd + L.z.backdrop);
            expect(v.p[2]).toBeLessThan(L.hd + L.z.glass);
        }
    });

    it('every UV lands inside a single label cell (no bleed across cells)', () => {
        const cells = Array.from({ length: VENDING_LABEL_CELLS }, (_, i) => vendingLabelCell(i).cell);
        for (const v of verts(g)) {
            const inside = cells.some((c) => v.uv[0] >= c[0] - 1e-6 && v.uv[0] <= c[2] + 1e-6 && v.uv[1] >= c[1] - 1e-6 && v.uv[1] <= c[3] + 1e-6);
            expect(inside).toBe(true);
        }
    });

    it('triangle winding agrees with the vertex normals (lit + culled correctly)', () => {
        const V = verts(g), ix = g.indices;
        for (let t = 0; t < ix.length; t += 3) {
            const a = V[ix[t]].p, b = V[ix[t + 1]].p, c = V[ix[t + 2]].p;
            const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const gn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const n = V[ix[t]].n;
            expect(gn[0] * n[0] + gn[1] * n[1] + gn[2] * n[2]).toBeGreaterThanOrEqual(-1e-12);
        }
    });

    it('the front of each can shows the label left→right, NOT mirrored (viewer-left = the cell\'s left edge)', () => {
        // Seen from the front of a +Z-facing machine the viewer's right is +X (like a sprite: u grows along +X).
        const cell = vendingLabelCell(vendingCanCell(0, 0, 0, P.seed)).label;
        const can = verts(g).slice(0, 8);   // the first ring = can 0's bottom ring
        const left = can.reduce((m, v) => (v.p[0] < m.p[0] ? v : m));   // −X = viewer's left
        const right = can.reduce((m, v) => (v.p[0] > m.p[0] ? v : m));
        expect(right.uv[0]).toBeCloseTo(cell[2], 6);
        expect(left.uv[0]).toBeCloseTo(cell[0], 6);
    });

    it('arrangement variants differ, and each machine picks one deterministically', () => {
        const cellsOf = (v: number) => Array.from({ length: P.shelves * P.cansPerShelf }, (_, i) => vendingCanCell(Math.floor(i / P.cansPerShelf), i % P.cansPerShelf, v, P.seed)).join(',');
        const all = new Set(Array.from({ length: VENDING_STOCK_VARIANTS }, (_, v) => cellsOf(v)));
        expect(all.size).toBe(VENDING_STOCK_VARIANTS);
        const used = new Set(Array.from({ length: 200 }, (_, i) => vendingStockVariant(i * 0.37, i * 0.11, 5)));
        expect(used.size).toBe(VENDING_STOCK_VARIANTS);
        expect(vendingStockVariant(1.23, 4.56, 5)).toBe(vendingStockVariant(1.23, 4.56, 5));
        // a machine shows a mix of designs, not one can repeated
        expect(new Set(cellsOf(0).split(',')).size).toBeGreaterThan(4);
    });
});

describe('nothing is mirrored (u grows along the viewer\'s right, like sprites)', () => {
    const uvAt = (geo: { vertices: Float32Array }, pick: (x: number, y: number, z: number, nz: number) => boolean) => {
        const out: number[][] = [];
        for (let i = 0; i < geo.vertices.length; i += 12) if (pick(geo.vertices[i], geo.vertices[i + 1], geo.vertices[i + 2], geo.vertices[i + 5])) out.push([geo.vertices[i], geo.vertices[i + 6], geo.vertices[i + 7]]);
        return out;
    };
    it('shell FRONT: the +X (viewer-right) edge maps to the region\'s right (u1)', () => {
        const g = vendingShellGeometry({}, 1), hz = 0.3, front = VENDING_BODY_UV_REGIONS.find((r) => r.label === 'front')!.rect;
        const vs = uvAt(g, (_x, _y, z, nz) => Math.abs(z - hz) < 1e-6 && nz > 0.9);
        expect(vs.length).toBe(4);
        for (const v of vs) expect(v[1]).toBeCloseTo(v[0] > 0 ? front[2] : front[0], 6);
    });
    it('backdrop: +X (viewer-right) → u 1', () => {
        for (const v of uvAt(vendingProductsGeometry({}, 1), () => true)) expect(v[1]).toBeCloseTo(v[0] > 0 ? 1 : 0, 6);
    });
    it('the control column sits on the viewer\'s RIGHT of a +Z-facing machine', () => {
        const acc = newVendingAccum(); emitVending(acc, [0, 0, 0], [0, 1], resolveVendingParams(), 1, 1, true, true);
        const v = acc.chrome.geometry().vertices; let mx = 0, n = 0;
        for (let i = 0; i < v.length; i += 12) if (v[i + 1] > 0.7) { mx += v[i]; n++; }   // coin / bill / lever (above the bay)
        expect(mx / n).toBeGreaterThan(0.1);
    });
});
