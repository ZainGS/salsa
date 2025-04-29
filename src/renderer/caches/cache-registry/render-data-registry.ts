import { RenderData, GeometryOffsets } from "./render-data";

export class RenderDataRegistry<T extends { id: string }> {
  public registryMap = new Map<string, RenderData>();

  public set(type: 'shape' | 'stroke' | 'highlight' | 'line', obj: T, data: Partial<RenderData>) {
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
    // console.log("Getting from registry. Id is: " + obj.id);
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