/**
 * asset-store-opfs — the browser AssetStorageBackend for the Shared Asset Library (docs/specs/shared-asset-library.md §3).
 *
 * OPFS layout (a sibling of ShellStorage's /shell, /carts, /projects — same conventions):
 *   /library/
 *     index.json          — AssetIndexEntry[] (envelopes + meta, no payloads) → instant listing
 *     assets/{id}.json     — one asset's payload (small kinds: clip tracks, pose, material recipe, brush)
 *
 * (Large binary payloads → a future /library/blobs/{id}.bin tier; small JSON payloads cover the current kinds.)
 * Writes to a single file are serialized through a mutex because OPFS `createWritable()` is exclusive — two
 * overlapping saves of index.json would otherwise race, exactly as ShellStorage guards. Falls back gracefully
 * (empty index, null payloads) when OPFS is unavailable, so the library degrades instead of throwing.
 */

import type { AssetStorageBackend, AssetIndexEntry } from './asset-types';

export class OpfsAssetBackend implements AssetStorageBackend {
  private writeChain: Promise<unknown> = Promise.resolve();

  private available(): boolean {
    return typeof navigator !== 'undefined'
      && !!navigator.storage
      && typeof navigator.storage.getDirectory === 'function';
  }

  private async libraryDir(create = false): Promise<FileSystemDirectoryHandle | null> {
    if (!this.available()) return null;
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('library', { create });
  }
  private async assetsDir(create = false): Promise<FileSystemDirectoryHandle | null> {
    const lib = await this.libraryDir(create);
    return lib ? lib.getDirectoryHandle('assets', { create }) : null;
  }

  // Serialize every write (index + payload) so exclusive OPFS writables never overlap.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => {});   // a failed write doesn't wedge the chain
    return run;
  }

  private async writeJSON(dir: FileSystemDirectoryHandle, name: string, data: unknown): Promise<void> {
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(data));
    await writable.close();
  }
  private async readJSON<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
    try {
      const file = await dir.getFileHandle(name);
      const text = await (await file.getFile()).text();
      return JSON.parse(text) as T;
    } catch { return null; }   // missing file / parse error → treat as absent
  }

  async loadIndex(): Promise<AssetIndexEntry[]> {
    const dir = await this.libraryDir(false);
    if (!dir) return [];
    return (await this.readJSON<AssetIndexEntry[]>(dir, 'index.json')) ?? [];
  }

  async saveIndex(index: AssetIndexEntry[]): Promise<void> {
    return this.enqueue(async () => {
      const dir = await this.libraryDir(true);
      if (dir) await this.writeJSON(dir, 'index.json', index);
    });
  }

  async loadPayload(id: string): Promise<unknown | null> {
    const dir = await this.assetsDir(false);
    if (!dir) return null;
    return this.readJSON<unknown>(dir, `${id}.json`);
  }

  async savePayload(id: string, payload: unknown): Promise<void> {
    return this.enqueue(async () => {
      const dir = await this.assetsDir(true);
      if (dir) await this.writeJSON(dir, `${id}.json`, payload);
    });
  }

  async deletePayload(id: string): Promise<void> {
    return this.enqueue(async () => {
      const dir = await this.assetsDir(false);
      if (!dir) return;
      try { await dir.removeEntry(`${id}.json`); } catch { /* already gone */ }
    });
  }
}
