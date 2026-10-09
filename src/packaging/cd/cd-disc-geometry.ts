/**
 * src/packaging/cd/cd-disc-geometry.ts
 *
 * The CD Kit's disc mesh. The geometry lives in the neutral CD-disc module (renderer/3d/cd-disc), shared with the
 * Shell's FrogCart discs so one image maps onto both the same way; this file keeps the packaging import path.
 */

export { generateCDDisc, CD_DISC, CD_DISC_SAFE_R, CD_DISC_HOLE_RATIO, CD_DISC_ART_INNER_RATIO } from '../../renderer/3d/cd-disc/cd-disc-geometry';
