import type { ManagerContext } from './manager-context';
import { LiveTextNode, type LiveTextOptions } from '../../scene-graph/shapes/live-text';
import { TextEffectEngine, type TextEffectConfig } from '../../renderer/raster/effects/text-effect-engine';

/** Collaborators the LiveText subsystem needs that don't live on {@link ManagerContext}. */
export interface LiveTextHost {
    /** The active vector layer to tag new nodes onto (shared facade state; read-only here). */
    getActiveVectorLayerId(): string | null;
    /** The facade-owned TextEffectEngine (LiveText wires it into each node's effect chain). */
    getTextEffectEngine(): TextEffectEngine | null;
}

/**
 * LiveTextNode management — create / style / edit / flatten the interactive HTML-in-Canvas text nodes.
 *
 * Extracted from ShapeManager. Takes {@link ManagerContext} (shapeFactory, renderer, interaction service,
 * scene graph, rasterLayerManager, scheduleRender, emitSceneGraphChanged) + a narrow {@link LiveTextHost}
 * (2 hooks). Method bodies are the originals verbatim, reached through the getters/bridges below. The
 * facade keeps thin delegators + the TextEffectEngine + the custom-WGSL-shader methods.
 */
export class LiveTextManager {
    constructor(private readonly ctx: ManagerContext, private readonly host: LiveTextHost) {}

    /** Tracks the node ID of the LiveTextNode currently in edit mode, or null. */
    private _editingLiveTextId: string | null = null;
    /** The node ID of the LiveTextNode currently being edited, or null (for the facade's input-active checks). */
    get editingLiveTextId(): string | null { return this._editingLiveTextId; }

    // ── Bridges so the moved method bodies stay byte-for-byte identical ─
    private get shapeFactory() { return this.ctx.shapeFactory; }
    private get webgpuRenderer() { return this.ctx.webgpuRenderer; }
    private get interactionService() { return this.ctx.interactionService; }
    private get sceneGraph() { return this.ctx.sceneGraph; }
    private get rasterLayerManager() { return this.ctx.rasterLayerManager; }
    private get _activeVectorLayerId(): string | null { return this.host.getActiveVectorLayerId(); }
    private scheduleRender(): void { this.ctx.scheduleRender(); }
    private emitSceneGraphChanged(): void { this.ctx.emitSceneGraphChanged(); }
    private getTextEffectEngine(): TextEffectEngine | null { return this.host.getTextEffectEngine(); }

    public createLiveText(x: number, y: number, options?: LiveTextOptions): LiveTextNode {
        // Auto-end any previous editing session before creating a new node
        if (this._editingLiveTextId) {
            this.endLiveTextEditing(this._editingLiveTextId);
        }

        const node = this.shapeFactory.createLiveText(x, y, options);

        // Wire up the TextEffectEngine
        const engine = this.getTextEffectEngine();
        if (engine) node.setEngine(engine);

        // Compute world-units-per-pixel from illustration bounds and raster pixel size.
        // This ensures LiveText sizing matches the raster layer (flatten result).
        const illBounds = this.webgpuRenderer?.getIllustrationBounds?.();
        const pixelSize = this.webgpuRenderer?.getIllustrationPixelSize?.();
        const canvas = this.interactionService?.canvas;
        if (illBounds && pixelSize) {
            // worldWidth / rasterPixelWidth (e.g., 1.5 / 963 ≈ 0.00156)
            node.worldUnitsPerPixel = illBounds.width / pixelSize.w;
        } else if (canvas) {
            // Fallback: use canvas dimensions. Visible Y range is ~2 world units at zoom=1.
            node.worldUnitsPerPixel = 2 / canvas.height;
        }

        // Pre-size from the frame/font so the node doesn't flash at the default unit size
        // (≈1 world unit) before the first async HTML capture lands.
        node.applyInitialSize();

        // Initialize DOM element if HTML-in-Canvas is available
        if (canvas && TextEffectEngine.htmlInCanvasAvailable()) {
            // The HTML-in-Canvas API requires the layoutsubtree attribute
            if (!canvas.hasAttribute('layoutsubtree')) {
                canvas.setAttribute('layoutsubtree', '');
            }
            node.initDomElement(canvas);
            // Request a paint so the element gets a paint record before the next frame
            TextEffectEngine.requestPaint(canvas);
        }

        // Capture the initial texture so dimensions are correct before the node
        // enters the scene graph. Without this the bounding box starts at the
        // constructor defaults (1 × 0.5) and visibly jumps on the next frame.
        node.updateTexture();

        // Add to scene — tie to the active vector layer, else the default one (so it gates by layer like other shapes).
        const vecLayer = this._activeVectorLayerId ?? this.rasterLayerManager?.getDefaultVectorLayerId();
        if (vecLayer) node.layerId = vecLayer;
        this.sceneGraph.root.addChild(node);
        this.interactionService.clearSelectedNodes();
        this.interactionService.selectNode(node);
        this.emitSceneGraphChanged();

        // Start continuous rendering if initial effects need animation
        if (node.needsAnimation) this.webgpuRenderer?.beginInteractive();

        return node;
    }

    public createLiveTextInRect(
        rect: { x: number; y: number; w: number; h: number },
        options?: LiveTextOptions,
    ): LiveTextNode {
        const illBounds = this.webgpuRenderer?.getIllustrationBounds?.();
        const pixelSize = this.webgpuRenderer?.getIllustrationPixelSize?.();
        // World units per pixel — same basis createLiveText uses, so px ↔ world match.
        const wupp = (illBounds && pixelSize) ? (illBounds.width / pixelSize.w) : (1 / 100);
        const frameWidth = Math.max(1, Math.round(Math.abs(rect.w) / wupp));   // CSS px
        const frameHeight = Math.max(1, Math.round(Math.abs(rect.h) / wupp));  // CSS px
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        return this.createLiveText(cx, cy, { ...options, frameWidth, frameHeight });
    }

    public setRectDrawCallback(
        cb: ((rect: { x: number; y: number; w: number; h: number }, clientX: number, clientY: number) => void) | null,
    ): void {
        this.interactionService.rectDrawCallback = cb;
        if (!cb) this.interactionService.hoveredLiveTextId = null;
        this.scheduleRender();
    }

    public setLiveTextEffects(nodeId: string, effects: TextEffectConfig[]): void {
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            const wasAnimated = node.needsAnimation;
            node.setEffects(effects);
            const isAnimated = node.needsAnimation;
            // Enter/exit continuous rendering based on whether effects animate
            if (isAnimated && !wasAnimated) this.webgpuRenderer?.beginInteractive();
            if (!isAnimated && wasAnimated) this.webgpuRenderer?.endInteractive();
            this.scheduleRender();
        }
    }

    public setLiveTextContent(nodeId: string, text: string): void {
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            node.text = text;
            this.scheduleRender();
        }
    }

    public setLiveTextStyle(nodeId: string, style: Partial<LiveTextOptions>): void {
        const node = this.findLiveTextNode(nodeId);
        if (!node) return;
        if (style.font !== undefined) node.font = style.font;
        if (style.fontSize !== undefined) node.fontSize = style.fontSize;
        if (style.color !== undefined) node.textColor = style.color;
        if (style.bold !== undefined) node.bold = style.bold;
        if (style.italic !== undefined) node.italic = style.italic;
        if (style.writingMode !== undefined) node.writingMode = style.writingMode;
        if (style.maxWidth !== undefined) node.maxWidth = style.maxWidth;
        if (style.lineHeight !== undefined) node.lineHeight = style.lineHeight;
        if (style.padding !== undefined) node.padding = style.padding;
        if (style.backgroundColor !== undefined) node.backgroundColor = style.backgroundColor;
        if (style.align !== undefined) node.align = style.align;
        if (style.arcAngle !== undefined) node.arcAngle = style.arcAngle;
        if (style.frameWidth !== undefined || style.frameHeight !== undefined) {
            node.setFrame(style.frameWidth ?? node.frameWidth, style.frameHeight ?? node.frameHeight);
        }
        this.scheduleRender();
    }

    public beginLiveTextEditing(nodeId: string): void {
        // Auto-end any previous editing session
        if (this._editingLiveTextId && this._editingLiveTextId !== nodeId) {
            this.endLiveTextEditing(this._editingLiveTextId);
        }

        const node = this.findLiveTextNode(nodeId);
        if (node) {
            // Wire onChange so each keystroke schedules a render frame
            node.onChange = () => this.scheduleRender();
            node.beginEditing();
            this._editingLiveTextId = nodeId;
            // Enter continuous rendering mode for the editing session
            // (handles cursor blink, IME composition, HTML-in-Canvas repaints)
            this.webgpuRenderer?.beginInteractive();
        }
    }

    public enterLiveTextEditingAt(nodeId: string, clientX: number, clientY: number): void {
        if (this._editingLiveTextId && this._editingLiveTextId !== nodeId) {
            this.endLiveTextEditing(this._editingLiveTextId);
        }
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            node.onChange = () => this.scheduleRender();
            node.enterEditAt(clientX, clientY);
            this._editingLiveTextId = nodeId;
            this.webgpuRenderer?.beginInteractive();
        }
    }

    public endLiveTextEditing(nodeId: string): void {
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            node.endEditing();
            node.onChange = undefined;
            if (this._editingLiveTextId === nodeId) {
                this._editingLiveTextId = null;
            }
            // Auto-remove a node left empty (clicked but never typed, or fully backspaced)
            // so the canvas doesn't accumulate invisible empty text boxes.
            if (!node.text.trim()) {
                this.interactionService.deselectNode(node);
                if (node.parent) node.parent.removeChild(node);
                else this.sceneGraph.root.removeChild(node);
                node.destroy();
                this.webgpuRenderer?.endInteractive();
                this.scheduleRender();
                return;
            }
            // Deselect the node so Frogmarks' next click doesn't
            // mistake it for a hit-test result and re-enter editing
            // instead of creating a new node.
            this.interactionService.deselectNode(node);
            this.webgpuRenderer?.endInteractive();
            this.scheduleRender();
        }
    }

    public async flattenLiveText(nodeId: string): Promise<boolean> {
        const node = this.findLiveTextNode(nodeId);
        if (!node || !this.rasterLayerManager) return false;
        const device = this.webgpuRenderer?.getDevice();
        if (!device) return false;

        const tex = node.getCurrentTexture();
        if (!tex) return false;

        const activeLayerId = this.rasterLayerManager.getSelectedLayerId();
        if (!activeLayerId) return false;
        const activeLayer = this.rasterLayerManager.getLayerById(activeLayerId);
        if (!activeLayer?.texture) return false;

        // Convert world position to texel position
        const texW = activeLayer.texture.width;
        const texH = activeLayer.texture.height;

        // Simple mapping: node center in world → texel coords
        // Assuming illustration bounds centered at origin, texture covers full bounds
        const illBounds = this.webgpuRenderer?.getIllustrationBounds?.();
        const worldW = illBounds?.width ?? 2;
        const worldH = illBounds?.height ?? 2;

        const destX = Math.round(((node.x + worldW / 2) / worldW) * texW - tex.width / 2);
        // World Y is up, texture Y is down — negate node.y
        const destY = Math.round(((-node.y + worldH / 2) / worldH) * texH - tex.height / 2);

        const srcW = Math.min(tex.width, texW - Math.max(0, destX));
        const srcH = Math.min(tex.height, texH - Math.max(0, destY));
        if (srcW <= 0 || srcH <= 0) return false;

        const enc = device.createCommandEncoder();
        enc.copyTextureToTexture(
            { texture: tex, origin: [0, 0, 0] },
            { texture: activeLayer.texture, origin: [Math.max(0, destX), Math.max(0, destY), 0] },
            { width: srcW, height: srcH },
        );
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();

        // End editing if this node was being edited
        if (this._editingLiveTextId === nodeId) {
            this.endLiveTextEditing(nodeId);
        }

        // Remove the LiveTextNode from the scene
        const wasAnimated = node.needsAnimation;
        node.destroy();
        this.sceneGraph.root.removeChild(node);
        if (wasAnimated) this.webgpuRenderer?.endInteractive();
        this.emitSceneGraphChanged();
        this.scheduleRender();
        return true;
    }

    public getLiveTextNode(nodeId: string): LiveTextNode | null {
        return this.findLiveTextNode(nodeId);
    }

    private findLiveTextNode(nodeId: string): LiveTextNode | null {
        let found: LiveTextNode | null = null;
        this.sceneGraph.root.forEachDeep((n) => {
            if (found) return;
            if (n instanceof LiveTextNode && (n as LiveTextNode).id === nodeId) {
                found = n as LiveTextNode;
            }
        });
        return found;
    }
}
