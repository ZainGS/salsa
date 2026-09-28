/**
 * asset-library — the account-global Shared Asset Library store (docs/specs/shared-asset-library.md).
 *
 * Domain-agnostic: it holds an index of `AssetRecord` envelopes, delegates the domain body to registered
 * `AssetProvider`s, and persists through a pluggable `AssetStorageBackend` (in-memory for tests, OPFS in the
 * browser). This is the "global" tier — creators promote here, and any document instantiates from here. Ids are
 * always minted here (never a document node id) and RE-MINTED on import, so libraries never collide across accounts.
 */

import type {
  AssetRecord, AssetIndexEntry, AssetKind, AssetProvider, AssetStorageBackend, AssetBundle, InstantiateTarget,
} from './asset-types';
import { resolveReference as resolveRef, type AssetReference, type EmbeddedAsset, type ResolvedReference } from './asset-references';

/** Default id minter — real UUID where available, else a time+counter fallback (tests inject a deterministic one). */
let _fallbackCounter = 0;
function defaultMintId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return `asset_${c.randomUUID()}`;
  } catch { /* no crypto — fall through */ }
  return `asset_${Date.now().toString(36)}_${(_fallbackCounter++).toString(36)}`;
}

export interface AssetListFilter {
  kind?: AssetKind;
  tags?: string[];          // AND — an asset must carry every listed tag
  query?: string;           // case-insensitive substring over name + tags
}

export class AssetLibrary {
  private index = new Map<string, AssetIndexEntry>();
  private providers = new Map<AssetKind, AssetProvider>();
  private loaded = false;

  constructor(
    private backend: AssetStorageBackend,
    private mintId: () => string = defaultMintId,
    private now: () => number = () => Date.now(),
  ) {}

  /** Register a domain provider (engine-internal; domains self-register at init). Last registration per kind wins. */
  registerProvider(provider: AssetProvider): void {
    this.providers.set(provider.kind, provider);
  }

  /** Load the index from the backend once. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.loaded) return;
    const idx = await this.backend.loadIndex();
    this.index.clear();
    for (const e of idx) this.index.set(e.id, e);
    this.loaded = true;
  }

  /** List envelopes (no payload unpack), newest first, optionally filtered by kind / tags / text. */
  list(filter?: AssetListFilter): AssetIndexEntry[] {
    let rows = [...this.index.values()];
    if (filter?.kind) rows = rows.filter((r) => r.kind === filter.kind);
    if (filter?.tags?.length) rows = rows.filter((r) => filter.tags!.every((t) => r.tags.includes(t)));
    if (filter?.query) {
      const q = filter.query.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)));
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).map((r) => ({ ...r }));
  }

  /** Full record (envelope + payload) for one id, or null if unknown / payload missing. */
  async get<P = unknown>(id: string): Promise<AssetRecord<P> | null> {
    await this.init();
    const env = this.index.get(id);
    if (!env) return null;
    const payload = await this.backend.loadPayload(id);
    if (payload == null) return null;
    return { ...env, payload: payload as P };
  }

  /**
   * Promote a payload into the global library. Mints a fresh id, computes `meta` via the provider (if registered),
   * writes the payload blob + index row. `payload` is the domain entry as-is (the domain facade resolves a doc-local
   * id → payload before calling this).
   */
  async promote<P = unknown>(kind: AssetKind, payload: P, opts: { name: string; tags?: string[]; createdBy?: string }): Promise<AssetRecord<P>> {
    await this.init();
    const id = this.mintId();
    const ts = this.now();
    const provider = this.providers.get(kind);
    const rec: AssetRecord<P> = {
      id, kind, name: opts.name, tags: opts.tags ? [...opts.tags] : [],
      version: 1, createdAt: ts, updatedAt: ts, createdBy: opts.createdBy,
      meta: provider ? provider.meta(payload) : {},
      payload,
    };
    await this.backend.savePayload(id, payload);
    this._putEnvelope(rec);
    await this._flushIndex();
    return rec;
  }

  /** Fires after a successful instantiate so the document can record a provenance reference (L3). */
  private _onInstantiate?: (record: AssetRecord, docLocalId: string) => void;
  setInstantiateHook(fn: ((record: AssetRecord, docLocalId: string) => void) | null): void { this._onInstantiate = fn ?? undefined; }

  /** Apply an asset into the open document via its provider. Returns the new document-local id, or null. */
  async instantiate(id: string, target: InstantiateTarget): Promise<string | null> {
    const rec = await this.get(id);
    if (!rec) return null;
    const provider = this.providers.get(rec.kind);
    if (!provider) return null;
    const docLocalId = await provider.instantiate(rec.payload, target);
    if (docLocalId && this._onInstantiate) this._onInstantiate(rec, docLocalId);
    return docLocalId;
  }

  /**
   * Resolve a document reference against the LIVE global library + the document's embedded copy (asset-references.ts).
   * The document persistence layer calls this on load: use the embedded copy (authoritative), flag when the global
   * library is newer, or report dangling when neither is present.
   */
  async resolveReference(ref: AssetReference, embedded?: EmbeddedAsset | null): Promise<ResolvedReference> {
    await this.init();
    const global = await this.get(ref.globalId);
    return resolveRef(ref, global, embedded ?? null);
  }

  /** Preview blob for a card (delegates to the provider's optional capture), or null. */
  async thumbnail(id: string): Promise<Blob | null> {
    const rec = await this.get(id);
    if (!rec) return null;
    const provider = this.providers.get(rec.kind);
    return provider?.thumbnail ? provider.thumbnail(rec.payload) : null;
  }

  async rename(id: string, name: string): Promise<boolean> {
    await this.init();
    const env = this.index.get(id);
    if (!env) return false;
    env.name = name; env.updatedAt = this.now();
    await this._flushIndex();
    return true;
  }

  async retag(id: string, tags: string[]): Promise<boolean> {
    await this.init();
    const env = this.index.get(id);
    if (!env) return false;
    env.tags = [...tags]; env.updatedAt = this.now();
    await this._flushIndex();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    await this.init();
    if (!this.index.has(id)) return false;
    this.index.delete(id);
    await this.backend.deletePayload(id);
    await this._flushIndex();
    return true;
  }

  /** Export a shareable bundle (records WITH payloads). Filter to a kind/tags/query subset, or export everything. */
  async export(filter?: AssetListFilter): Promise<AssetBundle> {
    await this.init();
    const rows = this.list(filter);
    const assets: AssetRecord[] = [];
    for (const env of rows) {
      const payload = await this.backend.loadPayload(env.id);
      if (payload != null) assets.push({ ...env, payload });
    }
    return { version: 1, assets };
  }

  /**
   * Import a bundle. Every id is RE-MINTED (imported libraries never collide with existing assets), `version` resets
   * to 1, and timestamps are refreshed. With `merge:false` the current library is cleared first. Returns the new
   * records. NOTE: imported assets are untrusted — the caller gates executable kinds (`effect`) per the sandbox rule.
   */
  async import(bundle: AssetBundle, opts?: { merge?: boolean }): Promise<AssetRecord[]> {
    await this.init();
    if (opts?.merge === false) {
      for (const id of [...this.index.keys()]) await this.backend.deletePayload(id);
      this.index.clear();
    }
    const out: AssetRecord[] = [];
    for (const a of bundle.assets ?? []) {
      const id = this.mintId();
      const ts = this.now();
      const rec: AssetRecord = { ...a, id, version: 1, createdAt: ts, updatedAt: ts };
      await this.backend.savePayload(id, rec.payload);
      this._putEnvelope(rec);
      out.push(rec);
    }
    await this._flushIndex();
    return out;
  }

  private _putEnvelope(rec: AssetRecord): void {
    const { payload: _omit, ...envelope } = rec;
    this.index.set(rec.id, envelope as AssetIndexEntry);
  }
  private async _flushIndex(): Promise<void> {
    await this.backend.saveIndex([...this.index.values()].map((e) => ({ ...e })));
  }
}
