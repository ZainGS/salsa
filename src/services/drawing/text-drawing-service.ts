import { RenderStrategy } from "../../renderer/render-strategies/render-strategy";
import { SceneGraph } from "../../scene-graph/core/scene-graph";
import { ShapeFactory } from "../../scene-graph/core/shape-factory";
import { InteractionService } from "../interaction-service";
import { Text } from "../../scene-graph/shapes/text";
import { RGBA } from "../../types/rgba";

export class TextDrawingService {
    private interactionService: InteractionService;
    private sceneGraph: SceneGraph;
    private renderStrategy: RenderStrategy;
    private shapeFactory: ShapeFactory;
    public isEnabled: boolean = false;
    private activeText: Text | null = null;
    private currentText: string = "";
    private strokeColor: RGBA = { r: 1, g: 1, b: 1, a: 1 };
    private font: string = "16px Arial";
    public device: GPUDevice;

    constructor(interactionService: InteractionService, sceneGraph: SceneGraph, renderStrategy: RenderStrategy, shapeFactory: ShapeFactory, device: GPUDevice) {
        this.interactionService = interactionService;
        this.sceneGraph = sceneGraph;
        this.renderStrategy = renderStrategy;
        this.shapeFactory = shapeFactory;
        this.device = device;
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
    
        // Clear the flag so attachEventListeners can run
        //this.eventListenersAttached = false;
    
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

        // Create new text object
        this.currentText = "";
        this.activeText = this.shapeFactory.createText(x, y, this.currentText, this.font, this.strokeColor, this.device);
        this.sceneGraph.root.addChild(this.activeText);

        // Mark text as dirty so it's rendered immediately
        this.activeText.isDirty = true;
        this.activeText.isTyping = true;
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

        // Only call `setText()`; it already updates texture
        this.activeText.setText(this.currentText);
        // Ensure the text is redrawn
        this.activeText.isDirty = true;
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

    public setTextColor(color: RGBA) {
        this.strokeColor = color;
    }

    public isUserTyping(): boolean {
        return this.activeText ? true : false;
    }

}
