/**
 * Every skinned shader must blend joints through the ONE shared WGSL function (audit 2026-09-28 C1 Phase 3). Six
 * hand-copied `w.x*skinMatrices[j.x] + …` blocks used to exist (skinned mesh ×3, outline/stencil ×2, shadow ×1); if a
 * new shader re-introduces its own blend, a dual-quaternion body's outline or shadow would silently drift from the body.
 * Scans every renderer source file (like the MeshInstance layout test), not a hand-kept list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';

const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

const rendererRoot = fileURLToPath(new URL('..', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const full = join(dir, d.name);
  if (d.isDirectory()) return walk(full);
  return d.name.endsWith('.ts') && !d.name.endsWith('.test.ts') ? [full] : [];
});
const DECL = /var<storage, read> skinMatrices:\s*array<mat4x4<f32>>;/g;

describe('skinned shaders share one skinning blend (audit C1 Phase 3)', () => {
  const files = walk(rendererRoot).filter((f) => !f.endsWith('dual-quat-skin.ts'));

  it('no shader hand-writes its own joint blend any more', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/weights\.x\s*\*\s*skinMatrices\[/.test(src), `${f} still has an inline skin blend`).toBe(false);
    }
  });

  it('every skinMatrices binding is followed by the shared SKIN_BLEND_WGSL (so skinMatrixFor exists in that module)', () => {
    let decls = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(DECL)) {
        decls++;
        const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
        expect(after.trimStart().startsWith('${SKIN_BLEND_WGSL}'), `${f}: skinMatrices declared without the shared blend`).toBe(true);
      }
    }
    expect(decls).toBeGreaterThanOrEqual(7);   // skinned mesh ×4, highlight ×2, shadow ×1 — can't pass vacuously
  });
});

describe('Skeleton3D.skinningMethod persistence', () => {
  it('defaults to linear, and a dualQuat skeleton round-trips through toJSON/fromJSON', () => {
    const skel = new Skeleton3D({ name: 't', joints: [], clips: [] });
    skel.addJoint(-1, [0, 0, 0], 'root');
    expect(skel.skinningMethod).toBe('linear');
    expect(skel.toJSON().skinningMethod).toBeUndefined();          // linear isn't written (old saves look identical)
    skel.skinningMethod = 'dualQuat';
    const back = Skeleton3D.fromJSON(JSON.parse(JSON.stringify(skel.toJSON())));
    expect(back.skinningMethod).toBe('dualQuat');
    expect(Skeleton3D.fromJSON({ ...skel.toJSON(), skinningMethod: undefined }).skinningMethod).toBe('linear');
  });
});
