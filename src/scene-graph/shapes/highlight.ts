import { mat4, vec3, vec4 } from 'gl-matrix';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';
import { InteractionService } from '../../services/interaction-service';

export class Highlight extends Shape {
    private _points: { x: number; y: number }[] = [];

    constructor(
        x: number,
        y: number,
        strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 1 },
        strokeWidth: number = 1,
        interactionService: InteractionService
    ) {
        super({ r: 0, g: 0, b: 0, a: 0 }, { ...strokeColor, a: 0.65 }, strokeWidth, interactionService);
        this._points.push({ x, y });
        this.calculateBoundingBox();
    }

    /** Adds a new point to the scribble path */
    addPoint(x: number, y: number): void {
        this._points.push({ x, y });
        this.calculateBoundingBox();
        this.markDirty();
        this.isPointsDirty = true;
    }

    get points(): { x: number; y: number }[] {
        return this._points;
    }

    set points(points: { x: number; y: number }[]) {
        this._points = points;
    }

    /** Generates a vertex array for WebGPU */
    getVertices(): Float32Array {
        // Converts points into a flattened array `[x1, y1, x2, y2, ...]`
        return new Float32Array(this._points.flatMap(p => [p.x, p.y]));
    }

    getVertices2(): Float32Array {
        const vertices: number[] = [];
    
        if (this._points.length < 2) return new Float32Array(vertices);
    
        for (let i = 1; i < this._points.length; i++) {
            const prev = this._points[i - 1];
            const curr = this._points[i];
        
            // Compute normal for thickness
            const dx = curr.x - prev.x;
            const dy = curr.y - prev.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            const normalX = -(dy / length) * (this._strokeWidth / 2);
            const normalY = (dx / length) * (this._strokeWidth / 2);
        
            // First triangle (quad strip)
            vertices.push(prev.x - normalX, prev.y - normalY); // Bottom left
            vertices.push(prev.x + normalX, prev.y + normalY); // Top left
            vertices.push(curr.x - normalX, curr.y - normalY); // Bottom right
            vertices.push(curr.x + normalX, curr.y + normalY); // Top right
        }
    
        return new Float32Array(vertices);
    }

    /** Checks if a point is close to any segment in the scribble */
    containsPoint(x: number, y: number): boolean {
        const inverseLocalMatrix = mat4.create();
        if (!mat4.invert(inverseLocalMatrix, this.localMatrix)) {
            console.error("Matrix inversion failed");
            return false;
        }

        // Transform the test point into local space
        const localPoint = vec3.fromValues(x, y, 0);
        vec3.transformMat4(localPoint, localPoint, inverseLocalMatrix);

        // Iterate over segments and check proximity
        for (let i = 1; i < this._points.length; i++) {
            const p1 = this._points[i - 1];
            const p2 = this._points[i];

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const lengthSquared = dx * dx + dy * dy;
            if (lengthSquared === 0) continue;

            // Projection of point onto line segment
            let t = ((localPoint[0] - p1.x) * dx + (localPoint[1] - p1.y) * dy) / lengthSquared;
            t = Math.max(0, Math.min(1, t)); // Clamp to segment

            // Closest point on the line
            const closestX = p1.x + t * dx;
            const closestY = p1.y + t * dy;

            // Check if the transformed point is within stroke width of the closest point
            const distance = Math.hypot(localPoint[0] - closestX, localPoint[1] - closestY);
            const easeMultiplier = .75;
            if (distance <= (this._strokeWidth) * easeMultiplier) return true;
        }

        return false;
    }

    /** Bounding box calculation to fit the entire scribble */
    public calculateBoundingBox(): void {
        if (this._points.length === 0) return;

        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;

        for (const p of this._points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }

        this.boundingBox = {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    /** Returns scale factors for WebGPU transformations */
    protected getScaleFactors(): [number, number] {
        return [1, 1]; // Scribbles are freeform, so scaling is per point.
    }

    // Cramer's Rule for line intersection using determinants
    public intersectsLine(x1: number, y1: number, x2: number, y2: number): boolean {
        for (let i = 0; i < this.points.length - 1; i++) {
            let sx = this.points[i].x;
            let sy = this.points[i].y;
            let ex = this.points[i + 1].x;
            let ey = this.points[i + 1].y;
    
            if (this.lineSegmentsIntersect(x1, y1, x2, y2, sx, sy, ex, ey)) {
                return true;
            }
        }
        return false;
    }
    
    // Check if two line segments intersect
    private lineSegmentsIntersect(x1: number, y1: number, x2: number, y2: number, 
                                  x3: number, y3: number, x4: number, y4: number): boolean {
        const det = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
        if (det === 0) return false; // Parallel lines
    
        const lambda = ((y4 - y3) * (x4 - x1) + (x3 - x4) * (y4 - y1)) / det;
        const gamma = ((y1 - y2) * (x4 - x1) + (x2 - x1) * (y4 - y1)) / det;
    
        return (0 <= lambda && lambda <= 1) && (0 <= gamma && gamma <= 1);
    }

    getType(): string {
        return "Highlight";
    }

    toJSON() {
        return {
            ...super.toJSON(),
            type: this.getType(),
            points: this.points
        };
    }

    override getWorldSpaceBoundingBoxPolygon(): [number, number][] {
        if (this.points.length === 0) {
            return [
                [0, 0],
                [0, 0],
                [0, 0],
                [0, 0]
            ];
        }
    
        const transformedPoints = this.points.map(p => {
            const local = vec4.fromValues(p.x, p.y, 0, 1);
            const world = vec4.create();
            vec4.transformMat4(world, local, this.localMatrix);
            return [world[0], world[1]] as [number, number];
        });
    
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
        for (const [x, y] of transformedPoints) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    
        return [
            [minX, minY], // Bottom-left
            [maxX, minY], // Bottom-right
            [maxX, maxY], // Top-right
            [minX, maxY], // Top-left
        ];
    }

    getWorldSpaceBoundingBox(): { x: number; y: number; width: number; height: number } {
        if (this.points.length === 0) {
            return { x: 0, y: 0, width: 0, height: 0 };
        }
    
        const transformedPoints = this.points.map(p => {
            const local = vec4.fromValues(p.x, p.y, 0, 1);
            const world = vec4.create();
            vec4.transformMat4(world, local, this.localMatrix);
            return [world[0], world[1]] as [number, number];
        });
    
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
        for (const [x, y] of transformedPoints) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    
        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    public getGeometryVertices(): Float32Array {
        return new Float32Array(); // Geometry handled by StrokeRenderCache
    }
    
    public getGeometryIndices(): Uint16Array | null {
        return null; // No indices needed here either
    }

    override getBoundingBoxVertices(thickness: number): Float32Array {
        const { x, y, width, height } = this.getWorldSpaceBoundingBox();
    
        // TODO: fix this... this random 12 makes it close, but we shouldnt use random constants lol.
        const strokeExpansion = this.strokeWidth*12 * 0.035;
        const outerExpansion = strokeExpansion + thickness;
    
        return new Float32Array([
            // Outer (further expanded)
            x - outerExpansion,         y - outerExpansion,          // 0
            x + width + outerExpansion, y - outerExpansion,          // 1
            x - outerExpansion,         y + height + outerExpansion, // 2
            x + width + outerExpansion, y + height + outerExpansion, // 3
    
            // Inner (closer to stroke edge)
            x - strokeExpansion,         y - strokeExpansion,          // 4
            x + width + strokeExpansion, y - strokeExpansion,          // 5
            x - strokeExpansion,         y + height + strokeExpansion, // 6
            x + width + strokeExpansion, y + height + strokeExpansion  // 7
        ]);
    }

    override usesWorldSpaceBoundingBox(): boolean {
        return true;
    }
}
