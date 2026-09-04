/**
 * ShellUIManager — Delegate for the Frogmarks Shell UI.
 *
 * The shell is the WebGPU-rendered console home screen that replaces the
 * legacy HTML/SCSS dashboard. This manager owns the shell's *data and
 * state* layer:
 *
 *   • Cart registry  — system apps + installed local/remote FrogCarts
 *   • Project index   — the user's saved .frogmarks illustration projects
 *   • Dashboard state — main grid vs. Illustrations sub-dashboard,
 *                       selected/hovered slot
 *
 * It is intentionally decoupled from rendering. The WebGPU shell scene
 * (cartridge viewer, slot grid, SDF labels) subscribes to `onChange` and
 * reads state via the getters here. The renderer-coupled lifecycle
 * (`initialize`/`destroy`/`launchSlot`) is stubbed for later phases — see
 * docs/specs/shell-ui.md for the full phase plan.
 *
 * Frogmarks accesses this via `shapeManager.shell`.
 */

import type { ManagerContext } from './manager-context';
import { EventEmitter } from '../../renderer/util/event-emitter';
import {
  ShellStorage,
  ShellRegistry,
  ShellSlot,
  ProjectEntry,
  SYSTEM_APPS,
} from '../persistence/shell-storage';
import { ShellRenderer, ensureShellFont, FONT_FAMILY, TITLEBAR_FONT } from '../../renderer/shell/shell-renderer';
import { drawPlaceholderIcon, iconKindForSystemKey } from '../../renderer/shell/shell-icons';
import { SHELL_ICON_PENCIL, SHELL_ICON_GEAR, SHELL_ICON_INSTALL } from '../../renderer/shell/shell-icon-assets';
import { generateBillboard3DGeometry, type Billboard3DConfig } from '../../renderer/3d/billboard-3d';
import { unzipSync, strFromU8 } from 'fflate';
import {
  computeShellLayout,
  computeProjectGrid,
  hitTestTiles,
  hitTestProjectGrid,
  hitTestProjectGridClose,
  SHELL_PREV_ID,
  SHELL_NEXT_ID,
  SHELL_THEMES,
  type ShellThemeName,
  type ShellTheme,
  type ShellTileSpec,
  type ShellRenderModel,
  type ViewerSpec,
} from '../../renderer/shell/shell-layout';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';

/** Synthetic tile id for the trailing "＋ Install cart" slot in shell mode. */
export const SHELL_ADD_CART_ID = '__add_cart__';
/** Synthetic tile id for the leading "＋ New project" slot in Illustrations mode. */
export const SHELL_NEW_PROJECT_ID = '__new_project__';
/** Synthetic tile id for the "‹ Back" slot in Illustrations mode. */
export const SHELL_BACK_ID = '__back__';
/** Viewer key for the default "hero" billboard (shown when nothing is picked). */
export const SHELL_HERO_ID = '__hero__';
/** Viewer key for the star billboard. Kept for a future "Favorites" feature
 *  (no longer used by Install Cart, which now uses the download arrow). */
export const SHELL_STAR_ID = '__star__';

/** Viewer key for the download-arrow billboard — the Install Cart tile. */
export const SHELL_DOWNLOAD_ID = '__download__';

/** TEMP: show a demo FrogCart CD tile so the CD visual can be tuned before the
 *  cart-upload path exists. Flip off (or delete this + its use in buildSpecs)
 *  once real carts populate the registry. See docs/specs/shell-cd.md. */
const SHELL_DEMO_CD = true;

/** Dwell duration (ms) before a hovered tile auto-unfocuses. Matches the
 *  renderer's countdown ring (RING_SECONDS). */
const DWELL_MS = 3000;

/** Format an [r,g,b,a] (0..1) color as a CSS rgba() string. */
function rgbaCss(c: [number, number, number, number]): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
}

/** Load an image element from a URL or data URL (for logo injection). */
function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Bake a colored outline into an icon canvas (in place): stamp the icon's
 *  silhouette in the outline color around two rings of offsets — a cheap
 *  circular dilation — then draw the icon back on top. The color survives only
 *  in the `rimPx` band just outside every alpha edge: the outer silhouette AND
 *  the rims of interior holes, whose centers stay transparent. Lets cutout icons
 *  (gear) show see-through holes with a printed, themed rim. See
 *  `setBillboardFromImage`. */
function bakeRim(canvas: HTMLCanvasElement, rimPx: number, color: [number, number, number, number]): void {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  // Snapshot the icon, and build a flat outline-colored version of its silhouette.
  const icon = document.createElement('canvas'); icon.width = w; icon.height = h;
  icon.getContext('2d')!.drawImage(canvas, 0, 0);
  const tint = document.createElement('canvas'); tint.width = w; tint.height = h;
  const tc = tint.getContext('2d')!;
  tc.drawImage(icon, 0, 0);
  tc.globalCompositeOperation = 'source-in';
  tc.fillStyle = rgbaCss(color);
  tc.fillRect(0, 0, w, h);
  // Dilate by stamping the tinted silhouette across the whole disc (every radius
  // up to rimPx, ~1px angular spacing), then draw the icon on top. A sparse ring
  // set leaves wedge gaps at sharp convex features (the pencil tip) where the
  // discrete directions fan apart; filling the disc closes them.
  ctx.clearRect(0, 0, w, h);
  for (let r = rimPx; r >= 1; r--) {
    const steps = Math.max(8, Math.ceil(2 * Math.PI * r));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      ctx.drawImage(tint, Math.cos(a) * r, Math.sin(a) * r);
    }
  }
  ctx.drawImage(icon, 0, 0);
}

/** Which dashboard view the shell is currently presenting. */
export type ShellMode = 'shell' | 'illustrations';

/** Emitted when a tile is activated (double-click / Open / Launch intent). */
export interface ShellActivateEvent {
  id: string;
  kind: ShellTileSpec['kind'];
  /** Which dashboard the action happened in — lets the host open/create the right editor
   *  ('packaging' → Package Designer, else the illustration editor). Set for project/empty events. */
  dashboardKind?: 'illustration' | 'packaging';
}

/** Emitted when a project card's title-bar ✕ is clicked — a DELETE intent. The host (Frogmarks) opens its own
 *  confirmation/deletion modal for `id`; the shell does NOT delete anything itself. */
export interface ShellDeleteEvent {
  id: string;
  dashboardKind: 'illustration' | 'packaging';
}

/**
 * Bridge to the host's document store. The Illustrations dashboard is a
 * **view over existing `.frogmarks` documents** — a project's id equals its
 * DocumentPersistence docId. ShapeManager supplies this so the shell never
 * owns a parallel project store; opening/saving reuses the editor's existing
 * `loadDocument` / autosave path.
 */
export interface ShellDocumentSource {
  /** All saved documents as project entries, newest first. Only `id` and
   *  `name` are required; `thumbnailDataUrl` is strongly recommended (drives
   *  tile + cartridge art) and `lastModified` is optional (drives sort). */
  listProjects(): Promise<ProjectEntry[]>;
  /** Delete a document by id. */
  deleteProject(id: string): Promise<void>;
  /** Rename a document by id. */
  renameProject(id: string, name: string): Promise<void>;
  /** Mint a new document id for a blank project (used only when
   *  `createProject` is not provided). */
  newProjectId(): string;
  /**
   * Optional but recommended: create a blank project **in the host store** and
   * return its entry. When present, the New tile calls this so the entry exists
   * before `onActivate` fires — i.e. the host's open-by-id flow finds it
   * immediately. When absent, the shell only mints a transient stub via
   * `newProjectId()` and the host must treat the new id as a blank document.
   */
  createProject?(name: string): Promise<ProjectEntry>;
  /** Optional: duplicate a document, returning the new entry. */
  duplicateProject?(id: string): Promise<ProjectEntry | null>;
}

/** Snapshot of the shell's transient UI state. */
export interface ShellViewState {
  mode: ShellMode;
  selectedSlotId: string | null;
  hoveredSlotId: string | null;
}

/** Fired on any state change so the renderer/UI can re-read and redraw. */
export type ShellChangeReason =
  | 'loaded'
  | 'registry'
  | 'projects'
  | 'mode'
  | 'selection'
  | 'hover';

export class ShellUIManager {
  private ctx: ManagerContext;
  private storage = new ShellStorage();

  /** Persisted cart/system slots. System apps are NOT stored here — they
   *  are merged in at read time from SYSTEM_APPS. */
  private registry: ShellRegistry = { version: 2, slots: [] };

  /** Bridge to the host document store (set via setDocumentSource). */
  private docSource: ShellDocumentSource | null = null;
  /** In-memory project list, refreshed asynchronously from the document
   *  source so the render path can read it synchronously. */
  private projectCache: ProjectEntry[] = [];

  private view: ShellViewState = {
    mode: 'shell',
    selectedSlotId: null,
    hoveredSlotId: null,
  };

  private _loaded = false;

  /** Subscribe to be notified of any shell state change. */
  readonly onChange = new EventEmitter<ShellChangeReason>();
  /** Subscribe to tile activation (double-click / Open / Launch intent). */
  readonly onActivate = new EventEmitter<ShellActivateEvent>();
  /** Subscribe to project-card ✕ clicks (delete intent). The host opens its own deletion modal for the id. */
  readonly onProjectDelete = new EventEmitter<ShellDeleteEvent>();

  // ── Renderer-coupled scene state (populated by initializeScene) ──
  private renderer: ShellRenderer | null = null;
  private sceneCanvas: HTMLCanvasElement | null = null;
  /** Host-injected logo image (URL/data URL) for the default hero billboard. */
  private logoSrc: string | null = null;
  /** Dwell-focus state: the focused tile, its unfocus timer, and the countdown
   *  start (undefined = paused/full while the pointer is still over the tile). */
  private dwellId: string | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private dwellCountdownStart: number | undefined = undefined;
  /** HTML-in-Canvas chrome cluster (top-right icons + expanding panels). */
  private clusterEl: HTMLElement | null = null;
  private clusterCountEl: HTMLElement | null = null;
  private clusterPanelEl: HTMLElement | null = null;
  private clusterActivePanel: string | null = null;
  /** Cluster icon buttons: emoji (default) ↔ Material-style SVG (Polygon theme). */
  private clusterIcons: { el: HTMLButtonElement; emoji: string; mat: string }[] = [];
  private typewriterTimer: ReturnType<typeof setInterval> | null = null;
  /** Active color theme (the Themes app switches this). */
  private activeThemeName: ShellThemeName = 'polygon';
  private get activeTheme(): ShellTheme { return SHELL_THEMES[this.activeThemeName]; }
  private currentModel: ShellRenderModel = computeShellLayout(0, 0, []);
  /** Vertical scroll offset (device px) of the illustrations thumbnail grid. */
  private gridScrollY = 0;
  /** Clickable zoom −/+ buttons in the panel window titlebar (device-px rects). */
  private zoomButtons: { rect: [number, number, number, number]; dir: number }[] = [];
  // Mode cross-fade (home ↔ illustrations grid): a dip-to-bg transition. The
  // underlying mode flips at the midpoint (hidden by the scrim).
  private transitionActive = false;
  private transitionTo: ShellMode = 'shell';
  private transitionStart = 0;
  private transitionT = 0;
  private transitionRaf: number | null = null;
  private resumeMainOnDestroy = false;
  private changeUnsub?: () => void;
  private resizeObserver?: ResizeObserver;
  private boundPointerMove?: (e: PointerEvent) => void;
  private boundClick?: (e: MouseEvent) => void;
  private boundDblClick?: (e: MouseEvent) => void;
  private boundKeyDown?: (e: KeyboardEvent) => void;
  private boundWheel?: (e: WheelEvent) => void;
  /** Current grid page and zoom (tile-size multiplier). */
  private currentPage = 0;
  private zoom = 0.85;   // default sits a touch zoomed-out

  constructor(ctx: ManagerContext) {
    this.ctx = ctx;
  }

  // ── Lifecycle: load persisted state ──────────────────────────────────

  /** True once `load()` has completed at least once. */
  get isLoaded(): boolean { return this._loaded; }

  /** True when OPFS persistence is available in this environment. */
  get isPersistenceAvailable(): boolean { return ShellStorage.isAvailable(); }

  /**
   * Load the cart registry from OPFS and refresh the project list from the
   * document source. Safe to call before any rendering is wired up. Degrades
   * to empty indexes if OPFS is unavailable or the stored data is corrupt.
   */
  private _loadPromise: Promise<void> | null = null;
  async load(): Promise<void> {
    // Idempotent under concurrency: initializeScene + the host may both call load(); memoize the in-flight promise
    // so the OPFS registry read + the 'loaded' emit happen once, not twice.
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      this.registry = ShellStorage.isAvailable()
        ? await this.storage.loadRegistry()
        : { version: 2, slots: [] };
      this._loaded = true;
      this.onChange.emit('loaded');
      void this.refreshProjects();
    })();
    return this._loadPromise;
  }

  /**
   * Wire the host document store. ShapeManager calls this. Triggers an
   * initial project-list refresh.
   */
  setDocumentSource(src: ShellDocumentSource): void {
    this.docSource = src;
    void this.refreshProjects();
  }

  /** Re-read the project list from the document source into the cache. Multiple refreshes can be in flight
   *  (load/setMode/recordProjectSave/…); a request-id guard drops any result that isn't the latest so a slow older
   *  read can't clobber a newer snapshot. */
  private _refreshSeq = 0;
  async refreshProjects(): Promise<void> {
    if (!this.docSource) return;
    const seq = ++this._refreshSeq;
    try {
      const all = await this.docSource.listProjects();
      if (seq !== this._refreshSeq) return;   // a newer refresh already landed — discard this stale snapshot
      // Show only the documents for the active dashboard (untagged = 'illustration').
      this.projectCache = all.filter(p => (p.kind ?? 'illustration') === this.dashboardKind);
      this._sortedProjects = null;
      this.onChange.emit('projects');
    } catch {
      /* keep the last good cache */
    }
  }

  // ── Cart registry: reads ─────────────────────────────────────────────

  /**
   * The full ordered slot list for the main shell grid: the two pinned
   * system apps first, then installed carts sorted by `order`. System
   * apps are re-derived from SYSTEM_APPS each call so a code change to
   * the app set takes effect without a registry migration.
   */
  getSlots(): ShellSlot[] {
    const carts = [...this.registry.slots]
      .filter(s => s.type !== 'system')
      .sort((a, b) => a.order - b.order);
    // Re-base cart order after the pinned system apps.
    const base = SYSTEM_APPS.length;
    const carts2 = carts.map((s, i) => ({ ...s, order: base + i }));
    return [...SYSTEM_APPS.map(s => ({ ...s })), ...carts2];
  }

  /** Raw persisted registry (carts only — no system apps). */
  getRegistry(): ShellRegistry {
    return { version: 2, slots: this.registry.slots.map(s => ({ ...s })) };
  }

  /** Look up a single slot by id (searches system apps + carts). */
  getSlot(slotId: string): ShellSlot | null {
    const sys = SYSTEM_APPS.find(s => s.id === slotId);
    if (sys) return { ...sys };
    const cart = this.registry.slots.find(s => s.id === slotId);
    return cart ? { ...cart } : null;
  }

  // ── Cart registry: mutations ─────────────────────────────────────────

  /**
   * Insert or replace a cart slot in the registry. Returns the stored
   * slot. The caller is responsible for having written any cart binary /
   * thumbnail beforehand (see ShellStorage). System slots are rejected —
   * they are hardcoded.
   */
  async upsertCartSlot(slot: ShellSlot): Promise<ShellSlot> {
    if (slot.type === 'system') {
      throw new Error('System app slots are hardcoded and cannot be persisted.');
    }
    const idx = this.registry.slots.findIndex(s => s.id === slot.id);
    if (idx >= 0) {
      this.registry.slots[idx] = { ...slot };
    } else {
      // New carts go to the end of the cart list.
      const maxOrder = this.registry.slots.reduce((m, s) => Math.max(m, s.order), SYSTEM_APPS.length - 1);
      this.registry.slots.push({ ...slot, order: maxOrder + 1 });
    }
    await this.persistRegistry('registry');
    return this.getSlot(slot.id)!;
  }

  /** Apply a partial patch to an existing cart slot. */
  async patchCartSlot(slotId: string, patch: Partial<ShellSlot>): Promise<void> {
    const idx = this.registry.slots.findIndex(s => s.id === slotId);
    if (idx < 0) return;
    this.registry.slots[idx] = { ...this.registry.slots[idx], ...patch, id: slotId, type: this.registry.slots[idx].type };
    await this.persistRegistry('registry');
  }

  /** "Import" tile: open the OS file picker (restricted to .frogcart), then
   *  install the chosen file locally. Must run inside the click gesture. */
  private importCartFromFile(): void {
    if (typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.frogcart';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void this.installLocalCart(file);
    }, { once: true });
    // Dismissing the picker fires `cancel` (not `change`) in modern browsers → the hidden input would otherwise
    // stay appended to <body> and accumulate on every cancelled import. Remove it on cancel too.
    input.addEventListener('cancel', () => input.remove(), { once: true });
    document.body.appendChild(input);
    input.click();
  }

  /** Store an imported .frogcart in OPFS and register its cart slot. The cart
   *  name comes from the zip's manifest.json (`name`), else the filename. */
  private async installLocalCart(file: File): Promise<void> {
    if (!ShellStorage.isAvailable()) {
      console.warn('[Shell] Cannot import cart — OPFS storage is unavailable.');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      let name = file.name.replace(/\.frogcart$/i, '').trim() || 'Cart';
      let description: string | undefined;
      try {
        const mf = unzipSync(new Uint8Array(buffer))['manifest.json'];
        if (mf) {
          const m = JSON.parse(strFromU8(mf)) as { name?: unknown; description?: unknown };
          if (typeof m.name === 'string' && m.name.trim()) name = m.name.trim();
          if (typeof m.description === 'string') description = m.description;
        }
      } catch { /* not a valid zip / no manifest → keep the filename */ }
      const id = crypto.randomUUID();
      const opfsPath = await this.storage.writeLocalCart(id, buffer);
      await this.upsertCartSlot({ id, type: 'local', name, description, opfsPath, order: 0 });
      this.setSelectedSlot(id);   // focus the freshly installed cart
    } catch (e) {
      console.warn('[Shell] Failed to import cart:', e);
    }
  }

  /** Remove a cart slot and its on-disk binaries. */
  async removeCartSlot(slotId: string): Promise<void> {
    const idx = this.registry.slots.findIndex(s => s.id === slotId);
    if (idx < 0) return;
    this.registry.slots.splice(idx, 1);
    await this.storage.deleteCartBinaries(slotId);
    if (this.view.selectedSlotId === slotId) this.view.selectedSlotId = null;
    await this.persistRegistry('registry');
  }

  /**
   * Move a cart slot to a new position among the carts. `newOrder` is an
   * absolute order value; system apps stay pinned regardless.
   */
  async reorderCartSlot(slotId: string, newOrder: number): Promise<void> {
    const slot = this.registry.slots.find(s => s.id === slotId);
    if (!slot) return;
    slot.order = newOrder;
    // Normalize so orders are dense and start after the system apps.
    const sorted = [...this.registry.slots].sort((a, b) => a.order - b.order);
    sorted.forEach((s, i) => { s.order = SYSTEM_APPS.length + i; });
    await this.persistRegistry('registry');
  }

  // ── Project reads (from the in-memory cache) ─────────────────────────

  /** All projects, most-recently-modified first (Illustrations grid order).
   *  Reads the in-memory cache synchronously; call `refreshProjects()` to
   *  re-pull from the document store. */
  private _sortedProjects: ProjectEntry[] | null = null;   // memoized sort+clone; invalidated on any projectCache change
  getProjects(): ProjectEntry[] {
    // Memoized: a single Illustrations rebuild calls this from requestThumbnails AND buildProjectGrid (and rebuilds
    // fire on every hover), so the sort + per-entry clone ran 2-3× per hover. Treat the result as read-only.
    return this._sortedProjects ??= [...this.projectCache]
      .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
      .map(p => ({ ...p }));
  }

  /** Look up a single project by id (from the cache). */
  getProject(projectId: string): ProjectEntry | null {
    const p = this.projectCache.find(p => p.id === projectId);
    return p ? { ...p } : null;
  }

  // ── Project mutations (delegate to the document store) ───────────────

  /**
   * Mint a blank project and return its entry. The id **is** a new document
   * id — the host opens a blank document with it; on first save it appears
   * in the store. The entry is added to the cache optimistically so the tile
   * shows immediately.
   */
  async createProject(name = 'Untitled Project'): Promise<ProjectEntry> {
    // Prefer the host's create hook (entry exists in their store before we
    // open it); otherwise mint a transient stub the host treats as blank.
    let entry: ProjectEntry;
    if (this.docSource?.createProject) {
      entry = await this.docSource.createProject(name);
    } else {
      const id = this.docSource?.newProjectId() ?? crypto.randomUUID();
      entry = { id, name, lastModified: Date.now() };
    }
    // Only show the optimistic tile if the new entry belongs to the ACTIVE dashboard — otherwise it would flash in
    // the wrong grid until the next refresh filters it out.
    if ((entry.kind ?? 'illustration') === this.dashboardKind) {
      this.projectCache = [entry, ...this.projectCache.filter(p => p.id !== entry.id)];
      this._sortedProjects = null;
      this.onChange.emit('projects');
    }
    return { ...entry };
  }

  /** Rename a project (rewrites the document manifest name). */
  async renameProject(projectId: string, name: string): Promise<void> {
    await this.docSource?.renameProject(projectId, name);
    const p = this.projectCache.find(p => p.id === projectId);
    if (p) { p.name = name; p.lastModified = Date.now(); }
    this.onChange.emit('projects');
  }

  /**
   * Note that a project was saved. The thumbnail now lives in the document
   * manifest, so the host need not pass one — but an optimistic patch makes
   * the grid update instantly. Always reconciles from the store afterward.
   */
  async recordProjectSave(
    projectId: string,
    opts: { thumbnailDataUrl?: string; sizeBytes?: number } = {},
  ): Promise<void> {
    const p = this.projectCache.find(p => p.id === projectId);
    if (p) {
      p.lastModified = Date.now();
      if (opts.thumbnailDataUrl !== undefined) p.thumbnailDataUrl = opts.thumbnailDataUrl;
      if (opts.sizeBytes !== undefined) p.sizeBytes = opts.sizeBytes;
      this.onChange.emit('projects');
    }
    void this.refreshProjects();
  }

  /** Delete a project (deletes the underlying document + any exported copy). */
  async deleteProject(projectId: string): Promise<void> {
    await this.docSource?.deleteProject(projectId);
    this.projectCache = this.projectCache.filter(p => p.id !== projectId);
    this._sortedProjects = null;
    if (this.view.selectedSlotId === projectId) this.view.selectedSlotId = null;
    // Best-effort cleanup of any exported .frogmarks package.
    await this.storage.deleteProjectFile(projectId);
    this.onChange.emit('projects');
  }

  /**
   * Duplicate a project. Requires the document source to support it (copying
   * a live document is the host's job); returns null if unsupported.
   */
  async duplicateProject(projectId: string): Promise<ProjectEntry | null> {
    if (!this.docSource?.duplicateProject) return null;
    const entry = await this.docSource.duplicateProject(projectId);
    await this.refreshProjects();
    return entry;
  }

  /** Direct access to the storage layer for cart binaries + exported
   *  `.frogmarks` packages. (The live project store is the document source.) */
  get fileStore(): ShellStorage { return this.storage; }

  // ── Dashboard view state ─────────────────────────────────────────────

  /** Current transient view state (mode + selection + hover). */
  getViewState(): ShellViewState { return { ...this.view }; }

  /** Switch between the main shell grid and the Illustrations sub-dashboard. */
  setMode(mode: ShellMode): void {
    if (this.view.mode === mode) return;
    this.view.mode = mode;
    // Selection is scoped to a dashboard; clear it on transition.
    this.view.selectedSlotId = null;
    this.currentPage = 0;
    this.gridScrollY = 0;   // reset the illustrations grid scroll on entry/exit
    // Entering the project browser — pull a fresh list from the store.
    if (mode === 'illustrations') void this.refreshProjects();
    this.onChange.emit('mode');
  }

  /** Which project dashboard is active: Illustrator ('illustration') or Package Designer ('packaging').
   *  Both reuse the 'illustrations' shell MODE; this axis filters the project list + labels the New tile. */
  private dashboardKind: 'illustration' | 'packaging' = 'illustration';
  getDashboardKind(): 'illustration' | 'packaging' { return this.dashboardKind; }

  openIllustratorDashboard(): void { this.dashboardKind = 'illustration'; this.startModeTransition('illustrations'); }
  /** Package Designer sub-dashboard — same project grid, filtered to packaging-kind documents. */
  openPackageDashboard(): void { this.dashboardKind = 'packaging'; this.startModeTransition('illustrations'); }
  closeIllustratorDashboard(): void { this.startModeTransition('shell'); }

  /** Animate a dip-to-background cross-fade between the shell home and the
   *  illustrations grid, flipping the underlying mode at the midpoint (hidden by
   *  the scrim, so each view is only ever shown alone). */
  private startModeTransition(to: ShellMode): void {
    if (!this.transitionActive && this.view.mode === to) return;   // already there
    this.transitionTo = to;
    this.transitionStart = performance.now();
    this.transitionActive = true;
    if (this.transitionRaf == null) this.transitionRaf = requestAnimationFrame(this.tickTransition);
  }

  private tickTransition = (): void => {
    const DURATION = 380;   // ms
    const t = Math.min(1, (performance.now() - this.transitionStart) / DURATION);
    this.transitionT = t;
    if (t >= 0.5 && this.view.mode !== this.transitionTo) {
      this.setMode(this.transitionTo);   // flip at the dip → emits → rebuildAndRender
    } else {
      this.rebuildAndRender();           // refresh modeFade (+ current view)
    }
    if (t < 1) {
      this.transitionRaf = requestAnimationFrame(this.tickTransition);
    } else {
      this.transitionActive = false;
      this.transitionRaf = null;
      this.rebuildAndRender();           // settle modeFade to 0/1
    }
  };

  /** Drives the cartridge / sketchbook viewer. Pass null to deselect. */
  setSelectedSlot(slotId: string | null): void {
    if (this.view.selectedSlotId === slotId) return;
    this.view.selectedSlotId = slotId;
    this.onChange.emit('selection');
  }

  /** Drives the hover lift on grid tiles. Pass null to clear. */
  setHoveredSlot(slotId: string | null): void {
    if (this.view.hoveredSlotId === slotId) return;
    this.view.hoveredSlotId = slotId;
    this.onChange.emit('hover');
  }

  /**
   * Hover handling with a *dwell linger*. Hovering a tile focuses it and shows
   * a full ring; while the pointer stays over the tile the ring stays full
   * (paused). When the pointer LEAVES the tile, a 3s countdown ring runs, then
   * the tile auto-unfocuses. Re-entering pauses again; hovering a different
   * tile re-focuses. Page arrows hover instantly (no dwell).
   */
  private handleHover(hit: string | null): void {
    // Illustrations grid: plain hover (lift/brighten), no dwell ring.
    if (this.view.mode === 'illustrations') { this.setHoveredSlot(hit); return; }
    const isArrow = !!hit && this.currentModel.arrows.some(a => a.id === hit);
    if (isArrow) {
      this.clearDwell();
      this.setHoveredSlot(hit);
      return;
    }
    if (hit) {
      if (hit !== this.dwellId) this.focusTile(hit);    // new tile → focus (ring full)
      else this.pauseDwell();                            // still over it → keep ring full
    } else if (this.dwellId) {
      this.startCountdown();                             // left the tile → begin the countdown
    } else if (this.view.hoveredSlotId) {
      this.setHoveredSlot(null);                         // left an arrow into empty space
    }
  }

  private focusTile(id: string): void {
    this.clearDwellTimer();
    this.dwellId = id;
    this.dwellCountdownStart = undefined;                // paused while hovering
    this.setHoveredSlot(id);                             // → rebuild (full ring + billboard)
  }

  /** Pointer back over the focused tile → pause the countdown (ring full). */
  private pauseDwell(): void {
    if (this.dwellTimer === null && this.dwellCountdownStart === undefined) return;
    this.clearDwellTimer();
    this.dwellCountdownStart = undefined;
    this.rebuildAndRender();
  }

  /** Pointer left the focused tile → run the 3s countdown ring, then unfocus. */
  private startCountdown(): void {
    if (this.dwellCountdownStart !== undefined) return;  // already counting
    this.dwellCountdownStart = performance.now() / 1000;
    this.clearDwellTimer();
    this.dwellTimer = setTimeout(() => this.expireDwell(), DWELL_MS);
    this.rebuildAndRender();
  }

  private expireDwell(): void {
    this.dwellTimer = null;
    this.dwellId = null;
    this.dwellCountdownStart = undefined;
    this.setHoveredSlot(null);                           // unfocus (ring gone, billboard → hero)
  }

  private clearDwell(): void {
    this.clearDwellTimer();
    this.dwellId = null;
    this.dwellCountdownStart = undefined;
  }
  private clearDwellTimer(): void {
    if (this.dwellTimer !== null) { clearTimeout(this.dwellTimer); this.dwellTimer = null; }
  }

  // ── Renderer-coupled scene lifecycle ─────────────────────────────────
  //
  // The shell borrows the main renderer's GPUDevice + canvas context and
  // draws to the same swapchain while the main render loop is paused. This
  // keeps the integration additive — webgpu-renderer.ts exposes read-only
  // getters and is otherwise untouched. Phase 1 renders the slot grid
  // (rounded-rect tiles); the cartridge viewer + SDF labels land later.

  /** True while the shell scene is mounted and owning the canvas. */
  get isSceneActive(): boolean { return this.renderer !== null; }

  /**
   * Mount the shell scene onto the shared canvas. Pauses the main renderer,
   * builds the grid, and wires pointer/keyboard interaction. Idempotent —
   * a second call while active is a no-op.
   *
   * The shell and editor share **one** canvas and **one** `GPUDevice`: the
   * shell borrows the main renderer's device and configures the *passed
   * canvas's* own WebGPU context, then pauses the main loop while it owns the
   * surface. `destroyScene()` resumes the main renderer. This matches the
   * "one canvas, one owner" model (no routing, mode is a state toggle).
   *
   * The device must already be initialized — the host should let ShapeManager
   * finish WebGPU init before the first mount. (A shared canvas cannot hold a
   * second, self-initialized device.)
   */
  async initializeScene(canvas: HTMLCanvasElement): Promise<void> {
    if (this.renderer) return;
    if (!this._loaded) await this.load();

    const main = this.ctx.webgpuRenderer;
    const device = main.getDevice();
    if (!device) {
      throw new Error('ShellUIManager.initializeScene: WebGPU device not ready. Await the main renderer\'s WebGPU init before mounting the shell (shared canvas → shared device).');
    }
    const format = main.getSwapChainFormat();

    // Configure the *passed* canvas's context. In the shared-canvas model
    // this is the same context the main renderer uses; reconfiguring with the
    // same device/format is idempotent and also covers the shell-first case
    // where the main renderer hasn't configured it yet.
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) {
      throw new Error('ShellUIManager.initializeScene: could not acquire a WebGPU context from the canvas.');
    }
    // Match the editor's context usage (incl. COPY_DST) so handing the canvas
    // back doesn't leave the editor's compositor unable to copy → black canvas.
    context.configure({
      device, format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      alphaMode: 'premultiplied',
    });

    // Hard-suspend the editor renderer and take over the canvas. suspendRendering
    // (not pause) also blocks the on-demand scheduleRender path, so editor
    // pointer/resize events can't repaint the whiteboard over the shell.
    this.resumeMainOnDestroy = main.isLive;
    main.suspendRendering();

    // If ANY step below throws after the suspend, the editor would be left hard-suspended AND destroyScene would
    // early-return (renderer null) → permanent black canvas. Restore the editor on failure and rethrow.
    try {
      this.sceneCanvas = canvas;
      this.renderer = new ShellRenderer(device, context, format, canvas);
      this.syncCanvasBackingStore();
      void this.refreshProjects();

      // Reactively redraw whenever shell state changes.
      this.changeUnsub = this.onChange.subscribe(() => this.rebuildAndRender()).unsubscribe;

      this.generateSystemIcons();
      this.attachInteraction(canvas);
      this.rebuildAndRender();
      this.mountChromeCluster();  // top-right utility icons + panels (HTML-in-Canvas)
      this.renderer.start(); // idle cartridge animation

      // Load the Bungee web font, then re-rasterize the labels with it.
      ensureShellFont().then(() => {
        this.renderer?.invalidateText();
        this.rebuildAndRender();
      });
    } catch (e) {
      try { this.detachInteraction(); } catch { /* best-effort */ }
      this.changeUnsub?.(); this.changeUnsub = undefined;
      try { this.renderer?.destroy(); } catch { /* best-effort */ }
      this.renderer = null;
      this.sceneCanvas = null;
      main.resumeRendering();
      if (this.resumeMainOnDestroy) main.play();
      this.resumeMainOnDestroy = false;
      throw e;
    }
  }

  /** Build placeholder icon cutouts for the system apps: draw a transparent
   *  silhouette → upload to the thumbnail atlas + generate a Billboard3D mesh.
   *  Re-run each mount (the renderer/viewer is recreated on mount). */
  private generateSystemIcons(): void {
    if (!this.renderer) return;
    const make = (key: string, iconKind: Parameters<typeof drawPlaceholderIcon>[0]) => {
      const icon = drawPlaceholderIcon(iconKind);
      this.renderer!.requestThumbnail(key, icon.dataUrl);
      const geo = generateBillboard3DGeometry(icon.rgba, icon.w, icon.h, {
        borderPx: 6, depth: 0.05, sideColor: [1, 1, 1, 1],
      });
      this.renderer!.setSystemIcon(key, geo);
    };
    for (const app of SYSTEM_APPS) {
      // Pencil + gear use real PNG art (embedded data URLs), baked as cutouts
      // (rimPx > 0) so the gear's holes read as true see-through gaps with a rim.
      if (app.systemKey === 'illustrator') { void this.setBillboardFromImage(app.id, SHELL_ICON_PENCIL, { alphaThreshold: 110 }, 8); continue; }
      if (app.systemKey === 'settings')    { void this.setBillboardFromImage(app.id, SHELL_ICON_GEAR,   { alphaThreshold: 110 }, 8); continue; }
      make(app.id, iconKindForSystemKey(app.systemKey));
    }
    make(SHELL_STAR_ID, 'star');          // kept for a future Favorites feature
    // Install Cart: real PNG art (arrow + tray), baked as a cutout. The bake's
    // dilation bridges the arrow→tray gap so both parts trace as one silhouette.
    void this.setBillboardFromImage(SHELL_DOWNLOAD_ID, SHELL_ICON_INSTALL, { alphaThreshold: 110 }, 8);
    // Hero: the host's injected logo (re-baked with the theme outline) if present,
    // else the frog placeholder. Don't reset to the frog when a logo exists — it
    // would flash during the async re-bake (e.g. on every theme switch).
    if (this.logoSrc) void this.applyLogoBillboard();
    else make(SHELL_HERO_ID, 'frog');
  }

  /** Inject the host's logo image (URL or data URL) to use as the default hero
   *  Billboard3D. Safe to call before or after the scene initializes — the
   *  logo is (re)applied whenever the renderer is available. The image should
   *  have a transparent background so the cutout silhouette traces cleanly. */
  setLogoBillboard(src: string): void {
    this.logoSrc = src;
    if (this.renderer) void this.applyLogoBillboard();
  }

  private _logoReady = false;
  /** Rasterize the injected logo → Billboard3D geometry, registered as the hero. On the FIRST load, keep the hero
   *  slot EMPTY until the logo image has decoded + baked, then FADE it in (~0.5s) — no white-card flash. Re-bakes
   *  (theme switch) don't re-hide/fade — the logo already exists. (Bouncing-dots placeholder is kept for reuse.) */
  private async applyLogoBillboard(): Promise<void> {
    if (!this.logoSrc) return;
    const firstLoad = !this._logoReady;
    if (firstLoad) this.renderer?.hideHero();
    await this.setBillboardFromImage(SHELL_HERO_ID, this.logoSrc, { borderPx: 12 });
    if (firstLoad) { this._logoReady = true; this.renderer?.revealHero(); this.rebuildAndRender(); }
  }

  /** Load an image (URL or data URL) → Billboard3D cutout + atlas thumbnail,
   *  registered under `key`. The image should have a transparent background so
   *  the silhouette traces cleanly. Shared by the host logo and the PNG-art
   *  system icons (pencil/gear). */
  private _iconBakeGen = 0;   // bumped on every theme switch; a bake whose gen is stale drops its result
  private async setBillboardFromImage(key: string, src: string, cfg: Partial<Billboard3DConfig> = {}, rimPx = 0): Promise<void> {
    if (!this.renderer) return;
    const gen = this._iconBakeGen;
    try {
      const img = await loadImageEl(src);
      if (gen !== this._iconBakeGen || !this.renderer) return;   // theme switched (or torn down) mid-load → stale bake
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) return;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      // Cutout mode (rimPx > 0): bake a themed outline around every alpha edge —
      // the outer silhouette AND interior holes — so the holes can render as
      // true see-through gaps with a printed rim. The bake also pre-dilates the
      // mask, so geometry needs no borderPx and triangulates the smoothed shape.
      const outline = cfg.sideColor ?? this.activeTheme.billboardOutline;
      const cutout = rimPx > 0;
      if (cutout) bakeRim(canvas, rimPx, outline);
      const atlasSrc = cutout ? canvas.toDataURL() : src;   // baked image → atlas
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const geo = generateBillboard3DGeometry(rgba, w, h, {
        borderPx: cutout ? 0 : 6, depth: 0.05, sideColor: outline, cutoutHoles: cutout, ...cfg,
      });
      this.renderer.requestThumbnail(key, atlasSrc);
      this.renderer.setSystemIcon(key, geo);
      this.rebuildAndRender();
    } catch (e) {
      console.warn('[Shell] Failed to load icon billboard:', key, e);
    }
  }

  // ── HTML-in-Canvas (experimental) ────────────────────────────────────
  //
  // A live DOM element rendered INTO the shell scene (or overlay fallback).
  // First use: a styled local-model-URL input. Whether it composites in-canvas
  // depends on Chrome's HTML-in-Canvas flag/origin-trial; otherwise it falls
  // back to a positioned overlay. Either way the input is fully interactive.

  /** Switch the active color theme (the Themes app). */
  setTheme(name: ShellThemeName): void {
    if (!SHELL_THEMES[name] || name === this.activeThemeName) return;
    this.activeThemeName = name;
    this._iconBakeGen++;         // invalidate any in-flight icon bake from the previous theme
    this.generateSystemIcons();  // re-bake the PNG-art cutouts with the new themed outline
    this.rebuildAndRender();
  }
  getThemeName(): ShellThemeName { return this.activeThemeName; }

  /** True when the experimental HTML-in-Canvas API is active (else overlay). */
  get htmlInCanvasSupported(): boolean { return this.renderer?.htmlSupported ?? false; }

  /** Persisted local-inference model URL. */
  getLocalModelUrl(): string {
    try { return localStorage.getItem('frogmarks.localModelUrl') ?? ''; } catch { return ''; }
  }

  /** Mount the top-right utility cluster (icons + expanding panels) as a
   *  positioned overlay over the canvas. (Reliably visible + interactive; the
   *  experimental in-canvas compositing path is kept on ShellHtmlLayer for the
   *  input specifically, but the always-on chrome uses a plain overlay.) */
  private _clusterScrollHandler: (() => void) | null = null;
  private _clusterRepositionRaf = 0;
  private mountChromeCluster(): void {
    if (!this.sceneCanvas) return;
    if (!this.clusterEl) {
      this.clusterEl = this.buildChromeCluster();
      this.clusterEl.style.position = 'fixed';
      this.clusterEl.style.zIndex = '50';
      document.body.appendChild(this.clusterEl);
    }
    // The cluster is a `position:fixed` overlay pinned to the canvas rect. Resize already flows through the
    // ResizeObserver, but a page SCROLL (or window move) shifts the canvas without a size change — reposition on
    // scroll too, coalesced to one rAF so fast scrolling can't thrash layout. Removed in destroyScene.
    if (!this._clusterScrollHandler) {
      this._clusterScrollHandler = () => {
        if (this._clusterRepositionRaf) return;
        this._clusterRepositionRaf = requestAnimationFrame(() => { this._clusterRepositionRaf = 0; this.positionChromeCluster(); });
      };
      window.addEventListener('scroll', this._clusterScrollHandler, { passive: true, capture: true });
      window.addEventListener('resize', this._clusterScrollHandler, { passive: true });
    }
    this.positionChromeCluster();
    this.updateChromeCluster();
  }

  /** Pin the cluster to the canvas's top-right (grows leftward as panels open). */
  private positionChromeCluster(): void {
    const c = this.sceneCanvas;
    if (!c || !this.clusterEl) return;
    const r = c.getBoundingClientRect();
    this.clusterEl.style.top = `${r.top + 16}px`;
    // Right edge lines up with the bottom panel window's right edge.
    const inset = r.width * this.activeTheme.cardMarginXFrac;
    this.clusterEl.style.right = `${Math.max(0, window.innerWidth - r.right) + inset}px`;
  }

  private _clusterThemeApplied: ShellThemeName | null = null;   // guards the theme CSS + SVG-glyph rewrite
  private _clusterCountApplied = -1;                            // guards the "N CARTS" text
  /** Refresh the cluster's count + theme colors + position. Called on every model rebuild (incl. hover), so the
   *  expensive parts — the CSS-var writes and the per-icon SVG innerHTML re-parse — are guarded to only run when the
   *  THEME actually changes (was: torn down + re-parsed on every mouse-move). */
  private updateChromeCluster(): void {
    if (!this.clusterEl) return;
    this.positionChromeCluster();
    const themeChanged = this.activeThemeName !== this._clusterThemeApplied;
    if (themeChanged) {
      this._clusterThemeApplied = this.activeThemeName;
      this.clusterEl.style.setProperty('--ink', rgbaCss(this.activeTheme.ink));
      this.clusterEl.style.setProperty('--panel', rgbaCss(this.activeTheme.panelColor));
      // Dim the Win9x bevel on Polygon (the bright cream border glares on black); default elsewhere.
      const dimBevel = this.activeTheme.backdropGrid;   // all 3D themes (dark bg) dim the chrome bevel
      this.clusterEl.style.setProperty('--bv-hi', dimBevel ? '#d2cec6' : '#fffaf0');   // 0.825× the default bevel
      this.clusterEl.style.setProperty('--bv-lo', dimBevel ? '#6d6859' : '#847e6c');
      // Polygon: swap the emoji glyphs for clean Material-style SVG icons; emoji on the other themes.
      const useMat = this.activeTheme.backdropGrid;   // all 3D themes use the Material SVG icons
      for (const ic of this.clusterIcons) {
        if (useMat) ic.el.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="display:block"><path d="${ic.mat}"/></svg>`;
        else ic.el.textContent = ic.emoji;
      }
    }
    const n = this.registry.slots.length;
    if (this.clusterCountEl && (themeChanged || n !== this._clusterCountApplied)) {
      this._clusterCountApplied = n;
      this.clusterCountEl.textContent = `${n} CART${n === 1 ? '' : 'S'}`;
      this.clusterCountEl.style.color = rgbaCss(this.activeTheme.chromeText ?? this.activeTheme.ink);   // white on Polygon
    }
  }

  private buildChromeCluster(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:system-ui,sans-serif;--ink:#1a4c7c;--panel:#f6efdd;';

    // Win9x raised bevel: light top/left, dark bottom/right, sharp corners. Colors are CSS vars so a
    // theme can dim them (Polygon does — bright cream glares on black). Fallbacks = the default bevel.
    const winBevel = 'border:2px solid;border-color:var(--bv-hi,#fffaf0) var(--bv-lo,#847e6c) var(--bv-lo,#847e6c) var(--bv-hi,#fffaf0);border-radius:0;';
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;gap:2px;background:var(--panel);${winBevel}padding:5px 8px;box-shadow:0 2px 8px rgba(0,0,0,0.18);`;
    // Material-style icon paths (24px). Shown instead of the emoji on Polygon; fill=currentColor → --ink.
    const MAT_SAVE = 'M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z';
    const MAT_MEMORY = 'M15 9H9v6h6V9zm-2 4h-2v-2h2v2zm8-2v-2h-2V7c0-1.1-.9-2-2-2h-2V3h-2v2h-2V3H9v2H7c-1.1 0-2 .9-2 2v2H3v2h2v2H3v2h2v2c0 1.1.9 2 2 2h2v2h2v-2h2v2h2v-2h2c1.1 0 2-.9 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z';
    const MAT_PALETTE = 'M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c1.38 0 2.5-1.12 2.5-2.5 0-.61-.23-1.2-.64-1.67-.08-.1-.13-.21-.13-.33 0-.28.22-.5.5-.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9zm5.5 11c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm-3-4c-.83 0-1.5-.67-1.5-1.5S13.67 6 14.5 6s1.5.67 1.5 1.5S15.33 9 14.5 9zM5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S7.33 13 6.5 13 5 12.33 5 11.5zm6-4c0 .83-.67 1.5-1.5 1.5S8 8.33 8 7.5 8.67 6 9.5 6s1.5.67 1.5 1.5z';
    const MAT_INFO = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z';
    this.clusterIcons = [];
    const iconBtn = (glyph: string, key: string, title: string, mat: string) => {
      const b = document.createElement('button');
      b.textContent = glyph; b.title = title;
      b.style.cssText = 'display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--ink);font-size:17px;line-height:1;width:30px;height:30px;border-radius:8px;cursor:pointer;';
      b.onmouseenter = () => { b.style.background = 'rgba(0,0,0,0.08)'; };
      b.onmouseleave = () => { b.style.background = 'transparent'; };
      b.onclick = () => this.toggleClusterPanel(key);
      this.clusterIcons.push({ el: b, emoji: glyph, mat });
      return b;
    };
    row.appendChild(iconBtn('💾', 'opfs', 'Storage usage', MAT_SAVE));
    row.appendChild(iconBtn('🧠', 'inference', 'Local model', MAT_MEMORY));
    row.appendChild(iconBtn('🎨', 'themes', 'Themes', MAT_PALETTE));
    const count = document.createElement('span');
    count.style.cssText = 'color:var(--ink);font-weight:800;font-size:12px;letter-spacing:0.06em;padding:0 9px;margin:0 3px;border-left:2px solid var(--ink);border-right:2px solid var(--ink);';
    this.clusterCountEl = count;
    row.appendChild(count);
    row.appendChild(iconBtn('ⓘ', 'info', 'What is a .frogcart?', MAT_INFO));
    wrap.appendChild(row);

    const panel = document.createElement('div');
    panel.style.cssText = `display:none;box-sizing:border-box;width:300px;background:var(--panel);${winBevel}padding:12px 14px;color:var(--ink);font-size:13px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,0.22);`;
    this.clusterPanelEl = panel;
    wrap.appendChild(panel);
    return wrap;
  }

  private toggleClusterPanel(key: string): void {
    const panel = this.clusterPanelEl;
    if (!panel) return;
    this.stopTypewriter();
    if (this.clusterActivePanel === key) { panel.style.display = 'none'; this.clusterActivePanel = null; return; }
    this.clusterActivePanel = key;
    panel.style.display = 'block';
    panel.innerHTML = '';
    if (key === 'info') {
      const p = document.createElement('div'); panel.appendChild(p);
      this.typewrite(p, 'A .frogcart is a self-contained Frogmarks mini-app; a tool, illustration, 3D scene, or animation you install into your dashboard. Each one adds its own tile here.');
    } else if (key === 'opfs') {
      panel.textContent = 'Reading storage…';
      void this.fillOpfsPanel(panel);
    } else if (key === 'inference') {
      this.fillInferencePanel(panel);
    } else if (key === 'themes') {
      this.fillThemesPanel(panel);
    }
  }

  private async fillOpfsPanel(panel: HTMLElement): Promise<void> {
    try {
      const est = await navigator.storage?.estimate?.();
      const usedMB = ((est?.usage ?? 0) / 1048576).toFixed(1);
      const quotaMB = ((est?.quota ?? 0) / 1048576).toFixed(0);
      const pct = est?.quota ? Math.round(((est.usage ?? 0) / est.quota) * 100) : 0;
      panel.innerHTML = `<b>Storage (OPFS)</b><br>${usedMB} MB used${quotaMB !== '0' ? ` · ~${quotaMB} MB available (${pct}%)` : ''}`;
    } catch { panel.textContent = 'Storage estimate unavailable.'; }
  }

  private fillInferencePanel(panel: HTMLElement): void {
    const label = document.createElement('div'); label.textContent = 'Local model URL'; label.style.cssText = 'font-weight:700;margin-bottom:6px;';
    const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = 'http://localhost:11434'; input.value = this.getLocalModelUrl();
    input.style.cssText = 'flex:1;min-width:0;border:1px solid var(--ink);background:rgba(255,255,255,0.92);border-radius:8px;padding:6px 8px;color:#111;font-size:13px;outline:none;';
    const save = document.createElement('button'); save.textContent = 'SAVE';
    save.style.cssText = 'border:none;background:#e23b2e;color:#fff;font-weight:700;font-size:12px;border-radius:8px;padding:7px 12px;cursor:pointer;';
    save.onclick = () => { try { localStorage.setItem('frogmarks.localModelUrl', input.value.trim()); } catch { /* ignore */ } save.textContent = 'SAVED'; setTimeout(() => { save.textContent = 'SAVE'; }, 900); };
    r.appendChild(input); r.appendChild(save);
    panel.appendChild(label); panel.appendChild(r);
  }

  private fillThemesPanel(panel: HTMLElement): void {
    const label = document.createElement('div'); label.textContent = 'Theme'; label.style.cssText = 'font-weight:700;margin-bottom:8px;';
    panel.appendChild(label);
    // Per-theme SVG icons (no text labels). fill/stroke=currentColor → tinted by each swatch's accent.
    const TH_MOON = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    const TH_FROG = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="9" r="2.6"/><circle cx="16" cy="9" r="2.6"/><path d="M5 12.5a7 5 0 0 0 14 0z"/></svg>';
    const TH_PINWHEEL = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5a7 7 0 1 1-6.9 8.2"/><path d="M12 9a3 3 0 1 0 2.9 3.7"/></svg>';
    const TH_POLYGON = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l10 10-10 10L2 12z"/></svg>';
    const TH_PRISM = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l9 16H3z"/></svg>';
    const TH_LATTICE = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>';
    const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;';
    // Win9x bevel: raised normally, pressed-in (reversed) when active. Colors are the cluster's --bv vars.
    const raised = 'var(--bv-hi,#fffaf0) var(--bv-lo,#847e6c) var(--bv-lo,#847e6c) var(--bv-hi,#fffaf0)';
    const sunken = 'var(--bv-lo,#847e6c) var(--bv-hi,#fffaf0) var(--bv-hi,#fffaf0) var(--bv-lo,#847e6c)';
    const opt = (svg: string, name: ShellThemeName, title: string) => {
      const th = SHELL_THEMES[name];
      const sel = this.activeThemeName === name;
      const b = document.createElement('button');
      b.title = title;
      // Each option is a mini chrome swatch: the theme's own bg + accent, sharp corners, a chrome bevel.
      b.style.cssText = `display:flex;align-items:center;justify-content:center;height:52px;border:2px solid;border-color:${sel ? sunken : raised};border-radius:0;background:${rgbaCss(th.bgBottom)};color:${rgbaCss(th.ink)};cursor:pointer;padding:0;box-shadow:${sel ? 'inset 1px 1px 2px rgba(0,0,0,0.4)' : 'none'};`;
      b.innerHTML = svg;
      b.onclick = () => { this.setTheme(name); this.toggleClusterPanel('themes'); };
      return b;
    };
    grid.appendChild(opt(TH_MOON, 'moon', 'Moon'));            // row 1 — 2D themes
    grid.appendChild(opt(TH_FROG, 'frog', 'Frog'));
    grid.appendChild(opt(TH_PINWHEEL, 'pinwheel', 'Pinwheel'));
    grid.appendChild(opt(TH_POLYGON, 'polygon', 'Polygon'));   // row 2 — 3D themes
    grid.appendChild(opt(TH_PRISM, 'prism', 'Prism'));
    grid.appendChild(opt(TH_LATTICE, 'lattice', 'Lattice'));
    panel.appendChild(grid);
  }

  private typewrite(el: HTMLElement, text: string): void {
    let i = 0; el.textContent = '';
    this.typewriterTimer = setInterval(() => {
      el.textContent = text.slice(0, ++i);
      if (i >= text.length) this.stopTypewriter();
    }, 18);
  }
  private stopTypewriter(): void {
    if (this.typewriterTimer !== null) { clearInterval(this.typewriterTimer); this.typewriterTimer = null; }
  }

  /** Unmount the shell scene, release GPU resources, and resume the main renderer. */
  destroyScene(): void {
    if (!this.renderer) return;
    this.clearDwell();
    this.stopTypewriter();
    this.clusterActivePanel = null;
    this.clusterEl?.remove();
    this.clusterEl = null;
    this.clusterCountEl = null;
    this.clusterPanelEl = null;
    this.renderer.stop();
    this.detachInteraction();
    this.changeUnsub?.();
    this.changeUnsub = undefined;
    this.renderer.destroy();
    this.renderer = null;
    this.sceneCanvas = null;
    // Drop references to the now-removed DOM + stale layout so we don't hold detached nodes between mounts.
    if (this._clusterScrollHandler) {
      window.removeEventListener('scroll', this._clusterScrollHandler, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', this._clusterScrollHandler);
      this._clusterScrollHandler = null;
    }
    if (this._clusterRepositionRaf) { cancelAnimationFrame(this._clusterRepositionRaf); this._clusterRepositionRaf = 0; }
    this.clusterIcons = [];
    this.zoomButtons = [];
    this._clusterThemeApplied = null; this._clusterCountApplied = -1;   // next mount's cluster re-applies theme/count
    // Release the hard-suspend (repaints the editor once); restart its loop
    // if it had been live when we mounted.
    const main = this.ctx.webgpuRenderer;
    main.resumeRendering();
    if (this.resumeMainOnDestroy) main.play();
    this.resumeMainOnDestroy = false;
  }

  /** Phase 6: full launch flow — update check → load .frogcart → swap renderer. */
  async launchSlot(_slotId: string): Promise<void> {
    throw new Error('ShellUIManager.launchSlot is not implemented yet (Phase 6 — Remote cart install / launch).');
  }

  // ── Scene rendering helpers ──────────────────────────────────────────

  /** Map the current view state to the logical tiles for the active mode. */
  private buildSpecs(): ShellTileSpec[] {
    const sel = this.view.selectedSlotId;
    const hov = this.view.hoveredSlotId;
    const flag = (id: string) => ({ selected: sel === id, hovered: hov === id });

    if (this.view.mode === 'illustrations') {
      // The Illustrate view is a full-screen curved thumbnail grid + floating
      // chrome chips, both built in buildProjectGrid — no slot tiles here.
      return [];
    }

    const specs: ShellTileSpec[] = [];
    for (const s of this.getSlots()) {
      const kind: ShellTileSpec['kind'] =
        s.type === 'system' ? 'system' : s.type === 'remote' ? 'remote' : 'local';
      // System apps render as spinning Billboard3D cutouts, not flat-faced coins;
      // carts render as CDs.
      specs.push({ id: s.id, kind, label: s.name, billboardKey: kind === 'system' ? s.id : undefined, cd: kind === 'remote' || kind === 'local', ...flag(s.id) });
    }
    // "Import" (the download-arrow Billboard3D) sits right after Illustrator →
    // order becomes: Illustrator, Import, Settings, [carts], Demo Cart.
    specs.splice(1, 0, { id: SHELL_ADD_CART_ID, kind: 'empty', label: 'Import', billboardKey: SHELL_DOWNLOAD_ID, ...flag(SHELL_ADD_CART_ID) });
    // TEMP demo CD — preview the FrogCart CD tile until upload lands. See shell-cd.md.
    if (SHELL_DEMO_CD) {
      specs.push({ id: '__demo_cart__', kind: 'remote', label: 'Demo Cart', cd: true, ...flag('__demo_cart__') });
    }
    return specs;
  }

  /** Recompute the layout from current state and push it to the renderer. */
  private rebuildAndRender(): void {
    if (!this.renderer || !this.sceneCanvas) return;
    this.syncCanvasBackingStore();
    this.requestThumbnails();
    this.currentModel = computeShellLayout(
      this.sceneCanvas.width,
      this.sceneCanvas.height,
      this.buildSpecs(),
      { page: this.currentPage, zoom: this.zoom },
      this.activeTheme,
    );
    // Layout clamps the page to the valid range — stay in sync.
    this.currentPage = this.currentModel.page;
    // Arrow hover (layout doesn't know the hovered id).
    for (const a of this.currentModel.arrows) a.hovered = a.id === this.view.hoveredSlotId;
    const viewer = this.buildViewerSpec();
    this.currentModel.viewer = viewer;
    // Billboard cutouts sample their icon from the atlas under billboardKey;
    // otherwise the cartridge/sketchbook samples a thumbnail by id:
    //   • shell mode    → the selected cart's thumbnail (on the cartridge)
    //   • illustrations → the hovered (else selected) project's thumbnail,
    //                     shown polaroid-style on the sketchbook mesh. The
    //                     dwell keeps hoveredSlotId set through the countdown,
    //                     so it tracks the focused tile and holds for the dwell.
    // Synthetic ids (Back / New Project) have no atlas entry → the renderer just
    // draws the plain mesh, so no special-casing is needed.
    this.currentModel.viewerThumbId = viewer.billboardKey
      ?? (this.view.mode === 'illustrations'
            ? (this.view.hoveredSlotId ?? this.view.selectedSlotId ?? undefined)
            : (this.view.selectedSlotId ?? undefined));
    // Dwell countdown ring follows the focused tile (full while paused).
    this.currentModel.ringTileId = this.dwellId ?? undefined;
    this.currentModel.ringCountdownStart = this.dwellCountdownStart;
    // Mode chrome: home gets the greeting; illustrations gets the curved
    // thumbnail grid + floating Back / New Project chips. (modeFade = 1 snaps to
    // the grid for now; Phase 2 animates the cross-fade.)
    this.currentModel.modeFade = this.transitionActive
      ? this.transitionT
      : (this.view.mode === 'illustrations' ? 1 : 0);
    this.zoomButtons = [];   // re-populated by buildChrome (home only)
    if (this.view.mode === 'illustrations') {
      this.buildProjectGrid(this.currentModel);
    } else {
      this.buildChrome(this.currentModel);
    }
    this.renderer.setModel(this.currentModel);
    this.updateChromeCluster();
  }

  /** Illustrations mode: build the curved thumbnail grid (one card per project)
   *  plus the floating Back / New Project chips, and clamp the scroll. */
  private buildProjectGrid(model: ShellRenderModel): void {
    const c = this.sceneCanvas;
    if (!c) return;
    const W = c.width, H = c.height;
    const projects = this.getProjects();
    const ids = projects.map(p => p.id);
    // Clamp scroll to the content height (probe with zero offset first).
    const probe = computeProjectGrid(W, H, ids, 0);
    const maxScroll = Math.max(0, probe.contentHeight - H);
    this.gridScrollY = Math.max(0, Math.min(this.gridScrollY, maxScroll));
    const grid = computeProjectGrid(W, H, ids, this.gridScrollY);
    model.projectGrid = grid.items.map(it => ({
      ...it, hover: this.view.hoveredSlotId === it.id ? 1 : 0,
    }));
    model.gridContentHeight = grid.contentHeight;

    // Per-card window title: the project name in the green title bar. Only the
    // on-screen cards (label positions/sizes must match the GRID_SHADER chrome:
    // titleH = h*0.10, bevel t = h*0.045). Light text on the green bar.
    for (let i = 0; i < grid.items.length; i++) {
      const it = grid.items[i];
      const name = projects[i]?.name;
      const [gx, gy, gw, gh] = it.rect;
      if (!name || gy + gh < 0 || gy > H) continue;   // skip off-screen
      // Geometry must match the GRID_SHADER title bar (b, titleH, close button).
      const b = Math.min(2.5, Math.max(1.5, Math.min(gw, gh) * 0.012));
      const titleH = Math.max(9, gh * 0.10);
      const fontPx = Math.max(9, Math.round(titleH * 0.68));
      const leftPad = 2 * b + gw * 0.025;
      const xReserve = titleH * 0.70 + 4 * b;         // close button slot
      const availW = Math.max(8, gw - leftPad - xReserve);
      model.labels.push({
        id: it.id,
        text: name,
        centerX: gx + leftPad + availW / 2,
        topY: gy + 2 * b + Math.max(0, (titleH - 1.4 * fontPx) / 2),
        maxWidthPx: availW,
        fontPx,
        color: [0.96, 0.98, 0.94, 1],
        fontFamily: TITLEBAR_FONT,
      });
    }

    // Floating chrome chips: plain tiles + labels, hit-tested as tiles
    // (handleClick routes Back / New Project).
    const theme = this.activeTheme;
    const fontPx = Math.max(12, Math.round(H * 0.020));
    const chipH = fontPx * 2.1;
    const y = H * 0.05;
    const x0 = W * 0.03;   // align the button's left edge with the grid's sideMargin
    const chip = (id: string, text: string, x: number, wpx: number) => {
      model.tiles.push({
        id, kind: 'empty', rect: [x, y, wpx, chipH],
        fill: theme.systemFill, cornerRadius: 0,   // sharp Win9x button
        selected: false, hovered: this.view.hoveredSlotId === id,
      });
      model.labels.push({
        id, text, centerX: x + wpx / 2, topY: y + chipH * 0.30,
        maxWidthPx: wpx * 1.4, fontPx, color: [0.13, 0.13, 0.15, 1],   // dark text on the grey button
      });
    };
    const pkg = this.dashboardKind === 'packaging';
    const backW = W * 0.085, npW = W * (pkg ? 0.205 : 0.140);
    chip(SHELL_BACK_ID, '‹ Back', x0, backW);
    chip(SHELL_NEW_PROJECT_ID, pkg ? '+ New Product Packaging' : '+ New Project', x0 + backW + W * 0.014, npW);
  }

  /** Change page (clamped) and redraw. */
  private changePage(delta: number): void {
    const next = Math.max(0, Math.min(this.currentPage + delta, this.currentModel.pageCount - 1));
    if (next === this.currentPage) return;
    this.currentPage = next;
    this.view.selectedSlotId = null;
    this.onChange.emit('mode');
  }

  /** Adjust zoom (tile size). Resets to the first page. */
  private adjustZoom(factor: number): void {
    const z = Math.max(0.55, Math.min(1.35, this.zoom * factor));
    if (Math.abs(z - this.zoom) < 0.001) return;
    this.zoom = z;
    this.currentPage = 0;
    this.onChange.emit('mode');
  }

  /** Feed cached thumbnail data URLs for the current mode's tiles to the
   *  renderer's atlas. De-duplicated downstream, so calling on every state
   *  change is cheap; uploads appear on the next animation frame. */
  private requestThumbnails(): void {
    if (!this.renderer) return;
    if (this.view.mode === 'illustrations') {
      for (const p of this.getProjects()) {
        if (p.thumbnailDataUrl) this.renderer.requestThumbnail(p.id, p.thumbnailDataUrl);
      }
    } else {
      for (const s of this.registry.slots) {
        if (s.thumbnailDataUrl) this.renderer.requestThumbnail(s.id, s.thumbnailDataUrl);
      }
    }
  }

  /** Decide what the top viewer shows: the Illustrations sketchbook, the
   *  selected cart's cartridge, or the default branded cartridge. */
  private buildViewerSpec(): ViewerSpec {
    const themeOutline = this.activeTheme.billboardOutline;
    const billboard = (
      key: string,
      side: [number, number, number, number] = themeOutline, // themed cutout outline
      scale = 1,
    ): ViewerSpec => {
      const isHero = key === SHELL_HERO_ID;
      // Contrast route: on the dark Moon theme the hero logo gets a white keyline.
      const outline: [number, number, number, number] =
        (isHero && this.activeThemeName === 'moon') ? [0.97, 0.98, 1.0, 1] : side;
      return {
        kind: 'cartridge',
        bodyColor: [0.14, 0.14, 0.17, 1],
        labelColor: [0.9, 0.9, 0.95, 1],
        billboardKey: key,
        sideColor: outline,
        scale,
        mirrorBack: false,
        floaty: isHero,   // the logo floats facing you; icons spin
        swayOnly: this.activeTheme.backdropGrid,   // 3D themes: ±30° sway, not a full spin
      };
    };

    // Hovering a system app shows its Billboard3D icon cutout in the viewer.
    const hov = this.view.hoveredSlotId ? this.getSlot(this.view.hoveredSlotId) : null;
    // Package Designer is special: a kraft-brown cardboard BOX cube, not a flat billboard icon.
    if (hov?.systemKey === 'packageDesigner') {
      return { kind: 'box', bodyColor: [0.60, 0.45, 0.29, 1], labelColor: [0.40, 0.29, 0.17, 1], swayOnly: this.activeTheme.backdropGrid };
    }
    if (hov?.type === 'system') return billboard(hov.id);
    // Hovering the synthetic "Install Cart" tile shows the download arrow.
    if (this.view.hoveredSlotId === SHELL_ADD_CART_ID) return billboard(SHELL_DOWNLOAD_ID);
    // Hovering a FrogCart (a CD tile) shows the CD in the top viewer, not the hero.
    const hovTile = this.view.hoveredSlotId ? this.currentModel.tiles.find(t => t.id === this.view.hoveredSlotId) : undefined;
    if (hovTile?.cd) return { kind: 'cd', bodyColor: [0.72, 0.74, 0.80, 1], labelColor: [0.9, 0.9, 0.95, 1] };

    if (this.view.mode === 'illustrations') {
      // A selected/hovered project shows the sketchbook; otherwise the hero.
      if (this.view.selectedSlotId || this.view.hoveredSlotId) {
        return {
          kind: 'sketchbook',
          bodyColor: [0.86, 0.82, 0.72, 1],
          labelColor: [0.97, 0.96, 0.93, 1],
        };
      }
      return billboard(SHELL_HERO_ID, [0.97, 0.96, 0.92, 1], 1.18); // warm sticker border, slightly larger
    }
    const sel = this.view.selectedSlotId ? this.getSlot(this.view.selectedSlotId) : null;
    if (!sel) {
      // Nothing selected → the hero logo (or frog placeholder until injected).
      return billboard(SHELL_HERO_ID, [0.97, 0.96, 0.92, 1], 1.18); // warm sticker border, slightly larger
    }
    const labelColor: [number, number, number, number] =
      sel.type === 'remote' ? [0.45, 0.62, 0.85, 1]
        : sel.type === 'local' ? [0.70, 0.52, 0.82, 1]
          : [0.40, 0.74, 0.62, 1];
    return {
      kind: 'cartridge',
      bodyColor: [0.14, 0.14, 0.17, 1],
      labelColor,
    };
  }

  private greeting(): string {
    const hr = new Date().getHours();
    return hr < 5 ? 'Late night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  }

  /** Greeting split into two uppercase words for the stacked chrome lettering. */
  private greetingWords(): [string, string] {
    const parts = this.greeting().toUpperCase().split(' ');
    return parts.length >= 2 ? [parts[0], parts.slice(1).join(' ')] : [parts[0], ''];
  }

  /** Lazily-created 2D context used only to measure chrome text widths. */
  private _measCtx: CanvasRenderingContext2D | null = null;
  private measureCtx(): CanvasRenderingContext2D {
    if (!this._measCtx) this._measCtx = document.createElement('canvas').getContext('2d')!;
    return this._measCtx;
  }

  /** Add the chrome pills (title bar + info badges) to the model. */
  private buildChrome(model: ShellRenderModel): void {
    const c = this.sceneCanvas;
    if (!c) return;
    const w = c.width, h = c.height;
    const ink = this.activeTheme.ink;
    // The "Frogmarks" title pill and the count chip moved out — the logo
    // billboard is the brand mark, and the count lives in the HTML cluster.

    // Greeting (top-left): two hand-lettered words, black ink, no pill. Both
    // words are stretched to the SAME width (top squashed, bottom tall) and
    // stacked tight.
    const [gw1, gw2] = this.greetingWords();
    const ct = this.activeTheme.chromeText ?? ink;   // greeting text color (white on Polygon, else themed ink)
    const black: [number, number, number, number] = [ct[0], ct[1], ct[2], 1];
    const gx = w * 0.026;
    const gFont = Math.max(12, Math.round(h * 0.030));
    const topSY = 0.60, botSY = 1.50;
    // Measure natural widths in the shell font, then match the top word's
    // width to the bottom word's (re-measures correctly once Bungee loads).
    const meas = this.measureCtx();
    meas.font = `400 ${gFont}px ${FONT_FAMILY}`;
    const w1n = Math.max(1, meas.measureText(gw1).width);
    const w2n = Math.max(1, meas.measureText(gw2).width);
    const botSX = 1.0;
    const topSX = (w2n * botSX) / w1n;          // top stretched to bottom's width
    const pad = gFont * 0.3;                     // atlas padX (both share fontPx)
    const cx = gx + (w2n * botSX + 2 * pad) / 2; // equal width → same centerX left-aligns both
    // Tight vertical stacking by cap height (atlas cell = 1.4·fontPx·scaleY).
    const LH = 1.4, CAP = 0.72;
    const gy = h * 0.012;
    const topGlyphBottom = gy + gFont * topSY * (LH + CAP) / 2;
    const botY = topGlyphBottom + gFont * 0.20 - gFont * botSY * (LH - CAP) / 2;
    model.labels.push({
      id: '__greet1__', text: gw1, centerX: cx, topY: gy,
      maxWidthPx: 9999, fontPx: gFont, color: black, scaleX: topSX, scaleY: topSY,
    });
    model.labels.push({
      id: '__greet2__', text: gw2, centerX: cx, topY: botY,
      maxWidthPx: 9999, fontPx: gFont, color: black, scaleX: botSX, scaleY: botSY,
    });

    // Bottom panel as a Win9x window: a frame overlay + a green titlebar label
    // (geometry must match WINDOW_SHADER: b = clamp(min·0.006, 2, 3.5)).
    const g = model.grid;
    if (g.cardW > 1 && g.cardH > 1) {
      model.windows = [...(model.windows ?? []), { rect: [g.cardX, g.cardY, g.cardW, g.cardH], titleH: g.panelTitleH, controls: 'zoom' }];
      const titleH = g.panelTitleH;
      const bb = Math.min(3.5, Math.max(2.0, Math.min(g.cardW, g.cardH) * 0.006));
      const tFont = Math.max(11, Math.round(titleH * 0.56));
      const leftPad = 2 * bb + g.cardW * 0.012;
      const title = 'FROGCARTS';
      meas.font = `400 ${tFont}px ${TITLEBAR_FONT}`;
      const tw = Math.max(1, meas.measureText(title).width);  // left-align the title
      model.labels.push({
        id: '__panel_title__', text: title,
        centerX: g.cardX + leftPad + tw / 2,
        topY: g.cardY + 2 * bb + Math.max(0, (titleH - 1.4 * tFont) / 2),
        maxWidthPx: g.cardW * 0.6, fontPx: tFont,
        color: [0.96, 0.98, 0.94, 1], fontFamily: TITLEBAR_FONT,
      });
      // Zoom −/+ button hit-rects (must match the WINDOW_SHADER button geometry).
      const bs = titleH * 0.62;
      const by0 = g.cardY + 2 * bb + (titleH - bs) / 2;
      const pbx0 = g.cardX + g.cardW - 3.2 * bb - bs;   // + (zoom in)
      const mbx0 = pbx0 - 1.2 * bb - bs;                 // − (zoom out)
      this.zoomButtons = [
        { rect: [mbx0, by0, bs, bs], dir: -1 },
        { rect: [pbx0, by0, bs, bs], dir: 1 },
      ];
    }
  }

  /** Ensure the canvas backing store matches its CSS size × DPR. The main
   *  renderer normally owns this, but it is paused while the shell is up. */
  private syncCanvasBackingStore(): void {
    const c = this.sceneCanvas;
    if (!c) return;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.clientWidth > 0 && (c.width !== w || c.height !== h)) {
      c.width = w;
      c.height = h;
    }
  }

  // ── Interaction ──────────────────────────────────────────────────────

  /** Top-most hit id under a device-px point, mode-aware: the illustrations
   *  grid hit-tests the chips (tiles) then the curved cards; home hit-tests
   *  the slot tiles + page arrows. */
  private hitTest(px: number, py: number): string | null {
    if (this.view.mode === 'illustrations') {
      return hitTestTiles(this.currentModel, px, py)
        ?? hitTestProjectGrid(this.currentModel, px, py, this.sceneCanvas?.width ?? 0);
    }
    return hitTestTiles(this.currentModel, px, py);
  }

  private attachInteraction(canvas: HTMLCanvasElement): void {
    this.boundPointerMove = (e) => {
      const [px, py] = this.toDevicePx(canvas, e.clientX, e.clientY);
      this.handleHover(this.hitTest(px, py));
      // Feed normalized pointer (-1..1 from center) to the renderer for parallax.
      const w = canvas.width || 1, h = canvas.height || 1;
      this.renderer?.setPointer((px / w) * 2 - 1, (py / h) * 2 - 1);
    };
    this.boundClick = (e) => {
      const [px, py] = this.toDevicePx(canvas, e.clientX, e.clientY);
      // Panel titlebar zoom −/+ buttons (same factor as Ctrl+wheel).
      for (const zb of this.zoomButtons) {
        const [bx, by, bw, bh] = zb.rect;
        if (px >= bx && px <= bx + bw && py >= by && py <= by + bh) {
          this.adjustZoom(zb.dir > 0 ? 1.1 : 1 / 1.1);
          return;
        }
      }
      // Project-card ✕ (delete intent) takes priority over opening the card. The host shows the modal + deletes.
      if (this.view.mode === 'illustrations') {
        const delId = hitTestProjectGridClose(this.currentModel, px, py, this.sceneCanvas?.width ?? 0);
        if (delId) { this.onProjectDelete.emit({ id: delId, dashboardKind: this.dashboardKind }); return; }
      }
      const id = this.hitTest(px, py);
      if (id) this.handleClick(id);
    };
    this.boundDblClick = (e) => {
      const [px, py] = this.toDevicePx(canvas, e.clientX, e.clientY);
      // Don't open the illustration when the double-click lands on its ✕ (the first click already fired delete).
      if (this.view.mode === 'illustrations' && hitTestProjectGridClose(this.currentModel, px, py, this.sceneCanvas?.width ?? 0)) return;
      const id = this.hitTest(px, py);
      if (id) this.handleActivate(id);
    };
    this.boundKeyDown = (e) => {
      if (e.key === 'Escape' && this.view.mode === 'illustrations') {
        this.closeIllustratorDashboard();
      }
    };
    // Wheel: Ctrl/⌘+wheel zooms tile size; plain wheel pages horizontally.
    this.boundWheel = (e) => {
      e.preventDefault();
      // Illustrations grid: plain wheel scrolls the grid vertically.
      if (this.view.mode === 'illustrations') {
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        this.gridScrollY += (e.deltaY || 0) * dpr;
        this.rebuildAndRender();   // clamps gridScrollY inside buildProjectGrid
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        this.adjustZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      } else {
        const d = (e.deltaY || e.deltaX);
        if (Math.abs(d) > 0) this.changePage(d > 0 ? 1 : -1);
      }
    };
    addZonelessListener(canvas, 'pointermove', this.boundPointerMove);
    canvas.addEventListener('click', this.boundClick);
    canvas.addEventListener('dblclick', this.boundDblClick);
    addZonelessListener(canvas, 'wheel', this.boundWheel, { passive: false });
    window.addEventListener('keydown', this.boundKeyDown);

    this.resizeObserver = new ResizeObserver(() => this.rebuildAndRender());
    this.resizeObserver.observe(canvas);
  }

  private detachInteraction(): void {
    const c = this.sceneCanvas;
    if (c) {
      if (this.boundPointerMove) removeZonelessListener(c, 'pointermove', this.boundPointerMove);
      if (this.boundClick) c.removeEventListener('click', this.boundClick);
      if (this.boundDblClick) c.removeEventListener('dblclick', this.boundDblClick);
      if (this.boundWheel) removeZonelessListener(c, 'wheel', this.boundWheel);
    }
    if (this.boundKeyDown) window.removeEventListener('keydown', this.boundKeyDown);
    if (this.transitionRaf != null) { cancelAnimationFrame(this.transitionRaf); this.transitionRaf = null; }
    this.transitionActive = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.boundPointerMove = this.boundClick = this.boundDblClick = undefined;
    this.boundKeyDown = undefined;
    this.boundWheel = undefined;
  }

  /** Convert a client (CSS px) pointer position to canvas device pixels. */
  private toDevicePx(canvas: HTMLCanvasElement, clientX: number, clientY: number): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? canvas.width / rect.width : 1;
    const sy = rect.height > 0 ? canvas.height / rect.height : 1;
    return [(clientX - rect.left) * sx, (clientY - rect.top) * sy];
  }

  /** Single-click: select, or perform the slot's primary navigation. */
  private handleClick(id: string): void {
    if (id === SHELL_PREV_ID) { this.changePage(-1); return; }
    if (id === SHELL_NEXT_ID) { this.changePage(1); return; }
    if (id === SHELL_BACK_ID) {
      this.closeIllustratorDashboard();
      return;
    }
    if (id === SHELL_NEW_PROJECT_ID) {
      // Signal intent only — the host opens its New modal and creates the document on confirm.
      // dashboardKind tells the host whether to make an illustration or a packaging document.
      this.onActivate.emit({ id, kind: 'empty', dashboardKind: this.dashboardKind });
      return;
    }
    if (id === SHELL_ADD_CART_ID) {
      this.importCartFromFile();   // open the .frogcart picker → install locally
      return;
    }
    // Illustrations grid: a card → open that project (chips handled above).
    if (this.view.mode === 'illustrations') { this.handleActivate(id); return; }
    const slot = this.getSlot(id);
    if (slot?.type === 'system') {
      if (slot.systemKey === 'illustrator') this.openIllustratorDashboard();
      else if (slot.systemKey === 'packageDesigner') this.openPackageDashboard();
      else this.onActivate.emit({ id, kind: 'system' });
      return;
    }
    this.setSelectedSlot(id);
  }

  /** Double-click: activation intent (Open project / Launch cart). */
  private handleActivate(id: string): void {
    if (id === SHELL_NEW_PROJECT_ID || id === SHELL_ADD_CART_ID) return;
    const inDash = this.view.mode === 'illustrations';
    const kind: ShellTileSpec['kind'] =
      inDash ? 'project'
        : (this.getSlot(id)?.type === 'remote' ? 'remote' : 'local');
    this.onActivate.emit({ id, kind, dashboardKind: inDash ? this.dashboardKind : undefined });
  }

  // ── internal ─────────────────────────────────────────────────────────

  private async persistRegistry(reason: ShellChangeReason): Promise<void> {
    if (ShellStorage.isAvailable()) await this.storage.saveRegistry(this.registry);
    this.onChange.emit(reason);
  }
}
