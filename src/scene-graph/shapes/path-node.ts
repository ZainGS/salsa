/**
 * src/scene-graph/shapes/path-node.ts
 *
 * PathNode — the true vector Path shape (docs/specs/vector-paths.md P1): cubic-Bézier anchors + handles
 * PERSISTED as source data, tessellated lazily for everything downstream (fill triangulation, stroke
 * expansion, hit-testing, selection box). The pen tool commits these; the P2 node editor re-drags them.
 *
 * Conventions (all hard-won — see the spec's transform contract):
 *  - Anchor coords are ABSOLUTE world/document coords (like freeform Polygon points); x/y is a transform
 *    offset on top (0 at creation, set by dragging the committed shape).
 *  - Geometry is REAL-SIZE ⇒ getScaleFactors returns [scaleX, scaleY], never bounds — and it's guarded
 *    against the base-constructor-before-fields trap (the Line/Polygon bug family of 2026-09-10).
 *  - A CLOSED path renders as a filled region (ear-clip on the flattened ring, like Polygon); an OPEN path
 *    renders as a stroke (smoothed-normal quad strip along the flattened polyline) — both ride the generic
 *    unique-geometry shape lane, no new pipelines.
 *  - Tessellation caches on `anchorsVersion`; every mutation must go through _mutated() (bump + markDirty).
 *    Tolerance is derived from the path's own extent (≈ extent/2000), so curves stay smooth at sane zooms
 *    without a zoom-keyed cache (P2+ can add zoom buckets if deep zoom shows faceting).
 */

import { mat4, vec4 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { Vec2 } from '../../types/interaction';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';
import { Polygon } from './polygon';
import { flattenCubic, splitCubic, type Pt } from '../core/bezier';
import { evenOddFillGeometry } from '../core/even-odd-fill';

export interface PathAnchor {
    x: number;
    y: number;
    /** Tangent INTO the anchor, as an offset from it (control point = anchor + in). Absent = straight side. */
    in?: Pt | null;
    /** Tangent OUT of the anchor, as an offset from it (control point = anchor + out). */
    out?: Pt | null;
    /** Editor affordance: 'smooth' keeps in/out mirrored while dragging; 'cusp' frees them. */
    kind?: 'smooth' | 'cusp' | 'corner';
}

export class PathNode extends Shape {
    private _anchors: PathAnchor[];
    private _closed: boolean;

    /** Bumped on every anchor/handle mutation — the tessellation cache key. */
    public anchorsVersion = 0;
    private _flatCache: { version: number; pts: Pt[] } | null = null;

    constructor(
        anchors: PathAnchor[],
        closed: boolean,
        fillColor: RGBA = { r: 0, g: 0, b: 0, a: 0 },
        strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 1 },
        strokeWidth: number = 1,
        interactionService: InteractionService,
    ) {
        super(fillColor, strokeColor, strokeWidth, interactionService);
        this._anchors = anchors;
        this._closed = closed;
        this.calculateBoundingBox();
    }

    get anchors(): PathAnchor[] { return this._anchors; }
    get closed(): boolean { return this._closed; }

    /** Replace all anchors (the node editor's bulk write). */
    public setAnchors(anchors: PathAnchor[], closed = this._closed): void {
        this._anchors = anchors;
        this._closed = closed;
        this._mutated();
    }

    // ── Node-editor mutations (all funnel through _mutated → retessellate + re-upload) ─────────────────────

    /** Move an anchor; its handles are offsets, so they ride along automatically. */
    public moveAnchor(i: number, x: number, y: number): void {
        const a = this._anchors[i];
        if (!a) return;
        a.x = x; a.y = y;
        this._mutated();
    }

    /** Set one handle (offset from the anchor; null clears it). `mirror` keeps the opposite handle at the
     *  exact negation (the smooth-point drag); without it the anchor becomes a cusp. */
    public setHandle(i: number, which: 'in' | 'out', v: Pt | null, mirror: boolean): void {
        const a = this._anchors[i];
        if (!a) return;
        a[which] = v ? { x: v.x, y: v.y } : null;
        if (mirror) {
            const other = which === 'in' ? 'out' : 'in';
            a[other] = v ? { x: -v.x || 0, y: -v.y || 0 } : null;   // `|| 0` normalizes −0
            a.kind = 'smooth';
        } else if (a.kind === 'smooth') {
            a.kind = 'cusp';
        }
        this._mutated();
    }

    /** Insert an anchor on segment `segIdx` (anchors[segIdx] → next) at parameter `t` via an EXACT De
     *  Casteljau split — the curve's shape is unchanged, it just gains a control point. Returns its index. */
    public insertAnchorOnSegment(segIdx: number, t: number): number {
        const n = this._anchors.length;
        const a = this._anchors[segIdx], b = this._anchors[(segIdx + 1) % n];
        if (!a || !b) return -1;
        const c1: Pt = a.out ? { x: a.x + a.out.x, y: a.y + a.out.y } : a;
        const c2: Pt = b.in ? { x: b.x + b.in.x, y: b.y + b.in.y } : b;
        const curved = !!(a.out || b.in);
        const { left, right } = splitCubic(a, c1, c2, b, t);
        const mid = left[3];
        if (curved) {
            // Rewrite the surrounding handles from the split's control points (offsets from their anchors).
            a.out = { x: left[1].x - a.x, y: left[1].y - a.y };
            b.in = { x: right[2].x - b.x, y: right[2].y - b.y };
        }
        const anchor: PathAnchor = curved
            ? {
                x: mid.x, y: mid.y,
                in: { x: left[2].x - mid.x, y: left[2].y - mid.y },
                out: { x: right[1].x - mid.x, y: right[1].y - mid.y },
                kind: 'cusp',   // split handles are collinear but ASYMMETRIC (t vs 1−t) — cusp keeps it exact
            }
            : { x: mid.x, y: mid.y, kind: 'corner' };
        this._anchors.splice(segIdx + 1, 0, anchor);
        this._mutated();
        return segIdx + 1;
    }

    /** Remove an anchor (heals the gap into one segment). Refuses below the minimum (3 closed / 2 open). */
    public removeAnchor(i: number): boolean {
        const min = this._closed ? 3 : 2;
        if (this._anchors.length <= min || !this._anchors[i]) return false;
        this._anchors.splice(i, 1);
        this._mutated();
        return true;
    }

    private _mutated(): void {
        this.anchorsVersion++;
        this._flatCache = null;
        this.calculateBoundingBox();
        this.markDirty();   // clears cachedVertices/cachedIndices/world polygon → geometry re-uploads
    }

    protected getScaleFactors(): [number, number] {
        // Real-size geometry ⇒ [scaleX, scaleY]; runs during super() before _anchors exists.
        return [this.scaleX !== 0 ? this.scaleX : 1, this.scaleY !== 0 ? this.scaleY : 1];
    }

    getType(): string { return 'Path'; }

    override get hasUniqueGeometry(): boolean { return true; }

    // ── Tessellation ────────────────────────────────────────────────────────────────────────────────────────

    /** The path flattened to a polyline (closed: ring without the duplicate terminal point). Cached. */
    public flattenedPoints(): Pt[] {
        if (!this._anchors || this._anchors.length === 0) return [];
        if (this._flatCache && this._flatCache.version === this.anchorsVersion) return this._flatCache.pts;

        // Flatness tolerance from the path's own extent (anchors + handle tips), ~1/2000 of the diagonal.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const grow = (px: number, py: number) => {
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
        };
        for (const a of this._anchors) {
            grow(a.x, a.y);
            if (a.in) grow(a.x + a.in.x, a.y + a.in.y);
            if (a.out) grow(a.x + a.out.x, a.y + a.out.y);
        }
        const tol = Math.max(Math.hypot(maxX - minX, maxY - minY) / 2000, 1e-6);

        const n = this._anchors.length;
        const segCount = this._closed ? n : n - 1;
        const pts: Pt[] = [{ x: this._anchors[0].x, y: this._anchors[0].y }];
        for (let i = 0; i < segCount; i++) {
            const a = this._anchors[i], b = this._anchors[(i + 1) % n];
            const c1: Pt = a.out ? { x: a.x + a.out.x, y: a.y + a.out.y } : a;
            const c2: Pt = b.in ? { x: b.x + b.in.x, y: b.y + b.in.y } : b;
            if (a.out || b.in) pts.push(...flattenCubic(a, c1, c2, b, tol));
            else pts.push({ x: b.x, y: b.y });
        }
        // Closed ring: drop the duplicate terminal point back at anchor 0.
        if (this._closed && pts.length > 1) {
            const last = pts[pts.length - 1];
            if (Math.hypot(last.x - pts[0].x, last.y - pts[0].y) < 1e-9) pts.pop();
        }
        this._flatCache = { version: this.anchorsVersion, pts };
        return pts;
    }

    // ── Render geometry (the generic unique-geometry shape lane) ────────────────────────────────────────────

    public getGeometryVertices(): Float32Array {
        if (this.cachedVertices) return this.cachedVertices;
        const flat = this.flattenedPoints();
        if (this._closed) {
            this._buildClosedFill(flat);
        } else {
            this.cachedVertices = PathNode._strokeQuads(flat, this.strokeWidth / 2);
        }
        return this.cachedVertices!;
    }

    public getGeometryIndices(): Uint16Array | null {
        if (this.cachedIndices) return this.cachedIndices;
        const flat = this.flattenedPoints();
        let indices: number[];
        if (this._closed) {
            if (flat.length < 3) return null;
            this._buildClosedFill(flat);
            return this.cachedIndices ?? null;
        } else {
            if (flat.length < 2) return null;
            indices = [];
            for (let s = 0; s + 1 < flat.length; s++) {
                const base = s * 4;
                indices.push(base, base + 1, base + 2, base + 1, base + 2, base + 3);
            }
        }
        // WebGPU index buffers must be 4-byte aligned (even number of Uint16s).
        const padded = indices.length % 2 === 1 ? [...indices, 0] : indices;
        this.cachedIndices = new Uint16Array(padded);
        return this.cachedIndices;
    }

    /** Closed fill: EVEN-ODD trapezoid decomposition (self-intersecting outlines render like every vector
     *  tool — matches containsPoint's even-odd rule). Vertices + indices come from ONE build since the
     *  trapezoid soup has its own vertex list. Falls back to the raw-ring + ear-clip pair on degenerate or
     *  pathologically dense input (evenOddFillGeometry → null). */
    private _buildClosedFill(flat: Pt[]): void {
        const eo = flat.length >= 3 ? evenOddFillGeometry(flat) : null;
        if (eo) {
            this.cachedVertices = eo.verts;
            this.cachedIndices = eo.indices;
            return;
        }
        const verts = new Float32Array(flat.length * 2);
        for (let i = 0; i < flat.length; i++) { verts[i * 2] = flat[i].x; verts[i * 2 + 1] = flat[i].y; }
        this.cachedVertices = verts;
        const indices = flat.length >= 3 ? Polygon.earClipTriangulate(flat) : [];
        const padded = indices.length % 2 === 1 ? [...indices, 0] : indices;
        this.cachedIndices = indices.length ? new Uint16Array(padded) : undefined;
    }

    /** Smoothed-normal quad strip for an open path's stroke (same technique as the scribble expansion). */
    private static _strokeQuads(pts: Pt[], halfThickness: number): Float32Array {
        const segs = Math.max(0, pts.length - 1);
        const verts = new Float32Array(segs * 8);
        if (segs === 0) return verts;
        const normals: Pt[] = [];
        for (let p = 0; p < pts.length; p++) {
            const prev = pts[p - 1] ?? pts[p];
            const next = pts[p + 1] ?? pts[p];
            const dx = next.x - prev.x, dy = next.y - prev.y;
            const len = Math.hypot(dx, dy) || 1;
            normals.push({ x: -(dy / len) * halfThickness, y: (dx / len) * halfThickness });
        }
        let v = 0;
        for (let s = 0; s < segs; s++) {
            const a = pts[s], b = pts[s + 1], nA = normals[s], nB = normals[s + 1];
            verts[v++] = a.x - nA.x; verts[v++] = a.y - nA.y;
            verts[v++] = a.x + nA.x; verts[v++] = a.y + nA.y;
            verts[v++] = b.x - nB.x; verts[v++] = b.y - nB.y;
            verts[v++] = b.x + nB.x; verts[v++] = b.y + nB.y;
        }
        return verts;
    }

    // ── Bounds, selection, hit-testing (the Polygon pattern) ────────────────────────────────────────────────

    public calculateBoundingBox(): void {
        const flat = this.flattenedPoints();
        if (flat.length === 0) {
            this._boundingBox = { x: this.x, y: this.y, width: 0, height: 0 };
            return;
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of flat) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        this._boundingBox = { x: this.x + minX, y: this.y + minY, width: maxX - minX, height: maxY - minY };
    }

    public getWorldSpaceBoundingBoxPolygon(resetCache?: boolean): Vec2[] {
        if (this.cachedWorldSpaceBoundingPolygon != null && !resetCache) return this.cachedWorldSpaceBoundingPolygon;
        const flat = this.flattenedPoints();
        if (flat.length === 0) { this.cachedWorldSpaceBoundingPolygon = []; return []; }
        const M = this.localMatrix;
        const world: Vec2[] = flat.map(p => {
            const v = vec4.fromValues(p.x, p.y, 0, 1);
            vec4.transformMat4(v, v, M);
            return [v[0], v[1]] as Vec2;
        });
        this.cachedWorldSpaceBoundingPolygon = world;
        return world;
    }

    override getBoundingBoxVertices(thickness: number): Float32Array {
        const world = this.getWorldSpaceBoundingBoxPolygon();
        if (!world || world.length === 0) return new Float32Array(16);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of world) {
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
        const t = thickness;
        return new Float32Array([
            minX - t, minY - t, maxX + t, minY - t, minX - t, maxY + t, maxX + t, maxY + t,   // outer
            minX, minY, maxX, minY, minX, maxY, maxX, maxY,                                     // inner
        ]);
    }

    override usesWorldSpaceBoundingBox(): boolean { return true; }

    containsPoint(x: number, y: number): boolean {
        const inv = mat4.create();
        if (!mat4.invert(inv, this.localMatrix)) return false;
        const v = vec4.fromValues(x, y, 0, 1);
        vec4.transformMat4(v, v, inv);
        const px = v[0], py = v[1];
        const flat = this.flattenedPoints();
        if (flat.length === 0) return false;

        if (this._closed) {
            // Even-odd crossing test on the flattened ring.
            let inside = false;
            for (let i = 0, j = flat.length - 1; i < flat.length; j = i++) {
                const xi = flat[i].x, yi = flat[i].y, xj = flat[j].x, yj = flat[j].y;
                if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
            }
            return inside;
        }
        // Open path: distance to the flattened polyline vs stroke half-width (with a small pick slop).
        const r = Math.max(this.strokeWidth / 2, this.strokeWidth * 1.5);
        for (let s = 0; s + 1 < flat.length; s++) {
            const a = flat[s], b = flat[s + 1];
            const vx = b.x - a.x, vy = b.y - a.y;
            const L2 = vx * vx + vy * vy || 1;
            const t = Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / L2));
            const dx = px - (a.x + vx * t), dy = py - (a.y + vy * t);
            if (dx * dx + dy * dy <= r * r) return true;
        }
        return false;
    }

    // ── Persistence ─────────────────────────────────────────────────────────────────────────────────────────

    toJSON() {
        return {
            ...super.toJSON(),
            anchors: this._anchors.map(a => ({
                x: a.x, y: a.y,
                in: a.in ? { x: a.in.x, y: a.in.y } : undefined,
                out: a.out ? { x: a.out.x, y: a.out.y } : undefined,
                kind: a.kind,
            })),
            closed: this._closed,
        };
    }
}
