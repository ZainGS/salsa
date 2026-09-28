/**
 * src/services/scripting/script-runner.ts
 *
 * Drives Script Behaviors during Play (docs/specs/script-behaviors.md §2.4). On start it compiles each ENABLED
 * behavior, gives it a fresh per-instance state bag (`this`) + a {@link ScriptContext}, and calls `onStart`. Each fixed
 * tick it calls `onTick(ctx, dt)`; trigger-volume + interact events route to `onTrigger`/`onInteract` on the matching
 * node. `stop()` drops every instance (transforms revert via the Play snapshot — no work here).
 *
 * ★ Error isolation: every hook call is try/caught. A behavior that throws `maxStrikes` times is DISABLED for the rest
 * of the run (a bad script never crashes the loop or the editor); each throw is surfaced via `onError`. Kept engine-free
 * (it talks to the scene only through the injected adapter), so it unit-tests without a GPU.
 */

import type { ScriptSceneAdapter, ScriptContext, ScriptTriggerEvent, CompiledScript } from './script-types';
import type { ScriptCompiler } from './script-compiler';
import type { ScriptBehaviorManager } from './script-behavior-manager';
import { createScriptContext } from './script-context';

type HookName = 'compile' | 'onStart' | 'onTick' | 'onTrigger' | 'onInteract';

export interface ScriptRunnerOptions {
  /** Surfaced on any compile error or thrown hook (host logs it / shows it on the node). */
  onError?: (nodeId: string, hook: HookName, err: unknown) => void;
  /** Total throws before a behavior is disabled for the rest of the run. Default 3. */
  maxStrikes?: number;
}

interface ScriptInstance {
  nodeId: string;
  script: CompiledScript;
  state: Record<string, unknown>;   // the per-instance `this`
  ctx: ScriptContext;
  strikes: number;
  disabled: boolean;
}

export class ScriptRunner {
  private _instances: ScriptInstance[] = [];
  private _dt = 0;
  private _running = false;

  constructor(
    private readonly _compiler: ScriptCompiler,
    private readonly _manager: ScriptBehaviorManager,
    private readonly _adapter: ScriptSceneAdapter,
    private readonly _opts: ScriptRunnerOptions = {},
  ) {}

  get running(): boolean { return this._running; }
  /** Number of live (non-disabled) instances — for tests/inspection. */
  get activeCount(): number { return this._instances.filter((i) => !i.disabled).length; }

  /** Compile + instantiate every enabled behavior, then call onStart. Safe to call with zero behaviors (no-op run). */
  start(): void {
    this._instances = [];
    for (const b of this._manager.listEnabled()) {
      const res = this._compiler.compile(b.source);
      if (!res.ok || !res.script) { this._opts.onError?.(b.nodeId, 'compile', res.error); continue; }
      this._instances.push({
        nodeId: b.nodeId,
        script: res.script,
        state: {},
        ctx: createScriptContext(b.nodeId, this._adapter, () => this._dt),
        strikes: 0,
        disabled: false,
      });
    }
    this._running = true;
    for (const inst of this._instances) {
      this._invoke(inst, 'onStart', (s) => s.onStart?.call(inst.state, inst.ctx));
    }
  }

  /** Advance every live behavior one fixed step. */
  tick(dt: number): void {
    if (!this._running) return;
    this._dt = dt;
    for (const inst of this._instances) {
      if (inst.disabled) continue;
      this._invoke(inst, 'onTick', (s) => s.onTick?.call(inst.state, inst.ctx, dt));
    }
  }

  /** Route a trigger-volume enter/exit to the script attached to the node whose id matches the volume. */
  fireTrigger(nodeId: string, e: ScriptTriggerEvent): void {
    const inst = this._live(nodeId);
    if (inst) this._invoke(inst, 'onTrigger', (s) => s.onTrigger?.call(inst.state, inst.ctx, e));
  }

  /** Route a "use" to the script on the interacted node. */
  fireInteract(nodeId: string): void {
    const inst = this._live(nodeId);
    if (inst) this._invoke(inst, 'onInteract', (s) => s.onInteract?.call(inst.state, inst.ctx));
  }

  /** End the run — drop all instances (Play snapshot reverts transforms separately). */
  stop(): void {
    this._running = false;
    this._instances = [];
    this._dt = 0;
  }

  private _live(nodeId: string): ScriptInstance | undefined {
    return this._instances.find((i) => i.nodeId === nodeId && !i.disabled);
  }

  private _invoke(inst: ScriptInstance, hook: HookName, call: (s: CompiledScript) => void): void {
    try {
      call(inst.script);
    } catch (err) {
      inst.strikes++;
      this._opts.onError?.(inst.nodeId, hook, err);
      if (inst.strikes >= (this._opts.maxStrikes ?? 3)) inst.disabled = true;
    }
  }
}
