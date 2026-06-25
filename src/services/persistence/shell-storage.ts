/**
 * ShellStorage — OPFS-backed persistence for the Frogmarks Shell UI.
 *
 * The shell is the browser-native console home screen that replaces the
 * legacy HTML/SCSS dashboard. It owns two independent indexes:
 *
 *   • Cart registry  — system apps + installed local/remote FrogCarts
 *   • Project index   — the user's saved .frogmarks illustration projects
 *
 * Storage layout in OPFS (siblings of /salsa-documents, NOT nested):
 *   /shell/
 *     registry.json        — ShellRegistry (cart + system app slots)
 *     projects.json        — ProjectRegistry (.frogmarks index)
 *   /carts/
 *     {id}.frogcart        — installed local carts
 *     cache/
 *       {id}.frogcart      — cached remote cart binaries
 *   /projects/
 *     {id}.frogmarks       — illustration project files
 *
 * This module has ZERO coupling to the renderer or UI. ShellUIManager
 * wires it into the rest of the engine. It deliberately mirrors the
 * OPFS read/write conventions used by DocumentPersistence so the two
 * storage layers behave identically.
 */

// ── Cart registry types ──────────────────────────────────────────────

export type ShellSlotType = 'system' | 'local' | 'remote';

/** Auto-update behavior for a remote cart. */
export type AutoUpdateMode = boolean | 'prompt';

export interface ShellSlot {
  /** Stable UUID. For system apps this is a fixed well-known id. */
  id: string;
  /** Position in the grid. System apps are pinned to the front. */
  order: number;
  type: ShellSlotType;
  name: string;
  description?: string;
  /** base64 PNG cached here for instant dashboard load (no cart unpack). */
  thumbnailDataUrl?: string;

  // ── system only ──
  /** Well-known system app key, e.g. 'illustrator' | 'settings'. */
  systemKey?: string;

  // ── local only ──
  /** '/carts/{id}.frogcart' */
  opfsPath?: string;

  // ── remote only ──
  /** URL to the cart's manifest JSON. */
  registryUrl?: string;
  /** URL to the .frogcart blob. */
  packageUrl?: string;
  /** SHA-256 of the cached binary. */
  packageHash?: string;
  installedVersion?: string;
  /** '/carts/cache/{id}.frogcart' */
  cachedOpfsPath?: string;
  autoUpdate?: AutoUpdateMode;
  /** Multiplayer carts that cannot run offline. */
  requiresNetwork?: boolean;
  /** Timestamp (ms) of the last update check, for throttling. */
  lastChecked?: number;
}

export interface ShellRegistry {
  version: 2;
  slots: ShellSlot[];
}

/**
 * Cart manifest JSON hosted by a creator at a stable URL. The shell
 * fetches this when installing or update-checking a remote cart.
 */
export interface CartManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  /** URL to .frogcart blob. */
  packageUrl: string;
  /** SHA-256 of the package. */
  packageHash: string;
  /** PNG for label and grid tile. */
  thumbnailUrl: string;
  autoUpdate?: AutoUpdateMode;
  requiresNetwork?: boolean;
  /** Future: URL to .frogscene for custom cartridge-viewer mini-scene. */
  shellSceneUrl?: string;
}

// ── Project index types ──────────────────────────────────────────────

export interface ProjectEntry {
  /** Stable UUID. In the index-over-documents model this **equals the
   *  DocumentPersistence docId** (project id === document id). */
  id: string;
  name: string;
  /** base64 thumbnail (from the document manifest) for fast grid load. */
  thumbnailDataUrl?: string;
  /** Unix timestamp (ms). Optional — a host source that has no timestamp can
   *  omit it; such entries sort to the bottom. */
  lastModified?: number;
  /** '/projects/{id}.frogmarks' — only set when an exported package exists.
   *  The live editable document lives in DocumentPersistence, not here. */
  opfsPath?: string;
  sizeBytes?: number;
}

export interface ProjectRegistry {
  version: 1;
  projects: ProjectEntry[];
}

// ── Well-known system apps ───────────────────────────────────────────

/**
 * The two pinned system apps. These are hardcoded — they have no
 * .frogcart file and never appear in the persisted slot list with cart
 * data. ShellUIManager prepends them to the grid at load time.
 */
export const SYSTEM_APPS: ReadonlyArray<ShellSlot> = [
  {
    id: 'system:illustrator',
    order: 0,
    type: 'system',
    systemKey: 'illustrator',
    name: 'Illustrator',
    description: 'Browse and open your .frogmarks projects',
  },
  {
    id: 'system:settings',
    order: 1,
    type: 'system',
    systemKey: 'settings',
    name: 'Settings',
    description: 'Preferences and Install-by-URL',
  },
];

// ── Storage ──────────────────────────────────────────────────────────

const EMPTY_REGISTRY: ShellRegistry = { version: 2, slots: [] };
const EMPTY_PROJECTS: ProjectRegistry = { version: 1, projects: [] };

/**
 * OPFS persistence for the shell. All methods are best-effort: read
 * failures resolve to an empty index rather than throwing, so a missing
 * or corrupt registry degrades to a fresh dashboard instead of a crash.
 */
export class ShellStorage {
  /** True when OPFS is available in this environment. */
  static isAvailable(): boolean {
    return typeof navigator !== 'undefined'
      && !!navigator.storage
      && typeof navigator.storage.getDirectory === 'function';
  }

  // ── directory handles ──

  private async getOPFSRoot(): Promise<FileSystemDirectoryHandle> {
    return navigator.storage.getDirectory();
  }

  private async getShellDir(create = false): Promise<FileSystemDirectoryHandle> {
    const root = await this.getOPFSRoot();
    return root.getDirectoryHandle('shell', { create });
  }

  private async getCartsDir(create = false): Promise<FileSystemDirectoryHandle> {
    const root = await this.getOPFSRoot();
    return root.getDirectoryHandle('carts', { create });
  }

  private async getCartCacheDir(create = false): Promise<FileSystemDirectoryHandle> {
    const carts = await this.getCartsDir(create);
    return carts.getDirectoryHandle('cache', { create });
  }

  private async getProjectsDir(create = false): Promise<FileSystemDirectoryHandle> {
    const root = await this.getOPFSRoot();
    return root.getDirectoryHandle('projects', { create });
  }

  // ── cart registry ──

  /** Load the cart registry. Returns an empty registry if none exists. */
  async loadRegistry(): Promise<ShellRegistry> {
    try {
      const dir = await this.getShellDir(false);
      const reg = await this.readJSON<ShellRegistry>(dir, 'registry.json');
      if (!reg || reg.version !== 2 || !Array.isArray(reg.slots)) return { ...EMPTY_REGISTRY };
      return reg;
    } catch {
      return { ...EMPTY_REGISTRY };
    }
  }

  /** Persist the cart registry. */
  async saveRegistry(registry: ShellRegistry): Promise<void> {
    const dir = await this.getShellDir(true);
    await this.writeJSON(dir, 'registry.json', registry);
  }

  // ── project index ──

  /** Load the project index. Returns an empty index if none exists. */
  async loadProjects(): Promise<ProjectRegistry> {
    try {
      const dir = await this.getShellDir(false);
      const reg = await this.readJSON<ProjectRegistry>(dir, 'projects.json');
      if (!reg || reg.version !== 1 || !Array.isArray(reg.projects)) return { ...EMPTY_PROJECTS };
      return reg;
    } catch {
      return { ...EMPTY_PROJECTS };
    }
  }

  /** Persist the project index. */
  async saveProjects(registry: ProjectRegistry): Promise<void> {
    const dir = await this.getShellDir(true);
    await this.writeJSON(dir, 'projects.json', registry);
  }

  // ── cart binaries ──

  /** Write a local cart binary to /carts/{id}.frogcart and return its OPFS path. */
  async writeLocalCart(id: string, data: ArrayBuffer): Promise<string> {
    const dir = await this.getCartsDir(true);
    await this.writeBinary(dir, `${id}.frogcart`, data);
    return `/carts/${id}.frogcart`;
  }

  /** Write a cached remote cart binary to /carts/cache/{id}.frogcart and return its OPFS path. */
  async writeCachedCart(id: string, data: ArrayBuffer): Promise<string> {
    const dir = await this.getCartCacheDir(true);
    await this.writeBinary(dir, `${id}.frogcart`, data);
    return `/carts/cache/${id}.frogcart`;
  }

  /** Read a local cart binary. Returns null if missing. */
  async readLocalCart(id: string): Promise<ArrayBuffer | null> {
    try {
      const dir = await this.getCartsDir(false);
      return this.readBinary(dir, `${id}.frogcart`);
    } catch {
      return null;
    }
  }

  /** Read a cached remote cart binary. Returns null if missing. */
  async readCachedCart(id: string): Promise<ArrayBuffer | null> {
    try {
      const dir = await this.getCartCacheDir(false);
      return this.readBinary(dir, `${id}.frogcart`);
    } catch {
      return null;
    }
  }

  /** Remove a cart binary (local and cached, if present). */
  async deleteCartBinaries(id: string): Promise<void> {
    try {
      const dir = await this.getCartsDir(false);
      await dir.removeEntry(`${id}.frogcart`).catch(() => {});
    } catch { /* no carts dir */ }
    try {
      const cache = await this.getCartCacheDir(false);
      await cache.removeEntry(`${id}.frogcart`).catch(() => {});
    } catch { /* no cache dir */ }
  }

  // ── project files ──

  /** Write a .frogmarks project file and return its OPFS path. */
  async writeProjectFile(id: string, data: ArrayBuffer): Promise<string> {
    const dir = await this.getProjectsDir(true);
    await this.writeBinary(dir, `${id}.frogmarks`, data);
    return `/projects/${id}.frogmarks`;
  }

  /** Read a .frogmarks project file. Returns null if missing. */
  async readProjectFile(id: string): Promise<ArrayBuffer | null> {
    try {
      const dir = await this.getProjectsDir(false);
      return this.readBinary(dir, `${id}.frogmarks`);
    } catch {
      return null;
    }
  }

  /** Remove a .frogmarks project file. */
  async deleteProjectFile(id: string): Promise<void> {
    try {
      const dir = await this.getProjectsDir(false);
      await dir.removeEntry(`${id}.frogmarks`).catch(() => {});
    } catch { /* no projects dir */ }
  }

  // ── OPFS read/write primitives (mirrors DocumentPersistence) ──

  private async writeJSON(dir: FileSystemDirectoryHandle, name: string, data: any): Promise<void> {
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(data));
    await writable.close();
  }

  private async writeBinary(dir: FileSystemDirectoryHandle, name: string, data: ArrayBuffer): Promise<void> {
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
  }

  private async readJSON<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
    try {
      const file = await dir.getFileHandle(name);
      const blob = await file.getFile();
      const text = await blob.text();
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private async readBinary(dir: FileSystemDirectoryHandle, name: string): Promise<ArrayBuffer | null> {
    try {
      const file = await dir.getFileHandle(name);
      const blob = await file.getFile();
      return blob.arrayBuffer();
    } catch {
      return null;
    }
  }
}
