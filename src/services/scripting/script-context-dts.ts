/**
 * src/services/scripting/script-context-dts.ts
 *
 * Two authoring aids the host surfaces (docs/specs/script-behaviors.md §5/§6):
 *   • SCRIPT_CONTEXT_DTS — an ambient `.d.ts` the code editor (Monaco) loads as an extraLib so a script author gets
 *     IntelliSense + type-checking on `ctx` and the lifecycle hooks, with NO imports needed. Returned by
 *     `sm.getScriptContextTypes3D()`.
 *   • SCRIPT_SNIPPETS — starter templates for the "insert snippet" picker (the on-ramp). Each compiles cleanly and only
 *     uses verbs the current runtime actually applies (move/rotate/look/vars/input/emit — NOT play/spawn, which are v1
 *     no-ops). Returned by `sm.getScriptSnippets3D()`.
 *
 * ★ Keep SCRIPT_CONTEXT_DTS in sync with ScriptContext/hook signatures in script-types.ts (a test compiles the snippets
 *   against the real compiler to catch drift in the examples).
 */

export const SCRIPT_CONTEXT_DTS = `
// Salsa Script Behavior API — available globally (no imports). Author in TypeScript; runs as JavaScript, Play-mode only.
// Define any of the lifecycle hooks below (as \`export function\` or a bare \`function\`). Per-instance state lives on
// \`this\` (a fresh object per scripted node per Play run) — e.g. \`this.speed = 2\` in onStart, read it in onTick.

type Vec3 = [number, number, number];

interface ScriptInput {
  /** -1..1 (forward/back intent) */ forward: number;
  /** -1..1 (strafe intent) */ right: number;
  jump: boolean;
  lookYaw: number;
  lookPitch: number;
  interact: boolean;
}

interface NodeHandle {
  readonly id: string;
  pos(): Vec3 | null;
  setPos(x: number, y: number, z: number): void;
}

interface ScriptTriggerEvent { type: 'enter' | 'exit'; id: string; }

/** The API every hook receives as its first argument. */
interface ScriptContext {
  /** This behavior's own node id. */ readonly id: string;
  /** The bound Player avatar's id, or null. */ readonly playerId: string | null;

  /** World position of this node. */ pos(): Vec3;
  setPos(x: number, y: number, z: number): void;
  /** Move by a WORLD-space delta. */ move(dx: number, dy: number, dz: number): void;
  /** Move relative to this node's facing (local +Z = forward). */ moveLocal(dx: number, dy: number, dz: number): void;
  /** Turn by an angle (radians) about +Y. */ rotateY(rad: number): void;
  setYaw(rad: number): void;
  /** Face a world point. */ lookAt(x: number, y: number, z: number): void;

  /** Play a clip on this node's skeleton. (Not yet applied in v1 — drive clips via the UI machine for now.) */
  play(clip: string, opts?: { loop?: boolean; blend?: number }): void;
  stop(): void;

  /** A handle to another node by id, or null if it doesn't exist. */ find(id: string): NodeHandle | null;
  posOf(id: string): Vec3 | null;
  /** Distance from this node to another, or null if either is missing. */ distanceTo(id: string): number | null;
  raycast(origin: Vec3, dir: Vec3, maxDist?: number): { id: string; point: Vec3 } | null;

  /** Spawn a clone of a template node. (Not yet applied in v1 — returns null.) */
  spawn(templateId: string, pos: Vec3): string | null;
  /** Remove a node from play (hidden; restored when Play stops). */ destroy(id: string): void;

  /** Read a shared variable (also settable by the UI state machine). */
  getVar(name: string): number | string | boolean | null;
  /** Set a shared variable (a UI-machine transition can react to it). */
  setVar(name: string, v: number | string | boolean): void;

  /** This tick's player input. */ readonly input: ScriptInput;
  /** Fire a custom event the host/UI can listen for. */ emit(event: string): void;

  /** Seconds since Play started. */ readonly time: number;
  /** Last tick length in seconds (same value passed to onTick). */ readonly dt: number;
}

/** Runs once when Play starts (set up \`this\` state here). */
declare function onStart(ctx: ScriptContext): void;
/** Runs every fixed tick. \`dt\` = step in seconds. */
declare function onTick(ctx: ScriptContext, dt: number): void;
/** A trigger volume named after this node fired. */
declare function onTrigger(ctx: ScriptContext, e: ScriptTriggerEvent): void;
/** The player "used" this node. */
declare function onInteract(ctx: ScriptContext): void;
`.trim();

export interface ScriptSnippet {
  name: string;
  description: string;
  source: string;
}

/** Starter behaviors for the editor's snippet picker. Each compiles clean and uses only applied verbs. */
export const SCRIPT_SNIPPETS: ScriptSnippet[] = [
  {
    name: 'Spinner',
    description: 'Rotates the object continuously about its up axis.',
    source: `export function onStart(ctx) { this.speed = 1.5; }   // radians/sec
export function onTick(ctx, dt) { ctx.rotateY(this.speed * dt); }`,
  },
  {
    name: 'Patrol (ping-pong)',
    description: 'Walks forward, flips direction at a distance, loops.',
    source: `export function onStart(ctx) {
  this.speed = 2; this.dir = 1; this.travelled = 0; this.range = 5;
}
export function onTick(ctx, dt) {
  const step = this.speed * dt * this.dir;
  ctx.moveLocal(0, 0, step);
  this.travelled += Math.abs(step);
  if (this.travelled >= this.range) { this.dir *= -1; this.travelled = 0; ctx.rotateY(Math.PI); }
}`,
  },
  {
    name: 'Follow player',
    description: 'Faces the player and walks toward them until close.',
    source: `export function onStart(ctx) { this.speed = 2.5; this.stopAt = 1.5; }
export function onTick(ctx, dt) {
  if (!ctx.playerId) return;
  const p = ctx.posOf(ctx.playerId);
  if (!p) return;
  ctx.lookAt(p[0], p[1], p[2]);
  const d = ctx.distanceTo(ctx.playerId);
  if (d !== null && d > this.stopAt) ctx.moveLocal(0, 0, this.speed * dt);
}`,
  },
  {
    name: 'Proximity switch',
    description: 'Sets a shared variable + emits when the player gets close (drive a UI transition off it).',
    source: `export function onStart(ctx) { this.radius = 3; this.near = false; }
export function onTick(ctx) {
  if (!ctx.playerId) return;
  const d = ctx.distanceTo(ctx.playerId);
  const near = d !== null && d < this.radius;
  if (near !== this.near) {
    this.near = near;
    ctx.setVar('playerNear', near);
    if (near) ctx.emit('playerApproached');
  }
}`,
  },
  {
    name: 'Interactable counter',
    description: 'Counts how many times the player uses this object.',
    source: `export function onStart(ctx) { this.count = 0; }
export function onInteract(ctx) {
  this.count += 1;
  ctx.setVar('usedCount', this.count);
  ctx.emit('used');
}`,
  },
];
