import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_MATERIAL, encodeMaterialFlags } from './material-3d';

// The 'unlit' render style (UI cards / labels / overlays: albedo output directly, no scene lighting/fog/
// colour-depth). encodeMaterialFlags packs renderStyle into bits 2-4; the mesh fragment shader hard-codes
// `renderStyle == 6u`, so this test pins the encoder ↔ shader contract so they can never silently drift.
describe('unlit render style', () => {
  const STYLE = (flags: number) => (flags >> 2) & 7;

  it("encodes 'unlit' as style value 6 in bits 2-4", () => {
    expect(STYLE(encodeMaterialFlags({ ...DEFAULT_MATERIAL, renderStyle: 'unlit' }))).toBe(6);
  });

  it('does not collide with the other render styles', () => {
    const styles = ['default', 'cel', 'sketch', 'ink', 'gouraud', 'cel-hd', 'unlit'] as const;
    const codes = styles.map((s) => STYLE(encodeMaterialFlags({ ...DEFAULT_MATERIAL, renderStyle: s })));
    expect(new Set(codes).size).toBe(styles.length);   // all distinct
    expect(codes[codes.length - 1]).toBe(6);            // 'unlit' is last
  });

  it("sets ONLY the style bits (no stray feature flags) for a plain unlit material", () => {
    // unlit + hasTexture (the card) should equal exactly the style bits | hasTexture bit.
    const card = encodeMaterialFlags({ ...DEFAULT_MATERIAL, renderStyle: 'unlit', hasTexture: true });
    expect(card).toBe((6 << 2) | 1);
  });

  it('the mesh shader branches on renderStyle == 6u and skips fog + colour-depth when unlit', () => {
    const src = readFileSync(new URL('./shaders/mesh3d-shaders.ts', import.meta.url), 'utf8');
    expect(src).toContain('renderStyle == 6u');               // the unlit lighting branch
    expect(src).toContain('fogMode != 0u && renderStyle != 6u');   // fog skipped
    expect(src).toContain('cd > 0.0 && renderStyle != 6u');        // PS1 colour-depth skipped
  });
});
