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
export { buildTrafficLights } from './signals';
export { buildSignage } from './signage';
export { buildAwnings } from './awnings';
export { buildFurniture } from './furniture';
export { buildRailway, railwayLine, buildSkyway, skywayPath } from './railway';
export { buildSky } from './sky';
export { buildPedestrians } from './pedestrians';
export { computeTraffic } from './traffic';
export type { MoverSpec } from './traffic';
export { computeTextSigns } from './signtext';
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
export { makeRng, hash2 } from './util';
export { Accum3D } from './meshbuild';
