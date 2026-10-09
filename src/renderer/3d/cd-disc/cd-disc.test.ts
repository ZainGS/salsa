/**
 * The neutral CD-disc module: the shared mesh (CD Kit + Shell), the art fitting (cover / zoom / pan, guides), the
 * seeded FrogCart disc pattern, and the shared WGSL.
 */
import { describe, it, expect } from 'vitest';
import {
  generateCDDisc, cdDiscToShellMesh, buildShellCDMesh, CD_DISC, CD_DISC_SAFE_R, CD_DISC_HOLE_RATIO,
  CD_DISC_ART_INNER_RATIO, SHELL_CD_HOLE_RATIO,
} from './cd-disc-geometry';
import {
  cdDiscArtCropRect, cdDiscArtUVRect, cdDiscArtPanBy, cdDiscArtZoomTo, cdDiscArtGuides, clampCDDiscArtFit,
  CD_DISC_ART_MAX_ZOOM, CD_DISC_ART_MIN_ZOOM, cdDiscArtDrawRects } from './cd-disc-art';
import {
  cartDiscPattern, cartDiscPatternCached, cartDiscSeedFromId, randomCartDiscSeed, normalizeCartDiscPatternRef,
  writeCartDiscPatternUniforms, cartDiscPatternInk, CART_DISC_PALETTES, CART_DISC_FAMILIES, CART_DISC_PATTERN_WGSL,
} from './cart-disc-pattern';
import { CD_DISC_WGSL, CD_PRINT_OPACITY } from './cd-disc-wgsl';
import { STYLE_WGSL_FUNCTIONS } from '../shaders/style-shaders';
import { generateCDDisc as kitGenerateCDDisc, CD_DISC as KIT_CD_DISC } from '../../../packaging/cd/cd-disc-geometry';
import { CD_DISC_SAFE_R as PRINT_SAFE_R } from '../../../packaging/cd/cd-print';

describe('CD disc mesh (shared by the CD Kit and the Shell)', () => {
  it('the packaging path re-exports the same geometry; the hole + safe ratios are the real CD ones', () => {
    expect(kitGenerateCDDisc).toBe(generateCDDisc);
    expect(KIT_CD_DISC).toBe(CD_DISC);
    expect(PRINT_SAFE_R).toBe(CD_DISC_SAFE_R);
    expect(CD_DISC_HOLE_RATIO).toBeCloseTo(0.125, 6);
    expect(CD_DISC_ART_INNER_RATIO).toBeCloseTo(0.3, 6);
    expect(SHELL_CD_HOLE_RATIO).toBe(CD_DISC_HOLE_RATIO);   // the ONE constant to flip back to 0.17
  });

  it('cdDiscToShellMesh: 9 floats per vertex, same positions / uvs, isFront only on the +Z ring', () => {
    const g = generateCDDisc(1, 0.125, 48, 0.05);
    const s = cdDiscToShellMesh(g);
    const n = g.vertices.length / 12;
    expect(s.verts.length).toBe(n * 9);
    expect(s.indices).toBeInstanceOf(Uint16Array);
    expect([...s.indices]).toEqual([...g.indices]);
    let front = 0;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 8; k++) expect(s.verts[i * 9 + k]).toBeCloseTo(g.vertices[i * 12 + k], 6);
      const isFront = s.verts[i * 9 + 8], nz = g.vertices[i * 12 + 5];
      expect(isFront).toBe(nz > 0.5 ? 1 : 0);
      if (isFront) { front++; expect(s.verts[i * 9 + 2]).toBeGreaterThan(0); }
    }
    expect(front).toBe(48 * 2);   // the top ring's inner + outer verts
  });

  it('buildShellCDMesh = a unit disc with the Shell hole', () => {
    const s = buildShellCDMesh();
    let minR = Infinity, maxR = 0;
    for (let i = 0; i < s.verts.length; i += 9) { const r = Math.hypot(s.verts[i], s.verts[i + 1]); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
    expect(maxR).toBeCloseTo(1, 4);
    expect(minR).toBeCloseTo(SHELL_CD_HOLE_RATIO, 4);
  });
});

describe('disc art fitting (cover, never stretch)', () => {
  it('covers: a landscape image is cropped to its centre square, a portrait one too', () => {
    expect(cdDiscArtCropRect(400, 200)).toEqual({ sx: 100, sy: 0, sw: 200, sh: 200 });
    expect(cdDiscArtCropRect(200, 400)).toEqual({ sx: 0, sy: 100, sw: 200, sh: 200 });
    expect(cdDiscArtCropRect(300, 300)).toEqual({ sx: 0, sy: 0, sw: 300, sh: 300 });
  });

  it('a non-square surface (the booklet 2:1) keeps its aspect', () => {
    const c = cdDiscArtCropRect(1000, 1000, null, 2);
    expect(c.sw / c.sh).toBeCloseTo(2, 6);
    expect(c).toEqual({ sx: 0, sy: 250, sw: 1000, sh: 500 });
  });

  it('zoom shrinks the crop around the centre; pan ±1 reaches the image edges', () => {
    expect(cdDiscArtCropRect(400, 400, { zoom: 2 })).toEqual({ sx: 100, sy: 100, sw: 200, sh: 200 });
    expect(cdDiscArtCropRect(400, 400, { zoom: 2, panX: -1, panY: 1 })).toEqual({ sx: 0, sy: 200, sw: 200, sh: 200 });
    expect(cdDiscArtCropRect(400, 200, { panX: 1 }).sx).toBe(200);   // the right edge of a landscape image
    expect(cdDiscArtCropRect(400, 200, { panY: 1 }).sy).toBe(0);     // no vertical slack → stays put
  });

  it('clamps the fit (zoom 1..max, pan -1..1, junk → defaults)', () => {
    expect(clampCDDiscArtFit({ zoom: 0.2, panX: 5, panY: -9 })).toEqual({ zoom: CD_DISC_ART_MIN_ZOOM, panX: 1, panY: -1 });
    expect(CD_DISC_ART_MIN_ZOOM).toBe(0.5);
  });

  it('zoomed out (< 1): the crop reaches past the image, centred; the draw rects clip to it; pan moves the smaller image', () => {
    const c = cdDiscArtCropRect(400, 400, { zoom: 0.5 });
    expect(c).toEqual({ sx: -200, sy: -200, sw: 800, sh: 800 });
    const d = cdDiscArtDrawRects(400, 400, c, 512, 512)!;
    expect(d).toEqual({ sx: 0, sy: 0, sw: 400, sh: 400, dx: 128, dy: 128, dw: 256, dh: 256 });
    expect(cdDiscArtDrawRects(400, 400, { sx: 500, sy: 0, sw: 100, sh: 100 }, 64, 64)).toBeNull();
    // drag right: the smaller image follows the pointer (the crop moves left)
    const f = cdDiscArtPanBy({ zoom: 0.5, panX: 0, panY: 0 }, 400, 400, 0.1, 0);
    expect(f.panX).toBeGreaterThan(0);
    expect(cdDiscArtCropRect(400, 400, f).sx).toBeLessThan(c.sx);
    // zoomTo keeps working across 1 (cover) in both directions
    expect(cdDiscArtZoomTo({ zoom: 1, panX: 0, panY: 0 }, 400, 300, 0.5).zoom).toBe(0.5);
    expect(cdDiscArtZoomTo({ zoom: 0.5, panX: 0, panY: 0 }, 400, 300, 2).zoom).toBe(2);
    expect(clampCDDiscArtFit({ zoom: 99 }).zoom).toBe(CD_DISC_ART_MAX_ZOOM);
    expect(clampCDDiscArtFit({ zoom: NaN as unknown as number })).toEqual({ zoom: 1, panX: 0, panY: 0 });
    expect(clampCDDiscArtFit(null)).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('the UV rect is the crop over the image size', () => {
    expect(cdDiscArtUVRect(400, 200)).toEqual({ u0: 0.25, v0: 0, u1: 0.75, v1: 1 });
  });

  it('drag-to-pan: the image follows the pointer (crop moves the other way); no slack = no pan', () => {
    const f = cdDiscArtPanBy({ zoom: 2 }, 400, 400, 0.25, 0);   // dragged right by a quarter of the preview
    expect(f.panX).toBeLessThan(0);
    const c0 = cdDiscArtCropRect(400, 400, { zoom: 2 }), c1 = cdDiscArtCropRect(400, 400, f);
    expect(c0.sx - c1.sx).toBeCloseTo(0.25 * c0.sw, 6);           // moved exactly a quarter of the crop
    expect(cdDiscArtPanBy(null, 300, 300, 0.5, 0.5)).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('zoomTo keeps the crop centre (as far as the slack allows)', () => {
    const start = { zoom: 2, panX: 0.5, panY: -0.5 };
    const c0 = cdDiscArtCropRect(400, 400, start);
    const z = cdDiscArtZoomTo(start, 400, 400, 3);
    const c1 = cdDiscArtCropRect(400, 400, z);
    expect(z.zoom).toBe(3);
    expect(c1.sx + c1.sw / 2).toBeCloseTo(c0.sx + c0.sw / 2, 6);
    expect(c1.sy + c1.sh / 2).toBeCloseTo(c0.sy + c0.sh / 2, 6);
    expect(cdDiscArtZoomTo(start, 400, 400, 1)).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('guides: the cut, the hole and the clear hub ring for a round preview', () => {
    const g = cdDiscArtGuides(200);
    expect(g).toEqual({ cx: 100, cy: 100, outerR: 100, holeR: 100 * SHELL_CD_HOLE_RATIO, safeR: 100 * CD_DISC_ART_INNER_RATIO });
  });
});

describe('the seeded FrogCart disc pattern', () => {
  it('is deterministic per seed (same seed → identical params + ink everywhere)', () => {
    for (const seed of [0, 1, 42, 0xdeadbeef, 123456789]) {
      const a = cartDiscPattern(seed), b = cartDiscPattern(seed);
      expect(b).toEqual(a);
      for (const [x, y] of [[0.5, 0.1], [-0.3, 0.7], [0.9, -0.2]]) expect(cartDiscPatternInk(b, x, y)).toBe(cartDiscPatternInk(a, x, y));
    }
  });

  it('different seeds vary (palette, warp) but stay in range', () => {
    const pats = Array.from({ length: 64 }, (_, i) => cartDiscPattern(i + 1));
    expect(new Set(pats.map(p => p.palette)).size).toBeGreaterThan(4);
    expect(new Set(pats.map(p => p.family))).toEqual(new Set(['checker']));
    expect(new Set(pats.map(p => p.amp.toFixed(4))).size).toBeGreaterThan(50);
    expect(cartDiscPattern(1).palette === cartDiscPattern(2).palette && cartDiscPattern(2).palette === cartDiscPattern(3).palette).toBe(false);
    for (const p of pats) {
      expect(p.cells).toBeGreaterThanOrEqual(6); expect(p.cells).toBeLessThanOrEqual(10);
      expect(p.amp).toBeGreaterThanOrEqual(0.12); expect(p.amp).toBeLessThanOrEqual(0.28);
      expect(p.freq).toBeGreaterThanOrEqual(0.85); expect(p.freq).toBeLessThanOrEqual(1.6);
      expect(Math.abs(p.rot)).toBeLessThanOrEqual(Math.PI / 4);
    }
  });

  it('only the wavy checker is drawn (even a pinned stripes / dots family); the palette list starts with sage / cream', () => {
    expect(cartDiscPattern(7, 'dots').family).toBe('checker');
    expect(cartDiscPattern(7, 'stripes').family).toBe('checker');
    for (let s = 0; s < 64; s++) expect(cartDiscPattern(s).family).toBe('checker');
    expect(CART_DISC_PALETTES[0]).toMatchObject({ name: 'Sage', ink: '#8ba36c', paper: '#fdebd3' });
    expect(CART_DISC_FAMILIES).toEqual(['checker', 'stripes', 'dots']);
  });

  it('the pattern prints both colours across the disc', () => {
    for (const f of CART_DISC_FAMILIES) {
      const p = cartDiscPattern(99, f);
      let ink = 0, paper = 0;
      for (let y = -0.9; y <= 0.9; y += 0.05) for (let x = -0.9; x <= 0.9; x += 0.05) {
        if (Math.hypot(x, y) > 1) continue;
        const k = cartDiscPatternInk(p, x, y);
        if (k > 0.9) ink++; else if (k < 0.1) paper++;
      }
      expect(ink, f).toBeGreaterThan(30);
      expect(paper, f).toBeGreaterThan(30);
    }
  });

  it('seeds: a stable hash of an id; random seeds are uint32; stored refs are cleaned', () => {
    expect(cartDiscSeedFromId('cart-abc')).toBe(cartDiscSeedFromId('cart-abc'));
    expect(cartDiscSeedFromId('cart-abc')).not.toBe(cartDiscSeedFromId('cart-abd'));
    const r = randomCartDiscSeed(() => 0.5);
    expect(r).toBe(2147483648);
    expect(normalizeCartDiscPatternRef({ seed: 12.9, family: 'checker' })).toEqual({ seed: 12, family: 'checker' });
    expect(normalizeCartDiscPatternRef({ seed: -1 })).toEqual({ seed: 4294967295 });
    expect(normalizeCartDiscPatternRef({ seed: 3, family: 'plaid' })).toBeNull();
    expect(normalizeCartDiscPatternRef({ seed: 'x' })).toBeNull();
    expect(normalizeCartDiscPatternRef(null)).toBeNull();
    expect(cartDiscPatternCached({ seed: 5 })).toBe(cartDiscPatternCached({ seed: 5 }));
  });

  it('packs the Shell CD uniform words (patA / patB / face.xyz / patC)', () => {
    const p = cartDiscPattern(11, 'stripes');   // → the checker
    const u = new Float32Array(52);
    writeCartDiscPatternUniforms(u, 32, p);
    expect([u[32], u[33], u[34]].map(v => +v.toFixed(5))).toEqual(p.ink.map(v => +v.toFixed(5)));
    expect(u[35]).toBe(0);   // checker
    expect(u[39]).toBe(p.cells);
    expect(u[40]).toBeCloseTo(p.amp, 5); expect(u[41]).toBeCloseTo(p.freq, 5); expect(u[42]).toBeCloseTo(p.rot, 5);
    expect(u[43]).toBe(0);   // the face mode is the caller's
    expect(u[44]).toBe(0);   // the uvRect slot is left alone
    expect(u[48]).toBeCloseTo(p.phase[0], 5); expect(u[50]).toBeCloseTo(p.dotR, 5);
  });
});

describe('shared CD WGSL', () => {
  it('the CD Kit style library uses it (cd_lighting / spectral_zucconi6 kept) and both print through cd_print', () => {
    expect(STYLE_WGSL_FUNCTIONS).toContain(CD_DISC_WGSL);
    expect(STYLE_WGSL_FUNCTIONS).toMatch(/fn cd_lighting\(/);
    expect(CD_DISC_WGSL).toMatch(/fn spectral_zucconi6\(/);
    expect(STYLE_WGSL_FUNCTIONS).toMatch(/cd_print\(col, labelRGB, 1\.0, r\)/);
    expect(CD_DISC_WGSL).toContain(CD_PRINT_OPACITY.toFixed(4));
    expect(CD_DISC_WGSL).toContain((CD_DISC_ART_INNER_RATIO + 0.006).toFixed(4));   // the clear hub edge
  });

  it('no backticks inside the WGSL (they would end the template literal) and the pattern reuses the wavy maths', () => {
    for (const s of [CD_DISC_WGSL, CART_DISC_PATTERN_WGSL]) expect(s.includes('`')).toBe(false);
    expect(CART_DISC_PATTERN_WGSL).toMatch(/fn wavy_warp\(/);
    expect(CART_DISC_PATTERN_WGSL).toMatch(/wavy_checker\(c, blur\)/);
  });
});
