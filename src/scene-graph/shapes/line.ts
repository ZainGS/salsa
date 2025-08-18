// src/scene-graph/line.ts
import { mat4, vec3, vec4 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';

export class Line extends Shape {
    private _x1: number;
    private _y1: number;
    private _x2: number;
    private _y2: number;
    interactionService!: InteractionService;

    constructor(x1: number, 
                y1: number, 
                x2: number, 
                y2: number, 
                strokeColor: RGBA = {r:1,g:1,b:1,a:1}, 
                strokeWidth: number = 1,
                interactionService: InteractionService) {

        super({r:1,g:1,b:1,a:1}, strokeColor, strokeWidth, interactionService);
        this._x1 = x1;
        this._y1 = y1;
        this._x2 = x2;
        this._y2 = y2;
        this._interactionService = interactionService;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    protected getScaleFactors(): [number, number] {
        return [this.x2-this.x1 , this.y2-this.y1];
    }

    get x1() {
        return this._x1;
    }

    get y1() {
        return this._y1;
    }

    get x2() {
        return this._x2;
    }

    get y2() {
        return this._y2;
    }

    containsPoint(x: number, y: number): boolean {
        const inverseLocal = mat4.create();
        mat4.invert(inverseLocal, this.localMatrix);
    
        const local = vec4.fromValues(x, y, 0, 1);
        vec4.transformMat4(local, local, inverseLocal);
    
        const lx = local[0];
        const ly = local[1];
    
        const dx = this.x2 - this.x1;
        const dy = this.y2 - this.y1;
    
        const length = Math.hypot(dx, dy);
        //if (length === 0) return false;
    
        // Project point onto line
        const t = ((lx - this.x1) * dx + (ly - this.y1) * dy) / (length * length);
    
        if (t < 0 || t > 1) return false;
    
        const closestX = this.x1 + t * dx;
        const closestY = this.y1 + t * dy;
    
        const dist = Math.hypot(lx - closestX, ly - closestY);
    
        const threshold = this.strokeWidth * 0.5;
        return dist <= threshold;
    }
    
    protected calculateBoundingBox() {
        const halfThickness = this.strokeWidth * 0.005;
    
        // Extract start and end points
        let startX = this._x1;
        let startY = this._y1;
        let endX = this._x2;
        let endY = this._y2;
    
        // Compute direction vector
        const shapeLength = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
        //if (shapeLength === 0) return;
    
        const dirX = (endX - startX) / shapeLength;
        const dirY = (endY - startY) / shapeLength;
    
        // Compute perpendicular vector
        const normalX = -dirY * halfThickness;
        const normalY = dirX * halfThickness;
    
        // Expansion factors
        const lengthExpandFactor = 0.1;
        const thicknessExpandFactor = 1.1;
    
        // Expanded normal
        const expandedNormalX = normalX * thicknessExpandFactor;
        const expandedNormalY = normalY * thicknessExpandFactor;
    
        // Expand start/end along direction vector
        startX -= dirX * halfThickness * lengthExpandFactor;
        startY -= dirY * halfThickness * lengthExpandFactor;
        endX += dirX * halfThickness * lengthExpandFactor;
        endY += dirY * halfThickness * lengthExpandFactor;
    
        // Store both outer and inner boxes for future use
        this.boundingBox.vertices = [
            // Outer quad (enclosing the entire stroke)
            [startX - expandedNormalX, startY - expandedNormalY], // 0
            [endX - expandedNormalX, endY - expandedNormalY],     // 1
            [startX + expandedNormalX, startY + expandedNormalY], // 2
            [endX + expandedNormalX, endY + expandedNormalY],     // 3
    
            // Inner quad (tight to stroke, for other uses)
            [this._x1 - normalX, this._y1 - normalY], // 4
            [this._x2 - normalX, this._y2 - normalY], // 5
            [this._x1 + normalX, this._y1 + normalY], // 6
            [this._x2 + normalX, this._y2 + normalY], // 7
        ];
    }
    
    
    public updateEndPoint(x2: number, y2: number) {
        this._x2 = x2;
        this._y2 = y2;
        this.calculateBoundingBox();
        this.markDirty();
    }

    getType(): string {
        return "Line";
    }

    toJSON() {
        return {
            ...super.toJSON(),
            x1: this.x1,
            y1: this.y1,
            x2: this.x2,
            y2: this.y2
        };
    }

    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;
    
        const halfThickness = this.strokeWidth;
    
        const startX = this.x1;
        const startY = this.y1;
        const endX = this.x2;
        const endY = this.y2;
    
        const dirX = endX - startX;
        const dirY = endY - startY;
        const length = Math.sqrt(dirX * dirX + dirY * dirY);
        const normalX = -(dirY / length) * halfThickness;
        const normalY = (dirX / length) * halfThickness;
    
        const vertices = new Float32Array([
            startX - normalX, startY - normalY,  // Bottom-left
            endX - normalX, endY - normalY,      // Bottom-right
            startX + normalX, startY + normalY,  // Top-left
            startX + normalX, startY + normalY,  // Top-left (Duplicate)
            endX - normalX, endY - normalY,      // Bottom-right (Duplicate)
            endX + normalX, endY + normalY       // Top-right
        ]);
    
        this.cachedVertices = vertices;
        return vertices;
    }

    public getGeometryIndices(): Uint16Array | null {
        return null; // Line is drawn using non-indexed triangle list
    }

    // public getGeometryIndices(): Uint16Array {
    //     return new Uint16Array(); // Return an empty array instead of null
    // }

    // getGeometryIndices(): Uint16Array {
    //     return new Uint16Array([0, 1, 2, 3, 4, 5]);
    // }

    override getBoundingBoxVertices(thickness: number): Float32Array {
        const halfThickness = thickness / 2;
    
        const startX = this.x1;
        const startY = this.y1;
        const endX = this.x2;
        const endY = this.y2;
    
        const dirX = endX - startX;
        const dirY = endY - startY;
        const length = Math.sqrt(dirX * dirX + dirY * dirY);
    
        if (length === 0) {
            // Degenerate case: line is a point
            return new Float32Array([
                -halfThickness, -halfThickness,
                 halfThickness, -halfThickness,
                -halfThickness,  halfThickness,
                 halfThickness,  halfThickness,
                0, 0,
                0, 0,
                0, 0,
                0, 0,
            ]);
        }
    
        const normalX = -(dirY / length) * halfThickness;
        const normalY = (dirX / length) * halfThickness;
    
        return new Float32Array([
            // Outer corners
            startX - normalX - halfThickness, startY - normalY - halfThickness, // 0
            endX   - normalX + halfThickness, endY   - normalY - halfThickness, // 1
            startX + normalX - halfThickness, startY + normalY + halfThickness, // 2
            endX   + normalX + halfThickness, endY   + normalY + halfThickness, // 3
    
            // Inner corners
            startX - normalX, startY - normalY, // 4
            endX   - normalX, endY   - normalY, // 5
            startX + normalX, startY + normalY, // 6
            endX   + normalX, endY   + normalY  // 7
        ]);
    }

    

    // override getBoundingBoxVertices(thickness: number): Float32Array {
    //     if (!this.boundingBox.vertices || this.boundingBox.vertices.length !== 8) {
    //       console.warn("Line: bounding box not calculated yet, recalculating.");
    //       this.calculateBoundingBox();
    //     }
      
    //     return new Float32Array(this.boundingBox.vertices!.flat());
    // }

    override getWorldSpaceBoundingBoxPolygon(): [number, number][] {
        const corners = this.boundingBox.vertices!;
        return [0, 1, 3, 2].map(index => {
            const [x, y] = corners[index];
            const local = vec4.fromValues(x, y, 0, 1);
            const world = vec4.create();
            vec4.transformMat4(world, local, this.localMatrix);
            return [world[0], world[1]];
        });
    }

    override usesWorldSpaceBoundingBox(): boolean {
        return false;
    }
}