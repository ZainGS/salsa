import { mat4, vec4 } from 'gl-matrix';

// Shared scratch vectors for updateLocalMatrix — this runs for EVERY moving mesh EVERY frame (city traffic),
// and fresh `[x,y,z]`/`[sx,sy,sz]` literals per call added up to real GC pressure. Safe to share: the function
// is synchronous + non-reentrant (gl-matrix reads the vector before returning).
const _translateScratch = new Float32Array(3);
const _scaleScratch = new Float32Array(3);

// §3.13: degenerate (zero-scale) matrices during interactive scaling made ~8 shapes spam
// console.error per pointer-move. Warn ONCE per session, then stay silent — every call
// site already has a safe fallback (identity matrix / hit-test miss / original point).
let _matrixInversionWarned = false;
export function warnMatrixInversionFailedOnce(): void {
    if (!_matrixInversionWarned) {
        _matrixInversionWarned = true;
        console.warn("Matrix inversion failed (degenerate transform) — further occurrences suppressed");
    }
}
import { RGBA } from '../../../types/rgba';
import { Node } from './node';
import { InteractionService } from '../../../services/interaction-service';
import { Vec2 } from '../../../types/interaction';

/** A named connection point on a shape's boundary, in world coordinates. */
export interface ConnectionPoint {
    /** Unique id within the shape (e.g. 'top', 'right', 'bottom', 'left', 'center'). */
    id: string;
    /** World-space X. */
    x: number;
    /** World-space Y. */
    y: number;
}

export abstract class Shape extends Node {
    private _id?: string;
    public _width!: number;
    public _height!: number;
    public _localMatrix: mat4;
    protected _localMatrixVersion: number = 0;

    // Cached combined (parentChain × local) matrix. Recomputed only when _localMatrixVersion
    // changes or the parentChainMatrix reference changes (i.e. parent transform was updated).
    private _cachedCombinedMatrix: mat4 = mat4.create();
    private _cachedCombinedVersion: number = -1;
    private _cachedCombinedParent: mat4 | null = null;
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

    /**
     * §3.5: non-minting id peek. Unlike the `id` getter this never allocates a UUID —
     * used by Node.addChild/removeChild to sync the scene graph's id→node map without
     * eagerly minting ids for every procedural node.
     */
    public peekId(): string | undefined {
        return this._id;
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

    /**
     * Injectable guard that prevents selection while a drawing tool is active.
     * Set once by ShapeManager on startup — avoids Shape importing ShapeManager (cycle).
     */
    public static selectionGuard: (() => boolean) | null = null;

    // Method to select the shape
    public select() {
        const blocked = Shape.selectionGuard ? Shape.selectionGuard() : false;
        if(!blocked) {
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
        // Subclasses override getScaleFactors() to control XY display scale independently
        // of this.scaleX/Y (e.g. Mesh3D always returns [1,1] since its 3D scale lives in
        // the GPU model matrix, not in the 2D local matrix).
        const [rawX, rawY] = this.getScaleFactors();

        mat4.identity(this._localMatrix);
        _translateScratch[0] = this.x; _translateScratch[1] = this.y; _translateScratch[2] = this.z;
        mat4.translate(this._localMatrix, this._localMatrix, _translateScratch as unknown as [number, number, number]);
        // Apply rotations: Y (yaw) → X (pitch) → Z (roll/2D rotation)
        if (this.rotationY !== 0) mat4.rotateY(this._localMatrix, this._localMatrix, this.rotationY);
        if (this.rotationX !== 0) mat4.rotateX(this._localMatrix, this._localMatrix, this.rotationX);
        mat4.rotateZ(this._localMatrix, this._localMatrix, this.rotation);
        // Clamp to non-zero so the matrix stays invertible (getInverseLocalMatrix uses mat4.invert).
        _scaleScratch[0] = rawX !== 0 ? rawX : 1e-6;
        _scaleScratch[1] = rawY !== 0 ? rawY : 1e-6;
        _scaleScratch[2] = this.scaleZ !== 0 ? this.scaleZ : 1e-6;
        mat4.scale(this._localMatrix, this._localMatrix, _scaleScratch as unknown as [number, number, number]);
        // §3.4: this override replaces Node.updateLocalMatrix, so it must uphold the same
        // invariant: local matrix changed ⇒ children's parentChainMatrix caches are stale.
        // The transform setters used to walk the subtree a second time for this; now
        // updateLocalMatrix is the single owner of that walk.
        this.markChildrenParentChainDirty();
    }

    protected abstract getScaleFactors(): [number, number];

    get localMatrix(): mat4 {
        const p = this.parentChainMatrix;
        if (this._cachedCombinedVersion === this._localMatrixVersion &&
            this._cachedCombinedParent  === p) {
            return this._cachedCombinedMatrix;
        }
        mat4.mul(this._cachedCombinedMatrix, p, this._localMatrix);
        this._cachedCombinedVersion = this._localMatrixVersion;
        this._cachedCombinedParent  = p;
        return this._cachedCombinedMatrix;
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
    public getWorldSpaceBoundingBoxPolygon(resetCache?: boolean): Vec2[] {
        if (this.cachedWorldSpaceBoundingPolygon != null && !resetCache) return this.cachedWorldSpaceBoundingPolygon;
        
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

    getWorldSpaceBoundingBoxPolygonRelativeToParent(parentMatrix?: mat4): Vec2[] {
  const corners = this.getLocalBoundingBoxCorners();
  const M = mat4.create();
  if (parentMatrix) {
    // parentMatrix is the space you want to be relative to – only combine with *local* transform
    mat4.multiply(M, parentMatrix, this._localMatrix);
  } else {
    // full world (parents already included)
    mat4.copy(M, this.localMatrix);
  }

  const out: Vec2[] = [];
  for (const [cx, cy] of corners) {
    const v = vec4.fromValues(cx, cy, 0, 1);
    vec4.transformMat4(v, v, M);
    out.push([v[0], v[1]]);
  }
  return out;
}

    public getLocalBoundingBoxCorners(): Vec2[] {
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
    
        return [
            [-halfWidth, -halfHeight], // Bottom-left
            [halfWidth, -halfHeight],  // Bottom-right
            [halfWidth, halfHeight],   // Top-right
            [-halfWidth, halfHeight],  // Top-left
        ];
    }

    public calculateBoundingBox() {
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

    public transformBoundingBoxToNDC() {
  const { x, y, width, height } = this.boundingBox;
  const localCorners = [
    vec4.fromValues(x,           y,            0, 1),
    vec4.fromValues(x + width,   y,            0, 1),
    vec4.fromValues(x,           y + height,   0, 1),
    vec4.fromValues(x + width,   y + height,   0, 1),
  ];

  const world = this.localMatrix;                       // node (parents included)
  const viewProj = this._interactionService.getWorldMatrix(); // camera/world

  const xs: number[] = [], ys: number[] = [];
  for (const c of localCorners) {
    const w = vec4.create();
    vec4.transformMat4(w, c, world);
    vec4.transformMat4(w, w, viewProj);
    xs.push(w[0]); ys.push(w[1]);
  }
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

    public isShapeDirty() {
        return this._isDirty;
    }

    public resetDirtyFlag() {
        this._isDirty = false;
    }

    private cachedInverseLocalMatrix: mat4 | null = null;
    // Cache key: the inverse is a pure function of the combined localMatrix, which changes
    // only when _localMatrixVersion bumps or the parentChainMatrix reference changes — the
    // exact same signal the combined-matrix cache above trusts. Mirroring that key here is
    // therefore as safe as that (shipping) cache. (Earlier the cache was disabled because it
    // had NO invalidation and went stale during scaling-handle drags.)
    private _cachedInverseVersion: number = -1;
    private _cachedInverseParent: mat4 | null = null;
    public getInverseLocalMatrix(): mat4 {
        const m = this.localMatrix; // combined (parent × local); also refreshes the version/parent below
        const parent = this.parentChainMatrix;
        if (this.cachedInverseLocalMatrix != null &&
            this._cachedInverseVersion === this._localMatrixVersion &&
            this._cachedInverseParent === parent) {
            return this.cachedInverseLocalMatrix;
        }

        const inverse = mat4.create();
        const success = mat4.invert(inverse, m);

        if (!success) {
            warnMatrixInversionFailedOnce(); // §3.13: was a per-call console.warn
            return mat4.create(); // Identity fallback if needed
        }

        this.cachedInverseLocalMatrix = inverse;
        this._cachedInverseVersion = this._localMatrixVersion;
        this._cachedInverseParent = parent;
        return inverse;
    }

    // These are LOCAL-space corners — a pure function of this.width/this.height (no matrix applied,
    // despite the name). §3.5 audit note: not worth caching. It has NO callers inside the engine, so
    // there is no hot path to optimize; and if one ever appears, the correct invalidation key is the
    // (width, height) VALUES themselves — not a _localMatrixVersion (which the direct _width/_height
    // writes in LiveText/Scribble/Group bypass) and not a bespoke cross-file _dimVersion. So the old
    // "needs a dimension-version" TODO was a false premise: value-key it in place if it ever goes hot.
    public getWorldSpaceCorners(): [vec4, vec4, vec4, vec4] {
        // Define the four corners of the bounding box rectangle in local space
        const corners: vec4[] = [
            vec4.fromValues(-this.width / 2, -this.height / 2, 0, 1), // Bottom-left
            vec4.fromValues(this.width / 2, -this.height / 2, 0, 1),  // Bottom-right
            vec4.fromValues(this.width / 2, this.height / 2, 0, 1),   // Top-right
            vec4.fromValues(-this.width / 2, this.height / 2, 0, 1),  // Top-left
        ];
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
            warnMatrixInversionFailedOnce(); // §3.13: was per-pointer-move console.error spam
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

    // ── Connection Points (for flowcharting / smart arrows) ─────────

    /**
     * Returns named connection points on this shape's boundary in world coordinates.
     * Default implementation returns the 4 edge midpoints + center of the bounding box.
     * Subclasses can override to provide shape-specific anchor points (e.g. line endpoints).
     */
    public getConnectionPoints(): ConnectionPoint[] {
        const hw = this.width / 2;
        const hh = this.height / 2;

        // Local-space anchor points (relative to shape origin)
        const locals: { id: string; lx: number; ly: number }[] = [
            { id: 'top',    lx: 0,    ly: -hh },
            { id: 'right',  lx: hw,   ly: 0   },
            { id: 'bottom', lx: 0,    ly: hh  },
            { id: 'left',   lx: -hw,  ly: 0   },
            { id: 'center', lx: 0,    ly: 0   },
        ];

        const m = this.localMatrix;
        return locals.map(({ id, lx, ly }) => {
            const v = vec4.fromValues(lx, ly, 0, 1);
            const w = vec4.create();
            vec4.transformMat4(w, v, m);
            return { id, x: w[0], y: w[1] };
        });
    }

    /**
     * Find the nearest connection point to a world-space position.
     * Returns the point and the distance, or null if no connection points exist.
     */
    public getNearestConnectionPoint(worldX: number, worldY: number): { point: ConnectionPoint; distance: number } | null {
        const pts = this.getConnectionPoints();
        if (pts.length === 0) return null;
        let best: ConnectionPoint = pts[0];
        let bestDist = Infinity;
        for (const p of pts) {
            const d = Math.hypot(p.x - worldX, p.y - worldY);
            if (d < bestDist) { bestDist = d; best = p; }
        }
        return { point: best, distance: bestDist };
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