/**
 * Scene3DModifiers — the CPU geometry-modifier stack subsystem, extracted from Scene3DManager.
 *
 * These operate on Mesh3D.modifiers (CPU geometry transforms applied before GPU upload) — distinct from the
 * EditMesh modifier stack (meshEdit.addMirrorModifier etc.) which only works on edit-mode meshes and modifies
 * the EditMesh topology in place.
 *
 * All state lives on the Mesh3D itself (`mesh.modifiers`), so this subsystem holds no map of its own: it only
 * needs the shared `ManagerContext` (for scheduleRender) plus a narrow host to resolve a mesh by id and to push
 * undo entries. Scene3DManager keeps thin delegating methods so the public API and every caller are unchanged.
 */

import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Modifier } from '../../scene-graph/shapes/modifiers';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';

/** Narrow host surface — everything Scene3DModifiers needs from the parent manager beyond the shared ctx. */
export interface Scene3DModifiersHost {
  getMesh(id: string): Mesh3D | null;
  pushUndo(cmd: Command3D): void;
}

export class Scene3DModifiers {
  constructor(
    private readonly ctx: ManagerContext,
    private readonly host: Scene3DModifiersHost,
  ) {}

  /** Append a geometry modifier to any Mesh3D's modifier stack. Pushes undo. */
  add(meshId: string, mod: Modifier): void {
    const mesh = this.host.getMesh(meshId);
    if (!mesh) return;
    mesh.modifiers.push(mod);
    mesh.invalidateModifierCache();
    this.ctx.scheduleRender();
    const idx = mesh.modifiers.length - 1;
    this.host.pushUndo({
      description: 'Add geometry modifier',
      undo: () => { mesh.modifiers.splice(idx, 1); mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
      redo: () => { mesh.modifiers.push(mod); mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
    });
  }

  /** Remove the geometry modifier at `index` from the mesh's stack. Pushes undo. */
  remove(meshId: string, index: number): void {
    const mesh = this.host.getMesh(meshId);
    if (!mesh || index < 0 || index >= mesh.modifiers.length) return;
    const removed = mesh.modifiers[index];
    mesh.modifiers.splice(index, 1);
    mesh.invalidateModifierCache();
    this.ctx.scheduleRender();
    this.host.pushUndo({
      description: 'Remove geometry modifier',
      undo: () => { mesh.modifiers.splice(index, 0, removed); mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
      redo: () => { mesh.modifiers.splice(index, 1); mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
    });
  }

  /** Merge `partial` fields into the geometry modifier at `index`. Pushes undo. */
  update(meshId: string, index: number, partial: Partial<Modifier>): void {
    const mesh = this.host.getMesh(meshId);
    if (!mesh || index < 0 || index >= mesh.modifiers.length) return;
    const before = { ...mesh.modifiers[index] };
    Object.assign(mesh.modifiers[index], partial);
    mesh.invalidateModifierCache();
    this.ctx.scheduleRender();
    const after = { ...mesh.modifiers[index] };
    this.host.pushUndo({
      description: 'Update geometry modifier',
      undo: () => { mesh.modifiers[index] = before as Modifier; mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
      redo: () => { mesh.modifiers[index] = after as Modifier; mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
    });
  }

  /** Return a snapshot of the mesh's geometry modifier stack. */
  list(meshId: string): Modifier[] {
    const mesh = this.host.getMesh(meshId);
    return mesh ? [...mesh.modifiers] : [];
  }
}
