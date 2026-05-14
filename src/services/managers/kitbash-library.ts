/**
 * KitbashLibrary — in-memory catalog of kitbash part metadata.
 *
 * Load one or more manifests via loadManifest(url). Parts are indexed by ID
 * and by slot for O(1) and O(k) lookup respectively.
 *
 * Manifest JSON format:
 *   { "version": "1", "styleSet": "frogmarks-v1", "parts": KitbashPartMeta[] }
 */

import type { CharacterSlot, KitbashPartMeta } from '../../types/kitbash-3d';

export class KitbashLibrary {
  private readonly _parts    = new Map<string, KitbashPartMeta>();
  private readonly _bySlot   = new Map<CharacterSlot, KitbashPartMeta[]>();

  // ── Catalog loading ───────────────────────────────────────────────────────

  /**
   * Fetch and parse a manifest JSON from the given URL, merging its parts into
   * the catalog. Safe to call multiple times with different manifests.
   */
  async loadManifest(url: string): Promise<void> {
    const json = await fetch(url).then(r => {
      if (!r.ok) throw new Error(`KitbashLibrary: failed to load manifest from ${url} (${r.status})`);
      return r.json();
    });
    this._ingestParts(json.parts ?? []);
  }

  /**
   * Register parts from a pre-parsed array (e.g. from a bundled import).
   * Safe to call multiple times.
   */
  addParts(parts: KitbashPartMeta[]): void {
    this._ingestParts(parts);
  }

  private _ingestParts(parts: KitbashPartMeta[]): void {
    for (const part of parts) {
      this._parts.set(part.id, part);
      if (!this._bySlot.has(part.slot)) this._bySlot.set(part.slot, []);
      const existing = this._bySlot.get(part.slot)!;
      // Replace if already present (re-load of same ID), otherwise append.
      const idx = existing.findIndex(p => p.id === part.id);
      if (idx >= 0) existing[idx] = part;
      else existing.push(part);
    }
  }

  // ── Catalog queries ───────────────────────────────────────────────────────

  /** Get all parts that fill the given slot. Returns [] if none loaded yet. */
  getPartsBySlot(slot: CharacterSlot): KitbashPartMeta[] {
    return this._bySlot.get(slot) ?? [];
  }

  /** Look up a part by its stable ID. Returns null if not found. */
  getPart(id: string): KitbashPartMeta | null {
    return this._parts.get(id) ?? null;
  }

  /** All slot types that have at least one part loaded. */
  getAllSlots(): CharacterSlot[] {
    return [...this._bySlot.keys()];
  }

  /** Total number of parts across all slots. */
  get partCount(): number { return this._parts.size; }

  /** True when at least one part has been loaded. */
  get isLoaded(): boolean { return this._parts.size > 0; }
}
