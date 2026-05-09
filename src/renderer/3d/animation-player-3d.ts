/**
 * AnimationPlayer3D — Frame-accurate playback clock for 3D keyframe animation.
 *
 * Drives per-frame callbacks using requestAnimationFrame with time-accumulation
 * to hit the target FPS precisely regardless of display refresh rate.
 *
 * Usage:
 *   const player = scene3d.createAnimationPlayer({ startFrame: 0, endFrame: 120, fps: 24 });
 *   player.play();
 *   player.pause();
 *   player.seek(30);
 */

export interface AnimationPlayer3DConfig {
  /** First frame of the animation range. Default: 0. */
  startFrame?: number;
  /** Last frame of the animation range (inclusive). Default: 120. */
  endFrame?: number;
  /** Playback rate in frames per second. Default: 24. */
  fps?: number;
  /** Whether to loop back to startFrame after reaching endFrame. Default: true. */
  loop?: boolean;
}

export class AnimationPlayer3D {
  private _frame: number;
  private _startFrame: number;
  private _endFrame: number;
  private _fps: number;
  private _loop: boolean;

  private _playing = false;
  private _lastTimestamp = 0;
  private _accumulator = 0;
  private _rafId: number | null = null;

  private _onFrame?: (frame: number) => void;
  private _onStop?: () => void;

  constructor(config: AnimationPlayer3DConfig = {}) {
    this._startFrame = config.startFrame ?? 0;
    this._endFrame   = config.endFrame   ?? 120;
    this._fps        = Math.max(1, config.fps ?? 24);
    this._loop       = config.loop ?? true;
    this._frame      = this._startFrame;
  }

  // ── State ──────────────────────────────────────────────────────

  get currentFrame(): number  { return this._frame; }
  get playing(): boolean      { return this._playing; }
  get fps(): number           { return this._fps; }
  get startFrame(): number    { return this._startFrame; }
  get endFrame(): number      { return this._endFrame; }
  get loop(): boolean         { return this._loop; }

  set fps(v: number)         { this._fps = Math.max(1, v); }
  set startFrame(v: number)  { this._startFrame = v; }
  set endFrame(v: number)    { this._endFrame = v; }
  set loop(v: boolean)       { this._loop = v; }

  // ── Events ─────────────────────────────────────────────────────

  /** Called every time the current frame advances. */
  onFrame(cb: (frame: number) => void): this { this._onFrame = cb; return this; }
  /** Called when playback reaches the end and loop is false. */
  onStop(cb: () => void): this { this._onStop = cb; return this; }

  // ── Playback control ───────────────────────────────────────────

  play(): void {
    if (this._playing) return;
    this._playing = true;
    this._lastTimestamp = performance.now();
    this._accumulator = 0;
    this._scheduleFrame();
  }

  pause(): void {
    this._playing = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  stop(): void {
    this.pause();
    this._frame = this._startFrame;
    this._accumulator = 0;
    this._onFrame?.(this._frame);
  }

  /** Jump to an arbitrary frame without changing play state. */
  seek(frame: number): void {
    this._frame = Math.max(this._startFrame, Math.min(this._endFrame, frame));
    this._accumulator = 0;
    this._onFrame?.(this._frame);
  }

  toggle(): void {
    this._playing ? this.pause() : this.play();
  }

  destroy(): void {
    this.pause();
    this._onFrame = undefined;
    this._onStop  = undefined;
  }

  // ── Internal tick ──────────────────────────────────────────────

  private _scheduleFrame(): void {
    this._rafId = requestAnimationFrame(this._tick);
  }

  private _tick = (timestamp: number): void => {
    if (!this._playing) return;

    const dt = timestamp - this._lastTimestamp;
    this._lastTimestamp = timestamp;
    this._accumulator += dt;

    const frameDuration = 1000 / this._fps;

    while (this._accumulator >= frameDuration) {
      this._accumulator -= frameDuration;
      this._frame++;

      if (this._frame > this._endFrame) {
        if (this._loop) {
          this._frame = this._startFrame;
        } else {
          this._frame = this._endFrame;
          this._playing = false;
          this._rafId = null;
          this._onFrame?.(this._frame);
          this._onStop?.();
          return;
        }
      }

      this._onFrame?.(this._frame);
    }

    this._scheduleFrame();
  };
}
