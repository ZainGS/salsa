/**
 * asset-reference-store — a document's record of which GLOBAL assets it uses (docs/specs/shared-asset-library.md §2.3, L3).
 *
 * When a document instantiates a global asset, it keeps a provenance link: the document-local object it created + which
 * global asset (+ version) it came from, optionally with an embedded copy for portability. This lets the document
 * report "you're using global asset Y, which now has a newer version" (via `resolveReference`) and stays self-contained.
 * GPU-free + serializable; persisted in `GlobalScene3DSettings.assetReferences` (rides scene3dJSON, like the animation
 * library) and cleared on document load (stale-registry rule).
 */

import type { AssetKind } from './asset-types';
import type { EmbeddedAsset } from './asset-references';

export interface DocumentAssetReference {
  docLocalId: string;        // the object THIS document created from the asset (e.g. the instantiated clip id)
  globalId: string;          // the global asset it came from
  version: number;           // the version this document was authored against
  kind: AssetKind;
  name: string;              // display name, so the panel needn't hit the library
  embedded?: EmbeddedAsset;  // optional portability copy (omitted for kinds that fully instantiate into the doc, e.g. anim)
}

/** Keyed by `docLocalId` — one provenance link per instantiated object. */
export class AssetReferenceStore {
  private refs = new Map<string, DocumentAssetReference>();

  record(ref: DocumentAssetReference): void {
    if (ref?.docLocalId) this.refs.set(ref.docLocalId, { ...ref });
  }
  removeByDocLocalId(docLocalId: string): boolean {
    return this.refs.delete(docLocalId);
  }
  list(): DocumentAssetReference[] {
    return [...this.refs.values()].map((r) => ({ ...r }));
  }
  get size(): number { return this.refs.size; }

  // ── persistence (rides GlobalScene3DSettings.assetReferences) ──
  serialize(): DocumentAssetReference[] { return this.list(); }
  load(data: DocumentAssetReference[] | null | undefined): void {
    this.clearForDocumentLoad();
    for (const r of data ?? []) if (r?.docLocalId) this.refs.set(r.docLocalId, { ...r });
  }
  /** Drop the previous document's links before loading the incoming one (stale-registry rule). */
  clearForDocumentLoad(): void { this.refs.clear(); }
}
