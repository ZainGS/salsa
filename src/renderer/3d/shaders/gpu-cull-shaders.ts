/**
 * GPU-DRIVEN MAIN PASS — the compute cull (performance-plan.md §P15, gpu-driven.ts). One invocation per record:
 * the WGSL twin of gdCullRecord (gpu-driven.ts, unit-tested): the hierarchical-cull reject + twin re-seed (Phase B),
 * fog horizon, distance LOD with its hysteresis state, near / far twins (mesh twins and P8 group twins, Phase B), the
 * frustum (positive-vertex test with a relative epsilon so the GPU never drops a box the CPU path would draw), then
 * one drawIndexedIndirect argument block per record. Counters are summed per workgroup and added once.
 *
 * Phase B adds cs_ranges (P11 cull ranges, one workgroup per ranged record); Phase C cs_shadow (the shadow casters of
 * the records, per layer) and cs_commit (a static shadow layer's drawn set).
 *
 * Layouts (must match gpu-driven.ts; checked by gpu-driven.test.ts): GdRec 112 bytes, GdFrame 160 bytes, args 20
 * bytes per DRAW POSITION (indexCount, instanceCount, firstIndex, baseVertex, firstInstance): record i writes its block
 * at pos[i], its place in the draw order, so a bucket's blocks are contiguous (multi-draw-indirect). No backticks in comments.
 */
export const GPU_CULL_WGSL = /* wgsl */ `
struct GdRec {
  bmin: vec3f, dd: f32,
  bmax: vec3f, ddBias: f32,
  indexCount: u32, firstIndex: u32, baseVertex: i32, firstInstance: u32,
  count: u32, flags: u32, tris: u32, twinRole: u32,
  twinDist: f32, twinDist2: f32, twinFlags: u32, shFeature: f32,
  omin: vec3f, shFlags: u32,
  omax: vec3f, pad2: f32,
};

struct GdFrame {
  planes: array<vec4f, 6>,
  cam: vec4f,
  fog: vec4f,
  lod: vec4f,
  ctl: vec4u,
};

@group(0) @binding(0) var<uniform> F: GdFrame;
@group(0) @binding(1) var<storage, read> recs: array<GdRec>;
@group(0) @binding(2) var<storage, read> ctl: array<u32>;
@group(0) @binding(3) var<storage, read_write> state: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: array<u32>;
@group(0) @binding(5) var<storage, read_write> stats: array<atomic<u32>, 32>;
@group(0) @binding(6) var<storage, read> pos: array<u32>;

var<workgroup> wsum: array<atomic<u32>, 13>;

const CTL_ENABLED: u32 = 1u;
const CTL_FORCED: u32 = 2u;
const CTL_FORCED_VIS: u32 = 4u;
const CTL_VISITED: u32 = 8u;
const CTL_CPU_LOD: u32 = 64u;
const CTL_CPU_N1: u32 = 128u;
const CTL_CPU_N2: u32 = 256u;
const FLAG_FOG_OTHER: u32 = 1u;
const FLAG_FOG_ATTACH: u32 = 2u;
const FLAG_NO_FOG: u32 = 4u;
const FLAG_GROUP: u32 = 8u;
const FLAG_NO_BOX: u32 = 16u;
const ST_LOD_HIDDEN: u32 = 1u;
const ST_FOG_HIDDEN: u32 = 2u;
const ST_TWIN_NEAR: u32 = 4u;
const ST_TWIN_NEAR2: u32 = 8u;
const ST_VISIBLE: u32 = 16u;
const ST_VISITED_LAST: u32 = 32u;
const TWIN_OFF_NEAR: u32 = 1u;
const TWIN_INSTANCED: u32 = 2u;
const TWIN_NO_ORIGIN: u32 = 4u;
const FR_FRUSTUM: u32 = 1u;
const FR_LOD: u32 = 2u;
const FR_LOD_ORTHO: u32 = 4u;
const FR_FOG_OTHER: u32 = 8u;
const FR_FOG_ATTACH: u32 = 16u;
const FR_HC: u32 = 32u;
const FR_GROUP_TWINS: u32 = 64u;
const FR_CPU_STATE: u32 = 256u;

fn sqDist(p: vec3f, lo: vec3f, hi: vec3f) -> f32 {
  let d = max(max(lo - p, p - hi), vec3f(0.0));
  return d.x * d.x + d.y * d.y + d.z * d.z;
}

fn boxDist2(p: vec3f, r: GdRec) -> f32 {
  return sqDist(p, r.bmin, r.bmax);
}

// distanceLodHidden: hidden past far, shown again only inside 0.9 far (the 10 percent hysteresis)
fn lodHidden(d2: f32, far: f32, wasHidden: bool) -> bool {
  if (wasHidden) {
    let s = far * F.lod.z;
    return d2 >= s * s;
  }
  return d2 > far * far;
}

fn camDist2(r: GdRec) -> f32 {
  if ((F.ctl.x & FR_LOD_ORTHO) != 0u) { return F.cam.w; }
  return boxDist2(F.cam.xyz, r);
}

fn frustumTest(r: GdRec) -> bool {
  for (var i = 0u; i < 6u; i = i + 1u) {
    let pl = F.planes[i];
    let x = select(r.bmin.x, r.bmax.x, pl.x >= 0.0);
    let y = select(r.bmin.y, r.bmax.y, pl.y >= 0.0);
    let z = select(r.bmin.z, r.bmax.z, pl.z >= 0.0);
    let ax = pl.x * x;
    let by = pl.y * y;
    let cz = pl.z * z;
    let s = ax + by + cz + pl.w;
    let mag = abs(ax) + abs(by) + abs(cz) + abs(pl.w);
    if (s < -(F.lod.w * mag)) { return false; }
  }
  return true;
}

fn fogPast(r: GdRec) -> bool {
  if ((r.flags & (FLAG_NO_BOX | FLAG_NO_FOG)) != 0u) { return false; }
  let fl = F.ctl.x;
  let cls = ((r.flags & FLAG_FOG_OTHER) != 0u && (fl & FR_FOG_OTHER) != 0u)
         || ((r.flags & FLAG_FOG_ATTACH) != 0u && (fl & FR_FOG_ATTACH) != 0u);
  if (!cls) { return false; }
  return boxDist2(F.fog.xyz, r) > F.fog.w;
}

fn writeArgs(i: u32, r: GdRec, n: u32) {
  let o = pos[i] * 5u;
  args[o] = r.indexCount;
  args[o + 1u] = n;
  args[o + 2u] = r.firstIndex;
  args[o + 3u] = bitcast<u32>(r.baseVertex);
  args[o + 4u] = r.firstInstance;
}

// role 1 near (draws while near1), 2 far (not near1), 3 mid (not near1, near2), 4 xfar (not near2); 0 always
fn twinDraws(role: u32, n1: bool, n2: bool) -> bool {
  if (role == 1u) { return n1; }
  if (role == 2u) { return !n1; }
  if (role == 3u) { return !n1 && n2; }
  if (role == 4u) { return !n2; }
  return true;
}

@compute @workgroup_size(64)
fn cs_cull(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li < 13u) { atomicStore(&wsum[li], 0u); }
  workgroupBarrier();
  let i = gid.x;
  if (i < F.ctl.y) {
    let r = recs[i];
    let c = ctl[i];
    let fl = F.ctl.x;
    var st = state[i];
    var n = 0u;
    // reason: 0 drawn, 1 disabled, 2 forced hidden, 3 no geometry, 4 fog, 5 lod, 6 frustum, 7 twin, 8 cluster
    var why = 0u;
    let isGroup = (r.flags & FLAG_GROUP) != 0u;
    let noBox = (r.flags & FLAG_NO_BOX) != 0u;
    let hcOn = (fl & FR_HC) != 0u;
    let visited = isGroup || !hcOn || (c & CTL_VISITED) != 0u;
    let lastVisited = (st & ST_VISITED_LAST) != 0u;
    if ((c & CTL_ENABLED) == 0u) {
      why = 1u;
      st = st & ~ST_VISITED_LAST;
    } else {
      st = st & ~(ST_VISIBLE | ST_FOG_HIDDEN);
      st = select(st & ~ST_VISITED_LAST, st | ST_VISITED_LAST, hcOn && visited);
      if ((c & CTL_FORCED) != 0u) {
        if ((c & CTL_FORCED_VIS) != 0u && r.indexCount > 0u) { n = r.count; } else { why = 2u; }
      } else {
        // P8 group twins first (the CPU group loop's order): near while the camera is inside the swap distance of
        // the instances' origin box
        if (isGroup && (r.twinRole == 1u || r.twinRole == 2u)) {
          var near = true;
          if ((fl & FR_GROUP_TWINS) != 0u && (fl & FR_LOD) != 0u && r.twinDist > 0.0 && (r.twinFlags & TWIN_NO_ORIGIN) == 0u) {
            var d2 = F.cam.w;
            if ((fl & FR_LOD_ORTHO) == 0u) { d2 = sqDist(F.cam.xyz, r.omin, r.omax); }
            if ((fl & FR_CPU_STATE) != 0u) { near = (c & CTL_CPU_N1) != 0u; }
            else { near = !lodHidden(d2, r.twinDist * F.lod.x, (st & ST_TWIN_NEAR) == 0u); }
            st = select(st & ~ST_TWIN_NEAR, st | ST_TWIN_NEAR, near);
          }
          if ((r.twinRole == 1u) != near) { why = 7u; }
        }
        if (why == 0u && !visited) { why = 8u; }
        if (why == 0u) {
          // P9 re-seed: a mesh twin that was not visited the frame before starts over (near1 off, near2 on)
          if (!isGroup && r.twinRole != 0u && hcOn && !lastVisited) { st = (st & ~ST_TWIN_NEAR) | ST_TWIN_NEAR2; }
          if (r.indexCount == 0u || r.count == 0u) {
            why = 3u;
          } else {
            // fog before LOD for a mesh (its LOD / twin state is held while fogged); LOD before fog for a group
            if (!isGroup && fogPast(r)) { why = 4u; }
            if (why == 0u) {
              var lodHid = false;
              if ((fl & FR_LOD) != 0u && r.dd > 0.0 && !noBox) {
                if ((fl & FR_CPU_STATE) != 0u) { lodHid = (c & CTL_CPU_LOD) != 0u; }
                else { lodHid = lodHidden(camDist2(r), (r.dd + F.lod.y * r.ddBias) * F.lod.x, (st & ST_LOD_HIDDEN) != 0u); }
                st = select(st & ~ST_LOD_HIDDEN, st | ST_LOD_HIDDEN, lodHid);
              } else {
                st = st & ~ST_LOD_HIDDEN;
              }
              if (lodHid) {
                why = 5u;
              } else if (isGroup && fogPast(r)) {
                why = 4u;
              } else if (!isGroup && r.twinRole != 0u) {
                // E2 / P9 near / far mesh twins (after fog + LOD: a hidden twin holds its swap state)
                var n1 = (st & ST_TWIN_NEAR) != 0u;
                var n2 = (st & ST_TWIN_NEAR2) != 0u;
                if ((fl & FR_LOD) == 0u || noBox || ((r.twinFlags & TWIN_INSTANCED) != 0u && (fl & FR_GROUP_TWINS) == 0u)) {
                  n1 = (r.twinFlags & TWIN_OFF_NEAR) != 0u;
                  n2 = true;
                } else if ((fl & FR_CPU_STATE) != 0u) {
                  n1 = (c & CTL_CPU_N1) != 0u;
                  n2 = (c & CTL_CPU_N2) != 0u;
                } else {
                  let td2 = camDist2(r);
                  if (r.twinRole != 4u) {
                    if (r.twinDist > 0.0) { n1 = !lodHidden(td2, r.twinDist * F.lod.x, !n1); } else { n1 = (r.twinFlags & TWIN_OFF_NEAR) != 0u; }
                  }
                  if (r.twinRole >= 3u) {
                    if (r.twinDist2 > 0.0) { n2 = !lodHidden(td2, r.twinDist2 * F.lod.x, !n2); } else { n2 = true; }
                  }
                }
                st = (st & ~(ST_TWIN_NEAR | ST_TWIN_NEAR2)) | select(0u, ST_TWIN_NEAR, n1) | select(0u, ST_TWIN_NEAR2, n2);
                if (!twinDraws(r.twinRole, n1, n2)) { why = 7u; }
              }
              if (why == 0u) {
                if ((fl & FR_FRUSTUM) != 0u && !noBox && !frustumTest(r)) { why = 6u; } else { n = r.count; }
              }
            }
          }
        }
      }
      if (why == 4u) { st = st | ST_FOG_HIDDEN; }
    }
    // Phase C: the record reached the CPU loop's shadow section (fog / LOD / twins passed; the frustum does not matter)
    st = select(st & ~ST_SH_ELIG, st | ST_SH_ELIG, (c & CTL_ENABLED) != 0u && (why == 0u || why == 6u));
    st = select(st & ~ST_VISIBLE, st | ST_VISIBLE, n > 0u);
    state[i] = st;
    writeArgs(i, r, n);
    if ((c & CTL_ENABLED) != 0u) { atomicAdd(&wsum[11], 1u); }
    if (n > 0u) {
      atomicAdd(&wsum[0], 1u);
      atomicAdd(&wsum[1], r.tris);
      atomicAdd(&wsum[2], n);
      if ((c & CTL_FORCED) != 0u) { atomicAdd(&wsum[10], 1u); atomicAdd(&wsum[12], r.tris); }
    } else if (why == 6u) {
      if (isGroup) { atomicAdd(&wsum[4], 1u); atomicAdd(&wsum[5], r.count); } else { atomicAdd(&wsum[3], 1u); }
    } else if (why == 5u || why == 7u) {
      atomicAdd(&wsum[6], 1u);
      atomicAdd(&wsum[7], r.tris);
    } else if (why == 4u) {
      atomicAdd(&wsum[8], 1u);
      atomicAdd(&wsum[9], r.tris);
    }
  }
  workgroupBarrier();
  if (li < 13u) {
    let v = atomicLoad(&wsum[li]);
    if (v != 0u) { atomicAdd(&stats[li], v); }
  }
}
// P11 CULL RANGES on the GPU (Phase B): one workgroup per ranged record, after cs_cull in the same compute pass. The
// record's verdict is block 0's instanceCount (written by cs_cull). Visible and partly in the view: the threads test
// the run boxes (blocks first: a block outside drops its runs, a block wholly inside keeps them) into a bitmask, then
// thread 0 merges the kept runs into at most RANGE_SPANS index spans (the last absorbs any overflow) and writes the
// record's RANGE_SPANS argument blocks. Otherwise block 0 stays as cs_cull wrote it and the other blocks are zeroed.
struct GdRangeJob {
  rec: u32, boxBase: u32, nRuns: u32, blockRuns: u32,
  runIdx: u32, totalIdx: u32, pad0: u32, pad1: u32,
};
@group(0) @binding(7) var<storage, read> jobs: array<GdRangeJob>;
@group(0) @binding(8) var<storage, read> rboxes: array<f32>;

const RANGE_SPANS: u32 = 4u;
const RANGE_MAX_WORDS: u32 = 1024u;
const FR_RANGES: u32 = 128u;

var<workgroup> keepBits: array<atomic<u32>, 1024>;

fn poolBox(o: u32) -> array<vec3f, 2> {
  return array<vec3f, 2>(vec3f(rboxes[o], rboxes[o + 1u], rboxes[o + 2u]), vec3f(rboxes[o + 3u], rboxes[o + 4u], rboxes[o + 5u]));
}

fn poolBoxTest(o: u32) -> bool {
  let b = poolBox(o);
  for (var i = 0u; i < 6u; i = i + 1u) {
    let pl = F.planes[i];
    let ax = pl.x * select(b[0].x, b[1].x, pl.x >= 0.0);
    let by = pl.y * select(b[0].y, b[1].y, pl.y >= 0.0);
    let cz = pl.z * select(b[0].z, b[1].z, pl.z >= 0.0);
    let s = ax + by + cz + pl.w;
    let mag = abs(ax) + abs(by) + abs(cz) + abs(pl.w);
    if (s < -(F.lod.w * mag)) { return false; }
  }
  return true;
}

fn poolBoxInside(o: u32) -> bool {
  let b = poolBox(o);
  for (var i = 0u; i < 6u; i = i + 1u) {
    let pl = F.planes[i];
    let s = pl.x * select(b[1].x, b[0].x, pl.x >= 0.0) + pl.y * select(b[1].y, b[0].y, pl.y >= 0.0) + pl.z * select(b[1].z, b[0].z, pl.z >= 0.0) + pl.w;
    if (s < 0.0) { return false; }
  }
  return true;
}

fn writeSpan(base: u32, k: u32, r: GdRec, first: u32, count: u32, n: u32) {
  let o = base + k * 5u;
  args[o] = count;
  args[o + 1u] = n;
  args[o + 2u] = r.firstIndex + first;
  args[o + 3u] = bitcast<u32>(r.baseVertex);
  args[o + 4u] = r.firstInstance;
}
// P22 propCull: an INSTANCE-range job (pad0 = 1, an instanced prop group): the runs are copies, so a span is the whole
// geometry drawn for [first, first + count) of the group's instances. count 0 draws nothing (an empty span).
fn writeSpanInst(base: u32, k: u32, r: GdRec, first: u32, count: u32) {
  let o = base + k * 5u;
  args[o] = select(0u, r.indexCount, count > 0u);
  args[o + 1u] = count;
  args[o + 2u] = r.firstIndex;
  args[o + 3u] = bitcast<u32>(r.baseVertex);
  args[o + 4u] = r.firstInstance + first;
}
fn writeAny(base: u32, k: u32, r: GdRec, first: u32, count: u32, n: u32, inst: bool) {
  if (inst) { writeSpanInst(base, k, r, first, count); } else { writeSpan(base, k, r, first, count, n); }
}

@compute @workgroup_size(64)
fn cs_ranges(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let j = jobs[wid.x];
  let r = recs[j.rec];
  let base = pos[j.rec] * 5u;
  let n = args[base + 1u];
  let fl = F.ctl.x;
  let words = (j.nRuns + 31u) / 32u;
  let doRanges = n > 0u && (fl & FR_RANGES) != 0u && (fl & FR_FRUSTUM) != 0u && words <= RANGE_MAX_WORDS && j.blockRuns > 0u;
  for (var wc = li; wc < min(words, RANGE_MAX_WORDS); wc = wc + 64u) { atomicStore(&keepBits[wc], 0u); }
  workgroupBarrier();
  if (doRanges) {
    let nb = (j.nRuns + j.blockRuns - 1u) / j.blockRuns;
    let runBase = j.boxBase + nb * 6u;
    for (var b = li; b < nb; b = b + 64u) {
      let bo = j.boxBase + b * 6u;
      let r0 = b * j.blockRuns;
      let r1 = min(j.nRuns, r0 + j.blockRuns);
      if (poolBoxTest(bo)) {
        let inside = poolBoxInside(bo);
        for (var i = r0; i < r1; i = i + 1u) {
          if (inside || poolBoxTest(runBase + i * 6u)) { atomicOr(&keepBits[i >> 5u], 1u << (i & 31u)); }
        }
      }
    }
  }
  workgroupBarrier();
  if (li != 0u) { return; }
  let inst = j.pad0 == 1u;
  if (!doRanges) {
    for (var k = 1u; k < RANGE_SPANS; k = k + 1u) { writeAny(base, k, r, 0u, 0u, 0u, inst); }
    return;
  }
  let gapMax = F.ctl.w;
  // pass 1: the gaps between the merged spans; keep the RANGE_SPANS - 1 largest (the earliest wins a tie): splitting
  // only there leaves out the most dropped runs RANGE_SPANS spans can
  var gg = array<u32, 3>(0u, 0u, 0u);
  var gi = array<u32, 3>(0xffffffffu, 0xffffffffu, 0xffffffffu);
  var have = false;
  var last = 0u;
  for (var wa = 0u; wa < words; wa = wa + 1u) {
    var bits = atomicLoad(&keepBits[wa]);
    loop {
      if (bits == 0u) { break; }
      let i = wa * 32u + firstTrailingBit(bits);
      bits = bits & (bits - 1u);
      if (have) {
        let g = i - last - 1u;
        if (g > gapMax && g > gg[2]) {
          if (g > gg[0]) { gg[2] = gg[1]; gi[2] = gi[1]; gg[1] = gg[0]; gi[1] = gi[0]; gg[0] = g; gi[0] = i; }
          else if (g > gg[1]) { gg[2] = gg[1]; gi[2] = gi[1]; gg[1] = g; gi[1] = i; }
          else { gg[2] = g; gi[2] = i; }
        }
      }
      have = true;
      last = i;
    }
  }
  // pass 2: the spans, split at those gaps only
  var cnt = 0u;
  var open = false;
  var s0 = 0u;
  var e0 = 0u;
  var drawn = 0u;
  last = 0u;
  for (var wb = 0u; wb < words; wb = wb + 1u) {
    var bits = atomicLoad(&keepBits[wb]);
    loop {
      if (bits == 0u) { break; }
      let i = wb * 32u + firstTrailingBit(bits);
      bits = bits & (bits - 1u);
      let fs = i * j.runIdx;
      let fe = min(j.totalIdx, fs + j.runIdx);
      let cut = i - last - 1u > gapMax && (i == gi[0] || i == gi[1] || i == gi[2]);
      if (open && !cut) {
        e0 = fe;
      } else {
        if (open) { writeAny(base, cnt, r, s0, e0 - s0, n, inst); cnt = cnt + 1u; drawn = drawn + e0 - s0; }
        open = true;
        s0 = fs;
        e0 = fe;
      }
      last = i;
    }
  }
  if (open) { writeAny(base, cnt, r, s0, e0 - s0, n, inst); cnt = cnt + 1u; drawn = drawn + e0 - s0; }
  for (var k = cnt; k < RANGE_SPANS; k = k + 1u) { writeAny(base, k, r, 0u, 0u, 0u, inst); }
  // stats word 13: the triangles the spans left out (cs_cull counted the record whole); instance mode: the copies left out
  if (inst) {
    if (n > drawn) { atomicAdd(&stats[13], (r.indexCount / 3u) * (n - drawn)); }
  } else if (r.indexCount > drawn) { atomicAdd(&stats[13], ((r.indexCount - drawn) / 3u) * n); }
}
// PHASE C: SHADOW CASTERS on the GPU (one invocation per record, after cs_cull in the same compute pass). The CPU
// path's shadow-list rules (Renderer3D._buildDrawLists) per record: the far light box, the shadow reach (the box
// swept along the light down to the scene floor against the camera frustum), the P8 shadow LOD (feature size against
// the far / cascade texel), the P4.2 / P14 static / dynamic split, the near-cascade boxes and the P14 joiners (a
// static caster not in the drawn static layer yet is drawn with the dynamic casters). It writes one argument block per
// record and LAYER (0 far direct, 1 far static, 2 far dynamic, 3 cascade 0, 4 cascade 0 dynamic, 5 cascade 1,
// 6 cascade 1 dynamic), keeps the static-layer membership in the state word and counts each static layer's leavers
// (drawn into the layer, no longer a member: the layer must re-render) and joiners (a member not drawn into it yet).
struct GdShadowFrame {
  light: array<vec4f, 6>,
  casc: array<vec4f, 12>,
  ldir: vec4f,
  lod: vec4f,
  ctl: vec4u,
};
@group(0) @binding(9) var<uniform> S: GdShadowFrame;

const SH_ON: u32 = 1u;
const SH_CACHE: u32 = 2u;
const SH_SPLIT: u32 = 4u;
const SH_REACH: u32 = 8u;
const SH_LIGHT: u32 = 16u;
const SH_WIND: u32 = 32u;
const SH_BAND: u32 = 64u;
const SH_BAND_ATTACH: u32 = 128u;
const SH_JOIN: u32 = 256u;
const SH_COMPACT: u32 = 512u;
const SH_COMPACT_STAT: u32 = 25u;
const CTL_VB_OV: u32 = 512u;
const SHF_CASTS: u32 = 1u;
const SHF_WIND: u32 = 2u;
const CTL_DYNAMIC: u32 = 16u;
const CTL_NOREACH: u32 = 32u;
const ST_SH_ELIG: u32 = 64u;
const ST_MEM_FAR: u32 = 128u;
const ST_MEM_C0: u32 = 256u;
const ST_MEM_C1: u32 = 512u;
const ST_IN_FAR: u32 = 1024u;
const ST_IN_C0: u32 = 2048u;
const ST_IN_C1: u32 = 4096u;
const L_DIRECT: u32 = 1u;
const L_FSTATIC: u32 = 2u;
const L_FDYN: u32 = 4u;
const SH_LAYERS: u32 = 7u;

var<workgroup> shsum: array<atomic<u32>, 9>;

fn planesTest(base: u32, lo: vec3f, hi: vec3f, isCasc: bool) -> bool {
  for (var k = 0u; k < 6u; k = k + 1u) {
    var pl = S.light[k];
    if (isCasc) { pl = S.casc[base + k]; }
    let ax = pl.x * select(lo.x, hi.x, pl.x >= 0.0);
    let by = pl.y * select(lo.y, hi.y, pl.y >= 0.0);
    let cz = pl.z * select(lo.z, hi.z, pl.z >= 0.0);
    let s = ax + by + cz + pl.w;
    let mag = abs(ax) + abs(by) + abs(cz) + abs(pl.w);
    if (s < -(F.lod.w * mag)) { return false; }
  }
  return true;
}

// the camera frustum (GdFrame planes) against a box
fn viewTest(lo: vec3f, hi: vec3f) -> bool {
  for (var k = 0u; k < 6u; k = k + 1u) {
    let pl = F.planes[k];
    let ax = pl.x * select(lo.x, hi.x, pl.x >= 0.0);
    let by = pl.y * select(lo.y, hi.y, pl.y >= 0.0);
    let cz = pl.z * select(lo.z, hi.z, pl.z >= 0.0);
    let s = ax + by + cz + pl.w;
    let mag = abs(ax) + abs(by) + abs(cz) + abs(pl.w);
    if (s < -(F.lod.w * mag)) { return false; }
  }
  return true;
}

// shadowReachesView (frustum-culler.ts): the box swept along the light to the floor meets the camera frustum
fn reaches(r: GdRec) -> bool {
  let d = S.ldir.xyz;
  let floorY = S.ldir.w;
  if (!(d.y < -0.05) || floorY > 1.0e37) { return true; }
  let len = max(0.0, r.bmax.y - floorY) / -d.y;
  let e = d * len;
  return viewTest(min(r.bmin, r.bmin + e), max(r.bmax, r.bmax + e));
}

// fog horizon P2 fade band: the box reaches past the band's inner distance (its farthest corner from the fog eye)
fn inFadeBand(r: GdRec) -> bool {
  let fl = S.ctl.x;
  if ((fl & SH_BAND) == 0u || (r.flags & (FLAG_NO_FOG | FLAG_NO_BOX)) != 0u) { return false; }
  let cls = (r.flags & FLAG_FOG_OTHER) != 0u || ((r.flags & FLAG_FOG_ATTACH) != 0u && (fl & SH_BAND_ATTACH) != 0u);
  if (!cls) { return false; }
  let e = F.fog.xyz;
  let d = max(abs(e - r.bmin), abs(e - r.bmax));
  return d.x * d.x + d.y * d.y + d.z * d.z >= S.lod.w * S.lod.w;
}

fn shWrite(i: u32, layer: u32, r: GdRec, n: u32) {
  let o = (S.ctl.z + layer * S.ctl.w + i) * 5u;
  args[o] = r.indexCount;
  args[o + 1u] = n;
  args[o + 2u] = r.firstIndex;
  args[o + 3u] = bitcast<u32>(r.baseVertex);
  args[o + 4u] = r.firstInstance;
}

fn cLayer(ci: u32) -> u32 { return 8u << (ci * 2u); }
fn cDynLayer(ci: u32) -> u32 { return 16u << (ci * 2u); }
fn cMem(ci: u32) -> u32 { return ST_MEM_C0 << ci; }
fn cIn(ci: u32) -> u32 { return ST_IN_C0 << ci; }

@compute @workgroup_size(64)
fn cs_shadow(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li < 9u) { atomicStore(&shsum[li], 0u); }
  workgroupBarrier();
  let i = gid.x;
  if (i < F.ctl.y) {
    let r = recs[i];
    let c = ctl[i];
    var st = state[i];
    let fl = S.ctl.x;
    var mask = 0u;
    var mem = 0u;
    let isGroup = (r.flags & FLAG_GROUP) != 0u;
    let noBox = (r.flags & FLAG_NO_BOX) != 0u;
    let cache = (fl & SH_CACHE) != 0u;
    let split = (fl & SH_SPLIT) != 0u;
    let join = (fl & SH_JOIN) != 0u;
    let on = (fl & SH_ON) != 0u && (c & CTL_ENABLED) != 0u && (c & CTL_FORCED) == 0u && (r.shFlags & SHF_CASTS) != 0u && r.indexCount > 0u && r.count > 0u;
    if (on) {
      let visited = isGroup || (F.ctl.x & FR_HC) == 0u || (c & CTL_VISITED) != 0u;
      let fsz = r.shFeature;
      let farSkip = fsz > 0.0 && fsz < S.lod.x;
      let windDyn = (fl & SH_WIND) != 0u && (r.shFlags & SHF_WIND) != 0u;
      if (visited && (st & ST_SH_ELIG) != 0u) {
        let inLight = (fl & SH_LIGHT) == 0u || noBox || planesTest(0u, r.bmin, r.bmax, false);
        if (inLight) {
          let reachOk = (fl & SH_REACH) == 0u || noBox || reaches(r);
          // a mesh is dynamic when it moved lately / is on probation (CPU), sways in the wind or straddles the fade band
          var dyn = windDyn || inFadeBand(r);
          if (!isGroup && (c & CTL_DYNAMIC) != 0u) { dyn = true; }
          let nC = S.ctl.y;
          if (!isGroup) {
            if (!farSkip) {
              if (reachOk) { mask = mask | L_DIRECT; }
              if (cache) {
                if (dyn) { if (reachOk) { mask = mask | L_FDYN; } }
                else { mem = mem | ST_MEM_FAR; mask = mask | L_FSTATIC; if (join && reachOk && (st & ST_IN_FAR) == 0u) { mask = mask | L_FDYN; } }
              }
            }
            for (var ci = 0u; ci < nC; ci = ci + 1u) {
              if (!(split || reachOk)) { continue; }
              let lt = select(S.lod.y, S.lod.z, ci == 1u);
              if (fsz > 0.0 && fsz < lt) { continue; }
              if (!noBox && !planesTest(ci * 6u, r.bmin, r.bmax, true)) { continue; }
              if (split) {
                if (dyn) { if (reachOk) { mask = mask | cDynLayer(ci); } }
                else { mem = mem | cMem(ci); mask = mask | cLayer(ci); if (join && reachOk && (st & cIn(ci)) == 0u) { mask = mask | cDynLayer(ci); } }
              } else { mask = mask | cLayer(ci); }
            }
          } else {
            // an instanced group that opted into shadows (castsInstancedShadow)
            var groupCasc = false;
            if (farSkip) {
              if (split) { groupCasc = true; }
              else if (reachOk) {
                for (var ci = 0u; ci < nC; ci = ci + 1u) {
                  let lt = select(S.lod.y, S.lod.z, ci == 1u);
                  if (fsz < lt) { continue; }
                  if (!noBox && !planesTest(ci * 6u, r.bmin, r.bmax, true)) { continue; }
                  mask = mask | cLayer(ci);
                }
              }
            } else {
              if (reachOk) {
                mask = mask | L_DIRECT;
                if (!split) {
                  for (var ci = 0u; ci < nC; ci = ci + 1u) {
                    let lt = select(S.lod.y, S.lod.z, ci == 1u);
                    if (fsz > 0.0 && fsz < lt) { continue; }
                    if (noBox || planesTest(ci * 6u, r.bmin, r.bmax, true)) { mask = mask | cLayer(ci); }
                  }
                }
              }
              if (cache) {
                if (dyn) { if (reachOk) { mask = mask | L_FDYN; } }
                else { mem = mem | ST_MEM_FAR; mask = mask | L_FSTATIC; if (join && reachOk && (st & ST_IN_FAR) == 0u) { mask = mask | L_FDYN; } }
              }
              if (split) { groupCasc = true; }
            }
            if (groupCasc && !(dyn && !reachOk)) {
              for (var ci = 0u; ci < nC; ci = ci + 1u) {
                let lt = select(S.lod.y, S.lod.z, ci == 1u);
                if (fsz > 0.0 && fsz < lt) { continue; }
                if (!noBox && !planesTest(ci * 6u, r.bmin, r.bmax, true)) { continue; }
                if (dyn) { mask = mask | cDynLayer(ci); }
                else { mem = mem | cMem(ci); mask = mask | cLayer(ci); if (join && reachOk && (st & cIn(ci)) == 0u) { mask = mask | cDynLayer(ci); } }
              }
            }
          }
        }
      } else if (!visited && (c & CTL_NOREACH) != 0u && cache) {
        // a member of a cluster rejected with NOREACH (in the light box, its shadow misses the view): only the cached
        // static far layer wants it, by its held LOD / twin state, a fresh fog test, fine enough for the far map, static
        let held = (st & ST_LOD_HIDDEN) == 0u && twinDraws(r.twinRole, (st & ST_TWIN_NEAR) != 0u, (st & ST_TWIN_NEAR2) != 0u) && !fogPast(r);
        let dyn = windDyn || inFadeBand(r) || (c & CTL_DYNAMIC) != 0u;
        if (held && !farSkip && !dyn) { mem = mem | ST_MEM_FAR; mask = mask | L_FSTATIC; }
      }
    }
    for (var kl = 0u; kl < SH_LAYERS; kl = kl + 1u) { shWrite(i, kl, r, select(0u, r.count, (mask & (1u << kl)) != 0u)); }
    // compacted dynamic layers (SH_COMPACT): append this record's nonzero blocks of layers 2, 4 and 6 to their compact
    // lists (list j after the SH_LAYERS per-record layers; the CPU draws a bound of slots, the rest cleared to zero).
    // A record with its own vertex buffer stays out: it is drawn from its per-record block.
    if ((fl & SH_COMPACT) != 0u && (c & CTL_VB_OV) == 0u && (mask & (L_FDYN | (L_FDYN << 2u) | (L_FDYN << 4u))) != 0u) {
      for (var j = 0u; j < 3u; j = j + 1u) {
        if ((mask & (L_FDYN << (2u * j))) == 0u) { continue; }
        let slot = atomicAdd(&stats[SH_COMPACT_STAT + j], 1u);
        if (slot < S.ctl.w) { shWrite(slot, SH_LAYERS + j, r, r.count); }
      }
    }
    // leavers / joiners of the three static layers (far, cascade 0, cascade 1)
    for (var k = 0u; k < 3u; k = k + 1u) {
      let mb = ST_MEM_FAR << k;
      let ib = ST_IN_FAR << k;
      let isIn = (st & ib) != 0u;
      let isMem = (mem & mb) != 0u;
      if (isIn && !isMem) { atomicAdd(&shsum[k], 1u); }
      if (isMem && !isIn) { atomicAdd(&shsum[3u + k], 1u); atomicAdd(&shsum[6u + k], r.tris); }
    }
    st = (st & ~(ST_MEM_FAR | ST_MEM_C0 | ST_MEM_C1)) | mem;
    state[i] = st;
  }
  workgroupBarrier();
  if (li < 9u) {
    let v = atomicLoad(&shsum[li]);
    if (v != 0u) { atomicAdd(&stats[16u + li], v); }
  }
}

// PHASE C COMMIT: a static layer was just drawn from this frame's members: they are its drawn set now
override COMMIT_LAYER: u32 = 0u;
@compute @workgroup_size(64)
fn cs_commit(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= F.ctl.y) { return; }
  let st = state[i];
  let mb = ST_MEM_FAR << COMMIT_LAYER;
  let ib = ST_IN_FAR << COMMIT_LAYER;
  state[i] = select(st & ~ib, st | ib, (st & mb) != 0u);
}
`;
