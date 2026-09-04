import type { ManagerContext } from '../managers/manager-context';
import type { EphemeraService } from './ephemera-service';
import type { EphemeraPlacement } from './ephemera-types';
import type { PlacementHandleHit, PlacementResizeHandle } from '../../renderer/core/webgpu-renderer';
import { EventEmitter } from '../../renderer/util/event-emitter';

/** The few collaborators the overlay needs that don't live on {@link ManagerContext}. */
export interface EphemeraOverlayHost {
    /** The shared ephemera registry (owned by the facade — many subsystems read it). */
    readonly ephemera: EphemeraService;
    /** A package-owned vector layer changed → refresh its box composite (debounced). */
    markPackageVectorLayerDirty(layerId: string): void;
    /** True while the mesh-edit / UV focus background is up (opaque) → suppress the 2D overlay. */
    meshEditFocusHidesContent(): boolean;
}

/**
 * Ephemera SVG overlay + placement interaction — the live, non-destructive rendering of vector
 * ephemera placements on a 2D canvas above the WebGPU canvas, plus the hit-testing / select /
 * move / resize / rotate math for the placement transform handles.
 *
 * Extracted from ShapeManager (the facade keeps the pure `_ephemera` registry delegators, the shared
 * `_activeVectorLayerId`, and the rasterize-to-layer glue). Takes {@link ManagerContext} (interaction
 * service, renderer, rasterLayerManager, scheduleRender) + a narrow {@link EphemeraOverlayHost}. Method
 * bodies are the originals, verbatim, reached through the getters/bridges below.
 */
export class EphemeraOverlay {
    constructor(private readonly ctx: ManagerContext, private readonly host: EphemeraOverlayHost) {}

    // ── State (moved from ShapeManager) ───────────────────────────────
    private _ephemeraOverlayCtx: CanvasRenderingContext2D | null = null;
    private _ephemeraOverlayCache = new Map<string, { svg: string; img: HTMLImageElement; loaded: boolean }>();
    private _ephemeraOverlayUnsub: (() => void) | null = null;
    private _selectedPlacementLayerId: string | null = null;
    private _selectedPlacementId: string | null = null;
    /** Fires (with the selected placement id, or null) whenever placement selection changes — so the UI System
     *  can treat a selected ephemera like a selected shape (there's no scene-graph `onSelectionChanged` for these). */
    public readonly onPlacementSelectionChanged = new EventEmitter<string | null>();

    // ── Bridges so the moved method bodies stay byte-for-byte identical ─
    private get _ephemera(): EphemeraService { return this.host.ephemera; }
    private get interactionService() { return this.ctx.interactionService; }
    private get webgpuRenderer() { return this.ctx.webgpuRenderer; }
    private get rasterLayerManager() { return this.ctx.rasterLayerManager; }
    private scheduleRender(): void { this.ctx.scheduleRender(); }
    private _pkgVectorLayerDirty(layerId: string): void { this.host.markPackageVectorLayerDirty(layerId); }
    private getEphemeraDefaultParams(typeId: string): Record<string, unknown> { return this._ephemera.getDefaultParams(typeId); }
    private generateEphemera(typeId: string, params: Record<string, unknown>): string { return this._ephemera.generate(typeId, params); }

    /** Drop the cached placement <img> elements (call when a layer's placements are wiped). */
    invalidateCache(): void { this._ephemeraOverlayCache.clear(); }

    /**
     * Returns the world-space width and height that will display this ephemera
     * at its natural SVG pixel size at the current zoom level.
     * Use this as the default W/H when placing via "Place on Canvas".
     */
    public getDefaultPlacementSize(typeId: string): { width: number; height: number } {
        const params = this.getEphemeraDefaultParams(typeId);
        const svgStr = this.generateEphemera(typeId, params);
        const wMatch = svgStr.match(/<svg[^>]+\bwidth="([\d.]+)"/);
        const hMatch = svgStr.match(/<svg[^>]+\bheight="([\d.]+)"/);
        const svgPxW = wMatch ? parseFloat(wMatch[1]) : 160;
        const svgPxH = hMatch ? parseFloat(hMatch[1]) : 160;

        const canvas = this._ephemeraOverlayCtx?.canvas;
        if (!canvas) return { width: 0.5, height: 0.5 };

        const m = this.interactionService.getWorldMatrix() as Float32Array;
        const sx = Math.abs(m[0]) * canvas.width  * 0.5;
        const sy = Math.abs(m[5]) * canvas.height * 0.5;

        return { width: svgPxW / sx, height: svgPxH / sy };
    }

    /**
     * Set the 2D canvas used to render non-destructive ephemera placements on top
     * of the WebGPU canvas. The caller is responsible for positioning this canvas
     * absolutely over the WebGPU canvas at the same dimensions.
     * Pass null to detach.
     */
    public setEphemeraOverlayCanvas(canvas: HTMLCanvasElement | null): void {
        // Unsubscribe existing post-frame hook
        if (this._ephemeraOverlayUnsub) {
            this._ephemeraOverlayUnsub();
            this._ephemeraOverlayUnsub = null;
        }
        this._ephemeraOverlayCtx = canvas ? canvas.getContext('2d') : null;
        this._ephemeraOverlayCache.clear();

        if (canvas && this.webgpuRenderer) {
            this._ephemeraOverlayUnsub = this.webgpuRenderer.addPostFrameCallback(
                () => this._renderEphemeraOverlay(),
            );
        }
    }

    /** True if any visible placement exists on a visible layer (so callers can skip compositing when there's none). */
    public hasVisiblePlacements(): boolean {
        const all = this._ephemera.getAllPlacements();
        if (all.size === 0) return false;
        const layers = this.rasterLayerManager?.getLayers() ?? [];
        for (const [layerId, placements] of all) {
            if (!layers.find(l => l.id === layerId)?.visible) continue;
            if (placements.some(p => p.visible)) return true;
        }
        return false;
    }

    /**
     * Rasterize the ephemera placements (no selection handles) onto `ctx`, framing the artboard — world
     * [-worldW/2, worldW/2] × [-worldH/2, worldH/2] — to fill the outW×outH output (y-flipped, same convention as the
     * live overlay). Used to composite ephemera into the transparent artboard capture (they render on a DOM overlay,
     * NOT the WebGPU frame — see docs/specs/textured-artboard.md). Reuses the display cache; unloaded SVGs are skipped
     * (they're normally already loaded from on-screen display — a kicked-off load + scheduleRender picks them up next).
     */
    public rasterizePlacements(ctx: CanvasRenderingContext2D, worldW: number, worldH: number, outW: number, outH: number): void {
        const all = this._ephemera.getAllPlacements();
        if (all.size === 0 || worldW <= 0 || worldH <= 0) return;
        const layers = this.rasterLayerManager?.getLayers() ?? [];
        ctx.save();
        ctx.setTransform(outW / worldW, 0, 0, -outH / worldH, outW / 2, outH / 2);   // world → output px, artboard-centered, y-flipped
        for (const [layerId, placements] of all) {
            if (!layers.find(l => l.id === layerId)?.visible) continue;
            for (const p of placements) {
                if (!p.visible) continue;
                let cached = this._ephemeraOverlayCache.get(p.id);
                if (!cached || cached.svg !== p.svg) {
                    if (cached) URL.revokeObjectURL(cached.img.src);
                    const url = URL.createObjectURL(new Blob([p.svg], { type: 'image/svg+xml' }));
                    const img = new Image();
                    const entry = { svg: p.svg, img, loaded: false };
                    img.onload = () => { entry.loaded = true; this.scheduleRender(); };
                    img.src = url;
                    this._ephemeraOverlayCache.set(p.id, entry);
                    cached = entry;
                }
                if (!cached.loaded) continue;
                ctx.save();
                ctx.globalAlpha = p.opacity;
                ctx.globalCompositeOperation = (p.blendMode ?? 'source-over') as GlobalCompositeOperation;
                ctx.translate(p.x + p.width * 0.5, p.y + p.height * 0.5);
                if (p.rotation !== 0) ctx.rotate(p.rotation * Math.PI / 180);
                ctx.scale(1, -1);
                ctx.drawImage(cached.img, -p.width * 0.5, -p.height * 0.5, p.width, p.height);
                ctx.restore();
            }
        }
        ctx.restore();
    }

    private _renderEphemeraOverlay(): void {
        const ctx = this._ephemeraOverlayCtx;
        if (!ctx) return;
        const canvas = ctx.canvas;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Suppress the ephemera overlay while the mesh-edit / UV focus background is up
        // (opaque) — it's a separate 2D canvas on top of WebGPU, so it would otherwise
        // float over the clean mesh-editing/painting workspace. Cleared above → blank.
        if (this.host.meshEditFocusHidesContent()) return;

        const allPlacements = this._ephemera.getAllPlacements();
        if (allPlacements.size === 0) return;

        const layers = this.rasterLayerManager?.getLayers() ?? [];
        const worldMatrix = this.interactionService.getWorldMatrix() as Float32Array;
        const w = canvas.width, h = canvas.height;

        // Convert gl-matrix column-major mat4 (world → WebGPU clip space) to
        // a 2D canvas transform (world → screen pixels, y-axis flipped).
        const a =  worldMatrix[0] * 0.5 * w;
        const b = -worldMatrix[1] * 0.5 * h;
        const c =  worldMatrix[4] * 0.5 * w;
        const d = -worldMatrix[5] * 0.5 * h;
        const e = (worldMatrix[12] + 1) * 0.5 * w;
        const f = (1 - worldMatrix[13])  * 0.5 * h;

        ctx.save();
        ctx.setTransform(a, b, c, d, e, f);

        for (const [layerId, placements] of allPlacements) {
            const layerEntry = layers.find(l => l.id === layerId);
            if (!layerEntry?.visible) continue;

            for (const p of placements) {
                if (!p.visible) continue;

                // Get or refresh the cached HTMLImageElement for this placement's SVG.
                let cached = this._ephemeraOverlayCache.get(p.id);
                if (!cached || cached.svg !== p.svg) {
                    if (cached) URL.revokeObjectURL(cached.img.src);
                    const blob = new Blob([p.svg], { type: 'image/svg+xml' });
                    const url = URL.createObjectURL(blob);
                    const img = new Image();
                    const entry = { svg: p.svg, img, loaded: false };
                    img.onload = () => { entry.loaded = true; this.scheduleRender(); };
                    img.src = url;
                    this._ephemeraOverlayCache.set(p.id, entry);
                    cached = entry;
                }
                if (!cached.loaded) continue;

                ctx.save();
                ctx.globalAlpha = p.opacity;
                ctx.globalCompositeOperation = p.blendMode ?? 'source-over';
                ctx.translate(p.x + p.width * 0.5, p.y + p.height * 0.5);
                if (p.rotation !== 0) ctx.rotate(p.rotation * Math.PI / 180);
                ctx.scale(1, -1);
                ctx.drawImage(cached.img, -p.width * 0.5, -p.height * 0.5, p.width, p.height);
                ctx.restore();
            }
        }

        // ── Selection handles ────────────────────────────────────────
        const selLayerId = this._selectedPlacementLayerId;
        const selId = this._selectedPlacementId;
        if (selLayerId && selId) {
            const selPlacements = this._ephemera.getPlacementsForLayer(selLayerId);
            const sp = selPlacements.find(pl => pl.id === selId);
            const selLayer = layers.find(l => l.id === selLayerId);
            if (sp && selLayer?.visible && sp.visible) {
                const HANDLE_PX = 8;
                const ROTATE_OFFSET_PX = 28;
                const hw = (HANDLE_PX / 2) / a;
                const hh = (HANDLE_PX / 2) / Math.abs(d);
                const rotOffY = ROTATE_OFFSET_PX / Math.abs(d);

                const rad = sp.rotation * Math.PI / 180;
                const cos = Math.cos(rad), sin = Math.sin(rad);
                const cx = sp.x + sp.width * 0.5;
                const cy = sp.y + sp.height * 0.5;
                const hw2 = sp.width * 0.5, hh2 = sp.height * 0.5;

                const toWorld = (lx: number, ly: number): [number, number] =>
                    [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];

                // Dashed outline
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(rad);
                ctx.strokeStyle = 'rgba(60, 200, 255, 0.95)';
                ctx.lineWidth = 1.5 / a;
                ctx.setLineDash([4 / a, 3 / a]);
                ctx.strokeRect(-hw2, -hh2, sp.width, sp.height);
                ctx.setLineDash([]);
                ctx.restore();

                // 8 resize handles
                const handleOffsets: [number, number][] = [
                    [-hw2, -hh2], [0, -hh2], [hw2, -hh2],
                    [-hw2, 0],               [hw2, 0],
                    [-hw2, +hh2], [0, +hh2], [hw2, +hh2],
                ];
                for (const [lx, ly] of handleOffsets) {
                    const [wx2, wy2] = toWorld(lx, ly);
                    ctx.save();
                    ctx.translate(wx2, wy2);
                    ctx.rotate(rad);
                    ctx.fillStyle = 'white';
                    ctx.strokeStyle = 'rgba(60, 200, 255, 0.95)';
                    ctx.lineWidth = 1 / a;
                    ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
                    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
                    ctx.restore();
                }

                // Rotation handle: stem + circle
                const [tcx, tcy] = toWorld(0, -hh2);
                const [rotX, rotY] = toWorld(0, -hh2 - rotOffY);
                ctx.beginPath();
                ctx.strokeStyle = 'rgba(60, 200, 255, 0.95)';
                ctx.lineWidth = 1.5 / a;
                ctx.moveTo(tcx, tcy);
                ctx.lineTo(rotX, rotY);
                ctx.stroke();

                ctx.beginPath();
                ctx.fillStyle = 'white';
                ctx.strokeStyle = 'rgba(60, 200, 255, 0.95)';
                ctx.lineWidth = 1 / a;
                ctx.ellipse(rotX, rotY, hw * 1.5, hh * 1.5, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    public getSelectedPlacement(): { layerId: string; placementId: string } | null {
        if (!this._selectedPlacementLayerId || !this._selectedPlacementId) return null;
        return { layerId: this._selectedPlacementLayerId, placementId: this._selectedPlacementId };
    }

    public selectPlacement(layerId: string, placementId: string): void {
        const changed = this._selectedPlacementId !== placementId;
        this._selectedPlacementLayerId = layerId;
        this._selectedPlacementId = placementId;
        if (changed) this.onPlacementSelectionChanged.emit(placementId);
        this.scheduleRender();
    }

    public clearPlacementSelection(): void {
        const had = this._selectedPlacementId !== null;
        this._selectedPlacementLayerId = null;
        this._selectedPlacementId = null;
        if (had) this.onPlacementSelectionChanged.emit(null);
    }

    /**
     * Hit-test world-space point (worldX, worldY) against all visible ephemera placements.
     * Returns the topmost hit, or null. Accounts for placement rotation.
     */
    public hitTestEphemeraPlacement(
        worldX: number,
        worldY: number,
    ): { layerId: string; placementId: string; x: number; y: number } | null {
        const layers = this.rasterLayerManager?.getLayers() ?? [];
        for (const [layerId, placements] of this._ephemera.getAllPlacements()) {
            const layer = layers.find(l => l.id === layerId);
            if (!layer?.visible) continue;
            // Iterate in reverse so topmost placement (last in array) is checked first
            for (let i = placements.length - 1; i >= 0; i--) {
                const p = placements[i];
                if (!p.visible) continue;
                if (this._placementContainsPoint(p, worldX, worldY)) {
                    return { layerId, placementId: p.id, x: p.x, y: p.y };
                }
            }
        }
        return null;
    }

    private _placementContainsPoint(p: EphemeraPlacement, wx: number, wy: number): boolean {
        const cx = p.x + p.width  * 0.5;
        const cy = p.y + p.height * 0.5;
        const dx = wx - cx;
        const dy = wy - cy;
        if (p.rotation === 0) {
            return Math.abs(dx) <= p.width * 0.5 && Math.abs(dy) <= p.height * 0.5;
        }
        const rad = p.rotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const lx =  dx * cos + dy * sin;
        const ly = -dx * sin + dy * cos;
        return Math.abs(lx) <= p.width * 0.5 && Math.abs(ly) <= p.height * 0.5;
    }

    /** Move a placement to a new position (called by the renderer drag handler). */
    public movePlacementTo(layerId: string, placementId: string, newX: number, newY: number): void {
        this._ephemera.updatePlacement(layerId, placementId, { x: newX, y: newY });
        this._pkgVectorLayerDirty(layerId);   // debounced — a drag settles into one proxy re-render
        this.scheduleRender();
    }

    /**
     * Hit-test the transform handles of the currently selected placement.
     * Returns a PlacementHandleHit describing which handle was hit, or null.
     * Called by the renderer before the placement body hit-test.
     */
    public hitTestPlacementHandle(wx: number, wy: number): PlacementHandleHit | null {
        if (!this._selectedPlacementLayerId || !this._selectedPlacementId) return null;
        const p = this._ephemera.getPlacementsForLayer(this._selectedPlacementLayerId)
            .find(pl => pl.id === this._selectedPlacementId);
        if (!p || !p.visible) return null;

        // Compute world-space handle half-size (fixed 12 screen-px hit area)
        const HANDLE_HIT_PX = 12;
        const ROTATE_OFFSET_PX = 28;
        const wm = this.interactionService.getWorldMatrix() as Float32Array;
        const cw = this._ephemeraOverlayCtx?.canvas.width ?? this.interactionService.canvas.width;
        const scaleX = wm[0] * 0.5 * cw;
        const ch = this._ephemeraOverlayCtx?.canvas.height ?? this.interactionService.canvas.height;
        const scaleY = Math.abs(wm[5]) * 0.5 * ch;
        const hw = (HANDLE_HIT_PX / 2) / scaleX;
        const hh = (HANDLE_HIT_PX / 2) / scaleY;
        const rotOffY = ROTATE_OFFSET_PX / scaleY;

        const rad = p.rotation * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const cx = p.x + p.width * 0.5;
        const cy = p.y + p.height * 0.5;
        const hw2 = p.width * 0.5, hh2 = p.height * 0.5;

        const toWorld = (lx: number, ly: number): [number, number] =>
            [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];

        // Rotation handle (circle) — check first since it's outside the placement bounds
        const [rotX, rotY] = toWorld(0, -hh2 - rotOffY);
        const dxR = wx - rotX, dyR = wy - rotY;
        const rotRadius = Math.max(hw, hh) * 1.5;
        if (dxR * dxR + dyR * dyR <= rotRadius * rotRadius) {
            return {
                kind: 'rotate',
                layerId: this._selectedPlacementLayerId,
                placementId: this._selectedPlacementId,
                centerX: cx, centerY: cy,
                startAngle: Math.atan2(wy - cy, wx - cx),
                startRotation: p.rotation,
            };
        }

        // Resize handles — AABB test in handle-local (rotated) space
        const resizeHandles: [PlacementResizeHandle, number, number][] = [
            ['TL', -hw2, -hh2], ['TC',    0, -hh2], ['TR', +hw2, -hh2],
            ['ML', -hw2,    0],                      ['MR', +hw2,    0],
            ['BL', -hw2, +hh2], ['BC',    0, +hh2], ['BR', +hw2, +hh2],
        ];
        // Anchor local offsets (opposite corner/edge for each handle)
        const anchorOffsets: Record<PlacementResizeHandle, [number, number]> = {
            'TL': [+hw2, +hh2], 'TC': [0, +hh2], 'TR': [-hw2, +hh2],
            'ML': [+hw2,    0],                   'MR': [-hw2,    0],
            'BL': [+hw2, -hh2], 'BC': [0, -hh2], 'BR': [-hw2, -hh2],
        };

        for (const [handle, lx, ly] of resizeHandles) {
            const [hx, hy] = toWorld(lx, ly);
            const dx = wx - hx, dy = wy - hy;
            // Unrotate test point into the handle's local frame
            const hlx =  dx * cos + dy * sin;
            const hly = -dx * sin + dy * cos;
            if (Math.abs(hlx) <= hw && Math.abs(hly) <= hh) {
                const [ax, ay] = toWorld(...anchorOffsets[handle]);
                return {
                    kind: 'resize',
                    layerId: this._selectedPlacementLayerId,
                    placementId: this._selectedPlacementId,
                    handle, anchorX: ax, anchorY: ay,
                };
            }
        }

        return null;
    }

    /** Apply a resize drag: recomputes x/y/width/height while pinning the anchor corner/edge. */
    public applyPlacementResize(
        layerId: string, placementId: string,
        handle: PlacementResizeHandle,
        anchorX: number, anchorY: number,
        dragX: number, dragY: number,
    ): void {
        const p = this._ephemera.getPlacementsForLayer(layerId).find(pl => pl.id === placementId);
        if (!p) return;

        const MIN_SIZE = 0.005;
        const rad = p.rotation * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);

        // New center = midpoint of fixed anchor and drag point
        const newCx = (anchorX + dragX) * 0.5;
        const newCy = (anchorY + dragY) * 0.5;

        // Compute local half-extents from (drag - new_center) rotated to local space
        const dx = dragX - newCx, dy = dragY - newCy;
        const lx = dx * cos + dy * sin;
        const ly = -dx * sin + dy * cos;

        let newW = p.width, newH = p.height;
        if (handle === 'TC' || handle === 'BC') {
            newH = Math.max(MIN_SIZE, Math.abs(ly) * 2);
        } else if (handle === 'ML' || handle === 'MR') {
            newW = Math.max(MIN_SIZE, Math.abs(lx) * 2);
        } else {
            newW = Math.max(MIN_SIZE, Math.abs(lx) * 2);
            newH = Math.max(MIN_SIZE, Math.abs(ly) * 2);
        }

        this._ephemera.updatePlacement(layerId, placementId, {
            x: newCx - newW * 0.5,
            y: newCy - newH * 0.5,
            width: newW,
            height: newH,
        });
        this._pkgVectorLayerDirty(layerId);
        this.scheduleRender();
    }

    /** Apply a rotate drag: updates rotation from angular delta around the placement center. */
    public applyPlacementRotate(
        layerId: string, placementId: string,
        centerX: number, centerY: number,
        startAngle: number, startRotation: number,
        dragX: number, dragY: number,
    ): void {
        const currentAngle = Math.atan2(dragY - centerY, dragX - centerX);
        const delta = (currentAngle - startAngle) * (180 / Math.PI);
        this._ephemera.updatePlacement(layerId, placementId, { rotation: startRotation + delta });
        this._pkgVectorLayerDirty(layerId);
        this.scheduleRender();
    }
}
