// src/scene-graph/circle.ts
import { RenderStrategy } from '../../renderer/render-strategies/render-strategy';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './shape';
import { mat4, vec2, vec3 } from 'gl-matrix';

export class Circle extends Shape {
    private _radius: number;
    private _interactionService: InteractionService;

    constructor(renderStrategy: RenderStrategy, 
        radius: number, 
        fillColor: RGBA = {r: 0, g: 0, b: 0, a: 0}, 
        strokeColor: RGBA = {r: 0, g: 0, b: 0, a: 1}, 
        strokeWidth: number = 1, 
        interactionService: InteractionService) {

        super(renderStrategy, fillColor, strokeColor, strokeWidth);
        this._interactionService = interactionService;
        this._radius = radius;
        this.calculateBoundingBox();
    }

    get radius() {
        return this._radius;
    }

    set radius(radius: number) {
        this._radius = radius;
        this.triggerRerender();
    }

    containsPoint(x: number, y: number): boolean {
        /*
        const inverseWorldMatrix = mat4.create();
        mat4.invert(inverseWorldMatrix, this._interactionService.getWorldMatrix());

        const point = vec3.fromValues(x, y, 0);
        vec3.transformMat4(point, point, inverseWorldMatrix);

        const dx = point[0] - this.x;
        const dy = point[1] - this.y;
        return (dx * dx + dy * dy) <= (this.radius * this.radius);
        */
        return true;
    }

    protected calculateBoundingBox() {
        // Use the original dimensions without applying zoom/pan manually
        this._boundingBox = {
            x: this.x - this._radius,
            y: this.y - this._radius,
            width: this._radius * 2,
            height: this._radius * 2,
        };
    }
}

/* 

NOTES:
For Bounding Box Calculation:
Since the world matrix is applied to the vertex positions in the shader, 
you don't need to manually apply the zoom factor and pan offset in the calculateBoundingBox 
method. Instead, you should directly use the shape's original dimensions and positions.

For Hit Detection:
For hit detection to work correctly in the transformed space, you'll need to apply the inverse of 
the world matrix to the point coordinates before performing the hit test. This will convert the coordinates 
back to the original, untransformed space.

*/