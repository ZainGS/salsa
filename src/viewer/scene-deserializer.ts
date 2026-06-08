/**
 * ViewerSceneDeserializer — standalone recreateNode() for the Salsa Viewer.
 *
 * Handles only the node types needed for playback (3D meshes, particles).
 * Has zero dependency on ShapeManager, ShapeFactory, or any drawing service.
 */

import { Node } from '../scene-graph/shapes/base/node';
import { Shape } from '../scene-graph/shapes/base/shape';
import { Mesh3D, Mesh3DConfig } from '../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { ParticleEmitter3D } from '../scene-graph/shapes/particle-emitter-3d';
import { EventEmitter } from '../renderer/util/event-emitter';
import type { InteractionService } from '../services/interaction-service';

function createStubInteractionService(): InteractionService {
  const noop = () => {};
  return {
    maxGlobalZIndex: 1,
    canvas: null as any,
    depthTexture: null as any,
    depthTextureView: null as any,
    viewportBounds: null as any,
    selectedNodes: new Set(),
    boxSelectPreview: null,
    onSelectionChanged: new EventEmitter<string[]>(),
    onSceneGraphChanged: new EventEmitter<void>(),
    onRequestRender: new EventEmitter<void>(),
    onBeginInteractive: new EventEmitter<void>(),
    onEndInteractive: new EventEmitter<void>(),
    onRequestBackgroundRender: new EventEmitter<void>(),
    onViewportChanged: new EventEmitter<void>(),
    requestRender: noop,
    beginInteractive: noop,
    endInteractive: noop,
    requestBackgroundRender: noop,
    isPanToolSelected: false,
    lastPointerUV: [0.5, 0.5] as [number, number],
    pointerDown: false,
    getAspectRatio: () => 1,
    getViewportCenter: () => [0, 0],
    setDepthTextureView: noop,
    // Zoom/pan stubs
    get zoom() { return 1; },
    set zoom(_v) {},
    get pan() { return { x: 0, y: 0 }; },
    get panOffset() { return { x: 0, y: 0 }; },
    worldToCanvas: (p: any) => p,
    canvasToWorld: (p: any) => p,
    resetView: noop,
    updateWorldMatrix: noop,
    getWorldMatrix: () => new Float32Array(16),
    worldToClip: (p: any) => p,
  } as unknown as InteractionService;
}

export class ViewerSceneDeserializer {
  private readonly _stub = createStubInteractionService();

  buildSceneGraph(root: Node, sourceData: any): void {
    if (!root || !sourceData) return;
    root.children = [];
    for (const childData of (sourceData.children ?? [])) {
      root.addChild(this.recreateNode(childData));
    }
  }

  recreateNode(data: any): Node {
    let node: Node;

    switch (data.type) {
      case '3DMesh': {
        const meshConfig: Mesh3DConfig = {
          primitive: data.primitive ?? 'box',
          ...(data.config ?? {}),
          material: data.material,
        };
        if (meshConfig.primitive === 'custom' && data.config?.geometry) {
          const g = data.config.geometry;
          if (Array.isArray(g.vertices) && Array.isArray(g.indices)) {
            meshConfig.geometry = {
              vertices: new Float32Array(g.vertices),
              indices:  new Uint32Array(g.indices),
            };
          } else {
            meshConfig.primitive = 'box';
            delete meshConfig.geometry;
          }
        }
        const mesh = new Mesh3D(this._stub, data.x ?? 0, data.y ?? 0, data.z ?? 0, meshConfig);
        if (data.rotationX  != null) mesh.rotationX  = data.rotationX;
        if (data.rotationY  != null) mesh.rotationY  = data.rotationY;
        if (data.scaleZ     != null) mesh.scaleZ     = data.scaleZ;
        if (data.keyframeTracks)     mesh.keyframeTracks   = data.keyframeTracks;
        if (data.textureLibraryId)   mesh.textureLibraryId = data.textureLibraryId;
        node = mesh;
        break;
      }
      case '3DMeshGroup': {
        const group = new MeshGroup3D(this._stub);
        group.collapsed = data.collapsed ?? false;
        for (const childData of (data.children ?? [])) {
          group.addChild(this.recreateNode(childData));
        }
        node = group;
        break;
      }
      case 'ParticleEmitter3D': {
        node = new ParticleEmitter3D(
          this._stub,
          data.x ?? 0, data.y ?? 0, data.z ?? 0,
          data.config ?? {},
        );
        break;
      }
      default:
        console.warn(`[SceneDeserializer] Unknown node type "${data.type}" — creating empty placeholder. Upgrade Salsa to load this project correctly.`);
        node = new Node();
        break;
    }

    if (node instanceof Shape && data.id) {
      node.setId(data.id);
    }

    node.name     = data.name;
    node.x        = data.x       ?? 0;
    node.y        = data.y       ?? 0;
    node.scaleX   = data.scaleX  ?? 1;
    node.scaleY   = data.scaleY  ?? 1;
    node.rotation = data.rotation ?? 0;
    node.zIndex   = data.zIndex  ?? 0;
    node.visible  = data.visible  ?? true;
    node.locked   = data.locked   ?? false;

    return node;
  }
}
