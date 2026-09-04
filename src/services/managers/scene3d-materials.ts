/**
 * Scene3DMaterials — the CPU mesh-appearance surface, extracted from Scene3DManager.
 *
 * Every method here mutates a mesh's `material` (render style, in-shader pattern, diffuse/opacity, or a bulk
 * Material3D patch) and schedules a render — no GPU work, no undo, no scene mutation. All state lives on the
 * Mesh3D, so this subsystem holds none of its own; it only needs a narrow host to resolve meshes (one, all, or a
 * character's parts). GPU-coupled texture UPLOAD (setMeshTexture / uploadAndApplyTexture / applyLibraryTexture) is
 * deliberately NOT here — it belongs to a later Scene3DTextures step — which keeps this subsystem unit-testable
 * with a mock ctx like Scene3DModifiers.
 *
 * Scene3DManager keeps thin delegating methods so the public API and every caller are unchanged.
 */

import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Material3D, RenderStyle } from '../../renderer/3d/material-3d';
import type { ManagerContext } from './manager-context';

/** Narrow host surface — everything Scene3DMaterials needs from the parent manager beyond the shared ctx. */
export interface Scene3DMaterialsHost {
  getMesh(id: string): Mesh3D | null;
  getAllMeshes(): Mesh3D[];
  /** Ids of a procedural character's parts (clothing / hair / attachments / face decal) — for whole-character ops. */
  getProceduralBodyParts(bodyMeshId: string): string[];
}

export class Scene3DMaterials {
  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DMaterialsHost,
  ) {}

  /** Set the render style on a mesh ('default' | 'cel' | 'sketch' | 'ink'). */
  setRenderStyle(nodeId: string, style: RenderStyle): boolean {
    const mesh = this.host.getMesh(nodeId);
    if (!mesh) return false;
    mesh.material.renderStyle = style;
    mesh.gpuDirty = true;
    mesh.stateDirty = true;
    this.ctx.scheduleRender();
    return true;
  }

  getRenderStyle(nodeId: string): RenderStyle | null {
    return this.host.getMesh(nodeId)?.material.renderStyle ?? null;
  }

  /** Set the render style on a whole procedural CHARACTER at once — the body + all its parts (clothing / hair /
   *  attachments; the face decal is unlit so it's skipped). Returns the number of meshes changed. */
  setCharacterRenderStyle(bodyMeshId: string, style: RenderStyle): number {
    let n = 0;
    if (this.setRenderStyle(bodyMeshId, style)) n++;
    for (const id of this.host.getProceduralBodyParts(bodyMeshId)) {
      if (this.host.getMesh(id)?.isFaceDecal) continue;          // unlit cutout — a lit render style has no effect
      if (this.setRenderStyle(id, style)) n++;
    }
    return n;
  }

  /** Set the render style on EVERY 3D mesh in the scene at once (face decals skipped). Returns the count changed. */
  setRenderStyleAll(style: RenderStyle): number {
    let n = 0;
    for (const m of this.host.getAllMeshes()) { if (m.isFaceDecal) continue; if (this.setRenderStyle(m.id, style)) n++; }
    return n;
  }

  /** Set a procedural geometric PATTERN on a mesh's albedo (analytic, antialiased in-shader — crisp at any zoom).
   *  Primary colour = the mesh's diffuse; `color` = the secondary. Live (read fresh each frame). Best on the
   *  default/PBR render style. Works on any mesh — garments, base layers, etc. */
  setMeshPattern(meshId: string, opts: {
    mode?: 'none' | 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid';
    color?: { r: number; g: number; b: number };
    freq?: number; angle?: number; scale?: number; spacing?: number;
  }): void {
    const mesh = this.host.getMesh(meshId); if (!mesh) return;
    const m = mesh.material;
    if (opts.mode    !== undefined) m.patternMode = opts.mode;
    if (opts.color)                 m.patternColor = { r: opts.color.r, g: opts.color.g, b: opts.color.b, a: 1 };
    if (opts.freq    !== undefined) m.patternFreq = opts.freq;
    if (opts.angle   !== undefined) m.patternAngle = opts.angle;
    if (opts.scale   !== undefined) m.patternScale = opts.scale;
    if (opts.spacing !== undefined) m.patternSpacing = opts.spacing;
    this.ctx.scheduleRender();
  }

  /** The mesh's current pattern settings (or null). */
  getMeshPattern(meshId: string): { mode: string; color: { r: number; g: number; b: number } | null; freq: number; angle: number; scale: number; spacing: number } | null {
    const m = this.host.getMesh(meshId)?.material; if (!m) return null;
    return {
      mode: m.patternMode ?? 'none',
      color: m.patternColor ? { r: m.patternColor.r, g: m.patternColor.g, b: m.patternColor.b } : null,
      freq: m.patternFreq ?? 8, angle: m.patternAngle ?? 0, scale: m.patternScale ?? 0.5, spacing: m.patternSpacing ?? 0,
    };
  }

  setMaterial(nodeId: string, material: Partial<Material3D>): void {
    const mesh = this.host.getMesh(nodeId);
    if (mesh) { mesh.setMaterial(material); this.ctx.scheduleRender(); }
  }

  setDiffuseColor(nodeId: string, r: number, g: number, b: number, a = 1): void {
    const mesh = this.host.getMesh(nodeId);
    if (mesh) { mesh.setDiffuseColor(r, g, b, a); this.ctx.scheduleRender(); }
  }

  setOpacity(nodeId: string, opacity: number): void {
    const mesh = this.host.getMesh(nodeId);
    if (mesh) { mesh.setOpacity(opacity); this.ctx.scheduleRender(); }
  }
}
