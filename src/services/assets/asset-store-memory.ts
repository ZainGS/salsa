/**
 * asset-store-memory — an in-memory AssetStorageBackend for tests + a safe fallback when OPFS is unavailable
 * (docs/specs/shared-asset-library.md §3). Deep-copies on read/write so callers can't alias the stored state,
 * matching how the OPFS backend behaves (it serializes through JSON blobs).
 */

import type { AssetStorageBackend, AssetIndexEntry } from './asset-types';

const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));

export class MemoryAssetBackend implements AssetStorageBackend {
  private index: AssetIndexEntry[] = [];
  private payloads = new Map<string, unknown>();

  async loadIndex(): Promise<AssetIndexEntry[]> {
    return this.index.map((e) => clone(e));
  }
  async saveIndex(index: AssetIndexEntry[]): Promise<void> {
    this.index = index.map((e) => clone(e));
  }
  async loadPayload(id: string): Promise<unknown | null> {
    return this.payloads.has(id) ? clone(this.payloads.get(id)) : null;
  }
  async savePayload(id: string, payload: unknown): Promise<void> {
    this.payloads.set(id, clone(payload));
  }
  async deletePayload(id: string): Promise<void> {
    this.payloads.delete(id);
  }
}
