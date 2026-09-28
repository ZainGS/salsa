/**
 * src/services/scripting/script-types.ts
 *
 * Data model + contracts for Script Behaviors (docs/specs/script-behaviors.md) — custom per-object game logic
 * authored in TypeScript, run as JavaScript, Play-mode only. These are pure types + interfaces (no engine, no GPU);
 * the compiler (script-compiler.ts), the ScriptContext factory (script-context.ts) and the manager
 * (script-behavior-manager.ts) build on them. The ScriptContext is the STABLE, curated contract user scripts see —
 * grow it deliberately (every verb is a permanent promise), never expose raw ShapeManager.
 */

export type Vec3 = [number, number, number];

/** A behavior script attached to one scene node. Stored in a manager map keyed by nodeId (NOT baked into the
 *  node's toJSON), so a script can outlive/reference a node that regenerates. `source` is the TS/JS text. */
export interface ScriptBehavior {
  nodeId: string;
  source: string;
  enabled: boolean;
  name?: string;
}

/** Player-input snapshot a script can read this tick (for player-controlled behaviors). */
export interface ScriptInput {
  forward: number;   // -1..1
  right: number;     // -1..1
  jump: boolean;
  lookYaw: number;
  lookPitch: number;
  interact: boolean;
}

/** An opaque handle to another node — a thin wrapper so scripts never touch engine internals. */
export interface NodeHandle {
  readonly id: string;
  pos(): Vec3 | null;
  setPos(x: number, y: number, z: number): void;
}

/** A trigger-volume enter/exit event routed to onTrigger. */
export interface ScriptTriggerEvent {
  type: 'enter' | 'exit';
  id: string;   // the trigger volume / other node id
}

/**
 * The curated API a script receives (`ctx`). THE forever-contract — intentionally small (~25 verbs). Every method
 * wraps something that already exists in the engine, surfaced through a {@link ScriptSceneAdapter} so this layer stays
 * pure and unit-testable against a mock scene.
 */
export interface ScriptContext {
  // identity
  readonly id: string;               // this behavior's node id
  readonly playerId: string | null;  // the bound Player avatar, if any

  // transform (self)
  pos(): Vec3;
  setPos(x: number, y: number, z: number): void;
  move(dx: number, dy: number, dz: number): void;        // world-space delta
  moveLocal(dx: number, dy: number, dz: number): void;   // relative to own yaw (local +Z = forward)
  rotateY(rad: number): void;
  setYaw(rad: number): void;
  lookAt(x: number, y: number, z: number): void;

  // animation (via the Animation Library / skeleton)
  play(clip: string, opts?: { loop?: boolean; blend?: number }): void;
  stop(): void;

  // scene queries
  find(id: string): NodeHandle | null;
  posOf(id: string): Vec3 | null;
  distanceTo(id: string): number | null;
  raycast(origin: Vec3, dir: Vec3, maxDist?: number): { id: string; point: Vec3 } | null;

  // spawn / destroy (v1: clone an existing node as a template)
  spawn(templateId: string, pos: Vec3): string | null;
  destroy(id: string): void;

  // variables — SHARED with the UI state machine (scripts + flow compose)
  getVar(name: string): number | string | boolean | null;
  setVar(name: string, v: number | string | boolean): void;

  // input (for player-controlled scripts)
  readonly input: ScriptInput;

  // events (fires an emitEvent-style signal into the UI machine)
  emit(event: string): void;

  // time / util
  readonly time: number;   // seconds since Play start
  readonly dt: number;     // last tick seconds (also passed to onTick)
}

/** The lifecycle hooks a compiled script may define. All optional; `this` inside each is a fresh per-instance state
 *  bag (created per scripted node per Play run). */
export interface CompiledScript {
  onStart?: (ctx: ScriptContext) => void;
  onTick?: (ctx: ScriptContext, dt: number) => void;
  onTrigger?: (ctx: ScriptContext, e: ScriptTriggerEvent) => void;
  onInteract?: (ctx: ScriptContext) => void;
}

/**
 * The seam between the pure ScriptContext and the real engine. S1 tests pass a mock; S2 wires a ShapeManager-backed
 * implementation. Primitives only — the ScriptContext factory layers the math (move/moveLocal/lookAt/distanceTo) on
 * top so those stay generic and testable.
 *
 * ★ Convention: yaw is rotation about +Y; a node's LOCAL FORWARD is +Z, i.e. world forward = (sin yaw, 0, cos yaw).
 * The S2 adapter must make getYaw/setYaw agree with the engine's forward, or moveLocal/lookAt will point the wrong way.
 */
export interface ScriptSceneAdapter {
  playerId(): string | null;
  getPos(id: string): Vec3 | null;
  setPos(id: string, x: number, y: number, z: number): void;
  getYaw(id: string): number;                 // radians; 0 if unknown
  setYaw(id: string, rad: number): void;
  play(id: string, clip: string, opts?: { loop?: boolean; blend?: number }): void;
  stop(id: string): void;
  exists(id: string): boolean;
  raycast(origin: Vec3, dir: Vec3, maxDist?: number): { id: string; point: Vec3 } | null;
  spawn(templateId: string, pos: Vec3): string | null;
  destroy(id: string): void;
  getVar(name: string): number | string | boolean | null;
  setVar(name: string, v: number | string | boolean): void;
  input(): ScriptInput;
  emit(event: string): void;
  now(): number;   // seconds since Play start
}
