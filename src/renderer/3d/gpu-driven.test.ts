/**
 * P15 GPU-DRIVEN MAIN PASS (performance-plan.md §P15): the buffer layouts against the WGSL, the CPU mirror of the
 * compute cull against the CPU path's rules (frustum, distance LOD + hysteresis, fog horizon), the dirty-range and
 * bucket / bundle-invalidation bookkeeping, and an END-TO-END check: the real Renderer3D on a recording device with the
 * compute pass EMULATED by the mirror, whose bundle draw sequence must equal the CPU path's main-pass sequence frame
 * for frame over a camera path (LOD swaps, fog horizon, twins, groups, hidden / moved / re-materialled meshes).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
import { webcrypto } from 'node:crypto';
import {
  GD_REC_WORDS, GD_REC_BYTES, GdRecW, GD_FRAME_FLOATS, GD_FRAME_BYTES, GdFrameW, GdStat, GD_STAT_WORDS, GD_ARGS_WORDS,
  GD_CTL_ENABLED, GD_CTL_FORCED, GD_CTL_FORCED_VIS, GD_CTL_VISITED, GD_STATE_LOD_HIDDEN, GD_STATE_TWIN_NEAR, GD_STATE_TWIN_NEAR2, GD_STATE_VISITED_LAST,
  GD_TWIN_OFF_NEAR, GD_TWIN_INSTANCED, GD_TWIN_NO_ORIGIN, GD_FLAG_GROUP, GD_FLAG_FOG_OTHER, GD_FLAG_FOG_ATTACH, GD_FLAG_NO_FOG,
  GD_FRAME_FRUSTUM, GD_FRAME_LOD, GD_FRAME_LOD_ORTHO, GD_FRAME_FOG_OTHER, GD_FRAME_FOG_ATTACH, GD_FRAME_HC, GD_FRAME_GROUP_TWINS,
  gdCullRecord, gdFrustumTest, packGdRecord, packGdFrame, gdFogFlags, GdDirtyRanges, gdBuckets, gdBucketsChanged, gdBundleCommands,
  GdRecordSlots, GD_CODE_TEXTURED, GD_CODE_ATLAS, GD_CODE_PATTERNED, GdWhy, type GdFrameParams, type GdBucketRefs,
  GD_FRAME_RANGES, GD_RANGE_SPANS, GD_RANGE_MAX_WORDS, GD_JOB_WORDS, GdJobW, gdRangeSpans, gdRangeBoxFloats, packGdRangeBoxes,
  GD_SHF_CASTS, GD_SHF_WIND, GD_CTL_DYNAMIC, GD_CTL_NOREACH, GD_STATE_SH_ELIG, GD_STATE_MEM_FAR, GD_STATE_MEM_C0, GD_STATE_MEM_C1,
  GD_STATE_IN_FAR, GD_STATE_IN_C0, GD_STATE_IN_C1, GD_SH_LAYERS, GD_SH_FRAME_FLOATS, GdShFrameW, GdShLayer, gdShadowRecord,
  GD_CTL_CPU_LOD, GD_CTL_CPU_N1, GD_CTL_CPU_N2, GD_FRAME_CPU_STATE,
  GD_SH_ON, GD_SH_CACHE, GD_SH_SPLIT, GD_SH_REACH, GD_SH_LIGHT, GD_SH_WIND, GD_SH_BAND, GD_SH_BAND_ATTACH, GD_SH_JOIN, type GdShadowParams,
  gdSkippable, gdBoxOutside, gdSegments,
  GD_CTL_VB_OV, GD_SH_COMPACT, GD_SH_COMPACT_LAYERS, GD_SH_COMPACT_MIN, gdCompactSize, gdShadowDynMaybe, gdBoxOutsideLoose, setGdBoundReach, GD_FLAG_NO_BOX,
} from './gpu-driven';
import { buildCullRanges, selectRanges } from './cull-ranges';
import { GPU_CULL_WGSL } from './shaders/gpu-cull-shaders';
import { FrustumCuller } from './frustum-culler';
import { aabbDistanceSq, distanceLodHidden, twinDraws } from './distance-lod';
import { mat4 } from 'gl-matrix';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;

// ── layouts ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** WGSL host-shareable layout of a struct's members (scalars, vec2/3/4, array<vec4f, N>): byte offsets + size. */
function wgslLayout(src: string, name: string): { offsets: Record<string, number>; size: number } {
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(src);
  if (!m) throw new Error('no struct ' + name);
  const offsets: Record<string, number> = {};
  let off = 0, maxAlign = 4;
  const parts: string[] = []; let depth = 0, cur = '';
  for (const ch of m[1]) { if (ch === '<') depth++; if (ch === '>') depth--; if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; }
  parts.push(cur);
  for (const part of parts.map((x) => x.trim()).filter(Boolean)) {
    const [fname, type] = part.split(':').map((s) => s.trim());
    let size: number, align: number;
    const arr = /array<\s*vec4[fu]\s*,\s*(\d+)\s*>/.exec(type);
    if (arr) { size = 16 * +arr[1]; align = 16; }
    else if (/^vec4/.test(type)) { size = 16; align = 16; }
    else if (/^vec3/.test(type)) { size = 12; align = 16; }
    else if (/^vec2/.test(type)) { size = 8; align = 8; }
    else { size = 4; align = 4; }
    off = Math.ceil(off / align) * align;
    offsets[fname] = off;
    off += size; maxAlign = Math.max(maxAlign, align);
  }
  return { offsets, size: Math.ceil(off / maxAlign) * maxAlign };
}

describe('P15 layouts', () => {
  it('GdRec: WGSL offsets = GdRecW words, 112 bytes', () => {
    const L = wgslLayout(GPU_CULL_WGSL, 'GdRec');
    expect(L.size).toBe(GD_REC_BYTES);
    expect(GD_REC_BYTES).toBe(GD_REC_WORDS * 4);
    const map: Record<string, number> = { bmin: GdRecW.minX, dd: GdRecW.drawDistance, bmax: GdRecW.maxX, ddBias: GdRecW.drawDistanceBias,
      indexCount: GdRecW.indexCount, firstIndex: GdRecW.firstIndex, baseVertex: GdRecW.baseVertex, firstInstance: GdRecW.firstInstance,
      count: GdRecW.count, flags: GdRecW.flags, tris: GdRecW.tris, twinRole: GdRecW.twinRole, twinDist: GdRecW.twinDist, twinDist2: GdRecW.twinDist2,
      twinFlags: GdRecW.twinFlags, omin: GdRecW.oMinX, omax: GdRecW.oMaxX, shFeature: GdRecW.shFeature, shFlags: GdRecW.shFlags };
    for (const [k, w] of Object.entries(map)) expect(L.offsets[k], k).toBe(w * 4);
  });
  it('GdFrame: WGSL offsets = GdFrameW, 160 bytes', () => {
    const L = wgslLayout(GPU_CULL_WGSL, 'GdFrame');
    expect(L.size).toBe(GD_FRAME_BYTES);
    expect(GD_FRAME_BYTES).toBe(GD_FRAME_FLOATS * 4);
    expect(L.offsets.planes).toBe(GdFrameW.planes * 4);
    expect(L.offsets.cam).toBe(GdFrameW.cam * 4);
    expect(L.offsets.fog).toBe(GdFrameW.fog * 4);
    expect(L.offsets.lod).toBe(GdFrameW.lod * 4);
    expect(L.offsets.ctl).toBe(GdFrameW.ctl * 4);
  });
  it('constants and stats words in the shader match gpu-driven.ts', () => {
    const c = (name: string) => +(new RegExp(`const ${name}: u32 = (\\d+)u;`).exec(GPU_CULL_WGSL)?.[1] ?? NaN);
    expect(c('CTL_ENABLED')).toBe(GD_CTL_ENABLED); expect(c('CTL_FORCED')).toBe(GD_CTL_FORCED); expect(c('CTL_FORCED_VIS')).toBe(GD_CTL_FORCED_VIS);
    expect(c('FLAG_FOG_OTHER')).toBe(GD_FLAG_FOG_OTHER); expect(c('FLAG_FOG_ATTACH')).toBe(GD_FLAG_FOG_ATTACH); expect(c('FLAG_NO_FOG')).toBe(GD_FLAG_NO_FOG); expect(c('FLAG_GROUP')).toBe(GD_FLAG_GROUP);
    expect(c('ST_LOD_HIDDEN')).toBe(GD_STATE_LOD_HIDDEN);
    expect(c('CTL_VISITED')).toBe(GD_CTL_VISITED); expect(c('ST_TWIN_NEAR')).toBe(GD_STATE_TWIN_NEAR); expect(c('ST_TWIN_NEAR2')).toBe(GD_STATE_TWIN_NEAR2);
    expect(c('ST_VISITED_LAST')).toBe(GD_STATE_VISITED_LAST); expect(c('TWIN_OFF_NEAR')).toBe(GD_TWIN_OFF_NEAR); expect(c('TWIN_INSTANCED')).toBe(GD_TWIN_INSTANCED);
    expect(c('TWIN_NO_ORIGIN')).toBe(GD_TWIN_NO_ORIGIN); expect(c('CTL_CPU_LOD')).toBe(GD_CTL_CPU_LOD); expect(c('CTL_CPU_N1')).toBe(GD_CTL_CPU_N1);
    expect(c('CTL_CPU_N2')).toBe(GD_CTL_CPU_N2); expect(c('FR_CPU_STATE')).toBe(GD_FRAME_CPU_STATE); expect(c('FR_HC')).toBe(GD_FRAME_HC); expect(c('FR_GROUP_TWINS')).toBe(GD_FRAME_GROUP_TWINS);
    expect(c('FR_FRUSTUM')).toBe(GD_FRAME_FRUSTUM); expect(c('FR_LOD')).toBe(GD_FRAME_LOD); expect(c('FR_LOD_ORTHO')).toBe(GD_FRAME_LOD_ORTHO);
    expect(c('FR_FOG_OTHER')).toBe(GD_FRAME_FOG_OTHER); expect(c('FR_FOG_ATTACH')).toBe(GD_FRAME_FOG_ATTACH);
    const sums = Object.entries(GdStat).filter(([k]) => k !== 'rangeTris' && !k.startsWith('sh')).map(([, v]) => v);   // rangeTris: cs_ranges; sh*: cs_shadow
    const n = Math.max(...sums) + 1;
    expect(GPU_CULL_WGSL).toContain(`array<atomic<u32>, ${n}>`);
    for (const v of sums) expect(GPU_CULL_WGSL, `wsum[${v}]`).toContain(`wsum[${v}]`);
    expect(GPU_CULL_WGSL).toContain(`stats[${GdStat.rangeTris}]`);
    expect(GdStat.rangeTris).toBeLessThan(GD_STAT_WORDS);
    expect(GPU_CULL_WGSL).toContain(`stats: array<atomic<u32>, ${GD_STAT_WORDS}>`);
    // cs_shadow sums leavers (0..2), joiners (3..5), joiner triangles (6..8) into stats[16 + k]
    expect(GdStat.shJoin).toBe(GdStat.shLeave + 3); expect(GdStat.shJoinTris).toBe(GdStat.shLeave + 6); expect(GdStat.shJoinTris + 3).toBeLessThanOrEqual(GD_STAT_WORDS);
    expect(GPU_CULL_WGSL).toContain(`atomicAdd(&stats[${GdStat.shLeave}u + li], v)`);
    for (let b = 0; b <= 6; b++) expect(GPU_CULL_WGSL).toContain(`@binding(${b})`);
    expect(GD_ARGS_WORDS).toBe(5);
    expect(GPU_CULL_WGSL).not.toMatch(/\/\/[^\n]*`/);   // no backticks in WGSL comments
  });
  it('Phase B range jobs: GdRangeJob = GD_JOB_WORDS, spans / words / flag constants, bindings 7-8', () => {
    const L = wgslLayout(GPU_CULL_WGSL, 'GdRangeJob');
    expect(L.size).toBe(GD_JOB_WORDS * 4);
    for (const [k, w] of Object.entries(GdJobW)) expect(L.offsets[k], k).toBe(w * 4);
    const c = (name: string) => +(new RegExp(`const ${name}: u32 = (\\d+)u;`).exec(GPU_CULL_WGSL)?.[1] ?? NaN);
    expect(c('RANGE_SPANS')).toBe(GD_RANGE_SPANS); expect(c('RANGE_MAX_WORDS')).toBe(GD_RANGE_MAX_WORDS); expect(c('FR_RANGES')).toBe(GD_FRAME_RANGES);
    expect(GPU_CULL_WGSL).toContain(`array<atomic<u32>, ${GD_RANGE_MAX_WORDS}>`);
    for (const b of [7, 8]) expect(GPU_CULL_WGSL).toContain(`@binding(${b})`);
    expect(GPU_CULL_WGSL).toContain('fn cs_ranges');
    expect(GPU_CULL_WGSL).toContain(`var gg = array<u32, ${GD_RANGE_SPANS - 1}>`);   // the split keeps RANGE_SPANS - 1 gaps
  });
  it('Phase C: GdShadowFrame = GdShFrameW, the shadow / caster / state / control constants match', () => {
    const L = wgslLayout(GPU_CULL_WGSL, 'GdShadowFrame');
    expect(L.size).toBe(GD_SH_FRAME_FLOATS * 4);
    for (const [k, w] of Object.entries(GdShFrameW)) expect(L.offsets[k], k).toBe(w * 4);
    const c = (name: string) => +(new RegExp(`const ${name}: u32 = (\\d+)u;`).exec(GPU_CULL_WGSL)?.[1] ?? NaN);
    const want: Record<string, number> = { SH_ON: GD_SH_ON, SH_CACHE: GD_SH_CACHE, SH_SPLIT: GD_SH_SPLIT, SH_REACH: GD_SH_REACH, SH_LIGHT: GD_SH_LIGHT, SH_WIND: GD_SH_WIND,
      SH_BAND: GD_SH_BAND, SH_BAND_ATTACH: GD_SH_BAND_ATTACH, SH_JOIN: GD_SH_JOIN, SHF_CASTS: GD_SHF_CASTS, SHF_WIND: GD_SHF_WIND, CTL_DYNAMIC: GD_CTL_DYNAMIC,
      CTL_NOREACH: GD_CTL_NOREACH, ST_SH_ELIG: GD_STATE_SH_ELIG, ST_MEM_FAR: GD_STATE_MEM_FAR, ST_MEM_C0: GD_STATE_MEM_C0, ST_MEM_C1: GD_STATE_MEM_C1,
      ST_IN_FAR: GD_STATE_IN_FAR, ST_IN_C0: GD_STATE_IN_C0, ST_IN_C1: GD_STATE_IN_C1, SH_LAYERS: GD_SH_LAYERS,
      L_DIRECT: 1 << GdShLayer.direct, L_FSTATIC: 1 << GdShLayer.farStatic, L_FDYN: 1 << GdShLayer.farDyn };
    for (const [k, v] of Object.entries(want)) expect(c(k), k).toBe(v);
    // cascade layer bits: cLayer(ci) = 8 << 2ci, cDynLayer(ci) = 16 << 2ci
    expect(8 << 0).toBe(1 << GdShLayer.c0); expect(16 << 0).toBe(1 << GdShLayer.c0Dyn); expect(8 << 2).toBe(1 << GdShLayer.c1); expect(16 << 2).toBe(1 << GdShLayer.c1Dyn);
    expect(GD_STATE_MEM_C0).toBe(GD_STATE_MEM_FAR << 1); expect(GD_STATE_IN_C1).toBe(GD_STATE_IN_FAR << 2);
    for (const fn of ['fn cs_shadow', 'fn cs_commit', 'override COMMIT_LAYER']) expect(GPU_CULL_WGSL).toContain(fn);
    expect(GPU_CULL_WGSL).toContain('@binding(9) var<uniform> S: GdShadowFrame');
  });
  it('packGdFrame writes the flags and a finite fog distance', () => {
    const out = new Float32Array(GD_FRAME_FLOATS), u = new Uint32Array(out.buffer);
    packGdFrame(out, { planes: null, cam: [1, 2, 3], lodOn: true, lodOrtho: false, orthoD2: 0, lodScale: 0.5, lodBias: 2, fogEye: [4, 5, 6], fogCull2: Infinity, fogCullOther: true, fogCullAttach: true }, 7, 9);
    expect(u[GdFrameW.ctl]).toBe(GD_FRAME_LOD);   // fog flags drop with an infinite cull distance; no planes = no frustum
    expect(Number.isFinite(out[GdFrameW.fog + 3])).toBe(true);
    expect(u[GdFrameW.ctl + 1]).toBe(7); expect(u[GdFrameW.ctl + 2]).toBe(9);
    expect([out[GdFrameW.cam], out[GdFrameW.cam + 1], out[GdFrameW.cam + 2]]).toEqual([1, 2, 3]);
  });
});

// ── the cull rule vs the CPU path ───────────────────────────────────────────────────────────────────────────────
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function recTable(n: number) { const buf = new ArrayBuffer(n * GD_REC_BYTES); return { f: new Float32Array(buf), u: new Uint32Array(buf), i: new Int32Array(buf) }; }

describe('P15 cull rule (CPU mirror) = the CPU path', () => {
  it('frustum: never culls a box the CPU keeps, and agrees away from the planes', () => {
    const R = rng(1);
    const cull = new FrustumCuller();
    let agree = 0, extra = 0;
    for (let t = 0; t < 40; t++) {
      const eye = [R() * 40 - 20, R() * 10, R() * 40 - 20], at = [R() * 40 - 20, 0, R() * 40 - 20];
      const v = mat4.lookAt(mat4.create(), eye as [number, number, number], at as [number, number, number], [0, 1, 0]);
      const p = mat4.perspectiveZO(mat4.create(), 0.4 + R() * 1.2, 1.5, 0.1, 200);
      cull.setFromViewProjection(mat4.multiply(mat4.create(), p, v));
      const planes = cull.writePlanes(new Float32Array(24));
      const T = recTable(1);
      for (let k = 0; k < 200; k++) {
        const cx = R() * 80 - 40, cy = R() * 10, cz = R() * 80 - 40, hx = R() * 4, hy = R() * 4, hz = R() * 4;
        const box = { minX: cx - hx, minY: cy - hy, minZ: cz - hz, maxX: cx + hx, maxY: cy + hy, maxZ: cz + hz };
        packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: 0, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 1, flags: 0 });
        const cpu = cull.testBox(box), gpu = gdFrustumTest(planes, T.f, 0);
        if (cpu) expect(gpu).toBe(true);
        if (cpu === gpu) agree++; else extra++;
      }
    }
    expect(extra).toBeLessThan(agree * 0.001 + 1);
  });

  it('distance LOD: the hysteresis sequence over a camera path = distanceLodHidden', () => {
    const R = rng(2);
    for (let t = 0; t < 30; t++) {
      const box = { minX: R() * 10, minY: 0, minZ: R() * 10, maxX: 0, maxY: 2, maxZ: 0 }; box.maxX = box.minX + 1 + R() * 5; box.maxZ = box.minZ + 1 + R() * 5;
      const dd = 5 + R() * 30, ddb = R(), lodScale = 0.5 + R(), lodBias = R() * 10;
      const T = recTable(1);
      packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: dd, drawDistanceBias: ddb, indexCount: 30, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 1, flags: 0 });
      let gpuState = 0, cpuHidden = false;
      for (let s = 0; s < 120; s++) {
        const ang = s * 0.13, r = 2 + 60 * Math.abs(Math.sin(s * 0.05));
        const cam = [Math.cos(ang) * r, 3, Math.sin(ang) * r];
        const F: GdFrameParams = { planes: null, cam, lodOn: true, lodOrtho: false, orthoD2: 0, lodScale, lodBias, fogEye: cam, fogCull2: Infinity, fogCullOther: false, fogCullAttach: false };
        const res = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, gpuState, 0, F);
        gpuState = res.state;
        const d2 = aabbDistanceSq(cam[0], cam[1], cam[2], box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
        const far = (dd + lodBias * ddb) * lodScale;
        cpuHidden = distanceLodHidden(d2, far, cpuHidden);
        // f32 may only disagree within float rounding of a threshold
        const near = Math.abs(Math.sqrt(d2) - far) < far * 1e-5 || Math.abs(Math.sqrt(d2) - far * 0.9) < far * 1e-5;
        if (!near) expect((gpuState & GD_STATE_LOD_HIDDEN) !== 0).toBe(cpuHidden);
        else cpuHidden = (gpuState & GD_STATE_LOD_HIDDEN) !== 0;   // resync at a rounding tie
        expect(res.instanceCount).toBe(cpuHidden ? 0 : 1);
      }
    }
  });

  it('ortho LOD uses the uniform zoom distance; LOD off clears the state', () => {
    const T = recTable(1);
    packGdRecord(T.f, T.u, T.i, 0, { box: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, drawDistance: 10, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 1, flags: 0 });
    const base: GdFrameParams = { planes: null, cam: [0, 0, 0], lodOn: true, lodOrtho: true, orthoD2: 121, lodScale: 1, lodBias: 0, fogEye: [0, 0, 0], fogCull2: Infinity, fogCullOther: false, fogCullAttach: false };
    let r = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, base);   // 11 > 10 → hidden although the camera sits in the box
    expect(r.why).toBe(GdWhy.Lod);
    r = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, r.state, 0, { ...base, orthoD2: 9.5 * 9.5 });   // 9.5 > 9 (0.9 x 10): stays hidden
    expect(r.instanceCount).toBe(0);
    r = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, r.state, 0, { ...base, lodOn: false });
    expect(r.instanceCount).toBe(1); expect(r.state & GD_STATE_LOD_HIDDEN).toBe(0);
  });

  it('fog horizon: classes, noFog, a mesh holds its LOD state while fogged, a group updates it first', () => {
    const T = recTable(2);
    const box = { minX: 100, minY: 0, minZ: 0, maxX: 101, maxY: 1, maxZ: 1 };
    packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: 50, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 1, flags: gdFogFlags(2, false) });
    packGdRecord(T.f, T.u, T.i, 1, { box, drawDistance: 50, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 4, count: 5, flags: gdFogFlags(2, false) | GD_FLAG_GROUP });
    const F: GdFrameParams = { planes: null, cam: [0, 0, 0], lodOn: true, lodOrtho: false, orthoD2: 0, lodScale: 1, lodBias: 0, fogEye: [0, 0, 0], fogCull2: 80 * 80, fogCullOther: true, fogCullAttach: false };
    const mesh = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, F), group = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 1, F);
    expect(mesh.why).toBe(GdWhy.Fog); expect(mesh.state & GD_STATE_LOD_HIDDEN).toBe(0);   // held
    expect(group.why).toBe(GdWhy.Lod); expect(group.state & GD_STATE_LOD_HIDDEN).toBe(GD_STATE_LOD_HIDDEN);   // LOD first
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, { ...F, fogCullOther: false }).why).toBe(GdWhy.Lod);
    expect(gdFogFlags(1, false)).toBe(GD_FLAG_FOG_ATTACH);
    packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: 0, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 1, flags: gdFogFlags(2, true) });
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, F).instanceCount).toBe(1);   // noFog: never fog-culled
  });

  it('Phase B mesh twins: the swap sequence over a camera path = the CPU twin rule (roles 1-4, off-near, LOD off)', () => {
    const R = rng(3);
    for (let t = 0; t < 24; t++) {
      const box = { minX: R() * 10, minY: 0, minZ: R() * 10, maxX: 0, maxY: 2, maxZ: 0 }; box.maxX = box.minX + 1 + R() * 4; box.maxZ = box.minZ + 1 + R() * 4;
      const t1 = 10 + R() * 20, t2 = t1 + 10 + R() * 30, lodScale = 0.6 + R() * 0.8, offNear = t % 3 === 0;
      const T = recTable(4);
      for (let role = 1; role <= 4; role++) packGdRecord(T.f, T.u, T.i, role - 1, { box, drawDistance: 0, drawDistanceBias: 0, indexCount: 30, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 1, flags: 0, twinRole: role, twinDist: t1, twinDist2: role >= 3 ? t2 : 0, twinFlags: offNear ? GD_TWIN_OFF_NEAR : 0 });
      const gst = [0, 0, 0, 0].map(() => GD_STATE_TWIN_NEAR2), cn1 = [false, false, false, false], cn2 = [true, true, true, true];
      for (let s = 0; s < 140; s++) {
        const ang = s * 0.11, rad = 1 + 90 * Math.abs(Math.sin(s * 0.045));
        const cam = [Math.cos(ang) * rad, 2, Math.sin(ang) * rad];
        const lodOn = s % 37 !== 5;   // now and then distance LOD off: the twin falls back (off-near / near2)
        const F: GdFrameParams = { planes: null, cam, lodOn, lodOrtho: false, orthoD2: 0, lodScale, lodBias: 0, fogEye: cam, fogCull2: Infinity, fogCullOther: false, fogCullAttach: false };
        const d2 = aabbDistanceSq(cam[0], cam[1], cam[2], box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
        const tie = (x: number) => x > 0 && (Math.abs(Math.sqrt(d2) - x * lodScale) < x * 1e-4 || Math.abs(Math.sqrt(d2) - 0.9 * x * lodScale) < x * 1e-4);
        for (let k = 0; k < 4; k++) {
          const role = k + 1;
          // the CPU rule (Renderer3D._buildDrawLists, E2 / P9)
          if (!lodOn) { cn1[k] = offNear; cn2[k] = true; }
          else {
            if (role !== 4) cn1[k] = !distanceLodHidden(d2, t1 * lodScale, !cn1[k]);
            if (role >= 3) cn2[k] = !distanceLodHidden(d2, t2 * lodScale, !cn2[k]);
          }
          const res = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, gst[k], k, F);
          gst[k] = res.state;
          if (tie(t1) || tie(t2)) { cn1[k] = (res.state & GD_STATE_TWIN_NEAR) !== 0; cn2[k] = (res.state & GD_STATE_TWIN_NEAR2) !== 0; continue; }   // f32 rounding tie: resync
          expect((res.state & GD_STATE_TWIN_NEAR) !== 0, `role ${role} near1 step ${s}`).toBe(cn1[k]);
          if (role >= 3) expect((res.state & GD_STATE_TWIN_NEAR2) !== 0, `role ${role} near2 step ${s}`).toBe(cn2[k]);
          expect(res.instanceCount).toBe(twinDraws(role, cn1[k], cn2[k]) ? 1 : 0);
        }
      }
    }
  });

  it('Phase B re-seed + cluster reject: a twin not visited the frame before starts over; a rejected member holds its state', () => {
    const T = recTable(1);
    const box = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
    packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: 50, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 1, flags: 0, twinRole: 2, twinDist: 20 });
    const F: GdFrameParams = { planes: null, cam: [30, 0, 0], lodOn: true, lodOrtho: false, orthoD2: 0, lodScale: 1, lodBias: 0, fogEye: [0, 0, 0], fogCull2: Infinity, fogCullOther: false, fogCullAttach: false, hcOn: true };
    const V = GD_CTL_ENABLED | GD_CTL_VISITED;
    // inside the hysteresis band (19 between 18 and 20): the swap state decides; near1 stays as it was
    const band = { ...F, cam: [19.5, 0, 0] };
    let r = gdCullRecord(T.f, T.u, V, GD_STATE_TWIN_NEAR | GD_STATE_VISITED_LAST, 0, band);
    expect(r.state & GD_STATE_TWIN_NEAR).toBe(GD_STATE_TWIN_NEAR); expect(r.instanceCount).toBe(0);   // far twin hidden (near1 held)
    // not visited last frame: re-seed (near1 off) → the band now keeps it far: the far twin draws
    r = gdCullRecord(T.f, T.u, V, GD_STATE_TWIN_NEAR, 0, band);
    expect(r.state & GD_STATE_TWIN_NEAR).toBe(0); expect(r.instanceCount).toBe(1);
    expect(r.state & GD_STATE_VISITED_LAST).toBe(GD_STATE_VISITED_LAST);
    // a rejected cluster member (enabled, not visited): drawn 0, state held, VISITED_LAST cleared
    r = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, GD_STATE_TWIN_NEAR | GD_STATE_LOD_HIDDEN | GD_STATE_VISITED_LAST, 0, { ...F, cam: [0.5, 0.5, 0.5] });
    expect(r.why).toBe(GdWhy.Cluster); expect(r.instanceCount).toBe(0);
    expect(r.state & (GD_STATE_TWIN_NEAR | GD_STATE_LOD_HIDDEN)).toBe(GD_STATE_TWIN_NEAR | GD_STATE_LOD_HIDDEN);
    expect(r.state & GD_STATE_VISITED_LAST).toBe(0);
    // disabled (not in the roster) clears VISITED_LAST too; without the hierarchical cull every record counts as visited
    expect(gdCullRecord(T.f, T.u, 0, GD_STATE_VISITED_LAST, 0, F).state & GD_STATE_VISITED_LAST).toBe(0);
    r = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, GD_STATE_TWIN_NEAR, 0, { ...band, hcOn: false });
    expect(r.why).not.toBe(GdWhy.Cluster); expect(r.state & GD_STATE_TWIN_NEAR).toBe(GD_STATE_TWIN_NEAR);   // no re-seed
  });

  it('CPU state: with GD_FRAME_CPU_STATE the LOD and twin choices are the control word state, whatever the distance', () => {
    const T = recTable(2);
    const box = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
    packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: 50, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 1, flags: 0, twinRole: 2, twinDist: 20 });
    const F: GdFrameParams = { planes: null, cam: [5, 0, 0], lodOn: true, lodOrtho: false, orthoD2: 0, lodScale: 1, lodBias: 0, fogEye: [0, 0, 0], fogCull2: Infinity, fogCullOther: false, fogCullAttach: false, cpuState: true };
    // the camera is 4 units away (near): the CPU says "LOD hidden" -> hidden; says "near" -> the far twin does not draw
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED | GD_CTL_CPU_LOD, 0, 0, F).why).toBe(GdWhy.Lod);
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED | GD_CTL_CPU_N1, 0, 0, F).why).toBe(GdWhy.Twin);
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, F).instanceCount).toBe(1);   // CPU: visible, far -> the far twin draws
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, { ...F, cpuState: false }).why).toBe(GdWhy.Twin);   // own state: 4 < 20 -> near
    // LOD off still clears (the CPU clears lodHidden then too)
    // LOD off: no LOD cull, and a twin falls back to lodTwinOffNear (false) -> the far twin draws, as on the CPU
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED | GD_CTL_CPU_LOD | GD_CTL_CPU_N1, 0, 0, { ...F, lodOn: false }).instanceCount).toBe(1);
  });

  it('Phase B group twins: the origin-box swap with hysteresis; no origin / twins off / LOD off = near', () => {
    const T = recTable(2);
    const box = { minX: -5, minY: 0, minZ: -5, maxX: 15, maxY: 5, maxZ: 15 }, origin = [0, 0, 0, 10, 0, 10];
    packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: 0, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 4, flags: GD_FLAG_GROUP, twinRole: 1, twinDist: 40, origin });
    packGdRecord(T.f, T.u, T.i, 1, { box, drawDistance: 0, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 4, count: 4, flags: GD_FLAG_GROUP, twinRole: 2, twinDist: 40, origin });
    const F: GdFrameParams = { planes: null, cam: [0, 0, 0], lodOn: true, lodOrtho: false, orthoD2: 0, lodScale: 1, lodBias: 0, fogEye: [0, 0, 0], fogCull2: Infinity, fogCullOther: false, fogCullAttach: false, groupTwins: true, hcOn: true };
    let near = false; const st = [0, 0];
    for (let s = 0; s < 200; s++) {
      const x = 10 + 60 * Math.abs(Math.sin(s * 0.05));
      const Fs = { ...F, cam: [x, 0, 5] };
      const d2 = (x - 10) * (x - 10);
      near = !distanceLodHidden(d2, 40, !near);
      const a = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, st[0], 0, Fs), b = gdCullRecord(T.f, T.u, GD_CTL_ENABLED, st[1], 1, Fs);
      st[0] = a.state; st[1] = b.state;
      expect(a.instanceCount + b.instanceCount).toBe(4);   // exactly one of the pair draws
      expect(a.instanceCount > 0).toBe(near);
    }
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 1, { ...F, cam: [200, 0, 0], groupTwins: false }).instanceCount).toBe(0);   // twins off: near only
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, { ...F, cam: [200, 0, 0], lodOn: false }).instanceCount).toBe(4);
    packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: 0, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 4, flags: GD_FLAG_GROUP, twinRole: 1, twinDist: 40, origin: null });
    expect(T.u[GdRecW.twinFlags] & GD_TWIN_NO_ORIGIN).toBe(GD_TWIN_NO_ORIGIN);
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, { ...F, cam: [200, 0, 0] }).instanceCount).toBe(4);   // no origin box: near
  });

  it('Phase B ranges: the GPU spans cover every CPU span (selectRanges), at most GD_RANGE_SPANS, equal when they fit', () => {
    const R = rng(11);
    const cull = new FrustumCuller();
    let eq = 0, fit = 0, over = 0;
    for (let t = 0; t < 60; t++) {
      // a "merged city chunk": many small boxes scattered over a wide area, emitted object by object
      const v: number[] = [], ix: number[] = [];
      const nObj = 150 + Math.floor(R() * 250);
      for (let k = 0; k < nObj; k++) {
        const cx = R() * 200 - 100, cz = R() * 200 - 100, h = 1 + R() * 6, base = v.length / 12;
        for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [1, h, 0], [0, h, 0], [0, 0, 1], [1, 0, 1], [1, h, 1], [0, h, 1]]) v.push(cx + dx, dy, cz + dz, 0, 1, 0, 0, 0, 1, 0, 0, 1);
        for (const q of [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4]) ix.push(base + q);
      }
      const rg = buildCullRanges(v, ix, 12, null, 64, 8);
      const pool = new Float32Array(gdRangeBoxFloats(rg.n, rg.blockRuns) + 12);
      packGdRangeBoxes(pool, 12, rg);
      const eye: [number, number, number] = [R() * 160 - 80, 2 + R() * 40, R() * 160 - 80], at: [number, number, number] = [R() * 160 - 80, 0, R() * 160 - 80];
      cull.setFromViewProjection(mat4.multiply(mat4.create(), mat4.perspectiveZO(mat4.create(), 0.5 + R(), 1.5, 0.1, 400), mat4.lookAt(mat4.create(), eye, at, [0, 1, 0])));
      const planes = cull.writePlanes(new Float32Array(24));
      const cpu: number[] = []; selectRanges(rg, cull, cpu, 2);
      const gpu = gdRangeSpans(planes, pool, 12, rg.n, rg.blockRuns, rg.first[1], ix.length, 2);
      expect(gpu.length / 2).toBeLessThanOrEqual(GD_RANGE_SPANS);
      // every CPU-kept index lies in a GPU span
      for (let k = 0; k < cpu.length; k += 2) {
        const a = cpu[k], b = a + cpu[k + 1];
        expect(gpu.some((_, j) => j % 2 === 0 && gpu[j] <= a && gpu[j] + gpu[j + 1] >= b), `span ${a}-${b}`).toBe(true);
      }
      if (cpu.length / 2 <= GD_RANGE_SPANS) { fit++; if (JSON.stringify(cpu) === JSON.stringify(gpu)) eq++; } else over++;
    }
    expect(fit).toBeGreaterThan(10);
    expect(eq).toBeGreaterThanOrEqual(fit - 2);   // f32 vs f64 may keep one extra run at a plane
    void over;
  });

  it('Phase C caster rule: light box, reach, shadow LOD, static / dynamic split, cascades, joiners, NOREACH', () => {
    const T = recTable(2);
    const box = { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 4, maxZ: 2 };
    packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: 0, drawDistanceBias: 0, indexCount: 36, firstIndex: 0, baseVertex: 0, firstInstance: 3, count: 1, flags: 0, shFeature: 0, shFlags: GD_SHF_CASTS });
    // planes: a +-50 box (light), a 0..10 box (cascade 0), a far-away box (cascade 1), the camera: x in [-100, 100]
    const boxPlanes = (x0: number, x1: number) => [1, 0, 0, -x0, -1, 0, 0, x1, 0, 1, 0, 100, 0, -1, 0, 100, 0, 0, 1, 100, 0, 0, -1, 100];
    const F: GdFrameParams = { planes: boxPlanes(-100, 100), cam: [0, 2, -20], lodOn: true, lodOrtho: false, orthoD2: 0, lodScale: 1, lodBias: 0, fogEye: [0, 0, 0], fogCull2: Infinity, fogCullOther: false, fogCullAttach: false, hcOn: true };
    const S: GdShadowParams = { on: true, light: boxPlanes(-50, 50), casc: [boxPlanes(-1, 10), boxPlanes(500, 600)], cascades: 2, ldir: [0.3, -0.9, 0.3], floorY: 0, reach: true,
      lodFar: 0.5, lodC0: 0.1, lodC1: 0.1, cache: true, split: true, wind: false, join: true, band: false, bandAttach: false, bandIn: 0 };
    const V = GD_CTL_ENABLED | GD_CTL_VISITED, E = GD_STATE_SH_ELIG;
    const bit = (l: number) => 1 << l;
    let r = gdShadowRecord(T.f, T.u, V, E, 0, F, S);
    expect(r.mask).toBe(bit(GdShLayer.direct) | bit(GdShLayer.farStatic) | bit(GdShLayer.farDyn) | bit(GdShLayer.c0) | bit(GdShLayer.c0Dyn));   // static + joiners (not drawn in yet)
    expect(r.state & (GD_STATE_MEM_FAR | GD_STATE_MEM_C0 | GD_STATE_MEM_C1)).toBe(GD_STATE_MEM_FAR | GD_STATE_MEM_C0);
    expect(r.join).toBe(0b011); expect(r.leave).toBe(0);
    r = gdShadowRecord(T.f, T.u, V, E | GD_STATE_IN_FAR | GD_STATE_IN_C0, 0, F, S);   // drawn into both: no joiner draws
    expect(r.mask).toBe(bit(GdShLayer.direct) | bit(GdShLayer.farStatic) | bit(GdShLayer.c0)); expect(r.join).toBe(0);
    r = gdShadowRecord(T.f, T.u, V | GD_CTL_DYNAMIC, E | GD_STATE_IN_FAR | GD_STATE_IN_C0, 0, F, S);   // a mover: dynamic layers; it leaves both
    expect(r.mask).toBe(bit(GdShLayer.direct) | bit(GdShLayer.farDyn) | bit(GdShLayer.c0Dyn)); expect(r.leave).toBe(0b011);
    expect(gdShadowRecord(T.f, T.u, V, 0, 0, F, S).mask).toBe(0);   // LOD / fog / twin hidden this frame (no SH_ELIG)
    expect(gdShadowRecord(T.f, T.u, V, E, 0, F, { ...S, light: boxPlanes(100, 200) }).mask).toBe(0);   // outside the light box
    // the shadow reach: a camera frustum far away -> only the static (unreached) memberships
    const noReach = gdShadowRecord(T.f, T.u, V, E, 0, { ...F, planes: boxPlanes(300, 400) }, S);
    expect(noReach.mask).toBe(bit(GdShLayer.farStatic) | bit(GdShLayer.c0));
    // P8 shadow LOD: too small for the far map (cascade 0 still fine)
    T.f[GdRecW.shFeature] = 0.3;
    expect(gdShadowRecord(T.f, T.u, V, E, 0, F, S).mask).toBe(bit(GdShLayer.c0) | bit(GdShLayer.c0Dyn));
    T.f[GdRecW.shFeature] = 0;
    // no split (cascade cache off): the cascades take reach-culled casters, no static / dynamic there
    expect(gdShadowRecord(T.f, T.u, V, E, 0, F, { ...S, split: false }).mask).toBe(bit(GdShLayer.direct) | bit(GdShLayer.farStatic) | bit(GdShLayer.farDyn) | bit(GdShLayer.c0));
    // a cluster rejected with NOREACH: the far static layer only, by the held state
    expect(gdShadowRecord(T.f, T.u, GD_CTL_ENABLED | GD_CTL_NOREACH, 0, 0, F, S).mask).toBe(bit(GdShLayer.farStatic));
    expect(gdShadowRecord(T.f, T.u, GD_CTL_ENABLED | GD_CTL_NOREACH, GD_STATE_LOD_HIDDEN, 0, F, S).mask).toBe(0);
    expect(gdShadowRecord(T.f, T.u, GD_CTL_ENABLED, E, 0, F, S).mask).toBe(0);   // rejected, not NOREACH
    // wind sway: dynamic while the wind blows
    T.u[GdRecW.shFlags] = GD_SHF_CASTS | GD_SHF_WIND;
    expect(gdShadowRecord(T.f, T.u, V, E, 0, F, { ...S, wind: true }).mask).toBe(bit(GdShLayer.direct) | bit(GdShLayer.farDyn) | bit(GdShLayer.c0Dyn));
    // disabled / forced / not a caster: nothing, and a disabled member drawn in leaves
    expect(gdShadowRecord(T.f, T.u, 0, GD_STATE_IN_FAR, 0, F, S)).toMatchObject({ mask: 0, leave: 1 });
    expect(gdShadowRecord(T.f, T.u, V | GD_CTL_FORCED, E, 0, F, S).mask).toBe(0);
    T.u[GdRecW.shFlags] = 0;
    expect(gdShadowRecord(T.f, T.u, V, E, 0, F, S).mask).toBe(0);
  });

  it('control words: disabled, forced (visible / hidden), no geometry; groups draw N copies', () => {
    const T = recTable(1);
    packGdRecord(T.f, T.u, T.i, 0, { box: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }, drawDistance: 0, drawDistanceBias: 0, indexCount: 6, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 7, flags: GD_FLAG_GROUP });
    const F: GdFrameParams = { planes: null, cam: [0, 0, 0], lodOn: false, lodOrtho: false, orthoD2: 0, lodScale: 1, lodBias: 0, fogEye: [0, 0, 0], fogCull2: Infinity, fogCullOther: false, fogCullAttach: false };
    expect(gdCullRecord(T.f, T.u, 0, 0, 0, F).why).toBe(GdWhy.Disabled);
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED | GD_CTL_FORCED, 0, 0, F).instanceCount).toBe(0);
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED | GD_CTL_FORCED | GD_CTL_FORCED_VIS, 0, 0, F).instanceCount).toBe(7);
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, F).instanceCount).toBe(7);
    T.u[GdRecW.indexCount] = 0;
    expect(gdCullRecord(T.f, T.u, GD_CTL_ENABLED, 0, 0, F).why).toBe(GdWhy.NoGeometry);
  });
});

// ── bookkeeping ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('P15 bookkeeping', () => {
  it('dirty ranges merge gaps and cap at n', () => {
    const d = new GdDirtyRanges();
    for (const i of [5, 1, 3, 200, 201, 90]) d.mark(i);
    expect(d.take(1000, 10)).toEqual([1, 5, 90, 1, 200, 2]);
    expect(d.any).toBe(false);
    d.markAll(); d.mark(3);
    expect(d.take(50)).toEqual([0, 50]);
    d.mark(60); expect(d.take(50)).toEqual([]);
  });
  it('record slots reuse freed indices', () => {
    const s = new GdRecordSlots();
    expect([s.alloc(), s.alloc(), s.alloc()]).toEqual([0, 1, 2]);
    s.free(1); expect(s.alloc()).toBe(1); expect(s.high).toBe(3);
  });
  it('buckets split on state code and on a non-atlas texture; refs changes invalidate; pending pipelines are left out', () => {
    const order = [4, 2, 7, 1, 3, 0];
    const code: Record<number, number> = { 4: 0, 2: 0, 7: GD_CODE_TEXTURED, 1: GD_CODE_TEXTURED, 3: GD_CODE_TEXTURED | GD_CODE_ATLAS, 0: GD_CODE_TEXTURED | GD_CODE_ATLAS };
    const tex: Record<number, unknown> = { 7: 'a', 1: 'b', 3: 'x', 0: 'y' };
    const b = gdBuckets(order, (r) => code[r], (r) => tex[r], () => null);
    expect(b.map((x) => [x.start, x.end, x.code])).toEqual([[0, 2, 0], [2, 3, GD_CODE_TEXTURED], [3, 4, GD_CODE_TEXTURED], [4, 6, GD_CODE_TEXTURED | GD_CODE_ATLAS]]);
    const refs = new Map<number, GdBucketRefs>();
    const resolve = (bk: { leadRec: number }, out: GdBucketRefs) => { const r = refs.get(bk.leadRec) ?? { pipeline: 'p' + bk.leadRec, bg0: 'g', bg1: null, bg2: null, vb: 'v', ib: 'i' }; Object.assign(out, r); };
    for (const bk of b) resolve(bk, bk);
    const scratch: GdBucketRefs = { pipeline: null, bg0: null, bg1: null, bg2: null, vb: null, ib: null };
    expect(gdBucketsChanged(b, resolve, scratch)).toBe(false);
    refs.set(7, { pipeline: 'p7', bg0: 'g2', bg1: null, bg2: null, vb: 'v', ib: 'i' });
    expect(gdBucketsChanged(b, resolve, scratch)).toBe(true);
    b[1].pipeline = null;   // still compiling
    const { cmds, skipped } = gdBundleCommands(order, b);
    expect(skipped).toBe(1);
    expect(cmds.filter((c) => c.op === 'draw').map((c) => (c as { rec: number }).rec)).toEqual([4, 2, 1, 3, 0]);
  });
});

// ── END TO END: the real renderer, the compute pass emulated by the mirror ──────────────────────────────────────
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

type Draw = { slot: number; indexCount: number; firstIndex: number };

/** A device whose buffers are byte arrays; render bundles record their commands; compute pipelines resolve. */
function recordingDevice(opts: { maps?: boolean } = {}) {
  const mem = new Map<object, Uint8Array>();
  const handler: ProxyHandler<() => unknown> = {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (typeof k === 'string' && (k.endsWith('Async') || k === 'onSubmittedWorkDone')) return () => new Promise(() => { /* never */ });
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'size') return 1 << 30;
      if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
      return stub;
    },
    apply() { return stub; },
  };
  const stub: unknown = new Proxy(function () { /* stub */ }, handler);
  const onEncode: Array<(dispatch: number, label: string) => void> = [];
  const encoder = new Proxy({}, { get: (_t, k) => {
    if (k === 'copyBufferToBuffer') return (src: object, so: number, dst: object, dof: number, n: number) => { const a = mem.get(src), b = mem.get(dst); if (a && b) b.set(a.subarray(so, so + n), dof); };
    if (k === 'clearBuffer') return (b: object, off = 0, size?: number) => { const m = mem.get(b); m?.fill(0, off, size === undefined ? m.length : off + size); };
    if (k === 'beginComputePass') return () => { let nd = 0, label = ''; return new Proxy({}, { get: (_t2, k2) => (k2 === 'dispatchWorkgroups' ? () => { const d = nd++; for (const f of onEncode) f(d, label); } : k2 === 'setPipeline' ? (p: { label?: unknown }) => { label = typeof p?.label === 'string' ? p.label : ''; } : () => { /* */ }) }); };
    if (k === 'finish') return () => stub;
    return stub;
  } });
  const queue = new Proxy({}, { get: (_t, k) => {
    if (k === 'writeBuffer') return (buf: object, off: number, data: ArrayBuffer | ArrayBufferView, dataOff = 0, size?: number) => {
      const isAB = data instanceof ArrayBuffer;
      const bpe = isAB ? 1 : ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
      const src = isAB ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const o = dataOff * bpe, n = size !== undefined ? size * bpe : src.byteLength - o;
      const m = mem.get(buf); if (m) m.set(src.subarray(o, o + n), off);
    };
    if (k === 'onSubmittedWorkDone') return () => new Promise(() => { /* never */ });
    return stub;
  } });
  const device = new Proxy({}, { get: (_t, k) => {
    if (k === 'queue') return queue;
    if (k === 'features') return { has: () => false };
    if (k === 'createComputePipelineAsync') return (d: { label?: string }) => Promise.resolve({ compute: true, label: d?.label ?? '' });
    if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
    if (k === 'createBuffer') return (d: { size: number }) => {
      // opts.maps: read-backs resolve (on a microtask) with the buffer's bytes at that moment
      const b = { size: d.size, destroy() { /* */ }, label: '', unmap() { /* */ },
        mapAsync: () => (opts.maps ? Promise.resolve() : new Promise(() => { /* */ })),
        getMappedRange: (o = 0, n?: number) => mem.get(b)!.slice(o, n === undefined ? undefined : o + n).buffer };
      mem.set(b, new Uint8Array(d.size)); return b;
    };
    if (k === 'createCommandEncoder') return () => encoder;
    if (k === 'createRenderBundleEncoder') return () => {
      const cmds: { offset: number }[] = [];
      return new Proxy({}, { get: (_t2, k2) => (k2 === 'drawIndexedIndirect' ? (_b: unknown, offset: number) => { cmds.push({ offset }); } : k2 === 'finish' ? () => ({ cmds }) : () => { /* state */ }) });
    };
    if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
    return stub;
  } });
  return { device: device as unknown as GPUDevice, mem, onEncode };
}

/** A pass that records the draws it receives (a bundle's indirect draws read the emulated args). */
function recordingPass(argsOf: () => Uint32Array | null) {
  const draws: Draw[] = [];
  let bundles = 0;
  const pass = new Proxy({}, { get: (_t, k) => {
    if (k === 'drawIndexed') return (indexCount: number, instanceCount: number, firstIndex: number, _bv: number, firstInstance: number) => { for (let i = 0; i < instanceCount; i++) draws.push({ slot: firstInstance + i, indexCount, firstIndex }); };
    if (k === 'executeBundles') return (bs: { cmds: { offset: number }[] }[]) => {
      bundles++;
      const a = argsOf()!;
      for (const b of bs) for (const c of b.cmds) {
        const o = c.offset / 4, ic = a[o], n = a[o + 1], fi = a[o + 2], first = a[o + 4];
        if (ic > 0) for (let i = 0; i < n; i++) draws.push({ slot: first + i, indexCount: ic, firstIndex: fi });
      }
    };
    return () => { /* state */ };
  } });
  return { pass: pass as unknown as GPURenderPassEncoder, draws, bundles: () => bundles };
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  const flags = new Proxy({}, { get: () => 1 });
  for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

async function scene(opts: { maps?: boolean } = {}) {
  const { Renderer3D } = await import('./renderer-3d');
  const { Camera3D } = await import('./camera-3d');
  const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
  const { ArrayGroup3D } = await import('../../scene-graph/shapes/array-group-3d');
  const dev = recordingDevice(opts);
  const cam = new Camera3D();
  const r = new Renderer3D(dev.device, cam) as unknown as Record<string, any>;
  const R = rng(7);
  const box = (x: number, z: number, s: number, h: number, name: string) => {
    const v: number[] = [], ix: number[] = [];
    const c = [[0, 0, 0], [s, 0, 0], [s, h, 0], [0, h, 0], [0, 0, s], [s, 0, s], [s, h, s], [0, h, s]];
    for (const p of c) v.push(p[0], p[1], p[2], 0, 1, 0, 0, 0, 1, 0, 0, 1);
    const f = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4];
    ix.push(...f);
    const m = new Mesh3D(isvc, x, 0, z, { primitive: 'custom', geometry: { vertices: new Float32Array(v), indices: new Uint32Array(ix), format: '12float' } });
    m.name = name; m.setGeometryKeyOverride('k-' + name);
    return m;
  };
  const meshes: InstanceType<typeof Mesh3D>[] = [];
  for (let i = 0; i < 70; i++) {
    const m = box(R() * 120 - 60, R() * 120 - 60, 0.5 + R() * 3, 0.5 + R() * 6, 'm' + i);
    if (i % 3 === 0) { m.drawDistance = 10 + R() * 40; m.drawDistanceBias = R(); }
    if (i % 4 === 0) m.fogClass = 2; else if (i % 7 === 0) m.fogClass = 1;
    if (i % 11 === 0) m.material.doubleSided = true;
    meshes.push(m);
  }
  // near / far twins (forced: the CPU decides)
  for (let i = 0; i < 6; i++) {
    const a = box(R() * 80 - 40, R() * 80 - 40, 2, 2, 'tn' + i), b = box(a.x, a.z, 2, 2, 'tf' + i);
    a.lodTwinRole = 1; b.lodTwinRole = 2; a.lodTwinDist = b.lodTwinDist = 25;
    meshes.push(a, b);
  }
  // not records: transparent, vertex-coloured
  const glass = box(5, 5, 3, 3, 'glass'); glass.material.opacity = 0.5; meshes.push(glass);
  const vc = box(-5, 5, 2, 2, 'vc'); (vc as unknown as { vertexColors: unknown }).vertexColors = new Float32Array(8 * 4).fill(1); meshes.push(vc);
  // an instanced group (explicit), a far-LOD'd one, and a group twin pair (forced)
  const groups: InstanceType<typeof ArrayGroup3D>[] = [];
  const mkGroup = (name: string, n: number, cx: number, cz: number) => {
    const src = box(cx, cz, 1, 1, name + '-src');
    const g = new ArrayGroup3D(isvc, src.id, { mode: 'explicit', offsets: Array.from({ length: n }, (_, k) => [cx + (k % 4) * 3, 0, cz + Math.floor(k / 4) * 3] as [number, number, number]) });
    (g as unknown as { _name: string })._name = name;
    meshes.push(src); groups.push(g);
    return { src, g };
  };
  mkGroup('gA', 8, 10, -30);
  const gB = mkGroup('gB', 12, -40, 30); gB.src.drawDistance = 30; gB.src.fogClass = 2;
  const gn = mkGroup('gTn', 4, 30, 30), gf = mkGroup('gTf', 4, 30, 30);
  gn.src.lodTwinRole = 1; gf.src.lodTwinRole = 2; gn.src.lodTwinDist = gf.src.lodTwinDist = 40;
  r.setArrayGroups(groups);
  return { r, dev, cam, meshes, groups, Renderer3D, box };
}

/** Emulate the compute pass with the mirror, over the GPU scene's buffers in the recording device's memory. */
function emulator(r: Record<string, any>, mem: Map<object, Uint8Array>) {
  let args: Uint32Array | null = null;
  const run = (dispatch = 0, label = 'GdCull') => {
    const gd = r._gd;
    if (label === 'GdRanges') { runRanges(gd); return; }
    if (label === 'GdShadow') { runShadow(gd); return; }
    if (label.startsWith('GdShadowCommit')) { runCommit(gd, +label.slice(14)); return; }
    if (label !== 'GdCull') return;
    const fb = mem.get(gd._frameBuf)!, ff = new Float32Array(fb.buffer, fb.byteOffset, GD_FRAME_FLOATS), fu = new Uint32Array(fb.buffer, fb.byteOffset, GD_FRAME_FLOATS);
    const fl = fu[GdFrameW.ctl], n = fu[GdFrameW.ctl + 1];
    const F: GdFrameParams = {
      planes: fl & GD_FRAME_FRUSTUM ? ff.slice(0, 24) : null, cam: [ff[24], ff[25], ff[26]], orthoD2: ff[27],
      lodOn: !!(fl & GD_FRAME_LOD), lodOrtho: !!(fl & GD_FRAME_LOD_ORTHO), lodScale: ff[32], lodBias: ff[33],
      fogEye: [ff[28], ff[29], ff[30]], fogCull2: ff[31], fogCullOther: !!(fl & GD_FRAME_FOG_OTHER), fogCullAttach: !!(fl & GD_FRAME_FOG_ATTACH),
      hcOn: !!(fl & GD_FRAME_HC), groupTwins: !!(fl & GD_FRAME_GROUP_TWINS), cpuState: !!(fl & GD_FRAME_CPU_STATE),
    };
    const rb = mem.get(gd._recBuf)!, recF = new Float32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4), recU = new Uint32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4);
    const ctl = new Uint32Array(mem.get(gd._ctlBuf)!.buffer), st = new Uint32Array(mem.get(gd._stateBuf)!.buffer), pos = new Uint32Array(mem.get(gd._posBuf)!.buffer);
    args = new Uint32Array(mem.get(gd._argsBuf)!.buffer);
    for (let i = 0; i < n; i++) {
      const res = gdCullRecord(recF, recU, ctl[i], st[i], i, F);
      st[i] = res.state;
      const o = pos[i] * 5, ro = i * GD_REC_WORDS;
      args[o] = recU[ro + GdRecW.indexCount]; args[o + 1] = res.instanceCount; args[o + 2] = recU[ro + GdRecW.firstIndex]; args[o + 3] = recU[ro + GdRecW.baseVertex]; args[o + 4] = recU[ro + GdRecW.firstInstance];
    }
  };
  /** The range jobs (cs_ranges) by the mirror gdRangeSpans: block 0 holds cs_cull's verdict. */
  const runRanges = (gd: Record<string, any>) => {
    const fb = mem.get(gd._frameBuf)!, ff = new Float32Array(fb.buffer, fb.byteOffset, GD_FRAME_FLOATS), fu = new Uint32Array(fb.buffer, fb.byteOffset, GD_FRAME_FLOATS);
    const fl = fu[GdFrameW.ctl], gap = fu[GdFrameW.ctl + 3];
    const rb = mem.get(gd._recBuf)!, recU = new Uint32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4);
    const pos = new Uint32Array(mem.get(gd._posBuf)!.buffer), J = new Uint32Array(mem.get(gd._jobBuf)!.buffer), pool = new Float32Array(mem.get(gd._boxBuf)!.buffer);
    const a = new Uint32Array(mem.get(gd._argsBuf)!.buffer);
    for (let jb = 0; jb < gd._nJobs; jb++) {
      const o = jb * GD_JOB_WORDS, rec = J[o + GdJobW.rec], base = pos[rec] * 5, n = a[base + 1], ro = rec * GD_REC_WORDS;
      const put = (k: number, first: number, count: number, inst: number) => { const q = base + k * 5; a[q] = count; a[q + 1] = inst; a[q + 2] = recU[ro + GdRecW.firstIndex] + first; a[q + 3] = recU[ro + GdRecW.baseVertex]; a[q + 4] = recU[ro + GdRecW.firstInstance]; };
      const on = n > 0 && (fl & GD_FRAME_RANGES) && (fl & GD_FRAME_FRUSTUM);
      if (!on) { for (let k = 1; k < GD_RANGE_SPANS; k++) put(k, 0, 0, 0); continue; }
      const sp = gdRangeSpans(ff.slice(0, 24), pool, J[o + GdJobW.boxBase], J[o + GdJobW.nRuns], J[o + GdJobW.blockRuns], J[o + GdJobW.runIdx], J[o + GdJobW.totalIdx], gap);
      for (let k = 0; k < GD_RANGE_SPANS; k++) if (k * 2 < sp.length) put(k, sp[k * 2], sp[k * 2 + 1], n); else put(k, 0, 0, 0);
    }
  };
  /** cs_shadow by the mirror gdShadowRecord (the frame inputs unpacked from both uniform buffers). */
  const frameOf = (gd: Record<string, any>): GdFrameParams => {
    const fb = mem.get(gd._frameBuf)!, ff = new Float32Array(fb.buffer, fb.byteOffset, GD_FRAME_FLOATS), fu = new Uint32Array(fb.buffer, fb.byteOffset, GD_FRAME_FLOATS);
    const fl = fu[GdFrameW.ctl];
    return { planes: fl & GD_FRAME_FRUSTUM ? ff.slice(0, 24) : null, cam: [ff[24], ff[25], ff[26]], orthoD2: ff[27], lodOn: !!(fl & GD_FRAME_LOD), lodOrtho: !!(fl & GD_FRAME_LOD_ORTHO),
      lodScale: ff[32], lodBias: ff[33], fogEye: [ff[28], ff[29], ff[30]], fogCull2: ff[31], fogCullOther: !!(fl & GD_FRAME_FOG_OTHER), fogCullAttach: !!(fl & GD_FRAME_FOG_ATTACH),
      hcOn: !!(fl & GD_FRAME_HC), groupTwins: !!(fl & GD_FRAME_GROUP_TWINS), cpuState: !!(fl & GD_FRAME_CPU_STATE) };
  };
  const runShadow = (gd: Record<string, any>) => {
    const F = frameOf(gd);
    const sb = mem.get(gd._shFrameBuf)!, sf = new Float32Array(sb.buffer, sb.byteOffset, GD_SH_FRAME_FLOATS), su = new Uint32Array(sb.buffer, sb.byteOffset, GD_SH_FRAME_FLOATS);
    const fl = su[GdShFrameW.ctl], base = su[GdShFrameW.ctl + 2], stride = su[GdShFrameW.ctl + 3];
    const S: GdShadowParams = { on: !!(fl & GD_SH_ON), light: fl & GD_SH_LIGHT ? sf.slice(0, 24) : null, casc: [sf.slice(24, 48), sf.slice(48, 72)], cascades: su[GdShFrameW.ctl + 1],
      ldir: [sf[72], sf[73], sf[74]], floorY: sf[75] > 1e37 ? Infinity : sf[75], reach: !!(fl & GD_SH_REACH), lodFar: sf[76], lodC0: sf[77], lodC1: sf[78], bandIn: sf[79],
      cache: !!(fl & GD_SH_CACHE), split: !!(fl & GD_SH_SPLIT), wind: !!(fl & GD_SH_WIND), join: !!(fl & GD_SH_JOIN), band: !!(fl & GD_SH_BAND), bandAttach: !!(fl & GD_SH_BAND_ATTACH) };
    const rb = mem.get(gd._recBuf)!, recF = new Float32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4), recU = new Uint32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4);
    const ctl = new Uint32Array(mem.get(gd._ctlBuf)!.buffer), st = new Uint32Array(mem.get(gd._stateBuf)!.buffer), a = new Uint32Array(mem.get(gd._argsBuf)!.buffer);
    const fb = new Uint32Array(mem.get(gd._frameBuf)!.buffer), n = fb[GdFrameW.ctl + 1];
    const stats = new Uint32Array(mem.get(gd._statsBuf)!.buffer);
    const put = (blk: number, ro: number, inst: number) => { const o = blk * 5; a[o] = recU[ro + GdRecW.indexCount]; a[o + 1] = inst; a[o + 2] = recU[ro + GdRecW.firstIndex]; a[o + 3] = recU[ro + GdRecW.baseVertex]; a[o + 4] = recU[ro + GdRecW.firstInstance]; };
    for (let i = 0; i < n; i++) {
      const res = gdShadowRecord(recF, recU, ctl[i], st[i], i, F, S);
      st[i] = res.state;
      const ro = i * GD_REC_WORDS;
      for (let L = 0; L < GD_SH_LAYERS; L++) put(base + L * stride + i, ro, (res.mask >> L) & 1 ? recU[ro + GdRecW.count] : 0);
      // GD_SH_COMPACT: the nonzero dynamic blocks appended to the compact lists (cs_shadow's atomic slots)
      if ((fl & GD_SH_COMPACT) && !(ctl[i] & GD_CTL_VB_OV)) GD_SH_COMPACT_LAYERS.forEach((L, j) => {
        if (!((res.mask >> L) & 1)) return;
        const slot = stats[GdStat.shCompact + j]++;
        if (slot < stride) put(base + (GD_SH_LAYERS + j) * stride + slot, ro, recU[ro + GdRecW.count]);
      });
    }
  };
  const runCommit = (gd: Record<string, any>, k: number) => {
    const st = new Uint32Array(mem.get(gd._stateBuf)!.buffer), n = new Uint32Array(mem.get(gd._frameBuf)!.buffer)[GdFrameW.ctl + 1];
    for (let i = 0; i < n; i++) st[i] = (st[i] & (GD_STATE_MEM_FAR << k)) ? (st[i] | (GD_STATE_IN_FAR << k)) : (st[i] & ~(GD_STATE_IN_FAR << k));
  };
  /** The instance slots of shadow layer L the GPU draws this frame. */
  const shadowSlots = (L: number): Set<number> => {
    const gd = r._gd, out = new Set<number>(), a = new Uint32Array(mem.get(gd._argsBuf)!.buffer);
    const base = gd._argBlocks + L * gd._cap;
    for (let i = 0; i < gd._slots.high; i++) { const o = (base + i) * 5; if (a[o] > 0) for (let k = 0; k < a[o + 1]; k++) out.add(a[o + 4] + k); }
    return out;
  };
  return { run, args: () => args, shadowSlots };
}

/** The CPU path's main-pass sequence of this frame from its lists (the batched segment in rank order, then multi,
 *  vertex-coloured and transparent), expanded per instance — what _drawMainPass submits. */
function cpuSequence(r: Record<string, any>): Draw[] {
  const out: Draw[] = [];
  const simple = [...r._opaqueSimple] as { mesh: { id: string }; idx: number; count?: number }[];
  const ord = r._drawOrder;
  const keyed = simple.map((e, i) => ({ e, k: ord.get(e.mesh.id) ?? 0x7fffffff, i }));
  keyed.sort((a, b) => (a.k - b.k) || (a.i - b.i));
  const push = (e: { mesh: { id: string }; idx: number; count?: number; submesh?: { indexOffset: number; indexCount: number }; range?: { indexOffset: number; indexCount: number } }) => {
    const a = r._geomAllocs.get(e.mesh.id); if (!a) return;
    const sub = e.submesh ?? e.range;   // a P11 index sub-range draws like a submesh range
    for (let i = 0; i < (e.count ?? 1); i++) out.push({ slot: e.idx + i, indexCount: sub ? sub.indexCount : a.indexCount, firstIndex: a.firstIndex + (sub ? sub.indexOffset : 0) });
  };
  for (const { e } of keyed) push(e);
  for (const e of r._opaqueMulti) push(e);
  for (const e of r._opaqueVC) push(e);
  for (const e of r._transparent) push(e);
  return out;
}

describe('P15 end to end: GPU scene + emulated cull = the CPU main pass, frame for frame', () => {
  it('a camera path with LOD swaps, fog horizon, twins, groups, hidden / moved / re-materialled meshes', async () => {
    const { r, dev, cam, meshes, Renderer3D, box } = await scene();
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean; rangeCulling: boolean };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, rc: R3.rangeCulling };
    R3.gpuDriven = true; R3.gpuDrivenLean = false;   // full CPU lists every frame: the reference sequence
    R3.rangeCulling = false;                          // a ranged mesh's sub-range draws are a CPU-only refinement (identical pixels)
    try {
      const em = emulator(r, dev.mem);
      dev.onEncode.push(em.run);
      let list = meshes.slice();
      let compared = 0, gpuFrames = 0;
      const twinSeen = { near: false, far: false };
      for (let f = 0; f < 90; f++) {
        await Promise.resolve();   // the cull pipeline resolves on a microtask
        const ang = f * 0.09, rad = 5 + 70 * Math.abs(Math.sin(f * 0.04));
        cam.setPosition(Math.cos(ang) * rad, 2 + (f % 30) * 0.5, Math.sin(ang) * rad);
        cam.setTarget(Math.cos(ang + 1.2) * 20, 0, Math.sin(ang + 1.2) * 20);
        if (f === 30) { r.fogHardEdge = true; r.setFog({ mode: 'linear', near: 20, far: 45, color: [0.5, 0.5, 0.6], density: 0 }); r.setFogHorizon({ buildingsOnly: true }); }
        if (f === 60) { r.setFogHorizon({ buildingsOnly: false }); r.fogHardEdge = false; }
        if (f === 20) list = list.filter((m) => m.name !== 'm5' && m.name !== 'm6');   // hidden (not in the frame's roster)
        if (f === 25) list = meshes.slice();                                           // shown again
        if (f === 35 || f === 36) {   // new meshes mid-path (their keys rank between existing ones): the O(new) insertion
          for (let k = 0; k < 3; k++) { const nm = box(f - 30 + k * 7, 4 - k * 9, 1.5, 2, 'm' + (k * 13 + f) + 'x'); if (k === 1) { nm.drawDistance = 20; } meshes.push(nm); }
          list = meshes.slice();
        }
        if (f === 40) { const m = meshes.find((x) => x.name === 'm9')!; m.setPosition3D(m.x + 30, m.y, m.z); }   // moved
        if (f === 50) { const m = meshes.find((x) => x.name === 'm12')!; m.material.opacity = 0.4; m.materialDirty = true; }   // → transparent
        if (f === 55) { const m = meshes.find((x) => x.name === 'm12')!; m.material.opacity = 1; m.materialDirty = true; }
        const rp = recordingPass(em.args);
        r.drawMeshes(rp.pass, list, 1300, 850);
        if (!r._gdDrew) continue;   // the cull pipeline resolves asynchronously (first frames: CPU path)
        gpuFrames++;
        expect(rp.bundles()).toBe(1);
        const want = cpuSequence(r);
        if (JSON.stringify(rp.draws) !== JSON.stringify(want)) {
          const nameOf = (slot: number) => { for (const [id, sl] of r._meshInstanceSlots) if (sl === slot) return meshes.find((m) => m.id === id)?.name; for (const [gid, fs] of r._arrayGroupFirstSlot) if (slot >= fs && slot < fs + (r._arrayGroupSlotCount.get(gid) ?? 0)) return 'g' + gid.slice(0, 4); return '?' + slot; };
          console.log('FRAME', f, 'GPU', rp.draws.map((d: Draw) => nameOf(d.slot)).join(','), 'CPU', want.map((d) => nameOf(d.slot)).join(','), 'RANK', r._drawOrder.orderedMeshes().map((m: any) => m.name).join(','));
        }
        expect(rp.draws).toEqual(want);
        compared += want.length;
        for (const m of meshes) if (/^t[nf]\d$/.test(m.name) && want.some((d) => d.slot === r._meshInstanceSlots.get(m.id))) { if (m.name[1] === 'n') twinSeen.near = true; else twinSeen.far = true; }
      }
      expect(gpuFrames).toBeGreaterThan(80);
      expect(compared).toBeGreaterThan(500);
      // Phase B: the twins are GPU-decided records (not forced), and both twins of a pair drew over the path
      const tw = meshes.filter((m) => /^t[nf]\d$/.test(m.name));
      expect(tw.every((m) => r._gd.owns(m) && r._gd._forced[m._gdRec] === 0)).toBe(true);
      expect(twinSeen.near && twinSeen.far).toBe(true);
      const st = r.getGpuDrivenStats();
      expect(st.records).toBeGreaterThan(80);
      // rebuilds only on structure changes (the roster edits above, the transparent swap and back)
      expect(st.rebuilds).toBeLessThan(15);
      expect(st.inserts).toBeGreaterThanOrEqual(6);
      expect(r.getFrameStats3D().gpuOrphanDraws).toBe(0);
    } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; R3.rangeCulling = prev.rc; }
  });

  it('Phase B ranges: heavy meshes partly in view draw only their runs in the view; every CPU span is covered', async () => {
    const { r, dev, cam, meshes, Renderer3D } = await scene();
    const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean; rangeCulling: boolean; CULL_RANGE_TRIS: number };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, rc: R3.rangeCulling, rt: R3.CULL_RANGE_TRIS };
    R3.gpuDriven = true; R3.gpuDrivenLean = false; R3.rangeCulling = true; R3.CULL_RANGE_TRIS = 64;
    try {
      const R = rng(5);
      for (let h = 0; h < 4; h++) {   // heavy merged chunks (>= CULL_RANGE_MIN_TRIS triangles), spread wide
        const v: number[] = [], ix: number[] = [];
        for (let k = 0; k < 220; k++) {
          const cx = R() * 140 - 70, cz = R() * 140 - 70, hh = 1 + R() * 5, base = v.length / 12;
          for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [1, hh, 0], [0, hh, 0], [0, 0, 1], [1, 0, 1], [1, hh, 1], [0, hh, 1]]) v.push(cx + dx, dy, cz + dz, 0, 1, 0, 0, 0, 1, 0, 0, 1);
          for (const q of [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4]) ix.push(base + q);
        }
        const m = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: { vertices: new Float32Array(v), indices: new Uint32Array(ix), format: '12float' } });
        m.name = 'heavy' + h; m.setGeometryKeyOverride('k-heavy' + h);
        meshes.push(m);
      }
      const em = emulator(r, dev.mem); dev.onEncode.push(em.run);
      let cpuTris = 0, gpuTris = 0, rangedFrames = 0, partial = 0;
      for (let f = 0; f < 60; f++) {
        await Promise.resolve();
        const ang = f * 0.1;
        cam.setPosition(Math.cos(ang) * 30, 6, Math.sin(ang) * 30); cam.setTarget(Math.cos(ang + 2) * 60, 0, Math.sin(ang + 2) * 60);
        const rp = recordingPass(em.args);
        r.drawMeshes(rp.pass, meshes, 1300, 850);
        if (!r._gdDrew) continue;
        const want = cpuSequence(r);
        const key = (d: Draw) => d.slot;
        const bySlot = (ds: Draw[]) => { const m = new Map<number, [number, number][]>(); for (const d of ds) { const a = m.get(key(d)) ?? []; a.push([d.firstIndex, d.firstIndex + d.indexCount]); m.set(key(d), a); } return m; };
        const G = bySlot(rp.draws), C = bySlot(want);
        expect([...G.keys()].sort()).toEqual([...C.keys()].sort());   // the same objects drawn
        for (const [slot, iv] of C) for (const [a, b] of iv) expect(G.get(slot)!.some(([x, y]) => x <= a && y >= b), `slot ${slot} ${a}-${b}`).toBe(true);
        for (const d of want) cpuTris += d.indexCount / 3;
        for (const d of rp.draws) gpuTris += d.indexCount / 3;
        if (r._gd.stats.ranged > 0) rangedFrames++;
        for (const m of meshes) if (/^heavy/.test(m.name)) { const iv = G.get(r._meshInstanceSlots.get(m.id)); const al = r._geomAllocs.get(m.id); if (iv && al && iv.reduce((t, [x, y]) => t + y - x, 0) < al.indexCount) partial++; }
      }
      expect(rangedFrames).toBeGreaterThan(40);
      expect(partial).toBeGreaterThan(40);   // heavy meshes really drew only part of their triangles
      expect(gpuTris).toBeLessThanOrEqual(cpuTris * 1.1);   // close to the CPU's ranged draws (overflow merges add a little)
      // ...and far below drawing the heavy meshes whole
      R3.rangeCulling = false;
    } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; R3.rangeCulling = prev.rc; R3.CULL_RANGE_TRIS = prev.rt; }
  });

  it('Phase C: the GPU shadow casters of every layer = the CPU path\'s shadow lists, frame for frame', async () => {
    const mk = async () => {
      const sc = await scene();
      const r = sc.r;
      r.enableShadows(1024, 60);
      r.setShadowCascades({ cascades: 3, nearExtent: 10 });
      r.setDirectionalLight(-0.4, -0.8, -0.3, 1, 1, 1, 1);
      r._wind = { ...(r._wind ?? {}), strength: 1, speed: 1 };
      for (const m of sc.meshes) {
        const k = +((m.name as string).replace(/\D/g, '') || 0);
        if (k % 5 === 1) m.material.windSway = true;
        if (k % 6 === 2) m.shadowFeatureSize = 0.05 + (k % 4) * 0.4;
        if ((m.name as string) === 'gA-src') m.castsInstancedShadow = true;
      }
      return sc;
    };
    const A = await mk(), B = await mk();
    const R3 = A.Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, sh: (await import('./gpu-scene')).GpuDrivenMain.shadows };
    const { GpuDrivenMain } = await import('./gpu-scene');
    try {
      R3.gpuDriven = true; R3.gpuDrivenLean = true;
      const em = emulator(A.r, A.dev.mem); A.dev.onEncode.push(em.run);
      const emB = emulator(B.r, B.dev.mem); B.dev.onEncode.push(emB.run);
      const lists = (r: Record<string, any>) => [r._shadowList, r._shadowStaticList, r._shadowDynList, r._cascadeLists[0], r._cascadeDynLists[0], r._cascadeLists[1], r._cascadeDynLists[1]];
      const slotsOf = (list: { idx: number; count?: number }[]) => { const o = new Set<number>(); for (const e of list) for (let k = 0; k < (e.count ?? 1); k++) o.add(e.idx + k); return o; };
      let compared = 0, gpuFrames = 0, nonEmpty = new Array(GD_SH_LAYERS).fill(0);
      for (let f = 0; f < 160; f++) {
        await Promise.resolve();
        const ang = f * 0.06, rad = 10 + 50 * Math.abs(Math.sin(f * 0.03));
        for (const sc of [A, B]) {
          sc.cam.setPosition(Math.cos(ang) * rad, 3 + (f % 40) * 0.6, Math.sin(ang) * rad);
          sc.cam.setTarget(Math.cos(ang + 1.3) * 25, 0, Math.sin(ang + 1.3) * 25);
          if (f === 70) { const m = sc.meshes.find((x) => x.name === 'm15')!; m.setPosition3D(m.x + 5, m.y, m.z); }   // a mover (dynamic for the hold)
        }
        GpuDrivenMain.shadows = true; R3.gpuDriven = true; R3.gpuDrivenLean = true;
        A.r.drawMeshes(recordingPass(em.args).pass, A.meshes, 1300, 850);
        GpuDrivenMain.shadows = false; R3.gpuDrivenLean = false;
        B.r.drawMeshes(recordingPass(emB.args).pass, B.meshes, 1300, 850);
        if (!A.r._gd?._shOn) continue;
        gpuFrames++;
        const la = lists(A.r), lb = lists(B.r);
        for (let L = 0; L < GD_SH_LAYERS; L++) {
          const got = em.shadowSlots(L); for (const x of slotsOf(la[L])) got.add(x);
          const want = slotsOf(lb[L]);
          const g = [...got].sort((x, y) => x - y), w = [...want].sort((x, y) => x - y);
          if (JSON.stringify(g) !== JSON.stringify(w)) console.log('FRAME', f, 'LAYER', L, 'gpu-only', g.filter((x) => !want.has(x)), 'cpu-only', w.filter((x) => !got.has(x)));
          expect(g, `frame ${f} layer ${L}`).toEqual(w);
          if (w.length) nonEmpty[L]++;
          compared += w.length;
        }
      }
      expect(gpuFrames).toBeGreaterThan(140);
      expect(compared).toBeGreaterThan(2000);
      // every layer was exercised (the far static set needs the 90-frame probation to pass)
      // the static layers re-rendered (and the GPU members were committed) as often as on the CPU path
      expect(A.r._gdShCommit.every((c: number) => c > 0)).toBe(true);
      expect(A.r._shadowCacheStats.staticRenders).toBe(B.r._shadowCacheStats.staticRenders);
      expect(A.r._shadowCacheStats.staticRenders).toBeGreaterThan(5);
      for (let L = 0; L < GD_SH_LAYERS; L++) expect(nonEmpty[L], `layer ${L} never had casters`).toBeGreaterThan(0);
    } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; GpuDrivenMain.shadows = prev.sh; }
  });

  it('lean mode draws the same sequence while the CPU skips the GPU records\' camera tail', async () => {
    const run = async (lean: boolean) => {
      const { r, dev, cam, meshes, Renderer3D } = await scene();
      const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean; rangeCulling: boolean };
      const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, rc: R3.rangeCulling };
      R3.gpuDriven = true; R3.gpuDrivenLean = lean; R3.rangeCulling = false;
      try {
        const em = emulator(r, dev.mem); dev.onEncode.push(em.run);
        const seqs: Draw[][] = [], cpuLists: number[] = [];
        for (let f = 0; f < 40; f++) {
          await Promise.resolve();
          cam.setPosition(Math.cos(f * 0.15) * 50, 3, Math.sin(f * 0.15) * 50); cam.setTarget(0, 0, 0);
          const rp = recordingPass(em.args);
          r.drawMeshes(rp.pass, meshes, 1300, 850);
          await Promise.resolve();
          if (r._gdDrew) { seqs.push(rp.draws); cpuLists.push(r._opaque.length); }
        }
        return { seqs, cpuLists };
      } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; R3.rangeCulling = prev.rc; }
    };
    const full = await run(false), lean = await run(true);
    expect(full.seqs.length).toBeGreaterThan(30);
    expect(lean.seqs.length).toBe(full.seqs.length);
    // the two scenes are built from the same seed: slots / pool offsets agree
    for (let i = 0; i < full.seqs.length; i++) expect(lean.seqs[i]).toEqual(full.seqs[i]);
    const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
    expect(sum(lean.cpuLists)).toBeLessThan(sum(full.cpuLists) * 0.5);   // only forced records + non-records left in the CPU list
  });

  it('the bundle is re-recorded only when the order or a bucket\'s refs change; switch off = the CPU path', async () => {
    const { r, dev, cam, meshes, Renderer3D, box } = await scene();
    const R3 = Renderer3D as unknown as { gpuDriven: boolean };
    const prev = R3.gpuDriven;
    R3.gpuDriven = true;
    try {
      const em = emulator(r, dev.mem); dev.onEncode.push(em.run);
      cam.setPosition(0, 5, 60); cam.setTarget(0, 0, 0);
      const frame = async (list = meshes) => { await Promise.resolve(); const rp = recordingPass(em.args); r.drawMeshes(rp.pass, list, 1300, 850); return rp; };
      for (let i = 0; i < 4; i++) await frame();
      expect(r._gdDrew).toBe(true);
      const s0 = { ...r.getGpuDrivenStats() };
      for (let i = 0; i < 5; i++) { cam.setPosition(i * 3, 5, 60); await frame(); }
      let s = r.getGpuDrivenStats();
      expect(s.bundleRecords).toBe(s0.bundleRecords);   // camera moves: no re-record
      expect(s.rebuilds).toBe(s0.rebuilds);
      r.meshBindGroup = { replaced: true };              // a bind group rebuilt (e.g. the instance buffer grew)
      await frame();
      s = r.getGpuDrivenStats();
      expect(s.bundleRecords).toBe(s0.bundleRecords + 1);
      expect(s.rebuilds).toBe(s0.rebuilds);
      const extra = box(0, 0, 1, 1, 'late');             // a new mesh: placed by the O(new) insertion (no full rebuild)
      let rp = await frame([...meshes, extra]);
      s = r.getGpuDrivenStats();
      expect(s.inserts).toBeGreaterThan(s0.inserts);
      expect(s.rebuilds).toBe(s0.rebuilds);
      const lateSlot = r._meshInstanceSlots.get(extra.id);
      expect(rp.draws.some((d: Draw) => d.slot === lateSlot)).toBe(true);
      // a new instanced group: a deferrable (order-only) full rebuild; the CPU draws it after the bundle meanwhile
      const { ArrayGroup3D } = await import('../../scene-graph/shapes/array-group-3d');
      const src = box(0, 0, 1, 1, 'late-src');
      const grp = new ArrayGroup3D(isvc, src.id, { mode: 'explicit', offsets: [[0, 0, 0], [2, 0, 0], [4, 0, 0]] });
      r.setArrayGroups([...r._arrayGroups, grp]);
      const list2 = [...meshes, extra, src];
      let sawCpu = false, placed = false;
      for (let i = 0; i < 40 && !placed; i++) {
        rp = await frame(list2);
        const first = r._arrayGroupFirstSlot.get(grp.id);
        if (first === undefined) continue;
        expect(rp.draws.some((d: Draw) => d.slot === first)).toBe(true);   // drawn every frame, by the CPU or the bundle
        if (r.getFrameStats3D().gpuOrphanDraws > 0) sawCpu = true;
        placed = r._gd.drawsObject(grp);
      }
      expect(sawCpu).toBe(true);
      expect(placed).toBe(true);
      s = r.getGpuDrivenStats();
      expect(s.rebuilds).toBeGreaterThan(s0.rebuilds);
      R3.gpuDriven = false;
      const off = await frame(list2);
      expect(off.bundles()).toBe(0);
      expect(off.draws.length).toBeGreaterThan(0);
      expect(r.getFrameStats3D().gpuDriven).toBe(0);
    } finally { R3.gpuDriven = prev; }
  });
});

// ── Sub-bundle omission (the D3D12 zero-draw cost) + the GPU culling mode's warm switch ─────────────────────────
describe('P15 sub-bundles: omitted draws are zero draws, the replay set = the full one', () => {
  it('gdSkippable never skips a record the cull draws (fuzzed records, control words, frames)', () => {
    const R = rng(41);
    const cull = new FrustumCuller();
    const T = recTable(1);
    let skipped = 0, total = 0;
    const bits = [GD_CTL_ENABLED, GD_CTL_FORCED, GD_CTL_FORCED_VIS, GD_CTL_VISITED, GD_CTL_CPU_LOD, GD_CTL_CPU_N1, GD_CTL_CPU_N2];
    for (let t = 0; t < 4000; t++) {
      const eye = [R() * 60 - 30, R() * 10, R() * 60 - 30];
      const v = mat4.lookAt(mat4.create(), eye as [number, number, number], [R() * 40 - 20, 0, R() * 40 - 20], [0, 1, 0]);
      cull.setFromViewProjection(mat4.multiply(mat4.create(), mat4.perspectiveZO(mat4.create(), 0.9, 1.5, 0.1, 300), v));
      const group = R() < 0.3, role = R() < 0.5 ? 0 : 1 + Math.floor(R() * 4);
      const cx = R() * 80 - 40, cz = R() * 80 - 40;
      const box = R() < 0.1 ? null : { minX: cx, minY: 0, minZ: cz, maxX: cx + 1 + R() * 5, maxY: 1 + R() * 5, maxZ: cz + 1 + R() * 5 };
      packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: R() < 0.5 ? 10 + R() * 50 : 0, drawDistanceBias: R(), indexCount: R() < 0.05 ? 0 : 36, firstIndex: 0, baseVertex: 0, firstInstance: 0,
        count: group ? 1 + Math.floor(R() * 8) : 1, flags: (group ? GD_FLAG_GROUP : 0) | (R() < 0.3 ? GD_FLAG_FOG_OTHER : 0),
        twinRole: group ? (role > 2 ? 0 : role) : role, twinDist: R() < 0.8 ? 10 + R() * 40 : 0, twinDist2: R() < 0.5 ? 30 + R() * 40 : 0,
        twinFlags: (R() < 0.3 ? GD_TWIN_OFF_NEAR : 0) | (R() < 0.2 ? GD_TWIN_INSTANCED : 0), origin: group && R() < 0.7 ? [cx, 0, cz, cx + 3, 0, cz + 3] : null });
      let ctl = 0; for (const b of bits) if (R() < 0.5) ctl |= b;
      if (R() < 0.6) ctl |= GD_CTL_ENABLED;
      const F: GdFrameParams = { planes: R() < 0.8 ? cull.writePlanes(new Float32Array(24)) : null, cam: eye, lodOn: R() < 0.8, lodOrtho: false, orthoD2: 0, lodScale: 0.5 + R(), lodBias: R(),
        fogEye: eye, fogCull2: R() < 0.5 ? 900 : Infinity, fogCullOther: R() < 0.5, fogCullAttach: false, hcOn: R() < 0.7, groupTwins: R() < 0.7, cpuState: R() < 0.8 };
      const st = Math.floor(R() * 64);
      total++;
      if (!gdSkippable(T.f, T.u, ctl, 0, F)) continue;
      skipped++;
      expect(gdCullRecord(T.f, T.u, ctl, st, 0, F).instanceCount, 'case ' + t).toBe(0);
    }
    expect(skipped).toBeGreaterThan(total * 0.3);   // the rule is not trivial
  });

  it('gdBoxOutside: every box inside an omitted union box is culled by the GPU test, at city coordinates too', () => {
    const R = rng(43);
    const cull = new FrustumCuller();
    const T = recTable(1);
    let outside = 0;
    for (let t = 0; t < 600; t++) {
      const off = t % 2 ? 0 : 2000;   // far from the origin: f32 rounding of big coordinates
      const eye = [off + R() * 60 - 30, R() * 20, off + R() * 60 - 30];
      const v = mat4.lookAt(mat4.create(), eye as [number, number, number], [off + R() * 60 - 30, 0, off + R() * 60 - 30], [0, 1, 0]);
      cull.setFromViewProjection(mat4.multiply(mat4.create(), mat4.perspectiveZO(mat4.create(), 0.5 + R(), 1.5, 0.05, 500), v));
      const planes = cull.writePlanes(new Float32Array(24));
      const ux = off + R() * 120 - 60, uz = off + R() * 120 - 60, U = [ux, 0, uz, ux + 1 + R() * 30, 1 + R() * 20, uz + 1 + R() * 30];
      if (!gdBoxOutside(planes, U)) continue;
      outside++;
      for (let k = 0; k < 40; k++) {
        const a = U[0] + R() * (U[3] - U[0]), b = U[2] + R() * (U[5] - U[2]);
        const box = { minX: a, minY: U[1], minZ: b, maxX: a + R() * (U[3] - a), maxY: U[1] + R() * (U[4] - U[1]), maxZ: b + R() * (U[5] - b) };
        if (k === 0) Object.assign(box, { minX: U[0], minY: U[1], minZ: U[2], maxX: U[3], maxY: U[4], maxZ: U[5] });
        packGdRecord(T.f, T.u, T.i, 0, { box, drawDistance: 0, drawDistanceBias: 0, indexCount: 3, firstIndex: 0, baseVertex: 0, firstInstance: 0, count: 1, flags: 0 });
        expect(gdFrustumTest(planes, T.f, 0)).toBe(false);
        expect(cull.testBox(box)).toBe(false);
      }
    }
    expect(outside).toBeGreaterThan(100);
    expect(gdBoxOutside([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], [0, NaN, 0, 1, 1, 1])).toBe(false);   // NaN: never omitted
  });

  it('gdSegments covers the order in key runs, merging runs shorter than the minimum', () => {
    const R = rng(47);
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(R() * 300), keys = Array.from({ length: n }, () => Math.floor(R() * 4) + (R() < 0.6 ? 10 : 0));
      for (let p = 1; p < n; p++) if (R() < 0.7) keys[p] = keys[p - 1];   // runs
      const min = 1 + Math.floor(R() * 10);
      const segs = gdSegments(n, (p) => keys[p], min);
      expect(segs[0].start).toBe(0); expect(segs[segs.length - 1].end).toBe(n);
      for (let i = 0; i < segs.length; i++) {
        expect(segs[i].end).toBeGreaterThan(segs[i].start);
        if (i > 0) { expect(segs[i].start).toBe(segs[i - 1].end); expect(keys[segs[i].start]).not.toBe(keys[segs[i].start - 1]); }   // cut only at a key change
        if (segs.length > 1 && min > 1 && i < segs.length - 1) expect(segs[i].end - segs[i].start).toBeGreaterThanOrEqual(min);
      }
    }
  });

  for (const lean of [false, true]) it('end to end' + (lean ? ' (lean)' : '') + ': the replayed sub-bundles draw the full replay' + (lean ? '' : ' = the CPU sequence') + '; omitted ones hold only zero draws', async () => {
    const { r, dev, cam, meshes, Renderer3D } = await scene();
    const { GpuDrivenMain } = await import('./gpu-scene');
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean; rangeCulling: boolean; rankCellM: number };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, rc: R3.rangeCulling, cell: R3.rankCellM, sub: GpuDrivenMain.subBundles, min: GpuDrivenMain.SUB_MIN_RECORDS };
    R3.gpuDriven = true; R3.gpuDrivenLean = lean; R3.rangeCulling = false; R3.rankCellM = 20; GpuDrivenMain.subBundles = true; GpuDrivenMain.SUB_MIN_RECORDS = 2;
    try {
      r.setGpuCullingMode('on', false);
      const em = emulator(r, dev.mem); dev.onEncode.push(em.run);
      let gpuFrames = 0, omittedSegs = 0, omittedDraws = 0, keptSegs = 0;
      const total0 = r._gd ? r._gd.stats.segOmitTotal : 0;
      for (let f = 0; f < 80; f++) {
        await Promise.resolve();
        const ang = f * 0.08, rad = 5 + 60 * Math.abs(Math.sin(f * 0.05));
        cam.setPosition(Math.cos(ang) * rad, 2 + (f % 20) * 0.6, Math.sin(ang) * rad);
        cam.setTarget(Math.cos(ang + 1.1) * 25, 0, Math.sin(ang + 1.1) * 25);
        const rp = recordingPass(em.args);
        r.drawMeshes(rp.pass, meshes, 1300, 850);
        if (!r._gdDrew) continue;
        gpuFrames++;
        const gd = r._gd;
        expect(gd._segOn).toBe(true);
        expect(rp.bundles()).toBe(1);
        if (!lean) expect(rp.draws).toEqual(cpuSequence(r));   // the replayed set draws exactly the CPU path's sequence (full CPU lists)
        // every left-out sub-bundle holds only zero draws (so the replayed set draws what the full bundle set draws)
        const a = em.args()!;
        for (let si = 0; si < gd._segs.length; si++) {
          if (gd._segKeep[si]) { keptSegs++; continue; }
          omittedSegs++;
          for (const c of gd._segBundles[si].cmds) { const o = c.offset / 4; expect(a[o] > 0 && a[o + 1] > 0, 'frame ' + f + ' segment ' + si).toBe(false); omittedDraws++; }
        }
      }
      expect(gpuFrames).toBeGreaterThan(70);
      expect(r._gd._segs.length).toBeGreaterThan(3);
      expect(omittedSegs).toBeGreaterThan(20);
      expect(keptSegs).toBeGreaterThan(20);
      expect(r._gd.stats.segOmitTotal - total0).toBe(omittedDraws);   // the counter = the zero draws left out
    } finally {
      R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; R3.rangeCulling = prev.rc; R3.rankCellM = prev.cell; GpuDrivenMain.subBundles = prev.sub; GpuDrivenMain.SUB_MIN_RECORDS = prev.min;
      r.setGpuCullingMode('auto', false);
    }
  });

  it('the spatial rank keeps a cell contiguous inside each pipeline class', async () => {
    const { r, cam, meshes, Renderer3D } = await scene();
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; rankCellM: number };
    const prev = { g: R3.gpuDriven, cell: R3.rankCellM };
    R3.gpuDriven = false; R3.rankCellM = 30;
    try {
      cam.setPosition(0, 40, 90); cam.setTarget(0, 0, 0);
      r.drawMeshes(recordingPass(() => null).pass, meshes, 1300, 850);
      const ord = r._drawOrder.orderedMeshes() as { _r3RankCell: number; material: { hasTexture: boolean; hasNormalMap: boolean; doubleSided: boolean } }[];
      const seen = new Set<string>();
      let prevKey = '';
      for (const m of ord) {
        const k = (m.material.hasTexture || m.material.hasNormalMap ? 't' : 'u') + (m.material.doubleSided ? 'd' : 's') + ':' + m._r3RankCell;
        if (k !== prevKey) { expect(seen.has(k), 'a cell run split in two').toBe(false); seen.add(k); prevKey = k; }
      }
      expect(new Set(ord.map((m) => m._r3RankCell)).size).toBeGreaterThan(4);
    } finally { R3.gpuDriven = prev.g; R3.rankCellM = prev.cell; }
  });

  it('the rank keys plain / full shaders: no alternation, plain records keep the plain pipeline, GPU = CPU sequence', async () => {
    const { r, dev, cam, meshes, Renderer3D } = await scene();
    const { GpuDrivenMain } = await import('./gpu-scene');
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean; rangeCulling: boolean; rankPatterned: boolean };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, rc: R3.rangeCulling, rp: R3.rankPatterned, mp: GpuDrivenMain.mergePatterned };
    R3.gpuDriven = true; R3.gpuDrivenLean = false; R3.rangeCulling = false;
    expect(GpuDrivenMain.mergePatterned).toBe(false);   // the default: the merged full-shader bucket cost main-pass GPU time
    expect(R3.rankPatterned).toBe(true);
    try {
      // every third plain box becomes patterned (the full shader), interleaved with plain ones in the geometry-key order
      meshes.forEach((m, i) => { if (/^m\d+$/.test(m.name) && i % 3 === 1) { m.material.metalShade = true; m.materialDirty = true; } });
      const em = emulator(r, dev.mem);
      dev.onEncode.push(em.run);
      cam.setPosition(0, 40, 90); cam.setTarget(0, 0, 0);
      const runsOf = (ord: { material: Record<string, unknown> }[]) => { let n = 0, last = ''; for (const m of ord) { const k = (m.material.hasTexture || m.material.hasNormalMap ? 't' : 'u') + (m.material.doubleSided ? 'd' : 's') + (r._usesPatterns(m) ? 'p' : ''); if (k !== last) { n++; last = k; } } return n; };
      let compared = 0;
      for (let f = 0; f < 12; f++) {
        await Promise.resolve();
        const rp = recordingPass(em.args);
        r.drawMeshes(rp.pass, meshes, 1300, 850);
        if (!r._gdDrew) continue;
        expect(rp.draws).toEqual(cpuSequence(r));
        compared++;
      }
      expect(compared).toBeGreaterThan(5);
      const ord = r._drawOrder.orderedMeshes() as { material: Record<string, unknown> }[];
      const classes = new Set(ord.map((m) => (m.material.hasTexture || m.material.hasNormalMap ? 't' : 'u') + (m.material.doubleSided ? 'd' : 's') + (r._usesPatterns(m) ? 'p' : '')));
      expect(runsOf(ord)).toBe(classes.size);   // each pipeline class (plain / full included) is one run of the rank
      const gd = r._gd;
      for (let p = 0; p < gd._nOrder; p++) {   // a record's state code carries the full-shader bit only for a patterned mesh
        const rr = gd._order[p], m = gd._isGroup[rr] ? gd._srcRef[rr] : gd._obj[rr];
        expect(!!(gd._code[rr] & GD_CODE_PATTERNED), m.name).toBe(r._usesPatterns(m));
      }
      const before = gd._buckets.length;
      R3.rankPatterned = false;   // the old rank interleaves plain and patterned records: more buckets
      (Renderer3D as unknown as { rankVariants: boolean }).rankVariants = false;   // (step 8: the variant id would separate them too)
      for (let f = 0; f < 40; f++) { await Promise.resolve(); r.drawMeshes(recordingPass(em.args).pass, meshes, 1300, 850); }
      expect(runsOf(r._drawOrder.orderedMeshes())).toBeGreaterThan(classes.size);
      expect(gd._buckets.length).toBeGreaterThan(before);
    } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; R3.rangeCulling = prev.rc; R3.rankPatterned = prev.rp; GpuDrivenMain.mergePatterned = prev.mp; (Renderer3D as unknown as { rankVariants: boolean }).rankVariants = true; }
  });

  it('step 8 shader variants: the key is the slot flags, one variant per rank run, state codes carry the id, the switch keeps the order', async () => {
    const { r, dev, cam, meshes, Renderer3D } = await scene();
    const { variantKeyOfMaterial } = await import('./shader-variants');
    const { encodeMaterialFlags } = await import('./material-3d');
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean; rangeCulling: boolean; shaderVariants: boolean };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, rc: R3.rangeCulling, sv: R3.shaderVariants };
    R3.gpuDriven = true; R3.gpuDrivenLean = false; R3.rangeCulling = false; R3.shaderVariants = true;
    try {
      // three families interleaved in the geometry-key order: plain, painted metal, procedural ground
      meshes.forEach((m, i) => { if (/^m\d+$/.test(m.name)) { if (i % 3 === 1) m.material.metalShade = true; else if (i % 3 === 2) m.material.groundShade = true; m.materialDirty = true; } });
      const em = emulator(r, dev.mem);
      dev.onEncode.push(em.run);
      cam.setPosition(0, 40, 90); cam.setTarget(0, 0, 0);
      let compared = 0;
      for (let f = 0; f < 12; f++) {
        await Promise.resolve();
        const rp = recordingPass(em.args);
        r.drawMeshes(rp.pass, meshes, 1300, 850);
        if (!r._gdDrew) continue;
        expect(rp.draws).toEqual(cpuSequence(r));
        compared++;
      }
      expect(compared).toBeGreaterThan(5);
      // the cached key = the flags written to the slot = the material's flags (single-material meshes)
      for (const m of meshes) if (m.submeshes.length === 0 && m._r3Slot >= 0) expect(m._r3VF, m.name).toBe(variantKeyOfMaterial(m.material));
      expect(meshes.some((m) => m._r3VF === encodeMaterialFlags(m.material) && m.material.groundShade)).toBe(true);
      // the rank: each variant key forms one run inside its pipeline class
      const ord = r._drawOrder.orderedMeshes() as typeof meshes;
      const keyOf = (m: (typeof meshes)[number]): string => (m.material.hasTexture || m.material.hasNormalMap ? 't' : 'u') + (m.material.doubleSided ? 'd' : 's') + (r._usesPatterns(m) ? 'p' : '') + ':' + m._r3VF;
      let runs = 0, last = '';
      for (const m of ord) { const k = keyOf(m); if (k !== last) { runs++; last = k; } }
      expect(runs).toBe(new Set(ord.map(keyOf)).size);
      // GPU state codes: bits 5+ = the variant id of the record's key
      const gd = r._gd;
      for (let p = 0; p < gd._nOrder; p++) {
        const rr = gd._order[p], m = gd._isGroup[rr] ? gd._srcRef[rr] : gd._obj[rr];
        const id = gd._code[rr] >> 5;
        expect(id > 0, m.name).toBe(variantKeyOfMaterial(m.material) >= 0);
        if (id > 0) expect(r._svIds.keyOf(id)).toBe(variantKeyOfMaterial(m.material));
      }
      // switching the variants off keeps the draw order (the A/B never moves coplanar draws) and drops the ids
      const order0 = ord.map((m) => m.id).join(',');
      r.setShaderVariants({ enabled: false });
      for (let f = 0; f < 6; f++) { await Promise.resolve(); r.drawMeshes(recordingPass(em.args).pass, meshes, 1300, 850); }
      expect((r._drawOrder.orderedMeshes() as typeof meshes).map((m) => m.id).join(',')).toBe(order0);
      for (let p = 0; p < gd._nOrder; p++) expect(gd._code[gd._order[p]] >> 5).toBe(0);
      const st = r.setShaderVariants({});
      expect(st.enabled).toBe(false);
      expect(st.keys).toBeGreaterThanOrEqual(3);
    } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; R3.rangeCulling = prev.rc; R3.shaderVariants = prev.sv; }
  });
});

describe('shader split phase 1 (mesh-fs-pipelines.ts)', () => {
  it('slot key = material key, state codes carry split ids, GPU = CPU sequence, covered meshes never touch the uber pipelines', async () => {
    const { r, dev, cam, meshes, Renderer3D } = await scene();
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean; rangeCulling: boolean; splitKeyOfMesh: (m: unknown) => number; SPLIT_ID_FLAG: number };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, rc: R3.rangeCulling };
    R3.gpuDriven = true; R3.gpuDrivenLean = false; R3.rangeCulling = false;
    try {
      // covered: plain, Cel + rim, painted metal; NOT covered (today's pipelines): procedural ground, stripes
      meshes.forEach((m, i) => {
        if (!/^m\d+$/.test(m.name)) return;
        if (i % 5 === 1) m.material.metalShade = true;
        else if (i % 5 === 2) { m.material.renderStyle = 'cel'; m.material.rimEnabled = true; }
        else if (i % 5 === 3) m.material.groundShade = true;
        else if (i % 5 === 4) m.material.patternMode = 'stripes';
        m.materialDirty = true;
      });
      expect(r.setShaderSplit({ enabled: true }).active).toBe(true);
      const em = emulator(r, dev.mem);
      dev.onEncode.push(em.run);
      cam.setPosition(0, 40, 90); cam.setTarget(0, 0, 0);
      let compared = 0;
      for (let f = 0; f < 12; f++) {
        await Promise.resolve();
        const rp = recordingPass(em.args);
        r.drawMeshes(rp.pass, meshes, 1300, 850);
        if (!r._gdDrew) continue;
        expect(rp.draws).toEqual(cpuSequence(r));
        compared++;
      }
      expect(compared).toBeGreaterThan(5);
      // the slot read-back key = the material key; covered iff no heavy feature
      let covered = 0;
      for (const m of meshes) if (m.submeshes.length === 0 && m._r3Slot >= 0) {
        expect(m._r3FK, m.name).toBe(R3.splitKeyOfMesh(m));
        expect(m._r3FK >= 0, m.name).toBe(!m.material.groundShade && (m.material.patternMode ?? 'none') === 'none');
        if (m._r3FK >= 0) covered++;
      }
      expect(covered).toBeGreaterThan(20);
      // GPU state codes: covered records carry SPLIT_ID_FLAG | id, the rest no split id
      const gd = r._gd;
      for (let p = 0; p < gd._nOrder; p++) {
        const rr = gd._order[p], m = gd._isGroup[rr] ? gd._srcRef[rr] : gd._obj[rr];
        const id = (gd._code[rr] >> 5) & 0x7fff;
        expect((id & R3.SPLIT_ID_FLAG) !== 0, m.name).toBe(R3.splitKeyOfMesh(m) >= 0);
      }
      // the generated pipelines exist; the PLAIN uber pipelines (only covered meshes would draw with them) never compiled
      // (a draw's get() compiles synchronously outside a live frame; the document pre-warm may still QUEUE one for the
      // uncovered vertex-coloured mesh, as today)
      const st = r.setShaderSplit({});
      expect(st.pipelines).toBeGreaterThanOrEqual(3);
      expect(st.list.every((e: { key: string }) => e.key.startsWith('U|') || e.key.startsWith('T|'))).toBe(true);
      for (const n of ['opaqueUntexturedPlainPipeline', 'opaqueUntexturedNoCullPlainPipeline', 'transparentUntexturedPipeline']) {
        expect(r.pipeline.handleOf(n).ready, n).toBe(false);
      }
      // switching the split off keeps the draw order and drops the split ids
      const order0 = (r._drawOrder.orderedMeshes() as typeof meshes).map((m) => m.id).join(',');
      r.setShaderSplit({ mode: 'auto' });
      for (let f = 0; f < 6; f++) { await Promise.resolve(); r.drawMeshes(recordingPass(em.args).pass, meshes, 1300, 850); }
      expect((r._drawOrder.orderedMeshes() as typeof meshes).map((m) => m.id).join(',')).toBe(order0);
      for (let p = 0; p < gd._nOrder; p++) expect(((gd._code[gd._order[p]] >> 5) & R3.SPLIT_ID_FLAG) !== 0).toBe(false);
    } finally { r.setShaderSplit({ mode: 'auto' }); R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; R3.rangeCulling = prev.rc; }
  });
});

describe('P15 GPU culling mode', () => {
  it('auto: switching paths (the GPU scene warm on CPU frames) draws the CPU sequence every frame, with no rebuild', async () => {
    const { r, dev, cam, meshes, Renderer3D } = await scene();
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean; rangeCulling: boolean; CULL_AUTO_MIN_RECORDS: number };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, rc: R3.rangeCulling, min: R3.CULL_AUTO_MIN_RECORDS };
    R3.gpuDriven = true; R3.gpuDrivenLean = false; R3.rangeCulling = false; R3.CULL_AUTO_MIN_RECORDS = 1;   // full CPU lists: the reference
    try {
      r.setGpuCullingMode('auto', false);
      let want: 'gpu' | 'cpu' = 'gpu';
      r.cullAuto.decide = () => want;   // the controller's choice, scripted
      const em = emulator(r, dev.mem); dev.onEncode.push(em.run);
      let warm = 0, gpu = 0, rebuilds = -1, bundles = -1, flips = 0;
      for (let f = 0; f < 70; f++) {
        await Promise.resolve();
        const next = Math.floor(f / 5) % 2 === 0 ? 'gpu' : 'cpu';
        if (f > 10 && next !== want) flips++;
        if (f > 10) want = next;
        const ang = f * 0.07;
        cam.setPosition(Math.cos(ang) * 50, 4, Math.sin(ang) * 50); cam.setTarget(0, 0, 0);
        const rp = recordingPass(em.args);
        r.drawMeshes(rp.pass, meshes, 1300, 850);
        if (f < 10) continue;   // warm-up: the cull pipeline resolves, the first records are built
        if (f === 10) { expect(r._gdDrew).toBe(true); rebuilds = r.getGpuDrivenStats().rebuilds; bundles = r.getGpuDrivenStats().bundleRecords; }
        const st = r.getGpuCullingMode();
        expect(st.active).toBe(want);
        if (want === 'cpu') { warm++; expect(r._gdDrew).toBe(false); expect(st.warm).toBe(true); expect(rp.bundles()).toBe(0); }
        else { gpu++; expect(r._gdDrew).toBe(true); }
        expect(rp.draws).toEqual(cpuSequence(r));   // the same picture on both paths, the switching frames included
      }
      expect(flips).toBeGreaterThan(8);
      expect(warm).toBeGreaterThan(20); expect(gpu).toBeGreaterThan(20);
      const s = r.getGpuDrivenStats();
      expect(s.rebuilds).toBe(rebuilds);          // a switch never rebuilds the records / order...
      expect(s.bundleRecords).toBe(bundles);      // ...nor re-records the bundles
    } finally {
      R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; R3.rangeCulling = prev.rc; R3.CULL_AUTO_MIN_RECORDS = prev.min;
      delete (r.cullAuto as { decide?: unknown }).decide;
      r.setGpuCullingMode('auto', false);
    }
  });

  it('the mode is a per-machine preference: a stored mode loads (off = the CPU path), a set mode is stored', async () => {
    const { r, Renderer3D } = await scene();
    const { GPU_CULL_PREF_KEY } = await import('./gpu-cull-auto');
    const g = globalThis as { localStorage?: unknown };
    const prevLS = g.localStorage, R3 = Renderer3D as unknown as { gpuDriven: boolean; _cullModeStatic: unknown };
    const prev = { g: R3.gpuDriven, m: R3._cullModeStatic };
    const store = new Map<string, string>([[GPU_CULL_PREF_KEY, 'off']]);
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    try {
      R3._cullModeStatic = null; R3.gpuDriven = true;
      const st = r.getGpuCullingMode();
      expect(st.mode).toBe('off'); expect(st.active).toBe('cpu'); expect(st.reason).toBe('mode-off');
      expect(R3.gpuDriven).toBe(false);
      r.setGpuCullingMode('on');
      expect(store.get(GPU_CULL_PREF_KEY)).toBe('on'); expect(R3.gpuDriven).toBe(true);
      r.setGpuCullingMode('auto', false);   // persist = false: this session only
      expect(store.get(GPU_CULL_PREF_KEY)).toBe('on');
      expect(r.setGpuCullingMode('bogus' as never, false).mode).toBe('auto');
    } finally { g.localStorage = prevLS; R3.gpuDriven = prev.g; R3._cullModeStatic = prev.m; }
  });
});

describe('P17 leak fix: a removed mesh does not keep its GPU-driven record (and itself) alive', () => {
  // `n` removed (a number, or 'share' = just past 1 / DEAD_SHARE_DEN of the records); shareDen 0 = the share rule off
  const run = async (deadRebuild: number, n: number | 'share' = 12, shareDen = 0) => {
    const { r, dev, cam, meshes, Renderer3D } = await scene();
    const { GpuDrivenMain } = await import('./gpu-scene');
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean };
    const G = GpuDrivenMain as unknown as { DEAD_REBUILD: number; DEAD_SHARE_DEN: number };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, d: G.DEAD_REBUILD, s: G.DEAD_SHARE_DEN };
    R3.gpuDriven = true; R3.gpuDrivenLean = false; G.DEAD_REBUILD = deadRebuild; G.DEAD_SHARE_DEN = shareDen;
    try {
      const em = emulator(r, dev.mem); dev.onEncode.push(em.run);
      cam.setPosition(0, 40, 90); cam.setTarget(0, 0, 0);
      let list = meshes.slice();
      const frame = async () => { await Promise.resolve(); const rp = recordingPass(em.args); r.drawMeshes(rp.pass, list, 1300, 850); };
      for (let f = 0; f < 12; f++) await frame();
      const k = n === 'share' ? Math.ceil(r._gd.recordCount / shareDen) + 1 : n;
      const gone = meshes.filter((m) => /^m\d+$/.test(m.name) && r._gd.owns(m)).slice(0, k);
      expect(gone.length).toBe(k);
      // a streamed tile leaving: detached from the roster, its renderer cleanup deferred (P16)
      list = list.filter((m) => !gone.includes(m));
      r.evictMeshCachesDeferred(gone);
      for (let f = 0; f < 40; f++) await frame();   // > FULL_REBUILD_MIN_FRAMES, no other structure change
      return { stillOwned: gone.filter((m) => r._gd.owns(m)).length, inObj: gone.filter((m) => r._gd._obj.includes(m)).length };
    } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; G.DEAD_REBUILD = prev.d; G.DEAD_SHARE_DEN = prev.s; }
  };
  it('past DEAD_REBUILD removals a deferrable rebuild frees the dead records', async () => {
    expect(await run(4)).toEqual({ stillOwned: 0, inObj: 0 });
  });
  it('(control) without the trigger the dead records, and the meshes they reference, stay', async () => {
    const r = await run(1 << 30);
    expect(r.inObj).toBe(12);
  });
  it('stats fix: under DEAD_REBUILD, dead records past 1 / DEAD_SHARE_DEN of all records rebuild too', async () => {
    expect(await run(1 << 30, 'share', 4)).toEqual({ stillOwned: 0, inObj: 0 });
  });
  it('(control) a small share of dead records still waits (no rebuild per streamed-out tile)', async () => {
    expect((await run(1 << 30, 3, 4)).inObj).toBe(3);
  });
});

// ── §P15 stats fix (2026-10-03): a frame with no static meshes must not keep the last static frame's numbers ─────────
describe('P15 stats fix: an empty static frame zeroes the frame stats and drops the GPU-driven records', () => {
  it('a city-like scene, then no regular meshes: stats read 0 (not the city), no record keeps a mesh, no stale read-back', async () => {
    const { r, dev, cam, meshes, Renderer3D } = await scene();
    const { splitPassStats } = await import('./pass-stats');
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean };
    R3.gpuDriven = true; R3.gpuDrivenLean = false;
    try {
      const em = emulator(r, dev.mem); dev.onEncode.push(em.run);
      cam.setPosition(0, 40, 90); cam.setTarget(0, 0, 0);
      const frame = async (list: unknown[]) => { await Promise.resolve(); const rp = recordingPass(em.args); r.drawMeshes(rp.pass, list, 1300, 850); return rp; };
      for (let f = 0; f < 12; f++) await frame(meshes);
      const before = r.getFrameStats3D();
      expect(before.drawCalls).toBeGreaterThan(0); expect(before.meshes).toBe(meshes.length);
      expect(r._gd.recordCount).toBeGreaterThan(0);
      // the scene cleared (only characters left, or nothing): the caller passes no regular meshes
      for (let f = 0; f < 3; f++) await frame([]);
      const fs = r.getFrameStats3D();
      expect({ drawCalls: fs.drawCalls, trisDrawn: fs.trisDrawn, meshes: fs.meshes, passMainDraws: fs.passMainDraws, passMainTris: fs.passMainTris,
        gpuMainDraws: fs.gpuMainDraws, gpuMainTris: fs.gpuMainTris, gpuRecords: fs.gpuRecords, gpuStatsAge: fs.gpuStatsAge, trisVisible: fs.trisVisible })
        .toEqual({ drawCalls: 0, trisDrawn: 0, meshes: 0, passMainDraws: 0, passMainTris: 0, gpuMainDraws: 0, gpuMainTris: 0, gpuRecords: 0, gpuStatsAge: -1, trisVisible: 0 });
      const split = splitPassStats(fs);
      expect([split.tris.total, split.draws.total]).toEqual([0, 0]);
      // the GPU scene forgot every record: no departed mesh is held, and its read-back counters are gone
      expect(r._gd.recordCount).toBe(0);
      expect(meshes.filter((m) => r._gd.owns(m) || r._gd._obj.includes(m)).length).toBe(0);
      const rs = r._gd.readStats();
      expect([rs.draws, rs.tris, rs.age]).toEqual([0, 0, -1]);
      // and a scene coming back draws from fresh records (the same picture as the CPU path)
      for (let f = 0; f < 12; f++) await frame(meshes);
      const rp = await frame(meshes);
      expect(r._gdDrew).toBe(true);
      expect(rp.draws).toEqual(cpuSequence(r));
      expect(r.getFrameStats3D().meshes).toBe(meshes.length);
    } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; }
  });

  it('resetGpuScene (document load): a read-back still in flight from before the reset is ignored', async () => {
    const { r, dev, cam, meshes, Renderer3D } = await scene({ maps: true });   // read-backs resolve on a microtask
    const R3 = Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean };
    R3.gpuDriven = true; R3.gpuDrivenLean = false;
    try {
      const em = emulator(r, dev.mem); dev.onEncode.push(em.run);
      // the emulator leaves the counters alone: stand in for the cull's atomics (what the GPU would count)
      dev.onEncode.push(() => { const s = new Uint32Array(dev.mem.get(r._gd._statsBuf)!.buffer); s[GdStat.draws] = 123; s[GdStat.tris] = 4567; });
      cam.setPosition(0, 40, 90); cam.setTarget(0, 0, 0);
      const flush = async () => { for (let k = 0; k < 4; k++) await Promise.resolve(); };
      for (let f = 0; f < 12; f++) { await flush(); r.drawMeshes(recordingPass(em.args).pass, meshes, 1300, 850); }
      await flush();
      expect(r._gd.readStats().draws).toBeGreaterThan(0);   // the read-back works (the test is not vacuous)
      r.drawMeshes(recordingPass(em.args).pass, meshes, 1300, 850);   // its read-back is now in flight...
      r.resetGpuScene();                                              // ...when the document is replaced
      await flush();
      const rs = r._gd.readStats();
      expect([rs.draws, rs.tris, rs.age, rs.records]).toEqual([0, 0, -1, 0]);
    } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; }
  });
});

// ── compacted dynamic shadow layers (the zero-draw cost of the GPU shadow passes) ──────────────────────────────────
describe('P15 compacted dynamic shadow layers: same casters, a CPU bound of the draw count', () => {
  const dynBits = (mask: number) => ((mask >> GdShLayer.farDyn) & 1) | (((mask >> GdShLayer.c0Dyn) & 1) << 1) | (((mask >> GdShLayer.c1Dyn) & 1) << 2);
  const boxPl = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => [1, 0, 0, -x0, -1, 0, 0, x1, 0, 1, 0, -y0, 0, -1, 0, y1, 0, 0, 1, -z0, 0, 0, -1, z1];

  it('constants match the shader; compact sizes are powers of two from the minimum, >= n, within the capacity', () => {
    const c = (name: string) => +(new RegExp(`const ${name}: u32 = (\\d+)u;`).exec(GPU_CULL_WGSL)?.[1] ?? NaN);
    expect(c('SH_COMPACT')).toBe(GD_SH_COMPACT); expect(c('CTL_VB_OV')).toBe(GD_CTL_VB_OV); expect(c('SH_COMPACT_STAT')).toBe(GdStat.shCompact);
    expect(GdStat.shCompact + 3).toBeLessThanOrEqual(GD_STAT_WORDS); expect(GdStat.shCompact).toBeGreaterThanOrEqual(GdStat.shJoinTris + 3);
    expect([...GD_SH_COMPACT_LAYERS]).toEqual([GdShLayer.farDyn, GdShLayer.c0Dyn, GdShLayer.c1Dyn]);
    expect(gdCompactSize(0, 1000)).toBe(0);
    expect(gdCompactSize(1, 1000)).toBe(GD_SH_COMPACT_MIN);
    for (const n of [1, 31, 32, 33, 200, 511, 512, 513, 999, 1000]) {
      const k = gdCompactSize(n, 1000);
      expect(k).toBeGreaterThanOrEqual(n); expect(k).toBeLessThanOrEqual(1000);
      if (k < 1000) expect(Math.log2(k) % 1).toBe(0);
    }
  });

  it('the bound: static committed casters are out, joiners / movers / wind / unknown membership in, misses out', () => {
    const T = recTable(1);
    packGdRecord(T.f, T.u, T.i, 0, { box: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 4, maxZ: 2 }, drawDistance: 30, drawDistanceBias: 0, indexCount: 36, firstIndex: 0, baseVertex: 0, firstInstance: 3, count: 1, flags: 0, shFeature: 0, shFlags: GD_SHF_CASTS | GD_SHF_WIND });
    const F: GdFrameParams = { planes: boxPl(-100, 100, -100, 100, -100, 100), cam: [0, 2, -20], lodOn: true, lodOrtho: false, orthoD2: 0, lodScale: 1, lodBias: 0, fogEye: [0, 0, 0], fogCull2: Infinity, fogCullOther: false, fogCullAttach: false, hcOn: true, cpuState: true };
    const S: GdShadowParams = { on: true, light: boxPl(-50, 50, -50, 50, -50, 50), casc: [boxPl(-1, 10, -1, 10, -1, 10), boxPl(-20, 20, -20, 20, -20, 20)], cascades: 2, ldir: [0.3, -0.9, 0.3], floorY: 0, reach: true,
      lodFar: 0.5, lodC0: 0.1, lodC1: 0.1, cache: true, split: true, wind: false, join: true, band: false, bandAttach: false, bandIn: 0 };
    const V = GD_CTL_ENABLED | GD_CTL_VISITED;
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, S, 0b111)).toBe(0);            // drawn into every static layer, static: nothing
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, S, 0b101)).toBe(0b010);        // not known in cascade 0: may join there
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, S, 0)).toBe(0b111);
    expect(gdShadowDynMaybe(T.f, T.u, V | GD_CTL_DYNAMIC, 0, F, S, 0b111)).toBe(0b111);   // a mover
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, { ...S, wind: true }, 0b111)).toBe(0b111);  // swaying
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, { ...S, join: false }, 0)).toBe(0);        // no joiners without the deferral
    expect(gdShadowDynMaybe(T.f, T.u, GD_CTL_ENABLED, 0, F, S, 0)).toBe(0);               // a rejected cluster member
    expect(gdShadowDynMaybe(T.f, T.u, V | GD_CTL_CPU_LOD, 0, F, S, 0)).toBe(0);           // the CPU's LOD verdict: hidden
    expect(gdShadowDynMaybe(T.f, T.u, V | GD_CTL_FORCED, 0, F, S, 0)).toBe(0);
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, { ...S, light: boxPl(100, 200, -50, 50, -50, 50) }, 0)).toBe(0);   // outside the light box
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, { ...F, planes: boxPl(300, 400, -100, 100, -100, 100) }, S, 0)).toBe(0);  // its shadow misses the view
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, { ...S, casc: [boxPl(500, 600, -1, 1, -1, 1), S.casc[1]] }, 0)).toBe(0b101);   // outside cascade 0
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, { ...S, split: false, cache: false }, 0)).toBe(0);   // no dynamic layers at all
    // the control pass's cached form: the box tests come from the caller (excl), the reach test still runs (boundReach)
    const away = { ...F, planes: boxPl(300, 400, -100, 100, -100, 100) };
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, S, 0, true, 0)).toBe(0b111);
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, F, S, 0, true, 0b010)).toBe(0b101);           // the caller found it outside cascade 0
    expect(gdShadowDynMaybe(T.f, T.u, V, 0, away, S, 0, true, 0)).toBe(0);                 // its shadow misses the view
    setGdBoundReach(false);
    try { expect(gdShadowDynMaybe(T.f, T.u, V, 0, away, S, 0, true, 0)).toBe(0b111); }    // the looser A/B form
    finally { setGdBoundReach(true); }
  });

  it('the bound covers every dynamic block cs_shadow writes (fuzzed records, control words, states, frames, city coordinates)', () => {
    const R = rng(41);
    const cull = new FrustumCuller();
    const T = recTable(1);
    let dynBlocks = 0, boundBlocks = 0, n = 0;
    for (let t = 0; t < 400; t++) {
      const O = t % 2 ? 4000 + R() * 2000 : 0;   // city coordinates: f32 rounding on the GPU side
      const eye = [O + R() * 40 - 20, 1 + R() * 30, O * 0.5 + R() * 40 - 20], at = [O + R() * 40 - 20, 0, O * 0.5 + R() * 40 - 20];
      const v = mat4.lookAt(mat4.create(), eye as [number, number, number], at as [number, number, number], [0, 1, 0]);
      cull.setFromViewProjection(mat4.multiply(mat4.create(), mat4.perspectiveZO(mat4.create(), 0.5 + R(), 1.5, 0.1, 150 + R() * 200), v));
      const planes = cull.writePlanes(new Float32Array(24));
      const lx = eye[0] + R() * 20 - 10, lz = eye[2] + R() * 20 - 10, lh = 20 + R() * 100;
      const ch0 = 3 + R() * 15, ch1 = ch0 + R() * 40;
      const ld = [R() - 0.5, -(0.02 + R()), R() - 0.5], ll = Math.hypot(ld[0], ld[1], ld[2]);
      const F: GdFrameParams = { planes: R() < 0.92 ? planes : null, cam: eye, lodOn: R() < 0.8, lodOrtho: false, orthoD2: 0, lodScale: 0.5 + R(), lodBias: R() * 5,
        fogEye: eye, fogCull2: R() < 0.5 ? Infinity : (20 + R() * 120) ** 2, fogCullOther: R() < 0.5, fogCullAttach: R() < 0.3, hcOn: R() < 0.7, groupTwins: R() < 0.5, cpuState: R() < 0.7 };
      const S: GdShadowParams = { on: true, light: R() < 0.9 ? boxPl(lx - lh, lx + lh, -50, 80, lz - lh, lz + lh) : null,
        casc: [boxPl(eye[0] - ch0, eye[0] + ch0, -20, 40, eye[2] - ch0, eye[2] + ch0), R() < 0.8 ? boxPl(eye[0] - ch1, eye[0] + ch1, -30, 60, eye[2] - ch1, eye[2] + ch1) : null],
        cascades: Math.floor(R() * 3), ldir: [ld[0] / ll, ld[1] / ll, ld[2] / ll], floorY: R() < 0.8 ? -1 + R() : Infinity, reach: R() < 0.8,
        lodFar: R() * 0.6, lodC0: R() * 0.2, lodC1: R() * 0.3, cache: R() < 0.85, split: R() < 0.85, wind: R() < 0.5, join: R() < 0.85,
        band: R() < 0.4, bandAttach: R() < 0.5, bandIn: 10 + R() * 80 };
      for (let k = 0; k < 60; k++) {
        const cx = eye[0] + (R() - 0.5) * 300, cz = eye[2] + (R() - 0.5) * 300, cy = R() * 10, hx = 0.2 + R() * 12, hy = 0.2 + R() * 15, hz = 0.2 + R() * 12;
        const group = R() < 0.2, noBox = R() < 0.04;
        const fogc = R() < 0.3 ? GD_FLAG_FOG_OTHER : R() < 0.3 ? GD_FLAG_FOG_ATTACH : 0;
        packGdRecord(T.f, T.u, T.i, 0, { box: noBox ? null : { minX: cx - hx, minY: cy, minZ: cz - hz, maxX: cx + hx, maxY: cy + hy, maxZ: cz + hz },
          drawDistance: R() < 0.4 ? 10 + R() * 80 : 0, drawDistanceBias: R(), indexCount: R() < 0.03 ? 0 : 36, firstIndex: 0, baseVertex: 0, firstInstance: k, count: group ? 1 + Math.floor(R() * 8) : 1,
          flags: fogc | (R() < 0.1 ? GD_FLAG_NO_FOG : 0) | (group ? GD_FLAG_GROUP : 0),
          twinRole: R() < 0.3 ? Math.floor(R() * 5) : 0, twinDist: R() < 0.8 ? 10 + R() * 60 : 0, twinDist2: 30 + R() * 80, twinFlags: (R() < 0.2 ? GD_TWIN_OFF_NEAR : 0) | (R() < 0.2 ? GD_TWIN_INSTANCED : 0),
          origin: group && R() < 0.7 ? [cx - 1, cy, cz - 1, cx + 1, cy + 1, cz + 1] : null,
          shFeature: R() < 0.3 ? R() * 0.8 : 0, shFlags: (R() < 0.95 ? GD_SHF_CASTS : 0) | (R() < 0.3 ? GD_SHF_WIND : 0) });
        const ctl = (R() < 0.92 ? GD_CTL_ENABLED : 0) | (R() < 0.08 ? GD_CTL_FORCED | (R() < 0.5 ? GD_CTL_FORCED_VIS : 0) : 0) | (R() < 0.75 ? GD_CTL_VISITED : 0)
          | (R() < 0.15 ? GD_CTL_DYNAMIC : 0) | (R() < 0.1 ? GD_CTL_NOREACH : 0) | (R() < 0.25 ? GD_CTL_CPU_LOD : 0) | (R() < 0.5 ? GD_CTL_CPU_N1 : 0) | (R() < 0.5 ? GD_CTL_CPU_N2 : 0);
        const st0 = (R() < 0.3 ? GD_STATE_LOD_HIDDEN : 0) | (R() < 0.5 ? GD_STATE_TWIN_NEAR : 0) | (R() < 0.5 ? GD_STATE_TWIN_NEAR2 : 0) | (R() < 0.6 ? GD_STATE_VISITED_LAST : 0)
          | (R() < 0.5 ? GD_STATE_IN_FAR : 0) | (R() < 0.5 ? GD_STATE_IN_C0 : 0) | (R() < 0.5 ? GD_STATE_IN_C1 : 0);
        const cu = gdCullRecord(T.f, T.u, ctl, st0, 0, F);           // cs_cull (this frame's SH_ELIG, held LOD / twin state)
        const sh = gdShadowRecord(T.f, T.u, ctl, cu.state, 0, F, S);  // cs_shadow
        const inBits = (cu.state / GD_STATE_IN_FAR) & 7;
        const known = inBits & Math.floor(R() * 8);                    // any subset of what the GPU holds (a snapshot)
        const b = gdShadowDynMaybe(T.f, T.u, ctl, 0, F, S, known);
        const d = dynBits(sh.mask);
        if ((d & ~b) !== 0) console.log('MISS', t, k, { d, b, ctl, st: cu.state, known, flags: T.u[GdRecW.flags], noBox: (T.u[GdRecW.flags] & GD_FLAG_NO_BOX) !== 0 });
        expect(d & ~b).toBe(0);
        // the control pass's cached form: outside the light box = nothing; else the cascade-outside mask stands in
        // for the box tests and the reach test is skipped
        if (S.light && gdBoxOutsideLoose(T.f, T.u, 0, S.light)) expect(d).toBe(0);
        else {
          const excl = (S.casc[0] && gdBoxOutsideLoose(T.f, T.u, 0, S.casc[0]) ? 2 : 0) | (S.casc[1] && gdBoxOutsideLoose(T.f, T.u, 0, S.casc[1]) ? 4 : 0);
          expect(d & ~gdShadowDynMaybe(T.f, T.u, ctl, 0, F, S, known, true, excl)).toBe(0);
        }
        for (let j = 0; j < 3; j++) { dynBlocks += (d >> j) & 1; boundBlocks += (b >> j) & 1; }
        n++;
      }
    }
    expect(n).toBe(24000);
    expect(dynBlocks).toBeGreaterThan(1500);   // the fuzz really reaches the dynamic layers
    expect(boundBlocks).toBeLessThan(n * 3);   // and the bound is not everything
  });

  it('end to end: the compact bundles draw exactly each dynamic layer\'s casters, the count never exceeds K, the P14 re-render counts are the CPU path\'s', async () => {
    const mk = async (maps: boolean) => {
      const sc = await scene({ maps });
      const r = sc.r;
      r.enableShadows(1024, 60);
      r.setShadowCascades({ cascades: 3, nearExtent: 10 });
      r.setDirectionalLight(-0.4, -0.8, -0.3, 1, 1, 1, 1);
      r._wind = { ...(r._wind ?? {}), strength: 1, speed: 1 };
      for (const m of sc.meshes) {
        const k = +((m.name as string).replace(/\D/g, '') || 0);
        if (k % 5 === 1) m.material.windSway = true;
        if (k % 6 === 2) m.shadowFeatureSize = 0.05 + (k % 4) * 0.4;
        if ((m.name as string) === 'gA-src') m.castsInstancedShadow = true;
      }
      return sc;
    };
    const A = await mk(true), B = await mk(false);
    const { GpuDrivenMain } = await import('./gpu-scene');
    const R3 = A.Renderer3D as unknown as { gpuDriven: boolean; gpuDrivenLean: boolean };
    const prev = { g: R3.gpuDriven, l: R3.gpuDrivenLean, sh: GpuDrivenMain.shadows, c: GpuDrivenMain.shadowCompact };
    try {
      GpuDrivenMain.shadowCompact = true;
      const em = emulator(A.r, A.dev.mem); A.dev.onEncode.push(em.run);
      const emB = emulator(B.r, B.dev.mem); B.dev.onEncode.push(emB.run);
      const pipe = { label: 'shadowPipe' } as unknown as GPURenderPipeline, bg = { label: 'bg' } as unknown as GPUBindGroup;
      let frames = 0, drawn = 0, sumK = 0, sumFull = 0, snapFrames = 0, knownChecked = 0;
      for (let f = 0; f < 160; f++) {
        await Promise.resolve(); await Promise.resolve();   // pipelines + read-backs resolve on microtasks
        const ang = f * 0.06, rad = 10 + 50 * Math.abs(Math.sin(f * 0.03));
        for (const sc of [A, B]) {
          sc.cam.setPosition(Math.cos(ang) * rad, 3 + (f % 40) * 0.6, Math.sin(ang) * rad);
          sc.cam.setTarget(Math.cos(ang + 1.3) * 25, 0, Math.sin(ang + 1.3) * 25);
          if (f === 70) { const m = sc.meshes.find((x) => x.name === 'm15')!; m.setPosition3D(m.x + 5, m.y, m.z); }
        }
        GpuDrivenMain.shadows = true; R3.gpuDriven = true; R3.gpuDrivenLean = true;
        A.r.drawMeshes(recordingPass(em.args).pass, A.meshes, 1300, 850);
        GpuDrivenMain.shadows = false; R3.gpuDrivenLean = false;
        B.r.drawMeshes(recordingPass(emB.args).pass, B.meshes, 1300, 850);
        const gd = A.r._gd;
        if (!gd?._shOn) continue;
        expect(gd._shCmp).toBe(true);
        frames++;
        const statsU = new Uint32Array(A.dev.mem.get(gd._statsBuf)!.buffer);
        GD_SH_COMPACT_LAYERS.forEach((L, j) => {
          const want = em.shadowSlots(L);   // the per-record blocks of the layer (the full bundles' draws)
          const rp = recordingPass(em.args);
          gd.drawShadow(rp.pass, L, pipe, bg, 'test');
          const got = rp.draws.map((d: Draw) => d.slot).sort((x: number, y: number) => x - y);
          expect(got, `frame ${f} layer ${L}`).toEqual([...want].sort((x, y) => x - y));   // the same casters, each once
          expect(statsU[GdStat.shCompact + j]).toBeLessThanOrEqual(gd._shK[j]);   // never past the bundle's K
          drawn += want.size; sumK += gd._shK[j]; sumFull += gd._slots.high;
        });
        // the snapshot never vouches for an IN bit the GPU state lacks
        if (gd._snapFrame >= 0) {
          snapFrames++;
          const st = new Uint32Array(A.dev.mem.get(gd._stateBuf)!.buffer);
          let inOk = 0; for (let k = 0; k < 3; k++) if (gd._commitF[k] < gd._snapFrame) inOk |= 1 << k;
          for (let r = 0; r < gd._slots.high; r++) {
            if (!(gd._seedF[r] <= gd._snapFrame)) continue;
            const kin = gd._inSnap[r] & inOk;
            expect(kin & ~((st[r] / GD_STATE_IN_FAR) & 7), `record ${r}`).toBe(0);
            knownChecked += kin ? 1 : 0;
          }
        }
      }
      console.log('compact e2e', { frames, drawn, sumK, sumFull, snapFrames, knownChecked, renders: A.r._shadowCacheStats.staticRenders, casc: A.r._cascadeWhy });
      expect(frames).toBeGreaterThan(140);
      expect(drawn).toBeGreaterThan(500);
      expect(snapFrames).toBeGreaterThan(100);   // read-back snapshots landed (after each commit)
      expect(knownChecked).toBeGreaterThan(30);   // (this scene's cascades re-render every frame: mostly far-layer IN bits)
      expect(sumK).toBeLessThan(sumFull * 0.75);  // the compact bundles issue far fewer draws than one per record
      // the P14 static-layer re-renders are the CPU path's (the compaction changes no decision)
      expect(A.r._shadowCacheStats.staticRenders).toBe(B.r._shadowCacheStats.staticRenders);
      expect(A.r._cascadeWhy).toEqual(B.r._cascadeWhy);
      expect(A.r._gd.stats.shCompactOver).toBe(0);
    } finally { R3.gpuDriven = prev.g; R3.gpuDrivenLean = prev.l; GpuDrivenMain.shadows = prev.sh; GpuDrivenMain.shadowCompact = prev.c; }
  });
});
