// src/scene-graph/shape.ts
import { RenderStrategy } from '../renderer/render-strategy';
import { Node } from './node';

export abstract class Shape extends Node {
    protected _fillColor: string;
    protected _strokeColor: string;
    protected _strokeWidth: number;
    protected _isDirty: boolean = true;
    protected _boundingBox: { x: number; y: number; width: number; height: number } | null = null;
    protected _previousBoundingBox: { x: number; y: number; width: number; height: number } | null = null;

    constructor(renderStrategy: RenderStrategy, fillColor: string = 'transparent', strokeColor: string = 'black', strokeWidth: number = 1) {
        super(renderStrategy);
        this._fillColor = fillColor;
        this._strokeColor = strokeColor;
        this._strokeWidth = strokeWidth;
        this.calculateBoundingBox(); // Calculate the initial bounding box
        this._previousBoundingBox = { ...this._boundingBox! }; // Initialize previousBoundingBox
    }

    get fillColor() {
        return this._fillColor;
    }

    set fillColor(value: string) {
        this._fillColor = value;
        this.triggerRerender();
    }

    get strokeColor() {
        return this._strokeColor;
    }

    set strokeColor(value: string) {
        this._strokeColor = value;
        this.triggerRerender();
    }

    get strokeWidth() {
        return this._strokeWidth;
    }

    set strokeWidth(value: number) {
        this._strokeWidth = value;
        this.triggerRerender();
    }

    get boundingBox() {
        return this._boundingBox;
    }

    set boundingBox(value: { x: number; y: number; width: number; height: number } | null) {
        this._boundingBox = value;
    }

    protected triggerRerender() {
        this._isDirty = true;

        // Update previousBoundingBox before recalculating boundingBox
        this._previousBoundingBox = { ...this.boundingBox! };
        this.calculateBoundingBox(); 
    }

    public markDirty() {
        this.triggerRerender();
    }

    protected calculateBoundingBox() {
        this._boundingBox = {
            x: this.x - this._strokeWidth / 2,
            y: this.y - this._strokeWidth / 2,
            width: 0,
            height: 0,
        };
    }

    public getBoundingBox() {
        return this.boundingBox;
    }

    public getPreviousBoundingBox() {
        return this._previousBoundingBox;
    }

    public isShapeDirty() {
        return this._isDirty;
    }

    public resetDirtyFlag() {
        this._isDirty = false;
    }
}