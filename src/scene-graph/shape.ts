// src/scene-graph/shape.ts
// A base class that includes common properties like fillColor, strokeColor, and strokeWidth. 
// It also handles triggering re-renders when these properties change.

import { Node } from './node';

export class Shape extends Node {
    protected _fillColor: string;
    protected _strokeColor: string;
    protected _strokeWidth: number;
    protected isDirty: boolean = true;
    protected boundingBox: { x: number; y: number; width: number; height: number } | null = null;

    constructor(fillColor: string = 'transparent', strokeColor: string = 'black', strokeWidth: number = 1) {
        super();
        this._fillColor = fillColor;
        this._strokeColor = strokeColor;
        this._strokeWidth = strokeWidth;
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

    protected triggerRerender() {
        this.isDirty = true;
        this.calculateBoundingBox(); // Recalculate bounding box
    }

    protected calculateBoundingBox() {
        this.boundingBox = {
            x: this.x,
            y: this.y,
            width: 0,
            height: 0,
        };
    }

    // Public getter methods for Renderer access
    public getBoundingBox() {
        return this.boundingBox;
    }

    public isShapeDirty() {
        return this.isDirty;
    }

    // Method to reset the dirty flag
    public resetDirtyFlag() {
        this.isDirty = false;
    }
}