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
    private fontSize: number = 16;
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

    private startTextEntryBound = (event: MouseEvent) => this.startTextEntry(event);
    private handleTypingBound = (event: KeyboardEvent) => this.handleTyping(event);

    private attachEventListeners() {
        const canvas = this.interactionService.canvas;
        canvas.addEventListener("mousedown", this.startTextEntryBound);
        window.addEventListener("keydown", this.handleTypingBound);
    }

    public reinitializeEventListeners() {
        const canvas = this.interactionService.canvas;
    
        // Remove existing listeners
        canvas.removeEventListener("mousedown", this.startTextEntryBound);
        window.removeEventListener("keydown", this.handleTypingBound);
    
        // Re-attach listeners
        this.attachEventListeners();
    }

    private startTextEntry(event: MouseEvent) {
        if (!this.isEnabled) return;

        const { x, y } = this.interactionService.toWorldCoords(event);

        // Finalize any active text before starting a new one
        if (this.activeText) {
            this.finalizeText();
        }

        // Create new SDF text object using the factory pattern
        this.currentText = "";
        this.activeText = this.createSDFText(x, y, this.currentText);
        
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

        if (event.key === "Enter") {
            this.finalizeText();
            return;
        }

        if (event.key === "Backspace") {
            this.currentText = this.currentText.slice(0, -1);
        } else if (event.key.length === 1) {
            this.currentText += event.key;
        }

        // Update the SDF text
        this.activeText.setText(this.currentText);
        this.activeText.isDirty = true;
        this.interactionService.onSceneGraphChanged.emit();
    }

    private finalizeText() {
        if (this.activeText) {
            if (this.currentText.trim() === "") {
                this.sceneGraph.root.removeChild(this.activeText);
            }
            this.activeText.isTyping = false;
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

    public isUserTyping(): boolean {
        return this.activeText !== null;
    }

    public getSDFAtlas(): SDFTextAtlas {
        return this._sdfAtlas;
    }

    public dispose() {
        const canvas = this.interactionService.canvas;
        canvas.removeEventListener("mousedown", this.startTextEntryBound);
        window.removeEventListener("keydown", this.handleTypingBound);
    }
}