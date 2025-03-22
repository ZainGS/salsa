/* 
A few ideas for future optimization:

Bounding box pre-computation: Store an axis-aligned bounding box (minX, maxX, minY, maxY) for all point-based shapes so visibility checks can start with a simple AABB test before doing more expensive calculations.
Right now, there are lots of shapes that don't have a defined width/height but are drawn based on control points (e.g., Line, Scribble, Pattern).
In the calculateBoundingBox() implementation for these shapes, I should find a way to calculate the correct height/width of the object.
Then I can replace the intersection checks with these simple 4 vertex checks. :)
...
But, right now we transform the Viewport into shape local space which is also good.
We cache the transformation for each shape; To optimize THIS even more, instead of clearing
the WHOLE cache on markDirty() we can is isDirty flags on each individual shape and only clear
the cache of those when they are true. So we only have to recompute those and not the whole cache,
but this is a future optimization problem, right now I am tired from all the matrix math...

Hierarchical culling: Eventually, use a quadtree or spatial hashing to quickly reject off-screen elements before running per-shape logic.
Parallel processing: For a massive performance boosts, we can theoretically use WebGPU compute shaders for batch culling instead of 
iterating over the scene in JavaScript... this will be a future optimization strategy I'll have to learn how to implement cleanly.
*/

import { mat4, vec4 } from "gl-matrix";
import { InteractionService } from "../../services/interaction-service";
import { Shape } from "../../scene-graph/shapes/base/shape";
import { Line } from "../../scene-graph/shapes/line";
import { Scribble } from "../../scene-graph/shapes/scribble";
import { Highlight } from "../../scene-graph/shapes/highlight";
import { Pattern } from "../../scene-graph/shapes/pattern";

export class ViewportBounds {
    minX!: number;
    maxX!: number;
    minY!: number;
    maxY!: number;

    private interactionService: InteractionService;
    private isViewportDirty: boolean = true; // Flag to track updates
    
    /** Cached transformed viewport per shape */
    private transformedViewportCache = new Map<Shape, { minX: number; maxX: number; minY: number; maxY: number }>();

    constructor(interactionService: InteractionService) {
        this.interactionService = interactionService;
        this.update();
    }

    /** Call this when panning or zooming occurs */
    markDirty(): void {
        this.isViewportDirty = true;

        /* For even more performance optimizations, we could use an isDirty flag per shape & only 
        invalidate specific cached transformed viewports instead of clearing the entire cache. 
        That would avoid unnecessary recalculations and make culling even more efficient, 
        especially when dealing with tons of shapes moving independently. */
        this.transformedViewportCache.clear(); // Invalidate cache since viewport changed
    }

    /** Update viewport bounds and transform them into world space */
    update(): void {
        if (!this.isViewportDirty) return; // Skip unnecessary calculations

        const worldMatrix = this.interactionService.getWorldMatrix();
        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, worldMatrix);

        // Define viewport corners in NDC (normalized device coordinates)
        const screenCorners = [
            vec4.fromValues(-1, -1, 0, 1), // Bottom-left (NDC)
            vec4.fromValues(1, 1, 0, 1)   // Top-right (NDC)
        ];

        // Transform viewport corners into world space
        const worldCorners = screenCorners.map(corner => {
            const transformed = vec4.create();
            vec4.transformMat4(transformed, corner, inverseWorldMatrix);
            return transformed;
        });

        // Store world-space bounds
        this.minX = worldCorners[0][0];
        this.maxX = worldCorners[1][0];
        this.minY = worldCorners[0][1];
        this.maxY = worldCorners[1][1];

        this.isViewportDirty = false;
    }

    /** Cached computation of transformed viewport bounds per shape */
    private computeTransformedViewport(shape: Shape): { minX: number; maxX: number; minY: number; maxY: number } | null {
        
        if (this.transformedViewportCache.has(shape)) {
            return this.transformedViewportCache.get(shape)!; // Return cached result
        }

        const inverseShapeMatrix = mat4.create();

        // Invert the shape’s local matrix (to transform viewport bounds into the shape’s space)
        if (!mat4.invert(inverseShapeMatrix, shape.localMatrix)) return null;

        const viewportCorners = [
            vec4.fromValues(this.minX, this.minY, 0, 1),
            vec4.fromValues(this.maxX, this.minY, 0, 1),
            vec4.fromValues(this.maxX, this.maxY, 0, 1),
            vec4.fromValues(this.minX, this.maxY, 0, 1)
        ];

        const transformedCorners = viewportCorners.map(corner => {
            const transformed = vec4.create();
            vec4.transformMat4(transformed, corner, inverseShapeMatrix); // Transform viewport to shape space
            return transformed;
        });

        const transformedViewport = {
            minX: Math.min(...transformedCorners.map(p => p[0])),
            maxX: Math.max(...transformedCorners.map(p => p[0])),
            minY: Math.min(...transformedCorners.map(p => p[1])),
            maxY: Math.max(...transformedCorners.map(p => p[1]))
        };

        this.transformedViewportCache.set(shape, transformedViewport); // Cache result
        return transformedViewport;
    }

    /** Check if a shape is inside the viewport */
    contains(shape: Shape): boolean {
        if (shape instanceof Line || shape instanceof Scribble || shape instanceof Highlight || shape instanceof Pattern) {
            return this.containsControlPointShape(shape);
        }

        // Default behavior for regular shapes (bounding box check)
        const shapeMinX = shape.x - shape.width / 2;
        const shapeMaxX = shape.x + shape.width / 2;
        const shapeMinY = shape.y - shape.height / 2;
        const shapeMaxY = shape.y + shape.height / 2;

        return (
            shapeMaxX >= this.minX &&
            shapeMinX <= this.maxX &&
            shapeMaxY >= this.minY &&
            shapeMinY <= this.maxY
        );
    }

    /** Checks visibility for control point-based shapes */
    private containsControlPointShape(shape: Line | Pattern | Scribble | Highlight): boolean {
        // Compute viewport bounds for this specific shape
        const transformedViewport = this.computeTransformedViewport(shape);
        if (!transformedViewport) return false; // Ensure transformed viewport is available

        // Get shape control points
        const controlPoints = shape instanceof Scribble || shape instanceof Highlight ? shape.points : [
            { x: shape.x1, y: shape.y1 },
            { x: shape.x2, y: shape.y2 }
        ];

        for (const { x, y } of controlPoints) {
            if (this.isPointInTransformedViewport(x, y, transformedViewport)) {
                return true;
            }
        }

        return this.lineIntersectsViewport(
            controlPoints[0].x, controlPoints[0].y,
            controlPoints[controlPoints.length - 1].x, controlPoints[controlPoints.length - 1].y
        );
    }

    /** Returns true if a point is inside the transformed viewport */
    private isPointInTransformedViewport(x: number, y: number, transformedViewport: { minX: number; maxX: number; minY: number; maxY: number }): boolean {
        return (
            x >= transformedViewport.minX &&
            x <= transformedViewport.maxX &&
            y >= transformedViewport.minY &&
            y <= transformedViewport.maxY
        );
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

    public updateVisibility(nodes: Shape[]): void {
        this.update(); // Ensure viewport is updated once per frame

        for (const node of nodes) {
            node.visible = this.contains(node);
        }
    }
}
