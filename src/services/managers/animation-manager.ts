/**
 * AnimationManager — Delegate for timeline and cel animation operations.
 *
 * Handles:
 *  - Timeline frame navigation and playback
 *  - Cel operations (add, delete, duplicate, move, swap)
 *  - Onion skinning
 *  - Loop modes and play ranges
 *
 * Frogmarks can access this via `shapeManager.animation`.
 */

import type { ManagerContext } from './manager-context';
import type { RasterLayerManager } from '../raster-layer-manager';
import type { OnionSkinConfig } from '../../animation';

export class AnimationManager {
    private ctx: ManagerContext;
    private _playbackUnsub?: () => void;
    private _sync3DPlayback?: (playing: boolean) => void;

    constructor(ctx: ManagerContext) {
        this.ctx = ctx;
    }

    /** Register a callback that fires whenever raster playback starts or stops. */
    set3DPlaybackSync(cb: (playing: boolean) => void): void {
        this._sync3DPlayback = cb;
    }

    private get layerMgr(): RasterLayerManager | undefined { return this.ctx.rasterLayerManager; }

    private syncRendererFrame(): void {
        if (this.ctx.webgpuRenderer) {
            (this.ctx.webgpuRenderer as any).currentAnimationFrame =
                this.layerMgr?.getTimeline().getCurrentFrame() ?? 1;
        }
    }

    setEnabled(enabled: boolean): void { this.layerMgr?.setAnimationEnabled(enabled); }
    isEnabled(): boolean { return this.layerMgr?.isAnimationEnabled() ?? false; }

    setCurrentFrame(frame: number): void {
        this.layerMgr?.getTimeline().setCurrentFrame(frame);
        if (this.ctx.webgpuRenderer) (this.ctx.webgpuRenderer as any).currentAnimationFrame = frame;
        this.ctx.scheduleRender();
    }

    getCurrentFrame(): number { return this.layerMgr?.getTimeline().getCurrentFrame() ?? 1; }
    getFrameCount(): number { return this.layerMgr?.getTimeline().getFrameCount() ?? 1; }
    setFrameCount(count: number): void { this.layerMgr?.getTimeline().setFrameCount(count); }
    setPlayRange(start: number, end: number): void { this.layerMgr?.getTimeline().setPlayRange(start, end); }

    getPlayRange(): { start: number; end: number } {
        const state = this.layerMgr?.getTimeline().getState();
        return { start: state?.playRangeStart ?? 1, end: state?.playRangeEnd ?? 1 };
    }

    getFps(): number { return this.layerMgr?.getTimeline().getFps() ?? 12; }
    setFps(fps: number): void { this.layerMgr?.getTimeline().setFps(fps); }
    addFrames(count: number): void { this.layerMgr?.getTimeline().addFrames(count); }
    insertFrame(at: number): void { this.layerMgr?.getTimeline().insertFrame(at); }
    deleteFrame(at: number): void { this.layerMgr?.getTimeline().deleteFrame(at); }

    nextFrame(): void { this.layerMgr?.getTimeline().nextFrame(); this.syncRendererFrame(); this.ctx.scheduleRender(); }
    prevFrame(): void { this.layerMgr?.getTimeline().prevFrame(); this.syncRendererFrame(); this.ctx.scheduleRender(); }

    play(): void {
        const timeline = this.layerMgr?.getTimeline();
        if (!timeline) return;
        this._playbackUnsub?.();
        this._playbackUnsub = timeline.on((e) => {
            if (e.type === 'frame-changed') { this.syncRendererFrame(); this.ctx.scheduleRender(); }
        });
        timeline.play();
        this._sync3DPlayback?.(true);
    }

    pause(): void {
        this.layerMgr?.getTimeline().pause();
        this._sync3DPlayback?.(false);
    }

    stopPlayback(): void {
        this.layerMgr?.getTimeline().stop();
        this.syncRendererFrame();
        this.ctx.scheduleRender();
        this._sync3DPlayback?.(false);
    }

    togglePlayPause(): void {
        const timeline = this.layerMgr?.getTimeline();
        if (!timeline) return;
        if (timeline.getState().playbackState === 'playing') this.pause();
        else this.play();
    }

    setLayerAnimated(layerId: string, animated: boolean): boolean { return this.layerMgr?.setLayerAnimated(layerId, animated) ?? false; }
    isLayerAnimated(layerId: string): boolean { return this.layerMgr?.isLayerAnimated(layerId) ?? false; }

    addCelAtCurrentFrame(layerId: string): string | null {
        const result = this.layerMgr?.addCelAtCurrentFrame(layerId) ?? null;
        if (result) this.ctx.scheduleRender();
        return result;
    }

    addCelAtFrame(layerId: string, frame: number): string | null {
        const result = this.layerMgr?.addCelAtFrame(layerId, frame) ?? null;
        if (result) this.ctx.scheduleRender();
        return result;
    }

    deleteCel(layerId: string, celId: string): boolean {
        const result = this.layerMgr?.deleteCel(layerId, celId) ?? false;
        if (result) this.ctx.scheduleRender();
        return result;
    }

    setLoopMode(mode: 'none' | 'loop' | 'ping-pong'): void { this.layerMgr?.getTimeline().setLoopMode(mode); }

    setOnionSkin(config: Partial<OnionSkinConfig>): void { this.layerMgr?.setOnionSkinConfig(config); this.ctx.scheduleRender(); }
    getOnionSkin(): OnionSkinConfig | null { return this.layerMgr?.getOnionSkinConfig() ?? null; }

    getTimelineState() { return this.layerMgr?.getTimeline().getState() ?? null; }

    onEvent(listener: (event: { type: string; frame?: number; layerId?: string; celId?: string }) => void): () => void {
        const timeline = this.layerMgr?.getTimeline();
        if (!timeline) return () => {};
        return timeline.on(listener);
    }

    duplicateCel(layerId: string, celId: string, targetFrame: number): string | null { return this.layerMgr?.duplicateCel(layerId, celId, targetFrame) ?? null; }
    moveCel(layerId: string, celId: string, targetFrame: number): boolean { return this.layerMgr?.moveCel(layerId, celId, targetFrame) ?? false; }
    swapCels(layerId: string, celIdA: string, celIdB: string): boolean { return this.layerMgr?.swapCels(layerId, celIdA, celIdB) ?? false; }
    setCelDuration(layerId: string, celId: string, duration: number): boolean { return this.layerMgr?.setCelDuration(layerId, celId, duration) ?? false; }
    setCelType(layerId: string, celId: string, type: 'key' | 'inbetween'): boolean { return this.layerMgr?.setCelType(layerId, celId, type) ?? false; }
    getCels(layerId: string): Array<{ id: string; startFrame: number; duration: number; celType: 'key' | 'inbetween' }> { return this.layerMgr?.getCels(layerId) ?? []; }
}
