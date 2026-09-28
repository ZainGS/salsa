import { describe, it, expect, vi } from 'vitest';
import { createScriptContext } from './script-context';
import type { ScriptSceneAdapter, Vec3 } from './script-types';

/** A mock scene: positions/yaws/vars in maps, side-effecting verbs spied. */
function mockAdapter(initPos: Record<string, Vec3> = {}) {
  const pos = new Map<string, Vec3>(Object.entries(initPos));
  const yaw = new Map<string, number>();
  const vars = new Map<string, number | string | boolean>();
  const play = vi.fn(), stop = vi.fn(), spawn = vi.fn((_t: string, p: Vec3) => { pos.set('spawned', p); return 'spawned'; });
  const destroy = vi.fn((id: string) => { pos.delete(id); });
  const emit = vi.fn();
  let now = 0;
  const adapter: ScriptSceneAdapter = {
    playerId: () => 'player',
    getPos: (id) => pos.get(id) ?? null,
    setPos: (id, x, y, z) => { pos.set(id, [x, y, z]); },
    getYaw: (id) => yaw.get(id) ?? 0,
    setYaw: (id, r) => { yaw.set(id, r); },
    play, stop,
    exists: (id) => pos.has(id),
    raycast: vi.fn(() => ({ id: 'hit', point: [1, 2, 3] as Vec3 })),
    spawn, destroy,
    getVar: (n) => vars.get(n) ?? null,
    setVar: (n, v) => { vars.set(n, v); },
    input: () => ({ forward: 1, right: 0, jump: false, lookYaw: 0, lookPitch: 0, interact: false }),
    emit,
    now: () => now,
  };
  return { adapter, pos, yaw, vars, play, stop, spawn, destroy, emit, setNow: (t: number) => { now = t; } };
}

describe('createScriptContext — derived math over adapter primitives', () => {
  it('id / playerId / pos / setPos', () => {
    const m = mockAdapter({ n1: [1, 2, 3] });
    const ctx = createScriptContext('n1', m.adapter, () => 0);
    expect(ctx.id).toBe('n1');
    expect(ctx.playerId).toBe('player');
    expect(ctx.pos()).toEqual([1, 2, 3]);
    ctx.setPos(5, 6, 7);
    expect(m.pos.get('n1')).toEqual([5, 6, 7]);
  });

  it('move applies a world delta', () => {
    const m = mockAdapter({ n1: [0, 0, 0] });
    const ctx = createScriptContext('n1', m.adapter, () => 0);
    ctx.move(1, 2, 3);
    expect(m.pos.get('n1')).toEqual([1, 2, 3]);
  });

  it('moveLocal rotates the delta by yaw (forward = +Z)', () => {
    const m = mockAdapter({ n1: [0, 0, 0] });
    const ctx = createScriptContext('n1', m.adapter, () => 0);
    // yaw 0: forward = +Z
    ctx.moveLocal(0, 0, 1);
    expect(m.pos.get('n1')![0]).toBeCloseTo(0);
    expect(m.pos.get('n1')![2]).toBeCloseTo(1);
    // yaw 90°: forward = +X
    m.pos.set('n1', [0, 0, 0]); m.yaw.set('n1', Math.PI / 2);
    ctx.moveLocal(0, 0, 1);
    expect(m.pos.get('n1')![0]).toBeCloseTo(1);
    expect(m.pos.get('n1')![2]).toBeCloseTo(0);
  });

  it('rotateY accumulates, setYaw sets, lookAt faces a target', () => {
    const m = mockAdapter({ n1: [0, 0, 0] });
    const ctx = createScriptContext('n1', m.adapter, () => 0);
    ctx.rotateY(0.5); ctx.rotateY(0.25);
    expect(m.yaw.get('n1')).toBeCloseTo(0.75);
    ctx.setYaw(1);
    expect(m.yaw.get('n1')).toBe(1);
    ctx.lookAt(1, 0, 0);                 // +X from origin → yaw π/2
    expect(m.yaw.get('n1')).toBeCloseTo(Math.PI / 2);
    // degenerate target (self) leaves yaw unchanged
    ctx.lookAt(0, 5, 0);
    expect(m.yaw.get('n1')).toBeCloseTo(Math.PI / 2);
  });

  it('distanceTo / posOf / find', () => {
    const m = mockAdapter({ n1: [0, 0, 0], n2: [3, 0, 4] });
    const ctx = createScriptContext('n1', m.adapter, () => 0);
    expect(ctx.distanceTo('n2')).toBeCloseTo(5);
    expect(ctx.distanceTo('ghost')).toBeNull();
    expect(ctx.posOf('n2')).toEqual([3, 0, 4]);
    const h = ctx.find('n2')!;
    expect(h.id).toBe('n2');
    expect(h.pos()).toEqual([3, 0, 4]);
    h.setPos(9, 9, 9);
    expect(m.pos.get('n2')).toEqual([9, 9, 9]);
    expect(ctx.find('ghost')).toBeNull();
  });

  it('play/stop/spawn/destroy/raycast/vars/input/emit/time pass through', () => {
    const m = mockAdapter({ n1: [0, 0, 0] });
    let dt = 0.016;
    const ctx = createScriptContext('n1', m.adapter, () => dt);
    ctx.play('walk', { loop: true }); expect(m.play).toHaveBeenCalledWith('n1', 'walk', { loop: true });
    ctx.stop(); expect(m.stop).toHaveBeenCalledWith('n1');
    expect(ctx.spawn('tmpl', [1, 1, 1])).toBe('spawned');
    ctx.destroy('spawned'); expect(m.destroy).toHaveBeenCalledWith('spawned');
    expect(ctx.raycast([0, 0, 0], [0, 0, 1])).toEqual({ id: 'hit', point: [1, 2, 3] });
    ctx.setVar('score', 10); expect(ctx.getVar('score')).toBe(10);
    expect(ctx.input.forward).toBe(1);
    ctx.emit('ping'); expect(m.emit).toHaveBeenCalledWith('ping');
    m.setNow(12.5); expect(ctx.time).toBeCloseTo(12.5);
    expect(ctx.dt).toBe(0.016);
    dt = 0.033; expect(ctx.dt).toBe(0.033);   // dt is live each read
  });
});
