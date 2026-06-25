/**
 * shell-thumbnails.ts — Thumbnail texture atlas for the Shell UI.
 *
 * Tile and cartridge thumbnails arrive as base64 data URLs cached in the
 * shell registry / project index. Rather than bind a separate texture per
 * tile (awkward in WebGPU), we pack every thumbnail into a single fixed
 * grid atlas and address each by a UV rect — the same strategy used for
 * text labels.
 *
 * Decoding + upload is async: `request(id, dataUrl)` kicks off a decode and
 * resolves into a preassigned grid cell. The atlas texture is preallocated
 * so it can always be bound, even before any thumbnail is ready. Because
 * ShellRenderer runs a continuous rAF loop, a freshly uploaded thumbnail
 * simply appears on the next frame — no explicit invalidation needed.
 */

const ATLAS_SIZE = 2048;
const CELL = 256;
const COLS = ATLAS_SIZE / CELL;       // 8
const MAX_CELLS = COLS * COLS;        // 64

interface Cell {
  index: number;
  u0: number; v0: number; u1: number; v1: number;
  dataUrl: string;
  ready: boolean;
}

export class ShellThumbnailAtlas {
  private device: GPUDevice;
  private texture: GPUTexture;
  private view: GPUTextureView;
  private cells = new Map<string, Cell>();
  private nextIndex = 0;

  /** Optional hook fired when a thumbnail finishes uploading. */
  onReady?: () => void;

  constructor(device: GPUDevice) {
    this.device = device;
    this.texture = device.createTexture({
      label: 'ShellThumbnailAtlas',
      size: { width: ATLAS_SIZE, height: ATLAS_SIZE },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.view = this.texture.createView();
  }

  getView(): GPUTextureView { return this.view; }

  /** UV rect for a ready thumbnail, or null if absent/not yet decoded. */
  get(id: string): { u0: number; v0: number; u1: number; v1: number } | null {
    const c = this.cells.get(id);
    return c && c.ready ? c : null;
  }

  /**
   * Ensure the thumbnail for `id` (identified by its data URL) is decoded
   * and uploaded. Cheap to call repeatedly — a no-op when the same data URL
   * is already loaded or in flight for this id.
   */
  request(id: string, dataUrl: string): void {
    const existing = this.cells.get(id);
    if (existing && existing.dataUrl === dataUrl) return; // already loading/loaded

    const index = existing?.index ?? this.nextIndex++;
    if (index >= MAX_CELLS) return; // atlas full — silently skip (rare)

    const col = index % COLS;
    const row = Math.floor(index / COLS);
    const x = col * CELL, y = row * CELL;
    this.cells.set(id, {
      index,
      u0: x / ATLAS_SIZE, v0: y / ATLAS_SIZE,
      u1: (x + CELL) / ATLAS_SIZE, v1: (y + CELL) / ATLAS_SIZE,
      dataUrl,
      ready: false,
    });
    void this.load(id, dataUrl, x, y);
  }

  private async load(id: string, dataUrl: string, x: number, y: number): Promise<void> {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: CELL, resizeHeight: CELL, resizeQuality: 'high',
      });
      const cell = this.cells.get(id);
      if (!cell || cell.dataUrl !== dataUrl) { bitmap.close?.(); return; } // superseded
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: this.texture, origin: { x, y } },
        { width: CELL, height: CELL },
      );
      bitmap.close?.();
      cell.ready = true;
      this.onReady?.();
    } catch {
      /* leave the cell un-ready; tile falls back to solid fill */
    }
  }

  destroy(): void {
    this.texture.destroy();
    this.cells.clear();
  }
}
