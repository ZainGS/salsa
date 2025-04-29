// src/scene-graph/pattern.ts
import { mat4, vec3, vec4 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';
import { TextureCache } from '../../renderer/caches/texture-cache/texture-cache';


export class Pattern extends Shape {
    private _x1: number;
    private _y1: number;
    private _x2: number;
    private _y2: number;
    private _patternUrl: string;
    public patternIndex: number | undefined = undefined;
    device!: GPUDevice;
    texture!: GPUTexture;
    interactionService!: InteractionService;

    constructor(x1: number, 
                y1: number, 
                x2: number, 
                y2: number, 
                strokeColor: RGBA = {r:1,g:1,b:1,a:1}, 
                strokeWidth: number = 1,
                interactionService: InteractionService,
                patternUrl: string,
                device: GPUDevice) {

        super({r:1,g:1,b:1,a:1}, strokeColor, strokeWidth, interactionService);
        this._x1 = x1;
        this._y1 = y1;
        this._x2 = x2;
        this._y2 = y2;
        this._patternUrl = patternUrl;
        
        this.device = device;
        this.loadPatternTexture(patternUrl);
        this._interactionService = interactionService;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    async loadPatternTexture(patternURL: string) {
        this.texture = await TextureCache.getTexture(this.device, patternURL);
        
        // In the future, we could immediately register in the PatternTextureCache...
        // but we'd have to inject CacheService into patterns.
        // await this.cacheService.patternTextureCache.registerPattern(this);

        this.markDirty(); // Mark pattern dirty so vertices with real uScale get regenerated
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
        const inverseLocalMatrix = mat4.create();
        const success = mat4.invert(inverseLocalMatrix, this.localMatrix);
        if (!success) {
            console.error("Matrix inversion failed");
            return false;
        }
        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseLocalMatrix);
    
        const localPoint = vec3.create();
        vec3.transformMat4(localPoint, point, inverseLocalMatrix);
    
        // Transform line endpoints to local space
        const start = vec3.fromValues(this._x1, this._y1, 0);
        const end = vec3.fromValues(this._x2, this._y2, 0);
        vec3.transformMat4(start, start, inverseLocalMatrix);
        vec3.transformMat4(end, end, inverseLocalMatrix);
    
        const x1 = start[0], y1 = start[1];
        const x2 = end[0], y2 = end[1];
    
        // Compute vector along the line
        const lineDX = (x2 - x1);
        const lineDY = (y2 - y1);
        const lengthSquared = lineDX * lineDX + lineDY * lineDY;
    
        if (lengthSquared === 0) {
            // Edge case: If the line is just a single point, check distance
            return Math.hypot(localPoint[0] - x1, localPoint[1] - y1) <= (this._strokeWidth / 2);
        }
    
        // Compute projection of the point onto the line segment
        let t = ((localPoint[0] - x1) * lineDX + (localPoint[1] - y1) * lineDY) / lengthSquared;
        t = Math.max(0, Math.min(1, t)); // Clamp to segment
    
        // Find closest point on the line
        const closestX = x1 + t * lineDX;
        const closestY = y1 + t * lineDY;
    
        // Check if the transformed point is within stroke width of the closest point
        const distance = Math.hypot(localPoint[0] - closestX, localPoint[1] - closestY);
        return distance <= (this._strokeWidth / 2)*.010;
    }
    
    protected calculateBoundingBox() {
        const halfThickness = this.strokeWidth * 0.005; // Match pattern thickness logic

        // Extract start and end points
        let startX = this.x1;
        let startY = this.y1;
        let endX = this.x2;
        let endY = this.y2;

        // Compute direction vector
        const shapeLength = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
        if (shapeLength === 0) return; // Prevent division by zero

        const dirX = (endX - startX) / shapeLength;
        const dirY = (endY - startY) / shapeLength;

        // **Compute perpendicular vector for thickness**
        const normalX = -dirY * halfThickness;
        const normalY = dirX * halfThickness;

        // **Expansion factors**
        const lengthExpandFactor = 0.1;  // 🔥 Smaller factor for start/end
        const thicknessExpandFactor = 1.1; // Keep full expansion for thickness

        // **Expanded perpendicular offsets**
        const expandedNormalX = normalX * thicknessExpandFactor;
        const expandedNormalY = normalY * thicknessExpandFactor;

        // **Slightly Expand Start and End Points Along Stroke Direction**
        startX -= dirX * halfThickness * lengthExpandFactor;  
        startY -= dirY * halfThickness * lengthExpandFactor;
        endX += dirX * halfThickness * lengthExpandFactor;    
        endY += dirY * halfThickness * lengthExpandFactor;

        // 🔥 Define Fully Expanded Outer and Inner Box
        this.boundingBox.vertices = [
            // **Outer Box (Enclosing Stroke in All Directions)**
            [startX - expandedNormalX, startY - expandedNormalY],  // 0 Bottom-left outer
            [endX - expandedNormalX, endY - expandedNormalY],      // 1 Bottom-right outer
            [startX + expandedNormalX, startY + expandedNormalY],  // 2 Top-left outer
            [endX + expandedNormalX, endY + expandedNormalY],      // 3 Top-right outer

            // **Inner Box (Aligned with Actual Stroke Edges)**
            [this.x1 - normalX, this.y1 - normalY],  // 4 Bottom-left inner
            [this.x2 - normalX, this.y2 - normalY],  // 5 Bottom-right inner
            [this.x1 + normalX, this.y1 + normalY],  // 6 Top-left inner
            [this.x2 + normalX, this.y2 + normalY],  // 7 Top-right inner
        ];
    }
    
    public updateEndPoint(x2: number, y2: number) {
        this._x2 = x2;
        this._y2 = y2;
        this.calculateBoundingBox();
        this.markDirty();
    }

    override getWorldSpaceBoundingBoxPolygon(): [number, number][] {
        const corners = this.boundingBox.vertices!;
        // Convert outer 4 corners of pattern bounding box to world space
        const shapePolygon: [number, number][] = [0, 1, 3, 2].map(index => {
            const [x, y] = corners[index];
            const local = vec4.fromValues(x, y, 0, 1);
            const world = vec4.create();
            vec4.transformMat4(world, local, this.localMatrix); // <-- local → world
            return [world[0], world[1]];
        });
        return shapePolygon;
    }

    getType(): string {
        return "Pattern";
    }

    /*  Since JavaScript's JSON.stringify() automatically calls an object's toJSON() method if 
    it exists, and because our subclass overrides Shape.toJSON(), the correct method is 
    called for each shape instance */
    toJSON() {
        return {
            ...super.toJSON(),
            x1: this._x1,
            y1: this._y1,
            x2: this._x2,
            y2: this._y2,
            pattern: this._patternUrl
        };
    }

    public getGeometryVertices(): Float32Array {
        // if (this.cachedVertices) return this.cachedVertices;

        // Compute length of the dragged shape
        const shapeLength = Math.sqrt((this._x2 - this._x1) ** 2 + (this._y2 - this._y1) ** 2);
        const shapeThickness = this.strokeWidth; // Keep thickness consistent
        
        // Compute perpendicular thickness
        const halfThickness = shapeThickness * 0.005;
    
        const startX = this._x1;
        const startY = this._y1;
        const endX = this._x2;
        const endY = this._y2;
    
        // Compute direction vector
        const dirX = (endX - startX) / shapeLength;
        const dirY = (endY - startY) / shapeLength;
    
        // Compute perpendicular vector for thickness
        const normalX = -dirY * halfThickness;
        const normalY = dirX * halfThickness;
    
        // Compute proper UV scaling based on pattern size
        // Set u/v scale — placeholder until texture loaded
        const patternWidth = this.texture?.width ?? 1; // Get actual texture size
        // Set uScale based on shape length so it tiles only in the dragged direction
        const uScale = 1600 * shapeLength / patternWidth;
        // Keep vScale fixed so that it doesn’t stretch in the perpendicular direction
        const vScale = 2; // Ensures no tiling along the thickness axis
    
        // UVs should align exactly along the dragged direction, with v fixed
        var vertices = new Float32Array([
            startX - normalX, startY - normalY, 0, 0,
            endX - normalX, endY - normalY, uScale, 0,
            startX + normalX, startY + normalY, 0, vScale,
            startX + normalX, startY + normalY, 0, vScale,
            endX - normalX, endY - normalY, uScale, 0,
            endX + normalX, endY + normalY, uScale, vScale
        ]);

        this.cachedVertices = vertices;
        return vertices;
    }
    
    public getGeometryIndices(): Uint16Array {
        return new Uint16Array(); // Return an empty array instead of null
    }

    override getBoundingBoxVertices(thickness: number): Float32Array {
        if (!this.boundingBox.vertices || this.boundingBox.vertices.length !== 8) {
            console.error("Bounding box vertices not calculated for pattern.");
            return new Float32Array(); // Return empty to avoid crash
        }
    
        return new Float32Array(this.boundingBox.vertices.flat());
    }
}