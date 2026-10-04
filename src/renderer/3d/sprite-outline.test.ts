import { describe, it, expect } from 'vitest';
import { computeAlphaSDF, decodeSDF, spriteOutlineMode, spriteLayerOuterWidths, spriteLayerAt, SPRITE_OUTLINE_MAX_LAYERS } from './sprite-outline';
import { packSpriteOutlineParams } from './sprite-outline-pass';
import { outlineLayers, type HighlightStyle } from './mesh-highlight-pass';
import { SPRITE_OUTLINE_SHADER } from './shaders/sprite-outline-shaders';

/** alpha mask of a filled disc of radius r centred in a w×h image. */
function disc(w: number, h: number, r: number): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + 0.5 - w / 2, dy = y + 0.5 - h / 2;
    a[y * w + x] = dx * dx + dy * dy <= r * r ? 255 : 0;
  }
  return a;
}
const at = (s: ReturnType<typeof computeAlphaSDF>, x: number, y: number) => decodeSDF(s.data[(y + s.pad) * s.width + (x + s.pad)], s.maxDist);

describe('computeAlphaSDF', () => {
  it('a disc: distance outside grows with radius, negative inside, ~0 at the edge', () => {
    const s = computeAlphaSDF(disc(64, 64, 16), 64, 64, 16);
    expect(s.hasTransparency).toBe(true);
    expect(s.width).toBe(96); expect(s.height).toBe(96);
    // centre is deep inside
    expect(at(s, 32, 32)).toBeLessThan(-10);
    // a point 8 texels outside the rim along +x: centre-x 32 + 16 + 8
    expect(at(s, 56, 32)).toBeGreaterThan(6.5);
    expect(at(s, 56, 32)).toBeLessThan(9.5);
    // right at the rim: within a texel of zero
    expect(Math.abs(at(s, 48, 32))).toBeLessThan(1.2);
    // diagonal distance is Euclidean (not Manhattan / chessboard): point at 45° 8 texels past the rim
    const k = Math.round(32 + (16 + 8) / Math.SQRT2);
    expect(at(s, k, k)).toBeGreaterThan(6.5);
    expect(at(s, k, k)).toBeLessThan(9.5);
  });

  it('an L shape: the notch corner is outside, the arms inside', () => {
    const w = 40, h = 40, a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 12 || y >= 28) a[y * w + x] = 255;
    const s = computeAlphaSDF(a, w, h, 8, 32);
    expect(at(s, 5, 5)).toBeLessThan(0);          // vertical arm
    expect(at(s, 30, 35)).toBeLessThan(0);        // horizontal arm
    expect(at(s, 30, 10)).toBeGreaterThan(16);    // deep in the notch (~17 to the nearer arm)
    expect(at(s, 30, 10)).toBeLessThan(18.5);
    // the padding lets distance continue past the image's own edge (the arm touches the left border)
    expect(decodeSDF(s.data[20 * s.width + 2], s.maxDist)).toBeGreaterThan(4);
  });

  it('saturates at maxDist, and a fully opaque image reports no transparency', () => {
    const s = computeAlphaSDF(disc(64, 64, 4), 64, 64, 4);
    expect(decodeSDF(s.data[0], s.maxDist)).toBeCloseTo(4, 0);      // far corner clamps to +maxDist
    const opaque = computeAlphaSDF(new Uint8Array(16).fill(255), 4, 4, 2);
    expect(opaque.hasTransparency).toBe(false);
  });
});

describe('spriteOutlineMode — the gate', () => {
  const tex = { depthOrArrayLayers: 1 };
  const sprite = { meshPrimitive: 'sprite', diffuseTexture: tex, material: { hasTexture: true } };
  const tiled = { ...sprite, material: { hasTexture: true, textureTiling: [0.25, 1], textureOffset: [0.5, 0] } };
  it('image (default) routes only textured, once-mapped, single-layer sprites', () => {
    expect(spriteOutlineMode(sprite, {})).toBe('image');
    expect(spriteOutlineMode(sprite, { spriteShape: 'image' })).toBe('image');
    for (const prim of ['box', 'plane', 'sphere', 'custom', 'cylinder']) {
      for (const spriteShape of [undefined, 'image', 'card', 'square']) {
        expect(spriteOutlineMode({ ...sprite, meshPrimitive: prim }, { spriteShape })).toBe(null);   // every other mesh
      }
    }
    expect(spriteOutlineMode({ ...sprite, diffuseTexture: null }, {})).toBe(null);
    expect(spriteOutlineMode({ ...sprite, material: { hasTexture: false } }, { spriteShape: 'card' })).toBe(null);
    expect(spriteOutlineMode({ ...sprite, diffuseTexture: { depthOrArrayLayers: 4 } }, { spriteShape: 'card' })).toBe(null);
    expect(spriteOutlineMode({ ...sprite, material: { hasTexture: true, textureTiling: [2, 1] } }, {})).toBe(null);
    expect(spriteOutlineMode({ ...sprite, material: { hasTexture: true, textureOffset: [0.5, 0] } }, {})).toBe(null);
    expect(spriteOutlineMode({ ...sprite, material: { hasTexture: true, textureTiling: [1, 1], textureOffset: [0, 0] } }, {})).toBe('image');
  });
  it("square → the hull (null); the old alphaShape:false still means square", () => {
    expect(spriteOutlineMode(sprite, { spriteShape: 'square' })).toBe(null);
    expect(spriteOutlineMode(sprite, { alphaShape: false })).toBe(null);
    expect(spriteOutlineMode(sprite, { alphaShape: false, spriteShape: 'card' })).toBe('card');   // the new field wins
  });
  it('card works on any texture mapping (sprite-sheet frames included)', () => {
    expect(spriteOutlineMode(sprite, { spriteShape: 'card' })).toBe('card');
    expect(spriteOutlineMode(tiled, { spriteShape: 'card' })).toBe('card');
    expect(spriteOutlineMode(tiled, {})).toBe(null);
  });
});

const style = (width: number, color: [number, number, number, number] = [1, 0, 0, 1]): HighlightStyle =>
  ({ color, width, thicknessPx: 4, patternMode: 0, patternColor: [1, 1, 1], freq: 20, speed: 0, glow: 1 });

describe('sprite layer thresholds', () => {
  it('uses the same cumulative widths as the hull (outlineLayers), clamped to the field', () => {
    const layers = outlineLayers(style(0.03), [style(0.02), style(0.05)]);
    const outer = spriteLayerOuterWidths(layers.map((l) => l.width), 1);
    expect(outer[0]).toBeCloseTo(0.03); expect(outer[1]).toBeCloseTo(0.05); expect(outer[2]).toBeCloseTo(0.10);
    expect(spriteLayerAt(-0.01, outer)).toBe(-1);   // inside the shape
    expect(spriteLayerAt(0.01, outer)).toBe(0);
    expect(spriteLayerAt(0.04, outer)).toBe(1);
    expect(spriteLayerAt(0.09, outer)).toBe(2);
    expect(spriteLayerAt(0.2, outer)).toBe(-1);     // past the last ring
    expect(spriteLayerOuterWidths([0.1, 0.5, 2], 0.3)).toEqual([0.1, 0.3, 0.3]);
    expect(spriteLayerOuterWidths(new Array(12).fill(0.1), 1)).toHaveLength(SPRITE_OUTLINE_MAX_LAYERS);
  });

  it('packs the uniform: quad, field, layer count + each layer', () => {
    const info = { width: 384, height: 384, pad: 64, imageW: 256, imageH: 256, maxDist: 64, hasTransparency: true };
    const layers = outlineLayers(style(0.03), [style(0.02, [1, 1, 1, 1])]);
    const a = packSpriteOutlineParams({ mode: 'image', width: 1, height: 1, layers, field: info }, 800, 600, 2);
    expect(a.length).toBe(20 + 8 * 16);
    expect([a[0], a[1]]).toEqual([0.5, 0.5]);
    expect(a[2]).toBeCloseTo(0.05);                 // grow = widest ring (no boil)
    expect(a[3]).toBeCloseTo(1 / 256);              // model units per texel
    expect([a[4], a[5], a[6], a[7]]).toEqual([256, 256, 64, 64]);
    expect([a[8], a[9], a[10], a[11]]).toEqual([800, 600, 2, 2]);
    expect(a[12]).toBe(0);                          // mode: image
    expect(a[20 + 8]).toBeCloseTo(0.03); expect(a[36 + 8]).toBeCloseTo(0.05);
    expect([a[36], a[37], a[38], a[39]]).toEqual([1, 1, 1, 1]);
  });

  it('never grows the quad past the field padding', () => {
    const info = { width: 384, height: 384, pad: 64, imageW: 256, imageH: 256, maxDist: 64, hasTransparency: true };
    const a = packSpriteOutlineParams({ mode: 'image', width: 1, height: 1, layers: [{ ...style(5), wobble: 1 }], field: info }, 1, 1, 0);
    expect(a[2]).toBeLessThanOrEqual(64 / 256 + 1e-6);
    expect(a[20 + 8]).toBeLessThanOrEqual(0.98 * 64 / 256 + 1e-6);
  });

  it('card: mode 1, the sprite UV transform, no padding clamp, grow leaves room for boil', () => {
    const layers = outlineLayers({ ...style(0.05, [0, 0, 0, 1]), wobble: 0.5 }, [style(0.5, [1, 0, 0, 1])]);
    const a = packSpriteOutlineParams({ mode: 'card', width: 2, height: 1, layers, uvTransform: [0.25, 1, 0.5, 0] }, 800, 600, 0);
    expect([a[0], a[1]]).toEqual([1, 0.5]);
    expect(a[12]).toBe(1);
    expect([a[16], a[17], a[18], a[19]]).toEqual([0.25, 1, 0.5, 0]);
    expect(a[20 + 8]).toBeCloseTo(0.05);
    expect(a[36 + 8]).toBeCloseTo(0.55);            // not clamped — card distances are analytic
    expect(a[2]).toBeCloseTo(0.55 * 1.5);           // widest ring × (1 + wobble)
    expect([a[20], a[21], a[22], a[23]]).toEqual([0, 0, 0, 1]);   // layer 0 = the card fill's colour
  });
});

describe('SPRITE_OUTLINE_SHADER', () => {
  it('reads the same MeshInstance / params fields the pass packs', () => {
    expect(SPRITE_OUTLINE_SHADER).toContain('layers: array<SpriteLayer, 8>');
    // header order the packer writes: quad, field, screen, mode, uvt, then the layers
    const hdr = SPRITE_OUTLINE_SHADER.slice(SPRITE_OUTLINE_SHADER.indexOf('struct SpriteOutlineParams'));
    const order = ['quad:', 'field:', 'screen:', 'mode:', 'uvt:', 'layers:'].map((k) => hdr.indexOf(k));
    expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]))).toBe(true);
    expect(SPRITE_OUTLINE_SHADER).toMatch(/@vertex fn vs\(/);
    expect(SPRITE_OUTLINE_SHADER).toMatch(/@fragment fn fs\(in: VOut\)/);
    expect(SPRITE_OUTLINE_MAX_LAYERS).toBe(8);
  });
});
