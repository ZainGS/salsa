import { describe, it, expect, beforeEach } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { Scene3DParticles } from './scene3d-particles';
import { SceneGraph } from '../../scene-graph/core/scene-graph';
import type { ManagerContext } from './manager-context';
import type { InteractionService } from '../interaction-service';

// §5.1 extraction pilot: Scene3DParticles depends ONLY on ManagerContext (no GPUDevice, no parent back-reference),
// which is exactly what makes it unit-testable in isolation — the payoff the god-object decomposition is chasing.
// We drive it with a mock ctx that records the render-scheduling + pre-render-callback traffic, and assert the
// emitter map + tick lifecycle directly. (A 15k-line manager cannot be tested this way; a 100-line subsystem can.)

function makeCtx() {
  const preRenderCbs = new Set<() => boolean>();
  const calls = { scheduleRender: 0, emitChanged: 0 };
  const sceneGraph = new SceneGraph();
  const ctx = {
    sceneGraph,
    interactionService: { maxGlobalZIndex: 0 } as unknown as InteractionService,
    webgpuRenderer: {
      addPreRenderCallback: (cb: () => boolean) => { preRenderCbs.add(cb); },
      removePreRenderCallback: (cb: () => boolean) => { preRenderCbs.delete(cb); },
    },
    scheduleRender: () => { calls.scheduleRender++; },
    emitSceneGraphChanged: () => { calls.emitChanged++; },
  } as unknown as ManagerContext;
  return { ctx, sceneGraph, preRenderCbs, calls };
}

describe('§5.1 Scene3DParticles (extracted subsystem)', () => {
  let env: ReturnType<typeof makeCtx>;
  let particles: Scene3DParticles;
  beforeEach(() => { env = makeCtx(); particles = new Scene3DParticles(env.ctx); });

  it('add() registers the emitter, attaches it to the scene root, starts one tick, and schedules a render', () => {
    const id = particles.add(1, 2, 3, { emitRate: 42 });
    expect(id).toBeTruthy();
    expect(particles.get(id)).not.toBeNull();
    expect(particles.getAll()).toHaveLength(1);
    expect(env.sceneGraph.root.children).toContain(particles.get(id));   // attached to the graph
    expect(env.preRenderCbs.size).toBe(1);                               // one tick loop running
    expect(env.calls.scheduleRender).toBe(1);
    expect(env.calls.emitChanged).toBe(1);
  });

  it('a second emitter reuses the SAME tick loop (does not stack callbacks)', () => {
    particles.add(0, 0, 0);
    particles.add(0, 1, 0);
    expect(particles.getAll()).toHaveLength(2);
    expect(env.preRenderCbs.size).toBe(1);
  });

  it('setConfig() reaches the underlying emitter', () => {
    const id = particles.add(0, 0, 0, { emitRate: 10 });
    particles.setConfig(id, { emitRate: 99 });
    expect(particles.get(id)!.config.emitRate).toBe(99);
  });

  it('removing the LAST emitter stops the tick loop; removing a non-last does not', () => {
    const a = particles.add(0, 0, 0);
    const b = particles.add(0, 0, 0);
    particles.remove(a);
    expect(particles.getAll()).toHaveLength(1);
    expect(env.preRenderCbs.size).toBe(1);   // still one emitter → tick keeps running
    particles.remove(b);
    expect(particles.getAll()).toHaveLength(0);
    expect(env.preRenderCbs.size).toBe(0);   // last one gone → tick stopped
    expect(env.sceneGraph.root.children).toHaveLength(0);
  });

  it('remove() of an unknown id is a no-op', () => {
    particles.add(0, 0, 0);
    expect(() => particles.remove('nope')).not.toThrow();
    expect(particles.getAll()).toHaveLength(1);
    expect(env.preRenderCbs.size).toBe(1);
  });

  it('the tick callback runs the sim and self-removes only when empty', () => {
    particles.add(0, 0, 0);
    const cb = [...env.preRenderCbs][0];
    expect(cb()).toBe(true);                 // an emitter is active → keep ticking, no throw
    expect(env.preRenderCbs.size).toBe(1);
  });

  it('registerRestored() re-adopts a JSON-restored emitter and starts ticking', () => {
    // Build an emitter via add on a throwaway subsystem, detach, then restore into a fresh one.
    const donor = new Scene3DParticles(env.ctx);
    const id = donor.add(0, 0, 0);
    const emitter = donor.get(id)!;
    donor.remove(id);

    const fresh = makeCtx();
    const p2 = new Scene3DParticles(fresh.ctx);
    p2.registerRestored(emitter);
    expect(p2.get(id)).toBe(emitter);
    expect(fresh.preRenderCbs.size).toBe(1);
  });

  it('dispose() stops the tick and drops all emitters', () => {
    particles.add(0, 0, 0);
    particles.add(0, 0, 0);
    particles.dispose();
    expect(particles.getAll()).toHaveLength(0);
    expect(env.preRenderCbs.size).toBe(0);
  });
});
