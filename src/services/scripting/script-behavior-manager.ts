/**
 * src/services/scripting/script-behavior-manager.ts
 *
 * Owns the set of {@link ScriptBehavior}s, keyed by nodeId (docs/specs/script-behaviors.md §2.1). Pure state container:
 * attach/replace/get/remove/enable/list + serialize/restore for persistence (S3 rides these into
 * GlobalScene3DSettings.scriptBehaviors). Does NOT run scripts or compile them — the Play runner (S2) reads `list()`
 * and drives the enabled ones through the compiler + ScriptContext. Kept engine-free so it unit-tests without a scene.
 */

import type { ScriptBehavior } from './script-types';

export interface SetScriptOptions {
  enabled?: boolean;
  name?: string;
}

export class ScriptBehaviorManager {
  private _map = new Map<string, ScriptBehavior>();

  /** Attach or replace the behavior on a node. Preserves the prior `enabled`/`name` unless overridden. Enabled
   *  defaults to true for a brand-new behavior. */
  set(nodeId: string, source: string, opts: SetScriptOptions = {}): ScriptBehavior {
    const prev = this._map.get(nodeId);
    const behavior: ScriptBehavior = {
      nodeId,
      source,
      enabled: opts.enabled ?? prev?.enabled ?? true,
      name: opts.name ?? prev?.name,
    };
    this._map.set(nodeId, behavior);
    return behavior;
  }

  get(nodeId: string): ScriptBehavior | null {
    return this._map.get(nodeId) ?? null;
  }

  has(nodeId: string): boolean {
    return this._map.has(nodeId);
  }

  /** Remove a node's behavior. Returns true if one existed. */
  remove(nodeId: string): boolean {
    return this._map.delete(nodeId);
  }

  /** Toggle without deleting. No-op if the node has no behavior. Returns true if it applied. */
  setEnabled(nodeId: string, enabled: boolean): boolean {
    const b = this._map.get(nodeId);
    if (!b) return false;
    b.enabled = enabled;
    return true;
  }

  /** All behaviors (insertion order). */
  list(): ScriptBehavior[] {
    return [...this._map.values()];
  }

  /** Only the enabled behaviors — what the Play runner instantiates. */
  listEnabled(): ScriptBehavior[] {
    return [...this._map.values()].filter((b) => b.enabled);
  }

  get size(): number {
    return this._map.size;
  }

  /** Drop everything (clear-on-load, per the stale-registry rule). */
  clear(): void {
    this._map.clear();
  }

  /** Snapshot for persistence — plain, diffable ScriptBehavior objects. */
  serialize(): ScriptBehavior[] {
    return this.list().map((b) => ({ ...b }));
  }

  /** Replace all behaviors from a persisted set (clears first). Skips malformed entries defensively. */
  restore(behaviors: ScriptBehavior[] | undefined | null): void {
    this.clear();
    if (!behaviors) return;
    for (const b of behaviors) {
      if (!b || typeof b.nodeId !== 'string' || typeof b.source !== 'string') continue;
      this._map.set(b.nodeId, {
        nodeId: b.nodeId,
        source: b.source,
        enabled: b.enabled !== false,   // default true
        name: b.name,
      });
    }
  }
}
