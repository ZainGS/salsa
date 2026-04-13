import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { InteractionService } from "../interaction-service";
import { RGBA } from "../../types/rgba";
import { SDFText } from "../../scene-graph/shapes/sdf-text/sdf-text";
import { SDFTextAtlas } from "../../scene-graph/shapes/sdf-text/sdf-text-atlas";
import { CacheService } from "../cache-service";

export class SdfTextDrawingService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    private shapeFactory: ShapeFactory;
    private _sdfAtlas: SDFTextAtlas;
    public isEnabled: boolean = false;
    private activeText: SDFText | null = null;
    private currentText: string = "";
    private strokeColor: RGBA = { r: 1, g: 1, b: 1, a: 1 };
    private font: string = "Arial";
    private fontSize: number = 120;
    public device: GPUDevice;

    // SDF-specific properties
    private sdfThreshold: number = 0.5;
    private outlineColor: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    private smoothing: number = 1;
    private outlineWidth: number = 0;

    constructor(
        interactionService: InteractionService, 
        sceneGraph: SceneGraph, 
        renderStrategy: RenderStrategy, 
        shapeFactory: ShapeFactory, 
        device: GPUDevice,
        sdfAtlas: SDFTextAtlas
    ) {
        this.interactionService = interactionService;
        this.sceneGraph = sceneGraph;
        this.renderStrategy = renderStrategy;
        this.shapeFactory = shapeFactory;
        this.device = device;
        this._sdfAtlas = sdfAtlas;
        this.attachEventListeners();
    }

    enable() {
        this.isEnabled = true;
        this.interactionService.clearSelectedNodes();
    }

    disable() {
        this.isEnabled = false;
        this.finalizeText();
    }

    private startTextEntryBound = (event: PointerEvent) => this.startTextEntry(event);
    private handleTypingBound = (event: KeyboardEvent) => this.handleTyping(event);

    private attachEventListeners() {
        const canvas = this.interactionService.canvas;
        canvas.addEventListener("pointerdown", this.startTextEntryBound);
        window.addEventListener("keydown", this.handleTypingBound);
    }

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;
    
        // Remove existing listeners
        canvas.removeEventListener("pointerdown", this.startTextEntryBound);
        window.removeEventListener("keydown", this.handleTypingBound);
    
        // Re-attach listeners
        this.attachEventListeners();
    }

    private startTextEntry(event: PointerEvent) {
        if (!this.isEnabled) return;

        const { x, y } = this.interactionService.toWorldCoords(event);

        // If clicking on the active text, position the caret there instead of creating a new one
        if (this.activeText && this.activeText.containsPoint(x, y)) {
            const idx = this.activeText.getCaretIndexAtWorldPos(x, y);
            this.activeText.caretIndex = idx;
            this.activeText.clearSelection();
            this.activeText.isDirty = true;
            this.interactionService.requestRender();
            return;
        }

        // Finalize any active text before starting a new one
        if (this.activeText) {
            this.finalizeText();
        }

        // Create new SDF text object using the factory pattern
        this.currentText = "";
        this.activeText = this.createSDFText(x, y, this.currentText);
        this.activeText.beginTyping();
        
        this.sceneGraph.root.addChild(this.activeText);

        // Mark text as dirty so it's rendered immediately
        this.activeText.isDirty = true;
        this.activeText.isTyping = true;
        this.interactionService.onSceneGraphChanged.emit();
    }

    private createSDFText(x: number, y: number, text: string): SDFText {
        const sdfText = this.shapeFactory.createSDFText(
            x,
            y,
            text,
            this.fontSize,
            this._sdfAtlas,
            this.strokeColor,
            this.font
        );

        // Set SDF-specific properties
        sdfText.sdfThreshold = this.sdfThreshold;
        sdfText.outlineColor = this.outlineColor;
        sdfText.smoothing = this.smoothing;
        sdfText.outlineWidth = this.outlineWidth;

        return sdfText;
    }

    private handleTyping(event: KeyboardEvent) {
        if (!this.isEnabled || !this.activeText) return;

        const shift = event.shiftKey;
        const ctrl = event.ctrlKey || event.metaKey;

        // ── Enter: finalize ──
        if (event.key === "Enter" && !shift) {
            this.finalizeText();
            return;
        }

        // ── Shift+Enter: insert newline ──
        if (event.key === "Enter" && shift) {
            event.preventDefault();
            this.activeText.insertAtCaret('\n');
            this.currentText = this.activeText.text;
            this.interactionService.onSceneGraphChanged.emit();
            return;
        }

        // ── Select All ──
        if (ctrl && event.key === 'a') {
            event.preventDefault();
            this.activeText.selectAll();
            this.activeText.isDirty = true;
            this.interactionService.requestRender();
            return;
        }

        // ── Copy ──
        if (ctrl && event.key === 'c') {
            event.preventDefault();
            const sel = this.activeText.getSelectedText();
            if (sel) navigator.clipboard.writeText(sel).catch(() => {});
            return;
        }

        // ── Cut ──
        if (ctrl && event.key === 'x') {
            event.preventDefault();
            const sel = this.activeText.getSelectedText();
            if (sel) {
                navigator.clipboard.writeText(sel).catch(() => {});
                this.currentText = this.activeText.deleteSelection();
                this.interactionService.onSceneGraphChanged.emit();
            }
            return;
        }

        // ── Paste ──
        if (ctrl && event.key === 'v') {
            event.preventDefault();
            navigator.clipboard.readText().then(clip => {
                if (clip && this.activeText) {
                    this.currentText = this.activeText.insertAtCaret(clip);
                    this.interactionService.onSceneGraphChanged.emit();
                }
            }).catch(() => {});
            return;
        }

        // ── Arrow keys ──
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            this.activeText.moveCaret(-1, shift);
            this.interactionService.requestRender();
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            this.activeText.moveCaret(1, shift);
            this.interactionService.requestRender();
            return;
        }

        // ── Home / End ──
        if (event.key === 'Home') {
            event.preventDefault();
            this.activeText.moveCaretToLineStart(shift);
            this.interactionService.requestRender();
            return;
        }
        if (event.key === 'End') {
            event.preventDefault();
            this.activeText.moveCaretToLineEnd(shift);
            this.interactionService.requestRender();
            return;
        }

        // ── Backspace ──
        if (event.key === "Backspace") {
            if (this.activeText.hasSelection()) {
                this.currentText = this.activeText.deleteSelection();
            } else if (this.activeText.caretIndex > 0) {
                this.activeText.moveCaret(-1, false);
                const idx = this.activeText.caretIndex;
                this.activeText.text = this.activeText.text.substring(0, idx) + this.activeText.text.substring(idx + 1);
                this.currentText = this.activeText.text;
                this.activeText.refreshText();
                this.activeText.isDirty = true;
                this.activeText.onChange?.();
            }
            this.interactionService.onSceneGraphChanged.emit();
            return;
        }

        // ── Delete key ──
        if (event.key === "Delete") {
            if (this.activeText.hasSelection()) {
                this.currentText = this.activeText.deleteSelection();
            } else if (this.activeText.caretIndex < this.activeText.text.length) {
                const idx = this.activeText.caretIndex;
                this.activeText.text = this.activeText.text.substring(0, idx) + this.activeText.text.substring(idx + 1);
                this.currentText = this.activeText.text;
                this.activeText.refreshText();
                this.activeText.isDirty = true;
                this.activeText.onChange?.();
            }
            this.interactionService.onSceneGraphChanged.emit();
            return;
        }

        // ── Printable character ──
        if (event.key.length === 1 && !ctrl) {
            this.currentText = this.activeText.insertAtCaret(event.key);
            this.interactionService.onSceneGraphChanged.emit();
            return;
        }
    }

    private finalizeText() {
        if (this.activeText) {
            if (this.currentText.trim() === "") {
                this.sceneGraph.root.removeChild(this.activeText);
            }
            this.activeText.isTyping = false;
            this.activeText.endTyping();
            this.activeText = null;
        }
    }

    // Setters for text properties
    public setTextColor(color: RGBA) {
        this.strokeColor = color;
        if (this.activeText) {
            this.activeText.strokeColor = color;
            this.activeText.isDirty = true;
        }
    }

    public setOutlineColor(color: RGBA) {
        this.outlineColor = color;
        if (this.activeText) {
            this.activeText.outlineColor = color;
            this.activeText.isDirty = true;
        }
    }

    public setFontSize(size: number) {
        this.fontSize = size;
    }

    public setFont(font: string) {
        this.font = font;
    }

    public setSDFThreshold(threshold: number) {
        this.sdfThreshold = threshold;
        if (this.activeText) {
            this.activeText.sdfThreshold = threshold;
            this.activeText.isDirty = true;
        }
    }

    public setSmoothing(smoothing: number) {
        this.smoothing = smoothing;
        if (this.activeText) {
            this.activeText.smoothing = smoothing;
            this.activeText.isDirty = true;
        }
    }

    public setOutlineWidth(width: number) {
        this.outlineWidth = width;
        if (this.activeText) {
            this.activeText.outlineWidth = width;
            this.activeText.isDirty = true;
        }
    }

    public setMaxWidth(worldUnits: number) {
        if (this.activeText) {
            this.activeText.setMaxWidth(worldUnits);
            this.activeText.isDirty = true;
        }
    }

    public isUserTyping(): boolean {
        return this.activeText !== null;
    }

    public getSDFAtlas(): SDFTextAtlas {
        return this._sdfAtlas;
    }

    public dispose() {
        const canvas = this.interactionService.canvas;
        canvas.removeEventListener("pointerdown", this.startTextEntryBound);
        window.removeEventListener("keydown", this.handleTypingBound);
    }
}