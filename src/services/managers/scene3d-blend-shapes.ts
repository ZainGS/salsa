/**
 * Scene3DBlendShapes — the blend-shape / morph-target subsystem, extracted from Scene3DManager.
 *
 * §5.1 extraction (docs/specs/god-objects-and-perf.md, Part A). Unlike Particles/GreasePencil this subsystem owns
 * NO map of its own — a mesh's blend shapes live on the Mesh3D itself (baseVertices / blendShapes / blendWeights).
 * So it's a cohesive OPERATION group rather than a state container: it takes `ctx` (for render scheduling) and a
 * narrow host (`getMesh`), and reads/writes the mesh's blend-shape arrays. Extracting it still trims the god-object
 * and gives the logic a directly-testable home (a fake mesh is enough — no GPUDevice).
 */

import type { ManagerContext } from './manager-context';
import { Mesh3D, type BlendShape } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';

export interface Scene3DBlendShapeHost {
  getMesh(id: string): Mesh3D | null;
}

export class Scene3DBlendShapes {
  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DBlendShapeHost,
  ) {}

  /** Seed a mesh's blend shapes from GLTF morph targets (captures the base geometry, all weights zero). */
  applyMorphTargets(mesh: Mesh3D, targets: BlendShape[]): void {
    if (!targets || targets.length === 0) return;
    mesh.baseVertices = new Float32Array(mesh.geometry.vertices);
    mesh.blendShapes = targets.slice();
    mesh.blendWeights = new Float32Array(targets.length); // all zeros
  }

  /** Add a blend shape from a delta-vertex array. Returns its index. Throws if the mesh is unknown. */
  add(meshId: string, name: string, deltaVertices: Float32Array): number {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) throw new Error(`Mesh ${meshId} not found`);
    if (!mesh.baseVertices) mesh.baseVertices = new Float32Array(mesh.geometry.vertices);
    const idx = mesh.blendShapes.length;
    mesh.blendShapes.push({ name, deltaVertices });
    const w = new Float32Array(mesh.blendShapes.length);
    w.set(mesh.blendWeights);
    mesh.blendWeights = w;
    return idx;
  }

  /** Set a blend shape's weight (clamped to [0,1]) and re-evaluate the mesh geometry. */
  setWeight(meshId: string, shapeIndex: number, weight: number): void {
    const mesh = this.host.getMesh(meshId);
    if (!mesh || shapeIndex >= mesh.blendShapes.length) return;
    mesh.blendWeights[shapeIndex] = Math.max(0, Math.min(1, weight));
    mesh.evaluateBlendShapes();
    if (mesh instanceof SkinnedMesh3D) mesh.skinDirty = true;
    this.ctx.scheduleRender();
  }

  /** List the mesh's blend shapes as {name, weight}. */
  list(meshId: string): { name: string; weight: number }[] {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return [];
    return mesh.blendShapes.map((s, i) => ({ name: s.name, weight: mesh.blendWeights[i] ?? 0 }));
  }

  /** Remove a blend shape by index, re-evaluate, and drop the base geometry once none remain. */
  remove(meshId: string, shapeIndex: number): void {
    const mesh = this.host.getMesh(meshId);
    if (!mesh || shapeIndex >= mesh.blendShapes.length) return;
    mesh.blendShapes.splice(shapeIndex, 1);
    const w = new Float32Array(mesh.blendShapes.length);
    for (let i = 0, j = 0; i < mesh.blendWeights.length; i++) {
      if (i !== shapeIndex) w[j++] = mesh.blendWeights[i];
    }
    mesh.blendWeights = w;
    mesh.evaluateBlendShapes();
    if (mesh.blendShapes.length === 0) mesh.baseVertices = null;
    if (mesh instanceof SkinnedMesh3D) mesh.skinDirty = true;
    this.ctx.scheduleRender();
  }
}
