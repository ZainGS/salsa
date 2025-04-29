import { mat4, vec4 } from 'gl-matrix';
import { RenderStrategy } from '../../../renderer/render-strategies/render-strategy';
import { RGBA } from '../../../types/rgba';
import { Node } from './node';
import { InteractionService } from '../../../services/interaction-service';
import ShapeManager from '../../../services/shape-manager';

export abstract class Shape extends Node {
    private _id?: string;
    public _width!: number;
    public _height!: number;
    protected _localMatrix: mat4;
    protected _localMatrixVersion: number = 0;
    protected _fillColor: RGBA;
    protected _strokeColor: RGBA;
    protected _strokeWidth: number;
    protected _boundingBox: { x: number; y: number; width: number; height: number, vertices?: [number, number][]};
    protected _previousBoundingBox: { x: number; y: number; width: number; height: number };
    protected _interactionService: InteractionService;
    protected _isSelected: boolean = false;
    
    protected cachedVertices?: Float32Array;
    protected cachedIndices?: Uint16Array;

    public isPreview: boolean = false;
    public isStaging: boolean = false;
    public wasCommitted = false;
    // public boundingBoxCacheOffset = -1;

    // Shape IDs map to buffer offset values inside 
    get id(): string {
        if (!this._id) {
            this._id = self.crypto.randomUUID();
        }
        return this._id;
    }

    public setId(value: string) {
        this._id = value;
    }

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
        if(!ShapeManager.getInstance().lineDrawingService.isEnabled) {
            this._isSelected = true;
            this.triggerRerender(); // Mark as dirty to trigger a re-render
        }
        else {
            this.deselect();
        }
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

    constructor(fillColor: RGBA = {r: 0, g: 0, b: 0, a: 0}, 
                strokeColor: RGBA = {r: 0, g: 0, b: 0, a: 0}, 
                strokeWidth: number = 1,
                interactionService: InteractionService) {
        super();
        this._interactionService = interactionService;
        this.zIndex = this._interactionService.maxGlobalZIndex;
        this._interactionService.maxGlobalZIndex += 1;
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
        this.bumpMatrixVersion();
        // Get scale factors from subclass
        const [scaleX, scaleY] = this.getScaleFactors(); 

        mat4.identity(this._localMatrix);
        mat4.translate(this._localMatrix, this._localMatrix, [this.x, this.y, 0]);
        mat4.rotateZ(this._localMatrix, this._localMatrix, this.rotation);
        mat4.scale(this._localMatrix, this._localMatrix, [this.scaleX, this.scaleY, 1]);
    }

    protected abstract getScaleFactors(): [number, number];

    // If you want more performance later, you can cache the result of parentChainMatrix or the full localMatrix 
    // per frame if no transforms are dirty. For now your method is clean and works well.
    get localMatrix(): mat4 {
        const combined = mat4.create();
        mat4.mul(combined, this.parentChainMatrix, this._localMatrix);
        return combined;
    }

    set localMatrix(newMatrix: mat4) {
        this._localMatrix = newMatrix;
        this.updateLocalMatrix();
    }

    get localMatrixVersion() {
        return this._localMatrixVersion;
    }
    protected bumpMatrixVersion() {
        this._localMatrixVersion++;
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

    set boundingBox(value: { x: number; y: number; width: number; height: number; vertices?: [number, number][] }) {
        this._boundingBox = value;
    }

    cachedWorldSpaceBoundingPolygon: [number, number][] | null = null;
    // Overwritten in Stroke-based Shapes' classes
    public getWorldSpaceBoundingBoxPolygon(resetCache?: boolean): [number, number][] {
        if (this.cachedWorldSpaceBoundingPolygon != null && !resetCache) return this.cachedWorldSpaceBoundingPolygon;
        // console.log("cached");
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        // Get the 4 local-space corners of the shape
        const localCorners = [
            vec4.fromValues(-halfWidth, -halfHeight, 0, 1), // Bottom-left
            vec4.fromValues(halfWidth, -halfHeight, 0, 1),  // Bottom-right
            vec4.fromValues(halfWidth, halfHeight, 0, 1),   // Top-right
            vec4.fromValues(-halfWidth, halfHeight, 0, 1),  // Top-left
        ];
    
        // Transform corners to world space using the shape's localMatrix (handles rotation, scale, position)
        const worldCorners = localCorners.map(corner => {
            const result = vec4.create();
            vec4.transformMat4(result, corner, this.localMatrix);
            return [result[0], result[1]] as [number, number];
        });
    
        // Cache it
        this.cachedWorldSpaceBoundingPolygon = worldCorners;
        return worldCorners;
    }

    public triggerRerender() {
        this._previousBoundingBox = { ...this._boundingBox };
        this.calculateBoundingBox();
        this._isDirty = true;
        this.cachedWorldSpaceBoundingPolygon = null;
    }

    public markDirty() {
        this.clearGeometryCache();
        this.triggerRerender();
    }

    public clearGeometryCache() {
        this.cachedVertices = undefined;
        this.cachedIndices = undefined;
        this.cachedWorldSpaceBoundingPolygon = null;
        // this.cachedWorldCorners = undefined;
        this.cachedInverseLocalMatrix = null;
    }

    protected _isPointsDirty: boolean = false;
    public get isPointsDirty(): boolean {
        return this._isPointsDirty;
    }

    public set isPointsDirty(value: boolean) {
        this._isPointsDirty = value;
    }

    getWorldSpaceBoundingBoxPolygonRelativeToParent(parentMatrix?: mat4): [number, number][] {
        const corners = this.getLocalBoundingBoxCorners(); // Your 4 corners (e.g., [-width/2, -height/2], etc.)
        const result: [number, number][] = [];
    
        const combinedMatrix = mat4.create();
        if (parentMatrix) {
            mat4.multiply(combinedMatrix, parentMatrix, this.localMatrix);
        } else {
            mat4.copy(combinedMatrix, this.localMatrix);
        }
    
        for (const corner of corners) {
            const transformed = vec4.fromValues(corner[0], corner[1], 0, 1);
            vec4.transformMat4(transformed, transformed, combinedMatrix);
            result.push([transformed[0], transformed[1]]);
        }
    
        return result;
    }

    public getLocalBoundingBoxCorners(): [number, number][] {
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        return [
            [-halfWidth, -halfHeight], // Bottom-left
            [halfWidth, -halfHeight],  // Bottom-right
            [halfWidth, halfHeight],   // Top-right
            [-halfWidth, halfHeight],  // Top-left
        ];
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

    public transformBoundingBoxToNDC(): { x: number, y: number, width: number, height: number } {
        var worldMatrix = this._interactionService.getWorldMatrix();
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

    public getWorldSpaceAABB(): { x: number; y: number; width: number; height: number } {
        const { x, y, width, height } = this.boundingBox;
    
        const topLeft = vec4.fromValues(x, y, 0, 1);
        const topRight = vec4.fromValues(x + width, y, 0, 1);
        const bottomLeft = vec4.fromValues(x, y + height, 0, 1);
        const bottomRight = vec4.fromValues(x + width, y + height, 0, 1);
    
        const worldMatrix = this.localMatrix; // Only local transforms
        const transformedCorners = [topLeft, topRight, bottomLeft, bottomRight].map(corner => {
            const result = vec4.create();
            vec4.transformMat4(result, corner, worldMatrix);
            return result;
        });
    
        const xs = transformedCorners.map(c => c[0]);
        const ys = transformedCorners.map(c => c[1]);
    
        return {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
        };
    }

    public isShapeDirty() {
        return this._isDirty;
    }

    public resetDirtyFlag() {
        this._isDirty = false;
    }

    private cachedInverseLocalMatrix: mat4 | null = null;
    public getInverseLocalMatrix(): mat4 {
        // if (this.cachedInverseLocalMatrix != null) {
        //     return this.cachedInverseLocalMatrix;
        // }
    
        const inverse = mat4.create();
        const success = mat4.invert(inverse, this.localMatrix);
    
        if (!success) {
            console.warn("❌ Failed to invert localMatrix for", this);
            return mat4.create(); // Identity fallback if needed
        }
    
        this.cachedInverseLocalMatrix = inverse;
        return inverse;
    }

    // TODO: Investigate why scaling handles break if I cache this...
    //private cachedWorldCorners?: [vec4, vec4, vec4, vec4];
    public getWorldSpaceCorners(): [vec4, vec4, vec4, vec4] {
        //if (this.cachedWorldCorners) return this.cachedWorldCorners;
        // Define the four corners of the bounding box rectangle in local space
        const corners: vec4[] = [
            vec4.fromValues(-this.width / 2, -this.height / 2, 0, 1), // Bottom-left
            vec4.fromValues(this.width / 2, -this.height / 2, 0, 1),  // Bottom-right
            vec4.fromValues(this.width / 2, this.height / 2, 0, 1),   // Top-right
            vec4.fromValues(-this.width / 2, this.height / 2, 0, 1),  // Top-left
        ];
        //this.cachedWorldCorners = corners as [vec4, vec4, vec4, vec4];
        return corners as [vec4, vec4, vec4, vec4];
    }

    // Applies the shape's local matrix to external points (mouse clicks) for
    // proper hit detection; ex: eraser service click/drag points. All shape
    // transformations are applied to the local matrix and not the shape's x,y
    // values. So this ensures we must erase at the shape's most current position;
    // not its original position.
    public applyMatrixToPoint(x: number, y: number): [number, number] {
        // Convert the point into a 4D homogeneous vector (x, y, 0, 1)
        const localPoint = vec4.fromValues(x, y, 0, 1);
    
        // Invert the local matrix to correctly apply transformations
        const inverseMatrix = mat4.create();
        if (!mat4.invert(inverseMatrix, this.localMatrix)) {
            console.error("Matrix inversion failed");
            return [x, y]; // Return original point if inversion fails
        }
    
        // Transform the point using the inverted local matrix
        const transformedPoint = vec4.create();
        vec4.transformMat4(transformedPoint, localPoint, inverseMatrix);
    
        // Return the transformed 2D coordinates
        return [transformedPoint[0], transformedPoint[1]];
    }

    // Ensure each subclass provides a type identifier and vertex/index logic
    abstract getType(): string; 
    abstract getGeometryVertices(): Float32Array | null;
    abstract getGeometryIndices(): Uint16Array | null;

    toJSON() {
        return {
            id: this.id,
            type: this.getType(), // Ensure all shapes define getType()
            fillColor: this._fillColor,
            strokeColor: this._strokeColor,
            strokeWidth: this._strokeWidth,
            width: this._width,
            height: this._height,
            ...super.toJSON(), // Spread Node properties AFTER setting type
        };
    }

    public getBoundingBoxVertices(thickness: number): Float32Array {
        // Default square/rectangle behavior using width/height
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        return new Float32Array([
            // Outer box
            -halfWidth - thickness, -halfHeight - thickness, // 0
             halfWidth + thickness, -halfHeight - thickness, // 1
            -halfWidth - thickness,  halfHeight + thickness, // 2
             halfWidth + thickness,  halfHeight + thickness, // 3
    
            // Inner box
            -halfWidth, -halfHeight, // 4
             halfWidth, -halfHeight, // 5
            -halfWidth,  halfHeight, // 6
             halfWidth,  halfHeight  // 7
        ]);
    }

    // public getBoundingBoxVertices(thickness: number): Float32Array {
    //     const scaleX = this.scaleX ?? this.width;
    //     const scaleY = this.scaleY ?? this.height;
    
    //     const halfWidth = scaleX / 2;
    //     const halfHeight = scaleY / 2;
    
    //     return new Float32Array([
    //         // Outer box
    //         -halfWidth - thickness, -halfHeight - thickness, // 0
    //          halfWidth + thickness, -halfHeight - thickness, // 1
    //         -halfWidth - thickness,  halfHeight + thickness, // 2
    //          halfWidth + thickness,  halfHeight + thickness, // 3
    
    //         // Inner box
    //         -halfWidth, -halfHeight, // 4
    //          halfWidth, -halfHeight, // 5
    //         -halfWidth,  halfHeight, // 6
    //          halfWidth,  halfHeight  // 7
    //     ]);
    // }

    /**
     * Our standard shapes like Rectangle, Text, Pattern, etc.: 
     * Use a localMatrix for scale/position/rotation.
     * That matrix is passed to the GPU in a uniform buffer.
     * The GPU transforms vertices from local → world → clip space.
     * So their bounding boxes are calculated in local space, then transformed during rendering.
     * 
     * But for Scribble and Highlight:
     * The vertices are generated on the CPU in absolute world coordinates.
     * The GPU does not transform them at all.
     * They are rendered using raw world positions — often from streamed or pointer-drawn data.
     * So their bounding boxes must already be in world space to match what’s rendered on screen.
     * 
     * If we used a localMatrix to scale or transform these shapes, we would have to apply those transforms manually to every point in the CPU.
     * That defeats the GPU’s purpose and introduces inconsistency.
     * It can also cause bugs in hit-testing, selection, and culling if you assume local transforms apply.
     * Because the mass number of points, I think handling these in world space is more optimized.
     */
    public usesWorldSpaceBoundingBox(): boolean {
        return false;
    }
}