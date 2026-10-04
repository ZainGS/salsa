/**
 * Fog horizon x P9 hierarchical cull (2026-10-01): the cluster-level fog reject (a cluster wholly past the fog edge
 * drops its culled-class members without the per-mesh box fetch + fog test) must produce EXACTLY the draw lists of the
 * per-mesh path, frame after frame, while the camera moves through and out of the fog (main, transparent, shadow, the
 * P4.2 static / dynamic shadow lists and the cascade lists), with the hysteresis state (lodHidden, twins) in step.
 *
 * Runs the REAL Renderer3D._buildDrawLists on a mock GPU device (every GPU call is a stub): the draw-list build is
 * pure CPU over the renderer's own maps, which _ensureGeomPool / uploadMeshInstances fill as they do in the app.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { InteractionService } from '../../services/interaction-service';
// Node test env: Shape.id uses self.crypto.randomUUID (browser globals).
import { webcrypto } from 'node:crypto';
const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;

const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** A GPUDevice whose every member is a callable stub returning another stub (enough for the constructor + uploads). */
function stubDevice(): GPUDevice {
  const handler: ProxyHandler<() => unknown> = {
    get(_t, k) {
      if (k === 'then') return undefined;   // not a thenable
      if (typeof k === 'string' && (k.endsWith('Async') || k === 'onSubmittedWorkDone')) return () => new Promise(() => { /* never */ });
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'size') return 1 << 30;
      if (k === 'limits') return { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 };
      return stub;
    },
    apply() { return stub; },
  };
  const stub: unknown = new Proxy(function () { /* stub */ }, handler);
  return stub as GPUDevice;
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  const flags = new Proxy({}, { get: () => 1 });
  for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

async function setup() {
  const { Renderer3D } = await import('./renderer-3d');
  const { Camera3D } = await import('./camera-3d');
  const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
  const { generateBox } = await import('./mesh-generators');
  const cam = new Camera3D();
  const r = new Renderer3D(stubDevice(), cam) as unknown as Record<string, any>;
  const meshes: InstanceType<typeof Mesh3D>[] = [];
  // A street of props (class 2, a distance LOD + some near/far twins), attachments (class 1) and buildings (class 0)
  // along +X, 0..400 units: enough meshes for the clusters (>= 2 x 32 eligible) and spread across the fog edge.
  let k = 0;
  for (let x = 0; x < 400; x += 2.5) {
    for (let row = 0; row < 3; row++) {
      const m = new Mesh3D(isvc, x, row === 0 ? 1 : 0.5, row * 6 - 6, { primitive: 'custom', geometry: generateBox(row === 0 ? 2 : 0.6, row === 0 ? 2 : 0.6, row === 0 ? 2 : 0.6) });
      m.name = `m${k}`;
      m.fogClass = row === 0 ? 0 : row === 1 ? 2 : (k % 2 ? 1 : 2);
      if (row === 1) m.drawDistance = 40 + (k % 7) * 9;   // 40-94: some hide inside the clear zone, some reach the fog
      const col = (k / 3) | 0;
      if (row === 2 && col % 3 === 0) { m.lodTwinRole = (col % 6 === 0 ? 1 : 2); m.lodTwinDist = 50 + (col % 5) * 9; }
      m.updateLocalMatrix?.();
      meshes.push(m);
      k++;
    }
  }
  return { r, cam, meshes, Renderer3D };
}

/** A comparable fingerprint of every list the build produced this frame. */
function snapshot(r: Record<string, any>) {
  // slot numbers differ between two renderers (the slot order follows the geometry keys, which embed the mesh ids):
  // compare "is the mesh's own slot" instead
  const enc = (l: any[]) => l.map((e) => `${e.mesh.name}:${e.idx === r._meshInstanceSlots.get(e.mesh.id) ? 's' : 'x' + e.idx}:${e.count ?? 1}`).join(',');
  return {
    opaque: enc(r._opaque), transparent: enc(r._transparent), shadow: enc(r._shadowList),
    stat: enc(r._shadowStaticList), dyn: enc(r._shadowDynList), c0: enc(r._cascadeLists[0]), c1: enc(r._cascadeLists[1]),
  };
}

describe('fog horizon cluster reject (P9 hierarchical cull)', () => {
  it('draw lists + LOD / twin state are identical with the cluster fog reject on and off, over a camera path', async () => {
    const A = await setup(), B = await setup();
    const Rcls = A.Renderer3D as unknown as { hcFogReject: boolean };
    const path: Array<[number, number, number]> = [];
    for (let i = 0; i <= 40; i++) path.push([i * 6, 4, 18]);        // walk +X through the street
    for (let i = 40; i >= 0; i--) path.push([i * 6, 30, 18]);       // and back, higher up
    for (let i = 0; i <= 20; i++) path.push([120, 4, 18 - i * 3]);  // across
    let frames = 0, rejected = 0, fogHidden = 0, lodHid = 0, twinNear = 0, twinFar = 0;
    for (const env of [A, B]) {
      env.r.setFogHorizon({ buildingsOnly: true, fadeM: 10 });
      env.r.fogHardEdge = true;
      env.r.distanceLod = true;
      env.r.setFog({ mode: 'linear', near: 89.9, far: 90, color: [0.5, 0.5, 0.6], density: 0 });
    }
    for (const p of path) {
      const out = [] as ReturnType<typeof snapshot>[];
      for (const [env, on] of [[A, true], [B, false]] as const) {
        Rcls.hcFogReject = on;
        env.cam.setPosition(p[0], p[1], p[2]); env.cam.setTarget(p[0] + 40, 0, 0);
        env.r.uploadSceneUniforms(1300, 850);
        if (!env.r._ensureGeomPool(env.meshes)) throw new Error('geometry pool');
        env.r.uploadMeshInstances(env.meshes);
        env.r._buildDrawLists(env.meshes);
        out.push(snapshot(env.r));
        if (on) { rejected += env.r._hcStats.fogSkipped; fogHidden += env.r._frame.fogHidden; }
      }
      expect(out[0]).toEqual(out[1]);
      expect(A.meshes.map((m) => `${+m.lodHidden}${+m.lodTwinNear}${+m.lodTwinNear2}${+m.fogHidden}`).join(''))
        .toEqual(B.meshes.map((m) => `${+m.lodHidden}${+m.lodTwinNear}${+m.lodTwinNear2}${+m.fogHidden}`).join(''));
      for (const m of A.meshes) { if (m.lodHidden) lodHid++; if (m.lodTwinRole) { if (m.lodTwinNear) twinNear++; else twinFar++; } }
      frames++;
    }
    Rcls.hcFogReject = true;
    expect(frames).toBe(path.length);
    expect(A.r._hcStats.clustered).toBeGreaterThan(0);   // the clusters were built
    expect(fogHidden).toBeGreaterThan(0);                // the fog cull ran
    expect(rejected).toBeGreaterThan(0);                 // and the cluster path took part of it
    expect(lodHid).toBeGreaterThan(0);                   // the distance LOD hid some meshes along the way
    expect(twinNear).toBeGreaterThan(0); expect(twinFar).toBeGreaterThan(0);   // and the twins swapped
  });
});
