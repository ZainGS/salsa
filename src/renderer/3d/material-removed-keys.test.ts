/**
 * The sparkle / glint feature was REMOVED 2026-10-07 (its late shader branch fired on meshes without the flag on an
 * Android tablet: white specks, mobile-parity §7.1). Old saves may still carry material.sparkleEnabled /
 * material.sparkleStar and charm params.sparkle: loading them must work, set no flag bit, and never write them back.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { encodeMaterialFlags, DEFAULT_MATERIAL, REMOVED_MATERIAL_KEYS, type Material3D } from './material-3d';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { dropRemovedAttachmentParams, defaultAttachmentParams } from '../../services/managers/attachment-generator';
import type { InteractionService } from '../../services/interaction-service';

const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

const OLD = { sparkleEnabled: true, sparkleStar: true };

describe('removed material keys (sparkle, 2026-10-07)', () => {
  it('a saved material with sparkleEnabled / sparkleStar encodes exactly like one without (bits 8 / 12 stay free)', () => {
    const loaded = JSON.parse(JSON.stringify({ ...DEFAULT_MATERIAL, rimEnabled: true, ...OLD })) as Material3D;
    const flags = encodeMaterialFlags(loaded);
    expect(flags).toBe(encodeMaterialFlags({ ...DEFAULT_MATERIAL, rimEnabled: true }));
    expect(flags & (256 | 4096)).toBe(0);
    expect(encodeMaterialFlags({ ...DEFAULT_MATERIAL, ...OLD } as Material3D)).toBe(encodeMaterialFlags(DEFAULT_MATERIAL));
    expect(REMOVED_MATERIAL_KEYS).toEqual(['sparkleEnabled', 'sparkleStar']);
  });

  it('a Mesh3D loaded from such a material drops the keys and never saves them (material, config, submeshes)', () => {
    const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box', material: { ...OLD, metalness: 0.9 } } as never);
    expect('sparkleEnabled' in m.material || 'sparkleStar' in m.material).toBe(false);
    expect(m.material.metalness).toBe(0.9);
    // An Object.assign load path (restoreMeshState) can put them back on the live material: the save still omits them.
    Object.assign(m.material, OLD);
    m.submeshes = [{ label: 's', indexOffset: 0, indexCount: 6, material: { ...DEFAULT_MATERIAL, ...OLD } as Material3D }];
    const json = JSON.stringify(m.toJSON());
    expect(json).not.toMatch(/sparkle/);
    const parsed = JSON.parse(json);
    expect(parsed.material.metalness).toBe(0.9);
    expect(parsed.submeshes).toHaveLength(1);
    m.setMaterial({ ...OLD, roughness: 0.3 } as Partial<Material3D>);
    expect('sparkleEnabled' in m.material).toBe(false);
    expect(m.material.roughness).toBe(0.3);
  });

  it('charm params drop the old sparkle field (and are untouched without it)', () => {
    const p = defaultAttachmentParams('chain');
    expect(dropRemovedAttachmentParams(p)).toBe(p);
    const old = { ...p, sparkle: 'star' } as typeof p;
    const out = dropRemovedAttachmentParams(old);
    expect('sparkle' in out).toBe(false);
    expect(out).toEqual(p);
    expect('sparkle' in old).toBe(true);   // the input is not mutated
  });
});
