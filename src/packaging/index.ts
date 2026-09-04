/**
 * src/packaging/ — optional packaging module (feature-flagged: PACKAGING_ENABLED).
 * Public entry point. Imports Salsa core; core never imports this → removable/tree-shakeable.
 * See docs/specs/packaging-system.md.
 */

export type {
  DielineParams, DielineGuide, DielineGuideType,
  FoldPanel, FoldMeshData, FoldTranslateSeg, DielineResult,
} from './types';
export { compileFoldMesh } from './fold-mesh';   // kept as the fold-math correctness reference (tests)
export { buildBoxNodes, setBoxFold, buildPanelLocalGeometry, computeFoldWorldCorners, windowedProgress, foldTranslateOffset } from './box-hierarchy';
export type { PackagingBox, PackagingBoxPanel, BoxNodeHost, PanelBuild } from './box-hierarchy';
export { PackagingManager, easeInOutCubic, STUDIO_STAGE_BG } from './packaging-manager';
export type {
  PackagingHost, PackagingState, EditorHandle, BoxStyle, CreatorModeOpts, CreatorState,
  DielinePaneHandle, DielinePanePanel,
  StageBackgroundOpts, StageShadowPlacement, BoardPresetId, PanelBoardMaterial,
} from './packaging-manager';
export { simpleBox } from './templates/simple-box';
export { tuckEnd } from './templates/tuck-end';
export { sleeve } from './templates/sleeve';
export { rollEndMailer } from './templates/roll-end-mailer';
export { rigidTwoPiece, TELESCOPE_SEQUENCE, TWO_PIECE_GUTTER } from './templates/rigid-two-piece';
export { cdTrayCard, CD_TRAY_CARD } from './templates/cd-tray-card';
export { cdFrontInsert, CD_FRONT_INSERT } from './templates/cd-front-insert';
export { cdBooklet, CD_BOOKLET } from './templates/cd-booklet';
export { addTuckFlap, addGlueTab, addRollWall, addPanel, buildNetGuides, bleedGuide, foldUpAngle, TUCK_SEQUENCE, ROLL_SEQUENCE } from './mechanisms';
export type { NetBuild, TuckFlapSpec, GlueTabSpec, RollWallSpec, MechanismEdge } from './mechanisms';
