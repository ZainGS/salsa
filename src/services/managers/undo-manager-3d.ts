/**
 * UndoManager3D — Closure-based command stack for 3D scene edits.
 *
 * Each command is a plain `{ undo, redo, description }` object. Callers
 * construct commands with closures that capture the mesh references or state
 * needed to reverse the operation. No context injection required.
 *
 * Memory note: delete-mesh commands keep the Mesh3D node and its GPU buffers
 * alive via closure until the command is evicted at maxDepth. This is intentional
 * (enables undo without re-uploading geometry) and bounds GPU retention to at most
 * maxDepth deleted meshes. This stack is independent from the raster snapshot undo
 * stack — there is no unified budget between them.
 *
 * Usage:
 *   undoManager.push({
 *     description: 'Move mesh',
 *     undo: () => mesh.setPosition3D(before.x, before.y, before.z),
 *     redo: () => mesh.setPosition3D(after.x, after.y, after.z),
 *   });
 *   undoManager.undo();  // calls undo()
 *   undoManager.redo();  // calls redo()
 */

export interface Command3D {
  description: string;
  undo(): void;
  redo(): void;
}

export class UndoManager3D {
  private _stack: Command3D[] = [];
  /** Points to the last executed command, or -1 when nothing undoable. */
  private _pointer = -1;
  private readonly _maxDepth: number;

  constructor(maxDepth = 50) {
    this._maxDepth = maxDepth;
  }

  // ── State ──────────────────────────────────────────────────────

  get canUndo(): boolean { return this._pointer >= 0; }
  get canRedo(): boolean { return this._pointer < this._stack.length - 1; }
  get stackSize(): number { return this._stack.length; }
  /** Description of the action that would be undone next, or null. */
  get undoDescription(): string | null { return this._pointer >= 0 ? this._stack[this._pointer].description : null; }
  /** Description of the action that would be redone next, or null. */
  get redoDescription(): string | null {
    return this._pointer < this._stack.length - 1 ? this._stack[this._pointer + 1].description : null;
  }

  // ── Stack operations ───────────────────────────────────────────

  /**
   * Push a command onto the stack (truncates any redo history above the
   * current pointer, then appends). Does NOT call command.redo() — the
   * caller is assumed to have already applied the change.
   */
  push(cmd: Command3D): void {
    // Truncate redo history
    this._stack = this._stack.slice(0, this._pointer + 1);
    this._stack.push(cmd);
    // Evict oldest entry if over depth limit
    if (this._stack.length > this._maxDepth) {
      this._stack.shift();
    } else {
      this._pointer++;
    }
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    this._stack[this._pointer].undo();
    this._pointer--;
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    this._pointer++;
    this._stack[this._pointer].redo();
    return true;
  }

  clear(): void {
    this._stack = [];
    this._pointer = -1;
  }
}
