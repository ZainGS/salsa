// src/scene-graph/line.ts
import { mat4, vec3, vec4 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape, ConnectionPoint } from './base/shape';

export type ArrowheadStyle = 'none' | 'closedCircle' | 'openCircle' | 'triangle' | 'open';

/** Binding that ties a line endpoint to a shape's connection port. */
export interface ConnectorBinding {
    /** ID of the shape this endpoint is attached to. */
    shapeId: string;
    /** Port ID on that shape (e.g. 'top', 'right', 'bottom', 'left', 'center'). */
    portId: string;
}

export class Line extends Shape {
    private _x1: number;
    private _y1: number;
    private _x2: number;
    private _y2: number;
    interactionService!: InteractionService;

    /** Arrowhead at the start (x1,y1) of the line. */
    public arrowStart: ArrowheadStyle = 'none';
    /** Arrowhead at the end (x2,y2) of the line. */
    public arrowEnd: ArrowheadStyle = 'none';
    /** Arrowhead size as a multiplier of strokeWidth. */
    public arrowSize: number = 6;

    /** Connector binding for the start endpoint (null = free/unbound). */
    public startBinding: ConnectorBinding | null = null;
    /** Connector binding for the end endpoint (null = free/unbound). */
    public endBinding: ConnectorBinding | null = null;

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
    
    public calculateBoundingBox() {
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
    
    
    /** Update the start point (x1, y1). Clears any start binding. */
    public updateStartPoint(x1: number, y1: number) {
        this._x1 = x1;
        this._y1 = y1;
        this._isPointsDirty = true;
        this.calculateBoundingBox();
        this.markDirty();
    }

    public updateEndPoint(x2: number, y2: number) {
        this._x2 = x2;
        this._y2 = y2;
        this._isPointsDirty = true;
        this.calculateBoundingBox();
        this.markDirty();
    }

    /** Connection points for lines: start, end, and midpoint (all in world space). */
    public override getConnectionPoints(): ConnectionPoint[] {
        const m = this.localMatrix;
        const transform = (lx: number, ly: number) => {
            const v = vec4.fromValues(lx, ly, 0, 1);
            const w = vec4.create();
            vec4.transformMat4(w, v, m);
            return { x: w[0], y: w[1] };
        };
        const s = transform(this._x1, this._y1);
        const e = transform(this._x2, this._y2);
        const mid = transform((this._x1 + this._x2) / 2, (this._y1 + this._y2) / 2);
        return [
            { id: 'start', ...s },
            { id: 'end', ...e },
            { id: 'mid', ...mid },
        ];
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
            y2: this.y2,
            arrowStart: this.arrowStart,
            arrowEnd: this.arrowEnd,
            arrowSize: this.arrowSize,
            startBinding: this.startBinding,
            endBinding: this.endBinding
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
        if (length === 0) {
            this.cachedVertices = new Float32Array(0);
            return this.cachedVertices;
        }
        const nx = -(dirY / length) * halfThickness;
        const ny = (dirX / length) * halfThickness;

        const verts: number[] = [];

        // Arrowhead sizing
        const arrowLen = this.strokeWidth * this.arrowSize; // triangle arrow length
        const circleRadius = this.strokeWidth * this.arrowSize * 0.5; // circle radius
        const SEGMENTS = 12; // triangle-fan segments for circles

        // Shorten line endpoints if arrowheads are present so the shaft doesn't poke through
        let sx = startX, sy = startY, ex = endX, ey = endY;
        if (this.arrowEnd !== 'none') {
            const pullback = (this.arrowEnd === 'triangle') ? arrowLen : circleRadius;
            ex -= (dirX / length) * pullback;
            ey -= (dirY / length) * pullback;
        }
        if (this.arrowStart !== 'none') {
            const pullback = (this.arrowStart === 'triangle') ? arrowLen : circleRadius;
            sx += (dirX / length) * pullback;
            sy += (dirY / length) * pullback;
        }

        // Normalize legacy alias: 'open' → 'openCircle'
        const endStyle = this.arrowEnd === 'open' ? 'openCircle' : this.arrowEnd;
        const startStyle = this.arrowStart === 'open' ? 'openCircle' : this.arrowStart;

        // ── Line shaft (2 triangles) ──
        verts.push(
            sx - nx, sy - ny,  // BL
            ex - nx, ey - ny,  // BR
            sx + nx, sy + ny,  // TL
            sx + nx, sy + ny,  // TL dup
            ex - nx, ey - ny,  // BR dup
            ex + nx, ey + ny   // TR
        );

        // ── Helper: push a filled circle (triangle fan) ──
        const pushFilledCircle = (cx: number, cy: number, r: number) => {
            for (let i = 0; i < SEGMENTS; i++) {
                const a0 = (i / SEGMENTS) * Math.PI * 2;
                const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
                verts.push(
                    cx, cy,
                    cx + Math.cos(a0) * r, cy + Math.sin(a0) * r,
                    cx + Math.cos(a1) * r, cy + Math.sin(a1) * r
                );
            }
        };

        // ── Helper: push an open circle (ring / annulus) ──
        const pushOpenCircle = (cx: number, cy: number, r: number, thickness: number) => {
            const rInner = Math.max(0, r - thickness);
            for (let i = 0; i < SEGMENTS; i++) {
                const a0 = (i / SEGMENTS) * Math.PI * 2;
                const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
                const c0 = Math.cos(a0), s0 = Math.sin(a0);
                const c1 = Math.cos(a1), s1 = Math.sin(a1);
                // Outer edge
                const ox0 = cx + c0 * r,    oy0 = cy + s0 * r;
                const ox1 = cx + c1 * r,    oy1 = cy + s1 * r;
                // Inner edge
                const ix0 = cx + c0 * rInner, iy0 = cy + s0 * rInner;
                const ix1 = cx + c1 * rInner, iy1 = cy + s1 * rInner;
                // Two triangles per segment
                verts.push(ox0, oy0, ox1, oy1, ix0, iy0);
                verts.push(ix0, iy0, ox1, oy1, ix1, iy1);
            }
        };

        // ── Helper: push a filled triangle arrowhead ──
        const pushTriangle = (tipX: number, tipY: number, dxN: number, dyN: number) => {
            // dxN, dyN = unit direction the arrow points toward
            const baseX = tipX - dxN * arrowLen;
            const baseY = tipY - dyN * arrowLen;
            const wingNx = -(dyN) * arrowLen * 0.5;
            const wingNy = (dxN) * arrowLen * 0.5;
            verts.push(
                tipX, tipY,
                baseX + wingNx, baseY + wingNy,
                baseX - wingNx, baseY - wingNy
            );
        };

        // ── Arrowhead at end (x2,y2) ──
        if (endStyle === 'triangle') {
            pushTriangle(endX, endY, dirX / length, dirY / length);
        } else if (endStyle === 'closedCircle') {
            pushFilledCircle(endX, endY, circleRadius);
        } else if (endStyle === 'openCircle') {
            pushOpenCircle(endX, endY, circleRadius, halfThickness);
        }

        // ── Arrowhead at start (x1,y1) ──
        if (startStyle === 'triangle') {
            pushTriangle(startX, startY, -(dirX / length), -(dirY / length));
        } else if (startStyle === 'closedCircle') {
            pushFilledCircle(startX, startY, circleRadius);
        } else if (startStyle === 'openCircle') {
            pushOpenCircle(startX, startY, circleRadius, halfThickness);
        }

        this.cachedVertices = new Float32Array(verts);
        return this.cachedVertices;
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