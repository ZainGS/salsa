/**
 * P14 (performance-plan.md, engine-roadmap step 7): the pure parts of the shadow caching — far-map run selection
 * (light box ∩ shadow reach), the cascade box hold + depth margin, the cascade refresh decision, the caster signature
 * and the stepped sun direction.
 */
import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { FrustumCuller, shadowReachesView } from './frustum-culler';
import { buildCullRanges, selectRanges } from './cull-ranges';
import { ShadowRunTester, CasterSig, StaticLayerMembers, cascadeBoxHolds, cascadeDepthMargin, cascadeRefresh, copyCascadeBox, newCascadeCacheState, stepSunDirection } from './shadow-cache';
import { cascadeLightBox, cascadeMatrixFromBox, computeCascadeMatrix, computeLightSpaceMatrix, type CascadeLightBox } from './scene-uniforms';
import { vec3 } from 'gl-matrix';

const scratch = () => ({ eye: vec3.create(), up: vec3.create(), view: mat4.create(), proj: mat4.create(), out: mat4.create() });
const unit = (v: number[]): number[] => { const l = Math.hypot(...v); return v.map((x) => x / l); };

/** A deterministic PRNG. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** A "streamed tile layer": `n` small boxes (12 triangles each) scattered over a wide square, emitted in rows (so a run is
 *  spatially compact, as the city builders emit). Stride 12 floats per vertex, position first. */
function tileMesh(n: number, span: number, seed: number): { v: Float32Array; idx: Uint32Array } {
  const r = rng(seed), V: number[] = [], I: number[] = [];
  const cols = Math.ceil(Math.sqrt(n)), B = 5, bc = Math.ceil(cols / B);
  for (let k = 0; k < n; k++) {
    // block by block (5 x 5 boxes ~ one 256-triangle run), the way the city builders emit lot by lot
    const blk = Math.floor(k / (B * B)), q = k % (B * B);
    const gx = (blk % bc) * B + (q % B), gz = Math.floor(blk / bc) * B + Math.floor(q / B);
    const cx = (gx + r() * 0.5) / cols * span - span / 2, cz = (gz + r() * 0.5) / cols * span - span / 2;
    const h = 0.5 + r() * 6, w = 0.3 + r() * 1.5;
    const base = V.length / 12;
    for (let c = 0; c < 8; c++) { V.push(cx + (c & 1 ? w : -w), c & 2 ? h : 0, cz + (c & 4 ? w : -w)); for (let p = 3; p < 12; p++) V.push(0); }
    const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (const f of faces) I.push(base + f[0], base + f[1], base + f[2], base + f[0], base + f[2], base + f[3]);
  }
  return { v: new Float32Array(V), idx: new Uint32Array(I) };
}

/** The far map's light culler over a box of half-extent `he` around `c` (computeLightSpaceMatrix, as the renderer). */
function lightCuller(d: number[], he: number, c: number[]): FrustumCuller {
  const m = computeLightSpaceMatrix(d, he, vec3.fromValues(c[0], c[1], c[2]), scratch());
  return FrustumCuller.fromViewProjection(m);
}
/** A street-level camera. */
function camera(eye: number[], at: number[], far = 120): FrustumCuller {
  const proj = mat4.perspectiveZO(mat4.create(), (72 * Math.PI) / 180, 1.6, 0.05, far);
  const view = mat4.lookAt(mat4.create(), eye as unknown as vec3, at as unknown as vec3, [0, 1, 0]);
  return FrustumCuller.fromViewProjection(mat4.multiply(mat4.create(), proj, view));
}

describe('ShadowRunTester + selectRanges (P14.1 far-map ranges)', () => {
  const d = unit([0.35, -0.8, 0.3]);
  const mesh = tileMesh(900, 420, 7);
  const rg = buildCullRanges(mesh.v, mesh.idx, 12, null, 256);

  it('keeps exactly the runs inside the light box (static list) and inside light box ∩ reach (direct list)', () => {
    const L = lightCuller(d, 60, [30, 0, -20]), cam = camera([25, 1.6, -10], [25, 1.6, -60]);
    for (const reach of [null, cam]) {
      const t = new ShadowRunTester().set(L, reach, d, 0);
      const spans: number[] = [];
      selectRanges(rg, t, spans, 0);
      const kept = new Set<number>();
      for (let k = 0; k < spans.length; k += 2) for (let f = spans[k]; f < spans[k] + spans[k + 1]; f += rg.count[0]) kept.add(f);
      for (let r = 0; r < rg.n; r++) {
        const b = rg.box.subarray(r * 6, r * 6 + 6);
        const want = L.testAABB(b[0], b[1], b[2], b[3], b[4], b[5]) && (!reach || shadowReachesView(reach, d, 0, b[0], b[1], b[2], b[3], b[4], b[5]));
        expect(kept.has(rg.first[r])).toBe(want);
      }
      // a whole-tile mesh submits a small part of itself
      const keptTris = spans.reduce((a, x, k) => (k & 1 ? a + x / 3 : a), 0);
      expect(keptTris).toBeLessThan(mesh.idx.length / 3 / 2);
      expect(keptTris).toBeGreaterThan(0);
    }
  });

  it('never drops a triangle that has a vertex inside the light box (the far map stays bit-identical)', () => {
    const L = lightCuller(d, 40, [-50, 0, 70]);
    const t = new ShadowRunTester().set(L, null, d, 0);
    const spans: number[] = [];
    selectRanges(rg, t, spans, 2);
    const inSpan = (i: number) => { for (let k = 0; k < spans.length; k += 2) if (i >= spans[k] && i < spans[k] + spans[k + 1]) return true; return false; };
    for (let i = 0; i < mesh.idx.length; i += 3) {
      let anyIn = false;
      for (let j = 0; j < 3; j++) { const o = mesh.idx[i + j] * 12; if (L.containsAABB(mesh.v[o], mesh.v[o + 1], mesh.v[o + 2], mesh.v[o], mesh.v[o + 1], mesh.v[o + 2])) anyIn = true; }
      if (anyIn) expect(inSpan(i)).toBe(true);
    }
  });

  it('containsAABB is conservative: a box it contains has every sub-box passing testAABB', () => {
    const L = lightCuller(d, 80, [0, 0, 0]), cam = camera([0, 1.6, 30], [0, 1.6, -30], 200);
    const t = new ShadowRunTester().set(L, cam, d, 0);
    const r = rng(3);
    let contained = 0;
    for (let k = 0; k < 4000; k++) {
      const x = (r() - 0.5) * 160, y = r() * 10, z = (r() - 0.5) * 160, s = 0.5 + r() * 12;
      if (!t.containsAABB(x, y, z, x + s, y + s, z + s)) continue;
      contained++;
      for (let q = 0; q < 6; q++) {
        const a = x + r() * s, b = y + r() * s, c = z + r() * s, e = r() * (s / 3);
        expect(t.testAABB(a, b, c, Math.min(x + s, a + e), Math.min(y + s, b + e), Math.min(z + s, c + e))).toBe(true);
      }
    }
    expect(contained).toBeGreaterThan(20);
  });

  it('a low sun or an unknown floor keeps the reach test out of the way (shadowReachesView passes everything)', () => {
    const L = lightCuller(unit([1, -0.02, 0]), 50, [0, 0, 0]);
    const far = camera([500, 2, 500], [600, 2, 600]);
    const t = new ShadowRunTester().set(L, far, unit([1, -0.02, 0]), 0);
    expect(t.reachActive).toBe(false);
    const t2 = new ShadowRunTester().set(L, far, d, NaN);
    expect(t2.reachActive).toBe(false);
  });
});

describe('CasterSig', () => {
  it('is order independent and changes when a member changes', () => {
    const a = new CasterSig(), b = new CasterSig();
    const items = [[1, 10, 1], [2, 11, 1], [3, 12, 2], [99, 4, 1]];
    for (const x of items) a.mix(x[0], x[1], x[2]);
    for (const x of [...items].reverse()) b.mix(x[0], x[1], x[2]);
    expect(a.value).toBe(b.value);
    const c = new CasterSig(); for (const x of items.slice(0, 3)) c.mix(x[0], x[1], x[2]);
    expect(c.value).not.toBe(a.value);
    const e = new CasterSig(); for (const x of items) e.mix(x[0], x[1] + (x[0] === 3 ? 1 : 0), x[2]);   // a slot moved
    expect(e.value).not.toBe(a.value);
    a.reset(); expect(a.value).toBe(new CasterSig().value);
  });
});

describe('near-cascade box hold (P14.2 slack)', () => {
  const d = unit([0.4, -0.75, 0.3]);
  const he = 1.6, size = 2048;
  const want = (c: number[], back = 6, fwd = 4): CascadeLightBox => cascadeLightBox(d, he, c, back, fwd, size, scratch(), { dx: 0, dy: 0, dz: 0, he: 0, size: 0, sx: 0, sy: 0, zn: 0, zf: 0 });

  it('cascadeLightBox + cascadeMatrixFromBox reproduce computeCascadeMatrix bit for bit', () => {
    const r = rng(11);
    for (let k = 0; k < 50; k++) {
      const c = [(r() - 0.5) * 40, r() * 3, (r() - 0.5) * 40], back = 2 + r() * 20, fwd = 1 + r() * 8, dd = unit([r() - 0.5, -0.3 - r(), r() - 0.5]);
      const a = computeCascadeMatrix(dd, he, c, back, fwd, size, scratch(), new Float32Array(16));
      const b = cascadeMatrixFromBox(cascadeLightBox(dd, he, c, back, fwd, size, scratch(), want([0, 0, 0])), scratch(), new Float32Array(16));
      expect(Array.from(b)).toEqual(Array.from(a));
    }
  });

  it('holds within the slack and the depth range, re-centres past either', () => {
    const texel = (2 * he) / size, slack = 64 * texel;
    const held = copyCascadeBox(want([0, 0, 0]), want([0, 0, 0]));
    const m = cascadeDepthMargin(slack, held.dy); held.zn -= m; held.zf += m;
    expect(cascadeBoxHolds(held, want([0.3 * slack, 0, 0.2 * slack]), slack)).toBe(true);
    expect(cascadeBoxHolds(held, want([3 * slack, 0, 0]), slack)).toBe(false);
    expect(cascadeBoxHolds(held, want([0, 0, 0], 6 + 2 * m + 1, 4), slack)).toBe(false);   // a taller caster: depth outside
    expect(cascadeBoxHolds(held, want([0, 0, 0]), 0)).toBe(false);                            // slack 0 = never hold
    const other = cascadeLightBox(unit([0.41, -0.75, 0.3]), he, [0, 0, 0], 6, 4, size, scratch(), want([0, 0, 0]));
    expect(cascadeBoxHolds(held, other, slack)).toBe(false);                                  // the sun moved
  });

  it('the depth margin covers every horizontal move the centre test lets through', () => {
    const r = rng(5);
    for (const dd of [unit([0.4, -0.75, 0.3]), unit([0.9, -0.3, 0.2]), unit([0.1, -0.98, 0.05])]) {
      const texel = (2 * he) / size, slack = 64 * texel;
      const b0 = cascadeLightBox(dd, he, [0, 0, 0], 6, 4, size, scratch(), want([0, 0, 0]));
      const held = copyCascadeBox(want([0, 0, 0]), b0);
      const m = cascadeDepthMargin(slack, held.dy); held.zn -= m; held.zf += m;
      for (let k = 0; k < 400; k++) {
        const a = r() * Math.PI * 2, h = r() * slack * 4;
        const w = cascadeLightBox(dd, he, [Math.cos(a) * h, 0, Math.sin(a) * h], 6, 4, size, scratch(), want([0, 0, 0]));
        if (Math.abs(w.sx - held.sx) <= slack && Math.abs(w.sy - held.sy) <= slack) expect(w.zn >= held.zn && w.zf <= held.zf).toBe(true);
      }
    }
  });
});

describe('cascadeRefresh (P14.2 invalidation)', () => {
  it('re-renders the static layer only on a cold cache, a box move, a set change or a structural change', () => {
    const st = newCascadeCacheState();
    expect(cascadeRefresh(st, false, 5, false, false, false)).toEqual({ renderStatic: true, composite: true });   // cold
    st.valid = true; st.sigDrawn = 5; st.dynInMap = false;
    expect(cascadeRefresh(st, false, 5, false, false, true)).toEqual({ renderStatic: false, composite: false });  // nothing moves
    expect(cascadeRefresh(st, false, 5, false, true, false)).toEqual({ renderStatic: false, composite: false });  // dynamic, not due
    expect(cascadeRefresh(st, false, 5, false, true, true)).toEqual({ renderStatic: false, composite: true });    // dynamic layer due
    expect(cascadeRefresh(st, true, 5, false, true, false).renderStatic).toBe(true);                             // box moved
    expect(cascadeRefresh(st, false, 6, false, false, false).renderStatic).toBe(true);                           // static set changed
    expect(cascadeRefresh(st, false, 5, true, false, false).renderStatic).toBe(true);                            // structural
    st.dynInMap = true;
    expect(cascadeRefresh(st, false, 5, false, false, false)).toEqual({ renderStatic: false, composite: true });  // movers left: clear them once
  });

  it('a walk: the static layer re-renders once per re-centre while the dynamic layer follows the player every frame', () => {
    const st = newCascadeCacheState();
    let statics = 0, composites = 0;
    for (let f = 0; f < 300; f++) {
      const boxChanged = f % 60 === 0;   // a re-centre every second
      const r = cascadeRefresh(st, boxChanged, 1, false, true, true);
      if (r.renderStatic) { statics++; st.valid = true; st.sigDrawn = 1; }
      if (r.composite) { composites++; st.dynInMap = true; }
    }
    expect(statics).toBe(5);
    expect(composites).toBe(300);
  });
});

describe('stepSunDirection', () => {
  it('follows the sun only once it turned by the step (0 = every change)', () => {
    const cur: [number, number, number] = unit([0.3, -0.8, -0.5]) as [number, number, number];
    const turn = (deg: number) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); const x = cur[0], z = cur[2]; return [x * c - z * s, cur[1], x * s + z * c]; };
    expect(stepSunDirection(cur, [...cur], 0.15)).toBe(false);
    expect(stepSunDirection(cur, turn(0.05), 0.15)).toBe(false);
    const n = turn(0.4);
    expect(stepSunDirection(cur, n, 0.15)).toBe(true);
    expect(cur).toEqual(n);
    expect(stepSunDirection(cur, turn(0.01), 0)).toBe(true);
    // a 120 s day at 60 fps: ~20 steps a second instead of 60
    let steps = 0; const c2: [number, number, number] = [0, -1, 0];
    for (let f = 0; f < 60; f++) { const a = ((f + 1) * 3 / 60) * Math.PI / 180 + 0.6; const next = [Math.cos(a) * 0.6, -0.8, Math.sin(a) * 0.6]; const l = Math.hypot(...next); if (stepSunDirection(c2, next.map((x) => x / l), 0.15)) steps++; }
    expect(steps).toBeGreaterThanOrEqual(10);
    expect(steps).toBeLessThanOrEqual(22);
  });

  it('a non-unit start (the renderer default before any sun) takes the first real sun', () => {
    const cur: [number, number, number] = [0.3, -0.8, -0.5];
    expect(stepSunDirection(cur, unit([0.3, -0.8, -0.5]), 0.15)).toBe(true);
  });
});

describe('StaticLayerMembers (P14 joiners: streamed tiles join a cached static layer in batches)', () => {
  /** A model of one cached layer over frames: `present` = this frame's static casters. Returns the static re-renders. */
  function simulate(frames: { present: object[] }[], maxTris = 1000, maxFrames = 30): number {
    const mem = new StaticLayerMembers(), all = new CasterSig(), kept = new CasterSig();
    let drawnSig = NaN, valid = false, renders = 0, drawn = new Set<object>();
    frames.forEach((f, fr) => {
      mem.beginFrame(); all.reset(); kept.reset();
      const keys: object[] = [], joiners: object[] = [];
      for (const k of f.present) {
        const id = (k as { id: number }).id;
        all.mix(id, 0, 1); keys.push(k);
        if (mem.has(k)) kept.mix(id, 0, 1); else { mem.join(100, fr); joiners.push(k); }
      }
      mem.endFrame();
      if (!valid || kept.value !== drawnSig || mem.due(fr, maxTris, maxFrames)) { valid = true; drawnSig = all.value; mem.drawnWith(keys); drawn = new Set(keys); renders++; }
      // the map = the static layer ∪ the joiners (drawn with the dynamic casters) = exactly this frame's casters,
      // and the static layer never holds a caster that is gone
      const map = new Set<object>([...drawn, ...joiners]);
      expect(map.size).toBe(f.present.length);
      for (const k of drawn) expect(f.present.includes(k)).toBe(true);
    });
    return renders;
  }
  const objs = Array.from({ length: 60 }, (_, i) => ({ id: i + 1 }));

  it('joiners wait for the budget or the time limit; one re-render takes them all', () => {
    // 20 static casters, then one new tile mesh joins every 2nd frame for 40 frames
    const frames = Array.from({ length: 80 }, (_, f) => ({ present: objs.slice(0, 20 + Math.min(20, Math.floor(f / 2))) }));
    const deferred = simulate(frames, 1000, 30);     // 100 tris each: due at 10 joiners or 30 frames
    expect(deferred).toBeLessThanOrEqual(4);
    // tiles leave too (and others keep arriving): every frame stays exact (asserted inside simulate)
    simulate(Array.from({ length: 60 }, (_, f) => ({ present: objs.slice(f >= 30 ? 6 : 0, 25 + (f >> 2)) })), 1000, 30);
    // without deferral every arrival re-renders
    let eager = 0, last = NaN;
    for (const f of frames) { const s = new CasterSig(); for (const k of f.present) s.mix((k as { id: number }).id, 0, 1); if (s.value !== last) { eager++; last = s.value; } }
    expect(eager).toBe(21);
  });

  it('a drawn caster that leaves re-renders at once (no stale shadow)', () => {
    const mem = new StaticLayerMembers(), kept = new CasterSig(), all = new CasterSig();
    for (const k of objs.slice(0, 5)) all.mix((k as { id: number }).id, 0, 1);
    mem.drawnWith(objs.slice(0, 5));
    const drawnSig = all.value;
    mem.beginFrame();
    for (const k of objs.slice(1, 5)) if (mem.has(k)) kept.mix((k as { id: number }).id, 0, 1);   // id 1 left
    expect(kept.value).not.toBe(drawnSig);
    expect(mem.due(0, 1e9, 1e9)).toBe(false);
    mem.endFrame();
    mem.clear(); expect(mem.size).toBe(0);
  });
});
