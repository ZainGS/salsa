// src/scene-graph/shapes/base/group.ts
import { Shape } from './shape';
import { RGBA } from '../../../types/rgba';
import { InteractionService } from '../../../services/interaction-service';

export class Group extends Shape {
    public clipChildren: boolean = false;
    public drawBackground: boolean = false;
    public backgroundColor: RGBA = { r: 1, g: 1, b: 1, a: 1 };

    constructor(
        interactionService: InteractionService,
        fillColor: RGBA = { r: 0, g: 0, b: 0, a: 0 },
        strokeColor: RGBA = { r: 0, g: 0, b: 0, a: 0 },
        strokeWidth: number = 1
    ) {
        super(fillColor, strokeColor, strokeWidth, interactionService);
        this._width = 1;
        this._height = 1;
        this.updateLocalMatrix();
        this.calculateBoundingBox();
    }

    public override getType(): string {
        return "Group";
    }

    protected override getScaleFactors(): [number, number] {
        return [this._width, this._height];
    }

    public override containsPoint(x: number, y: number): boolean {
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
        return (
            x >= this.x - halfWidth &&
            x <= this.x + halfWidth &&
            y >= this.y - halfHeight &&
            y <= this.y + halfHeight
        );
    }

    public override toJSON(): any {
        return {
            ...super.toJSON(),
            type: this.getType(),
            clipChildren: this.clipChildren,
            drawBackground: this.drawBackground,
            backgroundColor: this.backgroundColor
        };
    }

    //
    public override getGeometryVertices(): Float32Array | null {
        return null;
    }

    public override getGeometryIndices(): Uint16Array | null {
        return null;
    }

    // New: Recalculate Group's size based on children
    // public recalculateSize() {
    //     if (this.children.length === 0) {
    //         this.width = 0;
    //         this.height = 0;
    //         return;
    //     }

    //     let minX = Infinity;
    //     let minY = Infinity;
    //     let maxX = -Infinity;
    //     let maxY = -Infinity;

    //     for (const child of this.children) {
    //         if (!(child instanceof Shape)) continue;

    //         const worldCorners = child.getWorldSpaceBoundingBoxPolygon(true); // [ [x,y], [x,y], ... ]

    //         for (const [x, y] of worldCorners) {
    //             minX = Math.min(minX, x);
    //             minY = Math.min(minY, y);
    //             maxX = Math.max(maxX, x);
    //             maxY = Math.max(maxY, y);
    //         }
    //     }

    //     // New width/height based on extremes
    //     const newWidth = maxX - minX;
    //     const newHeight = maxY - minY;
    //     const centerX = (minX + maxX) / 2;
    //     const centerY = (minY + maxY) / 2;

    //     // Update group position and size
    //     this.x = centerX;
    //     this.y = centerY;
    //     this.width = newWidth;
    //     this.height = newHeight;

    //     this.updateLocalMatrix();
    //     this.calculateBoundingBox();
    //     this.markDirty();
    // }


    public recalculateSize() {
        if (this.children.length === 0) {
            this.width = 0;
            this.height = 0;
            return;
        }
    
        // --- Step 1: Save old center first
        const oldCenterX = this.x;
        const oldCenterY = this.y;
    
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
    
        for (const child of this.children) {
            if (!(child instanceof Shape)) continue;
    
            const worldCorners = child.getWorldSpaceBoundingBoxPolygon(true); // fresh=true to force update
    
            for (const [x, y] of worldCorners) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
    
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const newWidth = maxX - minX;
        const newHeight = maxY - minY;
    
        // --- Step 2: Update group position and size
        this.x = centerX;
        this.y = centerY;
        this.width = newWidth;
        this.height = newHeight;
    
        // --- Step 3: Calculate delta
        const deltaX = oldCenterX - centerX;
        const deltaY = oldCenterY - centerY;
    
        // --- Step 4: Reposition children back
        for (const child of this.children) {
            child.x += deltaX;
            child.y += deltaY;
            child.updateLocalMatrix();
        }
    
        this.updateLocalMatrix();
        this.calculateBoundingBox();
        this.markDirty();
    }
}