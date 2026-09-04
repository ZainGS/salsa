import { describe, it, expect, beforeEach } from 'vitest';

import { Scene3DMaterials, type Scene3DMaterialsHost } from './scene3d-materials';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { RenderStyle } from '../../renderer/3d/material-3d';
import type { ManagerContext } from './manager-context';

// §5.1 extraction: pure material-state mutation over mesh.material — mock the meshes + a render-count spy and
// assert each op writes the field and schedules a render, plus the whole-character / all-meshes fan-outs skip
// face decals. No GPU, no undo — exactly the kind of surface the god-object decomposition makes testable.

function fakeMesh(id: string, opts: { isFaceDecal?: boolean } = {}): Mesh3D {
  const material: Record<string, unknown> = {};
  return {
    id,
    isFaceDecal: opts.isFaceDecal ?? false,
    gpuDirty: false, stateDirty: false,
    material,
    setMaterial(m: Record<string, unknown>) { Object.assign(material, m); },
    setDiffuseColor(r: number, g: number, b: number, a: number) { material.diffuse = { r, g, b, a }; },
    setOpacity(o: number) { material.opacity = o; },
  } as unknown as Mesh3D;
}

function makeEnv(meshes: Mesh3D[], parts: Record<string, string[]> = {}) {
  const byId = new Map(meshes.map(m => [m.id, m]));
  const calls = { render: 0 };
  const ctx = { scheduleRender: () => { calls.render++; } } as unknown as ManagerContext;
  const host: Scene3DMaterialsHost = {
    getMesh: (id) => byId.get(id) ?? null,
    getAllMeshes: () => meshes,
    getProceduralBodyParts: (id) => parts[id] ?? [],
  };
  return { mats: new Scene3DMaterials(ctx, host), calls, byId };
}

describe('§5.1 Scene3DMaterials (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv([fakeMesh('m1')]); });

  it('setRenderStyle writes the style, marks dirty, schedules a render, and returns true', () => {
    expect(env.mats.setRenderStyle('m1', 'cel' as RenderStyle)).toBe(true);
    const m = env.byId.get('m1')! as unknown as { material: { renderStyle: string }; gpuDirty: boolean; stateDirty: boolean };
    expect(m.material.renderStyle).toBe('cel');
    expect(m.gpuDirty).toBe(true);
    expect(m.stateDirty).toBe(true);
    expect(env.calls.render).toBe(1);
  });

  it('setRenderStyle on an unknown mesh returns false and does not render', () => {
    expect(env.mats.setRenderStyle('nope', 'ink' as RenderStyle)).toBe(false);
    expect(env.calls.render).toBe(0);
  });

  it('setCharacterRenderStyle applies to the body + parts but SKIPS the face decal', () => {
    const env2 = makeEnv(
      [fakeMesh('body'), fakeMesh('shirt'), fakeMesh('face', { isFaceDecal: true })],
      { body: ['shirt', 'face'] },
    );
    const n = env2.mats.setCharacterRenderStyle('body', 'sketch' as RenderStyle);
    expect(n).toBe(2); // body + shirt, not the face decal
    expect((env2.byId.get('face') as unknown as { material: { renderStyle?: string } }).material.renderStyle).toBeUndefined();
  });

  it('setRenderStyleAll skips face decals and returns the changed count', () => {
    const env2 = makeEnv([fakeMesh('a'), fakeMesh('b'), fakeMesh('face', { isFaceDecal: true })]);
    expect(env2.mats.setRenderStyleAll('cel' as RenderStyle)).toBe(2);
  });

  it('setMeshPattern merges only the provided fields and always renders', () => {
    env.mats.setMeshPattern('m1', { mode: 'dots', freq: 12 });
    const mat = (env.byId.get('m1') as unknown as { material: Record<string, unknown> }).material;
    expect(mat.patternMode).toBe('dots');
    expect(mat.patternFreq).toBe(12);
    expect(mat.patternAngle).toBeUndefined();   // not provided → untouched
    expect(env.calls.render).toBe(1);
  });

  it('getMeshPattern returns defaults when nothing is set, and null for an unknown mesh', () => {
    expect(env.mats.getMeshPattern('m1')).toEqual({ mode: 'none', color: null, freq: 8, angle: 0, scale: 0.5, spacing: 0 });
    expect(env.mats.getMeshPattern('nope')).toBeNull();
  });

  it('setMaterial / setDiffuseColor / setOpacity route to the mesh and render', () => {
    env.mats.setMaterial('m1', { roughness: 0.3 } as never);
    env.mats.setDiffuseColor('m1', 1, 0, 0, 1);
    env.mats.setOpacity('m1', 0.5);
    const mat = (env.byId.get('m1') as unknown as { material: Record<string, unknown> }).material;
    expect(mat.roughness).toBe(0.3);
    expect(mat.diffuse).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(mat.opacity).toBe(0.5);
    expect(env.calls.render).toBe(3);
  });
});
