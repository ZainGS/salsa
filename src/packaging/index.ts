/**
 * src/packaging/ — optional packaging module (feature-flagged: PACKAGING_ENABLED).
 * Public entry point. Imports Salsa core; core never imports this → removable/tree-shakeable.
 * See docs/specs/packaging-system.md.
 */

export type {
  DielineParams, DielineGuide, DielineGuideType,
  FoldPanel, FoldMeshData, DielineResult,
} from './types';
export { compileFoldMesh } from './fold-mesh';
export { simpleBox } from './templates/simple-box';
