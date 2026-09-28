/**
 * src/services/scripting/script-compiler.ts
 *
 * Compiles a Script Behavior's source (TS or JS) into callable {@link CompiledScript} hooks (docs/specs/script-behaviors.md §2.2).
 *   1. sucrase strips TS types + converts ESM export/import → CommonJS (tiny, pure-JS, ~ms — no wasm, no full tsc).
 *   2. `new Function(...)` builds a factory that, when run, yields the module's exports.
 *   3. We collect onStart/onTick/onTrigger/onInteract from `exports` OR from top-level function declarations (so both
 *      `export function onTick(){}` and a bare `function onTick(){}` work).
 * Results are cached by source text (recompiling the same source is free). Errors — at transpile, wrap-build, or
 * MODULE-EVALUATION (top-level) time — are captured and returned, never thrown to the caller. (Per-hook RUNTIME error
 * isolation happens in the Play runner, S2.)
 *
 * Per-instance state: the compiled hook functions are shared/stateless; the runner calls them with `.call(stateBag, …)`
 * so `this` is a fresh per-node state object each Play run.
 */

import { transform } from 'sucrase';
import type { CompiledScript } from './script-types';

export interface CompileError {
  message: string;
  line?: number;
}

export interface CompileResult {
  ok: boolean;
  script?: CompiledScript;
  error?: CompileError;
}

/** Scripts get a curated `ctx`, never module imports — so `require`/`import` are hard-disabled. */
function forbiddenRequire(): never {
  throw new Error('imports are not allowed in scripts — everything is on the ctx argument');
}

const HOOK_NAMES = ['onStart', 'onTick', 'onTrigger', 'onInteract'] as const;

export class ScriptCompiler {
  /** Keyed by raw source text (Map key equality) — recompiling identical source is a cache hit. */
  private _cache = new Map<string, CompileResult>();

  /** Compile (cached). Never throws — failures come back as `{ ok: false, error }`. */
  compile(source: string): CompileResult {
    const hit = this._cache.get(source);
    if (hit) return hit;
    const res = this._compileUncached(source);
    this._cache.set(source, res);
    return res;
  }

  /** Drop the compile cache (e.g. on document load). */
  clearCache(): void {
    this._cache.clear();
  }

  private _compileUncached(source: string): CompileResult {
    // 1. TS → JS (+ ESM → CJS so `export function` becomes `exports.x`).
    let js: string;
    try {
      js = transform(source, { transforms: ['typescript', 'imports'] }).code;
    } catch (e) {
      return { ok: false, error: toCompileError(e) };
    }

    // 2. Append a collector that prefers `exports.<hook>` but falls back to a top-level function of that name.
    //    `typeof <name>` is safe (returns "undefined" without throwing) even in strict mode when undeclared.
    const collector =
      '\n;return {' +
      HOOK_NAMES.map(
        (h) => `${h}:(exports&&exports.${h})||(typeof ${h}!=="undefined"?${h}:undefined)`,
      ).join(',') +
      '};';

    // 3. Build the factory. `exports`/`require`/`module` are provided so the CJS output resolves.
    let factory: (exports: Record<string, unknown>, require: () => never, module: unknown) => Record<string, unknown>;
    try {
      factory = new Function('exports', 'require', 'module', js + collector) as typeof factory;
    } catch (e) {
      return { ok: false, error: toCompileError(e) };
    }

    // 4. Run the factory (executes top-level script code once) and pull the hooks.
    let hooks: Record<string, unknown>;
    try {
      const exportsObj: Record<string, unknown> = {};
      hooks = factory(exportsObj, forbiddenRequire, { exports: exportsObj });
    } catch (e) {
      return { ok: false, error: toCompileError(e) };
    }

    const script: CompiledScript = {};
    for (const h of HOOK_NAMES) {
      const fn = hooks[h];
      if (typeof fn === 'function') (script as Record<string, unknown>)[h] = fn;
    }
    return { ok: true, script };
  }
}

/** Normalize any thrown value into a CompileError, extracting a line number from a `(line:col)` suffix if present. */
function toCompileError(e: unknown): CompileError {
  const message = e instanceof Error ? e.message : String(e);
  const m = /\((\d+):\d+\)/.exec(message);
  return m ? { message, line: Number(m[1]) } : { message };
}
