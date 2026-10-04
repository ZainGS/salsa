/**
 * GPU-DRIVEN MAIN PASS — the persistent GPU scene (performance-plan.md §P15, engine-roadmap step 4, Phase A).
 *
 * One RECORD per main-pass draw that the CPU path would put in its batched "simple opaque" segment: every
 * single-material opaque mesh (not vertex-coloured-untextured, not an instanced-crowd phantom source) and every opaque
 * instanced array group. Records live in GPU buffers and are rewritten only when they change (box, pool allocation,
 * instance slot, LOD / fog parameters, the CPU's verdict for a FORCED record). Each frame:
 *   1. the renderer's draw-list loop stamps the records it saw (`seeMesh` / `seeGroup`, which also re-check the record
 *      against the object while it is cache-hot: allocation, slot, matrix version, LOD / fog parameters) and, for
 *      forced records (near / far twins, billboards, always-on-top cards), the CPU verdict (`markVis`);
 *   2. `finish` re-derives the draw order when the structure changed (the CPU path's draw rank, walked in order),
 *      syncs the changed records, uploads the dirty ranges and dispatches the cull (shaders/gpu-cull-shaders.ts);
 *   3. `draw` replays a pre-recorded RENDER BUNDLE of one drawIndexedIndirect per record in draw order (re-recorded
 *      only when the order or a bucket's pipeline / bind groups changed), or, with Chrome's experimental
 *      multi-draw-indirect and few buckets, one multiDrawIndexedIndirect per bucket.
 * Culled records draw with instanceCount 0, so the image is the CPU path's image (same draws, same order).
 */
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { ArrayGroup3D } from '../../scene-graph/shapes/array-group-3d';
import { GPU_CULL_WGSL } from './shaders/gpu-cull-shaders';
import type { CullRanges } from './cull-ranges';
import { constTangentBuffer, packedTwin, twinEpoch } from './vertex-pack';
import {
  GD_REC_WORDS, GD_REC_BYTES, GdRecW, GD_ARGS_BYTES, GD_FRAME_BYTES, GD_FRAME_FLOATS, GD_STAT_WORDS, GdStat, GD_WORKGROUP,
  GD_CTL_ENABLED, GD_CTL_FORCED, GD_CTL_FORCED_VIS, GD_CTL_VISITED, GD_STATE_LOD_HIDDEN, GD_STATE_TWIN_NEAR, GD_STATE_TWIN_NEAR2,
  GD_STATE_VISITED_LAST, GD_FLAG_GROUP, GD_TWIN_OFF_NEAR, GD_TWIN_INSTANCED,
  GD_SHF_CASTS, GD_SHF_WIND, GD_CTL_DYNAMIC, GD_CTL_NOREACH, GD_CTL_CPU_LOD, GD_CTL_CPU_N1, GD_CTL_CPU_N2, GD_SH_LAYERS, GD_SH_FRAME_FLOATS, packGdShadowFrame, type GdShadowParams,
  GD_CODE_VB_OVERRIDE, GD_CODE_PACKED, GD_RANGE_SPANS, GD_RANGE_MAX_RUNS, GD_JOB_WORDS, GdJobW, gdRangeBoxFloats, packGdRangeBoxes, GdDirtyRanges, GdRecordSlots, gdBuckets, gdBucketsChanged, gdFogFlags, packGdFrame, packGdRecord,
  GD_FLAG_NO_BOX, gdSkippable, gdBoxOutside, gdSegments,
  GD_CTL_VB_OV, GD_SH_COMPACT, GD_STATE_IN_FAR, GdShFrameW, gdShadowDynMaybe, gdCompactSize, gdBoxOutsideLoose,
  type GdBucket, type GdBucketRefs, type GdFrameParams, type GdSegment,
} from './gpu-driven';

export interface GdAlloc { indexCount: number; firstIndex: number; baseVertex: number }
type Box = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };

/** What the renderer exposes to the GPU scene (closures over its private state; see Renderer3D._gdHost). */
export interface GdHost {
  readonly device: GPUDevice;
  readonly colorFormat: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  /** The device has 'chromium-experimental-multi-draw-indirect'. */
  readonly mdi: boolean;
  /** The renderer's alloc / slot map generation (Renderer3D._r3Gen). */
  gen(): number;
  /** Make m._r3GA / m._r3Slot current for this generation (as the draw-list loop does). */
  refresh(m: Mesh3D): void;
  box(m: Mesh3D): Box | null;
  vbOverride(id: string): GPUBuffer | undefined;
  /** Bumped whenever the vertex-buffer override set changes. */
  vbGen(): number;
  /** The record's pipeline-state code (gpu-driven.ts GD_CODE_*). */
  stateCode(m: Mesh3D): number;
  /** The draw rank's meshes in rank order, or null (the rank fell back to its legacy map: use rankOf). */
  rankedMeshes(): readonly Mesh3D[] | null;
  rankOf(id: string): number | undefined;
  /** The meshes the last rank update added or re-ranked, or null (a full re-sort / the legacy map: anything moved). */
  rankChanged(): readonly Mesh3D[] | null;
  groups(): readonly ArrayGroup3D[];
  /** Bumped when the group set changes (Renderer3D.setArrayGroups). */
  groupGen(): number;
  groupFirstSlot(id: string): number | undefined;
  groupSource(g: ArrayGroup3D): Mesh3D | undefined;
  groupCount(g: ArrayGroup3D): number;
  groupBox(g: ArrayGroup3D, src: Mesh3D): ArrayLike<number> | null;
  /** The instances' ORIGIN box of a group (P8 group twins; null = no explicit offsets), cached with groupBox. */
  groupOrigin(g: ArrayGroup3D): ArrayLike<number> | null;
  /** The CPU's group-twin state (Renderer3D._lodTwinNearGroups): seeds a new group record. */
  groupTwinNear(g: ArrayGroup3D): boolean;
  /** The CPU's distance-LOD hysteresis of a group (Renderer3D._lodHiddenGroups): seeds a new group record. */
  groupLodHidden(g: ArrayGroup3D): boolean;
  /** Bucket key of a textured, non-atlas record: its texture bind group (null otherwise). */
  texKey(m: Mesh3D, code: number): unknown;
  /** Phase C: the renderer's shadow frame counter (Renderer3D._shadowFrameNo) and a caster's "dynamic until" frame
   *  from the CPU's motion bookkeeping (moved within the hold, or on probation: Renderer3D._casterUntil). */
  shadowFrame(): number;
  casterUntil(m: Mesh3D): number;
  /** The shared geometry pool's vertex / index buffers (Phase B prepass bundles). */
  geomBuffers(): { vb: GPUBuffer | null; ib: GPUBuffer | null };
  /** Fill `out` with the pipeline / bind groups / buffers a bucket draws with (lead = its first record's mesh). */
  resolve(code: number, lead: Mesh3D, out: GdBucketRefs): void;
  /** The spatial cell the draw rank put a mesh in (Renderer3D.rankCellM; 0 = no cell / the rank has none): the
   *  sub-bundle key. Optional (absent = one sub-bundle). */
  rankCell?(m: Mesh3D): number;
}

/** A mesh that sits in the CPU path's batched opaque segment when drawn (Renderer3D._drawMainPass partition). */
export function gdMeshCandidate(m: Mesh3D): boolean {
  if (m.arraySourceOnly || m.submeshes.length > 0) return false;
  const mat = m.material;
  if (mat.opacity < 1) return false;
  if (m.vertexColors && !(mat.hasTexture && !!m.diffuseTexture)) return false;
  return true;
}
/** The CPU decides this mesh's visibility: billboards, always-on-top overlay cards, externally driven twins (P12 crowd
 *  tiers: their owner's residency rule), and every near / far twin while GPU twins are off (Phase A). */
export function gdMeshForced(m: Mesh3D): boolean {
  return (m.lodTwinRole !== 0 && (m.lodTwinExternal || !GpuDrivenMain.twins)) || m.billboard || m.billboardParent !== null || m.alwaysOnTop;
}
/** An opaque group that the CPU path draws as one instanced-range entry of its batched segment. */
export function gdGroupCandidate(src: Mesh3D, n: number): boolean {
  if (src.submeshes.length > 0 || n <= 0 || src.material.opacity < 1) return false;
  if (n === 1 && src.vertexColors && !(src.material.hasTexture && !!src.diffuseTexture)) return false;   // a 1-copy group is a plain entry
  return true;
}
/** The CPU decides a group's visibility: P12 external crowd tiers, and the P8 group twins while GPU twins are off. */
export function gdGroupForced(src: Mesh3D): boolean {
  const r = src.lodTwinRole;
  return r !== 0 && (src.lodTwinExternal || ((r === 1 || r === 2) && !GpuDrivenMain.twins));
}
/** GdRec.twinFlags of a mesh (or a group's source). */
function gdTwinFlags(m: Mesh3D): number {
  return (m.lodTwinOffNear ? GD_TWIN_OFF_NEAR : 0) | (m.lodTwinInstanced ? GD_TWIN_INSTANCED : 0);
}

type Tagged = { _gdOwner: unknown; _gdRec: number; _gdSeen: number; _gdVis: number; _gdCand: number; _gdVisit: number };
type GroupTagged = ArrayGroup3D & Tagged & { _gdFirst: number; _gdSrc: Mesh3D | null; _gdN: number; _gdTaken: number; _gdKC: boolean };

export interface GdStats {
  records: number; ordered: number; buckets: number; enabled: number;
  draws: number; tris: number; instances: number; meshesCulled: number; groupsCulled: number; instancesCulled: number;
  lodHidden: number; lodTris: number; fogHidden: number; fogTris: number; forcedVisible: number; forcedTris: number;
  /** Frames between the counted frame and now (the counters are read back asynchronously). */
  age: number;
  rebuilds: number; bundleRecords: number; recordWrites: number; ctlWrites: number; uploads: number; uploadBytes: number;
  mode: 'bundle' | 'mdi' | 'off'; skippedPending: number;
  msSync: number; msRebuild: number; msBundle: number;
  /** Rebuilds by trigger since start (diagnostics). */
  rebuildWhy: Record<string, number>;
  /** Cumulative CPU ms of the rebuild steps: candidates, frees, order walk (+ new records), positions, buckets. */
  rebuildParts: number[];
  /** Orphans placed by the O(new) insertion path, and the CPU ms of the last insertion batch. */
  inserts: number; msInsert: number;
  /** Phase B prepass bundles re-recorded (all kinds) and the CPU ms of the last one. */
  prepassRecords: number; msPrepassBundle: number;
  /** Phase B ranged records (range jobs) this frame, and the triangles their spans left out (GPU-reported; `tris` is net). */
  ranged: number; rangeTris: number;
  /** Phase C: shadow casters on the GPU this frame; per static layer (far, cascade 0, cascade 1) the GPU-reported
   *  leavers / joiners / joiner triangles (frame `shFrame`); shadow bundles re-recorded. */
  shadowsOn: boolean; shLeave: number[]; shJoin: number[]; shJoinTris: number[]; shFrame: number; shadowRecords: number;
  /** Compacted dynamic shadow layers (GpuDrivenMain.shadowCompact; far dynamic, cascade 0 / 1 dynamic): on this frame,
   *  the CPU bound of possible blocks and the draws its bundles issue (K) this frame, the GPU's appended count (frame
   *  `shFrame`), frames whose count exceeded their K (must stay 0: a lost caster), the records drawn from their own
   *  vertex buffer, and the frames since the static-layer snapshot the bound reads (-1 = none valid). */
  shCompactOn: boolean; shBound: number[]; shK: number[]; shCount: number[]; shCompactOver: number; shOwnVb: number; shSnapAge: number; shBoundCalls: number;
  /** Sub-bundle omission (GpuDrivenMain.subBundles): sub-bundles recorded, replayed this frame, and the records /
   *  indirect draws left out this frame (every one of them a zero-instance draw), cumulative omitted draws, and the
   *  CPU ms of this frame's selection. */
  segments: number; segKept: number; segOmitRecords: number; segOmitDraws: number; segOmitTotal: number; msSegSelect: number;
}

/** missing = the CPU path draws it, the GPU culled it or its sub-bundle was left out (an error); omitted = order
 *  positions in left-out sub-bundles; omittedDrawn = of those, records the GPU drew (an error of the omission). */
export interface GdVerifyResult { frame: number; checked: number; missing: number; extra: number; missingIds: string[]; extraIds: string[]; omitted: number; omittedDrawn: number }

export class GpuDrivenMain {
  readonly host: GdHost;
  private _cap = 0;
  private _rec = new Float32Array(0);
  private _recU = new Uint32Array(0);
  private _recI = new Int32Array(0);
  private _ctl = new Uint32Array(0);
  private _state = new Uint32Array(0);
  private _pos = new Uint32Array(0);
  /** Per-record CPU bookkeeping (what the record was last written from). */
  private _obj: (Mesh3D | ArrayGroup3D | null)[] = [];
  private _alloc: unknown[] = [];
  private _boxRef: unknown[] = [];
  private _matVer = new Float64Array(0);
  private _slot = new Int32Array(0);
  private _dd = new Float64Array(0);
  private _ddb = new Float64Array(0);
  private _fog = new Int32Array(0);
  private _code = new Int32Array(0);
  private _count = new Int32Array(0);
  private _texRef: unknown[] = [];
  private _srcRef: unknown[] = [];
  /** Frame stamps per record: seen by the loop / re-checked against its object / drawn by the CPU path; forced flag. */
  private _seen = new Int32Array(0);
  private _synced = new Int32Array(0);
  private _vis = new Int32Array(0);
  private _visit = new Int32Array(0);
  /** The CPU's LOD / twin state per record (GD_CTL_CPU_*), written by the draw-list loop where it decides them. */
  private _cpuBits = new Uint16Array(0);
  /** Phase B prepasses: each record's place in this frame's draw-list visit (the CPU's pass-list order: meshes in
   *  roster order, then groups), its rank in the prepass bundles' order, and whether this frame's visit broke it. */
  private _inSeq = new Int32Array(0);
  private _inRank = new Int32Array(0);
  private _seq = 0;
  private _lastRank = -1;
  private _inVer = 0;
  private _forced = new Uint8Array(0);
  private _isGroup = new Uint8Array(0);
  private _takenR = new Int32Array(0);
  private readonly _slots = new GdRecordSlots();
  /** Candidate meshes the loop met without a record this frame (input order): inserted into the order (O(new)), or,
   *  while a full rebuild is throttled, drawn by the CPU segment after the bundle. */
  private readonly _orphans: Mesh3D[] = [];
  private _orphanGroups = 0;
  /** A full rebuild is pending; `_fullNow` = it must run this frame (a state / candidacy change, not just the order). */
  private _fullNow = true;
  private _framesSinceFull = 1 << 30;
  /** At most one deferrable full rebuild (a pure ORDER change: survivors re-ranked, new groups) per this many frames;
   *  meanwhile the meshes it would place are drawn by the CPU after the bundle. */
  static FULL_REBUILD_MIN_FRAMES = 30;
  /** ... unless this many meshes / groups wait for it. */
  static FULL_REBUILD_BACKLOG = 256;
  private _order = new Uint32Array(0);
  private _nOrder = 0;
  /** Per record: its index in the draw order (-1 = not ordered) and its argument-block width (1, or GD_RANGE_SPANS
   *  for a ranged record). `_pos[r]` is its first argument block; `_nPos` = the blocks of the ordered records. */
  private _oi = new Int32Array(0);
  private _wid = new Uint8Array(0);
  private _nPos = 0;
  /** The order's positions must be re-derived (a record's width changed): cheaper than a full rebuild. */
  private _layoutDirty = false;
  // P11 ranges (Phase B): the run table per record, its box-pool slice, the job list
  private _rangeTab: (CullRanges | null)[] = [];
  private _boxOff = new Int32Array(0);
  private _boxLen = new Int32Array(0);
  private _boxPool = new Float32Array(0);
  private _boxHigh = 0;
  private _boxLive = 0;
  private _nRanged = 0;
  private readonly _boxDirty: number[] = [];
  private _boxAll = false;
  private _jobs = new Uint32Array(0);
  private _nJobs = 0;
  private _jobsDirty = false;
  private _boxBuf: GPUBuffer | null = null;
  private _jobBuf: GPUBuffer | null = null;
  private _rangePipeline: GPUComputePipeline | null = null;
  // Phase C shadows
  private _shPipeline: GPUComputePipeline | null = null;
  private readonly _commitPipes: (GPUComputePipeline | null)[] = [null, null, null];
  private readonly _shFrameBuf: GPUBuffer;
  private readonly _shFrameData = new Float32Array(GD_SH_FRAME_FLOATS);
  private readonly _shFrameU = new Uint32Array(this._shFrameData.buffer);
  private _shOn = false;
  private _dynUntil = new Int32Array(0);
  private _noreach = new Int32Array(0);
  private _shf = new Uint8Array(0);
  private readonly _shBundles = new Map<string, { bundle: GPURenderBundle; ver: number; pipe: unknown; vb: unknown; ib: unknown; args: unknown }>();
  /** Records freed since the renderer last asked (a static layer may have lost a caster it holds). */
  private _freed = 0;
  // compacted dynamic shadow layers (shadowCompact): this frame's decision, the CPU bound and the bundles' draw counts
  private _shCmp = false;
  private readonly _shBound = new Int32Array(3);
  private readonly _shK = new Int32Array(3);
  /** The K of the last 8 frames (frame % 8), to check the read-back counts against. */
  private readonly _shKHist = new Int32Array(24);
  private readonly _shKHistFrame = new Int32Array(8).fill(-1);
  /** Records drawn from their own vertex buffer (GD_CODE_VB_OVERRIDE casters: not compacted), and its version. */
  private _ovList: number[] = [];
  private _ovScratch: number[] = [];
  private _ovVer = 0;
  private readonly _cmpBundles = new Map<string, { bundle: GPURenderBundle; pipe: unknown; bg: unknown; vb: unknown; ib: unknown; args: unknown; ov: number }>();
  /** The static-layer IN bits per record (bit k = GD_STATE_IN_FAR << k) of the last read-back state snapshot (taken at
   *  the start of frame `_snapFrame`'s cull, before any commit of that frame), and the frame each record's state word
   *  was last written by the CPU (a seed / an upload clears its IN bits on the GPU). */
  private _inSnap = new Uint8Array(0);
  private _seedF = new Int32Array(0);
  private _snapFrame = -1;
  private _snapCopied = -1;
  private _snapStaging: GPUBuffer | null = null;
  private _snapBusy = false;
  private _snapArm = 0;
  /** Per record: outside the far light box (the bound's loose test), valid while `_lbVer[r]` = the light-box epoch
   *  (bumped when the planes change; a record rewrite resets its entry). */
  private _lbOut = new Uint8Array(0);
  private _lbVer = new Int32Array(0);
  private _lbEpoch = 0;
  private readonly _lbPrev = new Float64Array(24);
  private _lbPrevOn = false;
  /** The same per near cascade box (k = 0, 1): outside it, valid while `_cbVer[k][r]` = that box's epoch. */
  private readonly _cbOut: Uint8Array[] = [new Uint8Array(0), new Uint8Array(0)];
  private readonly _cbVer: Int32Array[] = [new Int32Array(0), new Int32Array(0)];
  private readonly _cbEpoch = [0, 0];
  private readonly _cbPrev = [new Float64Array(24), new Float64Array(24)];
  private readonly _cbPrevOn = [false, false];
  /** The frame of each static layer's last commit (cs_commit: its IN bits changed). */
  private readonly _commitF = new Int32Array([-1, -1, -1]);
  private _buckets: GdBucket[] = [];
  private readonly _recDirty = new GdDirtyRanges();
  private readonly _ctlDirty = new GdDirtyRanges();
  private readonly _stateDirty = new GdDirtyRanges();
  private _posDirty = true;
  // GPU objects
  private _recBuf: GPUBuffer | null = null;
  private _ctlBuf: GPUBuffer | null = null;
  private _stateBuf: GPUBuffer | null = null;
  private _posBuf: GPUBuffer | null = null;
  private _argsBuf: GPUBuffer | null = null;
  private readonly _statsBuf: GPUBuffer;
  private readonly _frameBuf: GPUBuffer;
  private readonly _frameData = new Float32Array(GD_FRAME_FLOATS);
  private _pipeline: GPUComputePipeline | null = null;
  private _pipelinePending = false;
  private _bgl: GPUBindGroupLayout | null = null;
  private _bg: GPUBindGroup | null = null;
  private _bundle: GPURenderBundle | null = null;
  private _bundleDirty = true;
  private _bundleSkipped = 0;
  private readonly _refScratch: GdBucketRefs = { pipeline: null, bg0: null, bg1: null, bg2: null, vb: null, ib: null };
  // structure tracking
  private _frame = 0;
  private _stamp = 0;
  private _structDirty = true;
  private _rankVer = -1;
  private _gen = -1;
  private _vbGen = -1;
  private _groupGen = -1;
  private _ready = false;
  private _dispatched = false;
  /** Meshes captured while material-dirty (Renderer3D.uploadMeshInstances): their state code / fog flags are re-read. */
  readonly matDirty: Mesh3D[] = [];
  // stats readback
  private readonly _staging: { buf: GPUBuffer; busy: boolean; frame: number }[] = [];
  private readonly _last = new Uint32Array(GD_STAT_WORDS);
  private _lastFrame = -1;
  /** reset() drops the read-back counters; a read still in flight from a frame at or before this one is ignored (it
   *  counted the records that were just forgotten). */
  private _statsFloor = -1;
  readonly stats: GdStats = {
    records: 0, ordered: 0, buckets: 0, enabled: 0, draws: 0, tris: 0, instances: 0, meshesCulled: 0, groupsCulled: 0,
    instancesCulled: 0, lodHidden: 0, lodTris: 0, fogHidden: 0, fogTris: 0, forcedVisible: 0, forcedTris: 0, age: -1, rebuilds: 0,
    bundleRecords: 0, recordWrites: 0, ctlWrites: 0, uploads: 0, uploadBytes: 0, mode: 'off', skippedPending: 0,
    msSync: 0, msRebuild: 0, msBundle: 0, rebuildWhy: {}, rebuildParts: [0, 0, 0, 0, 0], inserts: 0, msInsert: 0,
    prepassRecords: 0, msPrepassBundle: 0, ranged: 0, rangeTris: 0,
    shadowsOn: false, shLeave: [0, 0, 0], shJoin: [0, 0, 0], shJoinTris: [0, 0, 0], shFrame: -1, shadowRecords: 0,
    shCompactOn: false, shBound: [0, 0, 0], shK: [0, 0, 0], shCount: [0, 0, 0], shCompactOver: 0, shOwnVb: 0, shSnapAge: -1, shBoundCalls: 0,
    segments: 0, segKept: 0, segOmitRecords: 0, segOmitDraws: 0, segOmitTotal: 0, msSegSelect: 0,
  };
  private _why = '';
  private readonly _rbT = new Float64Array(6);
  /** A structure change. `now` = the records' state is wrong until rebuilt (run this frame); otherwise only the ORDER is
   *  stale (deferrable, throttled). */
  private _dirty(why: string, now = true): void {
    if (!this._structDirty) { this._structDirty = true; this._why = why; }
    if (now) this._fullNow = true;
  }
  /** Use multi-draw-indirect when the device has it and the order splits into at most this many buckets. */
  static MDI_MAX_BUCKETS = 48;
  /** false = never MDI (bundles only). */
  static allowMdi = true;
  /** PHASE B: near / far twins (mesh twins, P8 group twins) are decided by the compute pass with the CPU's hysteresis
   *  and re-seed rules. false = they stay CPU-decided (FORCED records, Phase A). Change through Renderer3D.setGpuDriven
   *  (it resets the scene: every record's forced flag changes). */
  static twins = true;
  /** PHASE B: P11 cull ranges on the GPU. A heavy mesh with a run table (Renderer3D._rangesFor) owns GD_RANGE_SPANS
   *  argument blocks; a range job (cs_ranges, one workgroup per ranged record) draws only its runs in the view.
   *  false = ranged meshes draw whole (Phase A; bit-identical pixels, more triangles). Through Renderer3D.setGpuDriven. */
  static ranges = true;
  /** PHASE B: every record draws with the FULL (patterned) pipeline variant, so plain and patterned meshes share one
   *  bucket. The plain variant renders identically (shaders/mesh3d-shaders.ts §3.1) but the city interleaves the two in
   *  draw order; a pre-recorded bundle switches pipeline at every alternation, culled records included (the CPU path
   *  only between visible ones), and those switches between visible draws cost GPU time. false = the CPU path's
   *  per-mesh choice. Through Renderer3D.setGpuDriven.
   *  DEFAULT OFF (2026-10-03): the full shader costs much more fragment time than the plain one, and the merge made
   *  every plain mesh pay it: +5-7 ms main pass in the tiled city at 1300x850, the whole GPU-path deficit (direct
   *  draws of the GPU's visible set with merged pipelines +6.7 ms vs the CPU path, with per-mesh pipelines +0.3 ms).
   *  The alternation it worked around is gone at the source: the draw rank now keys plain / full
   *  (Renderer3D.rankPatterned), so plain and patterned records form separate runs. */
  static mergePatterned = false;
  /** PHASE C: the shadow casters of the GPU records (far map: direct / static / dynamic layers; each near cascade:
   *  static / dynamic) are decided by a compute pass from the same records in light space (the CPU path's rules: light
   *  box, shadow reach, shadow LOD, the P4.2 / P14 static / dynamic split and joiners) and drawn from render bundles;
   *  the CPU loop skips its shadow section for them. Static layers still re-render only on invalidation: the pass
   *  counts each layer's leavers / joiners and the renderer reads them back (a frame or two late, inside the layers'
   *  own refresh throttle). false = the CPU builds every shadow list (Phase A / B). Through Renderer3D.setGpuDriven. */
  static shadows = true;
  /** PHASE C COMPACTION (the zero-draw cost of the shadow passes): the per-frame DYNAMIC layers (far dynamic, cascade
   *  0 / 1 dynamic) draw from compact lists cs_shadow appends to (a depth-only pass is order-independent), K draws each,
   *  K = a CPU upper bound of the layer's nonzero blocks (gpu-driven.ts gdShadowDynMaybe; the static-layer membership
   *  from a read-back state snapshot after each commit), instead of one indirect draw per caster record. false = the
   *  per-record bundles (the A/B). The static and direct layers keep per-record bundles: they render only on
   *  invalidation. Through Renderer3D.setGpuDriven. */
  static shadowCompact = true;
  /** The LOD / twin hysteresis state comes from the CPU loop (GD_CTL_CPU_*: it computes it for every visited record
   *  anyway): the GPU's own f32 hysteresis could split from the CPU's at a threshold tie and then disagree inside the
   *  band. false = the GPU's own state (the A/B for that). Through Renderer3D.setGpuDriven. */
  static cpuState = true;
  /** SUB-BUNDLE OMISSION (the D3D12 zero-draw cost): the main bundle is recorded as one sub-bundle per run of the
   *  draw order in one spatial cell of the draw rank (GdHost.rankCell), and each frame only the sub-bundles that may
   *  draw something are replayed (selectSegments: gdSkippable per record from the control words, gdBoxOutside on the
   *  union box). Omitted draws are zero-instance draws, so the image is the full replay's. false = one bundle. */
  static subBundles = false;   // default OFF (2026-10-03): identical pixels but no measurable GPU win yet, and ~2.5x the bundle re-record CPU; see performance-plan §P15 status
  /** A run shorter than this merges into the next one (a sub-bundle's state setup costs about as much as a few draws). */
  static SUB_MIN_RECORDS = 8;
  /** Sub-bundles per GROUP bundle (a second level over the same draws). Replaying a sub-bundle costs GPU time of its
   *  own (about 7 µs each in the tiled city on D3D12, measured: more than 30 zero draws), so a group whose sub-bundles
   *  are all kept replays as ONE bundle, a group with none is skipped, and a mixed group replays its kept members.
   *  1 = no groups. SUB_LEVELS group levels are recorded (level k groups SUB_GROUP^k sub-bundles); the replay list
   *  takes the largest fully kept group at each place. The rank cells are in Z-order, so a group is a compact block. */
  static SUB_GROUP = 8;
  static SUB_LEVELS = 2;
  /** Per group level (level 1 = SUB_GROUP sub-bundles each, level 2 = SUB_GROUP^2, ...): its bundles. */
  private _grpBundles: GPURenderBundle[][] = [];
  // sub-bundles: the segments of the order, their bundles, union boxes (6 per segment, from the record table) and
  // argument-block counts; per record its segment; this frame's replay list
  private _segs: GdSegment[] = [];
  private _segBundles: GPURenderBundle[] = [];
  private _segBox = new Float64Array(0);
  private _segNoBox = new Uint8Array(0);
  private _segBlocks = new Int32Array(0);
  private _segKeep = new Uint8Array(0);
  private _segOfRec = new Int32Array(0);
  private _segBoxAll = true;
  private readonly _segBoxDirty: number[] = [];
  private readonly _kept: GPURenderBundle[] = [];
  /** The current bundle is split into sub-bundles (bundle mode + the switch on when it was recorded). */
  private _segOn = false;
  private _segSelFrame = -1;
  private _lastF: GdFrameParams | null = null;
  // verification (debug): compare the GPU's per-record verdict with the CPU path's lists
  private _verifyWanted = false;
  private _verifyBusy = false;
  private _verifyExpect: Uint8Array | null = null;
  private _verifyIds: string[] = [];
  private _verifyCb: ((r: GdVerifyResult) => void) | null = null;
  private _verifyStaging: GPUBuffer | null = null;
  private _verifyFrame = 0;
  private _verifyFirst: Uint32Array | null = null;
  private _verifyWid: Uint8Array | null = null;
  private _verifyOmit: Uint8Array | null = null;

  constructor(host: GdHost) {
    this.host = host;
    const d = host.device;
    this._statsBuf = d.createBuffer({ label: 'GdStats', size: GD_STAT_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this._frameBuf = d.createBuffer({ label: 'GdFrame', size: GD_FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._shFrameBuf = d.createBuffer({ label: 'GdShadowFrame', size: GD_SH_FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._createPipeline();
  }

  private _createPipeline(): void {
    const d = this.host.device;
    const S = GPUShaderStage.COMPUTE;
    this._bgl = d.createBindGroupLayout({
      label: 'GdCullBGL',
      entries: [
        { binding: 0, visibility: S, buffer: { type: 'uniform' } },
        { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: S, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: S, buffer: { type: 'storage' } },
        { binding: 4, visibility: S, buffer: { type: 'storage' } },
        { binding: 5, visibility: S, buffer: { type: 'storage' } },
        { binding: 6, visibility: S, buffer: { type: 'read-only-storage' } },
        { binding: 7, visibility: S, buffer: { type: 'read-only-storage' } },
        { binding: 8, visibility: S, buffer: { type: 'read-only-storage' } },
        { binding: 9, visibility: S, buffer: { type: 'uniform' } },
      ],
    });
    const module = d.createShaderModule({ label: 'GdCull', code: GPU_CULL_WGSL });
    this._pipelinePending = true;
    d.createComputePipelineAsync({ label: 'GdCull', layout: d.createPipelineLayout({ bindGroupLayouts: [this._bgl] }), compute: { module, entryPoint: 'cs_cull' } })
      .then((p) => { this._pipeline = p; this._pipelinePending = false; })
      .catch((e) => { this._pipelinePending = false; console.error('[gpu-driven] cull pipeline failed', e); });
    // Phase C shadow casters + the three static-layer commits (optional: until compiled the CPU builds the lists)
    const layout = d.createPipelineLayout({ bindGroupLayouts: [this._bgl] });
    d.createComputePipelineAsync({ label: 'GdShadow', layout, compute: { module, entryPoint: 'cs_shadow' } })
      .then((p) => { this._shPipeline = p; })
      .catch((e) => { console.error('[gpu-driven] shadow pipeline failed', e); });
    for (let k = 0; k < 3; k++) {
      d.createComputePipelineAsync({ label: 'GdShadowCommit' + k, layout, compute: { module, entryPoint: 'cs_commit', constants: { COMMIT_LAYER: k } } })
        .then((p) => { this._commitPipes[k] = p; })
        .catch((e) => { console.error('[gpu-driven] shadow commit pipeline failed', e); });
    }
    // Phase B range jobs: optional (until it compiles, or if it fails, ranged records draw whole: blocks 1.. stay zero)
    d.createComputePipelineAsync({ label: 'GdRanges', layout: d.createPipelineLayout({ bindGroupLayouts: [this._bgl] }), compute: { module, entryPoint: 'cs_ranges' } })
      .then((p) => { this._rangePipeline = p; })
      .catch((e) => { console.error('[gpu-driven] range pipeline failed', e); });
  }

  /** True once the cull pipeline compiled (until then the renderer keeps the CPU main pass). */
  get ready(): boolean { return !!this._pipeline; }
  get frame(): number { return this._frame; }
  /** True after `finish` dispatched this frame's cull (draw() may replay). */
  get dispatched(): boolean { return this._dispatched; }

  // ── per-frame protocol ─────────────────────────────────────────────────────────────────────────────────────────

  /** Start a frame; returns its stamp (meshes / groups the draw-list loop sees get `_gdSeen = stamp`). */
  beginFrame(): number {
    this._dispatched = false;
    this.matDirty.length = 0;
    this._orphans.length = 0; this._orphanGroups = 0;
    this._seq = 0; this._lastRank = -1;
    return ++this._frame;
  }
  /** True when `o` (a mesh or group) holds a live record of this scene (a copied object never does). */
  owns(o: { _gdOwner: unknown; _gdRec: number }): boolean {
    return o._gdOwner === this && o._gdRec >= 0 && this._obj[o._gdRec] === (o as unknown);
  }
  /** Renderer3D.uploadMeshInstances: a material-dirty mesh this frame (its record / its groups' records re-read it). */
  noteMatDirty(m: Mesh3D): void {
    (m as { _gdMatF: number })._gdMatF = this._frame; this.matDirty.push(m);
    // re-checked now, BEFORE the draw-list loop, so lean mode never skips a mesh that just left the batched segment
    if (!this.owns(m)) return;
    const r = m._gdRec;
    if (!gdMeshCandidate(m)) { m._gdKF = true; this._forced[r] = 1; this._dirty('meshCand'); return; }   // the CPU handles it this frame
    this._forced[r] = gdMeshForced(m) ? 1 : 0; m._gdKF = this._forced[r] !== 0;
    if (this.host.stateCode(m) !== this._code[r]) this._dirty('stateCode');
  }
  /** Mark the structure changed (the next finish re-derives the order). */
  invalidate(): void { this._dirty('invalidate'); }
  /** P17 (leak fix): `m` left the scene (Renderer3D evicts it). Its record stays disabled until a full rebuild frees it —
   *  but no removal requested one, so in a streamed fly (adds go in as orphan inserts) the dead records piled up in
   *  `_obj` and kept every disposed tile's meshes, with their CPU geometry, alive (the HLOD fly: +30 MB/s of heap).
   *  Past DEAD_REBUILD dead records a deferrable rebuild is requested (they are not drawn meanwhile). */
  noteRemoved(m: Mesh3D): void {
    if (!this.owns(m as unknown as { _gdOwner: unknown; _gdRec: number })) return;
    // §P15 stats fix: also once the dead are a large SHARE of the records (a small scene cleared: under 256 dead records
    // they used to stay, holding their meshes, until some unrelated change rebuilt the order)
    if (++this._dead >= GpuDrivenMain.DEAD_REBUILD || this._dead * GpuDrivenMain.DEAD_SHARE_DEN >= this.recordCount) this._dirty('removed', false);
  }
  /** Dead records (see noteRemoved) that request a deferrable full rebuild. */
  static DEAD_REBUILD = 256;
  /** ...or dead records at least 1 / DEAD_SHARE_DEN of all records (0 = off). */
  static DEAD_SHARE_DEN = 4;
  private _dead = 0;
  /** Re-record the main bundle(s) on the next finish (the sub-bundle switch flipped). */
  invalidateBundle(): void { this._bundleDirty = true; }
  /** Live records. */
  get recordCount(): number { return this._slots.high - this._slots.freeCount; }
  /** Re-read every record's pipeline-state code and texture key (a renderer-wide input of stateCode / texKey changed:
   *  the atlas, forceDoubleSided, the merged-pipeline choice), then re-derive the order and buckets. */
  recode(): void {
    const host = this.host;
    for (let r = 0; r < this._slots.high; r++) {
      const o = this._obj[r];
      if (!o) continue;
      const m = (this._isGroup[r] ? this._srcRef[r] : o) as Mesh3D | null;
      if (!m) continue;
      const code = host.stateCode(m);
      this._code[r] = code; this._texRef[r] = host.texKey(m, code);
    }
    this._dirty('recode');
  }
  /** Draw-list loop, every mesh: stamps it. Returns its record index, or -1 (no record: if it is a candidate the
   *  order is out of date and the next finish rebuilds; its stamps then seed the new record). */
  seeMesh(m: Mesh3D): number {
    const r = m._gdRec;
    if (m._gdOwner === this && r >= 0 && this._obj[r] === m) { this._seen[r] = this._frame; this._visitSeq(r); return r; }
    m._gdSeen = this._frame;
    if (gdMeshCandidate(m)) this._orphans.push(m);
    return -1;
  }
  /** Draw-list loop, a recorded mesh after its alloc / slot copies were refreshed (`_r3GA` / `_r3Slot` current): re-check
   *  the record against the mesh (cache-hot here) and rewrite it when anything it was built from changed. Returns
   *  true when the GPU culls it (not forced, still a candidate): lean mode may skip its camera-pass tail. */
  syncMesh(m: Mesh3D, r: number, mi: number): boolean {
    this._synced[r] = this._frame;
    // (candidacy, the forced flag and the state code change with the material: re-checked for material-dirty meshes in
    // finish, so the per-frame check reads only fields the draw-list loop just read itself)
    // the compare keys live on the mesh (cache-hot here; the record arrays are in rank order, the loop in input order)
    if (m._r3GA !== m._gdKA || (m._r3Slot >= 0 ? m._r3Slot : mi) !== m._gdKS || m.localMatrixVersion !== m._gdKM
        || m.drawDistance !== m._gdKD || m.drawDistanceBias !== m._gdKB || m.lodTwinRole !== m._gdKR || m.shadowFeatureSize !== m._gdKSh
        || (m._gdKR !== 0 && (m.lodTwinDist !== m._gdKT || m.lodTwinDist2 !== m._gdKT2 || (gdTwinFlags(m) | (m.lodTwinExternal ? 4 : 0)) !== m._gdKX))) this._writeMeshRec(r, m, mi);
    return !m._gdKF && this._seen[r] === this._frame;
  }
  /** At the CPU path's "drawn" point: the record's verdict for this frame (used by forced records + verification). */
  markVis(r: number): void { this._vis[r] = this._frame; }
  /** Draw-list loop, where the CPU has decided a mesh's LOD / twin state this frame (`m` is cache-hot there). */
  cpuMesh(r: number, m: Mesh3D): void {
    if (r >= 0) this._cpuBits[r] = (m.lodHidden ? GD_CTL_CPU_LOD : 0) | (m.lodTwinNear ? GD_CTL_CPU_N1 : 0) | (m.lodTwinNear2 ? GD_CTL_CPU_N2 : 0);
  }
  /** Group loop: the group twin's near state / the group's LOD state as the CPU just decided them. */
  cpuGroupNear(r: number, near: boolean): void { if (r >= 0) this._cpuBits[r] = near ? (this._cpuBits[r] | GD_CTL_CPU_N1) : (this._cpuBits[r] & ~GD_CTL_CPU_N1); }
  cpuGroupLod(r: number, hidden: boolean): void { if (r >= 0) this._cpuBits[r] = hidden ? (this._cpuBits[r] | GD_CTL_CPU_LOD) : (this._cpuBits[r] & ~GD_CTL_CPU_LOD); }
  /** Is record `r` CPU-decided (FORCED)? */
  isForced(r: number): boolean { return r >= 0 && this._forced[r] !== 0; }
  /** Phase C, draw-list loop: a record skipped by the hierarchical cull with HC_NOREACH (GD_CTL_NOREACH). */
  markNoReach(r: number): void { this._noreach[r] = this._frame; }
  /** Phase C: the shadow pipelines compiled (until then the CPU builds every shadow list). */
  get shadowReady(): boolean { return !!this._shPipeline && !!this._commitPipes[0] && !!this._commitPipes[1] && !!this._commitPipes[2]; }
  /** Phase C: is record `r` a GPU-decided caster this frame (the CPU loop skips its shadow section)? */
  shadowOwns(r: number): boolean { return this._shOn && r >= 0 && this._forced[r] === 0; }
  /** Records freed since the last call (Phase C: a static layer may hold one of them). */
  takeFreed(): number { const n = this._freed; this._freed = 0; return n; }
  /** Phase C: draw shadow `layer` (GdShLayer) of this frame's GPU casters into a depth-only pass from a render
   *  bundle (re-recorded when the record set, the pipeline, the bind group or the pool buffers change). Returns true
   *  when it executed one (executeBundles clears the pass state: the caller re-binds). */
  drawShadow(pass: GPURenderPassEncoder, layer: number, pipeline: GPURenderPipeline, bg0: GPUBindGroup, bgKey: string): boolean {
    if (!this._shOn || !this._dispatched || !this._argsBuf) return false;
    const host = this.host, { vb, ib } = host.geomBuffers();
    if (!vb || !ib) return false;
    const cj = this._shCmp ? (layer === 2 ? 0 : layer === 4 ? 1 : layer === 6 ? 2 : -1) : -1;
    if (cj >= 0) return this._drawCompact(pass, cj, layer, pipeline, bg0, bgKey, vb, ib);
    const key = layer + ':' + bgKey;
    let c = this._shBundles.get(key);
    if (!c || c.ver !== this._orderVer || c.pipe !== pipeline || c.vb !== vb || c.ib !== ib || c.args !== this._argsBuf || (c as { bg?: unknown }).bg !== bg0 || GpuDrivenMain._twinStale(c)) {
      const enc = host.device.createRenderBundleEncoder({ label: 'GdShadow:' + key, colorFormats: [], depthStencilFormat: 'depth32float', sampleCount: 1 });
      enc.setIndexBuffer(ib, 'uint32'); enc.setPipeline(pipeline); enc.setBindGroup(0, bg0);
      const base = this._argBlocks + layer * this._cap;
      let cur: GPUBuffer | null = null;
      const st = GpuDrivenMain._fmtState();
      for (let r = 0; r < this._slots.high; r++) {
        if (!this._obj[r] || !(this._shf[r] & GD_SHF_CASTS)) continue;
        if (!this._fmtBind(enc, st, r, pipeline, ib)) continue;   // P22: a packed record (its twin compiling: left out)
        const v = (this._code[r] & GD_CODE_VB_OVERRIDE) ? (host.vbOverride(this._srcId(r)) ?? vb) : vb;
        if (v !== cur) { enc.setVertexBuffer(0, v); cur = v; }
        enc.drawIndexedIndirect(this._argsBuf, (base + r) * GD_ARGS_BYTES);
      }
      c = { bundle: enc.finish(), ver: this._orderVer, pipe: pipeline, vb, ib, args: this._argsBuf };
      (c as { bg?: unknown }).bg = bg0;
      GpuDrivenMain._twinMark(c, st);
      this._shBundles.set(key, c);
      this.stats.shadowRecords++;
    }
    pass.executeBundles([c.bundle]);
    return true;
  }
  /** The compact list `j` of dynamic layer `layer`: K slot draws (this frame's bound) from the pool's vertex buffer,
   *  then the own-vertex-buffer casters from their per-record blocks. One cached bundle per (layer, bind group, K). */
  private _drawCompact(pass: GPURenderPassEncoder, j: number, layer: number, pipeline: GPURenderPipeline, bg0: GPUBindGroup, bgKey: string, vb: GPUBuffer, ib: GPUBuffer): boolean {
    const K = this._shK[j], ov = this._ovList;
    if (K === 0 && ov.length === 0) return false;
    const key = layer + ':' + bgKey + ':' + K;
    let c = this._cmpBundles.get(key);
    if (!c || c.pipe !== pipeline || c.bg !== bg0 || c.vb !== vb || c.ib !== ib || c.args !== this._argsBuf || c.ov !== this._ovVer || GpuDrivenMain._twinStale(c)) {
      if (this._cmpBundles.size > 64) this._cmpBundles.clear();
      const host = this.host, args = this._argsBuf!;
      const enc = host.device.createRenderBundleEncoder({ label: 'GdShadowCompact:' + key, colorFormats: [], depthStencilFormat: 'depth32float', sampleCount: 1 });
      enc.setIndexBuffer(ib, 'uint32'); enc.setPipeline(pipeline); enc.setBindGroup(0, bg0); enc.setVertexBuffer(0, vb);
      const cb = this._argBlocks + (GD_SH_LAYERS + j) * this._cap;
      for (let s = 0; s < K; s++) enc.drawIndexedIndirect(args, (cb + s) * GD_ARGS_BYTES);
      let cur: GPUBuffer = vb;
      const base = this._argBlocks + layer * this._cap;
      const st = GpuDrivenMain._fmtState();
      for (const r of ov) {   // (P22: packed casters are drawn here too, from their own blocks: never compacted)
        if (!this._fmtBind(enc, st, r, pipeline, ib)) continue;
        const v = host.vbOverride(this._srcId(r)) ?? vb;
        if (v !== cur) { enc.setVertexBuffer(0, v); cur = v; }
        enc.drawIndexedIndirect(args, (base + r) * GD_ARGS_BYTES);
      }
      c = { bundle: enc.finish(), pipe: pipeline, bg: bg0, vb, ib, args: this._argsBuf, ov: this._ovVer };
      GpuDrivenMain._twinMark(c, st);
      this._cmpBundles.set(key, c);
      this.stats.shadowRecords++;
    }
    pass.executeBundles([c.bundle]);
    return true;
  }
  // ── P22 packed records in the depth-style bundles (vertex-pack.ts; one pipeline for every record of the bundle) ──
  /** A bundle's format state: packed bound (twin + uint16), the tangent buffer in slot 1, a packed record left out. */
  private static _fmtState(): { pk: boolean; tan: boolean; missed: boolean } { return { pk: false, tan: false, missed: false }; }
  /** Bind record `r`'s format in `enc` (which starts with `pipeline` + a uint32 index buffer). False = leave the record
   *  out (its pipeline's packed twin is still compiling: the bundle re-records once one lands, see _twinMark). */
  private _fmtBind(enc: GPURenderBundleEncoder, st: { pk: boolean; tan: boolean; missed: boolean }, r: number, pipeline: GPURenderPipeline, ib: GPUBuffer): boolean {
    const pk = (this._code[r] & GD_CODE_PACKED) !== 0;
    if (pk === st.pk) return true;
    if (pk) {
      const tw = packedTwin(this.host.device, pipeline);
      if (!tw) { st.missed = true; return false; }
      enc.setPipeline(tw); enc.setIndexBuffer(ib, 'uint16');
      if (!st.tan) { enc.setVertexBuffer(1, constTangentBuffer(this.host.device)); st.tan = true; }
    } else { enc.setPipeline(pipeline); enc.setIndexBuffer(ib, 'uint32'); }
    st.pk = pk;
    return true;
  }
  /** Remember on a cached bundle that it left packed records out (the twin epoch it was recorded at). */
  private static _twinMark(c: object, st: { missed: boolean }): void { (c as { tw?: number }).tw = st.missed ? twinEpoch() : -1; }
  /** A cached bundle that left packed records out, recorded before the last twin landed. */
  private static _twinStale(c: object): boolean { const t = (c as { tw?: number }).tw; return t !== undefined && t >= 0 && t !== twinEpoch(); }
  /** Phase C: static layer `k` (0 far, 1 cascade 0, 2 cascade 1) was just drawn from this frame's members: record the
   *  commit (its drawn set := its members) into `enc`, after that pass. */
  encodeShadowCommit(enc: GPUCommandEncoder, k: number): boolean {
    const p = this._commitPipes[k];
    if (!this._shOn || !p || !this._bg || this._slots.high === 0) return false;
    this._commitF[k] = this._frame;   // the compaction bound's IN snapshot is stale for this layer from here
    const pass = enc.beginComputePass({ label: 'GdShadowCommit' + k });
    pass.setPipeline(p); pass.setBindGroup(0, this._bg);
    pass.dispatchWorkgroups(Math.ceil(this._slots.high / GD_WORKGROUP));
    pass.end();
    return true;
  }
  /** Draw-list loop, past the hierarchical cull (the CPU's `_hcSeen = hcFrame`): the record was visited this frame
   *  (GD_CTL_VISITED; `r` = -1 for a mesh without a record yet: its object stamp seeds the new record). */
  markVisited(m: Mesh3D, r: number): void { (m as Mesh3D & Tagged)._gdVisit = this._frame; if (r >= 0) this._visit[r] = this._frame; }
  /** Group loop, for a placed group with a single-material source and N > 0: stamps + re-checks it (as seeMesh +
   *  syncMesh). Returns its record index, or -1. */
  seeGroup(g: ArrayGroup3D, first: number, src: Mesh3D, n: number): number {
    const t = g as GroupTagged;
    t._gdFirst = first; t._gdSrc = src; t._gdN = n; t._gdSeen = this._frame;
    const r = t._gdRec;
    if (!(t._gdOwner === this && r >= 0 && this._obj[r] === (t as unknown))) {
      if (gdGroupCandidate(src, n)) { this._orphanGroups++; this._dirty('newGroup', false); }
      return -1;
    }
    this._synced[r] = this._frame;
    this._visitSeq(r);
    if (src.material.opacity < 1 || (n === 1 && src.vertexColors)) { this._seen[r] = -1; this._dirty('groupCand'); return -1; }
    this._seen[r] = this._frame;
    this.host.refresh(src);
    if (first !== t._gdKS || n !== t._gdKN || src._r3GA !== t._gdKA || src !== t._gdKSrc
        || src.drawDistance !== t._gdKD || src.drawDistanceBias !== t._gdKB || src._gdMatF === this._frame) this._writeGroupRec(r, t);
    if (src.castsInstancedShadow !== t._gdKC) { this._writeGroupRec(r, t); this._dirty('passSet'); }   // the prepass / caster set changed
    return r;
  }
  /** Group loop, once the group's world box is known this frame (the CPU's `gb`): rewrite the record if it changed. */
  groupBox(r: number, box: ArrayLike<number> | null): void {
    if (r >= 0 && box !== (this._obj[r] as GroupTagged)._gdKBox) this._writeGroupRec(r, this._obj[r] as GroupTagged, false, box);
  }
  /** After finish: does the bundle draw `o` (a mesh or group)? False = the CPU segment must (a mesh met this frame that
   *  is not placed yet, see `_orphans`). */
  drawsObject(o: { _gdOwner: unknown; _gdRec: number }): boolean {
    return this.owns(o) && this._takenR[o._gdRec] !== -1 && this._oi[o._gdRec] >= 0;
  }
  /** Lean mode: may the CPU skip this record's camera-pass tail (the GPU culls it)? */
  gpuCulls(r: number): boolean { return r >= 0 && this._forced[r] === 0 && this._seen[r] === this._frame; }

  /**
   * After the draw-list loop: rebuild the order when needed, sync the records, upload and dispatch the cull.
   * `meshes` = this frame's roster (the draw-list input). Returns false when the GPU path cannot draw this frame
   * (the caller then draws the CPU segment).
   */
  finish(meshes: readonly Mesh3D[], F: GdFrameParams, rankVersion: number, S?: GdShadowParams): boolean {
    if (!this._pipeline) return false;
    this._shS = S ?? null; this._lastF = F;
    const t0 = performance.now();
    const host = this.host;
    const gen = host.gen(), vbGen = host.vbGen(), groups = host.groups();
    const fr = this._frame;
    for (let k = 0; k < this.matDirty.length; k++) {   // fog flags (the candidacy / state code were re-checked in noteMatDirty)
      const m = this.matDirty[k] as Mesh3D & Tagged;
      if (!this.owns(m)) continue;
      const r = m._gdRec;
      if (!gdMeshCandidate(m)) { this._seen[r] = -1; continue; }   // left the batched segment: the CPU drew it
      if (gdFogFlags(m.fogClass, !!m.material.noFog) !== this._fog[r]) this._writeMeshRec(r, m, -1);
    }
    if (vbGen !== this._vbGen) this._dirty('vbOverride');
    if (host.groupGen() !== this._groupGen) this._dirty('groupSet', false);
    if (rankVersion !== this._rankVer) {
      // a rank update: only a re-rank of meshes that ALREADY have records changes the order of the bundle; new meshes are
      // placed below and removed ones simply stay disabled
      const ch = host.rankChanged();
      if (ch === null) this._dirty('rank', false);
      else for (let k = 0; k < ch.length; k++) if (this.owns(ch[k] as Mesh3D & Tagged)) { this._dirty('rank', false); break; }
      this._rankVer = rankVersion;
    }
    this._framesSinceFull++;
    const backlog = this._orphans.length + this._orphanGroups;
    const full = this._structDirty && (this._fullNow || this._framesSinceFull >= GpuDrivenMain.FULL_REBUILD_MIN_FRAMES || backlog > GpuDrivenMain.FULL_REBUILD_BACKLOG);
    if (full) {
      const w = this.stats.rebuildWhy; w[this._why] = (w[this._why] ?? 0) + 1;
      const tr = performance.now();
      this._rebuild(meshes, groups);
      this._vbGen = vbGen; this._groupGen = host.groupGen();
      this._structDirty = false; this._fullNow = false; this._framesSinceFull = 0;
      this.stats.rebuilds++;
      this.stats.msRebuild = performance.now() - tr;
    } else if (this._orphans.length > 0) {
      const ti = performance.now();
      const n = this._insertOrphans();
      this.stats.inserts += n;
      if (n > 0) this.stats.msInsert = performance.now() - ti;
    }
    // (decided before the control pass: it computes the compact lists' bound)
    this._shCmp = !!this._shS && this._shS.on && GpuDrivenMain.shadows && GpuDrivenMain.shadowCompact && this.shadowReady;
    this._ctlPass(gen !== this._gen);
    this._gen = gen;
    if (this._layoutDirty) { this._positions(); this._bundleDirty = true; }   // a record's width changed (P11 ranges)
    if (this._jobsDirty) this._buildJobs();
    if (this._structDirty && this._fullNow) {   // a record rewrite in the pass above found another bucket: redo the order now
      const w = this.stats.rebuildWhy; w[this._why] = (w[this._why] ?? 0) + 1;
      this._rebuild(meshes, groups); this._structDirty = false; this._fullNow = false; this._framesSinceFull = 0; this.stats.rebuilds++;
      this._ctlPass(false);
    }
    this._checkBundle();
    this._shOn = !!this._shS && this._shS.on && GpuDrivenMain.shadows && this.shadowReady;
    this._shCmp = this._shCmp && this._shOn;
    {
      const st = this.stats, h = (fr & 7) * 3;
      st.shCompactOn = this._shCmp; st.shOwnVb = this._ovList.length;
      st.shSnapAge = this._snapFrame >= 0 ? fr - this._snapFrame : -1;
      for (let j = 0; j < 3; j++) {
        if (!this._shCmp) this._shK[j] = 0;
        st.shBound[j] = this._shBound[j]; st.shK[j] = this._shK[j]; this._shKHist[h + j] = this._shK[j];
      }
      this._shKHistFrame[fr & 7] = this._shCmp ? fr : -1;
    }
    this._upload(F);
    this.stats.msSync = performance.now() - t0;
    return true;
  }

  /** Record the cull dispatch (+ the stats readback copy) into `enc`. Call after finish, before the main pass. */
  encode(enc: GPUCommandEncoder): void {
    if (!this._pipeline || !this._bg) return;
    enc.clearBuffer(this._statsBuf);
    if (this._shCmp && this._argsBuf) {
      // the compact lists: the slots this frame's bundles draw start as zero draws (cs_shadow fills the first `count`)
      for (let j = 0; j < 3; j++) if (this._shK[j] > 0) enc.clearBuffer(this._argsBuf, (this._argBlocks + (GD_SH_LAYERS + j) * this._cap) * GD_ARGS_BYTES, this._shK[j] * GD_ARGS_BYTES);
      // the static-layer IN bits for the bound: a state snapshot BEFORE this frame's compute (cs_cull / cs_shadow never
      // change them; only a commit or a CPU state upload does), whenever a commit happened since the last one
      const need = this._snapCopied < 0 || this._commitF[0] >= this._snapCopied || this._commitF[1] >= this._snapCopied || this._commitF[2] >= this._snapCopied;
      const high = this._slots.high;
      if (need && !this._snapBusy && high > 0 && this._stateBuf) {
        if (!this._snapStaging || this._snapStaging.size < high * 4) {
          this._snapStaging?.destroy();
          this._snapStaging = this.host.device.createBuffer({ label: 'GdStateSnap', size: Math.max(256, this._cap * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        }
        enc.copyBufferToBuffer(this._stateBuf, 0, this._snapStaging, 0, high * 4);
        this._snapBusy = true; this._snapCopied = this._frame; this._snapArm = high;
      }
    }
    const pass = enc.beginComputePass({ label: 'GdCull' });
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, this._bg);
    const n = this._slots.high;
    if (n > 0) pass.dispatchWorkgroups(Math.ceil(n / GD_WORKGROUP));
    if (this._nJobs > 0 && this._rangePipeline) { pass.setPipeline(this._rangePipeline); pass.dispatchWorkgroups(this._nJobs); }
    if (this._shOn && this._shPipeline && n > 0) { pass.setPipeline(this._shPipeline); pass.dispatchWorkgroups(Math.ceil(n / GD_WORKGROUP)); }
    pass.end();
    this._dispatched = true;
    // stats readback: a free staging buffer (skip a frame when all are in flight)
    let st = this._staging.find((s) => !s.busy);
    if (!st && this._staging.length < 3) {
      st = { buf: this.host.device.createBuffer({ label: 'GdStatsRead', size: GD_STAT_WORDS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false, frame: 0 };
      this._staging.push(st);
    }
    if (st) { enc.copyBufferToBuffer(this._statsBuf, 0, st.buf, 0, GD_STAT_WORDS * 4); st.busy = true; st.frame = this._frame; this._pendingRead = st; }
    if (this._verifyWanted && !this._verifyBusy && this._argsBuf && this._nOrder > 0) {
      const bytes = this._nPos * GD_ARGS_BYTES;
      if (!this._verifyStaging || this._verifyStaging.size < bytes) {
        this._verifyStaging?.destroy();
        this._verifyStaging = this.host.device.createBuffer({ label: 'GdVerifyRead', size: Math.max(bytes, 256), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      }
      enc.copyBufferToBuffer(this._argsBuf, 0, this._verifyStaging, 0, bytes);
      this._verifyBusy = true; this._verifyWanted = false; this._verifyArm = true;
    }
  }
  private _pendingRead: { buf: GPUBuffer; busy: boolean; frame: number } | null = null;
  private _verifyArm = false;
  private _overChecked = -1;
  /** A read-back state snapshot (words 0..n-1, taken at the start of a frame's cull): each record's IN bits. */
  private _applySnapshot(a: Uint32Array, n: number): void {
    const s = this._inSnap;
    for (let r = 0; r < n; r++) s[r] = (a[r] / GD_STATE_IN_FAR) & 7;
    s.fill(0, n);
  }

  /** After the encoder holding `encode` was submitted: start the async reads. */
  afterSubmit(): void {
    const st = this._pendingRead;
    this._pendingRead = null;
    if (st) {
      const fr = st.frame;
      st.buf.mapAsync(GPUMapMode.READ).then(() => {
        const a = new Uint32Array(st.buf.getMappedRange());
        if (fr > this._lastFrame && fr > this._statsFloor) { this._last.set(a); this._lastFrame = fr; }
        st.buf.unmap(); st.busy = false;
      }).catch(() => { st.busy = false; });
    }
    if (this._snapArm > 0 && this._snapStaging) {
      const buf = this._snapStaging, n = this._snapArm, sf = this._snapCopied;
      this._snapArm = 0;
      buf.mapAsync(GPUMapMode.READ, 0, n * 4).then(() => {
        const a = new Uint32Array(buf.getMappedRange(0, n * 4));
        if (sf > this._snapFrame && n <= this._inSnap.length) { this._applySnapshot(a, n); this._snapFrame = sf; }
        buf.unmap(); this._snapBusy = false;
      }).catch(() => { this._snapBusy = false; if (this._snapCopied === sf) this._snapCopied = -1; });
    }
    if (this._verifyArm && this._verifyStaging) {
      this._verifyArm = false;
      const buf = this._verifyStaging, n = this._nOrder, np = this._nPos, exp = this._verifyExpect, ids = this._verifyIds, fr = this._verifyFrame, cb = this._verifyCb;
      const first = this._verifyFirst!, wid = this._verifyWid!, omit = this._verifyOmit;
      buf.mapAsync(GPUMapMode.READ, 0, np * GD_ARGS_BYTES).then(() => {
        const a = new Uint32Array(buf.getMappedRange(0, np * GD_ARGS_BYTES));
        const res: GdVerifyResult = { frame: fr, checked: n, missing: 0, extra: 0, missingIds: [], extraIds: [], omitted: 0, omittedDrawn: 0 };
        for (let p = 0; p < n; p++) {
          let gpu = false;
          for (let k = 0; k < wid[p]; k++) { const q = (first[p] + k) * 5; if (a[q + 1] > 0 && a[q] > 0) gpu = true; }
          // a left-out sub-bundle draws nothing, whatever its arguments say
          if (omit && omit[p]) { res.omitted++; if (gpu) res.omittedDrawn++; gpu = false; }
          const cpu = !!exp && exp[p] === 1;
          if (cpu && !gpu) { res.missing++; if (res.missingIds.length < 20) res.missingIds.push(ids[p]); }
          else if (gpu && !cpu) { res.extra++; if (res.extraIds.length < 20) res.extraIds.push(ids[p]); }
        }
        buf.unmap(); this._verifyBusy = false;
        cb?.(res);
      }).catch(() => { this._verifyBusy = false; });
    }
  }

  /** Request one verification: the next frame's GPU verdicts vs the CPU lists (the renderer builds the full CPU lists
   *  on a verify frame). `cb` gets the mismatches: missing = the CPU path draws it, the GPU culled it (an error);
   *  extra = the GPU draws a record the CPU culled (only the CPU occlusion cull may do that; harmless). */
  requestVerify(cb: (r: GdVerifyResult) => void): void { this._verifyWanted = true; this._verifyCb = cb; }
  get verifyPending(): boolean { return this._verifyWanted; }
  /** Called by the renderer on a verify frame after the loop: the CPU verdict per draw-order position. */
  captureVerifyExpect(): void {
    if (!this._verifyWanted) return;
    const n = this._nOrder;
    const exp = new Uint8Array(n), ids: string[] = new Array(n);
    for (let p = 0; p < n; p++) {
      const r = this._order[p], o = this._obj[r] as (Tagged & { id: string }) | null;
      ids[p] = o ? o.id : '?';
      if (!o || this._seen[r] !== this._frame) continue;
      if (this._recU[r * GD_REC_WORDS + GdRecW.indexCount] === 0 || this._recU[r * GD_REC_WORDS + GdRecW.count] === 0) continue;
      exp[p] = this._vis[r] === this._frame ? 1 : 0;
    }
    this._verifyExpect = exp; this._verifyIds = ids; this._verifyFrame = this._frame;
    const first = new Uint32Array(n), wid = new Uint8Array(n), omit = new Uint8Array(n);
    const sel = this._segOn && this._segSelFrame === this._frame;
    for (let p = 0; p < n; p++) {
      const r = this._order[p]; first[p] = this._pos[r]; wid[p] = this._wid[r];
      if (sel) { const sg = this._segOfRec[r]; omit[p] = sg >= 0 && this._segKeep[sg] === 0 ? 1 : 0; }
    }
    this._verifyFirst = first; this._verifyWid = wid; this._verifyOmit = omit;
  }

  /** The visit order check: a record seen out of its prepass-bundle rank (or without one) re-records the bundles. */
  private _visitSeq(r: number): void {
    this._inSeq[r] = this._seq++;
    if (this._isGroup[r] && !this._inPrepass(r)) return;
    const k = this._inRank[r];
    if (k <= this._lastRank) this._inVer++;   // includes k = -1 (not in the bundles yet)
    else this._lastRank = k;
  }
  /** The mesh id whose geometry a record draws (a group: its source). */
  private _srcId(r: number): string { return this._isGroup[r] ? (this._srcRef[r] as Mesh3D).id : (this._obj[r] as Mesh3D).id; }
  /** Is record `r` part of the depth-style prepass set (the CPU's opaqueForPasses rule: an instanced group with more
   *  than one copy only when its source opts into instanced shadows)? */
  private _inPrepass(r: number): boolean {
    if (!this._isGroup[r]) return true;
    return this._count[r] <= 1 || !!(this._srcRef[r] as Mesh3D | null)?.castsInstancedShadow;
  }
  private _orderVer = 0;
  private readonly _passBundles = new Map<string, { bundle: GPURenderBundle; ver: number; inVer: number; pipe: unknown; bg: unknown; vb: unknown; ib: unknown; args: unknown; fmt: string }>();
  private _passOrder = new Uint32Array(0);
  private _passN = 0;
  private _passOrderVer = -1;
  private _passOrderInVer = -1;
  /** The prepass bundles' record order: ordered prepass records by this frame's visit (the CPU's pass-list order);
   *  records not seen this frame (drawn with 0 instances) after them. Ranks feed the visit check above. */
  private _buildPassOrder(): void {
    const n = this._nOrder, fr = this._frame;
    if (this._passOrder.length < n) this._passOrder = new Uint32Array(this._cap);
    const seen: number[] = [], unseen: number[] = [];
    for (let p = 0; p < n; p++) { const r = this._order[p]; this._inRank[r] = -1; if (!this._inPrepass(r)) continue; if (this._seen[r] === fr) seen.push(r); else unseen.push(r); }
    seen.sort((a, b) => this._inSeq[a] - this._inSeq[b]);
    let k = 0;
    for (const r of seen) { this._inRank[r] = k; this._passOrder[k++] = r; }
    for (const r of unseen) this._passOrder[k++] = r;
    this._passN = k;
    this._passOrderVer = this._orderVer; this._passOrderInVer = this._inVer;
  }
  /**
   * PHASE B PREPASSES: replay this frame's culled records into a depth-style prepass (outline depth + normal, the
   * SSAO / SSR G-buffer, the SSR depth peel) from a render bundle of drawIndexedIndirect over the SAME argument blocks
   * the main pass draws (the camera frustum is the same), re-recorded only when the order, the pipeline, the bind
   * group or the pool buffers change. Records are drawn in the CPU pass list's order (the roster order, then groups:
   * coplanar surfaces that tie in depth resolve as on the CPU path); only the CPU-drawn rest (multi-material,
   * vertex-coloured, unplaced meshes) moves behind them. False = not available this frame (the caller replays
   * the CPU runs for everything); a still-compiling pipeline draws nothing (as the CPU path skips its draws).
   * The caller then draws the entries `prepassDraws` says the bundle does not cover (non-records, orphans).
   */
  drawPrepass(pass: GPURenderPassEncoder, kind: string, pipeline: GPURenderPipeline | null, bg0: GPUBindGroup, colorFormats: GPUTextureFormat[], depthFormat: GPUTextureFormat): boolean {
    if (!this._dispatched || !this._argsBuf) return false;
    if (!pipeline) return true;
    const host = this.host, { vb, ib } = host.geomBuffers();
    if (!vb || !ib) return false;
    const fmt = colorFormats.join(',') + '|' + depthFormat;
    let c = this._passBundles.get(kind);
    if (this._passOrderVer !== this._orderVer || this._passOrderInVer !== this._inVer) this._buildPassOrder();
    if (!c || c.ver !== this._orderVer || c.inVer !== this._passOrderInVer || c.pipe !== pipeline || c.bg !== bg0 || c.vb !== vb || c.ib !== ib || c.args !== this._argsBuf || c.fmt !== fmt || GpuDrivenMain._twinStale(c)) {
      const t0 = performance.now();
      const enc = host.device.createRenderBundleEncoder({ label: 'GdPrepass:' + kind, colorFormats, depthStencilFormat: depthFormat, sampleCount: 1 });
      enc.setIndexBuffer(ib, 'uint32');
      enc.setPipeline(pipeline);
      enc.setBindGroup(0, bg0);
      let cur: GPUBuffer | null = null;
      const st = GpuDrivenMain._fmtState();
      for (let p = 0; p < this._passN; p++) {
        const r = this._passOrder[p];
        if (!this._fmtBind(enc, st, r, pipeline, ib)) continue;   // P22
        const v = (this._code[r] & GD_CODE_VB_OVERRIDE) ? (host.vbOverride(this._srcId(r)) ?? vb) : vb;
        if (v !== cur) { enc.setVertexBuffer(0, v); cur = v; }
        for (let k = 0, q = this._pos[r]; k < this._wid[r]; k++) enc.drawIndexedIndirect(this._argsBuf, (q + k) * GD_ARGS_BYTES);
      }
      c = { bundle: enc.finish(), ver: this._orderVer, inVer: this._passOrderInVer, pipe: pipeline, bg: bg0, vb, ib, args: this._argsBuf, fmt };
      GpuDrivenMain._twinMark(c, st);
      this._passBundles.set(kind, c);
      this.stats.prepassRecords++;
      this.stats.msPrepassBundle = performance.now() - t0;
    }
    pass.executeBundles([c.bundle]);
    return true;
  }
  /** After drawPrepass: does its bundle draw `o` (a mesh or group entry of the CPU's pass list)? */
  prepassDraws(o: { _gdOwner: unknown; _gdRec: number }): boolean {
    return this.drawsObject(o) && this._inPrepass(o._gdRec);
  }

  /** Replay the main-pass records into `pass` (the CPU segment's place). False = nothing recorded (caller falls back). */
  draw(pass: GPURenderPassEncoder): boolean {
    if (!this._dispatched || !this._argsBuf) return false;
    if (this.stats.mode === 'mdi') {
      const args = this._argsBuf;
      let ib: unknown = null, vb: unknown = null, ipk = false, tan = false;
      for (const b of this._buckets) {
        if (!b.pipeline) continue;
        const pk = (b.code & GD_CODE_PACKED) !== 0;   // P22: a packed bucket (twin pipeline, uint16 indices, tangent in slot 1)
        if (b.ib !== ib || pk !== ipk) { pass.setIndexBuffer(b.ib as GPUBuffer, pk ? 'uint16' : 'uint32'); ib = b.ib; ipk = pk; }
        if (pk && !tan) { pass.setVertexBuffer(1, constTangentBuffer(this.host.device)); tan = true; }
        if (b.vb !== vb) { pass.setVertexBuffer(0, b.vb as GPUBuffer); vb = b.vb; }
        pass.setPipeline(b.pipeline as GPURenderPipeline);
        pass.setBindGroup(0, b.bg0 as GPUBindGroup);
        if (b.bg1) pass.setBindGroup(1, b.bg1 as GPUBindGroup);
        if (b.bg2) pass.setBindGroup(2, b.bg2 as GPUBindGroup);
        (pass as unknown as { multiDrawIndexedIndirect(buf: GPUBuffer, off: number, max: number): void }).multiDrawIndexedIndirect(args, b.posStart! * GD_ARGS_BYTES, b.posEnd! - b.posStart!);
      }
      return true;
    }
    if (this._segOn) {
      // sub-bundles: the ones selectSegments kept this frame (all of them when it did not run), in draw order
      pass.executeBundles(this._segSelFrame === this._frame ? this._kept : (this._grpBundles.length ? this._grpBundles[this._grpBundles.length - 1] : this._segBundles));
      return true;
    }
    if (!this._bundle) return false;
    pass.executeBundles([this._bundle]);
    return true;
  }

  /** Last read-back counters (one or more frames old: `stats.age`). */
  readStats(): GdStats {
    const s = this.stats, a = this._last;
    s.records = this._slots.high - this._slots.freeCount; s.ordered = this._nOrder; s.buckets = this._buckets.length;
    s.draws = a[GdStat.draws]; s.tris = Math.max(0, a[GdStat.tris] - a[GdStat.rangeTris]); s.instances = a[GdStat.instances]; s.rangeTris = a[GdStat.rangeTris];
    s.meshesCulled = a[GdStat.meshesCulled]; s.groupsCulled = a[GdStat.groupsCulled]; s.instancesCulled = a[GdStat.instancesCulled];
    s.lodHidden = a[GdStat.lodHidden]; s.lodTris = a[GdStat.lodTris]; s.fogHidden = a[GdStat.fogHidden]; s.fogTris = a[GdStat.fogTris];
    s.forcedVisible = a[GdStat.forcedVisible]; s.forcedTris = a[GdStat.forcedTris]; s.enabled = a[GdStat.enabled];
    s.age = this._lastFrame < 0 ? -1 : this._frame - this._lastFrame;
    for (let k = 0; k < 3; k++) { s.shLeave[k] = a[GdStat.shLeave + k]; s.shJoin[k] = a[GdStat.shJoin + k]; s.shJoinTris[k] = a[GdStat.shJoinTris + k]; }
    s.shFrame = this._lastFrame; s.shadowsOn = this._shOn;
    for (let j = 0; j < 3; j++) s.shCount[j] = a[GdStat.shCompact + j];
    // a count past the K its frame drew would be a lost caster (the bound is an upper bound by construction: must stay 0)
    const lf = this._lastFrame;
    if (lf >= 0 && lf !== this._overChecked && this._shKHistFrame[lf & 7] === lf) {
      this._overChecked = lf;
      for (let j = 0; j < 3; j++) if (a[GdStat.shCompact + j] > this._shKHist[(lf & 7) * 3 + j]) { s.shCompactOver++; break; }
    }
    return s;
  }

  /** Forget every record (switch off / document load): the next frame rebuilds from scratch. */
  reset(): void {
    this._dead = 0;
    // §P15 stats fix: the read-back counters described the forgotten records (a cleared city's 2 k draws kept showing)
    this._last.fill(0); this._lastFrame = -1; this._statsFloor = this._frame;
    for (let r = 0; r < this._obj.length; r++) { const o = this._obj[r] as Tagged | null; if (o && o._gdOwner === this) { o._gdOwner = null; o._gdRec = -1; } }
    this._obj.length = 0; this._alloc.length = 0; this._boxRef.length = 0; this._texRef.length = 0;
    this._slots.reset(); this._nOrder = 0; this._nPos = 0; this._buckets = []; this._bundle = null; this._bundleDirty = true; this._passBundles.clear(); this._orderVer++;
    this._shBundles.clear(); this._freed++;
    this._cmpBundles.clear(); this._ovList = []; this._ovVer++; this._snapFrame = -1; this._snapCopied = -1;
    this._rangeTab.length = 0; this._nRanged = 0; this._boxHigh = 0; this._boxLive = 0; this._boxDirty.length = 0; this._nJobs = 0; this._jobsDirty = false; this._layoutDirty = false;
    this._wid.fill(1);
    this._segs = []; this._segBundles = []; this._grpBundles = []; this._segOn = false; this._kept.length = 0; this._segOfRec.fill(-1); this._segBoxAll = true; this._segBoxDirty.length = 0;
    this._structDirty = true; this._fullNow = true; this._why = 'reset'; this._rankVer = -1;
  }

  destroy(): void {
    this.reset();
    for (const b of [this._recBuf, this._ctlBuf, this._stateBuf, this._posBuf, this._argsBuf, this._statsBuf, this._frameBuf, this._verifyStaging, this._boxBuf, this._jobBuf, this._snapStaging]) b?.destroy();
    for (const s of this._staging) s.buf.destroy();
    this._staging.length = 0;
  }

  // ── structure ──────────────────────────────────────────────────────────────────────────────────────────────────

  private _ensureCap(n: number): boolean {
    if (n <= this._cap) return false;
    const cap = Math.max(1024, Math.ceil(n * 1.5));
    const grow = <T extends Float32Array | Uint32Array | Int32Array | Float64Array>(a: T, len: number, C: new (n: number) => T): T => { const b = new C(len); b.set(a.subarray(0, Math.min(a.length, len)) as unknown as ArrayLike<number> & T); return b; };
    const buf = new ArrayBuffer(cap * GD_REC_BYTES);
    const rf = new Float32Array(buf); rf.set(this._rec);
    this._rec = rf; this._recU = new Uint32Array(buf); this._recI = new Int32Array(buf);
    this._ctl = grow(this._ctl, cap, Uint32Array); this._state = grow(this._state, cap, Uint32Array); this._pos = grow(this._pos, cap, Uint32Array);
    this._matVer = grow(this._matVer, cap, Float64Array); this._slot = grow(this._slot, cap, Int32Array);
    this._dd = grow(this._dd, cap, Float64Array); this._ddb = grow(this._ddb, cap, Float64Array);
    this._fog = grow(this._fog, cap, Int32Array); this._code = grow(this._code, cap, Int32Array); this._count = grow(this._count, cap, Int32Array);
    this._seen = grow(this._seen, cap, Int32Array); this._synced = grow(this._synced, cap, Int32Array); this._vis = grow(this._vis, cap, Int32Array);
    this._visit = grow(this._visit, cap, Int32Array);
    { const c2 = new Uint16Array(cap); c2.set(this._cpuBits); this._cpuBits = c2; }
    this._dynUntil = grow(this._dynUntil, cap, Int32Array); this._noreach = grow(this._noreach, cap, Int32Array);
    { const s2 = new Uint8Array(cap); s2.set(this._shf); this._shf = s2; }
    { const s2 = new Uint8Array(cap); s2.set(this._inSnap); this._inSnap = s2; const l2 = new Uint8Array(cap); l2.set(this._lbOut); this._lbOut = l2; }
    this._seedF = grow(this._seedF, cap, Int32Array);
    { const v2 = new Int32Array(cap).fill(-1); v2.set(this._lbVer); this._lbVer = v2; }
    for (let k = 0; k < 2; k++) {
      const o2 = new Uint8Array(cap); o2.set(this._cbOut[k]); this._cbOut[k] = o2;
      const v2 = new Int32Array(cap).fill(-1); v2.set(this._cbVer[k]); this._cbVer[k] = v2;
    }
    this._inSeq = grow(this._inSeq, cap, Int32Array); this._inRank = grow(this._inRank, cap, Int32Array);
    this._takenR = grow(this._takenR, cap, Int32Array);
    { const s2 = new Int32Array(cap).fill(-1); s2.set(this._segOfRec.subarray(0, Math.min(this._segOfRec.length, cap))); this._segOfRec = s2; }
    this._oi = grow(this._oi, cap, Int32Array); this._boxOff = grow(this._boxOff, cap, Int32Array); this._boxLen = grow(this._boxLen, cap, Int32Array);
    { const w2 = new Uint8Array(cap).fill(1); w2.set(this._wid); this._wid = w2; }
    { const f2 = new Uint8Array(cap); f2.set(this._forced); this._forced = f2; const g2 = new Uint8Array(cap); g2.set(this._isGroup); this._isGroup = g2; }
    this._cap = cap;
    const d = this.host.device;
    for (const b of [this._recBuf, this._ctlBuf, this._stateBuf, this._posBuf, this._argsBuf]) b?.destroy();
    this._recBuf = d.createBuffer({ label: 'GdRecords', size: cap * GD_REC_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this._ctlBuf = d.createBuffer({ label: 'GdCtl', size: cap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this._stateBuf = d.createBuffer({ label: 'GdState', size: cap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this._posBuf = d.createBuffer({ label: 'GdPos', size: cap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    // two argument blocks per record: ranged records own GD_RANGE_SPANS (at most cap / (GD_RANGE_SPANS - 1) of them)
    this._argBlocks = cap * 2;
    // Phase C: then GD_SH_LAYERS x cap shadow blocks (block = argBlocks + layer x cap + record), then the 3 compact
    // dynamic-layer lists (cap slots each; cleared per frame: COPY_DST)
    this._argsBuf = d.createBuffer({ label: 'GdArgs', size: (this._argBlocks + (GD_SH_LAYERS + 3) * cap) * GD_ARGS_BYTES, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this._boxBuf ??= d.createBuffer({ label: 'GdRangeBoxes', size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this._jobBuf ??= d.createBuffer({ label: 'GdRangeJobs', size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this._makeBindGroup();
    // fresh GPU buffers: every record, control, position and (CPU-seeded) state word goes up again
    this._recDirty.markAll(); this._ctlDirty.markAll(); this._stateDirty.markAll(); this._seedF.fill(this._frame); this._posDirty = true;
    this._bundleDirty = true;
    return true;
  }

  private _argBlocks = 0;
  private _shS: GdShadowParams | null = null;
  private _makeBindGroup(): void {
    if (!this._recBuf || !this._argsBuf || !this._boxBuf || !this._jobBuf) return;
    this._bg = this.host.device.createBindGroup({
      layout: this._bgl!,
      entries: [
        { binding: 0, resource: { buffer: this._frameBuf } },
        { binding: 1, resource: { buffer: this._recBuf } },
        { binding: 2, resource: { buffer: this._ctlBuf! } },
        { binding: 3, resource: { buffer: this._stateBuf! } },
        { binding: 4, resource: { buffer: this._argsBuf } },
        { binding: 5, resource: { buffer: this._statsBuf } },
        { binding: 6, resource: { buffer: this._posBuf! } },
        { binding: 7, resource: { buffer: this._jobBuf } },
        { binding: 8, resource: { buffer: this._boxBuf } },
        { binding: 9, resource: { buffer: this._shFrameBuf } },
      ],
    });
  }

  /** Re-derive the record set and the draw order from the renderer's rank (the CPU path's sort, walked in order): one
   *  pass over the ranked meshes (each followed by its groups, in group order), then the unranked tail (input order)
   *  and the groups of unranked sources (group order) — the CPU path's stable sort exactly. Records whose object left
   *  the roster and the rank are freed. */
  private _rebuild(meshes: readonly Mesh3D[], groups: readonly ArrayGroup3D[]): void {
    const host = this.host;
    const stamp = ++this._stamp, fr = this._frame;
    this._dead = 0;   // P17: every record not placed below is freed (noteRemoved)
    const T = this._rbT; T[0] = performance.now();
    // candidate groups = the ones the group loop placed this frame; each source collects its groups in group order
    const candGroups: GroupTagged[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi] as GroupTagged;
      if (g._gdSeen !== fr || !g._gdSrc || !gdGroupCandidate(g._gdSrc as Mesh3D, g._gdN)) continue;
      const src = g._gdSrc as Mesh3D & { _gdGStamp: number; _gdGList: GroupTagged[] };
      if (src._gdGStamp !== stamp) { src._gdGStamp = stamp; src._gdGList = []; }
      src._gdGList.push(g);
      candGroups.push(g);
    }
    if (this._ensureCap(this._slots.high + this._orphans.length + candGroups.length + 1)) this._reseedStates();
    if (this._order.length < this._cap) this._order = new Uint32Array(this._cap);
    T[1] = performance.now();
    let np = 0;
    const take = (o: Tagged & { id: string; _gdTaken: number }, isGroup: boolean, mi: number): void => {
      o._gdTaken = stamp;
      let r = o._gdOwner === this && o._gdRec >= 0 && this._obj[o._gdRec] === (o as unknown) ? o._gdRec : -1;
      if (r < 0) {
        r = this._slots.alloc();
        o._gdOwner = this; o._gdRec = r; this._obj[r] = o as unknown as Mesh3D;
        this._alloc[r] = undefined; this._boxRef[r] = undefined; this._matVer[r] = NaN; this._slot[r] = -2;
        this._isGroup[r] = isGroup ? 1 : 0; this._wid[r] = 1; this._rangeTab[r] = null;
        // this frame's loop already ran: its stamps on the object become the record's
        this._seen[r] = o._gdSeen; this._vis[r] = o._gdVis; this._visit[r] = o._gdVisit; this._synced[r] = fr;
        if (isGroup) this._writeGroupRec(r, o as unknown as GroupTagged, true);
        else this._writeMeshRec(r, o as unknown as Mesh3D, mi, true);
      }
      this._takenR[r] = stamp;
      this._order[np++] = r;
    };
    /** A mesh of the walk: its record if it has one (and is still a candidate), or a new one if it was met this frame. */
    const meshCand = (m: Mesh3D & Tagged & { _gdMatF: number }): boolean => {
      if (m._gdOwner === this && m._gdRec >= 0 && this._obj[m._gdRec] === m) return m._gdMatF !== fr || gdMeshCandidate(m);
      return m._gdSeen === fr && gdMeshCandidate(m);
    };
    const ranked = host.rankedMeshes();
    let stale = 0;
    if (ranked) {
      for (let k = 0; k < ranked.length; k++) {
        const m = ranked[k] as Mesh3D & Tagged & { _gdTaken: number; _gdGStamp: number; _gdGList: GroupTagged[]; _gdMatF: number };
        if (m._gdTaken !== stamp && meshCand(m)) take(m, false, -1);
        if (m._gdGStamp === stamp) { const gs = m._gdGList; for (let j = 0; j < gs.length; j++) if (gs[j]._gdTaken !== stamp) take(gs[j] as never, true, -1); }
      }
      // the unranked tail (meshes added since the last rank update), input order
      for (let i = 0; i < this._orphans.length; i++) { const m = this._orphans[i] as Mesh3D & Tagged & { _gdTaken: number }; if (m._gdTaken !== stamp) take(m, false, -1); }
      for (let r = 0; r < this._slots.high; r++) if (this._obj[r] && this._takenR[r] !== stamp && this._seen[r] === fr && !this._isGroup[r]) stale++;
      if (stale > 0) {   // recorded meshes that lost their rank (a stale rank): the CPU draws them in input order, so do we
        for (let i = 0; i < meshes.length; i++) {
          const m = meshes[i] as Mesh3D & Tagged & { _gdTaken: number; _gdMatF: number };
          if (m._gdTaken !== stamp && this.owns(m) && meshCand(m)) take(m, false, i);
        }
      }
    } else {
      // legacy rank (duplicate ids): sort the candidates by (rank, input position) like the CPU's stable sort
      const items: { k: number; o: Tagged & { id: string }; g: boolean; i: number }[] = [];
      for (let i = 0; i < meshes.length; i++) { const m = meshes[i] as Mesh3D & Tagged & { _gdMatF: number }; if (meshCand(m)) items.push({ k: host.rankOf(m.id) ?? 0x7fffffff, o: m, g: false, i }); }
      let gp = meshes.length;
      for (const g of candGroups) items.push({ k: host.rankOf((g._gdSrc as Mesh3D).id) ?? 0x7fffffff, o: g, g: true, i: gp++ });
      items.sort((a, b) => (a.k - b.k) || (a.i - b.i));
      for (const it of items) if ((it.o as unknown as { _gdTaken: number })._gdTaken !== stamp) take(it.o as never, it.g, it.g ? -1 : it.i);
    }
    // groups whose source has no rank: after every mesh, in group order
    for (let j = 0; j < candGroups.length; j++) if (candGroups[j]._gdTaken !== stamp) take(candGroups[j] as never, true, -1);
    this._nOrder = np;
    T[2] = performance.now();
    // free the records that were not placed (their object left the roster and the rank, or the batched segment)
    for (let r = 0; r < this._slots.high; r++) {
      const o = this._obj[r] as Tagged | null;
      if (o === null || this._takenR[r] === stamp) continue;
      if (o._gdOwner === this && o._gdRec === r) { o._gdOwner = null; o._gdRec = -1; }
      this._obj[r] = null; this._alloc[r] = null; this._boxRef[r] = null; this._texRef[r] = null; this._srcRef[r] = null;
      this._takenR[r] = -1;
      if (this._rangeTab[r]) this._dropRanges(r);
      this._wid[r] = 1;
      if (this._shf[r]) this._freed++;
      this._shf[r] = 0;
      this._slots.free(r);
      if (this._ctl[r] !== 0) { this._ctl[r] = 0; this._ctlDirty.mark(r); }
    }
    T[3] = performance.now();
    this._positions();
    T[4] = performance.now();
    this._rebucket();
    T[5] = performance.now();
    const P = this.stats.rebuildParts;
    for (let k = 0; k < 5; k++) P[k] += T[k + 1] - T[k];
  }

  /** Positions: ordered records 0..n-1 (draw order); every other record a spare position from the top (unique, never
   *  drawn: the compute pass writes its zero args there). */
  private _positions(): void {
    const pos = this._pos, oi = this._oi, wid = this._wid, np = this._nOrder, high = this._slots.high;
    let spare = this._argBlocks;   // spare blocks are taken from the top, `wid` at a time
    for (let r = 0; r < high; r++) oi[r] = -1;
    let q = 0;
    for (let p = 0; p < np; p++) { const r = this._order[p]; oi[r] = p; pos[r] = q; q += wid[r]; }
    this._nPos = q;
    for (let r = 0; r < high; r++) if (oi[r] < 0) { spare -= wid[r]; pos[r] = spare; }
    this._posDirty = true;
    this._layoutDirty = false;
    this._orderVer++;
    for (const b of this._buckets) this._bucketPos(b);
  }

  private _rebucket(): void {
    const host = this.host;
    this._buckets = gdBuckets(this._order.subarray(0, this._nOrder), (r) => this._code[r], (r) => this._texRef[r], (r) => host.vbOverride(this._srcId(r)));
    for (const b of this._buckets) this._bucketPos(b);
    this._bundleDirty = true;
  }
  /** A bucket's argument-block range (multi-draw-indirect draws it in one call). */
  private _bucketPos(b: GdBucket): void {
    if (b.end <= b.start) { b.posStart = b.posEnd = 0; return; }
    const last = this._order[b.end - 1];
    b.posStart = this._pos[this._order[b.start]]; b.posEnd = this._pos[last] + this._wid[last];
  }

  // ── P11 ranges (Phase B) ──────────────────────────────────────────────────────────────────────────────────────
  /** Draw-list loop, a ranged-eligible record (a heavy single-material mesh while the CPU's range culling is on):
   *  `rg` = its current run table (Renderer3D._rangesFor's cache) or null. A new table goes into the box pool and
   *  the job list; gaining / losing one changes the record's width (the positions re-derive, the bundle re-records). */
  syncRanges(r: number, rg: CullRanges | null): void {
    // (P22 propCull: an instanced group takes an INSTANCE-run table, a mesh an index-run one)
    if (!GpuDrivenMain.ranges || (rg && !!rg.inst !== !!this._isGroup[r]) || (rg && (rg.n > GD_RANGE_MAX_RUNS || rg.n < 1))) rg = null;
    const cur = this._rangeTab[r] ?? null;
    if (rg === cur) return;
    if (rg && !cur && this._nRanged >= Math.floor(this._cap / (GD_RANGE_SPANS - 1)) - 1) return;   // argument blocks: 2 x cap
    if (cur) this._dropRanges(r);
    if (rg) {
      const len = gdRangeBoxFloats(rg.n, rg.blockRuns);
      const off = this._boxAlloc(len);
      packGdRangeBoxes(this._boxPool, off, rg);
      this._boxOff[r] = off; this._boxLen[r] = len; this._boxLive += len;
      if (!this._boxAll) this._boxDirty.push(off, len);
      this._rangeTab[r] = rg; this._nRanged++;
    }
    this._jobsDirty = true;
    const w = rg ? GD_RANGE_SPANS : 1;
    if (w !== this._wid[r]) { this._wid[r] = w; this._layoutDirty = true; }
  }
  private _dropRanges(r: number): void {
    if (!this._rangeTab[r]) return;
    this._rangeTab[r] = null; this._nRanged--; this._boxLive -= this._boxLen[r]; this._boxLen[r] = 0;
    this._jobsDirty = true;
    if (this._wid[r] !== 1) { this._wid[r] = 1; this._layoutDirty = true; }
  }
  /** Bump-allocate `len` floats of the box pool; compacts (and grows) it when the top is reached. */
  private _boxAlloc(len: number): number {
    if (this._boxHigh + len > this._boxPool.length) {
      const live = this._boxLive + len;
      const cap = Math.max(1 << 16, this._boxPool.length, Math.ceil(live * 2));
      const np = new Float32Array(cap);
      let hi = 0;
      for (let r = 0; r < this._slots.high; r++) {
        if (!this._rangeTab[r]) continue;
        np.set(this._boxPool.subarray(this._boxOff[r], this._boxOff[r] + this._boxLen[r]), hi);
        this._boxOff[r] = hi; hi += this._boxLen[r];
      }
      this._boxPool = np; this._boxHigh = hi; this._boxAll = true; this._boxDirty.length = 0; this._jobsDirty = true;
      if (!this._boxBuf || this._boxBuf.size < cap * 4) {
        this._boxBuf?.destroy();
        this._boxBuf = this.host.device.createBuffer({ label: 'GdRangeBoxes', size: cap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this._makeBindGroup();
      }
    }
    const off = this._boxHigh; this._boxHigh += len;
    return off;
  }
  /** The job list (one per ranged record), rebuilt when a table came or went. */
  private _buildJobs(): void {
    this._jobsDirty = false;
    let n = 0;
    if (this._jobs.length < this._nRanged * GD_JOB_WORDS) this._jobs = new Uint32Array(Math.max(64, this._nRanged * 2) * GD_JOB_WORDS);
    const J = this._jobs;
    for (let r = 0; r < this._slots.high; r++) {
      const rg = this._rangeTab[r];
      if (!rg) continue;
      const o = n * GD_JOB_WORDS;
      J[o + GdJobW.rec] = r; J[o + GdJobW.boxBase] = this._boxOff[r]; J[o + GdJobW.nRuns] = rg.n; J[o + GdJobW.blockRuns] = rg.blockRuns;
      J[o + GdJobW.runIdx] = rg.n > 1 ? rg.first[1] - rg.first[0] : rg.count[0]; J[o + GdJobW.totalIdx] = rg.first[rg.n - 1] + rg.count[rg.n - 1];
      J[o + GdJobW.pad0] = rg.inst ? 1 : 0; J[o + GdJobW.pad1] = 0;   // P22 propCull: 1 = instance runs (cs_ranges writeSpanInst)
      n++;
    }
    this._nJobs = n;
    if (!this._jobBuf || this._jobBuf.size < Math.max(1, n) * GD_JOB_WORDS * 4) {
      this._jobBuf?.destroy();
      this._jobBuf = this.host.device.createBuffer({ label: 'GdRangeJobs', size: Math.max(64, n * 2) * GD_JOB_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this._makeBindGroup();
    }
    if (n > 0) this.host.device.queue.writeBuffer(this._jobBuf, 0, J.buffer, 0, n * GD_JOB_WORDS * 4);
    this.stats.ranged = n;
  }

  /** O(new): place this frame's orphan meshes at their rank position (after the nearest ranked predecessor that has a
   *  record, and after that predecessor's groups). An orphan that cannot be placed this way (no rank yet, no recorded
   *  predecessor within reach) waits for the next full rebuild (the CPU draws it meanwhile). Returns how many. */
  private _insertOrphans(): number {
    const host = this.host;
    const ranked = host.rankedMeshes();
    if (!ranked) { this._dirty('orphan', false); return 0; }
    let placed = 0;
    const fr = this._frame;
    for (let i = 0; i < this._orphans.length; i++) {
      const m = this._orphans[i] as Mesh3D & Tagged & { _gdTaken: number };
      if (this.owns(m)) continue;
      const q = host.rankOf(m.id);
      if (q === undefined || ranked[q] !== m) { this._dirty('orphan', false); continue; }
      let p = -1;
      for (let k = q - 1; k >= 0 && k >= q - 256; k--) {
        const pm = ranked[k] as Mesh3D & Tagged & { _gdGStamp: number; _gdGList: GroupTagged[] | null };
        let after = -1;
        if (this.owns(pm) && this._oi[pm._gdRec] >= 0) after = this._oi[pm._gdRec];
        const gs = pm._gdGList;
        if (gs) for (let j = 0; j < gs.length; j++) { const g = gs[j]; if (this.owns(g) && this._oi[g._gdRec] > after) after = this._oi[g._gdRec]; }
        if (after >= 0) { p = after + 1; break; }
        if (k === 0) p = 0;   // no recorded predecessor at all: the very front
      }
      if (q === 0) p = 0;
      if (p < 0) { this._dirty('orphan', false); continue; }
      if (this._slots.high + 1 > this._cap || this._nOrder + 1 > this._cap) { if (this._ensureCap(this._slots.high + 64)) this._reseedStates(); }
      if (this._order.length < this._cap) { const no = new Uint32Array(this._cap); no.set(this._order.subarray(0, this._nOrder)); this._order = no; }
      const r = this._slots.alloc();
      m._gdOwner = this; m._gdRec = r; this._obj[r] = m;
      this._alloc[r] = undefined; this._boxRef[r] = undefined; this._matVer[r] = NaN; this._slot[r] = -2;
      this._isGroup[r] = 0; this._takenR[r] = this._stamp; this._wid[r] = 1; this._rangeTab[r] = null;
      this._seen[r] = m._gdSeen; this._vis[r] = m._gdVis; this._visit[r] = m._gdVisit; this._synced[r] = fr;
      this._writeMeshRec(r, m, -1, true);
      this._order.copyWithin(p + 1, p, this._nOrder);
      this._order[p] = r;
      this._nOrder++;
      for (let k = p; k < this._nOrder; k++) this._oi[this._order[k]] = k;   // the next orphan of this batch reads them
      placed++;
    }
    if (placed > 0) { this._positions(); this._rebucket(); }
    return placed;
  }

  /** Fresh GPU state buffer (growth): seed every live record from the CPU's hysteresis (it tracks the same rule). */
  private _reseedStates(): void {
    for (let r = 0; r < this._slots.high; r++) {
      const o = this._obj[r];
      if (!o) { this._state[r] = 0; continue; }
      const isGroup = (this._recU[r * GD_REC_WORDS + GdRecW.flags] & GD_FLAG_GROUP) !== 0;
      this._state[r] = isGroup ? this._groupSeed(o as ArrayGroup3D) : this._meshSeed(o as Mesh3D);
    }
    this._stateDirty.markAll(); this._seedF.fill(this._frame);
  }

  /** Write a mesh record from the mesh (args, box, LOD / fog parameters, state code); `seed` also seeds its state from
   *  the CPU's current hysteresis (a new record). `mi` = its input index (the CPU's slot fallback), -1 = unknown. */
  private _writeMeshRec(r: number, m: Mesh3D, mi: number, seed = false): void {
    const host = this.host;
    host.refresh(m);
    const a = m._r3GA as GdAlloc | undefined;
    const ov = host.vbOverride(m.id);
    const slot = m._r3Slot >= 0 ? m._r3Slot : (mi >= 0 ? mi : Math.max(0, this._slot[r]));
    const box = host.box(m);
    const fog = gdFogFlags(m.fogClass, !!m.material.noFog);
    packGdRecord(this._rec, this._recU, this._recI, r, {
      box, drawDistance: m.drawDistance, drawDistanceBias: m.drawDistanceBias,
      indexCount: a ? a.indexCount : 0, firstIndex: a ? a.firstIndex : 0, baseVertex: a ? (ov ? 0 : a.baseVertex) : 0, firstInstance: slot,
      count: 1, flags: fog,
      twinRole: m.lodTwinRole, twinDist: m.lodTwinDist, twinDist2: m.lodTwinDist2, twinFlags: gdTwinFlags(m), origin: null,
      shFeature: m.shadowFeatureSize, shFlags: GD_SHF_CASTS | (m.material.windSway ? GD_SHF_WIND : 0),
    });
    this._shf[r] = GD_SHF_CASTS; m._gdKSh = m.shadowFeatureSize;
    // the CPU's motion bookkeeping (the map _casterIsDynamic reads): a matrix change starts the mover hold
    if (seed || m.localMatrixVersion !== this._matVer[r]) this._dynUntil[r] = host.casterUntil(m);
    this._alloc[r] = a; this._slot[r] = slot; this._forced[r] = gdMeshForced(m) ? 1 : 0;
    this._matVer[r] = m.localMatrixVersion;
    m._gdKA = a; m._gdKS = slot; m._gdKM = m.localMatrixVersion; m._gdKD = m.drawDistance; m._gdKB = m.drawDistanceBias; m._gdKF = this._forced[r] !== 0;
    m._gdKR = m.lodTwinRole; m._gdKT = m.lodTwinDist; m._gdKT2 = m.lodTwinDist2; m._gdKX = gdTwinFlags(m) | (m.lodTwinExternal ? 4 : 0);
    this._dd[r] = m.drawDistance; this._ddb[r] = m.drawDistanceBias; this._fog[r] = fog; this._count[r] = 1;
    const code = host.stateCode(m), tk = host.texKey(m, code);
    if (!seed && (code !== this._code[r] || tk !== this._texRef[r])) this._dirty('meshBucket');   // another bucket
    this._code[r] = code;
    this._texRef[r] = tk;
    this._boxRef[r] = null;
    this._recDirty.mark(r); this._lbVer[r] = -1; this._cbVer[0][r] = -1; this._cbVer[1][r] = -1;   // (the compaction bound's cached box verdicts)
    this._segTouch(r);
    this.stats.recordWrites++;
    if (seed) { this._state[r] = this._meshSeed(m); this._stateDirty.mark(r); this._seedF[r] = this._frame; this._ctl[r] = 0; this._ctlDirty.mark(r); this.cpuMesh(r, m); }
  }
  /** A new record's GPU state from the CPU's hysteresis (it tracks the same rules). VISITED_LAST is set: the record's
   *  first evaluation is this frame's, which the CPU loop already applied (the rules are idempotent on one frame). */
  private _meshSeed(m: Mesh3D): number {
    return (m.lodHidden ? GD_STATE_LOD_HIDDEN : 0) | (m.lodTwinNear ? GD_STATE_TWIN_NEAR : 0) | (m.lodTwinNear2 ? GD_STATE_TWIN_NEAR2 : 0) | GD_STATE_VISITED_LAST;
  }
  private _groupSeed(g: ArrayGroup3D): number {
    return (this.host.groupLodHidden(g) ? GD_STATE_LOD_HIDDEN : 0) | (this.host.groupTwinNear(g) ? GD_STATE_TWIN_NEAR : 0) | GD_STATE_VISITED_LAST;
  }

  private _writeGroupRec(r: number, g: GroupTagged, seed = false, knownBox?: ArrayLike<number> | null): void {
    const host = this.host;
    const src = g._gdSrc!;
    host.refresh(src);
    const a = src._r3GA as GdAlloc | undefined;
    const ov = host.vbOverride(src.id);
    const bx = knownBox !== undefined ? knownBox : host.groupBox(g, src);
    this._srcRef[r] = src;
    const box = bx ? { minX: bx[0], minY: bx[1], minZ: bx[2], maxX: bx[3], maxY: bx[4], maxZ: bx[5] } : null;
    const fog = gdFogFlags(src.fogClass, !!src.material.noFog);
    packGdRecord(this._rec, this._recU, this._recI, r, {
      box, drawDistance: src.drawDistance, drawDistanceBias: src.drawDistanceBias,
      indexCount: a ? a.indexCount : 0, firstIndex: a ? a.firstIndex : 0, baseVertex: a ? (ov ? 0 : a.baseVertex) : 0, firstInstance: g._gdFirst,
      count: g._gdN, flags: fog | GD_FLAG_GROUP,
      twinRole: src.lodTwinRole, twinDist: src.lodTwinDist, twinDist2: src.lodTwinDist2, twinFlags: gdTwinFlags(src), origin: host.groupOrigin(g),
      shFeature: src.shadowFeatureSize, shFlags: (src.castsInstancedShadow ? GD_SHF_CASTS : 0) | (src.material.windSway ? GD_SHF_WIND : 0),
    });
    this._shf[r] = src.castsInstancedShadow ? GD_SHF_CASTS : 0; this._dynUntil[r] = -1;
    this._alloc[r] = a; this._slot[r] = g._gdFirst; this._boxRef[r] = bx; this._matVer[r] = src.localMatrixVersion; this._forced[r] = gdGroupForced(src) ? 1 : 0;
    g._gdKA = a; g._gdKS = g._gdFirst; g._gdKN = g._gdN; g._gdKSrc = src; g._gdKD = src.drawDistance; g._gdKB = src.drawDistanceBias; g._gdKBox = bx; g._gdKC = src.castsInstancedShadow;
    this._dd[r] = src.drawDistance; this._ddb[r] = src.drawDistanceBias; this._fog[r] = fog; this._count[r] = g._gdN;
    const code = host.stateCode(src), tk = host.texKey(src, code);
    if (!seed && (code !== this._code[r] || tk !== this._texRef[r])) this._dirty('groupBucket');
    this._code[r] = code;
    this._texRef[r] = tk;
    this._recDirty.mark(r); this._lbVer[r] = -1; this._cbVer[0][r] = -1; this._cbVer[1][r] = -1;   // (the compaction bound's cached box verdicts)
    this._segTouch(r);
    this.stats.recordWrites++;
    if (seed) {
      this._state[r] = this._groupSeed(g); this._stateDirty.mark(r); this._seedF[r] = this._frame; this._ctl[r] = 0; this._ctlDirty.mark(r);
      this._cpuBits[r] = (host.groupLodHidden(g) ? GD_CTL_CPU_LOD : 0) | (host.groupTwinNear(g) ? GD_CTL_CPU_N1 : 0);
    }
  }

  /** The end pass (typed arrays only): each ordered record's control word from this frame's stamps. On a frame where
   *  the renderer's alloc / slot maps changed, a record the loop saw but did not re-check (a member of a rejected
   *  cull cluster) is re-checked here, so no record ever draws a stale pool range. */
  private _ctlPass(genChanged: boolean): void {
    const fr = this._frame, ctl = this._ctl, seen = this._seen, vis = this._vis, visit = this._visit, forced = this._forced;
    const sf = this.host.shadowFrame(), dynU = this._dynUntil, nr = this._noreach, cpuSt = GpuDrivenMain.cpuState;
    const order = this._order, n = this._nOrder;
    // the compact shadow lists' bound (shadowCompact): per record, the dynamic layers it MAY be nonzero in this frame
    const cmp = this._shCmp, S = this._shS, F = this._lastF, code = this._code, shf = this._shf, ov = this._ovScratch;
    const hcOn = !!F?.hcOn, isG = this._isGroup, snap = this._inSnap, seedF = this._seedF, sFr = this._snapFrame;
    let inOk = 0;   // the static layers whose IN bits the snapshot holds (no commit since it was taken)
    if (sFr >= 0) for (let k = 0; k < 3; k++) if (this._commitF[k] < sFr) inOk |= 1 << k;
    let b0 = 0, b1 = 0, b2 = 0, calls = 0;
    // fast-path inputs: the layers in play, the frame-wide dynamic reasons, the cached light-box verdicts
    let lay = 0, windOn = false, bandOn = false, joinOn = false;
    const light = cmp ? S!.light : null, lbOut = this._lbOut, lbVer = this._lbVer, recU = this._recU;
    if (cmp) {
      const nC = Math.max(0, Math.min(2, S!.cascades));
      lay = (S!.cache ? 1 : 0) | (S!.split ? (nC >= 1 ? 2 : 0) | (nC >= 2 ? 4 : 0) : 0);
      windOn = S!.wind; bandOn = S!.band; joinOn = S!.join;
      let same = !!light === this._lbPrevOn;
      if (light) for (let k = 0; same && k < 24; k++) same = light[k] === this._lbPrev[k];
      if (!same) { this._lbEpoch++; this._lbPrevOn = !!light; if (light) for (let k = 0; k < 24; k++) this._lbPrev[k] = light[k]; }
      for (let c = 0; c < 2; c++) {
        const pl = (lay & (2 << c)) ? S!.casc[c] : null, pv = this._cbPrev[c];
        let sm = !!pl === this._cbPrevOn[c];
        if (pl) for (let k = 0; sm && k < 24; k++) sm = pl[k] === pv[k];
        if (!sm) { this._cbEpoch[c]++; this._cbPrevOn[c] = !!pl; if (pl) for (let k = 0; k < 24; k++) pv[k] = pl[k]; }
      }
    }
    const ep = this._lbEpoch, c0 = cmp && (lay & 2) ? S!.casc[0] : null, c1 = cmp && (lay & 4) ? S!.casc[1] : null;
    const cbOut0 = this._cbOut[0], cbOut1 = this._cbOut[1], cbVer0 = this._cbVer[0], cbVer1 = this._cbVer[1], ce0 = this._cbEpoch[0], ce1 = this._cbEpoch[1];
    ov.length = 0;
    let enabled = 0;
    for (let p = 0; p < n; p++) {
      const r = order[p];
      let want = 0;
      // (P22: a packed caster draws with another pipeline than the compacted list's: it takes the own-buffer path too)
      const own = (code[r] & (GD_CODE_VB_OVERRIDE | GD_CODE_PACKED)) !== 0 && (shf[r] & GD_SHF_CASTS) !== 0;
      if (own) ov.push(r);
      if (seen[r] === fr) {
        if (genChanged && this._synced[r] !== fr) this._resync(r);
        // P17: a dissolving HLOD tier is a dynamic caster (fs_shadow dithers it), as on the CPU path (_casterIsDynamic)
        want = GD_CTL_ENABLED | (visit[r] === fr ? GD_CTL_VISITED : 0) | (sf <= dynU[r] || (this._obj[r] as Mesh3D).hlodFade >= 0 ? GD_CTL_DYNAMIC : 0) | (nr[r] === fr ? GD_CTL_NOREACH : 0);
        if (cpuSt && forced[r] === 0) want |= this._cpuBits[r];   // the CPU's LOD / twin state after this frame's loop
        if (forced[r] !== 0) want |= GD_CTL_FORCED | (vis[r] === fr ? GD_CTL_FORCED_VIS : 0);
        if (own) want |= GD_CTL_VB_OV;
        else if (cmp && lay && forced[r] === 0 && (shf[r] & GD_SHF_CASTS) && (isG[r] || !hcOn || (want & GD_CTL_VISITED))) {
          let kin = sFr >= 0 && seedF[r] <= sFr ? snap[r] & inOk : 0;
          // nothing can make it dynamic or a joiner (a committed static caster): no block in any compact list
          const dynP = (want & GD_CTL_DYNAMIC) !== 0 || bandOn || (windOn && (recU[r * GD_REC_WORDS + GdRecW.shFlags] & GD_SHF_WIND) !== 0);
          if (dynP || (joinOn && (kin & lay) !== lay)) {
            let out = 0;
            if (light) { if (lbVer[r] !== ep) { lbOut[r] = gdBoxOutsideLoose(this._rec, recU, r, light) ? 1 : 0; lbVer[r] = ep; } out = lbOut[r]; }
            let excl = 0;
            if (!out) {
              // outside a cascade box: certainly no block in that cascade's list; cached per box epoch (the boxes
              // hold between re-centres)
              if (c0 && (dynP || !(kin & 2))) { if (cbVer0[r] !== ce0) { cbOut0[r] = gdBoxOutsideLoose(this._rec, recU, r, c0) ? 1 : 0; cbVer0[r] = ce0; } if (cbOut0[r]) excl |= 2; }
              if (c1 && (dynP || !(kin & 4))) { if (cbVer1[r] !== ce1) { cbOut1[r] = gdBoxOutsideLoose(this._rec, recU, r, c1) ? 1 : 0; cbVer1[r] = ce1; } if (cbOut1[r]) excl |= 4; }
              if (!dynP && ((kin | excl) & lay) === lay) out = 1;
            }
            if (!out) {
              // the cached box verdicts stand in for the box tests; the reach test is skipped (a looser bound)
              calls++; const m = gdShadowDynMaybe(this._rec, recU, want, r, F!, S!, kin, true, excl);
              if (m) { b0 += m & 1; b1 += (m >> 1) & 1; b2 += m >> 2; }
            }
          }
        }
        enabled++;
      }
      if (ctl[r] !== want) { ctl[r] = want; this._ctlDirty.mark(r); this.stats.ctlWrites++; }
    }
    this.stats.enabled = enabled;
    // the own-vertex-buffer casters (a new list re-records the compact bundles)
    const ol = this._ovList;
    let same = ol.length === ov.length;
    for (let k = 0; same && k < ov.length; k++) same = ol[k] === ov[k];
    if (!same) { this._ovScratch = ol; this._ovList = ov; this._ovVer++; }
    const B = this._shBound, K = this._shK;
    B[0] = b0; B[1] = b1; B[2] = b2; this.stats.shBoundCalls = calls;
    for (let j = 0; j < 3; j++) K[j] = cmp ? gdCompactSize(B[j], this._cap) : 0;
  }

  /** Re-check one record against its object (outside the loop). */
  private _resync(r: number): void {
    const o = this._obj[r];
    if (!o) return;
    this._synced[r] = this._frame;
    if (this._isGroup[r]) {
      const g = o as GroupTagged, src = g._gdSrc as Mesh3D | null;
      if (!src) return;
      this.host.refresh(src);
      if (src._r3GA !== this._alloc[r]) this._writeGroupRec(r, g);
    } else {
      const m = o as Mesh3D;
      this.host.refresh(m);
      if (m._r3GA !== this._alloc[r] || (m._r3Slot >= 0 && m._r3Slot !== this._slot[r])) this._writeMeshRec(r, m, -1);
    }
  }

  /** Re-record the bundle when the order changed or any bucket's pipeline / bind groups / buffers changed. */
  private _checkBundle(): void {
    const host = this.host;
    const resolve = (b: GdBucket, out: GdBucketRefs): void => host.resolve(b.code, this._obj[b.leadRec] as Mesh3D, out);
    const useMdi = host.mdi && GpuDrivenMain.allowMdi && this._buckets.length <= GpuDrivenMain.MDI_MAX_BUCKETS;
    const mode = useMdi ? 'mdi' : 'bundle';
    if (mode !== this.stats.mode) { this._bundleDirty = true; this.stats.mode = mode; }
    if (!this._bundleDirty && !gdBucketsChanged(this._buckets, resolve, this._refScratch)) return;
    const t0 = performance.now();
    let skipped = 0;
    for (const b of this._buckets) {
      resolve(b, b);
      if (!b.pipeline) skipped += b.end - b.start;
    }
    this._bundleSkipped = skipped; this.stats.skippedPending = skipped;
    this._segOn = false; this._segs = []; this._segBundles = []; this._grpBundles = []; this._kept.length = 0; this._segOfRec.fill(-1);
    if (mode === 'bundle' && GpuDrivenMain.subBundles && host.rankCell) {
      // SUB-BUNDLES: one per run of the order in one rank cell (tiny runs merged); each restates its buckets' state
      const order = this._order, cellOf = host.rankCell.bind(host);
      const key = (p: number): number => { const r = order[p]; return cellOf((this._isGroup[r] ? this._srcRef[r] : this._obj[r]) as Mesh3D); };
      const segs = gdSegments(this._nOrder, key, GpuDrivenMain.SUB_MIN_RECORDS);
      const ns = segs.length;
      if (this._segBox.length < ns * 6) { this._segBox = new Float64Array(ns * 12); this._segNoBox = new Uint8Array(ns * 2); this._segBlocks = new Int32Array(ns * 2); this._segKeep = new Uint8Array(ns * 2); }
      let bi = 0;
      for (let si = 0; si < ns; si++) {
        const g = segs[si];
        while (bi < this._buckets.length && this._buckets[bi].end <= g.start) bi++;
        this._segBundles.push(this._encodeRange(g.start, g.end, bi, 'GdMainSub' + si));
        let blocks = 0;
        for (let p = g.start; p < g.end; p++) { const r = order[p]; this._segOfRec[r] = si; blocks += this._wid[r]; }
        this._segBlocks[si] = blocks;
      }
      const GS = Math.max(1, GpuDrivenMain.SUB_GROUP | 0);
      for (let lv = 1, span = GS; GS > 1 && lv <= GpuDrivenMain.SUB_LEVELS && ns > span; lv++, span *= GS) {
        const list: GPURenderBundle[] = [];
        bi = 0;
        for (let g0 = 0; g0 < ns; g0 += span) {
          const a = segs[g0].start, b = segs[Math.min(ns, g0 + span) - 1].end;
          while (bi < this._buckets.length && this._buckets[bi].end <= a) bi++;
          list.push(this._encodeRange(a, b, bi, 'GdMainGroup' + lv + ':' + (g0 / span)));
        }
        this._grpBundles.push(list);
      }
      this._segs = segs; this._segOn = true; this._segBoxAll = true; this._segBoxDirty.length = 0;
      this._bundle = null;
    } else if (mode === 'bundle') {
      this._bundle = this._encodeRange(0, this._nOrder, 0, 'GdMainBundle');
    } else this._bundle = null;
    this.stats.segments = this._segs.length;
    this._bundleDirty = false;
    this.stats.bundleRecords++;
    this.stats.msBundle = performance.now() - t0;
  }

  /** Record the main-pass draws of order positions [start, end) into one bundle (bucket `bi` = the first bucket that
   *  ends past `start`): each bucket's state, then one drawIndexedIndirect per argument block. */
  private _encodeRange(start: number, end: number, bi: number, label: string): GPURenderBundle {
    const host = this.host;
    const enc = host.device.createRenderBundleEncoder({ label, colorFormats: [host.colorFormat], depthStencilFormat: host.depthFormat, sampleCount: 1 });
    const args = this._argsBuf!, B = this._buckets;
    let ib: unknown = null, vb: unknown = null, ipk = false, tan = false;
    for (let k = bi; k < B.length && B[k].start < end; k++) {
      const b = B[k];
      if (!b.pipeline || b.end <= start) continue;
      const pk = (b.code & GD_CODE_PACKED) !== 0;   // P22: a packed bucket (twin pipeline, uint16 indices, tangent in slot 1)
      if (b.ib !== ib || pk !== ipk) { enc.setIndexBuffer(b.ib as GPUBuffer, pk ? 'uint16' : 'uint32'); ib = b.ib; ipk = pk; }
      if (pk && !tan) { enc.setVertexBuffer(1, constTangentBuffer(host.device)); tan = true; }
      if (b.vb !== vb) { enc.setVertexBuffer(0, b.vb as GPUBuffer); vb = b.vb; }
      enc.setPipeline(b.pipeline as GPURenderPipeline);
      enc.setBindGroup(0, b.bg0 as GPUBindGroup);
      if (b.bg1) enc.setBindGroup(1, b.bg1 as GPUBindGroup);
      if (b.bg2) enc.setBindGroup(2, b.bg2 as GPUBindGroup);
      const p0 = Math.max(b.start, start), p1 = Math.min(b.end, end);
      for (let p = p0; p < p1; p++) { const r = this._order[p], q = this._pos[r]; for (let w = 0; w < this._wid[r]; w++) enc.drawIndexedIndirect(args, (q + w) * GD_ARGS_BYTES); }
    }
    return enc.finish();
  }
  /** Append the bundles covering the kept sub-bundles of [s0, s1) at group level `lv` (0 = the sub-bundles). */
  private _cover(lv: number, s0: number, s1: number, out: GPURenderBundle[]): void {
    if (lv === 0) { for (let si = s0; si < s1; si++) if (this._segKeep[si]) out.push(this._segBundles[si]); return; }
    const GS = Math.max(1, GpuDrivenMain.SUB_GROUP | 0);
    let span = 1; for (let k = 0; k < lv; k++) span *= GS;
    for (let g0 = s0; g0 < s1; g0 += span) {
      const g1 = Math.min(s1, g0 + span);
      let n = 0; for (let si = g0; si < g1; si++) n += this._segKeep[si];
      if (n === 0) continue;
      if (n === g1 - g0) out.push(this._grpBundles[lv - 1][g0 / span]);
      else this._cover(lv - 1, g0, g1, out);
    }
  }
  /** A record was rewritten (its box may have moved): its sub-bundle's union box is recomputed before the next selection. */
  private _segTouch(r: number): void {
    if (!this._segOn || this._segBoxAll) return;
    const sg = this._segOfRec[r];
    if (sg >= 0) this._segBoxDirty.push(sg);
  }
  private _segUnion(si: number): void {
    const g = this._segs[si], R = this._rec, U = this._recU, B = this._segBox, o6 = si * 6;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, nb = 0;
    for (let p = g.start; p < g.end; p++) {
      const r = this._order[p], o = r * GD_REC_WORDS;
      if (U[o + GdRecW.flags] & GD_FLAG_NO_BOX) { nb = 1; break; }
      const a0 = R[o + GdRecW.minX], a1 = R[o + GdRecW.minY], a2 = R[o + GdRecW.minZ], b0 = R[o + GdRecW.maxX], b1 = R[o + GdRecW.maxY], b2 = R[o + GdRecW.maxZ];
      if (a0 < x0) x0 = a0; if (a1 < y0) y0 = a1; if (a2 < z0) z0 = a2;
      if (b0 > x1) x1 = b0; if (b1 > y1) y1 = b1; if (b2 > z1) z1 = b2;
    }
    B[o6] = x0; B[o6 + 1] = y0; B[o6 + 2] = z0; B[o6 + 3] = x1; B[o6 + 4] = y1; B[o6 + 5] = z1;
    this._segNoBox[si] = nb;
  }
  /**
   * SUB-BUNDLE SELECTION (after finish, on a frame that dispatches the cull): keep a sub-bundle when one of its
   * records may draw (not gdSkippable from this frame's control words) and its union box is not outside the camera
   * frustum (gdBoxOutside). Both are conservative against the GPU cull: every omitted draw is a zero-instance draw.
   */
  selectSegments(): void {
    if (!this._segOn || !this._lastF) return;
    const t0 = performance.now();
    const F = this._lastF, segs = this._segs, ns = segs.length;
    if (this._segBoxAll) { for (let si = 0; si < ns; si++) this._segUnion(si); this._segBoxAll = false; this._segBoxDirty.length = 0; }
    else if (this._segBoxDirty.length) { for (const si of this._segBoxDirty) if (si < ns) this._segUnion(si); this._segBoxDirty.length = 0; }
    const R = this._rec, U = this._recU, ctl = this._ctl, order = this._order, planes = F.planes;
    const kept = this._kept; kept.length = 0;
    let omitR = 0, omitD = 0;
    for (let si = 0; si < ns; si++) {
      const g = segs[si];
      let keep = false;
      for (let p = g.start; p < g.end; p++) { const r = order[p]; if (!gdSkippable(R, U, ctl[r], r, F)) { keep = true; break; } }
      if (keep && planes && !this._segNoBox[si] && gdBoxOutside(planes, this._segBox, si * 6)) keep = false;
      this._segKeep[si] = keep ? 1 : 0;
      if (!keep) { omitR += g.end - g.start; omitD += this._segBlocks[si]; }
    }
    // the replay list (draw order): the largest group whose members are all kept, else down a level; nothing for a
    // group with no kept member
    this._cover(this._grpBundles.length, 0, ns, kept);
    this._segSelFrame = this._frame;
    const st = this.stats;
    st.segKept = kept.length; st.segOmitRecords = omitR; st.segOmitDraws = omitD; st.segOmitTotal += omitD;
    st.msSegSelect = performance.now() - t0;
  }

  private _upload(F: GdFrameParams): void {
    const q = this.host.device.queue;
    const high = this._slots.high;
    let bytes = 0, ups = 0;
    for (const [lo, cnt] of pairs(this._recDirty.take(high, 32))) { q.writeBuffer(this._recBuf!, lo * GD_REC_BYTES, this._rec.buffer, lo * GD_REC_BYTES, cnt * GD_REC_BYTES); bytes += cnt * GD_REC_BYTES; ups++; }
    for (const [lo, cnt] of pairs(this._ctlDirty.take(high, 256))) { q.writeBuffer(this._ctlBuf!, lo * 4, this._ctl.buffer, lo * 4, cnt * 4); bytes += cnt * 4; ups++; }
    // (contiguous runs only: a bridged gap would overwrite the GPU-owned state of records the CPU did not seed — their
    // hysteresis and static-layer IN bits, which the compaction bound's snapshot vouches for; seeded words are stamped
    // in _seedF where they are marked, before the control pass computes the bound)
    for (const [lo, cnt] of pairs(this._stateDirty.take(high, 1))) { q.writeBuffer(this._stateBuf!, lo * 4, this._state.buffer, lo * 4, cnt * 4); bytes += cnt * 4; ups++; this._seedF.fill(this._frame, lo, lo + cnt); }
    if (this._boxAll) { this._boxAll = false; if (this._boxHigh > 0) { q.writeBuffer(this._boxBuf!, 0, this._boxPool.buffer, 0, this._boxHigh * 4); bytes += this._boxHigh * 4; ups++; } }
    else for (let k = 0; k < this._boxDirty.length; k += 2) { const o = this._boxDirty[k], n = this._boxDirty[k + 1]; q.writeBuffer(this._boxBuf!, o * 4, this._boxPool.buffer, o * 4, n * 4); bytes += n * 4; ups++; }
    this._boxDirty.length = 0;
    if (this._posDirty && high > 0) { q.writeBuffer(this._posBuf!, 0, this._pos.buffer, 0, high * 4); bytes += high * 4; ups++; this._posDirty = false; }
    packGdFrame(this._frameData, F, high, this._frame);
    q.writeBuffer(this._frameBuf, 0, this._frameData);
    if (this._shS) {
      packGdShadowFrame(this._shFrameData, this._shOn ? this._shS : { ...this._shS, on: false }, this._argBlocks, this._cap);
      if (this._shCmp) this._shFrameU[GdShFrameW.ctl] |= GD_SH_COMPACT;
      q.writeBuffer(this._shFrameBuf, 0, this._shFrameData);
    }
    this.stats.uploads += ups; this.stats.uploadBytes += bytes;
  }
}

function* pairs(a: number[]): Generator<[number, number]> { for (let i = 0; i < a.length; i += 2) yield [a[i], a[i + 1]]; }

export { GD_CTL_FORCED, GD_CTL_FORCED_VIS };
