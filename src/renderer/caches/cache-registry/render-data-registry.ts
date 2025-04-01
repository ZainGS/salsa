import { RenderData } from "./render-data";

export class RenderDataRegistry<T extends { id: string }> {
  private registryMap = new Map<string, RenderData>();

  public set(obj: T, data: Partial<RenderData>) {
    const existing = this.registryMap.get(obj.id) || {};
    this.registryMap.set(obj.id, { ...existing, ...data });
  }

  public get(obj: T): RenderData | undefined {
    return this.registryMap.get(obj.id);
  }

  public has(obj: T): boolean {
    return this.registryMap.has(obj.id);
  }

  public delete(obj: T) {
    this.registryMap.delete(obj.id);
  }

  public clear() {
    this.registryMap.clear();
  }

  public entries(): IterableIterator<[string, RenderData]> {
    return this.registryMap.entries();
  }
}