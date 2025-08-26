// src/scene-graph/shapes/base/group.ts
import { Shape } from './shape';
import { RGBA } from '../../../types/rgba';
import { InteractionService } from '../../../services/interaction-service';
import { vec4, mat4, vec3 } from 'gl-matrix';

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
        return [this.scaleX ?? 1, this.scaleY ?? 1];
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
  if (this.children.length === 0) { this.width = 0; this.height = 0; return; }

  // 1) World AABB from children
  let minX =  Infinity, minY =  Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ch of this.children) {
    if (!(ch instanceof Shape)) continue;
    for (const [x,y] of ch.getWorldSpaceBoundingBoxPolygon(true)) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  const worldCenter = vec4.fromValues((minX+maxX)/2, (minY+maxY)/2, 0, 1);

  // 2) Convert center **to parent-local** before assigning to this.x/this.y
  const parentWorld = this.parentChainMatrix;                     // parent’s world
  const parentWorldInv = mat4.invert(mat4.create(), parentWorld)!;
  const centerPL = vec4.transformMat4(vec4.create(), worldCenter, parentWorldInv);

  // Old center (parent-local) to compute how far the group will move
  const oldCenterPL = vec4.fromValues(this.x, this.y, 0, 1);
  const deltaParent = vec3.fromValues(centerPL[0]-oldCenterPL[0], centerPL[1]-oldCenterPL[1], 0);

  // 3) Update group position and size **in parent-local**
  this.x = centerPL[0];
  this.y = centerPL[1];

  // To keep width/height consistent with your semantics, compute the AABB in parent-local:
  const aabbPL = [
    vec4.transformMat4(vec4.create(), vec4.fromValues(minX, minY, 0, 1), parentWorldInv),
    vec4.transformMat4(vec4.create(), vec4.fromValues(maxX, maxY, 0, 1), parentWorldInv),
  ];
  this.width  = Math.abs(aabbPL[1][0] - aabbPL[0][0]);
  this.height = Math.abs(aabbPL[1][1] - aabbPL[0][1]);

  // 4) Keep children visually fixed: convert the **parent-local** delta to **group-local**
  // Use the group’s rotation/scale (no translation) at the time of the move.
  const rot = this.rotation, sx = this.scaleX ?? 1, sy = this.scaleY ?? 1;
  const RS = mat4.fromRotationTranslationScale(mat4.create(), [0,0,Math.sin(rot/2), Math.cos(rot/2)], [0,0,0], [sx, sy, 1]);
  const RSinv = mat4.invert(mat4.create(), RS)!;
  const dLocal4 = vec4.transformMat4(vec4.create(), vec4.fromValues(-deltaParent[0], -deltaParent[1], 0, 0), RSinv);
  const dxL = dLocal4[0], dyL = dLocal4[1];

  for (const ch of this.children) {
    (ch as Shape).x += dxL;
    (ch as Shape).y += dyL;
    (ch as Shape).updateLocalMatrix();
  }

  this.updateLocalMatrix();
  this.calculateBoundingBox();
  this.markDirty();
}

   public override calculateBoundingBox(): void {
  const sx = this.scaleX ?? 1, sy = this.scaleY ?? 1;
  const w = this.width  * sx;
  const h = this.height * sy;
  this._boundingBox = {
    x: this.x - w/2,
    y: this.y - h/2,
    width:  w,
    height: h,
  };
}
    
}