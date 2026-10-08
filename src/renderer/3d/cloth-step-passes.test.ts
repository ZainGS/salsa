/**
 * Perf audit 2026-10-09 B4: ClothSimulator.step() encodes ONE compute pass holding every dispatch (integrate, every
 * iteration × colour-group constraint dispatch, collide, then pose) — it used to open one pass per dispatch (~1,450 per
 * frame while converging) — and uploads the integrate params once per call instead of once per sub-step. The dispatch
 * ORDER and the per-group dynamic offsets are unchanged (asserted here; bit-identical results were verified on a real
 * GPU with the Dawn harness, old vs new). Drives the real step() / runToConvergence on a mocked device.
 */
import { describe, it, expect } from 'vitest';
import { ClothSimulator } from './cloth-simulator';
import { buildClothGeometry, buildDefaultActiveCells } from './cloth-geometry-builder';

(globalThis as Record<string, unknown>).GPUMapMode ??= { READ: 1, WRITE: 2 };

function makeSim(opts: { stiffness: number; proxy: 'none' | 'sphere' }) {
  const geo = buildClothGeometry({
    cols: 6, rows: 5, cellSize: 0.1, subdivisions: 1, cornerRadius: 0,
    activeCells: buildDefaultActiveCells(6, 5), pinnedVertices: [0, 1, 2, 3, 4, 5, 6],
  });
  const g = geo.constraintGraph;
  const colorRanges = [...g.structColorRanges, ...g.shearColorRanges, ...g.bendColorRanges, ...g.stitchColorRanges];
  const log = { passes: 0, ops: [] as string[], writes: 0, submits: 0 };
  const P = { integrate: { n: 'integrate' }, constrain: { n: 'constrain' }, collide: { n: 'collide' }, pose: { n: 'pose' } };
  const device = {
    createCommandEncoder: () => ({
      beginComputePass: () => {
        log.passes++;
        return {
          setPipeline: (p: { n: string }) => log.ops.push(`pipe:${p.n}`),
          setBindGroup: (_i: number, bg: { n: string }, off?: number[]) => log.ops.push(`bg:${bg.n}${off ? `@${off[0]}` : ''}`),
          dispatchWorkgroups: (x: number) => log.ops.push(`dispatch:${x}`),
          end: () => log.ops.push('end'),
        };
      },
      copyBufferToBuffer: () => undefined,
      finish: () => ({}),
    }),
    queue: { writeBuffer: () => { log.writes++; }, submit: () => { log.submits++; } },
  };
  const sim = Object.assign(Object.create(ClothSimulator.prototype), {
    device, _ready: true, _pipesReady: () => true,
    integratePipeline: P.integrate, constrainPipeline: P.constrain, collidePipeline: P.collide, posePipeline: P.pose,
    integrateBG: { n: 'integrate' }, constrainBG: { n: 'constrain' }, collideBG: { n: 'collide' }, poseBG: { n: 'pose' },
    poseVertexBuf: {}, intParamsBuf: {}, _intParamsScratch: new Float32Array(8),
    _colorRanges: colorRanges, _vertexCount: geo.vertexCount,
    _physics: { gravity: 9.8, damping: 0.98, stiffness: opts.stiffness, thickness: 0, solidifyRounded: false },
    _proxy: opts.proxy === 'none' ? { type: 'none' } : { type: 'sphere', radius: 0.5 },
  }) as ClothSimulator;
  return { sim, log, colorRanges, vertexCount: geo.vertexCount };
}

/** The dispatch sequence the OLD per-pass encoder produced for one step (minus its pass boundaries). */
function expectedStep(colorRanges: { start: number; end: number }[], vc: number, stiffness: number, collide: boolean): string[] {
  const out = ['pipe:integrate', 'bg:integrate', `dispatch:${Math.ceil(vc / 64)}`];
  const con: string[] = [];
  for (let it = 0; it < stiffness; it++) {
    colorRanges.forEach((r, gi) => {
      if (r.end - r.start === 0) return;
      con.push(`bg:constrain@${gi * 256}`, `dispatch:${Math.ceil((r.end - r.start) / 64)}`);
    });
  }
  out.push('pipe:constrain', ...con);
  if (collide) out.push('pipe:collide', 'bg:collide', `dispatch:${Math.ceil(vc / 64)}`);
  return out;
}

describe('cloth step(): one compute pass per call (B4)', () => {
  it('converging (4 sub-steps × 30 iterations): 1 pass, 1 params upload, the same dispatches in the same order', () => {
    const { sim, log, colorRanges, vertexCount } = makeSim({ stiffness: 30, proxy: 'sphere' });
    sim.step(0.016, 4);
    expect(log.passes).toBe(1);
    expect(log.writes).toBe(1);
    expect(log.submits).toBe(1);
    const one = expectedStep(colorRanges, vertexCount, 30, true);
    const want = [...one, ...one, ...one, ...one, 'pipe:pose', 'bg:pose', `dispatch:${Math.ceil(vertexCount / 64)}`, 'end'];
    expect(log.ops).toEqual(want);
    const groups = colorRanges.filter(r => r.end > r.start).length;
    // the old encoder: one pass per dispatch
    expect(log.ops.filter(o => o.startsWith('dispatch')).length).toBe(4 * (1 + 30 * groups + 1) + 1);
  });

  it('no collision proxy: no collide dispatch; still one pass', () => {
    const { sim, log, colorRanges, vertexCount } = makeSim({ stiffness: 12, proxy: 'none' });
    sim.step(0.016, 2);
    expect(log.passes).toBe(1);
    const one = expectedStep(colorRanges, vertexCount, 12, false);
    expect(log.ops).toEqual([...one, ...one, 'pipe:pose', 'bg:pose', `dispatch:${Math.ceil(vertexCount / 64)}`, 'end']);
  });

  it('the bake path (runToConvergence) uses one pass per batch', async () => {
    const { sim, log } = makeSim({ stiffness: 8, proxy: 'sphere' });
    (sim as unknown as { _pipes: unknown })._pipes = { whenReady: async () => undefined };
    (sim as unknown as { readPositions: () => Promise<Float32Array> }).readPositions = async () => new Float32Array(3);
    await sim.runToConvergence(128, 64, 1, 0.016);   // epsilon 1 → converges after the 2nd batch
    expect(log.passes).toBe(2);
    expect(log.writes).toBe(2);
  });
});
