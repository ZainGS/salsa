/**
 * Character v2 MVP gates (docs/specs/character-v2.md Phase 1, item 7) on the real scene nodes (SkinnedMesh3D /
 * Skeleton3D / MeshGroup3D) with a fake host:
 *   • a slider drag never regenerates (generator spy = 0 calls; same index buffer object + content);
 *   • the live mesh + skeleton match the generator (rest ≤ 3 mm; posed in a Walk frame — reported);
 *   • the default gait clips bind on the v2 skeleton (same 20 joint names as v1);
 *   • save / load round-trips through the marker (JSON), a deleted body is not respawned.
 * Plus the body-v2@2 review fixes, group G4 (runtime integration — docs/specs/character-v2.md "body-v2@2 review fixes,
 * G4"): stable ids + per-body state across reloads, feet-origin body (no slider ever writes the node transform),
 * mid-Play sliders, duplicate / delete as whole characters, the shared character-body predicate, idempotent +
 * cancellable restores, runtime-state cleanup, IK in the character's frame, no second CPU evaluation per slider, added
 * joints, other blend shapes on the body — the second half on the REAL Scene3DManager (the play-auto-player stub ctx).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as { self?: unknown; crypto?: unknown; requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
(_g.self as { crypto?: unknown }).crypto ??= webcrypto;
_g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16);
_g.cancelAnimationFrame ??= (h: ReturnType<typeof setTimeout>) => clearTimeout(h);

vi.mock('./body-v2-generator', async (orig) => {
  const m = await orig<typeof import('./body-v2-generator')>();
  return { ...m, generateBodyV2: vi.fn(m.generateBodyV2) };
});
vi.mock('../services/managers/body-generator', async (orig) => {
  const m = await orig<typeof import('../services/managers/body-generator')>();
  return { ...m, generateBodyResult: vi.fn(m.generateBodyResult) };
});
vi.mock('./body-v2-asset', async (orig) => {
  const m = await orig<typeof import('./body-v2-asset')>();
  return { ...m, bodyV2Vertices: vi.fn(m.bodyV2Vertices) };
});

import * as gen from './body-v2-generator';
import * as v1gen from '../services/managers/body-generator';
import * as assetMod from './body-v2-asset';
import { SkinnedMesh3D } from '../scene-graph/shapes/skinned-mesh-3d';
import { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import { Skeleton3D } from '../scene-graph/shapes/skeleton-3d';
import type { InteractionService } from '../services/interaction-service';
import { CharacterV2Manager, skeletonFromResult, CHARACTER_V2_KIND, CHARACTER_V2_LIFT_SHAPE, type CharacterV2Host, type CharacterV2Marker } from './character-v2';
import { scene3dCharacterV2Host } from './scene3d-host';
import { BODY_V2_ASSET, sliderParams, bodyV2Weights, bodyV2Vertices, bodyV2JointLocal, heightScale, bodyV2LegacySoleY } from './body-v2-asset';
import { buildLocomotionClips, DEFAULT_LOCOMOTION_CLIP_NAMES } from '../services/managers/default-locomotion';
import { buildDefaultClips, DEFAULT_CLIP_NAMES } from '../services/managers/default-animations';
import { skinAll } from '../services/managers/clothing-audit-harness';
import { sampleClipPose } from '../renderer/3d/skeleton-animator';
import type { SkinnedMeshData, PoseRotations } from '../services/managers/skin-deform-metrics';
import { Scene3DManager } from '../services/managers/scene3d-manager';
import { Camera3D } from '../renderer/3d/camera-3d';
import { Node } from '../scene-graph/shapes/base/node';
import { mat4 } from 'gl-matrix';

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const maxDiff = (a: Float32Array, b: Float32Array): number => { let e = a.length === b.length ? 0 : Infinity; for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e; };
const find = (root: MeshGroup3D | Node, id: string): unknown => root.children.find((c) => (c as { id?: string }).id === id);
const minYv = (v: Float32Array): number => { let lo = Infinity; for (let i = 1; i < v.length; i += 12) lo = Math.min(lo, v[i]); return lo; };
/** The asset's evaluation + the runtime lift (what the live v2 mesh holds: the soles at mesh y = 0). */
const lifted = (v: Float32Array, lift: number): Float32Array => { const o = new Float32Array(v); for (let i = 1; i < o.length; i += 12) o[i] += lift; return o; };
/** World Y of the rest soles (the node origin is the soles; rotation about Y only in these tests). */
const solesY = (m: SkinnedMesh3D): number => m.y + minYv(m.geometry.vertices) * m.scaleY;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000): Promise<void> { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await wait(20); }

function fakeHost(root: MeshGroup3D, o: { mpu?: number | null; undo?: { description: string; undo(): void; redo(): void }[] } = {}): CharacterV2Host {
  const byId = (id: string) => { let f = false; root.forEachDeep((n: Node & { id?: string }) => { if (n.id === id) f = true; }); return f; };
  return {
    createRigged: async (r, x, y, z, _name, opts) => {
      const skeleton = opts.skeleton;
      const mesh = new SkinnedMesh3D(isvc, x, y, z, { primitive: 'custom', geometry: r.geometry });
      if (opts.meshId) mesh.setId(opts.meshId);
      mesh.skeleton = skeleton; mesh.skeletonId = skeleton.id;
      mesh.jointIndices = r.skinning.jointIndices.slice(); mesh.jointWeights = r.skinning.jointWeights.slice();
      root.addChild(skeleton); root.addChild(mesh);
      return { mesh, skeleton };
    },
    createMarker: (name) => { const g = new MeshGroup3D(isvc); g.name = name; g.thinWrapper = true; g.documentSkipChildren = true; root.addChild(g); return g; },
    removeMarker: (g) => root.removeChild(g),
    removeCharacter: (m, s) => { m.parent?.removeChild(m); s.parent?.removeChild(s); },
    getRootMeshGroups: () => root.children.filter((c): c is MeshGroup3D => c instanceof MeshGroup3D),
    isIdTaken: (id) => byId(id),
    sceneMetresPerUnit: () => o.mpu ?? null,
    requestRender: () => {},
    ...(o.undo ? { pushUndo: (c: { description: string; undo(): void; redo(): void }) => { o.undo!.push(c); }, undoTop: () => o.undo![o.undo!.length - 1]?.description ?? null } : {}),
  };
}

/** A marker group as the serializer's '3DMeshGroup' proceduralContent restore recreates it. */
function markerFrom(saved: { id?: string; name?: string; worldParams?: unknown }, svc: unknown = isvc): MeshGroup3D {
  const g = new MeshGroup3D(svc as InteractionService);
  if (saved.id) g.setId(saved.id);
  g.name = saved.name ?? 'Character (v2 save)'; g.thinWrapper = true; g.documentSkipChildren = true; g.worldParams = saved.worldParams;
  return g;
}
const saveMarker = (g: MeshGroup3D) => JSON.parse(JSON.stringify(g.toJSON()));

/** Rest positions of the live mesh (what the blend engine wrote, minus the runtime lift) vs the generator, mm. */
function restErrMm(mesh: SkinnedMesh3D, params: gen.BodyV2GenParams, lift: number): number {
  const V = mesh.geometry.vertices, R = gen.generateBodyV2(params).geometry.vertices;
  let e = 0;
  for (let i = 0; i < V.length / 12; i++) e = Math.max(e, Math.hypot(V[i * 12] - R[i * 12], V[i * 12 + 1] - lift - R[i * 12 + 1], V[i * 12 + 2] - R[i * 12 + 2]));
  return e * 1000;
}

describe('Character v2 MVP', () => {
  const root = new MeshGroup3D(isvc);
  const mgr = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
  let id = '';
  beforeAll(async () => { id = (await mgr.create({ position: [2, 0, -1] })).rootId; });

  it('creates the versioned frozen body on the v1 20-joint skeleton, soles on the requested point (= the node origin)', () => {
    const h = mgr.toHandle(id)!;
    expect(h.kind).toBe('v2');
    expect(h.partIds).toEqual([id]);
    const mesh = find(root, id) as SkinnedMesh3D;
    expect(mesh.geometry.vertices.length / 12).toBe(gen.generateBodyV2(mgr.getAsset(id)!.params).geometry.vertices.length / 12);
    expect(mesh.blendShapes.length).toBe(mgr.getAsset(id)!.shapes.length + 1);   // + the runtime lift
    expect(mesh.blendShapes[mesh.blendShapes.length - 1].name).toBe(CHARACTER_V2_LIFT_SHAPE);
    expect(mesh.skeleton!.data.joints.map((j) => j.name)).toEqual(v1gen.generateBodyResult({}).skinning.jointNames);   // v1's 20-joint skeleton
    expect(minYv(mesh.geometry.vertices)).toBeCloseTo(0, 6);   // feet-origin body
    expect(solesY(mesh)).toBeCloseTo(0, 6);
    expect([mesh.x, mesh.y, mesh.z]).toEqual([2, 0, -1]);
  });

  it('a slider drag never calls the generator, never re-evaluates on the CPU, never changes the topology, never moves the node', () => {
    const mesh = find(root, id) as SkinnedMesh3D;
    const idx = mesh.geometry.indices, idxCopy = new Uint32Array(idx), n = mesh.geometry.vertices.length;
    const spy = vi.mocked(gen.generateBodyV2), spy1 = vi.mocked(v1gen.generateBodyResult), spyEval = vi.mocked(assetMod.bodyV2Vertices);
    spy.mockClear(); spy1.mockClear(); spyEval.mockClear();
    const v0 = mesh.blendVersion, y0 = mesh.y;
    for (let step = 0; step <= 40; step++) {
      const x = -1 + step / 20;
      mgr.setSlider(id, 'waist', x); mgr.setSlider(id, 'legLength', -x); mgr.setSlider(id, 'torsoThick', x * 0.7);
      mgr.setSlider(id, 'shoulderWidth', x); mgr.setSlider(id, 'height', x * 0.5);
      expect(minYv(mesh.geometry.vertices)).toBeCloseTo(0, 5);   // the lift keeps the soles at the origin
    }
    expect(spy).not.toHaveBeenCalled();
    expect(spy1).not.toHaveBeenCalled();
    expect(spyEval).not.toHaveBeenCalled();   // review runtime#9: the soles come from the live vertices (no 194 KB re-evaluation)
    expect(mesh.y).toBe(y0);                  // review runtime#2: a shape / proportion slider never writes the node transform
    expect(mesh.blendVersion).toBeGreaterThan(v0);   // went through the blend-shape engine (fast path: blendVersion → in-place GPU range update)
    expect(mesh.geometry.indices).toBe(idx);
    expect(Buffer.from(mesh.geometry.indices.buffer).equals(Buffer.from(idxCopy.buffer))).toBe(true);
    expect(mesh.geometry.vertices.length).toBe(n);
    mgr.setSliders(id, {}, true);
  });

  it('the live mesh + skeleton match the generator (rest ≤ 3 mm; inverse binds = the new rest; walk frame reported)', () => {
    const mesh = find(root, id) as SkinnedMesh3D;
    const sk = mesh.skeleton!;
    const rows: string[] = [];
    for (const s of [{ legLength: 0.7, waist: -0.5 }, { torsoThick: 0.6, shoulderWidth: 0.7, limbThick: -0.4 }, { torsoLength: -0.8, bust: 0.9, hipWidth: 0.5 }]) {
      mgr.setSliders(id, s, true);
      const p = sliderParams(mgr.getAsset(id)!.params, s);
      const lift = mgr.getLift(id)!;
      const rest = restErrMm(mesh, p, lift);
      // Rest pose: every skin matrix = the object transform (world × inverseBind = objectTransform).
      sk.computeWorldMatrices();
      let ibErr = 0;
      for (const j of sk.data.joints) {
        const m = mat4.multiply(mat4.create(), j.worldMatrix as unknown as mat4, j.inverseBindMatrix as unknown as mat4);
        for (let k = 0; k < 16; k++) ibErr = Math.max(ibErr, Math.abs(m[k] - sk.objectTransform[k]));
      }
      // Posed: the v2 body (blend + bone offsets + the lift, the BASE's weights) vs the generator's own body, Walk
      // frame 8 — the lift is a uniform translation of the vertices AND the root joint, so the posed bodies differ by
      // exactly (0, lift, 0).
      const r = gen.generateBodyV2(p);
      const md = (verts: Float32Array, jl: Float32Array, ibm: Float32Array): SkinnedMeshData => ({
        vertices: verts, stride: 12, posOffset: 0, indices: r.geometry.indices, jointIndices: mesh.jointIndices, jointWeights: mesh.jointWeights,
        jointNames: r.skinning.jointNames, jointParents: r.skinning.jointParents!, jointLocalPositions: jl, inverseBindMatrices: ibm,
      });
      const jl = new Float32Array(sk.data.joints.flatMap((j) => j.localPosition));
      const ibm = new Float32Array(sk.data.joints.flatMap((j) => Array.from(j.inverseBindMatrix)));
      const walk = buildLocomotionClips(sk.data.joints).find((c) => c.name === 'Walk')!;
      const bind = { rotations: sk.data.joints.map(() => [0, 0, 0, 1] as [number, number, number, number]), positions: sk.data.joints.map((j) => [...j.localPosition] as [number, number, number]), scales: sk.data.joints.map(() => [1, 1, 1] as [number, number, number]) };
      const sp = sampleClipPose(walk, bind, 8);
      const pose: PoseRotations = sk.data.joints.map((j, i) => ({ joint: j.name, q: sp.rotations[i] }));
      const a = skinAll(md(mesh.geometry.vertices, jl, ibm), mesh.geometry.vertices, mesh.jointIndices, mesh.jointWeights, pose, 'dualQuat').P;
      const ref = { ...md(r.geometry.vertices, r.skinning.jointLocalPositions!, r.skinning.inverseBindMatrices), jointIndices: r.skinning.jointIndices, jointWeights: r.skinning.jointWeights };
      const b = skinAll(ref, r.geometry.vertices, r.skinning.jointIndices, r.skinning.jointWeights, pose, 'dualQuat').P;
      let posed = 0;
      for (let i = 0; i < a.length / 3; i++) posed = Math.max(posed, Math.hypot(a[i * 3] - b[i * 3], a[i * 3 + 1] - lift - b[i * 3 + 1], a[i * 3 + 2] - b[i * 3 + 2]));
      rows.push(`${JSON.stringify(s).padEnd(58)} rest ${rest.toFixed(2)} mm  walk-f8 ${(posed * 1000).toFixed(2)} mm  ibm ${ibErr.toExponential(1)}  lift ${lift.toFixed(4)}`);
      expect(rest).toBeLessThanOrEqual(3.5);   // 3-slider combos (single sliders are gated at 3 mm in body-v2-asset.test)
      expect(ibErr).toBeLessThan(1e-5);
      expect(posed * 1000).toBeLessThanOrEqual(15);   // the base's weights vs the generator's own (hip smoothing reads positions)
    }
    console.log(`[character-v2] live mesh vs generator:\n  ${rows.join('\n  ')}`);
    mgr.setSliders(id, {}, true);
  });

  it('the default gait + idle clips bind on the v2 skeleton (also after a proportion change)', () => {
    const mesh = find(root, id) as SkinnedMesh3D;
    const joints = mesh.skeleton!.data.joints;
    const clips = buildLocomotionClips(joints);
    expect(clips.map((c) => c.name)).toEqual(DEFAULT_LOCOMOTION_CLIP_NAMES);
    for (const c of clips) for (const t of c.tracks) expect(joints[t.jointIndex]).toBeTruthy();
    expect(buildDefaultClips(joints).length).toBeGreaterThan(0);
    const walk0 = clips.find((c) => c.name === 'Walk')!.groundSpeed!;
    mgr.setSlider(id, 'legLength', 1);
    const walk1 = buildLocomotionClips(joints).find((c) => c.name === 'Walk')!.groundSpeed!;
    expect(walk1).toBeGreaterThan(walk0);   // longer legs → the rig measures longer → a longer stride
    mgr.setSlider(id, 'legLength', 0);
  });

  it('save / load round-trips through the marker (JSON): same ids, same body; a deleted body is not respawned', async () => {
    mgr.setSliders(id, { waist: -0.6, legLength: 0.4, height: 0.5, headShape: -0.3 }, true);
    const mesh = find(root, id) as SkinnedMesh3D;
    mesh.setRotation3D(0, 0.7, 0);
    const markerNode = find(root, mgr.toHandle(id)!.markerId!) as MeshGroup3D;
    const saved = saveMarker(markerNode);
    const wp = saved.worldParams as CharacterV2Marker;
    expect(saved.proceduralContent).toBe(true);
    expect(saved.children).toEqual([]);
    expect(wp.kind).toBe(CHARACTER_V2_KIND);
    expect(wp.v).toBe(2);
    expect(wp.asset).toBe(BODY_V2_ASSET);
    expect(wp.sliders).toEqual({ waist: -0.6, legLength: 0.4, height: 0.5, headShape: -0.3 });
    expect([wp.meshId, wp.skeletonId]).toEqual([id, mesh.skeleton!.id]);
    const bytes = JSON.stringify(wp).length;
    expect(bytes).toBeLessThan(16_000);   // a few KB (the rig without its default clips / poses / derived inverse binds)
    // A fresh document: the serializer's '3DMeshGroup' proceduralContent restore, then the manager rebuilds.
    const root2 = new MeshGroup3D(isvc);
    const g = markerFrom(saved);
    root2.addChild(g);
    const mgr2 = new CharacterV2Manager(fakeHost(root2), { consoleHandle: false });
    expect(await mgr2.restoreFromSave()).toBe(1);
    const h2 = mgr2.list()[0];
    expect([h2.rootId, h2.skeletonId, h2.markerId]).toEqual([id, mesh.skeleton!.id, markerNode.id]);   // review runtime#1: stable ids
    const mesh2 = find(root2, h2.rootId) as SkinnedMesh3D;
    expect(mgr2.getSliders(h2.rootId)).toEqual(mgr.getSliders(id));
    expect(maxDiff(mesh2.geometry.vertices, mesh.geometry.vertices)).toBeLessThan(1e-5);   // incremental blend path (≤ ~1e-6 drift) vs a fresh full one
    expect([mesh2.x, mesh2.y, mesh2.z, mesh2.rotationY, mesh2.scaleY]).toEqual([mesh.x, mesh.y, mesh.z, mesh.rotationY, mesh.scaleY]);
    expect(maxDiff(new Float32Array(mesh2.skeleton!.data.joints.flatMap((j) => j.localPosition)), new Float32Array(mesh.skeleton!.data.joints.flatMap((j) => j.localPosition)))).toBeLessThan(1e-6);
    expect(mesh.scaleY).toBeCloseTo(heightScale(0.5), 9);
    // Re-saving the restored marker is stable; the body + skeleton never save themselves.
    expect(saveMarker(g).worldParams).toEqual(wp);
    expect(mesh2.excludeFromDocument && mesh2.skeleton!.excludeFromDocument).toBe(true);
    // A second reload keeps the same ids again.
    const root3 = new MeshGroup3D(isvc); root3.addChild(markerFrom(saveMarker(g)));
    const mgr3 = new CharacterV2Manager(fakeHost(root3), { consoleHandle: false });
    expect(await mgr3.restoreFromSave()).toBe(1);
    expect(mgr3.list()[0].rootId).toBe(id);
    // Delete → the marker says removed → the next load drops it.
    mgr2.remove(h2.rootId);
    const root4 = new MeshGroup3D(isvc);
    const g4 = new MeshGroup3D(isvc); g4.worldParams = { ...wp, removed: true }; root4.addChild(g4);
    const mgr4 = new CharacterV2Manager(fakeHost(root4), { consoleHandle: false });
    expect(await mgr4.restoreFromSave()).toBe(0);
    expect(root4.children.length).toBe(0);
    // the CPU evaluation the restore relies on is the same arithmetic as the mesh's (+ the lift)
    const a = mgr.getAsset(id)!;
    expect(maxDiff(lifted(bodyV2Vertices(a, bodyV2Weights(a, mgr.getSliders(id)!)), mgr.getLift(id)!), mesh.geometry.vertices)).toBeLessThan(1e-5);
  });
});
describe('Character v2 — asset migration', () => {
  it('a body-v2@1 save restores onto the current asset (semantic sliders), no warning, and re-saves as it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const old: CharacterV2Marker = {
      kind: CHARACTER_V2_KIND, asset: 'body-v2@1', base: 'masc', name: 'Old v2',
      sliders: { shoulderWidth: 0.4, legLength: -0.3, waist: 0.2, height: 0.25 },
      transform: { x: 1, y: 0.2, z: -2, rx: 0, ry: 0.5, rz: 0, s: heightScale(0.25) },
    };
    const root = new MeshGroup3D(isvc);
    const g = new MeshGroup3D(isvc); g.name = 'Old v2 (v2 save)'; g.thinWrapper = true; g.documentSkipChildren = true; g.worldParams = JSON.parse(JSON.stringify(old));
    root.addChild(g);
    const mgr = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    expect(await mgr.restoreFromSave()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    const h = mgr.list()[0];
    expect(mgr.getSliders(h.rootId)).toEqual(old.sliders);
    const a = mgr.getAsset(h.rootId)!;
    expect(BODY_V2_ASSET).toBe('body-v2@3');
    expect(a.asset).toBe(BODY_V2_ASSET);
    expect(a.base).toBe('masc');
    const mesh = find(root, h.rootId) as SkinnedMesh3D;
    // The FEET stay where the v2@1 body stood: its origin was relative to v2@1's soles (pipeline#7 — reusing the origin
    // as-is sank this masc ≈ 4 cm, 6.4 cm at default sliders). The v2 node origin IS the soles now.
    const soleOld = (await bodyV2LegacySoleY('body-v2@1', 'masc', old.sliders))!;
    expect(solesY(mesh)).toBeCloseTo(0.2 + soleOld * old.transform.s, 6);
    expect(mesh.y).toBeCloseTo(0.2 + soleOld * old.transform.s, 6);
    expect(Math.abs(soleOld - -mgr.getLift(h.rootId)!) * old.transform.s).toBeGreaterThan(0.02);   // the soles really moved between the assets
    expect(mesh.x).toBeCloseTo(1, 9); expect(mesh.z).toBeCloseTo(-2, 9); expect(mesh.rotationY).toBe(0.5);
    // the restored shape is the current asset's evaluation of the same sliders (+ the lift)
    expect(maxDiff(lifted(bodyV2Vertices(a, bodyV2Weights(a, old.sliders)), mgr.getLift(h.rootId)!), mesh.geometry.vertices)).toBeLessThan(1e-5);
    const resaved = JSON.parse(JSON.stringify(g.toJSON())).worldParams as CharacterV2Marker;
    expect(resaved.asset).toBe(BODY_V2_ASSET);
    expect(resaved.v).toBe(2);
    expect(resaved.sliders).toEqual(old.sliders);
    expect(resaved.transform.y).toBeCloseTo(mesh.y, 12);   // now the soles
  });

  it('a first-schema body-v2@2 marker (origin at the hips, transform.soleY) restores with its feet where they stood', async () => {
    // What the pre-review runtime wrote: origin = feet − soleY·s.
    const root = new MeshGroup3D(isvc);
    const tmp = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    const h0 = await tmp.create({ sliders: { legLength: 0.6 } });
    const soleY = -tmp.getLift(h0.rootId)!;
    tmp.remove(h0.rootId);
    const s = heightScale(-0.4);
    const old: CharacterV2Marker = { kind: CHARACTER_V2_KIND, asset: 'body-v2@2', base: 'fem', sliders: { legLength: 0.6, height: -0.4 }, transform: { x: 3, y: 0.5 - soleY * s, z: 1, rx: 0, ry: 0, rz: 0, s, soleY } };
    const g = markerFrom({ worldParams: old }); root.addChild(g);
    const mgr = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    expect(await mgr.restoreFromSave()).toBe(1);
    const mesh = find(root, mgr.list()[0].rootId) as SkinnedMesh3D;
    expect(solesY(mesh)).toBeCloseTo(0.5, 6);
    expect(mesh.scaleY).toBeCloseTo(s, 12);
  });
});

describe('Character v2 — body-v2@2 → body-v2@3 migration (the integration bump)', () => {
  it("a PRE-REVIEW body-v2@2 marker (no v, no soleY: origin at that body's hips) lands its feet where they stood", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sliders = { legLength: -0.3, limbThick: 0.5, waist: 0.4, height: 0.3 };
    const s = heightScale(0.3), floor = 0.25;
    const soleOld = (await bodyV2LegacySoleY('body-v2@2', 'masc', sliders))!;   // the pre-review generator's soles (pinned in body-v2-asset.test)
    const old: CharacterV2Marker = { kind: CHARACTER_V2_KIND, asset: 'body-v2@2', base: 'masc', name: 'Pre-review', sliders, transform: { x: -1, y: floor - soleOld * s, z: 4, rx: 0, ry: -0.7, rz: 0, s } };
    const root = new MeshGroup3D(isvc); root.addChild(markerFrom({ worldParams: JSON.parse(JSON.stringify(old)) }));
    const mgr = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    expect(await mgr.restoreFromSave()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    const h = mgr.list()[0], mesh = find(root, h.rootId) as SkinnedMesh3D;
    expect(mgr.getSliders(h.rootId)).toEqual(sliders);   // semantic: the same values on the per-base ranges
    expect(solesY(mesh)).toBeCloseTo(floor, 6);
    expect(mesh.scaleY).toBeCloseTo(s, 12);
    expect([mesh.x, mesh.z, mesh.rotationY]).toEqual([-1, 4, -0.7]);
    const resaved = saveMarker(find(root, h.markerId!) as MeshGroup3D).worldParams as CharacterV2Marker;
    expect(resaved.asset).toBe('body-v2@3');
    expect(resaved.v).toBe(2);
    expect(resaved.transform.y).toBeCloseTo(floor, 6);   // the soles origin from now on
  });

  it('a schema-v2 body-v2@2 marker (written just before the bump) keeps its feet, ids and joint offsets across the rest change', async () => {
    const root = new MeshGroup3D(isvc);
    const src = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    const h = await src.create({ base: 'fem', position: [2, 0.4, -3], sliders: { legLength: 0.5, shoulderWidth: -0.4 } });
    const sk = (find(root, h.rootId) as SkinnedMesh3D).skeleton!;
    const ia = sk.data.joints.findIndex((j) => j.name === 'lowerarm_L');
    const userOff: [number, number, number] = [0.004, -0.003, 0.002];   // the user dragged the elbow joint
    { const lp = sk.data.joints[ia].localPosition; sk.data.joints[ia].localPosition = [lp[0] + userOff[0], lp[1] + userOff[1], lp[2] + userOff[2]]; }
    const saved = saveMarker(find(root, h.markerId!) as MeshGroup3D) as { worldParams: CharacterV2Marker };
    const wp = saved.worldParams;
    expect(wp.v).toBe(2);
    // Pretend the saving asset (body-v2@2) had a different rest: every asset joint 1 cm higher / 6 mm further out, and
    // the saved skeleton's local positions on that old rest (+ the user's offset).
    const na = wp.rig!.rest.length / 3, jts = (wp.rig!.skeleton as { skeletonData: { joints: { name: string; localPosition: number[] }[] } }).skeletonData.joints;
    const names = (find(root, h.rootId) as SkinnedMesh3D).skeleton!.data.joints.slice(0, na).map((j) => j.name);
    for (let a = 0; a < na; a++) {
      const d = [a % 2 ? 0.006 : -0.006, 0.01, 0];
      for (let k = 0; k < 3; k++) wp.rig!.rest[a * 3 + k] += d[k];
      const jt = jts.find((j) => j.name === names[a])!;
      jt.localPosition = jt.localPosition.map((v, k) => v + d[k]);
    }
    wp.asset = 'body-v2@2';
    const r2 = new MeshGroup3D(isvc); r2.addChild(markerFrom(saved));
    const mgr = new CharacterV2Manager(fakeHost(r2), { consoleHandle: false });
    expect(await mgr.restoreFromSave()).toBe(1);
    const mesh = find(r2, h.rootId) as SkinnedMesh3D;
    expect(mesh).toBeTruthy();                           // same ids
    expect(solesY(mesh)).toBeCloseTo(0.4, 6);           // origin = the soles: no placement migration needed
    expect([mesh.x, mesh.z]).toEqual([2, -3]);
    const want = src.getAsset(h.rootId)!;               // the CURRENT rest (+ the user's offset) — not the old asset's
    const live = mesh.skeleton!.data.joints;
    const rest = bodyV2JointLocal(want, bodyV2Weights(want, mgr.getSliders(h.rootId)!));
    for (let a = 1; a < na; a++) for (let k = 0; k < 3; k++)
      expect(live[a].localPosition[k], `${names[a]}[${k}]`).toBeCloseTo(rest[a * 3 + k] + (a === ia ? userOff[k] : 0), 6);
    expect(saveMarker(find(r2, h.markerId!) as MeshGroup3D).worldParams.asset).toBe('body-v2@3');
  });
});

describe('Character v2 — review fixes (G4), fake host', () => {
  it('runtime#6 / pipeline#6: concurrent restores build each marker once; a document switch mid-restore leaves no ghost', async () => {
    const root = new MeshGroup3D(isvc);
    const src = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    const h = await src.create({ sliders: { waist: -0.3 } });
    const saved = saveMarker(find(root, h.markerId!) as MeshGroup3D);
    // (a) Two un-awaited restores over one marker (Frogmarks' OPFS load calls restoreProceduralFromSave3D twice).
    const rootA = new MeshGroup3D(isvc); rootA.addChild(markerFrom(saved));
    const a = new CharacterV2Manager(fakeHost(rootA), { consoleHandle: false });
    const [n1, n2] = await Promise.all([a.restoreFromSave(), a.restoreFromSave()]);
    expect(n1 + n2).toBe(1);
    expect(a.list().length).toBe(1);
    expect(rootA.children.filter((c) => c instanceof SkinnedMesh3D).length).toBe(1);
    expect(rootA.children.filter((c) => c instanceof Skeleton3D).length).toBe(1);
    // the marker's live getter is bound to the ONE record: an edit on it is what saves
    a.setSlider(a.list()[0].rootId, 'legLength', 0.8);
    expect((saveMarker(rootA.children.find((c) => c instanceof MeshGroup3D) as MeshGroup3D).worldParams as CharacterV2Marker).sliders).toEqual({ waist: -0.3, legLength: 0.8 });
    // (b) restore → document switch (clear + the root emptied for doc B) before the build resumes → nothing lands.
    const rootB = new MeshGroup3D(isvc); rootB.addChild(markerFrom(saved));
    const b = new CharacterV2Manager(fakeHost(rootB), { consoleHandle: false });
    const p = b.restoreFromSave();
    b.clearForDocumentLoad();
    for (const c of [...rootB.children]) rootB.removeChild(c);
    expect(await p).toBe(0);
    expect(rootB.children.length).toBe(0);
    expect(b.list().length).toBe(0);
    // (c) create() across a document load → rejects, leaves no body / marker in the new document.
    const rootC = new MeshGroup3D(isvc);
    const c = new CharacterV2Manager(fakeHost(rootC), { consoleHandle: false });
    const pc = c.create();
    c.clearForDocumentLoad();
    await expect(pc).rejects.toThrow(/document changed/);
    expect(rootC.children.length).toBe(0);
    expect(c.list().length).toBe(0);
  });

  it('runtime#8 / pipeline#11: the limb IK chains are seeded AFTER placement, in the character frame (targets on the end joints, poles ±0.4·s along its forward)', async () => {
    const check = (mgr: CharacterV2Manager, id: string, root: MeshGroup3D) => {
      const mesh = find(root, id) as SkinnedMesh3D, sk = mesh.skeleton!;
      sk.computeWorldMatrices();
      const o = sk.objectTransform, s = Math.hypot(o[8], o[9], o[10]);
      const fwd = [o[8] / s, o[9] / s, o[10] / s];
      const chains = sk.data.ikChains ?? [];
      expect(chains.length).toBe(4);
      for (const c of chains) {
        expect(c.enabled).toBe(false);
        const e = sk.data.joints[c.endJointIdx].worldMatrix;
        expect(Math.hypot(c.target[0] - e[12], c.target[1] - e[13], c.target[2] - e[14])).toBeLessThan(1e-6);
        const midName = sk.data.joints[c.endJointIdx].name.replace('hand', 'lowerarm').replace('foot', 'lowerleg');
        const m = sk.data.joints.find((j) => j.name === midName)!.worldMatrix;
        const d = [c.poleTarget![0] - m[12], c.poleTarget![1] - m[13], c.poleTarget![2] - m[14]];
        const along = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
        expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(0.4 * s, 6);
        expect(along).toBeCloseTo(midName.startsWith('lowerleg') ? 0.4 * s : -0.4 * s, 6);   // knees forward, elbows back
      }
      return s;
    };
    const root = new MeshGroup3D(isvc);
    const mgr = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    const h = await mgr.create({ position: [5, 0, 3] });
    check(mgr, h.rootId, root);
    // after a proportion slider the disabled chains follow the new joints
    mgr.setSlider(h.rootId, 'legLength', 1);
    check(mgr, h.rootId, root);
    // in a city (mpu 15): real size, the pole offset scales with the body
    const rootC = new MeshGroup3D(isvc);
    const city = new CharacterV2Manager(fakeHost(rootC, { mpu: 15 }), { consoleHandle: false });
    const hc = await city.create({ position: [40, 0, 25] });
    expect(check(city, hc.rootId, rootC)).toBeLessThan(0.1);
    // a first-schema (no rig) marker restored with a rotation: seeded in the ROTATED frame
    const old: CharacterV2Marker = { kind: CHARACTER_V2_KIND, asset: 'body-v2@2', base: 'fem', sliders: {}, transform: { x: -3, y: 0.3, z: 2, rx: 0, ry: Math.PI / 2, rz: 0, s: 1 } };
    const rootR = new MeshGroup3D(isvc); rootR.addChild(markerFrom({ worldParams: old }));
    const rr = new CharacterV2Manager(fakeHost(rootR), { consoleHandle: false });
    await rr.restoreFromSave();
    check(rr, rr.list()[0].rootId, rootR);
  });

  it('pipeline#4: a joint ADDED to the skeleton (spring chain / charm) stays finite and bound through every slider', async () => {
    const root = new MeshGroup3D(isvc);
    const mgr = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    const h = await mgr.create();
    const mesh = find(root, h.rootId) as SkinnedMesh3D, sk = mesh.skeleton!;
    const head = sk.data.joints.findIndex((j) => j.name === 'head'), hips = sk.data.joints.findIndex((j) => j.name === 'hips');
    sk.computeWorldMatrices();
    const add = (parent: number, local: [number, number, number], name: string) => {
      const i = sk.addJoint(parent, local, name);
      sk.computeWorldMatrices();
      mat4.invert(sk.data.joints[i].inverseBindMatrix as unknown as mat4, sk.data.joints[i].worldMatrix as unknown as mat4);   // the v1 charm rule
      return i;
    };
    const t0 = add(head, [0, 0.12, -0.05], 'hair_tail_0'), t1 = add(t0, [0, -0.06, -0.02], 'hair_tail_1'), sk0 = add(hips, [0, -0.1, 0.08], 'skirt_0');
    const locals = [t0, t1, sk0].map((i) => [...sk.data.joints[i].localPosition]);
    const restCheck = () => {
      // at rest (identity rotations) every skin matrix = the object transform (asset joints AND added joints)
      const rots = sk.data.joints.map((j) => j.localRotation);
      for (const j of sk.data.joints) j.localRotation = [0, 0, 0, 1];
      sk.computeWorldMatrices();
      let e = 0;
      for (const j of sk.data.joints) {
        const m = mat4.multiply(mat4.create(), j.worldMatrix as unknown as mat4, j.inverseBindMatrix as unknown as mat4);
        for (let k = 0; k < 16; k++) e = Math.max(e, Number.isFinite(m[k]) ? Math.abs(m[k] - sk.objectTransform[k]) : Infinity);
      }
      sk.data.joints.forEach((j, i) => { j.localRotation = rots[i]; });
      sk.computeWorldMatrices();
      return e;
    };
    expect(restCheck()).toBeLessThan(1e-5);
    for (const s of [{ torsoLength: 0.5 }, { waist: 0.3 }, { torsoLength: -1, legLength: 1, shoulderWidth: 1 }, { hipWidth: 1, height: 0.6 }, {}]) {
      mgr.setSliders(h.rootId, s, true);
      for (const v of sk.skinMatrices) expect(Number.isFinite(v)).toBe(true);
      expect(restCheck()).toBeLessThan(1e-5);
    }
    expect([t0, t1, sk0].map((i) => [...sk.data.joints[i].localPosition])).toEqual(locals);   // their own local rest untouched
  });

  it('pipeline#5: v2 writes only its own weights — another shape on the body survives slider drags and a generic removal', async () => {
    const root = new MeshGroup3D(isvc);
    const mgr = new CharacterV2Manager(fakeHost(root), { consoleHandle: false });
    const h = await mgr.create();
    const mesh = find(root, h.rootId) as SkinnedMesh3D;
    const a = mgr.getAsset(h.rootId)!;
    // a user shape (+10 mm z on vertex 0), as Scene3DBlendShapes.add + setWeight would
    const d = new Float32Array(a.vertexCount * 6); d[2] = 0.01;
    mesh.blendShapes.push({ name: 'user:smile', deltaVertices: d });
    const w = new Float32Array(mesh.blendShapes.length); w.set(mesh.blendWeights); w[w.length - 1] = 1; mesh.blendWeights = w;
    mesh.applyBlendWeights();
    const expected = () => { const v = lifted(bodyV2Vertices(a, bodyV2Weights(a, mgr.getSliders(h.rootId)!)), mgr.getLift(h.rootId)!); v[2] += 0.01; return v; };
    for (let i = 0; i <= 30; i++) mgr.setSliders(h.rootId, { waist: Math.sin(i) * 0.8, legLength: Math.cos(i) * 0.6, bust: i / 30 });
    expect(mesh.blendWeights[mesh.blendShapes.findIndex((s) => s.name === 'user:smile')]).toBe(1);
    expect(maxDiff(mesh.geometry.vertices, expected())).toBeLessThan(1e-5);
    // a generic removal of a shape BEFORE v2's range shifts every index — v2 re-locates its slots; a v2 shape removed is put back
    mesh.blendShapes.unshift({ name: 'user:before', deltaVertices: new Float32Array(a.vertexCount * 6) });
    const w2 = new Float32Array(mesh.blendShapes.length); w2.set(mesh.blendWeights, 1); mesh.blendWeights = w2;
    const victim = mesh.blendShapes.findIndex((s) => s.name.startsWith('v2:waist'));
    mesh.blendShapes.splice(victim, 1);
    mesh.blendWeights = Float32Array.from([...mesh.blendWeights].filter((_, i) => i !== victim));
    mgr.setSliders(h.rootId, { waist: -0.7, hipWidth: 0.6 });
    expect(mesh.blendShapes.filter((s) => s.name.startsWith('v2:')).length).toBe(a.shapes.length + 1);
    expect(maxDiff(mesh.geometry.vertices, expected())).toBeLessThan(1e-5);
  });

  it('runtime#2: slider changes are undo steps (a drag coalesces into one), consistent with the node scale', async () => {
    const undo: { description: string; undo(): void; redo(): void }[] = [];
    const root = new MeshGroup3D(isvc);
    const mgr = new CharacterV2Manager(fakeHost(root, { undo }), { consoleHandle: false });
    const h = await mgr.create();
    const mesh = find(root, h.rootId) as SkinnedMesh3D;
    for (let i = 1; i <= 20; i++) mgr.setSlider(h.rootId, 'height', i / 20);
    expect(undo.length).toBe(1);   // one drag = one step
    expect(mesh.scaleY).toBeCloseTo(heightScale(1), 12);
    for (let i = 1; i <= 10; i++) mgr.setSlider(h.rootId, 'legLength', i / 10);
    expect(undo.length).toBe(2);
    undo[1].undo();
    expect(mgr.getSliders(h.rootId)).toEqual({ height: 1 });
    undo[0].undo();
    expect(mgr.getSliders(h.rootId)).toEqual({});
    expect(mesh.scaleY).toBeCloseTo(1, 12);
    expect(solesY(mesh)).toBeCloseTo(0, 6);
    undo[0].redo(); undo[1].redo();
    expect(mgr.getSliders(h.rootId)).toEqual({ height: 1, legLength: 1 });
    expect(mesh.scaleY).toBeCloseTo(heightScale(1), 12);
    // a gizmo move undone across a height change (the gizmo restores its full captured TRS): the feet stay planted —
    // the origin is the soles — and the save matches what is shown
    const before = { x: mesh.x, y: mesh.y, z: mesh.z, sx: mesh.scaleX, sy: mesh.scaleY, sz: mesh.scaleZ };
    mesh.setPosition3D(1, 0, 1);
    mgr.setSlider(h.rootId, 'height', -0.5);
    mesh.setScale3D(before.sx, before.sy, before.sz); mesh.setPosition3D(before.x, before.y, before.z);   // the gizmo undo
    mgr.setSlider(h.rootId, 'waist', 0.3);
    expect(solesY(mesh)).toBeCloseTo(0, 6);
    const r2 = new MeshGroup3D(isvc); r2.addChild(markerFrom(saveMarker(find(root, h.markerId!) as MeshGroup3D)));
    const m2 = new CharacterV2Manager(fakeHost(r2), { consoleHandle: false });
    await m2.restoreFromSave();
    const mesh2 = find(r2, h.rootId) as SkinnedMesh3D;
    expect([mesh2.y, mesh2.scaleY]).toEqual([mesh.y, mesh.scaleY]);
  });
});

// ── The real Scene3DManager (the play-auto-player.test stub context) ────────────────────────────────────────────────
function makeManager() {
  const perm = <T extends object>(t: T): T => new Proxy(t, { get: (o, k) => (k in o ? (o as Record<string | symbol, unknown>)[k] : () => undefined) });
  const cam = new Camera3D();
  const outlines = new Map<string, unknown>();
  const r3 = perm({ getCamera: () => cam, setMeshOutline: (id: string, style: unknown) => { outlines.set(id, style); } });
  const wr = perm({ getRenderer3D: () => r3, getCanvas: () => null });
  const root = new Node();
  let ver = 0;
  const findNodeById = (id: string) => { let f: unknown = null; root.forEachDeep((n: Node & { id?: string }) => { if (n.id === id) f = n; }); return f; };
  const inter = { n: 0 };
  const svc = perm({ beginInteractive: () => { inter.n++; }, endInteractive: () => { inter.n--; } });
  const ctx = perm({
    webgpuRenderer: wr, sceneGraph: { root, findNodeById },
    sceneStructureVersion: () => ver, emitSceneGraphChanged: () => { ver++; }, scheduleRender: () => {},
    interactionService: svc,
  });
  const m = new Scene3DManager(ctx as never);
  const cv = new CharacterV2Manager(scene3dCharacterV2Host(m), { consoleHandle: false });
  return { m, cv, root, cam, outlines, inter, svc };
}
const PLAY = { keyboard: false, mouseLook: false, gamepad: false, collision: false } as const;
const v2Markers = (m: Scene3DManager) => m.getRootMeshGroups().filter((g) => (g.worldParams as { kind?: string } | null)?.kind === CHARACTER_V2_KIND);
/** "Save + reload" on a fresh manager: the v2 markers (their JSON), the player binding, and the groups bodies sit in. */
async function reload(m: Scene3DManager, extraGroups: MeshGroup3D[] = []) {
  const saved = v2Markers(m).map(saveMarker);
  const player = m.playerObjectId3D;
  const f = makeManager();
  for (const g of extraGroups) { const ng = new MeshGroup3D(f.svc as never); ng.setId(g.id); ng.name = g.name; f.root.addChild(ng); }
  for (const s of saved) f.root.addChild(markerFrom(s, f.svc));
  f.m.restoreGlobalScene3DSettings({ player: { meshId: player, locomotionSet: null } } as never);   // the doc's player binding
  const n = await f.cv.restoreFromSave();
  return { ...f, n, saved };
}

describe('Character v2 — review fixes (G4) on the real Scene3DManager', () => {
  it('runtime#1: ids, the Play binding, the gait seed and the per-body state survive two reloads', async () => {
    const { m, cv, root } = makeManager();
    const h = await cv.create({ position: [1.5, 0, -0.5], sliders: { legLength: 0.3 } });
    const mesh = m.getMesh(h.rootId) as SkinnedMesh3D, sk = mesh.skeleton!;
    expect(sk.data.clips!.map((c) => c.name)).toEqual(expect.arrayContaining(DEFAULT_CLIP_NAMES));
    m.setPlayerObject3D(h.rootId);
    // user state: rename, hide, lock, outline, colour, a head turn, a user clip, an enabled IK chain, grouped + moved
    mesh.name = 'Renamed Hero'; mesh.visible = false; mesh.locked = true;
    m.setMeshOutline3D(h.rootId, { color: [1, 0, 0, 1], width: 0.02 });
    mesh.setDiffuseColor(0.2, 0.4, 0.6, 1);
    const head = sk.data.joints.findIndex((j) => j.name === 'head');
    sk.data.joints[head].localRotation = [0, 0.3826834, 0, 0.9238795];
    sk.data.clips!.push({ id: 'userclip', name: 'My Wave', startFrame: 0, endFrame: 12, fps: 24, tracks: [{ jointIndex: head, channel: 'rotation', keyframes: [{ frame: 0, value: [0, 0, 0, 1] }, { frame: 12, value: [0, 0.2, 0, 0.98] }] }] } as never);
    const hand = sk.data.ikChains!.find((c) => sk.data.joints[c.endJointIdx].name === 'hand_L')!;
    m.setIKChainEnabled(sk.id, hand.id, true);
    const grp = new MeshGroup3D(isvc); grp.name = 'Party'; root.addChild(grp);
    root.removeChild(mesh); grp.addChild(mesh);
    const seed = (m as unknown as { _locoCharacterSeed(s: string): string })._locoCharacterSeed(sk.id);
    expect(seed).toBe(h.rootId);   // the shared predicate: the body id (was the per-load skeleton id)
    // the marker is the ONLY thing that saves, and it is a few KB
    expect(m.getAllMeshes().filter((x) => !x.excludeFromDocument).length).toBe(0);
    expect(m.getAllSkeletons().filter((s) => !s.excludeFromDocument).length).toBe(0);
    let r = await reload(m, [grp]);
    for (let pass = 0; pass < 2; pass++) {
      expect(r.n).toBe(1);
      expect(JSON.stringify(r.saved[0].worldParams).length).toBeLessThan(16_000);
      const h2 = r.cv.list()[0];
      expect([h2.rootId, h2.skeletonId]).toEqual([h.rootId, h.skeletonId]);
      const m2 = r.m.getMesh(h.rootId) as SkinnedMesh3D, sk2 = m2.skeleton!;
      expect(r.m.playerObjectId3D).toBe(h.rootId);
      expect(r.m.getAllMeshes().find((x) => x.id === r.m.playerObjectId3D)).toBe(m2);   // the Play binding resolves
      expect((r.m as unknown as { _locoCharacterSeed(s: string): string })._locoCharacterSeed(sk2.id)).toBe(seed);
      expect([m2.name, m2.visible, m2.locked]).toEqual(['Renamed Hero', false, true]);
      expect(m2.outline).toMatchObject({ color: [1, 0, 0, 1], width: 0.02 });
      expect(m2.material.diffuse).toEqual({ r: 0.2, g: 0.4, b: 0.6, a: 1 });
      expect(sk2.data.joints[head].localRotation).toEqual([0, 0.3826834, 0, 0.9238795]);   // the user's head turn (setupRig's Relaxed stance did not overwrite it)
      expect(sk2.data.clips!.find((c) => c.name === 'My Wave')?.tracks.length).toBe(1);
      expect(sk2.data.clips!.map((c) => c.name)).toEqual(expect.arrayContaining(DEFAULT_CLIP_NAMES));   // stripped defaults backfilled
      expect(sk2.data.clips!.filter((c) => c.name === DEFAULT_CLIP_NAMES[0]).length).toBe(1);
      expect(sk2.data.ikChains!.length).toBe(4);
      expect(sk2.data.ikChains!.find((c) => c.id === hand.id)?.enabled).toBe(true);
      expect((m2.parent as { id?: string } | null)?.id).toBe(grp.id);
      expect([m2.x, m2.y, m2.z]).toEqual([1.5, 0, -0.5]);
      expect(r.cv.getSliders(h.rootId)).toEqual({ legLength: 0.3 });
      r = await reload(r.m, [grp]);
    }
  });

  it('runtime#2: a slider changed during Play keeps the feet on the floor during Play and after Stop, and the height sticks', async () => {
    const { m, cv } = makeManager();
    const h = await cv.create({ position: [1, 0, 2] });
    const mesh = m.getMesh(h.rootId) as SkinnedMesh3D;
    m.setPlayerObject3D(h.rootId);
    m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
    await wait(80);
    cv.setSliders(h.rootId, { height: 0.8, legLength: 1 });
    await wait(300);   // Play ticks drive the avatar
    expect(Math.abs(solesY(mesh))).toBeLessThan(2e-3);   // was −0.317 (32 cm into the floor) during Play
    expect(mesh.scaleY).toBeCloseTo(heightScale(0.8), 9);
    // the mid-Play gait was rebuilt for the new legs: the engine's rest pose took the new bone lengths
    m.exitPlayMode3D();
    expect(Math.abs(solesY(mesh))).toBeLessThan(1e-6);   // was −0.252 after Stop
    expect(mesh.scaleY).toBeCloseTo(heightScale(0.8), 9);   // was 1.000 (Stop put the pre-Play scale back)
    const a = cv.getAsset(h.rootId)!;
    const J = bodyV2JointLocal(a, bodyV2Weights(a, cv.getSliders(h.rootId)!));
    J[1] += cv.getLift(h.rootId)!;   // the root (hips) carries the lift
    const jl = mesh.skeleton!.data.joints.slice(0, a.jointNames.length).flatMap((j) => j.localPosition);
    expect(maxDiff(new Float32Array(jl), J)).toBeLessThan(1e-5);   // Stop restored the NEW bone lengths (not the pre-Play ones)
    cv.setSlider(h.rootId, 'waist', 0.1);
    expect(Math.abs(solesY(mesh))).toBeLessThan(1e-6);
    const r = await reload(m);
    const m2 = r.m.getMesh(h.rootId) as SkinnedMesh3D;
    expect(Math.abs(solesY(m2))).toBeLessThan(1e-6);
    expect(m2.scaleY).toBeCloseTo(heightScale(0.8), 9);
  });

  it('runtime#3: Ctrl+D / Duplicate makes a REAL character copy (own arrays, own marker, same sliders); one undo removes it', async () => {
    const { m, cv } = makeManager();
    const h = await cv.create({ sliders: { waist: -0.4, height: 0.3 } });
    const src = m.getMesh(h.rootId) as SkinnedMesh3D;
    src.skeleton!.data.joints[src.skeleton!.data.joints.findIndex((j) => j.name === 'head')].localRotation = [0, 0.2, 0, 0.98];
    expect(m.duplicateMesh(h.rootId)).toBeNull();   // routed to the character provider (async)
    await until(() => cv.list().length === 2);
    const copyH = cv.list().find((x) => x.rootId !== h.rootId)!;
    const copy = m.getMesh(copyH.rootId) as SkinnedMesh3D;
    expect(copy).toBeInstanceOf(SkinnedMesh3D);
    expect(copy.geometry.vertices).not.toBe(src.geometry.vertices);
    expect(copy.skeleton).not.toBe(src.skeleton);
    expect(copy.excludeFromDocument).toBe(true);
    expect(cv.getSliders(copyH.rootId)).toEqual(cv.getSliders(h.rootId));
    expect(copy.scaleY).toBeCloseTo(src.scaleY, 12);
    expect(copy.skeleton!.data.joints.find((j) => j.name === 'head')!.localRotation).toEqual([0, 0.2, 0, 0.98]);   // the pose came along
    expect(v2Markers(m).length).toBe(2);
    expect(copy.name).toBe(`${src.name} copy`);
    expect(m.undoDescription3D).toBe('Duplicate character');
    const before = new Float32Array(copy.geometry.vertices);
    cv.setSliders(h.rootId, { legLength: 1 }, false, { undo: false });
    expect(maxDiff(copy.geometry.vertices, before)).toBe(0);   // the original's slider never reaches the copy
    expect(solesY(copy)).toBeCloseTo(0, 6);
    m.undo3D();
    expect(cv.list().length).toBe(1);
    expect(m.getMesh(copyH.rootId)).toBeNull();
    expect(v2Markers(m).length).toBe(1);
    m.redo3D();
    expect(cv.list().length).toBe(2);
    expect(m.getMesh(copyH.rootId)).toBe(copy);
  });

  it('runtime#4: the outliner delete (mesh or marker id) is ONE undoable whole-character op; the marker row is hidden', async () => {
    const { m, cv } = makeManager();
    const h = await cv.create();
    const mesh = m.getMesh(h.rootId) as SkinnedMesh3D, sk = mesh.skeleton!;
    const rows = m.getScene3DHierarchy();
    expect(rows.map((r) => r.id)).toContain(h.rootId);
    expect(rows.map((r) => r.id)).not.toContain(h.markerId);   // the "(v2 save)" row is gone from the outliner
    const inScene = () => [!!m.getMesh(h.rootId), !!m.getSkeleton(h.skeletonId), v2Markers(m).length, cv.list().length];
    expect(inScene()).toEqual([true, true, 1, 1]);
    expect(m.deleteMesh(h.rootId)).toBe(true);
    expect(inScene()).toEqual([false, false, 0, 0]);   // body + skeleton + marker + record together (was: the skeleton + record orphaned)
    expect(cv.setSlider(h.rootId, 'waist', 0.5)).toBe(false);
    m.undo3D();
    expect(inScene()).toEqual([true, true, 1, 1]);
    expect(m.getMesh(h.rootId)).toBe(mesh);
    expect(mesh.skeleton).toBe(sk);
    expect(cv.setSlider(h.rootId, 'waist', 0.5, { undo: false })).toBe(true);
    m.redo3D();
    expect(inScene()).toEqual([false, false, 0, 0]);
    m.undo3D();
    // the marker id (a group delete) deletes the character the same way
    expect(m.deleteMeshGroup(h.markerId!)).toBe(true);
    expect(inScene()).toEqual([false, false, 0, 0]);
    m.undo3D();
    expect(inScene()).toEqual([true, true, 1, 1]);
    // the old zombie path: delete, then the console remove → nothing comes back half
    m.deleteMesh(h.rootId);
    expect(cv.remove(h.rootId)).toBe(false);
    m.undo3D();
    expect(inScene()).toEqual([true, true, 1, 1]);
  });

  it('runtime#5 / downstream#6: the character-level gates see a v2 body (outlines, character scale, Bind Mesh refused, internal shapes guarded)', async () => {
    const { m, cv, outlines } = makeManager();
    const h = await cv.create();
    const mesh = m.getMesh(h.rootId) as SkinnedMesh3D;
    expect(mesh.isProceduralBody).toBe(false);   // still not a v1-params body
    expect(m.isCharacterBody3D(h.rootId)).toBe(true);
    expect(m.isCharacterBodySkeleton3D(h.skeletonId)).toBe(true);
    // characters-only outline
    expect(m.setCharacterOutlines3D({})).toBe(1);   // was 0
    expect(mesh.outline).not.toBeNull();
    // a character created while it is on gets it too
    const h2 = await cv.create({ position: [2, 0, 0] });
    expect(m.getMesh(h2.rootId)!.outline).not.toBeNull();
    m.setCharacterOutlines3D(null);
    expect(mesh.outline).toBeNull();
    // Play's ink outline (on by default) draws on the v2 avatar
    outlines.clear();
    m.setPlayerObject3D(h.rootId);
    m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
    expect(outlines.get(h.rootId)).toBeTruthy();
    m.exitPlayMode3D();
    // character scale API (feet kept: the origin is the soles)
    expect(m.getCharacterScale3D(h.rootId)).not.toBeNull();
    expect(m.setCharacterScale3D(h.rootId, 1.4)).toBe(true);
    expect(solesY(mesh)).toBeCloseTo(0, 6);
    m.undo3D();
    expect(mesh.scaleY).toBeCloseTo(1, 12);
    // Bind Mesh would replace the node and orphan the record → refused
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(m.bindMeshToSkeleton3D(h.rootId, h.skeletonId)).toBe(false);
    expect(m.getMesh(h.rootId)).toBe(mesh);
    // a generic weight edit / removal of a v2-internal shape is refused (it fought the sliders + bone offsets)
    const vi0 = mesh.blendShapes.findIndex((s) => s.name.startsWith('v2:legLength'));
    const before = new Float32Array(mesh.geometry.vertices);
    m.setBlendWeight3D(h.rootId, vi0, 1);
    m.removeBlendShape3D(h.rootId, vi0);
    expect(maxDiff(mesh.geometry.vertices, before)).toBe(0);
    expect(mesh.blendShapes[vi0].name.startsWith('v2:legLength')).toBe(true);
    warn.mockRestore();
    // a non-uniform scale (the gizmo's per-axis drag is not constrained for v2 yet — character-scale.ts) reloads as it
    // was shown (the marker saved only |scaleY|: a [1.6, 1, 1] body came back [1, 1, 1])
    mesh.setScale3D(1.6, 1, 1.2);
    const r = await reload(m);
    const m2 = r.m.getMesh(h.rootId) as SkinnedMesh3D;
    expect([m2.scaleX, m2.scaleY, m2.scaleZ]).toEqual([1.6, 1, 1.2]);
    // the Play gait's arm clearance now fits the v2 body too (it was 0 = skipped)
    const deg = (r.m as unknown as { _playArmClearance(s: unknown): number })._playArmClearance(m2.skeleton);
    r.cv.setSliders(h.rootId, { torsoThick: 1, bust: 1 }, false, { undo: false });
    const deg2 = (r.m as unknown as { _playArmClearance(s: unknown): number })._playArmClearance(m2.skeleton);
    console.log(`[character-v2] Play arm clearance on the v2 fem base: ${deg.toFixed(2)}°, at torsoThick +1 / bust +1: ${deg2.toFixed(2)}°`);
    expect(Number.isFinite(deg)).toBe(true);
    expect(deg2).toBeGreaterThanOrEqual(deg);   // re-fitted after the in-place re-shape (cache keyed on blendVersion)
  });

  it('runtime#7: remove() releases the idle (live-render hold + interactive count) and the Play binding', async () => {
    const { m, cv, inter } = makeManager();
    const h = await cv.create();
    m.setIdleAnimation(h.rootId, true);
    expect(m.isIdleAnimating(h.rootId)).toBe(true);
    expect(inter.n).toBe(1);
    expect(cv.remove(h.rootId)).toBe(true);
    expect(m.isIdleAnimating(h.rootId)).toBe(false);
    expect(inter.n).toBe(0);
    expect((m as unknown as { _idleHeldLive: boolean })._idleHeldLive).toBe(false);
    // removed mid-Play: unbound (the loco rig released), the persisted binding dropped
    const h2 = await cv.create();
    m.setPlayerObject3D(h2.rootId);
    m.enterPlayMode3D({ ...PLAY, config: { cameraMode: 'third' } });
    const body = m.getMesh(h2.rootId);
    cv.remove(h2.rootId);
    expect((m as unknown as { _playerMesh: unknown })._playerMesh).not.toBe(body);
    m.exitPlayMode3D();
    expect(m.playerObjectId3D).toBeNull();
    // an undoable delete keeps the binding id (the undo brings the character back bound)
    const h3 = await cv.create();
    m.setPlayerObject3D(h3.rootId);
    m.setIdleAnimation(h3.rootId, true);
    cv.delete(h3.rootId);
    expect(inter.n).toBe(0);
    expect(m.playerObjectId3D).toBe(h3.rootId);
    m.undo3D();
    expect(m.isIdleAnimating(h3.rootId)).toBe(true);   // the idle comes back with the undo
    expect(m.getAllMeshes().find((x) => x.id === m.playerObjectId3D)).toBe(m.getMesh(h3.rootId));
  });
});
