export interface RenderData {
  uniformOffset?: number;
  geometryOffset?: GeometryOffsets;

  // future caches
  // textureOffset?: number;
  // localMatrixOffset?: number;

  bufferType?: 'uniform' | 'geometry' | 'stroke' | 'boundingBox';
}
  
export interface GeometryOffsets {
  vertexOffset: number;
  indexOffset: number;
  vertexCount: number;
  indexCount: number;
}