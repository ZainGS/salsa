import { describe, it, expect } from 'vitest';
import { findMergeDownTargetIndex } from './raster-layer-manager';

// Layers are bottom-first (index 0 = bottom of the stack), like RasterLayerManager.layers.
describe('findMergeDownTargetIndex (Merge Down target)', () => {
  it('merges into the paint layer directly below (a lower index), never above', () => {
    const layers = [{ type: 'layer' as const }, { type: 'layer' as const }, { type: 'layer' as const }];
    expect(findMergeDownTargetIndex(layers, 2)).toBe(1);
    expect(findMergeDownTargetIndex(layers, 1)).toBe(0);
    expect(findMergeDownTargetIndex(layers, 0)).toBe(-1);   // the bottom layer has nothing below
  });

  it('skips folders, references, vector layers and the 3D scene', () => {
    const layers = [
      { type: 'layer' as const }, { type: '3d-scene' as const }, { type: 'reference' as const },
      { type: 'folder' as const }, { type: 'vector' as const }, {},   // {} = a legacy entry without type = paint layer
    ];
    expect(findMergeDownTargetIndex(layers, 5)).toBe(0);
  });

  it('only a paint layer merges', () => {
    expect(findMergeDownTargetIndex([{ type: 'layer' as const }, { type: 'reference' as const }], 1)).toBe(-1);
    expect(findMergeDownTargetIndex([{ type: 'layer' as const }, { type: 'folder' as const }], 1)).toBe(-1);
  });

  it('an artboard layer never merges into a package-owned layer; a package layer stays in its own package', () => {
    const layers = [
      { type: 'layer' as const },
      { type: 'layer' as const, packageOwnerId: 'p1', systemOwner: 'packaging' },
      { type: 'layer' as const, packageOwnerId: 'p2', systemOwner: 'packaging' },
      { type: 'layer' as const },
      { type: 'layer' as const, packageOwnerId: 'p1', systemOwner: 'packaging' },
    ];
    expect(findMergeDownTargetIndex(layers, 3)).toBe(0);
    expect(findMergeDownTargetIndex(layers, 4)).toBe(1);
    expect(findMergeDownTargetIndex(layers, 2)).toBe(-1);
  });
});
