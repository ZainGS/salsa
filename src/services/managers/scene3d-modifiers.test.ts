import { describe, it, expect, beforeEach } from 'vitest';

import { Scene3DModifiers, type Scene3DModifiersHost } from './scene3d-modifiers';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Modifier } from '../../scene-graph/shapes/modifiers';
import type { Command3D } from './undo-manager-3d';
import type { ManagerContext } from './manager-context';

// §5.1 extraction: Scene3DModifiers keeps NO state of its own — the modifier list lives on Mesh3D.modifiers.
// So the mock only needs a mesh stub (modifiers array + invalidateModifierCache spy) and captured undo/render
// traffic. This is the whole point of the decomposition: a stack + its undo semantics tested without a device.

function makeEnv() {
  const calls = { render: 0, invalidate: 0 };
  const undoStack: Command3D[] = [];
  const mesh = {
    modifiers: [] as Modifier[],
    invalidateModifierCache: () => { calls.invalidate++; },
  } as unknown as Mesh3D;
  const ctx = { scheduleRender: () => { calls.render++; } } as unknown as ManagerContext;
  const host: Scene3DModifiersHost = {
    getMesh: (id) => (id === 'm1' ? mesh : null),
    pushUndo: (cmd) => { undoStack.push(cmd); },
  };
  const mods = new Scene3DModifiers(ctx, host);
  return { mods, mesh, calls, undoStack };
}

const mkMod = (label: string): Modifier => ({ type: 'bend' } as unknown as Modifier & { _label: string });

describe('§5.1 Scene3DModifiers (extracted subsystem)', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });

  it('add() pushes onto the mesh stack, invalidates cache, schedules a render, and records undo', () => {
    const mod = mkMod('a');
    env.mods.add('m1', mod);
    expect(env.mesh.modifiers).toEqual([mod]);
    expect(env.calls.invalidate).toBe(1);
    expect(env.calls.render).toBe(1);
    expect(env.undoStack).toHaveLength(1);
    expect(env.undoStack[0].description).toBe('Add geometry modifier');
  });

  it('add() undo removes exactly the appended modifier; redo re-adds it', () => {
    const a = mkMod('a'), b = mkMod('b');
    env.mods.add('m1', a);
    env.mods.add('m1', b);
    const cmd = env.undoStack[1];         // undo for the SECOND add
    cmd.undo();
    expect(env.mesh.modifiers).toEqual([a]);
    cmd.redo();
    expect(env.mesh.modifiers).toEqual([a, b]);
  });

  it('add() on an unknown mesh is a no-op (no undo, no render)', () => {
    env.mods.add('nope', mkMod('a'));
    expect(env.undoStack).toHaveLength(0);
    expect(env.calls.render).toBe(0);
  });

  it('remove() drops the modifier at index; undo restores it at the same position', () => {
    const a = mkMod('a'), b = mkMod('b'), c = mkMod('c');
    env.mesh.modifiers.push(a, b, c);
    env.mods.remove('m1', 1);
    expect(env.mesh.modifiers).toEqual([a, c]);
    env.undoStack[0].undo();
    expect(env.mesh.modifiers).toEqual([a, b, c]);
  });

  it('remove() with an out-of-range index is a no-op', () => {
    env.mesh.modifiers.push(mkMod('a'));
    env.mods.remove('m1', 5);
    env.mods.remove('m1', -1);
    expect(env.mesh.modifiers).toHaveLength(1);
    expect(env.undoStack).toHaveLength(0);
  });

  it('update() merges partial fields; undo/redo swap the whole entry back and forth', () => {
    const a = { type: 'bend', angle: 10 } as unknown as Modifier;
    env.mesh.modifiers.push(a);
    env.mods.update('m1', 0, { angle: 90 } as Partial<Modifier>);
    expect((env.mesh.modifiers[0] as unknown as { angle: number }).angle).toBe(90);
    env.undoStack[0].undo();
    expect((env.mesh.modifiers[0] as unknown as { angle: number }).angle).toBe(10);
    env.undoStack[0].redo();
    expect((env.mesh.modifiers[0] as unknown as { angle: number }).angle).toBe(90);
  });

  it('list() returns a COPY of the stack (mutating the result does not touch the mesh)', () => {
    env.mesh.modifiers.push(mkMod('a'));
    const snap = env.mods.list('m1');
    snap.push(mkMod('b'));
    expect(env.mesh.modifiers).toHaveLength(1);   // original untouched
    expect(env.mods.list('nope')).toEqual([]);    // unknown mesh → empty
  });
});
