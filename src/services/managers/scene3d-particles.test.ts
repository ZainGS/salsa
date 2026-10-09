import { describe, it, expect, beforeEach } from 'vitest';

// Node test env: Shape.id uses self.crypto.randomUUID (browser globals). Provide both.
import { webcrypto } from 'node:crypto';
const g = globalThis as { self?: unknown; crypto?: unknown };
g.self ??= globalThis;
g.crypto ??= webcrypto;
(g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { Scene3DParticles, DELETE_PARTICLE_EMITTER_UNDO } from './scene3d-particles';
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

  it('an emitter saves its visibility, and one restored from an older save (no visible) comes back visible', () => {
    const id = particles.add(0, 0, 0);
    const emitter = particles.get(id)!;
    emitter.visible = false;
    expect(emitter.toJSON().visible).toBe(false);

    (emitter as { visible: unknown }).visible = undefined;   // what the loader assigns from a save without the field
    const p2 = new Scene3DParticles(makeCtx().ctx);
    p2.registerRestored(emitter);
    expect(emitter.visible).toBe(true);
  });

  it('remove() with an undo stack records ONE step: undo brings the same emitter back (graph + tick), redo removes it again', () => {
    const steps: Array<{ description: string; undo(): void; redo(): void }> = [];
    const p = new Scene3DParticles(env.ctx, (cmd) => steps.push(cmd));
    const id = p.add(1, 2, 3, { emitRate: 7 });
    const emitter = p.get(id)!;
    p.remove(id);
    expect(steps).toHaveLength(1);
    expect(steps[0].description).toBe(DELETE_PARTICLE_EMITTER_UNDO);
    expect(p.get(id)).toBeNull();
    expect(env.preRenderCbs.size).toBe(0);

    steps[0].undo();
    expect(p.get(id)).toBe(emitter);
    expect(env.sceneGraph.root.children).toContain(emitter);
    expect(emitter.config.emitRate).toBe(7);
    expect(env.preRenderCbs.size).toBe(1);

    steps[0].redo();
    expect(p.get(id)).toBeNull();
    expect(env.sceneGraph.root.children).not.toContain(emitter);
    expect(env.preRenderCbs.size).toBe(0);
  });

  it('remove() without an undo stack records nothing and still removes', () => {
    const id = particles.add(0, 0, 0);
    particles.remove(id);
    expect(particles.get(id)).toBeNull();
  });

  it('dispose() stops the tick and drops all emitters', () => {
    particles.add(0, 0, 0);
    particles.add(0, 0, 0);
    particles.dispose();
    expect(particles.getAll()).toHaveLength(0);
    expect(env.preRenderCbs.size).toBe(0);
  });
});

// Audit 2026-10-09 §2 #20: Loop off emitted forever (the spawn gate was always true). Loop off = ONE burst of
// maxParticles particles spawned at emitRate, then the live ones age out; a timeline rewind / config change re-arms it.
describe('ParticleEmitter3D Loop off = one burst', () => {
  function makeTimelineCtx() {
    const env = makeCtx();
    const listeners: Array<(e: { type: string; frame?: number }) => void> = [];
    let frame = 1;
    const timeline = {
      getCurrentFrame: () => frame,
      on: (l: (e: { type: string; frame?: number }) => void) => { listeners.push(l); return () => { listeners.splice(listeners.indexOf(l), 1); }; },
      go: (f: number) => { frame = f; for (const l of [...listeners]) l({ type: 'frame-changed', frame: f }); },
      listeners,
    };
    (env.ctx as unknown as { rasterLayerManager: unknown }).rasterLayerManager = { getTimeline: () => timeline };
    return { ...env, timeline };
  }
  const tickAll = (cbs: Set<() => boolean>) => { let r = false; for (const cb of cbs) r = cb() || r; return r; };
  const cfg = { loop: false, maxParticles: 20, emitRate: 100, lifetime: [0.5, 0.5] as [number, number] };

  it('spawns maxParticles in total, then stops; the live ones die out', () => {
    const env = makeCtx();
    const p = new Scene3DParticles(env.ctx);
    const e = p.get(p.add(0, 0, 0, cfg))!;
    e.tick(0.1);                       // 10 spawned
    e.buildGPUData();
    expect(e.activeCount).toBe(10);
    expect(e.burstDone).toBe(false);
    e.tick(0.1); e.tick(0.1);          // capped at 20 total
    e.buildGPUData();
    expect(e.activeCount).toBe(20);
    expect(e.burstDone).toBe(true);
    for (let i = 0; i < 10; i++) e.tick(0.1);   // 1 s later: every particle (0.5 s life) is gone, none respawned
    e.buildGPUData();
    expect(e.activeCount).toBe(0);
    expect(e.isActive).toBe(false);
  });

  it('a looping emitter keeps emitting (live count refills after the first generation dies)', () => {
    const env = makeCtx();
    const p = new Scene3DParticles(env.ctx);
    const e = p.get(p.add(0, 0, 0, { ...cfg, loop: true }))!;
    for (let i = 0; i < 20; i++) e.tick(0.1);
    e.buildGPUData();
    expect(e.activeCount).toBeGreaterThan(0);
    expect(e.burstDone).toBe(false);
    expect(e.isActive).toBe(true);
  });

  it('the tick loop stops requesting frames once the burst is over', () => {
    const env = makeCtx();
    const p = new Scene3DParticles(env.ctx);
    const e = p.get(p.add(0, 0, 0, cfg))!;
    for (let i = 0; i < 12; i++) e.tick(0.1);
    expect(e.isActive).toBe(false);
    expect(tickAll(env.preRenderCbs)).toBe(false);
    expect(env.preRenderCbs.size).toBe(1);   // still registered: a restart wakes it
  });

  it('a config change re-arms the burst', () => {
    const env = makeCtx();
    const p = new Scene3DParticles(env.ctx);
    const id = p.add(0, 0, 0, cfg);
    const e = p.get(id)!;
    for (let i = 0; i < 12; i++) e.tick(0.1);
    expect(e.burstDone).toBe(true);
    const before = env.calls.scheduleRender;
    p.setConfig(id, { emitRate: 200 });
    expect(e.burstDone).toBe(false);
    expect(env.calls.scheduleRender).toBeGreaterThan(before);
    e.tick(0.05);
    e.buildGPUData();
    expect(e.activeCount).toBe(10);
  });

  it('a timeline rewind restarts one-shot emitters only (moving forward does not)', () => {
    const env = makeTimelineCtx();
    const p = new Scene3DParticles(env.ctx);
    const once = p.get(p.add(0, 0, 0, cfg))!;
    const loop = p.get(p.add(0, 0, 0, { ...cfg, loop: true }))!;
    tickAll(env.preRenderCbs);                            // first tick subscribes to the timeline
    expect(env.timeline.listeners).toHaveLength(1);
    for (let i = 0; i < 12; i++) { once.tick(0.1); loop.tick(0.1); }
    expect(once.burstDone).toBe(true);
    env.timeline.go(5);                                    // forward: nothing restarts
    expect(once.burstDone).toBe(true);
    loop.buildGPUData();
    const loopLive = loop.activeCount;
    env.timeline.go(1);                                    // rewind: the burst fires again
    expect(once.burstDone).toBe(false);
    loop.buildGPUData();
    expect(loop.activeCount).toBe(loopLive);               // the looping stream is left alone
    p.dispose();
    expect(env.timeline.listeners).toHaveLength(0);        // unsubscribed on teardown
  });

  it('persistence is unchanged: toJSON writes the config (loop flag), not the runtime burst counter', () => {
    const env = makeCtx();
    const p = new Scene3DParticles(env.ctx);
    const e = p.get(p.add(0, 0, 0, cfg))!;
    e.tick(0.1);
    const json = e.toJSON();
    expect(json.config.loop).toBe(false);
    expect(Object.keys(json)).not.toContain('_emitted');
    expect(Object.keys(json.config)).not.toContain('emitted');
  });
});
