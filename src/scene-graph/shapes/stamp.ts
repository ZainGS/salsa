// src/scene-graph/shapes/stamp.ts
import { mat4, vec3, vec4 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';

export class Stamp extends Shape {
  public textureKey: string;
  public layerIndex: number = -1;
  public atlasWidth: number = 1;
  public atlasHeight: number = 1;

  constructor(
    x: number,
    y: number,
    width: number,
    height: number,
    textureKey: string,
    interactionService: InteractionService,
    fillColor: RGBA = { r: 1, g: 1, b: 1, a: 1 }
  ) {
    super(fillColor, { r: 0, g: 0, b: 0, a: 0 }, 0, interactionService);
    
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.textureKey = textureKey;
    this.calculateBoundingBox();
  }

  onAtlasReady(layerIndex: number, atlasWidth: number, atlasHeight: number) {
    this.layerIndex = layerIndex;
    this.atlasWidth = Math.max(1, atlasWidth);
    this.atlasHeight = Math.max(1, atlasHeight);
    this.markDirty();
  }

  protected getScaleFactors(): [number, number] {
    return [1, 1];
  }

  public calculateBoundingBox() {
    const halfWidth = this.width / 2;
    const halfHeight = this.height / 2;
    
    this.boundingBox.vertices = [
      [-halfWidth, -halfHeight],
      [halfWidth, -halfHeight],
      [-halfWidth, halfHeight],
      [halfWidth, halfHeight]
    ];
  }

  containsPoint(x: number, y: number): boolean {
    const inverseLocalMatrix = mat4.create();
    const success = mat4.invert(inverseLocalMatrix, this.localMatrix);
    if (!success) return false;

    const point = vec3.fromValues(x, y, 0);
    vec3.transformMat4(point, point, inverseLocalMatrix);

    const halfWidth = this.width / 2;
    const halfHeight = this.height / 2;

    return Math.abs(point[0]) <= halfWidth && Math.abs(point[1]) <= halfHeight;
  }

  getType(): string { return 'Stamp'; }

  toJSON() {
    return {
      ...super.toJSON(),
      width: this.width,
      height: this.height,
      textureKey: this.textureKey,
    };
  }

  static fromJSON(data: any, interactionService: InteractionService): Stamp {
    const stamp = new Stamp(
      data.x, data.y,
      data.width, data.height,
      data.textureKey,
      interactionService,
      data.fillColor || { r: 1, g: 1, b: 1, a: 1 }
    );
    
    if (data.rotation !== undefined) stamp.rotation = data.rotation;
    if (data.scaleX !== undefined) stamp.scaleX = data.scaleX;
    if (data.scaleY !== undefined) stamp.scaleY = data.scaleY;
    
    return stamp;
  }

  public getGeometryVertices(): Float32Array {
    const halfWidth = this.width / 2;
    const halfHeight = this.height / 2;

    return new Float32Array([
      -halfWidth, -halfHeight, 0, 1,  // Bottom-left
      halfWidth, -halfHeight, 1, 1,   // Bottom-right
      -halfWidth, halfHeight, 0, 0,   // Top-left
      
      -halfWidth, halfHeight, 0, 0,   // Top-left
      halfWidth, -halfHeight, 1, 1,   // Bottom-right
      halfWidth, halfHeight, 1, 0     // Top-right
    ]);
  }

  public getGeometryIndices(): Uint16Array {
    return new Uint16Array([0, 1, 2, 3, 4, 5]);
  }

  override getBoundingBoxVertices(thickness: number): Float32Array {
    if (!this.boundingBox.vertices || this.boundingBox.vertices.length !== 4) {
      return new Float32Array();
    }
    return new Float32Array(this.boundingBox.vertices.flat());
  }
}