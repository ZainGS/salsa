// ── World generation module (src/world) — public surface ────────────────────────────────────────
// The GENERATION half of the procedural world (docs/specs/world-generation.md). Pure + deterministic:
// (params → WorldGraph → flat preview geometry). Salsa core never imports this; the bridge to the scene is
// `src/services/managers/world-manager.ts` (exposed as `sm.world`). The runtime SIM half is `src/game/` (later).

export * from './types';
export { generateCityLayout, regionAt } from './layout';
export { buildLayoutPreview, polysToGeometry, ZONE_COLOR } from './preview';
export { buildBiome } from './biome';
export { buildStreets } from './streets';
export { buildRoadPaint } from './roadpaint';
export { buildVoidGrid, buildBorderGlow } from './voidgrid';
export { buildApron } from './apron';
export { tileSeed, offsetGraphGeometry, tileParams, tiledWorldExtent } from './tiled';
export { buildTrafficLights, computeSignalTextSigns } from './signals';
export { buildRoadSigns, warningGarpPool, warningCanonicalGeometry, warningSkinKey, WARNING_SKINS } from './road-sign';
export { buildSignage } from './signage';
export { buildAwnings } from './awnings';
export { buildFurniture } from './furniture';
export { buildRailway, railwayLine, railFrameAt, railTrackPath, railStations, railLayout, railReservations, RAIL_M, RAIL_TOP_M, buildSkyway, skywayPath } from './railway';
export type { RailLine, RailFrame, RailStation, RailPier, RailStair, RailLayout } from './railway';
export { buildMetro } from './metro';
export { buildLocalLine, localTrack } from './local-line-build';   // railway-upgrade R3.2/R3.3 — the at-grade local line
export { buildParkedTrain, emuCarLayers, emuCarTris, railConsists, railTrackInfo, railLivery, stepTrainRun, trainRunPlan, RAIL_LIVERIES } from './train';
export { buildSky } from './sky';
export { buildPedestrians } from './pedestrians';
export { computeTraffic } from './traffic';
export type { MoverSpec } from './traffic';
export { computeTextSigns, LANDMARK_LABEL, LANDMARK_H } from './signtext';
export { cityPalette, CITY_PALETTE_NAMES } from './palette';
export { cellLevelAt } from './elevation';
export { makeDomainWarp, makeDomainWarpInto, applyDomainWarp } from './warp';
export { CITY_STYLES, CITY_STYLE_NAMES, cityStyle } from './styles';
export type { CityStylePack } from './styles';
export { buildLandmarks } from './landmarks';
export { buildShotengai } from './shotengai';
export { buildWater } from './water';
export { buildTerraces } from './terraces';
export { makeHeightField, makeElevation, applyHeightField } from './elevation';
export { makeRng, hash2, pointInPolygon } from './util';
export { Accum3D, chipExtrude, edgeChipSpec, EDGE_CHIP_NEAR_M, type ChipSpec, type ChipExtrudeOpts, type EdgeWearLevel } from './meshbuild';
