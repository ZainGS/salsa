/**
 * Scene3DHtmlTextures — the HTML-in-Canvas / imperative-2D texture subsystem, extracted from Scene3DManager.
 *
 * §5.1 extraction (docs/specs/god-objects-and-perf.md, Part A). Second in the sequence after Scene3DParticles,
 * and the first to exercise the NARROW-HOST half of the template: unlike Particles this subsystem needs two
 * things that live outside it — the target Mesh3D (to swap its diffuse texture) and the mesh's RibbonData (to
 * cache HTML content/options for document auto-restore). Rather than take a raw `this` back-reference, it takes a
 * `Scene3DHtmlTextureHost` interface exposing exactly those two lookups, keeping the dependency surface minimal
 * and the no-circular-dependency property intact.
 *
 * Renders an HTML string (or a Canvas-2D draw callback) to a per-mesh GPUTexture via HtmlTexture3D and applies it
 * as the mesh's diffuse texture. Texture lifetime is careful: HtmlTexture3D destroys its own previous texture on
 * update, so we snapshot it first to avoid double-destroying the mesh's diffuse.
 */

import { HtmlTexture3D, HtmlTexture3DOptions } from '../../renderer/3d/html-texture-3d';
import type { ManagerContext } from './manager-context';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { RibbonData } from '../../types/ribbon-3d';

/** The few cross-subsystem lookups the HTML-texture subsystem needs from the parent manager. */
export interface Scene3DHtmlTextureHost {
  getMesh(id: string): Mesh3D | null;
  /** The mesh's ribbon data, if any — HTML content/options are cached on it so they survive a document reload. */
  getRibbonData(id: string): RibbonData | null;
}

export class Scene3DHtmlTextures {
  private _textures = new Map<string, HtmlTexture3D>();

  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DHtmlTextureHost,
  ) {}

  /**
   * Render an HTML string to a GPU texture and apply it to a mesh. Uses the native browser HTML-in-Canvas
   * technique (SVG foreignObject + drawImage + copyExternalImageToTexture) — no external libraries. Call once to
   * set the initial content, then {@link update} to change the HTML without recreating the texture object.
   */
  async set(meshId: string, html: string, width = 512, height = 128, options?: HtmlTexture3DOptions): Promise<boolean> {
    const mesh = this.host.getMesh(meshId);
    const device = this.ctx.webgpuRenderer.getDevice();
    if (!mesh || !device) return false;
    if (!(width >= 1) || !(height >= 1)) {
      console.error(`setHtmlTexture3D: invalid dimensions ${width}×${height} for mesh "${meshId}" — did computeRibbonTextureSize3D return null?`);
      return false;
    }

    const ht = this._ensureTexture(meshId, device, width, height);

    // Snapshot the old HtmlTexture3D-owned texture BEFORE update() destroys it internally, so we don't
    // double-destroy when the mesh's diffuse points at that same object.
    const prevHtTex = ht.texture;
    const tex = await ht.update(html, options);
    if (!tex) return false;

    if (mesh.diffuseTexture && mesh.diffuseTexture !== prevHtTex) mesh.diffuseTexture.destroy();
    mesh.diffuseTexture = tex;
    mesh.material.hasTexture = true;
    // Do NOT set gpuDirty — geometry did not change, only the texture; the renderer rebuilds the bind group anyway.

    // Cache content + options on the ribbon for auto-restore after document reload.
    const ribbon = this.host.getRibbonData(meshId);
    if (ribbon) {
      ribbon.htmlTextureId = meshId;
      ribbon.htmlContent = html;
      ribbon.htmlTextureWidth = width;
      ribbon.htmlTextureHeight = height;
      if (options?.backgroundColor !== undefined) ribbon.htmlTextureBgColor = options.backgroundColor;
      if (options?.stretchToFit !== undefined) ribbon.htmlTextureStretchToFit = options.stretchToFit;
    }

    this.ctx.scheduleRender();
    return true;
  }

  /**
   * Paint a mesh's diffuse texture directly with the Canvas 2D API via a draw callback. Same texture lifecycle as
   * {@link set}, but pixels come from an imperative 2D draw rather than HTML/CSS. Not persisted (a draw callback
   * isn't serializable) — for transient overlays like the landmark hover card.
   */
  async setCanvas(
    meshId: string,
    width: number,
    height: number,
    draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  ): Promise<boolean> {
    const mesh = this.host.getMesh(meshId);
    const device = this.ctx.webgpuRenderer.getDevice();
    if (!mesh || !device) return false;
    if (!(width >= 1) || !(height >= 1)) {
      console.error(`setCanvasTexture3D: invalid dimensions ${width}×${height} for mesh "${meshId}"`);
      return false;
    }

    const ht = this._ensureTexture(meshId, device, width, height);
    const prevHtTex = ht.texture;   // avoid double-destroy (see set)
    const tex = await ht.updateWithDraw(draw);
    if (!tex) return false;

    if (mesh.diffuseTexture && mesh.diffuseTexture !== prevHtTex) mesh.diffuseTexture.destroy();
    mesh.diffuseTexture = tex;
    mesh.material.hasTexture = true;
    this.ctx.scheduleRender();
    return true;
  }

  /**
   * Update the HTML content of an existing HTML texture without changing its size. Faster than {@link set}
   * because it skips texture recreation. Returns false if no HTML texture exists — call {@link set} first.
   */
  async update(meshId: string, html: string, options?: HtmlTexture3DOptions): Promise<boolean> {
    const mesh = this.host.getMesh(meshId);
    const ht = this._textures.get(meshId);
    if (!mesh || !ht) return false;

    const tex = await ht.update(html, options);
    if (!tex) return false;

    mesh.diffuseTexture = tex;
    mesh.material.hasTexture = true;
    mesh.gpuDirty = true;

    // Keep cached state in sync so options survive live updates.
    const ribbon = this.host.getRibbonData(meshId);
    if (ribbon) {
      ribbon.htmlContent = html;
      if (options?.backgroundColor !== undefined) ribbon.htmlTextureBgColor = options.backgroundColor;
      if (options?.stretchToFit !== undefined) ribbon.htmlTextureStretchToFit = options.stretchToFit;
    }

    this.ctx.scheduleRender();
    return true;
  }

  /** Remove the HTML texture from a mesh and destroy the GPU texture. The mesh reverts to its material color. */
  remove(meshId: string): boolean {
    const mesh = this.host.getMesh(meshId);
    const ht = this._textures.get(meshId);
    if (!mesh || !ht) return false;

    ht.destroy();
    this._textures.delete(meshId);

    if (mesh.diffuseTexture) { mesh.diffuseTexture.destroy(); mesh.diffuseTexture = null; }
    mesh.material.hasTexture = false;
    mesh.gpuDirty = true;
    this.ctx.scheduleRender();
    return true;
  }

  /** True if the mesh has an active HTML texture. */
  has(meshId: string): boolean {
    return this._textures.has(meshId);
  }

  /** Destroy every owned HTML texture (used on manager teardown). Safe to call more than once. */
  dispose(): void {
    for (const ht of this._textures.values()) ht.destroy();
    this._textures.clear();
  }

  /** Get the per-mesh HtmlTexture3D, recreating it if absent or if the requested size changed. */
  private _ensureTexture(meshId: string, device: GPUDevice, width: number, height: number): HtmlTexture3D {
    let ht = this._textures.get(meshId);
    if (ht && (ht.width !== width || ht.height !== height)) {
      ht.destroy();
      ht = undefined;
      this._textures.delete(meshId);
    }
    if (!ht) {
      HtmlTexture3D.setMainCanvas(this.ctx.webgpuRenderer.getCanvas());
      ht = new HtmlTexture3D(device, width, height);
      this._textures.set(meshId, ht);
    }
    return ht;
  }
}
