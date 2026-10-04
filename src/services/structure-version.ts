/**
 * Scene STRUCTURE version with coalesced bumps (engine-roadmap step 2; performance-plan.md §P13 "Step 2").
 *
 * Many caches key on the scene's structure version (getAllMeshes, getAllSkeletons, the array-group sync list, the
 * collision set, the sim-LOD body map, the character skeleton list …): when it changes they re-walk the scene graph.
 * A crowd cell build and a live-crowd promotion can notify several times in one frame. With COALESCING, bumps only
 * mark the version stale and the next read advances it by one: any number of notifications between two reads cost
 * one re-walk per cache, and a reader still sees a new value after any change since its previous read (so no cache
 * can miss one). `coalesce = false` = the old counter (every bump increments).
 */
export class StructureVersion {
  coalesce = true;
  private _v = 0;
  private _pending = false;
  /** Bumps since construction (diagnostics: notifications, not reads). */
  bumps = 0;
  bump(): void {
    this.bumps++;
    if (this.coalesce) this._pending = true;
    else this._v++;
  }
  /** The version a cache compares against (applies a pending bump). */
  read(): number {
    if (this._pending) { this._pending = false; this._v++; }
    return this._v;
  }
  /** The version without applying a pending bump (diagnostics). */
  peek(): number { return this._v; }
}
