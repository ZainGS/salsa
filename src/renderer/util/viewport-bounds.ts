import { mat4, vec4 } from "gl-matrix";
import { InteractionService } from "../../services/interaction-service";
import { Shape } from "../../scene-graph/shapes/base/shape";
import { Line } from "../../scene-graph/shapes/line";
import { Scribble } from "../../scene-graph/shapes/scribble";

export class ViewportBounds {
    minX!: number;
    maxX!: number;
    minY!: number;
    maxY!: number;

    constructor(private interactionService: InteractionService) {
        this.update();
    }

    /** Update viewport bounds and transform them into world space */
    update(): void {
        const worldMatrix = this.interactionService.getWorldMatrix();

        // Compute the inverse world matrix (to map screen -> world space)
        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, worldMatrix);

        // Define viewport corners in screen space
        const screenCorners = [
            vec4.fromValues(-1, -1, 0, 1),  // Top-left (screen space)
            vec4.fromValues(1, 1, 0, 1) // Bottom-right (screen space)
        ];

        // Transform screen space bounds into world space
        const worldCorners = screenCorners.map(corner => {
            const transformed = vec4.create();
            vec4.transformMat4(transformed, corner, inverseWorldMatrix);
            return transformed;
        });

        // Update world-space bounds
        this.minX = worldCorners[0][0];
        this.maxX = worldCorners[1][0];
        this.minY = worldCorners[0][1];
        this.maxY = worldCorners[1][1];

        //console.log("Viewport Bounds (World Space):", this.minX, this.maxX, this.minY, this.maxY);
    }

    /** Check if a shape is inside the viewport using transformed coordinates */
    contains(shape: Shape): boolean {
        
        if (shape instanceof Line) {
            return this.containsLine(shape);
        } else if (shape instanceof Scribble) {
            return this.containsScribble(shape);
        }

        // Default behavior for regular shapes (bounding box check)
        const shapeMinX = shape.x - shape.width / 2;
        const shapeMaxX = shape.x + shape.width / 2;
        const shapeMinY = shape.y - shape.height / 2;
        const shapeMaxY = shape.y + shape.height / 2;

        // Return true if the shape is inside the viewport
        return (
            shapeMaxX >= this.minX &&
            shapeMinX <= this.maxX &&
            shapeMaxY >= this.minY &&
            shapeMinY <= this.maxY
        );
    }

    /** Checks if a line is visible within the viewport */
    private containsLine(line: Line): boolean {
        const x1 = line.x1;
        const y1 = line.y1;
        const x2 = line.x2;
        const y2 = line.y2;

        return (
            this.isPointInViewport(x1, y1) ||
            this.isPointInViewport(x2, y2) ||
            this.lineIntersectsViewport(x1, y1, x2, y2)
        );
    }

    /** Checks if a scribble is visible within the viewport */
    private containsScribble(scribble: Scribble): boolean {
        const points = scribble.points;
        if (points.length === 0) return false;

        // Check if any point in the scribble is inside the viewport
        for (const { x, y } of points) {
            if (this.isPointInViewport(x, y)) return true;
        }

        // Check if any segment of the scribble intersects the viewport
        for (let i = 1; i < points.length; i++) {
            const { x: x1, y: y1 } = points[i - 1];
            const { x: x2, y: y2 } = points[i];
            if (this.lineIntersectsViewport(x1, y1, x2, y2)) return true;
        }

        return false;
    }

    /** Returns true if a point is inside the viewport */
    private isPointInViewport(x: number, y: number): boolean {
        return x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY;
    }

    /** Returns true if a line segment intersects the viewport */
    private lineIntersectsViewport(x1: number, y1: number, x2: number, y2: number): boolean {
        return this.lineIntersectsSegment(x1, y1, x2, y2, this.minX, this.minY, this.maxX, this.minY) || // Bottom
            this.lineIntersectsSegment(x1, y1, x2, y2, this.minX, this.maxY, this.maxX, this.maxY) || // Top
            this.lineIntersectsSegment(x1, y1, x2, y2, this.minX, this.minY, this.minX, this.maxY) || // Left
            this.lineIntersectsSegment(x1, y1, x2, y2, this.maxX, this.minY, this.maxX, this.maxY);   // Right
    }

    /** Checks if two line segments (p1→p2 and p3→p4) intersect */
    private lineIntersectsSegment(x1: number, y1: number, x2: number, y2: number, 
        x3: number, y3: number, x4: number, y4: number): boolean {
        function ccw(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
            return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
        }
        return ccw(x1, y1, x3, y3, x4, y4) !== ccw(x2, y2, x3, y3, x4, y4) &&
            ccw(x1, y1, x2, y2, x3, y3) !== ccw(x1, y1, x2, y2, x4, y4);
    }
    
}