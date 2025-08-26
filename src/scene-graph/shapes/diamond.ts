// src/scene-graph/diamond.ts
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';
import { mat4, vec3, vec4 } from 'gl-matrix';

export class Diamond extends Shape {

    constructor(x: number,
                y: number,
                width: number, 
                height: number, 
                fillColor: RGBA = {r:0,g:0,b:0,a:0}, 
                strokeColor: RGBA = {r:0,g:0,b:0,a:1}, 
                strokeWidth: number = 1,
                interactionService: InteractionService) {

        super(fillColor, strokeColor, strokeWidth, interactionService);
        this._interactionService = interactionService;
        this.width = width;
        this.height = height;
        this.x = x;
        this.y = y;
        

        this.boundingBox.x = x;
        this.boundingBox.y = x;
        this.boundingBox.width = this.width;
        this.boundingBox.height = this.height;
    }

    protected getScaleFactors(): [number, number] {
        return [this.scaleX, this.scaleY];
    }

    containsPoint(x: number, y: number): boolean {
        
        const inverseLocalMatrix = mat4.create();
        const success = mat4.invert(inverseLocalMatrix, this.localMatrix);
        if (!success) {
            console.error("Matrix inversion failed");
            return false;
        }
    
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseLocalMatrix);

        // Check if the point is within the diamond's bounds in local space
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;

        // Diamond hit test: check if point lies within the diamond shape
        return (
            Math.abs(point[0] / halfWidth) + Math.abs(point[1] / halfHeight) <= 1
        );
    }

    public calculateBoundingBox() {

        // Correct the dimensions of the rectangle for the aspect ratio
        // TODO: Find out exactly why I have to square the dimensions... probably world matrix related.
        const correctedWidth = (this.width)*this.width;
        const correctedHeight = this.height * this.height;
    
        // Define the four corners of the rectangle in local space
        const topLeft = vec4.fromValues((this.x - correctedWidth / 2), this.y - correctedHeight / 2, 0, 1);
        const topRight = vec4.fromValues(this.x + correctedWidth / 2, this.y - correctedHeight / 2, 0, 1);
        const bottomLeft = vec4.fromValues((this.x - correctedWidth / 2), this.y + correctedHeight / 2, 0, 1);
        const bottomRight = vec4.fromValues(this.x + correctedWidth / 2, this.y + correctedHeight / 2, 0, 1);
    
        // Transform the corners using the worldMatrix
        const worldMatrix = this._interactionService.getWorldMatrix();
        vec4.transformMat4(topLeft, topLeft, worldMatrix);
        vec4.transformMat4(topRight, topRight, worldMatrix);
        vec4.transformMat4(bottomLeft, bottomLeft, worldMatrix);
        vec4.transformMat4(bottomRight, bottomRight, worldMatrix);

        // Calculate the bounding box by finding the min and max X and Y coordinates
        const minX = Math.min(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
        const maxX = Math.max(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
        const minY = Math.min(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);
        const maxY = Math.max(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);
    
        // Update the bounding box with the transformed coordinates
        this._boundingBox = {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }

    getType(): string {
        return "Diamond";
    }

    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;
    
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        const vertices = new Float32Array([
            0.0, -halfHeight, // Bottom
            halfWidth, 0.0,   // Right
            0.0, halfHeight,  // Top
            -halfWidth, 0.0   // Left
        ]);
    
        this.cachedVertices = vertices;
        return vertices;
    }
    
    public getGeometryIndices(): Uint16Array {
        if (this.cachedIndices) return this.cachedIndices;
    
        const indices = new Uint16Array([
            0, 1, 3, // Triangle 1 (Bottom, Right, Left)
            1, 2, 3  // Triangle 2 (Right, Top, Left)
        ]);
    
        this.cachedIndices = indices;
        return indices;
    }
}