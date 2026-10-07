/**
 * The VECTOR (2D) part of the scene graph, for a host that stores the 3D scene separately — Frogmarks' cloud save
 * keeps every 3D mesh in its own blob, so the scene graph it sends the server holds only the 2D content
 * (`sm.getSceneGraphJSON2D()`; docs/ui/document-persistence.md "Cloud"). Restoring 3D nodes from a scene graph on top
 * of the mesh-blob restore would duplicate them (groups, emitters) or leave placeholders (skinned meshes).
 *
 * A top-level node is 3D when it is a Skeleton3D or its type contains "3D" (3DMesh and its skinned / cloth subclasses,
 * 3DMeshGroup — including procedural / decal / packaging markers —, 3DArrayGroup, ParticleEmitter3D, GpObject3D).
 * Everything else (shapes, paths, text, live text, groups, panels, …) is kept. The JSON has the shape
 * `setSceneGraphJSON` reads: `{ root: <Node.toJSON() of the root with the 2D children only> }`.
 */
import { Node } from '../../scene-graph/shapes/base/node';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';

/** True for a scene-graph node that belongs to the 3D scene. */
export function isSceneNode3D(node: unknown): boolean {
  if (node instanceof Skeleton3D) return true;
  const type = (node as { getType?: () => unknown })?.getType?.();
  return typeof type === 'string' && type.includes('3D');
}

/** `{ root }` of the scene graph with only the root's 2D children (the live graph is not touched). */
export function vectorSceneObject(root: Node): { root: unknown } {
  const kept = root.children.filter((c) => !isSceneNode3D(c));
  // The root's own fields through the root's own toJSON (Node.toJSON), called on a PLAIN stand-in that holds the root's
  // values and only the kept children (Node's fields are accessors with side effects, so the stand-in is not a Node).
  const standIn = {
    name: root.name, x: root.x, y: root.y, scaleX: root.scaleX, scaleY: root.scaleY, rotation: root.rotation,
    zIndex: root.zIndex, visible: root.visible, locked: root.locked, layerId: root.layerId, children: kept,
  };
  return { root: root.toJSON.call(standIn) };
}
