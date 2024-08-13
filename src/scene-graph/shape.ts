// src/scene-graph/shape.ts
import { RenderStrategy } from '../renderer/render-strategy';
import { RGBA } from '../types/rgba';
import { Node } from './node';

export abstract class Shape extends Node {
    protected _fillColor: RGBA;
    protected _strokeColor: RGBA;
    protected _strokeWidth: number;
    protected _isDirty: boolean = true;
    protected _boundingBox: { x: number; y: number; width: number; height: number } | null = null;
    protected _previousBoundingBox: { x: number; y: number; width: number; height: number } | null = null;

    constructor(renderStrategy: RenderStrategy, fillColor: RGBA = {r: 0, g: 0, b: 0, a: 0}, strokeColor: RGBA = {r: 0, g: 0, b: 0, a: 0}, strokeWidth: number = 1) {
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

    set fillColor(value: RGBA) {
        this._fillColor = value;
        this.triggerRerender();
    }

    get strokeColor() {
        return this._strokeColor;
    }

    set strokeColor(value: RGBA) {
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
            width: this._strokeWidth, // placeholder; actual dimensions should be set by subclasses
            height: this._strokeWidth, // placeholder; actual dimensions should be set by subclasses
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