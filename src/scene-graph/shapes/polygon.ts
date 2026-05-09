// src/scene-graph/polygon.ts
// Represents a polygon defined by a series of points.

import { mat4, vec3, vec4 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { Vec2 } from '../../types/interaction';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';

/** Available preset polygon shapes for createPresetPolygon. */
export type PolygonPreset =
    | 'parallelogram'
    | 'trapezoid'
    | 'arrowRight'
    | 'chevron'
    | 'star5'
    | 'star6'
    | 'cross'
    | 'speechBubble';

export class Polygon extends Shape {
    private _points: { x: number; y: number }[];
    /** Optional preset tag for serialization (e.g. 'parallelogram'). */
    public presetTag: string | null = null;
    
    constructor(
        points: { x: number; y: number }[], 
        fillColor: RGBA = {r:0,g:0,b:0,a:0}, 
        strokeColor: RGBA = {r:0,g:0,b:0,a:1}, 
        strokeWidth: number = 1,
        interactionService: InteractionService
    ) {
        super(fillColor, strokeColor, strokeWidth, interactionService);
        this._points = points;
        this.calculateBoundingBox(); // Calculate initial bounding box
    }

    protected getScaleFactors(): [number, number] {
        // Guard: _points is undefined during super() constructor (updateLocalMatrix
        // is called before subclass field assignment).
        if (!this._points || this._points.length === 0) return [1, 1];

        const minX = Math.min(...this._points.map(p => p.x));
        const minY = Math.min(...this._points.map(p => p.y));
        const maxX = Math.max(...this._points.map(p => p.x));
        const maxY = Math.max(...this._points.map(p => p.y));

        return [maxX-minX || 1, maxY-minY || 1];
    }

    get points() {
        return this._points;
    }

    /** Replace all points, invalidate geometry caches, and recalculate bounding box. */
    public setPoints(points: { x: number; y: number }[]): void {
        this._points = points;
        this.cachedVertices = undefined;
        this.cachedIndices = undefined;
        this.calculateBoundingBox();
        this.markDirty();
    }

    /** Add a single point, invalidate caches, and recalculate bounding box. */
    public addPoint(pt: { x: number; y: number }): void {
        this._points.push(pt);
        this.cachedVertices = undefined;
        this.cachedIndices = undefined;
        this.calculateBoundingBox();
        this.markDirty();
    }

    /** Update the last point in-place (for rubber-banding). */
    public updateLastPoint(pt: { x: number; y: number }): void {
        if (this._points.length === 0) return;
        this._points[this._points.length - 1] = pt;
        this.cachedVertices = undefined;
        this.cachedIndices = undefined;
        this.calculateBoundingBox();
        this.markDirty();
    }

    /** Remove the last point (e.g. undo the rubber-band ghost point). */
    public removeLastPoint(): void {
        if (this._points.length === 0) return;
        this._points.pop();
        this.cachedVertices = undefined;
        this.cachedIndices = undefined;
        this.calculateBoundingBox();
        this.markDirty();
    }

    toJSON() {
        return {
            ...super.toJSON(),
            points: this._points.map(p => ({ x: p.x, y: p.y })),
            presetTag: this.presetTag,
        };
    }

    containsPoint(x: number, y: number): boolean {
        const inverseLocalMatrix = mat4.create();
        if (!mat4.invert(inverseLocalMatrix, this.localMatrix)) return false;
    
        const localPoint = vec3.fromValues(x, y, 0);
        vec3.transformMat4(localPoint, localPoint, inverseLocalMatrix);
    
        let inside = false;
        for (let i = 0, j = this._points.length - 1; i < this._points.length; j = i++) {
            const xi = this._points[i].x;
            const yi = this._points[i].y;
            const xj = this._points[j].x;
            const yj = this._points[j].y;
    
            const intersect = ((yi > localPoint[1]) !== (yj > localPoint[1])) &&
                              (localPoint[0] < (xj - xi) * (localPoint[1] - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
    
        return inside;
    }

    public getWorldSpaceBoundingBoxPolygon(resetCache?: boolean): Vec2[] {
        if (this.cachedWorldSpaceBoundingPolygon != null && !resetCache)
            return this.cachedWorldSpaceBoundingPolygon;

        if (!this._points || this._points.length === 0) {
            this.cachedWorldSpaceBoundingPolygon = [];
            return [];
        }

        const M = this.localMatrix;
        const worldPoints: Vec2[] = this._points.map(p => {
            const v = vec4.fromValues(p.x, p.y, 0, 1);
            vec4.transformMat4(v, v, M);
            return [v[0], v[1]] as Vec2;
        });

        this.cachedWorldSpaceBoundingPolygon = worldPoints;
        return worldPoints;
    }

    public calculateBoundingBox(): void {
        if (!this._points || this._points.length === 0) {
            this._boundingBox = { x: this.x, y: this.y, width: 0, height: 0 };
            return;
        }

        const minX = Math.min(...this._points.map(p => p.x));
        const minY = Math.min(...this._points.map(p => p.y));
        const maxX = Math.max(...this._points.map(p => p.x));
        const maxY = Math.max(...this._points.map(p => p.y));
    
        this._boundingBox = {
            x: this.x + minX,
            y: this.y + minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }

    getType(): string {
        return "Polygon";
    }

    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;

        // Flatten points into [x0, y0, x1, y1, ...] vertex buffer
        const verts = new Float32Array(this._points.length * 2);
        for (let i = 0; i < this._points.length; i++) {
            verts[i * 2]     = this._points[i].x;
            verts[i * 2 + 1] = this._points[i].y;
        }
        this.cachedVertices = verts;
        return verts;
    }
    
    public getGeometryIndices(): Uint16Array | null {
        if (this.cachedIndices) return this.cachedIndices;
        if (this._points.length < 3) return null;

        const indices = Polygon.earClipTriangulate(this._points);
        if (indices.length === 0) return null;

        // WebGPU index buffers must be 4-byte aligned (even number of Uint16s)
        let result: Uint16Array;
        if ((indices.length * 2) % 4 !== 0) {
            result = new Uint16Array(indices.length + 1);
            result.set(indices);
        } else {
            result = new Uint16Array(indices);
        }
        this.cachedIndices = result;
        return result;
    }

    // ── Ear-clipping triangulation ──────────────────────────────────

    /**
     * Triangulate a simple polygon via ear-clipping.
     * Handles convex and concave polygons (but not self-intersecting).
     * Returns an array of triangle vertex indices.
     */
    private static earClipTriangulate(pts: { x: number; y: number }[]): number[] {
        const n = pts.length;
        if (n < 3) return [];
        if (n === 3) return [0, 1, 2];

        // Build index list
        const idx = Array.from({ length: n }, (_, i) => i);
        const tris: number[] = [];

        // Ensure CCW winding (signed area > 0)
        let signedArea = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            signedArea += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        if (signedArea < 0) idx.reverse();

        let remaining = idx.length;
        let failSafe = remaining * 2; // prevent infinite loop on degenerate input

        let i = 0;
        while (remaining > 2 && failSafe-- > 0) {
            const a = idx[i % remaining];
            const b = idx[(i + 1) % remaining];
            const c = idx[(i + 2) % remaining];

            if (Polygon.isEar(pts, idx, remaining, i, a, b, c)) {
                tris.push(a, b, c);
                // Remove vertex b from the index list
                idx.splice((i + 1) % remaining, 1);
                remaining--;
                failSafe = remaining * 2; // reset watchdog
                // Don't advance i — re-check from current position
            } else {
                i++;
            }
        }
        return tris;
    }

    private static cross2D(ax: number, ay: number, bx: number, by: number): number {
        return ax * by - ay * bx;
    }

    /** Check if triangle abc is a valid ear (convex + no other vertex inside). */
    private static isEar(
        pts: { x: number; y: number }[],
        idx: number[], remaining: number,
        i: number, a: number, b: number, c: number
    ): boolean {
        const ax = pts[a].x, ay = pts[a].y;
        const bx = pts[b].x, by = pts[b].y;
        const cx = pts[c].x, cy = pts[c].y;

        // Must be convex (CCW cross product > 0)
        if (Polygon.cross2D(bx - ax, by - ay, cx - bx, cy - by) <= 0) return false;

        // Check no other polygon vertex lies inside triangle abc
        for (let j = 0; j < remaining; j++) {
            const vi = idx[j];
            if (vi === a || vi === b || vi === c) continue;
            if (Polygon.pointInTriangle(pts[vi].x, pts[vi].y, ax, ay, bx, by, cx, cy)) {
                return false;
            }
        }
        return true;
    }

    /** Barycentric point-in-triangle test. */
    private static pointInTriangle(
        px: number, py: number,
        ax: number, ay: number, bx: number, by: number, cx: number, cy: number
    ): boolean {
        const d1 = Polygon.cross2D(bx - ax, by - ay, px - ax, py - ay);
        const d2 = Polygon.cross2D(cx - bx, cy - by, px - bx, py - by);
        const d3 = Polygon.cross2D(ax - cx, ay - cy, px - cx, py - cy);
        const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
        const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
        return !(hasNeg && hasPos);
    }
}