/**
 * shell-thumbnails.ts — Thumbnail texture atlas for the Shell UI.
 *
 * Tile and cartridge thumbnails arrive as base64 data URLs cached in the
 * shell registry / project index. Rather than bind a separate texture per
 * tile (awkward in WebGPU), we pack thumbnails into a single fixed grid
 * atlas and address each by a UV rect — the same strategy used for text
 * labels.
 *
 * The atlas holds a FIXED number of cells, but a project library can have far
 * more illustrations than that. So cells are a VIRTUALIZED, scroll-aware LRU
 * cache, not a first-come slot map: every requested data URL is remembered
 * (`request`), but a cell is only committed to an id when the renderer asks
 * for it while it's ON-SCREEN (`touch`). When the atlas is full, the
 * least-recently-touched cell (one NOT visible this frame) is evicted to make
 * room. Scrolling the grid therefore recycles a small pool of cells across an
 * unbounded number of thumbnails — the old behaviour silently dropped every
 * thumbnail past the 64th, leaving the rest grey.
 *
 * Decoding + upload is async: committing a cell kicks off a decode that
 * resolves into the cell. Because ShellRenderer runs a continuous rAF loop, a
 * freshly uploaded thumbnail simply appears on the next frame.
 */

const ATLAS_SIZE = 2048;
const CELL = 256;
const COLS = ATLAS_SIZE / CELL;       // 8
const MAX_CELLS = COLS * COLS;        // 64 resident cells — recycled by LRU across the whole library
// Remembered data URLs are bounded (Map-LRU) so a bulk-requested library can't retain every base64 string forever.
// Off-screen ids beyond this window drop their url (their committed cell, if any, survives); the host re-requests
// them on scroll. Sized well above the atlas so the on-screen working set is never evicted.
const URL_CACHE = MAX_CELLS * 12;     // 768

interface Cell {
  index: number;
  x: number; y: number;
  u0: number; v0: number; u1: number; v1: number;
  dataUrl: string;
  ready: boolean;
  lastUsed: number;   // frame counter of the last touch() — drives LRU eviction
}

export class ShellThumbnailAtlas {
  private device: GPUDevice;
  private texture: GPUTexture;
  private view: GPUTextureView;
  private cells = new Map<string, Cell>();    // id → its committed atlas cell (at most MAX_CELLS)
  private urls = new Map<string, string>();   // id → latest requested data URL — bounded Map-LRU (URL_CACHE)
  private failed = new Set<string>();          // data URLs that failed to load — skip until a fresh url is requested
  private nextIndex = 0;                       // next never-used cell index (until MAX_CELLS)
  private frame = 0;                           // per-frame counter (beginFrame)

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

  /** Advance the frame clock — call once per render before any touch(). LRU recency is measured in frames. */
  beginFrame(): void { this.frame++; }

  /**
   * Remember the data URL for `id`. Cheap to call repeatedly for the whole
   * library — it does NOT commit an atlas cell (touch does, on demand). If the
   * URL changed for an id that currently holds a cell, that cell reloads in place.
   */
  request(id: string, dataUrl: string): void {
    const prev = this.urls.get(id);
    if (prev === dataUrl) return;
    this.failed.delete(dataUrl);                 // a fresh url → allow (re)load even if a prior url for this id failed
    this.urls.delete(id); this.urls.set(id, dataUrl);   // move-to-end = most-recently-requested (LRU order)
    while (this.urls.size > URL_CACHE) {         // evict the oldest remembered url (its committed cell, if any, stays)
      const oldest = this.urls.keys().next().value;
      if (oldest === undefined) break;
      this.urls.delete(oldest);
    }
    const cell = this.cells.get(id);
    if (cell) {   // committed already → refresh its pixels in the same slot
      cell.dataUrl = dataUrl;
      cell.ready = false;
      void this.load(id, dataUrl, cell.index, cell.x, cell.y);
    }
  }

  /** UV rect for a cell — a FRESH literal (never the live Cell, which callers could mutate + corrupt LRU state). */
  private uv(c: Cell): { u0: number; v0: number; u1: number; v1: number } { return { u0: c.u0, v0: c.v0, u1: c.u1, v1: c.v1 }; }

  /** Pure read: the UV rect for an id that already has a READY cell, else null. No cell commit, no recency bump. */
  get(id: string): { u0: number; v0: number; u1: number; v1: number } | null {
    const c = this.cells.get(id);
    return c && c.ready ? this.uv(c) : null;
  }

  /**
   * Mark `id` as visible THIS frame and ensure it owns an atlas cell (committing
   * one — evicting the least-recently-used off-screen cell if the atlas is full —
   * and kicking a decode on first commit). Returns the UV rect once ready, else null.
   * Call only for on-screen thumbnails so off-screen ones stay evictable.
   */
  touch(id: string): { u0: number; v0: number; u1: number; v1: number } | null {
    const url = this.urls.get(id);
    if (!url || this.failed.has(url)) return null;   // no url, or a known-broken url → don't commit/retry a slot
    let cell = this.cells.get(id);
    if (cell) { cell.lastUsed = this.frame; return cell.ready ? this.uv(cell) : null; }

    const index = this.acquireIndex();
    if (index < 0) return null;   // every cell is in use this very frame (atlas smaller than the visible set) — skip
    const x = (index % COLS) * CELL, y = Math.floor(index / COLS) * CELL;
    cell = {
      index, x, y,
      u0: x / ATLAS_SIZE, v0: y / ATLAS_SIZE,
      u1: (x + CELL) / ATLAS_SIZE, v1: (y + CELL) / ATLAS_SIZE,
      dataUrl: url, ready: false, lastUsed: this.frame,
    };
    this.cells.set(id, cell);
    void this.load(id, url, index, x, y);
    return null;
  }

  /** A cell index to (re)use: a fresh one, else evict the oldest off-screen cell (reusing its slot). -1 if none free. */
  private acquireIndex(): number {
    if (this.nextIndex < MAX_CELLS) return this.nextIndex++;
    // Atlas full — evict the least-recently-touched cell that is NOT visible this frame.
    let victimId: string | null = null, oldest = Infinity;
    for (const [vid, c] of this.cells) {
      if (c.lastUsed === this.frame) continue;   // touched this frame → on-screen, never evict
      if (c.lastUsed < oldest) { oldest = c.lastUsed; victimId = vid; }
    }
    if (victimId === null) return -1;
    const v = this.cells.get(victimId)!;
    this.cells.delete(victimId);
    return v.index;
  }

  private async load(id: string, dataUrl: string, index: number, x: number, y: number): Promise<void> {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: CELL, resizeHeight: CELL, resizeQuality: 'high',
      });
      // Re-verify AFTER the async gap: the cell may have been evicted (id gone) or reassigned/reloaded (index or
      // URL changed). Writing anyway would smear one thumbnail's pixels into another's slot.
      const cell = this.cells.get(id);
      if (!cell || cell.index !== index || cell.dataUrl !== dataUrl) { bitmap.close?.(); return; }
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: this.texture, origin: { x, y } },
        { width: CELL, height: CELL },
      );
      bitmap.close?.();
      cell.ready = true;
      this.onReady?.();
    } catch {
      // Load failed: FREE the slot (was: left a ready:false cell that touch() kept most-recent but never retried,
      // permanently hogging a slot + staying grey) and mark this url broken so we don't retry it until a fresh one.
      const cell = this.cells.get(id);
      if (cell && cell.index === index && cell.dataUrl === dataUrl) this.cells.delete(id);
      this.failed.add(dataUrl);
    }
  }

  destroy(): void {
    this.texture.destroy();
    this.cells.clear();
    this.urls.clear();
    this.failed.clear();
  }
}
