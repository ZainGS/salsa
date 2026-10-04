/**
 * CITY LOD SETTINGS (docs/ui/performance.md §LOD settings): the user-tunable side of the city's level of detail —
 * per-family draw-distance multipliers, the zoom-tier thresholds, the near/far twin swap distances, the aerial bias
 * and two shadow options — plus the per-family stats and the LOD debug tint behind the City panel's Performance group.
 *
 * DATA-DRIVEN over WorldManager.cityDistanceTiers: every tier in that list is a FAMILY. Known tiers get a friendly id
 * and label (LOD_FAMILY_PROBES: a tier owns a probe when it is the first tier claiming the probe's sample name);
 * tiers added later (another agent's new LOD class) appear automatically under an id derived from their regex.
 *
 * Applying is live, without a city regen: the distances are re-stamped (assignDrawDistances, one tree walk), twin
 * distances rescaled, the renderer's aerial bias / PCF tier / shadow slack written. Persistence is opt-in: the city
 * marker carries only the fields that differ from the defaults (`lod`), so a saved scene that never touched them
 * stays byte-identical, and an absent field means today's behaviour.
 */
import { distanceTierKind, type DistanceTier } from './view-cull';
import { twinDraws } from '../../renderer/3d/distance-lod';
import { PED_NEAR_M } from '../../world/pedestrians';
import { EDGE_CHIP_NEAR_M } from '../../world/meshbuild';
import { Renderer3D } from '../../renderer/3d/renderer-3d';
import { defaultSimLod, sanitizeSimLod, simLodDiff, type SimLodSettings } from '../../world/sim-lod';
import { DEFAULT_SHADOW_QUALITY, isShadowQualityPreset, shadowQualityShown, shadowQualitySpec, type ShadowQualityPreset } from '../../renderer/3d/shadow-quality';

/** Zoom-tier thresholds as multiples of F = 2.8 × city radius (ortho: 0.3 × radius). */
export interface CityZoomTierSettings { detail: number; roof: number; props: number; flatmap: number; structure: number }

export interface CityLodSettings {
  /** Per-chunk camera-distance LOD (R6.1) on. */
  distanceLod: boolean;
  /** Multiplier on every distance-LOD draw distance. */
  global: number;
  /** Per-family draw-distance multipliers by family id (absent = 1). */
  families: Record<string, number>;
  /** Add the camera's height above the city to the biased families' distances (keeps the aerial overview's detail). */
  aerialBias: boolean;
  /** The zoom-gated tiers (whole-family hide past a zoom level) on. */
  zoomTiers: boolean;
  /** Zoom-tier thresholds (multiples of F). */
  zoom: CityZoomTierSettings;
  /** Near/far twin swap distances in metres: the high-detail crowd mannequins, and the chipped stone edges. (The P8
   *  tree crown twins are a 'twin' tier of cityDistanceTiers, tuned through their family multiplier instead.) */
  twins: { crowdM: number; chipsM: number };
  /** Shadow options: PCF kernel (5×5 = soft, 3×3 = cheaper), and how far (in shadow-map texels) the camera focus may
   *  drift before the far map re-centres (0 = every texel, the pre-P6 behaviour). `quality` (P14, shadow-quality.ts):
   *  the preset that also sets the PCF kernel and the cascade count when chosen, and owns the map sizes and refresh
   *  throttles ('high' = today's defaults). */
  shadow: { pcf: '5x5' | '3x3'; slackTexels: number; quality: ShadowQualityPreset };
  /** Colour the city's meshes by LOD family (session-only, never saved). */
  debugTint: boolean;
  /** SIMULATION LOD (src/world/sim-lod.ts, performance-plan §P13): how often movers, the live crowd, character idles
   *  and spring bones update by distance / visibility / fog. The live state is Scene3DManager.simLod; this field is
   *  its view (WorldManager reads and writes through it). */
  sim: SimLodSettings;
}

export const DEFAULT_ZOOM_TIERS: Readonly<CityZoomTierSettings> = Object.freeze({ detail: 1, roof: 1.25, props: 1.2, flatmap: 1.4, structure: 1.7 });
export const DEFAULT_SHADOW_SLACK_TEXELS = 16;

export function defaultCityLodSettings(): CityLodSettings {
  return {
    distanceLod: true, global: 1, families: {}, aerialBias: true, zoomTiers: true, zoom: { ...DEFAULT_ZOOM_TIERS },
    twins: { crowdM: PED_NEAR_M, chipsM: EDGE_CHIP_NEAR_M }, shadow: { pcf: '5x5', slackTexels: DEFAULT_SHADOW_SLACK_TEXELS, quality: DEFAULT_SHADOW_QUALITY },
    debugTint: false, sim: defaultSimLod(),
  };
}

/** A patch: any subset, nested objects partial. `reset: true` starts from the defaults first. */
export type CityLodSettingsPatch = Partial<Omit<CityLodSettings, 'zoom' | 'twins' | 'shadow' | 'families' | 'sim'>> & {
  families?: Record<string, number | null>;
  sim?: Partial<SimLodSettings> & { reset?: boolean };
  zoom?: Partial<CityZoomTierSettings>;
  twins?: Partial<CityLodSettings['twins']>;
  shadow?: Partial<CityLodSettings['shadow']>;
  reset?: boolean;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fin = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const MUL_MIN = 0.05, MUL_MAX = 8;

/** Merge `patch` onto `base` with every value clamped to its legal range (bad values keep the base value). */
export function sanitizeCityLodSettings(patch: unknown, base: CityLodSettings = defaultCityLodSettings()): CityLodSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as CityLodSettingsPatch;
  const b = p.reset ? defaultCityLodSettings() : base;
  const out: CityLodSettings = JSON.parse(JSON.stringify(b));
  if (typeof p.distanceLod === 'boolean') out.distanceLod = p.distanceLod;
  if (fin(p.global)) out.global = clamp(p.global, MUL_MIN, MUL_MAX);
  if (p.families && typeof p.families === 'object') {
    for (const [k, v] of Object.entries(p.families)) {
      if (v === null || (fin(v) && Math.abs(v - 1) < 1e-9)) delete out.families[k];
      else if (fin(v)) out.families[k] = clamp(v, MUL_MIN, MUL_MAX);
    }
  }
  if (typeof p.aerialBias === 'boolean') out.aerialBias = p.aerialBias;
  if (typeof p.zoomTiers === 'boolean') out.zoomTiers = p.zoomTiers;
  if (p.zoom && typeof p.zoom === 'object') {
    for (const k of Object.keys(DEFAULT_ZOOM_TIERS) as (keyof CityZoomTierSettings)[]) {
      const v = p.zoom[k];
      if (fin(v)) out.zoom[k] = clamp(v, 0.05, 20);
    }
  }
  if (p.twins && typeof p.twins === 'object') {
    if (fin(p.twins.crowdM)) out.twins.crowdM = clamp(p.twins.crowdM, 0, 500);
    if (fin(p.twins.chipsM)) out.twins.chipsM = clamp(p.twins.chipsM, 0, 500);
  }
  if (!isShadowQualityPreset(out.shadow.quality)) out.shadow.quality = DEFAULT_SHADOW_QUALITY;   // a save from before P14
  if (p.shadow && typeof p.shadow === 'object') {
    // P14: choosing a preset writes its PCF kernel (an explicit `pcf` in the same patch wins); the cascade count is
    // WorldManager's (setLodSettings applies the preset's).
    if (isShadowQualityPreset(p.shadow.quality)) { out.shadow.quality = p.shadow.quality; out.shadow.pcf = shadowQualitySpec(p.shadow.quality).pcf; }
    if (p.shadow.pcf === '5x5' || p.shadow.pcf === '3x3') out.shadow.pcf = p.shadow.pcf;
    if (fin(p.shadow.slackTexels)) out.shadow.slackTexels = clamp(Math.round(p.shadow.slackTexels), 0, 256);
  }
  if (typeof p.debugTint === 'boolean') out.debugTint = p.debugTint;
  out.sim = sanitizeSimLod(p.sim, out.sim ?? defaultSimLod());
  return out;
}

/** The fields that differ from the defaults (what the city marker stores), or null when nothing does. Never the
 *  debug tint (a session aid). */
export function cityLodSettingsDiff(s: CityLodSettings): Partial<CityLodSettings> | null {
  const d = defaultCityLodSettings();
  const out: Record<string, unknown> = {};
  if (s.distanceLod !== d.distanceLod) out.distanceLod = s.distanceLod;
  if (s.global !== d.global) out.global = s.global;
  if (Object.keys(s.families).length) out.families = { ...s.families };
  if (s.aerialBias !== d.aerialBias) out.aerialBias = s.aerialBias;
  if (s.zoomTiers !== d.zoomTiers) out.zoomTiers = s.zoomTiers;
  const z: Record<string, number> = {};
  for (const k of Object.keys(d.zoom) as (keyof CityZoomTierSettings)[]) if (s.zoom[k] !== d.zoom[k]) z[k] = s.zoom[k];
  if (Object.keys(z).length) out.zoom = z;
  const t: Record<string, number> = {};
  if (s.twins.crowdM !== d.twins.crowdM) t.crowdM = s.twins.crowdM;
  if (s.twins.chipsM !== d.twins.chipsM) t.chipsM = s.twins.chipsM;
  if (Object.keys(t).length) out.twins = t;
  const sh: Record<string, unknown> = {};
  if (s.shadow.pcf !== d.shadow.pcf) sh.pcf = s.shadow.pcf;
  if (s.shadow.slackTexels !== d.shadow.slackTexels) sh.slackTexels = s.shadow.slackTexels;
  if (s.shadow.quality && s.shadow.quality !== d.shadow.quality) sh.quality = s.shadow.quality;
  if (Object.keys(sh).length) out.shadow = sh;
  const sim = s.sim ? simLodDiff(s.sim) : null;
  if (sim) out.sim = sim;
  return Object.keys(out).length ? out as Partial<CityLodSettings> : null;
}

/** Write the renderer-wide LOD options (the PCF kernel, the far-shadow follow slack and the P14 preset's far-map
 *  refresh scale); null = their defaults. (The preset's map sizes and cascades: WorldManager._applyShadowCascades.) */
export function applyLodRendererSettings(scene3d: { setShadowQuality3D(radius: number): void; setShadowIntervalScale3D?(k: number): void }, s: CityLodSettings | null): void {
  scene3d.setShadowQuality3D(s && s.shadow.pcf === '3x3' ? 1 : 0);
  Renderer3D.SHADOW_FOLLOW_SLACK_TEXELS = s ? s.shadow.slackTexels : DEFAULT_SHADOW_SLACK_TEXELS;
  scene3d.setShadowIntervalScale3D?.(s ? shadowQualitySpec(s.shadow.quality).farIntervalScale : 1);
}

// ── Families ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Friendly ids / labels for the known tiers. A tier takes the FIRST probe for which it is the first claiming tier. */
export const LOD_FAMILY_PROBES: readonly { id: string; label: string; probe: string }[] = [
  { id: 'cans', label: 'Vending cans', probe: 'world:vending-stock' },
  { id: 'crowd', label: 'Crowd', probe: 'world:ped-red' },
  { id: 'railFine', label: 'Rail sleepers', probe: 'world:rail-fine-sleepers' },
  { id: 'tiny', label: 'Tiny clutter', probe: 'laundry' },
  { id: 'smallProps', label: 'Small props', probe: 'world:bench' },
  { id: 'poles', label: 'Poles', probe: 'world:util-pole' },
  { id: 'signText', label: 'Sign letters', probe: 'world:detail-sign-text' },
  { id: 'signs', label: 'Name plates', probe: 'textsign-0' },
  { id: 'roadSigns', label: 'Road signs', probe: 'world:roadsign-stop' },
  { id: 'facade', label: 'Facade detail', probe: 'world:detail-trim' },
  { id: 'roof', label: 'Roof objects', probe: 'world:roof-equip' },
  { id: 'trees', label: 'Trees', probe: 'world:tree-zelkova' },
  { id: 'parkedCars', label: 'Parked cars', probe: 'world:car-body' },
  { id: 'vending', label: 'Vending', probe: 'world:vending-body' },
  { id: 'props', label: 'Other props', probe: 'world:busstop' },
  { id: 'flatmap', label: 'Paving', probe: 'world:sidewalks' },
  { id: 'contact', label: 'Contact blobs', probe: 'world:contact-shadow' },
];

export interface CityLodFamily {
  id: string;
  label: string;
  /** P9: a TWIN tier (a near/far swap distance, in real metres at F = 1 — it does not scale with F or the global
   *  multiplier); absent = a draw-distance family. */
  kind?: 'twin' | 'twin2';
  /** Index into the tier list. */
  tier: number;
  /** The tier's distance at F = 1 (a multiple of F), before any multiplier. */
  factor: number;
  /** The fraction of the aerial bias the family takes (0 = true distance). */
  bias: number;
}

function firstTier(name: string, tiers: readonly DistanceTier[]): number {
  for (let i = 0; i < tiers.length; i++) if (tiers[i][0].test(name)) return i;
  return -1;
}

/** An id for a tier no probe names: its regex's first alternative, without the `world:` prefix. */
function fallbackId(re: RegExp): string {
  const first = re.source.split('|')[0].replace(/^world:/, '').replace(/\(\?[!=][^)]*\)/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return first || 'family';
}

/** The families of a tier list (`unitTiers` = cityDistanceTiers(1), so each distance is its multiple of F). */
export function cityLodFamilies(unitTiers: readonly DistanceTier[]): CityLodFamily[] {
  const out: CityLodFamily[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < unitTiers.length; i++) {
    const t = unitTiers[i];
    let id = '', label = '';
    for (const p of LOD_FAMILY_PROBES) {
      if (taken.has(p.id)) continue;
      if (firstTier(p.probe, unitTiers) === i) { id = p.id; label = p.label; break; }
    }
    if (!id) { id = fallbackId(t[0]); label = id.replace(/-/g, ' '); }
    let u = id, n = 2;
    while (taken.has(u)) u = `${id}-${n++}`;
    taken.add(u);
    const kind = distanceTierKind(t);
    out.push({ id: u, label, tier: i, factor: t[1], bias: t.length > 2 ? (t as readonly [RegExp, number, number])[2] : 1, ...(kind !== 'draw' ? { kind } : {}) });
  }
  return out;
}

/** A family as the settings panel shows it: its multiplier and resulting draw distance (world units + metres). */
export interface CityLodFamilyView extends CityLodFamily { multiplier: number; distance: number; metres: number }
/** getCityLodSettings3D: the settings plus the family table, the city's shadow cascades and the scale facts. */
export interface CityLodSettingsView extends Omit<CityLodSettings, 'shadow'> {
  /** `qualityShown`: the preset while the PCF kernel and the cascade count still match it, else 'custom'. */
  shadow: CityLodSettings['shadow'] & { cascades: 1 | 2 | 3; nearMetres: number; qualityShown: ShadowQualityPreset | 'custom' };
  familyList: CityLodFamilyView[];
  /** F = 2.8 x city radius, the Tier-1 zoom threshold (world units); every distance is a multiple of it. */
  F: number;
  metresPerUnit: number;
}
/** getCityLodStats3D: per-family rows + this frame's renderer counters + the resolution scaling state. */
export interface CityLodStats {
  families: CityLodFamilyStats[];
  frame: { fps: number; gpuMs: number | null; cpuMs: number; trisDrawn: number; trisVisible: number; drawCalls: number;
    meshesCulled: number; groupsCulled: number; lodHidden: number; lodTrisHidden: number; shadowTris: number;
    /** P11 honest split (pass-stats.ts): triangles submitted by the colour pass (static + skinned) / the shadow maps
     *  at their last refresh / the other prepasses, and the same for draw calls. trisDrawn mixes all passes. */
    trisMain: number; trisShadow: number; trisOther: number; drawsMain: number; drawsShadow: number; drawsOther: number };
  resolution: { mode: string; current: number };
}

/** The panel view of the settings (pure; WorldManager.getLodSettingsView supplies the city facts). */
export function cityLodSettingsView(s: CityLodSettings, families: readonly CityLodFamily[], F: number, metresPerUnit: number,
    cascades: { cascades: 1 | 2 | 3; nearMetres: number }): CityLodSettingsView {
  const c: CityLodSettings = JSON.parse(JSON.stringify(s));
  return {
    ...c,
    shadow: { ...c.shadow, cascades: cascades.cascades, nearMetres: cascades.nearMetres, qualityShown: shadowQualityShown(c.shadow.quality ?? DEFAULT_SHADOW_QUALITY, c.shadow.pcf, cascades.cascades) },
    familyList: families.map(f => {
      const multiplier = fin(s.families[f.id]) ? s.families[f.id] : 1;
      const distance = f.kind ? f.factor / (metresPerUnit || 1) * multiplier : f.factor * F * s.global * multiplier;   // P9 twin tiers: metres
      return { ...f, multiplier, distance, metres: distance * metresPerUnit };
    }),
    F, metresPerUnit,
  };
}

/** `tiers` with each family's distance multiplied by its setting (the global multiplier is already in `far`). */
export function scaleDistanceTiers(tiers: readonly DistanceTier[], families: readonly CityLodFamily[], s: CityLodSettings): DistanceTier[] {
  return tiers.map((t, i) => {
    const id = families[i]?.id;
    const m = id && fin(s.families[id]) ? s.families[id] : 1;
    if (m === 1) return t;
    return [t[0], t[1] * m, ...t.slice(2)] as unknown as DistanceTier;   // any further elements (bias, shadow size) kept
  });
}

// ── Twins ────────────────────────────────────────────────────────────────────────────────────────────────────────

type TwinNode = { name?: string; children?: unknown[]; lodTwinRole?: number; lodTwinDist?: number; lodTwinDist2?: number; lodTwinOffNear?: boolean };
/** The crowd's twins are the people layers; every other twin is an edge-chip / detail twin. */
export const CROWD_TWIN_RE = /world:ped-/;
/** P8: the trees' crown twins (full near crown / thinned far crown, city-foliage.ts) — their swap distance is the
 *  'twin' tier in WorldManager.cityDistanceTiers (a family of its own), so the chip multiplier leaves them alone. */
export const TREE_TWIN_RE = /world:tree-/;

/** Rescale every near/far twin distance under `roots` from its BUILT value (remembered on first sight). */
export function stampTwinDistances(roots: readonly unknown[], s: CityLodSettings, base: WeakMap<object, [number, number]>): number {
  const crowd = PED_NEAR_M > 0 ? s.twins.crowdM / PED_NEAR_M : 1;
  const chips = EDGE_CHIP_NEAR_M > 0 ? s.twins.chipsM / EDGE_CHIP_NEAR_M : 1;
  let n = 0;
  const stack: unknown[] = [...roots];
  while (stack.length) {
    const node = stack.pop() as TwinNode;
    if (!node) continue;
    if (node.lodTwinRole && typeof node.lodTwinDist === 'number' && !TREE_TWIN_RE.test(node.name ?? '') && !node.lodTwinOffNear) {   // P8: trees are tier-driven; P9 prop twins (lodTwinOffNear) too
      let b = base.get(node);
      if (!b) { b = [node.lodTwinDist, typeof node.lodTwinDist2 === 'number' ? node.lodTwinDist2 : 0]; base.set(node, b); }
      const m = CROWD_TWIN_RE.test(node.name ?? '') ? crowd : chips;
      node.lodTwinDist = b[0] * m;
      if (typeof node.lodTwinDist2 === 'number') node.lodTwinDist2 = b[1] * m;
      n++;
    }
    if (node.children) for (const k of node.children) stack.push(k);
  }
  return n;
}

// ── Stats ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CityLodFamilyStats {
  id: string;
  label: string;
  /** Meshes + instanced groups in the family. */
  objects: number;
  /** Drawn this frame as far as LOD goes (visible and inside its draw distance; the frustum may still cull it). */
  shown: number;
  /** Past its draw distance (or the twin not in use). */
  lodHidden: number;
  /** Hidden by a zoom tier (or the layer switched off). */
  zoomHidden: number;
  /** Triangles of the shown / LOD-hidden objects (instanced groups count every copy). */
  trisShown: number;
  trisHidden: number;
}

type StatNode = {
  id?: string | number; name?: string; visible?: boolean; children?: unknown[]; drawDistance?: number;
  lodHidden?: boolean; lodTwinRole?: number; lodTwinNear?: boolean; lodTwinNear2?: boolean; triangleCount?: number;
  sourceId?: string; arrayParams?: unknown;
};

/** Per-family counts over the city's groups. `groupLodHidden` answers the renderer's per-group LOD state.
 *  The last row (id 'other') is everything no family claims (buildings, roads, ground, lit signs...). */
export function collectCityLodStats(roots: readonly unknown[], tiers: readonly DistanceTier[], families: readonly CityLodFamily[],
    groupLodHidden: (id: string) => boolean, instanceCount: (params: unknown) => number): CityLodFamilyStats[] {
  const rows: CityLodFamilyStats[] = families.map(f => ({ id: f.id, label: f.label, objects: 0, shown: 0, lodHidden: 0, zoomHidden: 0, trisShown: 0, trisHidden: 0 }));
  const other: CityLodFamilyStats = { id: 'other', label: 'Untiered', objects: 0, shown: 0, lodHidden: 0, zoomHidden: 0, trisShown: 0, trisHidden: 0 };
  const meshTris = new Map<string | number, number>();
  const groups: { node: StatNode; row: CityLodFamilyStats; visible: boolean }[] = [];
  const stack: { node: StatNode; tier: number; visible: boolean }[] = roots.map(r => ({ node: r as StatNode, tier: -2, visible: true }));
  while (stack.length) {
    const { node, tier: inherited, visible: pv } = stack.pop()!;
    if (!node) continue;
    let tier = inherited;
    if (inherited === -2) { const t = firstTier(node.name ?? '', tiers); if (t >= 0) tier = t; }
    const visible = pv && node.visible !== false;
    const row = tier >= 0 ? rows[tier] ?? other : other;
    if (node.sourceId !== undefined && node.arrayParams !== undefined) {
      groups.push({ node, row, visible });
    } else if (typeof node.triangleCount === 'number' && typeof node.drawDistance === 'number') {
      const tris = node.triangleCount;
      if (node.id !== undefined) meshTris.set(node.id, tris);
      row.objects++;
      const twinOut = !!node.lodTwinRole && !twinDraws(node.lodTwinRole, !!node.lodTwinNear, node.lodTwinNear2 !== false);   // P9: + mid / xfar
      if (!visible) row.zoomHidden++;
      else if (node.lodHidden || twinOut) { row.lodHidden++; row.trisHidden += tris; }
      else { row.shown++; row.trisShown += tris; }
    }
    if (node.children) for (const k of node.children) stack.push({ node: k as StatNode, tier: tier >= 0 ? tier : -2, visible });
  }
  for (const { node, row, visible } of groups) {
    const tris = (meshTris.get(node.sourceId!) ?? 0) * Math.max(0, instanceCount(node.arrayParams));
    row.objects++;
    if (!visible) row.zoomHidden++;
    else if (groupLodHidden(String(node.id))) { row.lodHidden++; row.trisHidden += tris; }
    else { row.shown++; row.trisShown += tris; }
  }
  return [...rows, other];
}

// ── Debug tint ───────────────────────────────────────────────────────────────────────────────────────────────────

type RGBA = { r: number; g: number; b: number; a: number };
type TintNode = StatNode & { material?: { diffuse: RGBA; emissive: RGBA }; materialDirty?: boolean };

/** A distinct, saturated colour per family index (golden-angle hues). */
export function lodFamilyColor(i: number): [number, number, number] {
  const h = (i * 0.618034 + 0.08) % 1, s = 0.85, v = 1;
  const k = (n: number) => { const x = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(x, 4 - x, 1)); };
  return [k(5), k(3), k(1)];
}

/**
 * The LOD DEBUG TINT: every family's meshes in their family colour (glowing, so night and shading don't hide it),
 * everything untiered a dim grey — fly around and watch which colours drop out where. The far twin of a near/far
 * pair shows darker than its near twin. Material-only writes (`materialDirty`, the cheap budgeted repack; never a
 * geometry rebuild). `restore` puts every touched mesh's colours back.
 */
export class LodDebugTint {
  private readonly _saved = new Map<TintNode, { diffuse: RGBA; emissive: RGBA }>();
  get active(): boolean { return this._saved.size > 0; }

  /** Tint every mesh under `roots` not tinted yet (call again after new meshes arrive). */
  apply(roots: readonly unknown[], tiers: readonly DistanceTier[]): number {
    let n = 0;
    const stack: { node: TintNode; tier: number }[] = roots.map(r => ({ node: r as TintNode, tier: -2 }));
    while (stack.length) {
      const { node, tier: inherited } = stack.pop()!;
      if (!node) continue;
      let tier = inherited;
      if (inherited === -2) { const t = firstTier(node.name ?? '', tiers); if (t >= 0) tier = t; }
      const mat = node.material;
      if (mat && mat.diffuse && mat.emissive && typeof node.drawDistance === 'number' && !this._saved.has(node)) {
        this._saved.set(node, { diffuse: { ...mat.diffuse }, emissive: { ...mat.emissive } });
        const c = tier >= 0 ? lodFamilyColor(tier) : [0.32, 0.32, 0.34] as [number, number, number];
        const k = node.lodTwinRole === 2 ? 0.45 : 1;   // far twin darker
        const e = tier >= 0 ? 0.75 : 0.15;
        mat.diffuse = { r: c[0] * k, g: c[1] * k, b: c[2] * k, a: mat.diffuse.a };
        mat.emissive = { r: c[0] * k * e, g: c[1] * k * e, b: c[2] * k * e, a: 1 };
        node.materialDirty = true;
        n++;
      }
      if (node.children) for (const k of node.children) stack.push({ node: k as TintNode, tier: tier >= 0 ? tier : -2 });
    }
    return n;
  }

  /** Put the original colours back (meshes removed meanwhile are simply dropped). */
  restore(): number {
    let n = 0;
    for (const [node, c] of this._saved) {
      if (node.material) { node.material.diffuse = c.diffuse; node.material.emissive = c.emissive; node.materialDirty = true; n++; }
    }
    this._saved.clear();
    return n;
  }

  /** Forget everything without restoring (the meshes are gone: a city clear / document load). */
  forget(): void { this._saved.clear(); }
}
