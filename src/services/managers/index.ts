/**
 * managers/index.ts — Barrel export for all domain-specific managers.
 *
 * Import pattern:
 *   import { RasterManager, TextManager, ... } from '../managers';
 */

export { ManagerContext } from './manager-context';
export { RasterManager } from './raster-manager';
export { TextManager } from './text-manager';
export { AnimationManager } from './animation-manager';
export { Scene3DManager } from './scene3d-manager';
export { DrawingToolManager } from './drawing-tool-manager';
export { PersistenceManager, PersistenceCallbacks } from './persistence-manager';
export { UndoManager3D } from './undo-manager-3d';
export type { Command3D } from './undo-manager-3d';
export { MeshPaintManager } from './mesh-paint-manager';
export { MeshEditManager } from './mesh-edit-manager';
export { KitbashLibrary } from './kitbash-library';
export { UVEditorSession, UVCanvasRenderer } from './uv-canvas-renderer';
export type { UVSelectionMode } from './uv-canvas-renderer';
export { UVEditManager } from './uv-edit-manager';
export { LiveTextureMode } from './live-texture-mode';
