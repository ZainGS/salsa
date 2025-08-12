import { pointInPolygon, polygonsIntersect } from "../renderer/util/geometry";
import { Group } from "../scene-graph/shapes/base/group";
import { Node } from "../scene-graph/shapes/base/node";
import { Shape } from "../scene-graph/shapes/base/shape";

export class SelectionService {
  constructor(private readonly root: Node) {}

  findFirstNodeUnderMouse(x: number, y: number, node: Node = this.root): Node | null {
    const children = [...node.children].sort((a, b) => b.zIndex - a.zIndex);
    for (const child of children) {
      if (!child.visible) continue;
      const deep = this.findFirstNodeUnderMouse(x, y, child);
      if (deep) return deep;
      if (child.containsPoint(x, y)) return child;
    }
    return null;
  }

  /* When doing box selection or anything that needs to find all selectable shapes (even deep inside groups), 
  you can't just check top-level shapes — you need all shapes, recursively inside groups. */
  findAllShapesDeep(node: Node = this.root): Shape[] {
    const out: Shape[] = [];
    node.forEachDeep(n => { if (n instanceof Shape) out.push(n); });
    return out;
  }

  boxSelect(worldRectPoly: [number, number][]): (Shape | Group)[] {
    const all = this.findAllShapesDeep(this.root);
    const hits = all.filter(n => polygonsIntersect(n.getWorldSpaceBoundingBoxPolygon(), worldRectPoly));
    // return only top-level among matches
    return hits.filter(n => {
      let p = n.parent;
      while (p) { if (p instanceof Group && hits.includes(p as any)) return false; p = p.parent; }
      return true;
    });
  }

  sectionsContainingCenter(shape: Shape): Group[] {
    const center: [number, number] = [shape.x, shape.y];
    return this.root.children.filter(
      n => n instanceof Shape && (n as any).getType?.() === "Section" && n !== shape
    ).filter(sec => pointInPolygon(center, (sec as any as Shape).getWorldSpaceBoundingBoxPolygon())) as Group[];
  }
}