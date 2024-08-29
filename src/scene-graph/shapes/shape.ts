import { mat4, vec4 } from 'gl-matrix';
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { RGBA } from '../../types/rgba';
import { Node } from '../node';
import { InteractionService } from '../../services/interaction-service';

export abstract class Shape extends Node {
    
    private _width!: number;
    private _height!: number;
    protected _localMatrix: mat4;
    protected _fillColor: RGBA;
    protected _strokeColor: RGBA;
    protected _strokeWidth: number;
    protected _boundingBox: { x: number; y: number; width: number; height: number };
    protected _previousBoundingBox: { x: number; y: number; width: number; height: number };
    protected _interactionService: InteractionService;
    protected _isSelected: boolean = false;

    get width() {
        return this._width;
    }

    set width(newWidth: number) {
        this._width = newWidth;
        this.updateLocalMatrix();
        this.calculateBoundingBox();
    }

    get height() {
        return this._height;
    }

    set height(newHeight: number) {
        this._height = newHeight;
        this.updateLocalMatrix();
        this.calculateBoundingBox();
    }

    // Method to select the shape
    public select() {
        this._isSelected = true;
        this.triggerRerender(); // Mark as dirty to trigger a re-render
    }

    // Method to deselect the shape
    public deselect() {
        this._isSelected = false;
        this.triggerRerender(); // Mark as dirty to trigger a re-render
    }

    // Method to check if the shape is selected
    public isSelected(): boolean {
        return this._isSelected;
    }

    constructor(renderStrategy: RenderStrategy, 
                fillColor: RGBA = {r: 0, g: 0, b: 0, a: 0}, 
                strokeColor: RGBA = {r: 0, g: 0, b: 0, a: 0}, 
                strokeWidth: number = 1,
                interactionService: InteractionService) {
        super(renderStrategy);
        this._interactionService = interactionService;
        this._fillColor = fillColor;
        this._strokeColor = strokeColor;
        this._strokeWidth = strokeWidth;
        this._localMatrix = mat4.create(); // Initialize the localMatrix as an identity matrix
        this._boundingBox = { x: 0, y: 0, width: 0, height: 0 }; // Initialize boundingBox
        this._previousBoundingBox = { ...this._boundingBox }; // Initialize previousBoundingBox
        this.updateLocalMatrix(); // Initial update of the matrix
    }

    public finalizeInitialization() {
        this.updateLocalMatrix();
        this.calculateBoundingBox();
        this._previousBoundingBox = { ...this._boundingBox };
    }

    public updateLocalMatrix() {

        // Get scale factors from subclass
        const [scaleX, scaleY] = this.getScaleFactors(); 
        
        mat4.identity(this._localMatrix);
        mat4.translate(this._localMatrix, this._localMatrix, [this.x, this.y, 0]);
        mat4.rotateZ(this._localMatrix, this._localMatrix, this.rotation);
        mat4.scale(this._localMatrix, this._localMatrix, [scaleX, scaleY, 1]);
        //mat4.scale(this._localMatrix, this._localMatrix, [1/, 1, 1]);
    }

    protected abstract getScaleFactors(): [number, number];

    get localMatrix(): mat4 {
        return this._localMatrix;
    }

    set localMatrix(newMatrix: mat4) {
        this._localMatrix = newMatrix;
        this.updateLocalMatrix();
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

    set boundingBox(value: { x: number; y: number; width: number; height: number }) {
        this._boundingBox = value;
    }

    public triggerRerender() {
        this._previousBoundingBox = { ...this._boundingBox };
        this.calculateBoundingBox();
        this._isDirty = true;
    }

    public markDirty() {
        this.triggerRerender();
    }

    protected calculateBoundingBox() {
        // The bounding box should start at the shape's top-left corner
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        // Update the bounding box's properties
        this.boundingBox.x = this.x - halfWidth;
        this.boundingBox.y = this.y - halfHeight;
        this.boundingBox.width = this.width;
        this.boundingBox.height = this.height;
    }

    public getBoundingBox() {
        return this.boundingBox;
    }

    public getPreviousBoundingBox() {
        return this._previousBoundingBox;
    }

    protected transformBoundingBoxToNDC(worldMatrix: mat4): { x: number, y: number, width: number, height: number } {
        const { x, y, width, height } = this.boundingBox;
    
        const topLeft = vec4.fromValues(x, y, 0, 1);
        const topRight = vec4.fromValues(x + width, y, 0, 1);
        const bottomLeft = vec4.fromValues(x, y + height, 0, 1);
        const bottomRight = vec4.fromValues(x + width, y + height, 0, 1);
    
        vec4.transformMat4(topLeft, topLeft, worldMatrix);
        vec4.transformMat4(topRight, topRight, worldMatrix);
        vec4.transformMat4(bottomLeft, bottomLeft, worldMatrix);
        vec4.transformMat4(bottomRight, bottomRight, worldMatrix);
    
        const transformedBoundingBox = {
            x: Math.min(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]),
            y: Math.min(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]),
            width: Math.max(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]) - Math.min(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]),
            height: Math.max(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]) - Math.min(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1])
        };
    
        return transformedBoundingBox;
    }

    public isShapeDirty() {
        return this._isDirty;
    }

    public resetDirtyFlag() {
        this._isDirty = false;
    }

    public getWorldSpaceCorners(): [vec4, vec4, vec4, vec4] {
        // Define the four corners of the bounding box rectangle in local space
        const corners: vec4[] = [
            vec4.fromValues(-this.width / 2, -this.height / 2, 0, 1), // Bottom-left
            vec4.fromValues(this.width / 2, -this.height / 2, 0, 1),  // Bottom-right
            vec4.fromValues(this.width / 2, this.height / 2, 0, 1),   // Top-right
            vec4.fromValues(-this.width / 2, this.height / 2, 0, 1),  // Top-left
        ];

        return corners as [vec4, vec4, vec4, vec4];
    }
}