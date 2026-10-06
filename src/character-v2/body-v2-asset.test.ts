/**
 * body-v2 asset gates (body-v2@3; docs/specs/character-v2.md Phase 1, item 7 + "body-v2@2" + its review fixes, G3 +
 * integration):
 *   • FROZEN = pinned: the baked asset's fingerprint per base equals BODY_V2_FINGERPRINTS (any generator / base / table
 *     change fails here until it is re-pinned or the version is bumped — a deliberate decision);
 *   • blend shapes + bone offsets reproduce the v2 generator: every slider at sampled values, every slider PAIR at its
 *     corners, and 200 seeded random 4–6-slider combos per base (p50 / p95 / max reported, gated);
 *   • the per-base slider ranges are balanced around the base (both halves move the body comparably);
 *   • every per-base range end is a clean manifold with the base's topology + weights (the bake checks it per key);
 *   • the bake is deterministic (sync and time-sliced async give byte-identical tables); weights stay in [0, 1];
 *   • each shape is held ONCE (the dense array Mesh3D takes — evaluated bit-identically); resident bytes reported;
 *   • a failed async bake is retried, one asset object per base; bad slider values are rejected, never silently reset;
 *   • placement migration of body-v2@1 / pre-review body-v2@2 saves (the soles of the asset that wrote them, pinned
 *     against that asset's own generator); v1 is untouched (baking + evaluating v2 never changes v1's output).
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;

import { generateBodyResult, NEW_BODY_DEFAULTS, DEFAULT_BODY_PARAMS } from '../services/managers/body-generator';
import {
  bakeBodyV2, bakeBodyV2Async, getBodyV2Asset, bodyV2Weights, bodyV2JointLocal, bodyV2Vertices, bodyV2InverseBinds, sliderParams,
  sliderParamValue, denseShapeDelta, bodyV2DeltaBytes, bodyV2Fingerprint, bodyV2LegacySoleY, coerceBodyV2Slider, cleanBodyV2Sliders,
  editBodyV2Sliders, BodyV2AssetCache, BODY_V2_SLIDERS, BODY_V2_BASES, BODY_V2_AT1_BASES, BODY_V2_ASSET, BODY_V2_FINGERPRINTS, BODY_V2_CORRECTIVES,
  type BodyV2Asset, type BodyV2Sliders, type BodyV2SliderName, type BodyV2Base,
} from './body-v2-asset';
import { generateBodyV2, BODY_V2_GENERATOR_VERSION, type BodyV2GenParams, type BodyV2GenResult } from './body-v2-generator';
import { Mesh3D, blendSupport } from '../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../scene-graph/shapes/skinned-mesh-3d';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import type { InteractionService } from '../services/interaction-service';
import { CharacterV2Manager, skeletonFromResult, type CharacterV2Host, type CharacterV2Marker } from './character-v2';

const BASES = ['fem', 'masc'] as const;
const NAMES = BODY_V2_SLIDERS.map((d) => d.name);

/** Max vertex position error (mm) + max joint world-position error (mm) of the v2 evaluation vs the generator, and
 *  the inner-thigh midline crossings the blend has that the generator does not (|x| > 1 mm on the wrong side). */
function errorMm(asset: BodyV2Asset, sliders: BodyV2Sliders): { vert: number; joint: number; crossings: number } {
  const w = bodyV2Weights(asset, sliders);
  const V = bodyV2Vertices(asset, w), J = bodyV2JointLocal(asset, w);
  const ref = generateBodyV2(sliderParams(asset, sliders));
  const R = ref.geometry.vertices;
  let vert = 0, crossings = 0;
  for (let i = 0; i < asset.vertexCount; i++) {
    const o = i * 12, d = Math.hypot(V[o] - R[o], V[o + 1] - R[o + 1], V[o + 2] - R[o + 2]);
    if (d > vert) vert = d;
    if (R[o] !== 0 && Math.sign(V[o]) !== Math.sign(R[o]) && Math.abs(V[o]) > 0.001) crossings++;
  }
  const a = bodyV2InverseBinds(asset.jointParents, J).world, b = bodyV2InverseBinds(asset.jointParents, ref.skinning.jointLocalPositions!).world;
  let joint = 0;
  for (let j = 0; j < a.length / 3; j++) joint = Math.max(joint, Math.hypot(a[j * 3] - b[j * 3], a[j * 3 + 1] - b[j * 3 + 1], a[j * 3 + 2] - b[j * 3 + 2]));
  return { vert: vert * 1000, joint: joint * 1000, crossings };
}
/** Max vertex displacement (mm) of a slider state from the base, on the asset. */
function displacementMm(asset: BodyV2Asset, sliders: BodyV2Sliders): number {
  const V = bodyV2Vertices(asset, bodyV2Weights(asset, sliders)), B = asset.vertices;
  let m = 0;
  for (let i = 0; i < asset.vertexCount; i++) m = Math.max(m, Math.hypot(V[i * 12] - B[i * 12], V[i * 12 + 1] - B[i * 12 + 1], V[i * 12 + 2] - B[i * 12 + 2]));
  return m * 1000;
}
const minY = (v: Float32Array): number => { let lo = Infinity; for (let i = 1; i < v.length; i += 12) lo = Math.min(lo, v[i]); return lo; };
const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]; };
/** Seeded random combos: 4–6 distinct sliders, each uniform in [−1, 1] (2 decimals). Deterministic per base. */
function randomCombos(base: BodyV2Base, n: number): BodyV2Sliders[] {
  let s = base === 'fem' ? 0x2545f491 : 0x6c078965;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const out: BodyV2Sliders[] = [];
  for (let i = 0; i < n; i++) {
    const pool = [...NAMES], c: BodyV2Sliders = {};
    for (let k = 4 + Math.floor(rnd() * 3); k > 0; k--) {
      const nm = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      c[nm as BodyV2SliderName] = Math.round((rnd() * 2 - 1) * 100) / 100;
    }
    out.push(c);
  }
  return out;
}

/** Weld by exact position; every undirected edge must be used by exactly 2 triangles, in opposite directions. */
function manifoldDefects(r: BodyV2GenResult): number {
  const V = r.geometry.vertices, I = r.geometry.indices, id = new Map<string, number>(), w = new Int32Array(V.length / 12);
  for (let i = 0; i < w.length; i++) { const k = `${V[i * 12]},${V[i * 12 + 1]},${V[i * 12 + 2]}`; let x = id.get(k); if (x === undefined) { x = id.size; id.set(k, x); } w[i] = x; }
  const edges = new Map<string, number[]>();
  let bad = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = w[I[t]], b = w[I[t + 1]], c = w[I[t + 2]];
    if (a === b || b === c || a === c) { bad++; continue; }
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = p < q ? `${p},${q}` : `${q},${p}`; let e = edges.get(k); if (!e) { e = []; edges.set(k, e); } e.push(p < q ? 1 : -1); }
  }
  for (const e of edges.values()) if (e.length !== 2 || e[0] === e[1]) bad++;
  return bad;
}

const SAMPLES = [-1, -0.9, -0.7, -0.6, -0.375, -0.125, 0.125, 0.3, 0.45, 0.6, 0.7, 0.875, 1];   // mostly OFF the keys
const COMBOS: BodyV2Sliders[] = [
  { torsoThick: 0.6, shoulderWidth: 0.7 }, { torsoThick: 0.9, shoulderWidth: 0.3 }, { torsoThick: -0.85, shoulderWidth: -0.6 }, { torsoThick: 0.35, shoulderWidth: -0.8 },
  { limbThick: 0.9, shoulderWidth: 0.9 }, { limbThick: 0.9, torsoThick: 0.9 }, { headSize: 1, headShape: -1 },
  { torsoThick: -0.5, shoulderWidth: 1 },
  { legLength: 0.8, torsoLength: -0.6, limbThick: 0.5 },
  { bust: 0.7, waist: -0.6, hipWidth: 0.8, buttSize: 0.5 },
  { torsoLength: -0.8, bust: 0.9, hipWidth: 0.5 }, { torsoLength: 0.7, bust: -0.6 }, { shoulderWidth: 0.7, limbThick: -0.4, torsoThick: 0.6 },
  { waist: 1, torsoThick: 1 }, { hipWidth: -1, limbThick: 1 }, { hipWidth: 1, limbThick: -1 }, { bust: 1, torsoThick: 1 },
];

describe('body-v2@3 — FROZEN = pinned (fingerprint per base)', () => {
  it('the baked asset of every base matches BODY_V2_FINGERPRINTS[BODY_V2_ASSET] (a mismatch is a deliberate decision)', () => {
    const pin = BODY_V2_FINGERPRINTS[BODY_V2_ASSET];
    expect(pin, `no BODY_V2_FINGERPRINTS entry for ${BODY_V2_ASSET}`).toBeTruthy();
    expect(BODY_V2_GENERATOR_VERSION, 'generator version changed: re-pin / bump with it').toBe(pin.generatorVersion);
    const actual = { fem: bodyV2Fingerprint(getBodyV2Asset('fem')), masc: bodyV2Fingerprint(getBodyV2Asset('masc')) };
    const changed: string[] = [];
    for (const b of BASES) for (const k of ['topology', 'uv', 'shape', 'tables'] as const) if (actual[b][k] !== pin[b][k]) changed.push(`${b}.${k}`);
    const msg = `${BODY_V2_ASSET} changed (${changed.join(', ') || 'full'}) — ${pin.signedOff
      ? 'it is SIGNED OFF: do not re-pin; bump BODY_V2_ASSET_VERSION, add an entry, write the migration'
      : 'not signed off yet: re-pin BODY_V2_FINGERPRINTS if the change is intended'}. The entry for the CURRENT bake:\n`
      + `  '${BODY_V2_ASSET}': {\n    generatorVersion: ${BODY_V2_GENERATOR_VERSION}, signedOff: ${pin.signedOff},\n`
      + BASES.map((b) => `    ${b}: { ${(['full', 'topology', 'uv', 'shape', 'tables'] as const).map((k) => `${k}: '${actual[b][k]}'`).join(', ')} },\n`).join('') + '  },';
    expect(actual.fem.full, msg).toBe(pin.fem.full);
    expect(actual.masc.full, msg).toBe(pin.masc.full);
    expect(getBodyV2Asset('fem').generatorVersion).toBe(pin.generatorVersion);
  }, 120000);

  it('the fingerprint sees a 1-ulp change in any part (UVs, a shape delta, a weight) and the tables', () => {
    const a = getBodyV2Asset('fem'), f0 = bodyV2Fingerprint(a);
    const bump = (arr: Float32Array, i: number) => { const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.length); u[i] ^= 1; return () => { u[i] ^= 1; }; };
    for (const [part, undo] of [
      ['uv', bump(a.vertices, 7)], ['shape', bump(a.shapes[3].dense, a.shapes[3].idx[0] * 6)], ['topology', bump(a.jointWeights, 10)],
    ] as const) {
      const f = bodyV2Fingerprint(a);
      undo();
      expect(f[part], part).not.toBe(f0[part]);
      expect(f.full, part).not.toBe(f0.full);
    }
    expect(bodyV2Fingerprint(a)).toEqual(f0);   // restored → identical
  });
});

for (const base of BASES) {
  describe(`body-v2@3 (${base}) — sliders reproduce the generator`, () => {
    const asset = getBodyV2Asset(base);

    it('is the versioned asset with the v2 generator topology (20 joints)', () => {
      expect(asset.asset).toBe(BODY_V2_ASSET);
      expect(BODY_V2_ASSET).toBe('body-v2@3');
      const g = generateBodyV2(asset.params);
      expect(asset.vertexCount).toBe(g.geometry.vertices.length / 12);
      expect(asset.indices.length).toBe(g.geometry.indices.length);
      expect(asset.jointNames.length).toBe(20);
      for (let v = 0; v < asset.vertexCount; v++) {   // up to 4 influences (seam blend + hip smoothing), normalised
        const s = asset.jointWeights[v * 4] + asset.jointWeights[v * 4 + 1] + asset.jointWeights[v * 4 + 2] + asset.jointWeights[v * 4 + 3];
        expect(Math.abs(s - 1)).toBeLessThan(1e-4);
      }
    });

    it('every slider is within 3 mm of the generator at sampled values (per-slider max error reported)', () => {
      const rows: string[] = [];
      for (const def of BODY_V2_SLIDERS) {
        let vert = 0, joint = 0;
        for (const x of SAMPLES) { const e = errorMm(asset, { [def.name]: x }); vert = Math.max(vert, e.vert); joint = Math.max(joint, e.joint); }
        rows.push(`${def.name.padEnd(14)} vert ${vert.toFixed(2)} mm  joint ${joint.toFixed(2)} mm`);
        expect(vert, def.name).toBeLessThanOrEqual(3);
        expect(joint, def.name).toBeLessThanOrEqual(3);
      }
      console.log(`[body-v2 ${base}] slider accuracy (max over ${SAMPLES.join(', ')}):\n  ${rows.join('\n  ')}`);
    }, 120000);

    it('hand-picked combos stay within 3 mm (incl. the multiplicative pairs with correctives)', () => {
      const rows: string[] = [];
      for (const c of COMBOS) {
        const e = errorMm(asset, c);
        rows.push(`${JSON.stringify(c).padEnd(62)} vert ${e.vert.toFixed(2)} mm  joint ${e.joint.toFixed(2)} mm`);
        expect(e.vert, JSON.stringify(c)).toBeLessThanOrEqual(3);
        expect(e.joint, JSON.stringify(c)).toBeLessThanOrEqual(1);
      }
      console.log(`[body-v2 ${base}] combos:\n  ${rows.join('\n  ')}`);
    }, 120000);

    it('EVERY slider pair at its ±1 corners is within 2.5 mm (worst pairs reported)', () => {
      const rows: { k: string; e: number }[] = [];
      for (let i = 0; i < NAMES.length; i++) for (let j = i + 1; j < NAMES.length; j++) {
        let worst = 0, at = '';
        for (const [x, y] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const e = errorMm(asset, { [NAMES[i]]: x, [NAMES[j]]: y });
          if (e.vert > worst) { worst = e.vert; at = `(${x},${y})`; }
          expect(e.crossings, `${NAMES[i]} ${x} × ${NAMES[j]} ${y} midline crossings`).toBe(0);
        }
        rows.push({ k: `${NAMES[i]} × ${NAMES[j]} ${at}`, e: worst });
      }
      rows.sort((p, q) => q.e - p.e);
      console.log(`[body-v2 ${base}] pairs (66 × 4 corners), worst: ${rows.slice(0, 6).map((r) => `${r.k} ${r.e.toFixed(2)} mm`).join('; ')}`);
      // A new failing pair = the generator gained a cross term: add `{ a, b, grid: LIN }` (INB if it is not bilinear) to
      // BODY_V2_CORRECTIVES.
      for (const r of rows) expect(r.e, `${r.k}: add a corrective (BODY_V2_CORRECTIVES)`).toBeLessThanOrEqual(2.5);
    }, 180000);

    it('200 seeded random 4–6-slider combos: max ≤ 4 mm, p95 ≤ 2 mm, no blend-only midline crossing (p50 / p95 / max reported)', () => {
      const errs: number[] = [];
      let worst = { e: 0, c: '' }, crossings = 0, joint = 0;
      for (const c of randomCombos(base, 200)) {
        const e = errorMm(asset, c);
        errs.push(e.vert); crossings += e.crossings; joint = Math.max(joint, e.joint);
        if (e.vert > worst.e) worst = { e: e.vert, c: JSON.stringify(c) };
      }
      console.log(`[body-v2 ${base}] 200 random combos: p50 ${pct(errs, 0.5).toFixed(2)} / p95 ${pct(errs, 0.95).toFixed(2)} / max ${Math.max(...errs).toFixed(2)} mm (joints ≤ ${joint.toFixed(2)} mm); > 3 mm: ${errs.filter((e) => e > 3).length}; worst ${worst.c}`);
      expect(Math.max(...errs), worst.c).toBeLessThanOrEqual(4);
      expect(pct(errs, 0.95)).toBeLessThanOrEqual(2);
      expect(joint).toBeLessThanOrEqual(1);
      expect(crossings).toBe(0);
    }, 180000);

    it('slider weights are always in [0, 1] (the blend-shape engine clamps)', () => {
      for (const def of BODY_V2_SLIDERS) for (const x of [-1.5, ...SAMPLES, 1.5]) {
        const w = bodyV2Weights(asset, { [def.name]: x, torsoThick: x, shoulderWidth: -x, hipWidth: x, limbThick: -x, waist: x });
        for (const v of w) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1 + 1e-6); }
      }
    });

    it('per-base ranges are BALANCED: 0 = the base inside its range, each ±1 half moves the body ≥ 8 mm and within 2× of the other', () => {
      const rows: string[] = [];
      for (const d of BODY_V2_SLIDERS) {
        const r = d.range[base], b = asset.params[d.name] as number;
        const lo = displacementMm(asset, { [d.name]: -1 }), hi = displacementMm(asset, { [d.name]: 1 });
        rows.push(`${d.name.padEnd(14)} ${r.min.toFixed(2)} … ${b.toFixed(2)} … ${r.max.toFixed(2)}  −1 ${lo.toFixed(1)} mm  +1 ${hi.toFixed(1)} mm`);
        if (d.name === 'headShape') {   // the anime head (1) is the top of its range on both bases: a one-sided slider by design
          expect(r.max).toBe(b); expect(asset.sliders.headShape.every((k) => k.at < 0)).toBe(true); expect(lo).toBeGreaterThanOrEqual(8);
          continue;
        }
        const bounded = (d.bounds?.min !== undefined && r.min === d.bounds.min) || (d.bounds?.max !== undefined && r.max === d.bounds.max);
        if (!bounded) expect(r.max - b, `${d.name}: symmetric around the base`).toBeCloseTo(b - r.min, 12);
        expect(r.min, d.name).toBeLessThan(b);
        expect(r.max, d.name).toBeGreaterThan(b);
        expect(Math.min(lo, hi), `${d.name} weakest half`).toBeGreaterThanOrEqual(8);
        expect(Math.max(lo, hi) / Math.min(lo, hi), `${d.name} half ratio`).toBeLessThanOrEqual(2);
        expect(sliderParamValue(d, base, 1)).toBeCloseTo(r.max, 12);
        expect(sliderParamValue(d, asset.params, -1)).toBeCloseTo(r.min, 12);   // a bare params object resolves its base
      }
      console.log(`[body-v2 ${base}] slider ranges (generator values) + max displacement:\n  ${rows.join('\n  ')}`);
    });

    it('every per-base range end is a clean manifold with the base topology (the bake also checks indices + weights per key)', () => {
      const b0 = generateBodyV2(asset.params);
      expect(manifoldDefects(b0)).toBe(0);
      for (const d of BODY_V2_SLIDERS) for (const v of [d.range[base].min, d.range[base].max]) {
        const r = generateBodyV2({ ...asset.params, [d.name]: v } as BodyV2GenParams);
        expect(manifoldDefects(r), `${d.name} ${v}`).toBe(0);
        expect(Buffer.from(r.geometry.indices.buffer).equals(Buffer.from(b0.geometry.indices.buffer)), `${d.name} ${v}`).toBe(true);
      }
    }, 120000);
  });
}

describe('body-v2@3 — determinism, one representation, async, cache', () => {
  /** The generator outputs of one bake, recorded so the async tests replay them (no second 140-run bake). */
  const recorded = new Map<string, BodyV2GenResult>();
  const replay = (p: BodyV2GenParams): BodyV2GenResult => {
    const k = JSON.stringify(p), r = recorded.get(k);
    if (!r) throw new Error(`not recorded: ${k}`);
    return r;
  };
  const sameAsset = (a: BodyV2Asset, b: BodyV2Asset) => {
    expect(bodyV2Fingerprint(b)).toEqual(bodyV2Fingerprint(a));
    expect(Buffer.from(b.vertices.buffer).equals(Buffer.from(a.vertices.buffer))).toBe(true);
    expect(b.shapes.length).toBe(a.shapes.length);
    for (let s = 0; s < a.shapes.length; s++) {
      expect(b.shapes[s].name).toBe(a.shapes[s].name);
      expect(Buffer.from(b.shapes[s].idx.buffer).equals(Buffer.from(a.shapes[s].idx.buffer))).toBe(true);
      expect(Buffer.from(b.shapes[s].dense.buffer).equals(Buffer.from(a.shapes[s].dense.buffer))).toBe(true);
    }
  };

  it('a re-bake is byte-identical (generator runs, shapes and bake cost reported)', () => {
    let runs = 0;
    const t0 = performance.now();
    const a = getBodyV2Asset('fem'), b = bakeBodyV2('fem', (p) => { runs++; const r = generateBodyV2(p); recorded.set(JSON.stringify(p), r); return r; });
    const ms = performance.now() - t0;
    const bytes = bodyV2DeltaBytes(b);
    console.log(`[body-v2] bake: ${runs} generator runs, ${b.shapes.length} shapes (${b.correctives.length} corrective shapes over ${BODY_V2_CORRECTIVES.length} terms), ${b.vertexCount} verts, ~${Math.round(ms)} ms (informational)`);
    expect(runs).toBe(b.shapes.length + 1);
    sameAsset(a, b);
  }, 120000);

  it('the time-sliced async bake (default MessageChannel hand-back, and a custom yieldFn) is byte-identical to the sync bake', async () => {
    const a = getBodyV2Asset('fem');
    sameAsset(a, await bakeBodyV2Async('fem', replay));   // the default yielder (a MessageChannel task in node and browsers)
    let yields = 0;
    sameAsset(a, await bakeBodyV2Async('fem', replay, async () => { yields++; }));
    expect(yields).toBe(a.shapes.length + 1);   // the thread is handed back after EVERY generator run
  });

  it('each shape is held ONCE: the dense array Mesh3D takes (no copy), its support = idx, evaluated bit-identically', () => {
    const rows: string[] = [];
    for (const base of BASES) {
      const a = getBodyV2Asset(base), by = bodyV2DeltaBytes(a);
      rows.push(`${base}: ${a.shapes.length} shapes, resident ${(by.resident / 1e6).toFixed(2)} MB (dense ${(by.dense / 1e6).toFixed(2)} + support ${(by.support / 1e6).toFixed(2)}); the same shapes stored sparse: ${(by.sparse / 1e6).toFixed(2)} MB`);
      for (let s = 0; s < a.shapes.length; s++) {
        const sh = a.shapes[s];
        expect(denseShapeDelta(a, s)).toBe(sh.dense);   // the asset's own array: shared by every character, never copied
        expect(sh.dense.length).toBe(a.vertexCount * 6);
        expect(Buffer.from(blendSupport(sh.dense, a.vertexCount).idx.buffer).equals(Buffer.from(sh.idx.buffer)), sh.name).toBe(true);
      }
    }
    console.log(`[body-v2] shape memory (per base, shared by all its characters):\n  ${rows.join('\n  ')}`);
    // The engine's evaluation of the shared arrays == the asset's CPU evaluation, bit for bit.
    const a = getBodyV2Asset('masc'), w = bodyV2Weights(a, { bust: 0.6, legLength: -0.4, torsoThick: 0.3, hipWidth: -0.7, limbThick: 0.8 });
    const mesh = new Mesh3D({ maxGlobalZIndex: 0 } as unknown as InteractionService, 0, 0, 0, { primitive: 'custom', geometry: { vertices: new Float32Array(a.vertices), indices: a.indices, format: '12float' } });
    mesh.baseVertices = new Float32Array(a.vertices);
    mesh.blendShapes = a.shapes.map((s, i) => ({ name: s.name, deltaVertices: denseShapeDelta(a, i) }));
    mesh.blendWeights = w;
    mesh.evaluateBlendShapes();
    expect(Buffer.from(mesh.geometry.vertices.buffer).equals(Buffer.from(bodyV2Vertices(a, w).buffer))).toBe(true);
  });

  it('a generator change that breaks constant topology / weights at any key fails the bake loudly', () => {
    let n = 0;
    const brokenIdx = (p: BodyV2GenParams): BodyV2GenResult => {
      const r = generateBodyV2(p);
      if (n++ !== 5) return r;
      const idx = new Uint32Array(r.geometry.indices); [idx[0], idx[1]] = [idx[1], idx[0]];
      return { ...r, geometry: { ...r.geometry, indices: idx } };
    };
    expect(() => bakeBodyV2('masc', brokenIdx)).toThrow(/topology changed/);
    n = 0;
    const brokenW = (p: BodyV2GenParams): BodyV2GenResult => {
      const r = generateBodyV2(p);
      if (n++ !== 3) return r;
      const w = new Float32Array(r.skinning.jointWeights); w[0] -= 0.01; w[1] += 0.01;
      return { ...r, skinning: { ...r.skinning, jointWeights: w } };
    };
    expect(() => bakeBodyV2('masc', brokenW)).toThrow(/skin weights changed/);
  });

  it('the asset cache: a FAILED async bake is not cached (the next call retries); one asset object per base', async () => {
    const fem = getBodyV2Asset('fem');
    let calls = 0;
    const c1 = new BodyV2AssetCache(() => fem, async () => { calls++; if (calls === 1) throw new Error('transient'); return fem; });
    await expect(c1.getAsync('fem')).rejects.toThrow('transient');
    expect(await c1.getAsync('fem')).toBe(fem);   // retried, not the cached rejection
    expect(calls).toBe(2);
    expect(await c1.getAsync('fem')).toBe(fem);   // cached now
    expect(calls).toBe(2);
    // A sync bake landing while an async one is pending wins; the async call resolves to that same object.
    const other = { ...fem } as BodyV2Asset;
    let release!: () => void;
    const c2 = new BodyV2AssetCache(() => fem, () => new Promise<BodyV2Asset>((res) => { release = () => res(other); }));
    const p = c2.getAsync('fem');
    expect(c2.get('fem')).toBe(fem);
    release();
    expect(await p).toBe(fem);
    expect(c2.get('fem')).toBe(fem);
  });
});

// ── Slider values from callers + the runtime manager (fake host, real scene nodes) ───────────────────────────────
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
function fakeHost(root: MeshGroup3D): CharacterV2Host {
  return {
    createRigged: async (r, x, y, z, _name, opts) => {
      const skeleton = opts?.skeleton ?? skeletonFromResult(r);
      const mesh = new SkinnedMesh3D(isvc, x, y, z, { primitive: 'custom', geometry: r.geometry });
      mesh.skeleton = skeleton; mesh.skeletonId = skeleton.id;
      mesh.jointIndices = r.skinning.jointIndices.slice(); mesh.jointWeights = r.skinning.jointWeights.slice();
      root.addChild(skeleton); root.addChild(mesh);
      return { mesh, skeleton };
    },
    createMarker: (name) => { const g = new MeshGroup3D(isvc); g.name = name; g.thinWrapper = true; g.documentSkipChildren = true; root.addChild(g); return g; },
    removeMarker: (g) => root.removeChild(g),
    removeCharacter: (m, s) => { root.removeChild(m); root.removeChild(s); },
    getRootMeshGroups: () => root.children.filter((c): c is MeshGroup3D => c instanceof MeshGroup3D),
    sceneMetresPerUnit: () => null,
    requestRender: () => {},
  };
}

describe('body-v2@3 — slider values are validated, never silently reset', () => {
  it('coerceBodyV2Slider / cleanBodyV2Sliders / editBodyV2Sliders', () => {
    expect(coerceBodyV2Slider(Infinity)).toBe(1);
    expect(coerceBodyV2Slider(-Infinity)).toBe(-1);
    expect(coerceBodyV2Slider(5)).toBe(1);
    expect(coerceBodyV2Slider('0.5')).toBe(0.5);
    for (const bad of [NaN, '', '  ', 'abc', null, undefined, {}, [], true]) expect(coerceBodyV2Slider(bad), String(bad)).toBeNull();
    expect(cleanBodyV2Sliders({ bust: NaN, waist: 0.5, nope: 1, height: Infinity, legLength: 0 })).toEqual({ waist: 0.5, height: 1 });
    expect(cleanBodyV2Sliders(null)).toEqual({});
    const cur: BodyV2Sliders = { bust: 0.8, waist: -0.3 };
    expect(editBodyV2Sliders(cur, { bust: NaN, waist: 0.3 })).toBeNull();   // atomic: nothing applied
    expect(editBodyV2Sliders(cur, { nope: 0.3 })).toBeNull();
    expect(editBodyV2Sliders(cur, JSON.parse(JSON.stringify({ bust: Infinity })))).toBeNull();   // JSON turns Infinity into null
    expect(editBodyV2Sliders(cur, { bust: Infinity })).toEqual({ bust: 1, waist: -0.3 });
    expect(editBodyV2Sliders(cur, { waist: 0 })).toEqual({ bust: 0.8 });
    expect(editBodyV2Sliders(cur, { legLength: 0.25 }, true)).toEqual({ legLength: 0.25 });
    expect(cur).toEqual({ bust: 0.8, waist: -0.3 });
  });

  it('the manager: ±Infinity clamps, NaN / null / garbage return false and keep the value (the marker too)', async () => {
    const root = new MeshGroup3D(isvc);
    const mgr = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    const h = await mgr.create({ base: 'fem', sliders: { bust: 0.8, waist: -0.3 } });
    const marker = () => (root.children.find((c) => (c as { id?: string }).id === h.markerId) as MeshGroup3D).worldParams as CharacterV2Marker;
    const set = (v: unknown) => mgr.setSlider(h.rootId, 'bust', v as number);
    expect(set(NaN)).toBe(false);
    expect(set(null)).toBe(false);
    expect(set(undefined)).toBe(false);
    expect(mgr.setSliders(h.rootId, { bust: NaN, waist: 0.3 } as BodyV2Sliders)).toBe(false);
    expect(mgr.setSliders(h.rootId, { nope: 0.3 } as unknown as BodyV2Sliders)).toBe(false);
    expect(mgr.getSliders(h.rootId)).toEqual({ bust: 0.8, waist: -0.3 });
    expect(marker().sliders).toEqual({ bust: 0.8, waist: -0.3 });
    expect(set(Infinity)).toBe(true);
    expect(mgr.getSliders(h.rootId)).toEqual({ bust: 1, waist: -0.3 });
    expect(set('0.5')).toBe(true);
    expect(mgr.setSlider(h.rootId, 'height', -Infinity)).toBe(true);
    expect(mgr.getSliders(h.rootId)).toEqual({ bust: 0.5, waist: -0.3, height: -1 });
    expect(marker().sliders).toEqual({ bust: 0.5, waist: -0.3, height: -1 });
    const sw = mgr.sliderDefs('masc').find((d) => d.name === 'shoulderWidth')!;   // per base, 0 = the base, symmetric
    expect(sw.base).toBe(BODY_V2_BASES.masc.shoulderWidth);
    expect(sw.max - sw.base).toBeCloseTo(sw.base - sw.min, 12);
    expect(sw.min).not.toBe(mgr.sliderDefs('fem').find((d) => d.name === 'shoulderWidth')!.min);
  });
});

describe('body-v2@3 — save migration + v1 untouched', () => {
  it('body-v2@1 / pre-review body-v2@2 saves: the soles of the asset that wrote them (the restore keeps the feet; measured)', async () => {
    const rows: string[] = [];
    for (const base of BASES) for (const s of [{}, { legLength: -0.3 }, { legLength: 0.6, height: 0.5 }] as BodyV2Sliders[]) {
      const a = getBodyV2Asset(base), now = minY(bodyV2Vertices(a, bodyV2Weights(a, s)));
      const v1 = (await bodyV2LegacySoleY('body-v2@1', base, s))!, v2 = (await bodyV2LegacySoleY('body-v2@2', base, s))!;
      // the v1 generator's own soles at the v2@1 params (independent of the helper's range code at default sliders)
      if (!Object.keys(s).length) expect(v1).toBe(minY(generateBodyResult({ ...BODY_V2_AT1_BASES[base] }).geometry.vertices));
      rows.push(`${base} ${JSON.stringify(s).padEnd(32)} soles v2@1 ${v1.toFixed(4)} · v2@2 ${v2.toFixed(4)} · v2@3 ${now.toFixed(4)} → reusing the origin put the feet ${((now - v1) * 1000).toFixed(1)} / ${((now - v2) * 1000).toFixed(1)} mm off (now 0)`);
    }
    expect(await bodyV2LegacySoleY('body-v9@1', 'fem', {})).toBeNull();
    expect(await bodyV2LegacySoleY(BODY_V2_ASSET, 'fem', {})).toBeNull();   // v2@3 writes the soles origin (marker v 2)
    console.log(`[body-v2] migration (mesh units = m, before the height / city node scale):\n  ${rows.join('\n  ')}`);
  });

  it("pre-review body-v2@2 soles = that generator's own lowest vertex (pinned outputs of the 2026-10-05 generator, exact to float32)", async () => {
    // [base, sliders, minY of the PRE-REVIEW body-v2@2 generator at its bases + the old absolute ranges] — computed once
    // from that generator (the integration scratch, 2026-10-06); only legLength / limbThick reach the soles. The
    // CURRENT generator differs here by 0.2–15.7 mm (what the helper used before the integration fix).
    const PINNED: [BodyV2Base, BodyV2Sliders, number][] = [
      ['fem', {}, -0.29282858967781067],
      ['fem', { legLength: -0.3 }, -0.2298285961151123],
      ['fem', { legLength: 0.6, limbThick: -0.5, height: 0.4 }, -0.43949803709983826],
      ['fem', { legLength: -1, limbThick: 1, torsoLength: 1, hipWidth: -1 }, -0.10238149762153625],
      ['masc', {}, -0.3667052090167999],
      ['masc', { legLength: -0.3 }, -0.28354519605636597],
      ['masc', { legLength: 0.6, limbThick: 0.8, height: 0.5 }, -0.4878862500190735],
      ['masc', { torsoLength: 1, headSize: 1, bust: 1, shoulderWidth: -1, torsoThick: 1 }, -0.3667052090167999],
    ];
    for (const [base, s, want] of PINNED) {
      const got = (await bodyV2LegacySoleY('body-v2@2', base, s))!;
      expect(Math.abs(got - want), `${base} ${JSON.stringify(s)}`).toBeLessThan(2e-7);
      if (!Object.keys(s).length) {   // the reviewed generator really moved the soles (fem 6.6 mm, masc 2.8 mm at the bases)
        const cur = minY(generateBodyV2(BODY_V2_BASES[base]).geometry.vertices);
        expect(Math.abs(cur - want) * 1000, `${base}: v2@3 vs pre-review v2@2 soles (mm)`).toBeGreaterThan(1);
      }
    }
  });

  it('restore keeps the FEET where they stood: a same-asset round trip is exact; an old marker (origin at the hips + soleY) re-anchors', async () => {
    const root = new MeshGroup3D(isvc);
    const mgr = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    const h = await mgr.create({ base: 'masc', position: [3, 0.5, -1], sliders: { legLength: 0.4 } });
    const mesh = root.children.find((c) => (c as { id?: string }).id === h.rootId) as SkinnedMesh3D;
    mesh.setRotation3D(0.2, 1.1, -0.1);
    const saved = JSON.parse(JSON.stringify((root.children.find((c) => (c as { id?: string }).id === h.markerId) as MeshGroup3D).worldParams)) as CharacterV2Marker;
    const restore = async (wp: CharacterV2Marker) => {
      const r2 = new MeshGroup3D(isvc), g = new MeshGroup3D(isvc); g.thinWrapper = true; g.documentSkipChildren = true; g.worldParams = wp; r2.addChild(g);
      const m2 = new CharacterV2Manager(fakeHost(r2), { consoleHandle: false });
      expect(await m2.restoreFromSave()).toBe(1);
      return r2.children.find((c) => c instanceof SkinnedMesh3D) as SkinnedMesh3D;
    };
    const solesWorld = (m: SkinnedMesh3D) => { const M = m.localMatrix, V = m.geometry.vertices; let lo = Infinity; for (let i = 1; i < V.length; i += 12) lo = Math.min(lo, V[i]); return [M[4] * lo + M[12], M[5] * lo + M[13], M[6] * lo + M[14]]; };
    const same = await restore(saved);
    expect([same.x, same.y, same.z, same.rotationX, same.rotationY, same.rotation, same.scaleY]).toEqual([mesh.x, mesh.y, mesh.z, mesh.rotationX, mesh.rotationY, mesh.rotation, mesh.scaleY]);
    // A marker from before the soles origin: x/y/z = the origin at the saving asset's hips, its soles soleY below (here
    // 0.37 — a different asset than the current one): the FEET land where they stood.
    const want = solesWorld(mesh), M = mesh.localMatrix, soleY = -0.37;
    const legacy = { ...saved, v: undefined, rig: undefined, transform: { ...saved.transform, x: want[0] - M[4] * soleY, y: want[1] - M[5] * soleY, z: want[2] - M[6] * soleY, soleY } };
    const got = solesWorld(await restore(legacy as unknown as CharacterV2Marker));
    for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k], 5);   // float32 node transform
  });

  it('v1 bodies are byte-identical before and after baking / evaluating v2 (no shared generator state)', () => {
    const sets = [{}, { ...NEW_BODY_DEFAULTS }, { ...NEW_BODY_DEFAULTS, torsoThick: 1.3, hipWidth: 1.2 }, { ...DEFAULT_BODY_PARAMS, legLength: 1.1, bust: 1.6 }];
    const snap = (p: object) => { const r = generateBodyResult(p); return [r.geometry.vertices, r.geometry.indices, r.skinning.jointIndices, r.skinning.jointWeights, r.skinning.inverseBindMatrices].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)); };
    const before = sets.map(snap);
    const asset = getBodyV2Asset('masc');
    bodyV2Vertices(asset, bodyV2Weights(asset, { torsoThick: 1, legLength: -1 }));
    generateBodyV2(BODY_V2_BASES.fem);
    const after = sets.map(snap);
    for (let i = 0; i < sets.length; i++) for (let k = 0; k < before[i].length; k++) expect(after[i][k].equals(before[i][k]), `set ${i} array ${k}`).toBe(true);
    // The v2 asset never hands out the generator's own arrays (a mutation of the asset can't reach v1 output).
    expect(asset.vertices.buffer).not.toBe(generateBodyResult(asset.params).geometry.vertices.buffer);
  });
});

