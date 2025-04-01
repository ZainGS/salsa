import { RenderStrategy } from "../../../renderer/render-strategies/render-strategy";

// src/scene-graph/node.ts
export class Node {

    // Core
    public renderStrategy?: RenderStrategy;
    public visible: boolean = true;
    public children: Node[] = [];
    
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
    public _x: number = 0;
    
    public get x(): number {
        return this._x;
    }

    public set x(value: number) {
        this._x = value;
        this.updateLocalMatrix(); // Update localMatrix whenever x changes
    }

    // y position of node
    public _y: number = 0;

    public get y(): number {
        return this._y;
    }

    public set y(value: number) {
        this._y = value;
        this.updateLocalMatrix(); // Update localMatrix whenever y changes
    }

    // Transformations
    private _scaleX: number = 1;
    private _scaleY: number = 1;
    private _rotation: number = 0;

    public get scaleX(): number {
        return this._scaleX;
    }

    public set scaleX(value: number) {
        this._scaleX = value;
        this.updateLocalMatrix(); // Update localMatrix whenever scaleX changes
    }

    public get scaleY(): number {
        return this._scaleY;
    }

    public set scaleY(value: number) {
        this._scaleY = value;
        this.updateLocalMatrix(); // Update localMatrix whenever scaleY changes
    }

    public get rotation(): number {
        return this._rotation;
    }

    public set rotation(value: number) {
        this._rotation = value;
        this.updateLocalMatrix(); // Update localMatrix whenever rotation changes
    }
    
    // Event handlers
    public onClick?: (event: MouseEvent) => void;
    public onMouseOver?: (event: MouseEvent) => void;
    public onMouseOut?: (event: MouseEvent) => void;

    // Parent reference (optional, useful for sorting)
    public parent?: Node;

    constructor(renderStrategy?: RenderStrategy) {
        this.renderStrategy = renderStrategy;
    }

    // Add a child node
    addChild(child: Node) {
        child.parent = this; // Set parent reference
        this.children.push(child);
        // this.sortChildrenByZIndex(); // Ensure correct order
    }

    // Remove a child node
    removeChild(childToDelete: Node) {
        this.children = this.children.filter(c => c !== childToDelete);

        // this.children.forEach( (child, index) => {
        //     if(child === childToDelete) this.children.splice(index,1);
        //   });
    }

    // Sort children by zIndex
    sortChildrenByZIndex() {
        this.children.sort((a, b) => a.zIndex - b.zIndex);
    }

    // Delegate rendering to the strategy
    public render(ctxOrEncoder: CanvasRenderingContext2D | GPURenderPassEncoder, pipeline?: GPURenderPipeline) {
        this.renderStrategy?.render(this, ctxOrEncoder, pipeline);
    }

    // Check if a point is within this node (override in subclasses)
    public containsPoint(x: number, y: number): boolean {
        x = x;
        y = y;
        return false;
    }

    public updateLocalMatrix() {
        // To be overridden in subclasses like Shape
    }

    toJSON(): any {
        return {
            // type: "Node",  // Helps in reconstructing type during deserialization
            x: this.x,
            y: this.y,
            scaleX: this.scaleX,
            scaleY: this.scaleY,
            rotation: this.rotation,
            zIndex: this.zIndex,
            visible: this.visible,
            children: this.children.map(child => child.toJSON())
        };
    }
}