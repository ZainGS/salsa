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
import { unwrapDevice } from '../../renderer/core/gpu-device-handle';
import { EventEmitter } from '../../renderer/util/event-emitter';
import {
  ShellStorage,
  ShellRegistry,
  ShellSlot,
  ProjectEntry,
  SYSTEM_APPS,
} from '../persistence/shell-storage';
import { ShellRenderer, ensureShellFont, FONT_FAMILY, TITLEBAR_FONT } from '../../renderer/shell/shell-renderer';
import { iconKindForSystemKey, type IconKind } from '../../renderer/shell/shell-icons';
import { SHELL_ICON_PENCIL, SHELL_ICON_GEAR, SHELL_ICON_INSTALL } from '../../renderer/shell/shell-icon-assets';
import type { Billboard3DConfig } from '../../renderer/3d/billboard-3d';
import {
  rgbaCss, bakeImageIcon, peekImageIcon, bakePlaceholderIcon, peekPlaceholderIcon, type IconBake,
} from '../../renderer/shell/shell-icon-bake';
import { MODE_FADE_MS } from '../../renderer/shell/shell-bake';
import { shellMark } from '../../renderer/shell/shell-perf';
import { sameProjectList, projectsOfKind } from './shell-project-diff';
import {
  openShellImportPicker, readCartListing, shellCartFilesToInstall, SHELL_CART_ACCEPT, SHELL_IMPORT_ACCEPT,
  type ShellImportHandler,
} from './shell-import';
import {
  computeShellLayout,
  computeProjectGrid,
  layoutShellChips,
  projectCardTitleFontPx,
  projectCardTitleH,
  projectGridSideMargin,
  hitTestTiles,
  hitTestProjectGrid,
  hitTestProjectGridClose,
  SHELL_PREV_ID,
  SHELL_NEXT_ID,
  SHELL_THEMES,
  SHELL_COMPACT_BELOW_CSS,
  shellResponsiveOpts,
  type ShellThemeName,
  type ShellTheme,
  type ShellTileSpec,
  type ShellRenderModel,
  type ViewerSpec,
  type ShellChipLayout,
} from '../../renderer/shell/shell-layout';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import { syncShellCanvasBacking, shellBackingRatio } from '../../renderer/shell/shell-backing';
import { DESKTOP_CAPS } from '../../renderer/core/gpu-capabilities';
import { isHostModalOpen, shellShouldIgnoreEscape } from './shell-escape-guard';
import { shellCartCountLabel, shellEmptyGridLines } from '../../renderer/shell/shell-chrome-logic';

/** Minimum hit box (CSS px) of a project card's ✕ on a coarse (finger) pointer — the drawn button is ~14 px. */
const SHELL_CLOSE_MIN_HIT_COARSE_CSS = 44;

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

/** The Settings system app's slot id (the cluster's Settings button activates it, like the tile). */
export const SHELL_SETTINGS_ID = 'system:settings';

/** TEMP: show a demo FrogCart CD tile so the CD visual can be tuned before the
 *  cart-upload path exists. Flip off (or delete this + its use in buildSpecs)
 *  once real carts populate the registry. See docs/specs/shell-cd.md. */
const SHELL_DEMO_CD = true;

/** Dwell duration (ms) before a hovered tile auto-unfocuses. Matches the
 *  renderer's countdown ring (RING_SECONDS). */
const DWELL_MS = 3000;

/** The Shell must have been mounted this long before a heavy bake / prewarm may start (its first frames stay smooth). */
const CALM_AFTER_MOUNT_MS = 500;

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
  /** In-memory project list (EVERY kind), refreshed asynchronously from the document
   *  source so the render path can read it synchronously. */
  private allProjects: ProjectEntry[] = [];
  /** The active dashboard's projects (allProjects filtered by `dashboardKind`), memoised. Keeping the unfiltered
   *  list means opening either dashboard shows its projects straight from the cache — no refetch at the flip. */
  private _projectCache: ProjectEntry[] | null = null;
  private get projectCache(): ProjectEntry[] {
    return this._projectCache ??= projectsOfKind(this.allProjects, this.dashboardKind);
  }
  private setAllProjects(list: ProjectEntry[]): void {
    this.allProjects = list;
    this._projectCache = null;
    this.invalidateProjects();
  }
  /** Drop the memoised sorted list (it holds CLONES of the entries) and note that the list changed. */
  private invalidateProjects(): void {
    this._sortedProjects = null;
    this._projectsEpoch++;
  }
  private _projectsEpoch = 0;

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
  /** The canvas context + format the scene configured (restored to the editor's alpha mode on unmount). */
  private sceneContext: GPUCanvasContext | null = null;
  private sceneFormat: GPUTextureFormat | null = null;
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
  private clusterIcons: { el: HTMLButtonElement; emoji: string; mat: string; key: string }[] = [];
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
  private resumeMainOnDestroy = false;
  private changeUnsub?: () => void;
  private resizeObserver?: ResizeObserver;
  private boundPointerMove?: (e: PointerEvent) => void;
  private boundClick?: (e: MouseEvent) => void;
  private boundDblClick?: (e: MouseEvent) => void;
  private boundKeyDown?: (e: KeyboardEvent) => void;
  private boundWheel?: (e: WheelEvent) => void;
  private boundPointerDown?: (e: PointerEvent) => void;
  private boundPointerUp?: (e: PointerEvent) => void;
  /** Illustrations grid drag-to-scroll (touch / pen / mouse): the active pointer, its start Y + the scroll at
   *  start (device px), and whether it passed the drag threshold (a drag swallows the following click). */
  private gridDrag: { pointerId: number; startY: number; startScroll: number; dragging: boolean } | null = null;
  private suppressNextClick = false;
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
      // Nothing changed → no emit (an emit rebuilds the model, re-requests thumbnails and re-enters the host).
      if (sameProjectList(this.allProjects, all)) return;
      // Every kind is kept; the grid shows only the active dashboard's (untagged = 'illustration').
      this.setAllProjects(all);
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

  /** The host's router for the Import tile's files (setImportHandler); null = carts only. */
  private importHandler: ShellImportHandler | null = null;

  /**
   * Route the Import tile's files through the host: the picker then takes several files of any Frogmarks kind
   * (.frogcart, .frogmarks, .frog, a renamed / zipped copy) and `handler` gets them all; it opens what it can itself
   * (a project) and returns the ones that are carts, which the Shell installs. null = a .frogcart-only picker again.
   */
  setImportHandler(handler: ShellImportHandler | null): void { this.importHandler = handler; }

  /** Open the Import picker and import the chosen files (the Import tile's action) — for a host's own
   *  button / keyboard path. Must run inside a user gesture (a click / key handler). */
  importCart(): void { this.importCartFromFile(); }

  /** "Import" tile: open the OS file picker (restricted to .frogcart unless the host routes imports), then
   *  install the chosen carts locally. Must run inside the click gesture. */
  private importCartFromFile(): void {
    if (typeof document === 'undefined') return;
    const handler = this.importHandler;
    const accept = handler ? SHELL_IMPORT_ACCEPT : SHELL_CART_ACCEPT;
    openShellImportPicker(document, { accept, multiple: !!handler }, (files) => {
      void (async () => {
        for (const file of await shellCartFilesToInstall(files, handler)) await this.installLocalCart(file);
      })();
    });
  }

  /** Store an imported .frogcart in OPFS and register its cart slot. The cart
   *  name comes from the zip's manifest.json (`title`, else `name`), else the filename. */
  private async installLocalCart(file: File): Promise<void> {
    if (!ShellStorage.isAvailable()) {
      console.warn('[Shell] Cannot import cart — OPFS storage is unavailable.');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const { name, description } = readCartListing(new Uint8Array(buffer), file.name);
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
    this.setAllProjects([entry, ...this.allProjects.filter(p => p.id !== entry.id)]);
    if ((entry.kind ?? 'illustration') === this.dashboardKind) {
      this.onChange.emit('projects');
    }
    return { ...entry };
  }

  /** Rename a project (rewrites the document manifest name). */
  async renameProject(projectId: string, name: string): Promise<void> {
    await this.docSource?.renameProject(projectId, name);
    const p = this.projectCache.find(p => p.id === projectId);
    if (p) { p.name = name; p.lastModified = Date.now(); }
    this.invalidateProjects();
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
      this.invalidateProjects();
      this.onChange.emit('projects');
    }
    void this.refreshProjects();
  }

  /** Delete a project (deletes the underlying document + any exported copy). */
  async deleteProject(projectId: string): Promise<void> {
    await this.docSource?.deleteProject(projectId);
    this.setAllProjects(this.allProjects.filter(p => p.id !== projectId));
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
    // Entering the project browser — pull a fresh list from the store. Not at the flip of a cross-fade: the grid
    // shows the cache at once and the refresh runs when the fade has finished (onModeFadeEnd), so the store read +
    // a second rebuild don't land in the middle of the animation.
    if (mode === 'illustrations' && !this.transitionActive) void this.refreshProjects();
    this.onChange.emit('mode');
  }

  /** Which project dashboard is active: Illustrator ('illustration') or Package Designer ('packaging').
   *  Both reuse the 'illustrations' shell MODE; this axis filters the project list + labels the New tile. */
  private dashboardKind: 'illustration' | 'packaging' = 'illustration';
  getDashboardKind(): 'illustration' | 'packaging' { return this.dashboardKind; }

  private setDashboardKind(kind: 'illustration' | 'packaging'): void {
    if (this.dashboardKind === kind) return;
    this.dashboardKind = kind;
    this._projectCache = null;     // derived from the kind
    this._sortedProjects = null;
  }

  /** The projects of a dashboard, newest first (the memoised list for the active one). */
  private projectsFor(kind: 'illustration' | 'packaging'): ProjectEntry[] {
    if (kind === this.dashboardKind) return this.getProjects();
    return projectsOfKind(this.allProjects, kind).sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
  }

  openIllustratorDashboard(): void { shellMark('shell:tap'); this.setDashboardKind('illustration'); this.startModeTransition('illustrations'); }
  /** Package Designer sub-dashboard — same project grid, filtered to packaging-kind documents. */
  openPackageDashboard(): void { shellMark('shell:tap'); this.setDashboardKind('packaging'); this.startModeTransition('illustrations'); }
  closeIllustratorDashboard(): void { this.startModeTransition('shell'); }

  /** Animate a dip-to-background cross-fade between the shell home and the
   *  illustrations grid, flipping the underlying mode at the midpoint (hidden by
   *  the scrim, so each view is only ever shown alone). The fade runs on the renderer's clock
   *  (ShellRenderer.beginModeFade): the scrim alpha is computed inside its render(), so the only model rebuild of
   *  the whole transition is the one at the flip (was: a full rebuild + layout + text measuring every frame). */
  private startModeTransition(to: ShellMode): void {
    if (!this.transitionActive && this.view.mode === to) return;   // already there
    this.transitionTo = to;
    this.transitionStart = performance.now();
    this.transitionActive = true;
    if (this.renderer) {
      this.renderer.beginModeFade(this.transitionStart, MODE_FADE_MS, this.onModeFadeMidpoint, this.onModeFadeEnd);
    } else {
      // No scene mounted: nothing to fade, just switch.
      this.onModeFadeMidpoint();
      this.onModeFadeEnd();
    }
  }

  /** The dip is at its darkest: flip the mode (emits → the one rebuildAndRender of the transition). */
  private onModeFadeMidpoint = (): void => {
    if (this.view.mode === this.transitionTo) return;
    shellMark('shell:mode-flip');
    if (this.transitionTo === 'illustrations') this.renderer?.armGridMarks();
    this.setMode(this.transitionTo);
  };

  private onModeFadeEnd = (): void => {
    this.transitionActive = false;
    // The refresh setMode skipped at the flip: now that nothing is animating (emits only if the list changed).
    if (this.view.mode === 'illustrations') void this.refreshProjects();
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
      device: unwrapDevice(device), format,   // the editor's device is a HANDLE (proxy); configure brand-checks it
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      // The Shell fills its canvas with alpha 1 (an opaque background clear, then only blends that keep alpha 1),
      // so 'opaque' shows the same pixels as 'premultiplied' did while letting the compositor skip the per-pixel
      // blend of a full-screen layer. Hand-back: a host with a dedicated Shell canvas (Frogmarks) reinitializes the
      // editor on ITS canvas (premultiplied); for a host that shares one canvas, destroyScene puts the editor's
      // configuration back before the editor draws again.
      alphaMode: 'opaque',
    });
    this.sceneContext = context;
    this.sceneFormat = format;

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
      this.schedulePrewarm(); // the Illustrations view's labels + first screenful of thumbnails, at idle

      // Load the Bungee web font, then re-rasterize the labels with it.
      void ensureShellFont().then(() => {
        this._textEpoch++;                 // measured widths / fitted font sizes are stale
        this.renderer?.invalidateText();
        this.rebuildAndRender();
        this.schedulePrewarm();
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

  /** Build the icon cutouts for the system apps + the hero: a Billboard3D mesh + an atlas thumbnail each.
   *  Re-run each mount (the renderer/viewer is recreated on mount), but the BAKES are memoised for the page
   *  (shell-icon-bake.ts): a mount after the first applies them synchronously, with no image decode, rim bake or
   *  tracing. A bake that is still needed is queued (see enqueueCalm): never in the Shell's first moments and never
   *  during a mode cross-fade, one icon at a time, yielding between its steps. */
  private generateSystemIcons(): void {
    if (!this.renderer) return;
    const placeholder = (key: string, kind: IconKind) =>
      this.iconJob(key, peekPlaceholderIcon(kind), () => bakePlaceholderIcon(kind));
    // Hero first (it is the biggest thing on the home): the host's injected logo (re-baked with the theme outline)
    // if present, else the frog placeholder. Don't reset to the frog when a logo exists — it
    // would flash during the async re-bake (e.g. on every theme switch).
    if (this.logoSrc) this.applyLogoBillboard();
    else placeholder(SHELL_HERO_ID, 'frog');
    for (const app of SYSTEM_APPS) {
      // Pencil + gear use real PNG art (embedded data URLs), baked as cutouts
      // (rimPx > 0) so the gear's holes read as true see-through gaps with a rim.
      if (app.systemKey === 'illustrator') { this.setBillboardFromImage(app.id, SHELL_ICON_PENCIL, { alphaThreshold: 110 }, 8); continue; }
      if (app.systemKey === 'settings')    { this.setBillboardFromImage(app.id, SHELL_ICON_GEAR,   { alphaThreshold: 110 }, 8); continue; }
      placeholder(app.id, iconKindForSystemKey(app.systemKey));
    }
    // Install Cart: real PNG art (arrow + tray), baked as a cutout. The bake's
    // dilation bridges the arrow→tray gap so both parts trace as one silhouette.
    this.setBillboardFromImage(SHELL_DOWNLOAD_ID, SHELL_ICON_INSTALL, { alphaThreshold: 110 }, 8);
    placeholder(SHELL_STAR_ID, 'star');          // kept for a future Favorites feature
  }

  /** Inject the host's logo image (URL or data URL) to use as the default hero
   *  Billboard3D. Safe to call before or after the scene initializes — the
   *  logo is (re)applied whenever the renderer is available. The image should
   *  have a transparent background so the cutout silhouette traces cleanly. */
  setLogoBillboard(src: string): void {
    this.logoSrc = src;
    if (this.renderer) this.applyLogoBillboard();
  }

  /** Rasterize the injected logo → Billboard3D geometry, registered as the hero. While this renderer has NO hero
   *  mesh yet (first load, or a mount whose bake is still pending) the hero slot stays EMPTY until the logo has
   *  decoded + baked — no white-card / cartridge flash. Re-bakes (theme switch) don't re-hide: the logo already
   *  exists. (Bouncing-dots placeholder is kept for reuse.) */
  private applyLogoBillboard(): void {
    const r = this.renderer;
    if (!this.logoSrc || !r) return;
    const cfg = { borderPx: 12 };
    const outline = this.activeTheme.billboardOutline;
    const hadHero = r.hasSystemIcon(SHELL_HERO_ID);
    const cached = peekImageIcon(this.logoSrc, outline, 0, cfg);
    if (!hadHero && !cached) r.hideHero();
    const src = this.logoSrc;
    this.iconJob(SHELL_HERO_ID, cached, () => bakeImageIcon(src, outline, 0, cfg), () => {
      if (!hadHero && !cached) r.revealHero();
    });
  }

  /** Load an image (URL or data URL) → Billboard3D cutout + atlas thumbnail,
   *  registered under `key`. The image should have a transparent background so
   *  the silhouette traces cleanly. Shared by the PNG-art system icons (pencil/gear/install). */
  private _iconBakeGen = 0;   // bumped on every theme switch; a bake whose gen is stale drops its result
  private setBillboardFromImage(key: string, src: string, cfg: Partial<Billboard3DConfig> = {}, rimPx = 0): void {
    if (!this.renderer) return;
    const outline = cfg.sideColor ?? this.activeTheme.billboardOutline;
    this.iconJob(key, peekImageIcon(src, outline, rimPx, cfg), () => bakeImageIcon(src, outline, rimPx, cfg));
  }

  /** Hand a finished bake to the renderer: the mesh + the atlas thumbnail (already decoded when possible). */
  private applyIconBake(r: ShellRenderer, key: string, bake: IconBake): void {
    if (bake.bitmap) r.requestThumbnailBitmap(key, bake.bitmapKey, bake.bitmap);
    else r.requestThumbnail(key, bake.atlasUrl);
    r.setSystemIcon(key, bake.geo);
  }

  /** Apply `cached` now, or queue `bake` (calm moments only) and apply its result — unless the theme changed or the
   *  scene was torn down meanwhile (the next mount queues its own job, which reuses the memoised bake). */
  private iconJob(key: string, cached: IconBake | null, bake: () => Promise<IconBake>, after?: () => void): void {
    const r = this.renderer;
    if (!r) return;
    if (cached) { this.applyIconBake(r, key, cached); after?.(); return; }
    const gen = this._iconBakeGen;
    this.enqueueCalm(async () => {
      if (this.renderer !== r || gen !== this._iconBakeGen) return;   // stale before it started: don't bake for nobody
      try {
        const b = await bake();
        if (this.renderer !== r || gen !== this._iconBakeGen) return; // theme switched (or torn down) mid-bake
        this.applyIconBake(r, key, b);
        this.rebuildAndRender();
      } catch (e) {
        console.warn('[Shell] Failed to load icon billboard:', key, e);
        if (this.renderer !== r || gen !== this._iconBakeGen) return;
      }
      after?.();   // also after a failed bake (as before: the hero slot is revealed with its fallback mesh)
    });
  }

  // ── Calm-time work queue (icon bakes, the Illustrations prewarm) ──────

  private _calmChain: Promise<void> = Promise.resolve();
  /** Run `task` after the ones queued before it, and only once the Shell is calm (see whenCalm). */
  private enqueueCalm(task: () => Promise<void> | void): void {
    this._calmChain = this._calmChain.then(async () => {
      await this.whenCalm();
      await task();
    }).catch((e) => { console.warn('[Shell] deferred task failed:', e); });
  }

  /** Resolves when the mounted Shell is at least CALM_AFTER_MOUNT_MS old and no mode cross-fade is running, then at
   *  the browser's next idle slot (or at once when no scene is mounted — the task then decides what to do). */
  private async whenCalm(): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
    for (;;) {
      const r = this.renderer;
      if (!r) return;
      const wait = CALM_AFTER_MOUNT_MS - r.mountAgeMs;
      if (wait > 0) { await sleep(wait); continue; }
      if (this.transitionActive) { await sleep(60); continue; }
      break;
    }
    await new Promise<void>((res) => {
      const g = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void };
      if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(() => res(), { timeout: 300 });
      else setTimeout(res, 0);
    });
  }

  private _prewarmQueued = false;
  /** Queue a prewarm of the Illustrations view (coalesced). Runs at a calm moment while the HOME is showing. */
  private schedulePrewarm(): void {
    if (this._prewarmQueued || !this.renderer) return;
    this._prewarmQueued = true;
    this.enqueueCalm(async () => {
      this._prewarmQueued = false;
      await this.prewarmIllustrationsView();
    });
  }

  /**
   * Prepare the Illustrations grid while the home is showing, so tapping Illustrator only has to draw it: lay the
   * grid out once (filling the text-measure caches), rasterize its labels into the atlas (additive: the home labels
   * stay), and decode + upload the first screenful of thumbnails, a few per slice. Nothing is drawn differently.
   */
  private async prewarmIllustrationsView(): Promise<void> {
    const r = this.renderer, c = this.sceneCanvas;
    if (!r || !c || this.view.mode !== 'shell' || this.transitionActive || c.width === 0 || c.height === 0) return;
    const model = computeShellLayout(c.width, c.height, [], { page: 0, zoom: this.zoom }, this.activeTheme);
    // The Illustrator dashboard (the common tap); the Package Designer grid shares the chips + most of the atlas.
    const projects = this.projectsFor('illustration');
    this.layoutProjectGrid(model, 0, null, 'illustration');
    r.prewarmLabels(model.labels);
    // First screenful of thumbnails (cards on screen at scroll 0), newest first.
    const H = c.height;
    const ids: string[] = [];
    const byId = new Map<string, ProjectEntry>();
    for (const p of projects) byId.set(p.id, p);
    for (const it of model.projectGrid ?? []) {
      if (it.rect[1] + it.rect[3] <= 0 || it.rect[1] >= H) continue;
      const url = byId.get(it.id)?.thumbnailDataUrl;
      if (url) { r.requestThumbnail(it.id, url); ids.push(it.id); }
    }
    const SLICE = 4;
    for (let i = 0; i < ids.length; i += SLICE) {
      if (this.renderer !== r || this.view.mode !== 'shell' || this.transitionActive) return;   // the real view took over
      r.prewarmThumbnails(ids.slice(i, i + SLICE));
      await new Promise<void>((res) => setTimeout(res, 40));
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
      this.clusterEl.classList.add('salsa-shell-cluster');   // a host can find it (e.g. make it inert under its own modal)
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
    const compact = r.width > 0 && r.width < SHELL_COMPACT_BELOW_CSS;
    this.clusterEl.style.top = `${r.top + (compact ? 8 : 16)}px`;
    // Right edge lines up with the bottom panel window's right edge.
    const inset = r.width * this.activeTheme.cardMarginXFrac;
    this.clusterEl.style.right = `${Math.max(0, window.innerWidth - r.right) + inset}px`;
    // Phone: icons only (the count is in the ⓘ button's tooltip), so the cluster stays small.
    if (this.clusterCountEl) this.clusterCountEl.style.display = compact ? 'none' : '';
  }

  /** Device px the chrome cluster takes from the right end of the top row (the greeting and the Back / New Project
   *  chips stay clear of it). 0 before the cluster is mounted. */
  private clusterReservePx(): number {
    const c = this.sceneCanvas, row = this.clusterEl?.firstElementChild as HTMLElement | null | undefined;
    if (!c || !row) return 0;
    const cr = c.getBoundingClientRect(), rr = row.getBoundingClientRect();
    if (!(cr.width > 0) || !(rr.width > 0)) return 0;
    const dpr = shellBackingRatio(c, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    return Math.max(0, Math.ceil((cr.right - rr.left + 8) * dpr));
  }
  /** The reserve the current model was laid out with; a different measured one schedules one more rebuild. */
  private _clusterReserveUsed = 0;
  private _clusterReserveRaf = 0;

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
      const info = this.clusterIcons.find(ic => ic.key === 'info');
      if (info) info.el.title = `What is a .frogcart? (${shellCartCountLabel(n).toLowerCase()} on this device)`;
    }
    // The cluster's width changed (mounted, phone ↔ wide, count text): lay the top row out again, once.
    const reserve = this.clusterReservePx();
    if (Math.abs(reserve - this._clusterReserveUsed) > 1 && !this._clusterReserveRaf) {
      this._clusterReserveRaf = requestAnimationFrame(() => { this._clusterReserveRaf = 0; this.rebuildAndRender(); });
    }
  }

  private buildChromeCluster(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:system-ui,sans-serif;--ink:#1a4c7c;--panel:#f6efdd;max-width:calc(100vw - 16px);';

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
      this.clusterIcons.push({ el: b, emoji: glyph, mat, key });
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
    panel.style.cssText = `display:none;box-sizing:border-box;width:min(300px, calc(100vw - 32px));background:var(--panel);${winBevel}padding:12px 14px;color:var(--ink);font-size:13px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,0.22);`;
    this.clusterPanelEl = panel;
    wrap.appendChild(panel);
    return wrap;
  }

  private closeClusterPanel(): void {
    this.stopTypewriter();
    if (this.clusterPanelEl) this.clusterPanelEl.style.display = 'none';
    this.clusterActivePanel = null;
  }

  private toggleClusterPanel(key: string): void {
    const panel = this.clusterPanelEl;
    if (!panel) return;
    if (this.clusterActivePanel === key) { this.closeClusterPanel(); return; }
    this.stopTypewriter();
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
      b.onclick = () => {
        this.setTheme(name);
        // Remembered on this device (the host's Settings reads + applies the same key on load).
        try { localStorage.setItem('frogmarks.shellTheme', name); } catch { /* storage blocked: this session only */ }
        this.toggleClusterPanel('themes');
      };
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
    // Back to the editor's context configuration (the Shell ran 'opaque'): on a shared canvas the editor draws to
    // this context next. Usage stays RENDER_ATTACHMENT | COPY_DST (the editor's compositor copies into the swapchain).
    if (this.sceneContext && this.sceneFormat) {
      try {
        const dev = this.ctx.webgpuRenderer.getDevice();
        if (dev) this.sceneContext.configure({
          device: unwrapDevice(dev), format: this.sceneFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
          alphaMode: 'premultiplied',
        });
      } catch { /* the canvas is already gone: nothing to hand back */ }
    }
    this.sceneContext = null;
    // Drop references to the now-removed DOM + stale layout so we don't hold detached nodes between mounts.
    if (this._clusterScrollHandler) {
      window.removeEventListener('scroll', this._clusterScrollHandler, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', this._clusterScrollHandler);
      this._clusterScrollHandler = null;
    }
    if (this._clusterRepositionRaf) { cancelAnimationFrame(this._clusterRepositionRaf); this._clusterRepositionRaf = 0; }
    if (this._clusterReserveRaf) { cancelAnimationFrame(this._clusterReserveRaf); this._clusterReserveRaf = 0; }
    this._clusterReserveUsed = 0;
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
    const resized = this.syncCanvasBackingStore();
    this.requestThumbnails();
    const c = this.sceneCanvas;
    // Responsive home: a 64 CSS-px tile floor (fewer columns on a narrow screen) and, on a phone, only the rows the
    // tiles need plus one (not a screenful of tiny empty slots).
    const dpr = shellBackingRatio(c, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this._clusterReserveUsed = this.clusterReservePx();
    this.currentModel = computeShellLayout(
      c.width,
      c.height,
      this.buildSpecs(),
      { page: this.currentPage, zoom: this.zoom, ...shellResponsiveOpts(c.width, dpr) },
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
    // thumbnail grid + floating Back / New Project chips. modeFade is the RESTING value for the mode; while a
    // cross-fade runs the renderer overrides it with the animated one (beginModeFade), so nothing is rebuilt per frame.
    this.currentModel.modeFade = this.view.mode === 'illustrations' ? 1 : 0;
    this.zoomButtons = [];   // re-populated by buildChrome (home only)
    if (this.view.mode === 'illustrations') {
      this.buildProjectGrid(this.currentModel);
    } else {
      this.buildChrome(this.currentModel);
    }
    this.renderer.setModel(this.currentModel);
    // A backing-store resize cleared the canvas: redraw NOW (the rAF loop's next frame is a whole frame away, and this
    // may run after this frame's rAF callbacks — the cleared canvas would be presented once).
    if (resized) this.renderer.render();
    this.updateChromeCluster();
    // The project list / the canvas changed while the home is up → the prepared Illustrations view is stale.
    if (this.view.mode === 'shell' && this._prewarmSig !== this.prewarmSignature()) {
      this._prewarmSig = this.prewarmSignature();
      this.schedulePrewarm();
    }
  }

  /** What the prepared Illustrations view depends on (compared by identity / value on each home rebuild). */
  private _prewarmSig = '';
  private prewarmSignature(): string {
    const c = this.sceneCanvas;
    return `${c?.width ?? 0}x${c?.height ?? 0}|${this.activeThemeName}|${this._textEpoch}|${this._projectsEpoch}`;
  }

  /** Illustrations mode: build the curved thumbnail grid (one card per project)
   *  plus the floating Back / New Project chips, and clamp the scroll.
   *  Cards are a FIXED size (CSS px × DPR, mobile-parity UI-14); chips are sized
   *  from their measured labels so they never clip. */
  private buildProjectGrid(model: ShellRenderModel): void {
    this.gridScrollY = this.layoutProjectGrid(model, this.gridScrollY, this.view.hoveredSlotId);
  }

  // Text measuring is the expensive part of a grid rebuild (a rebuild runs on every hover / scroll step), and its
  // results only change with the text, the box and the loaded fonts: memoised until the fonts change (_textEpoch).
  private _textEpoch = 0;
  private _measEpoch = -1;
  private _titleFontCache = new Map<string, number>();
  private _chipCache: { key: string; chips: ShellChipLayout } | null = null;

  /** Lay the Illustrations grid (cards, titles, chips) into `model` for a scroll offset + hovered id. Returns the
   *  clamped scroll. Has no side effects on the view state, so it also serves the idle prewarm. */
  private layoutProjectGrid(model: ShellRenderModel, scrollY: number, hoveredId: string | null, kind: 'illustration' | 'packaging' = this.dashboardKind): number {
    const c = this.sceneCanvas;
    if (!c) return scrollY;
    const W = c.width, H = c.height;
    // Device px per CSS px of the canvas AS BACKED (CSS size × the capped DPR — UI-16), not window.devicePixelRatio.
    const dpr = shellBackingRatio(c, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const meas = this.measureCtx();
    const measureIn = (family: string) => (text: string, fontPx: number) => {
      meas.font = `400 ${fontPx}px ${family}`;
      return meas.measureText(text).width;
    };
    if (this._measEpoch !== this._textEpoch) {   // fonts (re)loaded → every cached measurement is stale
      this._measEpoch = this._textEpoch;
      this._titleFontCache.clear();
      this._chipCache = null;
    }

    // Floating chrome chips first: the grid starts below them (they may wrap on a narrow screen).
    const pkg = kind === 'packaging';
    const chipDefs: [string, string][] = [
      [SHELL_BACK_ID, '‹ Back'],
      [SHELL_NEW_PROJECT_ID, pkg ? '+ New Product Packaging' : '+ New Project'],
    ];
    const reserve = this._clusterReserveUsed;   // the top-right cluster: the first chip row stays clear of it
    const chipKey = `${pkg ? 1 : 0}|${W}|${H}|${dpr}|${reserve}`;
    if (this._chipCache?.key !== chipKey) {
      this._chipCache = { key: chipKey, chips: layoutShellChips(chipDefs.map(cd => cd[1]), measureIn(FONT_FAMILY), W, H, dpr, reserve) };
    }
    const chips = this._chipCache.chips;

    const projects = this.projectsFor(kind);
    const ids = projects.map(p => p.id);
    const top = chips.bottom + 16 * dpr;
    // Clamp scroll to the content height (probe with zero offset first).
    const probe = computeProjectGrid(W, H, ids, 0, dpr, top);
    const maxScroll = Math.max(0, probe.contentHeight - H);
    scrollY = Math.max(0, Math.min(scrollY, maxScroll));
    const grid = computeProjectGrid(W, H, ids, scrollY, dpr, top);
    model.projectGrid = grid.items.map(it => ({
      ...it, hover: hoveredId === it.id ? 1 : 0,
    }));
    model.gridContentHeight = grid.contentHeight;

    // Per-card window title: the project name in the green title bar. Only the
    // on-screen cards (label positions/sizes must match the GRID_SHADER chrome:
    // titleH = projectCardTitleH, bevel b). Light text on the green bar.
    const measureTitle = measureIn(TITLEBAR_FONT);
    for (let i = 0; i < grid.items.length; i++) {
      const it = grid.items[i];
      const name = projects[i]?.name;
      const [gx, gy, gw, gh] = it.rect;
      if (!name || gy + gh < 0 || gy > H) continue;   // skip off-screen
      // Geometry must match the GRID_SHADER title bar (b, titleH, close button).
      const b = Math.min(2.5, Math.max(1.5, Math.min(gw, gh) * 0.012));
      const titleH = projectCardTitleH(it);
      const leftPad = 2 * b + gw * 0.025;
      const xReserve = titleH * 0.70 + 4 * b;         // close button slot
      const availW = Math.max(8, gw - leftPad - xReserve);
      // 12–16 CSS px; shrinks toward 12 px before the atlas falls back to an ellipsis.
      const fontKey = `${availW}|${titleH}|${dpr}|${name}`;
      let fontPx = this._titleFontCache.get(fontKey);
      if (fontPx === undefined) {
        fontPx = projectCardTitleFontPx(name, availW, titleH, dpr, measureTitle);
        if (this._titleFontCache.size > 4000) this._titleFontCache.clear();
        this._titleFontCache.set(fontKey, fontPx);
      }
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

    const theme = this.activeTheme;
    // Empty dashboard: say so, and point at the button that fixes it (was: a blank screen under the chips).
    if (projects.length === 0) {
      let coarse = false;
      try { coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch { /* no matchMedia */ }
      const [head, hint] = shellEmptyGridLines(kind, coarse);
      const availW = Math.max(8, W - 2 * projectGridSideMargin(W, dpr));
      const headFont = projectCardTitleFontPx(head, availW, Math.round(H * 0.034), dpr, measureIn(FONT_FAMILY));
      const hintFont = projectCardTitleFontPx(hint, availW, Math.round(H * 0.026), dpr, measureIn(TITLEBAR_FONT));
      const ct = theme.chromeText ?? theme.ink;
      const y0 = top + Math.max(24 * dpr, H * 0.06);
      model.labels.push({
        id: '__empty_head__', text: head, centerX: W / 2, topY: y0,
        maxWidthPx: availW, fontPx: headFont, color: [ct[0], ct[1], ct[2], 1],
      });
      model.labels.push({
        id: '__empty_hint__', text: hint, centerX: W / 2, topY: y0 + headFont * 1.6,
        maxWidthPx: availW, fontPx: hintFont, color: [ct[0], ct[1], ct[2], 0.85], fontFamily: TITLEBAR_FONT,
      });
    }

    // Chips: plain tiles + labels, hit-tested as tiles (handleClick routes Back / New Project).
    chipDefs.forEach(([id, text], i) => {
      const [x, y, w, h] = chips.rects[i];
      model.tiles.push({
        id, kind: 'empty', rect: [x, y, w, h],
        fill: theme.systemFill, cornerRadius: 0,   // sharp Win9x button
        selected: false, hovered: hoveredId === id,
      });
      model.labels.push({
        id, text, centerX: x + w / 2,
        topY: y + Math.max(0, (h - 1.4 * chips.fontPx) / 2),   // atlas cell = 1.4·fontPx tall → centred
        maxWidthPx: w, fontPx: chips.fontPx, color: [0.13, 0.13, 0.15, 1],   // dark text on the grey button
      });
    });
    return scrollY;
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
    let gFont = Math.max(12, Math.round(h * 0.030));
    const topSY = 0.60, botSY = 1.50;
    // Measure natural widths in the shell font, then match the top word's
    // width to the bottom word's (re-measures correctly once Bungee loads).
    const meas = this.measureCtx();
    meas.font = `400 ${gFont}px ${FONT_FAMILY}`;
    let w1n = Math.max(1, meas.measureText(gw1).width);
    let w2n = Math.max(1, meas.measureText(gw2).width);
    // Keep the greeting clear of the top-right cluster (a phone used to draw them on top of each other): shrink the
    // font so the wider word ends before the cluster's left edge (text width scales linearly with the font).
    const roomW = w - gx - this._clusterReserveUsed;
    const needW = Math.max(w1n, w2n) * 1.0 + 0.6 * gFont;   // + the atlas padding (0.3·font each side)
    if (this._clusterReserveUsed > 0 && needW > roomW && roomW > 0) {
      const minFont = Math.max(12, Math.round(14 * shellBackingRatio(c, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)));
      const f = Math.max(minFont, Math.floor(gFont * roomW / needW));
      if (f < gFont) {
        gFont = f;
        meas.font = `400 ${gFont}px ${FONT_FAMILY}`;
        w1n = Math.max(1, meas.measureText(gw1).width);
        w2n = Math.max(1, meas.measureText(gw2).width);
      }
    }
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

  /** Ensure the canvas backing store matches its CSS size × DPR under the device caps (mobile-parity UI-16: the
   *  editor's rule — mobile DPR ≤ 1.5 / ≤ ~2.5 MP, desktop uncapped). The main renderer normally owns this, but it
   *  is suspended while the shell is up (and skips sizing then), so the two never fight over canvas.width. */
  private syncCanvasBackingStore(): boolean {
    const c = this.sceneCanvas;
    if (!c) return false;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return syncShellCanvasBacking(c, dpr, this.ctx.webgpuRenderer?.getGpuCaps?.() ?? DESKTOP_CAPS);
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
    // Illustrations grid: drag (touch / pen / mouse) scrolls vertically — the only way to scroll on a tablet
    // (#shellCanvas is touch-action:none and has no wheel there). Past an 8 CSS-px threshold it's a drag, and
    // the click the browser fires on release is swallowed so a scroll doesn't open a card.
    this.boundPointerDown = (e) => {
      if (this.view.mode !== 'illustrations' || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const [, py] = this.toDevicePx(canvas, e.clientX, e.clientY);
      this.gridDrag = { pointerId: e.pointerId, startY: py, startScroll: this.gridScrollY, dragging: false };
      this.suppressNextClick = false;
    };
    this.boundPointerUp = (e) => {
      const d = this.gridDrag;
      if (!d || d.pointerId !== e.pointerId) return;
      this.gridDrag = null;
      if (d.dragging) {
        this.suppressNextClick = e.type === 'pointerup';
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      }
    };
    this.boundPointerMove = (e) => {
      const [px, py] = this.toDevicePx(canvas, e.clientX, e.clientY);
      const drag = this.gridDrag;
      if (drag && drag.pointerId === e.pointerId && this.view.mode === 'illustrations') {
        const dy = py - drag.startY;
        const cssPx = canvas.clientHeight > 0 ? canvas.height / canvas.clientHeight : 1;
        if (!drag.dragging && Math.abs(dy) > 8 * cssPx) {
          drag.dragging = true;
          try { canvas.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
        }
        if (drag.dragging) {
          this.gridScrollY = drag.startScroll - dy;
          this.rebuildAndRender();   // clamps gridScrollY inside buildProjectGrid
          return;
        }
      }
      this.handleHover(this.hitTest(px, py));
      // Feed normalized pointer (-1..1 from center) to the renderer for parallax.
      const w = canvas.width || 1, h = canvas.height || 1;
      this.renderer?.setPointer((px / w) * 2 - 1, (py / h) * 2 - 1);
    };
    this.boundClick = (e) => {
      if (this.suppressNextClick) { this.suppressNextClick = false; return; }   // end of a grid drag-scroll
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
        const delId = hitTestProjectGridClose(this.currentModel, px, py, this.sceneCanvas?.width ?? 0, this.closeMinHitPx(canvas));
        if (delId) { this.onProjectDelete.emit({ id: delId, dashboardKind: this.dashboardKind }); return; }
      }
      const id = this.hitTest(px, py);
      if (id) this.handleClick(id);
    };
    this.boundDblClick = (e) => {
      const [px, py] = this.toDevicePx(canvas, e.clientX, e.clientY);
      // Don't open the illustration when the double-click lands on its ✕ (the first click already fired delete).
      if (this.view.mode === 'illustrations' && hitTestProjectGridClose(this.currentModel, px, py, this.sceneCanvas?.width ?? 0, this.closeMinHitPx(canvas))) return;
      const id = this.hitTest(px, py);
      const tap = this._tapActivated;
      this._tapActivated = null;
      if (id && tap && tap.id === id && performance.now() - tap.at < 800) return;   // its 2nd click already opened it
      if (id) this.handleActivate(id);
    };
    this.boundKeyDown = (e) => {
      // Not an Escape a host dialog consumed / meant for itself (it used to close the dialog AND flip the grid home).
      if (e.key === 'Escape' && this.view.mode === 'illustrations'
        && !shellShouldIgnoreEscape(e, isHostModalOpen(typeof document !== 'undefined' ? document : null))) {
        this.closeIllustratorDashboard();
      }
    };
    // Wheel: Ctrl/⌘+wheel zooms tile size; plain wheel pages horizontally.
    this.boundWheel = (e) => {
      e.preventDefault();
      // Illustrations grid: plain wheel scrolls the grid vertically.
      if (this.view.mode === 'illustrations') {
        this.gridScrollY += (e.deltaY || 0) * shellBackingRatio(canvas);   // CSS px → canvas device px (as backed)
        this.rebuildAndRender();   // clamps gridScrollY inside buildProjectGrid
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (Math.abs(e.deltaY) < 0.5) return;   // deltaY 0 (horizontal tilt / trackpad jitter) is not a zoom step
        this.adjustZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      } else {
        const d = (e.deltaY || e.deltaX);
        if (Math.abs(d) > 0) this.changePage(d > 0 ? 1 : -1);
      }
    };
    addZonelessListener(canvas, 'pointermove', this.boundPointerMove);
    addZonelessListener(canvas, 'pointerdown', this.boundPointerDown);
    addZonelessListener(canvas, 'pointerup', this.boundPointerUp);
    addZonelessListener(canvas, 'pointercancel', this.boundPointerUp);
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
      if (this.boundPointerDown) removeZonelessListener(c, 'pointerdown', this.boundPointerDown);
      if (this.boundPointerUp) {
        removeZonelessListener(c, 'pointerup', this.boundPointerUp);
        removeZonelessListener(c, 'pointercancel', this.boundPointerUp);
      }
      if (this.boundClick) c.removeEventListener('click', this.boundClick);
      if (this.boundDblClick) c.removeEventListener('dblclick', this.boundDblClick);
      if (this.boundWheel) removeZonelessListener(c, 'wheel', this.boundWheel);
    }
    if (this.boundKeyDown) window.removeEventListener('keydown', this.boundKeyDown);
    this.renderer?.cancelModeFade();
    this.transitionActive = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.boundPointerMove = this.boundPointerDown = this.boundPointerUp = undefined;
    this.boundClick = this.boundDblClick = undefined;
    this.gridDrag = null;
    this.suppressNextClick = false;
    this.boundKeyDown = undefined;
    this.boundWheel = undefined;
  }

  /** The project-card ✕ hit box (device px): finger-sized on a coarse pointer, else the drawn button (0). */
  private closeMinHitPx(canvas: HTMLCanvasElement): number {
    let coarse = false;
    try { coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch { /* no matchMedia */ }
    return coarse ? SHELL_CLOSE_MIN_HIT_COARSE_CSS * shellBackingRatio(canvas) : 0;
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
    // A cart: the first tap selects it (the viewer shows it), a tap on the selected cart opens it — a phone has no
    // double-click, so opening a cart used to be impossible there.
    if (this.view.selectedSlotId === id) {
      this._tapActivated = { id, at: performance.now() };
      this.handleActivate(id);
      return;
    }
    this.setSelectedSlot(id);
  }

  /** The cart a second click just opened (the dblclick that follows it must not open it again). */
  private _tapActivated: { id: string; at: number } | null = null;

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
