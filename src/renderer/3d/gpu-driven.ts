/**
 * GPU-DRIVEN MAIN PASS (engine-roadmap step 4, performance-plan.md §P15) — the pure part: buffer layouts, the CPU
 * mirror of the compute cull rules, and the draw-bucket / bundle-invalidation bookkeeping. No GPU objects here, so
 * every rule is unit-tested in node (gpu-driven.test.ts); the WGSL twin of `gdCullRecord` lives in
 * shaders/gpu-cull-shaders.ts and the GPU resources in gpu-scene.ts.
 *
 * The scene lives on the GPU as one RECORD per main-pass draw (a single-material opaque mesh, or an opaque instanced
 * array group): its world box, distance-LOD and fog parameters and its draw arguments. A per-record CONTROL word says
 * whether the record is part of this frame at all and whether the CPU decides its visibility itself (FORCED: near/far
 * twins in Phase A, billboards, always-on-top cards). A per-record STATE word holds the GPU-owned hysteresis (distance
 * LOD). Each frame a compute pass evaluates every record exactly like Renderer3D._buildDrawLists and writes one
 * drawIndexedIndirect argument block per record (instanceCount 0 = culled); a render bundle replays one indirect draw
 * per record in the CPU path's draw order, so the image is the CPU path's image.
 */

// ── Record layout (GdRec in the WGSL, 28 x 4 bytes) ───────────────────────────────────────────────────────────────
export const GD_REC_WORDS = 28;
export const GD_REC_BYTES = GD_REC_WORDS * 4;
/** Word offsets inside one record. */
export const GdRecW = {
  minX: 0, minY: 1, minZ: 2, drawDistance: 3,
  maxX: 4, maxY: 5, maxZ: 6, drawDistanceBias: 7,
  indexCount: 8, firstIndex: 9, baseVertex: 10, firstInstance: 11,
  count: 12, flags: 13, tris: 14, twinRole: 15,
  /** Phase C: shFeature = Mesh3D.shadowFeatureSize (the P8 shadow LOD), shFlags = GD_SHF_* (caster flags). */
  twinDist: 16, twinDist2: 17, twinFlags: 18, shFeature: 19,
  /** P8 group twins: the instances' ORIGIN box (the near / far swap distance is measured to it, not to the box). */
  oMinX: 20, oMinY: 21, oMinZ: 22, shFlags: 23,
  oMaxX: 24, oMaxY: 25, oMaxZ: 26, pad2: 27,
} as const;
/** GdRec.twinFlags bits. */
export const GD_TWIN_OFF_NEAR = 1;     // Mesh3D.lodTwinOffNear: the near twin draws whenever the distance cannot decide
export const GD_TWIN_INSTANCED = 2;    // Mesh3D.lodTwinInstanced: follows Renderer3D.groupTwins (the far tree crowns)
export const GD_TWIN_NO_ORIGIN = 4;    // a group twin without an origin box (no explicit offsets): always near

/** GdRec.flags bits. */
export const GD_FLAG_FOG_OTHER = 1;    // fog class 2: culled past the fog edge with Buildings only
export const GD_FLAG_FOG_ATTACH = 2;   // fog class 1: culled unless attachments are included
export const GD_FLAG_NO_FOG = 4;       // material.noFog: never fog-culled
export const GD_FLAG_GROUP = 8;        // an instanced array group (LOD before fog, as the CPU group loop)
export const GD_FLAG_NO_BOX = 16;      // no world box: no LOD / fog / frustum test (the CPU's `bb === null`)

/** GdRec.shFlags (Phase C). */
export const GD_SHF_CASTS = 1;       // a shadow caster (every opaque mesh record; a group whose source castsInstancedShadow)
export const GD_SHF_WIND = 2;        // material.windSway (dynamic while the wind blows)

/** Control word bits (one u32 per record, written by the CPU only when it changes). */
export const GD_CTL_ENABLED = 1;       // the record is in this frame's mesh / group roster
export const GD_CTL_FORCED = 2;        // the CPU decides the record's visibility (bit 2)
export const GD_CTL_FORCED_VIS = 4;
/** The draw-list loop visited the record past the hierarchical cull (not a member of a rejected cluster). A twin that
 *  was not visited the frame before re-seeds its swap state, exactly as the CPU loop does (P9). */
export const GD_CTL_VISITED = 8;
/** Phase C: the caster moved within the last 1800 frames or is on its 90-frame probation (Renderer3D._casterIsDynamic). */
export const GD_CTL_DYNAMIC = 16;
/** Phase C: a member of a cluster the hierarchical cull rejected with HC_NOREACH (in the light box, shadow off view). */
export const GD_CTL_NOREACH = 32;
/** The CPU's distance-LOD / twin state after this frame's draw-list loop (Mesh3D.lodHidden / lodTwinNear /
 *  lodTwinNear2; a group's _lodHiddenGroups / _lodTwinNearGroups). With GD_FRAME_CPU_STATE the cull takes these
 *  instead of re-deriving the hysteresis: an f32 rounding tie at a threshold, or any frame one side held while the
 *  other updated, can otherwise split the two hysteresis histories, and they then disagree inside the band for as
 *  long as the camera stays there. The CPU loop computes them for every visited record anyway. */
export const GD_CTL_CPU_LOD = 64, GD_CTL_CPU_N1 = 128, GD_CTL_CPU_N2 = 256;
/** The record draws with its own vertex buffer (GD_CODE_VB_OVERRIDE): it stays out of the compacted dynamic shadow
 *  lists (they draw from the pool's vertex buffer) and is drawn from its own block (GD_SH_COMPACT). */
export const GD_CTL_VB_OV = 512;

/** State word bits (one u32 per record, owned by the compute pass after the CPU seeds it). */
export const GD_STATE_LOD_HIDDEN = 1;
export const GD_STATE_FOG_HIDDEN = 2;
export const GD_STATE_TWIN_NEAR = 4;       // Mesh3D.lodTwinNear / the group twin's camera-near state
export const GD_STATE_TWIN_NEAR2 = 8;      // Mesh3D.lodTwinNear2
export const GD_STATE_VISITED_LAST = 32;   // visited the previous frame (see GD_CTL_VISITED)
export const GD_STATE_VISIBLE = 16;
/** Phase C: passed this frame's fog / LOD / twin tests (the CPU loop would have reached its shadow section). */
export const GD_STATE_SH_ELIG = 64;
/** Phase C: a member of the far / cascade 0 / cascade 1 STATIC layer this frame (MEM), and drawn into it (IN: set by
 *  the commit pass when that layer re-renders). */
export const GD_STATE_MEM_FAR = 128, GD_STATE_MEM_C0 = 256, GD_STATE_MEM_C1 = 512;
export const GD_STATE_IN_FAR = 1024, GD_STATE_IN_C0 = 2048, GD_STATE_IN_C1 = 4096;

/** drawIndexedIndirect argument block: indexCount, instanceCount, firstIndex, baseVertex, firstInstance. */
export const GD_ARGS_WORDS = 5;
export const GD_ARGS_BYTES = GD_ARGS_WORDS * 4;

// ── Frame uniform (GdFrame in the WGSL) ──────────────────────────────────────────────────────────────────────────
export const GD_FRAME_FLOATS = 40;
export const GD_FRAME_BYTES = GD_FRAME_FLOATS * 4;
export const GdFrameW = {
  planes: 0,           // 6 x vec4 (a, b, c, d), inside = a x + b y + c z + d >= 0
  cam: 24,             // xyz camera position, w = orthoD2
  fog: 28,             // xyz fog eye, w = the squared fog cull distance
  lod: 32,             // x lodScale, y lodBias, z show fraction (0.9), w frustum epsilon factor
  ctl: 36,             // u32: x frame flags, y record count, z frame number, w the P11 merge gap (runs)
} as const;
/** GdFrame.ctl.x bits. */
export const GD_FRAME_FRUSTUM = 1;
export const GD_FRAME_LOD = 2;
export const GD_FRAME_LOD_ORTHO = 4;
export const GD_FRAME_FOG_OTHER = 8;
export const GD_FRAME_FOG_ATTACH = 16;
export const GD_FRAME_HC = 32;             // the hierarchical cull ran (twins re-seed after a gap)
export const GD_FRAME_GROUP_TWINS = 64;    // Renderer3D.groupTwins
export const GD_FRAME_RANGES = 128;        // Phase B: P11 cull ranges on this frame (the CPU's rangeOn)
export const GD_FRAME_CPU_STATE = 256;     // the LOD / twin hysteresis state comes from the CPU (GD_CTL_CPU_*)

/** Stats buffer (u32 counters, accumulated by the compute pass, read back one frame late). */
export const GdStat = {
  draws: 0, tris: 1, instances: 2, meshesCulled: 3, groupsCulled: 4, instancesCulled: 5,
  lodHidden: 6, lodTris: 7, fogHidden: 8, fogTris: 9, forcedVisible: 10, enabled: 11, forcedTris: 12,
  /** Phase B: triangles the range jobs left out of drawn ranged records (written by cs_ranges, not the workgroup sums). */
  rangeTris: 13,
  /** Phase C (cs_shadow): per static layer (far, cascade 0, cascade 1) its leavers, joiners and the joiners' triangles. */
  shLeave: 16, shJoin: 19, shJoinTris: 22,
  /** GD_SH_COMPACT: the slots cs_shadow appended to the compact far-dynamic / cascade 0 / cascade 1 dynamic lists. */
  shCompact: 25,
} as const;
export const GD_STAT_WORDS = 32;

// ── Phase C: the shadow frame uniform (GdShadowFrame in the WGSL) and the caster layers ─────────────────────────
/** Argument-block layers of the shadow casters (one block per record and layer, at shadowBase + layer x stride + r). */
export const GdShLayer = { direct: 0, farStatic: 1, farDyn: 2, c0: 3, c0Dyn: 4, c1: 5, c1Dyn: 6 } as const;
export const GD_SH_LAYERS = 7;
export const GD_SH_FRAME_FLOATS = 84;
export const GdShFrameW = { light: 0, casc: 24, ldir: 72, lod: 76, ctl: 80 } as const;
/** GdShadowFrame.ctl.x flags. */
export const GD_SH_ON = 1, GD_SH_CACHE = 2, GD_SH_SPLIT = 4, GD_SH_REACH = 8, GD_SH_LIGHT = 16, GD_SH_WIND = 32,
  GD_SH_BAND = 64, GD_SH_BAND_ATTACH = 128, GD_SH_JOIN = 256, GD_SH_COMPACT = 512;

/** The per-frame inputs of the shadow-caster rules (the locals Renderer3D._buildDrawLists derives). */
export interface GdShadowParams {
  on: boolean;
  /** Far light-box planes (24) or null (no light culler); cascade planes (24 per cascade). */
  light: ArrayLike<number> | null;
  casc: (ArrayLike<number> | null)[];
  cascades: number;
  /** The stepped light travel direction (unit) and the reach floor (Infinity / null = reach unbounded). */
  ldir: ArrayLike<number>; floorY: number;
  reach: boolean;
  /** P8 shadow LOD thresholds (the far map, cascade 0, cascade 1). */
  lodFar: number; lodC0: number; lodC1: number;
  cache: boolean; split: boolean; wind: boolean; join: boolean;
  band: boolean; bandAttach: boolean; bandIn: number;
}

export function packGdShadowFrame(out: Float32Array, p: GdShadowParams, shadowBase: number, stride: number): void {
  const u = new Uint32Array(out.buffer, out.byteOffset, GD_SH_FRAME_FLOATS);
  const fin = (x: number) => (Number.isFinite(x) ? Math.max(-3.0e38, Math.min(3.0e38, x)) : (x > 0 ? 3.0e38 : -3.0e38));
  for (let i = 0; i < 24; i++) out[GdShFrameW.light + i] = p.light ? p.light[i] : 0;
  for (let c = 0; c < 2; c++) { const pl = p.casc[c]; for (let i = 0; i < 24; i++) out[GdShFrameW.casc + c * 24 + i] = pl ? pl[i] : 0; }
  out[GdShFrameW.ldir] = p.ldir[0]; out[GdShFrameW.ldir + 1] = p.ldir[1]; out[GdShFrameW.ldir + 2] = p.ldir[2];
  out[GdShFrameW.ldir + 3] = Number.isFinite(p.floorY) ? fin(p.floorY) : 3.0e38;
  out[GdShFrameW.lod] = fin(p.lodFar); out[GdShFrameW.lod + 1] = fin(p.lodC0); out[GdShFrameW.lod + 2] = fin(p.lodC1); out[GdShFrameW.lod + 3] = fin(p.bandIn);
  let fl = 0;
  if (p.on) fl |= GD_SH_ON;
  if (p.cache) fl |= GD_SH_CACHE;
  if (p.split) fl |= GD_SH_SPLIT;
  if (p.reach) fl |= GD_SH_REACH;
  if (p.light) fl |= GD_SH_LIGHT;
  if (p.wind) fl |= GD_SH_WIND;
  if (p.band) fl |= GD_SH_BAND;
  if (p.bandAttach) fl |= GD_SH_BAND_ATTACH;
  if (p.join) fl |= GD_SH_JOIN;
  u[GdShFrameW.ctl] = fl; u[GdShFrameW.ctl + 1] = Math.max(0, Math.min(2, p.cascades)) >>> 0;
  u[GdShFrameW.ctl + 2] = shadowBase >>> 0; u[GdShFrameW.ctl + 3] = stride >>> 0;
}

/** Compute workgroup size (records per invocation group). */
export const GD_WORKGROUP = 64;

/** Relative epsilon of the GPU frustum test: a box is culled only when it lies outside a plane by more than
 *  eps x (|a x| + |b y| + |c z| + |d|). f32 vs the CPU's f64 can only disagree inside that band, and the GPU then
 *  DRAWS (a box touching the frustum within float rounding covers no pixel), so the image never loses anything. */
export const GD_FRUSTUM_EPS = 4e-6;

// ── The cull rule (CPU mirror of gpu-cull-shaders.ts, in f32) ───────────────────────────────────────────────────

/** The per-frame inputs of the cull (the same locals Renderer3D._buildDrawLists derives). */
export interface GdFrameParams {
  /** 6 normalized planes, 24 floats (FrustumCuller order), or null = frustum culling off. */
  planes: ArrayLike<number> | null;
  cam: ArrayLike<number>;
  /** Distance LOD on this frame (`distanceLod && (!ortho || orthoScreenLod)`). */
  lodOn: boolean;
  lodOrtho: boolean;
  /** (orthoLodDistance(orthoSize))^2 under ortho. */
  orthoD2: number;
  /** fovDistanceScale x distanceLodScale x lodResolutionScale (1 under ortho for the lens part). */
  lodScale: number;
  lodBias: number;
  fogEye: ArrayLike<number>;
  /** Squared fog cull distance (edge x 1.01)^2. */
  fogCull2: number;
  fogCullOther: boolean;
  fogCullAttach: boolean;
  /** The hierarchical cull is on this frame (twin re-seed rule). */
  hcOn?: boolean;
  /** Renderer3D.groupTwins. */
  groupTwins?: boolean;
  /** Take the LOD / twin state from the control word (GD_CTL_CPU_*, GpuDrivenMain.cpuState). */
  cpuState?: boolean;
  /** P11 cull ranges on this frame (Renderer3D's rangeOn), and the run merge gap (CULL_RANGE_MERGE_GAP). */
  ranges?: boolean;
  mergeGap?: number;
}

const f = Math.fround;

/** Pack the frame uniform (GdFrame). */
export function packGdFrame(out: Float32Array, p: GdFrameParams, count: number, frame: number): void {
  const u = new Uint32Array(out.buffer, out.byteOffset, GD_FRAME_FLOATS);
  if (p.planes) for (let i = 0; i < 24; i++) out[GdFrameW.planes + i] = p.planes[i];
  else for (let i = 0; i < 24; i++) out[GdFrameW.planes + i] = 0;
  out[GdFrameW.cam] = p.cam[0]; out[GdFrameW.cam + 1] = p.cam[1]; out[GdFrameW.cam + 2] = p.cam[2]; out[GdFrameW.cam + 3] = p.orthoD2;
  out[GdFrameW.fog] = p.fogEye[0]; out[GdFrameW.fog + 1] = p.fogEye[1]; out[GdFrameW.fog + 2] = p.fogEye[2];
  // a finite value: the WGSL only compares against it while a fog flag is set
  out[GdFrameW.fog + 3] = Number.isFinite(p.fogCull2) ? Math.min(p.fogCull2, 3.0e38) : 3.0e38;
  out[GdFrameW.lod] = p.lodScale; out[GdFrameW.lod + 1] = p.lodBias; out[GdFrameW.lod + 2] = 0.9; out[GdFrameW.lod + 3] = GD_FRUSTUM_EPS;
  let fl = 0;
  if (p.planes) fl |= GD_FRAME_FRUSTUM;
  if (p.lodOn) fl |= GD_FRAME_LOD;
  if (p.lodOrtho) fl |= GD_FRAME_LOD_ORTHO;
  if (p.fogCullOther && Number.isFinite(p.fogCull2)) fl |= GD_FRAME_FOG_OTHER;
  if (p.fogCullAttach && Number.isFinite(p.fogCull2)) fl |= GD_FRAME_FOG_ATTACH;
  if (p.hcOn) fl |= GD_FRAME_HC;
  if (p.groupTwins) fl |= GD_FRAME_GROUP_TWINS;
  if (p.ranges) fl |= GD_FRAME_RANGES;
  if (p.cpuState) fl |= GD_FRAME_CPU_STATE;
  u[GdFrameW.ctl] = fl; u[GdFrameW.ctl + 1] = count >>> 0; u[GdFrameW.ctl + 2] = frame >>> 0; u[GdFrameW.ctl + 3] = (p.mergeGap ?? 0) >>> 0;
}

/** distanceLodHidden in f32 steps. */
function lodHiddenF(d2: number, far: number, wasHidden: boolean): boolean {
  if (wasHidden) { const s = f(far * f(0.9)); return d2 >= f(s * s); }
  return d2 > f(far * far);
}

/** Squared distance from p to the record's box (or, `origin`, its instance-origin box), in f32 steps (as the WGSL). */
function boxDist2F(px: number, py: number, pz: number, r: Float32Array, o: number, origin = false): number {
  const b0 = origin ? GdRecW.oMinX : GdRecW.minX, b1 = origin ? GdRecW.oMaxX : GdRecW.maxX;
  const x0 = r[o + b0], y0 = r[o + b0 + 1], z0 = r[o + b0 + 2];
  const x1 = r[o + b1], y1 = r[o + b1 + 1], z1 = r[o + b1 + 2];
  const dx = px < x0 ? f(x0 - px) : px > x1 ? f(px - x1) : 0;
  const dy = py < y0 ? f(y0 - py) : py > y1 ? f(py - y1) : 0;
  const dz = pz < z0 ? f(z0 - pz) : pz > z1 ? f(pz - z1) : 0;
  return f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz));
}

/** The frustum test of the WGSL (positive-vertex test with the relative epsilon). True = inside / intersecting. */
export function gdFrustumTest(planes: ArrayLike<number>, r: Float32Array, o: number, eps = GD_FRUSTUM_EPS): boolean {
  for (let i = 0; i < 6; i++) {
    const a = f(planes[i * 4]), b = f(planes[i * 4 + 1]), c = f(planes[i * 4 + 2]), d = f(planes[i * 4 + 3]);
    const x = a >= 0 ? r[o + GdRecW.maxX] : r[o + GdRecW.minX];
    const y = b >= 0 ? r[o + GdRecW.maxY] : r[o + GdRecW.minY];
    const z = c >= 0 ? r[o + GdRecW.maxZ] : r[o + GdRecW.minZ];
    const ax = f(a * x), by = f(b * y), cz = f(c * z);
    const s = f(f(f(ax + by) + cz) + d);
    const mag = f(f(f(Math.abs(ax) + Math.abs(by)) + Math.abs(cz)) + Math.abs(d));
    if (s < -f(eps * mag)) return false;
  }
  return true;
}

/** Why a record is not drawn (diagnostics + tests). Cluster = a member of a cluster the CPU's hierarchical cull
 *  rejected (outside the view: the CPU skipped it, so its LOD / twin state is held). */
export const enum GdWhy { Drawn = 0, Disabled = 1, ForcedHidden = 2, NoGeometry = 3, Fog = 4, Lod = 5, Frustum = 6, Twin = 7, Cluster = 8 }

export interface GdCullResult { instanceCount: number; state: number; why: GdWhy }

/**
 * CPU MIRROR of the compute cull for record `i` (f32 arithmetic like the shader). `rec` / `recU` are the record
 * table as floats / u32 (one buffer), `ctl` the control words, `state` the state words (read, the new state is
 * returned). The rules are Renderer3D._buildDrawLists' main-pass rules, in its order:
 *  - mesh: hierarchical-cull reject (state held) → twin re-seed → fog horizon (state held) → distance LOD
 *    (hysteresis) → near / far twins (E2 / P9, hysteresis) → frustum;
 *  - group: group twins (P8, origin box) → distance LOD (hysteresis) → fog horizon → frustum;
 *  - FORCED records take the CPU's verdict (externally driven twins, billboards, always-on-top).
 * VISITED_LAST tracks the CPU's `_hcSeen === hcFrame - 1`: set only on a frame where the hierarchical cull ran and the
 * loop got past it; a disabled (not in the roster) or rejected record clears it, so its twins re-seed on return.
 */
export function gdCullRecord(rec: Float32Array, recU: Uint32Array, ctl: number, state: number, i: number, F: GdFrameParams): GdCullResult {
  const res = gdCullRecordInner(rec, recU, ctl, state, i, F);
  // Phase C: the record reached the CPU loop's shadow section (fog / LOD / twins passed; the frustum does not matter)
  const elig = (ctl & GD_CTL_ENABLED) !== 0 && (res.why === GdWhy.Drawn || res.why === GdWhy.Frustum);
  res.state = elig ? (res.state | GD_STATE_SH_ELIG) : (res.state & ~GD_STATE_SH_ELIG);
  return res;
}
function gdCullRecordInner(rec: Float32Array, recU: Uint32Array, ctl: number, state: number, i: number, F: GdFrameParams): GdCullResult {
  const o = i * GD_REC_WORDS;
  if (!(ctl & GD_CTL_ENABLED)) return { instanceCount: 0, state: state & ~(GD_STATE_VISIBLE | GD_STATE_VISITED_LAST), why: GdWhy.Disabled };
  const count = recU[o + GdRecW.count];
  const flags = recU[o + GdRecW.flags];
  const group = (flags & GD_FLAG_GROUP) !== 0;
  const hcOn = !!F.hcOn;
  const visited = group || !hcOn || (ctl & GD_CTL_VISITED) !== 0;
  const lastVisited = (state & GD_STATE_VISITED_LAST) !== 0;
  let st = state & ~(GD_STATE_VISIBLE | GD_STATE_FOG_HIDDEN);
  st = hcOn && visited ? (st | GD_STATE_VISITED_LAST) : (st & ~GD_STATE_VISITED_LAST);
  if (ctl & GD_CTL_FORCED) {
    const vis = (ctl & GD_CTL_FORCED_VIS) !== 0 && recU[o + GdRecW.indexCount] > 0;
    return { instanceCount: vis ? count : 0, state: vis ? (st | GD_STATE_VISIBLE) : st, why: vis ? GdWhy.Drawn : GdWhy.ForcedHidden };
  }
  const noBox = (flags & GD_FLAG_NO_BOX) !== 0;
  const role = recU[o + GdRecW.twinRole], tf = recU[o + GdRecW.twinFlags];
  const cpu = !!F.cpuState;
  // (group twins are decided first, before the geometry check: the CPU group loop's order)
  if (group && (role === 1 || role === 2)) {
    let near = true;
    if (F.groupTwins && F.lodOn && rec[o + GdRecW.twinDist] > 0 && !(tf & GD_TWIN_NO_ORIGIN)) {
      const d2 = F.lodOrtho ? f(F.orthoD2) : boxDist2F(f(F.cam[0]), f(F.cam[1]), f(F.cam[2]), rec, o, true);
      near = cpu ? (ctl & GD_CTL_CPU_N1) !== 0 : !lodHiddenF(d2, f(rec[o + GdRecW.twinDist] * f(F.lodScale)), (st & GD_STATE_TWIN_NEAR) === 0);
      st = near ? (st | GD_STATE_TWIN_NEAR) : (st & ~GD_STATE_TWIN_NEAR);
    }
    if ((role === 1) !== near) return { instanceCount: 0, state: st, why: GdWhy.Twin };
  }
  // a member of a cluster the hierarchical cull rejected (outside the view): the CPU skipped it, state held
  if (!visited) return { instanceCount: 0, state: st, why: GdWhy.Cluster };
  // the P9 re-seed: a twin not visited past the hierarchical cull the frame before starts over (near1 off, near2 on)
  if (!group && role !== 0 && hcOn && !lastVisited) st = (st & ~GD_STATE_TWIN_NEAR) | GD_STATE_TWIN_NEAR2;
  if (recU[o + GdRecW.indexCount] === 0 || count === 0) return { instanceCount: 0, state: st, why: GdWhy.NoGeometry };
  const fogTest = (): boolean => {
    if (noBox || (flags & GD_FLAG_NO_FOG)) return false;
    const cls = ((flags & GD_FLAG_FOG_OTHER) && F.fogCullOther) || ((flags & GD_FLAG_FOG_ATTACH) && F.fogCullAttach);
    if (!cls || !Number.isFinite(F.fogCull2)) return false;
    return boxDist2F(f(F.fogEye[0]), f(F.fogEye[1]), f(F.fogEye[2]), rec, o) > f(F.fogCull2);
  };
  const lodStep = (): boolean => {
    const dd = rec[o + GdRecW.drawDistance];
    if (!F.lodOn || !(dd > 0) || noBox) { st &= ~GD_STATE_LOD_HIDDEN; return false; }
    const d2 = F.lodOrtho ? f(F.orthoD2) : boxDist2F(f(F.cam[0]), f(F.cam[1]), f(F.cam[2]), rec, o);
    const far = f(f(dd + f(f(F.lodBias) * rec[o + GdRecW.drawDistanceBias])) * f(F.lodScale));
    let hid: boolean;
    if (cpu) hid = (ctl & GD_CTL_CPU_LOD) !== 0;
    else if (st & GD_STATE_LOD_HIDDEN) { const sh = f(far * f(0.9)); hid = d2 >= f(sh * sh); } else hid = d2 > f(far * far);
    st = hid ? (st | GD_STATE_LOD_HIDDEN) : (st & ~GD_STATE_LOD_HIDDEN);
    return hid;
  };
  if (group) {
    if (lodStep()) return { instanceCount: 0, state: st, why: GdWhy.Lod };
    if (fogTest()) return { instanceCount: 0, state: st | GD_STATE_FOG_HIDDEN, why: GdWhy.Fog };
  } else {
    if (fogTest()) return { instanceCount: 0, state: st | GD_STATE_FOG_HIDDEN, why: GdWhy.Fog };
    if (lodStep()) return { instanceCount: 0, state: st, why: GdWhy.Lod };
    // E2 / P9 mesh twins (after fog + LOD: a hidden twin holds its swap state)
    if (role !== 0) {
      let n1 = (st & GD_STATE_TWIN_NEAR) !== 0, n2 = (st & GD_STATE_TWIN_NEAR2) !== 0;
      if (!F.lodOn || noBox || ((tf & GD_TWIN_INSTANCED) && !F.groupTwins)) { n1 = (tf & GD_TWIN_OFF_NEAR) !== 0; n2 = true; }
      else {
        const td2 = F.lodOrtho ? f(F.orthoD2) : boxDist2F(f(F.cam[0]), f(F.cam[1]), f(F.cam[2]), rec, o);
        const t1 = rec[o + GdRecW.twinDist], t2 = rec[o + GdRecW.twinDist2];
        if (cpu) { n1 = (ctl & GD_CTL_CPU_N1) !== 0; n2 = (ctl & GD_CTL_CPU_N2) !== 0; }
        else {
          if (role !== 4) n1 = t1 > 0 ? !lodHiddenF(td2, f(t1 * f(F.lodScale)), !n1) : (tf & GD_TWIN_OFF_NEAR) !== 0;
          if (role >= 3) n2 = t2 > 0 ? !lodHiddenF(td2, f(t2 * f(F.lodScale)), !n2) : true;
        }
      }
      st = (st & ~(GD_STATE_TWIN_NEAR | GD_STATE_TWIN_NEAR2)) | (n1 ? GD_STATE_TWIN_NEAR : 0) | (n2 ? GD_STATE_TWIN_NEAR2 : 0);
      const draws = role === 1 ? n1 : role === 2 ? !n1 : role === 3 ? (!n1 && n2) : role === 4 ? !n2 : true;
      if (!draws) return { instanceCount: 0, state: st, why: GdWhy.Twin };
    }
  }
  if (F.planes && !noBox && !gdFrustumTest(F.planes, rec, o)) return { instanceCount: 0, state: st, why: GdWhy.Frustum };
  return { instanceCount: count, state: st | GD_STATE_VISIBLE, why: GdWhy.Drawn };
}

// ── Phase C: the shadow-caster rule (CPU mirror of cs_shadow) ───────────────────────────────────────────────────

/** Six-plane box test with the relative epsilon (the WGSL planesTest / viewTest). */
function planes6(pl: ArrayLike<number>, o: number, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, eps: number): boolean {
  for (let i = 0; i < 6; i++) {
    const a = f(pl[o + i * 4]), b = f(pl[o + i * 4 + 1]), c = f(pl[o + i * 4 + 2]), d = f(pl[o + i * 4 + 3]);
    const ax = f(a * (a >= 0 ? hx : lx)), by = f(b * (b >= 0 ? hy : ly)), cz = f(c * (c >= 0 ? hz : lz));
    const sm = f(f(f(ax + by) + cz) + d), mag = f(f(f(Math.abs(ax) + Math.abs(by)) + Math.abs(cz)) + Math.abs(d));
    if (sm < -f(eps * mag)) return false;
  }
  return true;
}

export interface GdShadowResult { mask: number; state: number; leave: number; join: number }

/**
 * CPU MIRROR of cs_shadow for record `i`: the layer mask (bit = GdShLayer) and the new state (static-layer membership),
 * plus the static layers this record leaves / joins (bit 0 far, 1 cascade 0, 2 cascade 1). `state` must already hold
 * this frame's cs_cull result (GD_STATE_SH_ELIG, the held LOD / twin state). The rules are Renderer3D._buildDrawLists'
 * shadow section (meshes and castsInstancedShadow groups) and its HC_NOREACH static push.
 */
export function gdShadowRecord(rec: Float32Array, recU: Uint32Array, ctl: number, state: number, i: number, F: GdFrameParams, S: GdShadowParams): GdShadowResult {
  const o = i * GD_REC_WORDS, eps = GD_FRUSTUM_EPS;
  const flags = recU[o + GdRecW.flags], shf = recU[o + GdRecW.shFlags];
  const group = (flags & GD_FLAG_GROUP) !== 0, noBox = (flags & GD_FLAG_NO_BOX) !== 0;
  let mask = 0, mem = 0;
  const lx = rec[o + GdRecW.minX], ly = rec[o + GdRecW.minY], lz = rec[o + GdRecW.minZ], hx = rec[o + GdRecW.maxX], hy = rec[o + GdRecW.maxY], hz = rec[o + GdRecW.maxZ];
  const on = S.on && (ctl & GD_CTL_ENABLED) !== 0 && (ctl & GD_CTL_FORCED) === 0 && (shf & GD_SHF_CASTS) !== 0 && recU[o + GdRecW.indexCount] > 0 && recU[o + GdRecW.count] > 0;
  if (on) {
    const visited = group || !F.hcOn || (ctl & GD_CTL_VISITED) !== 0;
    const fsz = rec[o + GdRecW.shFeature];
    const farSkip = fsz > 0 && fsz < f(S.lodFar);
    const windDyn = S.wind && (shf & GD_SHF_WIND) !== 0;
    const band = (): boolean => {
      if (!S.band || (flags & (GD_FLAG_NO_FOG | GD_FLAG_NO_BOX))) return false;
      if (!((flags & GD_FLAG_FOG_OTHER) || ((flags & GD_FLAG_FOG_ATTACH) && S.bandAttach))) return false;
      const e = F.fogEye;
      const dx = Math.max(Math.abs(e[0] - lx), Math.abs(e[0] - hx)), dy = Math.max(Math.abs(e[1] - ly), Math.abs(e[1] - hy)), dz = Math.max(Math.abs(e[2] - lz), Math.abs(e[2] - hz));
      return dx * dx + dy * dy + dz * dz >= S.bandIn * S.bandIn;
    };
    const casc = (ci: number): boolean => noBox || !S.casc[ci] || planes6(S.casc[ci]!, 0, lx, ly, lz, hx, hy, hz, eps);
    const lodC = (ci: number) => f(ci === 1 ? S.lodC1 : S.lodC0);
    const IN = (k: number) => (state & (GD_STATE_IN_FAR << k)) !== 0;
    if (visited && (state & GD_STATE_SH_ELIG)) {
      const inLight = !S.light || noBox || planes6(S.light, 0, lx, ly, lz, hx, hy, hz, eps);
      if (inLight) {
        let reachOk = true;
        if (S.reach && !noBox && F.planes) {
          const d = S.ldir;
          if (d[1] < -0.05 && Number.isFinite(S.floorY)) {
            const len = Math.max(0, hy - S.floorY) / -d[1], ex = d[0] * len, ey = d[1] * len, ez = d[2] * len;
            reachOk = planes6(F.planes, 0, Math.min(lx, lx + ex), Math.min(ly, ly + ey), Math.min(lz, lz + ez), Math.max(hx, hx + ex), Math.max(hy, hy + ey), Math.max(hz, hz + ez), eps);
          }
        }
        let dyn = windDyn || band();
        if (!group && (ctl & GD_CTL_DYNAMIC)) dyn = true;
        const farStatic = (): void => {
          if (dyn) { if (reachOk) mask |= 1 << GdShLayer.farDyn; }
          else { mem |= GD_STATE_MEM_FAR; mask |= 1 << GdShLayer.farStatic; if (S.join && reachOk && !IN(0)) mask |= 1 << GdShLayer.farDyn; }
        };
        const cStatic = (ci: number): void => {
          mem |= GD_STATE_MEM_C0 << ci; mask |= 1 << (GdShLayer.c0 + ci * 2);
          if (S.join && reachOk && !IN(1 + ci)) mask |= 1 << (GdShLayer.c0Dyn + ci * 2);
        };
        if (!group) {
          if (!farSkip) { if (reachOk) mask |= 1 << GdShLayer.direct; if (S.cache) farStatic(); }
          for (let ci = 0; ci < S.cascades; ci++) {
            if (!(S.split || reachOk)) continue;
            if (fsz > 0 && fsz < lodC(ci)) continue;
            if (!casc(ci)) continue;
            if (S.split) { if (dyn) { if (reachOk) mask |= 1 << (GdShLayer.c0Dyn + ci * 2); } else cStatic(ci); }
            else mask |= 1 << (GdShLayer.c0 + ci * 2);
          }
        } else {
          let groupCasc = false;
          if (farSkip) {
            if (S.split) groupCasc = true;
            else if (reachOk) for (let ci = 0; ci < S.cascades; ci++) { if (fsz < lodC(ci)) continue; if (!casc(ci)) continue; mask |= 1 << (GdShLayer.c0 + ci * 2); }
          } else {
            if (reachOk) {
              mask |= 1 << GdShLayer.direct;
              if (!S.split) for (let ci = 0; ci < S.cascades; ci++) { if (fsz > 0 && fsz < lodC(ci)) continue; if (casc(ci)) mask |= 1 << (GdShLayer.c0 + ci * 2); }
            }
            if (S.cache) farStatic();
            if (S.split) groupCasc = true;
          }
          if (groupCasc && !(dyn && !reachOk)) {
            for (let ci = 0; ci < S.cascades; ci++) {
              if (fsz > 0 && fsz < lodC(ci)) continue;
              if (!casc(ci)) continue;
              if (dyn) mask |= 1 << (GdShLayer.c0Dyn + ci * 2); else cStatic(ci);
            }
          }
        }
      }
    } else if (!visited && (ctl & GD_CTL_NOREACH) && S.cache) {
      // the CPU's HC_NOREACH push: held LOD / twin state, a fresh fog test, fine enough for the far map, static
      const role = recU[o + GdRecW.twinRole];
      const n1 = (state & GD_STATE_TWIN_NEAR) !== 0, n2 = (state & GD_STATE_TWIN_NEAR2) !== 0;
      const twinOk = role === 1 ? n1 : role === 2 ? !n1 : role === 3 ? (!n1 && n2) : role === 4 ? !n2 : true;
      const fogged = !noBox && !(flags & GD_FLAG_NO_FOG) && ((((flags & GD_FLAG_FOG_OTHER) && F.fogCullOther) || ((flags & GD_FLAG_FOG_ATTACH) && F.fogCullAttach)) && Number.isFinite(F.fogCull2))
        && boxDist2F(f(F.fogEye[0]), f(F.fogEye[1]), f(F.fogEye[2]), rec, o) > f(F.fogCull2);
      const dyn = windDyn || band() || (ctl & GD_CTL_DYNAMIC) !== 0;
      if (!(state & GD_STATE_LOD_HIDDEN) && twinOk && !fogged && !farSkip && !dyn) { mem |= GD_STATE_MEM_FAR; mask |= 1 << GdShLayer.farStatic; }
    }
  }
  let leave = 0, join = 0;
  for (let k = 0; k < 3; k++) {
    const isIn = (state & (GD_STATE_IN_FAR << k)) !== 0, isMem = (mem & (GD_STATE_MEM_FAR << k)) !== 0;
    if (isIn && !isMem) leave |= 1 << k;
    if (isMem && !isIn) join |= 1 << k;
  }
  const st = (state & ~(GD_STATE_MEM_FAR | GD_STATE_MEM_C0 | GD_STATE_MEM_C1)) | mem;
  return { mask, state: st, leave, join };
}

// ── Phase C: compacted dynamic shadow layers (the zero-draw cost of the shadow passes) ──────────────────────────────
/**
 * The per-frame DYNAMIC shadow layers (far dynamic, cascade 0 / 1 dynamic: GD_SH_COMPACT_LAYERS) are sparse: a few
 * hundred nonzero blocks of ~15 k records in the tiled city, and every zero-instance indirect draw still costs GPU
 * front-end time. With GD_SH_COMPACT, cs_shadow also APPENDS each nonzero block of those layers to a compact list per
 * layer (the slot from an atomic counter, stats[GdStat.shCompact + j]). A depth-only pass keeps the per-texel minimum
 * whatever the draw order, so the compact list writes the same texels. WebGPU needs the draw count on the CPU: the
 * bundle draws K slots, K = gdCompactSize of a CPU UPPER BOUND of the layer's nonzero blocks (gdShadowDynMaybe per
 * record), and the slots past the GPU's count are cleared to zero draws every frame.
 */
export const GD_SH_COMPACT_LAYERS = [GdShLayer.farDyn, GdShLayer.c0Dyn, GdShLayer.c1Dyn] as const;
/** The smallest compact draw count (counts are rounded up to powers of two from here: a few cached bundles per layer). */
export const GD_SH_COMPACT_MIN = 32;
/** The draw count of a compact bundle for `n` possible blocks (0 = none), at most the list's capacity `cap` (>= n). */
export function gdCompactSize(n: number, cap: number): number {
  if (n <= 0) return 0;
  let k = GD_SH_COMPACT_MIN;
  while (k < n) k *= 2;
  return Math.min(k, Math.max(n, cap));
}
/** The cached form of the bound (the control pass) still runs the camera-dependent shadow-reach test on the records
 *  that reach it (~2 k a frame in the tiled street). Without it the bound was 3-5x the GPU's count (K 1024-4096 for
 *  200-900 casters); with it the bound is about the count. A/B: setGdBoundReach(false) (sm.setGpuDriven3D boundReach). */
export let gdBoundReach = true;
export function setGdBoundReach(on: boolean): void { gdBoundReach = on; }
/** The relative plane margin of the bound's box tests: the GPU's f32 test (GD_FRUSTUM_EPS) never keeps a box this
 *  (f64) test rejects (f32 rounding of the coefficients and sums is ~1e-6 of the magnitude). */
const GD_BOUND_EPS = 1e-4;
function planes6Loose(pl: ArrayLike<number>, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number): boolean {
  for (let i = 0; i < 6; i++) {
    const a = pl[i * 4], b = pl[i * 4 + 1], c = pl[i * 4 + 2], d = pl[i * 4 + 3];
    const ax = a * (a >= 0 ? hx : lx), by = b * (b >= 0 ? hy : ly), cz = c * (c >= 0 ? hz : lz);
    if (ax + by + cz + d < -GD_BOUND_EPS * (Math.abs(ax) + Math.abs(by) + Math.abs(cz) + Math.abs(d))) return false;
  }
  return true;
}
/** Record `i`'s box is certainly outside `planes` by the bound's loose test (false without a box): cached per record
 *  by the caller while the far light box holds, so the bound skips the many visited records outside it cheaply. */
export function gdBoxOutsideLoose(rec: Float32Array, recU: Uint32Array, i: number, planes: ArrayLike<number>): boolean {
  const o = i * GD_REC_WORDS;
  if (recU[o + GdRecW.flags] & GD_FLAG_NO_BOX) return false;
  return !planes6Loose(planes, rec[o + GdRecW.minX], rec[o + GdRecW.minY], rec[o + GdRecW.minZ], rec[o + GdRecW.maxX], rec[o + GdRecW.maxY], rec[o + GdRecW.maxZ]);
}
/**
 * CPU UPPER BOUND of record `i`'s compacted dynamic shadow blocks this frame: bit j = it MAY be nonzero in compact
 * layer j (0 far dynamic, 1 cascade 0 dynamic, 2 cascade 1 dynamic). A superset of gdShadowRecord's (cs_shadow's)
 * dynamic bits for any GPU-side state, given `knownIn` (bit k = the record is certainly drawn into static layer k:
 * GD_STATE_IN_FAR << k, from a read-back snapshot) — no bit may be set there that the GPU state lacks. Only facts the
 * CPU has this frame: the control word (enabled, forced, visited, the CPU's dynamic hold, its LOD / twin verdict), the
 * record (caster flags, shadow LOD, fog class, box) and loosened light-box / reach / cascade tests. The GPU-only facts
 * (fog horizon, SH_ELIG beyond the CPU's LOD / twin verdict, static membership) are assumed either way.
 */
export function gdShadowDynMaybe(rec: Float32Array, recU: Uint32Array, ctl: number, i: number, F: GdFrameParams, S: GdShadowParams, knownIn: number,
                                 /** The caller's cached box verdicts (gdBoxOutsideLoose): it found the record inside (or without) the
                                  *  far light box, and outside the cascades in `excl` (bit 1 cascade 0, bit 2 cascade 1). The box
                                  *  tests are then skipped, and so is the camera-dependent reach test (a looser, cheaper bound). */
                                 cached = false, excl = 0): number {
  if (!S.on || !(ctl & GD_CTL_ENABLED) || (ctl & GD_CTL_FORCED)) return 0;
  const o = i * GD_REC_WORDS;
  const shf = recU[o + GdRecW.shFlags], flags = recU[o + GdRecW.flags];
  if (!(shf & GD_SHF_CASTS) || recU[o + GdRecW.indexCount] === 0 || recU[o + GdRecW.count] === 0) return 0;
  const group = (flags & GD_FLAG_GROUP) !== 0, noBox = (flags & GD_FLAG_NO_BOX) !== 0;
  if (!group && F.hcOn && !(ctl & GD_CTL_VISITED)) return 0;   // a rejected cluster member: at most the far STATIC layer
  // certainly not SH_ELIG: the CPU's LOD / twin verdict, which the cull takes as is (GD_FRAME_CPU_STATE)
  if (F.cpuState) {
    const role = recU[o + GdRecW.twinRole], tf = recU[o + GdRecW.twinFlags];
    if (group && (role === 1 || role === 2)) {
      const near = F.groupTwins && F.lodOn && rec[o + GdRecW.twinDist] > 0 && !(tf & GD_TWIN_NO_ORIGIN) ? (ctl & GD_CTL_CPU_N1) !== 0 : true;
      if ((role === 1) !== near) return 0;
    }
    if (F.lodOn && rec[o + GdRecW.drawDistance] > 0 && !noBox && (ctl & GD_CTL_CPU_LOD)) return 0;
    if (!group && role !== 0) {
      let n1: boolean, n2: boolean;
      if (!F.lodOn || noBox || ((tf & GD_TWIN_INSTANCED) && !F.groupTwins)) { n1 = (tf & GD_TWIN_OFF_NEAR) !== 0; n2 = true; }
      else { n1 = (ctl & GD_CTL_CPU_N1) !== 0; n2 = (ctl & GD_CTL_CPU_N2) !== 0; }
      const draws = role === 1 ? n1 : role === 2 ? !n1 : role === 3 ? (!n1 && n2) : role === 4 ? !n2 : true;
      if (!draws) return 0;
    }
  }
  const lx = rec[o + GdRecW.minX], ly = rec[o + GdRecW.minY], lz = rec[o + GdRecW.minZ], hx = rec[o + GdRecW.maxX], hy = rec[o + GdRecW.maxY], hz = rec[o + GdRecW.maxZ];
  const fsz = rec[o + GdRecW.shFeature];
  let dyn = (S.wind && (shf & GD_SHF_WIND) !== 0) || (ctl & GD_CTL_DYNAMIC) !== 0;
  if (!dyn && S.band && !(flags & (GD_FLAG_NO_FOG | GD_FLAG_NO_BOX)) && ((flags & GD_FLAG_FOG_OTHER) || ((flags & GD_FLAG_FOG_ATTACH) && S.bandAttach))) {
    // the fade band: the box's farthest corner from the fog eye at the band's inner distance, with an absolute slack
    // for the GPU's f32 subtraction at city coordinates
    const e = F.fogEye;
    const dx = Math.max(Math.abs(e[0] - lx), Math.abs(e[0] - hx)), dy = Math.max(Math.abs(e[1] - ly), Math.abs(e[1] - hy)), dz = Math.max(Math.abs(e[2] - lz), Math.abs(e[2] - hz));
    const mag = Math.max(Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2]), Math.abs(lx), Math.abs(hx), Math.abs(ly), Math.abs(hy), Math.abs(lz), Math.abs(hz));
    dyn = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-5 * mag + 1e-3 >= S.bandIn;
  }
  let m = 0;
  if (S.cache && !(fsz > 0 && fsz < f(S.lodFar)) && (dyn || (S.join && !(knownIn & 1)))) m |= 1;
  const nC = Math.max(0, Math.min(2, S.cascades));
  if (S.split) for (let ci = 0; ci < nC; ci++) {
    if (fsz > 0 && fsz < f(ci === 1 ? S.lodC1 : S.lodC0)) continue;
    if (dyn || (S.join && !(knownIn & (2 << ci)))) m |= 2 << ci;
  }
  if (cached) m &= ~excl;
  if (m === 0 || noBox) return m;
  // every dynamic block needs the far light box and the shadow reach (cs_shadow), a cascade's its box
  if (!cached && S.light && !planes6Loose(S.light, lx, ly, lz, hx, hy, hz)) return 0;
  if (S.reach && F.planes && (!cached || gdBoundReach)) {
    const d = S.ldir;
    if (d[1] < -0.05 - 1e-4 && Number.isFinite(S.floorY) && S.floorY < 1e36) {
      const len = Math.max(0, hy - S.floorY) / -d[1], ex = d[0] * len, ey = d[1] * len, ez = d[2] * len;
      if (!planes6Loose(F.planes, Math.min(lx, lx + ex), Math.min(ly, ly + ey), Math.min(lz, lz + ez), Math.max(hx, hx + ex), Math.max(hy, hy + ey), Math.max(hz, hz + ez))) return 0;
    }
  }
  if (cached) return m;
  for (let ci = 0; ci < nC; ci++) { const pl = S.casc[ci]; if ((m & (2 << ci)) && pl && !planes6Loose(pl, lx, ly, lz, hx, hy, hz)) m &= ~(2 << ci); }
  return m;
}

// ── P11 cull ranges on the GPU (Phase B) ─────────────────────────────────────────────────────────────────────────
/** Argument blocks a ranged record owns in the draw order: its kept index spans (adjacent kept runs merged, short gaps
 *  bridged as on the CPU); a frame needing more merges the rest into the last block (a superset: still bit-identical,
 *  the extra runs lie wholly outside a clip plane). Measured (tiled city): 97 % of ranged draws need at most 4 spans. */
export const GD_RANGE_SPANS = 4;
/** Runs a job can test (its workgroup bitmask, 32 per word); a bigger table draws whole. */
export const GD_RANGE_MAX_WORDS = 1024;
export const GD_RANGE_MAX_RUNS = GD_RANGE_MAX_WORDS * 32;
/** One range job (GdRangeJob in the WGSL, 8 x u32): the ranged record, where its boxes start in the box pool (in
 *  floats: blocks first, then runs, 6 floats each), its run / block counts, indices per run, the mesh's index count. */
export const GD_JOB_WORDS = 8;
export const GdJobW = { rec: 0, boxBase: 1, nRuns: 2, blockRuns: 3, runIdx: 4, totalIdx: 5, pad0: 6, pad1: 7 } as const;
/** Workgroup size of the range jobs (one workgroup per job). */
export const GD_RANGE_WORKGROUP = 64;

/** The float layout a job's boxes take in the pool (blocks, then runs). */
export function gdRangeBoxFloats(nRuns: number, blockRuns: number): number { return (Math.ceil(nRuns / blockRuns) + nRuns) * 6; }
/** Write a run table's boxes into the pool at `off` (floats). */
export function packGdRangeBoxes(pool: Float32Array, off: number, rg: { n: number; blockRuns: number; box: ArrayLike<number>; blockBox: ArrayLike<number> }): void {
  const nb = Math.ceil(rg.n / rg.blockRuns);
  for (let k = 0; k < nb * 6; k++) pool[off + k] = rg.blockBox[k];
  for (let k = 0; k < rg.n * 6; k++) pool[off + nb * 6 + k] = rg.box[k];
}

/** Frustum test of one pooled box (the WGSL boxTest: positive vertex, relative epsilon). */
function poolBoxTest(planes: ArrayLike<number>, b: Float32Array, o: number, eps: number): boolean {
  for (let i = 0; i < 6; i++) {
    const a = f(planes[i * 4]), bb = f(planes[i * 4 + 1]), c = f(planes[i * 4 + 2]), d = f(planes[i * 4 + 3]);
    const ax = f(a * (a >= 0 ? b[o + 3] : b[o])), by = f(bb * (bb >= 0 ? b[o + 4] : b[o + 1])), cz = f(c * (c >= 0 ? b[o + 5] : b[o + 2]));
    const sm = f(f(f(ax + by) + cz) + d), mag = f(f(f(Math.abs(ax) + Math.abs(by)) + Math.abs(cz)) + Math.abs(d));
    if (sm < -f(eps * mag)) return false;
  }
  return true;
}
/** Wholly inside every plane (the negative vertex inside). */
function poolBoxInside(planes: ArrayLike<number>, b: Float32Array, o: number): boolean {
  for (let i = 0; i < 6; i++) {
    const a = f(planes[i * 4]), bb = f(planes[i * 4 + 1]), c = f(planes[i * 4 + 2]), d = f(planes[i * 4 + 3]);
    const sm = f(f(f(f(a * (a >= 0 ? b[o] : b[o + 3])) + f(bb * (bb >= 0 ? b[o + 1] : b[o + 4]))) + f(c * (c >= 0 ? b[o + 2] : b[o + 5]))) + d);
    if (sm < 0) return false;
  }
  return true;
}

/**
 * CPU MIRROR of the WGSL range job: the index spans (relative to the mesh's first index) a ranged record draws, as
 * (first, count) pairs, at most GD_RANGE_SPANS of them (the last one absorbs any overflow). The run selection is
 * selectRanges' (cull-ranges.ts): a block outside drops its runs, a block wholly inside keeps them untested, else each
 * run's box is tested; kept runs separated by at most `mergeGap` dropped runs merge. The GPU's f32 epsilon test keeps
 * every run the CPU keeps (a superset only within float rounding of a plane).
 */
export function gdRangeSpans(planes: ArrayLike<number>, pool: Float32Array, boxBase: number, nRuns: number, blockRuns: number, runIdx: number,
                             totalIdx: number, mergeGap: number, eps = GD_FRUSTUM_EPS, maxSpans = GD_RANGE_SPANS): number[] {
  const nb = Math.ceil(nRuns / blockRuns), keep = new Uint8Array(nRuns);
  for (let b = 0; b < nb; b++) {
    const bo = boxBase + b * 6, r0 = b * blockRuns, r1 = Math.min(nRuns, r0 + blockRuns);
    if (!poolBoxTest(planes, pool, bo, eps)) continue;
    if (poolBoxInside(planes, pool, bo)) { for (let i = r0; i < r1; i++) keep[i] = 1; continue; }
    for (let i = r0; i < r1; i++) if (poolBoxTest(planes, pool, boxBase + nb * 6 + i * 6, eps)) keep[i] = 1;
  }
  // pass 1: the gaps between the merged spans; keep the (maxSpans - 1) LARGEST (earliest wins a tie): splitting only
  // there leaves out the most dropped runs any maxSpans spans can (the rest of the gaps are drawn: clipped anyway)
  const top = maxSpans - 1, gg = new Array<number>(top).fill(0), gi = new Array<number>(top).fill(-1);
  let last = -1;
  for (let i = 0; i < nRuns; i++) {
    if (!keep[i]) continue;
    const g = last >= 0 ? i - last - 1 : 0;
    if (last >= 0 && g > mergeGap && top > 0 && g > gg[top - 1]) {
      let k = top - 1;
      while (k > 0 && g > gg[k - 1]) { gg[k] = gg[k - 1]; gi[k] = gi[k - 1]; k--; }
      gg[k] = g; gi[k] = i;
    }
    last = i;
  }
  // pass 2: the spans, split at those gaps only
  const out: number[] = [];
  let open = -1, end = 0;
  last = -1;
  for (let i = 0; i < nRuns; i++) {
    if (!keep[i]) continue;
    const s0 = i * runIdx, e0 = Math.min(totalIdx, s0 + runIdx);
    const split = open < 0 || (i - last - 1 > mergeGap && gi.includes(i));
    if (!split) end = e0;
    else { if (open >= 0) out.push(open, end - open); open = s0; end = e0; }
    last = i;
  }
  if (open >= 0) out.push(open, end - open);
  return out;
}

// ── Record packing ───────────────────────────────────────────────────────────────────────────────────────────────

export interface GdRecordFields {
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null;
  drawDistance: number; drawDistanceBias: number;
  indexCount: number; firstIndex: number; baseVertex: number; firstInstance: number;
  count: number; flags: number;
  /** Twins (optional): role 0..4, the swap distances, GD_TWIN_* flags, a group twin's origin box. */
  twinRole?: number; twinDist?: number; twinDist2?: number; twinFlags?: number;
  origin?: ArrayLike<number> | null;
  /** Phase C (optional): the shadow feature size and GD_SHF_* flags. */
  shFeature?: number; shFlags?: number;
}

/** Write one record's fields (the flags' NO_BOX bit follows `box`). */
export function packGdRecord(rec: Float32Array, recU: Uint32Array, recI: Int32Array, i: number, r: GdRecordFields): void {
  const o = i * GD_REC_WORDS;
  const b = r.box;
  rec[o + GdRecW.minX] = b ? b.minX : 0; rec[o + GdRecW.minY] = b ? b.minY : 0; rec[o + GdRecW.minZ] = b ? b.minZ : 0;
  rec[o + GdRecW.maxX] = b ? b.maxX : 0; rec[o + GdRecW.maxY] = b ? b.maxY : 0; rec[o + GdRecW.maxZ] = b ? b.maxZ : 0;
  rec[o + GdRecW.drawDistance] = r.drawDistance > 0 ? r.drawDistance : 0;
  rec[o + GdRecW.drawDistanceBias] = r.drawDistanceBias;
  recU[o + GdRecW.indexCount] = r.indexCount >>> 0; recU[o + GdRecW.firstIndex] = r.firstIndex >>> 0;
  recI[o + GdRecW.baseVertex] = r.baseVertex | 0; recU[o + GdRecW.firstInstance] = r.firstInstance >>> 0;
  recU[o + GdRecW.count] = r.count >>> 0;
  recU[o + GdRecW.flags] = (r.flags & ~GD_FLAG_NO_BOX) | (b ? 0 : GD_FLAG_NO_BOX);
  recU[o + GdRecW.tris] = Math.min(0xffffffff, Math.floor(r.indexCount / 3) * r.count) >>> 0;
  recU[o + GdRecW.twinRole] = r.twinRole ?? 0;
  rec[o + GdRecW.twinDist] = r.twinDist ?? 0; rec[o + GdRecW.twinDist2] = r.twinDist2 ?? 0;
  const og = r.origin;
  recU[o + GdRecW.twinFlags] = ((r.twinFlags ?? 0) & ~GD_TWIN_NO_ORIGIN) | (og ? 0 : GD_TWIN_NO_ORIGIN);
  rec[o + GdRecW.oMinX] = og ? og[0] : 0; rec[o + GdRecW.oMinY] = og ? og[1] : 0; rec[o + GdRecW.oMinZ] = og ? og[2] : 0;
  rec[o + GdRecW.oMaxX] = og ? og[3] : 0; rec[o + GdRecW.oMaxY] = og ? og[4] : 0; rec[o + GdRecW.oMaxZ] = og ? og[5] : 0;
  rec[o + GdRecW.shFeature] = r.shFeature && r.shFeature > 0 ? r.shFeature : 0;
  recU[o + GdRecW.shFlags] = (r.shFlags ?? 0) >>> 0;
}

/** Mesh fog-class flags as the CPU loop reads them (fogClass 2 / 1, material.noFog). */
export function gdFogFlags(fogClass: number, noFog: boolean): number {
  return (fogClass === 2 ? GD_FLAG_FOG_OTHER : fogClass === 1 ? GD_FLAG_FOG_ATTACH : 0) | (noFog ? GD_FLAG_NO_FOG : 0);
}

// ── Dirty ranges (coalesced uploads) ────────────────────────────────────────────────────────────────────────────

/** Tracks dirty element indices and merges them into upload runs (gaps < `gap` elements are bridged). */
export class GdDirtyRanges {
  private _idx: number[] = [];
  private _all = false;
  mark(i: number): void { if (!this._all) this._idx.push(i); }
  markAll(): void { this._all = true; this._idx.length = 0; }
  get any(): boolean { return this._all || this._idx.length > 0; }
  get all(): boolean { return this._all; }
  /** [start, count] pairs over 0..n-1, sorted and merged; clears the set. */
  take(n: number, gap = 64): number[] {
    const out: number[] = [];
    if (this._all) { this._all = false; this._idx.length = 0; if (n > 0) out.push(0, n); return out; }
    const a = this._idx;
    if (a.length === 0) return out;
    a.sort((x, y) => x - y);
    let lo = a[0], hi = a[0];
    for (let k = 1; k < a.length; k++) {
      const v = a[k];
      if (v >= n) break;
      if (v > hi + gap) { out.push(lo, hi - lo + 1); lo = v; }
      if (v > hi) hi = v;
    }
    if (lo < n) out.push(lo, Math.min(hi, n - 1) - lo + 1);
    a.length = 0;
    return out;
  }
}

// ── Draw buckets (runs of identical pipeline state in draw order) ───────────────────────────────────────────────

/** The pipeline / bind-group state a run of records draws with. Compared by identity each frame: a change means
 *  the bundle must be re-recorded (a pipeline finished compiling, a bind group was rebuilt, the pool grew). */
export interface GdBucketRefs {
  pipeline: unknown; bg0: unknown; bg1: unknown; bg2: unknown; vb: unknown; ib: unknown;
}

export interface GdBucket extends GdBucketRefs {
  /** The state code shared by the bucket's records (see Renderer3D._gdStateCode). */
  code: number;
  /** The record whose mesh resolves textured bind groups (a non-atlas textured bucket holds one texture pair). */
  leadRec: number;
  /** Position range [start, end) in the draw order. */
  start: number; end: number;
  /** Its argument-block range [posStart, posEnd) (gpu-scene.ts: a ranged record owns several blocks). */
  posStart?: number; posEnd?: number;
}

/**
 * Split a draw order into buckets: a new bucket starts when the state code changes, or (non-atlas textured codes)
 * when the record's texture identity changes. `codeOf(rec)` / `texOf(rec)` read the per-record state; `texOf` is only
 * consulted for codes with `GD_CODE_TEXTURED` and without `GD_CODE_ATLAS`.
 */
export const GD_CODE_TEXTURED = 1;
export const GD_CODE_NOCULL = 2;
export const GD_CODE_PATTERNED = 4;
export const GD_CODE_ATLAS = 8;
export const GD_CODE_VB_OVERRIDE = 16;
/** P22: the record's geometry is stored PACKED (32-byte vertices, 16-bit indices: vertex-pack.ts) — its bucket draws
 *  with the pipeline's packed twin, the tangent buffer in slot 1 and a uint16 index buffer. Above the shader-variant
 *  id bits (5+, ≤ 128 ids); read the variant id as `(code >> 5) & GD_CODE_VARIANT_MASK`. */
export const GD_CODE_PACKED = 1 << 20;
export const GD_CODE_VARIANT_MASK = 0x7fff;

export function gdBuckets(order: ArrayLike<number>, codeOf: (rec: number) => number, texOf: (rec: number) => unknown, vbOf: (rec: number) => unknown): GdBucket[] {
  const out: GdBucket[] = [];
  let cur: GdBucket | null = null, curTex: unknown = null, curVb: unknown = null;
  for (let p = 0; p < order.length; p++) {
    const r = order[p], code = codeOf(r);
    const texKeyed = (code & GD_CODE_TEXTURED) !== 0 && (code & GD_CODE_ATLAS) === 0;
    const tex = texKeyed ? texOf(r) : null;
    const vb = (code & GD_CODE_VB_OVERRIDE) ? vbOf(r) : null;
    if (cur === null || cur.code !== code || (texKeyed && tex !== curTex) || vb !== curVb) {
      if (cur) cur.end = p;
      cur = { code, leadRec: r, start: p, end: p + 1, pipeline: null, bg0: null, bg1: null, bg2: null, vb: null, ib: null };
      out.push(cur); curTex = tex; curVb = vb;
    }
  }
  if (cur) cur.end = order.length;
  return out;
}

/** True when any bucket's freshly resolved refs differ from the ones its bundle was recorded with. */
export function gdBucketsChanged(buckets: readonly GdBucket[], resolve: (b: GdBucket, out: GdBucketRefs) => void, scratch: GdBucketRefs): boolean {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    resolve(b, scratch);
    if (scratch.pipeline !== b.pipeline || scratch.bg0 !== b.bg0 || scratch.bg1 !== b.bg1 || scratch.bg2 !== b.bg2 || scratch.vb !== b.vb || scratch.ib !== b.ib) return true;
  }
  return false;
}

/** The commands a bundle records for `buckets` (pure: what gpu-scene.ts encodes). Draws of a bucket whose pipeline
 *  is still compiling are left out, exactly as the CPU path skips them (`_setPipe` → `_skipDraws`). */
export type GdCmd =
  | { op: 'pipe'; ref: unknown }
  | { op: 'bg'; index: number; ref: unknown }
  | { op: 'vb'; ref: unknown }
  | { op: 'ib'; ref: unknown }
  | { op: 'draw'; rec: number };

export function gdBundleCommands(order: ArrayLike<number>, buckets: readonly GdBucket[]): { cmds: GdCmd[]; skipped: number } {
  const cmds: GdCmd[] = [];
  let skipped = 0, vb: unknown = undefined, ib: unknown = undefined;
  for (const b of buckets) {
    if (!b.pipeline) { skipped += b.end - b.start; continue; }
    if (b.ib !== ib) { cmds.push({ op: 'ib', ref: b.ib }); ib = b.ib; }
    if (b.vb !== vb) { cmds.push({ op: 'vb', ref: b.vb }); vb = b.vb; }
    cmds.push({ op: 'pipe', ref: b.pipeline });
    cmds.push({ op: 'bg', index: 0, ref: b.bg0 });
    if (b.bg1) cmds.push({ op: 'bg', index: 1, ref: b.bg1 });
    if (b.bg2) cmds.push({ op: 'bg', index: 2, ref: b.bg2 });
    for (let p = b.start; p < b.end; p++) cmds.push({ op: 'draw', rec: order[p] });
  }
  return { cmds, skipped };
}

// ── Record slot allocation (stable record indices; the draw order is separate) ─────────────────────────────────

/** Free-list allocator of record indices: a record keeps its index while its object lives, so a structure change
 *  re-records the bundle (the order) without rewriting surviving records. */
export class GdRecordSlots {
  private _free: number[] = [];
  private _high = 0;
  get high(): number { return this._high; }
  alloc(): number { return this._free.length ? this._free.pop()! : this._high++; }
  free(i: number): void { this._free.push(i); }
  reset(): void { this._free.length = 0; this._high = 0; }
  get freeCount(): number { return this._free.length; }
}

// ── Sub-bundle omission (zero-draw cost, performance-plan §P15 "Remaining") ──────────────────────────────────────
//
// Every record is one drawIndexedIndirect, culled ones included (instanceCount 0), and on D3D12 each costs ~0.3 µs of
// GPU front-end time. The main bundle is split into SUB-BUNDLES: runs of the draw order whose records share a
// spatial cell of the draw rank (Renderer3D.rankCellM). Each frame the CPU leaves out a sub-bundle when every record
// in it is SURELY drawn with 0 instances (gdSkippable, from the control word the CPU writes anyway) or when the union
// of its records' boxes lies outside the camera frustum by a safe margin (gdBoxOutside). Both tests are conservative
// against the GPU cull (gdCullRecord / cs_cull), so the omitted draws are a subset of the zero draws and the image
// is the full replay's image.

/**
 * True when the cull SURELY draws record `i` with 0 instances this frame, judged from the control word and the
 * record alone (no distance math): disabled, forced hidden, no geometry, a mesh in a cluster the hierarchical cull
 * rejected, and (with the CPU's LOD / twin state, F.cpuState) LOD-hidden or the inactive twin. False = it may draw
 * (the frustum, fog and range tests are the GPU's). Mirrors gdCullRecordInner's early returns.
 */
export function gdSkippable(rec: Float32Array, recU: Uint32Array, ctl: number, i: number, F: GdFrameParams): boolean {
  if (!(ctl & GD_CTL_ENABLED)) return true;
  const o = i * GD_REC_WORDS;
  if (recU[o + GdRecW.indexCount] === 0 || recU[o + GdRecW.count] === 0) return true;
  if (ctl & GD_CTL_FORCED) return (ctl & GD_CTL_FORCED_VIS) === 0;
  const flags = recU[o + GdRecW.flags];
  const group = (flags & GD_FLAG_GROUP) !== 0;
  if (!group && F.hcOn && !(ctl & GD_CTL_VISITED)) return true;
  if (!F.cpuState) return false;
  const noBox = (flags & GD_FLAG_NO_BOX) !== 0;
  const role = recU[o + GdRecW.twinRole], tf = recU[o + GdRecW.twinFlags];
  if (group && (role === 1 || role === 2)) {
    let near = true;
    if (F.groupTwins && F.lodOn && rec[o + GdRecW.twinDist] > 0 && !(tf & GD_TWIN_NO_ORIGIN)) near = (ctl & GD_CTL_CPU_N1) !== 0;
    if ((role === 1) !== near) return true;
  }
  if (F.lodOn && rec[o + GdRecW.drawDistance] > 0 && !noBox && (ctl & GD_CTL_CPU_LOD)) return true;
  if (!group && role !== 0) {
    let n1: boolean, n2: boolean;
    if (!F.lodOn || noBox || ((tf & GD_TWIN_INSTANCED) && !F.groupTwins)) { n1 = (tf & GD_TWIN_OFF_NEAR) !== 0; n2 = true; }
    else { n1 = (ctl & GD_CTL_CPU_N1) !== 0; n2 = (ctl & GD_CTL_CPU_N2) !== 0; }
    const draws = role === 1 ? n1 : role === 2 ? !n1 : role === 3 ? (!n1 && n2) : role === 4 ? !n2 : true;
    if (!draws) return true;
  }
  return false;
}

/** Relative margin of the sub-bundle frustum test (25x the GPU's GD_FRUSTUM_EPS), plus an absolute floor. */
export const GD_SUB_EPS = 1e-4;

/**
 * True when the box (minX, minY, minZ, maxX, maxY, maxZ at `o` in `b`) lies outside one of the 6 planes by more than
 * GD_SUB_EPS x its magnitude (taken over the box's largest absolute coordinates, so it bounds every member box's
 * own magnitude). A box outside a plane has every sub-box outside it (the positive-vertex test is monotone), and
 * the margin covers the GPU test's f32 rounding and relative epsilon: the GPU culls every member.
 */
export function gdBoxOutside(planes: ArrayLike<number>, b: ArrayLike<number>, o = 0): boolean {
  const x0 = b[o], y0 = b[o + 1], z0 = b[o + 2], x1 = b[o + 3], y1 = b[o + 4], z1 = b[o + 5];
  if (!(x1 >= x0 && y1 >= y0 && z1 >= z0)) return false;   // empty / NaN: never omit
  const mx = Math.max(Math.abs(x0), Math.abs(x1)), my = Math.max(Math.abs(y0), Math.abs(y1)), mz = Math.max(Math.abs(z0), Math.abs(z1));
  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4], bb = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
    const s = a * (a >= 0 ? x1 : x0) + bb * (bb >= 0 ? y1 : y0) + c * (c >= 0 ? z1 : z0) + d;
    const mag = Math.abs(a) * mx + Math.abs(bb) * my + Math.abs(c) * mz + Math.abs(d);
    if (s < -(GD_SUB_EPS * mag + 1e-6)) return true;
  }
  return false;
}

/** A sub-bundle: draw-order positions [start, end). */
export interface GdSegment { start: number; end: number }

/**
 * Split a draw order of `n` positions into segments at every change of `keyOf(p)` (the record's rank cell), then
 * merge each segment shorter than `minLen` into the next one (the last into the previous), so tiny runs do not pay
 * a sub-bundle's state setup for little omission.
 */
export function gdSegments(n: number, keyOf: (p: number) => number, minLen: number): GdSegment[] {
  const out: GdSegment[] = [];
  let s = 0;
  for (let p = 1; p <= n; p++) {
    if (p === n || keyOf(p) !== keyOf(s)) { out.push({ start: s, end: p }); s = p; }
  }
  if (minLen <= 1 || out.length < 2) return out;
  const merged: GdSegment[] = [];
  let cur: GdSegment | null = null;
  for (const g of out) {
    if (cur === null) cur = { start: g.start, end: g.end };
    else cur.end = g.end;
    if (cur.end - cur.start >= minLen) { merged.push(cur); cur = null; }
  }
  if (cur !== null) { if (merged.length) merged[merged.length - 1].end = cur.end; else merged.push(cur); }
  return merged;
}
