/**
 * E11 / E8 (docs/reviews/playback-perf-2026-10-09.md): the selection box, the transform gizmo and the 3D grid are no
 * longer rebuilt + re-uploaded every frame. Real GizmoRenderer over a stub device that records writeBuffer sizes.
 *  - a steady selection / camera: zero rebuilds after the first frame;
 *  - a selected mesh MOVING rigidly (Frame Link bounce / sway / spin): zero box rebuilds — its rigid frame rides the
 *    model uniform, and the uploaded box is exactly what the world-space build drew (corners agree);
 *  - a scale change / hovered corner / gizmo mode change rebuilds once; the grid rebuilds only on its own params.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { InteractionService } from '../../services/interaction-service';

const gg = globalThis as { self?: unknown; crypto?: unknown };
gg.self ??= globalThis;
gg.crypto ??= webcrypto;
(gg.self as { crypto?: unknown }).crypto ??= webcrypto;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

function stubDevice() {
  const writes: { buf: unknown; floats: Float32Array | null }[] = [];
  const handler: ProxyHandler<() => unknown> = {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (typeof k === 'string' && (k.endsWith('Async') || k === 'onSubmittedWorkDone')) return () => new Promise(() => { /* never */ });
      if (k === Symbol.toPrimitive) return () => 0;
      return stub;
    },
    apply() { return stub; },
  };
  const stub: unknown = new Proxy(function () { /* stub */ }, handler);
  const queue = new Proxy({}, { get: (_t, k) => {
    if (k === 'writeBuffer') return (buf: unknown, _off: number, data: ArrayBufferView, dataOff = 0, size?: number) => {
      const f = data instanceof Float32Array ? data.slice(dataOff, size !== undefined ? dataOff + size : undefined) : null;
      writes.push({ buf, floats: f });
    };
    return stub;
  } });
  const device = new Proxy({}, { get: (_t, k) => {
    if (k === 'queue') return queue;
    if (k === 'features') return { has: () => false };
    if (typeof k === 'string' && k.endsWith('Async')) return () => new Promise(() => { /* never */ });
    if (k === 'createBuffer') return (d: { size: number }) => ({ size: d.size, destroy() { /* */ }, label: '' });
    return stub;
  } });
  return { device: device as unknown as GPUDevice, writes };
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  const flags = new Proxy({}, { get: () => 1 });
  for (const k of ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUMapMode', 'GPUColorWrite']) if (!(k in g)) g[k] = flags;
});

async function setup() {
  const { GizmoRenderer } = await import('./gizmo-renderer');
  const { Camera3D } = await import('./camera-3d');
  const { Mesh3D } = await import('../../scene-graph/shapes/mesh-3d');
  const dev = stubDevice();
  const gz = new GizmoRenderer(dev.device);
  const cam = new Camera3D({ position: [4, 3, 6], target: [0, 0, 0] });
  const mesh = new Mesh3D(isvc, 0, 0.5, 0, { primitive: 'box' } as never);
  const pass = new Proxy({}, { get: () => () => undefined }) as unknown as GPURenderPassEncoder;
  return { gz, cam, mesh, pass, dev, sel: (gz as unknown as Record<string, GPUBuffer>)._selBoxVertBuf };
}

/** World positions of the selection-box vertices the last upload holds, through the model the last uniform carried. */
function worldVerts(writes: { buf: unknown; floats: Float32Array | null }[], vbuf: unknown, ubuf: unknown): number[][] {
  const v = [...writes].reverse().find((w) => w.buf === vbuf)!.floats!;
  const u = [...writes].reverse().find((w) => w.buf === ubuf)!.floats!;
  const m = u.subarray(16, 32), out: number[][] = [];
  for (let i = 0; i < v.length; i += 7) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    out.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]);
  }
  return out;
}

describe('E11 selection box + gizmo: rebuilt only when they change', () => {
  it('a steady selection under a still camera: one build, then none', async () => {
    const { gz, cam, mesh, pass } = await setup();
    for (let f = 0; f < 30; f++) {
      gz.drawSelectionBox(pass, [mesh], cam, null);
      gz.drawGizmo(pass, [mesh], cam, 'move', null, 800, 600);
    }
    expect(gz.selectionBoxBuilds).toBe(1);
    expect(gz.gizmoBuilds).toBe(1);
  });

  it('a rigidly moving selection (bounce / sway / spin) reuses the box; the drawn box still matches its world corners', async () => {
    const { gz, cam, mesh, pass, dev, sel } = await setup();
    const ubuf = (gz as unknown as Record<string, unknown>)._selBoxUniBuf;
    gz.drawSelectionBox(pass, [mesh], cam, null);
    const builds0 = gz.selectionBoxBuilds;
    for (let f = 1; f <= 24; f++) {
      const a = (f / 24) * Math.PI * 2;
      mesh.setTransform3D(Math.sin(a) * 0.01, 0.5 + Math.sin(a) * 0.01, 0, 0, a * 0.02, Math.sin(a) * 0.01, 1, 1, 1);   // tiny moves: the camera-dependent thickness stays within 2 %
      gz.drawSelectionBox(pass, [mesh], cam, null);
    }
    expect(gz.selectionBoxBuilds).toBe(builds0);   // no rebuild while it moves
    // The uploaded (rigid-frame) box, through the uniform's model, encloses exactly the mesh's current OBB: every OBB
    // corner is the centre of one corner sphere (its 34 vertices average to it).
    const wv = worldVerts(dev.writes, sel, ubuf);
    const corners = mesh.obbCorners!;
    const sphereStart = 12 * 8;   // 12 edge prisms × 8 vertices, then 8 spheres × 34 vertices
    for (let ci = 0; ci < 8; ci++) {
      const s = wv.slice(sphereStart + ci * 34, sphereStart + (ci + 1) * 34);
      const c = [0, 1, 2].map((k) => s.reduce((n, p) => n + p[k], 0) / s.length);
      for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(corners[ci][k], 4);
    }
  });

  it('a scale change, a hovered corner, a gizmo mode change rebuild once each', async () => {
    const { gz, cam, mesh, pass } = await setup();
    gz.drawSelectionBox(pass, [mesh], cam, null); gz.drawGizmo(pass, [mesh], cam, 'move', null, 800, 600);
    mesh.setTransform3D(0, 0.5, 0, 0, 0, 0, 1.2, 1.2, 1.2);   // pulse
    gz.drawSelectionBox(pass, [mesh], cam, null); gz.drawSelectionBox(pass, [mesh], cam, null);
    expect(gz.selectionBoxBuilds).toBe(2);
    gz.drawSelectionBox(pass, [mesh], cam, 3); gz.drawSelectionBox(pass, [mesh], cam, 3);
    expect(gz.selectionBoxBuilds).toBe(3);
    gz.drawGizmo(pass, [mesh], cam, 'rotate', null, 800, 600); gz.drawGizmo(pass, [mesh], cam, 'rotate', null, 800, 600);
    gz.drawGizmo(pass, [mesh], cam, 'rotate', 'x', 800, 600);
    expect(gz.gizmoBuilds).toBe(3);
    cam.setPosition(-6, 3, 2);   // orbit: the gizmo-local view changed → rebuild
    gz.drawGizmo(pass, [mesh], cam, 'rotate', 'x', 800, 600);
    expect(gz.gizmoBuilds).toBe(4);
  });
});

describe('E8 3D grid: vertices cached per grid params', () => {
  it('rebuilds only when spacing / colour / opacity / plane change, not per frame or camera move', async () => {
    const { gz, cam, pass } = await setup();
    for (let f = 0; f < 20; f++) { cam.setPosition(4 + f * 0.1, 3, 6); gz.drawGrid(pass, cam, 0.5, [0.5, 0.5, 0.5], 0.4); }
    expect(gz.gridBuilds).toBe(1);
    gz.drawGrid(pass, cam, 0.25, [0.5, 0.5, 0.5], 0.4);
    gz.drawGrid(pass, cam, 0.25, [0.5, 0.5, 0.5], 0.6);
    expect(gz.gridBuilds).toBe(3);
  });
});
