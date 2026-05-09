import { mat4 } from "gl-matrix";

// src/scene-graph/node.ts
export class Node {

    public _stagingInfo: any;

    // Core
    public visible: boolean = true;
    public locked: boolean = false;
    /**
     * When true, this node (and its children) will be rendered BEFORE
     * raster layers instead of on top. Used for panel layouts so
     * that illustrations can be drawn on top of the panel structure.
     */
    public renderBelowRaster: boolean = false;
    public children: Node[] = [];
    public transformMode: "inherit" | "translate-only" = "inherit";
    
    // Cache the parent chain matrix to avoid recomputation
    private _parentChainMatrix: mat4 | null = null;
    private _parentChainMatrixDirty: boolean = true;

    get parentChainMatrix(): mat4 {
        if (this._parentChainMatrixDirty || !this._parentChainMatrix) {
            this._parentChainMatrix = this.computeParentChainMatrix();
            this._parentChainMatrixDirty = false;
        }
        return this._parentChainMatrix;
    }

    private computeParentChainMatrix(): mat4 {
        const result = mat4.create();     // identity
        const stack: Node[] = [];
        let current: Node | null = this.parent;

        // Collect ancestors from root → direct parent
        while (current) {
            stack.push(current);
            current = current.parent;
        }
        stack.reverse();

        for (const n of stack) {
            const mode = (n as any).transformMode ?? "inherit";
            if (mode === "translate-only") {
                // translate-only fallback for non-shape containers
                mat4.translate(result, result, [(n as any).x ?? 0, (n as any).y ?? 0, 0]);
            } else if ('_localMatrix' in (n as any)) {
                // ⬅️ IMPORTANT: use RAW _localMatrix, NOT localMatrix getter
                mat4.mul(result, result, (n as any)._localMatrix as mat4);
            }
            // else: no transform
        }

        return result;
    }

    // Method to update the parent chain matrix when transforms change
    public updateParentChainMatrix(): void {
        this._parentChainMatrixDirty = true;
        
        // Also mark all children as dirty since their parent chain changed
        for (const child of this.children) {
            child.updateParentChainMatrix();
        }
    }

    // Method to mark only this node's parent chain as dirty (non-recursive)
    public markParentChainDirty(): void {
        this._parentChainMatrix = null;
        this._parentChainMatrixDirty = true;
    }

    // Gives every Node and Group a clean method to walk itself and all its children
    forEachDeep(callback: (node: Node) => void) {
        callback(this);
        for (const child of this.children) {
            child.forEachDeep(callback);
        }
    }
    
    // Z-Index Property for Manual Sorting
    private _zIndex: number = 0;
    public get zIndex(): number {
        return this._zIndex;
    }
    public set zIndex(value: number) {
        this._zIndex = value;
        this.parent?.sortChildrenByZIndex(); // Ensure parent updates sort order
    }

    protected _isDirty: boolean = true;
    public get isDirty(): boolean {
        return this._isDirty;
    }

    public set isDirty(value: boolean) {
        this._isDirty = value;
        this.updateLocalMatrix(); // Update localMatrix whenever x changes
    }

    // x position of node
    public _name: string = "";
    
    public get name(): string {
        return this._name;
    }

    public set name(value: string) {
        this._name = value;
    }

    // x position of node
    public _x: number = 0;
    
    public get x(): number {
        return this._x;
    }

    public set x(value: number) {
        this._x = value;
        this.updateLocalMatrix(); // Update localMatrix whenever x changes
        this.markChildrenParentChainDirty(); // Children's parent chain changed
    }

    // y position of node
    public _y: number = 0;

    public get y(): number {
        return this._y;
    }

    public set y(value: number) {
        this._y = value;
        this.updateLocalMatrix(); // Update localMatrix whenever y changes
        this.markChildrenParentChainDirty(); // Children's parent chain changed
    }

    // z position of node (3D depth — defaults to 0 for 2D compatibility)
    public _z: number = 0;

    public get z(): number {
        return this._z;
    }

    public set z(value: number) {
        this._z = value;
        this.updateLocalMatrix();
        this.markChildrenParentChainDirty();
    }

    // Transformations
    private _scaleX: number = 1;
    private _scaleY: number = 1;
    private _scaleZ: number = 1;
    private _rotation: number = 0;    // Z-axis rotation (existing 2D rotation)
    private _rotationX: number = 0;   // X-axis rotation (3D pitch)
    private _rotationY: number = 0;   // Y-axis rotation (3D yaw)

    public get scaleX(): number {
        return this._scaleX;
    }

    public set scaleX(value: number) {
        this._scaleX = value;
        this.updateLocalMatrix(); // Update localMatrix whenever scaleX changes
        this.markChildrenParentChainDirty(); // Children's parent chain changed
    }

    public get scaleY(): number {
        return this._scaleY;
    }

    public set scaleY(value: number) {
        this._scaleY = value;
        this.updateLocalMatrix(); // Update localMatrix whenever scaleY changes
        this.markChildrenParentChainDirty(); // Children's parent chain changed
    }

    public get rotation(): number {
        return this._rotation;
    }

    public set rotation(value: number) {
        this._rotation = value;
        this.updateLocalMatrix(); // Update localMatrix whenever rotation changes
        this.markChildrenParentChainDirty(); // Children's parent chain changed
    }

    public get rotationDegrees(): number {
        return this._rotation * (180 / Math.PI);
    }

    public set rotationDegrees(value: number) {
        this._rotation = value * (Math.PI / 180);
        this.updateLocalMatrix(); // Update localMatrix whenever rotation changes
        this.markChildrenParentChainDirty(); // Children's parent chain changed
    }

    // 3D rotation: pitch (X-axis)
    public get rotationX(): number { return this._rotationX; }
    public set rotationX(value: number) {
        this._rotationX = value;
        this.updateLocalMatrix();
        this.markChildrenParentChainDirty();
    }

    // 3D rotation: yaw (Y-axis)
    public get rotationY(): number { return this._rotationY; }
    public set rotationY(value: number) {
        this._rotationY = value;
        this.updateLocalMatrix();
        this.markChildrenParentChainDirty();
    }

    // 3D scale: Z-axis
    public get scaleZ(): number { return this._scaleZ; }
    public set scaleZ(value: number) {
        this._scaleZ = value;
        this.updateLocalMatrix();
        this.markChildrenParentChainDirty();
    }

    // Helper method to mark all children's parent chain as dirty
    private markChildrenParentChainDirty(): void {
        for (const child of this.children) {
            child.markParentChainDirty();
            // Recursively mark grandchildren too
            child.markChildrenParentChainDirty();
        }
    }
    
    // Event handlers
    public onClick?: (event: MouseEvent) => void;
    public onMouseOver?: (event: MouseEvent) => void;
    public onMouseOut?: (event: MouseEvent) => void;

    // Parent reference (optional, useful for sorting)
    public parent: Node | null = null;

    /**
     * Check whether this node should render below raster layers.
     * Walks up the parent chain so children of a PanelLayout
     * (which sets renderBelowRaster = true) automatically inherit it.
     */
    public isRenderBelowRaster(): boolean {
        let n: Node | null = this;
        while (n) {
            if (n.renderBelowRaster) return true;
            n = n.parent;
        }
        return false;
    }

    /**
     * Returns true only if this node AND every ancestor in the hierarchy is visible.
     * Use this instead of checking `visible` alone to respect group visibility.
     */
    public isEffectivelyVisible(): boolean {
        let n: Node | null = this;
        while (n) {
            if (!n.visible) return false;
            n = n.parent;
        }
        return true;
    }

    constructor() {
    }

    // Add a child node
    addChild(child: Node) {
        child.parent = this; // Set parent reference
        this.children.push(child);
        child.updateParentChainMatrix(); // Update child's parent chain
        // this.sortChildrenByZIndex(); // Ensure correct order
    }

    // Remove a child node
    removeChild(childToDelete: Node): void {
        this.children = this.children.filter(child => child !== childToDelete);
        childToDelete.parent = null;
        childToDelete.updateParentChainMatrix(); // Update removed child's parent chain
        
        for (const child of this.children) {
            child.removeChild(childToDelete);
        }
    }

    // Sort children by zIndex
    sortChildrenByZIndex() {
        this.children.sort((a, b) => a.zIndex - b.zIndex);
    }

    // Check if a point is within this node (override in subclasses)
    public containsPoint(x: number, y: number): boolean {
        x = x;
        y = y;
        return false;
    }

    public updateLocalMatrix() {
        // To be overridden in subclasses like Shape
        // When local matrix changes, children's parent chain matrices are affected
        this.markChildrenParentChainDirty();
    }

    toJSON(): any {
        return {
            // type: "Node",  // Helps in reconstructing type during deserialization
            name: this.name,
            x: this.x,
            y: this.y,
            scaleX: this.scaleX,
            scaleY: this.scaleY,
            rotation: this.rotation,
            zIndex: this.zIndex,
            visible: this.visible,
            locked: this.locked,
            children: this.children.map(child => child.toJSON())
        };
    }
}