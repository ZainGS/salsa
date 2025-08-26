import { mat4, vec3, vec4 } from 'gl-matrix';
import { InteractionService } from '../../services/interaction-service';
import { RGBA } from '../../types/rgba';
import { Shape } from './base/shape';

export class Pattern extends Shape {
  // Store endpoints relative to shape center
  protected _relativeX1: number;
  protected _relativeY1: number;
  protected _relativeX2: number;
  protected _relativeY2: number;

  // NEW: stable id for the bitmap in the atlas (was _patternUrl/texture)
  public textureKey: string;

  // NEW: set when the atlas finishes loading this key
  public layerIndex: number = -1;

  // NEW: width (in pixels) of each 2D-array layer in the atlas.
  // For texture_2d_array all layers share the same W x H. Default 1 = safe placeholder.
  public atlasWidth: number = 1;

  interactionService!: InteractionService;

  constructor(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  strokeColor: RGBA = { r: 1, g: 1, b: 1, a: 1 },
  strokeWidth: number = 1,
  interactionService: InteractionService,
  textureKey: string
) {
  super({ r: 1, g: 1, b: 1, a: 1 }, strokeColor, strokeWidth, interactionService);
  
  // Use provided center or calculate from endpoints
  const finalCenterX = x1;
  const finalCenterY = y1;
  
  // Store endpoints relative to the final center
  this._relativeX1 = x1 - finalCenterX;
  this._relativeY1 = y1 - finalCenterY;
  this._relativeX2 = x2 - finalCenterX;
  this._relativeY2 = y2 - finalCenterY;
  
  // Set shape position to the final center
  this.x = finalCenterX;
  this.y = finalCenterY;
  this.textureKey = textureKey;

  this._interactionService = interactionService;
  this.calculateBoundingBox();
}

  // NEW: called by the atlas once it has this.textureKey
  // Use this instead of storing a GPUTexture on the node.
  onAtlasReady(layerIndex: number, atlasWidth: number) {
    this.layerIndex = layerIndex;
    this.atlasWidth = Math.max(1, atlasWidth);
    this.markDirty();
  }

  protected getScaleFactors(): [number, number] {
    return [1, 1];
  }

  // Getters return world coordinates (relative + center position)
  get x1() { return this.x + this._relativeX1; }
  get y1() { return this.y + this._relativeY1; }
  get x2() { return this.x + this._relativeX2; }
  get y2() { return this.y + this._relativeY2; }

  // Getters for relative coordinates (useful for calculations)
  get relativeX1() { return this._relativeX1; }
  get relativeY1() { return this._relativeY1; }
  get relativeX2() { return this._relativeX2; }
  get relativeY2() { return this._relativeY2; }

  containsPoint(x: number, y: number): boolean {
    const inverseLocalMatrix = mat4.create();
    const success = mat4.invert(inverseLocalMatrix, this.localMatrix);
    if (!success) return false;

    const point = vec3.fromValues(x, y, 0);
    vec3.transformMat4(point, point, inverseLocalMatrix);

    // Use relative coordinates for local space calculations
    const start = vec3.fromValues(this._relativeX1, this._relativeY1, 0);
    const end = vec3.fromValues(this._relativeX2, this._relativeY2, 0);

    const x1 = start[0], y1 = start[1];
    const x2 = end[0], y2 = end[1];

    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(point[0] - x1, point[1] - y1) <= (this._strokeWidth / 2);

    let t = ((point[0] - x1) * dx + (point[1] - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    const dist = Math.hypot(point[0] - cx, point[1] - cy);
    return dist <= (this._strokeWidth / 2) * 0.010;
  }

  public calculateBoundingBox() {
    const halfThickness = this.strokeWidth * 0.015;

    // Use relative coordinates for bounding box calculation
    let startX = this._relativeX1;
    let startY = this._relativeY1;
    let endX = this._relativeX2;
    let endY = this._relativeY2;

    const shapeLength = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
    if (shapeLength === 0) return;

    const dirX = (endX - startX) / shapeLength;
    const dirY = (endY - startY) / shapeLength;

    const normalX = -dirY * halfThickness;
    const normalY =  dirX * halfThickness;

    const lengthExpandFactor = 0.1;
    const thicknessExpandFactor = 1.1;

    const exNrmX = normalX * thicknessExpandFactor;
    const exNrmY = normalY * thicknessExpandFactor;

    startX -= dirX * halfThickness * lengthExpandFactor;
    startY -= dirY * halfThickness * lengthExpandFactor;
    endX   += dirX * halfThickness * lengthExpandFactor;
    endY   += dirY * halfThickness * lengthExpandFactor;

    this.boundingBox.vertices = [
      [startX - exNrmX, startY - exNrmY],
      [endX   - exNrmX, endY   - exNrmY],
      [startX + exNrmX, startY + exNrmY],
      [endX   + exNrmX, endY   + exNrmY],

      [this._relativeX1 - normalX, this._relativeY1 - normalY],
      [this._relativeX2 - normalX, this._relativeY2 - normalY],
      [this._relativeX1 + normalX, this._relativeY1 + normalY],
      [this._relativeX2 + normalX, this._relativeY2 + normalY],
    ];
  }

  public updateEndPoint(x2: number, y2: number) {
    // Convert world coordinates to relative coordinates
    this._relativeX2 = x2 - this.x;
    this._relativeY2 = y2 - this.y;
    this.calculateBoundingBox();
    this.markDirty();
  }

  // NEW: Method to update both endpoints (useful for complete repositioning)
  public updateEndpoints(x1: number, y1: number, x2: number, y2: number) {
    this._relativeX1 = x1 - this.x;
    this._relativeY1 = y1 - this.y;
    this._relativeX2 = x2 - this.x;
    this._relativeY2 = y2 - this.y;
    this.calculateBoundingBox();
    this.markDirty();
  }

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

  getType(): string { return 'Pattern'; }

toJSON() {
  return {
    ...super.toJSON(),
    x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2,
    textureKey: this.textureKey,
  };
}

  // Static method to create from JSON (handles both old and new formats)
  // Static method to create from JSON (handles both old and new formats)
// Fixed fromJSON - preserve the saved center, don't recalculate
static fromJSON(data: any, interactionService: InteractionService): Pattern {
  // Create pattern normally (constructor will calculate center from endpoints)
  const pattern = new Pattern(
    data.x1, data.y1, data.x2, data.y2,
    data.strokeColor || { r: 1, g: 1, b: 1, a: 1 },
    data.strokeWidth || 1,
    interactionService,
    data.textureKey || data.pattern
  );
  
  // CRITICAL: Restore the saved center position (don't use calculated center)
  if (data.x !== undefined && data.y !== undefined) {
    // Override with the actual saved center
    pattern.x = data.x;
    pattern.y = data.y;
    
    // Recalculate relative coordinates based on the preserved center
    pattern._relativeX1 = data.x1 - data.x;
    pattern._relativeY1 = data.y1 - data.y;
    pattern._relativeX2 = data.x2 - data.x;
    pattern._relativeY2 = data.y2 - data.y;
    
    pattern.calculateBoundingBox();
  }
  
  // Apply other transform properties
  if (data.rotation !== undefined) pattern.rotation = data.rotation;
  if (data.scaleX !== undefined) pattern.scaleX = data.scaleX;
  if (data.scaleY !== undefined) pattern.scaleY = data.scaleY;
  
  return pattern;
}

  // NOTE: with instanced drawing you won't use per-node geometry here.
  // Leaving this for now (selection helpers etc.). UVs still encode tiling.
  public getGeometryVertices(): Float32Array {
    // Use relative coordinates for geometry generation
    const shapeLength = Math.sqrt((this._relativeX2 - this._relativeX1) ** 2 + (this._relativeY2 - this._relativeY1) ** 2);
    const halfThickness = this.strokeWidth * 0.015;

    const startX = this._relativeX1, startY = this._relativeY1;
    const endX = this._relativeX2,   endY = this._relativeY2;

    const dirX = (endX - startX) / Math.max(1e-6, shapeLength);
    const dirY = (endY - startY) / Math.max(1e-6, shapeLength);

    const normalX = -dirY * halfThickness;
    const normalY =  dirX * halfThickness;

    // UPDATED: use atlasWidth (shared layer width) instead of per-texture width
    const patternWidth = this.atlasWidth; // 1 until onAtlasReady() runs
    const uScale = 1600 * shapeLength / Math.max(1, patternWidth);
    const vScale = 2;

    const verts = new Float32Array([
      startX - normalX, startY - normalY, 0,      0,
      endX   - normalX, endY   - normalY, uScale, 0,
      startX + normalX, startY + normalY, 0,      vScale,

      startX + normalX, startY + normalY, 0,      vScale,
      endX   - normalX, endY   - normalY, uScale, 0,
      endX   + normalX, endY   + normalY, uScale, vScale,
    ]);

    this.cachedVertices = verts;
    return verts;
  }

  public getGeometryIndices(): Uint16Array {
    return new Uint16Array(); // unchanged
  }

  override getBoundingBoxVertices(thickness: number): Float32Array {
    if (!this.boundingBox.vertices || this.boundingBox.vertices.length !== 8) {
      return new Float32Array();
    }
    return new Float32Array(this.boundingBox.vertices.flat());
  }
}