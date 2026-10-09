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
import type { Command3D } from './undo-manager-3d';

/** The 3D undo step a removed emitter records (hosts match it, e.g. an outliner Undo toast). */
export const DELETE_PARTICLE_EMITTER_UNDO = 'Delete particle emitter';

export class Scene3DParticles {
  private _emitters = new Map<string, ParticleEmitter3D>();
  private _tickCb: (() => boolean) | null = null;
  /** Timeline subscription (rewind = restart the non-looping bursts), made lazily once the timeline exists. */
  private _timelineUnsub: (() => void) | null = null;
  private _lastFrame = -1;

  /** `pushUndo` (the scene's 3D undo stack) makes remove() ONE undoable step, like a mesh delete. */
  constructor(private readonly ctx: ManagerContext, private readonly pushUndo?: (cmd: Command3D) => void) {}

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
    const parent = emitter.parent ?? this.ctx.sceneGraph.root;
    this._detach(emitter);
    this.pushUndo?.({
      description: DELETE_PARTICLE_EMITTER_UNDO,
      undo: () => {
        this._emitters.set(emitter.id, emitter);
        parent.addChild(emitter);
        emitter.gpuDirty = true;
        this.ctx.emitSceneGraphChanged();
        this._ensureTick();
        this.ctx.scheduleRender();
      },
      redo: () => { if (this._emitters.get(emitter.id) === emitter) this._detach(emitter); },
    });
  }

  private _detach(emitter: ParticleEmitter3D): void {
    this._emitters.delete(emitter.id);
    emitter.parent?.removeChild(emitter);
    this.ctx.emitSceneGraphChanged();

    if (this._emitters.size === 0) this._stopTick();
    this.ctx.scheduleRender();
  }

  get(id: string): ParticleEmitter3D | null {
    return this._emitters.get(id) ?? null;
  }

  setConfig(id: string, config: ParticleEmitterConfig): void {
    const e = this._emitters.get(id);
    if (!e) return;
    e.setConfig(config);   // re-arms a non-looping burst too
    this._ensureTick();
    this.ctx.scheduleRender();
  }

  /** Restart every emitter (a non-looping one fires its burst again). `onlyOneShot` leaves looping emitters alone
   *  (what a timeline rewind does: a looping stream has no start to go back to). */
  restartAll(onlyOneShot = false): void {
    let any = false;
    for (const e of this._emitters.values()) {
      if (onlyOneShot && e.config.loop) continue;
      e.restart();
      any = true;
    }
    if (any) this.ctx.scheduleRender();
  }

  /** The timeline frame moved: going BACK (rewind, Stop, a loop wrap, scrubbing left) restarts the one-shot bursts. */
  onTimelineFrame(frame: number): void {
    const prev = this._lastFrame;
    this._lastFrame = frame;
    if (prev >= 0 && frame < prev) this.restartAll(true);
  }

  private _attachTimeline(): void {
    if (this._timelineUnsub) return;
    const timeline = this.ctx.rasterLayerManager?.getTimeline?.();
    if (!timeline) return;
    this._lastFrame = timeline.getCurrentFrame();
    this._timelineUnsub = timeline.on((ev: { type: string; frame?: number }) => {
      if (ev.type === 'frame-changed') this.onTimelineFrame(ev.frame ?? timeline.getCurrentFrame());
    });
  }

  private _detachTimeline(): void {
    this._timelineUnsub?.();
    this._timelineUnsub = null;
    this._lastFrame = -1;
  }

  getAll(): ParticleEmitter3D[] {
    return [...this._emitters.values()];
  }

  /** Re-register a ParticleEmitter3D node that was restored from JSON. */
  registerRestored(emitter: ParticleEmitter3D): void {
    // Saves from before toJSON wrote `visible` restore it as undefined (= hidden, never drawn or icon-picked)
    if (typeof emitter.visible !== 'boolean') emitter.visible = true;
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
      if (!this._timelineUnsub) this._attachTimeline();   // the timeline may not exist yet when the first emitter lands
      let active = false;
      for (const e of this._emitters.values()) { e.tick(dt); if (e.isActive) active = true; }
      if (this._emitters.size === 0) {
        this.ctx.webgpuRenderer.removePreRenderCallback(this._tickCb!);
        this._tickCb = null;
        this._detachTimeline();
        return false;
      }
      // A finished one-shot burst stops asking for frames (it stays registered: a restart / config change wakes it).
      return active;
    };
    this.ctx.webgpuRenderer.addPreRenderCallback(this._tickCb, 'particles');
  }

  private _stopTick(): void {
    this._detachTimeline();
    if (!this._tickCb) return;
    this.ctx.webgpuRenderer.removePreRenderCallback(this._tickCb);
    this._tickCb = null;
  }
}
