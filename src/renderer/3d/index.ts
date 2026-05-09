/**
 * Salsa 3D — PS1-style WebGPU 3D rendering module.
 *
 * Fully self-contained. Can be used standalone (3D-only apps)
 * or alongside the 2D renderer (hybrid apps like Frogmarks).
 *
 * Usage:
 *   import { Camera3D, OrbitController, Renderer3D, Mesh3D } from './renderer/3d';
 */

export { Camera3D } from './camera-3d';
export type { CameraMode, Camera3DConfig } from './camera-3d';

export { OrbitController } from './orbit-controller';
export type { OrbitControllerConfig } from './orbit-controller';

export { Renderer3D, DEFAULT_PS1_CONFIG } from './renderer-3d';
export type { Light3DConfig, PS1Config } from './renderer-3d';

export { Pipeline3D, MESH3D_VERTEX_STRIDE } from './pipeline-3d';

export { DEFAULT_MATERIAL, encodeMaterialFlags } from './material-3d';
export type { Material3D } from './material-3d';

export { generateBox, generateSphere, generatePlane, generateCylinder, generateTorus } from './mesh-generators';
export type { MeshGeometry } from './mesh-generators';

export {
  MESH3D_VERTEX_SHADER,
  MESH3D_FRAGMENT_SHADER,
  MESH3D_FRAGMENT_SHADER_UNTEXTURED,
} from './shaders/mesh3d-shaders';

export { MeshPicker } from './mesh-picker';
export type { PickResult } from './mesh-picker';

export { GizmoRenderer } from './gizmo-renderer';
export type { GizmoMode, GizmoAxis } from './gizmo-renderer';

export { GIZMO_VERTEX_SHADER, GIZMO_FRAGMENT_SHADER, GIZMO_VERTEX_STRIDE } from './shaders/gizmo-shaders';

export { AnimationPlayer3D } from './animation-player-3d';
export type { AnimationPlayer3DConfig } from './animation-player-3d';

export { FrustumCuller } from './frustum-culler';
