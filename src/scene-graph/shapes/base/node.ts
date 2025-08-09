import { mat4 } from "gl-matrix";
import { Group } from "./group";

// src/scene-graph/node.ts
export class Node {

    public _stagingInfo: any;

    // Core
    public visible: boolean = true;
    public children: Node[] = [];
    public transformMode: "inherit" | "translate-only" = "inherit";
    
    // get parentChainMatrix(): mat4 {
    //     const result = mat4.create(); // identity
    //     let current: Node | null = this.parent;
    
    //     while (current) {
    //         if ('localMatrix' in current) {
    //             mat4.mul(result, result, (current as any).localMatrix);
    //         }
    //         current = current.parent;
    //     }
    
    //     return result;
    // }

    get parentChainMatrix(): mat4 {
        const result = mat4.create();
        let current: Node | null = this.parent;
    
        while (current) {
            const mode = (current as any).transformMode ?? "inherit";

            if (mode === "translate-only") {
                mat4.translate(result, result, [current.x, current.y, 0]);
            } else if ('localMatrix' in current) {
                mat4.mul(result, current['localMatrix'] as mat4, result);
            }
            current = null;
            // current = current.parent;
        }
    
        return result;
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

    public get rotationDegrees(): number {
        return this._rotation * (180 / Math.PI);
    }

    public set rotationDegrees(value: number) {
        this._rotation = value * (Math.PI / 180);
        this.updateLocalMatrix(); // Update localMatrix whenever rotation changes
    }
    
    // Event handlers
    public onClick?: (event: MouseEvent) => void;
    public onMouseOver?: (event: MouseEvent) => void;
    public onMouseOut?: (event: MouseEvent) => void;

    // Parent reference (optional, useful for sorting)
    public parent: Node | null = null;

    constructor() {
    }

    // Add a child node
    addChild(child: Node) {
        child.parent = this; // Set parent reference
        this.children.push(child);
        // this.sortChildrenByZIndex(); // Ensure correct order
    }

    // Remove a child node
    // removeChild(childToDelete: Node) {
    //     this.children = this.children.filter(c => c !== childToDelete);

    //     // this.children.forEach( (child, index) => {
    //     //     if(child === childToDelete) this.children.splice(index,1);
    //     //   });
    // }

    removeChild(childToDelete: Node): void {
        this.children = this.children.filter(child => child !== childToDelete);
        for (const child of this.children) {
            child.removeChild(childToDelete);
        }
    }

    // removeChild(childToDelete: Node): any | undefined {
    //     const index = this.children.indexOf(childToDelete);
    //     if (index !== -1) {
    //         this.children.splice(index, 1);
    //         return undefined;
    //     }

    //     for (const child of this.children) {
    //         const result = child.removeChild(childToDelete);
    //         if (result) return result;
    //     }

    //     return undefined;
    // }

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
            children: this.children.map(child => child.toJSON())
        };
    }
    
}