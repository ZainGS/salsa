/**
 * Scene3DParticles — the CPU-simulated billboard particle-emitter subsystem, extracted from Scene3DManager.
 *
 * This is the §5.1 extraction PILOT (docs/specs/god-objects-and-perf.md, Part A): a self-contained, id-keyed
 * subsystem whose only dependencies are the shared `ManagerContext` — no back-reference to the parent manager
 * and no cross-subsystem field access. Scene3DManager keeps thin delegating methods so the public API and every
 * caller are unchanged; the emitter map, tick loop, and their lifetime now live here where they can be unit-tested
 * in isolation with a mock ctx (see scene3d-particles.test.ts).
 *
 * The emitters are billboard nodes in the scene graph (so the main renderer finds them in `aboveRasterNodes`);
 * a single pre-render callback ticks all active emitters and self-removes when the last emitter is gone.
 */

import { ParticleEmitter3D, ParticleEmitterConfig, ParticlePreset } from '../../scene-graph/shapes/particle-emitter-3d';
import type { ManagerContext } from './manager-context';

export class Scene3DParticles {
  private _emitters = new Map<string, ParticleEmitter3D>();
  private _tickCb: (() => boolean) | null = null;

  constructor(private readonly ctx: ManagerContext) {}

  /**
   * Add a CPU-simulated billboard particle emitter to the 3D scene. Returns the emitter's ID. Pass `preset`
   * to use a tuned preset ('dust' | 'sparks' | 'snow' | 'magic'); individual config fields override the preset.
   * The emitter begins ticking immediately.
   */
  add(
    x: number, y: number, z: number,
    config: ParticleEmitterConfig = {},
    preset?: ParticlePreset,
  ): string {
    const emitter = new ParticleEmitter3D(this.ctx.interactionService, x, y, z, config, preset);
    this._emitters.set(emitter.id, emitter);

    // Add to the scene graph so the main renderer can find it in `aboveRasterNodes`.
    this.ctx.sceneGraph.root.addChild(emitter);
    this.ctx.emitSceneGraphChanged();

    this._ensureTick();
    this.ctx.scheduleRender();
    return emitter.id;
  }

  remove(id: string): void {
    const emitter = this._emitters.get(id);
    if (!emitter) return;
    this._emitters.delete(id);
    emitter.parent?.removeChild(emitter);
    this.ctx.emitSceneGraphChanged();

    if (this._emitters.size === 0) this._stopTick();
    this.ctx.scheduleRender();
  }

  get(id: string): ParticleEmitter3D | null {
    return this._emitters.get(id) ?? null;
  }

  setConfig(id: string, config: ParticleEmitterConfig): void {
    this._emitters.get(id)?.setConfig(config);
  }

  getAll(): ParticleEmitter3D[] {
    return [...this._emitters.values()];
  }

  /** Re-register a ParticleEmitter3D node that was restored from JSON. */
  registerRestored(emitter: ParticleEmitter3D): void {
    this._emitters.set(emitter.id, emitter);
    this._ensureTick();
  }

  /** Stop the tick loop and drop all emitter references (used on manager teardown). Does NOT detach the nodes —
   *  scene-graph disposal owns that. Safe to call more than once. */
  dispose(): void {
    this._stopTick();
    this._emitters.clear();
  }

  private _ensureTick(): void {
    if (this._tickCb) return;
    let lastTime = performance.now();
    this._tickCb = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1);   // clamp to 100 ms
      lastTime = now;
      for (const e of this._emitters.values()) e.tick(dt);
      const hasActive = this._emitters.size > 0;
      if (!hasActive) {
        this.ctx.webgpuRenderer.removePreRenderCallback(this._tickCb!);
        this._tickCb = null;
      }
      return hasActive;
    };
    this.ctx.webgpuRenderer.addPreRenderCallback(this._tickCb);
  }

  private _stopTick(): void {
    if (!this._tickCb) return;
    this.ctx.webgpuRenderer.removePreRenderCallback(this._tickCb);
    this._tickCb = null;
  }
}
