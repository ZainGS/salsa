import { RenderData, GeometryOffsets } from "./render-data";

export class RenderDataRegistry<T extends { id: string }> {
  public registryMap = new Map<string, RenderData>();
  
  public set(type: 'shape' | 'stroke' | 'highlight' | 'line' | 'sdfText', obj: T, data: Partial<RenderData>) {
    const existing = this.registryMap.get(obj.id) ?? {};
    const merged: RenderData = {
      shapeIndex: data.shapeIndex ?? existing.shapeIndex,
      uniformOffset: data.uniformOffset ?? existing.uniformOffset,
      geometryOffset: {
        ...(existing.geometryOffset ?? {}),
        ...(data.geometryOffset ?? {}),
      } as GeometryOffsets,
    };
    this.registryMap.set(obj.id, merged);
  }

  public get(obj: T): RenderData | undefined {
    return this.registryMap.get(obj.id);
  }

  public delete(obj: T): void {
    this.registryMap.delete(obj.id);
  }

  public clear(): void {
    this.registryMap.clear();
  }

  public entries(): IterableIterator<[string, RenderData]> {
    return this.registryMap.entries();
  }
}