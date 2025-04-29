export interface RenderData {
  shapeIndex?: number;
  uniformOffset?: number;
  geometryOffset?: GeometryOffsets;
  sharedGeometryType?: string; // E.g. "circle", "rectangle"
}
  
export interface GeometryOffsets {
  vertexOffset: number;
  indexOffset: number;
  vertexCount: number;
  indexCount: number;
}