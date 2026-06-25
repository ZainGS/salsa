/**
 * TextManager — Delegate for all text-related operations.
 *
 * Handles:
 *  - SDF text drawing tool (enable/disable, properties)
 *  - LiveTextNode creation and editing
 *  - Text effect engine (capture, apply, custom shaders)
 *  - Input-active detection
 *
 * Frogmarks can access this via `shapeManager.text`.
 */

import type { ManagerContext } from './manager-context';
import type { SdfTextDrawingService } from '../drawing/sdftext-drawing-service';
import type { TextDrawingService } from '../drawing/text-drawing-service';
import type { RasterLayerManager } from '../raster-layer-manager';
import type { RasterTextService } from '../raster-text-service';
import { hexToRgba } from '../../utils/color';
import { RGBA } from '../../types/rgba';
import { TextEffectEngine, TextEffectType, TextEffectConfig, TextEffectParams, TextCaptureConfig, CustomShaderParams, CustomShaderCompileResult } from '../../renderer/raster/effects/text-effect-engine';
import { LiveTextNode, LiveTextOptions } from '../../scene-graph/shapes/live-text';
import { SDFText } from '../../scene-graph/shapes/sdf-text/sdf-text';
import { StickyNote } from '../../scene-graph/shapes/sticky-note';
import { Shape } from '../../scene-graph/shapes/base/shape';

export class TextManager {
    private ctx: ManagerContext;
    private _sdfTextDrawingService!: SdfTextDrawingService;
    private _textDrawingService!: TextDrawingService;
    private _rasterTextService?: RasterTextService;
    private _textEffectEngine?: TextEffectEngine;
    private _editingLiveTextId: string | null = null;

    constructor(ctx: ManagerContext) {
        this.ctx = ctx;
    }

    // ── Service injection ────────────────────────────────────────────

    setSdfTextDrawingService(svc: SdfTextDrawingService): void { this._sdfTextDrawingService = svc; }
    setTextDrawingService(svc: TextDrawingService): void { this._textDrawingService = svc; }
    setRasterTextService(svc: RasterTextService): void { this._rasterTextService = svc; }

    // ── SDF Text Tool ────────────────────────────────────────────────

    enableSDFTextDrawing(): void { this._sdfTextDrawingService.enable(); this.ctx.beginInteractive(); }
    disableSDFTextDrawing(): void { this._sdfTextDrawingService.disable(); this.ctx.endInteractive(); }
    isSDFTextDrawingInProgress(): boolean { return this._sdfTextDrawingService.isUserTyping(); }

    setSDFTextColor(color: string): void { this._sdfTextDrawingService.setTextColor(hexToRgba(color)); this.ctx.scheduleRender(); }
    setSDFTextOutlineColor(color: string): void { this._sdfTextDrawingService.setOutlineColor(hexToRgba(color)); this.ctx.scheduleRender(); }
    setSDFTextFontSize(size: number): void { this._sdfTextDrawingService.setFontSize(size); this.ctx.scheduleRender(); }
    setSDFTextFont(font: string): void { this._sdfTextDrawingService.setFont(font); this.ctx.scheduleRender(); }
    setSDFTextThreshold(threshold: number): void { this._sdfTextDrawingService.setSDFThreshold(threshold); this.ctx.scheduleRender(); }
    setSDFTextSmoothing(smoothing: number): void { this._sdfTextDrawingService.setSmoothing(smoothing); this.ctx.scheduleRender(); }
    setSDFTextOutlineWidth(width: number): void { this._sdfTextDrawingService.setOutlineWidth(width); this.ctx.scheduleRender(); }
    setSDFTextMaxWidth(worldUnits: number): void { this._sdfTextDrawingService.setMaxWidth(worldUnits); this.ctx.scheduleRender(); }

    updateSDFText(nodeId: string, props: Partial<{
        text: string; font: string; fontSize: number; lineHeight: number; maxWidth: number;
        fill: string | RGBA; outline: string | RGBA; outlineWidth: number; threshold: number; smoothing: number;
    }>): void {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        if ((node as Shape).getType() === 'Sticky Note') {
            const note = node as StickyNote;
            if (props.text !== undefined) note.setText(props.text);
            if (props.font !== undefined) note.setFont(props.font);
            if (props.fontSize !== undefined) note.setFontSize(props.fontSize);
            if (props.lineHeight !== undefined) note.setLineHeight(props.lineHeight);
            note.markDirty?.();
            this.ctx.emitSceneGraphChanged();
            return;
        }
        if (!node || (node as Shape).getType() !== 'SDFText') return;
        const sdf = node as SDFText;
        if (props.font !== undefined) sdf.font = props.font;
        if (props.fontSize !== undefined) sdf.fontSize = props.fontSize;
        if (props.lineHeight !== undefined) sdf.lineHeight = props.lineHeight;
        if (props.fill !== undefined) sdf.strokeColor = typeof props.fill === 'string' ? hexToRgba(props.fill) : props.fill;
        if (props.outline !== undefined) sdf.outlineColor = typeof props.outline === 'string' ? hexToRgba(props.outline) : props.outline;
        if (props.outlineWidth !== undefined) sdf.outlineWidth = props.outlineWidth;
        if (props.threshold !== undefined) sdf.sdfThreshold = props.threshold;
        if (props.smoothing !== undefined) sdf.smoothing = props.smoothing;
        if (props.maxWidth !== undefined) sdf.setMaxWidth(props.maxWidth);
        if (props.text !== undefined) sdf.setText(props.text);
        else sdf.refreshText();
        sdf.isDirty = true;
        this.ctx.emitSceneGraphChanged();
    }

    // ── Input Active ─────────────────────────────────────────────────

    isInputActive(): boolean {
        return this._sdfTextDrawingService.isUserTyping()
            || this._textDrawingService.isUserTyping()
            || (this._rasterTextService?.getState()?.isActive ?? false)
            || this._editingLiveTextId != null;
    }

    getEditingLiveTextId(): string | null { return this._editingLiveTextId; }

    // ── Text Effect Engine ───────────────────────────────────────────

    getTextEffectEngine(): TextEffectEngine | null {
        const device = this.ctx.webgpuRenderer?.getDevice();
        if (!device) return null;
        if (!this._textEffectEngine) this._textEffectEngine = new TextEffectEngine(device);
        return this._textEffectEngine;
    }

    captureTextToTexture(config: TextCaptureConfig): { texture: GPUTexture; width: number; height: number } | null {
        return this.getTextEffectEngine()?.captureText(config) ?? null;
    }

    isHtmlInCanvasAvailable(): boolean { return TextEffectEngine.htmlInCanvasAvailable(); }
    getHtmlInCanvasMode(): 'webgpu-native' | 'webgl-bridge' | 'none' { return TextEffectEngine.htmlInCanvasMode(); }

    setupHtmlInCanvas(onPaint?: (changedElements: Element[]) => void): (() => void) | null {
        const canvas = this.ctx.interactionService?.canvas;
        if (!canvas) return null;
        return TextEffectEngine.setupCanvasForHtmlCapture(canvas, onPaint);
    }

    requestHtmlPaint(): void {
        const canvas = this.ctx.interactionService?.canvas;
        if (canvas) TextEffectEngine.requestPaint(canvas);
    }

    captureElementToTexture(element: HTMLElement, hostCanvas?: HTMLCanvasElement): { texture: GPUTexture; width: number; height: number } | null {
        return this.getTextEffectEngine()?.captureElement(element, hostCanvas) ?? null;
    }

    applyTextEffect(src: GPUTexture, effect: TextEffectType, params: TextEffectParams): GPUTexture | null {
        return this.getTextEffectEngine()?.apply(src, effect, params) ?? null;
    }

    applyTextEffectChain(src: GPUTexture, effects: TextEffectConfig[]): GPUTexture | null {
        return this.getTextEffectEngine()?.applyChain(src, effects) ?? null;
    }

    async validateCustomShader(code: string, rawCode = false): Promise<CustomShaderCompileResult> {
        const engine = this.getTextEffectEngine();
        if (!engine) return { success: false, errors: ['TextEffectEngine not available'] };
        return engine.validateCustomShader(code, rawCode);
    }

    async setCustomShader(nodeId: string, code: string, rawCode = false, params?: [number, number, number, number]): Promise<CustomShaderCompileResult> {
        const validation = await this.validateCustomShader(code, rawCode);
        if (!validation.success) return validation;
        const node = this.findLiveTextNode(nodeId);
        if (!node) return { success: false, errors: ['LiveTextNode not found'] };
        const customEffect: TextEffectConfig = {
            type: 'custom',
            params: { ...(rawCode ? { rawCode: code } : { code }), params: params ?? [0, 0, 0, 0] } as CustomShaderParams,
        };
        const existingEffects = node.effects.filter(e => e.type !== 'custom');
        node.setEffects([...existingEffects, customEffect]);
        this.ctx.scheduleRender();
        return { success: true };
    }

    removeCustomShader(nodeId: string): void {
        const node = this.findLiveTextNode(nodeId);
        if (!node) return;
        node.setEffects(node.effects.filter(e => e.type !== 'custom'));
        this.ctx.scheduleRender();
    }

    setCustomShaderParams(nodeId: string, params: [number, number, number, number]): void {
        const node = this.findLiveTextNode(nodeId);
        if (!node) return;
        const effects = [...node.effects];
        for (const fx of effects) { if (fx.type === 'custom') (fx.params as CustomShaderParams).params = params; }
        node.setEffects(effects);
        this.ctx.scheduleRender();
    }

    createEffectedText(textConfig: TextCaptureConfig, effects: TextEffectConfig[]): { texture: GPUTexture; width: number; height: number } | null {
        const engine = this.getTextEffectEngine();
        if (!engine) return null;
        const captured = engine.captureText(textConfig);
        if (effects.length === 0) return captured;
        const result = engine.applyChain(captured.texture, effects);
        return { texture: result, width: captured.width, height: captured.height };
    }

    async stampEffectedText(destX: number, destY: number, textConfig: TextCaptureConfig, effects: TextEffectConfig[]): Promise<boolean> {
        const rasterLayerManager = this.ctx.rasterLayerManager;
        if (!rasterLayerManager) return false;
        const device = this.ctx.webgpuRenderer?.getDevice();
        if (!device) return false;
        const activeLayerId = rasterLayerManager.getSelectedLayerId();
        if (!activeLayerId) return false;
        const activeLayer = rasterLayerManager.getLayerById(activeLayerId);
        if (!activeLayer?.texture) return false;
        const result = this.createEffectedText(textConfig, effects);
        if (!result) return false;
        const srcW = Math.min(result.width, activeLayer.texture.width - destX);
        const srcH = Math.min(result.height, activeLayer.texture.height - destY);
        if (srcW <= 0 || srcH <= 0) { result.texture.destroy(); return false; }
        const enc = device.createCommandEncoder();
        enc.copyTextureToTexture({ texture: result.texture, origin: [0, 0, 0] }, { texture: activeLayer.texture, origin: [destX, destY, 0] }, { width: srcW, height: srcH });
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();
        result.texture.destroy();
        this.ctx.scheduleRender();
        return true;
    }

    // ── LiveText ─────────────────────────────────────────────────────

    createLiveText(x: number, y: number, options?: LiveTextOptions): LiveTextNode {
        if (this._editingLiveTextId) this.endLiveTextEditing(this._editingLiveTextId);
        const node = this.ctx.shapeFactory.createLiveText(x, y, options);
        const engine = this.getTextEffectEngine();
        if (engine) node.setEngine(engine);
        const illBounds = this.ctx.webgpuRenderer?.getIllustrationBounds?.();
        const pixelSize = this.ctx.webgpuRenderer?.getIllustrationPixelSize?.();
        const canvas = this.ctx.interactionService?.canvas;
        if (illBounds && pixelSize) {
            node.worldUnitsPerPixel = illBounds.width / pixelSize.w;
        } else if (canvas) {
            node.worldUnitsPerPixel = 2 / canvas.height;
        }
        if (canvas && TextEffectEngine.htmlInCanvasAvailable()) {
            if (!canvas.hasAttribute('layoutsubtree')) canvas.setAttribute('layoutsubtree', '');
            node.initDomElement(canvas);
            TextEffectEngine.requestPaint(canvas);
        }
        node.updateTexture();
        this.ctx.sceneGraph.root.addChild(node);
        this.ctx.interactionService.clearSelectedNodes();
        this.ctx.interactionService.selectNode(node);
        this.ctx.emitSceneGraphChanged();
        if (node.needsAnimation) this.ctx.webgpuRenderer?.beginInteractive();
        return node;
    }

    setLiveTextEffects(nodeId: string, effects: TextEffectConfig[]): void {
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            const wasAnimated = node.needsAnimation;
            node.setEffects(effects);
            if (node.needsAnimation && !wasAnimated) this.ctx.webgpuRenderer?.beginInteractive();
            if (!node.needsAnimation && wasAnimated) this.ctx.webgpuRenderer?.endInteractive();
            this.ctx.scheduleRender();
        }
    }

    setLiveTextContent(nodeId: string, text: string): void {
        const node = this.findLiveTextNode(nodeId);
        if (node) { node.text = text; this.ctx.scheduleRender(); }
    }

    setLiveTextStyle(nodeId: string, style: Partial<LiveTextOptions>): void {
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
        this.ctx.scheduleRender();
    }

    beginLiveTextEditing(nodeId: string): void {
        if (this._editingLiveTextId && this._editingLiveTextId !== nodeId) this.endLiveTextEditing(this._editingLiveTextId);
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            node.onChange = () => this.ctx.scheduleRender();
            node.beginEditing();
            this._editingLiveTextId = nodeId;
            this.ctx.webgpuRenderer?.beginInteractive();
        }
    }

    endLiveTextEditing(nodeId: string): void {
        const node = this.findLiveTextNode(nodeId);
        if (node) {
            node.endEditing();
            node.onChange = undefined;
            if (this._editingLiveTextId === nodeId) this._editingLiveTextId = null;
            this.ctx.interactionService.deselectNode(node);
            this.ctx.webgpuRenderer?.endInteractive();
            this.ctx.scheduleRender();
        }
    }

    async flattenLiveText(nodeId: string): Promise<boolean> {
        const node = this.findLiveTextNode(nodeId);
        const rasterLayerManager = this.ctx.rasterLayerManager;
        if (!node || !rasterLayerManager) return false;
        const device = this.ctx.webgpuRenderer?.getDevice();
        if (!device) return false;
        const tex = node.getCurrentTexture();
        if (!tex) return false;
        const activeLayerId = rasterLayerManager.getSelectedLayerId();
        if (!activeLayerId) return false;
        const activeLayer = rasterLayerManager.getLayerById(activeLayerId);
        if (!activeLayer?.texture) return false;
        const texW = activeLayer.texture.width, texH = activeLayer.texture.height;
        const illBounds = this.ctx.webgpuRenderer?.getIllustrationBounds?.();
        const worldW = illBounds?.width ?? 2, worldH = illBounds?.height ?? 2;
        const destX = Math.round(((node.x + worldW / 2) / worldW) * texW - tex.width / 2);
        const destY = Math.round(((-node.y + worldH / 2) / worldH) * texH - tex.height / 2);
        const srcW = Math.min(tex.width, texW - Math.max(0, destX));
        const srcH = Math.min(tex.height, texH - Math.max(0, destY));
        if (srcW <= 0 || srcH <= 0) return false;
        const enc = device.createCommandEncoder();
        enc.copyTextureToTexture({ texture: tex, origin: [0, 0, 0] }, { texture: activeLayer.texture, origin: [Math.max(0, destX), Math.max(0, destY), 0] }, { width: srcW, height: srcH });
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();
        if (this._editingLiveTextId === nodeId) this.endLiveTextEditing(nodeId);
        const wasAnimated = node.needsAnimation;
        node.destroy();
        this.ctx.sceneGraph.root.removeChild(node);
        if (wasAnimated) this.ctx.webgpuRenderer?.endInteractive();
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return true;
    }

    getLiveTextNode(nodeId: string): LiveTextNode | null { return this.findLiveTextNode(nodeId); }

    findLiveTextNode(nodeId: string): LiveTextNode | null {
        let found: LiveTextNode | null = null;
        this.ctx.sceneGraph.root.forEachDeep((n) => {
            if (found) return;
            if (n instanceof LiveTextNode && (n as LiveTextNode).id === nodeId) found = n as LiveTextNode;
        });
        return found;
    }
}
