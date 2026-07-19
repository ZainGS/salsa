/**
 * src/packaging/packaging-manager.ts — lifecycle + fold control for packaging meshes.
 *
 * Decoupled from the engine via a small `PackagingHost` interface (ShapeManager supplies
 * the adapter), so this module stays removable. v1: one box style, create / setDimensions /
 * setFoldAmount / fold / unfold (tweened) / get / remove.
 */

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { DielineParams, DielineResult, DielineGuide, FoldMeshData } from './types';
import { compileFoldMesh } from './fold-mesh';
import { simpleBox } from './templates/simple-box';

/** What the host (ShapeManager → Scene3DManager) must provide. */
export interface PackagingHost {
  /** Create a custom-geometry mesh, return its node id. */
  createCustomMesh(geometry: MeshGeometry, name: string): string;
  setMeshGeometry(meshId: string, geometry: MeshGeometry): void;
  removeMesh(meshId: string): void;
  /** Live-texture: keep a raster layer in sync with the mesh's diffuse (draw the dieline → it
   *  appears on the box; the net UVs handle the correspondence). Reuses Salsa's LiveTextureMode. */
  linkLiveTexture(meshId: string, layerId: string): void;
  unlinkLiveTexture(meshId: string): void;
  /** Export a raster layer as a PNG blob (for the print-ready dieline export). */
  exportLayerPng(layerId: string): Promise<Blob | null>;
  scheduleRender(): void;
}

export type BoxStyle = 'simpleBox';

const TEMPLATES: Record<BoxStyle, (p: DielineParams) => DielineResult> = { simpleBox };

export interface PackagingState {
  /** Packaging id — equals the mesh node id in v1. */
  id: string;
  meshId: string;
  style: BoxStyle;
  params: DielineParams;
  foldMeshData: FoldMeshData;
  /** 0 = flat dieline, 1 = closed box. */
  foldAmount: number;
  /** Dieline canvas size (px) — the editor sizes the document to this. */
  canvasWidth: number;
  canvasHeight: number;
  /** Cut / fold / bleed guide lines (canvas px) for the editor overlay. */
  guides: DielineGuide[];
  /** panelId → display name. */
  panelLabels: Record<string, string>;
  /** The raster layer live-textured onto the box (the dieline canvas), if linked. */
  dielineLayerId?: string;
}

export class PackagingManager {
  private items = new Map<string, PackagingState>();
  private anim = new Map<string, number>();   // id → rAF handle

  constructor(private host: PackagingHost) {}

  /** Create a packaging mesh from a box style + dimensions (starts flat). */
  create(style: BoxStyle, params: DielineParams, name = 'Package'): PackagingState {
    const r = TEMPLATES[style](params);
    const meshId = this.host.createCustomMesh(compileFoldMesh(r.foldMeshData, 0), name);
    const state: PackagingState = {
      id: meshId, meshId, style, params, foldMeshData: r.foldMeshData, foldAmount: 0,
      canvasWidth: r.canvasWidth, canvasHeight: r.canvasHeight, guides: r.guides, panelLabels: r.panelLabels,
    };
    this.items.set(meshId, state);
    this.host.scheduleRender();
    return state;
  }

  /** Regenerate the net at new dimensions, preserving the current fold amount (the procedural slider path). */
  setDimensions(id: string, params: DielineParams): void {
    const s = this.items.get(id);
    if (!s) return;
    s.params = params;
    const r = TEMPLATES[s.style](params);
    s.foldMeshData = r.foldMeshData;
    s.canvasWidth = r.canvasWidth; s.canvasHeight = r.canvasHeight; s.guides = r.guides; s.panelLabels = r.panelLabels;
    this.host.setMeshGeometry(s.meshId, compileFoldMesh(s.foldMeshData, s.foldAmount));
    this.host.scheduleRender();
  }

  /** Set the fold position directly (0 flat → 1 folded), no animation. */
  setFoldAmount(id: string, amount: number): void {
    const s = this.items.get(id);
    if (!s) return;
    s.foldAmount = Math.max(0, Math.min(1, amount));
    this.host.setMeshGeometry(s.meshId, compileFoldMesh(s.foldMeshData, s.foldAmount));
    this.host.scheduleRender();
  }

  /** Live-texture a raster layer (the dieline canvas) onto the box → drawing on it shows on the box,
   *  flat OR folded (the net UVs map the canvas to the panels). Host syncs after strokes. */
  setDielineLayer(id: string, layerId: string): void {
    const s = this.items.get(id);
    if (!s) return;
    if (s.dielineLayerId) this.host.unlinkLiveTexture(s.meshId);
    s.dielineLayerId = layerId;
    this.host.linkLiveTexture(s.meshId, layerId);
    this.host.scheduleRender();
  }

  clearDielineLayer(id: string): void {
    const s = this.items.get(id);
    if (!s || !s.dielineLayerId) return;
    this.host.unlinkLiveTexture(s.meshId);
    s.dielineLayerId = undefined;
    this.host.scheduleRender();
  }

  fold(id: string, durationMs = 700): void { this.animateTo(id, 1, durationMs); }
  unfold(id: string, durationMs = 700): void { this.animateTo(id, 0, durationMs); }

  private animateTo(id: string, target: number, durationMs: number): void {
    const s = this.items.get(id);
    if (!s) return;
    const prev = this.anim.get(id);
    if (prev != null) cancelAnimationFrame(prev);
    const from = s.foldAmount, start = performance.now();
    const tick = (): void => {
      const t = Math.min(1, (performance.now() - start) / Math.max(1, durationMs));
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
      this.setFoldAmount(id, from + (target - from) * e);
      if (t < 1) this.anim.set(id, requestAnimationFrame(tick));
      else this.anim.delete(id);
    };
    this.anim.set(id, requestAnimationFrame(tick));
  }

  get(id: string): PackagingState | null { return this.items.get(id) ?? null; }
  getAll(): PackagingState[] { return [...this.items.values()]; }

  /** Export the dieline canvas (the linked raster layer) as a flat PNG. null if no dieline is linked. */
  async exportDielinePng(id: string): Promise<Blob | null> {
    const s = this.items.get(id);
    if (!s || !s.dielineLayerId) return null;
    return this.host.exportLayerPng(s.dielineLayerId);
  }

  remove(id: string): void {
    const s = this.items.get(id);
    if (!s) return;
    const a = this.anim.get(id);
    if (a != null) cancelAnimationFrame(a);
    this.anim.delete(id);
    if (s.dielineLayerId) this.host.unlinkLiveTexture(s.meshId);
    this.host.removeMesh(s.meshId);
    this.items.delete(id);
  }
}
