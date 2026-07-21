/**
 * src/packaging/ — optional packaging module (feature-flagged: PACKAGING_ENABLED).
 * Public entry point. Imports Salsa core; core never imports this → removable/tree-shakeable.
 * See docs/specs/packaging-system.md.
 */

export type {
  DielineParams, DielineGuide, DielineGuideType,
  FoldPanel, FoldMeshData, DielineResult,
} from './types';
export { compileFoldMesh } from './fold-mesh';   // kept as the fold-math correctness reference (tests)
export { buildBoxNodes, setBoxFold, buildPanelLocalGeometry, computeFoldWorldCorners } from './box-hierarchy';
export type { PackagingBox, PackagingBoxPanel, BoxNodeHost, PanelBuild } from './box-hierarchy';
export { PackagingManager } from './packaging-manager';
export type { PackagingHost, PackagingState, EditorHandle, BoxStyle, CreatorModeOpts, CreatorState, DielinePaneHandle } from './packaging-manager';
export { simpleBox } from './templates/simple-box';
