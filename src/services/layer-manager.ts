import { SceneGraph } from "../scene-graph/core/scene-graph";
import { Node } from "../scene-graph/shapes/base/node";
// lightweight unique id generator to avoid extra deps
function makeId() {
  return 'l_' + Math.random().toString(36).slice(2, 9);
}

export type LayerNode = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  node: Node;
};

export class LayerManager {
  private sceneGraph: SceneGraph;
  private selectedLayerId: string | null = null;

  constructor(sceneGraph: SceneGraph) {
    this.sceneGraph = sceneGraph;
  }

  // Return top-level child nodes as layers
  public getLayers(): LayerNode[] {
    const layers: LayerNode[] = [];
    const children = this.sceneGraph.root.children ?? [];
    for (const child of children) {
  const id = (child as any).id ?? makeId();
      const name = (child as any).name ?? 'Layer';
      const visible = (child as any).visible !== false;
      const locked = !!(child as any).locked;
      layers.push({ id, name, visible, locked, node: child });
    }
    return layers;
  }

  // Add a new empty layer (as a Node)
  public addLayer(name = 'Layer'): LayerNode {
  const node = new Node();
  (node as any).id = makeId();
    (node as any).name = name;
    (node as any).visible = true;
    (node as any).locked = false;
    this.sceneGraph.root.addChild(node);
    return { id: (node as any).id, name, visible: true, locked: false, node };
  }

  // Delete a layer by id
  public deleteLayer(id: string): boolean {
    const idx = this.sceneGraph.root.children.findIndex(c => (c as any).id === id);
    if (idx < 0) return false;
    this.sceneGraph.root.children.splice(idx, 1);
    if (this.selectedLayerId === id) this.selectedLayerId = null;
    return true;
  }

  public selectLayer(id: string | null) {
    this.selectedLayerId = id;
  }

  public getSelectedLayerId(): string | null { return this.selectedLayerId; }
}
