/**
 * ManagerContext — Shared dependency bag for all domain-specific managers.
 *
 * Instead of each manager importing ShapeManager (circular dependency),
 * they receive this context object which provides access to shared
 * infrastructure: the scene graph, renderer, interaction service, etc.
 *
 * ShapeManager constructs this once and passes it to each delegate.
 */

import { SceneGraph } from '../../scene-graph/core/scene-graph';
import { ShapeFactory } from '../../scene-graph/core/shape-factory';
import { InteractionService } from '../interaction-service';
import { WebGPURenderer } from '../../renderer/core/webgpu-renderer';
import { LayerManager } from '../layer-manager';
import { RasterLayerManager } from '../raster-layer-manager';
import { SelectionService } from '../selection-service';
import { CacheService } from '../cache-service';
export interface ManagerContext {
  readonly sceneGraph: SceneGraph;
  readonly shapeFactory: ShapeFactory;
  readonly interactionService: InteractionService;
  readonly webgpuRenderer: WebGPURenderer;
  readonly layerManager: LayerManager;

  // Optional — may not be available in all configurations
  rasterLayerManager?: RasterLayerManager;
  cacheService?: CacheService;

  // Render scheduling helpers
  scheduleRender(): void;
  beginInteractive(): void;
  endInteractive(): void;

  // Scene graph change notification
  emitSceneGraphChanged(): void;

  // Monotonic counter bumped on every scene-graph structural change (any emitSceneGraphChanged).
  // Lets hot read paths (e.g. per-pointer-move picks) cache their mesh list instead of re-walking
  // the whole tree + allocating a fresh array every call. Never changes on transforms or mouse-move.
  sceneStructureVersion(): number;

  // Selection helpers (delegates back to ShapeManager's core)
  setSelectedNode(nodeId: string): void;
}
