/**
 * AnimationTimeline — manages frame state, playback, and cel-to-frame mapping.
 *
 * This is the core timeline engine. It doesn't own textures — it coordinates
 * which cels are visible on which frames and handles playback timing.
 *
 * The RasterLayerManager uses this to swap textures per frame.
 *
 * Texture ownership (perf audit A1, 2026-10-09): every cel has its OWN texture. The timeline owns the textures it
 * creates (addCel / duplicateCel / a hold split) and the ones handed to addCelWithId; a layer's `baseTexture` (its
 * texture manager's, shown by cel 1) belongs to the layer and is never destroyed here. Every destroy goes through
 * releaseTexture(), which also skips a texture another cel still shows. Splitting a hold used to leave the rest of the
 * hold SHARING the original's texture: painting one frame changed the other, and deleting either destroyed both.
 *
 * Lazy cel textures (perf audit D1, 2026-10-09): a BLANK cel owns no texture (`texture: null`). addCel makes blank
 * cels; splitting a blank hold / duplicating a blank cel stays blank (a drawn one is still copied). The texture is made
 * on the first write — RasterLayerManager materialises the cel its selected layer shows (setCelTexture) and frees it
 * again while nothing was written (takeCelTexture). 2 animated layers × 48 cels at 1080p used to cost ~800 MB of GPU
 * memory for full-canvas blank textures.
 */

import {
  AnimationCel,
  AnimationLayerState,
  TimelineState,
  LoopMode,
  PlaybackState,
  OnionSkinConfig,
  DEFAULT_ONION_SKIN,
  AnimationEvent,
  AnimationEventListener,
} from './animation-types';

function makeCelId(): string {
  return 'cel_' + Math.random().toString(36).slice(2, 9);
}

const CEL_TEXTURE_USAGE = () =>
  GPUTextureUsage.TEXTURE_BINDING |
  GPUTextureUsage.STORAGE_BINDING |
  GPUTextureUsage.COPY_SRC |
  GPUTextureUsage.COPY_DST |
  GPUTextureUsage.RENDER_ATTACHMENT;

export class AnimationTimeline {
  private state: TimelineState;
  private layerStates: Map<string, AnimationLayerState> = new Map();
  private onionSkin: OnionSkinConfig = { ...DEFAULT_ONION_SKIN };
  private listeners: AnimationEventListener[] = [];

  // Playback
  private playbackRafId: number | null = null;
  private lastFrameTime = 0;

  constructor(fps = 12, frameCount = 1) {
    this.state = {
      frameCount: Math.max(1, frameCount),
      currentFrame: 1,
      fps,
      loopMode: 'loop',
      playbackState: 'stopped',
      playRangeStart: 1,
      playRangeEnd: Math.max(1, frameCount),
    };
  }

  // ── Event system ──────────────────────────────────────────────────

  public on(listener: AnimationEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emit(event: AnimationEvent): void {
    for (const l of this.listeners) l(event);
  }

  // ── Timeline state ────────────────────────────────────────────────

  /** Back to a new timeline's state (1 frame at 12 fps, loop, range 1..1, default onion skin), playback stopped — for a
   *  document load / new document. The previous document's frame count, fps, loop mode, play range and onion skin used
   *  to carry over when the next document had no animation of its own, and were then saved into it. Layer
   *  registrations are left alone: the document load replaces the layers itself. */
  public resetForDocumentLoad(): void {
    if (this.playbackRafId !== null) {
      cancelAnimationFrame(this.playbackRafId);
      this.playbackRafId = null;
    }
    const wasPlaying = this.state.playbackState !== 'stopped';
    this.state = {
      frameCount: 1, currentFrame: 1, fps: 12, loopMode: 'loop', playbackState: 'stopped',
      playRangeStart: 1, playRangeEnd: 1,
    };
    this.onionSkin = { ...DEFAULT_ONION_SKIN };
    this.pingPongDirection = 1;
    if (wasPlaying) this.emit({ type: 'playback-state-changed' });
  }

  public getState(): Readonly<TimelineState> {
    return { ...this.state };
  }

  public getFrameCount(): number {
    return this.state.frameCount;
  }

  public getCurrentFrame(): number {
    return this.state.currentFrame;
  }

  public getFps(): number {
    return this.state.fps;
  }

  public setFps(fps: number): void {
    this.state.fps = Math.max(1, Math.min(120, fps));
  }

  public setFrameCount(count: number): void {
    const oldCount = this.state.frameCount;
    this.state.frameCount = Math.max(1, count);
    if (this.state.currentFrame > this.state.frameCount) {
      this.state.currentFrame = this.state.frameCount;
    }
    // If the play range end was tracking the old frame count (default behavior),
    // expand it to the new count so playback covers the full timeline.
    if (this.state.playRangeEnd === oldCount || this.state.playRangeEnd < 1) {
      this.state.playRangeEnd = this.state.frameCount;
    } else {
      // Clamp to new max
      this.state.playRangeEnd = Math.min(this.state.playRangeEnd, this.state.frameCount);
    }
    this.state.playRangeStart = Math.min(this.state.playRangeStart, this.state.playRangeEnd);
    this.emit({ type: 'timeline-changed' });
  }

  /** Add N frames at the end of the timeline. */
  public addFrames(count: number): void {
    this.setFrameCount(this.state.frameCount + count);
  }

  /** Insert a frame at a specific position (1-indexed). Shifts subsequent frames. */
  public insertFrame(at: number): void {
    const pos = Math.max(1, Math.min(at, this.state.frameCount + 1));

    // Shift all cels that start at or after this position
    for (const [, ls] of this.layerStates) {
      if (ls.type !== 'animated') continue;
      for (const cel of ls.cels) {
        if (cel.startFrame >= pos) {
          cel.startFrame += 1;
        }
      }
    }

    this.state.frameCount += 1;
    if (this.state.currentFrame >= pos) {
      this.state.currentFrame = Math.min(this.state.currentFrame + 1, this.state.frameCount);
    }
    // Keep play range tracking the full timeline
    this.state.playRangeEnd = this.state.frameCount;
    this.state.playRangeStart = Math.min(this.state.playRangeStart, this.state.playRangeEnd);
    this.emit({ type: 'timeline-changed' });
    // Always emit frame-changed — inserting a frame shifts cels, so the
    // texture at the current frame position may have changed even if
    // currentFrame itself didn't move.
    this.emit({ type: 'frame-changed', frame: this.state.currentFrame });
  }

  /** Delete a frame at a specific position. Shifts subsequent frames back. */
  public deleteFrame(at: number): void {
    if (this.state.frameCount <= 1) return; // can't delete the last frame
    const pos = Math.max(1, Math.min(at, this.state.frameCount));

    // Remove cels that start exactly on this frame, shift others
    for (const [layerId, ls] of this.layerStates) {
      if (ls.type !== 'animated') continue;
      const toRemove: string[] = [];
      for (const cel of ls.cels) {
        if (cel.startFrame === pos && cel.duration === 1) {
          toRemove.push(cel.id);
        } else if (cel.startFrame === pos && cel.duration > 1) {
          // Shrink the hold
          cel.duration -= 1;
          // startFrame stays the same but will be shifted below
        } else if (cel.startFrame < pos && cel.startFrame + cel.duration > pos) {
          // Cel spans across the deleted frame — shrink duration
          cel.duration -= 1;
        }
      }
      // Remove dead cels — destroy their GPU textures to avoid leaks (never a layer's own / a still-shown one)
      const dead = ls.cels.filter(c => toRemove.includes(c.id));
      ls.cels = ls.cels.filter(c => !toRemove.includes(c.id));
      for (const cel of dead) {
        this.releaseTexture(cel.texture);
        this.emit({ type: 'cel-removed', layerId, celId: cel.id });
      }
      // Shift cels after deleted frame
      for (const cel of ls.cels) {
        if (cel.startFrame > pos) {
          cel.startFrame -= 1;
        }
      }
    }

    this.state.frameCount -= 1;
    const oldFrame = this.state.currentFrame;
    if (this.state.currentFrame > this.state.frameCount) {
      this.state.currentFrame = this.state.frameCount;
    }
    this.state.playRangeEnd = Math.min(this.state.playRangeEnd, this.state.frameCount);
    this.emit({ type: 'timeline-changed' });
    // Always emit frame-changed after delete — even if currentFrame number
    // didn't change, the cel at that frame position may have shifted.
    this.emit({ type: 'frame-changed', frame: this.state.currentFrame });
  }

  // ── Frame navigation ──────────────────────────────────────────────

  public setCurrentFrame(frame: number): void {
    const clamped = Math.max(1, Math.min(frame, this.state.frameCount));
    if (clamped !== this.state.currentFrame) {
      this.state.currentFrame = clamped;
      this.emit({ type: 'frame-changed', frame: clamped });
    }
  }

  public nextFrame(): void {
    if (this.state.currentFrame < this.state.frameCount) {
      this.setCurrentFrame(this.state.currentFrame + 1);
    } else if (this.state.loopMode === 'loop') {
      this.setCurrentFrame(this.state.playRangeStart);
    }
  }

  public prevFrame(): void {
    if (this.state.currentFrame > 1) {
      this.setCurrentFrame(this.state.currentFrame - 1);
    } else if (this.state.loopMode === 'loop') {
      this.setCurrentFrame(this.state.playRangeEnd);
    }
  }

  public firstFrame(): void {
    this.setCurrentFrame(this.state.playRangeStart);
  }

  public lastFrame(): void {
    this.setCurrentFrame(this.state.playRangeEnd);
  }

  // ── Playback ──────────────────────────────────────────────────────

  public setLoopMode(mode: LoopMode): void {
    this.state.loopMode = mode;
  }

  public setPlayRange(start: number, end: number): void {
    this.state.playRangeStart = Math.max(1, Math.min(start, this.state.frameCount));
    this.state.playRangeEnd = Math.max(this.state.playRangeStart, Math.min(end, this.state.frameCount));
  }

  public play(): void {
    if (this.state.playbackState === 'playing') return;
    this.state.playbackState = 'playing';
    this.lastFrameTime = performance.now();
    this.emit({ type: 'playback-state-changed' });
    this.tick();
  }

  public pause(): void {
    if (this.state.playbackState !== 'playing') return;
    this.state.playbackState = 'paused';
    if (this.playbackRafId !== null) {
      cancelAnimationFrame(this.playbackRafId);
      this.playbackRafId = null;
    }
    this.emit({ type: 'playback-state-changed' });
  }

  public stop(): void {
    this.state.playbackState = 'stopped';
    if (this.playbackRafId !== null) {
      cancelAnimationFrame(this.playbackRafId);
      this.playbackRafId = null;
    }
    this.setCurrentFrame(this.state.playRangeStart);
    this.emit({ type: 'playback-state-changed' });
  }

  /** Is playback running? (cheap — no state copy, unlike getState()) */
  public isPlaying(): boolean {
    return this.state.playbackState === 'playing';
  }

  public togglePlayPause(): void {
    if (this.state.playbackState === 'playing') {
      this.pause();
    } else {
      this.play();
    }
  }

  private pingPongDirection: 1 | -1 = 1;

  private tick = (): void => {
    if (this.state.playbackState !== 'playing') return;

    const now = performance.now();
    const frameDuration = 1000 / this.state.fps;
    const elapsed = now - this.lastFrameTime;

    if (elapsed >= frameDuration) {
      this.lastFrameTime = now - (elapsed % frameDuration);
      this.advanceFrame();
    }

    this.playbackRafId = requestAnimationFrame(this.tick);
  };

  private advanceFrame(): void {
    const { playRangeStart: rs, playRangeEnd: re, loopMode } = this.state;

    // Single-frame range — nothing to advance to
    if (rs >= re) {
      return;
    }

    let next = this.state.currentFrame;

    if (loopMode === 'ping-pong') {
      next += this.pingPongDirection;
      if (next > re) {
        this.pingPongDirection = -1;
        next = re - 1;
      } else if (next < rs) {
        this.pingPongDirection = 1;
        next = rs + 1;
      }
      next = Math.max(rs, Math.min(re, next));
    } else {
      next += 1;
      if (next > re) {
        if (loopMode === 'loop') {
          next = rs;
        } else {
          // 'none' — stop at end
          this.pause();
          return;
        }
      }
    }

    this.setCurrentFrame(next);
  }

  // ── Layer animation state ─────────────────────────────────────────

  /**
   * Register a layer for animation tracking.
   * Newly registered layers default to 'static' (single texture, visible on all frames).
   */
  public registerLayer(layerId: string): void {
    if (!this.layerStates.has(layerId)) {
      this.layerStates.set(layerId, { type: 'static', cels: [] });
    }
  }

  /** Unregister a layer (e.g. when deleted). Destroys cel textures. */
  public unregisterLayer(layerId: string): void {
    const ls = this.layerStates.get(layerId);
    if (ls) {
      this.layerStates.delete(layerId);
      // (the layer's own baseTexture is the layer's to destroy — its texture manager does)
      for (const cel of ls.cels) if (cel.texture !== ls.baseTexture) this.releaseTexture(cel.texture);
    }
  }

  /** Destroy a cel texture the timeline owns — unless it is a layer's own texture (baseTexture) or another cel still
   *  shows it. Call AFTER removing the cel from its layer's list. */
  private releaseTexture(tex: GPUTexture | null | undefined): void {
    if (!tex) return;
    for (const [, ls] of this.layerStates) {
      if (ls.baseTexture === tex) return;
      for (const c of ls.cels) if (c.texture === tex) return;
    }
    tex.destroy();
  }

  /**
   * Convert a layer between static and animated.
   * When converting static → animated, the layer's current texture becomes cel 1.
   */
  public setLayerAnimationType(
    layerId: string,
    type: 'static' | 'animated',
    existingTexture?: GPUTexture,
  ): void {
    let ls = this.layerStates.get(layerId);
    if (!ls) {
      ls = { type: 'static', cels: [] };
      this.layerStates.set(layerId, ls);
    }

    if (ls.type === type) return;

    if (type === 'animated' && existingTexture) {
      // The existing static texture becomes the first cel (the layer keeps owning it)
      const dropped = ls.cels;
      ls.baseTexture = existingTexture;
      ls.cels = [{
        id: makeCelId(),
        startFrame: 1,
        duration: this.state.frameCount, // hold for entire timeline
        texture: existingTexture,
        celType: 'key',
      }];
      for (const c of dropped) this.releaseTexture(c.texture);   // (a static layer's leftover first cel)
    } else if (type === 'static') {
      // Destroy all cel textures except the first (which becomes the static texture)
      const removed = ls.cels.slice(1);
      ls.cels = ls.cels.length > 0 ? [ls.cels[0]] : [];
      for (const c of removed) this.releaseTexture(c.texture);
    }

    ls.type = type;
    this.emit({ type: 'layer-type-changed', layerId });
  }

  public getLayerAnimationState(layerId: string): AnimationLayerState | undefined {
    return this.layerStates.get(layerId);
  }

  public isLayerAnimated(layerId: string): boolean {
    return this.layerStates.get(layerId)?.type === 'animated';
  }

  // ── Cel management ────────────────────────────────────────────────

  /**
   * Get the cel visible on a specific frame for a layer.
   * Returns undefined if the layer is static or the frame is blank.
   */
  public getCelAtFrame(layerId: string, frame: number): AnimationCel | undefined {
    const ls = this.layerStates.get(layerId);
    if (!ls || ls.type !== 'animated') return undefined;
    return ls.cels.find(c =>
      frame >= c.startFrame && frame < c.startFrame + c.duration
    );
  }

  /**
   * Get the texture to display for a layer on a specific frame.
   * For static layers, returns undefined (use the layer's main texture).
   * For animated layers, returns the cel's texture or null (blank frame).
   */
  public getTextureAtFrame(layerId: string, frame: number): GPUTexture | null | undefined {
    const ls = this.layerStates.get(layerId);
    if (!ls || ls.type !== 'animated') return undefined; // static — use main texture
    const cel = this.getCelAtFrame(layerId, frame);
    return cel?.texture ?? null; // null = blank frame
  }

  /**
   * Add a new blank cel at the specified frame.
   * The device is needed to create a new GPU texture.
   */
  public addCel(
    layerId: string,
    frame: number,
    device: GPUDevice,
    _width: number,
    _height: number,
    celType: 'key' | 'inbetween' = 'key',
    isBlank?: (tex: GPUTexture) => boolean,
  ): AnimationCel | null {
    const ls = this.layerStates.get(layerId);
    if (!ls || ls.type !== 'animated') return null;

    // Check if there's already a cel on this frame
    const existing = this.getCelAtFrame(layerId, frame);
    if (existing && existing.startFrame === frame) {
      // Already a cel starting on this exact frame
      return existing;
    }

    // If this frame is in the middle of a hold, split the hold
    if (existing) {
      const holdEnd = existing.startFrame + existing.duration;
      existing.duration = frame - existing.startFrame;
      // The remaining hold after the new cel gets its OWN copy of the drawing (A1: it used to share the texture —
      // painting one changed both, deleting one destroyed both). A blank hold's rest stays blank (D1: no texture).
      if (holdEnd > frame + 1) {
        const copy = this.copyTexture(existing.texture, device, isBlank);
        const remainCel: AnimationCel = {
          id: makeCelId(),
          startFrame: frame + 1,
          duration: holdEnd - frame - 1,
          texture: copy,
          celType: 'inbetween',
        };
        ls.cels.push(remainCel);
      }
    }

    // D1: the new cel is BLANK — no texture until something is drawn on it (the layer manager makes it on first write;
    // `_width` / `_height` are kept for callers — the texture it makes is the canvas size then)
    const cel: AnimationCel = {
      id: makeCelId(),
      startFrame: frame,
      duration: 1,
      texture: null,
      celType,
    };

    ls.cels.push(cel);
    // Sort by startFrame for consistent ordering
    ls.cels.sort((a, b) => a.startFrame - b.startFrame);

    // Auto-expand timeline if needed
    if (frame > this.state.frameCount) {
      this.state.frameCount = frame;
      this.state.playRangeEnd = frame;
    }

    this.emit({ type: 'cel-added', layerId, celId: cel.id, frame });
    return cel;
  }

  /**
   * Add a cel with a specific ID, startFrame, duration, and celType.
   * Used by the persistence engine to restore saved cels exactly.
   * The caller must provide a pre-created GPU texture.
   */
  public addCelWithId(
    layerId: string,
    celId: string,
    startFrame: number,
    duration: number,
    celType: 'key' | 'inbetween',
    texture: GPUTexture | null,
  ): AnimationCel | null {
    const ls = this.layerStates.get(layerId);
    if (!ls || ls.type !== 'animated') return null;

    const cel: AnimationCel = {
      id: celId,
      startFrame,
      duration,
      texture,
      celType,
    };

    ls.cels.push(cel);
    ls.cels.sort((a, b) => a.startFrame - b.startFrame);
    return cel;
  }

  /** Delete a cel by id. Destroys its texture. */
  public deleteCel(layerId: string, celId: string): boolean {
    const ls = this.layerStates.get(layerId);
    if (!ls) return false;
    const idx = ls.cels.findIndex(c => c.id === celId);
    if (idx < 0) return false;
    const [removed] = ls.cels.splice(idx, 1);
    this.releaseTexture(removed.texture);   // (never the layer's own texture)
    this.emit({ type: 'cel-removed', layerId, celId });
    return true;
  }

  /** Point a cel at another texture (e.g. the layer's own after its pixels were copied there, or a blank cel's first
   *  texture — D1); the old one is released (destroyed unless the layer owns it or another cel shows it). null makes
   *  the cel blank. */
  public setCelTexture(layerId: string, celId: string, texture: GPUTexture | null): boolean {
    const cel = this.layerStates.get(layerId)?.cels.find(c => c.id === celId);
    if (!cel) return false;
    const old = cel.texture;
    cel.texture = texture;
    if (old !== texture) this.releaseTexture(old);
    return true;
  }

  /** D1: make a cel BLANK again and hand its texture to the caller WITHOUT destroying it (the caller owns it now —
   *  e.g. keeps it as a spare blank texture). Null when the cel is unknown / already blank / shows a layer's own
   *  texture (that one stays with its cel). */
  public takeCelTexture(layerId: string, celId: string): GPUTexture | null {
    const ls = this.layerStates.get(layerId);
    const cel = ls?.cels.find(c => c.id === celId);
    const tex = cel?.texture ?? null;
    if (!cel || !tex || tex === ls!.baseTexture) return null;
    cel.texture = null;
    return tex;
  }

  /** The layer's own texture was reallocated (a document resize): its cel(s) and `baseTexture` follow the new one
   *  (they pointed at the old, destroyed one). Nothing is destroyed here. */
  public replaceBaseTexture(layerId: string, oldTex: GPUTexture, newTex: GPUTexture): void {
    const ls = this.layerStates.get(layerId);
    if (!ls || ls.baseTexture !== oldTex) return;
    ls.baseTexture = newTex;
    for (const c of ls.cels) if (c.texture === oldTex) c.texture = newTex;
  }

  /** A full copy of `src` (null — or a texture `isBlank` vouches is still blank — gives a blank cel, D1). */
  private copyTexture(src: GPUTexture | null, device: GPUDevice, isBlank?: (tex: GPUTexture) => boolean): GPUTexture | null {
    if (!src || isBlank?.(src)) return null;
    const copy = device.createTexture({ size: [src.width, src.height], format: 'rgba8unorm', usage: CEL_TEXTURE_USAGE() });
    const enc = device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: src }, { texture: copy }, { width: src.width, height: src.height });
    device.queue.submit([enc.finish()]);
    return copy;
  }

  /** Set the hold duration for a cel. */
  public setCelDuration(layerId: string, celId: string, duration: number): boolean {
    const ls = this.layerStates.get(layerId);
    if (!ls) return false;
    const cel = ls.cels.find(c => c.id === celId);
    if (!cel) return false;
    cel.duration = Math.max(1, duration);
    this.emit({ type: 'timeline-changed' });
    return true;
  }

  /** Mark a cel as key or inbetween. */
  public setCelType(layerId: string, celId: string, type: 'key' | 'inbetween'): boolean {
    const ls = this.layerStates.get(layerId);
    if (!ls) return false;
    const cel = ls.cels.find(c => c.id === celId);
    if (!cel) return false;
    cel.celType = type;
    return true;
  }

  /** Get all cels for a layer. */
  public getCels(layerId: string): AnimationCel[] {
    return this.layerStates.get(layerId)?.cels ?? [];
  }

  // ── Cel duplication / copy / move ─────────────────────────────────

  /**
   * Duplicate a cel's pixel data to a new frame.
   * Creates a new GPU texture and copies the source cel's pixels into it.
   * Returns the new cel, or null if the source doesn't exist.
   */
  public duplicateCel(
    layerId: string,
    celId: string,
    targetFrame: number,
    device: GPUDevice,
    isBlank?: (tex: GPUTexture) => boolean,
  ): AnimationCel | null {
    const ls = this.layerStates.get(layerId);
    if (!ls || ls.type !== 'animated') return null;
    const src = ls.cels.find(c => c.id === celId);
    if (!src) return null;

    // A copy of the source's pixels (a blank source makes a blank cel — D1)
    const texture = this.copyTexture(src.texture, device, isBlank);

    const cel: AnimationCel = {
      id: makeCelId(),
      startFrame: targetFrame,
      duration: 1,
      texture,
      celType: src.celType,
    };

    // Remove any existing cel at the target frame (same start)
    const existingIdx = ls.cels.findIndex(c => c.startFrame === targetFrame);
    if (existingIdx >= 0) {
      const [old] = ls.cels.splice(existingIdx, 1);
      this.releaseTexture(old.texture);
    }

    ls.cels.push(cel);
    ls.cels.sort((a, b) => a.startFrame - b.startFrame);

    if (targetFrame > this.state.frameCount) {
      this.state.frameCount = targetFrame;
      this.state.playRangeEnd = targetFrame;
    }

    this.emit({ type: 'cel-added', layerId, celId: cel.id, frame: targetFrame });
    return cel;
  }

  /**
   * Move a cel to a different frame (changes its startFrame).
   * Does NOT copy pixel data — the same texture moves to the new position.
   */
  public moveCel(
    layerId: string,
    celId: string,
    targetFrame: number,
  ): boolean {
    const ls = this.layerStates.get(layerId);
    if (!ls || ls.type !== 'animated') return false;
    const cel = ls.cels.find(c => c.id === celId);
    if (!cel) return false;

    // Check if target is occupied by a different cel
    const occupant = ls.cels.find(c =>
      c.id !== celId &&
      targetFrame >= c.startFrame &&
      targetFrame < c.startFrame + c.duration
    );
    if (occupant) return false; // target frame is occupied

    cel.startFrame = targetFrame;
    ls.cels.sort((a, b) => a.startFrame - b.startFrame);

    if (targetFrame > this.state.frameCount) {
      this.state.frameCount = targetFrame;
      this.state.playRangeEnd = targetFrame;
    }

    this.emit({ type: 'timeline-changed' });
    return true;
  }

  /**
   * Swap two cels' positions (exchange their startFrames).
   */
  public swapCels(
    layerId: string,
    celIdA: string,
    celIdB: string,
  ): boolean {
    const ls = this.layerStates.get(layerId);
    if (!ls || ls.type !== 'animated') return false;
    const celA = ls.cels.find(c => c.id === celIdA);
    const celB = ls.cels.find(c => c.id === celIdB);
    if (!celA || !celB) return false;

    const tmpFrame = celA.startFrame;
    celA.startFrame = celB.startFrame;
    celB.startFrame = tmpFrame;
    ls.cels.sort((a, b) => a.startFrame - b.startFrame);

    this.emit({ type: 'timeline-changed' });
    return true;
  }

  // ── Onion Skin ────────────────────────────────────────────────────

  public getOnionSkinConfig(): OnionSkinConfig {
    return { ...this.onionSkin };
  }

  public setOnionSkinConfig(config: Partial<OnionSkinConfig>): void {
    Object.assign(this.onionSkin, config);
    this.emit({ type: 'onion-skin-changed' });
  }

  /**
   * Get the onion skin frames to render for the current frame.
   * Returns an array of { frame, opacity, tint } for each ghost frame.
   */
  public getOnionSkinFrames(): Array<{
    frame: number;
    opacity: number;
    tint: [number, number, number];
  }> {
    if (!this.onionSkin.enabled) return [];

    const current = this.state.currentFrame;
    const result: Array<{ frame: number; opacity: number; tint: [number, number, number] }> = [];

    // Previous frames
    for (let i = 1; i <= this.onionSkin.framesBefore; i++) {
      const f = current - i;
      if (f < 1) break;
      const fadeRatio = 1 - (i - 1) / this.onionSkin.framesBefore;
      result.push({
        frame: f,
        opacity: this.onionSkin.opacity * fadeRatio,
        tint: this.onionSkin.tintBefore,
      });
    }

    // Next frames
    for (let i = 1; i <= this.onionSkin.framesAfter; i++) {
      const f = current + i;
      if (f > this.state.frameCount) break;
      const fadeRatio = 1 - (i - 1) / this.onionSkin.framesAfter;
      result.push({
        frame: f,
        opacity: this.onionSkin.opacity * fadeRatio,
        tint: this.onionSkin.tintAfter,
      });
    }

    return result;
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  public destroy(): void {
    this.stop();
    const owned = new Set<GPUTexture>();
    for (const [, ls] of this.layerStates) {
      for (const cel of ls.cels) if (cel.texture && cel.texture !== ls.baseTexture) owned.add(cel.texture);
    }
    for (const [, ls] of this.layerStates) if (ls.baseTexture) owned.delete(ls.baseTexture);
    for (const t of owned) t.destroy();   // once each (a layer's own texture is its texture manager's)
    this.layerStates.clear();
    this.listeners = [];
  }
}
